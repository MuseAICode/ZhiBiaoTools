// Redis（Valkey）连接。连接参数来自 src/config.ts，密码不写日志。
// createRedis 用于 /readyz 的连通性检查；任务队列（BullMQ，src/jobs/）用 bullmqConnection 的参数自建连接；
// 事件推送（src/events/）用 failFastRedisOptions 的参数自建发布、订阅连接。
import type { RedisOptions as BullmqRedisOptions } from 'bullmq';
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

/**
 * 未连接时命令立即失败而不是排队等待重连的连接参数：/readyz 应当如实报告未就绪，事件发布失败即丢弃（事件可丢，
 * 第 8.4 节），也不会在 Redis 长时间不可用时堆积命令。断线后按退避间隔自动重连。
 */
export function failFastRedisOptions(config: RedisConfig, connectionName: string) {
  return {
    host: config.host,
    port: config.port,
    ...(config.username ? { username: config.username } : {}),
    password: config.password,
    ...(config.tls ? { tls: { servername: config.host } } : {}),
    connectionName,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
  };
}

/**
 * 等到连接就绪：failFastRedisOptions 的连接不排队命令，刚创建或正在重连时直接发命令会立即失败。
 * 超过 timeoutMs 仍未就绪时抛错。
 */
export async function whenReady(client: Redis, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<void> {
  if (client.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error('redis connection not ready'));
    }, timeoutMs);
    client.once('ready', onReady);
  });
}

export function createRedis(config: RedisConfig, options: CreateRedisOptions = {}): RedisHandle {
  const client = new Redis(failFastRedisOptions(config, options.connectionName ?? 'bidtools-api'));
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

/**
 * BullMQ 的连接参数（BullMQ 按参数自建并复制连接）。producer（入队、对账）：未连接时命令立即失败，入队失败不影响任务
 * （任务已写入 jobs，由对账重新放入）；worker（消费者）：BullMQ 要求 maxRetriesPerRequest 为 null，断线后自动重连。
 */
export function bullmqConnection(config: RedisConfig, role: 'producer' | 'worker', connectionName: string): BullmqRedisOptions {
  return {
    host: config.host,
    port: config.port,
    ...(config.username ? { username: config.username } : {}),
    password: config.password,
    ...(config.tls ? { tls: { servername: config.host } } : {}),
    connectionName,
    connectTimeout: CONNECT_TIMEOUT_MS,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
    ...(role === 'producer'
      ? { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: COMMAND_TIMEOUT_MS }
      : { maxRetriesPerRequest: null }),
  };
}
