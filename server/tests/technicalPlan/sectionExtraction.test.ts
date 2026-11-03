// 多标段识别（src/technicalPlan/sectionExtraction.ts）与带行号的视图（lineView.ts）：加载桌面版 markdownLineView.cjs、
// bidSectionExtractionTask.cjs，用同一输入对照行号视图、请求序列与识别结果；超长行中大量“![”的输入耗时与长度成正比。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/ai/providers.ts';
import type { JobChat } from '../../src/jobs/chat.ts';
import { numberMarkdownLines } from '../../src/technicalPlan/lineView.ts';
import { extractBidSections, normalizeSectionsResponse, SectionExtractionError } from '../../src/technicalPlan/sectionExtraction.ts';

const require = createRequire(import.meta.url);
const desktopLines = require('../../../client/electron/utils/markdownLineView.cjs') as {
  numberMarkdownLines(markdown: string, options?: { maxLineChars?: number }): string;
};
const desktopTask = require('../../../client/electron/services/bidSectionExtractionTask.cjs') as {
  runBidSectionExtractionTask(options: Record<string, unknown>): Promise<void>;
};

describe('带行号的视图', () => {
  it('与桌面版 numberMarkdownLines 相同：普通行、CRLF、超长行按表格 / HTML / 句读切分、不切开图片与标签、代理对', async () => {
    const longTable = `| ${'单元格内容，'.repeat(300)} | ${'另一列'.repeat(200)} |`;
    const longHtml = `<table><tr>${'<td class="a > b">数值</td>'.repeat(200)}</tr></table>`;
    const longImages = `${'说明文字 ![图 (1)](/api/artifacts/x/content "标题 (a)") '.repeat(80)}结尾`;
    const nested = `${'![a[b]c](x(y)z) \\![不是图片](x) '.repeat(150)}`;
    const reference = `${'![引用][ref] '.repeat(400)}`;
    const emoji = `${'😀'.repeat(2500)}`;
    const comment = `${'<!-- 注释 -->文字'.repeat(400)}`;
    const unclosed = `${'![未闭合('.repeat(600)}`;
    const quotes = `${'![x](a "b) c" \'d\') '.repeat(300)}`;
    const inputs = [
      '',
      '单行',
      '第一行\r\n第二行\r第三行\n',
      longTable,
      longHtml,
      longImages,
      nested,
      reference,
      emoji,
      comment,
      unclosed,
      quotes,
      [longTable, '', longHtml, longImages].join('\n'),
    ];
    for (const input of inputs) {
      expect(await numberMarkdownLines(input), input.slice(0, 40)).toBe(desktopLines.numberMarkdownLines(input));
      expect(await numberMarkdownLines(input, { maxLineChars: 97 })).toBe(desktopLines.numberMarkdownLines(input, { maxLineChars: 97 }));
    }
  });

  it('一行中大量未闭合的“![…](”：耗时与长度成正比，字符不丢、顺序不变', async () => {
    const line = '![a]('.repeat(200_000);
    const started = performance.now();
    const numbered = await numberMarkdownLines(line);
    expect(performance.now() - started).toBeLessThan(5_000);
    const restored = numbered
      .split('\n')
      .map((part) => part.replace(/^L000001\[\d+\/\d+\] \| /, ''))
      .join('');
    expect(restored).toBe(line);
  });
});

interface Captured {
  messages: ChatMessage[];
}

/** 桌面版的请求序列与写入的结果。 */
async function desktopRun(markdown: string, contextLengthLimit: number, respond: (messages: ChatMessage[], call: number) => unknown) {
  const requests: Captured[] = [];
  let final: Record<string, unknown> | undefined;
  await desktopTask.runBidSectionExtractionTask({
    aiService: {
      getConfig: () => ({ context_length_limit: contextLengthLimit }),
      async collectJsonResponse(request: Captured) {
        requests.push({ messages: request.messages });
        return respond(request.messages, requests.length);
      },
    },
    workspaceStore: { readOriginalTenderMarkdown: () => markdown, prepareBidSectionExtraction() {} },
    updateTask() {},
    checkpointTask(_task: unknown, partial: Record<string, unknown>) {
      final = partial;
    },
  });
  return { requests, final: final! };
}

async function serverRun(markdown: string, contextLengthLimit: number, respond: (messages: ChatMessage[], call: number) => unknown) {
  const requests: Captured[] = [];
  const keys: string[] = [];
  const chat: JobChat = {
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    async text() {
      throw new Error('unexpected text request');
    },
    async json(stepKey, messages) {
      keys.push(stepKey);
      requests.push({ messages: [...messages] });
      return respond([...messages], requests.length);
    },
  };
  try {
    return { requests, keys, sections: await extractBidSections(chat, markdown, { contextLengthLimit }, () => {}), error: null };
  } catch (error) {
    return { requests, keys, sections: null, error };
  }
}

const TENDER = [
  '# 招标公告',
  '本项目分为两个标段。',
  '一标段：设备采购及安装',
  '设备清单如下。',
  '二标段：软件开发',
  '软件需求如下。',
  '# 通用条款',
  '投标人须知。',
].join('\n');

const candidate = (title: string, startLine: number, endLine: number, extra: Record<string, unknown> = {}) => ({
  title,
  includeRanges: [{ startLine, endLine, reason: `${title}范围` }],
  evidence: [title],
  ...extra,
});

describe('多标段识别', () => {
  it('一段：请求与结果与桌面版相同；同名标段合并、越界范围去掉、重新编号', async () => {
    const respond = () => ({
      sections: [
        candidate('二标段', 5, 6, { unit: '标段', index: 2 }),
        candidate('第一标段', 3, 4, { index: 1, headLine: '一标段：设备采购及安装' }),
        candidate('一标段', 3, 3, { description: '设备' }),
        candidate('越界', 9, 12),
        { title: '', includeRanges: [{ startLine: 1, endLine: 1 }] },
      ],
    });
    const expected = await desktopRun(TENDER, 400_000, respond);
    const actual = await serverRun(TENDER, 400_000, respond);
    expect(actual.error).toBeNull();
    expect(actual.keys).toEqual(['segment:1']);
    expect(actual.requests).toEqual(expected.requests);
    expect(actual.sections).toEqual(expected.final.bidSections);
    expect(actual.sections!.map((section) => [section.id, section.title])).toEqual([
      ['section-1', '第一标段'],
      ['section-2', '二标段'],
    ]);
  });

  it('多段：逐段请求后合并，请求与结果与桌面版相同', async () => {
    const respond = (messages: ChatMessage[]) =>
      messages[1]!.content.includes('各分段识别出的标段候选')
        ? { sections: [candidate('一标段', 3, 4), candidate('二标段', 5, 6)] }
        : { sections: [candidate('一标段', 3, 4)] };
    const expected = await desktopRun(TENDER, 120, respond);
    const actual = await serverRun(TENDER, 120, respond);
    expect(actual.keys.length).toBeGreaterThan(2);
    expect(actual.keys.at(-1)).toBe('merge');
    expect(actual.requests).toEqual(expected.requests);
    expect(actual.sections).toEqual(expected.final.bidSections);
  });

  it('少于两个有效标段时失败（文案与桌面版相同）', async () => {
    const respond = () => ({ sections: [candidate('一标段', 3, 4), candidate('无范围', 0, 0)] });
    const expected = await desktopRun(TENDER, 400_000, respond);
    const actual = await serverRun(TENDER, 400_000, respond);
    expect(expected.final).toMatchObject({ bidSectionExtractionStatus: 'error', bidSectionExtractionError: '未识别到至少两个有效标段' });
    expect(actual.error).toBeInstanceOf(SectionExtractionError);
    expect((actual.error as Error).message).toBe('未识别到至少两个有效标段');
  });

  it('不合规的模型输出按不可信数据整理', () => {
    for (const value of [null, 'x', [], { sections: 'x' }, { sections: [null, 1, 'x', { title: 1 }] }]) {
      expect(normalizeSectionsResponse(value, 10)).toEqual({ sections: [] });
    }
    expect(
      normalizeSectionsResponse({ sections: [{ title: '一标段', include_ranges: [{ start_line: '2', end_line: 3.7 }, { startLine: 5, endLine: 4 }, { startLine: 1, endLine: 11 }] }] }, 10),
    ).toEqual({ sections: [{ id: 'section-1', index: 1, unit: '标段', title: '一标段', headLine: '', description: '', includeRanges: [{ startLine: 2, endLine: 3, reason: undefined }], evidence: [] }] });
  });
});
