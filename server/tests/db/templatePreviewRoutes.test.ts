// 模板样张接口（路线图 7.3e，src/routes/templates.ts 的 /api/export-templates/preview）的数据库与接口测试：
// 1. 入队：需要登录；样张不合法时 400 PREVIEW_HTML_INVALID、不保存不入队；请求体多余字段、用途不合法时 400；合法时 202，
//    返回 requestId 与组织级的 template-preview 任务；同一用户的新样张取消排队中的旧样张（supersededJobIds）；
// 2. 样张导出 Word（purpose: word）：入队 template-word-export，不取消排队中的样张，也不被之后的样张取消；
// 3. 状态与下载：未完成 pending / 409，完成后 ready 与附件下载（docx 类型、nosniff、sandbox CSP、模板名_时间.docx），
//    产物被清理后 expired / 410；其他用户（同组织或其他组织）的请求与不存在的一样 404；没有对象存储时下载 503；
// 4. 按用户限流：超出 templatePreviewPerUser 时 429 与 Retry-After，不入队，其他用户不受影响。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { TEMPLATE_PREVIEW_JOB_TYPE, TEMPLATE_WORD_EXPORT_JOB_TYPE } from '../../src/export/previewJob.ts';
import { completeTemplatePreviewRequest, findTemplatePreviewRequest, writeTemplatePreviewArtifact } from '../../src/export/previewStore.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { defaultExportFormat } from '../../src/templates/exportFormat.ts';
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

const template = readFileSync(new URL('../../../client/electron/resources/content-generation/正文模板.html', import.meta.url), 'utf8');
const SAMPLE = template.replace(/src="assets\/([a-z-]+)\.webp"/g, (_match, name: string) => `src="/assets/${name}-Bx7Kq2Lm.webp"`);
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

function call(member: Member | null, method: 'GET' | 'POST', url: string, payload?: object, target: FastifyInstance = app) {
  return target.inject({
    method,
    url: `/api/export-templates${url}`,
    headers: { ...sameSiteHeaders, ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

function body(name = '样张', extra: Record<string, unknown> = {}) {
  return { html: SAMPLE, exportFormat: { ...defaultExportFormat(), template_name: name }, ...extra };
}

async function enqueue(member: Member, payload: object = body(), target: FastifyInstance = app) {
  const response = await call(member, 'POST', '/preview', payload, target);
  expect(response.statusCode, response.body).toBe(202);
  return response.json() as { requestId: string; job: { id: string; type: string; status: string; projectId: string | null }; supersededJobIds: string[] };
}

async function jobStatus(jobId: string): Promise<string> {
  const row = await superuser.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow();
  return row.status;
}

async function countRows(table: 'jobs' | 'template_preview_requests', member: Member): Promise<number> {
  const column = table === 'jobs' ? 'user_id' : 'created_by';
  const row = await superuser.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('n')).where(column, '=', member.userId).executeTakeFirstOrThrow();
  return Number(row.n);
}

/** 模拟任务完成：按请求的输入哈希写入样张产物并写回结果（任务本身见 templatePreviewJob.test.ts）。 */
async function complete(member: Member, requestId: string, content: Buffer = DOCX) {
  const request = (await findTemplatePreviewRequest(appDb, member.context, requestId))!;
  const artifact = await writeTemplatePreviewArtifact(appDb, member.context, store, Buffer.from(request.inputSha256, 'hex'), content);
  expect(await completeTemplatePreviewRequest(appDb, member.context, requestId, artifact.id)).not.toBeNull();
  return artifact;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = connect(testDb.ownerConfig) as Kysely<Database>;
  expect((await migrateToLatest(owner as Kysely<unknown>)).error).toBeUndefined();
  superuser = testDb.admin;
  database = createDatabase(testDb.appConfig);
  appDb = database.db;
  const common = { database, passwordHasher: await fastHasher(), mailer: { send: async () => {} } };
  const config = { ...testConfig, database: testDb.appConfig };
  app = await buildApp(config, { ...common, rateLimits: RELAXED_LIMITS, objectStore: store });
  strictApp = await buildApp(config, {
    ...common,
    rateLimits: { ...RELAXED_LIMITS, templatePreviewPerUser: { limit: 2, windowMs: 60_000 } },
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

describe('POST /api/export-templates/preview', () => {
  it('需要登录', async () => {
    const response = await call(null, 'POST', '/preview', body());
    expect(response.statusCode).toBe(401);
  });

  it('样张不合法时 400，不保存请求、不入队', async () => {
    const member = await newMember();
    await expectError(await call(member, 'POST', '/preview', body('样张', { html: '<p>正文</p><script>alert(1)</script>' })), 400, 'PREVIEW_HTML_INVALID');
    await expectError(await call(member, 'POST', '/preview', body('样张', { html: '' })), 400, 'PREVIEW_HTML_INVALID');
    await expectError(await call(member, 'POST', '/preview', body('样张', { html: '<p>x</p>'.repeat(40_000) })), 400, 'BAD_REQUEST');
    expect(await countRows('template_preview_requests', member)).toBe(0);
    expect(await countRows('jobs', member)).toBe(0);
  });

  it('请求体多余字段、用途不合法、配置不是对象时 400', async () => {
    const member = await newMember();
    for (const payload of [body('样张', { extra: 1 }), body('样张', { purpose: 'document' }), { html: SAMPLE, exportFormat: 'x' }, { html: SAMPLE }]) {
      const response = await call(member, 'POST', '/preview', payload);
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(await countRows('jobs', member)).toBe(0);
  });

  it('合法时 202：保存请求、新建组织级的 template-preview 任务', async () => {
    const member = await newMember();
    const result = await enqueue(member);
    expect(result.job).toMatchObject({ type: TEMPLATE_PREVIEW_JOB_TYPE, status: 'queued', projectId: null });
    expect(result.supersededJobIds).toEqual([]);
    expect(result.job).not.toHaveProperty('params');
    const request = await findTemplatePreviewRequest(appDb, member.context, result.requestId);
    expect(request).toMatchObject({ createdBy: member.userId, artifactId: null });
    expect(request!.html).not.toContain('src=');
    const job = await superuser.selectFrom('jobs').select(['params', 'lock_key', 'org_id']).where('id', '=', result.job.id).executeTakeFirstOrThrow();
    expect(job).toEqual({ params: { requestId: result.requestId }, lock_key: null, org_id: member.orgId });
  });

  it('同一用户的新样张取消排队中的旧样张，同事的不受影响', async () => {
    const member = await newMember();
    const colleague = await newMember(member.orgId);
    const theirs = await enqueue(colleague);
    const first = await enqueue(member, body('一'));
    const second = await enqueue(member, body('二'));
    expect(second.supersededJobIds).toEqual([first.job.id]);
    expect(await jobStatus(first.job.id)).toBe('cancelled');
    expect(await jobStatus(second.job.id)).toBe('queued');
    expect(await jobStatus(theirs.job.id)).toBe('queued');
  });

  it('样张导出 Word 不参与取代：不取消排队中的样张，也不被之后的样张取消', async () => {
    const member = await newMember();
    const preview = await enqueue(member, body('一'));
    const word = await enqueue(member, body('一', { purpose: 'word' }));
    expect(word.job).toMatchObject({ type: TEMPLATE_WORD_EXPORT_JOB_TYPE, status: 'queued', projectId: null });
    expect(word.supersededJobIds).toEqual([]);
    const next = await enqueue(member, body('二'));
    expect(next.supersededJobIds).toEqual([preview.job.id]);
    expect(await jobStatus(word.job.id)).toBe('queued');
    const secondWord = await enqueue(member, body('二', { purpose: 'word' }));
    expect(secondWord.supersededJobIds).toEqual([]);
    expect(await jobStatus(word.job.id)).toBe('queued');
    expect(await jobStatus(next.job.id)).toBe('queued');
  });

  it('按用户限流：超出时 429 与 Retry-After，不入队；其他用户不受影响', async () => {
    const member = await newMember();
    const other = await newMember();
    await enqueue(member, body(), strictApp);
    await enqueue(member, body('样张', { purpose: 'word' }), strictApp);
    const response = await call(member, 'POST', '/preview', body(), strictApp);
    await expectError(response, 429, 'TOO_MANY_REQUESTS');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(await countRows('jobs', member)).toBe(2);
    // 不合法的请求同样计数（限流在校验之前）。
    await expectError(await call(other, 'POST', '/preview', body('样张', { html: '<script></script>' }), strictApp), 400, 'PREVIEW_HTML_INVALID');
    await enqueue(other, body(), strictApp);
    await expectError(await call(other, 'POST', '/preview', body(), strictApp), 429, 'TOO_MANY_REQUESTS');
  });
});

describe('GET /api/export-templates/preview/:requestId(/content)', () => {
  it('未完成时 pending，下载 409', async () => {
    const member = await newMember();
    const { requestId } = await enqueue(member);
    const status = await call(member, 'GET', `/preview/${requestId}`);
    expect(status.statusCode).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.json()).toMatchObject({ id: requestId, status: 'pending', fileName: null, size: null, completedAt: null });
    await expectError(await call(member, 'GET', `/preview/${requestId}/content`), 409, 'PREVIEW_NOT_READY');
  });

  it('完成后 ready，以附件下载 docx', async () => {
    const member = await newMember();
    const { requestId } = await enqueue(member, body('投标/模板"A"'));
    await complete(member, requestId);
    const status = (await call(member, 'GET', `/preview/${requestId}`)).json();
    expect(status).toMatchObject({ id: requestId, status: 'ready', size: DOCX.length });
    expect(status.fileName).toMatch(/^投标_模板_A__\d{8}_\d{6}\.docx$/);
    expect(typeof status.completedAt).toBe('string');

    const response = await call(member, 'GET', `/preview/${requestId}/content`);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(DOCX)).toBe(true);
    expect(response.headers).toMatchObject({
      'content-type': DOCX_MIME,
      'content-length': String(DOCX.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    expect(String(response.headers['cache-control'])).toContain('no-store');
    const disposition = String(response.headers['content-disposition']);
    expect(disposition.startsWith('attachment; ')).toBe(true);
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(status.fileName)}`);
  });

  it('模板名为空时文件名用“模板样张”', async () => {
    const member = await newMember();
    const { requestId } = await enqueue(member, body('  '));
    await complete(member, requestId);
    const status = (await call(member, 'GET', `/preview/${requestId}`)).json();
    // 规范化后空模板名取默认值（与桌面版 normalizeExportFormat 相同）；无论哪种，都不为空。
    expect(status.fileName).toMatch(/^.+_\d{8}_\d{6}\.docx$/);
  });

  it('其他用户（同组织或其他组织）的与不存在的一样 404', async () => {
    const member = await newMember();
    const colleague = await newMember(member.orgId);
    const stranger = await newMember();
    const { requestId } = await enqueue(member);
    await complete(member, requestId);
    for (const who of [colleague, stranger]) {
      await expectError(await call(who, 'GET', `/preview/${requestId}`), 404, 'PREVIEW_NOT_FOUND');
      await expectError(await call(who, 'GET', `/preview/${requestId}/content`), 404, 'PREVIEW_NOT_FOUND');
    }
    await expectError(await call(member, 'GET', `/preview/${randomUUID()}`), 404, 'PREVIEW_NOT_FOUND');
    expect((await call(member, 'GET', '/preview/not-a-uuid')).statusCode).toBe(400);
    expect((await call(null, 'GET', `/preview/${requestId}`)).statusCode).toBe(401);
    expect((await call(member, 'GET', `/preview/${requestId.toUpperCase()}`)).json().status).toBe('ready');
  });

  it('产物被清理后 expired，下载 410；对象缺失时下载 410', async () => {
    const member = await newMember();
    const first = await enqueue(member, body('一'));
    const artifact = await complete(member, first.requestId);
    await superuser.deleteFrom('artifacts').where('id', '=', artifact.id).execute();
    expect((await call(member, 'GET', `/preview/${first.requestId}`)).json()).toMatchObject({ status: 'expired', fileName: null, size: null });
    await expectError(await call(member, 'GET', `/preview/${first.requestId}/content`), 410, 'PREVIEW_EXPIRED');

    const second = await enqueue(member, body('二'));
    const other = await complete(member, second.requestId, buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'word/document.xml', data: Buffer.from('<w:document>2</w:document>') },
    ]));
    objects.delete(other.storageKey);
    await expectError(await call(member, 'GET', `/preview/${second.requestId}/content`), 410, 'PREVIEW_EXPIRED');
  });

  it('没有对象存储时下载 503', async () => {
    const member = await newMember();
    const { requestId } = await enqueue(member);
    await expectError(await call(member, 'GET', `/preview/${requestId}/content`, undefined, noStorageApp), 503, 'FILE_STORAGE_DISABLED');
  });
});
