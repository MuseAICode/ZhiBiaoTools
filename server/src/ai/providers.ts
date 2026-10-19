// 服务商适配（docs/EXTERNAL_SERVICES.md §7）：DeepSeek、通义千问都是 OpenAI 兼容的 /chat/completions 接口，
// 区别只在用量字段中缓存命中 token 的写法。Base URL 由平台管理员与 Key 一起配置（provider_credentials.base_url），
// 代码中不写死。目前已知的地址（以服务商文档为准，通义千问用国内站还是国际站待定，第 11 节第 3 项）：
// - deepseek：https://api.deepseek.com
// - qwen：国内站 https://dashscope.aliyuncs.com/compatible-mode/v1，国际站 https://dashscope-intl.aliyuncs.com/compatible-mode/v1
import type { BillingProvider } from '../db/schema.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

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
        messages: params.messages.map((message) => ({ role: message.role, content: message.content })),
        // 输出上限就是冻结时按的最大输出 token，服务商不会输出更多。
        max_tokens: params.maxOutputTokens,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
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
