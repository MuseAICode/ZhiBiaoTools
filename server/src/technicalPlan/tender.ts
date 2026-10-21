// 技术方案的招标解析项与多标段：与桌面版 bidAnalysisTask.cjs 的任务列表（tests/technicalPlan/tender.test.ts 直接加载
// 桌面版文件核对）、technicalPlanStore.cjs 的 normalizeBidAnalysisConfig / normalizeBidSections /
// buildSelectedSectionMarkdown / combineTenderMarkdown 相同（桌面版没有导出这些函数，测试按桌面版的规则逐条核对）。
// 纯函数，不访问数据库。
import {
  TECHNICAL_PLAN_BID_ITEM_IDS,
  TECHNICAL_PLAN_KEY_MAX,
  TECHNICAL_PLAN_TEXT_MAX,
  TECHNICAL_PLAN_TITLE_MAX,
} from '../db/migrations/0018_technical_plan.ts';
import type { TechnicalPlanBidAnalysisMode, TechnicalPlanBidItemId, TechnicalPlanBidSection } from '../db/schema.ts';

export interface BidAnalysisTaskDefinition {
  id: TechnicalPlanBidItemId;
  label: string;
  /** 关键解析（key 模式）必选的项。 */
  required: boolean;
}

const LABELS: Record<TechnicalPlanBidItemId, string> = {
  projectOverview: '项目概述',
  techRequirements: '技术评分要求',
  projectInfo: '项目信息',
  partAInfo: '甲方信息',
  deliveryAndServiceRequirements: '交货和服务要求',
  procurementList: '采购清单',
  responseFileRequirements: '响应文件要求',
  agentInfo: '代理机构信息',
  keyInfo: '投标关键节点',
  marginInfo: '投标保证金',
  qualificationReview: '资格性审查',
  complianceCheck: '符合性检查',
  openBid: '开标要求',
  evaluationBid: '评标要求',
  businessScoring: '商务评分要求',
  discardedBids: '无效标与废标项',
  signingProcess: '合同授予与签订',
  terminationCondition: '合同解除和终止',
};

const REQUIRED = new Set<TechnicalPlanBidItemId>([
  'projectOverview',
  'techRequirements',
  'projectInfo',
  'partAInfo',
  'deliveryAndServiceRequirements',
  'responseFileRequirements',
]);

/** 全部招标解析项，顺序与桌面版相同。 */
export const BID_ANALYSIS_TASKS: readonly BidAnalysisTaskDefinition[] = TECHNICAL_PLAN_BID_ITEM_IDS.map((id) => ({
  id,
  label: LABELS[id],
  required: REQUIRED.has(id),
}));

const ALL_IDS: readonly TechnicalPlanBidItemId[] = TECHNICAL_PLAN_BID_ITEM_IDS;
const REQUIRED_IDS = ALL_IDS.filter((id) => REQUIRED.has(id));

export function isBidItemId(value: unknown): value is TechnicalPlanBidItemId {
  return (ALL_IDS as readonly unknown[]).includes(value);
}

/** 解析项在结果中的排序（与桌面版 getBidItemSortOrder 相同）。 */
export function bidItemSortOrder(id: TechnicalPlanBidItemId): number {
  return ALL_IDS.indexOf(id);
}

export function bidItemLabel(id: TechnicalPlanBidItemId): string {
  return LABELS[id];
}

/**
 * 与桌面版 normalizeBidAnalysisConfig 相同：必选项总是选中；选中了全部或模式是 full 时为 full；有可选项或模式是 custom 时
 * 为 custom；否则为 key。未知的 id 忽略，结果按任务列表的顺序。
 */
export function normalizeBidAnalysisConfig(
  mode: unknown,
  selectedTaskIds: unknown,
): { mode: TechnicalPlanBidAnalysisMode; selectedTaskIds: TechnicalPlanBidItemId[] } {
  const requested = new Set((Array.isArray(selectedTaskIds) ? selectedTaskIds : []).map((id) => String(id ?? '').trim()).filter(Boolean));
  const selected = new Set<string>([...REQUIRED_IDS, ...ALL_IDS.filter((id) => requested.has(id))]);
  const selectedIds = ALL_IDS.filter((id) => selected.has(id));
  const hasOptional = selectedIds.some((id) => !REQUIRED.has(id));
  if (mode === 'full' || selectedIds.length === ALL_IDS.length) return { mode: 'full', selectedTaskIds: [...ALL_IDS] };
  if (mode === 'custom' || hasOptional) return { mode: 'custom', selectedTaskIds: selectedIds };
  return { mode: 'key', selectedTaskIds: [...REQUIRED_IDS] };
}

/** 与桌面版 calculateBidProgress 相同：选中的解析项中已结束（成功或失败）的比例。 */
export function bidAnalysisProgress(selectedTaskIds: readonly string[], statuses: ReadonlyMap<string, string>): number {
  if (selectedTaskIds.length === 0) return 0;
  const done = selectedTaskIds.filter((id) => ['success', 'error'].includes(statuses.get(id) ?? '')).length;
  return Math.round((done / selectedTaskIds.length) * 100);
}

// ---- 多标段 ----

/** 标段数、每个标段的范围与依据的上限（桌面版没有；结果由任务写入，超出的部分截掉）。 */
export const BID_SECTIONS_MAX = 100;
export const BID_SECTION_RANGES_MAX = 500;
export const BID_SECTION_EVIDENCE_MAX = 50;
const UNIT_MAX = 20;
const LINE_MAX = 2_147_483_647;

const truncate = (text: string, max: number) => {
  const chars = [...text.replaceAll('\u0000', '')];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};

type Loose = Record<string, unknown> | null | undefined;

function lineNumber(value: unknown): number {
  const number = Math.max(1, Math.floor(Number(value || 0)));
  return Number.isNaN(number) ? number : Math.min(number, LINE_MAX);
}

function cleanRanges(value: readonly unknown[]): TechnicalPlanBidSection['includeRanges'] {
  return value
    .map((item) => {
      const range = item as Loose;
      return {
        startLine: lineNumber(range?.startLine || range?.start_line || 0),
        endLine: lineNumber(range?.endLine || range?.end_line || 0),
        ...(range?.reason ? { reason: truncate(String(range.reason), TECHNICAL_PLAN_TITLE_MAX) } : {}),
      };
    })
    .filter((range) => range.startLine > 0 && range.endLine >= range.startLine);
}

/** 与桌面版 normalizeBidSectionRanges 相同：兼容 snake_case，去掉起止不合法的范围。 */
export function normalizeBidSectionRanges(value: unknown): TechnicalPlanBidSection['includeRanges'] {
  return cleanRanges((Array.isArray(value) ? value : []).slice(0, BID_SECTION_RANGES_MAX));
}

/** 与桌面版 normalizeBidSections 相同：补默认 id、序号和单位，去掉没有 id 或标题的标段；另截短超长的文本。 */
export function normalizeBidSections(value: unknown): TechnicalPlanBidSection[] {
  return (Array.isArray(value) ? value : [])
    .slice(0, BID_SECTIONS_MAX)
    .map((item, index) => {
      const section = item as Loose;
      const normalizedIndex = Number(section?.index || index + 1);
      return {
        id: truncate(String(section?.id || `section-${normalizedIndex || index + 1}`).trim(), TECHNICAL_PLAN_KEY_MAX),
        index: Number.isFinite(normalizedIndex) && normalizedIndex > 0 ? normalizedIndex : index + 1,
        unit: truncate(String(section?.unit || '标段').trim() || '标段', UNIT_MAX),
        title: truncate(String(section?.title || '').trim(), TECHNICAL_PLAN_TITLE_MAX),
        headLine: truncate(String(section?.headLine || section?.head_line || ''), TECHNICAL_PLAN_TITLE_MAX),
        description: truncate(String(section?.description || ''), TECHNICAL_PLAN_TEXT_MAX),
        includeRanges: normalizeBidSectionRanges(section?.includeRanges || section?.include_ranges),
        evidence: (Array.isArray(section?.evidence) ? section.evidence : [])
          .map((evidence) => String(evidence || '').trim())
          .filter(Boolean)
          .slice(0, BID_SECTION_EVIDENCE_MAX)
          .map((evidence) => truncate(evidence, TECHNICAL_PLAN_TITLE_MAX)),
      };
    })
    .filter((section) => section.id && section.title);
}

/** 与桌面版 combineTenderMarkdown 相同：各份招标文件的 Markdown 去掉首尾空白，跳过空的，以空行连接。 */
export function combineTenderMarkdown(markdowns: readonly string[]): string {
  return markdowns
    .map((markdown) => String(markdown || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

export class BidSectionError extends Error {}

/**
 * 与桌面版 expandLineRanges 相同的行集合（行号从 1 起），用差分数组标记，耗时与范围数加行数成正比
 * （桌面版逐个范围展开，范围重叠很多时耗时成倍增加）。
 */
function expandLineRanges(ranges: TechnicalPlanBidSection['includeRanges'], totalLines: number): Uint8Array {
  const delta = new Int32Array(totalLines + 2);
  for (const range of cleanRanges(ranges)) {
    const start = Math.max(1, Math.min(totalLines, range.startLine));
    const end = Math.max(start, Math.min(totalLines, range.endLine));
    delta[start]! += 1;
    delta[end + 1]! -= 1;
  }
  const lines = new Uint8Array(totalLines + 1);
  let depth = 0;
  for (let line = 1; line <= totalLines; line += 1) {
    depth += delta[line]!;
    if (depth > 0) lines[line] = 1;
  }
  return lines;
}

/**
 * 与桌面版 buildSelectedSectionMarkdown 相同：从合并的招标正文中去掉只属于其他标段的行，得到所选投标范围的工作副本。
 * 标段不存在、没有有效范围或结果为空时抛 BidSectionError（消息与桌面版相同）。
 */
export function buildSelectedSectionMarkdown(markdown: string, sections: readonly TechnicalPlanBidSection[], selectedSectionId: string): string {
  const sourceLines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const totalLines = sourceLines.length;
  const selected = sections.find((section) => section.id === selectedSectionId);
  if (!selected) throw new BidSectionError('未找到选择的投标范围');
  if (!normalizeBidSectionRanges(selected.includeRanges).length) throw new BidSectionError('当前标段缺少有效范围，请重新识别');
  const selectedLines = expandLineRanges(selected.includeRanges, totalLines);
  const otherLines = expandLineRanges(
    sections.filter((section) => section.id !== selected.id).flatMap((section) => section.includeRanges),
    totalLines,
  );
  const filtered = sourceLines
    .filter((_, index) => !otherLines[index + 1] || selectedLines[index + 1])
    .join('\n')
    .trim();
  if (!filtered) throw new BidSectionError('生成投标范围工作副本失败，请重新提取标段');
  return filtered;
}
