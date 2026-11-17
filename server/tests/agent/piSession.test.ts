// agent 沙箱入口中的 Pi 会话（server/sandbox/agent/pi.mjs，路线图第 8 步 8.6b）：真实的 Pi 运行时（sandbox/agent/node_modules，
// 按 sandbox/agent/package-lock.json 安装，CI 在单元测试之前安装）经**真实的模型调用路由**（registerAgentChatRoute，schema 与
// 字段转换同生产）调用模型，AI 网关用按脚本回答的桩代替。覆盖：
// - Pi 发出的请求通过路由的严格 schema；令牌只在 Authorization 中（请求体、会话文件、bash 环境中都没有）；模型由平台决定；
// - 工作区说明（Linux /bin/sh、文件命名规则，与 agent 模板的取回规则一致）进入系统提示词；只注册请求中的原生工具；
// - bash 的环境固定为 BASH_ENV，命令时限只能更短；会话文件在 pi-sessions/ 中，续接时带上之前的对话；
// - 会话文件不存在 / 是符号链接 / 是目录 / 内容无效（SESSION_INVALID，不调用模型）、轮数达到上限（TURN_LIMIT）、
//   平台拒绝或流中途失败（MODEL_FAILED）、输出达到上限（stopReason = length）；
// - 阶段交接压缩（runPiCompaction，8.6d2）：会话太短时无需压缩（不调用模型）；会话足够长时按 worker 的指令压缩（经同一条路由、
//   不注册工具、令牌只在 Authorization 中），压缩写进同一个会话文件、续接时模型收到摘要而不是原文；刚压缩过时无需压缩；
//   会话文件不可用 SESSION_INVALID；模型调用失败 MODEL_FAILED；会话文件中的回复全文可以由 worker 取回（assistantText.ts）。
// 真实沙箱（gVisor、只通 agent-gw）中的同一流程见 tests/sandbox/docker/agentEntry.test.ts。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAgentChatRoute } from '../../src/agent/chatCompletions.ts';
import { generateAgentToken } from '../../src/agent/token.ts';
import type { AgentTokenIdentity } from '../../src/agent/tokenStore.ts';
import type { AiGateway, ChatDelta, ChatRequest, ChatResult } from '../../src/ai/gateway.ts';
import { AppError, registerErrorHandlers } from '../../src/errors.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { BASH_COMMAND_TIMEOUT_SECONDS, BASH_ENV, bashTimeoutSeconds, INSTRUCTIONS_PATH, runPiCompaction, runPiPrompt } from '../../sandbox/agent/pi.mjs';
import { extractAgentAssistantText } from '../../src/agent/assistantText.ts';
import { type CompactRequest, NATIVE_TOOLS, type PromptRequest, SESSION_FILE_PATTERN } from '../../sandbox/agent/protocol.mjs';

const TOKEN = generateAgentToken();
const IDENTITY: AgentTokenIdentity = {
  orgId: randomUUID(),
  jobId: randomUUID(),
  runId: randomUUID(),
  projectId: randomUUID(),
  userId: randomUUID(),
  jobType: 'technical-plan-outline',
  role: 'member',
  expiresAt: new Date(Date.now() + 600_000),
  logId: 'abcdef012345',
};

/** 网关桩的一次回答：文本或工具调用；error 给出时在分段之后抛出。 */
interface Reply {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  finishReason?: string;
  error?: unknown;
}

const calls: ChatRequest[] = [];
const authorizations: Array<string | undefined> = [];
const rawBodies: string[] = [];
let replies: Reply[] = [];
let fallback: Reply = { content: '完成' };
let turnError: unknown = null;

const stubGateway: AiGateway = {
  async chat(_context, request, options = {}) {
    calls.push(request);
    const reply = replies.shift() ?? fallback;
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
      finishReason: reply.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      aborted: false,
      reused: false,
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, usageSource: 'provider' },
      billing: { status: 'billed', amount: 1n },
    } satisfies ChatResult;
  },
};

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  // 与 src/agent/endpoint.ts 相同的 ajv 设置（不删除多余字段、不做类型转换）与错误处理；GET /v1/session 不经过 Pi，这里不需要。
  app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }, bodyLimit: 8 * 1024 * 1024, forceCloseConnections: true });
  registerErrorHandlers(app);
  app.removeContentTypeParser('text/plain');
  app.addHook('preParsing', async (request, _reply, payload) => {
    authorizations.push(request.headers.authorization);
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    rawBodies.push(raw.toString('utf8'));
    const { Readable } = await import('node:stream');
    return Readable.from([raw]);
  });
  registerAgentChatRoute(app, {
    resolveModel: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    gateway: stubGateway,
    maxOutputTokens: 4096,
    identityOf: () => IDENTITY,
    beginTurn: async () => {
      if (turnError) throw turnError;
    },
    markCostLimit: async () => {},
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
  calls.length = 0;
  authorizations.length = 0;
  rawBodies.length = 0;
  replies = [];
  fallback = { content: '完成' };
  turnError = null;
  root = mkdtempSync(join(tmpdir(), 'zhibiao-pi-'));
  workspaceDir = join(root, 'workspace');
  sessionsDir = join(workspaceDir, 'pi-sessions');
  mkdirSync(workspaceDir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const baseRequest = (overrides: Partial<PromptRequest> = {}): PromptRequest => ({
  version: 1,
  action: 'prompt',
  token: TOKEN,
  prompt: '按任务说明生成目录',
  session: null,
  tools: [...NATIVE_TOOLS],
  maxTurns: 20,
  model: { contextWindow: 128_000, maxOutputTokens: 8_192 },
  ...overrides,
});

const prompt = (overrides: Partial<PromptRequest> = {}) => runPiPrompt(baseRequest(overrides), { baseUrl, workspaceDir, sessionsDir, agentDir: join(root, 'agent') });
const COMPACTION_INSTRUCTIONS = '请用简体中文总结，供下一阶段「正文生成」继续使用。';
const compact = (session: string, overrides: Partial<CompactRequest> = {}) =>
  runPiCompaction(
    { version: 1, action: 'compact', token: TOKEN, session, instructions: COMPACTION_INSTRUCTIONS, model: { contextWindow: 128_000, maxOutputTokens: 8_192 }, ...overrides },
    { baseUrl, workspaceDir, sessionsDir, agentDir: join(root, 'agent') },
  );

/** 一次调用中 tool 消息的内容（Pi 把工具结果交回模型）。 */
const toolResults = (request: ChatRequest) => request.messages.filter((message) => message.role === 'tool').map((message) => message.content);
const systemPrompt = (request: ChatRequest) => request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');

describe('Pi 会话（pi.mjs）', () => {
  it('新建会话：请求通过真实路由的 schema，令牌只在 Authorization 中；bash 在工作区执行，环境固定、没有令牌', async () => {
    replies = [{ toolCalls: [{ name: 'bash', arguments: { command: 'printf ok > 结果.txt; env' } }] }, { content: '完成' }];
    const outcome = await prompt();
    expect(outcome).toEqual({ session: expect.stringMatching(SESSION_FILE_PATTERN), turns: 2, stopReason: 'stop' });
    expect(calls).toHaveLength(2);
    // 模型由平台决定（请求中的 default 不被采信），Pi 的请求经路由转成网关字段。
    expect(calls.every((call) => call.provider === 'deepseek' && call.model === 'deepseek-chat')).toBe(true);
    expect(authorizations).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    for (const body of rawBodies) expect(body).not.toContain(TOKEN);
    // 只注册请求中的原生工具。
    expect(calls[0]!.tools?.map((tool) => tool.name).sort()).toEqual([...NATIVE_TOOLS].sort());
    expect(calls[0]!.messages.at(-1)).toMatchObject({ role: 'user', content: '按任务说明生成目录' });
    // bash 的结果：文件写在工作区，环境只有 BASH_ENV 与 shell 自己设的 PWD。
    expect(readFileSync(join(workspaceDir, '结果.txt'), 'utf8')).toBe('ok');
    const [envOutput] = toolResults(calls[1]!);
    const variables = Object.fromEntries((envOutput ?? '').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    expect(variables).toEqual({ ...BASH_ENV, PWD: workspaceDir });
    // 会话文件在 pi-sessions/ 中，不含令牌。
    expect(readdirSync(sessionsDir)).toEqual([outcome.session]);
    const sessionText = readFileSync(join(sessionsDir, outcome.session), 'utf8');
    expect(sessionText).toContain('按任务说明生成目录');
    expect(sessionText).not.toContain(TOKEN);
  });

  it('系统提示词带上工作区说明（Linux /bin/sh、断网、文件命名规则），不含桌面版的 Windows / macOS 说明', async () => {
    await prompt({ tools: [] });
    const system = systemPrompt(calls[0]!);
    expect(system).toContain('`/bin/sh`（dash）');
    expect(system).toContain('每条命令最多运行 5 分钟');
    expect(system).toContain('文件命名与保存');
    expect(system).toContain('当前环境没有外部网络');
    for (const desktop of ['PowerShell', 'Windows', 'macOS', '智标客户端']) expect(system).not.toContain(desktop);
    expect(calls[0]!.tools ?? []).toEqual([]);
  });

  it('工作区说明中的命名规则与 agent 模板的取回规则一致', () => {
    const instructions = readFileSync(INSTRUCTIONS_PATH, 'utf8');
    const output = SANDBOX_TEMPLATES.agent.output;
    const line = instructions.split('\n').find((text) => text.startsWith('- 文件扩展名只能是'))!;
    expect(new Set(line.replace(/^- 文件扩展名只能是 /, '').replace(/；$/, '').split('、'))).toEqual(output.extensions);
    expect(output.maxFiles).toBe(10_000);
    expect(instructions).toContain('文件总数不超过 10,000 个');
    expect(output.maxTotalBytes).toBe(512 * 1024 * 1024);
    expect(instructions).toContain('总大小不超过 512 MiB');
    expect(output.maxFileBytes).toBe(100 * 1024 * 1024);
    expect(instructions).toContain('单个文件不超过 100 MiB');
    expect(output.maxDepth).toBe(8);
    expect(instructions).toContain('路径最多 8 级（含文件名）');
    expect(output.pathSegments).toBe('unicode');
  });

  it('续接会话：带上之前的对话，写回同一个会话文件', async () => {
    const first = await prompt({ prompt: '第一条提示词' });
    calls.length = 0;
    replies = [{ content: '第二条完成' }];
    const second = await prompt({ prompt: '第二条提示词', session: first.session });
    expect(second).toEqual({ session: first.session, turns: 1, stopReason: 'stop' });
    const contents = calls[0]!.messages.map((message) => message.content);
    expect(contents).toEqual(expect.arrayContaining(['第一条提示词', '完成', '第二条提示词']));
    expect(readdirSync(sessionsDir)).toEqual([first.session]);
    expect(readFileSync(join(sessionsDir, first.session), 'utf8')).toContain('第二条完成');
  });

  it('会话文件不存在、是符号链接、是目录或内容无效时 SESSION_INVALID，不调用模型', async () => {
    const valid = (await prompt()).session;
    calls.length = 0;
    const missing = valid.replace(/^\d{4}/, '1999');
    await expect(prompt({ session: missing })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    // 指向有效会话文件的符号链接：不跟随。
    const linked = valid.replace(/^\d{4}/, '2001');
    symlinkSync(join(sessionsDir, valid), join(sessionsDir, linked));
    await expect(prompt({ session: linked })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    const directory = valid.replace(/^\d{4}/, '2002');
    mkdirSync(join(sessionsDir, directory));
    await expect(prompt({ session: directory })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    const corrupt = valid.replace(/^\d{4}/, '2003');
    writeFileSync(join(sessionsDir, corrupt), 'not a pi session\n');
    await expect(prompt({ session: corrupt })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(readFileSync(join(sessionsDir, corrupt), 'utf8')).toBe('not a pi session\n');
    expect(calls).toEqual([]);
  });

  it('只注册请求中的工具：模型调用未启用的 bash 时得到错误，命令不执行', async () => {
    replies = [{ toolCalls: [{ name: 'bash', arguments: { command: 'printf x > 不应出现.txt' } }] }, { content: '完成' }];
    const outcome = await prompt({ tools: ['read', 'ls'] });
    expect(outcome.turns).toBe(2);
    expect(calls[0]!.tools?.map((tool) => tool.name).sort()).toEqual(['ls', 'read']);
    expect(existsSync(join(workspaceDir, '不应出现.txt'))).toBe(false);
    expect(toolResults(calls[1]!).join('\n')).toMatch(/not found|not available|unknown/i);
  });

  it('json-validation（8.6c2a）：只在请求中时注册；预置 Schema 优先于 Agent 给出的 schema；结果交回模型，失败时为工具错误', async () => {
    writeFileSync(join(workspaceDir, '目录.json'), JSON.stringify({ items: [{ title: '概述' }] }));
    writeFileSync(join(workspaceDir, '其他.json'), JSON.stringify({ count: 'x' }));
    replies = [
      // 预置了 Schema：Agent 给出的宽松 schema 被忽略。
      { toolCalls: [{ name: 'json-validation', arguments: { file_path: '目录.json', schema: true } }] },
      // 没有预置：按 Agent 给出的 schema 校验。
      { toolCalls: [{ name: 'json-validation', arguments: { file_path: '其他.json', schema: { type: 'object', properties: { count: { type: 'integer' } } } } }] },
      // 没有预置、也没有给出 schema；路径超出工作区。
      { toolCalls: [{ name: 'json-validation', arguments: { file_path: '其他.json' } }, { name: 'json-validation', arguments: { file_path: '../outside.json' } }] },
      { content: '完成' },
    ];
    const jsonSchemas = { '目录.json': { type: 'object', required: ['items'], properties: { items: { type: 'array', minItems: 2 } } } };
    const outcome = await prompt({ tools: ['read', 'json-validation'], jsonSchemas });
    expect(outcome.turns).toBe(4);
    expect(calls[0]!.tools?.map((tool) => tool.name).sort()).toEqual(['json-validation', 'read']);
    const results = calls.slice(1).map((call) => toolResults(call).slice(-1)[0] ?? '');
    const parsed = [JSON.parse(results[0]!), JSON.parse(results[1]!)];
    expect(parsed[0]).toMatchObject({ valid: false, stage: 'validation', file_path: '目录.json', errors: [{ instancePath: '/items', keyword: 'minItems' }] });
    expect(parsed[1]).toMatchObject({ valid: false, stage: 'validation', file_path: '其他.json', errors: [{ instancePath: '/count', keyword: 'type' }] });
    const last = toolResults(calls[3]!).slice(-2).map((text) => JSON.parse(text));
    expect(last[0]).toMatchObject({ valid: false, stage: 'schema' });
    expect(last[0].errors[0].message).toContain('必须提供 schema');
    expect(last[1]).toMatchObject({ valid: false, stage: 'read' });
    // 不在请求中时不注册。
    calls.length = 0;
    await prompt({ tools: ['read'] });
    expect(calls[0]!.tools?.map((tool) => tool.name)).toEqual(['read']);
  });

  it('bash 命令的时限：模型给出的更短时限照常生效；更长的截到 5 分钟', async () => {
    expect(bashTimeoutSeconds(undefined)).toBe(BASH_COMMAND_TIMEOUT_SECONDS);
    expect(bashTimeoutSeconds(BASH_COMMAND_TIMEOUT_SECONDS * 10)).toBe(BASH_COMMAND_TIMEOUT_SECONDS);
    expect(bashTimeoutSeconds(Number.POSITIVE_INFINITY)).toBe(BASH_COMMAND_TIMEOUT_SECONDS);
    expect(bashTimeoutSeconds(10)).toBe(10);
    expect(bashTimeoutSeconds(-1)).toBe(-1);
    expect(BASH_COMMAND_TIMEOUT_SECONDS).toBe(300);
    replies = [{ toolCalls: [{ name: 'bash', arguments: { command: 'sleep 30; printf late > late.txt', timeout: 1 } }] }, { content: '完成' }];
    const started = Date.now();
    await prompt({ tools: ['bash'] });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(existsSync(join(workspaceDir, 'late.txt'))).toBe(false);
    expect(toolResults(calls[1]!).join('\n')).toMatch(/timed out|timeout/i);
  });

  it('一条提示词的轮数达到上限时 TURN_LIMIT', async () => {
    fallback = { toolCalls: [{ name: 'ls', arguments: {} }] };
    await expect(prompt({ maxTurns: 3 })).rejects.toMatchObject({ code: 'TURN_LIMIT' });
    // 第 4 轮开始时中止：至多发出第 4 轮的请求（中止前可能已经发出）。
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('平台拒绝（达到任务上限等）或流中途失败时 MODEL_FAILED', async () => {
    turnError = new AppError(409, 'TASK_TURN_LIMIT', '本任务的模型调用次数已达到上限');
    await expect(prompt()).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(calls).toEqual([]);
    turnError = null;
    replies = [{ content: '写到一半', error: new AppError(502, 'AI_UPSTREAM_ERROR', '上游失败') }];
    await expect(prompt()).rejects.toMatchObject({ code: 'MODEL_FAILED' });
  });

  it('输出达到上限时照常返回（stopReason = length）', async () => {
    replies = [{ content: '很长的回复', finishReason: 'length' }];
    expect(await prompt()).toMatchObject({ turns: 1, stopReason: 'length' });
  });

  describe('阶段交接压缩（runPiCompaction，8.6d2）', () => {
    /** 一个足够长、可以压缩的会话：两条提示词各约 40k token（Pi 保留最近约 20k token，从第二条提示词处切开、总结第一条）。 */
    async function longSession(): Promise<string> {
      replies = [{ content: '第一阶段完成' }, { content: '第二阶段完成' }];
      const first = await prompt({ prompt: `第一阶段资料：${'甲乙丙丁'.repeat(40_000)}` });
      await prompt({ prompt: `第二阶段：检查目录。${'戊己庚辛'.repeat(40_000)}`, session: first.session });
      calls.length = 0;
      authorizations.length = 0;
      rawBodies.length = 0;
      return first.session;
    }

    it('会话太短时无需压缩：compacted = false，不调用模型、会话文件不变', async () => {
      const { session } = await prompt();
      calls.length = 0;
      const before = readFileSync(join(sessionsDir, session), 'utf8');
      expect(await compact(session)).toEqual({ session, compacted: false });
      expect(calls).toEqual([]);
      expect(readFileSync(join(sessionsDir, session), 'utf8')).toBe(before);
    });

    it('按 worker 的指令压缩：经同一条路由、不注册工具、令牌只在 Authorization 中；续接时模型收到摘要；刚压缩过时无需压缩', async () => {
      const session = await longSession();
      replies = [{ content: '## 摘要\n第一阶段已完成，资料见工作区。' }];
      expect(await compact(session)).toEqual({ session, compacted: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.tools ?? []).toEqual([]);
      expect(JSON.stringify(calls[0]!.messages)).toContain(COMPACTION_INSTRUCTIONS);
      expect(authorizations).toEqual([`Bearer ${TOKEN}`]);
      for (const body of rawBodies) expect(body).not.toContain(TOKEN);
      expect(readdirSync(sessionsDir)).toEqual([session]);
      const text = readFileSync(join(sessionsDir, session), 'utf8');
      expect(text).toContain('"type":"compaction"');
      expect(text).not.toContain(TOKEN);
      // 刚压缩过：无需压缩。
      calls.length = 0;
      expect(await compact(session)).toEqual({ session, compacted: false });
      expect(calls).toEqual([]);
      // 续接：模型收到摘要，不再收到第一阶段的原文。
      replies = [{ content: '正文完成' }];
      await prompt({ prompt: '进入正文生成', session });
      const sent = JSON.stringify(calls[0]!.messages);
      expect(sent).toContain('第一阶段已完成，资料见工作区。');
      expect(sent).not.toContain('甲乙丙丁'.repeat(100));
      // 会话文件中的回复全文由 worker 取回（最后一条 assistant 消息）。
      expect(extractAgentAssistantText(readFileSync(join(sessionsDir, session)))).toEqual({ text: '正文完成', truncated: false });
    });

    it('会话文件不存在或内容无效时 SESSION_INVALID，不调用模型', async () => {
      const valid = (await prompt()).session;
      calls.length = 0;
      await expect(compact(valid.replace(/^\d{4}/, '1999'))).rejects.toMatchObject({ code: 'SESSION_INVALID' });
      const corrupt = valid.replace(/^\d{4}/, '2003');
      writeFileSync(join(sessionsDir, corrupt), 'not a pi session\n');
      await expect(compact(corrupt)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
      expect(calls).toEqual([]);
    });

    it('模型调用失败（平台拒绝、上游失败）时 MODEL_FAILED，会话文件中没有压缩', async () => {
      const session = await longSession();
      turnError = new AppError(402, 'INSUFFICIENT_BALANCE', '余额不足');
      await expect(compact(session)).rejects.toMatchObject({ code: 'MODEL_FAILED' });
      turnError = null;
      replies = [{ content: '写到一半', error: new AppError(502, 'AI_UPSTREAM_ERROR', '上游失败') }];
      await expect(compact(session)).rejects.toMatchObject({ code: 'MODEL_FAILED' });
      expect(readFileSync(join(sessionsDir, session), 'utf8')).not.toContain('"type":"compaction"');
    });
  });
});
