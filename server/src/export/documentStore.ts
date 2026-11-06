// 技术方案整本导出的存储（路线图第 7 步 7.4d，迁移 0028_technical_plan_export）：整本导出 docx 的写入与按项目查找。
// 导出任务（7.4e）与接口（7.4f）调用，本模块不接任务和接口。组织和用户一律来自 TenantContext，所有查询都经 withTenant：
// - 整本导出属于项目，在本组织内可见（RLS，与项目的其他产物相同），项目删除后不可见；
// - 每个项目只保留最近一次：写入完成时在同一事务中替换同一项目中旧的导出（src/artifacts/store.ts 的 completeArtifact），
//   被替换的立即过期、未被替换的创建 7 天后过期，由清理任务删除；查找只返回 7 天内、未被替换的那一个；
// - 计入组织存储配额（迁移 0008 的配额函数），超出时 writeTechnicalPlanExportArtifact 抛 413 STORAGE_QUOTA_EXCEEDED，
//   旧的导出原样保留。
import { sql, type Kysely } from 'kysely';
import { findArtifact, writeArtifact, type ArtifactRecord } from '../artifacts/store.ts';
import { DOCX_MIME } from '../db/migrations/0027_template_preview.ts';
import { TECHNICAL_PLAN_EXPORT_KIND, TECHNICAL_PLAN_EXPORT_RETENTION_DAYS } from '../db/migrations/0028_technical_plan_export.ts';
import type { Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import type { ObjectStore } from '../files/objectStore.ts';

/** 整本导出产物的文件名（对象的登记名；下载时的文件名由 7.4f 决定）。 */
export const TECHNICAL_PLAN_EXPORT_ARTIFACT_NAME = 'technical-plan.docx';

const RETENTION = sql.raw(`interval '${TECHNICAL_PLAN_EXPORT_RETENTION_DAYS} days'`);

/** 把导出的整本 docx 存为项目的产物（登记 → 写对象 → 替换旧的导出并完成、检查配额）。 */
export async function writeTechnicalPlanExportArtifact(
  db: Kysely<Database>,
  context: TenantContext,
  store: ObjectStore,
  projectId: string,
  docx: Buffer,
): Promise<ArtifactRecord> {
  return writeArtifact(
    db,
    context,
    store,
    { kind: TECHNICAL_PLAN_EXPORT_KIND, name: TECHNICAL_PLAN_EXPORT_ARTIFACT_NAME, mime: DOCX_MIME, projectId },
    docx,
  );
}

/** 项目当前的整本导出（7 天内、未被替换）；没有、已过期、项目已删除或属于其他组织时返回 null。 */
export async function findTechnicalPlanExport(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
): Promise<ArtifactRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('artifacts')
      .select('id')
      .where('kind', '=', TECHNICAL_PLAN_EXPORT_KIND)
      .where('project_id', '=', projectId)
      .where('status', '=', 'ready')
      .where('superseded_at', 'is', null)
      .where('created_at', '>', sql<Date>`now() - ${RETENTION}`)
      .executeTakeFirst(),
  );
  return row ? findArtifact(db, context, row.id) : null;
}
