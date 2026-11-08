// 可研报告导出 Word 的存储（路线图第 7 步 7.5c，迁移 0030_feasibility_report_export）：可研导出 docx 的写入与按项目查找。
// 导出任务（7.5d）与接口（7.5e）调用，本模块不接任务和接口。规则与整本导出相同（src/export/documentStore.ts）：
// - 可研导出属于项目，在本组织内可见（RLS），项目删除后不可见；
// - 每个项目只保留最近一次：写入完成时在同一事务中替换同一项目中旧的可研导出（src/artifacts/store.ts 的 completeArtifact），
//   被替换的立即过期、未被替换的创建 7 天后过期，由清理任务删除；查找只返回 7 天内、未被替换的那一个；
// - 计入组织存储配额，超出时 writeFeasibilityExportArtifact 抛 413 STORAGE_QUOTA_EXCEEDED，旧的导出原样保留。
// 配图（7.5d）与整本导出相同，用 documentStore.ts 的 listTechnicalPlanExportImages 解析成本项目可见的图片产物。
import { sql, type Kysely } from 'kysely';
import { findArtifact, writeArtifact, type ArtifactRecord } from '../artifacts/store.ts';
import { DOCX_MIME } from '../db/migrations/0027_template_preview.ts';
import { FEASIBILITY_REPORT_EXPORT_KIND, FEASIBILITY_REPORT_EXPORT_RETENTION_DAYS } from '../db/migrations/0030_feasibility_report_export.ts';
import type { Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import type { ObjectStore } from '../files/objectStore.ts';

/** 可研导出产物的文件名（对象的登记名；下载时的文件名由 7.5e 决定）。 */
export const FEASIBILITY_REPORT_EXPORT_ARTIFACT_NAME = 'feasibility-report.docx';

const RETENTION = sql.raw(`interval '${FEASIBILITY_REPORT_EXPORT_RETENTION_DAYS} days'`);

/** 把导出的可研 docx 存为项目的产物（登记 → 写对象 → 替换旧的导出并完成、检查配额）。 */
export async function writeFeasibilityExportArtifact(
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
    { kind: FEASIBILITY_REPORT_EXPORT_KIND, name: FEASIBILITY_REPORT_EXPORT_ARTIFACT_NAME, mime: DOCX_MIME, projectId },
    docx,
  );
}

/** 项目当前的可研导出（7 天内、未被替换）；没有、已过期、项目已删除或属于其他组织时返回 null。 */
export async function findFeasibilityExport(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
): Promise<ArtifactRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('artifacts')
      .select('id')
      .where('kind', '=', FEASIBILITY_REPORT_EXPORT_KIND)
      .where('project_id', '=', projectId)
      .where('status', '=', 'ready')
      .where('superseded_at', 'is', null)
      .where('created_at', '>', sql<Date>`now() - ${RETENTION}`)
      .executeTakeFirst(),
  );
  return row ? findArtifact(db, context, row.id) : null;
}
