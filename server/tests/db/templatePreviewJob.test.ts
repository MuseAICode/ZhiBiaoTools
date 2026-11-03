// 模板样张任务（路线图 7.3d，src/export/previewJob.ts、src/jobs/store.ts 的 supersedeQueued）的数据库测试：
// 1. 入队：样张不合法时 400、不保存不入队；合法时保存样张请求、新建组织级的 template-preview 任务（export 队列，参数只有请求 id，不用 lock_key）；
// 2. 取代旧请求：新建时在同一事务中取消本用户排队中的样张任务（写 cancelled 事件并推送），运行中的、暂停的、其他用户的、其他类型的不动；
//    并发入队（多轮、每轮 16 个）后同一用户恰好一个排队中的样张，且是最后提交的那个，不会出现两个排队中的、也不会全部被取消；
// 3. 执行：以发起用户的身份读请求，在沙箱中生成并存为产物、写回结果；同一组织内同一输入复用 23 小时内的结果（不创建沙箱）；
//    请求不存在或属于其他用户、哈希不一致、没有对象存储、超出存储配额、中止时的处理。沙箱用桩（不需要 Docker）。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findArtifact } from '../../src/artifacts/store.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import {
  createTemplatePreviewJob,
  enqueueTemplatePreview,
  TEMPLATE_PREVIEW_JOB_TYPE,
  type TemplatePreviewParams,
} from '../../src/export/previewJob.ts';
import { findTemplatePreviewRequest } from '../../src/export/previewStore.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import { JobError, JobInterruptedError, type JobContext } from '../../src/jobs/definitions.ts';
import type { JobNotifier } from '../../src/jobs/notify.ts';
import { jobTypeRegistry } from '../../src/jobs/registry.ts';
import type { JobServiceDependencies } from '../../src/jobs/service.ts';
import type { JobRecord } from '../../src/jobs/store.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';
import type { SandboxDriver, SandboxExecResult } from '../../src/sandbox/driver.ts';
import { defaultExportFormat } from '../../src/templates/exportFormat.ts';
import { buildZip } from '../sandbox/zipFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const template = readFileSync(new URL('../../../client/electron/resources/content-generation/正文模板.html', import.meta.url), 'utf8');
const SAMPLE = template.replace(/src="assets\/([a-z-]+)\.webp"/g, (_match, name: string) => `src="/assets/${name}-Bx7Kq2Lm.webp"`);
const DOCX = buildZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
]);
const OK_FILES: SandboxFile[] = [
  { path: 'document.docx', data: DOCX },
  { path: 'result.json', data: Buffer.from(JSON.stringify({ version: 1, blockCount: 30, imageWarnings: [] })) },
];
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);

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

/** 记录推送的任务状态。 */
function recordingNotifier(): { notifier: JobNotifier; changed: JobRecord[] } {
  const changed: JobRecord[] = [];
  return {
    changed,
    notifier: {
      async changed(job) {
        changed.push(job);
      },
      async changedById() {},
      async progress() {},
      async logged() {},
    },
  };
}

function deps(notifier?: JobNotifier): JobServiceDependencies {
  return { db: appDb, registry: jobTypeRegistry, dispatcher: null, log: { warn() {} }, ...(notifier ? { notifier } : {}) };
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

async function fillUsage(orgId: string, bytes: number) {
  for (let left = bytes; left > 0; left -= DOCUMENT_MAX_BYTES) {
    await superuser.insertInto('files').values({
      org_id: orgId, purpose: 'tender', display_name: 'filler.pdf', extension: 'pdf', status: 'uploaded', mime: 'application/pdf',
      size_bytes: Math.min(left, DOCUMENT_MAX_BYTES), sha256: Buffer.alloc(32), created_by: randomUUID(), uploaded_at: new Date(),
    }).execute();
  }
}

function input(name = '样张') {
  return { html: SAMPLE, exportFormat: { ...defaultExportFormat(), template_name: name } };
}

async function previewJobs(context: TenantContext): Promise<Array<{ id: string; status: string; user_id: string; created_at: Date }>> {
  return superuser
    .selectFrom('jobs')
    .select(['id', 'status', 'user_id', 'created_at'])
    .where('org_id', '=', context.orgId)
    .where('type', '=', TEMPLATE_PREVIEW_JOB_TYPE)
    .orderBy('created_at')
    .execute();
}

/** 以超级用户把任务改为运行中（模拟 worker 已认领）。 */
async function markRunning(jobId: string): Promise<void> {
  await superuser
    .updateTable('jobs')
    .set({ status: 'running', run_id: randomUUID(), lease_expires_at: sql`now() + interval '1 minute'`, attempt: 1, started_at: sql`now()` })
    .where('id', '=', jobId)
    .execute();
}

// ---- 沙箱桩 ----

function fakeSandbox(options: { onExec?: () => void } = {}) {
  const calls: string[] = [];
  const driver: SandboxDriver = {
    async create(templateName, { jobId }) {
      calls.push(`create:${templateName}`);
      return { id: randomUUID(), template: templateName, jobId, expiresAt: new Date(Date.now() + 60_000) };
    },
    async copyIn() {
      calls.push('copyIn');
    },
    async exec(): Promise<SandboxExecResult> {
      calls.push('exec');
      options.onExec?.();
      return { exitCode: 0, timedOut: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
    },
    async copyOut() {
      calls.push('copyOut');
      return OK_FILES;
    },
    async destroy() {
      calls.push('destroy');
    },
  };
  return { driver, calls };
}

const job = createTemplatePreviewJob({ createRetryDelaysMs: [5] });

interface RunOptions {
  sandbox?: SandboxDriver | null;
  objectStore?: ObjectStore | null;
  controller?: AbortController;
}

/** 以给定的上下文直接执行任务类型的 run（不经队列）。 */
async function runPreview(context: TenantContext, requestId: string, options: RunOptions = {}): Promise<{ error: unknown; logs: string[] }> {
  const logs: string[] = [];
  const controller = options.controller ?? new AbortController();
  const jobContext: JobContext<TemplatePreviewParams> = {
    jobId: randomUUID(),
    projectId: null,
    type: TEMPLATE_PREVIEW_JOB_TYPE,
    attempt: 1,
    params: job.parseParams({ requestId }),
    checkpoint: null,
    tenant: context,
    db: appDb,
    signal: controller.signal,
    async setProgress() {},
    async saveCheckpoint() {},
    async log(message) {
      logs.push(message);
    },
    ai: {
      async chat() {
        throw new Error('template previews do not call models');
      },
    },
    objectStore: options.objectStore === undefined ? store : options.objectStore,
    sandbox: options.sandbox === undefined ? fakeSandbox().driver : options.sandbox,
  };
  try {
    await job.run(jobContext);
    return { error: null, logs };
  } catch (error) {
    return { error, logs };
  }
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
  appDb = connect<Database>(testDb.appConfig, 20);
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

describe('任务类型', () => {
  it('export 队列、可续跑、不调用模型；参数只有请求 id', () => {
    const registered = jobTypeRegistry.get(TEMPLATE_PREVIEW_JOB_TYPE)!;
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
  it('样张不合法时返回 400 PREVIEW_HTML_INVALID，不保存请求、不入队', async () => {
    const ctx = await newOrg();
    const error = await enqueueTemplatePreview(deps(), ctx, { html: '<script>alert(1)</script><p>x</p>', exportFormat: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 400, code: 'PREVIEW_HTML_INVALID' });
    expect(await previewJobs(ctx)).toEqual([]);
    const requests = await superuser.selectFrom('template_preview_requests').select('id').where('org_id', '=', ctx.orgId).execute();
    expect(requests).toEqual([]);
  });

  it('保存样张请求，新建组织级任务（参数只有请求 id，不用 lock_key），并推送任务状态', async () => {
    const ctx = await newOrg();
    const { notifier, changed } = recordingNotifier();
    const { job: queued, request, superseded } = await enqueueTemplatePreview(deps(notifier), ctx, input());
    expect(superseded).toEqual([]);
    expect(queued).toMatchObject({ type: TEMPLATE_PREVIEW_JOB_TYPE, status: 'queued', projectId: null, lockKey: null, userId: ctx.userId, params: { requestId: request.id } });
    expect(request).toMatchObject({ createdBy: ctx.userId, artifactId: null });
    expect(await findTemplatePreviewRequest(appDb, ctx, request.id)).toMatchObject({ id: request.id });
    expect(changed.map((item) => [item.id, item.status])).toEqual([[queued.id, 'queued']]);
  });
});

describe('取代排队中的旧请求', () => {
  it('取消本用户排队中的样张任务（写 cancelled 事件并推送）；运行中的、暂停的、其他用户的、其他类型的不动', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const running = (await enqueueTemplatePreview(deps(), ctx, input('运行中'))).job;
    await markRunning(running.id);
    const paused = (await enqueueTemplatePreview(deps(), ctx, input('暂停'))).job;
    await superuser.updateTable('jobs').set({ status: 'paused' }).where('id', '=', paused.id).execute();
    const older = (await enqueueTemplatePreview(deps(), ctx, input('旧'))).job;
    const others = (await enqueueTemplatePreview(deps(), colleague, input('同事'))).job;
    const otherType = await superuser
      .insertInto('jobs')
      .values({ org_id: ctx.orgId, user_id: ctx.userId, type: 'document-parse', params: JSON.stringify({}) })
      .returning('id')
      .executeTakeFirstOrThrow();

    const { notifier, changed } = recordingNotifier();
    const { job: latest, superseded } = await enqueueTemplatePreview(deps(notifier), ctx, input('新'));
    expect(superseded.map((item) => [item.id, item.status])).toEqual([[older.id, 'cancelled']]);
    expect(changed.map((item) => [item.id, item.status])).toEqual([[older.id, 'cancelled'], [latest.id, 'queued']]);

    const statuses = Object.fromEntries(
      (await superuser.selectFrom('jobs').select(['id', 'status', 'finished_at']).where('org_id', '=', ctx.orgId).execute()).map((row) => [row.id, row]),
    );
    expect(statuses[running.id].status).toBe('running');
    expect(statuses[paused.id].status).toBe('paused');
    expect(statuses[older.id].status).toBe('cancelled');
    expect(statuses[older.id].finished_at).toBeInstanceOf(Date);
    expect(statuses[others.id].status).toBe('queued');
    expect(statuses[otherType.id].status).toBe('queued');
    expect(statuses[latest.id].status).toBe('queued');

    const events = await superuser.selectFrom('job_events').select(['kind', 'data']).where('job_id', '=', older.id).orderBy('id').execute();
    expect(events.map((event) => [event.kind, event.data])).toEqual([
      ['queued', { userId: ctx.userId }],
      ['cancelled', { userId: ctx.userId, supersededBy: latest.id }],
    ]);
  });

  it('并发入队：每轮之后同一用户恰好一个排队中的样张，且是最后提交的那个；运行中的继续，同组织其他用户不受影响', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const running = (await enqueueTemplatePreview(deps(), ctx, input('运行中'))).job;
    await markRunning(running.id);
    const colleagueJob = (await enqueueTemplatePreview(deps(), colleague, input('同事'))).job;

    const ROUNDS = 5;
    const PARALLEL = 16;
    for (let round = 0; round < ROUNDS; round += 1) {
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, (_, index) => enqueueTemplatePreview(deps(), ctx, input(`第 ${round} 轮 ${index}`))),
      );
      const rows = await previewJobs(ctx);
      const queued = rows.filter((row) => row.user_id === ctx.userId && row.status === 'queued');
      expect(queued).toHaveLength(1);
      // 留下的是最后提交的：其他任务都由之后提交的某个入队取消，取消事件指向的任务都存在。
      const created = new Set(results.map((result) => result.job.id));
      expect(created.has(queued[0]!.id)).toBe(true);
      const cancelledThisRound = results.flatMap((result) => result.superseded.map((item) => item.id));
      expect(new Set(cancelledThisRound).size).toBe(cancelledThisRound.length);
      // 本轮新建的 PARALLEL 个任务中，除留下的一个外都被取消；上一轮留下的那个也被取消。
      const cancelledOfRound = [...created].filter((id) => id !== queued[0]!.id);
      expect(cancelledThisRound.filter((id) => created.has(id)).sort()).toEqual(cancelledOfRound.sort());
      expect(cancelledThisRound.length).toBe(round === 0 ? PARALLEL - 1 : PARALLEL);
      const lastEvent = await superuser
        .selectFrom('job_events')
        .select('id')
        .where('job_id', 'in', [...created])
        .where('kind', '=', 'queued')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      const lastQueued = await superuser.selectFrom('job_events').select('job_id').where('id', '=', lastEvent.id).executeTakeFirstOrThrow();
      expect(lastQueued.job_id).toBe(queued[0]!.id);
    }
    const rows = await previewJobs(ctx);
    expect(rows.find((row) => row.id === running.id)?.status).toBe('running');
    expect(rows.find((row) => row.id === colleagueJob.id)?.status).toBe('queued');
    expect(rows.filter((row) => row.user_id === ctx.userId && row.status === 'cancelled')).toHaveLength(ROUNDS * PARALLEL - 1);
  });

  it('并发：认领与取代同时发生时，被认领的继续运行，最后仍恰好一个排队中的样张', async () => {
    const ctx = await newOrg();
    for (let round = 0; round < 5; round += 1) {
      const target = (await enqueueTemplatePreview(deps(), ctx, input(`认领 ${round}`))).job;
      // 一边把它改为运行中（与 worker 认领相同，按 status = 'queued' 条件更新），一边并发入队新的样张。
      const [claimed] = await Promise.all([
        superuser
          .updateTable('jobs')
          .set({ status: 'running', run_id: randomUUID(), lease_expires_at: sql`now() + interval '1 minute'`, attempt: 1, started_at: sql`now()` })
          .where('id', '=', target.id)
          .where('status', '=', 'queued')
          .returning('id')
          .execute(),
        ...Array.from({ length: 4 }, (_, index) => enqueueTemplatePreview(deps(), ctx, input(`取代 ${round} ${index}`))),
      ]);
      const rows = await previewJobs(ctx);
      expect(rows.filter((row) => row.status === 'queued')).toHaveLength(1);
      const status = rows.find((row) => row.id === target.id)!.status;
      expect(status).toBe(claimed.length === 1 ? 'running' : 'cancelled');
      await superuser.updateTable('jobs').set({ status: 'cancelled', run_id: null, lease_expires_at: null, finished_at: sql`now()` }).where('id', '=', target.id).where('status', '=', 'running').execute();
    }
  });
});

describe('执行', () => {
  it('在 export-preview 沙箱中生成，存为样张产物并写回结果；同组织同一输入的新请求复用，不再创建沙箱', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const outsider = await newOrg();
    const first = await enqueueTemplatePreview(deps(), ctx, input('复用'));
    const sandbox = fakeSandbox();
    const result = await runPreview(ctx, first.request.id, { sandbox: sandbox.driver });
    expect(result.error).toBeNull();
    expect(sandbox.calls).toEqual(['create:export-preview', 'copyIn', 'exec', 'copyOut', 'destroy']);
    expect(result.logs).toEqual(['开始生成样张', '样张已生成']);
    const done = await findTemplatePreviewRequest(appDb, ctx, first.request.id);
    expect(done?.artifactId).toEqual(expect.any(String));
    expect(done?.completedAt).toBeInstanceOf(Date);
    const artifact = await findArtifact(appDb, ctx, done!.artifactId!);
    expect(artifact).toMatchObject({ kind: 'template-preview', projectId: null, size: DOCX.length });
    expect(objects.get(artifact!.storageKey)?.equals(DOCX)).toBe(true);

    // 同组织的同事、同一输入：复用，不创建沙箱。
    const second = await enqueueTemplatePreview(deps(), colleague, input('复用'));
    const unused = fakeSandbox();
    const reused = await runPreview(colleague, second.request.id, { sandbox: unused.driver });
    expect(reused.error).toBeNull();
    expect(unused.calls).toEqual([]);
    expect(reused.logs).toEqual(['复用相同设置最近生成的样张']);
    expect((await findTemplatePreviewRequest(appDb, colleague, second.request.id))?.artifactId).toBe(done!.artifactId);

    // 其他组织不复用。
    const third = await enqueueTemplatePreview(deps(), outsider, input('复用'));
    const fresh = fakeSandbox();
    expect((await runPreview(outsider, third.request.id, { sandbox: fresh.driver })).error).toBeNull();
    expect(fresh.calls).toContain('exec');
    expect((await findTemplatePreviewRequest(appDb, outsider, third.request.id))?.artifactId).not.toBe(done!.artifactId);
  });

  it('已有结果时直接结束（续跑），不创建沙箱、不改写结果', async () => {
    const ctx = await newOrg();
    const { request } = await enqueueTemplatePreview(deps(), ctx, input('续跑'));
    expect((await runPreview(ctx, request.id)).error).toBeNull();
    const before = await findTemplatePreviewRequest(appDb, ctx, request.id);
    const sandbox = fakeSandbox();
    const again = await runPreview(ctx, request.id, { sandbox: sandbox.driver });
    expect(again).toEqual({ error: null, logs: ['样张已生成'] });
    expect(sandbox.calls).toEqual([]);
    expect(await findTemplatePreviewRequest(appDb, ctx, request.id)).toEqual(before);
  });

  it('产物已写入而结果未写回时（崩溃后续跑），按输入哈希复用那份产物', async () => {
    const ctx = await newOrg();
    const { request } = await enqueueTemplatePreview(deps(), ctx, input('崩溃'));
    // 第一次执行在写回结果之前中止：产物已写入。
    const controller = new AbortController();
    const abortAfterPut: ObjectStore = {
      ...store,
      async put(key, body, options) {
        await store.put(key, body, options);
        controller.abort();
      },
    };
    const crashed = await runPreview(ctx, request.id, { controller, objectStore: abortAfterPut });
    expect(crashed.error).toBeInstanceOf(JobInterruptedError);
    expect((await findTemplatePreviewRequest(appDb, ctx, request.id))?.artifactId).toBeNull();
    const written = await superuser.selectFrom('artifacts').select('id').where('org_id', '=', ctx.orgId).where('kind', '=', 'template-preview').execute();
    expect(written).toHaveLength(1);

    const sandbox = fakeSandbox();
    expect((await runPreview(ctx, request.id, { sandbox: sandbox.driver })).error).toBeNull();
    expect(sandbox.calls).toEqual([]);
    expect((await findTemplatePreviewRequest(appDb, ctx, request.id))?.artifactId).toBe(written[0]!.id);
  });

  it('请求不存在或属于其他用户：PREVIEW_REQUEST_NOT_FOUND，不创建沙箱', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const { request } = await enqueueTemplatePreview(deps(), ctx, input('他人'));
    for (const [who, id] of [[colleague, request.id], [ctx, randomUUID()]] as const) {
      const sandbox = fakeSandbox();
      const { error } = await runPreview(who, id, { sandbox: sandbox.driver });
      expect(error).toBeInstanceOf(JobError);
      expect(error).toMatchObject({ code: 'PREVIEW_REQUEST_NOT_FOUND' });
      expect(sandbox.calls).toEqual([]);
    }
  });

  it('保存的哈希与重新准备的不一致：PREVIEW_REQUEST_INVALID，不创建沙箱', async () => {
    const ctx = await newOrg();
    const { request } = await enqueueTemplatePreview(deps(), ctx, input('哈希'));
    await superuser.transaction().execute(async (trx) => {
      await sql`ALTER TABLE template_preview_requests DISABLE TRIGGER USER`.execute(trx);
      await sql`UPDATE template_preview_requests SET input_sha256 = ${Buffer.alloc(32)} WHERE id = ${request.id}::uuid`.execute(trx);
      await sql`ALTER TABLE template_preview_requests ENABLE TRIGGER USER`.execute(trx);
    });
    const sandbox = fakeSandbox();
    const { error } = await runPreview(ctx, request.id, { sandbox: sandbox.driver });
    expect(error).toMatchObject({ code: 'PREVIEW_REQUEST_INVALID' });
    expect(sandbox.calls).toEqual([]);
  });

  it('没有对象存储：EXPORT_UNAVAILABLE，不创建沙箱；没有沙箱：EXPORT_UNAVAILABLE', async () => {
    const ctx = await newOrg();
    const { request } = await enqueueTemplatePreview(deps(), ctx, input('不可用'));
    const sandbox = fakeSandbox();
    expect((await runPreview(ctx, request.id, { sandbox: sandbox.driver, objectStore: null })).error).toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
    expect(sandbox.calls).toEqual([]);
    expect((await runPreview(ctx, request.id, { sandbox: null })).error).toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
    expect((await findTemplatePreviewRequest(appDb, ctx, request.id))?.artifactId).toBeNull();
  });

  it('超出组织存储配额：任务以 STORAGE_QUOTA_EXCEEDED 失败，结果不写回', async () => {
    const ctx = await newOrg();
    await fillUsage(ctx.orgId, QUOTA - 10);
    const { request } = await enqueueTemplatePreview(deps(), ctx, input('配额'));
    const { error } = await runPreview(ctx, request.id);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
    expect((await findTemplatePreviewRequest(appDb, ctx, request.id))?.artifactId).toBeNull();
  });

  it('生成过程中中止（取消、worker 关闭）：JobInterruptedError，不写产物、不写回结果', async () => {
    const ctx = await newOrg();
    const { request } = await enqueueTemplatePreview(deps(), ctx, input('中止'));
    const controller = new AbortController();
    const { error } = await runPreview(ctx, request.id, { controller, sandbox: fakeSandbox({ onExec: () => controller.abort() }).driver });
    expect(error).toBeInstanceOf(JobInterruptedError);
    expect((await findTemplatePreviewRequest(appDb, ctx, request.id))?.artifactId).toBeNull();
    expect(await superuser.selectFrom('artifacts').select('id').where('org_id', '=', ctx.orgId).execute()).toEqual([]);
  });
});
