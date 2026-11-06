// worker 中的 SandboxDriver：经 HTTP 调用 sandbox-runner（src/sandbox/runnerApp.ts）。
// worker 不挂载 Docker socket，只持有调用 sandbox-runner 的共享令牌。取回的归档在这里按模板校验
// （src/sandbox/archive.ts），不信任 sandbox-runner 转出的内容（它来自沙箱）。
import { createArchive, createArchiveStream, hasStreamFiles, readArchive, SandboxArchiveError, type ArchiveStream, type SandboxFile } from './archive.ts';
import { isSandboxErrorCode, SandboxError, SANDBOX_BUSY_MESSAGE, type SandboxDriver, type SandboxExecResult, type SandboxRef } from './driver.ts';
import { SANDBOX_JOB_HEADER } from './runnerApp.ts';
import { isSandboxTemplateName, SANDBOX_TEMPLATES } from './templates.ts';

export interface SandboxRunnerClientOptions {
  /** sandbox-runner 的地址（如 http://sandbox-runner:3100），只在内部网络上。 */
  url: string;
  token: string;
  /** 不带超时的操作（create、destroy 等）的请求超时。exec、copyIn、copyOut 由 sandbox-runner 按模板限时。 */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** exec 等由模板限时的操作，客户端的超时比模板上限多留这么多。 */
const TEMPLATE_TIMEOUT_MARGIN_MS = 30_000;

export function createSandboxRunnerClient(options: SandboxRunnerClientOptions): SandboxDriver {
  const base = options.url.replace(/\/+$/, '');
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function send(path: string, init: Omit<RequestInit, 'signal'> & { timeoutMs: number; signal?: AbortSignal | undefined }): Promise<Response> {
    const timeout = AbortSignal.timeout(init.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      const { timeoutMs: _timeoutMs, signal: _signal, ...rest } = init;
      response = await fetch(`${base}${path}`, {
        ...rest,
        headers: { authorization: `Bearer ${options.token}`, ...(init.headers as Record<string, string> | undefined) },
        signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw new SandboxError('SANDBOX_ABORTED', '沙箱操作已中止', { cause: error });
      throw new SandboxError('SANDBOX_UNAVAILABLE', '沙箱服务暂不可用', { cause: error });
    }
    if (!response.ok) {
      let code: unknown;
      try {
        code = ((await response.json()) as { error?: { code?: unknown } }).error?.code;
      } catch {
        code = undefined;
      }
      if (code === 'SANDBOX_BUSY') throw new SandboxError(code, SANDBOX_BUSY_MESSAGE);
      if (isSandboxErrorCode(code)) throw new SandboxError(code, `沙箱操作失败（${code}）`);
      throw new SandboxError(response.status >= 500 ? 'SANDBOX_UNAVAILABLE' : 'SANDBOX_FAILED', `沙箱服务返回 ${response.status}`);
    }
    return response;
  }

  const jobHeader = (sandbox: SandboxRef) => ({ [SANDBOX_JOB_HEADER]: sandbox.jobId });
  const sandboxPath = (sandbox: SandboxRef, suffix = '') => `/v1/sandboxes/${encodeURIComponent(sandbox.id)}${suffix}`;

  return {
    async create(template, createOptions) {
      const response = await send('/v1/sandboxes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template, jobId: createOptions.jobId }),
        timeoutMs: requestTimeoutMs,
        signal: createOptions.signal,
      });
      const body = (await response.json()) as { id: string; template: unknown; jobId: string; expiresAt: string };
      if (!isSandboxTemplateName(body.template) || body.template !== template || body.jobId !== createOptions.jobId) {
        throw new SandboxError('SANDBOX_FAILED', '沙箱服务的响应不合法');
      }
      return Object.freeze({ id: body.id, template: body.template, jobId: body.jobId, expiresAt: new Date(body.expiresAt) });
    },

    async copyIn(sandbox, files, operationOptions = {}) {
      const limits = SANDBOX_TEMPLATES[sandbox.template].input;
      let archive: Buffer | ArchiveStream;
      try {
        archive = hasStreamFiles(files)
          ? createArchiveStream(files, limits, operationOptions.signal ? { signal: operationOptions.signal } : {})
          : createArchive(files as readonly SandboxFile[], limits);
      } catch (error) {
        throw new SandboxError('SANDBOX_BAD_REQUEST', '输入文件不符合沙箱规则', { cause: error });
      }
      const timeoutMs = SANDBOX_TEMPLATES[sandbox.template].transferTimeoutMs + TEMPLATE_TIMEOUT_MARGIN_MS;
      if (Buffer.isBuffer(archive)) {
        await send(sandboxPath(sandbox, '/input'), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-tar', ...jobHeader(sandbox) },
          body: new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength),
          timeoutMs,
          signal: operationOptions.signal,
        });
        return;
      }
      // 按需读取的文件：边读边发送（不在内存中缓存整个归档），声明确切的长度，sandbox-runner 据此先按模板上限检查。
      const stream = archive;
      try {
        await send(sandboxPath(sandbox, '/input'), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-tar', 'content-length': String(stream.byteLength), ...jobHeader(sandbox) },
          body: ReadableStream.from(stream.chunks),
          duplex: 'half',
          timeoutMs,
          signal: operationOptions.signal,
        } as Parameters<typeof send>[1]);
      } catch (error) {
        // 中途失败时 sandbox-runner 收到被截断的归档，沙箱已被终止。失败来自输入本身时按输入的原因报告。
        const failure = stream.failure;
        if (failure === undefined || operationOptions.signal?.aborted) throw error;
        if (failure instanceof SandboxArchiveError) throw new SandboxError('SANDBOX_BAD_REQUEST', '输入文件不符合沙箱规则', { cause: failure });
        throw new SandboxError('SANDBOX_INPUT_FAILED', '读取放入沙箱的文件失败', { cause: failure });
      }
    },

    async exec(sandbox, command, args, operationOptions = {}) {
      const template = SANDBOX_TEMPLATES[sandbox.template];
      const timeoutMs = Object.hasOwn(template.commands, command) ? template.commands[command]!.timeoutMs : requestTimeoutMs;
      const response = await send(sandboxPath(sandbox, '/exec'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...jobHeader(sandbox) },
        body: JSON.stringify({ command, args }),
        timeoutMs: timeoutMs + TEMPLATE_TIMEOUT_MARGIN_MS,
        signal: operationOptions.signal,
      });
      return (await response.json()) as SandboxExecResult;
    },

    async copyOut(sandbox, operationOptions = {}) {
      const response = await send(sandboxPath(sandbox, '/output'), {
        method: 'GET',
        headers: jobHeader(sandbox),
        timeoutMs: SANDBOX_TEMPLATES[sandbox.template].transferTimeoutMs + TEMPLATE_TIMEOUT_MARGIN_MS,
        signal: operationOptions.signal,
      });
      if (!response.body) throw new SandboxError('SANDBOX_FAILED', '沙箱服务的响应不合法');
      try {
        return await readArchive(response.body, SANDBOX_TEMPLATES[sandbox.template].output);
      } catch (error) {
        if (error instanceof SandboxArchiveError) throw new SandboxError('SANDBOX_OUTPUT_REJECTED', '沙箱输出不符合规则', { cause: error });
        if (operationOptions.signal?.aborted) throw new SandboxError('SANDBOX_ABORTED', '沙箱操作已中止', { cause: error });
        // 连接中断：sandbox-runner 发现超量或沙箱内的 tar 失败时以错误结束响应。
        throw new SandboxError('SANDBOX_FAILED', '从沙箱取回文件失败', { cause: error });
      }
    },

    async destroy(sandbox) {
      await send(sandboxPath(sandbox), { method: 'DELETE', headers: jobHeader(sandbox), timeoutMs: requestTimeoutMs });
    },
  };
}
