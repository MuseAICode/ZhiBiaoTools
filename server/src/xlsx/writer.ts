// 最小的 xlsx（Office Open XML 工作簿）写出器：只支持导出检查结果用到的内容——多个工作表、文本和数字单元格、
// 百分比格式、列宽、表头筛选、文档标题和创建时间。不引入第三方依赖（桌面版用 SheetJS，npm 上的版本有未修复的漏洞，
// 新版只在 SheetJS 自己的 CDN 发布）。
//
// 防公式注入：文本一律写成内联字符串（inlineStr），从不写 <f>，打开文件时不会被当作公式求值；以 = + - @、制表符、
// 回车开头的文本另外套用 quotePrefix 样式（相当于在 Excel 中输入前导单引号），用户双击编辑后回车也仍是文本。
// 控制字符和 XML 不接受的字符由 normalizeCellText 去掉，其余做 XML 转义（回车写成 &#13;，否则会被 XML 解析器
// 规范化为换行）。zip 容器用 Node 自带的 zlib（deflate、crc32）写出。
import { crc32, deflateRawSync } from 'node:zlib';

/** Excel 单元格文本的长度上限（与桌面版相同，超出时截断并加提示）。 */
export const EXCEL_TEXT_LIMIT = 32767;
const EXCEL_TEXT_PREFIX_LIMIT = 32750;
const EXCEL_TEXT_TRUNCATION_SUFFIX = '……（内容过长，已截断）';

/** 百分比格式的数字单元格（0.00%）。 */
export interface PercentCell {
  percent: number;
}

export type CellValue = string | number | null | undefined | PercentCell;

export interface WorksheetSpec {
  /** 工作表名称：1~31 个字符，不含 [ ] : * ? / \。 */
  name: string;
  rows: CellValue[][];
  /** 每列的宽度（字符数）。 */
  columnWidths: number[];
  /** 给出时在这一行（从 0 开始）加表头筛选，范围到最后一行。 */
  filterHeaderRow?: number;
}

export interface WorkbookSpec {
  title: string;
  createdAt: Date;
  sheets: WorksheetSpec[];
}

/** 去掉 XML 1.0 不接受的控制字符和非字符，超长时截断（与桌面版 checkResultExportService 相同）。 */
export function normalizeCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  const normalized = String(value)
    .toWellFormed()
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
  if (normalized.length <= EXCEL_TEXT_LIMIT) return normalized;
  return `${normalized.slice(0, EXCEL_TEXT_PREFIX_LIMIT)}${EXCEL_TEXT_TRUNCATION_SUFFIX}`;
}

const XML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\r': '&#13;' };

function escapeXml(value: string): string {
  return value.replace(/[&<>"\r]/g, (char) => XML_ESCAPES[char]!);
}

/** Excel 会当作公式开头的字符（OWASP CSV Injection 列出的 = + - @ 和制表符、回车）。 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** 文本单元格是否需要 quotePrefix（样式 2）。 */
export function needsQuotePrefix(text: string): boolean {
  return FORMULA_PREFIX.test(text);
}

/** 列号（从 0 开始）转为 A、B、…、AA。 */
export function columnName(index: number): string {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

function cellXml(ref: string, value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    return Number.isFinite(value.percent) ? `<c r="${ref}" s="1"><v>${value.percent}</v></c>` : '';
  }
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : '';
  const text = normalizeCellText(value);
  if (text === '') return '';
  const style = needsQuotePrefix(text) ? ' s="2"' : '';
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function lastColumn(sheet: WorksheetSpec): number {
  // 不用 Math.max(...rows)：行数上万时展开参数会超出调用栈。
  let columns = Math.max(1, sheet.columnWidths.length);
  for (const row of sheet.rows) columns = Math.max(columns, row.length);
  return columns - 1;
}

function filterRange(sheet: WorksheetSpec): string | null {
  if (sheet.filterHeaderRow === undefined) return null;
  const header = sheet.rows[sheet.filterHeaderRow] ?? [];
  const lastRow = Math.max(sheet.filterHeaderRow, sheet.rows.length - 1);
  return `${columnName(0)}${sheet.filterHeaderRow + 1}:${columnName(Math.max(0, header.length - 1))}${lastRow + 1}`;
}

function worksheetXml(sheet: WorksheetSpec): string {
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const cells = row.map((value, columnIndex) => cellXml(`${columnName(columnIndex)}${rowIndex + 1}`, value)).join('');
      return cells ? `<row r="${rowIndex + 1}">${cells}</row>` : '';
    })
    .join('');
  const cols = sheet.columnWidths.length
    ? `<cols>${sheet.columnWidths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const dimension = `A1:${columnName(lastColumn(sheet))}${Math.max(1, sheet.rows.length)}`;
  const range = filterRange(sheet);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="${dimension}"/>${cols}<sheetData>${rows}</sheetData>` +
    (range ? `<autoFilter ref="${range}"/>` : '') +
    '</worksheet>'
  );
}

function absoluteRange(range: string): string {
  return range.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
}

function workbookXml(sheets: WorksheetSpec[]): string {
  const entries = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`);
  // 表头筛选需要隐藏的 _xlnm._FilterDatabase 名称，Excel 才能正常使用筛选。
  const names = sheets
    .map((sheet, index) => {
      const range = filterRange(sheet);
      if (!range) return '';
      const quoted = `'${sheet.name.replaceAll("'", "''")}'`;
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${index}" hidden="1">${escapeXml(`${quoted}!${absoluteRange(range)}`)}</definedName>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${entries.join('')}</sheets>` +
    (names ? `<definedNames>${names}</definedNames>` : '') +
    '</workbook>'
  );
}

function workbookRelsXml(sheets: WorksheetSpec[]): string {
  const relationships = sheets.map(
    (_sheet, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  );
  relationships.push(
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  );
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`
  );
}

function contentTypesXml(sheets: WorksheetSpec[]): string {
  const overrides = sheets.map(
    (_sheet, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  );
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    overrides.join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>'
  );
}

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '</Relationships>';

// 样式 0 是默认格式，样式 1 是内置格式 10（0.00%），样式 2 是带 quotePrefix 的文本（防公式注入）。
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

function coreXml(spec: WorkbookSpec): string {
  const created = spec.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(normalizeCellText(spec.title))}</dc:title>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
    '</cp:coreProperties>'
  );
}

const SHEET_NAME = /^[^[\]:*?/\\]{1,31}$/u;

// ---- zip 容器 ----

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** DOS 格式的日期和时间（zip 头中的修改时间）。 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

const ZIP32_MAX = 0xffff_ffff;

function zip(entries: ZipEntry[], modifiedAt: Date): Buffer {
  const { time, date } = dosDateTime(modifiedAt);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    if (entry.data.length > ZIP32_MAX || offset + compressed.length > ZIP32_MAX) throw new RangeError('工作簿过大');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** 生成 xlsx 文件内容。 */
export function writeWorkbook(spec: WorkbookSpec): Buffer {
  if (spec.sheets.length === 0) throw new TypeError('工作簿至少要有一个工作表');
  const names = new Set<string>();
  for (const sheet of spec.sheets) {
    if (!SHEET_NAME.test(sheet.name) || names.has(sheet.name)) throw new TypeError(`工作表名称不合法：${sheet.name}`);
    names.add(sheet.name);
  }
  const utf8 = (value: string) => Buffer.from(value, 'utf8');
  return zip(
    [
      { name: '[Content_Types].xml', data: utf8(contentTypesXml(spec.sheets)) },
      { name: '_rels/.rels', data: utf8(ROOT_RELS) },
      { name: 'docProps/core.xml', data: utf8(coreXml(spec)) },
      { name: 'xl/workbook.xml', data: utf8(workbookXml(spec.sheets)) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRelsXml(spec.sheets)) },
      { name: 'xl/styles.xml', data: utf8(STYLES) },
      ...spec.sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: utf8(worksheetXml(sheet)) })),
    ],
    spec.createdAt,
  );
}
