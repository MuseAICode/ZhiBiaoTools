// 任务与任务事件对外的形式：GET /api/jobs 的响应和 SSE 推送（src/jobs/notify.ts）共用，不含任务参数、checkpoint 和事件数据。
import type { JobEventRecord, JobRecord } from './store.ts';

export function jobBody(job: JobRecord) {
  return {
    id: job.id,
    type: job.type,
    projectId: job.projectId,
    status: job.status,
    pauseRequested: job.pauseRequested,
    // 暂停原因：insufficient_balance 时前端提示充值后继续（取代桌面版设计中的 onBalanceInsufficient）。
    pauseReason: job.pauseReason,
    progress: job.progress,
    attempt: job.attempt,
    // 本任务已消费的金额：计费单位（0.0001 元）的十进制字符串。
    billedAmount: job.billedAmount.toString(),
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
    createdBy: job.userId,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export type JobBody = ReturnType<typeof jobBody>;

export function jobEventBody(event: JobEventRecord) {
  return { id: event.id, kind: event.kind, message: event.message, createdAt: event.createdAt.toISOString() };
}
