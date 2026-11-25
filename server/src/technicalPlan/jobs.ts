// 技术方案的任务（取代桌面版 taskService.cjs 的 bid-section-extraction / bid-analysis / global-facts-generation /
// global-facts-adjustment / outline-adjustment 与 bidSectionExtractionTask.cjs、bidAnalysisTask.cjs、globalFactsTaskV2.cjs、
// globalFactsAdjustmentTask.cjs、outlineAdjustmentTask.cjs 的 run* 函数），会调用模型（入队检查最低启动余额）。各类任务互斥（lock_key 为 project:{projectId}:technical-plan，与桌面版 technical-plan
// 组的 group-exclusive 相同）：
// - 多标段识别、招标解析（路线图第 6 步 6.11）：ai 队列；
// - 全局事实生成（第 8 步 8.7c1）：agent 队列，在 agent 沙箱中由 Agent 读工作区材料写出 global-facts.json（见 createGlobalFactsJob）；
// - 全局事实调整（第 8 步 8.7c2）：agent 队列，接着全局事实生成（或上一次调整）的会话与工作区，按用户的要求改写 global-facts.json
//   （见 createGlobalFactsAdjustmentJob）。两者共用工作区快照类别 technical-plan-global-facts，成功后保留快照供下一次调整续用；
//   导入、移除招标文件，切换单 / 多标段，选择投标范围，多标段识别开始，全部重新解析，目录被清空与清空技术方案时丢弃
//   （discardTechnicalPlanSessions，桌面版 deleteGlobalFactsAgentTask）；
// - 目录生成（第 8 步 8.7e1、8.7e2a、8.7e2b）：agent 队列，一级目录、用户确认（暂停为 waiting_for_selection）与确认之后的后续阶段
//   （无技术评分项模式与评分模式，见 createOutlineGenerationJob）；
// - 正文生成（第 8 步 8.10b1 起）：agent 队列，见 contentGenerationJob.ts；
// - 目录调整（第 8 步 8.7d）：agent 队列，接着目录生成或上一次调整的会话与工作区，按用户的要求改写 outline.json
//   （见 createOutlineAdjustmentJob）。目录生成与调整共用工作区快照类别 technical-plan-outline-generation；与全局事实的会话在同样的入口
//   一并丢弃（桌面版 deleteOutlineAgentTask 与 deleteGlobalFactsAgentTask 总是一起调用）。
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
import { JobError, JobInterruptedError, JobSelectionRequiredError, type JobContext, type JobTypeDefinition } from '../jobs/definitions.ts';
import { cancelJob, confirmJobSelectionAndDispatch, enqueueJob, type JobServiceDependencies } from '../jobs/service.ts';
import { listJobs, type JobRecord } from '../jobs/store.ts';
import type { Kysely } from 'kysely';
import { AGENT_TASK_LIMITS } from '../agent/budget.ts';
import { findContinuableAgentSession } from '../agent/continuation.ts';
import type { AgentPromptTool } from '../agent/entry.ts';
import { withAgentRun, type AgentRun, type AgentRunState } from '../agent/execution.ts';
import { discardAgentWorkspaceSnapshots } from '../agent/workspaceJob.ts';
import type { Database } from '../db/schema.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import {
  buildGlobalFactsAgentInput,
  createGlobalFactsAdjustmentPrompt,
  globalFactsAdjustmentFile,
  GLOBAL_FACTS_JSON_SCHEMA,
  GLOBAL_FACTS_OUTPUT_FILE,
  globalFactsKnowledgeItems,
  validateGlobalFactsOutput,
  type GlobalFactGroup,
  type GlobalFactsAgentInput,
} from './globalFactsAgent.ts';
import { OutlineInputError } from './outline.ts';
import {
  AI_CONTENT_MODE,
  applyOutlineSelection,
  buildInitialOutlineInput,
  buildOutlineReviewContext,
  buildScorePlanningFiles,
  CHILDREN_GENERATION_STAGE,
  collectOutlineIds,
  countAiLeaves,
  createChildrenPrompt,
  createLeafAdjustmentPrompt,
  createLeafAllocationPrompt,
  createNoTechnicalScoreChildrenPrompt,
  createNoTechnicalScoreReviewPrompt,
  createOutlineAdjustmentPrompt,
  createOutlineReviewPrompt,
  createOutputRepairPrompt,
  createScorePlanningPrompt,
  defaultOutlineSelection,
  deriveTargetLeafCount,
  enforceMinimumLeafTarget,
  finalOutlineOf,
  INITIAL_OUTLINE_STAGE,
  initialOutlineNeedsKnowledge,
  isLeafAllocationList,
  isMissingTechnicalScoreItems,
  isScoreDirectoryPlan,
  LEAF_ADJUSTMENT_ACCEPT_OPTION,
  LEAF_ADJUSTMENT_STAGE,
  LEAF_ALLOCATION_CONTEXT_FILE,
  LEAF_ALLOCATION_FILE,
  LEAF_ALLOCATION_STAGE,
  lockedOutlineRoots,
  OUTLINE_JSON_SCHEMA,
  OUTLINE_OUTPUT_FILE,
  OUTLINE_REVIEW_CONTEXT_FILE,
  OUTLINE_REVIEW_FILE,
  OUTLINE_REVIEW_STAGE,
  outlineAdjustmentFile,
  outlineGenerationJsonSchemas,
  outlineReviewMessage,
  OUTLINE_SELECTION_ITEMS_MAX,
  OutlineSelectionInputError,
  parseOutlineRoots,
  readOutlineSelectionState,
  SCORE_DIRECTORY_PLAN_FILE,
  SCORE_PLANNING_STAGE,
  synchronizeScoreDirectoryPlan,
  TECHNICAL_SCORE_GROUPS_FILE,
  TECHNICAL_SCORE_INFO_FILE,
  validateInitialOutlineOutput,
  validateLeafAllocationOutput,
  validateOutlineOutput,
  validateOutlineReviewOutputs,
  validateScorePlanningOutputs,
  type AcceptedOutlineItem,
  type AgentInputFile,
  type InitialOutlineInput,
  type LeafAllocation,
  type OutlineGenerationMode,
  type OutlineReview,
  type OutlineSelectionChange,
  type OutlineSelectionRecord,
  type ScoreDirectoryPlan,
} from './outlineAgent.ts';
import { agentQuestionClock, findLatestConsumedAgentAnswer } from '../agent/questions.ts';
import { TERMINATION_OPTIONS } from '../agent/requestTerminationTool.ts';
import { TECHNICAL_PLAN_OUTLINE_NODES_MAX } from './outline.ts';
import { extractBidSections, SectionExtractionError } from './sectionExtraction.ts';
import {
  BID_ANALYSIS_JOB_TYPE,
  BID_SECTION_EXTRACTION_JOB_TYPE,
  CONTENT_GENERATION_JOB_TYPE,
  CONTENT_GENERATION_TASK_KIND,
  contentGenerationRetrySource,
  GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE,
  GLOBAL_FACTS_ADJUSTMENT_REQUIREMENT_MAX,
  GLOBAL_FACTS_ADJUSTMENT_SUMMARY_MAX,
  GLOBAL_FACTS_JOB_TYPE,
  GLOBAL_FACTS_TASK_KIND,
  globalFactsInputSignature,
  OUTLINE_ADJUSTMENT_JOB_TYPE,
  OUTLINE_ADJUSTMENT_REQUIREMENT_MAX,
  OUTLINE_ADJUSTMENT_SUMMARY_MAX,
  OUTLINE_GENERATION_JOB_TYPE,
  OUTLINE_TASK_KIND,
  outlineAdjustmentInputSignature,
  outlineGenerationInputSignature,
  outlineSessionTarget,
  globalFactsSessionTarget,
  inputSignatures,
  loadTechnicalPlan,
  prepareBidSectionExtraction,
  readGlobalFactsKnowledgeItems,
  readGlobalFactsSources,
  readOriginalTenderMarkdown,
  readOutlineKnowledgeMarkdowns,
  readTenderMarkdown,
  resetBidAnalysisForRerun,
  saveBidItems,
  saveBidSectionExtraction,
  saveGlobalFactsResult,
  saveOutlineAdjustmentResult,
  saveOutlineGenerationResult,
  technicalPlanLockKey,
  type TechnicalPlanState,
} from './store.ts';
import { BID_ANALYSIS_TASKS, bidItemLabel, isBidItemId } from './tender.ts';
import {
  contentGenerationProblem,
  createContentGenerationJob,
  CONTENT_RETRY_UNAVAILABLE_CODE,
  CONTENT_RETRY_UNAVAILABLE_MESSAGE,
} from './contentGenerationJob.ts';

export {
  BID_ANALYSIS_JOB_TYPE,
  BID_SECTION_EXTRACTION_JOB_TYPE,
  CONTENT_GENERATION_JOB_TYPE,
  GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE,
  GLOBAL_FACTS_JOB_TYPE,
  GLOBAL_FACTS_TASK_KIND,
  OUTLINE_ADJUSTMENT_JOB_TYPE,
  OUTLINE_GENERATION_JOB_TYPE,
  OUTLINE_TASK_KIND,
};

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

const GLOBAL_FACTS_TENDER_MISSING = '请先上传招标文件，再生成全局事实';

/** 全局事实生成的前置条件（与桌面版 runGlobalFactsTaskV2 开始时的检查相同；原方案未解析完成的两条是 Web 版新增的）。 */
function globalFactsProblem(state: TechnicalPlanState): Problem | null {
  const problem = tenderProblem(state, GLOBAL_FACTS_TENDER_MISSING);
  if (problem) return problem;
  if (!state.outlineData?.outline.length) return { code: 'TECHNICAL_PLAN_OUTLINE_REQUIRED', message: '请先生成目录，再生成全局事实' };
  const plan = state.originalPlanFile;
  if (plan?.status === 'error') return { code: 'TECHNICAL_PLAN_ORIGINAL_PLAN_FAILED', message: '原方案解析失败，请移除后重新上传' };
  if (plan && (plan.status !== 'success' || !plan.markdownArtifactId)) {
    return { code: 'TECHNICAL_PLAN_ORIGINAL_PLAN_NOT_READY', message: '原方案尚未解析完成，请稍后再试' };
  }
  return null;
}

/** 全局事实调整的前置条件（文案与桌面版 runGlobalFactsAdjustmentTask 相同）。 */
const GLOBAL_FACTS_REQUIRED: Problem = { code: 'TECHNICAL_PLAN_GLOBAL_FACTS_REQUIRED', message: '当前没有可调整的全局事实，请先完成全局事实设定' };
const GLOBAL_FACTS_SESSION_MISSING: Problem = {
  code: 'TECHNICAL_PLAN_GLOBAL_FACTS_SESSION_MISSING',
  message: '全局事实设定的 Agent 工作空间不存在，请重新生成后再使用 AI 调整',
};

/** 目录调整的前置条件（文案与桌面版 runOutlineAdjustmentTask 相同）。 */
const OUTLINE_REQUIRED: Problem = { code: 'TECHNICAL_PLAN_OUTLINE_REQUIRED', message: '当前没有可调整的目录，请先完成目录生成' };
const OUTLINE_SESSION_MISSING: Problem = {
  code: 'TECHNICAL_PLAN_OUTLINE_SESSION_MISSING',
  message: '目录生成的 Agent 工作空间不存在，请重新生成目录后再使用 AI 调整',
};

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

export interface GlobalFactsAdjustmentParams {
  /** 用户的调整要求（去掉首尾空白，不为空，至多 GLOBAL_FACTS_ADJUSTMENT_REQUIREMENT_MAX 字）。 */
  requirement: string;
}

/** 目录调整的参数（与全局事实调整相同，至多 OUTLINE_ADJUSTMENT_REQUIREMENT_MAX 字）。 */
export type OutlineAdjustmentParams = GlobalFactsAdjustmentParams;

/** 调整要求的规范化（与可研目录调整相同）：去掉 NUL 与首尾空白；为空或超过 max 字时返回 null。 */
function normalizeRequirement(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const requirement = raw.replace(/\0/g, '').trim();
  return requirement && [...requirement].length <= max ? requirement : null;
}

function adjustmentParamsParser(what: string, max: number): (raw: unknown) => GlobalFactsAdjustmentParams {
  return (raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError(`${what}任务参数不合法`);
    const { requirement, ...rest } = raw as Record<string, unknown>;
    const normalized = normalizeRequirement(requirement, max);
    if (Object.keys(rest).length > 0 || normalized === null || normalized !== requirement) throw new TypeError(`${what}任务参数不合法`);
    return { requirement: normalized };
  };
}

/** 接口收到的调整要求：为空或过长时 400（文案与全局事实调整相同）。 */
function requestedRequirement(raw: unknown, max: number): string {
  const requirement = normalizeRequirement(raw, max);
  if (requirement === null) throw new AppError(400, 'TECHNICAL_PLAN_INVALID', String(raw ?? '').trim() ? `调整要求超过 ${max} 字` : '调整要求不能为空');
  return requirement;
}

// ---- 公共 ----

/** 读取正文时的接口错误（过大、投标范围失效、存储不可用）转成给用户看的任务错误。 */
async function readForJob<T>(read: () => Promise<T>): Promise<T> {
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
      // 目录与全局事实已清空：目录与全局事实的会话不再续用（桌面版 clearDownstreamFromBidSectionChange）。丢弃失败的留给下一次生成替换。
      await discardTechnicalPlanSessions(db, tenant, context.objectStore, projectId).catch(() => {});
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
        // 目录与全局事实已清空：目录与全局事实的会话不再续用（桌面版目录被清空时删除持久任务）。丢弃失败的留给下一次生成替换。
        await discardTechnicalPlanSessions(db, tenant, context.objectStore, projectId).catch(() => {});
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

// ---- 全局事实生成（8.7c1）与调整（8.7c2） ----

/** 全局事实生成的阶段（与桌面版 initial_stage 相同）。 */
export const GLOBAL_FACTS_STAGE = 'global-facts';
/** 全局事实调整的阶段（与桌面版 initial_stage 相同）。 */
export const GLOBAL_FACTS_ADJUSTMENT_STAGE = 'global-facts-adjustment';
/** 工作区材料的受保护文件分组。 */
const GLOBAL_FACTS_INPUT_GROUP = 'input';
/** 全局事实调整放入的当前全局事实（交给 Agent 修改，写入后解除登记，不还原）。 */
const GLOBAL_FACTS_OUTPUT_GROUP = 'output';
/** 调整说明取不到时（与桌面版相同）。 */
const GLOBAL_FACTS_ADJUSTMENT_DEFAULT_SUMMARY = '全局事实已按要求调整完成。';
/** 续跑时该阶段的要求已在会话中发出：只请 Agent 继续（与桌面版 CONTINUE_PROMPT 相同）。 */
const CONTINUE_PROMPT = '继续之前的任务';
/** 与桌面版相同：原生工具、json-validation、ask-user 与需用户确认的失败报告（顶层任务的 report-failure 即 request-termination）。 */
const GLOBAL_FACTS_TOOLS: readonly AgentPromptTool[] = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'json-validation', 'ask-user', 'request-termination'];
const GLOBAL_FACTS_BUSINESS_TOOLS = ['ask-user', 'request-termination'] as const;
const GLOBAL_FACTS_INPUT_CHANGED_MESSAGE = '招标文件、解析结果、目录或全局事实已变化，本次结果已丢弃，请重新开始';

function globalFactsInputChanged(): JobError {
  return new JobError('TECHNICAL_PLAN_INPUT_CHANGED', GLOBAL_FACTS_INPUT_CHANGED_MESSAGE);
}

/** checkpoint 中任务自己的状态：首次执行开始时的输入签名（续跑时核对，写入时传回）。 */
function checkpointSignature(raw: Record<string, unknown> | null): string | null {
  return raw && typeof raw.signature === 'string' && raw.signature !== '' ? raw.signature : null;
}

interface GlobalFactsMaterials {
  input: GlobalFactsAgentInput;
  /** 生成配置是否引用了知识库文档。 */
  referenced: boolean;
  /** 读到的知识库完整条目数。 */
  knowledgeCount: number;
}

/**
 * 全局事实生成的工作区材料与提示词（生成时放入；调整时生成放入的原件不可用才按当前输入重新放入）。前置条件不满足时以对应的 JobError
 * 失败（与入队时的检查相同）。
 */
async function readGlobalFactsMaterials(context: JobContext<unknown>, projectId: string, state: TechnicalPlanState): Promise<GlobalFactsMaterials> {
  const { db, tenant } = context;
  const problem = globalFactsProblem(state);
  if (problem) throw new JobError(problem.code, problem.message);
  // 与桌面版 hasSelectedBidSection 相同：多标段且选择了投标范围时只用按投标范围裁剪的正文。
  const usingSection = state.bidSectionMode === 'multiple' && Boolean(state.selectedSection?.id);
  const sources = await readForJob(() => readGlobalFactsSources(db, tenant, projectId, context.objectStore, { tenders: !usingSection }));
  const tenderSources = usingSection
    ? [{ fileName: '当前投标范围', markdown: (await readForJob(() => readTenderMarkdown(db, tenant, projectId, context.objectStore))).trim(), isWorkingCopy: true }]
    : sources.tenderFiles.map((file) => ({ fileName: file.fileName, markdown: file.markdown.trim(), isWorkingCopy: false }));
  const tenders = tenderSources.filter((source) => source.markdown);
  if (!tenders.length) throw new JobError('TECHNICAL_PLAN_TENDER_EMPTY', GLOBAL_FACTS_TENDER_MISSING);
  const originalPlanMarkdown = state.originalPlanFile ? sources.originalPlanMarkdown.trim() : '';
  if (state.originalPlanFile && !originalPlanMarkdown) throw new JobError('TECHNICAL_PLAN_ORIGINAL_PLAN_REQUIRED', '请先上传原方案，再生成全局事实');
  const referenced = state.referenceKnowledgeDocumentIds.length > 0;
  const knowledgeItems = referenced ? globalFactsKnowledgeItems(await readGlobalFactsKnowledgeItems(db, tenant, projectId)) : [];
  const selectedSection = state.selectedSection ? (state.bidSections.find((section) => section.id === state.selectedSection!.id) ?? null) : null;
  const input = buildGlobalFactsAgentInput(
    {
      tenderSources: tenders,
      selectedSection,
      projectOverview: state.projectOverview,
      bidAnalysisTasks: state.bidAnalysisTasks,
      outline: state.outlineData!.outline,
      originalPlanMarkdown,
      globalFactsMode: state.globalFactsMode,
    },
    knowledgeItems,
  );
  return { input, referenced, knowledgeCount: knowledgeItems.length };
}

/** 工作区材料登记为受保护文件放入沙箱。 */
async function writeGlobalFactsInputs(context: JobContext<unknown>, run: AgentRun, input: GlobalFactsAgentInput): Promise<void> {
  await run.baseline.write(
    run.sandbox,
    GLOBAL_FACTS_INPUT_GROUP,
    input.files.map((file) => ({ path: file.path, data: Buffer.from(file.content, 'utf8') })),
    { replace: true, signal: context.signal },
  );
}

/** 生成与调整共用的提交校验：与桌面版 validateGlobalFactsOutput 相同，阻塞问题经提交修复退回 Agent。 */
function globalFactsValidator(run: AgentRun) {
  return async () => {
    const file = (await run.readFiles([GLOBAL_FACTS_OUTPUT_FILE])).get(GLOBAL_FACTS_OUTPUT_FILE);
    if (file && file.data === null) return { value: null, issues: [{ severity: 'blocking' as const, message: `${GLOBAL_FACTS_OUTPUT_FILE}过大，无法读取` }] };
    return validateGlobalFactsOutput(file?.data?.toString('utf8') ?? '');
  };
}

/** 生成与调整的结果：没有可用分组时失败。 */
function checkedGlobalFacts(context: JobContext<unknown>, groups: GlobalFactGroup[] | null): GlobalFactGroup[] {
  if (!groups?.length) throw new JobError('TECHNICAL_PLAN_GLOBAL_FACTS_INVALID', '全局事实结果缺少 groups');
  if (context.signal.aborted) throw new JobInterruptedError();
  return groups;
}

/** 写入结果（带输入签名）；超出服务端上限时失败，签名不符时以 TECHNICAL_PLAN_INPUT_CHANGED 失败。 */
async function writeGlobalFactsResult(context: JobContext<unknown>, projectId: string, groups: GlobalFactGroup[], signature: string): Promise<void> {
  let written: boolean;
  try {
    written = await saveGlobalFactsResult(context.db, context.tenant, projectId, groups, signature);
  } catch (error) {
    if (error instanceof OutlineInputError) throw new JobError('TECHNICAL_PLAN_GLOBAL_FACTS_INVALID', error.message, { cause: error });
    throw error;
  }
  if (!written) throw globalFactsInputChanged();
}

/**
 * 全局事实生成（取代桌面版 globalFactsTaskV2.cjs 的 runGlobalFactsTaskV2）：
 * - 输入在任务开始时从数据库读取：招标正文（多标段且选择了投标范围时为按投标范围裁剪的一份，否则为各招标文件的原文）、项目概述、
 *   招标解析结果（项目信息、甲方信息、交货和服务要求）、目录、原方案（有时）、引用的知识库文档的完整条目与全局事实的写法（生成配置，
 *   由 PATCH .../generation-config 先保存；桌面版随开始任务的参数传入）；
 * - 工作区材料（招标文件/*.md、项目概述.md、招标解析结果.md、技术方案目录.md、标段说明.md、参考知识库/条目-*.md、原方案.md、
 *   材料说明.md）登记为受保护文件，提示词、预置 Schema 与工具与桌面版相同（src/technicalPlan/globalFactsAgent.ts）；
 * - 提交校验与桌面版 validateGlobalFactsOutput 相同（不是合法 JSON、不符合 Schema、没有可用分组为阻塞问题，经提交修复退回 Agent，
 *   max_retries 0 只表示执行失败不重试），另按服务端的全局事实上限检查；
 * - 结果经 saveGlobalFactsResult 整体替换全局事实并清空正文阶段（桌面版在开始时清空全局事实，这里在写入时替换：失败时保留原来的），
 *   带上首次执行开始时的输入签名：之后招标文件、投标范围、原方案、解析结果、目录、全局事实的写法、引用的知识库文档或全局事实变化时，
 *   写入被拒绝；
 * - 可续跑：每条提示词之后保存检查点（工作区快照与 checkpoint，签名在其中），暂停（费用 / 轮数上限、余额不足、存储配额）或 worker
 *   失联后续接会话，只发“继续之前的任务”；续跑时输入已变化即失败；
 * - 成功后保留快照（8.7c2，keepAfterSuccess）：全局事实调整接着这次的会话与工作区（桌面版的持久任务）。新的生成在第一个检查点替换快照。
 */
function createGlobalFactsJob(): JobTypeDefinition<Record<string, never>> {
  return {
    type: GLOBAL_FACTS_JOB_TYPE,
    queue: 'agent',
    resumable: true,
    billable: true,
    agentLimits: AGENT_TASK_LIMITS.outline,
    agentTools: GLOBAL_FACTS_BUSINESS_TOOLS,
    agentWorkspace: { taskKind: GLOBAL_FACTS_TASK_KIND, keepAfterSuccess: true },
    parseParams: (raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0) throw new TypeError('全局事实生成任务参数不合法');
      return {};
    },
    async run(context) {
      const { db, tenant } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('TECHNICAL_PLAN_FAILED', '全局事实生成失败');
      // 先取签名再读状态与正文：读取期间输入变化时签名已过期，写入被拒绝。
      const current = await globalFactsInputSignature(db, tenant, projectId);
      const state = await loadTechnicalPlan(db, tenant, projectId);
      const { input, referenced, knowledgeCount } = await readGlobalFactsMaterials(context, projectId, state);
      await withAgentRun(context.agent, async (run) => {
        const saved = checkpointSignature(run.taskCheckpoint);
        if (saved !== null && saved !== current) throw globalFactsInputChanged();
        const signature = saved ?? current;
        if (!run.resumed) {
          await context.log('开始生成全局事实变量。');
          await context.setProgress(5);
          if (!referenced) {
            await context.log('未选择参考知识库。');
            await context.setProgress(8);
          } else {
            await context.log(knowledgeCount ? `已读取 ${knowledgeCount} 条知识库完整条目。` : '未读取到可用知识库完整条目。');
            await context.setProgress(14);
          }
          // 与桌面版相同，进度只增不减（选择了知识库时已到 14）。
          await context.log('正在准备全局事实工作区材料。');
          await context.setProgress(referenced ? 14 : 12);
        }
        // 续跑时材料在快照中；原件不可用（快照中的副本被改动）时按同一输入重新放入。
        if (!run.resumed || run.unavailableProtectedFiles.length > 0) await writeGlobalFactsInputs(context, run, input);
        await context.log(run.resumed ? 'Agent 继续整理全局事实变量。' : 'Agent 正在整理全局事实变量。');
        await context.setProgress(18);
        const stage = await run.runStage<GlobalFactGroup[]>({
          stage: GLOBAL_FACTS_STAGE,
          stageIndex: 0,
          prompt: run.wasPrompted(GLOBAL_FACTS_STAGE) ? CONTINUE_PROMPT : input.prompt,
          tools: GLOBAL_FACTS_TOOLS,
          jsonSchemas: { [GLOBAL_FACTS_OUTPUT_FILE]: GLOBAL_FACTS_JSON_SCHEMA },
          outputFile: GLOBAL_FACTS_OUTPUT_FILE,
          maxExecutionRetries: 0,
          checkpointAfterPrompt: () => ({ signature }),
          validate: globalFactsValidator(run),
        });
        const groups = checkedGlobalFacts(context, stage.value);
        await context.log(`全局事实变量整理完成：${groups.length} 个大项。`);
        await context.setProgress(95);
        await writeGlobalFactsResult(context, projectId, groups, signature);
      });
      await context.log('全局事实变量生成完成。');
    },
  };
}

/**
 * 全局事实调整（8.7c2，取代桌面版 globalFactsAdjustmentTask.cjs 的 runGlobalFactsAdjustmentTask）：
 * - 首次执行接着全局事实生成（或上一次调整）的会话与工作区（src/agent/continuation.ts：与当前快照同一对、已结束的生成或调整任务的
 *   现场）；没有全局事实、找不到会话时失败（文案与桌面版相同，入队时也检查）。续跑时用本任务自己的现场（只发“继续之前的任务”）；
 * - 当前全局事实（数据库中的，用户可能手动改过）按桌面版 buildAgentFactsInput 写入 global-facts.json，交给 Agent 修改、不登记为受保护
 *   文件；生成时放入的材料仍是受保护文件，原件不可用时按当前的输入重新放入；提示词、工具、预置 Schema、提交校验（经提交修复）与桌面版相同；
 * - 结果与生成相同经 saveGlobalFactsResult 整体替换全局事实并清空正文阶段（桌面版 invalidateContentGeneration），带上首次执行开始时的
 *   输入签名（与生成相同），之后输入或全局事实变化时写入被拒绝；
 * - 调整说明（桌面版 stats.adjustment.summary）：Agent 最后一条回复的全文（run.assistantText，至多 2000 字），取不到时为桌面版的固定
 *   说明；它是 AI 生成的内容，不写进任务日志，写进本任务最后的 checkpoint（{ signature, summary }），由页面状态的 globalFactsAdjustment
 *   给出（按纯文本显示，第 9 步）。成功后保留快照，下一次调整接着这次的会话。
 */
function createGlobalFactsAdjustmentJob(): JobTypeDefinition<GlobalFactsAdjustmentParams> {
  return {
    type: GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE,
    queue: 'agent',
    resumable: true,
    billable: true,
    agentLimits: AGENT_TASK_LIMITS.outline,
    agentTools: GLOBAL_FACTS_BUSINESS_TOOLS,
    agentWorkspace: { taskKind: GLOBAL_FACTS_TASK_KIND, keepAfterSuccess: true },
    parseParams: adjustmentParamsParser('全局事实调整', GLOBAL_FACTS_ADJUSTMENT_REQUIREMENT_MAX),
    async run(context) {
      const { db, tenant, params } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('TECHNICAL_PLAN_FAILED', '全局事实 AI 调整失败');
      const current = await globalFactsInputSignature(db, tenant, projectId);
      const state = await loadTechnicalPlan(db, tenant, projectId);
      if (!state.globalFacts.length) throw new JobError(GLOBAL_FACTS_REQUIRED.code, GLOBAL_FACTS_REQUIRED.message);
      // 首次执行：接着全局事实生成（或上一次调整）的会话；续跑：本任务自己的现场。
      let continueFrom: AgentRunState | undefined;
      if (context.agent && !context.agent.resuming) {
        const source = await findContinuableAgentSession(db, tenant, globalFactsSessionTarget(projectId));
        if (!source) throw new JobError(GLOBAL_FACTS_SESSION_MISSING.code, GLOBAL_FACTS_SESSION_MISSING.message);
        continueFrom = source.state;
      }
      await withAgentRun(
        context.agent,
        async (run) => {
          const saved = checkpointSignature(run.taskCheckpoint);
          if (saved !== null && saved !== current) throw globalFactsInputChanged();
          const signature = saved ?? current;
          if (!run.resumed) {
            await context.log('开始 AI 调整全局事实');
            await context.setProgress(10);
            // 当前全局事实覆盖写入 global-facts.json（与桌面版 files 相同），交给 Agent 修改：写入后解除登记，不还原。续跑时 Agent 可能已
            // 改写，不再覆盖。
            await run.baseline.write(
              run.sandbox,
              GLOBAL_FACTS_OUTPUT_GROUP,
              [{ path: GLOBAL_FACTS_OUTPUT_FILE, data: Buffer.from(globalFactsAdjustmentFile(state.globalFacts), 'utf8') }],
              { replace: true, signal: context.signal },
            );
            run.baseline.release(GLOBAL_FACTS_OUTPUT_GROUP, [GLOBAL_FACTS_OUTPUT_FILE]);
          }
          // 生成时放入的材料原件不可用（快照中的副本被改动）：按当前的输入重新放入。
          if (run.unavailableProtectedFiles.length > 0) await writeGlobalFactsInputs(context, run, (await readGlobalFactsMaterials(context, projectId, state)).input);
          await context.log(run.resumed ? 'Agent 继续调整全局事实。' : 'Agent 正在调整全局事实。');
          await context.setProgress(20);
          const stage = await run.runStage<GlobalFactGroup[]>({
            stage: GLOBAL_FACTS_ADJUSTMENT_STAGE,
            prompt: run.wasPrompted(GLOBAL_FACTS_ADJUSTMENT_STAGE) ? CONTINUE_PROMPT : createGlobalFactsAdjustmentPrompt(params.requirement),
            tools: GLOBAL_FACTS_TOOLS,
            jsonSchemas: { [GLOBAL_FACTS_OUTPUT_FILE]: GLOBAL_FACTS_JSON_SCHEMA },
            outputFile: GLOBAL_FACTS_OUTPUT_FILE,
            maxExecutionRetries: 0,
            checkpointAfterPrompt: () => ({ signature }),
            validate: globalFactsValidator(run),
          });
          const groups = checkedGlobalFacts(context, stage.value);
          const reply = await run.assistantText({ maxChars: GLOBAL_FACTS_ADJUSTMENT_SUMMARY_MAX });
          const summary = reply?.text.trim() || GLOBAL_FACTS_ADJUSTMENT_DEFAULT_SUMMARY;
          await context.setProgress(95);
          // 说明先随检查点保存（写入全局事实之后签名即变化，不能再续跑），再写入全局事实。
          await run.checkpoint({ signature, summary }, 95);
          await writeGlobalFactsResult(context, projectId, groups, signature);
        },
        continueFrom ? { continueFrom } : undefined,
      );
      await context.log('全局事实 AI 调整完成');
    },
  };
}

// ---- 目录调整（8.7d） ----

/** 目录调整的阶段（与桌面版 initial_stage 相同）。 */
export const OUTLINE_ADJUSTMENT_STAGE = 'outline-adjustment';
/** 目录调整放入的当前目录（交给 Agent 修改，写入后解除登记，不还原）。 */
const OUTLINE_OUTPUT_GROUP = 'outline-output';
/** 调整说明取不到时（与桌面版相同）。 */
const OUTLINE_ADJUSTMENT_DEFAULT_SUMMARY = '目录已按要求调整完成。';
const OUTLINE_INPUT_CHANGED_MESSAGE = '招标文件、投标范围或目录已变化，本次结果已丢弃，请重新开始';

/** outline.json 交给 Agent 修改：覆盖写入后解除登记（不是受保护文件）。 */
async function writeOutlineFile(context: JobContext<unknown>, run: AgentRun, content: string): Promise<void> {
  await run.baseline.write(run.sandbox, OUTLINE_OUTPUT_GROUP, [{ path: OUTLINE_OUTPUT_FILE, data: Buffer.from(content, 'utf8') }], { replace: true, signal: context.signal });
  run.baseline.release(OUTLINE_OUTPUT_GROUP, [OUTLINE_OUTPUT_FILE]);
}

/**
 * 目录调整（8.7d，取代桌面版 outlineAdjustmentTask.cjs 的 runOutlineAdjustmentTask）：
 * - 首次执行接着目录生成（或上一次调整）的会话与工作区（src/agent/continuation.ts：与当前快照同一对、已结束的生成或调整任务的现场）；
 *   没有目录、找不到会话时失败（文案与桌面版相同，入队时也检查）。目录生成随 8.7e，在此之前没有可以续用的会话。续跑时用本任务自己的
 *   现场（只发“继续之前的任务”）；
 * - 当前目录（数据库中的，用户可能手动改过）按桌面版 buildAgentOutlineInput 写入 outline.json，交给 Agent 修改、不登记为受保护文件；
 *   与桌面版相同不放入其他材料（生成时放入的材料仍是受保护文件；原件不可用时由 8.7e 按当前输入重新放入，见路线图）；提示词、阶段、
 *   工具、预置 Schema 与桌面版相同；
 * - 提交校验与桌面版 validateOutlineOutput(..., { checkSchema: false }) 相同（JSON、目录结构、节点 id 只能沿用当前目录的，经提交修复），
 *   另按服务端的目录上限检查；通过后新节点分配 id、编号，与桌面版 continueTask 相同写回 outline.json（之后的检查点与会话看到的是正式 id）；
 * - 结果经 saveOutlineAdjustmentResult 整体替换目录、清空正文与正文生成状态（桌面版 saveOutline 的 replace），目录的项目名称与概述沿用
 *   原目录的；带上首次执行开始时的输入签名（招标文件、投标范围与目录），之后它们变化时写入被拒绝；
 * - 调整说明（桌面版 stats.adjustment.summary）：Agent 最后一条回复的全文（run.assistantText，至多 2000 字），取不到时为桌面版的固定
 *   说明；它是 AI 生成的内容，不写进任务日志，写进本任务最后的 checkpoint（{ signature, summary }），由页面状态的 outlineAdjustment
 *   给出（按纯文本显示，第 9 步）。成功后保留快照，下一次调整接着这次的会话。
 */
function createOutlineAdjustmentJob(): JobTypeDefinition<OutlineAdjustmentParams> {
  return {
    type: OUTLINE_ADJUSTMENT_JOB_TYPE,
    queue: 'agent',
    resumable: true,
    billable: true,
    agentLimits: AGENT_TASK_LIMITS.outline,
    agentTools: GLOBAL_FACTS_BUSINESS_TOOLS,
    agentWorkspace: { taskKind: OUTLINE_TASK_KIND, keepAfterSuccess: true },
    parseParams: adjustmentParamsParser('目录调整', OUTLINE_ADJUSTMENT_REQUIREMENT_MAX),
    async run(context) {
      const { db, tenant, params } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('TECHNICAL_PLAN_FAILED', '目录 AI 调整失败');
      const current = await outlineAdjustmentInputSignature(db, tenant, projectId);
      const state = await loadTechnicalPlan(db, tenant, projectId);
      const outlineData = state.outlineData;
      if (!outlineData?.outline.length) throw new JobError(OUTLINE_REQUIRED.code, OUTLINE_REQUIRED.message);
      // 首次执行：接着目录生成（或上一次调整）的会话；续跑：本任务自己的现场。
      let continueFrom: AgentRunState | undefined;
      if (context.agent && !context.agent.resuming) {
        const source = await findContinuableAgentSession(db, tenant, outlineSessionTarget(projectId));
        if (!source) throw new JobError(OUTLINE_SESSION_MISSING.code, OUTLINE_SESSION_MISSING.message);
        continueFrom = source.state;
      }
      const knownIds = collectOutlineIds(outlineData.outline);
      await withAgentRun(
        context.agent,
        async (run) => {
          const saved = checkpointSignature(run.taskCheckpoint);
          if (saved !== null && saved !== current) throw new JobError('TECHNICAL_PLAN_INPUT_CHANGED', OUTLINE_INPUT_CHANGED_MESSAGE);
          const signature = saved ?? current;
          if (!run.resumed) {
            await context.log('开始 AI 调整目录');
            await context.setProgress(10);
            // 当前目录覆盖写入 outline.json（与桌面版 files 相同）。续跑时 Agent 可能已改写，不再覆盖。
            await writeOutlineFile(context, run, outlineAdjustmentFile(outlineData.outline));
          }
          await context.log(run.resumed ? 'Agent 继续调整目录。' : 'Agent 正在调整目录。');
          await context.setProgress(20);
          const stage = await run.runStage<{ outline: AcceptedOutlineItem[] }>({
            stage: OUTLINE_ADJUSTMENT_STAGE,
            prompt: run.wasPrompted(OUTLINE_ADJUSTMENT_STAGE) ? CONTINUE_PROMPT : createOutlineAdjustmentPrompt(params.requirement),
            tools: GLOBAL_FACTS_TOOLS,
            jsonSchemas: { [OUTLINE_OUTPUT_FILE]: OUTLINE_JSON_SCHEMA },
            outputFile: OUTLINE_OUTPUT_FILE,
            maxExecutionRetries: 0,
            checkpointAfterPrompt: () => ({ signature }),
            validate: async () => {
              const file = (await run.readFiles([OUTLINE_OUTPUT_FILE])).get(OUTLINE_OUTPUT_FILE);
              if (file && file.data === null) return { value: null, issues: [{ severity: 'blocking' as const, message: `${OUTLINE_OUTPUT_FILE}过大，无法读取` }] };
              return validateOutlineOutput(file?.data?.toString('utf8') ?? '', knownIds, { checkSchema: false });
            },
          });
          const accepted = stage.value;
          if (!accepted?.outline.length) throw new JobError('TECHNICAL_PLAN_OUTLINE_INVALID', '目录调整结果不可用');
          if (context.signal.aborted) throw new JobInterruptedError();
          // 与桌面版 continueTask 相同：分配了正式 id、编号后的目录写回 outline.json。
          await writeOutlineFile(context, run, JSON.stringify(accepted, null, 2));
          const reply = await run.assistantText({ maxChars: OUTLINE_ADJUSTMENT_SUMMARY_MAX });
          const summary = reply?.text.trim() || OUTLINE_ADJUSTMENT_DEFAULT_SUMMARY;
          await context.setProgress(95);
          // 说明先随检查点保存（写入目录之后签名即变化，不能再续跑），再写入目录。
          await run.checkpoint({ signature, summary }, 95);
          let written: boolean;
          try {
            // 与桌面版相同：项目名称、概述沿用原目录的。
            written = await saveOutlineAdjustmentResult(
              db,
              tenant,
              projectId,
              { outline: accepted.outline, project_name: outlineData.project_name, project_overview: outlineData.project_overview },
              signature,
            );
          } catch (error) {
            if (error instanceof OutlineInputError) throw new JobError('TECHNICAL_PLAN_OUTLINE_INVALID', error.message, { cause: error });
            throw error;
          }
          if (!written) throw new JobError('TECHNICAL_PLAN_INPUT_CHANGED', OUTLINE_INPUT_CHANGED_MESSAGE);
        },
        continueFrom ? { continueFrom } : undefined,
      );
      await context.log('目录 AI 调整完成');
    },
  };
}

// ---- 目录生成（8.7e1） ----

export interface OutlineGenerationParams {
  /** 用户确认以无技术评分项模式生成目录（桌面版 no_technical_score_mode；技术评分项缺失时必须为 true）。 */
  noTechnicalScoreMode: boolean;
}

function parseOutlineGenerationParams(raw: unknown): OutlineGenerationParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('目录生成任务参数不合法');
  const { noTechnicalScoreMode, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof noTechnicalScoreMode !== 'boolean') throw new TypeError('目录生成任务参数不合法');
  return { noTechnicalScoreMode };
}

const TECH_REQUIREMENTS_REQUIRED: Problem = { code: 'TECHNICAL_PLAN_TECH_REQUIREMENTS_REQUIRED', message: '请先完成技术评分要求解析，再生成目录' };
const NO_TECHNICAL_SCORE_CONFIRM_REQUIRED: Problem = {
  code: 'TECHNICAL_PLAN_NO_TECHNICAL_SCORE_CONFIRM_REQUIRED',
  message: '请先确认是否以无技术评分项模式生成目录',
};

/** 目录生成的前置条件（与桌面版 runOutlineGenerationTaskV2 开始时的检查相同；原方案未解析完成的两条是 Web 版新增的，同 8.7c1）。 */
function outlineGenerationProblem(state: TechnicalPlanState, confirmedNoTechnicalScore: boolean): Problem | null {
  const task = state.bidAnalysisTasks.techRequirements;
  const content = String(task?.content || '').trim();
  if (task?.status !== 'success' || !content) return TECH_REQUIREMENTS_REQUIRED;
  if (isMissingTechnicalScoreItems(content) && !confirmedNoTechnicalScore) return NO_TECHNICAL_SCORE_CONFIRM_REQUIRED;
  const plan = state.originalPlanFile;
  if (plan?.status === 'error') return { code: 'TECHNICAL_PLAN_ORIGINAL_PLAN_FAILED', message: '原方案解析失败，请移除后重新上传' };
  if (plan && (plan.status !== 'success' || !plan.markdownArtifactId)) {
    return { code: 'TECHNICAL_PLAN_ORIGINAL_PLAN_NOT_READY', message: '原方案尚未解析完成，请稍后再试' };
  }
  return null;
}

/** 目录生成放入的材料（受保护文件）与预置的 outline.json（交给 Agent 写入）。 */
const OUTLINE_GENERATION_INPUT_GROUP = 'outline-generation-inputs';
const OUTLINE_GENERATION_INPUT_CHANGED_MESSAGE = '招标文件、解析结果、原方案、目录配置、目录或全局事实已变化，本次结果已丢弃，请重新开始';

function outlineGenerationInputChanged(): JobError {
  return new JobError('TECHNICAL_PLAN_INPUT_CHANGED', OUTLINE_GENERATION_INPUT_CHANGED_MESSAGE);
}

/** 目录生成的一级目录阶段的材料与提示词（首次执行放入；续跑时原件不可用才重新放入）。前置条件不满足时以对应的 JobError 失败。 */
async function readInitialOutlineMaterials(
  context: JobContext<OutlineGenerationParams>,
  projectId: string,
  state: TechnicalPlanState,
): Promise<{ input: InitialOutlineInput; mode: OutlineGenerationMode }> {
  const { db, tenant, params } = context;
  const problem = outlineGenerationProblem(state, params.noTechnicalScoreMode);
  if (problem) throw new JobError(problem.code, problem.message);
  const noTechnicalScoreMode = isMissingTechnicalScoreItems(state.techRequirements);
  const hasOriginalPlan = state.originalPlanFile !== null;
  const originalPlanMarkdown = hasOriginalPlan
    ? (await readForJob(() => readGlobalFactsSources(db, tenant, projectId, context.objectStore, { tenders: false }))).originalPlanMarkdown
    : '';
  const source = {
    outlineMode: state.outlineMode,
    hasOriginalPlan,
    outlineExpansionMode: state.outlineExpansionMode,
    originalPlanMarkdown,
    responseFileRequirements: state.bidAnalysisTasks.responseFileRequirements?.content || '',
    projectOverview: state.projectOverview,
    techRequirements: state.techRequirements,
    noTechnicalScoreMode,
    knowledgeMarkdowns: [] as string[],
  };
  if (initialOutlineNeedsKnowledge(source) && state.referenceKnowledgeDocumentIds.length > 0) {
    source.knowledgeMarkdowns = await readForJob(() => readOutlineKnowledgeMarkdowns(db, tenant, projectId, context.objectStore));
  }
  return { input: buildInitialOutlineInput(source), mode: state.outlineMode };
}

/**
 * 目录生成（8.7e1 一级目录与确认、8.7e2a / 8.7e2b 确认之后的后续阶段，取代桌面版 outlineGenerationTaskV2.cjs 的 runOutlineGenerationTaskV2）：
 * - 输入在任务开始时从数据库读取：技术评分要求（须解析成功；技术评分项缺失时须确认无技术评分项模式，任务参数 noTechnicalScoreMode）、
 *   响应文件要求、项目概述、原方案（有时）、目录的组织方式 / 扩展方式 / 字数控制与引用的知识库文档（生成配置，由 PATCH .../generation-config
 *   先保存；桌面版随开始任务的参数传入），无技术评分项模式下另读知识库文档的 Markdown；
 * - 一级目录阶段：材料（响应文件要求.md、技术评分信息.md、项目概述.md、原方案.md、参考知识库/参考资料-*.md，按模式取舍）登记为受保护
 *   文件，预置空的 outline.json；提示词、预置 Schema、工具与桌面版相同；提交校验与桌面版 validateOutlineOutput(content) 相同（经提交修复），
 *   另限制一级目录数与大小；通过后与桌面版 continueTask 相同写回 outline.json；
 * - 一级目录确认（桌面版 waitForOutlineSelection）：生成的一级目录与默认选择（桌面版 defaultSelectedIds）随检查点写进 checkpoint
 *   （{ signature, selection }），任务抛出 JobSelectionRequiredError、暂停为 waiting_for_selection（沙箱销毁，不占 Agent 并发与运行时长）；
 *   用户经 POST .../outline-selection 确认（confirmOutlineSelection，写入 checkpoint 的 confirmed）后任务续跑。确认前被手动继续时再次暂停；
 * - 确认后：所选一级目录（按原顺序重新编号）都不需要 AI 扩展时（没有 ai-generate），与桌面版相同直接整理为最终目录（桌面版
 *   buildFinalOutline），经 saveOutlineGenerationResult 带输入签名整体替换目录、清空正文与全局事实、写入字数控制快照，再丢弃全局事实的
 *   会话（桌面版目录生成开始时删除）；这一路不再打开沙箱。需要 AI 扩展时经 runDirectory 续接本任务的会话：无技术评分项模式执行子目录
 *   生成、叶子调整与目录审查（8.7e2a），评分模式执行评分规划、叶子分配、子目录生成、叶子调整与目录审查（8.7e2b）；
 * - 桌面版有模板填写一级目录时并行执行投标模板提取（属 8.13）：按 8.7e1 开始前用户的决定先不接入，这类一级目录照常保留其处理方式；
 * - 可续跑：每条提示词之后保存检查点（工作区快照与 checkpoint，签名在其中），续跑时输入已变化即失败；成功后保留快照（keepAfterSuccess），
 *   目录调整接着这次的会话。
 */
function createOutlineGenerationJob(): JobTypeDefinition<OutlineGenerationParams> {
  return {
    type: OUTLINE_GENERATION_JOB_TYPE,
    queue: 'agent',
    resumable: true,
    billable: true,
    agentLimits: AGENT_TASK_LIMITS.outline,
    agentTools: GLOBAL_FACTS_BUSINESS_TOOLS,
    agentWorkspace: { taskKind: OUTLINE_TASK_KIND, keepAfterSuccess: true },
    parseParams: parseOutlineGenerationParams,
    async run(context) {
      const { db, tenant } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('TECHNICAL_PLAN_FAILED', '目录生成失败');
      // 先取签名再读状态与材料：读取期间输入变化时签名已过期，写入被拒绝。
      const current = await outlineGenerationInputSignature(db, tenant, projectId);
      const state = await loadTechnicalPlan(db, tenant, projectId);
      const saved = checkpointSignature(isPlainRecord(context.checkpoint?.task) ? context.checkpoint.task : null);
      if (saved !== null && saved !== current) throw outlineGenerationInputChanged();
      const signature = saved ?? current;
      const { selection, confirmed } = readOutlineSelectionState(context.checkpoint?.task);
      if (confirmed) {
        const lockedRoots = lockedOutlineRoots(confirmed.items, confirmed.selectedIds);
        if (!lockedRoots.length) throw new JobError('TECHNICAL_PLAN_OUTLINE_INVALID', '请至少选择一个一级目录');
        if (!lockedRoots.some((item) => item.content_mode === AI_CONTENT_MODE)) {
          await finishOutlineSelection(context, projectId, state, lockedRoots, signature);
          return;
        }
        await runDirectory(context, projectId, state, { signature, selection: selection ?? confirmed, confirmed }, lockedRoots);
        return;
      }
      // 已生成一级目录、尚未确认（确认前被手动继续）：再次等待确认。
      if (selection) throw new JobSelectionRequiredError();
      const { input, mode } = await readInitialOutlineMaterials(context, projectId, state);
      await withAgentRun(context.agent, async (run) => {
        if (!run.resumed) {
          await context.log('开始生成一级目录');
          await context.setProgress(10);
          await run.baseline.write(
            run.sandbox,
            OUTLINE_GENERATION_INPUT_GROUP,
            input.files.map((file) => ({ path: file.path, data: Buffer.from(file.content, 'utf8') })),
            { replace: true, signal: context.signal },
          );
          // 与桌面版 prepare_output_files 相同：预置空的 outline.json，交给 Agent 写入。
          await writeOutlineFile(context, run, '');
        } else if (run.unavailableProtectedFiles.length > 0) {
          // 续跑时材料在快照中；原件不可用（快照中的副本被改动）时按同一输入重新放入。
          await run.baseline.write(
            run.sandbox,
            OUTLINE_GENERATION_INPUT_GROUP,
            input.files.map((file) => ({ path: file.path, data: Buffer.from(file.content, 'utf8') })),
            { replace: true, signal: context.signal },
          );
        }
        const stage = await run.runStage<{ outline: AcceptedOutlineItem[] }>({
          stage: INITIAL_OUTLINE_STAGE,
          stageIndex: 0,
          prompt: run.wasPrompted(INITIAL_OUTLINE_STAGE) ? CONTINUE_PROMPT : input.prompt,
          tools: GLOBAL_FACTS_TOOLS,
          jsonSchemas: outlineGenerationJsonSchemas({ noTechnicalScoreMode: isMissingTechnicalScoreItems(state.techRequirements), standaloneTechnical: input.standaloneTechnical }),
          outputFile: OUTLINE_OUTPUT_FILE,
          // 与桌面版 max_retries 1 + buildRetryPrompt 相同：执行失败时 createOutputRepairPrompt 返回 null，不重试。
          maxExecutionRetries: 1,
          retryPrompt: () => null,
          repairPrompt: () => createOutputRepairPrompt(INITIAL_OUTLINE_STAGE),
          checkpointAfterPrompt: () => ({ signature }),
          validate: async () => {
            const file = (await run.readFiles([OUTLINE_OUTPUT_FILE])).get(OUTLINE_OUTPUT_FILE);
            if (file && file.data === null) return { value: null, issues: [{ severity: 'blocking' as const, message: `${OUTLINE_OUTPUT_FILE}过大，无法读取` }] };
            return validateInitialOutlineOutput(file?.data?.toString('utf8') ?? '');
          },
        });
        const accepted = stage.value;
        if (!accepted?.outline.length) throw new JobError('TECHNICAL_PLAN_OUTLINE_INVALID', '一级目录生成结果不可用');
        if (context.signal.aborted) throw new JobInterruptedError();
        // 与桌面版 continueTask 相同：分配了正式 id、编号后的一级目录写回 outline.json。
        await writeOutlineFile(context, run, JSON.stringify(accepted, null, 2));
        const pending: OutlineSelectionRecord = { items: accepted.outline, selectedIds: defaultOutlineSelection(accepted.outline, mode) };
        await context.log('一级目录已生成，等待用户确认');
        await run.checkpoint({ signature, selection: pending }, 30);
      });
      throw new JobSelectionRequiredError();
    },
  };
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 写入目录生成的结果（带输入签名），再丢弃全局事实的会话（见 createOutlineGenerationJob）。 */
async function writeOutlineGenerationResult(
  context: JobContext<OutlineGenerationParams>,
  projectId: string,
  state: TechnicalPlanState,
  outline: readonly AcceptedOutlineItem[],
  signature: string,
): Promise<void> {
  const { db, tenant } = context;
  let written: boolean;
  try {
    written = await saveOutlineGenerationResult(
      db,
      tenant,
      projectId,
      { outline, projectOverview: state.projectOverview, wordControl: state.outlineWordControlOptions },
      signature,
    );
  } catch (error) {
    if (error instanceof OutlineInputError) throw new JobError('TECHNICAL_PLAN_OUTLINE_INVALID', error.message, { cause: error });
    throw error;
  }
  if (!written) throw outlineGenerationInputChanged();
  // 全局事实已清空：全局事实的会话不再续用（桌面版目录生成开始时删除）。目录的会话保留给目录调整。丢弃失败的留给下一次生成替换。
  // 正文已清空：正文的会话同样不再续用（桌面版目录生成开始时一并删除，8.10b1）。
  await discardAgentWorkspaceSnapshots(db, tenant, context.objectStore, projectId, [GLOBAL_FACTS_TASK_KIND, CONTENT_GENERATION_TASK_KIND]).catch(() => {});
}

/** 一级目录确认之后、所选一级目录都不需要 AI 扩展时（见 createOutlineGenerationJob）。 */
async function finishOutlineSelection(
  context: JobContext<OutlineGenerationParams>,
  projectId: string,
  state: TechnicalPlanState,
  lockedRoots: readonly AcceptedOutlineItem[],
  signature: string,
): Promise<void> {
  await context.log('一级目录已确认，所选目录无需 AI 扩展');
  await context.setProgress(35);
  const outline = finalOutlineOf(lockedRoots);
  await context.log('所选一级目录已整理完成');
  await context.setProgress(98);
  await writeOutlineGenerationResult(context, projectId, state, outline, signature);
  await context.log('所选一级目录整理完成');
}

// ---- 目录生成：确认之后的后续阶段（8.7e2a 无技术评分项模式、8.7e2b 评分模式） ----

/** 目录审查放入的程序计算结果（受保护文件）。 */
const OUTLINE_REVIEW_CONTEXT_GROUP = 'outline-review-context';
/** 评分模式放入的材料与程序整理后的文件（受保护文件）：技术评分信息与知识库、评分规划、叶子分配的材料、子目录生成用的叶子分配。 */
const SCORE_INPUT_GROUP = 'outline-score-inputs';
const SCORE_PLAN_GROUP = 'outline-score-plan';
const LEAF_ALLOCATION_CONTEXT_GROUP = 'outline-leaf-allocation-context';
const LEAF_ALLOCATION_GROUP = 'outline-leaf-allocation';
/** 后续阶段的第一个序号（与桌面版 initial_stage_index 2 相同，之后每个阶段加 1）。 */
const DIRECTORY_STAGE_INDEX = 2;
const DIRECTORY_STAGES = [SCORE_PLANNING_STAGE, LEAF_ALLOCATION_STAGE, CHILDREN_GENERATION_STAGE, LEAF_ADJUSTMENT_STAGE, OUTLINE_REVIEW_STAGE] as const;
type DirectoryStage = (typeof DIRECTORY_STAGES)[number];
/** 终止确认的选项（桌面版不把终止确认记进 user_question_answers）。 */
const TERMINATION_OPTION_LABELS = TERMINATION_OPTIONS.map((option) => option.label);

/**
 * 评分模式在评分规划之后的状态（随 directory 写进 checkpoint）：
 * - plan：评分规划（root_id 已回填；每个阶段之后按目录同步一级目录标题，与桌面版 synchronizeScoreDirectoryPlan 相同）；
 * - rootIds / newRoots：评分规划之后的一级目录（确认后的一级目录加上用户批准新增的，按顺序；新增的单独保存，确认后的取自 confirmed）；
 * - targetLeafCount：“AI 生成”叶子的目标（单独技术分册按 enforceMinimumLeafTarget 调整后的）；fixedAiLeafCount：规划分支之外的 AI 生成
 *   一级目录数；allocations：子目录生成用的叶子分配（叶子分配阶段之前为 null）。
 */
interface ScoringFlow {
  plan: ScoreDirectoryPlan;
  rootIds: string[];
  newRoots: AcceptedOutlineItem[];
  targetLeafCount: number | null;
  fixedAiLeafCount: number;
  allocations: LeafAllocation['allocations'] | null;
}

/**
 * 后续阶段的进度，随检查点写进 checkpoint 中任务自己的状态（directory）。每个阶段的要求发出前（交接时）先保存一次（prompted 为 false），
 * 发出后每条提示词之后再保存（prompted 为 true）：续跑时 prompted 为 false 则重新发出该阶段的要求，否则只发“继续之前的任务”。叶子调整
 * 可以接连多次，因此不按执行者现场中已发出的阶段判断。
 */
interface DirectoryFlow {
  stage: DirectoryStage;
  stageIndex: number;
  prompted: boolean;
  /** 本阶段目录可以沿用的节点 id（上一阶段整理后的目录的；评分规划、子目录生成时为一级目录的）。 */
  knownIds: string[];
  /** 本阶段开始时的“AI 生成”叶子数（叶子调整、目录审查的提示词用）。 */
  actualLeafCount: number;
  /** 叶子数与目标不同、用户接受当前结果时的提示（桌面版 leafWarning）。 */
  leafWarning: string;
  /** 第一次叶子调整开始的时间（数据库时钟）：之后提出的问题才是叶子调整中的（桌面版按 workflow_stage 区分）。 */
  leafSince: string | null;
  /** 评分模式在评分规划之后的状态（无技术评分项模式与评分规划阶段为 null；8.7e2a 的 checkpoint 没有这一项，按 null）。 */
  scoring: ScoringFlow | null;
}

const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function readScoringFlow(value: unknown): ScoringFlow | null {
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value)) throw new TypeError('目录生成的 checkpoint 不合法');
  const newRoots = parseOutlineRoots(value.newRoots, { allowEmpty: true });
  if (
    !isScoreDirectoryPlan(value.plan) ||
    !newRoots ||
    !Array.isArray(value.rootIds) ||
    value.rootIds.length === 0 ||
    value.rootIds.length > OUTLINE_SELECTION_ITEMS_MAX ||
    !value.rootIds.every((id) => typeof id === 'string') ||
    new Set(value.rootIds).size !== value.rootIds.length ||
    !newRoots.every((root) => (value.rootIds as string[]).includes(root.id)) ||
    !(value.targetLeafCount === null || Number.isSafeInteger(value.targetLeafCount)) ||
    !isNonNegativeInteger(value.fixedAiLeafCount) ||
    !(value.allocations === null || isLeafAllocationList(value.allocations))
  ) {
    throw new TypeError('目录生成的 checkpoint 不合法');
  }
  return {
    plan: value.plan,
    rootIds: [...(value.rootIds as string[])],
    newRoots,
    targetLeafCount: value.targetLeafCount as number | null,
    fixedAiLeafCount: value.fixedAiLeafCount,
    allocations: value.allocations as LeafAllocation['allocations'] | null,
  };
}

/** 读出 checkpoint 中的后续阶段进度：没有时 null；形状不对时抛 TypeError（checkpoint 由 worker 写入，仍逐项检查）。 */
function readDirectoryFlow(task: Record<string, unknown> | null): DirectoryFlow | null {
  if (!task || !Object.hasOwn(task, 'directory')) return null;
  const value = task.directory;
  if (
    !isPlainRecord(value) ||
    !DIRECTORY_STAGES.includes(value.stage as DirectoryStage) ||
    !isNonNegativeInteger(value.stageIndex) ||
    typeof value.prompted !== 'boolean' ||
    !Array.isArray(value.knownIds) ||
    value.knownIds.length > TECHNICAL_PLAN_OUTLINE_NODES_MAX ||
    !value.knownIds.every((id) => typeof id === 'string') ||
    !isNonNegativeInteger(value.actualLeafCount) ||
    typeof value.leafWarning !== 'string' ||
    (value.leafSince !== null && (typeof value.leafSince !== 'string' || Number.isNaN(Date.parse(value.leafSince))))
  ) {
    throw new TypeError('目录生成的 checkpoint 不合法');
  }
  return {
    stage: value.stage as DirectoryStage,
    stageIndex: value.stageIndex,
    prompted: value.prompted,
    knownIds: [...(value.knownIds as string[])],
    actualLeafCount: value.actualLeafCount,
    leafWarning: value.leafWarning,
    leafSince: value.leafSince as string | null,
    scoring: readScoringFlow(value.scoring),
  };
}

/** 后续阶段写进 checkpoint 的任务状态：签名、一级目录（待确认与确认后的）与后续阶段进度。 */
interface DirectoryBase {
  signature: string;
  selection: OutlineSelectionRecord;
  confirmed: OutlineSelectionRecord;
}

/** 后续阶段的结果：目录（与目录审查的结果）、评分规划阶段的一级目录与规划、叶子分配阶段的分配。 */
type DirectoryStageValue =
  | { kind: 'outline'; outline: { outline: AcceptedOutlineItem[] }; review: OutlineReview | null }
  | { kind: 'planning'; roots: AcceptedOutlineItem[]; newRoots: AcceptedOutlineItem[]; plan: ScoreDirectoryPlan }
  | { kind: 'allocation'; allocation: LeafAllocation };

/**
 * 确认之后的后续阶段（桌面版 runOutlineGenerationTaskV2 的 directoryPromise）：
 * - 打开沙箱续接本任务的会话（一级目录阶段的快照，run.resumed）。阶段、提示词、工具、预置 Schema、提交校验（经提交修复）、阶段之间放入的
 *   文件与日志、叶子调整的判断（用户最近一次回答是否“接受当前结果”）与桌面版相同；
 * - 无技术评分项模式（8.7e2a）：材料（与一级目录阶段相同的一份）重新放入为受保护文件，outline.json 为确认后的一级目录（交给 Agent 修改）；
 *   子目录生成（children-generation）→ 叶子数与目标不同时叶子调整（leaf-adjustment，可接连多次）→ 目录审查（outline-review，放入程序
 *   计算的 outline-review-context.json 与预置空的 outline-review.json）；
 * - 评分模式（8.7e2b）：评分规划（score-planning：放入技术评分信息.md 与知识库、预置空的 technical-score-groups.json 与
 *   score-directory-plan.json；提交校验核对两份文件的 Schema 与 outline.json 中的一级目录，只接受用户批准新增的技术一级目录，新增的分配
 *   id 后回填规划的 root_id）→ 有字数目标且有多个技术分支时叶子分配（leaf-allocation：放入 leaf-allocation-context.json，预置空的
 *   leaf-allocation.json）→ 子目录生成（放入程序整理的 leaf-allocation.json）→ 叶子调整 → 目录审查（评分映射的机械检查一并放入
 *   outline-review-context.json，评分规划与技术评分信息附在提示词后）。程序整理后的评分规划与叶子分配登记为受保护文件，权威副本在
 *   checkpoint 中（审查的提示词与评分映射的检查只用它，不读回沙箱中的副本）；
 * - 目录审查通过后整理后的目录写回 outline.json，经 saveOutlineGenerationResult 带输入签名写入，再丢弃全局事实的会话（与一级目录无需
 *   AI 扩展时相同）。
 */
async function runDirectory(
  context: JobContext<OutlineGenerationParams>,
  projectId: string,
  state: TechnicalPlanState,
  base: DirectoryBase,
  lockedRoots: readonly AcceptedOutlineItem[],
): Promise<void> {
  const { db, tenant } = context;
  const { input } = await readInitialOutlineMaterials(context, projectId, state);
  const { standaloneTechnical, originalOnly } = input;
  const scoringMode = !isMissingTechnicalScoreItems(state.techRequirements);
  const hasOriginalPlan = state.originalPlanFile !== null;
  const baseTarget = deriveTargetLeafCount(state.outlineWordControlOptions);
  const scoreFiles = scoringMode
    ? buildScorePlanningFiles(
        state.techRequirements,
        state.referenceKnowledgeDocumentIds.length > 0 ? await readForJob(() => readOutlineKnowledgeMarkdowns(db, tenant, projectId, context.objectStore)) : [],
      )
    : [];
  const jsonSchemas = outlineGenerationJsonSchemas({ noTechnicalScoreMode: !scoringMode, standaloneTechnical });
  const taskState = (flow: DirectoryFlow): Record<string, unknown> => ({ ...base, directory: { ...flow } });
  const targetOf = (flow: DirectoryFlow): number | null => (flow.scoring ? flow.scoring.targetLeafCount : baseTarget);
  const protectedWrite = (run: AgentRun, group: string, files: readonly AgentInputFile[]) =>
    run.baseline.write(
      run.sandbox,
      group,
      files.map((file) => ({ path: file.path, data: Buffer.from(file.content, 'utf8') })),
      { replace: true, signal: context.signal },
    );
  const writeInputs = (run: AgentRun) => protectedWrite(run, OUTLINE_GENERATION_INPUT_GROUP, input.files);
  /** 交给 Agent 写入的文件（预置为空，与桌面版 prepare_output_files 相同）：覆盖写入后解除登记。 */
  const prepareOutputs = async (run: AgentRun, paths: readonly string[]) => {
    await run.baseline.write(run.sandbox, OUTLINE_OUTPUT_GROUP, paths.map((path) => ({ path, data: Buffer.alloc(0) })), { replace: true, signal: context.signal });
    run.baseline.release(OUTLINE_OUTPUT_GROUP, paths);
  };
  const planText = (scoring: ScoringFlow) => JSON.stringify(scoring.plan, null, 2);
  const writePlan = (run: AgentRun, scoring: ScoringFlow) => protectedWrite(run, SCORE_PLAN_GROUP, [{ path: SCORE_DIRECTORY_PLAN_FILE, content: planText(scoring) }]);
  /** 与桌面版 leaf-allocation-context.json 相同。 */
  const leafContextText = (scoring: ScoringFlow) =>
    JSON.stringify(
      {
        mode: 'allocated',
        target_ai_leaf_count: scoring.targetLeafCount,
        fixed_ai_leaf_count: scoring.fixedAiLeafCount,
        allocatable_ai_leaf_count: scoring.targetLeafCount! - scoring.fixedAiLeafCount,
        technical_branches: scoring.plan.branches.map((branch) => ({ root_id: branch.root_id, root_title: branch.root_title })),
      },
      null,
      2,
    );
  /** 与桌面版 continueWithChildrenGeneration 放入的 leaf-allocation.json 相同。 */
  const allocationText = (scoring: ScoringFlow) =>
    JSON.stringify(
      {
        mode: scoring.targetLeafCount === null ? 'agent-decides' : 'allocated',
        target_ai_leaf_count: scoring.targetLeafCount,
        fixed_ai_leaf_count: scoring.fixedAiLeafCount,
        allocatable_ai_leaf_count: scoring.targetLeafCount === null ? null : scoring.targetLeafCount - scoring.fixedAiLeafCount,
        allocations: scoring.allocations,
      },
      null,
      2,
    );
  /** 评分规划之后的一级目录（与桌面版 validateScorePlanningRoots 接受的相同：确认后的与新增的按顺序整理、编号）。 */
  const rootsOf = (scoring: ScoringFlow): AcceptedOutlineItem[] => {
    const byId = new Map([...lockedRoots, ...scoring.newRoots].map((root) => [root.id, root]));
    const roots = scoring.rootIds.map((id) => byId.get(id));
    if (roots.some((root) => root === undefined)) throw new TypeError('目录生成的 checkpoint 不合法');
    return finalOutlineOf(roots as AcceptedOutlineItem[]);
  };
  const readText = async (run: AgentRun, file: string): Promise<{ text: string } | { tooLarge: true }> => {
    const read = (await run.readFiles([file])).get(file);
    if (read && read.data === null) return { tooLarge: true };
    return { text: read?.data?.toString('utf8') ?? '' };
  };
  const tooLarge = (file: string) => ({ value: null, issues: [{ severity: 'blocking' as const, message: `${file}过大，无法读取` }] });
  // 与桌面版 publish 相同：与上一条相同的日志不再重复写（接连两次叶子调整时只写一次）。
  let lastLog = '';
  const publish = async (message: string, progress: number) => {
    if (message !== lastLog) await context.log(message);
    lastLog = message;
    await context.setProgress(progress);
  };

  /** 目录审查的提示词：材料附在提示词后（与桌面版相同；原方案、技术评分信息取放入的同一份，评分规划取 checkpoint 中的）。 */
  const reviewPrompt = (flow: DirectoryFlow, outlineText: string, contextText: string): string => {
    const targetLeafCount = targetOf(flow);
    if (flow.scoring) {
      const files: AgentInputFile[] = [
        { path: OUTLINE_OUTPUT_FILE, content: outlineText },
        { path: SCORE_DIRECTORY_PLAN_FILE, content: planText(flow.scoring) },
        { path: OUTLINE_REVIEW_CONTEXT_FILE, content: contextText },
        ...scoreFiles.filter((file) => file.path === TECHNICAL_SCORE_INFO_FILE),
      ];
      return createOutlineReviewPrompt({ targetLeafCount, actualLeafCount: flow.actualLeafCount, allowRootChanges: flow.scoring.plan.allow_root_changes === true, inputFiles: files });
    }
    const files: AgentInputFile[] = [
      { path: OUTLINE_OUTPUT_FILE, content: outlineText },
      { path: OUTLINE_REVIEW_CONTEXT_FILE, content: contextText },
      ...(originalOnly ? input.files.filter((file) => file.path === '原方案.md') : []),
    ];
    return createNoTechnicalScoreReviewPrompt({ targetLeafCount, actualLeafCount: flow.actualLeafCount, originalOnly, inputFiles: files });
  };

  /** 续跑时原件不可用（快照中的副本被改动）：按同一输入与 checkpoint 重新放入（审查材料由程序算出，不重新放入：需要还原时任务失败）。 */
  const rewriteProtected = async (run: AgentRun, flow: DirectoryFlow | null) => {
    await writeInputs(run);
    if (!scoringMode) return;
    await protectedWrite(run, SCORE_INPUT_GROUP, scoreFiles);
    if (!flow?.scoring) return;
    await writePlan(run, flow.scoring);
    if (flow.stage === LEAF_ALLOCATION_STAGE) await protectedWrite(run, LEAF_ALLOCATION_CONTEXT_GROUP, [{ path: LEAF_ALLOCATION_CONTEXT_FILE, content: leafContextText(flow.scoring) }]);
    if (flow.scoring.allocations) await protectedWrite(run, LEAF_ALLOCATION_GROUP, [{ path: LEAF_ALLOCATION_FILE, content: allocationText(flow.scoring) }]);
  };

  await withAgentRun(context.agent, async (run) => {
    let flow = readDirectoryFlow(run.taskCheckpoint);
    // 进度须与模式相符：评分规划、叶子分配只在评分模式；评分规划之后（且只在那之后）有评分模式的状态。
    if (
      flow &&
      ((!scoringMode && (flow.stage === SCORE_PLANNING_STAGE || flow.stage === LEAF_ALLOCATION_STAGE)) ||
        (flow.scoring !== null) !== (scoringMode && flow.stage !== SCORE_PLANNING_STAGE))
    ) {
      throw new TypeError('目录生成的 checkpoint 不合法');
    }
    /** 交接时算出的本阶段要求（续跑时 prompted 为 false 的按 flow 与工作区重新算出）。 */
    let pendingPrompt: string | null = null;
    if (!flow) {
      const templateRoots = !standaloneTechnical && lockedRoots.some((item) => item.content_mode === 'template-fill');
      // 与桌面版相同；桌面版有模板填写目录时写“目录生成与投标模版提取并行开始”，Web 版不提取投标模板（随 8.13）。
      await publish(
        !scoringMode
          ? '一级目录已确认，开始按无技术评分项模式生成目录'
          : standaloneTechnical
            ? '一级目录已确认，已跳过投标模版提取，开始生成技术文件目录'
            : templateRoots
              ? '一级目录已确认，开始生成完整目录'
              : '一级目录已确认，当前无模板填写目录，已跳过投标模版提取，开始生成完整目录',
        35,
      );
      if (scoringMode) {
        // 与桌面版 files 相同：确认后的一级目录、技术评分信息与知识库；预置空的评分清单与评分规划。一级目录阶段的材料仍在工作区中。
        if (run.unavailableProtectedFiles.length > 0) await writeInputs(run);
        await protectedWrite(run, SCORE_INPUT_GROUP, scoreFiles);
        await writeOutlineFile(context, run, JSON.stringify({ outline: lockedRoots }, null, 2));
        await prepareOutputs(run, [TECHNICAL_SCORE_GROUPS_FILE, SCORE_DIRECTORY_PLAN_FILE]);
      } else {
        // 与桌面版 files 相同：确认后的一级目录与一级目录阶段的材料。
        await writeInputs(run);
        await writeOutlineFile(context, run, JSON.stringify({ outline: lockedRoots }, null, 2));
      }
      flow = {
        stage: scoringMode ? SCORE_PLANNING_STAGE : CHILDREN_GENERATION_STAGE,
        stageIndex: DIRECTORY_STAGE_INDEX,
        prompted: false,
        knownIds: [...collectOutlineIds(lockedRoots)],
        actualLeafCount: 0,
        leafWarning: '',
        leafSince: null,
        scoring: null,
      };
    } else if (run.unavailableProtectedFiles.length > 0) {
      await rewriteProtected(run, flow);
    }

    /** 交接到子目录生成（与桌面版 continueWithChildrenGeneration 相同）。 */
    const toChildren = async (scoring: ScoringFlow, stageIndex: number): Promise<DirectoryFlow> => {
      await publish('技术方案目录已确认，开始生成子目录', 55);
      const roots = rootsOf(scoring);
      await writeOutlineFile(context, run, JSON.stringify({ outline: roots }, null, 2));
      await protectedWrite(run, LEAF_ALLOCATION_GROUP, [{ path: LEAF_ALLOCATION_FILE, content: allocationText(scoring) }]);
      const next: DirectoryFlow = {
        stage: CHILDREN_GENERATION_STAGE,
        stageIndex,
        prompted: false,
        knownIds: [...collectOutlineIds(roots)],
        actualLeafCount: 0,
        leafWarning: '',
        leafSince: null,
        scoring,
      };
      await run.checkpoint(taskState(next), 55);
      return next;
    };

    for (;;) {
      const current: DirectoryFlow = flow;
      const stage = current.stage;
      const scoring = current.scoring;
      const targetLeafCount = targetOf(current);
      let promptText: string;
      if (current.prompted) {
        promptText = CONTINUE_PROMPT;
      } else if (pendingPrompt !== null) {
        promptText = pendingPrompt;
      } else if (stage === SCORE_PLANNING_STAGE) {
        promptText = createScorePlanningPrompt({ standaloneTechnical });
      } else if (stage === LEAF_ALLOCATION_STAGE) {
        promptText = createLeafAllocationPrompt({ standaloneTechnical });
      } else if (stage === CHILDREN_GENERATION_STAGE) {
        promptText = scoring
          ? createChildrenPrompt({ hasOriginalPlan, originalOnly, targetLeafCount, allowRootChanges: scoring.plan.allow_root_changes === true, standaloneTechnical })
          : createNoTechnicalScoreChildrenPrompt({ targetLeafCount, standaloneTechnical, originalOnly });
      } else if (stage === LEAF_ADJUSTMENT_STAGE) {
        promptText = createLeafAdjustmentPrompt(targetLeafCount!, current.actualLeafCount, { noTechnicalScoreMode: !scoringMode, originalOnly });
      } else {
        // 续跑时审查的要求尚未发出：交接时写入的 outline.json 与审查材料在快照中（之后没有执行过提示词）。
        const outlineText = await readText(run, OUTLINE_OUTPUT_FILE);
        const contextText = run.baseline.original(OUTLINE_REVIEW_CONTEXT_FILE);
        if ('tooLarge' in outlineText || contextText === null) throw new JobError('TECHNICAL_PLAN_OUTLINE_INVALID', '目录审查的材料不可用，请重新生成目录');
        promptText = reviewPrompt(current, outlineText.text, contextText.toString('utf8'));
      }
      pendingPrompt = null;
      const knownIds = new Set(current.knownIds);
      const result = await run.runStage<DirectoryStageValue>({
        stage,
        stageIndex: current.stageIndex,
        prompt: promptText,
        tools: GLOBAL_FACTS_TOOLS,
        jsonSchemas,
        outputFile: OUTLINE_OUTPUT_FILE,
        // 与桌面版 max_retries 1 + buildRetryPrompt 相同：执行失败时不重试；提交修复的说明按本阶段的必需文件。
        maxExecutionRetries: 1,
        retryPrompt: () => null,
        repairPrompt: () => createOutputRepairPrompt(stage),
        checkpointAfterPrompt: () => taskState({ ...current, prompted: true }),
        validate: async () => {
          if (stage === LEAF_ALLOCATION_STAGE) {
            const allocationFile = await readText(run, LEAF_ALLOCATION_FILE);
            if ('tooLarge' in allocationFile) return tooLarge(LEAF_ALLOCATION_FILE);
            const report = validateLeafAllocationOutput(allocationFile.text, standaloneTechnical);
            return { value: report.value ? { kind: 'allocation' as const, allocation: report.value } : null, issues: report.issues };
          }
          if (stage === SCORE_PLANNING_STAGE) {
            const texts: string[] = [];
            for (const file of [TECHNICAL_SCORE_GROUPS_FILE, SCORE_DIRECTORY_PLAN_FILE, OUTLINE_OUTPUT_FILE]) {
              const read = await readText(run, file);
              if ('tooLarge' in read) return tooLarge(file);
              texts.push(read.text);
            }
            const report = validateScorePlanningOutputs(texts[0]!, texts[1]!, texts[2]!, lockedRoots);
            return { value: report.value ? { kind: 'planning' as const, ...report.value } : null, issues: report.issues };
          }
          const outlineText = await readText(run, OUTLINE_OUTPUT_FILE);
          if ('tooLarge' in outlineText) return tooLarge(OUTLINE_OUTPUT_FILE);
          if (stage !== OUTLINE_REVIEW_STAGE) {
            const report = validateOutlineOutput(outlineText.text, knownIds);
            return { value: report.value ? { kind: 'outline' as const, outline: report.value, review: null } : null, issues: report.issues };
          }
          const reviewText = await readText(run, OUTLINE_REVIEW_FILE);
          if ('tooLarge' in reviewText) return tooLarge(OUTLINE_REVIEW_FILE);
          const report = validateOutlineReviewOutputs(outlineText.text, reviewText.text, knownIds);
          return { value: report.value ? { kind: 'outline' as const, ...report.value } : null, issues: report.issues };
        },
      });
      const accepted = result.value;
      if (!accepted) throw new JobError('TECHNICAL_PLAN_OUTLINE_INVALID', '目录生成结果不可用');
      if (context.signal.aborted) throw new JobInterruptedError();

      if (accepted.kind === 'planning') {
        // 评分规划之后（与桌面版 continueTask 的 score-planning 相同）：用户批准新增的一级目录已分配正式 id，写回 outline.json 与评分规划。
        const roots = accepted.roots;
        const plan = synchronizeScoreDirectoryPlan(accepted.plan, roots);
        const branchIds = new Set(plan.branches.map((branch) => branch.root_id));
        const fixedAiLeafCount = roots.filter((root) => !branchIds.has(root.id) && root.content_mode === AI_CONTENT_MODE).length;
        let target = baseTarget;
        if (standaloneTechnical) {
          target = enforceMinimumLeafTarget(baseTarget, fixedAiLeafCount, plan.branches.length);
          if (baseTarget !== null && target !== baseTarget) await publish(`已按技术分支结构将 AI 生成叶子目标从 ${baseTarget} 调整为 ${target}`, 50);
        }
        const nextScoring: ScoringFlow = { plan, rootIds: roots.map((root) => root.id), newRoots: accepted.newRoots, targetLeafCount: target, fixedAiLeafCount, allocations: null };
        await writeOutlineFile(context, run, JSON.stringify({ outline: roots }, null, 2));
        await writePlan(run, nextScoring);
        const allocatable = target === null ? null : target - fixedAiLeafCount;
        if (allocatable !== null && plan.branches.length > 1) {
          await publish('技术方案目录已确认，Agent 正在分配 AI 生成小节', 50);
          await protectedWrite(run, LEAF_ALLOCATION_CONTEXT_GROUP, [{ path: LEAF_ALLOCATION_CONTEXT_FILE, content: leafContextText(nextScoring) }]);
          await prepareOutputs(run, [LEAF_ALLOCATION_FILE]);
          flow = { ...current, stage: LEAF_ALLOCATION_STAGE, stageIndex: current.stageIndex + 1, prompted: false, knownIds: nextScoring.rootIds, scoring: nextScoring };
          await run.checkpoint(taskState(flow), 50);
          continue;
        }
        nextScoring.allocations =
          allocatable === null ? plan.branches.map((branch) => ({ root_id: branch.root_id })) : [{ root_id: plan.branches[0]!.root_id, leaf_count: allocatable }];
        flow = await toChildren(nextScoring, current.stageIndex + 1);
        continue;
      }
      if (accepted.kind === 'allocation') {
        flow = await toChildren({ ...scoring!, allocations: accepted.allocation.allocations }, current.stageIndex + 1);
        continue;
      }

      const finalOutline = accepted.outline;
      const actualLeafCount = countAiLeaves(finalOutline.outline);
      const nextIds = [...collectOutlineIds(finalOutline.outline)];
      const nextScoring: ScoringFlow | null = scoring ? { ...scoring, plan: synchronizeScoreDirectoryPlan(scoring.plan, finalOutline.outline) } : null;

      if (stage === OUTLINE_REVIEW_STAGE) {
        // 与桌面版相同：整理后的目录（与评分规划）写回工作区（之后目录调整接着的会话看到的是正式 id）。
        await writeOutlineFile(context, run, JSON.stringify(finalOutline, null, 2));
        if (nextScoring) await writePlan(run, nextScoring);
        let leafWarning = current.leafWarning;
        if (targetLeafCount !== null) {
          if (actualLeafCount === targetLeafCount) leafWarning = '';
          else if (leafWarning) leafWarning = `AI 生成小节目标为 ${targetLeafCount}，用户已确认最终保留当前 ${actualLeafCount} 个。`;
        }
        await publish(outlineReviewMessage(accepted.review!), 95);
        await publish('目录生成完成', 98);
        await writeOutlineGenerationResult(context, projectId, state, finalOutline.outline, base.signature);
        // 桌面版无模板填写目录（或单独技术分册）时写“当前无模板填写目录”；Web 版不提取投标模板（随 8.13），有模板填写目录时不写这一句。
        const templateRoots = !standaloneTechnical && lockedRoots.some((item) => item.content_mode === 'template-fill');
        await context.log(standaloneTechnical || templateRoots ? '目录生成与审核完成' : '目录生成与审核完成，当前无模板填写目录');
        if (leafWarning) await context.log(leafWarning);
        return;
      }

      // 子目录生成、叶子调整之后（与桌面版 continueTask 的最后一段相同）。
      const latestLeafAnswer =
        stage === LEAF_ADJUSTMENT_STAGE && current.leafSince !== null
          ? await findLatestConsumedAgentAnswer(db, tenant, context.jobId, current.leafSince, { excludeOptionLabels: TERMINATION_OPTION_LABELS })
          : null;
      let leafWarning = current.leafWarning;
      const accept = latestLeafAnswer?.selected_option === LEAF_ADJUSTMENT_ACCEPT_OPTION;
      const toReview = targetLeafCount === null || actualLeafCount === targetLeafCount || accept;
      if (toReview && targetLeafCount !== null && actualLeafCount !== targetLeafCount) {
        leafWarning = `AI 生成小节目标为 ${targetLeafCount}，用户已接受当前 ${actualLeafCount} 个。`;
      }
      const next: DirectoryFlow = {
        stage: toReview ? OUTLINE_REVIEW_STAGE : LEAF_ADJUSTMENT_STAGE,
        stageIndex: current.stageIndex + 1,
        prompted: false,
        knownIds: nextIds,
        actualLeafCount,
        leafWarning,
        leafSince: current.leafSince,
        scoring: nextScoring,
      };
      const outlineText = JSON.stringify(finalOutline, null, 2);
      await writeOutlineFile(context, run, outlineText);
      // 与桌面版相同：叶子调整与目录审查一并放入同步后的评分规划。
      if (nextScoring) await writePlan(run, nextScoring);
      if (toReview) {
        const reviewContext = JSON.stringify(buildOutlineReviewContext({ outline: finalOutline, targetLeafCount, scoreDirectoryPlan: nextScoring?.plan ?? null }), null, 2);
        // 审查材料登记为受保护文件；outline-review.json 预置为空（与桌面版 prepare_output_files 相同），交给 Agent 写入。
        await run.baseline.write(run.sandbox, OUTLINE_REVIEW_CONTEXT_GROUP, [{ path: OUTLINE_REVIEW_CONTEXT_FILE, data: Buffer.from(reviewContext, 'utf8') }], {
          replace: true,
          signal: context.signal,
        });
        await prepareOutputs(run, [OUTLINE_REVIEW_FILE]);
        await publish('子目录生成完成，正在准备最终审核', 88);
        pendingPrompt = reviewPrompt(next, outlineText, reviewContext);
        await run.checkpoint(taskState(next), 88);
      } else {
        await publish('AI 生成小节数量存在差异，等待用户决定', 75);
        // 第一次叶子调整：记下起点，之后提出的问题才是叶子调整中的。
        next.leafSince ??= await agentQuestionClock(db, tenant);
        await run.checkpoint(taskState(next), 75);
      }
      flow = next;
    }
  });
}

export function createTechnicalPlanJobs(options: TechnicalPlanJobOptions = {}): JobTypeDefinition<any>[] {
  return [
    createSectionExtractionJob(options),
    createAnalysisJob(options),
    createGlobalFactsJob(),
    createGlobalFactsAdjustmentJob(),
    createOutlineGenerationJob(),
    createOutlineAdjustmentJob(),
    createContentGenerationJob(),
  ];
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
  const types: readonly string[] = [
    BID_SECTION_EXTRACTION_JOB_TYPE,
    BID_ANALYSIS_JOB_TYPE,
    GLOBAL_FACTS_JOB_TYPE,
    GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE,
    OUTLINE_GENERATION_JOB_TYPE,
    OUTLINE_ADJUSTMENT_JOB_TYPE,
    CONTENT_GENERATION_JOB_TYPE,
  ];
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

/**
 * 开始生成全局事实（取代桌面版 tasks.startGlobalFactsGeneration，8.7c1）：全局事实的写法与引用的知识库文档取已保存的生成配置
 * （PATCH .../generation-config）。入 agent 队列，另受每组织 Agent 任务并发与每日时长的限制（8.3d）。没有招标文件或未解析完成、
 * 没有目录、原方案未解析完成时 409（文案与桌面版相同）；已有进行中的技术方案任务时 409 JOB_LOCKED。
 */
export async function startGlobalFactsGeneration(jobs: JobServiceDependencies, context: TenantContext, projectId: string): Promise<JobRecord> {
  const problem = globalFactsProblem(await loadTechnicalPlan(jobs.db, context, projectId));
  if (problem) throw conflict(problem);
  return enqueueJob(jobs, context, { type: GLOBAL_FACTS_JOB_TYPE, projectId, lockKey: technicalPlanLockKey(projectId), params: {} });
}

/**
 * 开始 AI 调整全局事实（取代桌面版 tasks.startGlobalFactsAdjustment，8.7c2）：调整要求去掉首尾空白后不能为空、至多 2000 字（400）；
 * 没有全局事实、全局事实生成的会话不能续用时 409（文案与桌面版相同）；已有进行中的技术方案任务时 409 JOB_LOCKED。入 agent 队列。
 */
export async function startGlobalFactsAdjustment(jobs: JobServiceDependencies, context: TenantContext, projectId: string, input: { requirement: string }): Promise<JobRecord> {
  const requirement = requestedRequirement(input.requirement, GLOBAL_FACTS_ADJUSTMENT_REQUIREMENT_MAX);
  const state = await loadTechnicalPlan(jobs.db, context, projectId);
  if (!state.globalFacts.length) throw conflict(GLOBAL_FACTS_REQUIRED);
  if (!state.globalFactsAdjustable) throw conflict(GLOBAL_FACTS_SESSION_MISSING);
  return enqueueJob(jobs, context, { type: GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE, projectId, lockKey: technicalPlanLockKey(projectId), params: { requirement } });
}

/**
 * 开始 AI 调整目录（取代桌面版 tasks.startOutlineAdjustment，8.7d）：调整要求去掉首尾空白后不能为空、至多 2000 字（400）；没有目录、
 * 目录生成的会话不能续用时 409（文案与桌面版相同；目录生成随 8.7e，在此之前一律不能续用）；已有进行中的技术方案任务时 409 JOB_LOCKED。
 * 入 agent 队列。
 */
export async function startOutlineAdjustment(jobs: JobServiceDependencies, context: TenantContext, projectId: string, input: { requirement: string }): Promise<JobRecord> {
  const requirement = requestedRequirement(input.requirement, OUTLINE_ADJUSTMENT_REQUIREMENT_MAX);
  const state = await loadTechnicalPlan(jobs.db, context, projectId);
  if (!state.outlineData?.outline.length) throw conflict(OUTLINE_REQUIRED);
  if (!state.outlineAdjustable) throw conflict(OUTLINE_SESSION_MISSING);
  return enqueueJob(jobs, context, { type: OUTLINE_ADJUSTMENT_JOB_TYPE, projectId, lockKey: technicalPlanLockKey(projectId), params: { requirement } });
}

/**
 * 开始生成目录（取代桌面版 tasks.startOutlineGeneration，8.7e1）：目录的组织方式、扩展方式、字数控制与引用的知识库文档取已保存的生成配置
 * （PATCH .../generation-config）；noTechnicalScoreMode 为用户对“无技术评分项模式”的确认（技术评分项缺失时必须为 true，否则 409）。
 * 技术评分要求未解析成功、原方案未解析完成时 409（文案与桌面版相同）；已有进行中的技术方案任务（含等待确认一级目录的目录生成）时
 * 409 JOB_LOCKED。入 agent 队列。
 */
export async function startOutlineGeneration(
  jobs: JobServiceDependencies,
  context: TenantContext,
  projectId: string,
  input: { noTechnicalScoreMode?: boolean },
): Promise<JobRecord> {
  const noTechnicalScoreMode = input.noTechnicalScoreMode === true;
  const problem = outlineGenerationProblem(await loadTechnicalPlan(jobs.db, context, projectId), noTechnicalScoreMode);
  if (problem) throw conflict(problem);
  return enqueueJob(jobs, context, { type: OUTLINE_GENERATION_JOB_TYPE, projectId, lockKey: technicalPlanLockKey(projectId), params: { noTechnicalScoreMode } });
}

export interface OutlineSelectionInput {
  /** 等待确认的目录生成任务（桌面版 taskId）。 */
  jobId: string;
  /** 使用的一级目录（至少一个）。 */
  selectedIds: unknown[];
  /** 对一级目录属性与内容处理模式的修改（桌面版确认对话框中的修改），可省略。 */
  changes?: OutlineSelectionChange[];
}

/**
 * 确认一级目录（取代桌面版 tasks.confirmOutlineSelection，8.7e1）：目录生成任务须正在等待确认（暂停为 waiting_for_selection），限任务
 * 发起人或组织 owner / admin（src/jobs/store.ts 的 confirmJobSelection）。选择与修改按任务 checkpoint 中待确认的一级目录校验
 * （applyOutlineSelection；标题、说明与 id 以服务端保存的为准），不合法时 400；之后任务回到 queued 并派发。不是本项目的目录生成任务 404。
 */
export async function confirmOutlineSelection(jobs: JobServiceDependencies, context: TenantContext, projectId: string, input: OutlineSelectionInput): Promise<JobRecord> {
  return confirmJobSelectionAndDispatch(jobs, context, input.jobId, {
    projectId,
    type: OUTLINE_GENERATION_JOB_TYPE,
    apply(checkpoint) {
      const task = isPlainRecord(checkpoint?.task) ? checkpoint.task : null;
      const { selection, confirmed } = readOutlineSelectionState(task);
      if (!checkpoint || !task || !selection || confirmed) throw new AppError(409, 'JOB_SELECTION_NOT_PENDING', '一级目录生成结果已变化，请重新打开后再选择');
      let result: { items: AcceptedOutlineItem[]; selectedIds: string[] };
      try {
        result = applyOutlineSelection(selection.items, input.selectedIds, input.changes ?? []);
      } catch (error) {
        if (error instanceof OutlineSelectionInputError) throw new AppError(400, 'TECHNICAL_PLAN_INVALID', error.message, { cause: error });
        throw error;
      }
      return { ...checkpoint, task: { ...task, confirmed: result } };
    },
  });
}

/**
 * 丢弃目录与全局事实的会话（工作区快照，8.7c2 / 8.7d；桌面版 deleteOutlineAgentTask 与 deleteGlobalFactsAgentTask，两者在同样的入口
 * 一起调用）：导入、移除招标文件，切换单 / 多标段，选择投标范围，目录被清空，清空技术方案时由接口调用，多标段识别开始与全部重新解析时
 * 由任务调用。store 为 null 时只标为已被替换、对象留给清理任务。被取消的任务在退出前仍可能保存检查点（写下新的快照），它的会话不会被
 * 续用（src/agent/continuation.ts 只采用已结束的任务）。
 */
export async function discardTechnicalPlanSessions(db: Kysely<Database>, context: TenantContext, store: ObjectStore | null, projectId: string): Promise<void> {
  // 桌面版 deleteOutlineAgentTask 同时删除正文的会话（8.10b1）。
  await discardAgentWorkspaceSnapshots(db, context, store, projectId, [OUTLINE_TASK_KIND, GLOBAL_FACTS_TASK_KIND, CONTENT_GENERATION_TASK_KIND]);
}

/**
 * 开始生成正文（取代桌面版 tasks.startContentGeneration 的全文生成，8.10b1）：表格需求、配图数量等取已保存的生成配置
 * （PATCH .../generation-config）；regenerate 为全文重新生成。前置条件不满足时 409（文案与桌面版相同，见 contentGenerationProblem）；
 * 已有进行中的技术方案任务（含暂停中的正文生成）时 409 JOB_LOCKED。入 agent 队列。单节重新生成随 8.11，失败后重试见
 * startContentGenerationRetry；
 * 暂停后的继续沿用任务的续跑（通用的 resumeJob）。
 */
export async function startContentGeneration(jobs: JobServiceDependencies, context: TenantContext, projectId: string, input: { regenerate?: boolean }): Promise<JobRecord> {
  const problem = contentGenerationProblem(await loadTechnicalPlan(jobs.db, context, projectId));
  if (problem) throw conflict(problem);
  return enqueueJob(jobs, context, {
    type: CONTENT_GENERATION_JOB_TYPE,
    projectId,
    lockKey: technicalPlanLockKey(projectId),
    params: { regenerate: input.regenerate === true },
  });
}

/**
 * 重试失败的正文生成（取代桌面版 tasks.startContentGeneration({ retryFailedSections: true })，8.10b2）：新任务接着最近一次失败的正文
 * 生成任务的会话，按失败时的阶段续接（见 contentGenerationJob.ts）。前置条件同开始；没有可以重试的任务（最近一次不是失败、会话不能
 * 续用、编排已保存、输入已变化，见 contentGenerationRetrySourceIn）时 409 TECHNICAL_PLAN_CONTENT_RETRY_UNAVAILABLE；已有进行中的技术方案
 * 任务时 409 JOB_LOCKED。
 */
export async function startContentGenerationRetry(jobs: JobServiceDependencies, context: TenantContext, projectId: string): Promise<JobRecord> {
  const problem = contentGenerationProblem(await loadTechnicalPlan(jobs.db, context, projectId));
  if (problem) throw conflict(problem);
  const source = await contentGenerationRetrySource(jobs.db, context, projectId);
  if (!source) throw conflict({ code: CONTENT_RETRY_UNAVAILABLE_CODE, message: CONTENT_RETRY_UNAVAILABLE_MESSAGE });
  return enqueueJob(jobs, context, {
    type: CONTENT_GENERATION_JOB_TYPE,
    projectId,
    lockKey: technicalPlanLockKey(projectId),
    params: { regenerate: source.regenerate, retryOf: source.jobId },
  });
}
