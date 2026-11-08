// 技术方案整本导出的请求（路线图第 7 步 7.4f，迁移 0029_technical_plan_export_requests）：入队时取快照、任务读取快照、写回结果。
// 整本导出任务与入队（7.4g）调用，本模块不接任务和接口。组织和用户一律来自 TenantContext，所有查询都经 withTenant：
//
// - 快照（与桌面版 technicalPlanExport.prepare 相同的内容）：目录（含人工正文）、目录的项目名称、模板范围、所选模板经
//   normalizeExportFormat 规范化后的配置，在同一事务中读取，之后对目录、正文或模板的修改不影响这次导出。目录只保留
//   assembleDocumentHtml 用得到的字段：父节点与 AI 小节的正文不导出（AI 小节的正文在第 8 步之前一律按“正文未生成”处理），
//   不放进快照，组装结果与用完整目录组装的相同（tests/db/technicalPlanExportRequest.test.ts 核对）；
// - 入队前就能确定的错误直接拒绝，不保存：没有目录 400 EXPORT_EMPTY、没有选择有效的模板 400 EXPORT_TEMPLATE_REQUIRED、
//   标题超过六级 400 EXPORT_HEADING_TOO_DEEP（与组装时的代码和文案相同）、快照过大 413 EXPORT_TOO_LARGE；
// - 结果只能写一次（completeTechnicalPlanExportRequest），完成时清空快照中的目录；
// - 每个项目只需要最近一次的请求：入队成功后删除本项目的其他请求、入队失败时删除刚保存的请求（deleteTechnicalPlanExportRequests），
//   不需要清理任务。
import type { Kysely, Selectable } from 'kysely';
import {
  TECHNICAL_PLAN_EXPORT_FORMAT_MAX_BYTES,
  TECHNICAL_PLAN_EXPORT_MESSAGE_MAX,
  TECHNICAL_PLAN_EXPORT_OUTLINE_MAX_BYTES,
  TECHNICAL_PLAN_EXPORT_WARNINGS_MAX_BYTES,
} from '../db/migrations/0029_technical_plan_export_requests.ts';
import { TECHNICAL_PLAN_CONTENT_MODES } from '../db/migrations/0019_technical_plan_outline.ts';
import { TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES } from '../db/migrations/0018_technical_plan.ts';
import type { Database, TechnicalPlanContentMode, TechnicalPlanExportRequestsTable } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { serializeJsonObject } from '../jsonObject.ts';
import { readState } from '../technicalPlan/store.ts';
import type { TechnicalPlanOutlineItem } from '../technicalPlan/outline.ts';
import { normalizeExportFormat, type ExportFormat } from '../templates/exportFormat.ts';
import { collectOutlineExportEntries, DOCUMENT_HEADING_LEVEL_MAX, type DocumentSnapshot } from './documentHtml.ts';

/** 快照中的一个目录节点：只有组装用得到的字段。 */
interface SnapshotItem {
  id: string;
  title: string;
  content_mode?: TechnicalPlanContentMode;
  content_mode_note?: string;
  /** 只有导出的叶子（不是 AI 小节）才有正文。 */
  content?: string;
  children?: SnapshotItem[];
}

export interface TechnicalPlanExportResult {
  /** 整本导出的 docx 产物；产物可能已被替换或过期删除，读取经 findArtifact。 */
  artifactId: string;
  /** 给用户看的提示（summarizeDocumentExport），按目录顺序。 */
  warnings: string[];
  /** 给用户看的消息。 */
  message: string;
}

export interface TechnicalPlanExportRequestRecord {
  id: string;
  projectId: string;
  createdBy: string;
  /** 目录的项目名称（入队时的快照，完成后仍保留，用于下载文件名，7.4h）；没有时为 null。 */
  projectName: string | null;
  /** 交给 assembleDocumentHtml 的快照；已完成的请求为 null（目录已清空）。 */
  snapshot: DocumentSnapshot | null;
  /** 所选模板规范化后的配置。 */
  exportFormat: ExportFormat;
  /** 结果；未完成时为 null。 */
  result: TechnicalPlanExportResult | null;
  createdAt: Date;
  completedAt: Date | null;
}

const TOO_LARGE_CODES = new Set(['23514', '54000']);

function exportEmpty(): AppError {
  return new AppError(400, 'EXPORT_EMPTY', '没有可导出的目录内容');
}

function tooLarge(cause?: unknown): AppError {
  return new AppError(413, 'EXPORT_TOO_LARGE', '目录与正文内容过多，无法导出', cause === undefined ? undefined : { cause });
}

/** 与桌面版 technicalPlanExport.prepare 相同的内容：只保留组装用得到的字段（见文件头）。 */
function snapshotItems(items: readonly TechnicalPlanOutlineItem[]): SnapshotItem[] {
  return items.map((item) => {
    const children = item.children?.length ? snapshotItems(item.children) : undefined;
    return {
      id: item.id,
      title: item.title,
      ...(item.content_mode !== undefined ? { content_mode: item.content_mode } : {}),
      ...(item.content_mode_note !== undefined ? { content_mode_note: item.content_mode_note } : {}),
      ...(!children && item.content_mode !== 'ai-generate' && item.content ? { content: item.content } : {}),
      ...(children ? { children } : {}),
    };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读回快照中的目录（本表只由 saveTechnicalPlanExportRequest 写入，这里只核对形态，不符时抛 TypeError）。 */
function parseSnapshotItems(raw: unknown, depth = 1): TechnicalPlanOutlineItem[] {
  if (!Array.isArray(raw) || depth > 64) throw new TypeError('整本导出快照的目录不合法');
  return raw.map((value) => {
    if (!isPlainObject(value)) throw new TypeError('整本导出快照的目录不合法');
    const { id, title, content_mode: mode, content_mode_note: note, content, children, ...rest } = value;
    if (Object.keys(rest).length > 0 || typeof id !== 'string' || typeof title !== 'string') throw new TypeError('整本导出快照的目录不合法');
    if (mode !== undefined && !(TECHNICAL_PLAN_CONTENT_MODES as readonly unknown[]).includes(mode)) throw new TypeError('整本导出快照的目录不合法');
    if ((note !== undefined && typeof note !== 'string') || (content !== undefined && typeof content !== 'string')) {
      throw new TypeError('整本导出快照的目录不合法');
    }
    return {
      id,
      title,
      description: '',
      number: '',
      ...(mode !== undefined ? { content_mode: mode as TechnicalPlanContentMode } : {}),
      ...(note !== undefined ? { content_mode_note: note } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(children !== undefined ? { children: parseSnapshotItems(children, depth + 1) } : {}),
    };
  });
}

function toRecord(row: Selectable<TechnicalPlanExportRequestsTable>): TechnicalPlanExportRequestRecord {
  if (!(TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES as readonly string[]).includes(row.export_template_scope)) {
    throw new TypeError('整本导出快照的模板范围不合法');
  }
  return {
    id: row.id,
    projectId: row.project_id,
    createdBy: row.created_by,
    projectName: row.project_name,
    snapshot: row.outline === null
      ? null
      : { projectName: row.project_name, exportTemplateScope: row.export_template_scope, outline: parseSnapshotItems(row.outline) },
    exportFormat: normalizeExportFormat(row.export_format),
    result: row.completed_at === null
      ? null
      : { artifactId: row.artifact_id!, warnings: row.warnings!, message: row.message! },
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * 取快照并保存为一个整本导出请求（以当前用户的身份）。项目不存在、属于其他组织、已删除或不是技术方案项目时，状态读出来是空的，
 * 按没有目录处理（路由先经 requireProject 返回 404）。
 */
export async function saveTechnicalPlanExportRequest(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
): Promise<TechnicalPlanExportRequestRecord> {
  try {
    return await withTenant(db, context, async (trx) => {
      const state = await readState(trx, projectId);
      const outline = state.outlineData?.outline ?? [];
      if (outline.length === 0) throw exportEmpty();
      // 与组装（assembleDocumentHtml）相同的检查，入队前就拒绝。
      if (collectOutlineExportEntries(outline, state.exportTemplateScope === 'ai-only').some((entry) => entry.level > DOCUMENT_HEADING_LEVEL_MAX)) {
        throw new AppError(400, 'EXPORT_HEADING_TOO_DEEP', '当前转换器最多支持六级章节标题');
      }
      const template = state.exportTemplateId === null
        ? undefined
        : await trx.selectFrom('export_templates').select('config').where('id', '=', state.exportTemplateId).executeTakeFirst();
      // 与桌面版 prepare 相同的文案（“长嘛样”是技术方案中选择模板的页面）。
      if (!template) throw new AppError(400, 'EXPORT_TEMPLATE_REQUIRED', '请先到“长嘛样”选择有效的导出模板');
      const exportFormat = serializeJsonObject(normalizeExportFormat(template.config) as Record<string, unknown>, TECHNICAL_PLAN_EXPORT_FORMAT_MAX_BYTES);
      if (exportFormat === 'too-deep' || exportFormat === 'too-large') throw tooLarge();
      // jsonb 的文本形式（冒号、逗号之后有空格）比 JSON.stringify 略长，超出的由 CHECK 约束兜底（23514 → 413）。
      const outlineJson = JSON.stringify(snapshotItems(outline));
      if (Buffer.byteLength(outlineJson, 'utf8') > TECHNICAL_PLAN_EXPORT_OUTLINE_MAX_BYTES) throw tooLarge();
      const row = await trx
        .insertInto('technical_plan_export_requests')
        .values({
          org_id: context.orgId,
          project_id: projectId,
          created_by: context.userId,
          project_name: state.outlineData?.project_name || null,
          export_template_scope: state.exportTemplateScope,
          export_format: exportFormat,
          outline: outlineJson,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && TOO_LARGE_CODES.has(code)) throw tooLarge(error);
    throw error;
  }
}

/** 本组织内、项目未删除的整本导出请求；其他组织的、项目已删除的、已被删除的都返回 null。 */
export async function findTechnicalPlanExportRequest(
  db: Kysely<Database>,
  context: TenantContext,
  requestId: string,
): Promise<TechnicalPlanExportRequestRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx.selectFrom('technical_plan_export_requests').selectAll().where('id', '=', requestId).executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

/** 写入结果并清空快照中的目录（只能写一次）。请求不存在或已有结果时返回 null。 */
export async function completeTechnicalPlanExportRequest(
  db: Kysely<Database>,
  context: TenantContext,
  requestId: string,
  result: TechnicalPlanExportResult,
): Promise<TechnicalPlanExportRequestRecord | null> {
  if (!result.warnings.every((warning) => typeof warning === 'string')) throw new TypeError('整本导出的提示必须是字符串');
  const warnings = JSON.stringify(result.warnings);
  if (Buffer.byteLength(warnings, 'utf8') > TECHNICAL_PLAN_EXPORT_WARNINGS_MAX_BYTES) throw new TypeError('整本导出的提示过多');
  if (!result.message || [...result.message].length > TECHNICAL_PLAN_EXPORT_MESSAGE_MAX) throw new TypeError('整本导出的消息不合法');
  const row = await withTenant(db, context, (trx) =>
    trx
      .updateTable('technical_plan_export_requests')
      .set({ outline: null, artifact_id: result.artifactId, warnings, message: result.message })
      .where('id', '=', requestId)
      .where('completed_at', 'is', null)
      .returningAll()
      .executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

/**
 * 删除本项目的整本导出请求：给出 exceptId 时删除其他的（入队成功后），给出 onlyId 时只删除这一个（入队失败时）。
 * 返回删除的行数。
 */
export async function deleteTechnicalPlanExportRequests(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  target: { exceptId: string; onlyId?: undefined } | { onlyId: string; exceptId?: undefined },
): Promise<number> {
  const result = await withTenant(db, context, (trx) => {
    let query = trx.deleteFrom('technical_plan_export_requests').where('project_id', '=', projectId);
    query = target.onlyId !== undefined ? query.where('id', '=', target.onlyId) : query.where('id', '<>', target.exceptId);
    return query.executeTakeFirst();
  });
  return Number(result.numDeletedRows);
}
