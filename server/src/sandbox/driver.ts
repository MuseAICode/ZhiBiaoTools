// SandboxDriver 接口（docs/SERVER_DESIGN.md 第 7.2、7.5 节）：create / exec / copyIn / copyOut / destroy。
// 两个实现：sandbox-runner 进程内直接操作 Docker 的 createDockerSandboxDriver（src/sandbox/docker.ts），
// 和 worker 中经 HTTP 调用 sandbox-runner 的 createSandboxRunnerClient（src/sandbox/client.ts）。
// 以后换成微虚拟机等实现时，上层（解析任务）不变。
import type { SandboxFile, SandboxInputFile } from './archive.ts';
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
  /**
   * 把文件放进模板的输入目录（parse 为 /input）。路径、数量、大小按模板校验，不合法时一个字节都不放入（SANDBOX_BAD_REQUEST）。
   * 按需读取的文件（SandboxStreamFile）边读边放入，不在内存中整体缓存；读取中途失败（源出错、字节数与声明不符）时
   * 之前的条目可能已放入，沙箱被终止，调用方只能 destroy：源出错为 SANDBOX_INPUT_FAILED（cause 是源的错误），字节数不符为
   * SANDBOX_BAD_REQUEST。
   */
  copyIn(sandbox: SandboxRef, files: readonly SandboxInputFile[], options?: SandboxOperationOptions): Promise<void>;
  /** 执行模板中登记的命令（如 parse），只能追加符合模板规则的参数。 */
  exec(sandbox: SandboxRef, command: string, args: readonly string[], options?: SandboxOperationOptions): Promise<SandboxExecResult>;
  /** 取回模板输出目录（parse 为 /output）中的文件，按模板逐项校验（src/sandbox/archive.ts），不符即整体拒绝。 */
  copyOut(sandbox: SandboxRef, options?: SandboxOperationOptions): Promise<SandboxFile[]>;
  /** 销毁沙箱；已不存在时也成功。 */
  destroy(sandbox: SandboxRef): Promise<void>;
}

/** 取回的工作区归档（copyOutArchive）：已逐项校验并重新生成，只含普通文件。 */
export interface SandboxOutputArchive {
  /**
   * 归档的字节，只能迭代一次。中途不符时抛 SandboxError（SANDBOX_OUTPUT_REJECTED，cause 为 SandboxArchiveError），
   * 连接中断、沙箱内的 tar 失败时 SANDBOX_FAILED，中止时 SANDBOX_ABORTED；出错时已产出的字节不含结束块，调用方必须丢弃。
   */
  readonly chunks: AsyncIterable<Buffer>;
  /** 归档中的文件数；chunks 迭代完成之前读取抛错。 */
  readonly fileCount: number;
}

/**
 * 以整个归档为单位的放入与取回（路线图 8.5b 的 agent 工作区快照）：sandbox-runner 进程内的 driver 与 worker 的 HTTP 客户端都实现。
 * 不在内存中缓存整个归档或整个文件（快照至多 512 MiB）。
 */
export interface SandboxArchiveTransfer {
  /**
   * 放入一个 tar 归档：边读边按模板的输入规则校验（sandbox-runner 端），只把通过校验的条目转给沙箱内的 tar。
   * 中途不符或源出错时沙箱被终止（之前的条目可能已放入），之后只能 destroy；调用方据自己记下的源错误判断失败原因。
   */
  copyInArchive(sandbox: SandboxRef, archive: Buffer | AsyncIterable<Uint8Array>, options?: SandboxOperationOptions): Promise<void>;
  /** 取回模板输出目录的归档，按模板的取回规则逐项校验，只用通过校验的普通文件重新生成（src/sandbox/archive.ts 的 rewriteArchiveStream）。 */
  copyOutArchive(sandbox: SandboxRef, options?: SandboxOperationOptions): Promise<SandboxOutputArchive>;
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
  /** 放入时读取调用方给出的文件失败（例如对象存储出错），cause 是源的错误；沙箱已不可用。只在 worker 端产生，不经 HTTP 传递。 */
  'SANDBOX_INPUT_FAILED',
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
 * 同时存在的沙箱数已达上限时的文案（429 SANDBOX_BUSY）。上限计入全部带沙箱标签的容器，含已停止、已到期但尚未清理的残留沙箱，
 * 以及只剩专用网络的 agent 沙箱残留（与容器同名的只算一个，见 docker.ts 的 countSandboxes）。
 * worker 经 HTTP 收到 SANDBOX_BUSY 时用同一文案，不采用响应中的文字。
 */
export const SANDBOX_BUSY_MESSAGE = '沙箱数已达上限，请稍后重试';

export function isSandboxErrorCode(value: unknown): value is SandboxErrorCode {
  return typeof value === 'string' && (SANDBOX_ERROR_CODES as readonly string[]).includes(value);
}

export const SANDBOX_OUTPUT_PREVIEW_BYTES = 64 * 1024;
