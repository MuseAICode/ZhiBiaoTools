// AI 调用接口（docs/SERVER_DESIGN.md 第 1.1、10 节）：交互式的 ai.chat，经 AI 网关计量计费。
// 需要登录，组织取自会话；模型服务的 Key 和 Base URL 由平台配置，请求中不能指定。
//
// stream = true 时以 SSE 返回：event: delta（增量内容）、done（用量与费用）、error（调用中途失败）。
// 冻结失败（余额不足、模型不在白名单中或未定价、服务未配置）和第一段内容到达前的上游失败仍以普通 JSON 错误返回，
// 前端可以按状态码处理；开始推送后才发生的失败以 error 事件返回。
import type { FastifyInstance } from 'fastify';
import { tenantOf } from '../auth/hooks.ts';
import { MODEL_NAME_PATTERN } from '../billing/ledger.ts';
import type { AiGateway, ChatDelta, ChatMessage, ChatResult } from '../ai/gateway.ts';
import { BILLING_PROVIDERS, type BillingProvider } from '../db/schema.ts';
import { AppError } from '../errors.ts';

export interface AiRouteDependencies {
  /** 未配置主密钥（AI_KEK_FILE）时为 null，接口返回 503。 */
  gateway: AiGateway | null;
  maxOutputTokens: number;
}

/** 单条消息和整个请求的上限：请求体总大小另受 bodyLimit（1 MB）约束。 */
const MAX_MESSAGES = 500;
const MAX_MESSAGE_CHARS = 500_000;

interface ChatBody {
  provider: BillingProvider;
  model: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  stream?: boolean;
}

function resultBody(result: ChatResult) {
  return {
    requestId: result.requestId,
    finishReason: result.finishReason,
    usage: {
      inputTokens: result.usage.inputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      outputTokens: result.usage.outputTokens,
      source: result.usage.usageSource,
    },
    // 金额是计费单位（0.0001 元）的十进制字符串。
    billing: { status: result.billing.status, amount: result.billing.amount.toString() },
  };
}

export async function registerAiRoutes(app: FastifyInstance, deps: AiRouteDependencies): Promise<void> {
  app.post<{ Body: ChatBody }>(
    '/chat',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: [...BILLING_PROVIDERS] },
            model: { type: 'string', pattern: MODEL_NAME_PATTERN.source },
            messages: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_MESSAGES,
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                  content: { type: 'string', maxLength: MAX_MESSAGE_CHARS },
                },
                required: ['role', 'content'],
                additionalProperties: false,
              },
            },
            maxOutputTokens: { type: 'integer', minimum: 1, maximum: deps.maxOutputTokens },
            temperature: { type: 'number', minimum: 0, maximum: 2 },
            stream: { type: 'boolean' },
          },
          required: ['provider', 'model', 'messages'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const gateway = deps.gateway;
      if (!gateway) throw new AppError(503, 'AI_GATEWAY_DISABLED', 'AI 服务暂未开放');
      const context = tenantOf(request);
      const body = request.body;

      // 用户断开时立即中止上游调用（关闭到服务商的连接）；已产生的用量照常结算（第 10.1 节）。
      // 连接在处理函数开始前就已断开时，close 事件已经错过，直接取消：网关不会冻结、不会调用服务商。
      const controller = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) controller.abort();
      });
      if (request.raw.socket?.destroyed) controller.abort();

      let streaming = false;
      const write = (event: string, data: unknown) => {
        if (!controller.signal.aborted) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      // 第一段内容到达时才切换为 SSE，在此之前的失败都还能用普通的 HTTP 错误返回。
      const startStream = () => {
        if (streaming) return;
        streaming = true;
        reply.hijack();
        // hijack 之后 Fastify 不再发送 reply 上的头（helmet 的安全头等），这里一并写出。
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) reply.raw.setHeader(name, value);
        }
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-accel-buffering': 'no',
          'x-request-id': request.id,
        });
      };

      const chat = gateway.chat(
        context,
        {
          provider: body.provider,
          model: body.model,
          messages: body.messages,
          maxOutputTokens: body.maxOutputTokens,
          temperature: body.temperature,
          source: 'interactive',
        },
        {
          signal: controller.signal,
          log: request.log,
          ...(body.stream
            ? {
                onDelta: (delta: ChatDelta) => {
                  startStream();
                  write('delta', delta);
                },
              }
            : {}),
        },
      );

      if (!body.stream) {
        const result = await chat;
        reply.header('cache-control', 'no-store');
        return { ...resultBody(result), content: result.content, reasoningContent: result.reasoningContent };
      }

      let result: ChatResult;
      try {
        result = await chat;
      } catch (error) {
        if (!streaming) throw error;
        if (error instanceof AppError) {
          write('error', { error: { code: error.code, message: error.message, requestId: request.id } });
        } else {
          request.log.error({ err: error }, 'ai stream failed');
          write('error', { error: { code: 'INTERNAL_ERROR', message: '服务器内部错误', requestId: request.id } });
        }
        reply.raw.end();
        return reply;
      }
      startStream();
      write('done', resultBody(result));
      reply.raw.end();
      return reply;
    },
  );
}
