// 按上下文长度切分长文本（取代桌面版 utils/userTextSplitter.cjs，逻辑与切分点原样搬运）：长度按字符数（UTF-16 码元）计，
// 超过“上下文长度 × 比例”时切成长度相近的若干段，切点优先落在标题 / 空行，其次换行、句末、分号、逗号，不切开 Markdown 代码块
// 和代理对。任务据此决定是否分段调用模型（招标解析、废标检查等），同一输入的切分结果固定，续跑时请求内容不变。

/**
 * 默认上下文长度（字符）。与桌面版文本模型的默认值 DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT 相同；桌面版由用户按模型配置，
 * Web 版平台模型尚没有这项配置（路线图第 6 步“前面各步登记给第 6 步的事项”第 26 项），暂时全部使用默认值。
 */
export const DEFAULT_CONTEXT_LENGTH_LIMIT = 400_000;
const DEFAULT_CONTEXT_LIMIT_RATIO = 0.8;
const STRICT_WINDOW_RATIO = 0.12;
const RELAXED_WINDOW_RATIO = 0.25;
const MIN_SEGMENT_RATIO = 0.35;
const MAX_SEGMENT_LIMIT_RATIO = 1.1;

const BOUNDARY_GROUPS: readonly (readonly RegExp[])[] = [
  [/\r?\n(?=\s{0,3}#{1,6}\s+)/g, /\r?\n[ \t]*\r?\n/g],
  [/\r?\n/g],
  [/[。！？!?]/g],
  [/[；;]/g],
  [/[，,、：:]/g],
];

export interface SplitOptions {
  /** 上下文长度（字符），默认 DEFAULT_CONTEXT_LENGTH_LIMIT。 */
  contextLengthLimit?: number;
  /** 每段最多占上下文长度的比例，默认 0.8。 */
  limitRatio?: number;
  /** 找自然切点时单段最长可超出单段上限的比例，默认 1.1（知识库切开超长块时用 1，与桌面版相同）。 */
  maxSegmentLimitRatio?: number;
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function positiveRatio(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function collectMarkdownFenceRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const regex = /(^|\n)(```|~~~)/g;
  let openedAt = -1;
  let openedMarker = '';
  let match = regex.exec(text);
  while (match) {
    const markerStart = match.index + match[1]!.length;
    const marker = match[2]!;
    if (openedAt < 0) {
      openedAt = markerStart;
      openedMarker = marker;
    } else if (marker === openedMarker) {
      ranges.push([openedAt, markerStart + marker.length]);
      openedAt = -1;
      openedMarker = '';
    }
    match = regex.exec(text);
  }
  if (openedAt >= 0) ranges.push([openedAt, text.length]);
  return ranges;
}

function isInsideRange(index: number, ranges: readonly [number, number][]): boolean {
  for (const [start, end] of ranges) {
    if (index <= start) return false;
    if (index < end) return true;
  }
  return false;
}

function avoidsBreakingSurrogatePair(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const previous = text.charCodeAt(cut - 1);
  const next = text.charCodeAt(cut);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? cut + 1 : cut;
}

function clampHardCut(text: string, idealCut: number, previousCut: number, remainingSegments: number): number {
  const minimumCut = previousCut + 1;
  const maximumCut = text.length - remainingSegments;
  if (maximumCut < minimumCut) return Math.min(text.length, minimumCut);
  const clamped = Math.min(maximumCut, Math.max(minimumCut, Math.round(idealCut)));
  return avoidsBreakingSurrogatePair(text, clamped);
}

interface CutState {
  idealCut: number;
  previousCut: number;
  totalLength: number;
  remainingSegments: number;
  minimumSegmentLength: number;
  maximumSegmentLength: number;
}

function canUseCandidate(candidate: number, state: CutState): boolean {
  if (candidate <= state.previousCut || candidate >= state.totalLength) return false;
  const currentLength = candidate - state.previousCut;
  if (currentLength < state.minimumSegmentLength || currentLength > state.maximumSegmentLength) return false;
  if (state.remainingSegments > 0) {
    const remainingLength = state.totalLength - candidate;
    if (remainingLength < state.remainingSegments) return false;
    if (remainingLength / state.remainingSegments > state.maximumSegmentLength) return false;
  }
  return true;
}

function findBoundaryForGroup(text: string, from: number, to: number, group: readonly RegExp[], state: CutState, fences: readonly [number, number][]): number {
  let best: { cut: number; score: number } | null = null;
  const content = text.slice(from, to);
  for (const source of group) {
    const pattern = new RegExp(source.source, source.flags);
    let match = pattern.exec(content);
    while (match) {
      const candidate = from + match.index + match[0].length;
      if (!isInsideRange(candidate, fences) && canUseCandidate(candidate, state)) {
        const score = Math.abs(candidate - state.idealCut);
        if (!best || score < best.score) best = { cut: candidate, score };
      }
      if (!match[0]) pattern.lastIndex += 1;
      match = pattern.exec(content);
    }
  }
  return best?.cut ?? 0;
}

function findNaturalCut(text: string, state: CutState, fences: readonly [number, number][], radius: number): number {
  const from = Math.max(state.previousCut + 1, Math.floor(state.idealCut - radius));
  const to = Math.min(text.length - state.remainingSegments, Math.ceil(state.idealCut + radius));
  if (to <= from) return 0;
  for (const group of BOUNDARY_GROUPS) {
    const cut = findBoundaryForGroup(text, from, to, group, state, fences);
    if (cut) return cut;
  }
  return 0;
}

/** 切分文本；不超过单段上限时原样返回一段。各段首尾相接即原文。 */
export function splitTextByContextLimit(text: string, options: SplitOptions = {}): string[] {
  const source = String(text ?? '');
  const contextLengthLimit = positiveInteger(options.contextLengthLimit, DEFAULT_CONTEXT_LENGTH_LIMIT);
  const limitRatio = positiveRatio(options.limitRatio, DEFAULT_CONTEXT_LIMIT_RATIO);
  const segmentLimit = Math.max(1, Math.floor(contextLengthLimit * limitRatio));
  if (source.length <= segmentLimit) return [source];

  const segmentCount = Math.ceil(source.length / segmentLimit);
  const targetSize = Math.max(1, Math.ceil(source.length / segmentCount));
  const strictRadius = Math.max(1, Math.floor(targetSize * STRICT_WINDOW_RATIO));
  const relaxedRadius = Math.max(strictRadius, Math.floor(targetSize * RELAXED_WINDOW_RATIO));
  const maximumSegmentLength = Math.max(targetSize, Math.ceil(segmentLimit * positiveRatio(options.maxSegmentLimitRatio, MAX_SEGMENT_LIMIT_RATIO)));
  const minimumSegmentLength = Math.max(1, Math.floor(targetSize * MIN_SEGMENT_RATIO));
  const fences = collectMarkdownFenceRanges(source);
  const cuts: number[] = [];
  let previousCut = 0;
  for (let segmentIndex = 1; segmentIndex < segmentCount; segmentIndex += 1) {
    const state: CutState = {
      idealCut: (source.length * segmentIndex) / segmentCount,
      previousCut,
      totalLength: source.length,
      remainingSegments: segmentCount - segmentIndex,
      minimumSegmentLength,
      maximumSegmentLength,
    };
    const cut =
      findNaturalCut(source, state, fences, strictRadius) ||
      findNaturalCut(source, state, fences, relaxedRadius) ||
      clampHardCut(source, state.idealCut, previousCut, state.remainingSegments);
    cuts.push(cut);
    previousCut = cut;
  }
  const parts: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(source.slice(start, cut));
    start = cut;
  }
  parts.push(source.slice(start));
  return parts;
}
