// worker 接入 AI 网关与余额（迁移 0022_job_billing、src/jobs/runner.ts 的 context.ai、src/ai/concurrency.ts；路线图第 6 步 6.4）
// 对真实 PostgreSQL、真实 Valkey 和本机模拟服务商的集成测试：
// - 任务调用记 job_id / job_type，jobs.billed_amount 与结算在同一事务中累加，应用角色不能改；
// - 冻结时任务必须属于本组织且正在执行；
// - 入队、从暂停继续前检查最低启动余额（1 元）；
// - 运行中余额不足以冻结时任务暂停为 paused / insufficient_balance 并推送，充值后继续，不重复调用、不重复扣费；
// - 按“组织 + 服务商”的 Redis 分布式信号量，上限取组织设置与平台上限的较小值。
// 需要 TEST_DATABASE_ADMIN_URL 和 TEST_REDIS_URL / TEST_REDIS_PASSWORD。
import { randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAiConcurrencyLimiter, type AiConcurrencyLimiter } from '../../src/ai/concurrency.ts';
import { putCredential } from '../../src/ai/credentials.ts';
import { inputTokenUpperBound } from '../../src/ai/estimate.ts';
import { createAiGateway, type AiGateway, type GatewaySettings } from '../../src/ai/gateway.ts';
import { createFileKeyWrapper } from '../../src/ai/keyring.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { beginUsage, settleUsage } from '../../src/billing/usage.ts';
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
import { findJobForOrg } from '../../src/jobs/store.ts';
import { jobBody } from '../../src/jobs/view.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { startMockProvider, streamCompletion, type MockProvider } from '../ai/mockProvider.ts';
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
  const runs = new Map<string, { startStep: number; calls: number }[]>();
  async function run(context: JobContext<ChatParams>) {
    const startStep = typeof context.checkpoint?.step === 'number' ? context.checkpoint.step : 0;
    const record = { startStep, calls: 0 };
    runs.set(context.jobId, [...(runs.get(context.jobId) ?? []), record]);
    for (let step = startStep; step < context.params.steps; step += 1) {
      await context.ai.chat({ provider: 'deepseek', model: 'deepseek-chat', messages: MESSAGES, maxOutputTokens: MAX_OUTPUT });
      record.calls += 1;
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
    // 冻结失败的那次调用不写用量记录、没有进行中的冻结。
    expect((await usageOf(ctx.orgId)).map((row) => row.status)).toEqual(['billed', 'billed']);

    // 余额仍不足时不能继续。
    await expectAppError(resumeJob(service(registry), ctx, job.id), 402, 'INSUFFICIENT_BALANCE');
    await credit(ctx.orgId, JOB_MIN_START_BALANCE);
    await resumeJob({ ...service(registry), notifier }, ctx, job.id);
    const done = await waitForStatus(job.id, 'succeeded');

    expect(runs.get(job.id)).toEqual([
      { startStep: 0, calls: 2 },
      { startStep: 2, calls: 2 },
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
            await context.ai.chat({ provider: 'deepseek', model: 'deepseek-chat', messages: MESSAGES, maxOutputTokens: MAX_OUTPUT });
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
