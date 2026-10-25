// 任务类型的定义与登记（docs/SERVER_DESIGN.md 第 5.2 节）。6.2 只有骨架，业务任务类型由第 6 步各模块的 PR 登记到
// src/jobs/registry.ts；测试用的任务类型在 tests/ 中定义，不进入构建产物。
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { JOB_TYPE_PATTERN } from '../db/migrations/0021_jobs.ts';

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

export function createJobTypeRegistry(definitions: readonly JobTypeDefinition<any>[]): JobTypeRegistry {
  const byType = new Map<string, JobTypeDefinition>();
  for (const definition of definitions) {
    if (!TYPE_PATTERN.test(definition.type)) throw new TypeError(`任务类型名称不合法：${definition.type}`);
    if (!(JOB_QUEUES as readonly string[]).includes(definition.queue)) throw new TypeError(`任务类型 ${definition.type} 的队列不合法`);
    if (byType.has(definition.type)) throw new TypeError(`任务类型重复登记：${definition.type}`);
    byType.set(definition.type, definition);
  }
  return Object.freeze({ get: (type: string) => byType.get(type), types: Object.freeze([...byType.values()]) });
}

export function maxAttemptsOf(definition: JobTypeDefinition): number {
  return definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
}
