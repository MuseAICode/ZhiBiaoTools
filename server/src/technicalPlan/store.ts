// 技术方案（一）的读写（迁移 0018_technical_plan）：页面状态、招标文件与原方案、统一生成配置（含选中的招标解析项、引用的
// 知识库文档和导出模板）、招标解析项的结果、多标段识别与投标范围选择。组织和用户一律来自 TenantContext，所有查询都经
// withTenant；项目由路由先经 requireProject 校验（kind = technical-plan）。
//
// 可见性、写权限和删除可见性由 RLS 保证，这里不判断：所属项目已删除时六张表的行都查不到、改不了；文档随原件的生命周期，
// 原件已删除（进入回收站）时文档行不可见；引用的知识库文档不可见时引用行同样不可见；导出模板只能是本组织的或系统模板。
// 导入招标文件、上传原方案就是把已上传的 tender 文件挂到本项目（files.project_id，设置后不能再改，由迁移 0015 的触发器
// 保证）并登记到 technical_plan_documents，文档停在待解析；移除和清空时软删除原件（进回收站，按文件自己的恢复期处理），
// 应用角色没有文档的 DELETE 授权。
//
// 与桌面版 technicalPlanStore.cjs（经 taskService 调用的版本）相同：导入或移除招标文件时清空招标解析结果、多标段识别结果和
// 投标范围，生成配置恢复默认值，步骤回到 document-analysis（clearDownstreamFromTender）；切换单 / 多标段或选择投标范围时
// 清空招标解析结果、引用的知识库文档和正文生成选项，步骤回到 bid-analysis（clearDownstreamFromBidSectionChange）；移除原方案
// 时目录扩展方式恢复为 ai-complement。目录、全局事实（5.12）和正文（5.13）的下游清空随对应的 PR 加入这两个函数。
//
// 桌面版合并的招标正文（tender-original.md）和按投标范围裁剪的工作副本（tender.md）不再保存：读取时由各招标文件解析出的
// Markdown 现算（readTenderMarkdown），投标范围只记 id 和标题。给第 6 步任务用的写函数：saveDocumentParse（文档的解析
// 结果）、saveBidItems（招标解析项的结果）、prepareBidSectionExtraction / saveBidSectionExtraction（多标段识别）。
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  TECHNICAL_PLAN_BID_SECTION_MODES,
  TECHNICAL_PLAN_BID_ITEM_CONTENT_MAX,
  TECHNICAL_PLAN_BID_SECTIONS_MAX_BYTES,
  TECHNICAL_PLAN_DEFAULT_HTML_IMAGE_TYPES,
  TECHNICAL_PLAN_DOCUMENT_STATUSES,
  TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES,
  TECHNICAL_PLAN_GLOBAL_FACTS_MODES,
  TECHNICAL_PLAN_HTML_IMAGE_TYPES_MAX,
  TECHNICAL_PLAN_IMAGE_QUANTITIES,
  TECHNICAL_PLAN_KEY_MAX,
  TECHNICAL_PLAN_LABEL_MAX,
  TECHNICAL_PLAN_OUTLINE_EXPANSION_MODES,
  TECHNICAL_PLAN_OUTLINE_MODES,
  TECHNICAL_PLAN_RUN_STATUSES,
  TECHNICAL_PLAN_STEPS,
  TECHNICAL_PLAN_TABLE_REQUIREMENTS,
  TECHNICAL_PLAN_TEXT_MAX,
  TECHNICAL_PLAN_WORDS_MAX,
} from '../db/migrations/0018_technical_plan.ts';
import type {
  Database,
  TechnicalPlanBidAnalysisMode,
  TechnicalPlanBidItemId,
  TechnicalPlanBidSection,
  TechnicalPlanBidSectionMode,
  TechnicalPlanDocumentRole,
  TechnicalPlanDocumentStatus,
  TechnicalPlanExportTemplateScope,
  TechnicalPlanGlobalFactsMode,
  TechnicalPlanImageQuantity,
  TechnicalPlanOutlineExpansionMode,
  TechnicalPlanOutlineMode,
  TechnicalPlanRunStatus,
  TechnicalPlanStep,
  TechnicalPlanTableRequirement,
} from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { storageDisabled } from '../knowledgeBase/content.ts';
import {
  bidAnalysisProgress,
  bidItemLabel,
  bidItemSortOrder,
  BidSectionError,
  buildSelectedSectionMarkdown,
  combineTenderMarkdown,
  isBidItemId,
  normalizeBidAnalysisConfig,
  normalizeBidSections,
} from './tender.ts';

/** 每个项目最多的招标文件数（与其他模块相同）。 */
export const TECHNICAL_PLAN_TENDER_FILES_MAX = 20;
/** 生成配置最多引用的知识库文档数。 */
export const TECHNICAL_PLAN_REFERENCE_DOCUMENTS_MAX = 100;
/** 在线读取合并的招标正文时 Markdown 的总大小上限（整份读入内存）。 */
export const TECHNICAL_PLAN_MARKDOWN_READ_MAX_BYTES = 32 * 1024 * 1024;
/** 默认的导出模板：系统模板“标准投标”（桌面版 tpl-system-standard-bid）。 */
export const DEFAULT_EXPORT_TEMPLATE_KEY = 'standard-bid';

// ---- 读出的状态 ----

export interface TechnicalPlanDocument {
  /** files.id。 */
  id: string;
  fileName: string;
  extension: string;
  size: number;
  uploadedAt: Date;
  importedAt: Date;
  /** 解析状态；新导入的文档是 pending，由第 6 步的解析任务更新。 */
  status: TechnicalPlanDocumentStatus;
  /** 解析出的 Markdown（生成产物），经 /api/artifacts/:artifactId/content 读取。 */
  markdownArtifactId: string | null;
  contentChars: number;
  contentHash: string | null;
  parserLabel: string | null;
  error: string | null;
}

export interface TechnicalPlanBidItem {
  id: TechnicalPlanBidItemId;
  label: string;
  status: TechnicalPlanRunStatus;
  content: string;
  error: string | null;
}

export interface OutlineWordControlOptions {
  minimumWords: number;
  maximumWords: number;
  sectionWords: number;
}

/** 与桌面版 Renderer 的 ContentGenerationOptions 相同。 */
export interface ContentGenerationOptions {
  imageQuantity: TechnicalPlanImageQuantity;
  useAiImages: boolean;
  useMermaidImages: boolean;
  useHtmlImages: boolean;
  htmlImageOptimization: boolean;
  wordCountRepair: boolean;
  layoutCheck: boolean;
  useSingleImageLayout: boolean;
  useImageTextLayout: boolean;
  useThreeImagesLayout: boolean;
  useFourImagesLayout: boolean;
  htmlImageTypes: string;
  tableRequirement: TechnicalPlanTableRequirement;
}

/** 与桌面版 Renderer 的 TechnicalPlanGenerationConfig 相同，exportTemplateId 是 export_templates.id（未选择时为 null）。 */
export interface TechnicalPlanGenerationConfig {
  bidAnalysisMode: TechnicalPlanBidAnalysisMode;
  bidAnalysisSelectedTaskIds: TechnicalPlanBidItemId[];
  bidSectionMode: TechnicalPlanBidSectionMode;
  outlineMode: TechnicalPlanOutlineMode;
  outlineExpansionMode: TechnicalPlanOutlineExpansionMode;
  outlineWordControlOptions: OutlineWordControlOptions;
  /** 引用的知识库文档 id（只含当前可见的文档）。 */
  referenceKnowledgeDocumentIds: string[];
  globalFactsMode: TechnicalPlanGlobalFactsMode;
  exportTemplateId: string | null;
  exportTemplateScope: TechnicalPlanExportTemplateScope;
  contentGenerationOptions: ContentGenerationOptions;
}

export interface TechnicalPlanState extends TechnicalPlanGenerationConfig {
  step: TechnicalPlanStep;
  /** 招标文件，按导入顺序。 */
  tenderFiles: TechnicalPlanDocument[];
  originalPlanFile: TechnicalPlanDocument | null;
  /** 选中的投标范围（多标段时）；工作副本经 .../tender-markdown 读取。 */
  selectedSection: { id: string; title: string } | null;
  /** 项目概述、技术评分要求两项解析成功时的内容（与桌面版相同，否则为空）。 */
  projectOverview: string;
  techRequirements: string;
  bidAnalysisTasks: Partial<Record<TechnicalPlanBidItemId, TechnicalPlanBidItem>>;
  bidAnalysisProgress: number;
  bidSections: TechnicalPlanBidSection[];
  bidSectionExtractionStatus: TechnicalPlanRunStatus;
  bidSectionExtractionError: string | null;
  /** 后台任务状态随第 6 步（jobs），本步一律为 null。 */
  bidSectionExtractionTask: null;
  bidAnalysisTask: null;
}

// ---- 错误 ----

function invalid(message: string): AppError {
  return new AppError(400, 'TECHNICAL_PLAN_INVALID', message);
}

function fileUnavailable(cause?: unknown): AppError {
  return new AppError(
    400,
    'TECHNICAL_PLAN_FILE_UNAVAILABLE',
    '文件不存在、未上传完成、已删除、不是招标文件或已用于其他项目',
    cause === undefined ? undefined : { cause },
  );
}

function referenceUnavailable(cause?: unknown): AppError {
  return new AppError(400, 'TECHNICAL_PLAN_REFERENCE_UNAVAILABLE', '知识库文档不存在或已删除', cause === undefined ? undefined : { cause });
}

function templateUnavailable(cause?: unknown): AppError {
  return new AppError(400, 'TECHNICAL_PLAN_TEMPLATE_UNAVAILABLE', '导出模板不存在或已删除', cause === undefined ? undefined : { cause });
}

function documentNotFound(): AppError {
  return new AppError(404, 'TECHNICAL_PLAN_DOCUMENT_NOT_FOUND', '招标文件不存在或已移除');
}

function markdownTooLarge(): AppError {
  return new AppError(422, 'TECHNICAL_PLAN_MARKDOWN_TOO_LARGE', '招标文件内容过大，无法在线读取');
}

// ---- 输入整理 ----

const hasOwn = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const charLength = (text: string) => [...text].length;
const stripNul = (text: string) => text.replaceAll('\u0000', '');

/** 任务写入的文本：去掉 PostgreSQL text 不接受的 \u0000，超长时截短。 */
function taskText(value: unknown, max: number): string {
  const text = stripNul(String(value ?? ''));
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = taskText(value, max);
  return text === '' ? null : text;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown, what: string): string {
  const text = String(value ?? '');
  if (!UUID.test(text)) throw new TypeError(`${what}不合法：${JSON.stringify(text.slice(0, 64))}`);
  return text.toLowerCase();
}

function optionalUuid(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : uuid(value, what);
}

function optionalKey(value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (charLength(text) > TECHNICAL_PLAN_KEY_MAX || text.includes('\u0000')) {
    throw new TypeError(`${what}不合法：${JSON.stringify(text.slice(0, TECHNICAL_PLAN_KEY_MAX))}`);
  }
  return text;
}

function count(value: unknown): number {
  const number = Math.round(Number(value ?? 0));
  return Number.isFinite(number) && number > 0 ? Math.min(number, 2_147_483_647) : 0;
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** 与桌面版 normalizeNonNegativeInteger 相同（向下取整，负数和非数字取 0），另限制上限。 */
function words(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), TECHNICAL_PLAN_WORDS_MAX) : 0;
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

type Trx = Transaction<Database>;

/** 同一项目的写操作（用户与任务）串行执行。 */
async function lockProject(trx: Trx, projectId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`technical_plan:${projectId}`}, 0))`.execute(trx);
}

// ---- 生成配置的整理（与桌面版 normalizeGenerationConfig 相同） ----

const DEFAULT_CONTENT_OPTIONS: ContentGenerationOptions = Object.freeze({
  imageQuantity: 30,
  useAiImages: true,
  useMermaidImages: true,
  useHtmlImages: true,
  htmlImageOptimization: false,
  wordCountRepair: false,
  layoutCheck: false,
  useSingleImageLayout: true,
  useImageTextLayout: true,
  useThreeImagesLayout: true,
  useFourImagesLayout: true,
  htmlImageTypes: TECHNICAL_PLAN_DEFAULT_HTML_IMAGE_TYPES,
  tableRequirement: 'heavy',
});

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 与桌面版 normalizeContentGenerationOptions 相同：整份替换，未给出的字段取默认值；另限制配图比例的取值和配图类型的长度。 */
function normalizeContentOptions(value: unknown): ContentGenerationOptions {
  const source = isObject(value) ? value : {};
  const flag = (field: keyof ContentGenerationOptions) => (hasOwn(source, field) ? Boolean(source[field]) : (DEFAULT_CONTENT_OPTIONS[field] as boolean));
  const htmlImageTypes = taskText(source.htmlImageTypes || '', TECHNICAL_PLAN_HTML_IMAGE_TYPES_MAX);
  return {
    imageQuantity: oneOf(source.imageQuantity ?? DEFAULT_CONTENT_OPTIONS.imageQuantity, TECHNICAL_PLAN_IMAGE_QUANTITIES, DEFAULT_CONTENT_OPTIONS.imageQuantity),
    useAiImages: flag('useAiImages'),
    useMermaidImages: flag('useMermaidImages'),
    useHtmlImages: flag('useHtmlImages'),
    htmlImageOptimization: Boolean(source.htmlImageOptimization),
    wordCountRepair: Boolean(source.wordCountRepair),
    layoutCheck: Boolean(source.layoutCheck),
    useSingleImageLayout: flag('useSingleImageLayout'),
    useImageTextLayout: flag('useImageTextLayout'),
    useThreeImagesLayout: flag('useThreeImagesLayout'),
    useFourImagesLayout: flag('useFourImagesLayout'),
    htmlImageTypes: htmlImageTypes || DEFAULT_CONTENT_OPTIONS.htmlImageTypes,
    tableRequirement: oneOf(source.tableRequirement, TECHNICAL_PLAN_TABLE_REQUIREMENTS, DEFAULT_CONTENT_OPTIONS.tableRequirement),
  };
}

function normalizeDocumentIds(values: unknown): string[] {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean))];
}

/** 生成配置的完整取值；exportTemplateId 的有效性由数据库检查（策略与外键）。 */
function normalizeGenerationConfig(source: Partial<Record<keyof TechnicalPlanGenerationConfig, unknown>>): TechnicalPlanGenerationConfig {
  const bidAnalysis = normalizeBidAnalysisConfig(source.bidAnalysisMode, source.bidAnalysisSelectedTaskIds);
  const wordControl = isObject(source.outlineWordControlOptions) ? source.outlineWordControlOptions : {};
  const templateId = source.exportTemplateId;
  return {
    bidAnalysisMode: bidAnalysis.mode,
    bidAnalysisSelectedTaskIds: bidAnalysis.selectedTaskIds,
    bidSectionMode: source.bidSectionMode === 'multiple' ? 'multiple' : 'single',
    outlineMode: oneOf(source.outlineMode, TECHNICAL_PLAN_OUTLINE_MODES, 'standalone-technical'),
    outlineExpansionMode: oneOf(source.outlineExpansionMode, TECHNICAL_PLAN_OUTLINE_EXPANSION_MODES, 'ai-complement'),
    outlineWordControlOptions: {
      minimumWords: words(wordControl.minimumWords),
      maximumWords: words(wordControl.maximumWords),
      sectionWords: words(wordControl.sectionWords),
    },
    referenceKnowledgeDocumentIds: normalizeDocumentIds(source.referenceKnowledgeDocumentIds),
    globalFactsMode: oneOf(source.globalFactsMode, TECHNICAL_PLAN_GLOBAL_FACTS_MODES, 'fabricate'),
    exportTemplateId: typeof templateId === 'string' && templateId.trim() ? templateId.trim().toLowerCase() : null,
    exportTemplateScope: oneOf(source.exportTemplateScope, TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES, 'ai-only'),
    contentGenerationOptions: normalizeContentOptions(source.contentGenerationOptions),
  };
}

/** 系统模板“标准投标”的 id；系统模板尚未同步时为 null。 */
async function defaultTemplateId(trx: Trx): Promise<string | null> {
  const row = await trx
    .selectFrom('export_templates')
    .select('id')
    .where('org_id', 'is', null)
    .where('system_key', '=', DEFAULT_EXPORT_TEMPLATE_KEY)
    .executeTakeFirst();
  return row?.id ?? null;
}

/** 与桌面版 createDefaultGenerationConfig 相同。 */
async function defaultGenerationConfig(trx: Trx): Promise<TechnicalPlanGenerationConfig> {
  return normalizeGenerationConfig({ exportTemplateId: await defaultTemplateId(trx) });
}

// ---- 读取 ----

async function readDocuments(trx: Trx, projectId: string): Promise<(TechnicalPlanDocument & { role: TechnicalPlanDocumentRole })[]> {
  const rows = await trx
    .selectFrom('technical_plan_documents as d')
    .innerJoin('files as f', 'f.id', 'd.file_id')
    .select([
      'd.file_id',
      'd.role',
      'd.status',
      'd.markdown_artifact_id',
      'd.content_chars',
      'd.content_hash',
      'd.parser_label',
      'd.error',
      'd.created_at as imported_at',
      'f.display_name',
      'f.extension',
      'f.size_bytes',
      'f.uploaded_at',
      'f.created_at',
    ])
    .where('d.project_id', '=', projectId)
    .orderBy('d.sort_order')
    .orderBy('d.created_at')
    .orderBy('d.file_id')
    .execute();
  return rows.map((row) => ({
    id: row.file_id,
    role: row.role,
    fileName: row.display_name,
    extension: row.extension,
    size: Number(row.size_bytes ?? 0),
    uploadedAt: row.uploaded_at ?? row.created_at,
    importedAt: row.imported_at,
    status: oneOf(row.status, TECHNICAL_PLAN_DOCUMENT_STATUSES, 'pending'),
    markdownArtifactId: row.markdown_artifact_id,
    contentChars: row.content_chars,
    contentHash: row.content_hash,
    parserLabel: row.parser_label,
    error: row.error,
  }));
}

/** 读取生成配置；还没有保存过时返回默认值（不预先插入行）。 */
async function readGenerationConfig(trx: Trx, projectId: string): Promise<TechnicalPlanGenerationConfig> {
  const row = await trx.selectFrom('technical_plan_generation_config').selectAll().where('project_id', '=', projectId).executeTakeFirst();
  if (!row) return defaultGenerationConfig(trx);
  const taskIds = await trx
    .selectFrom('technical_plan_generation_bid_tasks')
    .select('task_id')
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('task_id')
    .execute();
  const documentIds = await trx
    .selectFrom('technical_plan_generation_reference_docs')
    .select('document_id')
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('document_id')
    .execute();
  return normalizeGenerationConfig({
    bidAnalysisMode: row.bid_analysis_mode,
    bidAnalysisSelectedTaskIds: taskIds.map((task) => task.task_id),
    bidSectionMode: row.bid_section_mode,
    outlineMode: row.outline_mode,
    outlineExpansionMode: row.outline_expansion_mode,
    outlineWordControlOptions: { minimumWords: row.minimum_words, maximumWords: row.maximum_words, sectionWords: row.section_words },
    referenceKnowledgeDocumentIds: documentIds.map((document) => document.document_id),
    globalFactsMode: row.global_facts_mode,
    exportTemplateId: row.export_template_id,
    exportTemplateScope: row.export_template_scope,
    contentGenerationOptions: {
      imageQuantity: row.image_quantity,
      useAiImages: row.use_ai_images,
      useMermaidImages: row.use_mermaid_images,
      useHtmlImages: row.use_html_images,
      htmlImageOptimization: row.html_image_optimization,
      wordCountRepair: row.word_count_repair,
      layoutCheck: row.layout_check,
      useSingleImageLayout: row.use_single_image_layout,
      useImageTextLayout: row.use_image_text_layout,
      useThreeImagesLayout: row.use_three_images_layout,
      useFourImagesLayout: row.use_four_images_layout,
      htmlImageTypes: row.html_image_types,
      tableRequirement: row.table_requirement,
    },
  });
}

async function readBidItems(trx: Trx, projectId: string): Promise<TechnicalPlanBidItem[]> {
  const rows = await trx
    .selectFrom('technical_plan_bid_items')
    .select(['item_id', 'label', 'status', 'content', 'error'])
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('item_id')
    .execute();
  return rows.map((row) => ({
    id: row.item_id,
    label: row.label,
    status: oneOf(row.status, TECHNICAL_PLAN_RUN_STATUSES, 'idle'),
    content: row.content,
    error: row.error,
  }));
}

/** 在已设置上下文的事务中读取完整状态（与桌面版 loadTechnicalPlan 中本步涉及的字段相同，任务状态先返回 null）。 */
export async function readState(trx: Trx, projectId: string): Promise<TechnicalPlanState> {
  const meta = await trx.selectFrom('technical_plan_meta').selectAll().where('project_id', '=', projectId).executeTakeFirst();
  const config = await readGenerationConfig(trx, projectId);
  const documents = await readDocuments(trx, projectId);
  const items = await readBidItems(trx, projectId);
  const strip = ({ role: _role, ...document }: TechnicalPlanDocument & { role: TechnicalPlanDocumentRole }): TechnicalPlanDocument => document;
  // 原方案只有一份；从回收站恢复了被替换的旧原方案时取最近导入的一份。
  const originalPlans = documents.filter((document) => document.role === 'original-plan');
  const originalPlan = originalPlans.reduce<(typeof originalPlans)[number] | null>(
    (latest, document) => (!latest || document.importedAt > latest.importedAt ? document : latest),
    null,
  );
  const tasks = Object.fromEntries(items.map((item) => [item.id, item])) as TechnicalPlanState['bidAnalysisTasks'];
  const succeeded = (id: TechnicalPlanBidItemId) => (tasks[id]?.status === 'success' ? tasks[id].content : '');
  return {
    step: meta?.step ?? 'document-analysis',
    tenderFiles: documents.filter((document) => document.role === 'tender').map(strip),
    originalPlanFile: originalPlan ? strip(originalPlan) : null,
    selectedSection: meta?.selected_section_id ? { id: meta.selected_section_id, title: meta.selected_section_title ?? '' } : null,
    projectOverview: succeeded('projectOverview'),
    techRequirements: succeeded('techRequirements'),
    ...config,
    bidAnalysisTasks: tasks,
    bidAnalysisProgress: bidAnalysisProgress(config.bidAnalysisSelectedTaskIds, new Map(items.map((item) => [item.id, item.status]))),
    bidSections: normalizeBidSections(meta?.bid_sections ?? []),
    bidSectionExtractionStatus: meta?.bid_section_extraction_status ?? 'idle',
    bidSectionExtractionError: meta?.bid_section_extraction_error ?? null,
    bidSectionExtractionTask: null,
    bidAnalysisTask: null,
  };
}

export async function loadTechnicalPlan(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<TechnicalPlanState> {
  return withTenant(db, context, (trx) => readState(trx, projectId));
}

// ---- 写入 ----

type MetaPatch = Partial<{
  step: TechnicalPlanStep;
  bid_sections: string | null;
  bid_section_extraction_status: TechnicalPlanRunStatus;
  bid_section_extraction_error: string | null;
  selected_section_id: string | null;
  selected_section_title: string | null;
}>;

async function writeMeta(trx: Trx, context: TenantContext, projectId: string, set: MetaPatch): Promise<void> {
  const query = trx.insertInto('technical_plan_meta').values({ project_id: projectId, org_id: context.orgId, ...set });
  await (Object.keys(set).length
    ? query.onConflict((oc) => oc.column('project_id').doUpdateSet(set))
    : query.onConflict((oc) => oc.column('project_id').doNothing())
  ).execute();
}

/** 多标段识别结果与投标范围恢复初始状态。 */
const RESET_BID_SECTIONS: MetaPatch = {
  bid_sections: null,
  bid_section_extraction_status: 'idle',
  bid_section_extraction_error: null,
  selected_section_id: null,
  selected_section_title: null,
};

/** 整份写入生成配置（与桌面版 writeGenerationConfig 相同），选中的招标解析项和引用的知识库文档整体替换。 */
async function writeGenerationConfig(trx: Trx, context: TenantContext, projectId: string, config: TechnicalPlanGenerationConfig): Promise<void> {
  const content = config.contentGenerationOptions;
  const set = {
    bid_analysis_mode: config.bidAnalysisMode,
    bid_section_mode: config.bidSectionMode,
    outline_mode: config.outlineMode,
    outline_expansion_mode: config.outlineExpansionMode,
    minimum_words: config.outlineWordControlOptions.minimumWords,
    maximum_words: config.outlineWordControlOptions.maximumWords,
    section_words: config.outlineWordControlOptions.sectionWords,
    global_facts_mode: config.globalFactsMode,
    export_template_id: config.exportTemplateId,
    export_template_scope: config.exportTemplateScope,
    use_ai_images: content.useAiImages,
    use_mermaid_images: content.useMermaidImages,
    use_html_images: content.useHtmlImages,
    html_image_types: content.htmlImageTypes,
    table_requirement: content.tableRequirement,
    image_quantity: content.imageQuantity,
    html_image_optimization: content.htmlImageOptimization,
    word_count_repair: content.wordCountRepair,
    layout_check: content.layoutCheck,
    use_single_image_layout: content.useSingleImageLayout,
    use_image_text_layout: content.useImageTextLayout,
    use_three_images_layout: content.useThreeImagesLayout,
    use_four_images_layout: content.useFourImagesLayout,
  };
  if (config.exportTemplateId !== null && !UUID.test(config.exportTemplateId)) throw templateUnavailable();
  try {
    await trx
      .insertInto('technical_plan_generation_config')
      .values({ project_id: projectId, org_id: context.orgId, ...set })
      .onConflict((oc) => oc.column('project_id').doUpdateSet(set))
      .execute();
  } catch (error) {
    // 42501：策略拒绝（其他组织的模板）；23503：外键（不存在的模板）。
    const code = errorCode(error);
    if (config.exportTemplateId !== null && (code === '42501' || code === '23503')) throw templateUnavailable(error);
    throw error;
  }
  await trx.deleteFrom('technical_plan_generation_bid_tasks').where('project_id', '=', projectId).execute();
  await trx
    .insertInto('technical_plan_generation_bid_tasks')
    .values(config.bidAnalysisSelectedTaskIds.map((taskId, index) => ({ org_id: context.orgId, project_id: projectId, task_id: taskId, sort_order: index })))
    .execute();
  const documentIds = config.referenceKnowledgeDocumentIds;
  if (documentIds.length > TECHNICAL_PLAN_REFERENCE_DOCUMENTS_MAX) throw invalid(`最多引用 ${TECHNICAL_PLAN_REFERENCE_DOCUMENTS_MAX} 个知识库文档`);
  if (!documentIds.every((id) => UUID.test(id))) throw referenceUnavailable();
  await trx.deleteFrom('technical_plan_generation_reference_docs').where('project_id', '=', projectId).execute();
  if (documentIds.length > 0) {
    try {
      await trx
        .insertInto('technical_plan_generation_reference_docs')
        .values(documentIds.map((documentId, index) => ({ org_id: context.orgId, project_id: projectId, document_id: documentId, sort_order: index })))
        .execute();
    } catch (error) {
      // 42501：INSERT 策略拒绝（文档不可见）；23503：外键（不存在或其他组织的文档）。
      const code = errorCode(error);
      if (code === '42501' || code === '23503') throw referenceUnavailable(error);
      throw error;
    }
  }
}

export type GenerationConfigPatch = Partial<Record<keyof TechnicalPlanGenerationConfig, unknown>>;

/** 与桌面版 updateGenerationConfig 相同：只替换给出的顶层字段，再整份整理和写入。 */
async function updateGenerationConfig(trx: Trx, context: TenantContext, projectId: string, partial: GenerationConfigPatch): Promise<void> {
  const current = await readGenerationConfig(trx, projectId);
  const merged: GenerationConfigPatch = { ...current };
  for (const key of Object.keys(current) as (keyof TechnicalPlanGenerationConfig)[]) {
    if (hasOwn(partial, key)) merged[key] = partial[key];
  }
  await writeGenerationConfig(trx, context, projectId, normalizeGenerationConfig(merged));
}

/** 与桌面版 clearDownstreamFromTender 相同：清空招标解析结果和多标段识别结果，生成配置恢复默认值，步骤回到第一步。 */
async function clearDownstreamFromTender(trx: Trx, context: TenantContext, projectId: string): Promise<void> {
  await trx.deleteFrom('technical_plan_bid_items').where('project_id', '=', projectId).execute();
  await writeGenerationConfig(trx, context, projectId, await defaultGenerationConfig(trx));
  await writeMeta(trx, context, projectId, { ...RESET_BID_SECTIONS, step: 'document-analysis' });
}

/** 与桌面版 clearDownstreamFromBidSectionChange 相同：清空招标解析结果、引用的知识库文档和正文生成选项，步骤回到招标解析。 */
async function clearDownstreamFromBidSectionChange(trx: Trx, context: TenantContext, projectId: string): Promise<void> {
  await trx.deleteFrom('technical_plan_bid_items').where('project_id', '=', projectId).execute();
  await updateGenerationConfig(trx, context, projectId, { referenceKnowledgeDocumentIds: [], contentGenerationOptions: DEFAULT_CONTENT_OPTIONS });
  await writeMeta(trx, context, projectId, { step: 'bid-analysis' });
}

/** 切换页面步骤（与桌面版 updateStep 相同）。 */
export async function updateStep(db: Kysely<Database>, context: TenantContext, projectId: string, step: TechnicalPlanStep): Promise<{ step: TechnicalPlanStep }> {
  const next = oneOf(step, TECHNICAL_PLAN_STEPS, 'document-analysis');
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await writeMeta(trx, context, projectId, { step: next });
    return { step: next };
  });
}

/**
 * 局部保存生成配置（与桌面版 saveGenerationConfig 相同）：只替换给出的字段。单 / 多标段切换时先清空下游
 * （clearDownstreamFromBidSectionChange）和多标段识别结果、投标范围。导出模板必须是本组织的或系统模板，引用的知识库
 * 文档必须可见，否则整体失败，返回 400。
 */
export async function saveGenerationConfig(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  partial: GenerationConfigPatch,
): Promise<TechnicalPlanState> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const current = await readGenerationConfig(trx, projectId);
    const nextSectionMode = hasOwn(partial, 'bidSectionMode') ? (partial.bidSectionMode === 'multiple' ? 'multiple' : 'single') : current.bidSectionMode;
    if (nextSectionMode !== current.bidSectionMode) {
      await clearDownstreamFromBidSectionChange(trx, context, projectId);
      await writeMeta(trx, context, projectId, RESET_BID_SECTIONS);
    }
    await updateGenerationConfig(trx, context, projectId, partial);
    return readState(trx, projectId);
  });
}

export interface BidAnalysisConfigInput {
  mode: TechnicalPlanBidAnalysisMode;
  selectedTaskIds: string[];
  bidSectionMode?: TechnicalPlanBidSectionMode;
}

/** 保存招标解析配置（与桌面版 saveBidAnalysisConfig 相同）：整理模式与选中项后经 saveGenerationConfig 保存。 */
export async function saveBidAnalysisConfig(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: BidAnalysisConfigInput,
): Promise<TechnicalPlanState> {
  const config = normalizeBidAnalysisConfig(input.mode, input.selectedTaskIds);
  return saveGenerationConfig(db, context, projectId, {
    bidAnalysisMode: config.mode,
    bidAnalysisSelectedTaskIds: config.selectedTaskIds,
    ...(input.bidSectionMode === undefined ? {} : { bidSectionMode: oneOf(input.bidSectionMode, TECHNICAL_PLAN_BID_SECTION_MODES, 'single') }),
  });
}

/** 保存正文生成选项（与桌面版 saveContentGenerationOptions 相同，整份替换，未给出的字段取默认值）。 */
export async function saveContentGenerationOptions(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  options: Partial<ContentGenerationOptions>,
): Promise<TechnicalPlanState> {
  return saveGenerationConfig(db, context, projectId, { contentGenerationOptions: options });
}

// ---- 招标文件与原方案 ----

/** 软删除文件（进回收站）。 */
async function trashFiles(trx: Trx, context: TenantContext, fileIds: string[]): Promise<number> {
  if (fileIds.length === 0) return 0;
  const result = await trx
    .updateTable('files')
    .set({ deleted_at: sql<Date>`now()`, deleted_by: context.userId })
    .where('id', 'in', fileIds)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/**
 * 把已上传的文件挂到本项目并登记为文档。已属于其他项目的文件由触发器 files_project_guard 拒绝（FS005，迁移 0015）；
 * 能否登记由 technical_plan_documents 的 INSERT 策略检查，这里的条件只为给出明确的错误。
 */
async function attachDocuments(
  trx: Trx,
  context: TenantContext,
  projectId: string,
  role: TechnicalPlanDocumentRole,
  fileIds: string[],
  firstSortOrder: number,
): Promise<void> {
  let claimed;
  try {
    claimed = await trx
      .updateTable('files')
      .set({ project_id: projectId })
      .where('id', 'in', fileIds)
      .where('purpose', '=', 'tender')
      .where('status', '=', 'uploaded')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  } catch (error) {
    // FS005：已属于其他项目；23503：外键（其他组织的项目）。
    const code = errorCode(error);
    if (code === 'FS005' || code === '23503') throw fileUnavailable(error);
    throw error;
  }
  if (Number(claimed.numUpdatedRows) !== fileIds.length) throw fileUnavailable();
  try {
    await trx
      .insertInto('technical_plan_documents')
      .values(fileIds.map((fileId, index) => ({ file_id: fileId, org_id: context.orgId, project_id: projectId, role, sort_order: firstSortOrder + index })))
      .execute();
  } catch (error) {
    // 42501：INSERT 策略拒绝（文件不可用）；23505：文件已登记（例如已是原方案，或原件在回收站时文档行不可见）；
    // 23503：外键（其他组织的文件）。
    const code = errorCode(error);
    if (code === '42501' || code === '23505' || code === '23503') throw fileUnavailable(error);
    throw error;
  }
}

async function visibleDocuments(trx: Trx, projectId: string, role: TechnicalPlanDocumentRole): Promise<{ file_id: string; sort_order: number }[]> {
  return trx.selectFrom('technical_plan_documents').select(['file_id', 'sort_order']).where('project_id', '=', projectId).where('role', '=', role).execute();
}

export interface ImportTenderFilesResult {
  addedCount: number;
  /** 已导入到本项目的文件（跳过）。 */
  skippedCount: number;
  state: TechnicalPlanState;
}

/**
 * 导入招标文件（取代桌面版 importTenderDocument）：与桌面版相同追加到已有招标文件之后，已导入到本项目的文件跳过。新文件
 * 挂到本项目（files.project_id）并登记，停在待解析（解析随第 6 步）。有新文件时清空下游（clearDownstreamFromTender）；
 * 全部跳过时不做改动。文件不可用（不存在、其他组织的、未上传完成、已删除、用途不是 tender、属于其他项目或已是原方案）时
 * 整体失败，返回 400；每个项目最多 TECHNICAL_PLAN_TENDER_FILES_MAX 份。
 */
export async function importTenderFiles(db: Kysely<Database>, context: TenantContext, projectId: string, fileIds: string[]): Promise<ImportTenderFilesResult> {
  const ids = [...new Set(fileIds.map((id) => id.toLowerCase()))];
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const existing = await visibleDocuments(trx, projectId, 'tender');
    const existingIds = new Set(existing.map((row) => row.file_id));
    const added = ids.filter((id) => !existingIds.has(id));
    if (added.length === 0) return { addedCount: 0, skippedCount: ids.length, state: await readState(trx, projectId) };
    if (existing.length + added.length > TECHNICAL_PLAN_TENDER_FILES_MAX) {
      throw new AppError(400, 'TECHNICAL_PLAN_DOCUMENT_LIMIT', `每个项目最多导入 ${TECHNICAL_PLAN_TENDER_FILES_MAX} 份招标文件`);
    }
    const next = existing.reduce((max, row) => Math.max(max, row.sort_order + 1), 0);
    await attachDocuments(trx, context, projectId, 'tender', added, next);
    await clearDownstreamFromTender(trx, context, projectId);
    return { addedCount: added.length, skippedCount: ids.length - added.length, state: await readState(trx, projectId) };
  });
}

/** 移除一份招标文件（取代桌面版 removeTenderDocument）：原件软删除（进回收站），文档行随之不可见；同时清空下游。 */
export async function removeTenderFile(db: Kysely<Database>, context: TenantContext, projectId: string, fileId: string): Promise<TechnicalPlanState> {
  const id = fileId.toLowerCase();
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (!(await visibleDocuments(trx, projectId, 'tender')).some((row) => row.file_id === id)) throw documentNotFound();
    await trashFiles(trx, context, [id]);
    await clearDownstreamFromTender(trx, context, projectId);
    return readState(trx, projectId);
  });
}

/**
 * 上传原方案（取代桌面版 importOriginalPlanDocument）：与桌面版相同替换已有的原方案（旧原件进回收站），不清空下游。
 * 新文件挂到本项目并登记，停在待解析；已是本项目原方案的文件不做改动。文件不可用时返回 400。
 */
export async function setOriginalPlan(db: Kysely<Database>, context: TenantContext, projectId: string, fileId: string): Promise<TechnicalPlanState> {
  const id = fileId.toLowerCase();
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const existing = (await visibleDocuments(trx, projectId, 'original-plan')).map((row) => row.file_id);
    if (!existing.includes(id)) {
      await attachDocuments(trx, context, projectId, 'original-plan', [id], 0);
    }
    await trashFiles(
      trx,
      context,
      existing.filter((existingId) => existingId !== id),
    );
    return readState(trx, projectId);
  });
}

/** 移除原方案（取代桌面版 removeOriginalPlanDocument）：原件软删除，目录扩展方式恢复为 ai-complement；没有原方案时不做改动。 */
export async function removeOriginalPlan(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<TechnicalPlanState> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const existing = (await visibleDocuments(trx, projectId, 'original-plan')).map((row) => row.file_id);
    if (existing.length > 0) {
      await trashFiles(trx, context, existing);
      await updateGenerationConfig(trx, context, projectId, { outlineExpansionMode: 'ai-complement' });
    }
    return readState(trx, projectId);
  });
}

export interface DocumentMarkdown {
  /** 解析出的 Markdown 产物的对象键和大小；还没有解析时为 null。 */
  artifact: { id: string; storageKey: string; size: number } | null;
}

/** 一份招标文件解析出的 Markdown 产物（桌面版 readTenderSourceMarkdown 读取的文件）。文档不可见时 404。 */
export async function findTenderFileMarkdown(db: Kysely<Database>, context: TenantContext, projectId: string, fileId: string): Promise<DocumentMarkdown> {
  const id = fileId.toLowerCase();
  return withTenant(db, context, async (trx) => {
    const document = await trx
      .selectFrom('technical_plan_documents')
      .select('markdown_artifact_id')
      .where('project_id', '=', projectId)
      .where('file_id', '=', id)
      .where('role', '=', 'tender')
      .executeTakeFirst();
    if (!document) throw documentNotFound();
    if (!document.markdown_artifact_id) return { artifact: null };
    // artifacts 的策略同样生效：产物不可见（例如写入中）时视为还没有 Markdown。
    const row = await trx
      .selectFrom('artifacts')
      .select(['id', 'storage_key', 'size_bytes'])
      .where('id', '=', document.markdown_artifact_id)
      .where('status', '=', 'ready')
      .executeTakeFirst();
    return { artifact: row ? { id: row.id, storageKey: row.storage_key, size: Number(row.size_bytes ?? 0) } : null };
  });
}

// ---- 合并的招标正文与投标范围 ----

interface TenderMarkdownSource {
  sections: TechnicalPlanBidSection[];
  selectedSectionId: string | null;
  /** 各招标文件已解析出的 Markdown 产物，按导入顺序；还没有解析的文件不在其中。 */
  artifacts: { storageKey: string; size: number }[];
}

async function tenderMarkdownSource(trx: Trx, projectId: string): Promise<TenderMarkdownSource> {
  const meta = await trx.selectFrom('technical_plan_meta').select(['bid_sections', 'selected_section_id']).where('project_id', '=', projectId).executeTakeFirst();
  const rows = await trx
    .selectFrom('technical_plan_documents as d')
    .innerJoin('artifacts as a', 'a.id', 'd.markdown_artifact_id')
    .select(['a.storage_key', 'a.size_bytes'])
    .where('d.project_id', '=', projectId)
    .where('d.role', '=', 'tender')
    .where('a.status', '=', 'ready')
    .orderBy('d.sort_order')
    .orderBy('d.created_at')
    .orderBy('d.file_id')
    .execute();
  return {
    sections: normalizeBidSections(meta?.bid_sections ?? []),
    selectedSectionId: meta?.selected_section_id ?? null,
    artifacts: rows.map((row) => ({ storageKey: row.storage_key, size: Number(row.size_bytes ?? 0) })),
  };
}

/** 读出各招标文件的 Markdown 并合并（与桌面版 tender-original.md 相同）。总大小超过上限时返回 422，不整体读入。 */
async function readCombinedMarkdown(objectStore: ObjectStore | null, artifacts: TenderMarkdownSource['artifacts']): Promise<string> {
  if (artifacts.length === 0) return '';
  if (!objectStore) throw storageDisabled();
  let total = artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
  if (total > TECHNICAL_PLAN_MARKDOWN_READ_MAX_BYTES) throw markdownTooLarge();
  total = 0;
  const markdowns: string[] = [];
  for (const artifact of artifacts) {
    const object = await objectStore.get(artifact.storageKey);
    if (!object) continue;
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) {
      const buffer = Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > TECHNICAL_PLAN_MARKDOWN_READ_MAX_BYTES) {
        object.body.destroy();
        throw markdownTooLarge();
      }
      chunks.push(buffer);
    }
    markdowns.push(Buffer.concat(chunks).toString('utf8'));
  }
  return combineTenderMarkdown(markdowns);
}

/**
 * 当前投标范围的招标正文（桌面版 readTenderMarkdown 读取的 tender.md）：各招标文件已解析出的 Markdown 按导入顺序合并；
 * 选择了投标范围时按标段裁剪。没有招标文件或都还没有解析时为空。第 6 步的招标解析任务同样经它读取。
 */
export async function readTenderMarkdown(db: Kysely<Database>, context: TenantContext, projectId: string, objectStore: ObjectStore | null): Promise<string> {
  const source = await withTenant(db, context, (trx) => tenderMarkdownSource(trx, projectId));
  const markdown = await readCombinedMarkdown(objectStore, source.artifacts);
  if (!markdown || !source.selectedSectionId || source.sections.length < 2) return markdown;
  try {
    return buildSelectedSectionMarkdown(markdown, source.sections, source.selectedSectionId);
  } catch (error) {
    if (error instanceof BidSectionError) throw new AppError(409, 'TECHNICAL_PLAN_BID_SECTION_INVALID', error.message, { cause: error });
    throw error;
  }
}

/**
 * 选择投标范围（与桌面版 selectBidSection 相同）：需要多标段识别出至少两个标段；按所选标段裁剪合并的招标正文，结果为空或
 * 标段没有有效范围时返回 400。成功后清空下游（clearDownstreamFromBidSectionChange），生成配置切到多标段。
 */
export async function selectBidSection(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  sectionId: string,
  objectStore: ObjectStore | null,
): Promise<TechnicalPlanState> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const source = await tenderMarkdownSource(trx, projectId);
    if (source.sections.length < 2) {
      throw new AppError(409, 'TECHNICAL_PLAN_BID_SECTIONS_UNAVAILABLE', '请先完成多标段识别，再选择投标范围');
    }
    const section = source.sections.find((candidate) => candidate.id === sectionId);
    const markdown = (await readCombinedMarkdown(objectStore, source.artifacts)).trim();
    if (!markdown) throw new AppError(409, 'TECHNICAL_PLAN_TENDER_EMPTY', '原始招标文件内容为空，请重新上传');
    try {
      buildSelectedSectionMarkdown(markdown, source.sections, sectionId);
    } catch (error) {
      if (error instanceof BidSectionError) throw new AppError(400, 'TECHNICAL_PLAN_BID_SECTION_INVALID', error.message, { cause: error });
      throw error;
    }
    await clearDownstreamFromBidSectionChange(trx, context, projectId);
    await updateGenerationConfig(trx, context, projectId, { bidSectionMode: 'multiple' });
    await writeMeta(trx, context, projectId, { selected_section_id: section!.id, selected_section_title: section!.title });
    return readState(trx, projectId);
  });
}

/**
 * 清空技术方案（与桌面版 clearTechnicalPlan 相同）：删除招标解析结果、选中的解析项与引用的知识库文档，招标文件与原方案的
 * 原件软删除（进回收站），页面状态和生成配置恢复默认值。返回软删除的文件数。
 */
export async function clearTechnicalPlan(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<{ deletedFileCount: number }> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const documents = await trx.selectFrom('technical_plan_documents').select('file_id').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('technical_plan_bid_items').where('project_id', '=', projectId).execute();
    const config = await trx.selectFrom('technical_plan_generation_config').select('project_id').where('project_id', '=', projectId).executeTakeFirst();
    if (config) await writeGenerationConfig(trx, context, projectId, await defaultGenerationConfig(trx));
    await trx
      .updateTable('technical_plan_meta')
      .set({ step: 'document-analysis', bid_sections: null, bid_section_extraction_status: 'idle', bid_section_extraction_error: null, selected_section_id: null, selected_section_title: null })
      .where('project_id', '=', projectId)
      .execute();
    const deletedFileCount = await trashFiles(
      trx,
      context,
      documents.map((row) => row.file_id),
    );
    return { deletedFileCount };
  });
}

// ---- 任务写入 ----

export interface DocumentParseInput {
  status?: TechnicalPlanDocumentStatus;
  markdownArtifactId?: string | null;
  contentChars?: number;
  /** 解析出的正文的哈希。 */
  contentHash?: string | null;
  parserLabel?: string | null;
  error?: string | null;
}

/**
 * 写入一份招标文件或原方案的解析结果（给第 6 步的解析任务用，取代桌面版导入时同步解析写入的 markdownPath、contentHash 等）：
 * 只写给出的字段。markdownArtifactId 只能是本文档原件的 Markdown 产物，否则被 RLS 拒绝。文档已移除（原件进回收站）时
 * 返回 false。参数不合法（文件 id、产物 id 不是 uuid，哈希超长）是调用方的程序错误，抛 TypeError。
 */
export async function saveDocumentParse(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  fileId: string,
  input: DocumentParseInput,
): Promise<boolean> {
  const id = uuid(fileId, '文件 id');
  const set = {
    ...(hasOwn(input, 'status') ? { status: oneOf(input.status, TECHNICAL_PLAN_DOCUMENT_STATUSES, 'pending') } : {}),
    ...(hasOwn(input, 'markdownArtifactId') ? { markdown_artifact_id: optionalUuid(input.markdownArtifactId, 'Markdown 产物 id') } : {}),
    ...(hasOwn(input, 'contentChars') ? { content_chars: count(input.contentChars) } : {}),
    ...(hasOwn(input, 'contentHash') ? { content_hash: optionalKey(input.contentHash, '正文哈希') } : {}),
    ...(hasOwn(input, 'parserLabel') ? { parser_label: optionalText(input.parserLabel, TECHNICAL_PLAN_LABEL_MAX) } : {}),
    ...(hasOwn(input, 'error') ? { error: optionalText(input.error, TECHNICAL_PLAN_TEXT_MAX) } : {}),
  };
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (Object.keys(set).length === 0) {
      return Boolean(await trx.selectFrom('technical_plan_documents').select('file_id').where('project_id', '=', projectId).where('file_id', '=', id).executeTakeFirst());
    }
    const result = await trx.updateTable('technical_plan_documents').set(set).where('project_id', '=', projectId).where('file_id', '=', id).executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  });
}

export interface BidItemInput {
  label?: string;
  status?: TechnicalPlanRunStatus;
  content?: string;
  error?: string | null;
}

/**
 * 写入招标解析项的结果（给第 6 步的招标解析任务用，取代桌面版 updateTechnicalPlan 的 bidAnalysisTasks / bidAnalysisItem /
 * projectOverview / techRequirements）：与桌面版 saveBidItems 相同，给出的项逐项覆盖写入（名称默认取任务列表，排序按任务
 * 列表），null 或空对象删除全部结果。解析项 id 不在任务列表中是调用方的程序错误，抛 TypeError；文本超长时截短。
 */
export async function saveBidItems(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  items: Partial<Record<string, BidItemInput>> | null,
): Promise<void> {
  const entries = Object.entries(items ?? {});
  const rows = entries.map(([itemId, item]) => {
    if (!isBidItemId(itemId)) throw new TypeError(`招标解析项不合法：${JSON.stringify(itemId.slice(0, 64))}`);
    return {
      org_id: context.orgId,
      project_id: projectId,
      item_id: itemId,
      label: taskText(item?.label || bidItemLabel(itemId), TECHNICAL_PLAN_LABEL_MAX) || bidItemLabel(itemId),
      status: oneOf(item?.status, TECHNICAL_PLAN_RUN_STATUSES, 'idle'),
      content: taskText(item?.content, TECHNICAL_PLAN_BID_ITEM_CONTENT_MAX),
      error: optionalText(item?.error, TECHNICAL_PLAN_TEXT_MAX),
      sort_order: bidItemSortOrder(itemId),
    };
  });
  await withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (rows.length === 0) {
      await trx.deleteFrom('technical_plan_bid_items').where('project_id', '=', projectId).execute();
      return;
    }
    await trx
      .insertInto('technical_plan_bid_items')
      .values(rows)
      .onConflict((oc) =>
        oc.columns(['project_id', 'item_id']).doUpdateSet((eb) => ({
          label: eb.ref('excluded.label'),
          status: eb.ref('excluded.status'),
          content: eb.ref('excluded.content'),
          error: eb.ref('excluded.error'),
          sort_order: eb.ref('excluded.sort_order'),
        })),
      )
      .execute();
  });
}

/**
 * 开始多标段识别（给第 6 步的识别任务用，与桌面版 prepareBidSectionExtraction 相同）：清空下游，生成配置切到多标段，
 * 识别结果与投标范围清空，状态置为 running。
 */
export async function prepareBidSectionExtraction(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<void> {
  await withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await clearDownstreamFromBidSectionChange(trx, context, projectId);
    await updateGenerationConfig(trx, context, projectId, { bidSectionMode: 'multiple' });
    await writeMeta(trx, context, projectId, { ...RESET_BID_SECTIONS, bid_section_extraction_status: 'running' });
  });
}

export interface BidSectionExtractionInput {
  status?: TechnicalPlanRunStatus;
  error?: string | null;
  /** 识别出的标段（与桌面版 normalizeBidSections 相同整理），null 清空。 */
  sections?: unknown[] | null;
}

/**
 * 写入多标段识别的状态与结果（给第 6 步的识别任务用，取代桌面版 updateTechnicalPlan 的 bidSections /
 * bidSectionExtractionStatus / bidSectionExtractionError）：只写给出的字段。整理后的标段列表超过大小上限是调用方的程序
 * 错误，抛 TypeError；文本超长时截短。
 */
export async function saveBidSectionExtraction(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: BidSectionExtractionInput,
): Promise<void> {
  const set: MetaPatch = {};
  if (hasOwn(input, 'status')) set.bid_section_extraction_status = oneOf(input.status, TECHNICAL_PLAN_RUN_STATUSES, 'idle');
  if (hasOwn(input, 'error')) set.bid_section_extraction_error = optionalText(input.error, TECHNICAL_PLAN_TEXT_MAX);
  if (hasOwn(input, 'sections')) {
    const sections = input.sections === null || input.sections === undefined ? null : JSON.stringify(normalizeBidSections(input.sections));
    // jsonb 的文本形式在冒号、逗号后多一个空格，比 JSON.stringify 的结果长，这里留出余量。
    if (sections !== null && Buffer.byteLength(sections) > (TECHNICAL_PLAN_BID_SECTIONS_MAX_BYTES * 3) / 4) throw new TypeError('标段列表过大');
    set.bid_sections = sections;
  }
  await withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await writeMeta(trx, context, projectId, set);
  });
}
