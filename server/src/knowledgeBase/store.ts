// 知识库文件夹、文档与处理步骤的读写（迁移 0012_knowledge_base）。组织和用户一律来自 TenantContext，所有查询都经 withTenant。
//
// 可见性、写权限和删除可见性由 RLS 保证，这里不判断：只能看到、写入本组织的行；文档只能挂本组织可用的 knowledge 文件，
// 原件已删除时文档及其步骤查不到、改不了。删除文档就是软删除它的原件（应用角色没有文档的 DELETE 授权），
// 删除文件夹时先软删除其中文档的原件、再物理删除文件夹（文档行由外键级联删除），原件进回收站，按文件自己的恢复期处理。
//
// 文件夹、文档的排序与桌面版 knowledgeBaseStore.cjs 相同：调整顺序时整组重排 sort_order。同一组织的排序类操作
// 用事务级 advisory lock 串行，并发的拖动不会交错写出重复或跳号的顺序。
//
// 给第 6 步解析任务用的写函数（updateDocumentState、setDocumentMarkdown、saveDocumentStep、clearDocumentProcessingFromStep）
// 在本步一并实现；切块、条目、匹配结果等其余七张表的读写在 content.ts（5.7）。
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  KNOWLEDGE_DOCUMENTS_PER_ORG_MAX,
  KNOWLEDGE_ERROR_MAX,
  KNOWLEDGE_FOLDER_NAME_MAX_LENGTH,
  KNOWLEDGE_FOLDERS_PER_ORG_MAX,
  KNOWLEDGE_MESSAGE_MAX,
  KNOWLEDGE_PARSER_LABEL_MAX,
  KNOWLEDGE_STEP_KEYS,
  KNOWLEDGE_STEP_RESULT_MAX_BYTES,
} from '../db/migrations/0012_knowledge_base.ts';
import type {
  Database,
  KnowledgeDocumentStatus,
  KnowledgeDocumentStepsTable,
  KnowledgeFoldersTable,
  KnowledgeStepKey,
  KnowledgeStepStatus,
} from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { serializeJsonObject } from '../jsonObject.ts';

/** 名称为空时的默认值（与桌面版相同）。 */
export const UNTITLED_FOLDER_NAME = '未命名';

export type DropPosition = 'before' | 'after';

export interface KnowledgeFolder {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeDocument {
  id: string;
  folderId: string;
  fileId: string;
  /** 上传时的文件名（files.display_name）。 */
  fileName: string;
  status: KnowledgeDocumentStatus;
  progress: number;
  message: string;
  error: string | null;
  itemCount: number;
  blockCount: number;
  filteredBlockCount: number;
  candidateItemCount: number;
  discardedBlockCount: number;
  systemDiscardedAfterRetryCount: number;
  lastBatchSize: number | null;
  markdownArtifactId: string | null;
  parserLabel: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeBaseIndex {
  folders: KnowledgeFolder[];
  documents: KnowledgeDocument[];
}

export interface KnowledgeDocumentStep {
  documentId: string;
  stepKey: KnowledgeStepKey;
  status: KnowledgeStepStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

/** 解析任务写入的文档状态（只写给出的字段）。 */
export interface DocumentStatePatch {
  status?: KnowledgeDocumentStatus;
  progress?: number;
  message?: string;
  error?: string | null;
  itemCount?: number;
  blockCount?: number;
  filteredBlockCount?: number;
  candidateItemCount?: number;
  discardedBlockCount?: number;
  systemDiscardedAfterRetryCount?: number;
  lastBatchSize?: number | null;
  parserLabel?: string | null;
}

const COUNT_FIELDS = {
  itemCount: 'item_count',
  blockCount: 'block_count',
  filteredBlockCount: 'filtered_block_count',
  candidateItemCount: 'candidate_item_count',
  discardedBlockCount: 'discarded_block_count',
  systemDiscardedAfterRetryCount: 'system_discarded_after_retry_count',
} as const;

function invalid(message: string, cause?: unknown): AppError {
  return new AppError(400, 'KNOWLEDGE_INVALID', message, cause === undefined ? undefined : { cause });
}

export function folderNotFound(): AppError {
  return new AppError(404, 'KNOWLEDGE_FOLDER_NOT_FOUND', '知识库文件夹不存在或已被删除');
}

export function documentNotFound(): AppError {
  return new AppError(404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND', '知识库文档不存在或已被删除');
}

function fileUnavailable(cause?: unknown): AppError {
  return new AppError(
    400,
    'KNOWLEDGE_FILE_UNAVAILABLE',
    '文档文件不存在、未上传完成、已删除或已加入知识库',
    cause === undefined ? undefined : { cause },
  );
}

function mapError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'KB001') {
    return new AppError(409, 'KNOWLEDGE_LIMIT_REACHED', `知识库最多 ${KNOWLEDGE_FOLDERS_PER_ORG_MAX} 个文件夹、${KNOWLEDGE_DOCUMENTS_PER_ORG_MAX} 个文档`, {
      cause: error,
    });
  }
  return error;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapError(error);
  }
}

// 控制字符、零宽和双向文本控制字符（Unicode Cc / Cf）不进名称，避免显示时伪装成别的名称（与项目名称相同）。
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/** NFC 归一化、去掉不可见字符和首尾空白；为空时用“未命名”（与桌面版相同），超过 200 字时拒绝。 */
export function normalizeFolderName(raw: string): string {
  const name = raw.normalize('NFC').replace(INVISIBLE_CHARACTERS, '').trim() || UNTITLED_FOLDER_NAME;
  if ([...name].length > KNOWLEDGE_FOLDER_NAME_MAX_LENGTH) throw invalid(`文件夹名称不超过 ${KNOWLEDGE_FOLDER_NAME_MAX_LENGTH} 个字`);
  return name;
}

/** 任务写入的文本：去掉 PostgreSQL text 不接受的 \u0000，超长时截短（进度说明、错误信息不应让任务失败）。 */
export function taskText(value: string, max: number): string {
  const text = value.replaceAll('\u0000', '');
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

function folderBody(row: Selectable<KnowledgeFoldersTable>): KnowledgeFolder {
  return { id: row.id, name: row.name, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at };
}

function documents(trx: Transaction<Database>) {
  return trx
    .selectFrom('knowledge_documents as d')
    .innerJoin('files as f', 'f.id', 'd.file_id')
    .select([
      'd.id',
      'd.folder_id',
      'd.file_id',
      'f.display_name',
      'd.status',
      'd.progress',
      'd.message',
      'd.error',
      'd.item_count',
      'd.block_count',
      'd.filtered_block_count',
      'd.candidate_item_count',
      'd.discarded_block_count',
      'd.system_discarded_after_retry_count',
      'd.last_batch_size',
      'd.markdown_artifact_id',
      'd.parser_label',
      'd.sort_order',
      'd.created_at',
      'd.updated_at',
    ]);
}

type DocumentRow = Awaited<ReturnType<ReturnType<typeof documents>['execute']>>[number];

function documentBody(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    folderId: row.folder_id,
    fileId: row.file_id,
    fileName: row.display_name,
    status: row.status,
    progress: row.progress,
    message: row.message,
    error: row.error,
    itemCount: row.item_count,
    blockCount: row.block_count,
    filteredBlockCount: row.filtered_block_count,
    candidateItemCount: row.candidate_item_count,
    discardedBlockCount: row.discarded_block_count,
    systemDiscardedAfterRetryCount: row.system_discarded_after_retry_count,
    lastBatchSize: row.last_batch_size,
    markdownArtifactId: row.markdown_artifact_id,
    parserLabel: row.parser_label,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 在已设置上下文的事务中读取文档，不可见时 404。 */
export async function readDocument(trx: Transaction<Database>, documentId: string): Promise<KnowledgeDocument> {
  const row = await documents(trx).where('d.id', '=', documentId).executeTakeFirst();
  if (!row) throw documentNotFound();
  return documentBody(row);
}

/** 同一组织的排序类操作串行执行（文件夹、文档的新建与拖动）。 */
async function lockOrdering(trx: Transaction<Database>, context: TenantContext): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`knowledge_base_order:${context.orgId}`}, 0))`.execute(trx);
}

async function folderExists(trx: Transaction<Database>, folderId: string): Promise<boolean> {
  return (await trx.selectFrom('knowledge_folders').select('id').where('id', '=', folderId).executeTakeFirst()) !== undefined;
}

async function orderedFolderIds(trx: Transaction<Database>): Promise<string[]> {
  const rows = await trx.selectFrom('knowledge_folders').select('id').orderBy('sort_order').orderBy('created_at').orderBy('id').execute();
  return rows.map((row) => row.id);
}

/** 文件夹中的文档 id，按显示顺序（与桌面版相同：sort_order 升序、新建的在前）。 */
async function orderedDocumentIds(trx: Transaction<Database>, folderId: string, excludedDocumentId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('knowledge_documents')
    .select('id')
    .where('folder_id', '=', folderId)
    .where('id', '!=', excludedDocumentId)
    .orderBy('sort_order')
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .execute();
  return rows.map((row) => row.id);
}

/** 把 ids 按给出的顺序写成 0、1、2…，只更新顺序有变化的行。 */
async function resequence(
  trx: Transaction<Database>,
  table: 'knowledge_folders' | 'knowledge_documents',
  ids: string[],
  extra: { updated_by?: string } = {},
): Promise<void> {
  if (ids.length === 0) return;
  const current = new Map(
    (await trx.selectFrom(table).select(['id', 'sort_order']).where('id', 'in', ids).execute()).map((row) => [row.id, row.sort_order]),
  );
  for (const [index, id] of ids.entries()) {
    if (current.get(id) === index) continue;
    await trx
      .updateTable(table)
      .set({ sort_order: index, ...extra })
      .where('id', '=', id)
      .execute();
  }
}

export async function listKnowledgeBase(db: Kysely<Database>, context: TenantContext): Promise<KnowledgeBaseIndex> {
  return withTenant(db, context, async (trx) => {
    const folders = await trx.selectFrom('knowledge_folders').selectAll().orderBy('sort_order').orderBy('created_at').orderBy('id').execute();
    const rows = await documents(trx)
      .innerJoin('knowledge_folders as k', 'k.id', 'd.folder_id')
      .orderBy('k.sort_order')
      .orderBy('k.created_at')
      .orderBy('d.folder_id')
      .orderBy('d.sort_order')
      .orderBy('d.created_at', 'desc')
      .orderBy('d.id')
      .execute();
    return { folders: folders.map(folderBody), documents: rows.map(documentBody) };
  });
}

export async function getDocument(db: Kysely<Database>, context: TenantContext, documentId: string): Promise<KnowledgeDocument> {
  return withTenant(db, context, (trx) => readDocument(trx, documentId));
}

/** 新建文件夹，排在最后。 */
export async function createFolder(db: Kysely<Database>, context: TenantContext, name: string): Promise<KnowledgeFolder> {
  const normalized = normalizeFolderName(name);
  return guarded(() =>
    withTenant(db, context, async (trx) => {
      await lockOrdering(trx, context);
      const max = await trx.selectFrom('knowledge_folders').select((eb) => eb.fn.max('sort_order').as('max')).executeTakeFirst();
      const row = await trx
        .insertInto('knowledge_folders')
        .values({
          org_id: context.orgId,
          name: normalized,
          sort_order: max?.max === null || max?.max === undefined ? 0 : Number(max.max) + 1,
          created_by: context.userId,
          updated_by: context.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return folderBody(row);
    }),
  );
}

export async function renameFolder(db: Kysely<Database>, context: TenantContext, folderId: string, name: string): Promise<KnowledgeFolder> {
  const normalized = normalizeFolderName(name);
  return withTenant(db, context, async (trx) => {
    const row = await trx
      .updateTable('knowledge_folders')
      .set({ name: normalized, updated_by: context.userId })
      .where('id', '=', folderId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw folderNotFound();
    return folderBody(row);
  });
}

/** 把文件夹拖到另一个文件夹之前或之后，返回重排后的全部文件夹。 */
export async function reorderFolder(
  db: Kysely<Database>,
  context: TenantContext,
  draggedFolderId: string,
  targetFolderId: string,
  position: DropPosition,
): Promise<KnowledgeFolder[]> {
  return withTenant(db, context, async (trx) => {
    await lockOrdering(trx, context);
    const ids = await orderedFolderIds(trx);
    if (!ids.includes(draggedFolderId) || !ids.includes(targetFolderId)) throw folderNotFound();
    if (draggedFolderId !== targetFolderId) {
      const next = ids.filter((id) => id !== draggedFolderId);
      const targetIndex = next.indexOf(targetFolderId);
      next.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, draggedFolderId);
      await resequence(trx, 'knowledge_folders', next, { updated_by: context.userId });
    }
    const folders = await trx.selectFrom('knowledge_folders').selectAll().orderBy('sort_order').orderBy('created_at').orderBy('id').execute();
    return folders.map(folderBody);
  });
}

/**
 * 删除文件夹：先软删除其中文档的原件（进回收站，按文件自己的恢复期处理），再物理删除文件夹，文档行由外键级联删除。
 * 返回删除的文件夹和其中（可见的）文档数。
 */
export async function deleteFolder(
  db: Kysely<Database>,
  context: TenantContext,
  folderId: string,
): Promise<{ folder: KnowledgeFolder; deletedDocumentCount: number }> {
  return withTenant(db, context, async (trx) => {
    await lockOrdering(trx, context);
    const folder = await trx.selectFrom('knowledge_folders').selectAll().where('id', '=', folderId).executeTakeFirst();
    if (!folder) throw folderNotFound();
    const deleted = await trx
      .updateTable('files')
      .set({ deleted_at: sql<Date>`now()`, deleted_by: context.userId })
      .where('deleted_at', 'is', null)
      .where('id', 'in', trx.selectFrom('knowledge_documents').select('file_id').where('folder_id', '=', folderId))
      .executeTakeFirst();
    await trx.deleteFrom('knowledge_folders').where('id', '=', folderId).execute();
    return { folder: folderBody(folder), deletedDocumentCount: Number(deleted.numUpdatedRows) };
  });
}

/**
 * 把已上传的 knowledge 文件挂到文件夹中（取代桌面版 uploadDocuments 的“选文件并复制”），按给出的顺序排在文件夹末尾，
 * 状态停在 pending，解析由第 6 步的任务执行。文件不可用（不存在、其他组织的、未上传完成、已删除、用途不是知识库、
 * 属于某个项目）由 INSERT 策略拒绝，已挂过的文件由唯一约束拒绝，统一返回 400。
 */
export async function addDocuments(
  db: Kysely<Database>,
  context: TenantContext,
  folderId: string,
  fileIds: string[],
): Promise<KnowledgeDocument[]> {
  const ids = fileIds.map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw fileUnavailable();
  return guarded(() =>
    withTenant(db, context, async (trx) => {
      await lockOrdering(trx, context);
      if (!(await folderExists(trx, folderId))) throw folderNotFound();
      const max = await trx
        .selectFrom('knowledge_documents')
        .select((eb) => eb.fn.max('sort_order').as('max'))
        .where('folder_id', '=', folderId)
        .executeTakeFirst();
      const start = max?.max === null || max?.max === undefined ? 0 : Number(max.max) + 1;
      let inserted: { id: string }[];
      try {
        inserted = await trx
          .insertInto('knowledge_documents')
          .values(ids.map((fileId, index) => ({ org_id: context.orgId, folder_id: folderId, file_id: fileId, sort_order: start + index, created_by: context.userId })))
          .returning('id')
          .execute();
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        // 42501：INSERT 策略拒绝（文件不可用）；23505：文件已挂过；23503：外键（其他组织的文件）。
        if (code === '42501' || code === '23505' || code === '23503') throw fileUnavailable(error);
        throw error;
      }
      const rows = await documents(trx)
        .where(
          'd.id',
          'in',
          inserted.map((row) => row.id),
        )
        .orderBy('d.sort_order')
        .execute();
      return rows.map(documentBody);
    }),
  );
}

/**
 * 把文档移到目标文件夹（可以是原文件夹）中目标文档之前或之后，没有目标文档时排在末尾。与桌面版相同，跨文件夹移动时
 * 原文件夹重新编号。Web 版文档不再有本地目录，移动只改 folder_id，不再要求文档先处理完。
 */
export async function moveDocument(
  db: Kysely<Database>,
  context: TenantContext,
  documentId: string,
  targetFolderId: string,
  options: { targetDocumentId?: string; position?: DropPosition } = {},
): Promise<KnowledgeDocument> {
  return withTenant(db, context, async (trx) => {
    await lockOrdering(trx, context);
    const document = await trx.selectFrom('knowledge_documents').select(['id', 'folder_id']).where('id', '=', documentId).executeTakeFirst();
    if (!document) throw documentNotFound();
    if (!(await folderExists(trx, targetFolderId))) throw folderNotFound();
    const targetIds = await orderedDocumentIds(trx, targetFolderId, documentId);
    let insertIndex = targetIds.length;
    if (options.targetDocumentId) {
      const targetIndex = targetIds.indexOf(options.targetDocumentId);
      if (targetIndex < 0) throw documentNotFound();
      insertIndex = targetIndex + (options.position === 'before' ? 0 : 1);
    }
    targetIds.splice(insertIndex, 0, documentId);

    if (document.folder_id !== targetFolderId) {
      await trx.updateTable('knowledge_documents').set({ folder_id: targetFolderId, sort_order: insertIndex }).where('id', '=', documentId).execute();
      await resequence(trx, 'knowledge_documents', await orderedDocumentIds(trx, document.folder_id, documentId));
    }
    await resequence(trx, 'knowledge_documents', targetIds);
    return readDocument(trx, documentId);
  });
}

/** 删除文档：软删除其原件，文档及其步骤随之不可见（RLS），恢复文件即一起恢复。返回删除前的文档。 */
export async function deleteDocument(db: Kysely<Database>, context: TenantContext, documentId: string): Promise<KnowledgeDocument> {
  return withTenant(db, context, async (trx) => {
    const document = await readDocument(trx, documentId);
    const result = await trx
      .updateTable('files')
      .set({ deleted_at: sql<Date>`now()`, deleted_by: context.userId })
      .where('id', '=', document.fileId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw documentNotFound();
    return document;
  });
}

// ---- 以下给第 6 步的解析任务用 ----

/** 写入文档的状态、进度、计数等（只写给出的字段）。进度取整并限制在 0~100，文本超长时截短。 */
export async function updateDocumentState(
  db: Kysely<Database>,
  context: TenantContext,
  documentId: string,
  patch: DocumentStatePatch,
): Promise<KnowledgeDocument> {
  const values: Record<string, unknown> = {};
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.progress !== undefined) values.progress = Math.max(0, Math.min(100, Math.round(patch.progress)));
  if (patch.message !== undefined) values.message = taskText(patch.message, KNOWLEDGE_MESSAGE_MAX);
  if (patch.error !== undefined) values.error = patch.error === null ? null : taskText(patch.error, KNOWLEDGE_ERROR_MAX);
  for (const [field, column] of Object.entries(COUNT_FIELDS)) {
    const value = patch[field as keyof typeof COUNT_FIELDS];
    if (value !== undefined) values[column] = value;
  }
  if (patch.lastBatchSize !== undefined) values.last_batch_size = patch.lastBatchSize;
  if (patch.parserLabel !== undefined) values.parser_label = patch.parserLabel === null ? null : taskText(patch.parserLabel, KNOWLEDGE_PARSER_LABEL_MAX);
  return withTenant(db, context, async (trx) => {
    if (Object.keys(values).length > 0) {
      const result = await trx.updateTable('knowledge_documents').set(values).where('id', '=', documentId).executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw documentNotFound();
    }
    return readDocument(trx, documentId);
  });
}

/**
 * 记录解析出的 Markdown（取代桌面版的 markdown_path / updateMarkdownMetadata）。产物必须是本组织已写完、种类为 markdown、
 * 来源文件就是本文档原件的（UPDATE 策略），否则抛 TypeError（调用方的程序错误）；传 null 清除。
 */
export async function setDocumentMarkdown(
  db: Kysely<Database>,
  context: TenantContext,
  documentId: string,
  artifactId: string | null,
  parserLabel?: string | null,
): Promise<KnowledgeDocument> {
  return withTenant(db, context, async (trx) => {
    let result;
    try {
      result = await trx
        .updateTable('knowledge_documents')
        .set({
          markdown_artifact_id: artifactId,
          ...(parserLabel !== undefined ? { parser_label: parserLabel === null ? null : taskText(parserLabel, KNOWLEDGE_PARSER_LABEL_MAX) } : {}),
        })
        .where('id', '=', documentId)
        .executeTakeFirst();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '42501' || code === '23503') throw new TypeError('Markdown 产物不存在或不属于该文档的原件', { cause: error });
      throw error;
    }
    if (result.numUpdatedRows === 0n) throw documentNotFound();
    return readDocument(trx, documentId);
  });
}

/** 删除最终条目（来源块随条目级联删除）、舍弃块组和报告。 */
export async function clearFinalResult(trx: Transaction<Database>, documentId: string): Promise<void> {
  await trx.deleteFrom('knowledge_items').where('document_id', '=', documentId).execute();
  await trx.deleteFrom('knowledge_discarded_groups').where('document_id', '=', documentId).execute();
  await trx.deleteFrom('knowledge_reports').where('document_id', '=', documentId).execute();
}

function stepBody(row: Selectable<KnowledgeDocumentStepsTable>): KnowledgeDocumentStep {
  return {
    documentId: row.document_id,
    stepKey: row.step_key,
    status: row.status,
    result: row.result,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function assertStepKey(stepKey: string): asserts stepKey is KnowledgeStepKey {
  if (!(KNOWLEDGE_STEP_KEYS as readonly string[]).includes(stepKey)) throw new TypeError(`未知知识库处理步骤：${stepKey}`);
}

/** 文档的全部处理步骤，按步骤顺序。文档不可见时 404。 */
export async function listDocumentSteps(db: Kysely<Database>, context: TenantContext, documentId: string): Promise<KnowledgeDocumentStep[]> {
  return withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    const rows = await trx.selectFrom('knowledge_document_steps').selectAll().where('document_id', '=', documentId).execute();
    return rows.map(stepBody).sort((a, b) => KNOWLEDGE_STEP_KEYS.indexOf(a.stepKey) - KNOWLEDGE_STEP_KEYS.indexOf(b.stepKey));
  });
}

/**
 * 写入一个处理步骤，时间与错误的规则与桌面版 saveDocumentStep 相同：running 重新记开始时间并清除完成时间和错误；
 * success 记完成时间并清除错误；error 记完成时间，没有错误信息时写“处理失败”；idle 全部清除。
 * 没有给出 result 时保留原结果。
 */
export async function saveDocumentStep(
  db: Kysely<Database>,
  context: TenantContext,
  documentId: string,
  stepKey: KnowledgeStepKey,
  fields: { status: KnowledgeStepStatus; result?: Record<string, unknown> | null; error?: string | null },
): Promise<KnowledgeDocumentStep> {
  assertStepKey(stepKey);
  let resultJson: string | null | undefined;
  if (fields.result !== undefined && fields.result !== null) {
    const serialized = serializeJsonObject(fields.result, KNOWLEDGE_STEP_RESULT_MAX_BYTES);
    if (serialized === 'too-deep' || serialized === 'too-large') throw new TypeError(`步骤结果过大或嵌套过深：${stepKey}`);
    resultJson = serialized;
  } else if (fields.result === null) {
    resultJson = null;
  }
  return withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    const current = await trx
      .selectFrom('knowledge_document_steps')
      .selectAll()
      .where('document_id', '=', documentId)
      .where('step_key', '=', stepKey)
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
      ...(resultJson !== undefined ? { result: resultJson } : {}),
    };
    const row = current
      ? await trx
          .updateTable('knowledge_document_steps')
          .set(values)
          .where('document_id', '=', documentId)
          .where('step_key', '=', stepKey)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('knowledge_document_steps')
          .values({ org_id: context.orgId, document_id: documentId, step_key: stepKey, ...values })
          .returningAll()
          .executeTakeFirstOrThrow();
    return stepBody(row);
  });
}

/**
 * 从某一步起清除处理结果（重试、重新匹配时用），与桌面版 clearDocumentProcessingFromStep 相同：删除该步及之后的步骤记录，
 * 清除 error、last_batch_size，并按起始步骤清除 Markdown 产物的引用、解析器标签、切块、候选条目、匹配批次、
 * 最终条目（含来源块、舍弃块组和报告）以及相应的计数。
 */
export async function clearDocumentProcessingFromStep(
  db: Kysely<Database>,
  context: TenantContext,
  documentId: string,
  stepKey: KnowledgeStepKey,
): Promise<KnowledgeDocument> {
  assertStepKey(stepKey);
  const start = KNOWLEDGE_STEP_KEYS.indexOf(stepKey);
  const from = (key: KnowledgeStepKey) => start <= KNOWLEDGE_STEP_KEYS.indexOf(key);
  return withTenant(db, context, async (trx) => {
    await readDocument(trx, documentId);
    await trx
      .deleteFrom('knowledge_document_steps')
      .where('document_id', '=', documentId)
      .where('step_key', 'in', KNOWLEDGE_STEP_KEYS.slice(start))
      .execute();
    if (from('build_blocks')) await trx.deleteFrom('knowledge_blocks').where('document_id', '=', documentId).execute();
    if (from('merge_candidates')) await trx.deleteFrom('knowledge_candidate_items').where('document_id', '=', documentId).execute();
    if (from('match_batches')) await trx.deleteFrom('knowledge_match_batches').where('document_id', '=', documentId).execute();
    if (from('save_result')) await clearFinalResult(trx, documentId);
    await trx
      .updateTable('knowledge_documents')
      .set({
        error: null,
        last_batch_size: null,
        ...(from('convert_markdown') ? { markdown_artifact_id: null, parser_label: null } : {}),
        ...(from('build_blocks') ? { block_count: 0, filtered_block_count: 0 } : {}),
        ...(from('merge_candidates') ? { candidate_item_count: 0 } : {}),
        ...(from('save_result') ? { item_count: 0, discarded_block_count: 0, system_discarded_after_retry_count: 0 } : {}),
      })
      .where('id', '=', documentId)
      .execute();
    return readDocument(trx, documentId);
  });
}
