// 技术方案目录生成的一级目录与确认（路线图第 8 步 8.7e1，src/technicalPlan/jobs.ts 的 outline-generation、迁移 0044_job_pause_selection、
// src/jobs/store.ts 的 confirmJobSelection）的数据库与接口测试：
// - Store：outlineGenerationInputSignature 覆盖的内容（目录、原方案、招标解析项、目录的组织方式 / 扩展方式 / 字数控制、引用的知识库文档、
//   全局事实；步骤与正文生成选项不影响），saveOutlineGenerationResult 在签名不符时不写入、相符时整体替换目录、清空正文与全局事实、写入
//   字数控制快照；readOutlineKnowledgeMarkdowns（按引用顺序，没有 Markdown 的为空）；
// - 暂停与确认：一级目录阶段之后暂停为 waiting_for_selection（事件与原因），已请求暂停时按手动暂停收尾；等待中普通继续 409、其他技术方案任务
//   互斥；状态中的 outlineGenerationTask 与 outlineSelection；确认的权限（发起人与 owner / admin，普通成员 403）、其他项目 / 其他组织 404、
//   选择不合法 400、不在等待 409、余额不足 402（都不改）；确认后回到 queued、checkpoint 中写下确认的选择，再次确认 409；
// - 确认后续跑（假 Agent、真实数据库）：写入所选一级目录、清空全局事实与正文、写入字数控制、丢弃全局事实的会话、保留目录的会话；无技术评分项
//   模式经子目录生成、叶子调整（按 agent_questions 中用户的回答）与目录审查写入目录（8.7e2a）；评分模式经评分规划、子目录生成、叶子调整与
//   目录审查写入目录，评分规划写进 checkpoint（8.7e2b）；
// - findLatestConsumedAgentAnswer / agentQuestionClock（8.7e2a）：只取起点之后、已交给 Agent 的回答，排除终止确认，按组织隔离；
// - 接口：POST .../outline-generation 的前置检查（文案与桌面版相同）、202 与 Agent 任务上限、无技术评分项模式的确认、请求体字段；清空时取消。
// 与桌面版逐项对照见 tests/technicalPlan/outlineGenerationJob.test.ts。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRun, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import { agentQuestionClock, findLatestConsumedAgentAnswer } from '../../src/agent/questions.ts';
import { TERMINATION_OPTIONS } from '../../src/agent/requestTerminationTool.ts';
import { findWorkspaceSnapshot, writeWorkspaceSnapshot } from '../../src/agent/workspaceSnapshots.ts';
import { buildApp } from '../../src/app.ts';
import { writeArtifact } from '../../src/artifacts/store.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database, MemberRole } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { JobSelectionRequiredError, type JobContext } from '../../src/jobs/definitions.ts';
import { claimJob, finishRun, renewRun, requestPause, requestResume, type RunRef } from '../../src/jobs/store.ts';
import { createTechnicalPlanJobs, OUTLINE_GENERATION_JOB_TYPE } from '../../src/technicalPlan/jobs.ts';
import {
  importTenderFiles,
  loadTechnicalPlan,
  outlineGenerationInputSignature,
  readOutlineKnowledgeMarkdowns,
  saveBidItems,
  saveContentGenerationOptions,
  saveDocumentParse,
  saveGeneratedOutline,
  saveGenerationConfig,
  saveGlobalFacts,
  saveOutlineGenerationResult,
  setOriginalPlan,
  updateStep,
} from '../../src/technicalPlan/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const PASSWORD = 'quiet-harbor-maple-91';
const LEASE_MS = 60_000;

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

/** 知识库文档；markdown 给出时写入解析出的 Markdown 产物。 */
async function newKnowledgeDocument(member: Member, markdown: string | null): Promise<string> {
  const fileId = await newFile(member, '知识.docx', 'knowledge');
  const folder = await superuser.insertInto('knowledge_folders').values({ org_id: member.orgId, name: '资料', created_by: member.userId, updated_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  const document = await superuser.insertInto('knowledge_documents').values({ org_id: member.orgId, folder_id: folder.id, file_id: fileId, created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  const artifactId = markdown === null ? null : await markdownArtifact(member, null, fileId, markdown);
  await superuser.updateTable('knowledge_documents').set({ status: 'success', progress: 100, markdown_artifact_id: artifactId }).where('id', '=', document.id).execute();
  return document.id;
}

const TECH_REQUIREMENTS = '## 技术评分项\n1. 总体设计（10 分）';
const NO_TECH_SCORE = '## 技术评分项\n没有提及';

/** 已解析的招标文件、技术评分要求与响应文件要求；没有目录、没有原方案。 */
async function fixture(member: Member, options: { techRequirements?: string } = {}): Promise<string> {
  const projectId = await newProject(member);
  const tender = await newFile(member, '招标文件.docx');
  await importTenderFiles(appDb, member.context, projectId, [tender]);
  await markParsed(member, projectId, tender, '# 招标公告');
  await saveBidItems(appDb, member.context, projectId, {
    projectOverview: { status: 'success', content: '某市智慧水务平台' },
    techRequirements: { status: 'success', content: options.techRequirements ?? TECH_REQUIREMENTS },
    responseFileRequirements: { status: 'success', content: '投标文件由目录、技术方案、报价组成。' },
  });
  await saveGenerationConfig(appDb, member.context, projectId, { outlineMode: 'response-file', outlineWordControlOptions: { minimumWords: 30000, maximumWords: 50000, sectionWords: 3000 } });
  return projectId;
}

const INITIAL = JSON.stringify({
  outline: [
    { id: null, title: '投标文件目录', description: '目录', attr: '目录', content_mode: 'directory-generate' },
    { id: null, title: '技术方案', description: '技术响应', attr: '技术', content_mode: 'ai-generate' },
    { id: null, title: '投标报价', description: '报价表', attr: '报价', content_mode: 'manual-fill' },
  ],
});

const AGENT_STATE = { version: 1, session: 's.jsonl', stage: 'initial-outline', stageIndex: 0, promptedStage: 'initial-outline', compactionPending: null, baseline: { version: 1, groups: {} }, snapshot: null };

/** 假 Agent：读结果文件时返回给定的 outline.json；检查点经 context.saveCheckpoint 写进任务（与执行者相同的 { agent, task } 形式）。 */
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
      const report = await stage.validate({ attempt: 1, restored: [] });
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

/** 后续阶段的一步（8.7e2a、8.7e2b）：Agent 按当前 outline.json 写出的目录、（审查阶段）outline-review.json、（评分规划）其他文件，以及本阶段中写入的问题与回答。 */
interface StagedStep {
  outline: (current: any) => unknown;
  review?: unknown;
  files?: (current: any) => Record<string, unknown>;
  onStage?: (member: Member, run: RunRef) => Promise<void>;
}

/** 按阶段脚本化的假 Agent（续跑：taskCheckpoint 为 checkpoint 中任务自己的状态）；工作区在内存中。 */
function stagedAgent(steps: StagedStep[], save: (checkpoint: Record<string, unknown>) => Promise<void>, taskCheckpoint: Record<string, unknown> | null, onStage: (step: StagedStep) => Promise<void>) {
  const record = { files: new Map<string, string>(), opened: 0, stages: [] as string[] };
  let index = 0;
  const run = {
    sandbox: { id: 'sandbox-1' },
    resumed: true,
    unavailableProtectedFiles: [],
    taskCheckpoint,
    baseline: {
      async write(_sandbox: unknown, _group: string, files: { path: string; data: Buffer }[]) {
        for (const file of files) record.files.set(file.path, file.data.toString('utf8'));
      },
      release: (_group: string, paths: readonly string[]) => [...paths],
      original: (path: string) => (record.files.has(path) ? Buffer.from(record.files.get(path)!, 'utf8') : null),
    },
    async readFiles(paths: readonly string[]) {
      return new Map(paths.filter((path) => record.files.has(path)).map((path) => [path, { size: 1, data: Buffer.from(record.files.get(path)!, 'utf8') }]));
    },
    async runStage(stage: AgentStageOptions<unknown>) {
      record.stages.push(stage.stage);
      const step = steps[index++]!;
      await onStage(step);
      const current = JSON.parse(record.files.get('outline.json')!);
      for (const [path, content] of Object.entries(step.files?.(current) ?? {})) record.files.set(path, JSON.stringify(content));
      record.files.set('outline.json', JSON.stringify(step.outline(current)));
      if (step.review !== undefined) record.files.set('outline-review.json', JSON.stringify(step.review));
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
    resuming: true,
    open: async () => {
      record.opened += 1;
      return run as unknown as AgentRun;
    },
  };
  return { agent, record };
}

const LEAF_OPTIONS = [
  { label: '接受当前结果', description: '', custom: false },
  { label: '允许 Agent 自行调整', description: '', custom: false },
  { label: '自定义需求', description: '', custom: true },
];

/** 写入一个已交给 Agent 的回答（agent_questions，status consumed）。 */
async function consumedQuestion(member: Member, run: RunRef, options: { label: string; description: string; custom: boolean }[], answer: number, askedAt?: string) {
  await sql`INSERT INTO agent_questions (org_id, job_id, run_id, content_hash, question, options, status, asked_at, answer_option, answered_by, answered_at, consumed_run_id, consumed_at)
    VALUES (${member.orgId}, ${run.jobId}, ${run.runId}, ${randomBytes(32)}, '问题', ${JSON.stringify(options)}::jsonb, 'consumed', ${askedAt ?? sql`now()`}, ${answer}, ${member.userId}, now(), ${run.runId}, now())`.execute(superuser);
}

const definition = createTechnicalPlanJobs().find((job) => job.type === OUTLINE_GENERATION_JOB_TYPE)!;

async function claim(member: Member, jobId: string): Promise<RunRef> {
  const runId = randomUUID();
  const result = await claimJob(appDb, { orgId: member.orgId, jobId, runId, leaseMs: LEASE_MS, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 });
  expect(result.kind).toBe('claimed');
  return { orgId: member.orgId, jobId, runId };
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
}

/** 认领并执行一次（假 Agent），按结果结束本次执行（与执行者相同的判断）。返回结束后的状态与任务抛出的错误。 */
async function execute(member: Member, projectId: string, jobId: string, output = INITIAL, staged?: StagedStep[]) {
  const run = await claim(member, jobId);
  const row = await jobRow(jobId);
  const saveCheckpoint = async (checkpoint: Record<string, unknown>) => {
    expect(await renewRun(appDb, run, LEASE_MS, { checkpoint })).not.toBeNull();
  };
  const { agent, record } = staged ? stagedAgent(staged, saveCheckpoint, row.checkpoint?.task ?? null, async (step) => step.onStage?.(member, run)) : scriptedAgent(output, saveCheckpoint);
  const context: JobContext<any> = {
    jobId,
    projectId,
    type: OUTLINE_GENERATION_JOB_TYPE,
    attempt: row.attempt,
    params: definition.parseParams(row.params),
    checkpoint: row.checkpoint,
    tenant: member.context,
    db: appDb,
    signal: new AbortController().signal,
    async setProgress() {},
    saveCheckpoint,
    async log() {},
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
  const outcome =
    error === null
      ? ({ kind: 'succeeded' } as const)
      : error instanceof JobSelectionRequiredError
        ? ({ kind: 'waiting-for-selection' } as const)
        : ({ kind: 'failed', code: (error as { code?: string }).code ?? 'JOB_FAILED', message: (error as Error).message } as const);
  const status = await finishRun(appDb, run, outcome, true);
  return { status, error, record, run };
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

/** 开始目录生成并执行到等待确认。 */
async function waitingJob(member: Member, projectId: string, body?: Record<string, unknown>): Promise<{ jobId: string; items: { id: string; title: string }[] }> {
  const started = await call(member, 'POST', planUrl(projectId, '/outline-generation'), body);
  expect(started.statusCode, started.body).toBe(202);
  const jobId = started.json().job.id as string;
  const { status } = await execute(member, projectId, jobId);
  expect(status).toBe('paused');
  const items = ((await jobRow(jobId)).checkpoint.task.selection.items as { id: string; title: string }[]).map(({ id, title }) => ({ id, title }));
  return { jobId, items };
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
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'technical-plan-outline-generation-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
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
  it('输入签名：目录、原方案、招标解析项、组织方式、扩展方式、字数控制、引用的知识库文档与全局事实变化时改变；步骤与正文生成选项不影响', async () => {
    const member = await newOrg();
    const projectId = await fixture(member);
    const signature = () => outlineGenerationInputSignature(appDb, member.context, projectId);
    const seen = new Set<string>([await signature()]);
    const changed = async (what: string) => {
      const next = await signature();
      expect(seen.has(next), what).toBe(false);
      seen.add(next);
    };
    const unchanged = async (what: string) => expect(seen.has(await signature()), what).toBe(true);

    await updateStep(appDb, member.context, projectId, 'outline-generation');
    await saveContentGenerationOptions(appDb, member.context, projectId, { imageQuantity: 20 });
    await unchanged('步骤与正文生成选项');
    await saveGeneratedOutline(appDb, member.context, projectId, { outlineData: { outline: [{ id: randomUUID(), title: '旧目录', description: '' }] }, wordControlSnapshot: null });
    await changed('目录');
    await saveBidItems(appDb, member.context, projectId, { responseFileRequirements: { status: 'success', content: '新的响应文件要求' } });
    await changed('招标解析项');
    await saveGenerationConfig(appDb, member.context, projectId, { outlineMode: 'standalone-technical' });
    await changed('组织方式');
    await saveGenerationConfig(appDb, member.context, projectId, { outlineExpansionMode: 'original-only' });
    await changed('扩展方式');
    await saveGenerationConfig(appDb, member.context, projectId, { outlineWordControlOptions: { minimumWords: 1, maximumWords: 2, sectionWords: 3 } });
    await changed('字数控制');
    await saveGenerationConfig(appDb, member.context, projectId, { referenceKnowledgeDocumentIds: [await newKnowledgeDocument(member, '# 知识')] });
    await changed('引用的知识库文档');
    await saveGlobalFacts(appDb, member.context, projectId, [{ id: 'g1', title: '工期', content: '180 天' }]);
    await changed('全局事实');
    const plan = await newFile(member, '原方案.docx');
    await setOriginalPlan(appDb, member.context, projectId, plan);
    await changed('原方案');
  });

  it('saveOutlineGenerationResult：签名不符时不写入；相符时整体替换目录、清空正文与全局事实、写入字数控制快照与项目概述', async () => {
    const member = await newOrg();
    const projectId = await fixture(member);
    const old = randomUUID();
    await saveGeneratedOutline(appDb, member.context, projectId, { outlineData: { outline: [{ id: old, title: '旧目录', description: '' }] }, wordControlSnapshot: null });
    await saveGlobalFacts(appDb, member.context, projectId, [{ id: 'g1', title: '工期', content: '180 天' }]);
    const signature = await outlineGenerationInputSignature(appDb, member.context, projectId);
    const outline = [
      { id: randomUUID(), number: '1', title: '投标文件目录', description: '目录', attr: '目录', content_mode: 'directory-generate' },
      { id: randomUUID(), number: '2', title: '投标报价', description: '报价表', attr: '报价', content_mode: 'manual-fill' },
    ];
    const input = { outline, projectOverview: '某市智慧水务平台', wordControl: { minimumWords: 30000, maximumWords: 50000, sectionWords: 3000 } };
    expect(await saveOutlineGenerationResult(appDb, member.context, projectId, input, 'other')).toBe(false);
    expect((await loadTechnicalPlan(appDb, member.context, projectId)).outlineData!.outline[0]!.id).toBe(old);
    expect(await saveOutlineGenerationResult(appDb, member.context, projectId, input, signature)).toBe(true);
    const state = await loadTechnicalPlan(appDb, member.context, projectId);
    expect(state.outlineData).toEqual({
      project_overview: '某市智慧水务平台',
      outline: [
        { id: outline[0]!.id, number: '1', title: '投标文件目录', description: '目录', content_mode: 'directory-generate' },
        { id: outline[1]!.id, number: '2', title: '投标报价', description: '报价表', content_mode: 'manual-fill' },
      ],
    });
    expect(state.globalFacts).toEqual([]);
    expect(state.outlineWordControlSnapshot).toEqual(input.wordControl);
  });

  it('readOutlineKnowledgeMarkdowns：按引用顺序；没有解析出 Markdown、对象已不在存储中的为空', async () => {
    const member = await newOrg();
    const projectId = await fixture(member);
    const first = await newKnowledgeDocument(member, '# 知识一');
    const none = await newKnowledgeDocument(member, null);
    const gone = await newKnowledgeDocument(member, '# 已删除');
    const last = await newKnowledgeDocument(member, '# 知识三');
    const key = await superuser
      .selectFrom('knowledge_documents as d')
      .innerJoin('artifacts as a', 'a.id', 'd.markdown_artifact_id')
      .select('a.storage_key')
      .where('d.id', '=', gone)
      .executeTakeFirstOrThrow();
    objects.delete(key.storage_key);
    await saveGenerationConfig(appDb, member.context, projectId, { referenceKnowledgeDocumentIds: [last, none, gone, first] });
    expect(await readOutlineKnowledgeMarkdowns(appDb, member.context, projectId, memoryStore)).toEqual(['# 知识三', '', '', '# 知识一']);
    await saveGenerationConfig(appDb, member.context, projectId, { referenceKnowledgeDocumentIds: [] });
    expect(await readOutlineKnowledgeMarkdowns(appDb, member.context, projectId, memoryStore)).toEqual([]);
  });
});

describe('暂停等待确认与确认', () => {
  it('一级目录阶段之后暂停为 waiting_for_selection；状态中返回任务与待确认的一级目录；普通继续 409、其他技术方案任务互斥', async () => {
    const owner = await newOrg();
    const projectId = await fixture(owner);
    const { jobId, items } = await waitingJob(owner, projectId);
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: 'paused', pause_reason: 'waiting_for_selection', run_id: null });
    expect(row.checkpoint.task.selection.selectedIds).toEqual(items.map((item) => item.id));
    const event = await superuser.selectFrom('job_events').select(['kind', 'message', 'data']).where('job_id', '=', jobId).orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(event).toEqual({ kind: 'paused', message: '等待确认，确认后任务会继续', data: { reason: 'waiting_for_selection' } });

    const state = (await call(owner, 'GET', planUrl(projectId))).json();
    expect(state.outlineGenerationTask).toMatchObject({ id: jobId, type: 'outline-generation', status: 'paused', pauseReason: 'waiting_for_selection' });
    expect(state.outlineSelection.confirmed).toBe(false);
    expect(state.outlineSelection.items.map((item: { title: string; attr: string }) => [item.title, item.attr])).toEqual([
      ['投标文件目录', '目录'],
      ['技术方案', '技术'],
      ['投标报价', '报价'],
    ]);
    expect(state.outlineSelection.selected_ids).toEqual(items.map((item) => item.id));
    expect(state.outlineData).toBeNull();

    await expect(requestResume(appDb, owner.context, jobId)).rejects.toMatchObject({ statusCode: 409, code: 'JOB_SELECTION_REQUIRED' });
    const other = await call(owner, 'POST', planUrl(projectId, '/global-facts-generation'));
    expect(other.statusCode).toBe(409);
    expect((await jobRow(jobId)).status).toBe('paused');
  });

  it('确认：普通成员 403、其他项目 / 其他组织 404、选择不合法 400、余额不足 402（都不改）；发起人确认后回到 queued，checkpoint 写下确认的选择；再次确认 409', async () => {
    const owner = await newOrg();
    const creator = await addMember(owner.orgId, 'member');
    const bystander = await addMember(owner.orgId, 'member');
    const projectId = await fixture(creator);
    const otherProject = await fixture(creator);
    const { jobId, items } = await waitingJob(creator, projectId);
    const body = { jobId, selectedIds: [items[2]!.id, items[0]!.id], changes: [{ id: items[2]!.id, attr: '其他', contentMode: 'other' }] };
    const before = await jobRow(jobId);

    const forbidden = await call(bystander, 'POST', planUrl(projectId, '/outline-selection'), body);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('JOB_SELECTION_FORBIDDEN');
    expect((await call(creator, 'POST', planUrl(otherProject, '/outline-selection'), body)).statusCode).toBe(404);
    const stranger = await newOrg();
    expect((await call(stranger, 'POST', planUrl(projectId, '/outline-selection'), body)).statusCode).toBe(404);
    for (const bad of [
      { ...body, selectedIds: [randomUUID()] },
      { ...body, selectedIds: [items[0]!.id, items[0]!.id] },
      { ...body, changes: [{ id: randomUUID(), attr: '技术' }] },
      { ...body, selectedIds: [] },
      { ...body, changes: [{ id: items[0]!.id, attr: '其它' }] },
      { ...body, extra: 1 },
    ]) {
      const response = await call(creator, 'POST', planUrl(projectId, '/outline-selection'), bad);
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const after = await jobRow(jobId);
    expect(after.checkpoint).toEqual(before.checkpoint);
    expect(after.status).toBe('paused');

    const confirmed = await call(creator, 'POST', planUrl(projectId, '/outline-selection'), body);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().job).toMatchObject({ id: jobId, status: 'queued', pauseReason: null });
    const row = await jobRow(jobId);
    expect(row.checkpoint.agent).toEqual(before.checkpoint.agent);
    expect(row.checkpoint.task.signature).toBe(before.checkpoint.task.signature);
    expect(row.checkpoint.task.confirmed.selectedIds).toEqual([items[0]!.id, items[2]!.id]);
    expect(row.checkpoint.task.confirmed.items[2]).toMatchObject({ id: items[2]!.id, attr: '其他', content_mode: 'other' });
    const event = await superuser.selectFrom('job_events').select(['kind', 'message', 'data']).where('job_id', '=', jobId).orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(event).toEqual({ kind: 'resumed', message: '已确认，任务继续', data: { userId: creator.userId } });
    const again = await call(owner, 'POST', planUrl(projectId, '/outline-selection'), body);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('JOB_SELECTION_NOT_PENDING');
    const state = (await call(creator, 'GET', planUrl(projectId))).json();
    expect(state.outlineSelection).toMatchObject({ confirmed: true, selected_ids: [items[0]!.id, items[2]!.id] });
  });

  it('组织管理员可以确认；余额低于最低启动余额时 402、不改，充值后可以确认', async () => {
    const owner = await newOrg();
    const creator = await addMember(owner.orgId, 'member');
    const admin = await addMember(owner.orgId, 'admin');
    const projectId = await fixture(creator);
    const { jobId, items } = await waitingJob(creator, projectId);
    const body = { jobId, selectedIds: [items[0]!.id] };
    await superuser.updateTable('org_balances').set({ balance: 0n }).where('org_id', '=', owner.orgId).execute();
    const poor = await call(admin, 'POST', planUrl(projectId, '/outline-selection'), body);
    expect(poor.statusCode).toBe(402);
    expect(await jobRow(jobId)).toMatchObject({ status: 'paused', pause_reason: 'waiting_for_selection' });
    expect((await jobRow(jobId)).checkpoint.task.confirmed).toBeUndefined();
    await creditOrganization(appDb, ctxAdmin, { orgId: owner.orgId, type: 'recharge', amount: 100_000n, reference: null, note: '测试充值' });
    expect((await call(admin, 'POST', planUrl(projectId, '/outline-selection'), body)).statusCode).toBe(200);
  });

  it('执行中已请求暂停时按手动暂停收尾（不是 waiting_for_selection），继续后再次等待确认；等待中取消即结束', async () => {
    const owner = await newOrg();
    const projectId = await fixture(owner);
    const started = await call(owner, 'POST', planUrl(projectId, '/outline-generation'));
    const jobId = started.json().job.id as string;
    const run = await claim(owner, jobId);
    await requestPause(appDb, owner.context, jobId);
    expect(await finishRun(appDb, run, { kind: 'waiting-for-selection' }, true)).toBe('paused');
    expect((await jobRow(jobId)).pause_reason).toBeNull();
    expect((await requestResume(appDb, owner.context, jobId)).job.status).toBe('queued');
    const { status } = await execute(owner, projectId, jobId);
    expect(status).toBe('paused');
    expect((await jobRow(jobId)).pause_reason).toBe('waiting_for_selection');
    // 确认前再被继续（例如管理员误操作，这里直接改回 queued）：任务不重新生成、再次等待。
    await superuser.updateTable('jobs').set({ status: 'queued', pause_reason: null }).where('id', '=', jobId).execute();
    const again = await execute(owner, projectId, jobId);
    expect(again.status).toBe('paused');
    expect(again.record.opened).toBe(0);
    expect((await call(owner, 'POST', `/api/jobs/${jobId}/cancel`)).statusCode).toBe(200);
    expect((await jobRow(jobId)).status).toBe('cancelled');
  });
});

describe('确认后续跑', () => {
  it('写入所选一级目录、清空全局事实与正文、写入字数控制；丢弃全局事实的会话、保留目录的会话；任务成功', async () => {
    const owner = await newOrg();
    const projectId = await fixture(owner);
    await saveGlobalFacts(appDb, owner.context, projectId, [{ id: 'g1', title: '工期', content: '180 天' }]);
    for (const taskKind of ['technical-plan-global-facts', 'technical-plan-outline-generation']) {
      await writeWorkspaceSnapshot(appDb, owner.context, memoryStore, { projectId, taskKind, fileCount: 1 }, Readable.from([Buffer.from('tar')]));
    }
    const { jobId, items } = await waitingJob(owner, projectId);
    const confirmed = await call(owner, 'POST', planUrl(projectId, '/outline-selection'), {
      jobId,
      selectedIds: [items[0]!.id, items[2]!.id],
      changes: [{ id: items[2]!.id, contentMode: 'other' }],
    });
    expect(confirmed.statusCode).toBe(200);
    const { status, record, error } = await execute(owner, projectId, jobId);
    expect(error).toBeNull();
    expect(status).toBe('succeeded');
    expect(record.opened).toBe(0);
    const state = await loadTechnicalPlan(appDb, owner.context, projectId);
    expect(state.outlineData).toEqual({
      project_overview: '某市智慧水务平台',
      outline: [
        { id: items[0]!.id, number: '1', title: '投标文件目录', description: '目录', content_mode: 'directory-generate' },
        { id: items[2]!.id, number: '2', title: '投标报价', description: '报价表', content_mode: 'other' },
      ],
    });
    expect(state.globalFacts).toEqual([]);
    expect(state.outlineWordControlSnapshot).toEqual({ minimumWords: 30000, maximumWords: 50000, sectionWords: 3000 });
    expect(await findWorkspaceSnapshot(appDb, owner.context, { projectId, taskKind: 'technical-plan-global-facts' })).toBeNull();
    expect(await findWorkspaceSnapshot(appDb, owner.context, { projectId, taskKind: 'technical-plan-outline-generation' })).not.toBeNull();
    expect(state.outlineGenerationTask).toMatchObject({ id: jobId, status: 'succeeded' });
    expect(state.outlineSelection).toMatchObject({ confirmed: true });
  });

  it('无技术评分项模式（8.7e2a）：子目录生成、叶子调整（起点之前的回答与终止确认不算）、目录审查后写入目录与字数控制，任务成功', async () => {
    const owner = await newOrg();
    const projectId = await fixture(owner, { techRequirements: NO_TECH_SCORE });
    await saveGlobalFacts(appDb, owner.context, projectId, [{ id: 'g1', title: '工期', content: '180 天' }]);
    const { jobId, items } = await waitingJob(owner, projectId, { noTechnicalScoreMode: true });
    expect((await call(owner, 'POST', planUrl(projectId, '/outline-selection'), { jobId, selectedIds: items.map((item) => item.id) })).statusCode).toBe(200);
    const expand = (current: any) => ({
      outline: current.outline.map((root: any) =>
        root.title === '技术方案'
          ? { id: root.id, title: root.title, description: root.description, attr: root.attr, children: [0, 1].map((index) => ({ id: null, title: `方案${index}`, description: '说明', content_mode: 'ai-generate' })) }
          : root,
      ),
    });
    const keep = (current: any) => current;
    const steps: StagedStep[] = [
      // 子目录生成中（叶子调整开始之前）用户回答过“接受当前结果”：不算。
      { outline: expand, onStage: (member, run) => consumedQuestion(member, run, LEAF_OPTIONS, 0) },
      // 第一次叶子调整没有回答：再次叶子调整。
      { outline: keep },
      // 第二次：回答“接受当前结果”，之后的终止确认（选择继续）不算。
      {
        outline: keep,
        onStage: async (member, run) => {
          await consumedQuestion(member, run, LEAF_OPTIONS, 0);
          await consumedQuestion(member, run, [...TERMINATION_OPTIONS], 0);
        },
      },
      { outline: keep, review: { status: 'passed', issues: [], user_feedback: '', summary: '通过' } },
    ];
    const { status, record, error } = await execute(owner, projectId, jobId, INITIAL, steps);
    expect(error).toBeNull();
    expect(status).toBe('succeeded');
    expect((record as { stages?: string[] }).stages).toEqual(['children-generation', 'leaf-adjustment', 'leaf-adjustment', 'outline-review']);
    const state = await loadTechnicalPlan(appDb, owner.context, projectId);
    expect(state.outlineData!.outline.map((item) => [item.number, item.title, item.children?.map((child) => child.title) ?? null])).toEqual([
      ['1', '投标文件目录', null],
      ['2', '技术方案', ['方案0', '方案1']],
      ['3', '投标报价', null],
    ]);
    expect(state.outlineData!.outline[1]!.id).toBe(items[1]!.id);
    expect(state.globalFacts).toEqual([]);
    expect(state.outlineWordControlSnapshot).toEqual({ minimumWords: 30000, maximumWords: 50000, sectionWords: 3000 });
    expect(state.outlineSelection).toMatchObject({ confirmed: true });
    const checkpoint = (await jobRow(jobId)).checkpoint.task;
    expect(checkpoint.directory).toMatchObject({ stage: 'outline-review', prompted: true, leafWarning: 'AI 生成小节目标为 14，用户已接受当前 2 个。' });
  });

  it('评分模式（8.7e2b）：评分规划、子目录生成、叶子调整（接受当前结果）、目录审查后写入目录；评分规划写进 checkpoint，任务成功', async () => {
    const owner = await newOrg();
    const projectId = await fixture(owner);
    const { jobId, items } = await waitingJob(owner, projectId);
    expect((await call(owner, 'POST', planUrl(projectId, '/outline-selection'), { jobId, selectedIds: items.map((item) => item.id) })).statusCode).toBe(200);
    const technicalId = items[1]!.id;
    const expand = (current: any) => ({
      outline: current.outline.map((root: any) =>
        root.id === technicalId
          ? { id: root.id, title: root.title, description: root.description, attr: root.attr, children: ['总体设计', '实施计划'].map((title) => ({ id: null, title, description: '说明', content_mode: 'ai-generate' })) }
          : root,
      ),
    });
    const keep = (current: any) => current;
    const steps: StagedStep[] = [
      {
        outline: keep,
        files: () => ({
          'technical-score-groups.json': { groups: [{ requirement_id: 'R1', title: '总体设计', description: '设计', detail_points: ['架构'] }] },
          'score-directory-plan.json': {
            allow_root_changes: false,
            branches: [{ root_id: technicalId, root_title: '技术方案', score_item_level: 2, mappings: [{ requirement_id: 'R1', target_title: '总体设计' }] }],
            extra_titles: [],
          },
        }),
      },
      { outline: expand },
      { outline: keep, onStage: (member, run) => consumedQuestion(member, run, LEAF_OPTIONS, 0) },
      { outline: keep, review: { status: 'passed', issues: [], user_feedback: '', summary: '通过' } },
    ];
    const { status, record, error } = await execute(owner, projectId, jobId, INITIAL, steps);
    expect(error).toBeNull();
    expect(status).toBe('succeeded');
    expect((record as { stages?: string[] }).stages).toEqual(['score-planning', 'children-generation', 'leaf-adjustment', 'outline-review']);
    const state = await loadTechnicalPlan(appDb, owner.context, projectId);
    expect(state.outlineData!.outline.map((item) => [item.number, item.title, item.children?.map((child) => child.title) ?? null])).toEqual([
      ['1', '投标文件目录', null],
      ['2', '技术方案', ['总体设计', '实施计划']],
      ['3', '投标报价', null],
    ]);
    expect(state.outlineData!.outline[1]!.id).toBe(technicalId);
    const checkpoint = (await jobRow(jobId)).checkpoint.task;
    expect(checkpoint.directory).toMatchObject({
      stage: 'outline-review',
      prompted: true,
      leafWarning: 'AI 生成小节目标为 14，用户已接受当前 2 个。',
      scoring: { targetLeafCount: 14, fixedAiLeafCount: 0, newRoots: [], allocations: [{ root_id: technicalId, leaf_count: 14 }] },
    });
    expect(checkpoint.directory.scoring.plan.branches[0]).toMatchObject({ root_id: technicalId, root_title: '技术方案' });
    const reviewContext = JSON.parse((record as { files: Map<string, string> }).files.get('outline-review-context.json')!);
    // 评分映射的机械检查：“实施计划”不在评分规划中（交给审查判断）。
    expect(reviewContext.score_mapping).toMatchObject({ valid: false, branches: [{ root_id: technicalId, actual_titles: ['总体设计', '实施计划'], missing_titles: [], unexpected_titles: ['实施计划'] }] });
  });

  it('等待确认期间输入变化：续跑时失败，不写入', async () => {
    const owner = await newOrg();
    const projectId = await fixture(owner);
    const { jobId, items } = await waitingJob(owner, projectId);
    await saveGenerationConfig(appDb, owner.context, projectId, { outlineWordControlOptions: { minimumWords: 1, maximumWords: 2, sectionWords: 3 } });
    expect((await call(owner, 'POST', planUrl(projectId, '/outline-selection'), { jobId, selectedIds: [items[0]!.id] })).statusCode).toBe(200);
    const { status } = await execute(owner, projectId, jobId);
    expect(status).toBe('failed');
    expect(await jobRow(jobId)).toMatchObject({ error_code: 'TECHNICAL_PLAN_INPUT_CHANGED' });
  });
});

describe('findLatestConsumedAgentAnswer / agentQuestionClock（8.7e2a）', () => {
  it('只取起点之后、已交给 Agent 的最近一个回答；排除选项与给出的相同的问题；其他任务与其他组织的不算', async () => {
    const owner = await newOrg();
    const other = await newOrg();
    const projectId = await fixture(owner);
    const otherProject = await fixture(other);
    const { jobId } = await waitingJob(owner, projectId);
    const { jobId: otherJob } = await waitingJob(other, otherProject);
    const run = { orgId: owner.orgId, jobId, runId: randomUUID() };
    await consumedQuestion(owner, run, LEAF_OPTIONS, 1, '2000-01-01T00:00:00Z');
    const since = await agentQuestionClock(appDb, owner.context);
    expect(Date.parse(since)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
    expect(await findLatestConsumedAgentAnswer(appDb, owner.context, jobId, since)).toBeNull();
    // 只有回答、尚未交给 Agent 的不算。
    await sql`INSERT INTO agent_questions (org_id, job_id, run_id, content_hash, question, options, status, answer_option, answered_by, answered_at)
      VALUES (${owner.orgId}, ${jobId}, ${run.runId}, ${randomBytes(32)}, '问题', ${JSON.stringify(LEAF_OPTIONS)}::jsonb, 'answered', 0, ${owner.userId}, now())`.execute(superuser);
    expect(await findLatestConsumedAgentAnswer(appDb, owner.context, jobId, since)).toBeNull();
    await superuser.deleteFrom('agent_questions').where('job_id', '=', jobId).where('status', '=', 'answered').execute();
    await consumedQuestion(owner, run, LEAF_OPTIONS, 2);
    await consumedQuestion(owner, run, [...TERMINATION_OPTIONS], 1);
    const exclude = { excludeOptionLabels: TERMINATION_OPTIONS.map((option) => option.label) };
    expect(await findLatestConsumedAgentAnswer(appDb, owner.context, jobId, since)).toMatchObject({ selected_option: '终止任务' });
    expect(await findLatestConsumedAgentAnswer(appDb, owner.context, jobId, since, exclude)).toEqual({ answered: true, answer: '', selected_option: '自定义需求', is_custom: true });
    // 其他任务、其他组织的回答不算（RLS 与 job_id）。
    await consumedQuestion(other, { orgId: other.orgId, jobId: otherJob, runId: randomUUID() }, LEAF_OPTIONS, 0);
    expect(await findLatestConsumedAgentAnswer(appDb, owner.context, otherJob, since)).toBeNull();
    expect(await findLatestConsumedAgentAnswer(appDb, other.context, otherJob, since)).toMatchObject({ selected_option: '接受当前结果' });
  });
});

describe('接口', () => {
  it('前置检查（文案与桌面版相同）：技术评分要求未解析成功 409，技术评分项缺失而未确认 409；确认后 202', async () => {
    const owner = await newOrg();
    const projectId = await newProject(owner);
    const missing = await call(owner, 'POST', planUrl(projectId, '/outline-generation'));
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toMatchObject({ code: 'TECHNICAL_PLAN_TECH_REQUIREMENTS_REQUIRED', message: '请先完成技术评分要求解析，再生成目录' });
    const noTech = await fixture(owner, { techRequirements: NO_TECH_SCORE });
    const unconfirmed = await call(owner, 'POST', planUrl(noTech, '/outline-generation'), {});
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json().error).toMatchObject({ code: 'TECHNICAL_PLAN_NO_TECHNICAL_SCORE_CONFIRM_REQUIRED', message: '请先确认是否以无技术评分项模式生成目录' });
    const started = await call(owner, 'POST', planUrl(noTech, '/outline-generation'), { noTechnicalScoreMode: true });
    expect(started.statusCode).toBe(202);
    const row = await jobRow(started.json().job.id);
    expect(row).toMatchObject({ type: 'outline-generation', status: 'queued', params: { noTechnicalScoreMode: true }, lock_key: `project:${noTech}:technical-plan` });
    expect(await superuser.selectFrom('agent_job_budgets').select('job_id').where('job_id', '=', row.id).executeTakeFirst()).toBeDefined();
    expect((await call(owner, 'POST', planUrl(noTech, '/outline-generation'), { outlineMode: 'response-file' })).statusCode).toBe(400);
    expect((await call(owner, 'POST', planUrl(noTech, '/outline-generation'))).statusCode).toBe(409);
  });

  it('清空技术方案时取消等待确认的目录生成', async () => {
    const owner = await newOrg();
    const projectId = await fixture(owner);
    const { jobId } = await waitingJob(owner, projectId);
    expect((await call(owner, 'DELETE', planUrl(projectId))).statusCode).toBe(200);
    expect((await jobRow(jobId)).status).toBe('cancelled');
  });
});

describe('回滚 0044', () => {
  it('pause_reason 只收登记的原因；回滚后等待确认的任务按手动暂停处理，再升级恢复约束', async () => {
    const owner = await newOrg();
    const projectId = await fixture(owner);
    const { jobId } = await waitingJob(owner, projectId);
    await expect(superuser.updateTable('jobs').set({ pause_reason: 'waiting_for_choice' }).where('id', '=', jobId).execute()).rejects.toThrow(/jobs_pause_reason_check/);
    const migrator = connect(testDb.ownerConfig);
    try {
      expect((await migrateDown(migrator)).results?.map((result) => result.migrationName)).toEqual(['0045_ai_image_generation']);
      expect((await migrateDown(migrator)).results?.map((result) => result.migrationName)).toEqual(['0044_job_pause_selection']);
      expect(await superuser.selectFrom('jobs').select(['status', 'pause_reason']).where('id', '=', jobId).executeTakeFirstOrThrow()).toEqual({ status: 'paused', pause_reason: null });
      await expect(superuser.updateTable('jobs').set({ pause_reason: 'waiting_for_selection' }).where('id', '=', jobId).execute()).rejects.toThrow(/jobs_pause_reason_check/);
    } finally {
      expect((await migrateToLatest(migrator)).error).toBeUndefined();
      await migrator.destroy();
    }
    await superuser.updateTable('jobs').set({ pause_reason: 'waiting_for_selection' }).where('id', '=', jobId).execute();
  });
});
