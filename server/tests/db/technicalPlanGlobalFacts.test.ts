// 技术方案全局事实生成（路线图第 8 步 8.7c1，src/technicalPlan/jobs.ts 的 global-facts-generation）的数据库与接口测试：
// - Store：globalFactsInputSignature 覆盖的内容（招标文件、投标范围、原方案、招标解析项、目录结构与标题说明、全局事实的写法、引用的
//   知识库文档、全局事实；不含步骤、正文生成选项与正文），saveGlobalFactsResult 在签名不符时不写入、相符时与 saveGlobalFacts 相同地
//   整体替换并清空正文阶段；readGlobalFactsSources（各招标文件的原文与文件名、原方案、对象已不在存储中的跳过、tenders: false）；
//   readGlobalFactsKnowledgeItems（按引用顺序、文档内按条目顺序）；
// - 任务经真实数据库执行（假 Agent）：材料取自数据库，写入全局事实并清空正文阶段；开始后用户手动保存了全局事实时不覆盖；
// - 接口：POST .../global-facts-generation 的前置检查（文案与桌面版相同）、202 与 Agent 任务上限、与其他技术方案任务互斥、请求体不采用、
//   余额不足 402、其他组织 404；状态中的 globalFactsTask；招标文件变化与清空时取消。
// - 全局事实调整（8.7c2）：直接执行（假 Agent，接着生成的会话）、接口（前置检查、参数、202、互斥）、状态中的说明与能否调整、各重置入口
//   丢弃会话（导入 / 移除招标文件、切换单 / 多标段、选择投标范围、目录被清空、清空，多标段识别开始与全部重新解析）与不丢弃的入口。
// 与桌面版逐项对照见 tests/technicalPlan/globalFactsJob.test.ts、globalFactsAdjustmentJob.test.ts。
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentOpenOptions, AgentRun, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import { findWorkspaceSnapshot, writeWorkspaceSnapshot } from '../../src/agent/workspaceSnapshots.ts';
import { buildApp } from '../../src/app.ts';
import { writeArtifact } from '../../src/artifacts/store.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import type { JobContext } from '../../src/jobs/definitions.ts';
import {
  BID_ANALYSIS_JOB_TYPE,
  BID_SECTION_EXTRACTION_JOB_TYPE,
  createTechnicalPlanJobs,
  GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE,
  GLOBAL_FACTS_JOB_TYPE,
} from '../../src/technicalPlan/jobs.ts';
import {
  globalFactsInputSignature,
  importTenderFiles,
  loadTechnicalPlan,
  readGlobalFactsKnowledgeItems,
  readGlobalFactsSources,
  saveBidItems,
  saveBidSectionExtraction,
  saveChapterContent,
  saveContentGenerationOptions,
  saveDocumentParse,
  saveGeneratedOutline,
  saveGenerationConfig,
  saveGlobalFacts,
  saveGlobalFactsResult,
  saveOutline,
  setOriginalPlan,
  updateStep,
} from '../../src/technicalPlan/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const PASSWORD = 'quiet-harbor-maple-87';

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
let platformModelId: string;

const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

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

// ---- 数据准备 ----

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

/** 新成员（个人组织 owner）；默认已选择平台模型、充值 10 元。 */
async function newMember(options: { balance?: bigint } = {}): Promise<Member> {
  const hasher = await fastHasher();
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  await superuser.insertInto('org_settings').values({ org_id: orgId, platform_model_id: platformModelId, updated_by: userId }).execute();
  const balance = options.balance ?? 100_000n;
  if (balance > 0n) await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: balance, reference: null, note: '测试充值' });
  return { userId, orgId, cookie: await login(email), context: { orgId, userId, role: 'owner' } };
}

async function newProject(member: Member): Promise<string> {
  const row = await superuser.insertInto('projects').values({ org_id: member.orgId, kind: 'technical-plan', name: '技术方案', created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

async function newFile(member: Member, name: string, purpose = 'tender'): Promise<string> {
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      purpose,
      display_name: name,
      extension: 'docx',
      status: 'uploaded',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size_bytes: 100,
      sha256: Buffer.alloc(32),
      uploaded_at: new Date(),
      created_by: member.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 写入解析结果（与 document-parse 任务相同：Markdown 产物 + saveDocumentParse）；返回产物的对象键。 */
async function markParsed(member: Member, projectId: string, fileId: string, markdown: string): Promise<string> {
  const artifact = await writeArtifact(
    appDb,
    member.context,
    memoryStore,
    { kind: 'markdown', name: 'content.md', mime: 'text/markdown; charset=utf-8', projectId, sourceFileId: fileId },
    Buffer.from(`${markdown}\n`, 'utf8'),
  );
  expect(
    await saveDocumentParse(appDb, member.context, projectId, fileId, {
      status: 'success',
      markdownArtifactId: artifact.id,
      contentChars: markdown.length,
      contentHash: sha256(markdown),
      parserLabel: '本地解析',
    }),
  ).toBe(true);
  return (await superuser.selectFrom('artifacts').select('storage_key').where('id', '=', artifact.id).executeTakeFirstOrThrow()).storage_key;
}

/** 处理成功的知识库文档及其条目（经超级用户写入）。 */
async function newKnowledgeDocument(member: Member, items: { id: string; title: string; resume: string; content: string }[]): Promise<string> {
  const fileId = await newFile(member, '知识.docx', 'knowledge');
  const folder = await superuser.insertInto('knowledge_folders').values({ org_id: member.orgId, name: '资料', created_by: member.userId, updated_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  const document = await superuser.insertInto('knowledge_documents').values({ org_id: member.orgId, folder_id: folder.id, file_id: fileId, created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  await superuser.updateTable('knowledge_documents').set({ status: 'success', progress: 100 }).where('id', '=', document.id).execute();
  for (const [index, item] of items.entries()) {
    await superuser
      .insertInto('knowledge_items')
      .values({ org_id: member.orgId, document_id: document.id, item_id: item.id, title: item.title, resume: item.resume, content: item.content, content_chars: item.content.length, sort_order: index })
      .execute();
  }
  return document.id;
}

const TENDER_A = '# 招标公告\n\n工期：180 日历天。';
const TENDER_B = '## 技术规范\n\n7×24 运维。';

interface Fixture {
  projectId: string;
  tenders: string[];
  nodes: string[];
  tenderKeys: string[];
}

/** 两份已解析的招标文件、招标解析结果、目录（两章三节）；不引用知识库、没有原方案、没有全局事实。 */
async function fixture(member: Member, options: { outline?: boolean } = {}): Promise<Fixture> {
  const projectId = await newProject(member);
  const tenders = [await newFile(member, '招标文件 第一册.docx'), await newFile(member, '技术规范.pdf')];
  await importTenderFiles(appDb, member.context, projectId, tenders);
  const tenderKeys = [await markParsed(member, projectId, tenders[0]!, TENDER_A), await markParsed(member, projectId, tenders[1]!, TENDER_B)];
  await saveBidItems(appDb, member.context, projectId, {
    projectOverview: { status: 'success', content: '某市智慧水务平台' },
    projectInfo: { status: 'success', content: '预算 500 万元' },
    deliveryAndServiceRequirements: { status: 'success', content: '工期 180 日历天' },
  });
  const nodes = Array.from({ length: 4 }, () => randomUUID());
  if (options.outline !== false) {
    await saveGeneratedOutline(appDb, member.context, projectId, {
      outlineData: {
        outline: [
          { id: nodes[0], title: '项目理解', description: '背景', children: [{ id: nodes[1], title: '建设目标', description: '' }] },
          { id: nodes[2], title: '实施方案', description: '', children: [{ id: nodes[3], title: '进度计划', description: '工期' }] },
        ],
      },
      wordControlSnapshot: null,
    });
  }
  return { projectId, tenders, nodes, tenderKeys };
}

/** 脚本化的假 Agent：记下放入工作区的材料与提示词，读结果文件时返回给定的 global-facts.json；beforeValidate 在提交校验前执行。 */
function scriptedAgent(output: string, beforeValidate?: () => Promise<void>) {
  const record = { files: new Map<string, string>(), prompts: [] as string[] };
  const run = {
    sandbox: { id: 'sandbox-1' },
    resumed: false,
    unavailableProtectedFiles: [],
    taskCheckpoint: null,
    wasPrompted: () => false,
    baseline: {
      async write(_sandbox: unknown, _group: string, files: { path: string; data: Buffer }[]) {
        for (const file of files) record.files.set(file.path, file.data.toString('utf8'));
      },
    },
    async readFiles(paths: readonly string[]) {
      return new Map([[paths[0]!, { size: output.length, data: Buffer.from(output, 'utf8') }]]);
    },
    async runStage(stage: AgentStageOptions<unknown>) {
      record.prompts.push(stage.prompt);
      await beforeValidate?.();
      const report = await stage.validate({ attempt: 1, restored: [] });
      return { value: report.value, acceptedIssues: [], repairs: 0, executionRetries: 0 };
    },
    async close() {},
  };
  const agent: JobAgent = { template: 'agent', resuming: false, open: async () => run as unknown as AgentRun };
  return { agent, record };
}

const technicalPlanJobs = createTechnicalPlanJobs();

async function runJob(member: Member, projectId: string, agent: JobAgent | null, type = GLOBAL_FACTS_JOB_TYPE, params: unknown = {}): Promise<{ error: unknown; logs: string[] }> {
  const definition = technicalPlanJobs.find((job) => job.type === type)!;
  const logs: string[] = [];
  const context: JobContext<any> = {
    jobId: randomUUID(),
    projectId,
    type,
    attempt: 1,
    params: definition.parseParams(params),
    checkpoint: null,
    tenant: member.context,
    db: appDb,
    signal: new AbortController().signal,
    async setProgress() {},
    async saveCheckpoint() {},
    async log(message) {
      logs.push(message);
    },
    ai: null as never,
    objectStore: memoryStore,
    sandbox: null,
    agentWorkspace: null,
    agent,
  };
  try {
    await definition.run(context);
    return { error: null, logs };
  } catch (error) {
    return { error, logs };
  }
}

function call(member: Member, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const planUrl = (projectId: string, path = '') => `/api/projects/${projectId}/technical-plan${path}`;
const statusOf = async (jobId: string) => (await superuser.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status;

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
  await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'technical-plan-global-facts-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
  const model = await superuser
    .insertInto('platform_models')
    .values({ provider: 'deepseek', model: 'deepseek-chat', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin })
    .returning('id')
    .executeTakeFirstOrThrow();
  platformModelId = model.id;
  app = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    { database, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} }, objectStore: memoryStore },
  );
});

afterAll(async () => {
  await app?.close();
  await database?.destroy();
  await testDb?.drop();
});

const OUTPUT = JSON.stringify({
  groups: [
    { id: 'Schedule', title: '工期变量', content: '- 工期：180 日历天。' },
    { id: 'team', title: '项目角色变量', content: '- 项目经理：张伟。' },
  ],
});

describe('Store', () => {
  it('输入签名：招标文件、原方案、招标解析项、目录、全局事实的写法、引用的知识库文档与全局事实变化时改变；步骤、正文生成选项与正文不影响', async () => {
    const member = await newMember();
    const { projectId, nodes } = await fixture(member);
    const ctx = member.context;
    let previous = await globalFactsInputSignature(appDb, ctx, projectId);
    const expectChange = async (changed: boolean) => {
      const next = await globalFactsInputSignature(appDb, ctx, projectId);
      if (changed) expect(next).not.toBe(previous);
      else expect(next).toBe(previous);
      previous = next;
    };
    await updateStep(appDb, ctx, projectId, 'global-facts');
    await saveContentGenerationOptions(appDb, ctx, projectId, { wordCountRepair: false });
    await saveChapterContent(appDb, ctx, projectId, nodes[1]!, '手工正文');
    await expectChange(false);
    await saveGenerationConfig(appDb, ctx, projectId, { globalFactsMode: 'placeholder' });
    await expectChange(true);
    const document = await newKnowledgeDocument(member, [{ id: 'K1', title: '案例', resume: '', content: '正文' }]);
    await saveGenerationConfig(appDb, ctx, projectId, { referenceKnowledgeDocumentIds: [document] });
    await expectChange(true);
    await saveBidItems(appDb, ctx, projectId, { partAInfo: { status: 'success', content: '甲方' } });
    await expectChange(true);
    const outline = (await loadTechnicalPlan(appDb, ctx, projectId)).outlineData!;
    await saveOutline(appDb, ctx, projectId, { reason: 'edit', outlineData: { ...outline, outline: outline.outline.map((item, i) => (i === 0 ? { ...item, title: '新标题' } : item)) } });
    await expectChange(true);
    await saveGlobalFacts(appDb, ctx, projectId, [{ id: 'a', title: '手动', content: '内容' }]);
    await expectChange(true);
    const plan = await newFile(member, '原方案.docx');
    await setOriginalPlan(appDb, ctx, projectId, plan);
    await expectChange(true);
    await markParsed(member, projectId, plan, '# 原方案');
    await expectChange(true);
    await importTenderFiles(appDb, ctx, projectId, [await newFile(member, '补遗.docx')]);
    await expectChange(true);
  });

  it('saveGlobalFactsResult：签名不符时不写入；相符时整理后整体替换并清空正文阶段，内容未变的分组沿用 updated_at', async () => {
    const member = await newMember();
    const { projectId, nodes } = await fixture(member);
    const ctx = member.context;
    await saveGlobalFacts(appDb, ctx, projectId, [{ id: 'team', title: '项目角色变量', content: '- 项目经理：张伟。' }]);
    const before = (await loadTechnicalPlan(appDb, ctx, projectId)).globalFacts[0]!.updated_at;
    await saveChapterContent(appDb, ctx, projectId, nodes[1]!, '正文');
    const signature = await globalFactsInputSignature(appDb, ctx, projectId);
    expect(await saveGlobalFactsResult(appDb, ctx, projectId, [{ id: 'x', title: '旧', content: '旧' }], 'stale')).toBe(false);
    expect((await loadTechnicalPlan(appDb, ctx, projectId)).globalFacts.map((fact) => fact.id)).toEqual(['team']);
    const groups = [
      { id: 'Schedule', title: '工期变量', content: '- 工期：180 日历天。' },
      { id: 'team', title: '项目角色变量', content: '- 项目经理：张伟。' },
    ];
    expect(await saveGlobalFactsResult(appDb, ctx, projectId, groups, signature)).toBe(true);
    const state = await loadTechnicalPlan(appDb, ctx, projectId);
    expect(state.globalFacts.map(({ id, title, content }) => ({ id, title, content }))).toEqual([
      { id: 'schedule', title: '工期变量', content: '- 工期：180 日历天。' },
      { id: 'team', title: '项目角色变量', content: '- 项目经理：张伟。' },
    ]);
    expect(state.globalFacts[1]!.updated_at).toEqual(before);
    expect(state.contentGenerationSections[nodes[1]!]?.content ?? '').toBe('');
    // 写入改变了签名：同一签名不能再写一次。
    expect(await saveGlobalFactsResult(appDb, ctx, projectId, groups, signature)).toBe(false);
  });

  it('readGlobalFactsSources：各招标文件的原文与文件名（按导入顺序）、原方案；对象已不在存储中的跳过；tenders: false 时不读招标文件', async () => {
    const member = await newMember();
    const { projectId, tenderKeys } = await fixture(member);
    expect(await readGlobalFactsSources(appDb, member.context, projectId, memoryStore, { tenders: true })).toEqual({
      tenderFiles: [
        { fileName: '招标文件 第一册.docx', markdown: `${TENDER_A}\n` },
        { fileName: '技术规范.pdf', markdown: `${TENDER_B}\n` },
      ],
      originalPlanMarkdown: '',
    });
    const plan = await newFile(member, '原方案.docx');
    await setOriginalPlan(appDb, member.context, projectId, plan);
    await markParsed(member, projectId, plan, '# 原方案');
    objects.delete(tenderKeys[0]!);
    expect(await readGlobalFactsSources(appDb, member.context, projectId, memoryStore, { tenders: true })).toEqual({
      tenderFiles: [{ fileName: '技术规范.pdf', markdown: `${TENDER_B}\n` }],
      originalPlanMarkdown: '# 原方案\n',
    });
    expect(await readGlobalFactsSources(appDb, member.context, projectId, memoryStore, { tenders: false })).toEqual({ tenderFiles: [], originalPlanMarkdown: '# 原方案\n' });
    // 其他组织读不到。
    const other = await newMember();
    expect(await readGlobalFactsSources(appDb, other.context, projectId, memoryStore, { tenders: true })).toEqual({ tenderFiles: [], originalPlanMarkdown: '' });
  });

  it('readGlobalFactsKnowledgeItems：按引用顺序、文档内按条目顺序；没有引用时为空', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    expect(await readGlobalFactsKnowledgeItems(appDb, member.context, projectId)).toEqual([]);
    const first = await newKnowledgeDocument(member, [
      { id: 'B', title: '乙', resume: '简介', content: '正文乙' },
      { id: 'A', title: '甲', resume: '', content: '正文甲' },
    ]);
    const second = await newKnowledgeDocument(member, [{ id: 'C', title: '丙', resume: '', content: '正文丙' }]);
    await saveGenerationConfig(appDb, member.context, projectId, { referenceKnowledgeDocumentIds: [second, first] });
    expect(await readGlobalFactsKnowledgeItems(appDb, member.context, projectId)).toEqual([
      { documentId: second, itemId: 'C', title: '丙', resume: '', content: '正文丙' },
      { documentId: first, itemId: 'B', title: '乙', resume: '简介', content: '正文乙' },
      { documentId: first, itemId: 'A', title: '甲', resume: '', content: '正文甲' },
    ]);
  });
});

describe('任务（直接执行，假 Agent）', () => {
  it('材料取自数据库（各招标文件、解析结果、目录、知识库条目），写入全局事实并清空正文阶段', async () => {
    const member = await newMember();
    const { projectId, nodes } = await fixture(member);
    const document = await newKnowledgeDocument(member, [{ id: 'K1', title: '运维承诺', resume: '', content: '7×24 小时响应。' }]);
    await saveGenerationConfig(appDb, member.context, projectId, { referenceKnowledgeDocumentIds: [document], globalFactsMode: 'omit' });
    await saveChapterContent(appDb, member.context, projectId, nodes[1]!, '旧正文');
    const { agent, record } = scriptedAgent(OUTPUT);
    const result = await runJob(member, projectId, agent);
    expect(result.error).toBeNull();
    expect([...record.files.keys()]).toEqual([
      '招标文件/招标文件-01-招标文件_第一册.docx.md',
      '招标文件/招标文件-02-技术规范.pdf.md',
      '项目概述.md',
      '招标解析结果.md',
      '技术方案目录.md',
      '参考知识库/条目-1.md',
      '材料说明.md',
    ]);
    expect(record.files.get('招标文件/招标文件-01-招标文件_第一册.docx.md')).toBe(TENDER_A);
    expect(record.files.get('项目概述.md')).toBe('某市智慧水务平台');
    expect(record.files.get('招标解析结果.md')).toBe('## 项目信息\n预算 500 万元\n\n## 交货和服务要求\n工期 180 日历天');
    expect(record.files.get('技术方案目录.md')).toBe('- 1 项目理解：背景\n  - 1.1 建设目标\n- 2 实施方案\n  - 2.1 进度计划：工期');
    expect(record.files.get('参考知识库/条目-1.md')).toBe('# 运维承诺\n\n简介：无\n\n7×24 小时响应。');
    expect(record.prompts[0]).toContain('写成不涉及具体时间、地点、人员');
    const state = await loadTechnicalPlan(appDb, member.context, projectId);
    expect(state.globalFacts.map(({ id, title, content }) => ({ id, title, content }))).toEqual([
      { id: 'schedule', title: '工期变量', content: '- 工期：180 日历天。' },
      { id: 'team', title: '项目角色变量', content: '- 项目经理：张伟。' },
    ]);
    expect(state.contentGenerationSections[nodes[1]!]?.content ?? '').toBe('');
  });

  it('开始后用户手动保存了全局事实：结果不覆盖，任务以 TECHNICAL_PLAN_INPUT_CHANGED 失败', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const { agent } = scriptedAgent(OUTPUT, async () => {
      await saveGlobalFacts(appDb, member.context, projectId, [{ id: 'manual', title: '手动', content: '手动保存' }]);
    });
    const result = await runJob(member, projectId, agent);
    expect((result.error as { code?: string }).code).toBe('TECHNICAL_PLAN_INPUT_CHANGED');
    expect((await loadTechnicalPlan(appDb, member.context, projectId)).globalFacts.map((fact) => fact.id)).toEqual(['manual']);
  });
});

describe('接口', () => {
  it('前置检查（文案与桌面版相同）：没有招标文件、未解析完成、没有目录、原方案未解析完成时 409', async () => {
    const member = await newMember();
    const expectConflict = async (projectId: string, code: string, message: string) => {
      const response = await call(member, 'POST', planUrl(projectId, '/global-facts-generation'));
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toMatchObject({ code, message });
    };
    await expectConflict(await newProject(member), 'TECHNICAL_PLAN_TENDER_MISSING', '请先上传招标文件，再生成全局事实');
    const pending = await newProject(member);
    await importTenderFiles(appDb, member.context, pending, [await newFile(member, '招标.docx')]);
    await expectConflict(pending, 'TECHNICAL_PLAN_DOCUMENT_NOT_READY', '招标文件尚未全部解析完成，请稍后再试');
    const { projectId: noOutline } = await fixture(member, { outline: false });
    await expectConflict(noOutline, 'TECHNICAL_PLAN_OUTLINE_REQUIRED', '请先生成目录，再生成全局事实');
    const { projectId } = await fixture(member);
    await setOriginalPlan(appDb, member.context, projectId, await newFile(member, '原方案.docx'));
    await expectConflict(projectId, 'TECHNICAL_PLAN_ORIGINAL_PLAN_NOT_READY', '原方案尚未解析完成，请稍后再试');
  });

  it('202，写入 Agent 任务上限；与其他技术方案任务互斥；状态中返回；移除招标文件时取消；不采用请求体字段；余额不足 402；其他组织 404', async () => {
    const member = await newMember();
    const { projectId, tenders } = await fixture(member);
    expect((await call(member, 'GET', planUrl(projectId))).json().globalFactsTask).toBeNull();
    const started = await call(member, 'POST', planUrl(projectId, '/global-facts-generation'), { globalFactsMode: 'omit', orgId: randomUUID() });
    expect(started.statusCode, started.body).toBe(202);
    const job = started.json().job;
    expect(job).toMatchObject({ type: GLOBAL_FACTS_JOB_TYPE, status: 'queued', projectId });
    const row = await superuser.selectFrom('jobs').select(['lock_key', 'params']).where('id', '=', job.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ lock_key: `project:${projectId}:technical-plan`, params: {} });
    const budget = await superuser.selectFrom('agent_job_budgets').select(['cost_limit', 'turn_limit']).where('job_id', '=', job.id).executeTakeFirstOrThrow();
    expect(budget).toEqual({ cost_limit: '50000', turn_limit: 500 });
    const locked = await call(member, 'POST', planUrl(projectId, '/bid-analysis'), {});
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('JOB_LOCKED');
    expect((await call(member, 'GET', planUrl(projectId))).json().globalFactsTask).toMatchObject({ id: job.id, type: GLOBAL_FACTS_JOB_TYPE, status: 'queued' });
    expect((await call(member, 'DELETE', planUrl(projectId, `/tender-files/${tenders[1]}`))).statusCode).toBe(200);
    expect(await statusOf(job.id)).toBe('cancelled');

    const other = await newMember();
    expect((await call(other, 'POST', planUrl(projectId, '/global-facts-generation'))).statusCode).toBe(404);
    const poor = await newMember({ balance: 0n });
    const { projectId: poorProject } = await fixture(poor);
    expect((await call(poor, 'POST', planUrl(poorProject, '/global-facts-generation'))).statusCode).toBe(402);
  });

  it('清空技术方案时取消进行中的全局事实生成', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const started = await call(member, 'POST', planUrl(projectId, '/global-facts-generation'));
    expect(started.statusCode, started.body).toBe(202);
    expect((await call(member, 'DELETE', planUrl(projectId))).statusCode).toBe(200);
    expect(await statusOf(started.json().job.id)).toBe('cancelled');
  });
});

// ---- 全局事实调整（8.7c2） ----

const FACTS_KIND = 'technical-plan-global-facts';

/** 全局事实生成留下的会话：该类别当前的快照与引用它的已结束的生成任务（现场与执行者写下的相同）。 */
async function seedFactsSession(member: Member, projectId: string, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded') {
  const snapshot = await writeWorkspaceSnapshot(appDb, member.context, memoryStore, { projectId, taskKind: FACTS_KIND, fileCount: 1 }, Readable.from([Buffer.from('tar')]));
  const agent = {
    version: 1,
    session: `2026-11-19T01-02-03-004Z_${randomUUID()}.jsonl`,
    stage: 'global-facts',
    stageIndex: 0,
    promptedStage: 'global-facts',
    compactionPending: null,
    baseline: { version: 1, groups: {} },
    snapshot: snapshot.id,
  };
  const row = await superuser
    .insertInto('jobs')
    .values({
      org_id: member.orgId,
      project_id: projectId,
      user_id: member.userId,
      type: GLOBAL_FACTS_JOB_TYPE,
      status,
      lock_key: `project:${projectId}:technical-plan`,
      params: '{}',
      checkpoint: JSON.stringify({ agent, task: { signature: 'generated' } }),
      finished_at: new Date(),
      ...(status === 'failed' ? { error_code: 'JOB_FAILED', error_message: '失败' } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { snapshot, agent, jobId: row.id };
}

const currentFactsSnapshot = (member: Member, projectId: string) => findWorkspaceSnapshot(appDb, member.context, { projectId, taskKind: FACTS_KIND });

const FACTS = [
  { id: 'schedule', title: '工期变量', content: '- 工期：180 日历天。' },
  { id: 'team', title: '项目角色变量', content: '- 项目经理：张伟。' },
];

/** 全局事实调整用的假 Agent：记下打开时接着的会话与放入的 global-facts.json，按脚本写出结果与最后一条回复。 */
function adjustmentAgent(output: string, reply: string) {
  const record = { opened: [] as (AgentOpenOptions | undefined)[], files: new Map<string, string>(), released: [] as string[], prompts: [] as string[], checkpoints: [] as unknown[] };
  const run = {
    sandbox: { id: 'sandbox-1' },
    resumed: false,
    continued: true,
    unavailableProtectedFiles: [],
    taskCheckpoint: null,
    wasPrompted: () => false,
    baseline: {
      async write(_sandbox: unknown, _group: string, files: { path: string; data: Buffer }[]) {
        for (const file of files) record.files.set(file.path, file.data.toString('utf8'));
      },
      release(_group: string, paths: string[]) {
        record.released.push(...paths);
        return paths;
      },
    },
    async readFiles(paths: readonly string[]) {
      return new Map([[paths[0]!, { size: output.length, data: Buffer.from(output, 'utf8') }]]);
    },
    async runStage(stage: AgentStageOptions<unknown>) {
      record.prompts.push(stage.prompt);
      const report = await stage.validate({ attempt: 1, restored: [] });
      return { value: report.value, acceptedIssues: [], repairs: 0, executionRetries: 0 };
    },
    async assistantText() {
      return { text: reply, truncated: false };
    },
    async checkpoint(task: unknown) {
      record.checkpoints.push(task);
    },
    async close() {},
  };
  const agent: JobAgent = {
    template: 'agent',
    resuming: false,
    open: async (options?: AgentOpenOptions) => {
      record.opened.push(options);
      return run as unknown as AgentRun;
    },
  };
  return { agent, record };
}

const ADJUSTED = JSON.stringify({ groups: [{ id: 'schedule', title: '工期变量', content: '- 工期：150 日历天。' }, { id: 'Quality', title: '质量变量', content: '- 质量目标：合格。' }] });

describe('全局事实调整（8.7c2）', () => {
  it('直接执行（假 Agent）：接着生成的会话，global-facts.json 为当前全局事实（交给 Agent 修改）；写入调整后的全局事实并清空正文阶段；没有会话时失败', async () => {
    const member = await newMember();
    const { projectId, nodes } = await fixture(member);
    await saveGlobalFacts(appDb, member.context, projectId, FACTS);
    await saveChapterContent(appDb, member.context, projectId, nodes[1]!, '旧正文');
    const seeded = await seedFactsSession(member, projectId);
    const { agent, record } = adjustmentAgent(ADJUSTED, '已把工期改为 150 天。');
    const result = await runJob(member, projectId, agent, GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE, { requirement: '工期改为 150 天' });
    expect(result.error).toBeNull();
    expect(record.opened).toEqual([{ continueFrom: seeded.agent }]);
    expect(JSON.parse(record.files.get('global-facts.json')!)).toEqual({ groups: FACTS });
    expect([...record.files.keys()]).toEqual(['global-facts.json']);
    expect(record.released).toEqual(['global-facts.json']);
    expect(record.prompts[0]).toContain('用户的调整要求：\n工期改为 150 天');
    expect(record.checkpoints).toEqual([{ signature: expect.any(String), summary: '已把工期改为 150 天。' }]);
    const state = await loadTechnicalPlan(appDb, member.context, projectId);
    expect(state.globalFacts.map(({ id, title, content }) => ({ id, title, content }))).toEqual([
      { id: 'schedule', title: '工期变量', content: '- 工期：150 日历天。' },
      { id: 'quality', title: '质量变量', content: '- 质量目标：合格。' },
    ]);
    expect(state.contentGenerationSections[nodes[1]!]?.content ?? '').toBe('');
    // 任务日志不含要求与说明。
    expect(result.logs.join('\n')).not.toContain('工期改为 150 天');
    expect(result.logs.join('\n')).not.toContain('已把工期改为 150 天。');

    // 没有可续用的会话（快照被丢弃）：失败，不打开沙箱。
    await superuser.updateTable('agent_workspace_snapshots').set({ superseded_at: new Date() }).where('id', '=', seeded.snapshot.id).execute();
    const missing = adjustmentAgent(ADJUSTED, '');
    const failed = await runJob(member, projectId, missing.agent, GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE, { requirement: '工期改为 150 天' });
    expect(failed.error).toMatchObject({ code: 'TECHNICAL_PLAN_GLOBAL_FACTS_SESSION_MISSING', message: '全局事实设定的 Agent 工作空间不存在，请重新生成后再使用 AI 调整' });
    expect(missing.record.opened).toEqual([]);
  });

  it('接口：没有全局事实 409、会话不能续用 409（文案与桌面版相同）、调整要求为空或过长 400；可以调整时 202，参数为去掉首尾空白的要求，写入 Agent 上限，与其他技术方案任务互斥；其他组织 404', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const url = planUrl(projectId, '/global-facts-adjustment');
    const noFacts = await call(member, 'POST', url, { requirement: '统一工期' });
    expect(noFacts.statusCode).toBe(409);
    expect(noFacts.json().error).toMatchObject({ code: 'TECHNICAL_PLAN_GLOBAL_FACTS_REQUIRED', message: '当前没有可调整的全局事实，请先完成全局事实设定' });
    await saveGlobalFacts(appDb, member.context, projectId, FACTS);
    expect((await call(member, 'GET', planUrl(projectId))).json()).toMatchObject({ globalFactsAdjustable: false, globalFactsAdjustmentTask: null, globalFactsAdjustment: null });
    const noSession = await call(member, 'POST', url, { requirement: '统一工期' });
    expect(noSession.statusCode).toBe(409);
    expect(noSession.json().error).toMatchObject({ code: 'TECHNICAL_PLAN_GLOBAL_FACTS_SESSION_MISSING', message: '全局事实设定的 Agent 工作空间不存在，请重新生成后再使用 AI 调整' });
    // 被取消的生成任务的会话不续用。
    await seedFactsSession(member, projectId, 'cancelled');
    expect((await call(member, 'POST', url, { requirement: '统一工期' })).statusCode).toBe(409);
    await seedFactsSession(member, projectId, 'failed');
    expect((await call(member, 'GET', planUrl(projectId))).json().globalFactsAdjustable).toBe(true);

    for (const payload of [{ requirement: '   ' }, { requirement: '字'.repeat(2001) }, {}, { requirement: null }, { requirement: '统一', orgId: randomUUID() }]) {
      expect((await call(member, 'POST', url, payload)).statusCode).toBe(400);
    }
    const started = await call(member, 'POST', url, { requirement: '  统一工期\n' });
    expect(started.statusCode, started.body).toBe(202);
    const job = started.json().job;
    expect(job).toMatchObject({ type: GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE, status: 'queued', projectId });
    const row = await superuser.selectFrom('jobs').select(['lock_key', 'params']).where('id', '=', job.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ lock_key: `project:${projectId}:technical-plan`, params: { requirement: '统一工期' } });
    const budget = await superuser.selectFrom('agent_job_budgets').select(['cost_limit', 'turn_limit']).where('job_id', '=', job.id).executeTakeFirstOrThrow();
    expect(budget).toEqual({ cost_limit: '50000', turn_limit: 500 });
    expect((await call(member, 'POST', planUrl(projectId, '/global-facts-generation'))).json().error.code).toBe('JOB_LOCKED');
    expect((await call(member, 'GET', planUrl(projectId))).json()).toMatchObject({
      globalFactsAdjustmentTask: { id: job.id, type: GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE, status: 'queued' },
      globalFactsAdjustment: { requirement: '统一工期', summary: null },
    });
    // 清空技术方案时取消进行中的调整。
    expect((await call(member, 'DELETE', planUrl(projectId))).statusCode).toBe(200);
    expect(await statusOf(job.id)).toBe('cancelled');

    const other = await newMember();
    expect((await call(other, 'POST', url, { requirement: '统一工期' })).statusCode).toBe(404);
  });

  it('状态中的说明：最近一次调整成功时为 checkpoint 中的说明（截到 2000 字），失败时为 null', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const insert = async (status: string, summary: unknown) =>
      superuser
        .insertInto('jobs')
        .values({
          org_id: member.orgId,
          project_id: projectId,
          user_id: member.userId,
          type: GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE,
          status,
          params: JSON.stringify({ requirement: '统一工期' }),
          checkpoint: JSON.stringify({ agent: {}, task: { signature: 's', summary } }),
          finished_at: new Date(),
          ...(status === 'failed' ? { error_code: 'JOB_FAILED', error_message: '失败' } : {}),
        })
        .execute();
    await insert('succeeded', '已统一工期。');
    expect((await call(member, 'GET', planUrl(projectId))).json().globalFactsAdjustment).toEqual({ requirement: '统一工期', summary: '已统一工期。' });
    await insert('failed', '不应显示');
    expect((await call(member, 'GET', planUrl(projectId))).json().globalFactsAdjustment).toEqual({ requirement: '统一工期', summary: null });
    await insert('succeeded', '长'.repeat(3000));
    expect((await call(member, 'GET', planUrl(projectId))).json().globalFactsAdjustment.summary).toHaveLength(2000);
    await insert('succeeded', 42);
    expect((await call(member, 'GET', planUrl(projectId))).json().globalFactsAdjustment).toEqual({ requirement: '统一工期', summary: null });
  });

  it('导入、移除招标文件，切换单 / 多标段，选择投标范围，目录被清空，清空时丢弃会话；保存全局事实、目录排序、生成配置的其他字段、步骤、原方案时不丢弃', async () => {
    const member = await newMember();
    const { projectId, tenders, nodes } = await fixture(member);
    const keeps: [string, string, unknown][] = [
      ['PUT', '/global-facts', { globalFacts: FACTS }],
      [
        'PUT',
        '/outline',
        {
          outlineData: {
            outline: [
              { id: nodes[2], title: '实施方案', description: '', children: [{ id: nodes[3], title: '进度计划', description: '工期' }] },
              { id: nodes[0], title: '项目理解', description: '背景', children: [{ id: nodes[1], title: '建设目标', description: '' }] },
            ],
          },
          reason: 'sort',
        },
      ],
      ['PATCH', '/generation-config', { globalFactsMode: 'omit', bidSectionMode: 'single' }],
      ['PUT', '/bid-analysis-config', { mode: 'custom', selectedTaskIds: ['projectInfo'], bidSectionMode: 'single' }],
      ['PATCH', '/step', { step: 'global-facts' }],
      ['PUT', '/original-plan', { fileId: await newFile(member, '原方案.docx') }],
      ['DELETE', '/original-plan', undefined],
    ];
    const seeded = await seedFactsSession(member, projectId);
    for (const [method, path, payload] of keeps) {
      const response = await call(member, method as 'PUT', planUrl(projectId, path), payload);
      expect(response.statusCode, `${method} ${path} ${response.body}`).toBe(200);
      expect((await currentFactsSnapshot(member, projectId))?.id, `${method} ${path}`).toBe(seeded.snapshot.id);
    }
    expect(objects.has(seeded.snapshot.storageKey)).toBe(true);

    const sections = [
      { id: 's1', title: '一标段', includeRanges: [{ startLine: 1, endLine: 1 }] },
      { id: 's2', title: '二标段', includeRanges: [{ startLine: 3, endLine: 3 }] },
    ];
    const discards: [string, string, unknown, (() => Promise<void>)?][] = [
      ['PATCH', '/generation-config', { bidSectionMode: 'multiple' }],
      ['PATCH', '/generation-config', { bidSectionMode: 'single' }],
      ['PUT', '/bid-analysis-config', { mode: 'custom', selectedTaskIds: ['projectInfo'], bidSectionMode: 'multiple' }],
      [
        'PUT',
        '/bid-section',
        { sectionId: 's1' },
        async () => {
          await saveBidSectionExtraction(appDb, member.context, projectId, { status: 'success', sections });
        },
      ],
      ['PUT', '/outline', { outlineData: null, reason: 'replace' }],
      ['POST', '/tender-files', { fileIds: [await newFile(member, '补充文件.docx')] }],
      ['DELETE', `/tender-files/${tenders[1]}`, undefined],
      ['DELETE', '', undefined],
    ];
    for (const [method, path, payload, prepare] of discards) {
      await prepare?.();
      const { snapshot } = await seedFactsSession(member, projectId);
      const response = await call(member, method as 'PUT', planUrl(projectId, path), payload);
      expect(response.statusCode, `${method} ${path} ${response.body}`).toBe(200);
      expect(await currentFactsSnapshot(member, projectId), `${method} ${path}`).toBeNull();
      // 有对象存储时一并删除对象与行。
      expect(objects.has(snapshot.storageKey)).toBe(false);
      expect(await superuser.selectFrom('agent_workspace_snapshots').select('id').where('id', '=', snapshot.id).executeTakeFirst()).toBeUndefined();
    }
  });

  it('多标段识别开始、全部重新解析（目录与全局事实被清空）时由任务丢弃会话；只重新解析部分解析项时不丢弃', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const failingAi = { chat: async () => { throw new Error('模型不可用'); } };
    const run = async (type: string, params: unknown) => {
      const definition = technicalPlanJobs.find((job) => job.type === type)!;
      const context: JobContext<any> = {
        jobId: randomUUID(),
        projectId,
        type,
        attempt: 1,
        params: definition.parseParams(params),
        checkpoint: null,
        tenant: member.context,
        db: appDb,
        signal: new AbortController().signal,
        async setProgress() {},
        async saveCheckpoint() {},
        async log() {},
        ai: failingAi as never,
        objectStore: memoryStore,
        sandbox: null,
        agentWorkspace: null,
        agent: null,
      };
      await definition.run(context).catch(() => {});
    };
    await seedFactsSession(member, projectId);
    await run(BID_ANALYSIS_JOB_TYPE, { taskIds: ['projectInfo'], forceRerun: false });
    expect(await currentFactsSnapshot(member, projectId)).not.toBeNull();
    await run(BID_ANALYSIS_JOB_TYPE, { taskIds: null, forceRerun: true });
    expect(await currentFactsSnapshot(member, projectId)).toBeNull();
    await seedFactsSession(member, projectId);
    await run(BID_SECTION_EXTRACTION_JOB_TYPE, {});
    expect(await currentFactsSnapshot(member, projectId)).toBeNull();
  });
});
