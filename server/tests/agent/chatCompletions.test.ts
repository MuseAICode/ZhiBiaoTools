// Agent 的模型调用路由（src/agent/chatCompletions.ts，路线图第 8 步 8.2c2）的单元测试：AI 网关用记录请求的桩代替，
// 身份与模型由桩给出。覆盖：Pi（openai-completions）请求格式的对照组、请求转成网关字段（身份只按令牌、模型固定、只转校验过的字段）、
// 伪造的身份 / 服务商 / Base URL 字段与不接受的字段一律 400 且不调用网关、各上限、SSE 输出格式（分段、工具调用、续跑取回、
// 开始推送前后的失败）。真实数据库、AI 网关与 agent-gw 的端到端用例见 tests/db/agentChat.test.ts。
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_CHAT_MAX_BODY_BYTES,
  AGENT_CHAT_MAX_MESSAGES,
  AGENT_CHAT_PATH,
  AGENT_CHAT_STEP_KEY,
  registerAgentChatRoute,
} from '../../src/agent/chatCompletions.ts';
import { AGENT_GATEWAY_ROUTES } from '../../src/agent/gateway.ts';
import type { AgentTokenIdentity } from '../../src/agent/tokenStore.ts';
import type { AiGateway, ChatDelta, ChatOptions, ChatRequest, ChatResult } from '../../src/ai/gateway.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { AppError, registerErrorHandlers } from '../../src/errors.ts';
import type { JobModel } from '../../src/jobs/chat.ts';
import { JobError } from '../../src/jobs/definitions.ts';

const PLATFORM_MAX_OUTPUT = 4096;
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
const PLATFORM_MODEL: JobModel = { provider: 'deepseek', model: 'deepseek-chat' };

interface Call {
  context: TenantContext;
  request: ChatRequest;
  options: ChatOptions;
}

/** 网关桩的行为：依次交给 onDelta 的段、返回的结果，或抛出的错误（可在给出若干段之后）。 */
interface Script {
  deltas?: ChatDelta[];
  result?: Partial<ChatResult>;
  error?: unknown;
  /** 给出 deltas 后等待这个 Promise 再结束（用于断开、关闭的用例）。 */
  hold?: (signal: AbortSignal) => Promise<void>;
}

const calls: Call[] = [];
let script: Script = {};
let resolveModel: (context: TenantContext) => Promise<JobModel> = async () => PLATFORM_MODEL;
const inFlight = new Set<AbortController>();

const stubGateway: AiGateway = {
  async chat(context, request, options = {}) {
    calls.push({ context, request, options });
    for (const delta of script.deltas ?? []) options.onDelta?.(delta);
    if (script.hold) await script.hold(options.signal!);
    if (script.error) throw script.error;
    const aborted = options.signal?.aborted ?? false;
    return {
      requestId: randomUUID(),
      content: (script.deltas ?? []).map((delta) => delta.content ?? '').join(''),
      reasoningContent: '',
      toolCalls: [],
      finishReason: 'stop',
      aborted,
      reused: false,
      usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30, usageSource: 'provider' },
      billing: { status: 'billed', amount: 1n },
      ...script.result,
    };
  },
};

async function buildApp(gateway: AiGateway | null): Promise<{ app: FastifyInstance; origin: string }> {
  // 与 src/agent/endpoint.ts 相同的 ajv 设置（不删除多余字段、不做类型转换）与错误处理。
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }, bodyLimit: 8 * 1024 * 1024, forceCloseConnections: true });
  registerErrorHandlers(app);
  app.removeContentTypeParser('text/plain');
  registerAgentChatRoute(app, {
    resolveModel: (context) => resolveModel(context),
    gateway,
    maxOutputTokens: PLATFORM_MAX_OUTPUT,
    identityOf: () => IDENTITY,
    track(controller) {
      inFlight.add(controller);
      return () => inFlight.delete(controller);
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, origin: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

let app: FastifyInstance;
let origin: string;

beforeAll(async () => {
  ({ app, origin } = await buildApp(stubGateway));
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  calls.length = 0;
  script = { deltas: [{ content: '你好' }, { content: '，世界' }] };
  resolveModel = async () => PLATFORM_MODEL;
});

/** Pi（@earendil-works/pi-ai 的 openai-completions，本平台的 compat 配置）发出的请求形状。 */
function piBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'default',
    messages: [
      { role: 'system', content: '你是投标文件助手。' },
      { role: 'user', content: [{ type: 'text', text: '生成目录' }, { type: 'text', text: '，并校验。' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', content: 'a.json', tool_call_id: 'call_1' },
    ],
    stream: true,
    store: false,
    max_tokens: 2000,
    tools: [{ type: 'function', function: { name: 'bash', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } }, strict: false } }],
    tool_choice: 'auto',
    ...overrides,
  };
}

async function post(body: unknown, init: { raw?: string; contentType?: string } = {}) {
  const response = await fetch(`${origin}${AGENT_CHAT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': init.contentType ?? 'application/json' },
    body: init.raw ?? JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', text };
}

/** 解析 SSE：每个 data 行一项，[DONE] 原样保留。 */
function events(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => {
      const data = block.slice('data: '.length);
      return data === '[DONE]' ? data : JSON.parse(data);
    });
}

describe('对照组：Pi 的请求', () => {
  it('转成网关字段：身份按令牌、模型取组织设置、步骤键固定；SSE 按 OpenAI 格式分段、结束块、[DONE]', async () => {
    const response = await post(piBody());
    expect(response.status, response.text).toBe(200);
    expect(response.contentType).toBe('text/event-stream; charset=utf-8');
    expect(calls).toHaveLength(1);
    const { context, request, options } = calls[0]!;
    expect(context).toEqual({ orgId: IDENTITY.orgId, userId: IDENTITY.userId, role: IDENTITY.role });
    expect(request).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是投标文件助手。' },
        { role: 'user', content: '生成目录，并校验。' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }] },
        { role: 'tool', content: 'a.json', toolCallId: 'call_1' },
      ],
      maxOutputTokens: 2000,
      temperature: undefined,
      tools: [{ name: 'bash', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
      toolChoice: 'auto',
      source: 'job',
      jobId: IDENTITY.jobId,
      jobType: IDENTITY.jobType,
      stepKey: AGENT_CHAT_STEP_KEY,
    });
    expect(options.concurrencyWaitMs).toBe(Number.POSITIVE_INFINITY);

    const items = events(response.text) as any[];
    expect(items.at(-1)).toBe('[DONE]');
    expect(items[0]).toMatchObject({ object: 'chat.completion.chunk', model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }] });
    expect(items[1].choices[0].delta).toEqual({ content: '，世界' });
    expect(items[2].choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
    // 没有要求用量时不发用量块。
    expect(items).toHaveLength(4);
    // 响应中没有内部标识。
    for (const id of [IDENTITY.orgId, IDENTITY.jobId, IDENTITY.userId, IDENTITY.projectId, IDENTITY.runId]) expect(response.text).not.toContain(id);
  });

  it('stream_options.include_usage：结束块之后发用量块（计费用量）', async () => {
    const items = events((await post(piBody({ stream_options: { include_usage: true } }))).text) as any[];
    expect(items.at(-2)).toMatchObject({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } } });
  });

  it('工具调用分段转回 delta.tool_calls（id 与 type 只在第一段），finish_reason 为 tool_calls', async () => {
    script = {
      deltas: [
        { toolCalls: [{ index: 0, id: 'call_9', name: 'read' }] },
        { toolCalls: [{ index: 0, arguments: '{"path":' }] },
        { toolCalls: [{ index: 0, arguments: '"a.json"}' }, { index: 1, id: 'call_10', name: 'ls', arguments: '{}' }] },
      ],
      result: { finishReason: 'tool_calls' },
    };
    const items = events((await post(piBody())).text) as any[];
    expect(items[0].choices[0].delta).toEqual({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'read' } }] });
    expect(items[1].choices[0].delta).toEqual({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] });
    expect(items[2].choices[0].delta.tool_calls).toEqual([
      { index: 0, function: { arguments: '"a.json"}' } },
      { index: 1, id: 'call_10', type: 'function', function: { name: 'ls', arguments: '{}' } },
    ]);
    expect(items[3].choices[0].finish_reason).toBe('tool_calls');
  });

  it('续跑取回已保存的结果（没有分段输出）：一次给出全部内容与工具调用', async () => {
    script = {
      deltas: [],
      result: { content: '已保存', toolCalls: [{ id: 'call_1', name: 'bash', arguments: '{}' }], finishReason: 'tool_calls', reused: true },
    };
    const items = events((await post(piBody())).text) as any[];
    expect(items[0].choices[0].delta).toEqual({
      role: 'assistant',
      content: '已保存',
      tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    });
    expect(items[1].choices[0].finish_reason).toBe('tool_calls');
    expect(items.at(-1)).toBe('[DONE]');
  });

  it('思考内容照常计费但不转给沙箱', async () => {
    script = { deltas: [{ reasoningContent: '思考……' }, { content: '答' }] };
    const response = await post(piBody());
    expect(response.text).not.toContain('思考');
    expect((events(response.text) as any[])[0].choices[0].delta).toEqual({ role: 'assistant', content: '答' });
  });

  it('空的 tools 数组按不提供工具处理；只有工具调用的 assistant 可以省略 content；temperature 原样转', async () => {
    const body = piBody({ tools: [], tool_choice: undefined, temperature: 0.3 });
    (body.messages as any[])[2] = { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] };
    expect((await post(body)).status).toBe(200);
    expect(calls[0]!.request.tools).toBeUndefined();
    expect(calls[0]!.request.toolChoice).toBeUndefined();
    expect(calls[0]!.request.temperature).toBe(0.3);
    expect(calls[0]!.request.messages[2]).toEqual({ role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'bash', arguments: '{}' }] });
  });

  it('指定工具的 tool_choice 转成网关格式；max_completion_tokens 与 max_tokens 等价', async () => {
    expect((await post(piBody({ tool_choice: { type: 'function', function: { name: 'bash' } }, max_tokens: undefined, max_completion_tokens: 100 }))).status).toBe(200);
    expect(calls[0]!.request.toolChoice).toEqual({ name: 'bash' });
    expect(calls[0]!.request.maxOutputTokens).toBe(100);
  });

  it('路由已登记到 agent-gw，请求体上限与 worker 入口相同', () => {
    expect(AGENT_GATEWAY_ROUTES).toContainEqual({ method: 'POST', path: AGENT_CHAT_PATH, bodyLimit: AGENT_CHAT_MAX_BODY_BYTES });
  });
});

describe('模型固定、上限', () => {
  it('请求中的 model 不采信：网关收到的是组织选用的平台模型', async () => {
    expect((await post(piBody({ model: 'qwen-max' }))).status).toBe(200);
    expect(calls[0]!.request).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('max_tokens 截到平台上限；不给时取平台上限', async () => {
    await post(piBody({ max_tokens: 1_000_000 }));
    await post(piBody({ max_tokens: undefined }));
    expect(calls.map((call) => call.request.maxOutputTokens)).toEqual([PLATFORM_MAX_OUTPUT, PLATFORM_MAX_OUTPUT]);
  });

  it(`消息条数：${AGENT_CHAT_MAX_MESSAGES} 条通过，多一条 400`, async () => {
    const messages = (count: number) => Array.from({ length: count }, () => ({ role: 'user', content: 'x' }));
    expect((await post(piBody({ messages: messages(AGENT_CHAT_MAX_MESSAGES), tools: undefined, tool_choice: undefined }))).status).toBe(200);
    expect((await post(piBody({ messages: messages(AGENT_CHAT_MAX_MESSAGES + 1), tools: undefined, tool_choice: undefined }))).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('请求体超过上限：413，不调用网关', async () => {
    const response = await post(piBody({ messages: [{ role: 'user', content: 'x'.repeat(AGENT_CHAT_MAX_BODY_BYTES) }] }));
    expect(response.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

describe('恶意样本：一律 400，不调用网关', () => {
  const forged: Array<[string, Record<string, unknown>]> = [
    ['org_id', { org_id: randomUUID() }],
    ['project_id', { project_id: randomUUID() }],
    ['job_id', { job_id: randomUUID() }],
    ['user_id', { user_id: randomUUID() }],
    ['user（OpenAI 的终端用户字段）', { user: randomUUID() }],
    ['provider', { provider: 'qwen' }],
    ['base_url', { base_url: 'http://169.254.169.254/' }],
    ['baseURL', { baseURL: 'http://attacker.example/' }],
    ['api_key', { api_key: 'sk-attacker' }],
    ['额外请求头', { headers: { 'x-api-key': 'sk-attacker' } }],
    ['extra_body', { extra_body: { base_url: 'http://attacker.example/' } }],
    ['stream: false', { stream: false }],
    ['stream 缺失', { stream: undefined }],
    ['store: true', { store: true }],
    ['n', { n: 5 }],
    ['logprobs', { logprobs: true }],
    ['response_format', { response_format: { type: 'json_object' } }],
    ['reasoning_effort', { reasoning_effort: 'high' }],
    ['enable_thinking', { enable_thinking: true }],
    ['max_tokens 为字符串（不做类型转换）', { max_tokens: '100' }],
    ['max_tokens 为 0', { max_tokens: 0 }],
    ['max_tokens 与 max_completion_tokens 同时给', { max_completion_tokens: 100 }],
    ['temperature 超出范围', { temperature: 3 }],
    ['stream_options 带多余字段', { stream_options: { include_usage: true, org_id: randomUUID() } }],
    ['model 带非法字符', { model: 'a b\n' }],
    ['工具带 strict: true', { tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' }, strict: true } }] }],
    ['工具带多余字段', { tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } }, base_url: 'x' }] }],
    ['工具类型不是 function', { tools: [{ type: 'code_interpreter', function: { name: 'bash', parameters: { type: 'object' } } }] }],
    ['工具缺参数定义', { tools: [{ type: 'function', function: { name: 'bash' } }] }],
    ['工具名不合法（网关校验）', { tools: [{ type: 'function', function: { name: 'bad name', parameters: { type: 'object' } } }] }],
    ['tool_choice 指定的工具不在列表中（网关校验）', { tool_choice: { type: 'function', function: { name: 'other' } } }],
    ['tool_choice 带多余字段', { tool_choice: { type: 'function', function: { name: 'bash' }, org_id: 'x' } }],
    ['messages 为空', { messages: [] }],
  ];

  it.each(forged)('顶层字段：%s', async (_name, overrides) => {
    const response = await post(piBody(overrides));
    expect(response.status, response.text).toBe(400);
    expect(JSON.parse(response.text).error.code).toMatch(/^(BAD_REQUEST|INVALID_AI_REQUEST)$/);
    expect(calls).toHaveLength(0);
  });

  const forgedMessages: Array<[string, unknown]> = [
    ['消息带 org_id', { role: 'user', content: 'x', org_id: randomUUID() }],
    ['消息带 name', { role: 'user', content: 'x', name: 'admin' }],
    ['tool 消息带 name（本平台配置下 Pi 不发送）', { role: 'tool', content: 'x', tool_call_id: 'call_1', name: 'bash' }],
    ['未知角色', { role: 'developer', content: 'x' }],
    ['function 角色', { role: 'function', content: 'x', name: 'bash' }],
    ['图片', { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    ['远程图片', { role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://attacker.example/a.png' } }] }],
    ['文本分段带多余字段', { role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }],
    ['assistant 带思考内容', { role: 'assistant', content: 'x', reasoning_content: '…' }],
    ['user 带工具调用', { role: 'user', content: 'x', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{}' } }] }],
    ['user 带 tool_call_id', { role: 'user', content: 'x', tool_call_id: 'call_1' }],
    ['tool 消息缺 tool_call_id', { role: 'tool', content: 'x' }],
    ['tool 消息回应不存在的调用（网关校验）', { role: 'tool', content: 'x', tool_call_id: 'call_404' }],
    ['system 的 content 为 null', { role: 'system', content: null }],
    ['user 缺 content', { role: 'user' }],
    ['content 为数字', { role: 'user', content: 1 }],
    ['工具调用带多余字段', { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' }, org_id: 'x' }] }],
    ['工具调用的 arguments 不是字符串', { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: {} } }] }],
  ];

  it.each(forgedMessages)('消息：%s', async (_name, message) => {
    const body = piBody();
    (body.messages as unknown[]).push(message);
    const response = await post(body);
    expect(response.status, response.text).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('__proto__ 键（原型污染）：400', async () => {
    const raw = JSON.stringify(piBody()).replace('"stream":true', '"stream":true,"__proto__":{"org_id":"x"}');
    expect((await post(null, { raw })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('不是 JSON 的内容类型：415', async () => {
    expect((await post(null, { raw: JSON.stringify(piBody()), contentType: 'text/plain' })).status).toBe(415);
    expect(calls).toHaveLength(0);
  });
});

describe('失败', () => {
  it('开始推送前的失败（如余额不足）：普通 JSON 错误与状态码', async () => {
    script = { error: new AppError(402, 'INSUFFICIENT_BALANCE', '余额不足') };
    const response = await post(piBody());
    expect(response.status).toBe(402);
    expect(JSON.parse(response.text).error).toMatchObject({ code: 'INSUFFICIENT_BALANCE', message: '余额不足' });
  });

  it('开始推送后的失败：以 data: {"error"} 结束，不发 [DONE]；非业务错误不带出内部信息', async () => {
    script = { deltas: [{ content: '你好' }], error: new AppError(502, 'AI_UPSTREAM_ERROR', '模型服务调用失败，本次调用不收费') };
    let items = events((await post(piBody())).text) as any[];
    expect(items.at(-1)).toMatchObject({ error: { code: 'AI_UPSTREAM_ERROR', type: 'server_error' } });
    expect(items).not.toContain('[DONE]');

    script = { deltas: [{ content: '你好' }], error: new Error('internal detail: postgres://secret') };
    const response = await post(piBody());
    expect(response.text).not.toContain('secret');
    items = events(response.text) as any[];
    expect(items.at(-1)).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('组织没有选择模型：409，不调用网关', async () => {
    resolveModel = async () => {
      throw new JobError('AI_MODEL_NOT_CONFIGURED', '尚未选择文本模型，请先在设置中选择模型');
    };
    const response = await post(piBody());
    expect(response.status).toBe(409);
    expect(JSON.parse(response.text).error.code).toBe('AI_MODEL_NOT_CONFIGURED');
    expect(calls).toHaveLength(0);
  });

  it('未配置主密钥（没有网关）：503', async () => {
    const other = await buildApp(null);
    try {
      const response = await fetch(`${other.origin}${AGENT_CHAT_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(piBody()) });
      expect(response.status).toBe(503);
    } finally {
      await other.app.close();
    }
  });

  it('沙箱断开：中止网关调用（原因不是 shutdown，按已产生的用量收费）', async () => {
    let seen: AbortSignal | null = null;
    const aborted = new Promise<void>((resolve) => {
      script = {
        deltas: [{ content: '你好' }],
        hold: (signal) => {
          seen = signal;
          return new Promise<void>((done) => signal.addEventListener('abort', () => (resolve(), done()), { once: true }));
        },
      };
    });
    const controller = new AbortController();
    const response = await fetch(`${origin}${AGENT_CHAT_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(piBody()), signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await aborted;
    expect(seen!.reason).toBe('client');
    expect(calls[0]!.options.platformAborted!()).toBe(false);
    // 调用结束后注销，不留在进行中的集合里。
    await expect.poll(() => inFlight.size).toBe(0);
  });
});
