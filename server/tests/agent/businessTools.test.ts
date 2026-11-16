// agent 沙箱入口的业务工具桩（server/sandbox/agent/tools.mjs，路线图第 8 步 8.6c1）：
// - 桩的参数 schema 与 worker 登记的相同（去掉 description 后逐项比较），面向模型的名字与桌面版相同；
// - callBusinessTool：只发 POST /v1/tools/call、令牌只在 Authorization 中、请求体只有 { name, arguments }；
//   200 取 result；401 / 409 JOB_NOT_RUNNING 为 fatal（TOKEN_INVALID / RUN_ENDED）；其他 4xx 带 worker 的说明（截短）；
//   5xx、响应不合法、过大、无限长、不响应、连不上、中止只给固定说明，不带出响应正文；
// - 桩的行为：pending 时以相同参数再次调用；报告失败 / 用户选择终止时结束会话；fatal 时结束会话；选择继续时把 instruction 交给模型。
// 真实的 Pi 经真实路由调用桩的流程见 tests/agent/piBusinessTools.test.ts。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Type } from '../../sandbox/agent/node_modules/typebox/build/index.mjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { askUserTool } from '../../src/agent/askUserTool.ts';
import { reportFailureTool } from '../../src/agent/reportFailureTool.ts';
import { requestTerminationTool } from '../../src/agent/requestTerminationTool.ts';
import { generateAgentToken } from '../../src/agent/token.ts';
import { agentToolRegistry } from '../../src/agent/toolRegistry.ts';
import { BUSINESS_TOOLS } from '../../sandbox/agent/protocol.mjs';
import {
  callBusinessTool,
  createBusinessToolStubs,
  MAX_TOOL_ERROR_CHARS,
  MAX_TOOL_RESPONSE_BYTES,
  modelToolName,
  ToolCallError,
} from '../../sandbox/agent/tools.mjs';

const TOKEN = generateAgentToken();

/** 去掉 description，只比较约束。 */
function constraints(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(constraints);
  if (typeof schema !== 'object' || schema === null) return schema;
  const entries = Object.entries(JSON.parse(JSON.stringify(schema)) as Record<string, unknown>)
    .filter(([key]) => key !== 'description')
    .map(([key, value]) => [key, key === 'required' && Array.isArray(value) ? [...value].sort() : constraints(value)]);
  return Object.fromEntries(entries.sort(([a], [b]) => String(a).localeCompare(String(b))));
}

const noop = async () => ({});

describe('桩的定义', () => {
  it('参数 schema 与 worker 登记的相同；面向模型的名字：request-termination 为 report-failure', () => {
    const stubs = createBusinessToolStubs({ Type, names: [...BUSINESS_TOOLS], call: noop, end: () => {} });
    const server = { 'ask-user': askUserTool, 'report-failure': reportFailureTool, 'request-termination': requestTerminationTool } as const;
    BUSINESS_TOOLS.forEach((name, index) => {
      expect(constraints(stubs[index]!.parameters)).toEqual(constraints(server[name].argumentsSchema));
      expect(stubs[index]!.name).toBe(modelToolName(name));
      // 生产登记中有同名的工具。
      expect(agentToolRegistry.get(name)).toBeDefined();
    });
    expect(stubs.map((stub) => stub.name)).toEqual(['ask-user', 'report-failure', 'report-failure']);
    expect(stubs[2]!.label).toBe('请求终止任务');
    // 问题按纯文本显示（#84）：提示中不要求 Markdown。
    expect(stubs[0]!.promptGuidelines.join('\n')).toContain('不要使用 Markdown');
    expect(() => createBusinessToolStubs({ Type, names: ['openxml'], call: noop, end: () => {} })).toThrow();
  });
});

describe('callBusinessTool', () => {
  type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;
  let server: Server;
  let baseUrl: string;
  let handler: Handler;
  const received: Array<{ method: string | undefined; url: string | undefined; headers: IncomingMessage['headers']; body: string }> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        received.push({ method: request.method, url: request.url, headers: request.headers, body });
        handler(request, response, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    received.length = 0;
  });

  const json = (status: number, value: unknown): Handler => (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const call = (options: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    callBusinessTool({ baseUrl, token: TOKEN, name: 'ask-user', args: { question: '选哪个', options: [] }, ...options });
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolCallError);
    return error as ToolCallError;
  };

  it('只发 POST /v1/tools/call，令牌只在 Authorization 中，请求体只有 name 与 arguments；200 取 result', async () => {
    handler = json(200, { result: { answered: true, answer: '甲' } });
    expect(await call()).toEqual({ answered: true, answer: '甲' });
    expect(received).toHaveLength(1);
    const [entry] = received;
    expect([entry!.method, entry!.url]).toEqual(['POST', '/v1/tools/call']);
    expect(entry!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(entry!.body)).toEqual({ name: 'ask-user', arguments: { question: '选哪个', options: [] } });
    expect(entry!.body).not.toContain(TOKEN);
    handler = json(200, { result: null });
    expect(await call()).toBeNull();
  });

  it('401 → TOKEN_INVALID；409 JOB_NOT_RUNNING → RUN_ENDED；其他 4xx 带 worker 的说明（截短），不是 fatal', async () => {
    handler = json(401, { error: { code: 'AGENT_TOKEN_INVALID', message: '令牌无效' } });
    expect((await failure(call())).fatalCode).toBe('TOKEN_INVALID');
    handler = json(409, { error: { code: 'JOB_NOT_RUNNING', message: '任务不在执行中' } });
    expect((await failure(call())).fatalCode).toBe('RUN_ENDED');
    for (const [status, code, message] of [
      [400, 'AGENT_TOOL_INVALID_ARGUMENTS', '工具参数不合法：/options must NOT have fewer than 2 items'],
      [403, 'AGENT_TOOL_NOT_IN_STAGE', '当前阶段不能调用 ask-user，请只使用当前阶段说明的工具。'],
      [404, 'AGENT_TOOL_NOT_FOUND', '工具不存在或本任务不能使用'],
      [409, 'AGENT_QUESTION_PENDING', '已有一个问题在等待用户回答'],
      [429, 'AGENT_TOOL_RATE_LIMIT', '调用工具 ask-user 过于频繁，请稍后再试'],
    ] as const) {
      handler = json(status, { error: { code, message } });
      const error = await failure(call());
      expect(error.fatalCode).toBeNull();
      expect(error.message).toBe(message);
    }
    handler = json(400, { error: { code: 'X', message: '长'.repeat(MAX_TOOL_ERROR_CHARS + 100) } });
    expect(Array.from((await failure(call())).message)).toHaveLength(MAX_TOOL_ERROR_CHARS);
  });

  it('5xx、响应不合法、过大、无限长、不响应、连不上、中止：固定说明，不带出响应正文', async () => {
    const generic = '平台暂时无法执行该工具，请稍后重试';
    const cases: Handler[] = [
      json(500, { error: { code: 'INTERNAL', message: 'database password is hunter2' } }),
      json(502, { error: { message: 'upstream secret' } }),
      (_request, response) => response.end('not json'),
      json(200, { notResult: 'secret' }),
      json(200, ['secret']),
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(`{"result":"${'x'.repeat(MAX_TOOL_RESPONSE_BYTES)}"}`);
      },
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        const timer = setInterval(() => response.write('x'.repeat(64 * 1024)), 1);
        response.on('close', () => clearInterval(timer));
      },
      (_request, response) => response.writeHead(302, { location: 'http://example.com/' }).end(),
      json(400, { error: { code: 'X', message: '   ' } }),
    ];
    for (const next of cases) {
      handler = next;
      const error = await failure(call());
      expect(error.fatalCode).toBeNull();
      expect(error.message).toBe(generic);
    }
    handler = () => {};
    expect((await failure(call({ timeoutMs: 200 }))).message).toBe(generic);
    const controller = new AbortController();
    const pending = call({ signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await failure(pending)).message).toBe('工具调用已中止');
    expect((await failure(callBusinessTool({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, name: 'ask-user', args: {} }))).message).toBe(generic);
  });
});

describe('桩的行为', () => {
  const question = { question: '选哪个', options: [{ label: '甲', custom: false }, { label: '乙', custom: false }] };

  function stubs(responses: Array<unknown | ToolCallError>, names: readonly string[] = BUSINESS_TOOLS.filter((name) => name !== 'request-termination')) {
    const calls: Array<{ name: string; args: unknown }> = [];
    const ended: string[] = [];
    const list = createBusinessToolStubs({
      Type,
      names,
      call: async (name, args) => {
        calls.push({ name, args: structuredClone(args) });
        const next = responses.shift();
        if (next instanceof ToolCallError) throw next;
        return next;
      },
      end: (code) => ended.push(code),
    });
    return { list, calls, ended };
  }

  it('ask-user：pending 时以完全相同的参数再次调用，不交给模型；回答后把结果交给模型', async () => {
    const answer = { answered: true, answer: '甲', selected_option: '甲', is_custom: false };
    const { list, calls, ended } = stubs([{ answered: false, pending: true, message: 'm' }, { answered: false, pending: true, message: 'm' }, answer]);
    const result = await list[0]!.execute('call-1', question);
    expect(calls).toEqual([0, 1, 2].map(() => ({ name: 'ask-user', args: question })));
    expect(JSON.parse(result.content[0]!.text)).toEqual(answer);
    expect(ended).toEqual([]);
  });

  it('report-failure：报告成功后结束会话（REPORTED_FAILURE）', async () => {
    const { list, calls, ended } = stubs([{ reported: true }]);
    await list[1]!.execute('call-1', { reason: '缺少评分表' });
    expect(calls).toEqual([{ name: 'report-failure', args: { reason: '缺少评分表' } }]);
    expect(ended).toEqual(['REPORTED_FAILURE']);
  });

  it('request-termination：pending 再次调用；终止时结束会话；继续时把 instruction 交给模型、不结束；结果不合法时报工具错误', async () => {
    const names = ['request-termination'];
    let run = stubs([{ answered: false, pending: true, message: 'm' }, { terminated: true, reason: 'r' }], names);
    await run.list[0]!.execute('c', { reason: 'r' });
    expect(run.calls.map((item) => item.name)).toEqual(['request-termination', 'request-termination']);
    expect(run.ended).toEqual(['REPORTED_FAILURE']);

    run = stubs([{ terminated: false, selected_option: '补充处理要求', user_reply: '先做第一章', instruction: '用户选择不终止任务，要求继续执行。' }], names);
    const result = await run.list[0]!.execute('c', { reason: 'r' });
    expect(result.content[0]!.text).toBe('用户选择不终止任务，要求继续执行。');
    expect(result.details).toEqual({ terminated: false, selected_option: '补充处理要求', user_reply: '先做第一章' });
    expect(run.ended).toEqual([]);

    run = stubs([{ unexpected: true }], names);
    await expect(run.list[0]!.execute('c', { reason: 'r' })).rejects.toThrow('平台暂时无法执行该工具，请稍后重试');
    expect(run.ended).toEqual([]);
  });

  it('fatal 错误结束会话（TOKEN_INVALID / RUN_ENDED）并作为工具错误交给模型；其他错误只交给模型', async () => {
    let run = stubs([new ToolCallError('x', 'TOKEN_INVALID')]);
    await expect(run.list[0]!.execute('c', question)).rejects.toThrow();
    expect(run.ended).toEqual(['TOKEN_INVALID']);
    run = stubs([new ToolCallError('x', 'RUN_ENDED')]);
    await expect(run.list[1]!.execute('c', { reason: 'r' })).rejects.toThrow();
    expect(run.ended).toEqual(['RUN_ENDED']);
    run = stubs([new ToolCallError('当前阶段不能调用 ask-user，请只使用当前阶段说明的工具。')]);
    await expect(run.list[0]!.execute('c', question)).rejects.toThrow('当前阶段不能调用 ask-user，请只使用当前阶段说明的工具。');
    expect(run.ended).toEqual([]);
  });
});
