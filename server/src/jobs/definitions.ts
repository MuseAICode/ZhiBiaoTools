// 任务类型的定义与登记（docs/SERVER_DESIGN.md 第 5.2 节）。6.2 只有骨架，业务任务类型由第 6 步各模块的 PR 登记到
// src/jobs/registry.ts；测试用的任务类型在 tests/ 中定义，不进入构建产物。
import type { Kysely } from 'kysely';
import type { ChatDelta, ChatRequest, ChatResult } from '../ai/gateway.ts';
import { isValidAgentTaskLimits, type AgentTaskLimits } from '../agent/budget.ts';
import type { AgentSandboxTemplate, JobAgent } from '../agent/execution.ts';
import type { JobAgentWorkspace } from '../agent/workspaceJob.ts';
import type { AgentBudgetExhaustedReason, Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import type { SandboxDriver } from '../sandbox/driver.ts';
import { JOB_TYPE_PATTERN } from '../db/migrations/0021_jobs.ts';
import { AGENT_TOOL_NAME_PATTERN } from '../db/migrations/0037_agent_tool_calls.ts';
import { AGENT_WORKSPACE_TASK_KIND_PATTERN } from '../db/migrations/0040_agent_workspace_snapshots.ts';

/** BullMQ 队列（第 5.2 节），每个队列在 worker 中单独设置并发。 */
export const JOB_QUEUES = ['parse', 'ai', 'agent', 'export'] as const;
export type JobQueueName = (typeof JOB_QUEUES)[number];

/** 单个 worker 实例中各队列的并发（第 5.2 节、决定事项第 8 项的起步值）。 */
export const DEFAULT_QUEUE_CONCURRENCY: Readonly<Record<JobQueueName, number>> = Object.freeze({
  parse: 4,
  ai: 8,
  agent: 2,
  export: 2,
});

/** 组织级同时运行的任务数（决定事项第 8 项）；超出的留在 queued，空出名额后再认领。 */
export const ORG_RUNNING_JOB_LIMIT = 3;

/**
 * 任务中的模型调用：来源、任务编号和类型由执行者填写，不由任务代码指定。步骤键必填（路线图 6.4a，迁移 0025_job_step_results）：
 * 在本任务内标识“同一次逻辑调用”，取值须在续跑时可以重新算出（如 section:<id>、outline），不能含随机数或时间；
 * 同一任务中不同的调用用不同的键，有意重试（输出不合格再调一次）也要换键（如 section:<id>:try-2）。
 */
export type JobChatRequest = Omit<ChatRequest, 'source' | 'jobId' | 'jobType' | 'stepKey'> & { stepKey: string };

export interface JobAi {
  /**
   * 经 AI 网关调用模型（docs/SERVER_DESIGN.md 第 10 节）：按“组织 + 服务商”的并发上限排队，冻结、结算记到本任务
   * （usage_records.job_id / job_type，jobs.billed_amount）。任务被取消、暂停时随 signal 中止，已产生的用量照常结算。
   * - 余额不足以冻结：抛 JobBalanceExhaustedError，任务应立即退出（不要吞掉这个错误），执行者把任务暂停为
   *   paused / insufficient_balance；充值后继续时从上次的 checkpoint 开始，所以每次调用的结果写入后应保存 checkpoint；
   * - 步骤幂等：完整的调用结果与结算在同一事务中保存。调用已结算、checkpoint 还没保存时 worker 崩溃，续跑时同一步骤键、
   *   同一请求内容的调用直接返回已保存的结果（reused），不再调用服务商、不再扣费；因 worker 关闭、租约丢失而中止的调用
   *   不收费。平台自身故障导致的重复调用不向用户收费；
   * - 网关的其他错误（上游失败、模型停用等）转成 JobError，代码和文案与接口相同（给用户看的），任务可以自行重试或失败；
   * - worker 未配置主密钥（AI_KEK_FILE）时抛 JobError('AI_UNAVAILABLE')。
   */
  chat(request: JobChatRequest, options?: { onDelta?: (delta: ChatDelta) => void }): Promise<ChatResult>;
}

/** 任务执行中可以使用的上下文。 */
export interface JobContext<P> {
  readonly jobId: string;
  readonly projectId: string | null;
  readonly type: string;
  /** 第几次开始执行（从 1 开始）；崩溃恢复后续跑时递增。 */
  readonly attempt: number;
  readonly params: P;
  /** 上次保存的 checkpoint；首次执行为 null。 */
  readonly checkpoint: Record<string, unknown> | null;
  /** 取自任务记录：组织、发起用户，以及该用户当前在组织中的角色（不取自任务参数）。 */
  readonly tenant: TenantContext;
  /** 业务读写经 withTenant(db, tenant, ...)，写入一律经第 5 步的 Store 函数。 */
  readonly db: Kysely<Database>;
  /** 取消、暂停、租约丢失或 worker 关闭时中止；任务应在下一个检查点退出。 */
  readonly signal: AbortSignal;
  /** 更新进度（0~100）。租约已丢失时抛 JobInterruptedError。 */
  setProgress(progress: number): Promise<void>;
  /** 保存 checkpoint（可续跑的任务从这里继续），可同时更新进度。租约已丢失时抛 JobInterruptedError。 */
  saveCheckpoint(checkpoint: Record<string, unknown>, progress?: number): Promise<void>;
  /** 写一条任务日志（job_events，经 SSE 推送）。不要写文档正文和 AI 输入输出全文（第 8.3 节）。 */
  log(message: string, data?: Record<string, unknown>): Promise<void>;
  /** 模型调用（6.4）。 */
  readonly ai: JobAi;
  /** 对象存储（读原件、写产物）；worker 未配置 S3 时为 null。 */
  readonly objectStore: ObjectStore | null;
  /**
   * 解析沙箱（6.6，经 sandbox-runner）；worker 未配置 SANDBOX_RUNNER_URL 时为 null。上传的文件只在沙箱中解析，
   * 任务进程内不运行任何文档解析器。exec 的任何非 0 结果之后都要销毁沙箱，任务在 finally 中 destroy。
   */
  readonly sandbox: SandboxDriver | null;
  /**
   * Agent 工作区快照（8.5c，src/agent/workspaceJob.ts）：任务类型登记了 agentWorkspace、任务属于项目、worker 配置了对象存储与
   * 能整体放入与取回归档的 sandbox-runner 时提供，否则为 null。续跑时 restore 放入上次的快照，检查点经 saveCheckpoint 先保存快照、
   * 再保存 checkpoint；超出组织存储配额时任务暂停为 storage_quota。
   */
  readonly agentWorkspace: JobAgentWorkspace | null;
  /**
   * Agent 执行（8.6d1，src/agent/execution.ts）：agent 队列的任务在 agentWorkspace 可用时提供（新建沙箱、签发令牌、续跑时恢复现场、
   * 逐条提示词执行入口、提交校验与修复、检查点），否则为 null。任务经 withAgentRun 打开，结束时销毁沙箱、作废令牌。
   */
  readonly agent: JobAgent | null;
}

/** Agent 任务的工作区快照登记（8.5c）。 */
export interface AgentWorkspaceRegistration {
  /**
   * 任务类别（迁移 0040 的 task_kind，例如 technical-plan-outline）：每个项目、每个类别只保留最近一次快照。几个任务类型可以登记
   * 同一类别（例如生成与调整共用一个工作区）。
   */
  readonly taskKind: string;
  /** 任务成功完成后保留快照（之后的同类任务还要接着用）；默认成功即丢弃。 */
  readonly keepAfterSuccess?: boolean;
}

export interface JobTypeDefinition<P = unknown> {
  readonly type: string;
  readonly queue: JobQueueName;
  /**
   * 执行者失联（租约过期）后能否从 checkpoint 续跑：true 时回到 queued 由其他 worker 继续，
   * false 时标为失败（JOB_INTERRUPTED）。
   */
  readonly resumable: boolean;
  /** 最多开始执行几次（含崩溃恢复后的续跑），默认 3。 */
  readonly maxAttempts?: number;
  /**
   * 会调用模型（经 context.ai）：入队和从暂停继续前检查组织的可用余额不低于最低启动余额（1 元，迁移 0022_job_billing），
   * 不足时拒绝（402 INSUFFICIENT_BALANCE）。不调用模型的任务（解析、导出、清理）不检查。
   */
  readonly billable?: boolean;
  /**
   * Agent 任务的费用与轮数上限（路线图 8.3a，迁移 0033_agent_job_budgets）：agent 队列的任务类型必须给出（src/agent/budget.ts 的
   * AGENT_TASK_LIMITS），入队时与任务一起写入；其他队列不能给出。
   */
  readonly agentLimits?: AgentTaskLimits;
  /**
   * Agent 任务可以调用的业务工具名（路线图 8.4a，src/agent/tools.ts）：只有 agent 队列的任务类型能给出；沙箱只能调用这里列出的工具，
   * 其余一律 404。worker 启动时检查这些工具都已登记（src/agent/toolRegistry.ts）。
   */
  readonly agentTools?: readonly string[];
  /** Agent 工作区快照（8.5c）：只有 agent 队列的任务类型能登记。 */
  readonly agentWorkspace?: AgentWorkspaceRegistration;
  /**
   * Agent 沙箱的模板（8.6d1）：正文生成、章节重写、原方案还原用 agent-content（墙钟 2 小时），其余默认 agent（30 分钟）。
   * 只有 agent 队列的任务类型能登记。
   */
  readonly agentSandboxTemplate?: AgentSandboxTemplate;
  /** 校验并归一化任务参数（入队时和执行前各一次），不合法时抛错。参数里只放 id 和少量选项。 */
  parseParams(raw: unknown): P;
  run(context: JobContext<P>): Promise<void>;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/** 任务失败时给用户看的原因。其他错误一律记为 JOB_FAILED，内部消息只写日志。 */
export class JobError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JobError';
    this.code = code;
  }
}

/**
 * 调用模型时余额不足以冻结：任务应立即退出，执行者把任务暂停为 paused / insufficient_balance。context.ai 之外（例如 Agent 沙箱中的
 * 模型调用，8.6d1 按可用余额判断）由任务抛出时同样暂停。
 */
export class JobBalanceExhaustedError extends Error {
  constructor(options?: ErrorOptions) {
    super('organization balance is insufficient for the next model call', options);
    this.name = 'JobBalanceExhaustedError';
  }
}

/**
 * 达到任务的费用或轮数上限（8.3a）：任务应立即退出，执行者把任务暂停为 paused / task_cost_limit 或 task_turn_limit，
 * 由发起人或组织管理员确认继续（8.3b）。
 */
export class JobTaskLimitError extends Error {
  readonly reason: AgentBudgetExhaustedReason;

  constructor(reason: AgentBudgetExhaustedReason, options?: ErrorOptions) {
    super(`job reached its ${reason === 'task_cost_limit' ? 'cost' : 'turn'} limit`, options);
    this.name = 'JobTaskLimitError';
    this.reason = reason;
  }
}

/**
 * 保存 Agent 工作区快照时超出组织存储配额（8.5c）：任务应立即退出，执行者把任务暂停为 paused / storage_quota，
 * 用户删除不需要的文件后经普通的“继续”从上一个检查点续跑。
 */
export class JobStorageQuotaError extends Error {
  constructor(options?: ErrorOptions) {
    super('organization storage quota exceeded while saving the agent workspace', options);
    this.name = 'JobStorageQuotaError';
  }
}

/**
 * Agent 沙箱中的模型调用被平台拒绝、原因是组织没有选择模型或所选模型不可用（8.6d3，#98 确认）：任务应立即退出，执行者把任务
 * 暂停为 paused / model_not_configured 或 model_unavailable，用户或管理员在设置中选择可用的模型后经普通的“继续”从上一个检查点续跑。
 */
export class JobModelUnavailableError extends Error {
  readonly reason: 'model_not_configured' | 'model_unavailable';

  constructor(reason: 'model_not_configured' | 'model_unavailable', options?: ErrorOptions) {
    super(reason === 'model_not_configured' ? 'organization has not selected a model' : 'selected model is unavailable', options);
    this.name = 'JobModelUnavailableError';
    this.reason = reason;
  }
}

/** 租约已丢失（被对账收回或任务已被别人结束）：当前执行者的写入不再生效，应立即退出。 */
export class JobInterruptedError extends Error {
  constructor() {
    super('job run is no longer current');
    this.name = 'JobInterruptedError';
  }
}

export interface JobTypeRegistry {
  get(type: string): JobTypeDefinition | undefined;
  readonly types: readonly JobTypeDefinition[];
}

const TYPE_PATTERN = new RegExp(JOB_TYPE_PATTERN);
const TOOL_NAME_PATTERN = new RegExp(AGENT_TOOL_NAME_PATTERN);
const isValidAgentToolName = (name: unknown) => typeof name === 'string' && TOOL_NAME_PATTERN.test(name);
const TASK_KIND_PATTERN = new RegExp(AGENT_WORKSPACE_TASK_KIND_PATTERN);

/**
 * 只能登记其中一个的业务工具：report-failure（8.4b，直接报告失败，供失败交回父 Agent 的任务）与 request-termination
 * （8.4c2，由用户决定是否终止）。两者都登记时被注入的 Agent 可以绕过用户的决定直接结束任务。
 */
export const AGENT_EXCLUSIVE_TOOLS: readonly (readonly string[])[] = [['report-failure', 'request-termination']];

/** agent 队列可用的沙箱模板（与 src/agent/execution.ts 的 AGENT_SANDBOX_TEMPLATES 相同，这里不引入该模块以免循环依赖）。 */
const AGENT_SANDBOX_TEMPLATE_NAMES = ['agent', 'agent-content'] as const;

export function createJobTypeRegistry(definitions: readonly JobTypeDefinition<any>[]): JobTypeRegistry {
  const byType = new Map<string, JobTypeDefinition>();
  for (const definition of definitions) {
    if (!TYPE_PATTERN.test(definition.type)) throw new TypeError(`任务类型名称不合法：${definition.type}`);
    if (!(JOB_QUEUES as readonly string[]).includes(definition.queue)) throw new TypeError(`任务类型 ${definition.type} 的队列不合法`);
    if (byType.has(definition.type)) throw new TypeError(`任务类型重复登记：${definition.type}`);
    // Agent 任务必须有上限（不放行没有上限的 Agent 任务），其他任务不登记上限。
    if ((definition.queue === 'agent') !== (definition.agentLimits !== undefined)) {
      throw new TypeError(`任务类型 ${definition.type}：agent 队列的任务必须给出费用与轮数上限，其他队列不能给出`);
    }
    if (definition.agentLimits !== undefined && !isValidAgentTaskLimits(definition.agentLimits)) {
      throw new TypeError(`任务类型 ${definition.type} 的费用与轮数上限不合法`);
    }
    if (definition.agentTools !== undefined) {
      if (definition.queue !== 'agent') throw new TypeError(`任务类型 ${definition.type}：只有 agent 队列的任务能登记业务工具`);
      const names = definition.agentTools;
      if (!Array.isArray(names) || !names.every(isValidAgentToolName) || new Set(names).size !== names.length) {
        throw new TypeError(`任务类型 ${definition.type} 登记的业务工具不合法`);
      }
      for (const group of AGENT_EXCLUSIVE_TOOLS) {
        if (group.filter((name) => names.includes(name)).length > 1) {
          throw new TypeError(`任务类型 ${definition.type}：业务工具 ${group.join('、')} 只能登记其中一个`);
        }
      }
    }
    if (definition.agentWorkspace !== undefined) {
      if (definition.queue !== 'agent') throw new TypeError(`任务类型 ${definition.type}：只有 agent 队列的任务能登记工作区快照`);
      const { taskKind, keepAfterSuccess } = (definition.agentWorkspace ?? {}) as Partial<AgentWorkspaceRegistration>;
      if (typeof taskKind !== 'string' || !TASK_KIND_PATTERN.test(taskKind) || (keepAfterSuccess !== undefined && typeof keepAfterSuccess !== 'boolean')) {
        throw new TypeError(`任务类型 ${definition.type} 登记的工作区快照不合法`);
      }
    }
    if (definition.agentSandboxTemplate !== undefined) {
      if (definition.queue !== 'agent') throw new TypeError(`任务类型 ${definition.type}：只有 agent 队列的任务能登记 Agent 沙箱模板`);
      if (!(AGENT_SANDBOX_TEMPLATE_NAMES as readonly string[]).includes(definition.agentSandboxTemplate)) {
        throw new TypeError(`任务类型 ${definition.type} 登记的 Agent 沙箱模板不合法`);
      }
    }
    byType.set(definition.type, definition);
  }
  return Object.freeze({ get: (type: string) => byType.get(type), types: Object.freeze([...byType.values()]) });
}

export function maxAttemptsOf(definition: JobTypeDefinition): number {
  return definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
}
