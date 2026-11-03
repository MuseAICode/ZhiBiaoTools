// 文档解析任务（路线图第 6 步 6.6，src/parse/job.ts、迁移 0023_artifact_supersede）的数据库测试：导入后自动入队；
// 解析结果经 writeArtifact 写入、经各模块的 saveDocumentParse / saveSourceParse 写回；重新解析时旧产物标为已被替换；
// 各种失败的文案与文档状态；沙箱在 finally 中销毁；沙箱数已达上限时按可重试处理；取消与 worker 关闭；以及经 worker
// （真实 Valkey）从导入到解析完成的完整流程。沙箱用桩（不需要 Docker），解析入口本身由 tests/sandbox/docker/parse.test.ts 覆盖。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { findArtifact, listArtifacts } from '../../src/artifacts/store.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { loadFeasibilityReport } from '../../src/feasibilityReport/store.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { JobError, JobInterruptedError, type JobContext } from '../../src/jobs/definitions.ts';
import { createJobDispatcher } from '../../src/jobs/queue.ts';
import { jobTypeRegistry } from '../../src/jobs/registry.ts';
import { createJobRunner } from '../../src/jobs/runner.ts';
import { createDocumentParseJob, DOCUMENT_PARSE_JOB_TYPE, type DocumentParseParams, type ParseTarget } from '../../src/parse/job.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { loadRejectionCheck } from '../../src/rejectionCheck/store.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxExecResult, type SandboxRef } from '../../src/sandbox/driver.ts';
import { loadTechnicalPlan } from '../../src/technicalPlan/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { redisConfig, testLogger, uniquePrefix, waitFor } from './jobFixtures.ts';

const PASSWORD = 'quiet-harbor-maple-61';
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
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

// ---- 沙箱桩 ----

type ExecBehavior =
  | { kind: 'output'; files: SandboxFile[] }
  | { kind: 'exit'; exitCode: number; stdout: string }
  | { kind: 'timeout' }
  | { kind: 'throw'; error: Error }
  /** 等到调用方中止（取消、关闭）为止，再以 SANDBOX_ABORTED 失败。 */
  | { kind: 'hang' };

interface FakeSandbox extends SandboxDriver {
  calls: string[];
  inputs: SandboxFile[][];
  /** 依次抛出的创建错误（用完后创建成功）。 */
  createErrors: SandboxError[];
  exec: SandboxDriver['exec'];
  behavior: ExecBehavior;
  /** exec 开始时调用（测试用来在执行中触发中止）。 */
  onExec?: () => void;
}

function fakeSandbox(behavior: ExecBehavior): FakeSandbox {
  const fake: FakeSandbox = {
    calls: [],
    inputs: [],
    createErrors: [],
    behavior,
    async create(template, options) {
      fake.calls.push('create');
      const error = fake.createErrors.shift();
      if (error) throw error;
      return { id: randomUUID(), template, jobId: options.jobId, expiresAt: new Date(Date.now() + 60_000) };
    },
    async copyIn(_sandbox, files) {
      fake.calls.push('copyIn');
      fake.inputs.push([...files]);
    },
    async exec(_sandbox, command, args, options = {}): Promise<SandboxExecResult> {
      fake.calls.push(`exec:${command} ${args.join(' ')}`);
      fake.onExec?.();
      const base = { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
      const current = fake.behavior;
      if (current.kind === 'exit') return { ...base, exitCode: current.exitCode, timedOut: false, stdout: current.stdout };
      if (current.kind === 'timeout') return { ...base, exitCode: null, timedOut: true };
      if (current.kind === 'throw') throw current.error;
      if (current.kind === 'hang') {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new SandboxError('SANDBOX_ABORTED', '沙箱操作已中止');
      }
      return { ...base, exitCode: 0, timedOut: false };
    },
    async copyOut() {
      fake.calls.push('copyOut');
      if (fake.behavior.kind !== 'output') throw new Error('copyOut without output');
      return fake.behavior.files;
    },
    async destroy(sandbox: SandboxRef) {
      fake.calls.push(`destroy:${sandbox.id.length}`);
    },
  };
  return fake;
}

function output(markdown: string, images: Array<{ path: string; mime: string; data: Buffer }> = []): ExecBehavior {
  return {
    kind: 'output',
    files: [
      { path: 'content.md', data: Buffer.from(markdown, 'utf8') },
      { path: 'manifest.json', data: Buffer.from(JSON.stringify({ version: 1, images: images.map(({ path, mime }) => ({ path, mime })) })) },
      ...images.map(({ path, data }) => ({ path, data })),
    ],
  };
}

// ---- 数据准备 ----

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

async function newMember(): Promise<Member> {
  const hasher = await fastHasher();
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { userId, orgId, cookie: await login(email), context: { orgId, userId, role: 'owner' } };
}

async function newProject(member: Member, kind: 'technical-plan' | 'rejection-check' | 'feasibility-report'): Promise<string> {
  const row = await superuser.insertInto('projects').values({ org_id: member.orgId, kind, name: '项目', created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

/** 登记一个已上传的 tender 文件（不属于任何项目），并把原件放进对象存储。 */
async function newFile(member: Member, options: { name?: string; mime?: string; extension?: string; content?: Buffer } = {}): Promise<string> {
  const content = options.content ?? Buffer.from('PK original');
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      purpose: 'tender',
      display_name: options.name ?? '招标文件.docx',
      extension: options.extension ?? 'docx',
      status: 'uploaded',
      mime: options.mime ?? DOCX_MIME,
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

function call(member: Member, method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** 导入一份招标文件到技术方案项目（经接口，同时入队解析任务），返回 { projectId, fileId }。 */
async function importTender(member: Member, options: Parameters<typeof newFile>[1] = {}): Promise<{ projectId: string; fileId: string }> {
  const projectId = await newProject(member, 'technical-plan');
  const fileId = await newFile(member, options);
  const response = await call(member, 'POST', `/api/projects/${projectId}/technical-plan/tender-files`, { fileIds: [fileId] });
  expect(response.statusCode, response.body).toBe(200);
  return { projectId, fileId };
}

async function parseJobs(orgId: string): Promise<Array<{ id: string; project_id: string; lock_key: string; params: Record<string, unknown>; status: string; user_id: string }>> {
  return superuser
    .selectFrom('jobs')
    .select(['id', 'project_id', 'lock_key', 'params', 'status', 'user_id'])
    .where('org_id', '=', orgId)
    .where('type', '=', DOCUMENT_PARSE_JOB_TYPE)
    .orderBy('created_at')
    .execute();
}

const job = createDocumentParseJob({ createRetryDelaysMs: [5, 5] });

interface RunOptions {
  target?: ParseTarget;
  sandbox?: SandboxDriver | null;
  objectStore?: ObjectStore | null;
  controller?: AbortController;
  /** setProgress 时报告租约已丢失。 */
  leaseLost?: boolean;
}

/** 以给定的上下文直接执行任务类型的 run（不经队列）。 */
async function runParse(member: Member, projectId: string, fileId: string, options: RunOptions = {}): Promise<{ error: unknown; logs: string[] }> {
  const logs: string[] = [];
  const controller = options.controller ?? new AbortController();
  const context: JobContext<DocumentParseParams> = {
    jobId: randomUUID(),
    projectId,
    type: DOCUMENT_PARSE_JOB_TYPE,
    attempt: 1,
    params: job.parseParams({ target: options.target ?? 'technical-plan-tender', fileId }),
    checkpoint: null,
    tenant: member.context,
    db: appDb,
    signal: controller.signal,
    async setProgress() {
      if (options.leaseLost) throw new JobInterruptedError();
    },
    async saveCheckpoint() {},
    async log(message) {
      logs.push(message);
    },
    ai: {
      async chat() {
        throw new Error('parse jobs do not call models');
      },
    },
    objectStore: options.objectStore === undefined ? memoryStore : options.objectStore,
    sandbox: options.sandbox === undefined ? fakeSandbox(output('# 默认\n')) : options.sandbox,
  };
  try {
    await job.run(context);
    return { error: null, logs };
  } catch (error) {
    return { error, logs };
  }
}

async function technicalPlanDocument(member: Member, projectId: string) {
  return (await loadTechnicalPlan(appDb, member.context, projectId)).tenderFiles[0]!;
}

async function markdownOf(member: Member, artifactId: string): Promise<string> {
  const artifact = await findArtifact(appDb, member.context, artifactId);
  expect(artifact).not.toBeNull();
  return objects.get(artifact!.storageKey)!.toString('utf8');
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

describe('导入后自动入队', () => {
  it('技术方案招标文件：每个新文件一个任务，互斥键是文件 id，重复导入不再入队', async () => {
    const member = await newMember();
    const projectId = await newProject(member, 'technical-plan');
    const first = await newFile(member);
    const second = await newFile(member);
    const response = await call(member, 'POST', `/api/projects/${projectId}/technical-plan/tender-files`, { fileIds: [first, second] });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ addedCount: 2, addedFileIds: [first, second] });
    const jobs = await parseJobs(member.orgId);
    expect(jobs.map((row) => [row.project_id, row.lock_key, row.params, row.status, row.user_id])).toEqual([
      [projectId, `document-parse:${first}`, { target: 'technical-plan-tender', fileId: first }, 'queued', member.userId],
      [projectId, `document-parse:${second}`, { target: 'technical-plan-tender', fileId: second }, 'queued', member.userId],
    ]);
    const again = await call(member, 'POST', `/api/projects/${projectId}/technical-plan/tender-files`, { fileIds: [first] });
    expect(again.json()).toMatchObject({ addedCount: 0, addedFileIds: [] });
    expect(await parseJobs(member.orgId)).toHaveLength(2);
  });

  it('技术方案原方案：新上传的入队（保留图片），已是原方案的不重复入队', async () => {
    const member = await newMember();
    const projectId = await newProject(member, 'technical-plan');
    const fileId = await newFile(member, { name: '原方案.docx' });
    const url = `/api/projects/${projectId}/technical-plan/original-plan`;
    expect((await call(member, 'PUT', url, { fileId })).statusCode).toBe(200);
    expect((await call(member, 'PUT', url, { fileId })).statusCode).toBe(200);
    const jobs = await parseJobs(member.orgId);
    expect(jobs.map((row) => row.params)).toEqual([{ target: 'technical-plan-original-plan', fileId }]);
  });

  it('废标检查（招标、投标文件）与可研报告资料', async () => {
    const member = await newMember();
    const rejectionProject = await newProject(member, 'rejection-check');
    const tender = await newFile(member);
    const bid = await newFile(member, { name: '投标文件.docx' });
    expect((await call(member, 'POST', `/api/projects/${rejectionProject}/rejection-check/documents`, { role: 'tender', fileIds: [tender] })).statusCode).toBe(200);
    expect((await call(member, 'POST', `/api/projects/${rejectionProject}/rejection-check/documents`, { role: 'bid', fileIds: [bid] })).statusCode).toBe(200);
    const feasibilityProject = await newProject(member, 'feasibility-report');
    const source = await newFile(member, { name: '资料.docx' });
    expect((await call(member, 'PUT', `/api/projects/${feasibilityProject}/feasibility-report/sources`, { fileIds: [source] })).statusCode).toBe(200);
    expect((await parseJobs(member.orgId)).map((row) => [row.project_id, row.params])).toEqual([
      [rejectionProject, { target: 'rejection-check', fileId: tender }],
      [rejectionProject, { target: 'rejection-check', fileId: bid }],
      [feasibilityProject, { target: 'feasibility-report', fileId: source }],
    ]);
  });

  it('任务参数只有目标和文件 id', () => {
    expect(() => job.parseParams({ target: 'technical-plan-tender', fileId: randomUUID(), extra: 1 })).toThrow(TypeError);
    expect(() => job.parseParams({ target: 'knowledge', fileId: randomUUID() })).toThrow(TypeError);
    expect(() => job.parseParams({ target: 'rejection-check', fileId: '../x' })).toThrow(TypeError);
  });
});

describe('解析与写回', () => {
  it('写入 Markdown 产物并写回文档（与桌面版相同的字段），沙箱用完即销毁', async () => {
    const member = await newMember();
    const { projectId, fileId } = await importTender(member, { content: Buffer.from('PK source bytes') });
    const sandbox = fakeSandbox(output('# 招标文件\n\n![远程](https://example.com/x.png)\n正文\n'));
    expect((await runParse(member, projectId, fileId, { sandbox })).error).toBeNull();
    expect(sandbox.calls).toEqual(['create', 'copyIn', 'exec:parse format=docx images=0', 'copyOut', 'destroy:36']);
    // 原件以固定名称放入，不带文件名。
    expect(sandbox.inputs).toEqual([[{ path: 'source', data: Buffer.from('PK source bytes') }]]);
    const document = await technicalPlanDocument(member, projectId);
    expect(document).toMatchObject({ status: 'success', parserLabel: '本地解析', error: null });
    const markdown = await markdownOf(member, document.markdownArtifactId!);
    // 远程图片去掉。
    expect(markdown).toBe('# 招标文件\n\n\n正文\n');
    expect(document.contentChars).toBe(markdown.trimEnd().length);
    expect(document.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const artifacts = await listArtifacts(appDb, member.context, { sourceFileId: fileId, limit: 10 });
    expect(artifacts.map((artifact) => [artifact.kind, artifact.name, artifact.mime, artifact.projectId])).toEqual([
      ['markdown', 'content.md', 'text/markdown; charset=utf-8', projectId],
    ]);
  });

  it('技术方案招标文件同时写入疑似多标段检测摘要（6.11），状态中合并各文件的结果；原方案与其他模块不写', async () => {
    const member = await newMember();
    const projectId = await newProject(member, 'technical-plan');
    const first = await newFile(member, { name: '第一册.docx' });
    const second = await newFile(member, { name: '第二册.docx' });
    expect((await call(member, 'POST', `/api/projects/${projectId}/technical-plan/tender-files`, { fileIds: [first, second] })).statusCode).toBe(200);
    // 两份文件各有一个标段定义：单独看都不是多标段，合并后是。
    expect((await runParse(member, projectId, first, { sandbox: fakeSandbox(output('# 第一册\n一标段：设备采购\n')) })).error).toBeNull();
    let state = await loadTechnicalPlan(appDb, member.context, projectId);
    // 第二份还没有解析成功：只合并解析成功的文件。
    expect(state.bidSectionDetection).toEqual({ hasMultiple: false, totalDeclared: null });
    expect((await runParse(member, projectId, second, { sandbox: fakeSandbox(output('# 第二册\n二标段：安装调试\n')) })).error).toBeNull();
    state = await loadTechnicalPlan(appDb, member.context, projectId);
    // 与桌面版相同，“二标段”同时按总数声明计（共 2 个）。
    expect(state.bidSectionDetection).toEqual({ hasMultiple: true, totalDeclared: 2 });
    const rows = await superuser.selectFrom('technical_plan_documents').select(['file_id', 'bid_section_detection']).where('project_id', '=', projectId).execute();
    expect(Object.fromEntries(rows.map((row: { file_id: string; bid_section_detection: unknown }) => [row.file_id, row.bid_section_detection]))).toEqual({
      [first]: { version: 1, declaredSections: null, declaredAny: null, definitions: ['标段:1'], bracketGroups: [], bracketChildren: [] },
      [second]: { version: 1, declaredSections: 2, declaredAny: 2, definitions: ['标段:2'], bracketGroups: [], bracketChildren: [] },
    });
    // 移除一份后按剩下的文件重新合并。
    expect((await call(member, 'DELETE', `/api/projects/${projectId}/technical-plan/tender-files/${second}`)).statusCode).toBe(200);
    expect((await loadTechnicalPlan(appDb, member.context, projectId)).bidSectionDetection).toEqual({ hasMultiple: false, totalDeclared: null });
    // 摘要缺失（不应出现，例如手工改过的行）时不提示。
    await superuser.updateTable('technical_plan_documents').set({ bid_section_detection: null }).where('file_id', '=', first).execute();
    expect((await loadTechnicalPlan(appDb, member.context, projectId)).bidSectionDetection).toBeNull();

    const plan = await newFile(member, { name: '原方案.docx' });
    expect((await call(member, 'PUT', `/api/projects/${projectId}/technical-plan/original-plan`, { fileId: plan })).statusCode).toBe(200);
    expect((await runParse(member, projectId, plan, { target: 'technical-plan-original-plan', sandbox: fakeSandbox(output('一标段：x\n二标段：y\n')) })).error).toBeNull();
    expect(await superuser.selectFrom('technical_plan_documents').select('bid_section_detection').where('file_id', '=', plan).executeTakeFirstOrThrow()).toEqual({ bid_section_detection: null });
  });

  it('原方案保留图片：图片写成产物，Markdown 中的引用改为产物地址', async () => {
    const member = await newMember();
    const projectId = await newProject(member, 'technical-plan');
    const fileId = await newFile(member, { name: '原方案.docx' });
    expect((await call(member, 'PUT', `/api/projects/${projectId}/technical-plan/original-plan`, { fileId })).statusCode).toBe(200);
    const sandbox = fakeSandbox(
      output('# 原方案\n\n![](images/image-0001.png)\n\n<table><tr><td><img src="images/image-0002.png"></td></tr></table>\n', [
        { path: 'images/image-0001.png', mime: 'image/png', data: PNG },
        { path: 'images/image-0002.png', mime: 'image/png', data: PNG },
      ]),
    );
    expect((await runParse(member, projectId, fileId, { target: 'technical-plan-original-plan', sandbox })).error).toBeNull();
    expect(sandbox.calls).toContain('exec:parse format=docx images=1');
    const plan = (await loadTechnicalPlan(appDb, member.context, projectId)).originalPlanFile!;
    expect(plan.status).toBe('success');
    const images = await listArtifacts(appDb, member.context, { sourceFileId: fileId, kind: 'image', limit: 10 });
    expect(images.map((image) => [image.name, image.mime])).toEqual([
      ['image-0001.png', 'image/png'],
      ['image-0002.png', 'image/png'],
    ]);
    expect(await markdownOf(member, plan.markdownArtifactId!)).toBe(
      `# 原方案\n\n![](/api/artifacts/${images[0]!.id}/content)\n\n<table><tr><td><img src="/api/artifacts/${images[1]!.id}/content"></td></tr></table>\n`,
    );
  });

  it('表格以文件名作一级标题（与桌面版相同）；废标检查与可研报告写回各自的文档', async () => {
    const member = await newMember();
    const rejectionProject = await newProject(member, 'rejection-check');
    const xlsx = await newFile(member, { name: '报价 清单.xlsx', extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect((await call(member, 'POST', `/api/projects/${rejectionProject}/rejection-check/documents`, { role: 'bid', fileIds: [xlsx] })).statusCode).toBe(200);
    const sandbox = fakeSandbox(output('## 工作表：Sheet1\n\n|a|b|\n'));
    expect((await runParse(member, rejectionProject, xlsx, { target: 'rejection-check', sandbox })).error).toBeNull();
    expect(sandbox.calls).toContain('exec:parse format=xlsx images=0');
    const bid = (await loadRejectionCheck(appDb, member.context, rejectionProject)).bidDocuments[0]!;
    expect(bid.status).toBe('success');
    expect(await markdownOf(member, bid.markdownArtifactId!)).toBe('# 报价 清单.xlsx\n\n## 工作表：Sheet1\n\n|a|b|\n');

    const feasibilityProject = await newProject(member, 'feasibility-report');
    const text = await newFile(member, { name: '资料.txt', extension: 'txt', mime: 'text/plain; charset=gb18030' });
    expect((await call(member, 'PUT', `/api/projects/${feasibilityProject}/feasibility-report/sources`, { fileIds: [text] })).statusCode).toBe(200);
    const textSandbox = fakeSandbox(output('资料正文\n'));
    expect((await runParse(member, feasibilityProject, text, { target: 'feasibility-report', sandbox: textSandbox })).error).toBeNull();
    expect(textSandbox.calls).toContain('exec:parse format=text images=0 charset=gb18030');
    expect((await loadFeasibilityReport(appDb, member.context, feasibilityProject)).sourceFiles[0]).toMatchObject({ status: 'success' });
  });

  it('重新解析时替换旧产物：之前的产物标为已被替换，读取时不再返回，文档指向新的 Markdown', async () => {
    const member = await newMember();
    const projectId = await newProject(member, 'technical-plan');
    const fileId = await newFile(member, { name: '原方案.docx' });
    expect((await call(member, 'PUT', `/api/projects/${projectId}/technical-plan/original-plan`, { fileId })).statusCode).toBe(200);
    const withImage = () => output('![](images/image-0001.png)\n文字\n', [{ path: 'images/image-0001.png', mime: 'image/png', data: PNG }]);
    expect((await runParse(member, projectId, fileId, { target: 'technical-plan-original-plan', sandbox: fakeSandbox(withImage()) })).error).toBeNull();
    const before = await listArtifacts(appDb, member.context, { sourceFileId: fileId, limit: 10 });
    expect(before).toHaveLength(2);
    expect((await runParse(member, projectId, fileId, { target: 'technical-plan-original-plan', sandbox: fakeSandbox(withImage()) })).error).toBeNull();
    const after = await listArtifacts(appDb, member.context, { sourceFileId: fileId, limit: 10 });
    expect(after).toHaveLength(2);
    expect(after.map((artifact) => artifact.id).some((id) => before.some((old) => old.id === id))).toBe(false);
    for (const old of before) expect(await findArtifact(appDb, member.context, old.id)).toBeNull();
    const rows = await superuser.selectFrom('artifacts').select(['id', 'superseded_at']).where('source_file_id', '=', fileId).execute();
    expect(rows.filter((row: { superseded_at: Date | null }) => row.superseded_at !== null).map((row: { id: string }) => row.id).sort()).toEqual(before.map((artifact) => artifact.id).sort());
    const plan = (await loadTechnicalPlan(appDb, member.context, projectId)).originalPlanFile!;
    expect(after.map((artifact) => artifact.id)).toContain(plan.markdownArtifactId);
    // 被替换的产物在清理（6.8）之前仍占用存储，计入配额；对象仍在。
    for (const old of before) expect(await memoryStore.exists((await superuser.selectFrom('artifacts').select('storage_key').where('id', '=', old.id).executeTakeFirstOrThrow()).storage_key)).toBe(true);
  });

  it('文档在解析前或解析中被移除时不写回，本次产物同样标为已被替换', async () => {
    const member = await newMember();
    const { projectId, fileId } = await importTender(member);
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/technical-plan/tender-files/${fileId}`, headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` } })).statusCode).toBe(200);
    const sandbox = fakeSandbox(output('# x\n'));
    const result = await runParse(member, projectId, fileId, { sandbox });
    expect(result.error).toBeNull();
    expect(result.logs).toEqual(['文档已移除，跳过解析']);
    expect(sandbox.calls).toEqual([]);
  });
});

describe('失败', () => {
  async function failed(behavior: ExecBehavior, options: { mime?: string; target?: ParseTarget } = {}) {
    const member = await newMember();
    const { projectId, fileId } = await importTender(member, options.mime ? { mime: options.mime } : {});
    const sandbox = fakeSandbox(behavior);
    const result = await runParse(member, projectId, fileId, { sandbox, ...(options.target ? { target: options.target } : {}) });
    return { member, projectId, fileId, sandbox, error: result.error, logs: result.logs, document: await technicalPlanDocument(member, projectId) };
  }

  it.each([
    ['zip_ratio', 'PARSE_ZIP_RATIO', '文件的压缩比异常（单个条目超过 100:1），已拒绝解析'],
    ['zip_too_many_entries', 'PARSE_ZIP_TOO_MANY_ENTRIES', '文件内部条目超过 10,000 个，已拒绝解析'],
    ['zip_too_large', 'PARSE_ZIP_TOO_LARGE', '文件解压后超过 1 GiB，已拒绝解析'],
    ['pdf_too_many_pages', 'PARSE_PDF_TOO_MANY_PAGES', 'PDF 超过 3,000 页，已拒绝解析'],
    ['office_conversion_timeout', 'PARSE_OFFICE_CONVERSION_TIMEOUT', '老式 Word 文件转换超时（超过 8 分钟），请另存为 docx 后重新导入'],
    ['pdf_text_layer_missing', 'PARSE_PDF_TEXT_LAYER_MISSING', 'PDF 未检测到可选中文字层'],
    ['too_many_images', 'PARSE_TOO_MANY_IMAGES', '文件中的图片超过 2,000 张，已拒绝解析'],
    ['xml_doctype', 'PARSE_XML_DOCTYPE', 'XML 文件含 DTD 声明（<!DOCTYPE> 等），为防止外部实体与实体膨胀已拒绝解析，请另存为 docx / xlsx 后重新导入'],
    ['xml_external_reference', 'PARSE_XML_EXTERNAL_REFERENCE', 'XML 文件含外部引用（XInclude 或样式表），已拒绝解析，请另存为 docx / xlsx 后重新导入'],
    ['xml_invalid', 'PARSE_XML_INVALID', 'XML 文件格式不正确（须为 UTF-8 编码的 Office 2003 XML），请另存为 docx / xlsx 后重新导入'],
    ['rtf_invalid', 'PARSE_RTF_INVALID', 'RTF 文件格式不正确，请另存为 docx 后重新导入'],
    ['mht_invalid', 'PARSE_MHT_INVALID', 'MHT 文件格式不正确（MIME 结构无法解析），请另存为 docx 后重新导入'],
    ['mht_too_complex', 'PARSE_MHT_TOO_COMPLEX', 'MHT 文件的 MIME 结构超过上限（嵌套层数、部分数或头部大小），已拒绝解析'],
    ['mht_no_html', 'PARSE_MHT_NO_HTML', 'MHT 文件中没有网页正文，请另存为 docx 后重新导入'],
    ['something <script>', 'PARSE_CONVERSION_FAILED', '文件解析失败'],
  ])('解析入口报告 %s：文档标为失败，文案由代码决定，沙箱照样销毁', async (code, jobCode, message) => {
    const { sandbox, error, document } = await failed({ kind: 'exit', exitCode: 65, stdout: `${JSON.stringify({ error: code })}\n` });
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: jobCode, message });
    expect(document).toMatchObject({ status: 'error', error: message, markdownArtifactId: null, contentChars: 0, contentHash: null });
    expect(sandbox.calls.at(-1)).toBe('destroy:36');
    expect(sandbox.calls).not.toContain('copyOut');
  });

  it('超时、沙箱操作出错时同样在 finally 中销毁', async () => {
    const timeout = await failed({ kind: 'timeout' });
    expect(timeout.error).toMatchObject({ code: 'PARSE_TIMEOUT', message: '文件解析超时（超过 10 分钟）' });
    expect(timeout.sandbox.calls.at(-1)).toBe('destroy:36');
    const unavailable = await failed({ kind: 'throw', error: new SandboxError('SANDBOX_UNAVAILABLE', '沙箱服务暂不可用') });
    expect(unavailable.error).toMatchObject({ code: 'PARSE_UNAVAILABLE' });
    expect(unavailable.sandbox.calls.at(-1)).toBe('destroy:36');
    const crash = await failed({ kind: 'throw', error: new Error('boom') });
    // 程序错误：原错误交给执行者写日志（任务记为 JOB_FAILED），文档标为“文件解析失败”。
    expect(crash.error).toMatchObject({ message: 'boom' });
    expect(crash.document).toMatchObject({ status: 'error', error: '文件解析失败' });
    expect(crash.sandbox.calls.at(-1)).toBe('destroy:36');
  });

  it('输出不合规整体拒绝：多余文件、图片内容与类型不符、引用了输出中没有的图片（原图资源缺失）', async () => {
    const extra = await failed({ kind: 'output', files: [...(output('x').kind === 'output' ? (output('x') as { files: SandboxFile[] }).files : []), { path: 'evil.json', data: Buffer.from('{}') }] });
    expect(extra.error).toMatchObject({ code: 'PARSE_OUTPUT_REJECTED', message: '解析结果不符合要求，已拒绝' });
    const fake = await failed(output('x', [{ path: 'images/image-0001.png', mime: 'image/png', data: Buffer.from('<svg onload=alert(1)>') }]));
    expect(fake.error).toMatchObject({ code: 'PARSE_OUTPUT_REJECTED' });
    const missing = await failed(output('![](images/image-0003.png)\n'), { target: 'technical-plan-tender' });
    expect(missing.error).toMatchObject({ code: 'PARSE_IMAGE_MISSING', message: '原方案图片资源缺失，请重新导入原 Word' });
    expect(missing.document).toMatchObject({ status: 'error' });
    // 输出不合规时一个产物也不留。
    expect(await listArtifacts(appDb, missing.member.context, { sourceFileId: missing.fileId, limit: 10 })).toEqual([]);
  });

  it('解析出的正文为空', async () => {
    const empty = await failed(output('  \n\n![](https://example.com/only-image.png)\n'));
    expect(empty.error).toMatchObject({ code: 'PARSE_EMPTY', message: '未提取到有效 Markdown 内容，请检查文件内容' });
    expect(await listArtifacts(appDb, empty.member.context, { sourceFileId: empty.fileId, limit: 10 })).toEqual([]);
  });

  it('文本类格式（6.7）按记录的 MIME 与登记的扩展名分派到沙箱；扩展名不符与不支持的类型不创建沙箱，直接失败', async () => {
    const member = await newMember();
    for (const [mime, extension, format] of [
      ['application/rtf', 'doc', 'rtf'],
      ['text/html', 'wps', 'html-word'],
      ['text/html', 'xls', 'html-sheet'],
      ['message/rfc822', 'doc', 'mht'],
      ['application/xml', 'wps', 'word-xml'],
      ['application/xml', 'xls', 'spreadsheet-xml'],
    ] as const) {
      const { projectId, fileId } = await importTender(member, { name: `招标.${extension}`, mime, extension });
      const sandbox = fakeSandbox(output('正文\n'));
      expect((await runParse(member, projectId, fileId, { sandbox })).error).toBeNull();
      expect(sandbox.calls).toEqual(['create', 'copyIn', `exec:parse format=${format} images=0`, 'copyOut', 'destroy:36']);
      const document = await technicalPlanDocument(member, projectId);
      expect(document.status).toBe('success');
      // 表格类格式以文件名作一级标题。
      expect(await markdownOf(member, document.markdownArtifactId!)).toBe(extension === 'xls' ? `# 招标.xls\n\n正文\n` : '正文\n');
    }
    for (const [mime, extension] of [['application/xml', 'docx'], ['text/html', 'pdf'], ['application/octet-stream', 'docx']] as const) {
      const { projectId, fileId } = await importTender(member, { name: `招标.${extension}`, mime, extension });
      const sandbox = fakeSandbox(output('x'));
      expect((await runParse(member, projectId, fileId, { sandbox })).error).toMatchObject({ code: 'PARSE_UNSUPPORTED_FORMAT', message: '不支持的文件格式' });
      expect(sandbox.calls).toEqual([]);
    }
  });

  it('worker 未配置沙箱或对象存储时失败（PARSE_UNAVAILABLE），原件不存在时 PARSE_SOURCE_MISSING', async () => {
    const member = await newMember();
    const { projectId, fileId } = await importTender(member);
    expect((await runParse(member, projectId, fileId, { sandbox: null })).error).toMatchObject({ code: 'PARSE_UNAVAILABLE' });
    expect((await runParse(member, projectId, fileId, { objectStore: null })).error).toMatchObject({ code: 'PARSE_UNAVAILABLE' });
    const key = (await superuser.selectFrom('files').select('storage_key').where('id', '=', fileId).executeTakeFirstOrThrow()).storage_key;
    objects.delete(key);
    expect((await runParse(member, projectId, fileId)).error).toMatchObject({ code: 'PARSE_SOURCE_MISSING', message: '原件不存在，请重新上传' });
  });
});

describe('沙箱数已达上限（可重试）', () => {
  it('按退避间隔重试创建，名额空出后照常解析', async () => {
    const member = await newMember();
    const { projectId, fileId } = await importTender(member);
    const sandbox = fakeSandbox(output('# 正文\n'));
    sandbox.createErrors.push(new SandboxError('SANDBOX_BUSY', '沙箱数已达上限，请稍后重试'), new SandboxError('SANDBOX_UNAVAILABLE', '沙箱服务暂不可用'));
    const result = await runParse(member, projectId, fileId, { sandbox });
    expect(result.error).toBeNull();
    expect(result.logs).toEqual(['沙箱数已达上限，稍后重试', '解析服务暂不可用，稍后重试', '解析完成']);
    expect(sandbox.calls.filter((item) => item === 'create')).toHaveLength(3);
    expect((await technicalPlanDocument(member, projectId)).status).toBe('success');
  });

  it('重试用完仍满时失败，文案说明原因', async () => {
    const member = await newMember();
    const { projectId, fileId } = await importTender(member);
    const sandbox = fakeSandbox(output('# 正文\n'));
    sandbox.createErrors.push(...Array.from({ length: 3 }, () => new SandboxError('SANDBOX_BUSY', '沙箱数已达上限，请稍后重试')));
    const result = await runParse(member, projectId, fileId, { sandbox });
    expect(result.error).toMatchObject({ code: 'PARSE_SANDBOX_BUSY', message: '解析服务繁忙（沙箱数已达上限），请稍后重新导入' });
    expect(sandbox.calls).toEqual(['create', 'create', 'create']);
    expect(await technicalPlanDocument(member, projectId)).toMatchObject({ status: 'error', error: '解析服务繁忙（沙箱数已达上限），请稍后重新导入' });
  });
});

describe('中止', () => {
  it('取消：中止执行中的沙箱命令，销毁沙箱，文档标为已取消', async () => {
    const member = await newMember();
    const { projectId, fileId } = await importTender(member);
    const controller = new AbortController();
    const sandbox = fakeSandbox({ kind: 'hang' });
    sandbox.onExec = () => setTimeout(() => controller.abort('cancel'), 10);
    const result = await runParse(member, projectId, fileId, { sandbox, controller });
    expect(result.error).toMatchObject({ code: 'PARSE_CANCELLED', message: '解析已取消' });
    expect(sandbox.calls.at(-1)).toBe('destroy:36');
    expect(await technicalPlanDocument(member, projectId)).toMatchObject({ status: 'error', error: '解析已取消' });
  });

  it('worker 关闭或租约丢失：不写文档（由续跑的执行者重新解析），沙箱照样销毁', async () => {
    const member = await newMember();
    const { projectId, fileId } = await importTender(member);
    const controller = new AbortController();
    const sandbox = fakeSandbox({ kind: 'hang' });
    sandbox.onExec = () => setTimeout(() => controller.abort('shutdown'), 10);
    const result = await runParse(member, projectId, fileId, { sandbox, controller });
    expect(result.error).toBeInstanceOf(JobInterruptedError);
    expect(sandbox.calls.at(-1)).toBe('destroy:36');
    expect((await technicalPlanDocument(member, projectId)).status).toBe('running');

    // 写回前发现租约已丢失：不写回，留给新的执行者。
    const lost = await runParse(member, projectId, fileId, { sandbox: fakeSandbox(output('# 正文\n')), leaseLost: true });
    expect(lost.error).toBeInstanceOf(JobInterruptedError);
    expect((await technicalPlanDocument(member, projectId)).status).toBe('running');
  });
});

describe('迁移 0023：产物的“已被替换”标记', () => {
  async function readyArtifact(member: Member, fileId: string, status: 'ready' | 'writing' = 'ready'): Promise<string> {
    const ready = status === 'ready';
    const row = await superuser
      .insertInto('artifacts')
      .values({
        org_id: member.orgId,
        source_file_id: fileId,
        kind: 'markdown',
        name: 'content.md',
        mime: 'text/markdown; charset=utf-8',
        status,
        size_bytes: ready ? 1 : null,
        sha256: ready ? Buffer.alloc(32) : null,
        completed_at: ready ? new Date() : null,
        created_by: member.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function asApp<T>(member: Member, run: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return appDb.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.org_id', ${member.orgId}, true), set_config('app.user_id', ${member.userId}, true)`.execute(trx);
      return run(trx);
    });
  }

  it('只能由空设为当前时间一次（时间由触发器写入），其他列仍不可改，写入中的产物不能标记', async () => {
    const member = await newMember();
    const fileId = await newFile(member);
    const id = await readyArtifact(member, fileId);
    const claimed = new Date('2000-01-01T00:00:00Z');
    await asApp(member, (trx) => trx.updateTable('artifacts').set({ superseded_at: claimed }).where('id', '=', id).execute());
    const marked = await superuser.selectFrom('artifacts').select('superseded_at').where('id', '=', id).executeTakeFirstOrThrow();
    expect(Math.abs(marked.superseded_at.getTime() - Date.now())).toBeLessThan(60_000);
    await expect(asApp(member, (trx) => trx.updateTable('artifacts').set({ superseded_at: new Date() }).where('id', '=', id).execute())).rejects.toMatchObject({ code: 'AR003' });
    const other = await readyArtifact(member, fileId);
    await expect(asApp(member, (trx) => trx.updateTable('artifacts').set({ superseded_at: new Date(), size_bytes: 2 }).where('id', '=', other).execute())).rejects.toMatchObject({ code: 'AR003' });
    const writing = await readyArtifact(member, fileId, 'writing');
    await expect(asApp(member, (trx) => trx.updateTable('artifacts').set({ superseded_at: new Date() }).where('id', '=', writing).execute())).rejects.toMatchObject({ code: 'AR003' });
    // 应用角色只多了这一列的 UPDATE 授权。
    const privileges = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_name = 'artifacts' AND grantee = 'bidtools_app' AND privilege_type = 'UPDATE' ORDER BY column_name`.execute(superuser);
    expect(privileges.rows.map((row) => row.column_name)).toEqual(['sha256', 'size_bytes', 'status', 'superseded_at']);
  });

  it('其他组织的产物标记不到（RLS）', async () => {
    const owner = await newMember();
    const stranger = await newMember();
    const id = await readyArtifact(owner, await newFile(owner));
    const result = await asApp(stranger, (trx) => trx.updateTable('artifacts').set({ superseded_at: new Date() }).where('id', '=', id).executeTakeFirst());
    expect(Number(result.numUpdatedRows)).toBe(0);
  });
});

describe('经 worker 的完整流程（真实 Valkey）', () => {
  it('导入 → 入队 → worker 认领 → 在沙箱中解析 → 文档就绪，任务成功', async () => {
    const prefix = uniquePrefix();
    const logs = testLogger();
    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'parse-test-dispatch'), prefix });
    const sandbox = fakeSandbox(output('# 经 worker 解析\n'));
    const runner = createJobRunner({
      db: appDb,
      registry: jobTypeRegistry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'parse-test-worker'),
      log: logs.log,
      prefix,
      reconcileIntervalMs: 600_000,
      objectStore: memoryStore,
      sandbox,
    });
    try {
      const member = await newMember();
      const { projectId } = await importTender(member);
      await runner.start();
      const [row] = await parseJobs(member.orgId);
      const finished = await waitFor(async () => {
        const current = await superuser.selectFrom('jobs').select(['status', 'error_code']).where('id', '=', row!.id).executeTakeFirst();
        return current && ['succeeded', 'failed'].includes(current.status) ? current : null;
      }, 20_000, 'parse job finished');
      expect(finished).toEqual({ status: 'succeeded', error_code: null });
      // 对账同时派发了本文件中其他用例留下的排队任务；每个创建的沙箱都被销毁。
      expect(sandbox.calls.filter((item) => item === 'create').length).toBe(sandbox.calls.filter((item) => item.startsWith('destroy')).length);
      const document = await technicalPlanDocument(member, projectId);
      expect(document.status).toBe('success');
      expect(await markdownOf(member, document.markdownArtifactId!)).toBe('# 经 worker 解析\n');
      const events = await superuser.selectFrom('job_events').select('message').where('job_id', '=', row!.id).orderBy('id').execute();
      expect(events.map((event: { message: string }) => event.message)).toContain('解析完成');
    } finally {
      await runner.close();
      await dispatcher.close();
    }
  });
});
