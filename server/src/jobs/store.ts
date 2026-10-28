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
import type { Database, JobEventKind, JobPauseReason, JobsTable, JobStatus, MemberRole } from '../db/schema.ts';
import { assertJobStartBalance } from '../billing/usage.ts';
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
  /** 暂停原因：insufficient_balance（运行中余额不足，6.4）；用户手动暂停时为 null。 */
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
}

/**
 * 新建任务（status = 'queued'），同一事务内写 queued 事件。lock_key 相同的未结束任务已存在时抛 409 JOB_LOCKED
 * （部分唯一索引兜底，并发入队也只有一个成功）。只写数据库，不放进 BullMQ（见 src/jobs/service.ts 的 enqueueJob）。
 */
export async function insertJob(db: Kysely<Database>, context: TenantContext, input: NewJob): Promise<JobRecord> {
  if (input.lockKey !== undefined && input.lockKey !== null && (input.lockKey.length === 0 || input.lockKey.length > JOB_LOCK_KEY_MAX_LENGTH)) {
    throw new TypeError('lockKey 长度不合法');
  }
  const params = serialize(input.params, JOB_PARAMS_MAX_BYTES, '任务参数');
  try {
    return await withTenant(db, context, async (trx) => {
      if (input.checkBalance) await assertJobStartBalance(trx);
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
      await appendEvent(trx, job, 'queued', null, { userId: context.userId });
      return job;
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
  /** true 只列未结束的任务，false 只列已结束的，不传列全部。 */
  active?: boolean;
  limit: number;
}

export async function listJobs(db: Kysely<Database>, context: TenantContext, options: ListJobsOptions): Promise<JobRecord[]> {
  const rows = await withTenant(db, context, (trx) => {
    let query = trx.selectFrom('jobs').selectAll();
    if (options.projectId !== undefined) query = query.where('project_id', '=', options.projectId);
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
 */
export async function requestResume(
  db: Kysely<Database>,
  context: TenantContext,
  jobId: string,
  checkBalance: (type: string) => boolean = () => false,
): Promise<JobChange> {
  return withTenant(db, context, async (trx) => {
    const row = await lockJob(trx, jobId);
    if (!row) throw jobNotFound();
    if (isFinalStatus(row.status)) throw jobFinished();
    if (row.status === 'paused') {
      if (checkBalance(row.type)) await assertJobStartBalance(trx);
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
}

export type ClaimResult =
  | { kind: 'claimed'; job: JobRecord; role: MemberRole }
  /** 组织已有 orgRunningLimit 个任务在运行，留在 queued，稍后再试。 */
  | { kind: 'deferred' }
  /** 任务不存在、不是 queued（已被认领、已暂停、已结束），或认领时判定失败；本次派发作废。 */
  | { kind: 'skipped'; reason: 'missing' | 'not-queued' | 'failed' };

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
}

/**
 * 续租，并可同时更新进度和 checkpoint。返回当前状态（执行者据此发现取消、暂停请求）；
 * 租约已不属于本执行者（被对账收回、任务已结束）时返回 null，什么都不写。
 */
export async function renewRun(
  db: Kysely<Database>,
  run: RunRef,
  leaseMs: number,
  update: { progress?: number; checkpoint?: Record<string, unknown> } = {},
): Promise<RunState | null> {
  const checkpoint = update.checkpoint ? serialize(update.checkpoint, JOB_CHECKPOINT_MAX_BYTES, 'checkpoint') : undefined;
  if (update.progress !== undefined && !(Number.isInteger(update.progress) && update.progress >= 0 && update.progress <= 100)) {
    throw new TypeError('progress 必须是 0~100 的整数');
  }
  const row = await withOrgContext(db, run.orgId, (trx) =>
    trx
      .updateTable('jobs')
      .set({
        lease_expires_at: leaseInterval(leaseMs),
        ...(update.progress !== undefined ? { progress: update.progress } : {}),
        ...(checkpoint !== undefined ? { checkpoint } : {}),
      })
      .where('id', '=', run.jobId)
      .where('run_id', '=', run.runId)
      .returning(['status', 'pause_requested'])
      .executeTakeFirst(),
  );
  return row ? { status: row.status, pauseRequested: row.pause_requested } : null;
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

export type RunOutcome =
  | { kind: 'succeeded' }
  | { kind: 'failed'; code: string; message: string }
  /** 执行被中止（取消、暂停、worker 关闭）：按数据库中的状态收尾。 */
  | { kind: 'interrupted' }
  /** 调用模型时余额不足以冻结（6.4）：暂停为 paused / insufficient_balance，已请求取消时仍为 cancelled。 */
  | { kind: 'insufficient-balance' };

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
    return releaseInTrx(trx, row, resumable, 'released');
  });
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
      const status = await releaseInTrx(trx, row, resumable ?? false, 'recovered');
      return status === 'queued' ? { kind: 'dispatch', type: row.type, changed: true } : { kind: 'none', changed: true };
    }
    return { kind: 'none', changed: false };
  });
}
