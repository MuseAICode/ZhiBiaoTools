// 知识库段落匹配与补漏（src/knowledgeBase/match.ts）与桌面版 knowledgeBaseService.cjs 的 _internals 逐项对照：
// 条目子批、匹配与补漏的消息、模型输出整理（含不合法的区间、条目 id 与字段）、同一条目的匹配合并，结果完全相同。
// 子批结果合并、补漏、最终条目与报告没有导出，经完整流程对照（tests/db/knowledgeBaseJobs.test.ts）。
import { describe, expect, it } from 'vitest';
import {
  blockOrderOf,
  buildMatchMessages,
  buildRecoveryMessages,
  compressBlockIdsToRanges,
  createFinalItems,
  mergeMatchResults,
  mergeRecoverySegmentResults,
  missingBlocksOf,
  nextKnowledgeItemId,
  normalizeMatchResult,
  normalizeRecoveryResult,
  packItemsIntoSegments,
} from '../../src/knowledgeBase/match.ts';
import { buildBlocks, buildUnifiedBlockSegments, type Block, type CandidateItem } from '../../src/knowledgeBase/prepare.ts';
import { desktop } from './desktop.ts';

const internals = desktop._internals;

const asDesktop = (blocks: readonly Block[]) => blocks.map(({ headingPath, ...rest }) => ({ ...rest, heading_path: headingPath }));

const sentence = (n: number) => `第${n}项施工组织措施包括人员配置、机械设备进场、材料检验与工序衔接，确保质量与安全目标全面实现。`;
const markdown = Array.from({ length: 30 }, (_, i) => `## 第${i + 1}节\n\n${Array.from({ length: 4 + (i % 3) }, (_, j) => sentence(i * 10 + j)).join('')}`).join('\n\n');
const { blocks } = buildBlocks(markdown);
const items: CandidateItem[] = Array.from({ length: 9 }, (_, i) => ({
  id: `K${String(i + 1).padStart(6, '0')}`,
  title: `条目${i + 1}：${'质量'.repeat(i)}`,
  summary: `用于编写第${i + 1}章的说明${'，'.repeat(i * 3)}`,
}));

describe('与桌面版对照', () => {
  it('样例有多个块', () => {
    expect(blocks.length).toBeGreaterThan(8);
  });

  it('条目子批：各种上限下分批相同', () => {
    for (const limit of [1, 50, 200, 400, 1000, 100_000]) {
      expect(packItemsIntoSegments(items, limit)).toEqual(internals.packItemsIntoSegments!(items, limit));
    }
    expect(packItemsIntoSegments([], 100)).toEqual([]);
  });

  it('匹配与补漏的消息逐字相同（单段与多段）', () => {
    for (const contextLengthLimit of [400_000, 2_000]) {
      const { segments } = buildUnifiedBlockSegments(blocks, contextLengthLimit);
      for (const segment of segments) {
        const desktopSegment = { ...segment, blocks: asDesktop(segment.blocks) };
        expect(buildMatchMessages('文档.docx', segment.text, items, segment)).toEqual(
          internals.buildMatchMessages!('文档.docx', segment.text, items, desktopSegment),
        );
        expect(buildRecoveryMessages('文档.docx', items, segment.blocks, segment)).toEqual(
          internals.buildRecoveryMessages!('文档.docx', items, asDesktop(segment.blocks), desktopSegment),
        );
      }
      expect(buildRecoveryMessages('文档.docx', [], blocks.slice(0, 2))).toEqual(internals.buildRecoveryMessages!('文档.docx', [], asDesktop(blocks.slice(0, 2))));
    }
  });

  const ids = blocks.map((block) => block.id);
  const outputs: unknown[] = [
    null,
    'not an object',
    [],
    { matches: 'x' },
    {
      matches: [
        { id: 'K000001', ranges: [[ids[0], ids[2]]] },
        { id: ' K000002 ', ranges: [[ids[5], ids[3]], ids[7], [ids[8]], ['P999999', ids[1]], [], null, 7] },
        { id: 'K000003', paragraph_ranges: [[ids[4], ids[4]]] },
        { id: 'K000004', block_ranges: [ids[6]] },
        { id: 'K999999', ranges: [[ids[0], ids[0]]] },
        { id: 'K000005', ranges: [] },
        { id: 'K000006' },
        null,
        'K000007',
        { id: 'K000001', ranges: [[ids[1], ids[3]]] },
      ],
      new_items: [
        { title: ' 新条目 ', summary: ' 说明 ', ranges: [[ids[2], ids[3]]] },
        { title: '只有简介', resume: '旧字段', ranges: [ids[5]] },
        { title: '', summary: '没有标题', ranges: [ids[5]] },
        { title: '没有区间', summary: '说明' },
        null,
      ],
      discarded: [{ ranges: [[ids[6], ids[7]]], reason: ' 页眉残留 ' }, { ranges: [ids[8]], reason: '   ' }, { ranges: [ids[0]] }, { ranges: ['P999999'] }, 3],
    },
  ];
  const itemIds = new Set(items.map((item) => item.id));
  const order = blockOrderOf(blocks);

  it('匹配输出的整理相同', () => {
    for (const output of outputs) {
      expect(normalizeMatchResult(output, itemIds, blocks, order)).toEqual(internals.normalizeMatchResult!(output, itemIds, asDesktop(blocks), order));
    }
  });

  it('补漏输出的整理相同', () => {
    for (const output of outputs) {
      expect(normalizeRecoveryResult(output, itemIds, blocks, order)).toEqual(internals.normalizeRecoveryResult!(output, itemIds, asDesktop(blocks), order));
    }
  });

  it('同一条目的匹配合并相同', () => {
    const lists = outputs.map((output) => normalizeMatchResult(output, itemIds, blocks, order).matches);
    expect(mergeMatchResults(lists)).toEqual(internals.mergeMatchResults!(lists));
    expect(mergeMatchResults([[{ id: '', ranges: [], block_ids: [] }]])).toEqual(internals.mergeMatchResults!([[{ id: '', ranges: [], block_ids: [] }]]));
  });
});

describe('整理与合并', () => {
  const order = blockOrderOf(blocks);
  const [a, b, c, d, e] = blocks.map((block) => block.id);

  it('块 id 压成闭区间：去重、按顺序、丢掉不认识的块', () => {
    expect(compressBlockIdsToRanges([d!, a!, b!, 'X', b!, e!], order)).toEqual([
      [a, b],
      [d, e],
    ]);
    expect(compressBlockIdsToRanges([], order)).toEqual([]);
  });

  it('补漏子批合并：每个块只归属一次，优先级 matches > new_items > discarded，与子批顺序无关', () => {
    const parsed = [
      { matches: [], new_items: [], discarded: [{ ranges: [], block_ids: [a!, b!], reason: '舍弃' }] },
      { matches: [{ id: 'K000001', ranges: [], block_ids: [b!, c!] }], new_items: [{ title: '新', summary: '说明', ranges: [], block_ids: [a!, d!] }], discarded: [] },
      { matches: [{ id: 'K999999', ranges: [], block_ids: [e!] }], new_items: [], discarded: [] },
    ];
    expect(mergeRecoverySegmentResults(parsed, new Set(['K000001']), order)).toEqual({
      matches: [{ id: 'K000001', ranges: [[b, c]], block_ids: [b, c] }],
      new_items: [{ title: '新', summary: '说明', ranges: [[a, a], [d, d]], block_ids: [a, d] }],
      discarded: [],
    });
  });

  it('遗漏块、下一个条目 id、最终条目', () => {
    const matches = [{ id: 'K000001', ranges: [], block_ids: [a!, c!] }];
    expect(missingBlocksOf(blocks.slice(0, 5), matches, [{ ranges: [], block_ids: [b!], reason: '' }], [{ block_ids: [e!], reason: '' }]).map((block) => block.id)).toEqual([d]);
    expect(nextKnowledgeItemId([{ id: 'K000009', title: '', summary: '' }, { id: 'X000100', title: '', summary: '' }])).toBe('K000010');
    expect(nextKnowledgeItemId([])).toBe('K000001');
    const final = createFinalItems(items.slice(0, 2), [...matches, { id: 'K000001', ranges: [], block_ids: [c!, b!] }], blocks, '文档.docx');
    expect(final).toEqual([
      {
        id: 'K000001',
        title: items[0]!.title,
        resume: items[0]!.summary,
        content: [blocks[0]!.content, blocks[2]!.content, blocks[1]!.content].join('\n\n'),
        sourceBlockIds: [a, c, b],
        sourceFile: '文档.docx',
      },
    ]);
  });
});
