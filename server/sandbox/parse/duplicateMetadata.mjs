// 标书查重的文档格式元数据（路线图第 6 步 6.10b；docs/SERVER_DESIGN.md 第 7.8 节），在 parse 沙箱中由 entry.mjs 调用
// （metadata=duplicate-check，输出 metadata.json）。提取逻辑搬自桌面版 client/electron/services/duplicateCheckService.cjs 的
// extractMetadata 中读取文档本身的部分，尽量保持输出一致：
// - docx：core / app / custom 属性与 Word 编辑会话 ID（rsid）；
// - 老式 Word（OLE）：SummaryInformation / DocumentSummaryInformation 属性集、存储结构与疑似账号痕迹，再加上转成 docx 后的属性；
// - PDF：Info、XMP、原始记录、结构、表单 / 签名 / 附件。
// 与桌面版的差别：
// - 只读内存中的原件字节；docx 先做 ZIP 炸弹检查（zipGuard.mjs），条目用内置的 zlib 读取（桌面版用 adm-zip）；
// - OLE 的读取（CFB）与 PDF 的 Info / XMP（pdf-parse）由调用方注入：沙箱中是 SheetJS 自带的 CFB（与桌面版的 cfb 同为 1.2.2）
//   和已有的 pdf-parse，没有新增依赖；代码页的解码用内置的 TextDecoder（桌面版用 iconv-lite）；
// - 文本类 Word 格式（RTF、HTML、MHT、Word 2003 XML，扩展名为 doc / wps）只取转成 docx 后的属性，不再尝试按 OLE 读取
//   （桌面版按扩展名走老式 Word 的流程，OLE 读取必然失败并记下错误）；
// - 读取失败的原因只有固定的文字（metadata_error），不带解析库的错误消息；
// - 输出前按 worker 的校验规则整理（finalizeMetadataFields）：字段数、键与值的长度有上限，键不合规的字段丢弃。
// 文件名、扩展名、大小、SHA-256 等基本信息由 worker 填写（src/duplicateCheck/analysis.ts），这里不输出。
// 本文件只用 Node 内置模块（宿主上的单元测试 server/tests/duplicateCheck/metadata.test.ts 直接导入）。
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { assertSafeZip } from './zipGuard.mjs';

/** 输出的上限（与 worker 的校验相同，src/duplicateCheck/analysis.ts）。 */
export const METADATA_LIMITS = Object.freeze({
  maxFields: 1_000,
  maxKeyLength: 512,
  maxValueLength: 8_000,
  /** 全部键与值的长度之和（UTF-16 单元）。 */
  maxTotalLength: 1_000_000,
});

/** 读取失败时 metadata_error 的取值（worker 只接受这几种）。 */
export const METADATA_ERRORS = Object.freeze({
  failed: '元数据读取失败',
  ole: 'OLE 元数据读取失败',
  convertedDocx: '转换 DOCX 元数据读取失败',
});

/** 由 worker 填写或计算的键，沙箱不能输出。 */
export const WORKER_METADATA_KEYS = Object.freeze(['file_name', 'extension', 'size', 'file_sha256', 'created_at', 'modified_at', 'accessed_at']);

/**
 * 固定名称的键：桌面版标签表中的格式元数据键、属性集映射中没有标签的三个键、metadata_error。
 * worker 有同样的一份（src/duplicateCheck/analysis.ts），单元测试检查两者一致。
 */
export const FORMAT_METADATA_KEYS = Object.freeze([
  'title', 'subject', 'author', 'last_modified_by', 'revision', 'created', 'modified', 'last_printed', 'keywords', 'category',
  'description', 'content_status', 'content_type', 'identifier', 'language', 'application', 'app_version', 'company', 'manager',
  'template', 'presentation_format', 'pages', 'words', 'characters', 'characters_with_spaces', 'bytes', 'lines', 'paragraphs',
  'slides', 'notes', 'hidden_slides', 'multimedia_clips', 'total_time', 'code_page', 'document_version', 'doc_security',
  'shared_doc', 'links_dirty', 'hlinks_changed', 'creator', 'producer', 'pdf_version', 'pdf_permissions', 'fingerprints',
  'word_rsid_root', 'word_rsid_count', 'word_rsid_values', 'word_rsid_fingerprint', 'ole_storage_count', 'ole_stream_count',
  'ole_stream_paths', 'ole_stream_paths_fingerprint', 'ole_stream_sizes_fingerprint', 'ole_has_macro_storage', 'ole_macro_paths',
  'pdf_header_version', 'pdf_object_count', 'pdf_startxref_count', 'pdf_incremental_update_count', 'pdf_linearized',
  'pdf_xref_type', 'pdf_trailer_id', 'pdf_has_acroform', 'pdf_has_xfa', 'pdf_signature_count', 'pdf_byterange_signature_count',
  'pdf_embedded_file_count', 'pdf_embedded_file_names',
  'scale_crop', 'heading_pairs', 'titles_of_parts',
  'metadata_error',
]);
const KNOWN_KEYS = new Set(FORMAT_METADATA_KEYS);

/** 文本类 Word 格式：经 LibreOffice 转成 docx 后读取属性。 */
export const WORD_TEXT_FORMATS = Object.freeze(['rtf', 'html-word', 'mht', 'word-xml']);
/** 提取元数据的格式（桌面版只对 docx / doc / wps / pdf 提取）。 */
export const METADATA_FORMATS = Object.freeze(['docx', 'word-ole', 'pdf', ...WORD_TEXT_FORMATS]);

// ---- 字段（与桌面版相同） ----

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue).filter(Boolean).join('；');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function addField(fields, key, value) {
  const text = normalizeValue(value);
  if (!text) return;
  fields.set(key, text);
}

function addFieldIfAbsent(fields, key, value) {
  if (fields.has(key)) return;
  addField(fields, key, value);
}

function addListField(fields, key, value) {
  const text = normalizeValue(value);
  if (!text) return;
  const current = fields.get(key);
  if (!current) {
    fields.set(key, text);
    return;
  }
  const parts = current.split('；').map((item) => item.trim()).filter(Boolean);
  if (!parts.includes(text)) fields.set(key, `${current}；${text}`);
}

function safeMetadataKey(value) {
  return normalizeValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'field';
}

function hashText(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function yesNo(value) {
  return value ? '是' : '否';
}

function countMatches(value, pattern) {
  const text = String(value || '');
  const regexp = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (regexp.exec(text)) count += 1;
  return count;
}

function uniqueSortedValues(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((item) => normalizeValue(item))
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
}

function summarizeValues(values, limit = 80) {
  const sorted = uniqueSortedValues(values);
  if (!sorted.length) return '';
  const visible = sorted.slice(0, limit).join('；');
  return sorted.length > limit ? `${visible}；...共${sorted.length}项` : visible;
}

function mergeMetadataFields(target, source, options = {}) {
  for (const [key, value] of source.entries()) {
    if (options.fillOnlyIfAbsent) addFieldIfAbsent(target, key, value);
    else addField(target, key, value);
    if (options.prefix) addField(target, `${options.prefix}:${key}`, value);
  }
}

// ---- docx ----

function xmlText(xml, tagName) {
  const pattern = new RegExp(`<[^:>]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tagName}>`, 'i');
  const match = String(xml || '').match(pattern);
  return match ? decodeXml(match[1]) : '';
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * 读取 ZIP 条目（取代桌面版的 adm-zip）。先做完整的 ZIP 炸弹检查：每个条目实际解压后不超过声明的大小，合计不超过上限，
 * 所以这里按声明的大小解压是有界的。同名条目取第一个。
 */
async function openZip(buffer) {
  const entries = await assertSafeZip(buffer);
  const read = (entry) => {
    const local = entry.localOffset;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + entry.compressedSize);
    return entry.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
  };
  return {
    entries: entries.map((entry) => ({ name: entry.name, read: () => read(entry) })),
    text(name) {
      const entry = entries.find((item) => item.name === name);
      return entry ? read(entry).toString('utf8') : '';
    },
  };
}

function formatDocxTotalTime(value) {
  const text = normalizeValue(value);
  if (!text) return '';
  return /^\d+$/.test(text) ? `${text} 分钟` : text;
}

function addDocxRsidFields(fields, zip) {
  const values = new Set();
  let root = '';
  const entries = zip.entries.filter((entry) => /^word\/.*\.xml$/i.test(entry.name || ''));
  const rsidPattern = /\b(?:[A-Za-z0-9_]+:)?(rsid[A-Za-z0-9]*)=["']([0-9A-Fa-f]{1,16})["']/g;

  for (const entry of entries) {
    const xml = entry.read().toString('utf8');
    let match;
    while ((match = rsidPattern.exec(xml))) {
      const attr = String(match[1] || '').toLowerCase();
      const value = String(match[2] || '').toUpperCase();
      if (!value) continue;
      values.add(value);
      if (attr === 'rsidroot' && !root) root = value;
    }
  }

  const sorted = uniqueSortedValues(Array.from(values));
  addField(fields, 'word_rsid_root', root);
  addField(fields, 'word_rsid_count', sorted.length);
  addField(fields, 'word_rsid_values', summarizeValues(sorted));
  if (sorted.length) addField(fields, 'word_rsid_fingerprint', hashText(sorted.join('\n')));
}

export async function extractDocxMetadata(buffer) {
  const zip = await openZip(buffer);
  const fields = new Map();
  const core = zip.text('docProps/core.xml');
  const app = zip.text('docProps/app.xml');
  const custom = zip.text('docProps/custom.xml');

  addField(fields, 'title', xmlText(core, 'title'));
  addField(fields, 'subject', xmlText(core, 'subject'));
  addField(fields, 'author', xmlText(core, 'creator'));
  addField(fields, 'last_modified_by', xmlText(core, 'lastModifiedBy'));
  addField(fields, 'revision', xmlText(core, 'revision'));
  addField(fields, 'created', xmlText(core, 'created'));
  addField(fields, 'modified', xmlText(core, 'modified'));
  addField(fields, 'keywords', xmlText(core, 'keywords'));
  addField(fields, 'category', xmlText(core, 'category'));
  addField(fields, 'description', xmlText(core, 'description'));
  addField(fields, 'application', xmlText(app, 'Application'));
  addField(fields, 'app_version', xmlText(app, 'AppVersion'));
  addField(fields, 'company', xmlText(app, 'Company'));
  addField(fields, 'manager', xmlText(app, 'Manager'));
  addField(fields, 'template', xmlText(app, 'Template'));
  addField(fields, 'pages', xmlText(app, 'Pages'));
  addField(fields, 'words', xmlText(app, 'Words'));
  addField(fields, 'characters', xmlText(app, 'Characters'));
  addField(fields, 'lines', xmlText(app, 'Lines'));
  addField(fields, 'paragraphs', xmlText(app, 'Paragraphs'));
  addField(fields, 'total_time', formatDocxTotalTime(xmlText(app, 'TotalTime')));

  for (const match of custom.matchAll(/<property\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/property>/gi)) {
    const key = `custom:${decodeXml(match[1])}`;
    const valueMatch = match[2].match(/<[^>]+>([\s\S]*?)<\/[^>]+>/);
    addField(fields, key, valueMatch ? decodeXml(valueMatch[1]) : decodeXml(match[2]));
  }

  addDocxRsidFields(fields, zip);
  addWpsSignalFields(fields);
  return fields;
}

// ---- OLE 属性集 ----

const SUMMARY_PROPERTY_MAP = {
  0x01: { key: 'code_page' },
  0x02: { key: 'title' },
  0x03: { key: 'subject' },
  0x04: { key: 'author' },
  0x05: { key: 'keywords' },
  0x06: { key: 'description' },
  0x07: { key: 'template' },
  0x08: { key: 'last_modified_by' },
  0x09: { key: 'revision' },
  0x0a: { key: 'total_time', kind: 'duration_filetime' },
  0x0b: { key: 'last_printed' },
  0x0c: { key: 'created' },
  0x0d: { key: 'modified' },
  0x0e: { key: 'pages' },
  0x0f: { key: 'words' },
  0x10: { key: 'characters' },
  0x12: { key: 'application' },
  0x13: { key: 'doc_security' },
};

const DOC_SUMMARY_PROPERTY_MAP = {
  0x01: { key: 'code_page' },
  0x02: { key: 'category' },
  0x03: { key: 'presentation_format' },
  0x04: { key: 'bytes' },
  0x05: { key: 'lines' },
  0x06: { key: 'paragraphs' },
  0x07: { key: 'slides' },
  0x08: { key: 'notes' },
  0x09: { key: 'hidden_slides' },
  0x0a: { key: 'multimedia_clips' },
  0x0b: { key: 'scale_crop' },
  0x0c: { key: 'heading_pairs' },
  0x0d: { key: 'titles_of_parts' },
  0x0e: { key: 'manager' },
  0x0f: { key: 'company' },
  0x10: { key: 'links_dirty' },
  0x11: { key: 'characters_with_spaces' },
  0x13: { key: 'shared_doc' },
  0x16: { key: 'hlinks_changed' },
  0x17: { key: 'app_version', kind: 'version' },
  0x1a: { key: 'content_type' },
  0x1b: { key: 'content_status' },
  0x1c: { key: 'language' },
  0x1d: { key: 'document_version' },
};

/** 属性集映射中的键（单元测试检查都在 FORMAT_METADATA_KEYS 中）。 */
export const PROPERTY_SET_KEYS = Object.freeze([...new Set([...Object.values(SUMMARY_PROPERTY_MAP), ...Object.values(DOC_SUMMARY_PROPERTY_MAP)].map((item) => item.key))]);

function align4(value) {
  return value + ((4 - (value % 4)) % 4);
}

function readUInt16LE(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : 0;
}

function readInt16LE(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readInt16LE(offset) : 0;
}

function readUInt32LE(buffer, offset) {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : 0;
}

function readInt32LE(buffer, offset) {
  return offset + 4 <= buffer.length ? buffer.readInt32LE(offset) : 0;
}

/** 代码页 → TextDecoder 的编码名（桌面版 codePageToEncoding 的 iconv-lite 编码名对应的 WHATWG 名称）；null 为 latin1。 */
function codePageToEncoding(codePage) {
  const value = Number(codePage) || 1252;
  if (value === 936 || value === 54936) return 'gb18030';
  if (value === 950) return 'big5';
  if (value === 932) return 'shift_jis';
  if (value === 949) return 'euc-kr';
  if (value === 65001) return 'utf-8';
  if (value === 1200 || value === 1201) return 'utf-16le';
  if (value >= 1250 && value <= 1258) return `windows-${value}`;
  return null;
}

function decodeCodePageBuffer(buffer, codePage) {
  const encoding = codePageToEncoding(codePage);
  // TextDecoder 的 latin1 实为 windows-1252，与 iconv-lite 的 latin1（ISO-8859-1）不同，按字节直接转换。
  if (!encoding) return buffer.toString('latin1');
  try {
    // iconv-lite 默认去掉开头的 BOM（各编码都去掉），TextDecoder 只对 UTF-8 / UTF-16 去掉，这里补上。
    return new TextDecoder(encoding).decode(buffer).replace(/^﻿/, '');
  } catch {
    return buffer.toString('latin1');
  }
}

function cleanOleString(value) {
  return String(value || '').replace(/\u0000+$/g, '').replace(/\u0000/g, '').trim();
}

function parseFileTimeValue(buffer, offset) {
  const low = readUInt32LE(buffer, offset);
  const high = readUInt32LE(buffer, offset + 4);
  if (!low && !high) return '';
  const ticks = (BigInt(high) << 32n) + BigInt(low);
  const unixMs = ticks / 10000n - 11644473600000n;
  const date = new Date(Number(unixMs));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function parseFileTimeDuration(buffer, offset) {
  const low = readUInt32LE(buffer, offset);
  const high = readUInt32LE(buffer, offset + 4);
  const ticks = (BigInt(high) << 32n) + BigInt(low);
  if (!ticks) return '';
  const seconds = Number(ticks / 10000000n);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
}

function parseLpstr(buffer, offset, codePage, padded = true) {
  const length = readUInt32LE(buffer, offset);
  const start = offset + 4;
  const byteLength = Math.max(0, Math.min(length, buffer.length - start));
  const raw = buffer.subarray(start, start + byteLength);
  return {
    value: cleanOleString(decodeCodePageBuffer(raw, codePage)),
    nextOffset: padded ? align4(start + byteLength) : start + byteLength,
  };
}

function parseLpwstr(buffer, offset, padded = true) {
  const charLength = readUInt32LE(buffer, offset);
  const start = offset + 4;
  const byteLength = Math.max(0, Math.min(charLength * 2, buffer.length - start));
  const raw = buffer.subarray(start, start + byteLength);
  return {
    value: cleanOleString(raw.toString('utf16le')),
    nextOffset: padded ? align4(start + byteLength) : start + byteLength,
  };
}

function parseVectorStringValue(buffer, offset, type, codePage) {
  const count = readUInt32LE(buffer, offset);
  let cursor = offset + 4;
  const values = [];
  for (let index = 0; index < count && cursor < buffer.length; index += 1) {
    const parsed = type === 0x101f ? parseLpwstr(buffer, cursor, true) : parseLpstr(buffer, cursor, codePage, false);
    if (parsed.value) values.push(parsed.value);
    cursor = parsed.nextOffset;
  }
  return { value: values, nextOffset: cursor };
}

function parseVectorVariantValue(buffer, offset, codePage) {
  const count = readUInt32LE(buffer, offset);
  let cursor = offset + 4;
  const values = [];
  for (let index = 0; index < count && cursor < buffer.length; index += 1) {
    const parsed = parseTypedPropertyValue(buffer, cursor, codePage);
    if (parsed.value !== '') values.push(parsed.value);
    cursor = parsed.nextOffset;
  }
  return { value: values, nextOffset: cursor };
}

function parseTypedPropertyValue(buffer, offset, codePage = 1252) {
  const type = readUInt16LE(buffer, offset);
  const valueOffset = offset + 4;
  if (!type || valueOffset > buffer.length) return { type, value: '', nextOffset: valueOffset };

  if (type === 0x02) return { type, value: readInt16LE(buffer, valueOffset), nextOffset: align4(valueOffset + 2) };
  if (type === 0x03) return { type, value: readInt32LE(buffer, valueOffset), nextOffset: valueOffset + 4 };
  if (type === 0x05) return { type, value: buffer.readDoubleLE(valueOffset), nextOffset: valueOffset + 8 };
  if (type === 0x0b) return { type, value: readUInt32LE(buffer, valueOffset) !== 0, nextOffset: valueOffset + 4 };
  if (type === 0x13) return { type, value: readUInt32LE(buffer, valueOffset), nextOffset: valueOffset + 4 };
  if (type === 0x1e) return { type, ...parseLpstr(buffer, valueOffset, codePage, true) };
  if (type === 0x1f) return { type, ...parseLpwstr(buffer, valueOffset, true) };
  if (type === 0x40) return { type, value: parseFileTimeValue(buffer, valueOffset), nextOffset: valueOffset + 8 };
  if (type === 0x50) return { type, ...parseLpwstr(buffer, valueOffset, true) };
  if (type === 0x51) return { type, ...parseLpwstr(buffer, valueOffset, false) };
  if (type === 0x101e || type === 0x101f) return { type, ...parseVectorStringValue(buffer, valueOffset, type, codePage) };
  if (type === 0x100c) return { type, ...parseVectorVariantValue(buffer, valueOffset, codePage) };
  if (type === 0x41) {
    const size = readUInt32LE(buffer, valueOffset);
    return { type, value: size ? `BLOB ${size} bytes` : '', nextOffset: align4(valueOffset + 4 + size) };
  }
  return { type, value: '', nextOffset: valueOffset + 4 };
}

function parsePropertyDictionary(buffer, offset, codePage) {
  const count = readUInt32LE(buffer, offset);
  const dictionary = new Map();
  let cursor = offset + 4;
  for (let index = 0; index < count && cursor + 8 <= buffer.length; index += 1) {
    const propertyId = readUInt32LE(buffer, cursor);
    const length = readUInt32LE(buffer, cursor + 4);
    cursor += 8;
    let byteLength = codePage === 1200 ? length * 2 : length;
    if (cursor + byteLength > buffer.length) byteLength = Math.max(0, Math.min(length, buffer.length - cursor));
    const raw = buffer.subarray(cursor, cursor + byteLength);
    const value = codePage === 1200 ? cleanOleString(raw.toString('utf16le')) : cleanOleString(decodeCodePageBuffer(raw, codePage));
    if (value) dictionary.set(propertyId, value.replace(/^\u0005/, '!'));
    cursor = align4(cursor + byteLength);
  }
  return dictionary;
}

function formatVersionNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return `${number >>> 16}.${String(number & 0xffff).padStart(4, '0')}`;
}

function parsePropertySet(buffer, offset, propertyMap = {}) {
  const size = readUInt32LE(buffer, offset);
  const count = readUInt32LE(buffer, offset + 4);
  const entries = [];
  for (let index = 0; index < count && offset + 8 + index * 8 + 8 <= buffer.length; index += 1) {
    entries.push({ id: readUInt32LE(buffer, offset + 8 + index * 8), offset: offset + readUInt32LE(buffer, offset + 12 + index * 8) });
  }

  let codePage = 1252;
  const codePageEntry = entries.find((entry) => entry.id === 0x01);
  if (codePageEntry) {
    const parsedCodePage = parseTypedPropertyValue(buffer, codePageEntry.offset, codePage).value;
    if (parsedCodePage) codePage = Number(parsedCodePage) || codePage;
  }

  const dictionaryEntry = entries.find((entry) => entry.id === 0x00);
  const dictionary = dictionaryEntry ? parsePropertyDictionary(buffer, dictionaryEntry.offset, codePage) : new Map();
  const fields = new Map();
  const endOffset = size ? offset + size : buffer.length;

  for (const entry of entries) {
    if (entry.id === 0x00 || entry.offset >= endOffset || entry.offset >= buffer.length) continue;
    const propertyInfo = propertyMap[entry.id];
    const parsed = parseTypedPropertyValue(buffer, entry.offset, codePage);
    let value = propertyInfo?.kind === 'duration_filetime' && parsed.type === 0x40
      ? parseFileTimeDuration(buffer, entry.offset + 4)
      : parsed.value;
    if (propertyInfo?.kind === 'version') value = formatVersionNumber(value);
    const name = propertyInfo?.key || (dictionary.get(entry.id) ? `custom:${dictionary.get(entry.id)}` : `ole_prop_${entry.id}`);
    addField(fields, name, value);
  }
  return fields;
}

/** 解析一个属性集 Stream（第一个属性集按 propertyMap 命名，其余按字典或编号）。 */
function parsePropertySetStream(content, propertyMap) {
  const buffer = Buffer.from(content || []);
  const fields = new Map();
  if (buffer.length < 48 || readUInt16LE(buffer, 0) !== 0xfffe) return fields;
  const setCount = readUInt32LE(buffer, 24);
  for (let index = 0; index < setCount && 28 + index * 20 + 20 <= buffer.length; index += 1) {
    const setOffset = readUInt32LE(buffer, 28 + index * 20 + 16);
    if (!setOffset || setOffset >= buffer.length) continue;
    const parsed = parsePropertySet(buffer, setOffset, index === 0 ? propertyMap : {});
    for (const [key, value] of parsed.entries()) addField(fields, key, value);
  }
  return fields;
}

function findCfbEntry(cfbApi, cfb, streamName) {
  const bangName = streamName.replace(/^\u0005/, '!');
  const candidates = [streamName, `/${streamName}`, bangName, `/${bangName}`];
  for (const candidate of candidates) {
    const entry = cfbApi.find(cfb, candidate);
    if (entry?.content) return entry;
  }
  return null;
}

const rawSignalPattern = /(kingsoft|wps office|\bwps\b|\bkso\b|account|e-mail|email|mail|userid|user id|user_id|uid|账号|金山)/ig;

function collectSignalSnippets(value, limit = 5) {
  const text = String(value || '').replace(/\u0000/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]+/g, ' ');
  const snippets = [];
  rawSignalPattern.lastIndex = 0;
  let match;
  while ((match = rawSignalPattern.exec(text)) && snippets.length < limit) {
    const start = Math.max(0, (match.index || 0) - 40);
    const end = Math.min(text.length, (match.index || 0) + match[0].length + 80);
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (isReadableSignalSnippet(snippet) && !snippets.includes(snippet)) snippets.push(snippet);
  }
  return snippets;
}

function isReadableSignalSnippet(value) {
  const text = String(value || '').trim();
  if (!text || text.includes('�')) return false;
  const chars = Array.from(text);
  const readable = chars.filter((char) => /[\p{Script=Han}A-Za-z0-9\s.,:;_@/\\\-()[\]{}"'，。：；（）【】《》、]/u.test(char)).length;
  return readable / Math.max(chars.length, 1) >= 0.75;
}

function collectBinarySignalSnippets(content) {
  const buffer = Buffer.from(content || []).subarray(0, 1024 * 1024);
  const candidates = [buffer.toString('utf16le'), decodeCodePageBuffer(buffer, 936), buffer.toString('utf8')];
  const snippets = [];
  for (const text of candidates) {
    for (const snippet of collectSignalSnippets(text, 3)) {
      if (!snippets.includes(snippet)) snippets.push(snippet);
      if (snippets.length >= 5) return snippets;
    }
  }
  return snippets;
}

function addOleSignalFields(fields, cfb) {
  for (let index = 0; index < cfb.FileIndex.length; index += 1) {
    const entry = cfb.FileIndex[index];
    const fullPath = cfb.FullPaths[index] || entry.name || `stream_${index}`;
    const signalKey = `ole_signal:${safeMetadataKey(fullPath)}`;
    for (const snippet of collectSignalSnippets(fullPath, 2)) addListField(fields, signalKey, snippet);
    if (entry?.content?.length && !isOlePropertySetStreamName(fullPath)) {
      for (const snippet of collectBinarySignalSnippets(entry.content)) addListField(fields, signalKey, snippet);
    }
  }
}

function addOleStructureFields(fields, cfb) {
  const entries = cfb.FileIndex.map((entry, index) => ({
    entry,
    path: normalizeValue(cfb.FullPaths[index] || entry.name || `stream_${index}`),
  })).filter((item) => item.path);
  const streamEntries = entries.filter((item) => item.entry?.type === 2 || item.entry?.content);
  const storageEntries = entries.filter((item) => item.entry?.type === 1);
  const streamPaths = streamEntries.map((item) => item.path.replace(/^\/Root Entry\/?/i, ''));
  const streamSizes = streamEntries.map((item) => `${item.path}:${item.entry?.content?.length || item.entry?.size || 0}`);
  const macroPaths = streamPaths.filter((item) => /(^|[\/\\])(?:vba|macros?|vbaProject\.bin|dir)([\/\\]|$)/i.test(item));

  addField(fields, 'ole_storage_count', storageEntries.length);
  addField(fields, 'ole_stream_count', streamEntries.length);
  addField(fields, 'ole_stream_paths', summarizeValues(streamPaths, 120));
  if (streamPaths.length) addField(fields, 'ole_stream_paths_fingerprint', hashText(uniqueSortedValues(streamPaths).join('\n')));
  if (streamSizes.length) addField(fields, 'ole_stream_sizes_fingerprint', hashText(uniqueSortedValues(streamSizes).join('\n')));
  addField(fields, 'ole_has_macro_storage', yesNo(macroPaths.length > 0));
  addField(fields, 'ole_macro_paths', summarizeValues(macroPaths, 40));
}

function isOlePropertySetStreamName(value) {
  return /(?:summaryinformation|documentsummaryinformation)$/i.test(String(value || '').replace(/^.*[\\/]/, '').replace(/^\u0005|^!/, ''));
}

function addWpsSignalFields(fields) {
  const entries = Array.from(fields.entries());
  for (const [key, value] of entries) {
    if (key.startsWith('wps:')) continue;
    const haystack = `${key} ${value}`;
    if (!collectSignalSnippets(haystack, 1).length) continue;
    addListField(fields, `wps:${safeMetadataKey(key)}`, value);
  }
}

/** @param {{ read: (buffer: Buffer, options: object) => any, find: (cfb: any, path: string) => any }} cfbApi */
export function extractOleMetadata(buffer, cfbApi) {
  const cfb = cfbApi.read(buffer, { type: 'buffer' });
  const fields = new Map();
  const summary = findCfbEntry(cfbApi, cfb, '\u0005SummaryInformation');
  const documentSummary = findCfbEntry(cfbApi, cfb, '\u0005DocumentSummaryInformation');

  if (summary) {
    for (const [key, value] of parsePropertySetStream(summary.content, SUMMARY_PROPERTY_MAP).entries()) addField(fields, key, value);
  }
  if (documentSummary) {
    for (const [key, value] of parsePropertySetStream(documentSummary.content, DOC_SUMMARY_PROPERTY_MAP).entries()) addField(fields, key, value);
  }
  addOleStructureFields(fields, cfb);
  addOleSignalFields(fields, cfb);
  addWpsSignalFields(fields);
  return fields;
}

/**
 * 老式 Word：OLE 属性（只对 OLE 原件）+ 转成 docx 后的属性（只填补没有的字段，另以 converted_docx: 前缀全部保留）。
 * @param {{ ole: boolean, cfb?: object, toDocx: () => Promise<Buffer> }} options
 */
async function extractLegacyWordMetadata(buffer, options) {
  const fields = new Map();
  const errors = [];
  if (options.ole) {
    try {
      mergeMetadataFields(fields, extractOleMetadata(buffer, options.cfb));
    } catch {
      errors.push(METADATA_ERRORS.ole);
    }
  }

  try {
    mergeMetadataFields(fields, await extractDocxMetadata(await options.toDocx()), {
      fillOnlyIfAbsent: true,
      prefix: 'converted_docx',
    });
  } catch {
    errors.push(METADATA_ERRORS.convertedDocx);
  }

  if (errors.length) addListField(fields, 'metadata_error', errors.join('；'));
  addWpsSignalFields(fields);
  return fields;
}

// ---- PDF ----

const PDF_INFO_KEY_MAP = {
  Title: 'title',
  Author: 'author',
  Subject: 'subject',
  Keywords: 'keywords',
  Creator: 'creator',
  Producer: 'producer',
  CreationDate: 'created',
  ModDate: 'modified',
  PDFFormatVersion: 'pdf_version',
};

function getPdfMetadataValue(metadata, ...names) {
  if (!metadata) return '';
  for (const name of names) {
    if (typeof metadata.get === 'function') {
      const value = metadata.get(name);
      if (normalizeValue(value)) return value;
    }
    if (Object.prototype.hasOwnProperty.call(metadata, name) && normalizeValue(metadata[name])) return metadata[name];
  }
  return '';
}

function getPdfMetadataEntries(metadata) {
  if (!metadata) return [];
  if (typeof metadata[Symbol.iterator] === 'function') return Array.from(metadata);
  return Object.entries(metadata).filter(([, value]) => normalizeValue(value));
}

function canonicalPdfXmpKey(rawKey) {
  const key = String(rawKey || '').toLowerCase();
  if (/(^|:)title$/.test(key)) return 'title';
  if (/(^|:)creator$/.test(key)) return 'author';
  if (/creatortool$/.test(key)) return 'creator';
  if (/producer$/.test(key)) return 'producer';
  if (/(^|:)subject$/.test(key)) return 'subject';
  if (/keywords$/.test(key)) return 'keywords';
  if (/description$/.test(key)) return 'description';
  if (/createdate$/.test(key)) return 'created';
  if (/(modifydate|metadatadate)$/.test(key)) return 'modified';
  return '';
}

function addPdfInfoFields(fields, info) {
  for (const [rawKey, value] of Object.entries(info || {})) {
    const text = normalizeValue(value);
    if (!text) continue;
    if (PDF_INFO_KEY_MAP[rawKey]) addField(fields, PDF_INFO_KEY_MAP[rawKey], text);
    addField(fields, `pdf_info:${safeMetadataKey(rawKey)}`, text);
  }
}

function addPdfXmpFields(fields, metadata) {
  for (const [rawKey, value] of getPdfMetadataEntries(metadata)) {
    const text = normalizeValue(value);
    if (!text) continue;
    const canonical = canonicalPdfXmpKey(rawKey);
    if (canonical) addFieldIfAbsent(fields, canonical, text);
    addField(fields, `pdf_xmp:${safeMetadataKey(rawKey)}`, text);
  }

  const raw = typeof metadata?.getRaw === 'function' ? metadata.getRaw() : '';
  for (const snippet of collectSignalSnippets(raw, 5)) addListField(fields, 'pdf_xmp:raw_signals', snippet);
}

function decodeUtf16Be(buffer) {
  const chars = [];
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const code = buffer.readUInt16BE(offset);
    if (code) chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

function decodePdfStringBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return decodeUtf16Be(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  const utf8 = buffer.toString('utf8').trim();
  return utf8 || buffer.toString('latin1').trim();
}

function decodePdfLiteralString(value) {
  let text = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      text += char;
      continue;
    }
    const next = value[index + 1];
    if (!next) continue;
    index += 1;
    if (next === 'n') text += '\n';
    else if (next === 'r') text += '\r';
    else if (next === 't') text += '\t';
    else if (next === 'b') text += '\b';
    else if (next === 'f') text += '\f';
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let count = 0; count < 2 && /[0-7]/.test(value[index + 1] || ''); count += 1) octal += value[++index];
      text += String.fromCharCode(parseInt(octal, 8));
    } else {
      text += next;
    }
  }
  return decodePdfStringBuffer(Buffer.from(text, 'latin1'));
}

function decodePdfHexString(value) {
  const hex = value.replace(/\s+/g, '');
  if (!hex || hex.length % 2 !== 0) return '';
  try {
    return decodePdfStringBuffer(Buffer.from(hex, 'hex'));
  } catch {
    return '';
  }
}

function addPdfRawFields(fields, buffer) {
  const text = buffer.toString('latin1');
  const pattern = /\/(Title|Author|Subject|Keywords|Creator|Producer|CreationDate|ModDate)\s*(\((?:\\.|[^\\)]){0,1000}\)|<([0-9a-fA-F\s]{2,2000})>)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const rawKey = match[1];
    const rawValue = match[3] ? decodePdfHexString(match[3]) : decodePdfLiteralString(match[2].slice(1, -1));
    addListField(fields, `pdf_raw:${safeMetadataKey(rawKey)}`, rawValue);
  }
  for (const snippet of collectBinarySignalSnippets(buffer)) addListField(fields, 'pdf_raw:signals', snippet);
}

function decodePdfName(value) {
  return String(value || '').replace(/#([0-9a-fA-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodePdfTokenString(token) {
  const value = String(token || '').trim();
  if (!value) return '';
  if (value.startsWith('(') && value.endsWith(')')) return decodePdfLiteralString(value.slice(1, -1));
  if (value.startsWith('<') && value.endsWith('>')) return decodePdfHexString(value.slice(1, -1));
  if (value.startsWith('/')) return decodePdfName(value.slice(1));
  return value;
}

function normalizePdfIdToken(token) {
  const value = String(token || '').trim();
  if (value.startsWith('<') && value.endsWith('>')) return `<${value.slice(1, -1).replace(/\s+/g, '').toLowerCase()}>`;
  return decodePdfTokenString(value);
}

function extractPdfTrailerIds(text) {
  const ids = [];
  const pattern = /\/ID\s*\[\s*(<[^>\r\n]{1,512}>|\((?:\\.|[^\\)]){0,512}\))\s*(<[^>\r\n]{1,512}>|\((?:\\.|[^\\)]){0,512}\))/g;
  let match;
  while ((match = pattern.exec(text))) {
    const first = normalizePdfIdToken(match[1]);
    const second = normalizePdfIdToken(match[2]);
    if (first || second) ids.push([first, second].filter(Boolean).join(' / '));
  }
  return uniqueSortedValues(ids);
}

function extractPdfAttachmentNames(text) {
  const names = [];
  const filespecPattern = /\/Type\s*\/Filespec\b/g;
  const stringToken = '(\\((?:\\\\.|[^\\\\)]){0,500}\\)|<[0-9a-fA-F\\s]{2,1000}>|\/[^\\s<>\\[\\]()/]{1,300})';
  const ufPattern = new RegExp(`/UF\\s*${stringToken}`);
  const fPattern = new RegExp(`/F\\s*${stringToken}`);
  let match;
  while ((match = filespecPattern.exec(text))) {
    const chunk = text.slice(match.index, Math.min(text.length, match.index + 2200));
    const nameMatch = chunk.match(ufPattern) || chunk.match(fPattern);
    const name = decodePdfTokenString(nameMatch?.[1] || '');
    if (name) names.push(name);
  }
  return uniqueSortedValues(names);
}

function addPdfStructureFields(fields, buffer) {
  const text = buffer.toString('latin1');
  const headerVersion = text.slice(0, 1024).match(/%PDF-(\d\.\d)/)?.[1] || '';
  const objectCount = countMatches(text, /(?:^|[\r\n])\s*\d+\s+\d+\s+obj\b/g);
  const startxrefCount = countMatches(text, /(?:^|[\r\n])startxref\b/g);
  const hasClassicXref = /(?:^|[\r\n])xref(?:\s|[\r\n])/.test(text);
  const xrefStreamCount = countMatches(text, /\/Type\s*\/XRef\b/g);
  const xrefTypes = [];
  if (hasClassicXref) xrefTypes.push('传统 xref 表');
  if (xrefStreamCount) xrefTypes.push('XRef 对象流');

  addField(fields, 'pdf_header_version', headerVersion);
  addField(fields, 'pdf_object_count', objectCount);
  addField(fields, 'pdf_startxref_count', startxrefCount);
  addField(fields, 'pdf_incremental_update_count', Math.max(0, startxrefCount - 1));
  addField(fields, 'pdf_linearized', yesNo(/\/Linearized\s+\d/.test(text.slice(0, 4096))));
  addField(fields, 'pdf_xref_type', xrefTypes.join('；') || '未识别');
  addField(fields, 'pdf_trailer_id', summarizeValues(extractPdfTrailerIds(text), 8));
}

function addPdfFormSignatureAttachmentFields(fields, buffer) {
  const text = buffer.toString('latin1');
  const byteRangeSignatureCount = countMatches(text, /\/ByteRange\s*\[/g);
  const signatureFieldCount = countMatches(text, /\/FT\s*\/Sig\b/g);
  const signatureObjectCount = countMatches(text, /\/Type\s*\/Sig\b/g);
  const embeddedFileCount = countMatches(text, /\/Type\s*\/EmbeddedFile\b/g);
  const attachmentNames = extractPdfAttachmentNames(text);

  addField(fields, 'pdf_has_acroform', yesNo(/\/AcroForm\b/.test(text)));
  addField(fields, 'pdf_has_xfa', yesNo(/\/XFA\b/.test(text)));
  addField(fields, 'pdf_signature_count', Math.max(signatureFieldCount, signatureObjectCount, byteRangeSignatureCount));
  addField(fields, 'pdf_byterange_signature_count', byteRangeSignatureCount);
  addField(fields, 'pdf_embedded_file_count', Math.max(embeddedFileCount, attachmentNames.length));
  addField(fields, 'pdf_embedded_file_names', summarizeValues(attachmentNames, 40));
}

/**
 * @param {Buffer} buffer
 * @param {(buffer: Buffer) => Promise<{ info?: object, metadata?: any, total?: number, pages?: number, numpages?: number,
 *   version?: string, fingerprints?: unknown, permission?: unknown }>} readPdfInfo pdf-parse 的 getInfo
 */
export async function extractPdfMetadata(buffer, readPdfInfo) {
  const fields = new Map();
  const result = await readPdfInfo(buffer);
  const info = result.info || {};
  const metadata = result.metadata || null;
  addPdfInfoFields(fields, info);
  addPdfXmpFields(fields, metadata);
  addFieldIfAbsent(fields, 'title', getPdfMetadataValue(metadata, 'dc:title', 'Title'));
  addFieldIfAbsent(fields, 'author', getPdfMetadataValue(metadata, 'dc:creator', 'Author'));
  addFieldIfAbsent(fields, 'subject', getPdfMetadataValue(metadata, 'dc:subject', 'Subject'));
  addFieldIfAbsent(fields, 'keywords', getPdfMetadataValue(metadata, 'pdf:Keywords', 'Keywords'));
  addFieldIfAbsent(fields, 'creator', getPdfMetadataValue(metadata, 'xmp:CreatorTool', 'Creator'));
  addFieldIfAbsent(fields, 'producer', getPdfMetadataValue(metadata, 'pdf:Producer', 'Producer'));
  addFieldIfAbsent(fields, 'created', getPdfMetadataValue(metadata, 'xmp:CreateDate', 'CreationDate'));
  addFieldIfAbsent(fields, 'modified', getPdfMetadataValue(metadata, 'xmp:ModifyDate', 'xmp:MetadataDate', 'ModDate'));
  addField(fields, 'pages', result.total || result.pages || result.numpages);
  addField(fields, 'pdf_version', result.version || info.PDFFormatVersion);
  addField(fields, 'fingerprints', result.fingerprints);
  addField(fields, 'pdf_permissions', result.permission);
  addPdfRawFields(fields, buffer);
  addPdfStructureFields(fields, buffer);
  addPdfFormSignatureAttachmentFields(fields, buffer);
  addWpsSignalFields(fields);
  return fields;
}

// ---- 汇总与输出 ----

const SAFE_KEY = /^[a-z0-9_一-龥]{1,80}$/;
const SAFE_KEY_PREFIXES = Object.freeze(['ole_signal:', 'wps:', 'pdf_info:', 'pdf_xmp:', 'pdf_raw:']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** 沙箱能输出的键（worker 用同一规则校验，src/duplicateCheck/analysis.ts 的 isDocumentMetadataKey）。 */
export function isDocumentMetadataKey(key) {
  if (typeof key !== 'string' || !key || key.length > METADATA_LIMITS.maxKeyLength || CONTROL_CHARACTERS.test(key)) return false;
  if (key.endsWith(':base64_decoded')) return false;
  const base = key.startsWith('converted_docx:') ? key.slice('converted_docx:'.length) : key;
  if (base === 'metadata_error' && base !== key) return false;
  if (KNOWN_KEYS.has(base)) return true;
  if (/^ole_prop_\d{1,10}$/.test(base)) return true;
  if (base.startsWith('custom:')) return base.length > 'custom:'.length;
  const prefix = SAFE_KEY_PREFIXES.find((item) => base.startsWith(item));
  return prefix ? SAFE_KEY.test(base.slice(prefix.length)) : false;
}

/**
 * 按上限整理输出：键不合规的字段丢弃（如自定义属性名含控制字符），过长的值截断，超出字段数或总长度的字段丢弃。
 * 正常文档不会触发；规则与 worker 的校验相同，worker 只在沙箱输出被篡改时拒绝。
 */
export function finalizeMetadataFields(fields) {
  const result = [];
  let total = 0;
  for (const [key, rawValue] of fields.entries()) {
    if (result.length >= METADATA_LIMITS.maxFields) break;
    if (!isDocumentMetadataKey(key) || WORKER_METADATA_KEYS.includes(key)) continue;
    // 值已在写入时规范化（addField；addListField 以“；”连接），这里不再规范化，只截断过长的值。
    let value = String(rawValue);
    if (value.length > METADATA_LIMITS.maxValueLength) value = value.slice(0, METADATA_LIMITS.maxValueLength).replace(/[\ud800-\udbff]$/, '');
    if (!value.trim() || CONTROL_CHARACTERS.test(value)) continue;
    if (key === 'metadata_error' && !isMetadataErrorValue(value)) continue;
    if (total + key.length + value.length > METADATA_LIMITS.maxTotalLength) continue;
    total += key.length + value.length;
    result.push([key, value]);
  }
  return result;
}

/** metadata_error 只能是固定文字的组合（桌面版老式 Word 以“；”连接两类失败）。 */
export function isMetadataErrorValue(value) {
  return value === METADATA_ERRORS.failed
    || value === METADATA_ERRORS.ole
    || value === METADATA_ERRORS.convertedDocx
    || value === `${METADATA_ERRORS.ole};${METADATA_ERRORS.convertedDocx}`;
}

/**
 * 按分派的格式提取元数据，返回 metadata.json 的内容（{ version: 1, fields: [[键, 值], …] }，按桌面版的字段顺序）。
 * 读取失败不抛出，记为 metadata_error（与桌面版相同，其余字段照常输出）。
 * @param {{ format: string, buffer: Buffer, cfb: object,
 *   readPdfInfo: (buffer: Buffer) => Promise<object>, toDocx: (format: string, buffer: Buffer) => Promise<Buffer> }} input
 */
export async function extractDocumentMetadata({ format, buffer, cfb, readPdfInfo, toDocx }) {
  const fields = new Map();
  try {
    if (format === 'docx') mergeMetadataFields(fields, await extractDocxMetadata(buffer));
    else if (format === 'word-ole' || WORD_TEXT_FORMATS.includes(format)) {
      mergeMetadataFields(fields, await extractLegacyWordMetadata(buffer, { ole: format === 'word-ole', cfb, toDocx: () => toDocx(format, buffer) }));
    } else if (format === 'pdf') mergeMetadataFields(fields, await extractPdfMetadata(buffer, readPdfInfo));
  } catch {
    addField(fields, 'metadata_error', METADATA_ERRORS.failed);
  }
  return { version: 1, fields: finalizeMetadataFields(fields) };
}
