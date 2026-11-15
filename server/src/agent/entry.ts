// agent 沙箱入口的 worker 一侧（路线图第 8 步 8.6a；docs/SERVER_DESIGN.md 第 7.22 节）：按协议编码请求、经 sandbox-runner 执行模板的
// run 命令（请求经标准输入传入），并按**不可信输入**解析入口写到标准输出的结果。沙箱内的协议实现见 server/sandbox/agent/protocol.mjs。
//
// - 请求只经标准输入：任务令牌不出现在 argv、容器环境、sandbox-runner 与 worker 的日志中（SandboxExecOptions.input 不写日志）；
// - 结果必须是恰好一行 JSON（以换行结束）、未被截断，字段与取值按登记的形状逐项检查，退出码与 ok 一致（0 ↔ ok，1 ↔ 失败）；
//   超时、被终止、其他退出码、多出的输出、形状不符一律 AGENT_ENTRY_FAILED（JobError，说明固定，不含入口的输出）；
// - 入口按协议报告的失败（令牌无效、连不上平台入口等）作为结果返回，由调用方决定如何处理（8.6d 的执行流程）。
//
// 两种请求：session（8.6a，确认令牌有效、取到期时间）与 prompt（8.6b，在 Pi 会话中执行一条提示词，返回会话文件名、轮数与结束原因）。
// prompt 的结果只说明入口按协议走完了：Agent 写了什么、会话中有什么，都由 worker 从工作区取回后按不可信内容处理（8.6d）；
// 入口报告的 MODEL_FAILED 不区分原因（令牌失效、任务上限、余额不足等），原因由调用方按任务状态判断，不采信沙箱的说法。
import { isWellFormedAgentToken } from './token.ts';
import { JobError } from '../jobs/definitions.ts';
import type { SandboxDriver, SandboxExecResult, SandboxOperationOptions, SandboxRef } from '../sandbox/driver.ts';
import { AGENT_ENTRY_COMMAND, AGENT_ENTRY_MAX_INPUT_BYTES } from '../sandbox/templates.ts';

export const AGENT_ENTRY_PROTOCOL_VERSION = 1;
/** 入口的结果至多这么多字节（与 protocol.mjs 的 MAX_RESULT_BYTES 相同）。 */
export const AGENT_ENTRY_MAX_RESULT_BYTES = 16 * 1024;
export const AGENT_ENTRY_FAILED_CODE = 'AGENT_ENTRY_FAILED';
const AGENT_ENTRY_FAILED_MESSAGE = 'Agent 入口执行失败';

/** 入口按协议报告的失败代码（protocol.mjs 的 ENTRY_ERROR_MESSAGES）。 */
export const AGENT_ENTRY_ERROR_CODES = [
  'BAD_REQUEST',
  'TOKEN_INVALID',
  'GATEWAY_UNAVAILABLE',
  'GATEWAY_FAILED',
  'SESSION_INVALID',
  'TURN_LIMIT',
  'MODEL_FAILED',
  'INTERNAL',
] as const;
export type AgentEntryErrorCode = (typeof AGENT_ENTRY_ERROR_CODES)[number];

/** Pi 原生工具（与 protocol.mjs 的 NATIVE_TOOLS 相同）：prompt 请求的 tools 只能从中选。 */
export const AGENT_NATIVE_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'] as const;
export type AgentNativeTool = (typeof AGENT_NATIVE_TOOLS)[number];
/** 与 protocol.mjs 相同的上限（两侧各自检查）。 */
export const AGENT_PROMPT_MAX_CHARS = 256 * 1024;
export const AGENT_MAX_TURNS_PER_PROMPT = 1_000;
export const AGENT_CONTEXT_WINDOW_RANGE = { min: 8_192, max: 2_000_000 } as const;
export const AGENT_MAX_OUTPUT_TOKENS_RANGE = { min: 256, max: 131_072 } as const;
/** Pi 的会话文件名（与 protocol.mjs 的 SESSION_FILE_PATTERN 相同），位于工作区的 pi-sessions/ 中。 */
export const AGENT_SESSION_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export interface AgentSessionRequest {
  action: 'session';
  token: string;
}
export interface AgentPromptRequest {
  action: 'prompt';
  token: string;
  /** 一条提示词。 */
  prompt: string;
  /** 续接的会话文件名（工作区 pi-sessions/ 中）；null 新建会话。 */
  session: string | null;
  /** 启用的 Pi 原生工具。 */
  tools: readonly AgentNativeTool[];
  /** 本条提示词之内至多的轮数（桌面版 max_turns_per_prompt）。 */
  maxTurns: number;
  /** 组织选用的模型的上下文长度与输出上限。 */
  model: { contextWindow: number; maxOutputTokens: number };
}
export type AgentEntryRequest = AgentSessionRequest | AgentPromptRequest;

export type AgentEntryResult =
  | { ok: true; action: 'session'; expiresAt: Date }
  | { ok: true; action: 'prompt'; session: string; turns: number; stopReason: 'stop' | 'length' }
  | { ok: false; code: AgentEntryErrorCode };

const isIntegerIn = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= range.min && value <= range.max;

function promptFields(request: AgentPromptRequest): Record<string, unknown> {
  const { prompt, session, tools, maxTurns, model } = request;
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > AGENT_PROMPT_MAX_CHARS) throw new TypeError('invalid agent prompt');
  if (session !== null && !AGENT_SESSION_FILE_PATTERN.test(session)) throw new TypeError('invalid agent session file');
  if (new Set(tools).size !== tools.length || !tools.every((tool) => (AGENT_NATIVE_TOOLS as readonly string[]).includes(tool))) throw new TypeError('invalid agent tools');
  if (!isIntegerIn(maxTurns, { min: 1, max: AGENT_MAX_TURNS_PER_PROMPT })) throw new TypeError('invalid agent max turns');
  if (!isIntegerIn(model.contextWindow, AGENT_CONTEXT_WINDOW_RANGE) || !isIntegerIn(model.maxOutputTokens, AGENT_MAX_OUTPUT_TOKENS_RANGE) || model.maxOutputTokens > model.contextWindow) {
    throw new TypeError('invalid agent model limits');
  }
  return { prompt, session, tools: [...tools], maxTurns, model: { contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens } };
}

/** 编码请求：令牌格式不对、字段不合法、超过上限时抛 TypeError（调用方的错误，不执行）。 */
export function encodeAgentEntryRequest(request: AgentEntryRequest): Buffer {
  if (request.action !== 'session' && request.action !== 'prompt') throw new TypeError('unknown agent entry action');
  if (!isWellFormedAgentToken(request.token)) throw new TypeError('invalid agent token');
  const body = { version: AGENT_ENTRY_PROTOCOL_VERSION, action: request.action, token: request.token, ...(request.action === 'prompt' ? promptFields(request) : {}) };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8');
  if (encoded.length > AGENT_ENTRY_MAX_INPUT_BYTES) throw new TypeError('agent entry request too large');
  return encoded;
}

function entryFailed(reason: string): JobError {
  return new JobError(AGENT_ENTRY_FAILED_CODE, AGENT_ENTRY_FAILED_MESSAGE, { cause: new Error(reason) });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 解析入口的执行结果；expected 给出时，成功结果的 action 必须与请求相同、prompt 的轮数不超过请求的上限。不符合协议时抛 AGENT_ENTRY_FAILED（cause 写明哪一项不符，只进日志）；入口按协议报告的失败作为结果返回。
 * 标准输出来自沙箱：不采信其中的任何其他内容，也不把它写进错误说明。
 */
export function parseAgentEntryResult(exec: SandboxExecResult, expected?: { action: AgentEntryRequest['action']; maxTurns?: number }): AgentEntryResult {
  const maxTurns = expected?.maxTurns;
  const expectedAction = expected?.action;
  if (exec.timedOut) throw entryFailed('entry timed out');
  if (exec.exitCode !== 0 && exec.exitCode !== 1) throw entryFailed(`entry exited with ${String(exec.exitCode)}`);
  if (exec.stdoutTruncated || Buffer.byteLength(exec.stdout, 'utf8') > AGENT_ENTRY_MAX_RESULT_BYTES) throw entryFailed('entry result too large');
  if (!exec.stdout.endsWith('\n') || exec.stdout.indexOf('\n') !== exec.stdout.length - 1) throw entryFailed('entry result is not exactly one line');
  let value: unknown;
  try {
    value = JSON.parse(exec.stdout);
  } catch {
    throw entryFailed('entry result is not json');
  }
  if (!isPlainObject(value) || value.version !== AGENT_ENTRY_PROTOCOL_VERSION) throw entryFailed('entry result version mismatch');
  if (value.ok === true) {
    if (exec.exitCode !== 0) throw entryFailed('entry reported success with a failing exit code');
    if (expectedAction !== undefined && value.action !== expectedAction) throw entryFailed('entry result action mismatch');
    if (value.action === 'session') {
      if (!hasExactKeys(value, ['version', 'ok', 'action', 'expiresAt'])) throw entryFailed('entry result shape mismatch');
      const expiresAt = typeof value.expiresAt === 'string' && ISO_INSTANT_PATTERN.test(value.expiresAt) ? new Date(value.expiresAt) : null;
      if (!expiresAt || Number.isNaN(expiresAt.getTime())) throw entryFailed('entry result expiresAt invalid');
      return { ok: true, action: 'session', expiresAt };
    }
    if (value.action === 'prompt') {
      if (!hasExactKeys(value, ['version', 'ok', 'action', 'session', 'turns', 'stopReason'])) throw entryFailed('entry result shape mismatch');
      if (typeof value.session !== 'string' || !AGENT_SESSION_FILE_PATTERN.test(value.session)) throw entryFailed('entry result session invalid');
      // 轮数只是入口的统计（平台另按令牌计数，8.3a）：至少 1 轮，至多本条提示词的上限。
      if (!isIntegerIn(value.turns, { min: 1, max: maxTurns ?? AGENT_MAX_TURNS_PER_PROMPT })) throw entryFailed('entry result turns invalid');
      if (value.stopReason !== 'stop' && value.stopReason !== 'length') throw entryFailed('entry result stopReason invalid');
      return { ok: true, action: 'prompt', session: value.session, turns: value.turns, stopReason: value.stopReason };
    }
    throw entryFailed('entry result action invalid');
  }
  if (value.ok === false) {
    if (exec.exitCode !== 1) throw entryFailed('entry reported failure with exit code 0');
    if (!hasExactKeys(value, ['version', 'ok', 'error']) || !isPlainObject(value.error) || !hasExactKeys(value.error, ['code', 'message'])) {
      throw entryFailed('entry error shape mismatch');
    }
    const code = value.error.code;
    if (typeof code !== 'string' || !(AGENT_ENTRY_ERROR_CODES as readonly string[]).includes(code) || typeof value.error.message !== 'string') {
      throw entryFailed('entry error code invalid');
    }
    return { ok: false, code: code as AgentEntryErrorCode };
  }
  throw entryFailed('entry result ok flag invalid');
}

/** 执行一次入口（模板的 run 命令，请求经标准输入传入）并解析结果。沙箱操作失败时照常抛 SandboxError。 */
export async function runAgentEntry(
  driver: Pick<SandboxDriver, 'exec'>,
  sandbox: SandboxRef,
  request: AgentEntryRequest,
  options: SandboxOperationOptions = {},
): Promise<AgentEntryResult> {
  const input = encodeAgentEntryRequest(request);
  const exec = await driver.exec(sandbox, AGENT_ENTRY_COMMAND, [], { ...options, input });
  return parseAgentEntryResult(exec, request.action === 'prompt' ? { action: 'prompt', maxTurns: request.maxTurns } : { action: 'session' });
}
