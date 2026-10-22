// Redis（Valkey）连接。连接参数来自 src/config.ts，密码不写日志。
// 6.1 只用于 /readyz 的连通性检查；任务队列（BullMQ）、事件推送等在第 6 步后续 PR 中接入，各自建立需要的连接。
import { Redis } from 'ioredis';
import type { RedisConfig } from './config.ts';

export interface RedisHandle {
  /** 执行 PING，未连接、超时或认证失败时抛错。用于 /readyz。 */
  ping(): Promise<void>;
  destroy(): Promise<void>;
}

export interface CreateRedisOptions {
  connectionName?: string;
  /** 连接出错（拒绝连接、认证失败、断线）时回调，用于写日志；断线后会按退避间隔自动重连。 */
  onError?: (error: Error) => void;
}

const COMMAND_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 5_000;

export function createRedis(config: RedisConfig, options: CreateRedisOptions = {}): RedisHandle {
  const client = new Redis({
    host: config.host,
    port: config.port,
    ...(config.username ? { username: config.username } : {}),
    password: config.password,
    ...(config.tls ? { tls: { servername: config.host } } : {}),
    connectionName: options.connectionName ?? 'bidtools-api',
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    // 未连接时命令立即失败而不是排队等待重连：/readyz 应当如实报告未就绪，也不会在 Redis 长时间不可用时堆积命令。
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
  });
  // 不监听 error 事件时 ioredis 会把每次连接失败打印到 stderr；交给调用方写结构化日志。
  client.on('error', (error: Error) => options.onError?.(error));

  return {
    async ping() {
      await client.ping();
    },
    async destroy() {
      try {
        await client.quit();
      } catch {
        // 未连接时 quit 直接失败，断开即可。
        client.disconnect();
      }
    },
  };
}
