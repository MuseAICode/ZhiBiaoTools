// 按上传时记录的 MIME 分派解析方式（docs/MIGRATION_PLAN.md 第 6 步“按记录的 MIME 分派”）。files.mime 由上传时的内容检查决定
// （src/files/inspect.ts），解析时不再按扩展名或重新嗅探选择解析器；唯一看扩展名的是 text/html 与 application/xml：
// 同一种内容在 .doc / .wps 中是 Word 文档（LibreOffice），在 .xls 中是表格（SheetJS），扩展名取上传时登记的值（#6 的约定）。
// 文本类格式（RTF、HTML、MHT、Office 2003 XML，6.7）在沙箱中先检查或清理再交给解析器，见 server/sandbox/parse/markupGuard.mjs。

/** 解析入口（server/sandbox/parse/entry.mjs）的 format 参数。 */
export const PARSE_FORMATS = [
  'pdf',
  'docx',
  'xlsx',
  'word-ole',
  'xls-ole',
  'text',
  'markdown',
  'rtf',
  'html-word',
  'html-sheet',
  'mht',
  'word-xml',
  'spreadsheet-xml',
] as const;
export type ParseFormat = (typeof PARSE_FORMATS)[number];
export type ParseCharset = 'utf-8' | 'gb18030';

export type ParseDispatch = { kind: 'parse'; format: ParseFormat; charset: ParseCharset | null } | { kind: 'unsupported' };

const BINARY_FORMATS: Readonly<Record<string, ParseFormat>> = Object.freeze({
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  // OLE 的 .doc / .docx（application/msword）和 .wps（application/vnd.ms-works）：LibreOffice 转 docx 后按 docx 处理。
  'application/msword': 'word-ole',
  'application/vnd.ms-works': 'word-ole',
  'application/vnd.ms-excel': 'xls-ole',
  // 只会以 .doc / .wps 上传（#6），不看扩展名。
  'application/rtf': 'rtf',
  'message/rfc822': 'mht',
});

/** 同一 MIME 按登记的扩展名区分 Word 与表格（#6：HTML 与 Office 2003 XML 只对 .doc / .wps / .xls 放行）。 */
const BY_EXTENSION: Readonly<Record<string, Readonly<Record<string, ParseFormat>>>> = Object.freeze({
  'text/html': Object.freeze({ doc: 'html-word', wps: 'html-word', xls: 'html-sheet' }),
  'application/xml': Object.freeze({ doc: 'word-xml', wps: 'word-xml', xls: 'spreadsheet-xml' }),
});

const TEXT_MIME = /^(text\/plain|text\/markdown); charset=(utf-8|gb18030)$/;

export function dispatchParse(mime: string, extension: string): ParseDispatch {
  if (Object.hasOwn(BINARY_FORMATS, mime)) return { kind: 'parse', format: BINARY_FORMATS[mime]!, charset: null };
  if (Object.hasOwn(BY_EXTENSION, mime)) {
    const formats = BY_EXTENSION[mime]!;
    return Object.hasOwn(formats, extension) ? { kind: 'parse', format: formats[extension]!, charset: null } : { kind: 'unsupported' };
  }
  const text = TEXT_MIME.exec(mime);
  if (text) return { kind: 'parse', format: text[1] === 'text/plain' ? 'text' : 'markdown', charset: text[2] as ParseCharset };
  return { kind: 'unsupported' };
}

/** 解析入口另做的逐文档提取（输出 analysis.json）：duplicate-check 为标书查重的目录、句子、图片位置（6.10）。 */
export type ParseAnalysis = 'duplicate-check';

/** 解析入口的参数（只有分派结果与选项，不含路径和文件名）。 */
export function parseCommandArgs(dispatch: { format: ParseFormat; charset: ParseCharset | null }, images: boolean, analysis?: ParseAnalysis): string[] {
  return [
    `format=${dispatch.format}`,
    `images=${images ? '1' : '0'}`,
    ...(dispatch.charset ? [`charset=${dispatch.charset}`] : []),
    ...(analysis ? [`analysis=${analysis}`] : []),
  ];
}

/** 表格类格式：桌面版以文件名作一级标题，沙箱中不知道文件名，由 worker 加上。 */
export function isSpreadsheetFormat(format: ParseFormat): boolean {
  return format === 'xlsx' || format === 'xls-ole' || format === 'html-sheet' || format === 'spreadsheet-xml';
}
