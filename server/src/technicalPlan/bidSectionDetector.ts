// 疑似多标段检测（路线图第 6 步 6.11；取代桌面版 utils/bidSectionDetector.cjs 与 technicalPlanStore.checkBidSections）。
// 只用于在开始招标解析前快速判断招标文件是否疑似多标段，不生成最终标段列表。
//
// 判定规则与桌面版相同（tests/technicalPlan/bidSectionDetector.test.ts 直接加载桌面版文件，对同一批输入逐个比对结果），
// 但不再用正则在全文上匹配：桌面版的总数声明（`\s*(\d+|…)\s*个?\s*`）和标段定义（`(\d+)标段[：:]` 等）在长数字串、
// 长空白串上是平方级回溯，每次匹配又从匹配位置向两侧扫描整行（一行很长、匹配很多时同样是平方级）。这里改为一次扫描找出
// 各类字符的最长连续段，按段判断（正则的最左、贪婪语义下，只有段首可能匹配，捕获的就是整段，见各函数的说明），行的
// 文本按行号缓存；整体耗时与正文长度成正比。
//
// 招标正文由多份文件合并而成，文件在不同时间解析完成、也可能单独移除，所以检测按文件进行：解析任务在 worker 中对每份招标文件
// 算出摘要（summarizeBidSectionDetection）写入文档，读取状态时把各文件的摘要合并（combineBidSectionDetections），合并只做
// 集合并集和取最大值。判定只关心集合大小是否达到 2，摘要中的集合最多保留 BID_SECTION_DETECTION_SET_MAX 个元素。
// 与桌面版对合并正文整体检测的差别：总数声明中的空白（`\s*`）不会跨过两份文件的边界（桌面版合并时以空行连接，理论上可以）。

/** 一份招标文件的检测摘要（写入 technical_plan_documents.bid_section_detection）。 */
export interface BidSectionDetectionSummary {
  version: 1;
  /** “共 N 个标段”类声明中 N ≥ 2 的最大值（单位是“标段”的），没有时为 null。 */
  declaredSections: number | null;
  /** 同上，任意单位（包、分包、标包、标的、子项目）。 */
  declaredAny: number | null;
  /** 标段定义（“一标段：”等）的“单位:序号”。 */
  definitions: string[];
  /** 行首“【N】”的 N。 */
  bracketGroups: string[];
  /** 行首“【N-M】”的“N-M”。 */
  bracketChildren: string[];
}

/** 与桌面版 checkBidSections 的返回值相同。 */
export interface BidSectionDetection {
  hasMultiple: boolean;
  totalDeclared: number | null;
}

/** 判定只看集合大小是否达到 2，每个集合保留的元素数上限（大于等于 2 即与完整集合的判定相同）。 */
export const BID_SECTION_DETECTION_SET_MAX = 10;

// ---- 与桌面版相同的数字换算 ----

const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function chineseToDigit(ch: string | undefined): number | null {
  const index = CHINESE_DIGITS.indexOf(ch ?? '');
  return index >= 1 ? index : null;
}

const CHINESE_SMALL: Readonly<Record<string, number>> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5,
};

/** 与桌面版 normalizeChineseNumber 相同。 */
function normalizeChineseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const digit = Number(trimmed);
  if (Number.isFinite(digit) && digit >= 1 && digit <= 99) return Math.floor(digit);
  if (CHINESE_SMALL[trimmed] !== undefined) return CHINESE_SMALL[trimmed];
  if (trimmed.length === 2 && trimmed[0] === '十') {
    const ones = chineseToDigit(trimmed[1]);
    return ones !== null ? 10 + ones : 10;
  }
  if (trimmed.length === 3 && trimmed[1] === '十') {
    const tens = chineseToDigit(trimmed[0]);
    const ones = chineseToDigit(trimmed[2]);
    if (tens !== null && ones !== null) return tens * 10 + ones;
  }
  if (trimmed.length === 2 && trimmed[1] === '十') {
    const tens = chineseToDigit(trimmed[0]);
    if (tens !== null) return tens * 10;
  }
  return null;
}

// ---- 字符类（与桌面版正则中的字符类相同；正文按 UTF-16 码元处理，这些字符都在基本平面内） ----

const isAsciiDigit = (ch: string) => ch >= '0' && ch <= '9';
/** 总数声明的中文数字 [一二三四五六七八九十]。 */
const TOTAL_CHINESE = new Set('一二三四五六七八九十');
/** 标段定义的中文数字 [一二三四五六七八九十壹贰叁肆伍]。 */
const DEFINITION_CHINESE = new Set('一二三四五六七八九十壹贰叁肆伍');
const isDefinitionMixed = (ch: string) => DEFINITION_CHINESE.has(ch) || isAsciiDigit(ch);
/** 合并提及 [一二三四五六七八九十\d]。 */
const isCombinedNumeral = (ch: string) => TOTAL_CHINESE.has(ch) || isAsciiDigit(ch);
const DEFINITION_PUNCTUATION = new Set('：:；;');

/** 与正则 \s 相同（单个字符的判断，耗时与字符数成正比）。 */
const SPACE = /\s/;
const isSpace = (ch: string) => SPACE.test(ch);

/** 从 index 开始、字符类 test 的最长连续段的结束位置（不含）。 */
function runEnd(text: string, index: number, test: (ch: string) => boolean): number {
  let end = index;
  while (end < text.length && test(text[end]!)) end += 1;
  return end;
}

function skipSpaces(text: string, index: number): number {
  return runEnd(text, index, isSpace);
}

// ---- 按行取文本（与桌面版 getLineAt 相同：以 \n 分行，去掉首尾空白），按行缓存 ----

class Lines {
  private readonly breaks: number[] = [];
  private readonly cache = new Map<(line: string) => unknown, Map<number, unknown>>();

  private readonly text: string;

  constructor(text: string) {
    this.text = text;
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) this.breaks.push(index);
  }

  /** index 所在行的行号（从 0 起）。 */
  private lineOf(index: number): number {
    let low = 0;
    let high = this.breaks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.breaks[middle]! < index) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** 对 index 所在行（去掉首尾空白）计算 compute，同一行、同一个 compute 只计算一次。 */
  memo<T>(index: number, compute: (line: string) => T): T {
    const line = this.lineOf(index);
    let results = this.cache.get(compute);
    if (!results) this.cache.set(compute, (results = new Map()));
    if (results.has(line)) return results.get(line) as T;
    const start = line === 0 ? 0 : this.breaks[line - 1]! + 1;
    const end = line < this.breaks.length ? this.breaks[line]! : this.text.length;
    const value = compute(this.text.slice(start, end).trim());
    results.set(line, value);
    return value;
  }
}

// ---- 总数声明 ----

const TOTAL_UNITS = ['标段', '包', '分包', '标包', '标的', '子项目'] as const;

/**
 * 与桌面版 totalSectionPattern 的全部匹配相同。正则的前缀（本项目、共计、划分为等）都可省略，且不含数字和单位用字，
 * 不影响捕获的数字和单位；数字是 \d+ 或 [一…十]+ 的贪婪匹配，其后是 \s*个?\s* 和单位。每个最长数字段只有段首可能匹配
 * （段内其他位置前面是同类字符，正则从更靠左的段首已经匹配或失败；失败时缩短数字段，后面紧接的仍是数字，同样失败），
 * 捕获的是整段；匹配不会跨过别的数字段，所以按段判断与逐个匹配的结果相同。
 */
function scanTotalDeclarations(text: string): { declaredSections: number | null; declaredAny: number | null } {
  let declaredSections: number | null = null;
  let declaredAny: number | null = null;
  let index = 0;
  while (index < text.length) {
    const ch = text[index]!;
    const test = isAsciiDigit(ch) ? isAsciiDigit : TOTAL_CHINESE.has(ch) ? (c: string) => TOTAL_CHINESE.has(c) : null;
    if (!test) {
      index += 1;
      continue;
    }
    const end = runEnd(text, index, test);
    let cursor = skipSpaces(text, end);
    if (text[cursor] === '个') cursor = skipSpaces(text, cursor + 1);
    // 与正则的分支顺序相同：取第一个匹配的单位。
    const unit = TOTAL_UNITS.find((candidate) => text.startsWith(candidate, cursor));
    if (unit) {
      const count = normalizeChineseNumber(text.slice(index, end));
      if (count && count >= 2) {
        declaredAny = declaredAny === null ? count : Math.max(declaredAny, count);
        if (unit === '标段') declaredSections = declaredSections === null ? count : Math.max(declaredSections, count);
      }
    }
    index = end;
  }
  return { declaredSections, declaredAny };
}

// ---- 标段定义 ----

const DEFINITION_UNITS = ['标段', '标包', '分包', '包'] as const;

/**
 * 与桌面版 isCombinedSectionMention 相同（/[一…十\d]+[、,]\s*[一…十\d]+\s*(?:标段|标包|分包|包)/ 是否出现）：
 * 在每个“、”“,”处向左要求至少一个数字，向右跳过空白、取最长数字段、跳过空白后接单位。数字、空白、单位用字互不相交，
 * 贪婪匹配缩短时紧接的仍是同类字符，必然失败，所以只需检查最长段。
 */
function isCombinedSectionMention(line: string): boolean {
  for (let index = 1; index < line.length; index += 1) {
    const ch = line[index]!;
    if ((ch !== '、' && ch !== ',') || !isCombinedNumeral(line[index - 1]!)) continue;
    const start = skipSpaces(line, index + 1);
    const end = runEnd(line, start, isCombinedNumeral);
    if (end === start) continue;
    const cursor = skipSpaces(line, end);
    if (DEFINITION_UNITS.some((unit) => line.startsWith(unit, cursor))) return true;
  }
  return false;
}

function addLimited(set: Set<string>, value: string): void {
  if (set.size < BID_SECTION_DETECTION_SET_MAX) set.add(value);
}

/**
 * 与桌面版 sectionDefinitionPatterns 的 16 个正则相同，每个单位三种写法：
 * - `([中文数字]+)单位[：:；;]`、`(\d+)单位[：:；;]`：该字符类的每个最长段，紧接单位和标点时匹配，捕获整段；
 * - `第([中文数字或\d]+)单位[：:；;]`：每个“第”之后的最长混合段；
 * - `单位([中文数字或\d]+)[：:；;]`：每次出现单位之后的最长混合段（与正则相同，“标包3：”中的“包3：”也算“包”）。
 * 数字段、“第”、单位、标点互不相交，一次匹配之内不会出现另一处可匹配的起点，所以按段判断与正则逐个匹配的结果相同。
 * 匹配所在行是“一、二标段”这样的合并提及时不计入。
 */
function scanDefinitions(text: string, lines: Lines, definitions: Set<string>): void {
  const record = (unit: string, numeral: string, at: number) => {
    if (definitions.size >= BID_SECTION_DETECTION_SET_MAX) return;
    const index = normalizeChineseNumber(numeral);
    if (index && index >= 1 && !lines.memo(at, isCombinedSectionMention)) addLimited(definitions, `${unit}:${index}`);
  };
  const followedBy = (cursor: number, unit: string) => text.startsWith(unit, cursor) && DEFINITION_PUNCTUATION.has(text[cursor + unit.length] ?? '');

  // 前两种：中文数字段、阿拉伯数字段。
  for (const test of [(c: string) => DEFINITION_CHINESE.has(c), isAsciiDigit]) {
    let index = 0;
    while (index < text.length) {
      if (!test(text[index]!)) {
        index += 1;
        continue;
      }
      const end = runEnd(text, index, test);
      for (const unit of DEFINITION_UNITS) {
        if (followedBy(end, unit)) record(unit, text.slice(index, end), index);
      }
      index = end;
    }
  }
  // “第”之后。
  for (let at = text.indexOf('第'); at >= 0; at = text.indexOf('第', at + 1)) {
    const end = runEnd(text, at + 1, isDefinitionMixed);
    if (end === at + 1) continue;
    for (const unit of DEFINITION_UNITS) {
      if (followedBy(end, unit)) record(unit, text.slice(at + 1, end), at);
    }
  }
  // 单位之后。
  for (const unit of DEFINITION_UNITS) {
    for (let at = text.indexOf(unit); at >= 0; at = text.indexOf(unit, at + 1)) {
      const start = at + unit.length;
      const end = runEnd(text, start, isDefinitionMixed);
      if (end > start && DEFINITION_PUNCTUATION.has(text[end] ?? '')) record(unit, text.slice(start, end), at);
    }
  }
}

// ---- 行首【N】 ----

/** 与桌面版 isDocumentNumberLine 相同（这几个正则没有回溯问题，按行缓存后只对每行执行一次）。 */
function isDocumentNumberLine(line: string): boolean {
  return /[号文]$|^\s*【\d+】\d+\s*号/.test(line) || /号文/.test(line);
}

/** 正则 ^（多行模式）可以匹配的位置：开头和每个行终止符之后。 */
const LINE_TERMINATORS = new Set(['\n', '\r', ' ', ' ']);

/**
 * 与桌面版 bracketPattern（/^【(\d+)(?:-(\d+))?】/gm）相同：每个行首（正则的 ^ 在 \n、\r、 、  之后都成立）
 * 取“【”后的最长数字段，接“】”或“-数字段】”；所在行（以 \n 分行）是文号的不计入。
 */
function scanBrackets(text: string, lines: Lines, groups: Set<string>, children: Set<string>): void {
  for (let start = 0; start < text.length; start += 1) {
    if (start > 0 && !LINE_TERMINATORS.has(text[start - 1]!)) continue;
    if (text[start] !== '【') continue;
    const parentEnd = runEnd(text, start + 1, isAsciiDigit);
    if (parentEnd === start + 1) continue;
    let child: string | null = null;
    if (text[parentEnd] === '-') {
      const childEnd = runEnd(text, parentEnd + 1, isAsciiDigit);
      if (childEnd > parentEnd + 1 && text[childEnd] === '】') child = text.slice(parentEnd + 1, childEnd);
      else continue;
    } else if (text[parentEnd] !== '】') continue;
    const parentNum = parseInt(text.slice(start + 1, parentEnd), 10);
    if (!parentNum || parentNum < 1 || lines.memo(start, isDocumentNumberLine)) continue;
    const childNum = child === null ? null : parseInt(child, 10);
    if (childNum) addLimited(children, `${parentNum}-${childNum}`);
    else addLimited(groups, String(parentNum));
  }
}

// ---- 摘要与合并 ----

/** 一份招标文件（解析出的 Markdown）的检测摘要。耗时与正文长度成正比。 */
export function summarizeBidSectionDetection(markdown: string): BidSectionDetectionSummary {
  const text = String(markdown ?? '');
  const empty: BidSectionDetectionSummary = { version: 1, declaredSections: null, declaredAny: null, definitions: [], bracketGroups: [], bracketChildren: [] };
  if (!text.trim()) return empty;
  const lines = new Lines(text);
  const definitions = new Set<string>();
  const groups = new Set<string>();
  const children = new Set<string>();
  scanDefinitions(text, lines, definitions);
  scanBrackets(text, lines, groups, children);
  return { ...empty, ...scanTotalDeclarations(text), definitions: [...definitions], bracketGroups: [...groups], bracketChildren: [...children] };
}

const maxOf = (values: (number | null)[]) => values.reduce<number | null>((max, value) => (value === null ? max : max === null ? value : Math.max(max, value)), null);

/**
 * 合并各招标文件的摘要（与桌面版 detectBidSections 对合并正文的结果相同，见文件头）：有总数声明时以声明为准（优先单位是
 * “标段”的），否则看标段定义数、行首【N】的数量是否达到 2。没有任何文件时与桌面版对空正文的结果相同。
 */
export function combineBidSectionDetections(summaries: readonly BidSectionDetectionSummary[]): BidSectionDetection {
  const totalDeclared = maxOf(summaries.map((summary) => summary.declaredSections)) ?? maxOf(summaries.map((summary) => summary.declaredAny));
  if (totalDeclared === 1) return { hasMultiple: false, totalDeclared };
  if (totalDeclared && totalDeclared >= 2) return { hasMultiple: true, totalDeclared };
  const union = (pick: (summary: BidSectionDetectionSummary) => readonly string[]) => new Set(summaries.flatMap(pick)).size;
  const children = union((summary) => summary.bracketChildren);
  const detectedCount = Math.max(union((summary) => summary.definitions), children >= 2 ? children : union((summary) => summary.bracketGroups));
  return { hasMultiple: detectedCount >= 2, totalDeclared };
}

/** 单份正文的检测（测试中与桌面版 detectBidSections 对照）。 */
export function detectBidSections(markdown: string): BidSectionDetection {
  return combineBidSectionDetections([summarizeBidSectionDetection(markdown)]);
}

const KEY = /^[^\u0000-\u001f]{1,64}$/;

function parseCount(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 99) throw new TypeError('疑似多标段检测摘要不合法');
  return value;
}

function parseSet(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > BID_SECTION_DETECTION_SET_MAX) throw new TypeError('疑似多标段检测摘要不合法');
  const items = value.map((item) => {
    if (typeof item !== 'string' || !KEY.test(item)) throw new TypeError('疑似多标段检测摘要不合法');
    return item;
  });
  if (new Set(items).size !== items.length) throw new TypeError('疑似多标段检测摘要不合法');
  return items;
}

/** 校验摘要（写入前、读出时）；不合法时抛 TypeError。 */
export function parseBidSectionDetectionSummary(value: unknown): BidSectionDetectionSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('疑似多标段检测摘要不合法');
  const { version, declaredSections, declaredAny, definitions, bracketGroups, bracketChildren, ...rest } = value as Record<string, unknown>;
  if (version !== 1 || Object.keys(rest).length > 0) throw new TypeError('疑似多标段检测摘要不合法');
  return {
    version: 1,
    declaredSections: parseCount(declaredSections),
    declaredAny: parseCount(declaredAny),
    definitions: parseSet(definitions),
    bracketGroups: parseSet(bracketGroups),
    bracketChildren: parseSet(bracketChildren),
  };
}
