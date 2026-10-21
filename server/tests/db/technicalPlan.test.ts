// 技术方案（一）（迁移 0018_technical_plan）的数据库与接口测试：六张表的隔离模板（describeProjectTable，项目级），
// 删除可见性与写权限由 RLS 强制（绕过 Store 直接写库同样被拒绝），招标文件与原方案、生成配置（含导出模板、选中的解析项、
// 引用的知识库文档）、单 / 多标段切换与投标范围、合并的招标正文、清空，给第 6 步任务用的写函数，以及全部接口。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { TECHNICAL_PLAN_BID_ITEM_IDS, TECHNICAL_PLAN_DEFAULT_HTML_IMAGE_TYPES, TECHNICAL_PLAN_TABLES } from '../../src/db/migrations/0018_technical_plan.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { APP_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import type { ProjectKind } from '../../src/projects/store.ts';
import {
  clearTechnicalPlan,
  DEFAULT_EXPORT_TEMPLATE_KEY,
  importTenderFiles,
  loadTechnicalPlan,
  prepareBidSectionExtraction,
  readTenderMarkdown,
  removeOriginalPlan,
  removeTenderFile,
  saveBidAnalysisConfig,
  saveBidItems,
  saveBidSectionExtraction,
  saveContentGenerationOptions,
  saveDocumentParse,
  saveGenerationConfig,
  selectBidSection,
  setOriginalPlan,
  TECHNICAL_PLAN_MARKDOWN_READ_MAX_BYTES,
  TECHNICAL_PLAN_TENDER_FILES_MAX,
  updateStep,
} from '../../src/technicalPlan/store.ts';
import { syncSystemTemplates } from '../../src/templates/system.ts';
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

const REQUIRED_TASKS = ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements', 'responseFileRequirements'];

const DEFAULT_CONTENT_OPTIONS = {
  imageQuantity: 30,
  useAiImages: true,
  useMermaidImages: true,
  useHtmlImages: true,
  htmlImageOptimization: false,
  wordCountRepair: false,
  layoutCheck: false,
  useSingleImageLayout: true,
  useImageTextLayout: true,
  useThreeImagesLayout: true,
  useFourImagesLayout: true,
  htmlImageTypes: TECHNICAL_PLAN_DEFAULT_HTML_IMAGE_TYPES,
  tableRequirement: 'heavy',
};

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
/** 系统模板“标准投标”的 id（默认导出模板）。 */
let standardTemplateId: string;
/** 另一个系统模板的 id。 */
let otherSystemTemplateId: string;

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

async function newProject(member: Pick<Member, 'orgId' | 'userId'>, kind: ProjectKind = 'technical-plan'): Promise<string> {
  const row = await superuser
    .insertInto('projects')
    .values({ org_id: member.orgId, kind, name: '技术方案项目', created_by: member.userId })
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
      display_name: options.name ?? '招标文件.docx',
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
  options: { kind: 'markdown' | 'image'; sourceFileId: string; status?: 'ready' | 'writing'; content?: string; recordedSize?: number },
): Promise<string> {
  const ready = (options.status ?? 'ready') === 'ready';
  const content = Buffer.from(options.content ?? '# 招标文件');
  const row = await superuser
    .insertInto('artifacts')
    .values({
      org_id: member.orgId,
      source_file_id: options.sourceFileId,
      kind: options.kind,
      name: options.kind === 'markdown' ? 'content.md' : 'image-001.png',
      mime: options.kind === 'markdown' ? 'text/markdown; charset=utf-8' : 'image/png',
      status: ready ? 'ready' : 'writing',
      size_bytes: ready ? (options.recordedSize ?? content.length) : null,
      sha256: ready ? Buffer.alloc(32) : null,
      completed_at: ready ? new Date() : null,
      created_by: member.userId,
    })
    .returning(['id', 'storage_key'])
    .executeTakeFirstOrThrow();
  objects.set(row.storage_key, content);
  return row.id;
}

/** 写入一份文档的解析结果（Markdown 产物），返回产物 id。 */
async function parsed(member: Member, projectId: string, fileId: string, content: string): Promise<string> {
  const artifactId = await newArtifact(member, { kind: 'markdown', sourceFileId: fileId, content });
  expect(await saveDocumentParse(appDb, member.context, projectId, fileId, { status: 'success', markdownArtifactId: artifactId, contentChars: content.length })).toBe(true);
  return artifactId;
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

/** 用超级用户新建一个组织模板。 */
async function newTemplate(member: Pick<Member, 'orgId' | 'userId'>, name = '组织模板'): Promise<string> {
  const row = await superuser
    .insertInto('export_templates')
    .values({ org_id: member.orgId, name, config: JSON.stringify({ template_name: name }), created_by: member.userId, updated_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const softDeleteFile = (fileId: string, userId: string) =>
  superuser.updateTable('files').set({ deleted_at: new Date(), deleted_by: userId }).where('id', '=', fileId).execute();
const restoreFile = (fileId: string) => superuser.updateTable('files').set({ deleted_at: null, deleted_by: null }).where('id', '=', fileId).execute();
const softDeleteProject = (projectId: string, userId: string) =>
  superuser.updateTable('projects').set({ deleted_at: new Date(), deleted_by: userId }).where('id', '=', projectId).execute();
const restoreProject = (projectId: string) =>
  superuser.updateTable('projects').set({ deleted_at: null, deleted_by: null }).where('id', '=', projectId).execute();
const fileDeleted = async (fileId: string) =>
  (await superuser.selectFrom('files').select('deleted_at').where('id', '=', fileId).executeTakeFirstOrThrow()).deleted_at !== null;

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

/** 解析项 id 只能取任务列表中的值；模板按主键跨组织查找，所以每次写入换一个，两个组织的行 id 不同。 */
let nextItem = 0;
const itemId = () => TECHNICAL_PLAN_BID_ITEM_IDS[nextItem++ % TECHNICAL_PLAN_BID_ITEM_IDS.length]!;

const ROW_WRITERS: Record<(typeof TECHNICAL_PLAN_TABLES)[number], (trx: Transaction<any>, scope: ProjectRowScope) => Promise<string>> = {
  async technical_plan_meta(trx, scope) {
    await trx.insertInto('technical_plan_meta').values(base(scope)).execute();
    return scope.projectId;
  },
  async technical_plan_documents(trx, scope) {
    const fileId = await fileInContext(trx, scope, 'tender', scope.projectId);
    await trx.insertInto('technical_plan_documents').values({ ...base(scope), file_id: fileId, role: 'tender' }).execute();
    return fileId;
  },
  async technical_plan_generation_config(trx, scope) {
    await trx.insertInto('technical_plan_generation_config').values(base(scope)).execute();
    return scope.projectId;
  },
  async technical_plan_generation_bid_tasks(trx, scope) {
    const taskId = itemId();
    await trx.insertInto('technical_plan_generation_bid_tasks').values({ ...base(scope), task_id: taskId }).execute();
    return taskId;
  },
  async technical_plan_generation_reference_docs(trx, scope) {
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
    await trx.insertInto('technical_plan_generation_reference_docs').values({ ...base(scope), document_id: document.id }).execute();
    return document.id;
  },
  async technical_plan_bid_items(trx, scope) {
    const id = itemId();
    await trx.insertInto('technical_plan_bid_items').values({ ...base(scope), item_id: id, label: '项目概述' }).execute();
    return id;
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

const tp = (projectId: string, path = '') => `/api/projects/${projectId}/technical-plan${path}`;

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  await expect(promise).rejects.toMatchObject({ statusCode: status, code });
}

/** 每张表中某个项目的行数（超级用户，绕过 RLS）。 */
async function adminCounts(projectId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TECHNICAL_PLAN_TABLES) {
    const row = await superuser.selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).where('project_id', '=', projectId).executeTakeFirstOrThrow();
    counts[table] = Number((row as { n: string }).n);
  }
  return counts;
}

/** 每张表在应用角色下（成员上下文中、不带条件的全表查询）看到的行数。 */
async function visibleCounts(member: Member): Promise<Record<string, number>> {
  return withTenant(appDb, member.context, async (trx) => {
    const counts: Record<string, number> = {};
    for (const table of TECHNICAL_PLAN_TABLES) {
      const row = await (trx as unknown as Kysely<any>).selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
      counts[table] = Number((row as { n: string }).n);
    }
    return counts;
  });
}

const zeroCounts = () => Object.fromEntries(TECHNICAL_PLAN_TABLES.map((table) => [table, 0]));

const SECTIONS = [
  { id: 's1', title: '一标段', includeRanges: [{ startLine: 2, endLine: 2 }] },
  { id: 's2', title: '二标段', includeRanges: [{ startLine: 3, endLine: 3 }] },
];

interface Filled {
  projectId: string;
  tenders: string[];
  originalPlan: string;
  reference: { documentId: string; fileId: string };
}

/**
 * 新建项目，导入两份招标文件并写入解析结果，上传原方案，多标段识别出两个标段并选择第一个，保存招标解析配置、生成配置
 * （引用一个知识库文档、选一个组织模板），写入招标解析结果。
 */
async function fillProject(member: Member): Promise<Filled> {
  const projectId = await newProject(member);
  const tenders = [await newFile(member, { name: '招标A.docx' }), await newFile(member, { name: '招标B.pdf' })];
  await importTenderFiles(appDb, member.context, projectId, tenders);
  await parsed(member, projectId, tenders[0]!, '# 公告\n一标段要求\n');
  await parsed(member, projectId, tenders[1]!, '二标段要求');
  const originalPlan = await newFile(member, { name: '原方案.docx' });
  await setOriginalPlan(appDb, member.context, projectId, originalPlan);
  await prepareBidSectionExtraction(appDb, member.context, projectId);
  await saveBidSectionExtraction(appDb, member.context, projectId, { status: 'success', sections: SECTIONS });
  await selectBidSection(appDb, member.context, projectId, 's1', memoryStore);
  await saveBidAnalysisConfig(appDb, member.context, projectId, { mode: 'custom', selectedTaskIds: ['agentInfo'] });
  const reference = await newKnowledgeDocument(member);
  await saveGenerationConfig(appDb, member.context, projectId, {
    referenceKnowledgeDocumentIds: [reference.documentId],
    exportTemplateId: await newTemplate(member),
    outlineMode: 'response-file',
  });
  await saveBidItems(appDb, member.context, projectId, {
    projectOverview: { status: 'success', content: '概述' },
    agentInfo: { status: 'running' },
  });
  await updateStep(appDb, member.context, projectId, 'bid-analysis');
  return { projectId, tenders, originalPlan, reference };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
    await syncSystemTemplates(owner);
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  const systemTemplates = await superuser.selectFrom('export_templates').select(['id', 'system_key']).where('org_id', 'is', null).execute();
  standardTemplateId = systemTemplates.find((row: { system_key: string }) => row.system_key === DEFAULT_EXPORT_TEMPLATE_KEY)!.id;
  otherSystemTemplateId = systemTemplates.find((row: { system_key: string }) => row.system_key !== DEFAULT_EXPORT_TEMPLATE_KEY)!.id;
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
    technical_plan_meta: 'project_id',
    technical_plan_documents: 'file_id',
    technical_plan_generation_config: 'project_id',
    technical_plan_generation_bid_tasks: 'task_id',
    technical_plan_generation_reference_docs: 'document_id',
    technical_plan_bid_items: 'item_id',
  };
  // 页面状态、生成配置、文档的解析结果、解析项的结果按字段更新；选中的解析项和引用的知识库文档整体替换，不授予 UPDATE。
  const updates: Record<string, Record<string, unknown>> = {
    technical_plan_meta: { step: 'bid-analysis' },
    technical_plan_documents: { status: 'running' },
    technical_plan_generation_config: { outline_mode: 'response-file' },
    technical_plan_bid_items: { status: 'running' },
  };

  for (const table of TECHNICAL_PLAN_TABLES) {
    describeProjectTable(
      {
        table,
        idColumn: ids[table]!,
        projectKind: 'technical-plan',
        insert: (trx, scope) => ROW_WRITERS[table](trx, scope),
        // 文档：项目物理删除被文件（files.project_id，不级联）挡住，要先由清理任务删除文件。
        onProjectDelete: table === 'technical_plan_documents' ? 'restrict' : 'cascade',
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

  it('所属项目软删除后六张表都查不到、改不了、删不掉，恢复项目即一起恢复', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    const before = await adminCounts(filled.projectId);
    expect(before).toEqual({
      technical_plan_meta: 1,
      technical_plan_documents: 3,
      technical_plan_generation_config: 1,
      technical_plan_generation_bid_tasks: 7,
      technical_plan_generation_reference_docs: 1,
      technical_plan_bid_items: 2,
    });
    expect(await visibleCounts(member)).toEqual(before);

    await softDeleteProject(filled.projectId, member.userId);
    expect(await visibleCounts(member)).toEqual(zeroCounts());
    await withTenant(appDb, member.context, async (trx) => {
      const any = trx as unknown as Kysely<any>;
      expect((await any.updateTable('technical_plan_meta').set({ step: 'expand' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.updateTable('technical_plan_documents').set({ status: 'error' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.updateTable('technical_plan_generation_config').set({ layout_check: true }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.updateTable('technical_plan_bid_items').set({ content: '' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.deleteFrom('technical_plan_bid_items').executeTakeFirst()).numDeletedRows).toBe(0n);
      expect((await any.deleteFrom('technical_plan_generation_bid_tasks').executeTakeFirst()).numDeletedRows).toBe(0n);
      expect((await any.deleteFrom('technical_plan_generation_reference_docs').executeTakeFirst()).numDeletedRows).toBe(0n);
    });
    // 已删除的项目下不能新写。
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx.insertInto('technical_plan_bid_items').values({ org_id: member.orgId, project_id: filled.projectId, item_id: 'keyInfo', label: '投标关键节点' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await adminCounts(filled.projectId)).toEqual(before);

    await restoreProject(filled.projectId);
    expect(await visibleCounts(member)).toEqual(before);
  });

  it('文档的原件进回收站后文档行不可见，其他行不受影响；恢复文件即一起恢复', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    const before = await visibleCounts(member);
    await softDeleteFile(filled.tenders[1]!, member.userId);
    await softDeleteFile(filled.originalPlan, member.userId);
    expect(await visibleCounts(member)).toEqual({ ...before, technical_plan_documents: 1 });
    const state = await loadTechnicalPlan(appDb, member.context, filled.projectId);
    expect(state.tenderFiles.map((file) => file.id)).toEqual([filled.tenders[0]]);
    expect(state.originalPlanFile).toBeNull();
    await restoreFile(filled.tenders[1]!);
    await restoreFile(filled.originalPlan);
    expect(await visibleCounts(member)).toEqual(before);
  });

  it('引用的知识库文档不可见（原件进回收站）时引用行同样不可见、不能新引用；文档删除时引用行级联删除', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    await softDeleteFile(filled.reference.fileId, member.userId);
    expect((await visibleCounts(member)).technical_plan_generation_reference_docs).toBe(0);
    expect((await loadTechnicalPlan(appDb, member.context, filled.projectId)).referenceKnowledgeDocumentIds).toEqual([]);
    const other = await newProject(member);
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx
          .insertInto('technical_plan_generation_reference_docs')
          .values({ org_id: member.orgId, project_id: other, document_id: filled.reference.documentId })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await restoreFile(filled.reference.fileId);
    expect((await loadTechnicalPlan(appDb, member.context, filled.projectId)).referenceKnowledgeDocumentIds).toEqual([filled.reference.documentId]);
    await superuser.deleteFrom('knowledge_documents').where('id', '=', filled.reference.documentId).execute();
    expect((await adminCounts(filled.projectId)).technical_plan_generation_reference_docs).toBe(0);
  });

  it('不能引用其他组织的知识库文档', async () => {
    const projectId = await newProject(a);
    const { documentId } = await newKnowledgeDocument(b);
    await expect(
      withTenant(appDb, a.context, (trx) =>
        trx.insertInto('technical_plan_generation_reference_docs').values({ org_id: a.orgId, project_id: projectId, document_id: documentId }).execute(),
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it('导出模板只能是本组织的模板或系统模板；模板删除时只清空 export_template_id', async () => {
    const projectId = await newProject(a);
    const write = (templateId: string | null) =>
      withTenant(appDb, a.context, (trx) =>
        trx
          .insertInto('technical_plan_generation_config')
          .values({ org_id: a.orgId, project_id: projectId, export_template_id: templateId })
          .onConflict((oc) => oc.column('project_id').doUpdateSet({ export_template_id: templateId }))
          .execute(),
      );
    await write(otherSystemTemplateId);
    const own = await newTemplate(a);
    await write(own);
    await expect(write(await newTemplate(b))).rejects.toThrow(/row-level security/);
    // 不存在的模板：策略中的 EXISTS 先不成立（外键同样会拒绝）。
    await expect(write(randomUUID())).rejects.toThrow(/row-level security|foreign key/);
    // 已存的行改成其他组织的模板同样被 UPDATE 策略拒绝。
    await expect(
      withTenant(appDb, a.context, async (trx) =>
        trx.updateTable('technical_plan_generation_config').set({ export_template_id: await newTemplate(b) }).where('project_id', '=', projectId).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await withTenant(appDb, a.context, (trx) => trx.deleteFrom('export_templates').where('id', '=', own).execute());
    const row = await superuser.selectFrom('technical_plan_generation_config').select(['export_template_id', 'outline_mode']).where('project_id', '=', projectId).executeTakeFirstOrThrow();
    expect(row).toEqual({ export_template_id: null, outline_mode: 'standalone-technical' });
  });

  it('文件被清理任务物理删除时文档行级联删除；项目随后可以物理删除', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    await superuser.deleteFrom('artifacts').where('org_id', '=', member.orgId).execute();
    await superuser.deleteFrom('files').where('project_id', '=', filled.projectId).execute();
    expect((await adminCounts(filled.projectId)).technical_plan_documents).toBe(0);
    await superuser.deleteFrom('projects').where('id', '=', filled.projectId).execute();
    expect(await adminCounts(filled.projectId)).toEqual(zeroCounts());
  });

  it('只能挂在技术方案项目下：其他 kind 的项目下写不进任何一张表', async () => {
    const projectId = await newProject(a, 'feasibility-report');
    const scope = { orgId: a.orgId, userId: a.userId, projectId };
    for (const table of TECHNICAL_PLAN_TABLES) {
      await expect(
        withTenant(appDb, a.context, (trx) => ROW_WRITERS[table](trx as unknown as Transaction<any>, scope)),
        table,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it('只能登记本组织已上传、未删除、用途是 tender、已挂到本项目的文件；新文档一律待解析', async () => {
    const projectId = await newProject(a);
    const other = await newProject(a);
    const insert = (fileId: string, extra: Record<string, unknown> = {}) =>
      withTenant(appDb, a.context, (trx) =>
        (trx as unknown as Kysely<any>)
          .insertInto('technical_plan_documents')
          .values({ file_id: fileId, org_id: a.orgId, project_id: projectId, role: 'tender', ...extra })
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
    await expect(insert(fine, { role: 'bid' })).rejects.toThrow(/check constraint/);
    await insert(fine);
    // 同一文件不能再登记（例如同时作为原方案）。
    await expect(insert(fine, { role: 'original-plan' })).rejects.toThrow(/duplicate key/);
    const row = await superuser.selectFrom('technical_plan_documents').select('status').where('file_id', '=', fine).executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
  });

  it('解析出的 Markdown 只能是本文档原件的 Markdown 产物', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const fileA = await newFile(member);
    const fileB = await newFile(member);
    await importTenderFiles(appDb, member.context, projectId, [fileA, fileB]);
    const setMarkdown = (artifactId: string) =>
      withTenant(appDb, member.context, (trx) => trx.updateTable('technical_plan_documents').set({ markdown_artifact_id: artifactId }).where('file_id', '=', fileA).execute());
    for (const artifactId of [
      await newArtifact(member, { kind: 'markdown', sourceFileId: fileB }), // 其他文件的
      await newArtifact(member, { kind: 'image', sourceFileId: fileA }), // 不是 Markdown
      await newArtifact(member, { kind: 'markdown', sourceFileId: fileA, status: 'writing' }), // 未写完
    ]) {
      await expect(setMarkdown(artifactId)).rejects.toThrow(/row-level security/);
    }
    await setMarkdown(await newArtifact(member, { kind: 'markdown', sourceFileId: fileA }));
  });

  it('页面状态、文档、生成配置没有 DELETE 授权，选中的解析项与引用没有 UPDATE 授权；归属列和文档的角色、顺序写入后不能改', async () => {
    const privileges = await sql<{ table: string; del: boolean; upd: boolean }>`
      SELECT t AS table, has_table_privilege(${APP_ROLE}, t, 'DELETE') AS del, has_any_column_privilege(${APP_ROLE}, t, 'UPDATE') AS upd
      FROM unnest(${sql.val([...TECHNICAL_PLAN_TABLES])}::text[]) AS t ORDER BY t`.execute(superuser);
    const byTable = Object.fromEntries(privileges.rows.map((row) => [row.table, row]));
    expect(byTable.technical_plan_meta).toMatchObject({ del: false, upd: true });
    expect(byTable.technical_plan_documents).toMatchObject({ del: false, upd: true });
    expect(byTable.technical_plan_generation_config).toMatchObject({ del: false, upd: true });
    expect(byTable.technical_plan_generation_bid_tasks).toMatchObject({ del: true, upd: false });
    expect(byTable.technical_plan_generation_reference_docs).toMatchObject({ del: true, upd: false });
    expect(byTable.technical_plan_bid_items).toMatchObject({ del: true, upd: true });
    for (const [table, column] of [
      ['technical_plan_meta', 'project_id'],
      ['technical_plan_meta', 'org_id'],
      ['technical_plan_documents', 'file_id'],
      ['technical_plan_documents', 'project_id'],
      ['technical_plan_documents', 'role'],
      ['technical_plan_documents', 'sort_order'],
      ['technical_plan_generation_config', 'project_id'],
      ['technical_plan_bid_items', 'item_id'],
      ['technical_plan_bid_items', 'project_id'],
    ] as const) {
      const result = await sql<{ ok: boolean }>`SELECT has_column_privilege(${APP_ROLE}, ${table}, ${column}, 'UPDATE') AS ok`.execute(superuser);
      expect(result.rows[0]!.ok, `${table}.${column}`).toBe(false);
    }
  });

  it('取值与长度由 CHECK 约束挡住', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const insert = (table: string, values: Record<string, unknown>) =>
      withTenant(appDb, member.context, (trx) =>
        (trx as unknown as Kysely<any>)
          .insertInto(table)
          .values({ org_id: member.orgId, project_id: projectId, ...values })
          .execute(),
      );
    const cases: [string, Record<string, unknown>][] = [
      ['technical_plan_meta', { step: 'done' }],
      ['technical_plan_meta', { bid_section_extraction_status: 'paused' }],
      ['technical_plan_meta', { bid_sections: '{}' }],
      ['technical_plan_meta', { selected_section_id: '' }],
      ['technical_plan_generation_config', { bid_analysis_mode: 'all' }],
      ['technical_plan_generation_config', { outline_mode: 'x' }],
      ['technical_plan_generation_config', { image_quantity: 15 }],
      ['technical_plan_generation_config', { minimum_words: -1 }],
      ['technical_plan_generation_config', { html_image_types: '' }],
      ['technical_plan_generation_config', { export_template_scope: 'page' }],
      ['technical_plan_generation_bid_tasks', { task_id: 'unknown' }],
      ['technical_plan_bid_items', { item_id: 'unknown', label: 'x' }],
      ['technical_plan_bid_items', { item_id: 'keyInfo', label: '' }],
      ['technical_plan_bid_items', { item_id: 'keyInfo', label: 'x', status: 'done' }],
    ];
    for (const [table, values] of cases) {
      await expect(insert(table, values), `${table} ${JSON.stringify(values)}`).rejects.toThrow(/check constraint/);
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

  const DEFAULT_CONFIG = () => ({
    bidAnalysisMode: 'key',
    bidAnalysisSelectedTaskIds: REQUIRED_TASKS,
    bidSectionMode: 'single',
    outlineMode: 'standalone-technical',
    outlineExpansionMode: 'ai-complement',
    outlineWordControlOptions: { minimumWords: 0, maximumWords: 0, sectionWords: 0 },
    referenceKnowledgeDocumentIds: [],
    globalFactsMode: 'fabricate',
    exportTemplateId: standardTemplateId,
    exportTemplateScope: 'ai-only',
    contentGenerationOptions: DEFAULT_CONTENT_OPTIONS,
  });

  it('没写过时返回默认状态（导出模板默认是系统模板“标准投标”），不预先插入行', async () => {
    const projectId = await newProject(a);
    expect(await loadTechnicalPlan(appDb, a.context, projectId)).toEqual({
      step: 'document-analysis',
      tenderFiles: [],
      originalPlanFile: null,
      selectedSection: null,
      projectOverview: '',
      techRequirements: '',
      ...DEFAULT_CONFIG(),
      bidAnalysisTasks: {},
      bidAnalysisProgress: 0,
      bidSections: [],
      bidSectionExtractionStatus: 'idle',
      bidSectionExtractionError: null,
      bidSectionExtractionTask: null,
      bidAnalysisTask: null,
    });
    expect(await adminCounts(projectId)).toEqual(zeroCounts());
  });

  it('完整状态；组织内其他成员看到同样的状态，其他组织的成员看不到任何行', async () => {
    const filled = await fillProject(a);
    const state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state).toMatchObject({
      step: 'bid-analysis',
      selectedSection: { id: 's1', title: '一标段' },
      projectOverview: '概述',
      techRequirements: '',
      bidAnalysisMode: 'custom',
      bidAnalysisSelectedTaskIds: [...REQUIRED_TASKS, 'agentInfo'],
      bidSectionMode: 'multiple',
      outlineMode: 'response-file',
      referenceKnowledgeDocumentIds: [filled.reference.documentId],
      bidSectionExtractionStatus: 'success',
      bidAnalysisProgress: 14,
    });
    expect(state.tenderFiles.map((file) => [file.id, file.fileName, file.status])).toEqual([
      [filled.tenders[0], '招标A.docx', 'success'],
      [filled.tenders[1], '招标B.pdf', 'success'],
    ]);
    expect(state.originalPlanFile).toMatchObject({ id: filled.originalPlan, fileName: '原方案.docx', status: 'pending', markdownArtifactId: null });
    expect(state.bidSections.map((section) => section.id)).toEqual(['s1', 's2']);
    expect(state.bidAnalysisTasks).toEqual({
      projectOverview: { id: 'projectOverview', label: '项目概述', status: 'success', content: '概述', error: null },
      agentInfo: { id: 'agentInfo', label: '代理机构信息', status: 'running', content: '', error: null },
    });
    expect(await loadTechnicalPlan(appDb, peer.context, filled.projectId)).toEqual(state);
    expect(await visibleCounts(b)).toEqual(zeroCounts());
  });

  it('切换步骤', async () => {
    const projectId = await newProject(a);
    expect(await updateStep(appDb, a.context, projectId, 'content-edit')).toEqual({ step: 'content-edit' });
    expect((await loadTechnicalPlan(appDb, a.context, projectId)).step).toBe('content-edit');
  });

  it('生成配置：局部保存，只替换给出的字段；字数控制与正文生成选项按桌面版整理', async () => {
    const projectId = await newProject(a);
    let state = await saveGenerationConfig(appDb, a.context, projectId, { globalFactsMode: 'placeholder', exportTemplateScope: 'document' });
    expect(state).toMatchObject({ ...DEFAULT_CONFIG(), globalFactsMode: 'placeholder', exportTemplateScope: 'document' });
    state = await saveGenerationConfig(appDb, a.context, projectId, {
      outlineWordControlOptions: { minimumWords: 1000.7, maximumWords: -5 },
      contentGenerationOptions: { useAiImages: false, imageQuantity: 50, htmlImageTypes: '' },
      exportTemplateId: null,
    });
    expect(state).toMatchObject({
      globalFactsMode: 'placeholder',
      outlineWordControlOptions: { minimumWords: 1000, maximumWords: 0, sectionWords: 0 },
      contentGenerationOptions: { ...DEFAULT_CONTENT_OPTIONS, useAiImages: false, imageQuantity: 50 },
      exportTemplateId: null,
    });
    state = await saveGenerationConfig(appDb, a.context, projectId, { exportTemplateId: otherSystemTemplateId.toUpperCase() });
    expect(state.exportTemplateId).toBe(otherSystemTemplateId);
  });

  it('生成配置：其他组织的、不存在的模板，或引用其他组织的、不存在的、原件已删除的知识库文档时整体失败，原配置不变', async () => {
    const projectId = await newProject(a);
    const { documentId } = await newKnowledgeDocument(a);
    await saveGenerationConfig(appDb, a.context, projectId, { referenceKnowledgeDocumentIds: [documentId], outlineMode: 'response-file' });
    const before = await loadTechnicalPlan(appDb, a.context, projectId);
    await expectAppError(saveGenerationConfig(appDb, a.context, projectId, { exportTemplateId: await newTemplate(b), outlineMode: 'standalone-business' }), 400, 'TECHNICAL_PLAN_TEMPLATE_UNAVAILABLE');
    await expectAppError(saveGenerationConfig(appDb, a.context, projectId, { exportTemplateId: randomUUID() }), 400, 'TECHNICAL_PLAN_TEMPLATE_UNAVAILABLE');
    const trashed = await newKnowledgeDocument(a);
    await softDeleteFile(trashed.fileId, a.userId);
    for (const ids of [[(await newKnowledgeDocument(b)).documentId], [randomUUID()], [trashed.documentId], ['x']]) {
      await expectAppError(saveGenerationConfig(appDb, a.context, projectId, { referenceKnowledgeDocumentIds: ids, outlineMode: 'standalone-business' }), 400, 'TECHNICAL_PLAN_REFERENCE_UNAVAILABLE');
    }
    expect(await loadTechnicalPlan(appDb, a.context, projectId)).toEqual(before);
  });

  it('切换单 / 多标段：清空招标解析结果、引用、正文生成选项、标段识别结果与投标范围，步骤回到招标解析；不切换时不清空', async () => {
    const filled = await fillProject(a);
    await saveContentGenerationOptions(appDb, a.context, filled.projectId, { layoutCheck: true });
    let state = await saveGenerationConfig(appDb, a.context, filled.projectId, { globalFactsMode: 'omit', bidSectionMode: 'multiple' });
    expect(state).toMatchObject({ bidSectionMode: 'multiple', globalFactsMode: 'omit', selectedSection: { id: 's1' }, projectOverview: '概述' });
    expect(state.contentGenerationOptions.layoutCheck).toBe(true);
    state = await saveGenerationConfig(appDb, a.context, filled.projectId, { bidSectionMode: 'single' });
    expect(state).toMatchObject({
      step: 'bid-analysis',
      bidSectionMode: 'single',
      bidAnalysisTasks: {},
      projectOverview: '',
      referenceKnowledgeDocumentIds: [],
      contentGenerationOptions: DEFAULT_CONTENT_OPTIONS,
      bidSections: [],
      bidSectionExtractionStatus: 'idle',
      selectedSection: null,
      // 其他配置保留。
      bidAnalysisMode: 'custom',
      globalFactsMode: 'omit',
      outlineMode: 'response-file',
    });
    expect(state.tenderFiles).toHaveLength(2);
  });

  it('招标解析配置：必选项总是选中，按模式整理；可同时切换单 / 多标段', async () => {
    const projectId = await newProject(a);
    let state = await saveBidAnalysisConfig(appDb, a.context, projectId, { mode: 'key', selectedTaskIds: ['keyInfo'] });
    expect(state).toMatchObject({ bidAnalysisMode: 'custom', bidAnalysisSelectedTaskIds: [...REQUIRED_TASKS, 'keyInfo'] });
    state = await saveBidAnalysisConfig(appDb, a.context, projectId, { mode: 'full', selectedTaskIds: [], bidSectionMode: 'multiple' });
    expect(state).toMatchObject({ bidAnalysisMode: 'full', bidAnalysisSelectedTaskIds: [...TECHNICAL_PLAN_BID_ITEM_IDS], bidSectionMode: 'multiple', step: 'bid-analysis' });
    state = await saveBidAnalysisConfig(appDb, a.context, projectId, { mode: 'key', selectedTaskIds: [] });
    expect(state).toMatchObject({ bidAnalysisMode: 'key', bidAnalysisSelectedTaskIds: REQUIRED_TASKS, bidSectionMode: 'multiple' });
  });

  it('正文生成选项：整份替换，未给出的字段取默认值', async () => {
    const projectId = await newProject(a);
    await saveContentGenerationOptions(appDb, a.context, projectId, { wordCountRepair: true, tableRequirement: 'light' });
    const state = await saveContentGenerationOptions(appDb, a.context, projectId, { useHtmlImages: false });
    expect(state.contentGenerationOptions).toEqual({ ...DEFAULT_CONTENT_OPTIONS, useHtmlImages: false });
  });

  it('导入招标文件：追加，新文件挂到项目、待解析，已导入的跳过；有新文件时清空下游、生成配置恢复默认值', async () => {
    const filled = await fillProject(a);
    const added = await newFile(a, { name: '补遗.docx' });
    const result = await importTenderFiles(appDb, a.context, filled.projectId, [filled.tenders[0]!, added]);
    expect(result).toMatchObject({ addedCount: 1, skippedCount: 1 });
    expect(result.state.tenderFiles.map((file) => [file.id, file.status])).toEqual([
      [filled.tenders[0], 'success'],
      [filled.tenders[1], 'success'],
      [added, 'pending'],
    ]);
    expect(result.state).toMatchObject({
      step: 'document-analysis',
      ...DEFAULT_CONFIG(),
      bidAnalysisTasks: {},
      bidSections: [],
      selectedSection: null,
      originalPlanFile: { id: filled.originalPlan },
    });
    const file = await superuser.selectFrom('files').select(['project_id', 'deleted_at']).where('id', '=', added).executeTakeFirstOrThrow();
    expect(file).toEqual({ project_id: filled.projectId, deleted_at: null });

    // 全部已导入：不做改动。
    await updateStep(appDb, a.context, filled.projectId, 'generation-settings');
    const skipped = await importTenderFiles(appDb, a.context, filled.projectId, [added, added.toUpperCase()]);
    expect(skipped).toMatchObject({ addedCount: 0, skippedCount: 1, state: { step: 'generation-settings' } });
  });

  it('导入招标文件：文件不可用或超过上限时整体失败，不改动已有文档', async () => {
    const projectId = await newProject(a);
    const first = await newFile(a);
    await importTenderFiles(appDb, a.context, projectId, [first]);
    await updateStep(appDb, a.context, projectId, 'bid-analysis');
    const before = await loadTechnicalPlan(appDb, a.context, projectId);
    const originalPlan = await newFile(a);
    await setOriginalPlan(appDb, a.context, projectId, originalPlan);
    const trashed = await newFile(a);
    await softDeleteFile(trashed, a.userId);
    const unavailable = [
      await newFile(b), // 其他组织的
      await newFile(a, { purpose: 'knowledge' }),
      await newFile(a, { status: 'uploading' }),
      await newFile(a, { projectId: await newProject(a) }), // 属于其他项目
      trashed,
      originalPlan, // 已是原方案
      randomUUID(),
    ];
    for (const fileId of unavailable) {
      await expectAppError(importTenderFiles(appDb, a.context, projectId, [await newFile(a), fileId]), 400, 'TECHNICAL_PLAN_FILE_UNAVAILABLE');
    }
    const many = await Promise.all(Array.from({ length: TECHNICAL_PLAN_TENDER_FILES_MAX }, () => newFile(a)));
    await expectAppError(importTenderFiles(appDb, a.context, projectId, many), 400, 'TECHNICAL_PLAN_DOCUMENT_LIMIT');
    const after = await loadTechnicalPlan(appDb, a.context, projectId);
    expect({ ...after, originalPlanFile: null }).toEqual(before);
    // 失败时文件没有挂到项目。
    expect(await superuser.selectFrom('files').select('id').where('id', 'in', many).where('project_id', 'is not', null).execute()).toEqual([]);
  });

  it('移除招标文件：原件进回收站，同时清空下游；不存在时 404', async () => {
    const filled = await fillProject(a);
    const state = await removeTenderFile(appDb, a.context, filled.projectId, filled.tenders[0]!.toUpperCase());
    expect(state.tenderFiles.map((file) => file.id)).toEqual([filled.tenders[1]]);
    expect(state).toMatchObject({ step: 'document-analysis', bidAnalysisTasks: {}, selectedSection: null, ...DEFAULT_CONFIG() });
    expect(await fileDeleted(filled.tenders[0]!)).toBe(true);
    await expectAppError(removeTenderFile(appDb, a.context, filled.projectId, filled.tenders[0]!), 404, 'TECHNICAL_PLAN_DOCUMENT_NOT_FOUND');
    // 原方案不能经它移除。
    await expectAppError(removeTenderFile(appDb, a.context, filled.projectId, filled.originalPlan), 404, 'TECHNICAL_PLAN_DOCUMENT_NOT_FOUND');
  });

  it('原方案：替换时旧原件进回收站，不清空下游；重复上传同一文件不做改动；移除时目录扩展方式恢复为 ai-complement', async () => {
    const filled = await fillProject(a);
    await saveGenerationConfig(appDb, a.context, filled.projectId, { outlineExpansionMode: 'original-only' });
    const before = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    const replacement = await newFile(a, { name: '新原方案.docx' });
    let state = await setOriginalPlan(appDb, a.context, filled.projectId, replacement);
    expect(state.originalPlanFile).toMatchObject({ id: replacement, fileName: '新原方案.docx', status: 'pending' });
    expect(await fileDeleted(filled.originalPlan)).toBe(true);
    expect({ ...state, originalPlanFile: null }).toEqual({ ...before, originalPlanFile: null });
    expect(await setOriginalPlan(appDb, a.context, filled.projectId, replacement)).toEqual(state);
    // 从回收站恢复被替换的旧原方案时取最近导入的一份。
    await restoreFile(filled.originalPlan);
    expect((await loadTechnicalPlan(appDb, a.context, filled.projectId)).originalPlanFile?.id).toBe(replacement);
    await expectAppError(setOriginalPlan(appDb, a.context, filled.projectId, filled.tenders[0]!), 400, 'TECHNICAL_PLAN_FILE_UNAVAILABLE');

    state = await removeOriginalPlan(appDb, a.context, filled.projectId);
    expect(state).toMatchObject({ originalPlanFile: null, outlineExpansionMode: 'ai-complement', projectOverview: '概述' });
    expect(await fileDeleted(replacement)).toBe(true);
    expect(await fileDeleted(filled.originalPlan)).toBe(true);
    expect(await removeOriginalPlan(appDb, a.context, filled.projectId)).toEqual(state);
  });

  it('合并的招标正文：按导入顺序合并已解析的文件，按所选投标范围裁剪；没有招标文件时为空', async () => {
    const projectId = await newProject(a);
    expect(await readTenderMarkdown(appDb, a.context, projectId, memoryStore)).toBe('');
    const files = [await newFile(a), await newFile(a), await newFile(a)];
    await importTenderFiles(appDb, a.context, projectId, files);
    await parsed(a, projectId, files[0]!, '  # 公告\n一标段要求\n');
    await parsed(a, projectId, files[2]!, '二标段要求\n');
    // 第二份还没有解析，不在其中。
    expect(await readTenderMarkdown(appDb, a.context, projectId, memoryStore)).toBe('# 公告\n一标段要求\n\n二标段要求');
    await saveBidSectionExtraction(appDb, a.context, projectId, {
      status: 'success',
      sections: [
        { id: 's1', title: '一标段', includeRanges: [{ startLine: 2, endLine: 2 }] },
        { id: 's2', title: '二标段', includeRanges: [{ startLine: 4, endLine: 4 }] },
      ],
    });
    await selectBidSection(appDb, a.context, projectId, 's2', memoryStore);
    expect(await readTenderMarkdown(appDb, a.context, projectId, memoryStore)).toBe('# 公告\n\n二标段要求');
    await expectAppError(readTenderMarkdown(appDb, a.context, projectId, null), 503, 'FILE_STORAGE_DISABLED');
    // 按记录的大小判断，合计超过上限时不读取。
    const large = await newArtifact(a, { kind: 'markdown', sourceFileId: files[1]!, recordedSize: TECHNICAL_PLAN_MARKDOWN_READ_MAX_BYTES });
    await saveDocumentParse(appDb, a.context, projectId, files[1]!, { status: 'success', markdownArtifactId: large });
    await expectAppError(readTenderMarkdown(appDb, a.context, projectId, memoryStore), 422, 'TECHNICAL_PLAN_MARKDOWN_TOO_LARGE');
  });

  it('选择投标范围：需要至少两个标段；标段不存在、没有有效范围或正文为空时失败；成功后清空下游、切到多标段', async () => {
    const projectId = await newProject(a);
    const file = await newFile(a);
    await importTenderFiles(appDb, a.context, projectId, [file]);
    await expectAppError(selectBidSection(appDb, a.context, projectId, 's1', memoryStore), 409, 'TECHNICAL_PLAN_BID_SECTIONS_UNAVAILABLE');
    await saveBidSectionExtraction(appDb, a.context, projectId, {
      status: 'success',
      sections: [...SECTIONS, { id: 's3', title: '三标段', includeRanges: [] }],
    });
    await expectAppError(selectBidSection(appDb, a.context, projectId, 's1', memoryStore), 409, 'TECHNICAL_PLAN_TENDER_EMPTY');
    await parsed(a, projectId, file, '公告\n一标段\n二标段');
    await expectAppError(selectBidSection(appDb, a.context, projectId, 'missing', memoryStore), 400, 'TECHNICAL_PLAN_BID_SECTION_INVALID');
    await expectAppError(selectBidSection(appDb, a.context, projectId, 's3', memoryStore), 400, 'TECHNICAL_PLAN_BID_SECTION_INVALID');
    await saveBidItems(appDb, a.context, projectId, { projectOverview: { status: 'success', content: '概述' } });
    await saveContentGenerationOptions(appDb, a.context, projectId, { layoutCheck: true });
    const state = await selectBidSection(appDb, a.context, projectId, 's2', memoryStore);
    expect(state).toMatchObject({
      step: 'bid-analysis',
      selectedSection: { id: 's2', title: '二标段' },
      bidSectionMode: 'multiple',
      bidAnalysisTasks: {},
      contentGenerationOptions: DEFAULT_CONTENT_OPTIONS,
      bidSectionExtractionStatus: 'success',
    });
    expect(state.bidSections).toHaveLength(3);
    expect(await readTenderMarkdown(appDb, a.context, projectId, memoryStore)).toBe('公告\n二标段');
  });

  it('清空：删除招标解析结果、选中的解析项与引用，招标文件与原方案进回收站，页面状态与生成配置恢复默认值', async () => {
    const filled = await fillProject(a);
    expect(await clearTechnicalPlan(appDb, a.context, filled.projectId)).toEqual({ deletedFileCount: 3 });
    const state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state).toMatchObject({ step: 'document-analysis', tenderFiles: [], originalPlanFile: null, selectedSection: null, bidSections: [], bidAnalysisTasks: {}, ...DEFAULT_CONFIG() });
    expect(await adminCounts(filled.projectId)).toMatchObject({
      technical_plan_meta: 1,
      technical_plan_generation_config: 1,
      technical_plan_generation_bid_tasks: REQUIRED_TASKS.length,
      technical_plan_generation_reference_docs: 0,
      technical_plan_bid_items: 0,
    });
    for (const fileId of [...filled.tenders, filled.originalPlan]) expect(await fileDeleted(fileId)).toBe(true);
    // 没写过的项目清空时不插入行。
    const empty = await newProject(a);
    expect(await clearTechnicalPlan(appDb, a.context, empty)).toEqual({ deletedFileCount: 0 });
    expect(await adminCounts(empty)).toEqual(zeroCounts());
  });

  it('saveDocumentParse：只写给出的字段；产物不合规被拒绝；文档已移除时返回 false；参数不合法抛 TypeError', async () => {
    const projectId = await newProject(a);
    const [fileA, fileB] = [await newFile(a), await newFile(a)];
    await importTenderFiles(appDb, a.context, projectId, [fileA, fileB]);
    expect(await saveDocumentParse(appDb, a.context, projectId, fileA, { status: 'running' })).toBe(true);
    expect(await saveDocumentParse(appDb, a.context, projectId, fileA, { contentHash: 'h', parserLabel: 'x'.repeat(300), error: 'e\u0000rr', contentChars: -3 })).toBe(true);
    let document = (await loadTechnicalPlan(appDb, a.context, projectId)).tenderFiles[0]!;
    expect(document).toMatchObject({ status: 'running', contentHash: 'h', error: 'err', contentChars: 0 });
    expect(document.parserLabel).toHaveLength(200);
    await expect(saveDocumentParse(appDb, a.context, projectId, fileA, { markdownArtifactId: await newArtifact(a, { kind: 'markdown', sourceFileId: fileB }) })).rejects.toThrow(
      /row-level security/,
    );
    expect(await saveDocumentParse(appDb, a.context, projectId, fileA, {})).toBe(true);
    await expect(saveDocumentParse(appDb, a.context, projectId, 'x', {})).rejects.toThrow(TypeError);
    await expect(saveDocumentParse(appDb, a.context, projectId, fileA, { markdownArtifactId: 'x' })).rejects.toThrow(TypeError);
    await expect(saveDocumentParse(appDb, a.context, projectId, fileA, { contentHash: 'h'.repeat(201) })).rejects.toThrow(TypeError);
    await removeTenderFile(appDb, a.context, projectId, fileA);
    expect(await saveDocumentParse(appDb, a.context, projectId, fileA, { status: 'success' })).toBe(false);
    expect(await saveDocumentParse(appDb, a.context, projectId, fileA, {})).toBe(false);
    document = (await loadTechnicalPlan(appDb, a.context, projectId)).tenderFiles[0]!;
    expect(document.id).toBe(fileB);
  });

  it('saveBidItems：逐项覆盖写入，名称默认取任务列表，按任务列表排序；null 或空对象删除全部；未知的解析项抛 TypeError', async () => {
    const projectId = await newProject(a);
    await saveBidAnalysisConfig(appDb, a.context, projectId, { mode: 'key', selectedTaskIds: [] });
    await saveBidItems(appDb, a.context, projectId, {
      techRequirements: { status: 'success', content: '评分' },
      projectOverview: { status: 'error', error: '失败', label: '' },
      keyInfo: { status: 'success', content: 'x'.repeat(1_000_001), label: '自定义名称' },
    });
    let state = await loadTechnicalPlan(appDb, a.context, projectId);
    expect(Object.keys(state.bidAnalysisTasks)).toEqual(['projectOverview', 'techRequirements', 'keyInfo']);
    expect(state.bidAnalysisTasks.projectOverview).toEqual({ id: 'projectOverview', label: '项目概述', status: 'error', content: '', error: '失败' });
    expect(state.bidAnalysisTasks.keyInfo!.label).toBe('自定义名称');
    expect(state.bidAnalysisTasks.keyInfo!.content).toHaveLength(1_000_000);
    // 解析失败的项目概述不作为结果；进度只算选中的解析项。
    expect(state).toMatchObject({ projectOverview: '', techRequirements: '评分', bidAnalysisProgress: 33 });
    await saveBidItems(appDb, a.context, projectId, { projectOverview: { status: 'success', content: '概述' } });
    state = await loadTechnicalPlan(appDb, a.context, projectId);
    expect(state).toMatchObject({ projectOverview: '概述', techRequirements: '评分' });
    await expect(saveBidItems(appDb, a.context, projectId, { unknown: { status: 'success' } })).rejects.toThrow(TypeError);
    await saveBidItems(appDb, a.context, projectId, {});
    expect((await loadTechnicalPlan(appDb, a.context, projectId)).bidAnalysisTasks).toEqual({});
    await saveBidItems(appDb, a.context, projectId, { openBid: {} });
    await saveBidItems(appDb, a.context, projectId, null);
    expect((await loadTechnicalPlan(appDb, a.context, projectId)).bidAnalysisTasks).toEqual({});
  });

  it('多标段识别：开始时清空下游并切到多标段；结果按桌面版整理，只写给出的字段；过大的结果抛 TypeError', async () => {
    const filled = await fillProject(a);
    await prepareBidSectionExtraction(appDb, a.context, filled.projectId);
    let state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state).toMatchObject({ step: 'bid-analysis', bidSectionMode: 'multiple', bidSectionExtractionStatus: 'running', bidSections: [], selectedSection: null, bidAnalysisTasks: {} });
    await saveBidSectionExtraction(appDb, a.context, filled.projectId, { sections: [{ title: ' 甲 ', include_ranges: [{ start_line: 1, end_line: 2 }] }, { id: 'x' }] });
    await saveBidSectionExtraction(appDb, a.context, filled.projectId, { status: 'error', error: '识别失败' });
    state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state).toMatchObject({
      bidSectionExtractionStatus: 'error',
      bidSectionExtractionError: '识别失败',
      bidSections: [{ id: 'section-1', index: 1, unit: '标段', title: '甲', headLine: '', description: '', includeRanges: [{ startLine: 1, endLine: 2 }], evidence: [] }],
    });
    const huge = Array.from({ length: 100 }, (_, index) => ({ id: `s${index}`, title: '标', description: '说'.repeat(20_000) }));
    await expect(saveBidSectionExtraction(appDb, a.context, filled.projectId, { sections: huge })).rejects.toThrow(TypeError);
    await saveBidSectionExtraction(appDb, a.context, filled.projectId, { sections: null, error: null, status: 'idle' });
    expect(await loadTechnicalPlan(appDb, a.context, filled.projectId)).toMatchObject({ bidSections: [], bidSectionExtractionStatus: 'idle', bidSectionExtractionError: null });
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
    await expectError(await call(null, 'GET', tp(projectId)), 401, 'UNAUTHORIZED');
    await expectError(await call(b, 'GET', tp(projectId)), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(a, 'GET', tp(await newProject(a, 'rejection-check'))), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(b, 'PATCH', tp(projectId, '/step'), { step: 'expand' }), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(b, 'GET', tp(projectId, '/tender-markdown')), 404, 'PROJECT_NOT_FOUND');
    await softDeleteProject(projectId, a.userId);
    await expectError(await call(a, 'GET', tp(projectId)), 404, 'PROJECT_NOT_FOUND');
  });

  it('完整流程：招标文件、原方案、配置、标段、步骤、清空', async () => {
    const projectId = await newProject(a);
    let response = await call(a, 'GET', tp(projectId));
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ step: 'document-analysis', tenderFiles: [], exportTemplateId: standardTemplateId, bidAnalysisTask: null });

    const tender = await newFile(a, { name: '招标.docx' });
    response = await call(a, 'POST', tp(projectId, '/tender-files'), { fileIds: [tender] });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ addedCount: 1, skippedCount: 0 });
    expect(response.json().state.tenderFiles[0]).toMatchObject({ id: tender, fileName: '招标.docx', status: 'pending' });
    await parsed(a, projectId, tender, '公告\n一标段\n二标段');

    const original = await newFile(a, { name: '原方案.docx' });
    response = await call(a, 'PUT', tp(projectId, '/original-plan'), { fileId: original });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().originalPlanFile).toMatchObject({ id: original, status: 'pending' });

    const { documentId } = await newKnowledgeDocument(a);
    response = await call(a, 'PATCH', tp(projectId, '/generation-config'), {
      referenceKnowledgeDocumentIds: [documentId],
      exportTemplateId: otherSystemTemplateId,
      outlineWordControlOptions: { minimumWords: 10000, maximumWords: 20000, sectionWords: 800 },
      outlineExpansionMode: 'original-only',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      referenceKnowledgeDocumentIds: [documentId],
      exportTemplateId: otherSystemTemplateId,
      outlineWordControlOptions: { minimumWords: 10000, maximumWords: 20000, sectionWords: 800 },
    });

    response = await call(a, 'PUT', tp(projectId, '/bid-analysis-config'), { mode: 'custom', selectedTaskIds: ['openBid'] });
    expect(response.json()).toMatchObject({ bidAnalysisMode: 'custom', bidAnalysisSelectedTaskIds: [...REQUIRED_TASKS, 'openBid'] });

    response = await call(a, 'PUT', tp(projectId, '/content-options'), { contentGenerationOptions: { imageQuantity: 0, tableRequirement: 'none' } });
    expect(response.json().contentGenerationOptions).toEqual({ ...DEFAULT_CONTENT_OPTIONS, imageQuantity: 0, tableRequirement: 'none' });

    await expectError(await call(a, 'PUT', tp(projectId, '/bid-section'), { sectionId: 's1' }), 409, 'TECHNICAL_PLAN_BID_SECTIONS_UNAVAILABLE');
    await saveBidSectionExtraction(appDb, a.context, projectId, { status: 'success', sections: SECTIONS });
    response = await call(a, 'PUT', tp(projectId, '/bid-section'), { sectionId: 's1' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ selectedSection: { id: 's1', title: '一标段' }, bidSectionMode: 'multiple', referenceKnowledgeDocumentIds: [] });
    response = await call(a, 'GET', tp(projectId, '/tender-markdown'));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('公告\n一标段\n');
    expect(response.headers).toMatchObject({ 'content-type': 'text/markdown; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    expect(String(response.headers['content-disposition'])).toMatch(/^attachment;/);
    await expectError(await call(a, 'GET', tp(projectId, '/tender-markdown'), undefined, noStorageApp), 503, 'FILE_STORAGE_DISABLED');

    response = await call(a, 'PATCH', tp(projectId, '/step'), { step: 'outline-generation' });
    expect(response.json()).toEqual({ step: 'outline-generation' });

    response = await call(a, 'DELETE', tp(projectId, '/original-plan'));
    expect(response.json()).toMatchObject({ originalPlanFile: null, outlineExpansionMode: 'ai-complement' });

    response = await call(a, 'DELETE', tp(projectId, `/tender-files/${tender}`));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ tenderFiles: [], step: 'document-analysis', selectedSection: null });
    await expectError(await call(a, 'DELETE', tp(projectId, `/tender-files/${tender}`)), 404, 'TECHNICAL_PLAN_DOCUMENT_NOT_FOUND');
    response = await call(a, 'GET', tp(projectId, '/tender-markdown'));
    expect(response.body).toBe('');

    response = await call(a, 'DELETE', tp(projectId));
    expect(response.json()).toEqual({ deletedFileCount: 0 });
    expect((await call(a, 'GET', tp(projectId))).json()).toMatchObject({ step: 'document-analysis', bidSectionMode: 'single', contentGenerationOptions: DEFAULT_CONTENT_OPTIONS });
  });

  it('请求体校验：未声明字段、取值不合法、缺少字段一律 400', async () => {
    const projectId = await newProject(a);
    const cases: [Method, string, object][] = [
      ['PATCH', '/step', { step: 'done' }],
      ['PATCH', '/generation-config', { apiKey: 'k' }],
      ['PATCH', '/generation-config', { bidSectionMode: 'many' }],
      ['PATCH', '/generation-config', { bidAnalysisSelectedTaskIds: ['unknown'] }],
      ['PATCH', '/generation-config', { exportTemplateId: 'tpl-system-standard-bid' }],
      ['PATCH', '/generation-config', { referenceKnowledgeDocumentIds: ['x'] }],
      ['PATCH', '/generation-config', { outlineWordControlOptions: { minimumWords: -1 } }],
      ['PATCH', '/generation-config', { outlineWordControlOptions: { enabled: true } }],
      ['PATCH', '/generation-config', { contentGenerationOptions: { imageQuantity: 15 } }],
      ['PATCH', '/generation-config', { contentGenerationOptions: { htmlImageTypes: 'x'.repeat(2001) } }],
      ['PUT', '/bid-analysis-config', { mode: 'key' }],
      ['PUT', '/content-options', {}],
      ['POST', '/tender-files', { fileIds: [] }],
      ['POST', '/tender-files', { fileIds: ['x'] }],
      ['PUT', '/original-plan', {}],
      ['PUT', '/bid-section', { sectionId: '' }],
    ];
    for (const [method, path, payload] of cases) {
      const response = await call(a, method, tp(projectId, path), payload);
      expect(response.statusCode, `${method} ${path} ${response.body}`).toBe(400);
    }
    await expectError(await call(a, 'POST', tp(projectId, '/tender-files'), { fileIds: [await newFile(b)] }), 400, 'TECHNICAL_PLAN_FILE_UNAVAILABLE');
    await expectError(await call(a, 'PUT', tp(projectId, '/original-plan'), { fileId: await newFile(a, { purpose: 'knowledge' }) }), 400, 'TECHNICAL_PLAN_FILE_UNAVAILABLE');
    await expectError(await call(a, 'PATCH', tp(projectId, '/generation-config'), { exportTemplateId: await newTemplate(b) }), 400, 'TECHNICAL_PLAN_TEMPLATE_UNAVAILABLE');
    await expectError(await call(a, 'PATCH', tp(projectId, '/generation-config'), { referenceKnowledgeDocumentIds: [randomUUID()] }), 400, 'TECHNICAL_PLAN_REFERENCE_UNAVAILABLE');
  });

  it('招标文件的 Markdown：附件下载；还没有解析时为空；未配置对象存储时 503；文档不可见或不是招标文件时 404', async () => {
    const projectId = await newProject(a);
    const fileId = await newFile(a);
    await importTenderFiles(appDb, a.context, projectId, [fileId]);
    let response = await call(a, 'GET', tp(projectId, `/tender-files/${fileId}/markdown`));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    await parsed(a, projectId, fileId, '# 招标正文');
    response = await call(a, 'GET', tp(projectId, `/tender-files/${fileId}/markdown`));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('# 招标正文');
    expect(response.headers).toMatchObject({
      'content-type': 'text/markdown; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
    });
    expect(String(response.headers['content-disposition'])).toMatch(/^attachment;/);
    await expectError(await call(a, 'GET', tp(projectId, `/tender-files/${fileId}/markdown`), undefined, noStorageApp), 503, 'FILE_STORAGE_DISABLED');
    await expectError(await call(b, 'GET', tp(projectId, `/tender-files/${fileId}/markdown`)), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(a, 'GET', tp(projectId, `/tender-files/${randomUUID()}/markdown`)), 404, 'TECHNICAL_PLAN_DOCUMENT_NOT_FOUND');
    const original = await newFile(a);
    await setOriginalPlan(appDb, a.context, projectId, original);
    await expectError(await call(a, 'GET', tp(projectId, `/tender-files/${original}/markdown`)), 404, 'TECHNICAL_PLAN_DOCUMENT_NOT_FOUND');
    await softDeleteFile(fileId, a.userId);
    await expectError(await call(a, 'GET', tp(projectId, `/tender-files/${fileId}/markdown`)), 404, 'TECHNICAL_PLAN_DOCUMENT_NOT_FOUND');
  });
});
