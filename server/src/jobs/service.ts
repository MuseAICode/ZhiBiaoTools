// 任务的入队、取消、暂停、继续（用户发起，经 TenantContext）。先改 jobs，提交后再放进 BullMQ：
// 放入失败（Redis 不可用、重启中）时任务仍是 queued，由 worker 的对账重新放入，不会丢失。
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import type { JobTypeRegistry } from './definitions.ts';
import { NULL_JOB_NOTIFIER, type JobNotifier } from './notify.ts';
import type { JobDispatcher } from './queue.ts';
import { insertJobSuperseding, requestCancel, requestPause, requestResume, type InsertedJob, type JobRecord, type NewJob } from './store.ts';

export interface JobServiceDependencies {
  db: Kysely<Database>;
  registry: JobTypeRegistry;
  /** 未配置 Redis 时为 null：只写 jobs，由 worker 的对账派发。 */
  dispatcher: JobDispatcher | null;
  log: Pick<FastifyBaseLogger, 'warn'>;
  /** 状态变化后的推送（6.3）；不提供时不推送。 */
  notifier?: JobNotifier;
}

async function dispatchBestEffort(deps: JobServiceDependencies, job: JobRecord): Promise<void> {
  const definition = deps.registry.get(job.type);
  if (!deps.dispatcher || !definition) return;
  try {
    await deps.dispatcher.dispatch({ id: job.id, orgId: job.orgId, type: job.type, queue: definition.queue });
  } catch (error) {
    deps.log.warn({ err: error, jobId: job.id }, 'job dispatch failed, left for reconcile');
  }
}

/**
 * 入队：任务类型必须已登记，参数先经该类型校验。lock_key 冲突时抛 409 JOB_LOCKED；会调用模型的任务类型（billable）
 * 可用余额低于最低启动余额时抛 402 INSUFFICIENT_BALANCE（与写入在同一事务）。
 */
export async function enqueueJob(deps: JobServiceDependencies, context: TenantContext, input: NewJob): Promise<JobRecord> {
  return (await enqueueJobSuperseding(deps, context, input)).job;
}

/** 同 enqueueJob，另返回被取代的排队中任务（NewJob.supersedeQueued），并推送它们的状态。 */
export async function enqueueJobSuperseding(deps: JobServiceDependencies, context: TenantContext, input: NewJob): Promise<InsertedJob> {
  const definition = deps.registry.get(input.type);
  if (!definition) throw new TypeError(`任务类型未登记：${input.type}`);
  definition.parseParams(input.params);
  const inserted = await insertJobSuperseding(deps.db, context, { ...input, checkBalance: definition.billable === true, agentLimits: definition.agentLimits ?? null });
  const notifier = deps.notifier ?? NULL_JOB_NOTIFIER;
  for (const cancelled of inserted.superseded) await notifier.changed(cancelled);
  await notifier.changed(inserted.job);
  await dispatchBestEffort(deps, inserted.job);
  return inserted;
}

export async function cancelJob(deps: JobServiceDependencies, context: TenantContext, jobId: string): Promise<JobRecord> {
  const { job } = await requestCancel(deps.db, context, jobId);
  await (deps.notifier ?? NULL_JOB_NOTIFIER).changed(job);
  return job;
}

export async function pauseJob(deps: JobServiceDependencies, context: TenantContext, jobId: string): Promise<JobRecord> {
  const { job } = await requestPause(deps.db, context, jobId);
  await (deps.notifier ?? NULL_JOB_NOTIFIER).changed(job);
  return job;
}

export async function resumeJob(deps: JobServiceDependencies, context: TenantContext, jobId: string): Promise<JobRecord> {
  // 从暂停继续前同样检查余额（余额不足暂停的任务充值后才能继续）。
  const change = await requestResume(deps.db, context, jobId, (type) => deps.registry.get(type)?.billable === true);
  await (deps.notifier ?? NULL_JOB_NOTIFIER).changed(change.job);
  if (change.dispatch) await dispatchBestEffort(deps, change.job);
  return change.job;
}
