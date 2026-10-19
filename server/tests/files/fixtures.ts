// 测试用的文件内容：按格式手工拼出最小的合法文件头，ZIP 用不压缩（stored）的条目拼出完整结构。
import { crc32 } from 'node:zlib';

/** 不压缩的 ZIP：本地文件头 + 数据、中央目录、目录尾记录。 */
export function makeZip(entries: Record<string, string | Buffer>, comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(entries).length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...locals, directory, end, commentBytes]);
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

export function makeDocx(extra: Record<string, string | Buffer> = {}): Buffer {
  return makeZip({ '[Content_Types].xml': CONTENT_TYPES, 'word/document.xml': '<w:document/>', ...extra });
}

export function makeXlsx(): Buffer {
  return makeZip({ '[Content_Types].xml': CONTENT_TYPES, 'xl/workbook.xml': '<workbook/>' });
}

export function makePdf(): Buffer {
  return Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
}

export function makeOle(): Buffer {
  return Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
}

export function makePng(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0000000dIHDR', 'latin1'), Buffer.alloc(32)]);
}

export function makeJpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60), Buffer.from([0xff, 0xd9])]);
}

export function makeGif(): Buffer {
  return Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(40)]);
}

export function makeWebp(): Buffer {
  const body = Buffer.concat([Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(40)]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

export function makeBmp(declaredSize?: number): Buffer {
  const file = Buffer.alloc(70);
  file.write('BM', 0, 'latin1');
  file.writeUInt32LE(declaredSize ?? file.length, 2);
  file.writeUInt32LE(54, 10);
  return file;
}

/** 浏览器会当作网页渲染的内容：用来确认它不能伪装成图片或文档上传，也不会被内联渲染。 */
export const HTML_PAYLOAD = Buffer.from('<!doctype html><script>alert(document.cookie)</script>', 'utf8');
export const SVG_PAYLOAD = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'utf8');
