// 服务商适配（docs/EXTERNAL_SERVICES.md §7）：DeepSeek、通义千问都是 OpenAI 兼容的 /chat/completions 接口，
// 区别只在用量字段中缓存命中 token 的写法。Base URL 由平台管理员与 Key 一起配置（provider_credentials.base_url），
// 代码中不写死。目前已知的地址（以服务商文档为准，通义千问用国内站还是国际站待定，第 11 节第 3 项）：
// - deepseek：https://api.deepseek.com
// - qwen：国内站 https://dashscope.aliyuncs.com/compatible-mode/v1，国际站 https://dashscope-intl.aliyuncs.com/compatible-mode/v1
// 工具调用（路线图 8.2c1，Agent 用）：两家都支持 OpenAI 兼容的 tools / tool_choice、assistant 消息的 tool_calls 与 tool 消息，
// 流式输出中工具调用按 delta.tool_calls 分段返回（src/ai/tools.ts 汇总）。
import type { BillingProvider } from '../db/schema.ts';

/** 模型发起的一次工具调用（OpenAI 兼容格式的 tool_calls，只有 function 一种）。arguments 是模型输出的 JSON 文本，不可信。 */
export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 一条消息。工具调用（路线图 8.2c1）：assistant 消息可以带 toolCalls（此时 content 可以为空），
 * tool 消息是某次工具调用的结果，必须带 toolCallId；其他角色不能带这两个字段（网关校验）。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: readonly ChatToolCall[] | undefined;
  toolCallId?: string | undefined;
}

/** 提供给模型的工具（function）：parameters 是 JSON Schema 对象，原样转给服务商。 */
export interface ChatTool {
  name: string;
  description?: string | undefined;
  parameters: Readonly<Record<string, unknown>>;
}

/** 工具选择：auto（默认）、none、required，或指定一个工具名。 */
export type ChatToolChoice = 'auto' | 'none' | 'required' | { readonly name: string };

export interface ProviderUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ChatCompletionParams {
  model: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  temperature: number | undefined;
  tools?: readonly ChatTool[] | undefined;
  toolChoice?: ChatToolChoice | undefined;
}

function messageBody(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      // 只有工具调用、没有文字时按 OpenAI 的约定传 null。
      content: message.content === '' ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
    };
  }
  return { role: message.role, content: message.content };
}

function toolChoiceBody(choice: ChatToolChoice): unknown {
  return typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } };
}

export interface ProviderAdapter {
  readonly chatPath: string;
  buildBody(params: ChatCompletionParams): Record<string, unknown>;
  /** 从流式响应最后一个块的 usage 中取用量；字段缺失或不合法时返回 null（改用本地估算）。 */
  parseUsage(usage: unknown): ProviderUsage | null;
}

const MAX_TOKENS = 1_000_000_000;

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : undefined;
}

function openAiCompatible(cachedTokens: (usage: Record<string, unknown>) => unknown): ProviderAdapter {
  return Object.freeze({
    chatPath: '/chat/completions',
    buildBody(params: ChatCompletionParams) {
      return {
        model: params.model,
        // 只转已校验的字段：调用方（8.2c 起含 agent 沙箱）传入的其他字段一律不转给服务商。
        messages: params.messages.map(messageBody),
        // 输出上限就是冻结时按的最大输出 token，服务商不会输出更多。
        max_tokens: params.maxOutputTokens,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.tools && params.tools.length > 0
          ? {
              tools: params.tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, ...(tool.description !== undefined ? { description: tool.description } : {}), parameters: tool.parameters },
              })),
            }
          : {}),
        ...(params.toolChoice !== undefined ? { tool_choice: toolChoiceBody(params.toolChoice) } : {}),
        stream: true,
        // 两家都在最后一个块里返回本次的用量。
        stream_options: { include_usage: true },
      };
    },
    parseUsage(usage: unknown): ProviderUsage | null {
      if (usage === null || typeof usage !== 'object') return null;
      const record = usage as Record<string, unknown>;
      const inputTokens = tokenCount(record.prompt_tokens);
      const outputTokens = tokenCount(record.completion_tokens);
      if (inputTokens === undefined || outputTokens === undefined) return null;
      const cached = tokenCount(cachedTokens(record)) ?? 0;
      return { inputTokens, outputTokens, cachedInputTokens: Math.min(cached, inputTokens) };
    },
  });
}

export const PROVIDER_ADAPTERS: Readonly<Record<BillingProvider, ProviderAdapter>> = Object.freeze({
  deepseek: openAiCompatible((usage) => usage.prompt_cache_hit_tokens),
  qwen: openAiCompatible((usage) => (usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens),
});
