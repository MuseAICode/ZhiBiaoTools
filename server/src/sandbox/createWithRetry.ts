// 任务中新建沙箱时的重试（解析 6.6 起、导出 7.3b 起共用）：沙箱数已达上限（SANDBOX_BUSY）或 sandbox-runner 暂不可用
// （SANDBOX_UNAVAILABLE）时按给定的间隔重试，用完仍不行时抛调用方给出的 JobError（给用户看的原因由调用方决定）；
// 中止抛 JobInterruptedError，其他错误原样抛出。
import { abortableDelay } from '../jobs/control.ts';
import { JobInterruptedError, type JobContext, type JobError } from '../jobs/definitions.ts';
import { SandboxError, type SandboxDriver, type SandboxRef } from './driver.ts';
import type { SandboxTemplateName } from './templates.ts';

export interface CreateRetryOptions {
  template: SandboxTemplateName;
  /** 每次重试前的等待（毫秒）；次数即重试次数。 */
  delaysMs: readonly number[];
  /** 重试用完时抛出的错误。 */
  busy: (cause: SandboxError) => JobError;
  unavailable: (cause: SandboxError) => JobError;
  /** 重试前写进任务日志的文字。 */
  busyLog: string;
  unavailableLog: string;
}

export async function createSandboxWithRetry(
  sandbox: SandboxDriver,
  context: Pick<JobContext<unknown>, 'jobId' | 'signal' | 'log'>,
  options: CreateRetryOptions,
): Promise<SandboxRef> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sandbox.create(options.template, { jobId: context.jobId, signal: context.signal });
    } catch (error) {
      if (!(error instanceof SandboxError)) throw error;
      if (error.code === 'SANDBOX_ABORTED') throw new JobInterruptedError();
      const retryable = error.code === 'SANDBOX_BUSY' || error.code === 'SANDBOX_UNAVAILABLE';
      if (!retryable) throw error;
      if (attempt >= options.delaysMs.length) throw error.code === 'SANDBOX_BUSY' ? options.busy(error) : options.unavailable(error);
      await context.log(error.code === 'SANDBOX_BUSY' ? options.busyLog : options.unavailableLog, { attempt: attempt + 1 });
      await abortableDelay(options.delaysMs[attempt]!, context.signal);
    }
  }
}
