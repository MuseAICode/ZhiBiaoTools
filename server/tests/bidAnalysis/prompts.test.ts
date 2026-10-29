// 招标解析的提示词与调用流程（src/bidAnalysis/prompts.ts）：加载桌面版 bidAnalysisTask.cjs、bidSectionContext.cjs，用同一输入
// 对照完整的请求序列（消息逐字相同），覆盖 18 个解析项、单段与分段合并、整项无结果时重跑、带投标范围提示。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/ai/providers.ts';
import { splitTextByContextLimit } from '../../src/ai/textSplit.ts';
import { extractInvalidBidAndRejectionItems } from '../../src/bidAnalysis/discardedBids.ts';
import { buildBidSectionContextHint, buildTaskPrompt, buildTenderContextMessages, runBidAnalysisPrompt } from '../../src/bidAnalysis/prompts.ts';
import type { TechnicalPlanBidItemId } from '../../src/db/schema.ts';
import type { JobChat } from '../../src/jobs/chat.ts';
import { BID_ANALYSIS_TASKS } from '../../src/technicalPlan/tender.ts';

const require = createRequire(import.meta.url);

interface DesktopTask {
  id: string;
  output: string;
  prompt(): string;
}

const desktop = require('../../../client/electron/services/bidAnalysisTask.cjs') as {
  getBidAnalysisTasks(mode: string): DesktopTask[];
  buildTenderContextMessages(fileContent: string, sectionHint: string): ChatMessage[];
  runBidAnalysisPromptTask(options: {
    aiService: { chat(request: { messages: ChatMessage[] }): Promise<string> };
    fileContent: string;
    fileSegments: string[];
    task: DesktopTask;
    sectionHint: string;
  }): Promise<string>;
};
const desktopHint = require('../../../client/electron/utils/bidSectionContext.cjs') as {
  buildBidSectionContextHint(section: unknown, options?: { hasSelectedSection?: boolean }): string;
};

type Respond = (messages: readonly ChatMessage[], call: number) => string;

/** 桌面版的请求序列。 */
async function desktopRequests(id: string, fileContent: string, segments: string[], sectionHint: string, respond: Respond) {
  const task = desktop.getBidAnalysisTasks('full').find((candidate) => candidate.id === id)!;
  const requests: ChatMessage[][] = [];
  const result = await desktop.runBidAnalysisPromptTask({
    aiService: {
      async chat(request) {
        requests.push(request.messages);
        return respond(request.messages, requests.length);
      },
    },
    fileContent,
    fileSegments: segments,
    task,
    sectionHint,
  });
  return { result, requests };
}

/** 服务端的请求序列与步骤键。 */
async function serverRequests(id: TechnicalPlanBidItemId, segments: string[], sectionHint: string, respond: Respond) {
  const requests: ChatMessage[][] = [];
  const keys: string[] = [];
  const chat: JobChat = {
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    async text(stepKey, messages) {
      keys.push(stepKey);
      requests.push([...messages]);
      return respond(messages, requests.length);
    },
    async json() {
      throw new Error('unexpected json request');
    },
  };
  const result = await runBidAnalysisPrompt(chat, { id, segments, sectionHint, keyPrefix: `item:${id}` });
  return { result, requests, keys };
}

const TENDER = ['# 第一章 招标公告', '项目名称：某平台建设', '', '# 第二章 评标办法', '技术方案 30 分。', '', '# 第三章 合同', '质保期两年。'].join('\n');
const HINT = desktopHint.buildBidSectionContextHint({ title: '一标段', headLine: '一标段：平台', description: '平台建设', evidence: ['一标段：平台'] }, { hasSelectedSection: true });

describe('与桌面版的请求序列相同', () => {
  it('18 个解析项的任务提示词与公共前缀', () => {
    for (const task of BID_ANALYSIS_TASKS) {
      const desktopTask = desktop.getBidAnalysisTasks('full').find((candidate) => candidate.id === task.id)!;
      const expected = desktop.buildTenderContextMessages(TENDER, HINT);
      expect(buildTenderContextMessages(TENDER, HINT)).toEqual(expected);
      expect(buildTaskPrompt(task.id).startsWith(desktopTask.prompt())).toBe(true);
    }
  });

  it('每个解析项：单段、分段合并、带与不带投标范围提示', async () => {
    const segments = splitTextByContextLimit(TENDER, { contextLengthLimit: 40 });
    expect(segments.length).toBeGreaterThan(1);
    for (const task of BID_ANALYSIS_TASKS) {
      for (const [parts, hint] of [
        [[TENDER], ''],
        [[TENDER], HINT],
        [segments, ''],
        [segments, HINT],
      ] as const) {
        const respond: Respond = (_messages, call) => `结果 ${call}`;
        const expected = await desktopRequests(task.id, TENDER, [...parts], hint, respond);
        const actual = await serverRequests(task.id, [...parts], hint, respond);
        expect(actual.requests, task.id).toEqual(expected.requests);
        expect(actual.result).toBe(expected.result);
        expect(actual.keys).toEqual(
          parts.length === 1 ? [`item:${task.id}`] : [...parts.map((_, index) => `item:${task.id}:segment:${index + 1}`), `item:${task.id}:merge`],
        );
      }
    }
  });

  it('Markdown 解析项只返回“未提取到”时完整重跑一次（步骤键加 :try-2），JSON 解析项不重跑', async () => {
    const missingOnce: Respond = (_messages, call) => (call === 1 ? '未提取到' : '项目概述内容');
    const expected = await desktopRequests('projectOverview', TENDER, [TENDER], '', missingOnce);
    const actual = await serverRequests('projectOverview', [TENDER], '', missingOnce);
    expect(actual.requests).toEqual(expected.requests);
    expect(actual.keys).toEqual(['item:projectOverview', 'item:projectOverview:try-2']);
    expect(actual.result).toBe('项目概述内容');

    const alwaysMissing: Respond = () => '未提取到';
    const json = await serverRequests('projectInfo', [TENDER], '', alwaysMissing);
    expect(json.keys).toEqual(['item:projectInfo']);
    expect((await desktopRequests('projectInfo', TENDER, [TENDER], '', alwaysMissing)).requests).toEqual(json.requests);
  });

  it('无效与废标项（废标检查）沿用原来的步骤键与请求', async () => {
    const keys: string[] = [];
    const requests: ChatMessage[][] = [];
    const chat: JobChat = {
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      async text(stepKey, messages) {
        keys.push(stepKey);
        requests.push([...messages]);
        return '无效投标';
      },
      async json() {
        throw new Error('unexpected json request');
      },
    };
    await extractInvalidBidAndRejectionItems(chat, TENDER, { contextLengthLimit: 40 });
    const segments = splitTextByContextLimit(TENDER, { contextLengthLimit: 40 });
    expect(keys).toEqual([...segments.map((_, index) => `extraction:segment:${index + 1}`), 'extraction:merge']);
    expect(requests).toEqual((await desktopRequests('discardedBids', TENDER, segments, '', () => '无效投标')).requests);
  });
});

describe('投标范围提示', () => {
  it('与桌面版 buildBidSectionContextHint 相同', () => {
    const cases: [unknown, { hasSelectedSection?: boolean }][] = [
      [null, {}],
      [null, { hasSelectedSection: true }],
      [{}, { hasSelectedSection: true }],
      [{ title: '  一 标段 ' }, {}],
      [{ title: '一标段', headLine: '一标段：\n平台', description: ' 描述 ', evidence: ['a', ' ', 'b\tc', 'd', 'e', 'f', 'g', 'h'] }, { hasSelectedSection: true }],
      [{ evidence: 'not-array', description: '只有描述' }, {}],
    ];
    for (const [section, options] of cases) {
      expect(buildBidSectionContextHint(section as never, options)).toBe(desktopHint.buildBidSectionContextHint(section, options));
    }
  });
});
