// 可研报告导出 Word 接口（路线图 7.5e，src/routes/feasibilityReport.ts 的 /api/projects/:projectId/feasibility-report/export）的数据库与
// 接口测试（与技术方案整本导出的 tests/db/technicalPlanExportRoutes.test.ts 相同的结构）：
// 1. 入队：需要登录；项目不属于本组织、不存在或不是可研项目时 404，不保存不入队；没有目录、模板不可见时 400，不保存不入队；
//    请求体多余字段、选项类型不对、templateId 不是 uuid 时 400；合法时 202，返回 requestId 与项目级的 feasibility-report-export 任务
//    （响应不含参数），快照中的模板与选项取自请求；同一项目已有未结束的导出时 409 JOB_LOCKED，原来的请求不动；
// 2. 状态与下载：未完成 pending / 409，完成后 ready（文件名、大小、提示与消息）与附件下载（docx 类型、长度、nosniff、sandbox CSP、
//    项目名称_时间.docx，项目名称为空时“可行性研究报告”），同组织其他成员可见；产物被替换或对象缺失时 expired / 410；
//    其他项目、其他组织的请求与不存在的一样 404；新的导出入队后旧的请求 404；没有对象存储时下载 503；
// 3. 按用户限流：超出 feasibilityReportExportPerUser 时 429 与 Retry-After，不保存不入队，其他用户不受影响；与技术方案的限流分开计数。
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
import { FEASIBILITY_REPORT_EXPORT_JOB_TYPE, feasibilityReportExportLockKey } from '../../src/export/feasibilityJob.ts';
import { completeFeasibilityExportRequest, FEASIBILITY_EXPORT_OPTION_TEXT_MAX, findFeasibilityExportRequest } from '../../src/export/feasibilityRequestStore.ts';
import { writeFeasibilityExportArtifact } from '../../src/export/feasibilityStore.ts';
import { saveOutline, saveProjectInfo } from '../../src/feasibilityReport/store.ts';
import { attachmentDisposition } from '../../src/files/filename.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { feasibilityExportFileName } from '../../src/routes/feasibilityReport.ts';
import { normalizeExportFormat } from '../../src/templates/exportFormat.ts';
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

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

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

async function newProject(member: Member, kind = 'feasibility-report'): Promise<string> {
  return (await superuser.insertInto('projects')
    .values({ org_id: member.orgId, kind, name: '项目', created_by: member.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

async function fillProject(member: Member, projectId: string, projectName = '示例产业园') {
  await saveProjectInfo(appDb, member.context, projectId, { projectName: projectName || '临时名称' });
  if (!projectName) await superuser.updateTable('feasibility_report_meta').set({ project_name: '' }).where('project_id', '=', projectId).execute();
  await saveOutline(appDb, member.context, projectId, {
    reason: 'edit',
    outlineData: { outline: [{ id: '1', title: '总论', description: '', content: '总论的正文' }] },
  });
}

function call(member: Member | null, method: 'GET' | 'POST', url: string, payload?: object, target: FastifyInstance = app) {
  return target.inject({
    method,
    url: `/api/projects${url}`,
    headers: { ...sameSiteHeaders, ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

const body = (extra: Record<string, unknown> = {}) => ({ templateId: systemTemplateId, options: { documentCode: 'KYBG-000007' }, ...extra });

async function enqueue(member: Member, projectId: string, payload: object = body(), target: FastifyInstance = app) {
  const response = await call(member, 'POST', `/${projectId}/feasibility-report/export`, payload, target);
  expect(response.statusCode, response.body).toBe(202);
  return response.json() as { requestId: string; job: { id: string; type: string; status: string; projectId: string | null } };
}

async function countRows(projectId: string) {
  const requests = await superuser.selectFrom('feasibility_report_export_requests').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('project_id', '=', projectId).executeTakeFirstOrThrow();
  const jobs = await superuser.selectFrom('jobs').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('project_id', '=', projectId).where('type', '=', FEASIBILITY_REPORT_EXPORT_JOB_TYPE).executeTakeFirstOrThrow();
  return { requests: Number(requests.n), jobs: Number(jobs.n) };
}

async function finishJobs(projectId: string) {
  await superuser.updateTable('jobs').set({ status: 'succeeded', finished_at: sql`now()` }).where('project_id', '=', projectId)
    .where('finished_at', 'is', null).execute();
}

/** 模拟任务完成：写入可研导出产物并写回结果（任务本身见 feasibilityExportJob.test.ts）。 */
async function complete(member: Member, projectId: string, requestId: string, warnings: string[] = []) {
  const artifact = await writeFeasibilityExportArtifact(appDb, member.context, store, projectId, DOCX);
  const message = warnings.length ? `Word 已导出，但有 ${warnings.length} 处图片未能插入，请打开文档核对。` : 'Word 已导出，请打开文档核对图片、表格和版式。';
  expect(await completeFeasibilityExportRequest(appDb, member.context, requestId, { artifactId: artifact.id, warnings, message })).not.toBeNull();
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
  systemTemplateId = (await superuser.selectFrom('export_templates').select('id').where('org_id', 'is', null).executeTakeFirstOrThrow()).id;
  const common = { database, passwordHasher: await fastHasher(), mailer: { send: async () => {} } };
  const config = { ...testConfig, database: testDb.appConfig };
  app = await buildApp(config, { ...common, rateLimits: RELAXED_LIMITS, objectStore: store });
  strictApp = await buildApp(config, {
    ...common,
    rateLimits: { ...RELAXED_LIMITS, feasibilityReportExportPerUser: { limit: 2, windowMs: 60_000 } },
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

describe('POST /api/projects/:projectId/feasibility-report/export', () => {
  it('需要登录', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    expect((await call(null, 'POST', `/${projectId}/feasibility-report/export`, body())).statusCode).toBe(401);
    expect(await countRows(projectId)).toEqual({ requests: 0, jobs: 0 });
  });

  it('其他组织的项目、不存在的项目、不是可研的项目：404，不保存不入队', async () => {
    const member = await newMember();
    const stranger = await newMember();
    const foreign = await newProject(stranger);
    await fillProject(stranger, foreign);
    const plan = await newProject(member, 'technical-plan');
    for (const projectId of [foreign, randomUUID(), plan]) {
      await expectError(await call(member, 'POST', `/${projectId}/feasibility-report/export`, body()), 404, 'PROJECT_NOT_FOUND');
    }
    expect(await countRows(foreign)).toEqual({ requests: 0, jobs: 0 });
    expect(await countRows(plan)).toEqual({ requests: 0, jobs: 0 });
  });

  it('没有目录、模板不存在或属于其他组织：400，不保存不入队；请求体不合法：400', async () => {
    const member = await newMember();
    const stranger = await newMember();
    const projectId = await newProject(member);
    await expectError(await call(member, 'POST', `/${projectId}/feasibility-report/export`, body()), 400, 'EXPORT_EMPTY');
    await fillProject(member, projectId);
    const foreignTemplate = (await superuser.insertInto('export_templates')
      .values({ org_id: stranger.orgId, name: '他人模板', config: JSON.stringify({ template_name: '他人模板' }), created_by: stranger.userId, updated_by: stranger.userId })
      .returning('id').executeTakeFirstOrThrow()).id;
    for (const templateId of [randomUUID(), foreignTemplate]) {
      await expectError(await call(member, 'POST', `/${projectId}/feasibility-report/export`, body({ templateId })), 400, 'EXPORT_TEMPLATE_REQUIRED');
    }
    for (const payload of [
      {},
      { templateId: 'not-a-uuid' },
      body({ extra: 1 }),
      body({ options: { includeCover: 'yes' } }),
      body({ options: { baseDir: '/etc' } }),
      body({ options: { securityLevel: 'x'.repeat(FEASIBILITY_EXPORT_OPTION_TEXT_MAX + 1) } }),
      body({ options: [] }),
    ]) {
      const response = await call(member, 'POST', `/${projectId}/feasibility-report/export`, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await countRows(projectId)).toEqual({ requests: 0, jobs: 0 });
  });

  it('合法时 202：保存请求（模板与选项取自请求）、新建项目级的 feasibility-report-export 任务（响应不含参数）', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillProject(member, projectId);
    const result = await enqueue(member, projectId, body({
      templateId: systemTemplateId.toUpperCase(),
      options: { includeCover: false, preparationUnit: '编制单位甲', documentCode: 'KYBG-000007' },
    }));
    expect(result.job).toMatchObject({ type: FEASIBILITY_REPORT_EXPORT_JOB_TYPE, status: 'queued', projectId });
    expect(result.job).not.toHaveProperty('params');
    const row = await superuser.selectFrom('jobs').select(['lock_key', 'params', 'user_id']).where('id', '=', result.job.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ lock_key: feasibilityReportExportLockKey(projectId), params: { requestId: result.requestId }, user_id: member.userId });
    const request = (await findFeasibilityExportRequest(appDb, member.context, result.requestId))!;
    expect(request).toMatchObject({ projectId, createdBy: member.userId, projectName: '示例产业园', result: null });
    expect(request.options).toMatchObject({ includeCover: false, includePreparationNotes: true, preparationUnit: '编制单位甲', documentCode: 'KYBG-000007' });
    const template = await superuser.selectFrom('export_templates').select('config').where('id', '=', systemTemplateId).executeTakeFirstOrThrow();
    expect(request.exportFormat).toEqual(normalizeExportFormat(template.config));
    // 不给 options 时取桌面版的默认值，文件编号按桌面版规则生成。
    await finishJobs(projectId);
    const defaults = await enqueue(member, projectId, { templateId: systemTemplateId });
    expect((await findFeasibilityExportRequest(appDb, member.context, defaults.requestId))!.options.documentCode).toMatch(/^KYBG-\d{6}$/);
  });

  it('同一项目已有未结束的导出：409 JOB_LOCKED，原来的请求与任务不动；同组织其他成员同样受互斥约束', async () => {
    const member = await newMember();
    const colleague = await newMember(member.orgId);
    const projectId = await newProject(member);
    await fillProject(member, projectId);
    const first = await enqueue(member, projectId);
    await expectError(await call(member, 'POST', `/${projectId}/feasibility-report/export`, body()), 409, 'JOB_LOCKED');
    await expectError(await call(colleague, 'POST', `/${projectId}/feasibility-report/export`, body()), 409, 'JOB_LOCKED');
    expect(await countRows(projectId)).toEqual({ requests: 1, jobs: 1 });
    expect(await findFeasibilityExportRequest(appDb, member.context, first.requestId)).not.toBeNull();
  });

  it('按用户限流：超出时 429 与 Retry-After，不保存不入队；其他用户不受影响；与技术方案的导出分开计数', async () => {
    const member = await newMember();
    const colleague = await newMember(member.orgId);
    const projectId = await newProject(member);
    await fillProject(member, projectId);
    const url = `/${projectId}/feasibility-report/export`;
    await enqueue(member, projectId, body(), strictApp);
    await expectError(await call(member, 'POST', url, body(), strictApp), 409, 'JOB_LOCKED');
    await finishJobs(projectId);
    const limited = await call(member, 'POST', url, body(), strictApp);
    await expectError(limited, 429, 'TOO_MANY_REQUESTS');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(await countRows(projectId)).toEqual({ requests: 1, jobs: 1 });
    await enqueue(colleague, projectId, body(), strictApp);
    expect(await countRows(projectId)).toEqual({ requests: 1, jobs: 2 });
    // 可研的限流用尽后，同一用户的技术方案导出不受影响（走到技术方案自己的检查：没有目录）。
    const plan = await newProject(member, 'technical-plan');
    await expectError(await call(member, 'POST', `/${plan}/technical-plan/export`, undefined, strictApp), 400, 'EXPORT_EMPTY');
  });
});

describe('GET /api/projects/:projectId/feasibility-report/export/:requestId', () => {
  it('未完成：pending，下载 409 EXPORT_NOT_READY', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillProject(member, projectId);
    const { requestId } = await enqueue(member, projectId);
    const status = await call(member, 'GET', `/${projectId}/feasibility-report/export/${requestId}`);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.json()).toMatchObject({ id: requestId, status: 'pending', fileName: null, size: null, warnings: [], message: null, completedAt: null });
    await expectError(await call(member, 'GET', `/${projectId}/feasibility-report/export/${requestId}/content`), 409, 'EXPORT_NOT_READY');
  });

  it('完成后：ready 与提示、消息；附件下载（类型、长度、nosniff、CSP、项目名称_时间.docx）；同组织其他成员可见，id 不区分大小写', async () => {
    const member = await newMember();
    const colleague = await newMember(member.orgId);
    const projectId = await newProject(member);
    await fillProject(member, projectId, '园区/一期:可研');
    const { requestId } = await enqueue(member, projectId);
    const warnings = ['图片无法导出：选址图，未找到可用图片数据'];
    const { message } = await complete(member, projectId, requestId, warnings);
    const record = (await findFeasibilityExportRequest(appDb, member.context, requestId))!;
    const fileName = feasibilityExportFileName(record);
    expect(fileName).toMatch(/^园区.一期.可研_\d{8}_\d{6}\.docx$/);
    expect(fileName).not.toMatch(/[/:]/);

    for (const reader of [member, colleague]) {
      const status = await call(reader, 'GET', `/${projectId}/feasibility-report/export/${requestId.toUpperCase()}`);
      expect(status.statusCode, status.body).toBe(200);
      expect(status.json()).toMatchObject({ id: requestId, status: 'ready', fileName, size: DOCX.length, warnings, message });
      const download = await call(reader, 'GET', `/${projectId}/feasibility-report/export/${requestId}/content`);
      expect(download.statusCode, download.body).toBe(200);
      expect(download.rawPayload.equals(DOCX)).toBe(true);
      expect(download.headers['content-type']).toBe(DOCX_MIME);
      expect(download.headers['content-length']).toBe(String(DOCX.length));
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(download.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(download.headers['cache-control']).toBe('no-store');
      expect(download.headers['content-disposition']).toBe(attachmentDisposition(fileName));
    }
  });

  it('项目名称为空时文件名用“可行性研究报告”', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillProject(member, projectId, '');
    const { requestId } = await enqueue(member, projectId);
    await complete(member, projectId, requestId);
    const status = await call(member, 'GET', `/${projectId}/feasibility-report/export/${requestId}`);
    expect(status.json().fileName).toMatch(/^可行性研究报告_\d{8}_\d{6}\.docx$/);
  });

  it('其他项目、其他组织的请求与不存在的一样 404', async () => {
    const member = await newMember();
    const stranger = await newMember();
    const projectId = await newProject(member);
    const otherProject = await newProject(member);
    const foreignProject = await newProject(stranger);
    await fillProject(member, projectId);
    await fillProject(stranger, foreignProject);
    const { requestId } = await enqueue(member, projectId);
    const foreign = await enqueue(stranger, foreignProject);
    await complete(member, projectId, requestId);
    await complete(stranger, foreignProject, foreign.requestId);
    for (const suffix of ['', '/content']) {
      await expectError(await call(member, 'GET', `/${otherProject}/feasibility-report/export/${requestId}${suffix}`), 404, 'EXPORT_NOT_FOUND');
      await expectError(await call(member, 'GET', `/${projectId}/feasibility-report/export/${foreign.requestId}${suffix}`), 404, 'EXPORT_NOT_FOUND');
      await expectError(await call(member, 'GET', `/${projectId}/feasibility-report/export/${randomUUID()}${suffix}`), 404, 'EXPORT_NOT_FOUND');
      await expectError(await call(stranger, 'GET', `/${projectId}/feasibility-report/export/${requestId}${suffix}`), 404, 'PROJECT_NOT_FOUND');
    }
    expect((await call(member, 'GET', `/${projectId}/feasibility-report/export/not-a-uuid`)).statusCode).toBe(400);
  });

  it('新的导出入队后旧的请求 404；对象缺失时 410；产物被替换时 expired / 410', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillProject(member, projectId);
    const first = await enqueue(member, projectId);
    await complete(member, projectId, first.requestId);
    const second = await enqueue(member, projectId);
    await expectError(await call(member, 'GET', `/${projectId}/feasibility-report/export/${first.requestId}`), 404, 'EXPORT_NOT_FOUND');

    const { artifact } = await complete(member, projectId, second.requestId);
    const saved = objects.get(artifact.storageKey)!;
    objects.delete(artifact.storageKey);
    await expectError(await call(member, 'GET', `/${projectId}/feasibility-report/export/${second.requestId}/content`), 410, 'EXPORT_EXPIRED');
    objects.set(artifact.storageKey, saved);
    await writeFeasibilityExportArtifact(appDb, member.context, store, projectId, DOCX);
    const status = await call(member, 'GET', `/${projectId}/feasibility-report/export/${second.requestId}`);
    expect(status.json()).toMatchObject({ status: 'expired', fileName: null, size: null });
    await expectError(await call(member, 'GET', `/${projectId}/feasibility-report/export/${second.requestId}/content`), 410, 'EXPORT_EXPIRED');
  });

  it('没有对象存储：下载 503', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    await fillProject(member, projectId);
    const { requestId } = await enqueue(member, projectId);
    await complete(member, projectId, requestId);
    await expectError(await call(member, 'GET', `/${projectId}/feasibility-report/export/${requestId}/content`, undefined, noStorageApp), 503, 'FILE_STORAGE_DISABLED');
  });
});
