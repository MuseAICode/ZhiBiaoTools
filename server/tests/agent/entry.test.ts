// agent 沙箱入口的协议（路线图第 8 步 8.6a、8.6b）：
// - 沙箱内（server/sandbox/agent/protocol.mjs）：请求的严格解析（大小、UTF-8、字段、令牌格式），经 agent-gw 的 GET /v1/session
//   确认令牌（只带 Authorization、不跟随重定向，401 / 其他状态 / 超大或不合法的响应 / 连不上 / 超时各自的代码），结果恰好一行、
//   失败只有固定的说明，任何输出中都没有令牌；
// - worker 一侧（src/agent/entry.ts）：请求只经标准输入（不在参数中），结果按不可信输入逐项检查，不符一律 AGENT_ENTRY_FAILED；
// - 两侧对同一份结果的理解一致：protocol.mjs 写出的每一种结果，entry.ts 都按同样的意思解析；
// - prompt 请求（8.6b）：字段恰好是登记的那几个、取值在范围内，先确认令牌再交给 Pi 会话（这里用桩代替 pi.mjs），Pi 会话抛出的
//   其他异常一律 INTERNAL、不带出说明；worker 一侧的编码与结果检查（会话文件名、轮数不超过请求的上限、结束原因）。
// 真实的 Pi 会话（pi.mjs）经真实的模型调用路由见 tests/agent/piSession.test.ts；真实沙箱中经 /etc/hosts 中的 agent-gw 访问、令牌不出现在进程的环境与参数中，见 tests/sandbox/docker/agentEntry.test.ts。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_WINDOW_RANGE,
  ENTRY_ERROR_MESSAGES,
  EntryError,
  formatResult,
  GATEWAY_BASE_URL,
  MAX_REQUEST_BYTES,
  MAX_OUTPUT_TOKENS_RANGE,
  MAX_PROMPT_CHARS,
  MAX_RESULT_BYTES,
  MAX_TURNS_PER_PROMPT,
  NATIVE_TOOLS,
  parseRequest,
  type PromptRequest,
  type RunPrompt,
  SESSION_FILE_PATTERN,
  querySession,
  readRequest,
  runEntry,
} from '../../sandbox/agent/protocol.mjs';
import {
  AGENT_CONTEXT_WINDOW_RANGE,
  AGENT_ENTRY_ERROR_CODES,
  AGENT_ENTRY_MAX_RESULT_BYTES,
  AGENT_MAX_OUTPUT_TOKENS_RANGE,
  AGENT_MAX_TURNS_PER_PROMPT,
  AGENT_NATIVE_TOOLS,
  AGENT_PROMPT_MAX_CHARS,
  AGENT_SESSION_FILE_PATTERN,
  type AgentPromptRequest,
  encodeAgentEntryRequest,
  parseAgentEntryResult,
  runAgentEntry,
} from '../../src/agent/entry.ts';
import { generateAgentToken } from '../../src/agent/token.ts';
import { JobError } from '../../src/jobs/definitions.ts';
import type { SandboxExecResult, SandboxRef } from '../../src/sandbox/driver.ts';
import { AGENT_ENTRY_MAX_INPUT_BYTES, AGENT_GATEWAY_HOSTNAME, AGENT_GATEWAY_PORT } from '../../src/sandbox/templates.ts';

const TOKEN = generateAgentToken();
const EXPIRES = '2026-11-15T12:30:00.000Z';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** agent-gw 的桩：记录收到的请求（方法、路径、头部），按当前的 handler 回答。 */
let server: Server;
let baseUrl: string;
let handler: Handler;
const received: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      handler(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const active: Handler = (_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status: 'active', expiresAt: EXPIRES }));
};
beforeEach(() => {
  received.length = 0;
  handler = active;
});

const request = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const valid = { version: 1, action: 'session', token: TOKEN };

/** 收集写到 stdout 的内容。 */
function sink() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function run(stdin: Buffer | Readable, options: { baseUrl?: string; timeoutMs?: number; runPrompt?: RunPrompt } = {}) {
  const stdout = sink();
  const exitCode = await runEntry({
    stdin: Buffer.isBuffer(stdin) ? Readable.from([stdin]) : stdin,
    stdout: stdout.stream,
    baseUrl: options.baseUrl ?? baseUrl,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.runPrompt ? { runPrompt: options.runPrompt } : {}),
  });
  return { exitCode, stdout: stdout.text() };
}

/** 入口的输出当作一次 exec 的结果，交给 worker 一侧解析。 */
const asExec = (result: { exitCode: number; stdout: string }): SandboxExecResult => ({
  exitCode: result.exitCode,
  timedOut: false,
  stdout: result.stdout,
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
});

describe('沙箱内的入口协议（protocol.mjs）', () => {
  it('与模板的上限、agent-gw 的地址一致', () => {
    expect(MAX_REQUEST_BYTES).toBe(AGENT_ENTRY_MAX_INPUT_BYTES);
    expect(MAX_RESULT_BYTES).toBe(AGENT_ENTRY_MAX_RESULT_BYTES);
    expect(GATEWAY_BASE_URL).toBe(`http://${AGENT_GATEWAY_HOSTNAME}:${AGENT_GATEWAY_PORT}`);
  });

  it('确认令牌：只发 GET /v1/session，令牌只在 Authorization 中；结果恰好一行，不含令牌', async () => {
    const result = await run(request(valid));
    expect(result).toEqual({ exitCode: 0, stdout: `${JSON.stringify({ version: 1, ok: true, action: 'session', expiresAt: EXPIRES })}\n` });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'GET', url: '/v1/session', body: '' });
    expect(received[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify({ ...received[0]!.headers, authorization: undefined })).not.toContain(TOKEN);
    expect(result.stdout).not.toContain(TOKEN);
    expect(parseAgentEntryResult(asExec(result))).toEqual({ ok: true, action: 'session', expiresAt: new Date(EXPIRES) });
  });

  it.each<[string, Buffer]>([
    ['空请求（没有接上标准输入）', Buffer.alloc(0)],
    ['不是 JSON', request('session')],
    ['JSON 数组', request([valid])],
    ['JSON 字符串', request(JSON.stringify(JSON.stringify(valid)))],
    ['null', request('null')],
    ['非法 UTF-8', Buffer.concat([request(valid).subarray(0, 10), Buffer.from([0xff, 0xfe]), request(valid).subarray(10)])],
    ['多余字段（伪造身份）', request({ ...valid, org_id: '00000000-0000-4000-8000-000000000001' })],
    ['多余字段（指定网关地址）', request({ ...valid, baseUrl: 'http://attacker.example' })],
    ['缺少令牌', request({ version: 1, action: 'session' })],
    ['令牌格式不对', request({ ...valid, token: TOKEN.slice(0, -1) })],
    ['令牌带空白', request({ ...valid, token: ` ${TOKEN}` })],
    ['令牌不是字符串', request({ ...valid, token: 1 })],
    ['未知的 action', request({ ...valid, action: 'shell' })],
    ['prompt 缺少字段', request({ ...valid, action: 'prompt' })],
    ['版本不对', request({ ...valid, version: 2 })],
    ['版本是字符串', request({ ...valid, version: '1' })],
    ['原型污染', request(`{"version":1,"action":"session","token":"${TOKEN}","__proto__":{"x":1}}`)],
  ])('拒绝不合法的请求：%s（不访问 agent-gw）', async (_name, bytes) => {
    const result = await run(bytes);
    expect(result).toEqual({ exitCode: 1, stdout: `${JSON.stringify({ version: 1, ok: false, error: { code: 'BAD_REQUEST', message: ENTRY_ERROR_MESSAGES.BAD_REQUEST } })}\n` });
    expect(received).toEqual([]);
    expect(parseAgentEntryResult(asExec(result))).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });

  it('请求超过上限时停止读取并拒绝；上限处照常解析', async () => {
    const padded = (size: number) => {
      const body = request(valid);
      return Buffer.concat([body.subarray(0, body.length - 1), Buffer.alloc(size - body.length, 0x20), Buffer.from('}')]);
    };
    expect(parseRequest(await readRequest(Readable.from([padded(MAX_REQUEST_BYTES)])))).toEqual(valid);
    // 超过上限：读到上限即停止，之后的数据不再读取。
    const source = new PassThrough();
    let pulled = 0;
    const tooLarge = padded(MAX_REQUEST_BYTES + 1);
    const pending = readRequest(source);
    for (let offset = 0; offset < tooLarge.length; offset += 64 * 1024) {
      pulled += 1;
      if (!source.write(tooLarge.subarray(offset, offset + 64 * 1024))) break;
    }
    source.write(Buffer.alloc(8 * 1024 * 1024));
    await expect(pending).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(source.destroyed).toBe(true);
    expect(pulled).toBeGreaterThan(0);
    expect((await run(tooLarge)).exitCode).toBe(1);
    expect(received).toEqual([]);
  });

  it.each<[string, Handler, string]>([
    ['401（令牌无效、过期、作废）', (_q, r) => { r.statusCode = 401; r.end('{"error":{"code":"AGENT_TOKEN_INVALID"}}'); }, 'TOKEN_INVALID'],
    ['500', (_q, r) => { r.statusCode = 500; r.end('internal detail'); }, 'GATEWAY_FAILED'],
    ['重定向（不跟随）', (_q, r) => { r.statusCode = 302; r.setHeader('location', 'http://attacker.example/'); r.end(); }, 'GATEWAY_FAILED'],
    ['不是 JSON', (_q, r) => r.end('active'), 'GATEWAY_FAILED'],
    ['状态不是 active', (_q, r) => r.end(JSON.stringify({ status: 'revoked', expiresAt: EXPIRES })), 'GATEWAY_FAILED'],
    ['到期时间不合法', (_q, r) => r.end(JSON.stringify({ status: 'active', expiresAt: 'tomorrow' })), 'GATEWAY_FAILED'],
    ['到期时间不是 ISO 时刻', (_q, r) => r.end(JSON.stringify({ status: 'active', expiresAt: '2026-11-15' })), 'GATEWAY_FAILED'],
    ['响应体超过 4 KiB', (_q, r) => r.end(JSON.stringify({ status: 'active', expiresAt: EXPIRES, pad: 'x'.repeat(8 * 1024) })), 'GATEWAY_FAILED'],
    ['响应体无限长', (_q, r) => { const timer = setInterval(() => r.write('x'.repeat(1024)), 1); r.on('close', () => clearInterval(timer)); }, 'GATEWAY_FAILED'],
    ['连接中途断开', (_q, r) => { r.write('{"status":'); r.socket?.destroy(); }, 'GATEWAY_UNAVAILABLE'],
  ])('agent-gw 的响应：%s → %s', async (_name, next, code) => {
    handler = next;
    const result = await run(request(valid));
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { error: { code: string; message: string } };
    expect(parsed.error).toEqual({ code, message: ENTRY_ERROR_MESSAGES[code as keyof typeof ENTRY_ERROR_MESSAGES] });
    // 说明是固定的：不含 agent-gw 的响应正文、重定向地址与令牌。
    for (const leaked of ['internal detail', 'attacker', 'AGENT_TOKEN_INVALID', TOKEN]) expect(result.stdout).not.toContain(leaked);
    expect(received).toHaveLength(1);
    expect(parseAgentEntryResult(asExec(result))).toEqual({ ok: false, code });
  });

  it('agent-gw 不响应时按时限放弃（GATEWAY_UNAVAILABLE）；连不上时同样', async () => {
    handler = () => {};
    const started = Date.now();
    expect(JSON.parse((await run(request(valid), { timeoutMs: 200 })).stdout).error.code).toBe('GATEWAY_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(2_000);
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(JSON.parse((await run(request(valid), { baseUrl: `http://127.0.0.1:${port}` })).stdout).error.code).toBe('GATEWAY_UNAVAILABLE');
    await expect(querySession({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN })).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
  });

  it('结果超过上限时改报 INTERNAL', () => {
    expect(formatResult({ ok: true, action: 'session', expiresAt: EXPIRES })).toBe(`${JSON.stringify({ version: 1, ok: true, action: 'session', expiresAt: EXPIRES })}\n`);
    const huge = formatResult({ ok: true, pad: 'x'.repeat(MAX_RESULT_BYTES) });
    expect(JSON.parse(huge)).toEqual({ version: 1, ok: false, error: { code: 'INTERNAL', message: ENTRY_ERROR_MESSAGES.INTERNAL } });
  });
});

describe('worker 一侧（src/agent/entry.ts）', () => {
  it('请求只经标准输入：执行 run、不带参数；令牌格式不对时不执行', async () => {
    const calls: Array<{ command: string; args: readonly string[]; input: Buffer | undefined }> = [];
    const sandbox: SandboxRef = { id: 'sandbox', template: 'agent', jobId: 'job', expiresAt: new Date() };
    const driver = {
      async exec(_ref: SandboxRef, command: string, args: readonly string[], options: { input?: Buffer } = {}) {
        calls.push({ command, args, input: options.input });
        return asExec(await run(options.input ?? Buffer.alloc(0)));
      },
    };
    expect(await runAgentEntry(driver, sandbox, { action: 'session', token: TOKEN })).toEqual({ ok: true, action: 'session', expiresAt: new Date(EXPIRES) });
    expect(calls).toEqual([{ command: 'run', args: [], input: request(valid) }]);
    expect(encodeAgentEntryRequest({ action: 'session', token: TOKEN })).toEqual(request(valid));
    for (const token of ['', TOKEN.slice(1), `${TOKEN}\n`, 'agt_' + '+'.repeat(43)]) {
      await expect(runAgentEntry(driver, sandbox, { action: 'session', token })).rejects.toBeInstanceOf(TypeError);
    }
    await expect(runAgentEntry(driver, sandbox, { action: 'prompt' as 'session', token: TOKEN })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(1);
  });

  const ok = `${JSON.stringify({ version: 1, ok: true, action: 'session', expiresAt: EXPIRES })}\n`;
  const failure = `${JSON.stringify({ version: 1, ok: false, error: { code: 'TOKEN_INVALID', message: '任务令牌无效' } })}\n`;
  it.each<[string, Partial<SandboxExecResult>]>([
    ['超时', { exitCode: null, timedOut: true, stdout: ok }],
    ['被终止（退出码为空）', { exitCode: null, stdout: ok }],
    ['其他退出码', { exitCode: 137, stdout: failure }],
    ['成功却以 1 退出', { exitCode: 1, stdout: ok }],
    ['失败却以 0 退出', { exitCode: 0, stdout: failure }],
    ['输出被截断', { stdout: ok, stdoutTruncated: true }],
    ['输出超过上限', { stdout: `${JSON.stringify({ version: 1, ok: true, action: 'session', expiresAt: EXPIRES, pad: 'x'.repeat(AGENT_ENTRY_MAX_RESULT_BYTES) })}\n` }],
    ['没有换行', { stdout: ok.trimEnd() }],
    ['多出一行（例如沙箱内的其他输出）', { stdout: `injected\n${ok}` }],
    ['结果后面多出一行', { stdout: `${ok}${ok}` }],
    ['多行的 JSON（缩进格式）', { stdout: `${JSON.stringify({ version: 1, ok: true, action: 'session', expiresAt: EXPIRES }, null, 2)}\n` }],
    ['空输出', { stdout: '' }],
    ['不是 JSON', { stdout: 'ok\n' }],
    ['版本不对', { stdout: `${JSON.stringify({ version: 2, ok: true, action: 'session', expiresAt: EXPIRES })}\n` }],
    ['多余字段', { stdout: `${JSON.stringify({ version: 1, ok: true, action: 'session', expiresAt: EXPIRES, orgId: 'x' })}\n` }],
    ['未知的 action', { stdout: `${JSON.stringify({ version: 1, ok: true, action: 'prompt', expiresAt: EXPIRES })}\n` }],
    ['到期时间不合法', { stdout: `${JSON.stringify({ version: 1, ok: true, action: 'session', expiresAt: '2026-13-45T99:99:99.000Z' })}\n` }],
    ['ok 不是布尔值', { stdout: `${JSON.stringify({ version: 1, ok: 'true', action: 'session', expiresAt: EXPIRES })}\n` }],
    ['未知的失败代码', { exitCode: 1, stdout: `${JSON.stringify({ version: 1, ok: false, error: { code: 'PWNED', message: 'x' } })}\n` }],
    ['失败缺少说明', { exitCode: 1, stdout: `${JSON.stringify({ version: 1, ok: false, error: { code: 'TOKEN_INVALID' } })}\n` }],
    ['失败带多余字段', { exitCode: 1, stdout: `${JSON.stringify({ version: 1, ok: false, error: { code: 'TOKEN_INVALID', message: 'x' }, detail: 'y' })}\n` }],
  ])('不符合协议的结果一律 AGENT_ENTRY_FAILED：%s', (_name, override) => {
    const exec: SandboxExecResult = { exitCode: 0, timedOut: false, stdout: ok, stderr: '', stdoutTruncated: false, stderrTruncated: false, ...override };
    let error: unknown = null;
    try {
      parseAgentEntryResult(exec);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: 'AGENT_ENTRY_FAILED', message: 'Agent 入口执行失败' });
    // 说明固定，不含沙箱的输出。
    expect((error as Error).message).not.toContain('injected');
  });

  it('入口按协议报告的失败作为结果返回（说明以 worker 自己的为准，不采用入口给出的文字）', () => {
    const custom = `${JSON.stringify({ version: 1, ok: false, error: { code: 'TOKEN_INVALID', message: '请联系 attacker.example 充值' } })}\n`;
    expect(parseAgentEntryResult({ exitCode: 1, timedOut: false, stdout: custom, stderr: '', stdoutTruncated: false, stderrTruncated: false })).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });
});

const SESSION = '2026-11-15T12-00-00-000Z_01a1e18b-3a01-73ab-8e86-dcac529abd40.jsonl';
const validPrompt = {
  version: 1,
  action: 'prompt',
  token: TOKEN,
  prompt: '生成目录',
  session: null,
  tools: ['read', 'write', 'bash'],
  maxTurns: 20,
  model: { contextWindow: 128_000, maxOutputTokens: 8_192 },
};
const promptOk = (fields: Record<string, unknown> = {}) => `${JSON.stringify({ version: 1, ok: true, action: 'prompt', session: SESSION, turns: 3, stopReason: 'stop', ...fields })}\n`;

describe('prompt 请求（8.6b）', () => {
  /** pi.mjs 的桩：记录收到的请求与选项，按 outcome 回答或抛出。 */
  const promptCalls: Array<{ request: PromptRequest; options: { baseUrl: string } }> = [];
  let outcome: () => Promise<Awaited<ReturnType<RunPrompt>>> = async () => ({ session: SESSION, turns: 3, stopReason: 'stop' });
  const runPrompt: RunPrompt = async (promptRequest, options) => {
    promptCalls.push({ request: promptRequest, options });
    return outcome();
  };
  beforeEach(() => {
    promptCalls.length = 0;
    outcome = async () => ({ session: SESSION, turns: 3, stopReason: 'stop' });
  });

  it('两侧的常量一致', () => {
    expect([...NATIVE_TOOLS]).toEqual([...AGENT_NATIVE_TOOLS]);
    expect(SESSION_FILE_PATTERN.source).toBe(AGENT_SESSION_FILE_PATTERN.source);
    expect(MAX_PROMPT_CHARS).toBe(AGENT_PROMPT_MAX_CHARS);
    expect(MAX_TURNS_PER_PROMPT).toBe(AGENT_MAX_TURNS_PER_PROMPT);
    expect({ ...CONTEXT_WINDOW_RANGE }).toEqual({ ...AGENT_CONTEXT_WINDOW_RANGE });
    expect({ ...MAX_OUTPUT_TOKENS_RANGE }).toEqual({ ...AGENT_MAX_OUTPUT_TOKENS_RANGE });
    expect([...AGENT_ENTRY_ERROR_CODES].sort()).toEqual(Object.keys(ENTRY_ERROR_MESSAGES).sort());
  });

  it('先经 agent-gw 确认令牌，再把解析过的请求交给 Pi 会话；结果恰好一行，worker 按同样的意思解析', async () => {
    const result = await run(request(validPrompt), { runPrompt });
    expect(result).toEqual({ exitCode: 0, stdout: promptOk() });
    expect(received.map((item) => [item.method, item.url])).toEqual([['GET', '/v1/session']]);
    expect(promptCalls).toEqual([{ request: validPrompt, options: { baseUrl } }]);
    expect(parseAgentEntryResult(asExec(result), { action: 'prompt', maxTurns: 20 })).toEqual({ ok: true, action: 'prompt', session: SESSION, turns: 3, stopReason: 'stop' });
    // 续接会话、不启用任何工具、各上限处照常。
    const edge = { ...validPrompt, session: SESSION, tools: [], maxTurns: MAX_TURNS_PER_PROMPT, prompt: 'x'.repeat(MAX_PROMPT_CHARS), model: { contextWindow: CONTEXT_WINDOW_RANGE.max, maxOutputTokens: MAX_OUTPUT_TOKENS_RANGE.max } };
    expect(parseRequest(request(edge))).toEqual(edge);
    expect(parseRequest(request({ ...validPrompt, tools: [...NATIVE_TOOLS], model: { contextWindow: CONTEXT_WINDOW_RANGE.min, maxOutputTokens: MAX_OUTPUT_TOKENS_RANGE.min } }))).toMatchObject({ tools: [...NATIVE_TOOLS] });
  });

  it.each<[string, Record<string, unknown>]>([
    ['缺少 session（必须显式给出 null）', { session: undefined }],
    ['多余字段（伪造身份）', { project_id: '00000000-0000-4000-8000-000000000001' }],
    ['多余字段（指定模型与 Base URL）', { baseUrl: 'http://attacker.example', modelName: 'gpt-x' }],
    ['提示词为空', { prompt: '' }],
    ['提示词只有空白', { prompt: ' \n\t' }],
    ['提示词过长', { prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }],
    ['提示词不是字符串', { prompt: ['生成'] }],
    ['会话文件名带路径', { session: `../${SESSION}` }],
    ['会话文件名是绝对路径', { session: `/workspace/pi-sessions/${SESSION}` }],
    ['会话文件名不是 Pi 的格式', { session: 'notes.jsonl' }],
    ['会话文件名大写', { session: SESSION.toUpperCase() }],
    ['会话文件名带换行', { session: `${SESSION}\n` }],
    ['工具不是数组', { tools: 'bash' }],
    ['未登记的工具', { tools: ['bash', 'curl'] }],
    ['业务工具（随 8.6c）', { tools: ['ask-user'] }],
    ['工具重复', { tools: ['bash', 'bash'] }],
    ['工具不是字符串', { tools: [1] }],
    ['轮数为 0', { maxTurns: 0 }],
    ['轮数超过上限', { maxTurns: MAX_TURNS_PER_PROMPT + 1 }],
    ['轮数不是整数', { maxTurns: 1.5 }],
    ['轮数是字符串', { maxTurns: '20' }],
    ['模型缺少字段', { model: { contextWindow: 128_000 } }],
    ['模型多余字段', { model: { contextWindow: 128_000, maxOutputTokens: 8_192, baseUrl: 'http://attacker.example' } }],
    ['上下文长度过小', { model: { contextWindow: CONTEXT_WINDOW_RANGE.min - 1, maxOutputTokens: 256 } }],
    ['上下文长度过大', { model: { contextWindow: CONTEXT_WINDOW_RANGE.max + 1, maxOutputTokens: 8_192 } }],
    ['输出上限过大', { model: { contextWindow: 2_000_000, maxOutputTokens: MAX_OUTPUT_TOKENS_RANGE.max + 1 } }],
    ['输出上限大于上下文长度', { model: { contextWindow: 8_192, maxOutputTokens: 16_384 } }],
    ['模型不是对象', { model: [128_000, 8_192] }],
  ])('拒绝不合法的 prompt 请求：%s（不访问 agent-gw，不启动 Pi 会话）', async (_name, override) => {
    const result = await run(request({ ...validPrompt, ...override }), { runPrompt });
    expect(result).toEqual({ exitCode: 1, stdout: `${JSON.stringify({ version: 1, ok: false, error: { code: 'BAD_REQUEST', message: ENTRY_ERROR_MESSAGES.BAD_REQUEST } })}\n` });
    expect(received).toEqual([]);
    expect(promptCalls).toEqual([]);
  });

  it('原型污染的请求被拒绝', async () => {
    const polluted = JSON.stringify(validPrompt).replace('"model":{', '"model":{"__proto__":{"x":1},');
    expect((await run(request(polluted), { runPrompt })).exitCode).toBe(1);
    expect(promptCalls).toEqual([]);
  });

  it('令牌无效、agent-gw 不可用时不启动 Pi 会话', async () => {
    handler = (_q, r) => {
      r.statusCode = 401;
      r.end();
    };
    expect(JSON.parse((await run(request(validPrompt), { runPrompt })).stdout).error.code).toBe('TOKEN_INVALID');
    handler = () => {};
    expect(JSON.parse((await run(request(validPrompt), { runPrompt, timeoutMs: 200 })).stdout).error.code).toBe('GATEWAY_UNAVAILABLE');
    expect(promptCalls).toEqual([]);
  });

  it.each(['SESSION_INVALID', 'TURN_LIMIT', 'MODEL_FAILED', 'INTERNAL'] as const)('Pi 会话报告 %s：按协议的固定说明返回', async (code) => {
    outcome = async () => {
      throw new EntryError(code);
    };
    const result = await run(request(validPrompt), { runPrompt });
    expect(result).toEqual({ exitCode: 1, stdout: `${JSON.stringify({ version: 1, ok: false, error: { code, message: ENTRY_ERROR_MESSAGES[code] } })}\n` });
    expect(parseAgentEntryResult(asExec(result), { action: 'prompt', maxTurns: 20 })).toEqual({ ok: false, code });
  });

  it('Pi 会话抛出的其他异常一律 INTERNAL，不带出说明；没有注入 Pi 会话时同样', async () => {
    outcome = async () => {
      throw new Error(`upstream said: ${TOKEN} sk-secret`);
    };
    const result = await run(request(validPrompt), { runPrompt });
    expect(JSON.parse(result.stdout).error.code).toBe('INTERNAL');
    for (const leaked of [TOKEN, 'sk-secret', 'upstream']) expect(result.stdout).not.toContain(leaked);
    expect(JSON.parse((await run(request(validPrompt))).stdout).error.code).toBe('INTERNAL');
  });

  describe('worker 一侧', () => {
    const promptRequest: AgentPromptRequest = { action: 'prompt', token: TOKEN, prompt: '生成目录', session: null, tools: ['read', 'write', 'bash'], maxTurns: 20, model: { contextWindow: 128_000, maxOutputTokens: 8_192 } };

    it('编码：与入口解析的字段一致；不合法的请求不执行', async () => {
      expect(encodeAgentEntryRequest(promptRequest)).toEqual(request(validPrompt));
      expect(parseRequest(encodeAgentEntryRequest({ ...promptRequest, session: SESSION }))).toEqual({ ...validPrompt, session: SESSION });
      const calls: unknown[] = [];
      const sandbox: SandboxRef = { id: 'sandbox', template: 'agent', jobId: 'job', expiresAt: new Date() };
      const driver = {
        async exec(_ref: SandboxRef, _command: string, _args: readonly string[], options: { input?: Buffer } = {}) {
          calls.push(options.input);
          return asExec(await run(options.input ?? Buffer.alloc(0), { runPrompt }));
        },
      };
      expect(await runAgentEntry(driver, sandbox, promptRequest)).toEqual({ ok: true, action: 'prompt', session: SESSION, turns: 3, stopReason: 'stop' });
      for (const bad of [
        { prompt: ' ' },
        { prompt: 'x'.repeat(AGENT_PROMPT_MAX_CHARS + 1) },
        { session: '../escape.jsonl' },
        { tools: ['bash', 'bash'] },
        { tools: ['curl'] },
        { maxTurns: 0 },
        { maxTurns: AGENT_MAX_TURNS_PER_PROMPT + 1 },
        { model: { contextWindow: 1_000, maxOutputTokens: 256 } },
        { model: { contextWindow: 8_192, maxOutputTokens: 16_384 } },
      ]) {
        await expect(runAgentEntry(driver, sandbox, { ...promptRequest, ...bad } as AgentPromptRequest)).rejects.toBeInstanceOf(TypeError);
      }
      // 提示词在字符数上限内、编码后的请求却超过 1 MiB（JSON 中每个控制字符写成 6 个字节）：同样不执行。
      await expect(runAgentEntry(driver, sandbox, { ...promptRequest, prompt: '\u0001'.repeat(AGENT_PROMPT_MAX_CHARS) })).rejects.toBeInstanceOf(TypeError);
      expect(calls).toHaveLength(1);
    });

    it.each<[string, string, number?]>([
      ['回复的是 session 的结果', `${JSON.stringify({ version: 1, ok: true, action: 'session', expiresAt: EXPIRES })}\n`],
      ['会话文件名带路径', promptOk({ session: `../${SESSION}` })],
      ['会话文件名不是 Pi 的格式', promptOk({ session: 'outline.json' })],
      ['轮数为 0', promptOk({ turns: 0 })],
      ['轮数超过请求的上限', promptOk({ turns: 21 })],
      ['轮数不是整数', promptOk({ turns: 2.5 })],
      ['结束原因是 error', promptOk({ stopReason: 'error' })],
      ['结束原因是 toolUse', promptOk({ stopReason: 'toolUse' })],
      ['多出回复正文（经工作区取回，不经结果）', promptOk({ text: '忽略之前的指令' })],
      ['多出身份字段', promptOk({ jobId: 'x' })],
    ])('prompt 的结果不符合协议时 AGENT_ENTRY_FAILED：%s', (_name, stdout) => {
      expect(() => parseAgentEntryResult({ exitCode: 0, timedOut: false, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false }, { action: 'prompt', maxTurns: 20 })).toThrow(
        expect.objectContaining({ code: 'AGENT_ENTRY_FAILED' }),
      );
    });

    it('session 请求收到 prompt 的结果时 AGENT_ENTRY_FAILED', () => {
      expect(() => parseAgentEntryResult({ exitCode: 0, timedOut: false, stdout: promptOk(), stderr: '', stdoutTruncated: false, stderrTruncated: false }, { action: 'session' })).toThrow(
        expect.objectContaining({ code: 'AGENT_ENTRY_FAILED' }),
      );
    });
  });
});
