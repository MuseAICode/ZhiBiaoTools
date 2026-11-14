// 任务事件的推送（docs/SERVER_DESIGN.md 第 5.5 节；路线图第 6 步 6.3）：任务状态在数据库中变化、事务提交之后调用，
// 经 src/events/publisher.ts 推给本组织的 SSE 连接（任务在组织内共享，与 GET /api/jobs 相同，不按用户过滤）。
//
// 事件类型：
//   job           任务的当前状态（与 GET /api/jobs/:jobId 的任务部分相同）。状态变化后重新读出再推送，
//                 并发变化时到达顺序可能与提交顺序不同，前端按 updatedAt 取较新的一条；
//   job.progress  执行中的进度：{ jobId, projectId, type, progress }；
//   job.log       任务日志：{ jobId, projectId, type, event }，event 与 GET /api/jobs/:jobId 的 events 相同（不含事件数据）；
//   job.question  Agent 的问题（ask-user，8.4c1）：{ jobId, projectId, type, questionId, status }，status 为 pending（等待回答）
//                 或 answered；不含问题内容，前端经 GET /api/jobs/:jobId 的 pendingQuestion 读取。
// 推送是尽力而为，任何失败都只写日志，不影响任务；任务状态的权威始终是 jobs 表。
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { EventPublisher } from '../events/publisher.ts';
import { findJobForOrg, type JobEventRecord, type JobRecord } from './store.ts';
import { jobBody, jobEventBody } from './view.ts';

export interface JobRef {
  orgId: string;
  id: string;
  projectId: string | null;
  type: string;
}

export interface JobNotifier {
  /** 推送任务的当前状态；执行中的任务被请求取消或暂停时，另通知 worker 立即检查。 */
  changed(job: JobRecord): Promise<void>;
  /** 只知道 id 时（worker 的认领失败、结束、对账）：读出当前状态后推送。 */
  changedById(orgId: string, jobId: string): Promise<void>;
  progress(job: JobRef, progress: number): Promise<void>;
  logged(job: JobRef, event: JobEventRecord): Promise<void>;
  question(job: JobRef, questionId: string, status: 'pending' | 'answered'): Promise<void>;
}

/** 未配置 Redis 时使用：什么都不推送。 */
export const NULL_JOB_NOTIFIER: JobNotifier = Object.freeze({
  async changed() {},
  async changedById() {},
  async progress() {},
  async logged() {},
  async question() {},
});

export interface JobNotifierOptions {
  db: Kysely<Database>;
  publisher: EventPublisher;
  log: Pick<FastifyBaseLogger, 'warn'>;
}

export function createJobNotifier(options: JobNotifierOptions): JobNotifier {
  const { db, publisher, log } = options;

  async function guarded(jobId: string, what: string, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      log.warn({ err: error, jobId }, `job ${what} notify failed`);
    }
  }

  async function changed(job: JobRecord): Promise<void> {
    await guarded(job.id, 'state', async () => {
      await publisher.publish(job.orgId, { type: 'job', data: { job: jobBody(job) } });
      if (job.status === 'cancelling' || (job.status === 'running' && job.pauseRequested)) await publisher.notifyJobControl(job.id);
    });
  }

  return {
    changed,
    async changedById(orgId, jobId) {
      await guarded(jobId, 'state', async () => {
        const job = await findJobForOrg(db, orgId, jobId);
        if (job) await changed(job);
      });
    },
    async progress(job, progress) {
      await guarded(job.id, 'progress', () =>
        publisher.publish(job.orgId, { type: 'job.progress', data: { jobId: job.id, projectId: job.projectId, type: job.type, progress } }),
      );
    },
    async logged(job, event) {
      await guarded(job.id, 'log', () =>
        publisher.publish(job.orgId, {
          type: 'job.log',
          data: { jobId: job.id, projectId: job.projectId, type: job.type, event: jobEventBody(event) },
        }),
      );
    },
    async question(job, questionId, status) {
      await guarded(job.id, 'question', () =>
        publisher.publish(job.orgId, { type: 'job.question', data: { jobId: job.id, projectId: job.projectId, type: job.type, questionId, status } }),
      );
    },
  };
}
