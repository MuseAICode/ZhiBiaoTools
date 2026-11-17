// worker 端的 Agent 执行（路线图第 8 步 8.6d1；docs/SERVER_DESIGN.md 第 7.27 节）。
//
// 桌面版的 piRuntimeService.runTask 在主进程中驱动 Pi 会话；Web 版的 Pi 会话在 agent 沙箱中，由 worker 逐条提示词驱动（#90）：
// 沙箱内的入口每次只执行一条提示词，阶段、提交校验、修复与重试、续跑的现场都在 worker 一侧。执行者给 agent 队列中登记了
// agentWorkspace 的任务提供 context.agent（src/jobs/runner.ts），任务经它：
// - open()：新建沙箱（任务类型登记的模板），为本次执行签发任务令牌（有效期 = 模板的入口墙钟），续跑时放入上次的工作区快照并从
//   checkpoint 重建受保护文件的登记、取回原件（8.5c、8.6c2b）；
// - prompt()：每条提示词之前先还原被改动的受保护文件，再经 runAgentPrompt 执行（先写下本阶段的业务工具，8.6c1）；
// - runStage()：一个阶段的提交校验与修复（与桌面版相同的提交策略，src/agent/submission.ts），执行失败按原因重试；
// - checkpoint()：先还原受保护文件，再经 context.agentWorkspace.saveCheckpoint 保存快照与 checkpoint（会话文件名、阶段、
//   已发出的阶段、受保护文件的登记与任务自己的状态）；超出存储配额时 JobStorageQuotaError，会话随沙箱结束；
// - close()：销毁沙箱、作废令牌（任务在 finally 中调用，withAgentRun 代为调用）。
//
// 入口的结果与失败代码都是沙箱的说法，不被采信：失败后按数据库中的事实判断原因（#92 登记）——本次执行的失败报告（8.4b）、任务的
// 费用与轮数上限（8.3a）、任务是否仍在本次执行中、令牌是否已到期、组织的可用余额；只有这些都不能说明时，才按入口的代码决定
// 是否重试（模型调用失败、连不上平台入口）或失败。给用户看的说明都是固定的文字，不含入口的输出、Agent 写出的内容与文件名。
// 本次执行的墙钟（令牌有效期）在 worker 一侧累计执行：每次执行入口时只给剩余的时间，到期即以 AGENT_TIME_LIMIT 失败。
import type { Kysely } from 'kysely';
import { JOB_MIN_START_BALANCE } from '../db/migrations/0022_job_billing.ts';
import type { Database } from '../db/schema.ts';
import { withOrgContext, type TenantContext } from '../db/tenant.ts';
import { getAvailableBalance } from '../billing/usage.ts';
import {
  JobBalanceExhaustedError,
  JobError,
  JobInterruptedError,
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
import {
  AGENT_ENTRY_FAILED_CODE,
  AGENT_MAX_TURNS_PER_PROMPT,
  runAgentPrompt,
  type AgentEntryErrorCode,
  type AgentPromptTool,
} from './entry.ts';
import { AGENT_REPORTED_FAILURE_CODE, AGENT_REPORTED_FAILURE_FALLBACK_MESSAGE, findAgentFailureReport } from './failureReport.ts';
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

const SANDBOX_FAILED_MESSAGE = 'Agent 沙箱执行失败，任务已停止，请稍后重新发起';
const SESSION_MISSING_MESSAGE = '上次保存的 Agent 会话不可用，请重新发起任务';
const SESSION_INVALID_MESSAGE = 'Agent 会话不可用，任务已停止，请重新发起任务';
/** 模型调用失败与连不上平台入口时给 Agent 与用户看的原因（固定文字，不采信沙箱的说法）。 */
const MODEL_FAILED_REASON = '模型调用失败';
const GATEWAY_FAILED_REASON = '连接平台服务失败';

/** 新建沙箱时 SANDBOX_BUSY / SANDBOX_UNAVAILABLE 的重试间隔（与导出相同的起步值）。 */
export const AGENT_SANDBOX_CREATE_DELAYS_MS: readonly number[] = Object.freeze([5_000, 15_000, 30_000]);

/** checkpoint 中执行者的现场放在这个键下，任务自己的状态在 task 下。 */
const CHECKPOINT_VERSION = 1;
/** 阶段名：任务代码中的常量（与受保护文件的分组名同一规则）。 */
const STAGE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_STAGE_INDEX = 10_000;
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
  /** 受保护文件的登记（8.6c2b 的 toState）。 */
  readonly baseline: AgentWorkspaceBaselineState;
}

export interface AgentRunCheckpoint {
  readonly agent: AgentRunState;
  readonly task: Record<string, unknown> | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const isStage = (value: unknown): value is string => typeof value === 'string' && STAGE_PATTERN.test(value);

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
  if (
    version !== CHECKPOINT_VERSION ||
    (session !== null && (typeof session !== 'string' || !AGENT_SESSION_FILE.test(session))) ||
    (stage !== null && !isStage(stage)) ||
    !Number.isSafeInteger(stageIndex) || (stageIndex as number) < 0 || (stageIndex as number) > MAX_STAGE_INDEX ||
    (promptedStage !== null && !isStage(promptedStage)) ||
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
      baseline: baseline as unknown as AgentWorkspaceBaselineState,
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
  /** 是否从 checkpoint 续跑（放入了上次的工作区快照）。 */
  readonly resumed: boolean;
  /** 续跑后原件仍不可用的受保护文件：任务须重新 baseline.write，否则需要还原时任务失败。 */
  readonly unavailableProtectedFiles: readonly string[];
  /** checkpoint 中任务自己的状态（首次执行为 null）。 */
  readonly taskCheckpoint: Record<string, unknown> | null;
  readonly session: string | null;
  readonly stage: string | null;
  readonly stageIndex: number;
  /** 该阶段的要求是否已在会话中发出（续跑时任务据此只发“继续之前的任务”）。 */
  wasPrompted(stage: string): boolean;
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

/** 任务上下文中的 Agent（context.agent）。 */
export interface JobAgent {
  readonly template: AgentSandboxTemplate;
  /** checkpoint 中是否有执行者的现场（本次执行是续跑）。 */
  readonly resuming: boolean;
  /** 打开本次执行的沙箱与会话；一次执行只能打开一次。 */
  open(): Promise<AgentRun>;
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
    async open(): Promise<AgentRun> {
      if (opened) throw new TypeError('一次执行只能打开一次 Agent 沙箱');
      opened = true;
      return openAgentRun(options, parsed, { db, driver, run, tenant, template, context });
    },
  });
}

async function openAgentRun(
  options: JobAgentOptions,
  parsed: AgentRunCheckpoint | null,
  deps: Pick<JobAgentOptions, 'db' | 'driver' | 'run' | 'tenant' | 'template' | 'context'>,
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
    };
    const allowedTools = options.allowedTools;
    const model = options.model;

    function assertUsable(): void {
      if (closed) throw new TypeError('Agent 沙箱已关闭');
      if (broken) throw broken instanceof JobError || broken instanceof JobStorageQuotaError ? broken : new JobError(AGENT_SANDBOX_FAILED_CODE, SANDBOX_FAILED_MESSAGE, { cause: broken });
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

    /** 失败后按数据库中的事实判断原因（不采信入口的说法）。 */
    async function explainFailure(code: AgentEntryErrorCode | null, cause: unknown, maxTurns: number, deadlinePassed: boolean): Promise<Error> {
      if (signal.aborted) return new JobInterruptedError();
      const facts = await readRunFacts(db, run);
      // 失败报告：finishRun 按数据库中的报告以 AGENT_REPORTED_FAILURE 失败，原因取报告。
      if (facts.failureReported) return new JobError(AGENT_REPORTED_FAILURE_CODE, AGENT_REPORTED_FAILURE_FALLBACK_MESSAGE, { cause });
      if (facts.exhaustedReason) return new JobTaskLimitError(facts.exhaustedReason, { cause });
      if (!facts.running) return new JobInterruptedError();
      if (deadlinePassed || Date.now() >= issued.expiresAt.getTime()) return timeLimitError(template);
      switch (code) {
        case 'MODEL_FAILED': {
          // 余额不足以冻结：可用余额低于最低启动余额时按余额不足暂停（充值后从 checkpoint 续跑）。
          const balance = await getAvailableBalance(db, tenant);
          if (balance.available < JOB_MIN_START_BALANCE) return new JobBalanceExhaustedError({ cause });
          return new AgentPromptRetryableError(MODEL_FAILED_REASON, new JobError(AGENT_MODEL_FAILED_CODE, '模型调用失败，任务已停止，请稍后重新发起', { cause }));
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
      const remaining = issued.expiresAt.getTime() - Date.now();
      if (remaining <= 0) throw timeLimitError(template);
      // 每条提示词之前还原被改动的受保护文件（8.6c2b）。
      const restored = await restoreProtected();
      await logRestored(restored);
      state.stage = input.stage;
      if (input.stageIndex !== undefined) state.stageIndex = input.stageIndex;
      // 续接的会话中，提示词一旦发出就已写进会话文件（即使本条失败）；新建会话失败时会话文件名未知，下一条重新新建。
      if (state.session !== null) state.promptedStage = input.stage;
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
        const explained = await explainFailure(null, error, maxTurns, deadline.aborted);
        if (explained instanceof JobError && explained.code === AGENT_ENTRY_FAILED_CODE) {
          throw error instanceof SandboxError ? new JobError(AGENT_SANDBOX_FAILED_CODE, SANDBOX_FAILED_MESSAGE, { cause: error }) : error;
        }
        throw explained;
      }
      if (!result.ok) {
        if (result.code === 'RUN_ENDED' && signal.aborted) throw new JobInterruptedError();
        const explained = await explainFailure(result.code, new Error(`agent entry reported ${result.code}`), maxTurns, false);
        if (!(explained instanceof AgentPromptRetryableError)) broken ??= explained;
        throw explained;
      }
      if (result.action !== 'prompt') throw new JobError(AGENT_ENTRY_FAILED_CODE, 'Agent 入口执行失败');
      state.session = result.session;
      state.promptedStage = input.stage;
      return { turns: result.turns, stopReason: result.stopReason, restored };
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
      const saved: AgentRunCheckpoint = {
        agent: { version: CHECKPOINT_VERSION, ...state, baseline: baseline.toState() },
        task,
      };
      try {
        await options.workspace.saveCheckpoint(current, saved as unknown as Record<string, unknown>, progress);
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
      resumed: parsed !== null,
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
export async function withAgentRun<T>(agent: JobAgent | null, fn: (run: AgentRun) => Promise<T>): Promise<T> {
  if (!agent) throw new JobError(AGENT_UNAVAILABLE_CODE, 'Agent 服务暂不可用，请稍后重新发起');
  const run = await agent.open();
  try {
    return await fn(run);
  } finally {
    await run.close();
  }
}
