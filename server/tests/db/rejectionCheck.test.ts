// 废标检查（迁移 0016_rejection_check）的数据库与接口测试：七张表的隔离模板（describeProjectTable，项目级），
// 删除可见性与写权限由 RLS 强制（绕过 Store 直接写库同样被拒绝），文档导入与移除、签名、给第 6 步任务用的写函数，
// 以及状态、文档、页面状态、检查问题、清空、Excel 导出接口。
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { REJECTION_CHECK_TABLES } from '../../src/db/migrations/0016_rejection_check.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { APP_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import type { ProjectKind } from '../../src/projects/store.ts';
import {
  clearRejectionCheck,
  computeSignatures,
  deleteFinding,
  importDocuments,
  loadRejectionCheck,
  removeDocument,
  saveCheckResult,
  saveDocumentParse,
  saveExtraction,
  saveUiState,
  setActiveFinding,
} from '../../src/rejectionCheck/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { readWorkbook } from '../xlsx/readXlsx.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable, type ProjectRowScope } from './projectTable.ts';

const PASSWORD = 'quiet-harbor-maple-59';

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

async function newProject(member: Pick<Member, 'orgId' | 'userId'>, kind: ProjectKind = 'rejection-check'): Promise<string> {
  const row = await superuser
    .insertInto('projects')
    .values({ org_id: member.orgId, kind, name: '废标检查项目', created_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** 用超级用户直接登记一个已上传的文件（默认 tender 用途、不属于任何项目）。 */
async function newFile(
  member: Pick<Member, 'orgId' | 'userId'>,
  options: { name?: string; purpose?: string; projectId?: string | null; status?: 'uploaded' | 'uploading' } = {},
): Promise<string> {
  const uploaded = (options.status ?? 'uploaded') === 'uploaded';
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      purpose: options.purpose ?? 'tender',
      display_name: options.name ?? '投标文件.docx',
      extension: 'docx',
      status: uploaded ? 'uploaded' : 'uploading',
      mime: uploaded ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null,
      size_bytes: uploaded ? 100 : null,
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
  options: { kind: 'markdown' | 'image'; sourceFileId: string; status?: 'ready' | 'writing' },
): Promise<string> {
  const ready = (options.status ?? 'ready') === 'ready';
  const row = await superuser
    .insertInto('artifacts')
    .values({
      org_id: member.orgId,
      source_file_id: options.sourceFileId,
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

/** 上传一个 tender 文件、挂到 scope 的项目并导入为文档，返回文件 id。 */
async function documentInContext(trx: Transaction<any>, scope: ProjectRowScope, role: 'tender' | 'bid' = 'bid', sortOrder = 0): Promise<string> {
  const file = await trx
    .insertInto('files')
    .values({ org_id: scope.orgId, project_id: scope.projectId, purpose: 'tender', display_name: 'a.docx', extension: 'docx', created_by: scope.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.updateTable('files').set({ status: 'uploaded', mime: 'application/zip', size_bytes: 10, sha256: Buffer.alloc(32) }).where('id', '=', file.id).execute();
  await trx
    .insertInto('rejection_check_documents')
    .values({ file_id: file.id, org_id: scope.orgId, project_id: scope.projectId, role, sort_order: sortOrder })
    .execute();
  return file.id;
}

const base = (scope: ProjectRowScope) => ({ org_id: scope.orgId, project_id: scope.projectId });

async function insertReturningId(trx: Transaction<any>, table: string, values: Record<string, unknown>): Promise<string> {
  return (await trx.insertInto(table).values(values).returning('id').executeTakeFirstOrThrow()).id;
}

const RISK = { type: 'rejectionItem', severity: 'high', title: '缺少资质', summary: '', requirement: '', bid_evidence: '', risk_reason: '', suggestion: '' };
const TYPO = { wrong_text: '帐号', correct_text: '账号', original_excerpt: '', reason: '' };
const LOGIC = { title: '前后矛盾', original_text: '', location_hint: '', fallacy_reason: '', suggestion: '' };

const ROW_WRITERS: Record<(typeof REJECTION_CHECK_TABLES)[number], (trx: Transaction<any>, scope: ProjectRowScope) => Promise<string>> = {
  async rejection_check_meta(trx, scope) {
    await trx.insertInto('rejection_check_meta').values(base(scope)).execute();
    return scope.projectId;
  },
  rejection_check_documents: (trx, scope) => documentInContext(trx, scope),
  async rejection_check_extraction(trx, scope) {
    await trx.insertInto('rejection_check_extraction').values({ ...base(scope), status: 'success', content: '废标项' }).execute();
    return scope.projectId;
  },
  async rejection_check_results(trx, scope) {
    await trx.insertInto('rejection_check_results').values({ ...base(scope), result_type: 'rejection', status: 'success' }).execute();
    return scope.projectId;
  },
  async rejection_check_risk_findings(trx, scope) {
    const fileId = await documentInContext(trx, scope);
    return insertReturningId(trx, 'rejection_check_risk_findings', { ...base(scope), finding_id: 'r1', bid_document_id: fileId, ...RISK });
  },
  async rejection_check_typo_findings(trx, scope) {
    const fileId = await documentInContext(trx, scope);
    return insertReturningId(trx, 'rejection_check_typo_findings', { ...base(scope), finding_id: 't1', bid_document_id: fileId, ...TYPO });
  },
  async rejection_check_logic_findings(trx, scope) {
    const fileId = await documentInContext(trx, scope);
    return insertReturningId(trx, 'rejection_check_logic_findings', { ...base(scope), finding_id: 'l1', bid_document_id: fileId, ...LOGIC });
  },
};

/** 引用文档的表：项目物理删除被文件（files.project_id，不级联）挡住，要先由清理任务删除文件。 */
const DOCUMENT_LINKED = new Set<string>([
  'rejection_check_documents',
  'rejection_check_risk_findings',
  'rejection_check_typo_findings',
  'rejection_check_logic_findings',
]);
const FINDING_TABLES = ['rejection_check_risk_findings', 'rejection_check_typo_findings', 'rejection_check_logic_findings'] as const;

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

const rc = (projectId: string, path = '') => `/api/projects/${projectId}/rejection-check${path}`;

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

/** 每张表中某个项目的行数（超级用户，绕过 RLS）。 */
async function adminCounts(projectId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of REJECTION_CHECK_TABLES) {
    const row = await superuser.selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).where('project_id', '=', projectId).executeTakeFirstOrThrow();
    counts[table] = Number((row as { n: string }).n);
  }
  return counts;
}

/** 每张表在应用角色下（成员上下文中、不带条件的全表查询）看到的行数。 */
async function visibleCounts(member: Member): Promise<Record<string, number>> {
  return withTenant(appDb, member.context, async (trx) => {
    const counts: Record<string, number> = {};
    for (const table of REJECTION_CHECK_TABLES) {
      const row = await (trx as unknown as Kysely<any>).selectFrom(table).select((eb: any) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
      counts[table] = Number((row as { n: string }).n);
    }
    return counts;
  });
}

const zeroCounts = () => Object.fromEntries(REJECTION_CHECK_TABLES.map((table) => [table, 0]));

interface Filled {
  projectId: string;
  tender: string;
  bidA: string;
  bidB: string;
}

/** 新建项目，导入一份招标文件、两份投标文件，写入解析结果并经 Store 写满三类检查（签名与当前输入一致）。 */
async function fillProject(member: Member): Promise<Filled> {
  const projectId = await newProject(member);
  const tender = await newFile(member, { name: '招标文件.pdf' });
  const bidA = await newFile(member, { name: '投标A.docx' });
  const bidB = await newFile(member, { name: '投标B.docx' });
  await importDocuments(appDb, member.context, projectId, { role: 'tender', fileIds: [tender] });
  await importDocuments(appDb, member.context, projectId, { role: 'bid', fileIds: [bidA, bidB] });
  for (const fileId of [tender, bidA, bidB]) {
    const markdown = await newArtifact(member, { kind: 'markdown', sourceFileId: fileId });
    await saveDocumentParse(appDb, member.context, projectId, fileId, { status: 'success', markdownArtifactId: markdown, contentChars: 1000, contentHash: `hash-${fileId}`, parserLabel: 'docx' });
  }
  let state = await loadRejectionCheck(appDb, member.context, projectId);
  await saveExtraction(appDb, member.context, projectId, { status: 'success', content: '1. 未按要求盖章的，投标无效。', source: 'ai', tenderSignature: state.signatures.tender });
  state = await loadRejectionCheck(appDb, member.context, projectId);
  await saveCheckResult(appDb, member.context, projectId, 'rejection', {
    status: 'success',
    inputSignature: state.signatures.rejectionInput,
    progressMessage: '发现 2 个风险项',
    findings: [
      { id: 'r1', bidDocumentId: bidA, type: 'invalidBid', severity: 'high', title: '未盖章', summary: '投标函未盖章', requirement: '须加盖公章', bidEvidence: '无', riskReason: '无效标', suggestion: '补盖' },
      { bidDocumentId: bidB, title: '=HYPERLINK("http://x")', severity: 'unknown' as never },
    ],
  });
  await saveCheckResult(appDb, member.context, projectId, 'typo', {
    status: 'success',
    inputSignature: state.signatures.bid,
    findings: [{ bidDocumentId: bidB, wrongText: '帐号', correctText: '账号', originalExcerpt: '请填写帐号', reason: '用字不规范', locationHint: '第 3 页' }],
  });
  await saveCheckResult(appDb, member.context, projectId, 'logic', {
    status: 'success',
    inputSignature: state.signatures.bid,
    findings: [{ bidDocumentId: bidA, title: '工期矛盾', originalText: '工期 30 天……工期 45 天', locationHint: '第 2 章', fallacyReason: '前后不一致', suggestion: '统一工期' }],
  });
  return { projectId, tender, bidA, bidB };
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
    rejection_check_meta: 'project_id',
    rejection_check_documents: 'file_id',
    rejection_check_extraction: 'project_id',
    rejection_check_results: 'project_id',
  };
  // 页面状态、文档的解析结果、解析结果、检查状态按字段更新；三张问题表整体替换，不授予 UPDATE。
  const updates: Record<string, Record<string, unknown>> = {
    rejection_check_meta: { step: 'items' },
    rejection_check_documents: { status: 'running' },
    rejection_check_extraction: { status: 'running' },
    rejection_check_results: { status: 'running' },
  };

  for (const table of REJECTION_CHECK_TABLES) {
    describeProjectTable(
      {
        table,
        idColumn: ids[table] ?? 'id',
        projectKind: 'rejection-check',
        insert: (trx, scope) => ROW_WRITERS[table](trx, scope),
        onProjectDelete: DOCUMENT_LINKED.has(table) ? 'restrict' : 'cascade',
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

  it('所属项目软删除后七张表都查不到、改不了、删不掉，恢复项目即一起恢复', async () => {
    const filled = await fillProject(a);
    const before = await adminCounts(filled.projectId);
    expect(Object.values(before).every((n) => n > 0)).toBe(true);
    expect(await visibleCounts(a)).toEqual(before);

    await softDeleteProject(filled.projectId, a.userId);
    expect(await visibleCounts(a)).toEqual(zeroCounts());
    await withTenant(appDb, a.context, async (trx) => {
      const any = trx as unknown as Kysely<any>;
      expect((await any.updateTable('rejection_check_meta').set({ step: 'documents' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.updateTable('rejection_check_documents').set({ status: 'error' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.updateTable('rejection_check_results').set({ status: 'idle' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await any.deleteFrom('rejection_check_extraction').executeTakeFirst()).numDeletedRows).toBe(0n);
      expect((await any.deleteFrom('rejection_check_risk_findings').executeTakeFirst()).numDeletedRows).toBe(0n);
    });
    // 已删除的项目下不能新写。
    await expect(
      withTenant(appDb, a.context, (trx) =>
        trx.insertInto('rejection_check_results').values({ org_id: a.orgId, project_id: filled.projectId, result_type: 'typo', status: 'idle' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await adminCounts(filled.projectId)).toEqual(before);

    await restoreProject(filled.projectId);
    expect(await visibleCounts(a)).toEqual(before);
  });

  it('文档的原件进回收站后，文档行和引用它的问题都不可见，其他行不受影响；恢复文件即一起恢复', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    const before = (await visibleCounts(member)) as Record<(typeof REJECTION_CHECK_TABLES)[number], number>;
    await softDeleteFile(filled.bidB, member.userId);
    const after = await visibleCounts(member);
    // 投标 B 的文档行、它的废标项和错别字不可见；逻辑问题只涉及投标 A。
    expect(after.rejection_check_documents).toBe(before.rejection_check_documents - 1);
    expect(after.rejection_check_risk_findings).toBe(before.rejection_check_risk_findings - 1);
    expect(after.rejection_check_typo_findings).toBe(0);
    expect(after.rejection_check_logic_findings).toBe(before.rejection_check_logic_findings);
    for (const table of ['rejection_check_meta', 'rejection_check_extraction', 'rejection_check_results'] as const) {
      expect(after[table], table).toBe(before[table]);
    }
    const state = await loadRejectionCheck(appDb, member.context, filled.projectId);
    expect(state.bidDocuments.map((document) => document.id)).toEqual([filled.bidA]);
    expect(state.rejectionCheckResult.findings.map((finding) => finding.id)).toEqual(['r1']);

    await restoreFile(filled.bidB);
    expect(await visibleCounts(member)).toEqual(before);
  });

  it('文件被清理任务物理删除时，文档行及其问题级联删除；项目随后可以物理删除', async () => {
    const member = await newMember();
    const filled = await fillProject(member);
    await superuser.deleteFrom('artifacts').where('org_id', '=', member.orgId).execute();
    await superuser.deleteFrom('files').where('project_id', '=', filled.projectId).execute();
    const counts = await adminCounts(filled.projectId);
    for (const table of DOCUMENT_LINKED) expect(counts[table], table).toBe(0);
    expect(counts.rejection_check_results).toBe(3);
    await superuser.deleteFrom('projects').where('id', '=', filled.projectId).execute();
    expect(await adminCounts(filled.projectId)).toEqual(zeroCounts());
  });

  it('只能挂在废标检查项目下：其他 kind 的项目下写不进任何一张表', async () => {
    const projectId = await newProject(a, 'duplicate-check');
    const scope = { orgId: a.orgId, userId: a.userId, projectId };
    for (const table of REJECTION_CHECK_TABLES) {
      await expect(
        withTenant(appDb, a.context, (trx) => ROW_WRITERS[table](trx as unknown as Transaction<any>, scope)),
        table,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it('只能导入本组织已上传、未删除、用途是 tender、已挂到本项目的文件；新文档一律待解析', async () => {
    const projectId = await newProject(a);
    const other = await newProject(a);
    const insert = (fileId: string, extra: Record<string, unknown> = {}) =>
      withTenant(appDb, a.context, (trx) =>
        (trx as unknown as Kysely<any>)
          .insertInto('rejection_check_documents')
          .values({ file_id: fileId, org_id: a.orgId, project_id: projectId, role: 'bid', sort_order: 0, ...extra })
          .execute(),
      );
    const deleted = await newFile(a, { projectId });
    await softDeleteFile(deleted, a.userId);
    const rejected = [
      await newFile(a), // 不属于任何项目
      await newFile(a, { projectId: other }), // 属于其他项目
      await newFile(a, { projectId, purpose: 'duplicate-check' }), // 其他用途
      await newFile(a, { projectId, status: 'uploading' }), // 未上传完成
      deleted,
    ];
    for (const fileId of rejected) await expect(insert(fileId)).rejects.toThrow(/row-level security/);
    // 其他组织的文件：外键挡住（应用角色看不到它，INSERT 策略也不成立）。
    await expect(insert(await newFile(b, { projectId: await newProject(b) }))).rejects.toThrow(/row-level security|foreign key/);
    const fine = await newFile(a, { projectId });
    // 状态等解析结果没有 INSERT 授权。
    await expect(insert(fine, { status: 'success' })).rejects.toThrow(/permission denied/);
    await insert(fine);
    // 同一文件不能导入两次（不能既是招标文件又是投标文件）。
    await expect(insert(fine)).rejects.toThrow(/duplicate key/);
    const row = await superuser.selectFrom('rejection_check_documents').select('status').where('file_id', '=', fine).executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
  });

  it('解析出的 Markdown 只能是本文档原件的 Markdown 产物', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const fileA = await newFile(member);
    const fileB = await newFile(member);
    await importDocuments(appDb, member.context, projectId, { role: 'bid', fileIds: [fileA, fileB] });
    const setMarkdown = (artifactId: string) =>
      withTenant(appDb, member.context, (trx) => trx.updateTable('rejection_check_documents').set({ markdown_artifact_id: artifactId }).where('file_id', '=', fileA).execute());
    for (const artifactId of [
      await newArtifact(member, { kind: 'markdown', sourceFileId: fileB }), // 其他文件的
      await newArtifact(member, { kind: 'image', sourceFileId: fileA }), // 不是 Markdown
      await newArtifact(member, { kind: 'markdown', sourceFileId: fileA, status: 'writing' }), // 未写完
    ]) {
      await expect(setMarkdown(artifactId)).rejects.toThrow(/row-level security/);
    }
    await setMarkdown(await newArtifact(member, { kind: 'markdown', sourceFileId: fileA }));
  });

  it('问题只能指向本项目的投标文件', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const tender = await newFile(member);
    const bid = await newFile(member);
    await importDocuments(appDb, member.context, projectId, { role: 'tender', fileIds: [tender] });
    await importDocuments(appDb, member.context, projectId, { role: 'bid', fileIds: [bid] });
    const insert = (bidDocumentId: string) =>
      withTenant(appDb, member.context, (trx) =>
        (trx as unknown as Kysely<any>)
          .insertInto('rejection_check_logic_findings')
          .values({ org_id: member.orgId, project_id: projectId, finding_id: randomUUID(), bid_document_id: bidDocumentId, ...LOGIC })
          .execute(),
      );
    await expect(insert(tender)).rejects.toThrow(/row-level security/);
    await expect(insert(randomUUID())).rejects.toThrow(/row-level security|foreign key/);
    await insert(bid);
  });

  it('页面状态、文档没有 DELETE 授权，问题表没有 UPDATE 授权；org_id、project_id、file_id 等写入后不能改', async () => {
    const privileges = await sql<{ table: string; del: boolean; upd: boolean }>`
      SELECT t AS table, has_table_privilege(${APP_ROLE}, t, 'DELETE') AS del, has_any_column_privilege(${APP_ROLE}, t, 'UPDATE') AS upd
      FROM unnest(${sql.val([...REJECTION_CHECK_TABLES])}::text[]) AS t ORDER BY t`.execute(superuser);
    const byTable = Object.fromEntries(privileges.rows.map((row) => [row.table, row]));
    expect(byTable.rejection_check_meta).toMatchObject({ del: false, upd: true });
    expect(byTable.rejection_check_documents).toMatchObject({ del: false, upd: true });
    expect(byTable.rejection_check_extraction).toMatchObject({ del: true, upd: true });
    expect(byTable.rejection_check_results).toMatchObject({ del: true, upd: true });
    for (const table of FINDING_TABLES) expect(byTable[table], table).toMatchObject({ del: true, upd: false });
    for (const [table, column] of [
      ['rejection_check_meta', 'project_id'],
      ['rejection_check_documents', 'file_id'],
      ['rejection_check_documents', 'role'],
      ['rejection_check_documents', 'sort_order'],
      ['rejection_check_extraction', 'org_id'],
      ['rejection_check_results', 'result_type'],
    ] as const) {
      const result = await sql<{ ok: boolean }>`SELECT has_column_privilege(${APP_ROLE}, ${table}, ${column}, 'UPDATE') AS ok`.execute(superuser);
      expect(result.rows[0]!.ok, `${table}.${column}`).toBe(false);
    }
  });

  it('取值与长度由 CHECK 约束挡住', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const write = (values: Record<string, unknown>) =>
      withTenant(appDb, member.context, (trx) => (trx as unknown as Kysely<any>).insertInto('rejection_check_meta').values({ org_id: member.orgId, project_id: projectId, ...values }).execute());
    for (const values of [{ step: 'done' }, { active_document_tab: '' }, { active_document_tab: 'x'.repeat(201) }, { active_check_result_tab: 'other' }, { custom_check_items: 'x'.repeat(100_001) }]) {
      await expect(write(values), JSON.stringify(values).slice(0, 60)).rejects.toThrow(/check constraint/);
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
    const state = await loadRejectionCheck(appDb, a.context, projectId);
    const emptyResult = { status: 'idle', findings: [], inputSignature: null, activeFindingId: null, progressMessage: null, error: null, updatedAt: null };
    expect(state).toEqual({
      tenderDocuments: [],
      bidDocuments: [],
      step: 'documents',
      activeDocumentTab: 'tender',
      activeResultTab: 'analysis',
      activeCheckResultTab: 'rejection',
      customCheckItems: '',
      checkOptions: { rejectionCheck: true, typoCheck: true, logicCheck: true },
      signatures: { tender: '', bid: '', rejectionInput: '' },
      invalidBidAndRejectionItems: { status: 'idle', content: '', source: null, tenderSignature: null, error: null, updatedAt: null },
      rejectionCheckResult: emptyResult,
      typoCheckResult: emptyResult,
      logicCheckResult: emptyResult,
      extractionTask: null,
      checkTask: null,
    });
    expect(await adminCounts(projectId)).toEqual(zeroCounts());
  });

  it('导入文档：挂到项目、按给出的顺序追加、待解析，已导入的跳过；当前页签与桌面版相同', async () => {
    const projectId = await newProject(a);
    const tender1 = await newFile(a, { name: '招标1.pdf' });
    const tender2 = await newFile(a, { name: '招标2.pdf' });
    const bid1 = await newFile(a, { name: '投标1.docx' });
    const bid2 = await newFile(a, { name: '投标2.docx' });
    let result = await importDocuments(appDb, a.context, projectId, { role: 'tender', fileIds: [tender2] });
    expect(result).toMatchObject({ addedCount: 1, skippedCount: 0 });
    result = await importDocuments(appDb, a.context, projectId, { role: 'tender', fileIds: [tender1.toUpperCase(), tender2] });
    expect(result).toMatchObject({ addedCount: 1, skippedCount: 1 });
    expect(result.state.tenderDocuments.map((document) => document.fileName)).toEqual(['招标2.pdf', '招标1.pdf']);
    expect(result.state.activeDocumentTab).toBe('tender');
    result = await importDocuments(appDb, a.context, projectId, { role: 'bid', fileIds: [bid2, bid1] });
    expect(result.state.bidDocuments.map((document) => document.id)).toEqual([bid2, bid1]);
    expect(result.state.activeDocumentTab).toBe(bid2);
    expect(result.state.bidDocuments[0]).toMatchObject({ role: 'bid', fileName: '投标2.docx', extension: 'docx', size: 100, status: 'pending', markdownArtifactId: null, contentHash: null });
    // 只跳过时不改当前页签。
    await saveUiState(appDb, a.context, projectId, { activeDocumentTab: bid1 });
    result = await importDocuments(appDb, a.context, projectId, { role: 'bid', fileIds: [bid1] });
    expect(result).toMatchObject({ addedCount: 0, skippedCount: 1 });
    expect(result.state.activeDocumentTab).toBe(bid1);
    const files = await superuser.selectFrom('files').select('project_id').where('id', 'in', [tender1, tender2, bid1, bid2]).execute();
    expect(files.every((file: { project_id: string }) => file.project_id === projectId)).toBe(true);
    // 组织内其他成员看到同样的状态（组织内共享）。
    expect(await loadRejectionCheck(appDb, peer.context, projectId)).toEqual(result.state);
  });

  it('导入招标文件清空解析结果和三类检查结果，导入投标文件只清空三类检查结果', async () => {
    const filled = await fillProject(a);
    await importDocuments(appDb, a.context, filled.projectId, { role: 'bid', fileIds: [await newFile(a)] });
    let counts = await adminCounts(filled.projectId);
    expect(counts.rejection_check_extraction).toBe(1);
    expect([counts.rejection_check_results, ...FINDING_TABLES.map((table) => counts[table])]).toEqual([0, 0, 0, 0]);
    await importDocuments(appDb, a.context, filled.projectId, { role: 'tender', fileIds: [await newFile(a)] });
    counts = await adminCounts(filled.projectId);
    expect(counts.rejection_check_extraction).toBe(0);
  });

  it('文件不可用或超过数量上限时整体失败，不改动已有文档', async () => {
    const projectId = await newProject(a);
    const kept = await newFile(a);
    await importDocuments(appDb, a.context, projectId, { role: 'bid', fileIds: [kept] });
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
    const fresh = await newFile(a);
    for (const fileId of unavailable) {
      await expect(importDocuments(appDb, a.context, projectId, { role: 'bid', fileIds: [fresh, fileId] })).rejects.toMatchObject({
        statusCode: 400,
        code: 'REJECTION_CHECK_FILE_UNAVAILABLE',
      });
    }
    await expect(importDocuments(appDb, a.context, projectId, { role: 'tender', fileIds: [fresh, fresh] })).rejects.toMatchObject({ code: 'REJECTION_CHECK_FILE_UNAVAILABLE' });
    // 已导入为投标文件的不能再作为招标文件导入（视为已导入，跳过）。
    expect(await importDocuments(appDb, a.context, projectId, { role: 'tender', fileIds: [kept] })).toMatchObject({ addedCount: 0, skippedCount: 1 });
    const state = await loadRejectionCheck(appDb, a.context, projectId);
    expect(state.bidDocuments.map((document) => document.id)).toEqual([kept]);
    expect(state.tenderDocuments).toEqual([]);
    // 没有挂到本项目。
    expect((await superuser.selectFrom('files').select('project_id').where('id', '=', fresh).executeTakeFirstOrThrow()).project_id).toBeNull();

    const many = await Promise.all(Array.from({ length: 20 }, () => newFile(a)));
    await importDocuments(appDb, a.context, projectId, { role: 'tender', fileIds: many });
    await expect(importDocuments(appDb, a.context, projectId, { role: 'tender', fileIds: [fresh] })).rejects.toMatchObject({
      statusCode: 400,
      code: 'REJECTION_CHECK_DOCUMENT_LIMIT',
    });
  });

  it('移除文档：原件进回收站；招标文件清空解析与检查结果，投标文件只清空检查结果；当前页签与桌面版相同', async () => {
    const filled = await fillProject(a);
    let state = await removeDocument(appDb, a.context, filled.projectId, filled.bidA);
    expect(state.bidDocuments.map((document) => document.id)).toEqual([filled.bidB]);
    expect(state.activeDocumentTab).toBe(filled.bidB);
    expect(state.invalidBidAndRejectionItems.status).toBe('success');
    expect(state.rejectionCheckResult).toMatchObject({ status: 'idle', findings: [] });
    const file = await superuser.selectFrom('files').select(['deleted_at', 'deleted_by']).where('id', '=', filled.bidA).executeTakeFirstOrThrow();
    expect(file.deleted_at).toBeInstanceOf(Date);
    expect(file.deleted_by).toBe(a.userId);

    state = await removeDocument(appDb, a.context, filled.projectId, filled.bidB);
    expect(state.activeDocumentTab).toBe('tender');
    state = await removeDocument(appDb, a.context, filled.projectId, filled.tender);
    expect(state.tenderDocuments).toEqual([]);
    expect(state.invalidBidAndRejectionItems.status).toBe('idle');
    expect(await adminCounts(filled.projectId)).toEqual({ ...zeroCounts(), rejection_check_meta: 1, rejection_check_documents: 3 });

    await expect(removeDocument(appDb, a.context, filled.projectId, filled.tender)).rejects.toMatchObject({ statusCode: 404, code: 'REJECTION_CHECK_DOCUMENT_NOT_FOUND' });
    await expect(removeDocument(appDb, a.context, filled.projectId, randomUUID())).rejects.toMatchObject({ code: 'REJECTION_CHECK_DOCUMENT_NOT_FOUND' });
  });

  it('保存页面状态只写给出的字段，检查选项按桌面版整理；不可用的文档页签读出时回退', async () => {
    const projectId = await newProject(a);
    expect(await saveUiState(appDb, a.context, projectId, { activeCheckResultTab: 'logic' })).toMatchObject({ step: 'documents', activeCheckResultTab: 'logic' });
    const ui = await saveUiState(appDb, a.context, projectId, {
      step: 'results',
      activeResultTab: 'custom',
      customCheckItems: '核对\u0000报价',
      checkOptions: { rejectionCheck: false, typoCheck: false },
    });
    expect(ui).toEqual({
      step: 'results',
      activeDocumentTab: 'tender',
      activeResultTab: 'custom',
      activeCheckResultTab: 'logic',
      customCheckItems: '核对报价',
      checkOptions: { rejectionCheck: true, typoCheck: false, logicCheck: true },
    });
    // 页签指向不存在的文档：没有招标文件时回退到第一份投标文件，都没有时回到合并的招标正文。
    await saveUiState(appDb, a.context, projectId, { activeDocumentTab: randomUUID() });
    expect((await loadRejectionCheck(appDb, a.context, projectId)).activeDocumentTab).toBe('tender');
    const bid = await newFile(a);
    await importDocuments(appDb, a.context, projectId, { role: 'bid', fileIds: [bid] });
    await saveUiState(appDb, a.context, projectId, { activeDocumentTab: 'missing' });
    expect((await loadRejectionCheck(appDb, a.context, projectId)).activeDocumentTab).toBe(bid);
  });

  it('签名：由文档 id 与正文哈希算出；解析结果只在其招标文件签名与当前一致时计入废标项检查的输入', async () => {
    const filled = await fillProject(a);
    let state = await loadRejectionCheck(appDb, a.context, filled.projectId);
    const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');
    expect(state.signatures.tender).toBe(sha1(`${filled.tender}|hash-${filled.tender}`));
    expect(state.signatures.bid).toBe(sha1([`${filled.bidA}|hash-${filled.bidA}`, `${filled.bidB}|hash-${filled.bidB}`].join('\n')));
    expect(state.signatures.rejectionInput).toBe(sha1(JSON.stringify([state.signatures.bid, '1. 未按要求盖章的，投标无效。', ''])));
    expect(computeSignatures({ ...state, extraction: state.invalidBidAndRejectionItems })).toEqual(state.signatures);
    // 自定义检查项参与废标项检查的签名。
    const before = state.signatures;
    await saveUiState(appDb, a.context, filled.projectId, { customCheckItems: ' 核对报价 ' });
    state = await loadRejectionCheck(appDb, a.context, filled.projectId);
    expect(state.signatures.rejectionInput).not.toBe(before.rejectionInput);
    expect(state.signatures.bid).toBe(before.bid);
    // 重新解析投标文件后正文哈希变化，投标签名随之变化。
    await saveDocumentParse(appDb, a.context, filled.projectId, filled.bidA, { contentHash: 'hash-new' });
    state = await loadRejectionCheck(appDb, a.context, filled.projectId);
    expect(state.signatures.bid).not.toBe(before.bid);
    // 解析结果的招标签名与当前不一致时不计入。
    await saveExtraction(appDb, a.context, filled.projectId, { status: 'success', content: '废标项', tenderSignature: 'stale' });
    expect((await loadRejectionCheck(appDb, a.context, filled.projectId)).signatures.rejectionInput).toBe('');
  });

  it('任务写入：文档解析结果、解析结果（去掉外层引号、null 删除）、检查结果（部分写入、问题整体替换、默认值）', async () => {
    const filled = await fillProject(a);
    let state = await loadRejectionCheck(appDb, a.context, filled.projectId);
    expect(state.tenderDocuments[0]).toMatchObject({ status: 'success', contentChars: 1000, contentHash: `hash-${filled.tender}`, parserLabel: 'docx' });
    expect(state.tenderDocuments[0]!.markdownArtifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await saveDocumentParse(appDb, a.context, filled.projectId, filled.bidA, { status: 'error', error: 'x'.repeat(30_000), markdownArtifactId: null })).toBe(true);
    state = await loadRejectionCheck(appDb, a.context, filled.projectId);
    expect(state.bidDocuments[0]).toMatchObject({ status: 'error', markdownArtifactId: null, contentHash: `hash-${filled.bidA}` });
    expect(state.bidDocuments[0]!.error).toHaveLength(20_000);
    expect(await saveDocumentParse(appDb, a.context, filled.projectId, randomUUID(), { status: 'success' })).toBe(false);

    expect(state.rejectionCheckResult).toMatchObject({ status: 'success', progressMessage: '发现 2 个风险项' });
    expect(state.rejectionCheckResult.findings).toEqual([
      { id: 'r1', bidDocumentId: filled.bidA, type: 'invalidBid', severity: 'high', title: '未盖章', summary: '投标函未盖章', requirement: '须加盖公章', bidEvidence: '无', riskReason: '无效标', suggestion: '补盖' },
      // 默认 id、类型、等级与桌面版相同，摘要为空时取标题。
      { id: 'rejection-finding-2', bidDocumentId: filled.bidB, type: 'rejectionItem', severity: 'medium', title: '=HYPERLINK("http://x")', summary: '=HYPERLINK("http://x")', requirement: '', bidEvidence: '', riskReason: '', suggestion: '' },
    ]);
    expect(state.typoCheckResult.findings).toEqual([
      { id: 'typo-finding-1', bidDocumentId: filled.bidB, wrongText: '帐号', correctText: '账号', originalExcerpt: '请填写帐号', reason: '用字不规范', locationHint: '第 3 页' },
    ]);

    await saveCheckResult(appDb, a.context, filled.projectId, 'rejection', { status: 'running', progressMessage: 'x\u0000y'.repeat(2000) });
    state = await loadRejectionCheck(appDb, a.context, filled.projectId);
    expect(state.rejectionCheckResult.status).toBe('running');
    expect(state.rejectionCheckResult.findings).toHaveLength(2);
    expect([...state.rejectionCheckResult.progressMessage!].length).toBe(2000);
    expect(state.rejectionCheckResult.progressMessage).not.toContain('\u0000');
    await saveCheckResult(appDb, a.context, filled.projectId, 'rejection', { findings: [], inputSignature: null });
    state = await loadRejectionCheck(appDb, a.context, filled.projectId);
    expect(state.rejectionCheckResult).toMatchObject({ status: 'running', findings: [], inputSignature: null });
    await saveCheckResult(appDb, a.context, filled.projectId, 'typo', null);
    state = await loadRejectionCheck(appDb, a.context, filled.projectId);
    expect(state.typoCheckResult).toMatchObject({ status: 'idle', findings: [], updatedAt: null });
    expect(state.logicCheckResult.findings).toHaveLength(1);

    await saveExtraction(appDb, a.context, filled.projectId, { status: 'success', content: "'''\n废标项\n'''", source: 'technical-plan' });
    state = await loadRejectionCheck(appDb, a.context, filled.projectId);
    expect(state.invalidBidAndRejectionItems).toMatchObject({ status: 'success', content: '废标项', source: 'technical-plan', tenderSignature: null, error: null });
    await saveExtraction(appDb, a.context, filled.projectId, null);
    expect((await loadRejectionCheck(appDb, a.context, filled.projectId)).invalidBidAndRejectionItems.status).toBe('idle');
  });

  it('任务写入的程序错误抛 TypeError；指向招标文件或已移除的投标文件被 RLS 拒绝，写入整体回滚', async () => {
    const filled = await fillProject(a);
    const write = (type: 'rejection' | 'typo' | 'logic', findings: object[]) =>
      saveCheckResult(appDb, a.context, filled.projectId, type, { status: 'error', findings } as never);
    await expect(write('logic', [{ id: 'x', bidDocumentId: filled.bidA }, { id: 'x', bidDocumentId: filled.bidA }])).rejects.toThrow(TypeError);
    await expect(write('logic', [{ id: 'x'.repeat(201), bidDocumentId: filled.bidA }])).rejects.toThrow(TypeError);
    await expect(write('typo', [{ bidDocumentId: 'not-a-uuid' }])).rejects.toThrow(TypeError);
    await expect(saveDocumentParse(appDb, a.context, filled.projectId, 'not-a-uuid', {})).rejects.toThrow(TypeError);
    await expect(saveCheckResult(appDb, a.context, filled.projectId, 'other' as never, null)).rejects.toThrow(TypeError);
    await expect(write('logic', [{ bidDocumentId: filled.tender }])).rejects.toThrow(/row-level security/);
    await removeDocument(appDb, a.context, filled.projectId, filled.bidB);
    await saveCheckResult(appDb, a.context, filled.projectId, 'logic', { status: 'success', findings: [{ bidDocumentId: filled.bidA }] });
    await expect(write('logic', [{ bidDocumentId: filled.bidA }, { bidDocumentId: filled.bidB }])).rejects.toThrow(/row-level security|foreign key/);
    // 失败的写入整体回滚：状态与问题都是失败前的。
    const logic = (await loadRejectionCheck(appDb, a.context, filled.projectId)).logicCheckResult;
    expect(logic).toMatchObject({ status: 'success', findings: [{ id: 'logic-finding-1', bidDocumentId: filled.bidA }] });
  });

  it('切换当前问题、删除单条问题：进度说明与桌面版相同', async () => {
    const filled = await fillProject(a);
    let result = await setActiveFinding(appDb, a.context, filled.projectId, 'rejection', 'r1');
    expect(result.activeFindingId).toBe('r1');
    result = await deleteFinding(appDb, a.context, filled.projectId, 'rejection', 'r1');
    expect(result).toMatchObject({ activeFindingId: null, progressMessage: '保留 1 个需复核风险项' });
    expect(result.findings.map((finding) => finding.id)).toEqual(['rejection-finding-2']);
    result = await deleteFinding(appDb, a.context, filled.projectId, 'rejection', 'rejection-finding-2');
    expect(result).toMatchObject({ findings: [], progressMessage: '所有风险项已处理', status: 'success' });
    await setActiveFinding(appDb, a.context, filled.projectId, 'typo', 'typo-finding-1');
    expect(await deleteFinding(appDb, a.context, filled.projectId, 'logic', 'logic-finding-1')).toMatchObject({ progressMessage: '所有逻辑问题已处理' });
    expect((await loadRejectionCheck(appDb, a.context, filled.projectId)).typoCheckResult.activeFindingId).toBe('typo-finding-1');
    expect(await deleteFinding(appDb, a.context, filled.projectId, 'typo', 'typo-finding-1')).toMatchObject({ activeFindingId: null, progressMessage: '所有错别字项已处理' });
    await expect(deleteFinding(appDb, a.context, filled.projectId, 'typo', 'typo-finding-1')).rejects.toMatchObject({ statusCode: 404, code: 'REJECTION_CHECK_FINDING_NOT_FOUND' });
    expect((await setActiveFinding(appDb, a.context, filled.projectId, 'typo', null)).activeFindingId).toBeNull();
  });

  it('清空：删除解析与检查结果，导入的文档进回收站，页面状态恢复默认值', async () => {
    const filled = await fillProject(a);
    await saveUiState(appDb, a.context, filled.projectId, { step: 'results', customCheckItems: '核对', checkOptions: { typoCheck: false } });
    expect(await clearRejectionCheck(appDb, a.context, filled.projectId)).toEqual({ deletedFileCount: 3 });
    expect(await adminCounts(filled.projectId)).toEqual({ ...zeroCounts(), rejection_check_meta: 1, rejection_check_documents: 3 });
    const state = await loadRejectionCheck(appDb, a.context, filled.projectId);
    expect(state).toMatchObject({
      tenderDocuments: [],
      bidDocuments: [],
      step: 'documents',
      customCheckItems: '',
      checkOptions: { typoCheck: true, logicCheck: true },
      signatures: { tender: '', bid: '', rejectionInput: '' },
    });
    const files = await superuser.selectFrom('files').select('deleted_at').where('project_id', '=', filled.projectId).execute();
    expect(files.length).toBe(3);
    expect(files.every((file: { deleted_at: Date | null }) => file.deleted_at instanceof Date)).toBe(true);
  });

  it('其他组织看不到、写不进本组织的项目', async () => {
    const filled = await fillProject(a);
    const state = await loadRejectionCheck(appDb, b.context, filled.projectId);
    expect(state).toMatchObject({ tenderDocuments: [], bidDocuments: [], rejectionCheckResult: { findings: [] } });
    // 页面状态行已存在：撞到唯一键后的 UPDATE 被 RLS 拒绝（行不存在时由复合外键拒绝）。
    await expect(saveUiState(appDb, b.context, filled.projectId, { step: 'items' })).rejects.toThrow(/row-level security|foreign key/);
    await expect(saveUiState(appDb, b.context, await newProject(a), { step: 'items' })).rejects.toThrow(/foreign key/);
    await expect(importDocuments(appDb, b.context, filled.projectId, { role: 'bid', fileIds: [await newFile(b)] })).rejects.toMatchObject({ code: 'REJECTION_CHECK_FILE_UNAVAILABLE' });
    await expect(removeDocument(appDb, b.context, filled.projectId, filled.bidA)).rejects.toMatchObject({ code: 'REJECTION_CHECK_DOCUMENT_NOT_FOUND' });
    await expect(deleteFinding(appDb, b.context, filled.projectId, 'rejection', 'r1')).rejects.toMatchObject({ code: 'REJECTION_CHECK_FINDING_NOT_FOUND' });
    expect(await saveDocumentParse(appDb, b.context, filled.projectId, filled.bidA, { status: 'error' })).toBe(false);
    expect(await clearRejectionCheck(appDb, b.context, filled.projectId)).toEqual({ deletedFileCount: 0 });
    const counts = await adminCounts(filled.projectId);
    expect(counts.rejection_check_documents).toBe(3);
    expect(counts.rejection_check_risk_findings).toBe(2);
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
    await expectError(await call(null, 'GET', rc(projectId)), 401, 'UNAUTHORIZED');
  });

  it('项目不存在、属于其他组织、已删除、kind 不符一律 404', async () => {
    const own = await newProject(a);
    const deleted = await newProject(a);
    await softDeleteProject(deleted, a.userId);
    const wrongKind = await newProject(a, 'duplicate-check');
    for (const [member, projectId] of [
      [a, randomUUID()],
      [b, own],
      [a, deleted],
      [a, wrongKind],
    ] as const) {
      await expectError(await call(member, 'GET', rc(projectId)), 404, 'PROJECT_NOT_FOUND');
      await expectError(await call(member, 'POST', rc(projectId, '/documents'), { role: 'bid', fileIds: [randomUUID()] }), 404, 'PROJECT_NOT_FOUND');
      await expectError(await call(member, 'DELETE', rc(projectId, `/documents/${randomUUID()}`)), 404, 'PROJECT_NOT_FOUND');
      await expectError(await call(member, 'PATCH', rc(projectId, '/ui-state'), { step: 'items' }), 404, 'PROJECT_NOT_FOUND');
      await expectError(await call(member, 'PATCH', rc(projectId, '/results/typo'), { activeFindingId: null }), 404, 'PROJECT_NOT_FOUND');
      await expectError(await call(member, 'DELETE', rc(projectId, '/results/typo/findings/t1')), 404, 'PROJECT_NOT_FOUND');
      await expectError(await call(member, 'DELETE', rc(projectId)), 404, 'PROJECT_NOT_FOUND');
      await expectError(await call(member, 'GET', rc(projectId, '/export')), 404, 'PROJECT_NOT_FOUND');
    }
    await expectError(await call(a, 'GET', rc('not-a-uuid')), 400, 'BAD_REQUEST');
  });

  it('读取、导入、移除文档、保存页面状态、切换与删除问题、清空', async () => {
    const filled = await fillProject(a);
    const initial = await call(a, 'GET', rc(filled.projectId));
    expect(initial.statusCode).toBe(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(initial.json()).toMatchObject({ tenderDocuments: [{ id: filled.tender, fileName: '招标文件.pdf' }], extractionTask: null, checkTask: null });
    expect(typeof initial.json().bidDocuments[0].importedAt).toBe('string');

    const bid = await newFile(a, { name: '投标C.docx' });
    const imported = await call(a, 'POST', rc(filled.projectId, '/documents'), { role: 'bid', fileIds: [bid.toUpperCase()] });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json()).toMatchObject({ addedCount: 1, skippedCount: 0, state: { activeDocumentTab: bid, rejectionCheckResult: { findings: [] } } });

    const removed = await call(a, 'DELETE', rc(filled.projectId, `/documents/${bid}`));
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().bidDocuments.map((document: { id: string }) => document.id)).toEqual([filled.bidA, filled.bidB]);
    await expectError(await call(a, 'DELETE', rc(filled.projectId, `/documents/${bid}`)), 404, 'REJECTION_CHECK_DOCUMENT_NOT_FOUND');

    const ui = await call(a, 'PATCH', rc(filled.projectId, '/ui-state'), { activeCheckResultTab: 'typo', checkOptions: { logicCheck: false } });
    expect(ui.json()).toMatchObject({ activeCheckResultTab: 'typo', checkOptions: { rejectionCheck: true, typoCheck: true, logicCheck: false } });

    await saveCheckResult(appDb, a.context, filled.projectId, 'typo', { findings: [{ id: 't1', bidDocumentId: filled.bidA }] });
    const active = await call(a, 'PATCH', rc(filled.projectId, '/results/typo'), { activeFindingId: 't1' });
    expect(active.json()).toMatchObject({ activeFindingId: 't1', findings: [{ id: 't1' }] });
    const deleted = await call(a, 'DELETE', rc(filled.projectId, '/results/typo/findings/t1'));
    expect(deleted.json()).toMatchObject({ activeFindingId: null, findings: [], progressMessage: '所有错别字项已处理' });
    await expectError(await call(a, 'DELETE', rc(filled.projectId, '/results/typo/findings/t1')), 404, 'REJECTION_CHECK_FINDING_NOT_FOUND');

    const cleared = await call(a, 'DELETE', rc(filled.projectId));
    expect(cleared.json()).toEqual({ deletedFileCount: 3 });
    expect((await call(a, 'GET', rc(filled.projectId))).json()).toMatchObject({ bidDocuments: [], step: 'documents', checkOptions: { logicCheck: true } });
  });

  it('请求体校验：未声明字段、空的页面状态、非法取值、超过数量与长度上限', async () => {
    const projectId = await newProject(a);
    for (const [method, path, body] of [
      ['POST', '/documents', { role: 'bid', fileIds: [], extra: 1 }],
      ['POST', '/documents', { role: 'bid', fileIds: [] }],
      ['POST', '/documents', { role: 'other', fileIds: [randomUUID()] }],
      ['POST', '/documents', { role: 'bid', fileIds: ['x'] }],
      ['POST', '/documents', { role: 'bid', fileIds: Array.from({ length: 51 }, () => randomUUID()) }],
      ['PATCH', '/ui-state', {}],
      ['PATCH', '/ui-state', { step: 'done' }],
      ['PATCH', '/ui-state', { activeDocumentTab: '' }],
      ['PATCH', '/ui-state', { customCheckItems: 'x'.repeat(100_001) }],
      ['PATCH', '/ui-state', { checkOptions: { other: true } }],
      ['PATCH', '/ui-state', { step: 'items', signature: 'x' }],
      ['PATCH', '/results/typo', {}],
      ['PATCH', '/results/typo', { activeFindingId: 'x'.repeat(201) }],
      ['PATCH', '/results/other', { activeFindingId: null }],
    ] as const) {
      await expectError(await call(a, method, rc(projectId, path), body), 400, 'BAD_REQUEST');
    }
    await expectError(await call(a, 'DELETE', rc(projectId, '/documents/not-a-uuid')), 400, 'BAD_REQUEST');
    await expectError(await call(a, 'DELETE', rc(projectId, '/results/other/findings/x')), 400, 'BAD_REQUEST');
    const fileId = await newFile(a);
    await expectError(await call(a, 'POST', rc(projectId, '/documents'), { role: 'bid', fileIds: [fileId, fileId] }), 400, 'REJECTION_CHECK_FILE_UNAVAILABLE');
    await expectError(await call(a, 'POST', rc(projectId, '/documents'), { role: 'bid', fileIds: [await newFile(b)] }), 400, 'REJECTION_CHECK_FILE_UNAVAILABLE');
  });

  it('导出：没有当前结果时 409；有结果时生成与桌面版结构相同的工作簿，失效的结果不导出，公式前缀写成文本', async () => {
    const empty = await newProject(a);
    await expectError(await call(a, 'GET', rc(empty, '/export')), 409, 'REJECTION_CHECK_NOTHING_TO_EXPORT');

    const filled = await fillProject(a);
    // 逻辑问题的签名与当前投标文件不一致：标为“结果已失效”，不导出其内容。
    await saveCheckResult(appDb, a.context, filled.projectId, 'logic', { inputSignature: 'stale' });
    const response = await call(a, 'GET', rc(filled.projectId, '/export'));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['cache-control']).toBe('no-store');
    const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(String(response.headers['content-disposition']))![1]!);
    expect(fileName).toMatch(/^废标检查结果_\d{8}_\d{6}\.xlsx$/);

    const { sheets } = readWorkbook(response.rawPayload);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['检查概览', '废标项', '错别字', '逻辑问题']);
    const [overview, risk, typo, logic] = sheets as [any, any, any, any];
    expect(overview.rows[2]).toEqual(['检查类型', '状态', '问题数量', '更新时间', '检查对象', '说明']);
    expect(overview.rows[3]).toEqual(['废标项检查', '已完成', 2, expect.any(String), '投标A.docx；投标B.docx', '发现 2 个风险项']);
    expect(overview.rows[4].slice(0, 3)).toEqual(['错别字检查', '已完成', 1]);
    expect(overview.rows[5]).toEqual(['逻辑问题检查', '结果已失效', 0, expect.any(String), '投标A.docx；投标B.docx', '结果签名与当前检查输入不一致']);
    expect(risk.rows[0]).toEqual(['序号', '投标文件序号', '投标文件名', '类型', '风险等级', '标题', '摘要', '招标要求', '投标证据', '风险原因', '修改建议']);
    expect(risk.rows[1]).toEqual([1, 1, '投标A.docx', '无效标', '高风险', '未盖章', '投标函未盖章', '须加盖公章', '无', '无效标', '补盖']);
    expect(risk.rows[2].slice(0, 6)).toEqual([2, 2, '投标B.docx', '废标项', '中风险', '=HYPERLINK("http://x")']);
    // 以 = 开头的文本写成内联字符串并套用 quotePrefix（样式 2），不会被当作公式。
    expect(risk.cells.get('F3').style).toBe(2);
    expect(risk.xml).not.toContain('<f>');
    expect(risk.autoFilter).toBe('A1:K3');
    expect(typo.rows[1]).toEqual([1, 2, '投标B.docx', '帐号', '账号', '第 3 页', '请填写帐号', '用字不规范']);
    expect(logic.rows).toEqual([['序号', '投标文件序号', '投标文件名', '标题', '位置', '原文', '问题原因', '修改建议']]);

    // 其他组织不能导出。
    await expectError(await call(b, 'GET', rc(filled.projectId, '/export')), 404, 'PROJECT_NOT_FOUND');
  });
});
