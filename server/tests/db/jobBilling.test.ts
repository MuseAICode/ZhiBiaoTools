// worker 接入 AI 网关与余额（迁移 0022_job_billing、src/jobs/runner.ts 的 context.ai、src/ai/concurrency.ts；路线图第 6 步 6.4）
// 对真实 PostgreSQL、真实 Valkey 和本机模拟服务商的集成测试：
// - 任务调用记 job_id / job_type，jobs.billed_amount 与结算在同一事务中累加，应用角色不能改；
// - 冻结时任务必须属于本组织且正在执行；
// - 入队、从暂停继续前检查最低启动余额（1 元）；
// - 运行中余额不足以冻结时任务暂停为 paused / insufficient_balance 并推送，充值后继续，不重复调用、不重复扣费；
// - 按“组织 + 服务商”的 Redis 分布式信号量，上限取组织设置与平台上限的较小值；
// - 步骤幂等（6.4a，迁移 0025_job_step_results）：调用已结算、checkpoint 未保存时崩溃，续跑不再调用服务商、不再扣费；
//   结果与结算同一事务提交；并发完成同一步骤只扣费一次；worker 关闭、租约丢失中止的调用不收费；
//   带工具调用的步骤（8.2c1，迁移 0032_job_step_tool_calls）原样取回工具调用，不用工具的步骤的请求内容与之前相同。
// 需要 TEST_DATABASE_ADMIN_URL 和 TEST_REDIS_URL / TEST_REDIS_PASSWORD。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAiConcurrencyLimiter, type AiConcurrencyLimiter } from '../../src/ai/concurrency.ts';
import { putCredential } from '../../src/ai/credentials.ts';
import { inputTokenUpperBound } from '../../src/ai/estimate.ts';
import { createAiGateway, type AiGateway, type ChatRequest, type GatewaySettings } from '../../src/ai/gateway.ts';
import { createFileKeyWrapper } from '../../src/ai/keyring.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import {
  beginUsage,
  expireStaleHolds,
  failUsage,
  findJobStepResult,
  getAvailableBalance,
  settleJobStep,
  settleUsage,
} from '../../src/billing/usage.ts';
import { JOB_MIN_START_BALANCE } from '../../src/db/migrations/0022_job_billing.ts';
import { APP_ROLE, BILLING_ROLE } from '../../src/db/roles.ts';
import type { Database, JobStatus } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import {
  createJobTypeRegistry,
  JobBalanceExhaustedError,
  type JobContext,
  type JobTypeDefinition,
  type JobTypeRegistry,
} from '../../src/jobs/definitions.ts';
import type { JobNotifier } from '../../src/jobs/notify.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner, type JobRunnerOptions } from '../../src/jobs/runner.ts';
import { cancelJob, enqueueJob, resumeJob, type JobServiceDependencies } from '../../src/jobs/service.ts';
import { claimJob, findJobForOrg, renewRun } from '../../src/jobs/store.ts';
import { jobBody } from '../../src/jobs/view.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { startMockProvider, streamCompletion, streamDeltas, type MockProvider } from '../ai/mockProvider.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const API_KEY = `sk-mock-${randomBytes(16).toString('hex')}`;
const keyWrapper = createFileKeyWrapper(randomBytes(32), 1);

// 价格：输入、输出都是每 token 1 个计费单位，金额好算。
const PRICE_PER_MTOK = '1000000';
const MAX_OUTPUT = 4000;
const MESSAGES = [{ role: 'user' as const, content: 'hi' }];
/** 每次调用的冻结额：输入上界 + 最大输出。 */
const HOLD = BigInt(inputTokenUpperBound(MESSAGES) + MAX_OUTPUT);
/** 模拟服务商返回的用量（输入 3000、输出 1000）对应的扣费。 */
const CHARGE = 4000n;
const USAGE = { prompt_tokens: 3000, completion_tokens: 1000, total_tokens: 4000 };

const SETTINGS: GatewaySettings = {
  upstreamTimeoutMs: 5_000,
  holdTtlSeconds: 60,
  maxOutputTokens: MAX_OUTPUT,
  upstreamPrivateHosts: ['127.0.0.1'],
  concurrencyMax: 10,
  concurrencyWaitMs: 2_000,
};

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;
let redis: Redis;
let provider: MockProvider;

const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

let prefix: string;
let logs: ReturnType<typeof testLogger>;
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];
const limiters: AiConcurrencyLimiter[] = [];

async function newMember(balance = 0n): Promise<TenantContext> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  if (balance > 0n) await credit(orgId, balance);
  return { orgId, userId, role: 'owner' };
}

async function credit(orgId: string, amount: bigint): Promise<void> {
  await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount, reference: null, note: '测试充值' });
}

function newLimiter(overrides: { leaseMs?: number; prefix?: string } = {}): AiConcurrencyLimiter {
  const limiter = createAiConcurrencyLimiter(redisConfig(), { leaseMs: overrides.leaseMs ?? 60_000, prefix: overrides.prefix ?? `${prefix}:ai`, maxPollMs: 50 });
  limiters.push(limiter);
  return limiter;
}

function newGateway(settings: Partial<GatewaySettings> = {}, limiter: AiConcurrencyLimiter | null = newLimiter()): AiGateway {
  return createAiGateway({ db: appDb, keyWrapper, settings: { ...SETTINGS, ...settings }, log: logs.log, limiter });
}

/** 每一步调用一次模型，结果写入后保存 checkpoint（{ step }）；记录每次 run 从第几步开始、调用了几次。 */
interface ChatParams {
  steps: number;
}

function chatJobTypes() {
  const runs = new Map<string, { startStep: number; calls: number; reused: number }[]>();
  async function run(context: JobContext<ChatParams>) {
    const startStep = typeof context.checkpoint?.step === 'number' ? context.checkpoint.step : 0;
    const record = { startStep, calls: 0, reused: 0 };
    runs.set(context.jobId, [...(runs.get(context.jobId) ?? []), record]);
    for (let step = startStep; step < context.params.steps; step += 1) {
      const result = await context.ai.chat({ provider: 'deepseek', model: 'deepseek-chat', messages: MESSAGES, maxOutputTokens: MAX_OUTPUT, stepKey: `step:${step}` });
      record.calls += 1;
      if (result.reused) record.reused += 1;
      await context.saveCheckpoint({ step: step + 1 });
    }
  }
  const parseParams = (raw: unknown): ChatParams => {
    const value = raw as Partial<ChatParams> | null;
    if (!value || !Number.isInteger(value.steps)) throw new TypeError('steps 不合法');
    return { steps: value.steps! };
  };
  const chat: JobTypeDefinition<ChatParams> = { type: 'test-chat', queue: 'ai', resumable: true, billable: true, parseParams, run };
  const free: JobTypeDefinition<ChatParams> = { type: 'test-free', queue: 'parse', resumable: true, parseParams, run: async () => {} };
  return { registry: createJobTypeRegistry([chat, free]), runs };
}

/** 收集推送的 job 事件（只记录任务的当前状态）。 */
function captureNotifier(db: Kysely<Database>): JobNotifier & { jobs: ReturnType<typeof jobBody>[] } {
  const jobs: ReturnType<typeof jobBody>[] = [];
  return {
    jobs,
    async changed(job) {
      jobs.push(jobBody(job));
    },
    async changedById(orgId, jobId) {
      const job = await findJobForOrg(db, orgId, jobId);
      if (job) jobs.push(jobBody(job));
    },
    async progress() {},
    async logged() {},
  };
}

function newDispatcher(): JobDispatcher {
  const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-dispatch'), prefix });
  dispatchers.push(dispatcher);
  return dispatcher;
}

function service(registry: JobTypeRegistry): JobServiceDependencies {
  return { db: appDb, registry, dispatcher: newDispatcher(), log: logs.log };
}

async function startRunner(registry: JobTypeRegistry, options: Partial<JobRunnerOptions> = {}): Promise<JobRunner> {
  const runner = createJobRunner({
    db: appDb,
    registry,
    dispatcher: newDispatcher(),
    connection: bullmqConnection(redisConfig(), 'worker', 'test-worker'),
    log: logs.log,
    prefix,
    leaseMs: 2_000,
    heartbeatMs: 200,
    reconcileIntervalMs: 600_000,
    deferDelayMs: 200,
    ...options,
  });
  runners.push(runner);
  await runner.start();
  return runner;
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
}

async function waitForStatus(jobId: string, status: JobStatus, timeoutMs = 15_000) {
  return waitFor(async () => {
    const row = await jobRow(jobId);
    return row.status === status ? row : null;
  }, timeoutMs, `job ${jobId} → ${status}`);
}

/** 执行中的任务（超级用户直接写入），用于直接测试冻结与结算。 */
async function runningJob(ctx: TenantContext, type = 'test-chat'): Promise<string> {
  const id = randomUUID();
  await superuser.insertInto('jobs').values({
    id, org_id: ctx.orgId, user_id: ctx.userId, type, status: 'running', run_id: randomUUID(),
    lease_expires_at: new Date(Date.now() + 60_000), started_at: new Date(),
  }).execute();
  return id;
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: status, code });
    return error as AppError;
  }
  throw new Error(`应当失败：${code}`);
}

async function usageOf(orgId: string): Promise<any[]> {
  return superuser.selectFrom('usage_records').selectAll().where('org_id', '=', orgId).orderBy('started_at').execute();
}

/** 本任务引用的扣费合计（账本中的金额为负）。 */
async function ledgerChargesForJob(orgId: string, jobId: string): Promise<bigint> {
  const { rows } = await sql<{ total: string }>`
    SELECT coalesce(-sum(l.amount), 0)::text AS total FROM billing_ledger l JOIN usage_records u ON u.id = l.usage_id
    WHERE l.org_id = ${orgId} AND u.job_id = ${jobId}`.execute(superuser);
  return BigInt(rows[0]!.total);
}

const hold = (ctx: TenantContext, jobId: string | null, overrides: Partial<Parameters<typeof beginUsage>[2]> = {}) =>
  beginUsage(appDb, ctx, {
    requestId: randomUUID(),
    source: jobId ? 'job' : 'interactive',
    jobId,
    jobType: null,
    provider: 'deepseek',
    model: 'deepseek-chat',
    estimatedInputTokens: 100,
    maxOutputTokens: 100,
    holdSeconds: 60,
    ...overrides,
  });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    const { migrateToLatest } = await import('../../src/db/migrator.ts');
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'job-billing-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
  const past = new Date(Date.now() - 30 * 86_400_000);
  await superuser.insertInto('model_prices').values({
    provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: PRICE_PER_MTOK, output_price_per_mtok: PRICE_PER_MTOK,
    effective_from: past, created_at: past, created_by: platformAdmin,
  }).execute();
  await superuser.insertInto('platform_models').values({
    provider: 'deepseek', model: 'deepseek-chat', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin,
  }).execute();

  appDb = connect<Database>(testDb.appConfig, 30);
  redis = rawRedis();
  provider = await startMockProvider(API_KEY);
  await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'deepseek', baseUrl: provider.baseUrl, apiKey: API_KEY });
});

beforeEach(() => {
  prefix = uniquePrefix();
  logs = testLogger();
  provider.reset();
  provider.setHandler(async (_request, response) => streamCompletion(response, { usage: USAGE }));
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await Promise.all(limiters.splice(0).map((limiter) => limiter.close()));
  await wipeQueueKeys(redis, prefix);
  await superuser
    .updateTable('jobs')
    .set({ status: 'cancelled', pause_requested: false, pause_reason: null, run_id: null, lease_expires_at: null, finished_at: sql`now()` })
    .where('status', 'in', ['queued', 'running', 'paused', 'cancelling'])
    .execute();
});

afterAll(async () => {
  redis?.disconnect();
  await provider?.close();
  await appDb?.destroy();
  await testDb?.drop();
});

describe('jobs.billed_amount 与任务调用的冻结检查', () => {
  it('结算在同一事务中累加 billed_amount，与本任务的扣费一致；未收费的调用不计入', async () => {
    const ctx = await newMember(1_000_000n);
    const jobId = await runningJob(ctx);
    const first = await hold(ctx, jobId);
    const second = await hold(ctx, jobId);
    const settled = await settleUsage(appDb, ctx, first.usageId, { inputTokens: 30, cachedInputTokens: 0, outputTokens: 20, usageSource: 'provider' });
    expect(settled).toMatchObject({ status: 'billed', amount: 50n });
    expect((await jobRow(jobId)).billed_amount).toBe('50');
    await settleUsage(appDb, ctx, second.usageId, { inputTokens: 7, cachedInputTokens: 0, outputTokens: 3, usageSource: 'estimated' });
    expect((await jobRow(jobId)).billed_amount).toBe('60');
    expect(await ledgerChargesForJob(ctx.orgId, jobId)).toBe(60n);
    // 冻结已到期的结算不收费，billed_amount 不变。
    const expired = await hold(ctx, jobId, { holdSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await settleUsage(appDb, ctx, expired.usageId, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, usageSource: 'provider' })).toMatchObject({ status: 'unbilled' });
    expect((await jobRow(jobId)).billed_amount).toBe('60');
    // 交互式调用不影响任何任务。
    const interactive = await hold(ctx, null);
    await settleUsage(appDb, ctx, interactive.usageId, { inputTokens: 5, cachedInputTokens: 0, outputTokens: 5, usageSource: 'provider' });
    expect((await jobRow(jobId)).billed_amount).toBe('60');
  });

  it('任务结束后才到达的结算照常扣费并累加，其他列仍不能改、updated_at 不变', async () => {
    const ctx = await newMember(1_000_000n);
    const jobId = await runningJob(ctx);
    const pending = await hold(ctx, jobId);
    // 执行者失联、任务被对账标为失败之后，原执行者的调用才结束。
    await superuser.updateTable('jobs').set({ status: 'failed', run_id: null, lease_expires_at: null, error_code: 'JOB_INTERRUPTED', error_message: '中断', finished_at: sql`now()` }).where('id', '=', jobId).execute();
    const before = await jobRow(jobId);
    await settleUsage(appDb, ctx, pending.usageId, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, usageSource: 'provider' });
    const after = await jobRow(jobId);
    expect(after.billed_amount).toBe('20');
    expect(after.updated_at).toEqual(before.updated_at);
    await expect(superuser.updateTable('jobs').set({ progress: 50 }).where('id', '=', jobId).execute()).rejects.toMatchObject({ code: 'JB001' });
    await expect(superuser.updateTable('jobs').set({ billed_amount: '30', progress: 50 }).where('id', '=', jobId).execute()).rejects.toMatchObject({ code: 'JB001' });
  });

  it('billed_amount 只增不减；应用角色不能写 billed_amount，计费角色只能读写本组织任务的少数列', async () => {
    const ctx = await newMember();
    const jobId = await runningJob(ctx);
    await superuser.updateTable('jobs').set({ billed_amount: '100' }).where('id', '=', jobId).execute();
    await expect(superuser.updateTable('jobs').set({ billed_amount: '99' }).where('id', '=', jobId).execute()).rejects.toMatchObject({ code: 'JB002' });
    await expect(
      withTenant(appDb, ctx, (trx) => sql`UPDATE jobs SET billed_amount = billed_amount + 1 WHERE id = ${jobId}`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(appDb, ctx, (trx) => sql`INSERT INTO jobs (org_id, user_id, type, billed_amount) VALUES (${ctx.orgId}, ${ctx.userId}, 'test-chat', 1)`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });

    const columns = await sql<{ column_name: string; privilege_type: string }>`
      SELECT column_name, privilege_type FROM information_schema.column_privileges
      WHERE grantee = ${BILLING_ROLE} AND table_name = 'jobs' ORDER BY privilege_type, column_name`.execute(superuser);
    expect(columns.rows).toEqual([
      ...['billed_amount', 'id', 'org_id', 'status', 'type'].map((column_name) => ({ column_name, privilege_type: 'SELECT' })),
      { column_name: 'billed_amount', privilege_type: 'UPDATE' },
    ]);
    const appUpdate = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.column_privileges
      WHERE grantee = ${APP_ROLE} AND table_name = 'jobs' AND privilege_type = 'UPDATE' AND column_name IN ('billed_amount', 'pause_reason')`.execute(superuser);
    expect(appUpdate.rows.map((row) => row.column_name)).toEqual(['pause_reason']);
  });

  it('pause_reason 只能在 paused 时有值', async () => {
    const ctx = await newMember();
    const jobId = await runningJob(ctx);
    await expect(
      withTenant(appDb, ctx, (trx) => trx.updateTable('jobs').set({ pause_reason: 'insufficient_balance' }).where('id', '=', jobId).execute()),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('任务调用：任务必须属于本组织且正在执行，否则不冻结（409 JOB_NOT_RUNNING）；任务类型以任务记录为准', async () => {
    const ctx = await newMember(1_000_000n);
    const other = await newMember(1_000_000n);
    const jobId = await runningJob(ctx);
    // 不传任务类型时取任务记录中的值；传错时拒绝。
    const ok = await hold(ctx, jobId);
    expect((await usageOf(ctx.orgId)).find((row) => row.id === ok.usageId)).toMatchObject({ job_id: jobId, job_type: 'test-chat' });
    await expectAppError(hold(ctx, jobId, { jobType: 'bid-analysis' }), 400, 'BAD_REQUEST');

    // 其他组织的任务、不存在的任务：与未执行相同。
    await expectAppError(hold(other, jobId), 409, 'JOB_NOT_RUNNING');
    await expectAppError(hold(ctx, randomUUID()), 409, 'JOB_NOT_RUNNING');
    for (const status of ['queued', 'paused', 'cancelling', 'succeeded'] as const) {
      const id = await runningJob(ctx);
      const set =
        status === 'cancelling'
          ? { status }
          : status === 'succeeded'
            ? { status, run_id: null, lease_expires_at: null, finished_at: sql`now()` }
            : { status, run_id: null, lease_expires_at: null };
      await superuser.updateTable('jobs').set(set).where('id', '=', id).execute();
      await expectAppError(hold(ctx, id), 409, 'JOB_NOT_RUNNING');
    }
    expect(await usageOf(other.orgId)).toEqual([]);
    expect((await usageOf(ctx.orgId)).map((row) => row.id)).toEqual([ok.usageId]);
  });
});

describe('最低启动余额', () => {
  it(`会调用模型的任务：可用余额（扣除进行中的冻结）低于 ${JOB_MIN_START_BALANCE} 时拒绝入队（402），不写任务；不调用模型的任务不检查`, async () => {
    const { registry } = chatJobTypes();
    const deps = service(registry);
    const poor = await newMember(JOB_MIN_START_BALANCE - 1n);
    await expectAppError(enqueueJob(deps, poor, { type: 'test-chat', params: { steps: 1 } }), 402, 'INSUFFICIENT_BALANCE');
    expect(await superuser.selectFrom('jobs').select('id').where('org_id', '=', poor.orgId).execute()).toEqual([]);
    const free = await enqueueJob(deps, poor, { type: 'test-free', params: { steps: 1 } });
    expect(free.status).toBe('queued');
    // 调用方传入的 checkBalance 被任务类型的定义覆盖。
    await expectAppError(enqueueJob(deps, poor, { type: 'test-chat', params: { steps: 1 }, checkBalance: false }), 402, 'INSUFFICIENT_BALANCE');

    const exact = await newMember(JOB_MIN_START_BALANCE);
    expect((await enqueueJob(deps, exact, { type: 'test-chat', params: { steps: 1 } })).status).toBe('queued');

    // 余额够，但进行中的冻结占用之后不够。
    const held = await newMember(JOB_MIN_START_BALANCE + 100n);
    const jobId = await runningJob(held);
    await hold(held, jobId, { estimatedInputTokens: 101, maxOutputTokens: 100 });
    await expectAppError(enqueueJob(deps, held, { type: 'test-chat', params: { steps: 1 } }), 402, 'INSUFFICIENT_BALANCE');
  });

  it('从暂停继续前同样检查：不足时 402、任务仍是 paused 且保留原因；充值后继续回到 queued 并清除原因', async () => {
    const { registry } = chatJobTypes();
    const deps = service(registry);
    const ctx = await newMember(JOB_MIN_START_BALANCE);
    const job = await enqueueJob({ ...deps, dispatcher: null }, ctx, { type: 'test-chat', params: { steps: 1 } });
    await superuser.updateTable('jobs').set({ status: 'paused', pause_reason: 'insufficient_balance' }).where('id', '=', job.id).execute();
    // 余额被冲正到不足（直接改余额模拟消费）。
    const jobId = await runningJob(ctx);
    await hold(ctx, jobId, { estimatedInputTokens: 1, maxOutputTokens: 1 });
    await expectAppError(resumeJob({ ...deps, dispatcher: null }, ctx, job.id), 402, 'INSUFFICIENT_BALANCE');
    expect(await jobRow(job.id)).toMatchObject({ status: 'paused', pause_reason: 'insufficient_balance' });
    await credit(ctx.orgId, 10n);
    const resumed = await resumeJob({ ...deps, dispatcher: null }, ctx, job.id);
    expect(resumed).toMatchObject({ status: 'queued', pauseReason: null });
    // 取消暂停中的任务同样清除原因。
    await superuser.updateTable('jobs').set({ status: 'paused', pause_reason: 'insufficient_balance' }).where('id', '=', job.id).execute();
    expect(await cancelJob({ ...deps, dispatcher: null }, ctx, job.id)).toMatchObject({ status: 'cancelled', pauseReason: null });
  });
});

describe('worker 中的任务调用', () => {
  it('运行中余额耗尽：暂停为 paused / insufficient_balance 并推送；充值后继续，从 checkpoint 开始，不重复调用、不重复扣费', async () => {
    const { registry, runs } = chatJobTypes();
    const notifier = captureNotifier(appDb);
    // 余额 1 元：前两次调用各扣 4000，第三次冻结不足（剩 2000 < 冻结额）。
    const ctx = await newMember(JOB_MIN_START_BALANCE);
    expect(HOLD).toBeGreaterThan(2_000n);
    await startRunner(registry, { gateway: newGateway(), notifier });
    const job = await enqueueJob({ ...service(registry), notifier }, ctx, { type: 'test-chat', params: { steps: 4 } });

    const paused = await waitForStatus(job.id, 'paused');
    expect(paused).toMatchObject({ pause_reason: 'insufficient_balance', billed_amount: String(2n * CHARGE), checkpoint: { step: 2 }, run_id: null });
    expect(provider.requests).toHaveLength(2);
    expect(notifier.jobs.at(-1)).toMatchObject({ id: job.id, status: 'paused', pauseReason: 'insufficient_balance', billedAmount: String(2n * CHARGE) });
    const events = await superuser.selectFrom('job_events').select(['kind', 'data']).where('job_id', '=', job.id).orderBy('id').execute();
    expect(events.at(-1)).toEqual({ kind: 'paused', data: { reason: 'insufficient_balance' } });
    // 已完成的两次调用按实际用量扣费；冻结失败的那次调用不写用量记录，暂停后没有任何进行中的冻结。
    expect((await usageOf(ctx.orgId)).map((row) => row.status)).toEqual(['billed', 'billed']);
    expect(await getAvailableBalance(appDb, ctx)).toEqual({
      balance: JOB_MIN_START_BALANCE - 2n * CHARGE,
      held: 0n,
      available: JOB_MIN_START_BALANCE - 2n * CHARGE,
    });
    expect(await ledgerChargesForJob(ctx.orgId, job.id)).toBe(2n * CHARGE);

    // 余额仍不足时不能继续。
    await expectAppError(resumeJob(service(registry), ctx, job.id), 402, 'INSUFFICIENT_BALANCE');
    await credit(ctx.orgId, JOB_MIN_START_BALANCE);
    await resumeJob({ ...service(registry), notifier }, ctx, job.id);
    const done = await waitForStatus(job.id, 'succeeded');

    expect(runs.get(job.id)).toEqual([
      { startStep: 0, calls: 2, reused: 0 },
      { startStep: 2, calls: 2, reused: 0 },
    ]);
    expect(provider.requests).toHaveLength(4);
    const usage = await usageOf(ctx.orgId);
    expect(usage.map((row) => row.status)).toEqual(['billed', 'billed', 'billed', 'billed']);
    expect(new Set(usage.map((row) => row.job_id))).toEqual(new Set([job.id]));
    expect(usage.every((row) => row.source === 'job' && row.job_type === 'test-chat' && row.user_id === ctx.userId)).toBe(true);
    expect(done.billed_amount).toBe(String(4n * CHARGE));
    expect(await ledgerChargesForJob(ctx.orgId, job.id)).toBe(4n * CHARGE);
    const balance = await superuser.selectFrom('org_balances').select('balance').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    expect(BigInt(balance.balance)).toBe(2n * JOB_MIN_START_BALANCE - 4n * CHARGE);
  });

  it('任务吞掉余额不足的错误也无法继续调用：之后的调用直接失败，执行结束后仍暂停', async () => {
    const ctx = await newMember(JOB_MIN_START_BALANCE);
    const attempts: string[] = [];
    const greedy: JobTypeDefinition<{ steps: number }> = {
      type: 'test-greedy',
      queue: 'ai',
      resumable: true,
      billable: true,
      parseParams: () => ({ steps: 5 }),
      async run(context) {
        for (let step = 0; step < 5; step += 1) {
          try {
            await context.ai.chat({ provider: 'deepseek', model: 'deepseek-chat', messages: MESSAGES, maxOutputTokens: MAX_OUTPUT, stepKey: `greedy:${step}` });
            attempts.push('ok');
          } catch (error) {
            attempts.push(error instanceof JobBalanceExhaustedError ? 'exhausted' : 'other');
          }
        }
        throw new Error('stop');
      },
    };
    const registry = createJobTypeRegistry([greedy]);
    await startRunner(registry, { gateway: newGateway() });
    const job = await enqueueJob(service(registry), ctx, { type: 'test-greedy', params: {} });
    await waitForStatus(job.id, 'paused');
    expect(attempts).toEqual(['ok', 'ok', 'exhausted', 'exhausted', 'exhausted']);
    expect(provider.requests).toHaveLength(2);
  });

  it('网关的其他错误转成任务的错误代码；未配置网关时 AI_UNAVAILABLE', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const { registry } = chatJobTypes();
    provider.setHandler((_request, response) => {
      response.writeHead(500);
      response.end('{"error":{"message":"internal secret detail"}}');
    });
    await startRunner(registry, { gateway: newGateway() });
    const failed = await enqueueJob(service(registry), ctx, { type: 'test-chat', params: { steps: 1 } });
    expect(await waitForStatus(failed.id, 'failed')).toMatchObject({ error_code: 'AI_UPSTREAM_ERROR', error_message: '模型服务调用失败，本次调用不收费', billed_amount: '0' });
    await Promise.all(runners.splice(0).map((runner) => runner.close()));

    await startRunner(registry, { gateway: null });
    const unavailable = await enqueueJob(service(registry), ctx, { type: 'test-chat', params: { steps: 1 } });
    expect(await waitForStatus(unavailable.id, 'failed')).toMatchObject({ error_code: 'AI_UNAVAILABLE' });
  });

  it('排队等并发名额时取消任务：立即退出为 cancelled，不冻结、不调用服务商', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    await superuser.insertInto('org_settings').values({ org_id: ctx.orgId, concurrency_limit: 1, updated_by: ctx.userId }).execute();
    const limiter = newLimiter();
    // 名额被占满（例如同组织的交互式调用）。
    const release = await limiter.acquire({ orgId: ctx.orgId, provider: 'deepseek', limit: 1, waitMs: 0 });
    const { registry } = chatJobTypes();
    await startRunner(registry, { gateway: newGateway({}, limiter) });
    const job = await enqueueJob(service(registry), ctx, { type: 'test-chat', params: { steps: 1 } });
    await waitForStatus(job.id, 'running');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cancelJob(service(registry), ctx, job.id);
    await waitForStatus(job.id, 'cancelled');
    expect(provider.requests).toHaveLength(0);
    expect(await usageOf(ctx.orgId)).toEqual([]);
    await release();
  });

  it('调用进行中取消任务：立即关闭到服务商的连接，按已产生的用量结算（不超过冻结额）、冻结释放，任务为 cancelled，不再发起后续调用', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    let upstreamClosed = false;
    // 服务商输出一段内容后一直不结束。
    provider.setHandler(async (_request, response) => {
      response.on('close', () => (upstreamClosed = true));
      await streamCompletion(response, { pieces: ['第一段内容'], usage: USAGE, beforeDone: new Promise(() => {}) });
    });
    const { registry } = chatJobTypes();
    await startRunner(registry, { gateway: newGateway() });
    const job = await enqueueJob(service(registry), ctx, { type: 'test-chat', params: { steps: 3 } });
    await waitFor(async () => (provider.requests.length === 1 ? true : null));
    await waitFor(async () => ((await usageOf(ctx.orgId))[0]?.status === 'pending' ? true : null));
    expect((await getAvailableBalance(appDb, ctx)).held).toBe(HOLD);

    await cancelJob(service(registry), ctx, job.id);
    const cancelled = await waitForStatus(job.id, 'cancelled');
    await waitFor(async () => (upstreamClosed ? true : null), 5_000, 'upstream connection closed');

    const [usage] = await usageOf(ctx.orgId);
    // 服务商没有返回用量（[DONE] 之前被中止）：按已产生的输出本地估算，不超过冻结额。
    expect(usage).toMatchObject({ status: 'billed', usage_source: 'estimated', job_id: job.id });
    const charged = BigInt(usage.amount);
    expect(charged).toBeGreaterThan(0n);
    expect(charged).toBeLessThanOrEqual(HOLD);
    expect(cancelled.billed_amount).toBe(String(charged));
    expect(await ledgerChargesForJob(ctx.orgId, job.id)).toBe(charged);
    expect(await getAvailableBalance(appDb, ctx)).toEqual({ balance: 10n * JOB_MIN_START_BALANCE - charged, held: 0n, available: 10n * JOB_MIN_START_BALANCE - charged });
    // 取消后不再发起后续调用。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.requests).toHaveLength(1);
    expect(await usageOf(ctx.orgId)).toHaveLength(1);
  });

  it('worker 在调用中途崩溃：冻结到期后不再占用余额、不收费；任务被收回后从 checkpoint 续跑，已扣费的步骤不重做、不重复扣费', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const { registry, runs } = chatJobTypes();
    const job = await enqueueJob({ ...service(registry), dispatcher: null }, ctx, { type: 'test-chat', params: { steps: 3 } });

    // 模拟崩溃的执行者在数据库中留下的状态：认领（租约很短）、完成第 0 步（扣费并保存 checkpoint）、
    // 第 1 步已冻结但还没有结算时进程消失（不续租、不结算、不结束）。
    const runId = randomUUID();
    const claim = await claimJob(appDb, { orgId: ctx.orgId, jobId: job.id, runId, leaseMs: 500, orgRunningLimit: 3, attemptsFor: () => 3 });
    expect(claim.kind).toBe('claimed');
    const gateway = newGateway();
    const first = await gateway.chat(ctx, { provider: 'deepseek', model: 'deepseek-chat', messages: MESSAGES, maxOutputTokens: MAX_OUTPUT, source: 'job', jobId: job.id, jobType: 'test-chat', stepKey: 'step:0' });
    expect(first.billing).toEqual({ status: 'billed', amount: CHARGE });
    expect(await renewRun(appDb, { orgId: ctx.orgId, jobId: job.id, runId }, 500, { checkpoint: { step: 1 } })).not.toBeNull();
    const orphan = await hold(ctx, job.id, { estimatedInputTokens: inputTokenUpperBound(MESSAGES), maxOutputTokens: MAX_OUTPUT, holdSeconds: 2 });
    expect((await getAvailableBalance(appDb, ctx)).held).toBe(HOLD);

    // 租约过期后由新的 worker 对账收回，从 checkpoint（第 1 步）继续。
    await new Promise((resolve) => setTimeout(resolve, 600));
    const runner = await startRunner(registry, { gateway });
    await runner.reconcile();
    const done = await waitForStatus(job.id, 'succeeded');
    expect(runs.get(job.id)).toEqual([{ startStep: 1, calls: 2, reused: 0 }]);
    expect(provider.requests).toHaveLength(3);

    // 崩溃留下的冻结到期后不再占用余额，不需要任何清理任务；清理任务只把它标为 abandoned，不收费。
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, orphan.holdExpiresAt.getTime() - Date.now()) + 200));
    expect(await getAvailableBalance(appDb, ctx)).toEqual({ balance: 10n * JOB_MIN_START_BALANCE - 3n * CHARGE, held: 0n, available: 10n * JOB_MIN_START_BALANCE - 3n * CHARGE });
    expect(await expireStaleHolds(appDb)).toBeGreaterThanOrEqual(1);
    const usage = await usageOf(ctx.orgId);
    expect(usage.find((row) => row.id === orphan.usageId)).toMatchObject({ status: 'unbilled', failure_reason: 'abandoned', amount: '0', ledger_entry_id: null });
    // 共 3 步各扣费一次：崩溃前的第 0 步 + 续跑的第 1、2 步。
    expect(usage.filter((row) => row.status === 'billed')).toHaveLength(3);
    expect(done.billed_amount).toBe(String(3n * CHARGE));
    expect(await ledgerChargesForJob(ctx.orgId, job.id)).toBe(3n * CHARGE);
  });
});

describe('按“组织 + 服务商”的并发信号量', () => {
  it('达到上限时等待，超时 429；释放后可再获取；不同组织、不同服务商互不影响；重复释放无害', async () => {
    const limiter = newLimiter();
    const orgA = randomUUID();
    const orgB = randomUUID();
    const first = await limiter.acquire({ orgId: orgA, provider: 'deepseek', limit: 2, waitMs: 0 });
    const second = await limiter.acquire({ orgId: orgA, provider: 'deepseek', limit: 2, waitMs: 0 });
    const started = Date.now();
    await expectAppError(limiter.acquire({ orgId: orgA, provider: 'deepseek', limit: 2, waitMs: 200 }), 429, 'AI_CONCURRENCY_LIMITED');
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    await (await limiter.acquire({ orgId: orgB, provider: 'deepseek', limit: 2, waitMs: 0 }))();
    await (await limiter.acquire({ orgId: orgA, provider: 'qwen', limit: 2, waitMs: 0 }))();

    const waiting = limiter.acquire({ orgId: orgA, provider: 'deepseek', limit: 2, waitMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first();
    await first();
    const third = await waiting;
    await expectAppError(limiter.acquire({ orgId: orgA, provider: 'deepseek', limit: 2, waitMs: 0 }), 429, 'AI_CONCURRENCY_LIMITED');
    await second();
    await third();
  });

  it('并发获取不会超过上限（原子脚本）', async () => {
    const limiter = newLimiter();
    const other = newLimiter();
    const orgId = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => (index % 2 ? limiter : other).acquire({ orgId, provider: 'deepseek', limit: 3, waitMs: 0 })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
  });

  it('进程崩溃没有释放：名额到期后自动收回', async () => {
    const limiter = newLimiter({ leaseMs: 300 });
    const orgId = randomUUID();
    await limiter.acquire({ orgId, provider: 'deepseek', limit: 1, waitMs: 0 });
    await expectAppError(limiter.acquire({ orgId, provider: 'deepseek', limit: 1, waitMs: 0 }), 429, 'AI_CONCURRENCY_LIMITED');
    const release = await limiter.acquire({ orgId, provider: 'deepseek', limit: 1, waitMs: 2_000 });
    await release();
  });

  it('等待中被取消：400 AI_REQUEST_ABORTED；Redis 不可用：等待超时后 503，不放行', async () => {
    const limiter = newLimiter();
    const orgId = randomUUID();
    const release = await limiter.acquire({ orgId, provider: 'deepseek', limit: 1, waitMs: 0 });
    const controller = new AbortController();
    const waiting = limiter.acquire({ orgId, provider: 'deepseek', limit: 1, waitMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expectAppError(waiting, 400, 'AI_REQUEST_ABORTED');
    await release();

    const broken = createAiConcurrencyLimiter({ ...redisConfig(), port: 1 }, { leaseMs: 1_000, maxPollMs: 50 });
    limiters.push(broken);
    await expectAppError(broken.acquire({ orgId, provider: 'deepseek', limit: 1, waitMs: 300 }), 503, 'AI_CONCURRENCY_UNAVAILABLE');
  });

  it('网关：上限取组织设置与平台上限的较小值；超时的交互式调用 429，不冻结、不调用服务商；调用结束释放名额', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inFlight = 0;
    let peak = 0;
    provider.setHandler(async (_request, response) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await streamCompletion(response, { usage: { prompt_tokens: 1, completion_tokens: 1 }, beforeDone: gate });
      inFlight -= 1;
    });
    const request = { provider: 'deepseek' as const, model: 'deepseek-chat', messages: MESSAGES, maxOutputTokens: 10, source: 'interactive' as const };

    // 组织设置 2、平台上限 10：同时最多 2 个。
    await superuser.insertInto('org_settings').values({ org_id: ctx.orgId, concurrency_limit: 2, updated_by: ctx.userId }).execute();
    const gateway = newGateway({ concurrencyWaitMs: 200 });
    const running = [gateway.chat(ctx, request), gateway.chat(ctx, request)];
    await waitFor(async () => (provider.requests.length === 2 ? true : null));
    await expectAppError(gateway.chat(ctx, request), 429, 'AI_CONCURRENCY_LIMITED');
    expect(await usageOf(ctx.orgId)).toHaveLength(2);
    // 平台上限 1 小于组织设置时取平台上限。
    const strict = newGateway({ concurrencyMax: 1, concurrencyWaitMs: 100 });
    const other = await newMember(10n * JOB_MIN_START_BALANCE);
    const otherCall = strict.chat(other, request);
    await waitFor(async () => (provider.requests.length === 3 ? true : null));
    await expectAppError(strict.chat(other, request), 429, 'AI_CONCURRENCY_LIMITED');
    release();
    await Promise.all([...running, otherCall]);
    expect(peak).toBe(3);
    expect(provider.requests).toHaveLength(3);
    // 名额已释放，可以再次调用。
    await gateway.chat(ctx, request);
    await gateway.chat(ctx, request);
  });
});

describe('步骤幂等（6.4a）：平台自身故障导致的重复调用不向用户收费', () => {
  const jobRequest = (jobId: string, stepKey: string, overrides: Partial<ChatRequest> = {}): ChatRequest => ({
    provider: 'deepseek', model: 'deepseek-chat', messages: MESSAGES, maxOutputTokens: MAX_OUTPUT,
    source: 'job', jobId, jobType: 'test-chat', stepKey, ...overrides,
  });
  const stepRows = (jobId: string) =>
    superuser.selectFrom('job_step_results').selectAll().where('job_id', '=', jobId).orderBy('step_key').execute();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('调用已结算、checkpoint 未保存时 worker 崩溃：续跑时这一步取回已保存的结果，服务商不再被调用，只扣费一次', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const { registry, runs } = chatJobTypes();
    const job = await enqueueJob({ ...service(registry), dispatcher: null }, ctx, { type: 'test-chat', params: { steps: 3 } });

    // 崩溃的执行者：认领（租约很短），第 0 步的调用完成并结算，还没保存 checkpoint 时进程消失。
    const runId = randomUUID();
    const claim = await claimJob(appDb, { orgId: ctx.orgId, jobId: job.id, runId, leaseMs: 500, orgRunningLimit: 3, attemptsFor: () => 3 });
    expect(claim.kind).toBe('claimed');
    const gateway = newGateway();
    const first = await gateway.chat(ctx, jobRequest(job.id, 'step:0'));
    expect(first).toMatchObject({ reused: false, billing: { status: 'billed', amount: CHARGE } });
    expect((await jobRow(job.id)).checkpoint).toBeNull();
    expect(provider.requests).toHaveLength(1);

    // 租约过期后由新的 worker 收回，从头（没有 checkpoint）续跑。
    await sleep(600);
    const runner = await startRunner(registry, { gateway });
    await runner.reconcile();
    const done = await waitForStatus(job.id, 'succeeded');
    expect(done.attempt).toBe(2);
    // 续跑重新执行了第 0 步，但取回的是已保存的结果：服务商共收到 3 次请求（崩溃前 1 次 + 第 1、2 步），不是 4 次。
    expect(runs.get(job.id)).toEqual([{ startStep: 0, calls: 3, reused: 1 }]);
    expect(provider.requests).toHaveLength(3);
    const usage = await usageOf(ctx.orgId);
    expect(usage.map((row) => row.status)).toEqual(['billed', 'billed', 'billed']);
    expect(done.billed_amount).toBe(String(3n * CHARGE));
    expect(await ledgerChargesForJob(ctx.orgId, job.id)).toBe(3n * CHARGE);
    expect(await getAvailableBalance(appDb, ctx)).toEqual({
      balance: 10n * JOB_MIN_START_BALANCE - 3n * CHARGE, held: 0n, available: 10n * JOB_MIN_START_BALANCE - 3n * CHARGE,
    });
    const steps = await stepRows(job.id);
    expect(steps.map((row) => row.step_key)).toEqual(['step:0', 'step:1', 'step:2']);
    expect(steps[0]).toMatchObject({ usage_id: usage[0].id, content: first.content, input_tokens: '3000', output_tokens: '1000' });
  });

  it('结果与结算在同一事务中提交：结算失败时结果不保存；结果写不进时不扣费；提交前崩溃则两者都没有，冻结到期后不收费', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const jobId = await runningJob(ctx);
    const otherJob = await runningJob(ctx);
    const step = { jobId, stepKey: 'step:0', requestHash: randomBytes(32) };
    const result = { requestId: randomUUID(), content: '结果', reasoningContent: '', toolCalls: [], finishReason: 'stop' };
    const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, usageSource: 'provider' as const };

    // 用量记录已经释放：结算失败，结果不保存。
    const released = await hold(ctx, jobId);
    await failUsage(appDb, ctx, released.usageId, 'upstream_error');
    await expectAppError(settleJobStep(appDb, ctx, released.usageId, step, result, usage), 409, 'USAGE_NOT_PENDING');
    expect(await stepRows(jobId)).toEqual([]);

    // 用量记录属于另一个任务：结果写不进，也不结算（冻结仍在，到期后不收费）。
    const foreign = await hold(ctx, otherJob);
    await expectAppError(settleJobStep(appDb, ctx, foreign.usageId, step, result, usage), 409, 'USAGE_NOT_PENDING');
    expect((await usageOf(ctx.orgId)).find((row) => row.id === foreign.usageId)).toMatchObject({ status: 'pending', amount: '0' });

    // 结果已写入、扣费时出错（注入的故障，相当于提交前崩溃）：整个事务回滚，结果和扣费都没有。
    const injected = await hold(ctx, jobId, { holdSeconds: 2 });
    await sql`CREATE FUNCTION test_fail_charge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.usage_id = ${sql.lit(injected.usageId)}::uuid THEN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX001'; END IF;
        RETURN NEW;
      END $$`.execute(superuser);
    await sql`CREATE TRIGGER test_fail_charge BEFORE INSERT ON billing_ledger FOR EACH ROW EXECUTE FUNCTION test_fail_charge()`.execute(superuser);
    try {
      await expect(settleJobStep(appDb, ctx, injected.usageId, step, result, usage)).rejects.toMatchObject({ code: 'XX001' });
    } finally {
      await sql`DROP TRIGGER test_fail_charge ON billing_ledger`.execute(superuser);
      await sql`DROP FUNCTION test_fail_charge()`.execute(superuser);
    }
    expect(await stepRows(jobId)).toEqual([]);
    expect(await findJobStepResult(appDb, ctx, step)).toBeNull();
    await sleep(Math.max(0, injected.holdExpiresAt.getTime() - Date.now()) + 200);
    expect(await expireStaleHolds(appDb)).toBeGreaterThanOrEqual(1);
    expect((await usageOf(ctx.orgId)).find((row) => row.id === injected.usageId)).toMatchObject({ status: 'unbilled', failure_reason: 'abandoned', amount: '0' });

    // 正常提交：结果和扣费同时存在，之后可以取回。
    const ok = await hold(ctx, jobId);
    const settled = await settleJobStep(appDb, ctx, ok.usageId, step, result, usage);
    expect(settled).toMatchObject({ stored: true, settlement: { status: 'billed', amount: 20n } });
    expect(await findJobStepResult(appDb, ctx, step)).toEqual({ ...result, requestId: (await usageOf(ctx.orgId)).find((row) => row.id === ok.usageId).request_id, usage });
    expect(await ledgerChargesForJob(ctx.orgId, jobId)).toBe(20n);
  });

  it('同一步骤被两个执行者同时完成（原执行者失联后仍在运行）：只扣费一次，后提交的不收费（duplicate_step），两边拿到同一结果', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const jobId = await runningJob(ctx);
    let arrived = 0;
    let releaseBoth!: () => void;
    const barrier = new Promise<void>((resolve) => (releaseBoth = resolve));
    provider.setHandler(async (_request, response) => {
      const n = (arrived += 1);
      if (n === 2) releaseBoth();
      await barrier;
      await streamCompletion(response, { pieces: [`第 ${n} 次的输出`], usage: USAGE });
    });
    const gateway = newGateway();
    const [a, b] = await Promise.all([gateway.chat(ctx, jobRequest(jobId, 'step:0')), gateway.chat(ctx, jobRequest(jobId, 'step:0'))]);
    expect(provider.requests).toHaveLength(2);
    expect(a.content).toBe(b.content);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
    const usage = await usageOf(ctx.orgId);
    expect(usage.map((row) => `${row.status}:${row.failure_reason}`).sort()).toEqual(['billed:null', 'unbilled:duplicate_step']);
    expect((await jobRow(jobId)).billed_amount).toBe(String(CHARGE));
    expect(await ledgerChargesForJob(ctx.orgId, jobId)).toBe(CHARGE);
    expect(await stepRows(jobId)).toHaveLength(1);
    expect((await getAvailableBalance(appDb, ctx)).held).toBe(0n);
  });

  it('同一步骤、同一请求直接取回，不冻结、不调用服务商；请求内容不同（如暂停期间改了输入）、步骤不同、任务不同都是新的调用，照常收费', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const jobId = await runningJob(ctx);
    const otherJob = await runningJob(ctx);
    const gateway = newGateway();
    expect((await gateway.chat(ctx, jobRequest(jobId, 'a'))).billing).toEqual({ status: 'billed', amount: CHARGE });
    const again = await gateway.chat(ctx, jobRequest(jobId, 'a'));
    expect(again).toMatchObject({ reused: true, billing: { status: 'unbilled', amount: 0n } });
    expect(provider.requests).toHaveLength(1);
    expect(await usageOf(ctx.orgId)).toHaveLength(1);

    const changed = [
      jobRequest(jobId, 'a', { messages: [{ role: 'user', content: '改过的输入' }] }),
      jobRequest(jobId, 'a', { maxOutputTokens: MAX_OUTPUT - 1 }),
      jobRequest(jobId, 'a', { temperature: 0.5 }),
      jobRequest(jobId, 'b'),
      jobRequest(otherJob, 'a'),
    ];
    for (const request of changed) {
      expect(await gateway.chat(ctx, request)).toMatchObject({ reused: false, billing: { status: 'billed' } });
    }
    expect(provider.requests).toHaveLength(1 + changed.length);
    expect((await usageOf(ctx.orgId)).every((row) => row.status === 'billed')).toBe(true);
  });

  it('带工具调用的步骤（8.2c1）：工具调用与结算一起保存，续跑时原样取回、不调用服务商；工具定义、工具选择、对话中的工具字段不同都是新的调用', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const jobId = await runningJob(ctx);
    const gateway = newGateway();
    provider.setHandler((_request, response) =>
      streamDeltas(response, [{ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }], { usage: USAGE }),
    );
    const bash = { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } };
    const request = jobRequest(jobId, 'agent:1', { tools: [bash] });
    const first = await gateway.chat(ctx, request);
    expect(first).toMatchObject({ reused: false, toolCalls: [{ id: 'call_a', name: 'bash', arguments: '{"command":"ls"}' }], finishReason: 'tool_calls' });
    const [row] = await stepRows(jobId);
    expect(row).toMatchObject({ content: '', tool_calls: [{ id: 'call_a', name: 'bash', arguments: '{"command":"ls"}' }] });

    const again = await gateway.chat(ctx, request);
    expect(again).toMatchObject({ reused: true, toolCalls: first.toolCalls, content: '', finishReason: 'tool_calls', billing: { status: 'unbilled', amount: 0n } });
    expect(provider.requests).toHaveLength(1);

    const followUp: ChatRequest['messages'] = [
      ...MESSAGES,
      { role: 'assistant', content: '', toolCalls: first.toolCalls },
      { role: 'tool', content: 'a.txt', toolCallId: 'call_a' },
    ];
    const changed = [
      jobRequest(jobId, 'agent:1'),
      jobRequest(jobId, 'agent:1', { tools: [{ ...bash, description: '执行命令' }] }),
      jobRequest(jobId, 'agent:1', { tools: [bash], toolChoice: 'required' }),
      jobRequest(jobId, 'agent:1', { tools: [bash], messages: followUp }),
      jobRequest(jobId, 'agent:1', { tools: [bash], messages: [followUp[0]!, followUp[1]!, { ...followUp[2]!, content: 'b.txt' }] }),
      jobRequest(jobId, 'agent:1', { tools: [bash], messages: [followUp[0]!, { ...followUp[1]!, toolCalls: [{ id: 'call_a', name: 'bash', arguments: '{"command":"pwd"}' }] }, followUp[2]!] }),
    ];
    for (const next of changed) expect(await gateway.chat(ctx, next)).toMatchObject({ reused: false, billing: { status: 'billed' } });
    expect(provider.requests).toHaveLength(1 + changed.length);
  });

  it('不用工具的步骤：请求内容（request_hash）与 8.2c1 之前的写法相同，升级前保存的结果升级后仍能取回；tool_calls 为 NULL', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const jobId = await runningJob(ctx);
    await newGateway().chat(ctx, jobRequest(jobId, 'legacy', { temperature: 0.3 }));
    const legacy = createHash('sha256')
      .update(JSON.stringify(['deepseek', 'deepseek-chat', MAX_OUTPUT, 0.3, MESSAGES.map((message) => [message.role, message.content])]), 'utf8')
      .digest();
    const [row] = await stepRows(jobId);
    expect(Buffer.from(row!.request_hash).equals(legacy)).toBe(true);
    expect(row!.tool_calls).toBeNull();
  });

  it('job_step_results.tool_calls：只能是 1～128 项的数组；应用角色只有 INSERT 授权', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const jobId = await runningJob(ctx);
    const insert = async (toolCalls: string) => {
      const pending = await hold(ctx, jobId);
      return withTenant(appDb, ctx, (trx) => trx.insertInto('job_step_results').values({
        org_id: ctx.orgId, job_id: jobId, step_key: `x-${randomUUID()}`, request_hash: randomBytes(32), usage_id: pending.usageId, content: '',
        reasoning_content: '', tool_calls: toolCalls, finish_reason: 'tool_calls', input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, usage_source: 'provider',
      }).execute());
    };
    const call = { id: 'c', name: 'bash', arguments: '{}' };
    for (const bad of ['{}', '[]', '"x"', JSON.stringify(Array.from({ length: 129 }, () => call))]) {
      await expect(insert(bad)).rejects.toMatchObject({ code: '23514' });
    }
    await insert(JSON.stringify(Array.from({ length: 128 }, () => call)));
    const privileges = await sql<{ privilege_type: string }>`
      SELECT privilege_type FROM information_schema.column_privileges
      WHERE table_name = 'job_step_results' AND column_name = 'tool_calls' AND grantee = ${APP_ROLE} ORDER BY privilege_type`.execute(superuser);
    expect(privileges.rows.map((item) => item.privilege_type)).toEqual(['INSERT', 'SELECT']);
    await expect(withTenant(appDb, ctx, (trx) => sql`UPDATE job_step_results SET tool_calls = NULL`.execute(trx))).rejects.toMatchObject({ code: '42501' });
  });

  it('worker 关闭时中止进行中的调用：按平台原因不收费（platform_interrupted）；续跑重做这一步，每步只扣费一次', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    provider.setHandler(async (_request, response) => {
      // 第一次调用输出一段后一直不结束，其余正常。
      if (provider.requests.length === 1) await streamCompletion(response, { pieces: ['一部分输出'], usage: USAGE, beforeDone: new Promise(() => {}) });
      else await streamCompletion(response, { usage: USAGE });
    });
    const { registry, runs } = chatJobTypes();
    const runner = await startRunner(registry, { gateway: newGateway() });
    const job = await enqueueJob(service(registry), ctx, { type: 'test-chat', params: { steps: 2 } });
    await waitFor(async () => ((await usageOf(ctx.orgId))[0]?.status === 'pending' ? true : null));

    runners.splice(runners.indexOf(runner), 1);
    await runner.close();
    expect((await jobRow(job.id)).status).toBe('queued');
    expect((await usageOf(ctx.orgId))[0]).toMatchObject({ status: 'unbilled', failure_reason: 'platform_interrupted', amount: '0', ledger_entry_id: null });
    expect((await getAvailableBalance(appDb, ctx)).held).toBe(0n);
    expect(await stepRows(job.id)).toEqual([]);

    const next = await startRunner(registry, { gateway: newGateway() });
    await next.reconcile();
    const done = await waitForStatus(job.id, 'succeeded');
    expect(runs.get(job.id)).toEqual([
      { startStep: 0, calls: 0, reused: 0 },
      { startStep: 0, calls: 2, reused: 0 },
    ]);
    expect(provider.requests).toHaveLength(3);
    expect(done.billed_amount).toBe(String(2n * CHARGE));
    expect(await ledgerChargesForJob(ctx.orgId, job.id)).toBe(2n * CHARGE);
  });

  it('租约丢失时中止进行中的调用：同样不收费；收回后续跑，每步只扣费一次', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    provider.setHandler(async (_request, response) => {
      if (provider.requests.length === 1) await streamCompletion(response, { pieces: ['一部分输出'], usage: USAGE, beforeDone: new Promise(() => {}) });
      else await streamCompletion(response, { usage: USAGE });
    });
    const { registry } = chatJobTypes();
    const runner = await startRunner(registry, { gateway: newGateway() });
    const job = await enqueueJob(service(registry), ctx, { type: 'test-chat', params: { steps: 2 } });
    await waitFor(async () => ((await usageOf(ctx.orgId))[0]?.status === 'pending' ? true : null));

    // 租约被收回（例如执行者与数据库之间长时间断开）：任务已归另一个执行者，原执行者续租失败后中止。
    await superuser.updateTable('jobs').set({ run_id: randomUUID(), lease_expires_at: new Date(Date.now() + 60_000) }).where('id', '=', job.id).execute();
    await waitFor(async () => ((await usageOf(ctx.orgId))[0]?.status === 'unbilled' ? true : null), 5_000, 'interrupted call released');
    expect((await usageOf(ctx.orgId))[0]).toMatchObject({ failure_reason: 'platform_interrupted', amount: '0' });

    // 新的执行者也失联：租约过期后收回、续跑。
    await superuser.updateTable('jobs').set({ lease_expires_at: new Date(Date.now() - 1_000) }).where('id', '=', job.id).execute();
    await runner.reconcile();
    const done = await waitForStatus(job.id, 'succeeded');
    expect(provider.requests).toHaveLength(3);
    expect(done.billed_amount).toBe(String(2n * CHARGE));
    expect(await ledgerChargesForJob(ctx.orgId, job.id)).toBe(2n * CHARGE);
  });

  it('job_step_results：强制 RLS，只读本组织；应用角色不能改、不能删；随任务记录的保留期删除，用量记录保留', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const other = await newMember();
    const jobId = await runningJob(ctx);
    await newGateway().chat(ctx, jobRequest(jobId, 'step:0'));
    expect(await withTenant(appDb, ctx, (trx) => trx.selectFrom('job_step_results').selectAll().execute())).toHaveLength(1);
    expect(await withTenant(appDb, other, (trx) => trx.selectFrom('job_step_results').selectAll().execute())).toEqual([]);
    expect(await appDb.selectFrom('job_step_results').selectAll().execute()).toEqual([]);
    await expect(withTenant(appDb, ctx, (trx) => sql`UPDATE job_step_results SET content = 'x'`.execute(trx))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(appDb, ctx, (trx) => sql`DELETE FROM job_step_results`.execute(trx))).rejects.toMatchObject({ code: '42501' });
    // 其他组织不能为本组织的任务写结果。
    const foreign = await hold(ctx, jobId);
    await expect(withTenant(appDb, other, (trx) => trx.insertInto('job_step_results').values({
      org_id: ctx.orgId, job_id: jobId, step_key: 'x', request_hash: randomBytes(32), usage_id: foreign.usageId, content: '', reasoning_content: '',
      finish_reason: null, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, usage_source: 'provider',
    }).execute())).rejects.toMatchObject({ code: '42501' });

    await superuser.updateTable('jobs')
      .set({ status: 'succeeded', run_id: null, lease_expires_at: null, finished_at: new Date(Date.now() - 100 * 86_400_000) })
      .where('id', '=', jobId).execute();
    await sql`SELECT cleanup_delete_jobs(1000)`.execute(appDb);
    expect(await superuser.selectFrom('jobs').select('id').where('id', '=', jobId).execute()).toEqual([]);
    expect(await stepRows(jobId)).toEqual([]);
    expect((await usageOf(ctx.orgId)).filter((row) => row.job_id === jobId)).toHaveLength(2);
  });

  it('项目被物理删除时，其下任务的 job_step_results 随任务记录一并删除（任务结束不满 90 天也删），用量记录与账本保留', async () => {
    const ctx = await newMember(10n * JOB_MIN_START_BALANCE);
    const project = await superuser.insertInto('projects')
      .values({ org_id: ctx.orgId, kind: 'technical-plan', name: '项目', created_by: ctx.userId })
      .returning('id').executeTakeFirstOrThrow();
    const jobId = randomUUID();
    await superuser.insertInto('jobs').values({
      id: jobId, org_id: ctx.orgId, project_id: project.id, user_id: ctx.userId, type: 'test-chat', status: 'running', run_id: randomUUID(),
      lease_expires_at: new Date(Date.now() + 60_000), started_at: new Date(),
    }).execute();
    await newGateway().chat(ctx, jobRequest(jobId, 'step:0'));
    expect(await stepRows(jobId)).toHaveLength(1);

    // 任务刚结束（远不满 90 天）；项目已删除超过 7 天恢复期。
    await superuser.updateTable('jobs').set({ status: 'succeeded', run_id: null, lease_expires_at: null, finished_at: new Date() })
      .where('id', '=', jobId).execute();
    await superuser.updateTable('projects')
      .set({ deleted_at: new Date(Date.now() - 8 * 86_400_000), deleted_by: ctx.userId }).where('id', '=', project.id).execute();
    // 任务记录未过期，单独的任务清理不删它。
    await sql`SELECT cleanup_delete_jobs(1000)`.execute(appDb);
    expect(await stepRows(jobId)).toHaveLength(1);

    expect((await sql<{ n: number }>`SELECT cleanup_delete_projects(1000) AS n`.execute(appDb)).rows[0]!.n).toBeGreaterThanOrEqual(1);
    expect(await superuser.selectFrom('projects').select('id').where('id', '=', project.id).execute()).toEqual([]);
    expect(await superuser.selectFrom('jobs').select('id').where('id', '=', jobId).execute()).toEqual([]);
    expect(await stepRows(jobId)).toEqual([]);
    const usage = (await usageOf(ctx.orgId)).filter((row) => row.job_id === jobId);
    expect(usage.map((row) => row.status)).toEqual(['billed']);
    expect(await ledgerChargesForJob(ctx.orgId, jobId)).toBe(CHARGE);
  });
});
