// 资信库的读写（迁移 0011_credential_library）。组织和用户一律来自 TenantContext，所有查询都经 withTenant。
//
// 可见性、写权限和删除可见性由 RLS 保证，这里不判断：只能看到、写入本组织的行；图片只能挂本组织可用的 credential-image 文件，
// 所引用的文件已删除时图片查不到、改不了。删除图片就是软删除它的文件（应用角色没有图片的 DELETE 授权），
// 删除记录时先软删除其图片的文件、再物理删除记录（图片行由外键级联删除），文件进回收站，按文件自己的恢复期处理。
//
// 每次修改后在同一事务中重新读取完整快照返回（与桌面版相同）。
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  CREDENTIAL_IMAGES_PER_ORG_MAX,
  CREDENTIAL_RECORD_TABLES,
  CREDENTIAL_RECORDS_PER_ORG_MAX,
  type CredentialOwnerType,
} from '../db/migrations/0011_credential_library.ts';
import type { CredentialLibraryProfileTable, Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { PROFILE_TEXT_FIELDS, RECORD_TEXT_FIELDS, type CredentialRecordType } from './fields.ts';

export interface CredentialImageRecord {
  id: string;
  ownerType: CredentialOwnerType;
  /** 所属记录的 id；企业信息的图片为 null。 */
  ownerId: string | null;
  fieldKey: string;
  fileId: string;
  /** 上传时的文件名（files.display_name）。 */
  originalName: string;
  customName: string;
  sortOrder: number;
  createdAt: Date;
}

export interface CredentialLibrarySnapshot {
  profile: Record<string, string | boolean | Date | null>;
  certificates: Record<string, string | Date>[];
  employees: Record<string, string | Date>[];
  projects: Record<string, string | Date>[];
  otherMaterials: Record<string, string | Date>[];
  images: CredentialImageRecord[];
}

export interface NewCredentialImage {
  fileId: string;
  customName?: string;
}

export interface RecordImageAddition extends NewCredentialImage {
  fieldKey: string;
}

export interface SaveRecordInput {
  record: Record<string, string>;
  newImages?: RecordImageAddition[];
  removedImageIds?: string[];
  imageNameUpdates?: { imageId: string; customName: string }[];
}

type RecordTable = (typeof CREDENTIAL_RECORD_TABLES)[CredentialRecordType]['table'];
type ImageOwnerColumn = (typeof CREDENTIAL_RECORD_TABLES)[CredentialRecordType]['imageColumn'];

function invalid(message: string, cause?: unknown): AppError {
  return new AppError(400, 'CREDENTIAL_INVALID', message, cause === undefined ? undefined : { cause });
}

export function recordNotFound(): AppError {
  return new AppError(404, 'CREDENTIAL_RECORD_NOT_FOUND', '资料不存在或已被删除');
}

function imageNotFound(): AppError {
  return new AppError(404, 'CREDENTIAL_IMAGE_NOT_FOUND', '图片不存在或已被删除');
}

function mapError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'CL001') {
    return new AppError(409, 'CREDENTIAL_LIMIT_REACHED', `每类资料最多 ${CREDENTIAL_RECORDS_PER_ORG_MAX} 条，图片最多 ${CREDENTIAL_IMAGES_PER_ORG_MAX} 张`, {
      cause: error,
    });
  }
  // 23514：长度、枚举或图片栏目不符；22021：文本中有数据库不接受的字符。
  if (code === '23514' || code === '22021') return invalid('资料内容不合法', error);
  return error;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapError(error);
  }
}

// \u0000 不能存进 PostgreSQL 的 text，提前拒绝，给出明确的错误。
function assertStorable(values: Iterable<unknown>): void {
  for (const value of values) {
    if (typeof value === 'string' && value.includes('\u0000')) throw invalid('资料中含有不可见的非法字符');
  }
}

function profileBody(row: Selectable<CredentialLibraryProfileTable> | undefined): CredentialLibrarySnapshot['profile'] {
  const profile: CredentialLibrarySnapshot['profile'] = {};
  for (const [field, { column }] of Object.entries(PROFILE_TEXT_FIELDS)) profile[field] = row ? row[column] : '';
  profile.watermarkEnabled = row?.watermark_enabled ?? false;
  profile.updatedBy = row?.updated_by ?? null;
  profile.createdAt = row?.created_at ?? null;
  profile.updatedAt = row?.updated_at ?? null;
  return profile;
}

function recordBody(type: CredentialRecordType, row: Record<string, unknown>): Record<string, string | Date> {
  const body: Record<string, string | Date> = { id: row.id as string };
  for (const [field, { column }] of Object.entries(RECORD_TEXT_FIELDS[type])) body[field] = row[column] as string;
  body.createdBy = row.created_by as string;
  body.updatedBy = row.updated_by as string;
  body.createdAt = row.created_at as Date;
  body.updatedAt = row.updated_at as Date;
  return body;
}

/** 记录表的动态访问：表名和列名只来自迁移中的常量，不来自请求。 */
function dynamic(trx: Transaction<Database>): Transaction<any> {
  return trx as unknown as Transaction<any>;
}

async function readRecords(trx: Transaction<Database>, type: CredentialRecordType) {
  const rows = await dynamic(trx)
    .selectFrom(CREDENTIAL_RECORD_TABLES[type].table)
    .selectAll()
    .orderBy('updated_at', 'desc')
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .execute();
  return rows.map((row: Record<string, unknown>) => recordBody(type, row));
}

async function readSnapshot(trx: Transaction<Database>): Promise<CredentialLibrarySnapshot> {
  const profile = await trx.selectFrom('credential_library_profile').selectAll().executeTakeFirst();
  const images = await trx
    .selectFrom('credential_library_images as i')
    .innerJoin('files as f', 'f.id', 'i.file_id')
    .select([
      'i.id',
      'i.owner_type',
      'i.certificate_id',
      'i.employee_id',
      'i.credential_project_id',
      'i.material_id',
      'i.field_key',
      'i.file_id',
      'f.display_name',
      'i.custom_name',
      'i.sort_order',
      'i.created_at',
    ])
    .orderBy('i.owner_type')
    .orderBy('i.field_key')
    .orderBy('i.sort_order')
    .orderBy('i.created_at')
    .orderBy('i.id')
    .execute();
  return {
    profile: profileBody(profile),
    certificates: await readRecords(trx, 'certificate'),
    employees: await readRecords(trx, 'employee'),
    projects: await readRecords(trx, 'project'),
    otherMaterials: await readRecords(trx, 'other'),
    images: images.map((row) => ({
      id: row.id,
      ownerType: row.owner_type,
      ownerId: row.certificate_id ?? row.employee_id ?? row.credential_project_id ?? row.material_id,
      fieldKey: row.field_key,
      fileId: row.file_id,
      originalName: row.display_name,
      customName: row.custom_name,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
    })),
  };
}

/** 软删除一组图片所引用的文件（只限 RLS 下可见、尚未删除的）。返回实际删除的文件数。 */
async function deleteImageFiles(
  trx: Transaction<Database>,
  context: TenantContext,
  filter: (query: ReturnType<typeof imageFiles>) => ReturnType<typeof imageFiles>,
): Promise<number> {
  const result = await trx
    .updateTable('files')
    .set({ deleted_at: sql<Date>`now()`, deleted_by: context.userId })
    .where('deleted_at', 'is', null)
    .where('id', 'in', filter(imageFiles(trx)))
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

function imageFiles(trx: Transaction<Database>) {
  return trx.selectFrom('credential_library_images').select('file_id');
}

/**
 * 挂一组图片到同一归属下，sort_order 接在该栏目现有图片之后。文件不可用（不存在、其他组织的、未上传完成、已删除、
 * 用途不是资信库图片、属于某个项目）由 INSERT 策略拒绝，已挂过的文件由唯一约束拒绝，统一返回 400。
 */
async function insertImages(
  trx: Transaction<Database>,
  context: TenantContext,
  owner: { ownerType: CredentialOwnerType; column: ImageOwnerColumn | null; ownerId: string | null },
  additions: RecordImageAddition[],
): Promise<void> {
  if (additions.length === 0) return;
  assertStorable(additions.map((addition) => addition.customName));
  const fileIds = additions.map((addition) => addition.fileId.toLowerCase());
  if (new Set(fileIds).size !== fileIds.length) throw imageUnavailable();
  const next = new Map<string, number>();
  for (const fieldKey of new Set(additions.map((addition) => addition.fieldKey))) {
    let query = trx
      .selectFrom('credential_library_images')
      .select((eb) => eb.fn.max('sort_order').as('max'))
      .where('owner_type', '=', owner.ownerType)
      .where('field_key', '=', fieldKey);
    if (owner.column) query = query.where(owner.column, '=', owner.ownerId);
    const row = await query.executeTakeFirst();
    next.set(fieldKey, row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1);
  }
  const values = additions.map((addition, index) => {
    const sortOrder = next.get(addition.fieldKey)!;
    next.set(addition.fieldKey, sortOrder + 1);
    return {
      org_id: context.orgId,
      owner_type: owner.ownerType,
      ...(owner.column ? { [owner.column]: owner.ownerId } : {}),
      field_key: addition.fieldKey,
      file_id: fileIds[index]!,
      custom_name: addition.customName ?? '',
      sort_order: sortOrder,
      created_by: context.userId,
    };
  });
  try {
    await trx.insertInto('credential_library_images').values(values).execute();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // 42501：INSERT 策略拒绝（文件不可用）；23505：文件已挂过；23503：外键（其他组织的文件）。
    if (code === '42501' || code === '23505' || code === '23503') throw imageUnavailable(error);
    throw error;
  }
}

function imageUnavailable(cause?: unknown): AppError {
  return new AppError(
    400,
    'CREDENTIAL_IMAGE_UNAVAILABLE',
    '图片文件不存在、未上传完成、已删除或已被使用',
    cause === undefined ? undefined : { cause },
  );
}

function recordValues(type: CredentialRecordType, record: Record<string, string>): Record<string, string> {
  assertStorable(Object.values(record));
  // 与桌面版相同整份保存：没有给出的字段存为空字符串。
  return Object.fromEntries(Object.entries(RECORD_TEXT_FIELDS[type]).map(([field, { column }]) => [column, record[field] ?? '']));
}

export async function loadLibrary(db: Kysely<Database>, context: TenantContext): Promise<CredentialLibrarySnapshot> {
  return withTenant(db, context, readSnapshot);
}

/** 按 patch 保存企业信息；没写过时先建行。 */
export async function saveProfile(
  db: Kysely<Database>,
  context: TenantContext,
  partial: Record<string, string | boolean>,
): Promise<CredentialLibrarySnapshot> {
  assertStorable(Object.values(partial));
  const values: Record<string, string | boolean> = {};
  for (const [field, value] of Object.entries(partial)) {
    if (field === 'watermarkEnabled') values.watermark_enabled = value;
    else values[PROFILE_TEXT_FIELDS[field]!.column] = value;
  }
  return guarded(() =>
    withTenant(db, context, async (trx) => {
      await trx
        .insertInto('credential_library_profile')
        .values({ org_id: context.orgId, ...values, updated_by: context.userId })
        .onConflict((oc) => oc.column('org_id').doUpdateSet({ ...values, updated_by: context.userId }))
        .execute();
      return readSnapshot(trx);
    }),
  );
}

/** 给企业信息的一个栏目追加图片。 */
export async function addProfileImages(
  db: Kysely<Database>,
  context: TenantContext,
  fieldKey: string,
  images: NewCredentialImage[],
): Promise<CredentialLibrarySnapshot> {
  return guarded(() =>
    withTenant(db, context, async (trx) => {
      await insertImages(trx, context, { ownerType: 'profile', column: null, ownerId: null }, images.map((image) => ({ ...image, fieldKey })));
      return readSnapshot(trx);
    }),
  );
}

/** 删除一张图片：软删除其文件，图片随之不可见（RLS），恢复文件即一起恢复。 */
export async function deleteImage(db: Kysely<Database>, context: TenantContext, imageId: string): Promise<CredentialLibrarySnapshot> {
  return withTenant(db, context, async (trx) => {
    const deleted = await deleteImageFiles(trx, context, (query) => query.where('id', '=', imageId));
    if (deleted === 0) throw imageNotFound();
    return readSnapshot(trx);
  });
}

export async function createRecord(
  db: Kysely<Database>,
  context: TenantContext,
  type: CredentialRecordType,
  input: SaveRecordInput,
): Promise<{ id: string; snapshot: CredentialLibrarySnapshot }> {
  const { table, imageColumn } = CREDENTIAL_RECORD_TABLES[type];
  const values = recordValues(type, input.record);
  return guarded(() =>
    withTenant(db, context, async (trx) => {
      const row = await dynamic(trx)
        .insertInto(table satisfies RecordTable)
        .values({ org_id: context.orgId, ...values, created_by: context.userId, updated_by: context.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await insertImages(trx, context, { ownerType: type, column: imageColumn, ownerId: row.id }, input.newImages ?? []);
      return { id: row.id as string, snapshot: await readSnapshot(trx) };
    }),
  );
}

/** 整份保存一条记录，并在同一事务中提交其图片的新增、删除和改名（与桌面版 saveRecord 相同）。 */
export async function updateRecord(
  db: Kysely<Database>,
  context: TenantContext,
  type: CredentialRecordType,
  recordId: string,
  input: SaveRecordInput,
): Promise<{ id: string; snapshot: CredentialLibrarySnapshot }> {
  const { table, imageColumn } = CREDENTIAL_RECORD_TABLES[type];
  const values = recordValues(type, input.record);
  assertStorable((input.imageNameUpdates ?? []).map((update) => update.customName));
  return guarded(() =>
    withTenant(db, context, async (trx) => {
      const row = await dynamic(trx)
        .updateTable(table)
        .set({ ...values, updated_by: context.userId })
        .where('id', '=', recordId)
        .returning('id')
        .executeTakeFirst();
      if (!row) throw recordNotFound();

      // 只处理属于这条记录的图片，其他 id 忽略（与桌面版相同）。
      const removed = [...new Set(input.removedImageIds ?? [])];
      if (removed.length > 0) {
        await deleteImageFiles(trx, context, (query) => query.where('id', 'in', removed).where(imageColumn, '=', recordId));
      }
      for (const update of input.imageNameUpdates ?? []) {
        await trx
          .updateTable('credential_library_images')
          .set({ custom_name: update.customName })
          .where('id', '=', update.imageId)
          .where(imageColumn, '=', recordId)
          .execute();
      }
      await insertImages(trx, context, { ownerType: type, column: imageColumn, ownerId: recordId }, input.newImages ?? []);
      return { id: recordId, snapshot: await readSnapshot(trx) };
    }),
  );
}

/** 删除一条记录：先软删除其图片的文件，再物理删除记录（图片行由外键级联删除）。 */
export async function deleteRecord(
  db: Kysely<Database>,
  context: TenantContext,
  type: CredentialRecordType,
  recordId: string,
): Promise<CredentialLibrarySnapshot> {
  const { table, imageColumn } = CREDENTIAL_RECORD_TABLES[type];
  return withTenant(db, context, async (trx) => {
    await deleteImageFiles(trx, context, (query) => query.where(imageColumn, '=', recordId));
    const result = await dynamic(trx).deleteFrom(table).where('id', '=', recordId).executeTakeFirst();
    if (result.numDeletedRows === 0n) throw recordNotFound();
    return readSnapshot(trx);
  });
}
