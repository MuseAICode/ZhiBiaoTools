// Agent 任务达到上限后的确认继续（迁移 0034_agent_job_budget_confirm、src/jobs/store.ts 的 confirmTaskLimit、
// POST /api/jobs/:jobId/confirm-limit，路线图第 8 步 8.3b）：
// - 确认人：任务发起人、组织 owner / admin 可以确认；同组织的其他普通成员 403，其他组织的成员 404；
// - 确认后上限各加一份（入队时的上限），清除原因，任务回到 queued，确认记录写入 resumed 事件；
// - 前置条件：只有因上限暂停的任务可以确认；继续前检查最低启动余额（不足时 402、什么都不改）；超出可确认的最高上限时 409；
// - 并发确认只加一份；
// - 数据库守卫（绕过应用代码直接写）：一次达到上限只能加一份、只能各加一份、轮数不变、必须清除原因、任务必须因上限暂停、
//   确认人必须是发起人或 owner / admin，没有用户上下文（worker、超级用户）一律拒绝；暂停中不能计入轮数；
// - 执行者：确认后从 checkpoint 续跑，到新上限处再次暂停；低于新上限时正常完成；
// - 接口：确认、权限、GET 详情中的上限与用量；
// - 回滚 0034：加大的上限保留，之后再升级成功。
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS, type AgentTaskLimits } from '../../src/agent/budget.ts';
import { putCredential } from '../../src/ai/credentials.ts';
import { inputTokenUpperBound } from '../../src/ai/estimate.ts';
import { createAiGateway } from '../../src/ai/gateway.ts';
import { createFileKeyWrapper } from '../../src/ai/keyring.ts';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { beginUsage } from '../../src/billing/usage.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { JOB_MIN_START_BALANCE } from '../../src/db/migrations/0022_job_billing.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database, JobStatus, MemberRole } from '../../src/db/schema.ts';
import { withOrgContext, withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import { createJobTypeRegistry, type JobContext, type JobTypeDefinition, type JobTypeRegistry } from '../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../src/jobs/runner.ts';
import { confirmJobTaskLimit, enqueueJob, pauseJob, type JobServiceDependencies } from '../../src/jobs/service.ts';
import { claimJob, finishRun, listJobEvents, type RunRef } from '../../src/jobs/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { startMockProvider, streamCompletion, type MockProvider } from '../ai/mockProvider.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const API_KEY = `sk-mock-${randomBytes(16).toString('hex')}`;
const keyWrapper = createFileKeyWrapper(randomBytes(32), 1);
const PASSWORD = 'quiet-harbor-maple-58';
/** 输入、输出都是 1 计费单位 / token，冻结额与扣费直接等于 token 数。 */
const PRICE_PER_MTOK = '1000000';
const MAX_OUTPUT = 400;
const MESSAGES = [{ role: 'user' as const, content: 'hi' }];
const GATEWAY_HOLD = BigInt(inputTokenUpperBound(MESSAGES) + MAX_OUTPUT);
const USAGE = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
const CHARGE = 150n;

const RELAXED_LIMITS: AuthRateLimitSettings = Object.fromEntries(
  Object.entries(DEFAULT_AUTH_RATE_LIMITS).map(([key, value]) => [
    key,
    'limit' in value ? { ...value, limit: 10_000 } : { ...value, freeFailures: 10_000 },
  ]),
) as unknown as AuthRateLimitSettings;

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let app: FastifyInstance;
let redis: Redis;
let provider: MockProvider;
let prefix: string;
let logs: ReturnType<typeof testLogger>;
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];

const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

interface Member {
  context: TenantContext;
  email: string;
}

async function credit(orgId: string, amount: bigint): Promise<void> {
  await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount, reference: null, note: '测试充值' });
}

/** 新组织，第一个成员是 owner。 */
async function newOrg(balance = 10_000_000n): Promise<Member> {
  const orgId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  if (balance > 0n) await credit(orgId, balance);
  return addMember(orgId, 'owner');
}

async function addMember(orgId: string, role: MemberRole): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { context: { orgId, userId, role }, email };
}

interface LoopParams {
  steps: number | null;
}

const parseLoop = (raw: unknown): LoopParams => {
  const value = raw as Partial<LoopParams> | null;
  if (!value || !(value.steps === null || Number.isInteger(value.steps))) throw new TypeError('steps 不合法');
  return { steps: value.steps ?? null };
};

/** 假模型：每一步换一个步骤键调用一次模型，steps 为 null 时永不停止。 */
function agentType(type: string, limits: AgentTaskLimits): JobTypeDefinition<LoopParams> {
  return {
    type,
    queue: 'agent',
    resumable: true,
    billable: true,
    agentLimits: limits,
    parseParams: parseLoop,
    async run(context: JobContext<LoopParams>) {
      const start = typeof context.checkpoint?.step === 'number' ? context.checkpoint.step : 0;
      for (let step = start; context.params.steps === null || step < context.params.steps; step += 1) {
        await context.ai.chat({ provider: 'deepseek', model: 'deepseek-chat', messages: MESSAGES, maxOutputTokens: MAX_OUTPUT, stepKey: `loop:${step}` });
        await context.saveCheckpoint({ step: step + 1 });
      }
    },
  };
}

const LIMITS = { costLimit: 1_000_000n, turnLimit: 3 } satisfies AgentTaskLimits;
const COST_LIMITS = { costLimit: 3n * CHARGE + GATEWAY_HOLD - 1n, turnLimit: 1000 } satisfies AgentTaskLimits;
const registry: JobTypeRegistry = createJobTypeRegistry([
  agentType('test-agent-turns', LIMITS),
  agentType('test-agent-cost', COST_LIMITS),
  { type: 'test-plain', queue: 'ai', resumable: true, parseParams: parseLoop, run: async () => {} },
]);

function newDispatcher(): JobDispatcher {
  const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-dispatch'), prefix });
  dispatchers.push(dispatcher);
  return dispatcher;
}

const offline = (): JobServiceDependencies => ({ db: appDb, registry, dispatcher: null, log: logs.log });
const service = (): JobServiceDependencies => ({ db: appDb, registry, dispatcher: newDispatcher(), log: logs.log });

async function startRunner(): Promise<JobRunner> {
  const gateway = createAiGateway({
    db: appDb,
    keyWrapper,
    settings: { upstreamTimeoutMs: 5_000, holdTtlSeconds: 60, maxOutputTokens: MAX_OUTPUT, upstreamPrivateHosts: ['127.0.0.1'] },
    log: logs.log,
  });
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
    gateway,
  });
  runners.push(runner);
  await runner.start();
  return runner;
}

async function newProject(ctx: TenantContext): Promise<string> {
  const row = await withTenant(appDb, ctx, (trx) =>
    trx.insertInto('projects').values({ org_id: ctx.orgId, kind: 'technical-plan', name: '项目', created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow(),
  );
  return row.id;
}

/** 入队并认领一个 Agent 任务（不经 BullMQ），返回本次执行。 */
async function runningAgentJob(ctx: TenantContext, type = 'test-agent-turns'): Promise<RunRef> {
  const job = await enqueueJob(offline(), ctx, { type, params: { steps: null }, projectId: await newProject(ctx) });
  const runId = randomUUID();
  const claim = await claimJob(appDb, { orgId: ctx.orgId, jobId: job.id, runId, leaseMs: 60_000, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 });
  expect(claim.kind).toBe('claimed');
  return { orgId: ctx.orgId, jobId: job.id, runId };
}

/** 发起人 ctx 的一个因上限暂停的 Agent 任务（执行者达到上限后的状态：原因已记下、任务 paused）。 */
async function limitPausedJob(ctx: TenantContext, reason: 'task_cost_limit' | 'task_turn_limit' = 'task_turn_limit'): Promise<string> {
  const run = await runningAgentJob(ctx);
  expect(await finishRun(appDb, run, { kind: 'task-limit', reason }, true)).toBe('paused');
  return run.jobId;
}

async function budgetRow(jobId: string) {
  return superuser.selectFrom('agent_job_budgets').selectAll().where('job_id', '=', jobId).executeTakeFirstOrThrow();
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
}

async function waitForStatus(jobId: string, status: JobStatus, reason?: string | null) {
  return waitFor(async () => {
    const row = await jobRow(jobId);
    return row.status === status && (reason === undefined || row.pause_reason === reason) ? row : null;
  }, 15_000, `job ${jobId} → ${status}`);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `应当失败：${code}`).not.toBeNull();
  const actual = error instanceof AppError ? error.code : (error as { code?: unknown }).code;
  expect(actual).toBe(code);
}

/** 未确认时的上限（入队时的值），用于核对“只加一份”。 */
const UNCHANGED = { cost_limit: LIMITS.costLimit.toString(), turn_limit: LIMITS.turnLimit, confirmations: 0, exhausted_reason: 'task_turn_limit' };

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'agent-confirm-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
  const past = new Date(Date.now() - 30 * 86_400_000);
  await superuser.insertInto('model_prices').values({
    provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: PRICE_PER_MTOK, output_price_per_mtok: PRICE_PER_MTOK,
    effective_from: past, created_at: past, created_by: platformAdmin,
  }).execute();
  await superuser.insertInto('platform_models').values({
    provider: 'deepseek', model: 'deepseek-chat', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin,
  }).execute();
  database = createDatabase(testDb.appConfig);
  appDb = database.db;
  redis = rawRedis();
  provider = await startMockProvider(API_KEY);
  await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'deepseek', baseUrl: provider.baseUrl, apiKey: API_KEY });
  app = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    { database, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} } },
  );
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
  await app?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('确认人', () => {
  it('发起人（普通成员）确认：上限各加一份、清除原因、回到 queued，确认记录写入事件', async () => {
    const owner = await newOrg();
    const creator = await addMember(owner.context.orgId, 'member');
    const jobId = await limitPausedJob(creator.context);
    const job = await confirmJobTaskLimit(offline(), creator.context, jobId);
    expect(job).toMatchObject({ status: 'queued', pauseReason: null });
    expect(await budgetRow(jobId)).toMatchObject({
      cost_limit: (2n * LIMITS.costLimit).toString(), turn_limit: 2 * LIMITS.turnLimit, turns_used: 0, exhausted_reason: null, confirmations: 1,
      cost_step: LIMITS.costLimit.toString(), turn_step: LIMITS.turnLimit,
    });
    const events = await listJobEvents(appDb, creator.context, jobId, 50);
    expect(events.at(-1)).toMatchObject({
      kind: 'resumed',
      data: {
        userId: creator.context.userId, confirmedReason: 'task_turn_limit', billedAmount: '0', turnsUsed: 0,
        previousCostLimit: LIMITS.costLimit.toString(), costLimit: (2n * LIMITS.costLimit).toString(),
        previousTurnLimit: LIMITS.turnLimit, turnLimit: 2 * LIMITS.turnLimit, confirmations: 1,
      },
    });
    expect(events.at(-1)!.message).toBe('已确认继续：本任务已花费 0 元，费用上限调整为 200 元、调用次数上限调整为 6 次');
  });

  it('组织 owner、admin 可以确认其他成员发起的任务', async () => {
    const owner = await newOrg();
    const admin = await addMember(owner.context.orgId, 'admin');
    const creator = await addMember(owner.context.orgId, 'member');
    for (const confirmer of [owner, admin]) {
      const jobId = await limitPausedJob(creator.context, 'task_cost_limit');
      expect((await confirmJobTaskLimit(offline(), confirmer.context, jobId)).status).toBe('queued');
      expect(await budgetRow(jobId)).toMatchObject({ confirmations: 1, exhausted_reason: null });
      expect((await listJobEvents(appDb, creator.context, jobId, 50)).at(-1)!.data).toMatchObject({ userId: confirmer.context.userId, confirmedReason: 'task_cost_limit' });
    }
  });

  it('同组织的其他普通成员 403、其他组织的 owner 404，都什么都不改', async () => {
    const owner = await newOrg();
    const jobId = await limitPausedJob(owner.context);
    const bystander = await addMember(owner.context.orgId, 'member');
    await expectCode(confirmJobTaskLimit(offline(), bystander.context, jobId), 'JOB_CONFIRM_FORBIDDEN');
    // 伪造的 TenantContext 角色（应用层检查被绕过）：数据库守卫按成员关系拒绝。
    await expectCode(confirmJobTaskLimit(offline(), { ...bystander.context, role: 'admin' }, jobId), 'AB001');
    const stranger = await newOrg();
    await expectCode(confirmJobTaskLimit(offline(), stranger.context, jobId), 'JOB_NOT_FOUND');
    expect(await budgetRow(jobId)).toMatchObject(UNCHANGED);
    expect(await jobRow(jobId)).toMatchObject({ status: 'paused', pause_reason: 'task_turn_limit' });
  });
});

describe('前置条件', () => {
  it('只有因上限暂停的任务可以确认：手动暂停、排队中、执行中 409，已结束 409 JOB_FINISHED', async () => {
    const owner = await newOrg();
    const queued = await enqueueJob(offline(), owner.context, { type: 'test-agent-turns', params: { steps: 1 }, projectId: await newProject(owner.context) });
    await expectCode(confirmJobTaskLimit(offline(), owner.context, queued.id), 'JOB_NOT_LIMIT_PAUSED');
    await pauseJob(offline(), owner.context, queued.id);
    await expectCode(confirmJobTaskLimit(offline(), owner.context, queued.id), 'JOB_NOT_LIMIT_PAUSED');
    const run = await runningAgentJob(owner.context);
    await expectCode(confirmJobTaskLimit(offline(), owner.context, run.jobId), 'JOB_NOT_LIMIT_PAUSED');
    await superuser.updateTable('jobs').set({ status: 'cancelled', run_id: null, lease_expires_at: null, finished_at: sql`now()` }).where('id', '=', run.jobId).execute();
    await expectCode(confirmJobTaskLimit(offline(), owner.context, run.jobId), 'JOB_FINISHED');
    expect((await budgetRow(queued.id)).confirmations).toBe(0);
  });

  it('余额低于最低启动余额：402，什么都不改；充值后可以确认', async () => {
    const owner = await newOrg(JOB_MIN_START_BALANCE);
    const jobId = await limitPausedJob(owner.context);
    // 另一个执行中的任务的冻结占用余额，可用余额低于门槛。
    const other = await runningAgentJob(owner.context, 'test-agent-cost');
    await beginUsage(appDb, owner.context, {
      requestId: randomUUID(), source: 'job', jobId: other.jobId, jobType: null, provider: 'deepseek', model: 'deepseek-chat',
      estimatedInputTokens: 1, maxOutputTokens: 1, holdSeconds: 60,
    });
    await expectCode(confirmJobTaskLimit(offline(), owner.context, jobId), 'INSUFFICIENT_BALANCE');
    expect(await budgetRow(jobId)).toMatchObject(UNCHANGED);
    expect(await jobRow(jobId)).toMatchObject({ status: 'paused', pause_reason: 'task_turn_limit' });
    await credit(owner.context.orgId, 10n);
    expect((await confirmJobTaskLimit(offline(), owner.context, jobId)).status).toBe('queued');
  });

  it('再加一份会超出可确认的最高上限：409 TASK_LIMIT_MAX_REACHED，什么都不改', async () => {
    const owner = await newOrg();
    const jobId = await limitPausedJob(owner.context);
    // 换成接近最高上限的一行（写入触发器取“一份”= 写入的上限）。
    await superuser.deleteFrom('agent_job_budgets').where('job_id', '=', jobId).execute();
    await superuser.insertInto('agent_job_budgets').values({
      org_id: owner.context.orgId, job_id: jobId, cost_limit: '60000000', turn_limit: 10, exhausted_reason: 'task_cost_limit',
      cost_step: '1', turn_step: 1, confirmations: 5,
    }).execute();
    expect(await budgetRow(jobId)).toMatchObject({ cost_step: '60000000', turn_step: 10, confirmations: 0 });
    await expectCode(confirmJobTaskLimit(offline(), owner.context, jobId), 'TASK_LIMIT_MAX_REACHED');
    expect(await budgetRow(jobId)).toMatchObject({ cost_limit: '60000000', confirmations: 0, exhausted_reason: 'task_cost_limit' });
  });

  it('并发确认只加一份：10 个并发请求只有 1 个成功', async () => {
    const owner = await newOrg();
    const admin = await addMember(owner.context.orgId, 'admin');
    const jobId = await limitPausedJob(owner.context);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => confirmJobTaskLimit(offline(), index % 2 === 0 ? owner.context : admin.context, jobId)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) if (result.status === 'rejected') expect((result.reason as AppError).code).toBe('JOB_NOT_LIMIT_PAUSED');
    expect(await budgetRow(jobId)).toMatchObject({ cost_limit: (2n * LIMITS.costLimit).toString(), turn_limit: 2 * LIMITS.turnLimit, confirmations: 1 });
    const resumed = (await listJobEvents(appDb, owner.context, jobId, 50)).filter((event) => event.kind === 'resumed');
    expect(resumed).toHaveLength(1);
  });
});

describe('数据库守卫（绕过应用代码直接写）', () => {
  const confirmShape = (budget: Record<string, any>) => ({
    cost_limit: (BigInt(budget.cost_limit) + BigInt(budget.cost_step)).toString(),
    turn_limit: budget.turn_limit + budget.turn_step,
    confirmations: budget.confirmations + 1,
    exhausted_reason: null,
  });
  const update = (ctx: TenantContext, jobId: string, set: Record<string, unknown>) =>
    withTenant(appDb, ctx, (trx) => trx.updateTable('agent_job_budgets').set(set).where('job_id', '=', jobId).executeTakeFirst());

  it('只能各加一份、次数加 1、清除原因、轮数不变；一次达到上限只能加一份', async () => {
    const owner = await newOrg();
    const jobId = await limitPausedJob(owner.context);
    const budget = await budgetRow(jobId);
    const shape = confirmShape(budget);
    await expectCode(update(owner.context, jobId, { ...shape, cost_limit: (2n * BigInt(shape.cost_limit)).toString() }), 'AB001');
    await expectCode(update(owner.context, jobId, { ...shape, turn_limit: shape.turn_limit + 1 }), 'AB001');
    await expectCode(update(owner.context, jobId, { ...shape, confirmations: 2 }), 'AB001');
    await expectCode(update(owner.context, jobId, { ...shape, exhausted_reason: 'task_turn_limit' }), 'AB001');
    await expectCode(update(owner.context, jobId, { ...shape, turns_used: 1 }), 'AB001');
    // 只加费用、不加轮数（或反之）同样被拒绝。
    await expectCode(update(owner.context, jobId, { cost_limit: shape.cost_limit, confirmations: 1, exhausted_reason: null }), 'AB001');
    // 只清除原因（不加上限）：仍是“原因不能清除”。
    await expectCode(update(owner.context, jobId, { exhausted_reason: null }), 'AB001');
    // 暂停中不能计入轮数。
    await expectCode(update(owner.context, jobId, { turns_used: 1 }), 'AB001');
    expect(await budgetRow(jobId)).toMatchObject(UNCHANGED);
    expect((await update(owner.context, jobId, shape)).numUpdatedRows).toBe(1n);
    // 原因已清除（任务仍是 paused、原因仍在 jobs 上）：同样形状的第二次被拒绝。
    await expectCode(update(owner.context, jobId, confirmShape(await budgetRow(jobId))), 'AB001');
    expect(await budgetRow(jobId)).toMatchObject({ confirmations: 1, turn_limit: 2 * LIMITS.turnLimit });
  });

  it('确认人：普通成员（非发起人）、worker（只有组织上下文）、超级用户都被拒绝；其他组织改不到', async () => {
    const owner = await newOrg();
    const jobId = await limitPausedJob(owner.context);
    const shape = confirmShape(await budgetRow(jobId));
    const bystander = await addMember(owner.context.orgId, 'member');
    await expectCode(update({ ...bystander.context, role: 'owner' }, jobId, shape), 'AB001');
    await expectCode(withOrgContext(appDb, owner.context.orgId, (trx) => trx.updateTable('agent_job_budgets').set(shape).where('job_id', '=', jobId).execute()), 'AB001');
    await expectCode(superuser.updateTable('agent_job_budgets').set(shape).where('job_id', '=', jobId).execute(), 'AB001');
    const stranger = await newOrg();
    expect((await update(stranger.context, jobId, shape)).numUpdatedRows).toBe(0n);
    // 已离开组织的发起人：不再是成员，被拒绝。
    const leaver = await addMember(owner.context.orgId, 'member');
    const leaverJob = await limitPausedJob(leaver.context);
    const leaverShape = confirmShape(await budgetRow(leaverJob));
    await superuser.deleteFrom('org_memberships').where('user_id', '=', leaver.context.userId).execute();
    await expectCode(update(leaver.context, leaverJob, leaverShape), 'AB001');
    expect(await budgetRow(jobId)).toMatchObject(UNCHANGED);
  });

  it('任务必须因上限暂停：执行中（原因已记下、尚未暂停）、手动暂停时不能加', async () => {
    const owner = await newOrg();
    const run = await runningAgentJob(owner.context);
    for (let turn = 1; turn <= LIMITS.turnLimit; turn += 1) {
      await superuser.updateTable('agent_job_budgets').set({ turns_used: turn }).where('job_id', '=', run.jobId).execute();
    }
    await superuser.updateTable('agent_job_budgets').set({ exhausted_reason: 'task_turn_limit' }).where('job_id', '=', run.jobId).execute();
    const shape = confirmShape(await budgetRow(run.jobId));
    await expectCode(update(owner.context, run.jobId, shape), 'AB001');
    await superuser.updateTable('jobs').set({ status: 'paused', pause_reason: null, run_id: null, lease_expires_at: null }).where('id', '=', run.jobId).execute();
    // 手动暂停：两条更新策略都不适用，0 行。
    expect((await update(owner.context, run.jobId, shape)).numUpdatedRows).toBe(0n);
    expect(await budgetRow(run.jobId)).toMatchObject({ confirmations: 0, exhausted_reason: 'task_turn_limit' });
  });

  it('因上限暂停但没有记下原因的任务（例如 0034 之前暂停的）：暂停中的更新策略不放行计入轮数与记下原因，也不能确认', async () => {
    const owner = await newOrg();
    const run = await runningAgentJob(owner.context);
    await superuser.updateTable('jobs').set({ status: 'paused', pause_reason: 'task_turn_limit', run_id: null, lease_expires_at: null }).where('id', '=', run.jobId).execute();
    await expectCode(update(owner.context, run.jobId, { turns_used: 1 }), 'AB001');
    await expectCode(update(owner.context, run.jobId, { exhausted_reason: 'task_cost_limit' }), 'AB001');
    await expectCode(update(owner.context, run.jobId, confirmShape(await budgetRow(run.jobId))), 'AB001');
    expect(await budgetRow(run.jobId)).toMatchObject({ turns_used: 0, exhausted_reason: null, confirmations: 0 });
  });

  it('写入时“一份”额度取写入的上限、确认次数为 0，之后不能改', async () => {
    const owner = await newOrg();
    const jobId = await limitPausedJob(owner.context);
    await expectCode(superuser.updateTable('agent_job_budgets').set({ cost_step: '1' }).where('job_id', '=', jobId).execute(), 'AB001');
    await expectCode(superuser.updateTable('agent_job_budgets').set({ turn_step: 1 }).where('job_id', '=', jobId).execute(), 'AB001');
    expect(await budgetRow(jobId)).toMatchObject({ cost_step: LIMITS.costLimit.toString(), turn_step: LIMITS.turnLimit, confirmations: 0 });
  });
});

describe('执行者：确认后续跑', () => {
  it('轮数上限：暂停 → 确认 → 从 checkpoint 续跑，到新上限处再次暂停；服务商合计调用 6 次', async () => {
    await startRunner();
    const owner = await newOrg();
    const job = await enqueueJob(service(), owner.context, { type: 'test-agent-turns', params: { steps: null }, projectId: await newProject(owner.context) });
    await waitForStatus(job.id, 'paused', 'task_turn_limit');
    expect(provider.requests).toHaveLength(3);
    await confirmJobTaskLimit(service(), owner.context, job.id);
    const row = await waitForStatus(job.id, 'paused', 'task_turn_limit');
    expect(provider.requests).toHaveLength(6);
    expect(row.billed_amount).toBe((6n * CHARGE).toString());
    expect(await budgetRow(job.id)).toMatchObject({ turns_used: 6, turn_limit: 6, exhausted_reason: 'task_turn_limit', confirmations: 1 });
  });

  it('对照组：低于新上限时确认后正常完成，已完成的步骤不重做', async () => {
    await startRunner();
    const owner = await newOrg();
    const job = await enqueueJob(service(), owner.context, { type: 'test-agent-turns', params: { steps: 5 }, projectId: await newProject(owner.context) });
    await waitForStatus(job.id, 'paused', 'task_turn_limit');
    await confirmJobTaskLimit(service(), owner.context, job.id);
    await waitForStatus(job.id, 'succeeded');
    expect(provider.requests).toHaveLength(5);
  });

  it('费用上限：确认后再给一份费用额度，已扣费 ≤ 新上限，再次暂停为 task_cost_limit', async () => {
    await startRunner();
    const owner = await newOrg();
    const job = await enqueueJob(service(), owner.context, { type: 'test-agent-cost', params: { steps: null }, projectId: await newProject(owner.context) });
    await waitForStatus(job.id, 'paused', 'task_cost_limit');
    expect(provider.requests).toHaveLength(3);
    await confirmJobTaskLimit(service(), owner.context, job.id);
    const row = await waitForStatus(job.id, 'paused', 'task_cost_limit');
    const budget = await budgetRow(job.id);
    expect(budget.cost_limit).toBe((2n * COST_LIMITS.costLimit).toString());
    expect(BigInt(row.billed_amount)).toBeLessThanOrEqual(BigInt(budget.cost_limit));
    // 第 n 次调用能冻结的条件：(n − 1) 次扣费 + 一次冻结 ≤ 上限。第一份额度只放得下 3 次（对照上面），新上限按同一条件计算。
    let expected = 0;
    while (BigInt(expected) * CHARGE + GATEWAY_HOLD <= 2n * COST_LIMITS.costLimit) expected += 1;
    expect(expected).toBeGreaterThan(3);
    expect(provider.requests).toHaveLength(expected);
    expect(row.billed_amount).toBe((BigInt(expected) * CHARGE).toString());
  });
});

describe('接口', () => {
  async function login(email: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
    expect(response.statusCode, response.body).toBe(200);
    const header = response.headers['set-cookie'];
    return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
  }

  async function call(member: Member, method: 'GET' | 'POST', url: string) {
    const cookie = await login(member.email);
    return app.inject({ method, url, headers: { ...sameSiteHeaders, cookie: `__Host-session=${cookie}` } });
  }

  it('GET 详情含上限与用量；普通成员确认 403；发起人确认 200；之后再确认 409；其他组织 404', async () => {
    const owner = await newOrg();
    const creator = await addMember(owner.context.orgId, 'member');
    const bystander = await addMember(owner.context.orgId, 'member');
    const jobId = await limitPausedJob(creator.context);

    const detail = await call(bystander, 'GET', `/api/jobs/${jobId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      status: 'paused', pauseReason: 'task_turn_limit', billedAmount: '0', createdBy: creator.context.userId,
      agentBudget: {
        costLimit: LIMITS.costLimit.toString(), turnLimit: 3, turnsUsed: 0, exhaustedReason: 'task_turn_limit',
        costStep: LIMITS.costLimit.toString(), turnStep: 3, confirmations: 0,
      },
    });

    const forbidden = await call(bystander, 'POST', `/api/jobs/${jobId}/confirm-limit`);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: { code: 'JOB_CONFIRM_FORBIDDEN' } });
    const stranger = await newOrg();
    expect((await call(stranger, 'POST', `/api/jobs/${jobId}/confirm-limit`)).statusCode).toBe(404);

    const confirmed = await call(creator, 'POST', `/api/jobs/${jobId.toUpperCase()}/confirm-limit`);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ id: jobId, status: 'queued', pauseReason: null });
    expect((await call(creator, 'GET', `/api/jobs/${jobId}`)).json()).toMatchObject({ agentBudget: { turnLimit: 6, exhaustedReason: null, confirmations: 1 } });

    const again = await call(owner, 'POST', `/api/jobs/${jobId}/confirm-limit`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'JOB_NOT_LIMIT_PAUSED' } });
  });

  it('不是 Agent 任务：详情中 agentBudget 为 null；缺少 CSRF 头的确认请求被拒绝', async () => {
    const owner = await newOrg();
    const plain = await enqueueJob(offline(), owner.context, { type: 'test-plain', params: { steps: 1 } });
    expect((await call(owner, 'GET', `/api/jobs/${plain.id}`)).json()).toMatchObject({ agentBudget: null });
    const jobId = await limitPausedJob(owner.context);
    const cookie = await login(owner.email);
    const noCsrf = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/confirm-limit`, headers: { cookie: `__Host-session=${cookie}` } });
    expect(noCsrf.statusCode).toBe(403);
    expect(await budgetRow(jobId)).toMatchObject(UNCHANGED);
  });
});

describe('回滚 0034', () => {
  it('已加大的上限保留、新列删除，之后再升级成功（一份 = 当时的上限）', async () => {
    const owner = await newOrg();
    const jobId = await limitPausedJob(owner.context);
    await confirmJobTaskLimit(offline(), owner.context, jobId);
    await app.close();
    await database.destroy();
    const migrator = connect(testDb.ownerConfig);
    try {
      expect((await migrateDown(migrator)).results?.map((result) => result.migrationName)).toEqual(['0041_job_pause_storage_quota']);
      expect((await migrateDown(migrator)).results?.map((result) => result.migrationName)).toEqual(['0040_agent_workspace_snapshots']);
      expect((await migrateDown(migrator)).results?.map((result) => result.migrationName)).toEqual(['0039_agent_questions']);
      expect((await migrateDown(migrator)).results?.map((result) => result.migrationName)).toEqual(['0038_agent_failure_reports']);
      expect((await migrateDown(migrator)).results?.map((result) => result.migrationName)).toEqual(['0037_agent_tool_calls']);
      expect((await migrateDown(migrator)).results?.map((result) => result.migrationName)).toEqual(['0036_agent_job_runs']);
      expect((await migrateDown(migrator)).results?.map((result) => result.migrationName)).toEqual(['0035_agent_job_limit_overrides']);
      const down = await migrateDown(migrator);
      expect(down.error).toBeUndefined();
      expect(down.results?.map((result) => result.migrationName)).toEqual(['0034_agent_job_budget_confirm']);
      const row = await budgetRow(jobId);
      expect(row).toMatchObject({ cost_limit: (2n * LIMITS.costLimit).toString(), turn_limit: 6 });
      expect(row).not.toHaveProperty('cost_step');
      expect((await migrateToLatest(migrator)).error).toBeUndefined();
      expect(await budgetRow(jobId)).toMatchObject({ cost_step: (2n * LIMITS.costLimit).toString(), turn_step: 6, confirmations: 0 });
    } finally {
      await migrator.destroy();
      database = createDatabase(testDb.appConfig);
      appDb = database.db;
      app = await buildApp(
        { ...testConfig, database: testDb.appConfig },
        { database, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} } },
      );
    }
  });
});
