// 知识库文档准备任务（路线图第 6 步 6.13a，src/knowledgeBase/jobs.ts）的数据库与接口测试：
// - 与桌面版对照：同一解析结果、同一模型输出，服务端任务（真实数据库，沙箱与模型用桩）与桌面版 prepareDocument（开发者模式、
//   内存 Store，tests/knowledgeBase/desktop.ts）的全部模型请求逐字相同（单段与多段），写入的块、筛除块、候选条目、步骤结果相同；
// - 续跑：暂停后已成功的步骤续用（不再解析、不再首轮提取）；未选择模型时解析与切块照常保存，选择后重试续用；
// - 失败：解析超时、筛选后没有正文、没有条目、JSON 三次不合法时文档与步骤标为失败并写入原因；处理中文档被删除时任务停止；取消；
// - 接口：挂文档后逐个入队（带上最近的任务），余额不足时文档标为失败；单个文档；中断显示；重试（处理中 409、非失败 409、
//   余额不足 402）；删除文档、文件夹后取消任务；
// - 经 worker（真实 Valkey）从挂文档到候选条目提取完成的完整流程。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiGateway, ChatResult } from '../../src/ai/gateway.ts';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { JobError, type JobChatRequest, type JobContext } from '../../src/jobs/definitions.ts';
import { createJobDispatcher } from '../../src/jobs/queue.ts';
import { jobTypeRegistry } from '../../src/jobs/registry.ts';
import { createJobRunner } from '../../src/jobs/runner.ts';
import { readBlocks, readCandidateItems } from '../../src/knowledgeBase/content.ts';
import {
  createKnowledgePrepareJob,
  INTERRUPTED_MESSAGE,
  KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE,
  knowledgeDocumentLockKey,
  type KnowledgeJobOptions,
} from '../../src/knowledgeBase/jobs.ts';
import { getDocument, listDocumentSteps } from '../../src/knowledgeBase/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';
import type { SandboxDriver, SandboxExecResult } from '../../src/sandbox/driver.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { runDesktopPreparation } from '../knowledgeBase/desktop.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { redisConfig, testLogger, uniquePrefix, waitFor } from './jobFixtures.ts';

const PASSWORD = 'quiet-harbor-maple-81';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

// ---- 样例文档与模型桩 ----

const sentence = (n: number) => `第${n}项措施包括人员配置、机械设备进场、材料检验与工序衔接，确保质量与安全目标全面实现。`;
const paragraph = (n: number, count: number) => Array.from({ length: count }, (_, i) => sentence(n * 10 + i)).join('');

/** 样例文档：标题、段落、列表、表格、封面、目录、页码（与 tests/knowledgeBase/prepare.test.ts 的样例同类）。 */
const SAMPLE = [
  '投标文件',
  '项目名称：某市政道路改造工程\n招标编号：ZB-2024-001',
  '# 第一章 总体概述',
  paragraph(1, 4),
  '## 1.1 编制依据',
  '- 《城市道路工程设计规范》CJJ 37\n- 招标文件及答疑纪要',
  paragraph(2, 6),
  '| 序号 | 设备名称 | 数量 |\n| --- | --- | --- |\n| 1 | 挖掘机 | 4 |',
  '# 第二章 施工方案',
  paragraph(3, 8),
  '- 3 -',
  paragraph(4, 9),
  '## 2.1 质量保证',
  paragraph(5, 10),
].join('\n\n');

const segmentOf = (messages: readonly { content: string }[]) => {
  const match = /当前是第 (\d+)\/\d+ 段/.exec(messages[0]?.content ?? '');
  return match ? Number(match[1]) : 1;
};

type Respond = (messages: readonly { role: string; content: string }[]) => string;

/** 首轮提取每段两条（含一条跨段重复的标题），补充提取每段一条新的、一条与首轮重复的。 */
const defaultRespond: Respond = (messages) => {
  const task = messages.at(-1)?.content ?? '';
  const segment = segmentOf(messages);
  if (task.includes('知识库分析助手')) {
    return JSON.stringify({ items: [{ title: `主题${segment}`, summary: `第${segment}段的主题` }, { title: '公共 主题', summary: '各段都有' }] });
  }
  if (task.includes('知识库补漏助手')) {
    return JSON.stringify({ items: [{ title: `补充${segment}`, resume: `第${segment}段的补充` }, { title: `主题${segment}`, summary: '重复' }] });
  }
  throw new Error(`unexpected request: ${task.slice(0, 40)}`);
};

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

// ---- 沙箱桩：解析入口输出给定的 Markdown ----

type ExecBehavior = { kind: 'output'; markdown: string } | { kind: 'timeout' };

interface FakeSandbox extends SandboxDriver {
  calls: string[];
  behavior: ExecBehavior;
}

function fakeSandbox(behavior: ExecBehavior): FakeSandbox {
  const fake: FakeSandbox = {
    calls: [],
    behavior,
    async create(template, options) {
      fake.calls.push('create');
      return { id: randomUUID(), template, jobId: options.jobId, expiresAt: new Date(Date.now() + 60_000) };
    },
    async copyIn() {
      fake.calls.push('copyIn');
    },
    async exec(_sandbox, command, args): Promise<SandboxExecResult> {
      fake.calls.push(`exec:${command} ${args.join(' ')}`);
      const base = { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
      if (fake.behavior.kind === 'timeout') return { ...base, exitCode: null, timedOut: true };
      return { ...base, exitCode: 0, timedOut: false };
    },
    async copyOut(): Promise<SandboxFile[]> {
      fake.calls.push('copyOut');
      if (fake.behavior.kind !== 'output') throw new Error('copyOut without output');
      return [
        { path: 'content.md', data: Buffer.from(fake.behavior.markdown, 'utf8') },
        { path: 'manifest.json', data: Buffer.from(JSON.stringify({ version: 1, images: [] })) },
      ];
    },
    async destroy() {
      fake.calls.push('destroy');
    },
  };
  return fake;
}

// ---- 数据准备 ----

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

/** 新成员（个人组织 owner）；默认已选择平台模型、充值 10 元。 */
async function newMember(options: { balance?: bigint; model?: boolean } = {}): Promise<Member> {
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

async function newFile(member: Member, name = '投标技术方案.docx'): Promise<string> {
  const content = Buffer.from('PK original');
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      purpose: 'knowledge',
      display_name: name,
      extension: 'docx',
      status: 'uploaded',
      mime: DOCX_MIME,
      size_bytes: content.length,
      sha256: Buffer.alloc(32),
      uploaded_at: new Date(),
      created_by: member.userId,
    })
    .returning(['id', 'storage_key'])
    .executeTakeFirstOrThrow();
  objects.set(row.storage_key, content);
  return row.id;
}

async function newFolder(member: Member): Promise<string> {
  const row = await superuser
    .insertInto('knowledge_folders')
    .values({ org_id: member.orgId, name: '文件夹', created_by: member.userId, updated_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** 直接插入一个文档（不经接口，不入队）。 */
async function newDocument(member: Member, name?: string, folderId?: string): Promise<{ documentId: string; fileId: string }> {
  const fileId = await newFile(member, name);
  const row = await superuser
    .insertInto('knowledge_documents')
    .values({ org_id: member.orgId, folder_id: folderId ?? (await newFolder(member)), file_id: fileId, created_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { documentId: row.id, fileId };
}

interface RunResult {
  error: unknown;
  logs: string[];
  requests: JobChatRequest[];
  progress: number[];
}

interface RunOptions {
  respond?: Respond;
  sandbox?: FakeSandbox;
  options?: KnowledgeJobOptions;
  controller?: AbortController;
  /** 每次模型请求前调用并等待（测试用来在执行中触发中止、删除文档）。 */
  onRequest?: (request: JobChatRequest, controller: AbortController) => void | Promise<void>;
}

/** 以给定的上下文直接执行任务（不经队列）。 */
async function runPrepare(member: Member, documentId: string, run: RunOptions = {}): Promise<RunResult> {
  const definition = createKnowledgePrepareJob({ warmupSettleMs: 0, createRetryDelaysMs: [5], ...run.options });
  const respond = run.respond ?? defaultRespond;
  const controller = run.controller ?? new AbortController();
  const logs: string[] = [];
  const requests: JobChatRequest[] = [];
  const progress: number[] = [];
  const context: JobContext<any> = {
    jobId: randomUUID(),
    projectId: null,
    type: KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE,
    attempt: 1,
    params: definition.parseParams({ documentId }),
    checkpoint: null,
    tenant: member.context,
    db: appDb,
    signal: controller.signal,
    async setProgress(value) {
      progress.push(value);
    },
    async saveCheckpoint() {},
    async log(message) {
      logs.push(message);
    },
    ai: {
      async chat(request) {
        requests.push(request);
        await run.onRequest?.(request, controller);
        if (controller.signal.aborted) return { ...chatResult(''), aborted: true };
        return chatResult(request.maxOutputTokens === 1 ? '' : respond(request.messages as { role: string; content: string }[]));
      },
    },
    objectStore: memoryStore,
    sandbox: run.sandbox ?? fakeSandbox({ kind: 'output', markdown: SAMPLE }),
  };
  try {
    await definition.run(context);
    return { error: null, logs, requests, progress };
  } catch (error) {
    return { error, logs, requests, progress };
  }
}

function call(member: Member, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/knowledge-base${url}`,
    headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const stepStatuses = async (member: Member, documentId: string) =>
  Object.fromEntries((await listDocumentSteps(appDb, member.context, documentId)).map((step) => [step.stepKey, step.status]));

const asDesktopBlocks = (blocks: Awaited<ReturnType<typeof readBlocks>>) => blocks.map(({ headingPath, ...rest }) => ({ ...rest, heading_path: headingPath }));

const requestKey = (kind: string, messages: readonly { role: string; content: string }[]) =>
  JSON.stringify({ kind, messages: messages.map(({ role, content }) => ({ role, content })) });

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
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'knowledge-jobs-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
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

describe('与桌面版对照', () => {
  for (const contextLengthLimit of [400_000, 1_500]) {
    it(`上下文长度 ${contextLengthLimit}：模型请求逐字相同，块、候选条目与步骤结果相同`, async () => {
      const member = await newMember();
      const fileName = '某项目投标技术方案.docx';
      const { documentId, fileId } = await newDocument(member, fileName);
      const expected = await runDesktopPreparation({ fileName, markdown: SAMPLE, respond: defaultRespond, contextLengthLimit });
      expect(expected.document).toMatchObject({ status: 'ready_for_matching' });

      const result = await runPrepare(member, documentId, { options: { contextLengthLimit } });
      expect(result.error).toBeNull();
      const segments = expected.requests.filter((request) => request.kind === 'warmup').length;
      expect(segments).toBe(contextLengthLimit === 400_000 ? 1 : expected.requests.length / 3);
      if (contextLengthLimit < 400_000) expect(segments).toBeGreaterThan(2);
      // 并发的请求顺序不固定：按内容比较全部请求（预热、首轮、补充）。
      const actual = result.requests.map((request) => requestKey(request.maxOutputTokens === 1 ? 'warmup' : 'json', request.messages as { role: string; content: string }[]));
      expect(actual.sort()).toEqual(expected.requests.map((request) => requestKey(request.kind, request.messages)).sort());
      expect(new Set(result.requests.map((request) => request.stepKey)).size).toBe(result.requests.length);

      expect(asDesktopBlocks(await readBlocks(appDb, member.context, documentId))).toEqual(expected.blocks);
      expect(asDesktopBlocks(await readBlocks(appDb, member.context, documentId, { filtered: true }))).toEqual(expected.filteredBlocks);
      const candidates = await readCandidateItems(appDb, member.context, documentId);
      expect(candidates).toEqual(expected.candidateItems);
      expect(candidates.length).toBeGreaterThan(2);

      const steps = await listDocumentSteps(appDb, member.context, documentId);
      expect(steps.map((step) => [step.stepKey, step.status])).toEqual([
        ['copy_source', 'success'],
        ['convert_markdown', 'success'],
        ['build_blocks', 'success'],
        ['extract_first_items', 'success'],
        ['extract_supplement_items', 'success'],
        ['merge_candidates', 'success'],
      ]);
      for (const step of steps.slice(1)) expect(step.result).toEqual(expected.steps.get(step.stepKey)!.result);
      expect(steps[0]!.result).toEqual({ file_id: fileId });

      const document = await getDocument(appDb, member.context, documentId);
      expect(document).toMatchObject({
        status: 'ready_for_matching',
        progress: 65,
        message: expected.document.message,
        error: null,
        blockCount: expected.blocks.length,
        filteredBlockCount: expected.filteredBlocks.length,
        candidateItemCount: expected.candidateItems.length,
        itemCount: 0,
      });
      expect(document.markdownArtifactId).not.toBeNull();
      expect(result.progress.at(-1)).toBe(65);
      // 日志不含文件名与正文。
      expect(result.logs.some((line) => line.includes('某项目') || line.includes('措施'))).toBe(false);
    });
  }
});

describe('续跑与失败', () => {
  it('暂停后续跑：已成功的步骤续用，不再解析、不再首轮提取', async () => {
    const member = await newMember();
    const { documentId } = await newDocument(member);
    const sandbox = fakeSandbox({ kind: 'output', markdown: SAMPLE });
    const paused = await runPrepare(member, documentId, {
      sandbox,
      onRequest: (request, controller) => {
        if (request.stepKey === 'supplement-items') controller.abort('pause');
      },
    });
    expect(paused.error).toBeTruthy();
    expect(await stepStatuses(member, documentId)).toMatchObject({ convert_markdown: 'success', extract_first_items: 'success', extract_supplement_items: 'running' });
    // 暂停不改写文档：仍是提取中。
    expect((await getDocument(appDb, member.context, documentId)).status).toBe('extracting');
    expect(sandbox.calls.filter((entry) => entry === 'create')).toHaveLength(1);

    const resumed = await runPrepare(member, documentId, { sandbox });
    expect(resumed.error).toBeNull();
    expect(sandbox.calls.filter((entry) => entry === 'create')).toHaveLength(1);
    expect(resumed.requests.map((request) => request.stepKey)).toEqual(['warmup', 'supplement-items']);
    expect((await getDocument(appDb, member.context, documentId)).status).toBe('ready_for_matching');
    expect(await readCandidateItems(appDb, member.context, documentId)).toEqual([
      { id: 'K000001', title: '主题1', summary: '第1段的主题' },
      { id: 'K000002', title: '公共 主题', summary: '各段都有' },
      { id: 'K000003', title: '补充1', summary: '第1段的补充' },
    ]);
  });

  it('未选择模型：解析与切块照常保存，文档写入原因；选择模型后重试续用解析结果', async () => {
    const member = await newMember({ model: false });
    const { documentId } = await newDocument(member);
    const sandbox = fakeSandbox({ kind: 'output', markdown: SAMPLE });
    const failed = await runPrepare(member, documentId, { sandbox });
    expect(failed.error).toBeInstanceOf(JobError);
    expect((failed.error as JobError).code).toBe('AI_MODEL_NOT_CONFIGURED');
    expect(await getDocument(appDb, member.context, documentId)).toMatchObject({ status: 'error', progress: 100, error: '尚未选择文本模型，请先在设置中选择模型' });
    expect(await stepStatuses(member, documentId)).toEqual({ copy_source: 'success', convert_markdown: 'success', build_blocks: 'success' });

    await superuser.insertInto('org_settings').values({ org_id: member.orgId, platform_model_id: platformModelId, updated_by: member.userId }).execute();
    const retried = await runPrepare(member, documentId, { sandbox });
    expect(retried.error).toBeNull();
    expect(sandbox.calls.filter((entry) => entry === 'create')).toHaveLength(1);
    expect(await getDocument(appDb, member.context, documentId)).toMatchObject({ status: 'ready_for_matching', error: null });
  });

  it('重新解析：Markdown 产物对象丢失时重新解析，旧产物标为已被替换；重新解析失败时全部标为已被替换', async () => {
    const member = await newMember();
    const { documentId, fileId } = await newDocument(member);
    const sandbox = fakeSandbox({ kind: 'output', markdown: SAMPLE });
    expect((await runPrepare(member, documentId, { sandbox })).error).toBeNull();
    const first = (await getDocument(appDb, member.context, documentId)).markdownArtifactId!;
    // 切块失效（模拟重试时需要重新切块），且产物对象已不存在。
    await superuser.deleteFrom('knowledge_document_steps').where('document_id', '=', documentId).where('step_key', 'in', ['build_blocks', 'extract_first_items', 'extract_supplement_items', 'merge_candidates']).execute();
    await superuser.deleteFrom('knowledge_blocks').where('document_id', '=', documentId).execute();
    const artifact = await superuser.selectFrom('artifacts').select('storage_key').where('id', '=', first).executeTakeFirstOrThrow();
    objects.delete(artifact.storage_key);
    expect((await runPrepare(member, documentId, { sandbox })).error).toBeNull();
    expect(sandbox.calls.filter((entry) => entry === 'create')).toHaveLength(2);
    const second = (await getDocument(appDb, member.context, documentId)).markdownArtifactId!;
    expect(second).not.toBe(first);
    const artifacts = await superuser.selectFrom('artifacts').select(['id', 'superseded_at', 'project_id']).where('source_file_id', '=', fileId).execute();
    expect(artifacts.filter((row: { superseded_at: Date | null }) => row.superseded_at === null).map((row: { id: string }) => row.id)).toEqual([second]);
    expect(artifacts.every((row: { project_id: string | null }) => row.project_id === null)).toBe(true);

    // 重新解析失败：Markdown 引用已清除，之前的产物全部标为已被替换（由清理任务删除）。
    await superuser.updateTable('knowledge_document_steps').set({ status: 'error', error: '失败', completed_at: new Date() }).where('document_id', '=', documentId).where('step_key', '=', 'convert_markdown').execute();
    const failed = await runPrepare(member, documentId, { sandbox: fakeSandbox({ kind: 'timeout' }) });
    expect(failed.error).toMatchObject({ code: 'PARSE_TIMEOUT' });
    expect((await getDocument(appDb, member.context, documentId)).markdownArtifactId).toBeNull();
    expect(await superuser.selectFrom('artifacts').select('id').where('source_file_id', '=', fileId).where('superseded_at', 'is', null).execute()).toEqual([]);
  });

  const failures: Array<[string, RunOptions, string, string, string]> = [
    ['解析超时', { sandbox: fakeSandbox({ kind: 'timeout' }) }, 'PARSE_TIMEOUT', '文件解析超时（超过 10 分钟）', 'convert_markdown'],
    ['筛选后没有正文', { sandbox: fakeSandbox({ kind: 'output', markdown: '# 目录\n\n- 1 -\n\n短句' }) }, 'KNOWLEDGE_NO_CONTENT', '筛选后没有可分析的正文内容', 'build_blocks'],
    ['没有条目', { respond: () => JSON.stringify({ items: [] }) }, 'KNOWLEDGE_NO_ITEMS', 'AI 未提取出可用知识条目', 'merge_candidates'],
    ['JSON 三次不合法', { respond: () => 'not json' }, 'AI_INVALID_JSON', '知识库条目提取失败，AI 未返回有效 JSON', 'extract_first_items'],
  ];
  for (const [name, options, code, message, failedStep] of failures) {
    it(`失败：${name}时文档与步骤标为失败并写入原因`, async () => {
      const member = await newMember();
      const { documentId, fileId } = await newDocument(member);
      const result = await runPrepare(member, documentId, options);
      expect(result.error).toBeInstanceOf(JobError);
      expect(result.error).toMatchObject({ code, message });
      expect(await getDocument(appDb, member.context, documentId)).toMatchObject({ status: 'error', progress: 100, message, error: message });
      const steps = await listDocumentSteps(appDb, member.context, documentId);
      expect(steps.at(-1)).toMatchObject({ stepKey: failedStep, status: 'error', error: message });
      if (failedStep === 'convert_markdown') {
        expect((await getDocument(appDb, member.context, documentId)).markdownArtifactId).toBeNull();
        const live = await superuser.selectFrom('artifacts').select('id').where('source_file_id', '=', fileId).where('superseded_at', 'is', null).execute();
        expect(live).toEqual([]);
      }
    });
  }

  it('处理中文档被删除：任务停止、不报错；取消时文档标为“处理已取消”', async () => {
    const member = await newMember();
    const { documentId, fileId } = await newDocument(member);
    const result = await runPrepare(member, documentId, {
      onRequest: async (request) => {
        if (request.stepKey === 'first-items') await superuser.updateTable('files').set({ deleted_at: new Date(), deleted_by: member.userId }).where('id', '=', fileId).execute();
      },
    });
    expect(result.error).toBeNull();
    expect(result.logs.at(-1)).toBe('文档已删除，停止处理。');

    const other = await newDocument(member);
    const cancelled = await runPrepare(member, other.documentId, {
      onRequest: (request, controller) => {
        if (request.stepKey === 'first-items') controller.abort('cancel');
      },
    });
    expect(cancelled.error).toBeTruthy();
    expect(await getDocument(appDb, member.context, other.documentId)).toMatchObject({ status: 'error', message: '处理已取消' });
  });
});

describe('接口', () => {
  const jobsOf = async (orgId: string) =>
    superuser
      .selectFrom('jobs')
      .select(['id', 'type', 'project_id', 'lock_key', 'params', 'status'])
      .where('org_id', '=', orgId)
      .orderBy('created_at')
      .execute();

  it('挂文档后逐个入队，文档带上最近的任务；单个文档；处理中而任务已结束按中断显示', async () => {
    const member = await newMember();
    const folder = await newFolder(member);
    const files = [await newFile(member, '一.docx'), await newFile(member, '二.docx')];
    const response = await call(member, 'POST', `/folders/${folder}/documents`, { fileIds: files });
    expect(response.statusCode, response.body).toBe(201);
    const documents = response.json().documents as Array<{ id: string; status: string; job: { id: string; type: string; status: string } }>;
    expect(documents.map((document) => [document.status, document.job.type, document.job.status])).toEqual([
      ['pending', KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE, 'queued'],
      ['pending', KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE, 'queued'],
    ]);
    expect(await jobsOf(member.orgId)).toEqual(
      documents.map((document) => ({
        id: document.job.id,
        type: KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE,
        project_id: null,
        lock_key: knowledgeDocumentLockKey(document.id),
        params: { documentId: document.id },
        status: 'queued',
      })),
    );
    const listed = (await call(member, 'GET', '')).json().documents;
    expect(listed.map((document: { job: { id: string } }) => document.job.id).sort()).toEqual(documents.map((document) => document.job.id).sort());

    // 任务已结束、文档仍在处理中：按中断显示（不写库）。
    const [first] = documents;
    await superuser.updateTable('jobs').set({ status: 'cancelled', finished_at: new Date() }).where('id', '=', first!.job.id).execute();
    await superuser.updateTable('knowledge_documents').set({ status: 'extracting', progress: 40 }).where('id', '=', first!.id).execute();
    const single = (await call(member, 'GET', `/documents/${first!.id}`)).json().document;
    expect(single).toMatchObject({ status: 'error', message: INTERRUPTED_MESSAGE, error: INTERRUPTED_MESSAGE, progress: 40, job: { id: first!.job.id, status: 'cancelled' } });
    expect((await superuser.selectFrom('knowledge_documents').select('status').where('id', '=', first!.id).executeTakeFirstOrThrow()).status).toBe('extracting');
    const other = await newMember();
    expect((await call(other, 'GET', `/documents/${first!.id}`)).statusCode).toBe(404);
  });

  it('重试：处理中 409、非失败 409；失败的文档重新入队；余额不足 402 并标为失败', async () => {
    const member = await newMember();
    const folder = await newFolder(member);
    const created = (await call(member, 'POST', `/folders/${folder}/documents`, { fileIds: [await newFile(member)] })).json().documents[0];
    const retry = () => call(member, 'POST', `/documents/${created.id}/retry`);
    let response = await retry();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('KNOWLEDGE_DOCUMENT_BUSY');

    await superuser.updateTable('jobs').set({ status: 'succeeded', finished_at: new Date(), progress: 100 }).where('id', '=', created.job.id).execute();
    await superuser.updateTable('knowledge_documents').set({ status: 'ready_for_matching' }).where('id', '=', created.id).execute();
    response = await retry();
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'KNOWLEDGE_DOCUMENT_NOT_RETRYABLE', message: '只有解析失败的文档可以重试' });

    await superuser.updateTable('knowledge_documents').set({ status: 'error', error: '失败', message: '失败', progress: 100 }).where('id', '=', created.id).execute();
    response = await retry();
    expect(response.statusCode, response.body).toBe(202);
    const retried = response.json().document;
    expect(retried).toMatchObject({ status: 'pending', progress: 0, message: '等待处理', error: null, job: { status: 'queued', type: KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE } });
    expect(retried.job.id).not.toBe(created.job.id);

    // 余额不足：402，文档恢复为失败并写入原因。
    const poor = await newMember({ balance: 0n });
    const poorFolder = await newFolder(poor);
    const added = (await call(poor, 'POST', `/folders/${poorFolder}/documents`, { fileIds: [await newFile(poor)] })).json().documents[0];
    expect(added).toMatchObject({ status: 'error', message: '余额不足，请充值后再试', job: null });
    response = await call(poor, 'POST', `/documents/${added.id}/retry`);
    expect(response.statusCode).toBe(402);
    expect((await call(poor, 'GET', `/documents/${added.id}`)).json().document).toMatchObject({ status: 'error', error: '余额不足，请充值后再试' });
    expect(await jobsOf(poor.orgId)).toEqual([]);
  });

  it('删除文档、删除文件夹后取消其中文档的处理任务', async () => {
    const member = await newMember();
    const folder = await newFolder(member);
    const created = (await call(member, 'POST', `/folders/${folder}/documents`, { fileIds: [await newFile(member), await newFile(member)] })).json().documents;
    const statusOf = async (jobId: string) => (await superuser.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status;
    const deleted = await call(member, 'DELETE', `/documents/${created[0].id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().document.job.id).toBe(created[0].job.id);
    expect(await statusOf(created[0].job.id)).toBe('cancelled');
    expect(await statusOf(created[1].job.id)).toBe('queued');

    const another = (await call(member, 'POST', `/folders/${folder}/documents`, { fileIds: [await newFile(member)] })).json().documents[0];
    expect((await call(member, 'DELETE', `/folders/${folder}`)).statusCode).toBe(200);
    expect(await statusOf(created[1].job.id)).toBe('cancelled');
    expect(await statusOf(another.job.id)).toBe('cancelled');
  });
});

describe('经 worker 执行', () => {
  it('挂文档 → worker 认领执行（沙箱解析、经 AI 网关调用模型）→ 候选条目提取完成', async () => {
    const member = await newMember();
    const folder = await newFolder(member);
    const sandbox = fakeSandbox({ kind: 'output', markdown: SAMPLE });
    const gateway: AiGateway = {
      async chat(_context, request) {
        expect(request).toMatchObject({ source: 'job', jobType: KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE });
        return chatResult(request.maxOutputTokens === 1 ? '' : defaultRespond(request.messages as { role: string; content: string }[]));
      },
    };
    const prefix = uniquePrefix();
    const logs = testLogger();
    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'knowledge-test-dispatch'), prefix });
    const runner = createJobRunner({
      db: appDb,
      registry: jobTypeRegistry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'knowledge-test-worker'),
      log: logs.log,
      prefix,
      reconcileIntervalMs: 300,
      objectStore: memoryStore,
      sandbox,
      gateway,
    });
    // 前面的用例留下的排队任务不交给本 worker。
    await superuser.updateTable('jobs').set({ status: 'cancelled', finished_at: new Date() }).where('status', 'in', ['queued', 'paused']).execute();
    try {
      await runner.start();
      const created = (await call(member, 'POST', `/folders/${folder}/documents`, { fileIds: [await newFile(member)] })).json().documents[0];
      const finished = await waitFor(
        async () => {
          const row = await superuser.selectFrom('jobs').select(['status', 'error_code', 'progress']).where('id', '=', created.job.id).executeTakeFirst();
          return row && ['succeeded', 'failed', 'cancelled'].includes(row.status) ? row : null;
        },
        30_000,
        'knowledge job finished',
      );
      expect(finished).toEqual({ status: 'succeeded', error_code: null, progress: 100 });
      const document = (await call(member, 'GET', `/documents/${created.id}`)).json().document;
      expect(document).toMatchObject({ status: 'ready_for_matching', progress: 65, candidateItemCount: 3, job: { id: created.job.id, status: 'succeeded' } });
      const events = await superuser.selectFrom('job_events').select('message').where('job_id', '=', created.job.id).orderBy('id').execute();
      expect(events.map((event: { message: string | null }) => event.message)).toEqual(
        expect.arrayContaining(['开始处理知识库文档。', '正在转换为 Markdown。', '已提取 3 条候选知识。']),
      );
      expect(sandbox.calls).toEqual(['create', 'copyIn', expect.stringMatching(/^exec:parse /), 'copyOut', 'destroy']);
    } finally {
      await runner.close();
      await dispatcher.close();
    }
  });
});
