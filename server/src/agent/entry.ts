// agent 沙箱入口的 worker 一侧（路线图第 8 步 8.6a；docs/SERVER_DESIGN.md 第 7.22 节）：按协议编码请求、经 sandbox-runner 执行模板的
// run 命令（请求经标准输入传入），并按**不可信输入**解析入口写到标准输出的结果。沙箱内的协议实现见 server/sandbox/agent/protocol.mjs。
//
// - 请求只经标准输入：任务令牌不出现在 argv、容器环境、sandbox-runner 与 worker 的日志中（SandboxExecOptions.input 不写日志）；
// - 结果必须是恰好一行 JSON（以换行结束）、未被截断，字段与取值按登记的形状逐项检查，退出码与 ok 一致（0 ↔ ok，1 ↔ 失败）；
//   超时、被终止、其他退出码、多出的输出、形状不符一律 AGENT_ENTRY_FAILED（JobError，说明固定，不含入口的输出）；
// - 入口按协议报告的失败（令牌无效、连不上平台入口等）作为结果返回，由调用方决定如何处理（8.6d 的执行流程）。
//
// 请求：session（8.6a，确认令牌有效、取到期时间）、prompt（8.6b，在 Pi 会话中执行一条提示词，返回会话文件名、轮数与结束原因）、
// compact（8.6d2，压缩已有会话的上下文，返回会话文件名与是否真的压缩了）、child-prompt（8.10c3b2，在子会话中执行一条提示词，
// 返回子会话文件名、轮数、结束方式与报告失败的原因）与 remove（8.10c3b2，删除工作区中的文件，返回删除的个数）。Agent 的回复全文不经标准输出（结果至多 16 KiB），
// 由 worker 从工作区的会话文件中取回（src/agent/assistantText.ts）。
// prompt 的结果只说明入口按协议走完了：Agent 写了什么、会话中有什么，都由 worker 从工作区取回后按不可信内容处理（8.6d）；
// 入口报告的 MODEL_FAILED 不区分原因（令牌失效、任务上限、余额不足等），原因由调用方按任务状态判断，不采信沙箱的说法；
// REPORTED_FAILURE（8.6c1，Agent 报告无法继续或用户选择终止）同样只是入口的说法，任务是否失败按 agent_failure_reports（8.4b）判断。
//
// 业务工具（8.6c1）：prompt 请求的 tools 中可以有业务工具（AGENT_BUSINESS_TOOLS），入口为它们登记桩。阶段的限制在 worker 一侧：
// runAgentPrompt 在执行入口之前写下本条提示词可用的业务工具（src/agent/toolScope.ts，迁移 0042），工具调用的计数语句只放行它们。
//
// 本地工具（8.6c2a）：json-validation 在沙箱内执行（#82 决定事项第 3 项），不经 worker、不写进阶段；jsonSchemas 为指定文件预置的
// Schema（只在 json-validation 启用时可以给出），worker 只检查形状、不编译。Agent 的自查结果不被采信，结果提交时另按固定规则校验（8.6d）。
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import { isWellFormedAgentToken } from './token.ts';
import { setAgentToolScope } from './toolScope.ts';
import { JobError } from '../jobs/definitions.ts';
import type { RunRef } from '../jobs/store.ts';
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
  'REPORTED_FAILURE',
  'RUN_ENDED',
  'INTERNAL',
] as const;
export type AgentEntryErrorCode = (typeof AGENT_ENTRY_ERROR_CODES)[number];

/** Pi 原生工具（与 protocol.mjs 的 NATIVE_TOOLS 相同）。 */
export const AGENT_NATIVE_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'] as const;
export type AgentNativeTool = (typeof AGENT_NATIVE_TOOLS)[number];
/** 入口有桩的业务工具（与 protocol.mjs 的 BUSINESS_TOOLS 相同，名字是 src/agent/toolRegistry.ts 中登记的工具名）。 */
export const AGENT_BUSINESS_TOOLS = ['ask-user', 'report-failure', 'request-termination', 'generate-sections', 'check-word-count'] as const;
export type AgentBusinessTool = (typeof AGENT_BUSINESS_TOOLS)[number];
/** 入口在沙箱内执行的本地工具（与 protocol.mjs 的 LOCAL_TOOLS 相同）。 */
export const AGENT_LOCAL_TOOLS = ['json-validation'] as const;
export type AgentLocalTool = (typeof AGENT_LOCAL_TOOLS)[number];
export type AgentPromptTool = AgentNativeTool | AgentLocalTool | AgentBusinessTool;
/** jsonSchemas 的上限与键的规则（与 protocol.mjs 的 MAX_JSON_SCHEMAS、isWorkspaceRelativePath 相同）。 */
export const AGENT_MAX_JSON_SCHEMAS = 32;
const WORKSPACE_PATH_MAX_BYTES = 255;
const WORKSPACE_PATH_MAX_DEPTH = 8;
/** 只能出现其中之一的业务工具（request-termination 面向模型的名字也是 report-failure）。 */
export const AGENT_EXCLUSIVE_PROMPT_TOOLS = [['report-failure', 'request-termination']] as const;
/** 与 protocol.mjs 相同的上限（两侧各自检查）。 */
export const AGENT_PROMPT_MAX_CHARS = 256 * 1024;
/** 压缩指令的上限（与 protocol.mjs 的 MAX_COMPACTION_INSTRUCTIONS_CHARS 相同）。 */
export const AGENT_COMPACTION_INSTRUCTIONS_MAX_CHARS = 16 * 1024;
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
  /** 启用的 Pi 原生工具与业务工具（业务工具的桩经 agent-gw 调用 worker，阶段限制由 runAgentPrompt 写下）。 */
  tools: readonly AgentPromptTool[];
  /** 本条提示词之内至多的轮数（桌面版 max_turns_per_prompt）。 */
  maxTurns: number;
  /** 组织选用的模型的上下文长度与输出上限。 */
  model: { contextWindow: number; maxOutputTokens: number };
  /** json-validation 为指定文件预置的 Schema（工作区相对路径 → JSON Schema）；省略或为空时不预置。 */
  jsonSchemas?: Readonly<Record<string, unknown>>;
}
/** 压缩已有会话的上下文（8.6d2）。 */
export interface AgentCompactRequest {
  action: 'compact';
  token: string;
  /** 续接的会话文件名（工作区 pi-sessions/ 中）。 */
  session: string;
  /** 压缩指令（桌面版 compaction_instructions）。 */
  instructions: string;
  model: { contextWindow: number; maxOutputTokens: number };
}
/** 子会话的墙钟范围与结束方式（与 protocol.mjs 的 CHILD_TIMEOUT_RANGE、CHILD_OUTCOMES 相同，8.10c3b2）。 */
export const AGENT_CHILD_TIMEOUT_RANGE = { min: 1_000, max: 120 * 60_000 } as const;
export const AGENT_CHILD_OUTCOMES = ['stop', 'length', 'reported', 'turn-limit', 'time-limit', 'model-failed'] as const;
export type AgentChildOutcome = (typeof AGENT_CHILD_OUTCOMES)[number];
export const AGENT_CHILD_FAILURE_REASON_MAX_CHARS = 500;
export const AGENT_REMOVE_MAX_PATHS = 256;

/**
 * 在子会话中执行一条提示词（8.10c3b2）：工具只有原生工具（report-failure 由入口在沙箱内登记，原因作为结果返回），
 * 会话文件在工作区之外；不写阶段（迁移 0042 的业务工具范围不变，子会话的清单中没有业务工具）。
 */
export interface AgentChildPromptRequest {
  action: 'child-prompt';
  token: string;
  prompt: string;
  /** 续接的子会话文件名（同一次执行的执行重试）；null 新建。 */
  session: string | null;
  tools: readonly AgentNativeTool[];
  maxTurns: number;
  /** 本条提示词的墙钟（入口执行）。 */
  timeoutMs: number;
  model: { contextWindow: number; maxOutputTokens: number };
}
/** 删除工作区中的文件（8.10c3b2）。 */
export interface AgentRemoveRequest {
  action: 'remove';
  token: string;
  paths: readonly string[];
}
export type AgentEntryRequest = AgentSessionRequest | AgentPromptRequest | AgentCompactRequest | AgentChildPromptRequest | AgentRemoveRequest;

export type AgentEntryResult =
  | { ok: true; action: 'session'; expiresAt: Date }
  | { ok: true; action: 'prompt'; session: string; turns: number; stopReason: 'stop' | 'length' }
  | { ok: true; action: 'compact'; session: string; compacted: boolean }
  | { ok: true; action: 'child-prompt'; session: string | null; turns: number; outcome: AgentChildOutcome; reason: string | null }
  | { ok: true; action: 'remove'; removed: number }
  | { ok: false; code: AgentEntryErrorCode };

const isIntegerIn = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= range.min && value <= range.max;

/** 规范的工作区相对路径（与 protocol.mjs 的 isWorkspaceRelativePath 相同）。 */
export function isAgentWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > WORKSPACE_PATH_MAX_BYTES) return false;
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return false;
  const segments = value.split('/');
  return segments.length <= WORKSPACE_PATH_MAX_DEPTH && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function jsonSchemasField(jsonSchemas: AgentPromptRequest['jsonSchemas'], tools: readonly AgentPromptTool[]): Record<string, unknown> {
  if (jsonSchemas === undefined) return {};
  if (!isPlainObject(jsonSchemas)) throw new TypeError('invalid agent json schemas');
  const entries = Object.entries(jsonSchemas);
  if (entries.length === 0) return {};
  if (!tools.includes('json-validation') || entries.length > AGENT_MAX_JSON_SCHEMAS) throw new TypeError('invalid agent json schemas');
  for (const [path, schema] of entries) {
    if (!isAgentWorkspaceRelativePath(path) || (typeof schema !== 'boolean' && !isPlainObject(schema))) throw new TypeError('invalid agent json schemas');
  }
  return { jsonSchemas: Object.fromEntries(entries) };
}

function modelField(model: AgentPromptRequest['model']): AgentPromptRequest['model'] {
  if (!isIntegerIn(model.contextWindow, AGENT_CONTEXT_WINDOW_RANGE) || !isIntegerIn(model.maxOutputTokens, AGENT_MAX_OUTPUT_TOKENS_RANGE) || model.maxOutputTokens > model.contextWindow) {
    throw new TypeError('invalid agent model limits');
  }
  return { contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens };
}

function compactFields(request: AgentCompactRequest): Record<string, unknown> {
  const { session, instructions, model } = request;
  if (typeof session !== 'string' || !AGENT_SESSION_FILE_PATTERN.test(session)) throw new TypeError('invalid agent session file');
  if (typeof instructions !== 'string' || instructions.trim() === '' || instructions.length > AGENT_COMPACTION_INSTRUCTIONS_MAX_CHARS) {
    throw new TypeError('invalid agent compaction instructions');
  }
  return { session, instructions, model: modelField(model) };
}

function promptFields(request: AgentPromptRequest): Record<string, unknown> {
  const { prompt, session, tools, maxTurns, model, jsonSchemas } = request;
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > AGENT_PROMPT_MAX_CHARS) throw new TypeError('invalid agent prompt');
  if (session !== null && !AGENT_SESSION_FILE_PATTERN.test(session)) throw new TypeError('invalid agent session file');
  const known: readonly string[] = [...AGENT_NATIVE_TOOLS, ...AGENT_LOCAL_TOOLS, ...AGENT_BUSINESS_TOOLS];
  if (new Set(tools).size !== tools.length || !tools.every((tool) => known.includes(tool))) throw new TypeError('invalid agent tools');
  if (AGENT_EXCLUSIVE_PROMPT_TOOLS.some((group) => group.filter((name) => tools.includes(name)).length > 1)) throw new TypeError('invalid agent tools');
  if (!isIntegerIn(maxTurns, { min: 1, max: AGENT_MAX_TURNS_PER_PROMPT })) throw new TypeError('invalid agent max turns');
  const limits = modelField(model);
  return {
    prompt,
    session,
    tools: [...tools],
    maxTurns,
    model: limits,
    ...jsonSchemasField(jsonSchemas, tools),
  };
}

function childPromptFields(request: AgentChildPromptRequest): Record<string, unknown> {
  const { prompt, session, tools, maxTurns, timeoutMs, model } = request;
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > AGENT_PROMPT_MAX_CHARS) throw new TypeError('invalid agent prompt');
  if (session !== null && !AGENT_SESSION_FILE_PATTERN.test(session)) throw new TypeError('invalid agent session file');
  const native: readonly string[] = AGENT_NATIVE_TOOLS;
  if (!Array.isArray(tools) || new Set(tools).size !== tools.length || !tools.every((tool) => native.includes(tool))) throw new TypeError('invalid agent child tools');
  if (!isIntegerIn(maxTurns, { min: 1, max: AGENT_MAX_TURNS_PER_PROMPT })) throw new TypeError('invalid agent max turns');
  if (!isIntegerIn(timeoutMs, AGENT_CHILD_TIMEOUT_RANGE)) throw new TypeError('invalid agent child timeout');
  return { prompt, session, tools: [...tools], maxTurns, timeoutMs, model: modelField(model) };
}

function removeFields(request: AgentRemoveRequest): Record<string, unknown> {
  const { paths } = request;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > AGENT_REMOVE_MAX_PATHS || new Set(paths).size !== paths.length) throw new TypeError('invalid agent remove paths');
  if (!paths.every(isAgentWorkspaceRelativePath)) throw new TypeError('invalid agent remove paths');
  return { paths: [...paths] };
}

const REQUEST_FIELDS: { [A in AgentEntryRequest['action']]: (request: Extract<AgentEntryRequest, { action: A }>) => Record<string, unknown> } = {
  session: () => ({}),
  prompt: promptFields,
  compact: compactFields,
  'child-prompt': childPromptFields,
  remove: removeFields,
};

/** 编码请求：令牌格式不对、字段不合法、超过上限时抛 TypeError（调用方的错误，不执行）。 */
export function encodeAgentEntryRequest(request: AgentEntryRequest): Buffer {
  if (!Object.hasOwn(REQUEST_FIELDS, request.action)) throw new TypeError('unknown agent entry action');
  if (!isWellFormedAgentToken(request.token)) throw new TypeError('invalid agent token');
  const fields = (REQUEST_FIELDS[request.action] as (value: AgentEntryRequest) => Record<string, unknown>)(request);
  const body = { version: AGENT_ENTRY_PROTOCOL_VERSION, action: request.action, token: request.token, ...fields };
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
 * 解析入口的执行结果；expected 给出时，成功结果的 action 必须与请求相同、prompt 的轮数不超过请求的上限、compact 的会话文件名与请求相同。不符合协议时抛 AGENT_ENTRY_FAILED（cause 写明哪一项不符，只进日志）；入口按协议报告的失败作为结果返回。
 * 标准输出来自沙箱：不采信其中的任何其他内容，也不把它写进错误说明。
 */
export function parseAgentEntryResult(
  exec: SandboxExecResult,
  expected?: { action: AgentEntryRequest['action']; maxTurns?: number; session?: string | null; paths?: number },
): AgentEntryResult {
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
    if (value.action === 'compact') {
      if (!hasExactKeys(value, ['version', 'ok', 'action', 'session', 'compacted'])) throw entryFailed('entry result shape mismatch');
      if (typeof value.session !== 'string' || !AGENT_SESSION_FILE_PATTERN.test(value.session)) throw entryFailed('entry result session invalid');
      // 压缩追加到同一个会话文件：文件名必须与请求相同。
      if (expected?.session !== undefined && value.session !== expected.session) throw entryFailed('entry result session mismatch');
      if (typeof value.compacted !== 'boolean') throw entryFailed('entry result compacted invalid');
      return { ok: true, action: 'compact', session: value.session, compacted: value.compacted };
    }
    if (value.action === 'child-prompt') {
      if (!hasExactKeys(value, ['version', 'ok', 'action', 'session', 'turns', 'outcome', 'reason'])) throw entryFailed('entry result shape mismatch');
      if (value.session !== null && (typeof value.session !== 'string' || !AGENT_SESSION_FILE_PATTERN.test(value.session))) throw entryFailed('entry result session invalid');
      // 续接的子会话：文件名不变（Pi 追加到同一个文件）。
      if (typeof expected?.session === 'string' && value.session !== null && value.session !== expected.session) throw entryFailed('entry result session mismatch');
      if (!isIntegerIn(value.turns, { min: 0, max: maxTurns ?? AGENT_MAX_TURNS_PER_PROMPT })) throw entryFailed('entry result turns invalid');
      if (typeof value.outcome !== 'string' || !(AGENT_CHILD_OUTCOMES as readonly string[]).includes(value.outcome)) throw entryFailed('entry result outcome invalid');
      const outcome = value.outcome as AgentChildOutcome;
      if (outcome === 'reported') {
        if (typeof value.reason !== 'string' || value.reason.trim() === '' || Array.from(value.reason).length > AGENT_CHILD_FAILURE_REASON_MAX_CHARS) throw entryFailed('entry result reason invalid');
      } else if (value.reason !== null) {
        throw entryFailed('entry result reason invalid');
      }
      return { ok: true, action: 'child-prompt', session: value.session as string | null, turns: value.turns as number, outcome, reason: value.reason as string | null };
    }
    if (value.action === 'remove') {
      if (!hasExactKeys(value, ['version', 'ok', 'action', 'removed'])) throw entryFailed('entry result shape mismatch');
      if (!isIntegerIn(value.removed, { min: 0, max: expected?.paths ?? AGENT_REMOVE_MAX_PATHS })) throw entryFailed('entry result removed invalid');
      return { ok: true, action: 'remove', removed: value.removed as number };
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
  return parseAgentEntryResult(exec, expectedResult(request));
}

function expectedResult(request: AgentEntryRequest): NonNullable<Parameters<typeof parseAgentEntryResult>[1]> {
  switch (request.action) {
    case 'prompt':
      return { action: 'prompt', maxTurns: request.maxTurns };
    case 'compact':
      return { action: 'compact', session: request.session };
    case 'child-prompt':
      return { action: 'child-prompt', maxTurns: request.maxTurns, session: request.session };
    case 'remove':
      return { action: 'remove', paths: request.paths.length };
    case 'session':
      return { action: 'session' };
  }
}

/** 请求中的业务工具（worker 一侧的工具名）。 */
export function agentPromptBusinessTools(tools: readonly AgentPromptTool[]): AgentBusinessTool[] {
  return tools.filter((name): name is AgentBusinessTool => (AGENT_BUSINESS_TOOLS as readonly string[]).includes(name));
}

/**
 * 执行一条提示词：先写下本条提示词可用的业务工具（本阶段，迁移 0042；allowedTools 为任务类型登记的 agentTools，请求中的业务工具
 * 必须是它的子集，否则抛 TypeError），再执行入口。任务已不在本次执行中（写不进阶段）时不执行入口，返回 RUN_ENDED。
 */
export async function runAgentPrompt(
  db: Kysely<Database>,
  driver: Pick<SandboxDriver, 'exec'>,
  sandbox: SandboxRef,
  run: RunRef,
  request: AgentPromptRequest,
  allowedTools: readonly string[],
  options: SandboxOperationOptions = {},
): Promise<AgentEntryResult> {
  // 先检查请求（不合法时不写阶段）。
  encodeAgentEntryRequest(request);
  if (!(await setAgentToolScope(db, run, agentPromptBusinessTools(request.tools), allowedTools))) return { ok: false, code: 'RUN_ENDED' };
  return runAgentEntry(driver, sandbox, request, options);
}

/**
 * 压缩会话的上下文（8.6d2）：先把本阶段可用的业务工具清空（压缩不调用工具，迁移 0042），再执行入口。任务已不在本次执行中时
 * 不执行入口，返回 RUN_ENDED。
 */
export async function runAgentCompaction(
  db: Kysely<Database>,
  driver: Pick<SandboxDriver, 'exec'>,
  sandbox: SandboxRef,
  run: RunRef,
  request: AgentCompactRequest,
  allowedTools: readonly string[],
  options: SandboxOperationOptions = {},
): Promise<AgentEntryResult> {
  encodeAgentEntryRequest(request);
  if (!(await setAgentToolScope(db, run, [], allowedTools))) return { ok: false, code: 'RUN_ENDED' };
  return runAgentEntry(driver, sandbox, request, options);
}

/**
 * 在子会话中执行一条提示词（8.10c3b2）：不写阶段（子会话没有业务工具，主会话的范围保持不变），直接执行入口。
 * 报告失败的原因（reason）来自沙箱，按不可信的纯文本处理（调用方只把它交回同一个 Agent）。
 */
export function runAgentChildPrompt(
  driver: Pick<SandboxDriver, 'exec'>,
  sandbox: SandboxRef,
  request: AgentChildPromptRequest,
  options: SandboxOperationOptions = {},
): Promise<AgentEntryResult> {
  return runAgentEntry(driver, sandbox, request, options);
}

/** 删除工作区中的文件（8.10c3b2）。 */
export function runAgentRemove(
  driver: Pick<SandboxDriver, 'exec'>,
  sandbox: SandboxRef,
  request: AgentRemoveRequest,
  options: SandboxOperationOptions = {},
): Promise<AgentEntryResult> {
  return runAgentEntry(driver, sandbox, request, options);
}
