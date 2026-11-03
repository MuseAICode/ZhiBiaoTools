// 多标段识别（路线图第 6 步 6.11；取代桌面版 bidSectionExtractionTask.cjs 的提示词、结果整理与流程，原样搬运，
// tests/technicalPlan/sectionExtraction.test.ts 加载桌面版文件，用同一输入对照请求序列与识别结果）。
//
// 流程：合并的招标正文（不按投标范围裁剪）加上行号（lineView.ts）后按上下文长度切分，逐段请模型返回标段候选（JSON），
// 每段的结果按真实行号整理；多于一段时再请模型合并一次。最终结果整理后少于两个标段时失败（“未识别到至少两个有效标段”）。
// 步骤键：segment:N（与桌面版相同逐段顺序调用）、merge；JSON 不合法时的重新调用与修复另加 :try-N、:repair-N（src/jobs/chat.ts）。
// 模型输出是不可信数据：只取需要的字段，行号必须在正文范围内，没有有效范围的标段去掉。
import type { ChatMessage } from '../ai/providers.ts';
import { splitTextByContextLimit, type SplitOptions } from '../ai/textSplit.ts';
import type { JobChat } from '../jobs/chat.ts';
import { numberMarkdownLines } from './lineView.ts';

export interface ExtractedLineRange {
  startLine: number;
  endLine: number;
  /** 与桌面版相同，没有原因时为 undefined（序列化时省略）。 */
  reason?: string | undefined;
}

export interface ExtractedSection {
  id: string;
  index: number;
  unit: string;
  title: string;
  headLine: string;
  description: string;
  includeRanges: ExtractedLineRange[];
  evidence: string[];
}

type Loose = Record<string, unknown> | null | undefined;

/** 与桌面版 normalizeLineRange 相同。 */
function normalizeLineRange(value: unknown, totalLines: number): ExtractedLineRange | null {
  const range = value as Loose;
  const startLine = Math.floor(Number(range?.startLine ?? range?.start_line ?? 0));
  const endLine = Math.floor(Number(range?.endLine ?? range?.end_line ?? 0));
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine || startLine > totalLines || endLine > totalLines) {
    return null;
  }
  return { startLine, endLine, reason: range?.reason ? String(range.reason).trim() : undefined };
}

function normalizeSectionTitle(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^第([一二三四五六七八九十壹贰叁肆伍\d]+)(标段|标包|分包|包)$/, '$1$2')
    .toLowerCase();
}

function sectionMergeKey(section: ExtractedSection): string {
  const titleKey = normalizeSectionTitle(section.title);
  return titleKey ? `${section.unit || '标段'}:${titleKey}` : `${section.unit || '标段'}:${section.index}`;
}

/** 与桌面版 mergeRanges 相同：按起止与原因去重后排序。 */
function mergeRanges(ranges: readonly ExtractedLineRange[]): ExtractedLineRange[] {
  const seen = new Set<string>();
  return ranges
    .filter((range) => {
      const key = `${range.startLine}-${range.endLine}-${range.reason || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

function firstRangeStart(section: ExtractedSection): number {
  return mergeRanges(section.includeRanges)[0]?.startLine || Number.MAX_SAFE_INTEGER;
}

function normalizeSection(value: unknown, index: number, totalLines: number): ExtractedSection | null {
  const section = value as Loose;
  const title = String(section?.title || '').trim();
  if (!title) return null;
  const sectionIndex = Math.floor(Number(section?.index || index + 1));
  const ranges = (Array.isArray(section?.includeRanges) ? section.includeRanges : section?.include_ranges) || [];
  const includeRanges = (Array.isArray(ranges) ? ranges : [])
    .map((range) => normalizeLineRange(range, totalLines))
    .filter((range): range is ExtractedLineRange => range !== null);
  return {
    id: String(section?.id || `section-${sectionIndex || index + 1}`).trim(),
    index: Number.isFinite(sectionIndex) && sectionIndex > 0 ? sectionIndex : index + 1,
    unit: String(section?.unit || '标段').trim() || '标段',
    title,
    headLine: String(section?.headLine || section?.head_line || '').trim(),
    description: String(section?.description || '').trim(),
    includeRanges,
    evidence: (Array.isArray(section?.evidence) ? section.evidence : []).map((item) => String(item || '').trim()).filter(Boolean),
  };
}

function dedupeSections(sections: readonly ExtractedSection[]): ExtractedSection[] {
  const map = new Map<string, ExtractedSection>();
  for (const section of sections) {
    const key = sectionMergeKey(section);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...section });
      continue;
    }
    existing.includeRanges = mergeRanges([...existing.includeRanges, ...section.includeRanges]);
    existing.evidence = [...new Set([...existing.evidence, ...section.evidence])];
    if (!existing.headLine && section.headLine) existing.headLine = section.headLine;
    if (!existing.description && section.description) existing.description = section.description;
  }
  return [...map.values()]
    .map((section) => ({ ...section, includeRanges: mergeRanges(section.includeRanges) }))
    .filter((section) => section.includeRanges.length > 0)
    .sort((a, b) => firstRangeStart(a) - firstRangeStart(b) || a.index - b.index)
    .map((section, index) => ({ ...section, id: `section-${index + 1}` }));
}

/** 与桌面版 normalizeSectionsResponse 相同：整理模型返回的候选，按真实行号校验范围，合并同名标段并重新编号。 */
export function normalizeSectionsResponse(value: unknown, totalLines: number): { sections: ExtractedSection[] } {
  const source = (value as Loose)?.sections;
  const sections = dedupeSections(
    (Array.isArray(source) ? source : []).map((section, index) => normalizeSection(section, index, totalLines)).filter((section): section is ExtractedSection => section !== null),
  );
  return { sections };
}

function buildExtractMessages(segment: string, segmentIndex: number, totalSegments: number): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是严谨的招标文件多标段识别专家。你只能基于用户提供的带行号文本识别标段、标包、分包、采购包、包件或标的。`,
    },
    {
      role: 'user',
      content: `当前是招标文件第 ${segmentIndex}/${totalSegments} 段。普通行格式为“L000001 | 原文”；超长原文行会显示为“L000001[1/3] | 第一段”等多个分片，相同 L 编号的分片仍属于同一个真实原文行。

任务：识别本段中明确属于某个标段/标包/分包/采购包/包件/标的的内容，并返回结构化 JSON。

要求：
1. 只识别明确属于某个标段的内容范围。
2. 通用条款不要归入某个标段；不确定归属的内容不要输出范围。
3. includeRanges 必须使用输入中的真实行号，startLine 和 endLine 都是不带 L 前缀及分片序号的数字；不得把同一 L 编号的多个分片当成多行。
4. 不要编造标段，不要补写原文没有的范围。
5. 无法提供有效 includeRanges 的候选不要输出到 sections。
6. 如果本段没有明确标段内容，返回 {"sections":[]}。
7. 只返回 JSON，不要输出 Markdown、代码块、解释或额外文字。

返回格式：
{
  "sections": [
    {
      "id": "section-1",
      "index": 1,
      "unit": "标段",
      "title": "一标段",
      "headLine": "一标段：设备采购及安装",
      "description": "设备采购、安装、调试及售后服务。",
      "includeRanges": [
        { "startLine": 120, "endLine": 180, "reason": "一标段采购清单" }
      ],
      "evidence": ["一标段：设备采购及安装"]
    }
  ]
}

带行号文本：
${segment}`,
    },
  ];
}

function buildMergeMessages(segmentResults: readonly { sections: ExtractedSection[] }[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: '你是严谨的招标文件多标段识别结果合并专家。你只能合并用户提供的分段识别结果，不得编造新标段或新行号。',
    },
    {
      role: 'user',
      content: `以下是同一份招标文件各分段识别出的标段候选。请合并重复标段，保留所有明确属于各标段的 includeRanges 和 evidence。

要求：
1. 同一标段跨多个分段出现时合并为一个 sections 项。
2. 不要把通用条款合并到任何标段。
3. 不要新增分段结果中没有的行号范围。
4. 如果最终少于两个标段，返回已有结果。
5. 只返回 JSON，不要输出 Markdown、代码块、解释或额外文字。

分段结果：
${JSON.stringify(segmentResults, null, 2)}`,
    },
  ];
}

/** 识别失败时给用户看的原因（与桌面版相同）。 */
export class SectionExtractionError extends Error {}

export interface SectionExtractionProgress {
  (message: string, progress: number): Promise<void> | void;
}

/**
 * 识别招标正文中的标段（与桌面版 runBidSectionExtractionTask 的识别部分相同），返回整理后的标段（至少两个）。少于两个时抛
 * SectionExtractionError；模型调用的错误原样抛出（由任务处理）。
 */
export async function extractBidSections(chat: JobChat, markdown: string, split: SplitOptions, onProgress: SectionExtractionProgress): Promise<ExtractedSection[]> {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const totalLines = normalized.split('\n').length;
  const numbered = await numberMarkdownLines(normalized);
  const segments = splitTextByContextLimit(numbered, split);
  const sourceSegments = segments.length ? segments : [numbered];
  await onProgress(`招标文件已按上下文拆分为 ${sourceSegments.length} 段，正在提取标段候选。`, 12);

  const segmentResults: { sections: ExtractedSection[] }[] = [];
  for (let index = 0; index < sourceSegments.length; index += 1) {
    const label = `多标段识别第${index + 1}段`;
    const raw = await chat.json(`segment:${index + 1}`, buildExtractMessages(sourceSegments[index]!, index + 1, sourceSegments.length), {
      progressLabel: label,
      failureMessage: '模型返回的 JSON 数据格式无效',
    });
    segmentResults.push(normalizeSectionsResponse(raw, totalLines));
    await onProgress(`已完成第 ${index + 1}/${sourceSegments.length} 段标段候选提取。`, Math.min(80, 12 + Math.round(((index + 1) / sourceSegments.length) * 60)));
  }

  const mergedRaw =
    sourceSegments.length > 1
      ? await chat.json('merge', buildMergeMessages(segmentResults), { progressLabel: '多标段识别候选合并', failureMessage: '模型返回的 JSON 数据格式无效' })
      : segmentResults[0];
  const merged = normalizeSectionsResponse(mergedRaw, totalLines);
  if (merged.sections.length < 2) throw new SectionExtractionError('未识别到至少两个有效标段');
  return merged.sections;
}
