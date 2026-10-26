// api 进程中的事件订阅（docs/SERVER_DESIGN.md 第 5.5 节）：一条订阅连接，按组织引用计数 SUBSCRIBE events:org:{orgId}，
// 收到的事件按连接的组织和用户过滤后交给各 SSE 连接（src/routes/events.ts）。
//
// 新连接的顺序保证不漏、不重：先订阅频道（等到 Redis 确认），期间和补发过程中到达的实时事件先缓存；再按 Last-Event-ID 从
// Stream 补发（或判定为 resync）；最后按 ID 去重放出缓存，切换为实时。订阅连接断开时，之后的实时事件无法保证送达，
// 所有连接收到 lost()，由调用方关闭 SSE 让前端重连，重连时带 Last-Event-ID 补发。
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import type { RedisConfig } from '../config.ts';
import { failFastRedisOptions, whenReady } from '../redis.ts';
import {
  compareStreamIds,
  EVENT_STREAM_MAX_LENGTH,
  orgChannel,
  orgStreamKey,
  parseStreamEvent,
  REPLAY_SCRIPT,
  STREAM_ID_PATTERN,
  type StreamEvent,
} from './stream.ts';

export interface EventSink {
  event(event: StreamEvent): void;
  /** 无法补发（超出保留窗口、Redis 重启或被清空、Last-Event-ID 不认识）：前端应重新拉取快照。 */
  resync(): void;
  /** 订阅连接断开，之后的事件无法保证送达：调用方应关闭 SSE，让前端重连补发。 */
  lost(): void;
}

export interface EventHub {
  /**
   * 订阅组织的事件，按 lastEventId 补发后切换为实时；返回取消订阅的函数。
   * Redis 不可用时抛 EventsUnavailableError。
   */
  attach(orgId: string, userId: string, lastEventId: string | null, sink: EventSink): Promise<() => void>;
  close(): Promise<void>;
}

export interface EventHubOptions {
  log: Pick<FastifyBaseLogger, 'warn'>;
  connectionName?: string;
  /** 与 src/events/publisher.ts 的 keyPrefix 一致。 */
  keyPrefix?: string;
}

export class EventsUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('event stream unavailable', options);
    this.name = 'EventsUnavailableError';
  }
}

/** 补发期间缓存的实时事件上限；超出时放弃缓存，改为 resync。 */
const BUFFER_MAX = EVENT_STREAM_MAX_LENGTH;

interface Listener {
  readonly userId: string;
  readonly sink: EventSink;
  live: boolean;
  buffer: StreamEvent[];
  overflow: boolean;
  lastId: string | null;
}

interface Channel {
  readonly listeners: Set<Listener>;
  readonly subscribed: Promise<void>;
}

type ReplayResult = ['resync'] | ['ok', [string, string[]][]];

function emit(listener: Listener, event: StreamEvent): void {
  if (event.userId !== undefined && event.userId !== listener.userId) return;
  if (listener.lastId !== null && compareStreamIds(event.id, listener.lastId) <= 0) return;
  listener.lastId = event.id;
  listener.sink.event(event);
}

function entryEvent(entry: [string, string[]]): StreamEvent | null {
  const [id, fields] = entry;
  const index = fields.indexOf('e');
  return index >= 0 && index + 1 < fields.length ? parseStreamEvent(id, fields[index + 1]!) : null;
}

export function createEventHub(config: RedisConfig, options: EventHubOptions): EventHub {
  const prefix = options.keyPrefix ?? '';
  const name = options.connectionName ?? 'bidtools-api-events';
  // 断线重连后不自动恢复订阅：断线期间的事件已经错过，由各连接重连补发，见 lost()。
  const subscriber = new Redis({ ...failFastRedisOptions(config, `${name}-subscriber`), autoResubscribe: false });
  const commands = new Redis(failFastRedisOptions(config, `${name}-replay`));
  subscriber.on('error', (error: Error) => options.log.warn({ err: error }, 'event subscriber redis error'));
  commands.on('error', (error: Error) => options.log.warn({ err: error }, 'event replay redis error'));

  const channels = new Map<string, Channel>();
  let closed = false;

  subscriber.on('message', (channelName: string, message: string) => {
    const channel = channels.get(channelName);
    if (!channel) return;
    const space = message.indexOf(' ');
    const event = space > 0 ? parseStreamEvent(message.slice(0, space), message.slice(space + 1)) : null;
    if (!event) {
      options.log.warn('malformed event message ignored');
      return;
    }
    for (const listener of channel.listeners) {
      if (listener.live) emit(listener, event);
      else if (listener.buffer.length < BUFFER_MAX) listener.buffer.push(event);
      else listener.overflow = true;
    }
  });

  subscriber.on('close', () => {
    const lost = [...channels.values()].flatMap((channel) => [...channel.listeners]);
    channels.clear();
    for (const listener of lost) listener.sink.lost();
  });

  /** 最后一个连接离开后退订。检查与退订在同一个同步块中，之后的新连接会重新订阅（命令在同一连接上按序执行）。 */
  function release(channelName: string, channel: Channel): void {
    channel.subscribed.then(
      () => {
        if (channel.listeners.size > 0 || channels.get(channelName) !== channel) return;
        channels.delete(channelName);
        subscriber.unsubscribe(channelName).catch(() => {});
      },
      () => {},
    );
  }

  async function replay(orgId: string, lastEventId: string): Promise<ReplayResult> {
    if (!STREAM_ID_PATTERN.test(lastEventId)) return ['resync'];
    return (await commands.eval(REPLAY_SCRIPT, 1, orgStreamKey(prefix, orgId), lastEventId, EVENT_STREAM_MAX_LENGTH)) as ReplayResult;
  }

  return {
    async attach(orgId, userId, lastEventId, sink) {
      if (closed) throw new EventsUnavailableError();
      // 连接刚创建或正在重连时稍等，超时即视为不可用。
      try {
        await Promise.all([whenReady(subscriber), whenReady(commands)]);
      } catch (error) {
        throw new EventsUnavailableError({ cause: error });
      }
      const channelName = orgChannel(prefix, orgId);
      let channel = channels.get(channelName);
      if (!channel) {
        const created: Channel = { listeners: new Set(), subscribed: subscriber.subscribe(channelName).then(() => {}) };
        created.subscribed.catch(() => {
          if (channels.get(channelName) === created) channels.delete(channelName);
        });
        channels.set(channelName, created);
        channel = created;
      }
      const current = channel;
      const listener: Listener = { userId, sink, live: false, buffer: [], overflow: false, lastId: null };
      current.listeners.add(listener);
      const detach = () => {
        if (current.listeners.delete(listener) && current.listeners.size === 0) release(channelName, current);
      };

      let result: ReplayResult | null = null;
      try {
        await current.subscribed;
        if (lastEventId !== null) result = await replay(orgId, lastEventId);
      } catch (error) {
        detach();
        throw new EventsUnavailableError({ cause: error });
      }

      if (result?.[0] === 'resync') sink.resync();
      else if (result?.[0] === 'ok') {
        for (const entry of result[1]) {
          const event = entryEvent(entry);
          if (event) emit(listener, event);
        }
      }
      const buffered = listener.buffer;
      listener.buffer = [];
      listener.live = true;
      for (const event of buffered) emit(listener, event);
      if (listener.overflow) sink.resync();
      return detach;
    },
    async close() {
      closed = true;
      await Promise.all(
        [subscriber, commands].map(async (client) => {
          try {
            await client.quit();
          } catch {
            client.disconnect();
          }
        }),
      );
    },
  };
}
