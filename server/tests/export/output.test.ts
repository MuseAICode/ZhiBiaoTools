// export 沙箱输出内容的校验（src/export/output.ts，路线图 7.3b）：只收 document.docx 与 result.json，result.json 只有已知字段，
// docx 经 ZIP 结构检查；入口的错误代码只取白名单内的。
import { describe, expect, it } from 'vitest';
import { EXPORT_ENTRY_ERROR_CODES, exportEntryErrorCode, ExportOutputError, validateExportOutput } from '../../src/export/output.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';
import { buildZip } from '../sandbox/zipFixtures.ts';

const ENTRY_SOURCE = new URL('../../sandbox/export/entry.mjs', import.meta.url);

const DOCX = buildZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
]);

function files(result: unknown, docx: Buffer = DOCX): SandboxFile[] {
  return [
    { path: 'document.docx', data: docx },
    { path: 'result.json', data: Buffer.isBuffer(result) ? result : Buffer.from(JSON.stringify(result)) },
  ];
}

async function rejection(input: SandboxFile[]): Promise<string> {
  try {
    await validateExportOutput(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ExportOutputError);
    return (error as ExportOutputError).reason;
  }
  throw new Error('expected the output to be rejected');
}

describe('export output', () => {
  it('returns the docx, the block count and the asset refs of image warnings (not the helper text)', async () => {
    const output = await validateExportOutput(files({ version: 1, blockCount: 12, imageWarnings: [{ assetRef: 'a.png', reason: '图片缺失：/work/assets/a.png' }] }));
    expect(output).toEqual({ docx: DOCX, blockCount: 12, imageWarnings: ['a.png'] });
  });

  it.each([
    ['only result.json', [{ path: 'result.json', data: Buffer.from('{}') }]],
    ['an extra file', [...files({ version: 1, blockCount: 0, imageWarnings: [] }), { path: 'extra.json', data: Buffer.from('{}') }]],
    ['a renamed docx', [{ path: 'other.docx', data: DOCX }, { path: 'result.json', data: Buffer.from('{"version":1,"blockCount":0,"imageWarnings":[]}') }]],
  ])('rejects output with %s', async (_label, input) => {
    expect(await rejection(input)).toBe('output must contain only document.docx and result.json');
  });

  it.each([
    ['not json', Buffer.from('{oops')],
    ['not utf-8', Buffer.from([0x7b, 0xff, 0x7d])],
    ['an array', []],
    ['another version', { version: 2, blockCount: 0, imageWarnings: [] }],
    ['an extra field', { version: 1, blockCount: 0, imageWarnings: [], error: '助手的错误文字' }],
    ['a negative block count', { version: 1, blockCount: -1, imageWarnings: [] }],
    ['a fractional block count', { version: 1, blockCount: 1.5, imageWarnings: [] }],
    ['a string block count', { version: 1, blockCount: '1', imageWarnings: [] }],
    ['missing warnings', { version: 1, blockCount: 0 }],
    ['a warning that is not an object', { version: 1, blockCount: 0, imageWarnings: ['a.png'] }],
    ['a warning with an extra field', { version: 1, blockCount: 0, imageWarnings: [{ assetRef: 'a', reason: '', path: '/work' }] }],
    ['a warning without a reason', { version: 1, blockCount: 0, imageWarnings: [{ assetRef: 'a' }] }],
    ['an overlong asset ref', { version: 1, blockCount: 0, imageWarnings: [{ assetRef: 'a'.repeat(257), reason: '' }] }],
    ['an overlong reason', { version: 1, blockCount: 0, imageWarnings: [{ assetRef: 'a', reason: '长'.repeat(201) }] }],
    ['too many warnings', { version: 1, blockCount: 0, imageWarnings: Array.from({ length: 2_001 }, () => ({ assetRef: 'a', reason: '' })) }],
  ])('rejects result.json with %s', async (_label, result) => {
    await expect(validateExportOutput(files(result))).rejects.toBeInstanceOf(ExportOutputError);
  });

  it('rejects a docx that fails the zip guard, with the guard reason only', async () => {
    const bomb = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'word/document.xml', data: Buffer.alloc(2 * 1024 * 1024) },
    ]);
    expect(await rejection(files({ version: 1, blockCount: 0, imageWarnings: [] }, bomb))).toBe('document.docx: zip_ratio');
    expect(await rejection(files({ version: 1, blockCount: 0, imageWarnings: [] }, Buffer.from('PK not really')))).toBe('document.docx: zip_invalid');
  });

  it('accepts exactly the limits the entry writes', async () => {
    const warnings = Array.from({ length: 2_000 }, () => ({ assetRef: 'a'.repeat(256), reason: '长'.repeat(200) }));
    expect((await validateExportOutput(files({ version: 1, blockCount: 0, imageWarnings: warnings }))).imageWarnings).toHaveLength(2_000);
  });
});

describe('export entry error codes', () => {
  it('takes the code from the last non-empty line of stdout', () => {
    expect(exportEntryErrorCode('noise\n{"error":"helper_failed"}\n\n')).toBe('helper_failed');
    expect(exportEntryErrorCode('{"error":"request_invalid"}')).toBe('request_invalid');
  });

  it('falls back to export_failed for anything else', () => {
    expect(exportEntryErrorCode('')).toBe('export_failed');
    expect(exportEntryErrorCode('{"error":"助手的错误文字"}')).toBe('export_failed');
    expect(exportEntryErrorCode('{"error":"helper_failed"}\nnot json')).toBe('export_failed');
    expect(exportEntryErrorCode('{"error":42}')).toBe('export_failed');
  });

  it('lists every code the entry can write, and no other', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(ENTRY_SOURCE, 'utf8');
    const written = new Set([...source.matchAll(/(?:ExportError|fail)\('([a-z_]+)'/g)].map((match) => match[1]!));
    // 未知错误的兜底代码写在 fail(…, 65) 的三元表达式中。
    expect(source).toContain("error.code : 'export_failed'");
    written.add('export_failed');
    expect([...written].sort()).toEqual([...EXPORT_ENTRY_ERROR_CODES].sort());
  });
});
