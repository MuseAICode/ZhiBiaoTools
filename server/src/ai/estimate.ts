// 冻结和估算用的 token 数（docs/SERVER_DESIGN.md 第 10.3 节）。
//
// 冻结要按“已知输入 token”算最高费用，但服务商的分词器不在本地。DeepSeek 和通义千问都是字节级 BPE：
// 每个 token 至少对应 1 个 UTF-8 字节，所以“UTF-8 字节数 + 每条消息的模板开销”是输入 token 数的上界。
// 中文约 3 字节一个字，冻结额会明显高于实际费用，结算时多余部分全部释放。
//
// 工具调用（8.2c1）：服务商把工具定义渲染进提示词模板（带说明文字与 JSON 结构），把历史中的工具调用、工具结果也渲染进去，
// 都按字节数计入上界，另加每个工具、每次工具调用、每条工具结果的模板开销，以及“有工具”时整段工具说明的固定开销，均取宽松值。
import type { ChatMessage, ChatTool, ChatToolCall } from './providers.ts';
import { toolCallBytes, toolDefinitionBytes } from './tools.ts';

/** 每条消息的角色和分隔符、整个请求的模板开销（token），取宽松的上界。 */
export const MESSAGE_OVERHEAD_TOKENS = 16;
export const REQUEST_OVERHEAD_TOKENS = 64;
/** 有工具定义时整段工具说明的模板开销、每个工具定义的开销、每次工具调用（含 tool_call_id 引用）的开销（token）。 */
export const TOOLS_OVERHEAD_TOKENS = 1024;
export const TOOL_OVERHEAD_TOKENS = 64;
export const TOOL_CALL_OVERHEAD_TOKENS = 32;

/** 输入 token 数的上界，用于冻结。 */
export function inputTokenUpperBound(messages: readonly ChatMessage[], tools?: readonly ChatTool[]): number {
  let total = REQUEST_OVERHEAD_TOKENS;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS + Buffer.byteLength(message.role, 'utf8') + Buffer.byteLength(message.content, 'utf8');
    if (message.toolCalls) total += message.toolCalls.length * TOOL_CALL_OVERHEAD_TOKENS + toolCallBytes(message.toolCalls);
    if (message.toolCallId !== undefined) total += TOOL_CALL_OVERHEAD_TOKENS + Buffer.byteLength(message.toolCallId, 'utf8');
  }
  if (tools && tools.length > 0) {
    total += TOOLS_OVERHEAD_TOKENS;
    for (const tool of tools) total += TOOL_OVERHEAD_TOKENS + toolDefinitionBytes(tool);
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

/** 工具调用的本地估算（名称与 arguments 按文本估算，另加每次调用的固定开销）。 */
function estimateToolCallTokens(calls: readonly ChatToolCall[] | undefined): number {
  if (!calls) return 0;
  return calls.reduce((total, call) => total + 8 + estimateTokens(call.id) + estimateTokens(call.name) + estimateTokens(call.arguments), 0);
}

export function estimateInputTokens(messages: readonly ChatMessage[], tools?: readonly ChatTool[]): number {
  let total = messages.reduce(
    (sum, message) => sum + 4 + estimateTokens(message.content) + estimateToolCallTokens(message.toolCalls) + (message.toolCallId !== undefined ? 8 : 0),
    3,
  );
  for (const tool of tools ?? []) total += 16 + estimateTokens(tool.name) + estimateTokens(tool.description ?? '') + estimateTokens(JSON.stringify(tool.parameters));
  return total;
}

/** 输出的本地估算：文字、思考内容与工具调用。 */
export function estimateOutputTokens(content: string, reasoningContent: string, toolCalls?: readonly ChatToolCall[]): number {
  return estimateTokens(content) + estimateTokens(reasoningContent) + estimateToolCallTokens(toolCalls);
}
