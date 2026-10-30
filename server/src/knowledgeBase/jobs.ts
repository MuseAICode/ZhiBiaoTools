// 知识库文档处理任务（路线图第 6 步 6.13a、6.13b；取代桌面版 knowledgeBaseService.cjs 的 prepareDocument、matchDocument、
// retryDocument、startMatching 与启动时的 recoverInterruptedDocuments），ai 队列，会调用模型（入队检查最低启动余额），组织级（没有项目）：
// - knowledge-document-prepare：文档准备，完成后接着匹配（与桌面版非开发者模式相同）；挂文档、重试时入队；
// - knowledge-document-match：只做匹配（startMatching，已处理完成的文档重新匹配）。
// 同一文档同时只有一个处理任务（lock_key 为 knowledge-document:{documentId}，与桌面版 activePreparations / activeMatches 相同）。
//
// 流程与桌面版相同，按 knowledge_document_steps 逐步执行、已成功的步骤续用：
//   copy_source（Web 版原件已在对象存储中，只记一步）→ convert_markdown（在断网的 parse 沙箱中解析，经 writeArtifact 写入
//   Markdown 产物）→ build_blocks（切块与筛选，src/knowledgeBase/prepare.ts）→ extract_first_items / extract_supplement_items
//   （按统一分段并发调用模型，先按段预热块前缀）→ merge_candidates（合并为候选条目，ready_for_matching）
//   → match_batches（按同一段表逐段匹配，条目超出预算时拆成条目子批；已成功且指纹相同的段续用，src/knowledgeBase/match.ts）
//   → recover_missing（遗漏块最多补漏 2 轮，仍遗漏的由系统舍弃）→ save_result（回填正文，保存最终条目与报告）→ success。
//
// - 输入在任务开始时从数据库读取，任务参数只有文档 id；模型取组织设置中选择的平台模型，在第一次调用模型前读取
//   （没有选择时解析与切块的结果照常保存，重试时续用）；
// - 可续跑：worker 崩溃、关闭或暂停后从头重新执行，已成功的步骤续用，已完成的调用按步骤键取回已保存的结果，不再调用服务商、
//   不再扣费（6.4a）；
// - 文档被删除（原件进回收站）后，Store 的读写一律 404，任务在下一次写入时停止（接口删除文档时另外取消任务）；
// - 失败时文档标为 error，写给用户看的原因（JobError 的文案，其他错误写“处理失败”并交给执行者写日志）；用户取消时标为“处理已取消”；
//   暂停、余额不足、中断时不改写文档；
// - 进度推送：任务进度与文档进度相同，阶段说明写进任务日志，经 SSE 的 job / job.progress / job.log 事件推送
//   （取代桌面版的 knowledge-base:event）；读取文档时附上它最近的任务（documentViews）；
// - 任务日志只写阶段、段数与条目数，不写文件名、文档正文和模型输出。
import { supersedeArtifacts } from '../artifacts/store.ts';
import { DEFAULT_CONTEXT_LENGTH_LIMIT } from '../ai/textSplit.ts';
import type { ChatMessage } from '../ai/providers.ts';
import type { Database, KnowledgeDocumentStatus, KnowledgeStepKey } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { findFile } from '../files/store.ts';
import { createJobChat, resolveJobModel, type JobChat } from '../jobs/chat.ts';
import { abortableDelay, isJobStop } from '../jobs/control.ts';
import { JobBalanceExhaustedError, JobError, JobInterruptedError, type JobContext, type JobTypeDefinition } from '../jobs/definitions.ts';
import { cancelJob, enqueueJob, type JobServiceDependencies } from '../jobs/service.ts';
import { isFinalStatus, latestLockKeyJobs, listJobs, type JobRecord } from '../jobs/store.ts';
import { parseFailureOf, parseFileInSandbox, writeParseArtifacts } from '../parse/run.ts';
import type { Kysely } from 'kysely';
import {
  clearMatchBatches,
  findDocumentMarkdown,
  getMatchBatch,
  readBlocks,
  readCandidateItems,
  readItems,
  readMatchBatches,
  saveBlocks,
  saveCandidateItems,
  saveMatchBatch,
  saveMatchResult,
} from './content.ts';
import {
  blockOrderOf,
  buildMatchMessages,
  buildMatchTaskMessage,
  buildMissingBlocksPrefixMessage,
  buildRecoveryMessages,
  buildRecoveryTaskMessage,
  compressBlockIdsToRanges,
  createFinalItems,
  createReport,
  expandRanges,
  isRecoveryResult,
  itemSplitBudget,
  mergeMatchResults,
  mergeRecoverySegmentResults,
  messagesContentLength,
  missingBlocksOf,
  nextKnowledgeItemId,
  normalizeMatchResult,
  normalizeRanges,
  normalizeRecoveryResult,
  packItemsIntoSegments,
  recompressMatches,
  RECOVERY_MAX_ATTEMPTS,
  type DiscardedBlocks,
  type Match,
  type RecoveryAttempt,
  type RecoveryParsed,
  type RecoveryResult,
  type SystemDiscarded,
} from './match.ts';
import {
  buildBlocks,
  buildDocumentBlocksPrefixMessage,
  buildInitialItemMessages,
  buildSupplementItemMessages,
  buildUnifiedBlockSegments,
  mergeCandidateItems,
  mergeTitleSummaryItems,
  normalizeCandidateItems,
  packBlocksIntoSegments,
  requestBudget,
  stripMarkdownFence,
  type Block,
  type BlockSegment,
  type CandidateItem,
  type TitleSummaryItem,
} from './prepare.ts';
import {
  clearDocumentProcessingFromStep,
  documentNotFound,
  getDocument,
  listDocumentSteps,
  saveDocumentStep,
  setDocumentMarkdown,
  updateDocumentState,
  type DocumentStatePatch,
  type KnowledgeDocument,
  type KnowledgeDocumentStep,
} from './store.ts';

export const KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE = 'knowledge-document-prepare';
export const KNOWLEDGE_DOCUMENT_MATCH_JOB_TYPE = 'knowledge-document-match';
/** 知识库的任务类型。 */
export const KNOWLEDGE_JOB_TYPES: readonly string[] = Object.freeze([KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE, KNOWLEDGE_DOCUMENT_MATCH_JOB_TYPE]);

const LOCK_KEY_PREFIX = 'knowledge-document:';

/** 同一文档同时只有一个处理任务（与桌面版相同，准备与匹配也互斥）。 */
export function knowledgeDocumentLockKey(documentId: string): string {
  return `${LOCK_KEY_PREFIX}${documentId}`;
}

/** 预热请求结束后稍候再发后续请求（与桌面版 PREFIX_WARMUP_SETTLE_MS 相同）。 */
const PREFIX_WARMUP_SETTLE_MS = 1500;
/** Markdown 读回内存的上限（重试时从产物重新切块）。 */
const MARKDOWN_MAX_BYTES = 64 * 1024 * 1024;

/** 处理中的状态：没有未结束的任务时按中断显示（取代桌面版启动时的 recoverInterruptedDocuments）。 */
const PROCESSING_STATUSES: ReadonlySet<KnowledgeDocumentStatus> = new Set([
  'pending',
  'copying',
  'converting',
  'extracting',
  'matching',
  'recovering',
  'analyzing',
  'saving',
]);
/** 与桌面版 recoverInterruptedDocuments 的文案相同。 */
export const INTERRUPTED_MESSAGE = '上次任务中断，请点击重试继续处理';
const CANCELLED_MESSAGE = '处理已取消';
const FAILED_MESSAGE = '处理失败';

export interface PrepareParams {
  documentId: string;
}

export interface MatchParams extends PrepareParams {
  /** 已处理完成的文档重新匹配：先清除匹配批次及之后的结果（与桌面版 startMatching 的 force 相同）。 */
  force: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseParams(raw: unknown): PrepareParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('知识库任务参数不合法');
  const { documentId, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof documentId !== 'string' || !UUID.test(documentId)) throw new TypeError('知识库任务参数不合法');
  return { documentId };
}

function parseMatchParams(raw: unknown): MatchParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('知识库任务参数不合法');
  const { force, ...rest } = raw as Record<string, unknown>;
  if (typeof force !== 'boolean') throw new TypeError('知识库任务参数不合法');
  return { ...parseParams(rest), force };
}

export interface KnowledgeJobOptions {
  /** 上下文长度（字符），默认 DEFAULT_CONTEXT_LENGTH_LIMIT；测试中用很小的值触发分段。 */
  contextLengthLimit?: number;
  /** 预热后等待的毫秒数，默认 1500。 */
  warmupSettleMs?: number;
  /** 沙箱繁忙时重试创建前的等待（毫秒），默认见 src/parse/run.ts。 */
  createRetryDelaysMs?: readonly number[];
}

const isDocumentGone = (error: unknown) => error instanceof AppError && error.code === 'KNOWLEDGE_DOCUMENT_NOT_FOUND';

/**
 * 并发执行，全部结束后有失败时抛出（与桌面版 runParallelAndThrowAfterSettled 相同）。中止与余额不足优先于其他错误抛出，
 * 由执行者按中止收尾，不把文档标为失败。
 */
async function runParallelAndThrowAfterSettled<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks.map((task) => task()));
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason as unknown);
  if (rejected.length > 0) {
    throw rejected.find((reason) => reason instanceof JobBalanceExhaustedError || reason instanceof JobInterruptedError) ?? rejected[0];
  }
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

function stepCanReuse(step: KnowledgeDocumentStep | null, hasArtifact: boolean): boolean {
  return hasArtifact && (!step || step.status === 'success');
}

function stepItems(step: KnowledgeDocumentStep | null): TitleSummaryItem[] | null {
  const items = step?.result?.items;
  return Array.isArray(items) ? (items as TitleSummaryItem[]) : null;
}

function toBlocks(rows: Awaited<ReturnType<typeof readBlocks>>): Block[] {
  return rows.map((row) => ({ id: row.id, type: row.type, headingPath: row.headingPath, content: row.content }));
}

/** 读回已保存的 Markdown 产物；产物或对象已不存在时返回 null（重新解析）。 */
async function readMarkdown(context: JobContext<PrepareParams>): Promise<string | null> {
  const { artifact } = await findDocumentMarkdown(context.db, context.tenant, context.params.documentId);
  if (!artifact || !context.objectStore) return null;
  if (artifact.size > MARKDOWN_MAX_BYTES) throw new JobError('KNOWLEDGE_MARKDOWN_TOO_LARGE', '解析出的 Markdown 过大');
  const object = await context.objectStore.get(artifact.storageKey);
  if (!object) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of object.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MARKDOWN_MAX_BYTES) throw new JobError('KNOWLEDGE_MARKDOWN_TOO_LARGE', '解析出的 Markdown 过大');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim() || null;
}

class DocumentRun {
  private chat: JobChat | null = null;
  private logChain: Promise<void> = Promise.resolve();
  private blockPrefixWarmed = false;

  private readonly context: JobContext<PrepareParams>;
  private readonly options: KnowledgeJobOptions;

  constructor(context: JobContext<PrepareParams>, options: KnowledgeJobOptions) {
    this.context = context;
    this.options = options;
  }

  private get documentId(): string {
    return this.context.params.documentId;
  }

  /** 写文档状态；给出进度时同时更新任务进度（经 SSE 推送）。 */
  async update(patch: DocumentStatePatch): Promise<KnowledgeDocument> {
    const document = await updateDocumentState(this.context.db, this.context.tenant, this.documentId, patch);
    if (patch.progress !== undefined) await this.context.setProgress(document.progress);
    return document;
  }

  async step(key: KnowledgeStepKey): Promise<KnowledgeDocumentStep | null> {
    return (await listDocumentSteps(this.context.db, this.context.tenant, this.documentId)).find((step) => step.stepKey === key) ?? null;
  }

  async saveStep(key: KnowledgeStepKey, fields: Parameters<typeof saveDocumentStep>[4]): Promise<void> {
    await saveDocumentStep(this.context.db, this.context.tenant, this.documentId, key, fields);
  }

  async clearFrom(key: KnowledgeStepKey): Promise<void> {
    await clearDocumentProcessingFromStep(this.context.db, this.context.tenant, this.documentId, key);
  }

  /** 与桌面版 runDocumentStep 相同：先记 running，成功记结果，失败记原因；中止时不改写步骤（续跑时重新执行这一步）。 */
  async runStep<T extends Record<string, unknown>>(key: KnowledgeStepKey, worker: () => Promise<T>): Promise<T> {
    await this.saveStep(key, { status: 'running' });
    try {
      const result = await worker();
      await this.saveStep(key, { status: 'success', result });
      return result;
    } catch (error) {
      if (!isJobStop(this.context, error) && !isDocumentGone(error)) {
        await this.saveStep(key, { status: 'error', error: error instanceof JobError ? error.message : FAILED_MESSAGE }).catch(() => {});
      }
      throw error;
    }
  }

  /** JSON 修复与重试的说明按顺序写入任务日志，不等待；写入失败（租约丢失）由后续的检查点处理。 */
  onProgress = (message: string) => {
    this.logChain = this.logChain.then(
      () => this.context.log(message),
      () => {},
    );
  };

  async jobChat(): Promise<JobChat> {
    this.chat ??= createJobChat(this.context.ai, await resolveJobModel(this.context.db, this.context.tenant));
    return this.chat;
  }

  /** 块前缀由首轮提取、补充提取共用，在本次第一个实际执行的阶段按段预热一次（与桌面版相同；匹配只在条目子批时预热）。 */
  async warmBlockPrefixes(chat: JobChat, segments: readonly BlockSegment[], prefix: (segment: BlockSegment) => ChatMessage): Promise<void> {
    if (this.blockPrefixWarmed) return;
    this.blockPrefixWarmed = true;
    await Promise.all(
      segments.map(async (segment) => {
        await this.warmPrefix(chat, segments.length > 1 ? `warmup:segment:${segment.index}` : 'warmup', prefix(segment), '知识库文档内容');
      }),
    );
  }

  /** 用只含公共前缀的短请求写入服务商的前缀缓存，稍候再放开后续请求；失败时直接继续（与桌面版 warmPromptPrefix 相同）。 */
  async warmPrefix(chat: JobChat, stepKey: string, prefix: ChatMessage, label: string): Promise<void> {
    try {
      await chat.text(stepKey, [prefix], label, { maxOutputTokens: 1, allowEmpty: true });
      await abortableDelay(this.options.warmupSettleMs ?? PREFIX_WARMUP_SETTLE_MS, this.context.signal);
    } catch (error) {
      if (isJobStop(this.context, error)) throw error;
      this.onProgress(`${label}缓存预热失败，直接继续`);
    }
  }

  async flushLogs(): Promise<void> {
    await this.logChain.catch(() => {});
  }
}

async function prepareDocument(context: JobContext<PrepareParams>, options: KnowledgeJobOptions): Promise<void> {
  const { db, tenant, params } = context;
  const documentId = params.documentId;
  const run = new DocumentRun(context, options);
  const document = await getDocument(db, tenant, documentId);
  const file = await findFile(db, tenant, document.fileId);
  // 原件已删除：文档已不可见（RLS），这里只是防御。
  if (!file) throw documentNotFound();
  await context.log('开始处理知识库文档。');

  // copy_source：原件上传时已在对象存储中，只记一步（与桌面版的步骤表一致）。
  const copyStep = await run.step('copy_source');
  if (!copyStep || copyStep.status !== 'success') {
    if (copyStep) await run.clearFrom('copy_source');
    await run.saveStep('copy_source', { status: 'success', result: { file_id: file.id } });
  }

  // convert_markdown：在断网的 parse 沙箱中解析（不保留图片，与桌面版 preserveImages: false 相同）。
  const converted = { markdown: null as string | null };
  const convertStep = await run.step('convert_markdown');
  const { artifact } = await findDocumentMarkdown(db, tenant, documentId);
  let blocks = toBlocks(await readBlocks(db, tenant, documentId));
  let filteredCount = (await readBlocks(db, tenant, documentId, { filtered: true })).length;
  const blockStep = await run.step('build_blocks');
  let reuseMarkdown = stepCanReuse(convertStep, artifact !== null);
  // 切块要重做时才读回 Markdown；产物对象已不存在时重新解析。
  if (reuseMarkdown && !stepCanReuse(blockStep, blocks.length > 0)) {
    converted.markdown = await readMarkdown(context);
    if (converted.markdown === null) reuseMarkdown = false;
  }
  if (!reuseMarkdown) {
    await run.clearFrom('convert_markdown');
    blocks = [];
    filteredCount = 0;
    await run.update({ status: 'converting', progress: 15, message: '正在转换为 Markdown', error: null });
    await context.log('正在转换为 Markdown。');
    const result = await run.runStep('convert_markdown', async () => {
      const written: string[] = [];
      try {
        const parsed = await parseFileInSandbox(context, file, { images: false, ...(options.createRetryDelaysMs ? { createRetryDelaysMs: options.createRetryDelaysMs } : {}) });
        const output = await writeParseArtifacts(context, null, file, parsed, (id) => written.push(id), { normalizeMarkdown: stripMarkdownFence });
        await setDocumentMarkdown(db, tenant, documentId, output.markdownArtifactId);
        // 之前的产物（含上次写了一半的）标为已被替换。
        await supersedeArtifacts(db, tenant, file.id, output.artifactIds);
        converted.markdown = output.markdown;
        return { markdown_chars: output.markdown.length };
      } catch (error) {
        if (isJobStop(context, error) || isDocumentGone(error)) throw error;
        // 写了一半的产物与之前的一起标为已被替换（文档的 Markdown 引用已在上面清除）。
        await supersedeArtifacts(db, tenant, file.id, []);
        throw parseFailureOf(error) ?? error;
      }
    });
    if (!result.markdown_chars || !converted.markdown) throw new JobError('PARSE_EMPTY', '文档未解析出有效 Markdown 内容');
  }

  // build_blocks
  // 重新解析时上面已清除切块（blocks 为空）。
  if (!stepCanReuse(blockStep, blocks.length > 0)) {
    await run.clearFrom('build_blocks');
    const source = converted.markdown ?? '';
    const result = await run.runStep('build_blocks', async () => {
      const built = buildBlocks(source);
      if (!built.blocks.length) throw new JobError('KNOWLEDGE_NO_CONTENT', '筛选后没有可分析的正文内容');
      await saveBlocks(db, tenant, documentId, built.blocks, built.filteredBlocks);
      return { block_count: built.blocks.length, filtered_block_count: built.filteredBlocks.length };
    });
    blocks = toBlocks(await readBlocks(db, tenant, documentId));
    filteredCount = (await readBlocks(db, tenant, documentId, { filtered: true })).length;
    await run.update({ blockCount: result.block_count, filteredBlockCount: result.filtered_block_count });
    await context.log(`切块完成：${blocks.length} 个有效块，筛除 ${filteredCount} 个。`);
  } else if (!blockStep) {
    await run.saveStep('build_blocks', { status: 'success', result: { block_count: blocks.length, filtered_block_count: filteredCount } });
  }

  // 统一分段：首轮提取、补充提取与匹配共用同一段表，块前缀逐字相同。
  const { segments } = buildUnifiedBlockSegments(blocks, options.contextLengthLimit ?? DEFAULT_CONTEXT_LENGTH_LIMIT);
  if (!segments.length) throw new JobError('KNOWLEDGE_NO_CONTENT', '筛选后没有可分析的正文内容');
  const blockPrefix = (segment: BlockSegment) => buildInitialItemMessages(document.fileName, segment.text, segment)[0]!;

  // extract_first_items（首轮条目只来自步骤结果，所以没有步骤记录时一定重新提取）
  const firstStep = await run.step('extract_first_items');
  let firstItems = stepItems(firstStep);
  if (!stepCanReuse(firstStep, Array.isArray(firstItems))) {
    await run.clearFrom('extract_first_items');
    await run.update({ status: 'extracting', progress: 35, message: 'AI 正在首次提取知识条目', blockCount: blocks.length, filteredBlockCount: filteredCount, error: null });
    await context.log(segments.length > 1 ? `AI 正在首次提取知识条目，共 ${segments.length} 段。` : 'AI 正在首次提取知识条目。');
    const chat = await run.jobChat();
    const result = await run.runStep('extract_first_items', async () => {
      let completed = 0;
      await run.warmBlockPrefixes(chat, segments, blockPrefix);
      const lists = await runParallelAndThrowAfterSettled(
        segments.map((segment) => async () => {
          const parsed = await chat.json(
            segments.length > 1 ? `first-items:segment:${segment.index}` : 'first-items',
            buildInitialItemMessages(document.fileName, segment.text, segment),
            { progressLabel: '知识库条目提取', failureMessage: '知识库条目提取失败，AI 未返回有效 JSON', onProgress: run.onProgress },
          );
          const items = normalizeCandidateItems(parsed);
          completed += 1;
          await run.update({
            status: 'extracting',
            progress: Math.min(54, 35 + Math.round((completed / segments.length) * 18)),
            message: segments.length > 1 ? `AI 正在首次提取知识条目，已完成 ${completed}/${segments.length} 段` : 'AI 正在首次提取知识条目',
          });
          return items;
        }),
      );
      return { items: mergeTitleSummaryItems(lists), segment_count: segments.length };
    });
    firstItems = result.items;
  }

  // extract_supplement_items
  const supplementStep = await run.step('extract_supplement_items');
  let supplementItems = stepItems(supplementStep);
  if (!stepCanReuse(supplementStep, Array.isArray(supplementItems))) {
    await run.clearFrom('extract_supplement_items');
    await run.update({ status: 'extracting', progress: 55, message: 'AI 正在补充遗漏知识条目', error: null });
    await context.log(segments.length > 1 ? `AI 正在补充遗漏知识条目，共 ${segments.length} 段。` : 'AI 正在补充遗漏知识条目。');
    const chat = await run.jobChat();
    const first = firstItems!;
    const result = await run.runStep('extract_supplement_items', async () => {
      let completed = 0;
      await run.warmBlockPrefixes(chat, segments, blockPrefix);
      const lists = await runParallelAndThrowAfterSettled(
        segments.map((segment) => async () => {
          const parsed = await chat.json(
            segments.length > 1 ? `supplement-items:segment:${segment.index}` : 'supplement-items',
            buildSupplementItemMessages(document.fileName, segment.text, first, segment),
            { progressLabel: '知识库条目补充', failureMessage: '知识库条目补充失败，AI 未返回有效 JSON', onProgress: run.onProgress },
          );
          const items = normalizeCandidateItems(parsed);
          completed += 1;
          await run.update({
            status: 'extracting',
            progress: Math.min(64, 55 + Math.round((completed / segments.length) * 8)),
            message: segments.length > 1 ? `AI 正在补充遗漏知识条目，已完成 ${completed}/${segments.length} 段` : 'AI 正在补充遗漏知识条目',
          });
          return items;
        }),
      );
      return { items: mergeTitleSummaryItems(lists), segment_count: segments.length };
    });
    supplementItems = result.items;
  }

  // merge_candidates
  const mergeStep = await run.step('merge_candidates');
  let candidates = await readCandidateItems(db, tenant, documentId);
  if (!stepCanReuse(mergeStep, candidates.length > 0)) {
    await run.clearFrom('merge_candidates');
    const first = firstItems!;
    const supplement = supplementItems!;
    await run.runStep('merge_candidates', async () => {
      const merged = mergeCandidateItems(first, supplement);
      if (!merged.length) throw new JobError('KNOWLEDGE_NO_ITEMS', 'AI 未提取出可用知识条目');
      await saveCandidateItems(db, tenant, documentId, merged);
      return { candidate_item_count: merged.length };
    });
    candidates = await readCandidateItems(db, tenant, documentId);
    if (!candidates.length) throw new JobError('KNOWLEDGE_NO_ITEMS', 'AI 未提取出可用知识条目');
  } else if (!mergeStep) {
    await run.saveStep('merge_candidates', { status: 'success', result: { candidate_item_count: candidates.length } });
  }

  await run.flushLogs();
  if (context.signal.aborted) throw new JobInterruptedError();
  // 接着自动匹配（桌面版非开发者模式的文案与流程）。
  await run.update({
    status: 'ready_for_matching',
    progress: 65,
    message: `已提取 ${candidates.length} 条候选知识，正在自动匹配段落`,
    candidateItemCount: candidates.length,
    itemCount: 0,
  });
  await context.log(`已提取 ${candidates.length} 条候选知识。`);
  await matchDocument(context, run, options, false);
}

// ---- 段落匹配、遗漏补漏与保存结果（6.13b，与桌面版 matchDocument 相同） ----

/** 匹配批次的指纹：本段的块 id 与全部候选条目 id；已保存的任一段不一致时清空全部批次重新匹配。 */
interface MatchFingerprint {
  block_ids: string[];
  item_ids: string[];
}

function readFingerprint(raw: unknown): MatchFingerprint | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { block_ids: blockIds, item_ids: itemIds } = raw as Record<string, unknown>;
  if (!Array.isArray(blockIds) || !Array.isArray(itemIds)) return null;
  return { block_ids: blockIds.map(String), item_ids: itemIds.map(String) };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const sameFingerprint = (a: MatchFingerprint | null, b: MatchFingerprint) => a !== null && sameList(a.block_ids, b.block_ids) && sameList(a.item_ids, b.item_ids);

async function matchDocument(context: JobContext<PrepareParams>, run: DocumentRun, options: KnowledgeJobOptions, force: boolean): Promise<void> {
  const { db, tenant, params } = context;
  const documentId = params.documentId;
  const contextLengthLimit = options.contextLengthLimit ?? DEFAULT_CONTEXT_LENGTH_LIMIT;
  const document = await getDocument(db, tenant, documentId);
  if (force) {
    // 先确认已选择模型，再清除上次的结果（没有选择时不丢掉已完成的结果）。
    await run.jobChat();
    await run.clearFrom('match_batches');
  }
  const blocks = toBlocks(await readBlocks(db, tenant, documentId));
  const filteredBlockCount = (await readBlocks(db, tenant, documentId, { filtered: true })).length;
  const initialItems: CandidateItem[] = await readCandidateItems(db, tenant, documentId);
  if (!blocks.length) throw new JobError('KNOWLEDGE_NO_BLOCKS', '缺少正文 block，请重新上传文档');
  if (!initialItems.length) throw new JobError('KNOWLEDGE_NO_CANDIDATES', '缺少候选知识条目，请等待条目提取完成');

  const blockOrder = blockOrderOf(blocks);
  const candidateItemIds = new Set(initialItems.map((item) => item.id));
  const allItemIds = initialItems.map((item) => item.id);
  // 与准备相同的统一分段，匹配的块前缀与提取、补充逐字相同。
  const { segments: blockSegments } = buildUnifiedBlockSegments(blocks, contextLengthLimit);
  const budget = requestBudget(contextLengthLimit);
  const fingerprintOf = (segment: BlockSegment): MatchFingerprint => ({ block_ids: [...segment.blockIds], item_ids: [...allItemIds] });

  const existingBatches = force ? [] : await readMatchBatches(db, tenant, documentId);
  const planned = new Map(blockSegments.map((segment) => [segment.index, fingerprintOf(segment)]));
  const mismatch = existingBatches.some((batch) => {
    const fingerprint = planned.get(batch.batchIndex);
    return !fingerprint || !sameFingerprint(readFingerprint(batch.itemIds), fingerprint);
  });
  if (mismatch && existingBatches.length) await clearMatchBatches(db, tenant, documentId);

  const matches: Match[] = [];
  await run.saveStep('match_batches', { status: 'running' });
  await run.update({
    status: 'matching',
    progress: 66,
    message: blockSegments.length > 1 ? `开始按上下文自动分段匹配，共 ${blockSegments.length} 段` : '开始匹配段落',
    lastBatchSize: blockSegments.length,
  });
  await context.log(blockSegments.length > 1 ? `开始匹配段落，共 ${blockSegments.length} 段。` : '开始匹配段落。');

  for (const segment of blockSegments) {
    const segmentBlockOrder = blockOrderOf(segment.blocks);
    const fingerprint = fingerprintOf(segment);
    const saved = await getMatchBatch(db, tenant, documentId, segment.index);
    if (saved?.status === 'success' && sameFingerprint(readFingerprint(saved.itemIds), fingerprint) && Array.isArray(saved.matches)) {
      matches.push(...(saved.matches as Match[]));
      continue;
    }
    await run.update({
      status: 'matching',
      progress: Math.min(88, 66 + Math.round((segment.index / blockSegments.length) * 22)),
      message: blockSegments.length > 1 ? `AI 正在匹配段落 第 ${segment.index}/${blockSegments.length} 段` : 'AI 正在匹配段落',
    });
    await saveMatchBatch(db, tenant, documentId, segment.index, { status: 'running', itemIds: fingerprint, matches: [] });
    try {
      const chat = await run.jobChat();
      const stepKey = blockSegments.length > 1 ? `match:segment:${segment.index}` : 'match';
      const jsonOptions = { progressLabel: '知识库段落匹配', failureMessage: '知识库段落匹配失败，AI 未返回有效 JSON', onProgress: run.onProgress };
      const fullMessages = buildMatchMessages(document.fileName, segment.text, initialItems, segment);
      let segmentMatches: Match[];
      if (messagesContentLength(fullMessages) <= budget) {
        const parsed = await chat.json(stepKey, fullMessages, jsonOptions);
        segmentMatches = normalizeMatchResult(parsed, candidateItemIds, segment.blocks, segmentBlockOrder).matches;
      } else {
        // 条目子批：块前缀不变，只拆分任务中的条目列表。
        const prefix = buildDocumentBlocksPrefixMessage(segment.text, segment);
        const itemSegments = packItemsIntoSegments(initialItems, itemSplitBudget(contextLengthLimit, [prefix, buildMatchTaskMessage(document.fileName, [])]));
        await context.log(`第 ${segment.index} 段的条目分 ${itemSegments.length} 批匹配。`);
        // 各条目批次共用本段的块前缀，多批时先预热。
        if (itemSegments.length > 1) await run.warmPrefix(chat, `${stepKey}:warmup`, prefix, '知识库文档内容');
        const lists: Match[][] = [];
        for (const itemSegment of itemSegments) {
          const parsed = await chat.json(`${stepKey}:items:${itemSegment.index}`, buildMatchMessages(document.fileName, segment.text, itemSegment.items, segment), jsonOptions);
          lists.push(normalizeMatchResult(parsed, new Set(itemSegment.itemIds), segment.blocks, segmentBlockOrder).matches);
        }
        segmentMatches = recompressMatches(mergeMatchResults(lists), segmentBlockOrder);
      }
      await saveMatchBatch(db, tenant, documentId, segment.index, { status: 'success', itemIds: fingerprint, matches: segmentMatches });
      matches.push(...segmentMatches);
    } catch (error) {
      if (!isJobStop(context, error) && !isDocumentGone(error)) {
        const message = error instanceof JobError ? error.message : FAILED_MESSAGE;
        await saveMatchBatch(db, tenant, documentId, segment.index, { status: 'error', itemIds: fingerprint, error: message }).catch(() => {});
        await run.saveStep('match_batches', { status: 'error', error: message }).catch(() => {});
      }
      throw error;
    }
  }

  const mergedMatches = mergeMatchResults([matches])
    .map((match) => {
      const ranges = normalizeRanges(match.ranges, blockOrder);
      return { id: match.id, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) };
    })
    .filter((match) => match.ranges.length);
  await run.saveStep('match_batches', {
    status: 'success',
    result: { batch_size: blockSegments.length, batch_count: blockSegments.length, segment_count: blockSegments.length },
  });

  // recover_missing
  const recoveryStep = await run.step('recover_missing');
  let recovery: RecoveryResult;
  if (!force && recoveryStep?.status === 'success' && isRecoveryResult(recoveryStep.result)) {
    recovery = recoveryStep.result;
  } else {
    await run.clearFrom('recover_missing');
    recovery = await run.runStep('recover_missing', () => recoverMissing(context, run, options, document.fileName, blocks, blockOrder, initialItems, mergedMatches));
  }

  // save_result
  const savedItems = await readItems(db, tenant, documentId);
  const saveStep = await run.step('save_result');
  await run.flushLogs();
  if (!force && saveStep?.status === 'success' && savedItems.length) {
    await run.update({ status: 'success', progress: 100, message: `整理完成，共 ${savedItems.length} 条`, itemCount: savedItems.length });
    await context.log(`整理完成，共 ${savedItems.length} 条。`);
    return;
  }
  if (context.signal.aborted) throw new JobInterruptedError();
  await run.update({ status: 'saving', progress: 98, message: '正在回填正文并保存知识条目' });
  const saved = await run.runStep('save_result', async () => {
    const finalItems = createFinalItems(recovery.items, recovery.matches, blocks, document.fileName);
    const report = createReport({
      blocks,
      filteredBlockCount,
      candidateItems: recovery.items,
      finalItems,
      matches: recovery.matches,
      discarded: recovery.discarded,
      systemDiscarded: recovery.system_discarded,
      recoveryAttempts: recovery.recovery_attempts,
      batchSize: blockSegments.length,
    });
    await saveMatchResult(db, tenant, documentId, {
      candidateItems: recovery.items,
      finalItems,
      discarded: recovery.discarded.map((group) => ({ blockIds: group.block_ids, reason: group.reason })),
      systemDiscardedAfterRetry: recovery.system_discarded.map((group) => ({ blockIds: group.block_ids, reason: group.reason })),
      report: {
        totalBlocks: report.total_blocks,
        filteredBlocksCount: report.filtered_blocks_count,
        candidateItemsCount: report.candidate_items_count,
        finalItemsCount: report.final_items_count,
        matchedBlocksCount: report.matched_blocks_count,
        discardedBlocksCount: report.discarded_blocks_count,
        systemDiscardedAfterRetryCount: report.system_discarded_after_retry_count,
        newItemsFromRecoveryCount: report.new_items_from_recovery_count,
        recoveryAttemptCount: report.recovery_attempt_count,
        batchSize: report.batch_size,
        coverageRate: report.coverage_rate,
        matchedRate: report.matched_rate,
      },
    });
    return { final_item_count: finalItems.length, report };
  });
  await run.update({
    status: 'success',
    progress: 100,
    message: `整理完成，共 ${saved.final_item_count} 条，覆盖率 ${Math.round(saved.report.coverage_rate * 100)}%`,
    itemCount: saved.final_item_count,
    candidateItemCount: recovery.items.length,
    discardedBlockCount: saved.report.discarded_blocks_count,
    systemDiscardedAfterRetryCount: saved.report.system_discarded_after_retry_count,
  });
  await context.log(`整理完成，共 ${saved.final_item_count} 条。`);
}

/** 遗漏块补漏（与桌面版 recover_missing 步骤相同）：最多 2 轮，每轮按条目壳扣除预算后把遗漏块分段并发补漏，仍遗漏的由系统舍弃。 */
async function recoverMissing(
  context: JobContext<PrepareParams>,
  run: DocumentRun,
  options: KnowledgeJobOptions,
  fileName: string,
  blocks: readonly Block[],
  blockOrder: ReadonlyMap<string, number>,
  initialItems: readonly CandidateItem[],
  mergedMatches: readonly Match[],
): Promise<RecoveryResult & Record<string, unknown>> {
  const contextLengthLimit = options.contextLengthLimit ?? DEFAULT_CONTEXT_LENGTH_LIMIT;
  const items: CandidateItem[] = [...initialItems];
  const recoveredMatches: Match[] = [...mergedMatches];
  const discarded: DiscardedBlocks[] = [];
  const systemDiscarded: SystemDiscarded[] = [];
  const recoveryAttempts: RecoveryAttempt[] = [];
  const jsonOptions = { progressLabel: '知识库遗漏补漏', failureMessage: '知识库遗漏段落补漏失败，AI 未返回有效 JSON', onProgress: run.onProgress };

  for (let attempt = 0; attempt < RECOVERY_MAX_ATTEMPTS; attempt += 1) {
    const missingBlocks = missingBlocksOf(blocks, recoveredMatches, discarded, systemDiscarded);
    if (!missingBlocks.length) break;
    await run.update({
      status: 'recovering',
      progress: Math.min(96, 90 + attempt * 3),
      message: `AI 正在补漏遗漏段落 ${attempt + 1}/${RECOVERY_MAX_ATTEMPTS}，剩余 ${missingBlocks.length} 个 block`,
    });

    const currentItemIds = new Set(items.map((item) => item.id));
    // 遗漏块在前：用任务与条目的壳扣除预算后切分遗漏块。
    const budget = requestBudget(contextLengthLimit);
    const missingSegments = packBlocksIntoSegments(missingBlocks, Math.max(1, budget - messagesContentLength([buildRecoveryTaskMessage(fileName, items)])));
    if (!missingSegments.length) break;
    await context.log(
      missingSegments.length > 1
        ? `补漏第 ${attempt + 1} 轮：${missingBlocks.length} 个遗漏块，分 ${missingSegments.length} 段。`
        : `补漏第 ${attempt + 1} 轮：${missingBlocks.length} 个遗漏块。`,
    );
    const chat = await run.jobChat();

    const runMissingSegment = async (missingSegment: BlockSegment): Promise<RecoveryParsed> => {
      const segmentBlockOrder = blockOrderOf(missingSegment.blocks);
      const stepKey = `recovery:${attempt + 1}${missingSegments.length > 1 ? `:segment:${missingSegment.index}` : ''}`;
      const fullMessages = buildRecoveryMessages(fileName, items, missingSegment.blocks, missingSegment);
      if (messagesContentLength(fullMessages) <= budget) {
        const parsed = await chat.json(stepKey, fullMessages, jsonOptions);
        return normalizeRecoveryResult(parsed, currentItemIds, missingSegment.blocks, segmentBlockOrder);
      }
      const prefix = buildMissingBlocksPrefixMessage(missingSegment.blocks, missingSegment);
      const itemSegments = packItemsIntoSegments(items, itemSplitBudget(contextLengthLimit, [prefix, buildRecoveryTaskMessage(fileName, [])]));
      // 各条目批次共用本段的遗漏块前缀，多批时先预热。
      if (itemSegments.length > 1) await run.warmPrefix(chat, `${stepKey}:warmup`, prefix, '知识库遗漏内容');
      const parsedList: RecoveryParsed[] = [];
      for (const itemSegment of itemSegments) {
        const parsed = await chat.json(`${stepKey}:items:${itemSegment.index}`, buildRecoveryMessages(fileName, itemSegment.items, missingSegment.blocks, missingSegment), jsonOptions);
        parsedList.push(normalizeRecoveryResult(parsed, new Set(itemSegment.itemIds), missingSegment.blocks, segmentBlockOrder));
      }
      return mergeRecoverySegmentResults(parsedList, currentItemIds, segmentBlockOrder);
    };

    // 各段遗漏块互不相同，没有可共用的前缀，直接并发。
    const parsedList = await runParallelAndThrowAfterSettled(missingSegments.map((segment) => () => runMissingSegment(segment)));

    // 以上游过滤后的块为准再压成区间，不用模型给出的区间再展开。
    const parsedMatches = recompressMatches(
      mergeMatchResults(parsedList.map((parsed) => parsed.matches)),
      blockOrder,
      currentItemIds,
    );
    const newItems = parsedList
      .flatMap((parsed) => parsed.new_items)
      .map((item) => {
        const blockIds = [...new Set(item.block_ids || [])].filter((id) => blockOrder.has(id));
        const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
        if (!ranges.length) return null;
        const next = { id: nextKnowledgeItemId(items), title: item.title, summary: item.summary };
        items.push(next);
        recoveredMatches.push({ id: next.id, ranges, block_ids: blockIds });
        return { ...next, ranges, block_ids: blockIds };
      })
      .filter((item) => item !== null);
    const parsedDiscarded = parsedList
      .flatMap((parsed) => parsed.discarded)
      .map((item): DiscardedBlocks | null => {
        const blockIds = [...new Set(item.block_ids || [])].filter((id) => blockOrder.has(id));
        const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
        return ranges.length ? { ranges, block_ids: blockIds, reason: item.reason || 'AI 建议舍弃', source: `recovery_${attempt + 1}` } : null;
      })
      .filter((item): item is DiscardedBlocks => item !== null);

    recoveredMatches.push(...parsedMatches);
    discarded.push(...parsedDiscarded);
    recoveryAttempts.push({
      attempt: attempt + 1,
      missing_before_count: missingBlocks.length,
      segment_count: missingSegments.length,
      matches: parsedMatches,
      new_items: newItems,
      discarded: parsedDiscarded,
    });
  }

  const remaining = missingBlocksOf(blocks, recoveredMatches, discarded, systemDiscarded);
  if (remaining.length) systemDiscarded.push({ block_ids: remaining.map((block) => block.id), reason: 'system_discarded_after_retry' });
  return { items, matches: recoveredMatches, discarded, system_discarded: systemDiscarded, recovery_attempts: recoveryAttempts };
}

/** 失败、取消时把文档标为 error（文档已删除时忽略）。 */
async function markFailed(context: JobContext<PrepareParams>, message: string): Promise<void> {
  try {
    await updateDocumentState(context.db, context.tenant, context.params.documentId, { status: 'error', progress: 100, message, error: message });
  } catch (error) {
    if (!isDocumentGone(error)) throw error;
  }
}

/** 两种任务共用的收尾：文档已删除时正常结束，失败、取消时把文档标为 error，暂停、余额不足、中断时不改写文档。 */
async function runDocumentJob(context: JobContext<PrepareParams>, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (isDocumentGone(error)) {
      await context.log('文档已删除，停止处理。');
      return;
    }
    if (isJobStop(context, error)) {
      if (context.signal.reason === 'cancel') await markFailed(context, CANCELLED_MESSAGE);
      throw error;
    }
    if (error instanceof JobError) {
      await markFailed(context, error.message);
      throw error;
    }
    if (error instanceof AppError) {
      await markFailed(context, error.message);
      throw new JobError(error.code, error.message, { cause: error });
    }
    // 程序错误（数据库、对象存储故障等）：文档写“处理失败”，原错误交给执行者写日志（任务记为 JOB_FAILED）。
    await markFailed(context, FAILED_MESSAGE);
    throw error;
  }
}

export function createKnowledgePrepareJob(options: KnowledgeJobOptions = {}): JobTypeDefinition<PrepareParams> {
  return {
    type: KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams,
    run: (context) => runDocumentJob(context, () => prepareDocument(context, options)),
  };
}

export function createKnowledgeMatchJob(options: KnowledgeJobOptions = {}): JobTypeDefinition<MatchParams> {
  return {
    type: KNOWLEDGE_DOCUMENT_MATCH_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams: parseMatchParams,
    run: (context) =>
      runDocumentJob(context, async () => {
        await context.log('开始匹配知识库文档。');
        await matchDocument(context, new DocumentRun(context, options), options, context.params.force);
      }),
  };
}

export const knowledgeBaseJobs: JobTypeDefinition<any>[] = [createKnowledgePrepareJob(), createKnowledgeMatchJob()];

// ---- 接口用：文档与任务、入队、重试、取消 ----

export interface KnowledgeDocumentView extends KnowledgeDocument {
  /** 文档最近一次的处理任务；没有时为 null。 */
  job: JobRecord | null;
}

/**
 * 文档附上最近的任务。处理中的文档没有未结束的任务时按中断显示（status = error，文案与桌面版启动时的 recoverInterruptedDocuments
 * 相同），只改读出的状态、不写库。先读任务再读文档（调用方传入的文档须在读任务之后读出），任务已结束而文档仍在处理中即确为中断。
 */
export function documentView(document: KnowledgeDocument, job: JobRecord | null): KnowledgeDocumentView {
  if (PROCESSING_STATUSES.has(document.status) && (!job || isFinalStatus(job.status))) {
    return { ...document, status: 'error', message: INTERRUPTED_MESSAGE, error: INTERRUPTED_MESSAGE, job };
  }
  return { ...document, job };
}

/** 本组织各文档最近的处理任务（documentIds 不给出时为全部文档）。 */
export async function latestDocumentJobs(db: Kysely<Database>, context: TenantContext, documentIds?: readonly string[]): Promise<Map<string, JobRecord>> {
  return withTenant(db, context, (trx) => latestLockKeyJobs(trx, LOCK_KEY_PREFIX, KNOWLEDGE_JOB_TYPES, documentIds));
}

/** 读取单个文档并附上任务（先读任务，见 documentView）。 */
export async function getDocumentView(db: Kysely<Database>, context: TenantContext, documentId: string): Promise<KnowledgeDocumentView> {
  const jobs = await latestDocumentJobs(db, context, [documentId]);
  return documentView(await getDocument(db, context, documentId), jobs.get(documentId) ?? null);
}

function busy(): AppError {
  return new AppError(409, 'KNOWLEDGE_DOCUMENT_BUSY', '该文档正在处理中');
}

async function enqueuePreparation(jobs: JobServiceDependencies, context: TenantContext, documentId: string): Promise<JobRecord> {
  return enqueueJob(jobs, context, {
    type: KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE,
    projectId: null,
    lockKey: knowledgeDocumentLockKey(documentId),
    params: { documentId },
  });
}

/**
 * 新挂的文档逐个入队处理（取代桌面版 uploadDocuments 中的 prepareDocument）。余额不足等入队失败时文档标为 error 并写入原因，
 * 充值后可以重试；已有处理任务时跳过。
 */
export async function startNewDocuments(jobs: JobServiceDependencies, context: TenantContext, documentIds: readonly string[]): Promise<void> {
  for (const documentId of documentIds) {
    try {
      await enqueuePreparation(jobs, context, documentId);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === 'JOB_LOCKED') continue;
      await updateDocumentState(jobs.db, context, documentId, { status: 'error', progress: 100, message: error.message, error: error.message }).catch((writeError: unknown) => {
        if (!isDocumentGone(writeError)) throw writeError;
      });
    }
  }
}

/**
 * 重试（取代桌面版 retryDocument）：只有失败（含按中断显示）的文档可以重试，已成功的步骤续用。文档先标为等待处理再入队，
 * 入队失败（余额不足等）时恢复为 error 并写入原因。返回文档与新任务。
 */
export async function retryDocument(jobs: JobServiceDependencies, context: TenantContext, documentId: string): Promise<KnowledgeDocumentView> {
  const view = await getDocumentView(jobs.db, context, documentId);
  if (view.job && !isFinalStatus(view.job.status)) throw busy();
  if (view.status !== 'error') throw new AppError(409, 'KNOWLEDGE_DOCUMENT_NOT_RETRYABLE', '只有解析失败的文档可以重试');
  await updateDocumentState(jobs.db, context, documentId, { status: 'pending', progress: 0, message: '等待处理', error: null });
  try {
    const job = await enqueuePreparation(jobs, context, documentId);
    return { ...(await getDocument(jobs.db, context, documentId)), job };
  } catch (error) {
    if (error instanceof AppError && error.code === 'JOB_LOCKED') throw busy();
    if (error instanceof AppError) {
      await updateDocumentState(jobs.db, context, documentId, { status: 'error', progress: 100, message: error.message, error: error.message });
    }
    throw error;
  }
}

/** 可以开始匹配的状态（与桌面版 startMatching 相同）。 */
const MATCHABLE_STATUSES: ReadonlySet<KnowledgeDocumentStatus> = new Set(['ready_for_matching', 'success', 'error']);
/** 正在匹配的状态：已有任务时按“正在匹配中”提示。 */
const MATCHING_STATUSES: ReadonlySet<KnowledgeDocumentStatus> = new Set(['ready_for_matching', 'matching', 'recovering', 'saving', 'success']);

/**
 * 开始匹配（取代桌面版 startMatching）：候选条目提取完成、处理完成或失败（含按中断显示）的文档可以开始匹配，已处理完成的
 * 文档重新匹配（force，任务开始时清除匹配批次及之后的结果）。已有处理任务时 409。文档先标为等待匹配再入队，入队失败
 * （余额不足等）时恢复原来的状态。返回文档与新任务。
 */
export async function startMatching(jobs: JobServiceDependencies, context: TenantContext, documentId: string): Promise<KnowledgeDocumentView> {
  const view = await getDocumentView(jobs.db, context, documentId);
  if (view.job && !isFinalStatus(view.job.status)) {
    if (MATCHING_STATUSES.has(view.status)) throw new AppError(409, 'KNOWLEDGE_DOCUMENT_BUSY', '该文档正在匹配中');
    throw notMatchable();
  }
  if (!MATCHABLE_STATUSES.has(view.status)) throw notMatchable();
  const previous = await getDocument(jobs.db, context, documentId);
  await updateDocumentState(jobs.db, context, documentId, { status: 'matching', progress: 65, message: '等待匹配段落', error: null });
  try {
    const job = await enqueueJob(jobs, context, {
      type: KNOWLEDGE_DOCUMENT_MATCH_JOB_TYPE,
      projectId: null,
      lockKey: knowledgeDocumentLockKey(documentId),
      params: { documentId, force: view.status === 'success' },
    });
    return { ...(await getDocument(jobs.db, context, documentId)), job };
  } catch (error) {
    await updateDocumentState(jobs.db, context, documentId, {
      status: previous.status,
      progress: previous.progress,
      message: previous.message,
      error: previous.error,
    }).catch((writeError: unknown) => {
      if (!isDocumentGone(writeError)) throw writeError;
    });
    if (error instanceof AppError && error.code === 'JOB_LOCKED') throw new AppError(409, 'KNOWLEDGE_DOCUMENT_BUSY', '该文档正在匹配中');
    throw error;
  }
}

function notMatchable(): AppError {
  return new AppError(409, 'KNOWLEDGE_DOCUMENT_NOT_MATCHABLE', '请等待候选知识条目提取完成');
}

/** 取消这些文档未结束的处理任务（删除文档、文件夹之后调用）。不等待执行者退出：其后续写入因文档不可见而失败、任务停止。 */
export async function cancelDocumentJobs(jobs: JobServiceDependencies, context: TenantContext, documentIds: readonly string[]): Promise<void> {
  for (const documentId of documentIds) {
    const active = await listJobs(jobs.db, context, { lockKey: knowledgeDocumentLockKey(documentId), active: true, limit: 5 });
    for (const job of active) {
      try {
        await cancelJob(jobs, context, job.id);
      } catch (error) {
        if (error instanceof AppError && (error.code === 'JOB_FINISHED' || error.code === 'JOB_NOT_FOUND')) continue;
        throw error;
      }
    }
  }
}

