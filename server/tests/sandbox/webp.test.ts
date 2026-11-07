// WebP 容器解析与首帧提取（server/sandbox/export/webp.mjs，路线图 7.4i），不需要 Docker：
// - 三种布局（VP8、VP8L、VP8X + ALPH + VP8）的画布尺寸；静态图的帧就是原文件；
// - 动图取第一帧：位置（偏移按 2 像素）、尺寸，重新封装成合法的静态 WebP（VP8L / VP8 / VP8X + ALPH + VP8）；
// - 不合法的容器、越界的块、超出像素上限的画布都拒绝；
// - Chromium 截图是否全透明的判断（解码失败时按转换失败处理）。
// 转换后在 docx 中的显示见 tests/sandbox/docker/exportDocument.test.ts。
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

interface ParsedWebp {
  width: number;
  height: number;
  animated: boolean;
  frame: { x: number; y: number; width: number; height: number; data: Buffer };
}
interface WebpModule {
  MAX_WEBP_SIDE: number;
  MAX_WEBP_PIXELS: number;
  isWebp(header: Buffer): boolean;
  parseWebp(buffer: Buffer): ParsedWebp;
  pngHasVisiblePixels(png: Buffer, inflate: (data: Buffer) => Buffer): boolean;
  WebpError: new (reason: string) => Error;
}

const webp = (await import(new URL('../../sandbox/export/webp.mjs', import.meta.url).href)) as WebpModule;
const sample = (name: string) => readFileSync(new URL(`samples/webp/${name}.webp`, import.meta.url));

function chunk(fourcc: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'latin1');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function riff(body: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

/** 文件中第一个某种块的内容。 */
function chunkOf(file: Buffer, fourcc: string): Buffer {
  let offset = 12;
  while (offset + 8 <= file.length) {
    const size = file.readUInt32LE(offset + 4);
    if (file.toString('latin1', offset, offset + 4) === fourcc) return file.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size & 1);
  }
  throw new Error(`no ${fourcc}`);
}

function vp8x(flags: number, width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return chunk('VP8X', data);
}

function anmf(x: number, y: number, width: number, height: number, frame: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUIntLE(x / 2, 0, 3);
  header.writeUIntLE(y / 2, 3, 3);
  header.writeUIntLE(width - 1, 6, 3);
  header.writeUIntLE(height - 1, 9, 3);
  header.writeUIntLE(100, 12, 3);
  return chunk('ANMF', Buffer.concat([header, frame]));
}

/** 用给定的扫描线生成 8 位 RGBA PNG（每行过滤方式取 filter）。 */
function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number], filter = 0): Buffer {
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(width * 4);
  for (let y = 0; y < height; y += 1) {
    const line = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x += 1) line.set(pixel(x, y), x * 4);
    const encoded = Buffer.alloc(width * 4);
    for (let i = 0; i < line.length; i += 1) {
      const left = i >= 4 ? line[i - 4]! : 0;
      encoded[i] = (line[i]! - (filter === 1 ? left : filter === 2 ? previous[i]! : 0)) & 0xff;
    }
    rows.push(Buffer.concat([Buffer.from([filter]), encoded]));
    previous = line;
  }
  const png = (type: string, data: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), png('IHDR', ihdr), png('IDAT', deflateSync(Buffer.concat(rows))), png('IEND', Buffer.alloc(0))]);
}

describe('parseWebp', () => {
  it.each(['lossless-alpha', 'lossy-alpha', 'opaque-lossy'])('still image %s: canvas size, the frame is the file itself', (name) => {
    const file = sample(name);
    expect(webp.isWebp(file.subarray(0, 12))).toBe(true);
    const parsed = webp.parseWebp(file);
    expect(parsed).toMatchObject({ width: 64, height: 48, animated: false, frame: { x: 0, y: 0, width: 64, height: 48 } });
    expect(parsed.frame.data.equals(file)).toBe(true);
  });

  it('animated image: takes the first frame (cropped by the encoder) and wraps it as a still VP8L image', () => {
    const file = sample('animated');
    const parsed = webp.parseWebp(file);
    expect(parsed).toMatchObject({ width: 64, height: 48, animated: true, frame: { x: 0, y: 0, width: 32, height: 48 } });
    const first = chunkOf(file, 'ANMF').subarray(16);
    expect(parsed.frame.data.equals(riff(first))).toBe(true);
    // 封装出的静态图本身也能被解析，尺寸与帧相同。
    expect(webp.parseWebp(parsed.frame.data)).toMatchObject({ width: 32, height: 48, animated: false });
  });

  it('animated image: frame offsets are in units of 2 pixels; lossy frames with alpha become VP8X + ALPH + VP8', () => {
    const lossy = sample('lossy-alpha');
    const alpha = chunkOf(lossy, 'ALPH');
    const vp8 = chunkOf(lossy, 'VP8 ');
    const second = chunkOf(sample('opaque-lossy'), 'VP8 ');
    const file = riff(Buffer.concat([
      vp8x(0x02 | 0x10, 200, 100),
      chunk('ANIM', Buffer.alloc(6)),
      anmf(10, 4, 64, 48, Buffer.concat([chunk('ALPH', alpha), chunk('VP8 ', vp8)])),
      anmf(0, 0, 64, 48, chunk('VP8 ', second)),
    ]));
    const parsed = webp.parseWebp(file);
    expect(parsed).toMatchObject({ width: 200, height: 100, animated: true, frame: { x: 10, y: 4, width: 64, height: 48 } });
    expect(parsed.frame.data.toString('latin1', 12, 16)).toBe('VP8X');
    expect(chunkOf(parsed.frame.data, 'ALPH').equals(alpha)).toBe(true);
    expect(chunkOf(parsed.frame.data, 'VP8 ').equals(vp8)).toBe(true);
    expect(chunkOf(parsed.frame.data, 'VP8X')[0]).toBe(0x10);
    expect(webp.parseWebp(parsed.frame.data)).toMatchObject({ width: 64, height: 48, animated: false });
    // 不透明的有损帧用简单格式。
    const opaque = webp.parseWebp(riff(Buffer.concat([vp8x(0x02, 64, 48), anmf(0, 0, 64, 48, chunk('VP8 ', second))])));
    expect(opaque.frame.data.equals(riff(chunk('VP8 ', second)))).toBe(true);
  });

  it.each([
    ['not a webp', () => Buffer.from('not a webp image at all')],
    ['a riff size beyond the file', () => { const file = Buffer.from(sample('opaque-lossy')); file.writeUInt32LE(file.length * 2, 4); return file; }],
    ['a chunk beyond the container', () => riff(Buffer.concat([Buffer.from('VP8 ', 'latin1'), Buffer.from([0xff, 0xff, 0, 0])]))],
    ['a broken VP8 start code', () => riff(chunk('VP8 ', Buffer.alloc(10)))],
    ['a broken VP8L signature', () => riff(chunk('VP8L', Buffer.alloc(5)))],
    ['an unknown first chunk', () => riff(chunk('ABCD', Buffer.alloc(10)))],
    ['an animation without frames', () => riff(Buffer.concat([vp8x(0x02, 64, 48), chunk('ANIM', Buffer.alloc(6))]))],
    ['a frame outside the canvas', () => riff(Buffer.concat([vp8x(0x02, 64, 48), anmf(2, 0, 64, 48, chunk('VP8 ', chunkOf(sample('opaque-lossy'), 'VP8 ')))]))],
    ['a frame whose bitstream size differs', () => riff(Buffer.concat([vp8x(0x02, 64, 48), anmf(0, 0, 32, 48, chunk('VP8 ', chunkOf(sample('opaque-lossy'), 'VP8 ')))]))],
    ['a canvas wider than the side limit', () => riff(vp8x(0x02, webp.MAX_WEBP_SIDE + 1, 10))],
    ['a canvas over the pixel limit', () => riff(vp8x(0x02, 10_000, 10_000))],
    ['an extended still whose bitstream differs from the canvas', () => riff(Buffer.concat([vp8x(0, 100, 48), chunk('VP8 ', chunkOf(sample('opaque-lossy'), 'VP8 '))]))],
  ])('rejects %s', (_name, build) => {
    expect(() => webp.parseWebp(build())).toThrow(webp.WebpError);
  });
});

describe('pngHasVisiblePixels', () => {
  it.each([0, 1, 2])('finds a single visible pixel in a transparent image (filter %i), and none in a fully transparent one', (filter) => {
    const one = rgbaPng(16, 8, (x, y) => (x === 13 && y === 6 ? [10, 20, 30, 1] : [0, 0, 0, 0]), filter);
    expect(webp.pngHasVisiblePixels(one, inflateSync)).toBe(true);
    const none = rgbaPng(16, 8, () => [255, 255, 255, 0], filter);
    expect(webp.pngHasVisiblePixels(none, inflateSync)).toBe(false);
  });

  it('treats anything other than 8-bit non-interlaced RGBA as visible', () => {
    const rgb = rgbaPng(4, 4, () => [0, 0, 0, 0]);
    rgb[25] = 2;
    expect(webp.pngHasVisiblePixels(rgb, inflateSync)).toBe(true);
    expect(webp.pngHasVisiblePixels(Buffer.from('short'), inflateSync)).toBe(true);
  });
});
