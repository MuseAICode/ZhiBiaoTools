// ZIP 炸弹检查（路线图第 6 步“资源上限”，决定事项第 5 项）：docx / xlsx 以及 LibreOffice 转换出的 docx 交给解析器之前，
// 先按中央目录检查条目数、声明的解压后总大小和单条目压缩比，再逐个条目实际解压（只计数、不保存），
// 确认实际大小不超过声明值：中央目录中的大小可以伪造，解析器（jszip）会按实际数据解压。
// 只用 Node 内置模块，不依赖解析器；宿主上的单元测试（server/tests/sandbox/zipGuard.test.ts）直接加载本文件。
import { createInflateRaw } from 'node:zlib';

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxRatio: 100,
  // 解压后不到 1 MiB 的条目不检查压缩比：小条目即使压缩比很高也放不大，正常文档中重复的小 XML 常超过 100:1。
  ratioMinBytes: 1024 * 1024,
});

export class ZipGuardError extends Error {
  /** @param {'zip_invalid' | 'zip_too_many_entries' | 'zip_too_large' | 'zip_ratio'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ZipGuardError';
    this.code = code;
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

function invalid(message) {
  return new ZipGuardError('zip_invalid', message);
}

/** 找到中央目录尾记录（文件末尾 22 字节 + 至多 64 KiB 注释）。 */
function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  return -1;
}

/**
 * 读出中央目录中的条目，并按声明值检查条目数、总大小和压缩比。
 * @returns {{ name: string, method: number, compressedSize: number, size: number, localOffset: number }[]}
 */
export function readZipEntries(buffer, limits = ZIP_LIMITS) {
  if (buffer.length < 22) throw invalid('too short');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw invalid('end of central directory not found');
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  // ZIP64（条目数或大小超过 32 位）在 100 MiB 以内的正常文档中不会出现，一律拒绝。
  if (count === 0xffff || directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) throw invalid('zip64 is not supported');
  if (count > limits.maxEntries) throw new ZipGuardError('zip_too_many_entries', 'too many entries');
  if (directoryOffset + directorySize > eocd) throw invalid('central directory out of range');

  const entries = [];
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
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || localOffset === ZIP64_MARKER) throw invalid('zip64 is not supported');
    if (flags & 0x1) throw invalid('encrypted entry');
    if (method !== 0 && method !== 8) throw invalid('unsupported compression method');
    if (method === 0 && compressedSize !== size) throw invalid('stored entry size mismatch');
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipGuardError('zip_too_large', 'uncompressed size too large');
    if (size >= limits.ratioMinBytes && size > compressedSize * limits.maxRatio) throw new ZipGuardError('zip_ratio', 'compression ratio too high');
    entries.push({ name, method, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.length !== count) throw invalid('entry count mismatch');
  return entries;
}

/** 实际解压一个 deflate 条目，只计数；超过声明的大小即中止。 */
function inflatedSizeWithin(data, declared) {
  return new Promise((resolve, reject) => {
    const inflate = createInflateRaw();
    let produced = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(produced);
    };
    inflate.on('data', (chunk) => {
      produced += chunk.length;
      if (produced > declared) {
        inflate.destroy();
        finish(new ZipGuardError('zip_too_large', 'entry inflates beyond its declared size'));
      }
    });
    inflate.on('error', () => finish(invalid('corrupt deflate stream')));
    inflate.on('end', () => finish(null));
    inflate.end(data);
  });
}

/**
 * 完整检查：中央目录的声明值，以及每个条目实际解压后的大小不超过声明值（合计因此也不超过上限）。
 * 不符时抛 ZipGuardError。
 */
export async function assertSafeZip(buffer, limits = ZIP_LIMITS) {
  const entries = readZipEntries(buffer, limits);
  for (const entry of entries) {
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) throw invalid('bad local header');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const end = start + entry.compressedSize;
    if (end > buffer.length) throw invalid('entry data out of range');
    if (entry.method === 0) continue;
    const produced = await inflatedSizeWithin(buffer.subarray(start, end), entry.size);
    if (produced !== entry.size) throw invalid('entry size mismatch');
  }
  return entries;
}
