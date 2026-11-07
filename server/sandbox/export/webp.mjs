// WebP 容器的解析与首帧提取（路线图第 7 步 7.4i）：整本导出把 WebP 配图转成 PNG 之前（与桌面版
// exportService.normalizeImageForDocx 一致，兼容不支持 WebP 的旧版 Word 与 WPS），在这里读出画布尺寸，
// 动图取第一帧并重新封装成静态 WebP，再交给 Chromium 栅格化（render.mjs，禁用 JavaScript）。
// 只解析 RIFF 容器与各种位流的头部，不解码像素；输入按不可信数据处理，任何不符都抛 WebpError。
// 规范：https://developers.google.com/speed/webp/docs/riff_container

/** 转换的像素上限：单边不超过 Chromium 截图的上限，总像素不超过 5,000 万（约 200 MiB 的 RGBA）。 */
export const MAX_WEBP_SIDE = 16_384;
export const MAX_WEBP_PIXELS = 50_000_000;

export class WebpError extends Error {
  constructor(reason) {
    super(`webp rejected: ${reason}`);
    this.name = 'WebpError';
    this.reason = reason;
  }
}

/** 文件头是否为 WebP（RIFF....WEBP）。 */
export function isWebp(header) {
  return header.length >= 12 && header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 12) === 'WEBP';
}

function readUint24(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

/** 依次读出 [start, end) 中的块：{ fourcc, data }；块长度越界时抛错。 */
function readChunks(buffer, start, end) {
  const chunks = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new WebpError('truncated chunk header');
    const fourcc = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (size > end - dataStart) throw new WebpError('chunk exceeds container');
    chunks.push({ fourcc, data: buffer.subarray(dataStart, dataStart + size) });
    offset = dataStart + size + (size & 1);
    if (chunks.length > 100_000) throw new WebpError('too many chunks');
  }
  return chunks;
}

/** 有损位流（VP8）的宽高。 */
function vp8Size(data) {
  if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new WebpError('bad VP8 header');
  return { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
}

/** 无损位流（VP8L）的宽高。 */
function vp8lSize(data) {
  if (data.length < 5 || data[0] !== 0x2f) throw new WebpError('bad VP8L header');
  const bits = data.readUInt32LE(1);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

function chunk(fourcc, data) {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'latin1');
  header.writeUInt32LE(data.length, 4);
  return data.length & 1 ? [header, data, Buffer.alloc(1)] : [header, data];
}

function riff(parts) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

/**
 * 由一帧的位流块（可选 ALPH + VP8，或 VP8L）封装成静态 WebP：VP8L 与不带透明的 VP8 用简单格式，带 ALPH 的 VP8 用扩展格式
 * （VP8X 只置透明标志）。返回静态 WebP 与位流的宽高。
 */
function stillFromFrame(frameChunks) {
  const alpha = frameChunks.find((item) => item.fourcc === 'ALPH');
  const lossy = frameChunks.find((item) => item.fourcc === 'VP8 ');
  const lossless = frameChunks.find((item) => item.fourcc === 'VP8L');
  if (lossless && !lossy) return { ...vp8lSize(lossless.data), data: riff(chunk('VP8L', lossless.data)) };
  if (!lossy || lossless) throw new WebpError('frame has no image bitstream');
  const size = vp8Size(lossy.data);
  if (!alpha) return { ...size, data: riff(chunk('VP8 ', lossy.data)) };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x10;
  vp8x.writeUIntLE(size.width - 1, 4, 3);
  vp8x.writeUIntLE(size.height - 1, 7, 3);
  return { ...size, data: riff([...chunk('VP8X', vp8x), ...chunk('ALPH', alpha.data), ...chunk('VP8 ', lossy.data)]) };
}

function checkSize(width, height) {
  if (!(width >= 1 && height >= 1)) throw new WebpError('empty image');
  if (width > MAX_WEBP_SIDE || height > MAX_WEBP_SIDE || width * height > MAX_WEBP_PIXELS) throw new WebpError('image too large');
}

/**
 * 解析 WebP：返回画布宽高与要栅格化的静态帧（动图为第一帧，带它在画布中的位置）。静态图的帧就是原文件。
 * @returns {{ width: number, height: number, animated: boolean, frame: { x: number, y: number, width: number, height: number, data: Buffer } }}
 */
export function parseWebp(buffer) {
  if (!isWebp(buffer)) throw new WebpError('not a webp');
  const declared = buffer.readUInt32LE(4);
  if (declared < 4 || declared + 8 > buffer.length) throw new WebpError('bad riff size');
  const chunks = readChunks(buffer, 12, declared + 8);
  const first = chunks[0];
  if (!first) throw new WebpError('no chunks');
  if (first.fourcc === 'VP8 ' || first.fourcc === 'VP8L') {
    const size = first.fourcc === 'VP8 ' ? vp8Size(first.data) : vp8lSize(first.data);
    checkSize(size.width, size.height);
    return { ...size, animated: false, frame: { x: 0, y: 0, ...size, data: buffer } };
  }
  if (first.fourcc !== 'VP8X' || first.data.length < 10) throw new WebpError('unknown layout');
  const flags = first.data[0];
  const width = readUint24(first.data, 4) + 1;
  const height = readUint24(first.data, 7) + 1;
  checkSize(width, height);
  if (!(flags & 0x02)) {
    const still = stillFromFrame(chunks.slice(1));
    if (still.width !== width || still.height !== height) throw new WebpError('bitstream size differs from canvas');
    return { width, height, animated: false, frame: { x: 0, y: 0, width, height, data: buffer } };
  }
  const frame = chunks.find((item) => item.fourcc === 'ANMF');
  if (!frame || frame.data.length < 16) throw new WebpError('animation has no frame');
  const x = readUint24(frame.data, 0) * 2;
  const y = readUint24(frame.data, 3) * 2;
  const frameWidth = readUint24(frame.data, 6) + 1;
  const frameHeight = readUint24(frame.data, 9) + 1;
  if (x + frameWidth > width || y + frameHeight > height) throw new WebpError('frame outside canvas');
  const still = stillFromFrame(readChunks(frame.data, 16, frame.data.length));
  if (still.width !== frameWidth || still.height !== frameHeight) throw new WebpError('frame bitstream size differs');
  return { width, height, animated: true, frame: { x, y, width: frameWidth, height: frameHeight, data: still.data } };
}

/**
 * Chromium 截出的 PNG 中是否有不透明度大于 0 的像素。图片解码失败时页面上什么也不画，截图是全透明的；
 * 这种结果按转换失败处理（与桌面版 nativeImage 解码为空时相同），不把空白图片嵌进文档。
 * 只支持 Chromium 输出的 8 位、非隔行的 RGB / RGBA；其他形态一律视为有像素（RGB 没有透明）。
 */
export function pngHasVisiblePixels(png, inflate) {
  if (png.length < 33 || png.toString('latin1', 12, 16) !== 'IHDR') return true;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  if (colorType !== 6 || bitDepth !== 8 || interlace !== 0) return true;
  const idat = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflate(Buffer.concat(idat));
  const stride = width * 4;
  let previous = Buffer.alloc(stride);
  let current = Buffer.alloc(stride);
  for (let row = 0; row < height; row += 1) {
    const start = row * (stride + 1);
    if (start + stride + 1 > raw.length) return true;
    const filter = raw[start];
    for (let i = 0; i < stride; i += 1) {
      const value = raw[start + 1 + i];
      const left = i >= 4 ? current[i - 4] : 0;
      const up = previous[i];
      const upLeft = i >= 4 ? previous[i - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      current[i] = (value + predictor) & 0xff;
    }
    for (let i = 3; i < stride; i += 4) if (current[i] !== 0) return true;
    [previous, current] = [current, previous];
  }
  return false;
}
