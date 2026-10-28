// 清理任务（路线图 6.8，迁移 0024_cleanup、src/cleanup/）的数据库测试，按“决定事项（#23）”第 9、10 项逐条验证：
// 1. 只删除超过保留期的数据（文件、产物、项目 7 天恢复期，遗留 uploading / writing 24 小时，jobs 90 天、job_events 30 天），
//    恢复期内的行一律不动；删除条件在 SECURITY DEFINER 函数和策略中，调用方传入 id 删不掉未过期的行，也不能传入时间；
// 2. 先删对象、成功后再删行；对象删除失败的行保留、下一批重试；孤儿对象只删除超过保留期、没有对应行的；
// 3. 每批按类别各记一行结构化日志（条数、对象数、失败数、耗时），不含对象键和文件名；
// 4. bidtools_cleanup 对计费账本、余额、价格表、用量记录、平台凭据、平台模型没有任何权限、没有为它建的策略；
//    清理前后账本与用量记录的行数不变（账本、余额、价格表的内容也不变）；冻结到期收尾经 bidtools_billing 的函数。
// 对象存储用内存实现（可注入删除失败、可回拨修改时间）；最后一组用真实的 S3 兼容服务（TEST_S3_*）验证列出与删除。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { putCredential } from '../../src/ai/credentials.ts';
import { completeArtifact } from '../../src/artifacts/store.ts';
import { createFileKeyWrapper } from '../../src/ai/keyring.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { beginUsage, settleUsage } from '../../src/billing/usage.ts';
import {
  CLEANUP_CATEGORIES,
  createCleaner,
  ORPHAN_MIN_AGE_MS,
  startCleanupSchedule,
  type CleanupCategory,
  type CleanupCategoryResult,
} from '../../src/cleanup/cleanup.ts';
import { CLEANUP_BATCH_MAX } from '../../src/db/migrations/0024_cleanup.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { APP_ROLE, BILLING_ROLE, CLEANUP_ROLE, OWNER_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { createS3ObjectStore, type ListedObject, type ObjectLister, type ObjectStore } from '../../src/files/objectStore.ts';
import { completeUpload } from '../../src/files/store.ts';
import { testLogger } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { createTestBucket, type TestBucket } from './s3.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MARKDOWN = 'text/markdown; charset=utf-8';
/** 计费相关的表：清理角色对它们不能有任何权限（决定事项第 9 项）。 */
const BILLING_TABLES = ['billing_ledger', 'org_balances', 'model_prices', 'usage_records', 'provider_credentials', 'platform_models'];
/** 清理角色有权限的表（其余一律没有）。 */
const CLEANUP_TABLES = ['artifacts', 'files', 'job_events', 'jobs', 'projects'];
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
const CLEANUP_FUNCTIONS = [
  'cleanup_artifact_candidates',
  'cleanup_delete_artifact',
  'cleanup_delete_file',
  'cleanup_delete_job_events',
  'cleanup_delete_jobs',
  'cleanup_delete_projects',
  'cleanup_file_candidates',
  'cleanup_unreferenced_keys',
];

interface MemoryStore extends ObjectStore, ObjectLister {
  objects: Map<string, { body: Buffer; lastModified: Date }>;
  /** 删除这些键时失败（模拟对象存储出错）。 */
  failDelete: Set<string>;
  /** 每次删除前调用（测试“先删对象、后删行”的顺序）。 */
  beforeDelete: ((key: string) => Promise<void>) | null;
  deleted: string[];
}

function createMemoryStore(): MemoryStore {
  const objects = new Map<string, { body: Buffer; lastModified: Date }>();
  const store: MemoryStore = {
    objects,
    failDelete: new Set(),
    beforeDelete: null,
    deleted: [],
    async put(key, body) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, { body: Buffer.concat(chunks), lastModified: new Date() });
    },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: Readable.from(object.body), size: object.body.length } : null;
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      await store.beforeDelete?.(key);
      if (store.failDelete.has(key)) throw Object.assign(new Error(`cannot delete ${key}`), { name: 'ServiceUnavailable' });
      objects.delete(key);
      store.deleted.push(key);
    },
    async list({ prefix, startAfter, maxKeys }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort();
      const page = keys.slice(0, maxKeys);
      const listed: ListedObject[] = page.map((key) => ({ key, lastModified: objects.get(key)!.lastModified }));
      return { objects: listed, truncated: keys.length > page.length };
    },
  };
  return store;
}

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;
let store: MemoryStore;

const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

const ago = (ms: number) => new Date(Date.now() - ms);

async function newOrg(): Promise<TenantContext> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, userId, role: 'owner' };
}

async function insertProject(ctx: TenantContext, deletedAgo: number | null = null): Promise<string> {
  const row = await superuser
    .insertInto('projects')
    .values({
      org_id: ctx.orgId, kind: 'technical-plan', name: '项目', created_by: ctx.userId,
      deleted_at: deletedAgo === null ? null : ago(deletedAgo), deleted_by: deletedAgo === null ? null : ctx.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** 超级用户直接写入文件记录并写入对象（时间可回拨）。 */
async function insertFile(
  ctx: TenantContext,
  options: { projectId?: string; deletedAgo?: number; uploading?: boolean; createdAgo?: number; object?: boolean; name?: string } = {},
): Promise<{ id: string; key: string }> {
  const uploading = options.uploading ?? false;
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: ctx.orgId,
      project_id: options.projectId ?? null,
      purpose: 'tender',
      display_name: options.name ?? '招标文件.pdf',
      extension: 'pdf',
      status: uploading ? 'uploading' : 'uploaded',
      mime: uploading ? null : 'application/pdf',
      size_bytes: uploading ? null : 100,
      sha256: uploading ? null : Buffer.alloc(32),
      uploaded_at: uploading ? null : ago(options.createdAgo ?? 0),
      created_by: ctx.userId,
      created_at: ago(options.createdAgo ?? 0),
      deleted_at: options.deletedAgo === undefined ? null : ago(options.deletedAgo),
      deleted_by: options.deletedAgo === undefined ? null : ctx.userId,
    })
    .returning(['id', 'storage_key'])
    .executeTakeFirstOrThrow();
  if (options.object ?? true) await store.put(row.storage_key, Readable.from(Buffer.from('file')), { contentType: 'application/pdf' });
  return { id: row.id, key: row.storage_key };
}

async function insertArtifact(
  ctx: TenantContext,
  options: { projectId?: string; sourceFileId?: string; supersededAgo?: number; writing?: boolean; createdAgo?: number } = {},
): Promise<{ id: string; key: string }> {
  const writing = options.writing ?? false;
  const row = await superuser
    .insertInto('artifacts')
    .values({
      org_id: ctx.orgId,
      project_id: options.projectId ?? null,
      source_file_id: options.sourceFileId ?? null,
      kind: 'markdown',
      name: 'content.md',
      mime: MARKDOWN,
      status: writing ? 'writing' : 'ready',
      size_bytes: writing ? null : 10,
      sha256: writing ? null : Buffer.alloc(32),
      completed_at: writing ? null : ago(options.createdAgo ?? 0),
      created_by: ctx.userId,
      created_at: ago(options.createdAgo ?? 0),
      superseded_at: options.supersededAgo === undefined ? null : ago(options.supersededAgo),
    })
    .returning(['id', 'storage_key'])
    .executeTakeFirstOrThrow();
  await store.put(row.storage_key, Readable.from(Buffer.from('# md')), { contentType: MARKDOWN });
  return { id: row.id, key: row.storage_key };
}

async function insertJob(
  ctx: TenantContext,
  options: { finishedAgo?: number; createdAgo?: number; projectId?: string; status?: 'succeeded' | 'failed' | 'cancelled' | 'paused' } = {},
): Promise<string> {
  const status = options.status ?? (options.finishedAgo === undefined ? 'paused' : 'succeeded');
  const finished = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  const row = await superuser
    .insertInto('jobs')
    .values({
      org_id: ctx.orgId,
      project_id: options.projectId ?? null,
      user_id: ctx.userId,
      type: 'test-job',
      status,
      created_at: ago(options.createdAgo ?? options.finishedAgo ?? 0),
      finished_at: finished ? ago(options.finishedAgo ?? 0) : null,
      error_code: status === 'failed' ? 'JOB_FAILED' : null,
      error_message: status === 'failed' ? '失败' : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertEvent(ctx: TenantContext, jobId: string, createdAgo: number): Promise<string> {
  const row = await superuser
    .insertInto('job_events')
    .values({ org_id: ctx.orgId, job_id: jobId, kind: 'log', message: '日志', created_at: ago(createdAgo) })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

async function exists(table: string, id: string): Promise<boolean> {
  return (await superuser.selectFrom(table).select('id').where('id', '=', id).executeTakeFirst()) !== undefined;
}

function newCleaner(overrides: Partial<Parameters<typeof createCleaner>[0]> = {}) {
  const logs = testLogger();
  const cleaner = createCleaner({ db: appDb, objectStore: store, log: logs.log, ...overrides });
  return { cleaner, logs };
}

function byCategory(results: CleanupCategoryResult[]): Record<CleanupCategory, CleanupCategoryResult> {
  return Object.fromEntries(results.map((result) => [result.category, result])) as Record<CleanupCategory, CleanupCategoryResult>;
}

/** 执行到没有可删的为止，使下一个测试的计数只含它自己的数据。 */
async function drain(): Promise<void> {
  const { cleaner } = newCleaner({ now: () => Date.now() });
  for (let round = 0; round < 10; round += 1) {
    const results = await cleaner.runBatch();
    if (results.every((result) => result.deleted === 0 && result.objects === 0)) return;
  }
}

/** 以清理角色执行（超级用户 SET ROLE，事务结束即恢复），用于直接检验角色的权限和策略。 */
async function asCleanupRole<T>(work: (trx: Kysely<any>) => Promise<T>): Promise<T> {
  return superuser.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE ${sql.id(CLEANUP_ROLE)}`.execute(trx);
    return work(trx);
  });
}

async function expectSqlError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
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
  await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'cleanup-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

beforeEach(() => {
  store = createMemoryStore();
});

describe('角色与权限', () => {
  it('bidtools_cleanup 与其他定义者角色属性相同：不能登录、非超级用户、无 BYPASSRLS；迁移角色只能 SET ROLE、不继承', async () => {
    const role = await superuser
      .selectFrom('pg_roles')
      .select(['rolcanlogin', 'rolsuper', 'rolbypassrls', 'rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolreplication'])
      .where('rolname', '=', CLEANUP_ROLE)
      .executeTakeFirstOrThrow();
    expect(role).toEqual({
      rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
    });
    const { rows } = await sql<{ member: string; inherit_option: boolean; set_option: boolean }>`
      SELECT pg_get_userbyid(m.member) AS member, m.inherit_option, m.set_option FROM pg_auth_members m
      WHERE m.roleid = ${CLEANUP_ROLE}::regrole`.execute(superuser);
    expect(rows).toEqual([{ member: OWNER_ROLE, inherit_option: false, set_option: true }]);
    // 应用角色不是它的成员，不能 SET ROLE 成它。
    await expectSqlError(
      appDb.transaction().execute((trx) => sql`SET LOCAL ROLE ${sql.id(CLEANUP_ROLE)}`.execute(trx)),
      '42501',
    );
  });

  it('对计费账本、余额、价格表、用量记录、平台凭据、平台模型没有任何表级或列级权限，也没有为它建的策略', async () => {
    for (const table of BILLING_TABLES) {
      for (const privilege of TABLE_PRIVILEGES) {
        const { rows } = await sql<{ ok: boolean }>`SELECT has_table_privilege(${CLEANUP_ROLE}, ${`public.${table}`}, ${privilege}) AS ok`.execute(superuser);
        expect(rows[0]!.ok, `${table} ${privilege}`).toBe(false);
      }
      for (const privilege of COLUMN_PRIVILEGES) {
        const { rows } = await sql<{ ok: boolean }>`SELECT has_any_column_privilege(${CLEANUP_ROLE}, ${`public.${table}`}, ${privilege}) AS ok`.execute(superuser);
        expect(rows[0]!.ok, `${table} column ${privilege}`).toBe(false);
      }
    }
    const policies = await sql<{ tablename: string; policyname: string }>`
      SELECT tablename, policyname FROM pg_policies WHERE ${CLEANUP_ROLE} = ANY (roles) ORDER BY tablename, policyname`.execute(superuser);
    expect(policies.rows.filter((row) => BILLING_TABLES.includes(row.tablename))).toEqual([]);
    expect([...new Set(policies.rows.map((row) => row.tablename))]).toEqual(CLEANUP_TABLES);
  });

  it('除 files、artifacts、projects、jobs、job_events 外，对任何表都没有权限；对这五张表只有 SELECT（列级）和 DELETE', async () => {
    const { rows } = await sql<{ relname: string; privileges: string[] }>`
      SELECT c.relname,
        array(SELECT p FROM unnest(${TABLE_PRIVILEGES}::text[]) p WHERE has_table_privilege(${CLEANUP_ROLE}, c.oid, p)
              UNION SELECT 'column ' || p FROM unnest(${COLUMN_PRIVILEGES}::text[]) p WHERE has_any_column_privilege(${CLEANUP_ROLE}, c.oid, p)
              ) AS privileges
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') ORDER BY c.relname`.execute(superuser);
    const granted = rows.filter((row) => row.privileges.length > 0);
    expect(granted.map((row) => row.relname)).toEqual(CLEANUP_TABLES);
    // 在 JS 中排序：CI 的数据库按 en_US 排序规则比较字符串，与本机的 C 排序不同。
    for (const row of granted) expect([...row.privileges].sort(), row.relname).toEqual(['DELETE', 'column SELECT']);
  });

  it('以清理角色直接读写计费表一律被拒绝', async () => {
    for (const table of BILLING_TABLES) {
      await expectSqlError(asCleanupRole((trx) => sql`SELECT count(*) FROM ${sql.id(table)}`.execute(trx)), '42501');
      await expectSqlError(asCleanupRole((trx) => sql`DELETE FROM ${sql.id(table)}`.execute(trx)), '42501');
      await expectSqlError(asCleanupRole((trx) => sql`TRUNCATE ${sql.id(table)}`.execute(trx)), '42501');
    }
    await expectSqlError(asCleanupRole((trx) => sql`UPDATE files SET deleted_at = now()`.execute(trx)), '42501');
    await expectSqlError(asCleanupRole((trx) => sql`INSERT INTO job_events (org_id, job_id, kind) VALUES (gen_random_uuid(), gen_random_uuid(), 'log')`.execute(trx)), '42501');
  });

  it('清理函数的属主都是 bidtools_cleanup、SECURITY DEFINER、固定 search_path，只授给应用角色；它不拥有其他函数；冻结收尾函数属于 bidtools_billing', async () => {
    const { rows } = await sql<{ proname: string; owner: string; secdef: boolean; config: string[] | null; args: string; public_exec: boolean; app_exec: boolean }>`
      SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config,
             pg_get_function_identity_arguments(p.oid) AS args,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege(${APP_ROLE}, p.oid, 'EXECUTE') AS app_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND (p.proname LIKE 'cleanup\\_%' OR p.proowner = ${CLEANUP_ROLE}::regrole)
      ORDER BY p.proname`.execute(superuser);
    expect(rows.map((row) => row.proname)).toEqual(CLEANUP_FUNCTIONS);
    for (const row of rows) {
      expect(row, row.proname).toMatchObject({ owner: CLEANUP_ROLE, secdef: true, public_exec: false, app_exec: true });
      expect(row.config, row.proname).toEqual(['search_path=pg_catalog, pg_temp']);
      // 调用方只能传行 id、批量上限或对象键，不能传时间、保留期或组织。
      expect(['p_limit integer', 'p_id uuid', 'p_keys text[]'], row.proname).toContain(row.args);
    }
    const holds = await sql<{ owner: string }>`
      SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'ai_usage_expire_holds'`.execute(superuser);
    expect(holds.rows).toEqual([{ owner: BILLING_ROLE }]);
  });
});

describe('只删除超过保留期的数据', () => {
  beforeEach(drain);

  it('文件：删除超过 7 天的连同对象删除，恢复期内、未删除的不动；文件下的文档行级联删除', async () => {
    const ctx = await newOrg();
    const project = await insertProject(ctx);
    const live = await insertFile(ctx);
    const recent = await insertFile(ctx, { deletedAgo: 7 * DAY - HOUR, createdAgo: 30 * DAY });
    const expired = await insertFile(ctx, { deletedAgo: 7 * DAY + HOUR, projectId: project, createdAgo: 30 * DAY });
    await superuser.insertInto('technical_plan_documents').values({ file_id: expired.id, org_id: ctx.orgId, project_id: project, role: 'tender' }).execute();

    const { cleaner } = newCleaner();
    const results = byCategory(await cleaner.runBatch());
    expect(results.files).toMatchObject({ deleted: 1, objects: 1, failed: 0 });
    expect(await exists('files', expired.id)).toBe(false);
    expect(store.objects.has(expired.key)).toBe(false);
    expect(await superuser.selectFrom('technical_plan_documents').select('file_id').where('file_id', '=', expired.id).execute()).toEqual([]);
    for (const kept of [live, recent]) {
      expect(await exists('files', kept.id)).toBe(true);
      expect(store.objects.has(kept.key)).toBe(true);
    }
    expect(await exists('projects', project)).toBe(true);
  });

  it('项目：删除超过 7 天的先删其下文件、产物（含对象），再删项目，项目级表与任务记录级联删除；恢复期内的项目连同其下内容不动', async () => {
    const ctx = await newOrg();
    const expiredProject = await insertProject(ctx, 7 * DAY + HOUR);
    const recentProject = await insertProject(ctx, 7 * DAY - HOUR);
    const liveProject = await insertProject(ctx);
    const seeded = new Map<string, { file: { id: string; key: string }; artifact: { id: string; key: string }; job: string }>();
    for (const project of [expiredProject, recentProject, liveProject]) {
      const file = await insertFile(ctx, { projectId: project, createdAgo: 30 * DAY });
      const artifact = await insertArtifact(ctx, { projectId: project, sourceFileId: file.id, createdAgo: 30 * DAY });
      await superuser.insertInto('technical_plan_meta').values({ project_id: project, org_id: ctx.orgId }).execute();
      await superuser.insertInto('technical_plan_documents')
        .values({ file_id: file.id, org_id: ctx.orgId, project_id: project, role: 'tender', markdown_artifact_id: artifact.id }).execute();
      seeded.set(project, { file, artifact, job: await insertJob(ctx, { projectId: project, finishedAgo: DAY }) });
    }

    const results = byCategory(await newCleaner().cleaner.runBatch());
    expect(results.artifacts).toMatchObject({ deleted: 1, objects: 1, failed: 0 });
    expect(results.files).toMatchObject({ deleted: 1, objects: 1, failed: 0 });
    expect(results.projects).toMatchObject({ deleted: 1, objects: 0, failed: 0 });

    const gone = seeded.get(expiredProject)!;
    expect(await exists('projects', expiredProject)).toBe(false);
    expect(await exists('files', gone.file.id)).toBe(false);
    expect(await exists('artifacts', gone.artifact.id)).toBe(false);
    expect(await exists('jobs', gone.job)).toBe(false);
    expect(store.objects.has(gone.file.key) || store.objects.has(gone.artifact.key)).toBe(false);
    expect(await superuser.selectFrom('technical_plan_meta').select('project_id').where('project_id', '=', expiredProject).execute()).toEqual([]);

    for (const project of [recentProject, liveProject]) {
      const kept = seeded.get(project)!;
      expect(await exists('projects', project)).toBe(true);
      expect(await exists('files', kept.file.id)).toBe(true);
      expect(await exists('artifacts', kept.artifact.id)).toBe(true);
      expect(await exists('jobs', kept.job)).toBe(true);
      expect(store.objects.has(kept.file.key) && store.objects.has(kept.artifact.key)).toBe(true);
      expect(await superuser.selectFrom('technical_plan_documents').select('markdown_artifact_id').where('file_id', '=', kept.file.id).executeTakeFirst())
        .toEqual({ markdown_artifact_id: kept.artifact.id });
    }
  });

  it('产物：被替换超过 7 天的删除，引用它的文档改为空；被替换未满 7 天的、来源文件仍在恢复期内的不动；来源文件过期的产物先于文件删除', async () => {
    const ctx = await newOrg();
    const project = await insertProject(ctx);
    const source = await insertFile(ctx, { projectId: project, createdAgo: 30 * DAY });
    const old = await insertArtifact(ctx, { projectId: project, sourceFileId: source.id, supersededAgo: 7 * DAY + HOUR, createdAgo: 30 * DAY });
    const recent = await insertArtifact(ctx, { projectId: project, sourceFileId: source.id, supersededAgo: 7 * DAY - HOUR, createdAgo: 30 * DAY });
    const current = await insertArtifact(ctx, { projectId: project, sourceFileId: source.id, createdAgo: 30 * DAY });
    await superuser.insertInto('technical_plan_documents')
      .values({ file_id: source.id, org_id: ctx.orgId, project_id: project, role: 'tender', markdown_artifact_id: old.id }).execute();
    const restorable = await insertFile(ctx, { deletedAgo: 6 * DAY, createdAgo: 30 * DAY });
    const restorableArtifact = await insertArtifact(ctx, { sourceFileId: restorable.id, createdAgo: 30 * DAY });
    const expiredSource = await insertFile(ctx, { deletedAgo: 8 * DAY, createdAgo: 30 * DAY });
    const orphaned = await insertArtifact(ctx, { sourceFileId: expiredSource.id, createdAgo: 30 * DAY });

    const results = byCategory(await newCleaner().cleaner.runBatch());
    expect(results.artifacts).toMatchObject({ deleted: 2, objects: 2, failed: 0 });
    expect(results.files).toMatchObject({ deleted: 1, objects: 1, failed: 0 });
    for (const gone of [old, orphaned]) {
      expect(await exists('artifacts', gone.id)).toBe(false);
      expect(store.objects.has(gone.key)).toBe(false);
    }
    expect(await exists('files', expiredSource.id)).toBe(false);
    expect(await superuser.selectFrom('technical_plan_documents').select('markdown_artifact_id').where('file_id', '=', source.id).executeTakeFirst())
      .toEqual({ markdown_artifact_id: null });
    for (const kept of [recent, current, restorableArtifact]) {
      expect(await exists('artifacts', kept.id)).toBe(true);
      expect(store.objects.has(kept.key)).toBe(true);
    }
    expect(await exists('files', restorable.id)).toBe(true);
  });

  it('遗留的 uploading 文件、writing 产物：登记超过 24 小时的删除（计入 uploading 类），未满 24 小时的不动；过期后不能再完成上传或写入', async () => {
    const ctx = await newOrg();
    const staleUpload = await insertFile(ctx, { uploading: true, createdAgo: 24 * HOUR + 60_000 });
    const freshUpload = await insertFile(ctx, { uploading: true, createdAgo: 23 * HOUR });
    const missingObject = await insertFile(ctx, { uploading: true, createdAgo: 2 * DAY, object: false });
    const staleWrite = await insertArtifact(ctx, { sourceFileId: (await insertFile(ctx)).id, writing: true, createdAgo: 24 * HOUR + 60_000 });
    const freshWrite = await insertArtifact(ctx, { sourceFileId: (await insertFile(ctx)).id, writing: true, createdAgo: 23 * HOUR });

    // 24 小时后才完成的上传 / 写入被拒绝（FS006 → 408、AR005），这样清理任务删掉对象之后，这一行不会再变成已上传。
    const late = await insertFile(ctx, { uploading: true, createdAgo: 25 * HOUR });
    const content = { mime: 'application/pdf', size: 4, sha256: Buffer.alloc(32) };
    await expect(completeUpload(appDb, ctx, late.id, content)).rejects.toMatchObject({ statusCode: 408, code: 'UPLOAD_TIMEOUT' });
    const lateArtifact = await insertArtifact(ctx, { sourceFileId: (await insertFile(ctx)).id, writing: true, createdAgo: 25 * HOUR });
    await expectSqlError(completeArtifact(appDb, ctx, lateArtifact.id, { size: 4, sha256: Buffer.alloc(32) }), 'AR005');
    // 对照组：未满 24 小时的照常完成。
    const onTime = await insertFile(ctx, { uploading: true, createdAgo: 23 * HOUR });
    expect(await completeUpload(appDb, ctx, onTime.id, content)).toMatchObject({ id: onTime.id });

    const results = byCategory(await newCleaner().cleaner.runBatch());
    // staleUpload、missingObject、late（文件）+ staleWrite、lateArtifact（产物）；对象不存在的照样删行。
    expect(results.uploading).toMatchObject({ deleted: 5, objects: 5, failed: 0 });
    expect(results.files).toMatchObject({ deleted: 0 });
    expect(results.artifacts).toMatchObject({ deleted: 0 });
    for (const gone of [staleUpload, missingObject, late]) expect(await exists('files', gone.id)).toBe(false);
    for (const gone of [staleWrite, lateArtifact]) expect(await exists('artifacts', gone.id)).toBe(false);
    expect(store.objects.has(staleUpload.key) || store.objects.has(staleWrite.key)).toBe(false);
    expect(await exists('files', freshUpload.id)).toBe(true);
    expect(await exists('artifacts', freshWrite.id)).toBe(true);
    expect(store.objects.has(freshUpload.key) && store.objects.has(freshWrite.key)).toBe(true);
  });

  it('任务记录：已结束超过 90 天的任务（连同其事件）删除，未满 90 天的与未结束的不动；超过 30 天的事件删除', async () => {
    const ctx = await newOrg();
    const old = await insertJob(ctx, { finishedAgo: 90 * DAY + HOUR });
    const oldFailed = await insertJob(ctx, { finishedAgo: 91 * DAY, status: 'failed' });
    const oldCancelled = await insertJob(ctx, { finishedAgo: 120 * DAY, status: 'cancelled' });
    const recent = await insertJob(ctx, { finishedAgo: 90 * DAY - HOUR });
    // 未结束的任务（暂停了 200 天）不论多久都不删。
    const paused = await insertJob(ctx, { status: 'paused', createdAgo: 200 * DAY });
    const oldEvent = await insertEvent(ctx, old, 95 * DAY);
    const recentOld = await insertEvent(ctx, recent, 31 * DAY);
    const recentNew = await insertEvent(ctx, recent, 29 * DAY);
    const pausedOld = await insertEvent(ctx, paused, 31 * DAY);
    const pausedNew = await insertEvent(ctx, paused, DAY);

    const results = byCategory(await newCleaner().cleaner.runBatch());
    expect(results.jobs).toMatchObject({ deleted: 3, objects: 0, failed: 0 });
    // 被删除任务的事件随任务级联删除，不计入 job_events。
    expect(results.job_events).toMatchObject({ deleted: 2, objects: 0, failed: 0 });
    for (const gone of [old, oldFailed, oldCancelled]) expect(await exists('jobs', gone)).toBe(false);
    for (const kept of [recent, paused]) expect(await exists('jobs', kept)).toBe(true);
    for (const gone of [oldEvent, recentOld, pausedOld]) expect(await exists('job_events', gone)).toBe(false);
    for (const kept of [recentNew, pausedNew]) expect(await exists('job_events', kept)).toBe(true);
  });

  it('每批每类最多 1000 行，剩下的下一批继续', async () => {
    const ctx = await newOrg();
    await superuser.insertInto('jobs').values(Array.from({ length: CLEANUP_BATCH_MAX + 5 }, () => ({
      org_id: ctx.orgId, user_id: ctx.userId, type: 'test-job', status: 'succeeded', created_at: ago(100 * DAY), finished_at: ago(100 * DAY),
    }))).execute();
    const { cleaner } = newCleaner({ batchSize: 10_000 });
    expect(byCategory(await cleaner.runBatch()).jobs.deleted).toBe(CLEANUP_BATCH_MAX);
    expect(byCategory(await cleaner.runBatch()).jobs.deleted).toBe(5);
  });
});

describe('调用方不能绕过删除条件', () => {
  beforeEach(drain);

  it('按 id 删除未过期的文件、产物一律影响 0 行（含恢复期内、未删除、上传中未超时、项目在恢复期内的）', async () => {
    const ctx = await newOrg();
    const recentProject = await insertProject(ctx, 6 * DAY);
    const files = [
      await insertFile(ctx),
      await insertFile(ctx, { deletedAgo: 7 * DAY - HOUR }),
      await insertFile(ctx, { uploading: true, createdAgo: 23 * HOUR }),
      await insertFile(ctx, { projectId: recentProject }),
    ];
    const artifacts = [
      await insertArtifact(ctx, { sourceFileId: files[0]!.id }),
      await insertArtifact(ctx, { sourceFileId: files[1]!.id }),
      await insertArtifact(ctx, { projectId: recentProject }),
      await insertArtifact(ctx, { sourceFileId: files[0]!.id, supersededAgo: 7 * DAY - HOUR }),
      await insertArtifact(ctx, { sourceFileId: files[0]!.id, writing: true, createdAgo: 23 * HOUR }),
    ];
    for (const artifact of artifacts) {
      const { rows } = await sql<{ ok: boolean }>`SELECT cleanup_delete_artifact(${artifact.id}::uuid) AS ok`.execute(appDb);
      expect(rows[0]!.ok).toBe(false);
      expect(await exists('artifacts', artifact.id)).toBe(true);
    }
    for (const file of files) {
      const { rows } = await sql<{ ok: boolean }>`SELECT cleanup_delete_file(${file.id}::uuid) AS ok`.execute(appDb);
      expect(rows[0]!.ok).toBe(false);
      expect(await exists('files', file.id)).toBe(true);
    }
    // 不存在的 id、其他组织的上下文都一样。
    expect((await sql<{ ok: boolean }>`SELECT cleanup_delete_file(${randomUUID()}::uuid) AS ok`.execute(appDb)).rows[0]!.ok).toBe(false);
    // 候选列表中也没有它们。
    const fileCandidates = await sql<{ id: string }>`SELECT id FROM cleanup_file_candidates(1000)`.execute(appDb);
    const artifactCandidates = await sql<{ id: string }>`SELECT id FROM cleanup_artifact_candidates(1000)`.execute(appDb);
    expect(fileCandidates.rows).toEqual([]);
    expect(artifactCandidates.rows).toEqual([]);
  });

  it('过期文件还挂着产物时按 id 删除同样影响 0 行（外键要求产物先删，避免对象已删、行删不掉）', async () => {
    const ctx = await newOrg();
    const file = await insertFile(ctx, { deletedAgo: 8 * DAY });
    const artifact = await insertArtifact(ctx, { sourceFileId: file.id });
    expect((await sql<{ ok: boolean }>`SELECT cleanup_delete_file(${file.id}::uuid) AS ok`.execute(appDb)).rows[0]!.ok).toBe(false);
    expect((await sql<{ id: string }>`SELECT id FROM cleanup_file_candidates(1000)`.execute(appDb)).rows).toEqual([]);
    expect((await sql<{ ok: boolean }>`SELECT cleanup_delete_artifact(${artifact.id}::uuid) AS ok`.execute(appDb)).rows[0]!.ok).toBe(true);
    expect((await sql<{ ok: boolean }>`SELECT cleanup_delete_file(${file.id}::uuid) AS ok`.execute(appDb)).rows[0]!.ok).toBe(true);
  });

  it('批量删除项目、任务、事件的函数只接受上限：恢复期内的项目、未满保留期的任务和事件不受上限影响，传入极端值也只是被夹在 1~1000', async () => {
    const ctx = await newOrg();
    const project = await insertProject(ctx, 7 * DAY - HOUR);
    const job = await insertJob(ctx, { finishedAgo: 89 * DAY });
    const event = await insertEvent(ctx, job, 29 * DAY);
    for (const limit of [1, 1000, 2_147_483_647, 0, -1, null]) {
      for (const fn of ['cleanup_delete_projects', 'cleanup_delete_jobs', 'cleanup_delete_job_events']) {
        const { rows } = await sql<{ n: number }>`SELECT ${sql.raw(fn)}(${limit}::integer) AS n`.execute(appDb);
        expect(rows[0]!.n, `${fn}(${limit})`).toBe(0);
      }
    }
    expect(await exists('projects', project)).toBe(true);
    expect(await exists('jobs', job)).toBe(true);
    expect(await exists('job_events', event)).toBe(true);
    // 不接受时间参数：传入时间的调用没有对应的函数。
    await expectSqlError(sql`SELECT cleanup_delete_jobs(now())`.execute(appDb), '42883');
    await expectSqlError(sql`SELECT cleanup_delete_projects(1, now() + interval '1 year')`.execute(appDb), '42883');
    await expectSqlError(sql`SELECT cleanup_file_candidates(1000, interval '0 days')`.execute(appDb), '42883');
  });

  it('即使绕过函数、以清理角色直接 DELETE，策略也只放行过期的行', async () => {
    const ctx = await newOrg();
    const project = await insertProject(ctx, 6 * DAY);
    const file = await insertFile(ctx, { deletedAgo: 6 * DAY });
    const job = await insertJob(ctx, { finishedAgo: 10 * DAY });
    const event = await insertEvent(ctx, job, DAY);
    const artifact = await insertArtifact(ctx, { projectId: project });
    const counts = await asCleanupRole(async (trx) => ({
      artifacts: Number((await trx.deleteFrom('artifacts').executeTakeFirst()).numDeletedRows),
      files: Number((await trx.deleteFrom('files').executeTakeFirst()).numDeletedRows),
      projects: Number((await trx.deleteFrom('projects').executeTakeFirst()).numDeletedRows),
      job_events: Number((await trx.deleteFrom('job_events').executeTakeFirst()).numDeletedRows),
      jobs: Number((await trx.deleteFrom('jobs').executeTakeFirst()).numDeletedRows),
    }));
    expect(counts).toEqual({ artifacts: 0, files: 0, projects: 0, job_events: 0, jobs: 0 });
    for (const [table, id] of [['projects', project], ['files', file.id], ['jobs', job], ['job_events', event], ['artifacts', artifact.id]] as const) {
      expect(await exists(table, id), table).toBe(true);
    }
  });

  it('改会话时区、设置租户上下文都不影响判断（过期只按数据库的 now() 计算）', async () => {
    const ctx = await newOrg();
    const file = await insertFile(ctx, { deletedAgo: 6 * DAY });
    const ok = await appDb.transaction().execute(async (trx) => {
      await sql`SET LOCAL timezone = 'Pacific/Kiritimati'`.execute(trx);
      await sql`SELECT set_config('app.org_id', ${ctx.orgId}, true), set_config('app.user_id', ${ctx.userId}, true)`.execute(trx);
      return (await sql<{ ok: boolean }>`SELECT cleanup_delete_file(${file.id}::uuid) AS ok`.execute(trx)).rows[0]!.ok;
    });
    expect(ok).toBe(false);
    expect(await exists('files', file.id)).toBe(true);
  });
});

describe('对象存储：先删对象，成功后再删行', () => {
  beforeEach(drain);

  it('删除对象时行仍在；对象删除失败的行与对象都保留，下一批重试成功', async () => {
    const ctx = await newOrg();
    const ok = await insertFile(ctx, { deletedAgo: 8 * DAY });
    const flaky = await insertFile(ctx, { deletedAgo: 8 * DAY });
    const flakyArtifact = await insertArtifact(ctx, { sourceFileId: ok.id, supersededAgo: 8 * DAY });
    const rowPresentAtDelete = new Map<string, boolean>();
    store.beforeDelete = async (key) => {
      const id = key.split('/')[3]!;
      rowPresentAtDelete.set(key, (await exists(key.includes('/files/') ? 'files' : 'artifacts', id)));
    };
    store.failDelete = new Set([flaky.key, flakyArtifact.key]);

    const { cleaner, logs } = newCleaner();
    const first = byCategory(await cleaner.runBatch());
    expect(first.artifacts).toMatchObject({ deleted: 0, objects: 0, failed: 1 });
    // ok 的产物删除失败，ok 仍挂着产物，本批不删；flaky 对象删除失败，行保留。
    expect(first.files).toMatchObject({ deleted: 0, objects: 0, failed: 1 });
    expect([...rowPresentAtDelete.values()].every(Boolean)).toBe(true);
    for (const kept of [ok, flaky]) expect(await exists('files', kept.id)).toBe(true);
    expect(await exists('artifacts', flakyArtifact.id)).toBe(true);
    expect(store.objects.has(flaky.key) && store.objects.has(flakyArtifact.key) && store.objects.has(ok.key)).toBe(true);
    // 失败只计数，日志中不出现对象键。
    expect(JSON.stringify(logs.entries)).not.toContain('org/');

    store.failDelete.clear();
    rowPresentAtDelete.clear();
    const second = byCategory(await cleaner.runBatch());
    expect(second.artifacts).toMatchObject({ deleted: 1, objects: 1, failed: 0 });
    expect(second.files).toMatchObject({ deleted: 2, objects: 2, failed: 0 });
    expect(rowPresentAtDelete.size).toBe(3);
    expect([...rowPresentAtDelete.values()].every(Boolean)).toBe(true);
    for (const gone of [ok, flaky]) expect(await exists('files', gone.id)).toBe(false);
    expect(store.objects.size).toBe(0);
  });

  it('未配置对象存储时有对象的行一律不删（不留孤儿对象），没有对象的项目、任务记录照常清理', async () => {
    const ctx = await newOrg();
    const file = await insertFile(ctx, { deletedAgo: 8 * DAY });
    const upload = await insertFile(ctx, { uploading: true, createdAgo: 2 * DAY });
    const project = await insertProject(ctx, 8 * DAY);
    const job = await insertJob(ctx, { finishedAgo: 100 * DAY });
    const results = byCategory(await newCleaner({ objectStore: null }).cleaner.runBatch());
    for (const category of ['artifacts', 'files', 'uploading', 'orphans'] as const) {
      expect(results[category]).toMatchObject({ deleted: 0, objects: 0, failed: 0, skipped: true });
    }
    expect(results.projects.deleted).toBe(1);
    expect(results.jobs.deleted).toBe(1);
    expect(await exists('files', file.id)).toBe(true);
    expect(await exists('files', upload.id)).toBe(true);
    expect(await exists('projects', project)).toBe(false);
  });

  it('孤儿对象：只删除超过 7 天、形如 org/{org}/files|artifacts/{id} 且没有对应行的对象', async () => {
    const ctx = await newOrg();
    const live = await insertFile(ctx);
    const recentDeleted = await insertFile(ctx, { deletedAgo: 6 * DAY });
    const backdate = (key: string, ageMs: number) => store.objects.set(key, { body: Buffer.from('x'), lastModified: ago(ageMs) });
    backdate(live.key, 30 * DAY);
    backdate(recentDeleted.key, 30 * DAY);
    const oldOrphanFile = `org/${ctx.orgId}/files/${randomUUID()}`;
    const oldOrphanArtifact = `org/${ctx.orgId}/artifacts/${randomUUID()}`;
    const youngOrphan = `org/${ctx.orgId}/files/${randomUUID()}`;
    // 另一个组织前缀下、id 与本组织文件相同的对象：键不同，仍是孤儿。
    const otherOrgSameId = `org/${randomUUID()}/files/${live.id}`;
    const unknownShapes = [`org/${ctx.orgId}/exports/${randomUUID()}`, `org/${ctx.orgId}/files/${randomUUID()}/extra`, `org/${ctx.orgId}/files/NOT-A-UUID`];
    for (const key of [oldOrphanFile, oldOrphanArtifact, otherOrgSameId, ...unknownShapes]) backdate(key, ORPHAN_MIN_AGE_MS + HOUR);
    backdate(youngOrphan, ORPHAN_MIN_AGE_MS - HOUR);
    backdate('tmp/other', 30 * DAY);

    const results = byCategory(await newCleaner().cleaner.runBatch());
    expect(results.orphans).toMatchObject({ deleted: 3, objects: 3, failed: 0 });
    expect([oldOrphanFile, oldOrphanArtifact, otherOrgSameId].some((key) => store.objects.has(key))).toBe(false);
    for (const key of [live.key, recentDeleted.key, youngOrphan, 'tmp/other', ...unknownShapes]) expect(store.objects.has(key), key).toBe(true);
  });

  it('孤儿对象分批扫描：每批从上次停下的位置继续，到末尾后从头开始；删除失败计入 failed', async () => {
    const ctx = await newOrg();
    const orphans = Array.from({ length: 7 }, () => `org/${ctx.orgId}/files/${randomUUID()}`).sort();
    for (const key of orphans) store.objects.set(key, { body: Buffer.from('x'), lastModified: ago(30 * DAY) });
    store.failDelete = new Set([orphans[6]!]);
    const { cleaner } = newCleaner({ orphanScanMax: 3 });
    expect(byCategory(await cleaner.runBatch()).orphans).toMatchObject({ deleted: 3, failed: 0 });
    expect(byCategory(await cleaner.runBatch()).orphans).toMatchObject({ deleted: 3, failed: 0 });
    expect(byCategory(await cleaner.runBatch()).orphans).toMatchObject({ deleted: 0, failed: 1 });
    expect([...store.objects.keys()]).toEqual([orphans[6]]);
    store.failDelete.clear();
    expect(byCategory(await cleaner.runBatch()).orphans).toMatchObject({ deleted: 1, failed: 0 });
    expect(store.objects.size).toBe(0);
  });
});

describe('日志', () => {
  beforeEach(drain);

  it('每批按八个类别各记一行结构化日志：删除条数、对象数、失败数、耗时，不含对象键、文件名和 id', async () => {
    const ctx = await newOrg();
    const secretName = `机密投标-${randomBytes(4).toString('hex')}.pdf`;
    const file = await insertFile(ctx, { deletedAgo: 8 * DAY, name: secretName });
    const job = await insertJob(ctx, { finishedAgo: 100 * DAY });
    const { cleaner, logs } = newCleaner();
    await cleaner.runBatch();
    const lines = logs.entries.filter((entry) => entry.msg === 'cleanup batch');
    expect(lines.map((entry) => (entry.obj as { cleanup: CleanupCategoryResult }).cleanup.category)).toEqual([...CLEANUP_CATEGORIES]);
    for (const entry of lines) {
      expect(entry.level).toBe('info');
      const { cleanup } = entry.obj as { cleanup: CleanupCategoryResult };
      expect(Object.keys(cleanup).sort()).toEqual(['category', 'deleted', 'durationMs', 'failed', 'objects']);
      expect(Number.isInteger(cleanup.durationMs) && cleanup.durationMs >= 0).toBe(true);
    }
    const files = lines.find((entry) => (entry.obj as { cleanup: CleanupCategoryResult }).cleanup.category === 'files')!;
    expect((files.obj as { cleanup: CleanupCategoryResult }).cleanup).toMatchObject({ deleted: 1, objects: 1, failed: 0 });
    const text = JSON.stringify(logs.entries);
    for (const forbidden of [secretName, file.key, file.id, job, ctx.orgId, 'org/']) expect(text).not.toContain(forbidden);
  });

  it('一类出错不影响其他类，出错的类同样记一行（failed = 1），警告中只有错误名称和代码', async () => {
    const ctx = await newOrg();
    await insertJob(ctx, { finishedAgo: 100 * DAY });
    const broken = createMemoryStore();
    broken.list = async () => {
      throw Object.assign(new Error('list failed for org/secret-key'), { name: 'AccessDenied', code: 'AccessDenied' });
    };
    const { cleaner, logs } = newCleaner({ objectStore: broken });
    const results = byCategory(await cleaner.runBatch());
    expect(results.orphans).toMatchObject({ deleted: 0, objects: 0, failed: 1 });
    expect(results.jobs.deleted).toBe(1);
    expect(logs.entries.filter((entry) => entry.msg === 'cleanup batch')).toHaveLength(CLEANUP_CATEGORIES.length);
    const warning = logs.entries.find((entry) => entry.msg === 'cleanup category failed')!;
    expect(warning.obj).toEqual({ categories: ['orphans'], error: { name: 'AccessDenied', code: 'AccessDenied' } });
    expect(JSON.stringify(logs.entries)).not.toContain('secret-key');
  });
});

describe('计费数据不受影响', () => {
  const API_KEY = `sk-test-${randomBytes(8).toString('hex')}`;

  /** 计费表的行数和全部内容的摘要（按主键排序）。 */
  async function billingSnapshot(): Promise<Record<string, { rows: number; digest: string }>> {
    const snapshot: Record<string, { rows: number; digest: string }> = {};
    for (const table of BILLING_TABLES) {
      const { rows } = await sql<{ row: unknown }>`SELECT to_jsonb(t) AS row FROM ${sql.id(table)} t ORDER BY 1`.execute(superuser);
      const serialized = rows.map((row) => JSON.stringify(row.row)).sort();
      snapshot[table] = { rows: rows.length, digest: createHash('sha256').update(serialized.join('\n')).digest('hex') };
    }
    return snapshot;
  }

  it('清理（含删除带用量记录的任务、项目）前后账本与用量记录行数不变，账本、余额、价格表、凭据、模型内容不变；到期冻结只经计费函数收尾', async () => {
    await drain();
    const past = ago(30 * DAY);
    await superuser.insertInto('model_prices').values({
      provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: '1000000', output_price_per_mtok: '1000000',
      effective_from: past, created_at: past, created_by: platformAdmin,
    }).execute();
    await superuser.insertInto('platform_models').values({
      provider: 'deepseek', model: 'deepseek-chat', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin,
    }).execute();
    await putCredential(appDb, ctxAdmin, createFileKeyWrapper(randomBytes(32), 1), { provider: 'deepseek', baseUrl: 'https://api.example.com', apiKey: API_KEY });

    const ctx = await newOrg();
    await creditOrganization(appDb, ctxAdmin, { orgId: ctx.orgId, type: 'recharge', amount: 1_000_000n, reference: null, note: '测试充值' });
    const project = await insertProject(ctx);
    // 两个执行中的任务各调用一次模型并结算（写入账本扣费和用量记录），之后改成已结束很久、所属项目删除很久。
    const jobs: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const id = randomUUID();
      await superuser.insertInto('jobs').values({
        id, org_id: ctx.orgId, project_id: index === 0 ? project : null, user_id: ctx.userId, type: 'test-job', status: 'running',
        run_id: randomUUID(), lease_expires_at: new Date(Date.now() + 60_000), started_at: new Date(),
      }).execute();
      const usage = await beginUsage(appDb, ctx, {
        requestId: randomUUID(), source: 'job', jobId: id, jobType: null, provider: 'deepseek', model: 'deepseek-chat',
        estimatedInputTokens: 10, maxOutputTokens: 10, holdSeconds: 60,
      });
      await settleUsage(appDb, ctx, usage.usageId, { inputTokens: 5, cachedInputTokens: 0, outputTokens: 5, usageSource: 'provider' });
      await insertEvent(ctx, id, 40 * DAY);
      jobs.push(id);
    }
    // 一条已到期的冻结（未结算）：由冻结收尾标为 unbilled，不删除。
    const expiring = await beginUsage(appDb, ctx, {
      requestId: randomUUID(), source: 'interactive', jobId: null, jobType: null, provider: 'deepseek', model: 'deepseek-chat',
      estimatedInputTokens: 10, maxOutputTokens: 10, holdSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await sql`ALTER TABLE jobs DISABLE TRIGGER jobs_guard`.execute(superuser);
    try {
      await superuser.updateTable('jobs').set({ status: 'succeeded', run_id: null, lease_expires_at: null, finished_at: ago(100 * DAY) })
        .where('id', 'in', jobs).execute();
    } finally {
      await sql`ALTER TABLE jobs ENABLE TRIGGER jobs_guard`.execute(superuser);
    }
    await sql`ALTER TABLE projects DISABLE TRIGGER projects_guard`.execute(superuser);
    try {
      await superuser.updateTable('projects').set({ deleted_at: ago(8 * DAY), deleted_by: ctx.userId }).where('id', '=', project).execute();
    } finally {
      await sql`ALTER TABLE projects ENABLE TRIGGER projects_guard`.execute(superuser);
    }

    const usageBefore = await superuser.selectFrom('usage_records').select(['id', 'job_id', 'status', 'amount']).where('org_id', '=', ctx.orgId).orderBy('id').execute();
    expect(usageBefore.filter((row) => row.status === 'billed').map((row) => row.job_id).sort()).toEqual([...jobs].sort());
    const before = await billingSnapshot();
    expect(before.billing_ledger!.rows).toBeGreaterThanOrEqual(3);

    const results = byCategory(await newCleaner().cleaner.runBatch());
    expect(results.holds).toMatchObject({ deleted: 1, objects: 0, failed: 0 });
    expect(results.projects.deleted).toBe(1);
    expect(results.jobs.deleted).toBe(1);
    for (const id of jobs) expect(await exists('jobs', id)).toBe(false);

    const after = await billingSnapshot();
    expect(after.usage_records!.rows).toBe(before.usage_records!.rows);
    for (const table of BILLING_TABLES.filter((name) => name !== 'usage_records')) expect(after[table], table).toEqual(before[table]);
    // 用量记录：行数、job_id、金额不变；只有到期的冻结被计费函数标为 unbilled / abandoned。
    const usageAfter = await superuser.selectFrom('usage_records').select(['id', 'job_id', 'status', 'amount', 'failure_reason']).where('org_id', '=', ctx.orgId).orderBy('id').execute();
    expect(usageAfter.map(({ id, job_id, amount }) => ({ id, job_id, amount }))).toEqual(usageBefore.map(({ id, job_id, amount }) => ({ id, job_id, amount })));
    expect(usageAfter.find((row) => row.id === expiring.usageId)).toMatchObject({ status: 'unbilled', failure_reason: 'abandoned' });

    // 再跑一批：什么都不再变化。
    await newCleaner().cleaner.runBatch();
    const again = await billingSnapshot();
    expect(again).toEqual(after);
  });
});

describe('定时执行', () => {
  it('启动后按间隔执行，close 后不再执行并等正在执行的一批结束', async () => {
    let runs = 0;
    let release: (() => void) | null = null;
    const cleaner = {
      async runBatch(signal?: AbortSignal) {
        runs += 1;
        if (runs === 2) await new Promise<void>((resolve) => { release = resolve; signal?.addEventListener('abort', () => resolve(), { once: true }); });
        return [];
      },
    };
    const logs = testLogger();
    const schedule = startCleanupSchedule(cleaner, { initialDelayMs: 10, intervalMs: 20, log: logs.log });
    await expect.poll(() => runs, { timeout: 2_000 }).toBe(2);
    const closing = schedule.close();
    await closing;
    expect(release).not.toBeNull();
    const after = runs;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runs).toBe(after);
  });
});

describe('真实的 S3 兼容服务', () => {
  let bucket: TestBucket;

  beforeAll(async () => {
    bucket = await createTestBucket();
  });

  afterAll(async () => {
    await bucket?.drop();
  });

  it('列出与删除：过期文件的对象删除后再删行，孤儿对象按修改时间判断，删除已不存在的对象不报错', async () => {
    await drain();
    const s3 = createS3ObjectStore(bucket.config, bucket.client);
    const ctx = await newOrg();
    const put = (key: string) => s3.put(key, Readable.from(Buffer.from('content')), { contentType: 'application/octet-stream' });
    const expired = (await superuser.insertInto('files').values({
      org_id: ctx.orgId, purpose: 'tender', display_name: 'a.pdf', extension: 'pdf', status: 'uploaded', mime: 'application/pdf',
      size_bytes: 7, sha256: Buffer.alloc(32), uploaded_at: ago(30 * DAY), created_by: ctx.userId, created_at: ago(30 * DAY),
      deleted_at: ago(8 * DAY), deleted_by: ctx.userId,
    }).returning(['id', 'storage_key']).executeTakeFirstOrThrow());
    const live = (await superuser.insertInto('files').values({
      org_id: ctx.orgId, purpose: 'tender', display_name: 'b.pdf', extension: 'pdf', status: 'uploaded', mime: 'application/pdf',
      size_bytes: 7, sha256: Buffer.alloc(32), uploaded_at: new Date(), created_by: ctx.userId,
    }).returning(['id', 'storage_key']).executeTakeFirstOrThrow());
    const orphan = `org/${ctx.orgId}/artifacts/${randomUUID()}`;
    await put(expired.storage_key);
    await put(live.storage_key);
    await put(orphan);
    await put('unrelated/object');

    // 对象刚写入：现在执行时孤儿还不满 7 天，不删。
    const now = createCleaner({ db: appDb, objectStore: s3, log: testLogger().log, orphanScanMax: 2 });
    const first = byCategory(await now.runBatch());
    expect(first.files).toMatchObject({ deleted: 1, objects: 1, failed: 0 });
    expect(first.orphans).toMatchObject({ deleted: 0, failed: 0 });
    expect(await bucket.keys()).toEqual([live.storage_key, orphan, 'unrelated/object'].sort());
    expect(await exists('files', expired.id)).toBe(false);

    // 8 天后（回拨当前时间）：孤儿对象删除，有对应行的和不认识的对象保留；分两批扫完（每批 2 个）。
    const later = createCleaner({ db: appDb, objectStore: s3, log: testLogger().log, orphanScanMax: 2, now: () => Date.now() + 8 * DAY });
    let deleted = 0;
    for (let round = 0; round < 3; round += 1) deleted += byCategory(await later.runBatch()).orphans.deleted;
    expect(deleted).toBe(1);
    expect(await bucket.keys()).toEqual([live.storage_key, 'unrelated/object'].sort());
    await expect(s3.delete(orphan)).resolves.toBeUndefined();
  });
});

describe('与已有守卫的配合', () => {
  it('应用角色仍不能物理删除已上传的文件、项目和任务记录', async () => {
    const ctx = await newOrg();
    const file = await insertFile(ctx, { deletedAgo: 8 * DAY });
    const deleted = await appDb.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.org_id', ${ctx.orgId}, true), set_config('app.user_id', ${ctx.userId}, true)`.execute(trx);
      return Number((await trx.deleteFrom('files').where('id', '=', file.id).executeTakeFirst()).numDeletedRows);
    });
    expect(deleted).toBe(0);
    await expectSqlError(appDb.deleteFrom('projects').execute(), '42501');
    await expectSqlError(appDb.deleteFrom('jobs').execute(), '42501');
  });
});
