// 导出 docx 的 ZIP 结构检查（路线图第 7 步“输出校验”：docx 写入前再做一次 ZIP 结构检查，条目数、解压大小）。
// docx 由沙箱中的助手生成，按不可信输入对待；worker 不解析其中的 XML，只按中央目录检查结构与上限，再逐个条目实际解压
// （只计数、不保存），确认实际大小不超过声明值——中央目录中的大小可以伪造，下载后打开它的 Word 或 docx-editor 按实际数据解压。
// 规则与 parse 沙箱的 zipGuard（server/sandbox/parse/zipGuard.mjs）相同，另要求：
// - 条目名是相对路径：不以 / 开头，没有反斜杠、空段、. 与 ..，没有控制字符，同名条目不出现两次；
// - 必须有 [Content_Types].xml 与 word/document.xml（Open XML SDK 写出的 docx 都有）。
// 只用 Node 内置模块；解压走 zlib 的流式接口（在线程池中执行），不阻塞事件循环。
import { createInflateRaw } from 'node:zlib';

export interface DocxLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxRatio: number;
  ratioMinBytes: number;
}

export const DOCX_LIMITS: Readonly<DocxLimits> = Object.freeze({
  maxEntries: 10_000,
  /** 解压后合计：docx 至多 100 MiB（决定事项第 5 项），其中的图片基本不可再压缩，1 GiB 足够。 */
  maxTotalBytes: 1024 * 1024 * 1024,
  maxRatio: 100,
  // 解压后不到 1 MiB 的条目不检查压缩比：小条目即使压缩比很高也放不大，正常文档中重复的小 XML 常超过 100:1。
  ratioMinBytes: 1024 * 1024,
});

export type DocxGuardReason =
  | 'zip_invalid'
  | 'zip_too_many_entries'
  | 'zip_too_large'
  | 'zip_ratio'
  | 'entry_name'
  | 'missing_part';

/** docx 不符合规则。reason 是固定的代码，不含文档中的内容。 */
export class DocxGuardError extends Error {
  readonly reason: DocxGuardReason;

  constructor(reason: DocxGuardReason, detail: string) {
    super(`docx rejected: ${reason} (${detail})`);
    this.name = 'DocxGuardError';
    this.reason = reason;
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
const REQUIRED_PARTS = ['[Content_Types].xml', 'word/document.xml'] as const;
const CONTROL = /[\u0000-\u001f\u007f]/;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function invalid(detail: string): DocxGuardError {
  return new DocxGuardError('zip_invalid', detail);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  return -1;
}

function assertEntryName(name: string): void {
  if (name === '' || name.startsWith('/') || name.includes('\\') || CONTROL.test(name)) throw new DocxGuardError('entry_name', 'bad entry name');
  // 目录条目（以 / 结尾）允许，其余各段都不能为空、. 或 ..。
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new DocxGuardError('entry_name', 'bad entry path');
}

/** 读出中央目录中的条目，并按声明值检查条目数、名称、总大小和压缩比。 */
export function readDocxEntries(buffer: Buffer, limits: DocxLimits = DOCX_LIMITS): ZipEntry[] {
  if (buffer.length < 22) throw invalid('too short');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw invalid('end of central directory not found');
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) throw invalid('multi-disk archive');
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  // ZIP64 在 100 MiB 以内、条目数受限的 docx 中不会出现，一律拒绝。
  if (count === 0xffff || directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) throw invalid('zip64 is not supported');
  if (count > limits.maxEntries) throw new DocxGuardError('zip_too_many_entries', 'too many entries');
  if (buffer.readUInt16LE(eocd + 8) !== count) throw invalid('entry count mismatch');
  if (directoryOffset + directorySize !== eocd) throw invalid('central directory out of range');

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw invalid('bad central directory entry');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) throw invalid('central directory entry out of range');
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || localOffset === ZIP64_MARKER) throw invalid('zip64 is not supported');
    if (flags & 0x1) throw invalid('encrypted entry');
    if (method !== 0 && method !== 8) throw invalid('unsupported compression method');
    if (method === 0 && compressedSize !== size) throw invalid('stored entry size mismatch');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      throw new DocxGuardError('entry_name', 'entry name is not utf-8');
    }
    assertEntryName(name);
    if (names.has(name)) throw new DocxGuardError('entry_name', 'duplicate entry');
    names.add(name);
    total += size;
    if (total > limits.maxTotalBytes) throw new DocxGuardError('zip_too_large', 'uncompressed size too large');
    if (size >= limits.ratioMinBytes && size > compressedSize * limits.maxRatio) throw new DocxGuardError('zip_ratio', 'compression ratio too high');
    entries.push({ name, method, compressedSize, size, localOffset });
    offset = end;
  }
  if (offset !== eocd) throw invalid('central directory size mismatch');
  for (const part of REQUIRED_PARTS) {
    if (!names.has(part)) throw new DocxGuardError('missing_part', 'required part is missing');
  }
  return entries;
}

/** 实际解压一个 deflate 条目，只计数；超过声明的大小即中止。 */
function inflatedSize(data: Buffer, declared: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const inflate = createInflateRaw();
    let produced = 0;
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(produced);
    };
    inflate.on('data', (chunk: Buffer) => {
      produced += chunk.length;
      if (produced > declared) {
        inflate.destroy();
        finish(new DocxGuardError('zip_too_large', 'entry inflates beyond its declared size'));
      }
    });
    inflate.on('error', () => finish(invalid('corrupt deflate stream')));
    inflate.on('end', () => finish(null));
    inflate.end(data);
  });
}

/**
 * 完整检查：中央目录的结构与声明值，以及每个条目的本地头与中央目录一致、实际解压后的大小等于声明值。
 * 不符时抛 DocxGuardError。返回条目名（按中央目录的顺序）。
 */
export async function assertSafeDocx(buffer: Buffer, limits: DocxLimits = DOCX_LIMITS): Promise<string[]> {
  const entries = readDocxEntries(buffer, limits);
  for (const entry of entries) {
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) throw invalid('bad local header');
    const localNameLength = buffer.readUInt16LE(local + 26);
    if (buffer.toString('utf8', local + 30, local + 30 + localNameLength) !== entry.name) throw invalid('local header name mismatch');
    if (buffer.readUInt16LE(local + 8) !== entry.method) throw invalid('local header method mismatch');
    const start = local + 30 + localNameLength + buffer.readUInt16LE(local + 28);
    const end = start + entry.compressedSize;
    if (end > buffer.length) throw invalid('entry data out of range');
    if (entry.method === 0) continue;
    const produced = await inflatedSize(buffer.subarray(start, end), entry.size);
    if (produced !== entry.size) throw invalid('entry size mismatch');
  }
  return entries.map((entry) => entry.name);
}
