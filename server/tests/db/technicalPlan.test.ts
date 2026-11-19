// 技术方案（迁移 0018_technical_plan、0019_technical_plan_outline、0020_technical_plan_content）的数据库与接口测试：十张表的隔离
// 模板（describeProjectTable，项目级），删除可见性与写权限由 RLS 强制（绕过 Store 直接写库同样被拒绝），招标文件与原方案、生成
// 配置（含导出模板、选中的解析项、引用的知识库文档）、单 / 多标段切换与投标范围、合并的招标正文、目录（reason 协议）与全局
// 事实、正文与正文生成状态（5.13）、下游清空、清空，给第 6、8 步任务用的写函数，废标检查从技术方案读取招标文件，以及全部接口。
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { TECHNICAL_PLAN_BID_ITEM_IDS, TECHNICAL_PLAN_DEFAULT_HTML_IMAGE_TYPES, TECHNICAL_PLAN_TABLES } from '../../src/db/migrations/0018_technical_plan.ts';
import { TECHNICAL_PLAN_OUTLINE_TABLES } from '../../src/db/migrations/0019_technical_plan_outline.ts';
import { TECHNICAL_PLAN_CONTENT_TABLES } from '../../src/db/migrations/0020_technical_plan_content.ts';
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
  resetContentGeneration,
  saveBidAnalysisConfig,
  saveBidItems,
  saveBidSectionExtraction,
  saveChapterContent,
  saveContentGenerationItem,
  saveContentGenerationOptions,
  saveContentGenerationRuntime,
  saveContentPlans,
  saveContentSections,
  saveDocumentParse,
  saveGeneratedOutline,
  saveGenerationConfig,
  saveGlobalFacts,
  saveOutline,
  selectBidSection,
  setOriginalPlan,
  TECHNICAL_PLAN_MARKDOWN_READ_MAX_BYTES,
  TECHNICAL_PLAN_TENDER_FILES_MAX,
  updateStep,
} from '../../src/technicalPlan/store.ts';
import {
  importDocuments as importRejectionDocuments,
  loadRejectionCheck,
  saveCheckResult as saveRejectionCheckResult,
  saveExtraction as saveRejectionExtraction,
} from '../../src/rejectionCheck/store.ts';
import { syncSystemTemplates } from '../../src/templates/system.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable, type ProjectRowScope } from './projectTable.ts';

const PASSWORD = 'quiet-harbor-maple-59';

/** 0018 的六张表、0019 与 0020 各两张表。 */
const ALL_TABLES = [...TECHNICAL_PLAN_TABLES, ...TECHNICAL_PLAN_OUTLINE_TABLES, ...TECHNICAL_PLAN_CONTENT_TABLES] as const;

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

const ROW_WRITERS: Record<(typeof ALL_TABLES)[number], (trx: Transaction<any>, scope: ProjectRowScope) => Promise<string>> = {
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
  async technical_plan_outline_nodes(trx, scope) {
    const nodeId = randomUUID();
    await trx.insertInto('technical_plan_outline_nodes').values({ ...base(scope), node_id: nodeId, level: 1, title: '第一章' }).execute();
    return nodeId;
  },
  async technical_plan_global_fact_groups(trx, scope) {
    const groupId = `fact_${randomUUID()}`;
    await trx.insertInto('technical_plan_global_fact_groups').values({ ...base(scope), group_id: groupId, title: '团队', content: '十人' }).execute();
    return groupId;
  },
  async technical_plan_content_sections(trx, scope) {
    const nodeId = await ROW_WRITERS.technical_plan_outline_nodes(trx, scope);
    await trx.insertInto('technical_plan_content_sections').values({ ...base(scope), node_id: nodeId, status: 'success' }).execute();
    return nodeId;
  },
  async technical_plan_content_plans(trx, scope) {
    const nodeId = await ROW_WRITERS.technical_plan_outline_nodes(trx, scope);
    await trx.insertInto('technical_plan_content_plans').values({ ...base(scope), node_id: nodeId, plan_version: 1, plan: '{}' }).execute();
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
  for (const table of ALL_TABLES) {
    const row = await superuser.selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).where('project_id', '=', projectId).executeTakeFirstOrThrow();
    counts[table] = Number((row as { n: string }).n);
  }
  return counts;
}

/** 每张表在应用角色下（成员上下文中、不带条件的全表查询）看到的行数。 */
async function visibleCounts(member: Member): Promise<Record<string, number>> {
  return withTenant(appDb, member.context, async (trx) => {
    const counts: Record<string, number> = {};
    for (const table of ALL_TABLES) {
      const row = await (trx as unknown as Kysely<any>).selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
      counts[table] = Number((row as { n: string }).n);
    }
    return counts;
  });
}

const zeroCounts = () => Object.fromEntries(ALL_TABLES.map((table) => [table, 0]));

const SECTIONS = [
  { id: 's1', title: '一标段', includeRanges: [{ startLine: 2, endLine: 2 }] },
  { id: 's2', title: '二标段', includeRanges: [{ startLine: 3, endLine: 3 }] },
];

interface Filled {
  projectId: string;
  tenders: string[];
  originalPlan: string;
  reference: { documentId: string; fileId: string };
  /** 目录的节点 id：[第一章, 1.1, 1.2, 第二章]。 */
  nodes: string[];
}

/** 一节正文编排（与桌面版 Renderer 的 ContentGenerationPlanData 相同）。 */
const PLAN = { image_suitability_score: 6, image_needed: true, knowledge: { item_ids: ['k1'] }, table: { needed: false, purpose: '' } };

/** 两章四个节点的目录（1.1、1.2 是叶子）。 */
function outlineOf(nodes: string[], extra: Record<string, unknown> = {}): { outline: any[]; [field: string]: unknown } {
  return {
    project_name: '示例项目',
    project_overview: '项目概述',
    ...extra,
    outline: [
      {
        id: nodes[0],
        title: '第一章',
        description: '总体',
        children: [
          { id: nodes[1], title: '1.1 节', description: '', content_mode: 'ai-generate', knowledge_item_ids: ['k1', 'k2'], source_requirement_id: 'r1' },
          { id: nodes[2], title: '1.2 节', description: '', content_mode: 'other', content_mode_note: '人工补充' },
        ],
      },
      { id: nodes[3], title: '第二章', description: '', content_mode: 'manual-fill' },
    ],
  };
}

/** 用超级用户直接写入各节正文（正文生成随 5.13、第 8 步）。 */
async function writeContents(projectId: string, contents: Record<string, string>): Promise<void> {
  for (const [nodeId, content] of Object.entries(contents)) {
    await superuser.updateTable('technical_plan_outline_nodes').set({ content }).where('project_id', '=', projectId).where('node_id', '=', nodeId).execute();
  }
}

/** 各节正文（超级用户读取）。 */
async function contentsOf(projectId: string): Promise<Record<string, string>> {
  const rows = await superuser.selectFrom('technical_plan_outline_nodes').select(['node_id', 'content']).where('project_id', '=', projectId).execute();
  return Object.fromEntries(rows.map((row: { node_id: string; content: string }) => [row.node_id, row.content]));
}

/**
 * 新建项目，导入两份招标文件并写入解析结果，上传原方案，多标段识别出两个标段并选择第一个，保存招标解析配置、生成配置
 * （引用一个知识库文档、选一个组织模板），写入招标解析结果，生成目录（带字数控制快照）和两组全局事实，写入两节正文。
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
  const nodes = Array.from({ length: 4 }, () => randomUUID());
  await saveGeneratedOutline(appDb, member.context, projectId, {
    outlineData: outlineOf(nodes),
    wordControlSnapshot: { minimumWords: 1000, maximumWords: 2000, sectionWords: 500 },
  });
  await saveGlobalFacts(appDb, member.context, projectId, [
    { id: 'team', title: '团队', content: '十人' },
    { id: 'schedule', title: '工期', content: '90 天' },
  ]);
  await writeContents(projectId, { [nodes[1]!]: '正文 1.1', [nodes[3]!]: '正文二' });
  await saveContentSections(appDb, member.context, projectId, { [nodes[1]!]: { status: 'success' } });
  await saveContentPlans(appDb, member.context, projectId, { [nodes[1]!]: { plan_version: 1, plan: PLAN, table_requirement: 'light' } });
  await saveContentGenerationRuntime(appDb, member.context, projectId, { generation_started: true, section_words: { [nodes[1]!]: 800 } });
  await updateStep(appDb, member.context, projectId, 'bid-analysis');
  return { projectId, tenders, originalPlan, reference, nodes };
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
    technical_plan_outline_nodes: 'node_id',
    technical_plan_global_fact_groups: 'group_id',
    technical_plan_content_sections: 'node_id',
    technical_plan_content_plans: 'node_id',
  };
  // 页面状态、生成配置、文档的解析结果、解析项的结果、目录节点按字段更新；选中的解析项、引用的知识库文档和全局事实整体替换，
  // 不授予 UPDATE。
  const updates: Record<string, Record<string, unknown>> = {
    technical_plan_meta: { step: 'bid-analysis' },
    technical_plan_documents: { status: 'running' },
    technical_plan_generation_config: { outline_mode: 'response-file' },
    technical_plan_bid_items: { status: 'running' },
    technical_plan_outline_nodes: { title: '改过的标题' },
    technical_plan_content_sections: { status: 'error' },
    technical_plan_content_plans: { plan_version: 2 },
  };

  for (const table of ALL_TABLES) {
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

  it('所属项目软删除后十张表都查不到、改不了、删不掉，恢复项目即一起恢复', async () => {
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
      technical_plan_outline_nodes: 4,
      technical_plan_global_fact_groups: 2,
      technical_plan_content_sections: 1,
      technical_plan_content_plans: 1,
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
      expect((await any.updateTable('technical_plan_outline_nodes').set({ content: '' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.deleteFrom('technical_plan_outline_nodes').executeTakeFirst()).numDeletedRows).toBe(0n);
      expect((await any.deleteFrom('technical_plan_global_fact_groups').executeTakeFirst()).numDeletedRows).toBe(0n);
      expect((await any.updateTable('technical_plan_content_sections').set({ status: 'error' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.deleteFrom('technical_plan_content_sections').executeTakeFirst()).numDeletedRows).toBe(0n);
      expect((await any.updateTable('technical_plan_content_plans').set({ plan_version: 9 }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.deleteFrom('technical_plan_content_plans').executeTakeFirst()).numDeletedRows).toBe(0n);
    });
    // 已删除的项目下不能新写。
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx.insertInto('technical_plan_bid_items').values({ org_id: member.orgId, project_id: filled.projectId, item_id: 'keyInfo', label: '投标关键节点' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx
          .insertInto('technical_plan_outline_nodes')
          .values({ org_id: member.orgId, project_id: filled.projectId, node_id: randomUUID(), level: 1, title: '新章' })
          .execute(),
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
    for (const table of ALL_TABLES) {
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

  it('页面状态、文档、生成配置没有 DELETE 授权，选中的解析项、引用与全局事实没有 UPDATE 授权；归属列、节点 id 和文档的角色、顺序写入后不能改', async () => {
    const privileges = await sql<{ table: string; del: boolean; upd: boolean }>`
      SELECT t AS table, has_table_privilege(${APP_ROLE}, t, 'DELETE') AS del, has_any_column_privilege(${APP_ROLE}, t, 'UPDATE') AS upd
      FROM unnest(${sql.val([...ALL_TABLES])}::text[]) AS t ORDER BY t`.execute(superuser);
    const byTable = Object.fromEntries(privileges.rows.map((row) => [row.table, row]));
    expect(byTable.technical_plan_meta).toMatchObject({ del: false, upd: true });
    expect(byTable.technical_plan_documents).toMatchObject({ del: false, upd: true });
    expect(byTable.technical_plan_generation_config).toMatchObject({ del: false, upd: true });
    expect(byTable.technical_plan_generation_bid_tasks).toMatchObject({ del: true, upd: false });
    expect(byTable.technical_plan_generation_reference_docs).toMatchObject({ del: true, upd: false });
    expect(byTable.technical_plan_bid_items).toMatchObject({ del: true, upd: true });
    expect(byTable.technical_plan_outline_nodes).toMatchObject({ del: true, upd: true });
    expect(byTable.technical_plan_global_fact_groups).toMatchObject({ del: true, upd: false });
    expect(byTable.technical_plan_content_sections).toMatchObject({ del: true, upd: true });
    expect(byTable.technical_plan_content_plans).toMatchObject({ del: true, upd: true });
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
      ['technical_plan_outline_nodes', 'org_id'],
      ['technical_plan_outline_nodes', 'project_id'],
      ['technical_plan_outline_nodes', 'node_id'],
      ['technical_plan_content_sections', 'org_id'],
      ['technical_plan_content_sections', 'project_id'],
      ['technical_plan_content_sections', 'node_id'],
      ['technical_plan_content_plans', 'org_id'],
      ['technical_plan_content_plans', 'project_id'],
      ['technical_plan_content_plans', 'node_id'],
    ] as const) {
      const result = await sql<{ ok: boolean }>`SELECT has_column_privilege(${APP_ROLE}, ${table}, ${column}, 'UPDATE') AS ok`.execute(superuser);
      expect(result.rows[0]!.ok, `${table}.${column}`).toBe(false);
    }
  });

  it('目录节点的父节点只能是同一项目的节点，不能以自己为父；删除父节点时子节点级联删除', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const other = await newProject(member);
    const insert = (project: string, nodeId: string, parent: string | null) =>
      withTenant(appDb, member.context, (trx) =>
        trx
          .insertInto('technical_plan_outline_nodes')
          .values({ org_id: member.orgId, project_id: project, node_id: nodeId, parent_node_id: parent, level: parent ? 2 : 1, title: '节' })
          .execute(),
      );
    const root = randomUUID();
    const child = randomUUID();
    await insert(projectId, root, null);
    await insert(projectId, child, root);
    await expect(insert(other, randomUUID(), root)).rejects.toThrow(/foreign key/);
    const self = randomUUID();
    await expect(insert(projectId, self, self)).rejects.toThrow(/check constraint|foreign key/);
    await withTenant(appDb, member.context, (trx) => trx.deleteFrom('technical_plan_outline_nodes').where('node_id', '=', root).execute());
    expect((await adminCounts(projectId)).technical_plan_outline_nodes).toBe(0);
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
      ['technical_plan_meta', { outline_word_control_snapshot: '[]' }],
      ['technical_plan_meta', { outline_project_name: '' }],
      ['technical_plan_outline_nodes', { node_id: randomUUID(), level: 0, title: 'x' }],
      ['technical_plan_outline_nodes', { node_id: randomUUID(), level: 11, title: 'x' }],
      ['technical_plan_outline_nodes', { node_id: randomUUID(), level: 2, title: 'x' }],
      ['technical_plan_outline_nodes', { node_id: randomUUID(), level: 1, title: '' }],
      ['technical_plan_outline_nodes', { node_id: randomUUID(), level: 1, title: 'x', content_mode: 'auto' }],
      ['technical_plan_outline_nodes', { node_id: randomUUID(), level: 1, title: 'x', content_mode: 'manual-fill', content_mode_note: '说明' }],
      ['technical_plan_outline_nodes', { node_id: randomUUID(), level: 1, title: 'x', knowledge_item_ids: '{}' }],
      ['technical_plan_outline_nodes', { node_id: randomUUID(), level: 1, title: 'x', source_requirement_id: '' }],
      ['technical_plan_global_fact_groups', { group_id: 'Team', title: 'x', content: 'y' }],
      ['technical_plan_global_fact_groups', { group_id: 'team', title: 'x', content: '' }],
      ['technical_plan_meta', { content_generation_runtime: '[]' }],
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
      bidSectionDetection: { hasMultiple: false, totalDeclared: null },
      bidSectionExtractionTask: null,
      bidAnalysisTask: null,
      outlineData: null,
      outlineWordControlSnapshot: null,
      globalFacts: [],
      outlineGenerationTask: null,
      outlineSelection: null,
      outlineAdjustmentTask: null,
      outlineAdjustment: null,
      outlineAdjustable: false,
      globalFactsTask: null,
      globalFactsAdjustmentTask: null,
      globalFactsAdjustment: null,
      globalFactsAdjustable: false,
      contentGenerationSections: {},
      contentGenerationPlans: {},
      contentGenerationRuntime: null,
      contentGenerationTask: null,
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
      // 仍是 running 的解析项没有对应的任务（6.11），按未完成显示，计入已结束的项。
      bidAnalysisProgress: 29,
    });
    expect(state.tenderFiles.map((file) => [file.id, file.fileName, file.status])).toEqual([
      [filled.tenders[0], '招标A.docx', 'success'],
      [filled.tenders[1], '招标B.pdf', 'success'],
    ]);
    expect(state.originalPlanFile).toMatchObject({ id: filled.originalPlan, fileName: '原方案.docx', status: 'pending', markdownArtifactId: null });
    expect(state.bidSections.map((section) => section.id)).toEqual(['s1', 's2']);
    expect(state.bidAnalysisTasks).toEqual({
      projectOverview: { id: 'projectOverview', label: '项目概述', status: 'success', content: '概述', error: null },
      agentInfo: { id: 'agentInfo', label: '代理机构信息', status: 'error', content: '', error: '上次招标文件解析未完成，请重新解析' },
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

  it('清空：删除招标解析结果、目录、全局事实、选中的解析项与引用，招标文件与原方案进回收站，页面状态与生成配置恢复默认值', async () => {
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
      technical_plan_outline_nodes: 0,
      technical_plan_global_fact_groups: 0,
    });
    expect(state).toMatchObject({ outlineData: null, outlineWordControlSnapshot: null, globalFacts: [] });
    for (const fileId of [...filled.tenders, filled.originalPlan]) expect(await fileDeleted(fileId)).toBe(true);
    // 没写过的项目清空时不插入行。
    const empty = await newProject(a);
    expect(await clearTechnicalPlan(appDb, a.context, empty)).toEqual({ deletedFileCount: 0 });
    expect(await adminCounts(empty)).toEqual(zeroCounts());
  });

  it('目录：完整状态带编号、正文与字数控制快照；组织内其他成员看到同样的目录', async () => {
    const filled = await fillProject(a);
    const [n0, n1, n2, n3] = filled.nodes;
    const state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state.outlineData).toEqual({
      project_name: '示例项目',
      project_overview: '项目概述',
      outline: [
        {
          id: n0,
          number: '1',
          title: '第一章',
          description: '总体',
          children: [
            {
              id: n1,
              number: '1.1',
              title: '1.1 节',
              description: '',
              content_mode: 'ai-generate',
              knowledge_item_ids: ['k1', 'k2'],
              source_requirement_id: 'r1',
              content: '正文 1.1',
            },
            { id: n2, number: '1.2', title: '1.2 节', description: '', content_mode: 'other', content_mode_note: '人工补充' },
          ],
        },
        { id: n3, number: '2', title: '第二章', description: '', content_mode: 'manual-fill', content: '正文二' },
      ],
    });
    expect(state.outlineWordControlSnapshot).toEqual({ minimumWords: 1000, maximumWords: 2000, sectionWords: 500 });
    expect(state.globalFacts.map((fact) => [fact.id, fact.title, fact.content])).toEqual([
      ['team', '团队', '十人'],
      ['schedule', '工期', '90 天'],
    ]);
    expect((await loadTechnicalPlan(appDb, peer.context, filled.projectId)).outlineData).toEqual(state.outlineData);
  });

  it('保存目录 sort：只改位置与项目名称，节点身份和正文不变，编号按新顺序现算；节点不一致时 409 不做改动', async () => {
    const filled = await fillProject(a);
    const [n0, n1, n2, n3] = filled.nodes as [string, string, string, string];
    const before = await contentsOf(filled.projectId);
    // 第二章移到最前，1.2 移到第二章下，同时请求中的正文、标题被忽略。
    const state = await saveOutline(appDb, a.context, filled.projectId, {
      reason: 'sort',
      outlineData: {
        project_name: '新名称',
        outline: [
          { id: n3, title: '第二章', content: '忽略', children: [{ id: n2, title: '改不了' }] },
          { id: n0, title: '第一章', children: [{ id: n1, title: '1.1 节' }] },
        ],
      },
    });
    expect(state.outlineData!.project_name).toBe('新名称');
    expect(state.outlineData!.project_overview).toBeUndefined();
    expect(state.outlineData!.outline.map((item) => [item.id, item.number, item.children?.map((child) => [child.id, child.number, child.title])])).toEqual([
      [n3, '1', [[n2, '1.1', '1.2 节']]],
      [n0, '2', [[n1, '2.1', '1.1 节']]],
    ]);
    expect(await contentsOf(filled.projectId)).toEqual(before);
    // 少了节点、多了节点：409，不做改动。
    for (const outline of [[{ id: n0, children: [{ id: n1 }, { id: n2 }] }], [...outlineOf(filled.nodes).outline, { id: randomUUID(), title: '新' }]]) {
      await expectAppError(saveOutline(appDb, a.context, filled.projectId, { reason: 'sort', outlineData: { outline } }), 409, 'TECHNICAL_PLAN_OUTLINE_CHANGED');
    }
    expect((await loadTechnicalPlan(appDb, a.context, filled.projectId)).outlineData).toEqual(state.outlineData);
  });

  it('保存目录 edit：只改标题与说明，处理方式、正文与位置不变', async () => {
    const filled = await fillProject(a);
    const [n0, n1, n2, n3] = filled.nodes as [string, string, string, string];
    const state = await saveOutline(appDb, a.context, filled.projectId, {
      reason: 'edit',
      outlineData: {
        outline: [
          { id: n0, title: '新第一章', description: '新说明', children: [{ id: n1, title: '1.1 节', content_mode: 'manual-fill', content: '' }, { id: n2, title: '1.2 节' }] },
          { id: n3, title: '' },
        ],
      },
    });
    expect(state.outlineData!.outline.map((item) => [item.title, item.description])).toEqual([
      ['新第一章', '新说明'],
      ['未命名章节', ''],
    ]);
    expect(state.outlineData!.outline[0]!.children![0]).toMatchObject({ content_mode: 'ai-generate', content: '正文 1.1' });
    expect(state.outlineData!.outline[1]).toMatchObject({ content: '正文二' });
    expect(state.outlineData!.project_name).toBe('示例项目');
    await expectAppError(
      saveOutline(appDb, a.context, filled.projectId, { reason: 'edit', outlineData: { outline: [{ id: n0, title: 'x' }] } }),
      409,
      'TECHNICAL_PLAN_OUTLINE_CHANGED',
    );
  });

  it('保存目录 add-child / delete：受影响节点与叶子、父节点身份变化的节点清空正文，其余沿用已保存的正文，新节点取请求的正文', async () => {
    const filled = await fillProject(a);
    const [n0, n1, n2, n3] = filled.nodes as [string, string, string, string];
    await writeContents(filled.projectId, { [n2]: '正文 1.2' });
    const added = randomUUID();
    // 第二章下加一个子节点：第二章由叶子变成父节点，正文清空；请求给出的 1.1 正文被忽略（沿用已保存的）。
    const outline = outlineOf(filled.nodes).outline;
    outline[0].children[0].content = '请求中的正文';
    outline[1].children = [{ id: added, title: '2.1 节', content_mode: 'ai-generate', content: '新节点正文' }];
    let state = await saveOutline(appDb, a.context, filled.projectId, { reason: 'add-child', outlineData: { outline }, affectedNodeIds: [] });
    expect(await contentsOf(filled.projectId)).toEqual({ [n0]: '', [n1]: '正文 1.1', [n2]: '正文 1.2', [n3]: '', [added]: '新节点正文' });
    expect(state.outlineData!.outline[1]).toMatchObject({ id: n3, number: '2', children: [{ id: added, number: '2.1' }] });
    // 父节点不再保留处理方式。
    expect(state.outlineData!.outline[1]!.content_mode).toBeUndefined();
    expect(state.outlineData!.project_name).toBeUndefined();

    // 删除 1.2，affectedNodeIds 中的 1.1 正文清空；删除第二章时其子节点一起删除。
    state = await saveOutline(appDb, a.context, filled.projectId, {
      reason: 'delete',
      outlineData: { project_name: '项目', outline: [{ id: n0, title: '第一章', children: [{ id: n1, title: '1.1 节', content_mode: 'ai-generate' }] }] },
      affectedNodeIds: [n1.toUpperCase()],
    });
    expect(await contentsOf(filled.projectId)).toEqual({ [n0]: '', [n1]: '' });
    expect(state.outlineData!.outline.map((item) => item.id)).toEqual([n0]);
    // 字数控制快照只在目录清空时清除。
    expect(state.outlineWordControlSnapshot).toEqual({ minimumWords: 1000, maximumWords: 2000, sectionWords: 500 });
  });

  it('保存目录 replace：整体替换并清空全部正文；空目录删除目录并清除字数控制快照；全局事实不受影响', async () => {
    const filled = await fillProject(a);
    const [n0, n1] = filled.nodes as [string, string];
    const fresh = randomUUID();
    let state = await saveOutline(appDb, a.context, filled.projectId, {
      reason: 'replace',
      outlineData: { outline: [{ id: n0, title: '第一章', children: [{ id: n1, title: '1.1', content: '不保留' }, { id: fresh, title: '1.2', content: '不保留' }] }] },
    });
    expect(await contentsOf(filled.projectId)).toEqual({ [n0]: '', [n1]: '', [fresh]: '' });
    expect(state.globalFacts).toHaveLength(2);
    state = await saveOutline(appDb, a.context, filled.projectId, { reason: 'add-root', outlineData: { project_name: '项目', outline: [] } });
    expect(state).toMatchObject({ outlineData: null, outlineWordControlSnapshot: null });
    expect((await adminCounts(filled.projectId)).technical_plan_outline_nodes).toBe(0);
    const meta = await superuser.selectFrom('technical_plan_meta').select(['outline_project_name', 'outline_project_overview']).where('project_id', '=', filled.projectId).executeTakeFirstOrThrow();
    expect(meta).toEqual({ outline_project_name: null, outline_project_overview: null });
    state = await saveOutline(appDb, a.context, filled.projectId, { reason: 'replace', outlineData: null });
    expect(state.outlineData).toBeNull();
  });

  it('保存目录：不合法的目录返回 400，不做改动', async () => {
    const filled = await fillProject(a);
    const before = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    for (const outlineData of [{ outline: {} }, { outline: [{ id: '1.1', title: 'x' }] }, { outline: [{ id: randomUUID(), content_mode: 'auto' }] }, 'x']) {
      await expectAppError(saveOutline(appDb, a.context, filled.projectId, { reason: 'replace', outlineData }), 400, 'TECHNICAL_PLAN_INVALID');
    }
    expect(await loadTechnicalPlan(appDb, a.context, filled.projectId)).toEqual(before);
  });

  it('saveGeneratedOutline：整体替换、清空正文并写入字数控制快照；空目录时快照为 null；不合法的目录返回 400', async () => {
    const filled = await fillProject(a);
    const nodes = Array.from({ length: 4 }, () => randomUUID());
    await saveGeneratedOutline(appDb, a.context, filled.projectId, {
      outlineData: outlineOf(nodes),
      wordControlSnapshot: { minimumWords: 3000.7, maximumWords: -1, sectionWords: 800 },
    });
    let state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state.outlineData!.outline.map((item) => item.id)).toEqual([nodes[0], nodes[3]]);
    expect(Object.values(await contentsOf(filled.projectId))).toEqual(['', '', '', '']);
    expect(state.outlineWordControlSnapshot).toEqual({ minimumWords: 3000, maximumWords: 0, sectionWords: 800 });
    await saveGeneratedOutline(appDb, a.context, filled.projectId, { outlineData: null, wordControlSnapshot: { minimumWords: 1, maximumWords: 2, sectionWords: 3 } });
    state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state).toMatchObject({ outlineData: null, outlineWordControlSnapshot: null });
    await expectAppError(
      saveGeneratedOutline(appDb, a.context, filled.projectId, { outlineData: { outline: [{ id: 'x' }] }, wordControlSnapshot: null }),
      400,
      'TECHNICAL_PLAN_INVALID',
    );
  });

  it('保存全局事实：按桌面版整理后整体替换，清空全部正文；内容未变的分组沿用原来的 updated_at；超出上限返回 400', async () => {
    const filled = await fillProject(a);
    const before = (await loadTechnicalPlan(appDb, a.context, filled.projectId)).globalFacts;
    const state = await saveGlobalFacts(appDb, a.context, filled.projectId, [
      { id: 'schedule', title: '工期', content: '120 天' },
      { id: 'team', title: ' 团队 ', content: '十人' },
      { title: '空的丢弃', content: ' ' },
      { title: 'Quality Level', content: '合格' },
    ]);
    expect(state.globalFacts.map((fact) => [fact.id, fact.title, fact.content])).toEqual([
      ['schedule', '工期', '120 天'],
      ['team', '团队', '十人'],
      ['quality_level', 'Quality Level', '合格'],
    ]);
    const team = state.globalFacts.find((fact) => fact.id === 'team')!;
    const schedule = state.globalFacts.find((fact) => fact.id === 'schedule')!;
    expect(team.updated_at).toEqual(before.find((fact) => fact.id === 'team')!.updated_at);
    expect(schedule.updated_at.getTime()).toBeGreaterThan(before.find((fact) => fact.id === 'schedule')!.updated_at.getTime());
    expect(Object.values(await contentsOf(filled.projectId)).every((content) => content === '')).toBe(true);
    // 目录本身不变。
    expect(state.outlineData!.outline).toHaveLength(2);
    expect((await saveGlobalFacts(appDb, a.context, filled.projectId, [])).globalFacts).toEqual([]);
    await expectAppError(
      saveGlobalFacts(appDb, a.context, filled.projectId, Array.from({ length: 101 }, () => ({ title: 't', content: 'c' }))),
      400,
      'TECHNICAL_PLAN_INVALID',
    );
  });

  it('下游清空：导入或移除招标文件、切换单 / 多标段、选择投标范围时删除目录与全局事实，清除项目名称、概述与字数控制快照', async () => {
    const cleared = { outlineData: null, outlineWordControlSnapshot: null, globalFacts: [] };
    const check = async (projectId: string) => {
      expect(await loadTechnicalPlan(appDb, a.context, projectId)).toMatchObject(cleared);
      const meta = await superuser
        .selectFrom('technical_plan_meta')
        .select(['outline_project_name', 'outline_project_overview', 'outline_word_control_snapshot'])
        .where('project_id', '=', projectId)
        .executeTakeFirstOrThrow();
      expect(meta).toEqual({ outline_project_name: null, outline_project_overview: null, outline_word_control_snapshot: null });
    };
    let filled = await fillProject(a);
    await importTenderFiles(appDb, a.context, filled.projectId, [await newFile(a)]);
    await check(filled.projectId);
    filled = await fillProject(a);
    await removeTenderFile(appDb, a.context, filled.projectId, filled.tenders[1]!);
    await check(filled.projectId);
    filled = await fillProject(a);
    await saveGenerationConfig(appDb, a.context, filled.projectId, { bidSectionMode: 'single' });
    await check(filled.projectId);
    filled = await fillProject(a);
    await selectBidSection(appDb, a.context, filled.projectId, 's2', memoryStore);
    await check(filled.projectId);
    filled = await fillProject(a);
    await prepareBidSectionExtraction(appDb, a.context, filled.projectId);
    await check(filled.projectId);
    // 上传、移除原方案和不切换单 / 多标段的配置保存不清空。
    filled = await fillProject(a);
    await setOriginalPlan(appDb, a.context, filled.projectId, await newFile(a));
    await removeOriginalPlan(appDb, a.context, filled.projectId);
    await saveGenerationConfig(appDb, a.context, filled.projectId, { globalFactsMode: 'omit' });
    const state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state.outlineData!.outline).toHaveLength(2);
    expect(state.globalFacts).toHaveLength(2);
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
    // 没有对应的识别任务（6.11），running 按未完成显示。
    expect(state).toMatchObject({
      step: 'bid-analysis',
      bidSectionMode: 'multiple',
      bidSectionExtractionStatus: 'error',
      bidSectionExtractionError: '上次多标段识别未完成，请重新识别',
      bidSections: [],
      selectedSection: null,
      bidAnalysisTasks: {},
    });
    expect((await superuser.selectFrom('technical_plan_meta').select('bid_section_extraction_status').where('project_id', '=', filled.projectId).executeTakeFirstOrThrow()).bid_section_extraction_status).toBe('running');
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
    await expectError(await call(b, 'PUT', tp(projectId, '/outline'), { outlineData: null, reason: 'replace' }), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(b, 'PUT', tp(projectId, '/global-facts'), { globalFacts: [] }), 404, 'PROJECT_NOT_FOUND');
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
      ['PUT', '/outline', { outlineData: { outline: [] } }],
      ['PUT', '/outline', { outlineData: [], reason: 'replace' }],
      ['PUT', '/outline', { outlineData: null, reason: 'move' }],
      ['PUT', '/outline', { outlineData: null, reason: 'delete', affectedNodeIds: ['1.2'] }],
      ['PUT', '/outline', { outlineData: { outline: [{ id: '1', title: 'x' }] }, reason: 'replace' }],
      ['PUT', '/global-facts', {}],
      ['PUT', '/global-facts', { globalFacts: [{ title: 'x' }] }],
      ['PUT', '/global-facts', { globalFacts: [{ title: 'x', content: 'y', note: 'z' }] }],
      ['PUT', '/global-facts', { globalFacts: [{ title: 'x', content: 'y'.repeat(100_001) }] }],
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

  it('目录与全局事实：保存后返回完整状态；sort 与已保存的目录不一致时 409', async () => {
    const projectId = await newProject(a);
    const nodes = Array.from({ length: 4 }, () => randomUUID());
    let response = await call(a, 'PUT', tp(projectId, '/outline'), { outlineData: outlineOf(nodes), reason: 'replace' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().outlineData.outline.map((item: { id: string; number: string }) => [item.id, item.number])).toEqual([
      [nodes[0], '1'],
      [nodes[3], '2'],
    ]);
    response = await call(a, 'PUT', tp(projectId, '/outline'), {
      outlineData: { outline: [{ id: nodes[3] }, { id: nodes[0], children: [{ id: nodes[2] }, { id: nodes[1] }] }] },
      reason: 'sort',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outlineData.outline[1].children.map((item: { id: string; number: string }) => [item.id, item.number])).toEqual([
      [nodes[2], '2.1'],
      [nodes[1], '2.2'],
    ]);
    await expectError(await call(a, 'PUT', tp(projectId, '/outline'), { outlineData: { outline: [{ id: nodes[0] }] }, reason: 'sort' }), 409, 'TECHNICAL_PLAN_OUTLINE_CHANGED');
    await expectError(
      await call(a, 'PUT', tp(projectId, '/outline'), { outlineData: { outline: [{ id: randomUUID(), content_mode: 'auto' }] }, reason: 'replace' }),
      400,
      'TECHNICAL_PLAN_INVALID',
    );

    response = await call(a, 'PUT', tp(projectId, '/global-facts'), {
      globalFacts: [{ id: 'team', title: '团队', content: '十人', updated_at: '2000-01-01T00:00:00.000Z' }, { title: '空', content: '' }],
    });
    expect(response.statusCode, response.body).toBe(200);
    const facts = response.json().globalFacts;
    expect(facts).toMatchObject([{ id: 'team', title: '团队', content: '十人' }]);
    expect(facts[0].updated_at).not.toBe('2000-01-01T00:00:00.000Z');

    // 其他组织的成员读不到。
    await expectError(await call(b, 'GET', tp(projectId)), 404, 'PROJECT_NOT_FOUND');
    response = await call(a, 'DELETE', tp(projectId));
    expect(response.statusCode).toBe(200);
    expect((await call(a, 'GET', tp(projectId))).json()).toMatchObject({ outlineData: null, globalFacts: [], outlineWordControlSnapshot: null });
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

describe('正文（5.13）：RLS', () => {
  it('正文生成状态与编排只能挂在同一项目的目录节点上，节点删除时随之删除；运行进度只能是对象', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const other = await newProject(member);
    const nodeId = randomUUID();
    await withTenant(appDb, member.context, (trx) =>
      trx.insertInto('technical_plan_outline_nodes').values({ org_id: member.orgId, project_id: projectId, node_id: nodeId, level: 1, title: '章' }).execute(),
    );
    const insert = (table: 'technical_plan_content_sections' | 'technical_plan_content_plans', project: string, node: string) =>
      withTenant(appDb, member.context, (trx) =>
        (trx as unknown as Kysely<any>)
          .insertInto(table)
          .values({
            org_id: member.orgId,
            project_id: project,
            node_id: node,
            ...(table === 'technical_plan_content_plans' ? { plan_version: 1, plan: '{}' } : {}),
          })
          .execute(),
      );
    for (const table of TECHNICAL_PLAN_CONTENT_TABLES) {
      await expect(insert(table, other, nodeId), table).rejects.toThrow(/foreign key/);
      await expect(insert(table, projectId, randomUUID()), table).rejects.toThrow(/foreign key/);
      await insert(table, projectId, nodeId);
    }
    expect(await adminCounts(projectId)).toMatchObject({ technical_plan_content_sections: 1, technical_plan_content_plans: 1 });
    await withTenant(appDb, member.context, (trx) => trx.deleteFrom('technical_plan_outline_nodes').where('node_id', '=', nodeId).execute());
    expect(await adminCounts(projectId)).toMatchObject({ technical_plan_content_sections: 0, technical_plan_content_plans: 0 });

    const insertAny = (table: string, values: Record<string, unknown>) =>
      withTenant(appDb, member.context, (trx) =>
        (trx as unknown as Kysely<any>).insertInto(table).values({ org_id: member.orgId, project_id: projectId, ...values }).execute(),
      );
    await insertAny('technical_plan_outline_nodes', { node_id: nodeId, level: 1, title: '章' });
    const cases: [string, Record<string, unknown>][] = [
      ['technical_plan_content_sections', { node_id: nodeId, status: 'paused' }],
      ['technical_plan_content_sections', { node_id: nodeId, error: '' }],
      ['technical_plan_content_plans', { node_id: nodeId, plan_version: 0, plan: '{}' }],
      ['technical_plan_content_plans', { node_id: nodeId, plan_version: 1, plan: '[]' }],
      ['technical_plan_content_plans', { node_id: nodeId, plan_version: 1, plan: '{}', table_requirement: 'all' }],
      ['technical_plan_meta', { content_generation_runtime: '"x"' }],
    ];
    for (const [table, values] of cases) {
      await expect(insertAny(table, values), `${table} ${JSON.stringify(values)}`).rejects.toThrow(/check constraint/);
    }
  });
});

describe('正文（5.13）：Store', () => {
  let a: Member;
  let peer: Member;

  beforeAll(async () => {
    a = await newMember();
    peer = await newMember(a.orgId);
  });

  const sectionRows = async (projectId: string) =>
    (await superuser.selectFrom('technical_plan_content_sections').select(['node_id', 'status', 'error']).where('project_id', '=', projectId).orderBy('node_id').execute()) as {
      node_id: string;
      status: string;
      error: string | null;
    }[];
  const planIds = async (projectId: string) =>
    ((await superuser.selectFrom('technical_plan_content_plans').select('node_id').where('project_id', '=', projectId).orderBy('node_id').execute()) as { node_id: string }[]).map(
      (row) => row.node_id,
    );
  const runtimeOf = async (projectId: string) =>
    (await superuser.selectFrom('technical_plan_meta').select('content_generation_runtime').where('project_id', '=', projectId).executeTakeFirstOrThrow()).content_generation_runtime;

  it('完整状态：有状态行的节取行中的状态，没有状态行但有正文的叶子视为 success；编排与运行进度；组织内其他成员看到同样的状态', async () => {
    const filled = await fillProject(a);
    const [, n11, , n2] = filled.nodes;
    const state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state.contentGenerationSections).toEqual({
      [n11!]: { id: n11, title: '1.1 节', status: 'success', content: '正文 1.1', error: null, updated_at: expect.any(Date) },
      [n2!]: { id: n2, title: '第二章', status: 'success', content: '正文二', error: null, updated_at: null },
    });
    expect(state.contentGenerationPlans).toEqual({ [n11!]: { plan_version: 1, plan: PLAN, table_requirement: 'light', updated_at: expect.any(Date) } });
    expect(state.contentGenerationRuntime).toEqual({ generation_started: true, section_words: { [n11!]: 800 } });
    expect(state.contentGenerationTask).toBeNull();
    expect(await loadTechnicalPlan(appDb, peer.context, filled.projectId)).toEqual(state);
  });

  it('手工保存一节正文：写入正文，状态改为 success（空正文 idle）并清除错误，编排与运行进度不变；节点不存在 404，超长 400', async () => {
    const filled = await fillProject(a);
    const [, n11, n12] = filled.nodes;
    await saveContentSections(appDb, a.context, filled.projectId, { [n11!]: { status: 'error', error: '生成失败' } });
    let state = await saveChapterContent(appDb, a.context, filled.projectId, n11!.toUpperCase(), '手写正文');
    expect(state.contentGenerationSections[n11!]).toMatchObject({ status: 'success', content: '手写正文', error: null });
    state = await saveChapterContent(appDb, a.context, filled.projectId, n12!, '  ');
    expect(state.contentGenerationSections[n12!]).toMatchObject({ status: 'idle', content: '  ' });
    expect(await planIds(filled.projectId)).toEqual([n11]);
    expect(await runtimeOf(filled.projectId)).toEqual({ generation_started: true, section_words: { [n11!]: 800 } });

    await expectAppError(saveChapterContent(appDb, a.context, filled.projectId, randomUUID(), 'x'), 404, 'TECHNICAL_PLAN_CHAPTER_NOT_FOUND');
    await expectAppError(saveChapterContent(appDb, a.context, filled.projectId, 'not-a-node', 'x'), 404, 'TECHNICAL_PLAN_CHAPTER_NOT_FOUND');
    await expectAppError(saveChapterContent(appDb, a.context, filled.projectId, n12!, '字'.repeat(500_001)), 400, 'TECHNICAL_PLAN_INVALID');
    expect((await contentsOf(filled.projectId))[n12!]).toBe('  ');
  });

  it('重置正文阶段：清空全部正文、生成状态、编排与运行进度，保留目录、全局事实和生成配置', async () => {
    const filled = await fillProject(a);
    const before = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    const state = await resetContentGeneration(appDb, a.context, filled.projectId);
    expect(Object.values(await contentsOf(filled.projectId))).toEqual(['', '', '', '']);
    expect(state.contentGenerationSections).toEqual({});
    expect(state.contentGenerationPlans).toEqual({});
    expect(state.contentGenerationRuntime).toBeNull();
    expect(state.globalFacts).toEqual(before.globalFacts);
    expect(state.outlineData!.outline.map((item) => item.id)).toEqual(before.outlineData!.outline.map((item) => item.id));
    expect(state.exportTemplateId).toBe(before.exportTemplateId);
    expect(await adminCounts(filled.projectId)).toMatchObject({ technical_plan_content_sections: 0, technical_plan_content_plans: 0, technical_plan_global_fact_groups: 2 });
  });

  it('保存目录 sort / edit 不改正文生成状态、编排与运行进度', async () => {
    const filled = await fillProject(a);
    const before = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    const outline = outlineOf(filled.nodes);
    outline.outline.reverse();
    await saveOutline(appDb, a.context, filled.projectId, { outlineData: outline, reason: 'sort' });
    outline.outline[1].children[0].title = '改过的 1.1';
    const state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: outline, reason: 'edit' });
    expect(state.contentGenerationPlans).toEqual(before.contentGenerationPlans);
    expect(state.contentGenerationRuntime).toEqual(before.contentGenerationRuntime);
    expect(Object.keys(state.contentGenerationSections).sort()).toEqual(Object.keys(before.contentGenerationSections).sort());
    expect(state.contentGenerationSections[filled.nodes[1]!]!.title).toBe('改过的 1.1');
  });

  it('保存目录 add-root / delete：受影响节点的状态与编排删除，运行进度按桌面版规则保留；replace 清空全部', async () => {
    const filled = await fillProject(a);
    const [n1, n11, n12, n2] = filled.nodes as [string, string, string, string];
    const removed = randomUUID();
    await saveContentGenerationRuntime(appDb, a.context, filled.projectId, {
      generation_started: true,
      section_words: { [n11]: 800, [n12]: 300, [removed]: 1 },
      html_output: { workspace_dir: 'w', word_output_dir: 'o', word_sections: [{ section_id: n11, file: 'a.docx' }, { section_id: n12, file: 'b.docx' }] },
      phase: 'generating',
      direct_generation_item_ids: [n11, removed],
      pending_item_ids: [n11],
      touched_item_ids: [n11],
    });
    // 新增一章（ai-generate 叶子）：已开始生成，新叶子同时进入直接生成与待生成范围。
    const added = randomUUID();
    const outline = outlineOf(filled.nodes);
    outline.outline.push({ id: added, title: '第三章', description: '', content_mode: 'ai-generate' });
    let state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: outline, reason: 'add-root', affectedNodeIds: [] });
    expect(Object.keys(state.contentGenerationPlans)).toEqual([n11]);
    expect(state.contentGenerationSections[n11]).toMatchObject({ status: 'success' });
    expect(state.contentGenerationRuntime).toEqual({
      generation_started: true,
      section_words: { [n11]: 800 },
      html_output: { workspace_dir: 'w', word_output_dir: 'o', word_sections: [{ section_id: n11, file: 'a.docx' }] },
      phase: 'planning',
      direct_generation_item_ids: [n11, added],
      pending_item_ids: [n11, added],
    });

    // 删除 1.2 并使 1.1 失效：1.1 的状态与编排删除，范围中去掉 1.1。
    outline.outline[0].children.pop();
    state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: outline, reason: 'delete', affectedNodeIds: [n11] });
    expect(state.contentGenerationPlans).toEqual({});
    expect(await sectionRows(filled.projectId)).toEqual([]);
    expect(state.contentGenerationRuntime).toEqual({
      generation_started: true,
      section_words: {},
      html_output: { workspace_dir: 'w', word_output_dir: 'o', word_sections: [] },
      phase: 'planning',
      direct_generation_item_ids: [added],
      pending_item_ids: [added],
    });

    // 没有运行进度、未开始生成时：新叶子只进入直接生成范围。
    await saveContentGenerationRuntime(appDb, a.context, filled.projectId, null);
    const another = randomUUID();
    outline.outline.push({ id: another, title: '第四章', description: '', content_mode: 'ai-generate' });
    state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: outline, reason: 'add-root' });
    expect(state.contentGenerationRuntime).toEqual({
      generation_started: false,
      section_words: {},
      phase: 'planning',
      direct_generation_item_ids: [another],
      pending_item_ids: [],
    });

    await saveContentSections(appDb, a.context, filled.projectId, { [n2]: { status: 'success' }, [n1]: { status: 'idle' } });
    await saveContentPlans(appDb, a.context, filled.projectId, { [n2]: { plan_version: 1, plan: PLAN } });
    state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: outline, reason: 'replace' });
    expect(await sectionRows(filled.projectId)).toEqual([]);
    expect(await planIds(filled.projectId)).toEqual([]);
    expect(state.contentGenerationRuntime).toBeNull();
  });

  it('由叶子变成父节点的节点：状态与编排随正文一起失效', async () => {
    const filled = await fillProject(a);
    const [, n11] = filled.nodes as [string, string];
    const outline = outlineOf(filled.nodes);
    outline.outline[0].children[0].children = [{ id: randomUUID(), title: '1.1.1', description: '', content_mode: 'ai-generate' }];
    const state = await saveOutline(appDb, a.context, filled.projectId, { outlineData: outline, reason: 'add-child', affectedNodeIds: [] });
    expect(state.contentGenerationPlans).toEqual({});
    expect(state.contentGenerationSections[n11]).toBeUndefined();
  });

  it('保存全局事实、saveGeneratedOutline 与下游清空、清空技术方案都清空正文生成状态、编排与运行进度', async () => {
    const check = async (projectId: string) => {
      expect(await adminCounts(projectId)).toMatchObject({ technical_plan_content_sections: 0, technical_plan_content_plans: 0 });
      expect(await runtimeOf(projectId)).toBeNull();
    };
    let filled = await fillProject(a);
    await saveGlobalFacts(appDb, a.context, filled.projectId, [{ id: 'team', title: '团队', content: '八人' }]);
    await check(filled.projectId);

    filled = await fillProject(a);
    await saveGeneratedOutline(appDb, a.context, filled.projectId, { outlineData: outlineOf(filled.nodes), wordControlSnapshot: null });
    await check(filled.projectId);

    filled = await fillProject(a);
    await removeTenderFile(appDb, a.context, filled.projectId, filled.tenders[1]!);
    await check(filled.projectId);

    filled = await fillProject(a);
    await saveGenerationConfig(appDb, a.context, filled.projectId, { bidSectionMode: 'single' });
    await check(filled.projectId);

    filled = await fillProject(a);
    await clearTechnicalPlan(appDb, a.context, filled.projectId);
    await check(filled.projectId);
  });

  it('saveContentSections：整体替换，给出 content 时写入正文；不在目录中的节点跳过；节点 id 不合法抛 TypeError', async () => {
    const filled = await fillProject(a);
    const [n1, n11, n12] = filled.nodes as [string, string, string];
    await saveContentSections(appDb, a.context, filled.projectId, {
      [n12.toUpperCase()]: { status: 'running', content: '生成中\u0000' },
      [n1]: { status: 'error', error: 'x'.repeat(30_000) },
      [randomUUID()]: { status: 'success' },
    });
    const rows = await sectionRows(filled.projectId);
    expect(rows.map((row) => [row.node_id, row.status])).toEqual([[n1, 'error'], [n12, 'running']].sort());
    expect(rows.find((row) => row.node_id === n1)!.error).toHaveLength(20_000);
    expect(await contentsOf(filled.projectId)).toMatchObject({ [n11]: '正文 1.1', [n12]: '生成中' });
    await saveContentSections(appDb, a.context, filled.projectId, null);
    expect(await sectionRows(filled.projectId)).toEqual([]);
    await expect(saveContentSections(appDb, a.context, filled.projectId, { 'not-a-node': {} })).rejects.toThrow(TypeError);
  });

  it('saveContentPlans：整体替换，只保存 plan 是对象、版本大于 0 的节；表格要求不合法时不存；过大抛 TypeError', async () => {
    const filled = await fillProject(a);
    const [n1, n11, n12, n2] = filled.nodes as [string, string, string, string];
    await saveContentPlans(appDb, a.context, filled.projectId, {
      [n1]: { plan_version: 2.7, plan: PLAN, table_requirement: 'huge' },
      [n11]: { plan_version: 0, plan: PLAN },
      [n12]: { plan_version: 1, plan: [] },
      [n2]: { plan_version: 1 },
      [randomUUID()]: { plan_version: 1, plan: PLAN },
    });
    const state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state.contentGenerationPlans).toEqual({ [n1]: { plan_version: 2, plan: PLAN, updated_at: expect.any(Date) } });
    await expect(saveContentPlans(appDb, a.context, filled.projectId, { [n1]: { plan_version: 1, plan: { text: 'x'.repeat(200_000) } } })).rejects.toThrow(TypeError);
    await saveContentPlans(appDb, a.context, filled.projectId, {});
    expect(await planIds(filled.projectId)).toEqual([]);
  });

  it('saveContentGenerationItem / saveContentGenerationRuntime：各自写入给出的部分；节点不存在时返回 false 但照常写入运行进度', async () => {
    const filled = await fillProject(a);
    const [, , n12] = filled.nodes as [string, string, string];
    expect(
      await saveContentGenerationItem(appDb, a.context, filled.projectId, {
        nodeId: n12,
        section: { status: 'success', content: '生成的正文' },
        plan: { plan_version: 3, plan: PLAN, table_requirement: 'none' },
        runtime: { phase: 'generating' },
      }),
    ).toBe(true);
    const state = await loadTechnicalPlan(appDb, a.context, filled.projectId);
    expect(state.contentGenerationSections[n12]).toMatchObject({ status: 'success', content: '生成的正文' });
    expect(state.contentGenerationPlans[n12]).toMatchObject({ plan_version: 3, table_requirement: 'none' });
    expect(state.contentGenerationRuntime).toEqual({ phase: 'generating' });

    expect(await saveContentGenerationItem(appDb, a.context, filled.projectId, { nodeId: randomUUID(), section: { status: 'success' }, runtime: null })).toBe(false);
    expect(await runtimeOf(filled.projectId)).toBeNull();
    await expect(saveContentGenerationItem(appDb, a.context, filled.projectId, { nodeId: 'x' })).rejects.toThrow(TypeError);
    await expect(saveContentGenerationRuntime(appDb, a.context, filled.projectId, [] as never)).rejects.toThrow(TypeError);
    await expect(saveContentGenerationRuntime(appDb, a.context, filled.projectId, { words: 'x'.repeat(800_000) })).rejects.toThrow(TypeError);
  });
});

describe('正文（5.13）：接口', () => {
  let member: Member;
  let outsider: Member;

  beforeAll(async () => {
    member = await newMember();
    outsider = await newMember();
  });

  it('保存一节正文、重置正文阶段：返回完整状态；其他组织 404；请求体校验', async () => {
    const filled = await fillProject(member);
    const n12 = filled.nodes[2]!;
    let response = await call(member, 'PUT', tp(filled.projectId, `/chapters/${n12}`), { content: '手写' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().contentGenerationSections[n12]).toMatchObject({ status: 'success', content: '手写' });
    await expectError(await call(member, 'PUT', tp(filled.projectId, `/chapters/${randomUUID()}`), { content: 'x' }), 404, 'TECHNICAL_PLAN_CHAPTER_NOT_FOUND');
    await expectError(await call(member, 'PUT', tp(filled.projectId, '/chapters/abc'), { content: 'x' }), 400, 'BAD_REQUEST');
    await expectError(await call(member, 'PUT', tp(filled.projectId, `/chapters/${n12}`), { content: 'x', status: 'success' }), 400, 'BAD_REQUEST');
    await expectError(await call(member, 'PUT', tp(filled.projectId, `/chapters/${n12}`), {}), 400, 'BAD_REQUEST');
    await expectError(await call(outsider, 'PUT', tp(filled.projectId, `/chapters/${n12}`), { content: 'x' }), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(outsider, 'DELETE', tp(filled.projectId, '/content-generation')), 404, 'PROJECT_NOT_FOUND');

    response = await call(member, 'DELETE', tp(filled.projectId, '/content-generation'));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ contentGenerationSections: {}, contentGenerationPlans: {}, contentGenerationRuntime: null, contentGenerationTask: null });
    expect(response.json().outlineData.outline).toHaveLength(2);
  });
});

describe('废标检查从技术方案读取招标文件（5.13）', () => {
  let member: Member;
  let outsider: Member;

  beforeAll(async () => {
    member = await newMember();
    outsider = await newMember();
  });

  const sha256 = (content: Buffer) => createHash('sha256').update(content).digest();
  const rcUrl = (projectId: string) => `/api/projects/${projectId}/rejection-check/tender-from-technical-plan`;

  /** 用超级用户登记一个有真实内容的已上传文件（对象写进内存存储）。 */
  async function realFile(projectId: string | null, name: string, content: Buffer): Promise<string> {
    const row = await superuser
      .insertInto('files')
      .values({
        org_id: member.orgId,
        purpose: 'tender',
        display_name: name,
        extension: 'docx',
        status: 'uploaded',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size_bytes: content.length,
        sha256: sha256(content),
        uploaded_at: new Date(),
        created_by: member.userId,
        project_id: projectId,
      })
      .returning(['id', 'storage_key'])
      .executeTakeFirstOrThrow();
    objects.set(row.storage_key, content);
    return row.id;
  }

  /** 登记一个有真实内容与哈希的 Markdown 产物，返回产物 id。 */
  async function realMarkdown(fileId: string, markdown: string): Promise<string> {
    const content = Buffer.from(markdown);
    const row = await superuser
      .insertInto('artifacts')
      .values({
        org_id: member.orgId,
        source_file_id: fileId,
        kind: 'markdown',
        name: 'content.md',
        mime: 'text/markdown; charset=utf-8',
        status: 'ready',
        size_bytes: content.length,
        sha256: sha256(content),
        completed_at: new Date(),
        created_by: member.userId,
      })
      .returning(['id', 'storage_key'])
      .executeTakeFirstOrThrow();
    objects.set(row.storage_key, content);
    return row.id;
  }

  /** 技术方案项目：两份已解析的招标文件、一份未解析的，无效投标与废标项解析成功。 */
  async function technicalPlan(): Promise<{ projectId: string; files: string[] }> {
    const projectId = await newProject(member);
    const files = [
      await realFile(null, '招标A.docx', Buffer.from('original-a')),
      await realFile(null, '招标B.docx', Buffer.from('original-b')),
      await realFile(null, '未解析.docx', Buffer.from('original-c')),
    ];
    await importTenderFiles(appDb, member.context, projectId, files);
    for (const [index, markdown] of ['# 招标 A', '# 招标 B'].entries()) {
      const artifactId = await realMarkdown(files[index]!, markdown);
      await saveDocumentParse(appDb, member.context, projectId, files[index]!, {
        status: 'success',
        markdownArtifactId: artifactId,
        contentChars: markdown.length,
        contentHash: `hash-${index}`,
        parserLabel: '本地解析',
      });
    }
    await saveBidItems(appDb, member.context, projectId, { discardedBids: { status: 'success', content: "'''\n未按要求盖章\n'''" } });
    return { projectId, files };
  }

  /** 废标检查项目：一份招标文件、一份投标文件，带解析结果与检查结果。 */
  async function rejectionCheck(): Promise<{ projectId: string; tender: string; bid: string }> {
    const projectId = await newProject(member, 'rejection-check');
    const tender = await realFile(null, '旧招标.docx', Buffer.from('old'));
    const bid = await realFile(null, '投标.docx', Buffer.from('bid'));
    await importRejectionDocuments(appDb, member.context, projectId, { role: 'tender', fileIds: [tender] });
    await importRejectionDocuments(appDb, member.context, projectId, { role: 'bid', fileIds: [bid] });
    await saveRejectionExtraction(appDb, member.context, projectId, { status: 'success', content: '旧解析', source: 'ai' });
    await saveRejectionCheckResult(appDb, member.context, projectId, 'typo', { status: 'success', findings: [{ bidDocumentId: bid, wrongText: '帐号', correctText: '账号' }] });
    return { projectId, tender, bid };
  }

  async function contentOfArtifact(artifactId: string): Promise<string> {
    const row = await superuser.selectFrom('artifacts').select('storage_key').where('id', '=', artifactId).executeTakeFirstOrThrow();
    return objects.get(row.storage_key)!.toString();
  }

  it('复制已解析的招标文件（原件与 Markdown）并整体替换招标文件；写入来自技术方案的解析结果，签名与当前招标文件一致', async () => {
    const source = await technicalPlan();
    const target = await rejectionCheck();
    const response = await call(member, 'POST', rcUrl(target.projectId), { technicalPlanProjectId: source.projectId.toUpperCase() });
    expect(response.statusCode, response.body).toBe(200);
    const { importedCount, state } = response.json();
    expect(importedCount).toBe(2);
    expect(state.tenderDocuments).toHaveLength(2);
    expect(state.tenderDocuments.map((document: { fileName: string }) => document.fileName)).toEqual(['招标A.docx', '招标B.docx']);
    for (const [index, document] of state.tenderDocuments.entries()) {
      expect(source.files).not.toContain(document.id);
      expect(document).toMatchObject({ status: 'success', contentChars: 6, contentHash: `hash-${index}`, parserLabel: '本地解析', error: null });
      expect(await contentOfArtifact(document.markdownArtifactId)).toBe(index === 0 ? '# 招标 A' : '# 招标 B');
      const file = await superuser.selectFrom('files').selectAll().where('id', '=', document.id).executeTakeFirstOrThrow();
      expect(file).toMatchObject({ project_id: target.projectId, purpose: 'tender', status: 'uploaded', deleted_at: null, created_by: member.userId });
      expect(objects.get(file.storage_key)!.toString()).toBe(index === 0 ? 'original-a' : 'original-b');
    }
    expect(state.bidDocuments.map((document: { id: string }) => document.id)).toEqual([target.bid]);
    expect(state.invalidBidAndRejectionItems).toMatchObject({ status: 'success', content: '未按要求盖章', source: 'technical-plan', tenderSignature: state.signatures.tender });
    expect(state.signatures.tender).not.toBe('');
    expect(state.typoCheckResult.findings).toEqual([]);
    expect(state.activeDocumentTab).toBe('tender');
    expect(await fileDeleted(target.tender)).toBe(true);
    expect(JSON.parse(JSON.stringify(await loadRejectionCheck(appDb, member.context, target.projectId)))).toEqual(state);
    // 来源不受影响。
    const plan = await loadTechnicalPlan(appDb, member.context, source.projectId);
    expect(plan.tenderFiles.map((document) => document.id)).toEqual(source.files);
    for (const fileId of source.files) expect(await fileDeleted(fileId)).toBe(false);
  });

  it('没有解析成功的“无效投标与废标项”时不写解析结果', async () => {
    const source = await technicalPlan();
    await saveBidItems(appDb, member.context, source.projectId, null);
    const target = await rejectionCheck();
    const response = await call(member, 'POST', rcUrl(target.projectId), { technicalPlanProjectId: source.projectId });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().state.invalidBidAndRejectionItems).toMatchObject({ status: 'idle', content: '', source: null });
  });

  it('来源不是本组织未删除的技术方案项目时 404；没有已解析的招标文件时 409；未配置对象存储时 503；均不改动招标文件', async () => {
    const target = await rejectionCheck();
    const before = await loadRejectionCheck(appDb, member.context, target.projectId);
    const notPlan = await newProject(member, 'rejection-check');
    const foreign = await newProject(outsider);
    const deleted = (await technicalPlan()).projectId;
    await softDeleteProject(deleted, member.userId);
    for (const projectId of [notPlan, foreign, deleted, randomUUID()]) {
      await expectError(await call(member, 'POST', rcUrl(target.projectId), { technicalPlanProjectId: projectId }), 404, 'REJECTION_CHECK_TECHNICAL_PLAN_NOT_FOUND');
    }
    const empty = await newProject(member);
    await importTenderFiles(appDb, member.context, empty, [await realFile(null, '未解析.docx', Buffer.from('x'))]);
    await expectError(await call(member, 'POST', rcUrl(target.projectId), { technicalPlanProjectId: empty }), 409, 'REJECTION_CHECK_TECHNICAL_PLAN_EMPTY');
    const source = await technicalPlan();
    await expectError(
      await call(member, 'POST', rcUrl(target.projectId), { technicalPlanProjectId: source.projectId }, noStorageApp),
      503,
      'FILE_STORAGE_DISABLED',
    );
    await expectError(await call(outsider, 'POST', rcUrl(target.projectId), { technicalPlanProjectId: source.projectId }), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(member, 'POST', rcUrl(target.projectId), { technicalPlanProjectId: 'x' }), 400, 'BAD_REQUEST');
    await expectError(await call(member, 'POST', rcUrl(source.projectId), { technicalPlanProjectId: source.projectId }), 404, 'PROJECT_NOT_FOUND');
    expect(await loadRejectionCheck(appDb, member.context, target.projectId)).toEqual(before);
  });

  it('复制中途失败（来源对象与登记的哈希不符）时不改动招标文件，已写的副本删除或进回收站，不留上传中的登记', async () => {
    const source = await technicalPlan();
    const target = await rejectionCheck();
    const before = await loadRejectionCheck(appDb, member.context, target.projectId);
    const filesBefore = new Set(((await superuser.selectFrom('files').select('id').where('org_id', '=', member.orgId).execute()) as { id: string }[]).map((row) => row.id));
    const objectsBefore = objects.size;
    // 第二份的 Markdown 对象被改动：第一份已完成复制，第二份的 Markdown 复制失败。
    const second = (await loadTechnicalPlan(appDb, member.context, source.projectId)).tenderFiles[1]!;
    const artifact = await superuser.selectFrom('artifacts').select('storage_key').where('id', '=', second.markdownArtifactId).executeTakeFirstOrThrow();
    objects.set(artifact.storage_key, Buffer.from('# 已损坏'));
    const response = await call(member, 'POST', rcUrl(target.projectId), { technicalPlanProjectId: source.projectId });
    expect(response.statusCode).toBe(500);
    expect(await loadRejectionCheck(appDb, member.context, target.projectId)).toEqual(before);
    const created = ((await superuser.selectFrom('files').selectAll().where('org_id', '=', member.orgId).execute()) as { id: string; status: string; deleted_at: Date | null }[]).filter(
      (row) => !filesBefore.has(row.id),
    );
    expect(created).toHaveLength(2);
    for (const row of created) expect(row).toMatchObject({ status: 'uploaded', deleted_at: expect.any(Date) });
    expect(await superuser.selectFrom('artifacts').select('id').where('status', '=', 'writing').where('org_id', '=', member.orgId).execute()).toEqual([]);
    // 两份原件、第一份 Markdown 的副本留在（回收站中的文件的）对象中；失败的 Markdown 副本已删除。
    expect(objects.size).toBe(objectsBefore + 3);
  });
});
