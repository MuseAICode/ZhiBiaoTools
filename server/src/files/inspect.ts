// 上传内容的校验（docs/SERVER_DESIGN.md 第 6.1 节）：按文件内容判断真实类型，必须与扩展名一致；
// 不信任扩展名和浏览器给的 Content-Type，记录的 MIME 由这里根据内容决定。
//
// 以 Transform 流的形式串在上传链路中，边写对象存储边校验，不整体读入内存：
// - 文件头（魔数）在前几个字节到达时就判断，不符立即中断，不必等整个文件传完；
//   没有魔数的文本类格式（.doc / .wps / .xls 的 RTF、HTML、MHT、Office 2003 XML）和文件头前有多余字节的 PDF
//   最多再看前 SNIFF_BYTES 字节；
// - docx / xlsx 是 ZIP，要看中央目录里有没有 [Content_Types].xml 和对应的主文档，中央目录在文件末尾，
//   所以保留最后 TAIL_BYTES 字节，流结束时解析；
// - 文本文件逐块用 fatal 模式解码，必须是合法 UTF-8 或 GB18030（含 GBK），不能含 NUL；
// - 同时计算大小和 SHA-256，超过上限立即中断。
// 任何一项不通过都以 AppError 结束流，上游据此中止上传并删除已写入的部分。
import { createHash, type Hash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { TextDecoder } from 'node:util';
import { AppError } from '../errors.ts';

export type ContentKind =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'ole'
  | 'rtf'
  | 'mht'
  | 'html'
  | 'word-xml'
  | 'spreadsheet-xml'
  | 'text'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'bmp';

/**
 * 扩展名 → 允许的内容类型，与桌面版能导入的内容一致（docs/MIGRATION_PLAN.md 第 4 步“上传白名单与桌面版的差距”）：
 * - .doc / .wps / .xls 也接受改了扩展名的 OOXML（桌面版查重同样兼容），.docx 也接受 OLE 的老 Word 文件；
 * - .doc / .wps 接受各类系统“另存为 doc”的 RTF、HTML、MHT、Word 2003 XML，.xls 接受导出为“xls”的 HTML 表格和
 *   SpreadsheetML 2003 XML。HTML / MHT 只能以这三个扩展名上传，.html / .mht 扩展名不开放。
 */
const EXTENSION_KINDS: Readonly<Record<string, readonly ContentKind[]>> = Object.freeze({
  pdf: ['pdf'],
  docx: ['docx', 'ole'],
  xlsx: ['xlsx'],
  doc: ['ole', 'docx', 'rtf', 'mht', 'html', 'word-xml'],
  wps: ['ole', 'docx', 'rtf', 'mht', 'html', 'word-xml'],
  xls: ['ole', 'xlsx', 'html', 'spreadsheet-xml'],
  txt: ['text'],
  md: ['text'],
  markdown: ['text'],
  png: ['png'],
  jpg: ['jpeg'],
  jpeg: ['jpeg'],
  gif: ['gif'],
  webp: ['webp'],
  bmp: ['bmp'],
});

const OLE_MIME: Readonly<Record<string, string>> = Object.freeze({
  // 扩展名是 .docx、内容是 OLE 的老 Word 文件，按老式 Word 记录和解析。
  docx: 'application/msword',
  doc: 'application/msword',
  wps: 'application/vnd.ms-works',
  xls: 'application/vnd.ms-excel',
});

const KIND_MIME: Readonly<Record<Exclude<ContentKind, 'ole' | 'text'>, string>> = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  rtf: 'application/rtf',
  mht: 'message/rfc822',
  html: 'text/html',
  'word-xml': 'application/xml',
  'spreadsheet-xml': 'application/xml',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
});

/** 判断二进制文件头所需的字节数。 */
const HEAD_BYTES = 16;
/** 文本类格式和带前缀的 PDF 最多看这么多字节；pdfjs 同样只在前 1024 字节内找 %PDF-。 */
export const SNIFF_BYTES = 1024;
/** 需要看 SNIFF_BYTES 才能判断的内容类型。 */
const WIDE_KINDS: readonly ContentKind[] = ['pdf', 'rtf', 'mht', 'html', 'word-xml', 'spreadsheet-xml'];
/** ZIP 中央目录（加上目录尾记录和注释）必须落在最后这么多字节内，否则拒绝。4 MiB 足够容纳数万个条目。 */
export const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100_000;

export function isSupportedExtension(extension: string): boolean {
  return Object.hasOwn(EXTENSION_KINDS, extension);
}

export interface InspectionResult {
  kind: ContentKind;
  mime: string;
  size: number;
  sha256: Buffer;
}

function startsWith(head: Buffer, signature: readonly number[], offset = 0): boolean {
  return head.length >= offset + signature.length && signature.every((byte, index) => head[offset + index] === byte);
}

const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** 按文件头判断二进制格式；ZIP 只返回 'zip'，具体是 docx 还是 xlsx 要看中央目录。 */
function sniffHead(head: Buffer): ContentKind | 'zip' | null {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(head, ZIP_LOCAL)) return 'zip';
  if (startsWith(head, OLE)) return 'ole';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'gif';
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp'; // RIFF....WEBP
  // BM + 4 字节文件大小 + 4 字节保留位（必须为 0）；文件大小在结束时核对。
  if (startsWith(head, [0x42, 0x4d]) && head.length >= 14 && head.readUInt32LE(6) === 0) return 'bmp';
  return null;
}

const MIME_VERSION_LINE = /^mime-version:/i;
const HEADER_LINE = /^[a-z0-9-]+:/i;

/**
 * 判断没有魔数的格式（sniffHead 之后、二进制格式都不符时）。只看开头的结构，不看全文：
 * - RTF：`{\rtf`；
 * - Office 2003 XML：`<?xml` 开头，根元素是 `w:wordDocument`，或含 SpreadsheetML 命名空间；
 * - HTML：`<!doctype html` 或 `<html` 开头（Word、Excel、LibreOffice 导出的都是这样）；
 * - MHT：开头是 MIME 头，头部（第一个空行之前）有 `MIME-Version:`；
 * - PDF：前 SNIFF_BYTES 字节内有 `%PDF-`，且开头不是上面任何一种。
 * 允许 UTF-8 BOM 和开头的空白；UTF-16 编码的文本不识别。
 */
export function sniffWide(head: Buffer): ContentKind | null {
  let start = startsWith(head, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (start < head.length && [0x20, 0x09, 0x0d, 0x0a].includes(head[start]!)) start += 1;
  const text = head.toString('latin1', start);
  const lower = text.toLowerCase();
  if (text.startsWith('{\\rtf')) return 'rtf';
  if (text.startsWith('<?xml')) {
    if (text.includes('<w:wordDocument')) return 'word-xml';
    if (text.includes('urn:schemas-microsoft-com:office:spreadsheet')) return 'spreadsheet-xml';
    return null;
  }
  if (lower.startsWith('<!doctype html') || /^<html[\s>]/.test(lower)) return 'html';
  if (start === 0 && HEADER_LINE.test(text)) {
    const headerEnd = text.search(/\r?\n\r?\n/);
    const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
    if (header.split(/\r?\n/).some((line) => MIME_VERSION_LINE.test(line))) return 'mht';
  }
  if (head.subarray(0, SNIFF_BYTES).includes('%PDF-', 0, 'latin1')) return 'pdf';
  return null;
}

/** 解析 ZIP 尾部，返回中央目录中的条目名；结构不合法、ZIP64 或目录不在 tail 内时返回 null。 */
export function readZipEntryNames(tail: Buffer, totalSize: number): string[] | null {
  const tailStart = totalSize - tail.length;
  // 目录尾记录 22 字节，后面最多 65535 字节注释。从后往前找签名。
  const minIndex = Math.max(0, tail.length - 22 - 0xffff);
  for (let index = tail.length - 22; index >= minIndex; index -= 1) {
    if (tail.readUInt32LE(index) !== 0x06054b50) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength !== tail.length) continue;
    const entryCount = tail.readUInt16LE(index + 10);
    const directorySize = tail.readUInt32LE(index + 12);
    const directoryOffset = tail.readUInt32LE(index + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null;
    if (entryCount > MAX_ZIP_ENTRIES) return null;
    const eocdOffset = tailStart + index;
    if (directoryOffset + directorySize !== eocdOffset || directoryOffset < tailStart) return null;

    const names: string[] = [];
    let cursor = directoryOffset - tailStart;
    for (let entry = 0; entry < entryCount; entry += 1) {
      if (cursor + 46 > index || tail.readUInt32LE(cursor) !== 0x02014b50) return null;
      const nameLength = tail.readUInt16LE(cursor + 28);
      const extraLength = tail.readUInt16LE(cursor + 30);
      const entryCommentLength = tail.readUInt16LE(cursor + 32);
      const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
      if (end > index) return null;
      names.push(tail.toString('latin1', cursor + 46, cursor + 46 + nameLength));
      cursor = end;
    }
    return cursor === index ? names : null;
  }
  return null;
}

function rejectType(): AppError {
  return new AppError(415, 'FILE_TYPE_MISMATCH', '文件内容与扩展名不符或格式不受支持');
}

export interface InspectorOptions {
  extension: string;
  /** 超过即中断。 */
  maxBytes: number;
  /** 超过 maxBytes 时的错误，由调用方决定是单文件上限还是配额。 */
  tooLarge: () => AppError;
}

/** 校验流：原样透传数据，结束时 result 可用；不通过时以 AppError 报错。 */
export class InspectionStream extends Transform {
  #options: InspectorOptions;
  #allowed: readonly ContentKind[];
  #hash: Hash = createHash('sha256');
  #size = 0;
  #head = Buffer.alloc(0);
  #headKind: ContentKind | 'zip' | null | undefined;
  /** 文件头不是已知的二进制格式时，是否再看前 SNIFF_BYTES 字节。 */
  #wideSniff: boolean;
  #tail: Buffer[] = [];
  #tailLength = 0;
  #utf8: TextDecoder | null = null;
  #gb18030: TextDecoder | null = null;
  #result: InspectionResult | null = null;

  constructor(options: InspectorOptions) {
    super();
    this.#options = options;
    const allowed = EXTENSION_KINDS[options.extension];
    if (!allowed) throw rejectType();
    this.#allowed = allowed;
    this.#wideSniff = allowed.some((kind) => WIDE_KINDS.includes(kind));
    if (allowed.includes('text')) {
      this.#utf8 = new TextDecoder('utf-8', { fatal: true });
      this.#gb18030 = new TextDecoder('gb18030', { fatal: true });
    }
  }

  get result(): InspectionResult {
    if (!this.#result) throw new Error('inspection has not finished');
    return this.#result;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.#consume(chunk);
    } catch (error) {
      callback(error as Error);
      return;
    }
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.#result = this.#finish();
    } catch (error) {
      callback(error as Error);
      return;
    }
    callback();
  }

  #consume(chunk: Buffer): void {
    this.#size += chunk.length;
    if (this.#size > this.#options.maxBytes) throw this.#options.tooLarge();
    this.#hash.update(chunk);

    if (this.#headKind === undefined) {
      this.#head = Buffer.concat([this.#head, chunk.subarray(0, SNIFF_BYTES - this.#head.length)]);
      if (this.#head.length >= HEAD_BYTES) this.#decideHead(false);
    }
    if (this.#headKind === 'zip' || this.#headKind === undefined) this.#keepTail(chunk);
    if (this.#utf8) this.#decodeText(chunk);
  }

  /** 文件头已足够判断：不在允许的集合中就立即拒绝。final 表示文件已经结束，不会再有更多字节。 */
  #decideHead(final: boolean): void {
    let kind = sniffHead(this.#head);
    if (this.#allowed.includes('text')) {
      this.#headKind = kind;
      // 文本文件没有魔数；但明显是二进制格式的（PDF、ZIP、OLE、图片）直接拒绝，不必等解码失败。
      // BMP 的 “BM” 太短，正常文本也可能以它开头，不在此列。
      if (kind !== null && kind !== 'bmp') throw rejectType();
      return;
    }
    if (kind === null && this.#wideSniff) {
      if (!final && this.#head.length < SNIFF_BYTES) return; // 等更多字节
      kind = sniffWide(this.#head);
    }
    this.#headKind = kind;
    const zipAllowed = this.#allowed.includes('docx') || this.#allowed.includes('xlsx');
    if (kind === null || (kind === 'zip' ? !zipAllowed : !this.#allowed.includes(kind))) throw rejectType();
    if (kind !== 'zip') {
      this.#tail = [];
      this.#tailLength = 0;
    }
  }

  #keepTail(chunk: Buffer): void {
    this.#tail.push(chunk);
    this.#tailLength += chunk.length;
    while (this.#tail.length > 1 && this.#tailLength - this.#tail[0]!.length >= TAIL_BYTES) {
      this.#tailLength -= this.#tail.shift()!.length;
    }
  }

  #decodeText(chunk: Buffer): void {
    if (chunk.includes(0)) throw rejectType();
    if (this.#utf8) {
      try {
        this.#utf8.decode(chunk, { stream: true });
      } catch {
        this.#utf8 = null;
      }
    }
    if (this.#gb18030) {
      try {
        this.#gb18030.decode(chunk, { stream: true });
      } catch {
        this.#gb18030 = null;
      }
    }
    if (!this.#utf8 && !this.#gb18030) throw rejectType();
  }

  #finish(): InspectionResult {
    if (this.#size === 0) throw new AppError(400, 'FILE_EMPTY', '文件为空');
    if (this.#headKind === undefined) this.#decideHead(true);
    const extension = this.#options.extension;
    const sha256 = this.#hash.digest();
    const done = (kind: ContentKind, mime: string): InspectionResult => ({ kind, mime, size: this.#size, sha256 });

    if (this.#allowed.includes('text')) {
      const charset = this.#finishText();
      const type = extension === 'txt' ? 'text/plain' : 'text/markdown';
      return done('text', `${type}; charset=${charset}`);
    }
    const kind = this.#headKind;
    if (kind === 'zip') {
      const tail = Buffer.concat(this.#tail);
      const names = readZipEntryNames(tail.subarray(Math.max(0, tail.length - TAIL_BYTES)), this.#size);
      if (!names || !names.includes('[Content_Types].xml')) throw rejectType();
      const ooxml: ContentKind | null = names.includes('word/document.xml') ? 'docx' : names.includes('xl/workbook.xml') ? 'xlsx' : null;
      if (ooxml === null || !this.#allowed.includes(ooxml)) throw rejectType();
      return done(ooxml, KIND_MIME[ooxml]);
    }
    if (kind === 'ole') return done('ole', OLE_MIME[extension] ?? 'application/octet-stream');
    if (kind === null || kind === undefined || kind === 'text') throw rejectType();
    if (kind === 'bmp') {
      const declared = this.#head.readUInt32LE(2);
      if (declared !== 0 && declared !== this.#size) throw rejectType();
    }
    return done(kind, KIND_MIME[kind]);
  }

  #finishText(): 'utf-8' | 'gb18030' {
    for (const [decoder, charset] of [
      [this.#utf8, 'utf-8'],
      [this.#gb18030, 'gb18030'],
    ] as const) {
      if (!decoder) continue;
      try {
        decoder.decode();
        return charset;
      } catch {
        // 末尾是不完整的多字节序列，试下一种编码。
      }
    }
    throw rejectType();
  }
}
