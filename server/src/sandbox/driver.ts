// SandboxDriver 接口（docs/SERVER_DESIGN.md 第 7.2、7.5 节）：create / exec / copyIn / copyOut / destroy。
// 两个实现：sandbox-runner 进程内直接操作 Docker 的 createDockerSandboxDriver（src/sandbox/docker.ts），
// 和 worker 中经 HTTP 调用 sandbox-runner 的 createSandboxRunnerClient（src/sandbox/client.ts）。
// 以后换成微虚拟机等实现时，上层（解析任务）不变。
import type { SandboxFile } from './archive.ts';
import type { SandboxTemplateName } from './templates.ts';

export interface SandboxRef {
  readonly id: string;
  readonly template: SandboxTemplateName;
  /** 沙箱绑定的任务：之后的每次操作都要带同一个任务 id，不符按不存在处理。 */
  readonly jobId: string;
  readonly expiresAt: Date;
}

export interface SandboxExecResult {
  /** 进程的退出码；超时、沙箱被终止时为 null。 */
  readonly exitCode: number | null;
  /** 超过命令的墙钟上限，整个沙箱已被终止（之后只能 destroy）。 */
  readonly timedOut: boolean;
  /** 标准输出、标准错误的前 64 KiB（UTF-8），只用于诊断和解析入口的简短结果，不写进任务日志。 */
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface SandboxOperationOptions {
  /** 任务取消、暂停或 worker 关闭时中止；中止 exec 会终止整个沙箱。 */
  signal?: AbortSignal;
}

export interface SandboxDriver {
  /** 按模板新建一个沙箱（一个任务一个，用完即毁）。 */
  create(template: SandboxTemplateName, options: { jobId: string } & SandboxOperationOptions): Promise<SandboxRef>;
  /** 把文件放进模板的输入目录（parse 为 /input）。路径、数量、大小按模板校验。 */
  copyIn(sandbox: SandboxRef, files: readonly SandboxFile[], options?: SandboxOperationOptions): Promise<void>;
  /** 执行模板中登记的命令（如 parse），只能追加符合模板规则的参数。 */
  exec(sandbox: SandboxRef, command: string, args: readonly string[], options?: SandboxOperationOptions): Promise<SandboxExecResult>;
  /** 取回模板输出目录（parse 为 /output）中的文件，按模板逐项校验（src/sandbox/archive.ts），不符即整体拒绝。 */
  copyOut(sandbox: SandboxRef, options?: SandboxOperationOptions): Promise<SandboxFile[]>;
  /** 销毁沙箱；已不存在时也成功。 */
  destroy(sandbox: SandboxRef): Promise<void>;
}

export const SANDBOX_ERROR_CODES = [
  /** 模板、命令或参数不合法，或输入文件不符合模板规则。 */
  'SANDBOX_BAD_REQUEST',
  /** 沙箱不存在、已过期或不属于该任务。 */
  'SANDBOX_NOT_FOUND',
  /** 同时存在的沙箱数已达上限，稍后重试。 */
  'SANDBOX_BUSY',
  /** 取回的文件不符合模板规则（符号链接、路径穿越、超量等），整体拒绝。 */
  'SANDBOX_OUTPUT_REJECTED',
  /** 容器运行时或 sandbox-runner 不可用。 */
  'SANDBOX_UNAVAILABLE',
  /** 操作被调用方中止。 */
  'SANDBOX_ABORTED',
  /** 其他错误。 */
  'SANDBOX_FAILED',
] as const;
export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

/** 沙箱操作失败。message 不含文件内容、文件名和 Docker 的错误正文（只写日志）。 */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/**
 * 同时存在的沙箱数已达上限时的文案（429 SANDBOX_BUSY）。上限计入全部带沙箱标签的容器，含已停止、已到期但尚未清理的残留沙箱。
 * worker 经 HTTP 收到 SANDBOX_BUSY 时用同一文案，不采用响应中的文字。
 */
export const SANDBOX_BUSY_MESSAGE = '沙箱数已达上限，请稍后重试';

export function isSandboxErrorCode(value: unknown): value is SandboxErrorCode {
  return typeof value === 'string' && (SANDBOX_ERROR_CODES as readonly string[]).includes(value);
}

export const SANDBOX_OUTPUT_PREVIEW_BYTES = 64 * 1024;
