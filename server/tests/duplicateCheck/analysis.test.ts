// 标书查重的逐文档提取（server/sandbox/parse/duplicateText.mjs，沙箱中运行）与跨文档比对（src/duplicateCheck/analysis.ts，worker 中运行）。
// 期望值按桌面版 duplicateCheckService.cjs 的同名函数对同一输入的结果给出；HTML 表格的文字读取（duplicateTables.mjs，cheerio）
// 在 tests/sandbox/docker/parse.test.ts 中经真实沙箱测试。
import { describe, expect, it } from 'vitest';
import * as text from '../../sandbox/parse/duplicateText.mjs';
import {
  ANALYSIS_LIMITS,
  basicMetadataFields,
  buildDuplicateImages,
  buildDuplicateSentences,
  buildOutlineComparison,
  buildTenderSourceMatcher,
  DuplicateAnalysisError,
  matchTenderSentence,
  mergeTenderSentences,
  metadataItems,
  normalizeContentSentence,
  parseDuplicateAnalysis,
  type GlobalImage,
  type GlobalSentence,
  type OutlineFile,
} from '../../src/duplicateCheck/analysis.ts';

const noTables = () => [];

const BID = `# 投标文件

目录

第一章 投标函 ........ 1
第二章 技术方案 ...... 5
1.1 项目概述 7

## 1 投标函

致：采购人

根据贵方项目编号 ABC-2024-001 的招标文件，我方愿意参加投标。
项目名称：消防装备管理系统项目

![图1](images/image-0001.png)

**技术响应**

<table><tr><td>CPU 不低于 2.0GHz</td></tr></table>

| 名称 | 说明 |
|---|---|
| 服务器 | 采用国产化服务器，保证系统稳定运行。 |

- 我们承诺在合同签订后30日历天内完成全部交付工作。

\`\`\`
![代码中的图](images/image-0003.png)
\`\`\`

<img src="images/image-0002.jpg" alt="a"> 前一句话在这里。后一句；
![远程](https://example.com/x.png)
![内嵌](data:image/png;base64,AAAA)
`;

describe('逐文档提取（duplicateText.mjs）', () => {
  it('目录：有“目录”页时取目录页（编号推断层级），路径与父子关系', () => {
    const outline = text.buildOutlineItems(BID);
    expect(outline.source).toBe('catalog');
    expect(outline.confidence).toBe(0.92);
    expect(outline.items.map((item) => [item.id, item.level, item.number, item.title, item.parentId, item.normalizedPath])).toEqual([
      ['O00001', 1, '第一章', '投标函', null, '投标函'],
      ['O00002', 1, '第二章', '技术方案', null, '技术方案'],
      ['O00003', 2, '1.1', '项目概述', 'O00002', '技术方案>项目概述'],
    ]);
    expect(outline.items[2]!.pathTitles).toEqual(['技术方案', '项目概述']);
  });

  it('目录：没有目录页时取 Markdown 标题，层级不跳级；都没有时为空', () => {
    const outline = text.buildOutlineItems('# 总体\n\n#### 细节一\n\n## 方案\n\n## 方案\n');
    expect(outline.source).toBe('heading');
    expect(outline.items.map((item) => [item.title, item.level, item.parentId])).toEqual([
      ['总体', 1, null],
      ['细节一', 2, 'O00001'],
      ['方案', 2, 'O00001'],
    ]);
    expect(text.buildOutlineItems('只有正文，没有任何标题。')).toEqual({ items: [], source: null, confidence: 0 });
  });

  it('正文句子：表格单元格经注入的读取函数，代码块与图片去掉，按句末标点切分，过短或纯数字的不要', () => {
    const tables: string[] = [];
    const sentences = text.splitContentSentences(BID, (html) => {
      tables.push(html);
      return ['CPU 不低于 2.0GHz'];
    });
    expect(tables).toEqual(['<table><tr><td>CPU 不低于 2.0GHz</td></tr></table>']);
    const normalized = sentences.map((item) => item.normalized);
    expect(normalized).toEqual(
      expect.arrayContaining([
        '根据贵方项目编号 ABC-2024-001 的招标文件，我方愿意参加投标。',
        '项目名称：消防装备管理系统项目',
        'CPU 不低于 2.0GHz',
        '采用国产化服务器，保证系统稳定运行。',
        '我们承诺在合同签订后30日历天内完成全部交付工作。',
      ]),
    );
    expect(normalized.some((item) => item.includes('代码中的图') || item.includes('image-'))).toBe(false);
    // 超过 600 个字符的句子截短（比较仍用完整的 normalized）。
    const long = text.splitContentSentences(`${'很长的句子'.repeat(200)}。`, noTables)[0]!;
    expect(long.sentence).toHaveLength(603);
    expect(long.normalized).toHaveLength(1001);
  });

  it('招标句子（目录白名单）：按规范化的标题去重，太短或太长的不要', () => {
    const sentences = text.splitTenderSentences('第三章 售后服务要求及培训安排\n售后服务要求及培训安排。\n短句\n');
    expect(sentences).toEqual([{ text: '第三章 售后服务要求及培训安排', normalized: '售后服务要求及培训安排' }]);
  });

  it('图片位置：只收解析输出中的图片，编号连续，记下所在目录和前一句；代码块、远程地址、data: 不计', () => {
    expect(text.extractImageOccurrences(BID)).toEqual([
      // 目录页中的“第二章 技术方案”行同样被当作标题（与桌面版相同）。
      { path: 'images/image-0001.png', index: 1, directory: '技术方案 > 1 投标函', previousSentence: '项目名称：消防装备管理系统项目' },
      { path: 'images/image-0002.jpg', index: 2, directory: '技术方案 > 技术响应', previousSentence: '我们承诺在合同签订后30日历天内完成全部交付工作' },
    ]);
  });

  it('汇总的结果能通过 worker 的校验', () => {
    const analysis = text.analyzeDuplicateCheckDocument(BID.trim(), noTables);
    const parsed = parseDuplicateAnalysis(Buffer.from(JSON.stringify(analysis)), new Set(['images/image-0001.png', 'images/image-0002.jpg']));
    expect(parsed.outline.items).toHaveLength(3);
    expect(parsed.images.map((image) => image.path)).toEqual(['images/image-0001.png', 'images/image-0002.jpg']);
    expect(parsed.sentences.length).toBe(analysis.sentences.length);
  });

  it('normalizeContentSentence 与 worker 中的副本一致（招标原文比较时再次规范化）', () => {
    const samples = ['1.2 技术要求：不低于', '（三）项目概述', '第二章 售后服务', '① 培训计划', '(12) 质保期', '一、总则', '  2\\.1\\. 转义编号', '﻿零宽​字符'];
    for (const sample of samples) expect(normalizeContentSentence(sample)).toBe(text.normalizeContentSentence(sample));
  });
});

describe('analysis.json 的校验', () => {
  const valid = () => JSON.parse(JSON.stringify(text.analyzeDuplicateCheckDocument(BID.trim(), noTables)));
  const images = new Set(['images/image-0001.png', 'images/image-0002.jpg']);
  const parse = (value: unknown, paths: ReadonlySet<string> = images) => parseDuplicateAnalysis(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), paths);

  it('合法的输出原样读出', () => {
    expect(parse(valid()).outline.items[2]).toMatchObject({ id: 'O00003', parentId: 'O00002', level: 2 });
  });

  it.each<[string, (analysis: any) => unknown]>([
    ['不是 JSON', () => '{'],
    ['多出字段', (analysis) => ({ ...analysis, extra: 1 })],
    ['版本不符', (analysis) => ({ ...analysis, version: 2 })],
    ['目录项编号不连续', (analysis) => { analysis.outline.items[1].id = 'O00009'; return analysis; }],
    ['目录项多出字段', (analysis) => { analysis.outline.items[0].html = '<b>'; return analysis; }],
    ['层级越界', (analysis) => { analysis.outline.items[0].level = 7; return analysis; }],
    ['父目录项不存在', (analysis) => { analysis.outline.items[2].parentId = 'O00099'; return analysis; }],
    ['父目录项在它之后', (analysis) => { analysis.outline.items[2].parentId = 'O00003'; return analysis; }],
    ['父目录项层级不符', (analysis) => { Object.assign(analysis.outline.items[2], { level: 3, pathTitles: ['技术方案', '中间', '项目概述'] }); return analysis; }],
    ['父目录项的路径不符', (analysis) => { analysis.outline.items[2].parentId = 'O00001'; return analysis; }],
    ['一级目录有父目录项', (analysis) => { analysis.outline.items[0].parentId = 'O00002'; return analysis; }],
    ['路径与标题不符', (analysis) => { analysis.outline.items[2].pathTitles = ['技术方案', '别的标题']; return analysis; }],
    ['来源不合法', (analysis) => { analysis.outline.items[0].source = 'script'; return analysis; }],
    ['置信度不是有限数', (analysis) => { analysis.outline.confidence = 2; return analysis; }],
    ['有目录项而没有来源', (analysis) => { analysis.outline.source = null; return analysis; }],
    ['招标句子太长', (analysis) => { analysis.tenderSentences = [{ text: 'x', normalized: 'x'.repeat(161) }]; return analysis; }],
    ['句子太长', (analysis) => { analysis.sentences = [{ sentence: 'x'.repeat(604), normalized: 'x' }]; return analysis; }],
    ['句子不是字符串', (analysis) => { analysis.sentences = [{ sentence: 1, normalized: 'x' }]; return analysis; }],
    ['图片不在输出中', (analysis) => { analysis.images[0].path = 'images/image-0005.png'; return analysis; }],
    ['图片路径带目录穿越', (analysis) => { analysis.images[0].path = '../images/image-0001.png'; return analysis; }],
    ['图片编号不连续', (analysis) => { analysis.images[1].index = 5; return analysis; }],
    ['前一句太长', (analysis) => { analysis.images[0].previousSentence = 'x'.repeat(501); return analysis; }],
    ['目录项过多', (analysis) => ({ ...analysis, outline: { ...analysis.outline, items: Array(ANALYSIS_LIMITS.outlineItems + 1).fill(analysis.outline.items[0]) } })],
  ])('拒绝：%s', (_name, mutate) => {
    expect(() => parse(mutate(valid()))).toThrow(DuplicateAnalysisError);
  });

  it('非法 UTF-8 拒绝', () => {
    expect(() => parseDuplicateAnalysis(Buffer.from([0x7b, 0xff, 0x7d]), images)).toThrow(DuplicateAnalysisError);
  });
});

describe('招标原文白名单', () => {
  it('目录：多份招标文件的句子按顺序合并去重；标题相同、包含或被包含（长度够时）算来自招标文件', () => {
    const merged = mergeTenderSentences([
      [{ text: '第三章 售后服务要求及培训安排', normalized: '售后服务要求及培训安排' }],
      [{ text: '售后服务要求及培训安排', normalized: '售后服务要求及培训安排' }, { text: '投标人须知前附表', normalized: '投标人须知前附表' }],
    ]);
    expect(merged.map((item) => item.text)).toEqual(['第三章 售后服务要求及培训安排', '投标人须知前附表']);
    expect(matchTenderSentence('售后服务要求及培训安排', merged)?.text).toBe('第三章 售后服务要求及培训安排');
    expect(matchTenderSentence('售后服务要求及培训', merged)).toBeNull();
    expect(matchTenderSentence('售后服务要求及培训安排表', merged)?.text).toBe('第三章 售后服务要求及培训安排');
    expect(matchTenderSentence('短标题', merged)).toBeNull();
  });

  it('正文：逐字、去标点、格式字段、近似匹配；联系人等字段不算', async () => {
    const tender = text.splitContentSentences(
      [
        '技术要求：CPU 不低于 2.0GHz，内存不少于 16GB。',
        '项目名称：消防装备管理系统项目',
        '投标人须提供不少于三年的质保服务，并承担全部运输费用和安装调试费用。',
        '本项目要求供应商在合同签订后三十日内完成全部设备的供货与安装工作。',
        '投标日期：2024年3月5日',
      ].join('\n\n'),
      noTables,
    );
    const matcher = await buildTenderSourceMatcher(tender);
    expect(matcher.tenderSentenceCount).toBe(5);
    const reason = (value: string) => matcher.match(text.splitContentSentences(value, noTables)[0]!)?.reason ?? null;
    expect(reason('技术要求：CPU 不低于 2.0GHz，内存不少于 16GB。')).toBe('exact');
    expect(reason('CPU≥2.0GHz，内存≥16GB。')).toBe('strict');
    expect(reason('本项目要求供应商在合同签订后三十日内完成全部设备的供货与安装工作')).toBe('strict');
    expect(reason('投标日期：2025年1月9日')).toBe('field');
    expect(reason('投标人须提供不少于三年的质保服务，并承担全部运输费用及安装调试费用。')).toBe('near');
    expect(reason('投标日期：联系人张三')).toBeNull();
    expect(reason('我方采用自主研发的管理平台。')).toBeNull();
    expect((await buildTenderSourceMatcher([])).match({ sentence: 'x', normalized: '我方采用自主研发的管理平台。' })).toBeNull();
  });
});

describe('目录比对', () => {
  const file = (fileId: string, markdown: string, tender: ReturnType<typeof mergeTenderSentences> = []): OutlineFile => ({
    fileId,
    status: 'success',
    items: text.buildOutlineItems(markdown).items.map((item) => {
      const matched = matchTenderSentence(item.normalizedTitle, tender);
      return { ...item, fromTender: Boolean(matched), matchedTenderSentence: matched?.text ?? null };
    }),
  });

  it('同一路径的重复组、同名标题、相近标题的相似组，成功文件的两两相似度（与桌面版结果相同）', async () => {
    const tender = mergeTenderSentences([text.splitTenderSentences('# 招标文件\n\n第三章 售后服务要求及培训安排\n')]);
    const files: OutlineFile[] = [
      file('a', '# 投标文件\n## 1 项目概述\n## 2 技术方案\n### 2.1 网络架构总体设计\n### 2.2 安全保障措施\n## 3 售后服务要求及培训安排', tender),
      file('b', '# 投标文件\n## 1 项目概述\n## 2 技术方案\n### 2.1 网络架构总体设计书\n### 2.2 安全保障措施\n## 3 售后服务要求及培训安排', tender),
      file('c', '# 响应文件\n## 1 公司简介\n## 2 业绩证明'),
      { fileId: 'd', status: 'error', items: [] },
    ];
    expect(files[0]!.items.map((item) => item.fromTender)).toEqual([false, false, false, false, false, true]);
    const { duplicateGroups, pairwiseSimilarities } = await buildOutlineComparison(files);
    expect(duplicateGroups.map((group) => [group.id, group.type, group.title, group.score, group.fileIds, group.itemIds])).toEqual([
      ['G0001', 'duplicate', '投标文件', 1, ['a', 'b'], { a: ['O00001'], b: ['O00001'] }],
      ['G0002', 'duplicate', '投标文件 > 项目概述', 1, ['a', 'b'], { a: ['O00002'], b: ['O00002'] }],
      ['G0003', 'duplicate', '投标文件 > 技术方案', 1, ['a', 'b'], { a: ['O00003'], b: ['O00003'] }],
      ['G0004', 'duplicate', '投标文件 > 技术方案 > 安全保障措施', 1, ['a', 'b'], { a: ['O00005'], b: ['O00005'] }],
      ['G0005', 'similar', '网络架构总体设计', 0.93, ['a', 'b'], { a: ['O00004'], b: ['O00004'] }],
    ]);
    expect(duplicateGroups[4]!.paths).toEqual({ a: ['投标文件 > 技术方案 > 网络架构总体设计'], b: ['投标文件 > 技术方案 > 网络架构总体设计书'] });
    expect(pairwiseSimilarities.map((item) => [item.fileAId, item.fileBId, item.score, item.titleOverlap, item.pathOverlap, item.orderSimilarity, item.sharedCount, item.risk])).toEqual([
      ['a', 'b', 0.8, 0.8, 0.8, 0.8, 4, 'high'],
      ['a', 'c', 0, 0, 0, 0, 0, 'none'],
      ['b', 'c', 0, 0, 0, 0, 0, 'none'],
    ]);
  });
});

describe('重复句与重复图片', () => {
  it('至少两份文件中出现的才算，按文件数、长度、首次出现排序后编号', () => {
    const sentences = new Map<string, GlobalSentence>([
      ['甲', { sentence: '甲句', normalized: '甲', fileIds: ['a'], occurrences: { a: 3 }, firstOrder: 0 }],
      ['乙', { sentence: '乙句较长一些', normalized: '乙', fileIds: ['a', 'b'], occurrences: { a: 1, b: 1 }, firstOrder: 1 }],
      ['丙', { sentence: '丙句', normalized: '丙', fileIds: ['a', 'b', 'c'], occurrences: { a: 1, b: 1, c: 2 }, firstOrder: 2 }],
      ['丁', { sentence: '丁句较长一些', normalized: '丁', fileIds: ['b', 'c'], occurrences: { b: 1, c: 1 }, firstOrder: 0 }],
    ]);
    expect(buildDuplicateSentences(sentences).map((item) => [item.id, item.sentence])).toEqual([
      ['S000001', '丙句'],
      ['S000002', '丁句较长一些'],
      ['S000003', '乙句较长一些'],
    ]);
    const image = (hash: string, occurrences: Record<string, number>): GlobalImage => ({ hash, previewArtifactId: hash, fileIds: Object.keys(occurrences), occurrences, locations: {} });
    const images = new Map([
      ['h1', image('h1', { a: 1 })],
      ['h2', image('h2', { a: 1, b: 1 })],
      ['h3', image('h3', { a: 2, b: 3 })],
    ]);
    expect(buildDuplicateImages(images).map((item) => [item.id, item.hash])).toEqual([
      ['I000001', 'h3'],
      ['I000002', 'h2'],
    ]);
  });
});

describe('元数据：文件基本信息', () => {
  it('文件名、扩展名（带点）、大小、SHA-256；标签与比较值与桌面版相同，Base64 文本另加解码项', () => {
    const items = metadataItems(basicMetadataFields({ fileName: '  投标　文件.docx ', extension: 'docx', size: 2048, sha256: 'ab'.repeat(32) }));
    expect(items).toEqual([
      { key: 'file_name', label: '文件名', value: '投标 文件.docx', normalized: '投标文件.docx', dateDay: '', comparable: false, dateComparable: false },
      { key: 'extension', label: '扩展名', value: '.docx', normalized: '.docx', dateDay: '', comparable: false, dateComparable: false },
      { key: 'size', label: '文件大小', value: '2048', normalized: expect.any(String), dateDay: expect.any(String), comparable: false, dateComparable: false },
      { key: 'file_sha256', label: '原始文件 SHA256', value: 'ab'.repeat(32), normalized: 'ab'.repeat(32), dateDay: '', comparable: true, dateComparable: false },
    ]);
    const decoded = metadataItems(new Map([['custom:账号', Buffer.from('zhang.san@example.com').toString('base64')]]));
    expect(decoded.map((item) => [item.key, item.label, item.value])).toEqual([
      ['custom:账号', '自定义：账号', Buffer.from('zhang.san@example.com').toString('base64')],
      ['custom:账号:base64_decoded', '自定义：账号（Base64 解码）', 'zhang.san@example.com'],
    ]);
  });
});
