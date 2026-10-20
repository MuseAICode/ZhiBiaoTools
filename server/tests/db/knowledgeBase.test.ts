// 知识库（一）（迁移 0012_knowledge_base）的数据库与接口测试：三张表的隔离模板（describeProjectTable，组织级），
// 权限与删除可见性由 RLS 强制（绕过 Store 直接写库同样被拒绝），文档随原件的生命周期，文件夹与文档数上限，
// 给解析任务用的写函数，以及 /api/knowledge-base。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import {
  KNOWLEDGE_DOCUMENTS_PER_ORG_MAX,
  KNOWLEDGE_ERROR_MAX,
  KNOWLEDGE_FOLDER_NAME_MAX_LENGTH,
  KNOWLEDGE_FOLDERS_PER_ORG_MAX,
  KNOWLEDGE_MESSAGE_MAX,
} from '../../src/db/migrations/0012_knowledge_base.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import {
  clearDocumentProcessingFromStep,
  listDocumentSteps,
  saveDocumentStep,
  setDocumentMarkdown,
  updateDocumentState,
} from '../../src/knowledgeBase/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable, withTenantAny, type ProjectRowScope } from './projectTable.ts';

const PASSWORD = 'quiet-harbor-maple-58';
const MARKDOWN = 'text/markdown; charset=utf-8';

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
  name?: string;
}

/** 用超级用户直接登记一个文件（默认已上传的知识库文档）。 */
async function newFile(member: Pick<Member, 'orgId' | 'userId'>, options: FileOptions = {}): Promise<string> {
  const uploaded = (options.status ?? 'uploaded') === 'uploaded';
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      project_id: options.projectId ?? null,
      purpose: options.purpose ?? 'knowledge',
      display_name: options.name ?? '投标技术方案.docx',
      extension: 'docx',
      status: uploaded ? 'uploaded' : 'uploading',
      mime: uploaded ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null,
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

/** 用超级用户直接登记一个已写完的产物（默认是 sourceFileId 的 Markdown）。 */
async function newArtifact(
  member: Pick<Member, 'orgId' | 'userId'>,
  sourceFileId: string,
  options: { kind?: 'markdown' | 'image'; status?: 'writing' | 'ready' } = {},
): Promise<string> {
  const image = options.kind === 'image';
  const ready = (options.status ?? 'ready') === 'ready';
  const row = await superuser
    .insertInto('artifacts')
    .values({
      org_id: member.orgId,
      source_file_id: sourceFileId,
      kind: image ? 'image' : 'markdown',
      name: image ? 'a.png' : 'content.md',
      mime: image ? 'image/png' : MARKDOWN,
      status: ready ? 'ready' : 'writing',
      size_bytes: ready ? 10 : null,
      sha256: ready ? Buffer.alloc(32) : null,
      completed_at: ready ? new Date() : null,
      created_by: member.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** 在当前上下文中经应用角色建一个文件夹（隔离模板用：组织不对时在这一步就被 RLS 拒绝）。 */
async function folderInContext(trx: Transaction<any>, scope: ProjectRowScope): Promise<string> {
  const row = await trx
    .insertInto('knowledge_folders')
    .values({ org_id: scope.orgId, name: '文件夹', created_by: scope.userId, updated_by: scope.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** 在当前上下文中经应用角色上传一个知识库文件并挂到新文件夹中。 */
async function documentInContext(trx: Transaction<any>, scope: ProjectRowScope): Promise<string> {
  const folderId = await folderInContext(trx, scope);
  const file = await trx
    .insertInto('files')
    .values({ org_id: scope.orgId, purpose: 'knowledge', display_name: 'a.docx', extension: 'docx', created_by: scope.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.updateTable('files').set({ status: 'uploaded', mime: 'application/zip', size_bytes: 10, sha256: Buffer.alloc(32) }).where('id', '=', file.id).execute();
  const row = await trx
    .insertInto('knowledge_documents')
    .values({ org_id: scope.orgId, folder_id: folderId, file_id: file.id, created_by: scope.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function call(member: Member | null, method: Method, url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

const kb = (member: Member | null, method: Method, url: string, payload?: object) => call(member, method, `/api/knowledge-base${url}`, payload);

async function ok(member: Member, method: Method, url: string, payload?: object, status = 200) {
  const response = await kb(member, method, url, payload);
  expect(response.statusCode, response.body).toBe(status);
  return response.json();
}

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

async function fileState(fileId: string) {
  return superuser.selectFrom('files').select(['deleted_at', 'deleted_by']).where('id', '=', fileId).executeTakeFirstOrThrow();
}

/** 用超级用户直接建文件夹和挂文档（不经 RLS），返回 { folderId, documentId, fileId }。 */
async function seedDocument(member: Pick<Member, 'orgId' | 'userId'>, folderId?: string) {
  const folder =
    folderId ??
    (
      await superuser
        .insertInto('knowledge_folders')
        .values({ org_id: member.orgId, name: '文件夹', created_by: member.userId, updated_by: member.userId })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const fileId = await newFile(member);
  const document = await superuser
    .insertInto('knowledge_documents')
    .values({ org_id: member.orgId, folder_id: folder, file_id: fileId, created_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { folderId: folder as string, documentId: document.id as string, fileId };
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
      table: 'knowledge_folders',
      idColumn: 'id',
      scope: 'org',
      insert: folderInContext,
      update: { name: '改名' },
    },
    env,
  );

  describeProjectTable(
    {
      table: 'knowledge_documents',
      idColumn: 'id',
      scope: 'org',
      insert: documentInContext,
      update: { progress: 50 },
    },
    env,
  );

  describeProjectTable(
    {
      table: 'knowledge_document_steps',
      idColumn: 'document_id',
      scope: 'org',
      async insert(trx, scope) {
        const documentId = await documentInContext(trx, scope);
        await trx.insertInto('knowledge_document_steps').values({ org_id: scope.orgId, document_id: documentId, step_key: 'copy_source' }).execute();
        return documentId;
      },
      update: { status: 'idle' },
    },
    env,
  );
});

describe('权限与删除可见性由 RLS 强制', () => {
  let a: Member;
  let peer: Member;
  let b: Member;
  let folderA: string;
  let folderB: string;

  const insertDocument = (member: Pick<Member, 'context'>, values: Record<string, unknown>) =>
    withTenantAny(appDb, member.context, (trx) =>
      trx
        .insertInto('knowledge_documents')
        .values({ org_id: member.context.orgId, folder_id: folderA, created_by: member.context.userId, ...values })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );

  const visibleDocuments = (member: Pick<Member, 'context'>) =>
    withTenant(appDb, member.context, (trx) => trx.selectFrom('knowledge_documents').select('id').execute());

  const visibleSteps = (member: Pick<Member, 'context'>) =>
    withTenant(appDb, member.context, (trx) => trx.selectFrom('knowledge_document_steps').select(['document_id', 'step_key']).execute());

  beforeAll(async () => {
    a = await newMember();
    peer = await newMember(a.orgId);
    b = await newMember();
    folderA = (await seedDocument(a)).folderId;
    folderB = (await seedDocument(b)).folderId;
  });

  it('组织内其他成员可以读写同一个知识库（组织内共享）', async () => {
    const { documentId } = await seedDocument(a, folderA);
    await withTenant(appDb, peer.context, async (trx) => {
      const updated = await trx.updateTable('knowledge_folders').set({ name: '成员改名', updated_by: peer.userId }).where('id', '=', folderA).executeTakeFirst();
      expect(updated.numUpdatedRows).toBe(1n);
      const moved = await trx.updateTable('knowledge_documents').set({ sort_order: 9 }).where('id', '=', documentId).executeTakeFirst();
      expect(moved.numUpdatedRows).toBe(1n);
    });
  });

  it('文件夹：created_by / updated_by 必须是当前用户', async () => {
    await expect(
      withTenantAny(appDb, a.context, (trx) =>
        trx.insertInto('knowledge_folders').values({ org_id: a.orgId, name: '代写', created_by: peer.userId, updated_by: a.userId }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenantAny(appDb, a.context, (trx) =>
        trx.updateTable('knowledge_folders').set({ name: '代写', updated_by: peer.userId }).where('id', '=', folderA).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenantAny(appDb, a.context, (trx) => trx.updateTable('knowledge_folders').set({ created_by: peer.userId }).where('id', '=', folderA).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it.each<[string, (member: Member) => Promise<string>]>([
    ['其他组织的文件', async () => newFile(b)],
    ['上传中的文件', async (member) => newFile(member, { status: 'uploading' })],
    ['已删除的文件', async (member) => newFile(member, { deleted: true })],
    ['其他用途的文件', async (member) => newFile(member, { purpose: 'tender' })],
    [
      '挂在项目下的文件',
      async (member) => {
        const project = await superuser
          .insertInto('projects')
          .values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        return newFile(member, { projectId: project.id });
      },
    ],
  ])('文档不能挂%s', async (_title, makeFile) => {
    const fileId = await makeFile(a);
    await expect(insertDocument(a, { file_id: fileId })).rejects.toThrow(/row-level security|foreign key/);
  });

  it('同一个文件只能挂一次；文件夹必须是本组织的；新文档一律是 pending、created_by 必须是当前用户', async () => {
    const fileId = await newFile(a);
    await insertDocument(a, { file_id: fileId });
    await expect(insertDocument(a, { file_id: fileId })).rejects.toThrow(/knowledge_documents_file_id_key/);
    await expect(insertDocument(a, { file_id: await newFile(a), folder_id: folderB })).rejects.toThrow(/foreign key/);
    await expect(insertDocument(a, { file_id: await newFile(a), status: 'success' })).rejects.toThrow(/permission denied/);
    await expect(insertDocument(a, { file_id: await newFile(a), created_by: peer.userId })).rejects.toThrow(/row-level security/);
  });

  it('文档的原件、组织和创建者写入后不能改，文件夹不能改到其他组织', async () => {
    const { documentId } = await seedDocument(a, folderA);
    const other = await newFile(a);
    for (const values of [{ file_id: other }, { org_id: b.orgId }, { created_by: peer.userId }]) {
      await expect(
        withTenantAny(appDb, a.context, (trx) => trx.updateTable('knowledge_documents').set(values).where('id', '=', documentId).execute()),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      withTenantAny(appDb, a.context, (trx) => trx.updateTable('knowledge_documents').set({ folder_id: folderB }).where('id', '=', documentId).execute()),
    ).rejects.toThrow(/foreign key/);
  });

  it('应用角色不能删除文档行（删除文档即软删除原件）', async () => {
    const { documentId } = await seedDocument(a, folderA);
    await expect(
      withTenantAny(appDb, a.context, (trx) => trx.deleteFrom('knowledge_documents').where('id', '=', documentId).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('原件删除后文档和步骤查不到、改不了，也不能新写步骤；恢复文件即一起恢复', async () => {
    const member = await newMember();
    const { documentId, fileId } = await seedDocument(member);
    await superuser.insertInto('knowledge_document_steps').values({ org_id: member.orgId, document_id: documentId, step_key: 'copy_source' }).execute();
    expect(await visibleDocuments(member)).toEqual([{ id: documentId }]);
    expect(await visibleSteps(member)).toHaveLength(1);

    await superuser.updateTable('files').set({ deleted_at: new Date(), deleted_by: member.userId }).where('id', '=', fileId).execute();
    expect(await visibleDocuments(member)).toEqual([]);
    expect(await visibleSteps(member)).toEqual([]);
    await withTenant(appDb, member.context, async (trx) => {
      expect((await trx.updateTable('knowledge_documents').set({ progress: 10 }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await trx.updateTable('knowledge_document_steps').set({ status: 'idle' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await trx.deleteFrom('knowledge_document_steps').executeTakeFirst()).numDeletedRows).toBe(0n);
    });
    await expect(
      withTenantAny(appDb, member.context, (trx) =>
        trx.insertInto('knowledge_document_steps').values({ org_id: member.orgId, document_id: documentId, step_key: 'build_blocks' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);

    await superuser.updateTable('files').set({ deleted_at: null, deleted_by: null }).where('id', '=', fileId).execute();
    expect(await visibleDocuments(member)).toEqual([{ id: documentId }]);
    expect(await visibleSteps(member)).toHaveLength(1);
  });

  it('Markdown 产物只能是本文档原件已写完的 markdown 产物', async () => {
    const { documentId, fileId } = await seedDocument(a, folderA);
    const setMarkdown = (artifactId: string | null) =>
      withTenantAny(appDb, a.context, (trx) =>
        trx.updateTable('knowledge_documents').set({ markdown_artifact_id: artifactId }).where('id', '=', documentId).executeTakeFirst(),
      );
    await expect(setMarkdown(await newArtifact(a, await newFile(a)))).rejects.toThrow(/row-level security/);
    await expect(setMarkdown(await newArtifact(a, fileId, { kind: 'image' }))).rejects.toThrow(/row-level security/);
    await expect(setMarkdown(await newArtifact(a, fileId, { status: 'writing' }))).rejects.toThrow(/row-level security/);
    await expect(setMarkdown(await newArtifact(b, await newFile(b)))).rejects.toThrow(/row-level security|foreign key/);
    const artifactId = await newArtifact(a, fileId);
    expect((await setMarkdown(artifactId)).numUpdatedRows).toBe(1n);
    expect((await setMarkdown(null)).numUpdatedRows).toBe(1n);
  });

  it('清理任务删除产物时只清空引用；物理删除原件时文档和步骤随之删除', async () => {
    const member = await newMember();
    const { documentId, fileId } = await seedDocument(member);
    const artifactId = await newArtifact(member, fileId);
    await superuser.updateTable('knowledge_documents').set({ markdown_artifact_id: artifactId }).where('id', '=', documentId).execute();
    await superuser.insertInto('knowledge_document_steps').values({ org_id: member.orgId, document_id: documentId, step_key: 'copy_source' }).execute();

    await superuser.deleteFrom('artifacts').where('id', '=', artifactId).execute();
    expect(
      await superuser.selectFrom('knowledge_documents').select(['org_id', 'markdown_artifact_id']).where('id', '=', documentId).executeTakeFirst(),
    ).toEqual({ org_id: member.orgId, markdown_artifact_id: null });

    await superuser.deleteFrom('files').where('id', '=', fileId).execute();
    expect(await superuser.selectFrom('knowledge_documents').select('id').where('id', '=', documentId).execute()).toEqual([]);
    expect(await superuser.selectFrom('knowledge_document_steps').select('step_key').where('document_id', '=', documentId).execute()).toEqual([]);
  });

  it('步骤的状态与时间、错误的组合由 CHECK 约束绑定，结果只能是对象', async () => {
    const { documentId } = await seedDocument(a, folderA);
    const insertStep = (values: Record<string, unknown>) =>
      withTenantAny(appDb, a.context, (trx) =>
        trx.insertInto('knowledge_document_steps').values({ org_id: a.orgId, document_id: documentId, step_key: 'copy_source', ...values }).execute(),
      );
    const now = new Date();
    await expect(insertStep({ status: 'running' })).rejects.toThrow(/knowledge_document_steps_status_shape/);
    await expect(insertStep({ status: 'success', started_at: now })).rejects.toThrow(/knowledge_document_steps_status_shape/);
    await expect(insertStep({ status: 'error', started_at: now, completed_at: now })).rejects.toThrow(/knowledge_document_steps_status_shape/);
    await expect(insertStep({ status: 'idle', error: 'x' })).rejects.toThrow(/knowledge_document_steps_status_shape/);
    await expect(insertStep({ result: '[1]' })).rejects.toThrow(/knowledge_document_steps_result_check/);
    await expect(insertStep({ step_key: 'unknown' })).rejects.toThrow(/knowledge_document_steps_step_key_check/);
    await insertStep({ status: 'error', started_at: now, completed_at: now, error: '失败', result: '{"a":1}' });
  });

  it('删除文件夹时其中的文档和步骤随之删除', async () => {
    const member = await newMember();
    const { folderId, documentId } = await seedDocument(member);
    await superuser.insertInto('knowledge_document_steps').values({ org_id: member.orgId, document_id: documentId, step_key: 'copy_source' }).execute();
    await withTenant(appDb, member.context, (trx) => trx.deleteFrom('knowledge_folders').where('id', '=', folderId).execute());
    expect(await superuser.selectFrom('knowledge_documents').select('id').where('org_id', '=', member.orgId).execute()).toEqual([]);
    expect(await superuser.selectFrom('knowledge_document_steps').select('step_key').where('org_id', '=', member.orgId).execute()).toEqual([]);
  });

  it(`每个组织最多 ${KNOWLEDGE_FOLDERS_PER_ORG_MAX} 个文件夹、${KNOWLEDGE_DOCUMENTS_PER_ORG_MAX} 个文档（KB001）`, async () => {
    const member = await newMember();
    const { folderId } = await seedDocument(member);
    // 批量准备数据时停用用户触发器（上限检查），只验证应用角色的插入。
    await sql`ALTER TABLE knowledge_folders DISABLE TRIGGER USER`.execute(superuser);
    await sql`ALTER TABLE knowledge_documents DISABLE TRIGGER USER`.execute(superuser);
    try {
      await sql`INSERT INTO knowledge_folders (org_id, name, created_by, updated_by)
        SELECT ${member.orgId}, 'f' || g, ${member.userId}, ${member.userId} FROM generate_series(2, ${KNOWLEDGE_FOLDERS_PER_ORG_MAX}) g`.execute(superuser);
      await sql`WITH f AS (
          INSERT INTO files (org_id, purpose, display_name, extension, status, mime, size_bytes, sha256, uploaded_at, created_by)
          SELECT ${member.orgId}, 'knowledge', 'a.md', 'md', 'uploaded', 'text/markdown', 1, decode(repeat('00', 32), 'hex'), now(), ${member.userId}
          FROM generate_series(2, ${KNOWLEDGE_DOCUMENTS_PER_ORG_MAX}) g RETURNING id)
        INSERT INTO knowledge_documents (org_id, folder_id, file_id, created_by) SELECT ${member.orgId}, ${folderId}, id, ${member.userId} FROM f`.execute(superuser);
    } finally {
      await sql`ALTER TABLE knowledge_folders ENABLE TRIGGER USER`.execute(superuser);
      await sql`ALTER TABLE knowledge_documents ENABLE TRIGGER USER`.execute(superuser);
    }
    const extraFile = await newFile(member);
    await expect(
      withTenantAny(appDb, member.context, (trx) =>
        trx.insertInto('knowledge_folders').values({ org_id: member.orgId, name: '超出', created_by: member.userId, updated_by: member.userId }).execute(),
      ),
    ).rejects.toMatchObject({ code: 'KB001' });
    await expect(
      withTenantAny(appDb, member.context, (trx) =>
        trx.insertInto('knowledge_documents').values({ org_id: member.orgId, folder_id: folderId, file_id: extraFile, created_by: member.userId }).execute(),
      ),
    ).rejects.toMatchObject({ code: 'KB001' });
    const response = await kb(member, 'POST', '/folders', { name: '超出' });
    await expectError(response, 409, 'KNOWLEDGE_LIMIT_REACHED');
    // 删除一个文档（原件进回收站）后不再计数，可以再挂一个。
    const someFile = await superuser.selectFrom('knowledge_documents').select('file_id').where('org_id', '=', member.orgId).executeTakeFirstOrThrow();
    await superuser.updateTable('files').set({ deleted_at: new Date(), deleted_by: member.userId }).where('id', '=', someFile.file_id).execute();
    await withTenantAny(appDb, member.context, (trx) =>
      trx.insertInto('knowledge_documents').values({ org_id: member.orgId, folder_id: folderId, file_id: extraFile, created_by: member.userId }).execute(),
    );
  });
});

describe('给解析任务用的写函数', () => {
  let member: Member;

  beforeAll(async () => {
    member = await newMember();
  });

  it('updateDocumentState：只写给出的字段，进度限制在 0~100，文本去掉 \\u0000 并截短', async () => {
    const { documentId } = await seedDocument(member);
    const document = await updateDocumentState(appDb, member.context, documentId, {
      status: 'converting',
      progress: 140.6,
      message: `解析\u0000中${'。'.repeat(KNOWLEDGE_MESSAGE_MAX)}`,
      blockCount: 3,
      lastBatchSize: 20,
    });
    expect(document).toMatchObject({ status: 'converting', progress: 100, blockCount: 3, lastBatchSize: 20, itemCount: 0, error: null });
    expect(document.message.startsWith('解析中')).toBe(true);
    expect([...document.message]).toHaveLength(KNOWLEDGE_MESSAGE_MAX);
    const errored = await updateDocumentState(appDb, member.context, documentId, { status: 'error', error: 'x'.repeat(KNOWLEDGE_ERROR_MAX + 5), progress: -3 });
    expect(errored).toMatchObject({ status: 'error', progress: 0, message: document.message, blockCount: 3 });
    expect(errored.error).toHaveLength(KNOWLEDGE_ERROR_MAX);
  });

  it('setDocumentMarkdown：只接受本文档原件的 Markdown 产物，否则抛 TypeError', async () => {
    const { documentId, fileId } = await seedDocument(member);
    const artifactId = await newArtifact(member, fileId);
    expect(await setDocumentMarkdown(appDb, member.context, documentId, artifactId, 'MinerU')).toMatchObject({
      markdownArtifactId: artifactId,
      parserLabel: 'MinerU',
    });
    await expect(setDocumentMarkdown(appDb, member.context, documentId, await newArtifact(member, await newFile(member)))).rejects.toBeInstanceOf(TypeError);
    await expect(setDocumentMarkdown(appDb, member.context, documentId, randomUUID())).rejects.toBeInstanceOf(TypeError);
  });

  it('saveDocumentStep：时间与错误的规则与桌面版相同，没有给出 result 时保留原结果', async () => {
    const { documentId } = await seedDocument(member);
    const running = await saveDocumentStep(appDb, member.context, documentId, 'convert_markdown', { status: 'running', result: { markdown_chars: 1 } });
    expect(running).toMatchObject({ status: 'running', error: null, completedAt: null, result: { markdown_chars: 1 } });
    expect(running.startedAt).toBeInstanceOf(Date);

    const failed = await saveDocumentStep(appDb, member.context, documentId, 'convert_markdown', { status: 'error' });
    expect(failed).toMatchObject({ status: 'error', error: '处理失败', startedAt: running.startedAt, result: { markdown_chars: 1 } });
    expect(failed.completedAt).toBeInstanceOf(Date);

    const success = await saveDocumentStep(appDb, member.context, documentId, 'convert_markdown', { status: 'success', result: { markdown_chars: 9 } });
    expect(success).toMatchObject({ status: 'success', error: null, result: { markdown_chars: 9 } });
    const idle = await saveDocumentStep(appDb, member.context, documentId, 'build_blocks', { status: 'idle' });
    expect(idle).toMatchObject({ status: 'idle', startedAt: null, completedAt: null, error: null, result: null });

    expect((await listDocumentSteps(appDb, member.context, documentId)).map((step) => step.stepKey)).toEqual(['convert_markdown', 'build_blocks']);
    await expect(saveDocumentStep(appDb, member.context, documentId, 'nope' as never, { status: 'idle' })).rejects.toBeInstanceOf(TypeError);
  });

  it('clearDocumentProcessingFromStep：删除该步及之后的步骤，清除相应的引用与计数', async () => {
    const { documentId, fileId } = await seedDocument(member);
    for (const stepKey of ['copy_source', 'convert_markdown', 'build_blocks', 'merge_candidates'] as const) {
      await saveDocumentStep(appDb, member.context, documentId, stepKey, { status: 'success' });
    }
    await setDocumentMarkdown(appDb, member.context, documentId, await newArtifact(member, fileId), 'doc2markdown');
    await updateDocumentState(appDb, member.context, documentId, { blockCount: 5, filteredBlockCount: 1, candidateItemCount: 4, itemCount: 2, error: 'x', lastBatchSize: 3 });

    const fromMerge = await clearDocumentProcessingFromStep(appDb, member.context, documentId, 'merge_candidates');
    expect(fromMerge).toMatchObject({ blockCount: 5, candidateItemCount: 0, itemCount: 0, error: null, lastBatchSize: null, parserLabel: 'doc2markdown' });
    expect((await listDocumentSteps(appDb, member.context, documentId)).map((step) => step.stepKey)).toEqual(['copy_source', 'convert_markdown', 'build_blocks']);

    const fromConvert = await clearDocumentProcessingFromStep(appDb, member.context, documentId, 'convert_markdown');
    expect(fromConvert).toMatchObject({ markdownArtifactId: null, parserLabel: null, blockCount: 0, filteredBlockCount: 0 });
    expect((await listDocumentSteps(appDb, member.context, documentId)).map((step) => step.stepKey)).toEqual(['copy_source']);
  });

  it('文档不可见（其他组织、原件已删除）时一律 404', async () => {
    const { documentId, fileId } = await seedDocument(member);
    const other = await newMember();
    await expect(updateDocumentState(appDb, other.context, documentId, { progress: 1 })).rejects.toMatchObject({ code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND' });
    await expect(saveDocumentStep(appDb, other.context, documentId, 'copy_source', { status: 'running' })).rejects.toMatchObject({
      code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND',
    });
    await superuser.updateTable('files').set({ deleted_at: new Date(), deleted_by: member.userId }).where('id', '=', fileId).execute();
    await expect(updateDocumentState(appDb, member.context, documentId, { progress: 1 })).rejects.toMatchObject({ code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND' });
    await expect(listDocumentSteps(appDb, member.context, documentId)).rejects.toMatchObject({ code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND' });
    await expect(clearDocumentProcessingFromStep(appDb, member.context, documentId, 'copy_source')).rejects.toMatchObject({
      code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND',
    });
  });
});

describe('/api/knowledge-base', () => {
  let a: Member;
  let peer: Member;
  let b: Member;

  beforeAll(async () => {
    a = await newMember();
    peer = await newMember(a.orgId);
    b = await newMember();
  });

  it('需要登录；响应不缓存', async () => {
    await expectError(await kb(null, 'GET', ''), 401, 'UNAUTHORIZED');
    const response = await kb(a, 'GET', '');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ folders: [], documents: [] });
  });

  it('文件夹：新建排在最后，名称归一化，空名称用“未命名”，超长拒绝；重命名；其他组织 404', async () => {
    const first = await ok(a, 'POST', '/folders', { name: '  资质​材料 ' }, 201);
    expect(first).toMatchObject({ name: '资质材料', sortOrder: 0 });
    const second = await ok(peer, 'POST', '/folders', { name: ' \u0007 ' }, 201);
    expect(second).toMatchObject({ name: '未命名', sortOrder: 1 });
    await expectError(await kb(a, 'POST', '/folders', { name: '名'.repeat(KNOWLEDGE_FOLDER_NAME_MAX_LENGTH + 1) }), 400, 'KNOWLEDGE_INVALID');
    await expectError(await kb(a, 'POST', '/folders', { name: '名', extra: 1 }), 400, 'BAD_REQUEST');

    expect(await ok(a, 'PATCH', `/folders/${second.id}`, { name: '业绩' })).toMatchObject({ id: second.id, name: '业绩' });
    await expectError(await kb(b, 'PATCH', `/folders/${second.id}`, { name: '越权' }), 404, 'KNOWLEDGE_FOLDER_NOT_FOUND');
    await expectError(await kb(b, 'DELETE', `/folders/${second.id}`), 404, 'KNOWLEDGE_FOLDER_NOT_FOUND');
    expect((await ok(b, 'GET', '')).folders).toEqual([]);
  });

  it('文件夹拖动排序（之前 / 之后），其他组织的文件夹 404', async () => {
    const member = await newMember();
    const ids: string[] = [];
    for (const name of ['一', '二', '三']) ids.push((await ok(member, 'POST', '/folders', { name }, 201)).id);
    const names = (folders: { name: string }[]) => folders.map((folder) => folder.name);
    expect(names((await ok(member, 'POST', `/folders/${ids[2]}/reorder`, { targetFolderId: ids[0], position: 'before' })).folders)).toEqual(['三', '一', '二']);
    expect(names((await ok(member, 'POST', `/folders/${ids[2]}/reorder`, { targetFolderId: ids[1], position: 'after' })).folders)).toEqual(['一', '二', '三']);
    const listed = await ok(member, 'GET', '');
    expect(listed.folders.map((folder: { sortOrder: number }) => folder.sortOrder)).toEqual([0, 1, 2]);
    const foreign = (await ok(b, 'POST', '/folders', { name: '别人' }, 201)).id;
    await expectError(await kb(member, 'POST', `/folders/${ids[0]}/reorder`, { targetFolderId: foreign, position: 'after' }), 404, 'KNOWLEDGE_FOLDER_NOT_FOUND');
  });

  it('挂文档：按给出的顺序排在末尾，状态 pending；文件不可用 400，文件夹不存在 404', async () => {
    const member = await newMember();
    const folder = (await ok(member, 'POST', '/folders', { name: '文档' }, 201)).id;
    const files = [await newFile(member, { name: '一.docx' }), await newFile(member, { name: '二.pdf' })];
    const created = await ok(member, 'POST', `/folders/${folder}/documents`, { fileIds: files }, 201);
    expect(created.documents).toMatchObject([
      { folderId: folder, fileId: files[0], fileName: '一.docx', status: 'pending', progress: 0, message: '等待处理', sortOrder: 0, markdownArtifactId: null },
      { fileId: files[1], fileName: '二.pdf', sortOrder: 1 },
    ]);
    const third = await newFile(member, { name: '三.md' });
    expect((await ok(member, 'POST', `/folders/${folder}/documents`, { fileIds: [third.toUpperCase()] }, 201)).documents[0]).toMatchObject({
      fileId: third,
      sortOrder: 2,
    });

    for (const fileIds of [[files[0]], [await newFile(member, { purpose: 'tender' })], [await newFile(b)], [third, third]]) {
      await expectError(await kb(member, 'POST', `/folders/${folder}/documents`, { fileIds }), 400, 'KNOWLEDGE_FILE_UNAVAILABLE');
    }
    const foreignFolder = (await ok(b, 'POST', '/folders', { name: '别人' }, 201)).id;
    await expectError(await kb(member, 'POST', `/folders/${foreignFolder}/documents`, { fileIds: [await newFile(member)] }), 404, 'KNOWLEDGE_FOLDER_NOT_FOUND');
    expect((await ok(member, 'GET', '')).documents).toHaveLength(3);
  });

  it('移动文档：同一文件夹内调整顺序、跨文件夹移动后两边重新编号；目标文档不在目标文件夹 404', async () => {
    const member = await newMember();
    const left = (await ok(member, 'POST', '/folders', { name: '左' }, 201)).id;
    const right = (await ok(member, 'POST', '/folders', { name: '右' }, 201)).id;
    const add = async (folder: string, names: string[]) =>
      (await ok(member, 'POST', `/folders/${folder}/documents`, { fileIds: await Promise.all(names.map((name) => newFile(member, { name }))) }, 201))
        .documents as { id: string }[];
    const [l1, l2, l3] = await add(left, ['l1', 'l2', 'l3']);
    const [r1] = await add(right, ['r1']);
    const order = async () => {
      const { documents } = await ok(member, 'GET', '');
      return documents.map((document: { folderId: string; fileName: string; sortOrder: number }) => [
        document.folderId === left ? '左' : '右',
        document.fileName,
        document.sortOrder,
      ]);
    };

    await ok(member, 'POST', `/documents/${l3!.id}/move`, { targetFolderId: left, targetDocumentId: l1!.id, position: 'before' });
    expect(await order()).toEqual([
      ['左', 'l3', 0],
      ['左', 'l1', 1],
      ['左', 'l2', 2],
      ['右', 'r1', 0],
    ]);

    const moved = await ok(member, 'POST', `/documents/${l1!.id}/move`, { targetFolderId: right, targetDocumentId: r1!.id, position: 'after' });
    expect(moved.document).toMatchObject({ id: l1!.id, folderId: right, sortOrder: 1 });
    await ok(member, 'POST', `/documents/${l2!.id}/move`, { targetFolderId: right });
    expect(await order()).toEqual([
      ['左', 'l3', 0],
      ['右', 'r1', 0],
      ['右', 'l1', 1],
      ['右', 'l2', 2],
    ]);

    await expectError(await kb(member, 'POST', `/documents/${l3!.id}/move`, { targetFolderId: left, targetDocumentId: r1!.id }), 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    const foreignFolder = (await ok(b, 'POST', '/folders', { name: '别人' }, 201)).id;
    await expectError(await kb(member, 'POST', `/documents/${l3!.id}/move`, { targetFolderId: foreignFolder }), 404, 'KNOWLEDGE_FOLDER_NOT_FOUND');
    await expectError(await kb(b, 'POST', `/documents/${l3!.id}/move`, { targetFolderId: foreignFolder }), 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
  });

  it('删除文档：软删除原件，文档从列表消失；经文件回收站恢复即一起恢复；其他组织 404', async () => {
    const member = await newMember();
    const folder = (await ok(member, 'POST', '/folders', { name: '文档' }, 201)).id;
    const fileId = await newFile(member);
    const [document] = (await ok(member, 'POST', `/folders/${folder}/documents`, { fileIds: [fileId] }, 201)).documents;

    await expectError(await kb(b, 'DELETE', `/documents/${document.id}`), 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    expect((await ok(member, 'DELETE', `/documents/${document.id}`)).document).toMatchObject({ id: document.id, fileId });
    expect(await fileState(fileId)).toMatchObject({ deleted_by: member.userId });
    expect((await ok(member, 'GET', '')).documents).toEqual([]);
    await expectError(await kb(member, 'DELETE', `/documents/${document.id}`), 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');

    const restored = await call(member, 'POST', `/api/files/${fileId}/restore`);
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await ok(member, 'GET', '')).documents).toMatchObject([{ id: document.id }]);
  });

  it('删除文件夹：其中文档的原件进回收站，文件夹和文档行删除', async () => {
    const member = await newMember();
    const folder = (await ok(member, 'POST', '/folders', { name: '待删' }, 201)).id;
    const keep = (await ok(member, 'POST', '/folders', { name: '保留' }, 201)).id;
    const files = [await newFile(member), await newFile(member)];
    await ok(member, 'POST', `/folders/${folder}/documents`, { fileIds: files }, 201);
    const kept = await newFile(member);
    await ok(member, 'POST', `/folders/${keep}/documents`, { fileIds: [kept] }, 201);

    const result = await ok(member, 'DELETE', `/folders/${folder}`);
    expect(result).toMatchObject({ folder: { id: folder, name: '待删' }, deletedDocumentCount: 2 });
    for (const fileId of files) expect((await fileState(fileId)).deleted_at).not.toBeNull();
    expect((await fileState(kept)).deleted_at).toBeNull();
    const listed = await ok(member, 'GET', '');
    expect(listed.folders.map((item: { id: string }) => item.id)).toEqual([keep]);
    expect(listed.documents.map((item: { fileId: string }) => item.fileId)).toEqual([kept]);
    expect(await superuser.selectFrom('knowledge_documents').select('id').where('folder_id', '=', folder).execute()).toEqual([]);
    await expectError(await kb(member, 'DELETE', `/folders/${folder}`), 404, 'KNOWLEDGE_FOLDER_NOT_FOUND');
  });

  it('列表按文件夹顺序、文件夹内按文档顺序', async () => {
    const member = await newMember();
    const first = (await ok(member, 'POST', '/folders', { name: '一' }, 201)).id;
    const second = (await ok(member, 'POST', '/folders', { name: '二' }, 201)).id;
    await ok(member, 'POST', `/folders/${second}/documents`, { fileIds: [await newFile(member, { name: 'b1' })] }, 201);
    await ok(member, 'POST', `/folders/${first}/documents`, { fileIds: [await newFile(member, { name: 'a1' }), await newFile(member, { name: 'a2' })] }, 201);
    await ok(member, 'POST', `/folders/${second}/reorder`, { targetFolderId: first, position: 'before' });
    const { documents } = await ok(member, 'GET', '');
    expect(documents.map((document: { fileName: string }) => document.fileName)).toEqual(['b1', 'a1', 'a2']);
  });

  it('参数不合法返回 400', async () => {
    await expectError(await kb(a, 'PATCH', '/folders/not-a-uuid', { name: 'x' }), 400, 'BAD_REQUEST');
    await expectError(await kb(a, 'POST', `/folders/${randomUUID()}/documents`, { fileIds: [] }), 400, 'BAD_REQUEST');
    await expectError(await kb(a, 'POST', `/folders/${randomUUID()}/reorder`, { targetFolderId: randomUUID(), position: 'middle' }), 400, 'BAD_REQUEST');
  });
});
