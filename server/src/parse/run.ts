// 在 parse 沙箱中解析一个文件并写入产物（路线图第 6 步；docs/SERVER_DESIGN.md 第 7.6 节）。document-parse 任务（6.6，src/parse/job.ts）
// 与标书查重任务（6.10，src/duplicateCheck/job.ts）共用：
// 按记录的 MIME 分派 → 从对象存储取出原件 → 新建 parse 沙箱（断网）→ copyIn → 执行解析入口 → copyOut（归档按模板校验）→
// 校验输出内容（src/parse/output.ts）→ 销毁沙箱（finally，exec 的任何非 0 结果之后都不复用）→ 经 writeArtifact 写入图片和 Markdown。
// 任务进程内不解析上传的内容：原件只经 copyIn 交给沙箱，取回的结果按不可信输入校验；给用户看的原因由错误代码决定，不采用沙箱输出的文字。
import { createHash } from 'node:crypto';
import { writeArtifact } from '../artifacts/store.ts';
import { AppError } from '../errors.ts';
import type { FileRecord } from '../files/store.ts';
import { JobError, JobInterruptedError, type JobContext } from '../jobs/definitions.ts';
import { SandboxError, type SandboxDriver, type SandboxRef } from '../sandbox/driver.ts';
import type { SandboxFile } from '../sandbox/archive.ts';
import { dispatchParse, isSpreadsheetFormat, parseCommandArgs, type ParseAnalysis, type ParseFormat } from './dispatch.ts';
import { entryErrorCode, ParseOutputError, rewriteImageReferences, validateParseOutput, type ParseEntryErrorCode, type ParsedOutput } from './output.ts';

/** 与桌面版的“本地解析”相同（MinerU 第一版不提供）。 */
export const LOCAL_PARSER_LABEL = '本地解析';

/** 解析入口的错误代码 → 给用户看的原因。 */
const ENTRY_MESSAGES: Readonly<Record<ParseEntryErrorCode, string>> = Object.freeze({
  bad_arguments: '文件解析失败',
  unsupported_format: '不支持的文件格式',
  text_decode_failed: '文本编码不正确，请另存为 UTF-8 后重新导入',
  zip_invalid: '文件不是有效的 Office 文档，请用 Word / WPS / Excel 另存后重新导入',
  zip_too_many_entries: '文件内部条目超过 10,000 个，已拒绝解析',
  zip_too_large: '文件解压后超过 1 GiB，已拒绝解析',
  zip_ratio: '文件的压缩比异常（单个条目超过 100:1），已拒绝解析',
  pdf_invalid: 'PDF 文件无法读取',
  pdf_too_many_pages: 'PDF 超过 3,000 页，已拒绝解析',
  pdf_text_layer_missing: 'PDF 未检测到可选中文字层',
  spreadsheet_empty: 'Excel 文件未包含工作表',
  office_conversion_failed: '老式 Word 文件转换失败，请另存为 docx 后重新导入',
  office_conversion_timeout: '老式 Word 文件转换超时（超过 8 分钟），请另存为 docx 后重新导入',
  too_many_images: '文件中的图片超过 2,000 张，已拒绝解析',
  xml_invalid: 'XML 文件格式不正确（须为 UTF-8 编码的 Office 2003 XML），请另存为 docx / xlsx 后重新导入',
  xml_doctype: 'XML 文件含 DTD 声明（<!DOCTYPE> 等），为防止外部实体与实体膨胀已拒绝解析，请另存为 docx / xlsx 后重新导入',
  xml_external_reference: 'XML 文件含外部引用（XInclude 或样式表），已拒绝解析，请另存为 docx / xlsx 后重新导入',
  rtf_invalid: 'RTF 文件格式不正确，请另存为 docx 后重新导入',
  mht_invalid: 'MHT 文件格式不正确（MIME 结构无法解析），请另存为 docx 后重新导入',
  mht_too_complex: 'MHT 文件的 MIME 结构超过上限（嵌套层数、部分数或头部大小），已拒绝解析',
  mht_no_html: 'MHT 文件中没有网页正文，请另存为 docx 后重新导入',
  conversion_failed: '文件解析失败',
});

function entryFailure(code: ParseEntryErrorCode): JobError {
  return new JobError(`PARSE_${code.toUpperCase()}`, ENTRY_MESSAGES[code]);
}

const SOURCE_MAX_BYTES = 128 * 1024 * 1024;

async function readObject(body: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > SOURCE_MAX_BYTES) throw new JobError('PARSE_SOURCE_TOO_LARGE', '原件超过解析大小上限');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

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

/** 表格类格式以文件名作一级标题时的标题（去掉换行与多余空白）。 */
export function cleanHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || '未命名';
}

/**
 * 沙箱数已达上限或 sandbox-runner 暂不可用时，重试创建前的等待（毫秒）；用完仍失败则失败。默认约 5 分钟内重试 8 次。
 */
export const DEFAULT_CREATE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5_000, 10_000, 20_000, 30_000, 45_000, 60_000, 60_000, 60_000]);

async function createSandboxWithRetry(sandbox: SandboxDriver, context: JobContext<unknown>, delays: readonly number[]): Promise<SandboxRef> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sandbox.create('parse', { jobId: context.jobId, signal: context.signal });
    } catch (error) {
      if (!(error instanceof SandboxError)) throw error;
      if (error.code === 'SANDBOX_ABORTED') throw new JobInterruptedError();
      const retryable = error.code === 'SANDBOX_BUSY' || error.code === 'SANDBOX_UNAVAILABLE';
      if (!retryable) throw error;
      if (attempt >= delays.length) {
        throw error.code === 'SANDBOX_BUSY'
          ? new JobError('PARSE_SANDBOX_BUSY', '解析服务繁忙（沙箱数已达上限），请稍后重新导入', { cause: error })
          : new JobError('PARSE_UNAVAILABLE', '解析服务暂不可用，请稍后重新导入', { cause: error });
      }
      await context.log(error.code === 'SANDBOX_BUSY' ? '沙箱数已达上限，稍后重试' : '解析服务暂不可用，稍后重试', { attempt: attempt + 1 });
      await abortableDelay(delays[attempt]!, context.signal);
    }
  }
}

/** 把沙箱操作的错误转成给用户看的原因（中止仍按中止处理）。 */
function sandboxFailure(error: SandboxError): Error {
  if (error.code === 'SANDBOX_ABORTED') return new JobInterruptedError();
  if (error.code === 'SANDBOX_OUTPUT_REJECTED') return new JobError('PARSE_OUTPUT_REJECTED', '解析结果不符合要求，已拒绝', { cause: error });
  if (error.code === 'SANDBOX_UNAVAILABLE') return new JobError('PARSE_UNAVAILABLE', '解析服务暂不可用，请稍后重新导入', { cause: error });
  return new JobError('PARSE_FAILED', '文件解析失败', { cause: error });
}

export interface ParseInSandboxOptions {
  /** 保留图片（images=1）。 */
  images: boolean;
  /** 解析入口另做的逐文档提取（analysis=…，输出 analysis.json）。 */
  analysis?: ParseAnalysis;
  createRetryDelaysMs?: readonly number[];
}

export interface SandboxParseResult {
  format: ParseFormat;
  output: ParsedOutput;
}

/**
 * 在新建的 parse 沙箱中解析一个文件，返回校验过的输出。不支持的格式、原件不存在、解析失败等抛 JobError（给用户看的原因），
 * 输出不符合规则抛 ParseOutputError，中止抛 JobInterruptedError。沙箱在 finally 中销毁。
 */
export async function parseFileInSandbox(context: JobContext<unknown>, file: FileRecord, options: ParseInSandboxOptions): Promise<SandboxParseResult> {
  const dispatch = dispatchParse(file.mime, file.extension);
  if (dispatch.kind === 'unsupported') throw new JobError('PARSE_UNSUPPORTED_FORMAT', '不支持的文件格式');
  if (!context.objectStore || !context.sandbox) throw new JobError('PARSE_UNAVAILABLE', '解析服务暂不可用，请稍后重新导入');
  const objectStore = context.objectStore;
  const sandboxDriver = context.sandbox;

  const object = await objectStore.get(file.storageKey);
  if (!object) throw new JobError('PARSE_SOURCE_MISSING', '原件不存在，请重新上传');
  const inputs: SandboxFile[] = [{ path: 'source', data: await readObject(object.body) }];
  // 表格类格式以文件名作一级标题：Markdown 产物的标题由写入时加上（writeParseArtifacts），逐文档提取在沙箱中进行，标题经文件交给它。
  if (options.analysis && isSpreadsheetFormat(dispatch.format)) inputs.push({ path: 'title', data: Buffer.from(cleanHeading(file.displayName), 'utf8') });

  const sandbox = await createSandboxWithRetry(sandboxDriver, context, options.createRetryDelaysMs ?? DEFAULT_CREATE_RETRY_DELAYS_MS);
  try {
    try {
      await sandboxDriver.copyIn(sandbox, inputs, { signal: context.signal });
      const result = await sandboxDriver.exec(sandbox, 'parse', parseCommandArgs(dispatch, options.images, options.analysis), { signal: context.signal });
      if (result.timedOut) throw new JobError('PARSE_TIMEOUT', '文件解析超时（超过 10 分钟）');
      if (result.exitCode !== 0) throw entryFailure(entryErrorCode(result.stdout));
      return { format: dispatch.format, output: validateParseOutput(await sandboxDriver.copyOut(sandbox, { signal: context.signal }), { analysis: Boolean(options.analysis) }) };
    } catch (error) {
      if (error instanceof SandboxError) throw sandboxFailure(error);
      throw error;
    }
  } finally {
    // 不论成败都销毁（exec 非 0、超时、中止之后同样）；销毁失败只写日志，到期清理兜底。
    await sandboxDriver.destroy(sandbox).catch(() => context.log('沙箱销毁失败，将由到期清理删除').catch(() => {}));
  }
}

export interface WrittenImage {
  artifactId: string;
  /** 图片内容的 SHA-256（十六进制）。 */
  sha256: string;
}

export interface WrittenParse {
  /** 写回 Markdown 产物的正文（图片引用已改写为产物地址，去掉首尾空白）。 */
  markdown: string;
  markdownArtifactId: string;
  /** 正文的 SHA-256（十六进制）。 */
  contentHash: string;
  /** 本次写入的全部产物（图片与 Markdown）。 */
  artifactIds: string[];
  /** 解析输出中的图片路径（images/image-0001.png）→ 写入的产物。 */
  images: Map<string, WrittenImage>;
}

/**
 * 把解析输出写为产物：图片（kind image）与 Markdown（kind markdown），来源文件都是 file、属于 projectId。表格类格式以文件名作一级标题；
 * 引用的图片都在输出中（否则 ParseOutputError），其他图片引用去掉；正文为空抛 JobError（PARSE_EMPTY）。
 * 写了一半时出错，已写入的产物由调用方标为已被替换（supersedeArtifacts）。
 */
export async function writeParseArtifacts(
  context: JobContext<unknown>,
  projectId: string,
  file: FileRecord,
  parsed: SandboxParseResult,
  onWritten?: (artifactId: string) => void,
): Promise<WrittenParse> {
  const { db, tenant } = context;
  const objectStore = context.objectStore;
  if (!objectStore) throw new JobError('PARSE_UNAVAILABLE', '解析服务暂不可用，请稍后重新导入');
  let markdown = parsed.output.markdown;
  if (isSpreadsheetFormat(parsed.format)) markdown = `# ${cleanHeading(file.displayName)}\n\n${markdown}`;
  if (!markdown.trim()) throw new JobError('PARSE_EMPTY', '未提取到有效 Markdown 内容，请检查文件内容');

  const artifactIds: string[] = [];
  const images = new Map<string, WrittenImage>();
  const urls = new Map<string, string>();
  for (const image of parsed.output.images) {
    const record = await writeArtifact(db, tenant, objectStore, {
      kind: 'image',
      name: image.path.slice('images/'.length),
      mime: image.mime,
      projectId,
      sourceFileId: file.id,
    }, image.data);
    artifactIds.push(record.id);
    onWritten?.(record.id);
    images.set(image.path, { artifactId: record.id, sha256: createHash('sha256').update(image.data).digest('hex') });
    urls.set(image.path, `/api/artifacts/${record.id}/content`);
  }
  // 引用的图片都在输出中（原方案“校验原图资源”），其他图片引用去掉。
  markdown = rewriteImageReferences(markdown, urls).trim();
  if (!markdown) throw new JobError('PARSE_EMPTY', '未提取到有效 Markdown 内容，请检查文件内容');
  const artifact = await writeArtifact(db, tenant, objectStore, {
    kind: 'markdown',
    name: 'content.md',
    mime: 'text/markdown; charset=utf-8',
    projectId,
    sourceFileId: file.id,
  }, Buffer.from(`${markdown}\n`, 'utf8'));
  artifactIds.push(artifact.id);
  onWritten?.(artifact.id);
  return {
    markdown,
    markdownArtifactId: artifact.id,
    contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    artifactIds,
    images,
  };
}

/**
 * 解析失败时给用户看的原因（JobError）。程序错误（数据库或对象存储故障等）返回 null，由调用方按“文件解析失败”处理并交给执行者写日志。
 * missingImageMessage：输出引用了其中没有的图片时的文案。
 */
export function parseFailureOf(error: unknown, missingImageMessage = '解析结果不符合要求，已拒绝'): JobError | null {
  if (error instanceof JobError) return error;
  if (error instanceof ParseOutputError) {
    return error.missingImage ? new JobError('PARSE_IMAGE_MISSING', missingImageMessage) : new JobError('PARSE_OUTPUT_REJECTED', '解析结果不符合要求，已拒绝');
  }
  if (error instanceof AppError && error.code === 'STORAGE_QUOTA_EXCEEDED') return new JobError(error.code, error.message);
  return null;
}
