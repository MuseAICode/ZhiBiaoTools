// 业务任务共用的中止处理（废标检查 6.9、技术方案 6.11）。
import { JobBalanceExhaustedError, JobInterruptedError, type JobContext } from './definitions.ts';

/** 暂停、余额不足、中断（租约丢失、worker 关闭）与取消：任务不改写结果，把错误原样抛给执行者，由执行者按任务状态收尾。 */
export function isJobStop(context: JobContext<unknown>, error: unknown): boolean {
  return context.signal.aborted || error instanceof JobInterruptedError || error instanceof JobBalanceExhaustedError;
}

/** 可被任务中止打断的等待（中止时抛 JobInterruptedError）。 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new JobInterruptedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JobInterruptedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
