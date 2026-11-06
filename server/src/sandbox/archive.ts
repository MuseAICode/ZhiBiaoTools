// 进出沙箱的 tar 归档（docs/SERVER_DESIGN.md 第 7.3、7.5 节）。不依赖第三方库。
//
// 写（copyIn）：只写普通文件，ustar 格式，路径由调用方给出、先按同样的规则校验。内存中的文件可以一次生成（createArchive），
// 按需读取的文件（对象存储中的配图等）边读边生成（createArchiveStream），不在内存中缓存整个归档。
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

/**
 * 放入沙箱时按需读取的文件（7.4e 起，例如整本导出的配图从对象存储读取）：size 必须事先知道（写进 tar 头部），
 * open 在归档生成到这个条目时才调用，返回的源必须正好产出 size 字节。
 */
export interface SandboxStreamFile {
  readonly path: string;
  readonly size: number;
  open(signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}

/** copyIn 的输入：内存中的文件或按需读取的文件。 */
export type SandboxInputFile = SandboxFile | SandboxStreamFile;

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

/** 一个已校验、待写入归档的条目。 */
interface PlannedEntry {
  readonly path: string;
  readonly file: SandboxInputFile;
  readonly size: number;
}

/**
 * 写入前一次校验全部条目（数量、路径、重复、单个与合计大小），不合法时抛 SandboxArchiveError。
 * 流式条目只看声明的 size，不打开它：任何一项不符时一个字节都不产出、一个对象都不读取。
 */
function planArchive(files: readonly SandboxInputFile[], limits: SandboxTransferLimits): PlannedEntry[] {
  if (files.length > limits.maxFiles) throw new SandboxArchiveError('too many files');
  const planned: PlannedEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const path = validateRelativePath(file.path, limits, false);
    if (path.length > 100) throw new SandboxArchiveError('path too long');
    if (seen.has(path)) throw new SandboxArchiveError('duplicate path');
    seen.add(path);
    const size = isStreamFile(file) ? file.size : file.data.length;
    if (!Number.isSafeInteger(size) || size < 0) throw new SandboxArchiveError('file size invalid');
    if (size > limits.maxFileBytes) throw new SandboxArchiveError('file too large');
    total += size;
    if (total > limits.maxTotalBytes) throw new SandboxArchiveError('archive too large');
    planned.push({ path, file, size });
  }
  return planned;
}

function isStreamFile(file: SandboxInputFile): file is SandboxStreamFile {
  return typeof (file as Partial<SandboxStreamFile>).open === 'function';
}

function entryHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  writeString(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function paddingFor(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** 生成只含普通文件的 ustar 归档（copyIn）。路径按 limits 校验，不合法时抛 SandboxArchiveError。只接受内存中的文件。 */
export function createArchive(files: readonly SandboxFile[], limits: SandboxTransferLimits): Buffer {
  const parts: Buffer[] = [];
  for (const entry of planArchive(files, limits)) {
    const data = (entry.file as SandboxFile).data;
    parts.push(entryHeader(entry.path, entry.size), data);
    const padding = paddingFor(entry.size);
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** 文件列表中是否有需要流式读取的条目。 */
export function hasStreamFiles(files: readonly SandboxInputFile[]): boolean {
  return files.some(isStreamFile);
}

export interface ArchiveStream {
  /** 归档的确切字节数（头部、内容、对齐与结束块），可作为 Content-Length。 */
  readonly byteLength: number;
  /** 归档的字节；只能迭代一次。 */
  readonly chunks: AsyncIterable<Buffer>;
  /**
   * 使生成中止的错误（字节数不符的 SandboxArchiveError、源的 open 或读取错误、中止）；没有时为 undefined。
   * 消费方（fetch、Readable）往往把它包成自己的错误，调用方据此判断失败是否来自输入本身。
   */
  readonly failure: unknown;
}

/**
 * 边读边生成只含普通文件的 ustar 归档（copyIn，worker 端），不在内存中缓存整个归档或整个文件：
 * - 生成之前一次校验全部条目（与 createArchive 相同的规则），不合法时同步抛 SandboxArchiveError，不打开任何流式条目；
 * - 流式条目按顺序、轮到它时才 open，同一时刻至多一个打开；它的内容原样（按源的分块）转出；
 * - 源产出的字节数必须正好等于声明的 size：多了立即停止读取，少了在源结束时，都抛 SandboxArchiveError('file size mismatch')；
 *   此时之前的条目可能已交给下游，下游（sandbox-runner）收到的是被截断的归档，调用方必须丢弃整个沙箱；
 * - 源的 open 或读取出错时原样抛出；消费方提前结束、出错或 signal 中止时关闭当前的源。
 */
export function createArchiveStream(files: readonly SandboxInputFile[], limits: SandboxTransferLimits, options: { signal?: AbortSignal } = {}): ArchiveStream {
  const planned = planArchive(files, limits);
  let byteLength = BLOCK * 2;
  for (const entry of planned) byteLength += BLOCK + entry.size + paddingFor(entry.size);
  let started = false;
  let failure: unknown;
  async function* generate(): AsyncGenerator<Buffer> {
    if (started) throw new Error('archive stream can only be consumed once');
    started = true;
    try {
      yield* entries();
    } catch (error) {
      failure = error;
      throw error;
    }
  }
  async function* entries(): AsyncGenerator<Buffer> {
    for (const entry of planned) {
      options.signal?.throwIfAborted();
      yield entryHeader(entry.path, entry.size);
      if (isStreamFile(entry.file)) {
        let remaining = entry.size;
        const source = await entry.file.open(options.signal);
        const iterator = source[Symbol.asyncIterator]();
        // 中止时立即释放源：读取可能正停在等待对象存储的下一块数据上。异步迭代器的 return 要排在未完成的 next 之后，
        // 不能打断它，所以可销毁的源（Readable，例如对象存储的响应体）直接销毁。
        const release = () => {
          const destroyable = source as { destroy?: unknown };
          if (typeof destroyable.destroy === 'function') (destroyable.destroy as () => void).call(source);
          else void Promise.resolve(iterator.return?.()).catch(() => {});
        };
        options.signal?.addEventListener('abort', release, { once: true });
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
            if (chunk.length === 0) continue;
            if (chunk.length > remaining) throw new SandboxArchiveError('file size mismatch');
            remaining -= chunk.length;
            yield chunk;
          }
        } finally {
          options.signal?.removeEventListener('abort', release);
          // 正常读完时 return 是空操作；提前结束或出错时释放源（例如中止对象存储的响应）。
          await iterator.return?.();
        }
        options.signal?.throwIfAborted();
        if (remaining !== 0) throw new SandboxArchiveError('file size mismatch');
      } else if (entry.size > 0) {
        yield entry.file.data;
      }
      const padding = paddingFor(entry.size);
      if (padding > 0) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  return {
    byteLength,
    chunks: { [Symbol.asyncIterator]: () => generate() },
    get failure() {
      return failure;
    },
  };
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

  /** 再从源流读入一块；流已结束时返回 false。累计读入超过 maxBytes 即拒绝。 */
  private async fill(): Promise<boolean> {
    let chunk: Buffer;
    do {
      if (this.done) return false;
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        return false;
      }
      chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    } while (chunk.length === 0);
    this.consumed += chunk.length;
    if (this.consumed > this.maxBytes) {
      await this.close();
      throw new SandboxArchiveError('archive too large');
    }
    this.buffered.push(chunk);
    this.bufferedBytes += chunk.length;
    return true;
  }

  /** 读取正好 length 字节；数据不够（流已结束）时返回 null。 */
  async read(length: number): Promise<Buffer | null> {
    while (this.bufferedBytes < length && (await this.fill())) {
      // 继续读入。
    }
    if (this.bufferedBytes < length) return null;
    const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered);
    const result = all.subarray(0, length);
    const rest = all.subarray(length);
    this.buffered = rest.length > 0 ? [rest] : [];
    this.bufferedBytes = rest.length;
    return result;
  }

  /** 读取至多 length 字节（至少 1 字节）；流已结束且没有剩余数据时返回 null。不为凑满 length 而合并缓冲区。 */
  async readSome(length: number): Promise<Buffer | null> {
    if (this.bufferedBytes === 0 && !(await this.fill())) return null;
    const first = this.buffered[0]!;
    const result = first.length > length ? first.subarray(0, length) : first;
    if (result.length === first.length) this.buffered.shift();
    else this.buffered[0] = first.subarray(length);
    this.bufferedBytes -= result.length;
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

/** 一个文件的内容按这个大小分块读出（流式转发时不在内存中缓存整个文件）。 */
const DATA_CHUNK_BYTES = 64 * 1024;

/**
 * 逐项校验归档时产出的片段：meta 是已校验的头部（含之前的扩展头）、目录条目、对齐与结束块，file 宣告一个普通文件，
 * 其后紧跟总长为 size 的 data。一个条目的头部只在校验通过后产出，扩展头与它所修饰的条目头部一起产出。
 */
type ArchivePart = { kind: 'meta'; bytes: Buffer } | { kind: 'file'; path: string; size: number } | { kind: 'data'; bytes: Buffer };

async function* scanArchive(reader: ByteReader, limits: SandboxTransferLimits): AsyncGenerator<ArchivePart> {
  const seen = new Set<string>();
  let total = 0;
  let entries = 0;
  let files = 0;
  let pendingPath: string | null = null;
  /** 扩展头（头部与内容）：等它修饰的条目通过校验后再一起产出。 */
  let pendingMeta: Buffer[] = [];
  for (;;) {
    const header = await reader.read(BLOCK);
    if (!header) throw new SandboxArchiveError('archive truncated');
    if (header.every((byte) => byte === 0)) {
      if (pendingPath !== null) throw new SandboxArchiveError('extended header without entry');
      yield { kind: 'meta', bytes: Buffer.alloc(BLOCK * 2) };
      return;
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
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      const block = await reader.read(padded);
      if (!block) throw new SandboxArchiveError('archive truncated');
      const data = block.subarray(0, size);
      if (type === 'x') {
        pendingPath = parsePaxPath(data);
        // 没有 path 的 PAX 头（只有时间等）按无扩展处理，但下一个头必须是条目本身。
        pendingPath ??= '';
      } else {
        const end = data.indexOf(0);
        pendingPath = data.subarray(0, end === -1 ? data.length : end).toString('utf8');
      }
      pendingMeta = [Buffer.from(header), Buffer.from(block)];
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
      yield { kind: 'meta', bytes: Buffer.concat([...pendingMeta, header]) };
      pendingMeta = [];
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
    files += 1;
    if (files > limits.maxFiles) throw new SandboxArchiveError('too many files');
    if (size > limits.maxFileBytes) throw new SandboxArchiveError('file too large');
    total += size;
    if (total > limits.maxTotalBytes) throw new SandboxArchiveError('archive too large');
    yield { kind: 'meta', bytes: Buffer.concat([...pendingMeta, header]) };
    pendingMeta = [];
    yield { kind: 'file', path, size };
    let remaining = size;
    while (remaining > 0) {
      const chunk = await reader.readSome(Math.min(remaining, DATA_CHUNK_BYTES));
      if (!chunk) throw new SandboxArchiveError('archive truncated');
      remaining -= chunk.length;
      yield { kind: 'data', bytes: chunk };
    }
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (padding > 0) {
      const block = await reader.read(padding);
      if (!block) throw new SandboxArchiveError('archive truncated');
      yield { kind: 'meta', bytes: block };
    }
  }
}

/**
 * 读取并校验 tar 归档（copyOut），返回其中的普通文件。流中的字节数超过 maxTotalBytes 加上头部和对齐的余量即中止读取。
 * 任何一项不符合规则都抛 SandboxArchiveError，不返回部分结果。
 */
export async function readArchive(source: AsyncIterable<Uint8Array>, limits: SandboxTransferLimits): Promise<SandboxFile[]> {
  const reader = new ByteReader(source, maxArchiveBytes(limits));
  const files: SandboxFile[] = [];
  let current: { path: string; data: Buffer; filled: number } | null = null;
  const finish = () => {
    if (current) files.push(Object.freeze({ path: current.path, data: current.data }));
    current = null;
  };
  try {
    for await (const part of scanArchive(reader, limits)) {
      if (part.kind === 'file') {
        finish();
        current = { path: part.path, data: Buffer.alloc(part.size), filled: 0 };
      } else if (part.kind === 'data') {
        // 复制出来，不持有读取缓冲区的引用。
        part.bytes.copy(current!.data, current!.filled);
        current!.filled += part.bytes.length;
      } else {
        finish();
      }
    }
    finish();
  } finally {
    await reader.close();
  }
  return files;
}

/**
 * 边读边校验 tar 归档（copyIn，sandbox-runner 收到的请求体），按原样产出已通过校验的字节，不在内存中缓存整个归档或整个文件：
 * 规则与 readArchive 相同；一个条目的头部只在它通过校验后产出，所以下游（沙箱内的 tar）收不到不合规的条目。
 * 中途不符时抛 SandboxArchiveError——此时之前的条目可能已交给下游，调用方必须丢弃整个沙箱。
 * 结束块之后的数据（tar 的记录对齐）计入字节上限，读完后丢弃；源流读完才结束，失败时不销毁源流（由调用方决定）。
 */
export async function* validateArchiveStream(source: AsyncIterable<Uint8Array>, limits: SandboxTransferLimits): AsyncGenerator<Buffer> {
  const reader = new ByteReader(source, maxArchiveBytes(limits));
  try {
    for await (const part of scanArchive(reader, limits)) {
      if (part.kind !== 'file') yield part.bytes;
    }
    while (await reader.readSome(DATA_CHUNK_BYTES)) {
      // 结束块之后的数据不转发。
    }
  } finally {
    await reader.close();
  }
}

/** 归档流的字节上限：文件总大小加上每个条目的头部、扩展头和对齐，再加结束块和 tar 的记录对齐（10 KiB）。 */
export function maxArchiveBytes(limits: SandboxTransferLimits): number {
  return limits.maxTotalBytes + (limits.maxFiles * 4 + 16) * (BLOCK * 2 + MAX_EXTENDED_HEADER_BYTES) + 20 * BLOCK;
}
