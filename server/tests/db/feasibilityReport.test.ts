// 可研报告（迁移 0017_feasibility_report）的数据库与接口测试：四张表的隔离模板（describeProjectTable，项目级），
// 删除可见性与写权限由 RLS 强制（绕过 Store 直接写库同样被拒绝），项目信息、资料、目录（reason 协议）、关键参数、正文、
// 目录配置与引用的知识库文档、清空，给第 6 步任务用的 saveSourceParse，以及全部接口。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { FEASIBILITY_REPORT_TABLES } from '../../src/db/migrations/0017_feasibility_report.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { APP_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import {
  clearFeasibilityReport,
  importSources,
  loadFeasibilityReport,
  removeSource,
  saveAnalysis,
  saveChapterContent,
  saveKeyParameters,
  saveOutline,
  saveOutlineConfig,
  saveProjectInfo,
  saveSourceParse,
  updateStep,
  type FeasibilityOutlineItem,
} from '../../src/feasibilityReport/store.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import type { ProjectKind } from '../../src/projects/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable, type ProjectRowScope } from './projectTable.ts';

const PASSWORD = 'quiet-harbor-maple-59';

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
let noStorageApp: FastifyInstance;

const objects = new Map<string, Buffer>();
const memoryStore: ObjectStore = {
  async put(key, body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
  },
  async get(key) {
    const content = objects.get(key);
    return content ? { body: Readable.from([content]), size: content.length } : null;
  },
  async exists(key) {
    return objects.has(key);
  },
  async delete(key) {
    objects.delete(key);
  },
};

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

async function newProject(member: Pick<Member, 'orgId' | 'userId'>, kind: ProjectKind = 'feasibility-report'): Promise<string> {
  const row = await superuser
    .insertInto('projects')
    .values({ org_id: member.orgId, kind, name: '可研项目', created_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** 用超级用户直接登记一个已上传的文件（默认 tender 用途、不属于任何项目）。 */
async function newFile(
  member: Pick<Member, 'orgId' | 'userId'>,
  options: { name?: string; purpose?: string; projectId?: string | null; status?: 'uploaded' | 'uploading' } = {},
): Promise<string> {
  const uploaded = (options.status ?? 'uploaded') === 'uploaded';
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      purpose: options.purpose ?? 'tender',
      display_name: options.name ?? '可研资料.docx',
      extension: 'docx',
      status: uploaded ? 'uploaded' : 'uploading',
      mime: uploaded ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null,
      size_bytes: uploaded ? 100 : null,
      sha256: uploaded ? Buffer.alloc(32) : null,
      uploaded_at: uploaded ? new Date() : null,
      created_by: member.userId,
      project_id: options.projectId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newArtifact(
  member: Pick<Member, 'orgId' | 'userId'>,
  options: { kind: 'markdown' | 'image'; sourceFileId: string; status?: 'ready' | 'writing'; content?: string },
): Promise<string> {
  const ready = (options.status ?? 'ready') === 'ready';
  const content = Buffer.from(options.content ?? '# 资料');
  const row = await superuser
    .insertInto('artifacts')
    .values({
      org_id: member.orgId,
      source_file_id: options.sourceFileId,
      kind: options.kind,
      name: options.kind === 'markdown' ? 'content.md' : 'image-001.png',
      mime: options.kind === 'markdown' ? 'text/markdown; charset=utf-8' : 'image/png',
      status: ready ? 'ready' : 'writing',
      size_bytes: ready ? content.length : null,
      sha256: ready ? Buffer.alloc(32) : null,
      completed_at: ready ? new Date() : null,
      created_by: member.userId,
    })
    .returning(['id', 'storage_key'])
    .executeTakeFirstOrThrow();
  objects.set(row.storage_key, content);
  return row.id;
}

/** 用超级用户登记一个知识库文档（原件是 knowledge 用途的文件），返回 { documentId, fileId }。 */
async function newKnowledgeDocument(member: Pick<Member, 'orgId' | 'userId'>): Promise<{ documentId: string; fileId: string }> {
  const fileId = await newFile(member, { purpose: 'knowledge', name: '知识.docx' });
  const folder = await superuser
    .insertInto('knowledge_folders')
    .values({ org_id: member.orgId, name: '资料', created_by: member.userId, updated_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  const document = await superuser
    .insertInto('knowledge_documents')
    .values({ org_id: member.orgId, folder_id: folder.id, file_id: fileId, created_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { documentId: document.id, fileId };
}

const softDeleteFile = (fileId: string, userId: string) =>
  superuser.updateTable('files').set({ deleted_at: new Date(), deleted_by: userId }).where('id', '=', fileId).execute();
const restoreFile = (fileId: string) => superuser.updateTable('files').set({ deleted_at: null, deleted_by: null }).where('id', '=', fileId).execute();
const softDeleteProject = (projectId: string, userId: string) =>
  superuser.updateTable('projects').set({ deleted_at: new Date(), deleted_by: userId }).where('id', '=', projectId).execute();
const restoreProject = (projectId: string) =>
  superuser.updateTable('projects').set({ deleted_at: null, deleted_by: null }).where('id', '=', projectId).execute();

// ---- 隔离模板用的行（经应用角色在给定上下文中写入；组织或项目不对时在第一步就被拒绝） ----

/** 在当前上下文中上传一个文件（可挂到项目），返回文件 id。 */
async function fileInContext(trx: Transaction<any>, scope: ProjectRowScope, purpose: string, projectId: string | null): Promise<string> {
  const file = await trx
    .insertInto('files')
    .values({ org_id: scope.orgId, project_id: projectId, purpose, display_name: 'a.docx', extension: 'docx', created_by: scope.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.updateTable('files').set({ status: 'uploaded', mime: 'application/zip', size_bytes: 10, sha256: Buffer.alloc(32) }).where('id', '=', file.id).execute();
  return file.id;
}

const base = (scope: ProjectRowScope) => ({ org_id: scope.orgId, project_id: scope.projectId });

const ROW_WRITERS: Record<(typeof FEASIBILITY_REPORT_TABLES)[number], (trx: Transaction<any>, scope: ProjectRowScope) => Promise<string>> = {
  async feasibility_report_meta(trx, scope) {
    await trx.insertInto('feasibility_report_meta').values(base(scope)).execute();
    return scope.projectId;
  },
  async feasibility_report_sources(trx, scope) {
    const fileId = await fileInContext(trx, scope, 'tender', scope.projectId);
    await trx.insertInto('feasibility_report_sources').values({ ...base(scope), file_id: fileId }).execute();
    return fileId;
  },
  async feasibility_report_reference_docs(trx, scope) {
    const fileId = await fileInContext(trx, scope, 'knowledge', null);
    const folder = await trx
      .insertInto('knowledge_folders')
      .values({ org_id: scope.orgId, name: '资料', created_by: scope.userId, updated_by: scope.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const document = await trx
      .insertInto('knowledge_documents')
      .values({ org_id: scope.orgId, folder_id: folder.id, file_id: fileId, created_by: scope.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('feasibility_report_reference_docs').values({ ...base(scope), document_id: document.id }).execute();
    return document.id;
  },
  async feasibility_report_outline_nodes(trx, scope) {
    // 节点 id 在项目内唯一；模板按主键跨组织查找，所以用随机 id。
    const nodeId = randomUUID();
    await trx.insertInto('feasibility_report_outline_nodes').values({ ...base(scope), node_id: nodeId, level: 1, title: '总论' }).execute();
    return nodeId;
  },
};

// ---- 接口 ----

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function call(member: Member | null, method: Method, url: string, payload?: object, target: FastifyInstance = app) {
  return target.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

const fr = (projectId: string, path = '') => `/api/projects/${projectId}/feasibility-report${path}`;

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

/** 每张表中某个项目的行数（超级用户，绕过 RLS）。 */
async function adminCounts(projectId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of FEASIBILITY_REPORT_TABLES) {
    const row = await superuser.selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).where('project_id', '=', projectId).executeTakeFirstOrThrow();
    counts[table] = Number((row as { n: string }).n);
  }
  return counts;
}

/** 每张表在应用角色下（成员上下文中、不带条件的全表查询）看到的行数。 */
async function visibleCounts(member: Member): Promise<Record<string, number>> {
  return withTenant(appDb, member.context, async (trx) => {
    const counts: Record<string, number> = {};
    for (const table of FEASIBILITY_REPORT_TABLES) {
      const row = await (trx as unknown as Kysely<any>).selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
      counts[table] = Number((row as { n: string }).n);
    }
    return counts;
  });
}

const zeroCounts = () => Object.fromEntries(FEASIBILITY_REPORT_TABLES.map((table) => [table, 0]));

const OUTLINE: FeasibilityOutlineItem[] = [
  {
    id: '1',
    title: '总论',
    description: '项目概况',
    children: [
      { id: '1.1', title: '项目背景', description: '', knowledge_item_ids: ['K1', 'K2'] },
      { id: '1.2', title: '建设必要性', description: '' },
    ],
  },
  { id: '2', title: '市场分析', description: '' },
];

interface Filled {
  projectId: string;
  sources: string[];
  reference: { documentId: string; fileId: string };
}

/** 新建项目，填写项目信息、导入两份资料并写入解析结果，保存资料分析、目录配置（引用一个知识库文档）、目录、关键参数和正文。 */
async function fillProject(member: Member): Promise<Filled> {
  const projectId = await newProject(member);
  const sources = [await newFile(member, { name: '资料A.docx' }), await newFile(member, { name: '资料B.pdf' })];
  await saveProjectInfo(appDb, member.context, projectId, { projectName: '示范园区', industry: '制造业' });
  await importSources(appDb, member.context, projectId, sources);
  for (const fileId of sources) {
    const markdown = await newArtifact(member, { kind: 'markdown', sourceFileId: fileId });
    await saveSourceParse(appDb, member.context, projectId, fileId, { status: 'success', markdownArtifactId: markdown, contentChars: 4, contentHash: 'h', parserLabel: 'docx' });
  }
  await saveAnalysis(appDb, member.context, projectId, '## 分析');
  const reference = await newKnowledgeDocument(member);
  await saveOutlineConfig(appDb, member.context, projectId, { outlineTemplate: 'industrial', targetWords: 50000, referenceDocumentIds: [reference.documentId] });
  await saveOutline(appDb, member.context, projectId, { outlineData: { outline: OUTLINE, project_name: '示范园区', project_overview: '概述' }, reason: 'replace' });
  await saveKeyParameters(appDb, member.context, projectId, '总投资 1 亿元');
  await saveChapterContent(appDb, member.context, projectId, '1.1', '背景正文');
  await saveChapterContent(appDb, member.context, projectId, '2', '市场正文');
  return { projectId, sources, reference };
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
  const options = { database, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} } };
  app = await buildApp({ ...testConfig, database: testDb.appConfig }, { ...options, objectStore: memoryStore });
  noStorageApp = await buildApp({ ...testConfig, database: testDb.appConfig }, { ...options, objectStore: null });
});

afterAll(async () => {
  await app?.close();
  await noStorageApp?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('隔离模板', () => {
  const env = { admin: () => superuser, app: () => appDb };
  const ids: Record<string, string> = {
    feasibility_report_meta: 'project_id',
    feasibility_report_sources: 'file_id',
    feasibility_report_reference_docs: 'document_id',
    feasibility_report_outline_nodes: 'node_id',
  };
  // 页面状态、资料的解析结果按字段更新，节点只能改正文；引用的知识库文档整体替换，不授予 UPDATE。
  const updates: Record<string, Record<string, unknown>> = {
    feasibility_report_meta: { step: 'sources' },
    feasibility_report_sources: { status: 'running' },
    feasibility_report_outline_nodes: { content: '正文' },
  };

  for (const table of FEASIBILITY_REPORT_TABLES) {
    describeProjectTable(
      {
        table,
        idColumn: ids[table]!,
        projectKind: 'feasibility-report',
        insert: (trx, scope) => ROW_WRITERS[table](trx, scope),
        // 资料：项目物理删除被文件（files.project_id，不级联）挡住，要先由清理任务删除文件。
        onProjectDelete: table === 'feasibility_report_sources' ? 'restrict' : 'cascade',
        ...(updates[table] ? { update: updates[table] } : {}),
      },
      env,
    );
  }
});

describe('RLS：删除可见性与写权限', () => {
  let a: Member;
  let b: Member;

  beforeAll(async () => {
    a = await newMember();
    b = await newMember();
  });

  it('所属项目软删除后四张表都查不到、改不了、删不掉，恢复项目即一起恢复', async () => {
    const filled = await fillProject(a);
    const before = await adminCounts(filled.projectId);
    expect(before).toEqual({
      feasibility_report_meta: 1,
      feasibility_report_sources: 2,
      feasibility_report_reference_docs: 1,
      feasibility_report_outline_nodes: 4,
    });
    expect(await visibleCounts(a)).toEqual(before);

    await softDeleteProject(filled.projectId, a.userId);
    expect(await visibleCounts(a)).toEqual(zeroCounts());
    await withTenant(appDb, a.context, async (trx) => {
      const any = trx as unknown as Kysely<any>;
      expect((await any.updateTable('feasibility_report_meta').set({ step: 'materials' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.updateTable('feasibility_report_sources').set({ status: 'error' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.updateTable('feasibility_report_outline_nodes').set({ content: '' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.deleteFrom('feasibility_report_outline_nodes').executeTakeFirst()).numDeletedRows).toBe(0n);
      expect((await any.deleteFrom('feasibility_report_reference_docs').executeTakeFirst()).numDeletedRows).toBe(0n);
    });
    // 已删除的项目下不能新写。
    await expect(
      withTenant(appDb, a.context, (trx) =>
        trx.insertInto('feasibility_report_outline_nodes').values({ org_id: a.orgId, project_id: filled.projectId, node_id: '9', level: 1, title: '新章' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await adminCounts(filled.projectId)).toEqual(before);

    await restoreProject(filled.projectId);
    expect(await visibleCounts(a)).toEqual(before);
  });

  it('资料的原件进回收站后资料行不可见，其他行不受影响；恢复文件即一起恢复', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    const before = await visibleCounts(member);
    await softDeleteFile(filled.sources[1]!, member.userId);
    expect(await visibleCounts(member)).toEqual({ ...before, feasibility_report_sources: 1 });
    const state = await loadFeasibilityReport(appDb, member.context, filled.projectId);
    expect(state.sourceFiles.map((source) => source.id)).toEqual([filled.sources[0]]);
    await restoreFile(filled.sources[1]!);
    expect(await visibleCounts(member)).toEqual(before);
  });

  it('引用的知识库文档不可见（原件进回收站）时引用行同样不可见、不能新引用；文档删除时引用行级联删除', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    await softDeleteFile(filled.reference.fileId, member.userId);
    expect((await visibleCounts(member)).feasibility_report_reference_docs).toBe(0);
    expect((await loadFeasibilityReport(appDb, member.context, filled.projectId)).referenceDocumentIds).toEqual([]);
    const other = await newProject(member);
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx.insertInto('feasibility_report_reference_docs').values({ org_id: member.orgId, project_id: other, document_id: filled.reference.documentId }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await restoreFile(filled.reference.fileId);
    expect((await loadFeasibilityReport(appDb, member.context, filled.projectId)).referenceDocumentIds).toEqual([filled.reference.documentId]);
    await superuser.deleteFrom('knowledge_documents').where('id', '=', filled.reference.documentId).execute();
    expect((await adminCounts(filled.projectId)).feasibility_report_reference_docs).toBe(0);
  });

  it('不能引用其他组织的知识库文档', async () => {
    const projectId = await newProject(a);
    const { documentId } = await newKnowledgeDocument(b);
    await expect(
      withTenant(appDb, a.context, (trx) =>
        trx.insertInto('feasibility_report_reference_docs').values({ org_id: a.orgId, project_id: projectId, document_id: documentId }).execute(),
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it('文件被清理任务物理删除时资料行级联删除；项目随后可以物理删除', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    await superuser.deleteFrom('artifacts').where('org_id', '=', member.orgId).execute();
    await superuser.deleteFrom('files').where('project_id', '=', filled.projectId).execute();
    expect((await adminCounts(filled.projectId)).feasibility_report_sources).toBe(0);
    await superuser.deleteFrom('projects').where('id', '=', filled.projectId).execute();
    expect(await adminCounts(filled.projectId)).toEqual(zeroCounts());
  });

  it('只能挂在可研报告项目下：其他 kind 的项目下写不进任何一张表', async () => {
    const projectId = await newProject(a, 'technical-plan');
    const scope = { orgId: a.orgId, userId: a.userId, projectId };
    for (const table of FEASIBILITY_REPORT_TABLES) {
      await expect(
        withTenant(appDb, a.context, (trx) => ROW_WRITERS[table](trx as unknown as Transaction<any>, scope)),
        table,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it('只能登记本组织已上传、未删除、用途是 tender、已挂到本项目的文件；新资料一律待解析', async () => {
    const projectId = await newProject(a);
    const other = await newProject(a);
    const insert = (fileId: string, extra: Record<string, unknown> = {}) =>
      withTenant(appDb, a.context, (trx) =>
        (trx as unknown as Kysely<any>)
          .insertInto('feasibility_report_sources')
          .values({ file_id: fileId, org_id: a.orgId, project_id: projectId, ...extra })
          .execute(),
      );
    const deleted = await newFile(a, { projectId });
    await softDeleteFile(deleted, a.userId);
    const rejected = [
      await newFile(a), // 不属于任何项目
      await newFile(a, { projectId: other }), // 属于其他项目
      await newFile(a, { projectId, purpose: 'knowledge' }), // 其他用途
      await newFile(a, { projectId, status: 'uploading' }), // 未上传完成
      deleted,
    ];
    for (const fileId of rejected) await expect(insert(fileId)).rejects.toThrow(/row-level security/);
    await expect(insert(await newFile(b, { projectId: await newProject(b) }))).rejects.toThrow(/row-level security|foreign key/);
    const fine = await newFile(a, { projectId });
    // 状态等解析结果没有 INSERT 授权。
    await expect(insert(fine, { status: 'success' })).rejects.toThrow(/permission denied/);
    await insert(fine);
    await expect(insert(fine)).rejects.toThrow(/duplicate key/);
    const row = await superuser.selectFrom('feasibility_report_sources').select('status').where('file_id', '=', fine).executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
  });

  it('解析出的 Markdown 只能是本资料原件的 Markdown 产物', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const fileA = await newFile(member);
    const fileB = await newFile(member);
    await importSources(appDb, member.context, projectId, [fileA, fileB]);
    const setMarkdown = (artifactId: string) =>
      withTenant(appDb, member.context, (trx) => trx.updateTable('feasibility_report_sources').set({ markdown_artifact_id: artifactId }).where('file_id', '=', fileA).execute());
    for (const artifactId of [
      await newArtifact(member, { kind: 'markdown', sourceFileId: fileB }), // 其他文件的
      await newArtifact(member, { kind: 'image', sourceFileId: fileA }), // 不是 Markdown
      await newArtifact(member, { kind: 'markdown', sourceFileId: fileA, status: 'writing' }), // 未写完
    ]) {
      await expect(setMarkdown(artifactId)).rejects.toThrow(/row-level security/);
    }
    await setMarkdown(await newArtifact(member, { kind: 'markdown', sourceFileId: fileA }));
  });

  it('页面状态、资料没有 DELETE 授权，引用没有 UPDATE 授权，节点只能改正文；归属列写入后不能改', async () => {
    const privileges = await sql<{ table: string; del: boolean; upd: boolean }>`
      SELECT t AS table, has_table_privilege(${APP_ROLE}, t, 'DELETE') AS del, has_any_column_privilege(${APP_ROLE}, t, 'UPDATE') AS upd
      FROM unnest(${sql.val([...FEASIBILITY_REPORT_TABLES])}::text[]) AS t ORDER BY t`.execute(superuser);
    const byTable = Object.fromEntries(privileges.rows.map((row) => [row.table, row]));
    expect(byTable.feasibility_report_meta).toMatchObject({ del: false, upd: true });
    expect(byTable.feasibility_report_sources).toMatchObject({ del: false, upd: true });
    expect(byTable.feasibility_report_reference_docs).toMatchObject({ del: true, upd: false });
    expect(byTable.feasibility_report_outline_nodes).toMatchObject({ del: true, upd: true });
    const nodeColumns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_name = 'feasibility_report_outline_nodes' AND grantee = ${APP_ROLE} AND privilege_type = 'UPDATE'`.execute(superuser);
    expect(nodeColumns.rows.map((row) => row.column_name)).toEqual(['content']);
    for (const [table, column] of [
      ['feasibility_report_meta', 'project_id'],
      ['feasibility_report_meta', 'org_id'],
      ['feasibility_report_sources', 'file_id'],
      ['feasibility_report_sources', 'project_id'],
    ] as const) {
      const result = await sql<{ ok: boolean }>`SELECT has_column_privilege(${APP_ROLE}, ${table}, ${column}, 'UPDATE') AS ok`.execute(superuser);
      expect(result.rows[0]!.ok, `${table}.${column}`).toBe(false);
    }
  });

  it('父节点删除时子节点级联删除；父节点不存在的节点在提交时被外键拒绝', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await saveOutline(appDb, member.context, projectId, { outlineData: { outline: OUTLINE }, reason: 'replace' });
    await withTenant(appDb, member.context, (trx) => trx.deleteFrom('feasibility_report_outline_nodes').where('project_id', '=', projectId).where('node_id', '=', '1').execute());
    expect((await adminCounts(projectId)).feasibility_report_outline_nodes).toBe(1);
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx.insertInto('feasibility_report_outline_nodes').values({ org_id: member.orgId, project_id: projectId, node_id: '3.1', parent_node_id: '3', level: 2, title: '孤儿' }).execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('取值与长度由 CHECK 约束挡住', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const meta = (values: Record<string, unknown>) =>
      withTenant(appDb, member.context, (trx) => (trx as unknown as Kysely<any>).insertInto('feasibility_report_meta').values({ org_id: member.orgId, project_id: projectId, ...values }).execute());
    for (const values of [{ step: 'done' }, { project_type: 'other' }, { outline_template: 'x' }, { target_words: 999 }, { target_words: 1_000_001 }, { project_name: 'x'.repeat(501) }]) {
      await expect(meta(values), JSON.stringify(values).slice(0, 60)).rejects.toThrow(/check constraint/);
    }
    const node = (values: Record<string, unknown>) =>
      withTenant(appDb, member.context, (trx) =>
        (trx as unknown as Kysely<any>)
          .insertInto('feasibility_report_outline_nodes')
          .values({ org_id: member.orgId, project_id: projectId, node_id: '1', level: 1, title: '总论', ...values })
          .execute(),
      );
    for (const values of [{ node_id: '' }, { title: '' }, { level: 0 }, { level: 11 }, { level: 2 }, { knowledge_item_ids: '{}' }, { node_id: 'x'.repeat(65) }]) {
      await expect(node(values), JSON.stringify(values).slice(0, 60)).rejects.toThrow(/check constraint/);
    }
  });
});

describe('Store', () => {
  let a: Member;
  let peer: Member;
  let b: Member;

  beforeAll(async () => {
    a = await newMember();
    peer = await newMember(a.orgId);
    b = await newMember();
  });

  it('没写过时返回默认状态，不预先插入行', async () => {
    const projectId = await newProject(a);
    expect(await loadFeasibilityReport(appDb, a.context, projectId)).toEqual({
      step: 'materials',
      projectInfo: {
        projectName: '',
        projectType: 'government',
        industry: '',
        constructionUnit: '',
        location: '',
        constructionContent: '',
        constructionPeriodYears: '2',
        operationPeriodYears: '20',
        totalInvestment: '',
        fundingSource: '',
      },
      sourceFiles: [],
      analysisMarkdown: '',
      outlineTemplate: 'government',
      targetWords: 30000,
      referenceDocumentIds: [],
      keyParametersMarkdown: '',
      outlineData: null,
      analysisTask: null,
      outlineTask: null,
      outlineAdjustmentTask: null,
      outlineAdjustment: null,
      outlineAdjustable: false,
      parametersTask: null,
      contentTask: null,
      humanWritingTask: null,
    });
    expect(await adminCounts(projectId)).toEqual(zeroCounts());
  });

  it('完整状态：目录组装成树，空字段省略；组织内其他成员看到同样的状态', async () => {
    const filled = await fillProject(a);
    const state = await loadFeasibilityReport(appDb, a.context, filled.projectId);
    expect(state.projectInfo).toMatchObject({ projectName: '示范园区', industry: '制造业', constructionPeriodYears: '2' });
    expect(state.sourceFiles.map((source) => [source.fileName, source.status, source.contentChars, source.parserLabel])).toEqual([
      ['资料A.docx', 'success', 4, 'docx'],
      ['资料B.pdf', 'success', 4, 'docx'],
    ]);
    expect(state).toMatchObject({ analysisMarkdown: '## 分析', outlineTemplate: 'industrial', targetWords: 50000, keyParametersMarkdown: '总投资 1 亿元' });
    expect(state.referenceDocumentIds).toEqual([filled.reference.documentId]);
    expect(state.outlineData).toEqual({
      outline: [
        {
          id: '1',
          title: '总论',
          description: '项目概况',
          children: [
            { id: '1.1', title: '项目背景', description: '', knowledge_item_ids: ['K1', 'K2'], content: '背景正文' },
            { id: '1.2', title: '建设必要性', description: '' },
          ],
        },
        { id: '2', title: '市场分析', description: '', content: '市场正文' },
      ],
      project_name: '示范园区',
      project_overview: '概述',
    });
    expect(await loadFeasibilityReport(appDb, peer.context, filled.projectId)).toEqual(state);
  });

  it('切换步骤', async () => {
    const projectId = await newProject(a);
    expect(await updateStep(appDb, a.context, projectId, 'outline')).toEqual({ step: 'outline' });
    expect((await loadFeasibilityReport(appDb, a.context, projectId)).step).toBe('outline');
  });

  it('保存项目信息：去掉首尾空白、建设期与运营期取默认值、项目名称必填；同时清空资料分析、目录和关键参数', async () => {
    const filled = await fillProject(a);
    await expect(saveProjectInfo(appDb, a.context, filled.projectId, { projectName: '  ' })).rejects.toMatchObject({ statusCode: 400, code: 'FEASIBILITY_REPORT_INVALID' });
    const state = await saveProjectInfo(appDb, a.context, filled.projectId, {
      projectName: ' 新项目 ',
      projectType: 'enterprise',
      constructionPeriodYears: ' ',
      fundingSource: '自筹\u0000',
    });
    expect(state.projectInfo).toEqual({
      projectName: '新项目',
      projectType: 'enterprise',
      industry: '',
      constructionUnit: '',
      location: '',
      constructionContent: '',
      constructionPeriodYears: '2',
      operationPeriodYears: '20',
      totalInvestment: '',
      fundingSource: '自筹',
    });
    expect(state).toMatchObject({ analysisMarkdown: '', keyParametersMarkdown: '', outlineData: null, outlineTemplate: 'industrial' });
    expect(state.sourceFiles).toHaveLength(2);
    expect(state.referenceDocumentIds).toEqual([filled.reference.documentId]);
  });

  it('保存资料分析：去掉首尾空白，同时清空目录和关键参数，保留目录配置', async () => {
    const filled = await fillProject(a);
    const state = await saveAnalysis(appDb, a.context, filled.projectId, '  新分析  ');
    expect(state).toMatchObject({ analysisMarkdown: '新分析', keyParametersMarkdown: '', outlineData: null, targetWords: 50000 });
    expect(state.referenceDocumentIds).toHaveLength(1);
  });

  it('保存关键参数：同时清空全部正文', async () => {
    const filled = await fillProject(a);
    const state = await saveKeyParameters(appDb, a.context, filled.projectId, ' 新参数 ');
    expect(state.keyParametersMarkdown).toBe('新参数');
    const contents = await superuser.selectFrom('feasibility_report_outline_nodes').select('content').where('project_id', '=', filled.projectId).execute();
    expect(contents.every((row: { content: string }) => row.content === '')).toBe(true);
    expect(state.outlineData?.outline).toHaveLength(2);
  });

  it('保存一章正文；章节不存在时 404', async () => {
    const filled = await fillProject(a);
    const state = await saveChapterContent(appDb, a.context, filled.projectId, '1.2', '必要性正文');
    expect(state.outlineData!.outline[0]!.children![1]!.content).toBe('必要性正文');
    expect(state.keyParametersMarkdown).toBe('总投资 1 亿元');
    await expect(saveChapterContent(appDb, a.context, filled.projectId, '9', 'x')).rejects.toMatchObject({ statusCode: 404, code: 'FEASIBILITY_REPORT_CHAPTER_NOT_FOUND' });
  });

  describe('保存目录（reason 协议）', () => {
    const contentsOf = async (projectId: string) =>
      Object.fromEntries(
        (await superuser.selectFrom('feasibility_report_outline_nodes').select(['node_id', 'content']).where('project_id', '=', projectId).execute()).map(
          (row: { node_id: string; content: string }) => [row.node_id, row.content],
        ),
      );

    it('replace：清空全部正文和关键参数（即使请求带了正文）', async () => {
      const filled = await fillProject(a);
      const outline = [{ id: '1', title: '总论', description: '', content: '请求中的正文' }];
      const state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: { outline }, reason: 'replace' });
      expect(await contentsOf(filled.projectId)).toEqual({ '1': '' });
      expect(state.keyParametersMarkdown).toBe('');
      expect(state.outlineData).toEqual({ outline: [{ id: '1', title: '总论', description: '' }] });
    });

    it('sort：按 idMap 沿用已保存的正文，保留关键参数', async () => {
      const filled = await fillProject(a);
      // 把“市场分析”移到最前，重新编号为 1，原来的 1 变成 2。
      const outline = [
        { id: '1', title: '市场分析', description: '' },
        { id: '2', title: '总论', description: '项目概况', children: [{ id: '2.1', title: '项目背景', description: '' }, { id: '2.2', title: '建设必要性', description: '' }] },
      ];
      const idMap = { '2': '1', '1': '2', '1.1': '2.1', '1.2': '2.2' };
      const state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: { outline, project_name: '示范园区' }, reason: 'sort', idMap });
      expect(await contentsOf(filled.projectId)).toEqual({ '1': '市场正文', '2': '', '2.1': '背景正文', '2.2': '' });
      expect(state.keyParametersMarkdown).toBe('总投资 1 亿元');
      expect(state.outlineData).toMatchObject({ project_name: '示范园区' });
      expect(state.outlineData).not.toHaveProperty('project_overview');
    });

    it('edit：只清空受影响章节的正文，清空关键参数', async () => {
      const filled = await fillProject(a);
      const outline = [
        { id: '1', title: '总论', description: '', children: [{ id: '1.1', title: '背景（改）', description: '' }, { id: '1.2', title: '建设必要性', description: '' }] },
        { id: '2', title: '市场分析', description: '' },
      ];
      const state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: { outline }, reason: 'edit', affectedNodeIds: ['1.1'] });
      expect(await contentsOf(filled.projectId)).toEqual({ '1': '', '1.1': '', '1.2': '', '2': '市场正文' });
      expect(state.keyParametersMarkdown).toBe('');
    });

    it('delete：按 idMap 找到旧正文（删除第一章后重新编号）', async () => {
      const filled = await fillProject(a);
      const outline = [{ id: '1', title: '市场分析', description: '' }];
      await saveOutline(appDb, a.context, filled.projectId, { outlineData: { outline }, reason: 'delete', idMap: { '2': '1' } });
      expect(await contentsOf(filled.projectId)).toEqual({ '1': '市场正文' });
    });

    it('outlineData 为 null 或空目录时删除目录', async () => {
      const filled = await fillProject(a);
      let state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: null, reason: 'replace' });
      expect(state.outlineData).toBeNull();
      expect((await adminCounts(filled.projectId)).feasibility_report_outline_nodes).toBe(0);
      state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: { outline: [], project_name: 'x' }, reason: 'replace' });
      expect(state.outlineData).toBeNull();
    });

    it('与桌面版相同：没有 id 的节点连同子节点跳过，空标题用“未命名章节”，去掉首尾空白', async () => {
      const projectId = await newProject(a);
      const outline = [
        { id: ' 1 ', title: '  ', description: ' 说明 ' },
        { id: '', title: '无 id', description: '', children: [{ id: '9', title: '子', description: '' }] },
      ];
      const state = await saveOutline(appDb, a.context, projectId, { outlineData: { outline }, reason: 'replace' });
      expect(state.outlineData).toEqual({ outline: [{ id: '1', title: '未命名章节', description: '说明' }] });
    });

    it('结构不对、id 重复、超过层级或字数上限时返回 400，原目录不变', async () => {
      const filled = await fillProject(a);
      let deep: Record<string, unknown> = { id: 'x11', title: 't', description: '' };
      for (let level = 10; level >= 1; level -= 1) deep = { id: `x${level}`, title: 't', description: '', children: [deep] };
      const bad: unknown[] = [
        'not-an-object',
        { outline: 'x' },
        { outline: [1] },
        { outline: [{ id: 1, title: 't' }] },
        { outline: [{ id: '1', title: 't', children: {} }] },
        { outline: [{ id: '1', title: 't', knowledge_item_ids: [1] }] },
        { outline: [{ id: '1', title: 't' }, { id: '1', title: 't' }] },
        { outline: [{ id: 'x'.repeat(65), title: 't' }] },
        { outline: [{ id: '1', title: 'x'.repeat(2001) }] },
        { outline: [{ id: '1', title: 't', content: 'x'.repeat(500_001) }] },
        { outline: [deep] },
        { outline: Array.from({ length: 2001 }, (_, index) => ({ id: String(index + 1), title: 't' })) },
      ];
      for (const outlineData of bad) {
        await expect(saveOutline(appDb, a.context, filled.projectId, { outlineData, reason: 'replace' }), JSON.stringify(outlineData).slice(0, 60)).rejects.toMatchObject({
          statusCode: 400,
          code: 'FEASIBILITY_REPORT_INVALID',
        });
      }
      // 10 级可以保存。
      await saveOutline(appDb, a.context, await newProject(a), { outlineData: { outline: [(deep.children as unknown[])[0]] }, reason: 'replace' });
      expect((await adminCounts(filled.projectId)).feasibility_report_outline_nodes).toBe(4);
    });
  });

  it('目录配置：目标字数按桌面版整理，引用的知识库文档去重、按顺序整体替换', async () => {
    const projectId = await newProject(a);
    const docA = await newKnowledgeDocument(a);
    const docB = await newKnowledgeDocument(a);
    let state = await saveOutlineConfig(appDb, a.context, projectId, {
      outlineTemplate: 'hi_tech',
      targetWords: 999,
      referenceDocumentIds: [docB.documentId, docA.documentId.toUpperCase(), docB.documentId],
    });
    expect(state).toMatchObject({ outlineTemplate: 'hi_tech', targetWords: 30000, referenceDocumentIds: [docB.documentId, docA.documentId] });
    state = await saveOutlineConfig(appDb, a.context, projectId, { outlineTemplate: 'enterprise', targetWords: 80000.4, referenceDocumentIds: [docA.documentId] });
    expect(state).toMatchObject({ outlineTemplate: 'enterprise', targetWords: 80000, referenceDocumentIds: [docA.documentId] });
  });

  it('目录配置：引用其他组织的、不存在的或原件已删除的文档时整体失败，原配置不变', async () => {
    const projectId = await newProject(a);
    const mine = await newKnowledgeDocument(a);
    const deleted = await newKnowledgeDocument(a);
    await softDeleteFile(deleted.fileId, a.userId);
    await saveOutlineConfig(appDb, a.context, projectId, { outlineTemplate: 'hi_tech', targetWords: 40000, referenceDocumentIds: [mine.documentId] });
    for (const documentId of [(await newKnowledgeDocument(b)).documentId, randomUUID(), deleted.documentId]) {
      await expect(
        saveOutlineConfig(appDb, a.context, projectId, { outlineTemplate: 'government', targetWords: 50000, referenceDocumentIds: [mine.documentId, documentId] }),
      ).rejects.toMatchObject({ statusCode: 400, code: 'FEASIBILITY_REPORT_REFERENCE_UNAVAILABLE' });
    }
    expect(await loadFeasibilityReport(appDb, a.context, projectId)).toMatchObject({ outlineTemplate: 'hi_tech', targetWords: 40000, referenceDocumentIds: [mine.documentId] });
  });

  it('导入资料：整体替换，新文件挂到项目、待解析，保留的按新顺序排列，去掉的原件进回收站；同时清空资料分析、目录和关键参数', async () => {
    const filled = await fillProject(a);
    const [first, second] = filled.sources as [string, string];
    const third = await newFile(a, { name: '资料C.xlsx' });
    const result = await importSources(appDb, a.context, filled.projectId, [third, second.toUpperCase()]);
    expect(result).toMatchObject({ addedCount: 1, removedCount: 1 });
    expect(result.state.sourceFiles.map((source) => [source.fileName, source.status])).toEqual([
      ['资料C.xlsx', 'pending'],
      ['资料B.pdf', 'success'],
    ]);
    expect(result.state).toMatchObject({ analysisMarkdown: '', keyParametersMarkdown: '', outlineData: null });
    const files = await superuser.selectFrom('files').select(['id', 'project_id', 'deleted_at']).where('id', 'in', [first, second, third]).execute();
    const byId: Record<string, { project_id: string | null; deleted_at: Date | null }> = Object.fromEntries(files.map((file: { id: string; project_id: string | null; deleted_at: Date | null }) => [file.id, file]));
    expect(byId[first]!.deleted_at).not.toBeNull();
    expect(byId[second]!.deleted_at).toBeNull();
    expect(byId[third]!.project_id).toBe(filled.projectId);
    expect(await loadFeasibilityReport(appDb, peer.context, filled.projectId)).toEqual(result.state);
  });

  it('导入资料：文件不可用时整体失败，不改动已有资料', async () => {
    const projectId = await newProject(a);
    const kept = await newFile(a);
    await importSources(appDb, a.context, projectId, [kept]);
    const deleted = await newFile(a);
    await softDeleteFile(deleted, a.userId);
    const unavailable = [
      await newFile(a, { purpose: 'knowledge' }),
      await newFile(a, { status: 'uploading' }),
      await newFile(a, { projectId: await newProject(a) }),
      await newFile(b),
      deleted,
      randomUUID(),
    ];
    for (const fileId of unavailable) {
      await expect(importSources(appDb, a.context, projectId, [await newFile(a), fileId])).rejects.toMatchObject({ statusCode: 400, code: 'FEASIBILITY_REPORT_FILE_UNAVAILABLE' });
    }
    await expect(importSources(appDb, a.context, projectId, [kept, kept])).rejects.toMatchObject({ code: 'FEASIBILITY_REPORT_FILE_UNAVAILABLE' });
    const state = await loadFeasibilityReport(appDb, a.context, projectId);
    expect(state.sourceFiles.map((source) => source.id)).toEqual([kept]);
    const keptFile = await superuser.selectFrom('files').select('deleted_at').where('id', '=', kept).executeTakeFirstOrThrow();
    expect(keptFile.deleted_at).toBeNull();
  });

  it('移除资料：原件进回收站，同时清空资料分析、目录和关键参数；不存在时 404', async () => {
    const filled = await fillProject(a);
    const state = await removeSource(appDb, a.context, filled.projectId, filled.sources[0]!.toUpperCase());
    expect(state.sourceFiles.map((source) => source.id)).toEqual([filled.sources[1]]);
    expect(state).toMatchObject({ analysisMarkdown: '', outlineData: null, keyParametersMarkdown: '' });
    await expect(removeSource(appDb, a.context, filled.projectId, filled.sources[0]!)).rejects.toMatchObject({ statusCode: 404, code: 'FEASIBILITY_REPORT_SOURCE_NOT_FOUND' });
  });

  it('清空：删除目录与引用，资料原件进回收站，页面状态与项目信息恢复默认值', async () => {
    const filled = await fillProject(a);
    expect(await clearFeasibilityReport(appDb, a.context, filled.projectId)).toEqual({ deletedFileCount: 2 });
    const state = await loadFeasibilityReport(appDb, a.context, filled.projectId);
    const fresh = await loadFeasibilityReport(appDb, a.context, await newProject(a));
    expect(state).toEqual(fresh);
    expect(await adminCounts(filled.projectId)).toEqual({ ...zeroCounts(), feasibility_report_meta: 1, feasibility_report_sources: 2 });
  });

  it('saveSourceParse：只写给出的字段；产物不合规被拒绝；资料已移除时返回 false；参数不合法抛 TypeError', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const fileId = await newFile(member);
    await importSources(appDb, member.context, projectId, [fileId]);
    expect(await saveSourceParse(appDb, member.context, projectId, fileId, { status: 'running' })).toBe(true);
    expect(await saveSourceParse(appDb, member.context, projectId, fileId, { error: 'x'.repeat(30_000), parserLabel: 'pdf\u0000', contentChars: -5 })).toBe(true);
    let source = (await loadFeasibilityReport(appDb, member.context, projectId)).sourceFiles[0]!;
    expect(source).toMatchObject({ status: 'running', parserLabel: 'pdf', contentChars: 0 });
    expect(source.error).toHaveLength(20_000);
    const other = await newFile(member);
    await expect(
      saveSourceParse(appDb, member.context, projectId, fileId, { markdownArtifactId: await newArtifact(member, { kind: 'markdown', sourceFileId: other }) }),
    ).rejects.toThrow(/row-level security/);
    const markdown = await newArtifact(member, { kind: 'markdown', sourceFileId: fileId });
    await saveSourceParse(appDb, member.context, projectId, fileId, { status: 'success', markdownArtifactId: markdown, contentHash: 'abc', error: null });
    source = (await loadFeasibilityReport(appDb, member.context, projectId)).sourceFiles[0]!;
    expect(source).toMatchObject({ status: 'success', markdownArtifactId: markdown, contentHash: 'abc', error: null });
    await expect(saveSourceParse(appDb, member.context, projectId, 'not-a-uuid', {})).rejects.toBeInstanceOf(TypeError);
    await expect(saveSourceParse(appDb, member.context, projectId, fileId, { contentHash: 'x'.repeat(201) })).rejects.toBeInstanceOf(TypeError);
    await softDeleteFile(fileId, member.userId);
    expect(await saveSourceParse(appDb, member.context, projectId, fileId, { status: 'error' })).toBe(false);
    expect(await saveSourceParse(appDb, member.context, projectId, fileId, {})).toBe(false);
  });
});

describe('接口', () => {
  let a: Member;
  let b: Member;

  beforeAll(async () => {
    a = await newMember();
    b = await newMember();
  });

  it('需要登录；其他组织的、已删除的、kind 不符的项目一律 404', async () => {
    const projectId = await newProject(a);
    await expectError(await call(null, 'GET', fr(projectId)), 401, 'UNAUTHORIZED');
    await expectError(await call(b, 'GET', fr(projectId)), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(a, 'GET', fr(await newProject(a, 'rejection-check'))), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(b, 'PUT', fr(projectId, '/project-info'), { projectInfo: { projectName: 'x' } }), 404, 'PROJECT_NOT_FOUND');
    await softDeleteProject(projectId, a.userId);
    await expectError(await call(a, 'GET', fr(projectId)), 404, 'PROJECT_NOT_FOUND');
  });

  it('完整流程：项目信息、资料、分析、目录配置、目录、关键参数、正文、步骤、清空', async () => {
    const projectId = await newProject(a);
    let response = await call(a, 'GET', fr(projectId));
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ step: 'materials', outlineData: null, contentTask: null });

    response = await call(a, 'PUT', fr(projectId, '/project-info'), { projectInfo: { projectName: '园区', projectType: 'enterprise' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().projectInfo).toMatchObject({ projectName: '园区', projectType: 'enterprise' });

    const fileId = await newFile(a, { name: '资料.docx' });
    response = await call(a, 'PUT', fr(projectId, '/sources'), { fileIds: [fileId] });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ addedCount: 1, removedCount: 0 });
    expect(response.json().state.sourceFiles[0]).toMatchObject({ id: fileId, fileName: '资料.docx', status: 'pending' });

    response = await call(a, 'PUT', fr(projectId, '/analysis'), { markdown: '分析' });
    expect(response.json().analysisMarkdown).toBe('分析');

    const { documentId } = await newKnowledgeDocument(a);
    response = await call(a, 'PUT', fr(projectId, '/outline-config'), { outlineTemplate: 'infrastructure', targetWords: 60000, referenceDocumentIds: [documentId] });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ outlineTemplate: 'infrastructure', targetWords: 60000, referenceDocumentIds: [documentId] });

    // 目录连同正文超过全局的 1 MB 请求体上限也能保存。
    const big = '字'.repeat(400_000);
    const outline = [{ id: '1', title: '总论', description: '', content: big, children: [{ id: '1.1', title: '背景', description: '', attr: '技术' }] }];
    response = await call(a, 'PUT', fr(projectId, '/outline'), { outlineData: { outline }, reason: 'add-root' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outlineData.outline[0].content).toHaveLength(400_000);
    // 桌面版 OutlineItem 的其他字段（如 attr）与桌面版相同不保存。
    expect(response.json().outlineData.outline[0].children[0]).toEqual({ id: '1.1', title: '背景', description: '' });

    response = await call(a, 'PUT', fr(projectId, '/key-parameters'), { markdown: '参数' });
    expect(response.json()).toMatchObject({ keyParametersMarkdown: '参数' });
    expect(response.json().outlineData.outline[0]).not.toHaveProperty('content');

    response = await call(a, 'PUT', fr(projectId, '/chapters/1.1'), { content: '背景正文' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outlineData.outline[0].children[0].content).toBe('背景正文');
    await expectError(await call(a, 'PUT', fr(projectId, '/chapters/9'), { content: 'x' }), 404, 'FEASIBILITY_REPORT_CHAPTER_NOT_FOUND');

    response = await call(a, 'PATCH', fr(projectId, '/step'), { step: 'content' });
    expect(response.json()).toEqual({ step: 'content' });

    response = await call(a, 'DELETE', fr(projectId, `/sources/${fileId}`));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ sourceFiles: [], analysisMarkdown: '', outlineData: null });
    await expectError(await call(a, 'DELETE', fr(projectId, `/sources/${fileId}`)), 404, 'FEASIBILITY_REPORT_SOURCE_NOT_FOUND');

    response = await call(a, 'DELETE', fr(projectId));
    expect(response.json()).toEqual({ deletedFileCount: 0 });
    expect((await call(a, 'GET', fr(projectId))).json()).toMatchObject({ step: 'materials', referenceDocumentIds: [], projectInfo: { projectName: '' } });
  });

  it('请求体校验：未声明字段、取值不合法、缺少字段一律 400', async () => {
    const projectId = await newProject(a);
    const cases: [Method, string, object][] = [
      ['PATCH', '/step', { step: 'done' }],
      ['PUT', '/project-info', { projectInfo: { projectName: 'x', apiKey: 'k' } }],
      ['PUT', '/project-info', { projectInfo: { projectName: 'x'.repeat(501) } }],
      ['PUT', '/analysis', {}],
      ['PUT', '/outline-config', { outlineTemplate: 'government', targetWords: 30000 }],
      ['PUT', '/outline-config', { outlineTemplate: 'government', targetWords: 30000, referenceDocumentIds: ['x'] }],
      ['PUT', '/outline', { outlineData: { outline: [] }, reason: 'other' }],
      ['PUT', '/outline', { outlineData: [], reason: 'replace' }],
      ['PUT', '/sources', { fileIds: [] }],
      ['PUT', '/sources', { fileIds: ['x'] }],
    ];
    for (const [method, path, payload] of cases) {
      const response = await call(a, method, fr(projectId, path), payload);
      expect(response.statusCode, `${method} ${path} ${response.body}`).toBe(400);
    }
    await expectError(await call(a, 'PUT', fr(projectId, '/project-info'), { projectInfo: { projectName: ' ' } }), 400, 'FEASIBILITY_REPORT_INVALID');
    await expectError(await call(a, 'PUT', fr(projectId, '/outline'), { outlineData: { outline: [{ id: '1' }, { id: '1' }] }, reason: 'replace' }), 400, 'FEASIBILITY_REPORT_INVALID');
    await expectError(await call(a, 'PUT', fr(projectId, '/sources'), { fileIds: [await newFile(b)] }), 400, 'FEASIBILITY_REPORT_FILE_UNAVAILABLE');
    await expectError(
      await call(a, 'PUT', fr(projectId, '/outline-config'), { outlineTemplate: 'government', targetWords: 30000, referenceDocumentIds: [randomUUID()] }),
      400,
      'FEASIBILITY_REPORT_REFERENCE_UNAVAILABLE',
    );
  });

  it('资料的 Markdown：附件下载；还没有解析时为空；未配置对象存储时 503；资料不可见时 404', async () => {
    const projectId = await newProject(a);
    const fileId = await newFile(a);
    await importSources(appDb, a.context, projectId, [fileId]);
    let response = await call(a, 'GET', fr(projectId, `/sources/${fileId}/markdown`));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    const markdown = await newArtifact(a, { kind: 'markdown', sourceFileId: fileId, content: '# 资料正文' });
    await saveSourceParse(appDb, a.context, projectId, fileId, { status: 'success', markdownArtifactId: markdown });
    response = await call(a, 'GET', fr(projectId, `/sources/${fileId}/markdown`));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('# 资料正文');
    expect(response.headers).toMatchObject({
      'content-type': 'text/markdown; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
    });
    expect(String(response.headers['content-disposition'])).toMatch(/^attachment;/);
    await expectError(await call(a, 'GET', fr(projectId, `/sources/${fileId}/markdown`), undefined, noStorageApp), 503, 'FILE_STORAGE_DISABLED');
    await expectError(await call(b, 'GET', fr(projectId, `/sources/${fileId}/markdown`)), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(a, 'GET', fr(projectId, `/sources/${randomUUID()}/markdown`)), 404, 'FEASIBILITY_REPORT_SOURCE_NOT_FOUND');
    await softDeleteFile(fileId, a.userId);
    await expectError(await call(a, 'GET', fr(projectId, `/sources/${fileId}/markdown`)), 404, 'FEASIBILITY_REPORT_SOURCE_NOT_FOUND');
  });
});
