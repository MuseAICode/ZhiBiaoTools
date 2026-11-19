// jobs / job_events 的读写（迁移 0021_jobs）与任务状态机。jobs 是任务状态的唯一权威，BullMQ 只负责派发（见 src/jobs/queue.ts）。
//
// 状态与转换：
//   queued ──认领──> running ──成功──> succeeded
//     │                │ ├──失败──> failed
//     │                │ ├──请求取消──> cancelling ──执行者退出 / 租约过期──> cancelled
//     │                │ ├──请求暂停（pause_requested）──执行者退出 / 租约过期──> paused
//     │                │ └──执行者失联（租约过期）──> queued（可续跑，从 checkpoint 继续）或 failed（JOB_INTERRUPTED）
//     ├──取消──> cancelled
//     └──暂停──> paused ──继续──> queued；paused ──取消──> cancelled
//   running ──调用模型时余额不足以冻结──> paused（pause_reason = insufficient_balance，6.4）；充值后继续即回到 queued
//   running ──达到 Agent 任务的费用或轮数上限──> paused（pause_reason = task_cost_limit / task_turn_limit，8.3a）；
//     不能经普通的“继续”恢复，须由发起人或组织管理员确认继续（confirmTaskLimit，8.3b）：上限各加一份，回到 queued
//   Agent 任务的组织配额（8.3d，src/agent/quota.ts）：同一组织同时运行的 Agent 任务已满时认领延后（留在 queued 排队）；
//   当日 Agent 运行时长用完时 queued ──认领──> paused、running ──续租时发现──> paused（pause_reason = agent_daily_runtime），
//   次日经普通的“继续”回到 queued；入队与继续时已用完的拒绝（429）
//   running ──保存 Agent 工作区快照时超出组织存储配额──> paused（pause_reason = storage_quota，8.5c）；用户删除文件后经普通的“继续”回到 queued
//   running ──Agent 的模型调用因没有选择模型 / 所选模型不可用被拒绝──> paused（pause_reason = model_not_configured / model_unavailable，
//     8.6d3）；在设置中选择可用的模型后经普通的“继续”回到 queued
//
// 用户发起的操作（新建、查询、取消、暂停、继续）经 withTenant；worker 的系统操作（认领、续租、结束、对账）经 withOrgContext，
// 只设置组织、不代表任何用户。worker 的每一次写入都带 run_id 条件：租约被收回后，原执行者的写入只影响 0 行。
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  JOB_ACTIVE_STATUSES,
  JOB_CHECKPOINT_MAX_BYTES,
  JOB_DISPATCH_BATCH_MAX,
  JOB_ERROR_MESSAGE_MAX_LENGTH,
  JOB_EVENT_DATA_MAX_BYTES,
  JOB_EVENT_MESSAGE_MAX_LENGTH,
  JOB_FINAL_STATUSES,
  JOB_LOCK_KEY_MAX_LENGTH,
  JOB_PARAMS_MAX_BYTES,
} from '../db/migrations/0021_jobs.ts';
import type { AgentBudgetExhaustedReason, Database, JobEventKind, JobPauseReason, JobsTable, JobStatus, MemberRole } from '../db/schema.ts';
import { insertAgentJobBudget, type AgentTaskLimits } from '../agent/budget.ts';
import { AGENT_REPORTED_FAILURE_CODE, AGENT_REPORTED_FAILURE_FALLBACK_MESSAGE, findAgentFailureReport } from '../agent/failureReport.ts';
import {
  AGENT_DAILY_RUNTIME_PAUSE_REASON,
  assertAgentDailyRuntimeAvailable,
  closeLostAgentJobRun,
  endAgentJobRun,
  isAgentDailyRuntimeExhausted,
  isAgentJob,
  shouldDeferAgentClaim,
  startAgentJobRun,
  touchAgentJobRun,
  type AgentQuotaOptions,
} from '../agent/quota.ts';
import { assertJobStartBalance } from '../billing/usage.ts';
import {
  AGENT_QUESTION_ANSWER_ROLES,
  AGENT_QUESTION_TIMEOUT_SECONDS,
  AGENT_WAITING_FOR_USER_PAUSE_REASON,
  findPendingAgentQuestion,
  hasExpiredAgentQuestion,
  isWaitingForUserReason,
  normalizeAgentCustomAnswer,
} from '../agent/questions.ts';
import { AGENT_BUDGET_EXHAUSTED_REASONS, AGENT_BUDGET_MAX_COST_LIMIT, AGENT_BUDGET_MAX_TURN_LIMIT } from '../db/migrations/0033_agent_job_budgets.ts';
import { AGENT_BUDGET_CONFIRM_ROLES } from '../db/migrations/0034_agent_job_budget_confirm.ts';
import { UNITS_PER_YUAN } from '../billing/ledger.ts';
import { STORAGE_QUOTA_PAUSE_REASON } from '../db/migrations/0041_job_pause_storage_quota.ts';
import { WAITING_FOR_SELECTION_PAUSE_REASON } from '../db/migrations/0044_job_pause_selection.ts';
import { withOrgContext, withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { serializeJsonObject } from '../jsonObject.ts';

export interface JobRecord {
  id: string;
  orgId: string;
  projectId: string | null;
  userId: string;
  type: string;
  lockKey: string | null;
  status: JobStatus;
  pauseRequested: boolean;
  progress: number;
  params: Record<string, unknown>;
  checkpoint: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempt: number;
  /**
   * 暂停原因：insufficient_balance（运行中余额不足，6.4）、task_cost_limit / task_turn_limit（达到任务上限，8.3a）、agent_daily_runtime（8.3d）、
   * waiting_for_user（8.4c1）、storage_quota（保存工作区快照时存储配额已满，8.5c）、model_not_configured / model_unavailable
   * （Agent 的模型调用因没有选择模型 / 所选模型不可用被拒绝，8.6d3）；用户手动暂停时为 null。
   */
  pauseReason: JobPauseReason | null;
  /** 本任务已扣费的合计（计费单位），在结算的同一事务中累加。 */
  billedAmount: bigint;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface JobEventRecord {
  id: string;
  kind: JobEventKind;
  message: string | null;
  data: Record<string, unknown> | null;
  createdAt: Date;
}

type JobRow = Selectable<JobsTable>;
type Trx = Transaction<Database>;

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    userId: row.user_id,
    type: row.type,
    lockKey: row.lock_key,
    status: row.status,
    pauseRequested: row.pause_requested,
    progress: row.progress,
    params: row.params,
    checkpoint: row.checkpoint,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attempt: row.attempt,
    pauseReason: row.pause_reason,
    billedAmount: BigInt(row.billed_amount),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function isFinalStatus(status: JobStatus): boolean {
  return (JOB_FINAL_STATUSES as readonly string[]).includes(status);
}

function serialize(value: Record<string, unknown>, maxBytes: number, what: string): string {
  const json = serializeJsonObject(value, maxBytes);
  if (json === 'too-deep' || json === 'too-large') throw new TypeError(`${what}过大或嵌套过深`);
  return json;
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

async function appendEvent(
  trx: Trx,
  job: { orgId: string; id: string },
  kind: JobEventKind,
  message: string | null = null,
  data: Record<string, unknown> | null = null,
): Promise<JobEventRecord> {
  const row = await trx
    .insertInto('job_events')
    .values({
      org_id: job.orgId,
      job_id: job.id,
      kind,
      message: message === null || message === '' ? null : truncate(message, JOB_EVENT_MESSAGE_MAX_LENGTH),
      data: data ? serialize(data, JOB_EVENT_DATA_MAX_BYTES, '任务事件数据') : null,
    })
    .returning(['id', 'kind', 'message', 'data', 'created_at'])
    .executeTakeFirstOrThrow();
  return { id: String(row.id), kind: row.kind, message: row.message, data: row.data, createdAt: row.created_at };
}

function jobNotFound(): AppError {
  return new AppError(404, 'JOB_NOT_FOUND', '任务不存在');
}

function jobFinished(): AppError {
  return new AppError(409, 'JOB_FINISHED', '任务已结束');
}

// ---------------------------------------------------------------------------------------------------------------
// 用户发起的操作（withTenant）
// ---------------------------------------------------------------------------------------------------------------

export interface NewJob {
  type: string;
  projectId?: string | null;
  /** 互斥键（例如 project:{projectId}:technical-plan）；为 null 时不互斥。 */
  lockKey?: string | null;
  params: Record<string, unknown>;
  /** 入队前检查最低启动余额（会调用模型的任务类型，见 JobTypeDefinition.billable）。 */
  checkBalance?: boolean;
  /**
   * 取代排队中的旧任务（模板样张 7.3d，对应桌面版“新请求取代旧请求”）：在新建的同一事务中，把本用户同一类型、仍是 queued 的
   * 任务改为 cancelled；运行中（running / cancelling）与暂停的不动。同一组织、用户、类型的这类入队用事务级 advisory lock 串行，
   * 并发入队时每个事务都看得到之前提交的任务，结果总是只有最后提交的一个仍在排队。不用 lock_key（运行中的旧任务会使新请求 409）。
   */
  supersedeQueued?: boolean;
  /** Agent 任务的费用与轮数上限（JobTypeDefinition.agentLimits），与任务在同一事务中写入。 */
  agentLimits?: AgentTaskLimits | null;
  /** Agent 任务的组织配额（8.3d）：给出 agentLimits 时，当日运行时长已用完则拒绝入队（429）。默认取 src/agent/quota.ts 的常量。 */
  agentQuota?: AgentQuotaOptions;
}

export interface InsertedJob {
  job: JobRecord;
  /** 被取代（改为 cancelled）的排队中任务。 */
  superseded: JobRecord[];
}

/**
 * 新建任务（status = 'queued'），同一事务内写 queued 事件。lock_key 相同的未结束任务已存在时抛 409 JOB_LOCKED
 * （部分唯一索引兜底，并发入队也只有一个成功）。只写数据库，不放进 BullMQ（见 src/jobs/service.ts 的 enqueueJob）。
 */
export async function insertJob(db: Kysely<Database>, context: TenantContext, input: NewJob): Promise<JobRecord> {
  return (await insertJobSuperseding(db, context, input)).job;
}

/** 同 insertJob，另返回被取代的排队中任务（NewJob.supersedeQueued）。 */
export async function insertJobSuperseding(db: Kysely<Database>, context: TenantContext, input: NewJob): Promise<InsertedJob> {
  if (input.lockKey !== undefined && input.lockKey !== null && (input.lockKey.length === 0 || input.lockKey.length > JOB_LOCK_KEY_MAX_LENGTH)) {
    throw new TypeError('lockKey 长度不合法');
  }
  const params = serialize(input.params, JOB_PARAMS_MAX_BYTES, '任务参数');
  try {
    return await withTenant(db, context, async (trx) => {
      if (input.checkBalance) await assertJobStartBalance(trx);
      if (input.supersedeQueued) {
        await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`jobs_supersede:${context.orgId}:${context.userId}:${input.type}`}, 0))`.execute(trx);
      }
      const row = await trx
        .insertInto('jobs')
        .values({
          org_id: context.orgId,
          project_id: input.projectId ?? null,
          user_id: context.userId,
          type: input.type,
          lock_key: input.lockKey ?? null,
          params,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const job = toRecord(row);
      if (input.agentLimits) {
        await assertAgentDailyRuntimeAvailable(trx, context.orgId, input.agentQuota);
        await insertAgentJobBudget(trx, job, input.agentLimits);
      }
      await appendEvent(trx, job, 'queued', null, { userId: context.userId });
      const superseded: JobRecord[] = [];
      if (input.supersedeQueued) {
        const rows = await trx
          .updateTable('jobs')
          .set({ status: 'cancelled', pause_reason: null, finished_at: sql<Date>`now()` })
          .where('user_id', '=', context.userId)
          .where('type', '=', input.type)
          .where('status', '=', 'queued')
          .where('id', '!=', job.id)
          .returningAll()
          .execute();
        for (const cancelled of rows) {
          const record = toRecord(cancelled);
          await appendEvent(trx, record, 'cancelled', null, { userId: context.userId, supersededBy: job.id });
          superseded.push(record);
        }
      }
      return { job, superseded };
    });
  } catch (error) {
    const pgError = error as { code?: unknown; constraint?: unknown } | null;
    if (pgError?.code === '23505' && pgError.constraint === 'jobs_org_id_lock_key_active_key') {
      throw new AppError(409, 'JOB_LOCKED', '已有同类任务正在进行，请等待其结束或先取消', { cause: error });
    }
    throw error;
  }
}

export async function findJob(db: Kysely<Database>, context: TenantContext, jobId: string): Promise<JobRecord | null> {
  const row = await withTenant(db, context, (trx) => trx.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirst());
  return row ? toRecord(row) : null;
}

export interface ListJobsOptions {
  projectId?: string;
  /** 只列这个互斥键的任务（组织级任务按对象查找，例如 knowledge-document:{documentId}）。 */
  lockKey?: string;
  /** true 只列未结束的任务，false 只列已结束的，不传列全部。 */
  active?: boolean;
  limit: number;
}

export async function listJobs(db: Kysely<Database>, context: TenantContext, options: ListJobsOptions): Promise<JobRecord[]> {
  const rows = await withTenant(db, context, (trx) => {
    let query = trx.selectFrom('jobs').selectAll();
    if (options.projectId !== undefined) query = query.where('project_id', '=', options.projectId);
    if (options.lockKey !== undefined) query = query.where('lock_key', '=', options.lockKey);
    if (options.active === true) query = query.where('status', 'in', JOB_ACTIVE_STATUSES);
    if (options.active === false) query = query.where('status', 'in', JOB_FINAL_STATUSES);
    return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit).execute();
  });
  return rows.map(toRecord);
}

/**
 * 在已设置上下文的事务中读取项目下每种任务类型最近的一个任务（各业务模块的 loadState 类接口返回任务状态用，取代桌面版
 * 各模块的 *_tasks 表）。没有的类型不出现在结果中。
 */
export async function latestProjectJobs(trx: Trx, projectId: string, types: readonly string[]): Promise<Map<string, JobRecord>> {
  if (types.length === 0) return new Map();
  const rows = await trx
    .selectFrom('jobs')
    .selectAll()
    .distinctOn('type')
    .where('project_id', '=', projectId)
    .where('type', 'in', [...types])
    .orderBy('type')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return new Map(rows.map((row) => [row.type, toRecord(row)]));
}

/**
 * 在已设置上下文的事务中读取每个互斥键最近的一个任务（组织级任务按对象返回任务状态用，例如知识库文档）。lockKeyPrefix 以 ':' 结尾，
 * 结果的键是互斥键中前缀之后的部分（对象 id）；给出 ids 时只读这些对象。没有任务的对象不出现在结果中。
 */
export async function latestLockKeyJobs(
  trx: Trx,
  lockKeyPrefix: string,
  types: readonly string[],
  ids?: readonly string[],
): Promise<Map<string, JobRecord>> {
  if (types.length === 0 || (ids && ids.length === 0)) return new Map();
  if (!lockKeyPrefix.endsWith(':') || /[%_\\]/.test(lockKeyPrefix)) throw new TypeError('lockKeyPrefix 不合法');
  let query = trx.selectFrom('jobs').selectAll().distinctOn('lock_key').where('type', 'in', [...types]);
  query = ids ? query.where('lock_key', 'in', ids.map((id) => `${lockKeyPrefix}${id}`)) : query.where('lock_key', 'like', `${lockKeyPrefix}%`);
  const rows = await query
    .orderBy('lock_key')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return new Map(rows.map((row) => [row.lock_key!.slice(lockKeyPrefix.length), toRecord(row)]));
}

export async function listJobEvents(
  db: Kysely<Database>,
  context: TenantContext,
  jobId: string,
  limit: number,
): Promise<JobEventRecord[]> {
  const rows = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('job_events')
      .select(['id', 'kind', 'message', 'data', 'created_at'])
      .where('job_id', '=', jobId)
      .orderBy('id', 'desc')
      .limit(limit)
      .execute(),
  );
  return rows.reverse().map((row) => ({ id: String(row.id), kind: row.kind, message: row.message, data: row.data, createdAt: row.created_at }));
}

async function lockJob(trx: Trx, jobId: string): Promise<JobRow | undefined> {
  return trx.selectFrom('jobs').selectAll().where('id', '=', jobId).forUpdate().executeTakeFirst();
}

export interface JobChange {
  job: JobRecord;
  /** 状态变成了 queued，需要放进 BullMQ。 */
  dispatch: boolean;
}

/**
 * 取消：queued / paused 立即变为 cancelled；running 变为 cancelling，执行者在下一个检查点退出后变为 cancelled
 * （执行者失联时由对账在租约过期后收尾）。已在取消中时原样返回；已结束时抛 409 JOB_FINISHED。
 */
export async function requestCancel(db: Kysely<Database>, context: TenantContext, jobId: string): Promise<JobChange> {
  return withTenant(db, context, async (trx) => {
    const row = await lockJob(trx, jobId);
    if (!row) throw jobNotFound();
    if (isFinalStatus(row.status)) throw jobFinished();
    if (row.status === 'cancelling') return { job: toRecord(row), dispatch: false };
    const update =
      row.status === 'running'
        ? { status: 'cancelling' as const, pause_requested: false }
        : { status: 'cancelled' as const, pause_reason: null, finished_at: sql<Date>`now()` };
    const updated = await trx.updateTable('jobs').set(update).where('id', '=', jobId).returningAll().executeTakeFirstOrThrow();
    const job = toRecord(updated);
    await appendEvent(trx, job, job.status === 'cancelled' ? 'cancelled' : 'cancel-requested', null, { userId: context.userId });
    return { job, dispatch: false };
  });
}

/**
 * 暂停：queued 立即变为 paused；running 只记下 pause_requested，执行者在下一个检查点保存 checkpoint 后退出，变为 paused。
 * 已暂停或取消中时原样返回；已结束时抛 409 JOB_FINISHED。
 */
export async function requestPause(db: Kysely<Database>, context: TenantContext, jobId: string): Promise<JobChange> {
  return withTenant(db, context, async (trx) => {
    const row = await lockJob(trx, jobId);
    if (!row) throw jobNotFound();
    if (isFinalStatus(row.status)) throw jobFinished();
    if (row.status === 'paused' || row.status === 'cancelling' || row.pause_requested) return { job: toRecord(row), dispatch: false };
    const update = row.status === 'running' ? { pause_requested: true } : { status: 'paused' as const };
    const updated = await trx.updateTable('jobs').set(update).where('id', '=', jobId).returningAll().executeTakeFirstOrThrow();
    const job = toRecord(updated);
    await appendEvent(trx, job, job.status === 'paused' ? 'paused' : 'pause-requested', null, { userId: context.userId });
    return { job, dispatch: false };
  });
}

/**
 * 继续：paused 变回 queued（需要重新派发），清除暂停原因；running 且已请求暂停时撤销暂停请求。其他未结束状态原样返回；
 * 已结束时抛 409。会调用模型的任务类型（checkBalance 返回 true）从 paused 继续前检查最低启动余额，不足时抛 402、任务仍是 paused。
 * Agent 任务从 paused 继续前检查组织当日的运行时长（8.3d），已用完时抛 429、任务仍是 paused。
 */
export async function requestResume(
  db: Kysely<Database>,
  context: TenantContext,
  jobId: string,
  checkBalance: (type: string) => boolean = () => false,
  agentQuota?: AgentQuotaOptions,
): Promise<JobChange> {
  return withTenant(db, context, async (trx) => {
    const row = await lockJob(trx, jobId);
    if (!row) throw jobNotFound();
    if (isFinalStatus(row.status)) throw jobFinished();
    if (row.status === 'paused') {
      // 达到任务上限而暂停的：只能由发起人或组织管理员确认继续（8.3b，确认时增加一份额度），普通的继续不放行。
      if (isTaskLimitReason(row.pause_reason)) {
        throw new AppError(409, 'JOB_TASK_LIMIT_CONFIRM_REQUIRED', '任务已达到费用或调用次数上限，需由发起人或组织管理员确认后继续');
      }
      // 等待用户确认选择而暂停的（8.7e1）：只能经该任务类型的确认接口继续（confirmJobSelection，选择写进 checkpoint）。
      if (row.pause_reason === WAITING_FOR_SELECTION_PAUSE_REASON) {
        throw new AppError(409, 'JOB_SELECTION_REQUIRED', '任务正在等待确认，确认后会自动继续');
      }
      // 等待回答超时而暂停的（8.4c1）：问题仍在等待时须先回答（回答后自动继续）；问题已不在等待（暂停前刚好被回答）时照常继续。
      if (isWaitingForUserReason(row.pause_reason) && (await findPendingAgentQuestion(trx, jobId)) !== null) {
        throw new AppError(409, 'JOB_ANSWER_REQUIRED', '任务正在等待回答 Agent 的问题，回答后会自动继续');
      }
      if (checkBalance(row.type)) await assertJobStartBalance(trx);
      if (await isAgentJob(trx, jobId)) await assertAgentDailyRuntimeAvailable(trx, context.orgId, agentQuota);
      const updated = await trx
        .updateTable('jobs')
        .set({ status: 'queued', pause_reason: null })
        .where('id', '=', jobId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const job = toRecord(updated);
      await appendEvent(trx, job, 'resumed', null, { userId: context.userId });
      return { job, dispatch: true };
    }
    if (row.status === 'running' && row.pause_requested) {
      const updated = await trx.updateTable('jobs').set({ pause_requested: false }).where('id', '=', jobId).returningAll().executeTakeFirstOrThrow();
      const job = toRecord(updated);
      await appendEvent(trx, job, 'resumed', null, { userId: context.userId });
      return { job, dispatch: false };
    }
    return { job: toRecord(row), dispatch: false };
  });
}

export interface AgentAnswerInput {
  questionId: string;
  /** 选项序号（从 0 开始）。 */
  optionIndex: number;
  /** 选了“自定义输入”的选项时必填，其他选项不能给出。 */
  customAnswer?: string;
}

export interface AnswerChange extends JobChange {
  questionId: string;
}

/**
 * 回答 Agent 的问题（ask-user，8.4c1，迁移 0039_agent_questions）：限任务发起人或组织的 owner / admin（数据库触发器再检查一次）。
 * 问题须是本任务等待回答中的问题；任务已结束 409。任务因等待回答超时暂停（waiting_for_user）时，回答后任务回到 queued（需要派发），
 * 继续前照常检查最低启动余额与当日运行时长，不足时 402 / 429、什么都不改（问题仍在等待）。任务执行中时只记下回答，等待中的
 * ask-user 调用随即取回。
 */
export async function answerAgentQuestion(
  db: Kysely<Database>,
  context: TenantContext,
  jobId: string,
  input: AgentAnswerInput,
  checkBalance: (type: string) => boolean = () => false,
  agentQuota?: AgentQuotaOptions,
): Promise<AnswerChange> {
  return withTenant(db, context, async (trx) => {
    const row = await lockJob(trx, jobId);
    if (!row) throw jobNotFound();
    if (isFinalStatus(row.status) || row.status === 'cancelling') throw jobFinished();
    if (row.user_id !== context.userId && !(AGENT_QUESTION_ANSWER_ROLES as readonly string[]).includes(context.role)) {
      throw new AppError(403, 'JOB_ANSWER_FORBIDDEN', '只有任务发起人或组织管理员可以回答');
    }
    const question = await trx
      .selectFrom('agent_questions')
      .select(['id', 'status', 'options'])
      .where('id', '=', input.questionId)
      .where('job_id', '=', jobId)
      .forUpdate()
      .executeTakeFirst();
    if (!question) throw new AppError(404, 'AGENT_QUESTION_NOT_FOUND', '问题不存在');
    if (question.status !== 'pending') throw new AppError(409, 'AGENT_QUESTION_NOT_PENDING', '该问题已回答或已失效');
    const option = question.options[input.optionIndex];
    if (!option) throw new AppError(400, 'AGENT_ANSWER_INVALID', '请选择一个有效选项');
    let answerText: string | null = null;
    if (option.custom) {
      answerText = normalizeAgentCustomAnswer(input.customAnswer ?? '');
      if (answerText.length === 0) throw new AppError(400, 'AGENT_ANSWER_INVALID', '请输入具体要求');
    } else if (input.customAnswer !== undefined) {
      throw new AppError(400, 'AGENT_ANSWER_INVALID', '该选项不需要输入具体要求');
    }
    const resume = row.status === 'paused' && isWaitingForUserReason(row.pause_reason);
    if (resume) {
      if (checkBalance(row.type)) await assertJobStartBalance(trx);
      if (await isAgentJob(trx, jobId)) await assertAgentDailyRuntimeAvailable(trx, context.orgId, agentQuota);
    }
    await trx.updateTable('agent_questions').set({ status: 'answered', answer_option: input.optionIndex, answer_text: answerText }).where('id', '=', question.id).execute();
    if (!resume) {
      await appendEvent(trx, toRecord(row), 'log', '已回答 Agent 的问题', { questionId: question.id, userId: context.userId });
      return { job: toRecord(row), dispatch: false, questionId: question.id };
    }
    const updated = await trx.updateTable('jobs').set({ status: 'queued', pause_reason: null }).where('id', '=', jobId).returningAll().executeTakeFirstOrThrow();
    const job = toRecord(updated);
    await appendEvent(trx, job, 'resumed', '已回答 Agent 的问题，任务继续', { questionId: question.id, userId: context.userId });
    return { job, dispatch: true, questionId: question.id };
  });
}

export interface JobSelectionInput {
  /** 任务所属的项目与任务类型（确认接口按业务分开，不是这个项目、这个类型的任务按不存在处理）。 */
  projectId: string;
  type: string;
  /**
   * 按 checkpoint 中待确认的内容校验用户的选择，返回写进任务的新 checkpoint（在任务行加锁之后调用）。选择不合法时抛 AppError（400），
   * checkpoint 中没有待确认的内容时抛 AppError（409）；什么都不改。
   */
  apply(checkpoint: Record<string, unknown> | null): Record<string, unknown>;
}

/**
 * 确认任务等待的选择（8.7e1，迁移 0044_job_pause_selection；例如技术方案目录生成的一级目录确认）：任务须因等待确认而暂停
 * （waiting_for_selection），否则 409 JOB_SELECTION_NOT_PENDING；限任务发起人或组织的 owner / admin（与回答 Agent 的问题相同）。
 * 选择由 input.apply 校验并写进 checkpoint，任务回到 queued（需要派发），续跑时任务从 checkpoint 取回选择并再次校验。继续前照常
 * 检查最低启动余额与当日运行时长，不足时 402 / 429、什么都不改（仍在等待确认）。任务行先加锁，并发确认只有第一个生效。
 */
export async function confirmJobSelection(
  db: Kysely<Database>,
  context: TenantContext,
  jobId: string,
  input: JobSelectionInput,
  checkBalance: (type: string) => boolean = () => false,
  agentQuota?: AgentQuotaOptions,
): Promise<JobChange> {
  return withTenant(db, context, async (trx) => {
    const row = await lockJob(trx, jobId);
    if (!row || row.project_id !== input.projectId || row.type !== input.type) throw jobNotFound();
    if (isFinalStatus(row.status)) throw jobFinished();
    if (row.status !== 'paused' || row.pause_reason !== WAITING_FOR_SELECTION_PAUSE_REASON) {
      throw new AppError(409, 'JOB_SELECTION_NOT_PENDING', '任务当前不在等待确认的状态');
    }
    if (row.user_id !== context.userId && !(AGENT_QUESTION_ANSWER_ROLES as readonly string[]).includes(context.role)) {
      throw new AppError(403, 'JOB_SELECTION_FORBIDDEN', '只有任务发起人或组织管理员可以确认');
    }
    const checkpoint = serialize(input.apply(row.checkpoint), JOB_CHECKPOINT_MAX_BYTES, 'checkpoint');
    if (checkBalance(row.type)) await assertJobStartBalance(trx);
    if (await isAgentJob(trx, jobId)) await assertAgentDailyRuntimeAvailable(trx, context.orgId, agentQuota);
    const updated = await trx
      .updateTable('jobs')
      .set({ status: 'queued', pause_reason: null, checkpoint })
      .where('id', '=', jobId)
      .returningAll()
      .executeTakeFirstOrThrow();
    const job = toRecord(updated);
    await appendEvent(trx, job, 'resumed', '已确认，任务继续', { userId: context.userId });
    return { job, dispatch: true };
  });
}

/** 计费单位 → “x.xx 元”（最多 4 位小数，去掉末尾的 0）。 */
function formatYuan(units: bigint): string {
  const negative = units < 0n;
  const value = negative ? -units : units;
  const fraction = (value % UNITS_PER_YUAN).toString().padStart(4, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${value / UNITS_PER_YUAN}${fraction ? `.${fraction}` : ''} 元`;
}

/**
 * 达到费用或轮数上限后确认继续（8.3b，迁移 0034_agent_job_budget_confirm）：任务因上限暂停时，由任务发起人或组织的 owner / admin
 * 确认，上限各加一份（与入队时的上限相同）、清除达到上限的原因，任务回到 queued（需要重新派发）。继续前照常检查最低启动余额，
 * 不足时 402、什么都不改。确认记录（确认人、已花费金额、之前与新的上限）写入 resumed 事件。
 *
 * 任务行先加锁，并发确认只有第一个生效，之后的看到任务已不是因上限暂停，409 JOB_NOT_LIMIT_PAUSED；数据库守卫另外限定
 * “一次达到上限只能加一份”和确认人（AB001），不依赖这里的检查。
 */
export async function confirmTaskLimit(
  db: Kysely<Database>,
  context: TenantContext,
  jobId: string,
  agentQuota?: AgentQuotaOptions,
): Promise<JobChange> {
  return withTenant(db, context, async (trx) => {
    const row = await lockJob(trx, jobId);
    if (!row) throw jobNotFound();
    if (isFinalStatus(row.status)) throw jobFinished();
    if (row.status !== 'paused' || !isTaskLimitReason(row.pause_reason)) {
      throw new AppError(409, 'JOB_NOT_LIMIT_PAUSED', '任务不是因达到费用或调用次数上限而暂停，不需要确认');
    }
    if (row.user_id !== context.userId && !(AGENT_BUDGET_CONFIRM_ROLES as readonly string[]).includes(context.role)) {
      throw new AppError(403, 'JOB_CONFIRM_FORBIDDEN', '只有任务发起人或组织管理员可以确认继续');
    }
    const budget = await trx.selectFrom('agent_job_budgets').selectAll().where('job_id', '=', jobId).forUpdate().executeTakeFirst();
    if (!budget) throw new AppError(409, 'AGENT_BUDGET_MISSING', '任务没有登记费用与轮数上限');
    const costLimit = BigInt(budget.cost_limit) + BigInt(budget.cost_step);
    const turnLimit = budget.turn_limit + budget.turn_step;
    if (costLimit > AGENT_BUDGET_MAX_COST_LIMIT || turnLimit > AGENT_BUDGET_MAX_TURN_LIMIT) {
      throw new AppError(409, 'TASK_LIMIT_MAX_REACHED', '本任务的费用或调用次数已达到可确认的最高上限，不能再继续，请取消后重新发起');
    }
    // 达到上限的任务都调用模型：继续前一律检查最低启动余额；当日 Agent 运行时长用完时同样不能继续（8.3d）。
    await assertJobStartBalance(trx);
    await assertAgentDailyRuntimeAvailable(trx, context.orgId, agentQuota);
    await trx
      .updateTable('agent_job_budgets')
      .set({ cost_limit: costLimit.toString(), turn_limit: turnLimit, confirmations: budget.confirmations + 1, exhausted_reason: null })
      .where('job_id', '=', jobId)
      .execute();
    const updated = await trx
      .updateTable('jobs')
      .set({ status: 'queued', pause_reason: null })
      .where('id', '=', jobId)
      .returningAll()
      .executeTakeFirstOrThrow();
    const job = toRecord(updated);
    const billed = BigInt(row.billed_amount);
    await appendEvent(
      trx,
      job,
      'resumed',
      `已确认继续：本任务已花费 ${formatYuan(billed)}，费用上限调整为 ${formatYuan(costLimit)}、调用次数上限调整为 ${turnLimit} 次`,
      {
        userId: context.userId,
        confirmedReason: row.pause_reason,
        billedAmount: billed.toString(),
        turnsUsed: budget.turns_used,
        previousCostLimit: budget.cost_limit,
        costLimit: costLimit.toString(),
        previousTurnLimit: budget.turn_limit,
        turnLimit,
        confirmations: budget.confirmations + 1,
      },
    );
    return { job, dispatch: true };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// worker 的系统操作（withOrgContext，带 run_id 的隔离条件）
// ---------------------------------------------------------------------------------------------------------------

export interface ClaimOptions {
  orgId: string;
  jobId: string;
  runId: string;
  leaseMs: number;
  /** 组织级同时运行的任务数上限。 */
  orgRunningLimit: number;
  /** 任务类型是否已登记，以及最多开始执行几次；未登记时返回 null。 */
  attemptsFor: (type: string) => number | null;
  /** Agent 任务的组织配额（8.3d），默认取 src/agent/quota.ts 的常量。 */
  agentQuota?: AgentQuotaOptions;
}

export type ClaimResult =
  | { kind: 'claimed'; job: JobRecord; role: MemberRole }
  /** 组织已有 orgRunningLimit 个任务（Agent 任务另有组织并发上限，且按入队时间排队）在运行，留在 queued，稍后再试。 */
  | { kind: 'deferred' }
  /**
   * 任务不存在、不是 queued（已被认领、已暂停、已结束），或认领时判定失败、或因组织当日 Agent 运行时长用完而暂停（paused，8.3d）；
   * 本次派发作废。
   */
  | { kind: 'skipped'; reason: 'missing' | 'not-queued' | 'failed' | 'paused' };

async function failInTrx(trx: Trx, row: JobRow, code: string, message: string): Promise<void> {
  const updated = await trx
    .updateTable('jobs')
    .set({
      status: 'failed',
      pause_requested: false,
      run_id: null,
      lease_expires_at: null,
      error_code: code,
      error_message: truncate(message, JOB_ERROR_MESSAGE_MAX_LENGTH),
      finished_at: sql<Date>`now()`,
    })
    .where('id', '=', row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await appendEvent(trx, toRecord(updated), 'failed', null, { code });
}

function leaseInterval(leaseMs: number) {
  return sql<Date>`now() + make_interval(secs => ${leaseMs / 1000})`;
}

/**
 * 认领：同一组织的认领串行（咨询锁），只有 queued 的任务能被认领，所以同一任务被派发多次也只执行一次。
 * 认领成功后 status = running，生成 run_id 与租约，attempt + 1。发起用户已不在组织中、任务类型未登记、
 * 超过最多执行次数时直接标为失败。
 */
export async function claimJob(db: Kysely<Database>, options: ClaimOptions): Promise<ClaimResult> {
  return withOrgContext(db, options.orgId, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`jobs_org:${options.orgId}`}, 0))`.execute(trx);
    const row = await lockJob(trx, options.jobId);
    if (!row) return { kind: 'skipped', reason: 'missing' };
    if (row.status !== 'queued') return { kind: 'skipped', reason: 'not-queued' };

    const maxAttempts = options.attemptsFor(row.type);
    if (maxAttempts === null) {
      await failInTrx(trx, row, 'JOB_TYPE_UNKNOWN', '任务类型不受支持');
      return { kind: 'skipped', reason: 'failed' };
    }
    if (row.attempt >= maxAttempts) {
      await failInTrx(trx, row, 'JOB_ATTEMPTS_EXHAUSTED', '任务多次中断，已停止重试');
      return { kind: 'skipped', reason: 'failed' };
    }
    const membership = await trx
      .selectFrom('org_memberships')
      .select('role')
      .where('org_id', '=', row.org_id)
      .where('user_id', '=', row.user_id)
      .executeTakeFirst();
    if (!membership) {
      await failInTrx(trx, row, 'JOB_USER_REMOVED', '发起任务的用户已不在本组织中');
      return { kind: 'skipped', reason: 'failed' };
    }

    const running = await trx
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('status', 'in', ['running', 'cancelling'])
      .executeTakeFirstOrThrow();
    if (Number(running.count) >= options.orgRunningLimit) return { kind: 'deferred' };

    // Agent 任务的组织配额（8.3d）：并发已满或前面还有排队的 Agent 任务时延后；当日运行时长已用完时暂停，次日可继续。
    const agent = await isAgentJob(trx, row.id);
    if (agent) {
      if (await shouldDeferAgentClaim(trx, { id: row.id, orgId: row.org_id }, options.agentQuota)) return { kind: 'deferred' };
      if (await isAgentDailyRuntimeExhausted(trx, row.org_id, options.agentQuota)) {
        const paused = await trx
          .updateTable('jobs')
          .set({ status: 'paused', pause_reason: AGENT_DAILY_RUNTIME_PAUSE_REASON })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await appendEvent(trx, toRecord(paused), 'paused', AGENT_DAILY_RUNTIME_PAUSE_MESSAGE, { reason: AGENT_DAILY_RUNTIME_PAUSE_REASON });
        return { kind: 'skipped', reason: 'paused' };
      }
    }

    const updated = await trx
      .updateTable('jobs')
      .set({
        status: 'running',
        run_id: options.runId,
        lease_expires_at: leaseInterval(options.leaseMs),
        attempt: row.attempt + 1,
        started_at: row.started_at ?? sql<Date>`now()`,
      })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const job = toRecord(updated);
    if (agent) await startAgentJobRun(trx, { orgId: job.orgId, jobId: job.id, runId: options.runId });
    await appendEvent(trx, job, 'started', null, { attempt: job.attempt });
    return { kind: 'claimed', job, role: membership.role };
  });
}

export interface RunRef {
  orgId: string;
  jobId: string;
  runId: string;
}

export interface RunState {
  status: JobStatus;
  pauseRequested: boolean;
  /** Agent 任务（8.3d）：本组织当日的 Agent 运行时长已用完（含本次执行到现在为止），执行者应中止并暂停。 */
  agentRuntimeExhausted: boolean;
  /** Agent 任务（8.4b）：本次执行中 Agent 已报告无法继续（report-failure），执行者应中止；结束时任务以 AGENT_REPORTED_FAILURE 失败。 */
  agentFailureReported: boolean;
  /** Agent 任务（8.4c1）：本次执行中等待用户回答已超时，执行者应中止并暂停为 waiting_for_user。 */
  agentQuestionExpired: boolean;
}

/**
 * 续租，并可同时更新进度和 checkpoint。返回当前状态（执行者据此发现取消、暂停请求）；
 * 租约已不属于本执行者（被对账收回、任务已结束）时返回 null，什么都不写。
 * Agent 任务另把本次执行计到现在（agent_job_runs.last_seen_at），并检查组织当日的运行时长（8.3d）与本次执行的失败报告（8.4b）。
 */
export async function renewRun(
  db: Kysely<Database>,
  run: RunRef,
  leaseMs: number,
  update: { progress?: number; checkpoint?: Record<string, unknown> } = {},
  agentQuota?: AgentQuotaOptions,
): Promise<RunState | null> {
  const checkpoint = update.checkpoint ? serialize(update.checkpoint, JOB_CHECKPOINT_MAX_BYTES, 'checkpoint') : undefined;
  if (update.progress !== undefined && !(Number.isInteger(update.progress) && update.progress >= 0 && update.progress <= 100)) {
    throw new TypeError('progress 必须是 0~100 的整数');
  }
  return withOrgContext(db, run.orgId, async (trx) => {
    const row = await trx
      .updateTable('jobs')
      .set({
        lease_expires_at: leaseInterval(leaseMs),
        ...(update.progress !== undefined ? { progress: update.progress } : {}),
        ...(checkpoint !== undefined ? { checkpoint } : {}),
      })
      .where('id', '=', run.jobId)
      .where('run_id', '=', run.runId)
      .returning(['status', 'pause_requested'])
      .executeTakeFirst();
    if (!row) return null;
    const agent = await touchAgentJobRun(trx, run.runId);
    const agentRuntimeExhausted = agent && (await isAgentDailyRuntimeExhausted(trx, run.orgId, agentQuota));
    const agentFailureReported = agent && (await findAgentFailureReport(trx, run.jobId, run.runId)) !== null;
    const agentQuestionExpired =
      agent && (await hasExpiredAgentQuestion(trx, run.jobId, run.runId, agentQuota?.agentQuestionTimeoutSeconds ?? AGENT_QUESTION_TIMEOUT_SECONDS));
    return { status: row.status, pauseRequested: row.pause_requested, agentRuntimeExhausted, agentFailureReported, agentQuestionExpired };
  });
}

/** 执行者写一条日志，返回写入的事件；租约已丢失时返回 null，不写。 */
export async function appendRunLog(
  db: Kysely<Database>,
  run: RunRef,
  message: string,
  data?: Record<string, unknown>,
): Promise<JobEventRecord | null> {
  return withOrgContext(db, run.orgId, async (trx) => {
    const row = await trx.selectFrom('jobs').select('id').where('id', '=', run.jobId).where('run_id', '=', run.runId).forShare().executeTakeFirst();
    if (!row) return null;
    return appendEvent(trx, { orgId: run.orgId, id: run.jobId }, 'log', message, data ?? null);
  });
}

/** worker 读出任务的当前状态（用于推送，src/jobs/notify.ts）；不存在时返回 null。 */
export async function findJobForOrg(db: Kysely<Database>, orgId: string, jobId: string): Promise<JobRecord | null> {
  const row = await withOrgContext(db, orgId, (trx) => trx.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirst());
  return row ? toRecord(row) : null;
}

export function isTaskLimitReason(reason: JobPauseReason | null): reason is AgentBudgetExhaustedReason {
  return reason !== null && (AGENT_BUDGET_EXHAUSTED_REASONS as readonly string[]).includes(reason);
}

const WAITING_FOR_SELECTION_PAUSE_MESSAGE = '等待确认，确认后任务会继续';

const AGENT_WAITING_FOR_USER_PAUSE_MESSAGE = 'Agent 的问题长时间未回答，任务已暂停，回答后会自动继续';

const STORAGE_QUOTA_PAUSE_MESSAGE = '组织存储空间已满，无法保存 Agent 的工作区，任务已暂停，请删除不需要的文件后继续';
const MODEL_PAUSE_MESSAGES = {
  model_not_configured: '尚未选择文本模型，任务已暂停，请在设置中选择模型后继续',
  model_unavailable: '所选模型暂时不能使用（未登记、已停用、未定价或服务未配置），任务已暂停，请在设置中选择可用的模型后继续',
} as const;

const AGENT_DAILY_RUNTIME_PAUSE_MESSAGE = '本组织今日的 Agent 运行时长已用完，任务已暂停，明日可继续';

const TASK_LIMIT_PAUSE_MESSAGES: Readonly<Record<AgentBudgetExhaustedReason, string>> = {
  task_cost_limit: '本任务的费用已达到上限，任务已暂停，由发起人或组织管理员确认后可以继续',
  task_turn_limit: '本任务的模型调用次数已达到上限，任务已暂停，由发起人或组织管理员确认后可以继续',
};

export type RunOutcome =
  | { kind: 'succeeded' }
  | { kind: 'failed'; code: string; message: string }
  /** 执行被中止（取消、暂停、worker 关闭）：按数据库中的状态收尾。 */
  | { kind: 'interrupted' }
  /** 调用模型时余额不足以冻结（6.4）：暂停为 paused / insufficient_balance，已请求取消时仍为 cancelled。 */
  | { kind: 'insufficient-balance' }
  /** 达到 Agent 任务的费用或轮数上限（8.3a）：暂停为 paused / 该原因，已请求取消时仍为 cancelled。 */
  | { kind: 'task-limit'; reason: AgentBudgetExhaustedReason }
  /** 组织当日的 Agent 运行时长用完（8.3d）：暂停为 paused / agent_daily_runtime，已请求取消时仍为 cancelled。 */
  | { kind: 'agent-runtime-limit' }
  /** 等待用户回答超时（8.4c1）：暂停为 paused / waiting_for_user，用户回答后自动继续；问题已被回答时按中止收尾（回到 queued）。 */
  | { kind: 'waiting-for-user' }
  /** 保存 Agent 工作区快照时超出组织存储配额（8.5c）：暂停为 paused / storage_quota，已请求取消时仍为 cancelled。 */
  | { kind: 'storage-quota' }
  /** Agent 的模型调用因没有选择模型 / 所选模型不可用被拒绝（8.6d3）：暂停为 paused / 该原因，已请求取消时仍为 cancelled。 */
  | { kind: 'model-unavailable'; reason: 'model_not_configured' | 'model_unavailable' }
  /** 任务等待用户确认选择（8.7e1）：暂停为 paused / waiting_for_selection；已请求取消、暂停时按请求收尾。 */
  | { kind: 'waiting-for-selection' };

/**
 * 结束一次执行。成功即 succeeded（即使期间请求了取消，工作已完成）；失败即 failed，除非已请求取消（cancelled）；
 * 中止（取消、暂停、worker 关闭）按数据库中的请求收尾：cancelling → cancelled，pause_requested → paused，
 * 都没有时可续跑的回到 queued、不可续跑的 failed；余额不足即 paused（pause_reason = insufficient_balance），已请求取消时 cancelled。
 * 租约已不属于本执行者时返回 null，什么都不写（隔离令牌）。返回结束后的状态。
 */
export async function finishRun(db: Kysely<Database>, run: RunRef, outcome: RunOutcome, resumable: boolean): Promise<JobStatus | null> {
  return withOrgContext(db, run.orgId, async (trx) => {
    const row = await trx.selectFrom('jobs').selectAll().where('id', '=', run.jobId).where('run_id', '=', run.runId).forUpdate().executeTakeFirst();
    if (!row) return null;
    // Agent 任务的本次执行计到现在（8.3d；不是 Agent 任务时影响 0 行）。
    await endAgentJobRun(trx, run.runId);
    if (outcome.kind === 'succeeded') {
      const updated = await trx
        .updateTable('jobs')
        .set({ status: 'succeeded', progress: 100, pause_requested: false, run_id: null, lease_expires_at: null, finished_at: sql<Date>`now()` })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendEvent(trx, toRecord(updated), 'succeeded');
      return updated.status;
    }
    // Agent 在本次执行中报告了无法继续（8.4b）：除成功外的任何结果（失败、中止、余额不足、达到上限、时长用完）都以
    // AGENT_REPORTED_FAILURE 失败，原因取数据库中记下的报告；已请求取消的仍为取消（下面的 releaseInTrx）。
    if (row.status === 'running' && (await failIfAgentReported(trx, row, run.runId))) return 'failed';
    if (outcome.kind === 'failed' && row.status === 'running') {
      await failInTrx(trx, row, outcome.code, outcome.message);
      return 'failed';
    }
    if (outcome.kind === 'insufficient-balance' && row.status === 'running') {
      const updated = await trx
        .updateTable('jobs')
        .set({ status: 'paused', pause_reason: 'insufficient_balance', pause_requested: false, run_id: null, lease_expires_at: null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendEvent(trx, toRecord(updated), 'paused', '余额不足，任务已暂停，充值后可继续', { reason: 'insufficient_balance' });
      return 'paused';
    }
    if (outcome.kind === 'task-limit' && row.status === 'running') {
      // 确认继续（8.3b）要求已记下达到上限的原因；执行者记录失败时（markAgentBudgetExhausted 出错）在暂停前补上。
      await trx
        .updateTable('agent_job_budgets')
        .set({ exhausted_reason: outcome.reason })
        .where('job_id', '=', row.id)
        .where('exhausted_reason', 'is', null)
        .execute();
      const updated = await trx
        .updateTable('jobs')
        .set({ status: 'paused', pause_reason: outcome.reason, pause_requested: false, run_id: null, lease_expires_at: null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      // 事件中记下暂停时的已扣费与上限（确认继续的页面显示，8.3b）。
      const budget = await trx
        .selectFrom('agent_job_budgets')
        .select(['cost_limit', 'turn_limit', 'turns_used'])
        .where('job_id', '=', row.id)
        .executeTakeFirst();
      await appendEvent(trx, toRecord(updated), 'paused', TASK_LIMIT_PAUSE_MESSAGES[outcome.reason], {
        reason: outcome.reason,
        billedAmount: updated.billed_amount,
        ...(budget ? { costLimit: budget.cost_limit, turnLimit: budget.turn_limit, turnsUsed: budget.turns_used } : {}),
      });
      return 'paused';
    }
    if (outcome.kind === 'storage-quota' && row.status === 'running') {
      const updated = await trx
        .updateTable('jobs')
        .set({ status: 'paused', pause_reason: STORAGE_QUOTA_PAUSE_REASON, pause_requested: false, run_id: null, lease_expires_at: null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendEvent(trx, toRecord(updated), 'paused', STORAGE_QUOTA_PAUSE_MESSAGE, { reason: STORAGE_QUOTA_PAUSE_REASON });
      return 'paused';
    }
    if (outcome.kind === 'model-unavailable' && row.status === 'running') {
      const updated = await trx
        .updateTable('jobs')
        .set({ status: 'paused', pause_reason: outcome.reason, pause_requested: false, run_id: null, lease_expires_at: null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendEvent(trx, toRecord(updated), 'paused', MODEL_PAUSE_MESSAGES[outcome.reason], { reason: outcome.reason });
      return 'paused';
    }
    if (outcome.kind === 'agent-runtime-limit' && row.status === 'running') {
      const updated = await trx
        .updateTable('jobs')
        .set({ status: 'paused', pause_reason: AGENT_DAILY_RUNTIME_PAUSE_REASON, pause_requested: false, run_id: null, lease_expires_at: null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendEvent(trx, toRecord(updated), 'paused', AGENT_DAILY_RUNTIME_PAUSE_MESSAGE, { reason: AGENT_DAILY_RUNTIME_PAUSE_REASON });
      return 'paused';
    }
    // 等待用户确认选择（8.7e1）：已请求取消、暂停的按请求收尾（releaseInTrx；手动暂停后的“继续”同样不放行，见 requestResume）。
    if (outcome.kind === 'waiting-for-selection' && row.status === 'running' && !row.pause_requested) {
      const updated = await trx
        .updateTable('jobs')
        .set({ status: 'paused', pause_reason: WAITING_FOR_SELECTION_PAUSE_REASON, pause_requested: false, run_id: null, lease_expires_at: null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendEvent(trx, toRecord(updated), 'paused', WAITING_FOR_SELECTION_PAUSE_MESSAGE, { reason: WAITING_FOR_SELECTION_PAUSE_REASON });
      return 'paused';
    }
    // 等待回答超时（8.4c1）：问题仍在等待（本次执行的）才暂停；暂停前刚好被回答的按中止收尾（回到 queued，续跑时取回答案）。
    // 已请求取消、暂停的按请求收尾（releaseInTrx）。
    if (outcome.kind === 'waiting-for-user' && row.status === 'running' && !row.pause_requested && (await findPendingAgentQuestion(trx, row.id, run.runId)) !== null) {
      const updated = await trx
        .updateTable('jobs')
        .set({ status: 'paused', pause_reason: AGENT_WAITING_FOR_USER_PAUSE_REASON, pause_requested: false, run_id: null, lease_expires_at: null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendEvent(trx, toRecord(updated), 'paused', AGENT_WAITING_FOR_USER_PAUSE_MESSAGE, { reason: AGENT_WAITING_FOR_USER_PAUSE_REASON });
      return 'paused';
    }
    return releaseInTrx(trx, row, resumable, 'released');
  });
}

/** 本次执行有 Agent 的失败报告（8.4b）时把任务标为失败（AGENT_REPORTED_FAILURE，原因为报告的原因），返回是否已标为失败。 */
async function failIfAgentReported(trx: Trx, row: JobRow, runId: string): Promise<boolean> {
  const reason = await findAgentFailureReport(trx, row.id, runId);
  if (reason === null) return false;
  await failInTrx(trx, row, AGENT_REPORTED_FAILURE_CODE, reason || AGENT_REPORTED_FAILURE_FALLBACK_MESSAGE);
  return true;
}

/**
 * 执行者已退出（中止或失联）后按请求收尾：cancelling → cancelled；pause_requested → paused；
 * 其余可续跑的回到 queued（不清 checkpoint），不可续跑的 failed（JOB_INTERRUPTED）。
 */
async function releaseInTrx(trx: Trx, row: JobRow, resumable: boolean, event: 'released' | 'recovered'): Promise<JobStatus> {
  const cleared = { pause_requested: false, run_id: null, lease_expires_at: null } as const;
  if (row.status === 'cancelling') {
    const updated = await trx
      .updateTable('jobs')
      .set({ ...cleared, status: 'cancelled', finished_at: sql<Date>`now()` })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendEvent(trx, toRecord(updated), 'cancelled');
    return 'cancelled';
  }
  if (row.pause_requested) {
    const updated = await trx.updateTable('jobs').set({ ...cleared, status: 'paused' }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
    await appendEvent(trx, toRecord(updated), 'paused');
    return 'paused';
  }
  if (!resumable) {
    await failInTrx(trx, row, 'JOB_INTERRUPTED', '任务执行中断，请重新发起');
    return 'failed';
  }
  const updated = await trx.updateTable('jobs').set({ ...cleared, status: 'queued' }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
  await appendEvent(trx, toRecord(updated), event, null, { attempt: updated.attempt });
  return 'queued';
}

export interface DispatchCandidate {
  id: string;
  orgId: string;
  /** 分页游标：入队时间的文本形式（保留微秒；转成 JS Date 会截到毫秒，下一页会重复返回同一毫秒内的任务）。 */
  cursor: string;
}

/** 跨组织列出需要 worker 处理的任务（queued，以及租约已过期的 running / cancelling），只有 id；按 (created_at, id) 分页。 */
export async function listDispatchCandidates(
  db: Kysely<Database>,
  after: { cursor: string; id: string } | null,
  limit: number = JOB_DISPATCH_BATCH_MAX,
): Promise<DispatchCandidate[]> {
  const { rows } = await sql<{ id: string; org_id: string; cursor: string }>`
    SELECT id, org_id, created_at::text AS cursor
    FROM jobs_dispatch_candidates(${after?.cursor ?? null}::timestamptz, ${after?.id ?? null}::uuid, ${limit})`.execute(db);
  return rows.map((row) => ({ id: row.id, orgId: row.org_id, cursor: row.cursor }));
}

/** changed：本次对账改变了任务的状态（需要推送）。 */
export type RecoverResult =
  | { kind: 'dispatch'; type: string; changed: boolean }
  | { kind: 'none'; changed: boolean };

/**
 * 对账一个任务：queued 的需要（重新）放进 BullMQ；租约已过期的 running / cancelling 按 releaseInTrx 收尾，回到 queued 的也要派发。
 * 任务类型未登记时标为失败。其余情况（已被认领、租约未过期、已结束）不处理。
 */
export async function recoverJob(
  db: Kysely<Database>,
  candidate: { orgId: string; id: string },
  resumableFor: (type: string) => boolean | null,
): Promise<RecoverResult> {
  return withOrgContext(db, candidate.orgId, async (trx) => {
    const row = await trx
      .selectFrom('jobs')
      .selectAll()
      .select(sql<boolean>`lease_expires_at < now()`.as('lease_expired'))
      .where('id', '=', candidate.id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { kind: 'none', changed: false };
    const resumable = resumableFor(row.type);
    if (row.status === 'queued') {
      if (resumable === null) {
        await failInTrx(trx, row, 'JOB_TYPE_UNKNOWN', '任务类型不受支持');
        return { kind: 'none', changed: true };
      }
      return { kind: 'dispatch', type: row.type, changed: false };
    }
    if ((row.status === 'running' || row.status === 'cancelling') && row.lease_expired) {
      // 执行者失联：Agent 任务的本次执行只计到最后一次续租（8.3d）。
      if (row.run_id) await closeLostAgentJobRun(trx, row.run_id);
      // 失联前 Agent 已报告无法继续（8.4b）：不再续跑，以 AGENT_REPORTED_FAILURE 失败（已请求取消的仍为取消）。
      if (row.status === 'running' && row.run_id && (await failIfAgentReported(trx, row, row.run_id))) return { kind: 'none', changed: true };
      const status = await releaseInTrx(trx, row, resumable ?? false, 'recovered');
      return status === 'queued' ? { kind: 'dispatch', type: row.type, changed: true } : { kind: 'none', changed: true };
    }
    return { kind: 'none', changed: false };
  });
}
