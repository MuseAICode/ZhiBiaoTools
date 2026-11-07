// 在 export-preview 沙箱中生成模板样张（路线图第 7 步 7.3b；docs/SERVER_DESIGN.md 第 7.9 节）。样张任务（7.3c）调用：
//
// 流程：样张 HTML 经 validatePreviewHtml 重新校验（与前端同一套白名单，不通过即拒绝，决定事项第 8 项）、配置经
// normalizeExportFormat 规范化 → 新建 export-preview 沙箱（断网）→ copyIn 只放 request.json（样张配图打进镜像，
// 不放任何配图）→ 执行模板登记的 export 命令 → copyOut（归档按模板校验）→ 校验输出内容（src/export/output.ts）。
// 沙箱在 finally 中销毁（exec 的任何非 0 结果之后都不复用）；sandbox-runner 的到期清理（5 分钟）是兜底。
//
// - 交给沙箱的只有重新序列化的 HTML 与规范化后的配置，不转发调用方的原文；
// - 失败一律抛 JobError，代码与给用户看的原因由这里按入口的错误代码决定，不采用沙箱输出的文字；
// - 沙箱数已达上限或 sandbox-runner 暂不可用时按退避间隔重试创建（样张是交互操作，默认约 30 秒内重试 5 次），仍不行才失败；
// - 中止（任务取消、取代、worker 关闭）抛 JobInterruptedError。
import { createHash } from 'node:crypto';
import { JobError, JobInterruptedError, type JobContext } from '../jobs/definitions.ts';
import { createSandboxWithRetry } from '../sandbox/createWithRetry.ts';
import { SandboxError, type SandboxDriver } from '../sandbox/driver.ts';
import { normalizeExportFormat, type ExportFormat } from '../templates/exportFormat.ts';
import { validatePreviewHtml } from '../templates/previewHtml.ts';
import { exportEntryErrorCode, ExportOutputError, validateExportOutput, type ExportEntryErrorCode, type ExportOutput } from './output.ts';

/** 样张可用的上下文：任务编号（沙箱绑定的任务）、中止信号、日志与沙箱驱动。 */
export type PreviewContext = Pick<JobContext<unknown>, 'jobId' | 'signal' | 'log' | 'sandbox'>;

export interface TemplatePreviewInput {
  /** 前端传来的样张 HTML（未经信任）。 */
  html: unknown;
  /** 模板的 export_format（未经规范化）。 */
  exportFormat: unknown;
}

export interface TemplatePreviewOptions {
  /** 重试创建前的等待（毫秒），默认约 30 秒内重试 5 次。 */
  createRetryDelaysMs?: readonly number[];
}

export const PREVIEW_CREATE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000, 8_000, 15_000]);

/** 入口的错误代码 → 给用户看的原因。 */
const ENTRY_FAILURES: Readonly<Record<ExportEntryErrorCode, [code: string, message: string]>> = Object.freeze({
  bad_arguments: ['EXPORT_FAILED', '样张生成失败'],
  request_invalid: ['EXPORT_REQUEST_INVALID', '样张请求不合法'],
  too_many_images: ['EXPORT_TOO_MANY_IMAGES', '配图超过 2,000 张'],
  chrome_render_failed: ['EXPORT_DECORATION_FAILED', '页眉页脚装饰生成失败，请检查模板的页面设置'],
  helper_failed: ['EXPORT_WORD_FAILED', 'Word 生成失败，请检查模板设置'],
  helper_timeout: ['EXPORT_TIMEOUT', '样张生成超时，请稍后重试'],
  output_too_large: ['EXPORT_OUTPUT_TOO_LARGE', '生成的 Word 超过 100 MiB'],
  // 样张不转换配图，不会出现。
  images_too_large: ['EXPORT_FAILED', '样张生成失败'],
  export_failed: ['EXPORT_FAILED', '样张生成失败'],
});

function entryFailure(code: ExportEntryErrorCode): JobError {
  const [jobCode, message] = ENTRY_FAILURES[code];
  return new JobError(jobCode, message);
}

function unavailable(cause?: unknown): JobError {
  return new JobError('EXPORT_UNAVAILABLE', '导出服务暂不可用，请稍后重试', cause === undefined ? undefined : { cause });
}

/** 把沙箱操作的错误转成给用户看的原因（中止仍按中止处理）。 */
function sandboxFailure(error: SandboxError): Error {
  if (error.code === 'SANDBOX_ABORTED') return new JobInterruptedError();
  if (error.code === 'SANDBOX_OUTPUT_REJECTED') return new JobError('EXPORT_OUTPUT_REJECTED', '样张生成结果不符合要求，已拒绝', { cause: error });
  if (error.code === 'SANDBOX_UNAVAILABLE') return unavailable(error);
  return new JobError('EXPORT_FAILED', '样张生成失败', { cause: error });
}

export interface PreparedPreviewRequest {
  /** 重新序列化的样张 HTML。 */
  html: string;
  /** 规范化后的配置。 */
  exportFormat: ExportFormat;
  /** 交给沙箱的 request.json。 */
  body: Buffer;
  /** body 的 SHA-256：样张输入的哈希，同一组织内按它复用最近的结果（迁移 0027 的 artifacts.preview_sha256）。 */
  sha256: Buffer;
}

/**
 * 校验并组装交给沙箱的请求：只有重新序列化的 HTML 与规范化后的配置。不合法时抛 JobError（PREVIEW_HTML_INVALID）。
 * 同一样张（HTML 与配置的含义相同）得到相同的 body 与哈希：HTML 由解析树重新序列化，配置由 normalizeExportFormat 按固定的
 * 字段顺序重建；对已规范化的结果再做一次得到同样的结果（样张请求从数据库读回后由任务重新准备，见 src/export/previewStore.ts）。
 */
export function preparePreviewRequest(input: TemplatePreviewInput): PreparedPreviewRequest {
  const checked = validatePreviewHtml(input.html);
  if (!checked.ok) throw new JobError('PREVIEW_HTML_INVALID', '样张内容不符合受限 HTML 规则');
  const exportFormat = normalizeExportFormat(input.exportFormat);
  const body = Buffer.from(JSON.stringify({ html: checked.html, export_format: exportFormat }), 'utf8');
  return { html: checked.html, exportFormat, body, sha256: createHash('sha256').update(body).digest() };
}

/** 组装交给沙箱的请求（preparePreviewRequest 的 body）。 */
export function buildPreviewRequest(input: TemplatePreviewInput): Buffer {
  return preparePreviewRequest(input).body;
}

/** 在新建的 export-preview 沙箱中生成样张，返回校验过的 docx 与结果。沙箱在 finally 中销毁。 */
export async function renderTemplatePreview(context: PreviewContext, input: TemplatePreviewInput, options: TemplatePreviewOptions = {}): Promise<ExportOutput> {
  const request = buildPreviewRequest(input);
  if (!context.sandbox) throw unavailable();
  const driver: SandboxDriver = context.sandbox;
  const sandbox = await createSandboxWithRetry(driver, context, {
    template: 'export-preview',
    delaysMs: options.createRetryDelaysMs ?? PREVIEW_CREATE_RETRY_DELAYS_MS,
    busy: (cause) => new JobError('EXPORT_SANDBOX_BUSY', '导出服务繁忙，请稍后重试', { cause }),
    unavailable,
    busyLog: '沙箱数已达上限，稍后重试',
    unavailableLog: '导出服务暂不可用，稍后重试',
  });
  try {
    try {
      await driver.copyIn(sandbox, [{ path: 'request.json', data: request }], { signal: context.signal });
      const result = await driver.exec(sandbox, 'export', [], { signal: context.signal });
      if (result.timedOut) throw new JobError('EXPORT_TIMEOUT', '样张生成超时，请稍后重试');
      if (result.exitCode !== 0) throw entryFailure(exportEntryErrorCode(result.stdout));
      return await validateExportOutput(await driver.copyOut(sandbox, { signal: context.signal }));
    } catch (error) {
      if (error instanceof SandboxError) throw sandboxFailure(error);
      if (error instanceof ExportOutputError) throw new JobError('EXPORT_OUTPUT_REJECTED', '样张生成结果不符合要求，已拒绝', { cause: error });
      throw error;
    }
  } finally {
    // 不论成败都销毁（exec 非 0、超时、中止之后同样）；销毁失败只写日志，到期清理兜底。
    await driver.destroy(sandbox).catch(() => context.log('沙箱销毁失败，将由到期清理删除').catch(() => {}));
  }
}
