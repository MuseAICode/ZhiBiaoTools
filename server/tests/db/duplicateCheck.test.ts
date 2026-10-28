// 标书查重（迁移 0014_duplicate_check）的数据库与接口测试：十三张表的隔离模板（describeProjectTable，项目级），
// 删除可见性与写权限由 RLS 强制（绕过 Store 直接写库同样被拒绝），文件选择、给查重任务用的写函数，以及状态、
// 文件选择、页面状态、清空、Excel 导出接口。
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { DUPLICATE_CHECK_TABLES } from '../../src/db/migrations/0014_duplicate_check.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { APP_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import {
  clearDuplicateCheck,
  loadDuplicateCheck,
  saveAnalysisSection,
  saveFiles,
  saveUiState,
  selectionSignature,
} from '../../src/duplicateCheck/store.ts';
import type { ProjectKind } from '../../src/projects/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { readWorkbook } from '../xlsx/readXlsx.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable, type ProjectRowScope } from './projectTable.ts';

const PASSWORD = 'quiet-harbor-maple-58';

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
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let app: FastifyInstance;
const EXPORTED_AT = new Date('2026-10-20T01:02:03Z');

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

/** 新建一个用户及其个人组织（owner），或以普通成员加入已有组织，并登录。 */
async function newMember(orgId: string = randomUUID()): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  const existing = await superuser.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
  if (!existing) await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  const role = existing ? 'member' : 'owner';
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { userId, orgId, cookie: await login(email), context: { orgId, userId, role } };
}

async function newProject(member: Pick<Member, 'orgId' | 'userId'>, kind: ProjectKind = 'duplicate-check'): Promise<string> {
  const row = await superuser
    .insertInto('projects')
    .values({ org_id: member.orgId, kind, name: '查重项目', created_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** 用超级用户直接登记一个已上传的文件（默认标书查重用途、不属于任何项目）。 */
async function newFile(
  member: Pick<Member, 'orgId' | 'userId'>,
  options: { name?: string; purpose?: string; projectId?: string | null; status?: 'uploaded' | 'uploading'; size?: number } = {},
): Promise<string> {
  const uploaded = (options.status ?? 'uploaded') === 'uploaded';
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      purpose: options.purpose ?? 'duplicate-check',
      display_name: options.name ?? '投标文件.docx',
      extension: 'docx',
      status: uploaded ? 'uploaded' : 'uploading',
      mime: uploaded ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null,
      size_bytes: uploaded ? (options.size ?? 100) : null,
      sha256: uploaded ? Buffer.alloc(32) : null,
      uploaded_at: uploaded ? new Date() : null,
      created_by: member.userId,
      project_id: options.projectId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newArtifact(
  member: Pick<Member, 'orgId' | 'userId'>,
  options: { kind: 'markdown' | 'image'; sourceFileId?: string; projectId?: string; status?: 'ready' | 'writing' },
): Promise<string> {
  const ready = (options.status ?? 'ready') === 'ready';
  const row = await superuser
    .insertInto('artifacts')
    .values({
      org_id: member.orgId,
      project_id: options.projectId ?? null,
      source_file_id: options.sourceFileId ?? null,
      kind: options.kind,
      name: options.kind === 'markdown' ? 'content.md' : 'image-001.png',
      mime: options.kind === 'markdown' ? 'text/markdown; charset=utf-8' : 'image/png',
      status: ready ? 'ready' : 'writing',
      size_bytes: ready ? 10 : null,
      sha256: ready ? Buffer.alloc(32) : null,
      completed_at: ready ? new Date() : null,
      created_by: member.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const softDeleteFile = (fileId: string, userId: string) =>
  superuser.updateTable('files').set({ deleted_at: new Date(), deleted_by: userId }).where('id', '=', fileId).execute();
const restoreFile = (fileId: string) => superuser.updateTable('files').set({ deleted_at: null, deleted_by: null }).where('id', '=', fileId).execute();
const softDeleteProject = (projectId: string, userId: string) =>
  superuser.updateTable('projects').set({ deleted_at: new Date(), deleted_by: userId }).where('id', '=', projectId).execute();
const restoreProject = (projectId: string) =>
  superuser.updateTable('projects').set({ deleted_at: null, deleted_by: null }).where('id', '=', projectId).execute();

// ---- 隔离模板用的行（经应用角色在给定上下文中写入；组织或项目不对时在第一步就被拒绝） ----

/** 上传一个标书查重文件、挂到 scope 的项目并选入，返回文件 id。 */
async function selectedFileInContext(trx: Transaction<any>, scope: ProjectRowScope, role: 'tender' | 'bid' = 'bid', sortOrder = 0): Promise<string> {
  const file = await trx
    .insertInto('files')
    .values({ org_id: scope.orgId, project_id: scope.projectId, purpose: 'duplicate-check', display_name: 'a.docx', extension: 'docx', created_by: scope.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.updateTable('files').set({ status: 'uploaded', mime: 'application/zip', size_bytes: 10, sha256: Buffer.alloc(32) }).where('id', '=', file.id).execute();
  await trx
    .insertInto('duplicate_check_files')
    .values({ file_id: file.id, org_id: scope.orgId, project_id: scope.projectId, role, sort_order: sortOrder })
    .execute();
  return file.id;
}

const base = (scope: ProjectRowScope) => ({ org_id: scope.orgId, project_id: scope.projectId });

async function insertReturningId(trx: Transaction<any>, table: string, values: Record<string, unknown>): Promise<string> {
  return (await trx.insertInto(table).values(values).returning('id').executeTakeFirstOrThrow()).id;
}

const ROW_WRITERS: Record<(typeof DUPLICATE_CHECK_TABLES)[number], (trx: Transaction<any>, scope: ProjectRowScope) => Promise<string>> = {
  async duplicate_check_meta(trx, scope) {
    await trx.insertInto('duplicate_check_meta').values(base(scope)).execute();
    return scope.projectId;
  },
  duplicate_check_files: (trx, scope) => selectedFileInContext(trx, scope),
  async duplicate_check_analysis_sections(trx, scope) {
    await trx.insertInto('duplicate_check_analysis_sections').values({ ...base(scope), section: 'metadata', status: 'pending', progress: 0, message: '', stats: '{}' }).execute();
    return scope.projectId;
  },
  async duplicate_check_content_files(trx, scope) {
    const fileId = await selectedFileInContext(trx, scope);
    await trx.insertInto('duplicate_check_content_files').values({ ...base(scope), file_id: fileId, status: 'success' }).execute();
    return fileId;
  },
  async duplicate_check_metadata_items(trx, scope) {
    const fileId = await selectedFileInContext(trx, scope);
    return insertReturningId(trx, 'duplicate_check_metadata_items', { ...base(scope), file_id: fileId, key: 'author', label: '作者', value: '张三' });
  },
  async duplicate_check_outline_items(trx, scope) {
    const fileId = await selectedFileInContext(trx, scope);
    return insertReturningId(trx, 'duplicate_check_outline_items', {
      ...base(scope),
      file_id: fileId,
      item_id: 'o1',
      title: '第一章',
      normalized_title: '第一章',
      normalized_path: '第一章',
      source: 'catalog',
    });
  },
  duplicate_check_outline_groups: (trx, scope) =>
    insertReturningId(trx, 'duplicate_check_outline_groups', { ...base(scope), group_id: 'g1', type: 'duplicate', title: '第一章' }),
  async duplicate_check_outline_pairwise(trx, scope) {
    const fileA = await selectedFileInContext(trx, scope, 'bid', 0);
    const fileB = await selectedFileInContext(trx, scope, 'bid', 1);
    return insertReturningId(trx, 'duplicate_check_outline_pairwise', { ...base(scope), file_a_id: fileA, file_b_id: fileB, score: 0.5 });
  },
  duplicate_check_content_duplicates: (trx, scope) =>
    insertReturningId(trx, 'duplicate_check_content_duplicates', { ...base(scope), duplicate_id: 'C000001', sentence: '句子', normalized: '句子' }),
  async duplicate_check_content_occurrences(trx, scope) {
    const fileId = await selectedFileInContext(trx, scope);
    await trx.insertInto('duplicate_check_content_duplicates').values({ ...base(scope), duplicate_id: 'C000001', sentence: '句子', normalized: '句子' }).execute();
    return insertReturningId(trx, 'duplicate_check_content_occurrences', { ...base(scope), duplicate_id: 'C000001', file_id: fileId, occurrence_count: 2 });
  },
  async duplicate_check_image_files(trx, scope) {
    const fileId = await selectedFileInContext(trx, scope);
    await trx.insertInto('duplicate_check_image_files').values({ ...base(scope), file_id: fileId, status: 'success' }).execute();
    return fileId;
  },
  duplicate_check_duplicate_images: (trx, scope) =>
    insertReturningId(trx, 'duplicate_check_duplicate_images', { ...base(scope), image_id: 'I000001', hash: 'abc' }),
  async duplicate_check_image_occurrences(trx, scope) {
    const fileId = await selectedFileInContext(trx, scope);
    await trx.insertInto('duplicate_check_duplicate_images').values({ ...base(scope), image_id: 'I000001', hash: 'abc' }).execute();
    return insertReturningId(trx, 'duplicate_check_image_occurrences', { ...base(scope), image_id: 'I000001', file_id: fileId, occurrence_count: 1 });
  },
};

/** 引用选中文件的表：项目物理删除被文件（files.project_id，不级联）挡住，要先由清理任务删除文件。 */
const FILE_LINKED = new Set<string>([
  'duplicate_check_files',
  'duplicate_check_content_files',
  'duplicate_check_metadata_items',
  'duplicate_check_outline_items',
  'duplicate_check_outline_pairwise',
  'duplicate_check_content_occurrences',
  'duplicate_check_image_files',
  'duplicate_check_image_occurrences',
]);

/** 引用选中文件、文件进回收站时随之不可见的结果表（文件行本身另算）。 */
const FILE_RESULT_TABLES = [...FILE_LINKED].filter((table) => table !== 'duplicate_check_files');

// ---- 接口 ----

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function call(member: Member | null, method: Method, url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

const dc = (projectId: string, path = '') => `/api/projects/${projectId}/duplicate-check${path}`;

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

/** 每张表中某个项目的行数（超级用户，绕过 RLS）。 */
async function adminCounts(projectId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of DUPLICATE_CHECK_TABLES) {
    const row = await superuser.selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).where('project_id', '=', projectId).executeTakeFirstOrThrow();
    counts[table] = Number((row as { n: string }).n);
  }
  return counts;
}

/** 每张表在应用角色下（成员上下文中、不带条件的全表查询）看到的行数。 */
async function visibleCounts(member: Member): Promise<Record<string, number>> {
  return withTenant(appDb, member.context, async (trx) => {
    const counts: Record<string, number> = {};
    for (const table of DUPLICATE_CHECK_TABLES) {
      const row = await (trx as unknown as Kysely<any>).selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
      counts[table] = Number((row as { n: string }).n);
    }
    return counts;
  });
}

const zeroCounts = () => Object.fromEntries(DUPLICATE_CHECK_TABLES.map((table) => [table, 0]));

interface Filled {
  projectId: string;
  tender: string;
  bidA: string;
  bidB: string;
  markdownA: string;
  preview: string;
}

/** 新建项目，选两份投标文件和一份招标文件，并经 Store 写满四类分析（签名与当前选择一致）。 */
async function fillProject(member: Member): Promise<Filled> {
  const projectId = await newProject(member);
  const tender = await newFile(member, { name: '招标文件.pdf' });
  const bidA = await newFile(member, { name: '投标A.docx' });
  const bidB = await newFile(member, { name: '投标B.docx' });
  const state = await saveFiles(appDb, member.context, projectId, { tenderFileIds: [tender], bidFileIds: [bidA, bidB], step: 'analysis' });
  const markdownA = await newArtifact(member, { kind: 'markdown', sourceFileId: bidA });
  const preview = await newArtifact(member, { kind: 'image', sourceFileId: bidA, projectId });
  const signature = state.signature;
  await saveAnalysisSection(appDb, member.context, projectId, 'metadata', {
    status: 'success',
    progress: 100,
    message: '元数据分析完成',
    signature,
    contentExtraction: { status: 'success', completed: 2, total: 2 },
    metadataExtraction: { status: 'success', completed: 2, total: 2 },
    logs: ['开始', '完成'],
    contentFiles: [
      { fileId: bidA, status: 'success', contentArtifactId: markdownA, contentLength: 1200, parserLabel: 'docx', contentHash: 'hash-a' },
      { fileId: bidB, status: 'error', error: '解析失败' },
    ],
    files: [
      {
        fileId: bidA,
        status: 'success',
        metadata: [
          { key: 'author', label: '作者', value: '张三', normalized: '张三', comparable: true },
          { key: 'created', label: '创建时间', value: '2026-01-01 10:00', normalized: '2026-01-01T10:00', dateDay: '2026-01-01', comparable: true, dateComparable: true },
        ],
      },
      {
        fileId: bidB,
        status: 'success',
        metadata: [
          { key: 'author', label: '作者', value: '张三 ', normalized: '张三', comparable: true },
          { key: 'created', label: '创建时间', value: '2026-01-01 18:00', normalized: '2026-01-01T18:00', dateDay: '2026-01-01', comparable: true, dateComparable: true },
        ],
      },
    ],
  });
  await saveAnalysisSection(appDb, member.context, projectId, 'outline', {
    status: 'success',
    progress: 100,
    signature,
    tenderSentenceCount: 30,
    tenderMatchedItemCount: 2,
    extraction: { status: 'success', completed: 2, total: 2 },
    files: [
      {
        fileId: bidA,
        status: 'success',
        source: 'catalog',
        confidence: 0.9,
        // 子项在父项之前：父目录项外键延迟到事务结束检查。
        items: [
          { id: 'a2', parentId: 'a1', level: 2, number: '1.1', title: '项目概况', normalizedTitle: '项目概况', pathTitles: ['总体方案', '项目概况'], normalizedPath: '总体方案/项目概况', order: 1 },
          { id: 'a1', level: 1, number: '1', title: '总体方案', normalizedTitle: '总体方案', pathTitles: ['总体方案'], normalizedPath: '总体方案', order: 0, fromTender: true, matchedTenderSentence: '总体方案' },
        ],
      },
      { fileId: bidB, status: 'success', source: 'heading', items: [{ id: 'b1', title: '项目概况', normalizedTitle: '项目概况', normalizedPath: '项目概况', order: 0 }] },
    ],
    duplicateGroups: [
      { id: 'g1', type: 'duplicate', title: '项目概况', score: 1, fileIds: [bidA, bidB], itemIds: { [bidA]: ['a2'], [bidB]: ['b1'] }, paths: { [bidA]: ['总体方案/项目概况'], [bidB]: ['项目概况'] } },
      { id: 'g2', type: 'similar', title: '总体', score: 0.8, fileIds: [bidA], itemIds: { [bidA]: ['a1'] }, paths: {} },
    ],
    pairwiseSimilarities: [{ fileAId: bidA, fileBId: bidB, score: 0.75, titleOverlap: 0.5, pathOverlap: 0.25, orderSimilarity: 1, sharedCount: 1, risk: 'high' }],
  });
  await saveAnalysisSection(appDb, member.context, projectId, 'content', {
    status: 'success',
    progress: 100,
    signature,
    tenderSentenceCount: 30,
    tenderMatchedSentenceCount: 4,
    totalSentenceCount: 120,
    extraction: { status: 'success', completed: 2, total: 2 },
    duplicateSentences: [
      { sentence: '本项目采用分布式架构。', normalized: '本项目采用分布式架构', fileIds: [bidA, bidB], occurrences: { [bidA]: 2, [bidB]: 1 }, firstOrder: 3 },
      { id: 'C9', sentence: '<b>=1+1</b>', normalized: '11', fileIds: [bidA, bidB], occurrences: { [bidA]: 1, [bidB]: 1 }, firstOrder: 1 },
    ],
  });
  await saveAnalysisSection(appDb, member.context, projectId, 'image', {
    status: 'success',
    progress: 100,
    signature,
    extraction: { status: 'success', completed: 2, total: 2 },
    totalImageCount: 9,
    files: [
      { fileId: bidA, status: 'success', imageCount: 5, uniqueImageCount: 4 },
      { fileId: bidB, status: 'success', imageCount: 4, uniqueImageCount: 4 },
    ],
    duplicateImages: [
      {
        hash: 'phash-1',
        previewArtifactId: preview,
        fileIds: [bidA, bidB],
        occurrences: { [bidA]: 1, [bidB]: 2 },
        locations: { [bidA]: [{ imageIndex: 3, directory: '总体方案', previousSentence: '如下图所示' }], [bidB]: [{ directory: '', previousSentence: '' }] },
      },
    ],
  });
  return { projectId, tender, bidA, bidB, markdownA, preview };
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
  database = createDatabase(testDb.appConfig);
  appDb = database.db;
  app = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    { database, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} } },
  );
});

afterAll(async () => {
  await app?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('隔离模板', () => {
  const env = { admin: () => superuser, app: () => appDb };
  const ids: Record<string, string> = {
    duplicate_check_meta: 'project_id',
    duplicate_check_files: 'file_id',
    duplicate_check_analysis_sections: 'project_id',
    duplicate_check_content_files: 'file_id',
    duplicate_check_image_files: 'file_id',
  };
  // 只有页面状态、文件的正文哈希和分析状态按字段更新；其余十张表整体替换，不授予 UPDATE。
  const updates: Record<string, Record<string, unknown>> = {
    duplicate_check_meta: { step: 'analysis' },
    duplicate_check_files: { content_hash: 'hash' },
    duplicate_check_analysis_sections: { progress: 5 },
  };

  for (const table of DUPLICATE_CHECK_TABLES) {
    describeProjectTable(
      {
        table,
        idColumn: ids[table] ?? 'id',
        projectKind: 'duplicate-check',
        insert: (trx, scope) => ROW_WRITERS[table](trx, scope),
        onProjectDelete: FILE_LINKED.has(table) ? 'restrict' : 'cascade',
        ...(updates[table] ? { update: updates[table] } : {}),
      },
      env,
    );
  }
});

describe('RLS：删除可见性与写权限', () => {
  let a: Member;
  let b: Member;

  beforeAll(async () => {
    a = await newMember();
    b = await newMember();
  });

  it('所属项目软删除后十三张表都查不到、改不了、删不掉，恢复项目即一起恢复', async () => {
    const filled = await fillProject(a);
    const before = await adminCounts(filled.projectId);
    expect(Object.values(before).every((n) => n > 0)).toBe(true);
    expect(await visibleCounts(a)).toEqual(before);

    await softDeleteProject(filled.projectId, a.userId);
    expect(await visibleCounts(a)).toEqual(zeroCounts());
    await withTenant(appDb, a.context, async (trx) => {
      const any = trx as unknown as Kysely<any>;
      expect((await any.updateTable('duplicate_check_meta').set({ step: 'upload' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.updateTable('duplicate_check_analysis_sections').set({ progress: 1 }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.deleteFrom('duplicate_check_files').executeTakeFirst()).numDeletedRows).toBe(0n);
      expect((await any.deleteFrom('duplicate_check_content_duplicates').executeTakeFirst()).numDeletedRows).toBe(0n);
    });
    // 已删除的项目下不能新写。
    await expect(
      withTenant(appDb, a.context, (trx) =>
        (trx as unknown as Kysely<any>).insertInto('duplicate_check_outline_groups').values({ org_id: a.orgId, project_id: filled.projectId, group_id: 'gx', type: 'duplicate', title: 'x' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await adminCounts(filled.projectId)).toEqual(before);

    await restoreProject(filled.projectId);
    expect(await visibleCounts(a)).toEqual(before);
  });

  it('选中的文件进回收站后，文件行和引用它的分析结果都不可见，其他结果不受影响；恢复文件即一起恢复', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    const before = (await visibleCounts(member)) as Record<(typeof DUPLICATE_CHECK_TABLES)[number], number>;
    await softDeleteFile(filled.bidB, member.userId);
    const after = await visibleCounts(member);
    // 投标 B 的文件行、正文提取、元数据项、目录项、出现次数、图片统计不可见；两两相似度引用了它，整行不可见。
    expect(after.duplicate_check_files).toBe(before.duplicate_check_files - 1);
    expect(after.duplicate_check_content_files).toBe(before.duplicate_check_content_files - 1);
    expect(after.duplicate_check_metadata_items).toBe(before.duplicate_check_metadata_items - 2);
    expect(after.duplicate_check_outline_items).toBe(before.duplicate_check_outline_items - 1);
    expect(after.duplicate_check_outline_pairwise).toBe(0);
    expect(after.duplicate_check_content_occurrences).toBe(before.duplicate_check_content_occurrences - 2);
    expect(after.duplicate_check_image_files).toBe(before.duplicate_check_image_files - 1);
    expect(after.duplicate_check_image_occurrences).toBe(before.duplicate_check_image_occurrences - 1);
    for (const table of [
      'duplicate_check_meta',
      'duplicate_check_analysis_sections',
      'duplicate_check_outline_groups',
      'duplicate_check_content_duplicates',
      'duplicate_check_duplicate_images',
    ] as const) {
      expect(after[table], table).toBe(before[table]);
    }
    const state = await loadDuplicateCheck(appDb, member.context, filled.projectId);
    expect(state.bidFiles.map((file) => file.id)).toEqual([filled.bidA]);
    expect(state.outlineAnalysis!.pairwiseSimilarities).toEqual([]);

    await restoreFile(filled.bidB);
    expect(await visibleCounts(member)).toEqual(before);
  });

  it('文件被清理任务物理删除时，文件行及其分析结果级联删除；项目随后可以物理删除', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    await superuser.deleteFrom('artifacts').where('org_id', '=', member.orgId).execute();
    await superuser.deleteFrom('files').where('project_id', '=', filled.projectId).execute();
    const counts = await adminCounts(filled.projectId);
    for (const table of FILE_LINKED) expect(counts[table], table).toBe(0);
    expect(counts.duplicate_check_outline_groups).toBe(2);
    await superuser.deleteFrom('projects').where('id', '=', filled.projectId).execute();
    expect(await adminCounts(filled.projectId)).toEqual(zeroCounts());
  });

  it('只能挂在查重项目下：其他 kind 的项目下写不进任何一张表', async () => {
    const projectId = await newProject(a, 'technical-plan');
    const scope = { orgId: a.orgId, userId: a.userId, projectId };
    for (const table of DUPLICATE_CHECK_TABLES) {
      await expect(
        withTenant(appDb, a.context, (trx) => ROW_WRITERS[table](trx as unknown as Transaction<any>, scope)),
        table,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it('只能选本组织已上传、未删除、用途是标书查重、已挂到本项目的文件', async () => {
    const projectId = await newProject(a);
    const other = await newProject(a);
    const insert = (fileId: string) =>
      withTenant(appDb, a.context, (trx) =>
        trx.insertInto('duplicate_check_files').values({ file_id: fileId, org_id: a.orgId, project_id: projectId, role: 'bid', sort_order: 0 }).execute(),
      );
    const deleted = await newFile(a, { projectId });
    await softDeleteFile(deleted, a.userId);
    const rejected = [
      await newFile(a), // 不属于任何项目
      await newFile(a, { projectId: other }), // 属于其他项目
      await newFile(a, { projectId, purpose: 'knowledge' }), // 其他用途
      await newFile(a, { projectId, status: 'uploading' }), // 未上传完成
      deleted,
    ];
    for (const fileId of rejected) await expect(insert(fileId)).rejects.toThrow(/row-level security/);
    // 其他组织的文件：外键挡住（应用角色看不到它，INSERT 策略也不成立）。
    await expect(insert(await newFile(b, { projectId: await newProject(b) }))).rejects.toThrow(/row-level security|foreign key/);
    const fine = await newFile(a, { projectId });
    await insert(fine);
    // 同一文件不能选两次（不能既是招标文件又是投标文件）。
    await expect(insert(fine)).rejects.toThrow(/duplicate key/);
  });

  it('正文产物只能是该文件的 Markdown，预览图只能是本项目的图片产物', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const fileA = await newFile(member);
    const fileB = await newFile(member);
    await saveFiles(appDb, member.context, projectId, { tenderFileIds: [], bidFileIds: [fileA, fileB] });
    const insertContent = (artifactId: string) =>
      withTenant(appDb, member.context, (trx) =>
        trx.insertInto('duplicate_check_content_files').values({ file_id: fileA, org_id: member.orgId, project_id: projectId, status: 'success', content_artifact_id: artifactId, content_length: 0 }).execute(),
      );
    for (const artifactId of [
      await newArtifact(member, { kind: 'markdown', sourceFileId: fileB }), // 其他文件的
      await newArtifact(member, { kind: 'image', sourceFileId: fileA }), // 不是 Markdown
      await newArtifact(member, { kind: 'markdown', sourceFileId: fileA, status: 'writing' }), // 未写完
    ]) {
      await expect(insertContent(artifactId)).rejects.toThrow(/row-level security/);
    }
    await insertContent(await newArtifact(member, { kind: 'markdown', sourceFileId: fileA }));

    const insertImage = (artifactId: string) =>
      withTenant(appDb, member.context, (trx) =>
        trx.insertInto('duplicate_check_duplicate_images').values({ org_id: member.orgId, project_id: projectId, image_id: randomUUID(), hash: 'h', preview_artifact_id: artifactId, sort_order: 0 }).execute(),
      );
    for (const artifactId of [
      await newArtifact(member, { kind: 'image', projectId: await newProject(member) }), // 其他项目的
      await newArtifact(member, { kind: 'markdown', projectId }), // 不是图片
      await newArtifact(member, { kind: 'image', projectId, status: 'writing' }),
    ]) {
      await expect(insertImage(artifactId)).rejects.toThrow(/row-level security/);
    }
    await insertImage(await newArtifact(member, { kind: 'image', projectId, sourceFileId: fileA }));
  });

  it('页面状态没有 DELETE 授权，分析结果表没有 UPDATE 授权；org_id、project_id、file_id 写入后不能改', async () => {
    const privileges = await sql<{ table: string; del: boolean; upd: boolean }>`
      SELECT t AS table, has_table_privilege(${APP_ROLE}, t, 'DELETE') AS del, has_any_column_privilege(${APP_ROLE}, t, 'UPDATE') AS upd
      FROM unnest(${sql.val([...DUPLICATE_CHECK_TABLES])}::text[]) AS t ORDER BY t`.execute(superuser);
    const byTable = Object.fromEntries(privileges.rows.map((row) => [row.table, row]));
    expect(byTable.duplicate_check_meta).toMatchObject({ del: false, upd: true });
    expect(byTable.duplicate_check_files).toMatchObject({ del: true, upd: true });
    expect(byTable.duplicate_check_analysis_sections).toMatchObject({ del: true, upd: true });
    for (const table of DUPLICATE_CHECK_TABLES.filter((name) => !['duplicate_check_meta', 'duplicate_check_files', 'duplicate_check_analysis_sections'].includes(name))) {
      expect(byTable[table], table).toMatchObject({ del: true, upd: false });
    }
    for (const [table, column] of [
      ['duplicate_check_meta', 'project_id'],
      ['duplicate_check_files', 'file_id'],
      ['duplicate_check_files', 'role'],
      ['duplicate_check_analysis_sections', 'section'],
      ['duplicate_check_analysis_sections', 'org_id'],
    ] as const) {
      const result = await sql<{ ok: boolean }>`SELECT has_column_privilege(${APP_ROLE}, ${table}, ${column}, 'UPDATE') AS ok`.execute(superuser);
      expect(result.rows[0]!.ok, `${table}.${column}`).toBe(false);
    }
  });

  it('父目录项外键延迟到事务结束检查：不存在的父目录项在提交时被拒绝', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const fileId = await newFile(member);
    await saveFiles(appDb, member.context, projectId, { tenderFileIds: [], bidFileIds: [fileId] });
    await expect(
      withTenant(appDb, member.context, (trx) =>
        trx
          .insertInto('duplicate_check_outline_items')
          .values({
            org_id: member.orgId,
            project_id: projectId,
            file_id: fileId,
            item_id: 'child',
            parent_item_id: 'missing',
            level: 2,
            number: null,
            title: 't',
            normalized_title: 't',
            path_titles: '[]',
            normalized_path: 't',
            source: 'heading',
            confidence: 0,
            sort_order: 0,
            from_tender: false,
            matched_tender_sentence: null,
          })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('数值列挡住 NaN、Infinity 和越界值', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    for (const value of ['NaN', 'Infinity', '-1', '1001']) {
      await expect(
        withTenant(appDb, member.context, (trx) =>
          trx
            .insertInto('duplicate_check_outline_groups')
            .values({ org_id: member.orgId, project_id: projectId, group_id: randomUUID(), type: 'duplicate', title: 't', score: sql<number>`${value}::double precision`, file_ids: '[]', item_ids: '{}', paths: '{}', sort_order: 0 })
            .execute(),
        ),
        value,
      ).rejects.toThrow(/check constraint/);
    }
  });
});

describe('Store', () => {
  let a: Member;
  let peer: Member;
  let b: Member;

  beforeAll(async () => {
    a = await newMember();
    peer = await newMember(a.orgId);
    b = await newMember();
  });

  it('没写过时返回默认状态，不预先插入行', async () => {
    const projectId = await newProject(a);
    const state = await loadDuplicateCheck(appDb, a.context, projectId);
    expect(state).toEqual({
      tenderFiles: [],
      bidFiles: [],
      step: 'upload',
      activeAnalysisTab: 'metadata',
      signature: createHash('sha1').update('').digest('hex'),
      analysisTask: null,
      metadataAnalysis: null,
      outlineAnalysis: null,
      contentAnalysis: null,
      imageAnalysis: null,
    });
    expect(await adminCounts(projectId)).toEqual(zeroCounts());
  });

  it('选择文件：挂到项目、按给出的顺序保存，签名由文件 id、大小和上传完成时间算出', async () => {
    const projectId = await newProject(a);
    const tender = await newFile(a, { name: '招标.pdf', size: 7 });
    const bid1 = await newFile(a, { name: '投标1.docx' });
    const bid2 = await newFile(a, { name: '投标2.docx' });
    const state = await saveFiles(appDb, a.context, projectId, { tenderFileIds: [tender], bidFileIds: [bid2, bid1], step: 'analysis', activeAnalysisTab: 'outline' });
    expect(state.tenderFiles).toMatchObject([{ id: tender, fileName: '招标.pdf', extension: 'docx', size: 7 }]);
    expect(state.bidFiles.map((file) => file.fileName)).toEqual(['投标2.docx', '投标1.docx']);
    expect(state).toMatchObject({ step: 'analysis', activeAnalysisTab: 'outline' });
    const files = await superuser.selectFrom('files').select(['id', 'uploaded_at', 'project_id']).where('id', 'in', [tender, bid1, bid2]).execute();
    expect(files.every((file: { project_id: string }) => file.project_id === projectId)).toBe(true);
    const uploaded = new Map(files.map((file: { id: string; uploaded_at: Date }) => [file.id, file.uploaded_at.toISOString()]));
    const expected = createHash('sha1')
      .update([`${tender}|7|${uploaded.get(tender)}`, `${bid2}|100|${uploaded.get(bid2)}`, `${bid1}|100|${uploaded.get(bid1)}`].join('\n'))
      .digest('hex');
    expect(state.signature).toBe(expected);
    expect(selectionSignature(state)).toBe(expected);
    // 组织内其他成员看到同样的状态（组织内共享）。
    expect(await loadDuplicateCheck(appDb, peer.context, projectId)).toEqual(state);
  });

  it('重新选择文件：清空全部分析结果，去掉的文件进回收站，步骤与页签不给出时回到默认值', async () => {
    const filled = await fillProject(a);
    const state = await saveFiles(appDb, a.context, filled.projectId, { tenderFileIds: [], bidFileIds: [filled.bidB, filled.bidA] });
    expect(state).toMatchObject({ step: 'upload', activeAnalysisTab: 'metadata', metadataAnalysis: null, outlineAnalysis: null, contentAnalysis: null, imageAnalysis: null });
    expect(state.bidFiles.map((file) => file.id)).toEqual([filled.bidB, filled.bidA]);
    const counts = await adminCounts(filled.projectId);
    expect(counts).toEqual({ ...zeroCounts(), duplicate_check_meta: 1, duplicate_check_files: 2 });
    const tender = await superuser.selectFrom('files').select(['deleted_at', 'deleted_by']).where('id', '=', filled.tender).executeTakeFirstOrThrow();
    expect(tender.deleted_at).toBeInstanceOf(Date);
    expect(tender.deleted_by).toBe(a.userId);
  });

  it('文件不可用时整体失败，不改动原有选择', async () => {
    const projectId = await newProject(a);
    const kept = await newFile(a);
    await saveFiles(appDb, a.context, projectId, { tenderFileIds: [], bidFileIds: [kept] });
    const deleted = await newFile(a);
    await softDeleteFile(deleted, a.userId);
    const unavailable = [
      await newFile(a, { purpose: 'knowledge' }),
      await newFile(a, { projectId: await newProject(a) }),
      await newFile(a, { status: 'uploading' }),
      deleted,
      await newFile(b),
      randomUUID(),
    ];
    for (const fileId of unavailable) {
      await expect(saveFiles(appDb, a.context, projectId, { tenderFileIds: [], bidFileIds: [kept, fileId] })).rejects.toMatchObject({
        statusCode: 400,
        code: 'DUPLICATE_CHECK_FILE_UNAVAILABLE',
      });
    }
    await expect(saveFiles(appDb, a.context, projectId, { tenderFileIds: [kept], bidFileIds: [kept] })).rejects.toMatchObject({
      code: 'DUPLICATE_CHECK_FILE_UNAVAILABLE',
    });
    expect((await loadDuplicateCheck(appDb, a.context, projectId)).bidFiles.map((file) => file.id)).toEqual([kept]);
    // 已属于其他项目的文件没有被改挂。
    const other = unavailable[1]!;
    expect((await superuser.selectFrom('files').select('project_id').where('id', '=', other).executeTakeFirstOrThrow()).project_id).not.toBe(projectId);
  });

  it('保存页面状态只写给出的字段', async () => {
    const projectId = await newProject(a);
    expect(await saveUiState(appDb, a.context, projectId, { activeAnalysisTab: 'image' })).toEqual({ step: 'upload', activeAnalysisTab: 'image' });
    expect(await saveUiState(appDb, a.context, projectId, { step: 'analysis' })).toEqual({ step: 'analysis', activeAnalysisTab: 'image' });
    expect(await saveUiState(appDb, a.context, projectId, {})).toEqual({ step: 'analysis', activeAnalysisTab: 'image' });
  });

  it('四类分析的读写与桌面版相同：结果、统计、元数据对比表、目录组反推', async () => {
    const filled = await fillProject(a);
    const state = await loadDuplicateCheck(appDb, a.context, filled.projectId);
    const metadata = state.metadataAnalysis!;
    expect(metadata).toMatchObject({
      status: 'success',
      progress: 100,
      message: '元数据分析完成',
      signature: state.signature,
      contentExtraction: { status: 'success', completed: 2, total: 2 },
      logs: ['开始', '完成'],
    });
    expect(metadata.contentFiles).toEqual(
      expect.arrayContaining([
        { fileId: filled.bidA, fileName: '投标A.docx', status: 'success', contentArtifactId: filled.markdownA, contentLength: 1200, parserLabel: 'docx', error: null },
        { fileId: filled.bidB, fileName: '投标B.docx', status: 'error', contentArtifactId: null, contentLength: 0, parserLabel: null, error: '解析失败' },
      ]),
    );
    expect(metadata.rows).toEqual([
      { key: 'author', label: '作者', values: { [filled.bidA]: '张三', [filled.bidB]: '张三 ' }, duplicateFileIds: [filled.bidA, filled.bidB], sameDayFileIds: [] },
      {
        key: 'created',
        label: '创建时间',
        values: { [filled.bidA]: '2026-01-01 10:00', [filled.bidB]: '2026-01-01 18:00' },
        duplicateFileIds: [],
        sameDayFileIds: [filled.bidA, filled.bidB],
      },
    ]);
    const hash = await superuser.selectFrom('duplicate_check_files').select('content_hash').where('file_id', '=', filled.bidA).executeTakeFirstOrThrow();
    expect(hash.content_hash).toBe('hash-a');

    const outline = state.outlineAnalysis!;
    expect(outline).toMatchObject({ tenderSentenceCount: 30, tenderMatchedItemCount: 2 });
    const fileA = outline.files.find((file) => file.fileId === filled.bidA)!;
    expect(fileA).toMatchObject({ status: 'success', source: 'catalog', confidence: 0.9, itemCount: 2, tenderMatchedCount: 1 });
    expect(fileA.items.map((item) => [item.id, item.parentId, item.duplicateGroupIds, item.similarGroupIds])).toEqual([
      ['a1', null, [], ['g2']],
      ['a2', 'a1', ['g1'], []],
    ]);
    expect(fileA.items[0]).toMatchObject({ pathTitles: ['总体方案'], fromTender: true, matchedTenderSentence: '总体方案', level: 1, number: '1' });
    expect(outline.duplicateGroups.map((group) => group.id)).toEqual(['g1', 'g2']);
    expect(outline.pairwiseSimilarities).toEqual([
      { fileAId: filled.bidA, fileBId: filled.bidB, score: 0.75, titleOverlap: 0.5, pathOverlap: 0.25, orderSimilarity: 1, sharedCount: 1, risk: 'high' },
    ]);

    const content = state.contentAnalysis!;
    expect(content).toMatchObject({ tenderMatchedSentenceCount: 4, totalSentenceCount: 120 });
    expect(content.duplicateSentences.map((item) => [item.id, item.firstOrder, item.occurrences])).toEqual([
      ['C9', 1, { [filled.bidA]: 1, [filled.bidB]: 1 }],
      ['C000001', 3, { [filled.bidA]: 2, [filled.bidB]: 1 }],
    ]);

    const image = state.imageAnalysis!;
    expect(image).toMatchObject({ totalImageCount: 9 });
    expect(image.duplicateImages).toEqual([
      {
        id: 'I000001',
        hash: 'phash-1',
        previewArtifactId: filled.preview,
        fileIds: [filled.bidA, filled.bidB],
        occurrences: { [filled.bidA]: 1, [filled.bidB]: 2 },
        locations: {
          [filled.bidA]: [{ imageIndex: 3, directory: '总体方案', previousSentence: '如下图所示' }],
          [filled.bidB]: [{ imageIndex: null, directory: '', previousSentence: '' }],
        },
      },
    ]);
  });

  it('部分写入只改给出的字段，统计按字段合并，结果字段给出时整体替换；null 删除这一类', async () => {
    const filled = await fillProject(a);
    // running 而没有进行中的任务时按未完成显示（6.10），这里写 success 只看字段合并。
    await saveAnalysisSection(appDb, a.context, filled.projectId, 'content', { status: 'success', progress: 150.4, totalSentenceCount: 7 });
    let content = (await loadDuplicateCheck(appDb, a.context, filled.projectId)).contentAnalysis!;
    expect(content).toMatchObject({ status: 'success', progress: 100, totalSentenceCount: 7, tenderMatchedSentenceCount: 4 });
    expect(content.duplicateSentences).toHaveLength(2);
    await saveAnalysisSection(appDb, a.context, filled.projectId, 'content', { duplicateSentences: [], signature: null, message: 'x\u0000y'.repeat(2000) });
    content = (await loadDuplicateCheck(appDb, a.context, filled.projectId)).contentAnalysis!;
    expect(content.duplicateSentences).toEqual([]);
    expect(content.signature).toBeNull();
    expect([...content.message].length).toBe(2000);
    expect(content.message).not.toContain('\u0000');
    expect((await adminCounts(filled.projectId)).duplicate_check_content_occurrences).toBe(0);

    await saveAnalysisSection(appDb, a.context, filled.projectId, 'image', null);
    const state = await loadDuplicateCheck(appDb, a.context, filled.projectId);
    expect(state.imageAnalysis).toBeNull();
    const counts = await adminCounts(filled.projectId);
    expect([counts.duplicate_check_image_files, counts.duplicate_check_duplicate_images, counts.duplicate_check_image_occurrences]).toEqual([0, 0, 0]);
    expect(state.outlineAnalysis).not.toBeNull();
  });

  it('目录项多于一批插入时，子项可以排在后一批的父项之前', async () => {
    const projectId = await newProject(a);
    const fileId = await newFile(a);
    await saveFiles(appDb, a.context, projectId, { tenderFileIds: [], bidFileIds: [fileId] });
    const items = Array.from({ length: 600 }, (_value, index) => ({ id: `o${index}`, title: `第${index}节`, order: index, level: 2, parentId: 'o599' as string | null }));
    items[599] = { ...items[599]!, level: 1, parentId: null };
    await saveAnalysisSection(appDb, a.context, projectId, 'outline', { signature: 's', files: [{ fileId, items }] });
    const outline = (await loadDuplicateCheck(appDb, a.context, projectId)).outlineAnalysis!;
    expect(outline.files[0]!.items).toHaveLength(600);
    expect(outline.files[0]!.items[0]).toMatchObject({ id: 'o0', parentId: 'o599' });
  });

  it('任务写入的程序错误抛 TypeError；引用未选中的文件被 RLS 拒绝', async () => {
    const filled = await fillProject(a);
    const write = (section: 'outline' | 'content' | 'image', analysis: object) =>
      saveAnalysisSection(appDb, a.context, filled.projectId, section, analysis as never);
    await expect(write('outline', { files: [{ fileId: filled.bidA, items: [{ id: 'x', parentId: 'missing' }] }] })).rejects.toThrow(TypeError);
    await expect(write('outline', { files: [{ fileId: filled.bidA, items: [{ id: 'x' }, { id: 'x' }] }] })).rejects.toThrow(TypeError);
    await expect(write('outline', { files: [{ fileId: filled.bidA, items: [{ id: 'x'.repeat(201) }] }] })).rejects.toThrow(TypeError);
    await expect(write('content', { duplicateSentences: [{ id: 'C1' }, { id: 'C1' }] })).rejects.toThrow(TypeError);
    await expect(write('content', { duplicateSentences: [{ occurrences: { 'not-a-uuid': 1 } }] })).rejects.toThrow(TypeError);
    await expect(write('image', { duplicateImages: [{ hash: '' }] })).rejects.toThrow(TypeError);
    await expect(write('outline', { pairwiseSimilarities: [{ fileAId: filled.bidA, fileBId: randomUUID() }] })).rejects.toThrow(/row-level security/);
    await expect(write('content', { duplicateSentences: [{ occurrences: { [filled.tender]: 1, [randomUUID()]: 1 } }] })).rejects.toThrow(/row-level security/);
    // 失败的写入整体回滚。
    expect((await loadDuplicateCheck(appDb, a.context, filled.projectId)).contentAnalysis!.duplicateSentences).toHaveLength(2);
  });

  it('清空：删除文件选择和全部分析结果，选中的文件进回收站，页面回到上传步骤', async () => {
    const filled = await fillProject(a);
    expect(await clearDuplicateCheck(appDb, a.context, filled.projectId)).toEqual({ deletedFileCount: 3 });
    expect(await adminCounts(filled.projectId)).toEqual({ ...zeroCounts(), duplicate_check_meta: 1 });
    const state = await loadDuplicateCheck(appDb, a.context, filled.projectId);
    expect(state).toMatchObject({ tenderFiles: [], bidFiles: [], step: 'upload', activeAnalysisTab: 'metadata', metadataAnalysis: null });
    const files = await superuser.selectFrom('files').select('deleted_at').where('project_id', '=', filled.projectId).execute();
    expect(files.length).toBe(3);
    expect(files.every((file: { deleted_at: Date | null }) => file.deleted_at instanceof Date)).toBe(true);
  });

  it('其他组织看不到、写不进本组织的项目', async () => {
    const filled = await fillProject(a);
    const state = await loadDuplicateCheck(appDb, b.context, filled.projectId);
    expect(state).toMatchObject({ tenderFiles: [], bidFiles: [], metadataAnalysis: null });
    // 页面状态行已存在：撞到唯一键后的 UPDATE 被 RLS 拒绝（行不存在时由复合外键拒绝）。
    await expect(saveUiState(appDb, b.context, filled.projectId, { step: 'analysis' })).rejects.toThrow(/row-level security|foreign key/);
    await expect(saveUiState(appDb, b.context, await newProject(a), { step: 'analysis' })).rejects.toThrow(/foreign key/);
    expect(await clearDuplicateCheck(appDb, b.context, filled.projectId)).toEqual({ deletedFileCount: 0 });
    expect((await adminCounts(filled.projectId)).duplicate_check_files).toBe(3);
  });
});

describe('接口', () => {
  let a: Member;
  let b: Member;

  beforeAll(async () => {
    a = await newMember();
    b = await newMember();
  });

  it('需要登录', async () => {
    const projectId = await newProject(a);
    await expectError(await call(null, 'GET', dc(projectId)), 401, 'UNAUTHORIZED');
  });

  it('项目不存在、属于其他组织、已删除、kind 不符一律 404', async () => {
    const own = await newProject(a);
    const deleted = await newProject(a);
    await softDeleteProject(deleted, a.userId);
    const wrongKind = await newProject(a, 'rejection-check');
    for (const [member, projectId] of [
      [a, randomUUID()],
      [b, own],
      [a, deleted],
      [a, wrongKind],
    ] as const) {
      await expectError(await call(member, 'GET', dc(projectId)), 404, 'PROJECT_NOT_FOUND');
      await expectError(await call(member, 'PATCH', dc(projectId, '/ui-state'), { step: 'analysis' }), 404, 'PROJECT_NOT_FOUND');
      await expectError(await call(member, 'DELETE', dc(projectId)), 404, 'PROJECT_NOT_FOUND');
      await expectError(await call(member, 'GET', dc(projectId, '/export')), 404, 'PROJECT_NOT_FOUND');
    }
    await expectError(await call(a, 'GET', dc('not-a-uuid')), 400, 'BAD_REQUEST');
  });

  it('读取、选择文件、保存页面状态、清空', async () => {
    const projectId = await newProject(a);
    const tender = await newFile(a, { name: '招标.pdf' });
    const bid = await newFile(a, { name: '投标.docx' });
    const initial = await call(a, 'GET', dc(projectId));
    expect(initial.statusCode).toBe(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(initial.json()).toMatchObject({ tenderFiles: [], bidFiles: [], step: 'upload', analysisTask: null });

    const saved = await call(a, 'PUT', dc(projectId, '/files'), { tenderFileIds: [tender.toUpperCase()], bidFileIds: [bid], step: 'analysis' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ tenderFiles: [{ id: tender, fileName: '招标.pdf' }], bidFiles: [{ id: bid }], step: 'analysis' });
    expect(typeof saved.json().bidFiles[0].uploadedAt).toBe('string');

    const ui = await call(a, 'PATCH', dc(projectId, '/ui-state'), { activeAnalysisTab: 'content' });
    expect(ui.json()).toEqual({ step: 'analysis', activeAnalysisTab: 'content' });

    const cleared = await call(a, 'DELETE', dc(projectId));
    expect(cleared.json()).toEqual({ deletedFileCount: 2 });
    expect((await call(a, 'GET', dc(projectId))).json()).toMatchObject({ bidFiles: [], step: 'upload', activeAnalysisTab: 'metadata' });
  });

  it('请求体校验：未声明字段、空的页面状态、非法取值、超过数量上限', async () => {
    const projectId = await newProject(a);
    const fileId = await newFile(a);
    for (const [method, path, body] of [
      ['PUT', '/files', { tenderFileIds: [], bidFileIds: [], extra: 1 }],
      ['PUT', '/files', { bidFileIds: [] }],
      ['PUT', '/files', { tenderFileIds: [], bidFileIds: ['x'] }],
      ['PUT', '/files', { tenderFileIds: [], bidFileIds: Array.from({ length: 51 }, () => randomUUID()) }],
      ['PUT', '/files', { tenderFileIds: Array.from({ length: 21 }, () => randomUUID()), bidFileIds: [] }],
      ['PUT', '/files', { tenderFileIds: [], bidFileIds: [fileId], step: 'done' }],
      ['PATCH', '/ui-state', {}],
      ['PATCH', '/ui-state', { activeAnalysisTab: 'other' }],
      ['PATCH', '/ui-state', { step: 'analysis', signature: 'x' }],
    ] as const) {
      await expectError(await call(a, method, dc(projectId, path), body), 400, 'BAD_REQUEST');
    }
    await expectError(await call(a, 'PUT', dc(projectId, '/files'), { tenderFileIds: [], bidFileIds: [fileId, fileId] }), 400, 'DUPLICATE_CHECK_FILE_UNAVAILABLE');
    await expectError(await call(a, 'PUT', dc(projectId, '/files'), { tenderFileIds: [], bidFileIds: [await newFile(b)] }), 400, 'DUPLICATE_CHECK_FILE_UNAVAILABLE');
  });

  it('导出：没有当前结果时 409；有结果时生成与桌面版结构相同的工作簿，失效的结果不导出', async () => {
    const empty = await newProject(a);
    await expectError(await call(a, 'GET', dc(empty, '/export')), 409, 'DUPLICATE_CHECK_NOTHING_TO_EXPORT');

    const filled = await fillProject(a);
    // 图片分析的签名与当前选择不一致：标为“结果已失效”，不导出其内容。
    await saveAnalysisSection(appDb, a.context, filled.projectId, 'image', { signature: 'stale' });
    const response = await app.inject({
      method: 'GET',
      url: dc(filled.projectId, '/export'),
      headers: { ...sameSiteHeaders, cookie: `__Host-session=${a.cookie}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(String(response.headers['content-disposition'])).toMatch(/^attachment; filename="[^"]+\.xlsx"; filename\*=UTF-8''/);
    const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(String(response.headers['content-disposition']))![1]!);
    expect(fileName).toMatch(/^标书查重结果_\d{8}_\d{6}\.xlsx$/);

    const { sheets } = readWorkbook(response.rawPayload);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['查重概览', '元数据', '目录重复', '文件相似度', '重复句子', '重复图片']);
    const [overview, metadata, outline, pairwise, content, image] = sheets as [any, any, any, any, any, any];
    expect(overview.rows[2]).toEqual(['分析维度', '状态', '结果数量', '更新时间', '招标文件', '投标文件', '说明']);
    expect(overview.rows[3].slice(0, 3)).toEqual(['元数据', '已完成', 2]);
    expect(overview.rows[3][4]).toBe('招标文件.pdf');
    expect(overview.rows[3][5]).toBe('投标A.docx；投标B.docx');
    expect(overview.rows[6].slice(0, 3)).toEqual(['图片', '结果已失效', 0]);
    expect(overview.rows[6][6]).toBe('结果签名与当前检查输入不一致');
    expect(overview.rows.slice(9)).toEqual([
      ['识别图片总数', 0],
      ['招标目录排除数量', 2],
      ['招标引用句子排除数量', 4],
      ['正文句子总量', 120],
    ]);
    expect(metadata.rows[0]).toEqual(['元数据项', '重复文件', '同日文件', '投标文件1：投标A.docx', '投标文件2：投标B.docx']);
    expect(metadata.rows[1]).toEqual(['作者', '投标A.docx；投标B.docx', undefined, '张三', '张三 ']);
    expect(metadata.autoFilter).toBe('A1:E3');
    expect(outline.rows[1]).toEqual([1, '重复', '项目概况', 1, '投标A.docx；投标B.docx', '投标A.docx：总体方案/项目概况；投标B.docx：项目概况']);
    expect(outline.cells.get('D2').style).toBe(1);
    expect(pairwise.rows[1]).toEqual(['投标A.docx', '投标B.docx', 0.75, 0.5, 0.25, 1, 1, '高']);
    expect(['C2', 'D2', 'E2', 'F2'].map((ref) => pairwise.cells.get(ref).style)).toEqual([1, 1, 1, 1]);
    expect(content.rows[1]).toEqual([1, '<b>=1+1</b>', '投标A.docx；投标B.docx', '投标A.docx × 1；投标B.docx × 1', 2]);
    expect(content.xml).toContain('&lt;b&gt;=1+1&lt;/b&gt;');
    expect(content.rows[2][4]).toBe(3);
    expect(image.rows).toEqual([['序号', '图片 Hash', '涉及文件', '各文件出现次数', '出现位置', '图片前文']]);

    // 其他组织不能导出。
    await expectError(await call(b, 'GET', dc(filled.projectId, '/export')), 404, 'PROJECT_NOT_FOUND');
  });
});
