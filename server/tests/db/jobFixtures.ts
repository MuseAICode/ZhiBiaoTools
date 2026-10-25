// 任务队列测试（tests/db/jobs.test.ts、tests/db/jobQueue.test.ts）共用：测试用的任务类型、Redis 连接、等待工具。
// 测试用的任务类型只在测试中登记，不进入 src/jobs/registry.ts。
import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { loadConfig, type RedisConfig } from '../../src/config.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { createJobTypeRegistry, JobError, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';

export function redisConfig(): RedisConfig {
  const url = process.env.TEST_REDIS_URL;
  const password = process.env.TEST_REDIS_PASSWORD;
  if (!url || !password) {
    throw new Error('任务队列测试需要 TEST_REDIS_URL 和 TEST_REDIS_PASSWORD，例如 TEST_REDIS_URL=redis://bidtools@127.0.0.1:6379');
  }
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PASSWORD: 'unused', REDIS_URL: url, REDIS_PASSWORD: password }).redis;
  if (!config) throw new Error('TEST_REDIS_URL 未生效');
  return config;
}

export function uniquePrefix(): string {
  return `jobs-test-${randomBytes(6).toString('hex')}`;
}

/** 以应用用户（与 worker 相同的 ACL）直接连 Redis，用于模拟清空、检查队列中的键。 */
export function rawRedis(config: RedisConfig = redisConfig()): Redis {
  return new Redis({
    host: config.host,
    port: config.port,
    ...(config.username ? { username: config.username } : {}),
    password: config.password,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
}

/**
 * 删除某个 BullMQ 前缀下的全部键：应用用户没有 FLUSHALL / FLUSHDB 权限（6.1 的 ACL），按前缀删除对本测试等同于清空。
 * 返回删除的键数。
 */
export async function wipeQueueKeys(redis: Redis, prefix: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await redis.del(...keys);
  } while (cursor !== '0');
  return deleted;
}

export async function countQueueKeys(redis: Redis, prefix: string): Promise<number> {
  let cursor = '0';
  let count = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
    cursor = next;
    count += keys.length;
  } while (cursor !== '0');
  return count;
}

export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface LogEntry {
  level: string;
  obj: unknown;
  msg: string | undefined;
}

/** 收集日志的 FastifyBaseLogger 桩。 */
export function testLogger(): { log: FastifyBaseLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const make = (level: string) => (obj: unknown, msg?: string) => {
    entries.push({ level, obj, msg: typeof obj === 'string' ? obj : msg });
  };
  const log: Record<string, unknown> = {
    level: 'info',
    fatal: make('fatal'),
    error: make('error'),
    warn: make('warn'),
    info: make('info'),
    debug: make('debug'),
    trace: make('trace'),
    silent: () => {},
  };
  log.child = () => log;
  return { log: log as unknown as FastifyBaseLogger, entries };
}

/** 一个可由测试放行的闸门。 */
export interface Gate {
  readonly entered: Promise<void>;
  open(): void;
}

export interface EchoParams {
  /** 分几步执行，每步结束保存一次 checkpoint。 */
  steps: number;
  /** 每一步开始前等待测试放行（gates 中以 `${jobId}:${step}` 登记）。 */
  hold?: boolean;
  /** 在第几步失败：'job-error' 抛 JobError，'crash' 抛普通错误（内部消息不应进入任务记录）。 */
  failAt?: number;
  failWith?: 'job-error' | 'crash';
}

/** 每个任务的执行记录：run() 被调用几次、每次从第几步开始、发起用户的上下文。 */
export interface ExecutionLog {
  runs: { attempt: number; startStep: number; userId: string | null; orgId: string | null }[];
  completed: number;
}

export function createTestJobTypes() {
  const executions = new Map<string, ExecutionLog>();
  const gates = new Map<string, { resolve: () => void; entered: () => void; promise: Promise<void>; enteredPromise: Promise<void> }>();

  function gateEntry(key: string) {
    let entry = gates.get(key);
    if (!entry) {
      let resolve!: () => void;
      let entered!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      const enteredPromise = new Promise<void>((r) => (entered = r));
      entry = { resolve, entered, promise, enteredPromise };
      gates.set(key, entry);
    }
    return entry;
  }

  function gate(jobId: string, step: number): Gate {
    const entry = gateEntry(`${jobId}:${step}`);
    return { entered: entry.enteredPromise, open: entry.resolve };
  }

  function logFor(jobId: string): ExecutionLog {
    let log = executions.get(jobId);
    if (!log) {
      log = { runs: [], completed: 0 };
      executions.set(jobId, log);
    }
    return log;
  }

  function parseParams(raw: unknown): EchoParams {
    const value = raw as Partial<EchoParams> | null;
    if (!value || typeof value !== 'object' || !Number.isInteger(value.steps) || value.steps! < 1 || value.steps! > 20) {
      throw new TypeError('steps 不合法');
    }
    return value as EchoParams;
  }

  async function run(context: JobContext<EchoParams>): Promise<void> {
    const log = logFor(context.jobId);
    const setting = await withTenant(context.db, context.tenant, async (trx) => {
      const { rows } = await sql<{ user_id: string; org_id: string }>`
        SELECT current_setting('app.user_id', true) AS user_id, current_setting('app.org_id', true) AS org_id`.execute(trx);
      return rows[0]!;
    });
    const startStep = typeof context.checkpoint?.step === 'number' ? context.checkpoint.step : 0;
    log.runs.push({ attempt: context.attempt, startStep, userId: setting.user_id, orgId: setting.org_id });
    for (let step = startStep; step < context.params.steps; step += 1) {
      if (context.params.hold) {
        const entry = gateEntry(`${context.jobId}:${step}`);
        entry.entered();
        await Promise.race([
          entry.promise,
          new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true })),
        ]);
      }
      context.signal.throwIfAborted();
      if (context.params.failAt === step) {
        if (context.params.failWith === 'crash') throw new Error('internal detail: connection string postgres://secret');
        throw new JobError('TEST_FAILED', '测试任务按要求失败');
      }
      await context.saveCheckpoint({ step: step + 1 }, Math.floor(((step + 1) * 100) / (context.params.steps + 1)));
    }
    await context.log('测试任务完成', { steps: context.params.steps });
    log.completed += 1;
  }

  const echo: JobTypeDefinition<EchoParams> = { type: 'test-echo', queue: 'ai', resumable: true, parseParams, run };
  const oneshot: JobTypeDefinition<EchoParams> = { type: 'test-oneshot', queue: 'parse', resumable: false, parseParams, run };
  return { registry: createJobTypeRegistry([echo, oneshot]), executions, gate, logFor };
}
