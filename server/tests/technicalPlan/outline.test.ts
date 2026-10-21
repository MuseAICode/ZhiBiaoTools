// 技术方案的目录与全局事实：编号与桌面版 technicalPlanOutline.cjs 的 numberOutline 一致，目录展开、组装和全局事实整理的规则
// 与桌面版 technicalPlanStore.cjs 的 flattenOutlineItems / loadOutlineData / normalizeGlobalFactGroups 相同，另加的校验与上限。
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TECHNICAL_PLAN_OUTLINE_DEPTH_MAX } from '../../src/db/migrations/0019_technical_plan_outline.ts';
import {
  buildOutline,
  flattenOutline,
  normalizeGlobalFactGroups,
  normalizeGlobalFactId,
  numberOutline,
  OutlineInputError,
  outlineHeader,
  TECHNICAL_PLAN_FACT_GROUPS_MAX,
  TECHNICAL_PLAN_OUTLINE_NODES_MAX,
  type OutlineNodeRow,
} from '../../src/technicalPlan/outline.ts';

const require = createRequire(import.meta.url);

const ids: string[] = Array.from({ length: 6 }, () => randomUUID());

const TREE = [
  {
    id: ids[0],
    title: ' 第一章 ',
    description: ' 说明 ',
    content_mode: 'ai-generate',
    content_mode_note: '父节点上的会被去掉',
    children: [
      { id: ids[1], title: '', content_mode: 'other', content_mode_note: ' 特殊 ', content: '正文一', knowledge_item_ids: ['k1', 'k2'] },
      { id: ids[2], title: '小节', content_mode: 'manual-fill', content_mode_note: '非 other 时去掉', source_requirement_id: 'r1', source_requirement_title: '要求' },
    ],
  },
  { title: '没有 id 的节点连同子节点跳过', children: [{ id: ids[5], title: 'x' }] },
  { id: ids[3]!.toUpperCase(), title: '第二章', content_mode: '', knowledge_item_ids: [], children: [] },
];

describe('目录展开（flattenOutline）', () => {
  it('先序展开；没有 id 的节点连同子节点跳过；标题为空用“未命名章节”；处理方式只留在叶子、说明只留在 other；id 统一小写', () => {
    expect(flattenOutline(TREE)).toEqual([
      {
        node_id: ids[0],
        parent_node_id: null,
        sort_order: 0,
        level: 1,
        title: '第一章',
        description: '说明',
        content_mode: null,
        content_mode_note: null,
        source_requirement_id: null,
        source_requirement_title: null,
        knowledge_item_ids: null,
        content: undefined,
        branch: true,
      },
      {
        node_id: ids[1],
        parent_node_id: ids[0],
        sort_order: 0,
        level: 2,
        title: '未命名章节',
        description: '',
        content_mode: 'other',
        content_mode_note: '特殊',
        source_requirement_id: null,
        source_requirement_title: null,
        knowledge_item_ids: ['k1', 'k2'],
        content: '正文一',
        branch: false,
      },
      {
        node_id: ids[2],
        parent_node_id: ids[0],
        sort_order: 1,
        level: 2,
        title: '小节',
        description: '',
        content_mode: 'manual-fill',
        content_mode_note: null,
        source_requirement_id: 'r1',
        source_requirement_title: '要求',
        knowledge_item_ids: null,
        content: undefined,
        branch: false,
      },
      {
        node_id: ids[3],
        parent_node_id: null,
        sort_order: 2,
        level: 1,
        title: '第二章',
        description: '',
        content_mode: null,
        content_mode_note: null,
        source_requirement_id: null,
        source_requirement_title: null,
        knowledge_item_ids: null,
        content: undefined,
        branch: false,
      },
    ]);
  });

  it('不合法的结构、id、处理方式与超出上限一律抛 OutlineInputError', () => {
    const leaf = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), title: 't', ...extra });
    const cases: unknown[] = [
      {},
      ['x'],
      [leaf({ id: '1.2' })],
      [leaf({ id: 1 })],
      [{ ...leaf(), id: ids[0] }, { ...leaf(), id: ids[0]!.toUpperCase() }],
      [leaf({ content_mode: 'auto' })],
      [leaf({ children: {} })],
      [leaf({ title: 'x'.repeat(2001) })],
      [leaf({ content: 'x'.repeat(500_001) })],
      [leaf({ knowledge_item_ids: [1] })],
      [leaf({ knowledge_item_ids: Array.from({ length: 201 }, (_, index) => String(index)) })],
      [leaf({ source_requirement_id: 'x'.repeat(201) })],
      Array.from({ length: TECHNICAL_PLAN_OUTLINE_NODES_MAX + 1 }, () => leaf()),
    ];
    // 超过层级上限。
    let deep: Record<string, unknown> = leaf();
    for (let level = 1; level <= TECHNICAL_PLAN_OUTLINE_DEPTH_MAX; level += 1) deep = leaf({ children: [deep] });
    cases.push([deep]);
    for (const value of cases) expect(() => flattenOutline(value), JSON.stringify(value).slice(0, 80)).toThrow(OutlineInputError);
    expect(flattenOutline(Array.from({ length: TECHNICAL_PLAN_OUTLINE_NODES_MAX }, () => leaf()))).toHaveLength(TECHNICAL_PLAN_OUTLINE_NODES_MAX);
  });

  it('项目名称与概述：空时为 null，类型不对或超长时抛 OutlineInputError', () => {
    expect(outlineHeader({ project_name: '项目', project_overview: '' })).toEqual({ name: '项目', overview: null });
    expect(outlineHeader({})).toEqual({ name: null, overview: null });
    expect(() => outlineHeader({ project_name: 1 })).toThrow(OutlineInputError);
    expect(() => outlineHeader({ project_name: 'x'.repeat(2001) })).toThrow(OutlineInputError);
  });
});

describe('目录组装（buildOutline）', () => {
  it('与桌面版 numberOutline 编号相同', () => {
    const { numberOutline: desktop } = require('../../../client/electron/services/technicalPlanOutline.cjs') as {
      numberOutline(items: unknown[]): unknown[];
    };
    type Node = { id: string; children?: Node[] };
    const tree: Node[] = [{ id: 'a', children: [{ id: 'b' }, { id: 'c', children: [{ id: 'd' }] }] }, { id: 'e', children: [] }];
    expect(numberOutline(tree)).toEqual(desktop(tree));
  });

  it('按父节点组装、编号，空的可选字段省略；父节点不存在的节点作为根节点；没有节点时为 null', () => {
    const row = (nodeId: string, parent: string | null, sortOrder: number, extra: Partial<OutlineNodeRow> = {}): OutlineNodeRow => ({
      node_id: nodeId,
      parent_node_id: parent,
      sort_order: sortOrder,
      level: parent ? 2 : 1,
      title: nodeId,
      description: '',
      content_mode: null,
      content_mode_note: null,
      source_requirement_id: null,
      source_requirement_title: null,
      knowledge_item_ids: null,
      content: '',
      ...extra,
    });
    const rows = [
      row('a', null, 0),
      row('e', null, 1),
      row('b', 'a', 0, { content_mode: 'ai-generate', content: '正文', knowledge_item_ids: ['k'] }),
      row('c', 'a', 1, { content_mode: 'other', content_mode_note: '说明', source_requirement_id: 'r', source_requirement_title: '要求', knowledge_item_ids: [] }),
      row('orphan', 'missing', 0),
    ];
    expect(buildOutline(rows, { name: '项目', overview: null })).toEqual({
      outline: [
        {
          id: 'a',
          title: 'a',
          description: '',
          number: '1',
          children: [
            { id: 'b', title: 'b', description: '', content_mode: 'ai-generate', content: '正文', knowledge_item_ids: ['k'], number: '1.1' },
            {
              id: 'c',
              title: 'c',
              description: '',
              content_mode: 'other',
              content_mode_note: '说明',
              source_requirement_id: 'r',
              source_requirement_title: '要求',
              number: '1.2',
            },
          ],
        },
        { id: 'e', title: 'e', description: '', number: '2' },
        { id: 'orphan', title: 'orphan', description: '', number: '3' },
      ],
      project_name: '项目',
    });
    expect(buildOutline([], { name: '项目', overview: '概述' })).toBeNull();
  });
});

describe('全局事实', () => {
  it('分组 id 与桌面版 normalizeGlobalFactId 相同', () => {
    expect(normalizeGlobalFactId(' Team-Size ', 0)).toBe('team-size');
    expect(normalizeGlobalFactId('项目 团队', 2)).toBe('fact_003');
    expect(normalizeGlobalFactId('__a b__', 0)).toBe('a_b');
    expect(normalizeGlobalFactId('', 11)).toBe('fact_012');
    expect(normalizeGlobalFactId('x'.repeat(300), 0)).toHaveLength(200);
  });

  it('标题或内容为空的分组丢弃；id 取 id、group_id 或标题；重复时追加 _2、_3……', () => {
    expect(
      normalizeGlobalFactGroups([
        { id: 'team', title: ' 团队 ', content: ' 十人 ' },
        { title: '空内容', content: '  ' },
        { id: 'team', title: '团队二', content: '内容' },
        { id: 'team', title: '团队三', content: '内容' },
        { group_id: 'Schedule', title: '工期', content: '90 天' },
        { title: '质量', content: '合格' },
        null,
      ]),
    ).toEqual([
      { id: 'team', title: '团队', content: '十人' },
      { id: 'team_2', title: '团队二', content: '内容' },
      { id: 'team_2_3', title: '团队三', content: '内容' },
      { id: 'schedule', title: '工期', content: '90 天' },
      { id: 'fact_006', title: '质量', content: '合格' },
    ]);
  });

  it('超过分组数或字数上限、不是数组时抛 OutlineInputError', () => {
    expect(() => normalizeGlobalFactGroups({})).toThrow(OutlineInputError);
    expect(() => normalizeGlobalFactGroups(Array.from({ length: TECHNICAL_PLAN_FACT_GROUPS_MAX + 1 }, () => ({ title: 't', content: 'c' })))).toThrow(OutlineInputError);
    expect(() => normalizeGlobalFactGroups([{ title: 'x'.repeat(2001), content: 'c' }])).toThrow(OutlineInputError);
    expect(() => normalizeGlobalFactGroups([{ title: 't', content: 'x'.repeat(100_001) }])).toThrow(OutlineInputError);
    // 重复后缀不超过表的 id 上限。
    const groups = normalizeGlobalFactGroups(Array.from({ length: TECHNICAL_PLAN_FACT_GROUPS_MAX }, () => ({ id: 'x'.repeat(300), title: 't', content: 'c' })));
    expect(Math.max(...groups.map((group) => group.id.length))).toBeLessThanOrEqual(1000);
  });
});
