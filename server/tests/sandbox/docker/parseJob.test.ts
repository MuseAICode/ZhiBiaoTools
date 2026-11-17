// 解析卡住时的解析任务（src/parse/job.ts）：在真实的沙箱（CI 中为 gVisor）和真实的数据库上执行 document-parse，
// 验证 LibreOffice 卡住、或整个解析命令卡住时，任务在预期时间内失败、文档标为失败、沙箱被销毁（容器不存在）。
// 生产中的时限：LibreOffice 转换 8 分钟（入口对整个进程组 SIGKILL）；解析命令墙钟 10 分钟（sandbox-runner 终止整个沙箱）；
// 任务在 finally 中销毁沙箱。测试中把两个时限缩短（转换 5 秒、命令 8 秒），终止方式与生产相同：
// - LibreOffice 卡住：真实的解析入口，转换上限经 ZHIBIAO_PARSE_OFFICE_TIMEOUT_MS 调为 5 秒（只能调小），soffice.bin 被冻结；
// - 整个解析命令卡住：入口被冻结，由沙箱命令的墙钟上限（这里 8 秒，代替模板的 10 分钟）终止整个沙箱。
// 需要 TEST_DATABASE_ADMIN_URL（CI 的沙箱测试步骤使用同一个 PostgreSQL 服务容器）；LibreOffice 的用例另需 TEST_SANDBOX_OFFICE=1。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listArtifacts } from '../../../src/artifacts/store.ts';
import { createDatabase, type DatabaseHandle } from '../../../src/db/database.ts';
import { migrateToLatest } from '../../../src/db/migrator.ts';
import type { Database } from '../../../src/db/schema.ts';
import type { TenantContext } from '../../../src/db/tenant.ts';
import type { ObjectStore } from '../../../src/files/objectStore.ts';
import { JobError, type JobContext } from '../../../src/jobs/definitions.ts';
import { createDocumentParseJob, DOCUMENT_PARSE_JOB_TYPE, type DocumentParseParams } from '../../../src/parse/job.ts';
import { createDockerSandboxDriver } from '../../../src/sandbox/docker.ts';
import type { SandboxDriver, SandboxRef } from '../../../src/sandbox/driver.ts';
import { importTenderFiles, loadTechnicalPlan } from '../../../src/technicalPlan/store.ts';
import { connect, createTestDatabase, type TestDatabase } from '../../db/harness.ts';
import { docker, sandboxEnv, silentLog } from './env.ts';
import { stuckEntryScript, stuckOfficeScript } from './stuckOffice.ts';

const hasDatabase = Boolean(process.env.TEST_DATABASE_ADMIN_URL);
const samples = new URL('../samples/', import.meta.url);

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

const base = createDockerSandboxDriver({ docker, runtime: sandboxEnv.runtime, images: { parse: sandboxEnv.image }, maxActive: 32, log: silentLog });

/**
 * 只替换 parse 命令的执行方式（见文件开头）的真实 driver：创建、放入、取回、销毁都是真实的。记录创建过的沙箱，
 * 测试结束后核对它们都已不存在。
 */
function stuckDriver(mode: 'office' | 'entry', commandTimeoutMs: number): SandboxDriver & { created: SandboxRef[] } {
  const created: SandboxRef[] = [];
  return {
    created,
    async create(template, options) {
      const ref = await base.create(template, options);
      created.push(ref);
      return ref;
    },
    copyIn: (sandbox, files, options) => base.copyIn(sandbox, files, options),
    copyOut: (sandbox, options) => base.copyOut(sandbox, options),
    destroy: (sandbox) => base.destroy(sandbox),
    async exec(sandbox, command, args, options = {}) {
      expect(command).toBe('parse');
      const script = mode === 'office' ? stuckOfficeScript(args, 5_000) : stuckEntryScript(args);
      return base.execArgv(sandbox, ['sh', '-c', script], { timeoutMs: commandTimeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
    },
  };
}

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
const leftovers: SandboxRef[] = [];

async function newMember(): Promise<TenantContext> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, userId, role: 'owner' };
}

/** 技术方案项目中导入一份招标文件（原件放进内存对象存储），返回 { projectId, fileId }。 */
async function importTender(member: TenantContext, file: { name: string; extension: string; mime: string; content: Buffer }) {
  const project = await superuser
    .insertInto('projects')
    .values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      purpose: 'tender',
      display_name: file.name,
      extension: file.extension,
      status: 'uploaded',
      mime: file.mime,
      size_bytes: file.content.length,
      sha256: Buffer.alloc(32),
      uploaded_at: new Date(),
      created_by: member.userId,
    })
    .returning(['id', 'storage_key'])
    .executeTakeFirstOrThrow();
  objects.set(row.storage_key, file.content);
  await importTenderFiles(appDb, member, project.id, [row.id]);
  return { projectId: project.id as string, fileId: row.id as string };
}

async function runJob(member: TenantContext, projectId: string, fileId: string, sandbox: SandboxDriver): Promise<{ error: unknown; elapsedMs: number }> {
  const job = createDocumentParseJob();
  const controller = new AbortController();
  const context: JobContext<DocumentParseParams> = {
    jobId: randomUUID(),
    projectId,
    type: DOCUMENT_PARSE_JOB_TYPE,
    attempt: 1,
    params: job.parseParams({ target: 'technical-plan-tender', fileId }),
    checkpoint: null,
    tenant: member,
    db: appDb,
    signal: controller.signal,
    async setProgress() {},
    async saveCheckpoint() {},
    async log() {},
    ai: {
      async chat() {
        throw new Error('parse jobs do not call models');
      },
    },
    objectStore: memoryStore,
    sandbox,
    agentWorkspace: null,
    agent: null,
  };
  const started = Date.now();
  try {
    await job.run(context);
    return { error: null, elapsedMs: Date.now() - started };
  } catch (error) {
    return { error, elapsedMs: Date.now() - started };
  }
}

async function expectDestroyed(refs: readonly SandboxRef[]) {
  expect(refs).toHaveLength(1);
  for (const ref of refs) {
    leftovers.push(ref);
    expect(await docker.inspectContainer(`zhibiao-sandbox-${ref.id}`)).toBeNull();
    expect((await docker.listContainers(`zhibiao.sandbox.job=${ref.jobId}`)).length).toBe(0);
  }
}

describe.runIf(hasDatabase)('parse job when parsing gets stuck (real sandbox and database)', () => {
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
  });

  afterEach(async () => {
    // 断言失败时也不留下容器。
    for (const ref of leftovers.splice(0)) await base.destroy(ref);
  });

  afterAll(async () => {
    await database?.destroy();
    await testDb?.drop();
  });

  it.runIf(sandboxEnv.office)('LibreOffice stuck: the job fails with the conversion timeout well within the limits and the sandbox is destroyed', async () => {
    const member = await newMember();
    const { projectId, fileId } = await importTender(member, {
      name: '招标文件.doc',
      extension: 'doc',
      mime: 'application/msword',
      content: readFileSync(new URL('sample.doc', samples)),
    });
    const sandbox = stuckDriver('office', 10 * 60_000);
    const { error, elapsedMs } = await runJob(member, projectId, fileId, sandbox);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: 'PARSE_OFFICE_CONVERSION_TIMEOUT', message: '老式 Word 文件转换超时（超过 8 分钟），请另存为 docx 后重新导入' });
    // 转换上限 5 秒；另含创建沙箱、放入原件和销毁的开销。
    expect(elapsedMs).toBeLessThan(45_000);
    await expectDestroyed(sandbox.created);
    expect((await loadTechnicalPlan(appDb, member, projectId)).tenderFiles[0]).toMatchObject({
      status: 'error',
      error: '老式 Word 文件转换超时（超过 8 分钟），请另存为 docx 后重新导入',
      markdownArtifactId: null,
    });
    expect(await listArtifacts(appDb, member, { sourceFileId: fileId, limit: 10 })).toEqual([]);
  });

  it('the whole parse command stuck: the command time limit terminates the sandbox, the job fails with PARSE_TIMEOUT and destroys it', async () => {
    const member = await newMember();
    const { projectId, fileId } = await importTender(member, {
      name: '招标文件.pdf',
      extension: 'pdf',
      mime: 'application/pdf',
      content: readFileSync(new URL('sample.pdf', samples)),
    });
    const sandbox = stuckDriver('entry', 8_000);
    const { error, elapsedMs } = await runJob(member, projectId, fileId, sandbox);
    expect(error).toMatchObject({ code: 'PARSE_TIMEOUT', message: '文件解析超时（超过 10 分钟）' });
    expect(elapsedMs).toBeGreaterThanOrEqual(8_000);
    expect(elapsedMs).toBeLessThan(45_000);
    await expectDestroyed(sandbox.created);
    expect((await loadTechnicalPlan(appDb, member, projectId)).tenderFiles[0]).toMatchObject({ status: 'error', error: '文件解析超时（超过 10 分钟）' });
  });
});
