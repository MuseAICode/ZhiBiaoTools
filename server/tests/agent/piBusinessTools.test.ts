// 入口中的业务工具桩（server/sandbox/agent/tools.mjs、pi.mjs，路线图第 8 步 8.6c1）：真实的 Pi 运行时经**真实的模型调用路由**
// 与**真实的工具路由**（registerAgentToolRoute：请求体 schema、按工具名套用 worker 登记的参数 schema、错误格式同生产；计数与阶段换成
// 按脚本回答的桩，数据库中的阶段限制见 tests/db/agentToolScopes.test.ts），AI 网关与工具的处理函数用按脚本回答的桩代替。覆盖：
// - 只登记请求中的业务工具，面向模型的名字与桌面版相同（request-termination 为 report-failure）；未请求的不登记、不发请求；
// - 桩发出的请求通过工具路由的严格 schema，令牌只在 Authorization 中；
// - ask-user 的 pending 由桩以相同参数再次调用、不交给模型；回答交给模型后会话照常结束；
// - report-failure 报告成功、request-termination 选择终止 → 会话立即结束（REPORTED_FAILURE），之后不再调用模型；
//   选择继续时 instruction 作为工具结果交给模型；
// - 阶段外（403）、参数不合法（400）的说明作为工具错误交给模型；401 → TOKEN_INVALID、409 JOB_NOT_RUNNING → RUN_ENDED，立即结束。
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { askUserTool } from '../../src/agent/askUserTool.ts';
import { registerAgentChatRoute } from '../../src/agent/chatCompletions.ts';
import { reportFailureTool } from '../../src/agent/reportFailureTool.ts';
import { requestTerminationTool } from '../../src/agent/requestTerminationTool.ts';
import { generateAgentToken } from '../../src/agent/token.ts';
import type { AgentTokenIdentity } from '../../src/agent/tokenStore.ts';
import { createAgentToolRegistry, registerAgentToolRoute, type AgentToolCallOutcome, type AgentToolDefinition } from '../../src/agent/tools.ts';
import type { AiGateway, ChatDelta, ChatRequest, ChatResult } from '../../src/ai/gateway.ts';
import { AppError, registerErrorHandlers } from '../../src/errors.ts';
import { runPiPrompt } from '../../sandbox/agent/pi.mjs';
import { EntryError, NATIVE_TOOLS, type PromptRequest, type RequestTool } from '../../sandbox/agent/protocol.mjs';

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

interface Reply {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

const chatCalls: ChatRequest[] = [];
let replies: Reply[] = [];

const stubGateway: AiGateway = {
  async chat(_context, request, options = {}) {
    chatCalls.push(request);
    const reply = replies.shift() ?? { content: '完成' };
    const toolCalls = (reply.toolCalls ?? []).map((call) => ({ id: `call_${randomUUID().slice(0, 8)}`, name: call.name, arguments: JSON.stringify(call.arguments) }));
    const delta: ChatDelta = {};
    if (reply.content !== undefined) delta.content = reply.content;
    if (toolCalls.length > 0) delta.toolCalls = toolCalls.map((call, index) => ({ index, id: call.id, name: call.name, arguments: call.arguments }));
    options.onDelta?.(delta);
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
  },
};

/** 工具处理函数的脚本：按调用顺序给出结果或抛出的错误。 */
const toolCalls: Array<{ name: string; args: unknown; authorization: string | undefined; rawBody: string }> = [];
let toolScript: Array<unknown | AppError> = [];
/** 计数桩的结果（null 放行；not-in-stage 等模拟 worker 一侧的阶段限制）。 */
let beginOutcome: AgentToolCallOutcome | null = null;

function scripted(definition: AgentToolDefinition): AgentToolDefinition {
  return {
    ...definition,
    async run(_context, args) {
      const next = toolScript.shift();
      if (next instanceof AppError) throw next;
      return next;
    },
  };
}

let app: FastifyInstance;
let baseUrl: string;
const lastRequest: { authorization: string | undefined; body: string } = { authorization: undefined, body: '' };

beforeAll(async () => {
  app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }, bodyLimit: 8 * 1024 * 1024, forceCloseConnections: true });
  registerErrorHandlers(app);
  app.removeContentTypeParser('text/plain');
  app.addHook('preParsing', async (request, _reply, payload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    lastRequest.authorization = request.headers.authorization;
    lastRequest.body = raw.toString('utf8');
    const { Readable } = await import('node:stream');
    return Readable.from([raw]);
  });
  app.addHook('preHandler', async (request) => {
    if (request.url === '/v1/tools/call') {
      const body = request.body as { name: string; arguments: unknown };
      toolCalls.push({ name: body.name, args: body.arguments, authorization: lastRequest.authorization, rawBody: lastRequest.body });
    }
  });
  registerAgentChatRoute(app, {
    resolveModel: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    gateway: stubGateway,
    maxOutputTokens: 4096,
    identityOf: () => IDENTITY,
    beginTurn: async () => {},
    markCostLimit: async () => {},
    track: () => () => {},
  });
  registerAgentToolRoute(app, {
    db: null as never,
    tools: createAgentToolRegistry([scripted(askUserTool), scripted(reportFailureTool), scripted(requestTerminationTool)]),
    toolsForJobType: () => ['ask-user', 'report-failure', 'request-termination'],
    identityOf: () => IDENTITY,
    track: () => () => {},
    beginCall: async () => beginOutcome,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app?.close();
});

let root: string;
let workspaceDir: string;
beforeEach(() => {
  chatCalls.length = 0;
  toolCalls.length = 0;
  replies = [];
  toolScript = [];
  beginOutcome = null;
  root = mkdtempSync(join(tmpdir(), 'zhibiao-pi-tools-'));
  workspaceDir = join(root, 'workspace');
  mkdirSync(workspaceDir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const prompt = (tools: RequestTool[]) => {
  const request: PromptRequest = {
    version: 1,
    action: 'prompt',
    token: TOKEN,
    prompt: '按任务说明生成目录',
    session: null,
    tools,
    maxTurns: 20,
    model: { contextWindow: 128_000, maxOutputTokens: 8_192 },
  };
  return runPiPrompt(request, { baseUrl, workspaceDir, sessionsDir: join(workspaceDir, 'pi-sessions'), agentDir: join(root, 'agent') });
};

const entryCode = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(EntryError);
  return (error as EntryError).code;
};
const toolMessages = (request: ChatRequest) => request.messages.filter((message) => message.role === 'tool').map((message) => message.content);
const QUESTION = { question: '目录按评分项还是按章节组织？', options: [{ label: '按评分项', custom: false }, { label: '按章节', custom: false }] };

describe('业务工具的桩（真实 Pi）', () => {
  it('只登记请求中的业务工具，名字与桌面版相同；未请求的业务工具不登记、不发请求', async () => {
    await prompt([...NATIVE_TOOLS, 'ask-user', 'request-termination']);
    expect(chatCalls[0]!.tools?.map((tool) => tool.name).sort()).toEqual([...NATIVE_TOOLS, 'ask-user', 'report-failure'].sort());
    const termination = chatCalls[0]!.tools!.find((tool) => tool.name === 'report-failure')!;
    expect(termination.description).toContain('程序会向用户说明原因并确认是否终止');

    chatCalls.length = 0;
    replies = [{ toolCalls: [{ name: 'ask-user', arguments: QUESTION }] }, { content: '完成' }];
    expect(await prompt(['read'])).toMatchObject({ stopReason: 'stop' });
    expect(chatCalls[0]!.tools?.map((tool) => tool.name)).toEqual(['read']);
    expect(toolCalls).toEqual([]);
  });

  it('ask-user：请求通过工具路由的 schema，令牌只在 Authorization 中；pending 由桩以相同参数再次调用，回答交给模型', async () => {
    const answer = { answered: true, answer: '按评分项', selected_option: '按评分项', is_custom: false };
    toolScript = [{ answered: false, pending: true, message: 'm' }, answer];
    replies = [{ toolCalls: [{ name: 'ask-user', arguments: QUESTION }] }, { content: '完成' }];
    const outcome = await prompt(['ask-user']);
    expect(outcome).toMatchObject({ turns: 2, stopReason: 'stop' });
    expect(toolCalls.map((call) => [call.name, call.args])).toEqual([['ask-user', QUESTION], ['ask-user', QUESTION]]);
    for (const call of toolCalls) {
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.rawBody).not.toContain(TOKEN);
      expect(Object.keys(JSON.parse(call.rawBody)).sort()).toEqual(['arguments', 'name']);
    }
    // 模型只看到回答，看不到 pending。
    expect(chatCalls).toHaveLength(2);
    expect(toolMessages(chatCalls[1]!).map((content) => JSON.parse(content))).toEqual([answer]);
  });

  it('report-failure：报告成功后立即结束会话（REPORTED_FAILURE），不再调用模型', async () => {
    toolScript = [{ reported: true }];
    replies = [{ toolCalls: [{ name: 'report-failure', arguments: { reason: '招标文件没有评分表' } }] }, { content: '不该被调用' }];
    expect(await entryCode(prompt(['report-failure']))).toBe('REPORTED_FAILURE');
    expect(toolCalls.map((call) => [call.name, call.args])).toEqual([['report-failure', { reason: '招标文件没有评分表' }]]);
    expect(chatCalls).toHaveLength(1);
  });

  it('request-termination（面向模型为 report-failure）：选择终止即结束；选择继续时 instruction 交给模型', async () => {
    toolScript = [{ answered: false, pending: true, message: 'm' }, { terminated: true, reason: '缺资料' }];
    replies = [{ toolCalls: [{ name: 'report-failure', arguments: { reason: '缺资料' } }] }, { content: '不该被调用' }];
    expect(await entryCode(prompt(['request-termination']))).toBe('REPORTED_FAILURE');
    expect(toolCalls.map((call) => call.name)).toEqual(['request-termination', 'request-termination']);
    expect(chatCalls).toHaveLength(1);

    chatCalls.length = 0;
    toolCalls.length = 0;
    const instruction = '用户选择不终止任务，要求继续执行。\n- 质量要求已放宽';
    toolScript = [{ terminated: false, selected_option: '降低质量继续', instruction }];
    replies = [{ toolCalls: [{ name: 'report-failure', arguments: { reason: '缺资料' } }] }, { content: '已按放宽后的要求完成' }];
    expect(await prompt(['request-termination'])).toMatchObject({ stopReason: 'stop', turns: 2 });
    expect(toolMessages(chatCalls[1]!)).toEqual([instruction]);
  });

  it('阶段外（403）与参数不合法（400）的说明作为工具错误交给模型，会话照常继续', async () => {
    beginOutcome = 'not-in-stage';
    replies = [{ toolCalls: [{ name: 'ask-user', arguments: QUESTION }] }, { toolCalls: [{ name: 'ask-user', arguments: { ...QUESTION, options: [QUESTION.options[0]!] } }] }, { content: '完成' }];
    expect(await prompt(['ask-user'])).toMatchObject({ stopReason: 'stop' });
    expect(toolMessages(chatCalls[1]!).join('\n')).toContain('当前阶段不能调用 ask-user，请只使用当前阶段说明的工具。');
    // 第二次：参数只有一个选项，Pi 本地按同一 schema 先拒绝（不发请求）；worker 一侧同样会 400。
    expect(toolMessages(chatCalls[2]!).at(-1)).toMatch(/options/);
    expect(toolCalls.map((call) => call.name)).toEqual(['ask-user']);

    // 桩不在本地校验时，worker 的 400 说明同样交给模型（直接调用工具路由）。
    beginOutcome = null;
    const response = await fetch(`${baseUrl}/v1/tools/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ask-user', arguments: { question: 'q', options: [] } }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('AGENT_TOOL_INVALID_ARGUMENTS');
  });

  it('401 → TOKEN_INVALID、409 JOB_NOT_RUNNING → RUN_ENDED：立即结束会话，不再调用模型；409 另有问题在等待只交给模型', async () => {
    toolScript = [new AppError(401, 'AGENT_TOKEN_INVALID', '令牌无效')];
    replies = [{ toolCalls: [{ name: 'ask-user', arguments: QUESTION }] }, { content: '不该被调用' }];
    expect(await entryCode(prompt(['ask-user']))).toBe('TOKEN_INVALID');
    expect(chatCalls).toHaveLength(1);

    chatCalls.length = 0;
    beginOutcome = 'not-running';
    replies = [{ toolCalls: [{ name: 'report-failure', arguments: { reason: 'r' } }] }, { content: '不该被调用' }];
    expect(await entryCode(prompt(['report-failure']))).toBe('RUN_ENDED');
    expect(chatCalls).toHaveLength(1);

    chatCalls.length = 0;
    beginOutcome = null;
    toolScript = [new AppError(409, 'AGENT_QUESTION_PENDING', '已有一个问题在等待用户回答，请先等待该问题的回答')];
    replies = [{ toolCalls: [{ name: 'ask-user', arguments: QUESTION }] }, { content: '完成' }];
    expect(await prompt(['ask-user'])).toMatchObject({ stopReason: 'stop' });
    expect(toolMessages(chatCalls[1]!).join('\n')).toContain('已有一个问题在等待用户回答');
  });
});
