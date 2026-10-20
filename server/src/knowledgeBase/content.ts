// 知识库文档准备产物的读写（迁移 0013_knowledge_base_items）：切块、候选条目、最终条目及其来源块、舍弃块组、
// 分析报告、匹配批次，以及面向用户的检索、读取条目 / 分析 / Markdown。组织和用户一律来自 TenantContext，
// 所有查询都经 withTenant。
//
// 可见性与删除可见性由 RLS 保证，这里不判断：七张表都随文档可见，原件已删除时查不到、改不了、不能新写。
// 写法与桌面版 knowledgeBaseStore.cjs 相同“整体替换”：先删除文档的旧结果，再按给出的顺序写入，同时更新文档上的计数；
// 只有匹配批次按批更新状态。写函数给第 6 步的解析任务用，参数不合法（id 为空或重复、正文超长等）是调用方的程序错误，
// 抛 TypeError；AI 生成的标题、摘要、原因等文本超长时截短，不让任务失败。
import type { Readable } from 'node:stream';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { KNOWLEDGE_ERROR_MAX } from '../db/migrations/0012_knowledge_base.ts';
import {
  KNOWLEDGE_CONTENT_MAX,
  KNOWLEDGE_HEADING_PATH_MAX_BYTES,
  KNOWLEDGE_JSON_MAX_BYTES,
  KNOWLEDGE_KEY_MAX,
  KNOWLEDGE_RATE_MAX,
  KNOWLEDGE_REASON_MAX,
  KNOWLEDGE_SOURCE_FILE_MAX,
  KNOWLEDGE_SUMMARY_MAX,
  KNOWLEDGE_TITLE_MAX,
} from '../db/migrations/0013_knowledge_base_items.ts';
import type { Database, KnowledgeMatchBatchesTable, KnowledgeStepStatus } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { serializeJsonObject } from '../jsonObject.ts';
import { clearFinalResult, readDocument, taskText, type KnowledgeDocument } from './store.ts';

/** 检索每页的条数（与桌面版相同）。 */
export const KNOWLEDGE_SEARCH_PAGE_SIZE = 100;
/** 检索关键词的字数上限。 */
export const KNOWLEDGE_SEARCH_KEYWORD_MAX = 200;
/** 检索结果摘录的长度（与桌面版相同）。 */
const SNIPPET_LENGTH = 180;
/** 正文命中时只取命中位置前后这么多字交给摘录，不把整段正文读出来。 */
const SNIPPET_WINDOW = 1000;

// ---- 类型 ----

export interface KnowledgeBlock {
  id: string;
  type: string;
  headingPath: string[];
  content: string;
  /** 只有筛除的块有筛除原因。 */
  reason?: string;
}

export interface BlockInput {
  id?: string;
  type?: string;
  headingPath?: string[];
  content?: string;
}

export interface FilteredBlockInput extends BlockInput {
  reason?: string | null;
}

export interface KnowledgeCandidateItem {
  id: string;
  title: string;
  summary: string;
}

export interface CandidateItemInput {
  id?: string;
  title?: string;
  summary?: string;
  source?: string | null;
}

export interface KnowledgeItem {
  id: string;
  title: string;
  resume: string;
  content: string;
  sourceBlockIds: string[];
  sourceFile: string | null;
}

export interface FinalItemInput {
  id?: string;
  title?: string;
  resume?: string;
  content?: string;
  sourceBlockIds?: string[];
  sourceFile?: string | null;
}

export interface DiscardedGroup {
  blockIds: string[];
  reason: string;
}

export interface DiscardedGroupInput {
  blockIds?: string[];
  reason?: string;
}

export interface KnowledgeReport {
  totalBlocks: number;
  filteredBlocksCount: number;
  candidateItemsCount: number;
  finalItemsCount: number;
  matchedBlocksCount: number;
  discardedBlocksCount: number;
  systemDiscardedAfterRetryCount: number;
  newItemsFromRecoveryCount: number;
  recoveryAttemptCount: number;
  batchSize: number;
  coverageRate: number;
  matchedRate: number;
  createdAt: Date;
}

export type ReportInput = Partial<Omit<KnowledgeReport, 'createdAt'>>;

export interface KnowledgeMatchBatch {
  documentId: string;
  batchIndex: number;
  status: KnowledgeStepStatus;
  /** 本批的指纹（{ block_ids, item_ids } 对象或数组），由任务解释。 */
  itemIds: unknown;
  matches: unknown[];
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface KnowledgeSearchResult {
  documentId: string;
  folderId: string;
  folderName: string;
  fileName: string;
  itemId: string;
  title: string;
  resume: string;
  snippet: string;
  matchField: 'title' | 'resume' | 'content' | 'file_name';
}

export interface KnowledgeSearchPage {
  items: KnowledgeSearchResult[];
  total: number;
  page: number;
  pageSize: number;
}

export interface KnowledgeAnalysis {
  document: KnowledgeDocument;
  blockCount: number;
  filteredBlocksCount: number;
  markdownChars: number;
  keptBlockChars: number;
  coveredUniqueContentChars: number;
  coverageRateVsMarkdown: number;
  candidateItems: KnowledgeCandidateItem[];
  report: KnowledgeReport | null;
  discarded: DiscardedGroup[];
  systemDiscardedAfterRetry: DiscardedGroup[];
}

// ---- 输入整理 ----

/** 去掉空白后的字数（与桌面版 getContentCharCount 相同：按 UTF-16 码元计数）。 */
export function contentCharCount(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function key(value: unknown, what: string): string {
  const text = String(value ?? '');
  if (text.length === 0 || [...text].length > KNOWLEDGE_KEY_MAX || text.includes('\u0000')) {
    throw new TypeError(`${what}不合法：${JSON.stringify(text.slice(0, KNOWLEDGE_KEY_MAX))}`);
  }
  return text;
}

function content(value: unknown, what: string): string {
  const text = String(value ?? '').replaceAll('\u0000', '');
  if ([...text].length > KNOWLEDGE_CONTENT_MAX) throw new TypeError(`${what}过长`);
  return text;
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

function assertUnique(ids: string[], what: string): void {
  if (new Set(ids).size !== ids.length) throw new TypeError(`${what}重复`);
}

function count(value: unknown): number {
  const number = Math.round(Number(value ?? 0));
  return Number.isFinite(number) && number > 0 ? Math.min(number, 2_147_483_647) : 0;
}

function rate(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.min(number, KNOWLEDGE_RATE_MAX) : 0;
}

/** 行数可能上万：分批插入，避免单条语句的参数超过 PostgreSQL 的上限（65535）。 */
async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  const size = 500;
  for (let start = 0; start < rows.length; start += size) await insert(rows.slice(start, start + size));
}

// ---- 切块 ----

/**
 * 整体替换文档的有效块和筛除块，并写入文档的 block_count、filtered_block_count（与桌面版 saveBlocks 相同）。
 * 没有 id 的块按顺序编为 P000001 / F000001，没有类型的是 paragraph。
 */
export async function saveBlocks(
  db: Kysely<Database>,
  context: TenantContext,
  documentId: string,
  blocks: BlockInput[],
  filteredBlocks: FilteredBlockInput[],
): Promise<void> {
  const rows = [
    ...blocks.map((block, index) => blockRow(context, documentId, block, index, false)),
    ...filteredBlocks.map((block, index) => blockRow(context, documentId, block, index, true)),
  ];
  assertUnique(blocks.map((_, index) => rows[index]!.block_id), '块 id ');
  assertUnique(rows.slice(blocks.length).map((row) => row.block_id), '筛除块 id ');
  await withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    await trx.deleteFrom('knowledge_blocks').where('document_id', '=', documentId).execute();
    await insertChunked(rows, (chunk) => trx.insertInto('knowledge_blocks').values(chunk).execute());
    await trx
      .updateTable('knowledge_documents')
      .set({ block_count: blocks.length, filtered_block_count: filteredBlocks.length })
      .where('id', '=', documentId)
      .execute();
  });
}

function blockRow(context: TenantContext, documentId: string, block: FilteredBlockInput, index: number, filtered: boolean) {
  const text = content(block.content, '块正文');
  return {
    org_id: context.orgId,
    document_id: documentId,
    block_id: key(block.id ?? `${filtered ? 'F' : 'P'}${String(index + 1).padStart(6, '0')}`, '块 id'),
    type: key(block.type || 'paragraph', '块类型'),
    heading_path: json(stringArray(block.headingPath), KNOWLEDGE_HEADING_PATH_MAX_BYTES, '标题路径'),
    content: text,
    content_chars: contentCharCount(text),
    is_filtered: filtered,
    filter_reason: filtered ? taskText(String(block.reason ?? ''), KNOWLEDGE_REASON_MAX) : null,
    sort_order: index,
  };
}

/** 文档的有效块（filtered 为 true 时是筛除块），按顺序。文档不可见时 404。 */
export async function readBlocks(
  db: Kysely<Database>,
  context: TenantContext,
  documentId: string,
  options: { filtered?: boolean } = {},
): Promise<KnowledgeBlock[]> {
  const filtered = options.filtered === true;
  return withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    const rows = await trx
      .selectFrom('knowledge_blocks')
      .select(['block_id', 'type', 'heading_path', 'content', 'filter_reason'])
      .where('document_id', '=', documentId)
      .where('is_filtered', '=', filtered)
      .orderBy('sort_order')
      .orderBy('block_id')
      .execute();
    return rows.map((row) => ({
      id: row.block_id,
      type: row.type,
      headingPath: row.heading_path,
      content: row.content,
      ...(filtered ? { reason: row.filter_reason ?? '' } : {}),
    }));
  });
}

// ---- 候选条目 ----

function candidateRows(context: TenantContext, documentId: string, items: CandidateItemInput[], source: string | null) {
  // 与桌面版相同：没有 id 的候选条目跳过。
  const rows = items
    .filter((item) => item.id !== undefined && item.id !== '')
    .map((item, index) => ({
      org_id: context.orgId,
      document_id: documentId,
      item_id: key(item.id, '候选条目 id'),
      title: taskText(String(item.title ?? ''), KNOWLEDGE_TITLE_MAX),
      summary: taskText(String(item.summary ?? ''), KNOWLEDGE_SUMMARY_MAX),
      source: item.source ? key(item.source, '候选条目来源') : source,
      sort_order: index,
    }));
  assertUnique(
    rows.map((row) => row.item_id),
    '候选条目 id ',
  );
  return rows;
}

async function replaceCandidates(trx: Transaction<Database>, documentId: string, rows: ReturnType<typeof candidateRows>): Promise<void> {
  await trx.deleteFrom('knowledge_candidate_items').where('document_id', '=', documentId).execute();
  await insertChunked(rows, (chunk) => trx.insertInto('knowledge_candidate_items').values(chunk).execute());
}

/** 整体替换文档的候选条目，并写入文档的 candidate_item_count（与桌面版 saveCandidateItems 相同）。 */
export async function saveCandidateItems(
  db: Kysely<Database>,
  context: TenantContext,
  documentId: string,
  items: CandidateItemInput[],
  source: string | null = null,
): Promise<void> {
  const rows = candidateRows(context, documentId, items, source === null ? null : key(source, '候选条目来源'));
  await withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    await replaceCandidates(trx, documentId, rows);
    await trx.updateTable('knowledge_documents').set({ candidate_item_count: items.length }).where('id', '=', documentId).execute();
  });
}

async function selectCandidates(trx: Transaction<Database>, documentId: string): Promise<KnowledgeCandidateItem[]> {
  const rows = await trx
    .selectFrom('knowledge_candidate_items')
    .select(['item_id', 'title', 'summary'])
    .where('document_id', '=', documentId)
    .orderBy('sort_order')
    .orderBy('item_id')
    .execute();
  return rows.map((row) => ({ id: row.item_id, title: row.title, summary: row.summary }));
}

/** 文档的候选条目，按顺序。文档不可见时 404。 */
export async function readCandidateItems(db: Kysely<Database>, context: TenantContext, documentId: string): Promise<KnowledgeCandidateItem[]> {
  return withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    return selectCandidates(trx, documentId);
  });
}

// ---- 匹配结果 ----

export interface MatchResultInput {
  candidateItems: CandidateItemInput[];
  finalItems: FinalItemInput[];
  /** AI 建议舍弃的块组。 */
  discarded?: DiscardedGroupInput[];
  /** 系统重试后舍弃的块组。 */
  systemDiscardedAfterRetry?: DiscardedGroupInput[];
  /** 没有报告时删除旧报告。 */
  report?: ReportInput | null;
}

/**
 * 保存匹配结果（与桌面版 saveMatchResult 相同，同一事务）：整体替换候选条目（来源记为 merged）、最终条目及其来源块、
 * 舍弃块组和报告，并写入文档的条目数、候选条目数、舍弃块数。没有 id 的最终条目跳过，同一条目的重复来源块只记一次。
 */
export async function saveMatchResult(db: Kysely<Database>, context: TenantContext, documentId: string, input: MatchResultInput): Promise<void> {
  const candidates = candidateRows(context, documentId, input.candidateItems, 'merged');
  const items = input.finalItems
    .filter((item) => item.id !== undefined && item.id !== '')
    .map((item, index) => {
      const text = content(item.content, '条目正文');
      return {
        org_id: context.orgId,
        document_id: documentId,
        item_id: key(item.id, '条目 id'),
        title: taskText(String(item.title ?? ''), KNOWLEDGE_TITLE_MAX),
        resume: taskText(String(item.resume ?? ''), KNOWLEDGE_SUMMARY_MAX),
        content: text,
        source_file: item.sourceFile ? taskText(String(item.sourceFile), KNOWLEDGE_SOURCE_FILE_MAX) : null,
        content_chars: contentCharCount(text),
        sort_order: index,
      };
    });
  assertUnique(
    items.map((item) => item.item_id),
    '条目 id ',
  );
  const itemBlocks = input.finalItems
    .filter((item) => item.id !== undefined && item.id !== '')
    .flatMap((item) => {
      const blockIds = [...new Set(stringArray(item.sourceBlockIds))];
      return blockIds.map((blockId, index) => ({
        org_id: context.orgId,
        document_id: documentId,
        item_id: String(item.id),
        block_id: key(blockId, '来源块 id'),
        sort_order: index,
      }));
    });
  const groups = [
    ...(input.discarded ?? []).map((group) => ({ source: 'ai' as const, reason: group.reason || 'AI 建议舍弃', blockIds: group.blockIds })),
    ...(input.systemDiscardedAfterRetry ?? []).map((group) => ({
      source: 'system' as const,
      reason: group.reason || 'system_discarded_after_retry',
      blockIds: group.blockIds,
    })),
  ].map((group, index) => ({
    org_id: context.orgId,
    document_id: documentId,
    source: group.source,
    reason: taskText(String(group.reason), KNOWLEDGE_REASON_MAX),
    block_ids: json(stringArray(group.blockIds), KNOWLEDGE_JSON_MAX_BYTES, '舍弃块组'),
    sort_order: index,
  }));
  const report = input.report ?? null;

  await withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    await replaceCandidates(trx, documentId, candidates);
    await clearFinalResult(trx, documentId);
    await insertChunked(items, (chunk) => trx.insertInto('knowledge_items').values(chunk).execute());
    await insertChunked(itemBlocks, (chunk) => trx.insertInto('knowledge_item_blocks').values(chunk).execute());
    await insertChunked(groups, (chunk) => trx.insertInto('knowledge_discarded_groups').values(chunk).execute());
    if (report) {
      await trx
        .insertInto('knowledge_reports')
        .values({
          org_id: context.orgId,
          document_id: documentId,
          total_blocks: count(report.totalBlocks),
          filtered_blocks_count: count(report.filteredBlocksCount),
          candidate_items_count: count(report.candidateItemsCount),
          final_items_count: count(report.finalItemsCount),
          matched_blocks_count: count(report.matchedBlocksCount),
          discarded_blocks_count: count(report.discardedBlocksCount),
          system_discarded_after_retry_count: count(report.systemDiscardedAfterRetryCount),
          new_items_from_recovery_count: count(report.newItemsFromRecoveryCount),
          recovery_attempt_count: count(report.recoveryAttemptCount),
          batch_size: count(report.batchSize) || 20,
          coverage_rate: rate(report.coverageRate),
          matched_rate: rate(report.matchedRate),
        })
        .execute();
    }
    await trx
      .updateTable('knowledge_documents')
      .set({
        item_count: input.finalItems.length,
        candidate_item_count: input.candidateItems.length,
        discarded_block_count: count(report?.discardedBlocksCount),
        system_discarded_after_retry_count: count(report?.systemDiscardedAfterRetryCount),
      })
      .where('id', '=', documentId)
      .execute();
  });
}

async function selectItems(trx: Transaction<Database>, documentId: string): Promise<KnowledgeItem[]> {
  const blockRows = await trx
    .selectFrom('knowledge_item_blocks')
    .select(['item_id', 'block_id'])
    .where('document_id', '=', documentId)
    .orderBy('item_id')
    .orderBy('sort_order')
    .execute();
  const blocksByItem = new Map<string, string[]>();
  for (const row of blockRows) {
    const list = blocksByItem.get(row.item_id) ?? [];
    list.push(row.block_id);
    blocksByItem.set(row.item_id, list);
  }
  const rows = await trx
    .selectFrom('knowledge_items')
    .select(['item_id', 'title', 'resume', 'content', 'source_file'])
    .where('document_id', '=', documentId)
    .orderBy('sort_order')
    .orderBy('item_id')
    .execute();
  return rows.map((row) => ({
    id: row.item_id,
    title: row.title,
    resume: row.resume,
    content: row.content,
    sourceBlockIds: blocksByItem.get(row.item_id) ?? [],
    sourceFile: row.source_file,
  }));
}

/** 文档的最终条目及其来源块，按顺序（桌面版 readItems）。文档不可见时 404。 */
export async function readItems(db: Kysely<Database>, context: TenantContext, documentId: string): Promise<KnowledgeItem[]> {
  return withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    return selectItems(trx, documentId);
  });
}

// ---- 匹配批次 ----

function batchBody(row: Selectable<KnowledgeMatchBatchesTable>): KnowledgeMatchBatch {
  return {
    documentId: row.document_id,
    batchIndex: row.batch_index,
    status: row.status,
    itemIds: row.item_ids,
    matches: row.matches ?? [],
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function assertBatchIndex(batchIndex: number): void {
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex > 2_147_483_647) throw new TypeError(`匹配批次序号不合法：${batchIndex}`);
}

/** 文档的全部匹配批次，按序号。文档不可见时 404。 */
export async function readMatchBatches(db: Kysely<Database>, context: TenantContext, documentId: string): Promise<KnowledgeMatchBatch[]> {
  return withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    const rows = await trx.selectFrom('knowledge_match_batches').selectAll().where('document_id', '=', documentId).orderBy('batch_index').execute();
    return rows.map(batchBody);
  });
}

/** 一个匹配批次；没有时返回 null。文档不可见时 404。 */
export async function getMatchBatch(
  db: Kysely<Database>,
  context: TenantContext,
  documentId: string,
  batchIndex: number,
): Promise<KnowledgeMatchBatch | null> {
  assertBatchIndex(batchIndex);
  return withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    const row = await trx
      .selectFrom('knowledge_match_batches')
      .selectAll()
      .where('document_id', '=', documentId)
      .where('batch_index', '=', batchIndex)
      .executeTakeFirst();
    return row ? batchBody(row) : null;
  });
}

/**
 * 写入一个匹配批次，时间与错误的规则与桌面版 saveMatchBatch 相同（同 saveDocumentStep）：running 重新记开始时间并清除
 * 完成时间和错误；success 记完成时间并清除错误；error 记完成时间，没有错误信息时写“处理失败”；idle 全部清除。
 * 没有给出 itemIds / matches 时保留原值。
 */
export async function saveMatchBatch(
  db: Kysely<Database>,
  context: TenantContext,
  documentId: string,
  batchIndex: number,
  fields: { status: KnowledgeStepStatus; itemIds?: unknown; matches?: unknown[] | null; error?: string | null },
): Promise<KnowledgeMatchBatch> {
  assertBatchIndex(batchIndex);
  if (fields.itemIds !== undefined && (fields.itemIds === null || typeof fields.itemIds !== 'object')) {
    throw new TypeError('匹配批次指纹必须是对象或数组');
  }
  if (fields.matches !== undefined && fields.matches !== null && !Array.isArray(fields.matches)) throw new TypeError('匹配结果必须是数组');
  const itemIds = fields.itemIds === undefined ? undefined : json(fields.itemIds, KNOWLEDGE_JSON_MAX_BYTES, '匹配批次指纹');
  const matches =
    fields.matches === undefined ? undefined : fields.matches === null ? null : json(fields.matches, KNOWLEDGE_JSON_MAX_BYTES, '匹配结果');
  return withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    const current = await trx
      .selectFrom('knowledge_match_batches')
      .selectAll()
      .where('document_id', '=', documentId)
      .where('batch_index', '=', batchIndex)
      .forUpdate()
      .executeTakeFirst();
    const now = new Date();
    const error = fields.error !== undefined ? fields.error : (current?.error ?? null);
    let startedAt = current?.started_at ?? null;
    let completedAt: Date | null;
    let nextError: string | null;
    switch (fields.status) {
      case 'running':
        startedAt = now;
        completedAt = null;
        nextError = null;
        break;
      case 'success':
        startedAt = startedAt ?? now;
        completedAt = now;
        nextError = null;
        break;
      case 'error':
        startedAt = startedAt ?? now;
        completedAt = now;
        nextError = taskText(error || '处理失败', KNOWLEDGE_ERROR_MAX);
        break;
      default:
        startedAt = null;
        completedAt = null;
        nextError = null;
    }
    const values = {
      status: fields.status,
      error: nextError,
      started_at: startedAt,
      completed_at: completedAt,
      ...(itemIds !== undefined ? { item_ids: itemIds } : {}),
      ...(matches !== undefined ? { matches } : {}),
    };
    const row = current
      ? await trx
          .updateTable('knowledge_match_batches')
          .set(values)
          .where('document_id', '=', documentId)
          .where('batch_index', '=', batchIndex)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('knowledge_match_batches')
          .values({ org_id: context.orgId, document_id: documentId, batch_index: batchIndex, ...values })
          .returningAll()
          .executeTakeFirstOrThrow();
    return batchBody(row);
  });
}

/** 删除文档的全部匹配批次（强制重新匹配时用）。文档不可见时 404。 */
export async function clearMatchBatches(db: Kysely<Database>, context: TenantContext, documentId: string): Promise<void> {
  await withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    await trx.deleteFrom('knowledge_match_batches').where('document_id', '=', documentId).execute();
  });
}

// ---- 检索 ----

type MatchField = KnowledgeSearchResult['matchField'];

/** 摘录：合并空白后取命中位置附近的一段，前后被截掉时加省略号（与桌面版 createSnippet 相同）。 */
function snippet(value: string, lowerKeyword: string, keywordLength: number, truncatedBefore: boolean, truncatedAfter: boolean): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const matchIndex = text.toLowerCase().indexOf(lowerKeyword);
  if (matchIndex < 0) return `${truncatedBefore ? '…' : ''}${text.slice(0, SNIPPET_LENGTH)}${text.length > SNIPPET_LENGTH || truncatedAfter ? '…' : ''}`;
  const start = Math.max(0, matchIndex - Math.floor((SNIPPET_LENGTH - keywordLength) / 2));
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  return `${start > 0 || truncatedBefore ? '…' : ''}${text.slice(start, end)}${end < text.length || truncatedAfter ? '…' : ''}`;
}

/**
 * 在已处理完成（status = success）的文档的最终条目中检索关键词（与桌面版 search 相同）：文件名、标题、摘要、正文
 * 不区分大小写包含关键词即命中；按命中字段（标题 → 摘要 → 正文 → 文件名）、文档最近更新、条目顺序排序，每页 100 条，
 * 页码超出时取最后一页。关键词为空时返回空结果。原件已删除的文档由 RLS 排除。
 */
export async function searchKnowledgeBase(
  db: Kysely<Database>,
  context: TenantContext,
  request: { keyword: string; page: number },
): Promise<KnowledgeSearchPage> {
  const pageSize = KNOWLEDGE_SEARCH_PAGE_SIZE;
  const keyword = request.keyword.replaceAll('\u0000', '').trim();
  if (!keyword) return { items: [], total: 0, page: 1, pageSize };
  const lowerKeyword = keyword.toLowerCase();
  const requestedPage = Math.max(1, Math.floor(request.page) || 1);

  return withTenant(db, context, async (trx) => {
    // 关键词作为参数传入，用 strpos 而不是 LIKE，不需要转义 % 和 _。
    const kw = sql<string>`lower(${keyword})`;
    const hit = (column: string) => sql<boolean>`strpos(lower(${sql.ref(column)}), ${kw}) > 0`;
    const matched = trx
      .selectFrom('knowledge_items as i')
      .innerJoin('knowledge_documents as d', 'd.id', 'i.document_id')
      .innerJoin('knowledge_folders as k', 'k.id', 'd.folder_id')
      .innerJoin('files as f', 'f.id', 'd.file_id')
      .where('d.status', '=', 'success')
      .where((eb) => eb.or([hit('f.display_name'), hit('i.title'), hit('i.resume'), hit('i.content')]));

    const { total } = await matched.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow();
    const totalCount = Number(total);
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(totalCount / pageSize)));
    if (totalCount === 0) return { items: [], total: 0, page, pageSize };

    const field = sql<MatchField>`CASE
        WHEN ${hit('i.title')} THEN 'title'
        WHEN ${hit('i.resume')} THEN 'resume'
        WHEN ${hit('i.content')} THEN 'content'
        ELSE 'file_name'
      END`;
    // 正文只取命中位置前后各 SNIPPET_WINDOW 字，不把整段正文读出来。
    const windowStart = sql<number>`greatest(strpos(lower(i.content), ${kw}) - ${SNIPPET_WINDOW}, 1)`;
    const rows = await matched
      .select([
        'd.id as document_id',
        'd.folder_id',
        'k.name as folder_name',
        'f.display_name as file_name',
        'i.item_id',
        'i.title',
        'i.resume',
        field.as('match_field'),
        windowStart.as('window_start'),
        sql<string>`substr(i.content, ${windowStart}, ${SNIPPET_WINDOW * 2} + char_length(${keyword}))`.as('content_window'),
        sql<number>`char_length(i.content)`.as('content_length'),
      ])
      .orderBy(sql`CASE
          WHEN ${hit('i.title')} THEN 0
          WHEN ${hit('i.resume')} THEN 1
          WHEN ${hit('i.content')} THEN 2
          ELSE 3
        END`)
      .orderBy('d.updated_at', 'desc')
      .orderBy('i.sort_order')
      .orderBy('i.id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();

    const keywordLength = keyword.length;
    const items = rows.map((row): KnowledgeSearchResult => {
      let text: string;
      let before = false;
      let after = false;
      if (row.match_field === 'content') {
        text = row.content_window;
        before = row.window_start > 1;
        after = row.window_start - 1 + [...row.content_window].length < row.content_length;
      } else {
        text = row.match_field === 'title' ? row.title : row.match_field === 'resume' ? row.resume : row.file_name;
      }
      return {
        documentId: row.document_id,
        folderId: row.folder_id,
        folderName: row.folder_name,
        fileName: row.file_name,
        itemId: row.item_id,
        title: row.title,
        resume: row.resume,
        snippet: snippet(text, lowerKeyword, keywordLength, before, after),
        matchField: row.match_field,
      };
    });
    return { items, total: totalCount, page, pageSize };
  });
}

// ---- Markdown 与分析 ----

export interface DocumentMarkdown {
  /** 解析出的 Markdown 产物的对象键和大小；还没有解析时为 null。 */
  artifact: { id: string; storageKey: string; size: number } | null;
}

async function markdownArtifact(trx: Transaction<Database>, document: KnowledgeDocument): Promise<DocumentMarkdown['artifact']> {
  if (!document.markdownArtifactId) return null;
  // artifacts 的策略同样生效：产物不可见（例如写入中）时视为还没有 Markdown。
  const row = await trx
    .selectFrom('artifacts')
    .select(['id', 'storage_key', 'size_bytes'])
    .where('id', '=', document.markdownArtifactId)
    .where('status', '=', 'ready')
    .executeTakeFirst();
  return row ? { id: row.id, storageKey: row.storage_key, size: Number(row.size_bytes ?? 0) } : null;
}

/** 文档解析出的 Markdown 产物（桌面版 readMarkdown 读取的文件）。文档不可见时 404。 */
export async function findDocumentMarkdown(db: Kysely<Database>, context: TenantContext, documentId: string): Promise<DocumentMarkdown> {
  return withTenant(db, context, async (trx) => ({ artifact: await markdownArtifact(trx, await readDocument(trx, documentId)) }));
}

export function storageDisabled(): AppError {
  return new AppError(503, 'FILE_STORAGE_DISABLED', '文件存储暂未开放');
}

/** 流式统计去掉空白后的字数（与 contentCharCount 相同），不把整份 Markdown 读入内存。 */
export async function streamContentCharCount(body: Readable): Promise<number> {
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  for await (const chunk of body) total += contentCharCount(decoder.decode(chunk as Uint8Array, { stream: true }));
  return total + contentCharCount(decoder.decode());
}

/**
 * 文档的分析快照（桌面版 readAnalysis）：块数、筛除块数、Markdown 字数、有效块字数、条目覆盖的去重字数与覆盖率、
 * 候选条目、报告、舍弃块组。Markdown 字数需要读取对象存储；文档还没有 Markdown 时为 0。文档不可见时 404。
 * 桌面版开发者模式的 debug_log_path 不迁移。
 */
export async function readAnalysis(
  db: Kysely<Database>,
  objectStore: ObjectStore | null,
  context: TenantContext,
  documentId: string,
): Promise<KnowledgeAnalysis> {
  const snapshot = await withTenant(db, context, async (trx) => {
    const document = await readDocument(trx, documentId);
    const blocks = await trx
      .selectFrom('knowledge_blocks')
      .select(['block_id', 'content_chars', 'is_filtered'])
      .where('document_id', '=', documentId)
      .execute();
    const kept = blocks.filter((block) => !block.is_filtered);
    const charsByBlock = new Map(kept.map((block) => [block.block_id, block.content_chars]));
    const items = await selectItems(trx, documentId);
    const covered = new Set(items.flatMap((item) => item.sourceBlockIds));
    const reportRow = await trx.selectFrom('knowledge_reports').selectAll().where('document_id', '=', documentId).executeTakeFirst();
    const groups = await trx
      .selectFrom('knowledge_discarded_groups')
      .select(['source', 'reason', 'block_ids'])
      .where('document_id', '=', documentId)
      .orderBy('sort_order')
      .execute();
    const toGroup = (row: (typeof groups)[number]): DiscardedGroup => ({ blockIds: row.block_ids, reason: row.reason });
    return {
      document,
      artifact: await markdownArtifact(trx, document),
      blockCount: kept.length,
      filteredBlocksCount: blocks.length - kept.length,
      keptBlockChars: kept.reduce((sum, block) => sum + block.content_chars, 0),
      coveredUniqueContentChars: [...covered].reduce((sum, id) => sum + (charsByBlock.get(id) ?? 0), 0),
      candidateItems: await selectCandidates(trx, documentId),
      report: reportRow
        ? {
            totalBlocks: reportRow.total_blocks,
            filteredBlocksCount: reportRow.filtered_blocks_count,
            candidateItemsCount: reportRow.candidate_items_count,
            finalItemsCount: reportRow.final_items_count,
            matchedBlocksCount: reportRow.matched_blocks_count,
            discardedBlocksCount: reportRow.discarded_blocks_count,
            systemDiscardedAfterRetryCount: reportRow.system_discarded_after_retry_count,
            newItemsFromRecoveryCount: reportRow.new_items_from_recovery_count,
            recoveryAttemptCount: reportRow.recovery_attempt_count,
            batchSize: reportRow.batch_size,
            coverageRate: reportRow.coverage_rate,
            matchedRate: reportRow.matched_rate,
            createdAt: reportRow.created_at,
          }
        : null,
      discarded: groups.filter((row) => row.source === 'ai').map(toGroup),
      systemDiscardedAfterRetry: groups.filter((row) => row.source === 'system').map(toGroup),
    };
  });

  let markdownChars = 0;
  if (snapshot.artifact) {
    if (!objectStore) throw storageDisabled();
    const object = await objectStore.get(snapshot.artifact.storageKey);
    if (object) markdownChars = await streamContentCharCount(object.body);
  }
  const { artifact: _artifact, ...rest } = snapshot;
  return {
    ...rest,
    markdownChars,
    coverageRateVsMarkdown: markdownChars ? Number((snapshot.coveredUniqueContentChars / markdownChars).toFixed(4)) : 0,
  };
}
