// worker 端的 Agent 执行（路线图第 8 步 8.6d1、8.6d2；docs/SERVER_DESIGN.md 第 7.27、7.28 节）。
//
// 桌面版的 piRuntimeService.runTask 在主进程中驱动 Pi 会话；Web 版的 Pi 会话在 agent 沙箱中，由 worker 逐条提示词驱动（#90）：
// 沙箱内的入口每次只执行一条提示词，阶段、提交校验、修复与重试、续跑的现场都在 worker 一侧。执行者给 agent 队列中登记了
// agentWorkspace 的任务提供 context.agent（src/jobs/runner.ts），任务经它：
// - open()：新建沙箱（任务类型登记的模板），为本次执行签发任务令牌（有效期 = 模板的入口墙钟），续跑时放入上次的工作区快照并从
//   checkpoint 重建受保护文件的登记、取回原件（8.5c、8.6c2b）；
// - prompt()：每条提示词之前先还原被改动的受保护文件，再经 runAgentPrompt 执行（先写下本阶段的业务工具，8.6c1）；
// - runStage()：一个阶段的提交校验与修复（与桌面版相同的提交策略，src/agent/submission.ts），执行失败按原因重试；
// - compact()（8.6d2）：阶段交接的上下文压缩（与桌面版 runStageCompaction 相同）：开始前登记待补压缩，成功或无需压缩时清除；
//   可选压缩失败时按原上下文继续并保留登记，续跑时在该阶段要求发出前补做；该阶段的要求发出后不再补做；
// - assistantText()（8.6d2）：从工作区的会话文件取回 Agent 最后一条回复的全文（不经入口的标准输出，按不可信内容处理）；
// - checkpoint()：先还原受保护文件，再经 context.agentWorkspace.saveCheckpoint 保存快照与 checkpoint（会话文件名、阶段、
//   已发出的阶段、待补压缩、受保护文件的登记、同时保存的快照 id 与任务自己的状态）；超出存储配额时 JobStorageQuotaError，会话随沙箱结束；
// - close()：销毁沙箱、作废令牌（任务在 finally 中调用，withAgentRun 代为调用）。
// - 跨任务续用（8.7b，桌面版 persistent_task.mode = 'resume'）：调整类任务首次执行时经 open({ continueFrom }) 接着另一个任务的会话
//   （src/agent/continuation.ts 按快照 id 找到与当前快照同一对的现场）：放入该类任务当前的快照，续接会话与受保护文件的登记，阶段、
//   已发出的阶段与待补压缩清空（新任务的要求照常发出）。之后的检查点与续跑与普通任务相同。失败后重试（8.10b2，retainStages）接着的是
//   同一件事的失败任务，阶段、已发出的阶段与待补压缩保留（任务只发“继续之前的任务”）。
//
// 入口的结果与失败代码都是沙箱的说法，不被采信：失败后按数据库中的事实判断原因（#92 登记）——本次执行的失败报告（8.4b）、任务的
// 费用与轮数上限（8.3a）、任务是否仍在本次执行中、令牌是否已到期，入口报告模型调用失败时再看模型调用路由在本条提示词（或压缩）
// 中记下的拒绝原因（8.6d3，src/agent/modelRejections.ts：余额不足暂停、模型不可用失败）；只有这些都不能说明时，才按入口的代码决定
// 是否重试（模型调用失败、连不上平台入口）或失败。给用户看的说明都是固定的文字，不含入口的输出、Agent 写出的内容与文件名。
// 本次执行的墙钟（令牌有效期）在 worker 一侧累计执行：每次执行入口时只给剩余的时间，到期即以 AGENT_TIME_LIMIT 失败。
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import { withOrgContext, type TenantContext } from '../db/tenant.ts';
import {
  JobBalanceExhaustedError,
  JobError,
  JobInterruptedError,
  JobModelUnavailableError,
  JobStorageQuotaError,
  JobTaskLimitError,
  type JobContext,
} from '../jobs/definitions.ts';
import { createSandboxWithRetry } from '../sandbox/createWithRetry.ts';
import { SandboxArchiveError, archivePathKey, validateRelativePath, visitArchive } from '../sandbox/archive.ts';
import { SandboxError, type SandboxRef } from '../sandbox/driver.ts';
import { AGENT_ENTRY_COMMAND, SANDBOX_TEMPLATES } from '../sandbox/templates.ts';
import type { RunRef } from '../jobs/store.ts';
import { findAgentJobBudget } from './budget.ts';
import { AGENT_SESSION_FILE_READ_MAX_BYTES, agentAssistantTextLimit, extractAgentAssistantText, type AgentAssistantText } from './assistantText.ts';
import {
  AGENT_COMPACTION_INSTRUCTIONS_MAX_CHARS,
  AGENT_ENTRY_FAILED_CODE,
  AGENT_MAX_TURNS_PER_PROMPT,
  runAgentCompaction,
  runAgentPrompt,
  type AgentEntryErrorCode,
  type AgentPromptTool,
} from './entry.ts';
import { AGENT_REPORTED_FAILURE_CODE, AGENT_REPORTED_FAILURE_FALLBACK_MESSAGE, findAgentFailureReport } from './failureReport.ts';
import { agentModelRejectionMark, agentModelRejectionSince } from './modelRejections.ts';
import {
  buildAgentExecutionRetryPrompt,
  buildAgentSubmissionRepairPrompt,
  createAgentSubmissionPolicy,
  restoredFilesNotice,
  AGENT_MAX_EXECUTION_RETRIES,
  type AgentSubmissionIssue,
  type AgentSubmissionReport,
} from './submission.ts';
import { issueAgentJobToken, revokeAgentJobTokens, type IssuedAgentToken } from './tokenStore.ts';
import { createAgentWorkspaceBaseline, type AgentWorkspaceBaseline, type AgentWorkspaceBaselineState } from './workspaceBaseline.ts';
import { AGENT_WORKSPACE_REJECTED_CODE, AGENT_WORKSPACE_RESTORE_FAILED_CODE, agentWorkspaceRejectedMessage, agentWorkspaceRejectionCategory, type JobAgentWorkspace } from './workspaceJob.ts';
import type { WorkspaceSandboxDriver } from './workspaceSandbox.ts';

/** agent 队列可用的沙箱模板（templates.ts）：正文生成类任务用 agent-content（2 小时），其余用 agent（30 分钟）。 */
export const AGENT_SANDBOX_TEMPLATES = ['agent', 'agent-content'] as const;
export type AgentSandboxTemplate = (typeof AGENT_SANDBOX_TEMPLATES)[number];

export const AGENT_TIME_LIMIT_CODE = 'AGENT_TIME_LIMIT';
export const AGENT_SANDBOX_FAILED_CODE = 'AGENT_SANDBOX_FAILED';
export const AGENT_SANDBOX_BUSY_CODE = 'AGENT_SANDBOX_BUSY';
export const AGENT_UNAVAILABLE_CODE = 'AGENT_UNAVAILABLE';
export const AGENT_MODEL_FAILED_CODE = 'AGENT_MODEL_FAILED';
export const AGENT_GATEWAY_FAILED_CODE = 'AGENT_GATEWAY_FAILED';
export const AGENT_PROMPT_TURN_LIMIT_CODE = 'AGENT_PROMPT_TURN_LIMIT';
export const AGENT_SESSION_INVALID_CODE = 'AGENT_SESSION_INVALID';
export const AGENT_SUBMISSION_FAILED_CODE = 'AGENT_SUBMISSION_FAILED';
export const AGENT_COMPACTION_FAILED_CODE = 'AGENT_COMPACTION_FAILED';

const SANDBOX_FAILED_MESSAGE = 'Agent 沙箱执行失败，任务已停止，请稍后重新发起';
const SESSION_MISSING_MESSAGE = '上次保存的 Agent 会话不可用，请重新发起任务';
const SESSION_INVALID_MESSAGE = 'Agent 会话不可用，任务已停止，请重新发起任务';
/** 模型调用失败与连不上平台入口时给 Agent 与用户看的原因（固定文字，不采信沙箱的说法）。 */
const MODEL_FAILED_REASON = '模型调用失败';
const GATEWAY_FAILED_REASON = '连接平台服务失败';
const COMPACTION_FAILED_MESSAGE = 'Agent 上下文压缩失败，任务已停止，请稍后重新发起';
/** 可选压缩按原上下文继续的入口代码（判断完数据库中的事实之后）：模型调用失败、连不上平台入口、入口内部错误。 */
const OPTIONAL_COMPACTION_TOLERATED: readonly AgentEntryErrorCode[] = ['MODEL_FAILED', 'GATEWAY_UNAVAILABLE', 'GATEWAY_FAILED', 'INTERNAL'];

/** 新建沙箱时 SANDBOX_BUSY / SANDBOX_UNAVAILABLE 的重试间隔（与导出相同的起步值）。 */
export const AGENT_SANDBOX_CREATE_DELAYS_MS: readonly number[] = Object.freeze([5_000, 15_000, 30_000]);

/** checkpoint 中执行者的现场放在这个键下，任务自己的状态在 task 下。 */
const CHECKPOINT_VERSION = 1;
/** 阶段名：任务代码中的常量（与受保护文件的分组名同一规则）。 */
const STAGE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_STAGE_INDEX = 10_000;
const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_SESSION_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** readFiles 的默认上限。 */
export const AGENT_READ_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const AGENT_READ_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
export const AGENT_READ_MAX_FILES = 256;

/** 组织选用的模型的上下文长度与输出上限（入口的 Pi 会话按它压缩与截断，8.6b）。 */
export interface AgentModelLimits {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

/** 未给出时的模型上限（与桌面版 context_length_limit 的默认值、输出上限 32,768 相同，再截到平台的 AI_MAX_OUTPUT_TOKENS）。 */
export const DEFAULT_AGENT_CONTEXT_WINDOW = 400_000;
export const DEFAULT_AGENT_MAX_OUTPUT_TOKENS = 32_768;

/** 待补的阶段交接压缩（桌面版 compaction_pending）：压缩完成前登记，续跑时在该阶段的要求发出前补做。 */
export interface AgentCompactionPending {
  /** 压缩之后要进入的阶段。 */
  readonly stage: string;
  readonly instructions: string;
  /** 可选压缩：失败时按原上下文继续。 */
  readonly optional: boolean;
}

/** 写进 jobs.checkpoint 的执行者现场（不含任何令牌与文件内容）。 */
export interface AgentRunState {
  readonly version: 1;
  /** Pi 的会话文件名（工作区 pi-sessions/ 中）；还没有会话时为 null。 */
  readonly session: string | null;
  /** 当前阶段与序号（任务给出）；还没有发出提示词时为 null / 0。 */
  readonly stage: string | null;
  readonly stageIndex: number;
  /** 已在会话中发出过要求的阶段（桌面版 prompted_stage）：续跑时任务据此只发“继续之前的任务”。 */
  readonly promptedStage: string | null;
  /** 待补的阶段交接压缩（8.6d2）；8.6d1 写下的 checkpoint 没有这一项，按 null 读出。 */
  readonly compactionPending: AgentCompactionPending | null;
  /** 受保护文件的登记（8.6c2b 的 toState）。 */
  readonly baseline: AgentWorkspaceBaselineState;
  /**
   * 与本现场同时保存的工作区快照 id（8.7b）：续跑与跨任务续用时放入的快照须是它，否则会话与快照不是同一对、不可用。
   * 8.7b 之前写下的现场没有这一项，按 null 读出（续跑时不核对）。
   */
  readonly snapshot: string | null;
}

export interface AgentRunCheckpoint {
  readonly agent: AgentRunState;
  readonly task: Record<string, unknown> | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const isStage = (value: unknown): value is string => typeof value === 'string' && STAGE_PATTERN.test(value);

const isCompactionInstructions = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= AGENT_COMPACTION_INSTRUCTIONS_MAX_CHARS;

function parseCompactionPending(value: unknown): AgentCompactionPending | null {
  if (value === null) return null;
  if (!isPlainObject(value) || Object.keys(value).length !== 3 || !isStage(value.stage) || !isCompactionInstructions(value.instructions) || typeof value.optional !== 'boolean') {
    throw new TypeError('Agent 的 checkpoint 不合法');
  }
  return { stage: value.stage, instructions: value.instructions, optional: value.optional };
}

/**
 * 从 jobs.checkpoint 读出执行者的现场：checkpoint 为 null 或没有 agent 键时返回 null（首次执行，或任务自己保存的 checkpoint）；
 * 形状不对时抛 TypeError（checkpoint 由 worker 写入，仍逐项检查）。受保护文件的登记由 createAgentWorkspaceBaseline 再检查。
 */
export function parseAgentRunCheckpoint(checkpoint: Record<string, unknown> | null): AgentRunCheckpoint | null {
  if (checkpoint === null || !Object.hasOwn(checkpoint, 'agent')) return null;
  const agent = checkpoint.agent;
  const task = Object.hasOwn(checkpoint, 'task') ? checkpoint.task : null;
  if (!isPlainObject(agent) || (task !== null && !isPlainObject(task))) throw new TypeError('Agent 的 checkpoint 不合法');
  const { version, session, stage, stageIndex, promptedStage, baseline } = agent;
  const snapshot = Object.hasOwn(agent, 'snapshot') ? agent.snapshot : null;
  if (
    version !== CHECKPOINT_VERSION ||
    (session !== null && (typeof session !== 'string' || !AGENT_SESSION_FILE.test(session))) ||
    (stage !== null && !isStage(stage)) ||
    !Number.isSafeInteger(stageIndex) || (stageIndex as number) < 0 || (stageIndex as number) > MAX_STAGE_INDEX ||
    (promptedStage !== null && !isStage(promptedStage)) ||
    (snapshot !== null && (typeof snapshot !== 'string' || !SNAPSHOT_ID.test(snapshot))) ||
    !isPlainObject(baseline)
  ) {
    throw new TypeError('Agent 的 checkpoint 不合法');
  }
  return {
    agent: {
      version: CHECKPOINT_VERSION,
      session: session as string | null,
      stage: stage as string | null,
      stageIndex: stageIndex as number,
      promptedStage: promptedStage as string | null,
      compactionPending: parseCompactionPending(Object.hasOwn(agent, 'compactionPending') ? agent.compactionPending : null),
      baseline: baseline as unknown as AgentWorkspaceBaselineState,
      snapshot: snapshot as string | null,
    },
    task: task as Record<string, unknown> | null,
  };
}

/** 一条提示词。会话由执行者管理（续接上一条的会话文件），不由任务指定。 */
export interface AgentPromptInput {
  /** 本条提示词所属的阶段（任务代码中的常量）。 */
  readonly stage: string;
  /** 阶段序号；省略时沿用当前的。 */
  readonly stageIndex?: number;
  readonly prompt: string;
  /** 启用的原生工具、本地工具与业务工具（业务工具须是任务类型登记的 agentTools 的子集）。 */
  readonly tools: readonly AgentPromptTool[];
  /** 本条提示词之内至多的轮数；省略时为入口的上限。 */
  readonly maxTurns?: number;
  readonly jsonSchemas?: Readonly<Record<string, unknown>>;
}

export interface AgentPromptOutcome {
  readonly turns: number;
  readonly stopReason: 'stop' | 'length';
  /** 发出提示词之前还原的受保护文件。 */
  readonly restored: readonly string[];
}

/**
 * 执行失败、可以在同一会话中重试（模型调用失败、连不上平台入口）：原因是固定的文字。runStage 按 maxExecutionRetries 重试，
 * 用完后以 jobError 失败；任务直接调用 prompt 时自行决定。
 */
export class AgentPromptRetryableError extends Error {
  readonly reason: string;
  readonly jobError: JobError;

  constructor(reason: string, jobError: JobError) {
    super(reason, { cause: jobError });
    this.name = 'AgentPromptRetryableError';
    this.reason = reason;
    this.jobError = jobError;
  }
}

/** 阶段交接的上下文压缩（8.6d2，桌面版 compact_before_prompt）。 */
export interface AgentCompactionInput {
  /** 压缩之后要进入的阶段（任务代码中的常量）。 */
  readonly stage: string;
  /** 压缩指令（总结时保留什么、不摘录什么）。 */
  readonly instructions: string;
  /** 可选压缩（默认 false）：模型调用失败等时按原上下文继续，登记保留到该阶段的要求发出为止。必须的压缩失败时任务失败。 */
  readonly optional?: boolean;
  /** 给出时，登记待补压缩之后、压缩之前保存检查点（与桌面版相同：压缩中被暂停时，续跑在该阶段要求发出前补做）。 */
  readonly checkpoint?: { readonly task: Record<string, unknown> | null; readonly progress?: number };
}

/** compact 的结果：compacted 已压缩；noop 无需压缩（还没有会话、会话太短、刚压缩过）；failed 可选压缩失败、按原上下文继续。 */
export type AgentCompactionStatus = 'compacted' | 'noop' | 'failed';

export interface AgentStageOptions<V> extends AgentPromptInput {
  /** 本阶段的结果文件（执行重试的提示词中给出，与桌面版 output_file 相同）。 */
  readonly outputFile: string;
  /** 执行失败后的重试次数（0～3，默认 1，与桌面版 max_retries 相同）。 */
  readonly maxExecutionRetries?: number;
  /**
   * 提交校验：按固定规则校验工作区中的结果（经 run.readFiles 读取，内容按不可信数据处理；受保护文件只用 baseline.original）。
   * attempt 为第几次提交，restored 为校验前刚还原的受保护文件。
   */
  validate(input: { attempt: number; restored: readonly string[] }): Promise<AgentSubmissionReport<V>>;
  /** 提交修复中的业务说明（文件与工具细节）；省略时为“本次结果文件：…。在当前会话和工作区修复，保留已完成内容。” */
  repairPrompt?(input: { report: AgentSubmissionReport<V>; mode: 'normal' | 'change-strategy' | 'minimum'; attempt: number }): string | Promise<string>;
  /** 执行失败后的重试提示词；返回 null 时不重试、按失败结束；省略时用桌面版的默认说明。 */
  retryPrompt?(input: { reason: string; attempt: number; maxRetries: number }): string | null | Promise<string | null>;
  /** 给出时，每条提示词成功执行之后（提交校验之前）保存检查点，任务的状态取它的返回值。 */
  checkpointAfterPrompt?(): Record<string, unknown> | null;
}

export interface AgentStageResult<V> {
  readonly value: V | null;
  /** 接受时仍遗留的问题（质量问题，或连续两次没有进展后接受的问题）。 */
  readonly acceptedIssues: readonly AgentSubmissionIssue[];
  /** 本阶段发出的提交修复次数与执行重试次数。 */
  readonly repairs: number;
  readonly executionRetries: number;
}

/** 工作区中读出的文件（readFiles）：内容来自沙箱，按不可信数据处理。超过单个文件上限的只给出大小。 */
export interface AgentWorkspaceFile {
  readonly size: number;
  readonly data: Buffer | null;
}

export interface AgentRun {
  readonly sandbox: SandboxRef;
  /** 受保护文件的登记（8.6c2b）：任务经 baseline.write 放入输入资料。 */
  readonly baseline: AgentWorkspaceBaseline;
  /** 是否从本任务的 checkpoint 续跑（放入了上次的工作区快照）。 */
  readonly resumed: boolean;
  /** 是否接着另一个任务的会话（8.7b，open({ continueFrom })）：放入了该类任务当前的快照，阶段与已发出的阶段从空开始（retainStages 时保留，8.10b2）。 */
  readonly continued: boolean;
  /** 续跑后原件仍不可用的受保护文件：任务须重新 baseline.write，否则需要还原时任务失败。 */
  readonly unavailableProtectedFiles: readonly string[];
  /** checkpoint 中任务自己的状态（首次执行、接着另一个任务的会话时为 null）。 */
  readonly taskCheckpoint: Record<string, unknown> | null;
  readonly session: string | null;
  readonly stage: string | null;
  readonly stageIndex: number;
  /** 该阶段的要求是否已在会话中发出（续跑时任务据此只发“继续之前的任务”）。 */
  wasPrompted(stage: string): boolean;
  /** 待补的阶段交接压缩（8.6d2）。 */
  readonly compactionPending: AgentCompactionPending | null;
  /**
   * 阶段交接的上下文压缩（见文件头）。续跑后第一条提示词之前，若 checkpoint 中有该阶段的待补压缩、而该阶段的要求还没有发出，
   * 执行者先自动补做，任务不必自己调用。
   */
  compact(input: AgentCompactionInput): Promise<AgentCompactionStatus>;
  /**
   * 从工作区的会话文件取回 Agent 最后一条回复的全文（8.6d2；桌面版 assistant_text）。还没有会话、会话文件不存在或过大、
   * 内容不合法、没有回复时返回 null。内容来自沙箱，按不可信的 AI 内容处理。
   */
  assistantText(options?: { maxChars?: number }): Promise<AgentAssistantText | null>;
  /** 读出工作区中的文件（不存在的不在结果中）。路径按 agent 工作区的规则校验，不合法时抛 TypeError。 */
  readFiles(paths: readonly string[], options?: { maxFileBytes?: number; maxTotalBytes?: number }): Promise<ReadonlyMap<string, AgentWorkspaceFile>>;
  /** 执行一条提示词（见文件头）。可以重试的失败抛 AgentPromptRetryableError，其余按原因抛 JobError / 暂停类错误 / JobInterruptedError。 */
  prompt(input: AgentPromptInput): Promise<AgentPromptOutcome>;
  /** 一个阶段：发出提示词、提交校验、按提交策略修复，执行失败按原因重试。 */
  runStage<V>(options: AgentStageOptions<V>): Promise<AgentStageResult<V>>;
  /** 检查点：先还原受保护文件，再保存工作区快照与 checkpoint（{ agent: 现场, task }）。 */
  checkpoint(task: Record<string, unknown> | null, progress?: number): Promise<void>;
  /** 销毁沙箱、作废令牌；可以重复调用。 */
  close(): Promise<void>;
}

export interface AgentOpenOptions {
  /**
   * 跨任务续用（8.7b）：接着另一个任务的会话（findContinuableAgentSession 找到的现场，须有会话与快照 id）。只能用于首次执行
   * （resuming 为 false）；续跑时放入本任务的快照，不能再给出。放入的快照不是该现场的快照时以 AGENT_WORKSPACE_RESTORE_FAILED 失败。
   */
  readonly continueFrom?: AgentRunState;
  /**
   * 失败后重试（8.10b2，桌面版 retryFailedSections 的 continuingPlanning）：与 continueFrom 一起给出，接着的是同一件事的失败任务，
   * 保留阶段、已发出的阶段与待补压缩（任务据此只发“继续之前的任务”）；不给出时按跨任务续用清空。
   */
  readonly retainStages?: boolean;
}

/** 任务上下文中的 Agent（context.agent）。 */
export interface JobAgent {
  readonly template: AgentSandboxTemplate;
  /** checkpoint 中是否有执行者的现场（本次执行是续跑）。 */
  readonly resuming: boolean;
  /** 打开本次执行的沙箱与会话；一次执行只能打开一次。 */
  open(options?: AgentOpenOptions): Promise<AgentRun>;
}

export interface JobAgentOptions {
  db: Kysely<Database>;
  driver: WorkspaceSandboxDriver;
  run: RunRef;
  tenant: TenantContext;
  template: AgentSandboxTemplate;
  /** 任务类型登记的 agentTools。 */
  allowedTools: readonly string[];
  model: AgentModelLimits;
  checkpoint: Record<string, unknown> | null;
  workspace: JobAgentWorkspace;
  context: Pick<JobContext<unknown>, 'jobId' | 'signal' | 'log'>;
  /** 新建沙箱的重试间隔（测试用）。 */
  createDelaysMs?: readonly number[];
}

/** 一次执行的墙钟（令牌有效期）：模板中入口命令的墙钟。 */
export function agentRunWallClockMs(template: AgentSandboxTemplate): number {
  const command = SANDBOX_TEMPLATES[template].commands[AGENT_ENTRY_COMMAND];
  if (!command) throw new TypeError('agent 模板没有入口命令');
  return command.timeoutMs;
}

function timeLimitError(template: AgentSandboxTemplate): JobError {
  return new JobError(AGENT_TIME_LIMIT_CODE, `Agent 执行超过本任务的时限（${Math.round(agentRunWallClockMs(template) / 60_000)} 分钟），任务已停止`);
}

/** 工作区不符合取回规则时与检查点相同的失败（说明只写类别）。 */
function workspaceRejected(error: SandboxError | SandboxArchiveError): JobError {
  const reason = error instanceof SandboxArchiveError ? error.reason : error.cause instanceof SandboxArchiveError ? error.cause.reason : null;
  return new JobError(AGENT_WORKSPACE_REJECTED_CODE, agentWorkspaceRejectedMessage(agentWorkspaceRejectionCategory(reason)), { cause: error });
}

const READ_LIMITS = SANDBOX_TEMPLATES.agent.output;

function normalizeReadPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new TypeError('工作区文件的路径必须是字符串');
  try {
    return validateRelativePath(raw, READ_LIMITS, false);
  } catch (error) {
    if (error instanceof SandboxArchiveError) throw new TypeError(`工作区文件的路径不合法（${error.reason}）`);
    throw error;
  }
}

interface RunFacts {
  running: boolean;
  failureReported: boolean;
  exhaustedReason: 'task_cost_limit' | 'task_turn_limit' | null;
}

/** 本次执行在数据库中的事实（失败后判断原因用）。 */
async function readRunFacts(db: Kysely<Database>, run: RunRef): Promise<RunFacts> {
  const facts = await withOrgContext(db, run.orgId, async (trx) => {
    const job = await trx.selectFrom('jobs').select(['status', 'pause_requested']).where('id', '=', run.jobId).where('run_id', '=', run.runId).executeTakeFirst();
    const report = await findAgentFailureReport(trx, run.jobId, run.runId);
    return { running: job?.status === 'running' && !job.pause_requested, failureReported: report !== null };
  });
  const budget = await findAgentJobBudget(db, run);
  return { ...facts, exhaustedReason: budget?.exhaustedReason ?? null };
}

export function createJobAgent(options: JobAgentOptions): JobAgent {
  const { db, driver, run, tenant, template, context } = options;
  const parsed = parseAgentRunCheckpoint(options.checkpoint);
  let opened = false;
  return Object.freeze({
    template,
    resuming: parsed !== null,
    async open(openOptions: AgentOpenOptions = {}): Promise<AgentRun> {
      if (opened) throw new TypeError('一次执行只能打开一次 Agent 沙箱');
      if (openOptions.retainStages && openOptions.continueFrom === undefined) throw new TypeError('retainStages 只能与 continueFrom 一起给出');
      const inherited = openOptions.continueFrom === undefined ? null : continuationCheckpoint(openOptions.continueFrom, parsed, openOptions.retainStages === true);
      opened = true;
      return openAgentRun(options, inherited ?? parsed, { db, driver, run, tenant, template, context }, inherited !== null);
    },
  });
}

/**
 * 跨任务续用的现场：形状同 checkpoint 逐项检查，须有会话与快照 id；阶段、已发出的阶段与待补压缩清空（失败后重试 retainStages 时保留），
 * 任务状态为空。
 */
function continuationCheckpoint(source: AgentRunState, own: AgentRunCheckpoint | null, retainStages: boolean): AgentRunCheckpoint {
  if (own !== null) throw new TypeError('续跑的执行不能接着其他任务的会话');
  const parsed = parseAgentRunCheckpoint({ agent: source as unknown as Record<string, unknown> });
  if (!parsed || parsed.agent.session === null || parsed.agent.snapshot === null) throw new TypeError('接着的会话必须有会话文件与快照');
  if (retainStages) return { agent: parsed.agent, task: null };
  return { agent: { ...parsed.agent, stage: null, stageIndex: 0, promptedStage: null, compactionPending: null }, task: null };
}

async function openAgentRun(
  options: JobAgentOptions,
  parsed: AgentRunCheckpoint | null,
  deps: Pick<JobAgentOptions, 'db' | 'driver' | 'run' | 'tenant' | 'template' | 'context'>,
  continued: boolean,
): Promise<AgentRun> {
  const { db, driver, run, tenant, template, context } = deps;
  const signal = context.signal;
  // 受保护文件的登记在建沙箱之前检查（不合法时不建沙箱）。
  const baseline: AgentWorkspaceBaseline = createAgentWorkspaceBaseline({ driver }, parsed?.agent.baseline ?? null);
  let sandbox: SandboxRef | null = null;
  let token: IssuedAgentToken | null = null;
  let closed = false;
  let broken: Error | null = null;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (sandbox) await driver.destroy(sandbox).catch(() => {});
    await revokeAgentJobTokens(db, run).catch(() => 0);
  }

  /** 沙箱操作的错误：中止按中止，取回不符合规则按工作区被拒绝，其余为沙箱失败（之后沙箱不再使用）。 */
  function sandboxFailure(error: unknown): unknown {
    if (signal.aborted) return new JobInterruptedError();
    if (error instanceof SandboxError) {
      if (error.code === 'SANDBOX_ABORTED') return new JobInterruptedError();
      broken ??= error;
      if (error.code === 'SANDBOX_OUTPUT_REJECTED') return workspaceRejected(error);
      return new JobError(AGENT_SANDBOX_FAILED_CODE, SANDBOX_FAILED_MESSAGE, { cause: error });
    }
    if (error instanceof JobError || error instanceof JobStorageQuotaError) broken ??= error;
    return error;
  }

  try {
    sandbox = await createSandboxWithRetry(driver, context, {
      template,
      delaysMs: options.createDelaysMs ?? AGENT_SANDBOX_CREATE_DELAYS_MS,
      busy: (cause) => new JobError(AGENT_SANDBOX_BUSY_CODE, 'Agent 服务繁忙（沙箱数已达上限），请稍后重新发起', { cause }),
      unavailable: (cause) => new JobError(AGENT_UNAVAILABLE_CODE, 'Agent 服务暂不可用，请稍后重新发起', { cause }),
      busyLog: '沙箱数已达上限，稍后重试',
      unavailableLog: 'Agent 服务暂不可用，稍后重试',
    }).catch((error: unknown) => {
      throw error instanceof SandboxError ? sandboxFailure(error) : error;
    });
    token = await issueAgentJobToken(db, run, agentRunWallClockMs(template));
    // 本次执行已结束（被收回、已结束）或已请求暂停：不签发，按中止收尾。
    if (!token) throw new JobInterruptedError();
    let unavailable: string[] = [];
    if (parsed) {
      const restored = await options.workspace.restore(sandbox);
      // checkpoint 中有会话、快照却不在了：会话不可用，不从头开始（从头开始会重新调用模型、重新扣费，由用户决定）。
      if (!restored) {
        if (parsed.agent.session !== null || Object.keys(parsed.agent.baseline.groups ?? {}).length > 0) {
          throw new JobError(AGENT_WORKSPACE_RESTORE_FAILED_CODE, SESSION_MISSING_MESSAGE);
        }
      } else if (parsed.agent.snapshot !== null && restored.id !== parsed.agent.snapshot) {
        // 当前的快照已被其他任务替换（8.7b）：与现场中的会话不是同一对。
        throw new JobError(AGENT_WORKSPACE_RESTORE_FAILED_CODE, SESSION_MISSING_MESSAGE);
      } else {
        unavailable = await baseline.recover(sandbox, { signal }).catch((error: unknown) => {
          throw sandboxFailure(error);
        });
      }
    }
    return createRun(unavailable);
  } catch (error) {
    await close();
    throw error;
  }

  function createRun(unavailable: readonly string[]): AgentRun {
    const current = sandbox!;
    const issued = token!;
    const state = {
      session: parsed?.agent.session ?? null,
      stage: parsed?.agent.stage ?? null,
      stageIndex: parsed?.agent.stageIndex ?? 0,
      promptedStage: parsed?.agent.promptedStage ?? null,
      compactionPending: parsed?.agent.compactionPending ?? null,
      snapshot: parsed?.agent.snapshot ?? null,
    };
    // 续跑后的第一条提示词之前检查一次 checkpoint 中的待补压缩（桌面版 resumePendingCompaction）。
    let resumeCompactionChecked = parsed === null;
    const allowedTools = options.allowedTools;
    const model = options.model;

    function assertUsable(): void {
      if (closed) throw new TypeError('Agent 沙箱已关闭');
      if (broken) throw broken instanceof JobError || broken instanceof JobStorageQuotaError || broken instanceof JobBalanceExhaustedError || broken instanceof JobModelUnavailableError ? broken : new JobError(AGENT_SANDBOX_FAILED_CODE, SANDBOX_FAILED_MESSAGE, { cause: broken });
      if (signal.aborted) throw new JobInterruptedError();
    }

    async function restoreProtected(): Promise<string[]> {
      try {
        return await baseline.restore(current, { signal });
      } catch (error) {
        throw sandboxFailure(error);
      }
    }

    async function logRestored(restored: readonly string[]): Promise<void> {
      if (restored.length === 0) return;
      // 路径是平台登记的受保护文件（不是 Agent 写出的名字），日志只给数量与前 20 个。
      await context.log(`已还原 ${restored.length} 个被改动的程序文件`, { count: restored.length, paths: restored.slice(0, 20) });
    }

    /**
     * 失败后按数据库中的事实判断原因（不采信入口的说法）。rejectionMark 是执行入口之前本次执行被拒绝的次数：只采信这之后
     * 模型调用路由记下的拒绝。
     */
    async function explainFailure(code: AgentEntryErrorCode | null, cause: unknown, maxTurns: number, deadlinePassed: boolean, rejectionMark: number): Promise<Error> {
      if (signal.aborted) return new JobInterruptedError();
      const facts = await readRunFacts(db, run);
      // 失败报告：finishRun 按数据库中的报告以 AGENT_REPORTED_FAILURE 失败，原因取报告。
      if (facts.failureReported) return new JobError(AGENT_REPORTED_FAILURE_CODE, AGENT_REPORTED_FAILURE_FALLBACK_MESSAGE, { cause });
      if (facts.exhaustedReason) return new JobTaskLimitError(facts.exhaustedReason, { cause });
      if (!facts.running) return new JobInterruptedError();
      if (deadlinePassed || Date.now() >= issued.expiresAt.getTime()) return timeLimitError(template);
      switch (code) {
        case 'MODEL_FAILED': {
          // 模型调用路由在本条提示词（或压缩）中记下的拒绝原因（8.6d3）：余额不足以冻结（含可用余额不低于 1 元、但不够一次冻结）
          // 一律暂停（充值后从 checkpoint 续跑）；没有选择模型 / 所选模型不可用同样暂停（#98 确认，在设置中选择可用的模型后续跑）；
          // 没有记下时按模型调用失败重试。
          const rejected = await agentModelRejectionSince(db, run, rejectionMark);
          switch (rejected) {
            case 'insufficient_balance':
              return new JobBalanceExhaustedError({ cause });
            case 'model_not_configured':
            case 'model_unavailable':
              return new JobModelUnavailableError(rejected, { cause });
            case null:
              return new AgentPromptRetryableError(MODEL_FAILED_REASON, new JobError(AGENT_MODEL_FAILED_CODE, '模型调用失败，任务已停止，请稍后重新发起', { cause }));
          }
        }
        case 'GATEWAY_UNAVAILABLE':
        case 'GATEWAY_FAILED':
          return new AgentPromptRetryableError(GATEWAY_FAILED_REASON, new JobError(AGENT_GATEWAY_FAILED_CODE, 'Agent 连接平台服务失败，任务已停止，请稍后重新发起', { cause }));
        case 'TURN_LIMIT':
          return new JobError(AGENT_PROMPT_TURN_LIMIT_CODE, `Agent 在一条提示词之后已连续执行 ${maxTurns} 轮仍未结束，任务已停止`, { cause });
        case 'SESSION_INVALID':
          return new JobError(AGENT_SESSION_INVALID_CODE, SESSION_INVALID_MESSAGE, { cause });
        default:
          // 其余（令牌无效、报告失败或执行已结束却查不到对应的事实、请求被拒绝、入口内部错误、结果不符合协议）：
          // 沙箱的说法不可信，按入口失败结束。
          return new JobError(AGENT_ENTRY_FAILED_CODE, 'Agent 入口执行失败', { cause });
      }
    }

    async function prompt(input: AgentPromptInput): Promise<AgentPromptOutcome> {
      assertUsable();
      if (!isStage(input.stage)) throw new TypeError('阶段名不合法');
      if (input.stageIndex !== undefined && !(Number.isSafeInteger(input.stageIndex) && input.stageIndex >= 0 && input.stageIndex <= MAX_STAGE_INDEX)) {
        throw new TypeError('阶段序号不合法');
      }
      const maxTurns = input.maxTurns ?? AGENT_MAX_TURNS_PER_PROMPT;
      if (!resumeCompactionChecked) {
        resumeCompactionChecked = true;
        // 续跑时该阶段的要求尚未发出而交接压缩未完成（失败或被暂停）：先补做压缩，再发出阶段要求。
        const pending = state.compactionPending;
        if (pending && pending.stage === input.stage && state.promptedStage !== input.stage) await runCompaction(pending);
      }
      const remaining = issued.expiresAt.getTime() - Date.now();
      if (remaining <= 0) throw timeLimitError(template);
      // 每条提示词之前还原被改动的受保护文件（8.6c2b）。
      const restored = await restoreProtected();
      await logRestored(restored);
      state.stage = input.stage;
      if (input.stageIndex !== undefined) state.stageIndex = input.stageIndex;
      // 续接的会话中，提示词一旦发出就已写进会话文件（即使本条失败）；新建会话失败时会话文件名未知，下一条重新新建。
      if (state.session !== null) state.promptedStage = input.stage;
      // 阶段要求发出后不再补做该阶段的交接压缩（与桌面版相同）。
      if (state.compactionPending?.stage === input.stage) state.compactionPending = null;
      // 执行入口之前的拒绝次数：失败后只采信本条提示词中记下的拒绝（8.6d3）。
      const rejectionMark = await agentModelRejectionMark(db, run);
      const deadline = AbortSignal.timeout(Math.max(1, issued.expiresAt.getTime() - Date.now()));
      const execSignal = AbortSignal.any([signal, deadline]);
      let result;
      try {
        result = await runAgentPrompt(
          db,
          driver,
          current,
          run,
          {
            action: 'prompt',
            token: issued.token,
            prompt: input.prompt,
            session: state.session,
            tools: input.tools,
            maxTurns,
            model,
            ...(input.jsonSchemas !== undefined ? { jsonSchemas: input.jsonSchemas } : {}),
          },
          allowedTools,
          { signal: execSignal },
        );
      } catch (error) {
        if (error instanceof TypeError) throw error;
        // 沙箱操作失败（中止 exec 会终止整个沙箱）、入口超时或结果不符合协议：之后只能关闭。
        if (error instanceof SandboxError || (error instanceof JobError && error.code === AGENT_ENTRY_FAILED_CODE)) broken ??= error;
        const explained = await explainFailure(null, error, maxTurns, deadline.aborted, rejectionMark);
        if (explained instanceof JobError && explained.code === AGENT_ENTRY_FAILED_CODE) {
          throw error instanceof SandboxError ? new JobError(AGENT_SANDBOX_FAILED_CODE, SANDBOX_FAILED_MESSAGE, { cause: error }) : error;
        }
        throw explained;
      }
      if (!result.ok) {
        if (result.code === 'RUN_ENDED' && signal.aborted) throw new JobInterruptedError();
        const explained = await explainFailure(result.code, new Error(`agent entry reported ${result.code}`), maxTurns, false, rejectionMark);
        if (!(explained instanceof AgentPromptRetryableError)) broken ??= explained;
        throw explained;
      }
      if (result.action !== 'prompt') throw new JobError(AGENT_ENTRY_FAILED_CODE, 'Agent 入口执行失败');
      state.session = result.session;
      state.promptedStage = input.stage;
      return { turns: result.turns, stopReason: result.stopReason, restored };
    }

    /** 执行一次压缩（compact 与续跑时的补做共用）：pending 已登记在 state 中。 */
    async function runCompaction(pending: AgentCompactionPending, retryNotice = false): Promise<AgentCompactionStatus> {
      assertUsable();
      await context.log(retryNotice ? '上下文压缩未完成，正在重新压缩' : 'Agent 正在压缩上下文', { stage: pending.stage, optional: pending.optional });
      // 还没有会话（没有发出过提示词）：没有可压缩的上下文。
      if (state.session === null) {
        state.compactionPending = null;
        await context.log('当前上下文无需压缩，继续执行下一阶段', { stage: pending.stage });
        return 'noop';
      }
      if (issued.expiresAt.getTime() - Date.now() <= 0) throw timeLimitError(template);
      const rejectionMark = await agentModelRejectionMark(db, run);
      const deadline = AbortSignal.timeout(Math.max(1, issued.expiresAt.getTime() - Date.now()));
      const execSignal = AbortSignal.any([signal, deadline]);
      let result;
      try {
        result = await runAgentCompaction(
          db,
          driver,
          current,
          run,
          { action: 'compact', token: issued.token, session: state.session, instructions: pending.instructions, model },
          options.allowedTools,
          { signal: execSignal },
        );
      } catch (error) {
        if (error instanceof TypeError) throw error;
        if (error instanceof SandboxError || (error instanceof JobError && error.code === AGENT_ENTRY_FAILED_CODE)) broken ??= error;
        const explained = await explainFailure(null, error, 0, deadline.aborted, rejectionMark);
        if (explained instanceof JobError && explained.code === AGENT_ENTRY_FAILED_CODE) {
          throw error instanceof SandboxError ? new JobError(AGENT_SANDBOX_FAILED_CODE, SANDBOX_FAILED_MESSAGE, { cause: error }) : error;
        }
        throw explained;
      }
      if (result.ok) {
        if (result.action !== 'compact') throw new JobError(AGENT_ENTRY_FAILED_CODE, 'Agent 入口执行失败');
        state.compactionPending = null;
        await context.log(result.compacted ? 'Agent 上下文压缩完成' : '当前上下文无需压缩，继续执行下一阶段', { stage: pending.stage });
        return result.compacted ? 'compacted' : 'noop';
      }
      if (result.code === 'RUN_ENDED' && signal.aborted) throw new JobInterruptedError();
      const explained = await explainFailure(result.code, new Error(`agent entry reported ${result.code}`), 0, false, rejectionMark);
      // 数据库中的事实（中止、失败报告、上限、执行已结束、时限、余额不足）优先；之后才看是否可选。
      const tolerable = explained instanceof AgentPromptRetryableError || (explained instanceof JobError && explained.code === AGENT_ENTRY_FAILED_CODE && result.code === 'INTERNAL');
      if (tolerable && OPTIONAL_COMPACTION_TOLERATED.includes(result.code)) {
        if (pending.optional) {
          // 可选压缩只用于缩减上下文：保留登记，按原上下文继续（说明是固定文字，不含入口的输出）。
          await context.log('上下文压缩失败，按原上下文继续', { stage: pending.stage });
          return 'failed';
        }
        const failed = new JobError(AGENT_COMPACTION_FAILED_CODE, COMPACTION_FAILED_MESSAGE, { cause: explained });
        broken ??= failed;
        throw failed;
      }
      if (!(explained instanceof AgentPromptRetryableError)) broken ??= explained;
      throw explained instanceof AgentPromptRetryableError ? explained.jobError : explained;
    }

    async function compact(input: AgentCompactionInput): Promise<AgentCompactionStatus> {
      assertUsable();
      if (!isStage(input.stage)) throw new TypeError('阶段名不合法');
      if (!isCompactionInstructions(input.instructions)) throw new TypeError('压缩指令不合法');
      if (input.optional !== undefined && typeof input.optional !== 'boolean') throw new TypeError('optional 必须是布尔值');
      const pending: AgentCompactionPending = { stage: input.stage, instructions: input.instructions, optional: input.optional === true };
      // 再次压缩同一阶段（例如与程序步骤并行的压缩失败后补做）时说明“重新压缩”。
      const retry = state.compactionPending?.stage === pending.stage;
      state.compactionPending = pending;
      // 任务自己发起了压缩：续跑时不再自动补做。
      resumeCompactionChecked = true;
      if (input.checkpoint) await checkpoint(input.checkpoint.task, input.checkpoint.progress);
      return runCompaction(pending, retry);
    }

    async function assistantText(limits: { maxChars?: number } = {}): Promise<AgentAssistantText | null> {
      assertUsable();
      // 先检查上限（不合法时不读取）。
      const maxChars = agentAssistantTextLimit(limits.maxChars);
      if (state.session === null) return null;
      const path = `pi-sessions/${state.session}`;
      const file = (await readFiles([path], { maxFileBytes: AGENT_SESSION_FILE_READ_MAX_BYTES, maxTotalBytes: AGENT_SESSION_FILE_READ_MAX_BYTES })).get(path);
      if (!file?.data) return null;
      return extractAgentAssistantText(file.data, maxChars);
    }

    async function readFiles(paths: readonly string[], limits: { maxFileBytes?: number; maxTotalBytes?: number } = {}): Promise<ReadonlyMap<string, AgentWorkspaceFile>> {
      assertUsable();
      if (!Array.isArray(paths) || paths.length > AGENT_READ_MAX_FILES) throw new TypeError('一次读取的文件过多');
      const maxFileBytes = limits.maxFileBytes ?? AGENT_READ_FILE_MAX_BYTES;
      const maxTotalBytes = limits.maxTotalBytes ?? AGENT_READ_TOTAL_MAX_BYTES;
      if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0 || maxFileBytes > AGENT_READ_TOTAL_MAX_BYTES || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0 || maxTotalBytes > AGENT_READ_TOTAL_MAX_BYTES) {
        throw new TypeError('读取上限不合法');
      }
      const wanted = new Map<string, string>();
      for (const raw of paths) wanted.set(archivePathKey(normalizeReadPath(raw), READ_LIMITS), normalizeReadPath(raw));
      const result = new Map<string, AgentWorkspaceFile>();
      if (wanted.size === 0) return result;
      let total = 0;
      let currentFile: { path: string; size: number; parts: Buffer[] | null } | null = null;
      const finish = () => {
        if (!currentFile) return;
        result.set(currentFile.path, { size: currentFile.size, data: currentFile.parts ? Buffer.concat(currentFile.parts) : null });
        currentFile = null;
      };
      try {
        const archive = await driver.copyOutArchive(current, { signal });
        await visitArchive(archive.chunks, READ_LIMITS, {
          file(path, size) {
            finish();
            const requested = wanted.get(archivePathKey(path, READ_LIMITS));
            // 只按请求时的写法取（大小写不同的同名文件不算），超过上限的只给大小。
            if (requested === undefined || requested !== path) return;
            const keep = size <= maxFileBytes && total + size <= maxTotalBytes;
            if (keep) total += size;
            currentFile = { path, size, parts: keep ? [] : null };
          },
          data(bytes) {
            currentFile?.parts?.push(Buffer.from(bytes));
          },
        });
        finish();
      } catch (error) {
        if (error instanceof SandboxArchiveError) {
          broken ??= error;
          throw workspaceRejected(error);
        }
        throw sandboxFailure(error);
      }
      return result;
    }

    async function checkpoint(task: Record<string, unknown> | null, progress?: number): Promise<void> {
      assertUsable();
      if (task !== null && !isPlainObject(task)) throw new TypeError('任务的 checkpoint 必须是对象');
      // 快照中的受保护文件须是原件（续跑时从快照中取回原件，8.6c2b）。
      const restored = await restoreProtected();
      await logRestored(restored);
      const agentState = { version: CHECKPOINT_VERSION as typeof CHECKPOINT_VERSION, ...state, baseline: baseline.toState() };
      try {
        // 快照 id 写进现场：续跑与跨任务续用时据此确认放入的快照与会话是同一对（8.7b）。
        const record = await options.workspace.saveCheckpoint(
          current,
          (snapshot) => ({ agent: { ...agentState, snapshot: snapshot.id }, task }) satisfies AgentRunCheckpoint as unknown as Record<string, unknown>,
          progress,
        );
        state.snapshot = record.id;
      } catch (error) {
        // 超出存储配额：任务应立即退出、会话随沙箱结束；工作区被拒绝、过大：任务失败。
        throw sandboxFailure(error);
      }
    }

    function promptInput(stage: AgentPromptInput, text: string, first: boolean): AgentPromptInput {
      const { stage: name, tools, maxTurns, jsonSchemas, stageIndex } = stage;
      return {
        stage: name,
        prompt: text,
        tools,
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(jsonSchemas !== undefined ? { jsonSchemas } : {}),
        ...(first && stageIndex !== undefined ? { stageIndex } : {}),
      };
    }

    async function runStage<V>(stage: AgentStageOptions<V>): Promise<AgentStageResult<V>> {
      const maxRetries = stage.maxExecutionRetries ?? 1;
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > AGENT_MAX_EXECUTION_RETRIES) throw new TypeError('执行重试次数不合法');
      if (typeof stage.outputFile !== 'string') throw new TypeError('结果文件不合法');
      normalizeReadPath(stage.outputFile);
      const policy = createAgentSubmissionPolicy();
      let text = stage.prompt;
      let executionRetries = 0;
      let first = true;
      for (;;) {
        try {
          await prompt(promptInput(stage, text, first));
        } catch (error) {
          if (!(error instanceof AgentPromptRetryableError)) throw error;
          if (executionRetries >= maxRetries) throw error.jobError;
          executionRetries += 1;
          const retry = stage.retryPrompt
            ? await stage.retryPrompt({ reason: error.reason, attempt: executionRetries, maxRetries })
            : buildAgentExecutionRetryPrompt(error.reason, stage.outputFile, executionRetries, maxRetries);
          if (retry === null) throw error.jobError;
          await context.log(`Agent 正在自动重试：${error.reason}`, { stage: stage.stage, attempt: executionRetries, maxRetries });
          text = retry;
          first = false;
          continue;
        }
        first = false;
        if (stage.checkpointAfterPrompt) await checkpoint(stage.checkpointAfterPrompt());
        // 提交校验之前还原被改动的受保护文件（8.6c2b）；还原本身不算校验失败。
        const restored = await restoreProtected();
        await logRestored(restored);
        const report = await stage.validate({ attempt: policy.attempts + 1, restored });
        const decision = policy.inspect(report);
        if (decision.action === 'stop') {
          const blocking = report.issues.filter((issue) => issue.severity === 'blocking').map((issue) => issue.message);
          throw new JobError(AGENT_SUBMISSION_FAILED_CODE, `已按最低完成目标再修复一轮，仍存在阻塞流程的问题，任务已停止：\n${blocking.join('\n')}`);
        }
        if (decision.action === 'accept') {
          if (report.issues.length > 0) {
            await context.log(`仍有 ${report.issues.length} 项质量问题，保留当前结果继续后续流程`, { stage: stage.stage, issues: report.issues.length });
          }
          return { value: report.value, acceptedIssues: report.issues, repairs: policy.attempts, executionRetries };
        }
        const business = stage.repairPrompt
          ? await stage.repairPrompt({ report, mode: decision.mode, attempt: decision.attempt })
          : `本次结果文件：${stage.outputFile}。在当前会话和工作区修复，保留已完成内容。`;
        text = buildAgentSubmissionRepairPrompt(report, decision, [restoredFilesNotice(restored), business].filter(Boolean).join('\n'));
        await context.log(`Agent 正在自动修复（第 ${decision.attempt} 次）`, { stage: stage.stage, attempt: decision.attempt, mode: decision.mode, issues: report.issues.length });
      }
    }

    return {
      sandbox: current,
      baseline,
      resumed: parsed !== null && !continued,
      continued,
      unavailableProtectedFiles: Object.freeze([...unavailable]),
      taskCheckpoint: parsed?.task ?? null,
      get session() {
        return state.session;
      },
      get stage() {
        return state.stage;
      },
      get stageIndex() {
        return state.stageIndex;
      },
      wasPrompted: (stage: string) => isStage(stage) && state.promptedStage === stage,
      get compactionPending() {
        return state.compactionPending;
      },
      compact,
      assistantText,
      readFiles,
      prompt,
      runStage,
      checkpoint,
      close,
    };
  }
}

/**
 * 打开本次执行的 Agent 沙箱并执行 fn，结束（含失败、中止）时销毁沙箱、作废令牌。context.agent 为 null（agent 队列以外的任务、
 * 未登记 agentWorkspace、worker 未配置对象存储或 sandbox-runner）时抛 JobError(AGENT_UNAVAILABLE)。
 */
export async function withAgentRun<T>(agent: JobAgent | null, fn: (run: AgentRun) => Promise<T>, options?: AgentOpenOptions): Promise<T> {
  if (!agent) throw new JobError(AGENT_UNAVAILABLE_CODE, 'Agent 服务暂不可用，请稍后重新发起');
  const run = await agent.open(options);
  try {
    return await fn(run);
  } finally {
    await run.close();
  }
}
