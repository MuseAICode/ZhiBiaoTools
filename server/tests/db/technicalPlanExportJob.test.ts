// 技术方案整本导出任务（路线图 7.4g，src/export/documentJob.ts）的数据库测试。沙箱用桩（按真实规则生成并读回归档，
// 按需读取的配图在放入时才从对象存储读取），不需要 Docker；真实沙箱见 tests/sandbox/docker/exportDocument.test.ts。
// 1. 入队：取快照存为请求，新建项目级任务（export 队列、lock_key 按项目、参数只有请求 id）；入队成功后删除本项目的其他请求；
//    入队前就能确定的错误不保存、不入队；同一项目已有未结束的整本导出时 409，并删除刚保存的请求；
// 2. 执行：只把正文引用中本项目可见的图片产物放入沙箱（其他项目、其他组织、已被替换、不是图片、不存在的都不放），
//    asset_types 取产物表的 MIME；存为整本导出产物、汇总提示与消息并写回结果；已有结果时直接结束；
// 3. 失败：请求不存在或不属于任务的项目、没有对象存储、配图合计过大（不创建沙箱）、配图已被删除、超出存储配额、中止。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findArtifact, writeArtifact } from '../../src/artifacts/store.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { EXPORT_DONE_MESSAGE } from '../../src/export/documentHtml.ts';
import {
  createTechnicalPlanExportJob,
  enqueueTechnicalPlanExport,
  IMAGE_NOT_AVAILABLE_REASON,
  IMAGE_NOT_EMBEDDABLE_REASON,
  WEBP_CONVERT_FAILED_REASON,
  TECHNICAL_PLAN_EXPORT_JOB_TYPE,
  technicalPlanExportLockKey,
  type TechnicalPlanExportParams,
} from '../../src/export/documentJob.ts';
import { findTechnicalPlanExportRequest, saveTechnicalPlanExportRequest } from '../../src/export/documentRequestStore.ts';
import { findTechnicalPlanExport } from '../../src/export/documentStore.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import { JobError, JobInterruptedError, type JobContext } from '../../src/jobs/definitions.ts';
import { jobTypeRegistry } from '../../src/jobs/registry.ts';
import type { JobServiceDependencies } from '../../src/jobs/service.ts';
import { createArchiveStream, readArchive, type SandboxFile, type SandboxInputFile } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxExecResult } from '../../src/sandbox/driver.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { saveOutline } from '../../src/technicalPlan/store.ts';
import { syncSystemTemplates } from '../../src/templates/system.ts';
import { buildZip } from '../sandbox/zipFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const LIMITS = SANDBOX_TEMPLATES['export-document'].input;
const MIB = 1024 * 1024;
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);
const DOCX = buildZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
]);

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;

const objects = new Map<string, Buffer>();
const store: ObjectStore = {
  async put(key, body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
  },
  async get(key) {
    const content = objects.get(key);
    return content ? { body: Readable.from(content), size: content.length } : null;
  },
  async exists(key) {
    return objects.has(key);
  },
  async delete(key) {
    objects.delete(key);
  },
};

function deps(): JobServiceDependencies {
  return { db: appDb, registry: jobTypeRegistry, dispatcher: null, log: { warn() {} } };
}

async function newOrg(): Promise<TenantContext> {
  const orgId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  return newMember(orgId, 'owner');
}

async function newMember(orgId: string, role: 'owner' | 'member' = 'member'): Promise<TenantContext> {
  const userId = randomUUID();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { orgId, userId, role };
}

async function newProject(ctx: TenantContext, kind = 'technical-plan'): Promise<string> {
  return (await superuser.insertInto('projects')
    .values({ org_id: ctx.orgId, kind, name: '项目', created_by: ctx.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

async function fillUsage(orgId: string, bytes: number) {
  for (let left = bytes; left > 0; left -= DOCUMENT_MAX_BYTES) {
    await superuser.insertInto('files').values({
      org_id: orgId, purpose: 'tender', display_name: 'filler.pdf', extension: 'pdf', status: 'uploaded', mime: 'application/pdf',
      size_bytes: Math.min(left, DOCUMENT_MAX_BYTES), sha256: Buffer.alloc(32), created_by: randomUUID(), uploaded_at: new Date(),
    }).execute();
  }
}

/** 写一张属于项目的图片产物（与解析写入的相同种类）。 */
async function image(ctx: TenantContext, projectId: string, data: Buffer, mime = 'image/png'): Promise<string> {
  const name = mime === 'image/webp' ? 'image-001.webp' : 'image-001.png';
  return (await writeArtifact(appDb, ctx, store, { kind: 'image', name, mime, projectId }, data)).id;
}

const url = (id: string) => `/api/artifacts/${id}/content`;

/** 一个两节的目录：第一节引用给出的图片（每张一次），第二节是 AI 小节。 */
async function fillOutline(ctx: TenantContext, projectId: string, imageIds: readonly string[]) {
  const manual = randomUUID();
  await saveOutline(appDb, ctx, projectId, {
    reason: 'replace',
    outlineData: {
      project_name: '整本导出',
      outline: [
        { id: manual, title: '人工小节', content_mode: 'manual-fill' },
        { id: randomUUID(), title: 'AI 小节', content_mode: 'ai-generate' },
      ],
    },
  });
  const content = ['人工正文', ...imageIds.map((id, index) => `![图 ${index}](${url(id)})`)].join('\n\n');
  await superuser.updateTable('technical_plan_outline_nodes').set({ content }).where('project_id', '=', projectId).where('node_id', '=', manual).execute();
}

// ---- 沙箱桩 ----

function execResult(exitCode: number | null, stdout = ''): SandboxExecResult {
  return { exitCode, timedOut: false, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false };
}

/** 按真实规则生成并读回归档（按需读取的配图在这里才读取）；输出的 imageWarnings 由 warn 决定。 */
function fakeSandbox(options: { warn?: (assetIds: string[]) => string[]; onExec?: () => void } = {}) {
  const calls: string[] = [];
  let copied: SandboxFile[] = [];
  const driver: SandboxDriver = {
    async create(templateName, { jobId }) {
      calls.push(`create:${templateName}`);
      return { id: randomUUID(), template: templateName, jobId, expiresAt: new Date(Date.now() + 60_000) };
    },
    async copyIn(_ref, files: readonly SandboxInputFile[]) {
      calls.push('copyIn');
      const stream = createArchiveStream(files, LIMITS);
      try {
        copied = await readArchive(stream.chunks, LIMITS);
      } catch (error) {
        if (stream.failure && !(stream.failure instanceof SandboxError)) throw new SandboxError('SANDBOX_INPUT_FAILED', 'input failed', { cause: stream.failure });
        throw error;
      }
    },
    async exec(): Promise<SandboxExecResult> {
      calls.push('exec');
      options.onExec?.();
      return execResult(0);
    },
    async copyOut() {
      calls.push('copyOut');
      const request = JSON.parse(copied.find((file) => file.path === 'request.json')!.data.toString('utf8')) as { html: string };
      const referenced = [...request.html.matchAll(/data-app-asset-ref="([^"]+)"/g)].map((match) => match[1]!);
      const imageWarnings = (options.warn?.(referenced) ?? []).map((assetRef) => ({ assetRef, reason: '助手的原因文字' }));
      return [
        { path: 'document.docx', data: DOCX },
        { path: 'result.json', data: Buffer.from(JSON.stringify({ version: 1, blockCount: 7, imageWarnings })) },
      ];
    },
    async destroy() {
      calls.push('destroy');
    },
  };
  return { driver, calls, copied: () => copied };
}

const job = createTechnicalPlanExportJob({ createRetryDelaysMs: [5] });

interface RunOptions {
  projectId?: string | null;
  sandbox?: SandboxDriver | null;
  objectStore?: ObjectStore | null;
  controller?: AbortController;
}

/** 以给定的上下文直接执行任务类型的 run（不经队列）。 */
async function runExport(context: TenantContext, projectId: string, requestId: string, options: RunOptions = {}) {
  const logs: string[] = [];
  const progress: number[] = [];
  const controller = options.controller ?? new AbortController();
  const jobContext: JobContext<TechnicalPlanExportParams> = {
    jobId: randomUUID(),
    projectId: options.projectId === undefined ? projectId : options.projectId,
    type: TECHNICAL_PLAN_EXPORT_JOB_TYPE,
    attempt: 1,
    params: job.parseParams({ requestId }),
    checkpoint: null,
    tenant: context,
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
      async chat() {
        throw new Error('technical plan exports do not call models');
      },
    },
    objectStore: options.objectStore === undefined ? store : options.objectStore,
    sandbox: options.sandbox === undefined ? fakeSandbox().driver : options.sandbox,
    agentWorkspace: null,
  };
  try {
    await job.run(jobContext);
    return { error: null as unknown, logs, progress };
  } catch (error) {
    return { error, logs, progress };
  }
}

async function exportJobs(projectId: string) {
  return superuser.selectFrom('jobs').select(['id', 'status', 'lock_key', 'params']).where('project_id', '=', projectId)
    .where('type', '=', TECHNICAL_PLAN_EXPORT_JOB_TYPE).orderBy('created_at').execute();
}

async function requestIds(projectId: string): Promise<string[]> {
  return (await superuser.selectFrom('technical_plan_export_requests').select('id').where('project_id', '=', projectId).execute()).map((row: { id: string }) => row.id);
}

async function finishJobs(projectId: string) {
  await superuser.updateTable('jobs').set({ status: 'succeeded', finished_at: sql`now()` }).where('project_id', '=', projectId).execute();
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
  appDb = connect<Database>(testDb.appConfig, 20);
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

describe('任务类型', () => {
  it('export 队列、可续跑、不调用模型；参数只有请求 id', () => {
    const registered = jobTypeRegistry.get(TECHNICAL_PLAN_EXPORT_JOB_TYPE)!;
    expect(registered).toMatchObject({ queue: 'export', resumable: true });
    expect(registered.billable).toBeUndefined();
    const id = randomUUID();
    expect(registered.parseParams({ requestId: id })).toEqual({ requestId: id });
    for (const bad of [null, [], {}, { requestId: 'x' }, { requestId: id.toUpperCase() }, { requestId: id, extra: 1 }, { requestId: 1 }]) {
      expect(() => registered.parseParams(bad)).toThrow(TypeError);
    }
  });
});

describe('入队', () => {
  it('取快照存为请求，新建项目级任务（lock_key 按项目，参数只有请求 id）；成功后删除本项目的其他请求，其他项目的不动', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const otherProject = await newProject(ctx);
    await fillOutline(ctx, projectId, []);
    await fillOutline(ctx, otherProject, []);
    const old = await saveTechnicalPlanExportRequest(appDb, ctx, projectId);
    const others = await saveTechnicalPlanExportRequest(appDb, ctx, otherProject);

    const { job: queued, request } = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    expect(queued).toMatchObject({
      type: TECHNICAL_PLAN_EXPORT_JOB_TYPE, status: 'queued', projectId, userId: ctx.userId,
      lockKey: technicalPlanExportLockKey(projectId), params: { requestId: request.id },
    });
    expect(request.snapshot?.projectName).toBe('整本导出');
    expect(await requestIds(projectId)).toEqual([request.id]);
    expect(await findTechnicalPlanExportRequest(appDb, ctx, old.id)).toBeNull();
    expect(await requestIds(otherProject)).toEqual([others.id]);
  });

  it('入队前就能确定的错误：不保存、不入队', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await expect(enqueueTechnicalPlanExport(deps(), ctx, projectId)).rejects.toMatchObject({ statusCode: 400, code: 'EXPORT_EMPTY' });
    expect(await requestIds(projectId)).toEqual([]);
    expect(await exportJobs(projectId)).toEqual([]);
  });

  it('同一项目已有未结束的整本导出：409 JOB_LOCKED，删除刚保存的请求，原来的请求与任务不动；结束后可以再导出', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const projectId = await newProject(ctx);
    await fillOutline(ctx, projectId, []);
    const first = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    await expect(enqueueTechnicalPlanExport(deps(), colleague, projectId)).rejects.toMatchObject({ statusCode: 409, code: 'JOB_LOCKED' });
    expect(await requestIds(projectId)).toEqual([first.request.id]);
    expect((await exportJobs(projectId)).map((row: { id: string }) => row.id)).toEqual([first.job.id]);

    await finishJobs(projectId);
    const second = await enqueueTechnicalPlanExport(deps(), colleague, projectId);
    expect(await requestIds(projectId)).toEqual([second.request.id]);
  });

  it('不同项目的整本导出互不影响', async () => {
    const ctx = await newOrg();
    const a = await newProject(ctx);
    const b = await newProject(ctx);
    await fillOutline(ctx, a, []);
    await fillOutline(ctx, b, []);
    await enqueueTechnicalPlanExport(deps(), ctx, a);
    await enqueueTechnicalPlanExport(deps(), ctx, b);
    expect(await exportJobs(a)).toHaveLength(1);
    expect(await exportJobs(b)).toHaveLength(1);
  });
});

describe('执行', () => {
  it('只放入本项目可见的图片产物（asset_types 取产物表的 MIME），存为整本导出产物、汇总提示并写回结果', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const outsider = await newOrg();
    const projectId = await newProject(ctx);
    const otherProject = await newProject(ctx);
    const outsiderProject = await newProject(outsider);
    const png = Buffer.from('png image bytes');
    const webp = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ');
    const visiblePng = await image(ctx, projectId, png);
    const visibleWebp = await image(ctx, projectId, webp, 'image/webp');
    const ofOtherProject = await image(ctx, otherProject, Buffer.from('other project'));
    const ofOtherOrg = await image(outsider, outsiderProject, Buffer.from('other org'));
    const superseded = await image(ctx, projectId, Buffer.from('superseded'));
    // 已被替换（例如来源文件重新解析之后的旧图片，supersedeArtifacts 的效果）。
    await superuser.updateTable('artifacts').set({ superseded_at: sql`now()` }).where('id', '=', superseded).execute();
    const markdown = (await writeArtifact(appDb, ctx, store, { kind: 'markdown', name: 'content.md', mime: 'text/markdown; charset=utf-8', projectId }, Buffer.from('# x'))).id;
    const missing = randomUUID();
    const refs = [visiblePng, ofOtherProject, visibleWebp, ofOtherOrg, superseded, markdown, missing];
    await fillOutline(ctx, projectId, refs);
    const { request } = await enqueueTechnicalPlanExport(deps(), ctx, projectId);

    // 助手对每一处引用都返回提示：没有放入的、放入了但无法嵌入的 PNG、转换失败的 WebP（7.4i）各有各的原因。
    const sandbox = fakeSandbox({ warn: (referenced) => referenced });
    // 由同组织的同事执行（任务以发起用户的身份执行；这里证明可见性只按组织与项目，而不是按创建者）。
    const result = await runExport(colleague, projectId, request.id, { sandbox: sandbox.driver });
    expect(result.error).toBeNull();
    expect(sandbox.calls).toEqual(['create:export-document', 'copyIn', 'exec', 'copyOut', 'destroy']);
    expect(sandbox.copied().map((file) => file.path)).toEqual(['request.json', `assets/${visiblePng}`, `assets/${visibleWebp}`]);
    expect(sandbox.copied()[1]!.data.equals(png)).toBe(true);
    expect(sandbox.copied()[2]!.data.equals(webp)).toBe(true);
    const body = JSON.parse(sandbox.copied()[0]!.data.toString('utf8')) as { html: string; export_format: Record<string, unknown>; asset_types: Record<string, string> };
    expect(body.asset_types).toEqual({ [visiblePng]: 'image/png', [visibleWebp]: 'image/webp' });
    expect(body.export_format).toEqual(request.exportFormat);
    // HTML 中保留全部引用（顺序与正文相同），不可见的由助手原位提示。
    expect([...body.html.matchAll(/data-app-asset-ref="([^"]+)"/g)].map((match) => match[1])).toEqual(refs);
    expect(result.logs).toEqual(['开始导出 Word', 'Word 已导出']);
    expect(result.progress).toEqual([5, 20, 80, 90]);

    const done = await findTechnicalPlanExportRequest(appDb, ctx, request.id);
    expect(done?.snapshot).toBeNull();
    const artifact = await findTechnicalPlanExport(appDb, ctx, projectId);
    expect(artifact).toMatchObject({ kind: 'technical-plan-export', projectId, size: DOCX.length });
    expect(done?.result?.artifactId).toBe(artifact!.id);
    expect(objects.get(artifact!.storageKey)?.equals(DOCX)).toBe(true);
    expect(done?.result?.warnings).toEqual([
      '小节 2 AI 小节 未导出正文：正文未生成',
      `小节 1 人工小节 有 7 张图片无法导出，已在原位置用文字标出：${IMAGE_NOT_EMBEDDABLE_REASON}；${IMAGE_NOT_AVAILABLE_REASON}；${WEBP_CONVERT_FAILED_REASON}`,
    ]);
    expect(done?.result?.message).toBe('Word 已导出，其中 1 个 AI 小节未完成，仅保留标题，请完成后重新导出；7 张图片无法导出，已在原位置用文字标出，请打开文档核对。');
  });

  it('没有提示时的消息；新的导出替换本项目旧的导出', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await saveOutline(appDb, ctx, projectId, { reason: 'replace', outlineData: { project_name: 'x', outline: [{ id: randomUUID(), title: '一', content_mode: 'manual-fill' }] } });
    const first = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    expect((await runExport(ctx, projectId, first.request.id)).error).toBeNull();
    const firstArtifact = (await findTechnicalPlanExportRequest(appDb, ctx, first.request.id))!.result!;
    expect(firstArtifact).toMatchObject({ warnings: [], message: EXPORT_DONE_MESSAGE });
    await finishJobs(projectId);
    const second = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    expect((await runExport(ctx, projectId, second.request.id)).error).toBeNull();
    const current = await findTechnicalPlanExport(appDb, ctx, projectId);
    expect(current?.id).toBe((await findTechnicalPlanExportRequest(appDb, ctx, second.request.id))!.result!.artifactId);
    expect(current?.id).not.toBe(firstArtifact.artifactId);
    expect(await findArtifact(appDb, ctx, firstArtifact.artifactId)).toBeNull();
  });

  it('已有结果时直接结束（续跑），不创建沙箱、不改写结果', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillOutline(ctx, projectId, []);
    const { request } = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    expect((await runExport(ctx, projectId, request.id)).error).toBeNull();
    const before = await findTechnicalPlanExportRequest(appDb, ctx, request.id);
    const sandbox = fakeSandbox();
    const again = await runExport(ctx, projectId, request.id, { sandbox: sandbox.driver });
    expect(again).toMatchObject({ error: null, logs: ['Word 已导出'] });
    expect(sandbox.calls).toEqual([]);
    expect(await findTechnicalPlanExportRequest(appDb, ctx, request.id)).toEqual(before);
  });

  it('请求不存在、属于其他组织或不属于任务的项目：EXPORT_REQUEST_NOT_FOUND，不创建沙箱', async () => {
    const ctx = await newOrg();
    const outsider = await newOrg();
    const projectId = await newProject(ctx);
    const otherProject = await newProject(ctx);
    await fillOutline(ctx, projectId, []);
    const { request } = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    for (const [who, project, id, jobProject] of [
      [ctx, projectId, randomUUID(), projectId],
      [outsider, projectId, request.id, projectId],
      [ctx, otherProject, request.id, otherProject],
      [ctx, projectId, request.id, null],
    ] as const) {
      const sandbox = fakeSandbox();
      const { error } = await runExport(who, project, id, { sandbox: sandbox.driver, projectId: jobProject });
      expect(error).toBeInstanceOf(JobError);
      expect(error).toMatchObject({ code: 'EXPORT_REQUEST_NOT_FOUND' });
      expect(sandbox.calls).toEqual([]);
    }
    expect((await findTechnicalPlanExportRequest(appDb, ctx, request.id))?.result).toBeNull();
  });

  it('没有对象存储：EXPORT_UNAVAILABLE，不创建沙箱', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillOutline(ctx, projectId, []);
    const { request } = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    const sandbox = fakeSandbox();
    expect((await runExport(ctx, projectId, request.id, { sandbox: sandbox.driver, objectStore: null })).error).toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
    expect(sandbox.calls).toEqual([]);
  });

  it('引用的配图合计超过 128 MiB：EXPORT_IMAGES_TOO_LARGE，不创建沙箱、不读取配图', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const a = await image(ctx, projectId, Buffer.from('a'));
    const b = await image(ctx, projectId, Buffer.from('b'));
    // 登记的大小改为 100 MiB 与 30 MiB（只改元数据；检查只看产物表登记的大小）。
    await superuser.transaction().execute(async (trx) => {
      await sql`ALTER TABLE artifacts DISABLE TRIGGER USER`.execute(trx);
      await sql`UPDATE artifacts SET size_bytes = ${100 * MIB} WHERE id = ${a}::uuid`.execute(trx);
      await sql`UPDATE artifacts SET size_bytes = ${30 * MIB} WHERE id = ${b}::uuid`.execute(trx);
      await sql`ALTER TABLE artifacts ENABLE TRIGGER USER`.execute(trx);
    });
    await fillOutline(ctx, projectId, [a, b]);
    const { request } = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    const reads: string[] = [];
    const sandbox = fakeSandbox();
    const { error } = await runExport(ctx, projectId, request.id, { sandbox: sandbox.driver, objectStore: { ...store, async get(key) { reads.push(key); return store.get(key); } } });
    expect(error).toMatchObject({ code: 'EXPORT_IMAGES_TOO_LARGE' });
    expect(sandbox.calls).toEqual([]);
    expect(reads).toEqual([]);
    expect((await findTechnicalPlanExportRequest(appDb, ctx, request.id))?.result).toBeNull();
  });

  it('配图在放入时已从对象存储删除：EXPORT_IMAGE_UNAVAILABLE，沙箱被销毁，结果不写回', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const id = await image(ctx, projectId, Buffer.from('to be deleted'));
    await fillOutline(ctx, projectId, [id]);
    const { request } = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    objects.delete((await findArtifact(appDb, ctx, id))!.storageKey);
    const sandbox = fakeSandbox();
    const { error } = await runExport(ctx, projectId, request.id, { sandbox: sandbox.driver });
    expect(error).toMatchObject({ code: 'EXPORT_IMAGE_UNAVAILABLE' });
    expect(sandbox.calls).toEqual(['create:export-document', 'copyIn', 'destroy']);
    expect(await findTechnicalPlanExport(appDb, ctx, projectId)).toBeNull();
  });

  it('超出组织存储配额：STORAGE_QUOTA_EXCEEDED，结果不写回', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillOutline(ctx, projectId, []);
    await fillUsage(ctx.orgId, QUOTA - 10);
    const { request } = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    const { error } = await runExport(ctx, projectId, request.id);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
    expect((await findTechnicalPlanExportRequest(appDb, ctx, request.id))?.result).toBeNull();
    expect(await findTechnicalPlanExport(appDb, ctx, projectId)).toBeNull();
  });

  it('生成过程中中止（取消、worker 关闭）：JobInterruptedError，不写产物、不写回结果', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillOutline(ctx, projectId, []);
    const { request } = await enqueueTechnicalPlanExport(deps(), ctx, projectId);
    const controller = new AbortController();
    const sandbox = fakeSandbox({ onExec: () => controller.abort() });
    const { error } = await runExport(ctx, projectId, request.id, { controller, sandbox: sandbox.driver });
    expect(error).toBeInstanceOf(JobInterruptedError);
    expect(sandbox.calls.at(-1)).toBe('destroy');
    expect((await findTechnicalPlanExportRequest(appDb, ctx, request.id))?.result).toBeNull();
    expect(await findTechnicalPlanExport(appDb, ctx, projectId)).toBeNull();
  });
});
