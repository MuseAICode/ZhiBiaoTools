// 技术方案正文生成任务（路线图第 8 步 8.10b1 起；docs/SERVER_DESIGN.md 第 7.40 节），取代桌面版 taskService.cjs 的 content-generation 与
// contentGenerationTask.cjs 的 runContentGenerationTask。本步只有基础编排阶段（材料、提示词与校验见 contentPlanning.ts）：
// - 开始时的检查与桌面版相同（目录生效字数快照、目录、全局事实、AI 小节；原方案须已解析完成，与 8.7c1 相同）；
// - 本次目标：全文重新生成时全部 AI 小节，否则为没有成功生成或没有字数记录的小节（目录变更后有新增的待生成小节时只取它们）；
//   可复用的已保存编排（版本相同、表格需求相同）直接沿用，其余交给 Agent 在 agent 沙箱中编排；
// - 编排提交后，程序按桌面版的规则分配字数、选出表格与配图小节，带输入签名经 saveContentPlanningResult 整体写入编排与运行进度；
// - 后续阶段（原方案还原 8.11、正文写作 8.10c 等）接入之前，编排保存后以 TECHNICAL_PLAN_CONTENT_STAGE_UNAVAILABLE 失败（同 8.7e1）；
// - 会话：开始时运行进度显示正文阶段已开始（generation_started）、且上一次正文生成的会话可以续用时接着它（桌面版局部新增沿用原会话）；
//   全文重新生成时先丢弃正文的会话（桌面版 deletePersistentTask）。正文阶段被清空的各入口都把运行进度置空，相当于桌面版删除正文会话；
// - 可续跑：每条提示词之后保存检查点（工作区快照与 checkpoint：签名、本次编排目标），暂停或 worker 失联后续接会话，只发“继续之前的
//   任务”；续跑时输入已变化即失败。编排已保存后续跑不再打开沙箱；
// - 失败后重试（8.10b2，桌面版 retryFailedSections）：新任务接着失败任务的正文会话（retainStages：阶段与已发出的阶段保留），按失败时的
//   阶段续接。现在只有基础编排一种情形（与桌面版 continuingPlanning 相同）：沿用失败任务的编排目标，重新放入材料、保留
//   正文编排结果.json 的草稿，只发“继续之前的任务”；regenerate 沿用失败任务的，不再丢弃会话。能否重试见 store.ts 的
//   contentGenerationRetrySourceIn，执行时再核对一次；
// - 日志只写阶段与条数，不写编排内容（AI 生成的写作重点等）。
import type { AgentPromptTool } from '../agent/entry.ts';
import { AGENT_TASK_LIMITS } from '../agent/budget.ts';
import { findContinuableAgentSession } from '../agent/continuation.ts';
import { withAgentRun, type AgentRunState } from '../agent/execution.ts';
import { discardAgentWorkspaceSnapshots } from '../agent/workspaceJob.ts';
import { JobError, JobInterruptedError, type JobContext, type JobTypeDefinition } from '../jobs/definitions.ts';
import {
  collectAiLeaves,
  completeContentPlanning,
  contentKnowledgeItems,
  contentRuntimeAfterPlanning,
  CONTENT_PLANNING_JSON_SCHEMA,
  CONTENT_PLANNING_OUTPUT_FILE,
  CONTENT_PLANNING_STAGE,
  buildContentPlanningFiles,
  createContentPlanningPrompt,
  createContentPlanningRepairPrompt,
  formatBidAnalysisFactsForPrompt,
  formatGlobalFactsForPrompt,
  getContentWordTarget,
  isIncrementalPlanning,
  normalizeContentWordControl,
  normalizeTableRequirement,
  pruneContentGenerationPlans,
  reusableContentPlan,
  selectContentGenerationTargets,
  tablesForRun,
  TABLE_REQUIREMENT_LABELS,
  validateContentPlanningOutput,
  type ContentPlan,
  type LeafContext,
} from './contentPlanning.ts';
import { CONTENT_TEMPLATE_REQUIRED_CODE, CONTENT_TEMPLATE_REQUIRED_MESSAGE } from './contentWriting.ts';
import {
  CONTENT_GENERATION_JOB_TYPE,
  CONTENT_GENERATION_TASK_KIND,
  contentGenerationInputSignature,
  contentGenerationRetrySource,
  contentGenerationSessionTarget,
  loadTechnicalPlan,
  readGlobalFactsKnowledgeItems,
  saveContentPlanningResult,
  type TechnicalPlanState,
} from './store.ts';

export interface ContentGenerationParams {
  /** 全文重新生成（桌面版 regenerate，不带 targetItemId）：全部 AI 小节重新编排，不复用已保存的编排与正文会话。 */
  regenerate: boolean;
  /** 失败后重试（8.10b2，桌面版 retryFailedSections）：要重试的失败任务；regenerate 与它相同。 */
  retryOf?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseContentGenerationParams(raw: unknown): ContentGenerationParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('正文生成任务参数不合法');
  const { regenerate, retryOf, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof regenerate !== 'boolean') throw new TypeError('正文生成任务参数不合法');
  if (retryOf !== undefined && (typeof retryOf !== 'string' || !UUID_PATTERN.test(retryOf))) throw new TypeError('正文生成任务参数不合法');
  return { regenerate, ...(retryOf !== undefined ? { retryOf } : {}) };
}

export interface ContentGenerationProblem {
  readonly code: string;
  readonly message: string;
}

/**
 * 正文生成的前置条件（文案与桌面版 startContentGeneration、runContentGenerationTask 开始时的检查相同，按同样的顺序）：目录生效的字数
 * 快照、目录、全局事实、原方案（未解析完成 / 失败的两条与 8.7c1 相同，是 Web 版新增的）、AI 小节、正文模板（8.10c1；桌面版在页面上开始前
 * 与任务准备写作材料时检查，文案相同）。
 */
export function contentGenerationProblem(state: TechnicalPlanState): ContentGenerationProblem | null {
  if (!state.outlineWordControlSnapshot) return { code: 'TECHNICAL_PLAN_WORD_CONTROL_REQUIRED', message: '当前目录没有字数控制生效快照，请重新生成目录' };
  if (!state.outlineData?.outline.length) return { code: 'TECHNICAL_PLAN_OUTLINE_REQUIRED', message: '请先生成目录，再生成正文' };
  if (!formatGlobalFactsForPrompt(state.globalFacts)) return { code: 'TECHNICAL_PLAN_GLOBAL_FACTS_REQUIRED', message: '请先完成全局事实设定，再生成正文' };
  const plan = state.originalPlanFile;
  if (plan?.status === 'error') return { code: 'TECHNICAL_PLAN_ORIGINAL_PLAN_FAILED', message: '原方案解析失败，请移除后重新上传' };
  if (plan && (plan.status !== 'success' || !plan.markdownArtifactId)) return { code: 'TECHNICAL_PLAN_ORIGINAL_PLAN_NOT_READY', message: '原方案尚未解析完成，请稍后再试' };
  if (!collectAiLeaves(state.outlineData.outline).length) return { code: 'TECHNICAL_PLAN_CONTENT_SECTIONS_REQUIRED', message: '当前目录没有标记为“AI生成”的正文小节' };
  // 8.10c1：写作阶段要用生成配置中选用的模板（桌面版页面开始前检查、任务在准备写作材料时检查）。模板被删除时外键置空，所以有 id 即存在。
  if (!state.exportTemplateId) return { code: CONTENT_TEMPLATE_REQUIRED_CODE, message: CONTENT_TEMPLATE_REQUIRED_MESSAGE };
  return null;
}

/** 与桌面版相同：原生工具、json-validation、ask-user 与需用户确认的失败报告（顶层任务的 report-failure 即 request-termination）。 */
const CONTENT_PLANNING_TOOLS: readonly AgentPromptTool[] = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'json-validation', 'ask-user', 'request-termination'];
// generate-sections（8.10c2b2）、check-word-count（8.10c3b1）与 fix-submission-issues（8.10c3b3）只在写作阶段的提示词中启用
// （8.10c3c 接入），基础编排阶段的工具调用被阶段限制拦住。
const CONTENT_GENERATION_BUSINESS_TOOLS = ['ask-user', 'request-termination', 'generate-sections', 'check-word-count', 'fix-submission-issues'] as const;
const CONTINUE_PROMPT = '继续之前的任务';
/** 基础编排放入的材料的受保护文件分组。 */
const CONTENT_PLANNING_INPUT_GROUP = 'content-planning-inputs';
/** 预置的结果文件（交给 Agent 写入，写入后解除登记）。 */
const CONTENT_PLANNING_OUTPUT_GROUP = 'content-planning-output';
const CONTENT_INPUT_CHANGED_MESSAGE = '招标文件、解析结果、原方案、目录、生成配置或全局事实已变化，本次结果已丢弃，请重新开始';
export const CONTENT_STAGE_UNAVAILABLE_CODE = 'TECHNICAL_PLAN_CONTENT_STAGE_UNAVAILABLE';
export const CONTENT_RETRY_UNAVAILABLE_CODE = 'TECHNICAL_PLAN_CONTENT_RETRY_UNAVAILABLE';
export const CONTENT_RETRY_UNAVAILABLE_MESSAGE = '没有可以重试的正文生成任务（原正文会话不存在或输入已变化），请重新生成正文';
const CONTENT_STAGE_UNAVAILABLE_MESSAGE = '正文编排已保存；正文写作等后续阶段尚未开放，暂时无法继续生成正文';

function contentInputChanged(): JobError {
  return new JobError('TECHNICAL_PLAN_INPUT_CHANGED', CONTENT_INPUT_CHANGED_MESSAGE);
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 任务开始后读取材料失败（项目被删除等）时按任务失败处理（与 jobs.ts 的 readForJob 相同）。 */
async function readForJob<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof JobError) throw error;
    throw new JobError('TECHNICAL_PLAN_FAILED', '读取技术方案材料失败', { cause: error });
  }
}

/** checkpoint 中任务自己的状态：签名、本次交给 Agent 编排的目标（首次执行时确定，续跑沿用），编排是否已保存。 */
interface ContentTaskState {
  readonly signature: string;
  readonly planningTargetIds?: readonly string[];
  readonly planned?: boolean;
}

function readContentTaskState(raw: unknown): ContentTaskState | null {
  if (!isPlainRecord(raw)) return null;
  if (typeof raw.signature !== 'string' || raw.signature === '') throw new JobError('TECHNICAL_PLAN_FAILED', '正文生成的检查点不可用，请重新开始');
  const ids = raw.planningTargetIds;
  if (ids !== undefined && !(Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) {
    throw new JobError('TECHNICAL_PLAN_FAILED', '正文生成的检查点不可用，请重新开始');
  }
  return { signature: raw.signature, ...(ids !== undefined ? { planningTargetIds: ids as string[] } : {}), ...(raw.planned === true ? { planned: true } : {}) };
}

/**
 * 开始时的日志（与桌面版 runContentGenerationTask 的 logs 相同；文本模型并发的一条随 8.10c 的写作阶段）。retrying 为失败后重试的
 * 小节数（基础编排阶段的重试，桌面版 retryFailedSections && !continuingStageRun），否则为 null。
 */
async function logStart(
  context: JobContext<ContentGenerationParams>,
  state: TechnicalPlanState,
  leaves: readonly LeafContext[],
  tables: { maxTables: number | null; maxTablesForRun: number | null },
  retrying: number | null,
): Promise<void> {
  const tableRequirement = normalizeTableRequirement(state.contentGenerationOptions.tableRequirement);
  const wordControl = normalizeContentWordControl(state.outlineWordControlSnapshot);
  await context.log(`准备生成正文，共 ${leaves.length} 个小节。`);
  if (retrying !== null) await context.log(`开始重试 ${retrying} 个失败或未完成正文小节。`);
  await context.log(
    tableRequirement === 'heavy'
      ? '表格需求：大量，保持现有表格编排逻辑。'
      : tableRequirement === 'none'
        ? '表格需求：不要，本次正文编排不会安排表格。'
        : `表格需求：${TABLE_REQUIREMENT_LABELS[tableRequirement]}，全文最多 ${tables.maxTables} 个表格，本轮最多新增 ${tables.maxTablesForRun} 个。`,
  );
  if (wordControl.minimumWords > 0 || wordControl.maximumWords > 0 || wordControl.sectionWords > 0) {
    await context.log(
      `目录生效字数配置：最少 ${wordControl.minimumWords || '不限制'} 字，最多 ${wordControl.maximumWords || '不限制'} 字，每小节建议 ${wordControl.sectionWords || '不控制'} 字。`,
    );
  }
  await context.log('全文一致性审计为必做阶段，正文扩写完成后将使用 Agent 检查并修复事实冲突。');
  if (state.originalPlanFile) await context.log('检测到已上传原方案：已读取完整原方案，交由 Agent 按语义还原。');
}

/**
 * 正文生成（见文件头）。参数只有 regenerate；表格需求、配图数量等取已保存的生成配置（PATCH .../generation-config 先保存，桌面版随开始
 * 任务的参数传入）。
 */
export function createContentGenerationJob(): JobTypeDefinition<ContentGenerationParams> {
  return {
    type: CONTENT_GENERATION_JOB_TYPE,
    queue: 'agent',
    resumable: true,
    billable: true,
    agentLimits: AGENT_TASK_LIMITS.contentGeneration,
    agentTools: CONTENT_GENERATION_BUSINESS_TOOLS,
    agentWorkspace: { taskKind: CONTENT_GENERATION_TASK_KIND, keepAfterSuccess: true },
    // 正文生成用墙钟 2 小时的 agent-content 沙箱（#70 决定事项第 3 项）。
    agentSandboxTemplate: 'agent-content',
    parseParams: parseContentGenerationParams,
    async run(context) {
      const { db, tenant, params } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('TECHNICAL_PLAN_FAILED', '正文生成失败');
      // 先取签名再读状态与材料：读取期间输入变化时签名已过期，写入被拒绝。
      const current = await contentGenerationInputSignature(db, tenant, projectId);
      const state = await loadTechnicalPlan(db, tenant, projectId);
      const own = readContentTaskState(context.checkpoint?.task);
      // 失败后重试的首次执行：接着失败任务的会话与它的状态（编排目标）；之后的续跑用本任务自己的 checkpoint。
      let retryFrom: AgentRunState | undefined;
      let inherited: ContentTaskState | null = null;
      if (params.retryOf !== undefined && !own && !context.agent?.resuming) {
        // 入队后到执行之前情况可能已变化（快照被替换、输入变化）：再核对一次。
        const source = await readForJob(() => contentGenerationRetrySource(db, tenant, projectId, context.jobId));
        if (!source || source.jobId !== params.retryOf || source.regenerate !== params.regenerate) {
          throw new JobError(CONTENT_RETRY_UNAVAILABLE_CODE, CONTENT_RETRY_UNAVAILABLE_MESSAGE);
        }
        inherited = readContentTaskState(source.task);
        if (!inherited?.planningTargetIds || inherited.planned) throw new JobError(CONTENT_RETRY_UNAVAILABLE_CODE, CONTENT_RETRY_UNAVAILABLE_MESSAGE);
        retryFrom = source.state;
      }
      const saved = own ?? inherited;
      if (saved && saved.signature !== current) throw contentInputChanged();
      const signature = saved?.signature ?? current;
      const problem = contentGenerationProblem(state);
      if (problem) throw new JobError(problem.code, problem.message);
      if (saved?.planned) throw new JobError(CONTENT_STAGE_UNAVAILABLE_CODE, CONTENT_STAGE_UNAVAILABLE_MESSAGE);
      const retrying = params.retryOf !== undefined;

      const outline = state.outlineData!.outline;
      const leaves = collectAiLeaves(outline);
      const runtime = params.regenerate ? null : state.contentGenerationRuntime;
      const tableRequirement = normalizeTableRequirement(state.contentGenerationOptions.tableRequirement);
      const wordControl = normalizeContentWordControl(state.outlineWordControlSnapshot);
      // 全文重新生成不复用已保存的编排（桌面版开始时清空）。
      const storedPlans = params.regenerate ? {} : pruneContentGenerationPlans(state.contentGenerationPlans, leaves);
      const targets = selectContentGenerationTargets({ leaves, sections: state.contentGenerationSections, runtime, regenerate: params.regenerate });
      const tables = tablesForRun(tableRequirement, leaves, storedPlans, targets);
      const knowledgeItems = state.referenceKnowledgeDocumentIds.length
        ? contentKnowledgeItems(await readForJob(() => readGlobalFactsKnowledgeItems(db, tenant, projectId)))
        : [];
      const allowedKnowledgeItemIds = new Set(knowledgeItems.map((item) => item.id));
      // 可以复用已保存编排的目标不再交给 Agent（与桌面版 preparePlanning 相同）。
      const planningTargets = targets.filter((target) => reusableContentPlan(storedPlans[target.item.id], tableRequirement, allowedKnowledgeItemIds) === null);
      // 续跑沿用首次执行确定的编排目标（签名相同，目录未变）。
      const leafById = new Map(leaves.map((leaf) => [leaf.item.id, leaf]));
      const planning = saved?.planningTargetIds
        ? saved.planningTargetIds.map((id) => {
            const leaf = leafById.get(id);
            if (!leaf) throw contentInputChanged();
            return leaf;
          })
        : planningTargets;
      const planningIds = planning.map(({ item }) => item.id);

      if (!context.checkpoint) {
        await logStart(context, state, leaves, tables, retrying ? targets.length : null);
        await context.log(
          !state.referenceKnowledgeDocumentIds.length
            ? '本次正文编排未选择参考知识库。'
            : knowledgeItems.length
              ? `正文编排已读取 ${knowledgeItems.length} 条知识库轻量条目。`
              : '未读取到可用知识库轻量条目，正文编排不使用知识库。',
        );
        await context.setProgress(2);
      }
      if (!targets.length) {
        await context.log('本次没有待生成的 AI 小节。');
        throw new JobError(CONTENT_STAGE_UNAVAILABLE_CODE, CONTENT_STAGE_UNAVAILABLE_MESSAGE);
      }
      if (!context.checkpoint) {
        await context.log(
          planningTargets.length === targets.length
            ? `开始整体编排决策，共 ${targets.length} 个小节。`
            : `继续整体编排决策，共 ${targets.length} 个小节，复用 ${targets.length - planningTargets.length} 个历史编排。`,
        );
      }

      // 编排提交后程序整理并带签名写入（与桌面版 preparePlanning 的 complete 相同），再随检查点记下编排已保存。
      const finish = async (generated: ReadonlyMap<string, ContentPlan>, checkpoint: (task: Record<string, unknown>) => Promise<void>) => {
        const completed = completeContentPlanning({
          leaves,
          storedPlans,
          planningTargets: planning,
          generatedPlans: generated,
          tableRequirement,
          maxTablesForRun: tables.maxTablesForRun,
          imageQuantity: state.contentGenerationOptions.imageQuantity,
        });
        await context.log(
          `整体编排完成：表格候选 ${completed.tableCandidates} 个，${completed.selectedTables === null ? '保持现有编排' : `入选 ${completed.selectedTables} 个`}。`,
        );
        const written = await saveContentPlanningResult(
          db,
          tenant,
          projectId,
          { plans: completed.plans, runtime: contentRuntimeAfterPlanning(state.contentGenerationRuntime, params.regenerate, new Date()) },
          signature,
        );
        if (!written) throw contentInputChanged();
        await context.log(`本次 ${planning.length} 个小节的编排及配图标记已保存。`);
        if (planning.length) {
          await context.log(`本次编排目标字数：${completed.targetWords || '未设置'}；全文基准：${getContentWordTarget(wordControl) || '未设置'} 字。`);
        }
        await checkpoint({ signature, planningTargetIds: planningIds, planned: true });
      };

      if (!planning.length) {
        await finish(new Map(), (task) => context.saveCheckpoint({ task }, 15));
      } else {
        const isIncremental = isIncrementalPlanning(planningIds, runtime);
        const validation = { outline, allowedKnowledgeItemIds, targetItemIds: planningIds, wordControl, totalSections: leaves.length, isIncremental };
        // 首次执行：接着上一次正文生成的会话（正文阶段已开始时）；全文重新生成时先丢弃正文的会话；失败后重试接着失败任务的会话。
        // 续跑：本任务自己的现场。
        let continueFrom: AgentRunState | undefined = retryFrom;
        if (context.agent && !context.agent.resuming && !retrying) {
          if (params.regenerate) {
            await discardAgentWorkspaceSnapshots(db, tenant, context.objectStore, projectId, [CONTENT_GENERATION_TASK_KIND]);
          } else if (state.contentGenerationRuntime?.generation_started === true) {
            continueFrom = (await findContinuableAgentSession(db, tenant, contentGenerationSessionTarget(projectId)))?.state;
          }
        }
        const files = buildContentPlanningFiles({
          outline,
          storedPlans,
          knowledgeItems,
          projectOverview: state.outlineData!.project_overview || state.projectOverview || '',
          bidAnalysisFactsText: formatBidAnalysisFactsForPrompt(state.bidAnalysisTasks),
          targetItemIds: planningIds,
        });
        await withAgentRun(
          context.agent,
          async (run) => {
            const writeInputs = () =>
              run.baseline.write(
                run.sandbox,
                CONTENT_PLANNING_INPUT_GROUP,
                files.map((file) => ({ path: file.path, data: Buffer.from(file.content, 'utf8') })),
                { replace: true, signal: context.signal },
              );
            // 失败后重试（与桌面版 continuingPlanning 相同）：重新放入材料，保留结果文件的草稿供 Agent 修复。
            if (run.continued && retryFrom) {
              await context.log(`正文 Agent 开始基础编排，本次处理 ${planning.length} 个目录节点。`);
              await writeInputs();
            } else if (!run.resumed) {
              await context.log(`正文 Agent 开始基础编排，本次处理 ${planning.length} 个目录节点。`);
              await writeInputs();
              // 与桌面版 prepare_output_files 相同：新一轮清空结果文件，交给 Agent 写入（不登记为受保护文件；续跑时保留草稿）。
              await run.baseline.write(run.sandbox, CONTENT_PLANNING_OUTPUT_GROUP, [{ path: CONTENT_PLANNING_OUTPUT_FILE, data: Buffer.alloc(0) }], {
                replace: true,
                signal: context.signal,
              });
              run.baseline.release(CONTENT_PLANNING_OUTPUT_GROUP, [CONTENT_PLANNING_OUTPUT_FILE]);
            } else if (run.unavailableProtectedFiles.length > 0) {
              // 续跑时材料在快照中；原件不可用（快照中的副本被改动）时按同一输入重新放入。
              await writeInputs();
            }
            await context.setProgress(5);
            const stage = await run.runStage<Map<string, ContentPlan>>({
              stage: CONTENT_PLANNING_STAGE,
              stageIndex: 0,
              prompt: run.wasPrompted(CONTENT_PLANNING_STAGE)
                ? CONTINUE_PROMPT
                : createContentPlanningPrompt({ targetItemIds: planningIds, tableRequirement, maxTables: tables.maxTables, totalSections: leaves.length, wordControl, isIncremental }),
              tools: CONTENT_PLANNING_TOOLS,
              jsonSchemas: { [CONTENT_PLANNING_OUTPUT_FILE]: CONTENT_PLANNING_JSON_SCHEMA },
              outputFile: CONTENT_PLANNING_OUTPUT_FILE,
              // 与桌面版 max_retries 1 + buildRetryPrompt 相同：基础编排的执行失败不重试。
              maxExecutionRetries: 1,
              retryPrompt: () => null,
              repairPrompt: () => createContentPlanningRepairPrompt(),
              checkpointAfterPrompt: () => ({ signature, planningTargetIds: planningIds }),
              validate: async () => {
                const file = (await run.readFiles([CONTENT_PLANNING_OUTPUT_FILE])).get(CONTENT_PLANNING_OUTPUT_FILE);
                if (file && file.data === null) return { value: null, issues: [{ severity: 'blocking' as const, message: `${CONTENT_PLANNING_OUTPUT_FILE}过大，无法读取` }] };
                return validateContentPlanningOutput(file ? file.data!.toString('utf8') : null, validation);
              },
            });
            if (!stage.value) throw new JobError('TECHNICAL_PLAN_CONTENT_PLAN_INVALID', '正文编排结果不可用');
            if (context.signal.aborted) throw new JobInterruptedError();
            await finish(stage.value, (task) => run.checkpoint(task, 15));
          },
          continueFrom ? { continueFrom, ...(retryFrom ? { retainStages: true } : {}) } : undefined,
        );
      }
      // 后续阶段（原方案还原 8.11、正文写作 8.10c 起）接入之前到此为止。
      throw new JobError(CONTENT_STAGE_UNAVAILABLE_CODE, CONTENT_STAGE_UNAVAILABLE_MESSAGE);
    },
  };
}
