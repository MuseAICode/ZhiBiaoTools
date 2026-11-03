// 标书查重分析任务（路线图第 6 步 6.10；取代桌面版 taskService.cjs 的 duplicate-analysis 与 duplicateCheckService.cjs 的
// runAnalysisTask），ai 队列（docs/SERVER_DESIGN.md 第 5.2 节），不调用模型（不检查余额）。同一项目同时只有一个分析任务
// （lock_key 为 project:{projectId}:duplicate-check，与桌面版同组互斥相同）。
//
// 流程与桌面版相同，分为提取和比对两部分：
// - 元数据：投标文件的基本信息（文件名、扩展名、大小、SHA-256）与文档格式自身的元数据（6.10b：docx 的属性与 rsid，老式 Word 的
//   OLE 属性集、存储结构与疑似账号痕迹及转成 docx 后的属性，PDF 的 Info / XMP / 原始记录 / 结构 / 签名与附件），后者每份文件
//   在一个只提取元数据的 parse 沙箱中读取（server/sandbox/parse/duplicateMetadata.mjs，输出 metadata.json），校验后并入；
// - 正文提取：招标文件、投标文件逐个在断网的 parse 沙箱中解析（保留图片），写入 Markdown 与图片产物；沙箱同时做逐文档的
//   文本提取（目录、句子、图片位置，server/sandbox/parse/duplicateText.mjs，输出 analysis.json），任务进程内不解析上传的内容；
// - 比对（src/duplicateCheck/analysis.ts）：招标原文白名单、目录的重复 / 相似组与两两相似度、重复句、重复图片（按图片内容的 SHA-256）。
//   投标文件逐个提取后立即计入比对，不在内存中保留全部正文；
// - 写入一律经 saveAnalysisSection，带任务开始时的文件选择签名：重新选择文件或清空后写入被拒绝（接口另外取消进行中的任务）；
// - 可续跑：worker 崩溃或关闭后从头重新执行（开始时把这些文件之前的产物标为已被替换）；暂停、中断、取消时不改写结果
//   （仍是 running），任务已结束而结果仍是 running 时按未完成显示（store.ts）；
// - 单个文件解析失败不影响其他文件（与桌面版相同），任务最后以“部分结果失败”结束；程序错误交给执行者写日志。
import { supersedeArtifacts } from '../artifacts/store.ts';
import type { DuplicateCheckSection } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { findFile } from '../files/store.ts';
import { JobError, JobInterruptedError, type JobContext, type JobTypeDefinition } from '../jobs/definitions.ts';
import { cancelJob, enqueueJob, type JobServiceDependencies } from '../jobs/service.ts';
import { listJobs, type JobRecord } from '../jobs/store.ts';
import { extractMetadataInSandbox, LOCAL_PARSER_LABEL, parseFailureOf, parseFileInSandbox, writeParseArtifacts, type WrittenImage } from '../parse/run.ts';
import {
  basicMetadataFields,
  buildDuplicateImages,
  buildDuplicateSentences,
  buildOutlineComparison,
  buildTenderSourceMatcher,
  DuplicateAnalysisError,
  matchTenderSentence,
  mergeDocumentMetadata,
  mergeTenderSentences,
  metadataItems,
  parseDocumentMetadata,
  parseDuplicateAnalysis,
  type ContentSentence,
  type DocumentAnalysis,
  type GlobalImage,
  type GlobalSentence,
  type OutlineFile,
  type TenderSentence,
} from './analysis.ts';
import {
  DUPLICATE_ANALYSIS_JOB_TYPE,
  duplicateCheckLockKey,
  readAnalysisInputs,
  saveAnalysisSection,
  type ContentFileInput,
  type DuplicateCheckFile,
  type ImageFileInput,
  type MetadataFileInput,
  type SectionInputs,
} from './store.ts';

export { DUPLICATE_ANALYSIS_JOB_TYPE };

export interface DuplicateAnalysisParams {
  /** 已有当前签名下全部成功的结果时也重新分析（桌面版的“重新分析”）。 */
  force: boolean;
}

function parseParams(raw: unknown): DuplicateAnalysisParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('标书查重任务参数不合法');
  const { force, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof force !== 'boolean') throw new TypeError('标书查重任务参数不合法');
  return { force };
}

const SECTIONS: readonly DuplicateCheckSection[] = ['metadata', 'outline', 'content', 'image'];

/** 桌面版 readContentMarkdown 在正文未提取成功时的说明（目录、正文、图片三类比对共用）。 */
const CONTENT_MISSING_MESSAGE = '正文内容尚未成功提取，无法进行目录分析';

/** 写入被拒绝：任务开始后重新选择了文件或清空。 */
class SelectionChangedError extends Error {
  constructor() {
    super('duplicate-check selection changed');
    this.name = 'SelectionChangedError';
  }
}

const yieldControl = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 暂停、中断（租约丢失、worker 关闭）与取消：不改写结果，由执行者按任务状态收尾。 */
function isStop(context: JobContext<unknown>, error: unknown): boolean {
  return context.signal.aborted || error instanceof JobInterruptedError;
}

/** 一份文件提取成功后留给比对的内容。 */
interface Extracted {
  analysis: DocumentAnalysis;
  /** 解析输出中的图片路径 → 写入的产物与内容哈希。 */
  images: Map<string, WrittenImage>;
}

export interface DuplicateAnalysisJobOptions {
  /** 沙箱数已达上限时重试创建前的等待（毫秒），见 src/parse/run.ts。 */
  createRetryDelaysMs?: readonly number[];
}

export function createDuplicateAnalysisJob(options: DuplicateAnalysisJobOptions = {}): JobTypeDefinition<DuplicateAnalysisParams> {
  return {
    type: DUPLICATE_ANALYSIS_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    parseParams,
    async run(context) {
      const { db, tenant, params } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('DUPLICATE_CHECK_FAILED', '标书查重分析失败');
      const inputs = await readAnalysisInputs(db, tenant, projectId);
      const { tenderFiles, bidFiles, signature } = inputs;
      if (bidFiles.length === 0) throw new JobError('DUPLICATE_CHECK_BID_MISSING', '请先上传至少一份投标文件');
      if (!params.force && SECTIONS.every((section) => inputs.sections[section]?.status === 'success' && inputs.sections[section]?.signature === signature)) {
        await context.log('标书查重分析已完成，无需重复分析。');
        return;
      }

      const save = async <S extends DuplicateCheckSection>(section: S, analysis: SectionInputs[S]): Promise<void> => {
        if (!(await saveAnalysisSection(db, tenant, projectId, section, analysis, { expectedSignature: signature }))) throw new SelectionChangedError();
      };
      try {
        await analyze(context, projectId, signature, tenderFiles, bidFiles, save);
      } catch (error) {
        if (error instanceof SelectionChangedError) {
          await context.log('文件选择已变化，本次分析结果已丢弃');
          throw new JobError('DUPLICATE_CHECK_INPUT_CHANGED', '文件选择已变化，本次分析结果已丢弃，请重新分析');
        }
        throw error;
      }
    },
  };

  async function analyze(
    context: JobContext<DuplicateAnalysisParams>,
    projectId: string,
    signature: string,
    tenderFiles: readonly DuplicateCheckFile[],
    bidFiles: readonly DuplicateCheckFile[],
    save: <S extends DuplicateCheckSection>(section: S, analysis: SectionInputs[S]) => Promise<void>,
  ): Promise<void> {
    const { db, tenant } = context;
    const allFiles = [...tenderFiles, ...bidFiles];
    const bidTotal = bidFiles.length;

    // ---- 初始状态（与桌面版 createInitial*Analysis 相同），四类结果一并清空 ----
    await context.log(context.params.force ? '开始重新执行标书查重分析。' : '开始执行标书查重分析。');
    const startedAt = null;
    await save('metadata', {
      status: 'running',
      progress: 0,
      message: '正在启动元数据分析',
      signature,
      startedAt,
      contentExtraction: { status: 'running', completed: 0, total: 0 },
      metadataExtraction: { status: 'running', completed: 0, total: bidTotal },
      files: [],
      contentFiles: [],
      logs: [],
    });
    const pendingExtraction = { status: 'pending' as const, completed: 0, total: bidTotal };
    await save('outline', {
      status: 'pending',
      progress: 0,
      message: '等待元数据提取完成后开始目录分析',
      signature,
      startedAt,
      tenderSentenceCount: 0,
      tenderMatchedItemCount: 0,
      extraction: pendingExtraction,
      files: [],
      duplicateGroups: [],
      pairwiseSimilarities: [],
    });
    await save('content', {
      status: 'pending',
      progress: 0,
      message: '等待正文内容提取完成后开始正文比对',
      signature,
      startedAt,
      tenderSentenceCount: 0,
      tenderMatchedSentenceCount: 0,
      totalSentenceCount: 0,
      extraction: pendingExtraction,
      duplicateSentences: [],
    });
    await save('image', {
      status: 'pending',
      progress: 0,
      message: '等待正文内容提取完成后开始图片比对',
      signature,
      startedAt,
      extraction: pendingExtraction,
      totalImageCount: 0,
      files: [],
      duplicateImages: [],
    });
    // 之前（含上次中断时写了一半）的正文与图片产物已不再被引用。
    for (const file of allFiles) await supersedeArtifacts(db, tenant, file.id, []);
    await context.setProgress(2);

    // ---- 元数据：投标文件的基本信息 + 文档格式的元数据（docx / 老式 Word / PDF 等，每份文件一个 parse 沙箱，6.10b） ----
    let unexpected: unknown = null;
    await save('metadata', { metadataExtraction: { status: 'running', completed: 0, total: bidTotal }, message: '正在提取投标文件元数据' });
    const records = new Map<string, Awaited<ReturnType<typeof findFile>>>();
    const metadataFiles: MetadataFileInput[] = [];
    for (const file of allFiles) records.set(file.id, await findFile(db, tenant, file.id));
    for (const file of bidFiles) {
      const record = records.get(file.id);
      if (!record) {
        metadataFiles.push({ fileId: file.id, status: 'error', error: '原件不存在，请重新上传', metadata: [] });
      } else {
        const basic = basicMetadataFields({ fileName: file.fileName, extension: file.extension, size: file.size, sha256: record.sha256 });
        try {
          const output = await extractMetadataInSandbox(context, record, options.createRetryDelaysMs ? { createRetryDelaysMs: options.createRetryDelaysMs } : {});
          const fields = output ? mergeDocumentMetadata(basic, parseDocumentMetadata(output)) : basic;
          metadataFiles.push({ fileId: file.id, status: 'success', metadata: metadataItems(fields) });
        } catch (error) {
          if (isStop(context, error)) throw error;
          // 沙箱层面的失败（超时、沙箱繁忙、输出不合规等）：保留文件基本信息，该文件记为失败。文档本身读取失败不在这里，
          // 由沙箱记为 metadata_error 字段（与桌面版相同）。
          const known = error instanceof DuplicateAnalysisError ? new JobError('PARSE_OUTPUT_REJECTED', '解析结果不符合要求，已拒绝') : parseFailureOf(error);
          if (!known) unexpected ??= error;
          const message = known?.message ?? '元数据提取失败';
          metadataFiles.push({ fileId: file.id, status: 'error', error: message, metadata: metadataItems(basic) });
          await context.log(`元数据提取失败：${message}`, { file: metadataFiles.length });
        }
      }
      await save('metadata', {
        metadataExtraction: { status: 'running', completed: metadataFiles.length, total: bidTotal },
        files: metadataFiles,
        message: `元数据提取 ${metadataFiles.length}/${bidTotal}`,
      });
      await context.setProgress(Math.min(5, Math.round(2 + (metadataFiles.length / bidTotal) * 3)));
    }
    const metadataFailed = metadataFiles.some((file) => file.status === 'error');
    await save('metadata', {
      metadataExtraction: { status: metadataFailed ? 'error' : 'success', completed: bidTotal, total: bidTotal },
      files: metadataFiles,
      message: `元数据提取 ${bidTotal}/${bidTotal}`,
    });
    await context.setProgress(5);

    // ---- 正文提取 ----
    const contentFiles: ContentFileInput[] = [];
    const total = allFiles.length;
    await save('metadata', { contentExtraction: { status: 'running', completed: 0, total }, message: '正在提取正文内容' });

    /** 在沙箱中解析一份文件并写入产物；失败时记下原因并返回 null（暂停、中断、取消照常抛出）。 */
    const extract = async (file: DuplicateCheckFile): Promise<Extracted | null> => {
      const record = records.get(file.id);
      let extracted: Extracted | null = null;
      try {
        if (!record) throw new JobError('PARSE_SOURCE_MISSING', '原件不存在，请重新上传');
        const parsed = await parseFileInSandbox(context, record, {
          images: true,
          analysis: 'duplicate-check',
          ...(options.createRetryDelaysMs ? { createRetryDelaysMs: options.createRetryDelaysMs } : {}),
        });
        // 先校验逐文档提取的结果，不合规时不写产物。
        const analysis = parseDuplicateAnalysis(parsed.output.analysis ?? Buffer.alloc(0), new Set(parsed.output.images.map((image) => image.path)));
        const written = await writeParseArtifacts(context, projectId, record, parsed);
        contentFiles.push({
          fileId: file.id,
          status: 'success',
          contentArtifactId: written.markdownArtifactId,
          contentLength: written.markdown.length,
          parserLabel: LOCAL_PARSER_LABEL,
          contentHash: written.contentHash,
          error: null,
        });
        extracted = { analysis, images: written.images };
      } catch (error) {
        if (isStop(context, error)) throw error;
        // 写了一半的产物（例如写到一半超出配额）标为已被替换；标记失败只写日志。
        await supersedeArtifacts(db, tenant, file.id, []).catch(() => context.log('解析失败的产物未能标记为已被替换').catch(() => {}));
        const known = error instanceof DuplicateAnalysisError ? new JobError('PARSE_OUTPUT_REJECTED', '解析结果不符合要求，已拒绝') : parseFailureOf(error);
        if (!known) unexpected ??= error;
        const message = known?.message ?? '正文提取失败';
        contentFiles.push({ fileId: file.id, status: 'error', contentArtifactId: null, contentLength: 0, parserLabel: null, contentHash: null, error: message });
        await context.log(`正文提取失败：${message}`, { file: contentFiles.length });
      }
      await save('metadata', {
        contentExtraction: { status: 'running', completed: contentFiles.length, total },
        contentFiles,
        message: `正文内容提取 ${contentFiles.length}/${total}`,
      });
      await context.setProgress(Math.min(90, Math.round(5 + (contentFiles.length / total) * 85)));
      return extracted;
    };

    // 招标文件：生成目录与正文比对的白名单（桌面版对合并的招标正文生成；有文件未提取成功时不用白名单，继续比对）。
    const tenderOutline: TenderSentence[][] = [];
    const tenderContent: ContentSentence[] = [];
    let tenderFailed = false;
    for (const file of tenderFiles) {
      const extracted = await extract(file);
      if (!extracted) tenderFailed = true;
      else {
        tenderOutline.push(extracted.analysis.tenderSentences);
        tenderContent.push(...extracted.analysis.sentences);
      }
    }
    const tenderSentences = tenderFailed ? [] : mergeTenderSentences(tenderOutline);
    const tenderMatcher = await buildTenderSourceMatcher(tenderFailed ? [] : tenderContent);
    tenderContent.length = 0;
    const whitelistFailure = tenderFailed ? `招标文件句子白名单生成失败，继续对比投标文件目录：${CONTENT_MISSING_MESSAGE}` : null;
    await save('outline', {
      status: 'running',
      progress: 5,
      extraction: { status: 'running', completed: 0, total: bidTotal },
      tenderSentenceCount: tenderSentences.length,
      message: whitelistFailure ?? '正在准备目录分析',
    });
    await save('content', {
      status: 'running',
      progress: 5,
      extraction: { status: 'running', completed: 0, total: bidTotal },
      tenderSentenceCount: tenderMatcher.tenderSentenceCount,
      message: tenderFailed ? `招标文件句子白名单生成失败，继续比对投标正文：${CONTENT_MISSING_MESSAGE}` : '正在准备正文比对',
    });
    await save('image', { status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidTotal }, message: '正在准备图片比对' });

    // ---- 投标文件：逐个提取并计入目录、正文、图片比对 ----
    const outlineFiles: (OutlineFile & { source: DocumentAnalysis['outline']['source']; confidence: number; error: string | null })[] = [];
    const globalSentences = new Map<string, GlobalSentence>();
    const globalImages = new Map<string, GlobalImage>();
    const imageFiles: ImageFileInput[] = [];
    let totalSentenceCount = 0;
    let tenderMatchedSentenceCount = 0;
    let tenderMatchedItemCount = 0;
    let totalImageCount = 0;
    let firstOrder = 0;
    let contentMessage: string | null = null;

    for (const [fileIndex, file] of bidFiles.entries()) {
      const extracted = await extract(file);
      if (!extracted) {
        outlineFiles.push({ fileId: file.id, status: 'error', items: [], source: null, confidence: 0, error: CONTENT_MISSING_MESSAGE });
        contentMessage = `${file.fileName} 正文比对失败：${CONTENT_MISSING_MESSAGE}`;
        imageFiles.push({ fileId: file.id, status: 'error', imageCount: 0, uniqueImageCount: 0, error: CONTENT_MISSING_MESSAGE });
      } else {
        const { analysis, images } = extracted;
        // 目录：标题来自招标原文的不参与比对。
        const items = analysis.outline.items.map((item) => {
          const matched = matchTenderSentence(item.normalizedTitle, tenderSentences);
          return { ...item, fromTender: Boolean(matched), matchedTenderSentence: matched?.text ?? null };
        });
        tenderMatchedItemCount += items.filter((item) => item.fromTender).length;
        outlineFiles.push({ fileId: file.id, status: 'success', items, source: analysis.outline.source, confidence: analysis.outline.confidence, error: null });

        // 正文：来自招标原文的句子不参与比对，其余按规范化的句子计数。
        totalSentenceCount += analysis.sentences.length;
        const local = new Map<string, { sentence: string; count: number; order: number }>();
        for (const [sentenceIndex, sentence] of analysis.sentences.entries()) {
          if (tenderMatcher.match(sentence)) tenderMatchedSentenceCount += 1;
          else {
            const current = local.get(sentence.normalized) ?? { sentence: sentence.sentence, count: 0, order: firstOrder++ };
            current.count += 1;
            local.set(sentence.normalized, current);
          }
          if ((sentenceIndex + 1) % 500 === 0) await yieldControl();
        }
        for (const [normalized, item] of local.entries()) {
          const global = globalSentences.get(normalized) ?? { sentence: item.sentence, normalized, fileIds: [], occurrences: {}, firstOrder: item.order };
          if (!global.fileIds.includes(file.id)) global.fileIds.push(file.id);
          global.occurrences[file.id] = item.count;
          globalSentences.set(normalized, global);
        }

        // 图片：按内容的 SHA-256 计数，记下每次出现的位置。
        totalImageCount += analysis.images.length;
        const localImages = new Map<string, { count: number; previewArtifactId: string; locations: GlobalImage['locations'][string] }>();
        for (const occurrence of analysis.images) {
          const image = images.get(occurrence.path);
          if (!image) continue;
          const current = localImages.get(image.sha256) ?? { count: 0, previewArtifactId: image.artifactId, locations: [] };
          current.count += 1;
          current.locations.push({ imageIndex: occurrence.index, directory: occurrence.directory, previousSentence: occurrence.previousSentence });
          localImages.set(image.sha256, current);
        }
        for (const [hash, item] of localImages.entries()) {
          const global = globalImages.get(hash) ?? { hash, previewArtifactId: item.previewArtifactId, fileIds: [], occurrences: {}, locations: {} };
          if (!global.fileIds.includes(file.id)) global.fileIds.push(file.id);
          global.occurrences[file.id] = item.count;
          global.locations[file.id] = item.locations;
          globalImages.set(hash, global);
        }
        imageFiles.push({ fileId: file.id, status: 'success', imageCount: analysis.images.length, uniqueImageCount: localImages.size, error: null });
      }

      const completed = fileIndex + 1;
      const extraction = { status: 'running' as const, completed, total: bidTotal };
      await save('outline', {
        progress: Math.round((completed / bidTotal) * 80),
        extraction,
        tenderSentenceCount: tenderSentences.length,
        tenderMatchedItemCount,
        message: `目录提取 ${completed}/${bidTotal}`,
      });
      await save('content', {
        progress: Math.round((globalSentences.size ? 10 : 5) + (completed / bidTotal) * 80),
        extraction,
        tenderSentenceCount: tenderMatcher.tenderSentenceCount,
        tenderMatchedSentenceCount,
        totalSentenceCount,
        message: contentMessage ?? `正文比对 ${completed}/${bidTotal}`,
      });
      contentMessage = null;
      await save('image', { progress: Math.round((completed / bidTotal) * 85), extraction, totalImageCount, message: `图片比对 ${completed}/${bidTotal}` });
    }

    // ---- 汇总写入 ----
    const contentFailed = contentFiles.some((file) => file.status === 'error');
    await save('metadata', {
      status: metadataFailed || contentFailed ? 'error' : 'success',
      progress: 100,
      message: metadataFailed || contentFailed ? '部分文件提取失败' : '元数据分析完成',
      contentExtraction: { status: contentFailed ? 'error' : 'success', completed: total, total },
    });

    const comparison = await buildOutlineComparison(outlineFiles);
    const outlineFailed = outlineFiles.some((file) => file.status === 'error');
    await save('outline', {
      status: outlineFailed ? 'error' : 'success',
      progress: 100,
      message: outlineFailed ? '部分文件目录分析失败' : '目录分析完成',
      extraction: { status: outlineFailed ? 'error' : 'success', completed: bidTotal, total: bidTotal },
      files: outlineFiles.map((file) => ({
        fileId: file.fileId,
        status: file.status,
        source: file.source,
        confidence: file.confidence,
        itemCount: file.items.length,
        tenderMatchedCount: file.items.filter((item) => item.fromTender).length,
        error: file.error,
        items: file.items,
      })),
      tenderSentenceCount: tenderSentences.length,
      tenderMatchedItemCount,
      duplicateGroups: comparison.duplicateGroups,
      pairwiseSimilarities: comparison.pairwiseSimilarities,
    });

    await save('content', {
      status: 'success',
      progress: 100,
      message: '正文比对完成',
      tenderSentenceCount: tenderMatcher.tenderSentenceCount,
      tenderMatchedSentenceCount,
      totalSentenceCount,
      extraction: { status: 'success', completed: bidTotal, total: bidTotal },
      duplicateSentences: buildDuplicateSentences(globalSentences),
    });

    const imageFailed = imageFiles.some((file) => file.status === 'error');
    await save('image', {
      status: imageFailed ? 'error' : 'success',
      progress: 100,
      message: imageFailed ? '部分文件图片比对失败' : '图片比对完成',
      extraction: { status: imageFailed ? 'error' : 'success', completed: bidTotal, total: bidTotal },
      files: imageFiles,
      totalImageCount,
      duplicateImages: buildDuplicateImages(globalImages),
    });

    // 程序错误（数据库或对象存储故障等）交给执行者写日志（任务记为 JOB_FAILED）。
    if (unexpected) throw unexpected;
    if (metadataFailed || contentFailed || outlineFailed || imageFailed) {
      await context.log('标书查重分析完成，部分结果失败。');
      throw new JobError('DUPLICATE_CHECK_PARTIAL_FAILED', '标书查重分析完成，部分结果失败');
    }
    await context.log('标书查重分析完成。', { files: allFiles.length, duplicateSentences: globalSentences.size });
  }
}

export const duplicateAnalysisJob = createDuplicateAnalysisJob();

// ---- 接口用：入队与取消 ----

/** 开始分析（取代桌面版 tasks.startDuplicateAnalysis）。没有投标文件时 409；已有进行中的分析任务时 409 JOB_LOCKED。 */
export async function startDuplicateAnalysis(jobs: JobServiceDependencies, context: TenantContext, projectId: string, force: boolean): Promise<JobRecord> {
  const inputs = await readAnalysisInputs(jobs.db, context, projectId);
  if (inputs.bidFiles.length === 0) throw new AppError(409, 'DUPLICATE_CHECK_BID_MISSING', '请先上传至少一份投标文件');
  return enqueueJob(jobs, context, { type: DUPLICATE_ANALYSIS_JOB_TYPE, projectId, lockKey: duplicateCheckLockKey(projectId), params: { force } });
}

/**
 * 取消本项目进行中的分析任务（重新选择文件、清空之后）。不等待执行者退出：其后续写入因签名不符被拒绝。已结束的任务跳过。
 */
export async function cancelDuplicateAnalysisJobs(jobs: JobServiceDependencies, context: TenantContext, projectId: string): Promise<void> {
  const active = await listJobs(jobs.db, context, { projectId, active: true, limit: 20 });
  for (const job of active) {
    if (job.type !== DUPLICATE_ANALYSIS_JOB_TYPE) continue;
    try {
      await cancelJob(jobs, context, job.id);
    } catch (error) {
      if (error instanceof AppError && (error.code === 'JOB_FINISHED' || error.code === 'JOB_NOT_FOUND')) continue;
      throw error;
    }
  }
}
