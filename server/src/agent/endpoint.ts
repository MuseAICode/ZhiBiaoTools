// worker 的 Agent 内部入口（路线图第 8 步 8.2b；docs/SERVER_DESIGN.md 第 7.12 节）：只接收 agent-gw 经内部网络 agent-relay
// 转来的请求，与 worker 的健康检查分开监听（AGENT_ENDPOINT_HOST / AGENT_ENDPOINT_PORT）。
//
// - **先校验中继密钥**（AGENT_RELAY_KEY_HEADER，常量时间比较，#73 确认）：不带或带错的请求即使有有效的任务令牌也 401，
//   不查库。网络配置出错、沙箱能直接连到这里时，沙箱绕不过 agent-gw 的过滤；
// - **请求体大小自己检查**，不只依赖 agent-gw：声明的长度超过上限时不读取直接 413，分块传输的按读取的字节数检查（Fastify bodyLimit）；
// - **每个请求都按令牌重新查身份**（lookupAgentJobToken，不缓存）：令牌无效（格式不对、不存在、作废、过期，任务已结束、暂停、
//   取消、换执行者，发起人被移出组织，项目已删除）一律 401，不区分原因。令牌失效后的下一个请求立即被拒绝。
// - 令牌所代表的身份是唯一可信来源：请求中出现的组织、项目、任务、用户、模型名、Base URL 等字段一律不采信（8.2c、8.4 的路由
//   经 agentIdentityOf 取身份）。agent-gw 也不转发这类头部，这里不依赖它。
// - 接收时限有上限；日志只记令牌哈希前缀与任务 id，不记令牌原文与中继密钥。
//
// 路由：GET /v1/session（8.2b）返回令牌当前的到期时间（令牌与租约中较早者），供沙箱内的入口（8.6）确认令牌有效，
// 不返回组织、项目、用户等标识（沙箱不需要）；POST /v1/chat/completions（8.2c2，src/agent/chatCompletions.ts）经 AI 网关
// 调用组织选用的模型；POST /v1/tools/call（8.4a，src/agent/tools.ts）执行本任务类型登记可用的业务工具。关闭时（worker 停止）
// 先中止进行中的模型调用（这些调用不收费）与工具调用。
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { AiGateway } from '../ai/gateway.ts';
import type { LogLevel } from '../config.ts';
import type { Database } from '../db/schema.ts';
import { AppError, registerErrorHandlers } from '../errors.ts';
import { resolveJobModel } from '../jobs/chat.ts';
import { createLoggerOptions } from '../logger.ts';
import { beginAgentTurn, markAgentBudgetExhausted } from './budget.ts';
import { registerAgentChatRoute } from './chatCompletions.ts';
import { createAgentToolRegistry, registerAgentToolRoute, type AgentToolRegistry } from './tools.ts';
import { DEFAULT_AGENT_GATEWAY_LIMITS } from './gateway.ts';
import { AGENT_RELAY_KEY_HEADER, createRelayKeyVerifier, parseAgentBearer } from './token.ts';
import { agentTenantContext, lookupAgentJobToken, type AgentTokenIdentity } from './tokenStore.ts';

export interface AgentEndpointOptions {
  db: Kysely<Database>;
  /** agent-gw 转发时带的中继密钥（至少 32 个字符）。 */
  relayKey: string;
  logLevel: LogLevel;
  logStream?: NodeJS.WritableStream;
  /** 收齐整个请求的时限（毫秒），默认与 agent-gw 相同。 */
  requestTimeoutMs?: number;
  /** 请求体上限（字节），默认与 agent-gw 的兜底上限相同；路由可以给出更小的上限（模型调用 AGENT_CHAT_MAX_BODY_BYTES）。 */
  bodyLimit?: number;
  /** 模型调用用的 AI 网关；未配置主密钥时为 null（或不传），模型调用返回 503。 */
  gateway?: AiGateway | null;
  /** 平台的最大输出 token（AI_MAX_OUTPUT_TOKENS）。 */
  maxOutputTokens?: number;
  /** 业务工具（8.4a）；不传时没有工具，所有工具调用 404。 */
  tools?: AgentToolRegistry;
  /** 任务类型登记可用的工具名（JobTypeDefinition.agentTools）；不传时所有任务类型都没有可用的工具。 */
  toolsForJobType?: (jobType: string) => readonly string[];
  /** 通知执行者立即检查该任务（任务控制频道，8.4b 的失败报告用）；不传时执行者在下一次定期续租时发现。 */
  notifyJobControl?: (jobId: string) => Promise<void>;
  /** 推送任务的问题状态（ask-user，8.4c1，SSE 的 job.question）；不传时不推送。 */
  notifyQuestion?: (identity: AgentTokenIdentity, questionId: string, status: 'pending' | 'answered') => Promise<void>;
}

/** 未给出 maxOutputTokens 时（测试）的平台最大输出 token，与 AI_MAX_OUTPUT_TOKENS 的默认值相同。 */
const DEFAULT_AGENT_MAX_OUTPUT_TOKENS = 8192;
/** 关闭时等进行中的模型调用释放冻结的上限（worker 的关闭时限是 25 秒）。 */
const CLOSE_DRAIN_MS = 5_000;

const identities = new WeakMap<FastifyRequest, AgentTokenIdentity>();

/** 本请求的令牌身份（onRequest 中已按令牌查出）；路由中只用它确定组织、项目、任务与用户。 */
export function agentIdentityOf(request: FastifyRequest): AgentTokenIdentity {
  const identity = identities.get(request);
  if (!identity) throw new AppError(401, 'AGENT_TOKEN_INVALID', '任务令牌无效');
  return identity;
}

export async function buildAgentEndpointApp(options: AgentEndpointOptions): Promise<FastifyInstance> {
  const verifyRelayKey = createRelayKeyVerifier(options.relayKey);
  const bodyLimit = options.bodyLimit ?? DEFAULT_AGENT_GATEWAY_LIMITS.maxBodyBytes;
  const app = Fastify({
    logger: createLoggerOptions({ level: options.logLevel, ...(options.logStream ? { stream: options.logStream } : {}) }),
    logController: new LogController({ disableRequestLogging: true }),
    exposeHeadRoutes: false,
    bodyLimit,
    // 不做类型转换：沙箱发来的 "1" 不当作数字。
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    requestTimeout: options.requestTimeoutMs ?? DEFAULT_AGENT_GATEWAY_LIMITS.requestTimeoutMs,
    http: { maxHeaderSize: DEFAULT_AGENT_GATEWAY_LIMITS.maxHeaderBytes },
    // 关闭时（preClose 中止进行中的模型调用之后）关闭全部连接，不等 agent-gw 的长连接。
    forceCloseConnections: true,
  });
  registerErrorHandlers(app);
  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', async (request, reply) => {
    // 中继密钥：只有 agent-gw 持有。不带或带错的一律拒绝，不读请求体、不查库。
    if (!verifyRelayKey(request.headers[AGENT_RELAY_KEY_HEADER])) {
      reply.header('connection', 'close');
      throw new AppError(401, 'UNAUTHORIZED', '请求来源无效');
    }
    // 请求体大小：声明的长度超过上限（路由自己的上限，没有时取整体的）时不读取（分块传输的由 Fastify 按读取的字节数检查）。
    const declared = request.headers['content-length'];
    const limit = request.routeOptions.bodyLimit ?? bodyLimit;
    if (declared !== undefined && !(/^\d{1,12}$/.test(declared) && Number(declared) <= limit)) {
      reply.header('connection', 'close');
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
    }
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

  // 进行中的模型调用与工具调用：关闭时统一中止（原因 shutdown，模型调用不收费），等它们释放冻结并结束响应（至多 CLOSE_DRAIN_MS），
  // 再由 forceCloseConnections 关闭全部连接（agent-gw 的长连接空闲时也不会拖住关闭）。
  const inFlight = new Set<AbortController>();
  let drained: (() => void) | null = null;
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
    if (inFlight.size === 0) return;
    const done = new Promise<void>((resolve) => (drained = resolve));
    for (const controller of inFlight) controller.abort('shutdown');
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, CLOSE_DRAIN_MS).unref())]);
  });
  function track(controller: AbortController): () => void {
    if (closing) controller.abort('shutdown');
    inFlight.add(controller);
    return () => {
      inFlight.delete(controller);
      if (inFlight.size === 0) drained?.();
    };
  }
  registerAgentChatRoute(app, {
    resolveModel: (context) => resolveJobModel(options.db, context),
    gateway: options.gateway ?? null,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
    identityOf: agentIdentityOf,
    beginTurn: async (identity) => {
      await beginAgentTurn(options.db, { tenant: agentTenantContext(identity), jobId: identity.jobId, runId: identity.runId });
    },
    markCostLimit: async (identity) => {
      await markAgentBudgetExhausted(options.db, { tenant: agentTenantContext(identity), jobId: identity.jobId, runId: identity.runId }, 'task_cost_limit');
    },
    track,
  });
  registerAgentToolRoute(app, {
    db: options.db,
    tools: options.tools ?? createAgentToolRegistry([]),
    toolsForJobType: options.toolsForJobType ?? (() => []),
    identityOf: agentIdentityOf,
    track,
    ...(options.notifyJobControl ? { notifyJobControl: options.notifyJobControl } : {}),
    ...(options.notifyQuestion ? { notifyQuestion: options.notifyQuestion } : {}),
  });

  return app;
}
