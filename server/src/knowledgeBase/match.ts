// 知识库段落匹配、遗漏补漏与结果整理（路线图第 6 步 6.13b）：从桌面版 knowledgeBaseService.cjs 原样搬运匹配用到的部分
// （条目子批、匹配与补漏的提示词、区间整理、子批结果合并、最终条目与报告），tests/knowledgeBase/match.test.ts 加载桌面版逐项对照。
//
// 匹配结果（{ id, ranges, block_ids }）、补漏结果与报告保持桌面版的字段名：它们原样存进匹配批次与步骤结果（jsonb），
// 与桌面版的步骤结果逐项相同。
import type { ChatMessage } from '../ai/providers.ts';
import { buildDocumentBlocksPrefixMessage, renderBlocksForPrompt, requestBudget, type Block, type BlockSegment, type CandidateItem } from './prepare.ts';

/** 补漏最多几轮（与桌面版 recoveryMaxAttempts 相同）。 */
export const RECOVERY_MAX_ATTEMPTS = 2;

export type Range = [string, string];

export interface Match {
  id: string;
  ranges: Range[];
  block_ids: string[];
}

export interface RecoveredNewItem {
  title: string;
  summary: string;
  ranges: Range[];
  block_ids: string[];
}

export interface DiscardedBlocks {
  ranges: Range[];
  block_ids: string[];
  reason: string;
  /** 补漏第几轮舍弃的（recovery_N）。 */
  source?: string;
}

export interface SystemDiscarded {
  block_ids: string[];
  reason: string;
}

export interface RecoveryParsed {
  matches: Match[];
  new_items: RecoveredNewItem[];
  discarded: DiscardedBlocks[];
}

export interface RecoveryAttempt {
  attempt: number;
  missing_before_count: number;
  segment_count: number;
  matches: Match[];
  new_items: (CandidateItem & { ranges: Range[]; block_ids: string[] })[];
  discarded: DiscardedBlocks[];
}

/** 补漏步骤（recover_missing）的结果，与桌面版相同。 */
export interface RecoveryResult {
  items: CandidateItem[];
  matches: Match[];
  discarded: DiscardedBlocks[];
  system_discarded: SystemDiscarded[];
  recovery_attempts: RecoveryAttempt[];
}

export interface ItemSegment {
  items: CandidateItem[];
  itemIds: string[];
  text: string;
  chars: number;
  index: number;
  total: number;
}

/** 估算消息的总字符（role + content + 少量开销，与桌面版 getMessagesContentLength 相同）。 */
export function messagesContentLength(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + String(message.role || 'user').length + String(message.content || '').length + 64, 0);
}

function renderKnowledgeItemsJson(items: readonly Pick<CandidateItem, 'id' | 'title' | 'summary'>[]): string {
  return JSON.stringify(
    items.map(({ id, title, summary }) => ({ id, title, summary })),
    null,
    2,
  );
}

/** 把条目按 JSON 渲染长度打包成段（只在条目超出预算时使用，与桌面版 packItemsIntoSegments 相同）。 */
export function packItemsIntoSegments(items: readonly CandidateItem[], segmentLimit: number): ItemSegment[] {
  const limit = Math.max(1, Math.floor(Number(segmentLimit) || 1));
  if (!items.length) return [];
  const segments: Omit<ItemSegment, 'index' | 'total'>[] = [];
  let currentItems: CandidateItem[] = [];
  let currentChars = 0;
  const flush = () => {
    if (!currentItems.length) return;
    const text = renderKnowledgeItemsJson(currentItems);
    segments.push({ items: currentItems, itemIds: currentItems.map((item) => item.id), text, chars: text.length });
    currentItems = [];
    currentChars = 0;
  };
  for (const item of items) {
    const itemChars = renderKnowledgeItemsJson([item]).length;
    const nextChars = currentChars + (currentItems.length ? 2 : 0) + itemChars;
    if (currentItems.length && nextChars > limit) flush();
    currentItems.push(item);
    currentChars += (currentItems.length > 1 ? 2 : 0) + itemChars;
  }
  flush();
  return segments.map((segment, index) => ({ ...segment, index: index + 1, total: segments.length }));
}

/** 条目侧可用的预算：请求预算减去已定的前缀与任务消息（与桌面版 getItemSplitBudget 相同）。 */
export function itemSplitBudget(contextLengthLimit: number, prefixMessages: readonly ChatMessage[]): number {
  return Math.max(1, requestBudget(contextLengthLimit) - messagesContentLength(prefixMessages));
}

// ---- 提示词（与桌面版逐字相同） ----

/** 遗漏块前缀：补漏单独打包，不与全文段混用。 */
export function buildMissingBlocksPrefixMessage(missingBlocks: readonly Block[], segment: Pick<BlockSegment, 'index' | 'total'> | null = null): ChatMessage {
  const segmentLine = segment && segment.total > 1 ? `当前是第 ${segment.index}/${segment.total} 段遗漏 block。` : '以下是当前需要处理的遗漏 block。';
  return {
    role: 'user',
    content: [
      '以下是接下来要处理的遗漏 block 列表，请先完整阅读理解。',
      '必须覆盖本段收到的全部遗漏 block；只能使用本段出现的 block id。',
      segmentLine,
      '<missing_blocks>',
      renderBlocksForPrompt(missingBlocks),
      '</missing_blocks>',
    ].join('\n'),
  };
}

export function buildMatchTaskMessage(documentName: string, batchItems: readonly CandidateItem[]): ChatMessage {
  return {
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标知识库段落匹配助手。你只根据知识条目的标题和摘要，为其匹配强相关 block 范围。',
      '规则：',
      '1. 只处理本次给出的知识条目。',
      '2. 只匹配与条目强相关、可直接支撑该条目的 block（基于上文本段 block）。',
      '3. 如果某些 block 更可能属于其他主题或条目，不要强行匹配。',
      '4. 只返回 id 和 ranges，不要输出正文，不要解释。',
      '5. ranges 使用闭区间：["P000001","P000003"] 表示连续 block；单个 block 写成 ["P000001","P000001"]。',
      '6. 只允许使用本段存在的 block 编号和本次条目 id。',
      '输出 JSON：{"matches":[{"id":"K000001","ranges":[["P000001","P000003"]]}]}',
      '',
      '以下是本次需要匹配的知识条目。只处理这些条目：',
      renderKnowledgeItemsJson(batchItems),
    ].join('\n'),
  };
}

/** 匹配：块前缀在前（与提取共用，逐字相同），任务与条目在后；条目子批只改后者。 */
export function buildMatchMessages(
  documentName: string,
  blockText: string,
  batchItems: readonly CandidateItem[],
  segment: Pick<BlockSegment, 'index' | 'total'> | null = null,
): ChatMessage[] {
  return [buildDocumentBlocksPrefixMessage(blockText, segment), buildMatchTaskMessage(documentName, batchItems)];
}

export function buildRecoveryTaskMessage(documentName: string, items: readonly CandidateItem[]): ChatMessage {
  return {
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标知识库遗漏段落补漏助手。必须把上文收到的遗漏 block 明确归入已有条目、新增条目或舍弃段落。',
      '任务：必须覆盖所有遗漏 block。每个遗漏 block 只能进入以下三类之一：',
      '1. matches：归入已有知识条目，只返回已有 id 和 ranges。',
      '2. new_items：如果没有合适的已有条目但内容有复用价值，则新增知识条目，并给出 title、summary、ranges。',
      '3. discarded：如果内容质量低、重复、格式残留或无投标复用价值，则推荐舍弃，并给出 reason。',
      '输出 JSON：{"matches":[{"id":"K000001","ranges":[["P000001","P000003"]]}],"new_items":[{"title":"","summary":"","ranges":[["P000004","P000005"]]}],"discarded":[{"ranges":[["P000006","P000006"]],"reason":""}]}',
      '不要输出正文、Markdown 或解释文字。',
      '只能使用本段存在的 block 编号和本次给出的条目 id。',
      '',
      '<knowledge_items>',
      renderKnowledgeItemsJson(items),
      '</knowledge_items>',
    ].join('\n'),
  };
}

/** 补漏：遗漏块前缀在前，任务与条目在后。 */
export function buildRecoveryMessages(
  documentName: string,
  items: readonly CandidateItem[],
  missingBlocks: readonly Block[],
  segment: Pick<BlockSegment, 'index' | 'total'> | null = null,
): ChatMessage[] {
  return [buildMissingBlocksPrefixMessage(missingBlocks, segment), buildRecoveryTaskMessage(documentName, items)];
}

// ---- 区间整理（模型输出是不可信数据，只保留本段存在的块与本次给出的条目） ----

export function blockOrderOf(blocks: readonly Block[]): Map<string, number> {
  return new Map(blocks.map((block, index) => [block.id, index]));
}

/** 与桌面版的 String(value || '') 相同：假值一律为空。 */
function text(value: unknown): string {
  return value ? String(value) : '';
}

function normalizeRangePair(range: unknown): Range | null {
  if (Array.isArray(range)) {
    const start = text(range[0]).trim();
    const end = text(range[1] || range[0]).trim();
    return start ? [start, end] : null;
  }
  const id = text(range).trim();
  return id ? [id, id] : null;
}

/** 区间两端都必须是本段的块，起止颠倒时交换（与桌面版 normalizeRanges 相同）。 */
export function normalizeRanges(ranges: unknown, blockOrder: ReadonlyMap<string, number>): Range[] {
  if (!Array.isArray(ranges)) return [];
  const normalized: Range[] = [];
  for (const range of ranges) {
    const pair = normalizeRangePair(range);
    if (!pair) continue;
    let [start, end] = pair;
    if (!blockOrder.has(start) || !blockOrder.has(end)) continue;
    if (blockOrder.get(start)! > blockOrder.get(end)!) [start, end] = [end, start];
    normalized.push([start, end]);
  }
  return normalized;
}

export function expandRanges(ranges: readonly Range[], blocks: readonly Block[], blockOrder: ReadonlyMap<string, number>): string[] {
  const ids: string[] = [];
  for (const [start, end] of ranges) {
    const startIndex = blockOrder.get(start);
    const endIndex = blockOrder.get(end);
    if (startIndex === undefined || endIndex === undefined) continue;
    for (let index = startIndex; index <= endIndex; index += 1) ids.push(blocks[index]!.id);
  }
  return [...new Set(ids)];
}

/** 块 id 按顺序压成闭区间（与桌面版 compressBlockIdsToRanges 相同）。 */
export function compressBlockIdsToRanges(blockIds: readonly string[], blockOrder: ReadonlyMap<string, number>): Range[] {
  const ordered = [...new Set(blockIds)].filter((id) => blockOrder.has(id)).sort((a, b) => blockOrder.get(a)! - blockOrder.get(b)!);
  if (!ordered.length) return [];
  const ranges: Range[] = [];
  let start = ordered[0]!;
  let prev = ordered[0]!;
  for (const id of ordered.slice(1)) {
    if (blockOrder.get(id) === blockOrder.get(prev)! + 1) {
      prev = id;
      continue;
    }
    ranges.push([start, prev]);
    start = id;
    prev = id;
  }
  ranges.push([start, prev]);
  return ranges;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

/** 匹配输出：只保留本次条目、区间有效的匹配（与桌面版 normalizeMatchResult 相同）。 */
export function normalizeMatchResult(parsed: unknown, itemIds: ReadonlySet<string>, blocks: readonly Block[], blockOrder: ReadonlyMap<string, number>): { matches: Match[] } {
  const matches = record(parsed).matches;
  return {
    matches: (Array.isArray(matches) ? matches : [])
      .map((value): Match | null => {
        const match = record(value);
        const id = text(match.id).trim();
        const ranges = normalizeRanges(match.ranges || match.paragraph_ranges || match.block_ranges || [], blockOrder);
        return itemIds.has(id) && ranges.length ? { id, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
      })
      .filter((match): match is Match => match !== null),
  };
}

/** 补漏输出：已有条目的匹配、新增条目与舍弃（与桌面版 normalizeRecoveryResult 相同）。 */
export function normalizeRecoveryResult(parsed: unknown, itemIds: ReadonlySet<string>, blocks: readonly Block[], blockOrder: ReadonlyMap<string, number>): RecoveryParsed {
  const source = record(parsed);
  const list = (value: unknown) => (Array.isArray(value) ? value : []).map(record);
  return {
    matches: list(source.matches)
      .map((match): Match | null => {
        const id = text(match.id).trim();
        const ranges = normalizeRanges(match.ranges || [], blockOrder);
        return itemIds.has(id) && ranges.length ? { id, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
      })
      .filter((match): match is Match => match !== null),
    new_items: list(source.new_items)
      .map((item): RecoveredNewItem | null => {
        const title = text(item.title).trim();
        const summary = text(item.summary || item.resume).trim();
        const ranges = normalizeRanges(item.ranges || [], blockOrder);
        return title && summary && ranges.length ? { title, summary, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
      })
      .filter((item): item is RecoveredNewItem => item !== null),
    discarded: list(source.discarded)
      .map((item): DiscardedBlocks | null => {
        const ranges = normalizeRanges(item.ranges || [], blockOrder);
        return ranges.length
          ? { ranges, block_ids: expandRanges(ranges, blocks, blockOrder), reason: text(item.reason || 'AI 建议舍弃').trim() || 'AI 建议舍弃' }
          : null;
      })
      .filter((item): item is DiscardedBlocks => item !== null),
  };
}

// ---- 合并 ----

/** 合并同一条目的区间与块（与桌面版 mergeMatchResults 相同）。 */
export function mergeMatchResults(matchLists: readonly (readonly Match[])[]): Match[] {
  const byId = new Map<string, Match>();
  for (const match of matchLists.flat()) {
    if (!match?.id) continue;
    const current = byId.get(match.id) ?? { id: match.id, ranges: [], block_ids: [] };
    if (Array.isArray(match.ranges)) current.ranges.push(...match.ranges);
    if (Array.isArray(match.block_ids)) current.block_ids.push(...match.block_ids);
    byId.set(match.id, current);
  }
  return [...byId.values()].map((match) => ({ id: match.id, ranges: match.ranges, block_ids: [...new Set(match.block_ids)] }));
}

/** 补漏多个条目子批时，每个块只保留一种归属：matches > new_items > discarded（与桌面版 mergeRecoverySegmentResults 相同）。 */
export function mergeRecoverySegmentResults(
  parsedList: readonly RecoveryParsed[],
  itemIds: ReadonlySet<string>,
  blockOrder: ReadonlyMap<string, number>,
): RecoveryParsed {
  type Ownership = { kind: 'match'; payload: string } | { kind: 'new_item' | 'discarded'; payload: unknown };
  const ownership = new Map<string, Ownership>();
  const matchRangesByItem = new Map<string, { ranges: Range[]; block_ids: string[] }>();
  const newItems: RecoveredNewItem[] = [];
  const discarded: DiscardedBlocks[] = [];
  const claimBlock = (blockId: string, owner: Ownership) => {
    if (!blockId || ownership.has(blockId)) return false;
    ownership.set(blockId, owner);
    return true;
  };

  // 必须全局按优先级认领，避免子批顺序导致 discarded 抢先占住 matches。
  for (const parsed of parsedList) {
    for (const match of parsed.matches || []) {
      const claimedIds = (match.block_ids || []).filter((blockId) => claimBlock(blockId, { kind: 'match', payload: match.id }));
      if (!claimedIds.length) continue;
      const current = matchRangesByItem.get(match.id) ?? { ranges: [], block_ids: [] };
      current.ranges.push(...(match.ranges || []));
      current.block_ids.push(...claimedIds);
      matchRangesByItem.set(match.id, current);
    }
  }
  for (const parsed of parsedList) {
    for (const item of parsed.new_items || []) {
      const claimedIds = (item.block_ids || []).filter((blockId) => claimBlock(blockId, { kind: 'new_item', payload: item }));
      if (!claimedIds.length) continue;
      newItems.push({ title: item.title, summary: item.summary, ranges: item.ranges || [], block_ids: claimedIds });
    }
  }
  for (const parsed of parsedList) {
    for (const item of parsed.discarded || []) {
      const claimedIds = (item.block_ids || []).filter((blockId) => claimBlock(blockId, { kind: 'discarded', payload: item }));
      if (!claimedIds.length) continue;
      discarded.push({ ranges: item.ranges || [], block_ids: claimedIds, reason: item.reason || 'AI 建议舍弃' });
    }
  }

  // 以认领后的块为准再压成区间，避免模型给出的脏区间再展开串段。
  const matches = [...matchRangesByItem.entries()]
    .map(([id, value]): Match | null => {
      if (!itemIds.has(id)) return null;
      const blockIds = [...new Set(value.block_ids)].filter((blockId) => {
        const owner = ownership.get(blockId);
        return owner?.kind === 'match' && owner.payload === id;
      });
      const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
      return ranges.length && blockIds.length ? { id, ranges, block_ids: blockIds } : null;
    })
    .filter((match): match is Match => match !== null);
  return {
    matches,
    new_items: newItems
      .map((item) => {
        const blockIds = [...new Set(item.block_ids)];
        return { title: item.title, summary: item.summary, ranges: compressBlockIdsToRanges(blockIds, blockOrder), block_ids: blockIds };
      })
      .filter((item) => item.ranges.length && item.block_ids.length),
    discarded: discarded
      .map((item) => {
        const blockIds = [...new Set(item.block_ids)];
        return { ranges: compressBlockIdsToRanges(blockIds, blockOrder), block_ids: blockIds, reason: item.reason };
      })
      .filter((item) => item.ranges.length && item.block_ids.length),
  };
}

/** 以给定的块为准重新压成区间，丢掉不在 blockOrder 中的块与没有块的匹配（桌面版匹配与补漏合并后的整理）。 */
export function recompressMatches(matches: readonly Match[], blockOrder: ReadonlyMap<string, number>, itemIds?: ReadonlySet<string>): Match[] {
  return matches
    .map((match): Match | null => {
      if (itemIds && !itemIds.has(match.id)) return null;
      const blockIds = [...new Set(match.block_ids || [])].filter((id) => blockOrder.has(id));
      const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
      return ranges.length ? { id: match.id, ranges, block_ids: blockIds } : null;
    })
    .filter((match): match is Match => match !== null);
}

// ---- 遗漏、最终条目与报告 ----

function collectHandledBlockIds(matches: readonly Match[], discarded: readonly DiscardedBlocks[], systemDiscarded: readonly SystemDiscarded[]): Set<string> {
  const handled = new Set<string>();
  for (const group of [...matches, ...discarded, ...systemDiscarded]) for (const id of group.block_ids) handled.add(id);
  return handled;
}

/** 还没有归入条目、也没有舍弃的块（与桌面版 getMissingBlocks 相同）。 */
export function missingBlocksOf(
  blocks: readonly Block[],
  matches: readonly Match[],
  discarded: readonly DiscardedBlocks[],
  systemDiscarded: readonly SystemDiscarded[],
): Block[] {
  const handled = collectHandledBlockIds(matches, discarded, systemDiscarded);
  return blocks.filter((block) => !handled.has(block.id));
}

/** 下一个条目 id：现有 K 编号的最大值加一（与桌面版 nextKnowledgeItemId 相同）。 */
export function nextKnowledgeItemId(items: readonly CandidateItem[]): string {
  let max = 0;
  for (const item of items) {
    const match = /^K(\d+)$/.exec(item.id || '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `K${String(max + 1).padStart(6, '0')}`;
}

export interface FinalItem {
  id: string;
  title: string;
  resume: string;
  content: string;
  sourceBlockIds: string[];
  sourceFile: string;
}

/** 按匹配回填正文，没有正文的条目丢弃（与桌面版 createFinalItems 相同）。 */
export function createFinalItems(items: readonly CandidateItem[], matches: readonly Match[], blocks: readonly Block[], fileName: string): FinalItem[] {
  const blockMap = new Map(blocks.map((block) => [block.id, block]));
  const blocksByItem = new Map<string, string[]>();
  for (const match of matches) {
    blocksByItem.set(match.id, [...new Set([...(blocksByItem.get(match.id) ?? []), ...match.block_ids])]);
  }
  return items
    .map((item) => {
      const sourceBlockIds = blocksByItem.get(item.id) ?? [];
      const content = sourceBlockIds
        .map((id) => blockMap.get(id)?.content || '')
        .filter(Boolean)
        .join('\n\n')
        .trim();
      return { id: item.id, title: item.title, resume: item.summary, content, sourceBlockIds, sourceFile: fileName };
    })
    .filter((item) => item.content);
}

/** 报告（与桌面版 createReport 相同的字段，存进 save_result 步骤结果）。 */
export interface MatchReport {
  total_blocks: number;
  filtered_blocks_count: number;
  candidate_items_count: number;
  final_items_count: number;
  matched_blocks_count: number;
  discarded_blocks_count: number;
  system_discarded_after_retry_count: number;
  new_items_from_recovery_count: number;
  recovery_attempt_count: number;
  batch_size: number;
  coverage_rate: number;
  matched_rate: number;
  created_at: string;
}

export function createReport(input: {
  blocks: readonly Block[];
  filteredBlockCount: number;
  candidateItems: readonly CandidateItem[];
  finalItems: readonly FinalItem[];
  matches: readonly Match[];
  discarded: readonly DiscardedBlocks[];
  systemDiscarded: readonly SystemDiscarded[];
  recoveryAttempts: readonly RecoveryAttempt[];
  batchSize: number;
}): MatchReport {
  const ids = (groups: readonly { block_ids: string[] }[]) => new Set(groups.flatMap((group) => group.block_ids));
  const matched = ids(input.matches);
  const discarded = ids(input.discarded);
  const system = ids(input.systemDiscarded);
  const handled = new Set([...matched, ...discarded, ...system]);
  const total = input.blocks.length || 1;
  return {
    total_blocks: input.blocks.length,
    filtered_blocks_count: input.filteredBlockCount,
    candidate_items_count: input.candidateItems.length,
    final_items_count: input.finalItems.length,
    matched_blocks_count: matched.size,
    discarded_blocks_count: discarded.size,
    system_discarded_after_retry_count: system.size,
    new_items_from_recovery_count: input.recoveryAttempts.reduce((sum, attempt) => sum + attempt.new_items.length, 0),
    recovery_attempt_count: input.recoveryAttempts.length,
    batch_size: input.batchSize,
    coverage_rate: Number((handled.size / total).toFixed(4)),
    matched_rate: Number((matched.size / total).toFixed(4)),
    created_at: new Date().toISOString(),
  };
}

/** 补漏步骤结果的形状检查（与桌面版 isRecoveryStepResult 相同）。 */
export function isRecoveryResult(value: unknown): value is RecoveryResult {
  const result = record(value);
  return ['items', 'matches', 'discarded', 'system_discarded', 'recovery_attempts'].every((field) => Array.isArray(result[field]));
}
