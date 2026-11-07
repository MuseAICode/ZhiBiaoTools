// 技术方案整本导出的存储（路线图第 7 步 7.4d，迁移 0028_technical_plan_export）：整本导出 docx 的写入与按项目查找。
// 导出任务（7.4e）与接口（7.4f）调用，本模块不接任务和接口。组织和用户一律来自 TenantContext，所有查询都经 withTenant：
// - 整本导出属于项目，在本组织内可见（RLS，与项目的其他产物相同），项目删除后不可见；
// - 每个项目只保留最近一次：写入完成时在同一事务中替换同一项目中旧的导出（src/artifacts/store.ts 的 completeArtifact），
//   被替换的立即过期、未被替换的创建 7 天后过期，由清理任务删除；查找只返回 7 天内、未被替换的那一个；
// - 计入组织存储配额（迁移 0008 的配额函数），超出时 writeTechnicalPlanExportArtifact 抛 413 STORAGE_QUOTA_EXCEEDED，
//   旧的导出原样保留；
// - 配图（7.4g）：listTechnicalPlanExportImages 在 RLS 下把正文引用的产物 id 解析成本项目可见的图片产物，
//   其他组织的、其他项目或组织级的、写入中的、已被替换的、来源文件或项目已删除的都不返回。
import { sql, type Kysely } from 'kysely';
import { findArtifact, writeArtifact, type ArtifactRecord } from '../artifacts/store.ts';
import { DOCX_MIME } from '../db/migrations/0027_template_preview.ts';
import { TECHNICAL_PLAN_EXPORT_KIND, TECHNICAL_PLAN_EXPORT_RETENTION_DAYS } from '../db/migrations/0028_technical_plan_export.ts';
import type { Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import type { ObjectStore } from '../files/objectStore.ts';

/** 整本导出产物的文件名（对象的登记名；下载时的文件名由 7.4f 决定）。 */
export const TECHNICAL_PLAN_EXPORT_ARTIFACT_NAME = 'technical-plan.docx';

/** 一次查询的产物 id 个数（引用至多 2,000 个，分批查询，避免过长的参数列表）。 */
const IMAGE_LOOKUP_BATCH = 500;

/** 本项目可见的图片产物：交给 export-document 沙箱的配图。 */
export interface TechnicalPlanExportImage {
  id: string;
  mime: string;
  size: number;
  storageKey: string;
}

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

/**
 * 把正文引用的产物 id 解析成本项目可见的图片产物（种类 image、已完成、未被替换、属于这个项目；可见性由 RLS 决定），
 * 按 ids 的顺序返回，不可见的不返回。ids 必须是小写 uuid（assembleDocumentHtml 的 assetRefs）。
 */
export async function listTechnicalPlanExportImages(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  ids: readonly string[],
): Promise<TechnicalPlanExportImage[]> {
  if (ids.length === 0) return [];
  const found = new Map<string, TechnicalPlanExportImage>();
  await withTenant(db, context, async (trx) => {
    for (let start = 0; start < ids.length; start += IMAGE_LOOKUP_BATCH) {
      const rows = await trx
        .selectFrom('artifacts')
        .select(['id', 'mime', 'size_bytes', 'storage_key'])
        .where('id', 'in', ids.slice(start, start + IMAGE_LOOKUP_BATCH))
        .where('kind', '=', 'image')
        .where('project_id', '=', projectId)
        .where('status', '=', 'ready')
        .where('superseded_at', 'is', null)
        .execute();
      for (const row of rows) found.set(row.id, { id: row.id, mime: row.mime, size: Number(row.size_bytes), storageKey: row.storage_key });
    }
  });
  return ids.flatMap((id) => found.get(id) ?? []);
}
