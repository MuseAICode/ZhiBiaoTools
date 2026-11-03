// 标书查重文档格式元数据（6.10b）的测试样本：docx（含 core / app / custom 属性与 rsid）、OLE 属性集与模拟的 CFB 容器、
// PDF 原始字节与模拟的 pdf-parse getInfo 结果。单元测试中的期望值是把同样的输入交给桌面版
// client/electron/services/duplicateCheckService.cjs 的同名函数得到的结果（CFB 与 pdf-parse 换成这里的模拟对象）。
import { buildZip } from '../sandbox/zipFixtures.ts';

// ---- docx ----

const CORE_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" '
  + 'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
  + '<dc:title>投标文件 &amp; 技术部分</dc:title><dc:subject>某某项目</dc:subject><dc:creator>张三</dc:creator><cp:keywords>投标,技术</cp:keywords>'
  + '<dc:description>描述 user@example.com</dc:description><cp:lastModifiedBy>李四 (WPS Office)</cp:lastModifiedBy><cp:revision>7</cp:revision>'
  + '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-02-03T04:05:06Z</dcterms:modified>'
  + '<cp:category><![CDATA[标书]]></cp:category></cp:coreProperties>';

const APP_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Template>Normal.dotm</Template><TotalTime>125</TotalTime>'
  + '<Pages>3</Pages><Words>1200</Words><Characters>3000</Characters><Application>WPS Office_11.1.0.12313</Application><Lines>40</Lines>'
  + '<Paragraphs>12</Paragraphs><Company>某某科技有限公司</Company><Manager>王五</Manager><AppVersion>16.0000</AppVersion></Properties>';

const CUSTOM_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
  + '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="KSOProductBuildVer"><vt:lpwstr>2052-11.1.0.12313</vt:lpwstr></property>'
  + '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="ICV"><vt:lpwstr>eyJ1aWQiOiIxMjM0NTYiLCJuYW1lIjoi5byg5LiJIn0=</vt:lpwstr></property>'
  + '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="4" name="Hash"><vt:lpwstr>0123456789abcdef0123456789abcdef</vt:lpwstr></property>'
  + '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="5" name="A&amp;B"><vt:i4>42</vt:i4></property></Properties>';

const DOCUMENT_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
  + '<w:p w:rsidR="00ABCDEF" w:rsidRDefault="00d4e5f6"><w:r><w:t>投标正文</w:t></w:r></w:p>'
  + '<w:p w:rsidR="00A1B2C3" w:rsidP="0012ab34"><w:r w:rsidRPr="00A1B2C3"><w:t>第二段</w:t></w:r></w:p></w:body></w:document>';

const SETTINGS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:rsids><w:rsidRoot w:val="00F1F2F3"/><w:rsid w:val="00A1B2C3"/></w:rsids></w:settings>';

/** 带全部三类属性与 rsid 的 docx（只有读取元数据用到的部件）。 */
export function buildMetadataDocx(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'docProps/core.xml', data: Buffer.from(CORE_XML) },
    { name: 'docProps/app.xml', data: Buffer.from(APP_XML) },
    { name: 'docProps/custom.xml', data: Buffer.from(CUSTOM_XML) },
    { name: 'word/document.xml', data: Buffer.from(DOCUMENT_XML) },
    { name: 'word/settings.xml', data: Buffer.from(SETTINGS_XML), method: 0 },
    { name: 'word/media/image1.png', data: Buffer.from('rsidR="00999999"') },
  ]);
}

// ---- OLE 属性集 ----

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function pad4(buffer: Buffer): Buffer {
  const rest = (4 - (buffer.length % 4)) % 4;
  return rest ? Buffer.concat([buffer, Buffer.alloc(rest)]) : buffer;
}

/** TypedPropertyValue：类型（2 字节）+ 填充（2 字节）+ 值，按 4 字节对齐。 */
function typed(type: number, data: Buffer): Buffer {
  return pad4(Buffer.concat([u16(type), u16(0), data]));
}

export const prop = {
  i2: (value: number) => {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16LE(value);
    return typed(0x02, buffer);
  },
  i4: (value: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32LE(value);
    return typed(0x03, buffer);
  },
  bool: (value: boolean) => typed(0x0b, u32(value ? 0xffff : 0)),
  /** 代码页编码的字节（含结尾的 0）。 */
  lpstr: (bytes: Buffer) => typed(0x1e, Buffer.concat([u32(bytes.length + 1), bytes, Buffer.alloc(1)])),
  lpwstr: (value: string) => typed(0x1f, Buffer.concat([u32(value.length + 1), Buffer.from(`${value}\u0000`, 'utf16le')])),
  filetime: (date: Date) => {
    const ticks = (BigInt(date.getTime()) + 11644473600000n) * 10000n;
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(ticks);
    return typed(0x40, buffer);
  },
  /** 时长（FILETIME 的 100 纳秒数）。 */
  duration: (seconds: number) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(seconds) * 10000000n);
    return typed(0x40, buffer);
  },
  blob: (size: number) => typed(0x41, Buffer.concat([u32(size), Buffer.alloc(size)])),
  vectorLpstr: (items: Buffer[]) => typed(0x101e, Buffer.concat([u32(items.length), ...items.map((bytes) => Buffer.concat([u32(bytes.length), bytes]))])),
  vectorVariant: (items: Buffer[]) => typed(0x100c, Buffer.concat([u32(items.length), ...items])),
};

/** 属性集中的字典（属性编号 0）：自定义属性名，按代码页编码，各项按 4 字节对齐。 */
export function dictionary(entries: readonly { id: number; name: Buffer }[]): Buffer {
  return Buffer.concat([u32(entries.length), ...entries.map(({ id, name }) => pad4(Buffer.concat([u32(id), u32(name.length + 1), name, Buffer.alloc(1)])))]);
}

/** 一个属性集：大小、属性数、（编号, 偏移）表、各属性的值。 */
function propertySet(properties: readonly { id: number; value: Buffer }[]): Buffer {
  const headerSize = 8 + properties.length * 8;
  let offset = headerSize;
  const table: Buffer[] = [];
  for (const { id, value } of properties) {
    table.push(u32(id), u32(offset));
    offset += value.length;
  }
  return Buffer.concat([u32(offset), u32(properties.length), ...table, ...properties.map((item) => item.value)]);
}

/** 属性集 Stream：头部（字节序、版本、CLSID、属性集数）、（FMTID, 偏移）表、各属性集。 */
export function propertySetStream(sets: readonly (readonly { id: number; value: Buffer }[])[]): Buffer {
  const headerSize = 28 + sets.length * 20;
  const bodies = sets.map((set) => propertySet(set));
  let offset = headerSize;
  const table: Buffer[] = [];
  for (const body of bodies) {
    table.push(Buffer.alloc(16, 0x11), u32(offset));
    offset += body.length;
  }
  return Buffer.concat([u16(0xfffe), u16(0), u32(0x00020006), Buffer.alloc(16), u32(sets.length), ...table, ...bodies]);
}

const GBK = {
  title: Buffer.from('cdb6b1eacec4bcfe', 'hex'), // 投标文件
  author: Buffer.from('d5c5c8fd', 'hex'), // 张三
  company: Buffer.from('c4b3c4b3bfc6bcbcd3d0cfdeb9abcbbe', 'hex'), // 某某科技有限公司
  accountName: Buffer.from('bdf0c9bdd5cbbac5', 'hex'), // 金山账号
  manager: Buffer.from('cdf5cee5', 'hex'), // 王五
  part: Buffer.from('bcbccaf5b1ea', 'hex'), // 技术标
};

/** SummaryInformation：代码页 936（GBK）的标题、作者，UTF-16 的最后修改人，时间、时长、页数等。 */
export function summaryInformation(): Buffer {
  return propertySetStream([[
    { id: 0x01, value: prop.i2(936) },
    { id: 0x02, value: prop.lpstr(GBK.title) },
    { id: 0x04, value: prop.lpstr(GBK.author) },
    { id: 0x08, value: prop.lpwstr('李四') },
    { id: 0x09, value: prop.lpstr(Buffer.from('12')) },
    { id: 0x0a, value: prop.duration(7_500) },
    { id: 0x0c, value: prop.filetime(new Date('2026-01-02T03:04:05Z')) },
    { id: 0x0d, value: prop.filetime(new Date('2026-02-03T04:05:06Z')) },
    { id: 0x0e, value: prop.i4(3) },
    { id: 0x12, value: prop.lpstr(Buffer.from('WPS Office')) },
    { id: 0x13, value: prop.i4(0) },
    { id: 0x20, value: prop.blob(5) },
  ]]);
}

/** DocumentSummaryInformation：第一个属性集是标准属性，第二个是带字典的自定义属性。 */
export function documentSummaryInformation(): Buffer {
  return propertySetStream([
    [
      { id: 0x01, value: prop.i2(936) },
      { id: 0x0c, value: prop.vectorVariant([prop.lpstr(GBK.part), prop.i4(1)]) },
      { id: 0x0d, value: prop.vectorLpstr([GBK.part, Buffer.from('Cover')]) },
      { id: 0x0e, value: prop.lpstr(GBK.manager) },
      { id: 0x0f, value: prop.lpstr(GBK.company) },
      { id: 0x10, value: prop.bool(false) },
      { id: 0x11, value: prop.i4(3600) },
      { id: 0x17, value: prop.i4(0x000b0000 + 12313) },
    ],
    [
      { id: 0x00, value: dictionary([{ id: 2, name: Buffer.from('KSOProductBuildVer') }, { id: 3, name: GBK.accountName }]) },
      { id: 0x01, value: prop.i2(936) },
      { id: 2, value: prop.lpstr(Buffer.from('2052-11.1.0.12313')) },
      { id: 3, value: prop.lpstr(Buffer.from('user@example.com')) },
      { id: 4, value: prop.i4(99) },
    ],
  ]);
}

export interface FakeCfbEntry {
  name: string;
  type: number;
  size: number;
  content: Buffer | null;
}

/** 模拟 CFB.read 的结果：根存储、属性集 Stream、正文 Stream（含疑似账号痕迹）、宏存储。 */
export function buildFakeCfb(): { FileIndex: FakeCfbEntry[]; FullPaths: string[] } {
  const wordDocument = Buffer.concat([Buffer.alloc(64, 0x01), Buffer.from('Created by Kingsoft WPS Office, account user@example.com', 'utf16le'), Buffer.alloc(32)]);
  const entries: [string, FakeCfbEntry][] = [
    ['Root Entry/', { name: 'Root Entry', type: 5, size: 0, content: null }],
    ['Root Entry/\u0005SummaryInformation', { name: '\u0005SummaryInformation', type: 2, size: 0, content: summaryInformation() }],
    ['Root Entry/\u0005DocumentSummaryInformation', { name: '\u0005DocumentSummaryInformation', type: 2, size: 0, content: documentSummaryInformation() }],
    ['Root Entry/WordDocument', { name: 'WordDocument', type: 2, size: 0, content: wordDocument }],
    ['Root Entry/Macros/', { name: 'Macros', type: 1, size: 0, content: null }],
    ['Root Entry/Macros/VBA/', { name: 'VBA', type: 1, size: 0, content: null }],
    ['Root Entry/Macros/VBA/dir', { name: 'dir', type: 2, size: 0, content: Buffer.from('attribute') }],
  ];
  for (const [, entry] of entries) entry.size = entry.content?.length ?? 0;
  return { FullPaths: entries.map(([path]) => path), FileIndex: entries.map(([, entry]) => entry) };
}

/** 模拟 CFB.find：与 cfb 1.2.2 相同按完整路径或文件名查找（不区分大小写）。 */
export function fakeCfbFind(cfb: { FileIndex: FakeCfbEntry[]; FullPaths: string[] }, path: string): FakeCfbEntry | null {
  const wanted = path.replace(/^\//, '').toLowerCase();
  const index = cfb.FullPaths.findIndex((full) => {
    const lower = full.toLowerCase().replace(/\/$/, '');
    return lower === wanted || lower === `root entry/${wanted}` || lower.split('/').at(-1) === wanted;
  });
  return index >= 0 ? cfb.FileIndex[index]! : null;
}

// ---- PDF ----

/** 带 Info、原始记录、两次增量保存、签名、表单与附件的 PDF 片段（只用于按字节扫描，不是可打开的 PDF）。 */
export function buildMetadataPdf(): Buffer {
  return Buffer.from([
    '%PDF-1.7',
    '%\xe2\xe3\xcf\xd3',
    '1 0 obj << /Type /Catalog /AcroForm << /Fields [5 0 R] /XFA 9 0 R >> >> endobj',
    '2 0 obj << /Title (\\376\\377\\000A\\000B) /Author <FEFF5F204E09> /Producer (Writer\\051 \\(x\\)) /CreationDate (D:20260102030405+08\'00\') >> endobj',
    '3 0 obj << /Type /Filespec /F (old.txt) /UF <FEFF9644004E0054002E0074007800740020> >> endobj',
    '4 0 obj << /Type /EmbeddedFile /Length 3 >> endobj',
    '5 0 obj << /FT /Sig /V 6 0 R >> endobj',
    '6 0 obj << /Type /Sig /ByteRange [0 10 20 30] /Name (WPS account user@example.com) >> endobj',
    'xref',
    '0 7',
    'trailer << /ID [<0318C26E7772BD5B2D4750E43289508B> <aa bb cc dd>] >>',
    'startxref',
    '100',
    '%%EOF',
    '7 0 obj << /Type /XRef /Title (Second Title) >> endobj',
    'startxref',
    '200',
    '%%EOF',
  ].join('\n'), 'latin1');
}

/** 模拟 pdfjs 的 Metadata（XMP）：get、getRaw 与迭代。 */
class FakeXmp {
  readonly #entries: [string, string][];
  readonly #raw: string;

  constructor(entries: [string, string][], raw: string) {
    this.#entries = entries;
    this.#raw = raw;
  }

  get(name: string): string | null {
    return this.#entries.find(([key]) => key === name)?.[1] ?? null;
  }

  getRaw(): string {
    return this.#raw;
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.#entries[Symbol.iterator]();
  }
}

/** 模拟 pdf-parse getInfo 的结果。 */
export function buildPdfInfo(): Record<string, unknown> {
  return {
    total: 12,
    version: '1.7',
    fingerprints: ['0318c26e7772bd5b2d4750e43289508b', null],
    permission: null,
    info: {
      PDFFormatVersion: '1.7',
      Language: 'zh-CN',
      IsLinearized: false,
      Title: '投标文件',
      Creator: 'WPS 文字',
      Producer: '',
      CreationDate: "D:20260102030405+08'00'",
      Custom: { SourceModified: 'D:20260101' },
    },
    metadata: new FakeXmp([
      ['dc:title', 'XMP 标题'],
      ['dc:creator', '张三'],
      ['xmp:creatortool', 'WPS 文字'],
      ['xmp:modifydate', '2026-02-03T04:05:06+08:00'],
      ['pdf:keywords', ''],
    ], '<x:xmpmeta><kso:account>user@example.com</kso:account></x:xmpmeta>'),
  };
}
