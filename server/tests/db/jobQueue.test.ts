// 任务队列（迁移 0021_jobs、src/jobs/）与真实 Valkey 的集成测试：jobs 表是唯一权威，Redis 重启或被清空后，
// 未完成的任务从数据库恢复入队，不丢失、不重复执行；执行者崩溃后按租约收回并从 checkpoint 续跑。
// 需要 TEST_DATABASE_ADMIN_URL 和 TEST_REDIS_URL / TEST_REDIS_PASSWORD；真实重启 Redis 的用例另需 TEST_REDIS_RESTART_COMMAND
// （CI 中是 docker restart valkey，见 .github/workflows/ci.yml）。
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database, JobStatus } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner, type JobRunnerOptions } from '../../src/jobs/runner.ts';
import { enqueueJob, pauseJob, resumeJob, cancelJob, type JobServiceDependencies } from '../../src/jobs/service.ts';
import { claimJob, finishRun, findJob, type JobRecord } from '../../src/jobs/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { AppError } from '../../src/errors.ts';
import {
  countQueueKeys,
  createTestJobTypes,
  rawRedis,
  redisConfig,
  testLogger,
  uniquePrefix,
  waitFor,
  wipeQueueKeys,
  type EchoParams,
} from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let redis: Redis;

let types: ReturnType<typeof createTestJobTypes>;
let prefix: string;
let logs: ReturnType<typeof testLogger>;
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];
const queues: Queue[] = [];

async function newMember(): Promise<TenantContext> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, userId, role: 'owner' };
}

function newDispatcher(): JobDispatcher {
  const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-dispatch'), prefix });
  dispatchers.push(dispatcher);
  return dispatcher;
}

function service(dispatcher: JobDispatcher | null = newDispatcher()): JobServiceDependencies {
  return { db: appDb, registry: types.registry, dispatcher, log: logs.log };
}

async function startRunner(options: Partial<JobRunnerOptions> = {}): Promise<JobRunner> {
  const runner = createJobRunner({
    db: appDb,
    registry: types.registry,
    dispatcher: newDispatcher(),
    connection: bullmqConnection(redisConfig(), 'worker', 'test-worker'),
    log: logs.log,
    prefix,
    leaseMs: 1_000,
    heartbeatMs: 150,
    // 定期对账在这些用例中关掉（间隔足够长），由用例显式调用或由 Redis 重新连上时触发，结果才可预期。
    reconcileIntervalMs: 600_000,
    deferDelayMs: 200,
    ...options,
  });
  runners.push(runner);
  await runner.start();
  return runner;
}

async function stopRunner(runner: JobRunner): Promise<void> {
  await runner.close();
  runners.splice(runners.indexOf(runner), 1);
}

async function enqueue(
  context: TenantContext,
  params: EchoParams,
  options: { type?: string; lockKey?: string; deps?: JobServiceDependencies } = {},
): Promise<JobRecord> {
  return enqueueJob(options.deps ?? service(), context, {
    type: options.type ?? 'test-echo',
    params: params as unknown as Record<string, unknown>,
    ...(options.lockKey ? { lockKey: options.lockKey } : {}),
  });
}

async function statusOf(jobId: string) {
  return superuser.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
}

async function waitForStatus(jobId: string, status: JobStatus, timeoutMs = 15_000) {
  return waitFor(
    async () => {
      const row = await statusOf(jobId);
      return row.status === status ? row : null;
    },
    timeoutMs,
    `job ${jobId} → ${status}`,
  );
}

async function eventKinds(jobId: string): Promise<string[]> {
  const rows = await superuser.selectFrom('job_events').select('kind').where('job_id', '=', jobId).orderBy('id').execute();
  return rows.map((row: { kind: string }) => row.kind);
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
  database = createDatabase(testDb.appConfig, { maxConnections: 20 });
  appDb = database.db;
  redis = rawRedis();
});

beforeEach(() => {
  types = createTestJobTypes();
  prefix = uniquePrefix();
  logs = testLogger();
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await wipeQueueKeys(redis, prefix);
  // 不让一个用例留下的未结束任务被后面用例的 worker 对账执行。
  await superuser
    .updateTable('jobs')
    .set({ status: 'cancelled', pause_requested: false, run_id: null, lease_expires_at: null, finished_at: sql`now()` })
    .where('status', 'in', ['queued', 'running', 'paused', 'cancelling'])
    .execute();
});

afterAll(async () => {
  redis?.disconnect();
  await database?.destroy();
  await testDb?.drop();
});

describe('任务执行', () => {
  it('入队后由 worker 执行一次：状态、进度、事件和发起用户的上下文', async () => {
    const member = await newMember();
    await startRunner();
    const job = await enqueue(member, { steps: 3 });
    expect(job).toMatchObject({ status: 'queued', attempt: 0, progress: 0 });

    const row = await waitForStatus(job.id, 'succeeded');
    expect(row).toMatchObject({ progress: 100, attempt: 1, run_id: null, lease_expires_at: null, error_code: null });
    expect(row.checkpoint).toEqual({ step: 3 });
    expect(row.finished_at).toBeInstanceOf(Date);
    expect(types.executions.get(job.id)).toEqual({
      runs: [{ attempt: 1, startStep: 0, userId: member.userId, orgId: member.orgId }],
      completed: 1,
    });
    expect(await eventKinds(job.id)).toEqual(['queued', 'started', 'log', 'succeeded']);
    // 完成后 BullMQ 不保留任务（状态只在 jobs 中）。
    await waitFor(async () => ((await redis.exists(`${prefix}:ai:${job.id}`)) === 0 ? true : null), 5_000, 'bullmq job removed');
  });

  it('同一任务被派发多次（重复投递）也只执行一次', async () => {
    const member = await newMember();
    const job = await enqueue(member, { steps: 1, hold: true });
    // 另以不同的 BullMQ id 再放入两次，模拟重复投递（例如对账与入队同时放入、stalled 后被再次派发）。
    const queue = new Queue('ai', { connection: bullmqConnection(redisConfig(), 'producer', 'dup'), prefix });
    queues.push(queue);
    await queue.add('test-echo', { orgId: member.orgId }, { jobId: randomUUID(), removeOnComplete: true, removeOnFail: true });
    await queue.add('test-echo', { orgId: member.orgId }, { jobId: randomUUID(), removeOnComplete: true, removeOnFail: true });
    await startRunner();

    await types.gate(job.id, 0).entered;
    // 三次投递都已被消费（两次认领失败直接作废），此时只有一次执行在进行。
    await waitFor(async () => ((await queue.getJobCounts('wait', 'delayed')).wait === 0 ? true : null));
    types.gate(job.id, 0).open();
    await waitForStatus(job.id, 'succeeded');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(types.executions.get(job.id)?.runs).toHaveLength(1);
    expect(types.executions.get(job.id)?.completed).toBe(1);
    expect((await eventKinds(job.id)).filter((kind) => kind === 'started')).toHaveLength(1);
  });

  it('派发数据中的组织与任务不符时，在该组织的上下文中查不到任务，认领失败；任务按记录中的组织执行一次', async () => {
    const member = await newMember();
    const other = await newMember();
    const job = await enqueue(member, { steps: 1 }, { deps: service(null) });
    const forged = await claimJob(appDb, {
      orgId: other.orgId,
      jobId: job.id,
      runId: randomUUID(),
      leaseMs: 1_000,
      orgRunningLimit: 3,
      attemptsFor: () => 3,
    });
    expect(forged).toEqual({ kind: 'skipped', reason: 'missing' });
    expect(await statusOf(job.id)).toMatchObject({ status: 'queued', attempt: 0 });

    const queue = new Queue('ai', { connection: bullmqConnection(redisConfig(), 'producer', 'forged'), prefix });
    queues.push(queue);
    await queue.add('test-echo', { orgId: other.orgId }, { jobId: randomUUID(), removeOnComplete: true, removeOnFail: true });
    await startRunner();
    await waitForStatus(job.id, 'succeeded');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(types.executions.get(job.id)?.runs).toEqual([{ attempt: 1, startStep: 0, userId: member.userId, orgId: member.orgId }]);
  });

  it('失败：JobError 的代码和文案写入任务；其他错误只记通用文案，内部消息不进任务记录', async () => {
    const member = await newMember();
    await startRunner();
    const expected = await enqueue(member, { steps: 2, failAt: 1, failWith: 'job-error' });
    const crashed = await enqueue(member, { steps: 2, failAt: 0, failWith: 'crash' });
    expect(await waitForStatus(expected.id, 'failed')).toMatchObject({ error_code: 'TEST_FAILED', error_message: '测试任务按要求失败' });
    const row = await waitForStatus(crashed.id, 'failed');
    expect(row).toMatchObject({ error_code: 'JOB_FAILED', error_message: '任务执行失败' });
    const events = await superuser.selectFrom('job_events').select(['message', 'data']).where('job_id', '=', crashed.id).execute();
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('发起用户已被移出组织时不执行，标为 JOB_USER_REMOVED', async () => {
    const member = await newMember();
    const job = await enqueue(member, { steps: 1 }, { deps: service(null) });
    await superuser.deleteFrom('org_memberships').where('user_id', '=', member.userId).execute();
    await startRunner();
    expect(await waitForStatus(job.id, 'failed')).toMatchObject({ error_code: 'JOB_USER_REMOVED' });
    expect(types.executions.has(job.id)).toBe(false);
  });

  it('互斥：同一 lock_key 已有未结束的任务时入队被拒绝（409），结束后可以再次入队', async () => {
    const member = await newMember();
    const lockKey = `project:${randomUUID()}:technical-plan`;
    const first = await enqueue(member, { steps: 1 }, { lockKey, deps: service(null) });
    await expect(enqueue(member, { steps: 1 }, { lockKey, deps: service(null) })).rejects.toMatchObject({
      statusCode: 409,
      code: 'JOB_LOCKED',
    });
    await startRunner();
    await waitForStatus(first.id, 'succeeded');
    const second = await enqueue(member, { steps: 1 }, { lockKey });
    await waitForStatus(second.id, 'succeeded');
  });

  it('参数不合法或任务类型未登记时不入队', async () => {
    const member = await newMember();
    await expect(enqueue(member, { steps: 0 })).rejects.toThrow(/steps/);
    await expect(enqueue(member, { steps: 1 }, { type: 'not-registered' })).rejects.toThrow(/未登记/);
    expect(await superuser.selectFrom('jobs').select('id').where('org_id', '=', member.orgId).execute()).toEqual([]);
  });

  it('组织级并发：超出上限的任务留在 queued，前面的结束后再执行', async () => {
    const member = await newMember();
    await startRunner({ orgRunningLimit: 1 });
    const first = await enqueue(member, { steps: 1, hold: true });
    const second = await enqueue(member, { steps: 1 });
    await types.gate(first.id, 0).entered;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await statusOf(second.id)).status).toBe('queued');
    expect(types.executions.has(second.id)).toBe(false);

    // 另一个组织不受影响。
    const other = await newMember();
    const otherJob = await enqueue(other, { steps: 1 });
    await waitForStatus(otherJob.id, 'succeeded');

    types.gate(first.id, 0).open();
    await waitForStatus(first.id, 'succeeded');
    await waitForStatus(second.id, 'succeeded');
    expect(types.executions.get(second.id)?.runs).toHaveLength(1);
  });
});

describe('Redis 不持久化：重启或清空后从 jobs 表恢复', () => {
  it('清空 Redis 后，未完成的任务（排队中、延后中、执行中）全部恢复，各执行一次', async () => {
    const member = await newMember();
    const runner = await startRunner({ orgRunningLimit: 1 });
    const running = await enqueue(member, { steps: 2, hold: true });
    await types.gate(running.id, 0).entered;
    const waiting = await Promise.all([1, 2, 3].map(() => enqueue(member, { steps: 1 })));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await countQueueKeys(redis, prefix)).toBeGreaterThan(0);

    // 清空：BullMQ 中的等待、延后、执行中的记录和锁全部丢失。
    expect(await wipeQueueKeys(redis, prefix)).toBeGreaterThan(0);
    expect(await countQueueKeys(redis, prefix)).toBe(0);
    for (const job of waiting) expect((await statusOf(job.id)).status).toBe('queued');

    // 对账从 jobs 重新放入；执行中的任务租约仍有效（执行者在续租），不会被收回、不会再派发一次。
    const result = await runner.reconcile();
    expect(result).toEqual({ dispatched: 3, failed: 0 });
    expect((await statusOf(running.id)).status).toBe('running');

    types.gate(running.id, 0).open();
    types.gate(running.id, 1).open();
    await waitForStatus(running.id, 'succeeded');
    for (const job of waiting) await waitForStatus(job.id, 'succeeded');
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const job of [running, ...waiting]) {
      expect(types.executions.get(job.id)?.runs, job.id).toHaveLength(1);
      expect(types.executions.get(job.id)?.completed, job.id).toBe(1);
      expect((await statusOf(job.id)).attempt).toBe(1);
    }
  });

  it('worker 运行中 Redis 被清空：worker 发现哨兵键丢失后自动对账，不需要等定期对账', async () => {
    const member = await newMember();
    await startRunner({ orgRunningLimit: 1, redisCheckIntervalMs: 200 });
    const running = await enqueue(member, { steps: 1, hold: true });
    await types.gate(running.id, 0).entered;
    const waiting = await Promise.all([1, 2].map(() => enqueue(member, { steps: 1 })));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await wipeQueueKeys(redis, prefix);
    await waitFor(
      async () => logs.entries.some((entry) => entry.msg === 'job queue state missing in redis (restart or flush), reconciling from database'),
      5_000,
      'sentinel detection',
    );
    types.gate(running.id, 0).open();
    for (const job of [running, ...waiting]) await waitForStatus(job.id, 'succeeded');
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const job of [running, ...waiting]) expect(types.executions.get(job.id)?.runs, job.id).toHaveLength(1);
  });

  it('worker 与 Redis 一起重启（连接全部断开、数据全部丢失）：新 worker 启动时对账，排队中的任务恢复执行，不重复', async () => {
    const member = await newMember();
    // 入队时 Redis 可用，任务已放进 BullMQ，但还没有 worker 消费。
    const jobs = await Promise.all([1, 2, 3, 4].map(() => enqueue(member, { steps: 2 })));
    expect(await countQueueKeys(redis, prefix)).toBeGreaterThan(0);
    await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
    await wipeQueueKeys(redis, prefix);

    await startRunner();
    for (const job of jobs) await waitForStatus(job.id, 'succeeded');
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const job of jobs) {
      expect(types.executions.get(job.id)?.runs).toHaveLength(1);
      expect(await eventKinds(job.id)).toEqual(['queued', 'started', 'log', 'succeeded']);
    }
  });

  it('入队时 Redis 不可用：任务仍写入 jobs，之后由对账派发', async () => {
    const member = await newMember();
    const unreachable = createJobDispatcher({
      connection: { ...bullmqConnection(redisConfig(), 'producer', 'unreachable'), port: 1, retryStrategy: () => null },
      prefix,
    });
    dispatchers.push(unreachable);
    const job = await enqueue(member, { steps: 1 }, { deps: service(unreachable) });
    expect((await statusOf(job.id)).status).toBe('queued');
    expect(logs.entries.some((entry) => entry.msg === 'job dispatch failed, left for reconcile')).toBe(true);
    await startRunner();
    await waitForStatus(job.id, 'succeeded');
    expect(types.executions.get(job.id)?.runs).toHaveLength(1);
  });

  it.skipIf(!process.env.TEST_REDIS_RESTART_COMMAND)('真实重启 Redis：worker 重新连上后自动对账，任务不丢失、不重复', async () => {
    const member = await newMember();
    await startRunner({ orgRunningLimit: 1, leaseMs: 5_000, heartbeatMs: 500 });
    const running = await enqueue(member, { steps: 2, hold: true });
    await types.gate(running.id, 0).entered;
    const waiting = await Promise.all([1, 2].map(() => enqueue(member, { steps: 1 })));
    await new Promise((resolve) => setTimeout(resolve, 300));

    execSync(process.env.TEST_REDIS_RESTART_COMMAND!, { stdio: 'inherit', timeout: 60_000 });
    // 重启后数据全部丢失（不持久化）。
    await waitFor(async () => {
      try {
        return (await redis.ping()) === 'PONG';
      } catch {
        return null;
      }
    }, 30_000, 'redis back');
    // 执行中的任务继续（租约在数据库中，Redis 重启不影响）；不手动对账，由 worker 重新连上时触发。
    types.gate(running.id, 0).open();
    types.gate(running.id, 1).open();
    await waitForStatus(running.id, 'succeeded', 30_000);
    for (const job of waiting) await waitForStatus(job.id, 'succeeded', 30_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const job of [running, ...waiting]) {
      expect(types.executions.get(job.id)?.runs, job.id).toHaveLength(1);
      expect(types.executions.get(job.id)?.completed, job.id).toBe(1);
    }
  }, 120_000);
});

describe('执行者失联与续跑', () => {
  /** 模拟一个认领后崩溃的 worker：认领、保存 checkpoint，然后不再续租。 */
  async function crashAfterClaim(job: JobRecord, checkpoint: Record<string, unknown> | null) {
    const runId = randomUUID();
    const claim = await claimJob(appDb, {
      orgId: job.orgId,
      jobId: job.id,
      runId,
      leaseMs: 300,
      orgRunningLimit: 3,
      attemptsFor: () => 3,
    });
    expect(claim.kind).toBe('claimed');
    if (checkpoint) {
      await superuser.updateTable('jobs').set({ checkpoint: JSON.stringify(checkpoint) }).where('id', '=', job.id).execute();
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return runId;
  }

  it('可续跑的任务：租约过期后由对账收回，从 checkpoint 继续；原执行者之后的写入不生效', async () => {
    const member = await newMember();
    const job = await enqueue(member, { steps: 4 }, { deps: service(null) });
    const staleRunId = await crashAfterClaim(job, { step: 2 });

    const runner = await startRunner();
    await runner.reconcile();
    const row = await waitForStatus(job.id, 'succeeded');
    expect(row.attempt).toBe(2);
    expect(types.executions.get(job.id)?.runs).toEqual([{ attempt: 2, startStep: 2, userId: member.userId, orgId: member.orgId }]);
    expect(await eventKinds(job.id)).toEqual(['queued', 'started', 'recovered', 'started', 'log', 'succeeded']);

    // 原执行者“醒来”后想把任务标为失败：run_id 已不是它的，什么都不写。
    expect(await finishRun(appDb, { orgId: job.orgId, jobId: job.id, runId: staleRunId }, { kind: 'failed', code: 'X', message: 'x' }, true)).toBeNull();
    expect((await statusOf(job.id)).status).toBe('succeeded');
  });

  it('不可续跑的任务：租约过期后标为 JOB_INTERRUPTED，不再执行', async () => {
    const member = await newMember();
    const job = await enqueue(member, { steps: 1 }, { type: 'test-oneshot', deps: service(null) });
    await crashAfterClaim(job, null);
    const runner = await startRunner();
    await runner.reconcile();
    expect(await waitForStatus(job.id, 'failed')).toMatchObject({ error_code: 'JOB_INTERRUPTED' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(types.executions.has(job.id)).toBe(false);
  });

  it('多次中断后不再续跑（JOB_ATTEMPTS_EXHAUSTED）', async () => {
    const member = await newMember();
    const job = await enqueue(member, { steps: 1 }, { deps: service(null) });
    const runner = await startRunner();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runner.close();
      await crashAfterClaim(job, null);
      await superuser
        .updateTable('jobs')
        .set({ status: 'queued', run_id: null, lease_expires_at: null })
        .where('id', '=', job.id)
        .where('attempt', '<', 3)
        .execute();
    }
    const fresh = await startRunner();
    await fresh.reconcile();
    expect(await waitForStatus(job.id, 'failed')).toMatchObject({ error_code: 'JOB_ATTEMPTS_EXHAUSTED', attempt: 3 });
    expect(types.executions.has(job.id)).toBe(false);
  });

  it('worker 正常关闭：执行中的可续跑任务回到 queued，下一个 worker 从 checkpoint 继续', async () => {
    const member = await newMember();
    const first = await startRunner();
    const job = await enqueue(member, { steps: 3, hold: true });
    types.gate(job.id, 0).open();
    await types.gate(job.id, 1).entered;
    await stopRunner(first);
    expect(await statusOf(job.id)).toMatchObject({ status: 'queued', checkpoint: { step: 1 }, run_id: null });

    types.gate(job.id, 1).open();
    types.gate(job.id, 2).open();
    await startRunner();
    await waitForStatus(job.id, 'succeeded');
    expect(types.executions.get(job.id)?.runs.map((run) => run.startStep)).toEqual([0, 1]);
    expect(types.executions.get(job.id)?.completed).toBe(1);
  });
});

describe('取消、暂停、继续', () => {
  it('取消排队中的任务：立即 cancelled，之后不会执行', async () => {
    const member = await newMember();
    const job = await enqueue(member, { steps: 1 });
    expect(await cancelJob(service(null), member, job.id)).toMatchObject({ status: 'cancelled' });
    await startRunner();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(types.executions.has(job.id)).toBe(false);
    await expect(cancelJob(service(null), member, job.id)).rejects.toMatchObject({ statusCode: 409, code: 'JOB_FINISHED' });
  });

  it('取消执行中的任务：先 cancelling，执行者在检查点退出后 cancelled，互斥锁随之释放', async () => {
    const member = await newMember();
    await startRunner();
    const lockKey = `knowledge-document:${randomUUID()}`;
    const job = await enqueue(member, { steps: 2, hold: true }, { lockKey });
    await types.gate(job.id, 0).entered;
    expect(await cancelJob(service(null), member, job.id)).toMatchObject({ status: 'cancelling' });
    await waitForStatus(job.id, 'cancelled');
    expect(types.executions.get(job.id)?.completed).toBe(0);
    expect(await eventKinds(job.id)).toEqual(['queued', 'started', 'cancel-requested', 'cancelled']);
    await enqueue(member, { steps: 1 }, { lockKey, deps: service(null) });
  });

  it('暂停执行中的任务后继续：保留 checkpoint，继续后从中断处执行', async () => {
    const member = await newMember();
    await startRunner();
    const job = await enqueue(member, { steps: 3, hold: true });
    types.gate(job.id, 0).open();
    await types.gate(job.id, 1).entered;
    expect(await pauseJob(service(null), member, job.id)).toMatchObject({ status: 'running', pauseRequested: true });
    const paused = await waitForStatus(job.id, 'paused');
    expect(paused).toMatchObject({ checkpoint: { step: 1 }, run_id: null, pause_requested: false });

    // 暂停中的任务不被对账派发。
    expect((await runners[0]!.reconcile()).dispatched).toBe(0);
    types.gate(job.id, 1).open();
    types.gate(job.id, 2).open();
    expect(await resumeJob(service(), member, job.id)).toMatchObject({ status: 'queued' });
    await waitForStatus(job.id, 'succeeded');
    expect(types.executions.get(job.id)?.runs.map((run) => run.startStep)).toEqual([0, 1]);
    expect(await eventKinds(job.id)).toEqual(['queued', 'started', 'pause-requested', 'paused', 'resumed', 'started', 'log', 'succeeded']);
  });

  it('暂停排队中的任务：立即 paused，继续后才执行；其他组织不能操作', async () => {
    const member = await newMember();
    const other = await newMember();
    const job = await enqueue(member, { steps: 1 }, { deps: service(null) });
    expect(await pauseJob(service(null), member, job.id)).toMatchObject({ status: 'paused' });
    await expect(resumeJob(service(null), other, job.id)).rejects.toBeInstanceOf(AppError);
    await expect(cancelJob(service(null), other, job.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await findJob(appDb, other, job.id)).toBeNull();
    await startRunner();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(types.executions.has(job.id)).toBe(false);
    await resumeJob(service(), member, job.id);
    await waitForStatus(job.id, 'succeeded');
  });
});
