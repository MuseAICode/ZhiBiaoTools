// render-html 入口（server/sandbox/export/render-html.mjs、htmlImage.mjs，8.8a1）不需要 Docker 的部分：请求校验、PNG 尺寸读取，
// 以及入口、镜像与 worker 三处的约定一致（上限、画布模块的路径与复制）。真实沙箱中的转图见 tests/sandbox/docker/renderHtml.test.ts。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RENDER_HTML_MAX_HTML_BYTES, RENDER_HTML_MAX_TOTAL_HTML_BYTES } from '../../src/render/htmlImages.ts';
import { RENDER_HTML_MAX_ITEMS, RENDER_HTML_MAX_PNG_BYTES } from '../../src/sandbox/templates.ts';
// @ts-expect-error 沙箱镜像中的 JavaScript 模块，没有类型声明。
import * as entry from '../../sandbox/export/htmlImage.mjs';

const sandboxDirectory = new URL('../../sandbox/export/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, sandboxDirectory), 'utf8');

const item = { id: 'h001', html: '<p>图</p>', frame_size: 'wide', check_layout: true };

describe('parseRenderHtmlRequest', () => {
  it('accepts the request built by the worker', () => {
    expect(entry.parseRenderHtmlRequest({ version: 1, items: [item, { ...item, id: 'h002', check_layout: false }] })).toEqual([
      { id: 'h001', html: '<p>图</p>', frameSize: 'wide', checkLayout: true },
      { id: 'h002', html: '<p>图</p>', frameSize: 'wide', checkLayout: false },
    ]);
  });

  it.each([
    ['not an object', []],
    ['another version', { version: 2, items: [item] }],
    ['an extra field', { version: 1, items: [item], extra: 1 }],
    ['no items', { version: 1, items: [] }],
    ['too many items', { version: 1, items: Array.from({ length: 51 }, (_, index) => ({ ...item, id: `h${index}` })) }],
    ['a duplicate id', { version: 1, items: [item, item] }],
    ['a path as id', { version: 1, items: [{ ...item, id: '../x' }] }],
    ['an unknown frame', { version: 1, items: [{ ...item, frame_size: 'toString' }] }],
    ['an item with an extra field', { version: 1, items: [{ ...item, script: true }] }],
    ['an item without check_layout', { version: 1, items: [{ id: 'h001', html: 'x', frame_size: 'wide' }] }],
    ['an html over 1 MiB', { version: 1, items: [{ ...item, html: 'x'.repeat(1024 * 1024 + 1) }] }],
    ['a batch over 16 MiB', { version: 1, items: Array.from({ length: 17 }, (_, index) => ({ ...item, id: `h${index}`, html: 'x'.repeat(1024 * 1024) })) }],
  ])('rejects %s', (_name, raw) => {
    expect(() => entry.parseRenderHtmlRequest(raw)).toThrow(expect.objectContaining({ code: 'request_invalid' }));
  });
});

describe('pngSize', () => {
  it('reads the IHDR size and rejects other data', () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(2480, 16);
    png.writeUInt32BE(1654, 20);
    expect(entry.pngSize(png)).toEqual({ width: 2480, height: 1654 });
    expect(entry.pngSize(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('entry, image and worker agree', () => {
  it('use the same limits', () => {
    expect(entry.MAX_ITEMS).toBe(RENDER_HTML_MAX_ITEMS);
    expect(entry.MAX_HTML_BYTES).toBe(RENDER_HTML_MAX_HTML_BYTES);
    expect(entry.MAX_TOTAL_HTML_BYTES).toBe(RENDER_HTML_MAX_TOTAL_HTML_BYTES);
    expect(entry.MAX_PNG_BYTES).toBe(RENDER_HTML_MAX_PNG_BYTES);
    expect(entry.FRAME_SIZES).toEqual(['square', 'wide', 'tall', 'panorama']);
  });

  it('load the desktop canvas module from where the image copies it, and copy the entry files', () => {
    const dockerfile = read('Dockerfile');
    expect(read('render-html.mjs')).toContain("require('/opt/export/desktop/electron/shared/htmlImageLayout.cjs')");
    expect(dockerfile).toContain('COPY --chmod=0644 --from=desktop shared/htmlImageLayout.cjs /opt/export/desktop/electron/shared/');
    expect(dockerfile).toMatch(/^COPY --chmod=0644 package\.json .*render-html\.mjs htmlImage\.mjs \/opt\/export\/$/m);
  });

  it('never enable page scripts in the entry', () => {
    // 只有测试能经 renderHtmlImage 的 javaScriptEnabled 打开（对照组）；入口不传这个选项。
    expect(read('render-html.mjs')).not.toContain('javaScriptEnabled');
    expect(read('htmlImage.mjs')).toContain('javaScriptEnabled: options.javaScriptEnabled === true');
  });
});
