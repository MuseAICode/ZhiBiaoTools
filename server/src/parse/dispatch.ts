// 按上传时记录的 MIME 分派解析方式（docs/MIGRATION_PLAN.md 第 6 步“按记录的 MIME 分派”）。files.mime 由上传时的内容检查决定
// （src/files/inspect.ts），解析时不再按扩展名或重新嗅探选择解析器；唯一看扩展名的是两种 Office 2003 XML（6.7）。
// 6.6 只做二进制与纯文本格式；RTF、HTML、MHT、Office 2003 XML 由 6.7 逐项满足“第 6 步解析要求”后开放，之前解析失败。

/** 解析入口（server/sandbox/parse/entry.mjs）的 format 参数。 */
export const PARSE_FORMATS = ['pdf', 'docx', 'xlsx', 'word-ole', 'xls-ole', 'text', 'markdown'] as const;
export type ParseFormat = (typeof PARSE_FORMATS)[number];
export type ParseCharset = 'utf-8' | 'gb18030';

export type ParseDispatch =
  | { kind: 'parse'; format: ParseFormat; charset: ParseCharset | null }
  /** 6.7 开放的文本类格式（RTF、HTML、MHT、Office 2003 XML）。 */
  | { kind: 'not-yet-supported' }
  | { kind: 'unsupported' };

const BINARY_FORMATS: Readonly<Record<string, ParseFormat>> = Object.freeze({
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  // OLE 的 .doc / .docx（application/msword）和 .wps（application/vnd.ms-works）：LibreOffice 转 docx 后按 docx 处理。
  'application/msword': 'word-ole',
  'application/vnd.ms-works': 'word-ole',
  'application/vnd.ms-excel': 'xls-ole',
});

const PENDING_MIMES: ReadonlySet<string> = new Set(['application/rtf', 'text/html', 'message/rfc822', 'application/xml']);

const TEXT_MIME = /^(text\/plain|text\/markdown); charset=(utf-8|gb18030)$/;

export function dispatchParse(mime: string): ParseDispatch {
  if (Object.hasOwn(BINARY_FORMATS, mime)) return { kind: 'parse', format: BINARY_FORMATS[mime]!, charset: null };
  const text = TEXT_MIME.exec(mime);
  if (text) return { kind: 'parse', format: text[1] === 'text/plain' ? 'text' : 'markdown', charset: text[2] as ParseCharset };
  if (PENDING_MIMES.has(mime)) return { kind: 'not-yet-supported' };
  return { kind: 'unsupported' };
}

/** 解析入口的参数（只有分派结果，不含路径和文件名）。 */
export function parseCommandArgs(dispatch: { format: ParseFormat; charset: ParseCharset | null }, images: boolean): string[] {
  return [`format=${dispatch.format}`, `images=${images ? '1' : '0'}`, ...(dispatch.charset ? [`charset=${dispatch.charset}`] : [])];
}

/** 表格类格式：桌面版以文件名作一级标题，沙箱中不知道文件名，由 worker 加上。 */
export function isSpreadsheetFormat(format: ParseFormat): boolean {
  return format === 'xlsx' || format === 'xls-ole';
}
