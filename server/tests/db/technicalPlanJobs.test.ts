// 技术方案任务（路线图第 6 步 6.11，src/technicalPlan/jobs.ts）的数据库与接口测试：
// - bid-section-extraction：合并的原始招标正文加行号后逐段识别、合并，结果经 saveBidSectionExtraction 写入；少于两个标段、
//   JSON 不合法、未选择模型时写入失败原因；
// - bid-analysis：按已保存的配置并发解析选中的项（先预热公共前缀），续跑时跳过已成功的项，重新解析指定项，全部重新解析时清空
//   下游；多标段时只读所选投标范围、带投标范围提示；必填项未完成时任务失败；
// - 写入带开始时的签名，任务开始后招标文件、投标范围变化时写入被拒绝；暂停、余额不足时不改写结果；
// - 接口：开始识别 / 解析的前置检查与互斥，招标文件变化与清空时取消任务，状态中返回最近的任务、结果仍是 running 而任务已结束时
//   按未完成显示；
// - 经 worker（真实 Valkey）从接口入队到执行完成的完整流程。
// 模型调用用桩（直接执行时的 context.ai、经 worker 时的 AiGateway），网关本身由 tests/db/aiGateway.test.ts、jobBilling.test.ts 覆盖。
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
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { JobBalanceExhaustedError, JobError, type JobChatRequest, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';
import { createJobDispatcher } from '../../src/jobs/queue.ts';
import { jobTypeRegistry } from '../../src/jobs/registry.ts';
import { createJobRunner } from '../../src/jobs/runner.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { summarizeBidSectionDetection } from '../../src/technicalPlan/bidSectionDetector.ts';
import { BID_ANALYSIS_JOB_TYPE, BID_SECTION_EXTRACTION_JOB_TYPE, createTechnicalPlanJobs } from '../../src/technicalPlan/jobs.ts';
import {
  importTenderFiles,
  loadTechnicalPlan,
  saveBidAnalysisConfig,
  saveDocumentParse,
  saveGenerationConfig,
  saveGlobalFacts,
  selectBidSection,
} from '../../src/technicalPlan/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { redisConfig, testLogger, uniquePrefix, waitFor } from './jobFixtures.ts';

const PASSWORD = 'quiet-harbor-maple-63';

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
async function newMember(options: { model?: boolean; balance?: bigint } = {}): Promise<Member> {
  const hasher = await fastHasher();
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  if (options.model !== false) await superuser.insertInto('org_settings').values({ org_id: orgId, platform_model_id: platformModelId, updated_by: userId }).execute();
  const balance = options.balance ?? 100_000n;
  if (balance > 0n) await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: balance, reference: null, note: '测试充值' });
  return { userId, orgId, cookie: await login(email), context: { orgId, userId, role: 'owner' } };
}

async function newProject(member: Member): Promise<string> {
  const row = await superuser.insertInto('projects').values({ org_id: member.orgId, kind: 'technical-plan', name: '技术方案', created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

async function newFile(member: Member, name: string): Promise<string> {
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      purpose: 'tender',
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

/** 写入解析结果（与 document-parse 任务相同：Markdown 产物 + saveDocumentParse，带疑似多标段检测摘要）。 */
async function markParsed(member: Member, projectId: string, fileId: string, markdown: string): Promise<void> {
  const artifact = await writeArtifact(
    appDb,
    member.context,
    memoryStore,
    { kind: 'markdown', name: 'content.md', mime: 'text/markdown; charset=utf-8', projectId, sourceFileId: fileId },
    Buffer.from(`${markdown}\n`, 'utf8'),
  );
  const saved = await saveDocumentParse(appDb, member.context, projectId, fileId, {
    status: 'success',
    markdownArtifactId: artifact.id,
    contentChars: markdown.length,
    contentHash: sha256(markdown),
    parserLabel: '本地解析',
    bidSectionDetection: summarizeBidSectionDetection(markdown),
  });
  expect(saved).toBe(true);
}

/** 导入招标文件（经 Store，不入队解析），给出 markdown 时写入解析结果。 */
async function addTenders(member: Member, projectId: string, documents: { name: string; markdown?: string }[]): Promise<string[]> {
  const ids: string[] = [];
  for (const document of documents) ids.push(await newFile(member, document.name));
  await importTenderFiles(appDb, member.context, projectId, ids);
  for (const [index, document] of documents.entries()) {
    if (document.markdown !== undefined) await markParsed(member, projectId, ids[index]!, document.markdown);
  }
  return ids;
}

// 合并后的行号：1 招标公告、2 两个标段、3~4 一标段、5~6 二标段、7 空行（两份文件以空行连接）、8~9 通用条款。
const TENDER_A = ['# 招标公告', '本项目分为两个标段。', '一标段：设备采购', '设备清单。', '二标段：软件开发', '软件需求。'].join('\n');
const TENDER_B = ['# 通用条款', '投标人须知。'].join('\n');

async function fixture(member: Member, options: { parsed?: boolean } = {}): Promise<{ projectId: string; tenders: string[] }> {
  const projectId = await newProject(member);
  const parsed = options.parsed !== false;
  const tenders = await addTenders(member, projectId, [
    { name: '招标文件-第一册.docx', ...(parsed ? { markdown: TENDER_A } : {}) },
    { name: '招标文件-第二册.docx', ...(parsed ? { markdown: TENDER_B } : {}) },
  ]);
  return { projectId, tenders };
}

// ---- 模型桩 ----

type Responder = (request: JobChatRequest) => string | Promise<string>;

const SECTIONS_JSON = JSON.stringify({
  sections: [
    { title: '二标段', headLine: '二标段：软件开发', includeRanges: [{ startLine: 5, endLine: 6, reason: '二标段范围' }], evidence: ['二标段：软件开发'] },
    { title: '一标段', headLine: '一标段：设备采购', description: '设备采购', includeRanges: [{ startLine: 3, endLine: 4 }], evidence: ['一标段：设备采购'] },
  ],
});

/** 默认输出：识别返回两个标段，解析项返回“{id}结果”，预热返回空。 */
const defaultResponder: Responder = (request) => {
  const key = request.stepKey;
  if (key.startsWith('warmup')) return '';
  if (key.startsWith('segment:') || key === 'merge') return SECTIONS_JSON;
  const item = /^item:([A-Za-z]+)/.exec(key);
  if (item) return `${item[1]}结果`;
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

const jobs = createTechnicalPlanJobs({ warmupSettleMs: 0 });
const extractionJob = jobs.find((job) => job.type === BID_SECTION_EXTRACTION_JOB_TYPE)!;
const analysisJob = jobs.find((job) => job.type === BID_ANALYSIS_JOB_TYPE)!;

interface RunResult {
  error: unknown;
  logs: string[];
  requests: JobChatRequest[];
}

/** 以给定的上下文直接执行任务类型的 run（不经队列）。 */
async function runJob(
  definition: JobTypeDefinition<any>,
  member: Member,
  projectId: string,
  respond: Responder,
  params: unknown = definition === analysisJob ? { taskIds: null, forceRerun: false } : {},
): Promise<RunResult> {
  const logs: string[] = [];
  const requests: JobChatRequest[] = [];
  const controller = new AbortController();
  const context: JobContext<any> = {
    jobId: randomUUID(),
    projectId,
    type: definition.type,
    attempt: 1,
    params: definition.parseParams(params),
    checkpoint: null,
    tenant: member.context,
    db: appDb,
    signal: controller.signal,
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
    agent: null,
  };
  try {
    await definition.run(context);
    return { error: null, logs, requests };
  } catch (error) {
    return { error, logs, requests };
  }
}

const REQUIRED = ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements', 'responseFileRequirements'];

function call(member: Member, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
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
  await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'technical-plan-jobs-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
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

describe('多标段识别任务', () => {
  it('合并的原始招标正文加行号交给模型；结果按真实行号整理、重新编号后写入，切到多标段并清空下游', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    // 先有招标解析结果，识别开始时被清空。
    expect((await runJob(analysisJob, member, projectId, defaultResponder)).error).toBeNull();
    const result = await runJob(extractionJob, member, projectId, defaultResponder);
    expect(result.error).toBeNull();
    expect(result.requests.map((request) => request.stepKey)).toEqual(['segment:1']);
    expect(result.requests[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
    const prompt = result.requests[0]!.messages[1]!.content;
    expect(prompt).toContain('L000003 | 一标段：设备采购');
    expect(prompt).toContain('L000007 | \nL000008 | # 通用条款');
    const state = await loadTechnicalPlan(appDb, member.context, projectId);
    expect(state).toMatchObject({ bidSectionMode: 'multiple', bidSectionExtractionStatus: 'success', bidSectionExtractionError: null, selectedSection: null, bidAnalysisTasks: {} });
    expect(state.bidSections.map((section) => [section.id, section.title, section.includeRanges])).toEqual([
      ['section-1', '一标段', [{ startLine: 3, endLine: 4 }]],
      ['section-2', '二标段', [{ startLine: 5, endLine: 6, reason: '二标段范围' }]],
    ]);
    expect(result.logs).toEqual([
      '开始识别招标文件中的标段范围。',
      '招标文件已按上下文拆分为 1 段，正在提取标段候选。',
      '已完成第 1/1 段标段候选提取。',
      '已识别 2 个标段，请选择本次投标范围。',
    ]);
  });

  it('正文超过上下文长度时逐段识别后合并；少于两个标段时写入失败原因', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const [segmented] = createTechnicalPlanJobs({ contextLengthLimit: 60 });
    const result = await runJob(segmented!, member, projectId, defaultResponder);
    expect(result.error).toBeNull();
    const keys = result.requests.map((request) => request.stepKey);
    expect(keys.filter((key) => key.startsWith('segment:')).length).toBeGreaterThan(1);
    expect(keys.at(-1)).toBe('merge');

    const single = await runJob(extractionJob, member, projectId, () => JSON.stringify({ sections: [{ title: '一标段', includeRanges: [{ startLine: 3, endLine: 4 }] }] }));
    expect(single.error).toMatchObject({ code: 'TECHNICAL_PLAN_BID_SECTIONS_NOT_FOUND', message: '未识别到至少两个有效标段' });
    expect(await loadTechnicalPlan(appDb, member.context, projectId)).toMatchObject({
      bidSectionExtractionStatus: 'error',
      bidSectionExtractionError: '未识别到至少两个有效标段',
      bidSections: [],
    });
  });

  it('JSON 3 次都不合法、未选择模型时写入失败原因；招标文件未解析完、解析失败、没有招标文件时不开始', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const invalid = await runJob(extractionJob, member, projectId, () => '不是 JSON');
    expect(invalid.requests.map((request) => request.stepKey)).toEqual(['segment:1', 'segment:1:repair-1', 'segment:1:try-2', 'segment:1:repair-2', 'segment:1:try-3', 'segment:1:repair-3']);
    expect(invalid.error).toMatchObject({ code: 'AI_INVALID_JSON', message: '模型返回的 JSON 数据格式无效' });
    expect((await loadTechnicalPlan(appDb, member.context, projectId)).bidSectionExtractionError).toBe('模型返回的 JSON 数据格式无效');

    const noModel = await newMember({ model: false });
    const noModelFixture = await fixture(noModel);
    expect((await runJob(extractionJob, noModel, noModelFixture.projectId, defaultResponder)).error).toMatchObject({ code: 'AI_MODEL_NOT_CONFIGURED' });
    expect(await loadTechnicalPlan(appDb, noModel.context, noModelFixture.projectId)).toMatchObject({
      bidSectionExtractionStatus: 'error',
      bidSectionExtractionError: '尚未选择文本模型，请先在设置中选择模型',
    });

    const pending = await fixture(member, { parsed: false });
    const notReady = await runJob(extractionJob, member, pending.projectId, defaultResponder);
    expect(notReady.error).toMatchObject({ code: 'TECHNICAL_PLAN_DOCUMENT_NOT_READY', message: '招标文件尚未全部解析完成，请稍后再试' });
    expect(notReady.requests).toHaveLength(0);
    expect((await loadTechnicalPlan(appDb, member.context, pending.projectId)).bidSectionExtractionStatus).toBe('idle');
    await saveDocumentParse(appDb, member.context, pending.projectId, pending.tenders[0]!, { status: 'error', error: '解析失败' });
    expect((await runJob(extractionJob, member, pending.projectId, defaultResponder)).error).toMatchObject({ code: 'TECHNICAL_PLAN_DOCUMENT_FAILED' });
    expect((await runJob(extractionJob, member, await newProject(member), defaultResponder)).error).toMatchObject({
      code: 'TECHNICAL_PLAN_TENDER_MISSING',
      message: '请先上传招标文件，再进行多标段识别',
    });
  });

  it('余额不足：不改写结果（仍是 running），交给执行者暂停；识别中导入了新的招标文件：结果被拒绝写入', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const exhausted = await runJob(extractionJob, member, projectId, () => {
      throw new JobBalanceExhaustedError();
    });
    expect(exhausted.error).toBeInstanceOf(JobBalanceExhaustedError);
    expect(await superuser.selectFrom('technical_plan_meta').select('bid_section_extraction_status').where('project_id', '=', projectId).executeTakeFirst()).toEqual({
      bid_section_extraction_status: 'running',
    });

    const changed = await runJob(extractionJob, member, projectId, async () => {
      await addTenders(member, projectId, [{ name: '补遗.docx', markdown: '# 补遗' }]);
      return SECTIONS_JSON;
    });
    expect(changed.error).toMatchObject({ code: 'TECHNICAL_PLAN_INPUT_CHANGED' });
    // 导入招标文件清空了识别结果，旧任务的结果没有写回。
    expect(await superuser.selectFrom('technical_plan_meta').select(['bid_section_extraction_status', 'bid_sections']).where('project_id', '=', projectId).executeTakeFirst()).toEqual({
      bid_section_extraction_status: 'idle',
      bid_sections: null,
    });
  });
});

describe('招标解析任务', () => {
  it('单标段：按已保存的配置并发解析选中的项，先预热公共前缀；结果写入解析项，项目概述与技术评分要求可用', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    await saveBidAnalysisConfig(appDb, member.context, projectId, { mode: 'custom', selectedTaskIds: ['agentInfo'] });
    const result = await runJob(analysisJob, member, projectId, defaultResponder);
    expect(result.error).toBeNull();
    expect(result.requests[0]).toMatchObject({ stepKey: 'warmup', maxOutputTokens: 1 });
    expect(result.requests[0]!.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(result.requests[0]!.messages[1]!.content).toContain(`${TENDER_A}\n\n${TENDER_B}`);
    expect(result.requests.slice(1).map((request) => request.stepKey).sort()).toEqual([...REQUIRED, 'agentInfo'].map((id) => `item:${id}`).sort());
    // 各项的公共前缀与预热请求逐字相同。
    for (const request of result.requests.slice(1)) expect(request.messages.slice(0, 2)).toEqual(result.requests[0]!.messages);

    const state = await loadTechnicalPlan(appDb, member.context, projectId);
    expect(state).toMatchObject({ projectOverview: 'projectOverview结果', techRequirements: 'techRequirements结果', bidAnalysisProgress: 100 });
    expect(Object.keys(state.bidAnalysisTasks).sort()).toEqual([...REQUIRED, 'agentInfo'].sort());
    expect(state.bidAnalysisTasks.agentInfo).toEqual({ id: 'agentInfo', label: '代理机构信息', status: 'success', content: 'agentInfo结果', error: null });
    expect(result.logs).toEqual(['开始解析招标文件。', '招标文件解析完成。']);
  });

  it('必填项失败时任务失败；再次开始只解析未成功的项；指定项重新解析；分段时逐段解析后合并', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const failing = await runJob(analysisJob, member, projectId, (request) => (request.stepKey === 'item:partAInfo' ? '  ' : defaultResponder(request)));
    expect(failing.error).toMatchObject({ code: 'TECHNICAL_PLAN_BID_ANALYSIS_INCOMPLETE', message: '必填解析项未完成：甲方信息，请重新解析失败项。' });
    let state = await loadTechnicalPlan(appDb, member.context, projectId);
    expect(state.bidAnalysisTasks.partAInfo).toMatchObject({ status: 'error', content: '', error: '甲方信息解析结果为空，请重新解析' });
    expect(failing.logs).toContain('甲方信息解析失败：甲方信息解析结果为空，请重新解析');

    const resumed = await runJob(analysisJob, member, projectId, defaultResponder);
    expect(resumed.error).toBeNull();
    // 只剩一项：不预热。
    expect(resumed.requests.map((request) => request.stepKey)).toEqual(['item:partAInfo']);
    state = await loadTechnicalPlan(appDb, member.context, projectId);
    expect(state.bidAnalysisTasks.partAInfo).toMatchObject({ status: 'success', content: 'partAInfo结果' });

    const retry = await runJob(analysisJob, member, projectId, defaultResponder, { taskIds: ['projectInfo'], forceRerun: false });
    expect(retry.requests.map((request) => request.stepKey)).toEqual(['item:projectInfo']);
    expect(retry.logs[0]).toBe('开始重新解析选中的招标文件解析项。');
    const notSelected = await runJob(analysisJob, member, projectId, defaultResponder, { taskIds: ['agentInfo'], forceRerun: false });
    expect(notSelected.error).toMatchObject({ code: 'TECHNICAL_PLAN_BID_ITEM_NOT_FOUND' });

    const [segmented] = createTechnicalPlanJobs({ contextLengthLimit: 60, warmupSettleMs: 0 }).filter((job) => job.type === BID_ANALYSIS_JOB_TYPE);
    const split = await runJob(segmented!, member, projectId, defaultResponder, { taskIds: ['projectOverview'], forceRerun: false });
    const keys = split.requests.map((request) => request.stepKey);
    expect(keys.filter((key) => key.startsWith('item:projectOverview:segment:')).length).toBeGreaterThan(1);
    expect(keys.at(-1)).toBe('item:projectOverview:merge');
  });

  it('Markdown 项只返回“未提取到”时完整重跑一次；全部重新解析时先清空选中的项与目录、全局事实', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    expect((await runJob(analysisJob, member, projectId, defaultResponder)).error).toBeNull();
    await saveGlobalFacts(appDb, member.context, projectId, [{ title: '事实', content: '内容' }]);
    await saveGenerationConfig(appDb, member.context, projectId, { contentGenerationOptions: { imageQuantity: 0 } });
    const rerun = await runJob(
      analysisJob,
      member,
      projectId,
      (request) => (request.stepKey === 'item:projectOverview' ? '未提取到' : defaultResponder(request)),
      { taskIds: null, forceRerun: true },
    );
    expect(rerun.error).toBeNull();
    expect(rerun.logs[0]).toBe('开始重新解析全部招标文件解析项。');
    expect(rerun.requests.map((request) => request.stepKey)).toEqual(expect.arrayContaining(['item:projectOverview', 'item:projectOverview:try-2']));
    expect(rerun.requests.filter((request) => request.stepKey.startsWith('item:')).length).toBe(REQUIRED.length + 1);
    const state = await loadTechnicalPlan(appDb, member.context, projectId);
    expect(state.globalFacts).toEqual([]);
    expect(state.contentGenerationOptions.imageQuantity).not.toBe(0);
    expect(state.bidAnalysisTasks.projectOverview).toMatchObject({ status: 'success', content: 'projectOverview结果' });
  });

  it('多标段：须先识别并选择投标范围；只读所选范围的正文，带投标范围提示', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    await saveGenerationConfig(appDb, member.context, projectId, { bidSectionMode: 'multiple' });
    expect((await runJob(analysisJob, member, projectId, defaultResponder)).error).toMatchObject({
      code: 'TECHNICAL_PLAN_BID_SECTIONS_REQUIRED',
      message: '请先完成多标段识别，再开始解析招标文件',
    });
    expect((await runJob(extractionJob, member, projectId, defaultResponder)).error).toBeNull();
    expect((await runJob(analysisJob, member, projectId, defaultResponder)).error).toMatchObject({ code: 'TECHNICAL_PLAN_BID_SECTION_REQUIRED' });
    await selectBidSection(appDb, member.context, projectId, 'section-1', memoryStore);
    const result = await runJob(analysisJob, member, projectId, defaultResponder);
    expect(result.error).toBeNull();
    const [system, hint, tender] = result.requests[0]!.messages;
    expect(system!.role).toBe('system');
    expect(hint).toEqual({ role: 'system', content: expect.stringContaining('当前选择标段：一标段') });
    expect(tender!.content).toContain('设备清单。');
    expect(tender!.content).not.toContain('软件需求。');
  });

  it('解析中导入了新的招标文件：结果被拒绝写入，任务以输入已变化结束；余额不足时不改写结果', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    let imported = false;
    const changed = await runJob(analysisJob, member, projectId, async (request) => {
      if (request.stepKey === 'item:projectOverview' && !imported) {
        imported = true;
        await addTenders(member, projectId, [{ name: '补遗.docx', markdown: '# 补遗' }]);
      }
      return defaultResponder(request);
    });
    expect(changed.error).toMatchObject({ code: 'TECHNICAL_PLAN_INPUT_CHANGED' });
    // 导入招标文件清空了解析结果；之后的写入都被拒绝。
    expect((await loadTechnicalPlan(appDb, member.context, projectId)).bidAnalysisTasks).toEqual({});

    const second = await fixture(member);
    const exhausted = await runJob(analysisJob, member, second.projectId, (request) => {
      if (request.stepKey === 'item:projectInfo') throw new JobBalanceExhaustedError();
      return defaultResponder(request);
    });
    expect(exhausted.error).toBeInstanceOf(JobBalanceExhaustedError);
    const row = await superuser.selectFrom('technical_plan_bid_items').select('status').where('project_id', '=', second.projectId).where('item_id', '=', 'projectInfo').executeTakeFirst();
    expect(row).toEqual({ status: 'running' });
  });

  it('前置检查：招标文件未解析完时不开始；未选择模型时不写入解析项', async () => {
    const member = await newMember();
    const pending = await fixture(member, { parsed: false });
    expect((await runJob(analysisJob, member, pending.projectId, defaultResponder)).error).toMatchObject({ code: 'TECHNICAL_PLAN_DOCUMENT_NOT_READY' });
    const noModel = await newMember({ model: false });
    const noModelFixture = await fixture(noModel);
    expect((await runJob(analysisJob, noModel, noModelFixture.projectId, defaultResponder)).error).toBeInstanceOf(JobError);
    expect((await loadTechnicalPlan(appDb, noModel.context, noModelFixture.projectId)).bidAnalysisTasks).toEqual({});
    expect(() => analysisJob.parseParams({ taskIds: [], forceRerun: false })).toThrow(TypeError);
    expect(() => analysisJob.parseParams({ taskIds: ['unknown'], forceRerun: false })).toThrow(TypeError);
    expect(() => analysisJob.parseParams({ taskIds: null })).toThrow(TypeError);
    expect(() => extractionJob.parseParams({ x: 1 })).toThrow(TypeError);
  });
});

describe('接口', () => {
  it('开始识别：招标文件未解析完时 409；入队 bid-section-extraction（项目互斥、参数为空），状态中返回任务；同一项目再开始任一任务 409 JOB_LOCKED', async () => {
    const member = await newMember();
    const pending = await fixture(member, { parsed: false });
    const notReady = await call(member, 'POST', `/api/projects/${pending.projectId}/technical-plan/bid-section-extraction`);
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toMatchObject({ error: { code: 'TECHNICAL_PLAN_DOCUMENT_NOT_READY' } });

    const { projectId } = await fixture(member);
    const started = await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-section-extraction`);
    expect(started.statusCode, started.body).toBe(202);
    const job = started.json().job;
    expect(job).toMatchObject({ type: BID_SECTION_EXTRACTION_JOB_TYPE, projectId, status: 'queued' });
    const row = await superuser.selectFrom('jobs').select(['lock_key', 'params']).where('id', '=', job.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ lock_key: `project:${projectId}:technical-plan`, params: {} });
    expect((await call(member, 'GET', `/api/projects/${projectId}/technical-plan`)).json()).toMatchObject({
      bidSectionExtractionTask: { id: job.id, status: 'queued' },
      bidAnalysisTask: null,
      bidSectionDetection: { hasMultiple: true, totalDeclared: 2 },
    });
    const again = await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-analysis`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'JOB_LOCKED' } });
  });

  it('开始解析：请求体可省略；只重新解析指定项（须是选中的项）；多标段未选择投标范围时 409；参数不合法 400；余额不足 402；其他组织的项目 404', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const started = await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-analysis`);
    expect(started.statusCode, started.body).toBe(202);
    expect((await superuser.selectFrom('jobs').select('params').where('id', '=', started.json().job.id).executeTakeFirstOrThrow()).params).toEqual({ taskIds: null, forceRerun: false });
    await call(member, 'POST', `/api/jobs/${started.json().job.id}/cancel`, {});

    expect((await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-analysis`, { taskIds: ['unknown'] })).statusCode).toBe(400);
    expect((await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-analysis`, { taskIds: [] })).statusCode).toBe(400);
    const notSelected = await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-analysis`, { taskIds: ['agentInfo'] });
    expect(notSelected.statusCode).toBe(409);
    expect(notSelected.json()).toMatchObject({ error: { code: 'TECHNICAL_PLAN_BID_ITEM_NOT_FOUND' } });
    const retry = await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-analysis`, { taskIds: ['partAInfo', 'partAInfo'], forceRerun: true });
    expect(retry.statusCode, retry.body).toBe(202);
    expect((await superuser.selectFrom('jobs').select('params').where('id', '=', retry.json().job.id).executeTakeFirstOrThrow()).params).toEqual({ taskIds: ['partAInfo'], forceRerun: true });
    await call(member, 'POST', `/api/jobs/${retry.json().job.id}/cancel`, {});

    await saveGenerationConfig(appDb, member.context, projectId, { bidSectionMode: 'multiple' });
    const multiple = await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-analysis`, {});
    expect(multiple.statusCode).toBe(409);
    expect(multiple.json()).toMatchObject({ error: { code: 'TECHNICAL_PLAN_BID_SECTIONS_REQUIRED', message: '请先完成多标段识别，再开始解析招标文件' } });

    const poor = await newMember({ balance: 0n });
    const poorFixture = await fixture(poor);
    expect((await call(poor, 'POST', `/api/projects/${poorFixture.projectId}/technical-plan/bid-analysis`)).statusCode).toBe(402);
    expect((await call(poor, 'POST', `/api/projects/${projectId}/technical-plan/bid-section-extraction`)).statusCode).toBe(404);
  });

  it('导入、移除招标文件与清空时取消进行中的技术方案任务；导入原方案不取消；只导入已导入过的文件不取消', async () => {
    const member = await newMember();
    const { projectId, tenders } = await fixture(member);
    const statusOf = async (jobId: string) => (await superuser.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status;
    const start = async () => (await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-analysis`)).json().job;

    let job = await start();
    expect((await call(member, 'POST', `/api/projects/${projectId}/technical-plan/tender-files`, { fileIds: [tenders[0]] })).json()).toMatchObject({ addedCount: 0 });
    expect(await statusOf(job.id)).toBe('queued');
    const plan = await newFile(member, '原方案.docx');
    expect((await call(member, 'PUT', `/api/projects/${projectId}/technical-plan/original-plan`, { fileId: plan })).statusCode).toBe(200);
    expect(await statusOf(job.id)).toBe('queued');
    await call(member, 'POST', `/api/jobs/${job.id}/cancel`, {});

    job = await start();
    const added = await newFile(member, '补遗.docx');
    const imported = await call(member, 'POST', `/api/projects/${projectId}/technical-plan/tender-files`, { fileIds: [added] });
    expect(imported.statusCode).toBe(200);
    expect(await statusOf(job.id)).toBe('cancelled');
    // 响应中的状态在取消之后读取。
    expect(imported.json().state.bidAnalysisTask).toMatchObject({ id: job.id, status: 'cancelled' });

    await markParsed(member, projectId, added, '# 补遗');
    job = await start();
    const removed = await call(member, 'DELETE', `/api/projects/${projectId}/technical-plan/tender-files/${added}`);
    expect(removed.statusCode).toBe(200);
    expect(await statusOf(job.id)).toBe('cancelled');
    expect(removed.json().bidAnalysisTask).toMatchObject({ id: job.id, status: 'cancelled' });

    job = await start();
    expect((await call(member, 'DELETE', `/api/projects/${projectId}/technical-plan`)).statusCode).toBe(200);
    expect(await statusOf(job.id)).toBe('cancelled');
  });

  it('任务已结束而结果仍是 running 时按未完成显示；任务暂停中仍显示 running', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const job = (await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-analysis`)).json().job;
    await superuser.insertInto('technical_plan_bid_items').values({ org_id: member.orgId, project_id: projectId, item_id: 'projectOverview', label: '项目概述', status: 'running', content: '', sort_order: 0 }).execute();
    await superuser.updateTable('jobs').set({ status: 'paused' }).where('id', '=', job.id).execute();
    let state = (await call(member, 'GET', `/api/projects/${projectId}/technical-plan`)).json();
    expect(state.bidAnalysisTasks.projectOverview).toMatchObject({ status: 'running', error: null });
    expect(state.bidAnalysisTask).toMatchObject({ id: job.id, status: 'paused' });
    await superuser.updateTable('jobs').set({ status: 'failed', error_code: 'JOB_INTERRUPTED', error_message: '任务中断', finished_at: new Date() }).where('id', '=', job.id).execute();
    state = (await call(member, 'GET', `/api/projects/${projectId}/technical-plan`)).json();
    expect(state.bidAnalysisTasks.projectOverview).toMatchObject({ status: 'error', error: '上次招标文件解析未完成，请重新解析' });
    expect(state.bidAnalysisTask).toMatchObject({ status: 'failed', error: { code: 'JOB_INTERRUPTED' } });
  });
});

describe('经 worker 执行', () => {
  it('接口入队 → worker 认领执行（经 AI 网关，任务调用带 job 来源与步骤键）→ 状态中返回结果与已完成的任务', async () => {
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
    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'technical-plan-test-dispatch'), prefix });
    const runner = createJobRunner({
      db: appDb,
      registry: jobTypeRegistry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'technical-plan-test-worker'),
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
      const extraction = (await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-section-extraction`)).json().job;
      expect(await finished(extraction.id)).toEqual({ status: 'succeeded', error_code: null });
      expect((await call(member, 'PUT', `/api/projects/${projectId}/technical-plan/bid-section`, { sectionId: 'section-1' })).statusCode).toBe(200);
      const analysis = (await call(member, 'POST', `/api/projects/${projectId}/technical-plan/bid-analysis`)).json().job;
      expect(await finished(analysis.id)).toEqual({ status: 'succeeded', error_code: null });
      expect(gatewayRequests.every((request) => request.source === 'job' && typeof request.stepKey === 'string' && request.jobId)).toBe(true);
      expect(new Set(gatewayRequests.map((request) => request.jobType))).toEqual(new Set([BID_SECTION_EXTRACTION_JOB_TYPE, BID_ANALYSIS_JOB_TYPE]));
      const state = (await call(member, 'GET', `/api/projects/${projectId}/technical-plan`)).json();
      expect(state).toMatchObject({
        bidSectionExtractionStatus: 'success',
        selectedSection: { id: 'section-1', title: '一标段' },
        projectOverview: 'projectOverview结果',
        bidAnalysisProgress: 100,
        bidSectionExtractionTask: { id: extraction.id, status: 'succeeded', progress: 100 },
        bidAnalysisTask: { id: analysis.id, status: 'succeeded' },
      });
      const events = await superuser.selectFrom('job_events').select(['kind', 'message']).where('job_id', '=', analysis.id).orderBy('id').execute();
      expect(events.map((event: { message: string | null }) => event.message)).toEqual(expect.arrayContaining(['开始解析招标文件。', '招标文件解析完成。']));
    } finally {
      await runner.close();
      await dispatcher.close();
    }
  });
});
