// 技术方案的任务（取代桌面版 taskService.cjs 的 bid-section-extraction / bid-analysis / global-facts-generation /
// global-facts-adjustment 与 bidSectionExtractionTask.cjs、bidAnalysisTask.cjs、globalFactsTaskV2.cjs、globalFactsAdjustmentTask.cjs 的
// run* 函数），会调用模型（入队检查最低启动余额）。各类任务互斥（lock_key 为 project:{projectId}:technical-plan，与桌面版 technical-plan
// 组的 group-exclusive 相同）：
// - 多标段识别、招标解析（路线图第 6 步 6.11）：ai 队列；
// - 全局事实生成（第 8 步 8.7c1）：agent 队列，在 agent 沙箱中由 Agent 读工作区材料写出 global-facts.json（见 createGlobalFactsJob）；
// - 全局事实调整（第 8 步 8.7c2）：agent 队列，接着全局事实生成（或上一次调整）的会话与工作区，按用户的要求改写 global-facts.json
//   （见 createGlobalFactsAdjustmentJob）。两者共用工作区快照类别 technical-plan-global-facts，成功后保留快照供下一次调整续用；
//   导入、移除招标文件，切换单 / 多标段，选择投标范围，多标段识别开始，全部重新解析，目录被清空与清空技术方案时丢弃
//   （discardGlobalFactsSession，桌面版 deleteGlobalFactsAgentTask）。
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
import { extractBidSections, SectionExtractionError } from './sectionExtraction.ts';
import {
  BID_ANALYSIS_JOB_TYPE,
  BID_SECTION_EXTRACTION_JOB_TYPE,
  GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE,
  GLOBAL_FACTS_ADJUSTMENT_REQUIREMENT_MAX,
  GLOBAL_FACTS_ADJUSTMENT_SUMMARY_MAX,
  GLOBAL_FACTS_JOB_TYPE,
  GLOBAL_FACTS_TASK_KIND,
  globalFactsInputSignature,
  globalFactsSessionTarget,
  inputSignatures,
  loadTechnicalPlan,
  prepareBidSectionExtraction,
  readGlobalFactsKnowledgeItems,
  readGlobalFactsSources,
  readOriginalTenderMarkdown,
  readTenderMarkdown,
  resetBidAnalysisForRerun,
  saveBidItems,
  saveBidSectionExtraction,
  saveGlobalFactsResult,
  technicalPlanLockKey,
  type TechnicalPlanState,
} from './store.ts';
import { BID_ANALYSIS_TASKS, bidItemLabel, isBidItemId } from './tender.ts';

export { BID_ANALYSIS_JOB_TYPE, BID_SECTION_EXTRACTION_JOB_TYPE, GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE, GLOBAL_FACTS_JOB_TYPE, GLOBAL_FACTS_TASK_KIND };

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

/** 调整要求的规范化（与可研目录调整相同）：去掉 NUL 与首尾空白；为空或过长时返回 null。 */
function normalizeRequirement(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const requirement = raw.replace(/\0/g, '').trim();
  return requirement && [...requirement].length <= GLOBAL_FACTS_ADJUSTMENT_REQUIREMENT_MAX ? requirement : null;
}

function parseAdjustmentParams(raw: unknown): GlobalFactsAdjustmentParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('全局事实调整任务参数不合法');
  const { requirement, ...rest } = raw as Record<string, unknown>;
  const normalized = normalizeRequirement(requirement);
  if (Object.keys(rest).length > 0 || normalized === null || normalized !== requirement) throw new TypeError('全局事实调整任务参数不合法');
  return { requirement: normalized };
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
      // 目录与全局事实已清空：全局事实的会话不再续用（桌面版 clearDownstreamFromBidSectionChange）。丢弃失败的留给下一次生成替换。
      await discardGlobalFactsSession(db, tenant, context.objectStore, projectId).catch(() => {});
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
        // 目录与全局事实已清空：全局事实的会话不再续用（桌面版目录被清空时删除持久任务）。丢弃失败的留给下一次生成替换。
        await discardGlobalFactsSession(db, tenant, context.objectStore, projectId).catch(() => {});
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
    parseParams: parseAdjustmentParams,
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

export function createTechnicalPlanJobs(options: TechnicalPlanJobOptions = {}): JobTypeDefinition<any>[] {
  return [createSectionExtractionJob(options), createAnalysisJob(options), createGlobalFactsJob(), createGlobalFactsAdjustmentJob()];
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
  const types: readonly string[] = [BID_SECTION_EXTRACTION_JOB_TYPE, BID_ANALYSIS_JOB_TYPE, GLOBAL_FACTS_JOB_TYPE, GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE];
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
  const requirement = normalizeRequirement(input.requirement);
  if (requirement === null) {
    throw new AppError(400, 'TECHNICAL_PLAN_INVALID', String(input.requirement ?? '').trim() ? `调整要求超过 ${GLOBAL_FACTS_ADJUSTMENT_REQUIREMENT_MAX} 字` : '调整要求不能为空');
  }
  const state = await loadTechnicalPlan(jobs.db, context, projectId);
  if (!state.globalFacts.length) throw conflict(GLOBAL_FACTS_REQUIRED);
  if (!state.globalFactsAdjustable) throw conflict(GLOBAL_FACTS_SESSION_MISSING);
  return enqueueJob(jobs, context, { type: GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE, projectId, lockKey: technicalPlanLockKey(projectId), params: { requirement } });
}

/**
 * 丢弃全局事实生成与调整的会话（工作区快照，8.7c2；桌面版 deleteGlobalFactsAgentTask）：导入、移除招标文件，切换单 / 多标段，选择投标
 * 范围，目录被清空，清空技术方案时由接口调用，多标段识别开始与全部重新解析时由任务调用。store 为 null 时只标为已被替换、对象留给
 * 清理任务。被取消的任务在退出前仍可能保存检查点（写下新的快照），它的会话不会被续用（src/agent/continuation.ts 只采用已结束的任务）。
 */
export async function discardGlobalFactsSession(db: Kysely<Database>, context: TenantContext, store: ObjectStore | null, projectId: string): Promise<void> {
  await discardAgentWorkspaceSnapshots(db, context, store, projectId, [GLOBAL_FACTS_TASK_KIND]);
}
