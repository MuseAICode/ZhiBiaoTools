// Agent 回复全文的取回（路线图第 8 步 8.6d2；docs/SERVER_DESIGN.md 第 7.28 节）。
//
// 入口的结果只有一行、至多 16 KiB（8.6a），Agent 的回复不经标准输出：worker 经 readFiles 从工作区读出 Pi 的会话文件
// （pi-sessions/<会话>.jsonl），取最后一条 assistant 消息中的文本（与桌面版 piRuntimeService 的 extractAssistantText 相同：
// 文本段按换行连接、去掉首尾空白）。目录调整、全局事实调整等任务用它作为给用户看的说明（桌面版 assistant_text）。
//
// 会话文件在工作区中，Agent 的命令可以任意改写它，内容按**不可信数据**处理：
// - 严格 UTF-8、每个非空行恰好是一个 JSON 对象，否则整个文件不可用（返回 null，由任务用固定的说明代替）；
// - 只认 Pi 的消息条目（type = message、message.role = assistant、content 为数组、文本段的 text 为字符串），其余条目跳过；
// - 结果去掉控制字符（保留换行与制表符）与孤立的代理项，按字符数截断（不拆开代理对）；
// - 文本只是 AI 生成的内容：给用户显示时与其他 AI 内容一样按 Markdown 渲染、不允许原始 HTML（第 9 步的审阅提醒另行处理），
//   不进日志与失败说明。

/** 取回的回复至多这么多字符（桌面版不限；目录调整等的说明一般只有几百个字符）。 */
export const AGENT_ASSISTANT_TEXT_MAX_CHARS = 64 * 1024;
/** 调用方可以给出的上限范围。 */
export const AGENT_ASSISTANT_TEXT_MAX_CHARS_LIMIT = 256 * 1024;
/** 会话文件超过这么多字节时不读取（返回 null）。 */
export const AGENT_SESSION_FILE_READ_MAX_BYTES = 16 * 1024 * 1024;

export interface AgentAssistantText {
  readonly text: string;
  /** 超过上限、已截断。 */
  readonly truncated: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** 去掉控制字符（保留 \n 与 \t，\r\n 与单独的 \r 换成 \n）与孤立的代理项。 */
function sanitize(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu, '');
}

/** 按 UTF-16 长度截断，不拆开代理对。 */
function truncate(text: string, maxChars: number): AgentAssistantText {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/** 检查调用方给出的字符上限（省略时为 AGENT_ASSISTANT_TEXT_MAX_CHARS），不合法时抛 TypeError。 */
export function agentAssistantTextLimit(maxChars: number = AGENT_ASSISTANT_TEXT_MAX_CHARS): number {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > AGENT_ASSISTANT_TEXT_MAX_CHARS_LIMIT) throw new TypeError('回复的字符上限不合法');
  return maxChars;
}

/**
 * 从会话文件的内容中取最后一条 assistant 消息的文本。文件不是合法的 JSONL（严格 UTF-8、每个非空行一个 JSON 对象）、
 * 没有 assistant 消息时返回 null；最后一条 assistant 消息没有文本时返回空字符串。
 */
export function extractAgentAssistantText(data: Buffer, maxChars?: number): AgentAssistantText | null {
  const limit = agentAssistantTextLimit(maxChars);
  if (data.length > AGENT_SESSION_FILE_READ_MAX_BYTES) return null;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return null;
  }
  let last: unknown[] | null = null;
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isPlainObject(entry)) return null;
    if (entry.type !== 'message' || !isPlainObject(entry.message) || entry.message.role !== 'assistant') continue;
    last = Array.isArray(entry.message.content) ? entry.message.content : [];
  }
  if (last === null) return null;
  const text = last
    .filter((part): part is { type: 'text'; text: string } => isPlainObject(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  return truncate(sanitize(text).trim(), limit);
}
