// 文档解析任务（路线图第 6 步 6.6；docs/SERVER_DESIGN.md 第 6.2、7.5 节）：document-parse，parse 队列。
// 技术方案（招标文件、原方案）、废标检查、可研报告导入文件后自动入队（src/parse/enqueue.ts），一个文件一个任务。
//
// 流程：文档标为解析中 → 按记录的 MIME 分派（src/parse/dispatch.ts）→ 从对象存储取出原件 → 新建 parse 沙箱（断网）→
// copyIn → 执行解析入口 → copyOut（归档按模板校验）→ 校验输出内容（src/parse/output.ts）→ 经 writeArtifact 写入图片和
// Markdown → 经各模块的 saveDocumentParse / saveSourceParse 写回文档 → 把该文件之前的产物标为已被替换（迁移 0023）。
// 沙箱在 finally 中销毁（exec 的任何非 0 结果之后都不复用，6.5 的约定）；sandbox-runner 的到期清理（15 分钟）是兜底。
//
// - 任务进程内不解析上传的内容：原件只经 copyIn 交给沙箱，取回的结果按不可信输入校验；
// - 失败时文档标为 error，写给用户看的原因（文案由代码决定，不采用沙箱输出的文字），任务以同一代码失败；
// - 沙箱数已达上限（SANDBOX_BUSY）或 sandbox-runner 暂不可用时按可重试处理：按退避间隔重试创建，仍不行才失败；
// - 可续跑：worker 崩溃或关闭后从头重新解析，上一次写了一半的产物在成功后一并标为已被替换；
// - 文档在解析中被移除（原件进回收站）时，写回影响 0 行，任务直接结束。
import { createHash } from 'node:crypto';
import { writeArtifact, supersedeArtifacts } from '../artifacts/store.ts';
import { AppError } from '../errors.ts';
import { findFile } from '../files/store.ts';
import { JobError, JobInterruptedError, type JobContext, type JobTypeDefinition } from '../jobs/definitions.ts';
import { saveSourceParse } from '../feasibilityReport/store.ts';
import { saveDocumentParse as saveRejectionCheckDocumentParse } from '../rejectionCheck/store.ts';
import { SandboxError, type SandboxDriver, type SandboxRef } from '../sandbox/driver.ts';
import { saveDocumentParse as saveTechnicalPlanDocumentParse } from '../technicalPlan/store.ts';
import { dispatchParse, isSpreadsheetFormat, parseCommandArgs } from './dispatch.ts';
import { entryErrorCode, ParseOutputError, rewriteImageReferences, validateParseOutput, type ParseEntryErrorCode } from './output.ts';

export const DOCUMENT_PARSE_JOB_TYPE = 'document-parse';

/** 解析结果写回到哪个模块的文档；只有原方案保留图片（桌面版 importOriginalPlanDocument 的 preserveImages）。 */
export const PARSE_TARGETS = ['technical-plan-tender', 'technical-plan-original-plan', 'rejection-check', 'feasibility-report'] as const;
export type ParseTarget = (typeof PARSE_TARGETS)[number];

export interface DocumentParseParams {
  target: ParseTarget;
  fileId: string;
}

/** 写回文档的字段（三个模块的 saveDocumentParse / saveSourceParse 相同）。 */
interface ParseResultInput {
  status?: 'pending' | 'running' | 'success' | 'error';
  markdownArtifactId?: string | null;
  contentChars?: number;
  contentHash?: string | null;
  parserLabel?: string | null;
  error?: string | null;
}

type SaveParse = (db: JobContext<unknown>['db'], context: JobContext<unknown>['tenant'], projectId: string, fileId: string, input: ParseResultInput) => Promise<boolean>;

const SAVE_BY_TARGET: Readonly<Record<ParseTarget, SaveParse>> = Object.freeze({
  'technical-plan-tender': saveTechnicalPlanDocumentParse,
  'technical-plan-original-plan': saveTechnicalPlanDocumentParse,
  'rejection-check': saveRejectionCheckDocumentParse,
  'feasibility-report': saveSourceParse,
});

/** 与桌面版的“本地解析”相同（MinerU 第一版不提供）。 */
export const LOCAL_PARSER_LABEL = '本地解析';

/** 同一文件同时只有一个解析任务（jobs 的部分唯一索引）。 */
export function documentParseLockKey(fileId: string): string {
  return `document-parse:${fileId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseParams(raw: unknown): DocumentParseParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('解析任务参数不合法');
  const { target, fileId, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new TypeError('解析任务参数不合法');
  if (typeof target !== 'string' || !(PARSE_TARGETS as readonly string[]).includes(target)) throw new TypeError('解析目标不合法');
  if (typeof fileId !== 'string' || !UUID.test(fileId)) throw new TypeError('文件 id 不合法');
  return { target: target as ParseTarget, fileId };
}

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

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
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

function cleanHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || '未命名';
}

export interface DocumentParseJobOptions {
  /**
   * 沙箱数已达上限或 sandbox-runner 暂不可用时，重试创建前的等待（毫秒）；用完仍失败则任务失败。
   * 默认约 5 分钟内重试 8 次。
   */
  createRetryDelaysMs?: readonly number[];
}

const DEFAULT_CREATE_RETRY_DELAYS_MS = Object.freeze([5_000, 10_000, 20_000, 30_000, 45_000, 60_000, 60_000, 60_000]);

async function createSandboxWithRetry(sandbox: SandboxDriver, context: JobContext<DocumentParseParams>, delays: readonly number[]): Promise<SandboxRef> {
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

export function createDocumentParseJob(options: DocumentParseJobOptions = {}): JobTypeDefinition<DocumentParseParams> {
  const retryDelays = options.createRetryDelaysMs ?? DEFAULT_CREATE_RETRY_DELAYS_MS;

  async function parse(context: JobContext<DocumentParseParams>, projectId: string, save: SaveParse): Promise<void> {
    const { db, tenant, params } = context;
    const file = await findFile(db, tenant, params.fileId);
    // 原件已删除，或不属于本项目（参数由服务端生成，这里只是防御）：按文档已移除处理。
    if (!file || file.projectId !== projectId) return;
    const dispatch = dispatchParse(file.mime, file.extension);
    if (dispatch.kind === 'unsupported') throw new JobError('PARSE_UNSUPPORTED_FORMAT', '不支持的文件格式');
    if (!context.objectStore || !context.sandbox) throw new JobError('PARSE_UNAVAILABLE', '解析服务暂不可用，请稍后重新导入');
    const objectStore = context.objectStore;
    const sandboxDriver = context.sandbox;

    const object = await objectStore.get(file.storageKey);
    if (!object) throw new JobError('PARSE_SOURCE_MISSING', '原件不存在，请重新上传');
    const source = await readObject(object.body);
    const images = params.target === 'technical-plan-original-plan';

    const sandbox = await createSandboxWithRetry(sandboxDriver, context, retryDelays);
    let output;
    try {
      try {
        await sandboxDriver.copyIn(sandbox, [{ path: 'source', data: source }], { signal: context.signal });
        const result = await sandboxDriver.exec(sandbox, 'parse', parseCommandArgs(dispatch, images), { signal: context.signal });
        if (result.timedOut) throw new JobError('PARSE_TIMEOUT', '文件解析超时（超过 10 分钟）');
        if (result.exitCode !== 0) throw entryFailure(entryErrorCode(result.stdout));
        output = validateParseOutput(await sandboxDriver.copyOut(sandbox, { signal: context.signal }));
      } catch (error) {
        if (error instanceof SandboxError) throw sandboxFailure(error);
        throw error;
      }
    } finally {
      // 不论成败都销毁（exec 非 0、超时、中止之后同样）；销毁失败只写日志，到期清理兜底。
      await sandboxDriver.destroy(sandbox).catch(() => context.log('沙箱销毁失败，将由到期清理删除').catch(() => {}));
    }

    let markdown = output.markdown;
    if (isSpreadsheetFormat(dispatch.format)) markdown = `# ${cleanHeading(file.displayName)}\n\n${markdown}`;
    if (!markdown.trim()) throw new JobError('PARSE_EMPTY', '未提取到有效 Markdown 内容，请检查文件内容');
    await context.setProgress(60);

    const written: string[] = [];
    const urls = new Map<string, string>();
    for (const image of output.images) {
      const record = await writeArtifact(db, tenant, objectStore, {
        kind: 'image',
        name: image.path.slice('images/'.length),
        mime: image.mime,
        projectId,
        sourceFileId: file.id,
      }, image.data);
      written.push(record.id);
      urls.set(image.path, `/api/artifacts/${record.id}/content`);
    }
    // 引用的图片都在输出中（原方案“校验原图资源”），其他图片引用去掉。
    markdown = rewriteImageReferences(markdown, urls).trim();
    if (!markdown) throw new JobError('PARSE_EMPTY', '未提取到有效 Markdown 内容，请检查文件内容');
    const content = Buffer.from(`${markdown}\n`, 'utf8');
    const artifact = await writeArtifact(db, tenant, objectStore, {
      kind: 'markdown',
      name: 'content.md',
      mime: 'text/markdown; charset=utf-8',
      projectId,
      sourceFileId: file.id,
    }, content);
    written.push(artifact.id);

    // 写回之前确认仍持有租约（已被收回时抛 JobInterruptedError，由新的执行者重新解析）。
    await context.setProgress(90);
    const saved = await save(db, tenant, projectId, file.id, {
      status: 'success',
      markdownArtifactId: artifact.id,
      contentChars: markdown.length,
      contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
      parserLabel: LOCAL_PARSER_LABEL,
      error: null,
    });
    // 文档已移除：本次写入的产物与之前的一起标为已被替换。
    await supersedeArtifacts(db, tenant, file.id, saved ? written : []);
    await context.log(saved ? '解析完成' : '文档已移除，解析结果已丢弃', { images: output.images.length, chars: markdown.length });
  }

  return {
    type: DOCUMENT_PARSE_JOB_TYPE,
    queue: 'parse',
    resumable: true,
    parseParams,
    async run(context) {
      const { db, tenant, params } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('PARSE_FAILED', '文件解析失败');
      const save = SAVE_BY_TARGET[params.target];
      if (!(await save(db, tenant, projectId, params.fileId, { status: 'running', error: null }))) {
        await context.log('文档已移除，跳过解析');
        return;
      }
      try {
        await parse(context, projectId, save);
      } catch (error) {
        const reason = context.signal.reason as unknown;
        // 租约丢失、worker 关闭、暂停：不写文档（由续跑的执行者继续）。取消：文档标为失败。
        if (context.signal.aborted && reason !== 'cancel') throw error;
        if (error instanceof JobInterruptedError && reason !== 'cancel') throw error;
        let failure: JobError;
        let unexpected: unknown = null;
        if (context.signal.aborted) failure = new JobError('PARSE_CANCELLED', '解析已取消');
        else if (error instanceof JobError) failure = error;
        else if (error instanceof ParseOutputError) {
          failure = error.missingImage
            ? new JobError('PARSE_IMAGE_MISSING', '原方案图片资源缺失，请重新导入原 Word')
            : new JobError('PARSE_OUTPUT_REJECTED', '解析结果不符合要求，已拒绝');
        } else if (error instanceof AppError && error.code === 'STORAGE_QUOTA_EXCEEDED') failure = new JobError(error.code, error.message);
        // 其他错误（程序错误、数据库或对象存储故障）：文档同样标为失败，原错误交给执行者写日志（任务记为 JOB_FAILED）。
        else {
          unexpected = error;
          failure = new JobError('PARSE_FAILED', '文件解析失败');
        }
        await save(db, tenant, projectId, params.fileId, {
          status: 'error',
          markdownArtifactId: null,
          contentChars: 0,
          contentHash: null,
          error: failure.message,
        });
        // 写了一半的产物（例如写到一半超出配额）和之前的产物都标为已被替换。
        await supersedeArtifacts(db, tenant, params.fileId, []);
        throw unexpected ?? failure;
      }
    },
  };
}

export const documentParseJob = createDocumentParseJob();
