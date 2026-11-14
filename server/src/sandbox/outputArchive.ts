// 取回的归档按模板规则逐项校验并重新生成（路线图 8.5b），两个 driver（sandbox-runner 进程内、worker 的 HTTP 客户端）共用：
// 校验失败映射为 SANDBOX_OUTPUT_REJECTED，其他错误（连接中断、沙箱内的 tar 失败）映射为 SANDBOX_FAILED，中止为 SANDBOX_ABORTED。
import { rewriteArchiveStream, SandboxArchiveError } from './archive.ts';
import { SandboxError, type SandboxOutputArchive } from './driver.ts';
import type { SandboxTransferLimits } from './templates.ts';

export function toOutputArchive(
  source: AsyncIterable<Uint8Array>,
  limits: SandboxTransferLimits,
  options: { signal?: AbortSignal | undefined; onRejected?: (error: SandboxArchiveError) => void } = {},
): SandboxOutputArchive {
  const rewritten = rewriteArchiveStream(source, limits);
  async function* chunks(): AsyncGenerator<Buffer> {
    try {
      yield* rewritten.chunks;
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      if (error instanceof SandboxArchiveError) {
        options.onRejected?.(error);
        throw new SandboxError('SANDBOX_OUTPUT_REJECTED', '沙箱输出不符合规则', { cause: error });
      }
      if (options.signal?.aborted) throw new SandboxError('SANDBOX_ABORTED', '沙箱操作已中止', { cause: error });
      throw new SandboxError('SANDBOX_FAILED', '从沙箱取回文件失败', { cause: error });
    }
  }
  return {
    chunks: { [Symbol.asyncIterator]: () => chunks() },
    get fileCount() {
      return rewritten.fileCount;
    },
  };
}
