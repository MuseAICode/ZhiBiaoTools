// render-html 入口（server/sandbox/export/render-html.mjs、htmlImage.mjs，8.8a1）不需要 Docker 的部分：请求校验、PNG 尺寸读取，
// 以及入口、镜像与 worker 三处的约定一致（上限、画布模块的路径与复制）。真实沙箱中的转图见 tests/sandbox/docker/renderHtml.test.ts。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RENDER_HTML_MAX_HTML_BYTES,
  RENDER_HTML_MAX_TOTAL_HTML_BYTES,
  RENDER_IMAGE_FORMATS,
  RENDER_IMAGE_MAX_BYTES,
  RENDER_IMAGE_MAX_HEIGHT,
  RENDER_IMAGE_MAX_TOTAL_BYTES,
  RENDER_IMAGE_MAX_WIDTH,
} from '../../src/render/htmlImages.ts';
import { RENDER_HTML_MAX_ITEMS, RENDER_HTML_MAX_PNG_BYTES } from '../../src/sandbox/templates.ts';
// @ts-expect-error 沙箱镜像中的 JavaScript 模块，没有类型声明。
import * as entry from '../../sandbox/export/htmlImage.mjs';
// @ts-expect-error 同上。
import * as convert from '../../sandbox/export/imageConvert.mjs';

const sandboxDirectory = new URL('../../sandbox/export/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, sandboxDirectory), 'utf8');

const item = { id: 'h001', kind: 'html', html: '<p>图</p>', frame_size: 'wide', check_layout: true };
const image = { id: 'h003', kind: 'image', format: 'webp' };

describe('parseRenderHtmlRequest', () => {
  it('accepts the request built by the worker', () => {
    expect(entry.parseRenderHtmlRequest({ version: 1, items: [item, { ...item, id: 'h002', check_layout: false }, image] })).toEqual([
      { id: 'h001', kind: 'html', html: '<p>图</p>', frameSize: 'wide', checkLayout: true },
      { id: 'h002', kind: 'html', html: '<p>图</p>', frameSize: 'wide', checkLayout: false },
      { id: 'h003', kind: 'image', format: 'webp' },
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
    ['an item without check_layout', { version: 1, items: [{ id: 'h001', kind: 'html', html: 'x', frame_size: 'wide' }] }],
    ['an html item without kind (8.8a1 form)', { version: 1, items: [{ id: 'h001', html: 'x', frame_size: 'wide', check_layout: true }] }],
    ['an unknown kind', { version: 1, items: [{ ...item, kind: 'pdf' }] }],
    ['an image of an unknown format', { version: 1, items: [{ ...image, format: 'gif' }] }],
    ['an image with an extra field', { version: 1, items: [{ ...image, data: 'x' }] }],
    ['an image with html fields', { version: 1, items: [{ ...image, html: 'x', frame_size: 'wide', check_layout: true }] }],
    ['an image id shared with an html item', { version: 1, items: [item, { ...image, id: 'h001' }] }],
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
    expect(convert.IMAGE_FORMATS).toEqual([...RENDER_IMAGE_FORMATS]);
    expect(convert.MAX_IMAGE_BYTES).toBe(RENDER_IMAGE_MAX_BYTES);
    expect(convert.MAX_TOTAL_IMAGE_BYTES).toBe(RENDER_IMAGE_MAX_TOTAL_BYTES);
    expect(convert.MAX_OUTPUT_WIDTH).toBe(RENDER_IMAGE_MAX_WIDTH);
    expect(convert.MAX_OUTPUT_HEIGHT).toBe(RENDER_IMAGE_MAX_HEIGHT);
  });

  it('use the output limits of the desktop generated-image compression', () => {
    const desktop = readFileSync(new URL('../../../client/electron/utils/imageCompression.cjs', import.meta.url), 'utf8');
    expect(desktop).toContain(`const MAX_WIDTH = ${RENDER_IMAGE_MAX_WIDTH};`);
    expect(desktop).toContain(`const MAX_HEIGHT = ${RENDER_IMAGE_MAX_HEIGHT};`);
  });

  it('load the desktop canvas module from where the image copies it, and copy the entry files', () => {
    const dockerfile = read('Dockerfile');
    expect(read('render-html.mjs')).toContain("require('/opt/export/desktop/electron/shared/htmlImageLayout.cjs')");
    expect(dockerfile).toContain('COPY --chmod=0644 --from=desktop shared/htmlImageLayout.cjs /opt/export/desktop/electron/shared/');
    expect(dockerfile).toMatch(/^COPY --chmod=0644 package\.json .*render-html\.mjs htmlImage\.mjs imageConvert\.mjs \/opt\/export\/$/m);
  });

  it('never enable page scripts in the entry', () => {
    // 只有测试能经 renderHtmlImage 的 javaScriptEnabled 打开（对照组）；入口不传这个选项。
    expect(read('render-html.mjs')).not.toContain('javaScriptEnabled');
    expect(read('htmlImage.mjs')).toContain('javaScriptEnabled: options.javaScriptEnabled === true');
    // 图片转 PNG 没有对照组的开关，固定禁用。
    expect(read('imageConvert.mjs')).toContain('javaScriptEnabled: false,');
    expect(read('imageConvert.mjs').match(/javaScriptEnabled/g)).toHaveLength(1);
  });
});

describe('outputScale (8.8a2)', () => {
  it.each([
    ['a small raster stays as is', [300, 200, false], { width: 300, height: 200 }],
    ['a wide raster shrinks to 1920 wide', [3000, 1000, false], { width: 1920, height: 640 }],
    ['a tall raster shrinks to 2880 high', [1000, 4000, false], { width: 720, height: 2880 }],
    ['a small vector grows to fit', [64, 32, true], { width: 1920, height: 960 }],
    ['a tall vector grows to fit', [75, 150, true], { width: 1440, height: 2880 }],
    ['a huge vector shrinks to fit', [100_000, 10, true], { width: 1920, height: 1 }],
  ])('%s', (_name, [width, height, vector], expected) => {
    expect(convert.outputScale(width, height, vector)).toMatchObject(expected);
  });
});

describe('raster headers (8.9)', () => {
  const png = (width: number, height: number) => {
    const data = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
    data.writeUInt32BE(13, 8);
    data.write('IHDR', 12, 'latin1');
    data.writeUInt32BE(width, 16);
    data.writeUInt32BE(height, 20);
    return data;
  };
  const jpeg = (width: number, height: number, before: Buffer[] = []) =>
    Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      ...before,
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]),
      Buffer.alloc(9),
    ]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);

  it('read the PNG IHDR size and reject other data', () => {
    expect(convert.pngDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(convert.pngDimensions(png(640, 480).subarray(0, 20))).toBeNull();
    const notIhdr = png(1, 1);
    notIhdr.write('IDAT', 12, 'latin1');
    expect(convert.pngDimensions(notIhdr)).toBeNull();
    expect(convert.pngDimensions(jpeg(1, 1))).toBeNull();
  });

  it('read the JPEG frame size after other segments, and reject truncated or headless data', () => {
    expect(convert.jpegDimensions(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(convert.jpegDimensions(jpeg(300, 200, [app0, Buffer.from([0xff, 0xff])]))).toEqual({ width: 300, height: 200 });
    // DHT（C4）不是帧头。
    expect(convert.jpegDimensions(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x04, 0, 0]), jpeg(5, 6).subarray(2)]))).toEqual({ width: 5, height: 6 });
    expect(convert.jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
    expect(convert.jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x00]))).toBeNull();
    expect(convert.jpegDimensions(png(1, 1))).toBeNull();
  });

  it('refuse to hand an oversized raster to the browser (decompression bomb)', async () => {
    const browser = { newContext: () => Promise.reject(new Error('must not decode')) };
    const options = { timeoutMs: 1000, maxPngBytes: 1024, pngSize: () => null };
    await expect(convert.convertImage(browser, { id: 'i001', format: 'png' }, png(20_000, 10), options)).rejects.toMatchObject({ code: 'image_invalid' });
    await expect(convert.convertImage(browser, { id: 'i001', format: 'png' }, png(8000, 8000), options)).rejects.toMatchObject({ code: 'image_invalid' });
    await expect(convert.convertImage(browser, { id: 'i001', format: 'jpeg' }, jpeg(16_000, 16_000), options)).rejects.toMatchObject({ code: 'image_invalid' });
    await expect(convert.convertImage(browser, { id: 'i001', format: 'jpeg' }, png(10, 10), options)).rejects.toMatchObject({ code: 'image_invalid' });
  });
});
