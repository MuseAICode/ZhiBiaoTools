// 技术方案的两类任务（路线图第 6 步 6.11；取代桌面版 taskService.cjs 的 bid-section-extraction / bid-analysis 与
// bidSectionExtractionTask.cjs、bidAnalysisTask.cjs 的 runBidSectionExtractionTask / runBidAnalysisTask），ai 队列，会调用模型
// （入队检查最低启动余额）。两类任务互斥（lock_key 为 project:{projectId}:technical-plan，与桌面版 technical-plan 组的
// group-exclusive 相同）。
//
// - 输入在任务开始时从数据库读取，不取自任务参数：招标文件须全部解析成功；多标段识别读合并的原始招标正文，招标解析读按投标
//   范围裁剪后的正文（readTenderMarkdown）和已保存的解析配置（选中的解析项）。模型取组织设置中选择的平台模型；
// - 写入一律经 Store 函数，并带上开始时的输入签名：任务开始后导入、移除了招标文件、文档重新解析，或切换单 / 多标段、重新识别、
//   选择了别的投标范围，写入在同一事务中被拒绝（结果已失效，不覆盖新的状态）；导入、移除招标文件和清空时接口另外取消进行中的
//   任务（与桌面版相同）；
// - 可续跑：worker 崩溃或关闭后从头重新执行，已完成的调用按步骤键取回已保存的结果，不再调用服务商、不再扣费（6.4a）；招标解析
//   续跑时已成功的解析项不再重跑（与桌面版相同，全部重新解析时除外）。暂停、余额不足、中断时不改写结果（仍是 running），
//   任务已结束而结果仍是 running 时按未完成显示（store.ts 的 readState）；
// - 失败时写给用户看的原因：JobError 的文案，其他错误一律“解析失败”“多标段识别失败”，原错误交给执行者写日志。
// - 任务日志只写阶段和条数，不写招标正文和模型输出。
import { DEFAULT_CONTEXT_LENGTH_LIMIT, splitTextByContextLimit } from '../ai/textSplit.ts';
import { buildBidSectionContextHint, buildTenderContextMessages, runBidAnalysisPrompt } from '../bidAnalysis/prompts.ts';
import type { TechnicalPlanBidItemId, TechnicalPlanRunStatus } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { createJobChat, resolveJobModel, type JobChat } from '../jobs/chat.ts';
import { abortableDelay, isJobStop } from '../jobs/control.ts';
import { JobError, JobInterruptedError, type JobContext, type JobTypeDefinition } from '../jobs/definitions.ts';
import { cancelJob, enqueueJob, type JobServiceDependencies } from '../jobs/service.ts';
import { listJobs, type JobRecord } from '../jobs/store.ts';
import { extractBidSections, SectionExtractionError } from './sectionExtraction.ts';
import {
  BID_ANALYSIS_JOB_TYPE,
  BID_SECTION_EXTRACTION_JOB_TYPE,
  inputSignatures,
  loadTechnicalPlan,
  prepareBidSectionExtraction,
  readOriginalTenderMarkdown,
  readTenderMarkdown,
  resetBidAnalysisForRerun,
  saveBidItems,
  saveBidSectionExtraction,
  technicalPlanLockKey,
  type TechnicalPlanState,
} from './store.ts';
import { BID_ANALYSIS_TASKS, bidItemLabel, isBidItemId } from './tender.ts';

export { BID_ANALYSIS_JOB_TYPE, BID_SECTION_EXTRACTION_JOB_TYPE };

/** 预热请求结束后稍候再发后续请求（与桌面版 PREFIX_WARMUP_SETTLE_MS 相同）：部分服务在请求结束后才异步构建前缀缓存。 */
const PREFIX_WARMUP_SETTLE_MS = 1500;

const INPUT_CHANGED_MESSAGE = '招标文件或投标范围已变化，本次结果已丢弃，请重新开始';

// ---- 输入检查（入队前与执行时相同） ----

interface Problem {
  code: string;
  message: string;
}

function tenderProblem(state: TechnicalPlanState, missingMessage: string): Problem | null {
  const documents = state.tenderFiles;
  if (documents.length === 0) return { code: 'TECHNICAL_PLAN_TENDER_MISSING', message: missingMessage };
  if (documents.some((document) => document.status === 'error')) {
    return { code: 'TECHNICAL_PLAN_DOCUMENT_FAILED', message: '有招标文件解析失败，请移除后重新导入' };
  }
  if (documents.some((document) => document.status !== 'success' || !document.markdownArtifactId)) {
    return { code: 'TECHNICAL_PLAN_DOCUMENT_NOT_READY', message: '招标文件尚未全部解析完成，请稍后再试' };
  }
  return null;
}

const EXTRACTION_TENDER_MISSING = '请先上传招标文件，再进行多标段识别';
const ANALYSIS_TENDER_MISSING = '请先上传招标文件，再开始解析';

/** 与桌面版 runBidAnalysisTask 开始时的检查相同（多标段须已识别并选择了仍然有效的投标范围）。 */
function analysisProblem(state: TechnicalPlanState): Problem | null {
  const problem = tenderProblem(state, ANALYSIS_TENDER_MISSING);
  if (problem) return problem;
  if (state.bidSectionMode !== 'multiple') return null;
  if (state.bidSectionExtractionStatus !== 'success' || state.bidSections.length < 2) {
    return { code: 'TECHNICAL_PLAN_BID_SECTIONS_REQUIRED', message: '请先完成多标段识别，再开始解析招标文件' };
  }
  if (!state.selectedSection?.id || !state.selectedSection.title) {
    return { code: 'TECHNICAL_PLAN_BID_SECTION_REQUIRED', message: '请先选择本次投标范围，再开始解析招标文件' };
  }
  if (!state.bidSections.some((section) => section.id === state.selectedSection!.id)) {
    return { code: 'TECHNICAL_PLAN_BID_SECTION_INVALID', message: '当前投标范围已失效，请重新选择标段' };
  }
  return null;
}

// ---- 参数 ----

export interface BidAnalysisParams {
  /** 只重新解析其中的项（桌面版 task_ids，“重试失败项”）；null 为全部选中的项。 */
  taskIds: TechnicalPlanBidItemId[] | null;
  /** 全部重新解析（桌面版 force_rerun）：先清空选中的项与目录、全局事实、正文阶段。 */
  forceRerun: boolean;
}

function noParams(raw: unknown): Record<string, never> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0) throw new TypeError('多标段识别任务参数不合法');
  return {};
}

function parseAnalysisParams(raw: unknown): BidAnalysisParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('招标解析任务参数不合法');
  const { taskIds, forceRerun, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof forceRerun !== 'boolean') throw new TypeError('招标解析任务参数不合法');
  if (taskIds === null) return { taskIds: null, forceRerun };
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > BID_ANALYSIS_TASKS.length || !taskIds.every(isBidItemId) || new Set(taskIds).size !== taskIds.length) {
    throw new TypeError('招标解析项不合法');
  }
  return { taskIds: [...taskIds], forceRerun };
}

// ---- 公共 ----

/** 读取正文时的接口错误（过大、投标范围失效、存储不可用）转成给用户看的任务错误。 */
async function readForJob(read: () => Promise<string>): Promise<string> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AppError) throw new JobError(error.code, error.message, { cause: error });
    throw error;
  }
}

export interface TechnicalPlanJobOptions {
  /** 上下文长度（字符），默认 DEFAULT_CONTEXT_LENGTH_LIMIT；测试中用很小的值触发分段。 */
  contextLengthLimit?: number;
  /** 预热后等待的毫秒数，默认 1500。 */
  warmupSettleMs?: number;
}

// ---- 多标段识别 ----

function createSectionExtractionJob(options: TechnicalPlanJobOptions): JobTypeDefinition<Record<string, never>> {
  const split = { contextLengthLimit: options.contextLengthLimit ?? DEFAULT_CONTEXT_LENGTH_LIMIT };
  return {
    type: BID_SECTION_EXTRACTION_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams: noParams,
    async run(context) {
      const { db, tenant } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('TECHNICAL_PLAN_FAILED', '多标段识别失败');
      const problem = tenderProblem(await loadTechnicalPlan(db, tenant, projectId), EXTRACTION_TENDER_MISSING);
      if (problem) throw new JobError(problem.code, problem.message);
      // 先取签名再读正文：读取期间招标文件变化时，签名已过期，写入被拒绝。
      const guard = { tender: (await inputSignatures(db, tenant, projectId)).tender };
      const markdown = (await readForJob(() => readOriginalTenderMarkdown(db, tenant, projectId, context.objectStore))).trim();
      if (!markdown) throw new JobError('TECHNICAL_PLAN_TENDER_EMPTY', EXTRACTION_TENDER_MISSING);

      if (!(await prepareBidSectionExtraction(db, tenant, projectId, guard))) {
        await context.log('招标文件已变化，本次识别已放弃');
        return;
      }
      await context.log('开始识别招标文件中的标段范围。');
      await context.setProgress(5);
      let sections;
      try {
        const chat = createJobChat(context.ai, await resolveJobModel(db, tenant));
        sections = await extractBidSections(chat, markdown, split, async (message, progress) => {
          await context.log(message);
          await context.setProgress(progress);
        });
      } catch (error) {
        if (isJobStop(context, error)) throw error;
        const message = error instanceof JobError || error instanceof SectionExtractionError ? error.message : '多标段识别失败';
        await saveBidSectionExtraction(db, tenant, projectId, { status: 'error', error: message }, guard);
        await context.log(message);
        throw error instanceof SectionExtractionError ? new JobError('TECHNICAL_PLAN_BID_SECTIONS_NOT_FOUND', message) : error;
      }
      if (context.signal.aborted) throw new JobInterruptedError();
      if (!(await saveBidSectionExtraction(db, tenant, projectId, { status: 'success', sections, error: null }, guard))) {
        throw new JobError('TECHNICAL_PLAN_INPUT_CHANGED', INPUT_CHANGED_MESSAGE);
      }
      await context.log(`已识别 ${sections.length} 个标段，请选择本次投标范围。`, { sections: sections.length });
    },
  };
}

// ---- 招标解析 ----

function createAnalysisJob(options: TechnicalPlanJobOptions): JobTypeDefinition<BidAnalysisParams> {
  const split = { contextLengthLimit: options.contextLengthLimit ?? DEFAULT_CONTEXT_LENGTH_LIMIT };
  const warmupSettleMs = options.warmupSettleMs ?? PREFIX_WARMUP_SETTLE_MS;

  /** 各解析项共用 system 与招标正文消息：多于一项时先按段预热这一前缀（与桌面版 warmPromptPrefix 相同），失败不影响后续。 */
  async function warmUp(context: JobContext<BidAnalysisParams>, chat: JobChat, segments: readonly string[], sectionHint: string): Promise<void> {
    await Promise.all(
      segments.map(async (segment, index) => {
        const key = segments.length > 1 ? `warmup:segment:${index + 1}` : 'warmup';
        try {
          await chat.text(key, buildTenderContextMessages(segment, sectionHint), '招标解析-公共前缀预热', { maxOutputTokens: 1, allowEmpty: true });
          await abortableDelay(warmupSettleMs, context.signal);
        } catch (error) {
          if (isJobStop(context, error)) throw error;
          await context.log('招标文件缓存预热失败，直接继续');
        }
      }),
    );
  }

  return {
    type: BID_ANALYSIS_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams: parseAnalysisParams,
    async run(context) {
      const { db, tenant, params } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('TECHNICAL_PLAN_FAILED', '招标文件解析失败');
      const state = await loadTechnicalPlan(db, tenant, projectId);
      const problem = analysisProblem(state);
      if (problem) throw new JobError(problem.code, problem.message);
      const guard = { analysis: (await inputSignatures(db, tenant, projectId)).analysis };
      const fileContent = await readForJob(() => readTenderMarkdown(db, tenant, projectId, context.objectStore));
      if (!fileContent.trim()) throw new JobError('TECHNICAL_PLAN_TENDER_EMPTY', ANALYSIS_TENDER_MISSING);

      const selectedIds = new Set<string>(state.bidAnalysisSelectedTaskIds);
      const selectedTasks = BID_ANALYSIS_TASKS.filter((task) => selectedIds.has(task.id));
      const requested = params.taskIds ? new Set<string>(params.taskIds) : null;
      const scopedTasks = requested ? selectedTasks.filter((task) => requested.has(task.id)) : selectedTasks;
      if (requested && scopedTasks.length === 0) throw new JobError('TECHNICAL_PLAN_BID_ITEM_NOT_FOUND', '未找到可重新解析的招标文件解析项');
      const selectedSection = state.selectedSection ? state.bidSections.find((section) => section.id === state.selectedSection!.id) : null;
      const sectionHint = buildBidSectionContextHint(selectedSection, { hasSelectedSection: state.bidSectionMode === 'multiple' && Boolean(state.selectedSection) });
      const segments = splitTextByContextLimit(fileContent, split);
      const chat = createJobChat(context.ai, await resolveJobModel(db, tenant));

      await context.log(requested ? '开始重新解析选中的招标文件解析项。' : params.forceRerun ? '开始重新解析全部招标文件解析项。' : '开始解析招标文件。');
      const statuses = new Map<string, TechnicalPlanRunStatus>(Object.values(state.bidAnalysisTasks).map((item) => [item.id, item.status]));
      if (params.forceRerun && !requested) {
        if (!(await resetBidAnalysisForRerun(db, tenant, projectId, selectedTasks.map((task) => task.id), guard))) {
          await context.log('招标文件或投标范围已变化，本次解析已放弃');
          return;
        }
        for (const task of selectedTasks) statuses.set(task.id, 'idle');
      }
      const tasksToRun = requested || params.forceRerun ? scopedTasks : scopedTasks.filter((task) => statuses.get(task.id) !== 'success');
      const progress = () => Math.round((selectedTasks.filter((task) => ['success', 'error'].includes(statuses.get(task.id) ?? '')).length / selectedTasks.length) * 100);
      await context.setProgress(progress());
      if (tasksToRun.length > 1) await warmUp(context, chat, segments, sectionHint);

      let discarded = 0;
      const save = async (id: TechnicalPlanBidItemId, status: TechnicalPlanRunStatus, content: string, error: string | null) => {
        const saved = await saveBidItems(db, tenant, projectId, { [id]: { status, content, error } }, guard);
        if (!saved) discarded += 1;
        return saved;
      };

      const runOne = async (id: TechnicalPlanBidItemId): Promise<{ error: unknown } | null> => {
        const label = bidItemLabel(id);
        try {
          if (!(await save(id, 'running', '', null))) return null;
          statuses.set(id, 'running');
          const content = (await runBidAnalysisPrompt(chat, { id, segments, sectionHint, keyPrefix: `item:${id}` })).trim();
          if (!content) throw new JobError('TECHNICAL_PLAN_BID_ITEM_EMPTY', `${label}解析结果为空，请重新解析`);
          if (context.signal.aborted) throw new JobInterruptedError();
          if (await save(id, 'success', content, null)) statuses.set(id, 'success');
          await context.setProgress(progress());
          return null;
        } catch (error) {
          if (isJobStop(context, error)) throw error;
          const message = error instanceof JobError ? error.message : '解析失败';
          if (await save(id, 'error', '', message)) statuses.set(id, 'error');
          await context.log(`${label}解析失败：${message}`);
          await context.setProgress(progress());
          return { error };
        }
      };

      const settled = await Promise.allSettled(tasksToRun.map((task) => runOne(task.id)));
      const stop = settled.find((result) => result.status === 'rejected');
      if (stop) throw stop.reason;
      if (discarded > 0) throw new JobError('TECHNICAL_PLAN_INPUT_CHANGED', INPUT_CHANGED_MESSAGE);
      // 程序错误等交给执行者写日志（任务记为 JOB_FAILED）。
      const unexpected = settled.flatMap((result) => (result.status === 'fulfilled' && result.value && !(result.value.error instanceof JobError) ? [result.value.error] : []));
      if (unexpected.length > 0) throw unexpected[0];
      const missing = BID_ANALYSIS_TASKS.filter((task) => task.required && statuses.get(task.id) !== 'success');
      if (missing.length > 0) {
        const message = `必填解析项未完成：${missing.map((task) => task.label).join('、')}，请重新解析失败项。`;
        await context.log(message);
        throw new JobError('TECHNICAL_PLAN_BID_ANALYSIS_INCOMPLETE', message);
      }
      await context.log('招标文件解析完成。');
    },
  };
}

export function createTechnicalPlanJobs(options: TechnicalPlanJobOptions = {}): JobTypeDefinition<any>[] {
  return [createSectionExtractionJob(options), createAnalysisJob(options)];
}

export const technicalPlanJobs = createTechnicalPlanJobs();

// ---- 接口用：入队与取消 ----

function conflict(problem: Problem): AppError {
  return new AppError(409, problem.code, problem.message);
}

/** 开始多标段识别（取代桌面版 tasks.startBidSectionExtraction）。已有进行中的技术方案任务时 409 JOB_LOCKED。 */
export async function startBidSectionExtraction(jobs: JobServiceDependencies, context: TenantContext, projectId: string): Promise<JobRecord> {
  const problem = tenderProblem(await loadTechnicalPlan(jobs.db, context, projectId), EXTRACTION_TENDER_MISSING);
  if (problem) throw conflict(problem);
  return enqueueJob(jobs, context, { type: BID_SECTION_EXTRACTION_JOB_TYPE, projectId, lockKey: technicalPlanLockKey(projectId), params: {} });
}

/**
 * 开始招标解析（取代桌面版 tasks.startBidAnalysis）。解析模式与选中的解析项取已保存的配置（桌面版 Renderer 启动前先保存配置，
 * 这里不再随参数传入）；taskIds 只重新解析其中的项，forceRerun 全部重新解析。已有进行中的技术方案任务时 409 JOB_LOCKED。
 */
export async function startBidAnalysis(
  jobs: JobServiceDependencies,
  context: TenantContext,
  projectId: string,
  input: { taskIds?: TechnicalPlanBidItemId[]; forceRerun?: boolean },
): Promise<JobRecord> {
  const state = await loadTechnicalPlan(jobs.db, context, projectId);
  const problem = analysisProblem(state);
  if (problem) throw conflict(problem);
  const taskIds = input.taskIds?.length ? [...new Set(input.taskIds)] : null;
  if (taskIds && !taskIds.some((id) => state.bidAnalysisSelectedTaskIds.includes(id))) {
    throw conflict({ code: 'TECHNICAL_PLAN_BID_ITEM_NOT_FOUND', message: '未找到可重新解析的招标文件解析项' });
  }
  return enqueueJob(jobs, context, {
    type: BID_ANALYSIS_JOB_TYPE,
    projectId,
    lockKey: technicalPlanLockKey(projectId),
    params: { taskIds, forceRerun: input.forceRerun === true },
  });
}

/**
 * 取消本项目进行中的技术方案任务（与桌面版导入、移除招标文件和重置前的 cancelTechnicalPlanTasks 相同）。不等待执行者退出：
 * 其后续写入因签名不符被拒绝。已结束的任务跳过。
 */
export async function cancelTechnicalPlanJobs(jobs: JobServiceDependencies, context: TenantContext, projectId: string): Promise<void> {
  const types: readonly string[] = [BID_SECTION_EXTRACTION_JOB_TYPE, BID_ANALYSIS_JOB_TYPE];
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
