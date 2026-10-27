// ZIP 炸弹检查（server/sandbox/parse/zipGuard.mjs，沙箱中的解析入口在 docx / xlsx 交给解析器之前调用）：
// 条目数 10,000、解压后总大小 1 GiB、单条目压缩比 100:1（解压后不到 1 MiB 的条目不检查），以及按实际解压的大小核对声明值。
import { describe, expect, it } from 'vitest';
import { assertSafeZip, readZipEntries, ZIP_LIMITS, ZipGuardError } from '../../sandbox/parse/zipGuard.mjs';
import { buildZip } from './zipFixtures.ts';

const MIB = 1024 * 1024;

async function rejection(buffer: Buffer, limits = ZIP_LIMITS): Promise<string> {
  try {
    await assertSafeZip(buffer, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(ZipGuardError);
    return (error as ZipGuardError).code;
  }
  throw new Error('expected the zip to be rejected');
}

describe('zip guard', () => {
  it('accepts an ordinary document-like archive', async () => {
    const zip = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'word/document.xml', data: Buffer.from('<w:document>正文</w:document>'.repeat(200)) },
      { name: 'word/media/image1.png', data: Buffer.from('89504e470d0a1a0a', 'hex'), method: 0 },
    ]);
    expect((await assertSafeZip(zip)).map((entry) => entry.name)).toEqual(['[Content_Types].xml', 'word/document.xml', 'word/media/image1.png']);
  });

  it('uses the limits of decision 5', () => {
    expect(ZIP_LIMITS).toEqual({ maxEntries: 10_000, maxTotalBytes: 1024 * MIB, maxRatio: 100, ratioMinBytes: MIB });
  });

  it('rejects more than 10,000 entries', async () => {
    const entries = Array.from({ length: 10_001 }, (_, index) => ({ name: `f${index}`, data: Buffer.from('x'), method: 0 as const }));
    expect(await rejection(buildZip(entries))).toBe('zip_too_many_entries');
    expect(await assertSafeZip(buildZip(entries.slice(0, 10_000)))).toHaveLength(10_000);
  });

  it('rejects a declared total above 1 GiB', async () => {
    // 声明 3 × 400 MiB，实际数据很小：按中央目录的声明值即拒绝，不必解压（这里放宽压缩比，单独验证总大小）。
    const entries = [0, 1, 2].map((index) => ({ name: `part${index}.xml`, data: Buffer.alloc(10), declaredSize: 400 * MIB }));
    const limits = { ...ZIP_LIMITS, maxRatio: Number.POSITIVE_INFINITY };
    expect(() => readZipEntries(buildZip(entries.slice(0, 2)), limits)).not.toThrow();
    expect(() => readZipEntries(buildZip(entries), limits)).toThrow(expect.objectContaining({ code: 'zip_too_large' }));
  });

  it('rejects an entry whose compression ratio exceeds 100:1', async () => {
    // 2 MiB 的零压缩后约 2 KiB（约 1000:1）。
    expect(await rejection(buildZip([{ name: 'word/document.xml', data: Buffer.alloc(2 * MIB) }]))).toBe('zip_ratio');
  });

  it('does not apply the ratio to entries below 1 MiB', async () => {
    await expect(assertSafeZip(buildZip([{ name: 'word/styles.xml', data: Buffer.alloc(MIB - 1) }]))).resolves.toHaveLength(1);
  });

  it('rejects an entry that inflates beyond its declared size (forged central directory)', async () => {
    // 声明 1,000 字节，实际解压出 512 KiB：解析器会按实际数据解压，所以按实际大小核对。
    const forged = buildZip([{ name: 'word/document.xml', data: Buffer.alloc(512 * 1024), declaredSize: 1_000 }]);
    expect(readZipEntries(forged)).toHaveLength(1);
    expect(await rejection(forged)).toBe('zip_too_large');
  });

  it('rejects an entry that inflates to less than its declared size', async () => {
    expect(await rejection(buildZip([{ name: 'a.xml', data: Buffer.from('abc'), declaredSize: 10 }]))).toBe('zip_invalid');
  });

  it('rejects encrypted entries, unsupported methods, zip64 markers and truncated archives', async () => {
    expect(await rejection(buildZip([{ name: 'a', data: Buffer.from('x'), flags: 1 }]))).toBe('zip_invalid');
    expect(await rejection(buildZip([{ name: 'a', data: Buffer.from('x'), method: 0, declaredSize: 0xffffffff }]))).toBe('zip_invalid');
    expect(await rejection(buildZip([], { declaredCount: 0xffff }))).toBe('zip_invalid');
    const zip = buildZip([{ name: 'a', data: Buffer.from('hello') }]);
    expect(await rejection(zip.subarray(0, zip.length - 30))).toBe('zip_invalid');
    expect(await rejection(Buffer.from('PK\u0003\u0004not a zip'))).toBe('zip_invalid');
    const method = Buffer.from(zip);
    method.writeUInt16LE(12, method.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    expect(await rejection(method)).toBe('zip_invalid');
  });

  it('rejects a corrupt deflate stream', async () => {
    const zip = buildZip([{ name: 'a.xml', data: Buffer.from('hello world hello world') }]);
    const corrupt = Buffer.from(zip);
    corrupt.fill(0xff, 30 + 5, 30 + 5 + 4);
    expect(await rejection(corrupt)).toBe('zip_invalid');
  });
});
