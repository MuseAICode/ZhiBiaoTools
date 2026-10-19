// 平台管理员计费接口端到端测试（真实数据库）：手动充值、冲正、新增价格版本，密码二次验证与金额二次确认。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { MAX_MANUAL_CREDIT_UNITS } from '../../src/billing/ledger.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { createLogCapture, fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const ADMIN_PASSWORD = 'tidy-orbit-lantern-42';
const USER_PASSWORD = 'brisk-meadow-copper-77';

const RELAXED_LIMITS: AuthRateLimitSettings = Object.fromEntries(
  Object.entries(DEFAULT_AUTH_RATE_LIMITS).map(([key, value]) => [
    key,
    'limit' in value ? { ...value, limit: 10_000 } : { ...value, freeFailures: 10_000 },
  ]),
) as unknown as AuthRateLimitSettings;

let testDb: TestDatabase;
let superuser: Kysely<any>;
const handles: DatabaseHandle[] = [];
const apps: FastifyInstance[] = [];

const customerOrg = randomUUID();
let adminCookie: string;
let userCookie: string;
let app: FastifyInstance;
let logs: ReturnType<typeof createLogCapture>;

async function createApp(limits: AuthRateLimitSettings = RELAXED_LIMITS) {
  const database = createDatabase(testDb.appConfig);
  handles.push(database);
  const capture = createLogCapture();
  const instance = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    { database, logStream: capture.stream, passwordHasher: await fastHasher(), rateLimits: limits, mailer: { send: async () => {} } },
  );
  apps.push(instance);
  return { instance, capture };
}

function post(target: FastifyInstance, url: string, payload: object, cookie: string): Promise<LightMyRequestResponse> {
  return target.inject({ method: 'POST', url, headers: { ...sameSiteHeaders, cookie: `__Host-session=${cookie}` }, payload });
}

async function login(target: FastifyInstance, email: string, password: string): Promise<string> {
  const response = await target.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

/** 建一个已验证邮箱的用户及其个人组织。 */
async function seedUser(email: string, password: string, options: { platformAdmin?: boolean; orgId?: string } = {}) {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const orgId = options.orgId ?? randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({
    id: userId, email, password_hash: await hasher.hash(password), email_verified_at: new Date(), is_platform_admin: options.platformAdmin ?? false,
  }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { userId, orgId };
}

const creditBody = (overrides: Record<string, unknown> = {}) => ({
  orgId: customerOrg,
  type: 'recharge',
  amount: '100000',
  confirmAmount: '100000',
  reference: 'BANK-20261018-001',
  note: '线下转账',
  password: ADMIN_PASSWORD,
  ...overrides,
});

async function ledgerCount(orgId = customerOrg): Promise<number> {
  const rows = await superuser.selectFrom('billing_ledger').select('id').where('org_id', '=', orgId).execute();
  return rows.length;
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
  await seedUser('admin@example.com', ADMIN_PASSWORD, { platformAdmin: true });
  await seedUser('customer@example.com', USER_PASSWORD, { orgId: customerOrg });
  ({ instance: app, capture: logs } = await createApp());
  adminCookie = await login(app, 'admin@example.com', ADMIN_PASSWORD);
  userCookie = await login(app, 'customer@example.com', USER_PASSWORD);
});

afterAll(async () => {
  for (const instance of apps) await instance.close();
  for (const handle of handles) await handle.destroy();
  await testDb?.drop();
});

describe('POST /api/admin/billing/credits', () => {
  it('平台管理员充值成功：金额以字符串返回，账本记录操作人、凭证号和备注，日志不含密码', async () => {
    const response = await post(app, '/api/admin/billing/credits', creditBody(), adminCookie);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const { entry } = response.json();
    expect(entry).toMatchObject({ orgId: customerOrg, type: 'recharge', amount: '100000', balanceAfter: '100000' });

    const row = await superuser.selectFrom('billing_ledger').selectAll().where('id', '=', entry.id).executeTakeFirstOrThrow();
    const adminUser = await superuser.selectFrom('users').select('id').where('email', '=', 'admin@example.com').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ entry_type: 'recharge', amount: '100000', reference: 'BANK-20261018-001', note: '线下转账', operator_user_id: adminUser.id });
    expect(logs.text()).toContain('billing credit');
    expect(logs.text()).not.toContain(ADMIN_PASSWORD);
  });

  it('密码错误时拒绝，不入账', async () => {
    const before = await ledgerCount();
    const response = await post(app, '/api/admin/billing/credits', creditBody({ password: 'wrong-password-123' }), adminCookie);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_PASSWORD');
    expect(await ledgerCount()).toBe(before);
  });

  it('两次输入的金额不一致时拒绝', async () => {
    const response = await post(app, '/api/admin/billing/credits', creditBody({ confirmAmount: '1000000' }), adminCookie);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('AMOUNT_MISMATCH');
  });

  it.each<[string, unknown]>([
    ['JSON 数字', 100000],
    ['小数', '1000.5'],
    ['科学计数法', '1e5'],
    ['负数', '-100'],
    ['零', '0'],
    ['前导零', '0100'],
    ['超长', '1'.repeat(20)],
  ])('金额必须是正整数字符串（计费单位）：拒绝%s', async (_name, amount) => {
    const before = await ledgerCount();
    const response = await post(app, '/api/admin/billing/credits', creditBody({ amount, confirmAmount: amount }), adminCookie);
    expect(response.statusCode).toBe(400);
    expect(await ledgerCount()).toBe(before);
  });

  it('超过单笔上限的大额充值暂未开放', async () => {
    const amount = (MAX_MANUAL_CREDIT_UNITS + 1n).toString();
    const response = await post(app, '/api/admin/billing/credits', creditBody({ amount, confirmAmount: amount }), adminCookie);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED' });
    expect(response.json().error.message).toContain('暂未开放');
  });

  it('组织不存在时返回 404', async () => {
    const response = await post(app, '/api/admin/billing/credits', creditBody({ orgId: randomUUID() }), adminCookie);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('普通用户（即便输入了自己的密码）不能充值；未登录返回 401', async () => {
    const before = await ledgerCount();
    const forbidden = await post(app, '/api/admin/billing/credits', creditBody({ password: USER_PASSWORD }), userCookie);
    expect(forbidden.statusCode).toBe(403);
    const anonymous = await app.inject({ method: 'POST', url: '/api/admin/billing/credits', headers: sameSiteHeaders, payload: creditBody() });
    expect(anonymous.statusCode).toBe(401);
    expect(await ledgerCount()).toBe(before);
  });

  it('跨站请求被拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/billing/credits',
      headers: { origin: 'https://evil.example', 'x-requested-with': 'app', cookie: `__Host-session=${adminCookie}` },
      payload: creditBody(),
    });
    expect(response.statusCode).toBe(403);
  });

  it('二次验证按管理员限流', async () => {
    const tight = { ...RELAXED_LIMITS, adminStepUpPerUser: { limit: 2, windowMs: 60_000 } };
    const { instance } = await createApp(tight);
    const cookie = await login(instance, 'admin@example.com', ADMIN_PASSWORD);
    const wrong = creditBody({ password: 'wrong-password-123' });
    expect((await post(instance, '/api/admin/billing/credits', wrong, cookie)).statusCode).toBe(400);
    expect((await post(instance, '/api/admin/billing/credits', wrong, cookie)).statusCode).toBe(400);
    const limited = await post(instance, '/api/admin/billing/credits', creditBody(), cookie);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('POST /api/admin/billing/reversals', () => {
  it('冲正一笔充值，第二次冲正返回 409', async () => {
    const credit = await post(app, '/api/admin/billing/credits', creditBody({ amount: '500', confirmAmount: '500' }), adminCookie);
    const entryId = credit.json().entry.id as string;
    const balanceBefore = BigInt(credit.json().entry.balanceAfter);

    const response = await post(app, '/api/admin/billing/reversals', { entryId, note: '重复录入', password: ADMIN_PASSWORD }, adminCookie);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().entry).toMatchObject({ type: 'reversal', amount: '-500', relatedEntryId: entryId, balanceAfter: (balanceBefore - 500n).toString() });

    const again = await post(app, '/api/admin/billing/reversals', { entryId, note: '重复录入', password: ADMIN_PASSWORD }, adminCookie);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('LEDGER_ENTRY_ALREADY_REVERSED');
  });

  it('普通用户不能冲正；密码错误拒绝', async () => {
    const credit = await post(app, '/api/admin/billing/credits', creditBody({ amount: '7', confirmAmount: '7' }), adminCookie);
    const entryId = credit.json().entry.id as string;
    expect((await post(app, '/api/admin/billing/reversals', { entryId, note: 'x', password: USER_PASSWORD }, userCookie)).statusCode).toBe(403);
    expect((await post(app, '/api/admin/billing/reversals', { entryId, note: 'x', password: 'wrong-password-123' }, adminCookie)).statusCode).toBe(400);
  });
});

describe('POST /api/admin/billing/prices', () => {
  const priceBody = (overrides: Record<string, unknown> = {}) => ({
    provider: 'deepseek',
    model: 'deepseek-chat',
    inputPricePerMtok: '20000',
    outputPricePerMtok: '80000',
    password: ADMIN_PASSWORD,
    ...overrides,
  });

  it('新增平台默认价（立即生效）和组织专属价（未来生效）', async () => {
    const now = await post(app, '/api/admin/billing/prices', priceBody(), adminCookie);
    expect(now.statusCode, now.body).toBe(201);
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const custom = await post(app, '/api/admin/billing/prices', priceBody({ orgId: customerOrg, model: 'qwen-max', provider: 'qwen', effectiveFrom: future, note: '合同价' }), adminCookie);
    expect(custom.statusCode, custom.body).toBe(201);
    expect(custom.json().price.effectiveFrom).toBe(future);
  });

  it.each<[string, Record<string, unknown>, number]>([
    ['生效时间在过去', { effectiveFrom: '2020-01-01T00:00:00Z' }, 400],
    ['生效时间不带时区', { effectiveFrom: '2030-01-01T00:00:00' }, 400],
    ['生效时间不合法', { effectiveFrom: '2030-13-45T00:00:00Z' }, 400],
    ['服务商不在清单中', { provider: 'openai' }, 400],
    ['单价为小数', { inputPricePerMtok: '1.5' }, 400],
    ['模型名不合法', { model: '../etc/passwd' }, 400],
    ['密码错误', { password: 'wrong-password-123' }, 400],
  ])('拒绝：%s', async (_name, overrides, status) => {
    const response = await post(app, '/api/admin/billing/prices', priceBody(overrides), adminCookie);
    expect(response.statusCode).toBe(status);
  });

  it('普通用户不能定价', async () => {
    expect((await post(app, '/api/admin/billing/prices', priceBody({ password: USER_PASSWORD }), userCookie)).statusCode).toBe(403);
  });
});
