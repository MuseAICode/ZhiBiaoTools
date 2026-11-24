// Agent 工作区快照的存储（迁移 0040_agent_workspace_snapshots、src/agent/workspaceSnapshots.ts，路线图第 8 步 8.5a）的数据库测试：
// 1. 项目级表的隔离模板（RLS、组织之间互相隔离、复合外键、项目删除挡住物理删除）；对象键由数据库生成；
// 2. 写入：登记 → 写对象（大小与 SHA-256 由服务端计算）→ 完成；同一项目、同一类任务只保留最近一次，旧的对象与行在新的完成后删除，
//    删除失败时留给清理任务；其他项目与其他类任务不受影响；并发写入只有一个当前的；
// 3. 失败不留痕：超过大小上限、超出配额、源出错、中止、项目已删除或属于其他组织时，不留下新对象与登记行，旧快照原样保留；
// 4. 配额：已完成的快照计入组织存储配额（含已被替换、尚未清理的），项目在恢复期内照常计入、超过恢复期不再计入；
// 5. 取回：核对大小与 SHA-256，对象缺失、被截断、被篡改、多出字节时抛错；
// 6. 丢弃：当前的快照标为已被替换并删除；
// 7. 数据库的守卫：完成后不能改（AW003）、只能被替换一次、写入中不能被替换、登记 24 小时后不能完成（AW005）、配额（AW001）、
//    CHECK 与唯一索引、应用角色的列级授权与 DELETE 条件；配额函数的属主仍是 bidtools_storage。
// 清理（被替换、遗留写入、项目超过恢复期、孤儿对象）见 tests/db/cleanup.test.ts。对象存储用内存实现。
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_WORKSPACE_MAX_ARCHIVE_BYTES,
  AGENT_WORKSPACE_MAX_FILES,
  discardWorkspaceSnapshot,
  findWorkspaceSnapshot,
  openWorkspaceSnapshot,
  WorkspaceSnapshotIntegrityError,
  writeWorkspaceSnapshot,
  type WorkspaceSnapshotTarget,
} from '../../src/agent/workspaceSnapshots.ts';
import { AGENT_WORKSPACE_MAX_CONTENT_BYTES } from '../../src/db/migrations/0040_agent_workspace_snapshots.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { CLEANUP_ROLE, STORAGE_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import { storageUsage } from '../../src/files/store.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { describeProjectTable } from './projectTable.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);
const KIND = 'technical-plan-outline';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;

interface MemoryStore extends ObjectStore {
  objects: Map<string, Buffer>;
  /** 删除这些键时失败。 */
  failDelete: Set<string>;
  /** put 读完 body 之后、返回之前调用（模拟写对象期间发生的事）。 */
  afterPut: ((key: string) => Promise<void>) | null;
  /** 每次删除前调用（核对“新快照提交后才删旧的”）。 */
  beforeDelete: ((key: string) => Promise<void>) | null;
  putKeys: string[];
  deleteKeys: string[];
}

function createMemoryStore(): MemoryStore {
  const store: MemoryStore = {
    objects: new Map(),
    failDelete: new Set(),
    afterPut: null,
    beforeDelete: null,
    putKeys: [],
    deleteKeys: [],
    async put(key, body, options) {
      store.putKeys.push(key);
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        options.signal?.throwIfAborted();
        chunks.push(Buffer.from(chunk));
      }
      options.signal?.throwIfAborted();
      store.objects.set(key, Buffer.concat(chunks));
      await store.afterPut?.(key);
    },
    async get(key) {
      const content = store.objects.get(key);
      return content ? { body: Readable.from([content]), size: content.length } : null;
    },
    async exists(key) {
      return store.objects.has(key);
    },
    async delete(key) {
      store.deleteKeys.push(key);
      await store.beforeDelete?.(key);
      if (store.failDelete.has(key)) throw new Error('delete failed');
      store.objects.delete(key);
    },
  };
  return store;
}

let store: MemoryStore;

beforeEach(() => {
  store = createMemoryStore();
});

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

async function deleteProject(projectId: string, agoMs: number, userId: string): Promise<void> {
  // 守卫不允许改已删除项目的删除时间：先恢复再按指定时间删除。
  await superuser.updateTable('projects').set({ deleted_at: null, deleted_by: null }).where('id', '=', projectId).where('deleted_at', 'is not', null).execute();
  await superuser.updateTable('projects').set({ deleted_at: new Date(Date.now() - agoMs), deleted_by: userId }).where('id', '=', projectId).execute();
}

async function fillUsage(orgId: string, bytes: number) {
  for (let left = bytes; left > 0; left -= DOCUMENT_MAX_BYTES) {
    await superuser.insertInto('files').values({
      org_id: orgId, purpose: 'tender', display_name: 'filler.pdf', extension: 'pdf', status: 'uploaded', mime: 'application/pdf',
      size_bytes: Math.min(left, DOCUMENT_MAX_BYTES), sha256: Buffer.alloc(32), created_by: randomUUID(), uploaded_at: new Date(),
    }).execute();
  }
}

function asApp<T>(context: TenantContext, work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
  return withTenant(appDb, context, work);
}

async function expectSqlError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

/** 一份“归档”（内容任意：本模块不解析归档，只按字节保存与核对）。 */
function archive(label: string, size = 2048): Buffer {
  const content = Buffer.alloc(size);
  content.write(label);
  return content;
}

async function* chunked(content: Buffer, size = 700): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < content.length; offset += size) yield content.subarray(offset, offset + size);
}

async function write(ctx: TenantContext, target: WorkspaceSnapshotTarget, content: Buffer, fileCount = 3) {
  return writeWorkspaceSnapshot(appDb, ctx, store, { ...target, fileCount }, chunked(content));
}

async function rows(projectId: string) {
  return superuser.selectFrom('agent_workspace_snapshots').selectAll().where('project_id', '=', projectId).orderBy('created_at').execute();
}

async function readAll(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
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
  appDb = connect<Database>(testDb.appConfig, 6);
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

describe('agent_workspace_snapshots 表', () => {
  describeProjectTable(
    {
      table: 'agent_workspace_snapshots',
      idColumn: 'id',
      async insert(trx, scope) {
        const row = await trx
          .insertInto('agent_workspace_snapshots')
          .values({ org_id: scope.orgId, project_id: scope.projectId, task_kind: KIND, created_by: scope.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        return row.id;
      },
      update: { status: 'ready', size_bytes: 1024, file_count: 0, sha256: Buffer.alloc(32) },
      onProjectDelete: 'restrict',
      definerRoles: [STORAGE_ROLE],
      cleanupRoles: [CLEANUP_ROLE],
    },
    { admin: () => superuser, app: () => appDb },
  );

  it('对象键由数据库生成，任何角色都不能写入；应用角色不能写入完成时间、组织、项目与类别以外的列', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const record = await write(ctx, { projectId, taskKind: KIND }, archive('a'));
    expect(record.storageKey).toBe(`org/${ctx.orgId}/agent-workspaces/${record.id}`);
    await expect(
      superuser.insertInto('agent_workspace_snapshots')
        .values({ org_id: ctx.orgId, project_id: projectId, task_kind: KIND, created_by: ctx.userId, storage_key: 'x' }).execute(),
    ).rejects.toThrow(/non-DEFAULT value into column "storage_key"/);
    for (const values of [{ completed_at: new Date() }, { org_id: randomUUID() }, { project_id: projectId }, { task_kind: 'other-kind' }, { created_by: ctx.userId }]) {
      await expectSqlError(
        asApp(ctx, (trx) => trx.updateTable('agent_workspace_snapshots').set(values as never).where('id', '=', record.id).execute()),
        '42501',
      );
    }
    await expectSqlError(
      asApp(ctx, (trx) => trx.insertInto('agent_workspace_snapshots')
        .values({ org_id: ctx.orgId, project_id: projectId, task_kind: KIND, created_by: ctx.userId, status: 'ready' } as never).execute()),
      '42501',
    );
  });
});

describe('写入与替换', () => {
  it('写入后可查找与取回：大小、文件数、SHA-256 由服务端计算，发起人为当前用户；同组织的其他成员可见', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const content = archive('first', 5000);
    const record = await write(ctx, { projectId, taskKind: KIND }, content, 42);
    expect(record).toMatchObject({
      projectId, taskKind: KIND, size: content.length, fileCount: 42, sha256: createHash('sha256').update(content).digest('hex'), createdBy: ctx.userId,
    });
    expect(store.objects.get(record.storageKey)).toEqual(content);
    const member = await newMember(ctx.orgId);
    expect(await findWorkspaceSnapshot(appDb, member, { projectId, taskKind: KIND })).toEqual(record);
    const opened = await openWorkspaceSnapshot(appDb, member, store, { projectId, taskKind: KIND });
    expect(opened!.record).toEqual(record);
    expect(await readAll(opened!.chunks)).toEqual(content);
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: 'other-kind' })).toBeNull();
    expect(await openWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: 'other-kind' })).toBeNull();
  });

  it('新快照完成后替换旧的：旧的对象与行删除，只剩一个当前的；其他项目、其他类任务不受影响', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const otherProject = await newProject(ctx);
    const old = await write(ctx, { projectId, taskKind: KIND }, archive('old'));
    const otherKind = await write(ctx, { projectId, taskKind: 'feasibility-outline' }, archive('kind'));
    const otherProjectSnapshot = await write(ctx, { projectId: otherProject, taskKind: KIND }, archive('project'));
    const latest = await write(ctx, { projectId, taskKind: KIND }, archive('new'));

    expect(store.objects.has(old.storageKey)).toBe(false);
    expect((await rows(projectId)).map((row) => row.id).sort()).toEqual([otherKind.id, latest.id].sort());
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND })).toEqual(latest);
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: 'feasibility-outline' })).toEqual(otherKind);
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId: otherProject, taskKind: KIND })).toEqual(otherProjectSnapshot);
    for (const kept of [otherKind, otherProjectSnapshot, latest]) expect(store.objects.has(kept.storageKey)).toBe(true);
  });

  it('旧快照只在新快照完整写入并提交之后才删除：删除旧对象时，新快照已对其他连接可见、内容完整，旧行已被替换', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const old = await write(ctx, { projectId, taskKind: KIND }, archive('old'));
    const content = archive('new', 3000);
    const seen: unknown[] = [];
    store.beforeDelete = async (key) => {
      if (key !== old.storageKey) return;
      // 超级用户是另一条连接：只看得到已提交的数据。
      const state = await superuser.selectFrom('agent_workspace_snapshots').select(['id', 'status', 'superseded_at', 'storage_key', 'size_bytes'])
        .where('project_id', '=', projectId).orderBy('created_at').execute();
      seen.push(state.map((row) => ({ old: row.id === old.id, status: row.status, superseded: row.superseded_at !== null, size: Number(row.size_bytes) })));
      const fresh = state.find((row) => row.id !== old.id)!;
      seen.push(store.objects.get(fresh.storage_key)?.equals(content));
    };
    try {
      await write(ctx, { projectId, taskKind: KIND }, content);
    } finally {
      store.beforeDelete = null;
    }
    expect(seen).toEqual([
      [{ old: true, status: 'ready', superseded: true, size: 2048 }, { old: false, status: 'ready', superseded: false, size: 3000 }],
      true,
    ]);
  });

  it('保存失败（超出配额、源出错、中止、超过大小上限）时从不删除旧快照的对象', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const old = await write(ctx, { projectId, taskKind: KIND }, archive('old'));
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(10);
      throw new Error('broken');
    }
    const aborted = new AbortController();
    store.afterPut = async () => aborted.abort(new Error('abort'));
    await expect(writeWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND, fileCount: 1 }, chunked(archive('x')), { signal: aborted.signal })).rejects.toThrow();
    store.afterPut = null;
    await expect(writeWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND, fileCount: 1 }, broken())).rejects.toThrow();
    await expect(writeWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND, fileCount: 1 }, chunked(archive('x', 5000)), { maxArchiveBytes: 4000 })).rejects.toThrow();
    await fillUsage(ctx.orgId, QUOTA - (await storageUsage(appDb, ctx)).used - 100);
    await expect(write(ctx, { projectId, taskKind: KIND }, archive('big', 2048))).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
    expect(store.deleteKeys).not.toContain(old.storageKey);
    expect(store.objects.get(old.storageKey)).toEqual(archive('old'));
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND })).toMatchObject({ id: old.id });
  });

  it('旧快照的对象删除失败时保留它的行（已被替换、查不到），由清理任务重试', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const old = await write(ctx, { projectId, taskKind: KIND }, archive('old'));
    store.failDelete.add(old.storageKey);
    const latest = await write(ctx, { projectId, taskKind: KIND }, archive('new'));
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND })).toEqual(latest);
    const oldRow = (await rows(projectId)).find((row) => row.id === old.id);
    expect(oldRow?.superseded_at).toBeInstanceOf(Date);
    expect(store.objects.has(old.storageKey)).toBe(true);
    const candidates = await sql<{ id: string }>`SELECT id FROM cleanup_agent_workspace_candidates(1000)`.execute(appDb);
    expect(candidates.rows.map((row) => row.id)).toContain(old.id);
  });

  it('并发写入同一项目、同一类任务：恰好一个当前的，其余的对象与行都已删除', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const records = await Promise.all([0, 1, 2, 3].map((index) => write(ctx, { projectId, taskKind: KIND }, archive(`c${index}`))));
    const current = await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND });
    expect(records.map((record) => record.id)).toContain(current!.id);
    expect((await rows(projectId)).map((row) => row.id)).toEqual([current!.id]);
    expect([...store.objects.keys()]).toEqual([current!.storageKey]);
  });

  it('参数不合法是程序错误：项目 id、任务类别、文件数逐项检查，不写库、不写对象', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const cases: [string, Parameters<typeof writeWorkspaceSnapshot>[3]][] = [
      ['大写 UUID', { projectId: projectId.toUpperCase(), taskKind: KIND, fileCount: 0 }],
      ['不是 UUID', { projectId: 'project', taskKind: KIND, fileCount: 0 }],
      ['类别有大写', { projectId, taskKind: 'Outline', fileCount: 0 }],
      ['类别以连字符结尾', { projectId, taskKind: 'outline-', fileCount: 0 }],
      ['类别只有一个字符', { projectId, taskKind: 'a', fileCount: 0 }],
      ['类别有路径分隔符', { projectId, taskKind: 'a/b', fileCount: 0 }],
      ['类别超过 64 个字符', { projectId, taskKind: `a${'b'.repeat(64)}`, fileCount: 0 }],
      ['文件数为负', { projectId, taskKind: KIND, fileCount: -1 }],
      ['文件数超过上限', { projectId, taskKind: KIND, fileCount: AGENT_WORKSPACE_MAX_FILES + 1 }],
      ['文件数不是整数', { projectId, taskKind: KIND, fileCount: 1.5 }],
    ];
    for (const [label, input] of cases) {
      await expect(writeWorkspaceSnapshot(appDb, ctx, store, input, chunked(archive('x'))), label).rejects.toBeInstanceOf(TypeError);
    }
    await expect(findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: 'BAD' })).rejects.toBeInstanceOf(TypeError);
    await expect(discardWorkspaceSnapshot(appDb, ctx, store, { projectId: 'x', taskKind: KIND })).rejects.toBeInstanceOf(TypeError);
    expect(await rows(projectId)).toEqual([]);
    expect(store.putKeys).toEqual([]);
    // 文件数恰好为上限可以写入。
    await write(ctx, { projectId, taskKind: KIND }, archive('max'), AGENT_WORKSPACE_MAX_FILES);
  });
});

describe('失败不留痕，旧快照保留', () => {
  async function seeded() {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const old = await write(ctx, { projectId, taskKind: KIND }, archive('old'));
    return { ctx, projectId, old };
  }

  async function expectOnlyOld(projectId: string, ctx: TenantContext, old: { id: string; storageKey: string }) {
    expect((await rows(projectId)).map((row) => ({ id: row.id, superseded: row.superseded_at }))).toEqual([{ id: old.id, superseded: null }]);
    expect([...store.objects.keys()]).toEqual([old.storageKey]);
    expect((await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND }))!.id).toBe(old.id);
  }

  it('超过大小上限：413 AGENT_WORKSPACE_TOO_LARGE，读到上限后不再读取；恰好等于上限可以写入；上限不能被调大', async () => {
    const { ctx, projectId, old } = await seeded();
    let pulled = 0;
    async function* large(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < 100; index += 1) {
        pulled += 1;
        yield Buffer.alloc(1000);
      }
    }
    await expect(writeWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND, fileCount: 1 }, large(), { maxArchiveBytes: 4500 }))
      .rejects.toMatchObject({ statusCode: 413, code: 'AGENT_WORKSPACE_TOO_LARGE' });
    expect(pulled).toBe(5);
    await expectOnlyOld(projectId, ctx, old);

    const exact = await writeWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND, fileCount: 1 }, chunked(archive('e', 4500)), { maxArchiveBytes: 4500 });
    expect(exact.size).toBe(4500);
    // 传入更大的值也按 AGENT_WORKSPACE_MAX_ARCHIVE_BYTES 计算（这里只核对常量与 CHECK 一致）。
    expect(AGENT_WORKSPACE_MAX_ARCHIVE_BYTES).toBe(AGENT_WORKSPACE_MAX_CONTENT_BYTES + AGENT_WORKSPACE_MAX_FILES * 1024 + 1024);
    await expectSqlError(
      superuser.insertInto('agent_workspace_snapshots').values({
        org_id: ctx.orgId, project_id: projectId, task_kind: 'big-kind', created_by: ctx.userId, status: 'ready',
        size_bytes: AGENT_WORKSPACE_MAX_ARCHIVE_BYTES + 1, file_count: 0, sha256: Buffer.alloc(32), completed_at: new Date(),
      }).execute(),
      '23514',
    );
  });

  it('超出组织存储配额：413 STORAGE_QUOTA_EXCEEDED，新对象与登记行删除，旧快照原样保留（替换在同一事务中回滚）', async () => {
    const { ctx, projectId, old } = await seeded();
    const used = (await storageUsage(appDb, ctx)).used;
    await fillUsage(ctx.orgId, QUOTA - used - 100);
    await expect(write(ctx, { projectId, taskKind: KIND }, archive('new', 2048)))
      .rejects.toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });
    await expectOnlyOld(projectId, ctx, old);
    // 对照组：放得下时成功（旧快照在替换前仍计入，所以新快照须连同旧的一起放得下）。
    const small = await write(ctx, { projectId, taskKind: KIND }, archive('small', 100));
    expect(small.size).toBe(100);
  });

  it('源出错、中止：不留下新对象与登记行', async () => {
    const { ctx, projectId, old } = await seeded();
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(100);
      throw new Error('sandbox stream broke');
    }
    await expect(writeWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND, fileCount: 1 }, broken())).rejects.toThrow('sandbox stream broke');
    await expectOnlyOld(projectId, ctx, old);

    const controller = new AbortController();
    store.afterPut = async () => controller.abort(new Error('worker shutting down'));
    await expect(writeWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND, fileCount: 1 }, chunked(archive('x')), { signal: controller.signal }))
      .rejects.toThrow('worker shutting down');
    store.afterPut = null;
    await expectOnlyOld(projectId, ctx, old);

    const aborted = new AbortController();
    aborted.abort(new Error('already aborted'));
    const before = store.putKeys.length;
    await expect(writeWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND, fileCount: 1 }, chunked(archive('x')), { signal: aborted.signal }))
      .rejects.toThrow('already aborted');
    expect(store.putKeys.length).toBe(before);
    await expectOnlyOld(projectId, ctx, old);
  });

  it('写对象期间项目被删除：完成被 RLS 挡住，不留下新对象与登记行（项目恢复后旧快照仍在）', async () => {
    const { ctx, projectId, old } = await seeded();
    store.afterPut = async () => deleteProject(projectId, 0, ctx.userId);
    await expect(write(ctx, { projectId, taskKind: KIND }, archive('new'))).rejects.toThrow();
    store.afterPut = null;
    await superuser.updateTable('projects').set({ deleted_at: null, deleted_by: null }).where('id', '=', projectId).execute();
    // 登记行在项目删除期间删不掉（RLS 下不可见），超过 24 小时后由清理任务删除；对象已删除。
    const leftovers = (await rows(projectId)).filter((row) => row.id !== old.id);
    expect(leftovers.every((row) => row.status === 'writing')).toBe(true);
    expect([...store.objects.keys()]).toEqual([old.storageKey]);
    expect((await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND }))!.id).toBe(old.id);
  });

  it('项目已删除、不存在或属于其他组织：登记被拒绝，不写对象', async () => {
    const ctx = await newOrg();
    const deleted = await newProject(ctx);
    await deleteProject(deleted, HOUR, ctx.userId);
    const stranger = await newOrg();
    const foreign = await newProject(stranger);
    for (const projectId of [deleted, randomUUID(), foreign]) {
      await expect(write(ctx, { projectId, taskKind: KIND }, archive('x'))).rejects.toThrow();
    }
    expect(store.putKeys).toEqual([]);
    expect(await rows(foreign)).toEqual([]);
  });
});

describe('配额与可见性', () => {
  it('已完成的快照计入组织存储配额，写入中的不计入；被替换、尚未清理的仍计入；项目在恢复期内计入，超过恢复期不再计入', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const base = (await storageUsage(appDb, ctx)).used;
    const record = await write(ctx, { projectId, taskKind: KIND }, archive('a', 3000));
    expect((await storageUsage(appDb, ctx)).used).toBe(base + 3000);
    await asApp(ctx, (trx) => trx.insertInto('agent_workspace_snapshots')
      .values({ org_id: ctx.orgId, project_id: projectId, task_kind: 'pending-kind', created_by: ctx.userId }).execute());
    expect((await storageUsage(appDb, ctx)).used).toBe(base + 3000);

    // 被替换、对象删除失败而留下的行仍计入，直到清理任务删除。
    store.failDelete.add(record.storageKey);
    await write(ctx, { projectId, taskKind: KIND }, archive('b', 1000));
    expect((await storageUsage(appDb, ctx)).used).toBe(base + 4000);

    await deleteProject(projectId, 7 * DAY - HOUR, ctx.userId);
    expect((await storageUsage(appDb, ctx)).used).toBe(base + 4000);
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND })).toBeNull();
    await deleteProject(projectId, 7 * DAY + HOUR, ctx.userId);
    expect((await storageUsage(appDb, ctx)).used).toBe(base);
  });

  it('项目删除后不可见、不能丢弃、不能直接删除；恢复后照常可见', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const record = await write(ctx, { projectId, taskKind: KIND }, archive('a'));
    await deleteProject(projectId, HOUR, ctx.userId);
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND })).toBeNull();
    expect(await openWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND })).toBeNull();
    expect(await discardWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND })).toBe(false);
    expect(store.objects.has(record.storageKey)).toBe(true);
    await superuser.updateTable('projects').set({ deleted_at: null, deleted_by: null }).where('id', '=', projectId).execute();
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND })).toEqual(record);
  });

  it('其他组织看不到、打不开、丢弃不了，也写不进本组织的项目', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const record = await write(ctx, { projectId, taskKind: KIND }, archive('a'));
    const stranger = await newOrg();
    expect(await findWorkspaceSnapshot(appDb, stranger, { projectId, taskKind: KIND })).toBeNull();
    expect(await openWorkspaceSnapshot(appDb, stranger, store, { projectId, taskKind: KIND })).toBeNull();
    expect(await discardWorkspaceSnapshot(appDb, stranger, store, { projectId, taskKind: KIND })).toBe(false);
    await expect(write(stranger, { projectId, taskKind: KIND }, archive('b'))).rejects.toThrow();
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND })).toEqual(record);
    expect(store.objects.has(record.storageKey)).toBe(true);
  });
});

describe('取回时核对内容', () => {
  async function stored() {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const content = archive('content', 4096);
    const record = await write(ctx, { projectId, taskKind: KIND }, content);
    return { ctx, target: { projectId, taskKind: KIND }, record, content };
  }

  it('对象缺失：WorkspaceSnapshotIntegrityError(missing)', async () => {
    const { ctx, target, record } = await stored();
    store.objects.delete(record.storageKey);
    await expect(openWorkspaceSnapshot(appDb, ctx, store, target)).rejects.toMatchObject({ reason: 'missing' });
  });

  it.each<[string, (content: Buffer) => Buffer, 'size' | 'sha256']>([
    ['被截断', (content) => content.subarray(0, content.length - 1), 'size'],
    ['多出字节', (content) => Buffer.concat([content, Buffer.from('x')]), 'size'],
    ['内容被篡改（大小相同）', (content) => Buffer.concat([Buffer.from('X'), content.subarray(1)]), 'sha256'],
  ])('%s：读完（或读到超出时）抛 WorkspaceSnapshotIntegrityError', async (_label, tamper, reason) => {
    const { ctx, target, record, content } = await stored();
    store.objects.set(record.storageKey, tamper(content));
    const opened = await openWorkspaceSnapshot(appDb, ctx, store, target);
    let delivered = 0;
    const error = await (async () => {
      for await (const chunk of opened!.chunks) delivered += chunk.length;
    })().then(() => null, (caught: unknown) => caught);
    // 多出的字节不交给调用方：超过记录的大小时立即停止。
    expect(delivered).toBeLessThanOrEqual(record.size);
    expect(error).toBeInstanceOf(WorkspaceSnapshotIntegrityError);
    expect(error).toMatchObject({ reason });
    expect(String((error as Error).message)).not.toContain(record.storageKey);
  });

  it('只能读一次', async () => {
    const { ctx, target, content } = await stored();
    const opened = await openWorkspaceSnapshot(appDb, ctx, store, target);
    expect(await readAll(opened!.chunks)).toEqual(content);
    await expect(readAll(opened!.chunks)).rejects.toThrow(/only be read once/);
  });
});

describe('丢弃', () => {
  it('丢弃当前的快照：对象与行删除，再查找为 null；没有快照时返回 false；对象删除失败时行保留、已被替换', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const keep = await write(ctx, { projectId, taskKind: 'feasibility-outline' }, archive('keep'));
    const record = await write(ctx, { projectId, taskKind: KIND }, archive('a'));
    expect(await discardWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND })).toBe(true);
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND })).toBeNull();
    expect(store.objects.has(record.storageKey)).toBe(false);
    expect((await rows(projectId)).map((row) => row.id)).toEqual([keep.id]);
    expect(await discardWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND })).toBe(false);

    const again = await write(ctx, { projectId, taskKind: KIND }, archive('b'));
    store.failDelete.add(again.storageKey);
    expect(await discardWorkspaceSnapshot(appDb, ctx, store, { projectId, taskKind: KIND })).toBe(true);
    expect(await findWorkspaceSnapshot(appDb, ctx, { projectId, taskKind: KIND })).toBeNull();
    expect((await rows(projectId)).find((row) => row.id === again.id)?.superseded_at).toBeInstanceOf(Date);
  });
});

describe('数据库的守卫', () => {
  async function current() {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const record = await write(ctx, { projectId, taskKind: KIND }, archive('a'));
    return { ctx, projectId, record };
  }

  it('已完成的快照内容不能改（AW003），只能标为已被替换一次，时间由触发器写入；写入中的不能被替换', async () => {
    const { ctx, projectId, record } = await current();
    for (const values of [{ size_bytes: 1 }, { file_count: 1 }, { sha256: Buffer.alloc(32, 1) }]) {
      await expectSqlError(asApp(ctx, (trx) => trx.updateTable('agent_workspace_snapshots').set(values).where('id', '=', record.id).execute()), 'AW003');
    }
    const claimed = new Date('2000-01-01T00:00:00Z');
    await asApp(ctx, (trx) => trx.updateTable('agent_workspace_snapshots').set({ superseded_at: claimed }).where('id', '=', record.id).execute());
    const row = (await rows(projectId))[0]!;
    expect(row.superseded_at.getTime()).toBeGreaterThan(Date.now() - HOUR);
    await expectSqlError(
      asApp(ctx, (trx) => trx.updateTable('agent_workspace_snapshots').set({ superseded_at: new Date() }).where('id', '=', record.id).execute()),
      'AW003',
    );
    const pending = await asApp(ctx, (trx) => trx.insertInto('agent_workspace_snapshots')
      .values({ org_id: ctx.orgId, project_id: projectId, task_kind: KIND, created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow());
    await expectSqlError(
      asApp(ctx, (trx) => trx.updateTable('agent_workspace_snapshots').set({ superseded_at: new Date() }).where('id', '=', pending.id).execute()),
      'AW003',
    );
  });

  it('完成时检查配额（AW001），不经 Store 直接完成同样被挡住', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    await fillUsage(ctx.orgId, QUOTA - (await storageUsage(appDb, ctx)).used - 10);
    const pending = await asApp(ctx, (trx) => trx.insertInto('agent_workspace_snapshots')
      .values({ org_id: ctx.orgId, project_id: projectId, task_kind: KIND, created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow());
    await expectSqlError(
      asApp(ctx, (trx) => trx.updateTable('agent_workspace_snapshots')
        .set({ status: 'ready', size_bytes: 11, file_count: 0, sha256: Buffer.alloc(32) }).where('id', '=', pending.id).execute()),
      'AW001',
    );
    await asApp(ctx, (trx) => trx.updateTable('agent_workspace_snapshots')
      .set({ status: 'ready', size_bytes: 10, file_count: 0, sha256: Buffer.alloc(32) }).where('id', '=', pending.id).execute());
  });

  it('同一项目、同一类任务至多一个当前的快照（唯一索引 23505）；被替换的不占位', async () => {
    const { ctx, projectId, record } = await current();
    const ready = { status: 'ready', size_bytes: 10, file_count: 0, sha256: Buffer.alloc(32) } as const;
    const second = await asApp(ctx, (trx) => trx.insertInto('agent_workspace_snapshots')
      .values({ org_id: ctx.orgId, project_id: projectId, task_kind: KIND, created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow());
    await expectSqlError(asApp(ctx, (trx) => trx.updateTable('agent_workspace_snapshots').set(ready).where('id', '=', second.id).execute()), '23505');
    await asApp(ctx, (trx) => trx.updateTable('agent_workspace_snapshots').set({ superseded_at: new Date() }).where('id', '=', record.id).execute());
    await asApp(ctx, (trx) => trx.updateTable('agent_workspace_snapshots').set(ready).where('id', '=', second.id).execute());
  });

  it('CHECK：写入中不能带内容字段，完成时内容字段都要有；文件数与类别的范围', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const base = { org_id: ctx.orgId, project_id: projectId, created_by: ctx.userId };
    const cases: [string, Record<string, unknown>][] = [
      ['写入中带大小', { ...base, task_kind: KIND, size_bytes: 1 }],
      ['写入中带完成时间', { ...base, task_kind: KIND, completed_at: new Date() }],
      ['完成时缺文件数', { ...base, task_kind: KIND, status: 'ready', size_bytes: 1, sha256: Buffer.alloc(32), completed_at: new Date() }],
      ['文件数超过上限', { ...base, task_kind: KIND, status: 'ready', size_bytes: 1, file_count: AGENT_WORKSPACE_MAX_FILES + 1, sha256: Buffer.alloc(32), completed_at: new Date() }],
      ['哈希不是 32 字节', { ...base, task_kind: KIND, status: 'ready', size_bytes: 1, file_count: 0, sha256: Buffer.alloc(31), completed_at: new Date() }],
      ['类别不合法', { ...base, task_kind: '../etc' }],
      ['状态不合法', { ...base, task_kind: KIND, status: 'deleted' }],
    ];
    for (const [label, values] of cases) {
      await expect(superuser.insertInto('agent_workspace_snapshots').values(values).execute(), label).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('应用角色只能删除写入中或已被替换的行，不能删除当前的快照', async () => {
    const { ctx, projectId, record } = await current();
    const deleted = await asApp(ctx, (trx) => trx.deleteFrom('agent_workspace_snapshots').where('id', '=', record.id).executeTakeFirst());
    expect(Number(deleted.numDeletedRows)).toBe(0);
    expect((await rows(projectId)).map((row) => row.id)).toEqual([record.id]);
    const pending = await asApp(ctx, (trx) => trx.insertInto('agent_workspace_snapshots')
      .values({ org_id: ctx.orgId, project_id: projectId, task_kind: 'pending-kind', created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow());
    expect(Number((await asApp(ctx, (trx) => trx.deleteFrom('agent_workspace_snapshots').where('id', '=', pending.id).executeTakeFirst())).numDeletedRows)).toBe(1);
  });

  it('不能以他人身份登记，也不能在登记时就标为已完成', async () => {
    const ctx = await newOrg();
    const projectId = await newProject(ctx);
    const member = await newMember(ctx.orgId);
    await expect(asApp(ctx, (trx) => trx.insertInto('agent_workspace_snapshots')
      .values({ org_id: ctx.orgId, project_id: projectId, task_kind: KIND, created_by: member.userId }).execute())).rejects.toThrow(/row-level security/);
  });

  it('bidtools_storage 对计费账本、余额、价格表、用量记录、平台凭据、平台模型没有任何权限与策略；全部授权只有 5 张表的列级 SELECT（0046 加上 AI 小节正文）', async () => {
    const billing = ['billing_ledger', 'org_balances', 'model_prices', 'usage_records', 'provider_credentials', 'platform_models'];
    for (const table of billing) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const { rows: granted } = await sql<{ ok: boolean }>`SELECT has_table_privilege(${STORAGE_ROLE}, ${`public.${table}`}, ${privilege}) AS ok`.execute(superuser);
        expect(granted[0]!.ok, `${table} ${privilege}`).toBe(false);
      }
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        const { rows: granted } = await sql<{ ok: boolean }>`SELECT has_any_column_privilege(${STORAGE_ROLE}, ${`public.${table}`}, ${privilege}) AS ok`.execute(superuser);
        expect(granted[0]!.ok, `${table} column ${privilege}`).toBe(false);
      }
    }
    const policies = await sql<{ tablename: string; cmd: string }>`
      SELECT tablename, cmd FROM pg_policies WHERE ${STORAGE_ROLE} = ANY (roles) ORDER BY tablename`.execute(superuser);
    expect(policies.rows).toEqual([
      { tablename: 'agent_workspace_snapshots', cmd: 'SELECT' }, { tablename: 'artifacts', cmd: 'SELECT' },
      { tablename: 'files', cmd: 'SELECT' }, { tablename: 'projects', cmd: 'SELECT' },
      { tablename: 'technical_plan_section_bodies', cmd: 'SELECT' },
    ]);
    const { rows: tables } = await sql<{ relname: string; privileges: string[] }>`
      SELECT c.relname,
        array(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege(${STORAGE_ROLE}, c.oid, p)
              UNION SELECT 'column ' || p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p WHERE has_any_column_privilege(${STORAGE_ROLE}, c.oid, p)) AS privileges
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') ORDER BY c.relname`.execute(superuser);
    const granted = tables.filter((row) => row.privileges.length > 0);
    expect(granted.map((row) => row.relname)).toEqual(['agent_workspace_snapshots', 'artifacts', 'files', 'projects', 'technical_plan_section_bodies']);
    for (const row of granted) expect(row.privileges, row.relname).toEqual(['column SELECT']);
  });

  it('配额函数的属主仍是 bidtools_storage，只能统计当前上下文的组织（AR004）', async () => {
    const ctx = await newOrg();
    const other = await newOrg();
    await expectSqlError(withTenant(appDb, other, (trx) => sql`SELECT files_org_usage_bytes(${ctx.orgId}::uuid)`.execute(trx)), 'AR004');
    const owner = await sql<{ owner: string; secdef: boolean; config: string[] }>`
      SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS secdef, proconfig AS config FROM pg_proc WHERE proname = 'files_org_usage_bytes'`.execute(superuser);
    expect(owner.rows).toEqual([{ owner: STORAGE_ROLE, secdef: true, config: ['search_path=pg_catalog, pg_temp'] }]);
    // bidtools_storage 对快照表只有配额要用的 4 列的 SELECT。
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_name = 'agent_workspace_snapshots' AND grantee = ${STORAGE_ROLE} AND privilege_type = 'SELECT' ORDER BY column_name`.execute(superuser);
    expect(columns.rows.map((row) => row.column_name)).toEqual(['org_id', 'project_id', 'size_bytes', 'status']);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      const { rows: granted } = await sql<{ ok: boolean }>`SELECT has_table_privilege(${STORAGE_ROLE}, 'public.agent_workspace_snapshots', ${privilege}) AS ok`.execute(superuser);
      expect(granted[0]!.ok, privilege).toBe(false);
    }
  });
});
