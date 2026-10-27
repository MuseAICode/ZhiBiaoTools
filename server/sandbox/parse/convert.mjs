// 文档转 Markdown（parse 沙箱中运行，由 entry.mjs 调用）。转换逻辑搬自桌面版 client/electron/services/doc2markdown/convert.mjs，
// 尽量保持输出一致；与桌面版的差别：
// - 格式由 worker 按上传时记录的 MIME 分派（docs/MIGRATION_PLAN.md 第 6 步“按记录的 MIME 分派”），不再按扩展名或文件头猜测；
// - 只读内存中的原件字节，不读取原件旁的其他文件（桌面版 Markdown 会内联同目录的图片）；
// - 老式 Word（OLE 的 .doc / .wps）只用 LibreOffice 转换（没有 WPS / Word 的 COM 组件），转换出的 docx 同样做 ZIP 检查；
// - docx、xlsx 先做 ZIP 炸弹检查（zipGuard.mjs），PDF 先检查页数上限；
// - 图片交给 imageSink 写进 /output/images，Markdown 中只引用 images/ 下的相对路径，其他图片丢弃。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as cheerio from 'cheerio';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { getDocument, OPS, PDFWorker, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfJsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';
import * as XLSX from 'xlsx';

import { assertSafeZip } from './zipGuard.mjs';

/** PDF 页数上限（决定事项第 5 项）。 */
export const PDF_MAX_PAGES = 3_000;
/** LibreOffice 转换的墙钟上限；整个解析命令另受模板的 10 分钟上限约束。 */
const OFFICE_CONVERSION_TIMEOUT_MS = 8 * 60_000;
const MARKDOWN_IMAGE_PATTERN = /!\[(?<alt>[^\]]*)\]\((?<target><[^>]+>|[^)\s]+)(?<title>\s+"[^"]*")?\)/gi;
const SPREADSHEET_TABLE_CHUNK_ROWS = 200;
const PDF_POINT_TOLERANCE = 2.5;
const PDF_GRID_MIN_LINE_LENGTH = 12;
const PDF_GRID_MIN_WIDTH = 40;
const PDF_GRID_MIN_HEIGHT = 12;
const PDF_TEXT_DUPLICATE_TOLERANCE = 1;
const PDF_TEXT_LINE_TOLERANCE = 3;

const { gfm } = turndownPluginGfm;
const PDF_OP_NAMES = Object.fromEntries(Object.entries(OPS).map(([name, value]) => [value, name]));
const PDF_JS_TABLE_WORKER = createPdfJsTableWorker();
const requireCjs = createRequire(import.meta.url);
const PDF_JS_PACKAGE_DIR = path.dirname(requireCjs.resolve('pdfjs-dist/package.json'));

export class ConversionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
  }
}

/**
 * 按分派结果转换。
 * @param {{ format: 'pdf' | 'docx' | 'xlsx' | 'word-ole' | 'xls-ole' | 'text' | 'markdown', buffer: Buffer, charset?: string,
 *   imageSink?: ((image: { buffer: Buffer, mime: string }) => Promise<string>) | null }} input
 *   imageSink 返回 Markdown 中引用的相对路径；返回空字符串表示丢弃该图片。为 null 时不提取图片。
 */
export async function convertToMarkdown({ format, buffer, charset, imageSink = null }) {
  switch (format) {
    case 'pdf':
      return convertPdf(buffer, imageSink);
    case 'docx':
      await assertSafeZip(buffer);
      return convertDocx(buffer, imageSink);
    case 'word-ole':
      return convertDocx(await convertLegacyWordToDocx(buffer), imageSink);
    case 'xlsx':
      await assertSafeZip(buffer);
      return convertSpreadsheet(buffer);
    case 'xls-ole':
      return convertSpreadsheet(buffer);
    case 'text':
      return ensureTrailingNewline(decodeText(buffer, charset).trimEnd());
    case 'markdown':
      // 桌面版不保留图片时去掉 Markdown 中的图片；沙箱中没有原件旁的文件，远程图片也不跟随，一律去掉。
      return ensureTrailingNewline(stripMarkdownImages(decodeText(buffer, charset)).trimEnd());
    default:
      throw new ConversionError('unsupported_format', '不支持的文件格式');
  }
}

/** 按上传时记录的编码（UTF-8 或 GB18030）解码，非法字节即失败，不猜测编码。 */
function decodeText(buffer, charset) {
  if (charset !== 'utf-8' && charset !== 'gb18030') throw new ConversionError('unsupported_format', '不支持的文本编码');
  let text;
  try {
    text = new TextDecoder(charset, { fatal: true }).decode(buffer);
  } catch {
    throw new ConversionError('text_decode_failed', '文本编码不正确');
  }
  return normalizeNewlinesOnly(text.replace(/^﻿/, '').replace(/\u0000/g, ''));
}

function convertSpreadsheet(buffer) {
  const workbook = readSpreadsheetWorkbook(buffer);
  const sheetNames = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];
  if (sheetNames.length === 0) {
    throw new ConversionError('spreadsheet_empty', 'Excel 文件未包含工作表');
  }

  // 桌面版以文件名作一级标题；沙箱中不知道文件名，标题由 worker 按登记的文件名加上。
  const parts = [];
  for (const sheetName of sheetNames) {
    const worksheet = workbook.Sheets?.[sheetName];
    const rows = extractSpreadsheetRows(worksheet);
    parts.push(`## 工作表：${cleanMarkdownHeading(sheetName)}`);

    if (rows.length === 0) {
      parts.push('> 该工作表为空。');
      continue;
    }

    const width = Math.max(...rows.map((row) => row.length));
    parts.push(`> ${rows.length} 行 x ${width} 列。`);
    parts.push(renderSpreadsheetRows(rows));
  }

  return normalizeGeneratedMarkdown(parts.join('\n\n'));
}

// 从内存中的字节读取；不读取任何外部文件或链接。
function readSpreadsheetWorkbook(buffer) {
  const xlsx = getXlsxModule();
  return xlsx.read(buffer, {
    type: 'buffer',
    cellDates: true,
    cellNF: true,
    cellStyles: false,
    cellText: true,
  });
}

function getXlsxModule() {
  return XLSX.read ? XLSX : XLSX.default;
}

function extractSpreadsheetRows(worksheet) {
  if (!worksheet?.['!ref']) {
    return [];
  }

  const xlsx = getXlsxModule();
  let range;
  try {
    range = xlsx.utils.decode_range(worksheet['!ref']);
  } catch {
    return [];
  }

  const rows = [];
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const row = [];
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const address = xlsx.utils.encode_cell({ r: rowIndex, c: columnIndex });
      row.push(getSpreadsheetCellText(worksheet[address]));
    }
    rows.push(row);
  }

  fillSpreadsheetMergedCells(rows, worksheet['!merges'], range);
  return trimSpreadsheetRows(rows);
}

function getSpreadsheetCellText(cell) {
  if (!cell) {
    return '';
  }
  if (cell.w !== undefined && cell.w !== null && String(cell.w).trim()) {
    return normalizeSpreadsheetCell(cell.w);
  }
  if (cell.v === undefined || cell.v === null) {
    return '';
  }
  if (cell.v instanceof Date) {
    return formatSpreadsheetDate(cell.v);
  }
  if (typeof cell.v === 'boolean') {
    return cell.v ? 'TRUE' : 'FALSE';
  }
  return normalizeSpreadsheetCell(cell.v);
}

function formatSpreadsheetDate(value) {
  const pad = (item) => String(item).padStart(2, '0');
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  return time === '00:00:00' ? date : `${date} ${time}`;
}

function normalizeSpreadsheetCell(value) {
  return normalizeNewlinesOnly(String(value ?? ''))
    .replace(/\u0000/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

function fillSpreadsheetMergedCells(rows, merges, range) {
  if (!Array.isArray(merges) || rows.length === 0) {
    return;
  }

  for (const merge of merges) {
    const startRow = merge.s.r - range.s.r;
    const endRow = merge.e.r - range.s.r;
    const startColumn = merge.s.c - range.s.c;
    const endColumn = merge.e.c - range.s.c;
    const value = rows[startRow]?.[startColumn] || '';
    if (!value) {
      continue;
    }

    for (let rowIndex = Math.max(0, startRow); rowIndex <= Math.min(rows.length - 1, endRow); rowIndex += 1) {
      for (let columnIndex = Math.max(0, startColumn); columnIndex <= Math.min(rows[rowIndex].length - 1, endColumn); columnIndex += 1) {
        if (!rows[rowIndex][columnIndex]) {
          rows[rowIndex][columnIndex] = value;
        }
      }
    }
  }
}

function trimSpreadsheetRows(rows) {
  const nonEmptyRowIndexes = [];
  const nonEmptyColumns = new Set();
  rows.forEach((row, rowIndex) => {
    let hasContent = false;
    row.forEach((cell, columnIndex) => {
      if (cell) {
        hasContent = true;
        nonEmptyColumns.add(columnIndex);
      }
    });
    if (hasContent) {
      nonEmptyRowIndexes.push(rowIndex);
    }
  });

  if (nonEmptyRowIndexes.length === 0 || nonEmptyColumns.size === 0) {
    return [];
  }

  const firstRow = nonEmptyRowIndexes[0];
  const lastRow = nonEmptyRowIndexes[nonEmptyRowIndexes.length - 1];
  const firstColumn = Math.min(...nonEmptyColumns);
  const lastColumn = Math.max(...nonEmptyColumns);
  return rows
    .slice(firstRow, lastRow + 1)
    .map((row) => row.slice(firstColumn, lastColumn + 1))
    .filter((row) => row.some((cell) => cell));
}

function renderSpreadsheetRows(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => row.concat(Array(Math.max(0, width - row.length)).fill('')));
  const headerIndex = findSpreadsheetHeaderIndex(normalizedRows);
  const headerStart = headerIndex >= 0 ? findSpreadsheetHeaderStart(normalizedRows, headerIndex) : -1;
  const notes = headerStart > 0 ? normalizedRows.slice(0, headerStart).map(renderSpreadsheetNote).filter(Boolean) : [];
  const headerRows = headerIndex >= 0 ? normalizedRows.slice(headerStart, headerIndex + 1) : [];
  const header = headerRows.length > 0 ? buildSpreadsheetHeader(headerRows, width) : buildGenericSpreadsheetHeader(width);
  const bodyRows = headerIndex >= 0 ? normalizedRows.slice(headerIndex + 1) : normalizedRows;
  const parts = [];

  if (notes.length > 0) {
    parts.push(notes.map((note) => `> 表格说明：${note}`).join('\n'));
  }
  parts.push(renderSpreadsheetTables(header, bodyRows));
  return parts.filter(Boolean).join('\n\n');
}

function findSpreadsheetHeaderIndex(rows) {
  const scanCount = Math.min(rows.length, 20);
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < scanCount; index += 1) {
    const score = countDistinctSpreadsheetValues(rows[index]);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? bestIndex : -1;
}

function findSpreadsheetHeaderStart(rows, headerIndex) {
  let start = headerIndex;
  const headerCellCount = countNonEmptySpreadsheetCells(rows[headerIndex]);
  const minRelatedCellCount = Math.max(3, Math.ceil(headerCellCount * 0.75));
  for (let index = headerIndex - 1; index >= 0 && index >= headerIndex - 2; index -= 1) {
    if (countDistinctSpreadsheetValues(rows[index]) < 2 || countNonEmptySpreadsheetCells(rows[index]) < minRelatedCellCount) {
      break;
    }
    start = index;
  }
  return start;
}

function countNonEmptySpreadsheetCells(row) {
  return (row || []).filter((cell) => String(cell || '').trim()).length;
}

function countDistinctSpreadsheetValues(row) {
  return dedupeSpreadsheetValues(row).length;
}

function dedupeSpreadsheetValues(row) {
  const values = [];
  const seen = new Set();
  for (const cell of row || []) {
    const value = String(cell || '').trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return values;
}

function renderSpreadsheetNote(row) {
  return dedupeSpreadsheetValues(row).join('；');
}

function buildSpreadsheetHeader(headerRows, width) {
  const header = [];
  for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
    const values = [];
    for (const row of headerRows) {
      const value = String(row[columnIndex] || '').trim();
      if (value && values[values.length - 1] !== value) {
        values.push(value);
      }
    }
    header.push(values.length > 0 ? values.join(' / ') : `列${columnIndex + 1}`);
  }
  return header;
}

function buildGenericSpreadsheetHeader(width) {
  return Array.from({ length: width }, (_, index) => `列${index + 1}`);
}

function renderSpreadsheetTables(header, bodyRows) {
  const totalChunks = Math.max(1, Math.ceil(bodyRows.length / SPREADSHEET_TABLE_CHUNK_ROWS));
  const chunks = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const chunkRows = bodyRows.slice(index * SPREADSHEET_TABLE_CHUNK_ROWS, (index + 1) * SPREADSHEET_TABLE_CHUNK_ROWS);
    const lines = [];
    if (totalChunks > 1) {
      lines.push(`### 表格分段 ${index + 1}/${totalChunks}`);
      lines.push('');
    }
    lines.push(renderMarkdownTableRow(header));
    lines.push(renderMarkdownTableRow(Array(header.length).fill('---')));
    for (const row of chunkRows) {
      lines.push(renderMarkdownTableRow(row));
    }
    chunks.push(lines.join('\n'));
  }
  return chunks.join('\n\n');
}

function cleanMarkdownHeading(value) {
  return String(value || '未命名')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '未命名';
}


async function convertDocx(buffer, imageSink) {
  const result = await mammoth.convertToHtml(
    { buffer },
    { convertImage: buildMammothImageConverter(imageSink) }
  );
  const html = cleanHtml(result.value, Boolean(imageSink));
  const { html: htmlWithoutTables, placeholders } = preserveTables(html);
  let markdown = htmlToMarkdown(htmlWithoutTables);
  markdown = restoreTables(markdown, placeholders);
  return normalizeGeneratedMarkdown(imageSink ? markdown : stripMarkdownImages(markdown));
}

function buildMammothImageConverter(imageSink) {
  return mammoth.images.imgElement(async (image) => {
    if (!imageSink) {
      return { src: '' };
    }
    const buffer = await image.readAsBuffer();
    return { src: (await imageSink({ buffer, mime: String(image.contentType || '') })) || '' };
  });
}

function cleanHtml(html, includeImages) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $('a').each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr('href') || '';
    if (!anchor.text().trim() && anchor.find('img').length === 0) {
      anchor.remove();
      return;
    }
    if (href.startsWith('#')) {
      anchor.replaceWith(anchor.contents());
    }
  });

  $('img').each((_, element) => {
    const image = $(element);
    if (!image.attr('src')) {
      image.remove();
    }
  });

  if (!includeImages) {
    $('img').remove();
  }

  return $.root().html() || '';
}

function htmlToMarkdown(html) {
  const turndownService = new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
  });
  turndownService.use(gfm);
  return turndownService.turndown(html);
}

function preserveTables(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const placeholders = new Map();
  $('table').each((index, element) => {
    const placeholder = `TABLEPLACEHOLDER${String(index + 1).padStart(4, '0')}`;
    placeholders.set(placeholder, $.html(element));
    $(element).replaceWith(placeholder);
  });
  return { html: $.root().html() || '', placeholders };
}

function restoreTables(markdown, placeholders) {
  let restored = markdown;
  for (const [placeholder, tableHtml] of placeholders.entries()) {
    restored = restored.replaceAll(placeholder, `\n\n${tableHtml}\n\n`);
  }
  return restored;
}

async function convertPdf(buffer, imageSink) {
  await assertPdfPageCount(buffer);
  const parser = new PDFParse({ data: buffer });

  try {
    const textResult = await parser.getText({ parseHyperlinks: true });
    const tableResult = await safePdfCall(() => parser.getTable());
    const pdfJsTableResult = await safePdfCall(() => extractPdfJsTables(buffer));
    const imageResult = imageSink ? await safePdfCall(() => parser.getImage()) : null;
    const markdown = await renderPdfMarkdown(textResult, tableResult, pdfJsTableResult, imageResult, imageSink);

    if (!hasInformativeText(markdown)) {
      throw new ConversionError('pdf_text_layer_missing', 'PDF 未检测到可选中文字层');
    }

    return normalizeGeneratedMarkdown(markdown);
  } finally {
    await parser.destroy();
  }
}

/** 解析前先只读出页数，超过上限即拒绝，不逐页解析。 */
async function assertPdfPageCount(buffer) {
  const loadingTask = getDocument({ data: new Uint8Array(buffer), worker: PDF_JS_TABLE_WORKER, verbosity: VerbosityLevel.ERRORS });
  let pages;
  try {
    pages = (await loadingTask.promise).numPages;
  } catch {
    throw new ConversionError('pdf_invalid', 'PDF 文件无法读取');
  } finally {
    await loadingTask.destroy();
  }
  if (!(pages >= 1)) throw new ConversionError('pdf_invalid', 'PDF 文件无法读取');
  if (pages > PDF_MAX_PAGES) throw new ConversionError('pdf_too_many_pages', 'PDF 页数超过上限');
}

async function safePdfCall(callback) {
  try {
    return await callback();
  } catch {
    return null;
  }
}

async function extractPdfJsTables(buffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    worker: PDF_JS_TABLE_WORKER,
    // 中文 PDF 常用非嵌入字体，缺 CMap / 标准字体数据时 pdfjs 取不到文字。
    cMapUrl: `${path.join(PDF_JS_PACKAGE_DIR, 'cmaps')}${path.sep}`,
    standardFontDataUrl: `${path.join(PDF_JS_PACKAGE_DIR, 'standard_fonts')}${path.sep}`,
    verbosity: VerbosityLevel.ERRORS,
  });
  const document = await loadingTask.promise;

  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const [textContent, operatorList] = await Promise.all([
        page.getTextContent(),
        page.getOperatorList(),
      ]);
      const textItems = normalizePdfJsTextItems(textContent.items || []);
      const rectangles = extractPdfJsRectangles(operatorList);
      pages.push({ tables: buildPdfJsTables(rectangles, textItems) });
    }
    return { pages };
  } finally {
    // pdfjs 6 去掉了 PDFDocumentProxy.destroy()，改由 loadingTask 销毁；传入的共享 worker 不会随之销毁。
    await loadingTask.destroy();
  }
}

// pdf-parse 内置 pdfjs 5.4.296，与这里直接依赖的 pdfjs 共用 globalThis.pdfjsWorker：
// 哪一份 pdfjs 先创建 fake worker，就会缓存当时的全局 worker，另一份随后报 API / Worker 版本不一致。
// 导入 pdf.worker.mjs 时它会把自己写进全局；这里在模块加载的同一同步段内用它建好本模块专用的 PDFWorker，
// 然后清掉全局，让 pdf-parse 首次使用时照常加载自己的 worker（已初始化过的 pdf-parse 不受影响）。
function createPdfJsTableWorker() {
  globalThis.pdfjsWorker = { WorkerMessageHandler: pdfJsWorkerModule.WorkerMessageHandler };
  try {
    return new PDFWorker({ name: 'doc2markdown-pdfjs-tables' });
  } finally {
    delete globalThis.pdfjsWorker;
  }
}

function normalizePdfJsTextItems(items) {
  const normalized = items
    .map((item) => {
      const text = collapsePdfWhitespace(item.str || '');
      if (!text) {
        return null;
      }
      const transform = Array.isArray(item.transform) ? item.transform : [];
      const x = Number(transform[4] || 0);
      const y = Number(transform[5] || 0);
      const width = Number(item.width || 0);
      const height = Number(item.height || Math.abs(transform[3] || 0));
      return {
        text,
        x,
        y,
        width,
        height,
        centerX: x + width / 2,
        centerY: y + height / 2,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.y - left.y || left.x - right.x);

  const kept = [];
  for (const item of normalized) {
    const duplicate = kept.some((previous) => previous.text === item.text
      && Math.abs(previous.x - item.x) <= PDF_TEXT_DUPLICATE_TOLERANCE
      && Math.abs(previous.y - item.y) <= PDF_TEXT_DUPLICATE_TOLERANCE);
    if (!duplicate) {
      kept.push(item);
    }
  }
  return kept;
}

function extractPdfJsRectangles(operatorList) {
  const rectangles = [];
  const stack = [];
  let matrix = [1, 0, 0, 1, 0, 0];

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const name = PDF_OP_NAMES[operatorList.fnArray[index]];
    const args = operatorList.argsArray[index];

    if (name === 'save') {
      stack.push(matrix.slice());
    } else if (name === 'restore') {
      matrix = stack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (name === 'transform') {
      matrix = multiplyPdfMatrix(matrix, args || [1, 0, 0, 1, 0, 0]);
    } else if (name === 'constructPath') {
      rectangles.push(...extractPdfJsPathRectangles(args?.[1] || [], matrix));
    }
  }

  return rectangles;
}

function multiplyPdfMatrix(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function transformPdfPoint(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function extractPdfJsPathRectangles(paths, matrix) {
  const rectangles = [];
  for (const pathChunk of paths) {
    if (!pathChunk) {
      continue;
    }
    const points = [];
    for (let index = 0; index < pathChunk.length;) {
      const op = pathChunk[index];
      index += 1;
      if (op === 0 || op === 1) {
        points.push(transformPdfPoint(matrix, pathChunk[index], pathChunk[index + 1]));
        index += 2;
      } else if (op === 3) {
        // closePath has no coordinates.
      } else {
        break;
      }
    }

    if (points.length < 2) {
      continue;
    }
    const xValues = points.map((point) => point.x);
    const yValues = points.map((point) => point.y);
    const x1 = Math.min(...xValues);
    const x2 = Math.max(...xValues);
    const y1 = Math.min(...yValues);
    const y2 = Math.max(...yValues);
    rectangles.push({
      x1,
      x2,
      y1,
      y2,
      width: x2 - x1,
      height: y2 - y1,
    });
  }
  return rectangles;
}

function buildPdfJsTables(rectangles, textItems) {
  const horizontalLines = [];
  const verticalLines = [];

  for (const rectangle of rectangles) {
    if (rectangle.width >= PDF_GRID_MIN_LINE_LENGTH && rectangle.height <= PDF_POINT_TOLERANCE) {
      horizontalLines.push({
        x1: rectangle.x1,
        x2: rectangle.x2,
        y: (rectangle.y1 + rectangle.y2) / 2,
      });
    }
    if (rectangle.height >= PDF_GRID_MIN_LINE_LENGTH && rectangle.width <= PDF_POINT_TOLERANCE) {
      verticalLines.push({
        x: (rectangle.x1 + rectangle.x2) / 2,
        y1: rectangle.y1,
        y2: rectangle.y2,
      });
    }
  }

  return buildPdfJsLineComponents(horizontalLines, verticalLines)
    .map((component) => buildPdfJsTableFromComponent(component, textItems))
    .filter(Boolean)
    .sort((left, right) => right.bounds.y2 - left.bounds.y2 || left.bounds.x1 - right.bounds.x1)
    .map((table) => table.rows);
}

function buildPdfJsLineComponents(horizontalLines, verticalLines) {
  const lines = [
    ...horizontalLines.map((line) => ({ kind: 'h', line })),
    ...verticalLines.map((line) => ({ kind: 'v', line })),
  ];
  const parent = lines.map((_, index) => index);

  for (let hIndex = 0; hIndex < horizontalLines.length; hIndex += 1) {
    for (let vIndex = 0; vIndex < verticalLines.length; vIndex += 1) {
      if (pdfJsLinesIntersect(horizontalLines[hIndex], verticalLines[vIndex])) {
        union(parent, hIndex, horizontalLines.length + vIndex);
      }
    }
  }

  const groups = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const root = find(parent, index);
    if (!groups.has(root)) {
      groups.set(root, { horizontalLines: [], verticalLines: [] });
    }
    const group = groups.get(root);
    if (lines[index].kind === 'h') {
      group.horizontalLines.push(lines[index].line);
    } else {
      group.verticalLines.push(lines[index].line);
    }
  }

  return [...groups.values()];
}

function pdfJsLinesIntersect(horizontalLine, verticalLine) {
  return verticalLine.x >= horizontalLine.x1 - PDF_POINT_TOLERANCE
    && verticalLine.x <= horizontalLine.x2 + PDF_POINT_TOLERANCE
    && horizontalLine.y >= verticalLine.y1 - PDF_POINT_TOLERANCE
    && horizontalLine.y <= verticalLine.y2 + PDF_POINT_TOLERANCE;
}

function find(parent, index) {
  if (parent[index] !== index) {
    parent[index] = find(parent, parent[index]);
  }
  return parent[index];
}

function union(parent, left, right) {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);
  if (leftRoot !== rightRoot) {
    parent[rightRoot] = leftRoot;
  }
}

function buildPdfJsTableFromComponent(component, textItems) {
  const xCoordinates = clusterPdfCoordinates(component.verticalLines.map((line) => line.x)).sort((left, right) => left - right);
  const yCoordinates = clusterPdfCoordinates(component.horizontalLines.map((line) => line.y)).sort((left, right) => right - left);
  if (xCoordinates.length < 2 || yCoordinates.length < 2) {
    return null;
  }

  const bounds = {
    x1: xCoordinates[0],
    x2: xCoordinates[xCoordinates.length - 1],
    y1: yCoordinates[yCoordinates.length - 1],
    y2: yCoordinates[0],
  };
  if (bounds.x2 - bounds.x1 < PDF_GRID_MIN_WIDTH || bounds.y2 - bounds.y1 < PDF_GRID_MIN_HEIGHT) {
    return null;
  }

  const rows = [];
  for (let rowIndex = 0; rowIndex < yCoordinates.length - 1; rowIndex += 1) {
    const top = yCoordinates[rowIndex];
    const bottom = yCoordinates[rowIndex + 1];
    const row = [];
    for (let columnIndex = 0; columnIndex < xCoordinates.length - 1; columnIndex += 1) {
      const left = xCoordinates[columnIndex];
      const right = xCoordinates[columnIndex + 1];
      const cellItems = textItems.filter((item) => item.centerX >= left - PDF_POINT_TOLERANCE
        && item.centerX <= right + PDF_POINT_TOLERANCE
        && item.centerY <= top + PDF_POINT_TOLERANCE
        && item.centerY >= bottom - PDF_POINT_TOLERANCE);
      row.push(renderPdfJsCellText(cellItems));
    }
    rows.push(row);
  }

  const nonEmptyCells = rows.flat().filter(Boolean).length;
  if (nonEmptyCells < 2) {
    return null;
  }
  return { bounds, rows };
}

function clusterPdfCoordinates(values) {
  const sortedValues = [...values].sort((left, right) => left - right);
  const clusters = [];
  for (const value of sortedValues) {
    const previous = clusters[clusters.length - 1];
    if (previous && Math.abs(previous.values[previous.values.length - 1] - value) <= PDF_POINT_TOLERANCE) {
      previous.values.push(value);
    } else {
      clusters.push({ values: [value] });
    }
  }
  return clusters.map((cluster) => cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length);
}

function renderPdfJsCellText(items) {
  if (items.length === 0) {
    return '';
  }

  const lines = [];
  for (const item of [...items].sort((left, right) => right.y - left.y || left.x - right.x)) {
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= PDF_TEXT_LINE_TOLERANCE);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }

  return lines
    .sort((left, right) => right.y - left.y)
    .map((line) => collapsePdfWhitespace(line.items
      .sort((left, right) => left.x - right.x)
      .map((item) => item.text)
      .join('')))
    .filter(Boolean)
    .map((line) => line.replace(/\|/g, '\\|'))
    .join('<br>');
}

async function renderPdfMarkdown(textResult, tableResult, pdfJsTableResult, imageResult, imageSink) {
  const textPages = Array.isArray(textResult?.pages) ? textResult.pages : [];
  const tablePages = Array.isArray(tableResult?.pages) ? tableResult.pages : [];
  const pdfJsTablePages = Array.isArray(pdfJsTableResult?.pages) ? pdfJsTableResult.pages : [];
  const imagePages = Array.isArray(imageResult?.pages) ? imageResult.pages : [];
  const pageCount = Math.max(textPages.length, tablePages.length, pdfJsTablePages.length, imagePages.length, 1);
  const parts = [];

  for (let index = 0; index < pageCount; index += 1) {
    const pageParts = [];
    const pageText = normalizePdfPlainText(textPages[index]?.text || '');
    const tables = [
      ...(tablePages[index]?.tables || []),
      ...(pdfJsTablePages[index]?.tables || []),
    ];
    const tableMarkdownList = [];
    for (const table of tables) {
      const tableMarkdown = renderMarkdownTable(table);
      if (tableMarkdown && !hasSimilarPdfTable(tableMarkdownList, tableMarkdown)) {
        tableMarkdownList.push(tableMarkdown);
      }
    }

    const dedupedText = removePdfTableDuplicateText(pageText, tableMarkdownList);
    if (dedupedText) {
      pageParts.push(dedupedText);
    }
    pageParts.push(...tableMarkdownList);

    if (imageSink) {
      const images = imagePages[index]?.images || [];
      for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
        const image = parseDataUrl(images[imageIndex]?.dataUrl);
        const target = image ? await imageSink(image) : '';
        if (target) {
          pageParts.push(`![Page ${index + 1} Image ${imageIndex + 1}](${target})`);
        }
      }
    }

    if (pageParts.length > 0) {
      parts.push(pageParts.join('\n\n'));
    }
  }

  if (parts.length === 0 && textResult?.text) {
    return normalizePdfPlainText(textResult.text);
  }
  return parts.join('\n\n');
}

function removePdfTableDuplicateText(pageText, tableMarkdownList) {
  if (!pageText || tableMarkdownList.length === 0) {
    return pageText;
  }

  const tableProbe = compactForDedup(tableMarkdownList.join('\n'));
  const keptLines = [];
  for (const line of pageText.split('\n')) {
    const trimmed = collapsePdfWhitespace(line);
    if (!trimmed) {
      continue;
    }
    const probe = compactForDedup(trimmed);
    if (!probe) {
      continue;
    }
    const collapsedProbe = collapseRepeatedPdfProbe(probe);
    if (isPdfLineCoveredByTables(probe, tableProbe)
      || (collapsedProbe !== probe && isPdfLineCoveredByTables(collapsedProbe, tableProbe))) {
      continue;
    }
    keptLines.push(trimmed);
  }

  return keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hasSimilarPdfTable(existingTables, nextTable) {
  const nextProbe = compactForDedup(nextTable);
  if (!nextProbe) {
    return true;
  }
  return existingTables.some((table) => {
    const probe = compactForDedup(table);
    if (!probe) {
      return false;
    }
    return probe.includes(nextProbe) || nextProbe.includes(probe);
  });
}

function isPdfLineCoveredByTables(lineProbe, tableProbe) {
  if (lineProbe.length <= 2) {
    return tableProbe.includes(lineProbe);
  }
  if (tableProbe.includes(lineProbe)) {
    return true;
  }
  if (lineProbe.length < 8) {
    return false;
  }

  const chunkSize = Math.min(12, Math.max(6, Math.floor(lineProbe.length / 2)));
  let covered = 0;
  let total = 0;
  for (let index = 0; index < lineProbe.length; index += chunkSize) {
    const chunk = lineProbe.slice(index, index + chunkSize);
    if (chunk.length < 4) {
      continue;
    }
    total += 1;
    if (tableProbe.includes(chunk)) {
      covered += 1;
    }
  }
  return total > 0 && covered / total >= 0.75;
}

function compactForDedup(text) {
  return String(text || '')
    .replace(/<br\s*\/?\s*>/gi, '')
    .replace(/[|\\`*_#\-\s，。；：！？、,.!:;?%（）()\[\]{}《》<>]/g, '')
    .toLowerCase();
}

function renderMarkdownTable(table) {
  const rows = normalizePdfTableRows(table);
  if (rows.length === 0) {
    return '';
  }

  const width = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => row.concat(Array(Math.max(0, width - row.length)).fill('')));
  const header = normalizedRows[0];
  const body = normalizedRows.slice(1);
  const lines = [renderMarkdownTableRow(header), renderMarkdownTableRow(Array(width).fill('---'))];
  for (const row of body) {
    lines.push(renderMarkdownTableRow(row));
  }
  return lines.join('\n');
}

function normalizePdfTableRows(table) {
  if (!Array.isArray(table)) {
    return [];
  }
  return table
    .map((row) => (Array.isArray(row) ? row : []))
    .map((row) => row.map((cell) => normalizeTableCell(cell)))
    .filter((row) => row.some((cell) => cell));
}

function normalizeTableCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return collapsePdfWhitespace(String(value).replace(/\n+/g, '<br>')).replace(/\|/g, '\\|');
}

function renderMarkdownTableRow(row) {
  return `|${row.join('|')}|`;
}

/**
 * 老式 Word（OLE 的 .doc / .wps）经 LibreOffice 转成 docx。LibreOffice 的宏、链接更新等全局设置在镜像中
 * （libreoffice/zhibiao-security.xcd，finalized，用户配置不能覆盖）；每次转换新建临时用户配置，用完删除。
 */
async function convertLegacyWordToDocx(buffer) {
  const workDir = await mkdtemp('/tmp/office-');
  try {
    const inputDir = path.join(workDir, 'in');
    const outputDir = path.join(workDir, 'out');
    await mkdir(inputDir);
    await mkdir(outputDir);
    const input = path.join(inputDir, 'source.doc');
    await writeFile(input, buffer);
    try {
      await runProcess('soffice', [
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nologo',
        '--nodefault',
        '--nofirststartwizard',
        `-env:UserInstallation=${pathToFileURL(path.join(workDir, 'profile')).href}`,
        '--convert-to',
        'docx:MS Word 2007 XML',
        '--outdir',
        outputDir,
        input,
      ], { timeoutMs: OFFICE_CONVERSION_TIMEOUT_MS });
    } catch {
      throw new ConversionError('office_conversion_failed', 'LibreOffice 转换失败');
    }
    const docxName = (await readdir(outputDir)).find((file) => path.extname(file).toLowerCase() === '.docx');
    if (!docxName) {
      throw new ConversionError('office_conversion_failed', 'LibreOffice 未生成 DOCX 文件');
    }
    const docx = await readFile(path.join(outputDir, docxName));
    // 转换产物同样做 ZIP 检查（路线图第 6 步分派表）。
    await assertSafeZip(docx);
    return docx;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'], env: { HOME: '/tmp', LANG: 'C.UTF-8', TMPDIR: '/tmp', PATH: '/usr/bin:/bin' } });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`command timed out: ${command}`));
    }, options.timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`command failed (${code}): ${command}`));
    });
  });
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(value || ''));
  if (!match) return null;
  return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
}

function normalizePdfPlainText(text) {
  const lines = normalizeNewlinesOnly(String(text || '').replace(/\f/g, '\n\n'))
    .split('\n')
    .map((line) => collapseRepeatedPdfText(collapsePdfWhitespace(line)));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function collapseRepeatedPdfText(text) {
  return collapseRepeatedPdfChunks(text, 2, true)
    .replace(/([\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9（）()：:、，,。.．\-]{1,29})\s+\1/g, '$1')
    .replace(/^([一二三四五六七八九十])\1(?=[.、．])/u, '$1');
}

function collapseRepeatedPdfProbe(text) {
  return collapseRepeatedPdfChunks(text, 1, false);
}

function collapseRepeatedPdfChunks(text, minLength, requireCjk) {
  let result = text;
  let changed = true;
  let rounds = 0;
  while (changed && rounds < 4) {
    changed = false;
    rounds += 1;
    const maxLength = Math.min(30, Math.floor(result.length / 2));
    for (let length = minLength; length <= maxLength; length += 1) {
      for (let index = 0; index + length * 2 <= result.length; index += 1) {
        const chunk = result.slice(index, index + length);
        if (!chunk.trim() || (requireCjk && !/[\u4e00-\u9fff]/.test(chunk))) {
          continue;
        }
        if (chunk === result.slice(index + length, index + length * 2)) {
          result = `${result.slice(0, index + length)}${result.slice(index + length * 2)}`;
          changed = true;
          break;
        }
      }
      if (changed) {
        break;
      }
    }
  }
  return result;
}

function collapsePdfWhitespace(text) {
  return String(text || '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '')
    .replace(/\s+([,.;:!?%])/g, '$1')
    .replace(/\s+([，。；：！？、％])/g, '$1');
}

function hasInformativeText(markdown) {
  const probe = stripMarkdownImages(markdown);
  return /[A-Za-z0-9\u4e00-\u9fff]{10,}/.test(probe.replace(/\s+/g, ''));
}

function normalizeGeneratedMarkdown(markdown) {
  const normalized = normalizeNewlinesOnly(markdown).replace(/\n{3,}/g, '\n\n').trim();
  return ensureTrailingNewline(normalized);
}

function normalizeNewlinesOnly(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function stripMarkdownImages(text) {
  return String(text || '')
    .replace(MARKDOWN_IMAGE_PATTERN, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}
