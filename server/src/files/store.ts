// files 表的读写（迁移 0006_files）。组织和用户一律来自 TenantContext，所有查询都经 withTenant，
// 由 RLS 保证只能看到、修改本组织的文件；跨组织的 fileId 与不存在的一样返回 null。
// 所属项目已删除的文件不可访问，也不在回收站中，随项目一起恢复（src/projects/visibility.ts）。
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, FilesTable } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { projectIsLive } from '../projects/visibility.ts';
import { FILE_RESTORE_DAYS, ORG_STORAGE_QUOTA_BYTES, type FilePurpose } from './policy.ts';
import type { InspectionResult } from './inspect.ts';

export type FileRow = Selectable<FilesTable>;

export interface FileRecord {
  id: string;
  storageKey: string;
  purpose: FilePurpose;
  /** 所属项目；不属于任何项目时为 null。 */
  projectId: string | null;
  displayName: string;
  extension: string;
  mime: string;
  size: number;
  sha256: string;
  createdBy: string;
  createdAt: Date;
  uploadedAt: Date;
  deletedAt: Date | null;
}

const RESTORE_WINDOW_MS = FILE_RESTORE_DAYS * 24 * 60 * 60 * 1000;

function toRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    storageKey: row.storage_key,
    purpose: row.purpose,
    projectId: row.project_id,
    displayName: row.display_name,
    extension: row.extension,
    mime: row.mime!,
    size: Number(row.size_bytes),
    sha256: row.sha256!.toString('hex'),
    createdBy: row.created_by,
    createdAt: row.created_at,
    uploadedAt: row.uploaded_at!,
    deletedAt: row.deleted_at,
  };
}

/** 删除后可以恢复到的时刻；未删除时为 null。 */
export function restoreDeadline(record: FileRecord): Date | null {
  return record.deletedAt ? new Date(record.deletedAt.getTime() + RESTORE_WINDOW_MS) : null;
}

function quotaExceeded(cause?: unknown): AppError {
  return new AppError(413, 'STORAGE_QUOTA_EXCEEDED', '组织存储空间已满，请删除不需要的文件后再上传', cause ? { cause } : undefined);
}

function mapFileError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'FS001') return quotaExceeded(error);
  if (code === 'FS002') return new AppError(404, 'FILE_NOT_FOUND', '文件不存在或已超过恢复期', { cause: error });
  return error;
}

/** 当前组织已占用的配额（字节）。 */
export async function storageUsage(db: Kysely<Database>, context: TenantContext): Promise<{ used: number; quota: number }> {
  const used = await withTenant(db, context, async (trx) => {
    const { rows } = await sql<{ used: string }>`SELECT files_org_usage_bytes(${context.orgId}::uuid) AS used`.execute(trx);
    return Number(rows[0]!.used);
  });
  return { used, quota: Number(ORG_STORAGE_QUOTA_BYTES) };
}

export interface PendingUpload {
  id: string;
  storageKey: string;
}

/** 登记一次上传（status = uploading，不计入配额），对象键由数据库生成。 */
export async function beginUpload(
  db: Kysely<Database>,
  context: TenantContext,
  input: { purpose: FilePurpose; displayName: string; extension: string },
): Promise<PendingUpload> {
  return withTenant(db, context, async (trx) => {
    const row = await trx
      .insertInto('files')
      .values({
        org_id: context.orgId,
        purpose: input.purpose,
        display_name: input.displayName,
        extension: input.extension,
        created_by: context.userId,
      })
      .returning(['id', 'storage_key'])
      .executeTakeFirstOrThrow();
    return { id: row.id, storageKey: row.storage_key };
  });
}

/** 上传完成：写入内容信息，触发器在此检查配额（超出抛 413 STORAGE_QUOTA_EXCEEDED）。 */
export async function completeUpload(
  db: Kysely<Database>,
  context: TenantContext,
  fileId: string,
  inspection: InspectionResult,
): Promise<FileRecord> {
  try {
    return await withTenant(db, context, async (trx) => {
      const row = await trx
        .updateTable('files')
        .set({ status: 'uploaded', mime: inspection.mime, size_bytes: inspection.size, sha256: inspection.sha256 })
        .where('id', '=', fileId)
        .where('status', '=', 'uploading')
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new AppError(409, 'UPLOAD_NOT_PENDING', '上传已失效，请重新上传');
      return toRecord(row);
    });
  } catch (error) {
    throw mapFileError(error);
  }
}

/** 放弃上传：删除 uploading 的行（已上传的行 RLS 不允许物理删除）。 */
export async function abandonUpload(db: Kysely<Database>, context: TenantContext, fileId: string): Promise<void> {
  await withTenant(db, context, (trx) =>
    trx.deleteFrom('files').where('id', '=', fileId).where('status', '=', 'uploading').execute(),
  );
}

/** 已上传、未删除的文件；其他组织的、已删除的、上传中的、所属项目已删除的都返回 null。 */
export async function findFile(db: Kysely<Database>, context: TenantContext, fileId: string): Promise<FileRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('files')
      .selectAll()
      .where('id', '=', fileId)
      .where('status', '=', 'uploaded')
      .where('deleted_at', 'is', null)
      .where(projectIsLive('files.project_id'))
      .executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

export interface ListFilesOptions {
  /** true：只列回收站中仍可恢复的文件（所属项目已删除的不列出，随项目恢复）。 */
  deleted: boolean;
  purpose?: FilePurpose;
  limit: number;
}

export async function listFiles(db: Kysely<Database>, context: TenantContext, options: ListFilesOptions): Promise<FileRecord[]> {
  const rows = await withTenant(db, context, (trx) => {
    let query = trx.selectFrom('files').selectAll().where('status', '=', 'uploaded').where(projectIsLive('files.project_id'));
    query = options.deleted
      ? query.where('deleted_at', 'is not', null).where(sql<boolean>`deleted_at > now() - make_interval(days => ${FILE_RESTORE_DAYS})`)
      : query.where('deleted_at', 'is', null);
    if (options.purpose) query = query.where('purpose', '=', options.purpose);
    return query.orderBy('created_at', 'desc').orderBy('id').limit(options.limit).execute();
  });
  return rows.map(toRecord);
}

/** 软删除，7 天内可恢复。已删除、不存在或所属项目已删除时返回 null。 */
export async function softDeleteFile(db: Kysely<Database>, context: TenantContext, fileId: string): Promise<FileRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx
      .updateTable('files')
      .set({ deleted_at: sql<Date>`now()`, deleted_by: context.userId })
      .where('id', '=', fileId)
      .where('status', '=', 'uploaded')
      .where('deleted_at', 'is', null)
      .where(projectIsLive('files.project_id'))
      .returningAll()
      .executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

/** 恢复回收站中的文件。不在回收站中、已超过恢复期、不存在或所属项目已删除（应恢复项目）时返回 null。 */
export async function restoreFile(db: Kysely<Database>, context: TenantContext, fileId: string): Promise<FileRecord | null> {
  try {
    const row = await withTenant(db, context, (trx) =>
      trx
        .updateTable('files')
        .set({ deleted_at: null, deleted_by: null })
        .where('id', '=', fileId)
        .where('deleted_at', 'is not', null)
        .where(sql<boolean>`deleted_at > now() - make_interval(days => ${FILE_RESTORE_DAYS})`)
        .where(projectIsLive('files.project_id'))
        .returningAll()
        .executeTakeFirst(),
    );
    return row ? toRecord(row) : null;
  } catch (error) {
    throw mapFileError(error);
  }
}
