// 疑似多标段检测（src/technicalPlan/bidSectionDetector.ts）：与桌面版 utils/bidSectionDetector.cjs 的 detectBidSections
// 对同一批输入（典型写法、边界情况、随机拼接的片段）结果相同；按文件算摘要再合并与对合并正文整体检测相同；构造的长数字串、
// 长空白串、长行（桌面版的平方级输入）耗时与长度成正比。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  BID_SECTION_DETECTION_SET_MAX,
  combineBidSectionDetections,
  detectBidSections,
  parseBidSectionDetectionSummary,
  summarizeBidSectionDetection,
} from '../../src/technicalPlan/bidSectionDetector.ts';
import { combineTenderMarkdown } from '../../src/technicalPlan/tender.ts';

const require = createRequire(import.meta.url);
const desktop = require('../../../client/electron/utils/bidSectionDetector.cjs') as {
  detectBidSections(markdown: string): { hasMultiple: boolean; totalDeclared: number | null };
};

const CASES = [
  '',
  '   \n\t',
  '本项目共划分为3个标段。',
  '本项目分为 二 个 标段',
  '本项目共 1 个标段',
  '本项目共计 12 个包',
  '本项目合计十二个子项目，另设 3 个标段',
  '项目分为两个标段',
  '共分为十个标的',
  '共 100 个标段',
  '共 0 个标段',
  '共 07 个标段',
  '一标段：设备采购\n二标段：安装',
  '第一标段：设备\n第二标段：安装',
  '标段1：设备\n标段2：安装',
  '1标包；设备\n2标包;安装',
  '第3分包：A\n分包4：B',
  '一包：A\n二包：B',
  '标包3：A\n包5：B',
  '一、二标段：合并说明',
  '一、二标段：合并说明\n三标段：单独',
  '1,2 标包：说明\n3标包：说明',
  '三四标段：x\n五标段：y',
  '十一标段：x\n二十标段：y\n九十九标段：z',
  '第十标段：x\n第3标段：y',
  '第第三标段：x\n第四标段：y',
  '3三个标段\n共 3三 个标段',
  '【1】设备\n【2】安装',
  '【1-1】设备\n【1-2】安装\n【2】其他',
  '【1】京建发〔2020〕号文\n【2】某号文件',
  '【1】2023 号\n【2】设备',
  '【0】x\n【00】y',
  '【1-0】x\n【2-0】y',
  '【1】x\r【2】y',
  '【1】x 【2】y',
  '前言【1】x\n【2】y',
  '【123456789012345678901234567890】x\n【2】y',
  '一标段 ：x\n二标段：y',
  '共计划分为 3 个 标段',
  '本项目共 2个 包，3 个分包',
  '设 2 个标的，分 4 个子项目',
  '第一标段;第二标段;',
  '标段一：A；标段二：B',
  '一标段：A 二标段：B 三标段：C 四标段：D 五标段：E 六标段：F 七标段：G 八标段：H 九标段：I 十标段：J 十一标段：K 十二标段：L',
  '【1】a\n【2】b\n【3】c\n【4】d\n【5】e\n【6】f\n【7】g\n【8】h\n【9】i\n【10】j\n【11】k\n【12】l',
];

describe('与桌面版 detectBidSections 相同', () => {
  it('典型写法与边界情况', () => {
    for (const text of CASES) expect(detectBidSections(text), JSON.stringify(text)).toEqual(desktop.detectBidSections(text));
  });

  it('随机拼接的片段（固定种子）', () => {
    const pieces = ['一', '二', '十', '壹', '3', '12', '0', ' ', '　', '\n', '\r', '个', '标段', '标包', '分包', '包', '标的', '子项目',
      '第', '：', ':', '；', ';', '、', ',', '【', '】', '-', '号', '文', '共', '分为', '本项目', '设', 'x'];
    let seed = 20261029;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 4000; round += 1) {
      const length = 1 + Math.floor(random() * 40);
      let text = '';
      for (let index = 0; index < length; index += 1) text += pieces[Math.floor(random() * pieces.length)];
      expect(detectBidSections(text), JSON.stringify(text)).toEqual(desktop.detectBidSections(text));
    }
  });
});

describe('按文件的摘要与合并', () => {
  it('各文件分别算摘要后合并，与对合并正文整体检测相同', () => {
    const groups = [
      ['一标段：A', '二标段：B'],
      ['【1-1】A', '【1-2】B'],
      ['【1】A', '说明'],
      ['【1】A', '【1】B'],
      ['本项目共 3 个包', '另有 2 个标段'],
      ['', '   '],
      [],
      ['普通正文', '没有标段'],
    ];
    for (const markdowns of groups) {
      const combined = combineBidSectionDetections(markdowns.map(summarizeBidSectionDetection));
      expect(combined, JSON.stringify(markdowns)).toEqual(desktop.detectBidSections(combineTenderMarkdown(markdowns)));
    }
  });

  it('集合最多保留上限个元素，判定不变；摘要经校验后原样读回，不合法时抛错', () => {
    const many = Array.from({ length: 30 }, (_, index) => `${index + 1}标段：x`).join('\n');
    const summary = summarizeBidSectionDetection(many);
    expect(summary.definitions).toHaveLength(BID_SECTION_DETECTION_SET_MAX);
    expect(parseBidSectionDetectionSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
    expect(combineBidSectionDetections([summary])).toEqual(desktop.detectBidSections(many));
    for (const bad of [
      null,
      [],
      { ...summary, version: 2 },
      { ...summary, extra: 1 },
      { ...summary, declaredAny: 1 },
      { ...summary, declaredAny: 100 },
      { ...summary, declaredSections: 2.5 },
      { ...summary, definitions: ['a', 'a'] },
      { ...summary, definitions: Array.from({ length: BID_SECTION_DETECTION_SET_MAX + 1 }, (_, index) => String(index)) },
      { ...summary, bracketGroups: [''] },
      { ...summary, bracketGroups: ['\u0000'] },
      { ...summary, bracketChildren: [1] },
      { ...summary, bracketChildren: ['x'.repeat(65)] },
    ]) {
      expect(() => parseBidSectionDetectionSummary(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });
});

describe('耗时与长度成正比（桌面版的平方级输入）', () => {
  const inputs: [string, string][] = [
    ['长数字串', '1'.repeat(400_000)],
    ['长中文数字串', '一'.repeat(400_000)],
    ['长空白后接数字', `${' '.repeat(400_000)}1`],
    ['数字后接长空白', `1${' '.repeat(400_000)}x`],
    ['长“第”串', '第'.repeat(400_000)],
    ['长单位串', '标段'.repeat(200_000)],
    ['一行中大量匹配', '一标段：'.repeat(100_000)],
    ['一行中大量合并提及候选', `${'1、'.repeat(200_000)}标段：`],
    ['大量行首【', '【1】\n'.repeat(100_000)],
    ['行首【后长数字', `【${'1'.repeat(400_000)}`],
  ];
  for (const [name, text] of inputs) {
    it(name, () => {
      const started = performance.now();
      summarizeBidSectionDetection(text);
      // 本地约几十毫秒；平方级的实现在这些输入上需要数分钟以上。
      expect(performance.now() - started).toBeLessThan(3_000);
    });
  }
});
