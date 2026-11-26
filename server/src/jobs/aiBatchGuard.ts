// 批量模型调用的连续失败守卫（路线图第 8 步 8.10c2b2，取代桌面版 utils/aiBatchGuard.cjs 的 createAiBatchGuard）：一个程序工具中并发的
// 多项模型调用连续 AI_UPSTREAM_FAILURE_LIMIT 项**请求本身失败**（没有拿到可用的回复）、其间没有成功时，判定模型服务不可用，中止本批
// 剩余的调用（signal），由调用方按 error 结束任务。服务有响应、只是输出不合格（校验失败）的清零计数；中止、暂停之后的结果不计入。
//
// “请求本身失败”在 Web 版是 JobAi 转换出的网关错误中服务商一侧的失败（isAiUpstreamFailure：上游失败、上游超时、并发名额暂不可用），
// 与桌面版 aiRetry.cjs 标记 isAiRequestError 的请求错误相对应。余额不足、达到任务上限、任务中断等不经守卫，由调用方立即结束本批。
// 后续的配图、字数校正等批量工具（8.10d / 8.10e）共用本守卫。
import { JobError } from './definitions.ts';

/** 连续失败的上限（与桌面版 AI_UPSTREAM_FAILURE_LIMIT 相同）。 */
export const AI_UPSTREAM_FAILURE_LIMIT = 10;
/** 守卫触发时任务的失败代码（与桌面版 AI_UPSTREAM_UNAVAILABLE 相同）。 */
export const AI_UPSTREAM_UNAVAILABLE = 'AI_UPSTREAM_UNAVAILABLE';

/** 计入连续失败的网关错误代码（服务商一侧的失败；说明是网关的固定文字）。 */
const UPSTREAM_FAILURE_CODES: ReadonlySet<string> = new Set(['AI_UPSTREAM_ERROR', 'AI_UPSTREAM_TIMEOUT', 'AI_CONCURRENCY_UNAVAILABLE']);

/** JobAi 抛出的服务商一侧的失败（对应桌面版的 isAiRequestError）。 */
export function isAiUpstreamFailure(error: unknown): error is JobError {
  return error instanceof JobError && UPSTREAM_FAILURE_CODES.has(error.code);
}

export interface AiBatchGuard {
  /** 调用方的 signal 或守卫触发时中止；本批的模型调用都用它。 */
  readonly signal: AbortSignal;
  /** 守卫触发时的错误（JobError AI_UPSTREAM_UNAVAILABLE），否则 null。 */
  readonly error: JobError | null;
  /** 一项拿到了可用的结果：清零计数。 */
  success(): void;
  /** 一项失败：请求本身失败才计数，其他失败（输出不合格）清零；本批已中止后的结果不计入。 */
  failure(error: unknown): void;
}

/** 本批已中止（中止之后的失败都按取消处理，不计入）。 */
export function isBatchCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function createAiBatchGuard(options: { signal?: AbortSignal; limit?: number } = {}): AiBatchGuard {
  const limit = options.limit ?? AI_UPSTREAM_FAILURE_LIMIT;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let failures = 0;
  let tripped: JobError | null = null;
  return {
    signal,
    get error() {
      return tripped;
    },
    success() {
      if (!tripped) failures = 0;
    },
    failure(error) {
      if (tripped || isBatchCancelled(signal)) return;
      if (!isAiUpstreamFailure(error)) {
        failures = 0;
        return;
      }
      failures += 1;
      if (failures < limit) return;
      // 最后一次错误的说明是网关的固定文字（不含服务商的响应）。
      tripped = new JobError(
        AI_UPSTREAM_UNAVAILABLE,
        `AI 服务连续 ${limit} 个请求失败，已停止派发剩余请求，已完成结果已保留，服务恢复后重试即可接着处理。最后一次错误：${error.message}`,
        { cause: error },
      );
      controller.abort(tripped);
    },
  };
}
