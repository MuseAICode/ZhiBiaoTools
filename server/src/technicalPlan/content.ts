// 技术方案正文生成状态的整理：与桌面版 technicalPlanStore.cjs 的 loadContentSections / saveContentPlans 的过滤规则、
// saveOutline 中正文生成运行进度（content_generation_runtime_json）的保留规则相同（桌面版没有导出这些函数，
// tests/technicalPlan/content.test.ts 按桌面版的规则逐条核对）。另加桌面版没有的大小上限，超出时抛 TypeError（调用方是
// 第 8 步的正文生成任务，传错是程序错误）。纯函数，不访问数据库。
import {
  TECHNICAL_PLAN_CONTENT_PLAN_MAX_BYTES,
  TECHNICAL_PLAN_CONTENT_RUNTIME_MAX_BYTES,
} from '../db/migrations/0020_technical_plan_content.ts';
import { TECHNICAL_PLAN_TABLE_REQUIREMENTS } from '../db/migrations/0018_technical_plan.ts';
import type { TechnicalPlanTableRequirement } from '../db/schema.ts';
import type { TechnicalPlanOutlineItem } from './outline.ts';

export type ContentRuntime = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * jsonb 的文本形式在冒号、逗号后多一个空格，比 JSON.stringify 的结果长；按 3/4 留出余量（与 0018 的标段列表相同），
 * 超出时抛 TypeError，不让数据库的 CHECK 在事务中途失败。
 */
function assertJsonSize(value: unknown, maxBytes: number, what: string): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > (maxBytes * 3) / 4) throw new TypeError(`${what}过大`);
  return text;
}

/** 正文生成运行进度：只接受对象（null / undefined 表示清除），返回要写入的 JSON 文本。 */
export function serializeRuntime(runtime: unknown): string | null {
  if (runtime === null || runtime === undefined) return null;
  if (!isObject(runtime)) throw new TypeError('正文生成运行进度必须是对象');
  return assertJsonSize(runtime, TECHNICAL_PLAN_CONTENT_RUNTIME_MAX_BYTES, '正文生成运行进度');
}

export interface NormalizedContentPlan {
  plan_version: number;
  plan: Record<string, unknown>;
  table_requirement: TechnicalPlanTableRequirement | null;
}

/**
 * 一节正文编排（与桌面版 saveContentPlans 的过滤相同）：plan 是对象、plan_version 大于 0 才保存，否则返回 null（跳过）。
 * plan_version 向下取整；表格要求不在列表中时不存。
 */
export function normalizeContentPlan(value: unknown): NormalizedContentPlan | null {
  if (!isObject(value) || !isObject(value.plan)) return null;
  const version = Math.floor(Number(value.plan_version));
  if (!Number.isFinite(version) || version <= 0) return null;
  if (version > 2_147_483_647) throw new TypeError('正文编排版本不合法');
  assertJsonSize(value.plan, TECHNICAL_PLAN_CONTENT_PLAN_MAX_BYTES, '正文编排');
  const requirement = value.table_requirement;
  return {
    plan_version: version,
    plan: value.plan,
    table_requirement: (TECHNICAL_PLAN_TABLE_REQUIREMENTS as readonly unknown[]).includes(requirement) ? (requirement as TechnicalPlanTableRequirement) : null,
  };
}

/** 目录中的叶子节点（与桌面版 collectLeafItems 相同：有子节点的节点展开，其余是叶子）。 */
export function collectLeafItems(items: readonly TechnicalPlanOutlineItem[]): TechnicalPlanOutlineItem[] {
  return items.flatMap((item) => (item.children?.length ? collectLeafItems(item.children) : [item]));
}

const stringIds = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);

export interface OutlineChange {
  /** 保存后的节点（先序），只需 id、父节点和处理方式。 */
  rows: readonly { node_id: string; parent_node_id: string | null; content_mode: string | null }[];
  /** 保存前已有的节点 id。 */
  previousIds: ReadonlySet<string>;
  /** 保存前有子节点的节点 id。 */
  previousParents: ReadonlySet<string | null>;
  /** 正文失效的节点（affectedNodeIds 与叶子 / 父节点身份变化的节点）。 */
  affected: ReadonlySet<string>;
}

/**
 * 目录结构变化（delete、add-root、add-child）后保留的正文生成运行进度，与桌面版 saveOutline 相同：
 * - 已确认的各节字数（section_words）和 Word 输出中的小节（html_output.word_sections）只保留仍是 ai-generate 叶子且正文未失效的节；
 * - 阶段回到 planning；
 * - 直接生成范围（direct_generation_item_ids）保留仍在目录中、未失效的 ai-generate 叶子，并加入新出现的 ai-generate 叶子
 *   （新节点，或由父节点变成叶子的节点）；
 * - 待生成范围（pending_item_ids）同样保留，已开始生成（generation_started）时也加入新叶子；
 * - 其他字段（touched_item_ids 等）不保留。
 * previous 不是对象时按空对象处理（桌面版没有运行进度时同样写出这些字段）。
 */
export function retainRuntimeAfterOutlineChange(previous: unknown, change: OutlineChange): ContentRuntime {
  const runtime = isObject(previous) ? previous : {};
  const generationStarted = Boolean(runtime.generation_started);
  const nextIds = new Set(change.rows.map((row) => row.node_id));
  const nextParents = new Set(change.rows.map((row) => row.parent_node_id));
  const leafIds = new Set(change.rows.filter((row) => !nextParents.has(row.node_id) && row.content_mode === 'ai-generate').map((row) => row.node_id));
  const newLeafIds = change.rows
    .filter((row) => leafIds.has(row.node_id) && (!change.previousIds.has(row.node_id) || change.previousParents.has(row.node_id)))
    .map((row) => row.node_id);
  const surviving = (ids: unknown) => stringIds(ids).filter((id) => nextIds.has(id) && !change.affected.has(id));
  const keepLeafIds = (ids: string[]) => [...new Set(ids)].filter((id) => leafIds.has(id));
  const keepResult = (id: unknown) => typeof id === 'string' && leafIds.has(id) && !change.affected.has(id);
  const sectionWords = isObject(runtime.section_words) ? runtime.section_words : {};
  const htmlOutput = runtime.html_output;
  return {
    generation_started: generationStarted,
    section_words: Object.fromEntries(Object.entries(sectionWords).filter(([id]) => keepResult(id))),
    ...(isObject(htmlOutput)
      ? {
          html_output: {
            ...htmlOutput,
            word_sections: (Array.isArray(htmlOutput.word_sections) ? htmlOutput.word_sections : []).filter(
              (section) => isObject(section) && keepResult(section.section_id),
            ),
          },
        }
      : {}),
    phase: 'planning',
    direct_generation_item_ids: keepLeafIds([...surviving(runtime.direct_generation_item_ids), ...newLeafIds]),
    pending_item_ids: keepLeafIds([...surviving(runtime.pending_item_ids), ...(generationStarted ? newLeafIds : [])]),
  };
}
