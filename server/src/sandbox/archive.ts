// 进出沙箱的 tar 归档（docs/SERVER_DESIGN.md 第 7.3、7.5 节）。不依赖第三方库。
//
// 写（copyIn）：只写普通文件，ustar 格式，路径由调用方给出、先按同样的规则校验。
// 读（copyOut）：归档由沙箱内的 tar 生成，沙箱内的代码可以控制它的全部内容（例如 ptrace 同一用户的 tar 进程），
// 所以按不可信输入逐项校验，任何一项不符即整体拒绝：
// - 只收普通文件（和目录，目录本身不产出），拒绝符号链接、硬链接、设备文件、FIFO、稀疏文件和其他类型；
// - 路径相对、按段校验（不能有 ..、空段、反斜杠、控制字符），段数、文件数、单个文件和总大小在上限内，扩展名在白名单内；
// - 同一路径不能出现两次；头部校验和必须正确；必须以结束块收尾（被截断的归档不收）。
import type { SandboxTransferLimits } from './templates.ts';

const BLOCK = 512;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PATH_LENGTH = 255;
/** PAX / GNU 长名扩展头的大小上限：只用来带路径，不需要更多。 */
const MAX_EXTENDED_HEADER_BYTES = 8 * 1024;

export interface SandboxFile {
  /** 相对路径，段之间用 /，例如 content.md、images/image-001.png。 */
  readonly path: string;
  readonly data: Buffer;
}

/** 归档不符合规则。reason 是固定的英文短语，不含归档中的文件名和内容。 */
export class SandboxArchiveError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`sandbox archive rejected: ${reason}`);
    this.name = 'SandboxArchiveError';
    this.reason = reason;
  }
}

/** 校验相对路径；返回规范化的路径（去掉开头的 ./），目录（以 / 结尾或 isDirectory）返回去掉末尾 / 的路径。 */
export function validateRelativePath(raw: string, limits: SandboxTransferLimits, isDirectory: boolean): string {
  let path = raw;
  while (path.startsWith('./')) path = path.slice(2);
  if (path.endsWith('/')) {
    if (!isDirectory) throw new SandboxArchiveError('file path ends with a slash');
    path = path.slice(0, -1);
  }
  if (path === '.' || path === '') {
    if (isDirectory) return '';
    throw new SandboxArchiveError('empty path');
  }
  if (path.length > MAX_PATH_LENGTH) throw new SandboxArchiveError('path too long');
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') throw new SandboxArchiveError('path traversal');
    if (!SEGMENT_PATTERN.test(segment)) throw new SandboxArchiveError('path segment not allowed');
  }
  if (segments.length > (isDirectory ? limits.maxDepth - 1 : limits.maxDepth)) throw new SandboxArchiveError('path too deep');
  if (!isDirectory && limits.extensions) {
    const name = segments[segments.length - 1]!;
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (!limits.extensions.has(extension)) throw new SandboxArchiveError('file extension not allowed');
  }
  return path;
}

function writeString(header: Buffer, offset: number, length: number, value: string) {
  header.write(value, offset, length, 'utf8');
}

function writeOctal(header: Buffer, offset: number, length: number, value: number) {
  // length - 1 位八进制数字 + NUL。
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

/** 生成只含普通文件的 ustar 归档（copyIn）。路径按 limits 校验，不合法时抛 SandboxArchiveError。 */
export function createArchive(files: readonly SandboxFile[], limits: SandboxTransferLimits): Buffer {
  if (files.length > limits.maxFiles) throw new SandboxArchiveError('too many files');
  const parts: Buffer[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const path = validateRelativePath(file.path, limits, false);
    if (path.length > 100) throw new SandboxArchiveError('path too long');
    if (seen.has(path)) throw new SandboxArchiveError('duplicate path');
    seen.add(path);
    if (file.data.length > limits.maxFileBytes) throw new SandboxArchiveError('file too large');
    total += file.data.length;
    if (total > limits.maxTotalBytes) throw new SandboxArchiveError('archive too large');

    const header = Buffer.alloc(BLOCK);
    writeString(header, 0, 100, path);
    writeOctal(header, 100, 8, 0o600);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, file.data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    parts.push(header, file.data);
    const padding = (BLOCK - (file.data.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** 按需读取固定字节数的流式读取器；超过 maxBytes 即拒绝（不再读入更多数据）。 */
class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private consumed = 0;
  private done = false;
  private readonly maxBytes: number;

  constructor(source: AsyncIterable<Uint8Array>, maxBytes: number) {
    this.iterator = source[Symbol.asyncIterator]();
    this.maxBytes = maxBytes;
  }

  /** 读取正好 length 字节；数据不够（流已结束）时返回 null。 */
  async read(length: number): Promise<Buffer | null> {
    while (this.bufferedBytes < length && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      this.consumed += chunk.length;
      if (this.consumed > this.maxBytes) {
        await this.close();
        throw new SandboxArchiveError('archive too large');
      }
      this.buffered.push(chunk);
      this.bufferedBytes += chunk.length;
    }
    if (this.bufferedBytes < length) return null;
    const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered);
    const result = all.subarray(0, length);
    const rest = all.subarray(length);
    this.buffered = rest.length > 0 ? [rest] : [];
    this.bufferedBytes = rest.length;
    return result;
  }

  /** 结束块之后的数据不再读取，释放上游（例如中止 HTTP 响应或沙箱内的 tar）。 */
  async close(): Promise<void> {
    if (!this.done) {
      this.done = true;
      await this.iterator.return?.();
    }
  }
}

function readString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length);
  // 首字节最高位为 1 是 base-256 编码（超过 8 GiB 的文件），一律拒绝。
  if ((field[0]! & 0x80) !== 0) throw new SandboxArchiveError('size field not supported');
  const text = field.toString('ascii').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (text === '') return 0;
  if (!/^[0-7]{1,11}$/.test(text)) throw new SandboxArchiveError('malformed header');
  return Number.parseInt(text, 8);
}

function verifyChecksum(header: Buffer) {
  const expected = readOctal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  if (sum !== expected) throw new SandboxArchiveError('header checksum mismatch');
}

/** PAX 扩展头：每条记录为“长度 空格 键=值\n”。只采用 path，出现 size、linkpath 等改变条目含义的键一律拒绝。 */
function parsePaxPath(data: Buffer): string | null {
  let offset = 0;
  let path: string | null = null;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new SandboxArchiveError('malformed pax header');
    const lengthText = data.subarray(offset, space).toString('ascii');
    if (!/^\d{1,5}$/.test(lengthText)) throw new SandboxArchiveError('malformed pax header');
    const length = Number(lengthText);
    if (length <= space - offset + 1 || offset + length > data.length) throw new SandboxArchiveError('malformed pax header');
    const record = data.subarray(space + 1, offset + length);
    if (record[record.length - 1] !== 0x0a) throw new SandboxArchiveError('malformed pax header');
    const text = record.subarray(0, -1).toString('utf8');
    const equals = text.indexOf('=');
    if (equals <= 0) throw new SandboxArchiveError('malformed pax header');
    const key = text.slice(0, equals);
    const value = text.slice(equals + 1);
    if (key === 'path') path = value;
    else if (key === 'size' || key === 'linkpath' || key.startsWith('GNU.sparse')) throw new SandboxArchiveError('pax key not supported');
    // 其他键（mtime、atime、ctime、uid、gid、uname、gname 等）不影响取回的内容，忽略。
    offset += length;
  }
  return path;
}

async function readPadded(reader: ByteReader, size: number): Promise<Buffer> {
  const padded = Math.ceil(size / BLOCK) * BLOCK;
  const data = await reader.read(padded);
  if (!data) throw new SandboxArchiveError('archive truncated');
  return data.subarray(0, size);
}

/**
 * 读取并校验 tar 归档（copyOut），返回其中的普通文件。流中的字节数超过 maxTotalBytes 加上头部和对齐的余量即中止读取。
 * 任何一项不符合规则都抛 SandboxArchiveError，不返回部分结果。
 */
export async function readArchive(source: AsyncIterable<Uint8Array>, limits: SandboxTransferLimits): Promise<SandboxFile[]> {
  const reader = new ByteReader(source, maxArchiveBytes(limits));
  const files: SandboxFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let entries = 0;
  let pendingPath: string | null = null;
  try {
    for (;;) {
      const header = await reader.read(BLOCK);
      if (!header) throw new SandboxArchiveError('archive truncated');
      if (header.every((byte) => byte === 0)) {
        if (pendingPath !== null) throw new SandboxArchiveError('extended header without entry');
        break;
      }
      verifyChecksum(header);
      entries += 1;
      // 目录、扩展头也计数，防止用大量空条目拖延读取。
      if (entries > limits.maxFiles * 4 + 16) throw new SandboxArchiveError('too many entries');

      const type = String.fromCharCode(header[156]!);
      const size = readOctal(header, 124, 12);

      if (type === 'x' || type === 'L') {
        if (pendingPath !== null) throw new SandboxArchiveError('extended header without entry');
        if (size > MAX_EXTENDED_HEADER_BYTES) throw new SandboxArchiveError('extended header too large');
        const data = await readPadded(reader, size);
        if (type === 'x') {
          pendingPath = parsePaxPath(data);
          // 没有 path 的 PAX 头（只有时间等）按无扩展处理，但下一个头必须是条目本身。
          pendingPath ??= '';
        } else {
          const end = data.indexOf(0);
          pendingPath = data.subarray(0, end === -1 ? data.length : end).toString('utf8');
        }
        continue;
      }

      const magic = header.subarray(257, 263).toString('ascii');
      let name = readString(header, 0, 100);
      // POSIX ustar 的 prefix 字段；GNU 格式（magic 为 "ustar  "）的同一位置是其他字段，不能拼接。
      if (magic === 'ustar\0') {
        const prefix = readString(header, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
      if (pendingPath) name = pendingPath;
      pendingPath = null;
      if (name.includes('\\') || /[\0-\x1f\x7f]/.test(name)) throw new SandboxArchiveError('path segment not allowed');
      if (name.startsWith('/')) throw new SandboxArchiveError('absolute path');

      if (type === '5') {
        if (size !== 0) throw new SandboxArchiveError('malformed header');
        validateRelativePath(name.endsWith('/') ? name : `${name}/`, limits, true);
        continue;
      }
      if (type !== '0' && type !== '\0' && type !== '7') {
        throw new SandboxArchiveError(
          type === '1' ? 'hard link not allowed' : type === '2' ? 'symbolic link not allowed' : type === '3' || type === '4' ? 'device file not allowed' : type === '6' ? 'fifo not allowed' : 'entry type not allowed',
        );
      }
      const path = validateRelativePath(name, limits, false);
      if (seen.has(path)) throw new SandboxArchiveError('duplicate path');
      seen.add(path);
      if (files.length + 1 > limits.maxFiles) throw new SandboxArchiveError('too many files');
      if (size > limits.maxFileBytes) throw new SandboxArchiveError('file too large');
      total += size;
      if (total > limits.maxTotalBytes) throw new SandboxArchiveError('archive too large');
      const data = await readPadded(reader, size);
      // 复制出来，不持有整块读取缓冲区的引用。
      files.push(Object.freeze({ path, data: Buffer.from(data) }));
    }
  } finally {
    await reader.close();
  }
  return files;
}

/** 归档流的字节上限：文件总大小加上每个条目的头部、扩展头和对齐，再加结束块和 tar 的记录对齐（10 KiB）。 */
export function maxArchiveBytes(limits: SandboxTransferLimits): number {
  return limits.maxTotalBytes + (limits.maxFiles * 4 + 16) * (BLOCK * 2 + MAX_EXTENDED_HEADER_BYTES) + 20 * BLOCK;
}
