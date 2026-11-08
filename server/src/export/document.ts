// 在 export-document 沙箱中生成技术方案整本 Word（路线图第 7 步 7.4g；docs/SERVER_DESIGN.md 第 7.9 节）。整本导出任务
// （src/export/documentJob.ts）调用：
//
// 流程：组装好的整本受限 HTML（7.4c 的 assembleDocumentHtml）与规范化后的配置 → 新建之前按模板的输入规则检查大小与数量
// （超过时直接失败，不创建沙箱；7.4b）→ 新建 export-document 沙箱（断网）→ copyIn 放 request.json 与本项目可见的配图
// （assets/<产物 id>，经 7.4e 的 objectInputFile 按需从对象存储读取、流式放入）→ 执行模板登记的 export 命令 → copyOut
// （归档按模板校验）→ 校验输出内容（src/export/output.ts）。沙箱在 finally 中销毁；sandbox-runner 的到期清理是兜底。
//
// - 交给沙箱的只有服务端组装的 HTML、规范化后的配置和产物表中登记的配图（MIME 取自产物表），不转发任何前端原文；
// - 失败一律抛 JobError，代码与给用户看的原因由这里按入口的错误代码决定，不采用沙箱输出的文字；
// - 配图读取失败（对象已被清理等，SANDBOX_INPUT_FAILED）时提示重新导出；
// - 中止（任务取消、worker 关闭）抛 JobInterruptedError。
import type { ObjectStore } from '../files/objectStore.ts';
import { JobError, JobInterruptedError, type JobContext } from '../jobs/definitions.ts';
import type { SandboxFile, SandboxInputFile } from '../sandbox/archive.ts';
import { createSandboxWithRetry } from '../sandbox/createWithRetry.ts';
import { SandboxError, type SandboxDriver } from '../sandbox/driver.ts';
import { ObjectInputError, objectInputFile } from '../sandbox/objectInput.ts';
import { SANDBOX_TEMPLATES, type SandboxTemplateName } from '../sandbox/templates.ts';
type SandboxInputLimits = (typeof SANDBOX_TEMPLATES)['export-document']['input'];
import type { ExportFormat } from '../templates/exportFormat.ts';
import { exportEntryErrorCode, ExportOutputError, validateExportOutput, type ExportEntryErrorCode, type ExportOutput } from './output.ts';

/** 整本导出可用的上下文：任务编号（沙箱绑定的任务）、中止信号、日志、进度与沙箱驱动。 */
export type DocumentExportContext = Pick<JobContext<unknown>, 'jobId' | 'signal' | 'log' | 'sandbox' | 'setProgress'>;

/** 放入沙箱的一张配图：本项目可见的图片产物。 */
export interface DocumentExportAsset {
  /** 产物 id（小写 uuid），即 data-app-asset-ref 与 assets/ 下的文件名。 */
  id: string;
  /** 产物表登记的 MIME。 */
  mime: string;
  /** 产物表登记的字节数。 */
  size: number;
  /** 对象键（产物表的 storage_key）。 */
  storageKey: string;
}

export interface DocumentExportInput {
  /** assembleDocumentHtml 组装的整本 HTML。 */
  html: string;
  /** 规范化后的配置。 */
  exportFormat: ExportFormat;
  assets: readonly DocumentExportAsset[];
}

export interface DocumentExportOptions {
  /** 重试创建前的等待（毫秒），默认约 2 分钟内重试 6 次。 */
  createRetryDelaysMs?: readonly number[];
}

/** 整本导出不是即时的交互操作，沙箱数已达上限时比样张多等一些（约 2 分钟）。 */
export const DOCUMENT_CREATE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([2_000, 5_000, 10_000, 20_000, 30_000, 60_000]);

const DOCUMENT_TEMPLATE = SANDBOX_TEMPLATES['export-document'];
const ASSET_ROOT = 'assets';
const REQUEST_NAME = 'request.json';

/** 入口的错误代码 → 给用户看的原因。 */
const ENTRY_FAILURES: Readonly<Record<ExportEntryErrorCode, [code: string, message: string]>> = Object.freeze({
  bad_arguments: ['EXPORT_FAILED', 'Word 导出失败'],
  request_invalid: ['EXPORT_REQUEST_INVALID', '导出请求不合法'],
  too_many_images: ['EXPORT_TOO_MANY_IMAGES', '配图超过 2,000 张，无法导出'],
  chrome_render_failed: ['EXPORT_DECORATION_FAILED', '页眉页脚装饰生成失败，请检查模板的页面设置'],
  helper_failed: ['EXPORT_WORD_FAILED', 'Word 生成失败，请检查模板设置与正文内容'],
  helper_timeout: ['EXPORT_TIMEOUT', 'Word 导出超时，请减少正文内容或配图后重试'],
  output_too_large: ['EXPORT_OUTPUT_TOO_LARGE', '生成的 Word 超过 100 MiB（WebP 配图转为 PNG 后可能变大），请减少或压缩正文中的图片'],
  images_too_large: ['EXPORT_IMAGES_TOO_LARGE', 'WebP 配图转为 PNG 后，正文与配图合计超过 128 MiB，无法导出，请减少或压缩正文中的图片'],
  export_failed: ['EXPORT_FAILED', 'Word 导出失败'],
});

const MIB = 1024 * 1024;

function entryFailure(code: ExportEntryErrorCode): JobError {
  const [jobCode, message] = ENTRY_FAILURES[code];
  return new JobError(jobCode, message);
}

function unavailable(cause?: unknown): JobError {
  return new JobError('EXPORT_UNAVAILABLE', '导出服务暂不可用，请稍后重试', cause === undefined ? undefined : { cause });
}

function outputRejected(cause: unknown): JobError {
  return new JobError('EXPORT_OUTPUT_REJECTED', 'Word 导出结果不符合要求，已拒绝', { cause });
}

/** 把沙箱操作的错误转成给用户看的原因（中止仍按中止处理）。 */
function sandboxFailure(error: SandboxError): Error {
  if (error.code === 'SANDBOX_ABORTED') return new JobInterruptedError();
  if (error.code === 'SANDBOX_OUTPUT_REJECTED') return outputRejected(error);
  if (error.code === 'SANDBOX_UNAVAILABLE') return unavailable(error);
  if (error.code === 'SANDBOX_INPUT_FAILED') {
    // 对象已被清理（例如来源文件重新解析后旧图片被删除）或长度与登记的不同：提示重新导出；对象存储出错按暂不可用处理。
    if (error.cause instanceof ObjectInputError) {
      return new JobError('EXPORT_IMAGE_UNAVAILABLE', '部分配图已被删除或已变化，请重新导出', { cause: error });
    }
    return unavailable(error);
  }
  return new JobError('EXPORT_FAILED', 'Word 导出失败', { cause: error });
}

/** 交给沙箱的 request.json：只有服务端组装的 HTML、规范化后的配置与配图的 MIME（产物表登记的值）。 */
export function buildDocumentRequest(input: Pick<DocumentExportInput, 'html' | 'exportFormat' | 'assets'>): Buffer {
  const assetTypes = Object.fromEntries(input.assets.map((asset) => [asset.id, asset.mime]));
  return Buffer.from(JSON.stringify({
    html: input.html,
    export_format: input.exportFormat,
    ...(input.assets.length > 0 ? { asset_types: assetTypes } : {}),
  }), 'utf8');
}

/**
 * 新建沙箱之前按 export-document 模板的输入规则检查（7.4b：超过时直接失败并提示，不创建沙箱）：配图至多 2,000 张，
 * request.json 不超过单个文件的上限，request.json 与配图合计不超过 128 MiB。
 */
export function checkDocumentInputSize(
  request: Buffer,
  assets: readonly Pick<DocumentExportAsset, 'size'>[],
  limits: SandboxInputLimits = DOCUMENT_TEMPLATE.input,
): void {
  if (assets.length + 1 > limits.maxFiles) throw new JobError('EXPORT_TOO_MANY_IMAGES', '配图超过 2,000 张，无法导出');
  if (request.length > limits.maxFileBytes) throw new JobError('EXPORT_TOO_LARGE', '目录与正文内容过多，无法导出');
  const total = assets.reduce((sum, asset) => sum + asset.size, request.length);
  if (total > limits.maxTotalBytes) {
    throw new JobError('EXPORT_IMAGES_TOO_LARGE', `正文与配图合计超过 ${limits.maxTotalBytes / MIB} MiB，无法导出，请减少或压缩正文中的图片`);
  }
}

/** 在新建的 export-document 沙箱中生成整本 Word，返回校验过的 docx 与结果。沙箱在 finally 中销毁。 */
export async function renderTechnicalPlanDocument(
  context: DocumentExportContext,
  objectStore: Pick<ObjectStore, 'get'>,
  input: DocumentExportInput,
  options: DocumentExportOptions = {},
): Promise<ExportOutput> {
  const request = buildDocumentRequest(input);
  checkDocumentInputSize(request, input.assets);
  return runExportSandbox(context, objectStore, { template: 'export-document', request, assets: input.assets, validate: validateExportOutput }, options);
}

/**
 * export-document / export-feasibility 共用的流程（调用方已按模板的输入规则检查过大小）：新建沙箱 → copyIn 放 request.json 与
 * 按需读取的配图 → 执行模板登记的 export 命令 → copyOut 并按 validate 校验 → 销毁。失败与中止的映射见 sandboxFailure。
 */
export async function runExportSandbox<T>(
  context: DocumentExportContext,
  objectStore: Pick<ObjectStore, 'get'>,
  run: {
    template: Extract<SandboxTemplateName, 'export-document' | 'export-feasibility'>;
    request: Buffer;
    assets: readonly DocumentExportAsset[];
    validate: (files: readonly SandboxFile[]) => Promise<T>;
  },
  options: DocumentExportOptions = {},
): Promise<T> {
  if (!context.sandbox) throw unavailable();
  const driver: SandboxDriver = context.sandbox;
  const files: SandboxInputFile[] = [
    { path: REQUEST_NAME, data: run.request },
    ...run.assets.map((asset) => objectInputFile(objectStore, { path: `${ASSET_ROOT}/${asset.id}`, key: asset.storageKey, size: asset.size })),
  ];
  const sandbox = await createSandboxWithRetry(driver, context, {
    template: run.template,
    delaysMs: options.createRetryDelaysMs ?? DOCUMENT_CREATE_RETRY_DELAYS_MS,
    busy: (cause) => new JobError('EXPORT_SANDBOX_BUSY', '导出服务繁忙，请稍后重试', { cause }),
    unavailable,
    busyLog: '沙箱数已达上限，稍后重试',
    unavailableLog: '导出服务暂不可用，稍后重试',
  });
  try {
    try {
      await driver.copyIn(sandbox, files, { signal: context.signal });
      await context.setProgress(20);
      const result = await driver.exec(sandbox, 'export', [], { signal: context.signal });
      if (result.timedOut) throw new JobError('EXPORT_TIMEOUT', 'Word 导出超时，请减少正文内容或配图后重试');
      if (result.exitCode !== 0) throw entryFailure(exportEntryErrorCode(result.stdout));
      await context.setProgress(80);
      return await run.validate(await driver.copyOut(sandbox, { signal: context.signal }));
    } catch (error) {
      if (error instanceof SandboxError) throw sandboxFailure(error);
      if (error instanceof ExportOutputError) throw outputRejected(error);
      throw error;
    }
  } finally {
    // 不论成败都销毁（exec 非 0、超时、中止之后同样）；销毁失败只写日志，到期清理兜底。
    await driver.destroy(sandbox).catch(() => context.log('沙箱销毁失败，将由到期清理删除').catch(() => {}));
  }
}
