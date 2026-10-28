// 标书查重的逐文档文本提取（路线图第 6 步 6.10）：在 parse 沙箱中对解析出的 Markdown 提取目录、句子和图片位置，跨文档的比对
// （招标原文白名单、目录分组与两两相似度、重复句、重复图片）在 worker 中进行（server/src/duplicateCheck/analysis.ts）。
// 函数搬自桌面版 duplicateCheckService.cjs，逻辑与常量不变；差异：
// - HTML 表格的文字由调用方传入的 extractTableBlocks 读取（duplicateTables.mjs，cheerio），本文件只用 JavaScript 内置功能，
//   宿主上的单元测试可以直接导入；
// - 目录项不在这里匹配招标原文（需要全部招标文件），由 worker 按 normalizedTitle 匹配后写入 fromTender；
// - 图片位置只收解析输出中的图片（images/image-NNNN.*），远程地址、data: 等在写回 Markdown 时就被去掉，不计入编号；
// - 输出字段改为 camelCase。
// 输入是本沙箱中解析出的 Markdown；输出在 worker 中按不可信输入校验（server/src/duplicateCheck/analysis.ts 的 parseDuplicateAnalysis）。

const markdownImagePattern = /!\[(?<alt>[^\]]*)\]\((?<target><[^>]+>|[^)\s]+)(?<title>\s+"[^"]*")?\)/gi;
const htmlImageSrcPattern = /<img\b[^>]*?\bsrc=["'](?<src>[^"']+)["'][^>]*>/gi;
const htmlImagePattern = /<img\b[^>]*>/gi;
const htmlTablePattern = /<table\b[\s\S]*?<\/table>/gi;
const contentTableTokenPrefix = 'APP_CONTENT_TABLE_';
/** 解析入口写出的图片（与 server/src/parse/output.ts 的 IMAGE_PATH 相同）。 */
const outputImagePath = /^images\/image-\d{4}\.(?:png|jpg|gif|webp|bmp)$/;

export function normalizeValue(value) {
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

// ---- 目录 ----

function stripMarkdownForOutline(markdown) {
  return String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

export function normalizeOutlineTitle(value) {
  return normalizeValue(stripMarkdownForOutline(value))
    .replace(/^(?:#{1,6}\s*)/, '')
    .replace(/^[-*+>]\s*/, '')
    .replace(/^(?:第[一二三四五六七八九十百千万\d]+[章节篇部分]|\d+(?:\.\d+)*[.)、．]?|[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十\d]+）|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])[\s、.．-]*/, '')
    .replace(/[\s　]+/g, '')
    .replace(/[，。！？；：、“”‘’'"《》〈〉（）()\[\]【】{}.,!?;:|/\\_-]+/g, '')
    .toLowerCase();
}

function cleanOutlineTitle(value) {
  return normalizeValue(stripMarkdownForOutline(value))
    .replace(/^(?:#{1,6}\s*)/, '')
    .replace(/^[-*+>]\s*/, '')
    .replace(/(?:\.{2,}|…{2,}|·{2,}|\s{3,})\s*\d+\s*$/g, '')
    .replace(/\s+\d{1,4}\s*$/g, '')
    .trim();
}

/** 招标文件的句子（目录分析的白名单）。多份招标文件由 worker 按顺序合并、按 normalized 去重。 */
export function splitTenderSentences(markdown) {
  const text = stripMarkdownForOutline(markdown)
    .replace(/\|/g, '\n')
    .replace(/\r?\n/g, '\n')
    .replace(/[\t ]+/g, ' ');
  const parts = text
    .split(/[。！？!?；;\n]+/)
    .map((item) => cleanOutlineTitle(item))
    .filter(Boolean);
  const seen = new Set();
  const sentences = [];
  for (const part of parts) {
    const normalized = normalizeOutlineTitle(part);
    if (normalized.length < 6 || normalized.length > 160 || seen.has(normalized)) continue;
    seen.add(normalized);
    sentences.push({ text: part, normalized });
  }
  return sentences;
}

function parseOutlineMarker(line) {
  const text = cleanOutlineTitle(line);
  const patterns = [
    { pattern: /^(?<number>\d+(?:\.\d+)*)(?:[.)、．])?\s*(?<title>.+)$/u },
    { pattern: /^(?<number>第[一二三四五六七八九十百千万\d]+[章节篇部分])\s*(?<title>.*)$/u },
    { pattern: /^(?<number>[一二三四五六七八九十]+[、.．])\s*(?<title>.+)$/u },
    { pattern: /^(?<number>（[一二三四五六七八九十\d]+）)\s*(?<title>.+)$/u },
    { pattern: /^(?<number>[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*(?<title>.+)$/u },
  ];
  for (const { pattern } of patterns) {
    const match = text.match(pattern);
    if (!match?.groups) continue;
    const number = match.groups.number.trim();
    const title = cleanOutlineTitle(match.groups.title || number);
    if (!title || normalizeOutlineTitle(title).length < 2) continue;
    return { number, title, level: inferOutlineLevel(number) };
  }
  return null;
}

function inferOutlineLevel(number) {
  const marker = String(number || '').trim();
  if (/^\d+(?:\.\d+)+/.test(marker)) return marker.split('.').filter(Boolean).length;
  if (/^\d+/.test(marker) || /^第.+[章节篇部分]$/.test(marker) || /^[一二三四五六七八九十]+[、.．]$/.test(marker)) return 1;
  if (/^（.+）$/.test(marker) || /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/.test(marker)) return 2;
  return 1;
}

function isCatalogTitleLine(line) {
  return /^(?:#{1,6}\s*)?(目录|目次|contents)$/i.test(String(line || '').replace(/\s+/g, ''));
}

function parseCatalogLine(line) {
  const raw = cleanOutlineTitle(String(line || '').replace(/^\|+|\|+$/g, '').replace(/\|/g, ' '));
  if (!raw || /^[-:|\s]+$/.test(raw) || isCatalogTitleLine(raw)) return null;
  const hasPageTrail = /(?:\.{2,}|…{2,}|·{2,}|\s{3,})\s*\d+\s*$/.test(raw) || /\s\d{1,4}$/.test(raw);
  const marker = parseOutlineMarker(raw);
  if (marker) return marker;
  if (!hasPageTrail) return null;
  const title = cleanOutlineTitle(raw.replace(/(?:\.{2,}|…{2,}|·{2,}|\s{3,})\s*\d+\s*$/g, '').replace(/\s+\d{1,4}\s*$/g, ''));
  return title && normalizeOutlineTitle(title).length >= 2 ? { title, level: 1 } : null;
}

function extractCatalogOutline(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex(isCatalogTitleLine);
  if (start < 0) return [];
  const items = [];
  let misses = 0;
  for (let index = start + 1; index < Math.min(lines.length, start + 180); index += 1) {
    const parsed = parseCatalogLine(lines[index]);
    if (!parsed) {
      if (items.length) misses += 1;
      if (misses >= 10) break;
      continue;
    }
    misses = 0;
    items.push({ ...parsed, source: 'catalog', confidence: 0.92 });
  }
  return items;
}

function extractHeadingOutline(markdown) {
  const items = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const title = cleanOutlineTitle(match[2]);
    if (!title || isCatalogTitleLine(title)) continue;
    const marker = parseOutlineMarker(title);
    items.push({ number: marker?.number, title: marker?.title || title, level: Math.min(match[1].length, 6), source: 'heading', confidence: 0.82 });
  }
  return items;
}

function extractSemanticOutline(markdown) {
  const items = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (const line of lines) {
    const text = cleanOutlineTitle(line);
    if (!text || text.length > 90 || /[。！？；;]$/.test(text) || /^\|/.test(text) || isCatalogTitleLine(text)) continue;
    const marker = parseOutlineMarker(text);
    const bold = /^\s*\*\*.+\*\*\s*$/.test(line);
    if (!marker && !bold) continue;
    items.push({ number: marker?.number, title: marker?.title || text, level: marker?.level || 2, source: 'semantic', confidence: marker ? 0.68 : 0.55 });
  }
  return items.slice(0, 260);
}

/** 投标文件的目录（桌面版 buildOutlineItems，不含招标原文匹配）。 */
export function buildOutlineItems(markdown) {
  const candidates = [extractCatalogOutline(markdown), extractHeadingOutline(markdown), extractSemanticOutline(markdown)];
  const selected = candidates.find((items) => items.length >= 3) || candidates.find((items) => items.length) || [];
  const stack = [];
  const items = [];
  const seen = new Set();
  for (const candidate of selected) {
    let level = Math.max(1, Math.min(Number(candidate.level) || 1, 6));
    if (level > stack.length + 1) level = stack.length + 1;
    const title = cleanOutlineTitle(candidate.title);
    const normalized = normalizeOutlineTitle(title);
    if (!title || normalized.length < 2) continue;
    const key = `${level}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stack.splice(level - 1);
    const parent = stack[level - 2] || null;
    const pathTitles = [...(parent?.pathTitles || []), title];
    const item = {
      id: `O${String(items.length + 1).padStart(5, '0')}`,
      level,
      number: candidate.number ?? null,
      title,
      normalizedTitle: normalized,
      pathTitles,
      normalizedPath: pathTitles.map(normalizeOutlineTitle).filter(Boolean).join('>'),
      source: candidate.source,
      confidence: candidate.confidence,
      order: items.length,
      parentId: parent?.id ?? null,
    };
    items.push(item);
    stack[level - 1] = item;
  }
  return {
    items,
    source: selected[0]?.source ?? null,
    confidence: selected.length ? Number((selected.reduce((sum, item) => sum + item.confidence, 0) / selected.length).toFixed(2)) : 0,
  };
}

// ---- 正文句子 ----

function stripImagesFromMarkdown(markdown) {
  return String(markdown || '')
    .replace(markdownImagePattern, ' ')
    .replace(htmlImageSrcPattern, ' ')
    .replace(htmlImagePattern, ' ');
}

function codePointToString(value, fallback) {
  try {
    const codePoint = Number.parseInt(value, 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

function hexCodePointToString(value, fallback) {
  try {
    const codePoint = Number.parseInt(value, 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

function decodeBasicHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => hexCodePointToString(hex, match))
    .replace(/&#(\d+);/g, (match, code) => codePointToString(code, match));
}

function normalizeContentLineBreaks(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 把一段文字按行加入文字块（HTML 表格的单元格也经它加入，duplicateTables.mjs）。 */
export function addContentTextBlock(blocks, value) {
  const text = cleanContentSentence(decodeBasicHtmlEntities(value));
  for (const line of normalizeContentLineBreaks(text).split(/\n+/)) {
    const cleaned = cleanContentSentence(line);
    if (cleaned) blocks.push(cleaned);
  }
}

function splitMarkdownTableRow(line) {
  let text = String(line || '').trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);

  const cells = [];
  let current = '';
  let escaped = false;
  for (const char of text) {
    if (char === '\\' && !escaped) {
      escaped = true;
      current += char;
      continue;
    }
    if (char === '|' && !escaped) {
      cells.push(current.replace(/\\\|/g, '|').trim());
      current = '';
      continue;
    }
    current += char;
    escaped = false;
  }
  cells.push(current.replace(/\\\|/g, '|').trim());
  return cells;
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')));
}

function isMarkdownTableRow(line) {
  return splitMarkdownTableRow(line).length > 1;
}

function cleanMarkdownInlineText(value) {
  return decodeBasicHtmlEntities(String(value || '')
    .replace(markdownImagePattern, ' ')
    .replace(htmlImageSrcPattern, ' ')
    .replace(htmlImagePattern, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1'));
}

function cleanMarkdownLine(value) {
  return cleanMarkdownInlineText(value)
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|>)\s+/, '')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function extractMarkdownTextBlocks(markdown) {
  const lines = normalizeContentLineBreaks(String(markdown || '').replace(/```[\s\S]*?```/g, '\n')).split('\n');
  const blocks = [];
  const paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    addContentTextBlock(blocks, paragraph.join(' '));
    paragraph.length = 0;
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (index + 1 < lines.length && isMarkdownTableRow(lines[index]) && isMarkdownTableSeparator(lines[index + 1])) {
      flushParagraph();
      const tableRows = [splitMarkdownTableRow(lines[index])];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        if (!isMarkdownTableSeparator(lines[index])) tableRows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      for (const row of tableRows) {
        for (const cell of row) {
          addContentTextBlock(blocks, cleanMarkdownInlineText(cell));
        }
      }
      continue;
    }

    const rawLine = lines[index];
    const cleaned = cleanMarkdownLine(rawLine);
    if (!cleaned) {
      flushParagraph();
      continue;
    }

    const standalone = /^\s{0,3}#{1,6}\s+/.test(rawLine)
      || /^\s*(?:[-*+]|>)\s+/.test(rawLine)
      || /^\s*(?:\d+(?:\.\d+)*[.)、．]|[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十\d]+）|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s+/.test(rawLine);
    const fieldLine = /^[^：:\s]{1,18}[：:]/.test(cleaned);
    const sentenceLine = /[。！？!?；;]$/.test(cleaned);
    if (standalone || fieldLine || sentenceLine) {
      flushParagraph();
      addContentTextBlock(blocks, cleaned);
    } else {
      paragraph.push(cleaned);
    }
  }
  flushParagraph();
  return blocks;
}

function extractContentTextBlocks(markdown, extractTableBlocks) {
  const source = stripImagesFromMarkdown(markdown);
  const tableBlocks = [];
  const withMarkers = source.replace(htmlTablePattern, (tableHtml) => {
    const index = tableBlocks.length;
    tableBlocks.push(extractTableBlocks(tableHtml));
    return `\n\n${contentTableTokenPrefix}${index}\n\n`;
  });
  const tokenPattern = new RegExp(`(${contentTableTokenPrefix}\\d+)`, 'g');
  const blocks = [];
  for (const chunk of withMarkers.split(tokenPattern)) {
    const tokenMatch = chunk.match(new RegExp(`^${contentTableTokenPrefix}(\\d+)$`));
    if (tokenMatch) {
      blocks.push(...(tableBlocks[Number(tokenMatch[1])] || []));
    } else {
      blocks.push(...extractMarkdownTextBlocks(chunk));
    }
  }
  return blocks;
}

export function normalizeContentSentence(value) {
  return stripLeadingContentSequence(String(value || ''))
    .replace(/^﻿/, '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮﻿]/g, '')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

function stripLeadingContentSequence(value) {
  let text = String(value || '').trim();
  const patterns = [
    /^\s*[\d０-９]+(?:\\?[.．][\d０-９]+)*\s*(?:\\?[.．]|[)）、])\s*/u,
    /^\s*[\d０-９]+(?:\\?[.．][\d０-９]+)*\s+(?=[A-Za-z一-鿿（(])/u,
    /^\s*\((?:[\d０-９]+(?:\\?[.．][\d０-９]+)*|[一二三四五六七八九十百千万]+)\)\s*(?:\\?[.．]|[、])?\s*/u,
    /^\s*[一二三四五六七八九十百千万]+\s*(?:\\?[.．]|[、)）])\s*/u,
    /^\s*（(?:[一二三四五六七八九十百千万]+|[\d０-９]+(?:\\?[.．][\d０-９]+)*)）\s*(?:\\?[.．]|[、])?\s*/u,
    /^\s*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*(?:\\?[.．]|[、])?\s*/u,
    /^\s*第(?:[\d０-９]+|[一二三四五六七八九十百千万]+)[章节篇部分卷]\s*/u,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = text.replace(pattern, '');
      if (next !== text) {
        text = next.trimStart();
        changed = true;
        break;
      }
    }
  }
  return text;
}

export function cleanContentSentence(value) {
  return String(value || '')
    .replace(/^﻿/, '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮﻿]/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/[　]+/g, ' ')
    .trim();
}

function splitContentBlockSentences(block) {
  const text = cleanContentSentence(block);
  if (!text) return [];

  const parts = [];
  let start = 0;
  let currentLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!/\s/.test(char)) currentLength += 1;
    const strongBoundary = /[。！？!?]/.test(char);
    const clauseBoundary = /[；;]/.test(char) && currentLength >= 20;
    if (strongBoundary || clauseBoundary) {
      parts.push(text.slice(start, index + 1));
      start = index + 1;
      currentLength = 0;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

function isInformativeContentSentence(sentence) {
  const compact = String(sentence || '').replace(/\s+/g, '');
  if (!compact || /^\d+$/.test(compact)) return false;
  const contentChars = compact.match(/[A-Za-z0-9一-鿿]/g) || [];
  if (contentChars.length < 4) return false;
  if (compact.length >= 12) return true;
  if (compact.length >= 6 && /[：:]/.test(compact) && /[A-Za-z一-鿿]{2,}/.test(compact)) return true;
  return compact.length >= 6
    && /[一-鿿]/.test(compact)
    && /(?:日历天|个月|万元|GHz|MHz|GB|MB|kg|mm|cm|天|年|元|%|％)/i.test(compact);
}

/** 正文句子（招标文件的用作正文比对的白名单，投标文件的用于比对）。 */
export function splitContentSentences(markdown, extractTableBlocks) {
  const sentences = [];
  for (const block of extractContentTextBlocks(markdown, extractTableBlocks)) {
    for (const part of splitContentBlockSentences(block)) {
      const sentence = cleanContentSentence(part);
      const normalized = normalizeContentSentence(sentence);
      if (!normalized) continue;
      if (!isInformativeContentSentence(normalized)) continue;
      sentences.push({ sentence: sentence.length > 600 ? `${sentence.slice(0, 600)}...` : sentence, normalized });
    }
  }
  return sentences;
}

// ---- 图片位置 ----

function extractLineImageTargets(line) {
  const targets = [];
  for (const match of String(line || '').matchAll(markdownImagePattern)) {
    const target = String(match.groups?.target || '').trim().replace(/^<|>$/g, '');
    if (target) targets.push({ target, index: match.index || 0 });
  }
  for (const match of String(line || '').matchAll(htmlImageSrcPattern)) {
    const target = String(match.groups?.src || '').trim();
    if (target) targets.push({ target, index: match.index || 0 });
  }
  return targets.sort((a, b) => a.index - b.index).filter((item) => outputImagePath.test(item.target));
}

function parseImageContextHeading(line) {
  const hashMatch = String(line || '').match(/^\s{0,3}(#{1,6})\s+(.+)$/);
  if (hashMatch) {
    const title = cleanOutlineTitle(hashMatch[2]);
    return title ? { level: Math.min(hashMatch[1].length, 6), title } : null;
  }

  const text = cleanOutlineTitle(line);
  if (!text || text.length > 90 || /[。！？；;]$/.test(text) || /^\|/.test(text) || isCatalogTitleLine(text)) return null;
  const marker = parseOutlineMarker(text);
  const bold = /^\s*\*\*.+\*\*\s*$/.test(line);
  if (!marker && !bold) return null;
  return { level: marker?.level || 2, title: marker?.title || text };
}

function updateImageContextHeadings(headings, heading) {
  while (headings.length && headings[headings.length - 1].level >= heading.level) headings.pop();
  headings.push(heading);
}

function getPreviousImageSentence(value) {
  const text = cleanMarkdownInlineText(value)
    .replace(/\|/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
  const parts = text.split(/[。！？!?；;\n]+/).map((item) => cleanContentSentence(item)).filter(Boolean);
  return (parts[parts.length - 1] || '').slice(0, 500);
}

/** 图片在文中的位置：所在目录、前一句。path 是解析输出中的图片，worker 按它找到写入的产物与哈希。 */
export function extractImageOccurrences(markdown) {
  const lines = normalizeContentLineBreaks(String(markdown || '').replace(/```[\s\S]*?```/g, '\n')).split('\n');
  const occurrences = [];
  const headings = [];
  let previousText = '';
  let imageIndex = 0;

  for (const line of lines) {
    const heading = parseImageContextHeading(line);
    if (heading) updateImageContextHeadings(headings, heading);

    const targets = extractLineImageTargets(line);
    for (const item of targets) {
      const beforeImage = line.slice(0, item.index);
      imageIndex += 1;
      occurrences.push({
        path: item.target,
        index: imageIndex,
        directory: headings.map((entry) => entry.title).join(' > '),
        previousSentence: getPreviousImageSentence(`${previousText}\n${beforeImage}`),
      });
    }

    const cleanedLine = cleanMarkdownLine(line);
    if (cleanedLine) {
      previousText = `${previousText}\n${cleanedLine}`.slice(-4000);
    }
  }

  return occurrences;
}

// ---- 汇总 ----

/**
 * 一份文档的查重提取结果（analysis.json）。markdown 与桌面版查重读取的正文相同（表格类格式以文件名作一级标题，去掉首尾空白）。
 * extractTableBlocks(tableHtml) 返回一个 HTML 表格中的文字块。
 */
export function analyzeDuplicateCheckDocument(markdown, extractTableBlocks) {
  const outline = buildOutlineItems(markdown);
  return {
    version: 1,
    outline,
    tenderSentences: splitTenderSentences(markdown),
    sentences: splitContentSentences(markdown, extractTableBlocks),
    images: extractImageOccurrences(markdown),
  };
}
