// 废标检查任务（路线图第 6 步 6.9，src/rejectionCheck/jobs.ts）的数据库与接口测试：
// - rejection-items-extraction：招标文件按导入顺序合并正文，经 saveExtraction 写入解析结果和招标签名；
// - rejection-check-run：三类检查并发执行，结果带开始时的签名写入，问题 id 统一编号；部分失败、余额不足、输入变化；
// - 写入带开始时的签名，任务开始后文档变化时写入被拒绝；
// - 接口：开始解析 / 检查的前置检查与互斥，文档变化时取消任务，状态中返回最近的任务、结果仍是 running 而任务已结束时按未完成显示；
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
import { JobBalanceExhaustedError, JobError, type JobChatRequest, type JobContext } from '../../src/jobs/definitions.ts';
import { createJobDispatcher } from '../../src/jobs/queue.ts';
import { jobTypeRegistry } from '../../src/jobs/registry.ts';
import { createJobRunner } from '../../src/jobs/runner.ts';
import { isExportable } from '../../src/rejectionCheck/export.ts';
import {
  createRejectionCheckJobs,
  REJECTION_CHECK_RUN_JOB_TYPE,
  REJECTION_ITEMS_EXTRACTION_JOB_TYPE,
  type RunOptions,
} from '../../src/rejectionCheck/jobs.ts';
import { importDocuments, loadRejectionCheck, saveDocumentParse, saveUiState } from '../../src/rejectionCheck/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
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
  const row = await superuser.insertInto('projects').values({ org_id: member.orgId, kind: 'rejection-check', name: '废标检查', created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
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

/** 写入解析结果（与 document-parse 任务相同：Markdown 产物 + saveDocumentParse）。 */
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
  });
  expect(saved).toBe(true);
}

/** 导入文档（经 Store，不入队解析），parse 给出时写入解析结果。 */
async function addDocuments(member: Member, projectId: string, role: 'tender' | 'bid', documents: { name: string; markdown?: string }[]): Promise<string[]> {
  const ids: string[] = [];
  for (const document of documents) ids.push(await newFile(member, document.name));
  await importDocuments(appDb, member.context, projectId, { role, fileIds: ids });
  for (const [index, document] of documents.entries()) {
    if (document.markdown !== undefined) await markParsed(member, projectId, ids[index]!, document.markdown);
  }
  return ids;
}

const TENDER_A = '# 第一章 招标公告\n投标函未盖章的，投标无效。';
const TENDER_B = '# 第二章 评标办法\n报价超过最高限价的，否决投标。';
const BID_A = '# 商务部分\n投标函（已签署）\n请填写帐号信息。\n工期为 90 天。';
const BID_B = '# 技术部分\n工期为 120 天。';

interface Fixture {
  projectId: string;
  tenders: string[];
  bids: string[];
}

async function fixture(member: Member, options: { bids?: boolean; parsedTenders?: boolean } = {}): Promise<Fixture> {
  const projectId = await newProject(member);
  const parsed = options.parsedTenders !== false;
  const tenders = await addDocuments(member, projectId, 'tender', [
    { name: '招标文件-第一册.docx', ...(parsed ? { markdown: TENDER_A } : {}) },
    { name: '招标文件-第二册.docx', ...(parsed ? { markdown: TENDER_B } : {}) },
  ]);
  const bids =
    options.bids === false
      ? []
      : await addDocuments(member, projectId, 'bid', [
          { name: '投标文件A.docx', markdown: BID_A },
          { name: '投标文件B.docx', markdown: BID_B },
        ]);
  return { projectId, tenders, bids };
}

// ---- 模型桩 ----

const EXTRACTION = "'''\n# 招标文件中明确提到的\n\n## 无效投标\n- 投标函未盖章\n'''";

type Responder = (request: JobChatRequest) => string | Promise<string>;

/** 默认输出：按步骤键返回合法的结果；bids 为投标文件 id（[A, B]）。 */
function defaultResponder(bids: string[]): Responder {
  return (request) => {
    const key = request.stepKey;
    if (key.startsWith('extraction')) return EXTRACTION;
    if (key === 'warmup') return '';
    if (key === 'rejection:analysis') return '重点核查投标函与报价。';
    if (key === 'rejection:inspection') return '- 投标文件B 未见投标函';
    if (key === 'rejection:final') {
      return JSON.stringify({
        findings: [
          { id: 'model-id', bidDocumentId: bids[1], type: 'invalidBid', severity: 'high', title: '未见投标函', bidEvidence: '目录中没有投标函', riskReason: '投标函未提交按无效投标处理' },
          { bidDocumentId: 'not-a-bid', title: '无效的文件', bidEvidence: 'x', riskReason: 'y' },
        ],
      });
    }
    if (key === 'typo') return JSON.stringify({ findings: [{ bidDocumentId: bids[0], wrongText: '帐号', correctText: '账号', originalExcerpt: '请填写帐号信息' }] });
    if (key === 'logic') return JSON.stringify({ findings: [{ bidDocumentId: bids[1], title: '工期前后不一致', originalText: '120 天', fallacyReason: '与 90 天不一致' }] });
    throw new Error(`unexpected step ${key}`);
  };
}

function chatResult(content: string): ChatResult {
  return {
    requestId: randomUUID(),
    content,
    reasoningContent: '',
    finishReason: 'stop',
    aborted: false,
    reused: false,
    usage: { inputTokens: 1, outputTokens: 1 } as unknown as ChatResult['usage'],
    billing: { status: 'billed', amount: 1n },
  };
}

const jobs = createRejectionCheckJobs({ warmupSettleMs: 0 });
const extractionJob = jobs.find((job) => job.type === REJECTION_ITEMS_EXTRACTION_JOB_TYPE)!;
const checkJob = jobs.find((job) => job.type === REJECTION_CHECK_RUN_JOB_TYPE)!;

interface RunResult {
  error: unknown;
  logs: string[];
  requests: JobChatRequest[];
}

/** 以给定的上下文直接执行任务类型的 run（不经队列）。 */
async function runJob(type: 'extraction' | 'check', member: Member, projectId: string, respond: Responder, params?: RunOptions): Promise<RunResult> {
  const definition = type === 'extraction' ? extractionJob : checkJob;
  const logs: string[] = [];
  const requests: JobChatRequest[] = [];
  const controller = new AbortController();
  const context: JobContext<any> = {
    jobId: randomUUID(),
    projectId,
    type: definition.type,
    attempt: 1,
    params: definition.parseParams(type === 'extraction' ? {} : (params ?? { rejectionCheck: true, typoCheck: true, logicCheck: true })),
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
  };
  try {
    await definition.run(context);
    return { error: null, logs, requests };
  } catch (error) {
    return { error, logs, requests };
  }
}

async function resultRows(projectId: string) {
  const rows = await superuser.selectFrom('rejection_check_results').select(['result_type', 'status', 'error']).where('project_id', '=', projectId).orderBy('result_type').execute();
  return Object.fromEntries(rows.map((row: { result_type: string; status: string; error: string | null }) => [row.result_type, { status: row.status, error: row.error }]));
}

function call(member: Member, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** 先完成废标项解析（直接执行任务）。 */
async function extract(member: Member, projectId: string, bids: string[]): Promise<void> {
  const result = await runJob('extraction', member, projectId, defaultResponder(bids));
  expect(result.error).toBeNull();
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
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'rejection-jobs-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
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

describe('废标项解析任务', () => {
  it('招标文件按导入顺序合并正文；结果去掉外层引号写入，带招标签名，之后废标项检查的输入签名可用', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const before = await loadRejectionCheck(appDb, member.context, projectId);
    expect(before.signatures.rejectionInput).toBe('');
    const result = await runJob('extraction', member, projectId, () => EXTRACTION);
    expect(result.error).toBeNull();
    expect(result.requests.map((request) => request.stepKey)).toEqual(['extraction']);
    expect(result.requests[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(result.requests[0]!.messages[1]!.content).toContain(`${TENDER_A}\n\n${TENDER_B}`);
    const state = await loadRejectionCheck(appDb, member.context, projectId);
    expect(state.invalidBidAndRejectionItems).toMatchObject({
      status: 'success',
      content: '# 招标文件中明确提到的\n\n## 无效投标\n- 投标函未盖章',
      source: 'ai',
      tenderSignature: before.signatures.tender,
      error: null,
    });
    expect(state.signatures.rejectionInput).not.toBe('');
    // 日志不含文档正文和模型输出。
    expect(result.logs).toEqual(['开始解析无效与废标项。', '无效与废标项解析完成。']);
  });

  it('只返回“未提取到”时完整重跑一次；招标正文超过上下文长度时分段解析后合并', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const missing = await runJob('extraction', member, projectId, (request) => (request.stepKey === 'extraction' ? '未提取到' : EXTRACTION));
    expect(missing.requests.map((request) => request.stepKey)).toEqual(['extraction', 'extraction:try-2']);
    expect((await loadRejectionCheck(appDb, member.context, projectId)).invalidBidAndRejectionItems.status).toBe('success');

    const [segmented] = createRejectionCheckJobs({ contextLengthLimit: 40 });
    const keys: string[] = [];
    const controller = new AbortController();
    await segmented!.run({
      jobId: randomUUID(),
      projectId,
      type: segmented!.type,
      attempt: 1,
      params: {},
      checkpoint: null,
      tenant: member.context,
      db: appDb,
      signal: controller.signal,
      setProgress: async () => {},
      saveCheckpoint: async () => {},
      log: async () => {},
      ai: {
        async chat(request) {
          keys.push(request.stepKey);
          return chatResult(EXTRACTION);
        },
      },
      objectStore: memoryStore,
      sandbox: null,
    });
    expect(keys.filter((key) => key.startsWith('extraction:segment:')).length).toBeGreaterThan(1);
    expect(keys.at(-1)).toBe('extraction:merge');
  });

  it('招标文件未解析完、解析失败、没有招标文件时不开始；未选择模型、输出为空时写入失败原因', async () => {
    const member = await newMember();
    const pending = await fixture(member, { parsedTenders: false });
    const notReady = await runJob('extraction', member, pending.projectId, () => EXTRACTION);
    expect(notReady.error).toMatchObject({ code: 'REJECTION_CHECK_DOCUMENT_NOT_READY', message: '招标文件尚未全部解析完成，请稍后再试' });
    expect(notReady.requests).toHaveLength(0);
    expect((await loadRejectionCheck(appDb, member.context, pending.projectId)).invalidBidAndRejectionItems.status).toBe('idle');
    await saveDocumentParse(appDb, member.context, pending.projectId, pending.tenders[0]!, { status: 'error', error: '解析失败' });
    expect((await runJob('extraction', member, pending.projectId, () => EXTRACTION)).error).toMatchObject({ code: 'REJECTION_CHECK_DOCUMENT_FAILED' });
    const empty = await newProject(member);
    expect((await runJob('extraction', member, empty, () => EXTRACTION)).error).toMatchObject({ code: 'REJECTION_CHECK_TENDER_MISSING' });

    const noModel = await newMember({ model: false });
    const noModelFixture = await fixture(noModel);
    const unconfigured = await runJob('extraction', noModel, noModelFixture.projectId, () => EXTRACTION);
    expect(unconfigured.error).toBeInstanceOf(JobError);
    expect(unconfigured.error).toMatchObject({ code: 'AI_MODEL_NOT_CONFIGURED' });
    expect((await loadRejectionCheck(appDb, noModel.context, noModelFixture.projectId)).invalidBidAndRejectionItems).toMatchObject({
      status: 'error',
      content: '',
      error: '尚未选择文本模型，请先在设置中选择模型',
    });

    const blank = await fixture(member);
    const blankRun = await runJob('extraction', member, blank.projectId, () => '  ');
    expect(blankRun.error).toMatchObject({ code: 'REJECTION_CHECK_EXTRACTION_EMPTY', message: '模型未返回解析内容' });
    expect((await loadRejectionCheck(appDb, member.context, blank.projectId)).invalidBidAndRejectionItems).toMatchObject({ status: 'error', error: '模型未返回解析内容' });
  });

  it('余额不足：不改写结果（仍是 running），交给执行者暂停；解析中导入了新的招标文件：结果被拒绝写入，不覆盖新的状态', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const exhausted = await runJob('extraction', member, projectId, () => {
      throw new JobBalanceExhaustedError();
    });
    expect(exhausted.error).toBeInstanceOf(JobBalanceExhaustedError);
    expect(await superuser.selectFrom('rejection_check_extraction').select('status').where('project_id', '=', projectId).executeTakeFirst()).toEqual({ status: 'running' });

    const changed = await runJob('extraction', member, projectId, async () => {
      await addDocuments(member, projectId, 'tender', [{ name: '补充文件.docx', markdown: '# 补遗' }]);
      return EXTRACTION;
    });
    expect(changed.error).toBeNull();
    expect(changed.logs.at(-1)).toBe('招标文件已变化，本次解析结果已丢弃');
    // 导入招标文件清空了解析结果，旧任务的结果没有写回。
    expect((await loadRejectionCheck(appDb, member.context, projectId)).invalidBidAndRejectionItems.status).toBe('idle');
  });
});

describe('检查任务', () => {
  it('三类检查：结果带开始时的签名写入（导出可用），问题 id 统一编号、当前问题为第一条；不合规的问题丢弃；先预热共用的投标文件原文', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member);
    await extract(member, projectId, bids);
    const result = await runJob('check', member, projectId, defaultResponder(bids));
    expect(result.error).toBeNull();
    expect(result.requests[0]).toMatchObject({ stepKey: 'warmup', maxOutputTokens: 1 });
    expect(result.requests[0]!.messages).toHaveLength(1);
    expect(result.requests.map((request) => request.stepKey).sort()).toEqual(['logic', 'rejection:analysis', 'rejection:final', 'rejection:inspection', 'typo', 'warmup']);
    // 投标文件以文件 id 作为 bidDocumentId。
    expect(result.requests[0]!.messages[0]!.content).toContain(`bidDocumentId：${bids[0]}｜文件名：投标文件A.docx`);

    const state = await loadRejectionCheck(appDb, member.context, projectId);
    expect(state.rejectionCheckResult).toMatchObject({
      status: 'success',
      inputSignature: state.signatures.rejectionInput,
      activeFindingId: 'rejection-finding-1',
      progressMessage: '废标项检查发现 1 项',
      error: null,
    });
    expect(state.rejectionCheckResult.findings).toEqual([
      expect.objectContaining({ id: 'rejection-finding-1', bidDocumentId: bids[1], type: 'invalidBid', severity: 'high', title: '未见投标函' }),
    ]);
    expect(state.typoCheckResult).toMatchObject({ status: 'success', inputSignature: state.signatures.bid, activeFindingId: 'typo-finding-1' });
    expect(state.typoCheckResult.findings).toEqual([
      { id: 'typo-finding-1', bidDocumentId: bids[0], wrongText: '帐号', correctText: '账号', originalExcerpt: '已签署）\n请填写帐号信息。\n工期为', reason: '疑似错别字，请结合原文复核。', locationHint: '原文第 3 行附近' },
    ]);
    expect(state.logicCheckResult).toMatchObject({ status: 'success', inputSignature: state.signatures.bid, progressMessage: '逻辑谬误检查发现 1 项' });
    expect(isExportable(state)).toBe(true);
    expect(result.logs).toEqual(expect.arrayContaining(['开始检查投标文件。', '废标项检查完成。', '错别字检查完成。', '逻辑谬误检查完成。', '检查完成。']));
  });

  it('部分失败：其余检查照常写入，失败的写给用户看的原因，任务以汇总原因失败', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member);
    await extract(member, projectId, bids);
    const base = defaultResponder(bids);
    const result = await runJob('check', member, projectId, (request) => (request.stepKey.startsWith('typo') ? '不是 JSON' : base(request)));
    expect(result.error).toMatchObject({ code: 'REJECTION_CHECK_FAILED', message: '1 个检查任务失败' });
    expect(result.requests.filter((request) => request.stepKey.startsWith('typo')).map((request) => request.stepKey)).toEqual([
      'typo',
      'typo:repair-1',
      'typo:try-2',
      'typo:repair-2',
      'typo:try-3',
      'typo:repair-3',
    ]);
    const state = await loadRejectionCheck(appDb, member.context, projectId);
    expect(state.typoCheckResult).toMatchObject({ status: 'error', error: '错别字检查结果格式无效，请重新检查', findings: [] });
    expect(state.rejectionCheckResult.status).toBe('success');
    expect(state.logicCheckResult.status).toBe('success');
  });

  it('只运行开启的检查：不需要解析结果，不预热，其他检查的结果不动', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member);
    const result = await runJob('check', member, projectId, defaultResponder(bids), { rejectionCheck: false, typoCheck: true, logicCheck: false });
    expect(result.error).toBeNull();
    expect(result.requests.map((request) => request.stepKey)).toEqual(['typo']);
    const state = await loadRejectionCheck(appDb, member.context, projectId);
    expect(state.typoCheckResult.status).toBe('success');
    expect(state.rejectionCheckResult.status).toBe('idle');
    expect(state.logicCheckResult.status).toBe('idle');
  });

  it('前置检查：没有投标文件、投标文件未解析完、开启废标项检查但没有可用的解析结果时不开始', async () => {
    const member = await newMember();
    const noBids = await fixture(member, { bids: false });
    expect((await runJob('check', member, noBids.projectId, () => '')).error).toMatchObject({ code: 'REJECTION_CHECK_BID_MISSING' });
    const pendingBid = await fixture(member);
    await addDocuments(member, pendingBid.projectId, 'bid', [{ name: '未解析.docx' }]);
    expect((await runJob('check', member, pendingBid.projectId, () => '', { rejectionCheck: false, typoCheck: true, logicCheck: false })).error).toMatchObject({
      code: 'REJECTION_CHECK_DOCUMENT_NOT_READY',
      message: '投标文件尚未全部解析完成，请稍后再试',
    });
    const noExtraction = await fixture(member);
    const result = await runJob('check', member, noExtraction.projectId, () => '');
    expect(result.error).toMatchObject({ code: 'REJECTION_CHECK_EXTRACTION_REQUIRED', message: '请先完成无效与废标项解析' });
    expect(result.requests).toHaveLength(0);
  });

  it('检查中导入了新的投标文件：结果被拒绝写入（不覆盖新的状态），任务以“输入已变化”失败', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member);
    await extract(member, projectId, bids);
    const base = defaultResponder(bids);
    let imported = false;
    const result = await runJob('check', member, projectId, async (request) => {
      if (request.stepKey === 'warmup' && !imported) {
        imported = true;
        await addDocuments(member, projectId, 'bid', [{ name: '新的投标文件.docx', markdown: '# 新文件' }]);
      }
      return base(request);
    });
    expect(result.error).toMatchObject({ code: 'REJECTION_CHECK_INPUT_CHANGED' });
    // 导入投标文件清空了三类结果，旧任务没有写回。
    expect(await resultRows(projectId)).toEqual({});
  });

  it('余额不足：抛给执行者暂停，该检查的结果不改写（仍是 running）；任务已结束而结果仍是 running 时按未完成显示', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member);
    await extract(member, projectId, bids);
    const base = defaultResponder(bids);
    const result = await runJob('check', member, projectId, (request) => {
      if (request.stepKey === 'logic') throw new JobBalanceExhaustedError();
      return base(request);
    });
    expect(result.error).toBeInstanceOf(JobBalanceExhaustedError);
    expect(await resultRows(projectId)).toEqual({
      logic: { status: 'running', error: null },
      rejection: { status: 'success', error: null },
      typo: { status: 'success', error: null },
    });
    // 没有对应的任务记录（或任务已结束）：按未完成显示，与桌面版重启后的恢复相同。
    const state = await loadRejectionCheck(appDb, member.context, projectId);
    expect(state.logicCheckResult).toMatchObject({ status: 'error', error: '上次检查未完成，请重新检查', progressMessage: '上次检查未完成，请重新检查' });
  });
});

describe('接口', () => {
  it('开始解析：招标文件未解析完时 409；入队 rejection-items-extraction（项目互斥、参数为空），状态中返回任务；同一项目再开始任一任务 409 JOB_LOCKED', async () => {
    const member = await newMember();
    const pending = await fixture(member, { parsedTenders: false });
    const notReady = await call(member, 'POST', `/api/projects/${pending.projectId}/rejection-check/extraction`);
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toMatchObject({ error: { code: 'REJECTION_CHECK_DOCUMENT_NOT_READY' } });

    const { projectId } = await fixture(member);
    const started = await call(member, 'POST', `/api/projects/${projectId}/rejection-check/extraction`);
    expect(started.statusCode, started.body).toBe(202);
    const job = started.json().job;
    expect(job).toMatchObject({ type: REJECTION_ITEMS_EXTRACTION_JOB_TYPE, projectId, status: 'queued' });
    const row = await superuser.selectFrom('jobs').select(['lock_key', 'params']).where('id', '=', job.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ lock_key: `project:${projectId}:rejection-check`, params: {} });

    const state = await call(member, 'GET', `/api/projects/${projectId}/rejection-check`);
    expect(state.json()).toMatchObject({ extractionTask: { id: job.id, status: 'queued' }, checkTask: null });
    const again = await call(member, 'POST', `/api/projects/${projectId}/rejection-check/extraction`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'JOB_LOCKED' } });
    const check = await call(member, 'POST', `/api/projects/${projectId}/rejection-check/check`, { runOptions: { typoCheck: true } });
    expect(check.json()).toMatchObject({ error: { code: 'JOB_LOCKED' } });
  });

  it('开始检查：默认取已保存的检查选项，没有可用的解析结果时 409；给出 runOptions 时只运行开启的；余额不足 402；其他组织的项目 404', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member);
    const required = await call(member, 'POST', `/api/projects/${projectId}/rejection-check/check`, {});
    expect(required.statusCode).toBe(409);
    expect(required.json()).toMatchObject({ error: { code: 'REJECTION_CHECK_EXTRACTION_REQUIRED', message: '请先完成无效与废标项解析' } });
    expect((await call(member, 'POST', `/api/projects/${projectId}/rejection-check/check`, { runOptions: {} })).json()).toMatchObject({
      error: { code: 'REJECTION_CHECK_NOTHING_ENABLED' },
    });

    const typoOnly = await call(member, 'POST', `/api/projects/${projectId}/rejection-check/check`, { runOptions: { typoCheck: true } });
    expect(typoOnly.statusCode, typoOnly.body).toBe(202);
    const typoJob = await superuser.selectFrom('jobs').select('params').where('id', '=', typoOnly.json().job.id).executeTakeFirstOrThrow();
    expect(typoJob.params).toEqual({ rejectionCheck: false, typoCheck: true, logicCheck: false });
    await call(member, 'POST', `/api/jobs/${typoOnly.json().job.id}/cancel`, {});

    await extract(member, projectId, bids);
    await saveUiState(appDb, member.context, projectId, { checkOptions: { typoCheck: false, logicCheck: true } });
    const saved = await call(member, 'POST', `/api/projects/${projectId}/rejection-check/check`);
    expect(saved.statusCode, saved.body).toBe(202);
    const savedJob = await superuser.selectFrom('jobs').select('params').where('id', '=', saved.json().job.id).executeTakeFirstOrThrow();
    expect(savedJob.params).toEqual({ rejectionCheck: true, typoCheck: false, logicCheck: true });

    const poor = await newMember({ balance: 0n });
    const poorFixture = await fixture(poor);
    const insufficient = await call(poor, 'POST', `/api/projects/${poorFixture.projectId}/rejection-check/check`, { runOptions: { typoCheck: true } });
    expect(insufficient.statusCode).toBe(402);
    expect((await call(poor, 'POST', `/api/projects/${projectId}/rejection-check/extraction`)).statusCode).toBe(404);
  });

  it('文档变化时取消进行中的任务：投标文件变化只取消检查，招标文件变化与清空取消两类', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member);
    await extract(member, projectId, bids);
    const statusOf = async (jobId: string) => (await superuser.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status;

    const check = (await call(member, 'POST', `/api/projects/${projectId}/rejection-check/check`)).json().job;
    const bidFile = await newFile(member, '新增投标文件.docx');
    expect((await call(member, 'POST', `/api/projects/${projectId}/rejection-check/documents`, { role: 'bid', fileIds: [bidFile] })).statusCode).toBe(200);
    expect(await statusOf(check.id)).toBe('cancelled');

    const extraction = (await call(member, 'POST', `/api/projects/${projectId}/rejection-check/extraction`)).json().job;
    // 移除投标文件不取消解析。
    expect((await call(member, 'DELETE', `/api/projects/${projectId}/rejection-check/documents/${bidFile}`)).statusCode).toBe(200);
    expect(await statusOf(extraction.id)).toBe('queued');
    expect((await call(member, 'DELETE', `/api/projects/${projectId}/rejection-check/documents/${(await loadRejectionCheck(appDb, member.context, projectId)).tenderDocuments[0]!.id}`)).statusCode).toBe(200);
    expect(await statusOf(extraction.id)).toBe('cancelled');

    const other = await fixture(member);
    const otherJob = (await call(member, 'POST', `/api/projects/${other.projectId}/rejection-check/extraction`)).json().job;
    expect((await call(member, 'DELETE', `/api/projects/${other.projectId}/rejection-check`)).statusCode).toBe(200);
    expect(await statusOf(otherJob.id)).toBe('cancelled');
  });

  it('任务已结束而结果仍是 running 时按未完成显示；任务暂停中仍显示 running', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member);
    await extract(member, projectId, bids);
    const job = (await call(member, 'POST', `/api/projects/${projectId}/rejection-check/check`, { runOptions: { typoCheck: true } })).json().job;
    await superuser.insertInto('rejection_check_results').values({ org_id: member.orgId, project_id: projectId, result_type: 'typo', status: 'running', progress_message: '正在识别错别字候选。' }).execute();
    await superuser.updateTable('jobs').set({ status: 'paused' }).where('id', '=', job.id).execute();
    let state = (await call(member, 'GET', `/api/projects/${projectId}/rejection-check`)).json();
    expect(state.typoCheckResult).toMatchObject({ status: 'running', progressMessage: '正在识别错别字候选。' });
    expect(state.checkTask).toMatchObject({ id: job.id, status: 'paused' });
    await superuser.updateTable('jobs').set({ status: 'failed', error_code: 'JOB_INTERRUPTED', error_message: '任务中断', finished_at: new Date() }).where('id', '=', job.id).execute();
    state = (await call(member, 'GET', `/api/projects/${projectId}/rejection-check`)).json();
    expect(state.typoCheckResult).toMatchObject({ status: 'error', error: '上次检查未完成，请重新检查' });
    expect(state.checkTask).toMatchObject({ status: 'failed', error: { code: 'JOB_INTERRUPTED' } });
  });
});

describe('经 worker 执行', () => {
  it('接口入队 → worker 认领执行（经 AI 网关，任务调用带 job 来源与步骤键）→ 状态中返回结果与已完成的任务', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member);
    const respond = defaultResponder(bids);
    const gatewayRequests: ChatRequest[] = [];
    const gateway: AiGateway = {
      async chat(_context, request) {
        gatewayRequests.push(request);
        return chatResult(await respond(request as JobChatRequest));
      },
    };
    const prefix = uniquePrefix();
    const logs = testLogger();
    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'rejection-test-dispatch'), prefix });
    const runner = createJobRunner({
      db: appDb,
      registry: jobTypeRegistry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'rejection-test-worker'),
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
      }, 20_000, `job ${jobId} finished`);
    try {
      await runner.start();
      const extraction = (await call(member, 'POST', `/api/projects/${projectId}/rejection-check/extraction`)).json().job;
      expect(await finished(extraction.id)).toEqual({ status: 'succeeded', error_code: null });
      const check = (await call(member, 'POST', `/api/projects/${projectId}/rejection-check/check`)).json().job;
      expect(await finished(check.id)).toEqual({ status: 'succeeded', error_code: null });
      expect(gatewayRequests.every((request) => request.source === 'job' && typeof request.stepKey === 'string' && request.jobId)).toBe(true);
      expect(new Set(gatewayRequests.map((request) => request.jobType))).toEqual(new Set([REJECTION_ITEMS_EXTRACTION_JOB_TYPE, REJECTION_CHECK_RUN_JOB_TYPE]));
      const state = (await call(member, 'GET', `/api/projects/${projectId}/rejection-check`)).json();
      expect(state).toMatchObject({
        invalidBidAndRejectionItems: { status: 'success' },
        rejectionCheckResult: { status: 'success' },
        typoCheckResult: { status: 'success' },
        logicCheckResult: { status: 'success' },
        extractionTask: { id: extraction.id, status: 'succeeded', progress: 100 },
        checkTask: { id: check.id, status: 'succeeded' },
      });
      const events = await superuser.selectFrom('job_events').select(['kind', 'message']).where('job_id', '=', check.id).orderBy('id').execute();
      expect(events.map((event: { message: string | null }) => event.message)).toEqual(expect.arrayContaining(['开始检查投标文件。', '检查完成。']));
    } finally {
      await runner.close();
      await dispatcher.close();
    }
  });
});
