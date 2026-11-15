// 标书查重分析任务（路线图第 6 步 6.10，src/duplicateCheck/job.ts）的数据库与接口测试：
// - 招标、投标文件逐个在沙箱中解析（保留图片、要求逐文档提取），写入正文与图片产物，四类分析经 saveAnalysisSection 写入；
// - 目录、正文的招标原文白名单，重复组、重复句、重复图片（按图片内容的哈希）与位置；
// - 已全部成功时不重复分析、force 重新分析并替换旧产物；单个文件解析失败、提取结果不合规、招标文件失败时继续；
// - 写入带开始时的签名，重新选择文件后写入被拒绝；暂停、中断时不改写结果，任务结束而结果仍是 running 时按未完成显示；
// - 接口：开始分析的前置检查与互斥，重新选择文件、清空后取消任务，状态中返回最近的任务；
// - 经 worker（真实 Valkey）从接口入队到执行完成的完整流程。
// 沙箱用桩：输出由测试按 Markdown 现算（逐文档提取用 server/sandbox/parse/duplicateText.mjs 本身，HTML 表格不在这里测），
// 解析入口与提取在真实沙箱中的结果由 tests/sandbox/docker/parse.test.ts 覆盖。
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeDuplicateCheckDocument } from '../../sandbox/parse/duplicateText.mjs';
import { findArtifact } from '../../src/artifacts/store.ts';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { createDuplicateAnalysisJob, DUPLICATE_ANALYSIS_JOB_TYPE, type DuplicateAnalysisParams } from '../../src/duplicateCheck/job.ts';
import { loadDuplicateCheck, saveFiles, type DuplicateCheckState } from '../../src/duplicateCheck/store.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { JobError, JobInterruptedError, type JobContext } from '../../src/jobs/definitions.ts';
import { createJobDispatcher } from '../../src/jobs/queue.ts';
import { jobTypeRegistry } from '../../src/jobs/registry.ts';
import { createJobRunner } from '../../src/jobs/runner.ts';
import { bullmqConnection } from '../../src/redis.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';
import type { SandboxDriver, SandboxExecResult, SandboxRef } from '../../src/sandbox/driver.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { redisConfig, testLogger, uniquePrefix, waitFor } from './jobFixtures.ts';

const PASSWORD = 'quiet-harbor-maple-67';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const png = (seed: string) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(seed, 'utf8')]);
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

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

// ---- 沙箱桩：按放入的原件给出解析输出 ----

interface Document {
  markdown: string;
  images?: Array<{ path: string; data: Buffer }>;
  /** 改写 analysis.json（构造不合规的提取结果）。 */
  analysis?: (analysis: Record<string, any>) => unknown;
  /** 只提取元数据时（metadata=duplicate-check）的 metadata.json 内容；默认见 defaultMetadata。'timeout' 为执行超时。 */
  metadata?: unknown;
}

/** 默认的文档格式元数据：每份文件的标题不同，公司相同（两份投标文件的“公司”一行成为重复项）。 */
function defaultMetadata(source: string): unknown {
  return { version: 1, fields: [['title', `标题 ${source}`], ['company', '某某科技有限公司'], ['custom:KSOProductBuildVer', '2052-11.1.0.12313']] };
}

/** hang：执行到中止为止（afterMetadata 时只提取元数据的执行照常给出默认元数据，正文解析时才挂起）。 */
type Behavior = { kind: 'document'; document: Document } | { kind: 'exit'; code: string } | { kind: 'hang'; afterMetadata?: boolean };

interface FakeSandbox extends SandboxDriver {
  calls: string[];
  inputs: SandboxFile[][];
  /** exec 开始时调用（测试用来在执行中改变状态或中止）。 */
  onExec?: (source: string) => Promise<void> | void;
}

/** 原件内容 → 解析输出。原件内容就是一个键（测试中的 source 字符串）。 */
function fakeSandbox(behaviors: Record<string, Behavior>): FakeSandbox {
  const sources = new Map<string, string>();
  const metadataMode = new Set<string>();
  const fake: FakeSandbox = {
    calls: [],
    inputs: [],
    async create(template, options) {
      fake.calls.push('create');
      return { id: randomUUID(), template, jobId: options.jobId, expiresAt: new Date(Date.now() + 60_000) };
    },
    async copyIn(sandbox, input) {
      // 解析只放入内存中的文件。
      const files = input as readonly SandboxFile[];
      fake.calls.push('copyIn');
      fake.inputs.push([...files]);
      sources.set(sandbox.id, files.find((file) => file.path === 'source')!.data.toString('utf8'));
    },
    async exec(sandbox, command, args, options = {}): Promise<SandboxExecResult> {
      fake.calls.push(`exec:${command} ${args.join(' ')}`);
      const source = sources.get(sandbox.id)!;
      if (args.includes('metadata=duplicate-check')) metadataMode.add(sandbox.id);
      await fake.onExec?.(source);
      const base = { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false };
      const behavior = behaviors[source];
      if (!behavior) throw new Error(`no behavior for ${source}`);
      if (metadataMode.has(sandbox.id) && behavior.kind === 'document' && behavior.document.metadata === 'timeout') return { ...base, exitCode: null, timedOut: true };
      if (metadataMode.has(sandbox.id) && behavior.kind === 'hang' && behavior.afterMetadata) return { ...base, exitCode: 0 };
      if (behavior.kind === 'exit') return { ...base, exitCode: 65, stdout: `${JSON.stringify({ error: behavior.code })}\n` };
      if (behavior.kind === 'hang') {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        const { SandboxError } = await import('../../src/sandbox/driver.ts');
        throw new SandboxError('SANDBOX_ABORTED', '沙箱操作已中止');
      }
      return { ...base, exitCode: 0 };
    },
    async copyOut(sandbox) {
      fake.calls.push('copyOut');
      const behavior = behaviors[sources.get(sandbox.id)!];
      if (metadataMode.has(sandbox.id) && behavior?.kind === 'hang') return [{ path: 'metadata.json', data: Buffer.from(JSON.stringify(defaultMetadata(sources.get(sandbox.id)!)), 'utf8') }];
      if (behavior?.kind !== 'document') throw new Error('copyOut without output');
      const { document } = behavior;
      if (metadataMode.has(sandbox.id)) {
        return [{ path: 'metadata.json', data: Buffer.from(JSON.stringify(document.metadata ?? defaultMetadata(sources.get(sandbox.id)!)), 'utf8') }];
      }
      const images = document.images ?? [];
      const title = fake.inputs.at(-1)!.find((file) => file.path === 'title')?.data.toString('utf8');
      const source = (title ? `# ${title}\n\n${document.markdown}` : document.markdown).trim();
      let analysis: unknown = analyzeDuplicateCheckDocument(source, () => []);
      if (document.analysis) analysis = document.analysis(analysis as Record<string, any>);
      return [
        { path: 'content.md', data: Buffer.from(document.markdown, 'utf8') },
        { path: 'manifest.json', data: Buffer.from(JSON.stringify({ version: 1, images: images.map(({ path }) => ({ path, mime: 'image/png' })) })) },
        ...images,
        { path: 'analysis.json', data: Buffer.from(JSON.stringify(analysis), 'utf8') },
      ];
    },
    async destroy(sandbox: SandboxRef) {
      fake.calls.push(`destroy:${sandbox.id.length}`);
    },
  };
  return fake;
}

// ---- 测试文档 ----

const TENDER = `# 招标文件

## 1 技术要求

投标人须提供不少于三年的质保服务，并承担全部运输费用。

项目名称：消防装备管理系统项目
`;

const LOGO = png('logo');
const SHARED_SENTENCE = '我方承诺在合同签订后三十日内完成全部部署工作。';

function bidMarkdown(variant: string): string {
  return `# 投标文件

## 1 项目概述

本项目采用${variant}架构建设统一管理平台，覆盖全部业务环节。

![公司标志](images/image-0001.png)

## 2 实施方案

${SHARED_SENTENCE}

投标人须提供不少于三年的质保服务，并承担全部运输费用。

### 2.1 ${variant}专项安排

${variant}团队负责现场实施与培训。
`;
}

const DOCUMENTS: Record<string, Behavior> = {
  tender: { kind: 'document', document: { markdown: TENDER } },
  bidA: { kind: 'document', document: { markdown: bidMarkdown('分布式'), images: [{ path: 'images/image-0001.png', data: LOGO }] } },
  bidB: { kind: 'document', document: { markdown: bidMarkdown('集中式'), images: [{ path: 'images/image-0001.png', data: LOGO }] } },
};

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

async function newProject(member: Member): Promise<string> {
  const row = await superuser.insertInto('projects').values({ org_id: member.orgId, kind: 'duplicate-check', name: '标书查重', created_by: member.userId }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

/** 登记一个已上传的标书查重文件，原件内容是 source（沙箱桩按它给出输出）。 */
async function newFile(member: Member, source: string, options: { name?: string; mime?: string; extension?: string; sha?: string } = {}): Promise<string> {
  const content = Buffer.from(source, 'utf8');
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      purpose: 'duplicate-check',
      display_name: options.name ?? `${source}.docx`,
      extension: options.extension ?? 'docx',
      status: 'uploaded',
      mime: options.mime ?? DOCX_MIME,
      size_bytes: content.length,
      sha256: Buffer.from(options.sha ?? sha256(source), 'hex'),
      uploaded_at: new Date(),
      created_by: member.userId,
    })
    .returning(['id', 'storage_key'])
    .executeTakeFirstOrThrow();
  objects.set(row.storage_key, content);
  return row.id;
}

interface Fixture {
  projectId: string;
  tender: string;
  bidA: string;
  bidB: string;
}

async function fixture(member: Member, sources: { tender?: string[]; bids?: string[] } = {}): Promise<Fixture & { tenders: string[]; bids: string[] }> {
  const projectId = await newProject(member);
  const tenders = [];
  for (const source of sources.tender ?? ['tender']) tenders.push(await newFile(member, source));
  const bids = [];
  for (const source of sources.bids ?? ['bidA', 'bidB']) bids.push(await newFile(member, source));
  await saveFiles(appDb, member.context, projectId, { tenderFileIds: tenders, bidFileIds: bids, step: 'analysis' });
  return { projectId, tender: tenders[0]!, bidA: bids[0]!, bidB: bids[1]!, tenders, bids };
}

function call(member: Member, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const job = createDuplicateAnalysisJob({ createRetryDelaysMs: [5] });

interface RunOptions {
  force?: boolean;
  sandbox?: SandboxDriver;
  objectStore?: ObjectStore;
  controller?: AbortController;
  /** setProgress 时报告租约已丢失。 */
  leaseLost?: boolean;
}

/** 以给定的上下文直接执行任务类型的 run（不经队列）。 */
async function runAnalysis(member: Member, projectId: string, options: RunOptions = {}): Promise<{ error: unknown; logs: string[] }> {
  const logs: string[] = [];
  const controller = options.controller ?? new AbortController();
  const context: JobContext<DuplicateAnalysisParams> = {
    jobId: randomUUID(),
    projectId,
    type: DUPLICATE_ANALYSIS_JOB_TYPE,
    attempt: 1,
    params: job.parseParams({ force: options.force ?? false }),
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
        throw new Error('duplicate-check jobs do not call models');
      },
    },
    objectStore: options.objectStore ?? memoryStore,
    sandbox: options.sandbox ?? fakeSandbox(DOCUMENTS),
    agentWorkspace: null,
  };
  try {
    await job.run(context);
    return { error: null, logs };
  } catch (error) {
    return { error, logs };
  }
}

const load = (member: Member, projectId: string) => loadDuplicateCheck(appDb, member.context, projectId);

async function artifactText(member: Member, artifactId: string): Promise<string> {
  const artifact = await findArtifact(appDb, member.context, artifactId);
  expect(artifact).not.toBeNull();
  return objects.get(artifact!.storageKey)!.toString('utf8');
}

async function liveArtifacts(fileId: string): Promise<Array<{ id: string; kind: string; project_id: string }>> {
  return superuser.selectFrom('artifacts').select(['id', 'kind', 'project_id']).where('source_file_id', '=', fileId).where('superseded_at', 'is', null).orderBy('created_at').execute();
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

describe('分析任务', () => {
  it('逐个在沙箱中解析（保留图片、逐文档提取），写入正文产物，四类分析都完成', async () => {
    const member = await newMember();
    const { projectId, tender, bidA, bidB } = await fixture(member);
    const sandbox = fakeSandbox(DOCUMENTS);
    const { error, logs } = await runAnalysis(member, projectId, { sandbox });
    expect(error).toBeNull();
    expect(logs).toEqual(expect.arrayContaining(['开始执行标书查重分析。', '标书查重分析完成。']));
    // 一个文件一个沙箱，用完即毁；参数只有格式与选项。先为两份投标文件各开一个只提取元数据的沙箱（6.10b），再逐个解析正文。
    expect(sandbox.calls.filter((entry) => entry.startsWith('exec:'))).toEqual([
      ...Array(2).fill('exec:parse format=docx metadata=duplicate-check'),
      ...Array(3).fill('exec:parse format=docx images=1 analysis=duplicate-check'),
    ]);
    expect(sandbox.calls.filter((entry) => entry === 'create')).toHaveLength(5);
    expect(sandbox.calls.filter((entry) => entry.startsWith('destroy:'))).toHaveLength(5);
    expect(sandbox.inputs.map((files) => files.map((file) => file.path))).toEqual(Array(5).fill(['source']));

    const state = await load(member, projectId);
    const metadata = state.metadataAnalysis!;
    expect(metadata).toMatchObject({
      status: 'success',
      progress: 100,
      message: '元数据分析完成',
      signature: state.signature,
      contentExtraction: { status: 'success', completed: 3, total: 3 },
      metadataExtraction: { status: 'success', completed: 2, total: 2 },
    });
    // 读出时按文件 id 排序（5.8）。
    const contentFile = (fileId: string) => metadata.contentFiles.find((file) => file.fileId === fileId)!;
    expect([tender, bidA, bidB].map((fileId) => [contentFile(fileId).status, contentFile(fileId).parserLabel])).toEqual(Array(3).fill(['success', '本地解析']));
    // 正文产物：图片引用改写为产物地址，长度与哈希按写入的正文。
    const bidAContent = await artifactText(member, contentFile(bidA).contentArtifactId!);
    expect(bidAContent).toMatch(/!\[公司标志\]\(\/api\/artifacts\/[0-9a-f-]{36}\/content\)/);
    expect(contentFile(bidA).contentLength).toBe(bidAContent.trimEnd().length);
    const contentHash = await superuser.selectFrom('duplicate_check_files').select('content_hash').where('file_id', '=', bidA).executeTakeFirstOrThrow();
    expect(contentHash.content_hash).toBe(sha256(bidAContent.trimEnd()));
    // 元数据：文件基本信息（扩展名与桌面版相同带点）在前，之后是沙箱提取的文档格式元数据；两份投标文件的 SHA-256 不同、公司相同。
    expect(metadata.files.map((file) => file.metadata.map((item) => item.key))).toEqual(
      Array(2).fill(['file_name', 'extension', 'size', 'file_sha256', 'title', 'company', 'custom:KSOProductBuildVer']),
    );
    expect(metadata.files.find((file) => file.fileId === bidA)!.metadata.find((item) => item.key === 'title')).toMatchObject({ label: '标题', value: '标题 bidA', comparable: true });
    expect(metadata.rows.find((row) => row.key === 'company')!.duplicateFileIds).toEqual([bidA, bidB]);
    expect(metadata.rows.find((row) => row.key === 'custom:KSOProductBuildVer')).toMatchObject({ label: '自定义：KSOProductBuildVer', duplicateFileIds: [bidA, bidB] });
    expect(metadata.rows.find((row) => row.key === 'title')!.duplicateFileIds).toEqual([]);
    expect(metadata.files[0]!.metadata).toEqual(
      expect.arrayContaining([
        { key: 'file_name', label: '文件名', value: 'bidA.docx', normalized: 'bida.docx', dateDay: null, comparable: false, dateComparable: false },
        expect.objectContaining({ key: 'extension', value: '.docx' }),
        expect.objectContaining({ key: 'file_sha256', value: sha256('bidA'), comparable: true }),
      ]),
    );
    expect(metadata.rows.find((row) => row.key === 'file_sha256')!.duplicateFileIds).toEqual([]);

    // 目录：招标原文中的标题不参与比对；两份投标文件同一路径的目录项成组。
    const outline = state.outlineAnalysis!;
    expect(outline).toMatchObject({ status: 'success', progress: 100, message: '目录分析完成', extraction: { status: 'success', completed: 2, total: 2 } });
    expect(outline.files.map((file) => [file.fileId, file.status, file.source])).toEqual([
      [bidA, 'success', 'heading'],
      [bidB, 'success', 'heading'],
    ]);
    expect(outline.files[0]!.items.map((item) => [item.title, item.level, item.parentId])).toEqual([
      ['投标文件', 1, null],
      ['项目概述', 2, 'O00001'],
      ['实施方案', 2, 'O00001'],
      ['分布式专项安排', 3, 'O00003'],
    ]);
    expect(outline.duplicateGroups.map((group) => [group.type, group.title, group.score, group.fileIds])).toEqual([
      ['duplicate', '投标文件', 1, [bidA, bidB]],
      ['duplicate', '投标文件 > 项目概述', 1, [bidA, bidB]],
      ['duplicate', '投标文件 > 实施方案', 1, [bidA, bidB]],
    ]);
    expect(outline.pairwiseSimilarities).toEqual([
      expect.objectContaining({ fileAId: bidA, fileBId: bidB, sharedCount: 3, risk: 'high' }),
    ]);

    // 正文：来自招标原文的句子不参与比对；两份共有的句子是重复句。
    const content = state.contentAnalysis!;
    expect(content).toMatchObject({ status: 'success', progress: 100, message: '正文比对完成', tenderMatchedSentenceCount: 2 });
    expect(content.tenderSentenceCount).toBeGreaterThan(0);
    expect(content.duplicateSentences.map((item) => [item.id, item.sentence, item.fileIds, item.occurrences])).toEqual([
      ['S000001', SHARED_SENTENCE, [bidA, bidB], { [bidA]: 1, [bidB]: 1 }],
    ]);

    // 图片：内容相同的图片按哈希成组，预览图是第一份文件中的图片产物，记下位置。
    const image = state.imageAnalysis!;
    expect(image).toMatchObject({ status: 'success', message: '图片比对完成', totalImageCount: 2 });
    expect([bidA, bidB].map((fileId) => image.files.find((file) => file.fileId === fileId)).map((file) => [file!.status, file!.imageCount, file!.uniqueImageCount])).toEqual([
      ['success', 1, 1],
      ['success', 1, 1],
    ]);
    expect(image.duplicateImages).toEqual([
      {
        id: 'I000001',
        hash: sha256(LOGO),
        previewArtifactId: expect.any(String),
        fileIds: [bidA, bidB],
        occurrences: { [bidA]: 1, [bidB]: 1 },
        locations: {
          [bidA]: [{ imageIndex: 1, directory: '投标文件 > 1 项目概述', previousSentence: '本项目采用分布式架构建设统一管理平台，覆盖全部业务环节' }],
          [bidB]: [{ imageIndex: 1, directory: '投标文件 > 1 项目概述', previousSentence: '本项目采用集中式架构建设统一管理平台，覆盖全部业务环节' }],
        },
      },
    ]);
    const preview = await findArtifact(appDb, member.context, image.duplicateImages[0]!.previewArtifactId!);
    expect(preview).toMatchObject({ kind: 'image', sourceFileId: bidA, projectId });
    expect(objects.get(preview!.storageKey)).toEqual(LOGO);
  });

  it('已有当前签名下全部成功的结果时不重复分析；force 时重新分析，之前的产物标为已被替换', async () => {
    const member = await newMember();
    const { projectId, bidA } = await fixture(member);
    expect((await runAnalysis(member, projectId)).error).toBeNull();
    const before = await liveArtifacts(bidA);
    expect(before.map((row) => row.kind).sort()).toEqual(['image', 'markdown']);

    const sandbox = fakeSandbox(DOCUMENTS);
    const skipped = await runAnalysis(member, projectId, { sandbox });
    expect(skipped.error).toBeNull();
    expect(skipped.logs).toEqual(['标书查重分析已完成，无需重复分析。']);
    expect(sandbox.calls).toEqual([]);

    const forced = await runAnalysis(member, projectId, { force: true, sandbox });
    expect(forced.error).toBeNull();
    expect(forced.logs[0]).toBe('开始重新执行标书查重分析。');
    const after = await liveArtifacts(bidA);
    expect(after).toHaveLength(2);
    expect(after.map((row) => row.id).filter((id) => before.some((old) => old.id === id))).toEqual([]);
    const state = await load(member, projectId);
    expect(state.metadataAnalysis!.contentFiles.find((file) => file.fileId === bidA)!.contentArtifactId).toBe(after.find((row) => row.kind === 'markdown')!.id);
  });

  it('没有投标文件时失败', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const tender = await newFile(member, 'tender');
    await saveFiles(appDb, member.context, projectId, { tenderFileIds: [tender], bidFileIds: [] });
    const { error } = await runAnalysis(member, projectId);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: 'DUPLICATE_CHECK_BID_MISSING', message: '请先上传至少一份投标文件' });
  });

  it('单个投标文件解析失败：记下原因，其余文件照常比对，任务以部分失败结束；写了一半的产物不保留', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member, { bids: ['bidA', 'broken', 'bidB'] });
    const [bidA, broken, bidB] = bids as [string, string, string];
    const { error, logs } = await runAnalysis(member, projectId, {
      sandbox: fakeSandbox({ ...DOCUMENTS, broken: { kind: 'exit', code: 'zip_ratio' } }),
    });
    expect(error).toMatchObject({ code: 'DUPLICATE_CHECK_PARTIAL_FAILED', message: '标书查重分析完成，部分结果失败' });
    expect(logs).toEqual(expect.arrayContaining(['正文提取失败：文件的压缩比异常（单个条目超过 100:1），已拒绝解析', '标书查重分析完成，部分结果失败。']));
    const state = await load(member, projectId);
    expect(state.metadataAnalysis).toMatchObject({ status: 'error', message: '部分文件提取失败', contentExtraction: { status: 'error', completed: 4, total: 4 } });
    expect(state.metadataAnalysis!.contentFiles.find((file) => file.fileId === broken)).toMatchObject({
      status: 'error',
      contentArtifactId: null,
      error: '文件的压缩比异常（单个条目超过 100:1），已拒绝解析',
    });
    expect(state.outlineAnalysis).toMatchObject({ status: 'error', message: '部分文件目录分析失败' });
    expect(state.outlineAnalysis!.files.find((file) => file.fileId === broken)).toMatchObject({ status: 'error', error: '正文内容尚未成功提取，无法进行目录分析', items: [] });
    expect(state.imageAnalysis).toMatchObject({ status: 'error', message: '部分文件图片比对失败' });
    expect(state.imageAnalysis!.files.find((file) => file.fileId === broken)).toMatchObject({ status: 'error', imageCount: 0 });
    // 正文比对与桌面版相同仍是成功，其余两份照常比对。
    expect(state.contentAnalysis).toMatchObject({ status: 'success' });
    expect(state.contentAnalysis!.duplicateSentences.map((item) => item.fileIds)).toEqual([[bidA, bidB]]);
    expect(await liveArtifacts(broken)).toEqual([]);
  });

  it('写产物时出现程序错误：该文件记为“正文提取失败”，已写入的产物标为已被替换，其余照常，原错误交给执行者', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member, { bids: ['bidA', 'storage', 'bidB'] });
    const storage = bids[1]!;
    const failing: ObjectStore = {
      ...memoryStore,
      async put(key, body, options) {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        const data = Buffer.concat(chunks);
        if (data.includes('STORAGE-FAILURE')) throw new Error('object store is down');
        return memoryStore.put(key, Readable.from([data]), options);
      },
    };
    const document = { markdown: `${bidMarkdown('存储故障')}\nSTORAGE-FAILURE\n`, images: [{ path: 'images/image-0001.png', data: png('other') }] };
    const { error } = await runAnalysis(member, projectId, { objectStore: failing, sandbox: fakeSandbox({ ...DOCUMENTS, storage: { kind: 'document', document } }) });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('object store is down');
    const state = await load(member, projectId);
    expect(state.metadataAnalysis!.contentFiles.find((file) => file.fileId === storage)).toMatchObject({ status: 'error', error: '正文提取失败' });
    // 图片已写入、正文写入失败：图片产物标为已被替换。
    expect(await superuser.selectFrom('artifacts').select('kind').where('source_file_id', '=', storage).where('superseded_at', 'is not', null).execute()).toEqual([{ kind: 'image' }]);
    expect(await liveArtifacts(storage)).toEqual([]);
    expect(state.contentAnalysis!.duplicateSentences.map((item) => item.fileIds)).toEqual([[bids[0], bids[2]]]);
  });

  it('逐文档提取结果不合规时按解析失败处理，不写产物', async () => {
    const member = await newMember();
    const outsideImage = (analysis: Record<string, any>) => ({ ...analysis, images: [{ path: 'images/image-0009.png', index: 1, directory: '', previousSentence: '' }] });
    const cases: Array<(analysis: Record<string, any>) => unknown> = [
      outsideImage,
      (analysis) => ({ ...analysis, extra: true }),
      (analysis) => ({ ...analysis, outline: { ...analysis.outline, items: analysis.outline.items.map((item: any) => ({ ...item, parentId: item.level > 1 ? 'O09999' : null })) } }),
      (analysis) => ({ ...analysis, sentences: [{ sentence: 'x'.repeat(700), normalized: 'x' }] }),
    ];
    for (const analysis of cases) {
      const { projectId, bidB } = await fixture(member);
      const bad = { kind: 'document' as const, document: { ...(DOCUMENTS.bidB as { document: Document }).document, analysis } };
      const { error } = await runAnalysis(member, projectId, { sandbox: fakeSandbox({ ...DOCUMENTS, bidB: bad }) });
      expect(error).toMatchObject({ code: 'DUPLICATE_CHECK_PARTIAL_FAILED' });
      const state = await load(member, projectId);
      expect(state.metadataAnalysis!.contentFiles.find((file) => file.fileId === bidB)).toMatchObject({ status: 'error', error: '解析结果不符合要求，已拒绝' });
      expect(await liveArtifacts(bidB)).toEqual([]);
    }
  });

  it('文档格式的元数据（6.10b）：沙箱记下的读取失败照常写入；超时、输出不合规时该文件记为失败并保留基本信息，正文照常提取', async () => {
    const member = await newMember();
    const { projectId, bids } = await fixture(member, { bids: ['bidA', 'unreadable', 'slow', 'forged', 'bidB'] });
    const [bidA, unreadable, slow, forged, bidB] = bids as [string, string, string, string, string];
    const document = (variant: string, metadata: unknown): Behavior => ({
      kind: 'document',
      document: { markdown: bidMarkdown(variant), images: [{ path: 'images/image-0001.png', data: png(variant) }], metadata },
    });
    const sandbox = fakeSandbox({
      ...DOCUMENTS,
      unreadable: document('甲', { version: 1, fields: [['metadata_error', '元数据读取失败']] }),
      slow: document('乙', 'timeout'),
      // 冒充文件基本信息的键：整份输出被拒绝。
      forged: document('丙', { version: 1, fields: [['title', '标题'], ['file_sha256', sha256('bidA')]] }),
    });
    const { error, logs } = await runAnalysis(member, projectId, { sandbox });
    expect(error).toMatchObject({ code: 'DUPLICATE_CHECK_PARTIAL_FAILED' });
    expect(logs).toEqual(expect.arrayContaining(['元数据提取失败：文件解析超时（超过 10 分钟）', '元数据提取失败：解析结果不符合要求，已拒绝']));
    const state = await load(member, projectId);
    const metadata = state.metadataAnalysis!;
    expect(metadata).toMatchObject({
      status: 'error',
      message: '部分文件提取失败',
      metadataExtraction: { status: 'error', completed: 5, total: 5 },
      contentExtraction: { status: 'success', completed: 6, total: 6 },
    });
    const file = (fileId: string) => metadata.files.find((item) => item.fileId === fileId)!;
    // 文档本身读取失败（沙箱记为 metadata_error）不算该文件失败，与桌面版相同。
    expect(file(unreadable)).toMatchObject({ status: 'success', error: null });
    expect(file(unreadable).metadata.find((item) => item.key === 'metadata_error')).toMatchObject({ label: 'metadata error', value: '元数据读取失败' });
    expect(file(slow)).toMatchObject({ status: 'error', error: '文件解析超时（超过 10 分钟）' });
    expect(file(slow).metadata.map((item) => item.key)).toEqual(['file_name', 'extension', 'size', 'file_sha256']);
    expect(file(forged)).toMatchObject({ status: 'error', error: '解析结果不符合要求，已拒绝' });
    expect(file(forged).metadata.find((item) => item.key === 'file_sha256')!.value).toBe(sha256('forged'));
    expect(file(forged).metadata.some((item) => item.key === 'title')).toBe(false);
    expect([...metadata.rows.find((row) => row.key === 'company')!.duplicateFileIds].sort()).toEqual([bidA, bidB].sort());
    // 正文、目录照常。
    expect(metadata.contentFiles.every((item) => item.status === 'success')).toBe(true);
    expect(state.outlineAnalysis).toMatchObject({ status: 'success' });
  });

  it('元数据阶段暂停：不改写结果，正文不开始解析', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const controller = new AbortController();
    const sandbox = fakeSandbox({ ...DOCUMENTS, bidA: { kind: 'hang' } });
    sandbox.onExec = (source) => {
      if (source === 'bidA') setTimeout(() => controller.abort('pause'), 20);
    };
    const { error } = await runAnalysis(member, projectId, { sandbox, controller });
    expect(error).toBeInstanceOf(JobInterruptedError);
    expect(sandbox.calls.filter((entry) => entry.startsWith('exec:'))).toEqual(['exec:parse format=docx metadata=duplicate-check']);
    expect(sandbox.calls.filter((entry) => entry.startsWith('destroy:'))).toHaveLength(1);
    const stored = await superuser.selectFrom('duplicate_check_analysis_sections').select(['section', 'status']).where('project_id', '=', projectId).orderBy('section').execute();
    expect(Object.fromEntries(stored.map((row: { section: string; status: string }) => [row.section, row.status]))).toEqual({ metadata: 'running', outline: 'pending', content: 'pending', image: 'pending' });
  });

  it('招标文件解析失败时不用白名单，继续比对（与桌面版相同）', async () => {
    const member = await newMember();
    const { projectId, bidA, bidB } = await fixture(member, { tender: ['broken'] });
    const { error } = await runAnalysis(member, projectId, { sandbox: fakeSandbox({ ...DOCUMENTS, broken: { kind: 'exit', code: 'pdf_invalid' } }) });
    expect(error).toMatchObject({ code: 'DUPLICATE_CHECK_PARTIAL_FAILED' });
    const state = await load(member, projectId);
    expect(state.metadataAnalysis).toMatchObject({ status: 'error' });
    expect(state.outlineAnalysis).toMatchObject({ status: 'success', tenderSentenceCount: 0 });
    expect(state.contentAnalysis).toMatchObject({ status: 'success', tenderSentenceCount: 0, tenderMatchedSentenceCount: 0 });
    // 没有白名单：来自招标文件的句子也算重复句。
    expect(state.contentAnalysis!.duplicateSentences.map((item) => item.sentence)).toEqual(
      expect.arrayContaining([SHARED_SENTENCE, '投标人须提供不少于三年的质保服务，并承担全部运输费用。']),
    );
    expect(state.contentAnalysis!.duplicateSentences.every((item) => item.fileIds.join() === [bidA, bidB].join())).toBe(true);
  });

  it('表格类文件：文件名经 title 交给沙箱（与桌面版相同作一级标题），正文产物同样带标题', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const sheetA = await newFile(member, 'sheetA', { name: '报价表\n甲.xlsx', mime: XLSX_MIME, extension: 'xlsx' });
    const sheetB = await newFile(member, 'sheetB', { name: '报价表乙.xlsx', mime: XLSX_MIME, extension: 'xlsx' });
    await saveFiles(appDb, member.context, projectId, { tenderFileIds: [], bidFileIds: [sheetA, sheetB] });
    const sheet = (rows: string) => ({ kind: 'document' as const, document: { markdown: `## 工作表：报价\n\n| 名称 | 说明 |\n|---|---|\n| 服务器 | ${rows} |\n` } });
    const sandbox = fakeSandbox({ sheetA: sheet('采用国产化服务器保证系统长期稳定运行。'), sheetB: sheet('采用国产化服务器保证系统长期稳定运行。') });
    expect((await runAnalysis(member, projectId, { sandbox })).error).toBeNull();
    // 表格类文件没有文档格式的元数据，不开只提取元数据的沙箱（与桌面版相同只有文件基本信息）。
    expect(sandbox.calls.filter((entry) => entry.startsWith('exec:'))).toEqual(Array(2).fill('exec:parse format=xlsx images=1 analysis=duplicate-check'));
    expect(sandbox.inputs[0]!.map((file) => [file.path, file.data.toString('utf8')])).toEqual([
      ['source', 'sheetA'],
      ['title', '报价表 甲.xlsx'],
    ]);
    const state = await load(member, projectId);
    expect(state.outlineAnalysis!.files[0]!.items.map((item) => [item.title, item.level])).toEqual([
      ['报价表 甲.xlsx', 1],
      // 标题经 NFKC 规范化（与桌面版相同），全角冒号变为半角。
      ['工作表:报价', 2],
    ]);
    // 读出时按首次出现的顺序（与桌面版的存储相同）。
    expect(state.contentAnalysis!.duplicateSentences.map((item) => item.sentence)).toEqual(['工作表：报价', '采用国产化服务器保证系统长期稳定运行。']);
    expect(await artifactText(member, state.metadataAnalysis!.contentFiles.find((file) => file.fileId === sheetA)!.contentArtifactId!)).toMatch(/^# 报价表 甲\.xlsx\n\n## 工作表：报价/);
  });

  it('任务开始后重新选择文件：写入被拒绝，新的选择不被旧任务覆盖', async () => {
    const member = await newMember();
    const { projectId, bidA } = await fixture(member);
    const sandbox = fakeSandbox(DOCUMENTS);
    let changed = false;
    sandbox.onExec = async (source) => {
      if (source !== 'bidA' || changed) return;
      changed = true;
      await saveFiles(appDb, member.context, projectId, { tenderFileIds: [], bidFileIds: [bidA] });
    };
    const { error, logs } = await runAnalysis(member, projectId, { sandbox });
    expect(error).toMatchObject({ code: 'DUPLICATE_CHECK_INPUT_CHANGED', message: '文件选择已变化，本次分析结果已丢弃，请重新分析' });
    expect(logs).toContain('文件选择已变化，本次分析结果已丢弃');
    const state = await load(member, projectId);
    expect([state.metadataAnalysis, state.outlineAnalysis, state.contentAnalysis, state.imageAnalysis]).toEqual([null, null, null, null]);
  });

  it('暂停、中断时不改写结果；任务已结束而结果仍是 running 时按未完成显示', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const controller = new AbortController();
    const sandbox = fakeSandbox({ ...DOCUMENTS, bidB: { kind: 'hang', afterMetadata: true } });
    let bidBExecs = 0;
    sandbox.onExec = (source) => {
      // 第二次执行是正文解析（第一次是只提取元数据）。
      if (source === 'bidB' && ++bidBExecs === 2) setTimeout(() => controller.abort('pause'), 20);
    };
    const { error } = await runAnalysis(member, projectId, { sandbox, controller });
    expect(error).toBeInstanceOf(JobInterruptedError);
    // 没有进行中的任务：running 的分析按未完成显示（只改读出的状态）。
    let state = await load(member, projectId);
    expect(state.metadataAnalysis).toMatchObject({ status: 'error', progress: 100, message: '上次标书查重分析未完成，请重新分析' });
    expect(state.outlineAnalysis).toMatchObject({ status: 'error', message: '上次标书查重分析未完成，请重新分析' });
    const stored = await superuser.selectFrom('duplicate_check_analysis_sections').select(['section', 'status']).where('project_id', '=', projectId).orderBy('section').execute();
    expect(stored.map((row: { status: string }) => row.status)).toEqual(['running', 'running', 'running', 'running']);
    // 有暂停中的任务：仍是 running。
    await superuser
      .insertInto('jobs')
      .values({ org_id: member.orgId, user_id: member.userId, project_id: projectId, type: DUPLICATE_ANALYSIS_JOB_TYPE, status: 'paused', params: JSON.stringify({ force: false }) })
      .execute();
    state = await load(member, projectId);
    expect(state.metadataAnalysis).toMatchObject({ status: 'running' });
    expect(state.analysisTask).toMatchObject({ type: DUPLICATE_ANALYSIS_JOB_TYPE, status: 'paused' });

    // 租约丢失（setProgress 报告）同样不改写。
    const other = await fixture(member);
    const lost = await runAnalysis(member, other.projectId, { leaseLost: true });
    expect(lost.error).toBeInstanceOf(JobInterruptedError);
  });
});

describe('接口', () => {
  it('开始分析：202 返回任务；没有投标文件 409；已有进行中的任务 409 JOB_LOCKED；状态中返回最近的任务', async () => {
    const member = await newMember();
    const empty = await newProject(member);
    const missing = await call(member, 'POST', `/api/projects/${empty}/duplicate-check/analysis`, {});
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ error: { code: 'DUPLICATE_CHECK_BID_MISSING', message: '请先上传至少一份投标文件' } });

    const { projectId } = await fixture(member);
    const started = await call(member, 'POST', `/api/projects/${projectId}/duplicate-check/analysis`);
    expect(started.statusCode, started.body).toBe(202);
    const jobBody = started.json().job;
    expect(jobBody).toMatchObject({ type: DUPLICATE_ANALYSIS_JOB_TYPE, projectId, status: 'queued' });
    const row = await superuser.selectFrom('jobs').select(['lock_key', 'params']).where('id', '=', jobBody.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ lock_key: `project:${projectId}:duplicate-check`, params: { force: false } });

    const again = await call(member, 'POST', `/api/projects/${projectId}/duplicate-check/analysis`, { force: true });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'JOB_LOCKED' } });
    expect((await call(member, 'POST', `/api/projects/${projectId}/duplicate-check/analysis`, { force: 'yes' })).statusCode).toBe(400);

    const state = (await call(member, 'GET', `/api/projects/${projectId}/duplicate-check`)).json() as DuplicateCheckState;
    expect(state.analysisTask).toMatchObject({ id: jobBody.id, status: 'queued' });

    // 其他组织的成员看不到这个项目。
    const outsider = await newMember();
    expect((await call(outsider, 'POST', `/api/projects/${projectId}/duplicate-check/analysis`)).statusCode).toBe(404);
  });

  it('重新选择文件、清空之后取消进行中的分析任务', async () => {
    const member = await newMember();
    const { projectId, bidA, bidB } = await fixture(member);
    const first = (await call(member, 'POST', `/api/projects/${projectId}/duplicate-check/analysis`)).json().job;
    const reselected = await call(member, 'PUT', `/api/projects/${projectId}/duplicate-check/files`, { tenderFileIds: [], bidFileIds: [bidA, bidB] });
    expect(reselected.statusCode, reselected.body).toBe(200);
    expect(await superuser.selectFrom('jobs').select('status').where('id', '=', first.id).executeTakeFirstOrThrow()).toEqual({ status: 'cancelled' });

    const second = (await call(member, 'POST', `/api/projects/${projectId}/duplicate-check/analysis`)).json().job;
    expect((await call(member, 'DELETE', `/api/projects/${projectId}/duplicate-check`)).statusCode).toBe(200);
    expect(await superuser.selectFrom('jobs').select('status').where('id', '=', second.id).executeTakeFirstOrThrow()).toEqual({ status: 'cancelled' });
  });
});

describe('经 worker 执行', () => {
  it('接口入队 → worker 认领执行（沙箱桩）→ 状态中返回结果与已完成的任务', async () => {
    const member = await newMember();
    const { projectId } = await fixture(member);
    const prefix = uniquePrefix();
    const logs = testLogger();
    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'duplicate-test-dispatch'), prefix });
    const runner = createJobRunner({
      db: appDb,
      registry: jobTypeRegistry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'duplicate-test-worker'),
      log: logs.log,
      prefix,
      reconcileIntervalMs: 300,
      objectStore: memoryStore,
      sandbox: fakeSandbox(DOCUMENTS),
    });
    try {
      await runner.start();
      const started = (await call(member, 'POST', `/api/projects/${projectId}/duplicate-check/analysis`)).json().job;
      const finished = await waitFor(async () => {
        const row = await superuser.selectFrom('jobs').select(['status', 'error_code']).where('id', '=', started.id).executeTakeFirst();
        return row && ['succeeded', 'failed', 'cancelled'].includes(row.status) ? row : null;
      }, 20_000, `job ${started.id} finished`);
      expect(finished).toEqual({ status: 'succeeded', error_code: null });
      const state = (await call(member, 'GET', `/api/projects/${projectId}/duplicate-check`)).json();
      expect(state).toMatchObject({
        metadataAnalysis: { status: 'success' },
        outlineAnalysis: { status: 'success' },
        contentAnalysis: { status: 'success' },
        imageAnalysis: { status: 'success' },
        analysisTask: { id: started.id, status: 'succeeded', progress: 100 },
      });
      const events = await superuser.selectFrom('job_events').select('message').where('job_id', '=', started.id).orderBy('id').execute();
      expect(events.map((event: { message: string | null }) => event.message)).toEqual(expect.arrayContaining(['开始执行标书查重分析。', '标书查重分析完成。']));
      // 导出：结果与当前文件选择一致。
      expect((await call(member, 'GET', `/api/projects/${projectId}/duplicate-check/export`)).statusCode).toBe(200);
    } finally {
      await runner.close();
      await dispatcher.close();
    }
  });
});
