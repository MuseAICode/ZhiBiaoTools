// 技术方案的读写（迁移 0018_technical_plan、0019_technical_plan_outline、0020_technical_plan_content）：页面状态、招标文件与原方案、
// 统一生成配置（含选中的招标解析项、引用的知识库文档和导出模板）、招标解析项的结果、多标段识别与投标范围选择（5.11），目录与
// 全局事实（5.12），各节正文、正文生成状态、编排与运行进度（5.13）。
// 组织和用户一律来自 TenantContext，所有查询都经 withTenant；项目由路由先经 requireProject 校验（kind = technical-plan）。
//
// 可见性、写权限和删除可见性由 RLS 保证，这里不判断：所属项目已删除时八张表的行都查不到、改不了；文档随原件的生命周期，
// 原件已删除（进入回收站）时文档行不可见；引用的知识库文档不可见时引用行同样不可见；导出模板只能是本组织的或系统模板；
// 正文生成状态与编排只能挂在本项目的目录节点上，节点删除时随之删除（外键）。
// 导入招标文件、上传原方案就是把已上传的 tender 文件挂到本项目（files.project_id，设置后不能再改，由迁移 0015 的触发器
// 保证）并登记到 technical_plan_documents，文档停在待解析；移除和清空时软删除原件（进回收站，按文件自己的恢复期处理），
// 应用角色没有文档的 DELETE 授权。
//
// 与桌面版 technicalPlanStore.cjs（经 taskService 调用的版本）相同：导入或移除招标文件时清空招标解析结果、多标段识别结果和
// 投标范围，生成配置恢复默认值，步骤回到 document-analysis（clearDownstreamFromTender）；切换单 / 多标段或选择投标范围时
// 清空招标解析结果、引用的知识库文档和正文生成选项，步骤回到 bid-analysis（clearDownstreamFromBidSectionChange）；移除原方案
// 时目录扩展方式恢复为 ai-complement。两个函数都清空目录（含各节正文、生成状态与编排）、全局事实、目录的项目名称、概述与
// 字数控制快照和正文生成的运行进度。
//
// 目录与桌面版 saveOutline 的 reason 协议相同（节点 id 是稳定 UUID，sort_order 是同级顺序，编号读取时现算）：replace 清空
// 全部正文与正文生成状态，delete / add-* 只清空受影响节点（affectedNodeIds 与叶子 / 父节点身份变化的节点）的正文、生成状态与
// 编排并按桌面版规则保留运行进度（content.ts），sort 只改位置，edit 只改标题与说明。保存全局事实、重置正文阶段时清空全部正文、
// 生成状态、编排与运行进度（与桌面版 clearContentGenerationState 相同）；手工保存一节正文时该节状态改为 success（正文为空时 idle）。
//
// 桌面版合并的招标正文（tender-original.md）和按投标范围裁剪的工作副本（tender.md）不再保存：读取时由各招标文件解析出的
// Markdown 现算（readTenderMarkdown），投标范围只记 id 和标题。给第 6 步任务用的写函数：saveDocumentParse（文档的解析
// 结果与疑似多标段检测摘要）、saveBidItems / resetBidAnalysisForRerun（招标解析项的结果）、prepareBidSectionExtraction /
// saveBidSectionExtraction（多标段识别）；这几个函数接受任务开始时的输入签名（inputSignatures），在写入的同一事务中（项目锁内）
// 核对，招标文件、投标范围变化后旧任务的写入被拒绝（6.11）。其余：
// saveGeneratedOutline（目录生成的结果与字数控制快照）、saveContentSections / saveContentPlans / saveContentGenerationItem /
// saveContentGenerationRuntime（第 8 步的正文生成）；全局事实生成与调整（8.7c1、8.7c2）经 saveGlobalFactsResult 写入（与
// saveGlobalFacts 相同的整理与清空，另核对 globalFactsInputSignature）。
import { createHash } from 'node:crypto';
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
import { TECHNICAL_PLAN_CONTENT_MAX } from '../db/migrations/0019_technical_plan_outline.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { isFinalStatus, latestProjectJobs, type JobRecord } from '../jobs/store.ts';
import { jobBody, type JobBody } from '../jobs/view.ts';
import { storageDisabled } from '../knowledgeBase/content.ts';
import { findContinuableAgentSessionIn, type AgentSessionTarget } from '../agent/continuation.ts';
import { discardSectionBodies, prepareSectionBody, readSectionBody, writeSectionBody, type SectionBody } from './sectionBodies.ts';
import {
  combineBidSectionDetections,
  parseBidSectionDetectionSummary,
  type BidSectionDetection,
  type BidSectionDetectionSummary,
} from './bidSectionDetector.ts';
import { collectLeafItems, normalizeContentPlan, retainRuntimeAfterOutlineChange, serializeRuntime, type ContentRuntime } from './content.ts';
import {
  buildOutline,
  flattenOutline,
  normalizeGlobalFactGroups,
  OutlineInputError,
  outlineHeader,
  TECHNICAL_PLAN_OUTLINE_SAVE_REASONS,
  type OutlineNodeRow,
  type TechnicalPlanOutlineData,
  type TechnicalPlanOutlineSaveReason,
} from './outline.ts';
import { readOutlineSelectionState, type AcceptedOutlineItem } from './outlineAgent.ts';
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

/** 多标段识别与招标解析两类任务（第 6 步 6.11，src/technicalPlan/jobs.ts）。 */
export const BID_SECTION_EXTRACTION_JOB_TYPE = 'bid-section-extraction';
export const BID_ANALYSIS_JOB_TYPE = 'bid-analysis';
/** 全局事实生成（第 8 步 8.7c1，src/technicalPlan/jobs.ts），agent 队列；任务类型与桌面版相同。 */
export const GLOBAL_FACTS_JOB_TYPE = 'global-facts-generation';
/** 全局事实调整（第 8 步 8.7c2）：agent 队列，接着全局事实生成（或上一次调整）的会话与工作区；任务类型与桌面版相同。 */
export const GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE = 'global-facts-adjustment';
/** 全局事实生成与调整共用的工作区快照类别（与桌面版的持久任务 technical-plan-global-facts 对应）。 */
export const GLOBAL_FACTS_TASK_KIND = 'technical-plan-global-facts';
/** 调整要求的字数上限（桌面版没有限制；放入提示词，与可研目录调整相同限制在 2000 字以内）。 */
export const GLOBAL_FACTS_ADJUSTMENT_REQUIREMENT_MAX = 2000;
/** 调整说明（Agent 最后一条回复）的字数上限：桌面版提示词要求不超过 200 字，超出的截短。 */
export const GLOBAL_FACTS_ADJUSTMENT_SUMMARY_MAX = 2000;

/** 全局事实调整接着的会话：全局事实生成或上一次调整写下的、与当前快照同一对的现场（src/agent/continuation.ts）。 */
export function globalFactsSessionTarget(projectId: string): AgentSessionTarget {
  return { projectId, taskKind: GLOBAL_FACTS_TASK_KIND, jobTypes: [GLOBAL_FACTS_JOB_TYPE, GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE] };
}

/**
 * 技术方案目录生成（第 8 步 8.7e1）：agent 队列，生成一级目录、等待用户确认后整理目录（需要 AI 扩展的后续阶段随 8.7e2）；任务类型与
 * 桌面版相同，目录调整接着它的会话。
 */
export const OUTLINE_GENERATION_JOB_TYPE = 'outline-generation';
/** 技术方案目录调整（第 8 步 8.7d）：agent 队列，接着目录生成（或上一次调整）的会话与工作区；任务类型与桌面版相同。 */
export const OUTLINE_ADJUSTMENT_JOB_TYPE = 'outline-adjustment';
/** 目录生成与调整共用的工作区快照类别（与桌面版的持久任务 technical-plan-outline-generation 对应）。 */
export const OUTLINE_TASK_KIND = 'technical-plan-outline-generation';
/** 目录调整要求与说明的字数上限（与全局事实调整相同）。 */
export const OUTLINE_ADJUSTMENT_REQUIREMENT_MAX = GLOBAL_FACTS_ADJUSTMENT_REQUIREMENT_MAX;
export const OUTLINE_ADJUSTMENT_SUMMARY_MAX = GLOBAL_FACTS_ADJUSTMENT_SUMMARY_MAX;

/** 目录调整接着的会话：目录生成或上一次调整写下的、与当前快照同一对的现场（src/agent/continuation.ts）。 */
export function outlineSessionTarget(projectId: string): AgentSessionTarget {
  return { projectId, taskKind: OUTLINE_TASK_KIND, jobTypes: [OUTLINE_GENERATION_JOB_TYPE, OUTLINE_ADJUSTMENT_JOB_TYPE] };
}

/**
 * 技术方案的任务互斥（与桌面版 technical-plan 组的 group-exclusive 相同）：同一项目同时只有一个技术方案任务。第 8 步的目录、
 * 全局事实、正文生成任务使用同一个键。
 */
export function technicalPlanLockKey(projectId: string): string {
  return `project:${projectId}:technical-plan`;
}

/** 任务记录已结束、结果仍是 running 时显示的原因（与桌面版重启后的 recoverInterruptedBidAnalysisTask 等相同）。 */
const STALE_BID_ANALYSIS_MESSAGE = '上次招标文件解析未完成，请重新解析';
const STALE_BID_SECTION_EXTRACTION_MESSAGE = '上次多标段识别未完成，请重新识别';

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

/** 一组全局事实（与桌面版 Renderer 的 GlobalFactGroup 相同）。 */
export interface TechnicalPlanGlobalFact {
  id: string;
  title: string;
  content: string;
  /** 内容最近一次变化的时间（重新保存时内容未变的分组沿用原值）。 */
  updated_at: Date;
}

/** 一节的正文生成状态（与桌面版 Renderer 的 ContentGenerationSectionState 相同，error 为 null 而不是省略）。 */
export interface ContentGenerationSection {
  id: string;
  title: string;
  status: TechnicalPlanRunStatus;
  content: string;
  error: string | null;
  /** 没有状态行、由已有正文推出的叶子节点为 null。 */
  updated_at: Date | null;
}

/** 一节的正文编排（与桌面版 Renderer 的 ContentGenerationPlanState 相同）。 */
export interface ContentGenerationPlan {
  plan_version: number;
  plan: Record<string, unknown>;
  table_requirement?: TechnicalPlanTableRequirement;
  updated_at: Date;
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
  /**
   * 疑似多标段检测（取代桌面版 checkBidSections）：各解析成功的招标文件的检测摘要合并的结果。有解析成功的招标文件缺少摘要时
   * 为 null（不提示）。
   */
  bidSectionDetection: BidSectionDetection | null;
  /** 本项目最近一次的多标段识别、招标解析任务（与 GET /api/jobs/:jobId 相同的形式），没有时为 null。 */
  bidSectionExtractionTask: JobBody | null;
  bidAnalysisTask: JobBody | null;
  /** 目录（含各节正文），还没有目录时为 null。 */
  outlineData: TechnicalPlanOutlineData | null;
  /** 目录生成时生效的字数控制，没有时为 null。 */
  outlineWordControlSnapshot: OutlineWordControlOptions | null;
  globalFacts: TechnicalPlanGlobalFact[];
  /** 本项目最近一次的目录生成任务（8.7e1），没有时为 null。 */
  outlineGenerationTask: JobBody | null;
  /**
   * 最近一次目录生成的一级目录（桌面版 outlineGenerationTask.stats.outline_selection）：items 为生成的一级目录（attr 与 content_mode 在其中），
   * selected_ids 为默认选择或用户确认的选择，confirmed 为是否已确认。任务正在等待确认时（暂停为 waiting_for_selection）由页面弹出确认，
   * 经 POST .../outline-selection 提交。还没有生成出一级目录时为 null。标题与说明是 AI 生成的内容（按纯文本显示，第 9 步）。
   */
  outlineSelection: { items: AcceptedOutlineItem[]; selected_ids: string[]; confirmed: boolean } | null;
  /** 本项目最近一次的目录调整任务（8.7d），没有时为 null。 */
  outlineAdjustmentTask: JobBody | null;
  /** 最近一次目录调整的要求与 Agent 的说明（桌面版 outlineAdjustmentTask.stats.adjustment），形式与 globalFactsAdjustment 相同。 */
  outlineAdjustment: { requirement: string; summary: string | null } | null;
  /** 能否发起目录调整：有目录，且目录生成（或上一次调整）的 Agent 会话可以续用（桌面版 hasPersistentTaskSession）。 */
  outlineAdjustable: boolean;
  /** 本项目最近一次的全局事实生成任务（8.7c1），没有时为 null。 */
  globalFactsTask: JobBody | null;
  /** 本项目最近一次的全局事实调整任务（8.7c2），没有时为 null。 */
  globalFactsAdjustmentTask: JobBody | null;
  /**
   * 最近一次全局事实调整的要求与 Agent 的说明（桌面版 globalFactsAdjustmentTask.stats.adjustment）；没有调整任务时为 null。summary 是 AI
   * 生成的内容（按纯文本显示），调整还没有成功完成时为 null（前端显示失败原因或进度）。
   */
  globalFactsAdjustment: { requirement: string; summary: string | null } | null;
  /** 能否发起全局事实调整：有全局事实，且全局事实生成（或上一次调整）的 Agent 会话可以续用（桌面版 hasPersistentTaskSession）。 */
  globalFactsAdjustable: boolean;
  /** 各节的正文生成状态，按节点 id。 */
  contentGenerationSections: Record<string, ContentGenerationSection>;
  /** 各节的正文编排，按节点 id。 */
  contentGenerationPlans: Record<string, ContentGenerationPlan>;
  /** 正文生成的运行进度，没有时为 null。 */
  contentGenerationRuntime: ContentRuntime | null;
  contentGenerationTask: null;
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

function outlineInvalid(error: OutlineInputError): AppError {
  return new AppError(400, 'TECHNICAL_PLAN_INVALID', error.message, { cause: error });
}

function outlineChanged(): AppError {
  return new AppError(409, 'TECHNICAL_PLAN_OUTLINE_CHANGED', '目录已变化，请刷新后再调整');
}

function chapterNotFound(): AppError {
  return new AppError(404, 'TECHNICAL_PLAN_CHAPTER_NOT_FOUND', '当前目录中未找到该章节');
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

/** 与桌面版 normalizeOutlineWordControlOptions 中本步用到的部分相同：三项字数各自按 words 整理。 */
function normalizeWordControl(value: unknown): OutlineWordControlOptions {
  const source = isObject(value) ? value : {};
  return { minimumWords: words(source.minimumWords), maximumWords: words(source.maximumWords), sectionWords: words(source.sectionWords) };
}

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  const size = 500;
  for (let start = 0; start < rows.length; start += size) await insert(rows.slice(start, start + size));
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
  const templateId = source.exportTemplateId;
  return {
    bidAnalysisMode: bidAnalysis.mode,
    bidAnalysisSelectedTaskIds: bidAnalysis.selectedTaskIds,
    bidSectionMode: source.bidSectionMode === 'multiple' ? 'multiple' : 'single',
    outlineMode: oneOf(source.outlineMode, TECHNICAL_PLAN_OUTLINE_MODES, 'standalone-technical'),
    outlineExpansionMode: oneOf(source.outlineExpansionMode, TECHNICAL_PLAN_OUTLINE_EXPANSION_MODES, 'ai-complement'),
    outlineWordControlOptions: normalizeWordControl(source.outlineWordControlOptions),
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

type DocumentRow = TechnicalPlanDocument & { role: TechnicalPlanDocumentRole; detection: Record<string, unknown> | null };

async function readDocuments(trx: Trx, projectId: string): Promise<DocumentRow[]> {
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
      'd.bid_section_detection',
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
    detection: row.bid_section_detection,
  }));
}

/** 合并解析成功的招标文件的检测摘要；有文件缺少摘要或摘要不合法时为 null。 */
function bidSectionDetectionOf(documents: readonly DocumentRow[]): BidSectionDetection | null {
  const summaries: BidSectionDetectionSummary[] = [];
  for (const document of documents) {
    if (document.role !== 'tender' || document.status !== 'success') continue;
    if (!document.detection) return null;
    try {
      summaries.push(parseBidSectionDetectionSummary(document.detection));
    } catch {
      return null;
    }
  }
  return combineBidSectionDetections(summaries);
}

/** 结果仍是 running、但对应的任务已结束或不存在（执行者失联后被标为失败、已取消等）时，按未完成显示。 */
function isStale(task: JobRecord | undefined): boolean {
  return !task || isFinalStatus(task.status);
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

async function readOutlineRows(trx: Trx, projectId: string): Promise<OutlineNodeRow[]> {
  return trx
    .selectFrom('technical_plan_outline_nodes')
    .select([
      'node_id',
      'parent_node_id',
      'sort_order',
      'level',
      'title',
      'description',
      'content_mode',
      'content_mode_note',
      'source_requirement_id',
      'source_requirement_title',
      'knowledge_item_ids',
      'content',
    ])
    .where('project_id', '=', projectId)
    .orderBy('level')
    .orderBy('parent_node_id')
    .orderBy('sort_order')
    .orderBy('node_id')
    .execute();
}

async function readGlobalFacts(trx: Trx, projectId: string): Promise<TechnicalPlanGlobalFact[]> {
  const rows = await trx
    .selectFrom('technical_plan_global_fact_groups')
    .select(['group_id', 'title', 'content', 'updated_at'])
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('group_id')
    .execute();
  return rows.map((row) => ({ id: row.group_id, title: row.title, content: row.content, updated_at: row.updated_at }));
}

/**
 * 各节的正文生成状态（与桌面版 loadContentSections 相同）：有状态行的节取行中的状态与错误，标题与正文取目录节点；没有状态行
 * 但已有正文的叶子节点视为 success。
 */
async function readContentSections(trx: Trx, projectId: string, rows: OutlineNodeRow[], outline: TechnicalPlanOutlineData | null): Promise<Record<string, ContentGenerationSection>> {
  const nodes = new Map(rows.map((row) => [row.node_id, row]));
  const sectionRows = await trx
    .selectFrom('technical_plan_content_sections')
    .select(['node_id', 'status', 'error', 'updated_at'])
    .where('project_id', '=', projectId)
    .orderBy('node_id')
    .execute();
  const sections: Record<string, ContentGenerationSection> = {};
  for (const row of sectionRows) {
    const node = nodes.get(row.node_id);
    sections[row.node_id] = {
      id: row.node_id,
      title: node?.title || '未命名章节',
      status: oneOf(row.status, TECHNICAL_PLAN_RUN_STATUSES, 'idle'),
      content: node?.content ?? '',
      error: row.error,
      updated_at: row.updated_at,
    };
  }
  for (const item of collectLeafItems(outline?.outline ?? [])) {
    if (!sections[item.id] && item.content?.trim()) {
      sections[item.id] = { id: item.id, title: item.title || '未命名章节', status: 'success', content: item.content, error: null, updated_at: null };
    }
  }
  return sections;
}

/** 各节的正文编排（与桌面版 loadContentPlans 相同）。 */
async function readContentPlans(trx: Trx, projectId: string): Promise<Record<string, ContentGenerationPlan>> {
  const rows = await trx
    .selectFrom('technical_plan_content_plans')
    .select(['node_id', 'plan_version', 'plan', 'table_requirement', 'updated_at'])
    .where('project_id', '=', projectId)
    .orderBy('node_id')
    .execute();
  return Object.fromEntries(
    rows.map((row) => [
      row.node_id,
      {
        plan_version: row.plan_version,
        plan: row.plan,
        ...(row.table_requirement ? { table_requirement: row.table_requirement } : {}),
        updated_at: row.updated_at,
      },
    ]),
  );
}

/** 在已设置上下文的事务中读取完整状态（与桌面版 loadTechnicalPlan 中已迁移的字段相同，任务状态先返回 null）。 */
export async function readState(trx: Trx, projectId: string): Promise<TechnicalPlanState> {
  const meta = await trx.selectFrom('technical_plan_meta').selectAll().where('project_id', '=', projectId).executeTakeFirst();
  const config = await readGenerationConfig(trx, projectId);
  const documents = await readDocuments(trx, projectId);
  const items = await readBidItems(trx, projectId);
  const outlineRows = await readOutlineRows(trx, projectId);
  const outline = buildOutline(outlineRows, {
    name: meta?.outline_project_name ?? null,
    overview: meta?.outline_project_overview ?? null,
  });
  const snapshot = meta?.outline_word_control_snapshot;
  const strip = ({ role: _role, detection: _detection, ...document }: DocumentRow): TechnicalPlanDocument => document;
  const jobs = await latestProjectJobs(trx, projectId, [
    BID_SECTION_EXTRACTION_JOB_TYPE,
    BID_ANALYSIS_JOB_TYPE,
    GLOBAL_FACTS_JOB_TYPE,
    GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE,
    OUTLINE_GENERATION_JOB_TYPE,
    OUTLINE_ADJUSTMENT_JOB_TYPE,
  ]);
  const extractionTask = jobs.get(BID_SECTION_EXTRACTION_JOB_TYPE);
  const analysisTask = jobs.get(BID_ANALYSIS_JOB_TYPE);
  const globalFactsTask = jobs.get(GLOBAL_FACTS_JOB_TYPE);
  const globalFactsAdjustmentTask = jobs.get(GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE);
  const outlineAdjustmentTask = jobs.get(OUTLINE_ADJUSTMENT_JOB_TYPE);
  const outlineGenerationTask = jobs.get(OUTLINE_GENERATION_JOB_TYPE);
  const globalFacts = await readGlobalFacts(trx, projectId);
  // 与桌面版 recoverInterruptedBidAnalysisTask 相同：任务已结束时仍是 running 的解析项按未完成显示（只改读出的状态）。
  const analysisStale = isStale(analysisTask);
  for (const item of items) {
    if (item.status === 'running' && analysisStale) Object.assign(item, { status: 'error', error: STALE_BID_ANALYSIS_MESSAGE });
  }
  const extractionStale = meta?.bid_section_extraction_status === 'running' && isStale(extractionTask);
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
    bidSectionExtractionStatus: extractionStale ? 'error' : (meta?.bid_section_extraction_status ?? 'idle'),
    bidSectionExtractionError: extractionStale ? STALE_BID_SECTION_EXTRACTION_MESSAGE : (meta?.bid_section_extraction_error ?? null),
    bidSectionDetection: bidSectionDetectionOf(documents),
    bidSectionExtractionTask: extractionTask ? jobBody(extractionTask) : null,
    bidAnalysisTask: analysisTask ? jobBody(analysisTask) : null,
    outlineData: outline,
    outlineWordControlSnapshot: snapshot ? normalizeWordControl(snapshot) : null,
    globalFacts,
    outlineGenerationTask: outlineGenerationTask ? jobBody(outlineGenerationTask) : null,
    outlineSelection: outlineSelectionOf(outlineGenerationTask),
    outlineAdjustmentTask: outlineAdjustmentTask ? jobBody(outlineAdjustmentTask) : null,
    outlineAdjustment: adjustmentOf(outlineAdjustmentTask),
    outlineAdjustable: outline !== null && (await findContinuableAgentSessionIn(trx, outlineSessionTarget(projectId))) !== null,
    globalFactsTask: globalFactsTask ? jobBody(globalFactsTask) : null,
    globalFactsAdjustmentTask: globalFactsAdjustmentTask ? jobBody(globalFactsAdjustmentTask) : null,
    globalFactsAdjustment: adjustmentOf(globalFactsAdjustmentTask),
    globalFactsAdjustable: globalFacts.length > 0 && (await findContinuableAgentSessionIn(trx, globalFactsSessionTarget(projectId))) !== null,
    contentGenerationSections: await readContentSections(trx, projectId, outlineRows, outline),
    contentGenerationPlans: await readContentPlans(trx, projectId),
    contentGenerationRuntime: meta?.content_generation_runtime ?? null,
    contentGenerationTask: null,
  };
}

/** 目录生成任务 checkpoint 中的一级目录（src/technicalPlan/jobs.ts 写入，确认接口写入 confirmed）。 */
function outlineSelectionOf(job: Pick<JobRecord, 'checkpoint'> | undefined): TechnicalPlanState['outlineSelection'] {
  if (!job) return null;
  const { selection, confirmed } = readOutlineSelectionState(job.checkpoint?.task);
  if (confirmed) return { items: confirmed.items, selected_ids: confirmed.selectedIds, confirmed: true };
  return selection ? { items: selection.items, selected_ids: selection.selectedIds, confirmed: false } : null;
}

/** 调整任务（全局事实调整、目录调整，说明上限相同）的要求（任务参数）与成功后写下的说明（任务最后的 checkpoint 中，src/technicalPlan/jobs.ts）。 */
function adjustmentOf(job: Pick<JobRecord, 'status' | 'params' | 'checkpoint'> | undefined): TechnicalPlanState['globalFactsAdjustment'] {
  if (!job) return null;
  const requirement = typeof job.params.requirement === 'string' ? job.params.requirement : '';
  const task = job.checkpoint?.task;
  const summary =
    job.status === 'succeeded' && typeof task === 'object' && task !== null && typeof (task as Record<string, unknown>).summary === 'string'
      ? ((task as Record<string, unknown>).summary as string).slice(0, GLOBAL_FACTS_ADJUSTMENT_SUMMARY_MAX)
      : null;
  return { requirement, summary };
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
  outline_project_name: string | null;
  outline_project_overview: string | null;
  outline_word_control_snapshot: string | null;
  content_generation_runtime: string | null;
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

/** 目录的项目名称、概述、字数控制快照与正文生成的运行进度恢复初始状态（目录删除时）。 */
const RESET_OUTLINE_META: MetaPatch = {
  outline_project_name: null,
  outline_project_overview: null,
  outline_word_control_snapshot: null,
  content_generation_runtime: null,
};

/**
 * 清空正文阶段（与桌面版 clearContentGenerationState 相同）：各节正文置空，删除正文生成状态与编排，清除运行进度。
 * 正文生成任务的取消随第 6 步，Agent 持久任务与正文 Word 文件的回收随第 8 步、第 7 步。
 */
async function clearContentGeneration(trx: Trx, context: TenantContext, projectId: string): Promise<void> {
  await trx.updateTable('technical_plan_outline_nodes').set({ content: '' }).where('project_id', '=', projectId).where('content', '<>', '').execute();
  await discardSectionBodies(trx, projectId, null);
  await trx.deleteFrom('technical_plan_content_sections').where('project_id', '=', projectId).execute();
  await trx.deleteFrom('technical_plan_content_plans').where('project_id', '=', projectId).execute();
  await writeMeta(trx, context, projectId, { content_generation_runtime: null });
}

/** 删除目录（含各节正文；正文生成状态与编排随节点级联删除）和全局事实。 */
async function deleteOutlineAndFacts(trx: Trx, projectId: string): Promise<void> {
  await discardSectionBodies(trx, projectId, null);
  await trx.deleteFrom('technical_plan_outline_nodes').where('project_id', '=', projectId).execute();
  await trx.deleteFrom('technical_plan_global_fact_groups').where('project_id', '=', projectId).execute();
}

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

/**
 * 与桌面版 clearDownstreamFromTender 相同：清空招标解析结果、多标段识别结果、目录（含正文）和全局事实，生成配置恢复默认值，
 * 步骤回到第一步。
 */
async function clearDownstreamFromTender(trx: Trx, context: TenantContext, projectId: string): Promise<void> {
  await trx.deleteFrom('technical_plan_bid_items').where('project_id', '=', projectId).execute();
  await deleteOutlineAndFacts(trx, projectId);
  await writeGenerationConfig(trx, context, projectId, await defaultGenerationConfig(trx));
  await writeMeta(trx, context, projectId, { ...RESET_BID_SECTIONS, ...RESET_OUTLINE_META, step: 'document-analysis' });
}

/**
 * 与桌面版 clearDownstreamFromBidSectionChange 相同：清空招标解析结果、目录（含正文）、全局事实、引用的知识库文档和正文生成
 * 选项，步骤回到招标解析。
 */
async function clearDownstreamFromBidSectionChange(trx: Trx, context: TenantContext, projectId: string): Promise<void> {
  await trx.deleteFrom('technical_plan_bid_items').where('project_id', '=', projectId).execute();
  await deleteOutlineAndFacts(trx, projectId);
  await updateGenerationConfig(trx, context, projectId, { referenceKnowledgeDocumentIds: [], contentGenerationOptions: DEFAULT_CONTENT_OPTIONS });
  await writeMeta(trx, context, projectId, { ...RESET_OUTLINE_META, step: 'bid-analysis' });
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
  return (await saveGenerationConfigReporting(db, context, projectId, partial)).state;
}

/** 同 saveGenerationConfig，另返回是否切换了单 / 多标段（清空了下游；接口据此丢弃全局事实的会话，8.7c2）。 */
export async function saveGenerationConfigReporting(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  partial: GenerationConfigPatch,
): Promise<{ state: TechnicalPlanState; downstreamCleared: boolean }> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const current = await readGenerationConfig(trx, projectId);
    const nextSectionMode = hasOwn(partial, 'bidSectionMode') ? (partial.bidSectionMode === 'multiple' ? 'multiple' : 'single') : current.bidSectionMode;
    const downstreamCleared = nextSectionMode !== current.bidSectionMode;
    if (downstreamCleared) {
      await clearDownstreamFromBidSectionChange(trx, context, projectId);
      await writeMeta(trx, context, projectId, RESET_BID_SECTIONS);
    }
    await updateGenerationConfig(trx, context, projectId, partial);
    return { state: await readState(trx, projectId), downstreamCleared };
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
  return (await saveBidAnalysisConfigReporting(db, context, projectId, input)).state;
}

/** 同 saveBidAnalysisConfig，另返回是否切换了单 / 多标段（清空了下游；接口据此丢弃全局事实的会话，8.7c2）。 */
export async function saveBidAnalysisConfigReporting(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: BidAnalysisConfigInput,
): Promise<{ state: TechnicalPlanState; downstreamCleared: boolean }> {
  const config = normalizeBidAnalysisConfig(input.mode, input.selectedTaskIds);
  return saveGenerationConfigReporting(db, context, projectId, {
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
  /** 新导入的文件（待解析，由接口入队解析任务）。 */
  addedFileIds: string[];
  /** 已导入到本项目的文件（跳过）。 */
  skippedCount: number;
  state: TechnicalPlanState;
}

/**
 * 导入招标文件（取代桌面版 importTenderDocument）：与桌面版相同追加到已有招标文件之后，已导入到本项目的文件跳过。新文件
 * 挂到本项目（files.project_id）并登记，停在待解析（由接口入队解析任务，6.6）。有新文件时清空下游（clearDownstreamFromTender）；
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
    if (added.length === 0) return { addedCount: 0, addedFileIds: [], skippedCount: ids.length, state: await readState(trx, projectId) };
    if (existing.length + added.length > TECHNICAL_PLAN_TENDER_FILES_MAX) {
      throw new AppError(400, 'TECHNICAL_PLAN_DOCUMENT_LIMIT', `每个项目最多导入 ${TECHNICAL_PLAN_TENDER_FILES_MAX} 份招标文件`);
    }
    const next = existing.reduce((max, row) => Math.max(max, row.sort_order + 1), 0);
    await attachDocuments(trx, context, projectId, 'tender', added, next);
    await clearDownstreamFromTender(trx, context, projectId);
    return { addedCount: added.length, addedFileIds: added, skippedCount: ids.length - added.length, state: await readState(trx, projectId) };
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

/**
 * 读出各 Markdown 产物的文本（按给出的顺序；对象已不在存储中的为 null）。总大小超过 TECHNICAL_PLAN_MARKDOWN_READ_MAX_BYTES 时
 * 返回 422，不整体读入。
 */
async function readArtifactTexts(objectStore: ObjectStore | null, artifacts: readonly { storageKey: string; size: number }[]): Promise<(string | null)[]> {
  if (artifacts.length === 0) return [];
  if (!objectStore) throw storageDisabled();
  let total = artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
  if (total > TECHNICAL_PLAN_MARKDOWN_READ_MAX_BYTES) throw markdownTooLarge();
  total = 0;
  const texts: (string | null)[] = [];
  for (const artifact of artifacts) {
    const object = await objectStore.get(artifact.storageKey);
    if (!object) {
      texts.push(null);
      continue;
    }
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
    texts.push(Buffer.concat(chunks).toString('utf8'));
  }
  return texts;
}

/** 读出各招标文件的 Markdown 并合并（与桌面版 tender-original.md 相同）。总大小超过上限时返回 422，不整体读入。 */
async function readCombinedMarkdown(objectStore: ObjectStore | null, artifacts: TenderMarkdownSource['artifacts']): Promise<string> {
  if (artifacts.length === 0) return '';
  const texts = await readArtifactTexts(objectStore, artifacts);
  return combineTenderMarkdown(texts.filter((text): text is string => text !== null));
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
 * 合并的原始招标正文（桌面版 readOriginalTenderMarkdown 读取的 tender-original.md，不按投标范围裁剪）：多标段识别任务的输入。
 */
export async function readOriginalTenderMarkdown(db: Kysely<Database>, context: TenantContext, projectId: string, objectStore: ObjectStore | null): Promise<string> {
  const source = await withTenant(db, context, (trx) => tenderMarkdownSource(trx, projectId));
  return readCombinedMarkdown(objectStore, source.artifacts);
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

// ---- 目录与全局事实 ----

/** 展开请求中的目录；不合法时返回 400。null、undefined 或空目录表示删除目录。 */
function parseOutline(outlineData: unknown): { rows: ReturnType<typeof flattenOutline>; header: { name: string | null; overview: string | null } } {
  if (outlineData === null || outlineData === undefined) return { rows: [], header: { name: null, overview: null } };
  try {
    if (!isObject(outlineData)) throw new OutlineInputError('目录数据必须是对象');
    const rows = flattenOutline(outlineData.outline ?? []);
    return { rows, header: rows.length ? outlineHeader(outlineData) : { name: null, overview: null } };
  } catch (error) {
    if (error instanceof OutlineInputError) throw outlineInvalid(error);
    throw error;
  }
}

/**
 * 按新目录写入节点（与桌面版 saveOutlineData 相同）：新增和保留的节点整行写入（节点身份不变，位置、标题等按请求），不在
 * 新目录中的节点删除（子节点随之级联删除；仍在新目录中的子节点已先移到新的父节点下）。content 是每个节点最终的正文。
 */
async function writeOutlineNodes(trx: Trx, context: TenantContext, projectId: string, rows: (OutlineNodeRow & { branch?: boolean })[]): Promise<void> {
  // 写入后不再是 ai-generate 叶子（含不在新目录中）的节点，AI 正文先删除并替换不再引用的配图，再由节点的级联删除其余行。
  const parents = new Set(rows.map((row) => row.parent_node_id));
  const aiLeaves = new Set(rows.filter((row) => row.content_mode === 'ai-generate' && !parents.has(row.node_id)).map((row) => row.node_id));
  const bodies = await trx.selectFrom('technical_plan_section_bodies').select('node_id').where('project_id', '=', projectId).execute();
  await discardSectionBodies(trx, projectId, bodies.map((row) => row.node_id).filter((id) => !aiLeaves.has(id)));
  const values = rows.map(({ branch: _branch, ...row }) => ({
    org_id: context.orgId,
    project_id: projectId,
    ...row,
    knowledge_item_ids: row.knowledge_item_ids ? JSON.stringify(row.knowledge_item_ids) : null,
  }));
  await insertChunked(values, (chunk) =>
    trx
      .insertInto('technical_plan_outline_nodes')
      .values(chunk)
      .onConflict((oc) =>
        oc.columns(['project_id', 'node_id']).doUpdateSet((eb) => ({
          parent_node_id: eb.ref('excluded.parent_node_id'),
          sort_order: eb.ref('excluded.sort_order'),
          level: eb.ref('excluded.level'),
          title: eb.ref('excluded.title'),
          description: eb.ref('excluded.description'),
          content_mode: eb.ref('excluded.content_mode'),
          content_mode_note: eb.ref('excluded.content_mode_note'),
          source_requirement_id: eb.ref('excluded.source_requirement_id'),
          source_requirement_title: eb.ref('excluded.source_requirement_title'),
          knowledge_item_ids: eb.ref('excluded.knowledge_item_ids'),
          content: eb.ref('excluded.content'),
        })),
      )
      .execute(),
  );
  let removal = trx.deleteFrom('technical_plan_outline_nodes').where('project_id', '=', projectId);
  if (rows.length > 0) removal = removal.where('node_id', 'not in', rows.map((row) => row.node_id));
  await removal.execute();
}

export interface SaveOutlineInput {
  /** null 或空目录表示删除目录。 */
  outlineData: unknown;
  reason?: TechnicalPlanOutlineSaveReason;
  /** 需要清空正文的节点（delete、add-* 时由前端给出）。 */
  affectedNodeIds?: string[];
}

/**
 * 保存目录（与桌面版 saveOutline 相同的 reason 协议，节点 id 是稳定 UUID）：
 * - sort：只改节点的父节点、同级顺序和层级以及目录的项目名称与概述，节点身份、正文不变；
 * - edit：只改标题与说明，正文、处理方式等不变；
 * - delete、add-root、add-child：按新目录写入，affectedNodeIds 中的节点和由叶子变成父节点（或反过来）的节点清空正文、
 *   生成状态与编排，其余已有节点沿用已保存的正文与状态（忽略请求中的正文），新节点取请求给出的正文；运行进度按
 *   retainRuntimeAfterOutlineChange 保留；
 * - replace：按新目录写入，清空全部正文、生成状态与编排和运行进度。
 * sort、edit 不改正文生成状态。不在新目录中的节点的状态与编排随节点删除。sort、edit 要求请求中的节点与已保存的完全一致
 * （例如其他成员已改过目录时），否则返回 409，不做改动；目录为空时同时清空字数控制快照。
 *
 * 桌面版“正文生成任务运行或暂停中不能调整目录”的检查和删除正文生成任务记录随第 6 步的任务队列。
 */
export async function saveOutline(db: Kysely<Database>, context: TenantContext, projectId: string, input: SaveOutlineInput): Promise<TechnicalPlanState> {
  const reason = oneOf(input.reason, TECHNICAL_PLAN_OUTLINE_SAVE_REASONS, 'replace');
  const { rows, header } = parseOutline(input.outlineData);
  const affected = new Set((input.affectedNodeIds ?? []).map((id) => String(id).trim().toLowerCase()).filter(Boolean));
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const previous = new Map(
      (await trx.selectFrom('technical_plan_outline_nodes').select(['node_id', 'parent_node_id', 'content']).where('project_id', '=', projectId).execute()).map(
        (row) => [row.node_id, row],
      ),
    );
    if (reason === 'sort' || reason === 'edit') {
      if (rows.length !== previous.size || rows.some((row) => !previous.has(row.node_id))) throw outlineChanged();
      if (rows.length === 0) return readState(trx, projectId);
      const values = JSON.stringify(rows.map(({ node_id, parent_node_id, sort_order, level, title, description }) => ({ node_id, parent_node_id, sort_order, level, title, description })));
      if (reason === 'sort') {
        await sql`UPDATE technical_plan_outline_nodes n
          SET parent_node_id = v.parent_node_id, sort_order = v.sort_order, level = v.level
          FROM jsonb_to_recordset(${values}::jsonb) AS v(node_id uuid, parent_node_id uuid, sort_order integer, level integer)
          WHERE n.project_id = ${projectId} AND n.node_id = v.node_id
            AND (n.parent_node_id IS DISTINCT FROM v.parent_node_id OR n.sort_order <> v.sort_order OR n.level <> v.level)`.execute(trx);
        await writeMeta(trx, context, projectId, { outline_project_name: header.name, outline_project_overview: header.overview });
      } else {
        await sql`UPDATE technical_plan_outline_nodes n
          SET title = v.title, description = v.description
          FROM jsonb_to_recordset(${values}::jsonb) AS v(node_id uuid, title text, description text)
          WHERE n.project_id = ${projectId} AND n.node_id = v.node_id AND (n.title <> v.title OR n.description <> v.description)`.execute(trx);
      }
      return readState(trx, projectId);
    }
    // 由叶子变成父节点或反过来的已有节点，正文一并失效（与桌面版相同，按保存前后是否有子节点行判断）。
    const previousParents = new Set([...previous.values()].map((row) => row.parent_node_id));
    const nextParents = new Set(rows.map((row) => row.parent_node_id));
    for (const row of rows) {
      if (previous.has(row.node_id) && previousParents.has(row.node_id) !== nextParents.has(row.node_id)) affected.add(row.node_id);
    }
    const clearAll = reason === 'replace';
    const meta = await trx.selectFrom('technical_plan_meta').select('content_generation_runtime').where('project_id', '=', projectId).executeTakeFirst();
    await writeOutlineNodes(
      trx,
      context,
      projectId,
      rows.map((row) => {
        const saved = previous.get(row.node_id);
        const content = clearAll || affected.has(row.node_id) ? '' : saved ? saved.content : (row.content ?? '');
        return { ...row, content };
      }),
    );
    const invalidated = [...affected].filter((id) => UUID.test(id));
    await discardSectionBodies(trx, projectId, clearAll ? null : invalidated);
    for (const table of ['technical_plan_content_sections', 'technical_plan_content_plans'] as const) {
      if (!clearAll && invalidated.length === 0) continue;
      let removal = trx.deleteFrom(table).where('project_id', '=', projectId);
      if (!clearAll) removal = removal.where('node_id', 'in', invalidated);
      await removal.execute();
    }
    const runtime = clearAll
      ? null
      : serializeRuntime(
          retainRuntimeAfterOutlineChange(meta?.content_generation_runtime, {
            rows,
            previousIds: new Set(previous.keys()),
            previousParents,
            affected,
          }),
        );
    await writeMeta(trx, context, projectId, {
      outline_project_name: header.name,
      outline_project_overview: header.overview,
      content_generation_runtime: runtime,
      ...(rows.length === 0 ? { outline_word_control_snapshot: null } : {}),
    });
    return readState(trx, projectId);
  });
}

export interface GeneratedOutlineInput {
  /** 生成的目录，null 或空目录表示删除目录。 */
  outlineData: unknown;
  /** 目录生成时生效的字数控制；null 清空。 */
  wordControlSnapshot: Partial<OutlineWordControlOptions> | null;
}

/**
 * 写入目录生成的结果（给第 6 步的目录生成任务用，取代桌面版任务 checkpoint 中的 outlineData 与 outlineWordControlSnapshot）：
 * 与 saveOutline 的 replace 相同整体替换、清空全部正文、正文生成状态、编排与运行进度，同时写入字数控制快照。目录不合法时
 * 返回 400（AppError）。
 */
export async function saveGeneratedOutline(db: Kysely<Database>, context: TenantContext, projectId: string, input: GeneratedOutlineInput): Promise<void> {
  const { rows, header } = parseOutline(input.outlineData);
  const snapshot = rows.length > 0 && input.wordControlSnapshot ? JSON.stringify(normalizeWordControl(input.wordControlSnapshot)) : null;
  await withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await writeOutlineNodes(
      trx,
      context,
      projectId,
      rows.map((row) => ({ ...row, content: '' })),
    );
    await discardSectionBodies(trx, projectId, null);
    await trx.deleteFrom('technical_plan_content_sections').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('technical_plan_content_plans').where('project_id', '=', projectId).execute();
    await writeMeta(trx, context, projectId, {
      content_generation_runtime: null,
      outline_project_name: header.name,
      outline_project_overview: header.overview,
      outline_word_control_snapshot: snapshot,
    });
  });
}

/** 在已加项目锁的事务中整体替换全局事实并清空正文阶段；内容未变的分组沿用原来的 updated_at。 */
async function replaceGlobalFacts(trx: Trx, context: TenantContext, projectId: string, normalized: ReturnType<typeof normalizeGlobalFactGroups>): Promise<void> {
  const previous = new Map((await readGlobalFacts(trx, projectId)).map((fact) => [fact.id, fact]));
  await trx.deleteFrom('technical_plan_global_fact_groups').where('project_id', '=', projectId).execute();
  if (normalized.length > 0) {
    await trx
      .insertInto('technical_plan_global_fact_groups')
      .values(
        normalized.map((group, index) => {
          const saved = previous.get(group.id);
          const unchanged = saved && saved.title === group.title && saved.content === group.content;
          return {
            org_id: context.orgId,
            project_id: projectId,
            group_id: group.id,
            title: group.title,
            content: group.content,
            sort_order: index,
            ...(unchanged ? { updated_at: saved.updated_at } : {}),
          };
        }),
      )
      .execute();
  }
  await clearContentGeneration(trx, context, projectId);
}

/**
 * 保存全局事实（与桌面版 saveGlobalFacts 相同）：按 normalizeGlobalFactGroups 整理后整体替换，同时清空正文阶段
 * （clearContentGeneration：全部正文、正文生成状态、编排与运行进度）。内容未变的分组沿用原来的 updated_at。全局事实生成任务
 * 经 saveGlobalFactsResult 写入（同样的整理与清空，另核对输入签名）。分组过多或超长时返回 400。
 */
export async function saveGlobalFacts(db: Kysely<Database>, context: TenantContext, projectId: string, groups: unknown): Promise<TechnicalPlanState> {
  let normalized: ReturnType<typeof normalizeGlobalFactGroups>;
  try {
    normalized = normalizeGlobalFactGroups(groups);
  } catch (error) {
    if (error instanceof OutlineInputError) throw outlineInvalid(error);
    throw error;
  }
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await replaceGlobalFacts(trx, context, projectId, normalized);
    return readState(trx, projectId);
  });
}

/**
 * 手工保存一节正文（与桌面版 saveChapterContent 相同）：写入节点的正文，该节的生成状态改为 success（正文为空时 idle）、清除
 * 错误；编排与运行进度不变。节点不在目录中时返回 404，正文超长时返回 400。桌面版“正文生成任务运行或暂停中不能手工编辑”的
 * 检查随第 6 步的任务队列。
 */
export async function saveChapterContent(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  nodeId: string,
  content: string,
): Promise<TechnicalPlanState> {
  const id = nodeId.trim().toLowerCase();
  const text = stripNul(String(content ?? ''));
  if (charLength(text) > TECHNICAL_PLAN_CONTENT_MAX) throw invalid(`章节正文超过 ${TECHNICAL_PLAN_CONTENT_MAX} 字`);
  if (!UUID.test(id)) throw chapterNotFound();
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const result = await trx
      .updateTable('technical_plan_outline_nodes')
      .set({ content: text })
      .where('project_id', '=', projectId)
      .where('node_id', '=', id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw chapterNotFound();
    const status = text.trim() ? 'success' : 'idle';
    await trx
      .insertInto('technical_plan_content_sections')
      .values({ org_id: context.orgId, project_id: projectId, node_id: id, status, error: null })
      .onConflict((oc) => oc.columns(['project_id', 'node_id']).doUpdateSet({ status, error: null }))
      .execute();
    return readState(trx, projectId);
  });
}

/**
 * 重置正文阶段（取代桌面版 taskService.resetContentGeneration）：保留目录、全局事实和生成配置，清空全部正文、正文生成状态、
 * 编排与运行进度。取消正在运行的正文生成任务随第 6 步。
 */
export async function resetContentGeneration(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<TechnicalPlanState> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await clearContentGeneration(trx, context, projectId);
    return readState(trx, projectId);
  });
}

/**
 * 清空技术方案（与桌面版 clearTechnicalPlan 相同）：删除招标解析结果、目录（含正文）、全局事实、选中的解析项与引用的知识库
 * 文档，招标文件与原方案的原件软删除（进回收站），页面状态和生成配置恢复默认值。返回软删除的文件数。
 */
export async function clearTechnicalPlan(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<{ deletedFileCount: number }> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const documents = await trx.selectFrom('technical_plan_documents').select('file_id').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('technical_plan_bid_items').where('project_id', '=', projectId).execute();
    await deleteOutlineAndFacts(trx, projectId);
    const config = await trx.selectFrom('technical_plan_generation_config').select('project_id').where('project_id', '=', projectId).executeTakeFirst();
    if (config) await writeGenerationConfig(trx, context, projectId, await defaultGenerationConfig(trx));
    await trx
      .updateTable('technical_plan_meta')
      .set({ step: 'document-analysis', ...RESET_BID_SECTIONS, ...RESET_OUTLINE_META })
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

/** 任务开始时的输入签名（写入时核对）。 */
export interface TechnicalPlanInputSignatures {
  /** 招标文件：按导入顺序的文件、解析状态、Markdown 产物与正文哈希（多标段识别的输入）。 */
  tender: string;
  /** 招标文件加上单 / 多标段、识别出的标段与选中的投标范围（招标解析的输入）。 */
  analysis: string;
}

/** 写入前核对的签名：给出的每一项都须与当前相同。 */
export type SignatureGuard = Partial<TechnicalPlanInputSignatures>;

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function readSignatures(trx: Trx, projectId: string): Promise<TechnicalPlanInputSignatures> {
  const documents = await trx
    .selectFrom('technical_plan_documents')
    .select(['file_id', 'status', 'markdown_artifact_id', 'content_hash'])
    .where('project_id', '=', projectId)
    .where('role', '=', 'tender')
    .orderBy('sort_order')
    .orderBy('created_at')
    .orderBy('file_id')
    .execute();
  const meta = await trx.selectFrom('technical_plan_meta').select(['bid_sections', 'selected_section_id']).where('project_id', '=', projectId).executeTakeFirst();
  const config = await trx.selectFrom('technical_plan_generation_config').select('bid_section_mode').where('project_id', '=', projectId).executeTakeFirst();
  const tender = sha256Hex(JSON.stringify(documents.map((row) => [row.file_id, row.status, row.markdown_artifact_id, row.content_hash])));
  const analysis = sha256Hex(
    JSON.stringify([tender, config?.bid_section_mode ?? null, meta?.selected_section_id ?? null, normalizeBidSections(meta?.bid_sections ?? [])]),
  );
  return { tender, analysis };
}

/** 当前的输入签名（任务开始时读取，写入时作为 SignatureGuard 传回）。 */
export async function inputSignatures(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<TechnicalPlanInputSignatures> {
  return withTenant(db, context, (trx) => readSignatures(trx, projectId));
}

/** 在已加项目锁的事务中核对签名。 */
async function guardHolds(trx: Trx, projectId: string, guard: SignatureGuard | undefined): Promise<boolean> {
  if (!guard || (guard.tender === undefined && guard.analysis === undefined)) return true;
  const current = await readSignatures(trx, projectId);
  return (guard.tender === undefined || guard.tender === current.tender) && (guard.analysis === undefined || guard.analysis === current.analysis);
}

export interface DocumentParseInput {
  status?: TechnicalPlanDocumentStatus;
  markdownArtifactId?: string | null;
  contentChars?: number;
  /** 解析出的正文的哈希。 */
  contentHash?: string | null;
  parserLabel?: string | null;
  error?: string | null;
  /** 疑似多标段检测摘要（招标文件解析成功时由解析任务算出），null 清空。 */
  bidSectionDetection?: BidSectionDetectionSummary | null;
}

/**
 * 写入一份招标文件或原方案的解析结果（给第 6 步的解析任务用，取代桌面版导入时同步解析写入的 markdownPath、contentHash 等）：
 * 只写给出的字段。markdownArtifactId 只能是本文档原件的 Markdown 产物，否则被 RLS 拒绝。文档已移除（原件进回收站）时
 * 返回 false。参数不合法（文件 id、产物 id 不是 uuid，哈希超长，检测摘要不合法）是调用方的程序错误，抛 TypeError。
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
    ...(hasOwn(input, 'bidSectionDetection')
      ? { bid_section_detection: input.bidSectionDetection ? JSON.stringify(parseBidSectionDetectionSummary(input.bidSectionDetection)) : null }
      : {}),
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

function bidItemRows(context: TenantContext, projectId: string, items: Partial<Record<string, BidItemInput>>) {
  return Object.entries(items).map(([itemId, item]) => {
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
}

async function upsertBidItems(trx: Trx, rows: ReturnType<typeof bidItemRows>): Promise<void> {
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
}

/**
 * 写入招标解析项的结果（给第 6 步的招标解析任务用，取代桌面版 updateTechnicalPlan 的 bidAnalysisTasks / bidAnalysisItem /
 * projectOverview / techRequirements）：与桌面版 saveBidItems 相同，给出的项逐项覆盖写入（名称默认取任务列表，排序按任务
 * 列表），null 或空对象删除全部结果。给出 guard 时先核对签名，不符时不写入并返回 false。解析项 id 不在任务列表中是调用方的
 * 程序错误，抛 TypeError；文本超长时截短。
 */
export async function saveBidItems(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  items: Partial<Record<string, BidItemInput>> | null,
  guard?: SignatureGuard,
): Promise<boolean> {
  const rows = bidItemRows(context, projectId, items ?? {});
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (!(await guardHolds(trx, projectId, guard))) return false;
    if (rows.length === 0) {
      await trx.deleteFrom('technical_plan_bid_items').where('project_id', '=', projectId).execute();
      return true;
    }
    await upsertBidItems(trx, rows);
    return true;
  });
}

/**
 * 全部重新解析前的重置（与桌面版 runBidAnalysisTask 在 force_rerun 时的 initialPartial 相同）：选中的解析项恢复为空的 idle，
 * 删除目录（含正文）与全局事实，目录的项目名称、概述、字数控制快照和正文生成的运行进度清空，正文生成选项恢复默认值；
 * 引用的知识库文档、步骤与其他解析项不变。签名不符时不写入并返回 false。
 */
export async function resetBidAnalysisForRerun(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  itemIds: readonly TechnicalPlanBidItemId[],
  guard: SignatureGuard,
): Promise<boolean> {
  const rows = bidItemRows(context, projectId, Object.fromEntries(itemIds.map((id) => [id, { status: 'idle', content: '', error: null }])));
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (!(await guardHolds(trx, projectId, guard))) return false;
    if (rows.length > 0) await upsertBidItems(trx, rows);
    await deleteOutlineAndFacts(trx, projectId);
    await writeMeta(trx, context, projectId, RESET_OUTLINE_META);
    await updateGenerationConfig(trx, context, projectId, { contentGenerationOptions: DEFAULT_CONTENT_OPTIONS });
    return true;
  });
}

/**
 * 开始多标段识别（给第 6 步的识别任务用，与桌面版 prepareBidSectionExtraction 相同）：清空下游，生成配置切到多标段，
 * 识别结果与投标范围清空，状态置为 running。给出 guard 时先核对签名，不符时不写入并返回 false。
 */
export async function prepareBidSectionExtraction(db: Kysely<Database>, context: TenantContext, projectId: string, guard?: SignatureGuard): Promise<boolean> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (!(await guardHolds(trx, projectId, guard))) return false;
    await clearDownstreamFromBidSectionChange(trx, context, projectId);
    await updateGenerationConfig(trx, context, projectId, { bidSectionMode: 'multiple' });
    await writeMeta(trx, context, projectId, { ...RESET_BID_SECTIONS, bid_section_extraction_status: 'running' });
    return true;
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
 * bidSectionExtractionStatus / bidSectionExtractionError）：只写给出的字段。给出 guard 时先核对签名，不符时不写入并返回 false。
 * 整理后的标段列表超过大小上限是调用方的程序错误，抛 TypeError；文本超长时截短。
 */
export async function saveBidSectionExtraction(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: BidSectionExtractionInput,
  guard?: SignatureGuard,
): Promise<boolean> {
  const set: MetaPatch = {};
  if (hasOwn(input, 'status')) set.bid_section_extraction_status = oneOf(input.status, TECHNICAL_PLAN_RUN_STATUSES, 'idle');
  if (hasOwn(input, 'error')) set.bid_section_extraction_error = optionalText(input.error, TECHNICAL_PLAN_TEXT_MAX);
  if (hasOwn(input, 'sections')) {
    const sections = input.sections === null || input.sections === undefined ? null : JSON.stringify(normalizeBidSections(input.sections));
    // jsonb 的文本形式在冒号、逗号后多一个空格，比 JSON.stringify 的结果长，这里留出余量。
    if (sections !== null && Buffer.byteLength(sections) > (TECHNICAL_PLAN_BID_SECTIONS_MAX_BYTES * 3) / 4) throw new TypeError('标段列表过大');
    set.bid_sections = sections;
  }
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (!(await guardHolds(trx, projectId, guard))) return false;
    await writeMeta(trx, context, projectId, set);
    return true;
  });
}

export interface ContentSectionInput {
  status?: TechnicalPlanRunStatus;
  error?: string | null;
  /** 给出时同时写入该节的正文。 */
  content?: string;
}

/** 本项目目录中存在的节点（ids 已是小写 uuid）。 */
async function existingNodeIds(trx: Trx, projectId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await trx.selectFrom('technical_plan_outline_nodes').select('node_id').where('project_id', '=', projectId).where('node_id', 'in', ids).execute();
  return new Set(rows.map((row) => row.node_id));
}

function sectionValues(context: TenantContext, projectId: string, nodeId: string, section: ContentSectionInput | null | undefined) {
  return {
    org_id: context.orgId,
    project_id: projectId,
    node_id: nodeId,
    status: oneOf(section?.status, TECHNICAL_PLAN_RUN_STATUSES, 'idle'),
    error: optionalText(section?.error, TECHNICAL_PLAN_TEXT_MAX),
  };
}

async function upsertSections(trx: Trx, rows: ReturnType<typeof sectionValues>[]): Promise<void> {
  await insertChunked(rows, (chunk) =>
    trx
      .insertInto('technical_plan_content_sections')
      .values(chunk)
      .onConflict((oc) => oc.columns(['project_id', 'node_id']).doUpdateSet((eb) => ({ status: eb.ref('excluded.status'), error: eb.ref('excluded.error') })))
      .execute(),
  );
}

/** 写入若干节的正文（任务写入：超长时截短）。 */
async function writeNodeContents(trx: Trx, projectId: string, contents: { node_id: string; content: string }[]): Promise<void> {
  if (contents.length === 0) return;
  await sql`UPDATE technical_plan_outline_nodes n SET content = v.content
    FROM jsonb_to_recordset(${JSON.stringify(contents)}::jsonb) AS v(node_id uuid, content text)
    WHERE n.project_id = ${projectId} AND n.node_id = v.node_id AND n.content <> v.content`.execute(trx);
}

/**
 * 整体写入各节的正文生成状态（给第 8 步的正文生成任务用，取代桌面版 updateTechnicalPlan 的 contentGenerationSections）：与桌面版
 * saveContentSections 相同，给出的节逐节写入状态与错误（给出 content 时同时写入正文），其余节的状态删除；null 或空对象删除
 * 全部。已不在目录中的节点跳过（用户可能已删除）。节点 id 不是 uuid 是调用方的程序错误，抛 TypeError；文本超长时截短。
 */
export async function saveContentSections(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  sections: Partial<Record<string, ContentSectionInput>> | null,
): Promise<void> {
  const entries = Object.entries(sections ?? {}).map(([nodeId, section]) => [uuid(nodeId, '节点 id'), section] as const);
  await withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const existing = await existingNodeIds(trx, projectId, entries.map(([id]) => id));
    const kept = entries.filter(([id]) => existing.has(id));
    let removal = trx.deleteFrom('technical_plan_content_sections').where('project_id', '=', projectId);
    if (kept.length > 0) removal = removal.where('node_id', 'not in', kept.map(([id]) => id));
    await removal.execute();
    await upsertSections(trx, kept.map(([id, section]) => sectionValues(context, projectId, id, section)));
    await writeNodeContents(
      trx,
      projectId,
      kept.filter(([, section]) => section && hasOwn(section, 'content')).map(([id, section]) => ({ node_id: id, content: taskText(section!.content, TECHNICAL_PLAN_CONTENT_MAX) })),
    );
  });
}

async function upsertPlans(trx: Trx, context: TenantContext, projectId: string, plans: [string, NonNullable<ReturnType<typeof normalizeContentPlan>>][]): Promise<void> {
  await insertChunked(
    plans.map(([nodeId, plan]) => ({ org_id: context.orgId, project_id: projectId, node_id: nodeId, ...plan, plan: JSON.stringify(plan.plan) })),
    (chunk) =>
      trx
        .insertInto('technical_plan_content_plans')
        .values(chunk)
        .onConflict((oc) =>
          oc.columns(['project_id', 'node_id']).doUpdateSet((eb) => ({
            plan_version: eb.ref('excluded.plan_version'),
            plan: eb.ref('excluded.plan'),
            table_requirement: eb.ref('excluded.table_requirement'),
          })),
        )
        .execute(),
  );
}

/**
 * 整体写入各节的正文编排（给第 8 步的正文生成任务用，取代桌面版 updateTechnicalPlan 的 contentGenerationPlans）：与桌面版
 * saveContentPlans 相同，只保存 plan 是对象、plan_version 大于 0 的节，其余节的编排删除；null 或空对象删除全部。已不在目录中的
 * 节点跳过。节点 id 不是 uuid、编排过大是调用方的程序错误，抛 TypeError。
 */
export async function saveContentPlans(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  plans: Partial<Record<string, unknown>> | null,
): Promise<void> {
  const entries = Object.entries(plans ?? {}).flatMap(([nodeId, value]) => {
    const id = uuid(nodeId, '节点 id');
    const plan = normalizeContentPlan(value);
    return plan ? [[id, plan] as [string, typeof plan]] : [];
  });
  await withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const existing = await existingNodeIds(trx, projectId, entries.map(([id]) => id));
    const kept = entries.filter(([id]) => existing.has(id));
    let removal = trx.deleteFrom('technical_plan_content_plans').where('project_id', '=', projectId);
    if (kept.length > 0) removal = removal.where('node_id', 'not in', kept.map(([id]) => id));
    await removal.execute();
    await upsertPlans(trx, context, projectId, kept);
  });
}

export interface ContentGenerationItemInput {
  nodeId: string;
  /** 该节的正文与状态（content 未给出时正文置空，与桌面版相同）。 */
  section?: ContentSectionInput | null;
  /** 该节的编排，不合规（plan 不是对象、版本不大于 0）时跳过。 */
  plan?: unknown;
  /** 给出时整体替换运行进度，null 清除。 */
  runtime?: ContentRuntime | null;
}

/**
 * 写入一节的生成结果（给第 8 步的正文生成任务用，取代桌面版 updateTechnicalPlan 的 contentGenerationItem）：与桌面版
 * saveContentGenerationItemFields 相同，给出的部分各自写入。节点已不在目录中时跳过正文、状态与编排，返回 false（运行进度
 * 照常写入）。参数不合法是调用方的程序错误，抛 TypeError。
 */
export async function saveContentGenerationItem(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: ContentGenerationItemInput,
): Promise<boolean> {
  const id = uuid(input.nodeId, '节点 id');
  const plan = input.plan === undefined ? null : normalizeContentPlan(input.plan);
  const runtime = hasOwn(input, 'runtime') ? serializeRuntime(input.runtime) : undefined;
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const exists = (await existingNodeIds(trx, projectId, [id])).has(id);
    if (exists && input.section) {
      await trx
        .updateTable('technical_plan_outline_nodes')
        .set({ content: taskText(input.section.content, TECHNICAL_PLAN_CONTENT_MAX) })
        .where('project_id', '=', projectId)
        .where('node_id', '=', id)
        .execute();
      await upsertSections(trx, [sectionValues(context, projectId, id, input.section)]);
    }
    if (exists && plan) await upsertPlans(trx, context, projectId, [[id, plan]]);
    if (runtime !== undefined) await writeMeta(trx, context, projectId, { content_generation_runtime: runtime });
    return exists;
  });
}

/**
 * 写入一节 AI 正文（给第 8 步的正文生成任务用，取代桌面版工作区中的 正文/<节点 id>.html，8.10a）：经服务端受限 HTML
 * 白名单规范化后整体替换（sectionBodies.ts）。不符合规范时抛 SectionBodyRejectedError（422，带问题清单），节点不在目录中
 * 时 404，不是 ai-generate 叶子时 409；节点 id 不是 uuid 是调用方的程序错误，抛 TypeError。
 */
export async function saveSectionBody(db: Kysely<Database>, context: TenantContext, projectId: string, nodeId: string, html: string): Promise<SectionBody> {
  const id = uuid(nodeId, '节点 id');
  const prepared = prepareSectionBody(html);
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    return writeSectionBody(trx, context.orgId, projectId, id, prepared);
  });
}

/** 读取一节 AI 正文；节点 id 不合法或没有正文时返回 null。 */
export async function getSectionBody(db: Kysely<Database>, context: TenantContext, projectId: string, nodeId: string): Promise<SectionBody | null> {
  const id = nodeId.trim().toLowerCase();
  if (!UUID.test(id)) return null;
  return withTenant(db, context, (trx) => readSectionBody(trx, projectId, id));
}

/**
 * 整体写入正文生成的运行进度（给第 8 步的正文生成任务用，取代桌面版 updateTechnicalPlan 的 contentGenerationRuntime），
 * null 清除。不是对象或过大是调用方的程序错误，抛 TypeError。
 */
export async function saveContentGenerationRuntime(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  runtime: ContentRuntime | null,
): Promise<void> {
  const value = serializeRuntime(runtime);
  await withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await writeMeta(trx, context, projectId, { content_generation_runtime: value });
  });
}

// ---- 全局事实生成（第 8 步 8.7c1） ----

/** 在事务中计算全局事实生成的输入签名（见 globalFactsInputSignature）。 */
async function readGlobalFactsSignature(trx: Trx, projectId: string): Promise<string> {
  const { analysis } = await readSignatures(trx, projectId);
  const originalPlans = await trx
    .selectFrom('technical_plan_documents')
    .select(['file_id', 'status', 'markdown_artifact_id', 'content_hash'])
    .where('project_id', '=', projectId)
    .where('role', '=', 'original-plan')
    .orderBy('created_at')
    .orderBy('file_id')
    .execute();
  const items = await trx
    .selectFrom('technical_plan_bid_items')
    .select(['item_id', 'status', 'content'])
    .where('project_id', '=', projectId)
    .orderBy('item_id')
    .execute();
  const nodes = await trx
    .selectFrom('technical_plan_outline_nodes')
    .select(['node_id', 'parent_node_id', 'sort_order', 'level', 'title', 'description'])
    .where('project_id', '=', projectId)
    .orderBy('level')
    .orderBy('parent_node_id')
    .orderBy('sort_order')
    .orderBy('node_id')
    .execute();
  const config = await trx.selectFrom('technical_plan_generation_config').select('global_facts_mode').where('project_id', '=', projectId).executeTakeFirst();
  const references = await trx
    .selectFrom('technical_plan_generation_reference_docs')
    .select('document_id')
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('document_id')
    .execute();
  const facts = await trx
    .selectFrom('technical_plan_global_fact_groups')
    .select(['group_id', 'title', 'content'])
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('group_id')
    .execute();
  return sha256Hex(
    JSON.stringify([
      analysis,
      originalPlans.map((row) => [row.file_id, row.status, row.markdown_artifact_id, row.content_hash]),
      items.map((row) => [row.item_id, row.status, row.content]),
      nodes.map((row) => [row.node_id, row.parent_node_id, row.sort_order, row.level, row.title, row.description]),
      config?.global_facts_mode ?? null,
      references.map((row) => row.document_id),
      facts.map((row) => [row.group_id, row.title, row.content]),
    ]),
  );
}

/**
 * 全局事实生成的输入签名（任务开始时读取，写入时传回）：招标文件与投标范围（招标解析的签名）、原方案、招标解析项的结果、目录的结构
 * 与标题说明、全局事实的写法与引用的知识库文档，以及当前的全局事实（任务开始后用户手动保存了全局事实时，不覆盖）。知识库条目的
 * 内容不在其中（与可研任务相同）。
 */
export async function globalFactsInputSignature(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<string> {
  return withTenant(db, context, (trx) => readGlobalFactsSignature(trx, projectId));
}

/**
 * 全局事实生成与调整任务的结果：与 saveGlobalFacts 相同整理后整体替换并清空正文阶段，在项目锁内核对输入签名，不符时不写入、返回 false。
 * 分组过多或超长时抛 OutlineInputError（任务的提交校验已先检查）。
 */
export async function saveGlobalFactsResult(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  groups: readonly { id: string; title: string; content: string }[],
  expectedSignature: string,
): Promise<boolean> {
  const normalized = normalizeGlobalFactGroups(groups);
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if ((await readGlobalFactsSignature(trx, projectId)) !== expectedSignature) return false;
    await replaceGlobalFacts(trx, context, projectId, normalized);
    return true;
  });
}

async function readOutlineAdjustmentSignature(trx: Trx, projectId: string): Promise<string> {
  const { analysis } = await readSignatures(trx, projectId);
  const nodes = await trx
    .selectFrom('technical_plan_outline_nodes')
    .select([
      'node_id',
      'parent_node_id',
      'sort_order',
      'level',
      'title',
      'description',
      'content_mode',
      'content_mode_note',
      'source_requirement_id',
      'source_requirement_title',
      'knowledge_item_ids',
      sql<string>`md5(content)`.as('content_md5'),
    ])
    .where('project_id', '=', projectId)
    .orderBy('level')
    .orderBy('parent_node_id')
    .orderBy('sort_order')
    .orderBy('node_id')
    .execute();
  const meta = await trx.selectFrom('technical_plan_meta').select(['outline_project_name', 'outline_project_overview']).where('project_id', '=', projectId).executeTakeFirst();
  return sha256Hex(
    JSON.stringify([
      analysis,
      nodes.map((row) => [
        row.node_id,
        row.parent_node_id,
        row.sort_order,
        row.level,
        row.title,
        row.description,
        row.content_mode,
        row.content_mode_note,
        row.source_requirement_id,
        row.source_requirement_title,
        row.knowledge_item_ids,
        row.content_md5,
      ]),
      meta?.outline_project_name ?? null,
      meta?.outline_project_overview ?? null,
    ]),
  );
}

/**
 * 目录调整的输入签名（8.7d；任务开始时读取，写入时传回）：招标文件与投标范围（招标解析的签名）与当前目录（各节点的全部字段、正文的
 * 摘要、目录的项目名称与概述）。任务开始后用户改过目录（排序、编辑、增删、正文）或招标文件、投标范围变化时，调整结果不覆盖。
 */
export async function outlineAdjustmentInputSignature(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<string> {
  return withTenant(db, context, (trx) => readOutlineAdjustmentSignature(trx, projectId));
}

/**
 * 目录调整任务的结果（8.7d）：与 saveOutline 的 replace 相同整体替换目录，清空全部正文、正文生成状态、编排与运行进度（桌面版
 * saveOutline({ reason: 'replace' })），字数控制快照不变。在项目锁内核对输入签名，不符时不写入、返回 false。目录不合法时抛
 * OutlineInputError（任务的提交校验已先检查）。
 */
export async function saveOutlineAdjustmentResult(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  outlineData: { outline: unknown; project_name?: string | undefined; project_overview?: string | undefined },
  expectedSignature: string,
): Promise<boolean> {
  const rows = flattenOutline(outlineData.outline);
  if (rows.length === 0) throw new OutlineInputError('目录不能为空');
  const header = outlineHeader(outlineData);
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if ((await readOutlineAdjustmentSignature(trx, projectId)) !== expectedSignature) return false;
    await writeOutlineNodes(
      trx,
      context,
      projectId,
      rows.map((row) => ({ ...row, content: '' })),
    );
    await discardSectionBodies(trx, projectId, null);
    await trx.deleteFrom('technical_plan_content_sections').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('technical_plan_content_plans').where('project_id', '=', projectId).execute();
    await writeMeta(trx, context, projectId, {
      content_generation_runtime: null,
      outline_project_name: header.name,
      outline_project_overview: header.overview,
    });
    return true;
  });
}

// ---- 目录生成（第 8 步 8.7e1） ----

async function readOutlineGenerationSignature(trx: Trx, projectId: string): Promise<string> {
  const outline = await readOutlineAdjustmentSignature(trx, projectId);
  const originalPlans = await trx
    .selectFrom('technical_plan_documents')
    .select(['file_id', 'status', 'markdown_artifact_id', 'content_hash'])
    .where('project_id', '=', projectId)
    .where('role', '=', 'original-plan')
    .orderBy('created_at')
    .orderBy('file_id')
    .execute();
  const items = await trx
    .selectFrom('technical_plan_bid_items')
    .select(['item_id', 'status', 'content'])
    .where('project_id', '=', projectId)
    .orderBy('item_id')
    .execute();
  const config = await trx
    .selectFrom('technical_plan_generation_config')
    .select(['outline_mode', 'outline_expansion_mode', 'minimum_words', 'maximum_words', 'section_words'])
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  const references = await trx
    .selectFrom('technical_plan_generation_reference_docs')
    .select('document_id')
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('document_id')
    .execute();
  const facts = await trx
    .selectFrom('technical_plan_global_fact_groups')
    .select(['group_id', 'title', 'content'])
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('group_id')
    .execute();
  return sha256Hex(
    JSON.stringify([
      outline,
      originalPlans.map((row) => [row.file_id, row.status, row.markdown_artifact_id, row.content_hash]),
      items.map((row) => [row.item_id, row.status, row.content]),
      config ? [config.outline_mode, config.outline_expansion_mode, config.minimum_words, config.maximum_words, config.section_words] : null,
      references.map((row) => row.document_id),
      facts.map((row) => [row.group_id, row.title, row.content]),
    ]),
  );
}

/**
 * 目录生成的输入签名（8.7e1；任务开始时读取，写入时传回）：招标文件与投标范围、当前目录（与目录调整的签名相同）、原方案、招标解析项的
 * 结果、目录的组织方式 / 扩展方式 / 字数控制、引用的知识库文档，以及当前的全局事实（结果会清空全局事实）。任务开始后（含等待确认一级
 * 目录期间）这些变化时，结果不覆盖。知识库文档的内容不在其中（与其他 Agent 任务相同）。
 */
export async function outlineGenerationInputSignature(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<string> {
  return withTenant(db, context, (trx) => readOutlineGenerationSignature(trx, projectId));
}

/**
 * 目录生成任务的结果（8.7e1，桌面版完成时的 outlineData / outlineWordControlSnapshot 与开始时的清空）：整体替换目录（项目概述取给出的，
 * 没有项目名称），清空全部正文、正文生成状态、编排与运行进度和全局事实，写入字数控制快照。在项目锁内核对输入签名，不符时不写入、
 * 返回 false。目录不合法时抛 OutlineInputError（任务的提交校验已先检查）。
 */
export async function saveOutlineGenerationResult(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: { outline: unknown; projectOverview: string; wordControl: OutlineWordControlOptions },
  expectedSignature: string,
): Promise<boolean> {
  const rows = flattenOutline(input.outline);
  if (rows.length === 0) throw new OutlineInputError('目录不能为空');
  const header = outlineHeader({ outline: input.outline, project_overview: input.projectOverview });
  const snapshot = JSON.stringify(normalizeWordControl(input.wordControl));
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if ((await readOutlineGenerationSignature(trx, projectId)) !== expectedSignature) return false;
    await writeOutlineNodes(
      trx,
      context,
      projectId,
      rows.map((row) => ({ ...row, content: '' })),
    );
    await discardSectionBodies(trx, projectId, null);
    await trx.deleteFrom('technical_plan_content_sections').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('technical_plan_content_plans').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('technical_plan_global_fact_groups').where('project_id', '=', projectId).execute();
    await writeMeta(trx, context, projectId, {
      content_generation_runtime: null,
      outline_project_name: header.name,
      outline_project_overview: header.overview,
      outline_word_control_snapshot: snapshot,
    });
    return true;
  });
}

/**
 * 生成配置引用的知识库文档的 Markdown（桌面版 knowledgeBaseService.readReferences(ids, { includeMarkdown: true })），按引用顺序；文档已
 * 删除的不在其中，还没有解析出 Markdown 或对象已不在存储中的为空（与桌面版文件不存在时相同）。总大小受
 * TECHNICAL_PLAN_MARKDOWN_READ_MAX_BYTES 限制（超过时 422）。
 */
export async function readOutlineKnowledgeMarkdowns(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  objectStore: ObjectStore | null,
): Promise<string[]> {
  const rows = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('technical_plan_generation_reference_docs as r')
      .innerJoin('knowledge_documents as d', 'd.id', 'r.document_id')
      .leftJoin('artifacts as a', (join) => join.onRef('a.id', '=', 'd.markdown_artifact_id').on('a.status', '=', 'ready'))
      .select(['r.document_id', 'a.storage_key', 'a.size_bytes'])
      .where('r.project_id', '=', projectId)
      .orderBy('r.sort_order')
      .orderBy('r.document_id')
      .execute(),
  );
  const present = rows.filter((row): row is typeof row & { storage_key: string } => typeof row.storage_key === 'string');
  const texts = await readArtifactTexts(objectStore, present.map((row) => ({ storageKey: row.storage_key, size: Number(row.size_bytes ?? 0) })));
  const byDocument = new Map(present.map((row, index) => [row.document_id, texts[index] ?? '']));
  return rows.map((row) => byDocument.get(row.document_id) ?? '');
}

export interface GlobalFactsSources {
  /** 各招标文件解析出的 Markdown 原文（不按投标范围裁剪），按导入顺序；还没有解析出 Markdown 的文件不在其中。 */
  tenderFiles: { fileName: string; markdown: string }[];
  /** 原方案解析出的 Markdown（没有原方案或还没有解析出时为空）。 */
  originalPlanMarkdown: string;
}

/**
 * 全局事实生成读取的原文（桌面版 readTenderSourceMarkdown 与 readOriginalPlanMarkdown）：招标文件与原方案分别按
 * TECHNICAL_PLAN_MARKDOWN_READ_MAX_BYTES 限制总大小（超过时 422）。tenders 为 false 时不读招标文件（选择了投标范围时，按投标范围
 * 裁剪的正文经 readTenderMarkdown 读取）。
 */
export async function readGlobalFactsSources(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  objectStore: ObjectStore | null,
  options: { tenders: boolean },
): Promise<GlobalFactsSources> {
  const rows = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('technical_plan_documents as d')
      .innerJoin('files as f', 'f.id', 'd.file_id')
      .innerJoin('artifacts as a', 'a.id', 'd.markdown_artifact_id')
      .select(['d.role', 'd.created_at', 'f.display_name', 'a.storage_key', 'a.size_bytes'])
      .where('d.project_id', '=', projectId)
      .where('a.status', '=', 'ready')
      .orderBy('d.sort_order')
      .orderBy('d.created_at')
      .orderBy('d.file_id')
      .execute(),
  );
  const artifact = (row: (typeof rows)[number]) => ({ storageKey: row.storage_key, size: Number(row.size_bytes ?? 0) });
  const tenders = options.tenders ? rows.filter((row) => row.role === 'tender') : [];
  // 原方案只有一份；与 readState 相同取最近导入的一份。
  const plan = rows.filter((row) => row.role === 'original-plan').reduce<(typeof rows)[number] | null>((latest, row) => (!latest || row.created_at > latest.created_at ? row : latest), null);
  const texts = await readArtifactTexts(objectStore, tenders.map(artifact));
  const [planText] = plan ? await readArtifactTexts(objectStore, [artifact(plan)]) : [null];
  return {
    tenderFiles: tenders.flatMap((row, index) => (texts[index] === null ? [] : [{ fileName: row.display_name, markdown: texts[index]! }])),
    originalPlanMarkdown: planText ?? '',
  };
}

/** 生成配置引用的知识库文档中的条目（桌面版 knowledgeBaseService.readReferences），按引用顺序、文档内按条目顺序。 */
export async function readGlobalFactsKnowledgeItems(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
): Promise<{ documentId: string; itemId: string; title: string; resume: string; content: string }[]> {
  const rows = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('technical_plan_generation_reference_docs as r')
      .innerJoin('knowledge_documents as d', 'd.id', 'r.document_id')
      .innerJoin('knowledge_items as i', 'i.document_id', 'd.id')
      .select(['r.document_id', 'i.item_id', 'i.title', 'i.resume', 'i.content'])
      .where('r.project_id', '=', projectId)
      .orderBy('r.sort_order')
      .orderBy('r.document_id')
      .orderBy('i.sort_order')
      .orderBy('i.item_id')
      .execute(),
  );
  return rows.map((row) => ({ documentId: row.document_id, itemId: row.item_id, title: row.title, resume: row.resume, content: row.content }));
}
