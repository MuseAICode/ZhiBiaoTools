// 可研报告的读写（迁移 0017_feasibility_report）：页面状态与项目信息、可研资料、资料分析、目录配置与引用的知识库文档、
// 报告目录与各章正文、关键参数。组织和用户一律来自 TenantContext，所有查询都经 withTenant；项目由路由先经 requireProject
// 校验（kind = feasibility-report）。
//
// 可见性、写权限和删除可见性由 RLS 保证，这里不判断：所属项目已删除时四张表的行都查不到、改不了；资料随原件的生命周期，
// 原件已删除（进入回收站）时资料行不可见；引用的知识库文档不可见时引用行同样不可见。导入资料就是把已上传的 tender 文件
// 挂到本项目（files.project_id，设置后不能再改，由迁移 0015 的触发器保证）并登记到 feasibility_report_sources，资料停在
// 待解析；移除资料和清空时软删除原件（进回收站，按文件自己的恢复期处理），应用角色没有资料的 DELETE 授权。
//
// 与桌面版 feasibilityReportStore.cjs（经 taskService 调用的版本）相同：保存项目信息、导入或移除资料时清空资料分析、
// 目录和关键参数；保存资料分析时清空目录和关键参数；保存目录（排序除外）时清空关键参数，并按 reason / idMap /
// affectedNodeIds 清空受影响章节的正文；保存关键参数时清空全部正文。
//
// 第 6 步（6.12）与第 8 步（8.7a、8.7b）的任务（src/feasibilityReport/jobs.ts）：资料解析结果经 saveSourceParse 写入；资料分析、目录、
// 关键参数、正文由 saveAnalysisResult、saveOutlineResult、saveKeyParametersResult、clearChapterContents、saveChapterResult 写入，下游清空规则与用户保存相同，
// 并带上任务开始时的输入签名（inputSignature），在写入的同一事务中（项目锁内）核对，不符时不写入。正文生成或审校任务未结束
// （排队、运行、暂停、取消中）时用户不能保存目录、手工改正文（与桌面版 assertContentUnlocked 相同，409）。
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  FEASIBILITY_CONTENT_MAX,
  FEASIBILITY_FIELD_MAX,
  FEASIBILITY_KEY_MAX,
  FEASIBILITY_KNOWLEDGE_IDS_MAX_BYTES,
  FEASIBILITY_MARKDOWN_MAX,
  FEASIBILITY_NODE_ID_MAX,
  FEASIBILITY_OUTLINE_DEPTH_MAX,
  FEASIBILITY_OUTLINE_TEMPLATES,
  FEASIBILITY_PARSER_LABEL_MAX,
  FEASIBILITY_PROJECT_TYPES,
  FEASIBILITY_REPORT_STEPS,
  FEASIBILITY_SOURCE_STATUSES,
  FEASIBILITY_TARGET_WORDS_MAX,
  FEASIBILITY_TARGET_WORDS_MIN,
  FEASIBILITY_TEXT_MAX,
  FEASIBILITY_TITLE_MAX,
} from '../db/migrations/0017_feasibility_report.ts';
import type {
  Database,
  FeasibilityOutlineTemplate,
  FeasibilityProjectType,
  FeasibilityReportStep,
  FeasibilitySourceStatus,
} from '../db/schema.ts';
import { JOB_ACTIVE_STATUSES } from '../db/migrations/0021_jobs.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { latestProjectJobs } from '../jobs/store.ts';
import { jobBody, type JobBody } from '../jobs/view.ts';
import { storageDisabled } from '../knowledgeBase/content.ts';
import { findContinuableAgentSessionIn, type AgentSessionTarget } from '../agent/continuation.ts';

/** 每个项目最多的可研资料数（与其他模块的招标文件相同）。 */
export const FEASIBILITY_SOURCES_MAX = 20;
/** 目录生成最多引用的知识库文档数。 */
export const FEASIBILITY_REFERENCE_DOCUMENTS_MAX = 100;
/** 目录的最多节点数。 */
export const FEASIBILITY_OUTLINE_NODES_MAX = 2000;
/** 每章最多引用的知识库条目数。 */
export const FEASIBILITY_KNOWLEDGE_ITEMS_MAX = 200;
/** 保存目录的 reason（与桌面版相同）。 */
export const FEASIBILITY_OUTLINE_SAVE_REASONS = ['sort', 'edit', 'delete', 'add-root', 'add-child', 'replace'] as const;
export type FeasibilityOutlineSaveReason = (typeof FEASIBILITY_OUTLINE_SAVE_REASONS)[number];

/** 任务读取合并的资料正文时 Markdown 的总大小上限（整份读入内存，与其他模块相同）。 */
export const FEASIBILITY_MARKDOWN_READ_MAX_BYTES = 32 * 1024 * 1024;

/** 可研报告的任务类型（6.12、8.7a、8.7b，src/feasibilityReport/jobs.ts）。 */
export const FEASIBILITY_ANALYSIS_JOB_TYPE = 'feasibility-analysis';
/** 目录生成（8.7a）：agent 队列，在 agent 沙箱中由 Agent 写出目录。 */
export const FEASIBILITY_OUTLINE_JOB_TYPE = 'feasibility-outline';
/** 目录调整（8.7b）：agent 队列，接着目录生成（或上一次调整）的会话与工作区，按用户的要求改写目录。 */
export const FEASIBILITY_OUTLINE_ADJUSTMENT_JOB_TYPE = 'feasibility-outline-adjustment';
export const FEASIBILITY_PARAMETERS_JOB_TYPE = 'feasibility-parameters';
export const FEASIBILITY_CONTENT_JOB_TYPE = 'feasibility-content';
export const FEASIBILITY_HUMAN_WRITING_JOB_TYPE = 'feasibility-human-writing';
export const FEASIBILITY_JOB_TYPES = [
  FEASIBILITY_ANALYSIS_JOB_TYPE,
  FEASIBILITY_OUTLINE_JOB_TYPE,
  FEASIBILITY_OUTLINE_ADJUSTMENT_JOB_TYPE,
  FEASIBILITY_PARAMETERS_JOB_TYPE,
  FEASIBILITY_CONTENT_JOB_TYPE,
  FEASIBILITY_HUMAN_WRITING_JOB_TYPE,
] as const;
/** 目录生成与目录调整共用的工作区快照类别（迁移 0040 的 task_kind）。 */
export const FEASIBILITY_OUTLINE_TASK_KIND = 'feasibility-outline';
/** 调整要求的字数上限（桌面版没有限制；放入提示词，限制在 2000 字以内）。 */
export const FEASIBILITY_ADJUSTMENT_REQUIREMENT_MAX = 2000;
/** 调整说明（Agent 最后一条回复）的字数上限：桌面版提示词要求不超过 200 字，超出的截短。 */
export const FEASIBILITY_ADJUSTMENT_SUMMARY_MAX = 2000;

/** 目录调整接着的会话：目录生成或上一次调整写下的、与当前快照同一对的现场（src/agent/continuation.ts）。 */
export function feasibilityOutlineSessionTarget(projectId: string): AgentSessionTarget {
  return { projectId, taskKind: FEASIBILITY_OUTLINE_TASK_KIND, jobTypes: [FEASIBILITY_OUTLINE_JOB_TYPE, FEASIBILITY_OUTLINE_ADJUSTMENT_JOB_TYPE] };
}
/** 持有正文锁的任务类型（与桌面版 assertContentUnlocked 检查的 contentTask、humanWritingTask 相同）。 */
const CONTENT_LOCK_JOB_TYPES = [FEASIBILITY_CONTENT_JOB_TYPE, FEASIBILITY_HUMAN_WRITING_JOB_TYPE];

/** 可研报告任务的互斥键（与桌面版 feasibility-report 组的 group-exclusive 相同）。 */
export function feasibilityReportLockKey(projectId: string): string {
  return `project:${projectId}:feasibility-report`;
}

const DEFAULT_TARGET_WORDS = 30000;
const UNTITLED_CHAPTER = '未命名章节';

// ---- 读出的状态 ----

export interface FeasibilityProjectInfo {
  projectName: string;
  projectType: FeasibilityProjectType;
  industry: string;
  constructionUnit: string;
  location: string;
  constructionContent: string;
  constructionPeriodYears: string;
  operationPeriodYears: string;
  totalInvestment: string;
  fundingSource: string;
}

export interface FeasibilitySource {
  /** files.id。 */
  id: string;
  fileName: string;
  extension: string;
  size: number;
  uploadedAt: Date;
  importedAt: Date;
  /** 解析状态；新导入的资料是 pending，由第 6 步的解析任务更新。 */
  status: FeasibilitySourceStatus;
  /** 解析出的 Markdown（生成产物），经 .../sources/:fileId/markdown 或 /api/artifacts/:artifactId/content 读取。 */
  markdownArtifactId: string | null;
  contentChars: number;
  contentHash: string | null;
  parserLabel: string | null;
  error: string | null;
}

/** 与桌面版 Renderer 的 OutlineItem 中可研报告用到的字段相同；空的 children、knowledge_item_ids、content 省略。 */
export interface FeasibilityOutlineItem {
  id: string;
  title: string;
  description: string;
  knowledge_item_ids?: string[];
  content?: string;
  children?: FeasibilityOutlineItem[];
}

export interface FeasibilityOutlineData {
  outline: FeasibilityOutlineItem[];
  project_name?: string;
  project_overview?: string;
}

export interface FeasibilityReportState {
  step: FeasibilityReportStep;
  projectInfo: FeasibilityProjectInfo;
  sourceFiles: FeasibilitySource[];
  analysisMarkdown: string;
  outlineTemplate: FeasibilityOutlineTemplate;
  targetWords: number;
  /** 目录生成引用的知识库文档 id（只含当前可见的文档）。 */
  referenceDocumentIds: string[];
  keyParametersMarkdown: string;
  outlineData: FeasibilityOutlineData | null;
  /** 本项目最近一次的各类任务（与 GET /api/jobs/:jobId 相同的形式）；没有时为 null。 */
  analysisTask: JobBody | null;
  outlineTask: JobBody | null;
  /** 最近一次目录调整（8.7b）。 */
  outlineAdjustmentTask: JobBody | null;
  /**
   * 最近一次目录调整的要求与 Agent 的说明（桌面版 outlineAdjustmentTask.stats.adjustment）；没有调整任务时为 null。summary 是 AI 生成
   * 的内容（按纯文本显示），调整还没有成功完成时为 null（前端显示失败原因或进度）。
   */
  outlineAdjustment: { requirement: string; summary: string | null } | null;
  /** 能否发起目录调整：有目录，且目录生成（或上一次调整）的 Agent 会话可以续用（桌面版 hasPersistentTaskSession）。 */
  outlineAdjustable: boolean;
  parametersTask: JobBody | null;
  contentTask: JobBody | null;
  humanWritingTask: JobBody | null;
}

// ---- 错误 ----

function invalid(message: string): AppError {
  return new AppError(400, 'FEASIBILITY_REPORT_INVALID', message);
}

function fileUnavailable(cause?: unknown): AppError {
  return new AppError(
    400,
    'FEASIBILITY_REPORT_FILE_UNAVAILABLE',
    '文件不存在、未上传完成、已删除、不是可研资料文件或已用于其他项目',
    cause === undefined ? undefined : { cause },
  );
}

function referenceUnavailable(cause?: unknown): AppError {
  return new AppError(400, 'FEASIBILITY_REPORT_REFERENCE_UNAVAILABLE', '知识库文档不存在或已删除', cause === undefined ? undefined : { cause });
}

function sourceNotFound(): AppError {
  return new AppError(404, 'FEASIBILITY_REPORT_SOURCE_NOT_FOUND', '资料不存在或已移除');
}

function chapterNotFound(): AppError {
  return new AppError(404, 'FEASIBILITY_REPORT_CHAPTER_NOT_FOUND', '未找到要保存的章节');
}

function markdownTooLarge(): AppError {
  return new AppError(422, 'FEASIBILITY_REPORT_CONTENT_TOO_LARGE', '资料正文合计超过 32 MiB，无法分析');
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

/** 用户输入的文本：去掉 \u0000，超长时返回 400（接口的 JSON Schema 已先按字数检查，这里检查去掉首尾空白后的结果）。 */
function userText(value: string, max: number, what: string): string {
  const text = stripNul(value);
  if (charLength(text) > max) throw invalid(`${what}超过 ${max} 字`);
  return text;
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
  if (charLength(text) > FEASIBILITY_KEY_MAX || text.includes('\u0000')) {
    throw new TypeError(`${what}不合法：${JSON.stringify(text.slice(0, FEASIBILITY_KEY_MAX))}`);
  }
  return text;
}

function count(value: unknown): number {
  const number = Math.round(Number(value ?? 0));
  return Number.isFinite(number) && number > 0 ? Math.min(number, 2_147_483_647) : 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** 与桌面版 normalizeTargetWords 相同：不足 1000 取默认 30000；另限制上限。 */
function normalizeTargetWords(value: unknown): number {
  const words = Math.round(Number(value) || 0);
  if (words < FEASIBILITY_TARGET_WORDS_MIN) return DEFAULT_TARGET_WORDS;
  return Math.min(words, FEASIBILITY_TARGET_WORDS_MAX);
}

/** 行数可能上千：分批插入，避免单条语句的参数超过 PostgreSQL 的上限（65535）。 */
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
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`feasibility_report:${projectId}`}, 0))`.execute(trx);
}

/**
 * 正文生成或审校任务未结束（排队、运行、暂停、取消中）时不能保存目录、手工改正文（与桌面版 assertContentUnlocked 相同；
 * 桌面版检查运行、暂停中，这里另含排队与取消中：任务即将开始写入正文，或可能还有一次写入）。
 */
async function assertContentUnlocked(trx: Trx, projectId: string): Promise<void> {
  const job = await trx
    .selectFrom('jobs')
    .select('id')
    .where('project_id', '=', projectId)
    .where('type', 'in', CONTENT_LOCK_JOB_TYPES)
    .where('status', 'in', JOB_ACTIVE_STATUSES)
    .limit(1)
    .executeTakeFirst();
  if (job) throw new AppError(409, 'FEASIBILITY_REPORT_CONTENT_LOCKED', '正文生成或审校任务正在运行或已暂停，当前不能修改目录或手工改正文');
}

// ---- 读取 ----

async function readSources(trx: Trx, projectId: string): Promise<FeasibilitySource[]> {
  const rows = await trx
    .selectFrom('feasibility_report_sources as s')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select([
      's.file_id',
      's.status',
      's.markdown_artifact_id',
      's.content_chars',
      's.content_hash',
      's.parser_label',
      's.error',
      's.created_at as imported_at',
      'f.display_name',
      'f.extension',
      'f.size_bytes',
      'f.uploaded_at',
      'f.created_at',
    ])
    .where('s.project_id', '=', projectId)
    .orderBy('s.sort_order')
    .orderBy('s.created_at')
    .orderBy('s.file_id')
    .execute();
  return rows.map((row) => ({
    id: row.file_id,
    fileName: row.display_name,
    extension: row.extension,
    size: Number(row.size_bytes ?? 0),
    uploadedAt: row.uploaded_at ?? row.created_at,
    importedAt: row.imported_at,
    status: oneOf(row.status, FEASIBILITY_SOURCE_STATUSES, 'pending'),
    markdownArtifactId: row.markdown_artifact_id,
    contentChars: row.content_chars,
    contentHash: row.content_hash,
    parserLabel: row.parser_label,
    error: row.error,
  }));
}

async function readReferenceDocumentIds(trx: Trx, projectId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('feasibility_report_reference_docs')
    .select('document_id')
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('document_id')
    .execute();
  return rows.map((row) => row.document_id);
}

/** 与桌面版 loadOutlineData 相同组装成树；父节点不存在的节点作为根节点。 */
async function readOutline(trx: Trx, projectId: string, meta: { outline_project_name: string | null; outline_project_overview: string | null } | undefined): Promise<FeasibilityOutlineData | null> {
  const rows = await trx
    .selectFrom('feasibility_report_outline_nodes')
    .select(['node_id', 'parent_node_id', 'title', 'description', 'knowledge_item_ids', 'content'])
    .where('project_id', '=', projectId)
    .orderBy('level')
    .orderBy('sort_order')
    .orderBy('node_id')
    .execute();
  if (rows.length === 0) return null;
  const items = new Map<string, FeasibilityOutlineItem>();
  for (const row of rows) {
    const item: FeasibilityOutlineItem = { id: row.node_id, title: row.title, description: row.description };
    if (row.knowledge_item_ids?.length) item.knowledge_item_ids = row.knowledge_item_ids;
    if (row.content) item.content = row.content;
    items.set(row.node_id, item);
  }
  const roots: FeasibilityOutlineItem[] = [];
  for (const row of rows) {
    const item = items.get(row.node_id)!;
    const parent = row.parent_node_id ? items.get(row.parent_node_id) : undefined;
    if (parent) (parent.children ??= []).push(item);
    else roots.push(item);
  }
  return {
    outline: roots,
    ...(meta?.outline_project_name ? { project_name: meta.outline_project_name } : {}),
    ...(meta?.outline_project_overview ? { project_overview: meta.outline_project_overview } : {}),
  };
}

/**
 * 在已设置上下文的事务中读取完整状态（与桌面版 loadFeasibilityReport 相同）。任务状态为本项目最近一次的各类任务；可研报告的结果
 * 没有“进行中”的状态（任务成功时才整体写入），所以不需要像其他模块那样把任务已结束的结果按未完成显示。
 */
export async function readState(trx: Trx, projectId: string): Promise<FeasibilityReportState> {
  const meta = await trx.selectFrom('feasibility_report_meta').selectAll().where('project_id', '=', projectId).executeTakeFirst();
  const jobs = await latestProjectJobs(trx, projectId, FEASIBILITY_JOB_TYPES);
  const task = (type: string) => {
    const job = jobs.get(type);
    return job ? jobBody(job) : null;
  };
  const outlineData = await readOutline(trx, projectId, meta);
  return {
    step: meta?.step ?? 'materials',
    projectInfo: {
      projectName: meta?.project_name ?? '',
      projectType: meta?.project_type ?? 'government',
      industry: meta?.industry ?? '',
      constructionUnit: meta?.construction_unit ?? '',
      location: meta?.location ?? '',
      constructionContent: meta?.construction_content ?? '',
      constructionPeriodYears: meta?.construction_period_years ?? '2',
      operationPeriodYears: meta?.operation_period_years ?? '20',
      totalInvestment: meta?.total_investment ?? '',
      fundingSource: meta?.funding_source ?? '',
    },
    sourceFiles: await readSources(trx, projectId),
    analysisMarkdown: meta?.analysis_markdown ?? '',
    outlineTemplate: meta?.outline_template ?? 'government',
    targetWords: meta?.target_words ?? DEFAULT_TARGET_WORDS,
    referenceDocumentIds: await readReferenceDocumentIds(trx, projectId),
    keyParametersMarkdown: meta?.key_parameters_markdown ?? '',
    outlineData,
    analysisTask: task(FEASIBILITY_ANALYSIS_JOB_TYPE),
    outlineTask: task(FEASIBILITY_OUTLINE_JOB_TYPE),
    outlineAdjustmentTask: task(FEASIBILITY_OUTLINE_ADJUSTMENT_JOB_TYPE),
    outlineAdjustment: adjustmentOf(jobs.get(FEASIBILITY_OUTLINE_ADJUSTMENT_JOB_TYPE)),
    outlineAdjustable: outlineData !== null && outlineData.outline.length > 0 && (await findContinuableAgentSessionIn(trx, feasibilityOutlineSessionTarget(projectId))) !== null,
    parametersTask: task(FEASIBILITY_PARAMETERS_JOB_TYPE),
    contentTask: task(FEASIBILITY_CONTENT_JOB_TYPE),
    humanWritingTask: task(FEASIBILITY_HUMAN_WRITING_JOB_TYPE),
  };
}

/** 调整任务的要求（任务参数）与成功后写下的说明（任务最后的 checkpoint 中，src/feasibilityReport/jobs.ts）。 */
function adjustmentOf(job: { status: string; params: Record<string, unknown>; checkpoint: Record<string, unknown> | null } | undefined) {
  if (!job) return null;
  const requirement = typeof job.params.requirement === 'string' ? job.params.requirement : '';
  const task = job.checkpoint?.task;
  const summary = job.status === 'succeeded' && typeof task === 'object' && task !== null && typeof (task as Record<string, unknown>).summary === 'string'
    ? ((task as Record<string, unknown>).summary as string).slice(0, FEASIBILITY_ADJUSTMENT_SUMMARY_MAX)
    : null;
  return { requirement, summary };
}

export async function loadFeasibilityReport(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<FeasibilityReportState> {
  return withTenant(db, context, (trx) => readState(trx, projectId));
}

// ---- 页面状态 ----

type MetaPatch = Partial<{
  step: FeasibilityReportStep;
  project_name: string;
  project_type: FeasibilityProjectType;
  industry: string;
  construction_unit: string;
  location: string;
  construction_content: string;
  construction_period_years: string;
  operation_period_years: string;
  total_investment: string;
  funding_source: string;
  analysis_markdown: string;
  outline_template: FeasibilityOutlineTemplate;
  target_words: number;
  key_parameters_markdown: string;
  outline_project_name: string | null;
  outline_project_overview: string | null;
}>;

async function writeMeta(trx: Trx, context: TenantContext, projectId: string, set: MetaPatch): Promise<void> {
  const query = trx.insertInto('feasibility_report_meta').values({ project_id: projectId, org_id: context.orgId, ...set });
  await (Object.keys(set).length
    ? query.onConflict((oc) => oc.column('project_id').doUpdateSet(set))
    : query.onConflict((oc) => oc.column('project_id').doNothing())
  ).execute();
}

async function deleteOutline(trx: Trx, projectId: string): Promise<void> {
  await trx.deleteFrom('feasibility_report_outline_nodes').where('project_id', '=', projectId).execute();
}

/** 与桌面版 clearDownstreamFromMaterials 相同：清空资料分析、目录和关键参数。 */
async function clearDownstreamFromMaterials(trx: Trx, context: TenantContext, projectId: string, set: MetaPatch = {}): Promise<void> {
  await deleteOutline(trx, projectId);
  await writeMeta(trx, context, projectId, {
    ...set,
    analysis_markdown: '',
    key_parameters_markdown: '',
    outline_project_name: null,
    outline_project_overview: null,
  });
}

/** 与桌面版 clearDownstreamFromAnalysis 相同：清空目录和关键参数。 */
async function clearDownstreamFromAnalysis(trx: Trx, context: TenantContext, projectId: string, set: MetaPatch = {}): Promise<void> {
  await deleteOutline(trx, projectId);
  await writeMeta(trx, context, projectId, { ...set, key_parameters_markdown: '', outline_project_name: null, outline_project_overview: null });
}

/** 切换页面步骤（与桌面版 updateStep 相同）。 */
export async function updateStep(db: Kysely<Database>, context: TenantContext, projectId: string, step: FeasibilityReportStep): Promise<{ step: FeasibilityReportStep }> {
  const next = oneOf(step, FEASIBILITY_REPORT_STEPS, 'materials');
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await writeMeta(trx, context, projectId, { step: next });
    return { step: next };
  });
}

export type ProjectInfoInput = Partial<Record<keyof FeasibilityProjectInfo, string>>;

/**
 * 保存项目信息（与桌面版经 taskService 的 saveProjectInfo 相同）：去掉首尾空白，建设期、运营期为空时取默认值，项目名称
 * 必填；同时清空资料分析、目录和关键参数。
 */
export async function saveProjectInfo(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: ProjectInfoInput,
): Promise<FeasibilityReportState> {
  const field = (key: keyof FeasibilityProjectInfo, what: string, max = FEASIBILITY_FIELD_MAX) => userText(String(input[key] ?? '').trim(), max, what);
  const set: MetaPatch = {
    project_name: field('projectName', '项目名称'),
    project_type: oneOf(input.projectType, FEASIBILITY_PROJECT_TYPES, 'government'),
    industry: field('industry', '所属行业'),
    construction_unit: field('constructionUnit', '建设单位'),
    location: field('location', '建设地点'),
    construction_content: field('constructionContent', '建设内容', FEASIBILITY_TEXT_MAX),
    construction_period_years: field('constructionPeriodYears', '建设期') || '2',
    operation_period_years: field('operationPeriodYears', '运营期') || '20',
    total_investment: field('totalInvestment', '总投资'),
    funding_source: field('fundingSource', '资金来源'),
  };
  if (!set.project_name) throw invalid('请填写项目名称');
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await clearDownstreamFromMaterials(trx, context, projectId, set);
    return readState(trx, projectId);
  });
}

/** 保存资料分析（与桌面版 saveAnalysis 相同）：去掉首尾空白，同时清空目录和关键参数。 */
export async function saveAnalysis(db: Kysely<Database>, context: TenantContext, projectId: string, markdown: string): Promise<FeasibilityReportState> {
  const analysis = userText(String(markdown ?? '').trim(), FEASIBILITY_MARKDOWN_MAX, '资料分析');
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await clearDownstreamFromAnalysis(trx, context, projectId, { analysis_markdown: analysis });
    return readState(trx, projectId);
  });
}

export interface OutlineConfigInput {
  outlineTemplate: FeasibilityOutlineTemplate;
  targetWords: number;
  referenceDocumentIds: string[];
}

/**
 * 保存目录配置（与桌面版 saveOutlineConfig 相同整份保存）：目录模板、目标字数（不足 1000 取默认 30000）和引用的知识库文档
 * （去重，按给出的顺序整体替换）。文档不存在、其他组织的或原件已删除时整体失败，返回 400。
 */
export async function saveOutlineConfig(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: OutlineConfigInput,
): Promise<FeasibilityReportState> {
  const documentIds = [...new Set(input.referenceDocumentIds.map((id) => id.toLowerCase()))];
  if (documentIds.length > FEASIBILITY_REFERENCE_DOCUMENTS_MAX) throw invalid(`最多引用 ${FEASIBILITY_REFERENCE_DOCUMENTS_MAX} 个知识库文档`);
  if (!documentIds.every((id) => UUID.test(id))) throw referenceUnavailable();
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await writeMeta(trx, context, projectId, {
      outline_template: oneOf(input.outlineTemplate, FEASIBILITY_OUTLINE_TEMPLATES, 'government'),
      target_words: normalizeTargetWords(input.targetWords),
    });
    await trx.deleteFrom('feasibility_report_reference_docs').where('project_id', '=', projectId).execute();
    if (documentIds.length > 0) {
      try {
        await trx
          .insertInto('feasibility_report_reference_docs')
          .values(documentIds.map((documentId, index) => ({ org_id: context.orgId, project_id: projectId, document_id: documentId, sort_order: index })))
          .execute();
      } catch (error) {
        // 42501：INSERT 策略拒绝（文档不可见）；23503：外键（不存在或其他组织的文档）。
        const code = errorCode(error);
        if (code === '42501' || code === '23503') throw referenceUnavailable(error);
        throw error;
      }
    }
    return readState(trx, projectId);
  });
}

// ---- 目录 ----

interface OutlineRow {
  node_id: string;
  parent_node_id: string | null;
  sort_order: number;
  level: number;
  title: string;
  description: string;
  knowledge_item_ids: string[] | null;
  content: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function optionalString(item: Record<string, unknown>, field: string, what: string): string | undefined {
  const value = item[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${what}必须是字符串`);
  return stripNul(value);
}

/**
 * 把请求中的目录展开成行（与桌面版 flattenOutlineItems 相同：先序，没有 id 的节点连同子节点跳过，标题为空时用
 * “未命名章节”）。结构不对、id 重复、超过层级 / 节点数 / 字数上限返回 400。content 为请求给出的正文（未给出时为 undefined，
 * 由调用方决定沿用已保存的正文还是清空）。递归深度受层级上限约束。
 */
function flattenOutline(outline: unknown): (Omit<OutlineRow, 'content'> & { content: string | undefined })[] {
  if (!Array.isArray(outline)) throw invalid('目录必须是数组');
  const rows: (Omit<OutlineRow, 'content'> & { content: string | undefined })[] = [];
  const ids = new Set<string>();
  const walk = (items: unknown[], parent: string | null, level: number) => {
    if (level > FEASIBILITY_OUTLINE_DEPTH_MAX) throw invalid(`目录最多 ${FEASIBILITY_OUTLINE_DEPTH_MAX} 级`);
    items.forEach((value, index) => {
      if (!isObject(value)) throw invalid('目录项必须是对象');
      const id = (optionalString(value, 'id', '目录项 id') ?? '').trim();
      if (!id) return;
      if (charLength(id) > FEASIBILITY_NODE_ID_MAX) throw invalid(`目录项 id 超过 ${FEASIBILITY_NODE_ID_MAX} 字`);
      if (ids.has(id)) throw invalid(`目录项 id 重复：${id}`);
      ids.add(id);
      if (rows.length >= FEASIBILITY_OUTLINE_NODES_MAX) throw invalid(`目录最多 ${FEASIBILITY_OUTLINE_NODES_MAX} 项`);
      const title = (optionalString(value, 'title', '目录标题') ?? '').trim() || UNTITLED_CHAPTER;
      if (charLength(title) > FEASIBILITY_TITLE_MAX) throw invalid(`目录标题超过 ${FEASIBILITY_TITLE_MAX} 字`);
      const description = (optionalString(value, 'description', '目录说明') ?? '').trim();
      if (charLength(description) > FEASIBILITY_TEXT_MAX) throw invalid(`目录说明超过 ${FEASIBILITY_TEXT_MAX} 字`);
      const content = optionalString(value, 'content', '章节正文');
      if (content !== undefined && charLength(content) > FEASIBILITY_CONTENT_MAX) throw invalid(`章节正文超过 ${FEASIBILITY_CONTENT_MAX} 字`);
      let knowledgeItemIds: string[] | null = null;
      const rawIds = value.knowledge_item_ids;
      if (rawIds !== undefined && rawIds !== null) {
        if (!Array.isArray(rawIds) || !rawIds.every((item) => typeof item === 'string')) throw invalid('引用的知识库条目必须是字符串数组');
        if (rawIds.length > FEASIBILITY_KNOWLEDGE_ITEMS_MAX) throw invalid(`每章最多引用 ${FEASIBILITY_KNOWLEDGE_ITEMS_MAX} 个知识库条目`);
        const cleaned = (rawIds as string[]).map(stripNul);
        if (Buffer.byteLength(JSON.stringify(cleaned)) > FEASIBILITY_KNOWLEDGE_IDS_MAX_BYTES) throw invalid('引用的知识库条目过多');
        knowledgeItemIds = cleaned.length ? cleaned : null;
      }
      rows.push({ node_id: id, parent_node_id: parent, sort_order: index, level, title, description, knowledge_item_ids: knowledgeItemIds, content });
      const children = value.children;
      if (children !== undefined && children !== null) {
        if (!Array.isArray(children)) throw invalid('子目录必须是数组');
        if (children.length) walk(children, id, level + 1);
      }
    });
  };
  walk(outline, null, 1);
  return rows;
}

function outlineHeader(outlineData: Record<string, unknown>): { name: string | null; overview: string | null } {
  const name = (optionalString(outlineData, 'project_name', '目录项目名称') ?? '').trim();
  const overview = (optionalString(outlineData, 'project_overview', '目录项目概述') ?? '').trim();
  if (charLength(name) > FEASIBILITY_TITLE_MAX) throw invalid(`目录项目名称超过 ${FEASIBILITY_TITLE_MAX} 字`);
  if (charLength(overview) > FEASIBILITY_TEXT_MAX) throw invalid(`目录项目概述超过 ${FEASIBILITY_TEXT_MAX} 字`);
  return { name: name || null, overview: overview || null };
}

export interface SaveOutlineInput {
  /** null 或空目录表示删除目录。 */
  outlineData: unknown;
  reason?: FeasibilityOutlineSaveReason;
  /** 重新编号前后的节点 id（旧 → 新），用来找到已保存的正文。 */
  idMap?: Record<string, string>;
  /** 需要清空正文的节点（新 id 或旧 id）。 */
  affectedNodeIds?: string[];
}

/**
 * 保存目录（与桌面版 saveOutline 相同的 reason 协议）：整体替换节点。reason 为 replace 时清空全部正文；其他 reason 中
 * affectedNodeIds 里的节点清空正文，其余节点的正文取请求给出的，未给出时按 idMap 沿用已保存的。reason 不是 sort 时
 * 同时清空关键参数。目录生成任务（8.7a）经 saveOutlineResult 写入（规则同 replace）。正文生成或审校任务未结束时返回 409
 * FEASIBILITY_REPORT_CONTENT_LOCKED。
 */
export async function saveOutline(db: Kysely<Database>, context: TenantContext, projectId: string, input: SaveOutlineInput): Promise<FeasibilityReportState> {
  const reason = oneOf(input.reason, FEASIBILITY_OUTLINE_SAVE_REASONS, 'replace');
  const outlineData = input.outlineData;
  if (outlineData !== null && outlineData !== undefined && !isObject(outlineData)) throw invalid('目录数据必须是对象');
  const rows = outlineData ? flattenOutline(outlineData.outline ?? []) : [];
  const header = outlineData && rows.length ? outlineHeader(outlineData) : { name: null, overview: null };
  const oldIdOf = new Map<string, string>();
  for (const [from, to] of Object.entries(input.idMap ?? {})) {
    const fromId = String(from).trim();
    const toId = String(to ?? '').trim();
    if (fromId && toId) oldIdOf.set(toId, fromId);
  }
  const affected = new Set((input.affectedNodeIds ?? []).map((id) => String(id).trim()).filter(Boolean));
  const clearAll = reason === 'replace';
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await assertContentUnlocked(trx, projectId);
    const previous = new Map(
      (await trx.selectFrom('feasibility_report_outline_nodes').select(['node_id', 'content']).where('project_id', '=', projectId).execute()).map(
        (row) => [row.node_id, row.content],
      ),
    );
    const values = rows.map((row) => {
      const oldId = oldIdOf.get(row.node_id) ?? row.node_id;
      const cleared = reason !== 'sort' && (clearAll || affected.has(row.node_id) || affected.has(oldId));
      // 与桌面版相同：旧节点存在时取它的正文（可能为空），不存在才按新 id 找。
      const saved = previous.has(oldId) ? previous.get(oldId) : previous.get(row.node_id);
      const content = cleared ? '' : row.content || saved || '';
      return {
        org_id: context.orgId,
        project_id: projectId,
        ...row,
        knowledge_item_ids: row.knowledge_item_ids ? JSON.stringify(row.knowledge_item_ids) : null,
        content,
      };
    });
    await deleteOutline(trx, projectId);
    await insertChunked(values, (chunk) => trx.insertInto('feasibility_report_outline_nodes').values(chunk).execute());
    await writeMeta(trx, context, projectId, {
      outline_project_name: header.name,
      outline_project_overview: header.overview,
      ...(reason === 'sort' ? {} : { key_parameters_markdown: '' }),
    });
    return readState(trx, projectId);
  });
}

async function clearAllContent(trx: Trx, projectId: string): Promise<void> {
  await trx.updateTable('feasibility_report_outline_nodes').set({ content: '' }).where('project_id', '=', projectId).where('content', '<>', '').execute();
}

/** 保存关键参数（与桌面版 saveKeyParameters 相同）：去掉首尾空白，同时清空全部正文。 */
export async function saveKeyParameters(db: Kysely<Database>, context: TenantContext, projectId: string, markdown: string): Promise<FeasibilityReportState> {
  const keyParameters = userText(String(markdown ?? '').trim(), FEASIBILITY_MARKDOWN_MAX, '关键参数');
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await writeMeta(trx, context, projectId, { key_parameters_markdown: keyParameters });
    await clearAllContent(trx, projectId);
    return readState(trx, projectId);
  });
}

/** 手工保存一章正文（与桌面版 saveChapterContent 相同）。章节不存在时 404；正文生成或审校任务未结束时 409。 */
export async function saveChapterContent(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  nodeId: string,
  content: string,
): Promise<FeasibilityReportState> {
  const id = nodeId.trim();
  const text = userText(String(content ?? ''), FEASIBILITY_CONTENT_MAX, '章节正文');
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await assertContentUnlocked(trx, projectId);
    const result = await trx
      .updateTable('feasibility_report_outline_nodes')
      .set({ content: text })
      .where('project_id', '=', projectId)
      .where('node_id', '=', id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw chapterNotFound();
    return readState(trx, projectId);
  });
}

// ---- 可研资料 ----

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

export interface ImportSourcesResult {
  addedCount: number;
  /** 新导入的文件（待解析，由接口入队解析任务）。 */
  addedFileIds: string[];
  /** 被替换掉的旧资料数（原件进回收站）。 */
  removedCount: number;
  state: FeasibilityReportState;
}

/**
 * 导入可研资料（取代桌面版 importSourceDocuments）：与桌面版相同整体替换。给出的文件按顺序成为全部资料：新文件挂到本项目
 * （files.project_id）并登记，资料停在待解析（由接口入队解析任务，6.6）；已登记的保留并按新顺序排列；不在其中的旧资料原件软删除
 * （进回收站）。同时清空资料分析、目录和关键参数。文件不可用（不存在、其他组织的、未上传完成、已删除、用途不是 tender、
 * 属于其他项目）时整体失败，返回 400。
 */
export async function importSources(db: Kysely<Database>, context: TenantContext, projectId: string, fileIds: string[]): Promise<ImportSourcesResult> {
  const ids = fileIds.map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw fileUnavailable();
  if (ids.length > FEASIBILITY_SOURCES_MAX) throw invalid(`每个项目最多导入 ${FEASIBILITY_SOURCES_MAX} 份资料`);
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const existing = new Set(
      (await trx.selectFrom('feasibility_report_sources').select('file_id').where('project_id', '=', projectId).execute()).map((row) => row.file_id),
    );
    const added = ids.filter((id) => !existing.has(id));
    const removed = [...existing].filter((id) => !ids.includes(id));
    if (added.length > 0) {
      // 挂到本项目。已属于其他项目的文件由触发器 files_project_guard 拒绝（FS005，迁移 0015）；能否登记由
      // feasibility_report_sources 的 INSERT 策略检查，这里的条件只为给出明确的错误。
      let claimed;
      try {
        claimed = await trx
          .updateTable('files')
          .set({ project_id: projectId })
          .where('id', 'in', added)
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
      if (Number(claimed.numUpdatedRows) !== added.length) throw fileUnavailable();
      try {
        await trx
          .insertInto('feasibility_report_sources')
          .values(added.map((fileId) => ({ file_id: fileId, org_id: context.orgId, project_id: projectId, sort_order: ids.indexOf(fileId) })))
          .execute();
      } catch (error) {
        // 42501：INSERT 策略拒绝（文件不可用）；23505：文件已登记（原件在回收站时资料行不可见）；23503：外键（其他组织的文件）。
        const code = errorCode(error);
        if (code === '42501' || code === '23505' || code === '23503') throw fileUnavailable(error);
        throw error;
      }
    }
    for (const fileId of ids.filter((id) => existing.has(id))) {
      await trx.updateTable('feasibility_report_sources').set({ sort_order: ids.indexOf(fileId) }).where('project_id', '=', projectId).where('file_id', '=', fileId).execute();
    }
    const removedCount = await trashFiles(trx, context, removed);
    await clearDownstreamFromMaterials(trx, context, projectId);
    return { addedCount: added.length, addedFileIds: added, removedCount, state: await readState(trx, projectId) };
  });
}

/** 移除一份资料（取代桌面版 removeSourceDocument）：原件软删除（进回收站），资料行随之不可见；同时清空资料分析、目录和关键参数。 */
export async function removeSource(db: Kysely<Database>, context: TenantContext, projectId: string, fileId: string): Promise<FeasibilityReportState> {
  const id = fileId.toLowerCase();
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const source = await trx.selectFrom('feasibility_report_sources').select('file_id').where('project_id', '=', projectId).where('file_id', '=', id).executeTakeFirst();
    if (!source) throw sourceNotFound();
    await trashFiles(trx, context, [id]);
    await clearDownstreamFromMaterials(trx, context, projectId);
    return readState(trx, projectId);
  });
}

export interface SourceMarkdown {
  /** 解析出的 Markdown 产物的对象键和大小；还没有解析时为 null。 */
  artifact: { id: string; storageKey: string; size: number } | null;
}

/** 资料解析出的 Markdown 产物（桌面版 readSourceMarkdown 读取的文件）。资料不可见时 404。 */
export async function findSourceMarkdown(db: Kysely<Database>, context: TenantContext, projectId: string, fileId: string): Promise<SourceMarkdown> {
  const id = fileId.toLowerCase();
  return withTenant(db, context, async (trx) => {
    const source = await trx
      .selectFrom('feasibility_report_sources')
      .select('markdown_artifact_id')
      .where('project_id', '=', projectId)
      .where('file_id', '=', id)
      .executeTakeFirst();
    if (!source) throw sourceNotFound();
    if (!source.markdown_artifact_id) return { artifact: null };
    // artifacts 的策略同样生效：产物不可见（例如写入中）时视为还没有 Markdown。
    const row = await trx
      .selectFrom('artifacts')
      .select(['id', 'storage_key', 'size_bytes'])
      .where('id', '=', source.markdown_artifact_id)
      .where('status', '=', 'ready')
      .executeTakeFirst();
    return { artifact: row ? { id: row.id, storageKey: row.storage_key, size: Number(row.size_bytes ?? 0) } : null };
  });
}

/**
 * 清空可研报告（与桌面版 clearFeasibilityReport 相同）：删除目录与引用的知识库文档，资料的原件软删除（进回收站），页面状态
 * 和项目信息恢复默认值。返回软删除的文件数。
 */
export async function clearFeasibilityReport(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<{ deletedFileCount: number }> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const sources = await trx.selectFrom('feasibility_report_sources').select('file_id').where('project_id', '=', projectId).execute();
    await deleteOutline(trx, projectId);
    await trx.deleteFrom('feasibility_report_reference_docs').where('project_id', '=', projectId).execute();
    const deletedFileCount = await trashFiles(
      trx,
      context,
      sources.map((row) => row.file_id),
    );
    await trx
      .updateTable('feasibility_report_meta')
      .set({
        step: 'materials',
        project_name: '',
        project_type: 'government',
        industry: '',
        construction_unit: '',
        location: '',
        construction_content: '',
        construction_period_years: '2',
        operation_period_years: '20',
        total_investment: '',
        funding_source: '',
        analysis_markdown: '',
        outline_template: 'government',
        target_words: DEFAULT_TARGET_WORDS,
        key_parameters_markdown: '',
        outline_project_name: null,
        outline_project_overview: null,
      })
      .where('project_id', '=', projectId)
      .execute();
    return { deletedFileCount };
  });
}

// ---- 任务写入 ----

export interface SourceParseInput {
  status?: FeasibilitySourceStatus;
  markdownArtifactId?: string | null;
  contentChars?: number;
  /** 解析出的正文的哈希。 */
  contentHash?: string | null;
  parserLabel?: string | null;
  error?: string | null;
}

/**
 * 写入一份资料的解析结果（给第 6 步的解析任务用，取代桌面版导入时同步解析写入的 markdownPath、contentHash 等）：
 * 只写给出的字段。markdownArtifactId 只能是本资料原件的 Markdown 产物，否则被 RLS 拒绝。资料已移除（原件进回收站）
 * 时返回 false。参数不合法（文件 id、产物 id 不是 uuid，哈希超长）是调用方的程序错误，抛 TypeError。
 */
export async function saveSourceParse(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  fileId: string,
  input: SourceParseInput,
): Promise<boolean> {
  const id = uuid(fileId, '文件 id');
  const set = {
    ...(hasOwn(input, 'status') ? { status: oneOf(input.status, FEASIBILITY_SOURCE_STATUSES, 'pending') } : {}),
    ...(hasOwn(input, 'markdownArtifactId') ? { markdown_artifact_id: optionalUuid(input.markdownArtifactId, 'Markdown 产物 id') } : {}),
    ...(hasOwn(input, 'contentChars') ? { content_chars: count(input.contentChars) } : {}),
    ...(hasOwn(input, 'contentHash') ? { content_hash: optionalKey(input.contentHash, '正文哈希') } : {}),
    ...(hasOwn(input, 'parserLabel') ? { parser_label: optionalText(input.parserLabel, FEASIBILITY_PARSER_LABEL_MAX) } : {}),
    ...(hasOwn(input, 'error') ? { error: optionalText(input.error, FEASIBILITY_TEXT_MAX) } : {}),
  };
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (Object.keys(set).length === 0) {
      return Boolean(await trx.selectFrom('feasibility_report_sources').select('file_id').where('project_id', '=', projectId).where('file_id', '=', id).executeTakeFirst());
    }
    const result = await trx.updateTable('feasibility_report_sources').set(set).where('project_id', '=', projectId).where('file_id', '=', id).executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  });
}

// ---- 任务的输入签名与写入（6.12） ----

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 在已设置上下文的事务中算出输入签名：项目信息、资料（顺序、解析状态、产物与正文哈希）、资料分析、目录结构（不含正文）与目录的
 * 项目名称和概述、关键参数。与桌面版保存这些内容时取消全部可研任务相同，任何一项变化都使进行中的任务的写入失效；不含页面步骤
 * 与目录配置（桌面版保存它们时不取消任务，任务在开始时读取），也不含正文（正文是正文任务自己的写入）。
 */
async function readInputSignature(trx: Trx, projectId: string): Promise<string> {
  const meta = await trx.selectFrom('feasibility_report_meta').selectAll().where('project_id', '=', projectId).executeTakeFirst();
  const sources = await trx
    .selectFrom('feasibility_report_sources')
    .select(['file_id', 'status', 'markdown_artifact_id', 'content_hash'])
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('created_at')
    .orderBy('file_id')
    .execute();
  const nodes = await trx
    .selectFrom('feasibility_report_outline_nodes')
    .select(['node_id', 'parent_node_id', 'sort_order', 'level', 'title', 'description', 'knowledge_item_ids'])
    .where('project_id', '=', projectId)
    .orderBy('level')
    .orderBy('sort_order')
    .orderBy('node_id')
    .execute();
  return sha256Hex(
    JSON.stringify([
      meta
        ? [
            meta.project_name,
            meta.project_type,
            meta.industry,
            meta.construction_unit,
            meta.location,
            meta.construction_content,
            meta.construction_period_years,
            meta.operation_period_years,
            meta.total_investment,
            meta.funding_source,
            meta.analysis_markdown,
            meta.key_parameters_markdown,
            meta.outline_project_name,
            meta.outline_project_overview,
          ]
        : null,
      sources.map((row) => [row.file_id, row.status, row.markdown_artifact_id, row.content_hash]),
      nodes.map((row) => [row.node_id, row.parent_node_id, row.sort_order, row.level, row.title, row.description, row.knowledge_item_ids]),
    ]),
  );
}

/** 当前的输入签名（任务开始时读取，写入时传回）。 */
export async function inputSignature(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<string> {
  return withTenant(db, context, (trx) => readInputSignature(trx, projectId));
}

/** 加项目锁并核对签名，相符时执行写入；不符时不写入，返回 false。 */
async function guardedWrite(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  expectedSignature: string,
  write: (trx: Trx) => Promise<boolean | void>,
): Promise<boolean> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if ((await readInputSignature(trx, projectId)) !== expectedSignature) return false;
    return (await write(trx)) !== false;
  });
}

/** 资料分析任务的结果：与 saveAnalysis 相同去掉首尾空白并清空目录和关键参数；超长时截短。签名不符时返回 false。 */
export async function saveAnalysisResult(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  markdown: string,
  expectedSignature: string,
): Promise<boolean> {
  const analysis = taskText(String(markdown ?? '').trim(), FEASIBILITY_MARKDOWN_MAX);
  return guardedWrite(db, context, projectId, expectedSignature, (trx) => clearDownstreamFromAnalysis(trx, context, projectId, { analysis_markdown: analysis }));
}

/** 关键参数任务的结果：与 saveKeyParameters 相同去掉首尾空白并清空全部正文；超长时截短。签名不符时返回 false。 */
export async function saveKeyParametersResult(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  markdown: string,
  expectedSignature: string,
): Promise<boolean> {
  const keyParameters = taskText(String(markdown ?? '').trim(), FEASIBILITY_MARKDOWN_MAX);
  return guardedWrite(db, context, projectId, expectedSignature, async (trx) => {
    await writeMeta(trx, context, projectId, { key_parameters_markdown: keyParameters });
    await clearAllContent(trx, projectId);
  });
}

/** 目录生成任务（8.7a）写入的目录：节点由任务按位置编号（1、1.1、1.1.1），各字段已转成字符串。 */
export interface OutlineResultInput {
  outline: readonly FeasibilityOutlineItem[];
  projectName: string;
  projectOverview: string;
}

/**
 * 目录生成任务的结果：与 saveOutline 的 replace 相同整体替换目录（新目录没有正文）并清空关键参数，目录的项目名称与概述一并写入。
 * 内容来自 Agent，超长的标题、说明截短，每章引用的知识库条目超过上限的截短；层级超过上限、节点数超过上限或 id 重复时抛 TypeError
 * （任务先检查）。任务自己持有可研任务的互斥键，正文任务不会同时运行，不检查正文锁。签名不符时不写入，返回 false。
 */
export async function saveOutlineResult(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: OutlineResultInput,
  expectedSignature: string,
): Promise<boolean> {
  const rows: OutlineRow[] = [];
  const ids = new Set<string>();
  const walk = (items: readonly FeasibilityOutlineItem[], parent: string | null, level: number) => {
    if (level > FEASIBILITY_OUTLINE_DEPTH_MAX) throw new TypeError('目录层级超过上限');
    items.forEach((item, index) => {
      const id = String(item.id);
      if (!id || charLength(id) > FEASIBILITY_NODE_ID_MAX || ids.has(id)) throw new TypeError('目录节点 id 不合法');
      ids.add(id);
      if (rows.length >= FEASIBILITY_OUTLINE_NODES_MAX) throw new TypeError('目录节点数超过上限');
      const knowledgeItemIds: string[] = [];
      for (const value of (item.knowledge_item_ids ?? []).slice(0, FEASIBILITY_KNOWLEDGE_ITEMS_MAX)) {
        const next = [...knowledgeItemIds, stripNul(String(value))];
        if (Buffer.byteLength(JSON.stringify(next)) > FEASIBILITY_KNOWLEDGE_IDS_MAX_BYTES) break;
        knowledgeItemIds.push(next[next.length - 1]!);
      }
      rows.push({
        node_id: id,
        parent_node_id: parent,
        sort_order: index,
        level,
        title: taskText(item.title, FEASIBILITY_TITLE_MAX).trim() || UNTITLED_CHAPTER,
        description: taskText(item.description, FEASIBILITY_TEXT_MAX).trim(),
        knowledge_item_ids: knowledgeItemIds.length ? knowledgeItemIds : null,
        content: '',
      });
      if (item.children?.length) walk(item.children, id, level + 1);
    });
  };
  walk(input.outline, null, 1);
  const name = taskText(input.projectName, FEASIBILITY_TITLE_MAX).trim();
  const overview = taskText(input.projectOverview, FEASIBILITY_TEXT_MAX).trim();
  return guardedWrite(db, context, projectId, expectedSignature, async (trx) => {
    await deleteOutline(trx, projectId);
    await insertChunked(
      rows.map((row) => ({
        org_id: context.orgId,
        project_id: projectId,
        ...row,
        knowledge_item_ids: row.knowledge_item_ids ? JSON.stringify(row.knowledge_item_ids) : null,
      })),
      (chunk) => trx.insertInto('feasibility_report_outline_nodes').values(chunk).execute(),
    );
    await writeMeta(trx, context, projectId, {
      outline_project_name: name || null,
      outline_project_overview: overview || null,
      key_parameters_markdown: '',
    });
  });
}

/** 正文生成任务开始时清空全部正文（与桌面版 startFeasibilityContent 的 clearContent 相同）。签名不符时返回 false。 */
export async function clearChapterContents(db: Kysely<Database>, context: TenantContext, projectId: string, expectedSignature: string): Promise<boolean> {
  return guardedWrite(db, context, projectId, expectedSignature, (trx) => clearAllContent(trx, projectId));
}

/**
 * 正文任务写入一章正文（生成或审校的结果，超长时截短）。任务自己持有正文锁，不检查锁；签名不符或章节不存在时不写入，返回 false。
 */
export async function saveChapterResult(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  nodeId: string,
  content: string,
  expectedSignature: string,
): Promise<boolean> {
  const text = taskText(content, FEASIBILITY_CONTENT_MAX);
  return guardedWrite(db, context, projectId, expectedSignature, async (trx) => {
    const result = await trx
      .updateTable('feasibility_report_outline_nodes')
      .set({ content: text })
      .where('project_id', '=', projectId)
      .where('node_id', '=', nodeId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  });
}

/**
 * 合并的资料正文（取代桌面版 readCombinedSourceMarkdown，不开放为接口）：各资料已解析出的 Markdown 按导入顺序、去掉首尾空白后
 * 以“## 文件名”开头，以空行连接；没有内容的资料跳过。总大小超过 32 MiB 时返回 422，不整体读入；对象存储未配置时 503。
 */
export async function readCombinedSourceMarkdown(db: Kysely<Database>, context: TenantContext, projectId: string, objectStore: ObjectStore | null): Promise<string> {
  const rows = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('feasibility_report_sources as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .innerJoin('artifacts as a', 'a.id', 's.markdown_artifact_id')
      .select(['f.display_name', 'a.storage_key', 'a.size_bytes'])
      .where('s.project_id', '=', projectId)
      .where('a.status', '=', 'ready')
      .orderBy('s.sort_order')
      .orderBy('s.created_at')
      .orderBy('s.file_id')
      .execute(),
  );
  if (rows.length === 0) return '';
  if (!objectStore) throw storageDisabled();
  let total = rows.reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0);
  if (total > FEASIBILITY_MARKDOWN_READ_MAX_BYTES) throw markdownTooLarge();
  total = 0;
  const parts: string[] = [];
  for (const row of rows) {
    const object = await objectStore.get(row.storage_key);
    if (!object) continue;
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) {
      const buffer = Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > FEASIBILITY_MARKDOWN_READ_MAX_BYTES) {
        object.body.destroy();
        throw markdownTooLarge();
      }
      chunks.push(buffer);
    }
    const markdown = Buffer.concat(chunks).toString('utf8').trim();
    if (markdown) parts.push(`## ${row.display_name}\n\n${markdown}`);
  }
  return parts.join('\n\n');
}

/** 目录配置引用的知识库文档中的最终条目（桌面版 knowledgeBaseService.readReferences 的结果中任务用到的字段）。 */
export interface ReferenceKnowledgeItem {
  documentId: string;
  itemId: string;
  title: string;
  resume: string;
  content: string;
}

/**
 * 引用的知识库文档中已处理成功的文档的最终条目：按引用顺序、文档内按条目顺序。原件已删除的文档由 RLS 隐藏（引用行与文档都不可见）。
 */
export async function readReferenceKnowledgeItems(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<ReferenceKnowledgeItem[]> {
  const rows = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('feasibility_report_reference_docs as r')
      .innerJoin('knowledge_documents as d', 'd.id', 'r.document_id')
      .innerJoin('knowledge_items as i', 'i.document_id', 'd.id')
      .select(['r.document_id', 'i.item_id', 'i.title', 'i.resume', 'i.content'])
      .where('r.project_id', '=', projectId)
      .where('d.status', '=', 'success')
      .orderBy('r.sort_order')
      .orderBy('r.document_id')
      .orderBy('i.sort_order')
      .orderBy('i.item_id')
      .execute(),
  );
  return rows.map((row) => ({ documentId: row.document_id, itemId: row.item_id, title: row.title, resume: row.resume, content: row.content }));
}
