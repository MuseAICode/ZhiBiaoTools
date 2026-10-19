// 冻结和估算用的 token 数（docs/SERVER_DESIGN.md 第 10.3 节）。
//
// 冻结要按“已知输入 token”算最高费用，但服务商的分词器不在本地。DeepSeek 和通义千问都是字节级 BPE：
// 每个 token 至少对应 1 个 UTF-8 字节，所以“UTF-8 字节数 + 每条消息的模板开销”是输入 token 数的上界。
// 中文约 3 字节一个字，冻结额会明显高于实际费用，结算时多余部分全部释放。
import type { ChatMessage } from './providers.ts';

/** 每条消息的角色和分隔符、整个请求的模板开销（token），取宽松的上界。 */
export const MESSAGE_OVERHEAD_TOKENS = 16;
export const REQUEST_OVERHEAD_TOKENS = 64;

/** 输入 token 数的上界，用于冻结。 */
export function inputTokenUpperBound(messages: readonly ChatMessage[]): number {
  let total = REQUEST_OVERHEAD_TOKENS;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS + Buffer.byteLength(message.role, 'utf8') + Buffer.byteLength(message.content, 'utf8');
  }
  return total;
}

/**
 * 服务商没有返回用量时（例如用户中途断开）的本地估算：中日韩字符按 1 个 token，其他字符按 4 个一组。
 * 只用于计费，结果不会超过冻结额（结算时封顶）。
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const char of text) {
    if (char.codePointAt(0)! >= 0x2e80) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / 4);
}

export function estimateInputTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + 4 + estimateTokens(message.content), 3);
}
