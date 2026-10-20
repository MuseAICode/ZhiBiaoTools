// 资信库（迁移 0011_credential_library）的数据库与接口测试：六张表的隔离模板（describeProjectTable，组织级），
// 权限与删除可见性由 RLS 强制（绕过 Store 直接写库同样被拒绝），图片随文件的生命周期，记录与图片数上限，
// 以及 /api/credential-library。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import {
  CREDENTIAL_IMAGES_PER_ORG_MAX,
  CREDENTIAL_LONG_TEXT_MAX,
  CREDENTIAL_RECORDS_PER_ORG_MAX,
  CREDENTIAL_SHORT_TEXT_MAX,
} from '../../src/db/migrations/0011_credential_library.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable, withTenantAny, type ProjectRowScope } from './projectTable.ts';

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

interface FileOptions {
  purpose?: string;
  status?: 'uploading' | 'uploaded';
  deleted?: boolean;
  projectId?: string;
}

/** 用超级用户直接登记一个文件（默认已上传的资信库图片）。 */
async function newFile(member: Pick<Member, 'orgId' | 'userId'>, options: FileOptions = {}): Promise<string> {
  const uploaded = (options.status ?? 'uploaded') === 'uploaded';
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      project_id: options.projectId ?? null,
      purpose: options.purpose ?? 'credential-image',
      display_name: '营业执照.png',
      extension: 'png',
      status: uploaded ? 'uploaded' : 'uploading',
      mime: uploaded ? 'image/png' : null,
      size_bytes: uploaded ? 100 : null,
      sha256: uploaded ? Buffer.alloc(32) : null,
      uploaded_at: uploaded ? new Date() : null,
      created_by: member.userId,
      deleted_at: options.deleted ? new Date() : null,
      deleted_by: options.deleted ? member.userId : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** 在当前上下文中经应用角色上传一个资信库图片文件（隔离模板用：组织不对时在这一步就被 RLS 拒绝）。 */
async function uploadInContext(trx: Transaction<any>, scope: ProjectRowScope): Promise<string> {
  const file = await trx
    .insertInto('files')
    .values({ org_id: scope.orgId, purpose: 'credential-image', display_name: 'a.png', extension: 'png', created_by: scope.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.updateTable('files').set({ status: 'uploaded', mime: 'image/png', size_bytes: 10, sha256: Buffer.alloc(32) }).where('id', '=', file.id).execute();
  return file.id;
}

function call(member: Member | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

async function ok(member: Member, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, status = 200) {
  const response = await call(member, method, `/api/credential-library${url}`, payload);
  expect(response.statusCode, response.body).toBe(status);
  return response.json();
}

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

const lib = (member: Member | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  call(member, method, `/api/credential-library${url}`, payload);

async function fileState(fileId: string) {
  return superuser.selectFrom('files').select(['deleted_at', 'deleted_by']).where('id', '=', fileId).executeTakeFirst();
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
  const env = { admin: () => superuser, app: () => appDb };

  describeProjectTable(
    {
      table: 'credential_library_profile',
      idColumn: 'org_id',
      scope: 'org',
      async insert(trx, scope) {
        const row = await trx
          .insertInto('credential_library_profile')
          .values({ org_id: scope.orgId, company_name: '公司', updated_by: scope.userId })
          .returning('org_id')
          .executeTakeFirstOrThrow();
        return row.org_id;
      },
      update: { company_name: '改名' },
    },
    env,
  );

  const recordTables = [
    ['credential_library_certificates', { name: '证书' }, { name: '改名' }],
    ['credential_library_employees', { name: '员工' }, { name: '改名' }],
    ['credential_library_projects', { project_name: '业绩' }, { project_name: '改名' }],
    ['credential_library_other_materials', { name: '资料' }, { name: '改名' }],
  ] as const;
  for (const [table, values, update] of recordTables) {
    describeProjectTable(
      {
        table,
        idColumn: 'id',
        scope: 'org',
        async insert(trx, scope) {
          const row = await trx
            .insertInto(table)
            .values({ org_id: scope.orgId, ...values, created_by: scope.userId, updated_by: scope.userId })
            .returning('id')
            .executeTakeFirstOrThrow();
          return row.id;
        },
        update,
      },
      env,
    );
  }

  describeProjectTable(
    {
      table: 'credential_library_images',
      idColumn: 'id',
      scope: 'org',
      async insert(trx, scope) {
        const fileId = await uploadInContext(trx, scope);
        const row = await trx
          .insertInto('credential_library_images')
          .values({ org_id: scope.orgId, owner_type: 'profile', field_key: 'businessLicense', file_id: fileId, created_by: scope.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        return row.id;
      },
      update: { custom_name: '改名' },
    },
    env,
  );
});

describe('权限与删除可见性由 RLS 强制', () => {
  let a: Member;
  let peer: Member;
  let b: Member;
  let certificateId: string;

  const insertImage = (member: Pick<Member, 'context'>, values: Record<string, unknown>) =>
    withTenantAny(appDb, member.context, (trx) =>
      trx
        .insertInto('credential_library_images')
        .values({ org_id: member.context.orgId, owner_type: 'profile', field_key: 'businessLicense', created_by: member.context.userId, ...values })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );

  const visibleImages = (member: Pick<Member, 'context'>) =>
    withTenant(appDb, member.context, (trx) => trx.selectFrom('credential_library_images').select('id').orderBy('created_at').execute());

  beforeAll(async () => {
    a = await newMember();
    peer = await newMember(a.orgId);
    b = await newMember();
    const row = await withTenant(appDb, a.context, (trx) =>
      trx
        .insertInto('credential_library_certificates')
        .values({ org_id: a.orgId, name: '证书', created_by: a.userId, updated_by: a.userId })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    certificateId = row.id;
  });

  it('组织内其他成员可以读写同一份资信库（组织内共享）', async () => {
    await withTenant(appDb, peer.context, async (trx) => {
      const updated = await trx
        .updateTable('credential_library_certificates')
        .set({ number: 'NO-1', updated_by: peer.userId })
        .where('id', '=', certificateId)
        .executeTakeFirst();
      expect(updated.numUpdatedRows).toBe(1n);
    });
  });

  it('created_by / updated_by 必须是当前用户，不能代他人写入', async () => {
    await expect(
      withTenant(appDb, a.context, (trx) =>
        trx.insertInto('credential_library_certificates').values({ org_id: a.orgId, name: 'x', created_by: peer.userId, updated_by: a.userId }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(appDb, a.context, (trx) =>
        trx.updateTable('credential_library_certificates').set({ name: 'x', updated_by: peer.userId }).where('id', '=', certificateId).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(appDb, a.context, (trx) =>
        trx.insertInto('credential_library_profile').values({ org_id: a.orgId, updated_by: peer.userId }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(insertImage(a, { file_id: await newFile(a), created_by: peer.userId })).rejects.toThrow(/row-level security/);
  });

  it('只能挂本组织已上传、未删除、不属于项目的资信库图片文件，每个文件只能挂一次', async () => {
    const project = await superuser
      .insertInto('projects')
      .values({ org_id: a.orgId, kind: 'technical-plan', name: '项目', created_by: a.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const rejected = [
      await newFile(b),
      await newFile(a, { status: 'uploading' }),
      await newFile(a, { deleted: true }),
      await newFile(a, { purpose: 'tender' }),
      await newFile(a, { projectId: project.id }),
      randomUUID(),
    ];
    for (const fileId of rejected) {
      await expect(insertImage(a, { file_id: fileId })).rejects.toThrow(/row-level security/);
    }
    const fileId = await newFile(a);
    await insertImage(a, { file_id: fileId });
    await expect(insertImage(a, { file_id: fileId, field_key: 'auditReport' })).rejects.toThrow(/unique constraint/);
  });

  it('归属记录必须属于本组织，归属类型与图片栏目由 CHECK 约束绑定', async () => {
    const other = await withTenant(appDb, b.context, (trx) =>
      trx
        .insertInto('credential_library_certificates')
        .values({ org_id: b.orgId, name: 'B', created_by: b.userId, updated_by: b.userId })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await expect(
      insertImage(a, { file_id: await newFile(a), owner_type: 'certificate', certificate_id: other.id, field_key: 'certificateImages' }),
    ).rejects.toThrow(/foreign key constraint/);
    await expect(insertImage(a, { file_id: await newFile(a), owner_type: 'certificate', certificate_id: certificateId, field_key: 'businessLicense' }))
      .rejects.toThrow(/credential_library_images_owner_shape/);
    await expect(insertImage(a, { file_id: await newFile(a), certificate_id: certificateId })).rejects.toThrow(/credential_library_images_owner_shape/);
    await expect(insertImage(a, { file_id: await newFile(a), owner_type: 'certificate', field_key: 'certificateImages' }))
      .rejects.toThrow(/credential_library_images_owner_shape/);
  });

  it('图片的归属和文件写入后不能改，应用角色不能删除图片行，也不能删除企业信息', async () => {
    const image = await insertImage(a, { file_id: await newFile(a) });
    for (const set of [{ file_id: await newFile(a) }, { owner_type: 'other' }, { field_key: 'auditReport' }, { certificate_id: certificateId }, { org_id: b.orgId }]) {
      await expect(
        withTenantAny(appDb, a.context, (trx) => trx.updateTable('credential_library_images').set(set).where('id', '=', image.id).execute()),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      withTenant(appDb, a.context, (trx) => trx.deleteFrom('credential_library_images').where('id', '=', image.id).execute()),
    ).rejects.toThrow(/permission denied/);
    await withTenant(appDb, a.context, (trx) => trx.insertInto('credential_library_profile').values({ org_id: a.orgId, updated_by: a.userId }).execute());
    await expect(
      withTenant(appDb, a.context, (trx) => trx.deleteFrom('credential_library_profile').execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('所引用的文件删除后图片查不到、改不了，恢复文件即一起恢复', async () => {
    const fileId = await newFile(a);
    const image = await insertImage(a, { file_id: fileId });
    expect((await visibleImages(a)).map((row) => row.id)).toContain(image.id);

    await withTenant(appDb, a.context, (trx) =>
      trx.updateTable('files').set({ deleted_at: new Date(), deleted_by: a.userId }).where('id', '=', fileId).execute(),
    );
    expect((await visibleImages(a)).map((row) => row.id)).not.toContain(image.id);
    // 不带条件的全表查询同样查不到。
    const all = await withTenant(appDb, a.context, (trx) => trx.selectFrom('credential_library_images').select('file_id').execute());
    expect(all.map((row) => row.file_id)).not.toContain(fileId);
    const renamed = await withTenant(appDb, a.context, (trx) =>
      trx.updateTable('credential_library_images').set({ custom_name: '改名' }).where('id', '=', image.id).executeTakeFirst(),
    );
    expect(renamed.numUpdatedRows).toBe(0n);

    await withTenant(appDb, a.context, (trx) => trx.updateTable('files').set({ deleted_at: null, deleted_by: null }).where('id', '=', fileId).execute());
    expect((await visibleImages(a)).map((row) => row.id)).toContain(image.id);
  });

  it('文件被物理删除（清理任务）、记录被删除时，图片行随之删除', async () => {
    const fileId = await newFile(a);
    const image = await insertImage(a, { file_id: fileId });
    await superuser.deleteFrom('files').where('id', '=', fileId).execute();
    expect(await superuser.selectFrom('credential_library_images').select('id').where('id', '=', image.id).execute()).toEqual([]);

    const record = await withTenant(appDb, a.context, (trx) =>
      trx
        .insertInto('credential_library_other_materials')
        .values({ org_id: a.orgId, name: '资料', created_by: a.userId, updated_by: a.userId })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const owned = await insertImage(a, { file_id: await newFile(a), owner_type: 'other', material_id: record.id, field_key: 'otherMaterialImages' });
    await withTenant(appDb, a.context, (trx) => trx.deleteFrom('credential_library_other_materials').where('id', '=', record.id).execute());
    expect(await superuser.selectFrom('credential_library_images').select('id').where('id', '=', owned.id).execute()).toEqual([]);
  });

  it('每类记录、图片数达到上限后不能再新增（CL001）', async () => {
    const member = await newMember();
    await sql`INSERT INTO credential_library_employees (org_id, name, created_by, updated_by)
      SELECT ${member.orgId}::uuid, 'e' || g, ${member.userId}::uuid, ${member.userId}::uuid
      FROM generate_series(1, ${CREDENTIAL_RECORDS_PER_ORG_MAX - 1}) g`.execute(superuser);
    const insert = () =>
      withTenant(appDb, member.context, (trx) =>
        trx.insertInto('credential_library_employees').values({ org_id: member.orgId, name: 'x', created_by: member.userId, updated_by: member.userId }).execute(),
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: 'CL001' });
    // 其他记录表和其他组织不受影响。
    await withTenant(appDb, member.context, (trx) =>
      trx.insertInto('credential_library_projects').values({ org_id: member.orgId, created_by: member.userId, updated_by: member.userId }).execute(),
    );

    await sql`WITH f AS (
        INSERT INTO files (org_id, purpose, display_name, extension, status, mime, size_bytes, sha256, uploaded_at, created_by)
        SELECT ${member.orgId}::uuid, 'credential-image', 'a.png', 'png', 'uploaded', 'image/png', 1, ${Buffer.alloc(32)}, now(), ${member.userId}::uuid
        FROM generate_series(1, ${CREDENTIAL_IMAGES_PER_ORG_MAX}) RETURNING id)
      INSERT INTO credential_library_images (org_id, owner_type, field_key, file_id, created_by)
      SELECT ${member.orgId}::uuid, 'profile', 'officeEnvironment', id, ${member.userId}::uuid FROM f`.execute(superuser);
    await expect(insertImage(member, { file_id: await newFile(member) })).rejects.toMatchObject({ code: 'CL001' });
  });
});

describe('/api/credential-library', () => {
  let a: Member;
  let peer: Member;
  let b: Member;

  beforeAll(async () => {
    a = await newMember();
    peer = await newMember(a.orgId);
    b = await newMember();
  });

  it('需要登录', async () => {
    expect((await lib(null, 'GET', '')).statusCode).toBe(401);
    expect((await lib(null, 'PATCH', '/profile', { companyName: 'x' })).statusCode).toBe(401);
  });

  it('没写过时返回空快照，不预先插入行', async () => {
    const snapshot = await ok(a, 'GET', '');
    expect(snapshot).toMatchObject({
      profile: { companyName: '', watermarkEnabled: false, watermarkContent: '', createdAt: null, updatedAt: null, updatedBy: null },
      certificates: [],
      employees: [],
      projects: [],
      otherMaterials: [],
      images: [],
    });
    expect(Object.keys(snapshot.profile)).toHaveLength(29);
    expect(await superuser.selectFrom('credential_library_profile').selectAll().where('org_id', '=', a.orgId).execute()).toEqual([]);
  });

  it('企业信息按 patch 保存，未给出的字段不变；组织内成员都能修改', async () => {
    let snapshot = await ok(a, 'PATCH', '/profile', { companyName: '某某有限公司', bankAccountNumber: '6222 0000', watermarkEnabled: true });
    expect(snapshot.profile).toMatchObject({ companyName: '某某有限公司', bankAccountNumber: '6222 0000', watermarkEnabled: true, updatedBy: a.userId });
    snapshot = await ok(peer, 'PATCH', '/profile', { companyIntro: '介绍' });
    expect(snapshot.profile).toMatchObject({ companyName: '某某有限公司', companyIntro: '介绍', watermarkEnabled: true, updatedBy: peer.userId });
    expect((await ok(b, 'GET', '')).profile.companyName).toBe('');
  });

  it('企业信息：拒绝未声明字段、超长文本、类型不符和 \\u0000', async () => {
    await expectError(await lib(a, 'PATCH', '/profile', { apiKey: 'x' }), 400, 'BAD_REQUEST');
    await expectError(await lib(a, 'PATCH', '/profile', { companyName: 'x'.repeat(CREDENTIAL_SHORT_TEXT_MAX + 1) }), 400, 'BAD_REQUEST');
    await expectError(await lib(a, 'PATCH', '/profile', { companyIntro: 'x'.repeat(CREDENTIAL_LONG_TEXT_MAX + 1) }), 400, 'BAD_REQUEST');
    await expectError(await lib(a, 'PATCH', '/profile', { watermarkEnabled: 'yes' }), 400, 'BAD_REQUEST');
    await expectError(await lib(a, 'PATCH', '/profile', { companyName: 'a\u0000b' }), 400, 'CREDENTIAL_INVALID');
    await ok(a, 'PATCH', '/profile', { companyIntro: 'x'.repeat(CREDENTIAL_LONG_TEXT_MAX) });
  });

  it('企业信息的图片：挂已上传的资信库图片，按栏目顺序排列；不可用的文件返回 400', async () => {
    const first = await newFile(a);
    const second = await newFile(a);
    let snapshot = await ok(a, 'POST', '/profile/images', { fieldKey: 'businessLicense', images: [{ fileId: first, customName: '正本' }] });
    snapshot = await ok(a, 'POST', '/profile/images', { fieldKey: 'businessLicense', images: [{ fileId: second.toUpperCase() }] });
    const images = snapshot.images.filter((image: { fieldKey: string }) => image.fieldKey === 'businessLicense');
    expect(images).toMatchObject([
      { ownerType: 'profile', ownerId: null, fileId: first, originalName: '营业执照.png', customName: '正本', sortOrder: 0 },
      { ownerType: 'profile', ownerId: null, fileId: second, customName: '', sortOrder: 1 },
    ]);

    for (const fileId of [first, await newFile(b), await newFile(a, { purpose: 'tender' }), await newFile(a, { deleted: true }), randomUUID()]) {
      await expectError(await lib(a, 'POST', '/profile/images', { fieldKey: 'auditReport', images: [{ fileId }] }), 400, 'CREDENTIAL_IMAGE_UNAVAILABLE');
    }
    const duplicate = await newFile(a);
    await expectError(
      await lib(a, 'POST', '/profile/images', { fieldKey: 'auditReport', images: [{ fileId: duplicate }, { fileId: duplicate }] }),
      400,
      'CREDENTIAL_IMAGE_UNAVAILABLE',
    );
    await expectError(await lib(a, 'POST', '/profile/images', { fieldKey: 'certificateImages', images: [{ fileId: duplicate }] }), 400, 'BAD_REQUEST');
    await expectError(await lib(a, 'POST', '/profile/images', { fieldKey: 'auditReport', images: [] }), 400, 'BAD_REQUEST');
  });

  it('删除图片即软删除其文件；恢复文件后图片回到原位；其他组织的图片返回 404', async () => {
    const fileId = await newFile(a);
    let snapshot = await ok(a, 'POST', '/profile/images', { fieldKey: 'officeEnvironment', images: [{ fileId }] });
    const image = snapshot.images.find((item: { fileId: string }) => item.fileId === fileId);

    await expectError(await lib(b, 'DELETE', `/images/${image.id}`), 404, 'CREDENTIAL_IMAGE_NOT_FOUND');
    expect((await fileState(fileId))?.deleted_at).toBeNull();

    snapshot = await ok(a, 'DELETE', `/images/${image.id}`);
    expect(snapshot.images.some((item: { id: string }) => item.id === image.id)).toBe(false);
    expect(await fileState(fileId)).toMatchObject({ deleted_by: a.userId });
    await expectError(await lib(a, 'DELETE', `/images/${image.id}`), 404, 'CREDENTIAL_IMAGE_NOT_FOUND');

    const restored = await call(a, 'POST', `/api/files/${fileId}/restore`);
    expect(restored.statusCode, restored.body).toBe(200);
    snapshot = await ok(a, 'GET', '');
    expect(snapshot.images.find((item: { id: string }) => item.id === image.id)).toMatchObject({ fileId, sortOrder: image.sortOrder });
  });

  it('记录：新建、整份保存（含图片的新增、删除、改名）、删除；文件进回收站', async () => {
    const kept = await newFile(a);
    const removed = await newFile(a);
    let result = await ok(
      a,
      'POST',
      '/certificates',
      {
        record: { name: 'ISO 9001', number: 'Q-1', validityMode: 'range', validFrom: '2024-01-01', validTo: '2027-01-01' },
        newImages: [
          { fieldKey: 'certificateImages', fileId: kept, customName: '正本' },
          { fieldKey: 'certificateImages', fileId: removed },
        ],
      },
      201,
    );
    const id = result.id;
    expect(result.snapshot.certificates).toMatchObject([
      { id, name: 'ISO 9001', number: 'Q-1', validityMode: 'range', validFrom: '2024-01-01', validTo: '2027-01-01', createdBy: a.userId },
    ]);
    const images = result.snapshot.images.filter((image: { ownerId: string }) => image.ownerId === id);
    expect(images.map((image: { fileId: string; sortOrder: number }) => [image.fileId, image.sortOrder])).toEqual([
      [kept, 0],
      [removed, 1],
    ]);
    const [keptImage, removedImage] = images;

    const added = await newFile(a);
    result = await ok(peer, 'PUT', `/certificates/${id}`, {
      record: { name: 'ISO 14001', validityMode: 'long-term' },
      newImages: [{ fieldKey: 'certificateImages', fileId: added }],
      removedImageIds: [removedImage.id, randomUUID()],
      imageNameUpdates: [{ imageId: keptImage.id, customName: '副本' }],
    });
    // 整份保存：没有给出的字段存为空字符串（与桌面版相同）。
    expect(result.snapshot.certificates).toMatchObject([{ id, name: 'ISO 14001', number: '', validityMode: 'long-term', validFrom: '', updatedBy: peer.userId }]);
    expect(
      result.snapshot.images
        .filter((image: { ownerId: string }) => image.ownerId === id)
        .map((image: { fileId: string; customName: string; sortOrder: number }) => [image.fileId, image.customName, image.sortOrder]),
    ).toEqual([
      [kept, '副本', 0],
      [added, '', 1],
    ]);
    expect(await fileState(removed)).toMatchObject({ deleted_by: peer.userId });

    const snapshot = await ok(a, 'DELETE', `/certificates/${id}`);
    expect(snapshot.certificates).toEqual([]);
    expect(snapshot.images.some((image: { ownerId: string }) => image.ownerId === id)).toBe(false);
    for (const fileId of [kept, added]) expect(await fileState(fileId)).toMatchObject({ deleted_by: a.userId });
    expect(await superuser.selectFrom('credential_library_images').select('id').where('certificate_id', '=', id).execute()).toEqual([]);
    await expectError(await lib(a, 'DELETE', `/certificates/${id}`), 404, 'CREDENTIAL_RECORD_NOT_FOUND');
  });

  it('四类记录的字段与路径', async () => {
    const employee = await ok(a, 'POST', '/employees', { record: { name: '张三', idNumber: '110101199001011234', idValidityMode: 'long-term', introduction: '简介' } }, 201);
    expect(employee.snapshot.employees[0]).toMatchObject({ id: employee.id, name: '张三', idNumber: '110101199001011234', idValidityMode: 'long-term' });
    const project = await ok(a, 'POST', '/projects', { record: { projectName: '某项目', projectType: 'goods', contractAmount: '100 万元' } }, 201);
    expect(project.snapshot.projects[0]).toMatchObject({ id: project.id, projectName: '某项目', projectType: 'goods', contractAmount: '100 万元' });
    const other = await ok(a, 'POST', '/other-materials', { record: { name: '其他', note: '备注' } }, 201);
    expect(other.snapshot.otherMaterials[0]).toMatchObject({ id: other.id, name: '其他', note: '备注' });
    // 记录 id 不能跨类型使用。
    await expectError(await lib(a, 'PUT', `/projects/${employee.id}`, { record: {} }), 404, 'CREDENTIAL_RECORD_NOT_FOUND');
  });

  it('记录：拒绝未声明字段、枚举外的值、其他类型的图片栏目和超长文本', async () => {
    await expectError(await lib(a, 'POST', '/certificates', { record: { certificateId: 'x' } }), 400, 'BAD_REQUEST');
    await expectError(await lib(a, 'POST', '/certificates', { record: { validityMode: 'forever' } }), 400, 'BAD_REQUEST');
    await expectError(await lib(a, 'POST', '/projects', { record: { projectType: 'other' } }), 400, 'BAD_REQUEST');
    await expectError(
      await lib(a, 'POST', '/employees', { record: {}, newImages: [{ fieldKey: 'certificateImages', fileId: await newFile(a) }] }),
      400,
      'BAD_REQUEST',
    );
    await expectError(await lib(a, 'POST', '/other-materials', { record: { note: 'x'.repeat(CREDENTIAL_LONG_TEXT_MAX + 1) } }), 400, 'BAD_REQUEST');
    await expectError(await lib(a, 'POST', '/other-materials', { record: { name: '\u0000' } }), 400, 'CREDENTIAL_INVALID');
    await expectError(await lib(a, 'POST', '/certificates', { record: {}, removedImageIds: [] }), 400, 'BAD_REQUEST');
    await expectError(await lib(a, 'PUT', '/certificates/not-a-uuid', { record: {} }), 400, 'BAD_REQUEST');
  });

  it('图片不可用时整个保存回滚，记录不会只写一半', async () => {
    const response = await lib(a, 'POST', '/other-materials', {
      record: { name: '回滚' },
      newImages: [{ fieldKey: 'otherMaterialImages', fileId: await newFile(b) }],
    });
    await expectError(response, 400, 'CREDENTIAL_IMAGE_UNAVAILABLE');
    expect(await superuser.selectFrom('credential_library_other_materials').select('id').where('name', '=', '回滚').execute()).toEqual([]);
  });

  it('其他组织的记录、图片与不存在的一样返回 404，也不能挂其他组织记录下的图片', async () => {
    const created = await ok(a, 'POST', '/other-materials', { record: { name: '组织 A 的资料' } }, 201);
    const fileId = await newFile(a);
    const withImage = await ok(a, 'PUT', `/other-materials/${created.id}`, {
      record: { name: '组织 A 的资料' },
      newImages: [{ fieldKey: 'otherMaterialImages', fileId }],
    });
    const image = withImage.snapshot.images.find((item: { fileId: string }) => item.fileId === fileId);

    await expectError(await lib(b, 'PUT', `/other-materials/${created.id}`, { record: { name: '篡改' } }), 404, 'CREDENTIAL_RECORD_NOT_FOUND');
    await expectError(await lib(b, 'DELETE', `/other-materials/${created.id}`), 404, 'CREDENTIAL_RECORD_NOT_FOUND');
    await expectError(await lib(b, 'DELETE', `/images/${image.id}`), 404, 'CREDENTIAL_IMAGE_NOT_FOUND');
    const own = await ok(b, 'POST', '/other-materials', { record: { name: '组织 B 的资料' } }, 201);
    // 其他组织的图片 id 放进 removedImageIds、imageNameUpdates 中不起作用。
    await ok(b, 'PUT', `/other-materials/${own.id}`, {
      record: { name: '组织 B 的资料' },
      removedImageIds: [image.id],
      imageNameUpdates: [{ imageId: image.id, customName: '篡改' }],
    });
    expect((await ok(b, 'GET', '')).otherMaterials.map((item: { name: string }) => item.name)).toEqual(['组织 B 的资料']);

    const after = await ok(a, 'GET', '');
    expect(after.otherMaterials.find((item: { id: string }) => item.id === created.id)).toMatchObject({ name: '组织 A 的资料' });
    expect(after.images.find((item: { id: string }) => item.id === image.id)).toMatchObject({ customName: '' });
    expect((await fileState(fileId))?.deleted_at).toBeNull();
  });

  it('同组织其他记录的图片 id 不会被当前记录删除或改名', async () => {
    const first = await ok(a, 'POST', '/employees', { record: { name: '甲' }, newImages: [{ fieldKey: 'laborContract', fileId: await newFile(a) }] }, 201);
    const image = first.snapshot.images.find((item: { ownerId: string }) => item.ownerId === first.id);
    const second = await ok(a, 'POST', '/employees', { record: { name: '乙' } }, 201);
    await ok(a, 'PUT', `/employees/${second.id}`, {
      record: { name: '乙' },
      removedImageIds: [image.id],
      imageNameUpdates: [{ imageId: image.id, customName: '改名' }],
    });
    const snapshot = await ok(a, 'GET', '');
    expect(snapshot.images.find((item: { id: string }) => item.id === image.id)).toMatchObject({ ownerId: first.id, customName: '' });
  });

  it('响应带 cache-control: no-store', async () => {
    const response = await lib(a, 'GET', '');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
