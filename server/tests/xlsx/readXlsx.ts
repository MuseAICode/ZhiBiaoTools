// 测试用：解开 xlsx（zip）并读出工作表中的单元格，核对 src/xlsx/writer.ts 的输出。只认 writer 写出的结构
// （deflate、内联字符串、数字），不是通用的 xlsx 解析器。
import { crc32, inflateRawSync } from 'node:zlib';

export function unzip(buffer: Buffer): Map<string, Buffer> {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('没有 zip 结束记录');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录记录不合法');
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地文件头不合法');
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== size || crc32(data) !== checksum) throw new Error(`${name} 的大小或校验和不符`);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function unescapeXml(value: string): string {
  return value.replace(/&(lt|gt|quot|amp|#\d+);/g, (_match, entity: string) =>
    entity.startsWith('#') ? String.fromCodePoint(Number(entity.slice(1))) : ({ lt: '<', gt: '>', quot: '"', amp: '&' })[entity]!,
  );
}

export interface ReadCell {
  value: string | number;
  /** 样式序号（1 是百分比）。 */
  style: number;
}

export interface ReadSheet {
  name: string;
  /** 按单元格引用（A1）取值。 */
  cells: Map<string, ReadCell>;
  /** 按行读出的值，空单元格为 undefined。 */
  rows: (string | number | undefined)[][];
  autoFilter: string | null;
  xml: string;
}

function columnIndex(letters: string): number {
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

export function readWorkbook(buffer: Buffer): { sheets: ReadSheet[]; files: Map<string, Buffer> } {
  const files = unzip(buffer);
  const workbook = files.get('xl/workbook.xml')!.toString('utf8');
  const names = [...workbook.matchAll(/<sheet name="([^"]*)" sheetId="(\d+)"/g)].map((match) => unescapeXml(match[1]!));
  const sheets = names.map((name, index) => {
    const xml = files.get(`xl/worksheets/sheet${index + 1}.xml`)!.toString('utf8');
    const cells = new Map<string, ReadCell>();
    const rows: (string | number | undefined)[][] = [];
    for (const match of xml.matchAll(/<c r="([A-Z]+)(\d+)"(?: s="(\d+)")?(?: t="inlineStr")?>(?:<v>([^<]*)<\/v>|<is><t xml:space="preserve">([^<]*)<\/t><\/is>)<\/c>/g)) {
      const [, column, row, style, number, text] = match;
      const value = number !== undefined ? Number(number) : unescapeXml(text!);
      cells.set(`${column}${row}`, { value, style: Number(style ?? 0) });
      const rowIndex = Number(row) - 1;
      (rows[rowIndex] ??= [])[columnIndex(column!)] = value;
    }
    for (let index = 0; index < rows.length; index += 1) rows[index] ??= [];
    const filter = /<autoFilter ref="([^"]+)"\/>/.exec(xml);
    return { name, cells, rows, autoFilter: filter ? filter[1]! : null, xml };
  });
  return { sheets, files };
}
