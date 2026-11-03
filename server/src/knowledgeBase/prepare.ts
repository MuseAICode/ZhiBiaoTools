// 知识库文档准备的切块、分段与提示词（路线图第 6 步 6.13a）：从桌面版 knowledgeBaseService.cjs 原样搬运文档准备用到的部分
// （切块与筛选、统一分段、首轮提取与补充提取的提示词、候选条目整理），tests/knowledgeBase/prepare.test.ts 加载桌面版逐项对照。
// 段落匹配、遗漏补漏与保存结果用到的部分在 src/knowledgeBase/match.ts（6.13b）。
//
// 块在这里用 headingPath（与 src/knowledgeBase/content.ts 的 Store 相同），渲染进提示词时与桌面版的 heading_path 逐字相同。
import type { ChatMessage } from '../ai/providers.ts';
import { DEFAULT_CONTEXT_LENGTH_LIMIT, splitTextByContextLimit } from '../ai/textSplit.ts';

/** 超过这么多字的原始块切开（与桌面版 oversizedBlockChars 相同）。 */
const OVERSIZED_BLOCK_CHARS = 8000;
/** 语义合并的目标字数（与桌面版 semanticMergeTargetChars 相同）。 */
const SEMANTIC_MERGE_TARGET_CHARS = 500;
/** 一次请求最多占上下文长度的比例（与桌面版 KNOWLEDGE_CONTEXT_LIMIT_RATIO 相同）。 */
const KNOWLEDGE_CONTEXT_LIMIT_RATIO = 0.8;
/** 统一分段时预留给任务说明与条目的比例（与桌面版 TASK_AND_ITEMS_RESERVE_RATIO 相同）。 */
const TASK_AND_ITEMS_RESERVE_RATIO = 0.2;

export interface Block {
  id: string;
  type: string;
  headingPath: string[];
  content: string;
}

export interface FilteredBlock extends Block {
  reason: string;
}

export interface BlockSegment {
  blocks: Block[];
  blockIds: string[];
  text: string;
  chars: number;
  /** 从 1 开始。 */
  index: number;
  total: number;
}

export interface TitleSummaryItem {
  title: string;
  summary: string;
}

export interface CandidateItem extends TitleSummaryItem {
  id: string;
}

/** 与桌面版 stripMarkdownFence 相同：去掉开头一行 ``` 与结尾的 ```（解析出的 Markdown 写入前使用）。 */
export function stripMarkdownFence(content: string): string {
  return String(content || '')
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```$/g, '')
    .trim();
}

function splitOversizedText(text: string, limit: number): string[] {
  return splitTextByContextLimit(String(text || ''), { contextLengthLimit: limit, limitRatio: 1, maxSegmentLimitRatio: 1 })
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeRepeatedText(text: string): string {
  return String(text || '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[\-—_·.。:：|第页共]/g, '')
    .trim()
    .toLowerCase();
}

function isPageNumberBlock(text: string): boolean {
  const compact = String(text || '').trim().replace(/\s+/g, '');
  return /^[-—_]*\d+[-—_]*$/.test(compact) || /^第\d+页(共\d+页)?$/.test(compact) || /^\d+\/\d+$/.test(compact) || /^page\d+(of\d+)?$/i.test(compact);
}

function isCatalogBlock(text: string): boolean {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (/^(#+)?(目录|目次|contents)$/i.test(compact)) return true;
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  const catalogLines = lines.filter((line) => /(?:\.{2,}|…{2,}|·{2,}|\s{4,})\s*\d+\s*$/.test(line));
  return catalogLines.length >= Math.ceil(lines.length * 0.6);
}

const COVER_MARKERS = ['投标文件', '投标书', '正本', '副本', '项目名称', '招标编号', '投标人', '编制日期', '日期：', '日期:'];

function isCoverBlock(text: string, index: number): boolean {
  if (index > 12) return false;
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (!compact || compact.length > 220) return false;
  const hasMarker = COVER_MARKERS.some((marker) => compact.includes(marker));
  const hasLongSentence = /[。！？；]/.test(normalized) && normalized.length > 80;
  return hasMarker && !hasLongSentence;
}

function isSignatureBlock(text: string): boolean {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (!compact || compact.length > 260) return false;
  if (/(签字确认|用户签字|双方责任人.{0,12}签字)/.test(compact)) return false;
  return (
    /(盖章|签章|签名|法定代表人|授权代表|委托代理人|被授权人|年月日|投标人代表签字|代表签字)/.test(compact) && !/[。！？；].{20,}/.test(normalized)
  );
}

/** 去掉空白后的字数（与桌面版 getContentCharCount 相同，按 UTF-16 码元计）。 */
function contentCharCount(text: string): number {
  return String(text || '').replace(/\s+/g, '').length;
}

function stripBoldMarker(text: string): string {
  return String(text || '')
    .trim()
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .trim();
}

function isTableBlock(block: Block): boolean {
  return /^<table[\s>]/i.test(String(block.content || '').trim());
}

function isSemanticHeadingBlock(block: Block): boolean {
  const original = String(block.content || '').trim();
  const normalized = stripBoldMarker(original);
  const compactLength = contentCharCount(normalized);
  if (!normalized || compactLength > 100) return false;
  if (/[。！？；;]$/.test(normalized)) return false;
  return (
    /^\*\*.+\*\*$/.test(original) ||
    /^\d+(?:\.\d+)+\s*[^。！？；;]{1,80}$/.test(normalized) ||
    /^\d+\.\s*[^。！？；;]{1,80}$/.test(normalized) ||
    /^[一二三四五六七八九十]+[、.．]\s*[^。！？；;]{1,80}$/.test(normalized) ||
    /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳][、.．]?\s*[^。！？；;]{1,80}$/.test(normalized) ||
    /^（[一二三四五六七八九十]+）\s*[^。！？；;]{1,80}$/.test(normalized) ||
    /^第[一二三四五六七八九十\d]+[章节部分篇]\s*[^。！？；;]{0,80}$/.test(normalized)
  );
}

const rawId = (index: number) => `R${String(index).padStart(6, '0')}`;

/** Markdown 按标题、空行与类型变化切成原始块（与桌面版 createRawBlocks 相同）。 */
export function createRawBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = String(markdown || '').split(/\r?\n/);
  let buffer: string[] = [];
  let currentType = 'paragraph';
  const headings: string[] = [];

  const pushBuffer = () => {
    const content = buffer.join('\n').trim();
    if (!content) {
      buffer = [];
      return;
    }
    const chunks = content.length > OVERSIZED_BLOCK_CHARS ? splitOversizedText(content, Math.floor(OVERSIZED_BLOCK_CHARS * 0.75)) : [content];
    for (const chunk of chunks) {
      blocks.push({ id: rawId(blocks.length + 1), type: currentType, headingPath: headings.filter(Boolean), content: chunk });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      pushBuffer();
      const level = headingMatch[1]!.length;
      headings.splice(level - 1);
      headings[level - 1] = headingMatch[2]!.trim();
      currentType = 'heading';
      buffer = [line];
      pushBuffer();
      currentType = 'paragraph';
      continue;
    }
    if (!line.trim()) {
      pushBuffer();
      currentType = 'paragraph';
      continue;
    }
    const nextType = /^\s*\|.*\|\s*$/.test(line) ? 'table' : /^\s*(?:[-*+]\s+|\d+[.)、]\s+)/.test(line) ? 'list' : 'paragraph';
    if (buffer.length && currentType !== nextType && (currentType !== 'paragraph' || nextType !== 'paragraph')) pushBuffer();
    currentType = nextType;
    buffer.push(line);
  }
  pushBuffer();
  return blocks;
}

/** 短段落与标题合并到约 500 字（与桌面版 mergeSemanticBlocks 相同），表格单独成块。 */
export function mergeSemanticBlocks(rawBlocks: readonly Block[]): Block[] {
  const merged: Block[] = [];
  let buffer: Block[] = [];
  const bufferText = () => buffer.map((block) => block.content).join('\n\n');
  const bufferHasOnlyHeadings = () => buffer.length > 0 && buffer.every(isSemanticHeadingBlock);
  const flushBuffer = () => {
    if (!buffer.length) return;
    merged.push({
      ...buffer[0]!,
      id: rawId(merged.length + 1),
      type: buffer.some((block) => block.type === 'list') ? 'list' : 'paragraph',
      content: bufferText().trim(),
    });
    buffer = [];
  };
  const pushStandalone = (block: Block) => merged.push({ ...block, id: rawId(merged.length + 1) });

  for (const block of rawBlocks) {
    if (isTableBlock(block)) {
      flushBuffer();
      pushStandalone(block);
      continue;
    }
    if (isSemanticHeadingBlock(block)) {
      if (buffer.length && !bufferHasOnlyHeadings() && contentCharCount(bufferText()) >= 100) flushBuffer();
      buffer.push(block);
      continue;
    }
    if (!buffer.length && contentCharCount(block.content) >= SEMANTIC_MERGE_TARGET_CHARS) {
      pushStandalone(block);
      continue;
    }
    buffer.push(block);
    if (contentCharCount(bufferText()) >= SEMANTIC_MERGE_TARGET_CHARS) flushBuffer();
  }
  flushBuffer();
  return merged;
}

/** 筛掉空块、页码、过短、目录、重复页眉页脚、封面、签字页（与桌面版 filterBlocks 相同），保留的块编为 P000001 起。 */
export function filterBlocks(rawBlocks: readonly Block[]): { blocks: Block[]; filteredBlocks: FilteredBlock[] } {
  const repeatedCounts = new Map<string, number>();
  for (const block of rawBlocks) {
    const key = normalizeRepeatedText(block.content);
    if (key && key.length <= 80) repeatedCounts.set(key, (repeatedCounts.get(key) ?? 0) + 1);
  }
  const kept: Block[] = [];
  const filtered: FilteredBlock[] = [];
  rawBlocks.forEach((block, index) => {
    const repeatedKey = normalizeRepeatedText(block.content);
    const repeated = Boolean(repeatedKey) && repeatedKey.length <= 80 && (repeatedCounts.get(repeatedKey) ?? 0) >= 3;
    const reason = !String(block.content || '').trim()
      ? 'empty'
      : isPageNumberBlock(block.content)
        ? 'page_number'
        : contentCharCount(block.content) < 100
          ? 'too_short'
          : isCatalogBlock(block.content)
            ? 'catalog'
            : repeated
              ? 'repeated_header_footer'
              : isCoverBlock(block.content, index)
                ? 'cover'
                : isSignatureBlock(block.content)
                  ? 'signature_page'
                  : '';
    if (reason) {
      filtered.push({ ...block, reason });
      return;
    }
    kept.push({ ...block, id: `P${String(kept.length + 1).padStart(6, '0')}` });
  });
  return { blocks: kept, filteredBlocks: filtered };
}

/** 切块的完整流程：原始块 → 语义合并 → 筛选。 */
export function buildBlocks(markdown: string): { blocks: Block[]; filteredBlocks: FilteredBlock[] } {
  return filterBlocks(mergeSemanticBlocks(createRawBlocks(markdown)));
}

/** 块渲染进提示词的形式（与桌面版 renderBlocksForPrompt 逐字相同）。 */
export function renderBlocksForPrompt(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      const headingPath = block.headingPath?.length ? block.headingPath.join(' > ') : '无';
      return [`[${block.id}]`, `type: ${block.type}`, `heading_path: ${headingPath}`, 'text:', block.content].join('\n');
    })
    .join('\n\n');
}

/** 把块按渲染长度连续打包成段，不拆单个块（与桌面版 packBlocksIntoSegments 相同）。 */
export function packBlocksIntoSegments(blocks: readonly Block[], segmentLimit: number): BlockSegment[] {
  const limit = Math.max(1, Math.floor(Number(segmentLimit) || 1));
  if (!blocks.length) return [];
  const segments: Omit<BlockSegment, 'index' | 'total'>[] = [];
  let currentBlocks: Block[] = [];
  let currentChars = 0;
  const flush = () => {
    if (!currentBlocks.length) return;
    const text = renderBlocksForPrompt(currentBlocks);
    segments.push({ blocks: currentBlocks, blockIds: currentBlocks.map((block) => block.id), text, chars: text.length });
    currentBlocks = [];
    currentChars = 0;
  };
  for (const block of blocks) {
    const blockChars = renderBlocksForPrompt([block]).length;
    const nextChars = currentChars + (currentBlocks.length ? 2 : 0) + blockChars;
    if (currentBlocks.length && nextChars > limit) flush();
    currentBlocks.push(block);
    currentChars += (currentBlocks.length > 1 ? 2 : 0) + blockChars;
  }
  flush();
  return segments.map((segment, index) => ({ ...segment, index: index + 1, total: segments.length }));
}

/** 一次请求的预算（字符）：上下文长度 × 0.8（与桌面版 getRequestBudget 相同）。 */
export function requestBudget(contextLengthLimit: number = DEFAULT_CONTEXT_LENGTH_LIMIT): number {
  return Math.floor(contextLengthLimit * KNOWLEDGE_CONTEXT_LIMIT_RATIO);
}

export interface UnifiedSegments {
  segments: BlockSegment[];
  blockSegmentLimit: number;
  requestBudget: number;
  reserve: number;
}

/**
 * 统一分段（与桌面版 buildUnifiedBlockSegments 相同）：首轮提取、补充提取与匹配共用同一段表，每段的块前缀消息逐字相同，
 * 才能复用服务商的前缀缓存。预算的 20% 留给任务说明与条目。
 */
export function buildUnifiedBlockSegments(blocks: readonly Block[], contextLengthLimit: number = DEFAULT_CONTEXT_LENGTH_LIMIT): UnifiedSegments {
  const budget = requestBudget(contextLengthLimit);
  const reserve = Math.max(1, Math.floor(budget * TASK_AND_ITEMS_RESERVE_RATIO));
  const blockSegmentLimit = Math.max(1, budget - reserve);
  return { segments: packBlocksIntoSegments(blocks, blockSegmentLimit), blockSegmentLimit, requestBudget: budget, reserve };
}

// ---- 提示词（与桌面版逐字相同） ----

function renderCandidateItemsJson(items: readonly TitleSummaryItem[]): string {
  return JSON.stringify(
    items.map(({ title, summary }) => ({ title, summary })),
    null,
    2,
  );
}

/** 块前缀（L1）：首轮提取、补充提取与匹配共用，逐字相同才能命中前缀缓存。 */
export function buildDocumentBlocksPrefixMessage(blockText: string, segment: Pick<BlockSegment, 'index' | 'total'> | null = null): ChatMessage {
  const segmentLine = segment && segment.total > 1 ? `当前是第 ${segment.index}/${segment.total} 段。` : '当前文档仅此一段。';
  return {
    role: 'user',
    content: [
      '以下是接下来要处理的主要内容 block 列表，请先完整阅读理解。',
      '只能使用本段出现的 block id；不要假设未见过的其它段内容。',
      segmentLine,
      '<document_blocks>',
      blockText,
      '</document_blocks>',
    ].join('\n'),
  };
}

function buildInitialItemTaskMessage(documentName: string): ChatMessage {
  return {
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标资料知识库分析助手。你只负责从历史投标资料中提取对后续编写标书有复用价值的知识条目。',
      '任务：基于上文已给出的本段 block，提取有意义的知识条目数组。条目应覆盖技术方案、项目管理、质量、安全、进度、服务、应急、人员设备、类似业绩等可复用内容。',
      '本段没有可复用知识时必须返回 {"items":[]}。',
      '只返回 JSON：{"items":[{"title":"","summary":""}]}',
      '要求：title 简洁明确；summary 说明该条目可如何用于编写投标文件；不要输出 id、content、段落编号、Markdown 或解释文字。',
    ].join('\n'),
  };
}

export function buildInitialItemMessages(documentName: string, blockText: string, segment: Pick<BlockSegment, 'index' | 'total'> | null = null): ChatMessage[] {
  return [buildDocumentBlocksPrefixMessage(blockText, segment), buildInitialItemTaskMessage(documentName)];
}

function buildSupplementItemTaskMessage(documentName: string, firstItems: readonly TitleSummaryItem[]): ChatMessage {
  return {
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标资料知识库补漏助手。你只判断已有知识条目是否遗漏了重要主题，并补充缺失条目。',
      'first_round_items 是全文已有结果，不要重复首轮已有条目。',
      '任务：基于上文本段 block，只输出本段可见且首轮未覆盖的新增条目；如果没有遗漏，返回空 items 数组。',
      '只返回 JSON：{"items":[{"title":"","summary":""}]}',
      '如果没有新增条目，必须返回 {"items":[]}，这属于正常结果。',
      '不要重复已有条目，不要输出 id、content、段落编号、Markdown 或解释文字。',
      '',
      '<first_round_items>',
      renderCandidateItemsJson(firstItems),
      '</first_round_items>',
    ].join('\n'),
  };
}

export function buildSupplementItemMessages(
  documentName: string,
  blockText: string,
  firstItems: readonly TitleSummaryItem[],
  segment: Pick<BlockSegment, 'index' | 'total'> | null = null,
): ChatMessage[] {
  return [buildDocumentBlocksPrefixMessage(blockText, segment), buildSupplementItemTaskMessage(documentName, firstItems)];
}

// ---- 候选条目整理（模型输出是不可信数据，逐字段整理） ----

/** 与桌面版的 String(value || '') 相同：假值一律为空。 */
function text(value: unknown): string {
  return value ? String(value) : '';
}

/** 模型输出中的条目：title 与 summary（或 resume）都不为空的才保留（与桌面版 normalizeCandidateItems 相同）。 */
export function normalizeCandidateItems(parsed: unknown): TitleSummaryItem[] {
  const items = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return { title: text(record.title).trim(), summary: text(record.summary || record.resume).trim() };
    })
    .filter((item) => item.title && item.summary);
}

/** 分段提取的结果按标题（去掉空白、不区分大小写）去重合并（与桌面版 mergeTitleSummaryItems 相同）。 */
export function mergeTitleSummaryItems(itemLists: readonly (readonly TitleSummaryItem[])[]): TitleSummaryItem[] {
  const merged: TitleSummaryItem[] = [];
  const seen = new Set<string>();
  for (const item of itemLists.flat()) {
    const title = text(item?.title).trim();
    const summary = text(item?.summary || (item as { resume?: unknown } | undefined)?.resume).trim();
    const key = title.replace(/\s+/g, '').toLowerCase();
    if (!key || !summary || seen.has(key)) continue;
    seen.add(key);
    merged.push({ title, summary });
  }
  return merged;
}

/** 首轮与补充的条目按标题去重合并，编为 K000001 起（与桌面版 mergeCandidateItems 相同）。 */
export function mergeCandidateItems(firstItems: readonly TitleSummaryItem[], supplementItems: readonly TitleSummaryItem[]): CandidateItem[] {
  const merged: CandidateItem[] = [];
  const seen = new Set<string>();
  for (const item of [...firstItems, ...supplementItems]) {
    const key = item.title.replace(/\s+/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ id: `K${String(merged.length + 1).padStart(6, '0')}`, title: item.title, summary: item.summary });
  }
  return merged;
}
