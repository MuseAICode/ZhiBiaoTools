// 技术方案的目录与全局事实：与桌面版 technicalPlanStore.cjs 的 flattenOutlineItems / loadOutlineData /
// normalizeGlobalFactGroups / normalizeGlobalFactId、technicalPlanOutline.cjs 的 numberOutline 相同（桌面版没有导出前几个函数，
// tests/technicalPlan/outline.test.ts 按桌面版的规则逐条核对，numberOutline 直接加载桌面版文件对照）。另加桌面版没有的
// 输入校验与上限，不合法时抛 OutlineInputError（由 Store 转成 400）。纯函数，不访问数据库。
import {
  TECHNICAL_PLAN_BID_ITEM_CONTENT_MAX,
  TECHNICAL_PLAN_KEY_MAX,
  TECHNICAL_PLAN_TEXT_MAX,
  TECHNICAL_PLAN_TITLE_MAX,
} from '../db/migrations/0018_technical_plan.ts';
import {
  TECHNICAL_PLAN_CONTENT_MAX,
  TECHNICAL_PLAN_CONTENT_MODES,
  TECHNICAL_PLAN_FACT_CONTENT_MAX,
  TECHNICAL_PLAN_KNOWLEDGE_IDS_MAX_BYTES,
  TECHNICAL_PLAN_OUTLINE_DEPTH_MAX,
} from '../db/migrations/0019_technical_plan_outline.ts';
import type { TechnicalPlanContentMode } from '../db/schema.ts';

/** 目录的最多节点数。 */
export const TECHNICAL_PLAN_OUTLINE_NODES_MAX = 2000;
/** 每节最多引用的知识库条目数。 */
export const TECHNICAL_PLAN_KNOWLEDGE_ITEMS_MAX = 200;
/** 最多的全局事实分组数。 */
export const TECHNICAL_PLAN_FACT_GROUPS_MAX = 100;
/** 由标题或请求得出的全局事实分组 id 在追加重复后缀之前的字数上限。 */
const FACT_ID_BASE_MAX = 200;
/** 保存目录的 reason（与桌面版相同）。 */
export const TECHNICAL_PLAN_OUTLINE_SAVE_REASONS = ['sort', 'edit', 'delete', 'add-root', 'add-child', 'replace'] as const;
export type TechnicalPlanOutlineSaveReason = (typeof TECHNICAL_PLAN_OUTLINE_SAVE_REASONS)[number];

const UNTITLED_CHAPTER = '未命名章节';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 请求中的目录或全局事实不合法。 */
export class OutlineInputError extends Error {}

/** 与桌面版 Renderer 的 TechnicalPlanOutlineItem 相同；空的可选字段省略，number 由树的顺序现算。 */
export interface TechnicalPlanOutlineItem {
  id: string;
  title: string;
  description: string;
  content_mode?: TechnicalPlanContentMode;
  content_mode_note?: string;
  source_requirement_id?: string;
  source_requirement_title?: string;
  knowledge_item_ids?: string[];
  content?: string;
  number: string;
  children?: TechnicalPlanOutlineItem[];
}

export interface TechnicalPlanOutlineData {
  outline: TechnicalPlanOutlineItem[];
  project_name?: string;
  project_overview?: string;
}

/** 一个目录节点的行（与表 technical_plan_outline_nodes 的列相同）。 */
export interface OutlineNodeRow {
  node_id: string;
  parent_node_id: string | null;
  sort_order: number;
  level: number;
  title: string;
  description: string;
  content_mode: TechnicalPlanContentMode | null;
  content_mode_note: string | null;
  source_requirement_id: string | null;
  source_requirement_title: string | null;
  knowledge_item_ids: string[] | null;
  content: string;
}

/** 请求展开出的行：content 为请求给出的正文（未给出时为 undefined），branch 表示有子节点。 */
export type RequestedOutlineRow = Omit<OutlineNodeRow, 'content'> & { content: string | undefined; branch: boolean };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const charLength = (text: string) => [...text].length;
const stripNul = (text: string) => text.replaceAll('\u0000', '');

function optionalString(item: Record<string, unknown>, field: string, what: string): string | undefined {
  const value = item[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new OutlineInputError(`${what}必须是字符串`);
  return stripNul(value);
}

function limited(text: string, max: number, what: string): string {
  if (charLength(text) > max) throw new OutlineInputError(`${what}超过 ${max} 字`);
  return text;
}

/**
 * 把请求中的目录展开成行（与桌面版 flattenOutlineItems 相同：先序，没有 id 的节点连同子节点跳过，标题为空时用“未命名章节”，
 * 处理方式只留在叶子节点上，说明只留在 other 方式上，来源要求为空时不存）。节点 id 必须是 UUID（统一成小写）；结构不对、
 * id 重复、处理方式不在列表中、超过层级 / 节点数 / 字数上限时抛 OutlineInputError。递归深度受层级上限约束。
 */
export function flattenOutline(outline: unknown): RequestedOutlineRow[] {
  if (!Array.isArray(outline)) throw new OutlineInputError('目录必须是数组');
  const rows: RequestedOutlineRow[] = [];
  const ids = new Set<string>();
  const walk = (items: unknown[], parent: string | null, level: number) => {
    if (level > TECHNICAL_PLAN_OUTLINE_DEPTH_MAX) throw new OutlineInputError(`目录最多 ${TECHNICAL_PLAN_OUTLINE_DEPTH_MAX} 级`);
    items.forEach((value, index) => {
      if (!isObject(value)) throw new OutlineInputError('目录项必须是对象');
      const rawId = (optionalString(value, 'id', '目录项 id') ?? '').trim();
      if (!rawId) return;
      if (!UUID.test(rawId)) throw new OutlineInputError(`目录项 id 不合法：${JSON.stringify(rawId.slice(0, 64))}`);
      const id = rawId.toLowerCase();
      if (ids.has(id)) throw new OutlineInputError(`目录项 id 重复：${id}`);
      ids.add(id);
      if (rows.length >= TECHNICAL_PLAN_OUTLINE_NODES_MAX) throw new OutlineInputError(`目录最多 ${TECHNICAL_PLAN_OUTLINE_NODES_MAX} 项`);
      const children = value.children;
      if (children !== undefined && children !== null && !Array.isArray(children)) throw new OutlineInputError('子目录必须是数组');
      const branch = Array.isArray(children) && children.length > 0;
      const title = limited((optionalString(value, 'title', '目录标题') ?? '').trim() || UNTITLED_CHAPTER, TECHNICAL_PLAN_TITLE_MAX, '目录标题');
      const description = limited((optionalString(value, 'description', '目录说明') ?? '').trim(), TECHNICAL_PLAN_TEXT_MAX, '目录说明');
      const mode = branch ? '' : (optionalString(value, 'content_mode', '处理方式') ?? '').trim();
      if (mode && !(TECHNICAL_PLAN_CONTENT_MODES as readonly string[]).includes(mode)) {
        throw new OutlineInputError(`处理方式不合法：${JSON.stringify(mode.slice(0, 64))}`);
      }
      const note = mode === 'other' ? (optionalString(value, 'content_mode_note', '处理方式说明') ?? '').trim() : '';
      const requirementId = optionalString(value, 'source_requirement_id', '来源要求 id') ?? '';
      const requirementTitle = optionalString(value, 'source_requirement_title', '来源要求标题') ?? '';
      const content = optionalString(value, 'content', '章节正文');
      if (content !== undefined) limited(content, TECHNICAL_PLAN_CONTENT_MAX, '章节正文');
      let knowledgeItemIds: string[] | null = null;
      const rawIds = value.knowledge_item_ids;
      if (rawIds !== undefined && rawIds !== null) {
        if (!Array.isArray(rawIds) || !rawIds.every((item) => typeof item === 'string')) throw new OutlineInputError('引用的知识库条目必须是字符串数组');
        if (rawIds.length > TECHNICAL_PLAN_KNOWLEDGE_ITEMS_MAX) throw new OutlineInputError(`每节最多引用 ${TECHNICAL_PLAN_KNOWLEDGE_ITEMS_MAX} 个知识库条目`);
        const cleaned = (rawIds as string[]).map(stripNul);
        // jsonb 的文本形式在逗号后多一个空格，比 JSON.stringify 的结果长，这里留出余量。
        if (Buffer.byteLength(JSON.stringify(cleaned)) > (TECHNICAL_PLAN_KNOWLEDGE_IDS_MAX_BYTES * 3) / 4) throw new OutlineInputError('引用的知识库条目过多');
        knowledgeItemIds = cleaned.length ? cleaned : null;
      }
      rows.push({
        node_id: id,
        parent_node_id: parent,
        sort_order: index,
        level,
        title,
        description,
        content_mode: (mode || null) as TechnicalPlanContentMode | null,
        content_mode_note: note ? limited(note, TECHNICAL_PLAN_TEXT_MAX, '处理方式说明') : null,
        source_requirement_id: requirementId ? limited(requirementId, TECHNICAL_PLAN_KEY_MAX, '来源要求 id') : null,
        source_requirement_title: requirementTitle ? limited(requirementTitle, TECHNICAL_PLAN_TITLE_MAX, '来源要求标题') : null,
        knowledge_item_ids: knowledgeItemIds,
        content,
        branch,
      });
      if (branch) walk(children as unknown[], id, level + 1);
    });
  };
  walk(outline, null, 1);
  return rows;
}

/** 目录的项目名称与概述（与桌面版相同，空时不存）。 */
export function outlineHeader(outlineData: Record<string, unknown>): { name: string | null; overview: string | null } {
  const name = limited(optionalString(outlineData, 'project_name', '目录项目名称') ?? '', TECHNICAL_PLAN_TITLE_MAX, '目录项目名称');
  const overview = limited(optionalString(outlineData, 'project_overview', '目录项目概述') ?? '', TECHNICAL_PLAN_BID_ITEM_CONTENT_MAX, '目录项目概述');
  return { name: name || null, overview: overview || null };
}

/** 与桌面版 technicalPlanOutline.cjs 的 numberOutline 相同：编号只反映当前树的位置，不修改节点身份。 */
export function numberOutline<T extends { children?: T[] }>(items: readonly T[], prefix = ''): (T & { number: string })[] {
  return items.map((item, index) => {
    const number = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    return { ...item, number, ...(item.children?.length ? { children: numberOutline(item.children, number) } : {}) };
  });
}

/**
 * 与桌面版 loadOutlineData 相同组装成树并编号：行按层级、父节点、同级顺序排好后依次挂到父节点下，父节点不存在的节点作为
 * 根节点；空的可选字段省略。
 */
export function buildOutline(
  rows: readonly OutlineNodeRow[],
  header: { name: string | null; overview: string | null },
): TechnicalPlanOutlineData | null {
  if (rows.length === 0) return null;
  type Draft = Omit<TechnicalPlanOutlineItem, 'number' | 'children'> & { children?: Draft[] };
  const items = new Map<string, Draft>();
  for (const row of rows) {
    const item: Draft = { id: row.node_id, title: row.title, description: row.description };
    if (row.content_mode) item.content_mode = row.content_mode;
    if (row.content_mode_note) item.content_mode_note = row.content_mode_note;
    if (row.source_requirement_id) item.source_requirement_id = row.source_requirement_id;
    if (row.source_requirement_title) item.source_requirement_title = row.source_requirement_title;
    if (row.knowledge_item_ids?.length) item.knowledge_item_ids = row.knowledge_item_ids;
    if (row.content) item.content = row.content;
    items.set(row.node_id, item);
  }
  const roots: Draft[] = [];
  for (const row of rows) {
    const item = items.get(row.node_id)!;
    const parent = row.parent_node_id ? items.get(row.parent_node_id) : undefined;
    if (parent) (parent.children ??= []).push(item);
    else roots.push(item);
  }
  return {
    outline: numberOutline(roots) as TechnicalPlanOutlineItem[],
    ...(header.name ? { project_name: header.name } : {}),
    ...(header.overview ? { project_overview: header.overview } : {}),
  };
}

// ---- 全局事实 ----

export interface GlobalFactGroupInput {
  id: string;
  title: string;
  content: string;
}

/** 与桌面版 normalizeGlobalFactId 相同：小写，非字母数字下划线连字符的连续字符换成下划线，去掉首尾下划线；为空时按序号。 */
export function normalizeGlobalFactId(value: unknown, index: number): string {
  const id = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id ? [...id].slice(0, FACT_ID_BASE_MAX).join('') : `fact_${String(index + 1).padStart(3, '0')}`;
}

/**
 * 与桌面版 normalizeGlobalFactGroups 相同：标题和内容去掉首尾空白，任一为空的分组丢弃；id 取 id、group_id 或标题，按
 * normalizeGlobalFactId 整理，重复时追加 _2、_3……。另限制分组数和字数，超出时抛 OutlineInputError。
 */
export function normalizeGlobalFactGroups(groups: unknown): GlobalFactGroupInput[] {
  if (!Array.isArray(groups)) throw new OutlineInputError('全局事实必须是数组');
  if (groups.length > TECHNICAL_PLAN_FACT_GROUPS_MAX) throw new OutlineInputError(`全局事实最多 ${TECHNICAL_PLAN_FACT_GROUPS_MAX} 组`);
  const seen = new Set<string>();
  const result: GlobalFactGroupInput[] = [];
  groups.forEach((group, index) => {
    const source = isObject(group) ? group : {};
    const title = stripNul(String(source.title || '')).trim();
    const content = stripNul(String(source.content || '')).trim();
    if (!title || !content) return;
    limited(title, TECHNICAL_PLAN_TITLE_MAX, '全局事实标题');
    limited(content, TECHNICAL_PLAN_FACT_CONTENT_MAX, '全局事实内容');
    let id = normalizeGlobalFactId(source.id || source.group_id || title, index);
    let suffix = 2;
    while (seen.has(id)) {
      id = `${id}_${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    result.push({ id, title, content });
  });
  return result;
}
