// src/technicalPlan/content.ts：与桌面版 technicalPlanStore.cjs 的 collectLeafItems、saveContentPlans 的过滤和 saveOutline 中运行进度的
// 保留规则逐条核对（桌面版没有导出这些函数）。
import { describe, expect, it } from 'vitest';
import { collectLeafItems, normalizeContentPlan, retainRuntimeAfterOutlineChange, serializeRuntime } from '../../src/technicalPlan/content.ts';

const PLAN = { image_suitability_score: 5, image_needed: false, knowledge: { item_ids: [] }, table: { needed: false, purpose: '' } };

describe('normalizeContentPlan', () => {
  it('plan 是对象、plan_version 大于 0 才保存；版本向下取整；表格要求不在列表中时不存', () => {
    expect(normalizeContentPlan({ plan_version: 1, plan: PLAN, table_requirement: 'heavy' })).toEqual({ plan_version: 1, plan: PLAN, table_requirement: 'heavy' });
    expect(normalizeContentPlan({ plan_version: '2.9', plan: PLAN, table_requirement: 'x' })).toEqual({ plan_version: 2, plan: PLAN, table_requirement: null });
    for (const value of [null, [], { plan: PLAN }, { plan_version: 0, plan: PLAN }, { plan_version: 0.5, plan: PLAN }, { plan_version: 1, plan: [] }, { plan_version: 1 }]) {
      expect(normalizeContentPlan(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('过大的编排、超出范围的版本抛 TypeError', () => {
    expect(() => normalizeContentPlan({ plan_version: 1, plan: { text: 'x'.repeat(200_000) } })).toThrow(TypeError);
    expect(() => normalizeContentPlan({ plan_version: 2 ** 31, plan: PLAN })).toThrow(TypeError);
  });
});

describe('serializeRuntime', () => {
  it('null / undefined 清除，只接受对象，过大抛 TypeError', () => {
    expect(serializeRuntime(null)).toBeNull();
    expect(serializeRuntime(undefined)).toBeNull();
    expect(serializeRuntime({ phase: 'planning' })).toBe('{"phase":"planning"}');
    expect(() => serializeRuntime([])).toThrow(TypeError);
    expect(() => serializeRuntime('x')).toThrow(TypeError);
    expect(() => serializeRuntime({ x: 'x'.repeat(800_000) })).toThrow(TypeError);
  });
});

describe('collectLeafItems', () => {
  it('与桌面版相同：有子节点的节点展开，空 children 视为叶子', () => {
    const leaf = (id: string, children?: unknown[]) => ({ id, title: id, description: '', number: '', ...(children ? { children } : {}) }) as never;
    const items = [leaf('a', [leaf('a1'), leaf('a2', [leaf('a21')])]), leaf('b', []), leaf('c')];
    expect(collectLeafItems(items).map((item: { id: string }) => item.id)).toEqual(['a1', 'a21', 'b', 'c']);
  });
});

describe('retainRuntimeAfterOutlineChange', () => {
  const row = (node_id: string, parent_node_id: string | null, content_mode: string | null = 'ai-generate') => ({ node_id, parent_node_id, content_mode });

  it('保留仍是 ai-generate 叶子且未失效的字数与 Word 小节；新叶子进入直接生成范围，已开始生成时也进入待生成范围', () => {
    const rows = [row('p', null, null), row('a', 'p'), row('b', 'p'), row('c', 'p', 'manual-fill'), row('n', null), row('was-branch', null)];
    const runtime = retainRuntimeAfterOutlineChange(
      {
        generation_started: 1,
        section_words: { a: 1, b: 2, c: 3, gone: 4 },
        html_output: { workspace_dir: 'w', word_sections: [{ section_id: 'a' }, { section_id: 'b' }, 'bad', { section_id: 'c' }] },
        phase: 'done',
        direct_generation_item_ids: ['a', 'b', 'gone', 'c', 'a', 7],
        pending_item_ids: ['b', 'a'],
        touched_item_ids: ['a'],
        target_item_id: 'a',
      },
      { rows, previousIds: new Set(['p', 'a', 'b', 'c', 'gone', 'was-branch']), previousParents: new Set([null, 'p', 'was-branch']), affected: new Set(['b']) },
    );
    expect(runtime).toEqual({
      generation_started: true,
      section_words: { a: 1 },
      html_output: { workspace_dir: 'w', word_sections: [{ section_id: 'a' }] },
      phase: 'planning',
      direct_generation_item_ids: ['a', 'n', 'was-branch'],
      pending_item_ids: ['a', 'n', 'was-branch'],
    });
  });

  it('没有运行进度时按空对象处理：未开始生成，新叶子只进入直接生成范围，没有 html_output', () => {
    expect(
      retainRuntimeAfterOutlineChange(null, { rows: [row('a', null), row('b', null)], previousIds: new Set(['a']), previousParents: new Set([null]), affected: new Set() }),
    ).toEqual({ generation_started: false, section_words: {}, phase: 'planning', direct_generation_item_ids: ['b'], pending_item_ids: [] });
  });

  it('html_output 中 word_sections 不是数组时视为空', () => {
    expect(
      retainRuntimeAfterOutlineChange({ html_output: { x: 1 } }, { rows: [], previousIds: new Set(), previousParents: new Set(), affected: new Set() }).html_output,
    ).toEqual({ x: 1, word_sections: [] });
  });
});
