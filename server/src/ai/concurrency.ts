// AI 网关按“组织 + 服务商”的并发上限（docs/SERVER_DESIGN.md 第 5.3 节；路线图第 6 步 6.4）：Redis 分布式信号量，
// api 与 worker 的所有实例共用。上限取组织设置 org_settings.concurrency_limit 与平台上限（AI_CONCURRENCY_MAX）的较小值。
//
// 每个 (组织, 服务商) 一个有序集合，成员是一次调用的随机令牌，分值是该名额的到期时间（毫秒，取 Redis 服务器时钟）：
// - 获取（Lua 脚本，原子执行）：先删掉已到期的成员，成员数小于上限时加入本次的令牌并返回成功；
// - 释放：删掉本次的令牌；
// - 名额有到期时间（不短于一次调用的最长时长），进程在调用中途崩溃、没有释放时到期后自动收回，不依赖任何后台任务；
//   Redis 重启或被清空时所有名额一起消失，最多短时间内超出上限，不影响计费（计费的权威在数据库）。
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { RedisConfig } from '../config.ts';
import type { BillingProvider } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { failFastRedisOptions, whenReady } from '../redis.ts';

export interface AcquireOptions {
  orgId: string;
  provider: BillingProvider;
  limit: number;
  /** 等待名额的最长时间；Infinity 表示一直等到 signal 中止（任务中的调用）。 */
  waitMs: number;
  signal?: AbortSignal | undefined;
}

export interface AiConcurrencyLimiter {
  /** 获取一个名额，返回释放函数（重复调用无害）。等待超时抛 429，等待期间被取消抛 400 AI_REQUEST_ABORTED。 */
  acquire(options: AcquireOptions): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface LimiterOptions {
  /** 一个名额的最长占用时间：必须不短于一次调用的最长时长（网关用冻结时长）。 */
  leaseMs: number;
  /** 键前缀，测试中每个文件用不同的前缀互不干扰。 */
  prefix?: string;
  /** 两次尝试之间的最长间隔。 */
  maxPollMs?: number;
  log?: { warn(obj: unknown, msg?: string): void };
}

export const DEFAULT_CONCURRENCY_PREFIX = 'ai:concurrency';
const MIN_POLL_MS = 25;
const DEFAULT_MAX_POLL_MS = 500;

// KEYS[1] 集合；ARGV[1] 上限、ARGV[2] 名额时长（毫秒）、ARGV[3] 令牌。返回 1 表示获取成功。
const ACQUIRE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= limit then
  return 0
end
redis.call('ZADD', KEYS[1], now + lease, ARGV[3])
redis.call('PEXPIRE', KEYS[1], lease)
return 1
`;

type ScriptedRedis = Redis & { aiAcquire(key: string, limit: number, leaseMs: number, token: string): Promise<number> };

function limited(): AppError {
  return new AppError(429, 'AI_CONCURRENCY_LIMITED', '同时进行的模型调用过多，请稍后再试');
}

function unavailable(cause: unknown): AppError {
  return new AppError(503, 'AI_CONCURRENCY_UNAVAILABLE', '模型服务暂不可用，请稍后再试', { cause });
}

function aborted(): AppError {
  return new AppError(400, 'AI_REQUEST_ABORTED', '调用已取消');
}

/** 等待 ms 毫秒或 signal 中止，先到者为准。 */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function concurrencyKey(prefix: string, orgId: string, provider: BillingProvider): string {
  return `${prefix}:${orgId}:${provider}`;
}

export function createAiConcurrencyLimiter(config: RedisConfig, options: LimiterOptions): AiConcurrencyLimiter {
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) throw new TypeError('leaseMs 不合法');
  const prefix = options.prefix ?? DEFAULT_CONCURRENCY_PREFIX;
  const maxPollMs = options.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  // 未连接时命令立即失败（不排队），Redis 不可用期间不会堆积请求。
  const client = new Redis(failFastRedisOptions(config, 'bidtools-ai-concurrency')) as ScriptedRedis;
  client.on('error', (error: Error) => options.log?.warn({ err: error }, 'ai concurrency redis connection error'));
  client.defineCommand('aiAcquire', { numberOfKeys: 1, lua: ACQUIRE_SCRIPT });

  // 刚启动或正在重连时，同时到来的调用共用一次等待（最多 2 秒）：不排队的连接上直接发命令会立即失败。
  let connecting: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (client.status === 'ready') return Promise.resolve();
    connecting ??= whenReady(client).finally(() => {
      connecting = null;
    });
    return connecting;
  }

  return {
    async acquire({ orgId, provider, limit, waitMs, signal }) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('并发上限不合法');
      const key = concurrencyKey(prefix, orgId, provider);
      const token = randomUUID();
      const deadline = Date.now() + waitMs;
      let delay = MIN_POLL_MS;
      let lastError: unknown = null;
      for (;;) {
        if (signal?.aborted) throw aborted();
        try {
          await ready();
          if ((await client.aiAcquire(key, limit, options.leaseMs, token)) === 1) break;
          lastError = null;
        } catch (error) {
          // Redis 暂时不可用：继续等（任务中的调用），超过等待时间后报 503；不放行，否则并发上限失效。
          if (lastError === null) options.log?.warn({ err: error }, 'ai concurrency acquire failed');
          lastError = error;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw lastError === null ? limited() : unavailable(lastError);
        await pause(Math.min(delay, remaining), signal);
        delay = Math.min(delay * 2, maxPollMs);
      }

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await client.zrem(key, token);
        } catch (error) {
          // 释放失败（Redis 暂时不可用）：名额到期后自动收回。
          options.log?.warn({ err: error }, 'ai concurrency release failed');
        }
      };
    },
    async close() {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}
