// 登录、注册、找回密码限流的共享计数（路线图第 6 步 6.14）：存在 Redis 中，api 的所有实例共用。
// 算法与 src/auth/rateLimit.ts 的进程内存实现相同，每次操作是一个 Lua 脚本（原子执行），时间取 Redis 服务器时钟，
// 不受各实例时钟偏差影响。
//
// - 键：`{prefix}:{限流器名}:{SHA-256(原始键) 的前 32 位十六进制}`。邮箱、IP 不以明文出现在 Redis 中，键长有界；
// - 每个键都带过期时间（固定窗口：窗口结束；失败退避：最近一次失败后 maxDelayMs），到期自动删除，不需要清理任务；
//   Redis 开启了 noeviction 与 maxmemory（redis/start-valkey.sh），内存满时写入失败，由调用方退回进程内存计数；
// - Redis 重启或被清空时计数一起清零，最多让攻击者多得一个窗口的额度；
// - 未连接时命令立即失败（不排队），调用方据此退回进程内存计数，不会让登录请求等待 Redis 重连。
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type { RedisConfig } from '../config.ts';
import { failFastRedisOptions, whenReady } from '../redis.ts';
import type { RateLimitDecision } from './rateLimit.ts';

export interface RateLimitStore {
  consumeWindow(name: string, key: string, options: { limit: number; windowMs: number }): Promise<RateLimitDecision>;
  checkBackoff(name: string, key: string): Promise<RateLimitDecision>;
  recordBackoffFailure(name: string, key: string, options: { freeFailures: number; baseDelayMs: number; maxDelayMs: number }): Promise<void>;
  resetBackoff(name: string, key: string): Promise<void>;
  /** 等到连接就绪，超时抛错。测试用；请求路径上不等待。 */
  ready(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export interface RateLimitStoreOptions {
  /** 键前缀，测试中每个文件用不同的前缀互不干扰。 */
  prefix?: string;
  log?: { warn(obj: unknown, msg?: string): void };
}

export const DEFAULT_RATE_LIMIT_PREFIX = 'ratelimit:auth';

// 固定窗口。KEYS[1] 计数；ARGV[1] 上限、ARGV[2] 窗口（毫秒）。返回 {是否放行, 被拒绝时距窗口结束的毫秒数}。
// 与进程内存实现一致：被拒绝的请求不计数，窗口从第一次请求开始，不因后续请求延长。
const WINDOW_SCRIPT = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('PTTL', KEYS[1])
if count > 0 and ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], window)
  ttl = window
end
if count >= limit then
  return {0, math.max(ttl, 1)}
end
if count == 0 then
  redis.call('SET', KEYS[1], 1, 'PX', window)
else
  redis.call('INCR', KEYS[1])
end
return {1, 0}
`;

// 失败退避的检查。KEYS[1] 哈希（f 失败次数、u 锁定到的时刻）。返回距离解锁的毫秒数，0 表示未锁定。
const BACKOFF_CHECK_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local lockedUntil = tonumber(redis.call('HGET', KEYS[1], 'u') or '0')
if lockedUntil > now then
  return lockedUntil - now
end
return 0
`;

// 记录一次失败。ARGV[1] freeFailures、ARGV[2] baseDelayMs、ARGV[3] maxDelayMs。
// 第 freeFailures + n 次失败后锁定 baseDelayMs × 2^(n-1)（不超过 maxDelayMs）。键在最近一次失败后 maxDelayMs 过期：
// 锁定时长不超过 maxDelayMs，所以到期时一定已经解锁，与进程内存实现“超过 maxDelayMs 没有失败的记录作废”一致。
const BACKOFF_FAILURE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local free = tonumber(ARGV[1])
local base = tonumber(ARGV[2])
local maxDelay = tonumber(ARGV[3])
local failures = redis.call('HINCRBY', KEYS[1], 'f', 1)
local excess = failures - free
if excess > 0 then
  local delay = math.min(base * math.pow(2, math.min(excess - 1, 52)), maxDelay)
  redis.call('HSET', KEYS[1], 'u', string.format('%d', now + math.floor(delay)))
end
redis.call('PEXPIRE', KEYS[1], maxDelay + 1)
return failures
`;

type ScriptedRedis = Redis & {
  rateLimitWindow(key: string, limit: number, windowMs: number): Promise<[number, number]>;
  rateLimitBackoffCheck(key: string): Promise<number>;
  rateLimitBackoffFailure(key: string, freeFailures: number, baseDelayMs: number, maxDelayMs: number): Promise<number>;
};

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} 不合法`);
}

export function rateLimitKey(prefix: string, name: string, key: string): string {
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
  return `${prefix}:${name}:${digest}`;
}

export function createRedisRateLimitStore(config: RedisConfig, options: RateLimitStoreOptions = {}): RateLimitStore {
  const prefix = options.prefix ?? DEFAULT_RATE_LIMIT_PREFIX;
  const client = new Redis(failFastRedisOptions(config, 'bidtools-auth-rate-limit')) as ScriptedRedis;
  // 断线后按退避间隔自动重连；出错时由 createAuthRateLimiters 退回进程内存计数并写日志，这里只记连接层的错误。
  client.on('error', (error: Error) => options.log?.warn({ err: error }, 'auth rate limit redis connection error'));
  client.defineCommand('rateLimitWindow', { numberOfKeys: 1, lua: WINDOW_SCRIPT });
  client.defineCommand('rateLimitBackoffCheck', { numberOfKeys: 1, lua: BACKOFF_CHECK_SCRIPT });
  client.defineCommand('rateLimitBackoffFailure', { numberOfKeys: 1, lua: BACKOFF_FAILURE_SCRIPT });

  return {
    async consumeWindow(name, key, { limit, windowMs }) {
      assertPositiveInteger(limit, 'limit');
      assertPositiveInteger(windowMs, 'windowMs');
      const [allowed, retryAfterMs] = await client.rateLimitWindow(rateLimitKey(prefix, name, key), limit, windowMs);
      return allowed === 1 ? { allowed: true, retryAfterMs: 0 } : { allowed: false, retryAfterMs };
    },
    async checkBackoff(name, key) {
      const retryAfterMs = await client.rateLimitBackoffCheck(rateLimitKey(prefix, name, key));
      return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : { allowed: true, retryAfterMs: 0 };
    },
    async recordBackoffFailure(name, key, { freeFailures, baseDelayMs, maxDelayMs }) {
      if (!Number.isSafeInteger(freeFailures) || freeFailures < 0) throw new TypeError('freeFailures 不合法');
      assertPositiveInteger(baseDelayMs, 'baseDelayMs');
      assertPositiveInteger(maxDelayMs, 'maxDelayMs');
      await client.rateLimitBackoffFailure(rateLimitKey(prefix, name, key), freeFailures, baseDelayMs, maxDelayMs);
    },
    async resetBackoff(name, key) {
      await client.del(rateLimitKey(prefix, name, key));
    },
    ready: (timeoutMs) => whenReady(client, timeoutMs),
    async close() {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}
