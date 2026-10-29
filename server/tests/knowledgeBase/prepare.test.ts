// 知识库文档准备的切块、分段与提示词（src/knowledgeBase/prepare.ts）与桌面版 knowledgeBaseService.cjs 的 _internals 逐项对照：
// 同一 Markdown 的原始块、语义合并、筛选、提示词渲染、统一分段，首轮 / 补充提取的消息，模型输出整理与合并，结果完全相同。
// 完整流程（解析 → 切块 → 提取 → 合并候选条目）的请求序列对照见 tests/db/knowledgeBaseJobs.test.ts。
import { describe, expect, it } from 'vitest';
import {
  buildBlocks,
  buildInitialItemMessages,
  buildSupplementItemMessages,
  buildUnifiedBlockSegments,
  createRawBlocks,
  filterBlocks,
  mergeCandidateItems,
  mergeSemanticBlocks,
  mergeTitleSummaryItems,
  normalizeCandidateItems,
  packBlocksIntoSegments,
  renderBlocksForPrompt,
  stripMarkdownFence,
  type Block,
} from '../../src/knowledgeBase/prepare.ts';
import { desktop } from './desktop.ts';

const internals = desktop._internals;

/** 服务端的块换成桌面版的字段名（heading_path）。 */
const asDesktop = (blocks: readonly (Block & { reason?: string })[]) =>
  blocks.map(({ headingPath, ...rest }) => ({ ...rest, heading_path: headingPath }));
const fromDesktop = (blocks: any[]): Block[] => blocks.map(({ heading_path, ...rest }) => ({ ...rest, headingPath: heading_path }));

/** 覆盖各种块类型与筛选原因的样例文档。 */
function sampleMarkdown(seed: number): string {
  const sentence = (n: number) => `第${n}项施工组织措施包括人员配置、机械设备进场、材料检验与工序衔接，确保质量与安全目标全面实现。`;
  const paragraph = (n: number, count: number) => Array.from({ length: count }, (_, i) => sentence(n * 10 + i)).join('');
  const parts = [
    '投标文件',
    '项目名称：某市政道路改造工程\n招标编号：ZB-2024-001\n投标人：某建设集团',
    '# 目录',
    '第一章 总体概述........1\n第二章 施工方案........5\n第三章 质量保证........9',
    '- 1 -',
    '页眉：某建设集团投标文件',
    '# 第一章 总体概述',
    paragraph(1, 4),
    '**1.1 工程概况**',
    paragraph(2, 2),
    '页眉：某建设集团投标文件',
    '## 1.2 编制依据',
    '- 《城市道路工程设计规范》CJJ 37\n- 《混凝土结构工程施工质量验收规范》GB 50204\n- 招标文件及答疑纪要',
    paragraph(3, 3),
    '| 序号 | 设备名称 | 数量 |\n| --- | --- | --- |\n| 1 | 挖掘机 | 4 |\n| 2 | 压路机 | 3 |',
    '<table><tr><td>人员</td><td>数量</td></tr><tr><td>项目经理</td><td>1</td></tr></table>',
    '一、质量目标',
    paragraph(4, 1),
    '1. 合格率 100%',
    paragraph(5, 6),
    '页眉：某建设集团投标文件',
    `### 第三章 超长段落\n\n${paragraph(6, 4 + seed).repeat(40)}`,
    '第2页共10页',
    '投标人（盖章）：某建设集团\n法定代表人或授权代表（签字）：\n年 月 日',
    paragraph(7, 2 + seed),
    '```\n代码块不影响切块\n```',
  ];
  return parts.join('\n\n');
}

describe('切块与筛选', () => {
  for (const seed of [0, 1, 2]) {
    it(`样例 ${seed}：原始块、语义合并、筛选与桌面版相同`, () => {
      const markdown = sampleMarkdown(seed);
      const raw = createRawBlocks(markdown);
      expect(asDesktop(raw)).toEqual(internals.createRawBlocks!(markdown));
      // 超长段落被切开（覆盖 splitOversizedText）。
      expect(raw.some((block) => block.content.length > 4000)).toBe(true);
      expect(raw.length).toBeGreaterThan(20);
      const merged = mergeSemanticBlocks(raw);
      expect(asDesktop(merged)).toEqual(internals.mergeSemanticBlocks!(internals.createRawBlocks!(markdown)));
      const filtered = filterBlocks(merged);
      const expected = internals.filterBlocks!(internals.mergeSemanticBlocks!(internals.createRawBlocks!(markdown)));
      expect(asDesktop(filtered.blocks)).toEqual(expected.blocks);
      expect(asDesktop(filtered.filteredBlocks)).toEqual(expected.filtered_blocks);
      expect(filtered.filteredBlocks.length).toBeGreaterThan(0);
      expect(buildBlocks(markdown)).toEqual(filtered);
      expect(renderBlocksForPrompt(filtered.blocks)).toBe(internals.renderBlocksForPrompt!(expected.blocks));
    });
  }

  it('筛选原因：空块、页码、过短、目录、重复页眉页脚、封面、签字页', () => {
    const block = (content: string, index: number): Block => ({ id: `R${index}`, type: 'paragraph', headingPath: ['一', '二'], content });
    const long = (n: number) => `第${n}段正文用于凑足字数，`.repeat(12);
    const header = `页眉内容${'。'.repeat(100)}`;
    const contents = [
      '',
      '- 12 -',
      '短',
      `目录\n第一章 概述........1\n第二章 方案........5\n${'x'.repeat(100)}........9`,
      header,
      `投标文件${'某'.repeat(120)}`,
      header,
      header,
      ...Array.from({ length: 8 }, (_, i) => long(i)),
      `投标人（盖章）${'某'.repeat(100)}`,
      long(99),
    ];
    const inputs = contents.map(block);
    const result = filterBlocks(inputs);
    const expected = internals.filterBlocks!(asDesktop(inputs));
    expect(asDesktop(result.filteredBlocks)).toEqual(expected.filtered_blocks);
    expect(asDesktop(result.blocks)).toEqual(expected.blocks);
    expect(result.filteredBlocks.map((entry) => entry.reason)).toEqual([
      'empty',
      'page_number',
      'too_short',
      'catalog',
      'repeated_header_footer',
      'cover',
      'repeated_header_footer',
      'repeated_header_footer',
      'signature_page',
    ]);
    expect(result.blocks.map((entry) => entry.id)).toEqual(Array.from({ length: 9 }, (_, i) => `P${String(i + 1).padStart(6, '0')}`));
  });

  it('去掉 Markdown 代码块围栏与桌面版相同', () => {
    for (const value of ['```markdown\n# 标题\n正文\n```', '正文```', '```\n```', '普通正文']) {
      const desktopStrip = (content: string) => String(content || '').replace(/^```[\s\S]*?\n/, '').replace(/```$/g, '').trim();
      expect(stripMarkdownFence(value)).toBe(desktopStrip(value));
    }
  });
});

describe('分段与提示词', () => {
  const { blocks } = buildBlocks(sampleMarkdown(1));
  const desktopBlocks = asDesktop(blocks);

  it('按渲染长度打包、统一分段（各种上下文长度）与桌面版相同', () => {
    for (const limit of [1, 500, 3000, 20_000, 400_000]) {
      const segments = packBlocksIntoSegments(blocks, limit);
      const expected = internals.packBlocksIntoSegments!(desktopBlocks, limit);
      expect(segments.map((segment) => ({ ...segment, blocks: asDesktop(segment.blocks) }))).toEqual(expected);
    }
    for (const contextLengthLimit of [2_000, 10_000, 40_000, 400_000]) {
      const unified = buildUnifiedBlockSegments(blocks, contextLengthLimit);
      const expected = internals.buildUnifiedBlockSegments!(desktopBlocks, { getConfig: () => ({ context_length_limit: contextLengthLimit }) });
      expect({ ...unified, segments: unified.segments.map((segment) => ({ ...segment, blocks: asDesktop(segment.blocks) })) }).toEqual(expected);
    }
    expect(buildUnifiedBlockSegments(blocks, 4_000).segments.length).toBeGreaterThan(2);
    expect(packBlocksIntoSegments([], 100)).toEqual([]);
  });

  it('首轮提取与补充提取的消息逐字相同（单段与多段）', () => {
    const items = [
      { title: '施工组织', summary: '可用于施工组织设计章节' },
      { title: '质量保证 "措施"', summary: '含引号\n与换行' },
    ];
    for (const segment of [null, { index: 1, total: 1 }, { index: 2, total: 3 }]) {
      const text = renderBlocksForPrompt(blocks.slice(0, 3));
      expect(buildInitialItemMessages('投标文件.docx', text, segment)).toEqual(internals.buildInitialItemMessages!('投标文件.docx', text, segment));
      expect(buildSupplementItemMessages('投标文件.docx', text, items, segment)).toEqual(
        internals.buildSupplementItemMessages!('投标文件.docx', text, items, segment),
      );
    }
  });
});

describe('模型输出整理', () => {
  const outputs: unknown[] = [
    { items: [{ title: ' 施工组织 ', summary: ' 摘要 ' }, { title: '质量', resume: '用 resume' }, { title: '', summary: '无标题' }, { title: '无摘要' }, null, 3] },
    [{ title: '数组形式', summary: '直接是数组' }],
    { items: 'not array' },
    null,
    'text',
    { items: [{ title: 0, summary: 'x' }, { title: NaN, summary: 'x' }, { title: false, summary: 'x' }, { title: 12, summary: 34 }, { title: { a: 1 }, summary: ['b'] }] },
  ];

  it('normalizeCandidateItems 与桌面版相同', () => {
    for (const output of outputs) expect(normalizeCandidateItems(output)).toEqual(internals.normalizeCandidateItems!(output));
  });

  it('分段结果按标题去重合并、候选条目编号与桌面版相同', () => {
    const lists = [
      [
        { title: '施工 组织', summary: '一' },
        { title: '质量', summary: '二' },
      ],
      [
        { title: '施工组织', summary: '重复标题（去空白、不区分大小写）' },
        { title: 'Quality', summary: '三' },
        { title: 'quality', summary: '重复' },
        { title: '无摘要', summary: '' },
      ],
    ];
    const merged = mergeTitleSummaryItems(lists);
    expect(merged).toEqual(internals.mergeTitleSummaryItems!(lists));
    expect(merged.map((item) => item.title)).toEqual(['施工 组织', '质量', 'Quality']);
    // mergeCandidateItems 不在桌面版的 _internals 中，按桌面版的写法核对编号与去重。
    const candidates = mergeCandidateItems(merged, [{ title: '质 量', summary: '补充中的重复' }, { title: '应急预案', summary: '四' }]);
    expect(candidates).toEqual([
      { id: 'K000001', title: '施工 组织', summary: '一' },
      { id: 'K000002', title: '质量', summary: '二' },
      { id: 'K000003', title: 'Quality', summary: '三' },
      { id: 'K000004', title: '应急预案', summary: '四' },
    ]);
  });
});

describe('与桌面版的块互转', () => {
  it('fromDesktop 与 asDesktop 互逆', () => {
    const { blocks } = buildBlocks(sampleMarkdown(0));
    expect(fromDesktop(asDesktop(blocks))).toEqual(blocks);
  });
});
