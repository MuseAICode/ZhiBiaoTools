// Agent 结果的提交策略与修复提示词（src/agent/submission.ts，路线图第 8 步 8.6d1）：与桌面版 piSubmissionPolicy.cjs 逐次对照，
// 另检查报告形状与执行重试的提示词。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MAX_EXECUTION_RETRIES,
  AGENT_SUBMISSION_MAX_ISSUES,
  assertAgentSubmissionReport,
  buildAgentExecutionRetryPrompt,
  buildAgentSubmissionRepairPrompt,
  createAgentSubmissionPolicy,
  restoredFilesNotice,
  type AgentSubmissionReport,
} from '../../src/agent/submission.ts';

const require = createRequire(import.meta.url);
const desktop = require('../../../client/electron/services/pi/piSubmissionPolicy.cjs') as {
  createSubmissionPolicy(): { attempts: number; inspect(report: AgentSubmissionReport): any };
  buildSubmissionRepairPrompt(report: AgentSubmissionReport, decision: any, businessPrompt?: string): string;
};

const blocking = (message: string) => ({ severity: 'blocking' as const, message });
const quality = (message: string) => ({ severity: 'quality' as const, message });

// 每个序列是一个阶段中依次提交的校验报告。
const SEQUENCES: ReadonlyArray<readonly AgentSubmissionReport[]> = [
  [{ value: 1, issues: [] }],
  [{ value: null, issues: [blocking('a')] }, { value: 2, issues: [] }],
  [{ value: null, issues: [blocking('a')] }, { value: null, issues: [blocking('a')] }, { value: null, issues: [blocking('a')] }, { value: null, issues: [blocking('a')] }],
  [{ value: null, issues: [blocking('a')] }, { value: null, issues: [blocking('a')] }, { value: null, issues: [blocking('a')] }, { value: 3, issues: [] }],
  [{ value: null, issues: [quality('q')], progress: 10 }, { value: null, issues: [quality('q')], progress: 10 }, { value: null, issues: [quality('q')], progress: 10 }],
  [{ value: null, issues: [quality('q')], progress: 10 }, { value: null, issues: [quality('q')], progress: 5 }, { value: null, issues: [quality('q')], progress: 1 }, { value: 4, issues: [] }],
  [{ value: null, issues: [blocking('a'), blocking('b')] }, { value: null, issues: [blocking('a')] }, { value: null, issues: [blocking('a')] }, { value: null, issues: [quality('q')] }],
  [{ value: null, issues: [blocking('a')], minimumGoal: '最低目标' }, { value: null, issues: [blocking('a')] }, { value: null, issues: [blocking('a'), quality('q')] }, { value: null, issues: [quality('q')] }],
];

describe('提交策略', () => {
  it.each(SEQUENCES.map((sequence, index) => [index, sequence] as const))('与桌面版相同的决策与修复提示词（序列 %i）', (_index, sequence) => {
    const ours = createAgentSubmissionPolicy();
    const theirs = desktop.createSubmissionPolicy();
    for (const report of sequence) {
      const decision = ours.inspect(report);
      const expected = theirs.inspect(report);
      expect(decision).toEqual(expected);
      expect(ours.attempts).toBe(theirs.attempts);
      if (decision.action === 'repair') {
        expect(buildAgentSubmissionRepairPrompt(report, decision, '业务提示')).toBe(desktop.buildSubmissionRepairPrompt(report, expected, '业务提示'));
        expect(buildAgentSubmissionRepairPrompt(report, decision)).toBe(desktop.buildSubmissionRepairPrompt(report, expected));
      }
      if (decision.action !== 'repair') break;
    }
  });

  it('最低目标修复只列阻塞问题，并写明最低完成目标', () => {
    const report: AgentSubmissionReport = { value: null, issues: [blocking('结构错误'), quality('字数不足')], minimumGoal: '能被后续流程读取' };
    const prompt = buildAgentSubmissionRepairPrompt(report, { action: 'repair', mode: 'minimum', attempt: 3 });
    expect(prompt).toContain('1. 结构错误');
    expect(prompt).not.toContain('字数不足');
    expect(prompt).toContain('最低完成目标：能被后续流程读取');
    expect(prompt).toContain('这是本阶段第 3 次提交修复。');
  });

  it.each([
    ['不是对象', null],
    ['没有问题清单', { value: null }],
    ['问题过多', { value: null, issues: Array.from({ length: AGENT_SUBMISSION_MAX_ISSUES + 1 }, () => blocking('x')) }],
    ['严重程度不对', { value: null, issues: [{ severity: 'fatal', message: 'x' }] }],
    ['说明为空', { value: null, issues: [blocking('  ')] }],
    ['说明过长', { value: null, issues: [blocking('x'.repeat(2_001))] }],
    ['剩余量为负', { value: null, issues: [], progress: -1 }],
    ['剩余量不是数', { value: null, issues: [], progress: Number.NaN }],
    ['最低目标不是字符串', { value: null, issues: [], minimumGoal: 1 }],
  ])('报告不合法时抛 TypeError：%s', (_name, report) => {
    expect(() => assertAgentSubmissionReport(report)).toThrow(TypeError);
    expect(() => createAgentSubmissionPolicy().inspect(report as AgentSubmissionReport)).toThrow(TypeError);
  });
});

describe('其他提示词', () => {
  it('还原了受保护文件时的说明；没有时为空', () => {
    expect(restoredFilesNotice(['输入/a.md', '输入/b.md'])).toBe('程序已还原被改动的文件：输入/a.md、输入/b.md。这些文件由程序维护，不要修改。');
    expect(restoredFilesNotice([])).toBe('');
  });

  it('执行重试的提示词与桌面版的默认说明相同（原因为固定文字）', () => {
    expect(AGENT_MAX_EXECUTION_RETRIES).toBe(3);
    expect(buildAgentExecutionRetryPrompt('模型调用失败', '结果/目录.json', 1, 2)).toBe(
      '上一轮执行失败：模型调用失败\n\n本次结果文件：结果/目录.json。在当前会话和工作区中，根据上述错误修复该文件。继续遵守当前阶段的可修改范围、工具权限及完成条件；已有文件优先局部修正，不因重试扩大修改范围或重新执行已完成阶段。\n这是第 1/2 次自动修复机会。',
    );
  });
});
