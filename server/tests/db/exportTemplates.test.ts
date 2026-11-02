// 导出模板（迁移 0010_export_templates）的数据库与接口测试：隔离模板（describeProjectTable，组织级 + 系统行），
// 系统模板的同步，修改、删除权限由 RLS 强制（系统模板只读、其他组织的模板不可见），模板数上限，以及 /api/export-templates；
// 另有 GET /api/fonts 登录后的返回（7.2，未登录与清单内容见 tests/templates/fonts.test.ts）。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { OWNER_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { TEMPLATE_FONT_NAMES } from '../../src/templates/fonts.ts';
import { EXPORT_TEMPLATE_CONFIG_MAX_BYTES, EXPORT_TEMPLATES_PER_ORG_MAX } from '../../src/templates/store.ts';
import { syncSystemTemplates } from '../../src/templates/system.ts';
import { SYSTEM_EXPORT_TEMPLATES } from '../../src/templates/systemTemplates.ts';
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
let owner: Kysely<Database>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let app: FastifyInstance;

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

/** 新建一个用户及其个人组织（owner），或以普通成员加入已有组织，并登录。 */
async function newMember(orgId: string = randomUUID()): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  const existing = await superuser.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
  if (!existing) await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  const role = existing ? 'member' : 'owner';
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { userId, orgId, cookie: await login(email), context: { orgId, userId, role } };
}

function call(member: Member | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/export-templates${url}`,
    headers: { ...sameSiteHeaders, ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

async function ok(member: Member, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, status = 200) {
  const response = await call(member, method, url, payload);
  expect(response.statusCode, response.body).toBe(status);
  return response.json();
}

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

function config(name: string, extra: Record<string, unknown> = {}) {
  return { template_name: name, page: { paper_size: 'a4' }, ...extra };
}

async function systemTemplateId(key: string): Promise<string> {
  const row = await superuser.selectFrom('export_templates').select('id').where('system_key', '=', key).executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = connect(testDb.ownerConfig) as Kysely<Database>;
  expect((await migrateToLatest(owner as Kysely<unknown>)).error).toBeUndefined();
  expect(await syncSystemTemplates(owner)).toEqual({ upserted: SYSTEM_EXPORT_TEMPLATES.length, removed: 0 });
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
  await owner?.destroy();
  await testDb?.drop();
});

describe('隔离模板', () => {
  describeProjectTable(
    {
      table: 'export_templates',
      idColumn: 'id',
      scope: 'org',
      async insert(trx, scope) {
        const row = await trx
          .insertInto('export_templates')
          .values({
            org_id: scope.orgId,
            name: '模板',
            config: JSON.stringify(config('模板')),
            created_by: scope.userId,
            updated_by: scope.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return row.id;
      },
      update: { name: '改名', config: JSON.stringify(config('改名')) },
      systemRows: {
        async insert(admin) {
          const row = await admin
            .insertInto('export_templates')
            .values({ system_key: `test-${randomUUID()}`, name: '系统', config: JSON.stringify(config('系统')) })
            .returning('id')
            .executeTakeFirstOrThrow();
          return row.id;
        },
        writerRole: OWNER_ROLE,
        writer: () => owner,
      },
    },
    { admin: () => superuser, app: () => appDb },
  );
});

describe('系统模板同步', () => {
  it('按定义写入全部系统模板：名称取自 template_name，顺序即定义顺序，没有创建者', async () => {
    const rows = await superuser
      .selectFrom('export_templates')
      .select(['system_key', 'name', 'sort_order', 'created_by', 'updated_by', 'config'])
      .where('org_id', 'is', null)
      .where('system_key', 'not like', 'test-%')
      .orderBy('sort_order')
      .execute();
    expect(rows.map((row) => row.system_key)).toEqual(SYSTEM_EXPORT_TEMPLATES.map((definition) => definition.key));
    rows.forEach((row, index) => {
      const definition = SYSTEM_EXPORT_TEMPLATES[index]!;
      expect(row).toMatchObject({ name: definition.config.template_name, sort_order: index, created_by: null, updated_by: null });
      expect(row.config).toEqual(definition.config);
    });
  });

  it('重复同步不改变 id；改动的定义整份覆盖，删掉的定义被移除，组织模板不受影响', async () => {
    const member = await newMember();
    const mine = await ok(member, 'POST', '', { config: config('组织模板') }, 201);
    const systemIds = () =>
      superuser.selectFrom('export_templates').select(['system_key', 'id']).where('org_id', 'is', null).where('system_key', 'not like', 'test-%').orderBy('system_key').execute();
    const ids = await systemIds();
    // 隔离模板用超级用户写入的 test- 系统行不在定义中，同步时一并移除。
    const strays = await superuser.selectFrom('export_templates').select('id').where('system_key', 'like', 'test-%').execute();
    expect(await syncSystemTemplates(owner)).toEqual({ upserted: SYSTEM_EXPORT_TEMPLATES.length, removed: strays.length });
    expect(await systemIds()).toEqual(ids);
    expect(await syncSystemTemplates(owner)).toEqual({ upserted: SYSTEM_EXPORT_TEMPLATES.length, removed: 0 });
    expect(await systemIds()).toEqual(ids);

    const [first, second] = SYSTEM_EXPORT_TEMPLATES;
    const changed = { key: first!.key, config: { ...first!.config, template_name: '  改过的名称  ', marker: 1 } };
    const added = { key: 'brand-new', config: config('新增') };
    expect(await syncSystemTemplates(owner, [added, changed])).toEqual({ upserted: 2, removed: SYSTEM_EXPORT_TEMPLATES.length - 1 });
    const after = await superuser
      .selectFrom('export_templates')
      .select(['id', 'system_key', 'name', 'sort_order', 'config'])
      .where('org_id', 'is', null)
      .orderBy('sort_order')
      .execute();
    expect(after.map((row) => [row.system_key, row.name, row.sort_order])).toEqual([
      ['brand-new', '新增', 0],
      [first!.key, '改过的名称', 1],
    ]);
    expect(after[1]!.id).toBe(ids.find((row) => row.system_key === first!.key)!.id);
    expect(after[1]!.config).toMatchObject({ template_name: '改过的名称', marker: 1 });
    expect(after.some((row) => row.system_key === second!.key)).toBe(false);
    expect(await superuser.selectFrom('export_templates').select('name').where('id', '=', mine.id).executeTakeFirst()).toEqual({ name: '组织模板' });

    // 恢复正式定义，供后面的用例使用。
    expect(await syncSystemTemplates(owner)).toEqual({ upserted: SYSTEM_EXPORT_TEMPLATES.length, removed: 1 });
    expect((await systemIds()).find((row) => row.system_key === first!.key)!.id).toBe(after[1]!.id);
  });

  it('迁移角色不能写组织模板（策略只覆盖系统模板）', async () => {
    const member = await newMember();
    await expect(
      owner
        .insertInto('export_templates')
        .values({ org_id: member.orgId, name: '冒充', config: JSON.stringify(config('冒充')), created_by: member.userId, updated_by: member.userId })
        .execute(),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('数据库约束', () => {
  it('名称必须与 config.template_name 一致，config 必须是对象', async () => {
    const member = await newMember();
    const insert = (name: string, value: unknown) =>
      withTenant(appDb, member.context, (trx) =>
        trx
          .insertInto('export_templates')
          .values({ org_id: member.orgId, name, config: JSON.stringify(value), created_by: member.userId, updated_by: member.userId })
          .execute(),
      );
    await expect(insert('甲', config('乙'))).rejects.toThrow(/export_templates_name_matches_config/);
    await expect(insert('甲', ['甲'])).rejects.toThrow(/check constraint/);
    await expect(insert(' 甲', config(' 甲'))).rejects.toThrow(/check constraint/);
  });

  it('应用角色不能写 system_key，也不能代他人署名', async () => {
    const member = await newMember();
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx
          .insertInto('export_templates')
          .values({ org_id: member.orgId, system_key: 'mine', name: '甲', config: JSON.stringify(config('甲')), created_by: member.userId, updated_by: member.userId })
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    const other = randomUUID();
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx
          .insertInto('export_templates')
          .values({ org_id: member.orgId, name: '甲', config: JSON.stringify(config('甲')), created_by: other, updated_by: other })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it(`每个组织最多 ${EXPORT_TEMPLATES_PER_ORG_MAX} 个模板，系统模板不计；接口返回 409`, async () => {
    const member = await newMember();
    await superuser
      .insertInto('export_templates')
      .values(
        Array.from({ length: EXPORT_TEMPLATES_PER_ORG_MAX }, (_, index) => ({
          org_id: member.orgId,
          name: `模板${index}`,
          config: JSON.stringify(config(`模板${index}`)),
          created_by: member.userId,
          updated_by: member.userId,
        })),
      )
      .execute();
    await expectError(await call(member, 'POST', '', { config: config('超出') }), 409, 'TEMPLATE_LIMIT_REACHED');
    const standard = await systemTemplateId('standard-bid');
    await expectError(await call(member, 'POST', `/${standard}/duplicate`), 409, 'TEMPLATE_LIMIT_REACHED');
    // 其他组织不受影响。
    const other = await newMember();
    await ok(other, 'POST', '', { config: config('正常') }, 201);
  });
});

describe('接口', () => {
  let alice: Member;
  let bob: Member;
  let colleague: Member;

  beforeAll(async () => {
    alice = await newMember();
    colleague = await newMember(alice.orgId);
    bob = await newMember();
  });

  it('未登录返回 401', async () => {
    expect((await call(null, 'GET', '')).statusCode).toBe(401);
  });

  it('新建：名称取自 template_name，归一化后写回 config；为空时用“未命名模板”', async () => {
    const created = await ok(alice, 'POST', '', { config: config('  技术​标模板  ', { body_text: { font: '宋体' } }) }, 201);
    expect(created).toMatchObject({
      name: '技术标模板',
      isSystem: false,
      config: { template_name: '技术标模板', body_text: { font: '宋体' } },
      createdBy: alice.userId,
      updatedBy: alice.userId,
    });
    const untitled = await ok(alice, 'POST', '', { config: { page: {} } }, 201);
    expect(untitled).toMatchObject({ name: '未命名模板', config: { template_name: '未命名模板', page: {} } });
  });

  it('列表：系统模板在前，按定义顺序；组织模板按最近修改在后；同组织成员共享，其他组织看不到', async () => {
    const first = await ok(alice, 'POST', '', { config: config('先建') }, 201);
    const second = await ok(colleague, 'POST', '', { config: config('后建') }, 201);
    await ok(bob, 'POST', '', { config: config('别人的') }, 201);

    const response = await call(alice, 'GET', '');
    expect(response.headers['cache-control']).toBe('no-store');
    const { templates } = response.json() as { templates: Array<{ id: string; name: string; isSystem: boolean; config: object }> };
    const system = templates.filter((template) => template.isSystem && !template.name.startsWith('系统'));
    expect(system.map((template) => template.name)).toEqual(SYSTEM_EXPORT_TEMPLATES.map((definition) => definition.config.template_name));
    const firstOrg = templates.findIndex((template) => !template.isSystem);
    expect(templates.slice(0, firstOrg).every((template) => template.isSystem)).toBe(true);
    const orgIds = templates.slice(firstOrg).map((template) => template.id);
    expect(orgIds.indexOf(second.id)).toBeLessThan(orgIds.indexOf(first.id));
    expect(templates.some((template) => template.name === '别人的')).toBe(false);
  });

  it('读取：本组织的模板和系统模板可读，其他组织的与不存在的一样 404', async () => {
    const mine = await ok(alice, 'POST', '', { config: config('读取') }, 201);
    expect(await ok(colleague, 'GET', `/${mine.id.toUpperCase()}`)).toMatchObject({ id: mine.id, name: '读取' });
    const standard = await systemTemplateId('standard-bid');
    expect(await ok(bob, 'GET', `/${standard}`)).toMatchObject({ id: standard, isSystem: true, createdBy: null });
    await expectError(await call(bob, 'GET', `/${mine.id}`), 404, 'TEMPLATE_NOT_FOUND');
    await expectError(await call(bob, 'GET', `/${randomUUID()}`), 404, 'TEMPLATE_NOT_FOUND');
    expect((await call(bob, 'GET', '/not-a-uuid')).statusCode).toBe(400);
  });

  it('修改：整份替换配置，同组织成员可改；系统模板 403，其他组织的 404 且内容不变', async () => {
    const mine = await ok(alice, 'POST', '', { config: config('原名', { marker: 1 }) }, 201);
    const updated = await ok(colleague, 'PUT', `/${mine.id}`, { config: config('新名') });
    expect(updated).toMatchObject({ id: mine.id, name: '新名', updatedBy: colleague.userId, createdBy: alice.userId });
    expect(updated.config).not.toHaveProperty('marker');
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(mine.updatedAt));

    const standard = await systemTemplateId('standard-bid');
    const before = await superuser.selectFrom('export_templates').selectAll().where('id', '=', standard).executeTakeFirstOrThrow();
    await expectError(await call(alice, 'PUT', `/${standard}`, { config: config('篡改') }), 403, 'TEMPLATE_READ_ONLY');
    expect(await superuser.selectFrom('export_templates').selectAll().where('id', '=', standard).executeTakeFirstOrThrow()).toEqual(before);

    await expectError(await call(bob, 'PUT', `/${mine.id}`, { config: config('篡改') }), 404, 'TEMPLATE_NOT_FOUND');
    expect(await ok(alice, 'GET', `/${mine.id}`)).toMatchObject({ name: '新名' });
  });

  it('删除：同组织成员可删，删除后 404；系统模板 403，其他组织的 404 且仍在', async () => {
    const mine = await ok(alice, 'POST', '', { config: config('待删') }, 201);
    await expectError(await call(bob, 'DELETE', `/${mine.id}`), 404, 'TEMPLATE_NOT_FOUND');
    expect(await superuser.selectFrom('export_templates').select('id').where('id', '=', mine.id).executeTakeFirst()).toBeDefined();

    const deleted = await call(colleague, 'DELETE', `/${mine.id}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    await expectError(await call(alice, 'GET', `/${mine.id}`), 404, 'TEMPLATE_NOT_FOUND');
    await expectError(await call(alice, 'DELETE', `/${mine.id}`), 404, 'TEMPLATE_NOT_FOUND');

    const standard = await systemTemplateId('standard-bid');
    await expectError(await call(alice, 'DELETE', `/${standard}`), 403, 'TEMPLATE_READ_ONLY');
    expect(await superuser.selectFrom('export_templates').select('id').where('id', '=', standard).executeTakeFirst()).toEqual({ id: standard });
  });

  it('复制：系统模板和本组织的模板都能复制成本组织的模板；其他组织的 404', async () => {
    const standard = await systemTemplateId('standard-bid');
    const copy = await ok(bob, 'POST', `/${standard}/duplicate`, undefined, 201);
    const source = SYSTEM_EXPORT_TEMPLATES.find((definition) => definition.key === 'standard-bid')!;
    expect(copy).toMatchObject({ name: `${source.config.template_name} 副本`, isSystem: false, createdBy: bob.userId });
    expect(copy.config).toEqual({ ...source.config, template_name: `${source.config.template_name} 副本` });
    expect(await ok(bob, 'PUT', `/${copy.id}`, { config: config('改复制品') })).toMatchObject({ name: '改复制品' });

    const longName = '长'.repeat(200);
    const mine = await ok(alice, 'POST', '', { config: config(longName) }, 201);
    const second = await ok(alice, 'POST', `/${mine.id}/duplicate`, undefined, 201);
    expect([...second.name]).toHaveLength(200);
    expect(second.name.endsWith(' 副本')).toBe(true);
    await expectError(await call(bob, 'POST', `/${mine.id}/duplicate`), 404, 'TEMPLATE_NOT_FOUND');
  });

  it('输入校验：未声明字段、非对象配置、过长名称、过大或过深的配置、jsonb 不接受的字符都返回 400', async () => {
    expect((await call(alice, 'POST', '', { config: config('甲'), apiKey: 'x' })).statusCode).toBe(400);
    expect((await call(alice, 'POST', '', { config: ['甲'] })).statusCode).toBe(400);
    expect((await call(alice, 'POST', '', {})).statusCode).toBe(400);
    await expectError(await call(alice, 'POST', '', { config: config('长'.repeat(201)) }), 400, 'TEMPLATE_INVALID');
    await expectError(
      await call(alice, 'POST', '', { config: config('大', { blob: 'x'.repeat(EXPORT_TEMPLATE_CONFIG_MAX_BYTES) }) }),
      400,
      'TEMPLATE_INVALID',
    );
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) deep = { child: deep };
    await expectError(await call(alice, 'POST', '', { config: config('深', { deep }) }), 400, 'TEMPLATE_INVALID');
    await expectError(await call(alice, 'POST', '', { config: config('零', { text: 'a\u0000b' }) }), 400, 'TEMPLATE_INVALID');
  });
});

describe('GET /api/fonts', () => {
  it('登录后返回模板可选字体名的固定清单，不随组织变化，不缓存', async () => {
    const first = await newMember();
    const second = await newMember();
    const bodies = [];
    for (const member of [first, second]) {
      const response = await app.inject({ method: 'GET', url: '/api/fonts', headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      bodies.push(response.json());
    }
    expect(bodies[0]).toEqual({ fonts: [...TEMPLATE_FONT_NAMES] });
    expect(bodies[1]).toEqual(bodies[0]);
  });
});
