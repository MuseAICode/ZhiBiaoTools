// 事件推送接口（docs/SERVER_DESIGN.md 第 5.4、5.5 节；路线图第 6 步 6.3）：GET /api/events，SSE。
// 需要登录，组织和用户取自会话；一个页面只开一条连接，所有事件类型复用（见 src/jobs/notify.ts）。
//
// - 每条事件的 id: 是 Redis Stream ID。浏览器断线重连时自动带 Last-Event-ID，从 Stream 补发；无法补发（超出 10 分钟 /
//   1000 条的保留窗口、Redis 重启或被清空、不认识的 ID）时推一条 resync，前端重新拉取快照；
// - 订阅就绪、补发完成后推一条 ready（不带 id）。前端应先等到 ready 再拉快照，之后的变化都会经这条连接到达；
// - 每 25 秒一条注释行做心跳；
// - 定期重新校验会话（与登录态检查相同，经 auth_session_lookup）：会话过期、被吊销、用户被停用或移出组织后，
//   推一条 closed（reason: session）并断开，重连时得到 401；
// - 订阅连接断开（Redis 故障）、服务关闭、客户端读得太慢积压过多时，推一条 closed 并断开，由前端重连补发；
// - 每个用户在本进程中最多 maxConnectionsPerUser 条连接，超出返回 429；Redis 未配置或不可用时返回 503。
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { readSessionCookie } from '../auth/cookie.ts';
import { requireSession } from '../auth/hooks.ts';
import { findSession } from '../auth/store.ts';
import { hashToken, isWellFormedToken } from '../auth/tokens.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { EventsUnavailableError, type EventHub } from '../events/hub.ts';
import type { StreamEvent } from '../events/stream.ts';

export interface EventRouteDependencies {
  db: Kysely<Database>;
  /** 未配置 Redis 时为 null，接口返回 503。 */
  hub: EventHub | null;
  /** 测试用：替换心跳、会话重新校验的间隔和连接数上限。 */
  heartbeatMs?: number;
  sessionCheckMs?: number;
  maxConnectionsPerUser?: number;
}

export const EVENT_HEARTBEAT_MS = 25_000;
export const EVENT_SESSION_CHECK_MS = 60_000;
export const EVENT_MAX_CONNECTIONS_PER_USER = 10;
/** 前端断线后多久重连（SSE 的 retry: 字段）。 */
const RETRY_MS = 3_000;
/** 写不出去的数据积压超过这么多时断开，由前端重连补发。 */
const MAX_PENDING_BYTES = 1024 * 1024;

type CloseReason = 'session' | 'unavailable' | 'shutdown' | 'overflow';

export async function registerEventRoutes(app: FastifyInstance, deps: EventRouteDependencies): Promise<void> {
  const heartbeatMs = deps.heartbeatMs ?? EVENT_HEARTBEAT_MS;
  const sessionCheckMs = deps.sessionCheckMs ?? EVENT_SESSION_CHECK_MS;
  const maxConnections = deps.maxConnectionsPerUser ?? EVENT_MAX_CONNECTIONS_PER_USER;
  const perUser = new Map<string, number>();
  const open = new Set<(reason: CloseReason) => void>();

  // 服务关闭时先断开所有推送连接，否则 server.close() 会一直等这些长连接结束。
  app.addHook('preClose', async () => {
    for (const close of [...open]) close('shutdown');
  });

  app.get('/', async (request, reply: FastifyReply) => {
    const hub = deps.hub;
    if (!hub) throw new AppError(503, 'EVENTS_UNAVAILABLE', '实时推送暂不可用');
    const session = requireSession(request);
    const { orgId, userId } = session.context;
    const token = readSessionCookie(request.headers.cookie);
    if (token === null || !isWellFormedToken(token)) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
    const tokenHash = hashToken(token);

    const count = perUser.get(userId) ?? 0;
    if (count >= maxConnections) throw new AppError(429, 'EVENTS_TOO_MANY_CONNECTIONS', '打开的页面过多，请关闭部分页面后重试');
    perUser.set(userId, count + 1);
    let counted = true;
    const uncount = () => {
      if (!counted) return;
      counted = false;
      const remaining = (perUser.get(userId) ?? 1) - 1;
      if (remaining > 0) perUser.set(userId, remaining);
      else perUser.delete(userId);
    };

    const header = request.headers['last-event-id'];
    const lastEventId = typeof header === 'string' && header !== '' ? header : null;

    let started = false;
    let closed = false;
    let detach: (() => void) | null = null;
    let heartbeat: NodeJS.Timeout | undefined;
    let sessionCheck: NodeJS.Timeout | undefined;
    const raw = reply.raw;

    const write = (chunk: string) => {
      if (closed || !started) return;
      raw.write(chunk);
      if (raw.writableLength > MAX_PENDING_BYTES) close('overflow');
    };
    const send = (type: string, data: unknown, id?: string) => {
      write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const close = (reason: CloseReason) => {
      if (closed) return;
      if (started) send('closed', { reason });
      closed = true;
      open.delete(close);
      clearInterval(heartbeat);
      clearInterval(sessionCheck);
      detach?.();
      uncount();
      if (started) raw.end();
    };
    open.add(close);
    raw.on('close', () => close('shutdown'));

    // 订阅期间到达的事件和 resync 先排队，响应头写出之后再发送。
    const pending: (() => void)[] = [];
    const sink = {
      event: (event: StreamEvent) => {
        const deliver = () => send(event.type, event.data, event.id);
        if (started) deliver();
        else pending.push(deliver);
      },
      resync: () => {
        const deliver = () => send('resync', {});
        if (started) deliver();
        else pending.push(deliver);
      },
      lost: () => close('unavailable'),
    };

    try {
      detach = await hub.attach(orgId, userId, lastEventId, sink);
    } catch (error) {
      close('unavailable');
      if (error instanceof EventsUnavailableError) {
        request.log.warn({ err: error.cause ?? error }, 'event stream unavailable');
        throw new AppError(503, 'EVENTS_UNAVAILABLE', '实时推送暂不可用');
      }
      throw error;
    }
    // 订阅过程中客户端已断开或订阅连接已断开。
    if (closed) {
      detach();
      return reply;
    }

    reply.hijack();
    // hijack 之后 Fastify 不再发送 reply 上的头（helmet 的安全头等），这里一并写出。
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) raw.setHeader(name, value);
    }
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
      'x-request-id': request.id,
      // 推送结束后关闭底层连接：否则服务关闭时已结束的推送连接仍按 keep-alive 保持，server.close() 要等它超时。
      connection: 'close',
    });
    started = true;
    write(`retry: ${RETRY_MS}\n\n`);
    for (const deliver of pending.splice(0)) deliver();
    send('ready', {});

    heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
    heartbeat.unref();
    sessionCheck = setInterval(() => {
      findSession(deps.db, tokenHash).then(
        (current) => {
          if (!current || current.sessionId !== session.sessionId || current.context.orgId !== orgId || current.context.userId !== userId) {
            close('session');
          }
        },
        (error: unknown) => request.log.warn({ err: error }, 'event stream session check failed'),
      );
    }, sessionCheckMs);
    sessionCheck.unref();
    return reply;
  });
}
