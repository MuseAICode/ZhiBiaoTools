// Agent 的模型调用路由（路线图第 8 步 8.2c2；docs/SERVER_DESIGN.md 第 7.14 节）：worker 的 Agent 内部入口上的
// POST /v1/chat/completions，OpenAI 兼容 chat completions 的**流式子集**，供沙箱内的 Pi 运行时（openai-completions）调用。
//
// 请求来自 agent 沙箱，按攻击者的输入处理：
// - **身份只按令牌**（agentIdentityOf）：组织、发起用户、任务、任务类型由服务端按令牌查出；请求体中的 org_id、project_id、
//   job_id、user_id、provider、base_url、api_key 等字段一律 400（schema 不允许未登记的字段），头部中自称的身份不读取；
// - **模型固定**：组织在设置中选用的平台模型（resolveJobModel，与其他任务相同），白名单与定价由 AI 网关再检查；请求中的
//   model 字段（OpenAI SDK 必带）只校验格式、不采信；沙箱不能指定服务商、Base URL 或额外请求头；
// - **上限**：请求体 AGENT_CHAT_MAX_BODY_BYTES（agent-gw 与本入口各自执行）、消息条数、文本分段数，max_tokens 截到平台上限
//   （AI_MAX_OUTPUT_TOKENS），工具定义与工具调用沿用 8.2c1 的校验（src/ai/tools.ts，查模型之前先检查一次，网关再检查一次）；
// - **只转校验过的字段**：请求按 schema 转成网关的 ChatRequest（src/ai/gateway.ts），网关再按 providers.ts 重新组装服务商
//   请求体；只接受流式（stream 必须为 true），不接受图片、思考内容（reasoning_content）、tool 消息的 name 等 Pi 在本平台配置下
//   不发送的字段。
//
// 任务上限（8.3a，src/agent/budget.ts）：每个请求在调用网关之前先按令牌的任务原子地计入一轮——**取回已保存结果的请求同样计入**，
// 否则被注入的 Agent 可以无限重发同一请求（不冻结、不扣费）空耗墙钟与并发名额；达到轮数上限即 409 TASK_TURN_LIMIT，不取回、
// 不冻结、不调用服务商。费用上限由冻结（ai_usage_begin）检查，超出即 409 TASK_COST_LIMIT 并记下原因；之后的请求都被拒绝，
// 执行者据此暂停任务（task_cost_limit / task_turn_limit）。没有登记上限的任务一律拒绝。
//
// 计费、步骤幂等、并发都沿用 AI 网关：source = 'job'，任务按令牌取；步骤键固定为 AGENT_CHAT_STEP_KEY，网关的步骤幂等键
// 本来就含请求内容的 SHA-256，所以“同一任务、同一请求内容”就是同一步骤——续跑时 Pi 重发同一请求取回已保存的结果，不再扣费。
// 中止：沙箱断开（agent-gw 随之中止转发）按已产生的用量收费（与用户取消相同）；worker 关闭时中止的调用不收费
// （platform_interrupted，与任务中的调用相同）。
//
// 响应：第一段输出到达时才开始 SSE（与 /api/ai/chat 相同），在此之前的失败（余额不足、模型未选择、上游失败等）按普通 JSON 错误
// 返回；开始推送后的失败以 data: {"error": ...} 结束（OpenAI SDK 按 APIError 处理），不发 [DONE]。思考内容（reasoning_content）
// 照常计费但不转给沙箱（Pi 配置为不思考，转回会使下一轮请求带上不接受的字段）。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AiGateway, ChatDelta, ChatMessage, ChatResult, ChatTool, ChatToolCall, ChatToolChoice } from '../ai/gateway.ts';
import { MODEL_NAME_PATTERN } from '../billing/ledger.ts';
import type { TenantContext } from '../db/tenant.ts';
import { assertToolRequest, ToolRequestError } from '../ai/tools.ts';
import { AppError } from '../errors.ts';
import type { JobModel } from '../jobs/chat.ts';
import { JobError } from '../jobs/definitions.ts';
import { TASK_COST_LIMIT_CODE } from './budget.ts';
import { AGENT_CHAT_MAX_BODY_BYTES, AGENT_CHAT_PATH } from './gateway.ts';
import { agentTenantContext, type AgentTokenIdentity } from './tokenStore.ts';

export { AGENT_CHAT_MAX_BODY_BYTES, AGENT_CHAT_PATH } from './gateway.ts';

/** 一次请求最多的消息条数（Pi 会压缩过长的对话；上限只防滥用）。 */
export const AGENT_CHAT_MAX_MESSAGES = 2_000;
/** 一条消息的 content 写成分段数组时最多的段数。 */
export const AGENT_CHAT_MAX_CONTENT_PARTS = 256;
/** Agent 调用的步骤键：网关的步骤幂等键另含请求内容的 SHA-256。 */
export const AGENT_CHAT_STEP_KEY = 'agent:chat';

export interface AgentChatDependencies {
  /** 组织设置中选用的平台模型（endpoint.ts 传 resolveJobModel）；没有选择时抛 JobError。 */
  resolveModel: (context: TenantContext) => Promise<JobModel>;
  /** 未配置主密钥时为 null，路由返回 503。 */
  gateway: AiGateway | null;
  /** 平台的最大输出 token（AI_MAX_OUTPUT_TOKENS）：请求中的 max_tokens 截到它。 */
  maxOutputTokens: number;
  /** 本次请求的令牌身份（endpoint.ts 的 agentIdentityOf）。 */
  identityOf: (request: FastifyRequest) => AgentTokenIdentity;
  /** 计入一轮模型调用请求（endpoint.ts 传 beginAgentTurn）；达到上限、没有登记上限、任务不在执行中时抛 AppError。 */
  beginTurn: (identity: AgentTokenIdentity) => Promise<void>;
  /** 冻结时费用上限检查失败后记下原因（endpoint.ts 传 markAgentBudgetExhausted）。 */
  markCostLimit: (identity: AgentTokenIdentity) => Promise<void>;
  /** 登记进行中的调用，worker 关闭时以原因 'shutdown' 统一中止（不收费）；返回注销函数。 */
  track: (controller: AbortController) => () => void;
}

const textPart = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'text'],
  properties: { type: { const: 'text' }, text: { type: 'string' } },
} as const;

const textContent = { type: 'array', minItems: 1, maxItems: AGENT_CHAT_MAX_CONTENT_PARTS, items: textPart } as const;

const toolCallSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'function'],
  properties: {
    id: { type: 'string' },
    type: { const: 'function' },
    function: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'arguments'],
      properties: { name: { type: 'string' }, arguments: { type: 'string' } },
    },
  },
} as const;

/**
 * 请求体 schema：只有登记的字段，其余（含自称的组织、任务、服务商、Base URL 等）一律 400。各角色的字段组合、工具定义的
 * 细节由 toChatRequest 与网关（src/ai/tools.ts）检查。
 */
export const AGENT_CHAT_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['messages', 'stream'],
  properties: {
    model: { type: 'string', pattern: MODEL_NAME_PATTERN.source },
    messages: {
      type: 'array',
      minItems: 1,
      maxItems: AGENT_CHAT_MAX_MESSAGES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role'],
        properties: {
          role: { enum: ['system', 'user', 'assistant', 'tool'] },
          content: { anyOf: [{ type: 'string' }, { type: 'null' }, textContent] },
          tool_calls: { type: 'array', items: toolCallSchema },
          tool_call_id: { type: 'string' },
        },
      },
    },
    stream: { const: true },
    stream_options: { type: 'object', additionalProperties: false, properties: { include_usage: { type: 'boolean' } } },
    max_tokens: { type: 'integer', minimum: 1 },
    max_completion_tokens: { type: 'integer', minimum: 1 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'function'],
        properties: {
          type: { const: 'function' },
          function: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'parameters'],
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              parameters: { type: 'object' },
              // Pi 对支持 strict 的服务商发 strict: false；严格模式不转给服务商，只接受 false。
              strict: { const: false },
            },
          },
        },
      },
    },
    tool_choice: {
      anyOf: [
        { enum: ['auto', 'none', 'required'] },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'function'],
          properties: {
            type: { const: 'function' },
            function: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
          },
        },
      ],
    },
    // Pi 对 OpenAI 标准接口发 store: false；平台不保存对话，只接受 false。
    store: { const: false },
  },
} as const;

type TextPart = { type: 'text'; text: string };

export interface AgentChatBody {
  model?: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | null | TextPart[];
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  }>;
  stream: true;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown>; strict?: false } }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  store?: false;
}

/** 转换后的请求（不含服务商与模型：由组织设置决定）。 */
export interface AgentChatInput {
  messages: ChatMessage[];
  tools?: ChatTool[];
  toolChoice?: ChatToolChoice;
  maxOutputTokens: number;
  temperature?: number;
  includeUsage: boolean;
}

function invalid(message: string): AppError {
  return new AppError(400, 'INVALID_AI_REQUEST', message);
}

function textOf(content: string | TextPart[]): string {
  return typeof content === 'string' ? content : content.map((part) => part.text).join('');
}

/**
 * 把（已通过 schema 的）请求体转成网关的字段。各角色允许的字段：system / user 只有 content（字符串或文本分段）；
 * assistant 的 content 可以为 null 或省略（只有工具调用时），可带 tool_calls；tool 必须带 tool_call_id 与 content。
 * 空的 tools 数组按“不提供工具”处理（Pi 在对话中有工具记录、本轮没有工具时发 tools: []）。
 */
export function toChatRequest(body: AgentChatBody, platformMaxOutputTokens: number): AgentChatInput {
  const messages: ChatMessage[] = body.messages.map((message) => {
    const { role, content } = message;
    if (role !== 'assistant' && message.tool_calls !== undefined) throw invalid('只有 assistant 消息能带工具调用');
    if (role !== 'tool' && message.tool_call_id !== undefined) throw invalid('只有 tool 消息能带 tool_call_id');
    if (role === 'assistant') {
      const toolCalls = message.tool_calls?.map((call): ChatToolCall => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
      const text = content === undefined || content === null ? '' : textOf(content);
      return toolCalls !== undefined ? { role, content: text, toolCalls } : { role, content: text };
    }
    if (content === undefined || content === null) throw invalid('消息格式不正确');
    if (role === 'tool') {
      if (message.tool_call_id === undefined) throw invalid('tool 消息必须带 tool_call_id');
      return { role, content: textOf(content), toolCallId: message.tool_call_id };
    }
    return { role, content: textOf(content) };
  });

  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw invalid('max_tokens 与 max_completion_tokens 只能给一个');
  const requested = body.max_tokens ?? body.max_completion_tokens;
  const input: AgentChatInput = {
    messages,
    // 截到平台上限：冻结额按它计算，沙箱不能要求更多。
    maxOutputTokens: Math.min(requested ?? platformMaxOutputTokens, platformMaxOutputTokens),
    includeUsage: body.stream_options?.include_usage === true,
  };
  if (body.temperature !== undefined) input.temperature = body.temperature;
  if (body.tools !== undefined && body.tools.length > 0) {
    input.tools = body.tools.map((tool) => ({
      name: tool.function.name,
      ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters,
    }));
  }
  if (body.tool_choice !== undefined) {
    input.toolChoice = typeof body.tool_choice === 'string' ? body.tool_choice : { name: body.tool_choice.function.name };
  }
  // 工具定义、工具选择与工具字段的细节（8.2c1）：在查模型之前先检查一次，网关调用时再检查一次。
  try {
    assertToolRequest(input.messages, input.tools, input.toolChoice);
  } catch (error) {
    if (error instanceof ToolRequestError) throw invalid(error.message);
    throw error;
  }
  return input;
}

/** onDelta 的工具调用段转回 OpenAI 格式的 delta.tool_calls。 */
function toolCallsDelta(pieces: NonNullable<ChatDelta['toolCalls']>): unknown[] {
  return pieces.map((piece) => {
    const fn: Record<string, string> = {};
    if (piece.name !== undefined) fn.name = piece.name;
    if (piece.arguments !== undefined) fn.arguments = piece.arguments;
    return {
      index: piece.index,
      ...(piece.id !== undefined ? { id: piece.id, type: 'function' } : {}),
      ...(Object.keys(fn).length > 0 ? { function: fn } : {}),
    };
  });
}

function usageBody(result: ChatResult) {
  const { inputTokens, cachedInputTokens, outputTokens } = result.usage;
  return { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens, prompt_tokens_details: { cached_tokens: cachedInputTokens } };
}

export function registerAgentChatRoute(app: FastifyInstance, deps: AgentChatDependencies): void {
  app.post<{ Body: AgentChatBody }>(
    AGENT_CHAT_PATH,
    { bodyLimit: AGENT_CHAT_MAX_BODY_BYTES, schema: { body: AGENT_CHAT_BODY_SCHEMA } },
    async (request: FastifyRequest<{ Body: AgentChatBody }>, reply: FastifyReply) => {
      const identity = deps.identityOf(request);
      const gateway = deps.gateway;
      if (!gateway) throw new AppError(503, 'AI_GATEWAY_DISABLED', '模型服务暂不可用，请稍后再试');
      const input = toChatRequest(request.body, deps.maxOutputTokens);
      const tenant = agentTenantContext(identity);
      let model: JobModel;
      try {
        model = await deps.resolveModel(tenant);
      } catch (error) {
        if (error instanceof JobError) throw new AppError(409, error.code, error.message);
        throw error;
      }
      // 轮数：在取回已保存结果、冻结之前计入（达到上限时抛错，不调用网关）。
      await deps.beginTurn(identity);

      // 沙箱断开（agent-gw 中止转发）时立即中止上游调用，已产生的用量照常结算；worker 关闭时由 track 统一中止（不收费）。
      const controller = new AbortController();
      const untrack = deps.track(controller);
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished && !controller.signal.aborted) controller.abort('client');
      });
      if (request.raw.socket?.destroyed) controller.abort('client');

      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      let streaming = false;
      let sentOutput = false;
      const write = (data: unknown) => {
        if (!controller.signal.aborted && !reply.raw.destroyed) reply.raw.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
      };
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model: model.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      // 第一段输出到达时才切换为 SSE，在此之前的失败都还能用普通的 HTTP 错误返回。
      const startStream = () => {
        if (streaming) return;
        streaming = true;
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      };
      const emit = (delta: Record<string, unknown>) => {
        startStream();
        write(chunk(sentOutput ? delta : { role: 'assistant', ...delta }));
        sentOutput = true;
      };

      let result: ChatResult;
      try {
        result = await gateway.chat(
          tenant,
          {
            provider: model.provider,
            model: model.model,
            messages: input.messages,
            maxOutputTokens: input.maxOutputTokens,
            temperature: input.temperature,
            tools: input.tools,
            toolChoice: input.toolChoice,
            source: 'job',
            jobId: identity.jobId,
            jobType: identity.jobType,
            stepKey: AGENT_CHAT_STEP_KEY,
          },
          {
            signal: controller.signal,
            log: request.log,
            // 与任务中的调用相同：一直排队等并发名额，直到沙箱断开或 worker 关闭。
            concurrencyWaitMs: Number.POSITIVE_INFINITY,
            platformAborted: () => controller.signal.reason === 'shutdown',
            onDelta: (delta: ChatDelta) => {
              const piece: Record<string, unknown> = {};
              if (delta.content !== undefined) piece.content = delta.content;
              if (delta.toolCalls !== undefined) piece.tool_calls = toolCallsDelta(delta.toolCalls);
              if (Object.keys(piece).length > 0) emit(piece);
            },
          },
        );
      } catch (error) {
        untrack();
        if (error instanceof AppError && error.code === TASK_COST_LIMIT_CODE) {
          await deps.markCostLimit(identity).catch((markError: unknown) => request.log.error({ err: markError, jobId: identity.jobId }, 'agent budget mark failed'));
        }
        if (!streaming) throw error;
        const failure = error instanceof AppError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: '服务器内部错误' };
        if (!(error instanceof AppError)) request.log.error({ err: error, jobId: identity.jobId }, 'agent chat stream failed');
        write({ error: { ...failure, type: 'server_error', requestId: request.id } });
        reply.raw.end();
        return reply;
      }
      untrack();
      if (result.aborted) {
        // 沙箱已断开：没有可以回写的连接。
        if (!reply.raw.destroyed) reply.raw.destroy();
        return reply;
      }
      // 取回的已保存结果（续跑）没有分段输出：一次给出全部内容与工具调用。
      if (!sentOutput) {
        const full: Record<string, unknown> = {};
        if (result.content !== '') full.content = result.content;
        if (result.toolCalls.length > 0) {
          full.tool_calls = result.toolCalls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
        }
        emit(full);
      }
      write(chunk({}, result.finishReason ?? (result.toolCalls.length > 0 ? 'tool_calls' : 'stop')));
      if (input.includeUsage) write({ id, object: 'chat.completion.chunk', created, model: model.model, choices: [], usage: usageBody(result) });
      write('[DONE]');
      reply.raw.end();
      return reply;
    },
  );
}
