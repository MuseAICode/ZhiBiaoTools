// 技术方案整本导出接口（路线图 7.4h，src/routes/technicalPlan.ts 的 /api/projects/:projectId/technical-plan/export）的数据库与接口测试：
// 1. 入队：需要登录；项目不属于本组织、不存在或不是技术方案时 404，不保存不入队；没有目录时 400 EXPORT_EMPTY，不保存不入队；
//    合法时 202，返回 requestId 与项目级的 technical-plan-export 任务（响应不含参数）；同一项目已有未结束的导出时 409 JOB_LOCKED，
//    原来的请求不动；
// 2. 状态与下载：未完成 pending / 409，完成后 ready（文件名、大小、提示与消息）与附件下载（docx 类型、长度、nosniff、sandbox CSP、
//    项目名称_时间.docx），同组织其他成员可见；产物被替换或对象缺失时 expired / 410；其他项目、其他组织的请求与不存在的一样 404；
//    新的导出入队后旧的请求 404；没有对象存储时下载 503；
// 3. 按用户限流：超出 technicalPlanExportPerUser 时 429 与 Retry-After，不保存不入队，其他用户不受影响。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { TECHNICAL_PLAN_EXPORT_JOB_TYPE, technicalPlanExportLockKey } from '../../src/export/documentJob.ts';
import { completeTechnicalPlanExportRequest, findTechnicalPlanExportRequest } from '../../src/export/documentRequestStore.ts';
import { writeTechnicalPlanExportArtifact } from '../../src/export/documentStore.ts';
import { attachmentDisposition } from '../../src/files/filename.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { technicalPlanExportFileName } from '../../src/routes/technicalPlan.ts';
import { saveGenerationConfig, saveOutline } from '../../src/technicalPlan/store.ts';
import { defaultExportFormat } from '../../src/templates/exportFormat.ts';
import { createTemplate } from '../../src/templates/store.ts';
import { syncSystemTemplates } from '../../src/templates/system.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { buildZip } from '../sandbox/zipFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const PASSWORD = 'quiet-harbor-maple-58';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const RELAXED_LIMITS: AuthRateLimitSettings = Object.fromEntries(
  Object.entries(DEFAULT_AUTH_RATE_LIMITS).map(([key, value]) => [
    key,
    'limit' in value ? { ...value, limit: 10_000 } : { ...value, freeFailures: 10_000 },
  ]),
) as unknown as AuthRateLimitSettings;

const DOCX = buildZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
]);

interface Member {
  userId: string;
  orgId: string;
  cookie: string;
  context: TenantContext;
}

let testDb: TestDatabase;
let superuser: Kysely<any>;
let owner: Kysely<Database>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let app: FastifyInstance;
let strictApp: FastifyInstance;
let noStorageApp: FastifyInstance;

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

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

/** 新建一个用户及其组织（owner），或以普通成员加入已有组织，并登录。 */
async function newMember(orgId: string = randomUUID()): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  const existing = await superuser.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
  if (!existing) await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'team' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  const role = existing ? 'member' : 'owner';
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { userId, orgId, cookie: await login(email), context: { orgId, userId, role } };
}

async function newProject(member: Member, kind = 'technical-plan'): Promise<string> {
  return (await superuser.insertInto('projects')
    .values({ org_id: member.orgId, kind, name: '项目', created_by: member.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

/** 一个有正文的人工小节（默认系统模板由 syncSystemTemplates 提供）。 */
async function fillOutline(member: Member, projectId: string, projectName = '智慧园区技术方案') {
  const manual = randomUUID();
  await saveOutline(appDb, member.context, projectId, {
    reason: 'replace',
    outlineData: { project_name: projectName, outline: [{ id: manual, title: '人工小节', content_mode: 'manual-fill' }] },
  });
  await superuser.updateTable('technical_plan_outline_nodes').set({ content: '人工正文' }).where('project_id', '=', projectId).where('node_id', '=', manual).execute();
}

function call(member: Member | null, method: 'GET' | 'POST', url: string, target: FastifyInstance = app) {
  return target.inject({
    method,
    url: `/api/projects${url}`,
    headers: { ...sameSiteHeaders, ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}) },
  });
}

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

async function enqueue(member: Member, projectId: string, target: FastifyInstance = app) {
  const response = await call(member, 'POST', `/${projectId}/technical-plan/export`, target);
  expect(response.statusCode, response.body).toBe(202);
  return response.json() as { requestId: string; job: { id: string; type: string; status: string; projectId: string | null } };
}

async function countRows(projectId: string) {
  const requests = await superuser.selectFrom('technical_plan_export_requests').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('project_id', '=', projectId).executeTakeFirstOrThrow();
  const jobs = await superuser.selectFrom('jobs').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('project_id', '=', projectId).where('type', '=', TECHNICAL_PLAN_EXPORT_JOB_TYPE).executeTakeFirstOrThrow();
  return { requests: Number(requests.n), jobs: Number(jobs.n) };
}

async function finishJobs(projectId: string) {
  await superuser.updateTable('jobs').set({ status: 'succeeded', finished_at: sql`now()` }).where('project_id', '=', projectId)
    .where('finished_at', 'is', null).execute();
}

/** 模拟任务完成：写入整本导出产物并写回结果（任务本身见 technicalPlanExportJob.test.ts）。 */
async function complete(member: Member, projectId: string, requestId: string, content: Buffer = DOCX, warnings: string[] = []) {
  const artifact = await writeTechnicalPlanExportArtifact(appDb, member.context, store, projectId, content);
  const message = warnings.length ? `Word 已导出，但有 ${warnings.length} 处提示。` : 'Word 已导出，请打开文档核对图片、表格和版式。';
  expect(await completeTechnicalPlanExportRequest(appDb, member.context, requestId, { artifactId: artifact.id, warnings, message })).not.toBeNull();
  await finishJobs(projectId);
  return { artifact, message };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = connect(testDb.ownerConfig) as Kysely<Database>;
  expect((await migrateToLatest(owner as Kysely<unknown>)).error).toBeUndefined();
  await syncSystemTemplates(owner as Kysely<unknown> as never);
  superuser = testDb.admin;
  database = createDatabase(testDb.appConfig);
  appDb = database.db;
  const common = { database, passwordHasher: await fastHasher(), mailer: { send: async () => {} } };
  const config = { ...testConfig, database: testDb.appConfig };
  app = await buildApp(config, { ...common, rateLimits: RELAXED_LIMITS, objectStore: store });
  strictApp = await buildApp(config, {
    ...common,
    rateLimits: { ...RELAXED_LIMITS, technicalPlanExportPerUser: { limit: 2, windowMs: 60_000 } },
    objectStore: store,
  });
  noStorageApp = await buildApp(config, { ...common, rateLimits: RELAXED_LIMITS });
});

afterAll(async () => {
  await app?.close();
  await strictApp?.close();
  await noStorageApp?.close();
  await database?.destroy();
  await owner?.destroy();
  await testDb?.drop();
});

describe('POST /api/projects/:projectId/technical-plan/export', () => {
  it('需要登录', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    expect((await call(null, 'POST', `/${projectId}/technical-plan/export`)).statusCode).toBe(401);
    expect(await countRows(projectId)).toEqual({ requests: 0, jobs: 0 });
  });

  it('其他组织的项目、不存在的项目、不是技术方案的项目：404，不保存不入队', async () => {
    const member = await newMember();
    const stranger = await newMember();
    const foreign = await newProject(stranger);
    await fillOutline(stranger, foreign);
    const report = await newProject(member, 'feasibility-report');
    await expectError(await call(member, 'POST', `/${foreign}/technical-plan/export`), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(member, 'POST', `/${randomUUID()}/technical-plan/export`), 404, 'PROJECT_NOT_FOUND');
    await expectError(await call(member, 'POST', `/${report}/technical-plan/export`), 404, 'PROJECT_NOT_FOUND');
    expect(await countRows(foreign)).toEqual({ requests: 0, jobs: 0 });
    expect(await countRows(report)).toEqual({ requests: 0, jobs: 0 });
  });

  it('没有目录：400 EXPORT_EMPTY，不保存不入队', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await expectError(await call(member, 'POST', `/${projectId}/technical-plan/export`), 400, 'EXPORT_EMPTY');
    expect(await countRows(projectId)).toEqual({ requests: 0, jobs: 0 });
  });

  it('合法时 202：保存请求、新建项目级的 technical-plan-export 任务（响应不含参数）', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillOutline(member, projectId);
    const result = await enqueue(member, projectId);
    expect(result.job).toMatchObject({ type: TECHNICAL_PLAN_EXPORT_JOB_TYPE, status: 'queued', projectId });
    expect(result.job).not.toHaveProperty('params');
    const row = await superuser.selectFrom('jobs').select(['lock_key', 'params', 'user_id']).where('id', '=', result.job.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ lock_key: technicalPlanExportLockKey(projectId), params: { requestId: result.requestId }, user_id: member.userId });
    const request = await findTechnicalPlanExportRequest(appDb, member.context, result.requestId);
    expect(request).toMatchObject({ projectId, createdBy: member.userId, projectName: '智慧园区技术方案', result: null });
  });

  it('所选模板的配置缺少 page 一节（#43 发现的问题第 1 项）：入队时规范化，交给助手的配置补齐了 page', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillOutline(member, projectId);
    const { page: _page, ...withoutPage } = { ...defaultExportFormat(), template_name: '缺页面的模板' } as Record<string, unknown>;
    const template = await createTemplate(appDb, member.context, withoutPage);
    expect(template.config).not.toHaveProperty('page');
    await saveGenerationConfig(appDb, member.context, projectId, { exportTemplateId: template.id });
    const { requestId } = await enqueue(member, projectId);
    const request = (await findTechnicalPlanExportRequest(appDb, member.context, requestId))!;
    expect(request.exportFormat.template_name).toBe('缺页面的模板');
    expect(request.exportFormat.page).toEqual(defaultExportFormat().page);
    const stored = await superuser.selectFrom('technical_plan_export_requests').select('export_format').where('id', '=', requestId).executeTakeFirstOrThrow();
    expect(stored.export_format.page).toEqual(defaultExportFormat().page);
  });

  it('同一项目已有未结束的导出：409 JOB_LOCKED，原来的请求与任务不动；同组织其他成员同样受互斥约束', async () => {
    const member = await newMember();
    const colleague = await newMember(member.orgId);
    const projectId = await newProject(member);
    await fillOutline(member, projectId);
    const first = await enqueue(member, projectId);
    await expectError(await call(member, 'POST', `/${projectId}/technical-plan/export`), 409, 'JOB_LOCKED');
    await expectError(await call(colleague, 'POST', `/${projectId}/technical-plan/export`), 409, 'JOB_LOCKED');
    expect(await countRows(projectId)).toEqual({ requests: 1, jobs: 1 });
    expect(await findTechnicalPlanExportRequest(appDb, member.context, first.requestId)).not.toBeNull();
  });

  it('按用户限流：超出时 429 与 Retry-After，不保存不入队；其他用户不受影响', async () => {
    const member = await newMember();
    const colleague = await newMember(member.orgId);
    const projectId = await newProject(member);
    await fillOutline(member, projectId);
    const url = `/${projectId}/technical-plan/export`;
    // 第一次入队，第二次 409（同样计数），第三次超出。
    await enqueue(member, projectId, strictApp);
    await expectError(await call(member, 'POST', url, strictApp), 409, 'JOB_LOCKED');
    await finishJobs(projectId);
    const limited = await call(member, 'POST', url, strictApp);
    await expectError(limited, 429, 'TOO_MANY_REQUESTS');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(await countRows(projectId)).toEqual({ requests: 1, jobs: 1 });
    await enqueue(colleague, projectId, strictApp);
    expect(await countRows(projectId)).toEqual({ requests: 1, jobs: 2 });
  });
});

describe('GET /api/projects/:projectId/technical-plan/export/:requestId', () => {
  it('未完成：pending，下载 409 EXPORT_NOT_READY', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillOutline(member, projectId);
    const { requestId } = await enqueue(member, projectId);
    const status = await call(member, 'GET', `/${projectId}/technical-plan/export/${requestId}`);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.json()).toMatchObject({ id: requestId, status: 'pending', fileName: null, size: null, warnings: [], message: null, completedAt: null });
    await expectError(await call(member, 'GET', `/${projectId}/technical-plan/export/${requestId}/content`), 409, 'EXPORT_NOT_READY');
  });

  it('完成后：ready 与提示、消息；附件下载（类型、长度、nosniff、CSP、项目名称_时间.docx）；同组织其他成员可见，id 不区分大小写', async () => {
    const member = await newMember();
    const colleague = await newMember(member.orgId);
    const projectId = await newProject(member);
    await fillOutline(member, projectId, '园区/一期:技术方案');
    const { requestId } = await enqueue(member, projectId);
    const { artifact, message } = await complete(member, projectId, requestId, DOCX, ['“人工小节”中有 1 张图片无法导出']);
    const record = (await findTechnicalPlanExportRequest(appDb, member.context, requestId))!;
    const fileName = technicalPlanExportFileName(record);
    expect(fileName).toMatch(/^园区.一期.技术方案_\d{8}_\d{6}\.docx$/);
    expect(fileName).not.toMatch(/[/:]/);

    for (const reader of [member, colleague]) {
      const status = await call(reader, 'GET', `/${projectId}/technical-plan/export/${requestId.toUpperCase()}`);
      expect(status.statusCode, status.body).toBe(200);
      expect(status.json()).toMatchObject({
        id: requestId, status: 'ready', fileName, size: DOCX.length, warnings: ['“人工小节”中有 1 张图片无法导出'], message,
      });
      expect(status.json().completedAt).not.toBeNull();

      const download = await call(reader, 'GET', `/${projectId}/technical-plan/export/${requestId}/content`);
      expect(download.statusCode, download.body).toBe(200);
      expect(download.rawPayload.equals(DOCX)).toBe(true);
      expect(download.headers['content-type']).toBe(DOCX_MIME);
      expect(download.headers['content-length']).toBe(String(DOCX.length));
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(download.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(download.headers['cache-control']).toBe('no-store');
      expect(download.headers['content-disposition']).toBe(attachmentDisposition(fileName));
    }
    expect(artifact.size).toBe(DOCX.length);
  });

  it('项目名称为空时文件名用“标书文档”', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillOutline(member, projectId, '');
    const { requestId } = await enqueue(member, projectId);
    await complete(member, projectId, requestId);
    const status = await call(member, 'GET', `/${projectId}/technical-plan/export/${requestId}`);
    expect(status.json().fileName).toMatch(/^标书文档_\d{8}_\d{6}\.docx$/);
  });

  it('其他项目、其他组织的请求与不存在的一样 404', async () => {
    const member = await newMember();
    const stranger = await newMember();
    const projectId = await newProject(member);
    const otherProject = await newProject(member);
    const foreignProject = await newProject(stranger);
    await fillOutline(member, projectId);
    await fillOutline(stranger, foreignProject);
    const { requestId } = await enqueue(member, projectId);
    const foreign = await enqueue(stranger, foreignProject);
    await complete(member, projectId, requestId);
    await complete(stranger, foreignProject, foreign.requestId);
    for (const suffix of ['', '/content']) {
      await expectError(await call(member, 'GET', `/${otherProject}/technical-plan/export/${requestId}${suffix}`), 404, 'EXPORT_NOT_FOUND');
      await expectError(await call(member, 'GET', `/${projectId}/technical-plan/export/${foreign.requestId}${suffix}`), 404, 'EXPORT_NOT_FOUND');
      await expectError(await call(member, 'GET', `/${projectId}/technical-plan/export/${randomUUID()}${suffix}`), 404, 'EXPORT_NOT_FOUND');
      await expectError(await call(stranger, 'GET', `/${projectId}/technical-plan/export/${requestId}${suffix}`), 404, 'PROJECT_NOT_FOUND');
    }
    expect((await call(member, 'GET', `/${projectId}/technical-plan/export/not-a-uuid`)).statusCode).toBe(400);
  });

  it('新的导出入队后旧的请求 404；产物被替换时 expired / 410；对象缺失时 410', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillOutline(member, projectId);
    const first = await enqueue(member, projectId);
    await complete(member, projectId, first.requestId);
    const second = await enqueue(member, projectId);
    await expectError(await call(member, 'GET', `/${projectId}/technical-plan/export/${first.requestId}`), 404, 'EXPORT_NOT_FOUND');

    const { artifact } = await complete(member, projectId, second.requestId);
    // 对象缺失：状态仍是 ready（产物行还在），下载 410。
    const saved = objects.get(artifact.storageKey)!;
    objects.delete(artifact.storageKey);
    await expectError(await call(member, 'GET', `/${projectId}/technical-plan/export/${second.requestId}/content`), 410, 'EXPORT_EXPIRED');
    objects.set(artifact.storageKey, saved);
    // 产物被替换（例如另一次导出先写完）：expired / 410。
    await writeTechnicalPlanExportArtifact(appDb, member.context, store, projectId, DOCX);
    const status = await call(member, 'GET', `/${projectId}/technical-plan/export/${second.requestId}`);
    expect(status.json()).toMatchObject({ status: 'expired', fileName: null, size: null });
    await expectError(await call(member, 'GET', `/${projectId}/technical-plan/export/${second.requestId}/content`), 410, 'EXPORT_EXPIRED');
  });

  it('没有对象存储：下载 503', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillOutline(member, projectId);
    const { requestId } = await enqueue(member, projectId);
    await complete(member, projectId, requestId);
    await expectError(await call(member, 'GET', `/${projectId}/technical-plan/export/${requestId}/content`, noStorageApp), 503, 'FILE_STORAGE_DISABLED');
  });
});
