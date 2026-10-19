import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.ts';
import { InspectionStream, readZipEntryNames, TAIL_BYTES, type InspectionResult } from '../../src/files/inspect.ts';
import { HTML_PAYLOAD, SVG_PAYLOAD, makeBmp, makeDocx, makeGif, makeJpeg, makeOle, makePdf, makePng, makeWebp, makeXlsx, makeZip } from './fixtures.ts';

const tooLarge = () => new AppError(413, 'FILE_TOO_LARGE', 'too large');

/** 按指定块大小送入校验流，返回结果或抛出的错误。 */
async function inspect(extension: string, content: Buffer, options: { chunkSize?: number; maxBytes?: number } = {}): Promise<InspectionResult> {
  const chunkSize = options.chunkSize ?? 7;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < content.length; offset += chunkSize) chunks.push(content.subarray(offset, offset + chunkSize));
  const stream = new InspectionStream({ extension, maxBytes: options.maxBytes ?? 100 * 1024 * 1024, tooLarge });
  const passed: Buffer[] = [];
  await pipeline(Readable.from(chunks), stream, async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) passed.push(chunk);
  });
  // 透传的数据与输入一致。
  expect(Buffer.concat(passed).equals(content)).toBe(true);
  return stream.result;
}

async function expectRejected(extension: string, content: Buffer, code = 'FILE_TYPE_MISMATCH', options: { chunkSize?: number; maxBytes?: number } = {}) {
  const error = await inspect(extension, content, options).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe('InspectionStream：按内容判断真实类型', () => {
  it.each<[string, () => Buffer, string]>([
    ['pdf', makePdf, 'application/pdf'],
    ['docx', makeDocx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', makeXlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['doc', makeOle, 'application/msword'],
    ['wps', makeOle, 'application/vnd.ms-works'],
    ['xls', makeOle, 'application/vnd.ms-excel'],
    ['doc', makeDocx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['png', makePng, 'image/png'],
    ['jpg', makeJpeg, 'image/jpeg'],
    ['jpeg', makeJpeg, 'image/jpeg'],
    ['gif', makeGif, 'image/gif'],
    ['webp', makeWebp, 'image/webp'],
    ['bmp', makeBmp, 'image/bmp'],
  ])('.%s 接受真实内容，MIME 由内容决定', async (extension, make, mime) => {
    const content = make();
    const result = await inspect(extension, content);
    expect(result.mime).toBe(mime);
    expect(result.size).toBe(content.length);
    expect(result.sha256.equals(createHash('sha256').update(content).digest())).toBe(true);
  });

  it.each([1, 3, 16, 4096])('块大小为 %i 时结果相同', async (chunkSize) => {
    expect((await inspect('docx', makeDocx(), { chunkSize })).mime).toContain('wordprocessingml');
    expect((await inspect('png', makePng(), { chunkSize })).mime).toBe('image/png');
  });

  it.each<[string, () => Buffer]>([
    ['pdf', makeDocx],
    ['pdf', () => HTML_PAYLOAD],
    ['docx', makePdf],
    ['docx', makeXlsx],
    ['xlsx', makeDocx],
    ['docx', makeOle],
    ['png', makeJpeg],
    ['jpg', makePng],
    ['png', () => HTML_PAYLOAD],
    ['png', () => SVG_PAYLOAD],
    ['gif', () => Buffer.from('GIF87', 'latin1')],
    ['doc', makePdf],
    ['xls', makePdf],
    ['txt', makePdf],
    ['md', makePng],
    ['txt', makeDocx],
  ])('伪造类型：.%s 的内容是别的格式时拒绝', async (extension, make) => {
    await expectRejected(extension, make());
  });

  it('ZIP 中没有 [Content_Types].xml 或主文档时不是 docx', async () => {
    await expectRejected('docx', makeZip({ 'word/document.xml': '<w:document/>' }));
    await expectRejected('docx', makeZip({ '[Content_Types].xml': '<Types/>', 'payload.exe': 'MZ' }));
    // 改了扩展名的普通 ZIP。
    await expectRejected('docx', makeZip({ 'readme.txt': 'hello' }));
  });

  it('ZIP 结构被截断或篡改时拒绝', async () => {
    const docx = makeDocx();
    await expectRejected('docx', docx.subarray(0, docx.length - 5));
    const tampered = Buffer.from(docx);
    tampered.writeUInt32LE(0xffffffff, tampered.length - 6); // 中央目录偏移改成 ZIP64 标记
    await expectRejected('docx', tampered);
  });

  it('ZIP 带注释时仍能找到目录尾记录', async () => {
    const withComment = makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' }, 'PK\x05\x06 fake');
    expect((await inspect('docx', withComment)).mime).toContain('wordprocessingml');
  });

  it('中央目录在末尾 4 MiB 之外时拒绝（不保留更多数据）', () => {
    const big = makeDocx({ 'word/media/big.bin': Buffer.alloc(16) });
    expect(readZipEntryNames(big, big.length)).toContain('word/document.xml');
    // 只给出目录尾记录，目录本身落在 tail 之外。
    expect(readZipEntryNames(big.subarray(big.length - 22), big.length)).toBeNull();
    expect(TAIL_BYTES).toBe(4 * 1024 * 1024);
  });

  it('大文件的中央目录在末尾时能找到', async () => {
    const big = makeDocx({ 'word/media/big.bin': Buffer.alloc(6 * 1024 * 1024, 1) });
    expect((await inspect('docx', big, { chunkSize: 64 * 1024 })).mime).toContain('wordprocessingml');
  });

  it('BMP 头中的文件大小与实际不符时拒绝', async () => {
    await expectRejected('bmp', makeBmp(12345));
    expect((await inspect('bmp', makeBmp(0))).mime).toBe('image/bmp');
  });
});

describe('InspectionStream：文本文件', () => {
  it('UTF-8 文本（含跨块的多字节字符）', async () => {
    const content = Buffer.from('# 投标文件\n\n技术方案：😀', 'utf8');
    const result = await inspect('md', content, { chunkSize: 1 });
    expect(result.mime).toBe('text/markdown; charset=utf-8');
    expect((await inspect('txt', content)).mime).toBe('text/plain; charset=utf-8');
  });

  it('GBK / GB18030 文本', async () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xb1, 0xea, 0xca, 0xe9]); // 你好\n标书
    expect((await inspect('txt', gbk, { chunkSize: 1 })).mime).toBe('text/plain; charset=gb18030');
  });

  it('以 “BM” 开头的普通文本不会被当作 BMP', async () => {
    expect((await inspect('md', Buffer.from('BMW 报价单：设备清单与参数', 'utf8'))).mime).toBe('text/markdown; charset=utf-8');
  });

  it('含 NUL 或既不是 UTF-8 也不是 GB18030 时拒绝', async () => {
    await expectRejected('txt', Buffer.from('abc\0def', 'latin1'));
    await expectRejected('txt', Buffer.from([0x61, 0x80, 0xff, 0x62]));
  });

  it('末尾是不完整的多字节序列时拒绝', async () => {
    // 0x81 在 UTF-8 中不合法，在 GB18030 中是缺少后续字节的首字节。
    await expectRejected('txt', Buffer.from([0x61, 0x62, 0x81]));
  });
});

describe('InspectionStream：大小', () => {
  it('超过上限时立即中断，不等流结束', async () => {
    const content = Buffer.alloc(1024, 0x61);
    await expectRejected('txt', content, 'FILE_TOO_LARGE', { maxBytes: 100, chunkSize: 64 });
  });

  it('恰好等于上限时接受', async () => {
    expect((await inspect('txt', Buffer.alloc(100, 0x61), { maxBytes: 100 })).size).toBe(100);
  });

  it('空文件拒绝', async () => {
    await expectRejected('pdf', Buffer.alloc(0), 'FILE_EMPTY');
    await expectRejected('txt', Buffer.alloc(0), 'FILE_EMPTY');
  });

  it('不支持的扩展名在构造时拒绝', () => {
    expect(() => new InspectionStream({ extension: 'svg', maxBytes: 10, tooLarge })).toThrow(AppError);
    expect(() => new InspectionStream({ extension: 'html', maxBytes: 10, tooLarge })).toThrow(AppError);
  });
});
