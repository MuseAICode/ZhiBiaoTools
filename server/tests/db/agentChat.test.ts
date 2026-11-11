// Agent 的模型调用（src/agent/chatCompletions.ts，路线图第 8 步 8.2c2）对真实数据库、AI 网关与本机模拟服务商的端到端测试，
// 请求经 agent-gw 转给 worker 的内部入口：
// - 组织、任务、发起用户只按令牌：伪造的身份字段被拒绝，伪造的头部不影响记账（另一个组织的余额与用量不变）；
// - 模型固定为组织选用的白名单模型：请求中的 model 不采信，发给服务商的是平台模型，用量按它记账；max_tokens 截到平台上限；
// - 计费与步骤幂等沿用 AI 网关：按用量扣费，同一任务同一请求内容（续跑时 Pi 重发）取回已保存的结果、只扣一次；
// - 令牌无效、请求暂停后不调用服务商；沙箱断开按已产生的用量收费，worker 关闭时中止的调用不收费；
// - 任务上限（8.3a）：取回已保存结果的请求同样计入轮数，重复同一请求到上限即被拒绝；费用上限在冻结时检查；
// - 日志中没有令牌原文与 Key。
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS, type AgentTaskLimits } from '../../src/agent/budget.ts';
import { AGENT_CHAT_PATH, AGENT_CHAT_STEP_KEY } from '../../src/agent/chatCompletions.ts';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import { buildAgentGateway } from '../../src/agent/gateway.ts';
import { AGENT_RELAY_KEY_HEADER, generateAgentToken } from '../../src/agent/token.ts';
import { issueAgentJobToken } from '../../src/agent/tokenStore.ts';
import { putCredential } from '../../src/ai/credentials.ts';
import { createAiGateway, type AiGateway, type GatewaySettings } from '../../src/ai/gateway.ts';
import { createFileKeyWrapper } from '../../src/ai/keyring.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { getAvailableBalance } from '../../src/billing/usage.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { claimJob, insertJob, requestPause, type RunRef } from '../../src/jobs/store.ts';
import { createLoggerOptions } from '../../src/logger.ts';
import { startMockProvider, streamCompletion, streamDeltas, type MockProvider } from '../ai/mockProvider.ts';
import { createLogCapture } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const API_KEY = `sk-mock-${randomBytes(16).toString('hex')}`;
const keyWrapper = createFileKeyWrapper(randomBytes(32), 1);
const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;
const MAX_OUTPUT = 1000;
const SETTINGS: GatewaySettings = { upstreamTimeoutMs: 5_000, holdTtlSeconds: 60, maxOutputTokens: MAX_OUTPUT, upstreamPrivateHosts: ['127.0.0.1'] };
/** deepseek-chat：输入 2 元 / 百万 token、输出 8 元。模拟服务商默认用量输入 1000、输出 500。 */
const DEFAULT_CHARGE = (1000n * 20_000n + 500n * 80_000n + 999_999n) / 1_000_000n;

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let provider: MockProvider;
let aiGateway: AiGateway;
let endpoint: FastifyInstance;
let endpointOrigin: string;
let agentGw: FastifyInstance;
let gwOrigin: string;
let platformModelId: string;
const endpointLogs = createLogCapture();
const gwLogs = createLogCapture();
const gatewayLogs = createLogCapture();

const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

interface Member {
  orgId: string;
  userId: string;
  context: TenantContext;
}

async function newMember(options: { balance?: bigint; model?: boolean } = {}): Promise<Member> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: 'x', email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  if (options.model !== false) await superuser.insertInto('org_settings').values({ org_id: orgId, platform_model_id: platformModelId, updated_by: userId }).execute();
  const balance = options.balance ?? 1_000_000n;
  if (balance > 0n) await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: balance, reference: null, note: '测试充值' });
  return { orgId, userId, context: { orgId, userId, role: 'owner' } };
}

async function runningJob(member: Member, limits: AgentTaskLimits = AGENT_TASK_LIMITS.outline): Promise<RunRef> {
  const project = await withTenant(appDb, member.context, (trx) =>
    trx.insertInto('projects').values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId }).returning('id').executeTakeFirstOrThrow(),
  );
  const job = await insertJob(appDb, member.context, { type: 'test-agent', params: {}, projectId: project.id, agentLimits: limits });
  const runId = randomUUID();
  const result = await claimJob(appDb, { orgId: member.orgId, jobId: job.id, runId, leaseMs: LEASE_MS, orgRunningLimit: 100, attemptsFor: () => 5 });
  expect(result.kind).toBe('claimed');
  return { orgId: member.orgId, jobId: job.id, runId };
}

async function tokenFor(member: Member, limits?: AgentTaskLimits): Promise<{ run: RunRef; token: string }> {
  const run = await runningJob(member, limits);
  const issued = await issueAgentJobToken(appDb, run, TTL_MS);
  return { run, token: issued!.token };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'default', messages: [{ role: 'system', content: '你是助手。' }, { role: 'user', content: '生成目录' }], stream: true, max_tokens: 500, ...overrides };
}

async function chat(origin: string, token: string | null, payload: unknown, init: { headers?: Record<string, string>; relayKey?: boolean } = {}) {
  const response = await fetch(`${origin}${AGENT_CHAT_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(init.relayKey === false ? {} : { [AGENT_RELAY_KEY_HEADER]: RELAY_KEY }),
      ...init.headers,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { status: response.status, text: await response.text() };
}

function sseContent(text: string): { content: string; done: boolean; toolCalls: any[] } {
  let content = '';
  const toolCalls: any[] = [];
  let done = false;
  for (const block of text.split('\n\n')) {
    if (!block.startsWith('data: ')) continue;
    const data = block.slice(6);
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    const delta = JSON.parse(data).choices?.[0]?.delta;
    if (typeof delta?.content === 'string') content += delta.content;
    for (const call of delta?.tool_calls ?? []) toolCalls.push(call);
  }
  return { content, done, toolCalls };
}

async function usageRows(orgId: string): Promise<any[]> {
  return superuser.selectFrom('usage_records').selectAll().where('org_id', '=', orgId).orderBy('started_at').execute();
}

async function balanceOf(member: Member): Promise<bigint> {
  return (await getAvailableBalance(appDb, member.context)).balance;
}

async function startEndpoint(gateway: AiGateway | null) {
  const app = await buildAgentEndpointApp({ db: appDb, relayKey: RELAY_KEY, logLevel: 'info', logStream: endpointLogs.stream, gateway, maxOutputTokens: MAX_OUTPUT });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, origin: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'agent-chat-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
  const past = new Date(Date.now() - 30 * 86_400_000);
  await superuser.insertInto('model_prices').values([
    { provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: '20000', output_price_per_mtok: '80000', effective_from: past, created_at: past, created_by: platformAdmin },
    { provider: 'qwen', model: 'qwen-plus', input_price_per_mtok: '8000', output_price_per_mtok: '20000', effective_from: past, created_at: past, created_by: platformAdmin },
  ]).execute();
  const models = await superuser
    .insertInto('platform_models')
    .values([
      { provider: 'deepseek', model: 'deepseek-chat', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin },
      { provider: 'qwen', model: 'qwen-plus', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin },
    ])
    .returning(['id', 'model'])
    .execute();
  platformModelId = models.find((row: { model: string }) => row.model === 'deepseek-chat')!.id;

  database = createDatabase(testDb.appConfig);
  appDb = database.db;
  provider = await startMockProvider(API_KEY);
  await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'deepseek', baseUrl: provider.baseUrl, apiKey: API_KEY });
  const log = Fastify({ logger: createLoggerOptions({ level: 'info', stream: gatewayLogs.stream }) }).log;
  aiGateway = createAiGateway({ db: appDb, keyWrapper, settings: SETTINGS, log });

  ({ app: endpoint, origin: endpointOrigin } = await startEndpoint(aiGateway));
  agentGw = await buildAgentGateway({ upstream: endpointOrigin, relayKey: RELAY_KEY, logLevel: 'info', logStream: gwLogs.stream });
  await agentGw.listen({ host: '127.0.0.1', port: 0 });
  gwOrigin = `http://127.0.0.1:${(agentGw.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await agentGw?.close();
  await endpoint?.close();
  await provider?.close();
  await database?.destroy();
  await testDb?.drop();
});

beforeEach(() => provider.reset());

describe('对照组：经 agent-gw 调用组织选用的模型', () => {
  it('流式返回内容；按令牌的组织与任务记账，模型为平台模型，max_tokens 截到平台上限，步骤键固定', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    const before = await balanceOf(member);
    const response = await chat(gwOrigin, token, body({ max_tokens: 100_000, stream_options: { include_usage: true } }));
    expect(response.status, response.text).toBe(200);
    expect(sseContent(response.text)).toMatchObject({ content: '你好，世界', done: true });
    expect(response.text).toContain('"prompt_tokens":1000');

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.body).toMatchObject({ model: 'deepseek-chat', max_tokens: MAX_OUTPUT, stream: true });
    const [record] = await usageRows(member.orgId);
    expect(record).toMatchObject({ status: 'billed', source: 'job', job_id: run.jobId, job_type: 'test-agent', user_id: member.userId, provider: 'deepseek', model: 'deepseek-chat' });
    expect(await balanceOf(member)).toBe(before - DEFAULT_CHARGE);
    const step = await superuser.selectFrom('job_step_results').selectAll().where('job_id', '=', run.jobId).executeTakeFirstOrThrow();
    expect(step.step_key).toBe(AGENT_CHAT_STEP_KEY);
  });

  it('工具调用：请求中的工具转给服务商，输出的工具调用按 OpenAI 格式回传并保存', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    provider.setHandler(async (_request, res) => {
      await streamDeltas(res, [
        { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'bash', arguments: '' } }] },
        { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] },
      ]);
    });
    const tools = [{ type: 'function', function: { name: 'bash', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } }, strict: false } }];
    const response = await chat(gwOrigin, token, body({ tools, tool_choice: 'auto', store: false }));
    expect(response.status, response.text).toBe(200);
    const parsed = sseContent(response.text);
    expect(parsed.toolCalls[0]).toEqual({ index: 0, id: 'call_a', type: 'function', function: { name: 'bash' } });
    expect(parsed.toolCalls.map((call) => call.function?.arguments ?? '').join('')).toBe('{"command":"ls"}');
    expect(response.text).toContain('"finish_reason":"tool_calls"');
    // 发给服务商的请求体只由校验过的字段组装：没有 strict、store。
    expect(provider.requests[0]!.body.tools).toEqual([{ type: 'function', function: { name: 'bash', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]);
    expect(provider.requests[0]!.body).not.toHaveProperty('store');
    const step = await superuser.selectFrom('job_step_results').selectAll().where('job_id', '=', run.jobId).executeTakeFirstOrThrow();
    expect(step.tool_calls).toEqual([{ id: 'call_a', name: 'bash', arguments: '{"command":"ls"}' }]);
  });

  it('同一任务重发同一请求（续跑）：取回已保存的结果，服务商只调用一次、只扣一次费', async () => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    const before = await balanceOf(member);
    const first = await chat(gwOrigin, token, body());
    const second = await chat(gwOrigin, token, body());
    expect(sseContent(first.text)).toEqual(sseContent(second.text));
    expect(provider.requests).toHaveLength(1);
    // 只有一条用量记录（第二次没有冻结），余额只少了这一次的金额（金额不超过冻结额）。
    const rows = await usageRows(member.orgId);
    expect(rows.map((row) => row.status)).toEqual(['billed']);
    expect(await balanceOf(member)).toBe(before - BigInt(rows[0]!.amount));
    // 请求内容不同就是新的调用。
    await chat(gwOrigin, token, body({ messages: [{ role: 'user', content: '另一个问题' }] }));
    expect(provider.requests).toHaveLength(2);
  });
});

describe('伪造身份与模型', () => {
  it('请求中的 model 不采信：组织选用 deepseek-chat 时请求 qwen-plus，发给服务商与记账的都是 deepseek-chat', async () => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    expect((await chat(gwOrigin, token, body({ model: 'qwen-plus' }))).status).toBe(200);
    expect(provider.requests[0]!.body.model).toBe('deepseek-chat');
    expect((await usageRows(member.orgId)).map((row) => row.model)).toEqual(['deepseek-chat']);
  });

  it.each([
    ['org_id', { org_id: randomUUID() }],
    ['job_id', { job_id: randomUUID() }],
    ['project_id', { project_id: randomUUID() }],
    ['user_id', { user_id: randomUUID() }],
    ['provider', { provider: 'qwen' }],
    ['base_url', { base_url: 'http://169.254.169.254/' }],
    ['api_key', { api_key: 'sk-attacker' }],
  ])('请求体中的 %s：400，不冻结、不调用服务商', async (_name, forged) => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    const response = await chat(gwOrigin, token, body(forged));
    expect(response.status).toBe(400);
    expect(provider.requests).toHaveLength(0);
    expect(await usageRows(member.orgId)).toHaveLength(0);
  });

  it('头部自称另一个组织、任务、用户：只按令牌记账，另一个组织的余额与用量不变', async () => {
    const victim = await newMember();
    const victimRun = await runningJob(victim);
    const attacker = await newMember();
    const { run, token } = await tokenFor(attacker);
    const victimBefore = await balanceOf(victim);
    const headers = { 'x-org-id': victim.orgId, 'x-job-id': victimRun.jobId, 'x-user-id': victim.userId, 'x-forwarded-for': '10.0.0.1' };
    // 经 agent-gw（不转这些头部）与直接访问 worker 入口（不读这些头部）都一样。
    expect((await chat(gwOrigin, token, body(), { headers })).status).toBe(200);
    expect((await chat(endpointOrigin, token, body({ messages: [{ role: 'user', content: '直接访问' }] }), { headers })).status).toBe(200);
    expect(await usageRows(victim.orgId)).toHaveLength(0);
    expect(await balanceOf(victim)).toBe(victimBefore);
    expect((await usageRows(attacker.orgId)).map((row) => row.job_id)).toEqual([run.jobId, run.jobId]);
  });

  it('组织没有选择模型：409，不调用服务商', async () => {
    const member = await newMember({ model: false });
    const { token } = await tokenFor(member);
    const response = await chat(gwOrigin, token, body());
    expect(response.status).toBe(409);
    expect(JSON.parse(response.text).error.code).toBe('AI_MODEL_NOT_CONFIGURED');
    expect(provider.requests).toHaveLength(0);
  });

  it('组织选用的模型被停用：网关拒绝，不调用服务商', async () => {
    const member = await newMember({ model: false });
    const qwen = await superuser.selectFrom('platform_models').select('id').where('model', '=', 'qwen-plus').executeTakeFirstOrThrow();
    await superuser.insertInto('org_settings').values({ org_id: member.orgId, platform_model_id: qwen.id, updated_by: member.userId }).execute();
    await superuser.updateTable('platform_models').set({ enabled: false }).where('id', '=', qwen.id).execute();
    const { token } = await tokenFor(member);
    const response = await chat(gwOrigin, token, body());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(provider.requests).toHaveLength(0);
    expect(await usageRows(member.orgId)).toHaveLength(0);
  });
});

describe('令牌、余额与上限', () => {
  it('令牌无效、请求暂停后：401，不调用服务商', async () => {
    const member = await newMember();
    expect((await chat(gwOrigin, generateAgentToken(), body())).status).toBe(401);
    expect((await chat(gwOrigin, null, body())).status).toBe(401);
    const { run, token } = await tokenFor(member);
    await requestPause(appDb, member.context, run.jobId);
    expect((await chat(gwOrigin, token, body())).status).toBe(401);
    // 不带中继密钥直接访问 worker 入口：即使令牌有效也 401。
    const other = await tokenFor(member);
    expect((await chat(endpointOrigin, other.token, body(), { relayKey: false })).status).toBe(401);
    expect(provider.requests).toHaveLength(0);
  });

  it('余额不足：402（开始推送前，普通 JSON 错误），不调用服务商', async () => {
    const member = await newMember({ balance: 0n });
    const { token } = await tokenFor(member);
    const response = await chat(gwOrigin, token, body());
    expect(response.status).toBe(402);
    expect(JSON.parse(response.text).error.code).toBe('INSUFFICIENT_BALANCE');
    expect(provider.requests).toHaveLength(0);
  });

  it('请求体超过路由上限：agent-gw 413；直接访问 worker 入口声明超限也 413，不读取、不调用服务商', async () => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    const big = JSON.stringify(body({ messages: [{ role: 'user', content: 'x'.repeat(4 * 1024 * 1024) }] }));
    expect((await chat(gwOrigin, token, big)).status).toBe(413);
    expect((await chat(endpointOrigin, token, big)).status).toBe(413);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('任务上限（8.3a）', () => {
  async function budgetOf(jobId: string) {
    return superuser.selectFrom('agent_job_budgets').selectAll().where('job_id', '=', jobId).executeTakeFirstOrThrow();
  }

  it('恶意样本：重复同一请求（取回已保存的结果）也计入轮数，到上限即 409 TASK_TURN_LIMIT，不取回、不调用服务商', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member, { costLimit: 1_000_000n, turnLimit: 3 });
    for (let turn = 0; turn < 3; turn += 1) expect((await chat(gwOrigin, token, body())).status).toBe(200);
    // 第一次调用服务商，后两次取回已保存的结果。
    expect(provider.requests).toHaveLength(1);
    const limited = await chat(gwOrigin, token, body());
    expect(limited.status).toBe(409);
    expect(JSON.parse(limited.text).error.code).toBe('TASK_TURN_LIMIT');
    // 换一个请求内容同样被拒绝：之后一律不调用服务商。
    expect((await chat(gwOrigin, token, body({ messages: [{ role: 'user', content: '另一个问题' }] }))).status).toBe(409);
    expect(provider.requests).toHaveLength(1);
    expect(await budgetOf(run.jobId)).toMatchObject({ turns_used: 3, exhausted_reason: 'task_turn_limit' });
    expect((await usageRows(member.orgId)).map((row) => row.status)).toEqual(['billed']);
  });

  it('对照组：低于轮数上限的请求正常返回，每个请求计一轮', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member, { costLimit: 1_000_000n, turnLimit: 3 });
    expect((await chat(gwOrigin, token, body())).status).toBe(200);
    expect((await chat(gwOrigin, token, body({ messages: [{ role: 'user', content: '第二轮' }] }))).status).toBe(200);
    expect(await budgetOf(run.jobId)).toMatchObject({ turns_used: 2, exhausted_reason: null });
  });

  it('费用上限不足一次冻结：409 TASK_COST_LIMIT，不冻结、不调用服务商，记下原因后之后的请求也被拒绝', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member, { costLimit: 1n, turnLimit: 100 });
    const limited = await chat(gwOrigin, token, body());
    expect(limited.status).toBe(409);
    expect(JSON.parse(limited.text).error.code).toBe('TASK_COST_LIMIT');
    expect(provider.requests).toHaveLength(0);
    expect(await usageRows(member.orgId)).toHaveLength(0);
    expect(await budgetOf(run.jobId)).toMatchObject({ exhausted_reason: 'task_cost_limit', turns_used: 1 });
    expect(JSON.parse((await chat(gwOrigin, token, body())).text).error.code).toBe('TASK_COST_LIMIT');
    expect((await budgetOf(run.jobId)).turns_used).toBe(1);
  });

  it('任务没有登记上限：409 AGENT_BUDGET_MISSING，不调用服务商', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    await superuser.deleteFrom('agent_job_budgets').where('job_id', '=', run.jobId).execute();
    const response = await chat(gwOrigin, token, body());
    expect(response.status).toBe(409);
    expect(JSON.parse(response.text).error.code).toBe('AGENT_BUDGET_MISSING');
    expect(provider.requests).toHaveLength(0);
  });
});

describe('中止', () => {
  it('沙箱断开：中止上游调用，按已产生的用量收费', async () => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.setHandler(async (_request, res) => {
      await streamCompletion(res, { beforeDone: gate });
    });
    const controller = new AbortController();
    const response = await fetch(`${gwOrigin}${AGENT_CHAT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body()),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect.poll(async () => (await usageRows(member.orgId))[0]?.status, { timeout: 5_000 }).toBe('billed');
    release();
  });

  it('worker 关闭：进行中的调用被中止，不收费（platform_interrupted），关闭不等流式输出结束', async () => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    const local = await startEndpoint(aiGateway);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.setHandler(async (_request, res) => {
      await streamCompletion(res, { beforeDone: gate });
    });
    const response = await fetch(`${local.origin}${AGENT_CHAT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, [AGENT_RELAY_KEY_HEADER]: RELAY_KEY },
      body: JSON.stringify(body()),
    });
    const reader = response.body!.getReader();
    await reader.read();
    const startedAt = Date.now();
    await local.app.close();
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await expect.poll(async () => (await usageRows(member.orgId))[0]?.failure_reason, { timeout: 5_000 }).toBe('platform_interrupted');
    expect((await usageRows(member.orgId))[0]!.status).toBe('unbilled');
    await reader.cancel().catch(() => undefined);
    release();
  });

  it('日志中没有令牌原文与 Key', async () => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    await chat(gwOrigin, token, body({ messages: [{ role: 'user', content: '日志检查' }] }));
    for (const capture of [endpointLogs, gwLogs, gatewayLogs]) {
      const text = JSON.stringify(capture.lines());
      expect(text).not.toContain(token);
      expect(text).not.toContain(API_KEY);
    }
  });
});
