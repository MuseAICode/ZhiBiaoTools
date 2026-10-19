// 项目（迁移 0007_projects）的数据库与接口测试：projects 表的 RLS 与守卫、files.project_id 的复合外键、
// 项目接口、路由层的项目归属校验，以及项目级表模板（tests/db/fixtures/exampleProjectTable.ts）的隔离测试。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { tenantOf } from '../../src/auth/hooks.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { STORAGE_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { PROJECT_ID_PARAMS, requireProject } from '../../src/projects/access.ts';
import { PROJECT_NAME_MAX_LENGTH } from '../../src/projects/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import * as exampleProjectTable from './fixtures/exampleProjectTable.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable, withTenantAny } from './projectTable.ts';

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

/** 新建一个用户及其个人组织（或加入已有组织），并登录。 */
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

function headers(member: Member) {
  return { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` };
}

function call(member: Member, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: headers(member), ...(payload ? { payload } : {}) });
}

async function createOk(member: Member, kind = 'technical-plan', name = '某项目技术方案') {
  const response = await call(member, 'POST', '/api/projects', { kind, name });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

/** 用超级用户把项目的删除时间推到指定天数之前（模拟恢复期已过）。守卫不允许改删除时间，所以本事务内跳过触发器。 */
async function backdateDeletion(projectId: string, days: number) {
  await superuser.transaction().execute(async (trx) => {
    await sql`SET LOCAL session_replication_role = replica`.execute(trx);
    await trx
      .updateTable('projects')
      .set({ deleted_at: sql`now() - make_interval(days => ${days})` })
      .where('id', '=', projectId)
      .execute();
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
    await exampleProjectTable.up(owner);
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
  // 模拟一个模块的项目级接口：先校验归属（组织 + kind），再往下传。
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/technical-plan',
    { schema: { params: PROJECT_ID_PARAMS } },
    async (request) => {
      const project = await requireProject(appDb, tenantOf(request), request.params.projectId, 'technical-plan');
      return { id: project.id, kind: project.kind };
    },
  );
});

afterAll(async () => {
  await app?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('projects 表', () => {
  let a: Member;
  let b: Member;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    a = await newMember();
    b = await newMember();
    projectA = (await createOk(a)).id;
    projectB = (await createOk(b)).id;
  });

  it('未设置上下文：查询返回 0 行，更新影响 0 行，插入被拒绝', async () => {
    expect((await superuser.selectFrom('projects').select('id').where('id', 'in', [projectA, projectB]).execute()).length).toBe(2);
    expect(await appDb.selectFrom('projects').selectAll().execute()).toEqual([]);
    expect(await appDb.selectFrom('projects').selectAll().where('id', '=', projectA).execute()).toEqual([]);
    const updated = await appDb.updateTable('projects').set({ name: '篡改' }).executeTakeFirst();
    expect(updated.numUpdatedRows).toBe(0n);
    await expect(
      appDb.insertInto('projects').values({ org_id: a.orgId, kind: 'technical-plan', name: 'x', created_by: a.userId }).execute(),
    ).rejects.toThrow(/row-level security/);
  });

  it('组织 A 只看到自己的项目，按 ID 查不到、改不到组织 B 的项目', async () => {
    await withTenant(appDb, a.context, async (trx) => {
      expect(await trx.selectFrom('projects').select('id').execute()).toEqual([{ id: projectA }]);
      expect(await trx.selectFrom('projects').selectAll().where('id', '=', projectB).execute()).toEqual([]);
      const renamed = await trx.updateTable('projects').set({ name: '篡改' }).where('id', '=', projectB).executeTakeFirst();
      expect(renamed.numUpdatedRows).toBe(0n);
    });
    const row = await superuser.selectFrom('projects').select('name').where('id', '=', projectB).executeTakeFirstOrThrow();
    expect(row.name).toBe('某项目技术方案');
  });

  it.each<[string, (trx: Kysely<Database>) => Promise<unknown>, RegExp]>([
    ['在组织 B 中建项目', (trx) =>
      trx.insertInto('projects').values({ org_id: b.orgId, kind: 'technical-plan', name: 'x', created_by: a.userId }).execute(), /row-level security/],
    ['以别的用户的身份建项目', (trx) =>
      trx.insertInto('projects').values({ org_id: a.orgId, kind: 'technical-plan', name: 'x', created_by: b.userId }).execute(), /row-level security/],
    ['物理删除项目', (trx) => trx.deleteFrom('projects').where('id', '=', projectA).execute(), /permission denied/],
    ['修改 kind', (trx) => trx.updateTable('projects').set({ kind: 'duplicate-check' } as never).where('id', '=', projectA).execute(), /permission denied/],
    ['修改 created_by', (trx) => trx.updateTable('projects').set({ created_by: b.userId } as never).where('id', '=', projectA).execute(), /permission denied/],
    ['修改 org_id', (trx) => trx.updateTable('projects').set({ org_id: b.orgId } as never).where('id', '=', projectA).execute(), /permission denied/],
    ['以别的用户的名义删除', (trx) =>
      trx.updateTable('projects').set({ deleted_at: new Date(), deleted_by: b.userId }).where('id', '=', projectA).execute(), /row-level security/],
    ['名称首尾带空白', (trx) =>
      trx.insertInto('projects').values({ org_id: a.orgId, kind: 'technical-plan', name: ' x ', created_by: a.userId }).execute(), /check constraint/],
    ['kind 不在白名单中', (trx) =>
      trx.insertInto('projects').values({ org_id: a.orgId, kind: 'knowledge-base' as never, name: 'x', created_by: a.userId }).execute(), /check constraint/],
  ])('组织 A 的应用角色不能%s', async (_name, write, error) => {
    await expect(withTenant(appDb, a.context, (trx) => write(trx))).rejects.toThrow(error);
    const row = await superuser.selectFrom('projects').selectAll().where('id', '=', projectA).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: a.orgId, kind: 'technical-plan', created_by: a.userId, deleted_at: null });
  });

  it('守卫：已删除的项目不能改名或重复删除；超过 7 天不能恢复；更新时刷新 updated_at', async () => {
    const project = await createOk(a, 'rejection-check', '待删除');
    await withTenant(appDb, a.context, async (trx) => {
      await trx.updateTable('projects').set({ deleted_at: new Date(), deleted_by: a.userId }).where('id', '=', project.id).execute();
    });
    await expect(
      withTenant(appDb, a.context, (trx) => trx.updateTable('projects').set({ name: '改名' }).where('id', '=', project.id).execute()),
    ).rejects.toMatchObject({ code: 'PJ004' });
    await expect(
      withTenant(appDb, a.context, (trx) =>
        trx.updateTable('projects').set({ deleted_at: new Date(), deleted_by: a.userId }).where('id', '=', project.id).execute(),
      ),
    ).rejects.toMatchObject({ code: 'PJ004' });

    await backdateDeletion(project.id, 8);
    await expect(
      withTenant(appDb, a.context, (trx) =>
        trx.updateTable('projects').set({ deleted_at: null, deleted_by: null }).where('id', '=', project.id).execute(),
      ),
    ).rejects.toMatchObject({ code: 'PJ002' });

    const before = await superuser.selectFrom('projects').select('updated_at').where('id', '=', projectA).executeTakeFirstOrThrow();
    await withTenant(appDb, a.context, (trx) => trx.updateTable('projects').set({ name: '新名称' }).where('id', '=', projectA).execute());
    const after = await superuser.selectFrom('projects').select(['name', 'updated_at']).where('id', '=', projectA).executeTakeFirstOrThrow();
    expect(after.name).toBe('新名称');
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});

describe('files.project_id', () => {
  describeProjectTable(
    {
      table: 'files',
      idColumn: 'id',
      async insert(trx, scope) {
        const row = await trx
          .insertInto('files')
          .values({ org_id: scope.orgId, project_id: scope.projectId, purpose: 'tender', display_name: 'a.pdf', extension: 'pdf', created_by: scope.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        return row.id;
      },
      update: { project_id: null },
      onProjectDelete: 'restrict',
      projectIdNullable: true,
      definerRoles: [STORAGE_ROLE],
    },
    { admin: () => superuser, app: () => appDb },
  );

  it('project_id 可空：不属于项目的文件照常写入', async () => {
    const member = await newMember();
    const id = await withTenant(appDb, member.context, async (trx) => {
      const row = await trx
        .insertInto('files')
        .values({ org_id: member.orgId, purpose: 'knowledge', display_name: 'b.docx', extension: 'docx', created_by: member.userId })
        .returning(['id', 'project_id'])
        .executeTakeFirstOrThrow();
      expect(row.project_id).toBeNull();
      return row.id;
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('文件接口返回 projectId', async () => {
    const member = await newMember();
    const project = await createOk(member);
    // 用超级用户直接写入已上传的记录（不经对象存储和配额触发器），只验证接口的返回字段。
    const { id: fileId } = await superuser
      .insertInto('files')
      .values({
        org_id: member.orgId, project_id: project.id, purpose: 'tender', display_name: 'c.pdf', extension: 'pdf', created_by: member.userId,
        status: 'uploaded', mime: 'application/pdf', size_bytes: 10, sha256: Buffer.alloc(32), uploaded_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const response = await call(member, 'GET', `/api/files/${fileId}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: fileId, projectId: project.id });
  });
});

describe('项目级表模板', () => {
  const env = { admin: () => superuser, app: () => appDb };

  describeProjectTable(
    {
      table: 'example_project_meta',
      idColumn: 'project_id',
      async insert(trx, scope) {
        await trx.insertInto('example_project_meta').values({ org_id: scope.orgId, project_id: scope.projectId, options: { mode: 'auto' } }).execute();
        return scope.projectId;
      },
      update: { step: 'outline' },
      onProjectDelete: 'cascade',
    },
    env,
  );

  describeProjectTable(
    {
      table: 'example_project_items',
      idColumn: 'id',
      async insert(trx, scope) {
        const row = await trx
          .insertInto('example_project_items')
          .values({ org_id: scope.orgId, project_id: scope.projectId, title: '条目', payload: { level: 1 } })
          .returning('id')
          .executeTakeFirstOrThrow();
        return row.id;
      },
      update: { title: '改过的条目' },
      onProjectDelete: 'cascade',
    },
    env,
  );

  it('jsonb 原样读写并约束顶层类型，timestamptz 读出为 Date，updated_at 由触发器刷新', async () => {
    const member = await newMember();
    const project = await createOk(member);
    const db = appDb as Kysely<any>;
    const row = await withTenantAny(db, member.context, (trx) =>
      trx
        .insertInto('example_project_items')
        .values({ org_id: member.orgId, project_id: project.id, title: '条目', payload: JSON.stringify({ tags: ['甲', '乙'], n: 1 }) })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    expect(row.payload).toEqual({ tags: ['甲', '乙'], n: 1 });
    expect(row.created_at).toBeInstanceOf(Date);

    // 同一事务内 now() 不变，所以另起事务更新。
    await withTenantAny(db, member.context, (trx) => trx.updateTable('example_project_items').set({ title: '改名' }).where('id', '=', row.id).execute());
    const updated = await superuser.selectFrom('example_project_items').select('updated_at').where('id', '=', row.id).executeTakeFirstOrThrow();
    expect(updated.updated_at.getTime()).toBeGreaterThan(row.updated_at.getTime());

    await expect(
      withTenantAny(db, member.context, (trx) =>
        trx.insertInto('example_project_items').values({ org_id: member.orgId, project_id: project.id, title: 'x', payload: '[1]' }).execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('引用文件同样用复合外键：挂不上别的组织的文件', async () => {
    const a = await newMember();
    const b = await newMember();
    const project = await createOk(a);
    const fileB = await withTenant(appDb, b.context, async (trx) => {
      const row = await trx
        .insertInto('files')
        .values({ org_id: b.orgId, purpose: 'tender', display_name: 'b.pdf', extension: 'pdf', created_by: b.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    await expect(
      withTenantAny(appDb, a.context, (trx) =>
        trx.insertInto('example_project_items').values({ org_id: a.orgId, project_id: project.id, source_file_id: fileB, title: 'x' }).execute(),
      ),
    ).rejects.toThrow(/foreign key constraint/);
  });
});

describe('项目接口', () => {
  it('未登录返回 401，缺少跨站校验头返回 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
    const member = await newMember();
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: `__Host-session=${member.cookie}`, origin: testConfig.publicOrigin },
      payload: { kind: 'technical-plan', name: 'x' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('新建、查看、列出、改名、删除、恢复', async () => {
    const member = await newMember();
    const created = await createOk(member, 'feasibility-report', '可研报告');
    expect(created).toMatchObject({
      kind: 'feasibility-report',
      name: '可研报告',
      createdBy: member.userId,
      deletedAt: null,
      restoreUntil: null,
    });
    const other = await createOk(member, 'duplicate-check', '查重');

    const fetched = await call(member, 'GET', `/api/projects/${created.id.toUpperCase()}`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['cache-control']).toBe('no-store');
    expect(fetched.json()).toEqual(created);

    const all = await call(member, 'GET', '/api/projects');
    expect(all.json().projects.map((p: { id: string }) => p.id)).toEqual([other.id, created.id]);
    const filtered = await call(member, 'GET', '/api/projects?kind=duplicate-check');
    expect(filtered.json().projects.map((p: { id: string }) => p.id)).toEqual([other.id]);

    const renamed = await call(member, 'PATCH', `/api/projects/${created.id}`, { name: '  新​名称\u0007 ' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().name).toBe('新名称');

    const deleted = await call(member, 'DELETE', `/api/projects/${created.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().deletedAt).not.toBeNull();
    expect(new Date(deleted.json().restoreUntil).getTime() - new Date(deleted.json().deletedAt).getTime()).toBe(7 * 86_400_000);
    expect((await call(member, 'GET', `/api/projects/${created.id}`)).statusCode).toBe(404);
    expect((await call(member, 'PATCH', `/api/projects/${created.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await call(member, 'DELETE', `/api/projects/${created.id}`)).statusCode).toBe(404);
    expect((await call(member, 'GET', '/api/projects')).json().projects.map((p: { id: string }) => p.id)).toEqual([other.id]);
    expect((await call(member, 'GET', '/api/projects?deleted=true')).json().projects.map((p: { id: string }) => p.id)).toEqual([created.id]);

    const restored = await call(member, 'POST', `/api/projects/${created.id}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: created.id, name: '新名称', deletedAt: null, restoreUntil: null });
    expect((await call(member, 'POST', `/api/projects/${created.id}/restore`)).statusCode).toBe(404);
  });

  it('同组织的其他成员可以看到、修改项目（组织内共享）', async () => {
    const owner = await newMember();
    const colleague = await newMember(owner.orgId);
    const project = await createOk(owner);
    expect((await call(colleague, 'GET', `/api/projects/${project.id}`)).statusCode).toBe(200);
    expect((await call(colleague, 'PATCH', `/api/projects/${project.id}`, { name: '同事改的' })).json().name).toBe('同事改的');
  });

  it('超过恢复期的项目不能恢复，也不在回收站中', async () => {
    const member = await newMember();
    const project = await createOk(member);
    expect((await call(member, 'DELETE', `/api/projects/${project.id}`)).statusCode).toBe(200);
    await backdateDeletion(project.id, 8);
    const response = await call(member, 'POST', `/api/projects/${project.id}/restore`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PROJECT_NOT_FOUND');
    expect((await call(member, 'GET', '/api/projects?deleted=true')).json().projects).toEqual([]);
  });

  it('跨组织：别的组织的项目一律 404，且不被修改', async () => {
    const a = await newMember();
    const b = await newMember();
    const project = await createOk(b, 'technical-plan', 'B 的项目');
    const deletedProject = await createOk(b, 'technical-plan', 'B 删除的项目');
    expect((await call(b, 'DELETE', `/api/projects/${deletedProject.id}`)).statusCode).toBe(200);

    const responses = [
      await call(a, 'GET', `/api/projects/${project.id}`),
      await call(a, 'PATCH', `/api/projects/${project.id}`, { name: '篡改' }),
      await call(a, 'DELETE', `/api/projects/${project.id}`),
      await call(a, 'POST', `/api/projects/${deletedProject.id}/restore`),
      await call(a, 'GET', `/api/projects/${project.id}/technical-plan`),
    ];
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().error.code).toBe('PROJECT_NOT_FOUND');
    }
    expect((await call(a, 'GET', '/api/projects')).json().projects).toEqual([]);
    expect((await call(a, 'GET', '/api/projects?deleted=true')).json().projects).toEqual([]);

    const rows = await superuser.selectFrom('projects').select(['id', 'name', 'deleted_at']).where('org_id', '=', b.orgId).orderBy('created_at').execute();
    expect(rows).toEqual([
      { id: project.id, name: 'B 的项目', deleted_at: null },
      { id: deletedProject.id, name: 'B 删除的项目', deleted_at: expect.any(Date) },
    ]);
  });

  it.each([
    ['kind 不合法', { kind: 'knowledge-base', name: 'x' }],
    ['缺少名称', { kind: 'technical-plan' }],
    ['名称只有空白和不可见字符', { kind: 'technical-plan', name: ' ​‮ ' }],
    ['名称超过 200 字', { kind: 'technical-plan', name: '字'.repeat(PROJECT_NAME_MAX_LENGTH + 1) }],
    ['多余字段', { kind: 'technical-plan', name: 'x', orgId: randomUUID() }],
  ])('新建时%s返回 400', async (_name, payload) => {
    const member = await newMember();
    const response = await call(member, 'POST', '/api/projects', payload);
    expect(response.statusCode, response.body).toBe(400);
    expect(await superuser.selectFrom('projects').select('id').where('org_id', '=', member.orgId).execute()).toEqual([]);
  });

  it('名称正好 200 字可以保存；projectId 格式不对返回 400', async () => {
    const member = await newMember();
    const project = await createOk(member, 'technical-plan', '字'.repeat(PROJECT_NAME_MAX_LENGTH));
    expect([...project.name]).toHaveLength(PROJECT_NAME_MAX_LENGTH);
    expect((await call(member, 'GET', "/api/projects/' OR 1=1 --")).statusCode).toBe(400);
    expect((await call(member, 'GET', '/api/projects/not-a-uuid/technical-plan')).statusCode).toBe(400);
  });
});

describe('路由层的项目归属校验（requireProject）', () => {
  it('本组织、kind 相符的项目放行；kind 不符、已删除、不存在一律返回相同的 404', async () => {
    const member = await newMember();
    const plan = await createOk(member, 'technical-plan');
    const check = await createOk(member, 'rejection-check');
    const removed = await createOk(member, 'technical-plan');
    expect((await call(member, 'DELETE', `/api/projects/${removed.id}`)).statusCode).toBe(200);

    const ok = await call(member, 'GET', `/api/projects/${plan.id.toUpperCase()}/technical-plan`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: plan.id, kind: 'technical-plan' });

    const bodies = [];
    for (const id of [check.id, removed.id, randomUUID()]) {
      const response = await call(member, 'GET', `/api/projects/${id}/technical-plan`);
      expect(response.statusCode).toBe(404);
      bodies.push({ ...response.json().error, requestId: undefined });
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ code: 'PROJECT_NOT_FOUND', message: '项目不存在' });
  });

  it('只认上下文中的组织：别的组织的项目查不到', async () => {
    const a = await newMember();
    const b = await newMember();
    const project = await createOk(b);
    await expect(requireProject(appDb, a.context, project.id, null)).rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_NOT_FOUND' });
    await expect(requireProject(appDb, b.context, project.id, null)).resolves.toMatchObject({ id: project.id, orgId: b.orgId });
  });
});
