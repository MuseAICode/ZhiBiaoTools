// 标书查重的跨文档比对（路线图第 6 步 6.10）。逐文档的提取（目录、句子、图片位置）在 parse 沙箱中进行
// （server/sandbox/parse/duplicateText.mjs，输出 analysis.json），这里只做：
// - analysis.json 的校验（来自沙箱，按不可信输入处理：结构、类型、数量、目录项的编号与父子关系、图片路径）；
// - 招标原文白名单：目录项匹配招标句子（matchTenderSentence）、正文句子匹配招标原文（buildTenderSourceMatcher）；
// - 目录的重复组、相似组与两两相似度（buildOutlineComparison），重复句（buildDuplicateSentences），重复图片（buildDuplicateImages）；
// - 文件基本信息的元数据项（文件名、扩展名、大小、SHA-256；文档格式自身的元数据随 6.10b 在沙箱中提取）。
// 算法搬自桌面版 duplicateCheckService.cjs，常量与结果不变；为不长时间占用事件循环（任务租约靠定时器续期），长循环中定期让出，
// 目录相似度预先算好每个标题的二元组、最长公共子序列改为两行滚动数组，结果与桌面版相同。字段改为 camelCase。
import type { DuplicateCheckOutlineSource, DuplicateCheckRisk } from '../db/schema.ts';
import type { MetadataItemInput } from './store.ts';

const yieldControl = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---- analysis.json 的校验 ----

export interface AnalysisOutlineItem {
  id: string;
  level: number;
  number: string | null;
  title: string;
  normalizedTitle: string;
  pathTitles: string[];
  normalizedPath: string;
  source: DuplicateCheckOutlineSource;
  confidence: number;
  order: number;
  parentId: string | null;
}

export interface TenderSentence {
  text: string;
  normalized: string;
}

export interface ContentSentence {
  sentence: string;
  normalized: string;
}

export interface ImageOccurrence {
  /** 解析输出中的图片（images/image-0001.png）。 */
  path: string;
  index: number;
  directory: string;
  previousSentence: string;
}

export interface DocumentAnalysis {
  outline: { items: AnalysisOutlineItem[]; source: DuplicateCheckOutlineSource | null; confidence: number };
  tenderSentences: TenderSentence[];
  sentences: ContentSentence[];
  images: ImageOccurrence[];
}

/** 校验上限：远大于正常文档，只为挡住异常输出（归档本身另有 100 MiB 的单文件上限）。 */
export const ANALYSIS_LIMITS = Object.freeze({
  outlineItems: 50_000,
  tenderSentences: 1_000_000,
  sentences: 2_000_000,
  images: 10_000,
  /** 单个字符串（标题、句子、目录路径等）的字符数。 */
  text: 100_000,
  pathDepth: 6,
});

/** analysis.json 不符合规则。reason 是固定的英文短语，不含输出中的内容。 */
export class DuplicateAnalysisError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`duplicate-check analysis rejected: ${reason}`);
    this.name = 'DuplicateAnalysisError';
    this.reason = reason;
  }
}

const OUTLINE_SOURCES: readonly DuplicateCheckOutlineSource[] = ['catalog', 'heading', 'semantic'];
const IMAGE_PATH = /^images\/image-\d{4}\.(?:png|jpg|gif|webp|bmp)$/;

function record(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DuplicateAnalysisError(`${what} is not an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) throw new DuplicateAnalysisError(`${what} has an unexpected shape`);
  return value as Record<string, unknown>;
}

function list(value: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(value)) throw new DuplicateAnalysisError(`${what} is not an array`);
  if (value.length > max) throw new DuplicateAnalysisError(`${what} has too many entries`);
  return value;
}

function text(value: unknown, what: string, options: { min?: number; max?: number } = {}): string {
  if (typeof value !== 'string') throw new DuplicateAnalysisError(`${what} is not a string`);
  const length = value.length;
  if (length < (options.min ?? 0) || length > (options.max ?? ANALYSIS_LIMITS.text)) throw new DuplicateAnalysisError(`${what} has an unexpected length`);
  return value;
}

function integer(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new DuplicateAnalysisError(`${what} is out of range`);
  return value;
}

function ratio(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new DuplicateAnalysisError(`${what} is out of range`);
  return value;
}

function outlineItem(raw: unknown, index: number, byId: Map<string, AnalysisOutlineItem>): AnalysisOutlineItem {
  const item = record(raw, ['id', 'level', 'number', 'title', 'normalizedTitle', 'pathTitles', 'normalizedPath', 'source', 'confidence', 'order', 'parentId'], 'outline item');
  const id = text(item.id, 'outline item id');
  // 编号、顺序与入口的写法一致（O00001 起连续）。
  if (id !== `O${String(index + 1).padStart(5, '0')}` || item.order !== index) throw new DuplicateAnalysisError('outline item id or order is unexpected');
  const level = integer(item.level, 1, ANALYSIS_LIMITS.pathDepth, 'outline item level');
  const pathTitles = list(item.pathTitles, ANALYSIS_LIMITS.pathDepth, 'outline item path').map((entry) => text(entry, 'outline item path', { min: 1 }));
  const title = text(item.title, 'outline item title', { min: 1 });
  if (pathTitles.length !== level || pathTitles.at(-1) !== title) throw new DuplicateAnalysisError('outline item path does not match its level');
  let parentId: string | null = null;
  if (level > 1) {
    parentId = text(item.parentId, 'outline item parent');
    const parent = byId.get(parentId);
    // 父目录项在它之前、层级少一级，路径是父目录项的路径加上自己。
    if (!parent || parent.level !== level - 1 || parent.pathTitles.some((entry, position) => entry !== pathTitles[position])) {
      throw new DuplicateAnalysisError('outline item parent is unexpected');
    }
  } else if (item.parentId !== null) {
    throw new DuplicateAnalysisError('outline item parent is unexpected');
  }
  if (typeof item.source !== 'string' || !(OUTLINE_SOURCES as readonly string[]).includes(item.source)) throw new DuplicateAnalysisError('outline item source is unexpected');
  const parsed: AnalysisOutlineItem = {
    id,
    level,
    number: item.number === null ? null : text(item.number, 'outline item number', { min: 1 }),
    title,
    normalizedTitle: text(item.normalizedTitle, 'outline item normalized title', { min: 2 }),
    pathTitles,
    normalizedPath: text(item.normalizedPath, 'outline item normalized path'),
    source: item.source as DuplicateCheckOutlineSource,
    confidence: ratio(item.confidence, 'outline item confidence'),
    order: index,
    parentId,
  };
  byId.set(id, parsed);
  return parsed;
}

/**
 * 校验沙箱输出的 analysis.json（duplicateText.mjs 的 analyzeDuplicateCheckDocument）。imagePaths 是本次解析输出中的图片，
 * 图片位置只能引用它们。不符时抛 DuplicateAnalysisError。
 */
export function parseDuplicateAnalysis(data: Buffer, imagePaths: ReadonlySet<string>): DocumentAnalysis {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new DuplicateAnalysisError('analysis is not valid json');
  }
  const top = record(raw, ['version', 'outline', 'tenderSentences', 'sentences', 'images'], 'analysis');
  if (top.version !== 1) throw new DuplicateAnalysisError('analysis version is unexpected');

  const outline = record(top.outline, ['items', 'source', 'confidence'], 'outline');
  const byId = new Map<string, AnalysisOutlineItem>();
  const items = list(outline.items, ANALYSIS_LIMITS.outlineItems, 'outline items').map((item, index) => outlineItem(item, index, byId));
  const source = outline.source === null ? null : outline.source;
  if (source !== null && (typeof source !== 'string' || !(OUTLINE_SOURCES as readonly string[]).includes(source))) throw new DuplicateAnalysisError('outline source is unexpected');
  if ((source === null) !== (items.length === 0)) throw new DuplicateAnalysisError('outline source does not match its items');

  const tenderSentences = list(top.tenderSentences, ANALYSIS_LIMITS.tenderSentences, 'tender sentences').map((entry) => {
    const sentence = record(entry, ['text', 'normalized'], 'tender sentence');
    return { text: text(sentence.text, 'tender sentence text', { min: 1 }), normalized: text(sentence.normalized, 'tender sentence normalized', { min: 6, max: 160 }) };
  });
  const sentences = list(top.sentences, ANALYSIS_LIMITS.sentences, 'sentences').map((entry) => {
    const sentence = record(entry, ['sentence', 'normalized'], 'sentence');
    return { sentence: text(sentence.sentence, 'sentence text', { min: 1, max: 603 }), normalized: text(sentence.normalized, 'sentence normalized', { min: 1 }) };
  });
  const images = list(top.images, ANALYSIS_LIMITS.images, 'images').map((entry, index) => {
    const image = record(entry, ['path', 'index', 'directory', 'previousSentence'], 'image');
    const path = text(image.path, 'image path');
    if (!IMAGE_PATH.test(path) || !imagePaths.has(path)) throw new DuplicateAnalysisError('image path is not in the output');
    if (image.index !== index + 1) throw new DuplicateAnalysisError('image index is unexpected');
    return { path, index: index + 1, directory: text(image.directory, 'image directory'), previousSentence: text(image.previousSentence, 'image previous sentence', { max: 500 }) };
  });
  return {
    outline: { items, source: source as DuplicateCheckOutlineSource | null, confidence: ratio(outline.confidence, 'outline confidence') },
    tenderSentences,
    sentences,
    images,
  };
}

// ---- 目录：招标原文白名单 ----

/** 多份招标文件的句子按顺序合并、按 normalized 去重（与桌面版对合并的招标正文调用 splitTenderSentences 相同）。 */
export function mergeTenderSentences(lists: readonly (readonly TenderSentence[])[]): TenderSentence[] {
  const seen = new Set<string>();
  const merged: TenderSentence[] = [];
  for (const sentences of lists) {
    for (const sentence of sentences) {
      if (seen.has(sentence.normalized)) continue;
      seen.add(sentence.normalized);
      merged.push(sentence);
    }
  }
  return merged;
}

/** 目录标题是否来自招标原文（桌面版 matchTenderSentence；标题已规范化，即目录项的 normalizedTitle）。 */
export function matchTenderSentence(normalized: string, tenderSentences: readonly TenderSentence[]): TenderSentence | null {
  if (normalized.length < 6) return null;
  for (const sentence of tenderSentences) {
    if (sentence.normalized === normalized) return sentence;
    if (normalized.length >= 10 && sentence.normalized.includes(normalized)) return sentence;
    if (sentence.normalized.length >= 10 && normalized.includes(sentence.normalized) && sentence.normalized.length / normalized.length >= 0.8) return sentence;
  }
  return null;
}

// ---- 目录：重复组、相似组与两两相似度 ----

export interface OutlineFile {
  fileId: string;
  status: 'success' | 'error';
  items: OutlineEntry[];
}

export interface OutlineEntry extends AnalysisOutlineItem {
  fromTender: boolean;
  matchedTenderSentence: string | null;
}

export interface OutlineGroup {
  id: string;
  type: 'duplicate' | 'similar';
  title: string;
  score: number;
  fileIds: string[];
  itemIds: Record<string, string[]>;
  paths: Record<string, string[]>;
}

export interface OutlinePairwise {
  fileAId: string;
  fileBId: string;
  score: number;
  titleOverlap: number;
  pathOverlap: number;
  orderSimilarity: number;
  sharedCount: number;
  risk: DuplicateCheckRisk;
}

function intersectSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

function toBigrams(value: string): Set<string> {
  const chars = Array.from(value);
  if (chars.length <= 1) return new Set(chars);
  return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
}

/** 桌面版 bigramSimilarity；二元组集合由调用方缓存。 */
function bigramSimilarity(left: string, right: string, bigrams: (value: string) => Set<string>): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);
  const shared = intersectSize(leftSet, rightSet);
  return (2 * shared) / (leftSet.size + rightSet.size || 1);
}

/** 桌面版 lcsSimilarity（最长公共子序列长度 / 较长的长度），两行滚动数组。 */
function lcsSimilarity(left: readonly string[], right: readonly string[]): number {
  if (!left.length || !right.length) return 0;
  let previous = new Array<number>(right.length + 1).fill(0);
  let current = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
    current[0] = 0;
  }
  return previous[right.length]! / Math.max(left.length, right.length);
}

function riskFromScore(score: number): DuplicateCheckRisk {
  if (score >= 0.75) return 'high';
  if (score >= 0.55) return 'medium';
  if (score >= 0.35) return 'low';
  return 'none';
}

/** 桌面版 buildOutlineComparison：目录的重复组、相似组（按分数、文件数排序）与成功文件的两两相似度。 */
export async function buildOutlineComparison(files: readonly OutlineFile[]): Promise<{ duplicateGroups: OutlineGroup[]; pairwiseSimilarities: OutlinePairwise[] }> {
  const groups: OutlineGroup[] = [];
  type Entry = { file: OutlineFile; item: OutlineEntry };
  const byTitle = new Map<string, Entry[]>();
  const byPath = new Map<string, Entry[]>();
  const duplicateGroupIds = new Map<OutlineEntry, string[]>();
  const successful = files.filter((file) => file.status === 'success');
  for (const file of successful) {
    for (const item of file.items) {
      duplicateGroupIds.set(item, []);
      if (item.fromTender) continue;
      const titleList = byTitle.get(item.normalizedTitle) ?? [];
      titleList.push({ file, item });
      byTitle.set(item.normalizedTitle, titleList);
      const pathList = byPath.get(item.normalizedPath) ?? [];
      pathList.push({ file, item });
      byPath.set(item.normalizedPath, pathList);
    }
  }

  function addGroup(type: OutlineGroup['type'], entries: readonly Entry[], title: string, score: number): void {
    const fileIds = Array.from(new Set(entries.map((entry) => entry.file.fileId)));
    if (fileIds.length < 2) return;
    const id = `G${String(groups.length + 1).padStart(4, '0')}`;
    const group: OutlineGroup = { id, type, title, score, fileIds, itemIds: {}, paths: {} };
    for (const entry of entries) {
      group.itemIds[entry.file.fileId] = [...(group.itemIds[entry.file.fileId] ?? []), entry.item.id];
      group.paths[entry.file.fileId] = [...(group.paths[entry.file.fileId] ?? []), entry.item.pathTitles.join(' > ')];
      if (type === 'duplicate') duplicateGroupIds.get(entry.item)!.push(id);
    }
    groups.push(group);
  }

  for (const entries of byPath.values()) addGroup('duplicate', entries, entries[0]?.item.pathTitles.join(' > ') || entries[0]?.item.title || '', 1);
  for (const entries of byTitle.values()) {
    const alreadyGrouped = entries.every((entry) => duplicateGroupIds.get(entry.item)!.length);
    if (!alreadyGrouped) addGroup('duplicate', entries, entries[0]?.item.title || '', 0.95);
  }

  const bigramCache = new Map<string, Set<string>>();
  const bigrams = (value: string) => {
    let set = bigramCache.get(value);
    if (!set) {
      set = toBigrams(value);
      bigramCache.set(value, set);
    }
    return set;
  };
  const ungrouped = successful.map((file) => file.items.filter((item) => !item.fromTender && !duplicateGroupIds.get(item)!.length));
  const seenSimilar = new Set<string>();
  for (let i = 0; i < successful.length; i += 1) {
    for (let j = i + 1; j < successful.length; j += 1) {
      for (const left of ungrouped[i]!) {
        for (const right of ungrouped[j]!) {
          if (Math.abs(right.level - left.level) > 1) continue;
          const score = bigramSimilarity(left.normalizedTitle, right.normalizedTitle, bigrams);
          if (score < 0.86) continue;
          const key = [successful[i]!.fileId, left.id, successful[j]!.fileId, right.id].join(':');
          if (seenSimilar.has(key)) continue;
          seenSimilar.add(key);
          addGroup('similar', [{ file: successful[i]!, item: left }, { file: successful[j]!, item: right }], left.title, Number(score.toFixed(2)));
        }
      }
      await yieldControl();
    }
  }

  const pairwiseSimilarities: OutlinePairwise[] = [];
  const compared = successful.map((file) => {
    const items = file.items.filter((item) => !item.fromTender);
    return {
      titles: new Set(items.map((item) => item.normalizedTitle)),
      paths: new Set(items.map((item) => item.normalizedPath)),
      order: items.map((item) => item.normalizedTitle),
    };
  });
  for (let i = 0; i < successful.length; i += 1) {
    for (let j = i + 1; j < successful.length; j += 1) {
      const left = compared[i]!;
      const right = compared[j]!;
      const titleShared = intersectSize(left.titles, right.titles);
      const pathShared = intersectSize(left.paths, right.paths);
      const titleOverlap = titleShared / Math.max(Math.min(left.titles.size, right.titles.size), 1);
      const pathOverlap = pathShared / Math.max(Math.min(left.paths.size, right.paths.size), 1);
      const orderSimilarity = lcsSimilarity(left.order, right.order);
      const score = Number((pathOverlap * 0.45 + titleOverlap * 0.35 + orderSimilarity * 0.2).toFixed(2));
      pairwiseSimilarities.push({
        fileAId: successful[i]!.fileId,
        fileBId: successful[j]!.fileId,
        score,
        titleOverlap: Number(titleOverlap.toFixed(2)),
        pathOverlap: Number(pathOverlap.toFixed(2)),
        orderSimilarity: Number(orderSimilarity.toFixed(2)),
        sharedCount: Math.max(titleShared, pathShared),
        risk: riskFromScore(score),
      });
      await yieldControl();
    }
  }

  return { duplicateGroups: groups.sort((a, b) => b.score - a.score || b.fileIds.length - a.fileIds.length), pairwiseSimilarities };
}

// ---- 正文：招标原文白名单 ----

// normalizeContentSentence 与沙箱中的 duplicateText.mjs 相同（招标原文比较时还要再规范化一次；单元测试核对两边一致）。
function stripLeadingContentSequence(value: string): string {
  let text = String(value || '').trim();
  const patterns = [
    /^\s*[\d０-９]+(?:\\?[.．][\d０-９]+)*\s*(?:\\?[.．]|[)）、])\s*/u,
    /^\s*[\d０-９]+(?:\\?[.．][\d０-９]+)*\s+(?=[A-Za-z\u4e00-\u9fff（(])/u,
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

export function normalizeContentSentence(value: string): string {
  return stripLeadingContentSequence(String(value || ''))
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

function normalizeTenderComparableText(value: string): string {
  let text = normalizeContentSentence(value)
    .normalize('NFKC')
    .replace(/\\([\[\]().{}<>#+=\-])/g, '$1')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/，/g, ',')
    .replace(/。/g, '.')
    .replace(/；/g, ';')
    .replace(/：/g, ':')
    .replace(/≥|大于等于|不低于|不少于/g, '>=')
    .replace(/≤|小于等于|不高于|不超过/g, '<=')
    .replace(/(\d)\s*[xX×]\s*(\d)/g, '$1×$2')
    .replace(/(\d{4})\s*年\s*0?(\d{1,2})\s*月\s*0?(\d{1,2})\s*日/g, (_match, year: string, month: string, day: string) => `${year}年${Number(month)}月${Number(day)}日`)
    .replace(/\b(\d{4})[-/.](0?\d{1,2})[-/.](0?\d{1,2})\b/g, (_match, year: string, month: string, day: string) => `${year}年${Number(month)}月${Number(day)}日`)
    .replace(/\s+/g, ' ')
    .trim();

  text = stripTenderTablePrefix(text);
  text = stripTenderDirectoryPageTail(text);
  return text.trim();
}

const TENDER_TABLE_PREFIXES = ['技术要求', '招标要求', '评分标准', '评标标准', '投标应答', '偏离说明'].map(
  (prefix) => new RegExp(`^${prefix}\\s*[:：]?\\s*(?:\\d+(?:\\.\\d+)*\\s*[.)、．]?\\s*)?`, 'i'),
);

function stripTenderTablePrefix(value: string): string {
  let text = String(value || '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of TENDER_TABLE_PREFIXES) {
      const next = text.replace(pattern, '').trim();
      if (next !== text && next) {
        text = next;
        changed = true;
        break;
      }
    }
  }
  return text;
}

function stripTenderDirectoryPageTail(value: string): string {
  let text = String(value || '').trim();
  if (!/(目录|页码|检索|评分因素|评标标准|评分标准)/.test(text)) return text;
  text = text
    .replace(/\s*(?:第\s*)?\d{1,4}\s*页\s*$/i, '')
    .replace(/\s*P\s*\d{1,4}(?:\s*[-~至]\s*P?\s*\d{1,4})?\s*$/i, '')
    .replace(/(?:\.{2,}|…{2,}|·{2,}|\s{2,})\s*\d{1,4}\s*$/g, '')
    .replace(/\s+\d{1,4}\s*$/g, '');
  return text.trim();
}

function buildTenderStrictKey(value: string): string {
  return normalizeTenderComparableText(value)
    .replace(/[\s　]+/g, '')
    .replace(/[.,，。;；:：、!！?？"'“”‘’《》<>〈〉()[\]【】{}]/g, '')
    .toLowerCase();
}

function buildTenderLooseText(value: string): string {
  return normalizeTenderComparableText(value)
    .replace(/[\s　]+/g, '')
    .replace(/[.,，。;；:：、!！?？"'“”‘’《》<>〈〉()[\]【】{}]/g, '')
    .toLowerCase();
}

function buildTenderSkeletonKey(value: string): string {
  let text = normalizeTenderComparableText(value)
    .replace(/\b\d{4}年\d{1,2}月\d{1,2}日\b/g, '{date}')
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, '{date}')
    .replace(/\b[A-Z]{2,}[-A-Z0-9]{4,}\b/gi, '{code}')
    .replace(/\d+(?:\.\d+)?\s*万元/g, '{money}')
    .replace(/\d+(?:\.\d+)?\s*元/g, '{money}')
    .replace(/\d+(?:\.\d+)?\s*%/g, '{percent}')
    .replace(/\d+(?:\.\d+)?\s*分/g, '{score}')
    .replace(/P\s*\d+(?:\s*[-~至]\s*P?\s*\d+)?/gi, '{page}')
    .replace(/\b\d+(?:\.\d+)?\b/g, '{num}');
  text = text
    .replace(/[\s　]+/g, '')
    .replace(/[.,，。;；:：、!！?？"'“”‘’《》<>〈〉()[\]【】{}]/g, '')
    .toLowerCase();
  return text;
}

function isTenderSkeletonAllowed(value: string, skeletonKey: string): boolean {
  const text = normalizeTenderComparableText(value);
  const compactLength = buildTenderLooseText(text).length;
  if (!skeletonKey || skeletonKey.length < 8 || !/[{}]/.test(skeletonKey)) return false;
  if (compactLength >= 18) return true;
  return /(评分|评标|分值|计分|内容无瑕疵|内容存在|页码检索|合同复印件|技术要求|招标要求)/.test(text);
}

const tenderFieldDenyPattern = /(供应商名称|供应商地址|法定代表人|供应商代表|授权代表|被授权人|委托代理人|联系人|联系电话|电话|手机|邮政编码|邮箱|电子邮箱|开户|账号|银行|报价|投标报价|投标总价|合同金额|金额|总价)/;
const tenderFieldAllowPattern = /^(投标日期|日期|项目名称|项目编号|采购人|采购代理机构|评分因素及评标标准页码检索|投标文件总目录|目录|附件\d*|投标书|开标一览表|报价分项一览表|投标产品配置清单|商务要求点对点应答表|技术要求点对点应答表|主要相关业绩一览表|政府采购政策情况表|中小微企业声明函|非残疾人福利性单位声明函)$/;

function normalizeTenderFieldName(value: string): string {
  return String(value || '')
    .replace(/[\s　]+/g, '')
    .replace(/[：:]+$/g, '')
    .replace(/[()（）【】\[\]《》]/g, '')
    .trim();
}

function parseTenderFormatField(value: string): { field: string; tail: string } | null {
  const text = normalizeTenderComparableText(value);
  if (!text) return null;
  if (/^评分因素及评标标准页码检索(?:\s+\d{1,4}|\s+P?\d{1,4}(?:[-~至]P?\d{1,4})?)?$/i.test(text)) {
    return { field: '评分因素及评标标准页码检索', tail: text.replace(/^评分因素及评标标准页码检索/i, '').trim() };
  }

  const colonIndex = text.indexOf(':');
  if (colonIndex > 0 && colonIndex <= 24) {
    const field = normalizeTenderFieldName(text.slice(0, colonIndex));
    const tail = text.slice(colonIndex + 1).trim();
    return field ? { field, tail } : null;
  }

  const title = normalizeTenderFieldName(stripTenderDirectoryPageTail(text));
  return tenderFieldAllowPattern.test(title) ? { field: title, tail: text.slice(title.length).trim() } : null;
}

function isTenderFieldAllowed(field: string): boolean {
  if (!field || tenderFieldDenyPattern.test(field)) return false;
  return tenderFieldAllowPattern.test(field);
}

function isSafeTenderFieldTail(value: string): boolean {
  const tail = normalizeTenderComparableText(value).trim();
  if (!tail) return true;
  if (/^(?:\d{4}年\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$/.test(tail)) return true;
  if (/^(?:第\s*)?\d{1,4}\s*页?$/.test(tail)) return true;
  if (/^P\s*\d{1,4}(?:\s*[-~至]\s*P?\s*\d{1,4})?$/i.test(tail)) return true;
  if (/^[A-Z0-9-]{4,}$/i.test(tail)) return true;
  return tail.length <= 36 && /(天津港保税区消防救援支队|消防装备管理系统项目|天津众信招标咨询有限公司)/.test(tail);
}

function charBigramsFromLooseText(value: string): Set<string> {
  const text = String(value || '');
  if (!text) return new Set();
  if (text.length === 1) return new Set([text]);
  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}

function diceSimilarityFromShared(shared: number, leftSize: number, rightSize: number): number {
  return (2 * shared) / Math.max(leftSize + rightSize, 1);
}

function shouldApplyNearTenderMatch(value: string, looseText: string): boolean {
  if (looseText.length >= 12) return true;
  return /(评分|评标|页码|投标日期|日期|技术要求|招标要求)/.test(normalizeTenderComparableText(value));
}

export type TenderMatchReason = 'exact' | 'strict' | 'field' | 'skeleton' | 'near';

export interface TenderSourceMatcher {
  tenderSentenceCount: number;
  match(sentence: ContentSentence): { reason: TenderMatchReason } | null;
}

/** 桌面版 buildTenderSourceMatcher：投标正文的句子是否来自招标原文（逐字、去标点、格式字段、骨架、近似五种）。 */
export async function buildTenderSourceMatcher(tenderSentences: readonly ContentSentence[]): Promise<TenderSourceMatcher> {
  const exactSet = new Set<string>();
  const strictSet = new Set<string>();
  const skeletonSet = new Set<string>();
  const fieldSet = new Set<string>();
  const entries: { normalized: string; grams: Set<string> }[] = [];
  const gramIndex = new Map<string, number[]>();

  for (const [position, sentence] of tenderSentences.entries()) {
    const normalized = sentence.normalized || normalizeContentSentence(sentence.sentence);
    const strictKey = buildTenderStrictKey(normalized);
    const skeletonKey = buildTenderSkeletonKey(normalized);
    const looseText = buildTenderLooseText(normalized);
    const grams = charBigramsFromLooseText(looseText);
    if (normalized) exactSet.add(normalized);
    if (strictKey && strictKey.length >= 3) strictSet.add(strictKey);
    if (isTenderSkeletonAllowed(normalized, skeletonKey)) skeletonSet.add(skeletonKey);
    const parsedField = parseTenderFormatField(normalized);
    if (parsedField && isTenderFieldAllowed(parsedField.field)) fieldSet.add(parsedField.field);
    const entryIndex = entries.length;
    entries.push({ normalized, grams });
    for (const gram of grams) {
      const indexes = gramIndex.get(gram) ?? [];
      indexes.push(entryIndex);
      gramIndex.set(gram, indexes);
    }
    if ((position + 1) % 2000 === 0) await yieldControl();
  }

  const candidateCounts = new Uint32Array(entries.length);

  function matchNear(sentence: ContentSentence): { reason: 'near' } | null {
    const looseText = buildTenderLooseText(sentence.normalized);
    if (!shouldApplyNearTenderMatch(sentence.normalized, looseText)) return null;
    const grams = charBigramsFromLooseText(looseText);
    if (grams.size < 4) return null;
    const candidates: number[] = [];
    for (const gram of grams) {
      for (const index of gramIndex.get(gram) ?? []) {
        if (candidateCounts[index] === 0) candidates.push(index);
        candidateCounts[index]! += 1;
      }
    }

    let best: { reason: 'near'; dice: number } | null = null;
    const compactLength = looseText.length;
    for (const index of candidates) {
      const shared = candidateCounts[index]!;
      candidateCounts[index] = 0;
      const entry = entries[index];
      if (!entry?.grams.size) continue;
      const shorter = Math.min(grams.size, entry.grams.size);
      const longer = Math.max(grams.size, entry.grams.size);
      const containment = shared / Math.max(shorter, 1);
      const dice = diceSimilarityFromShared(shared, grams.size, entry.grams.size);
      const lengthRatio = shorter / Math.max(longer, 1);
      const allowed = compactLength >= 30
        ? containment >= 0.9 && dice >= 0.82 && lengthRatio >= 0.5
        : containment >= 0.95 && dice >= 0.88 && lengthRatio >= 0.55;
      if (!allowed) continue;
      if (!best || dice > best.dice) best = { reason: 'near', dice };
    }
    return best ? { reason: 'near' } : null;
  }

  return {
    tenderSentenceCount: exactSet.size,
    match(sentence) {
      const normalized = sentence.normalized || '';
      if (!normalized) return null;
      if (exactSet.has(normalized)) return { reason: 'exact' };
      const strictKey = buildTenderStrictKey(normalized);
      if (strictKey && strictSet.has(strictKey)) return { reason: 'strict' };
      const parsedField = parseTenderFormatField(normalized);
      if (parsedField && isTenderFieldAllowed(parsedField.field) && fieldSet.has(parsedField.field) && isSafeTenderFieldTail(parsedField.tail)) {
        return { reason: 'field' };
      }
      const skeletonKey = buildTenderSkeletonKey(normalized);
      if (isTenderSkeletonAllowed(normalized, skeletonKey) && skeletonSet.has(skeletonKey)) return { reason: 'skeleton' };
      return matchNear(sentence);
    },
  };
}

// ---- 正文：重复句 ----

export interface GlobalSentence {
  sentence: string;
  normalized: string;
  fileIds: string[];
  occurrences: Record<string, number>;
  firstOrder: number;
}

export interface DuplicateSentence extends GlobalSentence {
  id: string;
}

/** 至少出现在两份投标文件中的句子，按文件数、句子长度、首次出现的顺序排序，编号 S000001 起。 */
export function buildDuplicateSentences(globalSentences: ReadonlyMap<string, GlobalSentence>): DuplicateSentence[] {
  return Array.from(globalSentences.values())
    .filter((item) => item.fileIds.length > 1)
    .sort((a, b) => b.fileIds.length - a.fileIds.length || b.sentence.length - a.sentence.length || a.firstOrder - b.firstOrder)
    .map((item, index) => ({ ...item, id: `S${String(index + 1).padStart(6, '0')}` }));
}

// ---- 图片：重复图片 ----

export interface GlobalImage {
  hash: string;
  /** 预览图：第一份含该图片的文件中第一次出现的图片产物。 */
  previewArtifactId: string;
  fileIds: string[];
  occurrences: Record<string, number>;
  locations: Record<string, { imageIndex: number; directory: string; previousSentence: string }[]>;
}

export interface DuplicateImage extends GlobalImage {
  id: string;
}

/** 至少出现在两份投标文件中的图片（按内容的 SHA-256），按文件数、出现总次数排序，编号 I000001 起。 */
export function buildDuplicateImages(globalImages: ReadonlyMap<string, GlobalImage>): DuplicateImage[] {
  const total = (item: GlobalImage) => Object.values(item.occurrences).reduce((sum, count) => sum + count, 0);
  return Array.from(globalImages.values())
    .filter((item) => item.fileIds.length > 1)
    .sort((a, b) => b.fileIds.length - a.fileIds.length || total(b) - total(a))
    .map((item, index) => ({ ...item, id: `I${String(index + 1).padStart(6, '0')}` }));
}

// ---- 元数据：文件基本信息 ----

const metadataLabels: Readonly<Record<string, string>> = Object.freeze({
  file_name: '文件名',
  extension: '扩展名',
  size: '文件大小',
  file_sha256: '原始文件 SHA256',
  created_at: '文件创建时间',
  modified_at: '文件修改时间',
  accessed_at: '文件访问时间',
  title: '标题',
  subject: '主题',
  author: '作者',
  last_modified_by: '最后修改人',
  revision: '修订号',
  created: '创建时间',
  modified: '修改时间',
  last_printed: '最后打印时间',
  keywords: '关键词',
  category: '类别',
  description: '描述',
  content_status: '内容状态',
  content_type: '内容类型',
  identifier: '标识符',
  language: '语言',
  application: '应用程序',
  app_version: '应用程序版本',
  company: '公司',
  manager: '管理者',
  template: '模板',
  presentation_format: '演示格式',
  pages: '页数',
  words: '字数',
  characters: '字符数',
  characters_with_spaces: '含空格字符数',
  bytes: '字节数',
  lines: '行数',
  paragraphs: '段落数',
  slides: '幻灯片数',
  notes: '备注数',
  hidden_slides: '隐藏幻灯片数',
  multimedia_clips: '多媒体剪辑数',
  total_time: '编辑时长',
  code_page: '代码页',
  document_version: '文档版本',
  doc_security: '文档安全状态',
  shared_doc: '共享文档',
  links_dirty: '链接已变更',
  hlinks_changed: '超链接已变更',
  creator: '创建工具',
  producer: '生成工具',
  pdf_version: 'PDF 版本',
  pdf_permissions: 'PDF 权限',
  fingerprints: 'PDF 指纹',
  word_rsid_root: 'Word 编辑会话根 ID',
  word_rsid_count: 'Word 编辑会话 ID 数量',
  word_rsid_values: 'Word 编辑会话 ID 列表',
  word_rsid_fingerprint: 'Word 编辑会话指纹',
  ole_storage_count: 'OLE 存储数量',
  ole_stream_count: 'OLE Stream 数量',
  ole_stream_paths: 'OLE Stream 路径摘要',
  ole_stream_paths_fingerprint: 'OLE Stream 路径指纹',
  ole_stream_sizes_fingerprint: 'OLE Stream 大小指纹',
  ole_has_macro_storage: 'OLE 宏存储',
  ole_macro_paths: 'OLE 宏存储路径',
  pdf_header_version: 'PDF 头版本',
  pdf_object_count: 'PDF 对象数量',
  pdf_startxref_count: 'PDF startxref 数量',
  pdf_incremental_update_count: 'PDF 增量保存次数',
  pdf_linearized: 'PDF 线性化',
  pdf_xref_type: 'PDF XRef 类型',
  pdf_trailer_id: 'PDF Trailer ID',
  pdf_has_acroform: 'PDF 表单',
  pdf_has_xfa: 'PDF XFA 表单',
  pdf_signature_count: 'PDF 签名字段数量',
  pdf_byterange_signature_count: 'PDF ByteRange 签名数量',
  pdf_embedded_file_count: 'PDF 附件数量',
  pdf_embedded_file_names: 'PDF 附件文件名',
});

const comparableKeys = new Set([
  'title', 'subject', 'author', 'last_modified_by', 'revision', 'created', 'modified', 'last_printed', 'keywords',
  'category', 'description', 'content_status', 'content_type', 'identifier', 'language', 'application', 'app_version',
  'company', 'manager', 'template', 'presentation_format', 'pages', 'words', 'characters', 'characters_with_spaces',
  'bytes', 'lines', 'paragraphs', 'slides', 'notes', 'hidden_slides', 'multimedia_clips', 'total_time', 'creator',
  'producer', 'pdf_version', 'pdf_permissions', 'fingerprints', 'document_version', 'doc_security', 'shared_doc',
  'links_dirty', 'hlinks_changed',
  'file_sha256', 'word_rsid_root', 'word_rsid_count', 'word_rsid_values', 'word_rsid_fingerprint',
  'ole_storage_count', 'ole_stream_count', 'ole_stream_paths', 'ole_stream_paths_fingerprint', 'ole_stream_sizes_fingerprint',
  'ole_has_macro_storage', 'ole_macro_paths', 'pdf_header_version', 'pdf_object_count', 'pdf_startxref_count',
  'pdf_incremental_update_count', 'pdf_linearized', 'pdf_xref_type', 'pdf_trailer_id', 'pdf_has_acroform',
  'pdf_has_xfa', 'pdf_signature_count', 'pdf_byterange_signature_count', 'pdf_embedded_file_count', 'pdf_embedded_file_names',
]);

const dateComparableKeys = new Set(['created_at', 'modified_at', 'accessed_at', 'created', 'modified', 'last_printed']);

export function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue).filter(Boolean).join('；');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeComparable(value: unknown): string {
  const text = normalizeValue(value).toLowerCase();
  if (!text || ['没有提及', '原文未提及', '-', '无', 'null', 'undefined'].includes(text)) return '';
  const date = new Date(text.replace(/^d:/i, '').replace(/([+-]\d{2})'(\d{2})'$/, '$1:$2'));
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return text.replace(/[\s　\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]+/g, '');
}

function normalizeDateDay(value: unknown): string {
  const text = normalizeValue(value);
  if (!text) return '';
  const date = new Date(text.replace(/^d:/i, '').replace(/([+-]\d{2})'(\d{2})'$/, '$1:$2'));
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  const match = text.match(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/);
  return match ? match[0].replace(/[年月/.]/g, '-').replace(/日/g, '') : '';
}

function formatMetadataKey(key: string): string {
  return String(key || '').replace(/[_:]+/g, ' ').trim() || String(key || '');
}

export function getMetadataLabel(key: string): string {
  if (Object.hasOwn(metadataLabels, key)) return metadataLabels[key]!;
  if (key.startsWith('converted_docx:')) return `转换 DOCX：${getMetadataLabel(key.slice('converted_docx:'.length))}`;
  if (key.startsWith('custom:') && key.endsWith(':base64_decoded')) return `自定义：${key.slice('custom:'.length, -':base64_decoded'.length)}（Base64 解码）`;
  if (key.startsWith('custom:')) return `自定义：${key.slice('custom:'.length)}`;
  if (key.endsWith(':base64_decoded')) return `${getMetadataLabel(key.slice(0, -':base64_decoded'.length))}（Base64 解码）`;
  if (key.startsWith('pdf_info:')) return `PDF Info：${formatMetadataKey(key.slice('pdf_info:'.length))}`;
  if (key.startsWith('pdf_xmp:')) return `PDF XMP：${formatMetadataKey(key.slice('pdf_xmp:'.length))}`;
  if (key.startsWith('pdf_raw:')) return `PDF 原始记录：${formatMetadataKey(key.slice('pdf_raw:'.length))}`;
  if (key.startsWith('ole_signal:')) return `OLE 疑似痕迹：${formatMetadataKey(key.slice('ole_signal:'.length))}`;
  if (key.startsWith('wps:')) return `疑似 WPS 用户/账号：${formatMetadataKey(key.slice('wps:'.length))}`;
  return formatMetadataKey(key);
}

function isDateComparableKey(key: string): boolean {
  if (dateComparableKeys.has(key)) return true;
  const normalized = String(key || '').toLowerCase();
  if (/last[_-]?modified[_-]?by|lastmodifiedby/.test(normalized)) return false;
  return /(^|[:_])(created|modified|last_printed|creationdate|moddate|createdate|modifydate|metadatadate|lastsaved|lastprinted)([:_]|$)/.test(normalized);
}

function isComparableKey(key: string): boolean {
  return comparableKeys.has(key)
    || isDateComparableKey(key)
    || key.startsWith('custom:')
    || key.startsWith('converted_docx:')
    || key.startsWith('pdf_info:')
    || key.startsWith('pdf_xmp:')
    || key.startsWith('pdf_raw:')
    || key.startsWith('ole_signal:')
    || key.startsWith('wps:');
}

function tryDecodeBase64Text(value: string): string {
  const text = normalizeValue(value);
  if (!text || text.length < 12 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return '';
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!decoded || decoded === text || decoded.includes('\uFFFD') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)) return '';
    try {
      return JSON.stringify(JSON.parse(decoded));
    } catch {
      return decoded;
    }
  } catch {
    return '';
  }
}

function shouldSkipBase64Decode(key: string, value: string): boolean {
  const normalizedKey = String(key || '').toLowerCase();
  if (/(^|[:_])(sha256|sha1|md5|hash|fingerprint)([:_]|$)/.test(normalizedKey)) return true;
  return /^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$|^[0-9a-f]{128}$/i.test(normalizeValue(value));
}

function addField(fields: Map<string, string>, key: string, value: unknown): void {
  const text = normalizeValue(value);
  if (!text) return;
  fields.set(key, text);
}

function addDecodedBase64Fields(fields: Map<string, string>): void {
  for (const [key, value] of Array.from(fields.entries())) {
    if (key.endsWith(':base64_decoded')) continue;
    if (shouldSkipBase64Decode(key, value)) continue;
    const decoded = tryDecodeBase64Text(value);
    if (decoded) addField(fields, `${key}:base64_decoded`, decoded);
  }
}

/** 元数据字段 → 元数据项（标签、规范化的比较值、日期，桌面版 extractMetadata 的末尾部分）。 */
export function metadataItems(fields: ReadonlyMap<string, string>): MetadataItemInput[] {
  const withDecoded = new Map(fields);
  addDecodedBase64Fields(withDecoded);
  return Array.from(withDecoded.entries()).map(([key, value]) => ({
    key,
    label: getMetadataLabel(key),
    value,
    normalized: normalizeComparable(value),
    dateDay: normalizeDateDay(value),
    comparable: isComparableKey(key),
    dateComparable: isDateComparableKey(key),
  }));
}

/**
 * 文件基本信息（桌面版 extractMetadata 的前半部分）：文件名、扩展名（与桌面版相同带点）、大小、原件的 SHA-256。
 * 桌面版的文件创建 / 修改 / 访问时间是本机文件系统的时间，Web 版只有上传时间（同一天上传的文件都会被标为“同一天”），不提供。
 */
export function basicMetadataFields(file: { fileName: string; extension: string; size: number; sha256: string }): Map<string, string> {
  const fields = new Map<string, string>();
  addField(fields, 'file_name', file.fileName);
  addField(fields, 'extension', file.extension ? `.${file.extension}` : '');
  addField(fields, 'size', file.size);
  addField(fields, 'file_sha256', file.sha256);
  return fields;
}
