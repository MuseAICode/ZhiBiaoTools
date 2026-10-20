// 知识库（二）（迁移 0013_knowledge_base_items）的数据库与接口测试：七张表的隔离模板（describeProjectTable，组织级），
// 删除可见性与写权限由 RLS 强制（绕过 Store 直接写库同样被拒绝），给解析任务用的读写函数，以及检索、条目、分析、
// Markdown 接口。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { KNOWLEDGE_CONTENT_TABLES, KNOWLEDGE_KEY_MAX, KNOWLEDGE_TITLE_MAX } from '../../src/db/migrations/0013_knowledge_base_items.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import {
  clearMatchBatches,
  contentCharCount,
  getMatchBatch,
  readBlocks,
  readCandidateItems,
  readItems,
  readMatchBatches,
  saveBlocks,
  saveCandidateItems,
  saveMatchBatch,
  saveMatchResult,
  streamContentCharCount,
} from '../../src/knowledgeBase/content.ts';
import { clearDocumentProcessingFromStep, getDocument, setDocumentMarkdown, updateDocumentState } from '../../src/knowledgeBase/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable, withTenantAny, type ProjectRowScope } from './projectTable.ts';

const PASSWORD = 'quiet-harbor-maple-58';
const MARKDOWN = 'text/markdown; charset=utf-8';

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
let noStorageApp: FastifyInstance;
const objects = new Map<string, Buffer>();

const memoryStore: ObjectStore = {
  async put(key, body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
  },
  async get(key) {
    const content = objects.get(key);
    // 小块输出，覆盖多字节字符跨块的情况。
    return content ? { body: Readable.from(chunked(content, 7)), size: content.length } : null;
  },
  async exists(key) {
    return objects.has(key);
  },
  async delete(key) {
    objects.delete(key);
  },
};

function* chunked(buffer: Buffer, size: number) {
  for (let start = 0; start < buffer.length; start += size) yield buffer.subarray(start, start + size);
}

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

/** 用超级用户直接登记一个已上传的知识库文件。 */
async function newFile(member: Pick<Member, 'orgId' | 'userId'>, name = '投标技术方案.docx'): Promise<string> {
  const row = await superuser
    .insertInto('files')
    .values({
      org_id: member.orgId,
      purpose: 'knowledge',
      display_name: name,
      extension: 'docx',
      status: 'uploaded',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size_bytes: 100,
      sha256: Buffer.alloc(32),
      uploaded_at: new Date(),
      created_by: member.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** 用超级用户建文件夹和挂文档（不经 RLS），返回 { folderId, documentId, fileId }。 */
async function seedDocument(member: Pick<Member, 'orgId' | 'userId'>, options: { folderId?: string; name?: string } = {}) {
  const folderId =
    options.folderId ??
    (
      await superuser
        .insertInto('knowledge_folders')
        .values({ org_id: member.orgId, name: '文件夹', created_by: member.userId, updated_by: member.userId })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const fileId = await newFile(member, options.name);
  const document = await superuser
    .insertInto('knowledge_documents')
    .values({ org_id: member.orgId, folder_id: folderId, file_id: fileId, created_by: member.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { folderId: folderId as string, documentId: document.id as string, fileId };
}

/** 把 markdown 写进内存对象存储，登记为文档原件的 Markdown 产物并挂到文档上。 */
async function attachMarkdown(member: Member, documentId: string, fileId: string, markdown: string): Promise<string> {
  const content = Buffer.from(markdown, 'utf8');
  const row = await superuser
    .insertInto('artifacts')
    .values({
      org_id: member.orgId,
      source_file_id: fileId,
      kind: 'markdown',
      name: 'content.md',
      mime: MARKDOWN,
      status: 'ready',
      size_bytes: content.length,
      sha256: Buffer.alloc(32),
      completed_at: new Date(),
      created_by: member.userId,
    })
    .returning(['id', 'storage_key'])
    .executeTakeFirstOrThrow();
  objects.set(row.storage_key, content);
  await setDocumentMarkdown(appDb, member.context, documentId, row.id);
  return row.id;
}

/** 在当前上下文中经应用角色建文件夹、上传知识库文件并挂成文档（隔离模板用：组织不对时在这一步就被 RLS 拒绝）。 */
async function documentInContext(trx: Transaction<any>, scope: ProjectRowScope): Promise<string> {
  const folder = await trx
    .insertInto('knowledge_folders')
    .values({ org_id: scope.orgId, name: '文件夹', created_by: scope.userId, updated_by: scope.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  const file = await trx
    .insertInto('files')
    .values({ org_id: scope.orgId, purpose: 'knowledge', display_name: 'a.docx', extension: 'docx', created_by: scope.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.updateTable('files').set({ status: 'uploaded', mime: 'application/zip', size_bytes: 10, sha256: Buffer.alloc(32) }).where('id', '=', file.id).execute();
  const row = await trx
    .insertInto('knowledge_documents')
    .values({ org_id: scope.orgId, folder_id: folder.id, file_id: file.id, created_by: scope.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** 每张表的一行（经应用角色在给定上下文中写入）。返回模板用的主键值。 */
const ROW_WRITERS: Record<(typeof KNOWLEDGE_CONTENT_TABLES)[number], (trx: Transaction<any>, orgId: string, documentId: string) => Promise<string>> = {
  async knowledge_blocks(trx, orgId, documentId) {
    const row = await trx
      .insertInto('knowledge_blocks')
      .values({ org_id: orgId, document_id: documentId, block_id: 'P000001', type: 'paragraph', content: '正文' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async knowledge_candidate_items(trx, orgId, documentId) {
    const row = await trx
      .insertInto('knowledge_candidate_items')
      .values({ org_id: orgId, document_id: documentId, item_id: 'K000001', title: '标题', summary: '摘要' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async knowledge_items(trx, orgId, documentId) {
    const row = await trx
      .insertInto('knowledge_items')
      .values({ org_id: orgId, document_id: documentId, item_id: 'K000001', title: '标题', resume: '摘要', content: '正文' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async knowledge_item_blocks(trx, orgId, documentId) {
    await ROW_WRITERS.knowledge_items(trx, orgId, documentId);
    await trx.insertInto('knowledge_item_blocks').values({ org_id: orgId, document_id: documentId, item_id: 'K000001', block_id: 'P000001' }).execute();
    return documentId;
  },
  async knowledge_discarded_groups(trx, orgId, documentId) {
    const row = await trx
      .insertInto('knowledge_discarded_groups')
      .values({ org_id: orgId, document_id: documentId, source: 'ai', reason: '无关', block_ids: '["P000002"]' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async knowledge_reports(trx, orgId, documentId) {
    await trx.insertInto('knowledge_reports').values({ org_id: orgId, document_id: documentId, total_blocks: 3 }).execute();
    return documentId;
  },
  async knowledge_match_batches(trx, orgId, documentId) {
    await trx.insertInto('knowledge_match_batches').values({ org_id: orgId, document_id: documentId, batch_index: 0 }).execute();
    return documentId;
  },
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function call(member: Member | null, method: Method, url: string, payload?: object, instance = app) {
  return instance.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}) },
    ...(payload ? { payload } : {}),
  });
}

const kb = (member: Member | null, url: string, instance = app) => call(member, 'GET', `/api/knowledge-base${url}`, undefined, instance);

async function ok(member: Member, url: string) {
  const response = await kb(member, url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error.code).toBe(code);
}

const softDeleteFile = (fileId: string, userId: string) =>
  superuser.updateTable('files').set({ deleted_at: new Date(), deleted_by: userId }).where('id', '=', fileId).execute();
const restoreFile = (fileId: string) => superuser.updateTable('files').set({ deleted_at: null, deleted_by: null }).where('id', '=', fileId).execute();

/** 每张表在超级用户下的行数。 */
async function rowCounts(documentId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of KNOWLEDGE_CONTENT_TABLES) {
    const row = await superuser
      .selectFrom(table)
      .select((eb: any) => eb.fn.countAll().as('n'))
      .where('document_id', '=', documentId)
      .executeTakeFirstOrThrow();
    counts[table] = Number((row as { n: string }).n);
  }
  return counts;
}

/** 经 Store 写满一个文档的七张表。 */
async function fillDocument(member: Member, documentId: string): Promise<void> {
  await saveBlocks(
    appDb,
    member.context,
    documentId,
    [
      { id: 'P1', content: '第一段 内容' },
      { id: 'P2', content: '第二段' },
    ],
    [{ id: 'F1', content: '目录', reason: '目录' }],
  );
  await saveMatchResult(appDb, member.context, documentId, {
    candidateItems: [{ id: 'K1', title: '候选', summary: '摘要' }],
    finalItems: [{ id: 'K1', title: '条目', resume: '摘要', content: '正文', sourceBlockIds: ['P1'] }],
    discarded: [{ blockIds: ['P2'], reason: '无关' }],
    report: { totalBlocks: 2 },
  });
  await saveMatchBatch(appDb, member.context, documentId, 1, { status: 'success', itemIds: { block_ids: ['P1'], item_ids: ['K1'] }, matches: [] });
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
  const options = { database, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} } };
  app = await buildApp({ ...testConfig, database: testDb.appConfig }, { ...options, objectStore: memoryStore });
  noStorageApp = await buildApp({ ...testConfig, database: testDb.appConfig }, { ...options, objectStore: null });
});

afterAll(async () => {
  await app?.close();
  await noStorageApp?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('隔离模板', () => {
  const env = { admin: () => superuser, app: () => appDb };
  const ids: Record<string, string> = {
    knowledge_item_blocks: 'document_id',
    knowledge_reports: 'document_id',
    knowledge_match_batches: 'document_id',
  };

  for (const table of KNOWLEDGE_CONTENT_TABLES) {
    describeProjectTable(
      {
        table,
        idColumn: ids[table] ?? 'id',
        scope: 'org',
        async insert(trx, scope) {
          const documentId = await documentInContext(trx, scope);
          return ROW_WRITERS[table](trx, scope.orgId, documentId);
        },
        // 只有匹配批次按批更新；其余六张表整体替换，不授予 UPDATE。
        ...(table === 'knowledge_match_batches' ? { update: { status: 'idle' } } : {}),
      },
      env,
    );
  }
});

describe('删除可见性与写权限由 RLS 强制', () => {
  let a: Member;
  let peer: Member;
  let b: Member;

  beforeAll(async () => {
    a = await newMember();
    peer = await newMember(a.orgId);
    b = await newMember();
  });

  it('组织内其他成员可以读写同一个文档的结果（组织内共享）', async () => {
    const { documentId } = await seedDocument(a);
    await fillDocument(peer, documentId);
    expect(await readItems(appDb, a.context, documentId)).toMatchObject([{ id: 'K1' }]);
  });

  it('原件删除后七张表都查不到、改不了、删不掉，也不能新写；恢复文件即一起恢复', async () => {
    const member = await newMember();
    const { documentId, fileId } = await seedDocument(member);
    await fillDocument(member, documentId);
    const visible = () =>
      withTenantAny(appDb, member.context, async (trx) => {
        const result: Record<string, number> = {};
        for (const table of KNOWLEDGE_CONTENT_TABLES) result[table] = (await trx.selectFrom(table).select('document_id').execute()).length;
        return result;
      });
    const before = await visible();
    expect(Object.values(before).every((n) => n > 0)).toBe(true);

    await softDeleteFile(fileId, member.userId);
    expect(Object.values(await visible())).toEqual(KNOWLEDGE_CONTENT_TABLES.map(() => 0));
    await withTenantAny(appDb, member.context, async (trx) => {
      expect((await trx.updateTable('knowledge_match_batches').set({ status: 'idle' }).executeTakeFirst()).numUpdatedRows).toBe(0n);
      for (const table of KNOWLEDGE_CONTENT_TABLES) {
        expect((await trx.deleteFrom(table).executeTakeFirst()).numDeletedRows, table).toBe(0n);
      }
    });
    for (const table of KNOWLEDGE_CONTENT_TABLES) {
      await expect(
        withTenantAny(appDb, member.context, (trx) => ROW_WRITERS[table](trx, member.orgId, documentId)),
        table,
      ).rejects.toThrow(/row-level security/);
    }
    // 经 Store 同样 404。
    await expect(readItems(appDb, member.context, documentId)).rejects.toMatchObject({ code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND' });
    await expect(saveBlocks(appDb, member.context, documentId, [], [])).rejects.toMatchObject({ code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND' });

    await restoreFile(fileId);
    expect(await visible()).toEqual(before);
  });

  it('删除文件夹或物理删除原件时，七张表的行随文档级联删除', async () => {
    const member = await newMember();
    const first = await seedDocument(member);
    const second = await seedDocument(member);
    await fillDocument(member, first.documentId);
    await fillDocument(member, second.documentId);

    await withTenant(appDb, member.context, (trx) => trx.deleteFrom('knowledge_folders').where('id', '=', first.folderId).execute());
    expect(Object.values(await rowCounts(first.documentId))).toEqual(KNOWLEDGE_CONTENT_TABLES.map(() => 0));

    await superuser.deleteFrom('files').where('id', '=', second.fileId).execute();
    expect(Object.values(await rowCounts(second.documentId))).toEqual(KNOWLEDGE_CONTENT_TABLES.map(() => 0));
  });

  it('不能挂到其他组织的文档上（复合外键）；匹配批次的组织、文档和序号写入后不能改', async () => {
    const { documentId } = await seedDocument(a);
    const other = await seedDocument(b);
    for (const table of KNOWLEDGE_CONTENT_TABLES) {
      await expect(
        withTenantAny(appDb, a.context, (trx) => ROW_WRITERS[table](trx, a.orgId, other.documentId)),
        table,
      ).rejects.toThrow(/row-level security|foreign key/);
    }
    await withTenantAny(appDb, a.context, (trx) => ROW_WRITERS.knowledge_match_batches(trx, a.orgId, documentId));
    for (const values of [{ org_id: b.orgId }, { document_id: other.documentId }, { batch_index: 3 }]) {
      await expect(
        withTenantAny(appDb, a.context, (trx) => trx.updateTable('knowledge_match_batches').set(values).where('document_id', '=', documentId).execute()),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('条目的来源块只能指向本文档已有的条目，随条目删除', async () => {
    const { documentId } = await seedDocument(a);
    const other = await seedDocument(a);
    await withTenantAny(appDb, a.context, (trx) => ROW_WRITERS.knowledge_items(trx, a.orgId, documentId));
    const insertBlock = (document: string, itemId: string) =>
      withTenantAny(appDb, a.context, (trx) =>
        trx.insertInto('knowledge_item_blocks').values({ org_id: a.orgId, document_id: document, item_id: itemId, block_id: 'P1' }).execute(),
      );
    await expect(insertBlock(documentId, 'K404')).rejects.toThrow(/knowledge_item_blocks_item_fkey/);
    await expect(insertBlock(other.documentId, 'K000001')).rejects.toThrow(/knowledge_item_blocks_item_fkey/);
    await insertBlock(documentId, 'K000001');
    await withTenantAny(appDb, a.context, (trx) => trx.deleteFrom('knowledge_items').where('document_id', '=', documentId).execute());
    expect(await superuser.selectFrom('knowledge_item_blocks').select('block_id').where('document_id', '=', documentId).execute()).toEqual([]);
  });

  it('CHECK 约束：id 长度、筛除原因只属于筛除块、舍弃来源、比率、标题路径与指纹的 JSON 类型、批次状态与时间', async () => {
    const { documentId } = await seedDocument(a);
    const insert = (table: string, values: Record<string, unknown>) =>
      withTenantAny(appDb, a.context, (trx) => trx.insertInto(table).values({ org_id: a.orgId, document_id: documentId, ...values }).execute());
    const block = { block_id: 'P1', type: 'paragraph', content: '' };
    await expect(insert('knowledge_blocks', { ...block, block_id: '' })).rejects.toThrow(/knowledge_blocks_block_id_check/);
    await expect(insert('knowledge_blocks', { ...block, block_id: 'P'.repeat(KNOWLEDGE_KEY_MAX + 1) })).rejects.toThrow(/knowledge_blocks_block_id_check/);
    await expect(insert('knowledge_blocks', { ...block, filter_reason: '目录' })).rejects.toThrow(/knowledge_blocks_filter_reason_shape/);
    await expect(insert('knowledge_blocks', { ...block, heading_path: '{"a":1}' })).rejects.toThrow(/knowledge_blocks_heading_path_check/);
    await insert('knowledge_blocks', { ...block, is_filtered: true, filter_reason: '目录' });
    await insert('knowledge_blocks', block);
    await expect(insert('knowledge_blocks', block)).rejects.toThrow(/knowledge_blocks_block_key/);

    await expect(insert('knowledge_discarded_groups', { source: 'user', reason: 'x' })).rejects.toThrow(/knowledge_discarded_groups_source_check/);
    await expect(insert('knowledge_discarded_groups', { source: 'ai', reason: 'x', block_ids: '"P1"' })).rejects.toThrow(
      /knowledge_discarded_groups_block_ids_check/,
    );
    for (const value of ['NaN', 'Infinity', '-0.5']) {
      await expect(insert('knowledge_reports', { coverage_rate: value })).rejects.toThrow(/knowledge_reports_coverage_rate_check/);
    }

    const now = new Date();
    await expect(insert('knowledge_match_batches', { batch_index: 0, status: 'running' })).rejects.toThrow(/knowledge_match_batches_status_shape/);
    await expect(insert('knowledge_match_batches', { batch_index: 0, status: 'error', started_at: now, completed_at: now })).rejects.toThrow(
      /knowledge_match_batches_status_shape/,
    );
    await expect(insert('knowledge_match_batches', { batch_index: 0, item_ids: '"x"' })).rejects.toThrow(/knowledge_match_batches_item_ids_check/);
    await expect(insert('knowledge_match_batches', { batch_index: 0, matches: '{}' })).rejects.toThrow(/knowledge_match_batches_matches_check/);
    await expect(insert('knowledge_match_batches', { batch_index: -1 })).rejects.toThrow(/knowledge_match_batches_batch_index_check/);
  });
});

describe('给解析任务用的读写函数', () => {
  let member: Member;

  beforeAll(async () => {
    member = await newMember();
  });

  it('contentCharCount / streamContentCharCount：去掉空白后的字数，流式统计与整体统计一致', async () => {
    const text = ' 第一段\n\n  第二 段 😀 a\tb\r\n';
    expect(contentCharCount(text)).toBe(text.replace(/\s+/g, '').length);
    expect(await streamContentCharCount(Readable.from(chunked(Buffer.from(text), 3)))).toBe(contentCharCount(text));
  });

  it('saveBlocks / readBlocks：整体替换，默认 id 与类型，计数写到文档上，去掉 \\u0000；id 重复抛 TypeError', async () => {
    const { documentId } = await seedDocument(member);
    await saveBlocks(
      appDb,
      member.context,
      documentId,
      [{ content: '第一 段', headingPath: ['一、', '（一）\u0000'] }, { id: 'X', type: 'table', content: '| a |\u0000' }],
      [{ content: '目录', reason: '目录页' }],
    );
    expect(await readBlocks(appDb, member.context, documentId)).toEqual([
      { id: 'P000001', type: 'paragraph', headingPath: ['一、', '（一）'], content: '第一 段' },
      { id: 'X', type: 'table', headingPath: [], content: '| a |' },
    ]);
    expect(await readBlocks(appDb, member.context, documentId, { filtered: true })).toEqual([
      { id: 'F000001', type: 'paragraph', headingPath: [], content: '目录', reason: '目录页' },
    ]);
    expect(await getDocument(appDb, member.context, documentId)).toMatchObject({ blockCount: 2, filteredBlockCount: 1 });
    expect(
      await superuser.selectFrom('knowledge_blocks').select(['block_id', 'content_chars']).where('document_id', '=', documentId).orderBy('block_id').execute(),
    ).toEqual([
      { block_id: 'F000001', content_chars: 2 },
      { block_id: 'P000001', content_chars: 3 },
      { block_id: 'X', content_chars: 3 },
    ]);

    await saveBlocks(appDb, member.context, documentId, [{ id: 'P9', content: '新' }], []);
    expect((await readBlocks(appDb, member.context, documentId)).map((block) => block.id)).toEqual(['P9']);
    expect(await getDocument(appDb, member.context, documentId)).toMatchObject({ blockCount: 1, filteredBlockCount: 0 });

    await expect(saveBlocks(appDb, member.context, documentId, [{ id: 'A' }, { id: 'A' }], [])).rejects.toBeInstanceOf(TypeError);
    await expect(saveBlocks(appDb, member.context, documentId, [{ id: 'x'.repeat(KNOWLEDGE_KEY_MAX + 1) }], [])).rejects.toBeInstanceOf(TypeError);
    // 有效块和筛除块的 id 各自唯一（与桌面版相同）。
    await saveBlocks(appDb, member.context, documentId, [{ id: 'A' }], [{ id: 'A' }]);
  });

  it('saveCandidateItems / readCandidateItems：跳过没有 id 的，标题超长截短，计数写到文档上；id 重复抛 TypeError', async () => {
    const { documentId } = await seedDocument(member);
    await saveCandidateItems(
      appDb,
      member.context,
      documentId,
      [{ id: 'K1', title: '标'.repeat(KNOWLEDGE_TITLE_MAX + 3), summary: '摘要' }, { title: '没有 id' }, { id: 'K2', source: 'supplement' }],
      'first',
    );
    const items = await readCandidateItems(appDb, member.context, documentId);
    expect(items.map((item) => item.id)).toEqual(['K1', 'K2']);
    expect([...items[0]!.title]).toHaveLength(KNOWLEDGE_TITLE_MAX);
    expect(
      await superuser.selectFrom('knowledge_candidate_items').select(['item_id', 'source']).where('document_id', '=', documentId).orderBy('sort_order').execute(),
    ).toEqual([
      { item_id: 'K1', source: 'first' },
      { item_id: 'K2', source: 'supplement' },
    ]);
    // 与桌面版相同，计数按传入的条数。
    expect(await getDocument(appDb, member.context, documentId)).toMatchObject({ candidateItemCount: 3 });
    await expect(saveCandidateItems(appDb, member.context, documentId, [{ id: 'K1' }, { id: 'K1' }])).rejects.toBeInstanceOf(TypeError);
  });

  it('saveMatchResult：整体替换候选条目、最终条目及来源块、舍弃块组和报告，写入文档计数；再次保存时替换，没有报告时删除', async () => {
    const { documentId } = await seedDocument(member);
    await saveMatchResult(appDb, member.context, documentId, {
      candidateItems: [{ id: 'K1', title: '候选一', summary: 's' }, { id: 'K2', title: '候选二', summary: 's' }],
      finalItems: [
        { id: 'K1', title: '条目一', resume: '摘要', content: '正文 一', sourceBlockIds: ['P2', 'P1', 'P2'], sourceFile: '原件.docx' },
        { title: '没有 id 的跳过' },
        { id: 'K2', title: '条目二', resume: '', content: '' },
      ],
      discarded: [{ blockIds: ['P3'], reason: '' }],
      systemDiscardedAfterRetry: [{ blockIds: ['P4', 'P5'] }],
      report: { totalBlocks: 5, discardedBlocksCount: 1, systemDiscardedAfterRetryCount: 2, coverageRate: 0.8, matchedRate: Number.NaN },
    });
    expect(await readItems(appDb, member.context, documentId)).toEqual([
      { id: 'K1', title: '条目一', resume: '摘要', content: '正文 一', sourceBlockIds: ['P2', 'P1'], sourceFile: '原件.docx' },
      { id: 'K2', title: '条目二', resume: '', content: '', sourceBlockIds: [], sourceFile: null },
    ]);
    expect(
      await superuser.selectFrom('knowledge_candidate_items').select('source').distinct().where('document_id', '=', documentId).execute(),
    ).toEqual([{ source: 'merged' }]);
    expect(
      await superuser
        .selectFrom('knowledge_discarded_groups')
        .select(['source', 'reason', 'block_ids'])
        .where('document_id', '=', documentId)
        .orderBy('sort_order')
        .execute(),
    ).toEqual([
      { source: 'ai', reason: 'AI 建议舍弃', block_ids: ['P3'] },
      { source: 'system', reason: 'system_discarded_after_retry', block_ids: ['P4', 'P5'] },
    ]);
    expect(
      await superuser.selectFrom('knowledge_reports').select(['total_blocks', 'batch_size', 'coverage_rate', 'matched_rate']).where('document_id', '=', documentId).execute(),
    ).toEqual([{ total_blocks: 5, batch_size: 20, coverage_rate: 0.8, matched_rate: 0 }]);
    expect(await getDocument(appDb, member.context, documentId)).toMatchObject({
      itemCount: 3,
      candidateItemCount: 2,
      discardedBlockCount: 1,
      systemDiscardedAfterRetryCount: 2,
    });

    await saveMatchResult(appDb, member.context, documentId, { candidateItems: [], finalItems: [{ id: 'K9', sourceBlockIds: ['P1'] }], report: null });
    expect((await readItems(appDb, member.context, documentId)).map((item) => [item.id, item.sourceBlockIds])).toEqual([['K9', ['P1']]]);
    expect(await rowCounts(documentId)).toMatchObject({
      knowledge_candidate_items: 0,
      knowledge_item_blocks: 1,
      knowledge_discarded_groups: 0,
      knowledge_reports: 0,
    });
    expect(await getDocument(appDb, member.context, documentId)).toMatchObject({ itemCount: 1, discardedBlockCount: 0 });

    await expect(
      saveMatchResult(appDb, member.context, documentId, { candidateItems: [], finalItems: [{ id: 'K1' }, { id: 'K1' }] }),
    ).rejects.toBeInstanceOf(TypeError);
    // 失败时整个事务回滚，原结果不变。
    expect((await readItems(appDb, member.context, documentId)).map((item) => item.id)).toEqual(['K9']);
  });

  it('saveMatchBatch：时间与错误的规则与桌面版相同，没有给出指纹和结果时保留原值；按序号读取、清除', async () => {
    const { documentId } = await seedDocument(member);
    const fingerprint = { block_ids: ['P1'], item_ids: ['K1'] };
    const running = await saveMatchBatch(appDb, member.context, documentId, 2, { status: 'running', itemIds: fingerprint, matches: [] });
    expect(running).toMatchObject({ batchIndex: 2, status: 'running', itemIds: fingerprint, matches: [], error: null, completedAt: null });
    expect(running.startedAt).toBeInstanceOf(Date);

    const failed = await saveMatchBatch(appDb, member.context, documentId, 2, { status: 'error', itemIds: fingerprint });
    expect(failed).toMatchObject({ status: 'error', error: '处理失败', startedAt: running.startedAt, matches: [] });
    expect(failed.completedAt).toBeInstanceOf(Date);

    const matches = [{ id: 'K1', ranges: [['P1', 'P1']], block_ids: ['P1'] }];
    const success = await saveMatchBatch(appDb, member.context, documentId, 2, { status: 'success', matches });
    expect(success).toMatchObject({ status: 'success', error: null, itemIds: fingerprint, matches });
    await saveMatchBatch(appDb, member.context, documentId, 0, { status: 'idle' });

    expect(await getMatchBatch(appDb, member.context, documentId, 1)).toBeNull();
    expect(await getMatchBatch(appDb, member.context, documentId, 0)).toMatchObject({ status: 'idle', itemIds: [], matches: [], startedAt: null });
    expect((await readMatchBatches(appDb, member.context, documentId)).map((batch) => batch.batchIndex)).toEqual([0, 2]);
    await expect(saveMatchBatch(appDb, member.context, documentId, -1, { status: 'idle' })).rejects.toBeInstanceOf(TypeError);
    await expect(saveMatchBatch(appDb, member.context, documentId, 0, { status: 'idle', itemIds: 'x' })).rejects.toBeInstanceOf(TypeError);

    await clearMatchBatches(appDb, member.context, documentId);
    expect(await readMatchBatches(appDb, member.context, documentId)).toEqual([]);
  });

  it('clearDocumentProcessingFromStep：按起始步骤清除切块、候选条目、匹配批次和最终结果', async () => {
    const { documentId } = await seedDocument(member);
    await fillDocument(member, documentId);
    const all = { knowledge_blocks: 3, knowledge_candidate_items: 1, knowledge_items: 1, knowledge_item_blocks: 1, knowledge_discarded_groups: 1, knowledge_reports: 1, knowledge_match_batches: 1 };
    expect(await rowCounts(documentId)).toEqual(all);

    await clearDocumentProcessingFromStep(appDb, member.context, documentId, 'save_result');
    expect(await rowCounts(documentId)).toEqual({ ...all, knowledge_items: 0, knowledge_item_blocks: 0, knowledge_discarded_groups: 0, knowledge_reports: 0 });

    await fillDocument(member, documentId);
    await clearDocumentProcessingFromStep(appDb, member.context, documentId, 'match_batches');
    expect(await rowCounts(documentId)).toMatchObject({ knowledge_blocks: 3, knowledge_candidate_items: 1, knowledge_match_batches: 0, knowledge_items: 0 });

    await fillDocument(member, documentId);
    await clearDocumentProcessingFromStep(appDb, member.context, documentId, 'merge_candidates');
    expect(await rowCounts(documentId)).toMatchObject({ knowledge_blocks: 3, knowledge_candidate_items: 0, knowledge_match_batches: 0 });

    await fillDocument(member, documentId);
    const document = await clearDocumentProcessingFromStep(appDb, member.context, documentId, 'build_blocks');
    expect(Object.values(await rowCounts(documentId))).toEqual(KNOWLEDGE_CONTENT_TABLES.map(() => 0));
    expect(document).toMatchObject({ blockCount: 0, filteredBlockCount: 0, candidateItemCount: 0, itemCount: 0 });
  });

  it('文档不可见（其他组织）时一律 404', async () => {
    const { documentId } = await seedDocument(member);
    const other = await newMember();
    const notFound = { code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND' };
    await expect(saveBlocks(appDb, other.context, documentId, [], [])).rejects.toMatchObject(notFound);
    await expect(saveCandidateItems(appDb, other.context, documentId, [])).rejects.toMatchObject(notFound);
    await expect(saveMatchResult(appDb, other.context, documentId, { candidateItems: [], finalItems: [] })).rejects.toMatchObject(notFound);
    await expect(saveMatchBatch(appDb, other.context, documentId, 0, { status: 'idle' })).rejects.toMatchObject(notFound);
    await expect(readBlocks(appDb, other.context, documentId)).rejects.toMatchObject(notFound);
    await expect(readMatchBatches(appDb, other.context, documentId)).rejects.toMatchObject(notFound);
    await expect(clearMatchBatches(appDb, other.context, documentId)).rejects.toMatchObject(notFound);
  });
});

describe('/api/knowledge-base 检索与读取', () => {
  let a: Member;
  let b: Member;

  /** 建一个已处理完成的文档，写入给出的最终条目。 */
  async function readyDocument(member: Member, name: string, items: { id: string; title: string; resume?: string; content?: string }[], folderId?: string) {
    const seeded = await seedDocument(member, { name, ...(folderId ? { folderId } : {}) });
    await saveMatchResult(appDb, member.context, seeded.documentId, { candidateItems: [], finalItems: items });
    await updateDocumentState(appDb, member.context, seeded.documentId, { status: 'success', progress: 100 });
    return seeded;
  }

  beforeAll(async () => {
    a = await newMember();
    b = await newMember();
  });

  it('需要登录；响应不缓存；关键词为空返回空结果；关键词超长 400', async () => {
    await expectError(await kb(null, '/search?keyword=x'), 401, 'UNAUTHORIZED');
    const response = await kb(a, '/search?keyword=%20%20');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ items: [], total: 0, page: 1, pageSize: 100 });
    await expectError(await kb(a, `/search?keyword=${'字'.repeat(201)}`), 400, 'KNOWLEDGE_INVALID');
    await expectError(await kb(a, '/search'), 400, 'BAD_REQUEST');
    await expectError(await kb(a, '/search?keyword=x&page=0'), 400, 'BAD_REQUEST');
  });

  it('按标题 → 摘要 → 正文 → 文件名排序，不区分大小写；只检索已完成的文档；其他组织、原件已删除的不出现', async () => {
    const member = await newMember();
    const done = await readyDocument(member, '施工组织设计.docx', [
      { id: 'K1', title: '质量保证', resume: '', content: '本节说明 BIM 应用' },
      { id: 'K2', title: '安全', resume: '基于 bim 的安全管理', content: '' },
      { id: 'K3', title: 'BIM 技术路线', resume: '', content: '' },
    ]);
    await readyDocument(member, 'BIM 专篇.pdf', [{ id: 'K1', title: '概述', resume: '', content: '' }]);
    const pending = await seedDocument(member, { name: 'BIM 未完成.docx' });
    await saveMatchResult(appDb, member.context, pending.documentId, { candidateItems: [], finalItems: [{ id: 'K1', title: 'BIM' }] });
    await readyDocument(b, 'BIM.docx', [{ id: 'K1', title: 'BIM' }]);

    const result = await ok(member, '/search?keyword=bim');
    expect(result).toMatchObject({ total: 4, page: 1, pageSize: 100 });
    expect(result.items.map((item: { matchField: string; title: string }) => [item.matchField, item.title])).toEqual([
      ['title', 'BIM 技术路线'],
      ['resume', '安全'],
      ['content', '质量保证'],
      ['file_name', '概述'],
    ]);
    expect(result.items[0]).toEqual({
      documentId: done.documentId,
      folderId: done.folderId,
      folderName: '文件夹',
      fileName: '施工组织设计.docx',
      itemId: 'K3',
      title: 'BIM 技术路线',
      resume: '',
      snippet: 'BIM 技术路线',
      matchField: 'title',
    });

    await softDeleteFile(done.fileId, member.userId);
    expect((await ok(member, '/search?keyword=bim')).total).toBe(1);
    await restoreFile(done.fileId);
  });

  it('% 和 _ 按字面匹配；正文命中时摘录命中位置附近一段，前后截掉时加省略号', async () => {
    const member = await newMember();
    const long = `${'前'.repeat(3000)}  命中 100%_达标\n\n${'后'.repeat(3000)}`;
    await readyDocument(member, 'a.docx', [
      { id: 'K1', title: '正文', content: long },
      { id: 'K2', title: '百分号', content: '100 percent' },
    ]);
    const result = await ok(member, `/search?keyword=${encodeURIComponent('100%_')}`);
    expect(result.total).toBe(1);
    const snippetText: string = result.items[0].snippet;
    expect(snippetText.startsWith('…')).toBe(true);
    expect(snippetText.endsWith('…')).toBe(true);
    expect(snippetText).toContain('命中 100%_达标 后');
    expect([...snippetText]).toHaveLength(180 + 2);
  });

  it('分页：每页 100 条，页码超出时取最后一页', async () => {
    const member = await newMember();
    await readyDocument(
      member,
      'a.docx',
      Array.from({ length: 105 }, (_, index) => ({ id: `K${index}`, title: `条目 ${index}` })),
    );
    const first = await ok(member, '/search?keyword=条目');
    expect(first).toMatchObject({ total: 105, page: 1 });
    expect(first.items).toHaveLength(100);
    expect(first.items[0].itemId).toBe('K0');
    const last = await ok(member, '/search?keyword=条目&page=9');
    expect(last).toMatchObject({ total: 105, page: 2 });
    expect(last.items.map((item: { itemId: string }) => item.itemId)).toEqual(['K100', 'K101', 'K102', 'K103', 'K104']);
  });

  it('条目：按顺序返回来源块；其他组织、原件已删除 404', async () => {
    const { documentId, fileId } = await readyDocument(a, 'a.docx', [{ id: 'K1', title: '条目', content: '正文' }]);
    await saveMatchResult(appDb, a.context, documentId, {
      candidateItems: [],
      finalItems: [{ id: 'K1', title: '条目', resume: '摘要', content: '正文', sourceBlockIds: ['P1', 'P2'] }],
    });
    expect(await ok(a, `/documents/${documentId}/items`)).toEqual({
      items: [{ id: 'K1', title: '条目', resume: '摘要', content: '正文', sourceBlockIds: ['P1', 'P2'], sourceFile: null }],
    });
    await expectError(await kb(b, `/documents/${documentId}/items`), 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    await softDeleteFile(fileId, a.userId);
    await expectError(await kb(a, `/documents/${documentId}/items`), 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    await expectError(await kb(a, `/documents/${documentId}/analysis`), 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    await expectError(await kb(a, `/documents/${documentId}/markdown`), 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    await expectError(await kb(a, '/documents/not-a-uuid/items'), 400, 'BAD_REQUEST');
  });

  it('Markdown：附件下载、nosniff、sandbox CSP；还没有解析时为空；其他组织 404', async () => {
    const { documentId, fileId } = await seedDocument(a);
    const empty = await kb(a, `/documents/${documentId}/markdown`);
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.body).toBe('');

    const markdown = '# 标题\n\n<script>alert(1)</script> 正文';
    await attachMarkdown(a, documentId, fileId, markdown);
    const response = await kb(a, `/documents/${documentId}/markdown`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toBe(markdown);
    expect(response.headers).toMatchObject({
      'content-type': MARKDOWN,
      'content-length': String(Buffer.byteLength(markdown)),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
    });
    expect(String(response.headers['content-disposition'])).toMatch(/^attachment;/);
    await expectError(await kb(b, `/documents/${documentId}/markdown`), 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    await expectError(await kb(a, `/documents/${documentId}/markdown`, noStorageApp), 503, 'FILE_STORAGE_DISABLED');
  });

  it('分析：块数、字数、覆盖率、候选条目、报告与舍弃块组；没有 Markdown 时不需要对象存储', async () => {
    const member = await newMember();
    const { documentId, fileId } = await seedDocument(member);
    await saveBlocks(
      appDb,
      member.context,
      documentId,
      [
        { id: 'P1', content: '一二三 四' },
        { id: 'P2', content: '五六' },
        { id: 'P3', content: '七' },
      ],
      [{ id: 'F1', content: '目录', reason: '目录' }],
    );
    await saveMatchResult(appDb, member.context, documentId, {
      candidateItems: [{ id: 'K1', title: '候选', summary: '摘要' }],
      finalItems: [
        { id: 'K1', title: '甲', sourceBlockIds: ['P1', 'P2'] },
        { id: 'K2', title: '乙', sourceBlockIds: ['P1', 'F1'] },
      ],
      discarded: [{ blockIds: ['P3'], reason: '无关' }],
      systemDiscardedAfterRetry: [{ blockIds: ['P9'], reason: '重试后舍弃' }],
      report: { totalBlocks: 3, finalItemsCount: 2, coverageRate: 0.75 },
    });

    const withoutMarkdown = await kb(member, `/documents/${documentId}/analysis`, noStorageApp);
    expect(withoutMarkdown.statusCode, withoutMarkdown.body).toBe(200);
    expect(withoutMarkdown.json()).toMatchObject({ markdownChars: 0, coverageRateVsMarkdown: 0 });

    await attachMarkdown(member, documentId, fileId, '# 一二三 四\n\n五六\n\n七 八九十');
    const analysis = await ok(member, `/documents/${documentId}/analysis`);
    expect(analysis).toMatchObject({
      document: { id: documentId, blockCount: 3, filteredBlockCount: 1 },
      blockCount: 3,
      filteredBlocksCount: 1,
      markdownChars: 11,
      keptBlockChars: 7,
      coveredUniqueContentChars: 6,
      coverageRateVsMarkdown: 0.5455,
      candidateItems: [{ id: 'K1', title: '候选', summary: '摘要' }],
      report: { totalBlocks: 3, finalItemsCount: 2, batchSize: 20, coverageRate: 0.75, matchedRate: 0 },
      discarded: [{ blockIds: ['P3'], reason: '无关' }],
      systemDiscardedAfterRetry: [{ blockIds: ['P9'], reason: '重试后舍弃' }],
    });
    expect(typeof analysis.report.createdAt).toBe('string');
    expect(analysis).not.toHaveProperty('debugLogPath');
    await expectError(await kb(member, `/documents/${documentId}/analysis`, noStorageApp), 503, 'FILE_STORAGE_DISABLED');
    await expectError(await kb(a, `/documents/${documentId}/analysis`), 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
  });
});
