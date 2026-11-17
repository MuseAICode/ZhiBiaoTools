// 可研报告导出 Word 任务（路线图 7.5d，src/export/feasibilityJob.ts）的数据库测试。沙箱用桩（按真实规则生成并读回归档，
// 按需读取的配图在放入时才从对象存储读取），不需要 Docker；真实沙箱见 tests/sandbox/docker/exportFeasibility.test.ts。
// 1. 入队：取快照存为请求，新建项目级任务（export 队列、lock_key 按项目、参数只有请求 id）；入队成功后删除本项目的其他请求；
//    入队前就能确定的错误不保存、不入队；同一项目已有未结束的可研导出时 409，并删除刚保存的请求；可研的生成任务不阻塞导出；
// 2. 执行：从快照正文中找出引用的产物，只把本项目可见的图片产物放入沙箱（其他项目、其他组织、已被替换、不是图片、不存在的都不放），
//    request.json 只有桌面版代码用到的字段；存为可研导出产物、写回提示与消息；已有结果时直接结束；
// 3. 失败：请求不存在或不属于任务的项目、没有对象存储、配图合计过大（不创建沙箱）、配图已被删除、超出存储配额、中止。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findArtifact, writeArtifact } from '../../src/artifacts/store.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import {
  collectFeasibilityImageRefs,
  createFeasibilityReportExportJob,
  enqueueFeasibilityReportExport,
  FEASIBILITY_DEFAULT_PROJECT_NAME,
  FEASIBILITY_REPORT_EXPORT_JOB_TYPE,
  feasibilityReportExportLockKey,
  type FeasibilityReportExportParams,
} from '../../src/export/feasibilityJob.ts';
import { findFeasibilityExportRequest, saveFeasibilityExportRequest } from '../../src/export/feasibilityRequestStore.ts';
import { findFeasibilityExport } from '../../src/export/feasibilityStore.ts';
import { feasibilityReportLockKey, saveOutline, saveProjectInfo } from '../../src/feasibilityReport/store.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import { JobError, JobInterruptedError, type JobContext } from '../../src/jobs/definitions.ts';
import { jobTypeRegistry } from '../../src/jobs/registry.ts';
import type { JobServiceDependencies } from '../../src/jobs/service.ts';
import { createArchiveStream, readArchive, type SandboxFile, type SandboxInputFile } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxExecResult } from '../../src/sandbox/driver.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { syncSystemTemplates } from '../../src/templates/system.ts';
import { buildZip } from '../sandbox/zipFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const LIMITS = SANDBOX_TEMPLATES['export-feasibility'].input;
const MIB = 1024 * 1024;
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);
const DOCX = buildZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
]);

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;
let systemTemplateId: string;

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

async function newProject(ctx: TenantContext, kind = 'feasibility-report'): Promise<string> {
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

async function image(ctx: TenantContext, projectId: string, data: Buffer, mime = 'image/png'): Promise<string> {
  const name = mime === 'image/webp' ? 'image-001.webp' : 'image-001.png';
  return (await writeArtifact(appDb, ctx, store, { kind: 'image', name, mime, projectId }, data)).id;
}

const url = (id: string) => `/api/artifacts/${id}/content`;

/** 项目信息与一个两节的目录：第一节的正文引用给出的地址（每个一次），第二节没有正文。 */
async function fillProject(ctx: TenantContext, projectId: string, refs: readonly string[], projectName = '示例产业园') {
  await saveProjectInfo(appDb, ctx, projectId, { projectName, constructionUnit: '示例公司' });
  await saveOutline(appDb, ctx, projectId, {
    reason: 'edit',
    outlineData: {
      outline: [
        { id: '1', title: '总论', description: '', content: ['总论的正文', ...refs.map((ref, index) => `![图 ${index}](${ref})`)].join('\n\n') },
        { id: '2', title: '建设条件', description: '' },
      ],
    },
  });
}

const enqueueInput = () => ({ templateId: systemTemplateId, options: { documentCode: 'KYBG-000042' } });

// ---- 沙箱桩 ----

function execResult(exitCode: number | null, stdout = ''): SandboxExecResult {
  return { exitCode, timedOut: false, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false };
}

/** 按真实规则生成并读回归档（按需读取的配图在这里才读取）；输出的提示由 warn 决定。 */
function fakeSandbox(options: { warn?: (request: Record<string, any>, assets: string[]) => string[]; onExec?: () => void } = {}) {
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
      const request = JSON.parse(copied.find((file) => file.path === 'request.json')!.data.toString('utf8')) as Record<string, any>;
      const assets = copied.filter((file) => file.path.startsWith('assets/')).map((file) => file.path.slice('assets/'.length));
      return [
        { path: 'document.docx', data: DOCX },
        { path: 'result.json', data: Buffer.from(JSON.stringify({ version: 1, warnings: options.warn?.(request, assets) ?? [] })) },
      ];
    },
    async destroy() {
      calls.push('destroy');
    },
  };
  return { driver, calls, copied: () => copied };
}

const job = createFeasibilityReportExportJob({ createRetryDelaysMs: [5] });

interface RunOptions {
  projectId?: string | null;
  sandbox?: SandboxDriver | null;
  objectStore?: ObjectStore | null;
  controller?: AbortController;
}

async function runExport(context: TenantContext, projectId: string, requestId: string, options: RunOptions = {}) {
  const logs: string[] = [];
  const progress: number[] = [];
  const controller = options.controller ?? new AbortController();
  const jobContext: JobContext<FeasibilityReportExportParams> = {
    jobId: randomUUID(),
    projectId: options.projectId === undefined ? projectId : options.projectId,
    type: FEASIBILITY_REPORT_EXPORT_JOB_TYPE,
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
        throw new Error('feasibility report exports do not call models');
      },
    },
    objectStore: options.objectStore === undefined ? store : options.objectStore,
    sandbox: options.sandbox === undefined ? fakeSandbox().driver : options.sandbox,
    agentWorkspace: null,
    agent: null,
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
    .where('type', '=', FEASIBILITY_REPORT_EXPORT_JOB_TYPE).orderBy('created_at').execute();
}

async function requestIds(projectId: string): Promise<string[]> {
  return (await superuser.selectFrom('feasibility_report_export_requests').select('id').where('project_id', '=', projectId).execute()).map((row: { id: string }) => row.id);
}

async function finishJobs(projectId: string) {
  await superuser.updateTable('jobs').set({ status: 'succeeded', finished_at: sql`now()` }).where('project_id', '=', projectId)
    .where('finished_at', 'is', null).execute();
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
  systemTemplateId = (await superuser.selectFrom('export_templates').select('id').where('org_id', 'is', null).executeTakeFirstOrThrow()).id;
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

describe('任务类型', () => {
  it('export 队列、可续跑、不调用模型；参数只有请求 id', () => {
    const registered = jobTypeRegistry.get(FEASIBILITY_REPORT_EXPORT_JOB_TYPE)!;
    expect(registered).toMatchObject({ queue: 'export', resumable: true });
    expect(registered.billable).toBeUndefined();
    const id = randomUUID();
    expect(registered.parseParams({ requestId: id })).toEqual({ requestId: id });
    for (const bad of [null, [], {}, { requestId: 'x' }, { requestId: id.toUpperCase() }, { requestId: id, extra: 1 }, { requestId: 1 }]) {
      expect(() => registered.parseParams(bad)).toThrow(TypeError);
    }
    expect(feasibilityReportExportLockKey(id)).not.toBe(feasibilityReportLockKey(id));
  });

  it('从快照正文中找出引用的产物 id：小写、去重、按首次出现的顺序，含子节点', () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(collectFeasibilityImageRefs([
      { id: '1', title: 't', children: [{ id: '1.1', title: 't', content: `![x](${url(a.toUpperCase())}) <img src="${url(b)}"> [链接](${url(a)})` }] },
      { id: '2', title: 't', content: `![y](https://example.com${url(b)}) /api/artifacts/not-a-uuid/content` },
      { id: '3', title: 't' },
    ])).toEqual([a, b]);
  });
});

describe('入队', () => {
  it('取快照存为请求，新建项目级任务（lock_key 按项目，参数只有请求 id）；成功后删除本项目的其他请求，其他项目的不动', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const otherProject = await newProject(ctx);
    await fillProject(ctx, projectId, []);
    await fillProject(ctx, otherProject, []);
    const old = await saveFeasibilityExportRequest(appDb, ctx, projectId, enqueueInput());
    const others = await saveFeasibilityExportRequest(appDb, ctx, otherProject, enqueueInput());

    const { job: queued, request } = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    expect(queued).toMatchObject({
      type: FEASIBILITY_REPORT_EXPORT_JOB_TYPE, status: 'queued', projectId, userId: ctx.userId,
      lockKey: feasibilityReportExportLockKey(projectId), params: { requestId: request.id },
    });
    expect(request).toMatchObject({ projectName: '示例产业园', options: { documentCode: 'KYBG-000042' } });
    expect(await requestIds(projectId)).toEqual([request.id]);
    expect(await findFeasibilityExportRequest(appDb, ctx, old.id)).toBeNull();
    expect(await requestIds(otherProject)).toEqual([others.id]);
  });

  it('入队前就能确定的错误：不保存、不入队', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await expect(enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput())).rejects.toMatchObject({ statusCode: 400, code: 'EXPORT_EMPTY' });
    await fillProject(ctx, projectId, []);
    await expect(enqueueFeasibilityReportExport(deps(), ctx, projectId, { templateId: randomUUID(), options: {} }))
      .rejects.toMatchObject({ statusCode: 400, code: 'EXPORT_TEMPLATE_REQUIRED' });
    await expect(enqueueFeasibilityReportExport(deps(), ctx, projectId, { templateId: systemTemplateId, options: { includeCover: 1 as never } }))
      .rejects.toMatchObject({ statusCode: 400, code: 'EXPORT_OPTIONS_INVALID' });
    expect(await requestIds(projectId)).toEqual([]);
    expect(await exportJobs(projectId)).toEqual([]);
  });

  it('同一项目已有未结束的可研导出：409 JOB_LOCKED，删除刚保存的请求，原来的请求与任务不动；结束后可以再导出', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const projectId = await newProject(ctx);
    await fillProject(ctx, projectId, []);
    const first = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    await expect(enqueueFeasibilityReportExport(deps(), colleague, projectId, enqueueInput())).rejects.toMatchObject({ statusCode: 409, code: 'JOB_LOCKED' });
    expect(await requestIds(projectId)).toEqual([first.request.id]);
    expect((await exportJobs(projectId)).map((row: { id: string }) => row.id)).toEqual([first.job.id]);

    await finishJobs(projectId);
    const second = await enqueueFeasibilityReportExport(deps(), colleague, projectId, enqueueInput());
    expect(await requestIds(projectId)).toEqual([second.request.id]);
  });

  it('可研的生成任务未结束时仍可导出（不同的互斥键，导出读的是快照）', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillProject(ctx, projectId, []);
    await superuser.insertInto('jobs').values({
      org_id: ctx.orgId, user_id: ctx.userId, project_id: projectId, type: 'feasibility-content', status: 'queued',
      lock_key: feasibilityReportLockKey(projectId), params: JSON.stringify({}),
    } as never).execute();
    const { job: queued } = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    expect(queued.status).toBe('queued');
  });
});

describe('执行', () => {
  it('只放入本项目可见的图片产物，request.json 只有桌面版代码用到的字段；存为可研导出产物并写回提示与消息', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const outsider = await newOrg();
    const projectId = await newProject(ctx);
    const otherProject = await newProject(ctx);
    const outsiderProject = await newProject(outsider);
    const png = await image(ctx, projectId, Buffer.from('png bytes'));
    const webp = await image(ctx, projectId, Buffer.from('RIFF....WEBP'), 'image/webp');
    const otherProjectImage = await image(ctx, otherProject, Buffer.from('other project'));
    const outsiderImage = await image(outsider, outsiderProject, Buffer.from('outsider'));
    const replaced = await image(ctx, projectId, Buffer.from('replaced'));
    await superuser.updateTable('artifacts').set({ superseded_at: new Date() }).where('id', '=', replaced).execute();
    const markdown = (await writeArtifact(appDb, ctx, store, { kind: 'markdown', name: 'content.md', mime: 'text/markdown; charset=utf-8', projectId }, Buffer.from('# md'))).id;
    const missing = randomUUID();
    const refs = [png, webp.toUpperCase(), otherProjectImage, outsiderImage, replaced, markdown, missing, png].map(url);
    await fillProject(ctx, projectId, refs);
    const { request } = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());

    const sandbox = fakeSandbox({ warn: () => ['图片无法导出：图 2，未找到可用图片数据'] });
    // 同组织的其他成员执行（任务以发起用户的身份运行时同样可见）。
    const run = await runExport(colleague, projectId, request.id, { sandbox: sandbox.driver });
    expect(run.error).toBeNull();
    expect(sandbox.calls).toEqual(['create:export-feasibility', 'copyIn', 'exec', 'copyOut', 'destroy']);
    const copied = sandbox.copied();
    expect(copied.map((file) => file.path)).toEqual(['request.json', `assets/${png}`, `assets/${webp}`]);
    const body = JSON.parse(copied[0]!.data.toString('utf8'));
    expect(Object.keys(body).sort()).toEqual(['export_format', 'feasibility_options', 'outline', 'project_name']);
    expect(body.project_name).toBe('示例产业园');
    expect(body.feasibility_options).toMatchObject({ documentCode: 'KYBG-000042', project_info: { projectName: '示例产业园', constructionUnit: '示例公司' } });
    // 正文原样交给沙箱（引用的地址由沙箱中的桌面版代码按产物读取或原位提示）。
    expect(body.outline[0].content).toContain(url(webp.toUpperCase()));
    expect(run.progress).toEqual([5, 20, 80, 90]);

    const artifact = await findFeasibilityExport(appDb, ctx, projectId);
    expect(artifact).toMatchObject({ kind: 'feasibility-report-export', projectId, size: DOCX.length });
    expect((await findFeasibilityExportRequest(appDb, ctx, request.id))?.result).toEqual({
      artifactId: artifact!.id,
      warnings: ['图片无法导出：图 2，未找到可用图片数据'],
      message: 'Word 已导出，但有 1 处图片未能插入，请打开文档核对。',
    });
  });

  it('项目名称为空时用桌面版的默认名称；没有提示时的消息；新的导出替换本项目旧的导出', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillProject(ctx, projectId, []);
    const first = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    expect((await runExport(ctx, projectId, first.request.id)).error).toBeNull();
    const firstArtifact = (await findFeasibilityExport(appDb, ctx, projectId))!;
    await finishJobs(projectId);

    await superuser.updateTable('feasibility_report_meta').set({ project_name: '' }).where('project_id', '=', projectId).execute();
    const second = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    const sandbox = fakeSandbox();
    expect((await runExport(ctx, projectId, second.request.id, { sandbox: sandbox.driver })).error).toBeNull();
    expect(JSON.parse(sandbox.copied()[0]!.data.toString('utf8')).project_name).toBe(FEASIBILITY_DEFAULT_PROJECT_NAME);
    expect((await findFeasibilityExportRequest(appDb, ctx, second.request.id))?.result?.message).toBe('Word 已导出，请打开文档核对图片、表格和版式。');
    const current = (await findFeasibilityExport(appDb, ctx, projectId))!;
    expect(current.id).not.toBe(firstArtifact.id);
    expect(await findArtifact(appDb, ctx, firstArtifact.id)).toBeNull();
  });

  it('已有结果时直接结束（续跑），不创建沙箱、不改写结果', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillProject(ctx, projectId, []);
    const { request } = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    expect((await runExport(ctx, projectId, request.id)).error).toBeNull();
    const result = (await findFeasibilityExportRequest(appDb, ctx, request.id))!.result;
    const sandbox = fakeSandbox();
    const again = await runExport(ctx, projectId, request.id, { sandbox: sandbox.driver });
    expect(again.error).toBeNull();
    expect(sandbox.calls).toEqual([]);
    expect((await findFeasibilityExportRequest(appDb, ctx, request.id))!.result).toEqual(result);
  });

  it('请求不存在、属于其他组织或不属于任务的项目：EXPORT_REQUEST_NOT_FOUND，不创建沙箱', async () => {
    const ctx = await newOrg();
    const outsider = await newOrg();
    const projectId = await newProject(ctx);
    const otherProject = await newProject(ctx);
    await fillProject(ctx, projectId, []);
    const { request } = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    for (const [context, project, requestId, overrides] of [
      [ctx, projectId, randomUUID(), {}],
      [outsider, projectId, request.id, {}],
      [ctx, otherProject, request.id, {}],
      [ctx, projectId, request.id, { projectId: null }],
    ] as const) {
      const sandbox = fakeSandbox();
      const run = await runExport(context, project, requestId, { ...overrides, sandbox: sandbox.driver });
      expect(run.error).toBeInstanceOf(JobError);
      expect(run.error).toMatchObject({ code: 'EXPORT_REQUEST_NOT_FOUND' });
      expect(sandbox.calls).toEqual([]);
    }
  });

  it('没有对象存储：EXPORT_UNAVAILABLE，不创建沙箱', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillProject(ctx, projectId, []);
    const { request } = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    const sandbox = fakeSandbox();
    const run = await runExport(ctx, projectId, request.id, { objectStore: null, sandbox: sandbox.driver });
    expect(run.error).toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
    expect(sandbox.calls).toEqual([]);
  });

  it('引用的配图合计超过 128 MiB：EXPORT_IMAGES_TOO_LARGE，不创建沙箱、不读取配图', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const a = await image(ctx, projectId, Buffer.from('a'));
    const b = await image(ctx, projectId, Buffer.from('b'));
    // 只改登记的大小，不真的写 128 MiB（已完成的产物受触发器保护，临时关掉）。
    await superuser.transaction().execute(async (trx) => {
      await sql`ALTER TABLE artifacts DISABLE TRIGGER USER`.execute(trx);
      await sql`UPDATE artifacts SET size_bytes = ${100 * MIB} WHERE id IN (${a}::uuid, ${b}::uuid)`.execute(trx);
      await sql`ALTER TABLE artifacts ENABLE TRIGGER USER`.execute(trx);
    });
    await fillProject(ctx, projectId, [url(a), url(b)]);
    const { request } = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    const gets: string[] = [];
    const counting: ObjectStore = { ...store, async get(key) { gets.push(key); return store.get(key); } };
    const sandbox = fakeSandbox();
    const run = await runExport(ctx, projectId, request.id, { objectStore: counting, sandbox: sandbox.driver });
    expect(run.error).toMatchObject({ code: 'EXPORT_IMAGES_TOO_LARGE' });
    expect(sandbox.calls).toEqual([]);
    expect(gets).toEqual([]);
    expect((await findFeasibilityExportRequest(appDb, ctx, request.id))!.result).toBeNull();
  });

  it('配图在放入时已从对象存储删除：EXPORT_IMAGE_UNAVAILABLE，沙箱被销毁，结果不写回', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const a = await image(ctx, projectId, Buffer.from('a'));
    await fillProject(ctx, projectId, [url(a)]);
    const { request } = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    const key = (await findArtifact(appDb, ctx, a))!.storageKey;
    objects.delete(key);
    const sandbox = fakeSandbox();
    const run = await runExport(ctx, projectId, request.id, { sandbox: sandbox.driver });
    expect(run.error).toMatchObject({ code: 'EXPORT_IMAGE_UNAVAILABLE' });
    expect(sandbox.calls).toEqual(['create:export-feasibility', 'copyIn', 'destroy']);
    expect((await findFeasibilityExportRequest(appDb, ctx, request.id))!.result).toBeNull();
  });

  it('超出组织存储配额：STORAGE_QUOTA_EXCEEDED，结果不写回', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillProject(ctx, projectId, []);
    const { request } = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    await fillUsage(ctx.orgId, QUOTA);
    const run = await runExport(ctx, projectId, request.id);
    expect(run.error).toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
    expect((await findFeasibilityExportRequest(appDb, ctx, request.id))!.result).toBeNull();
    expect(await findFeasibilityExport(appDb, ctx, projectId)).toBeNull();
  });

  it('生成过程中中止（取消、worker 关闭）：JobInterruptedError，不写产物、不写回结果', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillProject(ctx, projectId, []);
    const { request } = await enqueueFeasibilityReportExport(deps(), ctx, projectId, enqueueInput());
    const controller = new AbortController();
    const sandbox = fakeSandbox({ onExec: () => controller.abort() });
    const run = await runExport(ctx, projectId, request.id, { sandbox: sandbox.driver, controller });
    expect(run.error).toBeInstanceOf(JobInterruptedError);
    expect(await findFeasibilityExport(appDb, ctx, projectId)).toBeNull();
    expect((await findFeasibilityExportRequest(appDb, ctx, request.id))!.result).toBeNull();
    expect(sandbox.calls.at(-1)).toBe('destroy');
  });
});
