// agent 沙箱入口的 worker 一侧（路线图第 8 步 8.6a；docs/SERVER_DESIGN.md 第 7.22 节）：按协议编码请求、经 sandbox-runner 执行模板的
// run 命令（请求经标准输入传入），并按**不可信输入**解析入口写到标准输出的结果。沙箱内的协议实现见 server/sandbox/agent/protocol.mjs。
//
// - 请求只经标准输入：任务令牌不出现在 argv、容器环境、sandbox-runner 与 worker 的日志中（SandboxExecOptions.input 不写日志）；
// - 结果必须是恰好一行 JSON（以换行结束）、未被截断，字段与取值按登记的形状逐项检查，退出码与 ok 一致（0 ↔ ok，1 ↔ 失败）；
//   超时、被终止、其他退出码、多出的输出、形状不符一律 AGENT_ENTRY_FAILED（JobError，说明固定，不含入口的输出）；
// - 入口按协议报告的失败（令牌无效、连不上平台入口等）作为结果返回，由调用方决定如何处理（8.6d 的执行流程）。
//
// 8.6a 只有 action = session（确认令牌有效、取到期时间）；Pi 会话（prompt）随 8.6b 加入同一协议。
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
export const AGENT_ENTRY_ERROR_CODES = ['BAD_REQUEST', 'TOKEN_INVALID', 'GATEWAY_UNAVAILABLE', 'GATEWAY_FAILED', 'INTERNAL'] as const;
export type AgentEntryErrorCode = (typeof AGENT_ENTRY_ERROR_CODES)[number];

export interface AgentSessionRequest {
  action: 'session';
  token: string;
}
export type AgentEntryRequest = AgentSessionRequest;

export type AgentEntryResult = { ok: true; action: 'session'; expiresAt: Date } | { ok: false; code: AgentEntryErrorCode };

/** 编码请求：令牌格式不对、超过上限时抛 TypeError（调用方的错误，不执行）。 */
export function encodeAgentEntryRequest(request: AgentEntryRequest): Buffer {
  if (request.action !== 'session') throw new TypeError('unknown agent entry action');
  if (!isWellFormedAgentToken(request.token)) throw new TypeError('invalid agent token');
  const encoded = Buffer.from(JSON.stringify({ version: AGENT_ENTRY_PROTOCOL_VERSION, action: request.action, token: request.token }), 'utf8');
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
 * 解析入口的执行结果。不符合协议时抛 AGENT_ENTRY_FAILED（cause 写明哪一项不符，只进日志）；入口按协议报告的失败作为结果返回。
 * 标准输出来自沙箱：不采信其中的任何其他内容，也不把它写进错误说明。
 */
export function parseAgentEntryResult(exec: SandboxExecResult): AgentEntryResult {
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
    if (!hasExactKeys(value, ['version', 'ok', 'action', 'expiresAt']) || value.action !== 'session') throw entryFailed('entry result shape mismatch');
    const expiresAt = typeof value.expiresAt === 'string' && ISO_INSTANT_PATTERN.test(value.expiresAt) ? new Date(value.expiresAt) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime())) throw entryFailed('entry result expiresAt invalid');
    return { ok: true, action: 'session', expiresAt };
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
  return parseAgentEntryResult(exec);
}
