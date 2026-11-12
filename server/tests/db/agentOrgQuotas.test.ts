// 每组织的 Agent 任务并发与每日运行时长（迁移 0036_agent_job_runs、src/agent/quota.ts，路线图第 8 步 8.3d）：
// - 并发：同一组织同时运行的 Agent 任务至多 1 个，超出的留在 queued、按入队时间排队；取消中的计入；其他组织、非 Agent 任务不受影响（对照组）；
//   执行者端到端：同一组织的两个 Agent 任务不重叠，两个组织的同时运行；
// - 每日运行时长：按北京时间的自然日、跨天的只计当日部分、只计本组织；用完时入队与继续 429、认领时暂停为 agent_daily_runtime、
//   执行中续租时发现即暂停；差一点用完时照常（对照组）；非 Agent 任务不受影响；
// - 执行记录：认领时写入、续租推进、结束时计到现在、执行者失联只计到最后一次续租；数据库不变式（RLS、授权、AR001）；
// - 回滚 0036：因时长用完暂停的任务改为普通暂停。
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import {
  AGENT_DAILY_RUNTIME_SECONDS,
  AGENT_ORG_RUNNING_LIMIT,
  AGENT_RUNTIME_TIME_ZONE,
  agentRuntimeUsedToday,
} from '../../src/agent/quota.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database, JobStatus } from '../../src/db/schema.ts';
import { withOrgContext, withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import { createJobTypeRegistry, type JobContext, type JobTypeDefinition, type JobTypeRegistry } from '../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../src/jobs/runner.ts';
import { cancelJob, confirmJobTaskLimit, enqueueJob, resumeJob, type JobServiceDependencies } from '../../src/jobs/service.ts';
import { claimJob, finishRun, listJobEvents, recoverJob, renewRun, type RunRef } from '../../src/jobs/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;
let redis: Redis;
let prefix: string;
let logs: ReturnType<typeof testLogger>;
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];

const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

/** 假 Agent：运行 holdMs 毫秒（期间响应中止）后完成；holdMs 为 null 时一直运行到被中止。不调用模型。 */
interface HoldParams {
  holdMs: number | null;
}

const parseHold = (raw: unknown): HoldParams => {
  const value = raw as Partial<HoldParams> | null;
  if (!value || !(value.holdMs === null || Number.isInteger(value.holdMs))) throw new TypeError('holdMs 不合法');
  return { holdMs: value.holdMs ?? null };
};

async function hold(context: JobContext<HoldParams>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = context.params.holdMs === null ? undefined : setTimeout(resolve, context.params.holdMs);
    context.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

const agentHold: JobTypeDefinition<HoldParams> = {
  type: 'test-agent-hold',
  queue: 'agent',
  resumable: true,
  agentLimits: AGENT_TASK_LIMITS.outline,
  parseParams: parseHold,
  run: hold,
};
const plainHold: JobTypeDefinition<HoldParams> = { type: 'test-plain-hold', queue: 'ai', resumable: true, parseParams: parseHold, run: hold };
const registry: JobTypeRegistry = createJobTypeRegistry([agentHold, plainHold]);

const deps = (): JobServiceDependencies => ({ db: appDb, registry, dispatcher: null, log: logs.log });

function newDispatcher(): JobDispatcher {
  const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-dispatch'), prefix });
  dispatchers.push(dispatcher);
  return dispatcher;
}

async function startRunner(): Promise<JobRunner> {
  const runner = createJobRunner({
    db: appDb,
    registry,
    dispatcher: newDispatcher(),
    connection: bullmqConnection(redisConfig(), 'worker', 'test-worker'),
    log: logs.log,
    prefix,
    leaseMs: 2_000,
    heartbeatMs: 100,
    reconcileIntervalMs: 600_000,
    deferDelayMs: 100,
    concurrency: { agent: 4, ai: 4 },
  });
  runners.push(runner);
  await runner.start();
  return runner;
}

async function newMember(role: 'owner' | 'member' = 'owner'): Promise<TenantContext> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { orgId, userId, role };
}

async function newProject(ctx: TenantContext): Promise<string> {
  const row = await withTenant(appDb, ctx, (trx) =>
    trx.insertInto('projects').values({ org_id: ctx.orgId, kind: 'technical-plan', name: '项目', created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow(),
  );
  return row.id;
}

async function enqueue(ctx: TenantContext, type = agentHold.type, holdMs: number | null = null, service = deps()): Promise<string> {
  return (await enqueueJob(service, ctx, { type, params: { holdMs }, projectId: await newProject(ctx) })).id;
}

const claimOptions = (ctx: TenantContext, jobId: string, runId = randomUUID()) => ({
  orgId: ctx.orgId,
  jobId,
  runId,
  leaseMs: 60_000,
  orgRunningLimit: 100,
  attemptsFor: () => 5,
});

async function claim(ctx: TenantContext, jobId: string, runId = randomUUID()) {
  return claimJob(appDb, claimOptions(ctx, jobId, runId));
}

async function claimRun(ctx: TenantContext, jobId: string): Promise<RunRef> {
  const runId = randomUUID();
  expect((await claim(ctx, jobId, runId)).kind).toBe('claimed');
  return { orgId: ctx.orgId, jobId, runId };
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
}

async function runRows(jobId: string) {
  return superuser.selectFrom('agent_job_runs').selectAll().where('job_id', '=', jobId).orderBy('started_at').execute();
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

/** 当日（北京时间）0 点。 */
async function dayStart(): Promise<Date> {
  const zone = sql.lit(AGENT_RUNTIME_TIME_ZONE);
  const { rows } = await sql<{ d: Date }>`SELECT date_trunc('day', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone} AS d`.execute(superuser);
  return rows[0]!.d;
}

/**
 * 以超级用户写一条已结束的执行记录（模拟之前已用掉的时长），时间以当日 0 点为基准（秒）。应用角色不能写时间，
 * 测试数据只能这样写入；挂在一个已结束的 Agent 任务上。
 */
async function pastRun(ctx: TenantContext, fromSeconds: number, toSeconds: number): Promise<string> {
  const base = (await dayStart()).getTime();
  const jobId = randomUUID();
  await superuser.insertInto('jobs').values({
    id: jobId, org_id: ctx.orgId, user_id: ctx.userId, type: agentHold.type, status: 'succeeded', finished_at: new Date(),
  }).execute();
  const end = new Date(base + toSeconds * 1000);
  await superuser.insertInto('agent_job_runs').values({
    run_id: randomUUID(), org_id: ctx.orgId, job_id: jobId, started_at: new Date(base + fromSeconds * 1000), last_seen_at: end, ended_at: end,
  }).execute();
  return jobId;
}

const usedToday = (ctx: TenantContext) => withOrgContext(appDb, ctx.orgId, (trx) => agentRuntimeUsedToday(trx, ctx.orgId));

/** 把当日时长用完（8 小时整）。 */
const exhaust = (ctx: TenantContext) => pastRun(ctx, 0, AGENT_DAILY_RUNTIME_SECONDS);

/** 模拟到了次日：删掉之前写入的执行记录（超级用户；应用角色没有 DELETE 授权）。 */
async function nextDay(ctx: TenantContext): Promise<void> {
  await superuser.deleteFrom('agent_job_runs').where('org_id', '=', ctx.orgId).where('ended_at', 'is not', null).execute();
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
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'agent-quota-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
  appDb = connect<Database>(testDb.appConfig, 30);
  redis = rawRedis();
});

beforeEach(() => {
  prefix = uniquePrefix();
  logs = testLogger();
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
  await appDb?.destroy();
  await testDb?.drop();
});

describe('并发：每组织同时运行的 Agent 任务至多 1 个', () => {
  it('起步值与设计第 5.3 节、第 9 节第 15 项相同', () => {
    expect(AGENT_ORG_RUNNING_LIMIT).toBe(1);
    expect(AGENT_DAILY_RUNTIME_SECONDS).toBe(8 * 3600);
    expect(AGENT_RUNTIME_TIME_ZONE).toBe('Asia/Shanghai');
  });

  it('同一组织第二个 Agent 任务延后、留在 queued；其他组织的 Agent 任务与本组织的非 Agent 任务照常认领（对照组）', async () => {
    const ctx = await newMember();
    const other = await newMember();
    const first = await enqueue(ctx);
    const second = await enqueue(ctx);
    await claimRun(ctx, first);
    expect((await claim(ctx, second)).kind).toBe('deferred');
    expect((await jobRow(second)).status).toBe('queued');
    expect(await runRows(second)).toHaveLength(0);
    // 对照组：其他组织不受影响，本组织的非 Agent 任务不受影响。
    await claimRun(other, await enqueue(other));
    await claimRun(ctx, await enqueue(ctx, plainHold.type));
    // 第一个结束后第二个可以认领。
    await finishRun(appDb, (await claimOptionsRun(ctx, first))!, { kind: 'succeeded' }, true);
    expect((await claim(ctx, second)).kind).toBe('claimed');
  });

  it('取消中的 Agent 任务仍计入；结束后才放行', async () => {
    const ctx = await newMember();
    const first = await enqueue(ctx);
    const second = await enqueue(ctx);
    const run = await claimRun(ctx, first);
    expect((await cancelJob(deps(), ctx, first)).status).toBe('cancelling');
    expect((await claim(ctx, second)).kind).toBe('deferred');
    expect(await finishRun(appDb, run, { kind: 'interrupted' }, true)).toBe('cancelled');
    expect((await claim(ctx, second)).kind).toBe('claimed');
  });

  it('按入队时间排队：先入队的 Agent 任务没有开始之前，后入队的不认领；暂停的不占位', async () => {
    const ctx = await newMember();
    const first = await enqueue(ctx);
    const second = await enqueue(ctx);
    const third = await enqueue(ctx);
    expect((await claim(ctx, third)).kind).toBe('deferred');
    expect((await claim(ctx, second)).kind).toBe('deferred');
    // 先入队的暂停后不再排在前面。
    await withTenant(appDb, ctx, (trx) => trx.updateTable('jobs').set({ status: 'paused' }).where('id', '=', first).execute());
    expect((await claim(ctx, third)).kind).toBe('deferred');
    expect((await claim(ctx, second)).kind).toBe('claimed');
  });

  it('上限可调（测试用的选项）：上限 2 时两个同时运行，第三个延后', async () => {
    const ctx = await newMember();
    const jobs = [await enqueue(ctx), await enqueue(ctx), await enqueue(ctx)];
    const options = (jobId: string) => ({ ...claimOptions(ctx, jobId), agentQuota: { orgAgentRunningLimit: 2 } });
    expect((await claimJob(appDb, options(jobs[0]!))).kind).toBe('claimed');
    expect((await claimJob(appDb, options(jobs[1]!))).kind).toBe('claimed');
    expect((await claimJob(appDb, options(jobs[2]!))).kind).toBe('deferred');
  });

  it('执行者端到端：同一组织的两个 Agent 任务先后执行、不重叠；另一个组织的同时执行', async () => {
    await startRunner();
    const ctx = await newMember();
    const other = await newMember();
    const service = { ...deps(), dispatcher: newDispatcher() };
    const first = await enqueue(ctx, agentHold.type, 600, service);
    const second = await enqueue(ctx, agentHold.type, 600, service);
    const parallel = await enqueue(other, agentHold.type, 600, service);
    await waitForStatus(first, 'succeeded');
    await waitForStatus(second, 'succeeded');
    await waitForStatus(parallel, 'succeeded');
    const [a] = await runRows(first);
    const [b] = await runRows(second);
    const [c] = await runRows(parallel);
    expect(b!.started_at.getTime()).toBeGreaterThanOrEqual(a!.ended_at!.getTime());
    // 另一个组织的与第一个重叠。
    expect(c!.started_at.getTime()).toBeLessThan(a!.ended_at!.getTime());
    expect(a!.started_at.getTime()).toBeLessThan(c!.ended_at!.getTime());
  });
});

/** 读出某个执行中任务的 RunRef（当前 run_id）。 */
async function claimOptionsRun(ctx: TenantContext, jobId: string): Promise<RunRef | null> {
  const row = await jobRow(jobId);
  return row.run_id ? { orgId: ctx.orgId, jobId, runId: row.run_id } : null;
}

describe('每日运行时长的计算', () => {
  it('按北京时间的自然日：跨天的只计当日部分，昨天的不计，只计本组织', async () => {
    const ctx = await newMember();
    const other = await newMember();
    expect(await usedToday(ctx)).toBe(0);
    await pastRun(ctx, -2 * 3600, 3600); // 昨天 22 点到今天 1 点：今天 1 小时
    await pastRun(ctx, -5 * 3600, -3600); // 昨天的：不计
    await pastRun(ctx, 2 * 3600, 2 * 3600 + 90); // 90 秒
    await pastRun(other, 0, 5 * 3600); // 其他组织：不计
    expect(await usedToday(ctx)).toBe(3600 + 90);
    expect(await usedToday(other)).toBe(5 * 3600);
  });

  it('执行中的按最后一次续租计；结束时计到现在', async () => {
    const ctx = await newMember();
    const jobId = await enqueue(ctx);
    const run = await claimRun(ctx, jobId);
    const [opened] = await runRows(jobId);
    expect(opened).toMatchObject({ run_id: run.runId, ended_at: null });
    expect(opened!.last_seen_at.getTime()).toBe(opened!.started_at.getTime());
    await new Promise((resolve) => setTimeout(resolve, 300));
    const state = await renewRun(appDb, run, 60_000);
    expect(state).toMatchObject({ status: 'running', agentRuntimeExhausted: false });
    const [renewed] = await runRows(jobId);
    expect(renewed!.last_seen_at.getTime() - renewed!.started_at.getTime()).toBeGreaterThanOrEqual(250);
    expect(await usedToday(ctx)).toBeGreaterThanOrEqual(0.25);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await finishRun(appDb, run, { kind: 'succeeded' }, true);
    const [ended] = await runRows(jobId);
    expect(ended!.ended_at).not.toBeNull();
    expect(ended!.ended_at!.getTime()).toBe(ended!.last_seen_at.getTime());
    expect(ended!.ended_at!.getTime()).toBeGreaterThan(renewed!.last_seen_at.getTime());
  });

  it('执行者失联：对账收回时只计到最后一次续租，失联的那段不计入；续跑是新的一次执行', async () => {
    const ctx = await newMember();
    const jobId = await enqueue(ctx);
    const runId = randomUUID();
    expect((await claimJob(appDb, { ...claimOptions(ctx, jobId, runId), leaseMs: 100 })).kind).toBe('claimed');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await recoverJob(appDb, { orgId: ctx.orgId, id: jobId }, () => true)).toMatchObject({ kind: 'dispatch', changed: true });
    const [lost] = await runRows(jobId);
    expect(lost!.ended_at!.getTime()).toBe(lost!.started_at.getTime());
    await claimRun(ctx, jobId);
    expect(await runRows(jobId)).toHaveLength(2);
  });

  it('非 Agent 任务没有执行记录，续租不检查时长', async () => {
    const ctx = await newMember();
    await exhaust(ctx);
    const jobId = await enqueue(ctx, plainHold.type);
    const run = await claimRun(ctx, jobId);
    expect(await renewRun(appDb, run, 60_000)).toMatchObject({ status: 'running', agentRuntimeExhausted: false });
    expect(await runRows(jobId)).toHaveLength(0);
  });
});

describe('每日运行时长用完', () => {
  it('入队：用完时 429 AGENT_DAILY_RUNTIME_EXHAUSTED、什么都不写；差 1 秒时照常（对照组）；非 Agent 任务照常', async () => {
    const ctx = await newMember();
    await pastRun(ctx, 0, AGENT_DAILY_RUNTIME_SECONDS - 1);
    await enqueue(ctx);
    await pastRun(ctx, AGENT_DAILY_RUNTIME_SECONDS, AGENT_DAILY_RUNTIME_SECONDS + 1);
    const projectId = await newProject(ctx);
    const error = await enqueueJob(deps(), ctx, { type: agentHold.type, params: { holdMs: null }, projectId }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 429, code: 'AGENT_DAILY_RUNTIME_EXHAUSTED' });
    expect((error as AppError).message).toContain('8 小时');
    expect(await superuser.selectFrom('jobs').select('id').where('project_id', '=', projectId).execute()).toHaveLength(0);
    await enqueue(ctx, plainHold.type);
  });

  it('认领：排队期间用完的暂停为 agent_daily_runtime（写暂停事件、不写执行记录）；用完时普通继续 429，次日继续成功', async () => {
    const ctx = await newMember();
    const jobId = await enqueue(ctx);
    await exhaust(ctx);
    expect(await claim(ctx, jobId)).toEqual({ kind: 'skipped', reason: 'paused' });
    expect(await jobRow(jobId)).toMatchObject({ status: 'paused', pause_reason: 'agent_daily_runtime', run_id: null, attempt: 0 });
    expect(await runRows(jobId)).toHaveLength(0);
    expect((await listJobEvents(appDb, ctx, jobId, 10)).at(-1)).toMatchObject({ kind: 'paused', data: { reason: 'agent_daily_runtime' } });
    await expectCode(resumeJob(deps(), ctx, jobId), 'AGENT_DAILY_RUNTIME_EXHAUSTED');
    expect((await jobRow(jobId)).status).toBe('paused');
    await nextDay(ctx);
    expect(await resumeJob(deps(), ctx, jobId)).toMatchObject({ status: 'queued', pauseReason: null });
    expect((await claim(ctx, jobId)).kind).toBe('claimed');
  });

  it('执行中：续租时发现用完即中止、暂停为 agent_daily_runtime，执行记录计到暂停时；差一点用完前照常运行', async () => {
    await startRunner();
    const ctx = await newMember();
    // 还剩 1 秒。
    await pastRun(ctx, 0, AGENT_DAILY_RUNTIME_SECONDS - 1);
    const jobId = await enqueue(ctx, agentHold.type, null, { ...deps(), dispatcher: newDispatcher() });
    await waitForStatus(jobId, 'running');
    const row = await waitForStatus(jobId, 'paused');
    expect(row.pause_reason).toBe('agent_daily_runtime');
    const [run] = await runRows(jobId);
    expect(run!.ended_at).not.toBeNull();
    const ran = run!.ended_at!.getTime() - run!.started_at.getTime();
    expect(ran).toBeGreaterThanOrEqual(900);
    expect(ran).toBeLessThan(5_000);
    expect(await usedToday(ctx)).toBeGreaterThanOrEqual(AGENT_DAILY_RUNTIME_SECONDS);
    const events = await listJobEvents(appDb, ctx, jobId, 10);
    expect(events.at(-1)).toMatchObject({ kind: 'paused', data: { reason: 'agent_daily_runtime' } });
    expect(events.at(-1)!.message).toContain('明日可继续');
  });

  it('执行中用完时已请求取消：仍为 cancelled', async () => {
    const ctx = await newMember();
    const run = await claimRun(ctx, await enqueue(ctx));
    await cancelJob(deps(), ctx, run.jobId);
    expect(await finishRun(appDb, run, { kind: 'agent-runtime-limit' }, true)).toBe('cancelled');
  });

  it('确认继续（达到任务上限后）：用完时 429，余额与上限都不改；次日确认成功', async () => {
    const ctx = await newMember();
    await creditOrganization(appDb, ctxAdmin, { orgId: ctx.orgId, type: 'recharge', amount: 10_000_000n, reference: null, note: '测试充值' });
    const run = await claimRun(ctx, await enqueue(ctx));
    expect(await finishRun(appDb, run, { kind: 'task-limit', reason: 'task_turn_limit' }, true)).toBe('paused');
    await exhaust(ctx);
    const before = await superuser.selectFrom('agent_job_budgets').selectAll().where('job_id', '=', run.jobId).executeTakeFirstOrThrow();
    await expectCode(confirmJobTaskLimit(deps(), ctx, run.jobId), 'AGENT_DAILY_RUNTIME_EXHAUSTED');
    expect(await superuser.selectFrom('agent_job_budgets').selectAll().where('job_id', '=', run.jobId).executeTakeFirstOrThrow()).toEqual(before);
    expect((await jobRow(run.jobId)).pause_reason).toBe('task_turn_limit');
    await nextDay(ctx);
    expect((await confirmJobTaskLimit(deps(), ctx, run.jobId)).status).toBe('queued');
  });
});

describe('执行记录的数据库不变式（应用角色）', () => {
  const insertRun = (ctx: TenantContext, values: Record<string, unknown>) =>
    withOrgContext(appDb, ctx.orgId, (trx) => trx.insertInto('agent_job_runs').values(values as never).execute());

  it('只能为本组织执行中、run_id 相符的 Agent 任务写入；不能写时间', async () => {
    const ctx = await newMember();
    const other = await newMember();
    const run = await claimRun(ctx, await enqueue(ctx));
    const queued = await enqueue(ctx);
    await expect(insertRun(ctx, { org_id: ctx.orgId, job_id: queued, run_id: randomUUID() })).rejects.toThrow(/row-level security/);
    // run_id 不符。
    await expect(insertRun(ctx, { org_id: ctx.orgId, job_id: run.jobId, run_id: randomUUID() })).rejects.toThrow(/row-level security/);
    // 非 Agent 任务。
    const plain = await claimRun(ctx, await enqueue(ctx, plainHold.type));
    await expect(insertRun(ctx, { org_id: ctx.orgId, job_id: plain.jobId, run_id: plain.runId })).rejects.toThrow(/row-level security/);
    // 其他组织。
    await expect(insertRun(other, { org_id: ctx.orgId, job_id: run.jobId, run_id: run.runId })).rejects.toThrow(/row-level security/);
    // 时间取数据库时间，应用角色不能写。
    await expect(insertRun(ctx, { org_id: ctx.orgId, job_id: run.jobId, run_id: randomUUID(), started_at: new Date(0) })).rejects.toThrow(/permission denied/);
    // 同一次执行只有一行（认领时已写入）。
    await expect(insertRun(ctx, { org_id: ctx.orgId, job_id: run.jobId, run_id: run.runId })).rejects.toThrow(/duplicate key/);
  });

  it('last_seen_at 只能前进、不能超过现在；结束后不能再改；不能改开始时间；不能删除；看不到其他组织的行', async () => {
    const ctx = await newMember();
    const other = await newMember();
    const run = await claimRun(ctx, await enqueue(ctx));
    const update = (values: Record<string, unknown>, who = ctx) =>
      withOrgContext(appDb, who.orgId, (trx) => trx.updateTable('agent_job_runs').set(values as never).where('run_id', '=', run.runId).executeTakeFirst());
    await expect(update({ last_seen_at: new Date(Date.now() - 86_400_000) })).rejects.toMatchObject({ code: 'AR001' });
    await expect(update({ last_seen_at: new Date(Date.now() + 3_600_000) })).rejects.toMatchObject({ code: 'AR001' });
    await expect(update({ started_at: new Date(0) })).rejects.toThrow(/permission denied/);
    // ended_at 必须等于 last_seen_at（CHECK）。
    await expect(update({ ended_at: new Date(Date.now() + 3_600_000) })).rejects.toThrow(/agent_job_runs_time_shape/);
    // 其他组织改不到、看不到。
    expect(Number((await update({ last_seen_at: sql`now()` }, other)).numUpdatedRows)).toBe(0);
    expect(await withOrgContext(appDb, other.orgId, (trx) => trx.selectFrom('agent_job_runs').selectAll().execute())).toHaveLength(0);
    await expect(
      withOrgContext(appDb, ctx.orgId, (trx) => trx.deleteFrom('agent_job_runs').where('run_id', '=', run.runId).execute()),
    ).rejects.toThrow(/permission denied/);
    await finishRun(appDb, run, { kind: 'succeeded' }, true);
    // 结束后的行不在更新策略内（影响 0 行），超级用户改同样被触发器拒绝。
    expect(Number((await update({ last_seen_at: sql`now()` })).numUpdatedRows)).toBe(0);
    await expect(superuser.updateTable('agent_job_runs').set({ last_seen_at: sql`now()` }).where('run_id', '=', run.runId).execute()).rejects.toMatchObject({ code: 'AR001' });
  });

  it('授权：应用角色只能写入标识、只能更新 last_seen_at 与 ended_at', async () => {
    const { rows } = await sql<{ privilege_type: string; column_name: string }>`
      SELECT privilege_type, column_name FROM information_schema.column_privileges
      WHERE table_name = 'agent_job_runs' AND grantee = 'bidtools_app' AND privilege_type IN ('INSERT', 'UPDATE')
      ORDER BY privilege_type, column_name`.execute(superuser);
    expect(rows.map((row) => `${row.privilege_type}:${row.column_name}`)).toEqual([
      'INSERT:job_id', 'INSERT:org_id', 'INSERT:run_id', 'UPDATE:ended_at', 'UPDATE:last_seen_at',
    ]);
    const { rows: table } = await sql<{ privilege_type: string }>`
      SELECT privilege_type FROM information_schema.table_privileges WHERE table_name = 'agent_job_runs' AND grantee = 'bidtools_app'
      ORDER BY privilege_type`.execute(superuser);
    expect(table.map((row) => row.privilege_type)).toEqual(['SELECT']);
  });
});

describe('回滚 0036', () => {
  it('因每日时长用完而暂停的任务改为普通暂停，之后再升级成功', async () => {
    const ctx = await newMember();
    const jobId = await enqueue(ctx);
    await exhaust(ctx);
    expect((await claim(ctx, jobId)).kind).toBe('skipped');
    await appDb.destroy();
    const owner = connect(testDb.ownerConfig);
    try {
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0037_agent_tool_calls']);
      const down = await migrateDown(owner);
      expect(down.error).toBeUndefined();
      expect(down.results?.map((result) => result.migrationName)).toEqual(['0036_agent_job_runs']);
      expect(await jobRow(jobId)).toMatchObject({ status: 'paused', pause_reason: null });
      expect((await migrateToLatest(owner)).error).toBeUndefined();
    } finally {
      await owner.destroy();
      appDb = connect<Database>(testDb.appConfig, 30);
    }
  });
});
