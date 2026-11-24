// 技术方案正文生成的基础编排（路线图第 8 步 8.10b1，src/technicalPlan/contentGenerationJob.ts）的数据库与接口测试：
// - Store：contentGenerationInputSignature 覆盖的内容（目录、目录的字数控制快照、正文生成选项、引用的知识库文档、招标解析项、全局事实、原方案；
//   步骤与正文生成自己写入的编排、状态、运行进度不影响），saveContentPlanningResult 在签名不符时不写入、相符时整体写入编排（不在目录中的跳过）
//   与运行进度；
// - 任务（假 Agent、真实数据库）：基础编排写入的编排与运行进度，之后以 TECHNICAL_PLAN_CONTENT_STAGE_UNAVAILABLE 失败；状态中的
//   contentGenerationTask；全部可以复用时不打开沙箱；全文重新生成；
// - 接口：POST .../content-generation 的前置检查（文案与桌面版相同）、202、正文生成的 Agent 任务上限、请求体字段、互斥；清空时取消。
// 与桌面版逐项对照见 tests/technicalPlan/contentGenerationJob.test.ts。
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import type { AgentRun, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import { buildApp } from '../../src/app.ts';
import { writeArtifact } from '../../src/artifacts/store.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database, MemberRole } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import type { JobContext } from '../../src/jobs/definitions.ts';
import { claimJob, finishRun, renewRun, type RunRef } from '../../src/jobs/store.ts';
import { CONTENT_GENERATION_JOB_TYPE, createTechnicalPlanJobs } from '../../src/technicalPlan/jobs.ts';
import {
  contentGenerationInputSignature,
  importTenderFiles,
  loadTechnicalPlan,
  saveBidItems,
  saveContentGenerationOptions,
  saveContentGenerationRuntime,
  saveContentPlanningResult,
  saveContentPlans,
  saveContentSections,
  saveDocumentParse,
  saveGeneratedOutline,
  saveGenerationConfig,
  saveGlobalFacts,
  setOriginalPlan,
  updateStep,
} from '../../src/technicalPlan/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const PASSWORD = 'quiet-harbor-maple-91';

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

async function addMember(orgId: string, role: MemberRole): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { userId, orgId, cookie: await login(email), context: { orgId, userId, role } };
}

/** 新的团队组织与其 owner；默认已选择平台模型、充值 10 元。 */
async function newOrg(options: { balance?: bigint } = {}): Promise<Member> {
  const orgId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  const owner = await addMember(orgId, 'owner');
  await superuser.insertInto('org_settings').values({ org_id: orgId, platform_model_id: platformModelId, updated_by: owner.userId }).execute();
  const balance = options.balance ?? 100_000n;
  if (balance > 0n) await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: balance, reference: null, note: '测试充值' });
  return owner;
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

async function markdownArtifact(member: Member, projectId: string | null, fileId: string, markdown: string): Promise<string> {
  const artifact = await writeArtifact(
    appDb,
    member.context,
    memoryStore,
    { kind: 'markdown', name: 'content.md', mime: 'text/markdown; charset=utf-8', projectId, sourceFileId: fileId },
    Buffer.from(markdown, 'utf8'),
  );
  return artifact.id;
}

async function markParsed(member: Member, projectId: string, fileId: string, markdown: string): Promise<void> {
  const artifactId = await markdownArtifact(member, projectId, fileId, markdown);
  expect(
    await saveDocumentParse(appDb, member.context, projectId, fileId, {
      status: 'success',
      markdownArtifactId: artifactId,
      contentChars: markdown.length,
      contentHash: sha256(markdown),
      parserLabel: '本地解析',
    }),
  ).toBe(true);
}

/** 已解析成功的知识库文档。 */
async function newKnowledgeDocument(member: Member): Promise<string> {
  const fileId = await newFile(member, '知识.docx', 'knowledge');
  const folder = await superuser.insertInto('knowledge_folders').values({ org_id: member.orgId, name: '资料', created_by: member.userId, updated_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  const document = await superuser.insertInto('knowledge_documents').values({ org_id: member.orgId, folder_id: folder.id, file_id: fileId, created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  await superuser.updateTable('knowledge_documents').set({ status: 'success', progress: 100 }).where('id', '=', document.id).execute();
  return document.id;
}

const LEASE_MS = 60_000;

const LEAVES = [randomUUID(), randomUUID(), randomUUID()];
const MANUAL = randomUUID();
const outlineOf = () => [
  {
    id: randomUUID(),
    title: '技术方案',
    description: '技术响应',
    children: [
      { id: LEAVES[0], title: '总体设计', description: '总体', content_mode: 'ai-generate' },
      { id: LEAVES[1], title: '实施计划', description: '计划', content_mode: 'ai-generate' },
      { id: MANUAL, title: '资质证书', description: '证书', content_mode: 'manual-fill' },
      { id: LEAVES[2], title: '售后服务', description: '售后', content_mode: 'ai-generate' },
    ],
  },
];
const WORD_CONTROL = { minimumWords: 3000, maximumWords: 6000, sectionWords: 1000 };

/** 有目录（三个 AI 小节）、字数控制快照与全局事实的项目；招标文件已解析。 */
async function fixture(member: Member, options: { globalFacts?: boolean; outline?: boolean } = {}): Promise<string> {
  const projectId = await newProject(member);
  const tender = await newFile(member, '招标文件.docx');
  await importTenderFiles(appDb, member.context, projectId, [tender]);
  await markParsed(member, projectId, tender, '# 招标公告');
  await saveBidItems(appDb, member.context, projectId, { projectOverview: { status: 'success', content: '某市智慧水务平台' } });
  await saveContentGenerationOptions(appDb, member.context, projectId, { tableRequirement: 'heavy', imageQuantity: 50 });
  if (options.outline !== false) await saveGeneratedOutline(appDb, member.context, projectId, { outlineData: { outline: outlineOf() }, wordControlSnapshot: WORD_CONTROL });
  if (options.globalFacts !== false) await saveGlobalFacts(appDb, member.context, projectId, [{ id: 'g1', title: '工期', content: '180 天' }]);
  return projectId;
}

function planningOutput(ids: readonly string[]): string {
  return JSON.stringify({
    plans: ids.map((id, index) => ({
      id,
      content_plan: {
        writing_focus: `第 ${index + 1} 节重点`,
        target_words: 1000 * (index + 1),
        image_suitability_score: 9 - index,
        knowledge: { item_ids: [] },
        table: index === 1 ? { needed: true, purpose: '对比' } : { needed: false, purpose: '' },
      },
    })),
  });
}

const AGENT_STATE = { version: 1, session: 's.jsonl', stage: 'content-planning', stageIndex: 0, promptedStage: 'content-planning', compactionPending: null, baseline: { version: 1, groups: {} }, snapshot: null };

/** 假 Agent：读结果文件时返回给定的 正文编排结果.json；检查点经 context.saveCheckpoint 写进任务（与执行者相同的 { agent, task } 形式）。 */
function scriptedAgent(output: string, save: (checkpoint: Record<string, unknown>) => Promise<void>) {
  const record = { files: new Map<string, string>(), opened: 0 };
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
      release: (_group: string, paths: readonly string[]) => [...paths],
    },
    async readFiles(paths: readonly string[]) {
      return new Map([[paths[0]!, { size: output.length, data: Buffer.from(output, 'utf8') }]]);
    },
    async runStage(stage: AgentStageOptions<unknown>) {
      if (stage.checkpointAfterPrompt) await save({ agent: AGENT_STATE, task: stage.checkpointAfterPrompt() });
      const report = await stage.validate({ attempt: 1, restored: [] });
      expect(report.issues).toEqual([]);
      return { value: report.value, acceptedIssues: [], repairs: 0, executionRetries: 0 };
    },
    async checkpoint(task: Record<string, unknown> | null) {
      await save({ agent: AGENT_STATE, task });
    },
    async close() {},
  };
  const agent: JobAgent = {
    template: 'agent',
    resuming: false,
    open: async () => {
      record.opened += 1;
      return run as unknown as AgentRun;
    },
  };
  return { agent, record };
}

const definition = createTechnicalPlanJobs().find((job) => job.type === CONTENT_GENERATION_JOB_TYPE)!;

async function claim(member: Member, jobId: string): Promise<RunRef> {
  const runId = randomUUID();
  const result = await claimJob(appDb, { orgId: member.orgId, jobId, runId, leaseMs: LEASE_MS, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 });
  expect(result.kind).toBe('claimed');
  return { orgId: member.orgId, jobId, runId };
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
}

/** 认领并执行一次（假 Agent），按结果结束本次执行。 */
async function execute(member: Member, projectId: string, jobId: string, output: string) {
  const run = await claim(member, jobId);
  const row = await jobRow(jobId);
  const saveCheckpoint = async (checkpoint: Record<string, unknown>) => {
    expect(await renewRun(appDb, run, LEASE_MS, { checkpoint })).not.toBeNull();
  };
  const { agent, record } = scriptedAgent(output, saveCheckpoint);
  const logs: string[] = [];
  const context: JobContext<any> = {
    jobId,
    projectId,
    type: CONTENT_GENERATION_JOB_TYPE,
    attempt: row.attempt,
    params: definition.parseParams(row.params),
    checkpoint: row.checkpoint,
    tenant: member.context,
    db: appDb,
    signal: new AbortController().signal,
    async setProgress() {},
    saveCheckpoint,
    async log(message) {
      logs.push(message);
    },
    ai: null as never,
    objectStore: memoryStore,
    sandbox: null,
    agentWorkspace: null,
    agent,
  };
  let error: unknown = null;
  try {
    await definition.run(context);
  } catch (caught) {
    error = caught;
  }
  const outcome = error === null ? ({ kind: 'succeeded' } as const) : ({ kind: 'failed', code: (error as { code?: string }).code ?? 'JOB_FAILED', message: (error as Error).message } as const);
  const status = await finishRun(appDb, run, outcome, true);
  return { status, error, record, logs };
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
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'technical-plan-content-generation-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
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

describe('Store', () => {
  it('输入签名：目录、字数控制快照、正文生成选项、知识库引用、招标解析项、全局事实、原方案变化时改变；步骤与正文生成自己写入的内容不影响', async () => {
    const member = await newOrg();
    const projectId = await fixture(member);
    const signature = () => contentGenerationInputSignature(appDb, member.context, projectId);
    const seen = new Set<string>([await signature()]);
    const changed = async (what: string) => {
      const next = await signature();
      expect(seen.has(next), what).toBe(false);
      seen.add(next);
    };
    const unchanged = async (what: string) => expect(seen.has(await signature()), what).toBe(true);

    await updateStep(appDb, member.context, projectId, 'content-edit');
    await saveContentPlans(appDb, member.context, projectId, { [LEAVES[0]!]: { plan_version: 6, plan: { writing_focus: 'x' } } });
    await saveContentSections(appDb, member.context, projectId, { [LEAVES[0]!]: { status: 'error', error: '失败' } });
    await saveContentGenerationRuntime(appDb, member.context, projectId, { generation_started: true });
    await unchanged('步骤、编排、正文状态与运行进度');
    await saveContentGenerationOptions(appDb, member.context, projectId, { tableRequirement: 'none' });
    await changed('正文生成选项');
    await saveGeneratedOutline(appDb, member.context, projectId, { outlineData: { outline: outlineOf() }, wordControlSnapshot: { ...WORD_CONTROL, sectionWords: 2000 } });
    await changed('目录与字数控制快照');
    await saveGlobalFacts(appDb, member.context, projectId, [{ id: 'g1', title: '工期', content: '90 天' }]);
    await changed('全局事实');
    await saveBidItems(appDb, member.context, projectId, { projectInfo: { status: 'success', content: '项目信息' } });
    await changed('招标解析项');
    await saveGenerationConfig(appDb, member.context, projectId, { referenceKnowledgeDocumentIds: [await newKnowledgeDocument(member)] });
    await changed('引用的知识库文档');
    await setOriginalPlan(appDb, member.context, projectId, await newFile(member, '原方案.docx'));
    await changed('原方案');
  });

  it('saveContentPlanningResult：签名不符时不写入；相符时整体写入编排（不在目录中的跳过）与运行进度', async () => {
    const member = await newOrg();
    const projectId = await fixture(member);
    await saveContentPlans(appDb, member.context, projectId, { [LEAVES[2]!]: { plan_version: 6, plan: { writing_focus: '旧' } } });
    const signature = await contentGenerationInputSignature(appDb, member.context, projectId);
    const plans = {
      [LEAVES[0]!]: { plan_version: 6, plan: { writing_focus: '一' }, table_requirement: 'heavy' },
      [LEAVES[1]!]: { plan_version: 6, plan: { writing_focus: '二' } },
      [randomUUID()]: { plan_version: 6, plan: { writing_focus: '已删除的节点' } },
    };
    const runtime = { generation_started: true, phase: 'planning', completed_stages: ['planning'] };
    expect(await saveContentPlanningResult(appDb, member.context, projectId, { plans, runtime }, 'other')).toBe(false);
    expect(Object.keys((await loadTechnicalPlan(appDb, member.context, projectId)).contentGenerationPlans)).toEqual([LEAVES[2]]);
    expect(await saveContentPlanningResult(appDb, member.context, projectId, { plans, runtime }, signature)).toBe(true);
    const state = await loadTechnicalPlan(appDb, member.context, projectId);
    expect(Object.keys(state.contentGenerationPlans).sort()).toEqual([LEAVES[0], LEAVES[1]].sort());
    expect(state.contentGenerationPlans[LEAVES[0]!]).toMatchObject({ plan_version: 6, plan: { writing_focus: '一' }, table_requirement: 'heavy' });
    expect(state.contentGenerationRuntime).toEqual(runtime);
    // 其他组织写不进。
    const other = await newOrg();
    expect(await saveContentPlanningResult(appDb, other.context, projectId, { plans, runtime }, signature)).toBe(false);
  });
});

describe('任务', () => {
  it('基础编排写入编排与运行进度，之后以 TECHNICAL_PLAN_CONTENT_STAGE_UNAVAILABLE 失败；状态中返回任务；全部可以复用时不打开沙箱', async () => {
    const owner = await newOrg();
    const projectId = await fixture(owner);
    const started = await call(owner, 'POST', planUrl(projectId, '/content-generation'));
    expect(started.statusCode, started.body).toBe(202);
    const jobId = started.json().job.id as string;
    const { status, error, record, logs } = await execute(owner, projectId, jobId, planningOutput(LEAVES));
    expect(status).toBe('failed');
    expect(error).toMatchObject({ code: 'TECHNICAL_PLAN_CONTENT_STAGE_UNAVAILABLE' });
    expect(record.opened).toBe(1);
    expect(JSON.parse(record.files.get('正文编排目标.json')!)).toEqual({ target_ids: LEAVES });
    expect(record.files.get('正文编排结果.json')).toBe('');
    expect(logs).toContain('本次 3 个小节的编排及配图标记已保存。');
    const state = await loadTechnicalPlan(appDb, owner.context, projectId);
    expect(Object.keys(state.contentGenerationPlans).sort()).toEqual([...LEAVES].sort());
    // 全文基准 4500 字按 1:2:3 分配（与桌面版相同，每节先保底 1 字，余数按小数部分与目录顺序）；配图名额 floor(3 × 50%) = 1；表格“大量”保持候选。
    expect(LEAVES.map((id) => state.contentGenerationPlans[id]!.plan.target_words)).toEqual([751, 1500, 2249]);
    expect(LEAVES.map((id) => state.contentGenerationPlans[id]!.plan.image_needed)).toEqual([true, false, false]);
    expect(LEAVES.map((id) => (state.contentGenerationPlans[id]!.plan.table as { needed: boolean }).needed)).toEqual([false, true, false]);
    expect(state.contentGenerationRuntime).toMatchObject({ generation_started: true, phase: 'planning', completed_stages: ['planning'] });
    expect(state.contentGenerationTask).toMatchObject({ id: jobId, type: 'content-generation', status: 'failed', error: { code: 'TECHNICAL_PLAN_CONTENT_STAGE_UNAVAILABLE' } });
    expect((await jobRow(jobId)).checkpoint.task).toEqual({ signature: expect.any(String), planningTargetIds: LEAVES, planned: true });

    // 再次开始：编排全部可以复用，不打开沙箱。
    const again = await call(owner, 'POST', planUrl(projectId, '/content-generation'), { regenerate: false });
    expect(again.statusCode, again.body).toBe(202);
    const second = await execute(owner, projectId, again.json().job.id, planningOutput(LEAVES));
    expect(second.error).toMatchObject({ code: 'TECHNICAL_PLAN_CONTENT_STAGE_UNAVAILABLE' });
    expect(second.record.opened).toBe(0);
    expect(second.logs).toContain('继续整体编排决策，共 3 个小节，复用 3 个历史编排。');
    const withoutTimes = (plans: Record<string, { updated_at: Date }>) => Object.fromEntries(Object.entries(plans).map(([id, { updated_at: _time, ...plan }]) => [id, plan]));
    expect(withoutTimes((await loadTechnicalPlan(appDb, owner.context, projectId)).contentGenerationPlans)).toEqual(withoutTimes(state.contentGenerationPlans));

    // 全文重新生成：全部重新编排。
    const regenerate = await call(owner, 'POST', planUrl(projectId, '/content-generation'), { regenerate: true });
    expect(regenerate.statusCode, regenerate.body).toBe(202);
    const third = await execute(owner, projectId, regenerate.json().job.id, planningOutput([...LEAVES].reverse()));
    expect(third.record.opened).toBe(1);
    const regenerated = (await loadTechnicalPlan(appDb, owner.context, projectId)).contentGenerationPlans;
    expect(regenerated[LEAVES[2]!]!.plan.writing_focus).toBe('第 1 节重点');
  });
});

describe('接口', () => {
  it('前置检查（文案与桌面版相同）、202 与正文生成的 Agent 任务上限、请求体字段、互斥；清空技术方案时取消', async () => {
    const owner = await newOrg();
    const noOutline = await fixture(owner, { outline: false });
    const missing = await call(owner, 'POST', planUrl(noOutline, '/content-generation'));
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toMatchObject({ code: 'TECHNICAL_PLAN_WORD_CONTROL_REQUIRED', message: '当前目录没有字数控制生效快照，请重新生成目录' });
    const noFacts = await fixture(owner, { globalFacts: false });
    const factsMissing = await call(owner, 'POST', planUrl(noFacts, '/content-generation'));
    expect(factsMissing.statusCode).toBe(409);
    expect(factsMissing.json().error).toMatchObject({ code: 'TECHNICAL_PLAN_GLOBAL_FACTS_REQUIRED', message: '请先完成全局事实设定，再生成正文' });

    const projectId = await fixture(owner);
    expect((await call(owner, 'POST', planUrl(projectId, '/content-generation'), { targetItemId: LEAVES[0] })).statusCode).toBe(400);
    expect((await call(owner, 'POST', planUrl(projectId, '/content-generation'), { regenerate: 'yes' })).statusCode).toBe(400);
    const started = await call(owner, 'POST', planUrl(projectId, '/content-generation'), { regenerate: true });
    expect(started.statusCode).toBe(202);
    const row = await jobRow(started.json().job.id);
    expect(row).toMatchObject({ type: 'content-generation', status: 'queued', params: { regenerate: true }, lock_key: `project:${projectId}:technical-plan` });
    const budget = await superuser.selectFrom('agent_job_budgets').selectAll().where('job_id', '=', row.id).executeTakeFirstOrThrow();
    expect({ cost: BigInt(budget.cost_limit), turns: budget.turn_limit }).toEqual({ cost: AGENT_TASK_LIMITS.contentGeneration.costLimit, turns: AGENT_TASK_LIMITS.contentGeneration.turnLimit });
    const locked = await call(owner, 'POST', planUrl(projectId, '/content-generation'));
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('JOB_LOCKED');
    // 其他组织的项目 404。
    const other = await newOrg();
    expect((await call(other, 'POST', planUrl(projectId, '/content-generation'))).statusCode).toBe(404);
    expect((await call(owner, 'DELETE', planUrl(projectId))).statusCode).toBe(200);
    expect((await jobRow(row.id)).status).toBe('cancelled');
  });
});
