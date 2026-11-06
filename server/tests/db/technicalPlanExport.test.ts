// 技术方案整本导出的存储（迁移 0028_technical_plan_export、src/export/documentStore.ts，路线图 7.4d）的数据库测试：
// 1. 整本导出（technical-plan-export）必须属于项目、不能有来源文件和样张哈希、MIME 必须是 docx（CHECK）；计入组织存储配额；
//    在本组织内可见、其他组织不可见，项目删除后不可见；
// 2. 每个项目只保留最近一次：新的导出完成时在同一事务中替换旧的；同一项目至多一个当前的导出（部分唯一索引）；
//    完成失败（超出配额）时旧的原样保留；并发完成时后完成的替换先完成的，不会两个都是当前的；
// 3. 查找只返回 7 天内、未被替换的导出。
// 被替换、7 天后的清理见 tests/db/cleanup.test.ts。对象存储用内存实现。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findArtifact, listArtifacts, writeArtifact } from '../../src/artifacts/store.ts';
import { DOCX_MIME } from '../../src/db/migrations/0027_template_preview.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import {
  findTechnicalPlanExport,
  TECHNICAL_PLAN_EXPORT_ARTIFACT_NAME,
  writeTechnicalPlanExportArtifact,
} from '../../src/export/documentStore.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import { storageUsage } from '../../src/files/store.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);
const MARKDOWN = 'text/markdown; charset=utf-8';
const DOCX = Buffer.from('PK\u0003\u0004 whole document');

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

async function newProject(ctx: TenantContext): Promise<string> {
  return (await superuser.insertInto('projects')
    .values({ org_id: ctx.orgId, kind: 'technical-plan', name: '项目', created_by: ctx.userId })
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

/** 以应用角色在租户上下文中直接执行 SQL（检验 RLS、授权、CHECK 与唯一索引）。 */
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

async function exportsOf(projectId: string) {
  return superuser.selectFrom('artifacts').select(['id', 'status', 'superseded_at'])
    .where('project_id', '=', projectId).where('kind', '=', 'technical-plan-export').orderBy('created_at').execute();
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

describe('整本导出产物', () => {
  it('属于项目：写入对象、计入组织存储配额；本组织成员可见，其他组织不可见，项目删除后不可见', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const outsider = await newOrg();
    const project = await newProject(ctx);
    const before = (await storageUsage(appDb, ctx)).used;
    const record = await writeTechnicalPlanExportArtifact(appDb, ctx, store, project, DOCX);
    expect(record).toMatchObject({
      kind: 'technical-plan-export', name: TECHNICAL_PLAN_EXPORT_ARTIFACT_NAME, mime: DOCX_MIME, projectId: project, sourceFileId: null,
      size: DOCX.length, sha256: createHash('sha256').update(DOCX).digest('hex'), createdBy: ctx.userId,
    });
    expect(objects.get(record.storageKey)?.equals(DOCX)).toBe(true);
    expect((await storageUsage(appDb, ctx)).used).toBe(before + DOCX.length);

    expect(await findTechnicalPlanExport(appDb, colleague, project)).toMatchObject({ id: record.id });
    expect(await findArtifact(appDb, colleague, record.id)).toMatchObject({ id: record.id });
    expect(await findTechnicalPlanExport(appDb, outsider, project)).toBeNull();
    expect(await findArtifact(appDb, outsider, record.id)).toBeNull();

    await superuser.updateTable('projects').set({ deleted_at: new Date(), deleted_by: ctx.userId }).where('id', '=', project).execute();
    expect(await findTechnicalPlanExport(appDb, ctx, project)).toBeNull();
    expect(await findArtifact(appDb, ctx, record.id)).toBeNull();
  });

  it('归属规则由数据库强制：必须有项目、不能有来源文件和样张哈希、MIME 必须是 docx；Store 在写库前拒绝', async () => {
    const ctx = await newOrg();
    const project = await newProject(ctx);
    const file = (await superuser.insertInto('files').values({
      org_id: ctx.orgId, project_id: project, purpose: 'tender', display_name: 'a.pdf', extension: 'pdf', status: 'uploaded',
      mime: 'application/pdf', size_bytes: 1, sha256: Buffer.alloc(32), created_by: ctx.userId, uploaded_at: new Date(),
    }).returning('id').executeTakeFirstOrThrow()).id;
    const insert = (values: Record<string, unknown>) => asApp(ctx, (trx) => trx.insertInto('artifacts').values({
      org_id: ctx.orgId, created_by: ctx.userId, kind: 'technical-plan-export', name: 'technical-plan.docx', mime: DOCX_MIME,
      project_id: project, ...values,
    } as never).execute());
    await expectSqlError(insert({ project_id: null, source_file_id: file }), '23514');
    await expectSqlError(insert({ source_file_id: file }), '23514');
    await expectSqlError(insert({ preview_sha256: randomBytes(32) }), '23514');
    await expectSqlError(insert({ mime: MARKDOWN }), '23514');
    await expectSqlError(insert({ mime: 'text/html' }), '23514');
    await insert({});
    // 其他种类的规则不变。
    await insert({ kind: 'markdown', mime: MARKDOWN });
    await insert({ kind: 'markdown', mime: MARKDOWN, project_id: null, source_file_id: file });
    await insert({ kind: 'template-preview', project_id: null, preview_sha256: randomBytes(32) });
    await expectSqlError(insert({ kind: 'template-preview', preview_sha256: randomBytes(32) }), '23514');

    const write = (input: Parameters<typeof writeArtifact>[3]) => writeArtifact(appDb, ctx, store, input, DOCX);
    const base = { kind: 'technical-plan-export', name: 'technical-plan.docx', mime: DOCX_MIME } as const;
    await expect(write({ ...base })).rejects.toThrow(TypeError);
    await expect(write({ ...base, sourceFileId: file })).rejects.toThrow(TypeError);
    await expect(write({ ...base, projectId: project, sourceFileId: file })).rejects.toThrow(TypeError);
    await expect(write({ ...base, projectId: project, previewSha256: randomBytes(32) })).rejects.toThrow(TypeError);
    await expect(write({ ...base, projectId: project, mime: MARKDOWN })).rejects.toThrow(TypeError);
  });

  it('超出组织配额时拒绝（413），不留下对象和登记行', async () => {
    const ctx = await newOrg();
    const project = await newProject(ctx);
    await fillUsage(ctx.orgId, QUOTA - DOCX.length + 1);
    await expect(writeTechnicalPlanExportArtifact(appDb, ctx, store, project, DOCX))
      .rejects.toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });
    expect(await superuser.selectFrom('artifacts').select('id').where('org_id', '=', ctx.orgId).execute()).toEqual([]);
    expect([...objects.keys()].filter((key) => key.startsWith(`org/${ctx.orgId}/`))).toEqual([]);
  });
});

describe('每个项目只保留最近一次', () => {
  it('新的导出完成时替换同一项目中旧的导出（旧的不再可见）；其他项目的导出、同一项目的其他种类不受影响', async () => {
    const ctx = await newOrg();
    const colleague = await newMember(ctx.orgId);
    const project = await newProject(ctx);
    const other = await newProject(ctx);
    const markdown = await writeArtifact(appDb, ctx, store, { kind: 'markdown', name: 'content.md', mime: MARKDOWN, projectId: project }, Buffer.from('# md'));
    const first = await writeTechnicalPlanExportArtifact(appDb, ctx, store, project, DOCX);
    const otherExport = await writeTechnicalPlanExportArtifact(appDb, ctx, store, other, DOCX);
    // 同组织的其他成员导出同一项目，同样替换。
    const second = await writeTechnicalPlanExportArtifact(appDb, colleague, store, project, Buffer.from('PK\u0003\u0004 second'));

    expect((await findTechnicalPlanExport(appDb, ctx, project))?.id).toBe(second.id);
    expect(await findArtifact(appDb, ctx, first.id)).toBeNull();
    expect((await listArtifacts(appDb, ctx, { projectId: project, kind: 'technical-plan-export', limit: 10 })).map((a) => a.id)).toEqual([second.id]);
    const rows = await exportsOf(project);
    expect(rows.map((row) => [row.id, row.superseded_at !== null])).toEqual([[first.id, true], [second.id, false]]);
    // 被替换的对象由清理任务删除，这里仍在。
    expect(objects.has(first.storageKey)).toBe(true);

    expect((await findTechnicalPlanExport(appDb, ctx, other))?.id).toBe(otherExport.id);
    expect(await findArtifact(appDb, ctx, markdown.id)).toMatchObject({ id: markdown.id });
  });

  it('完成失败（超出配额）时整个事务回滚：旧的导出仍是当前的，新的不留下对象和登记行', async () => {
    const ctx = await newOrg();
    const project = await newProject(ctx);
    const first = await writeTechnicalPlanExportArtifact(appDb, ctx, store, project, DOCX);
    const used = (await storageUsage(appDb, ctx)).used;
    await fillUsage(ctx.orgId, QUOTA - used - DOCX.length + 1);
    await expect(writeTechnicalPlanExportArtifact(appDb, ctx, store, project, DOCX))
      .rejects.toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });
    expect((await findTechnicalPlanExport(appDb, ctx, project))?.id).toBe(first.id);
    expect((await exportsOf(project)).map((row) => [row.id, row.superseded_at])).toEqual([[first.id, null]]);
    expect([...objects.keys()].filter((key) => key.startsWith(`org/${ctx.orgId}/`))).toEqual([first.storageKey]);
  });

  it('同一项目至多一个当前的导出由数据库保证：不经替换直接完成第二个时违反唯一索引（23505）', async () => {
    const ctx = await newOrg();
    const project = await newProject(ctx);
    await writeTechnicalPlanExportArtifact(appDb, ctx, store, project, DOCX);
    await expectSqlError(asApp(ctx, async (trx) => {
      const { id } = await trx.insertInto('artifacts').values({
        org_id: ctx.orgId, created_by: ctx.userId, kind: 'technical-plan-export', name: 'technical-plan.docx', mime: DOCX_MIME, project_id: project,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.updateTable('artifacts').set({ status: 'ready', size_bytes: 1, sha256: Buffer.alloc(32) }).where('id', '=', id).execute();
    }), '23505');
    // 写入中的可以有多个（导出完成之前不影响当前的导出）。
    for (let i = 0; i < 2; i += 1) {
      await asApp(ctx, (trx) => trx.insertInto('artifacts').values({
        org_id: ctx.orgId, created_by: ctx.userId, kind: 'technical-plan-export', name: 'technical-plan.docx', mime: DOCX_MIME, project_id: project,
      }).execute());
    }
  });

  it('并发完成同一项目的多个导出：全部成功，恰好一个是当前的，其余都被替换', async () => {
    const ctx = await newOrg();
    const project = await newProject(ctx);
    const records = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      writeTechnicalPlanExportArtifact(appDb, ctx, store, project, Buffer.from(`PK\u0003\u0004 ${i}`))));
    const rows = await exportsOf(project);
    expect(rows).toHaveLength(4);
    const current = rows.filter((row) => row.superseded_at === null);
    expect(current).toHaveLength(1);
    expect(records.map((record) => record.id)).toContain(current[0]!.id);
    expect((await findTechnicalPlanExport(appDb, ctx, project))?.id).toBe(current[0]!.id);
  });
});

describe('查找', () => {
  it('只返回 7 天内、未被替换的导出；没有导出、不存在的项目返回 null', async () => {
    const ctx = await newOrg();
    const project = await newProject(ctx);
    expect(await findTechnicalPlanExport(appDb, ctx, project)).toBeNull();
    expect(await findTechnicalPlanExport(appDb, ctx, randomUUID())).toBeNull();
    const record = await writeTechnicalPlanExportArtifact(appDb, ctx, store, project, DOCX);
    await backdateArtifact(record.id, 7 * DAY - HOUR);
    expect((await findTechnicalPlanExport(appDb, ctx, project))?.id).toBe(record.id);
    await backdateArtifact(record.id, 2 * HOUR);
    expect(await findTechnicalPlanExport(appDb, ctx, project)).toBeNull();
  });
});
