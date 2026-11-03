// 导出 docx 的 ZIP 结构检查（src/export/docxGuard.ts，路线图 7.3b）：条目数、解压后大小、压缩比、按实际解压核对声明值，
// 条目名必须是相对路径、不重复，必须有 [Content_Types].xml 与 word/document.xml。
import { describe, expect, it } from 'vitest';
import { assertSafeDocx, DOCX_LIMITS, DocxGuardError } from '../../src/export/docxGuard.ts';
import { buildZip, type ZipFixtureEntry } from '../sandbox/zipFixtures.ts';

const MIB = 1024 * 1024;
const REQUIRED: ZipFixtureEntry[] = [
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<w:document>正文</w:document>'.repeat(200)) },
];

async function rejection(buffer: Buffer, limits = DOCX_LIMITS): Promise<string> {
  try {
    await assertSafeDocx(buffer, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(DocxGuardError);
    // 错误信息只有固定的代码与短语，不含条目名。
    expect((error as Error).message).not.toContain('secret');
    return (error as DocxGuardError).reason;
  }
  throw new Error('expected the docx to be rejected');
}

describe('docx guard', () => {
  it('accepts an ordinary docx-like archive', async () => {
    const zip = buildZip([...REQUIRED, { name: '_rels/.rels', data: Buffer.from('<Relationships/>') }, { name: 'word/media/image1.png', data: Buffer.from('89504e470d0a1a0a', 'hex'), method: 0 }]);
    expect(await assertSafeDocx(zip)).toEqual(['[Content_Types].xml', 'word/document.xml', '_rels/.rels', 'word/media/image1.png']);
  });

  it('uses the same limits as the parse sandbox zip guard', () => {
    expect(DOCX_LIMITS).toEqual({ maxEntries: 10_000, maxTotalBytes: 1024 * MIB, maxRatio: 100, ratioMinBytes: MIB });
  });

  it.each([
    ['[Content_Types].xml', 'word/document.xml'],
    ['word/document.xml', '[Content_Types].xml'],
  ])('rejects an archive without %s', async (missing, kept) => {
    expect(await rejection(buildZip([{ name: kept, data: Buffer.from('x') }]))).toBe('missing_part');
    expect(missing).not.toBe(kept);
  });

  it('rejects more than 10,000 entries', async () => {
    const entries = Array.from({ length: 9_999 }, (_, index) => ({ name: `word/f${index}.xml`, data: Buffer.from('x'), method: 0 as const }));
    expect(await assertSafeDocx(buildZip([...REQUIRED, ...entries.slice(0, 9_998)]))).toHaveLength(10_000);
    expect(await rejection(buildZip([...REQUIRED, ...entries]))).toBe('zip_too_many_entries');
  });

  it('rejects a declared total above 1 GiB without inflating', async () => {
    const big = (name: string): ZipFixtureEntry => ({ name, data: Buffer.from('x'), method: 0, declaredSize: 400 * MIB });
    // 不压缩的条目声明大小与实际不符本身也会被拒绝，这里用 deflate 并放宽压缩比，单独验证总大小。
    const zip = buildZip([...REQUIRED, ...['a', 'b', 'c'].map((name) => ({ ...big(`word/${name}.bin`), method: 8 as const }))]);
    expect(await rejection(zip, { ...DOCX_LIMITS, maxRatio: Number.MAX_SAFE_INTEGER })).toBe('zip_too_large');
  });

  it('rejects an entry above the compression ratio, and checks small entries only by size', async () => {
    const zeros = Buffer.alloc(2 * MIB);
    expect(await rejection(buildZip([...REQUIRED, { name: 'word/zeros.bin', data: zeros }]))).toBe('zip_ratio');
    // 不到 1 MiB 的条目不检查压缩比。
    expect(await assertSafeDocx(buildZip([...REQUIRED, { name: 'word/zeros.bin', data: Buffer.alloc(MIB - 1) }]))).toHaveLength(3);
  });

  it('rejects an entry that inflates beyond its declared size', async () => {
    const data = Buffer.from('<w:p/>'.repeat(10_000));
    expect(await rejection(buildZip([...REQUIRED, { name: 'word/forged.xml', data, declaredSize: 100 }]))).toBe('zip_too_large');
  });

  it('rejects an entry that inflates below its declared size', async () => {
    const data = Buffer.from('<w:p/>'.repeat(100));
    expect(await rejection(buildZip([...REQUIRED, { name: 'word/forged.xml', data, declaredSize: data.length + 10 }]))).toBe('zip_invalid');
  });

  it.each([
    ['an absolute path', '/word/secret.xml'],
    ['a parent segment', 'word/../../secret.xml'],
    ['a dot segment', 'word/./secret.xml'],
    ['an empty segment', 'word//secret.xml'],
    ['a backslash', 'word\\secret.xml'],
    ['a control character', 'word/secret\u0001.xml'],
  ])('rejects an entry name with %s', async (_label, name) => {
    expect(await rejection(buildZip([...REQUIRED, { name, data: Buffer.from('x') }]))).toBe('entry_name');
  });

  it('rejects duplicate entry names', async () => {
    expect(await rejection(buildZip([...REQUIRED, { name: 'word/document.xml', data: Buffer.from('<secret/>') }]))).toBe('entry_name');
  });

  it.each([
    ['an encrypted entry', [{ name: 'word/a.xml', data: Buffer.from('x'), flags: 1 }]],
    ['a stored entry whose sizes differ', [{ name: 'word/a.xml', data: Buffer.from('xx'), method: 0 as const, declaredSize: 3 }]],
  ])('rejects %s', async (_label, extra) => {
    expect(await rejection(buildZip([...REQUIRED, ...extra]))).toBe('zip_invalid');
  });

  it('rejects truncated, non-zip and inconsistent archives', async () => {
    const zip = buildZip(REQUIRED);
    expect(await rejection(Buffer.alloc(10))).toBe('zip_invalid');
    expect(await rejection(Buffer.from('not a zip file at all, just some text that is long enough'))).toBe('zip_invalid');
    expect(await rejection(zip.subarray(0, zip.length - 30))).toBe('zip_invalid');
    expect(await rejection(buildZip(REQUIRED, { declaredCount: 1 }))).toBe('zip_invalid');
    // 中央目录的条目指向的本地头名称不符。
    const tampered = Buffer.from(zip);
    tampered.write('X', 30, 'latin1');
    expect(await rejection(tampered)).toBe('zip_invalid');
  });
});
