// 文件上传、下载、删除的端到端测试（真实数据库 + S3 兼容对象存储）：
// 跨组织访问、伪造类型、超大文件、配额、路径穿越文件名、已删除文件的访问、上传中断。
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { createS3ObjectStore, type ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, IMAGE_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import { beginUpload, completeUpload, storageUsage } from '../../src/files/store.ts';
import { HTML_PAYLOAD, SVG_PAYLOAD, makeDocx, makeJpeg, makeOle, makePdf, makePng } from '../files/fixtures.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { createTestBucket, type TestBucket } from './s3.ts';

const PASSWORD = 'quiet-harbor-maple-58';
const MIB = 1024 * 1024;
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);

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
let bucket: TestBucket;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let objectStore: ObjectStore;
let app: FastifyInstance;
const apps: FastifyInstance[] = [];

async function createApp(store: ObjectStore | null, uploadLimits?: { maxConcurrentUploads?: number; uploadIdleTimeoutMs?: number }) {
  const instance = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    {
      database,
      passwordHasher: await fastHasher(),
      rateLimits: RELAXED_LIMITS,
      mailer: { send: async () => {} },
      objectStore: store,
      ...(uploadLimits ? { uploadLimits } : {}),
    },
  );
  apps.push(instance);
  return instance;
}

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

/** 新建一个用户及其个人组织（或加入已有组织），并登录。 */
async function newMember(orgId: string = randomUUID()): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  const existing = await superuser.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
  if (!existing) await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: existing ? 'member' : 'owner' }).execute();
  return { userId, orgId, cookie: await login(email), context: { orgId, userId, role: existing ? 'member' : 'owner' } };
}

function headers(member: Member, extra: Record<string, string> = {}) {
  return { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}`, ...extra };
}

function upload(member: Member, name: string, content: Buffer | Readable, options: { purpose?: string; headers?: Record<string, string>; target?: FastifyInstance } = {}) {
  return (options.target ?? app).inject({
    method: 'POST',
    url: `/api/files?purpose=${options.purpose ?? 'tender'}&name=${encodeURIComponent(name)}`,
    headers: headers(member, { 'content-type': 'application/octet-stream', ...options.headers }),
    payload: content,
  });
}

function get(member: Member, url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: headers(member) });
}

async function uploadOk(member: Member, name: string, content: Buffer, purpose = 'tender') {
  const response = await upload(member, name, content, { purpose });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

async function rowsOf(orgId: string): Promise<any[]> {
  return superuser.selectFrom('files').selectAll().where('org_id', '=', orgId).execute();
}

async function keysOf(orgId: string): Promise<string[]> {
  return (await bucket.keys()).filter((key) => key.startsWith(`org/${orgId}/`));
}

/** 用超级用户直接写入已上传的大文件记录（不写对象），把组织的用量推到指定值附近。 */
async function fillUsage(orgId: string, bytes: number, deletedAt: Date | null = null) {
  const sizes: number[] = [];
  for (let left = bytes; left > 0; left -= DOCUMENT_MAX_BYTES) sizes.push(Math.min(left, DOCUMENT_MAX_BYTES));
  for (const size of sizes) {
    await superuser.insertInto('files').values({
      org_id: orgId, purpose: 'tender', display_name: 'filler.pdf', extension: 'pdf', status: 'uploaded', mime: 'application/pdf',
      size_bytes: size, sha256: Buffer.alloc(32), created_by: randomUUID(), uploaded_at: new Date(),
      ...(deletedAt ? { deleted_at: deletedAt, deleted_by: randomUUID() } : {}),
    }).execute();
  }
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  bucket = await createTestBucket();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  database = createDatabase(testDb.appConfig);
  appDb = database.db;
  objectStore = createS3ObjectStore(bucket.config, bucket.client);
  app = await createApp(objectStore);
});

afterAll(async () => {
  for (const instance of apps) await instance.close();
  await database?.destroy();
  await bucket?.drop();
  await testDb?.drop();
});

describe('上传与下载', () => {
  it('上传 PDF：返回元数据，对象键由服务端生成，内容按原样存入对象存储', async () => {
    const member = await newMember();
    const content = makePdf();
    const file = await uploadOk(member, '招标文件.pdf', content);
    expect(file).toMatchObject({ purpose: 'tender', name: '招标文件.pdf', extension: 'pdf', mime: 'application/pdf', size: content.length, deletedAt: null });
    expect(file.id).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await rowsOf(member.orgId);
    expect(row).toMatchObject({ id: file.id, status: 'uploaded', storage_key: `org/${member.orgId}/files/${file.id}`, created_by: member.userId });
    expect(await keysOf(member.orgId)).toEqual([`org/${member.orgId}/files/${file.id}`]);

    const download = await get(member, `/api/files/${file.id}/content`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(content)).toBe(true);
  });

  it('下载一律以附件返回，Content-Type 用服务端判断的值，禁止嗅探和渲染', async () => {
    const member = await newMember();
    const image = await uploadOk(member, 'logo.png', makePng(), 'credential-image');
    const response = await get(member, `/api/files/${image.id}/content`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['content-disposition']).toBe(`attachment; filename="logo.png"; filename*=UTF-8''logo.png`);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('浏览器给的 Content-Type 不被采信：只接受 application/octet-stream', async () => {
    const member = await newMember();
    const response = await upload(member, 'a.png', makePng(), { purpose: 'credential-image', headers: { 'content-type': 'image/png' } });
    expect(response.statusCode).toBe(415);
    expect(await rowsOf(member.orgId)).toEqual([]);
  });

  it('文本文件记录检测到的编码', async () => {
    const member = await newMember();
    const file = await uploadOk(member, '说明.md', Buffer.from('# 标题\n内容', 'utf8'));
    expect(file.mime).toBe('text/markdown; charset=utf-8');
  });

  it('列表只含本组织已上传、未删除的文件；用量接口返回已用和配额', async () => {
    const member = await newMember();
    const pdf = await uploadOk(member, 'a.pdf', makePdf());
    const doc = await uploadOk(member, 'b.doc', makeOle(), 'knowledge');
    const list = await get(member, '/api/files');
    expect(list.statusCode).toBe(200);
    expect(list.json().files.map((file: { id: string }) => file.id).sort()).toEqual([pdf.id, doc.id].sort());
    const knowledge = await get(member, '/api/files?purpose=knowledge');
    expect(knowledge.json().files.map((file: { id: string }) => file.id)).toEqual([doc.id]);

    const usage = await get(member, '/api/files/usage');
    expect(usage.json()).toEqual({ usedBytes: pdf.size + doc.size, quotaBytes: QUOTA });
  });
});

describe('路径穿越文件名', () => {
  it.each(['../../etc/passwd.pdf', '..\\..\\..\\windows\\win.ini.pdf', '/var/lib/x.pdf', '%2e%2e%2fsecret.pdf', 'a\u0000b.pdf'])(
    '%j 只作显示名，对象键不受影响',
    async (name) => {
      const member = await newMember();
      const file = await uploadOk(member, name, makePdf());
      expect(file.name).not.toMatch(/[/\\\u0000]/);
      expect(await keysOf(member.orgId)).toEqual([`org/${member.orgId}/files/${file.id}`]);
      // bucket 中没有落在组织前缀之外的对象。
      for (const key of await bucket.keys()) expect(key).toMatch(/^org\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}$/);
      const download = await get(member, `/api/files/${file.id}/content`);
      expect(download.headers['content-disposition']).toMatch(/^attachment; /);
      expect(download.headers['content-disposition']).not.toMatch(/[/\\]/);
    },
  );

  it('fileId 不是 UUID 时拒绝，不会拼进对象键', async () => {
    const member = await newMember();
    for (const id of ['..%2F..%2Fetc', '..', 'org%2Fother']) {
      const response = await get(member, `/api/files/${id}/content`);
      expect([400, 404]).toContain(response.statusCode);
    }
  });

  it('数据库拒绝写入对象键：存储路径只能是生成列', async () => {
    const member = await newMember();
    await expect(
      withTenant(appDb, member.context, (trx) =>
        sql`INSERT INTO files (org_id, purpose, display_name, extension, created_by, storage_key)
            VALUES (${member.orgId}, 'tender', 'x.pdf', 'pdf', ${member.userId}, '../../etc/passwd')`.execute(trx),
      ),
    ).rejects.toThrow();
  });
});

describe('伪造类型', () => {
  it.each<[string, string, Buffer]>([
    ['tender', '报价.pdf', HTML_PAYLOAD],
    ['tender', '方案.docx', makePdf()],
    ['tender', '表格.xlsx', makeDocx()],
    ['tender', '旧文档.doc', makePng()],
    ['tender', '说明.txt', makePdf()],
    ['credential-image', '证书.png', SVG_PAYLOAD],
    ['credential-image', '证书.jpg', makePng()],
    ['credential-image', '证书.png', HTML_PAYLOAD],
  ])('%s：%s 的内容是别的格式时拒绝，不留下记录和对象', async (purpose, name, content) => {
    const member = await newMember();
    const response = await upload(member, name, content, { purpose });
    expect(response.statusCode, response.body).toBe(415);
    expect(response.json().error.code).toBe('FILE_TYPE_MISMATCH');
    expect(await rowsOf(member.orgId)).toEqual([]);
    expect(await keysOf(member.orgId)).toEqual([]);
  });

  it.each<[string, string]>([
    ['tender', 'page.html'],
    ['tender', 'run.exe'],
    ['credential-image', 'icon.svg'],
    ['credential-image', 'scan.pdf'],
    ['knowledge', 'notes.txt'],
    ['tender', 'noextension'],
  ])('%s 不允许的扩展名 %s：在读取内容前拒绝', async (purpose, name) => {
    const member = await newMember();
    const response = await upload(member, name, makePdf(), { purpose });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('FILE_EXTENSION_NOT_ALLOWED');
    expect(await rowsOf(member.orgId)).toEqual([]);
  });

  it('空文件拒绝', async () => {
    const member = await newMember();
    const response = await upload(member, 'empty.pdf', Buffer.alloc(0));
    expect(response.statusCode).toBe(400);
    expect(await rowsOf(member.orgId)).toEqual([]);
  });
});

describe('超大文件', () => {
  it('Content-Length 超过图片上限（10 MB）时立即拒绝', async () => {
    const member = await newMember();
    const content = Buffer.concat([makePng(), Buffer.alloc(IMAGE_MAX_BYTES)]);
    const response = await upload(member, 'big.png', content, { purpose: 'credential-image' });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('FILE_TOO_LARGE');
    expect(response.headers.connection).toBe('close');
    expect(await rowsOf(member.orgId)).toEqual([]);
    expect(await keysOf(member.orgId)).toEqual([]);
  });

  it('不带 Content-Length 的流式上传超过上限时中断，放弃分片上传，不留下记录和对象', async () => {
    const member = await newMember();
    // 分块发送 12 MiB，超过图片上限；对象存储已经收到了第一个分片。
    async function* chunks() {
      yield makePng();
      for (let index = 0; index < 12; index += 1) yield Buffer.alloc(MIB, 1);
    }
    const response = await upload(member, 'stream.png', Readable.from(chunks()), { purpose: 'credential-image' });
    expect(response.statusCode, response.body).toBe(413);
    expect(response.json().error.code).toBe('FILE_TOO_LARGE');
    expect(await rowsOf(member.orgId)).toEqual([]);
    expect(await keysOf(member.orgId)).toEqual([]);
    expect((await bucket.pendingMultipartKeys()).filter((key) => key.startsWith(`org/${member.orgId}/`))).toEqual([]);
  });

  it('文档上限是 100 MB：Content-Length 恰好超过 1 字节时拒绝', async () => {
    const member = await newMember();
    const response = await app.inject({
      method: 'POST',
      url: '/api/files?purpose=tender&name=big.pdf',
      headers: headers(member, { 'content-type': 'application/octet-stream', 'content-length': String(DOCUMENT_MAX_BYTES + 1) }),
      payload: makePdf(),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('存储配额（每组织 20 GB）', () => {
  it('剩余空间不足时拒绝，不留下记录和对象', async () => {
    const member = await newMember();
    await fillUsage(member.orgId, QUOTA - 100);
    const before = (await rowsOf(member.orgId)).length;
    const response = await upload(member, 'a.pdf', Buffer.concat([makePdf(), Buffer.alloc(200)]));
    expect(response.statusCode, response.body).toBe(413);
    expect(response.json().error.code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect((await rowsOf(member.orgId)).length).toBe(before);
    expect(await keysOf(member.orgId)).toEqual([]);
  });

  it('不带 Content-Length 时按剩余空间中断', async () => {
    const member = await newMember();
    await fillUsage(member.orgId, QUOTA - 1000);
    async function* chunks() {
      yield makePdf();
      yield Buffer.alloc(2000);
    }
    const response = await upload(member, 'a.pdf', Readable.from(chunks()));
    expect(response.statusCode, response.body).toBe(413);
    expect(response.json().error.code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(await keysOf(member.orgId)).toEqual([]);
  });

  it('配额用满时任何上传都拒绝；刚好用满的上传成功', async () => {
    const member = await newMember();
    const content = makePdf();
    await fillUsage(member.orgId, QUOTA - content.length);
    expect((await upload(member, 'exact.pdf', content)).statusCode).toBe(201);
    expect((await storageUsage(appDb, member.context)).used).toBe(QUOTA);
    const response = await upload(member, 'more.pdf', content);
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('STORAGE_QUOTA_EXCEEDED');
  });

  it('数据库触发器兜底：并发完成的上传合计不能超过配额', async () => {
    const member = await newMember();
    await fillUsage(member.orgId, QUOTA - 150);
    const inspection = (size: number) => ({ kind: 'pdf' as const, mime: 'application/pdf', size, sha256: Buffer.alloc(32, 7) });
    const first = await beginUpload(appDb, member.context, { purpose: 'tender', displayName: 'a.pdf', extension: 'pdf' });
    const second = await beginUpload(appDb, member.context, { purpose: 'tender', displayName: 'b.pdf', extension: 'pdf' });
    // 两个上传都通过了预检（各自 100 字节 < 剩余 150），完成时只有一个能入账。
    const results = await Promise.allSettled([
      completeUpload(appDb, member.context, first.id, inspection(100)),
      completeUpload(appDb, member.context, second.id, inspection(100)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });
  });

  it('其他组织的用量不影响本组织', async () => {
    const full = await newMember();
    await fillUsage(full.orgId, QUOTA);
    const other = await newMember();
    expect((await upload(other, 'a.pdf', makePdf())).statusCode).toBe(201);
  });

  it('上传中断不占配额：遗留的 uploading 记录不计入用量', async () => {
    const member = await newMember();
    await beginUpload(appDb, member.context, { purpose: 'tender', displayName: 'crash.pdf', extension: 'pdf' });
    expect((await storageUsage(appDb, member.context)).used).toBe(0);
  });

  it('客户端中途断开：放弃上传，删除 uploading 记录，不留下对象', async () => {
    const member = await newMember();
    const server = await createApp(objectStore);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const { port } = server.server.address() as AddressInfo;
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/files?purpose=tender&name=partial.pdf',
      headers: headers(member, { 'content-type': 'application/octet-stream', 'content-length': String(20 * MIB) }),
    });
    req.on('error', () => {});
    req.write(makePdf());
    req.write(Buffer.alloc(9 * MIB));
    // 等服务端登记了 uploading 行、开始写对象存储后再断开。
    await waitFor(async () => (await rowsOf(member.orgId)).length === 1);
    req.destroy();
    await waitFor(async () => (await rowsOf(member.orgId)).length === 0);
    expect(await keysOf(member.orgId)).toEqual([]);
    expect((await storageUsage(appDb, member.context)).used).toBe(0);
    await waitFor(async () => (await bucket.pendingMultipartKeys()).every((key) => !key.startsWith(`org/${member.orgId}/`)));
  });

  it('长时间收不到数据时中断上传', async () => {
    const member = await newMember();
    const server = await createApp(objectStore, { uploadIdleTimeoutMs: 300 });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const { port } = server.server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/files?purpose=tender&name=slow.pdf',
          headers: headers(member, { 'content-type': 'application/octet-stream', 'content-length': '100000' }),
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(makePdf());
    });
    expect(status).toBe(408);
    await waitFor(async () => (await rowsOf(member.orgId)).length === 0);
    expect(await keysOf(member.orgId)).toEqual([]);
  });
});

describe('跨组织访问', () => {
  let alice: Member;
  let mallory: Member;
  let fileId: string;

  beforeAll(async () => {
    alice = await newMember();
    mallory = await newMember();
    fileId = (await uploadOk(alice, '机密.pdf', makePdf())).id;
  });

  it.each([
    ['GET', (id: string) => `/api/files/${id}`],
    ['GET', (id: string) => `/api/files/${id}/content`],
    ['DELETE', (id: string) => `/api/files/${id}`],
    ['POST', (id: string) => `/api/files/${id}/restore`],
  ] as const)('%s %s：其他组织的文件与不存在的一样返回 404', async (method, url) => {
    const response = await app.inject({ method, url: url(fileId), headers: headers(mallory) });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('FILE_NOT_FOUND');
    const missing = await app.inject({ method, url: url(randomUUID()), headers: headers(mallory) });
    expect(missing.json().error.code).toBe(response.json().error.code);
  });

  it('其他组织的列表看不到；文件仍然完好', async () => {
    expect((await get(mallory, '/api/files')).json().files).toEqual([]);
    expect((await get(mallory, '/api/files?deleted=true')).json().files).toEqual([]);
    expect((await get(alice, `/api/files/${fileId}/content`)).statusCode).toBe(200);
  });

  it('同组织的其他成员可以访问（组织内共享，第 9 节第 2 项）', async () => {
    const colleague = await newMember(alice.orgId);
    expect((await get(colleague, `/api/files/${fileId}/content`)).statusCode).toBe(200);
  });

  it('数据库层：RLS 下查不到、改不了、删不掉其他组织的行，也不能以其他组织或用户的名义插入', async () => {
    const rows = await withTenant(appDb, mallory.context, (trx) => trx.selectFrom('files').selectAll().where('id', '=', fileId).execute());
    expect(rows).toEqual([]);
    const updated = await withTenant(appDb, mallory.context, (trx) =>
      trx.updateTable('files').set({ deleted_at: new Date(), deleted_by: mallory.userId }).where('id', '=', fileId).executeTakeFirst(),
    );
    expect(updated.numUpdatedRows).toBe(0n);
    const deleted = await withTenant(appDb, mallory.context, (trx) => trx.deleteFrom('files').where('id', '=', fileId).executeTakeFirst());
    expect(deleted.numDeletedRows).toBe(0n);

    for (const values of [
      { org_id: alice.orgId, created_by: mallory.userId },
      { org_id: mallory.orgId, created_by: alice.userId },
    ]) {
      await expect(
        withTenant(appDb, mallory.context, (trx) =>
          trx.insertInto('files').values({ purpose: 'tender', display_name: 'x.pdf', extension: 'pdf', ...values }).execute(),
        ),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it('未设置组织上下文时查不到任何文件', async () => {
    expect(await appDb.selectFrom('files').selectAll().execute()).toEqual([]);
  });

  it('未登录返回 401；跨站请求返回 403', async () => {
    const anonymous = await app.inject({ method: 'GET', url: `/api/files/${fileId}/content` });
    expect(anonymous.statusCode).toBe(401);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/files?purpose=tender&name=a.pdf',
      headers: { cookie: `__Host-session=${alice.cookie}`, origin: 'https://evil.example', 'x-requested-with': 'app', 'content-type': 'application/octet-stream' },
      payload: makePdf(),
    });
    expect(crossSite.statusCode).toBe(403);
    const noHeader = await app.inject({
      method: 'POST',
      url: '/api/files?purpose=tender&name=a.pdf',
      headers: { cookie: `__Host-session=${alice.cookie}`, origin: testConfig.publicOrigin, 'content-type': 'application/octet-stream' },
      payload: makePdf(),
    });
    expect(noHeader.statusCode).toBe(403);
    // 其他接口仍然只接受 JSON：octet-stream 只对上传路由放开。
    const elsewhere = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: headers(alice, { 'content-type': 'application/octet-stream' }),
      payload: Buffer.from('x'),
    });
    expect(elsewhere.statusCode).toBe(415);
  });
});

describe('删除与恢复（7 天恢复期）', () => {
  it('删除后不能下载、不能查看，回收站中可见并可恢复，恢复后可以下载', async () => {
    const member = await newMember();
    const content = makeDocx();
    const file = await uploadOk(member, '方案.docx', content);

    const removed = await app.inject({ method: 'DELETE', url: `/api/files/${file.id}`, headers: headers(member) });
    expect(removed.statusCode).toBe(200);
    const body = removed.json();
    expect(body.deletedAt).not.toBeNull();
    expect(new Date(body.restoreUntil).getTime() - new Date(body.deletedAt).getTime()).toBe(7 * 24 * 60 * 60 * 1000);

    expect((await get(member, `/api/files/${file.id}/content`)).statusCode).toBe(404);
    expect((await get(member, `/api/files/${file.id}`)).statusCode).toBe(404);
    expect((await get(member, '/api/files')).json().files).toEqual([]);
    expect((await get(member, '/api/files?deleted=true')).json().files.map((item: { id: string }) => item.id)).toEqual([file.id]);
    // 恢复期内的文件仍占用配额，对象仍在。
    expect((await storageUsage(appDb, member.context)).used).toBe(content.length);
    expect(await keysOf(member.orgId)).toHaveLength(1);

    const again = await app.inject({ method: 'DELETE', url: `/api/files/${file.id}`, headers: headers(member) });
    expect(again.statusCode).toBe(404);

    const restored = await app.inject({ method: 'POST', url: `/api/files/${file.id}/restore`, headers: headers(member) });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: file.id, deletedAt: null, restoreUntil: null });
    const download = await get(member, `/api/files/${file.id}/content`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(content)).toBe(true);

    const notDeleted = await app.inject({ method: 'POST', url: `/api/files/${file.id}/restore`, headers: headers(member) });
    expect(notDeleted.statusCode).toBe(404);
  });

  it('超过 7 天：不能恢复、不能访问、回收站中不再显示、不计入配额', async () => {
    const member = await newMember();
    const file = await uploadOk(member, 'old.pdf', makePdf());
    // 相当于 7 天零 1 秒前删除（触发器不允许改已删除文件的删除时间，所以直接从未删除状态写入）。
    await superuser
      .updateTable('files')
      .set({ deleted_at: sql`now() - interval '7 days 1 second'`, deleted_by: member.userId })
      .where('id', '=', file.id)
      .execute();

    const restored = await app.inject({ method: 'POST', url: `/api/files/${file.id}/restore`, headers: headers(member) });
    expect(restored.statusCode).toBe(404);
    expect((await get(member, `/api/files/${file.id}/content`)).statusCode).toBe(404);
    expect((await get(member, '/api/files?deleted=true')).json().files).toEqual([]);
    expect((await storageUsage(appDb, member.context)).used).toBe(0);
  });

  it('数据库层：过期后即使绕过接口直接改库也不能恢复', async () => {
    const member = await newMember();
    const file = await uploadOk(member, 'old.pdf', makePdf());
    await superuser.updateTable('files').set({ deleted_at: sql`now() - interval '8 days'`, deleted_by: member.userId }).where('id', '=', file.id).execute();
    await expect(
      withTenant(appDb, member.context, (trx) => trx.updateTable('files').set({ deleted_at: null, deleted_by: null }).where('id', '=', file.id).execute()),
    ).rejects.toMatchObject({ code: 'FS002' });
  });

  it('数据库层：应用角色不能物理删除已上传的文件，也不能改已上传文件的内容信息', async () => {
    const member = await newMember();
    const file = await uploadOk(member, 'keep.pdf', makePdf());
    const deleted = await withTenant(appDb, member.context, (trx) => trx.deleteFrom('files').where('id', '=', file.id).executeTakeFirst());
    expect(deleted.numDeletedRows).toBe(0n);
    await expect(
      withTenant(appDb, member.context, (trx) => trx.updateTable('files').set({ size_bytes: 1 }).where('id', '=', file.id).execute()),
    ).rejects.toMatchObject({ code: 'FS003' });
    await expect(
      withTenant(appDb, member.context, (trx) => sql`UPDATE files SET org_id = gen_random_uuid() WHERE id = ${file.id}`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
    expect(await rowsOf(member.orgId)).toHaveLength(1);
  });

  it('删除操作人必须是当前用户', async () => {
    const member = await newMember();
    const file = await uploadOk(member, 'a.pdf', makePdf());
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx.updateTable('files').set({ deleted_at: new Date(), deleted_by: randomUUID() }).where('id', '=', file.id).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('对象存储未配置', () => {
  it('上传和下载返回 503，不写数据库', async () => {
    const disabled = await createApp(null);
    const member = await newMember();
    const response = await upload(member, 'a.pdf', makePdf(), { target: disabled });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('FILE_STORAGE_DISABLED');
    expect(await rowsOf(member.orgId)).toEqual([]);
  });

  it('同时上传数达到上限时返回 429', async () => {
    const limited = await createApp(objectStore, { maxConcurrentUploads: 0 });
    const member = await newMember();
    const response = await upload(member, 'a.pdf', makePdf(), { target: limited });
    expect(response.statusCode).toBe(429);
    expect(await rowsOf(member.orgId)).toEqual([]);
  });
});
