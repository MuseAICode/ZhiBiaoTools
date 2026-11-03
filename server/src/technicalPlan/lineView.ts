// 带行号的 Markdown 视图（取代桌面版 utils/markdownLineView.cjs 的 numberMarkdownLines，多标段识别把招标正文按此格式交给模型）：
// 每个真实的物理行加稳定行号“L000001 | ”，超过 2000 字的行切成多个分片“L000001[1/3] | ”，切点优先落在表格、HTML 与自然语言
// 边界，不切开 Markdown 图片和 HTML 标签。输出与桌面版相同（tests/technicalPlan/lineView.test.ts 加载桌面版文件对照）。
//
// 与桌面版的差别只在病态输入上：桌面版对一行中的每个“![”都从该处向后扫描到行尾找配对的括号，一行很长、“![”很多时是平方级。
// 这里方括号的配对一次扫描算出（与逐个扫描的结果相同）；图片目标的圆括号扫描（含引号规则，与起点有关）在一行内共用一份
// 步数预算（行长的 4 倍再加 10 万步），用完后该行其余的图片不再保护（只影响超长行的切点，不丢字符、不改顺序）。正常文档
// 远用不完预算。任务在 worker 中执行，处理很长的正文时每 2,000 行让出一次事件循环（任务租约靠定时器续期）。

const DEFAULT_MAX_LINE_CHARS = 2000;
const MIN_NATURAL_FRAGMENT_RATIO = 0.55;
const YIELD_EVERY_LINES = 2000;

type Range = [number, number];

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && end > start).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Range[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range[0] >= previous[1]) merged.push([range[0], range[1]]);
    else previous[1] = Math.max(previous[1], range[1]);
  }
  return merged;
}

/** 当前位置是否被奇数个反斜杠转义（按行预先算出，与桌面版 isEscaped 相同）。 */
function escapedFlags(text: string): Uint8Array {
  const flags = new Uint8Array(text.length);
  let slashes = 0;
  for (let index = 0; index < text.length; index += 1) {
    flags[index] = slashes % 2 === 1 ? 1 : 0;
    slashes = text[index] === '\\' ? slashes + 1 : 0;
  }
  return flags;
}

/**
 * 每个“[”配对的“]”位置（与桌面版 findClosingSquareBracket 从该处起按深度扫描的结果相同：没有被转义的“[”入栈，
 * “]”与栈顶配对，栈空时的“]”在任何起点的扫描中都不会被用到），没有配对时为 -1。
 */
function squareBracketPairs(text: string, escaped: Uint8Array): Int32Array {
  const pairs = new Int32Array(text.length).fill(-1);
  const stack: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (escaped[index]) continue;
    if (text[index] === '[') stack.push(index);
    else if (text[index] === ']' && stack.length) pairs[stack.pop()!] = index;
  }
  return pairs;
}

const SPACE_CHAR = /\s/u;

/** 与桌面版 findClosingParenthesis 相同；budget 用完时返回 -1 并把 budget.exhausted 置为 true。 */
function findClosingParenthesis(text: string, start: number, escaped: Uint8Array, budget: { steps: number; exhausted: boolean }): number {
  let depth = 0;
  let quote = '';
  for (let index = start; index < text.length; index += 1) {
    if (--budget.steps < 0) {
      budget.exhausted = true;
      return -1;
    }
    const character = text[index]!;
    if (escaped[index]) continue;
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if ((character === '"' || character === "'") && depth === 1 && SPACE_CHAR.test(text[index - 1] || '')) {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')' && --depth === 0) {
      return index;
    }
  }
  return -1;
}

/** 与桌面版 collectMarkdownImageRanges 相同（见文件头的预算说明）。 */
function collectMarkdownImageRanges(line: string): Range[] {
  const ranges: Range[] = [];
  const escaped = escapedFlags(line);
  const pairs = squareBracketPairs(line, escaped);
  const budget = { steps: line.length * 4 + 100_000, exhausted: false };
  for (let index = 0; index < line.length - 1; index += 1) {
    if (line[index] !== '!' || line[index + 1] !== '[' || escaped[index]) continue;
    // 这里的“[”紧跟在“!”或“]”之后，不会被转义。
    const altEnd = pairs[index + 1]!;
    if (altEnd < 0) continue;
    let end = altEnd + 1;
    if (line[end] === '(') {
      if (budget.exhausted) continue;
      const targetEnd = findClosingParenthesis(line, end, escaped, budget);
      if (targetEnd < 0) continue;
      end = targetEnd + 1;
    } else if (line[end] === '[') {
      const referenceEnd = pairs[end]!;
      if (referenceEnd < 0) continue;
      end = referenceEnd + 1;
    }
    ranges.push([index, end]);
    index = end - 1;
  }
  return ranges;
}

/** 与桌面版 collectHtmlTagRanges 相同（每个字符最多扫描一次）。 */
function collectHtmlTagRanges(line: string): Range[] {
  const ranges: Range[] = [];
  let start = line.indexOf('<');
  while (start >= 0) {
    if (line.startsWith('<!--', start)) {
      const commentEnd = line.indexOf('-->', start + 4);
      if (commentEnd < 0) break;
      ranges.push([start, commentEnd + 3]);
      start = line.indexOf('<', commentEnd + 3);
      continue;
    }
    let quote = '';
    let end = -1;
    for (let index = start + 1; index < line.length; index += 1) {
      const character = line[index];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        end = index + 1;
        break;
      }
    }
    if (end < 0) break;
    ranges.push([start, end]);
    start = line.indexOf('<', end);
  }
  return ranges;
}

function collectProtectedRanges(line: string): Range[] {
  return mergeRanges([...collectMarkdownImageRanges(line), ...collectHtmlTagRanges(line)]);
}

function protectedRangeAt(ranges: Range[], cut: number): Range | undefined {
  let left = 0;
  let right = ranges.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const range = ranges[middle]!;
    if (cut <= range[0]) right = middle - 1;
    else if (cut >= range[1]) left = middle + 1;
    else return range;
  }
  return undefined;
}

function safeUnicodeCut(line: string, cut: number, start: number): number {
  if (cut <= start || cut >= line.length) return cut;
  const previous = line.charCodeAt(cut - 1);
  const next = line.charCodeAt(cut);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return cut - 1 > start ? cut - 1 : Math.min(line.length, cut + 1);
  }
  return cut;
}

const NATURAL_BOUNDARY = /\s|[。！？!?；;，,、：:]/u;

function findPreferredCut(line: string, start: number, target: number, ranges: Range[]): number {
  const minimum = start + Math.max(1, Math.floor((target - start) * MIN_NATURAL_FRAGMENT_RATIO));
  const isAvailable = (cut: number) => !protectedRangeAt(ranges, cut);
  for (let cut = target; cut >= minimum; cut -= 1) {
    if (!isAvailable(cut)) continue;
    const before = line[cut - 1] || '';
    const around = line.slice(Math.max(start, cut - 6), cut).toLowerCase();
    if ((before === '|' && line[cut - 2] !== '\\') || before === '>' || around.endsWith('</td>') || around.endsWith('</th>') || around.endsWith('</tr>')) {
      return safeUnicodeCut(line, cut, start);
    }
  }
  for (let cut = target; cut >= minimum; cut -= 1) {
    if (!isAvailable(cut)) continue;
    if (NATURAL_BOUNDARY.test(line[cut - 1] || '')) return safeUnicodeCut(line, cut, start);
  }
  const protectedRange = protectedRangeAt(ranges, target);
  if (protectedRange) return protectedRange[0] > start ? protectedRange[0] : protectedRange[1];
  return safeUnicodeCut(line, target, start);
}

function splitLongLine(line: string, maxLineChars: number): string[] {
  if (line.length <= maxLineChars) return [line];
  const ranges = collectProtectedRanges(line);
  const parts: string[] = [];
  let start = 0;
  while (start < line.length) {
    const target = Math.min(line.length, start + maxLineChars);
    if (target >= line.length) {
      parts.push(line.slice(start));
      break;
    }
    let cut = findPreferredCut(line, start, target, ranges);
    if (cut <= start) cut = safeUnicodeCut(line, target, start);
    parts.push(line.slice(start, cut));
    start = cut;
  }
  return parts;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 与桌面版 numberMarkdownLines 相同（换行统一为 \n，行号从 1 起）。 */
export async function numberMarkdownLines(markdown: string, options: { maxLineChars?: number } = {}): Promise<string> {
  const requested = Number(options.maxLineChars);
  const maxLineChars = Number.isFinite(requested) && requested > 0 ? Math.max(1, Math.floor(requested)) : DEFAULT_MAX_LINE_CHARS;
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0 && index % YIELD_EVERY_LINES === 0) await yieldToEventLoop();
    const lineId = `L${String(index + 1).padStart(6, '0')}`;
    const parts = splitLongLine(lines[index]!, maxLineChars);
    if (parts.length === 1) output.push(`${lineId} | ${parts[0]}`);
    else for (const [partIndex, part] of parts.entries()) output.push(`${lineId}[${partIndex + 1}/${parts.length}] | ${part}`);
  }
  return output.join('\n');
}
