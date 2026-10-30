// 知识库文档准备任务（路线图第 6 步 6.13a；取代桌面版 knowledgeBaseService.cjs 的 prepareDocument、retryDocument 与启动时的
// recoverInterruptedDocuments）：knowledge-document-prepare，ai 队列，会调用模型（入队检查最低启动余额），组织级（没有项目）。
// 同一文档同时只有一个处理任务（lock_key 为 knowledge-document:{documentId}，与桌面版 activePreparations / activeMatches 相同）。
//
// 流程与桌面版相同，按 knowledge_document_steps 逐步执行、已成功的步骤续用：
//   copy_source（Web 版原件已在对象存储中，只记一步）→ convert_markdown（在断网的 parse 沙箱中解析，经 writeArtifact 写入
//   Markdown 产物）→ build_blocks（切块与筛选，src/knowledgeBase/prepare.ts）→ extract_first_items / extract_supplement_items
//   （按统一分段并发调用模型，先按段预热块前缀）→ merge_candidates（合并为候选条目）→ 文档停在 ready_for_matching。
//   段落匹配、遗漏补漏与保存结果（桌面版非开发者模式下接着自动执行）随 6.13b。
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
// - 任务日志只写阶段与段数，不写文件名、文档正文和模型输出。
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
import { findDocumentMarkdown, readBlocks, readCandidateItems, saveBlocks, saveCandidateItems } from './content.ts';
import {
  buildBlocks,
  buildInitialItemMessages,
  buildSupplementItemMessages,
  buildUnifiedBlockSegments,
  mergeCandidateItems,
  mergeTitleSummaryItems,
  normalizeCandidateItems,
  stripMarkdownFence,
  type Block,
  type BlockSegment,
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
/** 知识库的任务类型（6.13b 加入匹配）。 */
export const KNOWLEDGE_JOB_TYPES: readonly string[] = Object.freeze([KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE]);

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseParams(raw: unknown): PrepareParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('知识库任务参数不合法');
  const { documentId, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof documentId !== 'string' || !UUID.test(documentId)) throw new TypeError('知识库任务参数不合法');
  return { documentId };
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

class Preparation {
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

  /** 块前缀由首轮提取、补充提取（6.13b 起还有匹配）共用，在本次第一个实际执行的阶段按段预热一次（与桌面版相同）。 */
  async warmBlockPrefixes(chat: JobChat, segments: readonly BlockSegment[], prefix: (segment: BlockSegment) => ChatMessage): Promise<void> {
    if (this.blockPrefixWarmed) return;
    this.blockPrefixWarmed = true;
    const settleMs = this.options.warmupSettleMs ?? PREFIX_WARMUP_SETTLE_MS;
    await Promise.all(
      segments.map(async (segment) => {
        try {
          await chat.text(segments.length > 1 ? `warmup:segment:${segment.index}` : 'warmup', [prefix(segment)], '知识库文档内容', {
            maxOutputTokens: 1,
            allowEmpty: true,
          });
          await abortableDelay(settleMs, this.context.signal);
        } catch (error) {
          if (isJobStop(this.context, error)) throw error;
          this.onProgress('知识库文档内容缓存预热失败，直接继续');
        }
      }),
    );
  }

  async flushLogs(): Promise<void> {
    await this.logChain.catch(() => {});
  }
}

async function prepareDocument(context: JobContext<PrepareParams>, options: KnowledgeJobOptions): Promise<void> {
  const { db, tenant, params } = context;
  const documentId = params.documentId;
  const run = new Preparation(context, options);
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

  // 统一分段：首轮提取、补充提取（6.13b 起还有匹配）共用同一段表，块前缀逐字相同。
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
  // 段落匹配随 6.13b（桌面版开发者模式的文案：停在待匹配）。
  await run.update({
    status: 'ready_for_matching',
    progress: 65,
    message: `已提取 ${candidates.length} 条候选知识，可开始自动分段匹配`,
    candidateItemCount: candidates.length,
    itemCount: 0,
  });
  await context.log(`已提取 ${candidates.length} 条候选知识。`);
}

/** 失败、取消时把文档标为 error（文档已删除时忽略）。 */
async function markFailed(context: JobContext<PrepareParams>, message: string): Promise<void> {
  try {
    await updateDocumentState(context.db, context.tenant, context.params.documentId, { status: 'error', progress: 100, message, error: message });
  } catch (error) {
    if (!isDocumentGone(error)) throw error;
  }
}

export function createKnowledgePrepareJob(options: KnowledgeJobOptions = {}): JobTypeDefinition<PrepareParams> {
  return {
    type: KNOWLEDGE_DOCUMENT_PREPARE_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams,
    async run(context) {
      try {
        await prepareDocument(context, options);
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
    },
  };
}

export const knowledgeBaseJobs: JobTypeDefinition<any>[] = [createKnowledgePrepareJob()];

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

