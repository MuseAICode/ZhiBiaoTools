// 技术方案的招标解析项与多标段：任务列表与桌面版 bidAnalysisTask.cjs 一致，解析配置、标段整理、投标范围裁剪和招标正文
// 合并的规则与桌面版 technicalPlanStore.cjs 相同。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  BID_ANALYSIS_TASKS,
  BID_SECTION_RANGES_MAX,
  BID_SECTIONS_MAX,
  bidAnalysisProgress,
  BidSectionError,
  buildSelectedSectionMarkdown,
  combineTenderMarkdown,
  normalizeBidAnalysisConfig,
  normalizeBidSections,
} from '../../src/technicalPlan/tender.ts';

const require = createRequire(import.meta.url);

const REQUIRED = ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements', 'responseFileRequirements'];
const ALL = BID_ANALYSIS_TASKS.map((task) => task.id);

describe('招标解析项', () => {
  it('与桌面版 bidAnalysisTask.cjs 的任务列表相同（id、名称、是否必选、顺序）', () => {
    const { getBidAnalysisTasks } = require('../../../client/electron/services/bidAnalysisTask.cjs') as {
      getBidAnalysisTasks(mode: string): Array<{ id: string; label: string; required: boolean }>;
    };
    expect(BID_ANALYSIS_TASKS).toEqual(getBidAnalysisTasks('full').map(({ id, label, required }) => ({ id, label, required })));
    expect(BID_ANALYSIS_TASKS.filter((task) => task.required).map((task) => task.id)).toEqual(getBidAnalysisTasks('key').map((task) => task.id));
  });

  it('解析配置：必选项总是选中，选了可选项为 custom，选全为 full，未知 id 忽略，按任务列表排序', () => {
    expect(normalizeBidAnalysisConfig('key', [])).toEqual({ mode: 'key', selectedTaskIds: REQUIRED });
    expect(normalizeBidAnalysisConfig('custom', [])).toEqual({ mode: 'custom', selectedTaskIds: REQUIRED });
    expect(normalizeBidAnalysisConfig('key', ['terminationCondition', 'agentInfo', 'unknown', ' '])).toEqual({
      mode: 'custom',
      selectedTaskIds: [...REQUIRED, 'agentInfo', 'terminationCondition'],
    });
    expect(normalizeBidAnalysisConfig('full', [])).toEqual({ mode: 'full', selectedTaskIds: ALL });
    expect(normalizeBidAnalysisConfig('key', ALL)).toEqual({ mode: 'full', selectedTaskIds: ALL });
    expect(normalizeBidAnalysisConfig(undefined, 'x')).toEqual({ mode: 'key', selectedTaskIds: REQUIRED });
  });

  it('进度：选中项中已成功或失败的比例', () => {
    expect(bidAnalysisProgress([], new Map())).toBe(0);
    expect(bidAnalysisProgress(['a', 'b', 'c'], new Map([['a', 'success'], ['b', 'error'], ['c', 'running'], ['d', 'success']]))).toBe(67);
  });
});

describe('多标段', () => {
  it('整理标段：补默认 id / 序号 / 单位，兼容 snake_case，去掉没有标题的标段和不合法的范围', () => {
    expect(
      normalizeBidSections([
        { title: ' 一标段 ', head_line: '第一标段', include_ranges: [{ start_line: 1, end_line: 3, reason: '正文' }, { startLine: 5, endLine: 4 }, { startLine: 'x' }] },
        { id: 'b', index: 'abc', unit: ' ', title: '二标段', evidence: [' 依据 ', '', null], includeRanges: [{ startLine: 0, endLine: 0 }] },
        { id: 'c', title: '' },
        null,
      ]),
    ).toEqual([
      { id: 'section-1', index: 1, unit: '标段', title: '一标段', headLine: '第一标段', description: '', includeRanges: [{ startLine: 1, endLine: 3, reason: '正文' }], evidence: [] },
      // 起止为 0 时与桌面版相同按 1 处理。
      { id: 'b', index: 2, unit: '标段', title: '二标段', headLine: '', description: '', includeRanges: [{ startLine: 1, endLine: 1 }], evidence: ['依据'] },
    ]);
    expect(normalizeBidSections('x')).toEqual([]);
  });

  it('整理标段：超过数量上限的标段和范围截掉，超长文本截短，去掉 \\u0000', () => {
    const many = Array.from({ length: BID_SECTIONS_MAX + 5 }, (_, index) => ({ title: `标段${index}` }));
    expect(normalizeBidSections(many)).toHaveLength(BID_SECTIONS_MAX);
    const ranges = Array.from({ length: BID_SECTION_RANGES_MAX + 1 }, () => ({ startLine: 1, endLine: 2 }));
    const [section] = normalizeBidSections([{ title: `长${'题'.repeat(3000)}\u0000`, includeRanges: ranges }]);
    expect(section!.includeRanges).toHaveLength(BID_SECTION_RANGES_MAX);
    expect([...section!.title]).toHaveLength(2000);
    expect(section!.title).not.toContain('\u0000');
  });

  const SECTIONS = normalizeBidSections([
    { id: 's1', title: '一标段', includeRanges: [{ startLine: 2, endLine: 3 }] },
    { id: 's2', title: '二标段', includeRanges: [{ startLine: 4, endLine: 5 }, { startLine: 3, endLine: 3 }] },
    { id: 's3', title: '三标段', includeRanges: [] },
  ]);
  const MARKDOWN = '公共\r\n一甲\n共用\n二甲\n二乙\n结尾';

  it('投标范围：去掉只属于其他标段的行，保留公共行和与所选标段重叠的行', () => {
    expect(buildSelectedSectionMarkdown(MARKDOWN, SECTIONS, 's1')).toBe('公共\n一甲\n共用\n结尾');
    expect(buildSelectedSectionMarkdown(MARKDOWN, SECTIONS, 's2')).toBe('公共\n共用\n二甲\n二乙\n结尾');
  });

  it('投标范围：范围超出总行数时截到末行；标段不存在、没有有效范围或结果为空时报错（消息与桌面版相同）', () => {
    const wide = normalizeBidSections([
      { id: 'a', title: 'A', includeRanges: [{ startLine: 1, endLine: 1 }] },
      { id: 'b', title: 'B', includeRanges: [{ startLine: 1, endLine: 1_000_000_000 }] },
    ]);
    expect(buildSelectedSectionMarkdown('一\n二\n三', wide, 'a')).toBe('一');
    expect(() => buildSelectedSectionMarkdown(MARKDOWN, SECTIONS, 'missing')).toThrow(new BidSectionError('未找到选择的投标范围'));
    expect(() => buildSelectedSectionMarkdown(MARKDOWN, SECTIONS, 's3')).toThrow('当前标段缺少有效范围，请重新识别');
    const blank = normalizeBidSections([
      { id: 'a', title: 'A', includeRanges: [{ startLine: 2, endLine: 2 }] },
      { id: 'b', title: 'B', includeRanges: [{ startLine: 1, endLine: 1 }] },
    ]);
    expect(() => buildSelectedSectionMarkdown('正文\n  ', blank, 'a')).toThrow('生成投标范围工作副本失败，请重新提取标段');
  });

  it('合并招标正文：各份去掉首尾空白，跳过空的，以空行连接', () => {
    expect(combineTenderMarkdown(['  # 甲\n', '', '\n# 乙  '])).toBe('# 甲\n\n# 乙');
    expect(combineTenderMarkdown([])).toBe('');
  });
});
