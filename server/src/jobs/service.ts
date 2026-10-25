// 任务的入队、取消、暂停、继续（用户发起，经 TenantContext）。先改 jobs，提交后再放进 BullMQ：
// 放入失败（Redis 不可用、重启中）时任务仍是 queued，由 worker 的对账重新放入，不会丢失。
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import type { JobTypeRegistry } from './definitions.ts';
import type { JobDispatcher } from './queue.ts';
import { insertJob, requestCancel, requestPause, requestResume, type JobRecord, type NewJob } from './store.ts';

export interface JobServiceDependencies {
  db: Kysely<Database>;
  registry: JobTypeRegistry;
  /** 未配置 Redis 时为 null：只写 jobs，由 worker 的对账派发。 */
  dispatcher: JobDispatcher | null;
  log: Pick<FastifyBaseLogger, 'warn'>;
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

/** 入队：任务类型必须已登记，参数先经该类型校验。lock_key 冲突时抛 409 JOB_LOCKED。 */
export async function enqueueJob(deps: JobServiceDependencies, context: TenantContext, input: NewJob): Promise<JobRecord> {
  const definition = deps.registry.get(input.type);
  if (!definition) throw new TypeError(`任务类型未登记：${input.type}`);
  definition.parseParams(input.params);
  const job = await insertJob(deps.db, context, input);
  await dispatchBestEffort(deps, job);
  return job;
}

export async function cancelJob(deps: JobServiceDependencies, context: TenantContext, jobId: string): Promise<JobRecord> {
  return (await requestCancel(deps.db, context, jobId)).job;
}

export async function pauseJob(deps: JobServiceDependencies, context: TenantContext, jobId: string): Promise<JobRecord> {
  return (await requestPause(deps.db, context, jobId)).job;
}

export async function resumeJob(deps: JobServiceDependencies, context: TenantContext, jobId: string): Promise<JobRecord> {
  const change = await requestResume(deps.db, context, jobId);
  if (change.dispatch) await dispatchBestEffort(deps, change.job);
  return change.job;
}
