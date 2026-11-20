// Agent 任务用量统计的纯函数（src/agent/usageStats.ts，8.7f1）：分位数、建议上限、按任务类型汇总、JSON 形式。
import { describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS, type AgentTaskLimits } from '../../src/agent/budget.ts';
import { nearestRank, suggestLimits, summarizeAgentTaskUsage, unitsToYuan, usageSummaryToJson, type AgentTaskUsageSample } from '../../src/agent/usageStats.ts';

const range = (n: number) => Array.from({ length: n }, (_, index) => index + 1);

describe('nearestRank', () => {
  it('最近秩法：第 ⌈p·n⌉ 个', () => {
    expect(nearestRank(range(100), 0.95)).toBe(95);
    expect(nearestRank(range(20), 0.95)).toBe(19);
    expect(nearestRank(range(21), 0.95)).toBe(20);
    expect(nearestRank(range(10), 0.5)).toBe(5);
    expect(nearestRank([7], 0.95)).toBe(7);
    expect(nearestRank(range(10), 1)).toBe(10);
  });

  it('不依赖输入顺序，也不改动输入', () => {
    const values = [5n, 1n, 4n, 2n, 3n];
    expect(nearestRank(values, 0.5)).toBe(3n);
    expect(values).toEqual([5n, 1n, 4n, 2n, 3n]);
  });

  it('没有样本为 null，分位数越界报错', () => {
    expect(nearestRank([], 0.95)).toBeNull();
    expect(() => nearestRank([1], 0)).toThrow(RangeError);
    expect(() => nearestRank([1], 1.5)).toThrow(RangeError);
  });
});

describe('suggestLimits', () => {
  it('P95 的 2 倍：轮数向上取整，费用向上取整到 0.01 元', () => {
    expect(suggestLimits(37, 12_345n)).toEqual({ costLimit: 24_700n, turnLimit: 74 });
    expect(suggestLimits(50, 10_000n)).toEqual({ costLimit: 20_000n, turnLimit: 100 });
  });

  it('至少 1 轮、0.01 元（没有扣费的任务）', () => {
    expect(suggestLimits(0, 0n)).toEqual({ costLimit: 100n, turnLimit: 1 });
  });

  it('超出登记范围时不给建议', () => {
    expect(suggestLimits(600_000, 1n)).toBeNull();
  });
});

describe('summarizeAgentTaskUsage', () => {
  const types = new Map<string, AgentTaskLimits>([
    ['type-b', AGENT_TASK_LIMITS.outline],
    ['type-a', AGENT_TASK_LIMITS.templateExtraction],
  ]);
  const samples = (jobType: string, n: number, confirmedEvery = 0): AgentTaskUsageSample[] =>
    range(n).map((i) => ({ jobType, turnsUsed: i, billedAmount: BigInt(i * 1000), confirmations: confirmedEvery && i % confirmedEvery === 0 ? 1 : 0 }));

  it('按任务类型汇总，每个登记的类型都出现（按类型名排序），未登记的类型忽略', () => {
    const result = summarizeAgentTaskUsage(
      { samples: [...samples('type-b', 40, 10), ...samples('retired', 5)], censored: new Map([['type-b', 2]]), overrides: new Map([['type-b', { costLimit: 1n, turnLimit: 1 }]]) },
      types,
    );
    expect(result.map((summary) => summary.jobType)).toEqual(['type-a', 'type-b']);
    expect(result[0]).toEqual({
      jobType: 'type-a',
      samples: 0,
      confirmed: 0,
      censored: 0,
      turns: null,
      cost: null,
      defaults: AGENT_TASK_LIMITS.templateExtraction,
      override: null,
      suggested: null,
    });
    expect(result[1]).toEqual({
      jobType: 'type-b',
      samples: 40,
      confirmed: 4,
      censored: 2,
      turns: { p50: 20, p95: 38, max: 40 },
      cost: { p50: 20_000n, p95: 38_000n, max: 40_000n },
      defaults: AGENT_TASK_LIMITS.outline,
      override: { costLimit: 1n, turnLimit: 1 },
      suggested: { costLimit: 76_000n, turnLimit: 76 },
    });
  });

  it('样本少于 minSamples 时给出分布但不给建议', () => {
    const input = { samples: samples('type-a', 19), censored: new Map(), overrides: new Map() };
    const [few] = summarizeAgentTaskUsage(input, types);
    expect(few!.turns).toEqual({ p50: 10, p95: 19, max: 19 });
    expect(few!.suggested).toBeNull();
    const [enough] = summarizeAgentTaskUsage(input, types, { minSamples: 19 });
    expect(enough!.suggested).toEqual({ costLimit: 38_000n, turnLimit: 38 });
    expect(() => summarizeAgentTaskUsage(input, types, { minSamples: 0 })).toThrow(RangeError);
  });

  it('JSON 形式把费用换算为元的字符串', () => {
    const [, summary] = summarizeAgentTaskUsage({ samples: samples('type-b', 20), censored: new Map(), overrides: new Map() }, types);
    const json = usageSummaryToJson(summary!);
    expect(JSON.parse(JSON.stringify(json))).toEqual({
      jobType: 'type-b',
      samples: 20,
      confirmed: 0,
      censored: 0,
      turns: { p50: 10, p95: 19, max: 20 },
      costYuan: { p50: '1.0000', p95: '1.9000', max: '2.0000' },
      defaults: { costYuan: '5.0000', turnLimit: 500 },
      override: null,
      suggested: { costYuan: '3.8000', turnLimit: 38 },
    });
  });
});

describe('unitsToYuan', () => {
  it('4 位小数', () => {
    expect(unitsToYuan(0n)).toBe('0.0000');
    expect(unitsToYuan(12_345n)).toBe('1.2345');
    expect(unitsToYuan(50_000n)).toBe('5.0000');
    expect(unitsToYuan(-1n)).toBe('-0.0001');
  });
});
