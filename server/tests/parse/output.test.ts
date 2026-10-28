// 解析输出的内容校验与图片引用改写（src/parse/output.ts）：沙箱的输出按不可信输入处理。
import { describe, expect, it } from 'vitest';
import { entryErrorCode, imageMatchesMime, ParseOutputError, rewriteImageReferences, validateParseOutput } from '../../src/parse/output.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');

function file(path: string, data: string | Buffer): SandboxFile {
  return { path, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data };
}

function manifest(images: unknown[]): SandboxFile {
  return file('manifest.json', JSON.stringify({ version: 1, images }));
}

function reason(files: SandboxFile[]): string {
  try {
    validateParseOutput(files);
  } catch (error) {
    expect(error).toBeInstanceOf(ParseOutputError);
    return (error as ParseOutputError).reason;
  }
  throw new Error('expected rejection');
}

describe('validateParseOutput', () => {
  it('accepts markdown with the images listed in the manifest', () => {
    const output = validateParseOutput([
      file('content.md', '﻿# 标题\n\n![](images/image-0001.png)\n'),
      manifest([{ path: 'images/image-0001.png', mime: 'image/png' }, { path: 'images/image-0002.jpg', mime: 'image/jpeg' }]),
      file('images/image-0001.png', PNG),
      file('images/image-0002.jpg', JPEG),
    ]);
    expect(output.markdown).toBe('# 标题\n\n![](images/image-0001.png)\n');
    expect(output.images.map((image) => [image.path, image.mime])).toEqual([
      ['images/image-0001.png', 'image/png'],
      ['images/image-0002.jpg', 'image/jpeg'],
    ]);
  });

  it('rejects missing or extra files', () => {
    expect(reason([manifest([])])).toMatch(/missing/);
    expect(reason([file('content.md', 'x')])).toMatch(/missing/);
    expect(reason([file('content.md', 'x'), manifest([]), file('images/image-0001.png', PNG)])).toMatch(/not listed/);
    expect(reason([file('content.md', 'x'), manifest([]), file('extra.json', '{}')])).toMatch(/not listed/);
    expect(reason([file('content.md', 'x'), manifest([{ path: 'images/image-0001.png', mime: 'image/png' }]), file('other.md', 'y')])).toMatch(/missing/);
  });

  it('requires analysis.json only when the per-document analysis was asked for (6.10), and keeps its bytes as they are', () => {
    const base = [file('content.md', 'x'), manifest([])];
    expect(validateParseOutput(base).analysis).toBeNull();
    expect(reason([...base, file('analysis.json', '{}')])).toMatch(/not listed/);
    expect(() => validateParseOutput(base, { analysis: true })).toThrow(/analysis.json is missing/);
    expect(validateParseOutput([...base, file('analysis.json', '{"version":1}')], { analysis: true }).analysis?.toString('utf8')).toBe('{"version":1}');
    expect(() => validateParseOutput([...base, file('analysis.json', '{}'), file('extra.json', '{}')], { analysis: true })).toThrow(/not listed/);
  });

  it('rejects malformed manifests', () => {
    const md = file('content.md', 'x');
    expect(reason([md, file('manifest.json', 'not json')])).toMatch(/json/);
    expect(reason([md, file('manifest.json', '[]')])).toMatch(/object/);
    expect(reason([md, file('manifest.json', JSON.stringify({ version: 2, images: [] }))])).toMatch(/shape/);
    expect(reason([md, file('manifest.json', JSON.stringify({ version: 1, images: [], extra: 1 }))])).toMatch(/shape/);
    expect(reason([md, manifest([{ path: 'images/image-0001.png', mime: 'image/png', extra: 1 }])])).toMatch(/shape/);
    expect(reason([md, manifest([{ path: '../image-0001.png', mime: 'image/png' }])])).toMatch(/path/);
    expect(reason([md, manifest([{ path: 'images/image-0002.png', mime: 'image/png' }])])).toMatch(/path/);
    expect(reason([md, manifest([{ path: 'images/image-0001.svg', mime: 'image/svg+xml' }])])).toMatch(/path/);
    expect(reason([md, manifest([{ path: 'images/image-0001.png', mime: 'image/jpeg' }])])).toMatch(/mime/);
    expect(reason([md, manifest(Array.from({ length: 2_001 }, (_, index) => ({ path: `images/image-${String(index + 1).padStart(4, '0')}.png`, mime: 'image/png' })))])).toMatch(
      /too many/,
    );
  });

  it('rejects images whose content does not match the mime', () => {
    expect(reason([file('content.md', 'x'), manifest([{ path: 'images/image-0001.png', mime: 'image/png' }]), file('images/image-0001.png', Buffer.from('<svg/>'))])).toMatch(
      /content/,
    );
  });

  it('rejects markdown that is not utf-8', () => {
    expect(reason([file('content.md', Buffer.from([0xff, 0xfe, 0x00])), manifest([])])).toMatch(/utf-8/);
  });
});

describe('imageMatchesMime', () => {
  it('checks the magic bytes of each allowed type', () => {
    expect(imageMatchesMime(PNG, 'image/png')).toBe(true);
    expect(imageMatchesMime(JPEG, 'image/jpeg')).toBe(true);
    expect(imageMatchesMime(Buffer.from('GIF89a'), 'image/gif')).toBe(true);
    expect(imageMatchesMime(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP'), 'image/webp')).toBe(true);
    expect(imageMatchesMime(Buffer.concat([Buffer.from('BM'), Buffer.alloc(30)]), 'image/bmp')).toBe(true);
    expect(imageMatchesMime(PNG, 'image/jpeg')).toBe(false);
    expect(imageMatchesMime(PNG, 'image/svg+xml')).toBe(false);
  });
});

describe('rewriteImageReferences', () => {
  const urls = new Map([['images/image-0001.png', '/api/artifacts/a1/content']]);

  it('rewrites local images and drops every other image', () => {
    const markdown = [
      '![logo](images/image-0001.png "t")',
      '![remote](https://example.com/track.png)',
      '![data](data:image/png;base64,AAAA)',
      '<table><tr><td><img src="images/image-0001.png" width="10" onerror="x()"></td><td><img src=\'http://evil/x.png\'></td></tr></table>',
      '正文',
    ].join('\n');
    expect(rewriteImageReferences(markdown, urls)).toBe(
      ['![logo](/api/artifacts/a1/content "t")', '', '', '<table><tr><td><img src="/api/artifacts/a1/content"></td><td></td></tr></table>', '正文'].join('\n'),
    );
  });

  it('rejects references to images that are not in the output (原图资源缺失)', () => {
    expect(() => rewriteImageReferences('![](images/image-0002.png)', urls)).toThrow(expect.objectContaining({ missingImage: true }));
    expect(() => rewriteImageReferences('<img src="images/image-0009.jpg">', urls)).toThrow(ParseOutputError);
  });
});

describe('entryErrorCode', () => {
  it('takes the code on the last line and ignores anything else', () => {
    expect(entryErrorCode('Warning: something\n{"error":"pdf_too_many_pages"}\n')).toBe('pdf_too_many_pages');
    expect(entryErrorCode('{"error":"zip_ratio"}')).toBe('zip_ratio');
    expect(entryErrorCode('{"error":"rm -rf"}')).toBe('conversion_failed');
    expect(entryErrorCode('{"error":"zip_ratio"}\nnoise')).toBe('conversion_failed');
    expect(entryErrorCode('')).toBe('conversion_failed');
  });
});
