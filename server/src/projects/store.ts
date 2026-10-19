// projects 表的读写（迁移 0007_projects）。组织和用户一律来自 TenantContext，所有查询都经 withTenant，
// 由 RLS 保证只能看到、修改本组织的项目；跨组织的 projectId 与不存在的一样返回 null。
import { sql, type Kysely, type Selectable } from 'kysely';
import { PROJECT_KINDS, PROJECT_NAME_MAX_LENGTH, PROJECT_RESTORE_DAYS } from '../db/migrations/0007_projects.ts';
import type { Database, ProjectsTable } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';

export { PROJECT_KINDS, PROJECT_NAME_MAX_LENGTH, PROJECT_RESTORE_DAYS };
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export interface ProjectRecord {
  id: string;
  orgId: string;
  kind: ProjectKind;
  name: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const RESTORE_WINDOW_MS = PROJECT_RESTORE_DAYS * 24 * 60 * 60 * 1000;

function toRecord(row: Selectable<ProjectsTable>): ProjectRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/** 删除后可以恢复到的时刻；未删除时为 null。 */
export function projectRestoreDeadline(record: ProjectRecord): Date | null {
  return record.deletedAt ? new Date(record.deletedAt.getTime() + RESTORE_WINDOW_MS) : null;
}

// 控制字符、零宽和双向文本控制字符（Unicode Cc / Cf）不进名称，避免显示时伪装成别的名称。
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/** 项目名称：NFC 归一化、去掉不可见字符和首尾空白；为空或超过 200 字时拒绝。 */
export function normalizeProjectName(raw: string): string {
  const name = raw.normalize('NFC').replace(INVISIBLE_CHARACTERS, '').trim();
  if (name.length === 0 || [...name].length > PROJECT_NAME_MAX_LENGTH) {
    throw new AppError(400, 'PROJECT_NAME_INVALID', `项目名称不能为空，且不超过 ${PROJECT_NAME_MAX_LENGTH} 个字`);
  }
  return name;
}

function mapProjectError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'PJ002') return new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已超过恢复期', { cause: error });
  return error;
}

export async function createProject(
  db: Kysely<Database>,
  context: TenantContext,
  input: { kind: ProjectKind; name: string },
): Promise<ProjectRecord> {
  const row = await withTenant(db, context, (trx) =>
    trx
      .insertInto('projects')
      .values({ org_id: context.orgId, kind: input.kind, name: normalizeProjectName(input.name), created_by: context.userId })
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
  return toRecord(row);
}

/** 未删除的项目；其他组织的、已删除的都返回 null。 */
export async function findProject(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<ProjectRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx.selectFrom('projects').selectAll().where('id', '=', projectId).where('deleted_at', 'is', null).executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

export interface ListProjectsOptions {
  /** true：只列回收站中仍可恢复的项目。 */
  deleted: boolean;
  kind?: ProjectKind;
  limit: number;
}

export async function listProjects(db: Kysely<Database>, context: TenantContext, options: ListProjectsOptions): Promise<ProjectRecord[]> {
  const rows = await withTenant(db, context, (trx) => {
    let query = trx.selectFrom('projects').selectAll();
    query = options.deleted
      ? query.where('deleted_at', 'is not', null).where(sql<boolean>`deleted_at > now() - make_interval(days => ${PROJECT_RESTORE_DAYS})`)
      : query.where('deleted_at', 'is', null);
    if (options.kind) query = query.where('kind', '=', options.kind);
    return query.orderBy('created_at', 'desc').orderBy('id').limit(options.limit).execute();
  });
  return rows.map(toRecord);
}

/** 改名。已删除或不存在时返回 null。 */
export async function renameProject(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  name: string,
): Promise<ProjectRecord | null> {
  const normalized = normalizeProjectName(name);
  const row = await withTenant(db, context, (trx) =>
    trx
      .updateTable('projects')
      .set({ name: normalized })
      .where('id', '=', projectId)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

/** 软删除，7 天内可恢复。已删除或不存在时返回 null。 */
export async function softDeleteProject(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<ProjectRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx
      .updateTable('projects')
      .set({ deleted_at: sql<Date>`now()`, deleted_by: context.userId })
      .where('id', '=', projectId)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

/** 恢复回收站中的项目。不在回收站中、已超过恢复期或不存在时返回 null。 */
export async function restoreProject(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<ProjectRecord | null> {
  try {
    const row = await withTenant(db, context, (trx) =>
      trx
        .updateTable('projects')
        .set({ deleted_at: null, deleted_by: null })
        .where('id', '=', projectId)
        .where('deleted_at', 'is not', null)
        .where(sql<boolean>`deleted_at > now() - make_interval(days => ${PROJECT_RESTORE_DAYS})`)
        .returningAll()
        .executeTakeFirst(),
    );
    return row ? toRecord(row) : null;
  } catch (error) {
    throw mapProjectError(error);
  }
}
