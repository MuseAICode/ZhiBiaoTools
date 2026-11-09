// worker 的 Agent 内部入口（路线图第 8 步 8.2b；docs/SERVER_DESIGN.md 第 7.12 节）：只接收 agent-gw 经内部网络 agent-relay
// 转来的请求，与 worker 的健康检查分开监听（AGENT_ENDPOINT_HOST / AGENT_ENDPOINT_PORT）。
//
// - **每个请求都按令牌重新查身份**（lookupAgentJobToken，不缓存）：令牌无效（格式不对、不存在、作废、过期，任务已结束、暂停、
//   取消、换执行者，发起人被移出组织，项目已删除）一律 401，不区分原因。令牌失效后的下一个请求立即被拒绝。
// - 令牌所代表的身份是唯一可信来源：请求中出现的组织、项目、任务、用户、模型名、Base URL 等字段一律不采信（8.2c、8.4 的路由
//   经 agentIdentityOf 取身份）。agent-gw 也不转发这类头部，这里不依赖它。
// - 请求体与接收时限有上限（agent-gw 已检查，这里再兜底）；日志只记令牌哈希前缀与任务 id，不记令牌原文。
//
// 8.2b 只有 GET /v1/session：返回令牌当前的到期时间（令牌与租约中较早者），供沙箱内的入口（8.6）确认令牌有效；
// 不返回组织、项目、用户等标识（沙箱不需要）。
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { LogLevel } from '../config.ts';
import type { Database } from '../db/schema.ts';
import { AppError, registerErrorHandlers } from '../errors.ts';
import { createLoggerOptions } from '../logger.ts';
import { DEFAULT_AGENT_GATEWAY_LIMITS } from './gateway.ts';
import { parseAgentBearer } from './token.ts';
import { lookupAgentJobToken, type AgentTokenIdentity } from './tokenStore.ts';

export interface AgentEndpointOptions {
  db: Kysely<Database>;
  logLevel: LogLevel;
  logStream?: NodeJS.WritableStream;
  /** 收齐整个请求的时限（毫秒），默认与 agent-gw 相同。 */
  requestTimeoutMs?: number;
}

const identities = new WeakMap<FastifyRequest, AgentTokenIdentity>();

/** 本请求的令牌身份（onRequest 中已按令牌查出）；路由中只用它确定组织、项目、任务与用户。 */
export function agentIdentityOf(request: FastifyRequest): AgentTokenIdentity {
  const identity = identities.get(request);
  if (!identity) throw new AppError(401, 'AGENT_TOKEN_INVALID', '任务令牌无效');
  return identity;
}

export async function buildAgentEndpointApp(options: AgentEndpointOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    logger: createLoggerOptions({ level: options.logLevel, ...(options.logStream ? { stream: options.logStream } : {}) }),
    logController: new LogController({ disableRequestLogging: true }),
    exposeHeadRoutes: false,
    bodyLimit: DEFAULT_AGENT_GATEWAY_LIMITS.maxBodyBytes,
    requestTimeout: options.requestTimeoutMs ?? DEFAULT_AGENT_GATEWAY_LIMITS.requestTimeoutMs,
    http: { maxHeaderSize: DEFAULT_AGENT_GATEWAY_LIMITS.maxHeaderBytes },
  });
  registerErrorHandlers(app);
  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', async (request, reply) => {
    const token = parseAgentBearer(request.headers.authorization);
    // 每次都查库：令牌失效（暂停、取消、移出组织等）在下一个请求立即生效。
    const identity = token === null ? null : await lookupAgentJobToken(options.db, token);
    if (!identity) {
      reply.header('connection', 'close');
      throw new AppError(401, 'AGENT_TOKEN_INVALID', '任务令牌无效');
    }
    identities.set(request, identity);
  });

  app.addHook('onResponse', async (request, reply) => {
    const identity = identities.get(request);
    request.log.info(
      {
        method: request.method,
        path: request.url.split('?', 1)[0],
        statusCode: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        tokenId: identity?.logId,
        jobId: identity?.jobId,
        gatewayRequestId: typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'].slice(0, 64) : undefined,
      },
      'agent endpoint request',
    );
  });

  app.get('/v1/session', async (request, reply) => {
    const identity = agentIdentityOf(request);
    reply.header('cache-control', 'no-store');
    return { status: 'active', expiresAt: identity.expiresAt.toISOString() };
  });

  return app;
}
