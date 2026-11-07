// export 沙箱测试用的读取工具：读 docx（ZIP）中的条目、解码 Chromium 截出的 PNG，不依赖第三方库。
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync, inflateRawSync, inflateSync } from 'node:zlib';

/** 读出 ZIP 中的全部条目（只支持存储与 deflate，够读 Open XML SDK 写出的 docx）。 */
export function readZipEntries(zip: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export interface DecodedPng {
  width: number;
  height: number;
  /** 某个像素的 [r, g, b]。 */
  pixel(x: number, y: number): [number, number, number];
  /** 某个像素的不透明度（RGB 为 255）。 */
  alpha(x: number, y: number): number;
}

/** 解码 8 位、不隔行的 RGB / RGBA PNG（Chromium 截图的格式）。 */
export function decodePng(png: Buffer): DecodedPng {
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('not a png');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [bitDepth, colorType, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error('unsupported png');
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0;
      let value = line[x]!;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
        value += a <= b && a <= c ? left : b <= c ? up : upLeft;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const start = Math.floor(y) * stride + Math.floor(x) * channels;
      return [pixels[start]!, pixels[start + 1]!, pixels[start + 2]!];
    },
    alpha(x, y) {
      return channels === 4 ? pixels[Math.floor(y) * stride + Math.floor(x) * channels + 3]! : 255;
    },
  };
}

/** 生成纯灰的 RGB PNG（作为配图放进 /work/assets）。 */
export function grayPng(width: number, height: number): Buffer {
  const rows = Buffer.alloc(height * (width * 3 + 1), 0x80);
  for (let y = 0; y < height; y += 1) rows[y * (width * 3 + 1)] = 0;
  return withPngChunks(width, height, deflateSync(rows));
}

/** 按宽高与已压缩的像素数据拼出 8 位 RGB 的 PNG（IHDR、IDAT、IEND，带 CRC）。 */
function withPngChunks(width: number, height: number, idat: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 约 bytes 字节、像素随机的 RGB PNG（IDAT 用 deflate 的不压缩块，docx 的 deflate 也压不动），用于按体积检查导出的内存预算
 * （路线图 7.4b）。助手只读文件头取格式与宽高，不解码像素。
 */
export function noisePng(bytes: number): Buffer {
  const width = 1024;
  const rowBytes = width * 3 + 1;
  const height = Math.max(1, Math.floor(bytes / rowBytes));
  const rows = randomBytes(height * rowBytes);
  for (let y = 0; y < height; y += 1) rows[y * rowBytes] = 0;
  return withPngChunks(width, height, deflateSync(rows, { level: 0 }));
}

