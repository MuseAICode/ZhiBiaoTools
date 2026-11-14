// Agent 工作区快照的读写（迁移 0040_agent_workspace_snapshots，路线图第 8 步 8.5a；docs/SERVER_DESIGN.md 第 7.19 节）。
// 组织和用户一律来自 TenantContext，所有查询都经 withTenant，由 RLS 保证只能看到、修改本组织未删除项目下的快照。
//
// - 每个项目、每类任务只保留最近一次（拆分计划“5. 工作区”）：writeWorkspaceSnapshot 登记 → 写对象（边写边计算大小与 SHA-256，
//   超过上限即中止）→ 在同一事务中把同一项目、同一类任务当前的快照标为已被替换并标记完成（触发器检查配额）。
//   任何一步失败都删除新对象和登记行，旧快照原样保留；成功后再删除被替换的旧快照（先删对象、再删行），删除失败的留给清理任务；
// - 快照只用于续跑，内容来自沙箱（不可信）：这里只保证“取回的字节就是写入时的字节”（openWorkspaceSnapshot 核对大小与 SHA-256），
//   归档内容的逐项校验在放入沙箱时进行（8.5b）；
// - 任务成功完成或用户重置该类任务时调用 discardWorkspaceSnapshot（8.5c 接上）。
// 本模块不写日志，不在错误中带对象键。
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  AGENT_WORKSPACE_MAX_ARCHIVE_BYTES,
  AGENT_WORKSPACE_MAX_FILES,
  AGENT_WORKSPACE_TASK_KIND_PATTERN,
} from '../db/migrations/0040_agent_workspace_snapshots.ts';
import type { AgentWorkspaceSnapshotsTable, Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import type { ObjectStore } from '../files/objectStore.ts';

export { AGENT_WORKSPACE_MAX_ARCHIVE_BYTES, AGENT_WORKSPACE_MAX_FILES };

/** 快照对象的 Content-Type：只在对象存储中使用，快照不提供下载。 */
export const AGENT_WORKSPACE_CONTENT_TYPE = 'application/x-tar';

export interface WorkspaceSnapshotTarget {
  /** 所属项目（任务令牌中的项目，不接受 Agent 传入）。 */
  readonly projectId: string;
  /** 任务类别（服务端按任务类型给出），例如 technical-plan-outline。 */
  readonly taskKind: string;
}

export interface WorkspaceSnapshotRecord {
  id: string;
  storageKey: string;
  projectId: string;
  taskKind: string;
  /** 归档对象的字节数。 */
  size: number;
  fileCount: number;
  /** 归档对象的 SHA-256（十六进制）。 */
  sha256: string;
  createdBy: string;
  createdAt: Date;
  completedAt: Date;
}

/** 取回的快照与写入时不一致（对象缺失、大小或 SHA-256 不符）。消息不含对象键。 */
export class WorkspaceSnapshotIntegrityError extends Error {
  readonly reason: 'missing' | 'size' | 'sha256';

  constructor(reason: 'missing' | 'size' | 'sha256') {
    super(`workspace snapshot integrity check failed: ${reason}`);
    this.name = 'WorkspaceSnapshotIntegrityError';
    this.reason = reason;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TASK_KIND = new RegExp(AGENT_WORKSPACE_TASK_KIND_PATTERN);

/** 调用方传错参数是程序错误，抛 TypeError；数据库的 CHECK 约束另外兜底。 */
function assertTarget(target: WorkspaceSnapshotTarget): void {
  if (typeof target.projectId !== 'string' || !UUID_PATTERN.test(target.projectId)) throw new TypeError('projectId 必须是小写 UUID');
  if (typeof target.taskKind !== 'string' || !TASK_KIND.test(target.taskKind)) throw new TypeError('taskKind 不合法');
}

function toRecord(row: Selectable<AgentWorkspaceSnapshotsTable>): WorkspaceSnapshotRecord {
  return {
    id: row.id,
    storageKey: row.storage_key,
    projectId: row.project_id,
    taskKind: row.task_kind,
    size: Number(row.size_bytes),
    fileCount: row.file_count!,
    sha256: row.sha256!.toString('hex'),
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at!,
  };
}

function mapSnapshotError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'AW001') {
    return new AppError(413, 'STORAGE_QUOTA_EXCEEDED', '组织存储空间已满，请删除不需要的文件后再试', { cause: error });
  }
  return error;
}

interface SupersededSnapshot {
  id: string;
  storage_key: string;
}

/** 删除被替换的快照：先删对象，成功后再删行。任何一步失败都保留这一行（已被替换的立即过期，由清理任务重试）。 */
async function purgeSuperseded(db: Kysely<Database>, context: TenantContext, store: ObjectStore, rows: readonly SupersededSnapshot[]): Promise<void> {
  for (const row of rows) {
    try {
      await store.delete(row.storage_key);
      await withTenant(db, context, (trx) =>
        trx.deleteFrom('agent_workspace_snapshots').where('id', '=', row.id).where('superseded_at', 'is not', null).execute(),
      );
    } catch {
      // 留给清理任务。
    }
  }
}

export interface WriteWorkspaceSnapshotOptions {
  signal?: AbortSignal;
  /** 归档的字节上限（测试用），不能超过 AGENT_WORKSPACE_MAX_ARCHIVE_BYTES。 */
  maxArchiveBytes?: number;
}

/**
 * 写入一个快照并替换同一项目、同一类任务当前的快照。body 是已按快照规则生成的 tar 归档（8.5b），fileCount 是其中的文件数。
 * 超过大小上限 413 AGENT_WORKSPACE_TOO_LARGE，超出组织配额 413 STORAGE_QUOTA_EXCEEDED；项目不存在、已删除或属于其他组织时
 * 登记被 RLS 拒绝。失败时不留下新对象和登记行，旧快照原样保留。
 */
export async function writeWorkspaceSnapshot(
  db: Kysely<Database>,
  context: TenantContext,
  store: ObjectStore,
  input: WorkspaceSnapshotTarget & { fileCount: number },
  body: AsyncIterable<Uint8Array>,
  options: WriteWorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshotRecord> {
  assertTarget(input);
  if (!Number.isSafeInteger(input.fileCount) || input.fileCount < 0 || input.fileCount > AGENT_WORKSPACE_MAX_FILES) {
    throw new TypeError('fileCount 超出范围');
  }
  const maxBytes = Math.min(options.maxArchiveBytes ?? AGENT_WORKSPACE_MAX_ARCHIVE_BYTES, AGENT_WORKSPACE_MAX_ARCHIVE_BYTES);
  options.signal?.throwIfAborted();

  const pending = await withTenant(db, context, (trx) =>
    trx
      .insertInto('agent_workspace_snapshots')
      .values({ org_id: context.orgId, project_id: input.projectId, task_kind: input.taskKind, created_by: context.userId })
      .returning(['id', 'storage_key'])
      .executeTakeFirstOrThrow(),
  );

  const hash = createHash('sha256');
  let size = 0;
  async function* metered(): AsyncGenerator<Buffer> {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      size += buffer.length;
      if (size > maxBytes) throw new AppError(413, 'AGENT_WORKSPACE_TOO_LARGE', '工作区快照超过大小上限');
      hash.update(buffer);
      yield buffer;
    }
  }

  let superseded: SupersededSnapshot[];
  let record: WorkspaceSnapshotRecord;
  try {
    // 生成器出错时 Readable 随之出错，对象存储放弃上传。
    let failure: unknown;
    const source = Readable.from(metered());
    source.once('error', (error) => {
      failure ??= error;
    });
    try {
      await store.put(pending.storage_key, source, { contentType: AGENT_WORKSPACE_CONTENT_TYPE, ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
      throw failure ?? error;
    }
    if (failure !== undefined) throw failure;
    options.signal?.throwIfAborted();
    const sha256 = hash.digest();
    ({ record, superseded } = await withTenant(db, context, async (trx) => {
      const lockKey = `agent_workspace:${context.orgId}:${input.projectId}:${input.taskKind}`;
      // 同一项目、同一类任务的完成串行（先于配额的锁取得，顺序固定），后完成的替换先完成的。
      await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`.execute(trx);
      const replaced = await trx
        .updateTable('agent_workspace_snapshots')
        .set({ superseded_at: new Date() })
        .where('project_id', '=', input.projectId)
        .where('task_kind', '=', input.taskKind)
        .where('status', '=', 'ready')
        .where('superseded_at', 'is', null)
        .returning(['id', 'storage_key'])
        .execute();
      const row = await trx
        .updateTable('agent_workspace_snapshots')
        .set({ status: 'ready', size_bytes: size, file_count: input.fileCount, sha256 })
        .where('id', '=', pending.id)
        .where('status', '=', 'writing')
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new Error('workspace snapshot is not pending');
      return { record: toRecord(row), superseded: replaced };
    }));
  } catch (error) {
    // 删除失败时对象成为孤儿、登记行超过 24 小时后过期，都由清理任务处理。
    await store.delete(pending.storage_key).catch(() => {});
    await withTenant(db, context, (trx) =>
      trx.deleteFrom('agent_workspace_snapshots').where('id', '=', pending.id).where('status', '=', 'writing').execute(),
    ).catch(() => {});
    throw mapSnapshotError(error);
  }
  await purgeSuperseded(db, context, store, superseded);
  return record;
}

/** 当前的快照（已完成、未被替换）；没有、属于其他组织、项目已删除时返回 null。 */
export async function findWorkspaceSnapshot(
  db: Kysely<Database>,
  context: TenantContext,
  target: WorkspaceSnapshotTarget,
): Promise<WorkspaceSnapshotRecord | null> {
  assertTarget(target);
  const row = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('agent_workspace_snapshots')
      .selectAll()
      .where('project_id', '=', target.projectId)
      .where('task_kind', '=', target.taskKind)
      .where('status', '=', 'ready')
      .where('superseded_at', 'is', null)
      .executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

export interface OpenedWorkspaceSnapshot {
  record: WorkspaceSnapshotRecord;
  /**
   * 归档的字节，只能迭代一次。读到的字节数超过记录的大小立即抛 WorkspaceSnapshotIntegrityError('size')，读完时大小或 SHA-256
   * 不符同样抛出；调用方必须读完（或在出错时丢弃已放入的内容），不能使用读到一半的数据。
   */
  chunks: AsyncIterable<Buffer>;
}

/** 打开当前的快照；没有时返回 null，对象缺失抛 WorkspaceSnapshotIntegrityError('missing')。 */
export async function openWorkspaceSnapshot(
  db: Kysely<Database>,
  context: TenantContext,
  store: ObjectStore,
  target: WorkspaceSnapshotTarget,
): Promise<OpenedWorkspaceSnapshot | null> {
  const record = await findWorkspaceSnapshot(db, context, target);
  if (!record) return null;
  const object = await store.get(record.storageKey);
  if (!object) throw new WorkspaceSnapshotIntegrityError('missing');
  const body = object.body;
  let started = false;
  async function* verified(): AsyncGenerator<Buffer> {
    if (started) throw new Error('workspace snapshot can only be read once');
    started = true;
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        size += buffer.length;
        if (size > record!.size) throw new WorkspaceSnapshotIntegrityError('size');
        hash.update(buffer);
        yield buffer;
      }
    } finally {
      body.destroy();
    }
    if (size !== record!.size) throw new WorkspaceSnapshotIntegrityError('size');
    if (hash.digest('hex') !== record!.sha256) throw new WorkspaceSnapshotIntegrityError('sha256');
  }
  return { record, chunks: { [Symbol.asyncIterator]: () => verified() } };
}

/**
 * 丢弃当前的快照（任务成功完成且不再需要续跑、或用户重置该类任务时）：标为已被替换，再删除对象和行（失败的留给清理任务）。
 * 返回是否有快照被丢弃。
 */
export async function discardWorkspaceSnapshot(
  db: Kysely<Database>,
  context: TenantContext,
  store: ObjectStore,
  target: WorkspaceSnapshotTarget,
): Promise<boolean> {
  assertTarget(target);
  const discarded = await withTenant(db, context, async (trx) => {
    const lockKey = `agent_workspace:${context.orgId}:${target.projectId}:${target.taskKind}`;
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`.execute(trx);
    return trx
      .updateTable('agent_workspace_snapshots')
      .set({ superseded_at: new Date() })
      .where('project_id', '=', target.projectId)
      .where('task_kind', '=', target.taskKind)
      .where('status', '=', 'ready')
      .where('superseded_at', 'is', null)
      .returning(['id', 'storage_key'])
      .execute();
  });
  await purgeSuperseded(db, context, store, discarded);
  return discarded.length > 0;
}
