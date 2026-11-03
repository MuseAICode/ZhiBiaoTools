// 废标检查三类检查的流程与结果整理（src/rejectionCheck/checks.ts）。模型调用用桩，按步骤键返回预设的输出。
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/ai/providers.ts';
import type { JobChat } from '../../src/jobs/chat.ts';
import {
  normalizeLogicCheckFindings,
  normalizeRejectionCheckFindings,
  normalizeTypoCheckFindings,
  runLogicCheck,
  runRejectionItemCheck,
  runTypoCheck,
  usesSegmentedRejectionFlow,
} from '../../src/rejectionCheck/checks.ts';
import type { BidDocumentInput, RejectionInput } from '../../src/rejectionCheck/prompts.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const DOCS: BidDocumentInput[] = [
  { id: A, fileName: '投标文件A.docx', content: '# 商务部分\n请填写帐号信息。\n<td>表格</td>\n工期为 90 天。' },
  { id: B, fileName: '投标文件B.pdf', content: '# 技术部分\n工期为 120 天。' },
];

const INPUT: RejectionInput = { invalidBidAndRejectionItems: '- 投标函未盖章按无效投标处理', customCheckItems: '', bidDocuments: DOCS };

type Responder = (stepKey: string, messages: readonly ChatMessage[]) => unknown;

function fakeChat(responder: Responder): JobChat & { calls: { key: string; hash: string }[] } {
  const calls: { key: string; hash: string }[] = [];
  const record = (key: string, messages: readonly ChatMessage[]) => {
    calls.push({ key, hash: createHash('sha256').update(JSON.stringify(messages)).digest('hex') });
    return responder(key, messages);
  };
  return {
    calls,
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    async text(key, messages) {
      return String(record(key, messages));
    },
    async json(key, messages) {
      return record(key, messages);
    },
  };
}

describe('结果整理', () => {
  it('废标项：bidDocumentId 必须是输入中的投标文件，缺少证据或原因的丢弃，类型、等级按中文归一，没给 id 时按内容生成', () => {
    const findings = normalizeRejectionCheckFindings(
      {
        risks: [
          { bidDocumentId: A, type: '无效标', severity: '高', title: '投标函未盖章', bidEvidence: '第 3 页', riskReason: '按无效投标处理' },
          { bidDocumentId: 'bid-unknown', title: 'x', bidEvidence: 'y', riskReason: 'z' },
          { bidDocumentId: B, title: '缺少证据', riskReason: 'z' },
        ],
      },
      DOCS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ bidDocumentId: A, type: 'invalidBid', severity: 'high', summary: '投标函未盖章', requirement: '未明确引用具体检查依据，请人工复核。' });
    const again = normalizeRejectionCheckFindings({ risks: [{ bidDocumentId: A, type: '无效标', severity: '高', title: '投标函未盖章', bidEvidence: '第 3 页', riskReason: '按无效投标处理' }] }, DOCS);
    expect(again[0]!.id).toBe(findings[0]!.id);
    expect(findings[0]!.id).toMatch(/^rejection_finding_[0-9a-f]{12}$/);
    // 只有一份投标文件时缺省为它。
    expect(normalizeRejectionCheckFindings({ findings: [{ title: 't', bidEvidence: 'e', riskReason: 'r' }] }, [DOCS[0]!])[0]!.bidDocumentId).toBe(A);
  });

  it('错别字：必须能在原文中找到，摘录与位置由程序按原文生成，不从 HTML 标签中间截断；同一位置去重', () => {
    const findings = normalizeTypoCheckFindings(
      {
        findings: [
          { bidDocumentId: A, wrongText: '帐号', correctText: '账号', originalExcerpt: '模型编造的摘录' },
          { bidDocumentId: A, wrongText: '帐号', correctText: '账号' },
          { bidDocumentId: A, wrongText: '不存在', correctText: '存在' },
          { bidDocumentId: A, wrongText: '相同', correctText: '相同' },
          { bidDocumentId: A, wrongText: '表格', correctText: '表单' },
        ],
      },
      DOCS,
    );
    expect(findings.map(({ wrongText, originalExcerpt, locationHint, reason }) => ({ wrongText, originalExcerpt, locationHint, reason }))).toEqual([
      { wrongText: '帐号', originalExcerpt: '商务部分\n请填写帐号信息。\n<td>', locationHint: '原文第 2 行附近', reason: '疑似错别字，请结合原文复核。' },
      { wrongText: '表格', originalExcerpt: '信息。\n<td>表格</td>\n工期', locationHint: '原文第 3 行附近', reason: '疑似错别字，请结合原文复核。' },
    ]);
  });

  it('逻辑问题：缺少标题、原因或投标文件的丢弃，缺省的摘录、位置、建议与桌面版相同，同一问题去重', () => {
    const findings = normalizeLogicCheckFindings(
      { issues: [{ bidDocumentId: B, summary: '工期不一致', reason: '90 天与 120 天' }, { bidDocumentId: B, title: '工期不一致', fallacyReason: '90 天与 120 天' }, { title: '无文件', reason: 'r' }] },
      DOCS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      bidDocumentId: B,
      title: '工期不一致',
      originalText: '未提供明确原文摘录，请结合位置线索复核。',
      locationHint: '未明确具体位置，请结合原文摘录复核。',
      suggestion: '请结合投标文件上下文人工复核后修改。',
    });
  });
});

describe('一次检查', () => {
  it('废标项三轮：分析、检查、定稿，后两轮带上前一轮的输出', async () => {
    const chat = fakeChat((key) => {
      if (key === 'rejection:analysis') return '分析结论';
      if (key === 'rejection:inspection') return '初步风险';
      return { findings: [{ bidDocumentId: A, type: 'invalidBid', severity: 'high', title: '未盖章', bidEvidence: '投标函', riskReason: '无效' }] };
    });
    const progress: string[] = [];
    const findings = await runRejectionItemCheck({ chat }, INPUT, (message) => progress.push(message));
    expect(chat.calls.map((call) => call.key)).toEqual(['rejection:analysis', 'rejection:inspection', 'rejection:final']);
    expect(findings).toHaveLength(1);
    expect(progress).toEqual(['第一轮：正在分析检查范围。', '第二轮：正在逐项检查投标文件。', '第三轮：正在补充、去重并生成结果。']);
  });

  it('错别字、逻辑各一次调用', async () => {
    const chat = fakeChat((key) =>
      key === 'typo'
        ? { findings: [{ bidDocumentId: A, wrongText: '帐号', correctText: '账号' }] }
        : { findings: [{ bidDocumentId: B, title: '工期', fallacyReason: '前后不一致' }] },
    );
    expect(await runTypoCheck({ chat }, DOCS, () => {})).toHaveLength(1);
    expect(await runLogicCheck({ chat }, DOCS, () => {})).toHaveLength(1);
    expect(chat.calls.map((call) => call.key)).toEqual(['typo', 'logic']);
  });
});

describe('分段检查', () => {
  const split = { contextLengthLimit: 60 };
  const longDocs: BidDocumentInput[] = [
    { id: A, fileName: 'A', content: `${'商务响应内容。'.repeat(12)}\n请填写帐号信息。` },
    { id: B, fileName: 'B', content: '技术响应内容。'.repeat(12) },
  ];
  const longInput: RejectionInput = { ...INPUT, bidDocuments: longDocs };

  function rollingResponder(key: string): unknown {
    if (key === 'rejection:segment:1') {
      return {
        evidenceAdds: [{ name: '投标函', evidence: '目录中有投标函' }],
        pendingRiskAdds: [{ title: '未见授权书', requirement: '须提交授权书' }, { title: '未见报价表', requirement: '须提交报价表' }],
      };
    }
    if (key === 'rejection:segment:2') return { pendingRiskResolves: [{ id: 'risk_0002', reason: '后文有报价表' }], pendingRiskUpdates: [{ id: 'risk_0001', bidEvidence: '仍未见' }] };
    if (key.startsWith('rejection:segment:')) return { confirmedRiskAdds: [{ bidDocumentId: B, title: '工期超出', bidEvidence: '120 天', riskReason: '超出要求' }] };
    if (key.startsWith('rejection:final:')) return { findings: [{ bidDocumentId: A, title: '未见授权书', bidEvidence: '仍未见', riskReason: '可能无效' }] };
    if (key === 'rejection:merge') return { findings: [{ bidDocumentId: A, title: '未见授权书', bidEvidence: '仍未见', riskReason: '可能无效' }] };
    if (key.startsWith('typo:')) return { findings: [{ bidDocumentId: A, wrongText: '帐号', correctText: '账号' }] };
    if (key.startsWith('logic:segment:')) return { factAdds: [{ name: '工期', value: key }] };
    if (key.startsWith('logic:final:')) return { findings: [] };
    throw new Error(`unexpected ${key}`);
  }

  it('超过上下文长度时废标项按投标包滚动检查：累计状态的 id 按顺序编号，排除的风险不再进入定稿，最后全局合稿', async () => {
    expect(usesSegmentedRejectionFlow(longInput, split)).toBe(true);
    const chat = fakeChat(rollingResponder);
    const findings = await runRejectionItemCheck({ chat, split }, longInput, () => {});
    const keys = chat.calls.map((call) => call.key);
    const segments = keys.filter((key) => key.startsWith('rejection:segment:'));
    expect(segments.length).toBeGreaterThan(2);
    expect(keys.slice(segments.length)).toEqual(['rejection:final:1', 'rejection:merge']);
    expect(findings).toEqual([expect.objectContaining({ bidDocumentId: A, title: '未见授权书' })]);
  });

  it('错别字按文件分段，位置在各自的文件中校验；逻辑没有候选时不再定稿', async () => {
    const chat = fakeChat(rollingResponder);
    const typos = await runTypoCheck({ chat, split }, longDocs, () => {});
    expect(chat.calls.every((call) => /^typo:document:[12]:segment:\d+$/.test(call.key))).toBe(true);
    expect(typos).toHaveLength(1);
    expect(typos[0]!.locationHint).toBe('原文第 2 行附近');
    chat.calls.length = 0;
    expect(await runLogicCheck({ chat, split }, longDocs, () => {})).toEqual([]);
    expect(chat.calls.every((call) => call.key.startsWith('logic:segment:'))).toBe(true);
  });

  it('同一输入、同一模型输出时，每一步的请求内容完全相同（续跑时能按步骤取回已保存的结果，不重复扣费）', async () => {
    const first = fakeChat(rollingResponder);
    const second = fakeChat(rollingResponder);
    for (const chat of [first, second]) {
      await runRejectionItemCheck({ chat, split }, longInput, () => {});
      await runLogicCheck({ chat, split }, longDocs, () => {});
    }
    expect(second.calls).toEqual(first.calls);
    expect(new Set(first.calls.map((call) => call.key)).size).toBe(first.calls.length);
  });
});
