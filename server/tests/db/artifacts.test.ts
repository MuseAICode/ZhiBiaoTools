// 生成产物（迁移 0008_artifacts）的数据库与接口测试：artifacts 表的 RLS 与守卫、项目级表隔离模板、
// Store 的写入与配额、只读接口，以及项目软删除与其下文件、产物的联动（同步不可访问、一起恢复、过期后不计配额）。
// 对象存储用内存实现：产物的读写只经 ObjectStore 接口，S3 兼容服务本身由 files.test.ts 覆盖。
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { beginArtifact, completeArtifact, findArtifact, writeArtifact, type NewArtifact } from '../../src/artifacts/store.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { STORAGE_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import { storageUsage } from '../../src/files/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable } from './projectTable.ts';

const PASSWORD = 'quiet-harbor-maple-58';
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);
const MARKDOWN = 'text/markdown; charset=utf-8';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

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

interface MemoryStore extends ObjectStore {
  objects: Map<string, Buffer>;
  /** 为 true 时 put 失败（模拟对象存储出错）。 */
  failPut: boolean;
}

function createMemoryStore(): MemoryStore {
  const objects = new Map<string, Buffer>();
  const store: MemoryStore = {
    objects,
    failPut: false,
    async put(key, body) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      if (store.failPut) throw new Error('object storage unavailable');
      objects.set(key, Buffer.concat(chunks));
    },
    async get(key) {
      const content = objects.get(key);
      if (!content) return null;
      return { body: Readable.from(content), size: content.length };
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return store;
}

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let store: MemoryStore;
let app: FastifyInstance;
const apps: FastifyInstance[] = [];

async function createApp(objectStore: ObjectStore | null) {
  const instance = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    { database, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} }, objectStore },
  );
  apps.push(instance);
  return instance;
}

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

function call(member: Member, method: 'GET' | 'POST' | 'DELETE', url: string, target = app) {
  return target.inject({ method, url, headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` } });
}

async function createProject(member: Member): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` },
    payload: { kind: 'technical-plan', name: '项目' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id;
}

/** 用超级用户直接写入一个已上传的文件记录（不写对象），可挂到项目下。 */
async function insertUploadedFile(member: Member, options: { projectId?: string; size?: number } = {}): Promise<string> {
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      project_id: options.projectId ?? null,
      purpose: 'tender',
      display_name: '招标文件.pdf',
      extension: 'pdf',
      status: 'uploaded',
      mime: 'application/pdf',
      size_bytes: options.size ?? 100,
      sha256: Buffer.alloc(32),
      created_by: member.userId,
      uploaded_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

function markdown(owner: Pick<NewArtifact, 'projectId' | 'sourceFileId'>, name = 'content.md'): NewArtifact {
  return { kind: 'markdown', name, mime: MARKDOWN, ...owner };
}

/** 用超级用户把删除时间推到指定天数之前（模拟恢复期已过）。守卫不允许改删除时间，所以本事务内跳过触发器。 */
async function backdateDeletion(table: 'projects' | 'files', id: string, days: number) {
  await superuser.transaction().execute(async (trx) => {
    await sql`SET LOCAL session_replication_role = replica`.execute(trx);
    await trx.updateTable(table).set({ deleted_at: sql`now() - make_interval(days => ${days})` }).where('id', '=', id).execute();
  });
}

/** 用超级用户直接写入已上传的大文件记录，把组织的用量推到指定值附近。 */
async function fillUsage(orgId: string, bytes: number) {
  for (let left = bytes; left > 0; left -= DOCUMENT_MAX_BYTES) {
    await superuser.insertInto('files').values({
      org_id: orgId, purpose: 'tender', display_name: 'filler.pdf', extension: 'pdf', status: 'uploaded', mime: 'application/pdf',
      size_bytes: Math.min(left, DOCUMENT_MAX_BYTES), sha256: Buffer.alloc(32), created_by: randomUUID(), uploaded_at: new Date(),
    }).execute();
  }
}

const ids = (body: { artifacts?: { id: string }[]; files?: { id: string }[] }) => (body.artifacts ?? body.files ?? []).map((item) => item.id);

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
  store = createMemoryStore();
  app = await createApp(store);
});

afterAll(async () => {
  for (const instance of apps) await instance.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('artifacts 表', () => {
  describeProjectTable(
    {
      table: 'artifacts',
      idColumn: 'id',
      async insert(trx, scope) {
        const row = await trx
          .insertInto('artifacts')
          .values({ org_id: scope.orgId, project_id: scope.projectId, kind: 'markdown', name: 'content.md', mime: MARKDOWN, created_by: scope.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        return row.id;
      },
      update: { status: 'ready', size_bytes: 1, sha256: Buffer.alloc(32) },
      onProjectDelete: 'restrict',
      projectIdNullable: true,
      definerRoles: [STORAGE_ROLE],
    },
    { admin: () => superuser, app: () => appDb },
  );

  it('对象键由数据库生成，任何角色都不能写入', async () => {
    const member = await newMember();
    const fileId = await insertUploadedFile(member);
    const pending = await beginArtifact(appDb, member.context, markdown({ sourceFileId: fileId }));
    expect(pending.storageKey).toBe(`org/${member.orgId}/artifacts/${pending.id}`);
    await expect(
      superuser.insertInto('artifacts').values({
        org_id: member.orgId, source_file_id: fileId, kind: 'markdown', name: 'a.md', mime: MARKDOWN, created_by: member.userId, storage_key: 'x',
      }).execute(),
    ).rejects.toThrow(/non-DEFAULT value into column "storage_key"/);
  });

  it.each<[string, Partial<NewArtifact> & { projectless?: boolean }, RegExp]>([
    ['SVG 不是允许的图片类型', { kind: 'image', mime: 'image/svg+xml', name: 'a.svg' }, /artifacts_kind_mime/],
    ['HTML 不是允许的类型', { kind: 'markdown', mime: 'text/html', name: 'a.html' }, /artifacts_kind_mime/],
    ['种类与 MIME 不符', { kind: 'markdown', mime: 'image/png', name: 'a.png' }, /artifacts_kind_mime/],
    ['名称含路径分隔符', { name: '../a.md' }, /artifacts_name_check/],
    ['名称为空', { name: '' }, /artifacts_name_check/],
    ['既不属于项目也没有来源文件', { projectless: true }, /artifacts_owner_present/],
  ])('数据库拒绝：%s', async (_name, override, error) => {
    const member = await newMember();
    const fileId = await insertUploadedFile(member);
    const { projectless, ...fields } = override;
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx.insertInto('artifacts').values({
          org_id: member.orgId, source_file_id: projectless ? null : fileId, kind: 'markdown', name: 'content.md', mime: MARKDOWN,
          created_by: member.userId, ...fields,
        } as never).execute(),
      ),
    ).rejects.toThrow(error);
  });

  it('Store 在写库前拒绝不合法的参数', async () => {
    const member = await newMember();
    const fileId = await insertUploadedFile(member);
    await expect(beginArtifact(appDb, member.context, { kind: 'image', name: 'a.svg', mime: 'image/svg+xml', sourceFileId: fileId })).rejects.toThrow(TypeError);
    await expect(beginArtifact(appDb, member.context, markdown({ sourceFileId: fileId }, 'a/b.md'))).rejects.toThrow(TypeError);
    await expect(beginArtifact(appDb, member.context, markdown({}))).rejects.toThrow(TypeError);
    expect(await superuser.selectFrom('artifacts').select('id').where('org_id', '=', member.orgId).execute()).toEqual([]);
  });

  it('来源文件不能是别的组织的文件（RLS 下看不到该文件，复合外键另外兜底）', async () => {
    const a = await newMember();
    const b = await newMember();
    const fileB = await insertUploadedFile(b);
    await expect(beginArtifact(appDb, a.context, markdown({ sourceFileId: fileB }))).rejects.toThrow(/row-level security/);
    // 绕过 RLS（超级用户）同样挂不上：复合外键 (org_id, source_file_id)。
    await expect(
      superuser.insertInto('artifacts').values({
        org_id: a.orgId, source_file_id: fileB, kind: 'markdown', name: 'a.md', mime: MARKDOWN, created_by: a.userId,
      }).execute(),
    ).rejects.toThrow(/foreign key constraint/);
  });

  it('守卫：完成后内容不能再改，应用角色不能物理删除已完成的产物，也不能改挂项目或来源文件', async () => {
    const member = await newMember();
    const fileId = await insertUploadedFile(member);
    const otherFile = await insertUploadedFile(member);
    const record = await writeArtifact(appDb, member.context, store, markdown({ sourceFileId: fileId }), Buffer.from('# 标题'));
    expect(record.completedAt).toBeInstanceOf(Date);

    await expect(
      withTenant(appDb, member.context, (trx) => trx.updateTable('artifacts').set({ size_bytes: 1 }).where('id', '=', record.id).execute()),
    ).rejects.toMatchObject({ code: 'AR003' });
    await expect(
      withTenant(appDb, member.context, (trx) => trx.updateTable('artifacts').set({ source_file_id: otherFile } as never).where('id', '=', record.id).execute()),
    ).rejects.toThrow(/permission denied/);
    const deleted = await withTenant(appDb, member.context, (trx) => trx.deleteFrom('artifacts').where('id', '=', record.id).executeTakeFirst());
    expect(deleted.numDeletedRows).toBe(0n);
    expect(await findArtifact(appDb, member.context, record.id)).toMatchObject({ id: record.id, size: 8 });
  });
});

describe('Store：写入与配额', () => {
  it('writeArtifact：写入对象，记录大小和 SHA-256，计入组织用量', async () => {
    const member = await newMember();
    const fileId = await insertUploadedFile(member, { size: 1000 });
    const content = Buffer.from('# 招标文件\n\n正文');
    const record = await writeArtifact(appDb, member.context, store, markdown({ sourceFileId: fileId }), content);
    expect(record).toMatchObject({
      kind: 'markdown',
      name: 'content.md',
      mime: MARKDOWN,
      projectId: null,
      sourceFileId: fileId,
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      createdBy: member.userId,
    });
    expect(store.objects.get(record.storageKey)?.equals(content)).toBe(true);
    expect((await storageUsage(appDb, member.context)).used).toBe(1000 + content.length);
  });

  it('写入中的产物不计入用量、不可访问；放弃后不留下记录', async () => {
    const member = await newMember();
    const fileId = await insertUploadedFile(member, { size: 10 });
    const pending = await beginArtifact(appDb, member.context, markdown({ sourceFileId: fileId }));
    expect((await storageUsage(appDb, member.context)).used).toBe(10);
    expect(await findArtifact(appDb, member.context, pending.id)).toBeNull();
    expect((await call(member, 'GET', `/api/artifacts/${pending.id}`)).statusCode).toBe(404);
  });

  it('对象存储出错：删除登记行，不留下对象', async () => {
    const member = await newMember();
    const fileId = await insertUploadedFile(member);
    store.failPut = true;
    try {
      await expect(writeArtifact(appDb, member.context, store, markdown({ sourceFileId: fileId }), Buffer.from('x'))).rejects.toThrow(/unavailable/);
    } finally {
      store.failPut = false;
    }
    expect(await superuser.selectFrom('artifacts').select('id').where('org_id', '=', member.orgId).execute()).toEqual([]);
    expect([...store.objects.keys()].filter((key) => key.startsWith(`org/${member.orgId}/`))).toEqual([]);
  });

  it('超出组织配额时拒绝（413），删除对象和登记行；刚好用满时成功', async () => {
    const member = await newMember();
    await fillUsage(member.orgId, QUOTA - 10);
    const fileId = await insertUploadedFile(member, { size: 5 });
    await expect(
      writeArtifact(appDb, member.context, store, markdown({ sourceFileId: fileId }), Buffer.alloc(6, 'a')),
    ).rejects.toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });
    expect(await superuser.selectFrom('artifacts').select('id').where('org_id', '=', member.orgId).execute()).toEqual([]);
    expect([...store.objects.keys()].filter((key) => key.startsWith(`org/${member.orgId}/`))).toEqual([]);

    await writeArtifact(appDb, member.context, store, markdown({ sourceFileId: fileId }), Buffer.alloc(5, 'a'));
    expect((await storageUsage(appDb, member.context)).used).toBe(QUOTA);
  });

  it('产物占用的配额同样挡住文件上传完成', async () => {
    const member = await newMember();
    await fillUsage(member.orgId, QUOTA - 10);
    const fileId = await insertUploadedFile(member, { size: 1 });
    await writeArtifact(appDb, member.context, store, markdown({ sourceFileId: fileId }), Buffer.alloc(9, 'a'));
    const pending = await withTenant(appDb, member.context, (trx) =>
      trx.insertInto('files').values({ org_id: member.orgId, purpose: 'tender', display_name: 'a.pdf', extension: 'pdf', created_by: member.userId })
        .returning('id').executeTakeFirstOrThrow(),
    );
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx.updateTable('files').set({ status: 'uploaded', mime: 'application/pdf', size_bytes: 1, sha256: Buffer.alloc(32) }).where('id', '=', pending.id).execute(),
      ),
    ).rejects.toMatchObject({ code: 'FS001' });
  });

  it('并发完成的产物合计不能超过配额', async () => {
    const member = await newMember();
    await fillUsage(member.orgId, QUOTA - 10);
    const fileId = await insertUploadedFile(member, { size: 1 });
    const pendings = await Promise.all([0, 1, 2].map(() => beginArtifact(appDb, member.context, markdown({ sourceFileId: fileId }))));
    const results = await Promise.allSettled(
      pendings.map((pending) => completeArtifact(appDb, member.context, pending.id, { size: 4, sha256: Buffer.alloc(32) })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect((await storageUsage(appDb, member.context)).used).toBeLessThanOrEqual(QUOTA);
  });
});

describe('只读接口', () => {
  let a: Member;
  let b: Member;
  let projectId: string;
  let fileId: string;
  let doc: Awaited<ReturnType<typeof writeArtifact>>;
  let image: Awaited<ReturnType<typeof writeArtifact>>;

  beforeAll(async () => {
    a = await newMember();
    b = await newMember();
    projectId = await createProject(a);
    fileId = await insertUploadedFile(a, { projectId });
    doc = await writeArtifact(appDb, a.context, store, markdown({ projectId, sourceFileId: fileId }), Buffer.from('# 标题\n<script>alert(1)</script>'));
    image = await writeArtifact(appDb, a.context, store, { kind: 'image', name: 'image-001.png', mime: 'image/png', projectId, sourceFileId: fileId }, PNG);
  });

  it('按项目、按来源文件列出，可按种类过滤', async () => {
    const byProject = await call(a, 'GET', `/api/artifacts?projectId=${projectId.toUpperCase()}`);
    expect(byProject.statusCode, byProject.body).toBe(200);
    expect(byProject.headers['cache-control']).toBe('no-store');
    expect(ids(byProject.json())).toEqual([doc.id, image.id]);
    expect(ids((await call(a, 'GET', `/api/artifacts?sourceFileId=${fileId}`)).json())).toEqual([doc.id, image.id]);
    expect(ids((await call(a, 'GET', `/api/artifacts?projectId=${projectId}&kind=image`)).json())).toEqual([image.id]);
  });

  it('查看元数据', async () => {
    const response = await call(a, 'GET', `/api/artifacts/${doc.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: doc.id,
      kind: 'markdown',
      name: 'content.md',
      mime: MARKDOWN,
      projectId,
      sourceFileId: fileId,
      size: doc.size,
      sha256: doc.sha256,
      createdAt: doc.createdAt.toISOString(),
      completedAt: doc.completedAt.toISOString(),
    });
    expect(response.json()).not.toHaveProperty('storageKey');
  });

  it('下载一律以附件返回，Content-Type 用登记的值，禁止嗅探和渲染', async () => {
    const response = await call(a, 'GET', `/api/artifacts/${doc.id}/content`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(MARKDOWN);
    expect(response.headers['content-disposition']).toBe(`attachment; filename="content.md"; filename*=UTF-8''content.md`);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toBe('# 标题\n<script>alert(1)</script>');
    const png = await call(a, 'GET', `/api/artifacts/${image.id}/content`);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.rawPayload.equals(PNG)).toBe(true);
  });

  it('同组织的其他成员可以访问', async () => {
    const colleague = await newMember(a.orgId);
    expect((await call(colleague, 'GET', `/api/artifacts/${doc.id}/content`)).statusCode).toBe(200);
  });

  it('跨组织：别的组织的产物与不存在的一样返回 404，列表为空', async () => {
    for (const url of [`/api/artifacts/${doc.id}`, `/api/artifacts/${doc.id}/content`]) {
      const response = await call(b, 'GET', url);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('ARTIFACT_NOT_FOUND');
      const missing = await call(b, 'GET', url.replace(doc.id, randomUUID()));
      expect(missing.json().error.code).toBe('ARTIFACT_NOT_FOUND');
    }
    expect((await call(b, 'GET', `/api/artifacts?projectId=${projectId}`)).json().artifacts).toEqual([]);
    expect((await call(b, 'GET', `/api/artifacts?sourceFileId=${fileId}`)).json().artifacts).toEqual([]);
    expect(await withTenant(appDb, b.context, (trx) => trx.selectFrom('artifacts').selectAll().where('id', '=', doc.id).execute())).toEqual([]);
  });

  it('参数不合法返回 400；未登录返回 401；没有写接口', async () => {
    expect((await call(a, 'GET', '/api/artifacts')).statusCode).toBe(400);
    expect((await call(a, 'GET', `/api/artifacts?projectId=${projectId}&sourceFileId=${fileId}`)).statusCode).toBe(400);
    expect((await call(a, 'GET', "/api/artifacts/' OR 1=1 --")).statusCode).toBe(400);
    expect((await call(a, 'GET', '/api/artifacts?projectId=../x')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/artifacts/${doc.id}/content` })).statusCode).toBe(401);
    expect((await call(a, 'POST', '/api/artifacts')).statusCode).toBe(404);
    expect((await call(a, 'DELETE', `/api/artifacts/${doc.id}`)).statusCode).toBe(404);
  });

  it('对象存储未配置时下载返回 503；对象丢失时返回 404', async () => {
    const withoutStore = await createApp(null);
    expect((await call(a, 'GET', `/api/artifacts/${doc.id}/content`, withoutStore)).statusCode).toBe(503);
    expect((await call(a, 'GET', `/api/artifacts/${doc.id}`, withoutStore)).statusCode).toBe(200);

    const lost = await writeArtifact(appDb, a.context, store, markdown({ projectId }, 'lost.md'), Buffer.from('x'));
    store.objects.delete(lost.storageKey);
    expect((await call(a, 'GET', `/api/artifacts/${lost.id}/content`)).statusCode).toBe(404);
  });
});

describe('项目软删除与文件、产物的联动', () => {
  async function setup() {
    const member = await newMember();
    const projectId = await createProject(member);
    const fileId = await insertUploadedFile(member, { projectId, size: 100 });
    // 知识库式的产物：只挂来源文件，不挂项目；来源文件在项目下，项目删除时同样不可访问。
    const fromFile = await writeArtifact(appDb, member.context, store, markdown({ sourceFileId: fileId }), Buffer.from('a'.repeat(10)));
    const inProject = await writeArtifact(appDb, member.context, store, markdown({ projectId }, 'outline.md'), Buffer.from('b'.repeat(20)));
    return { member, projectId, fileId, fromFile, inProject };
  }

  async function expectAccessible(member: Member, fileId: string, artifactIds: string[], accessible: boolean) {
    const status = accessible ? 200 : 404;
    expect((await call(member, 'GET', `/api/files/${fileId}`)).statusCode).toBe(status);
    expect(ids((await call(member, 'GET', '/api/files')).json()).includes(fileId)).toBe(accessible);
    for (const id of artifactIds) {
      expect((await call(member, 'GET', `/api/artifacts/${id}`)).statusCode).toBe(status);
      expect((await call(member, 'GET', `/api/artifacts/${id}/content`)).statusCode).toBe(status);
    }
    expect(ids((await call(member, 'GET', `/api/artifacts?sourceFileId=${fileId}`)).json()).length > 0).toBe(accessible);
  }

  it('项目删除后其下的文件和产物不可访问，也不在文件回收站中；恢复项目后一起恢复', async () => {
    const { member, projectId, fileId, fromFile, inProject } = await setup();
    await expectAccessible(member, fileId, [fromFile.id, inProject.id], true);

    expect((await call(member, 'DELETE', `/api/projects/${projectId}`)).statusCode).toBe(200);
    await expectAccessible(member, fileId, [fromFile.id, inProject.id], false);
    expect((await call(member, 'GET', `/api/artifacts?projectId=${projectId}`)).json().artifacts).toEqual([]);
    expect((await call(member, 'GET', '/api/files?deleted=true')).json().files).toEqual([]);
    // 项目已删除时不能单独删除、恢复其下的文件。
    expect((await call(member, 'DELETE', `/api/files/${fileId}`)).statusCode).toBe(404);
    expect((await call(member, 'POST', `/api/files/${fileId}/restore`)).statusCode).toBe(404);
    // 删除状态不复制到文件和产物上：数据库中的行原样不动。
    expect(await superuser.selectFrom('files').select('deleted_at').where('id', '=', fileId).executeTakeFirstOrThrow()).toEqual({ deleted_at: null });
    // 恢复期内仍占配额。
    expect((await storageUsage(appDb, member.context)).used).toBe(130);

    expect((await call(member, 'POST', `/api/projects/${projectId}/restore`)).statusCode).toBe(200);
    await expectAccessible(member, fileId, [fromFile.id, inProject.id], true);
    expect(ids((await call(member, 'GET', `/api/artifacts?projectId=${projectId}`)).json())).toEqual([inProject.id]);
  });

  it('项目删除前就单独删除的文件，恢复项目后仍在回收站中，可单独恢复', async () => {
    const { member, projectId, fileId, fromFile } = await setup();
    expect((await call(member, 'DELETE', `/api/files/${fileId}`)).statusCode).toBe(200);
    expect((await call(member, 'DELETE', `/api/projects/${projectId}`)).statusCode).toBe(200);
    expect((await call(member, 'POST', `/api/projects/${projectId}/restore`)).statusCode).toBe(200);

    expect((await call(member, 'GET', `/api/files/${fileId}`)).statusCode).toBe(404);
    expect(ids((await call(member, 'GET', '/api/files?deleted=true')).json())).toEqual([fileId]);
    expect((await call(member, 'GET', `/api/artifacts/${fromFile.id}`)).statusCode).toBe(404);
    expect((await call(member, 'POST', `/api/files/${fileId}/restore`)).statusCode).toBe(200);
    expect((await call(member, 'GET', `/api/artifacts/${fromFile.id}`)).statusCode).toBe(200);
  });

  it('来源文件单独删除时其产物不可访问，恢复文件后一起恢复；挂在项目上的其他产物不受影响', async () => {
    const { member, fileId, fromFile, inProject } = await setup();
    expect((await call(member, 'DELETE', `/api/files/${fileId}`)).statusCode).toBe(200);
    expect((await call(member, 'GET', `/api/artifacts/${fromFile.id}`)).statusCode).toBe(404);
    expect((await call(member, 'GET', `/api/artifacts/${inProject.id}`)).statusCode).toBe(200);
    expect((await call(member, 'POST', `/api/files/${fileId}/restore`)).statusCode).toBe(200);
    expect((await call(member, 'GET', `/api/artifacts/${fromFile.id}`)).statusCode).toBe(200);
  });

  it('项目超过恢复期：不能恢复，其下的文件和产物不再计入配额', async () => {
    const { member, projectId, fileId, fromFile, inProject } = await setup();
    const unrelated = await insertUploadedFile(member, { size: 7 });
    expect((await storageUsage(appDb, member.context)).used).toBe(137);
    expect((await call(member, 'DELETE', `/api/projects/${projectId}`)).statusCode).toBe(200);
    await backdateDeletion('projects', projectId, 8);

    expect((await call(member, 'POST', `/api/projects/${projectId}/restore`)).statusCode).toBe(404);
    await expectAccessible(member, fileId, [fromFile.id, inProject.id], false);
    expect((await storageUsage(appDb, member.context)).used).toBe(7);
    expect((await call(member, 'GET', `/api/files/${unrelated}`)).statusCode).toBe(200);
  });

  it('来源文件超过恢复期：其产物不再计入配额', async () => {
    const { member, fileId, inProject } = await setup();
    expect((await call(member, 'DELETE', `/api/files/${fileId}`)).statusCode).toBe(200);
    await backdateDeletion('files', fileId, 8);
    expect((await storageUsage(appDb, member.context)).used).toBe(inProject.size);
  });

  it('项目删除后解析任务不能再写入产物；删除前已登记的产物也不能完成，对象被删除', async () => {
    const member = await newMember();
    const projectId = await createProject(member);
    const pending = await beginArtifact(appDb, member.context, markdown({ projectId }));
    expect((await call(member, 'DELETE', `/api/projects/${projectId}`)).statusCode).toBe(200);

    await expect(writeArtifact(appDb, member.context, store, markdown({ projectId }), Buffer.from('x'))).rejects.toThrow(/row-level security/);
    await expect(completeArtifact(appDb, member.context, pending.id, { size: 1, sha256: Buffer.alloc(32) })).rejects.toThrow(/not pending/);
    expect([...store.objects.keys()].filter((key) => key.startsWith(`org/${member.orgId}/`))).toEqual([]);
    // 遗留的 writing 行不计入配额，由清理任务（第 6 步）删除。
    expect((await storageUsage(appDb, member.context)).used).toBe(0);
  });

  it('项目还有文件或产物时不能物理删除（先由清理任务删除对象和元数据）', async () => {
    const { projectId, fileId } = await setup();
    await expect(superuser.deleteFrom('projects').where('id', '=', projectId).execute()).rejects.toThrow(/foreign key constraint/);
    await expect(superuser.deleteFrom('files').where('id', '=', fileId).execute()).rejects.toThrow(/artifacts_source_file_fkey/);
  });
});

describe('数据库层强制：直接查询 files / artifacts 表', () => {
  async function setup() {
    const member = await newMember();
    const projectId = await createProject(member);
    const fileId = await insertUploadedFile(member, { projectId, size: 100 });
    const fromFile = await writeArtifact(appDb, member.context, store, markdown({ sourceFileId: fileId }), Buffer.from('a'.repeat(10)));
    const inProject = await writeArtifact(appDb, member.context, store, markdown({ projectId }, 'outline.md'), Buffer.from('b'.repeat(20)));
    return { member, projectId, fileId, artifactIds: [fromFile.id, inProject.id].sort() };
  }

  /** 不经 Store，直接在租户上下文中查表。 */
  async function visibleRows(member: Member, fileId: string, artifactIds: string[]) {
    return withTenant(appDb, member.context, async (trx) => ({
      files: (await trx.selectFrom('files').select('id').where('id', '=', fileId).execute()).map((row) => row.id),
      artifacts: (await trx.selectFrom('artifacts').select('id').where('id', 'in', artifactIds).orderBy('id').execute()).map((row) => row.id),
    }));
  }

  it('已删除项目下的文件和产物：直接查询查不到，更新、删除影响 0 行；恢复项目后又能查到', async () => {
    const { member, projectId, fileId, artifactIds } = await setup();
    expect(await visibleRows(member, fileId, artifactIds)).toEqual({ files: [fileId], artifacts: artifactIds });

    expect((await call(member, 'DELETE', `/api/projects/${projectId}`)).statusCode).toBe(200);
    expect(await visibleRows(member, fileId, artifactIds)).toEqual({ files: [], artifacts: [] });
    await withTenant(appDb, member.context, async (trx) => {
      // 不带任何条件的全表查询同样看不到。
      expect(await trx.selectFrom('files').select('id').execute()).toEqual([]);
      expect(await trx.selectFrom('artifacts').select('id').execute()).toEqual([]);
      const updated = await trx.updateTable('files').set({ deleted_at: new Date(), deleted_by: member.userId }).executeTakeFirst();
      expect(updated.numUpdatedRows).toBe(0n);
      const updatedArtifacts = await trx.updateTable('artifacts').set({ status: 'ready' }).executeTakeFirst();
      expect(updatedArtifacts.numUpdatedRows).toBe(0n);
    });
    // 超级用户看得到：行原样保留，删除状态没有复制到文件和产物上。
    expect(await superuser.selectFrom('files').select('deleted_at').where('id', '=', fileId).executeTakeFirstOrThrow()).toEqual({ deleted_at: null });
    expect(await superuser.selectFrom('artifacts').select('id').where('id', 'in', artifactIds).execute()).toHaveLength(2);

    expect((await call(member, 'POST', `/api/projects/${projectId}/restore`)).statusCode).toBe(200);
    expect(await visibleRows(member, fileId, artifactIds)).toEqual({ files: [fileId], artifacts: artifactIds });
  });

  it('来源文件已删除：直接查询查不到其产物，挂在项目上的产物不受影响', async () => {
    const { member, fileId, artifactIds } = await setup();
    await withTenant(appDb, member.context, (trx) =>
      trx.updateTable('files').set({ deleted_at: sql<Date>`now()`, deleted_by: member.userId }).where('id', '=', fileId).execute(),
    );
    const rows = await visibleRows(member, fileId, artifactIds);
    expect(rows.files).toEqual([fileId]);
    expect(rows.artifacts).toHaveLength(1);
    expect(await superuser.selectFrom('artifacts').select('source_file_id').where('id', '=', rows.artifacts[0]!).executeTakeFirstOrThrow())
      .toEqual({ source_file_id: null });
  });

  it('不能把文件或产物写到已删除的项目或已删除的来源文件下', async () => {
    const { member, projectId, fileId } = await setup();
    const looseFile = await insertUploadedFile(member);
    await withTenant(appDb, member.context, (trx) =>
      trx.updateTable('files').set({ deleted_at: sql<Date>`now()`, deleted_by: member.userId }).where('id', '=', looseFile).execute(),
    );
    expect((await call(member, 'DELETE', `/api/projects/${projectId}`)).statusCode).toBe(200);
    for (const write of [
      (trx: Kysely<Database>) => trx.insertInto('files').values({ org_id: member.orgId, project_id: projectId, purpose: 'tender', display_name: 'a.pdf', extension: 'pdf', created_by: member.userId }).execute(),
      (trx: Kysely<Database>) => trx.insertInto('artifacts').values({ org_id: member.orgId, project_id: projectId, kind: 'markdown', name: 'a.md', mime: MARKDOWN, created_by: member.userId }).execute(),
      (trx: Kysely<Database>) => trx.insertInto('artifacts').values({ org_id: member.orgId, source_file_id: fileId, kind: 'markdown', name: 'a.md', mime: MARKDOWN, created_by: member.userId }).execute(),
      (trx: Kysely<Database>) => trx.insertInto('artifacts').values({ org_id: member.orgId, source_file_id: looseFile, kind: 'markdown', name: 'a.md', mime: MARKDOWN, created_by: member.userId }).execute(),
    ]) {
      await expect(withTenant(appDb, member.context, write)).rejects.toThrow(/row-level security/);
    }
    // 已有的文件也不能改挂到已删除的项目下。
    const other = await insertUploadedFile(member);
    await expect(
      withTenant(appDb, member.context, (trx) => trx.updateTable('files').set({ project_id: projectId }).where('id', '=', other).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it('配额函数统计 RLS 下看不到的行（删除项目不能绕过配额），但只能统计当前上下文的组织', async () => {
    const { member, projectId } = await setup();
    expect((await call(member, 'DELETE', `/api/projects/${projectId}`)).statusCode).toBe(200);
    expect((await storageUsage(appDb, member.context)).used).toBe(130);

    const other = await newMember();
    await expect(
      withTenant(appDb, other.context, (trx) => sql`SELECT files_org_usage_bytes(${member.orgId}::uuid)`.execute(trx)),
    ).rejects.toMatchObject({ code: 'AR004' });
    await expect(sql`SELECT files_org_usage_bytes(${member.orgId}::uuid)`.execute(appDb)).rejects.toMatchObject({ code: 'AR004' });

    const owner = await sql<{ owner: string; secdef: boolean }>`
      SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS secdef FROM pg_proc WHERE proname = 'files_org_usage_bytes'`.execute(superuser);
    expect(owner.rows).toEqual([{ owner: STORAGE_ROLE, secdef: true }]);
  });
});
