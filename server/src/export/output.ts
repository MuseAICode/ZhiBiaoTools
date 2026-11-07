// export 沙箱输出的校验（路线图第 7 步“输出校验”）。归档本身（只有普通文件、document.docx 与 result.json、大小上限）已由
// src/sandbox/archive.ts 按 export 模板校验；这里再校验内容：
// - 必须正好是 document.docx 与 result.json；
// - result.json 是合法 UTF-8 的 JSON，只能有 version（1）、blockCount（非负整数）、imageWarnings（对象数组，每项只有字符串
//   assetRef 与 reason）三个字段，长度在上限内。返回时只保留 blockCount 与告警的 assetRef：reason 是助手的文字，
//   给用户的提示由调用方按代码决定，不直接采用（与 6.6 相同）；
// - docx 经 assertSafeDocx 检查 ZIP 结构、条目数与解压大小（src/export/docxGuard.ts）。
// 入口失败时只采用它在标准输出最后一行给出的错误代码（白名单内），不采用任何文字。
import type { SandboxFile } from '../sandbox/archive.ts';
import { assertSafeDocx, DocxGuardError } from './docxGuard.ts';

export const EXPORT_DOCX_NAME = 'document.docx';
export const EXPORT_RESULT_NAME = 'result.json';

/** 入口写给 result.json 的上限（server/sandbox/export/entry.mjs）：告警至多 2,000 条，assetRef 256 个字符，reason 200 个字符。 */
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_WARNINGS = 2_000;
const MAX_ASSET_REF_CHARS = 256;
const MAX_REASON_CHARS = 200;

/** 导出入口给出的错误代码（server/sandbox/export/entry.mjs）。 */
export const EXPORT_ENTRY_ERROR_CODES = [
  'bad_arguments',
  'request_invalid',
  'too_many_images',
  'chrome_render_failed',
  'helper_failed',
  'helper_timeout',
  'output_too_large',
  /** 整本导出：WebP 配图转成 PNG 后输入合计超过上限（7.4i）。 */
  'images_too_large',
  'export_failed',
] as const;
export type ExportEntryErrorCode = (typeof EXPORT_ENTRY_ERROR_CODES)[number];

/** 导出输出不符合规则。reason 是固定的英文短语，不含输出中的内容。 */
export class ExportOutputError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super(`export output rejected: ${reason}`, options);
    this.name = 'ExportOutputError';
    this.reason = reason;
  }
}

export interface ExportOutput {
  docx: Buffer;
  blockCount: number;
  /** 助手报告无法嵌入的配图（data-app-asset-ref）。 */
  imageWarnings: string[];
}

/** 标准输出最后一个非空行的 {"error":"代码"}；不是白名单内的代码时返回 export_failed。 */
export function exportEntryErrorCode(stdout: string): ExportEntryErrorCode {
  const line = stdout.split('\n').map((item) => item.trim()).filter(Boolean).at(-1) ?? '';
  try {
    const code = (JSON.parse(line) as { error?: unknown }).error;
    if (typeof code === 'string' && (EXPORT_ENTRY_ERROR_CODES as readonly string[]).includes(code)) return code as ExportEntryErrorCode;
  } catch {
    // 不是 JSON。
  }
  return 'export_failed';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResult(data: Buffer): { blockCount: number; imageWarnings: string[] } {
  if (data.length > MAX_RESULT_BYTES) throw new ExportOutputError('result.json is too large');
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new ExportOutputError('result.json is not valid json');
  }
  if (!isPlainObject(result)) throw new ExportOutputError('result.json is not an object');
  const { version, blockCount, imageWarnings, ...rest } = result;
  if (version !== 1 || Object.keys(rest).length > 0) throw new ExportOutputError('result.json has an unexpected shape');
  if (typeof blockCount !== 'number' || !Number.isSafeInteger(blockCount) || blockCount < 0) throw new ExportOutputError('blockCount is not a non-negative integer');
  if (!Array.isArray(imageWarnings) || imageWarnings.length > MAX_WARNINGS) throw new ExportOutputError('imageWarnings is not a bounded array');
  const refs = imageWarnings.map((item) => {
    if (!isPlainObject(item)) throw new ExportOutputError('image warning is not an object');
    const { assetRef, reason, ...other } = item;
    if (Object.keys(other).length > 0) throw new ExportOutputError('image warning has an unexpected shape');
    if (typeof assetRef !== 'string' || assetRef.length > MAX_ASSET_REF_CHARS) throw new ExportOutputError('image warning assetRef is not a bounded string');
    if (typeof reason !== 'string' || reason.length > MAX_REASON_CHARS) throw new ExportOutputError('image warning reason is not a bounded string');
    return assetRef;
  });
  return { blockCount, imageWarnings: refs };
}

/** 校验导出输出（归档已由 src/sandbox/archive.ts 校验）。不符时抛 ExportOutputError。 */
export async function validateExportOutput(files: readonly SandboxFile[]): Promise<ExportOutput> {
  const names = files.map((file) => file.path).sort();
  if (names.length !== 2 || names[0] !== EXPORT_DOCX_NAME || names[1] !== EXPORT_RESULT_NAME) {
    throw new ExportOutputError('output must contain only document.docx and result.json');
  }
  const docx = files.find((file) => file.path === EXPORT_DOCX_NAME)!.data;
  const result = parseResult(files.find((file) => file.path === EXPORT_RESULT_NAME)!.data);
  try {
    await assertSafeDocx(docx);
  } catch (error) {
    if (error instanceof DocxGuardError) throw new ExportOutputError(`document.docx: ${error.reason}`, { cause: error });
    throw error;
  }
  return { docx, ...result };
}
