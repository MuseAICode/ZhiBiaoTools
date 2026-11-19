// 可研报告任务（路线图第 6 步 6.12，src/feasibilityReport/jobs.ts）的数据库与接口测试：
// - Store：输入签名覆盖的内容（项目信息、资料、资料分析、目录结构、关键参数；不含步骤、目录配置和正文），任务写入在签名不符时
//   不写入，合并的资料正文，引用的知识库条目（只取处理成功的文档）；
// - 正文锁：正文生成或审校任务未结束时不能保存目录、手工改正文（409），任务自己的写入不受影响；
// - 四类任务经真实数据库执行（模型用桩）：资料分析读合并的资料正文、关键参数读引用的知识库条目、正文生成与审校；
// - 接口：开始任务的前置检查与互斥、余额不足 402、正文暂停中不能启动其他任务，保存上游内容、资料变化与清空时取消任务，
//   状态中返回最近的任务；
// - 经 worker（真实 Valkey）从接口入队到执行完成的完整流程。
// 与桌面版的请求序列对照见 tests/feasibilityReport/jobs.test.ts。
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiGateway, ChatRequest, ChatResult } from '../../src/ai/gateway.ts';
import { buildApp } from '../../src/app.ts';
import { writeArtifact } from '../../src/artifacts/store.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import {
  createFeasibilityReportJobs,
  FEASIBILITY_ANALYSIS_JOB_TYPE,
  FEASIBILITY_CONTENT_JOB_TYPE,
  FEASIBILITY_HUMAN_WRITING_JOB_TYPE,
  FEASIBILITY_OUTLINE_JOB_TYPE,
  FEASIBILITY_PARAMETERS_JOB_TYPE,
} from '../../src/feasibilityReport/jobs.ts';
import {
  clearChapterContents,
  importSources,
  inputSignature,
  loadFeasibilityReport,
  readCombinedSourceMarkdown,
  readReferenceKnowledgeItems,
  saveAnalysis,
  saveAnalysisResult,
  saveChapterContent,
  saveChapterResult,
  saveKeyParameters,
  saveKeyParametersResult,
  saveOutline,
  saveOutlineConfig,
  saveOutlineResult,
  saveProjectInfo,
  saveSourceParse,
  updateStep,
  type FeasibilityOutlineItem,
} from '../../src/feasibilityReport/store.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import type { AgentRun, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import type { JobChatRequest, JobContext, JobTypeDefinition } from '../../src/jobs/definitions.ts';
import { createJobDispatcher } from '../../src/jobs/queue.ts';
import { jobTypeRegistry } from '../../src/jobs/registry.ts';
import { createJobRunner } from '../../src/jobs/runner.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { redisConfig, testLogger, uniquePrefix, waitFor } from './jobFixtures.ts';

const PASSWORD = 'quiet-harbor-maple-71';

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
  const row = await superuser.insertInto('projects').values({ org_id: member.orgId, kind: 'feasibility-report', name: '可研', created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
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

/** 写入资料的解析结果（与 document-parse 任务相同：Markdown 产物 + saveSourceParse）。 */
async function markParsed(member: Member, projectId: string, fileId: string, markdown: string): Promise<void> {
  const artifact = await writeArtifact(
    appDb,
    member.context,
    memoryStore,
    { kind: 'markdown', name: 'content.md', mime: 'text/markdown; charset=utf-8', projectId, sourceFileId: fileId },
    Buffer.from(`${markdown}\n`, 'utf8'),
  );
  expect(
    await saveSourceParse(appDb, member.context, projectId, fileId, {
      status: 'success',
      markdownArtifactId: artifact.id,
      contentChars: markdown.length,
      contentHash: sha256(markdown),
      parserLabel: '本地解析',
    }),
  ).toBe(true);
}

/** 处理成功的知识库文档及其最终条目（经超级用户写入）。 */
async function newKnowledgeDocument(member: Member, items: { id: string; title: string; resume: string; content: string }[], status = 'success'): Promise<string> {
  const fileId = await newFile(member, '知识.docx', 'knowledge');
  const folder = await superuser.insertInto('knowledge_folders').values({ org_id: member.orgId, name: '资料', created_by: member.userId, updated_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  const document = await superuser.insertInto('knowledge_documents').values({ org_id: member.orgId, folder_id: folder.id, file_id: fileId, created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  await superuser.updateTable('knowledge_documents').set({ status, progress: status === 'success' ? 100 : 0 }).where('id', '=', document.id).execute();
  for (const [index, item] of items.entries()) {
    await superuser
      .insertInto('knowledge_items')
      .values({ org_id: member.orgId, document_id: document.id, item_id: item.id, title: item.title, resume: item.resume, content: item.content, content_chars: item.content.length, sort_order: index })
      .execute();
  }
  return document.id;
}

const PROJECT_INFO = { projectName: '城区供水管网改造工程', industry: '市政公用', constructionContent: '改造供水管网 12 公里' };

const OUTLINE: FeasibilityOutlineItem[] = [
  { id: '1', title: '概述', description: '', children: [{ id: '1.1', title: '项目概况', description: '' }, { id: '1.2', title: '编制依据', description: '' }] },
  { id: '2', title: '项目建设方案', description: '管网工程方案' },
];

interface Fixture {
  projectId: string;
  sources: string[];
}

/** 已填写项目信息、导入两份已解析的资料；stage 决定已有的下游结果。 */
async function fixture(member: Member, stage: 'materials' | 'outline' | 'parameters' | 'content' = 'materials'): Promise<Fixture> {
  const projectId = await newProject(member);
  await saveProjectInfo(appDb, member.context, projectId, PROJECT_INFO);
  const sources = [await newFile(member, '可研资料-一.docx'), await newFile(member, '可研资料-二.docx')];
  await importSources(appDb, member.context, projectId, sources);
  await markParsed(member, projectId, sources[0]!, '管网长度 12 公里。');
  await markParsed(member, projectId, sources[1]!, '  \n水厂规模 5 万吨。\n');
  if (stage === 'materials') return { projectId, sources };
  await saveAnalysis(appDb, member.context, projectId, '## 项目概况\n\n管网 12 公里。');
  await saveOutline(appDb, member.context, projectId, { outlineData: { outline: OUTLINE }, reason: 'replace' });
  if (stage === 'outline') return { projectId, sources };
  await saveKeyParameters(appDb, member.context, projectId, '## 项目身份信息\n\n- 管网 12 公里');
  if (stage === 'parameters') return { projectId, sources };
  for (const id of ['1.1', '1.2', '2']) await saveChapterContent(appDb, member.context, projectId, id, `${id} 已有正文，共 3 段。`);
  return { projectId, sources };
}

// ---- 模型桩 ----

type Responder = (request: JobChatRequest) => string | Promise<string>;

const defaultResponder: Responder = (request) => {
  const key = request.stepKey;
  if (key.endsWith('warmup')) return '';
  if (key.startsWith('analysis')) return JSON.stringify({ project_overview: '管网 12 公里', missing_information: '- 缺少投资估算' });
  if (key === 'parameters') return '## 项目身份信息\n\n- 新的关键参数';
  const content = /^content:(.+)$/.exec(key);
  if (content) return `${content[1]} 的正文，共 3 段。`;
  const review = /^review:(.+)$/.exec(key);
  if (review) return `${review[1]} 审校后的正文，共 3 段。`;
  throw new Error(`unexpected step ${key}`);
};

function chatResult(content: string): ChatResult {
  return {
    requestId: randomUUID(),
    content,
    reasoningContent: '',
    toolCalls: [],
    finishReason: 'stop',
    aborted: false,
    reused: false,
    usage: { inputTokens: 1, outputTokens: 1 } as unknown as ChatResult['usage'],
    billing: { status: 'billed', amount: 1n },
  };
}

const jobs = createFeasibilityReportJobs({ warmupSettleMs: 0 });
const jobOf = (type: string) => jobs.find((job) => job.type === type)! as JobTypeDefinition<any>;

interface RunResult {
  error: unknown;
  logs: string[];
  requests: JobChatRequest[];
}

/** 以给定的上下文直接执行任务类型的 run（不经队列）。 */
async function runJob(type: string, member: Member, projectId: string, respond: Responder = defaultResponder, params: unknown = {}, agent: JobAgent | null = null): Promise<RunResult> {
  const definition = jobOf(type);
  const logs: string[] = [];
  const requests: JobChatRequest[] = [];
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
    ai: {
      async chat(request) {
        requests.push(request);
        return chatResult(await respond(request));
      },
    },
    objectStore: memoryStore,
    sandbox: null,
    agentWorkspace: null,
    agent,
  };
  try {
    await definition.run(context);
    return { error: null, logs, requests };
  } catch (error) {
    return { error, logs, requests };
  }
}

function call(member: Member, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const reportUrl = (projectId: string, path = '') => `/api/projects/${projectId}/feasibility-report${path}`;

/** 直接插入一个任务记录（模拟排队、暂停等状态）。 */
async function insertJob(member: Member, projectId: string, type: string, status: string): Promise<string> {
  const row = await superuser
    .insertInto('jobs')
    .values({
      org_id: member.orgId,
      project_id: projectId,
      user_id: member.userId,
      type,
      status,
      lock_key: `project:${projectId}:feasibility-report`,
      params: JSON.stringify(type === FEASIBILITY_CONTENT_JOB_TYPE ? { onlyMissing: false } : {}),
      ...(['succeeded', 'failed', 'cancelled'].includes(status) ? { finished_at: new Date() } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

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
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'feasibility-jobs-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
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

describe('Store：输入签名与任务写入', () => {
  it('签名随项目信息、资料、资料分析、目录结构、关键参数变化；不随步骤、目录配置和正文变化', async () => {
    const member = await newMember();
    const { projectId, sources } = await fixture(member, 'parameters');
    const signature = () => inputSignature(appDb, member.context, projectId);
    let current = await signature();
    const changes = async (change: () => Promise<unknown>) => {
      await change();
      const next = await signature();
      const changed = next !== current;
      current = next;
      return changed;
    };
    expect(await changes(() => updateStep(appDb, member.context, projectId, 'content'))).toBe(false);
    expect(await changes(() => saveOutlineConfig(appDb, member.context, projectId, { outlineTemplate: 'enterprise', targetWords: 50000, referenceDocumentIds: [] }))).toBe(false);
    expect(await changes(() => saveChapterContent(appDb, member.context, projectId, '2', '手工正文'))).toBe(false);
    expect(await changes(() => saveKeyParameters(appDb, member.context, projectId, '## 新参数'))).toBe(true);
    expect(await changes(() => saveOutline(appDb, member.context, projectId, { outlineData: { outline: [OUTLINE[1]!, OUTLINE[0]!] }, reason: 'sort' }))).toBe(true);
    expect(await changes(() => saveAnalysis(appDb, member.context, projectId, '## 新分析'))).toBe(true);
    expect(await changes(() => saveSourceParse(appDb, member.context, projectId, sources[0]!, { contentHash: 'other' }))).toBe(true);
    expect(await changes(() => saveProjectInfo(appDb, member.context, projectId, { ...PROJECT_INFO, location: '新城区' }))).toBe(true);
  });

  it('任务写入在签名不符时不写入；相符时与用户保存相同清空下游；正文写入不受正文锁影响', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member, 'content');
    const signature = await inputSignature(appDb, member.context, projectId);
    expect(await saveAnalysisResult(appDb, member.context, projectId, '旧任务的分析', 'stale')).toBe(false);
    expect(await saveKeyParametersResult(appDb, member.context, projectId, '旧任务的参数', 'stale')).toBe(false);
    expect(await clearChapterContents(appDb, member.context, projectId, 'stale')).toBe(false);
    expect(await saveChapterResult(appDb, member.context, projectId, '2', '旧任务的正文', 'stale')).toBe(false);
    let state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(state.analysisMarkdown).toBe('## 项目概况\n\n管网 12 公里。');
    expect(state.outlineData!.outline[1]!.content).toBe('2 已有正文，共 3 段。');

    // 正文任务未结束时用户不能改正文，任务自己的写入照常；章节不存在时返回 false。
    await insertJob(member, projectId, FEASIBILITY_CONTENT_JOB_TYPE, 'queued');
    await expect(saveChapterContent(appDb, member.context, projectId, '2', '手工')).rejects.toMatchObject({ statusCode: 409, code: 'FEASIBILITY_REPORT_CONTENT_LOCKED' });
    expect(await saveChapterResult(appDb, member.context, projectId, '2', '任务正文', signature)).toBe(true);
    expect(await saveChapterResult(appDb, member.context, projectId, 'missing', '任务正文', signature)).toBe(false);
    expect(await clearChapterContents(appDb, member.context, projectId, signature)).toBe(true);
    state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(collectContents(state.outlineData!.outline)).toEqual([]);

    expect(await saveKeyParametersResult(appDb, member.context, projectId, '  ## 任务参数  ', signature)).toBe(true);
    const afterParameters = await inputSignature(appDb, member.context, projectId);
    expect((await loadFeasibilityReport(appDb, member.context, projectId)).keyParametersMarkdown).toBe('## 任务参数');
    expect(await saveAnalysisResult(appDb, member.context, projectId, '## 任务分析', afterParameters)).toBe(true);
    state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(state).toMatchObject({ analysisMarkdown: '## 任务分析', keyParametersMarkdown: '', outlineData: null });
  });

  it('目录生成的结果（8.7a）：签名不符时不写入；相符时整体替换目录、清空正文与关键参数，写入项目名称与概述；超长字段截短', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member, 'content');
    const generated: FeasibilityOutlineItem[] = [
      {
        id: '1',
        title: '概述',
        description: '概述说明',
        children: [{ id: '1.1', title: 'x'.repeat(2100), description: '叶子', knowledge_item_ids: ['doc::a', 'doc::b'] }],
      },
      { id: '2', title: '研究结论及建议', description: 'y'.repeat(20_100) },
    ];
    const input = { outline: generated, projectName: '城区供水管网改造工程', projectOverview: '## 项目概况\n\n管网 12 公里。' };
    expect(await saveOutlineResult(appDb, member.context, projectId, input, 'stale')).toBe(false);
    let state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(state.outlineData!.outline.map((item) => item.id)).toEqual(['1', '2']);
    expect(state.keyParametersMarkdown).not.toBe('');

    const signature = await inputSignature(appDb, member.context, projectId);
    expect(await saveOutlineResult(appDb, member.context, projectId, input, signature)).toBe(true);
    state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(state.keyParametersMarkdown).toBe('');
    expect(state.outlineData).toEqual({
      outline: [
        { id: '1', title: '概述', description: '概述说明', children: [{ id: '1.1', title: 'x'.repeat(2000), description: '叶子', knowledge_item_ids: ['doc::a', 'doc::b'] }] },
        { id: '2', title: '研究结论及建议', description: 'y'.repeat(20_000) },
      ],
      project_name: '城区供水管网改造工程',
      project_overview: '## 项目概况\n\n管网 12 公里。',
    });
    expect(collectContents(state.outlineData!.outline)).toEqual([]);
    // 写入后签名变化：同一任务的第二次写入被拒绝。
    expect(await saveOutlineResult(appDb, member.context, projectId, input, signature)).toBe(false);
    await expect(
      saveOutlineResult(appDb, member.context, projectId, { ...input, outline: [{ id: '1', title: 'a', description: '' }, { id: '1', title: 'b', description: '' }] }, await inputSignature(appDb, member.context, projectId)),
    ).rejects.toThrow(TypeError);
  });

  it('合并的资料正文按导入顺序、以“## 文件名”开头；还没有解析的资料不在其中', async () => {
    const member = await newMember();
    const { projectId, sources } = await fixture(member);
    expect(await readCombinedSourceMarkdown(appDb, member.context, projectId, memoryStore)).toBe('## 可研资料-一.docx\n\n管网长度 12 公里。\n\n## 可研资料-二.docx\n\n水厂规模 5 万吨。');
    await importSources(appDb, member.context, projectId, [sources[1]!, sources[0]!, await newFile(member, '待解析.docx')]);
    expect(await readCombinedSourceMarkdown(appDb, member.context, projectId, memoryStore)).toBe('## 可研资料-二.docx\n\n水厂规模 5 万吨。\n\n## 可研资料-一.docx\n\n管网长度 12 公里。');
    await expect(readCombinedSourceMarkdown(appDb, member.context, projectId, null)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('引用的知识库条目只取处理成功的文档，按引用顺序；原件删除后不再读到', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const first = await newKnowledgeDocument(member, [{ id: 'K1', title: '管网方案', resume: '方案简介', content: '方案正文' }]);
    const pending = await newKnowledgeDocument(member, [{ id: 'K2', title: '未完成', resume: '简介', content: '正文' }], 'pending');
    const second = await newKnowledgeDocument(member, [
      { id: 'K3', title: '依据', resume: '依据简介', content: '依据正文' },
      { id: 'K4', title: '无简介', resume: '', content: '只有正文' },
    ]);
    await saveOutlineConfig(appDb, member.context, projectId, { outlineTemplate: 'government', targetWords: 30000, referenceDocumentIds: [second, pending, first] });
    expect((await readReferenceKnowledgeItems(appDb, member.context, projectId)).map((item) => `${item.documentId === second ? 'B' : 'A'}:${item.itemId}`)).toEqual(['B:K3', 'B:K4', 'A:K1']);
    const fileId = (await superuser.selectFrom('knowledge_documents').select('file_id').where('id', '=', second).executeTakeFirstOrThrow()).file_id;
    await superuser.updateTable('files').set({ deleted_at: new Date(), deleted_by: member.userId }).where('id', '=', fileId).execute();
    expect((await readReferenceKnowledgeItems(appDb, member.context, projectId)).map((item) => item.itemId)).toEqual(['K1']);
  });
});

function collectContents(items: readonly FeasibilityOutlineItem[]): string[] {
  return items.flatMap((item) => [...(item.content ? [`${item.id}:${item.content}`] : []), ...collectContents(item.children ?? [])]);
}

/** 脚本化的假 Agent：记下放入工作区的材料与提示词，读结果文件时返回给定的 outline.json。 */
function scriptedAgent(output: string) {
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
      const report = await stage.validate({ attempt: 1, restored: [] });
      return { value: report.value, acceptedIssues: [], repairs: 0, executionRetries: 0 };
    },
    async close() {},
  };
  const agent: JobAgent = { template: 'agent', resuming: false, open: async () => run as unknown as AgentRun };
  return { agent, record };
}

describe('四类任务（直接执行）', () => {
  it('目录生成（8.7a，假 Agent）：材料取已保存的目录配置与引用的知识库条目，写入目录并清空正文与关键参数；Agent 写的知识库条目只保留本次清单中的', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member, 'content');
    const document = await newKnowledgeDocument(member, [
      { id: 'K1', title: '管网方案', resume: '管网工程方案', content: '正文' },
      { id: 'K2', title: '无简介', resume: '', content: '只有正文' },
    ]);
    await saveOutlineConfig(appDb, member.context, projectId, { outlineTemplate: 'infrastructure', targetWords: 80000, referenceDocumentIds: [document] });
    const output = JSON.stringify({
      outline: [
        { title: '第一章 概述', description: '概述', children: [{ title: '项目概况', description: '叶子', knowledge_item_ids: [`${document}::K1`, `${document}::K2`, 'other::K9'] }] },
        { title: '研究结论', description: '' },
      ],
    });
    const { agent, record } = scriptedAgent(output);
    const result = await runJob(FEASIBILITY_OUTLINE_JOB_TYPE, member, projectId, defaultResponder, {}, agent);
    expect(result.error).toBeNull();
    expect(result.requests).toEqual([]);
    expect([...record.files.keys()]).toEqual(['项目参数.md', '资料分析.md', '大纲模板.md', '参考知识库.md', '材料说明.md']);
    expect(record.files.get('大纲模板.md')).toContain('# 选用的通用大纲：基础设施与公用事业大纲');
    expect(record.files.get('大纲模板.md')).toContain('目标总字数约 80000 字。');
    expect(JSON.parse(record.files.get('参考知识库.md')!)).toEqual([{ id: `${document}::K1`, title: '管网方案', resume: '管网工程方案' }]);
    expect(record.files.get('资料分析.md')).toBe('## 项目概况\n\n管网 12 公里。');
    expect(record.prompts[0]).toContain('目标总字数约 80000 字');
    const state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(state.outlineData).toEqual({
      outline: [
        { id: '1', title: '概述', description: '概述', children: [{ id: '1.1', title: '项目概况', description: '叶子', knowledge_item_ids: [`${document}::K1`] }] },
        { id: '2', title: '研究结论', description: '' },
      ],
      project_name: '城区供水管网改造工程',
      project_overview: '## 项目概况\n\n管网 12 公里。',
    });
    expect(state.keyParametersMarkdown).toBe('');
  });


  it('资料分析读合并的资料正文，结果整理成 Markdown 写入并清空目录和关键参数', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member, 'parameters');
    const result = await runJob(FEASIBILITY_ANALYSIS_JOB_TYPE, member, projectId);
    expect(result.error).toBeNull();
    expect(result.requests.map((request) => request.stepKey)).toEqual(['analysis']);
    expect(result.requests[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(result.requests[0]!.messages[1]!.content).toContain('## 可研资料-一.docx\n\n管网长度 12 公里。\n\n## 可研资料-二.docx\n\n水厂规模 5 万吨。');
    const state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(state.analysisMarkdown).toContain('## 项目概况\n\n管网 12 公里');
    expect(state.analysisMarkdown).toContain('## 缺失资料清单\n\n- 缺少投资估算');
    expect(state).toMatchObject({ outlineData: null, keyParametersMarkdown: '' });
    expect(result.logs).toEqual(['开始分析项目资料。', '正在提取资料事实。', '资料分析完成。']);
  });

  it('资料分析的前置条件：项目名称必填、资料须全部解析成功', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    expect((await runJob(FEASIBILITY_ANALYSIS_JOB_TYPE, member, projectId)).error).toMatchObject({ code: 'FEASIBILITY_REPORT_PROJECT_INFO_REQUIRED', message: '请先填写项目名称' });
    await saveProjectInfo(appDb, member.context, projectId, PROJECT_INFO);
    const fileId = await newFile(member, '资料.docx');
    await importSources(appDb, member.context, projectId, [fileId]);
    expect((await runJob(FEASIBILITY_ANALYSIS_JOB_TYPE, member, projectId)).error).toMatchObject({ code: 'FEASIBILITY_REPORT_SOURCE_NOT_READY' });
    await saveSourceParse(appDb, member.context, projectId, fileId, { status: 'error', error: '解析失败' });
    expect((await runJob(FEASIBILITY_ANALYSIS_JOB_TYPE, member, projectId)).error).toMatchObject({ code: 'FEASIBILITY_REPORT_SOURCE_FAILED' });
  });

  it('关键参数读引用的知识库条目，写入后清空正文；任务开始后目录变化时不写入', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member, 'content');
    const documentId = await newKnowledgeDocument(member, [{ id: 'K1', title: '管网方案', resume: '方案简介', content: '方案正文' }]);
    await saveOutlineConfig(appDb, member.context, projectId, { outlineTemplate: 'government', targetWords: 30000, referenceDocumentIds: [documentId] });
    const result = await runJob(FEASIBILITY_PARAMETERS_JOB_TYPE, member, projectId);
    expect(result.error).toBeNull();
    expect(result.requests[0]!.messages[3]!.content).toContain(`"id": "${documentId}::K1"`);
    let state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(state.keyParametersMarkdown).toBe('## 项目身份信息\n\n- 新的关键参数');
    expect(collectContents(state.outlineData!.outline)).toEqual([]);

    await saveKeyParameters(appDb, member.context, projectId, '## 手工参数');
    const changed = await runJob(FEASIBILITY_PARAMETERS_JOB_TYPE, member, projectId, async (request) => {
      await saveOutline(appDb, member.context, projectId, { outlineData: { outline: OUTLINE.slice(1) }, reason: 'delete' });
      return defaultResponder(request);
    });
    expect(changed.error).toMatchObject({ code: 'FEASIBILITY_REPORT_INPUT_CHANGED' });
    state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(state.keyParametersMarkdown).toBe('');
  });

  it('正文生成：清空旧正文后逐章生成并审校；只补充未完成章节时保留已有正文；单独的自然化审校', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member, 'content');
    let result = await runJob(FEASIBILITY_CONTENT_JOB_TYPE, member, projectId, defaultResponder, { onlyMissing: false });
    expect(result.error).toBeNull();
    expect(result.requests.map((request) => request.stepKey)).toEqual(['content:warmup', 'content:1.1', 'content:1.2', 'content:2', 'review:warmup', 'review:1.1', 'review:1.2', 'review:2']);
    let state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(collectContents(state.outlineData!.outline)).toEqual(['1.1:1.1 审校后的正文，共 3 段。', '1.2:1.2 审校后的正文，共 3 段。', '2:2 审校后的正文，共 3 段。']);
    // 日志不含章节标题和正文。
    expect(result.logs.join('\n')).not.toMatch(/项目概况|编制依据|正文，共/);

    await saveKeyParameters(appDb, member.context, projectId, '## 参数');
    await saveChapterContent(appDb, member.context, projectId, '2', '2 手工正文，共 3 段。');
    result = await runJob(FEASIBILITY_CONTENT_JOB_TYPE, member, projectId, defaultResponder, { onlyMissing: true });
    expect(result.error).toBeNull();
    expect(result.requests.map((request) => request.stepKey)).toEqual(['content:warmup', 'content:1.1', 'content:1.2', 'review:warmup', 'review:1.1', 'review:1.2', 'review:2']);

    result = await runJob(FEASIBILITY_HUMAN_WRITING_JOB_TYPE, member, projectId);
    expect(result.error).toBeNull();
    expect(result.requests.map((request) => request.stepKey)).toEqual(['review:1.1', 'review:1.2', 'review:2']);
    state = await loadFeasibilityReport(appDb, member.context, projectId);
    expect(collectContents(state.outlineData!.outline)).toEqual(['1.1:1.1 审校后的正文，共 3 段。', '1.2:1.2 审校后的正文，共 3 段。', '2:2 审校后的正文，共 3 段。']);
  });
});

describe('接口', () => {
  it('开始四类任务返回 202；前置条件不满足 409（文案与桌面版相同）；状态中返回最近的任务', async () => {
    const member = await newMember();
    const empty = await newProject(member);
    const expectConflict = async (url: string, code: string, message: string) => {
      const response = await call(member, 'POST', url);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toMatchObject({ code, message });
    };
    await expectConflict(reportUrl(empty, '/analysis-job'), 'FEASIBILITY_REPORT_PROJECT_INFO_REQUIRED', '请先填写项目名称');
    await expectConflict(reportUrl(empty, '/outline-job'), 'FEASIBILITY_REPORT_ANALYSIS_REQUIRED', '请先完成资料分析');
    await expectConflict(reportUrl(empty, '/key-parameters-job'), 'FEASIBILITY_REPORT_OUTLINE_REQUIRED', '请先生成报告目录');
    await expectConflict(reportUrl(empty, '/content-job'), 'FEASIBILITY_REPORT_OUTLINE_REQUIRED', '请先生成报告目录');
    await expectConflict(reportUrl(empty, '/human-writing-job'), 'FEASIBILITY_REPORT_CONTENT_REQUIRED', '请先生成正文，再进行自然化审校');

    const { projectId } = await fixture(member, 'outline');
    await expectConflict(reportUrl(projectId, '/content-job'), 'FEASIBILITY_REPORT_KEY_PARAMETERS_REQUIRED', '请先生成关键参数');
    const started = await call(member, 'POST', reportUrl(projectId, '/analysis-job'));
    expect(started.statusCode, started.body).toBe(202);
    const job = started.json().job;
    expect(job).toMatchObject({ type: FEASIBILITY_ANALYSIS_JOB_TYPE, status: 'queued', projectId });
    // 互斥：已有未结束的可研任务。
    const locked = await call(member, 'POST', reportUrl(projectId, '/key-parameters-job'));
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('JOB_LOCKED');
    const state = (await call(member, 'GET', reportUrl(projectId))).json();
    expect(state).toMatchObject({ analysisTask: { id: job.id, status: 'queued' }, parametersTask: null, contentTask: null, humanWritingTask: null, outlineTask: null });
    await call(member, 'POST', `/api/jobs/${job.id}/cancel`, {});

    const content = await call(member, 'POST', reportUrl(projectId, '/content-job'), { onlyMissing: true });
    expect(content.statusCode, content.body).toBe(409);
    expect(content.json().error.code).toBe('FEASIBILITY_REPORT_KEY_PARAMETERS_REQUIRED');
    expect((await call(member, 'POST', reportUrl(projectId, '/content-job'), { resume: true })).statusCode).toBe(400);
  });

  it('开始目录生成（8.7a）：202，写入 Agent 任务上限；与其他可研任务互斥；状态中返回；保存资料分析时取消；不采用请求体字段', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member, 'parameters');
    const started = await call(member, 'POST', reportUrl(projectId, '/outline-job'));
    expect(started.statusCode, started.body).toBe(202);
    const job = started.json().job;
    expect(job).toMatchObject({ type: FEASIBILITY_OUTLINE_JOB_TYPE, status: 'queued', projectId });
    const row = await superuser.selectFrom('jobs').select(['lock_key', 'params']).where('id', '=', job.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ lock_key: `project:${projectId}:feasibility-report`, params: {} });
    const budget = await superuser.selectFrom('agent_job_budgets').select(['cost_limit', 'turn_limit']).where('job_id', '=', job.id).executeTakeFirstOrThrow();
    expect(budget).toEqual({ cost_limit: '50000', turn_limit: 500 });
    const locked = await call(member, 'POST', reportUrl(projectId, '/analysis-job'));
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('JOB_LOCKED');
    expect((await call(member, 'GET', reportUrl(projectId))).json().outlineTask).toMatchObject({ id: job.id, type: FEASIBILITY_OUTLINE_JOB_TYPE, status: 'queued' });
    expect((await call(member, 'PUT', reportUrl(projectId, '/analysis'), { markdown: '## 新分析' })).statusCode).toBe(200);
    expect(await statusOf(job.id)).toBe('cancelled');
    // 请求体中的字段一律不采用：目录配置取已保存的，任务参数为空。
    const again = await call(member, 'POST', reportUrl(projectId, '/outline-job'), { outlineTemplate: 'enterprise', orgId: randomUUID() });
    expect(again.statusCode, again.body).toBe(202);
    expect((await superuser.selectFrom('jobs').select('params').where('id', '=', again.json().job.id).executeTakeFirstOrThrow()).params).toEqual({});
    const other = await newMember();
    expect((await call(other, 'POST', reportUrl(projectId, '/outline-job'))).statusCode).toBe(404);
    const poor = await newMember({ balance: 0n });
    const { projectId: poorProject } = await fixture(poor, 'outline');
    expect((await call(poor, 'POST', reportUrl(poorProject, '/outline-job'))).statusCode).toBe(402);
  });

  it('余额不足 402；其他组织的项目 404', async () => {
    const poor = await newMember({ balance: 0n });
    const { projectId } = await fixture(poor);
    expect((await call(poor, 'POST', reportUrl(projectId, '/analysis-job'))).statusCode).toBe(402);
    const other = await newMember();
    expect((await call(other, 'POST', reportUrl(projectId, '/analysis-job'))).statusCode).toBe(404);
  });

  it('正文生成或审校任务未结束时不能保存目录、手工改正文；暂停中不能启动其他可研任务', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member, 'content');
    for (const type of [FEASIBILITY_CONTENT_JOB_TYPE, FEASIBILITY_HUMAN_WRITING_JOB_TYPE]) {
      const jobId = await insertJob(member, projectId, type, type === FEASIBILITY_CONTENT_JOB_TYPE ? 'paused' : 'queued');
      const outline = await call(member, 'PUT', reportUrl(projectId, '/outline'), { outlineData: { outline: OUTLINE }, reason: 'sort' });
      expect(outline.statusCode).toBe(409);
      expect(outline.json().error).toMatchObject({ code: 'FEASIBILITY_REPORT_CONTENT_LOCKED', message: '正文生成或审校任务正在运行或已暂停，当前不能修改目录或手工改正文' });
      expect((await call(member, 'PUT', reportUrl(projectId, '/chapters/2'), { content: '手工' })).statusCode).toBe(409);
      if (type === FEASIBILITY_CONTENT_JOB_TYPE) {
        const blocked = await call(member, 'POST', reportUrl(projectId, '/human-writing-job'));
        expect(blocked.statusCode).toBe(409);
        expect(blocked.json().error).toMatchObject({ code: 'FEASIBILITY_REPORT_CONTENT_PAUSED', message: '可研正文生成已暂停，请先继续当前正文生成或重置可研后再启动新的任务。' });
      }
      await superuser.updateTable('jobs').set({ status: 'cancelled', finished_at: new Date() }).where('id', '=', jobId).execute();
    }
    expect((await call(member, 'PUT', reportUrl(projectId, '/chapters/2'), { content: '手工' })).statusCode).toBe(200);
  });

  it('保存项目信息、资料分析、目录、关键参数，导入、移除资料和清空时取消进行中的可研任务（含暂停中的）；保存步骤与目录配置不取消', async () => {
    const member = await newMember();
    const { projectId, sources } = await fixture(member, 'parameters');
    const start = async () => (await call(member, 'POST', reportUrl(projectId, '/analysis-job'))).json().job.id as string;

    let jobId = await start();
    expect((await call(member, 'PATCH', reportUrl(projectId, '/step'), { step: 'outline' })).statusCode).toBe(200);
    expect((await call(member, 'PUT', reportUrl(projectId, '/outline-config'), { outlineTemplate: 'government', targetWords: 30000, referenceDocumentIds: [] })).statusCode).toBe(200);
    expect(await statusOf(jobId)).toBe('queued');
    const response = await call(member, 'PUT', reportUrl(projectId, '/key-parameters'), { markdown: '## 参数' });
    expect(response.statusCode).toBe(200);
    expect(await statusOf(jobId)).toBe('cancelled');
    // 响应中的状态在取消之后读取。
    expect(response.json().analysisTask).toMatchObject({ id: jobId, status: 'cancelled' });

    const saves: [string, string, unknown][] = [
      ['PUT', '/outline', { outlineData: { outline: OUTLINE }, reason: 'sort' }],
      ['PUT', '/analysis', { markdown: '## 分析' }],
      ['PUT', '/project-info', { projectInfo: PROJECT_INFO }],
    ];
    for (const [method, path, payload] of saves) {
      jobId = await start();
      expect((await call(member, method as 'PUT', reportUrl(projectId, path), payload)).statusCode).toBe(200);
      expect(await statusOf(jobId)).toBe('cancelled');
    }

    jobId = await start();
    const imported = await call(member, 'PUT', reportUrl(projectId, '/sources'), { fileIds: sources });
    expect(imported.statusCode).toBe(200);
    expect(await statusOf(jobId)).toBe('cancelled');
    expect(imported.json().state.analysisTask).toMatchObject({ id: jobId, status: 'cancelled' });

    jobId = await start();
    expect((await call(member, 'DELETE', reportUrl(projectId, `/sources/${sources[1]}`))).statusCode).toBe(200);
    expect(await statusOf(jobId)).toBe('cancelled');

    const paused = await insertJob(member, projectId, FEASIBILITY_CONTENT_JOB_TYPE, 'paused');
    expect((await call(member, 'DELETE', reportUrl(projectId))).statusCode).toBe(200);
    expect(await statusOf(paused)).toBe('cancelled');
  });
});

describe('经 worker 执行', () => {
  it('接口入队 → worker 认领执行（经 AI 网关，任务调用带 job 来源与步骤键）→ 资料分析、关键参数、正文生成依次完成', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const gatewayRequests: ChatRequest[] = [];
    const gateway: AiGateway = {
      async chat(_context, request) {
        gatewayRequests.push(request);
        return chatResult(await defaultResponder(request as JobChatRequest));
      },
    };
    const prefix = uniquePrefix();
    const logs = testLogger();
    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'feasibility-test-dispatch'), prefix });
    const runner = createJobRunner({
      db: appDb,
      registry: jobTypeRegistry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'feasibility-test-worker'),
      log: logs.log,
      prefix,
      reconcileIntervalMs: 300,
      objectStore: memoryStore,
      gateway,
    });
    const finished = (jobId: string) =>
      waitFor(async () => {
        const row = await superuser.selectFrom('jobs').select(['status', 'error_code']).where('id', '=', jobId).executeTakeFirst();
        return row && ['succeeded', 'failed', 'cancelled'].includes(row.status) ? row : null;
      }, 30_000, `job ${jobId} finished`);
    try {
      await runner.start();
      const analysis = (await call(member, 'POST', reportUrl(projectId, '/analysis-job'))).json().job;
      expect(await finished(analysis.id)).toEqual({ status: 'succeeded', error_code: null });
      expect((await call(member, 'PUT', reportUrl(projectId, '/outline'), { outlineData: { outline: OUTLINE }, reason: 'replace' })).statusCode).toBe(200);
      const parameters = (await call(member, 'POST', reportUrl(projectId, '/key-parameters-job'))).json().job;
      expect(await finished(parameters.id)).toEqual({ status: 'succeeded', error_code: null });
      const content = (await call(member, 'POST', reportUrl(projectId, '/content-job'))).json().job;
      expect(await finished(content.id)).toEqual({ status: 'succeeded', error_code: null });
      expect(gatewayRequests.every((request) => request.source === 'job' && typeof request.stepKey === 'string' && request.jobId)).toBe(true);
      expect(new Set(gatewayRequests.map((request) => request.jobType))).toEqual(new Set([FEASIBILITY_ANALYSIS_JOB_TYPE, FEASIBILITY_PARAMETERS_JOB_TYPE, FEASIBILITY_CONTENT_JOB_TYPE]));
      const state = (await call(member, 'GET', reportUrl(projectId))).json();
      expect(state).toMatchObject({
        keyParametersMarkdown: '## 项目身份信息\n\n- 新的关键参数',
        analysisTask: { id: analysis.id, status: 'succeeded' },
        parametersTask: { id: parameters.id, status: 'succeeded' },
        contentTask: { id: content.id, status: 'succeeded', progress: 100 },
      });
      expect(state.analysisMarkdown).toContain('## 项目概况\n\n管网 12 公里');
      expect(collectContents(state.outlineData.outline)).toEqual(['1.1:1.1 审校后的正文，共 3 段。', '1.2:1.2 审校后的正文，共 3 段。', '2:2 审校后的正文，共 3 段。']);
      const events = await superuser.selectFrom('job_events').select(['message']).where('job_id', '=', content.id).orderBy('id').execute();
      expect(events.map((event: { message: string | null }) => event.message)).toEqual(expect.arrayContaining(['开始生成 3 个章节正文。', '正文生成完成，开始自然化审校。', '自然化审校完成。']));
    } finally {
      await runner.close();
      await dispatcher.close();
    }
  });
});
