// Agent 任务的费用与轮数上限（迁移 0033_agent_job_budgets、src/agent/budget.ts，路线图第 8 步 8.3a）：
// - 入队：agent 队列的任务类型必须登记上限，入队时与任务一起写入；
// - 数据库不变式：上限不能直接改（确认继续见 agentJobBudgetConfirm.test.ts）、轮数只能逐次加 1、达到上限的原因只能设置一次（AB001），只能为本组织 queued 的任务写入，
//   只在执行中更新；计费角色只读费用上限；
// - 轮数：原子递增，并发请求也不超过上限；达到上限后记下原因、之后一律拒绝；
// - 费用：冻结时检查“已扣费 + 本任务未到期的冻结 + 本次冻结 ≤ 上限”，并发冻结也不超过上限；没有登记上限的任务不受影响；
// - 执行者：假模型永不停止时在上限处暂停（task_turn_limit / task_cost_limit），已扣费 ≤ 上限；普通的“继续”被拒绝，取消照常；
//   低于上限的任务正常完成（对照组）；暂停时已记下达到上限的原因（确认继续的前提）；
// - 回滚 0033：因上限暂停的任务改为普通暂停。
// 经 agent-gw 的模型调用路由的端到端用例（含取回已保存结果的请求计入轮数）见 tests/db/agentChat.test.ts。
import { randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { beginAgentTurn, findAgentJobBudget, markAgentBudgetExhausted, AGENT_TASK_LIMITS, type AgentTaskLimits } from '../../src/agent/budget.ts';
import { putCredential } from '../../src/ai/credentials.ts';
import { inputTokenUpperBound } from '../../src/ai/estimate.ts';
import { createAiGateway } from '../../src/ai/gateway.ts';
import { createFileKeyWrapper } from '../../src/ai/keyring.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { beginUsage, settleUsage } from '../../src/billing/usage.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import { APP_ROLE, BILLING_ROLE } from '../../src/db/roles.ts';
import type { Database, JobStatus } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import { createJobTypeRegistry, type JobContext, type JobTypeDefinition, type JobTypeRegistry } from '../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../src/jobs/runner.ts';
import { cancelJob, enqueueJob, resumeJob, type JobServiceDependencies } from '../../src/jobs/service.ts';
import { claimJob, finishRun, listJobEvents, type RunRef } from '../../src/jobs/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { startMockProvider, streamCompletion, type MockProvider } from '../ai/mockProvider.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const API_KEY = `sk-mock-${randomBytes(16).toString('hex')}`;
const keyWrapper = createFileKeyWrapper(randomBytes(32), 1);
/** 输入、输出都是 1 计费单位 / token，冻结额与扣费直接等于 token 数。 */
const PRICE_PER_MTOK = '1000000';
const MAX_OUTPUT = 400;
const MESSAGES = [{ role: 'user' as const, content: 'hi' }];
/** 网关的一次调用的冻结额（输入上界 + 最大输出）。 */
const GATEWAY_HOLD = BigInt(inputTokenUpperBound(MESSAGES) + MAX_OUTPUT);
/** 模拟服务商返回的用量（输入 100、输出 50）对应的扣费。 */
const USAGE = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
const CHARGE = 150n;
/** 直接调用 beginUsage 时的冻结额（输入 100 + 输出 100）。 */
const DIRECT_HOLD = 200n;

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;
let redis: Redis;
let provider: MockProvider;
let prefix: string;
let logs: ReturnType<typeof testLogger>;
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];

const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

async function newMember(balance = 10_000_000n): Promise<TenantContext> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  if (balance > 0n) await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: balance, reference: null, note: '测试充值' });
  return { orgId, userId, role: 'owner' };
}

/** 假模型：每一步换一个步骤键调用一次模型，steps 为 null 时永不停止（模拟被注入、无限调用的 Agent）。 */
interface LoopParams {
  steps: number | null;
}

const parseLoop = (raw: unknown): LoopParams => {
  const value = raw as Partial<LoopParams> | null;
  if (!value || !(value.steps === null || Number.isInteger(value.steps))) throw new TypeError('steps 不合法');
  return { steps: value.steps ?? null };
};

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
const registry: JobTypeRegistry = createJobTypeRegistry([
  agentType('test-agent-turns', LIMITS),
  agentType('test-agent-cost', { costLimit: 3n * CHARGE + GATEWAY_HOLD - 1n, turnLimit: 1000 }),
  agentType('test-agent-roomy', AGENT_TASK_LIMITS.outline),
  { type: 'test-plain', queue: 'ai', resumable: true, parseParams: parseLoop, run: async () => {} },
]);

function newDispatcher(): JobDispatcher {
  const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-dispatch'), prefix });
  dispatchers.push(dispatcher);
  return dispatcher;
}

function service(): JobServiceDependencies {
  return { db: appDb, registry, dispatcher: newDispatcher(), log: logs.log };
}

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
  const job = await enqueueJob({ db: appDb, registry, dispatcher: null, log: logs.log }, ctx, { type, params: { steps: null }, projectId: await newProject(ctx) });
  const runId = randomUUID();
  const claim = await claimJob(appDb, { orgId: ctx.orgId, jobId: job.id, runId, leaseMs: 60_000, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 });
  expect(claim.kind).toBe('claimed');
  return { orgId: ctx.orgId, jobId: job.id, runId };
}

const turnRef = (ctx: TenantContext, run: RunRef) => ({ tenant: ctx, jobId: run.jobId, runId: run.runId });

async function budgetRow(jobId: string) {
  return superuser.selectFrom('agent_job_budgets').selectAll().where('job_id', '=', jobId).executeTakeFirst();
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
}

async function waitForStatus(jobId: string, status: JobStatus) {
  return waitFor(async () => {
    const row = await jobRow(jobId);
    return row.status === status ? row : null;
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

const directHold = (ctx: TenantContext, jobId: string) =>
  beginUsage(appDb, ctx, {
    requestId: randomUUID(),
    source: 'job',
    jobId,
    jobType: null,
    provider: 'deepseek',
    model: 'deepseek-chat',
    estimatedInputTokens: 100,
    maxOutputTokens: 100,
    holdSeconds: 60,
  });

/** 直接写一个有上限、执行中的任务（不经入队），用于测试冻结时的费用检查。 */
async function runningJobWithCostLimit(ctx: TenantContext, costLimit: bigint): Promise<string> {
  const id = randomUUID();
  await superuser.insertInto('jobs').values({
    id, org_id: ctx.orgId, user_id: ctx.userId, type: 'test-agent-turns', status: 'running', run_id: randomUUID(),
    lease_expires_at: new Date(Date.now() + 60_000), started_at: new Date(),
  }).execute();
  await superuser.insertInto('agent_job_budgets').values({ org_id: ctx.orgId, job_id: id, cost_limit: costLimit.toString(), turn_limit: 100 }).execute();
  return id;
}

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
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'agent-budget-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
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
  await wipeQueueKeys(redis, prefix);
  // 留下的未结束任务会在下一个用例启动执行者时被对账派发。
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

describe('入队与任务类型登记', () => {
  it('Agent 任务入队时写入上限；其他任务没有上限', async () => {
    const ctx = await newMember();
    const deps = { db: appDb, registry, dispatcher: null, log: logs.log };
    const agent = await enqueueJob(deps, ctx, { type: 'test-agent-roomy', params: { steps: 1 }, projectId: await newProject(ctx) });
    expect(await budgetRow(agent.id)).toMatchObject({
      org_id: ctx.orgId, cost_limit: AGENT_TASK_LIMITS.outline.costLimit.toString(), turn_limit: AGENT_TASK_LIMITS.outline.turnLimit, turns_used: 0, exhausted_reason: null,
    });
    const plain = await enqueueJob(deps, ctx, { type: 'test-plain', params: { steps: 1 } });
    expect(await budgetRow(plain.id)).toBeUndefined();
  });

  it('起步值与 #70 决定事项第 8 项相同（元 → 计费单位）', () => {
    expect(AGENT_TASK_LIMITS).toEqual({
      contentGeneration: { costLimit: 300_000n, turnLimit: 3_000 },
      sectionRewrite: { costLimit: 50_000n, turnLimit: 500 },
      outline: { costLimit: 50_000n, turnLimit: 500 },
      templateExtraction: { costLimit: 30_000n, turnLimit: 300 },
    });
  });

  it('agent 队列的任务类型必须登记上限，其他队列不能登记；上限必须在范围内', () => {
    const base = { type: 'test-x', resumable: true, parseParams: parseLoop, run: async () => {} };
    expect(() => createJobTypeRegistry([{ ...base, queue: 'agent' }])).toThrow(/必须给出费用与轮数上限/);
    expect(() => createJobTypeRegistry([{ ...base, queue: 'ai', agentLimits: LIMITS }])).toThrow(/必须给出费用与轮数上限/);
    for (const bad of [{ costLimit: 0n, turnLimit: 1 }, { costLimit: 1n, turnLimit: 0 }, { costLimit: 100_000_001n, turnLimit: 1 }, { costLimit: 1n, turnLimit: 1.5 }]) {
      expect(() => createJobTypeRegistry([{ ...base, queue: 'agent', agentLimits: bad }])).toThrow(/不合法/);
    }
    expect(() => createJobTypeRegistry([{ ...base, queue: 'agent', agentLimits: LIMITS }])).not.toThrow();
  });
});

describe('数据库不变式（应用角色）', () => {
  async function asApp<T>(ctx: TenantContext, run: (trx: any) => Promise<T>): Promise<T> {
    return withTenant(appDb, ctx, run);
  }

  it('上限不能改、轮数只能逐次加 1、不能减少、不能超过上限、达到上限的原因不能清除（AB001 / CHECK）', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx);
    const update = (set: Record<string, unknown>) => asApp(ctx, (trx) => trx.updateTable('agent_job_budgets').set(set).where('job_id', '=', run.jobId).execute());
    // 上限只能经确认继续改（0034，见 agentJobBudgetConfirm.test.ts）：执行中直接改被守卫拒绝。
    await expectCode(update({ cost_limit: '99999999' }), 'AB001');
    await expectCode(update({ turn_limit: 100 }), 'AB001');
    await expectCode(update({ turns_used: 2 }), 'AB001');
    await update({ turns_used: 1 });
    await expectCode(update({ turns_used: 0 }), 'AB001');
    await update({ turns_used: 2 });
    await update({ turns_used: 3 });
    await expectCode(update({ turns_used: 4 }), '23514');
    await update({ exhausted_reason: 'task_turn_limit' });
    await expectCode(update({ exhausted_reason: null }), 'AB001');
    await expectCode(update({ exhausted_reason: 'task_cost_limit' }), 'AB001');
    // 超级用户（绕过授权）改上限同样被触发器拒绝。
    await expectCode(superuser.updateTable('agent_job_budgets').set({ turn_limit: 1000 }).where('job_id', '=', run.jobId).execute(), 'AB001');
    expect(await budgetRow(run.jobId)).toMatchObject({ turns_used: 3, turn_limit: 3, exhausted_reason: 'task_turn_limit' });
  });

  it('只能为本组织 queued 的任务写入，每个任务一行；不能直接写已用轮数', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx);
    const insert = (values: Record<string, unknown>) => asApp(ctx, (trx) => trx.insertInto('agent_job_budgets').values(values).execute());
    // 已在执行中的任务：RLS 拒绝（不能在执行中途补登或替换上限）。
    await superuser.deleteFrom('agent_job_budgets').where('job_id', '=', run.jobId).execute();
    await expectCode(insert({ org_id: ctx.orgId, job_id: run.jobId, cost_limit: '1', turn_limit: 1 }), '42501');
    // 直接写已用轮数、原因：没有授权。
    const queued = await enqueueJob({ db: appDb, registry, dispatcher: null, log: logs.log }, ctx, { type: 'test-plain', params: { steps: 1 } });
    await expectCode(insert({ org_id: ctx.orgId, job_id: queued.id, cost_limit: '1', turn_limit: 1, turns_used: 0 }), '42501');
    await insert({ org_id: ctx.orgId, job_id: queued.id, cost_limit: '1', turn_limit: 1 });
    await expectCode(insert({ org_id: ctx.orgId, job_id: queued.id, cost_limit: '1', turn_limit: 1 }), '23505');
    // 另一个组织的任务：不可见，写入被拒绝（复合外键或 RLS）。
    const other = await newMember();
    const otherRun = await runningAgentJob(other);
    expect(await asApp(ctx, (trx) => trx.selectFrom('agent_job_budgets').selectAll().where('job_id', '=', otherRun.jobId).execute())).toEqual([]);
    const otherQueued = await enqueueJob({ db: appDb, registry, dispatcher: null, log: logs.log }, other, { type: 'test-plain', params: { steps: 1 } });
    await expect(insert({ org_id: ctx.orgId, job_id: otherQueued.id, cost_limit: '1', turn_limit: 1 })).rejects.toThrow();
    await expectCode(insert({ org_id: other.orgId, job_id: otherQueued.id, cost_limit: '1', turn_limit: 1 }), '42501');
  });

  it('不在执行中的任务不能更新；另一个组织的行改不到', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx);
    const other = await newMember();
    const changed = await withTenant(appDb, other, (trx) => trx.updateTable('agent_job_budgets').set({ turns_used: 1 }).where('job_id', '=', run.jobId).executeTakeFirst());
    expect(changed.numUpdatedRows).toBe(0n);
    await superuser.updateTable('jobs').set({ status: 'paused', run_id: null, lease_expires_at: null }).where('id', '=', run.jobId).execute();
    const paused = await withTenant(appDb, ctx, (trx) => trx.updateTable('agent_job_budgets').set({ turns_used: 1 }).where('job_id', '=', run.jobId).executeTakeFirst());
    expect(paused.numUpdatedRows).toBe(0n);
    expect((await budgetRow(run.jobId))!.turns_used).toBe(0);
  });

  it('授权：应用角色只能写入上限、只能更新已用轮数、原因与（确认继续时的）上限；计费角色只读费用上限', async () => {
    const privilege = async (role: string, column: string, kind: string) =>
      (await sql<{ ok: boolean }>`SELECT has_column_privilege(${role}, 'agent_job_budgets', ${column}, ${kind}) AS ok`.execute(superuser)).rows[0]!.ok;
    expect(await privilege(APP_ROLE, 'cost_limit', 'INSERT')).toBe(true);
    expect(await privilege(APP_ROLE, 'turns_used', 'INSERT')).toBe(false);
    expect(await privilege(APP_ROLE, 'exhausted_reason', 'INSERT')).toBe(false);
    // 0034：上限与确认次数可以更新（只能经确认继续，由守卫限定）；“一份”额度不能写。
    expect(await privilege(APP_ROLE, 'cost_limit', 'UPDATE')).toBe(true);
    expect(await privilege(APP_ROLE, 'turn_limit', 'UPDATE')).toBe(true);
    expect(await privilege(APP_ROLE, 'cost_step', 'UPDATE')).toBe(false);
    expect(await privilege(APP_ROLE, 'turn_step', 'UPDATE')).toBe(false);
    expect(await privilege(APP_ROLE, 'cost_step', 'INSERT')).toBe(false);
    expect(await privilege(APP_ROLE, 'confirmations', 'INSERT')).toBe(false);
    expect(await privilege(APP_ROLE, 'turns_used', 'UPDATE')).toBe(true);
    const table = async (role: string, kind: string) =>
      (await sql<{ ok: boolean }>`SELECT has_table_privilege(${role}, 'agent_job_budgets', ${kind}) AS ok`.execute(superuser)).rows[0]!.ok;
    expect(await table(APP_ROLE, 'DELETE')).toBe(false);
    expect(await privilege(BILLING_ROLE, 'cost_limit', 'SELECT')).toBe(true);
    expect(await privilege(BILLING_ROLE, 'turns_used', 'SELECT')).toBe(false);
    for (const kind of ['INSERT', 'UPDATE', 'DELETE']) expect(await table(BILLING_ROLE, kind)).toBe(false);
  });

  it('随任务记录删除', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx);
    await superuser.deleteFrom('jobs').where('id', '=', run.jobId).execute();
    expect(await budgetRow(run.jobId)).toBeUndefined();
  });
});

describe('轮数上限（beginAgentTurn）', () => {
  it('计到上限后 TASK_TURN_LIMIT 并记下原因，之后一律拒绝、不再计数', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx);
    for (let turn = 1; turn <= LIMITS.turnLimit; turn += 1) {
      expect(await beginAgentTurn(appDb, turnRef(ctx, run))).toEqual({ turnsUsed: turn, turnLimit: LIMITS.turnLimit });
    }
    await expectCode(beginAgentTurn(appDb, turnRef(ctx, run)), 'TASK_TURN_LIMIT');
    await expectCode(beginAgentTurn(appDb, turnRef(ctx, run)), 'TASK_TURN_LIMIT');
    expect(await findAgentJobBudget(appDb, run)).toMatchObject({ turnsUsed: LIMITS.turnLimit, exhaustedReason: 'task_turn_limit', billedAmount: 0n });
  });

  it('并发请求：恰好计入上限那么多次', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx, 'test-agent-roomy');
    await superuser.deleteFrom('agent_job_budgets').where('job_id', '=', run.jobId).execute();
    await superuser.insertInto('agent_job_budgets').values({ org_id: ctx.orgId, job_id: run.jobId, cost_limit: '1000', turn_limit: 5 }).execute();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => beginAgentTurn(appDb, turnRef(ctx, run))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    for (const result of results) if (result.status === 'rejected') expect((result.reason as AppError).code).toBe('TASK_TURN_LIMIT');
    expect(await budgetRow(run.jobId)).toMatchObject({ turns_used: 5, exhausted_reason: 'task_turn_limit' });
  });

  it('达到费用上限后（已记下原因）按该原因拒绝', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx);
    expect(await markAgentBudgetExhausted(appDb, turnRef(ctx, run), 'task_cost_limit')).toBe('task_cost_limit');
    // 已记下的原因不被覆盖。
    expect(await markAgentBudgetExhausted(appDb, turnRef(ctx, run), 'task_turn_limit')).toBe('task_cost_limit');
    await expectCode(beginAgentTurn(appDb, turnRef(ctx, run)), 'TASK_COST_LIMIT');
    expect((await budgetRow(run.jobId))!.turns_used).toBe(0);
  });

  it('不是本次执行（run_id 不符、任务已暂停）：JOB_NOT_RUNNING；没有登记上限：AGENT_BUDGET_MISSING；都不计数', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx);
    await expectCode(beginAgentTurn(appDb, { ...turnRef(ctx, run), runId: randomUUID() }), 'JOB_NOT_RUNNING');
    // 另一个组织的身份：查不到任务（RLS），按没有登记处理。
    const other = await newMember();
    await expectCode(beginAgentTurn(appDb, { tenant: other, jobId: run.jobId, runId: run.runId }), 'AGENT_BUDGET_MISSING');
    expect((await budgetRow(run.jobId))!.turns_used).toBe(0);
    await superuser.deleteFrom('agent_job_budgets').where('job_id', '=', run.jobId).execute();
    await expectCode(beginAgentTurn(appDb, turnRef(ctx, run)), 'AGENT_BUDGET_MISSING');
  });
});

describe('费用上限（冻结时检查）', () => {
  it('对照组：已扣费 + 冻结 + 本次冻结不超过上限时冻结成功', async () => {
    const ctx = await newMember();
    const jobId = await runningJobWithCostLimit(ctx, 2n * DIRECT_HOLD);
    const first = await directHold(ctx, jobId);
    await settleUsage(appDb, ctx, first.usageId, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 100, usageSource: 'provider' });
    expect((await jobRow(jobId)).billed_amount).toBe(DIRECT_HOLD.toString());
    // 已扣费 200 + 本次冻结 200 = 上限 400：恰好可以。
    await directHold(ctx, jobId);
  });

  it('超出上限：TASK_COST_LIMIT，不冻结、不写用量记录；未到期的冻结计入', async () => {
    const ctx = await newMember();
    const jobId = await runningJobWithCostLimit(ctx, 2n * DIRECT_HOLD + 1n);
    await directHold(ctx, jobId);
    await directHold(ctx, jobId);
    // 两个进行中的冻结已占 400，再冻结 200 超出 401。
    await expectCode(directHold(ctx, jobId), 'TASK_COST_LIMIT');
    const rows = await superuser.selectFrom('usage_records').select('status').where('job_id', '=', jobId).execute();
    expect(rows).toHaveLength(2);
  });

  it('已扣费计入：结算后剩余额度不足一次冻结即拒绝', async () => {
    const ctx = await newMember();
    const jobId = await runningJobWithCostLimit(ctx, DIRECT_HOLD + 50n);
    const first = await directHold(ctx, jobId);
    await settleUsage(appDb, ctx, first.usageId, { inputTokens: 60, cachedInputTokens: 0, outputTokens: 40, usageSource: 'provider' });
    // 已扣费 100 + 本次 200 > 250。
    await expectCode(directHold(ctx, jobId), 'TASK_COST_LIMIT');
  });

  it('并发冻结：合计不超过上限', async () => {
    const ctx = await newMember();
    const jobId = await runningJobWithCostLimit(ctx, 3n * DIRECT_HOLD + DIRECT_HOLD / 2n);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => directHold(ctx, jobId)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    for (const result of results) if (result.status === 'rejected') expect((result.reason as AppError).code).toBe('TASK_COST_LIMIT');
  });

  it('没有登记上限的任务不受影响（第 6 步的任务）', async () => {
    const ctx = await newMember();
    const jobId = await runningJobWithCostLimit(ctx, 1n);
    await superuser.deleteFrom('agent_job_budgets').where('job_id', '=', jobId).execute();
    for (let index = 0; index < 3; index += 1) await directHold(ctx, jobId);
  });
});

describe('执行者：达到上限即暂停（假模型永不停止）', () => {
  it('轮数上限：调用 3 次后暂停为 task_turn_limit，服务商只被调用 3 次；事件记下已扣费与上限', async () => {
    await startRunner();
    const ctx = await newMember();
    const job = await enqueueJob(service(), ctx, { type: 'test-agent-turns', params: { steps: null }, projectId: await newProject(ctx) });
    const row = await waitForStatus(job.id, 'paused');
    expect(row.pause_reason).toBe('task_turn_limit');
    expect(provider.requests).toHaveLength(LIMITS.turnLimit);
    expect(row.billed_amount).toBe((BigInt(LIMITS.turnLimit) * CHARGE).toString());
    const events = await listJobEvents(appDb, ctx, job.id, 50);
    expect(events.at(-1)).toMatchObject({
      kind: 'paused',
      data: { reason: 'task_turn_limit', billedAmount: row.billed_amount, costLimit: LIMITS.costLimit.toString(), turnLimit: 3, turnsUsed: 3 },
    });
    expect(events.at(-1)!.message).toContain('调用次数已达到上限');
  });

  it('费用上限：已扣费 ≤ 上限，暂停为 task_cost_limit', async () => {
    await startRunner();
    const ctx = await newMember();
    const job = await enqueueJob(service(), ctx, { type: 'test-agent-cost', params: { steps: null }, projectId: await newProject(ctx) });
    const row = await waitForStatus(job.id, 'paused');
    expect(row.pause_reason).toBe('task_cost_limit');
    const budget = (await budgetRow(job.id))!;
    expect(BigInt(row.billed_amount)).toBeLessThanOrEqual(BigInt(budget.cost_limit));
    // 上限 = 3 次扣费 + 1 次冻结 − 1：第 4 次冻结超出，只调用了 3 次。
    expect(provider.requests).toHaveLength(3);
    expect(budget.exhausted_reason).toBe('task_cost_limit');
    expect(await superuser.selectFrom('usage_records').select('id').where('job_id', '=', job.id).execute()).toHaveLength(3);
  });

  it('对照组：低于上限的任务正常完成', async () => {
    await startRunner();
    const ctx = await newMember();
    const job = await enqueueJob(service(), ctx, { type: 'test-agent-turns', params: { steps: LIMITS.turnLimit }, projectId: await newProject(ctx) });
    const row = await waitForStatus(job.id, 'succeeded');
    expect(row.pause_reason).toBeNull();
    expect(provider.requests).toHaveLength(LIMITS.turnLimit);
  });

  it('因上限暂停的任务：普通的继续被拒绝（须确认继续，8.3b），取消照常', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx);
    expect(await finishRun(appDb, run, { kind: 'task-limit', reason: 'task_cost_limit' }, true)).toBe('paused');
    expect(await jobRow(run.jobId)).toMatchObject({ status: 'paused', pause_reason: 'task_cost_limit', run_id: null });
    // 执行者没能记下原因时，暂停的同一事务中补上（确认继续的前提）。
    expect((await budgetRow(run.jobId))!.exhausted_reason).toBe('task_cost_limit');
    const deps = { db: appDb, registry, dispatcher: null, log: logs.log };
    await expectCode(resumeJob(deps, ctx, run.jobId), 'JOB_TASK_LIMIT_CONFIRM_REQUIRED');
    expect((await jobRow(run.jobId)).status).toBe('paused');
    expect((await cancelJob(deps, ctx, run.jobId)).status).toBe('cancelled');
  });

  it('已请求取消时达到上限：仍为 cancelled', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx);
    await cancelJob({ db: appDb, registry, dispatcher: null, log: logs.log }, ctx, run.jobId);
    expect(await finishRun(appDb, run, { kind: 'task-limit', reason: 'task_turn_limit' }, true)).toBe('cancelled');
  });
});

describe('回滚 0033', () => {
  it('因上限暂停的任务改为普通暂停，之后再升级成功', async () => {
    const ctx = await newMember();
    const run = await runningAgentJob(ctx);
    await finishRun(appDb, run, { kind: 'task-limit', reason: 'task_turn_limit' }, true);
    await Promise.all(runners.splice(0).map((runner) => runner.close()));
    await appDb.destroy();
    const owner = connect(testDb.ownerConfig);
    try {
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0042_agent_tool_scopes']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0041_job_pause_storage_quota']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0040_agent_workspace_snapshots']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0039_agent_questions']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0038_agent_failure_reports']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0037_agent_tool_calls']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0036_agent_job_runs']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0035_agent_job_limit_overrides']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0034_agent_job_budget_confirm']);
      const down = await migrateDown(owner);
      expect(down.error).toBeUndefined();
      expect(down.results?.map((result) => result.migrationName)).toEqual(['0033_agent_job_budgets']);
      expect(await jobRow(run.jobId)).toMatchObject({ status: 'paused', pause_reason: null });
      expect((await migrateToLatest(owner)).error).toBeUndefined();
    } finally {
      await owner.destroy();
      appDb = connect<Database>(testDb.appConfig, 30);
    }
  });
});
