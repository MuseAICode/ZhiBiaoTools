// 可研报告的任务（取代桌面版 taskService.cjs 的 feasibility-* 任务与 feasibilityReportTasks.cjs、feasibilityOutlineTask.cjs 的
// run* 函数），会调用模型（入队检查最低启动余额）。各类任务互斥（lock_key 为 project:{projectId}:feasibility-report，与桌面版
// feasibility-report 组的 group-exclusive 相同；8.7b 的目录调整沿用）：
// - 资料分析、关键参数、正文生成、自然化审校（路线图第 6 步 6.12）：ai 队列；
// - 目录生成（第 8 步 8.7a）：agent 队列，在 agent 沙箱中由 Agent 读工作区材料写出 outline.json（见 createOutlineJob）。
//
// - 输入在任务开始时从数据库读取，不取自任务参数：资料分析读合并的资料正文（资料须全部解析成功，没有资料时只按项目参数分析）；
//   关键参数读目录与引用的知识库条目；正文生成读目录、关键参数与引用的知识库条目。模型取组织设置中选择的平台模型；
// - 写入一律经 Store 函数，并带上开始时的输入签名（inputSignature）：任务开始后保存了项目信息、资料分析、目录、关键参数，导入、
//   移除了资料或资料重新解析，写入在同一事务中被拒绝（结果已失效，不覆盖新的状态）；这些保存与清空时接口另外取消进行中的任务
//   （与桌面版相同）；
// - 可续跑：worker 崩溃、关闭或暂停后从头重新执行，已完成的调用按步骤键取回已保存的结果，不再调用服务商、不再扣费（6.4a）。
//   正文生成与审校按 checkpoint 继续：已写入正文的章节不再生成，已审校的章节不再审校；正在审校的一章记下审校前正文的哈希，
//   续跑时正文已变化即视为已写入（审校的请求含正文，重新审校会是另一次调用）；
// - 失败时写给用户看的原因：JobError 的文案，其他错误交给执行者写日志（任务记为 JOB_FAILED）；
// - 任务日志只写阶段和章节序号，不写资料正文、章节标题和模型输出。
import { createHash } from 'node:crypto';
import { DEFAULT_CONTEXT_LENGTH_LIMIT, splitTextByContextLimit } from '../ai/textSplit.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { createJobChat, resolveJobModel, type JobChat } from '../jobs/chat.ts';
import { abortableDelay, isJobStop } from '../jobs/control.ts';
import { AGENT_TASK_LIMITS } from '../agent/budget.ts';
import type { AgentPromptTool } from '../agent/entry.ts';
import { withAgentRun } from '../agent/execution.ts';
import { JobError, JobInterruptedError, type JobContext, type JobTypeDefinition } from '../jobs/definitions.ts';
import { cancelJob, enqueueJob, type JobServiceDependencies } from '../jobs/service.ts';
import { listJobs, type JobRecord } from '../jobs/store.ts';
import {
  analysisToMarkdown,
  buildAnalysisMergeMessages,
  buildAnalysisSegmentMessages,
  buildContentPrefixMessages,
  buildLeafContentMessages,
  buildLeafReviewMessages,
  buildParametersMessages,
  buildReviewPrefixMessages,
  collectLeaves,
  contentProgress,
  hasContent,
  perLeafWords,
  protectFacts,
  selectKnowledgeContents,
  stripMarkdownFence,
  type KnowledgeContent,
  type Leaf,
  type LightweightKnowledgeItem,
  type PromptState,
} from './prompts.ts';
import {
  buildFeasibilityOutlineAgentInput,
  countOutlineNodes,
  FEASIBILITY_OUTLINE_JSON_SCHEMA,
  FEASIBILITY_OUTLINE_OUTPUT_FILE,
  FeasibilityOutlineResultError,
  finalizeFeasibilityOutline,
} from './outlineAgent.ts';
import {
  clearChapterContents,
  FEASIBILITY_ANALYSIS_JOB_TYPE,
  FEASIBILITY_CONTENT_JOB_TYPE,
  FEASIBILITY_HUMAN_WRITING_JOB_TYPE,
  FEASIBILITY_JOB_TYPES,
  FEASIBILITY_OUTLINE_JOB_TYPE,
  FEASIBILITY_OUTLINE_NODES_MAX,
  FEASIBILITY_PARAMETERS_JOB_TYPE,
  feasibilityReportLockKey,
  inputSignature,
  loadFeasibilityReport,
  readCombinedSourceMarkdown,
  readReferenceKnowledgeItems,
  saveAnalysisResult,
  saveChapterResult,
  saveKeyParametersResult,
  saveOutlineResult,
  type FeasibilityOutlineItem,
  type FeasibilityReportState,
  type ReferenceKnowledgeItem,
} from './store.ts';

export { FEASIBILITY_ANALYSIS_JOB_TYPE, FEASIBILITY_CONTENT_JOB_TYPE, FEASIBILITY_HUMAN_WRITING_JOB_TYPE, FEASIBILITY_OUTLINE_JOB_TYPE, FEASIBILITY_PARAMETERS_JOB_TYPE };

/** 预热请求结束后稍候再发后续请求（与桌面版 PREFIX_WARMUP_SETTLE_MS 相同）。 */
const PREFIX_WARMUP_SETTLE_MS = 1500;

const INPUT_CHANGED_MESSAGE = '可研报告的资料、项目信息或已有结果已变化，本次结果已丢弃，请重新开始';

// ---- 输入检查（入队前与执行时相同；文案与桌面版相同） ----

interface Problem {
  code: string;
  message: string;
}

function analysisProblem(state: FeasibilityReportState): Problem | null {
  if (!state.projectInfo.projectName) return { code: 'FEASIBILITY_REPORT_PROJECT_INFO_REQUIRED', message: '请先填写项目名称' };
  if (state.sourceFiles.some((source) => source.status === 'error')) {
    return { code: 'FEASIBILITY_REPORT_SOURCE_FAILED', message: '有资料文件解析失败，请移除后重新导入' };
  }
  if (state.sourceFiles.some((source) => source.status !== 'success' || !source.markdownArtifactId)) {
    return { code: 'FEASIBILITY_REPORT_SOURCE_NOT_READY', message: '资料文件尚未全部解析完成，请稍后再试' };
  }
  return null;
}

function outlineProblem(state: FeasibilityReportState): Problem | null {
  return state.analysisMarkdown.trim() ? null : { code: 'FEASIBILITY_REPORT_ANALYSIS_REQUIRED', message: '请先完成资料分析' };
}

const OUTLINE_REQUIRED: Problem = { code: 'FEASIBILITY_REPORT_OUTLINE_REQUIRED', message: '请先生成报告目录' };

function parametersProblem(state: FeasibilityReportState): Problem | null {
  return state.outlineData?.outline.length ? null : OUTLINE_REQUIRED;
}

function contentProblem(state: FeasibilityReportState): Problem | null {
  if (!state.outlineData?.outline.length) return OUTLINE_REQUIRED;
  if (!state.keyParametersMarkdown.trim()) return { code: 'FEASIBILITY_REPORT_KEY_PARAMETERS_REQUIRED', message: '请先生成关键参数' };
  return null;
}

function humanWritingProblem(state: FeasibilityReportState): Problem | null {
  return collectLeaves(state.outlineData?.outline ?? []).some(hasContent)
    ? null
    : { code: 'FEASIBILITY_REPORT_CONTENT_REQUIRED', message: '请先生成正文，再进行自然化审校' };
}

// ---- 参数 ----

export interface ContentParams {
  /** 只补充生成还没有正文的章节（桌面版 onlyMissing），不清空已有正文。 */
  onlyMissing: boolean;
}

function noParams(what: string) {
  return (raw: unknown): Record<string, never> => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0) throw new TypeError(`${what}任务参数不合法`);
    return {};
  };
}

function parseContentParams(raw: unknown): ContentParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('正文生成任务参数不合法');
  const { onlyMissing, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof onlyMissing !== 'boolean') throw new TypeError('正文生成任务参数不合法');
  return { onlyMissing };
}

// ---- 公共 ----

export interface FeasibilityJobOptions {
  /** 上下文长度（字符），默认 DEFAULT_CONTEXT_LENGTH_LIMIT；测试中用很小的值触发分段。 */
  contextLengthLimit?: number;
  /** 预热后等待的毫秒数，默认 1500。 */
  warmupSettleMs?: number;
}

async function startState(context: JobContext<unknown>, check: (state: FeasibilityReportState) => Problem | null): Promise<{ projectId: string; state: FeasibilityReportState; signature: string }> {
  const projectId = context.projectId;
  if (!projectId) throw new JobError('FEASIBILITY_REPORT_FAILED', '可研报告任务缺少项目');
  // 先取签名再读状态：读取期间输入变化时签名已过期，写入被拒绝。
  const signature = await inputSignature(context.db, context.tenant, projectId);
  const state = await loadFeasibilityReport(context.db, context.tenant, projectId);
  const problem = check(state);
  if (problem) throw new JobError(problem.code, problem.message);
  return { projectId, state, signature };
}

function promptState(state: FeasibilityReportState): PromptState {
  return { projectInfo: state.projectInfo, analysisMarkdown: state.analysisMarkdown, keyParametersMarkdown: state.keyParametersMarkdown };
}

function inputChanged(): JobError {
  return new JobError('FEASIBILITY_REPORT_INPUT_CHANGED', INPUT_CHANGED_MESSAGE);
}

/** 关键参数用的知识库轻量条目（与桌面版 getOutlineReferences 相同：标题、简介都不为空，按“文档::条目”去重）。 */
export function lightweightKnowledgeItems(items: readonly ReferenceKnowledgeItem[]): LightweightKnowledgeItem[] {
  const seen = new Set<string>();
  const result: LightweightKnowledgeItem[] = [];
  for (const item of items) {
    const itemId = item.itemId.trim();
    const title = item.title.trim();
    const resume = item.resume.trim();
    if (!itemId || !title || !resume) continue;
    const id = `${item.documentId}::${itemId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ id, title, resume });
  }
  return result;
}

/** 正文生成可吸收的知识库条目（与桌面版 loadKnowledgeContentMap 相同：正文不为空，键为“文档::条目”，后出现的覆盖先出现的）。 */
export function knowledgeContentMap(items: readonly ReferenceKnowledgeItem[]): Map<string, KnowledgeContent> {
  const map = new Map<string, KnowledgeContent>();
  for (const item of items) {
    const itemId = item.itemId.trim();
    const content = item.content.trim();
    if (!itemId || !content) continue;
    map.set(`${item.documentId}::${itemId}`, { title: item.title, resume: item.resume, content });
  }
  return map;
}

/** 读取正文时的接口错误（过大、存储不可用）转成给用户看的任务错误。 */
async function readForJob<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AppError) throw new JobError(error.code, error.message, { cause: error });
    throw error;
  }
}

/** 各节共用的前缀先用短请求写入缓存（与桌面版 warmPromptPrefix 相同），失败不影响后续。 */
async function warmUp(context: JobContext<unknown>, chat: JobChat, stepKey: string, messages: Parameters<JobChat['text']>[1], label: string, settleMs: number): Promise<void> {
  try {
    await chat.text(stepKey, messages, label, { maxOutputTokens: 1, allowEmpty: true });
    await abortableDelay(settleMs, context.signal);
  } catch (error) {
    if (isJobStop(context, error)) throw error;
    await context.log(`${label}缓存预热失败，直接继续`);
  }
}

// ---- 资料分析 ----

function createAnalysisJob(options: FeasibilityJobOptions): JobTypeDefinition<Record<string, never>> {
  const split = { contextLengthLimit: options.contextLengthLimit ?? DEFAULT_CONTEXT_LENGTH_LIMIT };
  return {
    type: FEASIBILITY_ANALYSIS_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams: noParams('资料分析'),
    async run(context) {
      const { db, tenant } = context;
      const { projectId, state, signature } = await startState(context, analysisProblem);
      const sources = (await readForJob(() => readCombinedSourceMarkdown(db, tenant, projectId, context.objectStore))).trim();
      const chat = createJobChat(context.ai, await resolveJobModel(db, tenant));
      await context.log(sources ? '开始分析项目资料。' : '未导入资料文件，仅根据项目参数分析。');
      await context.setProgress(8);
      const segments = splitTextByContextLimit(sources, split);
      // JSON 修复与重试的说明按顺序写入任务日志，不等待（与桌面版的 updateTask 相同）；写入失败（租约丢失）由后续的检查点处理。
      let logChain = Promise.resolve();
      const onProgress = (message: string) => {
        logChain = logChain.then(
          () => context.log(message),
          () => {},
        );
      };

      const analyzeSegment = async (content: string, index: number, total: number) => {
        await context.log(total > 1 ? `正在分析第 ${index}/${total} 段资料。` : '正在提取资料事实。');
        await context.setProgress(12 + Math.round(((index - 1) / total) * 50));
        return chat.json(total > 1 ? `analysis:segment:${index}` : 'analysis', buildAnalysisSegmentMessages(state.projectInfo, content, index, total), {
          progressLabel: '可研资料分析',
          failureMessage: '资料分析结果不是有效 JSON',
          onProgress,
        });
      };

      let payload: unknown;
      if (segments.length <= 1) {
        payload = await analyzeSegment(segments[0] || sources, 1, 1);
      } else {
        const parts: unknown[] = [];
        for (let index = 0; index < segments.length; index += 1) parts.push(await analyzeSegment(segments[index]!, index + 1, segments.length));
        await context.log('正在合并分段分析结果。');
        await context.setProgress(72);
        payload = await chat.json('analysis:merge', buildAnalysisMergeMessages(state.projectInfo, parts), {
          progressLabel: '可研资料分析合并',
          failureMessage: '合并分析结果不是有效 JSON',
          onProgress,
        });
      }
      await logChain.catch(() => {});
      if (context.signal.aborted) throw new JobInterruptedError();
      if (!(await saveAnalysisResult(db, tenant, projectId, analysisToMarkdown(payload), signature))) throw inputChanged();
      await context.log('资料分析完成。');
    },
  };
}

// ---- 目录生成（8.7a） ----

/** 目录生成的阶段（与桌面版 initial_stage 相同）。 */
export const FEASIBILITY_OUTLINE_STAGE = 'feasibility-outline';
/** 工作区快照的任务类别（迁移 0040 的 task_kind；8.7b 的目录调整共用）。 */
export const FEASIBILITY_OUTLINE_TASK_KIND = 'feasibility-outline';
/** 工作区材料的受保护文件分组。 */
const OUTLINE_INPUT_GROUP = 'input';
/** 续跑时该阶段的要求已在会话中发出：只请 Agent 继续（与桌面版 CONTINUE_PROMPT 相同）。 */
const CONTINUE_PROMPT = '继续之前的任务';
/** 与桌面版相同：原生工具、json-validation、ask-user 与需用户确认的失败报告（顶层任务的 report-failure 即 request-termination）。 */
const OUTLINE_TOOLS: readonly AgentPromptTool[] = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'json-validation', 'ask-user', 'request-termination'];
const OUTLINE_BUSINESS_TOOLS = ['ask-user', 'request-termination'] as const;

/** checkpoint 中任务自己的状态：首次执行开始时的输入签名（续跑时核对，写入时传回）。 */
function outlineCheckpointSignature(raw: Record<string, unknown> | null): string | null {
  return raw && typeof raw.signature === 'string' && raw.signature !== '' ? raw.signature : null;
}

/**
 * 可研报告目录生成（取代桌面版 feasibilityOutlineTask.cjs 的 runFeasibilityOutlineTask）：
 * - 输入在任务开始时从数据库读取：资料分析（为空时不能开始）、项目参数、目录配置（大纲模板、目标字数）与引用的知识库条目
 *   （轻量条目：id、标题、简介）；目录配置由接口先保存（PUT .../outline-config），与桌面版开始时保存相同；
 * - 工作区材料（项目参数.md、资料分析.md、大纲模板.md、参考知识库.md、材料说明.md）登记为受保护文件，提示词、预置 Schema 与工具
 *   与桌面版相同（src/feasibilityReport/outlineAgent.ts）；桌面版没有提交校验（max_retries 0），结果在 Agent 结束后整理：不是合法
 *   JSON、没有可用目录时任务失败，说明为固定文字；
 * - 结果经 saveOutlineResult 整体替换目录并清空关键参数（桌面版在开始时清空，这里在写入时清空，与资料分析任务相同），带上首次执行
 *   开始时的输入签名：之后保存了项目信息、资料分析、目录、关键参数，导入、移除了资料，写入被拒绝；
 * - 可续跑：每条提示词之后保存检查点（工作区快照与 checkpoint，签名在其中），暂停（费用 / 轮数上限、余额不足、存储配额）或 worker
 *   失联后续接会话，只发“继续之前的任务”；续跑时输入已变化即失败（不按新的输入接着旧的会话）。成功后丢弃快照（目录调整接着生成的
 *   会话在 8.7b 设计）。
 */
function createOutlineJob(): JobTypeDefinition<Record<string, never>> {
  return {
    type: FEASIBILITY_OUTLINE_JOB_TYPE,
    queue: 'agent',
    resumable: true,
    billable: true,
    agentLimits: AGENT_TASK_LIMITS.outline,
    agentTools: OUTLINE_BUSINESS_TOOLS,
    agentWorkspace: { taskKind: FEASIBILITY_OUTLINE_TASK_KIND },
    parseParams: noParams('目录生成'),
    async run(context) {
      const { db, tenant } = context;
      const { projectId, state, signature: current } = await startState(context, outlineProblem);
      const knowledgeItems = lightweightKnowledgeItems(await readReferenceKnowledgeItems(db, tenant, projectId));
      const allowedKnowledgeIds = new Set(knowledgeItems.map((item) => item.id));
      const input = buildFeasibilityOutlineAgentInput(state, knowledgeItems);
      await withAgentRun(context.agent, async (run) => {
        const saved = outlineCheckpointSignature(run.taskCheckpoint);
        if (saved !== null && saved !== current) throw inputChanged();
        const signature = saved ?? current;
        if (!run.resumed) {
          await context.log('开始生成报告目录。');
          await context.setProgress(8);
          await context.log(knowledgeItems.length ? `已读取 ${knowledgeItems.length} 条知识库轻量条目。` : '本次未使用知识库条目。');
          await context.setProgress(12);
          await context.log('正在准备目录生成工作区材料。');
          await context.setProgress(16);
        }
        // 续跑时材料在快照中；原件不可用（快照中的副本被改动）时按同一输入重新放入。
        if (!run.resumed || run.unavailableProtectedFiles.length > 0) {
          await run.baseline.write(run.sandbox, OUTLINE_INPUT_GROUP, input.files.map((file) => ({ path: file.path, data: Buffer.from(file.content, 'utf8') })), {
            replace: true,
            signal: context.signal,
          });
        }
        await context.log(run.resumed ? 'Agent 继续生成报告目录。' : 'Agent 正在生成报告目录。');
        await context.setProgress(22);
        const stage = await run.runStage<FeasibilityOutlineItem[]>({
          stage: FEASIBILITY_OUTLINE_STAGE,
          stageIndex: 0,
          prompt: run.wasPrompted(FEASIBILITY_OUTLINE_STAGE) ? CONTINUE_PROMPT : input.prompt,
          tools: OUTLINE_TOOLS,
          jsonSchemas: { [FEASIBILITY_OUTLINE_OUTPUT_FILE]: FEASIBILITY_OUTLINE_JSON_SCHEMA },
          outputFile: FEASIBILITY_OUTLINE_OUTPUT_FILE,
          maxExecutionRetries: 0,
          checkpointAfterPrompt: () => ({ signature }),
          async validate() {
            // 与桌面版相同：不做提交修复，结果不可用时任务失败。
            const file = (await run.readFiles([FEASIBILITY_OUTLINE_OUTPUT_FILE])).get(FEASIBILITY_OUTLINE_OUTPUT_FILE);
            if (file && file.data === null) throw new JobError('FEASIBILITY_REPORT_OUTLINE_INVALID', `${FEASIBILITY_OUTLINE_OUTPUT_FILE}过大，无法读取`);
            try {
              return { value: finalizeFeasibilityOutline(file?.data?.toString('utf8') ?? '', allowedKnowledgeIds), issues: [] };
            } catch (error) {
              if (error instanceof FeasibilityOutlineResultError) throw new JobError('FEASIBILITY_REPORT_OUTLINE_INVALID', error.message, { cause: error });
              throw error;
            }
          },
        });
        if (stage.value === null) throw new JobError('FEASIBILITY_REPORT_OUTLINE_INVALID', '模型未返回可用目录');
        if (context.signal.aborted) throw new JobInterruptedError();
        if (countOutlineNodes(stage.value) > FEASIBILITY_OUTLINE_NODES_MAX) {
          throw new JobError('FEASIBILITY_REPORT_OUTLINE_TOO_LARGE', `生成的目录超过 ${FEASIBILITY_OUTLINE_NODES_MAX} 项，请重新生成`);
        }
        await context.log(`已生成 ${stage.value.length} 个一级目录。`);
        await context.setProgress(95);
        const written = await saveOutlineResult(
          db,
          tenant,
          projectId,
          // 与桌面版相同：目录的项目名称取项目参数，概述取资料分析的前 400 个字符。
          { outline: stage.value, projectName: state.projectInfo.projectName, projectOverview: String(state.analysisMarkdown || '').slice(0, 400) },
          signature,
        );
        if (!written) throw inputChanged();
      });
      await context.log('报告目录生成完成。');
    },
  };
}

// ---- 关键参数 ----

function createParametersJob(): JobTypeDefinition<Record<string, never>> {
  return {
    type: FEASIBILITY_PARAMETERS_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams: noParams('关键参数'),
    async run(context) {
      const { db, tenant } = context;
      const { projectId, state, signature } = await startState(context, parametersProblem);
      const chat = createJobChat(context.ai, await resolveJobModel(db, tenant));
      await context.log('正在提取可研报告关键参数与统一口径。');
      await context.setProgress(12);
      const knowledgeItems = lightweightKnowledgeItems(await readReferenceKnowledgeItems(db, tenant, projectId));
      const markdown = await chat.text('parameters', buildParametersMessages(promptState(state), state.outlineData!.outline, knowledgeItems), '可研关键参数');
      if (context.signal.aborted) throw new JobInterruptedError();
      if (!(await saveKeyParametersResult(db, tenant, projectId, markdown, signature))) throw inputChanged();
      await context.log('关键参数与编制口径生成完成，请人工核对待补充项。已清空旧正文。');
    },
  };
}

// ---- 正文生成与自然化审校 ----

interface ReviewCheckpoint {
  phase: 'generating' | 'human-writing';
  reviewedNodeIds: string[];
  /** 正在审校的一章与审校前正文的哈希（续跑时正文已变化即视为已写入）。 */
  reviewing: { nodeId: string; contentHash: string } | null;
}

const contentHashOf = (content: string | undefined) => createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');

function parseCheckpoint(raw: Record<string, unknown> | null): ReviewCheckpoint | null {
  if (!raw) return null;
  const phase = raw.phase === 'human-writing' ? 'human-writing' : 'generating';
  const reviewedNodeIds = Array.isArray(raw.reviewedNodeIds) ? raw.reviewedNodeIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  const reviewing = raw.reviewing as { nodeId?: unknown; contentHash?: unknown } | null | undefined;
  return {
    phase,
    reviewedNodeIds,
    reviewing: reviewing && typeof reviewing.nodeId === 'string' && typeof reviewing.contentHash === 'string' ? { nodeId: reviewing.nodeId, contentHash: reviewing.contentHash } : null,
  };
}

interface ReviewRun {
  context: JobContext<unknown>;
  chat: JobChat;
  projectId: string;
  signature: string;
  prompt: PromptState;
  checkpoint: ReviewCheckpoint;
  /** 当前的各叶子章节（写入后同步更新）。 */
  leaves: Map<string, Leaf>;
  progress: (reviewed: number, total: number) => number;
  /** 多于一章时先预热公共前缀（正文任务预热，单独的审校任务与桌面版相同不预热）。 */
  warmup: { stepKey: string; settleMs: number } | null;
}

async function saveReviewCheckpoint(run: ReviewRun, progress: number): Promise<void> {
  await run.context.saveCheckpoint({ ...run.checkpoint, reviewedNodeIds: [...run.checkpoint.reviewedNodeIds] }, progress);
}

/** 依次审校有正文、还没有审校的章节（与桌面版 rewriteLeafContent 相同，结果经 protectFacts 保护事实）。 */
async function reviewLeaves(run: ReviewRun, order: readonly string[]): Promise<number> {
  const { context, chat, checkpoint } = run;
  // 续跑：上次写入了审校结果、还没记下 checkpoint 时，正文已不是审校前的正文。
  if (checkpoint.reviewing) {
    const leaf = run.leaves.get(checkpoint.reviewing.nodeId);
    if (leaf && contentHashOf(leaf.content) !== checkpoint.reviewing.contentHash && !checkpoint.reviewedNodeIds.includes(leaf.id)) {
      checkpoint.reviewedNodeIds.push(leaf.id);
    }
    checkpoint.reviewing = null;
  }
  const targets = order.filter((id) => hasContent(run.leaves.get(id)) && !checkpoint.reviewedNodeIds.includes(id));
  const total = targets.length + checkpoint.reviewedNodeIds.length;
  await context.setProgress(run.progress(checkpoint.reviewedNodeIds.length, total));
  if (run.warmup && targets.length > 1) {
    await warmUp(context, chat, run.warmup.stepKey, buildReviewPrefixMessages(run.prompt), '可研审校公共材料', run.warmup.settleMs);
  }
  for (const [index, nodeId] of targets.entries()) {
    if (context.signal.aborted) throw new JobInterruptedError();
    const leaf = run.leaves.get(nodeId)!;
    await context.log(`正在审校第 ${index + 1}/${targets.length} 章。`, { nodeId });
    checkpoint.reviewing = { nodeId, contentHash: contentHashOf(leaf.content) };
    await saveReviewCheckpoint(run, run.progress(checkpoint.reviewedNodeIds.length, total));
    const rewritten = await chat.text(`review:${nodeId}`, buildLeafReviewMessages(run.prompt, leaf), '可研审校', { allowEmpty: true });
    const content = protectFacts(leaf.content ?? '', stripMarkdownFence(rewritten));
    if (context.signal.aborted) throw new JobInterruptedError();
    if (!(await saveChapterResult(context.db, context.tenant, run.projectId, nodeId, content, run.signature))) throw inputChanged();
    run.leaves.set(nodeId, { ...leaf, content });
    checkpoint.reviewedNodeIds.push(nodeId);
    checkpoint.reviewing = null;
    await saveReviewCheckpoint(run, run.progress(checkpoint.reviewedNodeIds.length, total));
  }
  return targets.length;
}

function createContentJob(options: FeasibilityJobOptions): JobTypeDefinition<ContentParams> {
  const settleMs = options.warmupSettleMs ?? PREFIX_WARMUP_SETTLE_MS;
  return {
    type: FEASIBILITY_CONTENT_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams: parseContentParams,
    async run(context) {
      const { db, tenant, params } = context;
      const { projectId, state, signature } = await startState(context, contentProblem);
      const chat = createJobChat(context.ai, await resolveJobModel(db, tenant));
      const prompt = promptState(state);
      let checkpoint = parseCheckpoint(context.checkpoint);
      const resumed = checkpoint !== null;
      if (!checkpoint) {
        // 首次执行：全部重新生成时先清空全部正文（与桌面版 startFeasibilityContent 相同），之后的续跑都从 checkpoint 继续。
        if (!params.onlyMissing && !(await clearChapterContents(db, tenant, projectId, signature))) throw inputChanged();
        checkpoint = { phase: 'generating', reviewedNodeIds: [], reviewing: null };
        await context.saveCheckpoint({ ...checkpoint }, contentProgress('generating', 0, 1));
      }
      // 刚清空了全部正文时，开始时读出的正文已失效。
      const cleared = !params.onlyMissing && !resumed;
      const leaves = new Map<string, Leaf>();
      const order: string[] = [];
      for (const leaf of collectLeaves(state.outlineData!.outline)) {
        leaves.set(leaf.id, cleared ? { ...leaf, content: '' } : leaf);
        order.push(leaf.id);
      }

      if (checkpoint.phase === 'generating') {
        const targets = order.filter((id) => !hasContent(leaves.get(id)));
        if (targets.length === 0) await context.log('没有需要生成的章节，进入自然化审校。');
        else await context.log(cleared ? `开始生成 ${targets.length} 个章节正文。` : `补充生成 ${targets.length} 个未完成章节。`);
        await context.setProgress(contentProgress('generating', 0, targets.length || 1));
        if (targets.length > 1) await warmUp(context, chat, 'content:warmup', buildContentPrefixMessages(prompt), '可研正文公共材料', settleMs);
        const knowledgeMap = knowledgeContentMap(await readReferenceKnowledgeItems(db, tenant, projectId));
        const words = perLeafWords(state.targetWords, order.length);
        for (const [index, nodeId] of targets.entries()) {
          if (context.signal.aborted) throw new JobInterruptedError();
          const leaf = leaves.get(nodeId)!;
          await context.log(`正在撰写第 ${index + 1}/${targets.length} 章。`, { nodeId });
          await context.setProgress(contentProgress('generating', index, targets.length));
          const response = await chat.text(`content:${nodeId}`, buildLeafContentMessages(prompt, leaf, selectKnowledgeContents(leaf, knowledgeMap), words), '可研正文', {
            allowEmpty: true,
          });
          const content = stripMarkdownFence(response).trim();
          if (context.signal.aborted) throw new JobInterruptedError();
          if (!(await saveChapterResult(db, tenant, projectId, nodeId, content, signature))) throw inputChanged();
          leaves.set(nodeId, { ...leaf, content });
          await context.saveCheckpoint({ ...checkpoint }, contentProgress('generating', index + 1, targets.length));
        }
        await context.log(targets.length ? '正文生成完成，开始自然化审校。' : '开始自然化审校。');
        checkpoint.phase = 'human-writing';
        await context.saveCheckpoint({ ...checkpoint }, contentProgress('human-writing', 0, Math.max(order.filter((id) => hasContent(leaves.get(id))).length, 1)));
      } else {
        await context.log('继续自然化审校。');
      }

      const reviewed = await reviewLeaves(
        {
          context,
          chat,
          projectId,
          signature,
          prompt,
          checkpoint,
          leaves,
          progress: (done, total) => contentProgress('human-writing', done, Math.max(total, 1)),
          warmup: { stepKey: 'review:warmup', settleMs },
        },
        order,
      );
      await context.log(reviewed || checkpoint.reviewedNodeIds.length ? '自然化审校完成。' : '没有需要审校的章节。');
    },
  };
}

function createHumanWritingJob(): JobTypeDefinition<Record<string, never>> {
  return {
    type: FEASIBILITY_HUMAN_WRITING_JOB_TYPE,
    queue: 'ai',
    resumable: true,
    billable: true,
    parseParams: noParams('自然化审校'),
    async run(context) {
      const { db, tenant } = context;
      const { projectId, state, signature } = await startState(context, humanWritingProblem);
      const chat = createJobChat(context.ai, await resolveJobModel(db, tenant));
      const checkpoint = parseCheckpoint(context.checkpoint) ?? { phase: 'human-writing', reviewedNodeIds: [], reviewing: null };
      const leaves = new Map<string, Leaf>();
      const order: string[] = [];
      for (const leaf of collectLeaves(state.outlineData!.outline)) {
        leaves.set(leaf.id, leaf);
        order.push(leaf.id);
      }
      await context.log(`开始审校 ${order.filter((id) => hasContent(leaves.get(id)) && !checkpoint.reviewedNodeIds.includes(id)).length} 个已生成章节。`);
      // 与桌面版相同：审校进度到 90，完成时 100。
      await reviewLeaves(
        { context, chat, projectId, signature, prompt: promptState(state), checkpoint, leaves, progress: (done, total) => Math.round((done / Math.max(total, 1)) * 90), warmup: null },
        order,
      );
      await context.log('自然化审校完成。');
    },
  };
}

export function createFeasibilityReportJobs(options: FeasibilityJobOptions = {}): JobTypeDefinition<any>[] {
  return [createAnalysisJob(options), createOutlineJob(), createParametersJob(), createContentJob(options), createHumanWritingJob()];
}

export const feasibilityReportJobs = createFeasibilityReportJobs();

// ---- 接口用：入队与取消 ----

const CONTENT_PAUSED: Problem = {
  code: 'FEASIBILITY_REPORT_CONTENT_PAUSED',
  message: '可研正文生成已暂停，请先继续当前正文生成或重置可研后再启动新的任务。',
};

function conflict(problem: Problem): AppError {
  return new AppError(409, problem.code, problem.message);
}

async function enqueue(
  jobs: JobServiceDependencies,
  context: TenantContext,
  projectId: string,
  type: string,
  check: (state: FeasibilityReportState) => Problem | null,
  params: Record<string, unknown>,
): Promise<JobRecord> {
  const state = await loadFeasibilityReport(jobs.db, context, projectId);
  // 与桌面版 assertTaskCanStart 相同：正文生成暂停中不能启动其他可研任务（继续经 POST /api/jobs/:jobId/resume）。
  if (state.contentTask?.status === 'paused') throw conflict(CONTENT_PAUSED);
  const problem = check(state);
  if (problem) throw conflict(problem);
  return enqueueJob(jobs, context, { type, projectId, lockKey: feasibilityReportLockKey(projectId), params });
}

/** 开始资料分析（取代桌面版 tasks.startFeasibilityAnalysis）。已有未结束的可研任务时 409 JOB_LOCKED。 */
export function startFeasibilityAnalysis(jobs: JobServiceDependencies, context: TenantContext, projectId: string): Promise<JobRecord> {
  return enqueue(jobs, context, projectId, FEASIBILITY_ANALYSIS_JOB_TYPE, analysisProblem, {});
}

/**
 * 开始生成报告目录（取代桌面版 tasks.startFeasibilityOutline，8.7a）：目录配置（大纲模板、目标字数、引用的知识库文档）先经
 * PUT .../outline-config 保存。入 agent 队列，另受每组织 Agent 任务并发与每日时长的限制（8.3d）。
 */
export function startFeasibilityOutline(jobs: JobServiceDependencies, context: TenantContext, projectId: string): Promise<JobRecord> {
  return enqueue(jobs, context, projectId, FEASIBILITY_OUTLINE_JOB_TYPE, outlineProblem, {});
}

/** 开始生成关键参数（取代桌面版 tasks.startFeasibilityParameters）。 */
export function startFeasibilityParameters(jobs: JobServiceDependencies, context: TenantContext, projectId: string): Promise<JobRecord> {
  return enqueue(jobs, context, projectId, FEASIBILITY_PARAMETERS_JOB_TYPE, parametersProblem, {});
}

/**
 * 开始正文生成（取代桌面版 tasks.startFeasibilityContent）：生成后接着自然化审校。onlyMissing 只补充生成还没有正文的章节，
 * 否则开始执行时清空全部正文。暂停后继续经 POST /api/jobs/:jobId/resume（取代桌面版的 resume 参数）。
 */
export function startFeasibilityContent(jobs: JobServiceDependencies, context: TenantContext, projectId: string, input: { onlyMissing?: boolean }): Promise<JobRecord> {
  return enqueue(jobs, context, projectId, FEASIBILITY_CONTENT_JOB_TYPE, contentProblem, { onlyMissing: input.onlyMissing === true });
}

/** 开始自然化审校（取代桌面版 tasks.startFeasibilityHumanWriting）：审校全部有正文的章节。 */
export function startFeasibilityHumanWriting(jobs: JobServiceDependencies, context: TenantContext, projectId: string): Promise<JobRecord> {
  return enqueue(jobs, context, projectId, FEASIBILITY_HUMAN_WRITING_JOB_TYPE, humanWritingProblem, {});
}

/**
 * 取消本项目未结束的可研任务（与桌面版保存项目信息、资料分析、目录、关键参数，导入、移除资料和重置前的
 * cancelFeasibilityReportTasks 相同；暂停中的也取消，桌面版此时删除任务记录）。不等待执行者退出：其后续写入因签名不符被拒绝。
 */
export async function cancelFeasibilityReportJobs(jobs: JobServiceDependencies, context: TenantContext, projectId: string): Promise<void> {
  const types: readonly string[] = FEASIBILITY_JOB_TYPES;
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
