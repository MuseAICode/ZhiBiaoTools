// 事件发布（docs/SERVER_DESIGN.md 第 5.5 节）：worker 和 api 在数据库事务提交之后调用，追加到组织的 Stream 并发布到频道
// （见 src/events/stream.ts）。发布是尽力而为：Redis 不可用时只写一条 warn 日志并丢弃，不影响任务本身；
// 前端重连时发现缺了事件会收到 resync，重新拉快照。
//
// 另有任务控制频道（jobs:control）：取消、暂停后通知正在执行该任务的 worker 立即检查 jobs 中的请求，
// 不必等到下一次续租（第 5.6 节）。消息只有任务 id，worker 收到后仍以 jobs 表为准，伪造的消息最多引起一次多余的查询。
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import type { RedisConfig } from '../config.ts';
import { failFastRedisOptions, whenReady } from '../redis.ts';
import {
  EVENT_MAX_BYTES,
  EVENT_STREAM_MAX_LENGTH,
  EVENT_STREAM_WINDOW_MS,
  EVENT_TYPE_PATTERN,
  orgChannel,
  orgStreamKey,
  PUBLISH_SCRIPT,
  type OrgEvent,
} from './stream.ts';

export interface EventPublisher {
  /** 发布到组织的 Stream 和频道，返回 Stream ID；Redis 不可用时返回 null（已写日志）。事件不合法时抛 TypeError。 */
  publish(orgId: string, event: OrgEvent): Promise<string | null>;
  /** 通知 worker 立即检查该任务的取消、暂停请求。失败时只写日志。 */
  notifyJobControl(jobId: string): Promise<void>;
  close(): Promise<void>;
}

export interface EventPublisherOptions {
  log: Pick<FastifyBaseLogger, 'warn'>;
  connectionName: string;
  /** 键和频道的前缀，测试中每个文件用不同的前缀互不干扰。 */
  keyPrefix?: string;
  /** 任务控制频道的前缀，与 BullMQ 的前缀（src/jobs/queue.ts）一致。 */
  queuePrefix?: string;
}

export function jobControlChannel(queuePrefix: string): string {
  return `${queuePrefix}:jobs:control`;
}

export function serializeEvent(event: OrgEvent): string {
  if (!EVENT_TYPE_PATTERN.test(event.type)) throw new TypeError(`事件类型不合法：${event.type}`);
  const json = JSON.stringify({ type: event.type, data: event.data, ...(event.userId !== undefined ? { userId: event.userId } : {}) });
  if (Buffer.byteLength(json) > EVENT_MAX_BYTES) throw new TypeError(`事件过大：${event.type}`);
  return json;
}

export function createEventPublisher(config: RedisConfig, options: EventPublisherOptions): EventPublisher {
  const prefix = options.keyPrefix ?? '';
  const controlChannel = jobControlChannel(options.queuePrefix ?? 'bull');
  const client = new Redis(failFastRedisOptions(config, options.connectionName));
  client.on('error', (error: Error) => options.log.warn({ err: error }, 'event publisher redis error'));
  // 只在首次连上之前等待（进程刚启动）；之后断线期间立即丢弃，不拖慢任务的进度和日志写入。
  let connected = false;
  client.once('ready', () => {
    connected = true;
  });
  const ready = () => (connected ? Promise.resolve() : whenReady(client));

  return {
    async publish(orgId, event) {
      const json = serializeEvent(event);
      try {
        await ready();
        const id = await client.eval(
          PUBLISH_SCRIPT,
          2,
          orgStreamKey(prefix, orgId),
          orgChannel(prefix, orgId),
          json,
          EVENT_STREAM_MAX_LENGTH,
          EVENT_STREAM_WINDOW_MS,
        );
        return typeof id === 'string' ? id : null;
      } catch (error) {
        options.log.warn({ err: error, eventType: event.type }, 'event publish failed, dropped');
        return null;
      }
    },
    async notifyJobControl(jobId) {
      try {
        await ready();
        await client.publish(controlChannel, jobId);
      } catch (error) {
        options.log.warn({ err: error, jobId }, 'job control notify failed');
      }
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
