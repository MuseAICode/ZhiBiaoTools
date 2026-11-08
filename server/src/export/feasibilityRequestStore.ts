// 可研报告导出 Word 的请求（路线图第 7 步 7.5c，迁移 0030_feasibility_report_export）：入队时取快照、任务读取快照、写回结果。
// 可研导出任务与入队（7.5d）调用，本模块不接任务和接口。组织和用户一律来自 TenantContext，所有查询都经 withTenant。
// 与整本导出的请求（src/export/documentRequestStore.ts）写法相同：
//
// - 快照（与桌面版可研页面交给 export.word 的内容相同）：项目名称（项目信息中的名称）、请求所选模板经 normalizeExportFormat
//   规范化后的配置（模板由服务端按 id 读取，不接受前端传来的配置）、导出选项（三个开关、编制单位、密级、文件编号，
//   文件编号为空时按桌面版规则生成 KYBG- 加时间戳后 6 位）与项目信息、只含导出用得到的字段的目录（父节点的正文不导出，
//   不放进快照），在同一事务中读取，之后对目录、正文、项目信息或模板的修改不影响这次导出；
// - 入队前就能确定的错误直接拒绝，不保存：没有目录 400 EXPORT_EMPTY、模板不存在或不可见 400 EXPORT_TEMPLATE_REQUIRED、
//   导出选项不合法 400 EXPORT_OPTIONS_INVALID、快照过大 413 EXPORT_TOO_LARGE；
// - 结果只能写一次（completeFeasibilityExportRequest），完成时清空快照中的目录；
// - 每个项目只需要最近一次的请求（deleteFeasibilityExportRequests），不需要清理任务。
import type { Kysely, Selectable } from 'kysely';
import { FEASIBILITY_FIELD_MAX } from '../db/migrations/0017_feasibility_report.ts';
import {
  FEASIBILITY_REPORT_EXPORT_FORMAT_MAX_BYTES,
  FEASIBILITY_REPORT_EXPORT_MESSAGE_MAX,
  FEASIBILITY_REPORT_EXPORT_OPTIONS_MAX_BYTES,
  FEASIBILITY_REPORT_EXPORT_OUTLINE_MAX_BYTES,
  FEASIBILITY_REPORT_EXPORT_WARNINGS_MAX_BYTES,
} from '../db/migrations/0030_feasibility_report_export.ts';
import type { Database, FeasibilityReportExportRequestsTable } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { readState, type FeasibilityOutlineItem, type FeasibilityProjectInfo } from '../feasibilityReport/store.ts';
import { serializeJsonObject } from '../jsonObject.ts';
import { normalizeExportFormat, type ExportFormat } from '../templates/exportFormat.ts';
import type { FeasibilityExportOptions, FeasibilityExportOutlineItem } from './feasibility.ts';

/** 前端可选的导出选项（与桌面版 FeasibilityExportOptions 相同）；未给出的取桌面版的默认值。 */
export interface FeasibilityExportOptionsInput {
  includeCover?: boolean;
  includePreparationNotes?: boolean;
  includeAppendixTables?: boolean;
  preparationUnit?: string;
  securityLevel?: string;
  documentCode?: string;
}

/** 与桌面版 DEFAULT_FEASIBILITY_EXPORT_OPTIONS（client/src/features/feasibility-report/types.ts）相同。 */
export const DEFAULT_FEASIBILITY_EXPORT_OPTIONS: Readonly<Required<FeasibilityExportOptionsInput>> = Object.freeze({
  includeCover: true,
  includePreparationNotes: true,
  includeAppendixTables: true,
  preparationUnit: '可行性研究报告编制中心',
  securityLevel: '内部资料 / 普通',
  documentCode: '',
});

/** 编制单位、密级、文件编号的字数上限（与项目信息字段相同，0017 的 FEASIBILITY_FIELD_MAX）。 */
export const FEASIBILITY_EXPORT_OPTION_TEXT_MAX = FEASIBILITY_FIELD_MAX;

export interface FeasibilityExportResult {
  /** 可研导出的 docx 产物；产物可能已被替换或过期删除，读取经 findArtifact。 */
  artifactId: string;
  /** 给用户看的提示（桌面版可研导出代码生成的文字），按文档顺序。 */
  warnings: string[];
  /** 给用户看的消息。 */
  message: string;
}

export interface FeasibilityExportRequestRecord {
  id: string;
  projectId: string;
  createdBy: string;
  /** 项目信息中的名称（入队时的快照）；没有时为 null（交给桌面版代码时用“可行性研究报告”）。 */
  projectName: string | null;
  /** 所选模板规范化后的配置。 */
  exportFormat: ExportFormat;
  /** 导出选项与项目信息（入队时的快照，文件编号已补齐）。 */
  options: FeasibilityExportOptions;
  /** 快照中的目录；已完成的请求为 null（目录已清空）。 */
  outline: FeasibilityExportOutlineItem[] | null;
  /** 结果；未完成时为 null。 */
  result: FeasibilityExportResult | null;
  createdAt: Date;
  completedAt: Date | null;
}

const TOO_LARGE_CODES = new Set(['23514', '54000']);
const OPTION_FLAGS = ['includeCover', 'includePreparationNotes', 'includeAppendixTables'] as const;
const OPTION_TEXTS = ['preparationUnit', 'securityLevel', 'documentCode'] as const;
const PROJECT_INFO_KEYS: readonly (keyof FeasibilityProjectInfo)[] = [
  'projectName', 'projectType', 'industry', 'constructionUnit', 'location', 'constructionContent',
  'constructionPeriodYears', 'operationPeriodYears', 'totalInvestment', 'fundingSource',
];

function exportEmpty(): AppError {
  return new AppError(400, 'EXPORT_EMPTY', '没有可导出的目录内容');
}

function tooLarge(cause?: unknown): AppError {
  return new AppError(413, 'EXPORT_TOO_LARGE', '目录与正文内容过多，无法导出', cause === undefined ? undefined : { cause });
}

function optionsInvalid(message: string): AppError {
  return new AppError(400, 'EXPORT_OPTIONS_INVALID', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 文件编号为空时与桌面版 Renderer 相同的规则：KYBG- 加当前时间戳（毫秒）的后 6 位。 */
export function defaultDocumentCode(now: Date = new Date()): string {
  return `KYBG-${now.getTime().toString().slice(-6)}`;
}

/** 校验并补齐导出选项（未知字段由接口的 schema 拒绝；这里再核对类型与长度）。 */
export function resolveFeasibilityExportOptions(input: FeasibilityExportOptionsInput, projectInfo: FeasibilityProjectInfo, now = new Date()): FeasibilityExportOptions {
  if (!isPlainObject(input)) throw optionsInvalid('导出选项不合法');
  const options = { ...DEFAULT_FEASIBILITY_EXPORT_OPTIONS };
  for (const [key, value] of Object.entries(input)) {
    if ((OPTION_FLAGS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') throw optionsInvalid('导出选项不合法');
      (options as Record<string, unknown>)[key] = value;
    } else if ((OPTION_TEXTS as readonly string[]).includes(key)) {
      if (typeof value !== 'string' || [...value].length > FEASIBILITY_EXPORT_OPTION_TEXT_MAX) {
        throw optionsInvalid(`编制单位、密级与文件编号不能超过 ${FEASIBILITY_EXPORT_OPTION_TEXT_MAX} 字`);
      }
      (options as Record<string, unknown>)[key] = value;
    } else {
      throw optionsInvalid('导出选项不合法');
    }
  }
  return {
    includeCover: options.includeCover,
    includePreparationNotes: options.includePreparationNotes,
    includeAppendixTables: options.includeAppendixTables,
    preparationUnit: options.preparationUnit,
    securityLevel: options.securityLevel,
    documentCode: options.documentCode.trim() || defaultDocumentCode(now),
    projectInfo: Object.fromEntries(PROJECT_INFO_KEYS.map((key) => [key, String(projectInfo[key] ?? '')])),
  };
}

/** 只保留导出用得到的字段：标题、子节点与叶子的正文（桌面版 addOutlineItem 不导出父节点的正文）。 */
function snapshotItems(items: readonly FeasibilityOutlineItem[]): FeasibilityExportOutlineItem[] {
  return items.map((item) => {
    const children = item.children?.length ? snapshotItems(item.children) : undefined;
    return {
      id: item.id,
      title: item.title,
      ...(!children && item.content ? { content: item.content } : {}),
      ...(children ? { children } : {}),
    };
  });
}

/** 读回快照中的目录（本表只由 saveFeasibilityExportRequest 写入，这里只核对形态，不符时抛 TypeError）。 */
function parseSnapshotItems(raw: unknown, depth = 1): FeasibilityExportOutlineItem[] {
  if (!Array.isArray(raw) || depth > 64) throw new TypeError('可研导出快照的目录不合法');
  return raw.map((value) => {
    if (!isPlainObject(value)) throw new TypeError('可研导出快照的目录不合法');
    const { id, title, content, children, ...rest } = value;
    if (Object.keys(rest).length > 0 || typeof id !== 'string' || typeof title !== 'string') throw new TypeError('可研导出快照的目录不合法');
    if (content !== undefined && typeof content !== 'string') throw new TypeError('可研导出快照的目录不合法');
    return {
      id,
      title,
      ...(content !== undefined ? { content } : {}),
      ...(children !== undefined ? { children: parseSnapshotItems(children, depth + 1) } : {}),
    };
  });
}

/** 读回快照中的导出选项（形态不符时抛 TypeError）。 */
function parseOptions(raw: unknown): FeasibilityExportOptions {
  if (!isPlainObject(raw)) throw new TypeError('可研导出快照的选项不合法');
  const { projectInfo, ...rest } = raw;
  for (const key of OPTION_FLAGS) if (typeof rest[key] !== 'boolean') throw new TypeError('可研导出快照的选项不合法');
  for (const key of OPTION_TEXTS) if (typeof rest[key] !== 'string') throw new TypeError('可研导出快照的选项不合法');
  if (Object.keys(rest).length !== OPTION_FLAGS.length + OPTION_TEXTS.length || !isPlainObject(projectInfo)) {
    throw new TypeError('可研导出快照的选项不合法');
  }
  if (!Object.entries(projectInfo).every(([key, value]) => (PROJECT_INFO_KEYS as readonly string[]).includes(key) && typeof value === 'string')) {
    throw new TypeError('可研导出快照的选项不合法');
  }
  return { ...(rest as Omit<FeasibilityExportOptions, 'projectInfo'>), projectInfo: projectInfo as Record<string, string> };
}

function toRecord(row: Selectable<FeasibilityReportExportRequestsTable>): FeasibilityExportRequestRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    createdBy: row.created_by,
    projectName: row.project_name,
    exportFormat: normalizeExportFormat(row.export_format),
    options: parseOptions(row.options),
    outline: row.outline === null ? null : parseSnapshotItems(row.outline),
    result: row.completed_at === null
      ? null
      : { artifactId: row.artifact_id!, warnings: row.warnings!, message: row.message! },
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export interface SaveFeasibilityExportRequestInput {
  /** 导出模板（export_templates.id，本组织的或系统模板）。 */
  templateId: string;
  options: FeasibilityExportOptionsInput;
}

/**
 * 取快照并保存为一个可研导出请求（以当前用户的身份）。项目不存在、属于其他组织、已删除或不是可研项目时，状态读出来是空的，
 * 按没有目录处理（路由先经 requireProject 返回 404）。
 */
export async function saveFeasibilityExportRequest(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: SaveFeasibilityExportRequestInput,
  now: Date = new Date(),
): Promise<FeasibilityExportRequestRecord> {
  try {
    return await withTenant(db, context, async (trx) => {
      const state = await readState(trx, projectId);
      const outline = state.outlineData?.outline ?? [];
      if (outline.length === 0) throw exportEmpty();
      const options = resolveFeasibilityExportOptions(input.options, state.projectInfo, now);
      const template = await trx.selectFrom('export_templates').select('config').where('id', '=', input.templateId).executeTakeFirst();
      if (!template) throw new AppError(400, 'EXPORT_TEMPLATE_REQUIRED', '请选择有效的导出模板');
      const exportFormat = serializeJsonObject(normalizeExportFormat(template.config) as Record<string, unknown>, FEASIBILITY_REPORT_EXPORT_FORMAT_MAX_BYTES);
      if (exportFormat === 'too-deep' || exportFormat === 'too-large') throw tooLarge();
      const optionsJson = serializeJsonObject(options as unknown as Record<string, unknown>, FEASIBILITY_REPORT_EXPORT_OPTIONS_MAX_BYTES);
      if (optionsJson === 'too-deep' || optionsJson === 'too-large') throw tooLarge();
      // jsonb 的文本形式比 JSON.stringify 略长，超出的由 CHECK 约束兜底（23514 → 413）。
      const outlineJson = JSON.stringify(snapshotItems(outline));
      if (Buffer.byteLength(outlineJson, 'utf8') > FEASIBILITY_REPORT_EXPORT_OUTLINE_MAX_BYTES) throw tooLarge();
      const row = await trx
        .insertInto('feasibility_report_export_requests')
        .values({
          org_id: context.orgId,
          project_id: projectId,
          created_by: context.userId,
          project_name: state.projectInfo.projectName.trim() || null,
          export_format: exportFormat,
          options: optionsJson,
          outline: outlineJson,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && TOO_LARGE_CODES.has(code)) throw tooLarge(error);
    // templateId 不是 uuid（接口的 schema 先挡住；这里兜底）。
    if (code === '22P02') throw new AppError(400, 'EXPORT_TEMPLATE_REQUIRED', '请选择有效的导出模板', { cause: error });
    throw error;
  }
}

/** 本组织内、项目未删除的可研导出请求；其他组织的、项目已删除的、已被删除的都返回 null。 */
export async function findFeasibilityExportRequest(
  db: Kysely<Database>,
  context: TenantContext,
  requestId: string,
): Promise<FeasibilityExportRequestRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx.selectFrom('feasibility_report_export_requests').selectAll().where('id', '=', requestId).executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

/** 写入结果并清空快照中的目录（只能写一次）。请求不存在或已有结果时返回 null。 */
export async function completeFeasibilityExportRequest(
  db: Kysely<Database>,
  context: TenantContext,
  requestId: string,
  result: FeasibilityExportResult,
): Promise<FeasibilityExportRequestRecord | null> {
  if (!result.warnings.every((warning) => typeof warning === 'string')) throw new TypeError('可研导出的提示必须是字符串');
  const warnings = JSON.stringify(result.warnings);
  if (Buffer.byteLength(warnings, 'utf8') > FEASIBILITY_REPORT_EXPORT_WARNINGS_MAX_BYTES) throw new TypeError('可研导出的提示过多');
  if (!result.message || [...result.message].length > FEASIBILITY_REPORT_EXPORT_MESSAGE_MAX) throw new TypeError('可研导出的消息不合法');
  const row = await withTenant(db, context, (trx) =>
    trx
      .updateTable('feasibility_report_export_requests')
      .set({ outline: null, artifact_id: result.artifactId, warnings, message: result.message })
      .where('id', '=', requestId)
      .where('completed_at', 'is', null)
      .returningAll()
      .executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

/**
 * 删除本项目的可研导出请求：给出 exceptId 时删除其他的（入队成功后），给出 onlyId 时只删除这一个（入队失败时）。
 * 返回删除的行数。
 */
export async function deleteFeasibilityExportRequests(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  target: { exceptId: string; onlyId?: undefined } | { onlyId: string; exceptId?: undefined },
): Promise<number> {
  const result = await withTenant(db, context, (trx) => {
    let query = trx.deleteFrom('feasibility_report_export_requests').where('project_id', '=', projectId);
    query = target.onlyId !== undefined ? query.where('id', '=', target.onlyId) : query.where('id', '<>', target.exceptId);
    return query.executeTakeFirst();
  });
  return Number(result.numDeletedRows);
}
