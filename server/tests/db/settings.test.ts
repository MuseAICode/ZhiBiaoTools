// 设置（迁移 0009_settings）的数据库与接口测试：org_settings、user_settings 的隔离模板（describeProjectTable，组织级），
// 写权限与删除可见性由 RLS 强制（绕过应用层检查直接写库同样被拒绝），平台模型选择的守卫，以及 GET/PATCH /api/settings。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database, MemberRole } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { DEFAULT_CONCURRENCY_LIMIT, EXPORT_FORMAT_MAX_BYTES, loadSettings, updateSettings } from '../../src/settings/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable } from './projectTable.ts';

const PASSWORD = 'quiet-harbor-maple-58';

const RELAXED_LIMITS: AuthRateLimitSettings = Object.fromEntries(
  Object.entries(DEFAULT_AUTH_RATE_LIMITS).map(([key, value]) => [
    key,
    'limit' in value ? { ...value, limit: 10_000 } : { ...value, freeFailures: 10_000 },
  ]),
) as unknown as AuthRateLimitSettings;

interface Member {
  userId: string;
  orgId: string;
  cookie: string;
  context: TenantContext;
}

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let app: FastifyInstance;

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

/** 新建一个用户及其个人组织（owner），或以指定角色加入已有组织，并登录。 */
async function newMember(orgId: string = randomUUID(), joinAs: MemberRole = 'member'): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  const existing = await superuser.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
  if (!existing) await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  const role = existing ? joinAs : 'owner';
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { userId, orgId, cookie: await login(email), context: { orgId, userId, role } };
}

function call(member: Member, method: 'GET' | 'PATCH', payload?: object) {
  return app.inject({
    method,
    url: '/api/settings',
    headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` },
    ...(payload ? { payload } : {}),
  });
}

async function patchOk(member: Member, payload: object) {
  const response = await call(member, 'PATCH', payload);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function expectError(member: Member, payload: object, status: number, code?: string) {
  const response = await call(member, 'PATCH', payload);
  expect(response.statusCode, response.body).toBe(status);
  if (code) expect(response.json().error.code).toBe(code);
}

/** 用超级用户登记一个平台模型。 */
async function registerModel(enabled: boolean): Promise<string> {
  const admin = randomUUID();
  const row = await superuser
    .insertInto('platform_models')
    .values({ provider: 'deepseek', model: `model-${randomUUID()}`, enabled, created_by: admin, updated_by: admin })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
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
  database = createDatabase(testDb.appConfig);
  appDb = database.db;
  app = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    { database, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} } },
  );
});

afterAll(async () => {
  await app?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('隔离模板', () => {
  describeProjectTable(
    {
      table: 'org_settings',
      idColumn: 'org_id',
      scope: 'org',
      async insert(trx, scope) {
        const row = await trx
          .insertInto('org_settings')
          .values({ org_id: scope.orgId, concurrency_limit: 3, updated_by: scope.userId })
          .returning('org_id')
          .executeTakeFirstOrThrow();
        return row.org_id;
      },
      update: { concurrency_limit: 5 },
    },
    { admin: () => superuser, app: () => appDb },
  );

  describeProjectTable(
    {
      table: 'user_settings',
      idColumn: 'user_id',
      scope: 'org',
      userColumn: 'user_id',
      async insert(trx, scope) {
        const row = await trx
          .insertInto('user_settings')
          .values({ org_id: scope.orgId, user_id: scope.userId, agent_auto_answer_enabled: true })
          .returning('user_id')
          .executeTakeFirstOrThrow();
        return row.user_id;
      },
      update: { agent_auto_answer_enabled: false },
    },
    { admin: () => superuser, app: () => appDb },
  );
});

describe('写权限与删除可见性由 RLS 强制', () => {
  it('普通成员即使绕过应用层检查直接写库，也写不了组织设置', async () => {
    const owner = await newMember();
    const member = await newMember(owner.orgId);
    // 上下文中的角色是应用层的判断依据，数据库不信任它，按 org_memberships 中的实际角色判断。
    const forged: TenantContext = { ...member.context, role: 'owner' };
    await expect(
      withTenant(appDb, forged, (trx) =>
        trx.insertInto('org_settings').values({ org_id: owner.orgId, concurrency_limit: 2, updated_by: member.userId }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(updateSettings(appDb, forged, { org: { concurrencyLimit: 2 } })).rejects.toMatchObject({ statusCode: 403, code: 'SETTINGS_FORBIDDEN' });

    await patchOk(owner, { org: { concurrencyLimit: 4 } });
    const updated = await withTenant(appDb, forged, (trx) =>
      trx.updateTable('org_settings').set({ concurrency_limit: 1, updated_by: member.userId }).executeTakeFirst(),
    );
    expect(updated.numUpdatedRows).toBe(0n);
    expect((await loadSettings(appDb, member.context)).org.concurrencyLimit).toBe(4);
  });

  it('管理员降级为普通成员后立即不能再写（即使上下文中的角色还是 admin）', async () => {
    const owner = await newMember();
    const admin = await newMember(owner.orgId, 'admin');
    await patchOk(admin, { org: { concurrencyLimit: 6 } });
    await superuser.updateTable('org_memberships').set({ role: 'member' }).where('user_id', '=', admin.userId).execute();
    await expect(updateSettings(appDb, admin.context, { org: { concurrencyLimit: 7 } })).rejects.toMatchObject({ statusCode: 403 });
    expect((await loadSettings(appDb, owner.context)).org.concurrencyLimit).toBe(6);
  });

  it('不能以别人的名义写入 updated_by', async () => {
    const owner = await newMember();
    const other = await newMember(owner.orgId, 'admin');
    await expect(
      withTenant(appDb, owner.context, (trx) =>
        trx.insertInto('org_settings').values({ org_id: owner.orgId, updated_by: other.userId }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('成员关系不存在时（即使行还在），用户设置不可见、不可改、不能新写', async () => {
    const owner = await newMember();
    const member = await newMember(owner.orgId);
    await patchOk(member, { user: { agentAutoAnswerEnabled: true } });
    // 跳过外键级联删除成员关系，单独验证 RLS 的成员关系条件（级联删除由模板验证）。
    await superuser.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.deleteFrom('org_memberships').where('user_id', '=', member.userId).execute();
    });
    expect(await superuser.selectFrom('user_settings').select('user_id').where('user_id', '=', member.userId).execute()).toHaveLength(1);
    await withTenant(appDb, member.context, async (trx) => {
      expect(await trx.selectFrom('user_settings').selectAll().execute()).toEqual([]);
      const updated = await trx.updateTable('user_settings').set({ agent_auto_answer_enabled: false }).executeTakeFirst();
      expect(updated.numUpdatedRows).toBe(0n);
    });
    expect((await loadSettings(appDb, member.context)).user.agentAutoAnswerEnabled).toBe(false);
    const other = await newMember();
    await superuser.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.deleteFrom('org_memberships').where('user_id', '=', other.userId).execute();
    });
    await expect(updateSettings(appDb, other.context, { user: { agentAutoAnswerEnabled: true } })).rejects.toMatchObject({ statusCode: 403, code: 'SETTINGS_FORBIDDEN' });
  });

  it('移出组织后会话失效，用户设置随成员关系删除', async () => {
    const owner = await newMember();
    const member = await newMember(owner.orgId);
    await patchOk(member, { user: { uiPreferences: { sidebar: 'collapsed' } } });
    await superuser.deleteFrom('org_memberships').where('user_id', '=', member.userId).execute();
    expect(await superuser.selectFrom('user_settings').select('user_id').where('user_id', '=', member.userId).execute()).toEqual([]);
    expect((await call(member, 'GET')).statusCode).toBe(401);
  });
});

describe('平台模型选择', () => {
  it('只能选已启用的模型；不存在、已停用的被拒绝；选择后停用的照常保留并显示停用', async () => {
    const owner = await newMember();
    const enabled = await registerModel(true);
    const disabled = await registerModel(false);

    await expectError(owner, { org: { platformModelId: disabled } }, 400, 'PLATFORM_MODEL_UNAVAILABLE');
    await expectError(owner, { org: { platformModelId: randomUUID() } }, 400, 'PLATFORM_MODEL_UNAVAILABLE');

    const selected = await patchOk(owner, { org: { platformModelId: enabled.toUpperCase() } });
    expect(selected.org.platformModelId).toBe(enabled);
    expect(selected.org.platformModel).toMatchObject({ id: enabled, provider: 'deepseek', enabled: true });

    await superuser.updateTable('platform_models').set({ enabled: false }).where('id', '=', enabled).execute();
    const after = await patchOk(owner, { org: { concurrencyLimit: 8 } });
    expect(after.org).toMatchObject({ platformModelId: enabled, platformModel: { enabled: false }, concurrencyLimit: 8 });
    // 换回同一个（未变化）不再检查；换成别的停用模型被拒绝。
    await patchOk(owner, { org: { platformModelId: enabled } });
    await expectError(owner, { org: { platformModelId: disabled } }, 400, 'PLATFORM_MODEL_UNAVAILABLE');

    const cleared = await patchOk(owner, { org: { platformModelId: null } });
    expect(cleared.org).toMatchObject({ platformModelId: null, platformModel: null });
  });
});

describe('GET/PATCH /api/settings', () => {
  it('未登录返回 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401);
  });

  it('没有写过时返回默认值；返回中不含任何 Key 或 Base URL', async () => {
    const owner = await newMember();
    const response = await call(owner, 'GET');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      org: { platformModelId: null, platformModel: null, concurrencyLimit: DEFAULT_CONCURRENCY_LIMIT, exportFormat: {}, updatedBy: null, updatedAt: null },
      user: { agentAutoAnswerEnabled: false, uiPreferences: {}, updatedAt: null },
      canEditOrg: true,
    });
    expect(response.body).not.toMatch(/key|base_?url|secret|token/i);
  });

  it('部分更新只改传入的字段；组织设置全员可见，用户设置只有本人可见', async () => {
    const owner = await newMember();
    const member = await newMember(owner.orgId);
    const exportFormat = { template_name: '默认模版', page: { paper_size: 'a4', margin_top_cm: 2 } };

    const first = await patchOk(owner, { org: { concurrencyLimit: 3, exportFormat }, user: { agentAutoAnswerEnabled: true } });
    expect(first.org).toMatchObject({ concurrencyLimit: 3, exportFormat, updatedBy: owner.userId });
    expect(first.user.agentAutoAnswerEnabled).toBe(true);

    const second = await patchOk(owner, { org: { concurrencyLimit: 5 } });
    expect(second.org).toMatchObject({ concurrencyLimit: 5, exportFormat });
    expect(new Date(second.org.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.org.updatedAt).getTime());
    expect(second.user.agentAutoAnswerEnabled).toBe(true);

    const seen = (await call(member, 'GET')).json();
    expect(seen.org).toMatchObject({ concurrencyLimit: 5, exportFormat });
    expect(seen.user).toEqual({ agentAutoAnswerEnabled: false, uiPreferences: {}, updatedAt: null });
    expect(seen.canEditOrg).toBe(false);

    const own = await patchOk(member, { user: { uiPreferences: { theme: 'dark' } } });
    expect(own.user.uiPreferences).toEqual({ theme: 'dark' });
    expect((await call(owner, 'GET')).json().user).toMatchObject({ agentAutoAnswerEnabled: true, uiPreferences: {} });
  });

  it('普通成员改组织设置返回 403，同一请求中的用户设置也不写入', async () => {
    const owner = await newMember();
    const member = await newMember(owner.orgId);
    await expectError(member, { org: { concurrencyLimit: 2 }, user: { agentAutoAnswerEnabled: true } }, 403, 'SETTINGS_FORBIDDEN');
    expect((await call(member, 'GET')).json().user.agentAutoAnswerEnabled).toBe(false);
    const admin = await newMember(owner.orgId, 'admin');
    expect((await patchOk(admin, { org: { concurrencyLimit: 2 } })).org.updatedBy).toBe(admin.userId);
  });

  it('组织之间互不可见', async () => {
    const a = await newMember();
    const b = await newMember();
    await patchOk(a, { org: { concurrencyLimit: 9, exportFormat: { template_name: 'A' } }, user: { uiPreferences: { a: 1 } } });
    const seen = (await call(b, 'GET')).json();
    expect(seen.org).toMatchObject({ concurrencyLimit: DEFAULT_CONCURRENCY_LIMIT, exportFormat: {}, updatedAt: null });
    expect(seen.user.uiPreferences).toEqual({});
  });

  it('参数不合法返回 400', async () => {
    const owner = await newMember();
    const invalid: object[] = [
      {},
      { org: {} },
      { user: {} },
      { org: { concurrencyLimit: 0 } },
      { org: { concurrencyLimit: 21 } },
      { org: { concurrencyLimit: 2.5 } },
      { org: { platformModelId: 'not-a-uuid' } },
      { org: { exportFormat: [] } },
      { org: { exportFormat: 'x' } },
      { org: { apiKey: 'sk-test' } },
      { org: { baseUrl: 'https://example.com' } },
      { user: { agentAutoAnswerEnabled: 'yes' } },
      { user: { uiPreferences: null } },
      { other: true },
    ];
    for (const payload of invalid) await expectError(owner, payload, 400);
  });

  it('JSON 过大、嵌套过深、含 \\u0000 时返回 400，不写入', async () => {
    const owner = await newMember();
    await expectError(owner, { org: { exportFormat: { blob: 'x'.repeat(EXPORT_FORMAT_MAX_BYTES) } } }, 400, 'SETTINGS_INVALID');
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) deep = { d: deep };
    await expectError(owner, { user: { uiPreferences: deep } }, 400, 'SETTINGS_INVALID');
    await expectError(owner, { user: { uiPreferences: { text: 'a\u0000b' } } }, 400, 'SETTINGS_INVALID');
    expect(await superuser.selectFrom('org_settings').select('org_id').where('org_id', '=', owner.orgId).execute()).toEqual([]);
    expect(await superuser.selectFrom('user_settings').select('user_id').where('user_id', '=', owner.userId).execute()).toEqual([]);
  });

  it('跨站请求被拒绝', async () => {
    const owner = await newMember();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: `__Host-session=${owner.cookie}`, origin: 'https://evil.example' },
      payload: { user: { agentAutoAnswerEnabled: true } },
    });
    expect(response.statusCode).toBe(403);
  });
});
