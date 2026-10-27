// 导入后自动入队文档解析（路线图第 6 步 6.6）：技术方案、废标检查、可研报告的导入接口在导入的事务提交之后调用。
// 一个文件一个任务，互斥键是文件 id；同一文件已有未结束的解析任务（JOB_LOCKED）时不再重复入队。
// 入队先写 jobs，Redis 不可用时任务仍是 queued，由 worker 的对账派发。
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { enqueueJob, type JobServiceDependencies } from '../jobs/service.ts';
import { DOCUMENT_PARSE_JOB_TYPE, documentParseLockKey, type ParseTarget } from './job.ts';

export async function enqueueDocumentParses(
  jobs: JobServiceDependencies,
  context: TenantContext,
  projectId: string,
  target: ParseTarget,
  fileIds: readonly string[],
): Promise<void> {
  for (const fileId of fileIds) {
    try {
      await enqueueJob(jobs, context, {
        type: DOCUMENT_PARSE_JOB_TYPE,
        projectId,
        lockKey: documentParseLockKey(fileId),
        params: { target, fileId },
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'JOB_LOCKED') continue;
      throw error;
    }
  }
}
