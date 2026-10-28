// 废标检查的读写（迁移 0016_rejection_check）：页面状态、导入的文档、无效投标与废标项解析结果、三类检查的状态与问题。
// 组织和用户一律来自 TenantContext，所有查询都经 withTenant；项目由路由先经 requireProject 校验（kind = rejection-check）。
//
// 可见性、写权限和删除可见性由 RLS 保证，这里不判断：所属项目已删除时七张表的行都查不到、改不了；文档随原件的生命周期，
// 原件已删除（进入回收站）时文档行和引用它的问题都不可见。导入文档就是把已上传的 tender 文件挂到本项目
// （files.project_id，设置后不能再改，由迁移 0015 的触发器保证）并登记到 rejection_check_documents，文档停在待解析；
// 移除文档和清空时软删除原件（进回收站，按文件自己的恢复期处理），应用角色没有文档的 DELETE 授权。
//
// 与桌面版 rejectionCheckStore.cjs 相同：导入或移除招标文件时清空解析结果和三类检查结果，导入或移除投标文件时清空三类
// 检查结果；检查问题由任务按类整体替换写入，状态按字段合并，用户只能删除单条问题、切换当前问题。给第 6 步任务用的写函数
// （saveDocumentParse、saveExtraction、saveCheckResult，取代桌面版 updateState 中的任务部分）在本步一并实现，参数不合法
// （问题 id 为空、超长或重复，投标文件 id 不是 uuid）是调用方的程序错误，抛 TypeError；文本超长时截短，不让任务失败。
//
// 签名按当前可见的文档现算（取代桌面版 Renderer 按正文前后 800 字算出的签名）：招标文件、投标文件各自按顺序由文件 id 和
// 解析出的正文哈希算出，废标项检查的输入另含当前有效的解析结果和自定义检查项。结果中的签名与当前签名不同即已失效。
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  REJECTION_CHECK_DOCUMENT_STATUSES,
  REJECTION_CHECK_EXTRACTION_MAX,
  REJECTION_CHECK_EXTRACTION_SOURCES,
  REJECTION_CHECK_KEY_MAX,
  REJECTION_CHECK_PARSER_LABEL_MAX,
  REJECTION_CHECK_RESULT_TABS,
  REJECTION_CHECK_RESULT_TYPES,
  REJECTION_CHECK_RUN_STATUSES,
  REJECTION_CHECK_SEVERITIES,
  REJECTION_CHECK_STEPS,
  REJECTION_CHECK_TEXT_MAX,
  REJECTION_CHECK_TITLE_MAX,
} from '../db/migrations/0016_rejection_check.ts';
import type {
  Database,
  RejectionCheckDocumentRole,
  RejectionCheckDocumentStatus,
  RejectionCheckExtractionSource,
  RejectionCheckFindingType,
  RejectionCheckResultTab,
  RejectionCheckResultType,
  RejectionCheckRunStatus,
  RejectionCheckSeverity,
  RejectionCheckStep,
} from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { isFinalStatus, latestProjectJobs, type JobRecord } from '../jobs/store.ts';
import { jobBody, type JobBody } from '../jobs/view.ts';

/** 每个项目最多的招标文件、投标文件数（与标书查重相同）。 */
export const REJECTION_CHECK_TENDER_DOCUMENTS_MAX = 20;
export const REJECTION_CHECK_BID_DOCUMENTS_MAX = 50;

/** 合并的招标正文的页签（与桌面版相同）。 */
export const TENDER_TAB = 'tender';

/** 废标项解析与检查两类任务（第 6 步 6.9，src/rejectionCheck/jobs.ts）。 */
export const REJECTION_ITEMS_EXTRACTION_JOB_TYPE = 'rejection-items-extraction';
export const REJECTION_CHECK_RUN_JOB_TYPE = 'rejection-check-run';

/** 两类任务互斥（与桌面版的 group-exclusive 相同）：同一项目同时只有一个废标检查任务。 */
export function rejectionCheckLockKey(projectId: string): string {
  return `project:${projectId}:rejection-check`;
}

/** 任务记录已结束、结果仍是 running 时显示的原因（与桌面版重启后的 recoverInterruptedRejectionCheckTasks 相同）。 */
const STALE_EXTRACTION_MESSAGE = '上次解析未完成，请重新解析';
const STALE_CHECK_MESSAGE = '上次检查未完成，请重新检查';

// ---- 读出的状态 ----

export interface RejectionCheckDocument {
  /** files.id。 */
  id: string;
  role: RejectionCheckDocumentRole;
  fileName: string;
  extension: string;
  size: number;
  uploadedAt: Date;
  importedAt: Date;
  /** 解析状态；新导入的文档是 pending，由第 6 步的解析任务更新。 */
  status: RejectionCheckDocumentStatus;
  /** 解析出的 Markdown（生成产物），经 /api/artifacts/:artifactId/content 读取。 */
  markdownArtifactId: string | null;
  contentChars: number;
  contentHash: string | null;
  parserLabel: string | null;
  error: string | null;
}

export interface CheckOptions {
  /** 废标项检查始终开启（与桌面版相同）。 */
  rejectionCheck: true;
  typoCheck: boolean;
  logicCheck: boolean;
}

export interface UiState {
  step: RejectionCheckStep;
  activeDocumentTab: string;
  activeResultTab: RejectionCheckResultTab;
  activeCheckResultTab: RejectionCheckResultType;
  customCheckItems: string;
  checkOptions: CheckOptions;
}

export interface ExtractionState {
  status: RejectionCheckRunStatus;
  content: string;
  source: RejectionCheckExtractionSource | null;
  /** 解析时招标文件的签名，与 signatures.tender 不同即已失效。 */
  tenderSignature: string | null;
  error: string | null;
  updatedAt: Date | null;
}

export interface RiskFinding {
  id: string;
  bidDocumentId: string;
  type: RejectionCheckFindingType;
  severity: RejectionCheckSeverity;
  title: string;
  summary: string;
  requirement: string;
  bidEvidence: string;
  riskReason: string;
  suggestion: string;
}

export interface TypoFinding {
  id: string;
  bidDocumentId: string;
  wrongText: string;
  correctText: string;
  originalExcerpt: string;
  reason: string;
  locationHint: string | null;
}

export interface LogicFinding {
  id: string;
  bidDocumentId: string;
  title: string;
  originalText: string;
  locationHint: string;
  fallacyReason: string;
  suggestion: string;
}

export interface Findings {
  rejection: RiskFinding;
  typo: TypoFinding;
  logic: LogicFinding;
}

export interface CheckResult<F> {
  status: RejectionCheckRunStatus;
  findings: F[];
  /** 检查时输入的签名，与当前签名不同即已失效。 */
  inputSignature: string | null;
  activeFindingId: string | null;
  progressMessage: string | null;
  error: string | null;
  updatedAt: Date | null;
}

export interface Signatures {
  /** 招标文件的签名；没有招标文件时为空。 */
  tender: string;
  /** 投标文件的签名（错别字、逻辑问题检查的输入）；没有投标文件时为空。 */
  bid: string;
  /** 废标项检查的输入签名（投标文件、当前有效的解析结果、自定义检查项）；没有投标文件或解析结果时为空。 */
  rejectionInput: string;
}

export interface RejectionCheckState extends UiState {
  tenderDocuments: RejectionCheckDocument[];
  bidDocuments: RejectionCheckDocument[];
  signatures: Signatures;
  invalidBidAndRejectionItems: ExtractionState;
  rejectionCheckResult: CheckResult<RiskFinding>;
  typoCheckResult: CheckResult<TypoFinding>;
  logicCheckResult: CheckResult<LogicFinding>;
  /** 最近一次废标项解析任务、检查任务（jobs，与 GET /api/jobs/:jobId 相同的形式）；没有时为 null。 */
  extractionTask: JobBody | null;
  checkTask: JobBody | null;
}

// ---- 错误 ----

function fileUnavailable(cause?: unknown): AppError {
  return new AppError(
    400,
    'REJECTION_CHECK_FILE_UNAVAILABLE',
    '文件不存在、未上传完成、已删除、不是招标或投标文件或已用于其他项目',
    cause === undefined ? undefined : { cause },
  );
}

function documentNotFound(): AppError {
  return new AppError(404, 'REJECTION_CHECK_DOCUMENT_NOT_FOUND', '文档不存在或已移除');
}

function findingNotFound(): AppError {
  return new AppError(404, 'REJECTION_CHECK_FINDING_NOT_FOUND', '检查问题不存在或已删除');
}

// ---- 输入整理 ----

const hasOwn = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);

/** 任务写入的文本：去掉 PostgreSQL text 不接受的 \u0000，超长时截短。 */
function taskText(value: unknown, max: number): string {
  const text = String(value ?? '').replaceAll('\u0000', '');
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = taskText(value, max);
  return text === '' ? null : text;
}

function key(value: unknown, what: string): string {
  const text = String(value ?? '');
  if (text.length === 0 || [...text].length > REJECTION_CHECK_KEY_MAX || text.includes('\u0000')) {
    throw new TypeError(`${what}不合法：${JSON.stringify(text.slice(0, REJECTION_CHECK_KEY_MAX))}`);
  }
  return text;
}

function optionalKey(value: unknown, what: string): string | null {
  return value === null || value === undefined || value === '' ? null : key(value, what);
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

function count(value: unknown): number {
  const number = Math.round(Number(value ?? 0));
  return Number.isFinite(number) && number > 0 ? Math.min(number, 2_147_483_647) : 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** 与桌面版 stripTripleQuoteWrapper 相同：去掉模型输出外层的 '''。 */
function stripTripleQuoteWrapper(content: string): string {
  const trimmed = content.trim();
  return trimmed.startsWith("'''") && trimmed.endsWith("'''") ? trimmed.slice(3, -3).trim() : content;
}

/** 与桌面版 normalizeCheckOptions 相同：废标项检查始终开启，其余两项不是 false 即开启。 */
function normalizeCheckOptions(options: { typoCheck?: unknown; logicCheck?: unknown } | undefined): CheckOptions {
  return { rejectionCheck: true, typoCheck: options?.typoCheck !== false, logicCheck: options?.logicCheck !== false };
}

/** 行数可能上千：分批插入，避免单条语句的参数超过 PostgreSQL 的上限（65535）。 */
async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  const size = 500;
  for (let start = 0; start < rows.length; start += size) await insert(rows.slice(start, start + size));
}

type Trx = Transaction<Database>;

/** 同一项目的导入、移除、清空和任务写入串行执行。 */
async function lockProject(trx: Trx, projectId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`rejection_check:${projectId}`}, 0))`.execute(trx);
}

// ---- 签名 ----

const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');

function documentsSignature(documents: readonly Pick<RejectionCheckDocument, 'id' | 'contentHash'>[]): string {
  if (documents.length === 0) return '';
  return sha1(documents.map((document) => `${document.id}|${document.contentHash ?? ''}`).join('\n'));
}

/**
 * 当前输入的签名（第 6 步的任务开始检查时按同样的方式算出并写进结果）。解析结果只在其招标文件签名与当前一致时计入，
 * 与桌面版 Renderer 的 visibleExtractionContent 相同。
 */
export function computeSignatures(input: {
  tenderDocuments: readonly Pick<RejectionCheckDocument, 'id' | 'contentHash'>[];
  bidDocuments: readonly Pick<RejectionCheckDocument, 'id' | 'contentHash'>[];
  extraction: Pick<ExtractionState, 'content' | 'tenderSignature'>;
  customCheckItems: string;
}): Signatures {
  const tender = documentsSignature(input.tenderDocuments);
  const bid = documentsSignature(input.bidDocuments);
  const analysis = tender !== '' && input.extraction.tenderSignature === tender ? input.extraction.content.trim() : '';
  const rejectionInput = bid !== '' && analysis !== '' ? sha1(JSON.stringify([bid, analysis, input.customCheckItems.trim()])) : '';
  return { tender, bid, rejectionInput };
}

// ---- 读取 ----

async function readDocuments(trx: Trx, projectId: string): Promise<{ tenderDocuments: RejectionCheckDocument[]; bidDocuments: RejectionCheckDocument[] }> {
  const rows = await trx
    .selectFrom('rejection_check_documents as d')
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
    .orderBy('d.role')
    .orderBy('d.sort_order')
    .orderBy('d.created_at')
    .orderBy('d.file_id')
    .execute();
  const documents = rows.map(
    (row): RejectionCheckDocument => ({
      id: row.file_id,
      role: row.role,
      fileName: row.display_name,
      extension: row.extension,
      size: Number(row.size_bytes ?? 0),
      uploadedAt: row.uploaded_at ?? row.created_at,
      importedAt: row.imported_at,
      status: oneOf(row.status, REJECTION_CHECK_DOCUMENT_STATUSES, 'pending'),
      markdownArtifactId: row.markdown_artifact_id,
      contentChars: row.content_chars,
      contentHash: row.content_hash,
      parserLabel: row.parser_label,
      error: row.error,
    }),
  );
  return {
    tenderDocuments: documents.filter((document) => document.role === 'tender'),
    bidDocuments: documents.filter((document) => document.role === 'bid'),
  };
}

async function readUiState(trx: Trx, projectId: string): Promise<UiState> {
  const row = await trx.selectFrom('rejection_check_meta').selectAll().where('project_id', '=', projectId).executeTakeFirst();
  return {
    step: row?.step ?? 'documents',
    activeDocumentTab: row?.active_document_tab ?? TENDER_TAB,
    activeResultTab: row?.active_result_tab ?? 'analysis',
    activeCheckResultTab: row?.active_check_result_tab ?? 'rejection',
    customCheckItems: row?.custom_check_items ?? '',
    checkOptions: normalizeCheckOptions(row ? { typoCheck: row.typo_check, logicCheck: row.logic_check } : undefined),
  };
}

async function readExtraction(trx: Trx, projectId: string): Promise<ExtractionState> {
  const row = await trx.selectFrom('rejection_check_extraction').selectAll().where('project_id', '=', projectId).executeTakeFirst();
  if (!row) return { status: 'idle', content: '', source: null, tenderSignature: null, error: null, updatedAt: null };
  return {
    status: oneOf(row.status, REJECTION_CHECK_RUN_STATUSES, 'idle'),
    content: row.content,
    source: row.source,
    tenderSignature: row.tender_signature,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

const FINDING_TABLES = {
  rejection: 'rejection_check_risk_findings',
  typo: 'rejection_check_typo_findings',
  logic: 'rejection_check_logic_findings',
} as const;

async function readFindings<T extends RejectionCheckResultType>(trx: Trx, projectId: string, type: T): Promise<Findings[T][]> {
  if (type === 'rejection') {
    const rows = await trx
      .selectFrom('rejection_check_risk_findings')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('sort_order')
      .orderBy('finding_id')
      .execute();
    return rows.map((row) => ({
      id: row.finding_id,
      bidDocumentId: row.bid_document_id,
      type: row.type,
      severity: row.severity,
      title: row.title,
      summary: row.summary,
      requirement: row.requirement,
      bidEvidence: row.bid_evidence,
      riskReason: row.risk_reason,
      suggestion: row.suggestion,
    })) as Findings[T][];
  }
  if (type === 'typo') {
    const rows = await trx
      .selectFrom('rejection_check_typo_findings')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('sort_order')
      .orderBy('finding_id')
      .execute();
    return rows.map((row) => ({
      id: row.finding_id,
      bidDocumentId: row.bid_document_id,
      wrongText: row.wrong_text,
      correctText: row.correct_text,
      originalExcerpt: row.original_excerpt,
      reason: row.reason,
      locationHint: row.location_hint,
    })) as Findings[T][];
  }
  const rows = await trx
    .selectFrom('rejection_check_logic_findings')
    .selectAll()
    .where('project_id', '=', projectId)
    .orderBy('sort_order')
    .orderBy('finding_id')
    .execute();
  return rows.map((row) => ({
    id: row.finding_id,
    bidDocumentId: row.bid_document_id,
    title: row.title,
    originalText: row.original_text,
    locationHint: row.location_hint,
    fallacyReason: row.fallacy_reason,
    suggestion: row.suggestion,
  })) as Findings[T][];
}

async function readResult<T extends RejectionCheckResultType>(trx: Trx, projectId: string, type: T): Promise<CheckResult<Findings[T]>> {
  const row = await trx
    .selectFrom('rejection_check_results')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('result_type', '=', type)
    .executeTakeFirst();
  const findings = await readFindings(trx, projectId, type);
  if (!row) return { status: 'idle', findings, inputSignature: null, activeFindingId: null, progressMessage: null, error: null, updatedAt: null };
  return {
    status: oneOf(row.status, REJECTION_CHECK_RUN_STATUSES, 'idle'),
    findings,
    inputSignature: row.input_signature,
    activeFindingId: row.active_finding_id,
    progressMessage: row.progress_message,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

/** 结果仍是 running、但对应的任务已结束或不存在（执行者失联后被标为失败、已取消等）时，按未完成显示。 */
function settleStale<T extends { status: RejectionCheckRunStatus; error: string | null }>(result: T, task: JobRecord | undefined, message: string): T {
  if (result.status !== 'running' || (task && !isFinalStatus(task.status))) return result;
  return { ...result, status: 'error', error: message, ...('progressMessage' in result ? { progressMessage: message } : {}) };
}

/** 当前输入的签名（在已加锁的事务中读取，任务写入前核对）。 */
async function currentSignatures(trx: Trx, projectId: string): Promise<Signatures> {
  const documents = await readDocuments(trx, projectId);
  const ui = await readUiState(trx, projectId);
  const extraction = await readExtraction(trx, projectId);
  return computeSignatures({ ...documents, extraction, customCheckItems: ui.customCheckItems });
}

/** 在已设置上下文的事务中读取完整状态（与桌面版 loadRejectionCheck 相同）。 */
export async function readState(trx: Trx, projectId: string): Promise<RejectionCheckState> {
  const documents = await readDocuments(trx, projectId);
  const ui = await readUiState(trx, projectId);
  const tasks = await latestProjectJobs(trx, projectId, [REJECTION_ITEMS_EXTRACTION_JOB_TYPE, REJECTION_CHECK_RUN_JOB_TYPE]);
  const extractionTask = tasks.get(REJECTION_ITEMS_EXTRACTION_JOB_TYPE);
  const checkTask = tasks.get(REJECTION_CHECK_RUN_JOB_TYPE);
  const extraction = settleStale(await readExtraction(trx, projectId), extractionTask, STALE_EXTRACTION_MESSAGE);
  // 当前文档页签不可用时与桌面版相同回退：有招标文件回到合并的招标正文，否则第一份投标文件。
  const tab = ui.activeDocumentTab;
  const tabValid = tab === TENDER_TAB || [...documents.tenderDocuments, ...documents.bidDocuments].some((document) => document.id === tab);
  const activeDocumentTab = tabValid ? tab : documents.tenderDocuments.length ? TENDER_TAB : (documents.bidDocuments[0]?.id ?? TENDER_TAB);
  return {
    ...documents,
    ...ui,
    activeDocumentTab,
    signatures: computeSignatures({ ...documents, extraction, customCheckItems: ui.customCheckItems }),
    invalidBidAndRejectionItems: extraction,
    rejectionCheckResult: settleStale(await readResult(trx, projectId, 'rejection'), checkTask, STALE_CHECK_MESSAGE),
    typoCheckResult: settleStale(await readResult(trx, projectId, 'typo'), checkTask, STALE_CHECK_MESSAGE),
    logicCheckResult: settleStale(await readResult(trx, projectId, 'logic'), checkTask, STALE_CHECK_MESSAGE),
    extractionTask: extractionTask ? jobBody(extractionTask) : null,
    checkTask: checkTask ? jobBody(checkTask) : null,
  };
}

export async function loadRejectionCheck(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<RejectionCheckState> {
  return withTenant(db, context, (trx) => readState(trx, projectId));
}

// ---- 页面状态 ----

interface MetaPatch {
  step?: RejectionCheckStep;
  active_document_tab?: string;
  active_result_tab?: RejectionCheckResultTab;
  active_check_result_tab?: RejectionCheckResultType;
  custom_check_items?: string;
  typo_check?: boolean;
  logic_check?: boolean;
}

async function writeMeta(trx: Trx, context: TenantContext, projectId: string, set: MetaPatch): Promise<void> {
  const query = trx.insertInto('rejection_check_meta').values({ project_id: projectId, org_id: context.orgId, ...set });
  await (Object.keys(set).length
    ? query.onConflict((oc) => oc.column('project_id').doUpdateSet(set))
    : query.onConflict((oc) => oc.column('project_id').doNothing())
  ).execute();
}

export interface UiStatePatch {
  step?: RejectionCheckStep;
  activeDocumentTab?: string;
  activeResultTab?: RejectionCheckResultTab;
  activeCheckResultTab?: RejectionCheckResultType;
  customCheckItems?: string;
  checkOptions?: { rejectionCheck?: boolean; typoCheck?: boolean; logicCheck?: boolean };
}

/** 保存页面状态（与桌面版 saveUiState 相同，只写给出的字段；检查选项给出时按桌面版整理）。 */
export async function saveUiState(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  patch: UiStatePatch,
): Promise<UiState> {
  const set: MetaPatch = {};
  if (patch.step !== undefined) set.step = oneOf(patch.step, REJECTION_CHECK_STEPS, 'documents');
  if (patch.activeDocumentTab !== undefined) set.active_document_tab = patch.activeDocumentTab.trim() || TENDER_TAB;
  if (patch.activeResultTab !== undefined) set.active_result_tab = oneOf(patch.activeResultTab, REJECTION_CHECK_RESULT_TABS, 'analysis');
  if (patch.activeCheckResultTab !== undefined) set.active_check_result_tab = oneOf(patch.activeCheckResultTab, REJECTION_CHECK_RESULT_TYPES, 'rejection');
  if (patch.customCheckItems !== undefined) set.custom_check_items = patch.customCheckItems.replaceAll('\u0000', '');
  if (patch.checkOptions !== undefined) {
    const options = normalizeCheckOptions(patch.checkOptions);
    set.typo_check = options.typoCheck;
    set.logic_check = options.logicCheck;
  }
  return withTenant(db, context, async (trx) => {
    await writeMeta(trx, context, projectId, set);
    return readUiState(trx, projectId);
  });
}

// ---- 文档 ----

/** 删除一类检查的问题（给出 findingId 时只删这一条），返回删除的行数。三张表的列不同，按表名动态删除时不做列类型推断。 */
async function deleteFindingRows(trx: Trx, type: RejectionCheckResultType, projectId: string, findingId?: string): Promise<number> {
  let query = (trx as unknown as Transaction<any>).deleteFrom(FINDING_TABLES[type]).where('project_id', '=', projectId);
  if (findingId !== undefined) query = query.where('finding_id', '=', findingId);
  return Number((await query.executeTakeFirst()).numDeletedRows);
}

/** 删除三类检查的状态和问题（与桌面版 clearCheckResults 相同）。 */
async function clearCheckResults(trx: Trx, projectId: string): Promise<void> {
  await trx.deleteFrom('rejection_check_results').where('project_id', '=', projectId).execute();
  for (const type of REJECTION_CHECK_RESULT_TYPES) await deleteFindingRows(trx, type, projectId);
}

/** 另删除解析结果（与桌面版 clearExtractionAndCheckResults 相同）。 */
async function clearExtractionAndCheckResults(trx: Trx, projectId: string): Promise<void> {
  await trx.deleteFrom('rejection_check_extraction').where('project_id', '=', projectId).execute();
  await clearCheckResults(trx, projectId);
}

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

export interface ImportDocumentsInput {
  role: RejectionCheckDocumentRole;
  fileIds: string[];
}

export interface ImportDocumentsResult {
  addedCount: number;
  /** 新导入的文件（待解析，由接口入队解析任务）。 */
  addedFileIds: string[];
  /** 已导入到本项目的文件（与桌面版跳过重复文件相同，不再导入）。 */
  skippedCount: number;
  state: RejectionCheckState;
}

/**
 * 导入招标文件或投标文件（取代桌面版 importDocument）：把已上传的 tender 文件挂到本项目（files.project_id）并按给出的
 * 顺序追加到同类文档之后，文档停在待解析（由接口入队解析任务，6.6）。已导入到本项目的文件跳过。有新文档时与桌面版相同：招标文件
 * 清空解析结果和三类检查结果，当前页签回到合并的招标正文；投标文件清空三类检查结果，当前页签切到第一份新投标文件。
 * 文件不可用（不存在、其他组织的、未上传完成、已删除、用途不是 tender、属于其他项目）时整体失败，返回 400。
 */
export async function importDocuments(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: ImportDocumentsInput,
): Promise<ImportDocumentsResult> {
  const ids = input.fileIds.map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw fileUnavailable();
  const role = input.role;
  const max = role === 'tender' ? REJECTION_CHECK_TENDER_DOCUMENTS_MAX : REJECTION_CHECK_BID_DOCUMENTS_MAX;
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const existing = await trx.selectFrom('rejection_check_documents').select(['file_id', 'role', 'sort_order']).where('project_id', '=', projectId).execute();
    const known = new Set(existing.map((row) => row.file_id));
    const added = ids.filter((id) => !known.has(id));
    const sameRole = existing.filter((row) => row.role === role);
    if (sameRole.length + added.length > max) {
      throw new AppError(400, 'REJECTION_CHECK_DOCUMENT_LIMIT', `每个项目最多导入 ${max} 份${role === 'tender' ? '招标' : '投标'}文件`);
    }
    if (added.length > 0) {
      // 挂到本项目。已属于其他项目的文件由触发器 files_project_guard 拒绝（FS005，迁移 0015）；能否导入由
      // rejection_check_documents 的 INSERT 策略检查，这里的条件只为给出明确的错误。
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
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 'FS005' || code === '23503') throw fileUnavailable(error);
        throw error;
      }
      if (Number(claimed.numUpdatedRows) !== added.length) throw fileUnavailable();
      const start = sameRole.reduce((next, row) => Math.max(next, row.sort_order + 1), 0);
      try {
        await trx
          .insertInto('rejection_check_documents')
          .values(added.map((fileId, index) => ({ file_id: fileId, org_id: context.orgId, project_id: projectId, role, sort_order: start + index })))
          .execute();
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        // 42501：INSERT 策略拒绝（文件不可用）；23505：文件已导入（原件在回收站时文档行不可见）；23503：外键（其他组织的文件）。
        if (code === '42501' || code === '23505' || code === '23503') throw fileUnavailable(error);
        throw error;
      }
      if (role === 'tender') await clearExtractionAndCheckResults(trx, projectId);
      else await clearCheckResults(trx, projectId);
      await writeMeta(trx, context, projectId, { active_document_tab: role === 'tender' ? TENDER_TAB : added[0]! });
    }
    return { addedCount: added.length, addedFileIds: added, skippedCount: ids.length - added.length, state: await readState(trx, projectId) };
  });
}

/** 从技术方案复制来的一份招标文件：原件与 Markdown 产物都已是本组织的新副本（见 fromTechnicalPlan.ts）。 */
export interface CopiedTenderDocument {
  fileId: string;
  markdownArtifactId: string;
  contentChars: number;
  contentHash: string | null;
  parserLabel: string | null;
}

/**
 * 用从技术方案复制来的招标文件整体替换本项目的招标文件（importTenderFromTechnicalPlan 的最后一步，与桌面版相同）：新原件挂到
 * 本项目并登记，直接写入解析结果（Markdown 已有，不再解析）；原有的招标文件原件软删除；清空解析结果和三类检查结果，技术方案
 * 中已解析出的无效投标与废标项（discardedBids）给出时作为来源为 technical-plan 的解析结果写入，签名取替换后的招标文件；当前
 * 页签回到合并的招标正文。新原件或产物不合规时被触发器、RLS 拒绝，整体回滚。
 */
export async function replaceTenderDocuments(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  documents: CopiedTenderDocument[],
  discardedBids: string | null,
): Promise<RejectionCheckState> {
  if (documents.length === 0 || documents.length > REJECTION_CHECK_TENDER_DOCUMENTS_MAX) throw new TypeError('招标文件数不合法');
  const ids = documents.map((document) => uuid(document.fileId, '文件 id'));
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const existing = await trx
      .selectFrom('rejection_check_documents')
      .select('file_id')
      .where('project_id', '=', projectId)
      .where('role', '=', 'tender')
      .execute();
    const claimed = await trx
      .updateTable('files')
      .set({ project_id: projectId })
      .where('id', 'in', ids)
      .where('purpose', '=', 'tender')
      .where('status', '=', 'uploaded')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== ids.length) throw new Error('copied tender files are unavailable');
    // 先删结果再软删除原件（同 removeDocument）。
    await clearExtractionAndCheckResults(trx, projectId);
    await trashFiles(
      trx,
      context,
      existing.map((row) => row.file_id),
    );
    await trx
      .insertInto('rejection_check_documents')
      .values(ids.map((fileId, index) => ({ file_id: fileId, org_id: context.orgId, project_id: projectId, role: 'tender' as const, sort_order: index })))
      .execute();
    for (const [index, document] of documents.entries()) {
      await trx
        .updateTable('rejection_check_documents')
        .set({
          status: 'success',
          markdown_artifact_id: uuid(document.markdownArtifactId, 'Markdown 产物 id'),
          content_chars: count(document.contentChars),
          content_hash: optionalKey(document.contentHash, '正文哈希'),
          parser_label: optionalText(document.parserLabel, REJECTION_CHECK_PARSER_LABEL_MAX),
        })
        .where('project_id', '=', projectId)
        .where('file_id', '=', ids[index]!)
        .execute();
    }
    const analysis = discardedBids?.trim() ? taskText(stripTripleQuoteWrapper(discardedBids), REJECTION_CHECK_EXTRACTION_MAX) : '';
    if (analysis) {
      const { signatures } = await readState(trx, projectId);
      await trx
        .insertInto('rejection_check_extraction')
        .values({ project_id: projectId, org_id: context.orgId, status: 'success', content: analysis, source: 'technical-plan', tender_signature: signatures.tender })
        .execute();
    }
    await writeMeta(trx, context, projectId, { active_document_tab: TENDER_TAB });
    return readState(trx, projectId);
  });
}

/** 文档的类别（移除前决定取消哪些任务）；文档不存在或已移除时为 null。 */
export async function findDocumentRole(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  fileId: string,
): Promise<RejectionCheckDocumentRole | null> {
  const row = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('rejection_check_documents')
      .select('role')
      .where('project_id', '=', projectId)
      .where('file_id', '=', fileId.toLowerCase())
      .executeTakeFirst(),
  );
  return row?.role ?? null;
}

/**
 * 移除一份文档（取代桌面版 removeDocument）：原件软删除（进回收站），文档行随之不可见。与桌面版相同：招标文件清空解析结果
 * 和三类检查结果，当前页签回到合并的招标正文；投标文件清空三类检查结果，当前页签切到剩下的第一份投标文件。
 */
export async function removeDocument(db: Kysely<Database>, context: TenantContext, projectId: string, fileId: string): Promise<RejectionCheckState> {
  const id = fileId.toLowerCase();
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const document = await trx
      .selectFrom('rejection_check_documents')
      .select('role')
      .where('project_id', '=', projectId)
      .where('file_id', '=', id)
      .executeTakeFirst();
    if (!document) throw documentNotFound();
    // 先删结果再软删除原件：原件进回收站后，引用它的问题不可见，删不到。
    if (document.role === 'tender') await clearExtractionAndCheckResults(trx, projectId);
    else await clearCheckResults(trx, projectId);
    await trashFiles(trx, context, [id]);
    if (document.role === 'tender') {
      await writeMeta(trx, context, projectId, { active_document_tab: TENDER_TAB });
    } else {
      const next = await trx
        .selectFrom('rejection_check_documents')
        .select('file_id')
        .where('project_id', '=', projectId)
        .where('role', '=', 'bid')
        .orderBy('sort_order')
        .orderBy('created_at')
        .orderBy('file_id')
        .executeTakeFirst();
      await writeMeta(trx, context, projectId, { active_document_tab: next?.file_id ?? TENDER_TAB });
    }
    return readState(trx, projectId);
  });
}

/**
 * 清空废标检查（与桌面版 clear 相同）：删除解析结果和三类检查结果，导入的文档的原件软删除（进回收站），页面状态恢复默认值。
 * 返回软删除的文件数。
 */
export async function clearRejectionCheck(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<{ deletedFileCount: number }> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const documents = await trx.selectFrom('rejection_check_documents').select('file_id').where('project_id', '=', projectId).execute();
    // 先删结果再软删除原件（同 removeDocument）。
    await clearExtractionAndCheckResults(trx, projectId);
    const deletedFileCount = await trashFiles(
      trx,
      context,
      documents.map((row) => row.file_id),
    );
    await trx
      .updateTable('rejection_check_meta')
      .set({
        step: 'documents',
        active_document_tab: TENDER_TAB,
        active_result_tab: 'analysis',
        active_check_result_tab: 'rejection',
        custom_check_items: '',
        typo_check: true,
        logic_check: true,
      })
      .where('project_id', '=', projectId)
      .execute();
    return { deletedFileCount };
  });
}

// ---- 检查结果（用户操作） ----

/** 删除单条问题后的进度说明（与桌面版 Renderer 的 deleteFinding / deleteTypoFinding / deleteLogicFinding 相同）。 */
function remainingMessage(type: RejectionCheckResultType, remaining: number): string {
  if (type === 'rejection') return remaining ? `保留 ${remaining} 个需复核风险项` : '所有风险项已处理';
  if (type === 'typo') return remaining ? `保留 ${remaining} 个疑似错别字` : '所有错别字项已处理';
  return remaining ? `保留 ${remaining} 个逻辑问题` : '所有逻辑问题已处理';
}

async function upsertResult(
  trx: Trx,
  context: TenantContext,
  projectId: string,
  type: RejectionCheckResultType,
  set: { status?: RejectionCheckRunStatus; input_signature?: string | null; active_finding_id?: string | null; progress_message?: string | null; error?: string | null },
): Promise<void> {
  const query = trx.insertInto('rejection_check_results').values({ org_id: context.orgId, project_id: projectId, result_type: type, status: 'idle', ...set });
  await (Object.keys(set).length
    ? query.onConflict((oc) => oc.columns(['project_id', 'result_type']).doUpdateSet(set))
    : query.onConflict((oc) => oc.columns(['project_id', 'result_type']).doNothing())
  ).execute();
}

function assertResultType(type: string): asserts type is RejectionCheckResultType {
  if (!(REJECTION_CHECK_RESULT_TYPES as readonly string[]).includes(type)) throw new TypeError(`检查类型不合法：${type}`);
}

/** 切换当前问题（取代桌面版 Renderer 经 updateState 保存的 activeFindingId；null 表示收起）。 */
export async function setActiveFinding<T extends RejectionCheckResultType>(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  type: T,
  activeFindingId: string | null,
): Promise<CheckResult<Findings[T]>> {
  assertResultType(type);
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    await upsertResult(trx, context, projectId, type, { active_finding_id: activeFindingId === null || activeFindingId === '' ? null : activeFindingId });
    return readResult(trx, projectId, type);
  });
}

/** 删除单条问题（取代桌面版 Renderer 经 updateState 保存的过滤后的问题列表），进度说明与桌面版相同。 */
export async function deleteFinding<T extends RejectionCheckResultType>(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  type: T,
  findingId: string,
): Promise<CheckResult<Findings[T]>> {
  assertResultType(type);
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if ((await deleteFindingRows(trx, type, projectId, findingId)) === 0) throw findingNotFound();
    const current = await readResult(trx, projectId, type);
    await upsertResult(trx, context, projectId, type, {
      active_finding_id: current.activeFindingId === findingId ? null : current.activeFindingId,
      progress_message: remainingMessage(type, current.findings.length),
    });
    return readResult(trx, projectId, type);
  });
}

// ---- 任务写入 ----

export interface DocumentParseInput {
  status?: RejectionCheckDocumentStatus;
  markdownArtifactId?: string | null;
  contentChars?: number;
  /** 解析出的正文的哈希（参与签名）。 */
  contentHash?: string | null;
  parserLabel?: string | null;
  error?: string | null;
}

/**
 * 写入一份文档的解析结果（给第 6 步的解析任务用，取代桌面版导入时同步解析写入的 markdown_path、content_hash 等）：
 * 只写给出的字段。markdownArtifactId 只能是本文档原件的 Markdown 产物，否则被 RLS 拒绝。文档已移除（原件进回收站）
 * 时返回 false。
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
    ...(hasOwn(input, 'status') ? { status: oneOf(input.status, REJECTION_CHECK_DOCUMENT_STATUSES, 'pending') } : {}),
    ...(hasOwn(input, 'markdownArtifactId') ? { markdown_artifact_id: optionalUuid(input.markdownArtifactId, 'Markdown 产物 id') } : {}),
    ...(hasOwn(input, 'contentChars') ? { content_chars: count(input.contentChars) } : {}),
    ...(hasOwn(input, 'contentHash') ? { content_hash: optionalKey(input.contentHash, '正文哈希') } : {}),
    ...(hasOwn(input, 'parserLabel') ? { parser_label: optionalText(input.parserLabel, REJECTION_CHECK_PARSER_LABEL_MAX) } : {}),
    ...(hasOwn(input, 'error') ? { error: optionalText(input.error, REJECTION_CHECK_TEXT_MAX) } : {}),
  };
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (Object.keys(set).length === 0) {
      return Boolean(await trx.selectFrom('rejection_check_documents').select('file_id').where('project_id', '=', projectId).where('file_id', '=', id).executeTakeFirst());
    }
    const result = await trx.updateTable('rejection_check_documents').set(set).where('project_id', '=', projectId).where('file_id', '=', id).executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  });
}

export interface ExtractionInput {
  status?: RejectionCheckRunStatus;
  content?: string;
  source?: RejectionCheckExtractionSource | null;
  tenderSignature?: string | null;
  error?: string | null;
}

export interface TaskWriteOptions {
  /**
   * 任务开始时输入的签名（解析结果写招标文件签名，废标项检查写 rejectionInput，错别字、逻辑检查写 bid）：给出时在同一事务中
   * 与当前签名核对，不一致（任务开始后导入、移除了文档，或改了解析结果、自定义检查项）时不写入、返回 false。
   */
  expectedSignature?: string;
}

/**
 * 写入无效投标与废标项的解析结果（给第 6 步的解析任务用，取代桌面版 updateState 的 invalidBidAndRejectionItems）：
 * 与桌面版 saveExtraction 相同整体写入，没给出的字段取默认值，正文去掉外层的 '''；null 删除解析结果。
 * options.expectedSignature 与当前招标文件签名不一致时不写入，返回 false。
 */
export async function saveExtraction(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  extraction: ExtractionInput | null,
  options: TaskWriteOptions = {},
): Promise<boolean> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (options.expectedSignature !== undefined && (await currentSignatures(trx, projectId)).tender !== options.expectedSignature) return false;
    if (!extraction) {
      await trx.deleteFrom('rejection_check_extraction').where('project_id', '=', projectId).execute();
      return true;
    }
    const values = {
      status: oneOf(extraction.status, REJECTION_CHECK_RUN_STATUSES, 'idle'),
      content: taskText(stripTripleQuoteWrapper(String(extraction.content ?? '')), REJECTION_CHECK_EXTRACTION_MAX),
      source: extraction.source ? oneOf(extraction.source, REJECTION_CHECK_EXTRACTION_SOURCES, 'ai') : null,
      tender_signature: optionalKey(extraction.tenderSignature, '招标文件签名'),
      error: optionalText(extraction.error, REJECTION_CHECK_TEXT_MAX),
    };
    await trx
      .insertInto('rejection_check_extraction')
      .values({ project_id: projectId, org_id: context.orgId, ...values })
      .onConflict((oc) => oc.column('project_id').doUpdateSet(values))
      .execute();
    return true;
  });
}

interface FindingInputBase {
  id?: string;
  bidDocumentId?: string;
}

export interface RiskFindingInput extends FindingInputBase {
  type?: RejectionCheckFindingType;
  severity?: RejectionCheckSeverity;
  title?: string;
  summary?: string;
  requirement?: string;
  bidEvidence?: string;
  riskReason?: string;
  suggestion?: string;
}

export interface TypoFindingInput extends FindingInputBase {
  wrongText?: string;
  correctText?: string;
  originalExcerpt?: string;
  reason?: string;
  locationHint?: string | null;
}

export interface LogicFindingInput extends FindingInputBase {
  title?: string;
  originalText?: string;
  locationHint?: string;
  fallacyReason?: string;
  suggestion?: string;
}

export interface FindingInputs {
  rejection: RiskFindingInput;
  typo: TypoFindingInput;
  logic: LogicFindingInput;
}

export interface CheckResultInput<F> {
  status?: RejectionCheckRunStatus;
  /** 给出 null 时清除。 */
  inputSignature?: string | null;
  activeFindingId?: string | null;
  progressMessage?: string | null;
  error?: string | null;
  /** 给出时整体替换。 */
  findings?: F[];
}

function findingRows(type: RejectionCheckResultType, context: TenantContext, projectId: string, findings: unknown[]): Record<string, unknown>[] {
  const ids = new Set<string>();
  return findings.map((value, index) => {
    const item = (value ?? {}) as Record<string, unknown>;
    // 默认 id 与桌面版相同（rejection-finding-1 等）。
    const findingId = key(item.id || `${type}-finding-${index + 1}`, '问题 id');
    if (ids.has(findingId)) throw new TypeError(`问题 id 重复：${findingId}`);
    ids.add(findingId);
    const base = {
      org_id: context.orgId,
      project_id: projectId,
      finding_id: findingId,
      bid_document_id: uuid(item.bidDocumentId, '投标文件 id'),
      sort_order: index,
    };
    const title = (field: string) => taskText(item[field] ?? '', REJECTION_CHECK_TITLE_MAX);
    const body = (field: string) => taskText(item[field] ?? '', REJECTION_CHECK_TEXT_MAX);
    if (type === 'rejection') {
      return {
        ...base,
        type: item.type === 'invalidBid' ? 'invalidBid' : 'rejectionItem',
        severity: oneOf(item.severity, REJECTION_CHECK_SEVERITIES, 'medium'),
        title: title('title'),
        summary: taskText(item.summary || item.title || '', REJECTION_CHECK_TEXT_MAX),
        requirement: body('requirement'),
        bid_evidence: body('bidEvidence'),
        risk_reason: body('riskReason'),
        suggestion: body('suggestion'),
      };
    }
    if (type === 'typo') {
      return {
        ...base,
        wrong_text: title('wrongText'),
        correct_text: title('correctText'),
        original_excerpt: body('originalExcerpt'),
        reason: body('reason'),
        location_hint: optionalText(item.locationHint, REJECTION_CHECK_TITLE_MAX),
      };
    }
    return {
      ...base,
      title: title('title'),
      original_text: body('originalText'),
      location_hint: title('locationHint'),
      fallacy_reason: body('fallacyReason'),
      suggestion: body('suggestion'),
    };
  });
}

/**
 * 写入一类检查的状态与问题（给第 6 步的检查任务用，取代桌面版 updateState 的 rejectionCheckResult / typoCheckResult /
 * logicCheckResult）：状态、签名、当前问题、进度说明、错误只写给出的字段，问题给出时整体替换。result 为 null 时删除这一类
 * 的状态和全部问题。问题引用的必须是本项目当前的投标文件，否则被 RLS 拒绝（文档已移除时任务的写入失败）。
 * options.expectedSignature 与这一类当前应匹配的签名（废标项为 rejectionInput，其余为 bid）不一致时不写入，返回 false。
 */
export async function saveCheckResult<T extends RejectionCheckResultType>(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  type: T,
  result: CheckResultInput<FindingInputs[T]> | null,
  options: TaskWriteOptions = {},
): Promise<boolean> {
  assertResultType(type);
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    if (options.expectedSignature !== undefined) {
      const signatures = await currentSignatures(trx, projectId);
      if ((type === 'rejection' ? signatures.rejectionInput : signatures.bid) !== options.expectedSignature) return false;
    }
    if (!result) {
      await trx.deleteFrom('rejection_check_results').where('project_id', '=', projectId).where('result_type', '=', type).execute();
      await deleteFindingRows(trx, type, projectId);
      return true;
    }
    const set = {
      ...(hasOwn(result, 'status') ? { status: oneOf(result.status, REJECTION_CHECK_RUN_STATUSES, 'idle') } : {}),
      ...(hasOwn(result, 'inputSignature') ? { input_signature: optionalKey(result.inputSignature, '检查签名') } : {}),
      ...(hasOwn(result, 'activeFindingId') ? { active_finding_id: optionalKey(result.activeFindingId, '当前问题 id') } : {}),
      ...(hasOwn(result, 'progressMessage') ? { progress_message: optionalText(result.progressMessage, REJECTION_CHECK_TITLE_MAX) } : {}),
      ...(hasOwn(result, 'error') ? { error: optionalText(result.error, REJECTION_CHECK_TEXT_MAX) } : {}),
    };
    await upsertResult(trx, context, projectId, type, set);
    if (hasOwn(result, 'findings')) {
      const rows = findingRows(type, context, projectId, result.findings ?? []);
      await deleteFindingRows(trx, type, projectId);
      await insertChunked(rows, (chunk) => trx.insertInto(FINDING_TABLES[type]).values(chunk as never).execute());
    }
    return true;
  });
}
