// AI 网关（src/ai/gateway.ts、迁移 0004_ai_gateway）对真实数据库和本机模拟服务商的集成测试：
// 预扣冻结与结算、平台模型白名单、并发调用、进程中途崩溃后冻结释放、上游失败不收费、用户中途断开、Key 不泄露、
// 跨组织隔离与权限。不使用任何真实服务商的 Key；价格和白名单由测试写入。
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { putCredential } from '../../src/ai/credentials.ts';
import { inputTokenUpperBound } from '../../src/ai/estimate.ts';
import { createAiGateway, type AiGateway, type ChatRequest, type GatewaySettings } from '../../src/ai/gateway.ts';
import { createFileKeyWrapper } from '../../src/ai/keyring.ts';
import { assertModelCallable, listModels, registerModel, setModelEnabled } from '../../src/ai/models.ts';
import { chargeUsage, creditOrganization } from '../../src/billing/ledger.ts';
import { beginUsage, expireStaleHolds, failUsage, getAvailableBalance, settleUsage } from '../../src/billing/usage.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import { createLoggerOptions } from '../../src/logger.ts';
import { sseChunk, startMockProvider, streamCompletion, type MockProvider } from '../ai/mockProvider.ts';
import { createLogCapture } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const API_KEY = `sk-mock-${randomBytes(16).toString('hex')}`;
const KEK = randomBytes(32);
const keyWrapper = createFileKeyWrapper(KEK, 1);

/** deepseek-chat：输入 2 元 / 百万 token、输出 8 元；上游成本输入 1 元、输出 4 元。 */
const INPUT_PRICE = 20_000n;
const OUTPUT_PRICE = 80_000n;
const UPSTREAM_INPUT_PRICE = 10_000n;
const UPSTREAM_OUTPUT_PRICE = 40_000n;
const MAX_OUTPUT = 1000;

const SETTINGS: GatewaySettings = { upstreamTimeoutMs: 2_000, holdTtlSeconds: 60, maxOutputTokens: MAX_OUTPUT, upstreamPrivateHosts: ['127.0.0.1'] };

let testDb: TestDatabase;
let appDb: Kysely<Database>;
let superuser: Kysely<any>;
let provider: MockProvider;
let gateway: AiGateway;
let logs: ReturnType<typeof createLogCapture>;

const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

const MESSAGES = [{ role: 'user' as const, content: '请写一段投标文件的开头。' }];
const HOLD = (BigInt(inputTokenUpperBound(MESSAGES)) * INPUT_PRICE + BigInt(MAX_OUTPUT) * OUTPUT_PRICE + 999_999n) / 1_000_000n;
/** 模拟服务商默认返回的用量：输入 1000、输出 500。 */
const DEFAULT_CHARGE = (1000n * INPUT_PRICE + 500n * OUTPUT_PRICE + 999_999n) / 1_000_000n;
const DEFAULT_UPSTREAM_COST = (1000n * UPSTREAM_INPUT_PRICE + 500n * UPSTREAM_OUTPUT_PRICE + 999_999n) / 1_000_000n;

function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { provider: 'deepseek', model: 'deepseek-chat', messages: MESSAGES, source: 'interactive', ...overrides };
}

let orgCounter = 0;
async function newOrg(balance = 0n): Promise<TenantContext> {
  const orgId = randomUUID();
  const userId = randomUUID();
  orgCounter += 1;
  await superuser.insertInto('organizations').values({ id: orgId, name: `组织 ${orgCounter}`, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `ai${orgCounter}-${userId.slice(0, 8)}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  if (balance > 0n) await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: balance, reference: null, note: '测试充值' });
  return { orgId, userId, role: 'owner' };
}

// 超级用户读出的行（Kysely<any>），字段按迁移中的列名访问。
async function usageRows(orgId: string): Promise<any[]> {
  return superuser.selectFrom('usage_records').selectAll().where('org_id', '=', orgId).orderBy('started_at').execute();
}

async function chargesOf(orgId: string): Promise<any[]> {
  return superuser.selectFrom('billing_ledger').selectAll().where('org_id', '=', orgId).where('entry_type', '=', 'charge').execute();
}

async function available(ctx: TenantContext) {
  return getAvailableBalance(appDb, ctx);
}

/** 余额 = 账本金额之和；没有到期未结算的冻结时，可用余额 = 余额。 */
async function expectInvariant(orgId: string) {
  const rows = await superuser.selectFrom('billing_ledger').select('amount').where('org_id', '=', orgId).execute();
  const sum = rows.reduce((total: bigint, row: { amount: string }) => total + BigInt(row.amount), 0n);
  const balance = await superuser.selectFrom('org_balances').select('balance').where('org_id', '=', orgId).executeTakeFirst();
  expect(BigInt(balance?.balance ?? 0)).toBe(sum);
  // 已结算的用量记录与引用它们的扣费一一对应、金额一致。
  const billed = await superuser.selectFrom('usage_records').select('amount').where('org_id', '=', orgId).where('status', '=', 'billed').execute();
  const settlements = (await chargesOf(orgId)).filter((row: { usage_id: string | null }) => row.usage_id !== null);
  expect(settlements).toHaveLength(billed.length);
  const charged = settlements.reduce((total: bigint, row: { amount: string }) => total - BigInt(row.amount), 0n);
  expect(billed.reduce((total: bigint, row: { amount: string }) => total + BigInt(row.amount), 0n)).toBe(charged);
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: status, code });
    return error as AppError;
  }
  throw new Error(`应当失败：${code}`);
}

/** 让模拟服务商停在 [DONE] 之前，返回放行函数和“已收到请求”的 Promise。 */
function gateProvider(count = 1) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let received = 0;
  let notify!: () => void;
  const allReceived = new Promise<void>((resolve) => (notify = resolve));
  provider.setHandler(async (_req, res) => {
    received += 1;
    if (received >= count) notify();
    await streamCompletion(res, { beforeDone: gate });
  });
  return { release, allReceived, received: () => received };
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
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'ai-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();

  const past = new Date(Date.now() - 30 * 86_400_000);
  await superuser.insertInto('model_prices').values([
    {
      provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: INPUT_PRICE.toString(), output_price_per_mtok: OUTPUT_PRICE.toString(),
      upstream_input_price_per_mtok: UPSTREAM_INPUT_PRICE.toString(), upstream_output_price_per_mtok: UPSTREAM_OUTPUT_PRICE.toString(),
      effective_from: past, created_at: past, created_by: platformAdmin,
    },
    { provider: 'qwen', model: 'qwen-plus', input_price_per_mtok: '8000', output_price_per_mtok: '20000', effective_from: past, created_at: past, created_by: platformAdmin },
    // 免费模型：冻结额为 0，余额为 0 的组织也能调用（白名单中显式标记 is_free）。
    { provider: 'deepseek', model: 'free-model', input_price_per_mtok: '0', output_price_per_mtok: '0', effective_from: past, created_at: past, created_by: platformAdmin },
  ]).execute();
  await superuser.insertInto('platform_models').values([
    { provider: 'deepseek', model: 'deepseek-chat', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin },
    { provider: 'qwen', model: 'qwen-plus', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin },
    { provider: 'deepseek', model: 'free-model', is_free: true, enabled: true, created_by: platformAdmin, updated_by: platformAdmin },
  ]).execute();

  appDb = connect<Database>(testDb.appConfig, 20);
  provider = await startMockProvider(API_KEY);
  await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'deepseek', baseUrl: provider.baseUrl, apiKey: API_KEY });

  logs = createLogCapture();
  const log = Fastify({ logger: createLoggerOptions({ level: 'info', stream: logs.stream }) }).log;
  gateway = createAiGateway({ db: appDb, keyWrapper, settings: SETTINGS, log });
});

afterAll(async () => {
  await provider?.close();
  await appDb?.destroy();
  await testDb?.drop();
});

beforeEach(() => provider.reset());

describe('冻结与结算', () => {
  it('调用前按输入上界 + 最大输出冻结，调用中可用余额减少；结束后按实际用量扣费并释放多余部分', async () => {
    const ctx = await newOrg(1_000_000n);
    const gate = gateProvider();
    const call = gateway.chat(ctx, chatRequest());
    await gate.allReceived;

    expect(await available(ctx)).toEqual({ balance: 1_000_000n, held: HOLD, available: 1_000_000n - HOLD });
    const [pending] = await usageRows(ctx.orgId);
    expect(pending).toMatchObject({ status: 'pending', hold_amount: HOLD.toString(), max_output_tokens: String(MAX_OUTPUT), user_id: ctx.userId });
    expect(BigInt(pending.estimated_input_tokens)).toBe(BigInt(inputTokenUpperBound(MESSAGES)));
    // 发给服务商的 max_tokens 就是冻结时的最大输出，Key 已正确解密。
    expect(provider.requests[0]!.body).toMatchObject({ model: 'deepseek-chat', max_tokens: MAX_OUTPUT, stream: true });
    expect(provider.requests[0]!.authorization).toBe(`Bearer ${API_KEY}`);

    gate.release();
    const result = await call;
    expect(result).toMatchObject({
      content: '你好，世界',
      finishReason: 'stop',
      aborted: false,
      usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, usageSource: 'provider' },
      billing: { status: 'billed', amount: DEFAULT_CHARGE },
    });
    expect(await available(ctx)).toEqual({ balance: 1_000_000n - DEFAULT_CHARGE, held: 0n, available: 1_000_000n - DEFAULT_CHARGE });

    const [record] = await usageRows(ctx.orgId);
    const [charge] = await chargesOf(ctx.orgId);
    expect(record).toMatchObject({
      status: 'billed', source: 'interactive', job_id: null, provider: 'deepseek', model: 'deepseek-chat',
      input_tokens: '1000', output_tokens: '500', usage_source: 'provider', amount: DEFAULT_CHARGE.toString(),
      upstream_cost: DEFAULT_UPSTREAM_COST.toString(), ledger_entry_id: charge.id, request_id: result.requestId,
    });
    expect(record.finished_at).toBeInstanceOf(Date);
    expect(charge).toMatchObject({ usage_id: record.id, request_id: result.requestId, amount: (-DEFAULT_CHARGE).toString(), price_id: record.price_id, operator_user_id: ctx.userId });
    await expectInvariant(ctx.orgId);
  });

  it('余额不足以冻结时拒绝（402），不调用服务商、不写用量记录', async () => {
    const ctx = await newOrg(HOLD - 1n);
    await expectAppError(gateway.chat(ctx, chatRequest()), 402, 'INSUFFICIENT_BALANCE');
    expect(provider.requests).toHaveLength(0);
    expect(await usageRows(ctx.orgId)).toEqual([]);
    // 余额恰好够冻结时可以调用。
    const enough = await newOrg(HOLD);
    expect((await gateway.chat(enough, chatRequest())).billing.status).toBe('billed');
  });

  it('最大输出 token 越大冻结越多：同样余额下调小 maxOutputTokens 可以调用', async () => {
    const small = 100;
    const smallHold = (BigInt(inputTokenUpperBound(MESSAGES)) * INPUT_PRICE + BigInt(small) * OUTPUT_PRICE + 999_999n) / 1_000_000n;
    const ctx = await newOrg(smallHold);
    await expectAppError(gateway.chat(ctx, chatRequest()), 402, 'INSUFFICIENT_BALANCE');
    provider.setHandler((_req, res) => streamCompletion(res, { usage: { prompt_tokens: 10, completion_tokens: 50 } }));
    const result = await gateway.chat(ctx, chatRequest({ maxOutputTokens: small }));
    expect(result.billing.status).toBe('billed');
    expect(provider.requests.at(-1)!.body.max_tokens).toBe(small);
    await expectAppError(gateway.chat(ctx, chatRequest({ maxOutputTokens: MAX_OUTPUT + 1 })), 400, 'INVALID_AI_REQUEST');
  });

  it('服务商报告的用量超出冻结时，扣费以冻结额封顶，余额不会被多扣', async () => {
    const ctx = await newOrg(1_000_000n);
    provider.setHandler((_req, res) => streamCompletion(res, { usage: { prompt_tokens: 900_000_000, completion_tokens: 900_000_000 } }));
    const result = await gateway.chat(ctx, chatRequest());
    expect(result.billing).toEqual({ status: 'billed', amount: HOLD });
    expect(await available(ctx)).toMatchObject({ balance: 1_000_000n - HOLD, held: 0n });
    const [record] = await usageRows(ctx.orgId);
    // 上游成本按完整用量计算，超出部分由平台承担。
    expect(BigInt(record.upstream_cost)).toBeGreaterThan(HOLD);
    await expectInvariant(ctx.orgId);
  });

  it('价格在冻结和结算之间变动时，按冻结时确定的价格版本结算', async () => {
    const ctx = await newOrg(1_000_000n);
    const gate = gateProvider();
    const call = gateway.chat(ctx, chatRequest());
    await gate.allReceived;
    const [pending] = await usageRows(ctx.orgId);
    // 冻结后才生效的新版本（组织专属价，优先于默认价）。
    await superuser.insertInto('model_prices').values({
      org_id: ctx.orgId, provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: '999999', output_price_per_mtok: '999999',
      effective_from: sql`now()`, created_by: platformAdmin,
    }).execute();
    gate.release();
    expect((await call).billing.amount).toBe(DEFAULT_CHARGE);
    const [charge] = await chargesOf(ctx.orgId);
    expect(charge.price_id).toBe(pending.price_id);
  });

  it('服务商没有返回用量时按本地估算结算，标记 estimated', async () => {
    const ctx = await newOrg(1_000_000n);
    provider.setHandler((_req, res) => streamCompletion(res, { usage: null, pieces: ['你好世界', 'abcdefgh'] }));
    const result = await gateway.chat(ctx, chatRequest());
    expect(result.usage).toMatchObject({ usageSource: 'estimated', outputTokens: 6 });
    expect(result.billing.status).toBe('billed');
    const [record] = await usageRows(ctx.orgId);
    expect(record).toMatchObject({ usage_source: 'estimated', output_tokens: '6' });
  });

  it('通义千问：按 prompt_tokens_details.cached_tokens 记录缓存命中 token；未配置凭据时 503、不冻结', async () => {
    const ctx = await newOrg(1_000_000n);
    await expectAppError(gateway.chat(ctx, chatRequest({ provider: 'qwen', model: 'qwen-plus' })), 503, 'AI_PROVIDER_NOT_CONFIGURED');
    expect(await usageRows(ctx.orgId)).toEqual([]);

    await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'qwen', baseUrl: provider.baseUrl, apiKey: API_KEY });
    provider.setHandler((_req, res) =>
      streamCompletion(res, { usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 } } }),
    );
    const result = await gateway.chat(ctx, chatRequest({ provider: 'qwen', model: 'qwen-plus' }));
    expect(result.usage).toEqual({ inputTokens: 1000, cachedInputTokens: 600, outputTokens: 100, usageSource: 'provider' });
    // qwen-plus 没有录入上游成本单价：上游成本记为未知。
    const [record] = await usageRows(ctx.orgId);
    expect(record).toMatchObject({ provider: 'qwen', cached_input_tokens: '600', upstream_cost: null, amount: String((1000n * 8000n + 100n * 20000n + 999_999n) / 1_000_000n) });
  });

  it('显式标记为免费的模型：余额为 0 也能调用，扣费为 0', async () => {
    const ctx = await newOrg();
    const result = await gateway.chat(ctx, chatRequest({ model: 'free-model' }));
    expect(result.billing).toEqual({ status: 'billed', amount: 0n });
  });

  it('任务调用记录所属任务和任务类型', async () => {
    const ctx = await newOrg(1_000_000n);
    const jobId = randomUUID();
    // 任务调用要求任务正在执行（迁移 0022_job_billing），这里由超级用户直接写入一条执行中的任务。
    await superuser.insertInto('jobs').values({
      id: jobId, org_id: ctx.orgId, user_id: ctx.userId, type: 'bid-analysis', status: 'running', run_id: randomUUID(),
      lease_expires_at: new Date(Date.now() + 60_000), started_at: new Date(),
    }).execute();
    await gateway.chat(ctx, chatRequest({ source: 'job', jobId, jobType: 'bid-analysis', stepKey: 'analysis' }));
    const [record] = await usageRows(ctx.orgId);
    expect(record).toMatchObject({ source: 'job', job_id: jobId, job_type: 'bid-analysis' });
    await expectAppError(gateway.chat(ctx, chatRequest({ source: 'job', stepKey: 'analysis' })), 400, 'INVALID_AI_REQUEST');
    await expectAppError(gateway.chat(ctx, chatRequest({ jobId })), 400, 'INVALID_AI_REQUEST');
    // 任务调用必须带合法的步骤键；交互式调用不能带。
    await expectAppError(gateway.chat(ctx, chatRequest({ source: 'job', jobId })), 400, 'INVALID_AI_REQUEST');
    for (const stepKey of ['', ' ', '-lead', 'a'.repeat(201), '步骤', 'a b']) {
      await expectAppError(gateway.chat(ctx, chatRequest({ source: 'job', jobId, stepKey })), 400, 'INVALID_AI_REQUEST');
    }
    await expectAppError(gateway.chat(ctx, chatRequest({ stepKey: 'analysis' })), 400, 'INVALID_AI_REQUEST');
    expect(await usageRows(ctx.orgId)).toHaveLength(1);
  });
});

describe('平台模型白名单', () => {
  let modelCounter = 0;
  const uniqueModel = (prefix: string) => `${prefix}-${++modelCounter}-${randomUUID().slice(0, 8)}`;

  /** 直接写入一个价格版本（超级用户，生效时间在过去）。 */
  async function addPrice(model: string, input: string, output: string, orgId: string | null = null, prov = 'deepseek') {
    const past = new Date(Date.now() - 86_400_000);
    await superuser.insertInto('model_prices').values({
      org_id: orgId, provider: prov, model, input_price_per_mtok: input, output_price_per_mtok: output, effective_from: past, created_at: past, created_by: platformAdmin,
    }).execute();
  }

  /** 经管理员函数登记（可选启用）。 */
  async function register(model: string, options: { isFree?: boolean; enabled?: boolean; prov?: 'deepseek' | 'qwen' } = {}) {
    const registered = await registerModel(appDb, ctxAdmin, { provider: options.prov ?? 'deepseek', model, isFree: options.isFree ?? false, note: null });
    if (options.enabled ?? true) await setModelEnabled(appDb, ctxAdmin, registered.id, true);
    return registered.id;
  }

  /** 被拒绝的调用：抛出预期错误；不调用服务商、不写用量记录、不扣费、余额和可用余额都不变。 */
  async function expectRejected(ctx: TenantContext, request: ChatRequest, status: number, code: string) {
    const before = await available(ctx);
    await expectAppError(gateway.chat(ctx, request), status, code);
    expect(provider.requests).toHaveLength(0);
    expect(await usageRows(ctx.orgId)).toEqual([]);
    expect(await chargesOf(ctx.orgId)).toEqual([]);
    expect(await available(ctx)).toEqual(before);
    // 绕过网关的预检、直接冻结同样被拒绝（同一个数据库函数判定）。
    await expectAppError(
      beginUsage(appDb, ctx, {
        requestId: randomUUID(), source: 'interactive', jobId: null, jobType: null, provider: request.provider, model: request.model,
        estimatedInputTokens: 10, maxOutputTokens: 10, holdSeconds: 60,
      }),
      status,
      code,
    );
    expect(await usageRows(ctx.orgId)).toEqual([]);
  }

  it('未登记的模型：即使价格表里有生效价格也拒绝（404），不调用服务商、不收费', async () => {
    const ctx = await newOrg(1_000_000n);
    const model = uniqueModel('priced-unregistered');
    await addPrice(model, '20000', '80000');
    await expectRejected(ctx, chatRequest({ model }), 404, 'AI_MODEL_NOT_REGISTERED');
    // 既没登记也没定价。
    await expectRejected(ctx, chatRequest({ model: uniqueModel('unknown') }), 404, 'AI_MODEL_NOT_REGISTERED');
  });

  it('已登记、已启用但没有生效价格：503 未定价，不调用服务商、不收费', async () => {
    const ctx = await newOrg(1_000_000n);
    const model = uniqueModel('registered-unpriced');
    await register(model);
    await expectRejected(ctx, chatRequest({ model }), 503, 'MODEL_PRICE_NOT_CONFIGURED');
    // 只有尚未生效（将来生效）的价格版本，同样视为未定价。
    await superuser.insertInto('model_prices').values({
      provider: 'deepseek', model, input_price_per_mtok: '1', output_price_per_mtok: '1', effective_from: new Date(Date.now() + 86_400_000), created_by: platformAdmin,
    }).execute();
    await expectRejected(ctx, chatRequest({ model }), 503, 'MODEL_PRICE_NOT_CONFIGURED');
  });

  it('未标记免费的零价格不等于免费：按未定价拒绝，余额为 0 的组织也不能白用', async () => {
    const ctx = await newOrg();
    const model = uniqueModel('zero-not-free');
    await register(model);
    await addPrice(model, '0', '0');
    await expectRejected(ctx, chatRequest({ model }), 503, 'MODEL_PRICE_NOT_CONFIGURED');
    // 组织专属的零价格同样不能绕过。
    const priced = uniqueModel('org-zero');
    await register(priced);
    await addPrice(priced, '20000', '80000');
    await addPrice(priced, '0', '0', ctx.orgId);
    await expectRejected(ctx, chatRequest({ model: priced }), 503, 'MODEL_PRICE_NOT_CONFIGURED');
  });

  it('标记免费但生效价格不为零：503 冲突，不按任何一边计费', async () => {
    const ctx = await newOrg(1_000_000n);
    const model = uniqueModel('free-but-priced');
    await register(model, { isFree: true });
    await addPrice(model, '20000', '0');
    await expectRejected(ctx, chatRequest({ model }), 503, 'AI_MODEL_PRICE_CONFLICT');
  });

  it('已登记但未启用（登记后默认停用）、已停用：403，不调用服务商、不收费；重新启用后可以调用', async () => {
    const ctx = await newOrg(1_000_000n);
    const model = uniqueModel('toggle');
    await addPrice(model, '20000', '80000');
    const id = await register(model, { enabled: false });
    await expectRejected(ctx, chatRequest({ model }), 403, 'AI_MODEL_DISABLED');

    await setModelEnabled(appDb, ctxAdmin, id, true);
    expect((await gateway.chat(ctx, chatRequest({ model }))).billing.status).toBe('billed');
    expect(provider.requests).toHaveLength(1);

    provider.reset();
    const ctx2 = await newOrg(1_000_000n);
    await setModelEnabled(appDb, ctxAdmin, id, false);
    await expectRejected(ctx2, chatRequest({ model }), 403, 'AI_MODEL_DISABLED');
  });

  it('伪造服务商名：不在服务商清单中的名字 400；真实服务商配上别家登记的模型 404；都不调用服务商、不收费', async () => {
    const ctx = await newOrg(1_000_000n);
    for (const fake of ['openai', 'DeepSeek', 'deepseek ', '', 'qwen\u0000']) {
      await expectAppError(gateway.chat(ctx, chatRequest({ provider: fake as never })), 400, 'INVALID_AI_REQUEST');
    }
    // 数据库层同样拒绝（不依赖网关的参数校验）。
    await expectAppError(assertModelCallable(appDb, ctx, 'openai' as never, 'deepseek-chat'), 404, 'AI_MODEL_NOT_REGISTERED');
    // deepseek-chat 只在 deepseek 下登记；qwen 的凭据已配置，换成 qwen 也不能调用。
    await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'qwen', baseUrl: provider.baseUrl, apiKey: API_KEY });
    await expectRejected(ctx, chatRequest({ provider: 'qwen', model: 'deepseek-chat' }), 404, 'AI_MODEL_NOT_REGISTERED');
    expect(provider.requests).toHaveLength(0);
    expect(await usageRows(ctx.orgId)).toEqual([]);
    expect((await available(ctx)).balance).toBe(1_000_000n);
  });

  it('白名单检查在解密 Key 之前：未登记的模型即使服务商凭据未配置，也返回模型错误', async () => {
    const ctx = await newOrg(1_000_000n);
    const original = await superuser.selectFrom('provider_credentials').selectAll().where('provider', '=', 'deepseek').executeTakeFirstOrThrow();
    // 让解密必然失败：若先解密，会得到 AI_PROVIDER_UNAVAILABLE 并写入解密失败日志。
    await superuser.updateTable('provider_credentials').set({ base_url: 'http://127.0.0.1:1/v1' }).where('id', '=', original.id).execute();
    try {
      await expectAppError(gateway.chat(ctx, chatRequest({ model: uniqueModel('before-decrypt') })), 404, 'AI_MODEL_NOT_REGISTERED');
    } finally {
      await superuser.updateTable('provider_credentials').set({ base_url: original.base_url }).where('id', '=', original.id).execute();
    }
  });

  it('冻结后停用模型：进行中的调用照常结算，之后的调用被拒绝', async () => {
    const ctx = await newOrg(1_000_000n);
    const model = uniqueModel('disable-in-flight');
    await addPrice(model, '20000', '80000');
    const id = await register(model);
    const gate = gateProvider();
    const call = gateway.chat(ctx, chatRequest({ model }));
    await gate.allReceived;
    await setModelEnabled(appDb, ctxAdmin, id, false);
    gate.release();
    expect((await call).billing).toEqual({ status: 'billed', amount: DEFAULT_CHARGE });
    provider.reset();
    await expectAppError(gateway.chat(ctx, chatRequest({ model })), 403, 'AI_MODEL_DISABLED');
    expect(provider.requests).toHaveLength(0);
    await expectInvariant(ctx.orgId);
  });

  it('管理员函数：只有平台管理员能登记、启用、停用；重复登记 409；登记后服务商、模型名、免费标记不可改、记录不可删', async () => {
    const ctx = await newOrg();
    const model = uniqueModel('admin-only');
    await expectAppError(registerModel(appDb, ctx, { provider: 'deepseek', model, isFree: true, note: null }), 403, 'FORBIDDEN');
    const id = await register(model, { enabled: false });
    await expectAppError(setModelEnabled(appDb, ctx, id, true), 403, 'FORBIDDEN');
    await expectAppError(registerModel(appDb, ctxAdmin, { provider: 'deepseek', model, isFree: false, note: null }), 409, 'AI_MODEL_EXISTS');
    await expectAppError(setModelEnabled(appDb, ctxAdmin, randomUUID(), true), 404, 'AI_MODEL_NOT_FOUND');

    const row = await superuser.selectFrom('platform_models').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ provider: 'deepseek', model, is_free: false, enabled: false, created_by: platformAdmin, updated_by: platformAdmin });
    for (const change of [{ is_free: true }, { model: 'renamed' }, { provider: 'qwen' }]) {
      await expect(superuser.updateTable('platform_models').set(change).where('id', '=', id).execute()).rejects.toThrow(/immutable/);
    }
    await expect(superuser.deleteFrom('platform_models').where('id', '=', id).execute()).rejects.toThrow(/append-only/);

    const listed = (await listModels(appDb, ctxAdmin)).find((entry) => entry.id === id);
    expect(listed).toMatchObject({ enabled: false, isFree: false, status: 'disabled', inputPricePerMtok: null });
  });

  it.each([
    ['INSERT', `INSERT INTO platform_models (provider, model, is_free, enabled, created_by, updated_by) VALUES ('deepseek', 'x-insert', true, true, app_current_user_id(), app_current_user_id())`],
    ['UPDATE', `UPDATE platform_models SET enabled = true`],
    ['DELETE', `DELETE FROM platform_models`],
    ['调用内部函数 ai_model_price', `SELECT ai_model_price(app_current_org_id(), 'deepseek', 'deepseek-chat')`],
  ])('应用角色不能直接%s', async (_name, statement) => {
    const ctx = await newOrg();
    await expect(withTenant(appDb, ctx, (trx) => sql.raw(statement).execute(trx))).rejects.toThrow(/permission denied/);
  });

  it('未设置租户上下文时读不到白名单，也不能预检', async () => {
    expect((await sql`SELECT id FROM platform_models`.execute(appDb)).rows).toEqual([]);
    await expect(sql`SELECT ai_model_check('deepseek', 'deepseek-chat')`.execute(appDb)).rejects.toThrow(/tenant context required/);
  });
});

describe('并发调用', () => {
  it('余额只够 5 次冻结时，12 个并发调用恰好 5 个成功，其余 402 且不调用服务商', async () => {
    const ctx = await newOrg(HOLD * 5n + HOLD - 1n);
    const gate = gateProvider(5);
    let rejectedCount = 0;
    const calls = Array.from({ length: 12 }, () =>
      gateway.chat(ctx, chatRequest()).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => {
          rejectedCount += 1;
          return { ok: false as const, error };
        },
      ),
    );
    // 等全部 12 个调用都已冻结成功（到达服务商）或被拒绝，再放行：否则先结束的调用释放冻结后，晚到的调用会成功。
    await gate.allReceived;
    while (gate.received() + rejectedCount < 12) await new Promise((resolve) => setTimeout(resolve, 10));
    // 5 个调用都在进行中时，可用余额不足一次冻结。
    expect((await available(ctx)).available).toBe(HOLD - 1n);
    gate.release();
    const results = await Promise.all(calls);
    const succeeded = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(succeeded).toHaveLength(5);
    expect(rejected).toHaveLength(7);
    for (const result of rejected) expect((result as { error: unknown }).error).toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(gate.received()).toBe(5);

    const balance = HOLD * 6n - 1n - DEFAULT_CHARGE * 5n;
    expect(await available(ctx)).toEqual({ balance, held: 0n, available: balance });
    expect(await usageRows(ctx.orgId)).toHaveLength(5);
    await expectInvariant(ctx.orgId);
  });

  it('不经冻结的直接扣费不能占用进行中调用已冻结的金额', async () => {
    const ctx = await newOrg(HOLD + 10n);
    const gate = gateProvider();
    const call = gateway.chat(ctx, chatRequest());
    await gate.allReceived;
    // 50 个计费单位：不超过余额（HOLD + 10），但超过可用余额（10）。
    const direct = { requestId: randomUUID(), provider: 'deepseek' as const, model: 'deepseek-chat', inputTokens: 0, outputTokens: 625 };
    await expectAppError(chargeUsage(appDb, ctx, direct), 402, 'INSUFFICIENT_BALANCE');
    await chargeUsage(appDb, ctx, { ...direct, requestId: randomUUID(), outputTokens: 125 });
    gate.release();
    expect((await call).billing.amount).toBe(DEFAULT_CHARGE);
    await expectInvariant(ctx.orgId);
  });

  it('同一调用不能结算两次，结算与释放互斥', async () => {
    const ctx = await newOrg(1_000_000n);
    const hold = await beginUsage(appDb, ctx, {
      requestId: randomUUID(), source: 'interactive', jobId: null, jobType: null, provider: 'deepseek', model: 'deepseek-chat',
      estimatedInputTokens: 1000, maxOutputTokens: 1000, holdSeconds: 60,
    });
    const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, usageSource: 'provider' as const };
    const outcomes = await Promise.allSettled([
      settleUsage(appDb, ctx, hold.usageId, usage),
      settleUsage(appDb, ctx, hold.usageId, usage),
      failUsage(appDb, ctx, hold.usageId, 'upstream_error'),
    ]);
    const settled = outcomes.filter((outcome) => outcome.status === 'fulfilled' && typeof outcome.value === 'object');
    const released = outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value === true);
    expect(settled.length + released.length).toBe(1);
    expect(await chargesOf(ctx.orgId)).toHaveLength(settled.length);
    await expectInvariant(ctx.orgId);
  });
});

describe('中途崩溃后冻结释放', () => {
  it('进程在调用中途被 SIGKILL：冻结到期后自动不再占用余额，清理任务标为 abandoned，不收费', async () => {
    const ctx = await newOrg(HOLD + 5n);
    provider.setHandler(() => undefined); // 服务商收到请求后一直不响应。
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/crashingGateway.ts', import.meta.url))], {
      env: {
        PATH: process.env.PATH,
        DATABASE_HOST: testDb.appConfig.host,
        DATABASE_PORT: String(testDb.appConfig.port),
        DATABASE_NAME: testDb.appConfig.name,
        DATABASE_USER: testDb.appConfig.user,
        DATABASE_PASSWORD: testDb.appConfig.password,
        TEST_KEK: KEK.toString('base64'),
        HOLD_SECONDS: '2',
        MESSAGE: MESSAGES[0]!.content,
        ORG_ID: ctx.orgId,
        USER_ID: ctx.userId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const deadline = Date.now() + 15_000;
    while (provider.requests.length === 0) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`子进程没有发起调用：${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));

    // 刚崩溃时冻结仍在，余额不够第二次调用。
    const [pending] = await usageRows(ctx.orgId);
    expect(pending.status).toBe('pending');
    expect((await available(ctx)).held).toBe(HOLD);
    await expectAppError(gateway.chat(ctx, chatRequest()), 402, 'INSUFFICIENT_BALANCE');

    // 冻结到期（2 秒）后，不需要任何清理任务，可用余额已经恢复。
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, pending.hold_expires_at.getTime() - Date.now()) + 200));
    expect(await available(ctx)).toEqual({ balance: HOLD + 5n, held: 0n, available: HOLD + 5n });
    provider.reset();
    expect((await gateway.chat(ctx, chatRequest())).billing.status).toBe('billed');

    expect(await expireStaleHolds(appDb)).toBeGreaterThanOrEqual(1);
    const records = await usageRows(ctx.orgId);
    expect(records[0]).toMatchObject({ id: pending.id, status: 'unbilled', failure_reason: 'abandoned', amount: '0', ledger_entry_id: null });
    expect(await chargesOf(ctx.orgId)).toHaveLength(1);
    await expectInvariant(ctx.orgId);
  });

  it('冻结到期后才到达的结算不收费（hold_expired）；已被清理的调用再结算返回 409', async () => {
    const ctx = await newOrg(1_000_000n);
    const begin = () =>
      beginUsage(appDb, ctx, {
        requestId: randomUUID(), source: 'interactive', jobId: null, jobType: null, provider: 'deepseek', model: 'deepseek-chat',
        estimatedInputTokens: 100, maxOutputTokens: 100, holdSeconds: 60,
      });
    const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, usageSource: 'provider' as const };
    const late = await begin();
    const swept = await begin();
    // 模拟时间流逝：超级用户把两笔冻结的到期时间改到过去（pending 记录的到期时间不属于不可修改的标识列）。
    await superuser.updateTable('usage_records').set({ hold_expires_at: new Date(Date.now() - 1000) }).where('id', 'in', [late.usageId, swept.usageId]).execute();
    expect((await available(ctx)).held).toBe(0n);

    expect(await settleUsage(appDb, ctx, late.usageId, usage)).toEqual({ status: 'unbilled', amount: 0n, balanceAfter: null, ledgerEntryId: null });
    await expireStaleHolds(appDb);
    await expectAppError(settleUsage(appDb, ctx, swept.usageId, usage), 409, 'USAGE_NOT_PENDING');
    const rows = await usageRows(ctx.orgId);
    expect(rows.map((row) => [row.status, row.failure_reason])).toEqual([['unbilled', 'hold_expired'], ['unbilled', 'abandoned']]);
    expect(rows[0]).toMatchObject({ input_tokens: '10', upstream_cost: '1' });
    expect(await chargesOf(ctx.orgId)).toEqual([]);
    expect((await available(ctx)).balance).toBe(1_000_000n);
  });
});

describe('上游失败不收费', () => {
  const failures: [string, (res: import('node:http').ServerResponse) => void, number, string, string][] = [
    ['5xx', (res) => { res.writeHead(500); res.end('{"error":{"code":"internal_error"}}'); }, 502, 'AI_UPSTREAM_ERROR', 'upstream_error'],
    ['限流 429', (res) => { res.writeHead(429); res.end('{"error":{"code":"rate_limit"}}'); }, 502, 'AI_UPSTREAM_ERROR', 'upstream_error'],
    ['输入不合法 400', (res) => { res.writeHead(400); res.end('{"error":{"code":"invalid_request_error"}}'); }, 502, 'AI_UPSTREAM_ERROR', 'upstream_error'],
    ['流中途断开', (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk({ choices: [{ delta: { content: '半句' } }] }));
      setTimeout(() => res.socket?.destroy(), 20);
    }, 502, 'AI_UPSTREAM_ERROR', 'upstream_unreachable'],
    ['流中的错误事件', (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk({ choices: [{ delta: { content: '半句' } }] }));
      res.end(sseChunk({ error: { code: 'server_overloaded' } }));
    }, 502, 'AI_UPSTREAM_ERROR', 'upstream_error'],
    ['被截断（没有 finish_reason 和 [DONE]）', (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseChunk({ choices: [{ delta: { content: '半句' } }] }));
    }, 502, 'AI_UPSTREAM_ERROR', 'invalid_upstream_response'],
    ['超时', () => undefined, 504, 'AI_UPSTREAM_TIMEOUT', 'upstream_timeout'],
  ];

  it.each(failures)('%s：返回 %i，冻结全额释放，用量记录为 unbilled，不扣费', async (_name, handler, status, code, reason) => {
    const ctx = await newOrg(1_000_000n);
    provider.setHandler((_req, res) => handler(res));
    const fast = createAiGateway({ db: appDb, keyWrapper, settings: { ...SETTINGS, upstreamTimeoutMs: 300 }, log: Fastify({ logger: false }).log });
    await expectAppError(fast.chat(ctx, chatRequest()), status, code);
    expect(await available(ctx)).toEqual({ balance: 1_000_000n, held: 0n, available: 1_000_000n });
    const [record] = await usageRows(ctx.orgId);
    expect(record).toMatchObject({ status: 'unbilled', failure_reason: reason, amount: '0', ledger_entry_id: null });
    expect(await chargesOf(ctx.orgId)).toEqual([]);
  });

  it('连接不上服务商：upstream_unreachable，不收费', async () => {
    const ctx = await newOrg(1_000_000n);
    await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'deepseek', baseUrl: 'http://127.0.0.1:9/v1', apiKey: API_KEY });
    try {
      await expectAppError(gateway.chat(ctx, chatRequest()), 502, 'AI_UPSTREAM_ERROR');
    } finally {
      await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'deepseek', baseUrl: provider.baseUrl, apiKey: API_KEY });
    }
    const [record] = await usageRows(ctx.orgId);
    expect(record).toMatchObject({ status: 'unbilled', failure_reason: 'upstream_unreachable' });
    expect((await available(ctx)).balance).toBe(1_000_000n);
  });

  it('流式输出已经开始后失败，同样不收费', async () => {
    const ctx = await newOrg(1_000_000n);
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk({ choices: [{ delta: { content: '第一段' } }] }));
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const deltas: string[] = [];
    await expectAppError(gateway.chat(ctx, chatRequest(), { onDelta: (delta) => deltas.push(delta.content ?? '') }), 502, 'AI_UPSTREAM_ERROR');
    expect(deltas).toEqual(['第一段']);
    expect((await available(ctx)).balance).toBe(1_000_000n);
  });
});

describe('用户中途断开', () => {
  it('调用开始前已经取消：不冻结、不调用服务商、不收费', async () => {
    const ctx = await newOrg(1_000_000n);
    const controller = new AbortController();
    controller.abort();
    await expectAppError(gateway.chat(ctx, chatRequest(), { signal: controller.signal }), 400, 'AI_REQUEST_ABORTED');
    expect(provider.requests).toHaveLength(0);
    expect(await usageRows(ctx.orgId)).toEqual([]);
    expect((await available(ctx)).balance).toBe(1_000_000n);
  });

  it('按已产生的用量（本地估算）结算，不超过冻结额', async () => {
    const ctx = await newOrg(1_000_000n);
    provider.setHandler((_req, res) => streamCompletion(res, { pieces: ['第一段内容', '第二段', '第三段'], delayMs: 200 }));
    const controller = new AbortController();
    const result = await gateway.chat(ctx, chatRequest(), {
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });
    expect(result).toMatchObject({ aborted: true, content: '第一段内容', usage: { usageSource: 'estimated', outputTokens: 5 } });
    expect(result.billing.status).toBe('billed');
    expect(result.billing.amount).toBeGreaterThan(0n);
    expect(result.billing.amount).toBeLessThanOrEqual(HOLD);
    expect((await available(ctx)).held).toBe(0n);
    await expectInvariant(ctx.orgId);
  });
});

describe('Key 不泄露', () => {
  it('服务商在错误消息中回显 Key 时，抛出的错误和日志都不含 Key 和错误正文', async () => {
    const ctx = await newOrg(1_000_000n);
    provider.setHandler((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${req.authorization}` } }));
    });
    const error = await expectAppError(gateway.chat(ctx, chatRequest()), 502, 'AI_UPSTREAM_ERROR');
    const text = `${error.message} ${error.stack} ${JSON.stringify(error)} ${String(error.cause)}`;
    expect(text).not.toContain(API_KEY);
    expect(logs.text()).toContain('invalid_api_key');
    expect(logs.text()).not.toContain(API_KEY);
    expect(logs.text()).not.toContain('Incorrect API key');
  });

  it('数据库中只有密文：凭据行、用量记录、账本里都没有 Key 明文，Key 的任何 8 个字符的片段都不出现', async () => {
    const credentials = await superuser.selectFrom('provider_credentials').selectAll().execute();
    expect(credentials.length).toBeGreaterThan(0);
    const dump = JSON.stringify([
      credentials.map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('latin1') : value]))),
      await superuser.selectFrom('usage_records').selectAll().execute(),
      await superuser.selectFrom('billing_ledger').selectAll().execute(),
    ]);
    for (let i = 0; i + 8 <= API_KEY.length - 4; i += 1) expect(dump).not.toContain(API_KEY.slice(i, i + 8));
    expect(credentials[0]).toMatchObject({ last4: API_KEY.slice(-4), kek_version: 1 });
  });

  it('密文被复制到另一服务商、或 Base URL 被直接改掉时解密失败：503，不冻结、不发请求，日志不含密钥材料', async () => {
    const ctx = await newOrg(1_000_000n);
    const original = await superuser.selectFrom('provider_credentials').selectAll().where('provider', '=', 'deepseek').executeTakeFirstOrThrow();
    await superuser.updateTable('provider_credentials').set({ base_url: 'http://127.0.0.1:1/v1' }).where('id', '=', original.id).execute();
    try {
      await expectAppError(gateway.chat(ctx, chatRequest()), 503, 'AI_PROVIDER_UNAVAILABLE');
    } finally {
      await superuser.updateTable('provider_credentials').set({ base_url: original.base_url }).where('id', '=', original.id).execute();
    }
    expect(provider.requests).toHaveLength(0);
    expect(await usageRows(ctx.orgId)).toEqual([]);
    expect(logs.text()).toContain('ai credential decrypt failed');
    expect(logs.text()).not.toContain(KEK.toString('base64'));
  });

  it('应用角色读不到上游成本和上游单价', async () => {
    const ctx = await newOrg();
    await expect(withTenant(appDb, ctx, (trx) => sql`SELECT upstream_cost FROM usage_records`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(withTenant(appDb, ctx, (trx) => sql`SELECT upstream_input_price_per_mtok FROM model_prices`.execute(trx))).rejects.toThrow(/permission denied/);
  });
});

describe('隔离与权限', () => {
  it('其他组织看不到用量记录，也不能结算或释放别的组织的冻结', async () => {
    const owner = await newOrg(1_000_000n);
    const other = await newOrg(1_000_000n);
    const hold = await beginUsage(appDb, owner, {
      requestId: randomUUID(), source: 'interactive', jobId: null, jobType: null, provider: 'deepseek', model: 'deepseek-chat',
      estimatedInputTokens: 10, maxOutputTokens: 10, holdSeconds: 60,
    });
    expect(await withTenant(appDb, other, (trx) => trx.selectFrom('usage_records').select('id').execute())).toEqual([]);
    await expectAppError(
      settleUsage(appDb, other, hold.usageId, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, usageSource: 'provider' }),
      409,
      'USAGE_NOT_PENDING',
    );
    expect(await failUsage(appDb, other, hold.usageId, 'upstream_error')).toBe(false);
    expect((await usageRows(owner.orgId))[0].status).toBe('pending');
    expect(await withTenant(appDb, owner, (trx) => trx.selectFrom('usage_records').select('id').execute())).toHaveLength(1);
  });

  it.each([
    ['UPDATE 用量记录', `UPDATE usage_records SET amount = 0`],
    ['DELETE 用量记录', `DELETE FROM usage_records`],
    ['INSERT 用量记录', `INSERT INTO usage_records (org_id) VALUES (app_current_org_id())`],
    ['结算列由计费函数写', `INSERT INTO billing_ledger (org_id, entry_type, usage_id, input_tokens, output_tokens) VALUES (app_current_org_id(), 'charge', gen_random_uuid(), 1, 1)`],
    ['写平台凭据', `DELETE FROM provider_credentials`],
    ['直接调用内部函数', `SELECT billing_active_holds(app_current_org_id())`],
  ])('应用角色不能%s', async (_name, statement) => {
    const ctx = await newOrg();
    await expect(withTenant(appDb, ctx, (trx) => sql.raw(statement).execute(trx))).rejects.toThrow(/permission denied/);
  });

  it('已结束的用量记录不可修改、任何记录不可删除（表属主和超级用户同样）', async () => {
    const ctx = await newOrg(1_000_000n);
    await gateway.chat(ctx, chatRequest());
    const [record] = await usageRows(ctx.orgId);
    await expect(superuser.updateTable('usage_records').set({ amount: '0' }).where('id', '=', record.id).execute()).rejects.toThrow(/immutable/);
    await expect(superuser.deleteFrom('usage_records').where('id', '=', record.id).execute()).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE usage_records CASCADE`.execute(superuser)).rejects.toThrow(/append-only/);
  });

  it('未设置租户上下文时不能冻结，也读不到平台凭据', async () => {
    await expect(sql`SELECT * FROM ai_usage_begin(gen_random_uuid(), 'interactive', NULL, NULL, 'deepseek', 'deepseek-chat', 1, 1, 60)`.execute(appDb)).rejects.toThrow(/tenant context required/);
    expect((await sql`SELECT id FROM provider_credentials`.execute(appDb)).rows).toEqual([]);
  });

  it('只有平台管理员能写入平台凭据', async () => {
    const ctx = await newOrg();
    await expectAppError(putCredential(appDb, ctx, keyWrapper, { provider: 'deepseek', baseUrl: 'https://evil.example.com', apiKey: 'sk-attacker-key' }), 403, 'FORBIDDEN');
    const row = await superuser.selectFrom('provider_credentials').select('base_url').where('provider', '=', 'deepseek').executeTakeFirstOrThrow();
    expect(row.base_url).toBe(provider.baseUrl);
  });
});
