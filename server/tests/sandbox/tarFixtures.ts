// 构造任意 tar 条目（含符号链接、设备文件、错误的校验和等），用于测试取回时的校验。
import { Readable } from 'node:stream';

export interface TarEntryOptions {
  name: string;
  /** typeflag：'0' 普通文件、'1' 硬链接、'2' 符号链接、'3' 字符设备、'4' 块设备、'5' 目录、'6' FIFO、'x' PAX、'L' GNU 长名。 */
  type?: string;
  data?: Buffer;
  /** 头部中的大小，默认为 data 的长度。 */
  size?: number;
  linkname?: string;
  prefix?: string;
  /** 'posix'（ustar\0 00）或 'gnu'（ustar  \0）。 */
  format?: 'posix' | 'gnu';
  /** 写入错误的校验和。 */
  badChecksum?: boolean;
  /** 原样写入大小字段（如 base-256 编码）。 */
  rawSize?: Buffer;
}

export function tarEntry(options: TarEntryOptions): Buffer {
  const data = options.data ?? Buffer.alloc(0);
  const header = Buffer.alloc(512);
  header.write(options.name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  if (options.rawSize) options.rawSize.copy(header, 124);
  else header.write(`${(options.size ?? data.length).toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(options.type ?? '0', 156, 1, 'ascii');
  if (options.linkname) header.write(options.linkname, 157, 100, 'utf8');
  if (options.format === 'gnu') header.write('ustar  \0', 257, 8, 'ascii');
  else {
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
  }
  if (options.prefix) header.write(options.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  if (options.badChecksum) sum += 1;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(padding)]);
}

/** PAX 扩展头（类型 x）：records 为键值对。 */
export function paxEntry(records: Record<string, string>): Buffer {
  const lines = Object.entries(records).map(([key, value]) => {
    // 记录长度按 UTF-8 字节计（中文路径）。
    const body = ` ${key}=${value}\n`;
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
    let length = bytes(body) + 1;
    while (bytes(`${length}${body}`) !== length) length = bytes(`${length}${body}`);
    return `${length}${body}`;
  });
  return tarEntry({ name: 'PaxHeaders/entry', type: 'x', data: Buffer.from(lines.join(''), 'utf8') });
}

export const END_OF_ARCHIVE = Buffer.alloc(1024);

export function tarStream(...parts: Buffer[]): Readable {
  return Readable.from([Buffer.concat(parts)]);
}
