// 正文生成的基础编排阶段（路线图第 8 步 8.10b1；docs/SERVER_DESIGN.md 第 7.40 节）：移植桌面版 contentGenerationTask.cjs 中基础编排的
// 纯函数部分（材料、提示词、预置 Schema、提交校验、程序的字数分配、表格与配图目标选择、已保存编排的复用规则）。任务流程见 jobs.ts 的
// createContentGenerationJob。
//
// 与桌面版逐项相同（tests/technicalPlan/contentGenerationJob.test.ts 加载桌面版对照），只有以下差异：
// - 结果文件不是合法 JSON 时不附解析器的错误信息（与 8.7a 相同）；问题清单至多 AGENT_SUBMISSION_MAX_ISSUES 条、每条按上限截短；
// - 服务端另限：writing_focus 与表格用途按 CONTENT_PLAN_TEXT_MAX（1000 字）截短（提示词要求 1～2 句话），超出部分不保存。
//
// 编排结果是 Agent 写出的内容，按不可信数据处理：只按稳定 id 提取本次目标，不接受目录结构；保存前经 normalizeContentPlan 只留下已知字段。
import { Ajv } from 'ajv';
import { AGENT_SUBMISSION_MAX_ISSUES, AGENT_SUBMISSION_MAX_MESSAGE_CHARS, type AgentSubmissionIssue, type AgentSubmissionReport } from '../agent/submission.ts';
import type { TechnicalPlanTableRequirement } from '../db/schema.ts';
import type { TechnicalPlanOutlineItem } from './outline.ts';

/** 编排的版本（与桌面版 CONTENT_PLAN_VERSION 相同）：版本不同的已保存编排不复用。 */
export const CONTENT_PLAN_VERSION = 6;
/** 目录变更后新增小节的固定目标字数（与桌面版 ADDED_SECTION_TARGET_WORDS 相同）。 */
export const ADDED_SECTION_TARGET_WORDS = 3000;
export const CONTENT_PLANNING_OUTLINE_FILE = '正文编排目录.json';
export const CONTENT_PLANNING_OUTPUT_FILE = '正文编排结果.json';
export const CONTENT_PLANNING_KNOWLEDGE_FILE = '参考知识库轻量条目.json';
export const CONTENT_PLANNING_BID_INFO_FILE = '招标文件关键信息.md';
export const CONTENT_PLANNING_TARGETS_FILE = '正文编排目标.json';
/** 基础编排的阶段（与桌面版 initial_stage 相同）。 */
export const CONTENT_PLANNING_STAGE = 'content-planning';
/** writing_focus 与表格用途的服务端上限（提示词要求 1～2 句话）。 */
export const CONTENT_PLAN_TEXT_MAX = 1000;

export const TABLE_REQUIREMENT_LABELS: Readonly<Record<TechnicalPlanTableRequirement, string>> = {
  none: '不要',
  light: '少量',
  moderate: '适中',
  heavy: '大量',
};

const CONTENT_PLAN_SCHEMA = {
  type: 'object',
  required: ['writing_focus', 'knowledge', 'table', 'image_suitability_score', 'target_words'],
  additionalProperties: false,
  properties: {
    writing_focus: { type: 'string', minLength: 1 },
    target_words: { type: 'integer', minimum: 0 },
    image_suitability_score: { type: 'integer', minimum: 0, maximum: 10 },
    knowledge: {
      type: 'object',
      required: ['item_ids'],
      additionalProperties: false,
      properties: {
        item_ids: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
      },
    },
    table: {
      type: 'object',
      required: ['needed', 'purpose'],
      additionalProperties: false,
      properties: {
        needed: { type: 'boolean' },
        purpose: { type: 'string' },
      },
    },
  },
} as const;

/** 正文编排结果.json 的预置 Schema（与桌面版 CONTENT_PLANNING_JSON_SCHEMA 相同）。 */
export const CONTENT_PLANNING_JSON_SCHEMA = {
  type: 'object',
  required: ['plans'],
  additionalProperties: false,
  properties: {
    plans: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'content_plan'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          content_plan: CONTENT_PLAN_SCHEMA,
        },
      },
    },
  },
} as const;

// 与桌面版相同的 Ajv 选项（错误说明的文字与桌面版一致）。
const contentPlanningAjv = new Ajv({ allErrors: true });
const validateContentPlanningResult = contentPlanningAjv.compile(CONTENT_PLANNING_JSON_SCHEMA);

// ---- 基本整理 ----

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/** 与桌面版 singleLine 相同。 */
export function singleLine(value: unknown): string {
  return text(value || '').replace(/\s+/g, ' ').trim();
}

/** 与桌面版 normalizeTableRequirement 相同：不认识的一律为“大量”。 */
export function normalizeTableRequirement(value: unknown): TechnicalPlanTableRequirement {
  const source = text(value || '').trim();
  if (source === 'none' || source === 'light' || source === 'moderate' || source === 'heavy') return source;
  if (source === '不要') return 'none';
  if (source === '少量') return 'light';
  if (source === '适中') return 'moderate';
  if (source === '大量') return 'heavy';
  return 'heavy';
}

export interface ContentWordControl {
  readonly minimumWords: number;
  readonly maximumWords: number;
  readonly sectionWords: number;
}

/** 与桌面版 normalizeOutlineWordControlSnapshot 相同（enabled 不使用）。 */
export function normalizeContentWordControl(value: unknown): ContentWordControl {
  const source = isObject(value) ? value : {};
  const integer = (input: unknown) => {
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  return { minimumWords: integer(source.minimumWords), maximumWords: integer(source.maximumWords), sectionWords: integer(source.sectionWords) };
}

/** 全文写作基准（与桌面版 getContentWordTarget 相同），0 表示未设置全文目标。 */
export function getContentWordTarget({ minimumWords = 0, maximumWords = 0 }: Partial<ContentWordControl>): number {
  if (minimumWords > 0 && maximumWords > 0) return Math.round((minimumWords + maximumWords) / 2);
  return Math.round(minimumWords > 0 ? minimumWords * 1.2 : maximumWords * 0.8);
}

/** 与桌面版 maxTablesForRequirement 相同：“大量”没有上限（null）。 */
export function maxTablesForRequirement(requirement: TechnicalPlanTableRequirement, leafCount: number): number | null {
  if (requirement === 'none') return 0;
  if (requirement === 'light') return Math.floor(Math.max(0, leafCount) * 0.2);
  if (requirement === 'moderate') return Math.floor(Math.max(0, leafCount) * 0.4);
  return null;
}

// ---- 编排的形状 ----

export interface OriginalMaterial {
  restored: boolean;
  optimized: boolean;
  source_hash: string;
  source_ranges: { start_line: unknown; end_line: unknown }[];
  restored_words: number;
  restored_at?: unknown;
  optimized_at?: unknown;
}

export interface ContentPlan {
  writing_focus: string;
  target_words: unknown;
  image_suitability_score: unknown;
  image_needed: unknown;
  knowledge: { item_ids: string[] };
  table: { needed: boolean; purpose: string };
  original_material: OriginalMaterial;
}

/** 已保存的一节编排（与 technical_plan_content_plans 的一行对应，updated_at 由数据库写入）。 */
export interface StoredContentPlan {
  plan_version: number;
  plan: ContentPlan;
  table_requirement?: TechnicalPlanTableRequirement;
}

/** 与桌面版 normalizeKnowledgeItemIds 相同。 */
function normalizeKnowledgeItemIds(value: unknown, allowed?: ReadonlySet<string>): string[] {
  const source = Array.isArray(value) ? value : [];
  const ids = source.map((id) => text(id || '').trim()).filter(Boolean);
  return [...new Set(allowed ? ids.filter((id) => allowed.has(id)) : ids)];
}

/** 与桌面版 normalizeOriginalMaterial 相同（原方案还原随 8.11 写入，这里只原样保留）。 */
function normalizeOriginalMaterial(value: unknown): OriginalMaterial {
  const source = isObject(value) ? value : {};
  return {
    restored: Boolean(source.restored),
    optimized: Boolean(source.optimized),
    source_hash: text(source.source_hash || ''),
    source_ranges: Array.isArray(source.source_ranges)
      ? source.source_ranges.map((range) => {
          const item = isObject(range) ? range : {};
          return { start_line: item.start_line, end_line: item.end_line };
        })
      : [],
    restored_words: Math.max(0, Number(source.restored_words) || 0),
    ...(source.restored_at ? { restored_at: source.restored_at } : {}),
    ...(source.optimized_at ? { optimized_at: source.optimized_at } : {}),
  };
}

/** 与桌面版 normalizeContentPlan 相同（兼容旧字段名），另按 CONTENT_PLAN_TEXT_MAX 截短两段文字。 */
export function normalizeContentPlan(value: unknown, allowed?: ReadonlySet<string>): ContentPlan {
  const outer = isObject(value) ? value : {};
  const source = isObject(outer.plan) ? outer.plan : outer;
  const writing = isObject(source.writing) ? source.writing : {};
  const knowledgeSource = source.knowledge;
  const knowledge = isObject(knowledgeSource) ? knowledgeSource : {};
  const rawKnowledgeItemIds = Array.isArray(knowledgeSource)
    ? knowledgeSource
    : (knowledge.item_ids ?? knowledge.itemIds ?? knowledge.knowledge_item_ids ?? source.knowledge_item_ids ?? source.knowledgeItemIds);
  const table = isObject(source.table) ? source.table : {};
  const tableNeeded = Boolean(table.needed);
  return {
    writing_focus: singleLine(source.writing_focus || source.writingFocus || writing.focus || writing.writing_focus || writing.writingFocus).slice(0, CONTENT_PLAN_TEXT_MAX),
    target_words: source.target_words,
    image_suitability_score: source.image_suitability_score,
    image_needed: source.image_needed,
    knowledge: { item_ids: normalizeKnowledgeItemIds(rawKnowledgeItemIds, allowed) },
    table: { needed: tableNeeded, purpose: tableNeeded ? singleLine(table.purpose).slice(0, CONTENT_PLAN_TEXT_MAX) : '' },
    original_material: normalizeOriginalMaterial(source.original_material || source.originalMaterial),
  };
}

/** 与桌面版 validateContentPlan 相同（不合规时抛 Error，文案相同）。 */
export function validateContentPlan(plan: ContentPlan): void {
  if (!plan || typeof plan !== 'object') throw new Error('正文编排决策必须是对象');
  if (!plan.knowledge || !Array.isArray(plan.knowledge.item_ids)) throw new Error('正文编排决策缺少 knowledge.item_ids');
  if (!Number.isInteger(plan.target_words) || (plan.target_words as number) < 0) throw new Error('正文编排决策的 target_words 必须是非负整数');
  const score = plan.image_suitability_score;
  if (!Number.isInteger(score) || (score as number) < 0 || (score as number) > 10) throw new Error('正文编排决策的配图适配性评分必须是 0-10 的整数');
  if (typeof plan.writing_focus !== 'string' || !plan.writing_focus.trim()) throw new Error('正文编排决策缺少 writing_focus');
  if (!plan.table || typeof plan.table.needed !== 'boolean') throw new Error('正文编排决策缺少 table.needed');
}

/** 与桌面版 clearContentPlanTable 相同。 */
export function clearContentPlanTable(plan: ContentPlan): ContentPlan {
  return { ...plan, table: { needed: false, purpose: '' } };
}

/** 与桌面版 createStoredContentPlan 相同（updated_at 由数据库写入）。 */
export function createStoredContentPlan(plan: unknown, tableRequirement: TechnicalPlanTableRequirement | ''): StoredContentPlan {
  return {
    plan_version: CONTENT_PLAN_VERSION,
    plan: normalizeContentPlan(plan),
    ...(tableRequirement ? { table_requirement: normalizeTableRequirement(tableRequirement) } : {}),
  };
}

/** 与桌面版 normalizeStoredContentPlan 相同：版本不同、缺写作重点或不合规的返回 null（不复用）。 */
export function normalizeStoredContentPlan(value: unknown): StoredContentPlan | null {
  if (!isObject(value)) return null;
  if (Number(value.plan_version ?? value.planVersion ?? 0) !== CONTENT_PLAN_VERSION) return null;
  const plan = normalizeContentPlan(value.plan || value.contentPlan || value);
  if (!plan.writing_focus) return null;
  try {
    validateContentPlan(plan);
  } catch {
    return null;
  }
  const requirement = value.table_requirement || value.tableRequirement;
  return {
    plan_version: CONTENT_PLAN_VERSION,
    plan,
    ...(requirement ? { table_requirement: normalizeTableRequirement(requirement) } : {}),
  };
}

/** 与桌面版 isStoredContentPlanReusableForTableRequirement 相同。 */
export function isStoredContentPlanReusable(stored: StoredContentPlan, tableRequirement: TechnicalPlanTableRequirement): boolean {
  const current = normalizeTableRequirement(tableRequirement);
  return stored.table_requirement ? stored.table_requirement === current : current === 'none';
}

// ---- 目录 ----

export interface LeafContext {
  readonly item: TechnicalPlanOutlineItem;
}

/** 与桌面版 collectLeafContexts 相同（只保留叶子本身）。 */
export function collectLeafContexts(items: readonly TechnicalPlanOutlineItem[]): LeafContext[] {
  return items.flatMap((item) => (item.children?.length ? collectLeafContexts(item.children) : [{ item }]));
}

/** 全文的 AI 小节（content_mode 为 ai-generate 的叶子，目录顺序）。 */
export function collectAiLeaves(items: readonly TechnicalPlanOutlineItem[]): LeafContext[] {
  return collectLeafContexts(items).filter(({ item }) => item.content_mode === 'ai-generate');
}

/** 与桌面版 pruneContentGenerationPlans 相同：只留下当前 AI 小节、可复用形状的编排。 */
export function pruneContentGenerationPlans(plans: Readonly<Record<string, unknown>>, leaves: readonly LeafContext[]): Record<string, StoredContentPlan> {
  const leafIds = new Set(leaves.map(({ item }) => item.id));
  const next: Record<string, StoredContentPlan> = {};
  for (const [itemId, value] of Object.entries(plans)) {
    if (!leafIds.has(itemId)) continue;
    const stored = normalizeStoredContentPlan(value);
    if (stored) next[itemId] = stored;
  }
  return next;
}

/** 与桌面版 countRetainedTablePlans 相同。 */
export function countRetainedTablePlans(plans: Readonly<Record<string, unknown>>, excludedItemIds: ReadonlySet<string>): number {
  let count = 0;
  for (const [itemId, value] of Object.entries(plans)) {
    if (excludedItemIds.has(itemId)) continue;
    if (normalizeStoredContentPlan(value)?.plan.table.needed) count += 1;
  }
  return count;
}

/** 与桌面版 pickDistributedTableTargets 相同：按目录顺序均匀分布地选出至多 limit 个表格。 */
export function pickDistributedTableTargets(planned: readonly LeafContext[], limit: number): Set<string> {
  if (limit <= 0 || !planned.length) return new Set();
  if (planned.length <= limit) return new Set(planned.map(({ item }) => item.id));
  const selected = new Set<string>();
  for (let slot = 0; slot < limit; slot += 1) {
    const start = Math.floor((slot * planned.length) / limit);
    const end = Math.floor(((slot + 1) * planned.length) / limit);
    const group = planned.slice(start, Math.max(start + 1, end));
    const candidate = group[Math.floor(group.length / 2)] ?? group[0]!;
    selected.add(candidate.item.id);
  }
  return selected;
}

/** 与桌面版 selectContentImageTargets 相同：按全文 AI 小节数确定配图名额，稳定排序保留同分小节的目录顺序，0 分不入选。 */
export function selectContentImageTargets(leaves: readonly LeafContext[], plans: Readonly<Record<string, StoredContentPlan>>, imageQuantity: number): Set<string> {
  const limit = Math.floor((leaves.length * imageQuantity) / 100);
  const score = (id: string) => Number(plans[id]?.plan.image_suitability_score) || 0;
  const candidates = leaves.filter(({ item }) => score(item.id) > 0).sort((left, right) => score(right.item.id) - score(left.item.id));
  return new Set(candidates.slice(0, limit).map(({ item }) => item.id));
}

// ---- 材料 ----

export interface ContentKnowledgeItem {
  readonly id: string;
  readonly title: string;
  readonly resume: string;
}

/**
 * 知识库轻量条目（与桌面版 loadContentKnowledgeReferences 相同）：id 为“文档 id::条目 id”，标题与简介都不为空的才用。调用方传入生成配置
 * 引用的文档中的条目（store.ts 的 readGlobalFactsKnowledgeItems）。
 */
export function contentKnowledgeItems(items: readonly { documentId: string; itemId: string; title: string; resume: string }[]): ContentKnowledgeItem[] {
  const result: ContentKnowledgeItem[] = [];
  for (const item of items) {
    const documentId = text(item.documentId || '').trim();
    const itemId = text(item.itemId || '').trim();
    const title = text(item.title || '').trim();
    const resume = text(item.resume || '').trim();
    if (documentId && itemId && title && resume) result.push({ id: `${documentId}::${itemId}`, title, resume });
  }
  return result;
}

/** 与桌面版 renderKnowledgeItemsForPrompt 相同。 */
export function renderKnowledgeItemsForPrompt(items: readonly ContentKnowledgeItem[]): string {
  return JSON.stringify(
    items
      .map((item) => ({ id: text(item.id || '').trim(), title: text(item.title || '').trim(), resume: text(item.resume || '').trim() }))
      .filter((item) => item.id && item.title && item.resume),
    null,
    2,
  );
}

/** 招标解析项（项目信息、甲方信息、交货和服务要求）的成功结果，与桌面版 formatBidAnalysisFactsForPrompt 相同。 */
export function formatBidAnalysisFactsForPrompt(tasks: Readonly<Record<string, { status?: string; content?: string } | undefined>>): string {
  const fact = (id: string, label: string) => {
    const item = tasks[id];
    const content = item?.status === 'success' ? text(item.content || '').trim() : '';
    return content ? `## ${label}\n${content}` : '';
  };
  return [fact('projectInfo', '项目信息'), fact('partAInfo', '甲方信息'), fact('deliveryAndServiceRequirements', '交货和服务要求')].filter(Boolean).join('\n\n');
}

/** 与桌面版 formatBidKeyInfoForPrompt 相同。 */
export function formatBidKeyInfoForPrompt(projectOverview: string, bidAnalysisFactsText: string): string {
  return [
    text(projectOverview || '').trim() ? `## 项目概述\n${text(projectOverview || '').trim()}` : '',
    text(bidAnalysisFactsText || '').trim(),
  ].filter(Boolean).join('\n\n') || '未提供';
}

/** 与桌面版 formatGlobalFactsForPrompt 相同（开始时据此检查是否已完成全局事实设定）。 */
export function formatGlobalFactsForPrompt(globalFacts: readonly { title?: string; content?: string }[]): string {
  return globalFacts
    .map((group, index) => {
      const title = singleLine(group?.title || `全局事实${index + 1}`);
      const content = text(group?.content || '').trim();
      return title && content ? `## ${title}\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

interface PlanningOutlineNode {
  id: string;
  number: string;
  title: string;
  description: string;
  attr?: string;
  children?: PlanningOutlineNode[];
  content_mode?: string;
  content_mode_note?: string;
  content_plan?: Record<string, unknown>;
}

/** 与桌面版 buildContentPlanningOutline 相同：完整目录，已有编排只保留本阶段负责的字段。 */
export function buildContentPlanningOutline(items: readonly TechnicalPlanOutlineItem[], storedPlans: Readonly<Record<string, unknown>>, root = true): PlanningOutlineNode[] {
  return items.map((item) => {
    const children = item.children ?? [];
    const title = singleLine(item.title) || '未命名章节';
    const node: PlanningOutlineNode = {
      id: item.id,
      number: item.number,
      title,
      description: text(item.description || '').trim() || title,
      ...(root ? { attr: singleLine((item as { attr?: unknown }).attr) || '其他' } : {}),
    };
    if (children.length) return { ...node, children: buildContentPlanningOutline(children, storedPlans, false) };
    const contentMode = text(item.content_mode || '').trim();
    const stored = normalizeStoredContentPlan(storedPlans[node.id]);
    return {
      ...node,
      content_mode: contentMode,
      ...(text(item.content_mode_note || '').trim() ? { content_mode_note: text(item.content_mode_note).trim() } : {}),
      ...(contentMode === 'ai-generate' && stored?.plan
        ? {
            content_plan: {
              writing_focus: stored.plan.writing_focus,
              target_words: stored.plan.target_words,
              image_suitability_score: stored.plan.image_suitability_score,
              knowledge: { item_ids: stored.plan.knowledge.item_ids },
              table: stored.plan.table,
            },
          }
        : {}),
    };
  });
}

export interface ContentPlanningPromptInput {
  readonly targetItemIds: readonly string[];
  readonly tableRequirement: TechnicalPlanTableRequirement;
  readonly maxTables: number | null;
  readonly totalSections: number;
  readonly wordControl: ContentWordControl;
  readonly isIncremental: boolean;
}

/**
 * 基础编排的提示词（与桌面版 createContentPlanningPrompt 相同）。单节重新生成的额外要求（regenerateRequirement）随 8.11 接入，
 * 这里一律为空。
 */
export function createContentPlanningPrompt({ targetItemIds, tableRequirement, maxTables, totalSections, wordControl, isIncremental }: ContentPlanningPromptInput): string {
  const totalWordTarget = getContentWordTarget(wordControl);
  const wordInstruction = isIncremental
    ? `本次为目录变更后的新增小节编排，每节 target_words 固定填 ${ADDED_SECTION_TARGET_WORDS}，不按全文目标或每小节建议字数重新分配，其他小节的已有目标保持不变。`
    : totalWordTarget > 0
      ? `全文 AI 正文目标基准为 ${totalWordTarget} 字，共 ${totalSections} 个 AI 小节；本次 ${targetItemIds.length} 个目标小节的合计目标为 ${Math.round((totalWordTarget * targetItemIds.length) / totalSections)} 字。结合各节重要程度、内容量与写作重点分配正整数 target_words，不必平均分配，不重复承担全文目标。程序会按你提供的比例校正取整后的合计；已有非目标小节的编排保持不变。全文目标优先于每小节建议字数。`
      : `未设置全文字数目标，每节 target_words 填 ${wordControl.sectionWords || 0}；0 表示不设字数目标。`;
  const tableRequirementLabel = TABLE_REQUIREMENT_LABELS[tableRequirement] || TABLE_REQUIREMENT_LABELS.heavy;
  const tableLimitInstruction = tableRequirement === 'heavy'
    ? '表格需求为“大量”，没有数量上限，但仍然只有明显适合表格的小节才将 table.needed 设为 true。'
    : tableRequirement === 'none'
      ? '表格需求为“不要”，table.needed 必须为 false，table.purpose 留空。'
      : `表格需求为“${tableRequirementLabel}”，全文共 ${totalSections || 0} 个 AI 生成小节，表格上限为 ${maxTables || 0} 个；在当前表格数量受限的模式下，table.needed=true 表示本节适合使用表格，属于候选建议。程序会在编排完成后根据全局数量限制确定最终结果，不应将候选标记理解为最终保留决定。`;
  const targetText = targetItemIds.length
    ? `共 ${targetItemIds.length} 个，稳定 ID 见 ${CONTENT_PLANNING_TARGETS_FILE} 的 target_ids。`
    : '无。结果输出空 plans 数组。';
  const requirementText = '';
  return `你负责本次投标技术方案正文生成，现在先完成基础编排。程序会处理并保存编排，再在同一会话中交给你生效结果和正文生成要求；本阶段不要提前生成正文或图片。工作区已提供编排材料：
- ${CONTENT_PLANNING_KNOWLEDGE_FILE}：参考知识库轻量条目，只包含 id、标题和简介。
- ${CONTENT_PLANNING_BID_INFO_FILE}：招标文件关键信息。
- ${CONTENT_PLANNING_OUTLINE_FILE}：当前最新的完整目录及已有编排，只读参考。
- ${CONTENT_PLANNING_TARGETS_FILE}：本次需要编排的目录节点稳定 ID。
结果单独写入 ${CONTENT_PLANNING_OUTPUT_FILE}，格式为 {"plans":[{"id":"目标小节稳定 ID","content_plan":{...}}]}。

程序已确定本次需要编排的目录节点：
${targetText}
${requirementText}
请严格完成以下工作：
1. 结合知识条目、招标文件关键信息，以及完整目录中的上下级和同级关系进行整体判断；读取方式自行决定。
2. 完整目录仅供参考，不修改参考文件；plans 只包含程序列出的本次目标 AI 叶子，每个目标恰好一项，不提交非目标节点。
3. 每项只包含 id 和 content_plan；content_plan 必须包含 writing_focus、target_words、knowledge.item_ids、table.needed、table.purpose、image_suitability_score。image_needed 由程序计算，不输出。
字数编排要求：${wordInstruction} 字数只统计正文可读文字，不包含 HTML 标签和配图提示词；目标用于写作，不要求删减必要信息或重复凑字。
4. writing_focus 用 1-2 句话概括本节正文重点，不展开成正文，不编造具体参数、周期、人员、设备、品牌、型号或承诺，并避免与相邻章节重复。
5. knowledge.item_ids 只能从 ${CONTENT_PLANNING_KNOWLEDGE_FILE} 中选择，可以多选或为空数组，不要编造 id。
6. ${tableLimitInstruction}
7. 表格仅在能明显提升职责、步骤、参数、风险、措施或成果等内容的表达清晰度时使用；需要时准确填写用途，不需要时 purpose 留空。
8. image_suitability_score 是本节配图适配性评分，必须为 0-10 的整数：0 表示不适合配图，10 表示非常适合配图。结合本节标题、说明、写作重点和项目背景，判断图片能否帮助读者理解流程、结构、关系或设备、场景示意等内容；图片带来的理解帮助越明显，评分越高，仅起装饰作用时不应给高分。
9. id 原样使用目标节点的稳定 ID，不能用显示编号代替。不复制标题、编号、描述或目录树，程序按 ID 保存本次编排。
10. 将本次全部目标的编排写入 ${CONTENT_PLANNING_OUTPUT_FILE}；内容较多时可分多次写入：首次用 write，之后用 edit 补充，每次写入后保持完整有效 JSON。继续任务时可读取已有结果并接着完善，但提交范围始终以本次目标列表为准。程序已为该文件预置 Schema，可用 json-validation 自查；结束后程序统一校验，不通过会退回问题清单继续修改。完成全部目标后，在最后一次成功写入或更新时设置 task_complete=true，结束本次基础编排，等待程序在同一会话中继续派发正文生成要求。`;
}

export interface ContentPlanningFilesInput {
  readonly outline: readonly TechnicalPlanOutlineItem[];
  readonly storedPlans: Readonly<Record<string, unknown>>;
  readonly knowledgeItems: readonly ContentKnowledgeItem[];
  readonly projectOverview: string;
  readonly bidAnalysisFactsText: string;
  readonly targetItemIds: readonly string[];
}

/** 基础编排放入的材料（与桌面版 createContentPlanningStage 的 files 相同，结果文件另由任务预置）。 */
export function buildContentPlanningFiles(input: ContentPlanningFilesInput): { path: string; content: string }[] {
  return [
    { path: CONTENT_PLANNING_KNOWLEDGE_FILE, content: renderKnowledgeItemsForPrompt(input.knowledgeItems) },
    { path: CONTENT_PLANNING_BID_INFO_FILE, content: formatBidKeyInfoForPrompt(input.projectOverview, input.bidAnalysisFactsText) },
    { path: CONTENT_PLANNING_OUTLINE_FILE, content: JSON.stringify({ outline: buildContentPlanningOutline(input.outline, input.storedPlans) }, null, 2) },
    { path: CONTENT_PLANNING_TARGETS_FILE, content: JSON.stringify({ target_ids: input.targetItemIds }, null, 2) },
  ];
}

// ---- 提交校验 ----

/** 与桌面版 allocateContentWordTargets 相同：新增小节固定目标字数，其他按 Agent 提议的比例分配整数目标（不满足时抛 Error）。 */
export function allocateContentWordTargets(plans: Map<string, ContentPlan>, control: ContentWordControl, totalSections: number, isIncremental: boolean): void {
  const entries = [...plans.values()];
  if (!entries.length) return;
  if (isIncremental) {
    for (const plan of entries) plan.target_words = ADDED_SECTION_TARGET_WORDS;
    return;
  }
  const totalTarget = getContentWordTarget(control);
  if (!totalTarget) {
    for (const plan of entries) plan.target_words = control.sectionWords || 0;
    return;
  }
  const budget = Math.round((totalTarget * entries.length) / totalSections);
  if (budget < entries.length) throw new Error('正文目标字数不足以为每个小节分配字数，请调整字数配置或目录规模。');
  if (entries.some((plan) => !Number.isInteger(plan.target_words) || (plan.target_words as number) <= 0)) {
    throw new Error('已设置全文字数要求，正文编排必须为每个目标小节提供正整数 target_words。');
  }
  const proposedTotal = entries.reduce((sum, plan) => sum + (plan.target_words as number), 0);
  if (proposedTotal === budget) return;
  const allocations = entries.map((plan, index) => {
    const exact = 1 + ((budget - entries.length) * (plan.target_words as number)) / proposedTotal;
    return { plan, index, words: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  const remainder = budget - allocations.reduce((sum, item) => sum + item.words, 0);
  allocations.sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  allocations.forEach((item, index) => {
    item.plan.target_words = item.words + (index < remainder ? 1 : 0);
  });
}

class PlanningIssues extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.issues = issues;
  }
}

/** 与桌面版 extractContentPlanningPlans 相同：校验 Schema，只按稳定 id 提取本次目标的编排（目录顺序）。不合规时抛 Error。 */
export function extractContentPlanningPlans(
  value: unknown,
  outline: readonly TechnicalPlanOutlineItem[],
  allowedKnowledgeItemIds: ReadonlySet<string>,
  targetItemIds: ReadonlySet<string>,
): Map<string, ContentPlan> {
  if (!validateContentPlanningResult(value)) {
    const errors = validateContentPlanningResult.errors ?? [];
    throw new PlanningIssues(
      '正文编排结果格式错误：' + contentPlanningAjv.errorsText(errors),
      errors.map((item) => (item.instancePath || '/') + ' ' + item.message),
    );
  }
  const result = value as { plans: { id: string; content_plan: { knowledge: { item_ids: string[] }; table: { purpose: string } } }[] };
  const aiLeafIds = new Set(collectAiLeaves(outline).map(({ item }) => item.id));
  const plans = new Map<string, ContentPlan>();
  for (const { id, content_plan: rawPlan } of result.plans) {
    if (!targetItemIds.has(id) || !aiLeafIds.has(id)) throw new Error(`正文编排结果包含非目标 AI 小节：${id}`);
    if (plans.has(id)) throw new Error(`正文编排结果重复提交小节：${id}`);
    if (rawPlan.knowledge.item_ids.some((itemId) => !allowedKnowledgeItemIds.has(itemId))) throw new Error(`正文编排结果引用了不存在的知识库条目：${id}`);
    const plan = normalizeContentPlan(rawPlan, allowedKnowledgeItemIds);
    validateContentPlan(plan);
    if (plan.table.needed && !plan.table.purpose) throw new Error(`正文编排结果缺少表格用途：${id}`);
    if (!plan.table.needed && rawPlan.table.purpose.trim()) throw new Error(`正文编排结果为无表格目录填写了表格用途：${id}`);
    plans.set(id, plan);
  }
  for (const id of targetItemIds) {
    if (!plans.has(id)) throw new Error(`正文编排结果缺少目标节点：${id}`);
  }
  // 保持程序分配字数时的目录顺序，不受模型返回数组顺序影响。
  return new Map([...aiLeafIds].filter((id) => plans.has(id)).map((id) => [id, plans.get(id)!]));
}

const PLANNING_MINIMUM_GOAL = '编排结果是完整有效的 JSON，覆盖本轮目标小节，保留稳定 ID，并提供生成正文所需的写作重点、字数、知识引用及表格安排。';

function issueOf(message: string): AgentSubmissionIssue {
  const trimmed = message.trim() || '正文编排结果不合规';
  return { severity: 'blocking', message: trimmed.length > AGENT_SUBMISSION_MAX_MESSAGE_CHARS ? `${trimmed.slice(0, AGENT_SUBMISSION_MAX_MESSAGE_CHARS - 1)}…` : trimmed };
}

export interface ContentPlanningValidation {
  readonly outline: readonly TechnicalPlanOutlineItem[];
  readonly allowedKnowledgeItemIds: ReadonlySet<string>;
  readonly targetItemIds: readonly string[];
  readonly wordControl: ContentWordControl;
  readonly totalSections: number;
  readonly isIncremental: boolean;
}

/**
 * 基础编排的提交校验（与桌面版 createContentPlanningStage 的 validate 相同）：content 为 null 表示结果文件还不存在。通过时 value 为
 * 本次目标的编排（已按程序规则分配字数，目录顺序）；不合规时为阻塞问题（经提交修复退回 Agent）。
 */
export function validateContentPlanningOutput(content: string | null, input: ContentPlanningValidation): AgentSubmissionReport<Map<string, ContentPlan>> {
  if (content === null) {
    return { value: null, issues: [issueOf(`${CONTENT_PLANNING_OUTPUT_FILE} 尚未生成，请按本阶段要求保存结果。`)] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    return { value: null, issues: [issueOf(`${CONTENT_PLANNING_OUTPUT_FILE}不是合法 JSON`)], minimumGoal: PLANNING_MINIMUM_GOAL };
  }
  try {
    const plans = extractContentPlanningPlans(parsed, input.outline, input.allowedKnowledgeItemIds, new Set(input.targetItemIds));
    allocateContentWordTargets(plans, input.wordControl, input.totalSections, input.isIncremental);
    return { value: plans, issues: [] };
  } catch (error) {
    if (!(error instanceof Error) || (error.constructor !== Error && !(error instanceof PlanningIssues))) throw error;
    const messages = error instanceof PlanningIssues ? error.issues : [error.message];
    return { value: null, issues: messages.slice(0, AGENT_SUBMISSION_MAX_ISSUES).map(issueOf), minimumGoal: PLANNING_MINIMUM_GOAL };
  }
}

// ---- 本次目标与保存 ----

export interface ContentSectionState {
  readonly status?: string;
}

export interface ContentGenerationTargetsInput {
  readonly leaves: readonly LeafContext[];
  readonly sections: Readonly<Record<string, ContentSectionState | undefined>>;
  /** 正文生成的运行进度（store 的 contentGenerationRuntime；全文重新生成时为 null）。 */
  readonly runtime: Record<string, unknown> | null;
  readonly regenerate: boolean;
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.map((item) => text(item || '').trim()).filter(Boolean))] : [];

/**
 * 本次要生成的小节（与桌面版 runContentGenerationTask 的 tasksToRun 相同，单节重新生成与重试随 8.11 / 8.10b2）：全文重新生成时全部
 * AI 小节；否则为没有成功生成或没有字数记录的小节，运行进度中有待生成小节（目录变更后新增）时只取其中的。
 */
export function selectContentGenerationTargets({ leaves, sections, runtime, regenerate }: ContentGenerationTargetsInput): LeafContext[] {
  const sectionWords = isObject(runtime?.section_words) ? runtime.section_words : {};
  let targets = leaves.filter(({ item }) => regenerate || sections[item.id]?.status !== 'success' || !Object.hasOwn(sectionWords, item.id));
  const pending = stringArray(runtime?.pending_item_ids);
  if (!regenerate && pending.length) {
    const pendingIds = new Set(pending);
    targets = targets.filter(({ item }) => pendingIds.has(item.id));
  }
  return targets;
}

/** 本次的表格名额（与桌面版 refreshRunLimits 相同）：全文上限减去本次目标之外已保留的表格。 */
export function tablesForRun(
  tableRequirement: TechnicalPlanTableRequirement,
  leaves: readonly LeafContext[],
  storedPlans: Readonly<Record<string, unknown>>,
  targets: readonly LeafContext[],
): { maxTables: number | null; maxTablesForRun: number | null } {
  const maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
  if (maxTables === null) return { maxTables, maxTablesForRun: null };
  const retained = countRetainedTablePlans(storedPlans, new Set(targets.map(({ item }) => item.id)));
  return { maxTables, maxTablesForRun: Math.max(0, maxTables - retained) };
}

/** 复用已保存的编排（与桌面版 getReusableStoredContentPlan 相同）；不能复用时返回 null。 */
export function reusableContentPlan(stored: StoredContentPlan | undefined, tableRequirement: TechnicalPlanTableRequirement, allowed: ReadonlySet<string>): ContentPlan | null {
  if (!stored || !isStoredContentPlanReusable(stored, tableRequirement)) return null;
  const plan = normalizeContentPlan(stored.plan, allowed);
  return tableRequirement === 'none' ? clearContentPlanTable(plan) : plan;
}

export interface CompletedContentPlanning {
  /** 整理后的全部编排（只含当前 AI 小节），整体写入 technical_plan_content_plans。 */
  readonly plans: Record<string, StoredContentPlan>;
  readonly tableCandidates: number;
  /** 入选的表格数；“大量”时为 null（保持现有编排）。 */
  readonly selectedTables: number | null;
  /** 本次目标的目标字数合计。 */
  readonly targetWords: number;
}

export interface CompleteContentPlanningInput {
  readonly leaves: readonly LeafContext[];
  readonly storedPlans: Readonly<Record<string, StoredContentPlan>>;
  /** 本次要编排的目标（目录顺序）与 Agent 交回、已分配字数的编排。 */
  readonly planningTargets: readonly LeafContext[];
  readonly generatedPlans: ReadonlyMap<string, ContentPlan>;
  readonly tableRequirement: TechnicalPlanTableRequirement;
  readonly maxTablesForRun: number | null;
  readonly imageQuantity: number;
}

/**
 * 编排提交后程序的整理（与桌面版 preparePlanning 的 complete 与 persistContentPlans 相同）：表格需求为“不要”时清除表格；数量受限时
 * 按目录顺序均匀选出本次名额内的表格，其余清除；再按全文的配图适配性评分选出配图小节（image_needed），只更新本次目标。
 */
export function completeContentPlanning(input: CompleteContentPlanningInput): CompletedContentPlanning {
  const plans = new Map<string, ContentPlan>();
  for (const { item } of input.planningTargets) {
    let plan = input.generatedPlans.get(item.id);
    if (!plan) throw new Error(`正文编排结果缺少目标节点：${item.id}`);
    if (input.tableRequirement === 'none') plan = clearContentPlanTable(plan);
    plans.set(item.id, plan);
  }
  const tableCandidates = input.planningTargets.filter(({ item }) => plans.get(item.id)!.table.needed);
  const selectedTableIds = input.maxTablesForRun === null ? new Set(tableCandidates.map(({ item }) => item.id)) : pickDistributedTableTargets(tableCandidates, input.maxTablesForRun);
  if (input.maxTablesForRun !== null) {
    for (const { item } of tableCandidates) {
      if (!selectedTableIds.has(item.id)) plans.set(item.id, clearContentPlanTable(plans.get(item.id)!));
    }
  }
  const nextPlans: Record<string, StoredContentPlan> = { ...input.storedPlans };
  for (const { item } of input.planningTargets) {
    const originalMaterial = input.storedPlans[item.id]?.plan.original_material;
    nextPlans[item.id] = createStoredContentPlan({ ...plans.get(item.id)!, ...(originalMaterial ? { original_material: originalMaterial } : {}) }, input.tableRequirement);
  }
  const selectedImageIds = selectContentImageTargets(input.leaves, nextPlans, input.imageQuantity);
  for (const { item } of input.planningTargets) {
    nextPlans[item.id] = { ...nextPlans[item.id]!, plan: { ...nextPlans[item.id]!.plan, image_needed: selectedImageIds.has(item.id) } };
  }
  const targetWords = input.planningTargets.reduce((sum, { item }) => sum + (Number(nextPlans[item.id]!.plan.target_words) || 0), 0);
  return {
    plans: pruneContentGenerationPlans(nextPlans, input.leaves),
    tableCandidates: tableCandidates.length,
    selectedTables: input.maxTablesForRun === null ? null : selectedTableIds.size,
    targetWords,
  };
}

/** 提交修复中的业务说明（与桌面版 buildRetryPrompt 在基础编排阶段的文字相同：编排的问题没有小节清单）。 */
export function createContentPlanningRepairPrompt(): string {
  return `本次结果文件：${CONTENT_PLANNING_OUTPUT_FILE}。按问题说明修正当前结果，保留已完成内容和当前阶段范围。 保留已完成内容，不重新执行已结束阶段；本轮处理后重新提交，由程序判断是否继续。`;
}

/**
 * 基础编排保存时的运行进度（与桌面版 prepareContentGenerationStart 与 markStageCompleted('planning') 之后的 contentGenerationRuntime
 * 相同）：全文重新生成时不沿用之前的字数记录、待生成小节与转换结果。
 */
export function contentRuntimeAfterPlanning(previous: Record<string, unknown> | null, regenerate: boolean, now: Date): Record<string, unknown> {
  const source = regenerate || !previous ? {} : previous;
  return {
    generation_started: true,
    direct_generation_item_ids: stringArray(source.direct_generation_item_ids),
    pending_item_ids: stringArray(source.pending_item_ids),
    section_words: isObject(source.section_words) ? { ...source.section_words } : {},
    phase: 'planning',
    touched_item_ids: [],
    completed_stages: ['planning'],
    target_item_id: '',
    regenerate_requirement: '',
    ...(source.html_output !== undefined ? { html_output: source.html_output } : {}),
    updated_at: now.toISOString(),
  };
}

/** 与桌面版 createContentPlanningStage 的 isIncremental 相同：本次目标都是目录变更后新增的待生成小节。 */
export function isIncrementalPlanning(targetItemIds: readonly string[], runtime: Record<string, unknown> | null): boolean {
  const pending = new Set(stringArray(runtime?.pending_item_ids));
  return targetItemIds.every((id) => pending.has(id));
}
