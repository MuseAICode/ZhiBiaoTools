// agent 沙箱入口中的子会话（server/sandbox/agent/pi.mjs 的 runPiChildPrompt、protocol.mjs 的 child-prompt / remove，路线图第 8 步 8.10c3b2）：
// 真实的 Pi 运行时经**真实的模型调用路由**（registerAgentChatRoute）调用模型，AI 网关用按会话脚本回答的桩代替。覆盖：
// - **并发子会话对同一工作区的读写不互相覆盖**（#126 用户要求）：几个子会话同时运行（模型调用确实重叠），各自修改自己的小节文件、
//   同时读取同一个共享文件，结束后每个文件都是各自子会话写下的内容，共享文件不变；各子会话的会话文件互相独立、在工作区之外；
// - 子会话只注册请求中的原生工具与 report-failure，没有业务工具与本地工具；report-failure 在沙箱内处理（不调用 worker 的工具接口），
//   原因作为结果返回；轮数上限、墙钟到期、模型调用失败作为结束方式返回；同一子会话可以续接；
// - 协议：child-prompt 与 remove 请求的严格解析；remove 只删普通文件与符号链接本身，不删目录、不经链接删到工作区之外。
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAgentChatRoute } from '../../src/agent/chatCompletions.ts';
import { generateAgentToken } from '../../src/agent/token.ts';
import type { AgentTokenIdentity } from '../../src/agent/tokenStore.ts';
import type { AiGateway, ChatDelta, ChatRequest, ChatResult } from '../../src/ai/gateway.ts';
import { AppError, registerErrorHandlers } from '../../src/errors.ts';
import { CHILD_SESSIONS_DIR, runPiChildPrompt } from '../../sandbox/agent/pi.mjs';
import {
  type ChildPromptRequest,
  CHILD_TIMEOUT_RANGE,
  MAX_REMOVE_PATHS,
  NATIVE_TOOLS,
  parseRequest,
  removeWorkspaceFiles,
  runEntry,
  SESSION_FILE_PATTERN,
} from '../../sandbox/agent/protocol.mjs';

const TOKEN = generateAgentToken();
const IDENTITY: AgentTokenIdentity = {
  orgId: randomUUID(),
  jobId: randomUUID(),
  runId: randomUUID(),
  projectId: randomUUID(),
  userId: randomUUID(),
  jobType: 'content-generation',
  role: 'member',
  expiresAt: new Date(Date.now() + 600_000),
  logId: 'abcdef012345',
};

interface Reply {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  error?: unknown;
  delayMs?: number;
}

/** 按会话脚本回答：第一条用户消息中含有的标记决定用哪一组回答（并发的子会话各有各的脚本）。 */
const scripts = new Map<string, Reply[]>();
const calls: Array<{ key: string; request: ChatRequest }> = [];
const toolCallPaths: string[] = [];
let inFlight = 0;
let maxInFlight = 0;

function keyOf(request: ChatRequest): string {
  const firstUser = request.messages.find((message) => message.role === 'user');
  const text = typeof firstUser?.content === 'string' ? firstUser.content : '';
  return [...scripts.keys()].find((key) => text.includes(key)) ?? '';
}

const stubGateway: AiGateway = {
  async chat(_context, request, options = {}) {
    const key = keyOf(request);
    calls.push({ key, request });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const reply = scripts.get(key)?.shift() ?? { content: '完成' };
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      const toolCalls = (reply.toolCalls ?? []).map((call) => ({ id: `call_${randomUUID().slice(0, 8)}`, name: call.name, arguments: JSON.stringify(call.arguments) }));
      const delta: ChatDelta = {};
      if (reply.content !== undefined) delta.content = reply.content;
      if (toolCalls.length > 0) delta.toolCalls = toolCalls.map((call, index) => ({ index, id: call.id, name: call.name, arguments: call.arguments }));
      options.onDelta?.(delta);
      if (reply.error) throw reply.error;
      return {
        requestId: randomUUID(),
        content: reply.content ?? '',
        reasoningContent: '',
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        aborted: false,
        reused: false,
        usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, usageSource: 'provider' },
        billing: { status: 'billed', amount: 1n },
      } satisfies ChatResult;
    } finally {
      inFlight -= 1;
    }
  },
};

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }, bodyLimit: 8 * 1024 * 1024, forceCloseConnections: true });
  registerErrorHandlers(app);
  // 子会话不应调用 worker 的工具接口：有请求就记下（并按 404 拒绝）。
  app.addHook('onRequest', async (request) => {
    if (request.url !== '/v1/chat/completions') toolCallPaths.push(request.url);
  });
  registerAgentChatRoute(app, {
    resolveModel: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    gateway: stubGateway,
    maxOutputTokens: 4096,
    identityOf: () => IDENTITY,
    beginTurn: async () => {},
    markCostLimit: async () => {},
    recordRejection: async () => {},
    track: () => () => {},
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app?.close();
});

let root: string;
let workspaceDir: string;
let sessionsDir: string;
beforeEach(() => {
  scripts.clear();
  calls.length = 0;
  toolCallPaths.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  root = mkdtempSync(join(tmpdir(), 'zhibiao-pi-child-'));
  workspaceDir = join(root, 'workspace');
  sessionsDir = join(root, 'child-sessions');
  mkdirSync(workspaceDir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const request = (overrides: Partial<ChildPromptRequest> = {}): ChildPromptRequest => ({
  version: 1,
  action: 'child-prompt',
  token: TOKEN,
  prompt: '修复小节',
  session: null,
  tools: [...NATIVE_TOOLS],
  maxTurns: 20,
  timeoutMs: 60_000,
  model: { contextWindow: 128_000, maxOutputTokens: 8_192 },
  ...overrides,
});
const child = (overrides: Partial<ChildPromptRequest> = {}) => runPiChildPrompt(request(overrides), { baseUrl, workspaceDir, sessionsDir, agentDir: join(root, 'agent') });
const toolResults = (chat: ChatRequest) => chat.messages.filter((message) => message.role === 'tool').map((message) => message.content);

describe('并发子会话（runPiChildPrompt）', () => {
  it('同一工作区中并发的子会话各自修改自己的小节、读取共享文件，读写互不覆盖；会话文件独立、在工作区之外', async () => {
    mkdirSync(join(workspaceDir, '正文'));
    writeFileSync(join(workspaceDir, '共享.md'), '共享规范');
    const ids = ['1-1', '1-2', '1-3'];
    for (const id of ids) {
      writeFileSync(join(workspaceDir, '正文', `${id}.html`), `<p>第 ${id} 节原文</p>`);
      // 每个子会话：读共享文件（等待一下，让各子会话的调用重叠）→ edit 本节 → bash 追加一行 → 结束。
      scripts.set(`【小节 ${id}】`, [
        { delayMs: 150, toolCalls: [{ name: 'read', arguments: { path: '共享.md' } }] },
        { delayMs: 150, toolCalls: [{ name: 'edit', arguments: { path: `正文/${id}.html`, edits: [{ oldText: '原文', newText: `修复后（${id}）` }] } }] },
        { delayMs: 150, toolCalls: [{ name: 'bash', arguments: { command: `printf '\\n<p>补充 ${id}</p>' >> 正文/${id}.html` } }] },
        { content: '本节已完成' },
      ]);
    }
    const outcomes = await Promise.all(ids.map((id) => child({ prompt: `【小节 ${id}】修复本节` })));
    // 模型调用确实并发。
    expect(maxInFlight).toBeGreaterThan(1);
    for (const [index, id] of ids.entries()) {
      expect(outcomes[index]).toEqual({ session: expect.stringMatching(SESSION_FILE_PATTERN), turns: 4, outcome: 'stop', reason: null });
      expect(readFileSync(join(workspaceDir, '正文', `${id}.html`), 'utf8')).toBe(`<p>第 ${id} 节修复后（${id}）</p>\n<p>补充 ${id}</p>`);
      // 每个子会话读到的共享文件都是原文。
      const own = calls.filter((call) => call.key === `【小节 ${id}】`);
      expect(toolResults(own[1]!.request)[0]).toContain('共享规范');
    }
    expect(readFileSync(join(workspaceDir, '共享.md'), 'utf8')).toBe('共享规范');
    // 会话文件：各自一个、互不相同，都在子会话目录中（不在工作区内）。
    const sessions = outcomes.map((outcome) => outcome.session!);
    expect(new Set(sessions).size).toBe(3);
    expect(readdirSync(sessionsDir).sort()).toEqual([...sessions].sort());
    expect(readdirSync(workspaceDir).sort()).toEqual(['共享.md', '正文']);
    for (const [index, id] of ids.entries()) {
      const text = readFileSync(join(sessionsDir, sessions[index]!), 'utf8');
      expect(text).toContain(`【小节 ${id}】`);
      for (const other of ids.filter((value) => value !== id)) expect(text).not.toContain(`【小节 ${other}】`);
      expect(text).not.toContain(TOKEN);
    }
    // 子会话不调用 worker 的工具接口。
    expect(toolCallPaths).toEqual([]);
  });

  it('只注册请求中的原生工具与 report-failure；默认的会话目录在工作区之外', async () => {
    await child({ tools: ['read', 'edit'] });
    expect(calls[0]!.request.tools?.map((tool) => tool.name).sort()).toEqual(['edit', 'read', 'report-failure']);
    expect(CHILD_SESSIONS_DIR.startsWith('/workspace')).toBe(false);
  });

  it('report-failure 在沙箱内处理：不调用 worker，原因作为结果返回，会话随即结束', async () => {
    scripts.set('【失败】', [{ toolCalls: [{ name: 'report-failure', arguments: { reason: '本节缺少招标文件中的参数，无法修复' } }] }, { content: '不应再调用' }]);
    const outcome = await child({ prompt: '【失败】修复' });
    expect(outcome).toEqual({ session: expect.stringMatching(SESSION_FILE_PATTERN), turns: 1, outcome: 'reported', reason: '本节缺少招标文件中的参数，无法修复' });
    expect(calls).toHaveLength(1);
    expect(toolCallPaths).toEqual([]);
  });

  it('轮数达到上限、墙钟到期、模型调用失败作为结束方式返回', async () => {
    scripts.set('【轮数】', [{ toolCalls: [{ name: 'ls', arguments: {} }] }, { toolCalls: [{ name: 'ls', arguments: {} }] }, { content: '完成' }]);
    expect(await child({ prompt: '【轮数】', maxTurns: 1 })).toMatchObject({ outcome: 'turn-limit', turns: 1, reason: null });

    scripts.set('【墙钟】', [{ delayMs: 3_000, content: '太晚了' }]);
    const started = Date.now();
    expect(await child({ prompt: '【墙钟】', timeoutMs: CHILD_TIMEOUT_RANGE.min })).toMatchObject({ outcome: 'time-limit', reason: null });
    expect(Date.now() - started).toBeLessThan(2_900);

    scripts.set('【失败调用】', [{ error: new AppError(502, 'AI_UPSTREAM_FAILED', '上游失败') }]);
    expect(await child({ prompt: '【失败调用】' })).toMatchObject({ outcome: 'model-failed', reason: null });
  });

  it('续接同一子会话：带上之前的对话，会话文件名不变；会话文件不存在时 SESSION_INVALID', async () => {
    scripts.set('【续接】', [{ content: '第一轮完成' }, { content: '第二轮完成' }]);
    const first = await child({ prompt: '【续接】第一轮' });
    const second = await child({ prompt: '继续处理', session: first.session });
    expect(second.session).toBe(first.session);
    expect(calls.at(-1)!.request.messages.map((message) => message.content)).toEqual(expect.arrayContaining(['【续接】第一轮', '第一轮完成', '继续处理']));
    await expect(child({ session: `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.jsonl` })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
  });
});

describe('child-prompt 与 remove 的协议（protocol.mjs）', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

  it('child-prompt：字段恰好登记的那些，工具只能是原生工具，墙钟与轮数在范围内', () => {
    const valid = request();
    expect(parseRequest(encode(valid))).toEqual(valid);
    for (const broken of [
      { ...valid, tools: ['read', 'ask-user'] },
      { ...valid, tools: ['report-failure'] },
      { ...valid, tools: ['json-validation'] },
      { ...valid, tools: ['read', 'read'] },
      { ...valid, timeoutMs: CHILD_TIMEOUT_RANGE.min - 1 },
      { ...valid, timeoutMs: CHILD_TIMEOUT_RANGE.max + 1 },
      { ...valid, maxTurns: 0 },
      { ...valid, session: '../x.jsonl' },
      { ...valid, jsonSchemas: {} },
      (({ timeoutMs: _omitted, ...rest }) => rest)(valid),
    ]) {
      expect(() => parseRequest(encode(broken))).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
    }
  });

  it('remove：1～256 个不重复的工作区相对路径', () => {
    const valid = { version: 1, action: 'remove', token: TOKEN, paths: ['正文/1.html'] };
    expect(parseRequest(encode(valid))).toEqual(valid);
    for (const paths of [[], ['正文/1.html', '正文/1.html'], ['../x'], ['/etc/passwd'], ['a\\b'], Array.from({ length: MAX_REMOVE_PATHS + 1 }, (_, index) => `${index}.html`)]) {
      expect(() => parseRequest(encode({ ...valid, paths }))).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
    }
  });

  it('removeWorkspaceFiles：删普通文件与符号链接本身；目录、不存在的、经链接指向工作区之外的跳过', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.html'), 'outside');
    mkdirSync(join(workspaceDir, '正文'));
    writeFileSync(join(workspaceDir, '正文', 'a.html'), 'a');
    mkdirSync(join(workspaceDir, '正文', 'dir.html'));
    symlinkSync(join(outside, 'keep.html'), join(workspaceDir, '正文', 'link.html'));
    symlinkSync(outside, join(workspaceDir, '外链'));
    const removed = removeWorkspaceFiles(['正文/a.html', '正文/dir.html', '正文/link.html', '正文/none.html', '外链/keep.html'], { workspaceDir });
    expect(removed).toBe(2);
    expect(existsSync(join(workspaceDir, '正文', 'a.html'))).toBe(false);
    expect(lstatSync(join(workspaceDir, '正文', 'dir.html')).isDirectory()).toBe(true);
    expect(existsSync(join(workspaceDir, '正文', 'link.html'))).toBe(false);
    expect(readFileSync(join(outside, 'keep.html'), 'utf8')).toBe('outside');
  });

  it('runEntry：child-prompt 只留登记的字段；remove 返回删除的个数；令牌无效时不执行', async () => {
    const sessionServer = Fastify();
    let active = true;
    sessionServer.get('/v1/session', async (_request, reply) => (active ? { status: 'active', expiresAt: new Date(Date.now() + 60_000).toISOString() } : reply.code(401).send({})));
    await sessionServer.listen({ host: '127.0.0.1', port: 0 });
    const origin = `http://127.0.0.1:${(sessionServer.server.address() as AddressInfo).port}`;
    const run = async (body: unknown, extra: Record<string, unknown> = {}) => {
      let out = '';
      const stdout = { write: (chunk: string, done: () => void) => { out += chunk; done(); } };
      const code = await runEntry({ stdin: Readable.from([encode(body)]), stdout: stdout as never, baseUrl: origin, ...extra });
      return { code, result: JSON.parse(out) };
    };
    try {
      const session = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.jsonl`;
      expect(await run(request(), { runChildPrompt: async () => ({ session, turns: 3, outcome: 'reported', reason: '原因', extra: 'x' }) })).toEqual({
        code: 0,
        result: { version: 1, ok: true, action: 'child-prompt', session, turns: 3, outcome: 'reported', reason: '原因' },
      });
      // 结束方式之外的原因不带出；形状不对按 INTERNAL。
      expect((await run(request(), { runChildPrompt: async () => ({ session: null, turns: 1, outcome: 'stop', reason: '多余' }) })).result).toMatchObject({ ok: true, reason: null });
      expect((await run(request(), { runChildPrompt: async () => ({ session: null, turns: 99, outcome: 'stop', reason: null }) })).result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
      expect((await run(request(), { runChildPrompt: async () => ({ session: null, turns: 1, outcome: 'weird', reason: null }) })).result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
      expect(await run({ version: 1, action: 'remove', token: TOKEN, paths: ['a.html', 'b.html'] }, { removeFiles: (paths: string[]) => paths.length - 1 })).toEqual({
        code: 0,
        result: { version: 1, ok: true, action: 'remove', removed: 1 },
      });
      active = false;
      let called = false;
      expect((await run({ version: 1, action: 'remove', token: TOKEN, paths: ['a.html'] }, { removeFiles: () => { called = true; return 1; } })).result).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
      expect(called).toBe(false);
    } finally {
      await sessionServer.close();
    }
  });
});
