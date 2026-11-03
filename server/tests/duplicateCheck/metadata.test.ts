// 标书查重的文档格式元数据（路线图第 6 步 6.10b）：沙箱中的提取（server/sandbox/parse/duplicateMetadata.mjs，只用内置模块，
// CFB 与 pdf-parse 用模拟对象）与 worker 对 metadata.json 的校验（src/duplicateCheck/analysis.ts）。
// metadataExpected.json 是同样的输入交给桌面版 duplicateCheckService.cjs 的 extractDocxMetadata / extractOleMetadata /
// extractPdfMetadata 得到的结果（CFB.read / CFB.find 与 PDFParse 换成 metadataFixtures.ts 中的模拟对象）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_METADATA_LIMITS,
  DuplicateAnalysisError,
  FORMAT_METADATA_KEYS,
  basicMetadataFields,
  isDocumentMetadataKey,
  mergeDocumentMetadata,
  metadataItems,
  parseDocumentMetadata,
} from '../../src/duplicateCheck/analysis.ts';
import { PARSE_FORMATS, supportsDocumentMetadata } from '../../src/parse/dispatch.ts';
import {
  extractDocumentMetadata,
  extractDocxMetadata,
  extractOleMetadata,
  extractPdfMetadata,
  finalizeMetadataFields,
  FORMAT_METADATA_KEYS as SANDBOX_FORMAT_METADATA_KEYS,
  isDocumentMetadataKey as sandboxIsDocumentMetadataKey,
  METADATA_FORMATS,
  METADATA_LIMITS,
  PROPERTY_SET_KEYS,
  type CfbApi,
} from '../../sandbox/parse/duplicateMetadata.mjs';
import { buildZip } from '../sandbox/zipFixtures.ts';
import { buildFakeCfb, buildMetadataDocx, buildMetadataPdf, buildPdfInfo, fakeCfbFind } from './metadataFixtures.ts';

const expected = JSON.parse(readFileSync(new URL('./metadataExpected.json', import.meta.url), 'utf8')) as Record<'docx' | 'ole' | 'pdf', [string, string][]>;

const fakeCfb: CfbApi = { read: () => buildFakeCfb() as never, find: fakeCfbFind as never };
const failingCfb: CfbApi = {
  read: () => {
    throw new Error('CFB header signature mismatch');
  },
  find: () => null,
};
const readPdfInfo = async () => buildPdfInfo();
const noDocx = async (): Promise<Buffer> => {
  throw new Error('LibreOffice failed');
};

function output(fields: unknown, version: unknown = 1): Buffer {
  return Buffer.from(JSON.stringify({ version, fields }), 'utf8');
}

describe('沙箱中的元数据提取（与桌面版相同）', () => {
  it('docx：core / app / custom 属性、rsid、疑似 WPS 账号', async () => {
    expect(Array.from((await extractDocxMetadata(buildMetadataDocx())).entries())).toEqual(expected.docx);
  });

  it('OLE：两个属性集（代码页 936、字典中的自定义属性）、存储结构、宏存储、正文中的疑似账号痕迹', () => {
    expect(Array.from(extractOleMetadata(Buffer.alloc(0), fakeCfb).entries())).toEqual(expected.ole);
  });

  it('PDF：Info、XMP、原始记录、结构、表单 / 签名 / 附件', async () => {
    expect(Array.from((await extractPdfMetadata(buildMetadataPdf(), readPdfInfo)).entries())).toEqual(expected.pdf);
  });

  it('docx 经 extractDocumentMetadata 输出（整理后不变）', async () => {
    const result = await extractDocumentMetadata({ format: 'docx', buffer: buildMetadataDocx(), cfb: failingCfb, readPdfInfo, toDocx: noDocx });
    expect(result).toEqual({ version: 1, fields: expected.docx });
  });

  it('老式 Word：OLE 属性 + 转成 docx 后的属性（只填补没有的字段，另以 converted_docx: 前缀全部保留），再找一次疑似账号', async () => {
    let converted: string | null = null;
    const result = await extractDocumentMetadata({
      format: 'word-ole',
      buffer: Buffer.alloc(0),
      cfb: fakeCfb,
      readPdfInfo,
      toDocx: async (format) => {
        converted = format;
        return buildMetadataDocx();
      },
    });
    expect(converted).toBe('word-ole');
    const fields = new Map(result.fields);
    // OLE 中已有的字段不被覆盖，没有的由 docx 填补。
    expect(fields.get('title')).toBe('投标文件');
    expect(fields.get('subject')).toBe('某某项目');
    expect(fields.get('converted_docx:title')).toBe('投标文件 & 技术部分');
    expect(fields.get('converted_docx:wps:last_modified_by')).toBe('李四 (WPS Office)');
    expect(fields.get('wps:converted_docx_wps_last_modified_by')).toBe('李四 (WPS Office)');
    expect(fields.has('metadata_error')).toBe(false);
    // 顺序：OLE 的字段在前（与桌面版 mergeMetadataFields 相同；合并时值再规范化一次，列表值中的“；”变为“;”，桌面版同样如此）。
    expect(result.fields.slice(0, expected.ole.length).map(([key]) => key)).toEqual(expected.ole.map(([key]) => key));
    expect(fields.get('ole_signal:root_entry_worddocument')).toBe(expected.ole.find(([key]) => key === 'ole_signal:root_entry_worddocument')![1].replaceAll('；', ';'));
  });

  it('老式 Word 两部分都读取失败：metadata_error 为固定文字，不带解析库的错误消息', async () => {
    const result = await extractDocumentMetadata({ format: 'word-ole', buffer: Buffer.alloc(0), cfb: failingCfb, readPdfInfo, toDocx: noDocx });
    expect(result.fields).toEqual([['metadata_error', 'OLE 元数据读取失败;转换 DOCX 元数据读取失败']]);
  });

  it('文本类 Word 格式只读取转成 docx 后的属性，不尝试按 OLE 读取', async () => {
    for (const format of ['rtf', 'html-word', 'mht', 'word-xml']) {
      let cfbRead = false;
      const cfb: CfbApi = { read: () => ((cfbRead = true), buildFakeCfb() as never), find: fakeCfbFind as never };
      const result = await extractDocumentMetadata({ format, buffer: Buffer.alloc(0), cfb, readPdfInfo, toDocx: async () => buildMetadataDocx() });
      expect(cfbRead).toBe(false);
      expect(new Map(result.fields).get('converted_docx:author')).toBe('张三');
      expect(new Map(result.fields).get('author')).toBe('张三');
      const failed = await extractDocumentMetadata({ format, buffer: Buffer.alloc(0), cfb, readPdfInfo, toDocx: noDocx });
      expect(failed.fields).toEqual([['metadata_error', '转换 DOCX 元数据读取失败']]);
    }
  });

  it('docx 不是有效的 ZIP、ZIP 炸弹检查不通过、PDF 读取失败：只有 metadata_error', async () => {
    const bomb = buildZip([{ name: 'docProps/core.xml', data: Buffer.from('<x/>'), declaredSize: 1 }]);
    for (const buffer of [Buffer.from('not a zip'), bomb]) {
      expect((await extractDocumentMetadata({ format: 'docx', buffer, cfb: failingCfb, readPdfInfo, toDocx: noDocx })).fields).toEqual([['metadata_error', '元数据读取失败']]);
    }
    const pdfFailed = await extractDocumentMetadata({
      format: 'pdf',
      buffer: buildMetadataPdf(),
      cfb: failingCfb,
      readPdfInfo: async () => {
        throw new Error('Invalid PDF structure');
      },
      toDocx: noDocx,
    });
    expect(pdfFailed.fields).toEqual([['metadata_error', '元数据读取失败']]);
  });

  it('其他格式（表格、纯文本）不输出字段', async () => {
    for (const format of ['xlsx', 'xls-ole', 'text', 'markdown', 'html-sheet', 'spreadsheet-xml']) {
      expect((await extractDocumentMetadata({ format, buffer: Buffer.alloc(0), cfb: fakeCfb, readPdfInfo, toDocx: noDocx })).fields).toEqual([]);
    }
  });

  it('输出前按上限整理：不合规的键丢弃，过长的值截断，超出字段数的丢弃', () => {
    const fields = new Map<string, string>([
      ['title', '标题'],
      ['custom:名\u0001称', '控制字符'],
      ['custom:', '空名称'],
      ['custom:x:base64_decoded', '保留给 worker'],
      ['file_sha256', '0'.repeat(64)],
      ['unknown_key', '未知'],
      ['metadata_error', '解析库的错误消息'],
      ['description', `${'长'.repeat(METADATA_LIMITS.maxValueLength - 1)}😀`],
    ]);
    const result = finalizeMetadataFields(fields);
    expect(result.map(([key]) => key)).toEqual(['title', 'description']);
    expect(result[1]![1]).toBe('长'.repeat(METADATA_LIMITS.maxValueLength - 1));

    const many = new Map(Array.from({ length: METADATA_LIMITS.maxFields + 5 }, (_, index) => [`custom:p${index}`, 'v'] as [string, string]));
    expect(finalizeMetadataFields(many)).toHaveLength(METADATA_LIMITS.maxFields);
  });

  it('沙箱与 worker 的键规则、上限、格式一致', () => {
    expect(new Set(SANDBOX_FORMAT_METADATA_KEYS)).toEqual(FORMAT_METADATA_KEYS);
    for (const key of PROPERTY_SET_KEYS) expect(FORMAT_METADATA_KEYS.has(key)).toBe(true);
    expect(METADATA_LIMITS).toEqual({
      maxFields: DOCUMENT_METADATA_LIMITS.maxFields,
      maxKeyLength: DOCUMENT_METADATA_LIMITS.maxKeyLength,
      maxValueLength: DOCUMENT_METADATA_LIMITS.maxValueLength,
      maxTotalLength: DOCUMENT_METADATA_LIMITS.maxTotalLength,
    });
    expect(PARSE_FORMATS.filter((format) => supportsDocumentMetadata(format))).toEqual(PARSE_FORMATS.filter((format) => METADATA_FORMATS.includes(format)));
    const keys = [
      ...Object.values(expected).flat().map(([key]) => key),
      'converted_docx:custom:ICV', 'converted_docx:wps:application', 'ole_prop_4294967295', 'pdf_xmp:raw_signals', 'metadata_error',
      'custom:x', 'file_name', 'size', 'created_at', 'custom:a:base64_decoded', 'converted_docx:metadata_error', 'pdf_info:Title', 'pdf_raw:a-b',
      'ole_prop_x', 'wps:', `custom:${'x'.repeat(600)}`, 'custom:\u0000', 'converted_docx:converted_docx:title', 'other',
    ];
    for (const key of keys) expect(isDocumentMetadataKey(key), key).toBe(sandboxIsDocumentMetadataKey(key) && !['file_name', 'size', 'created_at'].includes(key));
  });
});

describe('metadata.json 的校验（worker）', () => {
  it('接受沙箱的输出并按桌面版的顺序并入文件基本信息，Base64 解码项由 worker 计算', async () => {
    const result = await extractDocumentMetadata({ format: 'docx', buffer: buildMetadataDocx(), cfb: failingCfb, readPdfInfo, toDocx: noDocx });
    const fields = parseDocumentMetadata(Buffer.from(JSON.stringify(result), 'utf8'));
    expect(Array.from(fields.entries())).toEqual(expected.docx);
    const basic = basicMetadataFields({ fileName: '投标文件.docx', extension: 'docx', size: 1234, sha256: 'a'.repeat(64) });
    const items = metadataItems(mergeDocumentMetadata(basic, fields));
    expect(items.slice(0, 5).map((item) => item.key)).toEqual(['file_name', 'extension', 'size', 'file_sha256', 'title']);
    const decoded = items.find((item) => item.key === 'custom:ICV:base64_decoded');
    expect(decoded).toMatchObject({ label: '自定义：ICV（Base64 解码）', value: '{"uid":"123456","name":"张三"}', comparable: true });
    // 哈希类的键不解码。
    expect(items.some((item) => item.key === 'custom:Hash:base64_decoded')).toBe(false);
    expect(items.find((item) => item.key === 'created')).toMatchObject({ dateComparable: true, dateDay: '2026-01-02' });
    expect(items.find((item) => item.key === 'wps:last_modified_by')).toMatchObject({ label: '疑似 WPS 用户/账号：last modified by', comparable: true });
  });

  it('OLE 与 PDF 的输出（含“；”连接的列表值）同样接受', () => {
    for (const fields of [expected.ole, expected.pdf]) expect(Array.from(parseDocumentMetadata(output(fields)).entries())).toEqual(fields);
    expect(parseDocumentMetadata(output([])).size).toBe(0);
    expect(Array.from(parseDocumentMetadata(output([['metadata_error', 'OLE 元数据读取失败;转换 DOCX 元数据读取失败']])).entries())).toHaveLength(1);
  });

  it.each([
    ['不是 JSON', Buffer.from('{')],
    ['非法 UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
    ['版本不对', output([], 2)],
    ['多出字段', Buffer.from(JSON.stringify({ version: 1, fields: [], extra: 1 }))],
    ['fields 不是数组', Buffer.from(JSON.stringify({ version: 1, fields: {} }))],
    ['字段不是二元组', output([['title']])],
    ['字段多一项', output([['title', 'a', 'b']])],
    ['键不是字符串', output([[1, 'a']])],
    ['值不是字符串', output([['pages', 3]])],
    ['值为空', output([['title', ' ']])],
    ['值含控制字符', output([['title', 'a\u0007b']])],
    ['值过长', output([['title', 'x'.repeat(DOCUMENT_METADATA_LIMITS.maxValueLength + 1)]])],
    ['未知的键', output([['unknown_key', 'a']])],
    ['覆盖文件基本信息', output([['file_sha256', 'a'.repeat(64)]])],
    ['冒充 Base64 解码项', output([['custom:ICV:base64_decoded', 'a']])],
    ['不规范的键名', output([['pdf_info:Title', 'a']])],
    ['重复的键', output([['title', 'a'], ['title', 'b']])],
    ['metadata_error 不是固定文字', output([['metadata_error', 'Error: ENOENT /input/source']])],
    ['converted_docx 前缀的 metadata_error', output([['converted_docx:metadata_error', '元数据读取失败']])],
    ['字段过多', output(Array.from({ length: DOCUMENT_METADATA_LIMITS.maxFields + 1 }, (_, index) => [`custom:p${index}`, 'v']))],
    ['总长度过大', output(Array.from({ length: 200 }, (_, index) => [`custom:p${index}`, 'x'.repeat(DOCUMENT_METADATA_LIMITS.maxValueLength)]))],
    ['字节数过大', Buffer.alloc(DOCUMENT_METADATA_LIMITS.maxBytes + 1, 0x20)],
  ])('拒绝：%s', (_, data) => {
    expect(() => parseDocumentMetadata(data)).toThrow(DuplicateAnalysisError);
  });
});
