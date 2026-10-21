// xlsx 写出器（src/xlsx/writer.ts）的单元测试：zip 结构与校验和、工作表内容、转义、截断、百分比格式、表头筛选。
import { describe, expect, it } from 'vitest';
import { columnName, EXCEL_TEXT_LIMIT, needsQuotePrefix, normalizeCellText, writeWorkbook } from '../../src/xlsx/writer.ts';
import { readWorkbook } from './readXlsx.ts';

const createdAt = new Date('2026-10-20T08:09:10.123Z');

describe('xlsx 写出器', () => {
  it('写出完整的包结构，每个部件的大小和 CRC 都正确', () => {
    const { files } = readWorkbook(writeWorkbook({ title: '标题', createdAt, sheets: [{ name: '表一', rows: [['a']], columnWidths: [10] }] }));
    expect([...files.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const core = files.get('docProps/core.xml')!.toString('utf8');
    expect(core).toContain('<dc:title>标题</dc:title>');
    expect(core).toContain('<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-20T08:09:10Z</dcterms:created>');
    expect(files.get('[Content_Types].xml')!.toString('utf8')).toContain('/xl/worksheets/sheet1.xml');
  });

  it('文本写成内联字符串，数字写成数值，空值不写；XML 特殊字符转义，以等号开头的文本不是公式', () => {
    const { sheets } = readWorkbook(
      writeWorkbook({
        title: 't',
        createdAt,
        sheets: [{ name: 'S', rows: [['<a href="x">&</a>', 12.5, null, undefined, ''], [], ['=SUM(A1:A2)', Number.NaN, 0]], columnWidths: [] }],
      }),
    );
    const sheet = sheets[0]!;
    expect(sheet.cells.get('A1')).toEqual({ value: '<a href="x">&</a>', style: 0 });
    expect(sheet.cells.get('B1')).toEqual({ value: 12.5, style: 0 });
    expect(sheet.cells.has('C1')).toBe(false);
    expect(sheet.cells.has('E1')).toBe(false);
    expect(sheet.xml).not.toContain('<row r="2"');
    expect(sheet.cells.get('A3')).toEqual({ value: '=SUM(A1:A2)', style: 2 });
    expect(sheet.xml).not.toContain('<f>');
    expect(sheet.cells.has('B3')).toBe(false);
    expect(sheet.cells.get('C3')).toEqual({ value: 0, style: 0 });
  });

  it('防公式注入：以 = + - @、制表符、回车开头的文本是带 quotePrefix 的内联字符串，从不写公式', () => {
    const dangerous = ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1+1', '\r=1+1', '=cmd|\' /C calc\'!A0'];
    const safe = ['正常文本', ' =1', '1=1', 'a@b.com', '－1', '＝1', '\n=1'];
    const buffer = writeWorkbook({ title: 't', createdAt, sheets: [{ name: 'S', rows: [dangerous, safe], columnWidths: [] }] });
    const { sheets, files } = readWorkbook(buffer);
    const sheet = sheets[0]!;
    dangerous.forEach((text, index) => {
      const ref = `${columnName(index)}1`;
      expect(sheet.cells.get(ref), ref).toEqual({ value: text, style: 2 });
      expect(sheet.xml).toMatch(new RegExp(`<c r="${ref}" s="2" t="inlineStr">`));
    });
    safe.forEach((text, index) => {
      const ref = `${columnName(index)}2`;
      expect(sheet.cells.get(ref), ref).toEqual({ value: text, style: 0 });
    });
    expect(sheet.xml).not.toMatch(/<f[ >]/);
    expect(sheet.xml).not.toContain('t="str"');
    expect(files.get('xl/styles.xml')!.toString('utf8')).toContain('<cellXfs count="3">');
    expect(files.get('xl/styles.xml')!.toString('utf8')).toContain('quotePrefix="1"');
    expect([...dangerous].every(needsQuotePrefix)).toBe(true);
    expect(safe.some(needsQuotePrefix)).toBe(false);
  });

  it('XML 特殊字符转义，回车写成 &#13;（保留原样），制表符和换行原样保留，控制字符去掉', () => {
    const text = 'a&b<c>d"e\'f]]>g\rh\ti\nj\u0001k\u001Fl\u007Fm';
    const { sheets } = readWorkbook(writeWorkbook({ title: 't', createdAt, sheets: [{ name: 'S', rows: [[text]], columnWidths: [] }] }));
    const sheet = sheets[0]!;
    expect(sheet.xml).toContain('a&amp;b&lt;c&gt;d&quot;e\'f]]&gt;g&#13;h\ti\nj');
    expect(sheet.xml).not.toContain('\r');
    expect(sheet.xml).not.toMatch(/[\u0001\u001F]/);
    // XML 1.0 允许 DEL（U+007F），与桌面版相同不去掉。
    expect(sheet.cells.get('A1')!.value).toBe('a&b<c>d"e\'f]]>g\rh\ti\njkl\u007Fm');
  });

  it('不成对的代理项替换为 U+FFFD，工作表名称和标题中的特殊字符同样转义', () => {
    const { sheets, files } = readWorkbook(
      writeWorkbook({ title: '<标题&>', createdAt, sheets: [{ name: 'A&B<"', rows: [['x\uD800y']], columnWidths: [], filterHeaderRow: 0 }] }),
    );
    expect(sheets[0]!.name).toBe('A&B<"');
    expect(sheets[0]!.cells.get('A1')!.value).toBe('x\uFFFDy');
    expect(files.get('xl/workbook.xml')!.toString('utf8')).toContain('<sheet name="A&amp;B&lt;&quot;"');
    expect(files.get('docProps/core.xml')!.toString('utf8')).toContain('<dc:title>&lt;标题&amp;&gt;</dc:title>');
  });

  it('百分比单元格使用样式 1（0.00%）', () => {
    const buffer = writeWorkbook({ title: 't', createdAt, sheets: [{ name: 'S', rows: [[{ percent: 0.256 }]], columnWidths: [] }] });
    const { sheets, files } = readWorkbook(buffer);
    expect(sheets[0]!.cells.get('A1')).toEqual({ value: 0.256, style: 1 });
    expect(files.get('xl/styles.xml')!.toString('utf8')).toContain('<xf numFmtId="10"');
  });

  it('列宽、维度和表头筛选（含隐藏的 _FilterDatabase 名称）', () => {
    const { sheets, files } = readWorkbook(
      writeWorkbook({
        title: 't',
        createdAt,
        sheets: [
          { name: "O'Brien 表", rows: [['h1', 'h2', 'h3'], ['a'], ['b']], columnWidths: [8, 30], filterHeaderRow: 0 },
          { name: '无筛选', rows: [], columnWidths: [] },
        ],
      }),
    );
    expect(sheets.map((sheet) => sheet.name)).toEqual(["O'Brien 表", '无筛选']);
    expect(sheets[0]!.autoFilter).toBe('A1:C3');
    expect(sheets[0]!.xml).toContain('<dimension ref="A1:C3"/>');
    expect(sheets[0]!.xml).toContain('<col min="2" max="2" width="30" customWidth="1"/>');
    expect(sheets[1]!.autoFilter).toBeNull();
    expect(files.get('xl/workbook.xml')!.toString('utf8')).toContain(
      `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'O''Brien 表'!$A$1:$C$3</definedName>`,
    );
  });

  it('去掉控制字符和非字符，超长文本截断并加提示（与桌面版相同）', () => {
    expect(normalizeCellText('a\u0000b\u0007c\td\ne￿')).toBe('abc\td\ne');
    expect(normalizeCellText(null)).toBe('');
    const long = normalizeCellText('字'.repeat(EXCEL_TEXT_LIMIT + 10));
    expect(long.length).toBeLessThanOrEqual(EXCEL_TEXT_LIMIT);
    expect(long.endsWith('……（内容过长，已截断）')).toBe(true);
    const { sheets } = readWorkbook(writeWorkbook({ title: 't', createdAt, sheets: [{ name: 'S', rows: [['x'.repeat(40_000)]], columnWidths: [] }] }));
    expect(String(sheets[0]!.cells.get('A1')!.value).length).toBeLessThanOrEqual(EXCEL_TEXT_LIMIT);
  });

  it('列名与工作表名称校验', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    for (const name of ['', 'a/b', 'a[1]', 'x'.repeat(32)]) {
      expect(() => writeWorkbook({ title: 't', createdAt, sheets: [{ name, rows: [], columnWidths: [] }] })).toThrow(TypeError);
    }
    expect(() =>
      writeWorkbook({
        title: 't',
        createdAt,
        sheets: [
          { name: 'S', rows: [], columnWidths: [] },
          { name: 'S', rows: [], columnWidths: [] },
        ],
      }),
    ).toThrow(TypeError);
    expect(() => writeWorkbook({ title: 't', createdAt, sheets: [] })).toThrow(TypeError);
  });

  it('上万行时不会因展开参数耗尽调用栈', () => {
    const rows = Array.from({ length: 200_000 }, (_value, index) => [index]);
    const { sheets } = readWorkbook(writeWorkbook({ title: 't', createdAt, sheets: [{ name: 'S', rows, columnWidths: [] }] }));
    expect(sheets[0]!.cells.get('A200000')).toEqual({ value: 199_999, style: 0 });
  });
});
