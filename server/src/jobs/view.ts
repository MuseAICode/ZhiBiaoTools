// 任务与任务事件对外的形式：GET /api/jobs 的响应和 SSE 推送（src/jobs/notify.ts）共用，不含任务参数、checkpoint 和事件数据。
import type { JobEventRecord, JobRecord } from './store.ts';

export function jobBody(job: JobRecord) {
  return {
    id: job.id,
    type: job.type,
    projectId: job.projectId,
    status: job.status,
    pauseRequested: job.pauseRequested,
    progress: job.progress,
    attempt: job.attempt,
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
    createdBy: job.userId,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export function jobEventBody(event: JobEventRecord) {
  return { id: event.id, kind: event.kind, message: event.message, createdAt: event.createdAt.toISOString() };
}
