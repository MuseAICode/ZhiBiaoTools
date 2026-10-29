// 废标检查的两类任务（路线图第 6 步 6.9；取代桌面版 taskService.cjs 的 rejection-items-extraction / rejection-check-run 与
// rejectionCheckTask.cjs 的 runRejectionItemsExtractionTask / runRejectionCheckTask），ai 队列，会调用模型（入队检查最低启动余额）。
// 两类任务互斥（lock_key 为 project:{projectId}:rejection-check，与桌面版同组互斥相同）。
//
// - 输入在任务开始时从数据库读取，不取自任务参数：招标文件按导入顺序合并正文（取代桌面版保存的合并招标文档），投标文件
//   逐份读取解析出的 Markdown；文档须全部解析成功。签名经 computeSignatures 算出（与 GET 返回的 signatures 相同）并写进结果；
// - 写入一律经 Store 函数，并带上开始时的签名：任务开始后导入、移除了文档或改了解析结果、自定义检查项，写入在同一事务中被
//   拒绝（结果已失效，不覆盖新的状态）；导入、移除、清空时接口另外取消进行中的任务（与桌面版相同）；
// - 可续跑：worker 崩溃或关闭后从头重新执行，已完成的调用按步骤键取回已保存的结果，不再调用服务商、不再扣费（6.4a）；
//   暂停、余额不足、中断时不改写结果（仍是 running，继续后重写），任务已结束而结果仍是 running 时按未完成显示（store.ts）；
// - 失败时写给用户看的原因：JobError 的文案，其他错误一律“{检查名}失败”，原错误交给执行者写日志。
import { DEFAULT_CONTEXT_LENGTH_LIMIT } from '../ai/textSplit.ts';
import { extractInvalidBidAndRejectionItems } from '../bidAnalysis/discardedBids.ts';
import { findArtifact } from '../artifacts/store.ts';
import type { RejectionCheckResultType } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { createJobChat, resolveJobModel, type JobChat } from '../jobs/chat.ts';
import { abortableDelay, isJobStop } from '../jobs/control.ts';
import { JobError, JobInterruptedError, type JobContext, type JobTypeDefinition } from '../jobs/definitions.ts';
import { cancelJob, enqueueJob, type JobServiceDependencies } from '../jobs/service.ts';
import { listJobs, type JobRecord } from '../jobs/store.ts';
import { runLogicCheck, runRejectionItemCheck, runTypoCheck, usesSegmentedBidDocuments, usesSegmentedRejectionFlow, type CheckRuntime } from './checks.ts';
import { buildBidDocumentsMessage, type BidDocumentInput, type RejectionInput } from './prompts.ts';
import {
  loadRejectionCheck,
  REJECTION_CHECK_RUN_JOB_TYPE,
  REJECTION_ITEMS_EXTRACTION_JOB_TYPE,
  rejectionCheckLockKey,
  saveCheckResult,
  saveExtraction,
  type RejectionCheckDocument,
  type RejectionCheckState,
} from './store.ts';

export { REJECTION_CHECK_RUN_JOB_TYPE, REJECTION_ITEMS_EXTRACTION_JOB_TYPE };

/** 一次任务读取的正文总大小上限（与技术方案读取招标正文相同）。 */
export const REJECTION_CHECK_MARKDOWN_READ_MAX_BYTES = 32 * 1024 * 1024;

/** 预热请求结束后稍候再发后续请求（与桌面版 PREFIX_WARMUP_SETTLE_MS 相同）：部分服务在请求结束后才异步构建前缀缓存。 */
const PREFIX_WARMUP_SETTLE_MS = 1500;

export interface RunOptions {
  rejectionCheck: boolean;
  typoCheck: boolean;
  logicCheck: boolean;
}

const CHECKS = [
  { type: 'rejection', option: 'rejectionCheck', label: '废标项检查', initialMessage: '第一轮：正在分析检查范围。' },
  { type: 'typo', option: 'typoCheck', label: '错别字检查', initialMessage: '正在识别错别字候选。' },
  { type: 'logic', option: 'logicCheck', label: '逻辑谬误检查', initialMessage: '正在检查逻辑谬误。' },
] as const satisfies readonly { type: RejectionCheckResultType; option: keyof RunOptions; label: string; initialMessage: string }[];

// ---- 输入检查（入队前与执行时相同） ----

interface Problem {
  code: string;
  message: string;
}

function documentsProblem(documents: readonly RejectionCheckDocument[], what: '招标' | '投标'): Problem | null {
  if (documents.some((document) => document.status === 'error')) {
    return { code: 'REJECTION_CHECK_DOCUMENT_FAILED', message: `有${what}文件解析失败，请移除后重新导入` };
  }
  if (documents.some((document) => document.status !== 'success' || !document.markdownArtifactId)) {
    return { code: 'REJECTION_CHECK_DOCUMENT_NOT_READY', message: `${what}文件尚未全部解析完成，请稍后再试` };
  }
  return null;
}

function extractionProblem(state: RejectionCheckState): Problem | null {
  if (state.tenderDocuments.length === 0) return { code: 'REJECTION_CHECK_TENDER_MISSING', message: '缺少招标文件内容，无法解析无效与废标项' };
  return documentsProblem(state.tenderDocuments, '招标');
}

/** 当前解析结果是否可用作废标项检查的输入（与桌面版 Renderer 的 visibleExtractionStatus / visibleExtractionContent 相同）。 */
function extractionUsable(state: RejectionCheckState): boolean {
  const extraction = state.invalidBidAndRejectionItems;
  return extraction.status === 'success' && extraction.content.trim() !== '' && state.signatures.rejectionInput !== '';
}

function checkProblem(state: RejectionCheckState, options: RunOptions): Problem | null {
  if (!options.rejectionCheck && !options.typoCheck && !options.logicCheck) return { code: 'REJECTION_CHECK_NOTHING_ENABLED', message: '请至少启用一种检查' };
  if (state.bidDocuments.length === 0) return { code: 'REJECTION_CHECK_BID_MISSING', message: '缺少投标文件内容，无法开始检查' };
  const problem = documentsProblem(state.bidDocuments, '投标');
  if (problem) return problem;
  if (options.rejectionCheck && !extractionUsable(state)) return { code: 'REJECTION_CHECK_EXTRACTION_REQUIRED', message: '请先完成无效与废标项解析' };
  return null;
}

// ---- 读取正文 ----

async function readMarkdowns(context: JobContext<unknown>, documents: readonly RejectionCheckDocument[]): Promise<string[]> {
  const objectStore = context.objectStore;
  if (!objectStore) throw new JobError('STORAGE_DISABLED', '文件存储暂不可用，请稍后再试');
  let total = 0;
  const contents: string[] = [];
  for (const document of documents) {
    const artifact = document.markdownArtifactId ? await findArtifact(context.db, context.tenant, document.markdownArtifactId) : null;
    const object = artifact ? await objectStore.get(artifact.storageKey) : null;
    if (!object) throw new JobError('REJECTION_CHECK_DOCUMENT_NOT_READY', '文档解析结果不存在，请重新导入');
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) {
      const buffer = Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > REJECTION_CHECK_MARKDOWN_READ_MAX_BYTES) {
        object.body.destroy();
        throw new JobError('REJECTION_CHECK_CONTENT_TOO_LARGE', '文档正文合计超过 32 MiB，无法检查');
      }
      chunks.push(buffer);
    }
    contents.push(Buffer.concat(chunks).toString('utf8'));
  }
  return contents;
}

/** 招标文件按导入顺序合并（与桌面版 combineTenderMarkdown 相同）。 */
function combineTenderMarkdown(contents: readonly string[]): string {
  return contents
    .map((content) => content.trim())
    .filter(Boolean)
    .join('\n\n');
}

// ---- 公共 ----

function noParams(raw: unknown): Record<string, never> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0) throw new TypeError('废标项解析任务参数不合法');
  return {};
}

function parseRunOptions(raw: unknown): RunOptions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('废标检查任务参数不合法');
  const { rejectionCheck, typoCheck, logicCheck, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new TypeError('废标检查任务参数不合法');
  if (typeof rejectionCheck !== 'boolean' || typeof typoCheck !== 'boolean' || typeof logicCheck !== 'boolean') throw new TypeError('检查选项不合法');
  if (!rejectionCheck && !typoCheck && !logicCheck) throw new TypeError('至少启用一种检查');
  return { rejectionCheck, typoCheck, logicCheck };
}

export interface RejectionCheckJobOptions {
  /** 上下文长度（字符），默认 DEFAULT_CONTEXT_LENGTH_LIMIT；测试中用很小的值触发分段。 */
  contextLengthLimit?: number;
  /** 预热后等待的毫秒数，默认 1500。 */
  warmupSettleMs?: number;
}

// ---- 废标项解析 ----

function createExtractionJob(options: RejectionCheckJobOptions): JobTypeDefinition<Record<string, never>> {
  const split = { contextLengthLimit: options.contextLengthLimit ?? DEFAULT_CONTEXT_LENGTH_LIMIT };
  return {
    type: REJECTION_ITEMS_EXTRACTION_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams: noParams,
    async run(context) {
      const { db, tenant } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('REJECTION_CHECK_FAILED', '无效与废标项解析失败');
      const state = await loadRejectionCheck(db, tenant, projectId);
      const problem = extractionProblem(state);
      if (problem) throw new JobError(problem.code, problem.message);
      const tenderSignature = state.signatures.tender;
      const guard = { expectedSignature: tenderSignature };
      const save = (status: 'running' | 'success' | 'error', content: string, error: string | null) =>
        saveExtraction(db, tenant, projectId, { status, content, source: 'ai', tenderSignature, error }, guard);

      await context.log('开始解析无效与废标项。');
      if (!(await save('running', '', null))) {
        await context.log('招标文件已变化，本次解析已放弃');
        return;
      }
      await context.setProgress(5);
      let content: string;
      try {
        const tenderContent = combineTenderMarkdown(await readMarkdowns(context, state.tenderDocuments));
        if (!tenderContent.trim()) throw new JobError('REJECTION_CHECK_TENDER_MISSING', '缺少招标文件内容，无法解析无效与废标项');
        const chat = createJobChat(context.ai, await resolveJobModel(db, tenant));
        content = await extractInvalidBidAndRejectionItems(chat, tenderContent, split);
      } catch (error) {
        if (isJobStop(context, error)) throw error;
        const message = error instanceof JobError ? error.message : '无效与废标项解析失败';
        await save('error', '', message);
        await context.log(`无效与废标项解析失败：${message}`);
        throw error;
      }
      if (context.signal.aborted) throw new JobInterruptedError();
      if (!content.trim()) {
        await save('error', '', '模型未返回解析内容');
        await context.log('无效与废标项解析失败：模型未返回解析内容。');
        throw new JobError('REJECTION_CHECK_EXTRACTION_EMPTY', '模型未返回解析内容');
      }
      if (!(await save('success', content, null))) {
        await context.log('招标文件已变化，本次解析结果已丢弃');
        return;
      }
      await context.log('无效与废标项解析完成。');
    },
  };
}

// ---- 三类检查 ----

/** 保存前统一问题 id（rejection-finding-1 等，与 Store 的默认值相同），不采用模型给出的 id；去掉只用于去重的字段。 */
function withStableIds<F extends { id: string }>(type: RejectionCheckResultType, findings: readonly F[]): Omit<F, 'position'>[] {
  return findings.map((finding, index) => {
    const { position: _position, ...rest } = finding as F & { position?: unknown };
    return { ...rest, id: `${type}-finding-${index + 1}` };
  });
}

function createCheckJob(options: RejectionCheckJobOptions): JobTypeDefinition<RunOptions> {
  const split = { contextLengthLimit: options.contextLengthLimit ?? DEFAULT_CONTEXT_LENGTH_LIMIT };
  const warmupSettleMs = options.warmupSettleMs ?? PREFIX_WARMUP_SETTLE_MS;

  /** 多个不分段的检查共用投标文件原文消息时先预热前缀缓存（与桌面版 warmPromptPrefix 相同），失败不影响后续请求。 */
  async function warmUp(context: JobContext<RunOptions>, chat: JobChat, input: RejectionInput): Promise<void> {
    const runOptions = context.params;
    const bidDocumentsSegmented = usesSegmentedBidDocuments(input.bidDocuments, split);
    const shared =
      (runOptions.rejectionCheck && !usesSegmentedRejectionFlow(input, split) ? 3 : 0) +
      (bidDocumentsSegmented ? 0 : (runOptions.typoCheck ? 1 : 0) + (runOptions.logicCheck ? 1 : 0));
    if (shared <= 1) return;
    try {
      await chat.text('warmup', [buildBidDocumentsMessage(input.bidDocuments)], '废标检查-公共前缀预热', { maxOutputTokens: 1, allowEmpty: true });
      await abortableDelay(warmupSettleMs, context.signal);
    } catch (error) {
      if (isJobStop(context, error)) throw error;
      await context.log('投标文件原文缓存预热失败，直接继续');
    }
  }

  return {
    type: REJECTION_CHECK_RUN_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams: parseRunOptions,
    async run(context) {
      const { db, tenant, params: runOptions } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('REJECTION_CHECK_FAILED', '废标检查失败');
      const state = await loadRejectionCheck(db, tenant, projectId);
      const problem = checkProblem(state, runOptions);
      if (problem) throw new JobError(problem.code, problem.message);
      const enabled = CHECKS.filter((check) => runOptions[check.option]);
      const signatureOf = (type: RejectionCheckResultType) => (type === 'rejection' ? state.signatures.rejectionInput : state.signatures.bid);

      await context.log('开始检查投标文件。');
      for (const check of enabled) {
        const saved = await saveCheckResult(
          db,
          tenant,
          projectId,
          check.type,
          { status: 'running', inputSignature: signatureOf(check.type), progressMessage: check.initialMessage, error: null, activeFindingId: null, findings: [] },
          { expectedSignature: signatureOf(check.type) },
        );
        if (!saved) {
          await context.log('检查输入已变化，本次检查已放弃');
          return;
        }
      }
      await context.setProgress(5);

      let chat: JobChat;
      let input: RejectionInput;
      try {
        const contents = await readMarkdowns(context, state.bidDocuments);
        const bidDocuments: BidDocumentInput[] = state.bidDocuments.map((document, index) => ({ id: document.id, fileName: document.fileName, content: contents[index]! }));
        input = { invalidBidAndRejectionItems: state.invalidBidAndRejectionItems.content, customCheckItems: state.customCheckItems, bidDocuments };
        chat = createJobChat(context.ai, await resolveJobModel(db, tenant));
        await warmUp(context, chat, input);
      } catch (error) {
        if (isJobStop(context, error)) throw error;
        const message = error instanceof JobError ? error.message : '废标检查失败';
        for (const check of enabled) {
          const signature = signatureOf(check.type);
          await saveCheckResult(db, tenant, projectId, check.type, { status: 'error', error: message, progressMessage: message }, { expectedSignature: signature });
        }
        throw error;
      }
      const runtime: CheckRuntime = { chat, split };
      let completed = 0;
      let discarded = 0;

      const runOne = async (check: (typeof CHECKS)[number]): Promise<{ error: unknown } | null> => {
        const signature = signatureOf(check.type);
        const guard = { expectedSignature: signature };
        // 进度说明按顺序写入，不等待（与桌面版的 updateTask 相同，不影响检查本身）；结束前等它写完。
        let progressChain = Promise.resolve();
        const onProgress = (message: string) => {
          if (context.signal.aborted) return;
          progressChain = progressChain
            .then(() => saveCheckResult(db, tenant, projectId, check.type, { progressMessage: message }, guard))
            .then(
              () => {},
              () => {},
            );
        };
        try {
          const drafts: readonly { id: string }[] =
            check.type === 'rejection'
              ? await runRejectionItemCheck(runtime, input, onProgress)
              : check.type === 'typo'
                ? await runTypoCheck(runtime, input.bidDocuments, onProgress)
                : await runLogicCheck(runtime, input.bidDocuments, onProgress);
          await progressChain;
          if (context.signal.aborted) throw new JobInterruptedError();
          completed += 1;
          const findings = withStableIds(check.type, drafts);
          const saved = await saveCheckResult(
            db,
            tenant,
            projectId,
            check.type,
            {
              status: 'success',
              findings,
              inputSignature: signature,
              activeFindingId: findings[0]?.id ?? null,
              progressMessage: findings.length ? `${check.label}发现 ${findings.length} 项` : `${check.label}未发现问题`,
              error: null,
            },
            guard,
          );
          if (!saved) discarded += 1;
          await context.log(saved ? `${check.label}完成。` : `${check.label}的输入已变化，结果已丢弃`, { findings: findings.length });
          await context.setProgress(Math.min(95, Math.round(5 + (completed / enabled.length) * 90)));
          return null;
        } catch (error) {
          await progressChain;
          if (isJobStop(context, error)) throw error;
          completed += 1;
          const message = error instanceof JobError ? error.message : `${check.label}失败`;
          await saveCheckResult(
            db,
            tenant,
            projectId,
            check.type,
            { status: 'error', findings: [], inputSignature: signature, activeFindingId: null, error: message, progressMessage: message },
            guard,
          );
          await context.log(`${check.label}失败：${message}`);
          return { error };
        }
      };

      const settled = await Promise.allSettled(enabled.map((check) => runOne(check)));
      const stop = settled.find((result) => result.status === 'rejected');
      if (stop) throw stop.reason;
      const failures = settled.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value.error] : []));
      if (failures.length > 0) {
        await context.log(`检查完成，${failures.length} 个任务失败。`);
        // 程序错误等交给执行者写日志（任务记为 JOB_FAILED）；都是给用户看的原因时，任务以汇总的原因失败。
        const unexpected = failures.find((error) => !(error instanceof JobError));
        throw unexpected ?? new JobError('REJECTION_CHECK_FAILED', `${failures.length} 个检查任务失败`);
      }
      if (discarded > 0) throw new JobError('REJECTION_CHECK_INPUT_CHANGED', '检查输入已变化，本次结果已丢弃，请重新检查');
      await context.log('检查完成。');
    },
  };
}

export function createRejectionCheckJobs(options: RejectionCheckJobOptions = {}): JobTypeDefinition<any>[] {
  return [createExtractionJob(options), createCheckJob(options)];
}

export const rejectionCheckJobs = createRejectionCheckJobs();

// ---- 接口用：入队与取消 ----

function conflict(problem: Problem): AppError {
  return new AppError(409, problem.code, problem.message);
}

/** 开始解析无效与废标项（取代桌面版 tasks.startRejectionItemsExtraction）。已有进行中的废标检查任务时 409 JOB_LOCKED。 */
export async function startRejectionItemsExtraction(
  jobs: JobServiceDependencies,
  context: TenantContext,
  projectId: string,
): Promise<JobRecord> {
  const problem = extractionProblem(await loadRejectionCheck(jobs.db, context, projectId));
  if (problem) throw conflict(problem);
  return enqueueJob(jobs, context, { type: REJECTION_ITEMS_EXTRACTION_JOB_TYPE, projectId, lockKey: rejectionCheckLockKey(projectId), params: {} });
}

/**
 * 开始检查（取代桌面版 tasks.startRejectionCheck）：runOptions 不给出时取已保存的检查选项（废标项检查始终开启），给出时只运行
 * 其中开启的检查（桌面版的“重新检查某一项”）。
 */
export async function startRejectionCheck(
  jobs: JobServiceDependencies,
  context: TenantContext,
  projectId: string,
  runOptions?: Partial<RunOptions>,
): Promise<JobRecord> {
  const state = await loadRejectionCheck(jobs.db, context, projectId);
  const options: RunOptions = runOptions
    ? { rejectionCheck: runOptions.rejectionCheck === true, typoCheck: runOptions.typoCheck === true, logicCheck: runOptions.logicCheck === true }
    : { rejectionCheck: true, typoCheck: state.checkOptions.typoCheck, logicCheck: state.checkOptions.logicCheck };
  const problem = checkProblem(state, options);
  if (problem) throw conflict(problem);
  return enqueueJob(jobs, context, { type: REJECTION_CHECK_RUN_JOB_TYPE, projectId, lockKey: rejectionCheckLockKey(projectId), params: { ...options } });
}

/**
 * 取消本项目进行中的废标检查任务（与桌面版导入、移除文档和清空前的 cancelRejectionCheckTasks 相同）：招标文件变化取消两类，
 * 投标文件变化只取消检查。不等待执行者退出：其后续写入因签名不符被拒绝。已结束的任务跳过。
 */
export async function cancelRejectionCheckJobs(
  jobs: JobServiceDependencies,
  context: TenantContext,
  projectId: string,
  types: readonly string[] = [REJECTION_ITEMS_EXTRACTION_JOB_TYPE, REJECTION_CHECK_RUN_JOB_TYPE],
): Promise<void> {
  const active = await listJobs(jobs.db, context, { projectId, active: true, limit: 20 });
  for (const job of active) {
    if (!types.includes(job.type)) continue;
    try {
      await cancelJob(jobs, context, job.id);
    } catch (error) {
      if (error instanceof AppError && (error.code === 'JOB_FINISHED' || error.code === 'JOB_NOT_FOUND')) continue;
      throw error;
    }
  }
}
