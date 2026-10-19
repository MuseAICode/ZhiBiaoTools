// 上传内容的校验（docs/SERVER_DESIGN.md 第 6.1 节）：按文件内容判断真实类型，必须与扩展名一致；
// 不信任扩展名和浏览器给的 Content-Type，记录的 MIME 由这里根据内容决定。
//
// 以 Transform 流的形式串在上传链路中，边写对象存储边校验，不整体读入内存：
// - 文件头（魔数）在前几个字节到达时就判断，不符立即中断，不必等整个文件传完；
// - docx / xlsx 是 ZIP，要看中央目录里有没有 [Content_Types].xml 和对应的主文档，中央目录在文件末尾，
//   所以保留最后 TAIL_BYTES 字节，流结束时解析；
// - 文本文件逐块用 fatal 模式解码，必须是合法 UTF-8 或 GB18030（含 GBK），不能含 NUL；
// - 同时计算大小和 SHA-256，超过上限立即中断。
// 任何一项不通过都以 AppError 结束流，上游据此中止上传并删除已写入的部分。
import { createHash, type Hash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { TextDecoder } from 'node:util';
import { AppError } from '../errors.ts';

export type ContentKind = 'pdf' | 'docx' | 'xlsx' | 'ole' | 'text' | 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp';

/** 扩展名 → 允许的内容类型。.doc / .wps / .xls 也接受改了扩展名的 OOXML（桌面版查重同样兼容）。 */
const EXTENSION_KINDS: Readonly<Record<string, readonly ContentKind[]>> = Object.freeze({
  pdf: ['pdf'],
  docx: ['docx'],
  xlsx: ['xlsx'],
  doc: ['ole', 'docx'],
  wps: ['ole', 'docx'],
  xls: ['ole', 'xlsx'],
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
  doc: 'application/msword',
  wps: 'application/vnd.ms-works',
  xls: 'application/vnd.ms-excel',
});

const KIND_MIME: Readonly<Record<Exclude<ContentKind, 'ole' | 'text'>, string>> = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
});

/** 判断文件头所需的字节数。 */
const HEAD_BYTES = 16;
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
      this.#head = Buffer.concat([this.#head, chunk.subarray(0, HEAD_BYTES - this.#head.length)]);
      if (this.#head.length >= HEAD_BYTES) this.#decideHead();
    }
    if (this.#headKind === 'zip' || this.#headKind === undefined) this.#keepTail(chunk);
    if (this.#utf8) this.#decodeText(chunk);
  }

  /** 文件头已足够判断：二进制格式不在允许的集合中就立即拒绝。 */
  #decideHead(): void {
    const kind = sniffHead(this.#head);
    this.#headKind = kind;
    if (this.#allowed.includes('text')) {
      // 文本文件没有魔数；但明显是二进制格式的（PDF、ZIP、OLE、图片）直接拒绝，不必等解码失败。
      // BMP 的 “BM” 太短，正常文本也可能以它开头，不在此列。
      if (kind !== null && kind !== 'bmp') throw rejectType();
      return;
    }
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
    if (this.#headKind === undefined) this.#decideHead();
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
