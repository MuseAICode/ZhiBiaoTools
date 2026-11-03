// 模板样张的存储（迁移 0027_template_preview、src/export/previewStore.ts，路线图 7.3c）的数据库测试：
// 1. 样张产物（template-preview）：不属于项目或来源文件、必须有输入哈希（CHECK），其他种类的归属规则不变；计入组织存储配额；
//    在本组织内可见、其他组织不可见；按输入哈希复用 23 小时内最近完成的结果；
// 2. 样张请求：只有创建者本人可见、可写（RLS），内容写入后不能改，结果只能写一次（TP001），没有应用角色的删除权限；
//    读回的内容重新准备后得到相同的哈希。
// 24 小时后的清理见 tests/db/cleanup.test.ts。对象存储用内存实现。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findArtifact } from '../../src/artifacts/store.ts';
import { DOCX_MIME, TEMPLATE_PREVIEW_HTML_MAX_BYTES } from '../../src/db/migrations/0027_template_preview.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { preparePreviewRequest, type PreparedPreviewRequest } from '../../src/export/preview.ts';
import {
  completeTemplatePreviewRequest,
  findReusableTemplatePreview,
  findTemplatePreviewRequest,
  saveTemplatePreviewRequest,
  TEMPLATE_PREVIEW_ARTIFACT_NAME,
  writeTemplatePreviewArtifact,
} from '../../src/export/previewStore.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import { storageUsage } from '../../src/files/store.ts';
import { defaultExportFormat } from '../../src/templates/exportFormat.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const HOUR = 60 * 60 * 1000;
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);
const template = readFileSync(new URL('../../../client/electron/resources/content-generation/正文模板.html', import.meta.url), 'utf8');
const SAMPLE = template.replace(/src="assets\/([a-z-]+)\.webp"/g, (_match, name: string) => `src="/assets/${name}-Bx7Kq2Lm.webp"`);
const DOCX = Buffer.from('PK\u0003\u0004 docx bytes');

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

function prepared(overrides: Record<string, unknown> = {}): PreparedPreviewRequest {
  return preparePreviewRequest({ html: SAMPLE, exportFormat: { ...defaultExportFormat(), ...overrides } });
}

/** 以应用角色在租户上下文中直接执行 SQL（检验 RLS、授权与 CHECK）。 */
function asApp<T>(context: TenantContext, work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
  return withTenant(appDb, context, work);
}

async function expectSqlError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

async function backdateArtifact(id: string, ms: number): Promise<void> {
  // 守卫禁止改已完成的产物，测试中临时关掉触发器回拨时间。
  await superuser.transaction().execute(async (trx) => {
    await sql`ALTER TABLE artifacts DISABLE TRIGGER artifacts_guard`.execute(trx);
    await sql`UPDATE artifacts SET created_at = created_at - ${`${ms} milliseconds`}::interval WHERE id = ${id}::uuid`.execute(trx);
    await sql`ALTER TABLE artifacts ENABLE TRIGGER artifacts_guard`.execute(trx);
  });
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
  appDb = connect<Database>(testDb.appConfig, 5);
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

describe('样张产物', () => {
  it('不属于项目或来源文件，登记输入哈希；写入对象、计入组织存储配额；本组织成员可见，其他组织不可见', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const outsider = await newOrg();
    const request = prepared();
    const before = (await storageUsage(appDb, ctx)).used;
    const record = await writeTemplatePreviewArtifact(appDb, ctx, store, request.sha256, DOCX);
    expect(record).toMatchObject({
      kind: 'template-preview', name: TEMPLATE_PREVIEW_ARTIFACT_NAME, mime: DOCX_MIME, projectId: null, sourceFileId: null,
      size: DOCX.length, sha256: createHash('sha256').update(DOCX).digest('hex'), createdBy: ctx.userId,
    });
    expect(objects.get(record.storageKey)?.equals(DOCX)).toBe(true);
    expect((await storageUsage(appDb, ctx)).used).toBe(before + DOCX.length);
    const row = await superuser.selectFrom('artifacts').select('preview_sha256').where('id', '=', record.id).executeTakeFirstOrThrow();
    expect(row.preview_sha256.equals(request.sha256)).toBe(true);

    expect(await findArtifact(appDb, colleague, record.id)).toMatchObject({ id: record.id });
    expect(await findArtifact(appDb, outsider, record.id)).toBeNull();
  });

  it('超出组织配额时拒绝（413），不留下对象和登记行', async () => {
    const ctx = await newOrg();
    await fillUsage(ctx.orgId, QUOTA - DOCX.length + 1);
    await expect(writeTemplatePreviewArtifact(appDb, ctx, store, prepared().sha256, DOCX))
      .rejects.toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });
    expect(await superuser.selectFrom('artifacts').select('id').where('org_id', '=', ctx.orgId).execute()).toEqual([]);
    expect([...objects.keys()].filter((key) => key.startsWith(`org/${ctx.orgId}/`))).toEqual([]);
  });

  it('归属规则由数据库强制：样张不能挂项目或来源文件、必须有 32 字节的哈希、MIME 必须是 docx；其他种类不能有哈希、必须有归属', async () => {
    const ctx = await newOrg();
    const project = (await superuser.insertInto('projects')
      .values({ org_id: ctx.orgId, kind: 'technical-plan', name: '项目', created_by: ctx.userId })
      .returning('id').executeTakeFirstOrThrow()).id;
    const insert = (values: Record<string, unknown>) => asApp(ctx, (trx) => trx.insertInto('artifacts').values({
      org_id: ctx.orgId, created_by: ctx.userId, kind: 'template-preview', name: 'template-preview.docx', mime: DOCX_MIME,
      preview_sha256: randomBytes(32), ...values,
    } as never).execute());
    await expectSqlError(insert({ project_id: project }), '23514');
    await expectSqlError(insert({ preview_sha256: null }), '23514');
    await expectSqlError(insert({ preview_sha256: randomBytes(31) }), '23514');
    await expectSqlError(insert({ mime: 'text/html' }), '23514');
    await expectSqlError(insert({ kind: 'markdown', mime: 'text/markdown; charset=utf-8', project_id: project }), '23514');
    await expectSqlError(insert({ kind: 'markdown', mime: 'text/markdown; charset=utf-8', preview_sha256: null }), '23514');
    await expectSqlError(insert({ kind: 'image', mime: DOCX_MIME, project_id: project, preview_sha256: null }), '23514');
    await insert({});
    await insert({ kind: 'markdown', mime: 'text/markdown; charset=utf-8', project_id: project, preview_sha256: null });

    // Store 在写库前拒绝（程序错误）。
    const write = (input: Parameters<typeof writeTemplatePreviewArtifact>[3]) => writeTemplatePreviewArtifact(appDb, ctx, store, input, DOCX);
    await expect(write(randomBytes(16))).rejects.toThrow(TypeError);
    const { writeArtifact } = await import('../../src/artifacts/store.ts');
    await expect(writeArtifact(appDb, ctx, store,
      { kind: 'template-preview', name: 'x.docx', mime: DOCX_MIME, projectId: project, previewSha256: randomBytes(32) }, DOCX)).rejects.toThrow(TypeError);
    await expect(writeArtifact(appDb, ctx, store,
      { kind: 'markdown', name: 'c.md', mime: 'text/markdown; charset=utf-8', projectId: project, previewSha256: randomBytes(32) }, DOCX)).rejects.toThrow(TypeError);
  });

  it('按输入哈希复用：本组织 23 小时内最近完成的结果；更早的、写入中的、其他组织的、哈希不同的都不复用', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const outsider = await newOrg();
    const hash = prepared({ template_name: `复用-${randomUUID()}` }).sha256;
    expect(await findReusableTemplatePreview(appDb, ctx, hash)).toBeNull();

    const old = await writeTemplatePreviewArtifact(appDb, ctx, store, hash, DOCX);
    await backdateArtifact(old.id, 23 * HOUR + 60_000);
    expect(await findReusableTemplatePreview(appDb, ctx, hash)).toBeNull();

    const earlier = await writeTemplatePreviewArtifact(appDb, ctx, store, hash, DOCX);
    await backdateArtifact(earlier.id, HOUR);
    const latest = await writeTemplatePreviewArtifact(appDb, colleague, store, hash, DOCX);
    await asApp(ctx, (trx) => trx.insertInto('artifacts').values({
      org_id: ctx.orgId, created_by: ctx.userId, kind: 'template-preview', name: 'template-preview.docx', mime: DOCX_MIME, preview_sha256: hash,
    }).execute());

    // 同组织的其他成员生成的结果同样复用（同一输入，内容相同）。
    expect((await findReusableTemplatePreview(appDb, ctx, hash))?.id).toBe(latest.id);
    expect((await findReusableTemplatePreview(appDb, colleague, hash))?.id).toBe(latest.id);
    expect(await findReusableTemplatePreview(appDb, outsider, hash)).toBeNull();
    expect(await findReusableTemplatePreview(appDb, ctx, randomBytes(32))).toBeNull();
    await expect(findReusableTemplatePreview(appDb, ctx, randomBytes(8))).rejects.toThrow(TypeError);
  });
});

describe('样张请求', () => {
  it('保存后读回的内容重新准备得到相同的哈希（jsonb 改变键的顺序不影响）', async () => {
    const ctx = await newOrg();
    const request = prepared({ template_name: '读回' });
    const saved = await saveTemplatePreviewRequest(appDb, ctx, request);
    expect(saved).toMatchObject({ createdBy: ctx.userId, inputSha256: request.sha256.toString('hex'), html: request.html, artifactId: null, completedAt: null });
    const loaded = await findTemplatePreviewRequest(appDb, ctx, saved.id);
    expect(loaded).toEqual(saved);
    expect(JSON.stringify(loaded!.exportFormat)).not.toBe(JSON.stringify(request.exportFormat));
    expect(preparePreviewRequest({ html: loaded!.html, exportFormat: loaded!.exportFormat }).sha256.equals(request.sha256)).toBe(true);
  });

  it('只有创建者本人可见：同组织其他成员、其他组织都看不到，也不能写入结果', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const outsider = await newOrg();
    const saved = await saveTemplatePreviewRequest(appDb, ctx, prepared());
    for (const other of [colleague, outsider]) {
      expect(await findTemplatePreviewRequest(appDb, other, saved.id)).toBeNull();
      expect(await completeTemplatePreviewRequest(appDb, other, saved.id, randomUUID())).toBeNull();
      expect(await asApp(other, (trx) => trx.selectFrom('template_preview_requests').select('id').execute())).toEqual([]);
    }
    expect((await findTemplatePreviewRequest(appDb, ctx, saved.id))?.artifactId).toBeNull();
    // 不能以别人的身份写入。
    await expectSqlError(asApp(ctx, (trx) => trx.insertInto('template_preview_requests').values({
      org_id: ctx.orgId, created_by: colleague.userId, input_sha256: randomBytes(32), html: '<p>x</p>', export_format: '{}',
    }).execute()), '42501');
    await expectSqlError(asApp(ctx, (trx) => trx.insertInto('template_preview_requests').values({
      org_id: outsider.orgId, created_by: ctx.userId, input_sha256: randomBytes(32), html: '<p>x</p>', export_format: '{}',
    }).execute()), '42501');
  });

  it('结果只能写一次（completed_at 由数据库写入）；内容不能改；应用角色不能删除', async () => {
    const ctx = await newOrg();
    const saved = await saveTemplatePreviewRequest(appDb, ctx, prepared());
    const artifactId = randomUUID();
    const done = await completeTemplatePreviewRequest(appDb, ctx, saved.id, artifactId);
    expect(done).toMatchObject({ id: saved.id, artifactId });
    expect(done!.completedAt).toBeInstanceOf(Date);
    expect(await completeTemplatePreviewRequest(appDb, ctx, saved.id, randomUUID())).toBeNull();

    await expectSqlError(asApp(ctx, (trx) => trx.updateTable('template_preview_requests')
      .set({ artifact_id: randomUUID() }).where('id', '=', saved.id).execute()), 'TP001');
    const fresh = await saveTemplatePreviewRequest(appDb, ctx, prepared());
    await expectSqlError(asApp(ctx, (trx) => sql`UPDATE template_preview_requests SET artifact_id = NULL WHERE id = ${fresh.id}::uuid`.execute(trx)), 'TP001');
    for (const column of ['html', 'export_format', 'input_sha256', 'created_by', 'created_at', 'completed_at']) {
      await expectSqlError(asApp(ctx, (trx) => sql`UPDATE template_preview_requests SET ${sql.id(column)} = ${sql.id(column)} WHERE id = ${fresh.id}::uuid`.execute(trx)), '42501');
    }
    await expectSqlError(asApp(ctx, (trx) => trx.deleteFrom('template_preview_requests').where('id', '=', fresh.id).execute()), '42501');
    // 新建时不能直接带结果（没有该列的 INSERT 授权）。
    await expectSqlError(asApp(ctx, (trx) => sql`INSERT INTO template_preview_requests (org_id, created_by, input_sha256, html, export_format, artifact_id)
      VALUES (${ctx.orgId}::uuid, ${ctx.userId}::uuid, ${randomBytes(32)}, '<p>x</p>', '{}', gen_random_uuid())`.execute(trx)), '42501');
  });

  it('大小由数据库限制：HTML 不能为空、不超过 2 MiB，配置只能是对象且不超过 128 KiB；Store 超限时返回 413', async () => {
    const ctx = await newOrg();
    const insert = (values: Record<string, unknown>) => asApp(ctx, (trx) => trx.insertInto('template_preview_requests').values({
      org_id: ctx.orgId, created_by: ctx.userId, input_sha256: randomBytes(32), html: '<p>x</p>', export_format: '{}', ...values,
    } as never).execute());
    await expectSqlError(insert({ html: '' }), '23514');
    await expectSqlError(insert({ html: 'x'.repeat(TEMPLATE_PREVIEW_HTML_MAX_BYTES + 1) }), '23514');
    await expectSqlError(insert({ export_format: '[]' }), '23514');
    await expectSqlError(insert({ export_format: JSON.stringify({ text: 'x'.repeat(128 * 1024) }) }), '23514');
    await expectSqlError(insert({ input_sha256: randomBytes(16) }), '23514');
    await insert({ html: 'x'.repeat(TEMPLATE_PREVIEW_HTML_MAX_BYTES) });

    const base = prepared();
    await expect(saveTemplatePreviewRequest(appDb, ctx, { ...base, html: 'x'.repeat(TEMPLATE_PREVIEW_HTML_MAX_BYTES + 1) }))
      .rejects.toMatchObject({ statusCode: 413, code: 'PREVIEW_TOO_LARGE' });
    await expect(saveTemplatePreviewRequest(appDb, ctx, { ...base, exportFormat: { ...base.exportFormat, template_name: 'x'.repeat(128 * 1024) } }))
      .rejects.toMatchObject({ statusCode: 413, code: 'PREVIEW_TOO_LARGE' });
  });
});
