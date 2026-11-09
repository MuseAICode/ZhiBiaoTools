// agent-gw：agent 沙箱访问平台的唯一入口（路线图第 8 步决定事项第 1 项 B，8.2b；docs/SERVER_DESIGN.md 第 7.12 节）。
//
// 只在 agent 沙箱的专用网络（由 sandbox-runner 随沙箱接入）与 worker 之间的内部网络 agent-relay 上，**不持有任何凭据**：
// 没有数据库连接、主密钥、对象存储凭据、模型 Key、sandbox-runner 令牌（入口启动时发现这些配置即拒绝启动，见 src/agent-gw.ts）。
// 被攻破时只能看到经过它的令牌与请求；令牌短期有效、绑定一次执行，worker 对每个请求都按令牌重新查身份。
//
// 每个请求按顺序检查，任一项不符即拒绝、不转给 worker：
//   1. 头部：请求行加全部头部 ≤ maxHeaderBytes（超出 431），收齐头部的时限 headersTimeoutMs（慢速头部断开连接）；
//   2. 路由：只有 AGENT_GATEWAY_ROUTES 中登记的方法与路径（其余 404），查询串一律丢弃；
//   3. 令牌：Authorization: Bearer agt_...，只做格式检查（isWellFormedAgentToken），不对的 401，**此时还没有读取请求体**；
//   4. 并发：同一令牌同时进行的请求 ≤ maxInFlightPerToken（超出 429），整个进程的连接数 ≤ maxConnections；
//   5. 请求体：不带请求体的路由不接受请求体（400）；带请求体的只收 application/json（415），≤ 路由的 bodyLimit（超出 413，
//      声明的长度超限时不读取），收齐整个请求的时限 requestTimeoutMs（慢速请求体断开连接）。agent-gw 不解析 JSON，原样转发；
//   6. 转发：经内部网络转给 worker 的内部入口（src/agent/endpoint.ts），只带 Authorization、Content-Type、Content-Length 与
//      请求 id，沙箱发来的其他头部（Cookie、X-Forwarded-For、自称的组织 / 任务等）一律不转；响应只回传状态码、Content-Type、
//      Content-Length、Cache-Control，响应体流式回传、不缓冲（8.2c 的流式模型输出）。连接 worker 超过 upstreamConnectTimeoutMs 返回 502，
//      整个转发超过 responseTimeoutMs 中止（尚未响应时 504）；沙箱断开时立即中止转给 worker 的请求。
//
// 日志只记方法、路径、状态码、耗时与令牌哈希的前 12 个十六进制字符（agentTokenLogId），不记令牌原文与请求体。
import { Agent, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { LogLevel } from '../config.ts';
import { AppError, registerErrorHandlers } from '../errors.ts';
import { createLoggerOptions } from '../logger.ts';
import { agentTokenLogId, hashAgentToken, parseAgentBearer } from './token.ts';

export interface AgentGatewayRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** POST 路由的请求体上限（字节）；GET 路由不接受请求体。 */
  readonly bodyLimit?: number;
}

/**
 * 转给 worker 的路由，worker 的内部入口有同样的路径。8.2b 只有查询令牌状态的 /v1/session；
 * 模型调用（8.2c，POST /v1/chat/completions）与业务工具 RPC（8.4）在这里登记后才能经过 agent-gw。
 */
export const AGENT_GATEWAY_ROUTES: readonly AgentGatewayRoute[] = Object.freeze([Object.freeze({ method: 'GET', path: '/v1/session' } as const)]);

export interface AgentGatewayLimits {
  /** 请求行加全部头部的字节数上限（Node 的 maxHeaderSize）。 */
  readonly maxHeaderBytes: number;
  /** 收齐头部的时限。 */
  readonly headersTimeoutMs: number;
  /** 收齐整个请求（含请求体）的时限。 */
  readonly requestTimeoutMs: number;
  /** POST 路由未单独给出时的请求体上限。 */
  readonly maxBodyBytes: number;
  /** 同一令牌同时进行的请求数。 */
  readonly maxInFlightPerToken: number;
  /** 整个进程同时保持的连接数，超出的新连接直接关闭。 */
  readonly maxConnections: number;
  /** 连接 worker 的时限。 */
  readonly upstreamConnectTimeoutMs: number;
  /** 一次转发（含流式响应）的总时长上限。 */
  readonly responseTimeoutMs: number;
}

export const DEFAULT_AGENT_GATEWAY_LIMITS: AgentGatewayLimits = Object.freeze({
  maxHeaderBytes: 8 * 1024,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 60_000,
  // 模型调用的请求带整段对话，8.2c 按实测再定各路由自己的上限；这里是 agent-gw 的兜底。
  maxBodyBytes: 8 * 1024 * 1024,
  maxInFlightPerToken: 4,
  maxConnections: 256,
  upstreamConnectTimeoutMs: 5_000,
  responseTimeoutMs: 600_000,
});

export interface AgentGatewayOptions {
  /** worker 内部入口的源（如 http://worker:3200），只在内部网络 agent-relay 上。 */
  upstream: string;
  logLevel: LogLevel;
  logStream?: NodeJS.WritableStream;
  limits?: Partial<AgentGatewayLimits>;
  /** 测试用：替换登记的路由。 */
  routes?: readonly AgentGatewayRoute[];
}

interface TokenState {
  token: string;
  logId: string;
}

/** 只转这几个响应头；其余（Set-Cookie、Connection 等）不回传给沙箱。 */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'cache-control'] as const;

export async function buildAgentGateway(options: AgentGatewayOptions): Promise<FastifyInstance> {
  const limits: AgentGatewayLimits = Object.freeze({ ...DEFAULT_AGENT_GATEWAY_LIMITS, ...options.limits });
  const routes = options.routes ?? AGENT_GATEWAY_ROUTES;
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== 'http:' || upstream.pathname !== '/' || upstream.search || upstream.username) {
    throw new TypeError('agent-gw 的上游必须是不带路径的 http 源');
  }
  const app = Fastify({
    logger: createLoggerOptions({ level: options.logLevel, ...(options.logStream ? { stream: options.logStream } : {}) }),
    // 默认的请求日志带 Fastify 的请求对象，改为在 onResponse 中只记必要的字段（含令牌哈希前缀）。
    logController: new LogController({ disableRequestLogging: true }),
    exposeHeadRoutes: false,
    bodyLimit: limits.maxBodyBytes,
    requestTimeout: limits.requestTimeoutMs,
    http: {
      maxHeaderSize: limits.maxHeaderBytes,
      headersTimeout: limits.headersTimeoutMs,
      // Node 按这个间隔检查 headersTimeout / requestTimeout，默认 30 秒，比时限本身还长。
      connectionsCheckingInterval: Math.max(50, Math.min(1_000, Math.floor(limits.headersTimeoutMs / 4))),
    },
    // 关闭时不等流式响应结束：agent-gw 没有状态，沙箱内的入口会重试。
    forceCloseConnections: true,
  });
  app.server.maxConnections = limits.maxConnections;
  registerErrorHandlers(app);

  // 不解析请求体：只接受 application/json，原样（Buffer）转发，由 worker 校验。
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  const agent = new Agent({ keepAlive: true, maxSockets: limits.maxConnections });
  app.addHook('onClose', async () => agent.destroy());

  const tokens = new WeakMap<FastifyRequest, TokenState>();
  const inFlight = new Map<string, number>();

  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config?.access === 'public') return;
    const token = parseAgentBearer(request.headers.authorization);
    if (token === null) {
      // 请求体还没有读取：不保持连接，剩余的请求体随连接关闭丢弃。
      reply.header('connection', 'close');
      throw new AppError(401, 'AGENT_TOKEN_INVALID', '任务令牌无效');
    }
    const logId = agentTokenLogId(hashAgentToken(token));
    const count = inFlight.get(logId) ?? 0;
    if (count >= limits.maxInFlightPerToken) {
      reply.header('connection', 'close');
      throw new AppError(429, 'AGENT_TOO_MANY_REQUESTS', '同时进行的请求过多');
    }
    inFlight.set(logId, count + 1);
    reply.raw.once('close', () => {
      const left = (inFlight.get(logId) ?? 1) - 1;
      if (left <= 0) inFlight.delete(logId);
      else inFlight.set(logId, left);
    });
    tokens.set(request, { token, logId });
    const method = request.method;
    const declared = request.headers['content-length'];
    const hasBody = request.headers['transfer-encoding'] !== undefined || (declared !== undefined && declared !== '0');
    if (method !== 'POST' && hasBody) {
      reply.header('connection', 'close');
      throw new AppError(400, 'BAD_REQUEST', '请求不合法');
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { method: request.method, path: request.url.split('?', 1)[0], statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime), tokenId: tokens.get(request)?.logId },
      'agent request',
    );
  });

  const health = { config: { access: 'public' as const } };
  app.get('/healthz', health, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { status: 'ok' };
  });

  for (const route of routes) {
    const handler = (request: FastifyRequest, reply: FastifyReply) => forward(request, reply, route);
    if (route.method === 'GET') app.get(route.path, handler);
    else app.post(route.path, { bodyLimit: route.bodyLimit ?? limits.maxBodyBytes }, handler);
  }

  function forward(request: FastifyRequest, reply: FastifyReply, route: AgentGatewayRoute): Promise<FastifyReply> {
    const state = tokens.get(request);
    if (!state) throw new AppError(401, 'AGENT_TOKEN_INVALID', '任务令牌无效');
    const body = route.method === 'POST' ? (request.body as Buffer | undefined) ?? Buffer.alloc(0) : null;
    const headers: OutgoingHttpHeaders = { authorization: `Bearer ${state.token}`, 'x-request-id': request.id };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
    }

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('agent-gw response timeout')), limits.responseTimeoutMs);
    deadline.unref();
    reply.raw.once('close', () => {
      clearTimeout(deadline);
      // 沙箱断开（或响应未发完就关闭）：中止转给 worker 的请求，worker 随之中止模型调用。
      if (!reply.raw.writableFinished) controller.abort(new Error('agent client disconnected'));
    });

    return new Promise<FastifyReply>((resolve, reject) => {
      let responded = false;
      const upstreamRequest = httpRequest(
        {
          protocol: 'http:',
          hostname: upstream.hostname,
          port: upstream.port || 80,
          // 只用登记的路径：沙箱请求中的查询串不转发。
          path: route.path,
          method: route.method,
          headers,
          agent,
          signal: controller.signal,
        },
        (response: IncomingMessage) => {
          responded = true;
          response.once('error', (error) => request.log.warn({ err: error, tokenId: state.logId }, 'agent upstream response failed'));
          reply.code(response.statusCode ?? 502);
          for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = response.headers[name];
            if (typeof value === 'string') reply.header(name, value);
          }
          if (response.headers['cache-control'] === undefined) reply.header('cache-control', 'no-store');
          resolve(reply.send(response));
        },
      );
      upstreamRequest.once('socket', (socket) => {
        if (!socket.connecting) return;
        const connectTimer = setTimeout(() => upstreamRequest.destroy(new Error('agent upstream connect timeout')), limits.upstreamConnectTimeoutMs);
        socket.once('connect', () => clearTimeout(connectTimer));
        socket.once('close', () => clearTimeout(connectTimer));
      });
      upstreamRequest.once('error', (error) => {
        if (responded) return;
        clearTimeout(deadline);
        if (controller.signal.aborted && !reply.raw.destroyed) {
          request.log.warn({ tokenId: state.logId }, 'agent upstream timed out');
          reject(new AppError(504, 'AGENT_UPSTREAM_TIMEOUT', '平台处理超时'));
          return;
        }
        request.log.warn({ err: error, tokenId: state.logId }, 'agent upstream unavailable');
        reject(new AppError(502, 'AGENT_UPSTREAM_UNAVAILABLE', '平台暂不可用'));
      });
      upstreamRequest.end(body ?? undefined);
    });
  }

  return app;
}
