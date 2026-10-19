// AI 接口端到端测试（真实数据库 + 本机模拟服务商）：POST /api/ai/chat（JSON 与 SSE）、用户断开时中止上游请求、
// 平台管理员的凭据接口、模型白名单接口和带上游成本的定价接口，以及响应、日志中都不出现 API Key。
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { putCredential } from '../../src/ai/credentials.ts';
import { createFileKeyWrapper, type KeyWrapper } from '../../src/ai/keyring.ts';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { sseChunk, startMockProvider, streamCompletion, type MockProvider } from '../ai/mockProvider.ts';
import { createLogCapture, fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const ADMIN_PASSWORD = 'tidy-orbit-lantern-42';
const USER_PASSWORD = 'brisk-meadow-copper-77';
const API_KEY = `sk-route-${randomBytes(16).toString('hex')}`;

const RELAXED_LIMITS: AuthRateLimitSettings = Object.fromEntries(
  Object.entries(DEFAULT_AUTH_RATE_LIMITS).map(([key, value]) => [
    key,
    'limit' in value ? { ...value, limit: 10_000 } : { ...value, freeFailures: 10_000 },
  ]),
) as unknown as AuthRateLimitSettings;

let testDb: TestDatabase;
let superuser: Kysely<any>;
let provider: MockProvider;
const handles: DatabaseHandle[] = [];
const apps: FastifyInstance[] = [];
const keyWrapper = createFileKeyWrapper(randomBytes(32), 1);

let app: FastifyInstance;
let logs: ReturnType<typeof createLogCapture>;
let adminCookie: string;
let userCookie: string;
let customer: { userId: string; orgId: string };
let adminUser: { userId: string; orgId: string };

async function createApp(wrapper: KeyWrapper | null = keyWrapper) {
  const database = createDatabase(testDb.appConfig);
  handles.push(database);
  const capture = createLogCapture();
  const instance = await buildApp(
    { ...testConfig, database: testDb.appConfig, ai: { ...testConfig.ai, upstreamTimeoutMs: 2_000, maxOutputTokens: 1000, upstreamPrivateHosts: ['127.0.0.1'] } },
    { database, logStream: capture.stream, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} }, keyWrapper: wrapper },
  );
  apps.push(instance);
  return { instance, capture };
}

function send(target: FastifyInstance, method: 'POST' | 'PUT' | 'GET', url: string, cookie: string | null, payload?: object): Promise<LightMyRequestResponse> {
  return target.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, ...(cookie ? { cookie: `__Host-session=${cookie}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

async function login(target: FastifyInstance, email: string, password: string): Promise<string> {
  const response = await target.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

async function seedUser(email: string, password: string, platformAdmin = false) {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const orgId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({
    id: userId, email, password_hash: await hasher.hash(password), email_verified_at: new Date(), is_platform_admin: platformAdmin,
  }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { userId, orgId };
}

const chatBody = (overrides: Record<string, unknown> = {}) => ({
  provider: 'deepseek',
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: '你好' }],
  ...overrides,
});

function sseEvents(body: string) {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

async function balanceOf(orgId: string): Promise<bigint> {
  const row = await superuser.selectFrom('org_balances').select('balance').where('org_id', '=', orgId).executeTakeFirst();
  return BigInt(row?.balance ?? 0);
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
  adminUser = await seedUser('admin@example.com', ADMIN_PASSWORD, true);
  customer = await seedUser('customer@example.com', USER_PASSWORD);
  const past = new Date(Date.now() - 86_400_000);
  await superuser.insertInto('model_prices').values({
    provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: '20000', output_price_per_mtok: '80000',
    effective_from: past, created_at: past, created_by: adminUser.userId,
  }).execute();
  await superuser.insertInto('platform_models').values({
    provider: 'deepseek', model: 'deepseek-chat', is_free: false, enabled: true, created_by: adminUser.userId, updated_by: adminUser.userId,
  }).execute();
  provider = await startMockProvider(API_KEY);
  ({ instance: app, capture: logs } = await createApp());
  adminCookie = await login(app, 'admin@example.com', ADMIN_PASSWORD);
  userCookie = await login(app, 'customer@example.com', USER_PASSWORD);

  const appDb = connect(testDb.appConfig);
  try {
    await creditOrganization(appDb as never, { orgId: adminUser.orgId, userId: adminUser.userId, role: 'owner' }, {
      orgId: customer.orgId, type: 'recharge', amount: 1_000_000n, reference: null, note: '测试充值',
    });
  } finally {
    await appDb.destroy();
  }
});

afterAll(async () => {
  for (const instance of apps) await instance.close();
  for (const handle of handles) await handle.destroy();
  await provider?.close();
  await testDb?.drop();
});

beforeEach(() => provider.reset());

describe('平台凭据接口', () => {
  const credentialBody = (overrides: Record<string, unknown> = {}) => ({ baseUrl: provider.baseUrl, apiKey: API_KEY, password: ADMIN_PASSWORD, ...overrides });

  it('凭据未配置时调用 503，不冻结', async () => {
    const response = await send(app, 'POST', '/api/ai/chat', userCookie, chatBody());
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json().error.code).toBe('AI_PROVIDER_NOT_CONFIGURED');
    expect(await superuser.selectFrom('usage_records').select('id').execute()).toEqual([]);
  });

  it('普通用户不能写入或查看凭据', async () => {
    expect((await send(app, 'PUT', '/api/admin/ai/credentials/deepseek', userCookie, credentialBody())).statusCode).toBe(403);
    expect((await send(app, 'GET', '/api/admin/ai/credentials', userCookie)).statusCode).toBe(403);
  });

  it.each([
    ['http 地址', { baseUrl: 'http://api.deepseek.com' }, 'INVALID_BASE_URL'],
    ['带用户名', { baseUrl: 'https://u:p@api.deepseek.com' }, 'INVALID_BASE_URL'],
    ['Key 含空白', { apiKey: 'sk-has space-123' }, 'INVALID_API_KEY'],
    ['密码错误', { password: 'wrong-password-123' }, 'INVALID_PASSWORD'],
  ])('%s：400，不写入', async (_name, overrides, code) => {
    const response = await send(app, 'PUT', '/api/admin/ai/credentials/deepseek', adminCookie, credentialBody(overrides));
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe(code);
    expect(await superuser.selectFrom('provider_credentials').select('id').execute()).toEqual([]);
  });

  it('不支持的服务商：400', async () => {
    expect((await send(app, 'PUT', '/api/admin/ai/credentials/openai', adminCookie, credentialBody())).statusCode).toBe(400);
  });

  it('平台管理员写入凭据：响应和状态接口只有末尾 4 位，没有 Key', async () => {
    const response = await send(app, 'PUT', '/api/admin/ai/credentials/deepseek', adminCookie, credentialBody({ baseUrl: `${provider.baseUrl}/` }));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().credential).toMatchObject({ provider: 'deepseek', kind: 'text_model', baseUrl: provider.baseUrl, configured: true, last4: API_KEY.slice(-4) });
    expect(response.body).not.toContain(API_KEY.slice(0, -4));

    const list = await send(app, 'GET', '/api/admin/ai/credentials', adminCookie);
    expect(list.json().credentials).toEqual([expect.objectContaining({ provider: 'deepseek', last4: API_KEY.slice(-4) })]);
    expect(list.body).not.toContain(API_KEY.slice(0, -4));
    expect(logs.text()).toContain('ai credential saved');
  });

  it('主密钥未配置时凭据接口和 AI 调用都返回 503', async () => {
    const { instance } = await createApp(null);
    const cookie = await login(instance, 'admin@example.com', ADMIN_PASSWORD);
    const put = await send(instance, 'PUT', '/api/admin/ai/credentials/deepseek', cookie, credentialBody());
    expect(put.statusCode).toBe(503);
    const chat = await send(instance, 'POST', '/api/ai/chat', cookie, chatBody());
    expect(chat.statusCode).toBe(503);
    expect(chat.json().error.code).toBe('AI_GATEWAY_DISABLED');
  });
});

describe('POST /api/ai/chat', () => {
  it('未登录 401，跨站 403', async () => {
    expect((await send(app, 'POST', '/api/ai/chat', null, chatBody())).statusCode).toBe(401);
    const crossSite = await app.inject({
      method: 'POST', url: '/api/ai/chat', headers: { origin: 'https://evil.example.com', 'x-requested-with': 'app', cookie: `__Host-session=${userCookie}` }, payload: chatBody(),
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it.each([
    ['不支持的服务商', { provider: 'openai' }],
    ['空消息', { messages: [] }],
    ['未知角色', { messages: [{ role: 'tool', content: 'x' }] }],
    ['超过最大输出', { maxOutputTokens: 1001 }],
    ['不能指定 Base URL', { baseUrl: 'http://127.0.0.1' }],
    ['不能指定 Key', { apiKey: 'sk-x' }],
  ])('%s：400', async (_name, overrides) => {
    expect((await send(app, 'POST', '/api/ai/chat', userCookie, chatBody(overrides))).statusCode).toBe(400);
    expect(provider.requests).toHaveLength(0);
  });

  it('非流式：返回内容、用量和费用（计费单位字符串），按组织扣费', async () => {
    const before = await balanceOf(customer.orgId);
    const response = await send(app, 'POST', '/api/ai/chat', userCookie, chatBody());
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body).toMatchObject({
      content: '你好，世界',
      finishReason: 'stop',
      usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, source: 'provider' },
      billing: { status: 'billed', amount: '60' },
    });
    expect(body).not.toHaveProperty('upstreamCost');
    expect(await balanceOf(customer.orgId)).toBe(before - 60n);
    const record = await superuser.selectFrom('usage_records').selectAll().where('request_id', '=', body.requestId).executeTakeFirstOrThrow();
    expect(record).toMatchObject({ org_id: customer.orgId, user_id: customer.userId, source: 'interactive', status: 'billed' });
  });

  it('流式：SSE 推送增量和最终用量，带安全响应头', async () => {
    const response = await send(app, 'POST', '/api/ai/chat', userCookie, chatBody({ stream: true }));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeDefined();
    const events = sseEvents(response.body);
    expect(events.map((event) => event.event)).toEqual(['delta', 'delta', 'done']);
    expect(events.slice(0, 2).map((event) => event.data.content).join('')).toBe('你好，世界');
    expect(events[2]!.data).toMatchObject({ billing: { status: 'billed', amount: '60' }, usage: { outputTokens: 500 } });
  });

  it('流式：推送开始前的失败（余额不足）仍以普通 JSON 错误返回', async () => {
    const email = `poor-${randomUUID().slice(0, 8)}@example.com`;
    await seedUser(email, USER_PASSWORD);
    const cookie = await login(app, email, USER_PASSWORD);
    const response = await send(app, 'POST', '/api/ai/chat', cookie, chatBody({ stream: true }));
    expect(response.statusCode).toBe(402);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.json().error).toMatchObject({ code: 'INSUFFICIENT_BALANCE', message: '余额不足，请充值后再试' });
    expect(provider.requests).toHaveLength(0);
  });

  it('流式：推送开始后的上游失败以 error 事件返回，不收费', async () => {
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk({ choices: [{ delta: { content: '半句' } }] }));
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const before = await balanceOf(customer.orgId);
    const response = await send(app, 'POST', '/api/ai/chat', userCookie, chatBody({ stream: true }));
    const events = sseEvents(response.body);
    expect(events.map((event) => event.event)).toEqual(['delta', 'error']);
    expect(events[1]!.data.error).toMatchObject({ code: 'AI_UPSTREAM_ERROR', message: '模型服务调用失败，本次调用不收费' });
    expect(await balanceOf(customer.orgId)).toBe(before);
  });

  it('上游失败（非流式）：502，不收费；服务商回显 Key 时响应和日志都不含 Key', async () => {
    provider.setHandler((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${req.authorization}` } }));
    });
    const before = await balanceOf(customer.orgId);
    const response = await send(app, 'POST', '/api/ai/chat', userCookie, chatBody());
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatchObject({ code: 'AI_UPSTREAM_ERROR' });
    expect(response.body).not.toContain(API_KEY);
    expect(response.body).not.toContain('Incorrect API key');
    expect(await balanceOf(customer.orgId)).toBe(before);
  });

  it('日志中有每次调用的计费摘要，但没有 Key、Prompt 和输出内容', async () => {
    provider.setHandler((_req, res) => streamCompletion(res, { pieces: ['机密输出内容'] }));
    await send(app, 'POST', '/api/ai/chat', userCookie, chatBody({ messages: [{ role: 'user', content: '机密招标文件正文' }] }));
    const text = logs.text();
    expect(text).toContain('ai call settled');
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(API_KEY.slice(4, 20));
    expect(text).not.toContain('机密招标文件正文');
    expect(text).not.toContain('机密输出内容');
  });
});

describe('用户断开时中止上游请求', () => {
  // 用真实的 TCP 连接（inject 模拟不了断开）。上游超时设为 60 秒：上游连接在断开后很快关闭，只能是因为用户断开。
  let server: FastifyInstance;
  let origin: string;
  let disconnectLogs: ReturnType<typeof createLogCapture>;

  beforeAll(async () => {
    const database = createDatabase(testDb.appConfig);
    handles.push(database);
    disconnectLogs = createLogCapture();
    server = await buildApp(
      { ...testConfig, database: testDb.appConfig, ai: { ...testConfig.ai, upstreamTimeoutMs: 60_000, maxOutputTokens: 1000, upstreamPrivateHosts: ['127.0.0.1'] } },
      { database, logStream: disconnectLogs.stream, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} }, keyWrapper },
    );
    apps.push(server);
    await server.listen({ host: '127.0.0.1', port: 0 });
    // 不依赖前面的凭据接口用例：单独运行本组用例时也已配置凭据。
    const appDb = connect(testDb.appConfig);
    try {
      await putCredential(appDb as never, { orgId: adminUser.orgId, userId: adminUser.userId, role: 'owner' }, keyWrapper, {
        provider: 'deepseek', baseUrl: provider.baseUrl, apiKey: API_KEY,
      });
    } finally {
      await appDb.destroy();
    }
    origin = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  });

  /** 服务商收到请求后先发一段内容（可选），然后一直不结束；记录上游连接何时被网关关闭。 */
  function hangingProvider(firstPiece: string | null) {
    let closedAt = 0;
    provider.setHandler((_req, res) => {
      res.on('close', () => (closedAt = Date.now()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (firstPiece !== null) res.write(sseChunk({ choices: [{ index: 0, delta: { content: firstPiece }, finish_reason: null }] }));
      res.flushHeaders();
    });
    return { closedAt: () => closedAt };
  }

  function openChat(body: object) {
    const payload = JSON.stringify(body);
    const req = http.request(`${origin}/api/ai/chat`, {
      method: 'POST',
      headers: { ...sameSiteHeaders, cookie: `__Host-session=${userCookie}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    });
    req.on('error', () => undefined);
    req.end(payload);
    return req;
  }

  async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs} 毫秒）`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function recordIds(): Promise<string[]> {
    return (await superuser.selectFrom('usage_records').select('id').execute()).map((row: { id: string }) => row.id);
  }

  /** 本次调用（调用前不存在的那一条）结算或释放后的用量记录。 */
  async function settledRecord(existing: string[]) {
    let record: any;
    await waitFor(async () => {
      record = await superuser.selectFrom('usage_records').selectAll().where('org_id', '=', customer.orgId)
        .$if(existing.length > 0, (query: any) => query.where('id', 'not in', existing))
        .where('status', '<>', 'pending').executeTakeFirst();
      return record !== undefined;
    });
    return record;
  }

  it('流式：收到第一段内容后断开，网关立即关闭到服务商的连接，按已产生的部分结算并释放冻结', async () => {
    const upstream = hangingProvider('第一段');
    const existing = await recordIds();
    const before = await balanceOf(customer.orgId);
    const req = openChat(chatBody({ stream: true }));
    const response = await new Promise<http.IncomingMessage>((resolve) => req.on('response', resolve));
    expect(response.statusCode).toBe(200);
    // 等到第一段增量到达客户端，再断开。
    await new Promise<void>((resolve) => response.on('data', (chunk: Buffer) => chunk.toString().includes('第一段') && resolve()));
    const disconnectedAt = Date.now();
    req.destroy();

    // 3 秒内上游连接必须已关闭（上游超时是 60 秒）。
    await waitFor(() => upstream.closedAt() > 0, 3_000);
    // 远小于 60 秒的上游超时：是用户断开触发的中止。
    expect(upstream.closedAt() - disconnectedAt).toBeLessThan(1_000);
    const record = await settledRecord(existing);
    expect(record).toMatchObject({ status: 'billed', usage_source: 'estimated', failure_reason: null });
    expect(BigInt(record.amount)).toBeLessThanOrEqual(BigInt(record.hold_amount));
    expect(await balanceOf(customer.orgId)).toBe(before - BigInt(record.amount));
    expect(provider.requests).toHaveLength(1);
    await waitFor(() => disconnectLogs.text().includes('"aborted":true'));
  });

  it('非流式：服务商还没返回任何内容时断开，同样立即关闭上游连接', async () => {
    const upstream = hangingProvider(null);
    const existing = await recordIds();
    const req = openChat(chatBody());
    await waitFor(() => provider.requests.length === 1);
    const disconnectedAt = Date.now();
    req.destroy();

    // 3 秒内上游连接必须已关闭（上游超时是 60 秒）。
    await waitFor(() => upstream.closedAt() > 0, 3_000);
    expect(upstream.closedAt() - disconnectedAt).toBeLessThan(1_000);
    const record = await settledRecord(existing);
    // 没有输出：只按输入估算结算，没有任何冻结残留。
    expect(record).toMatchObject({ status: 'billed', usage_source: 'estimated', output_tokens: '0' });
    const held = await superuser.selectFrom('usage_records').select('id').where('org_id', '=', customer.orgId).where('status', '=', 'pending').execute();
    expect(held).toEqual([]);
  });
});

describe('平台模型白名单接口', () => {
  const modelName = () => `wl-${randomUUID().slice(0, 8)}`;
  const registerBody = (overrides: Record<string, unknown> = {}) => ({ provider: 'deepseek', model: modelName(), isFree: false, password: ADMIN_PASSWORD, ...overrides });

  async function addDefaultPrice(model: string, input = '20000', output = '80000') {
    const past = new Date(Date.now() - 86_400_000);
    await superuser.insertInto('model_prices').values({
      provider: 'deepseek', model, input_price_per_mtok: input, output_price_per_mtok: output, effective_from: past, created_at: past, created_by: adminUser.userId,
    }).execute();
  }

  async function expectChatRejected(model: string, status: number, code: string) {
    const before = await balanceOf(customer.orgId);
    const records = (await superuser.selectFrom('usage_records').select('id').execute()).length;
    for (const stream of [false, true]) {
      const response = await send(app, 'POST', '/api/ai/chat', userCookie, chatBody({ model, stream }));
      expect(response.statusCode, response.body).toBe(status);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.json().error.code).toBe(code);
    }
    expect(provider.requests).toHaveLength(0);
    expect((await superuser.selectFrom('usage_records').select('id').execute()).length).toBe(records);
    expect(await balanceOf(customer.orgId)).toBe(before);
  }

  it('登记（默认停用）→ 启用 → 停用，调用结果随之变化；列表展示状态和当前默认价', async () => {
    const body = registerBody();
    await addDefaultPrice(body.model);
    const registered = await send(app, 'POST', '/api/admin/ai/models', adminCookie, body);
    expect(registered.statusCode, registered.body).toBe(201);
    expect(registered.headers['cache-control']).toBe('no-store');
    const { id } = registered.json().model;
    expect(registered.json().model).toMatchObject({ provider: 'deepseek', model: body.model, isFree: false, enabled: false });
    expect(logs.text()).toContain('ai model registered');
    await expectChatRejected(body.model, 403, 'AI_MODEL_DISABLED');

    const enabled = await send(app, 'POST', `/api/admin/ai/models/${id}/enable`, adminCookie, { password: ADMIN_PASSWORD });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().model).toMatchObject({ id, enabled: true });
    const list = await send(app, 'GET', '/api/admin/ai/models', adminCookie);
    expect(list.json().models).toContainEqual(expect.objectContaining({ id, status: 'available', inputPricePerMtok: '20000', outputPricePerMtok: '80000' }));
    const ok = await send(app, 'POST', '/api/ai/chat', userCookie, chatBody({ model: body.model }));
    expect(ok.statusCode, ok.body).toBe(200);

    provider.reset();
    const disabled = await send(app, 'POST', `/api/admin/ai/models/${id}/disable`, adminCookie);
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().model).toMatchObject({ id, enabled: false });
    expect(logs.text()).toContain('ai model disabled');
    await expectChatRejected(body.model, 403, 'AI_MODEL_DISABLED');
  });

  it('未登记 404、已登记未定价 503、零价格未标记免费 503、伪造服务商 400：都不调用服务商、不收费', async () => {
    const priced = modelName();
    await addDefaultPrice(priced);
    await expectChatRejected(priced, 404, 'AI_MODEL_NOT_REGISTERED');

    const unpriced = registerBody();
    const created = await send(app, 'POST', '/api/admin/ai/models', adminCookie, unpriced);
    await send(app, 'POST', `/api/admin/ai/models/${created.json().model.id}/enable`, adminCookie, { password: ADMIN_PASSWORD });
    await expectChatRejected(unpriced.model, 503, 'MODEL_PRICE_NOT_CONFIGURED');
    expect((await send(app, 'GET', '/api/admin/ai/models', adminCookie)).json().models).toContainEqual(
      expect.objectContaining({ model: unpriced.model, status: 'unpriced', inputPricePerMtok: null }),
    );

    const zero = registerBody();
    await addDefaultPrice(zero.model, '0', '0');
    const zeroId = (await send(app, 'POST', '/api/admin/ai/models', adminCookie, zero)).json().model.id;
    await send(app, 'POST', `/api/admin/ai/models/${zeroId}/enable`, adminCookie, { password: ADMIN_PASSWORD });
    await expectChatRejected(zero.model, 503, 'MODEL_PRICE_NOT_CONFIGURED');

    for (const fake of ['openai', 'Deepseek']) {
      const response = await send(app, 'POST', '/api/ai/chat', userCookie, chatBody({ provider: fake }));
      expect(response.statusCode).toBe(400);
    }
    expect(provider.requests).toHaveLength(0);
  });

  it('免费模型必须显式标记：isFree 必填、只接受 JSON 布尔值', async () => {
    const { isFree: _omit, ...withoutFlag } = registerBody();
    expect((await send(app, 'POST', '/api/admin/ai/models', adminCookie, withoutFlag)).statusCode).toBe(400);
    for (const value of ['true', 1, 'false', 0, null]) {
      const response = await send(app, 'POST', '/api/admin/ai/models', adminCookie, registerBody({ isFree: value }));
      expect(response.statusCode, String(value)).toBe(400);
      expect(response.json().error.code).toBe('INVALID_FREE_FLAG');
    }
    const free = registerBody({ isFree: true });
    await addDefaultPrice(free.model, '0', '0');
    const created = await send(app, 'POST', '/api/admin/ai/models', adminCookie, free);
    expect(created.statusCode, created.body).toBe(201);
    await send(app, 'POST', `/api/admin/ai/models/${created.json().model.id}/enable`, adminCookie, { password: ADMIN_PASSWORD });
    const response = await send(app, 'POST', '/api/ai/chat', userCookie, chatBody({ model: free.model }));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().billing).toEqual({ status: 'billed', amount: '0' });
  });

  it('普通用户不能查看、登记、启用、停用；登记和启用要求重新输入密码；重复登记 409；不存在的模型 404', async () => {
    const body = registerBody();
    const created = await send(app, 'POST', '/api/admin/ai/models', adminCookie, body);
    const { id } = created.json().model;
    expect((await send(app, 'GET', '/api/admin/ai/models', userCookie)).statusCode).toBe(403);
    expect((await send(app, 'POST', '/api/admin/ai/models', userCookie, registerBody({ password: USER_PASSWORD }))).statusCode).toBe(403);
    expect((await send(app, 'POST', `/api/admin/ai/models/${id}/enable`, userCookie, { password: USER_PASSWORD })).statusCode).toBe(403);
    expect((await send(app, 'POST', `/api/admin/ai/models/${id}/disable`, userCookie)).statusCode).toBe(403);
    expect((await send(app, 'POST', '/api/admin/ai/models', null, registerBody())).statusCode).toBe(401);

    const wrong = await send(app, 'POST', `/api/admin/ai/models/${id}/enable`, adminCookie, { password: 'wrong-password-123' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('INVALID_PASSWORD');
    expect((await send(app, 'POST', '/api/admin/ai/models', adminCookie, registerBody({ password: 'wrong-password-123' }))).json().error.code).toBe('INVALID_PASSWORD');
    const row = await superuser.selectFrom('platform_models').select('enabled').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.enabled).toBe(false);

    const duplicate = await send(app, 'POST', '/api/admin/ai/models', adminCookie, { ...body, isFree: true });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('AI_MODEL_EXISTS');
    const missing = await send(app, 'POST', `/api/admin/ai/models/${randomUUID()}/disable`, adminCookie);
    expect(missing.statusCode).toBe(404);
    expect((await send(app, 'POST', '/api/admin/ai/models', adminCookie, registerBody({ provider: 'openai' }))).statusCode).toBe(400);
    expect((await send(app, 'POST', '/api/admin/ai/models', adminCookie, registerBody({ model: '../etc' }))).statusCode).toBe(400);
  });
});

describe('定价接口的上游成本单价', () => {
  const priceBody = (overrides: Record<string, unknown> = {}) => ({
    provider: 'qwen', model: `qwen-route-${randomUUID().slice(0, 8)}`, inputPricePerMtok: '8000', outputPricePerMtok: '20000', password: ADMIN_PASSWORD, ...overrides,
  });

  it('同时提供两项上游单价时写入价格版本', async () => {
    const response = await send(app, 'POST', '/api/admin/billing/prices', adminCookie, priceBody({ upstreamInputPricePerMtok: '4000', upstreamOutputPricePerMtok: '12000' }));
    expect(response.statusCode, response.body).toBe(201);
    const row = await superuser.selectFrom('model_prices').selectAll().where('id', '=', response.json().price.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ upstream_input_price_per_mtok: '4000', upstream_output_price_per_mtok: '12000' });
  });

  it('不提供上游单价时为空；只提供一项、或用 JSON 数字时 400', async () => {
    const response = await send(app, 'POST', '/api/admin/billing/prices', adminCookie, priceBody());
    expect(response.statusCode, response.body).toBe(201);
    const row = await superuser.selectFrom('model_prices').selectAll().where('id', '=', response.json().price.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ upstream_input_price_per_mtok: null, upstream_output_price_per_mtok: null });

    expect((await send(app, 'POST', '/api/admin/billing/prices', adminCookie, priceBody({ upstreamInputPricePerMtok: '4000' }))).statusCode).toBe(400);
    const numeric = await send(app, 'POST', '/api/admin/billing/prices', adminCookie, priceBody({ upstreamInputPricePerMtok: 4000, upstreamOutputPricePerMtok: '1' }));
    expect(numeric.statusCode).toBe(400);
    expect(numeric.json().error.code).toBe('INVALID_AMOUNT');
  });
});
