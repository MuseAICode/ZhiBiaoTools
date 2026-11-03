// 标书查重的读写（迁移 0014_duplicate_check）：页面状态、文件选择、四类分析的状态与结果。组织和用户一律来自
// TenantContext，所有查询都经 withTenant；项目由路由先经 requireProject 校验（kind = duplicate-check）。
//
// 可见性、写权限和删除可见性由 RLS 保证，这里不判断：所属项目已删除时十三张表的行都查不到、改不了；选中的文件随原件的
// 生命周期，原件已删除（进入回收站）时文件行和引用它的分析结果都不可见。选择文件就是把已上传的 duplicate-check 文件
// 挂到本项目（files.project_id，设置后不能再改，由迁移 0015 的触发器保证）并登记到 duplicate_check_files；
// 从选择中去掉的文件和清空时的全部文件软删除（进回收站，按文件自己的恢复期处理）。
//
// 与桌面版 duplicateCheckStore.cjs 相同：重新选择文件时清空全部分析结果；分析结果由任务按类整体替换写入，状态与统计
// 按字段合并。给第 6 步查重任务用的写函数（saveAnalysisSection，取代桌面版 updateState 中的分析部分）在本步一并实现，
// 参数不合法（id 为空或超长、父目录项不存在）是调用方的程序错误，抛 TypeError；说明、错误等文本超长时截短，不让任务失败。
// 文件选择的签名按当前可见的文件现算（文件 id、大小、上传完成时间），分析结果的 signature 与它不同即已失效。
//
// 第 6 步 6.10：分析由任务 duplicate-analysis 执行（src/duplicateCheck/job.ts），写入带任务开始时的签名，文件选择已变化时不写入；
// 状态中的 analysisTask 是本项目最近一次分析任务，任务已结束而分析仍是 running 时按未完成显示（取代桌面版的启动时恢复）。
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  DUPLICATE_CHECK_GROUP_TYPES,
  DUPLICATE_CHECK_JSON_MAX_BYTES,
  DUPLICATE_CHECK_KEY_MAX,
  DUPLICATE_CHECK_LEVEL_MAX,
  DUPLICATE_CHECK_OUTLINE_SOURCES,
  DUPLICATE_CHECK_PARSER_LABEL_MAX,
  DUPLICATE_CHECK_PATH_MAX_BYTES,
  DUPLICATE_CHECK_RISKS,
  DUPLICATE_CHECK_SCORE_MAX,
  DUPLICATE_CHECK_SECTIONS,
  DUPLICATE_CHECK_SENTENCE_MAX,
  DUPLICATE_CHECK_STATUSES,
  DUPLICATE_CHECK_TEXT_MAX,
  DUPLICATE_CHECK_TITLE_MAX,
} from '../db/migrations/0014_duplicate_check.ts';
import type {
  Database,
  DuplicateCheckFileRole,
  DuplicateCheckGroupType,
  DuplicateCheckOutlineSource,
  DuplicateCheckRisk,
  DuplicateCheckSection,
  DuplicateCheckStatus,
  DuplicateCheckStep,
} from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { isFinalStatus, latestProjectJobs, type JobRecord } from '../jobs/store.ts';
import { jobBody, type JobBody } from '../jobs/view.ts';
import { serializeJsonObject } from '../jsonObject.ts';

/** 一次最多选的招标文件、投标文件数。 */
export const DUPLICATE_CHECK_TENDER_FILES_MAX = 20;
export const DUPLICATE_CHECK_BID_FILES_MAX = 50;

/** 标书查重分析任务（第 6 步 6.10，src/duplicateCheck/job.ts）。 */
export const DUPLICATE_ANALYSIS_JOB_TYPE = 'duplicate-analysis';

/** 同一项目同时只有一个分析任务（与桌面版同组互斥相同）。 */
export function duplicateCheckLockKey(projectId: string): string {
  return `project:${projectId}:duplicate-check`;
}

/** 任务已结束（或不存在）而分析仍是 running 时的说明（与桌面版启动时恢复中断任务的文案相同）。 */
const STALE_ANALYSIS_MESSAGE = '上次标书查重分析未完成，请重新分析';

// ---- 读出的状态 ----

export interface DuplicateCheckFile {
  /** files.id。 */
  id: string;
  fileName: string;
  extension: string;
  size: number;
  uploadedAt: Date;
}

export interface SubTaskProgress {
  status: DuplicateCheckStatus;
  completed: number;
  total: number;
}

interface SectionBase {
  status: DuplicateCheckStatus;
  progress: number;
  message: string;
  signature: string | null;
  startedAt: Date | null;
  updatedAt: Date;
}

export interface MetadataItem {
  key: string;
  label: string;
  value: string;
  normalized: string | null;
  dateDay: string | null;
  comparable: boolean;
  dateComparable: boolean;
}

export interface MetadataFileResult {
  fileId: string;
  fileName: string;
  status: DuplicateCheckStatus;
  metadata: MetadataItem[];
  error: string | null;
}

export interface MetadataComparisonRow {
  key: string;
  label: string;
  values: Record<string, string>;
  duplicateFileIds: string[];
  sameDayFileIds: string[];
}

export interface ContentExtractionItem {
  fileId: string;
  fileName: string;
  status: DuplicateCheckStatus;
  /** 解析出的 Markdown（生成产物），经 /api/artifacts/:artifactId/content 读取。 */
  contentArtifactId: string | null;
  contentLength: number;
  parserLabel: string | null;
  error: string | null;
}

export interface MetadataAnalysis extends SectionBase {
  contentExtraction: SubTaskProgress;
  metadataExtraction: SubTaskProgress;
  files: MetadataFileResult[];
  rows: MetadataComparisonRow[];
  contentFiles: ContentExtractionItem[];
  logs: string[];
}

export interface OutlineItem {
  id: string;
  level: number;
  number: string | null;
  title: string;
  normalizedTitle: string;
  pathTitles: string[];
  normalizedPath: string;
  source: DuplicateCheckOutlineSource;
  confidence: number;
  order: number;
  parentId: string | null;
  fromTender: boolean;
  matchedTenderSentence: string | null;
  duplicateGroupIds: string[];
  similarGroupIds: string[];
}

export interface OutlineFileResult {
  fileId: string;
  fileName: string;
  status: DuplicateCheckStatus;
  source: DuplicateCheckOutlineSource | null;
  confidence: number;
  itemCount: number;
  tenderMatchedCount: number;
  items: OutlineItem[];
  error: string | null;
}

export interface OutlineGroup {
  id: string;
  type: DuplicateCheckGroupType;
  title: string;
  score: number;
  fileIds: string[];
  itemIds: Record<string, string[]>;
  paths: Record<string, string[]>;
}

export interface OutlinePairwiseSimilarity {
  fileAId: string;
  fileBId: string;
  score: number;
  titleOverlap: number;
  pathOverlap: number;
  orderSimilarity: number;
  sharedCount: number;
  risk: DuplicateCheckRisk;
}

export interface OutlineAnalysis extends SectionBase {
  tenderSentenceCount: number;
  tenderMatchedItemCount: number;
  extraction: SubTaskProgress;
  files: OutlineFileResult[];
  duplicateGroups: OutlineGroup[];
  pairwiseSimilarities: OutlinePairwiseSimilarity[];
}

export interface ContentSentence {
  id: string;
  sentence: string;
  normalized: string;
  fileIds: string[];
  occurrences: Record<string, number>;
  firstOrder: number;
}

export interface ContentAnalysis extends SectionBase {
  tenderSentenceCount: number;
  tenderMatchedSentenceCount: number;
  totalSentenceCount: number;
  extraction: SubTaskProgress;
  duplicateSentences: ContentSentence[];
}

export interface ImageFileResult {
  fileId: string;
  fileName: string;
  status: DuplicateCheckStatus;
  imageCount: number;
  uniqueImageCount: number;
  error: string | null;
}

export interface ImageLocation {
  imageIndex: number | null;
  directory: string;
  previousSentence: string;
}

export interface DuplicateImage {
  id: string;
  hash: string;
  /** 预览图（生成产物），经 /api/artifacts/:artifactId/content 读取。 */
  previewArtifactId: string | null;
  fileIds: string[];
  occurrences: Record<string, number>;
  locations: Record<string, ImageLocation[]>;
}

export interface ImageAnalysis extends SectionBase {
  extraction: SubTaskProgress;
  totalImageCount: number;
  files: ImageFileResult[];
  duplicateImages: DuplicateImage[];
}

export interface DuplicateCheckState {
  tenderFiles: DuplicateCheckFile[];
  bidFiles: DuplicateCheckFile[];
  step: DuplicateCheckStep;
  activeAnalysisTab: DuplicateCheckSection;
  /** 当前文件选择的签名；分析结果的 signature 与它不同即已失效。 */
  signature: string;
  /** 最近一次分析任务（jobs，与 GET /api/jobs/:jobId 相同的形式）；没有时为 null。 */
  analysisTask: JobBody | null;
  metadataAnalysis: MetadataAnalysis | null;
  outlineAnalysis: OutlineAnalysis | null;
  contentAnalysis: ContentAnalysis | null;
  imageAnalysis: ImageAnalysis | null;
}

export interface UiState {
  step: DuplicateCheckStep;
  activeAnalysisTab: DuplicateCheckSection;
}

// ---- 任务写入的分析结果 ----

interface SectionStateInput {
  status?: DuplicateCheckStatus;
  progress?: number;
  message?: string;
  /** 给出 null 时清除。 */
  signature?: string | null;
  /** 给出时写入（null 表示现在）；不给出时保留原值，没有原值时为现在。 */
  startedAt?: Date | null;
}

export interface SubTaskProgressInput {
  status?: DuplicateCheckStatus;
  completed?: number;
  total?: number;
}

export interface MetadataItemInput {
  key?: string;
  label?: string;
  value?: string;
  normalized?: string | null;
  dateDay?: string | null;
  comparable?: boolean;
  dateComparable?: boolean;
}

export interface MetadataFileInput {
  fileId?: string;
  status?: DuplicateCheckStatus;
  error?: string | null;
  metadata?: MetadataItemInput[];
}

export interface ContentFileInput {
  fileId?: string;
  status?: DuplicateCheckStatus;
  contentArtifactId?: string | null;
  contentLength?: number;
  parserLabel?: string | null;
  error?: string | null;
  /** 正文的哈希，写到选中文件上。 */
  contentHash?: string | null;
}

export interface MetadataAnalysisInput extends SectionStateInput {
  contentExtraction?: SubTaskProgressInput;
  metadataExtraction?: SubTaskProgressInput;
  logs?: string[];
  /** 给出时整体替换元数据项。 */
  files?: MetadataFileInput[];
  /** 给出时整体替换正文提取结果。 */
  contentFiles?: ContentFileInput[];
}

export interface OutlineItemInput {
  id?: string;
  parentId?: string | null;
  level?: number;
  number?: string | null;
  title?: string;
  normalizedTitle?: string;
  pathTitles?: string[];
  normalizedPath?: string;
  source?: DuplicateCheckOutlineSource;
  confidence?: number;
  order?: number;
  fromTender?: boolean;
  matchedTenderSentence?: string | null;
}

export interface OutlineFileInput {
  fileId?: string;
  status?: DuplicateCheckStatus;
  source?: DuplicateCheckOutlineSource | null;
  confidence?: number;
  itemCount?: number;
  tenderMatchedCount?: number;
  error?: string | null;
  items?: OutlineItemInput[];
}

export interface OutlineGroupInput {
  id?: string;
  type?: DuplicateCheckGroupType;
  title?: string;
  score?: number;
  fileIds?: string[];
  itemIds?: Record<string, string[]>;
  paths?: Record<string, string[]>;
}

export interface PairwiseInput {
  fileAId?: string;
  fileBId?: string;
  score?: number;
  titleOverlap?: number;
  pathOverlap?: number;
  orderSimilarity?: number;
  sharedCount?: number;
  risk?: DuplicateCheckRisk;
}

export interface OutlineAnalysisInput extends SectionStateInput {
  tenderSentenceCount?: number;
  tenderMatchedItemCount?: number;
  extraction?: SubTaskProgressInput;
  /** 给出时整体替换目录项，并更新每个文件的状态摘要。 */
  files?: OutlineFileInput[];
  duplicateGroups?: OutlineGroupInput[];
  pairwiseSimilarities?: PairwiseInput[];
}

export interface ContentSentenceInput {
  id?: string;
  sentence?: string;
  normalized?: string;
  fileIds?: string[];
  occurrences?: Record<string, number>;
  firstOrder?: number;
}

export interface ContentAnalysisInput extends SectionStateInput {
  tenderSentenceCount?: number;
  tenderMatchedSentenceCount?: number;
  totalSentenceCount?: number;
  extraction?: SubTaskProgressInput;
  duplicateSentences?: ContentSentenceInput[];
}

export interface ImageFileInput {
  fileId?: string;
  status?: DuplicateCheckStatus;
  imageCount?: number;
  uniqueImageCount?: number;
  error?: string | null;
}

export interface ImageLocationInput {
  imageIndex?: number | null;
  directory?: string;
  previousSentence?: string;
}

export interface DuplicateImageInput {
  id?: string;
  hash?: string;
  previewArtifactId?: string | null;
  fileIds?: string[];
  occurrences?: Record<string, number>;
  locations?: Record<string, ImageLocationInput[]>;
}

export interface ImageAnalysisInput extends SectionStateInput {
  extraction?: SubTaskProgressInput;
  totalImageCount?: number;
  files?: ImageFileInput[];
  duplicateImages?: DuplicateImageInput[];
}

export interface SectionInputs {
  metadata: MetadataAnalysisInput;
  outline: OutlineAnalysisInput;
  content: ContentAnalysisInput;
  image: ImageAnalysisInput;
}

// ---- 错误 ----

function fileUnavailable(cause?: unknown): AppError {
  return new AppError(
    400,
    'DUPLICATE_CHECK_FILE_UNAVAILABLE',
    '文件不存在、未上传完成、已删除、不是标书查重文件或已用于其他项目',
    cause === undefined ? undefined : { cause },
  );
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
  if (text.length === 0 || [...text].length > DUPLICATE_CHECK_KEY_MAX || text.includes('\u0000')) {
    throw new TypeError(`${what}不合法：${JSON.stringify(text.slice(0, DUPLICATE_CHECK_KEY_MAX))}`);
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

function score(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.min(number, DUPLICATE_CHECK_SCORE_MAX) : 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

const stripNul = (_key: string, value: unknown) => (typeof value === 'string' ? value.replaceAll('\u0000', '') : value);

/** 序列化存进 jsonb 的值：检查嵌套深度和大小，去掉 jsonb 不接受的 \u0000。 */
function json(value: unknown, maxBytes: number, what: string): string {
  const checked = serializeJsonObject(value as Record<string, unknown>, maxBytes);
  if (checked === 'too-deep' || checked === 'too-large') throw new TypeError(`${what}过大或嵌套过深`);
  return JSON.stringify(value, stripNul);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function stringArrayRecord(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([fileId, entries]) => [fileId, stringArray(entries)]));
}

function progress(value: unknown): number {
  return Math.max(0, Math.min(100, Math.round(Number(value ?? 0)) || 0));
}

function subTask(value: SubTaskProgressInput | undefined): SubTaskProgress {
  return {
    status: oneOf(value?.status, DUPLICATE_CHECK_STATUSES, 'pending'),
    completed: count(value?.completed),
    total: count(value?.total),
  };
}

/** 行数可能上万：分批插入，避免单条语句的参数超过 PostgreSQL 的上限（65535）。 */
async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  const size = 500;
  for (let start = 0; start < rows.length; start += size) await insert(rows.slice(start, start + size));
}

function emptyProgress(total: number): SubTaskProgress {
  return { status: 'pending', completed: 0, total };
}

/** 读出 stats 中的子任务进度（任务写入时已整理）。 */
function storedProgress(value: unknown, total: number): SubTaskProgress {
  if (!value || typeof value !== 'object') return emptyProgress(total);
  return subTask(value as SubTaskProgressInput);
}

// ---- 文件选择 ----

type Trx = Transaction<Database>;

/** 同一项目的文件选择和清空串行执行。 */
async function lockProject(trx: Trx, projectId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`duplicate_check:${projectId}`}, 0))`.execute(trx);
}

async function readFiles(trx: Trx, projectId: string): Promise<{ tenderFiles: DuplicateCheckFile[]; bidFiles: DuplicateCheckFile[] }> {
  const rows = await trx
    .selectFrom('duplicate_check_files as d')
    .innerJoin('files as f', 'f.id', 'd.file_id')
    .select(['d.file_id', 'd.role', 'f.display_name', 'f.extension', 'f.size_bytes', 'f.uploaded_at', 'f.created_at'])
    .where('d.project_id', '=', projectId)
    .orderBy('d.role')
    .orderBy('d.sort_order')
    .orderBy('d.file_id')
    .execute();
  const file = (row: (typeof rows)[number]): DuplicateCheckFile => ({
    id: row.file_id,
    fileName: row.display_name,
    extension: row.extension,
    size: Number(row.size_bytes ?? 0),
    uploadedAt: row.uploaded_at ?? row.created_at,
  });
  return {
    tenderFiles: rows.filter((row) => row.role === 'tender').map(file),
    bidFiles: rows.filter((row) => row.role === 'bid').map(file),
  };
}

/** 文件选择的签名（与桌面版 createSignature 相同按招标文件、投标文件的顺序，本地路径改为文件 id）。 */
export function selectionSignature(files: { tenderFiles: DuplicateCheckFile[]; bidFiles: DuplicateCheckFile[] }): string {
  const lines = [...files.tenderFiles, ...files.bidFiles].map((file) => `${file.id}|${file.size}|${file.uploadedAt.toISOString()}`);
  return createHash('sha1').update(lines.join('\n')).digest('hex');
}

async function readUiState(trx: Trx, projectId: string): Promise<UiState> {
  const row = await trx
    .selectFrom('duplicate_check_meta')
    .select(['step', 'active_analysis_tab'])
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  return { step: row?.step ?? 'upload', activeAnalysisTab: row?.active_analysis_tab ?? 'metadata' };
}

async function writeUiState(trx: Trx, context: TenantContext, projectId: string, patch: Partial<UiState>): Promise<void> {
  const set = {
    ...(patch.step ? { step: patch.step } : {}),
    ...(patch.activeAnalysisTab ? { active_analysis_tab: patch.activeAnalysisTab } : {}),
  };
  const query = trx.insertInto('duplicate_check_meta').values({ project_id: projectId, org_id: context.orgId, ...set });
  await (Object.keys(set).length
    ? query.onConflict((oc) => oc.column('project_id').doUpdateSet(set))
    : query.onConflict((oc) => oc.column('project_id').doNothing())
  ).execute();
}

/** 删除全部分析结果（与选中文件挂钩的结果随文件行级联删除，这里删其余的）。 */
async function clearAnalysis(trx: Trx, projectId: string): Promise<void> {
  for (const section of DUPLICATE_CHECK_SECTIONS) await clearSectionRows(trx, projectId, section);
}

async function clearSectionRows(trx: Trx, projectId: string, section: DuplicateCheckSection): Promise<void> {
  await trx.deleteFrom('duplicate_check_analysis_sections').where('project_id', '=', projectId).where('section', '=', section).execute();
  if (section === 'metadata') {
    await trx.deleteFrom('duplicate_check_content_files').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('duplicate_check_metadata_items').where('project_id', '=', projectId).execute();
    await trx.updateTable('duplicate_check_files').set({ content_hash: null }).where('project_id', '=', projectId).execute();
  } else if (section === 'outline') {
    await trx.deleteFrom('duplicate_check_outline_items').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('duplicate_check_outline_groups').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('duplicate_check_outline_pairwise').where('project_id', '=', projectId).execute();
  } else if (section === 'content') {
    // 出现次数随重复句级联删除。
    await trx.deleteFrom('duplicate_check_content_duplicates').where('project_id', '=', projectId).execute();
  } else {
    await trx.deleteFrom('duplicate_check_duplicate_images').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('duplicate_check_image_files').where('project_id', '=', projectId).execute();
  }
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

export interface SaveFilesInput {
  tenderFileIds: string[];
  bidFileIds: string[];
  step?: DuplicateCheckStep;
  activeAnalysisTab?: DuplicateCheckSection;
}

/**
 * 重新选择招标文件和投标文件（取代桌面版 saveFiles 与 selectDuplicateCheckFiles），按给出的顺序保存，并清空全部分析结果。
 * 文件挂到本项目（files.project_id）；从选择中去掉的文件软删除。文件不可用（不存在、其他组织的、未上传完成、已删除、
 * 用途不是标书查重、属于其他项目）时整体失败，返回 400。步骤、页签与桌面版相同，不给出时回到上传页、元数据页签。
 */
export async function saveFiles(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  input: SaveFilesInput,
): Promise<DuplicateCheckState> {
  const tenderIds = input.tenderFileIds.map((id) => id.toLowerCase());
  const bidIds = input.bidFileIds.map((id) => id.toLowerCase());
  const ids = [...tenderIds, ...bidIds];
  if (new Set(ids).size !== ids.length) throw fileUnavailable();
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const previous = await trx.selectFrom('duplicate_check_files').select('file_id').where('project_id', '=', projectId).execute();
    if (ids.length > 0) {
      // 挂到本项目。已属于其他项目的文件由触发器 files_project_guard 拒绝（FS005，迁移 0015：project_id 设置后不能再改）；
      // 能否选入由 duplicate_check_files 的 INSERT 策略检查，这里的条件只为给出明确的错误。
      let claimed;
      try {
        claimed = await trx
          .updateTable('files')
          .set({ project_id: projectId })
          .where('id', 'in', ids)
          .where('purpose', '=', 'duplicate-check')
          .where('status', '=', 'uploaded')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'FS005') throw fileUnavailable(error);
        throw error;
      }
      if (Number(claimed.numUpdatedRows) !== ids.length) throw fileUnavailable();
    }
    // 先删文件行（分析结果随之级联删除），再软删除去掉的文件：文件进回收站后其行不可见，删不到。
    await trx.deleteFrom('duplicate_check_files').where('project_id', '=', projectId).execute();
    await clearAnalysis(trx, projectId);
    const kept = new Set(ids);
    await trashFiles(
      trx,
      context,
      previous.map((row) => row.file_id).filter((id) => !kept.has(id)),
    );
    const rows = [
      ...tenderIds.map((fileId, index) => ({ role: 'tender' as DuplicateCheckFileRole, fileId, index })),
      ...bidIds.map((fileId, index) => ({ role: 'bid' as DuplicateCheckFileRole, fileId, index })),
    ].map(({ role, fileId, index }) => ({ file_id: fileId, org_id: context.orgId, project_id: projectId, role, sort_order: index }));
    if (rows.length > 0) {
      try {
        await trx.insertInto('duplicate_check_files').values(rows).execute();
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        // 42501：INSERT 策略拒绝（文件不可用）；23505：文件已被其他项目选中；23503：外键（其他组织的文件）。
        if (code === '42501' || code === '23505' || code === '23503') throw fileUnavailable(error);
        throw error;
      }
    }
    await writeUiState(trx, context, projectId, { step: input.step ?? 'upload', activeAnalysisTab: input.activeAnalysisTab ?? 'metadata' });
    return readState(trx, projectId);
  });
}

/** 保存页面步骤和分析页签（只写给出的字段）。 */
export async function saveUiState(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  patch: Partial<UiState>,
): Promise<UiState> {
  return withTenant(db, context, async (trx) => {
    await writeUiState(trx, context, projectId, patch);
    return readUiState(trx, projectId);
  });
}

/**
 * 清空标书查重（与桌面版 clear 相同）：删除文件选择和全部分析结果，页面回到上传步骤。选中的文件软删除（进回收站）。
 * 返回软删除的文件数。
 */
export async function clearDuplicateCheck(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<{ deletedFileCount: number }> {
  return withTenant(db, context, async (trx) => {
    await lockProject(trx, projectId);
    const previous = await trx.selectFrom('duplicate_check_files').select('file_id').where('project_id', '=', projectId).execute();
    await trx.deleteFrom('duplicate_check_files').where('project_id', '=', projectId).execute();
    await clearAnalysis(trx, projectId);
    const deletedFileCount = await trashFiles(
      trx,
      context,
      previous.map((row) => row.file_id),
    );
    await trx
      .updateTable('duplicate_check_meta')
      .set({ step: 'upload', active_analysis_tab: 'metadata' })
      .where('project_id', '=', projectId)
      .execute();
    return { deletedFileCount };
  });
}

// ---- 读取 ----

async function readSections(trx: Trx, projectId: string) {
  const rows = await trx.selectFrom('duplicate_check_analysis_sections').selectAll().where('project_id', '=', projectId).execute();
  return new Map(rows.map((row) => [row.section, row]));
}

type SectionRow = NonNullable<ReturnType<Awaited<ReturnType<typeof readSections>>['get']>>;

function sectionBase(row: SectionRow): SectionBase {
  return {
    status: oneOf(row.status, DUPLICATE_CHECK_STATUSES, 'pending'),
    progress: row.progress,
    message: row.message,
    signature: row.signature,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

interface StatsFileSummary {
  fileId?: string;
  status?: DuplicateCheckStatus;
  error?: string | null;
  source?: DuplicateCheckOutlineSource | null;
  confidence?: number;
  itemCount?: number;
  tenderMatchedCount?: number;
}

function statsFiles(stats: Record<string, unknown>): Map<string, StatsFileSummary> {
  const files = Array.isArray(stats.files) ? (stats.files as StatsFileSummary[]) : [];
  return new Map(files.filter((file) => file && typeof file.fileId === 'string').map((file) => [file.fileId!, file]));
}

/** 元数据对比表（与桌面版 buildRows 相同）：重复值、同一天的日期分别列出涉及的文件。 */
function buildRows(files: MetadataFileResult[]): MetadataComparisonRow[] {
  const keyOrder: string[] = [];
  const rowsByKey = new Map<string, MetadataComparisonRow>();
  for (const file of files) {
    for (const item of file.metadata) {
      let row = rowsByKey.get(item.key);
      if (!row) {
        keyOrder.push(item.key);
        row = { key: item.key, label: item.label, values: {}, duplicateFileIds: [], sameDayFileIds: [] };
        rowsByKey.set(item.key, row);
      }
      row.values[file.fileId] = item.value;
    }
  }
  for (const itemKey of keyOrder) {
    const row = rowsByKey.get(itemKey)!;
    const normalizedToFiles = new Map<string, string[]>();
    const dayToFiles = new Map<string, string[]>();
    for (const file of files) {
      const item = file.metadata.find((entry) => entry.key === itemKey);
      if (!item?.comparable || !item.normalized) continue;
      if (item.dateComparable) {
        if (!item.dateDay) continue;
        dayToFiles.set(item.dateDay, [...(dayToFiles.get(item.dateDay) ?? []), file.fileId]);
        continue;
      }
      normalizedToFiles.set(item.normalized, [...(normalizedToFiles.get(item.normalized) ?? []), file.fileId]);
    }
    const shared = (groups: Map<string, string[]>) => [...new Set([...groups.values()].filter((ids) => ids.length > 1).flat())];
    row.duplicateFileIds = shared(normalizedToFiles);
    row.sameDayFileIds = shared(dayToFiles);
  }
  return keyOrder.map((itemKey) => rowsByKey.get(itemKey)!);
}

async function readMetadataAnalysis(
  trx: Trx,
  projectId: string,
  row: SectionRow | undefined,
  bidFiles: DuplicateCheckFile[],
  fileNames: Map<string, string>,
): Promise<MetadataAnalysis | null> {
  if (!row) return null;
  const stats = row.stats;
  const contentFiles = (
    await trx.selectFrom('duplicate_check_content_files').selectAll().where('project_id', '=', projectId).orderBy('file_id').execute()
  ).map((item) => ({
    fileId: item.file_id,
    fileName: fileNames.get(item.file_id) ?? item.file_id,
    status: oneOf(item.status, DUPLICATE_CHECK_STATUSES, 'pending'),
    contentArtifactId: item.content_artifact_id,
    contentLength: item.content_length,
    parserLabel: item.parser_label,
    error: item.error,
  }));
  const items = await trx
    .selectFrom('duplicate_check_metadata_items')
    .selectAll()
    .where('project_id', '=', projectId)
    .orderBy('file_id')
    .orderBy('sort_order')
    .orderBy('key')
    .execute();
  const summaries = statsFiles(stats);
  const filesById = new Map<string, MetadataFileResult>();
  for (const file of bidFiles) {
    const summary = summaries.get(file.id);
    filesById.set(file.id, { fileId: file.id, fileName: file.fileName, status: oneOf(summary?.status, DUPLICATE_CHECK_STATUSES, 'pending'), metadata: [], error: summary?.error ?? null });
  }
  for (const item of items) {
    let file = filesById.get(item.file_id);
    if (!file) {
      const summary = summaries.get(item.file_id);
      file = {
        fileId: item.file_id,
        fileName: fileNames.get(item.file_id) ?? item.file_id,
        status: oneOf(summary?.status, DUPLICATE_CHECK_STATUSES, 'success'),
        metadata: [],
        error: summary?.error ?? null,
      };
      filesById.set(item.file_id, file);
    }
    file.metadata.push({
      key: item.key,
      label: item.label,
      value: item.value,
      normalized: item.normalized,
      dateDay: item.date_day,
      comparable: item.comparable,
      dateComparable: item.date_comparable,
    });
  }
  const files = [...filesById.values()];
  return {
    ...sectionBase(row),
    contentExtraction: storedProgress(stats.contentExtraction, contentFiles.length),
    metadataExtraction: storedProgress(stats.metadataExtraction, files.length),
    files,
    rows: buildRows(files),
    contentFiles,
    logs: stringArray(stats.logs),
  };
}

async function readOutlineAnalysis(trx: Trx, projectId: string, row: SectionRow | undefined, bidFiles: DuplicateCheckFile[]): Promise<OutlineAnalysis | null> {
  if (!row) return null;
  const stats = row.stats;
  const itemsByFile = new Map<string, OutlineItem[]>();
  const itemRows = await trx
    .selectFrom('duplicate_check_outline_items')
    .selectAll()
    .where('project_id', '=', projectId)
    .orderBy('file_id')
    .orderBy('sort_order')
    .orderBy('item_id')
    .execute();
  for (const item of itemRows) {
    const list = itemsByFile.get(item.file_id) ?? [];
    list.push({
      id: item.item_id,
      level: item.level,
      number: item.number,
      title: item.title,
      normalizedTitle: item.normalized_title,
      pathTitles: stringArray(item.path_titles),
      normalizedPath: item.normalized_path,
      source: item.source,
      confidence: item.confidence,
      order: item.sort_order,
      parentId: item.parent_item_id,
      fromTender: item.from_tender,
      matchedTenderSentence: item.matched_tender_sentence,
      duplicateGroupIds: [],
      similarGroupIds: [],
    });
    itemsByFile.set(item.file_id, list);
  }
  const duplicateGroups = (
    await trx.selectFrom('duplicate_check_outline_groups').selectAll().where('project_id', '=', projectId).orderBy('sort_order').orderBy('group_id').execute()
  ).map((group) => ({
    id: group.group_id,
    type: group.type,
    title: group.title,
    score: group.score,
    fileIds: stringArray(group.file_ids),
    itemIds: stringArrayRecord(group.item_ids),
    paths: stringArrayRecord(group.paths),
  }));
  // 每个目录项所在的重复组、相似组（与桌面版相同，由组反推）。
  for (const group of duplicateGroups) {
    for (const [fileId, itemIds] of Object.entries(group.itemIds)) {
      const items = itemsByFile.get(fileId) ?? [];
      for (const itemId of itemIds) {
        const item = items.find((entry) => entry.id === itemId);
        const field = group.type === 'similar' ? 'similarGroupIds' : 'duplicateGroupIds';
        if (item && !item[field].includes(group.id)) item[field].push(group.id);
      }
    }
  }
  const summaries = statsFiles(stats);
  const files = bidFiles.map((file) => {
    const summary = summaries.get(file.id);
    const items = itemsByFile.get(file.id) ?? [];
    return {
      fileId: file.id,
      fileName: file.fileName,
      status: oneOf(summary?.status, DUPLICATE_CHECK_STATUSES, items.length ? 'success' : 'pending'),
      source: summary?.source ?? items[0]?.source ?? null,
      confidence: score(summary?.confidence ?? items[0]?.confidence),
      itemCount: summary?.itemCount === undefined ? items.length : count(summary.itemCount),
      tenderMatchedCount: summary?.tenderMatchedCount === undefined ? items.filter((item) => item.fromTender).length : count(summary.tenderMatchedCount),
      items,
      error: summary?.error ?? null,
    };
  });
  const pairwiseSimilarities = (
    await trx
      .selectFrom('duplicate_check_outline_pairwise')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('score', 'desc')
      .orderBy('sort_order')
      .execute()
  ).map((item) => ({
    fileAId: item.file_a_id,
    fileBId: item.file_b_id,
    score: item.score,
    titleOverlap: item.title_overlap,
    pathOverlap: item.path_overlap,
    orderSimilarity: item.order_similarity,
    sharedCount: item.shared_count,
    risk: item.risk,
  }));
  return {
    ...sectionBase(row),
    tenderSentenceCount: count(stats.tenderSentenceCount),
    tenderMatchedItemCount: count(stats.tenderMatchedItemCount),
    extraction: storedProgress(stats.extraction, files.length),
    files,
    duplicateGroups,
    pairwiseSimilarities,
  };
}

async function readContentAnalysis(trx: Trx, projectId: string, row: SectionRow | undefined, bidFiles: DuplicateCheckFile[]): Promise<ContentAnalysis | null> {
  if (!row) return null;
  const stats = row.stats;
  const occurrences = new Map<string, Record<string, number>>();
  for (const item of await trx.selectFrom('duplicate_check_content_occurrences').selectAll().where('project_id', '=', projectId).execute()) {
    occurrences.set(item.duplicate_id, { ...occurrences.get(item.duplicate_id), [item.file_id]: item.occurrence_count });
  }
  const duplicateSentences = (
    await trx
      .selectFrom('duplicate_check_content_duplicates')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('first_order')
      .orderBy('duplicate_id')
      .execute()
  ).map((item) => ({
    id: item.duplicate_id,
    sentence: item.sentence,
    normalized: item.normalized,
    fileIds: stringArray(item.file_ids),
    occurrences: occurrences.get(item.duplicate_id) ?? {},
    firstOrder: item.first_order,
  }));
  return {
    ...sectionBase(row),
    tenderSentenceCount: count(stats.tenderSentenceCount),
    tenderMatchedSentenceCount: count(stats.tenderMatchedSentenceCount),
    totalSentenceCount: count(stats.totalSentenceCount),
    extraction: storedProgress(stats.extraction, bidFiles.length),
    duplicateSentences,
  };
}

function storedLocations(value: unknown): ImageLocation[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      imageIndex: Number.isFinite(Number(entry.imageIndex)) && entry.imageIndex !== null ? Number(entry.imageIndex) : null,
      directory: String(entry.directory ?? ''),
      previousSentence: String(entry.previousSentence ?? ''),
    }));
}

async function readImageAnalysis(
  trx: Trx,
  projectId: string,
  row: SectionRow | undefined,
  bidFiles: DuplicateCheckFile[],
  fileNames: Map<string, string>,
): Promise<ImageAnalysis | null> {
  if (!row) return null;
  const stats = row.stats;
  const files = (
    await trx.selectFrom('duplicate_check_image_files').selectAll().where('project_id', '=', projectId).orderBy('file_id').execute()
  ).map((item) => ({
    fileId: item.file_id,
    fileName: fileNames.get(item.file_id) ?? item.file_id,
    status: oneOf(item.status, DUPLICATE_CHECK_STATUSES, 'pending'),
    imageCount: item.image_count,
    uniqueImageCount: item.unique_image_count,
    error: item.error,
  }));
  const occurrences = new Map<string, Record<string, number>>();
  const locations = new Map<string, Record<string, ImageLocation[]>>();
  for (const item of await trx.selectFrom('duplicate_check_image_occurrences').selectAll().where('project_id', '=', projectId).execute()) {
    occurrences.set(item.image_id, { ...occurrences.get(item.image_id), [item.file_id]: item.occurrence_count });
    locations.set(item.image_id, { ...locations.get(item.image_id), [item.file_id]: storedLocations(item.locations) });
  }
  const duplicateImages = (
    await trx
      .selectFrom('duplicate_check_duplicate_images')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('sort_order')
      .orderBy('image_id')
      .execute()
  ).map((item) => ({
    id: item.image_id,
    hash: item.hash,
    previewArtifactId: item.preview_artifact_id,
    fileIds: stringArray(item.file_ids),
    occurrences: occurrences.get(item.image_id) ?? {},
    locations: locations.get(item.image_id) ?? {},
  }));
  return {
    ...sectionBase(row),
    extraction: storedProgress(stats.extraction, bidFiles.length),
    totalImageCount: count(stats.totalImageCount),
    files,
    duplicateImages,
  };
}

/** 分析仍是 running 而任务已结束或不存在（worker 崩溃且续跑次数用完等）：按未完成显示，只改读出的状态。暂停中的任务仍是 running。 */
function settleStale<T extends SectionBase>(analysis: T | null, task: JobRecord | undefined): T | null {
  if (!analysis || analysis.status !== 'running' || (task && !isFinalStatus(task.status))) return analysis;
  return { ...analysis, status: 'error', progress: 100, message: STALE_ANALYSIS_MESSAGE };
}

/** 在已设置上下文的事务中读取完整状态（与桌面版 loadState 相同）。 */
export async function readState(trx: Trx, projectId: string): Promise<DuplicateCheckState> {
  const files = await readFiles(trx, projectId);
  const ui = await readUiState(trx, projectId);
  const sections = await readSections(trx, projectId);
  const task = (await latestProjectJobs(trx, projectId, [DUPLICATE_ANALYSIS_JOB_TYPE])).get(DUPLICATE_ANALYSIS_JOB_TYPE);
  const fileNames = new Map([...files.tenderFiles, ...files.bidFiles].map((file) => [file.id, file.fileName]));
  return {
    ...files,
    ...ui,
    signature: selectionSignature(files),
    analysisTask: task ? jobBody(task) : null,
    metadataAnalysis: settleStale(await readMetadataAnalysis(trx, projectId, sections.get('metadata'), files.bidFiles, fileNames), task),
    outlineAnalysis: settleStale(await readOutlineAnalysis(trx, projectId, sections.get('outline'), files.bidFiles), task),
    contentAnalysis: settleStale(await readContentAnalysis(trx, projectId, sections.get('content'), files.bidFiles), task),
    imageAnalysis: settleStale(await readImageAnalysis(trx, projectId, sections.get('image'), files.bidFiles, fileNames), task),
  };
}

export async function loadDuplicateCheck(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<DuplicateCheckState> {
  return withTenant(db, context, (trx) => readState(trx, projectId));
}

export interface AnalysisInputs {
  tenderFiles: DuplicateCheckFile[];
  bidFiles: DuplicateCheckFile[];
  /** 当前文件选择的签名。 */
  signature: string;
  /** 四类分析各自的状态与签名（没有时不出现）。 */
  sections: Partial<Record<DuplicateCheckSection, { status: DuplicateCheckStatus; signature: string | null }>>;
}

/** 分析任务开始时读取的输入：文件选择、签名与四类分析的状态（不读分析结果）。 */
export async function readAnalysisInputs(db: Kysely<Database>, context: TenantContext, projectId: string): Promise<AnalysisInputs> {
  return withTenant(db, context, async (trx) => {
    const files = await readFiles(trx, projectId);
    const sections = await readSections(trx, projectId);
    return {
      ...files,
      signature: selectionSignature(files),
      sections: Object.fromEntries(
        [...sections.entries()].map(([section, row]) => [section, { status: oneOf(row.status, DUPLICATE_CHECK_STATUSES, 'pending'), signature: row.signature }]),
      ),
    };
  });
}

// ---- 任务写入 ----

/** 各类分析写进 stats 的字段（与桌面版 createSectionStatsPatch 相同：只合并给出的字段）。 */
function statsPatch(section: DuplicateCheckSection, analysis: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const copyCount = (field: string) => {
    if (hasOwn(analysis, field)) patch[field] = count(analysis[field]);
  };
  const copyProgress = (field: string) => {
    if (hasOwn(analysis, field)) patch[field] = subTask(analysis[field] as SubTaskProgressInput);
  };
  if (section === 'metadata') {
    copyProgress('contentExtraction');
    copyProgress('metadataExtraction');
    if (hasOwn(analysis, 'logs')) patch.logs = stringArray(analysis.logs).map((line) => taskText(line, DUPLICATE_CHECK_TEXT_MAX));
    if (hasOwn(analysis, 'files')) {
      patch.files = (analysis.files as MetadataFileInput[] | undefined ?? [])
        .filter((file) => file?.fileId)
        .map((file) => ({
          fileId: uuid(file.fileId, '文件 id'),
          status: oneOf(file.status, DUPLICATE_CHECK_STATUSES, 'pending'),
          error: optionalText(file.error, DUPLICATE_CHECK_TEXT_MAX),
        }));
    }
  } else if (section === 'outline') {
    copyCount('tenderSentenceCount');
    copyCount('tenderMatchedItemCount');
    copyProgress('extraction');
    if (hasOwn(analysis, 'files')) {
      patch.files = (analysis.files as OutlineFileInput[] | undefined ?? [])
        .filter((file) => file?.fileId)
        .map((file) => ({
          fileId: uuid(file.fileId, '文件 id'),
          status: oneOf(file.status, DUPLICATE_CHECK_STATUSES, 'pending'),
          source: file.source ? oneOf(file.source, DUPLICATE_CHECK_OUTLINE_SOURCES, 'semantic') : null,
          confidence: score(file.confidence),
          itemCount: count(file.itemCount ?? file.items?.length),
          tenderMatchedCount: count(file.tenderMatchedCount ?? file.items?.filter((item) => item?.fromTender).length),
          error: optionalText(file.error, DUPLICATE_CHECK_TEXT_MAX),
        }));
    }
  } else if (section === 'content') {
    copyCount('tenderSentenceCount');
    copyCount('tenderMatchedSentenceCount');
    copyCount('totalSentenceCount');
    copyProgress('extraction');
  } else {
    copyProgress('extraction');
    copyCount('totalImageCount');
  }
  return patch;
}

async function saveMetadataDetails(trx: Trx, context: TenantContext, projectId: string, analysis: MetadataAnalysisInput): Promise<void> {
  if (hasOwn(analysis, 'contentFiles')) {
    const items = (analysis.contentFiles ?? []).filter((item) => item?.fileId);
    const rows = items.map((item) => ({
      file_id: uuid(item.fileId, '文件 id'),
      org_id: context.orgId,
      project_id: projectId,
      status: oneOf(item.status, DUPLICATE_CHECK_STATUSES, 'pending'),
      content_artifact_id: optionalUuid(item.contentArtifactId, '正文产物 id'),
      content_length: count(item.contentLength),
      parser_label: optionalText(item.parserLabel, DUPLICATE_CHECK_PARSER_LABEL_MAX),
      error: optionalText(item.error, DUPLICATE_CHECK_TEXT_MAX),
    }));
    await trx.deleteFrom('duplicate_check_content_files').where('project_id', '=', projectId).execute();
    await trx.updateTable('duplicate_check_files').set({ content_hash: null }).where('project_id', '=', projectId).execute();
    await insertChunked(rows, (chunk) => trx.insertInto('duplicate_check_content_files').values(chunk).execute());
    for (const [index, item] of items.entries()) {
      const hash = optionalKey(item.contentHash, '正文哈希');
      if (hash) await trx.updateTable('duplicate_check_files').set({ content_hash: hash }).where('file_id', '=', rows[index]!.file_id).execute();
    }
  }
  if (hasOwn(analysis, 'files')) {
    const rows = (analysis.files ?? [])
      .filter((file) => file?.fileId)
      .flatMap((file) => {
        const fileId = uuid(file.fileId, '文件 id');
        return (file.metadata ?? [])
          .filter((item) => item?.key)
          .map((item, index) => ({
            org_id: context.orgId,
            project_id: projectId,
            file_id: fileId,
            key: key(item.key, '元数据键'),
            label: taskText(item.label || item.key, DUPLICATE_CHECK_TITLE_MAX),
            value: taskText(item.value ?? '', DUPLICATE_CHECK_TEXT_MAX),
            normalized: optionalText(item.normalized, DUPLICATE_CHECK_TEXT_MAX),
            date_day: optionalText(item.dateDay, 32),
            comparable: Boolean(item.comparable),
            date_comparable: Boolean(item.dateComparable),
            sort_order: index,
          }));
      });
    await trx.deleteFrom('duplicate_check_metadata_items').where('project_id', '=', projectId).execute();
    await insertChunked(rows, (chunk) => trx.insertInto('duplicate_check_metadata_items').values(chunk).execute());
  }
}

async function saveOutlineDetails(trx: Trx, context: TenantContext, projectId: string, analysis: OutlineAnalysisInput): Promise<void> {
  if (hasOwn(analysis, 'files')) {
    const rows = (analysis.files ?? [])
      .filter((file) => file?.fileId)
      .flatMap((file) => {
        const fileId = uuid(file.fileId, '文件 id');
        const items = (file.items ?? []).filter((item) => item?.id);
        const ids = items.map((item) => key(item.id, '目录项 id'));
        if (new Set(ids).size !== ids.length) throw new TypeError('目录项 id 重复');
        const known = new Set(ids);
        return items.map((item, index) => {
          const parentId = optionalKey(item.parentId, '父目录项 id');
          if (parentId !== null && !known.has(parentId)) throw new TypeError(`父目录项不存在：${parentId}`);
          return {
            org_id: context.orgId,
            project_id: projectId,
            file_id: fileId,
            item_id: ids[index]!,
            parent_item_id: parentId,
            level: Math.min(Math.max(count(item.level) || 1, 1), DUPLICATE_CHECK_LEVEL_MAX),
            number: optionalText(item.number, DUPLICATE_CHECK_KEY_MAX),
            title: taskText(item.title, DUPLICATE_CHECK_TITLE_MAX),
            normalized_title: taskText(item.normalizedTitle, DUPLICATE_CHECK_TITLE_MAX),
            path_titles: json(stringArray(item.pathTitles), DUPLICATE_CHECK_PATH_MAX_BYTES, '目录路径'),
            normalized_path: taskText(item.normalizedPath, DUPLICATE_CHECK_TEXT_MAX),
            source: oneOf(item.source ?? file.source, DUPLICATE_CHECK_OUTLINE_SOURCES, 'semantic'),
            confidence: score(item.confidence ?? file.confidence),
            sort_order: count(item.order),
            from_tender: Boolean(item.fromTender),
            matched_tender_sentence: optionalText(item.matchedTenderSentence, DUPLICATE_CHECK_TEXT_MAX),
          };
        });
      });
    await trx.deleteFrom('duplicate_check_outline_items').where('project_id', '=', projectId).execute();
    await insertChunked(rows, (chunk) => trx.insertInto('duplicate_check_outline_items').values(chunk).execute());
  }
  if (hasOwn(analysis, 'duplicateGroups')) {
    const groups = (analysis.duplicateGroups ?? []).filter((group) => group?.id);
    const rows = groups.map((group, index) => ({
      org_id: context.orgId,
      project_id: projectId,
      group_id: key(group.id, '目录组 id'),
      type: oneOf(group.type, DUPLICATE_CHECK_GROUP_TYPES, 'duplicate'),
      title: taskText(group.title, DUPLICATE_CHECK_TITLE_MAX),
      score: score(group.score),
      file_ids: json(stringArray(group.fileIds), DUPLICATE_CHECK_JSON_MAX_BYTES, '目录组文件'),
      item_ids: json(stringArrayRecord(group.itemIds), DUPLICATE_CHECK_JSON_MAX_BYTES, '目录组条目'),
      paths: json(stringArrayRecord(group.paths), DUPLICATE_CHECK_JSON_MAX_BYTES, '目录组路径'),
      sort_order: index,
    }));
    if (new Set(rows.map((row) => row.group_id)).size !== rows.length) throw new TypeError('目录组 id 重复');
    await trx.deleteFrom('duplicate_check_outline_groups').where('project_id', '=', projectId).execute();
    await insertChunked(rows, (chunk) => trx.insertInto('duplicate_check_outline_groups').values(chunk).execute());
  }
  if (hasOwn(analysis, 'pairwiseSimilarities')) {
    const rows = (analysis.pairwiseSimilarities ?? [])
      .filter((item) => item?.fileAId && item?.fileBId)
      .map((item, index) => ({
        org_id: context.orgId,
        project_id: projectId,
        file_a_id: uuid(item.fileAId, '文件 id'),
        file_b_id: uuid(item.fileBId, '文件 id'),
        score: score(item.score),
        title_overlap: score(item.titleOverlap),
        path_overlap: score(item.pathOverlap),
        order_similarity: score(item.orderSimilarity),
        shared_count: count(item.sharedCount),
        risk: oneOf(item.risk, DUPLICATE_CHECK_RISKS, 'none'),
        sort_order: index,
      }));
    await trx.deleteFrom('duplicate_check_outline_pairwise').where('project_id', '=', projectId).execute();
    await insertChunked(rows, (chunk) => trx.insertInto('duplicate_check_outline_pairwise').values(chunk).execute());
  }
}

/** 出现次数：按文件 id 给出，次数取非负整数。 */
function occurrenceEntries(value: unknown): [string, number][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([fileId, occurrences]) => [uuid(fileId, '文件 id'), count(occurrences)]);
}

async function saveContentDetails(trx: Trx, context: TenantContext, projectId: string, analysis: ContentAnalysisInput): Promise<void> {
  if (!hasOwn(analysis, 'duplicateSentences')) return;
  const sentences = analysis.duplicateSentences ?? [];
  const rows = sentences.map((item, index) => ({
    org_id: context.orgId,
    project_id: projectId,
    // 没有 id 时按顺序编为 C000001（与桌面版相同）。
    duplicate_id: key(item?.id || `C${String(index + 1).padStart(6, '0')}`, '重复句 id'),
    sentence: taskText(item?.sentence, DUPLICATE_CHECK_SENTENCE_MAX),
    normalized: taskText(item?.normalized, DUPLICATE_CHECK_SENTENCE_MAX),
    file_ids: json(stringArray(item?.fileIds), DUPLICATE_CHECK_JSON_MAX_BYTES, '重复句文件'),
    first_order: count(item?.firstOrder ?? index),
  }));
  if (new Set(rows.map((row) => row.duplicate_id)).size !== rows.length) throw new TypeError('重复句 id 重复');
  const occurrences = sentences.flatMap((item, index) =>
    occurrenceEntries(item?.occurrences).map(([fileId, occurrenceCount]) => ({
      org_id: context.orgId,
      project_id: projectId,
      duplicate_id: rows[index]!.duplicate_id,
      file_id: fileId,
      occurrence_count: occurrenceCount,
    })),
  );
  await trx.deleteFrom('duplicate_check_content_duplicates').where('project_id', '=', projectId).execute();
  await insertChunked(rows, (chunk) => trx.insertInto('duplicate_check_content_duplicates').values(chunk).execute());
  await insertChunked(occurrences, (chunk) => trx.insertInto('duplicate_check_content_occurrences').values(chunk).execute());
}

function locationRows(value: unknown): Record<string, ImageLocation[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([fileId, entries]) => [
      fileId,
      (Array.isArray(entries) ? entries : []).map((entry: ImageLocationInput) => ({
        imageIndex: Number.isFinite(Number(entry?.imageIndex)) && entry?.imageIndex !== null ? Number(entry.imageIndex) : null,
        directory: taskText(entry?.directory, DUPLICATE_CHECK_TEXT_MAX),
        previousSentence: taskText(entry?.previousSentence, DUPLICATE_CHECK_TEXT_MAX),
      })),
    ]),
  );
}

async function saveImageDetails(trx: Trx, context: TenantContext, projectId: string, analysis: ImageAnalysisInput): Promise<void> {
  if (hasOwn(analysis, 'files')) {
    const rows = (analysis.files ?? [])
      .filter((file) => file?.fileId)
      .map((file) => ({
        file_id: uuid(file.fileId, '文件 id'),
        org_id: context.orgId,
        project_id: projectId,
        status: oneOf(file.status, DUPLICATE_CHECK_STATUSES, 'pending'),
        image_count: count(file.imageCount),
        unique_image_count: count(file.uniqueImageCount),
        error: optionalText(file.error, DUPLICATE_CHECK_TEXT_MAX),
      }));
    await trx.deleteFrom('duplicate_check_image_files').where('project_id', '=', projectId).execute();
    await insertChunked(rows, (chunk) => trx.insertInto('duplicate_check_image_files').values(chunk).execute());
  }
  if (hasOwn(analysis, 'duplicateImages')) {
    const images = analysis.duplicateImages ?? [];
    const rows = images.map((item, index) => ({
      org_id: context.orgId,
      project_id: projectId,
      // 没有 id 时按顺序编为 I000001（与桌面版相同）。
      image_id: key(item?.id || `I${String(index + 1).padStart(6, '0')}`, '重复图片 id'),
      hash: key(item?.hash, '图片哈希'),
      preview_artifact_id: optionalUuid(item?.previewArtifactId, '预览图产物 id'),
      file_ids: json(stringArray(item?.fileIds), DUPLICATE_CHECK_JSON_MAX_BYTES, '重复图片文件'),
      sort_order: index,
    }));
    if (new Set(rows.map((row) => row.image_id)).size !== rows.length) throw new TypeError('重复图片 id 重复');
    const occurrences = images.flatMap((item, index) => {
      const locations = locationRows(item?.locations);
      return occurrenceEntries(item?.occurrences).map(([fileId, occurrenceCount]) => ({
        org_id: context.orgId,
        project_id: projectId,
        image_id: rows[index]!.image_id,
        file_id: fileId,
        occurrence_count: occurrenceCount,
        locations: json(locations[fileId] ?? [], DUPLICATE_CHECK_JSON_MAX_BYTES, '图片位置'),
      }));
    });
    await trx.deleteFrom('duplicate_check_duplicate_images').where('project_id', '=', projectId).execute();
    await insertChunked(rows, (chunk) => trx.insertInto('duplicate_check_duplicate_images').values(chunk).execute());
    await insertChunked(occurrences, (chunk) => trx.insertInto('duplicate_check_image_occurrences').values(chunk).execute());
  }
}

/**
 * 写入一类分析的状态与结果（取代桌面版 updateState 中的 metadataAnalysis / outlineAnalysis / contentAnalysis / imageAnalysis）：
 * 状态、进度、说明、签名、开始时间只写给出的字段，统计按字段合并；结果字段（files、contentFiles、duplicateGroups 等）
 * 给出时整体替换。analysis 为 null 时删除这一类的状态和全部结果。分析结果引用的文件必须是当前选中的文件，
 * 否则被 RLS 拒绝（文件选择已变化时任务的写入失败）。
 * options.expectedSignature（任务开始时的文件选择签名）：在同一事务中与当前签名核对，不同时不写入、返回 false
 * （与桌面版 updateAnalysisField 的签名检查相同）。其余情况返回 true。
 */
export async function saveAnalysisSection<S extends DuplicateCheckSection>(
  db: Kysely<Database>,
  context: TenantContext,
  projectId: string,
  section: S,
  analysis: SectionInputs[S] | null,
  options: { expectedSignature?: string } = {},
): Promise<boolean> {
  if (!(DUPLICATE_CHECK_SECTIONS as readonly string[]).includes(section)) throw new TypeError(`分析类型不合法：${section}`);
  return withTenant(db, context, async (trx) => {
    // 与文件选择、清空串行：重新选择文件时进行中的写入要么在其之前完成，要么之后因文件已不在选择中被拒绝。
    await lockProject(trx, projectId);
    if (options.expectedSignature !== undefined && selectionSignature(await readFiles(trx, projectId)) !== options.expectedSignature) return false;
    if (!analysis) {
      await clearSectionRows(trx, projectId, section);
      return true;
    }
    const input = analysis as SectionStateInput & Record<string, unknown>;
    const existing = await trx
      .selectFrom('duplicate_check_analysis_sections')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('section', '=', section)
      .executeTakeFirst();
    const stats = json({ ...(existing?.stats ?? {}), ...statsPatch(section, input) }, DUPLICATE_CHECK_JSON_MAX_BYTES, '分析统计');
    const values = {
      status: hasOwn(input, 'status') ? oneOf(input.status, DUPLICATE_CHECK_STATUSES, 'pending') : (existing?.status ?? 'pending'),
      progress: hasOwn(input, 'progress') ? progress(input.progress) : (existing?.progress ?? 0),
      message: hasOwn(input, 'message') ? taskText(input.message, DUPLICATE_CHECK_TITLE_MAX) : (existing?.message ?? ''),
      signature: hasOwn(input, 'signature') ? optionalKey(input.signature, '分析签名') : (existing?.signature ?? null),
      stats,
      started_at: hasOwn(input, 'startedAt') ? (input.startedAt ?? new Date()) : (existing?.started_at ?? new Date()),
    };
    if (existing) {
      await trx
        .updateTable('duplicate_check_analysis_sections')
        .set(values)
        .where('project_id', '=', projectId)
        .where('section', '=', section)
        .execute();
    } else {
      await trx
        .insertInto('duplicate_check_analysis_sections')
        .values({ org_id: context.orgId, project_id: projectId, section, ...values })
        .execute();
    }
    if (section === 'metadata') await saveMetadataDetails(trx, context, projectId, analysis as MetadataAnalysisInput);
    else if (section === 'outline') await saveOutlineDetails(trx, context, projectId, analysis as OutlineAnalysisInput);
    else if (section === 'content') await saveContentDetails(trx, context, projectId, analysis as ContentAnalysisInput);
    else await saveImageDetails(trx, context, projectId, analysis as ImageAnalysisInput);
    return true;
  });
}
