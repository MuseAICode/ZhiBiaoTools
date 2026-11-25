// 正文小节的写作请求与输出检查（路线图第 8 步 8.10c2a，src/technicalPlan/contentSectionWriting.ts、readableWords.ts）与桌面版的对照：
// - 字数统计与 wordCount.cjs / contentGenerationWordTools.cjs 的 countHtmlWords、源码提取与 aiSourceExtraction.cjs、输出边界与
//   contentGenerationAgent.cjs 的 checkSectionHtml、任务文件的读取与 contentGenerationTaskFiles.cjs 的 readTaskFile 逐个输入相同；
// - 写作请求：把服务端生成的材料（buildContentWritingFiles，8.10c1 已与桌面版逐个文件核对）放进临时工作区，执行桌面版的
//   generate-sections 工具（模型换成记录请求的替身），预热请求与每节请求的消息、非目标 / 重复小节的说明、已生成小节的跳过都须相同。
// 桌面版加载方式与 contentWriting.test.ts 相同（ajv 换成 server/ 的同一版本，cheerio 等前端依赖换成桩：HTML 结构检查的对照见
// htmlStructure.test.ts）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/ai/gateway.ts';
import { collectAiLeaves, type StoredContentPlan } from '../../src/technicalPlan/contentPlanning.ts';
import {
  checkSectionHtml,
  compactResults,
  CONTENT_SECTION_TRUNCATED_MESSAGE,
  CONTENT_SECTIONS_TASK_FILE,
  ContentSectionOutputError,
  ContentSectionTaskError,
  contentSectionMessages,
  contentSectionSharedInput,
  contentSectionSuccess,
  contentSectionWritingMaterials,
  contentSectionWritingSystem,
  extractAiSource,
  finishSectionHtml,
  planContentSectionBatch,
  readContentSectionsTask,
  sharedPrefixMessages,
  type ContentSectionJob,
} from '../../src/technicalPlan/contentSectionWriting.ts';
import { buildContentWritingFiles, contentSectionFile, type ContentWritingFilesInput } from '../../src/technicalPlan/contentWriting.ts';
import { HtmlStructureError } from '../../src/technicalPlan/htmlStructure.ts';
import type { TechnicalPlanOutlineItem } from '../../src/technicalPlan/outline.ts';
import { countHtmlWords, countReadableWords } from '../../src/technicalPlan/readableWords.ts';

const require = createRequire(import.meta.url);
const STUBBED = new Set(['cheerio', 'docx', 'electron', 'image-size', 'mime-types']);
const stub: unknown = new Proxy(function stubbed() {}, {
  get: (_target, key) => (key === Symbol.toPrimitive ? () => '' : stub),
  apply: () => stub,
  construct: () => stub as object,
});
function loadDesktop(path: string): any {
  const Module = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = Module._load;
  const ajv = require('ajv') as unknown;
  Module._load = function load(request: string, parent: unknown, isMain: boolean) {
    if (request === 'ajv') return ajv;
    if (STUBBED.has(request)) return stub;
    return original.call(this, request, parent, isMain);
  };
  try {
    return require(path);
  } finally {
    Module._load = original;
  }
}

const DESKTOP = '../../../client/electron/';
const desktopWords = loadDesktop(`${DESKTOP}utils/wordCount.cjs`) as { countReadableWords(content: unknown): number };
const desktopWordTools = loadDesktop(`${DESKTOP}services/contentGenerationWordTools.cjs`) as { countHtmlWords(html: unknown): number };
const desktopSource = loadDesktop(`${DESKTOP}utils/aiSourceExtraction.cjs`) as { extractAiSource(response: string, kind: string): string };
const desktopTaskFiles = loadDesktop(`${DESKTOP}services/contentGenerationTaskFiles.cjs`) as {
  readTaskFile(workspaceDir: string, key: string): unknown;
  compactResults(results: unknown[]): unknown;
};
const desktopAgent = loadDesktop(`${DESKTOP}services/contentGenerationAgent.cjs`) as {
  checkSectionHtml(html: unknown): string;
  createContentGenerationTools(options: Record<string, unknown>, context: Record<string, unknown>): { name: string; execute: (...args: unknown[]) => Promise<any> }[];
};

const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});
function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'content-section-writing-'));
  workspaces.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content, 'utf8');
  }
  return dir;
}

/** 同一输入在两边的结果（返回值或抛出的说明）。 */
function outcome(fn: () => unknown): { value: unknown } | { error: string } {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

const SECTION_HTML = '<!-- app:block -->\n<p>本节说明施工组织安排。</p>';

describe('word counts (desktop parity)', () => {
  const samples = [
    '',
    '纯中文正文，共十个字。',
    'Mixed 中英 text with v1.2.3 and foo-bar_baz 42',
    '# 标题\n\n- 列表项\n1. 第一\n> 引用\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |',
    '![图](a.png) [链接](https://example.com/x) [ref][1]\n[1]: https://example.com\n```js\ncode\n```\n`inline`',
    '<!-- app:block -->\n<p>段落<br/>换行</p><ul><li>一</li></ul><table><tr><td>格</td></tr></table>&nbsp;app-asset://abc file:///x',
    '<figure data-app-size="wide"><template>提示词不计入字数</template><img alt="图"><figcaption>图 1 说明</figcaption></figure>',
    '<TEMPLATE>大写</TEMPLATE><template a="1">多</template>正文<template>未闭合',
    '㐀䶵一鿿 〇 ～ ０１２',
  ];
  for (const sample of samples) {
    it(`counts ${JSON.stringify(sample.slice(0, 24))} like the desktop`, () => {
      expect(countReadableWords(sample)).toBe(desktopWords.countReadableWords(sample));
      expect(countHtmlWords(sample)).toBe(desktopWordTools.countHtmlWords(sample));
    });
  }
  it('treats non-string input like the desktop', () => {
    for (const value of [null, undefined, 0, 12345]) expect(countReadableWords(value)).toBe(desktopWords.countReadableWords(value));
    expect(countHtmlWords(null)).toBe(desktopWordTools.countHtmlWords(null));
  });
});

describe('extractAiSource / checkSectionHtml (desktop parity)', () => {
  const responses = [
    SECTION_HTML,
    `  \n${SECTION_HTML}\n  `,
    `说明文字\n\`\`\`html\n${SECTION_HTML}\n\`\`\`\n结尾`,
    `\`\`\`\n${SECTION_HTML}\n\`\`\``,
    `\`\`\`HTML\r\n${SECTION_HTML}\r\n\`\`\``,
    `\`\`\`markdown\n${SECTION_HTML}\n\`\`\``,
    `\`\`\`html\n${SECTION_HTML}`,
    `\`\`\`html\n${SECTION_HTML}\n\`\`\`\n\`\`\`html\n<p>二</p>\n\`\`\``,
    '```html\n   \n```',
    '   ',
    '````html\n<p>四个反引号</p>\n````',
  ];
  for (const response of responses) {
    it(`extracts ${JSON.stringify(response.slice(0, 30))} like the desktop`, () => {
      expect(outcome(() => extractAiSource(response, 'html'))).toEqual(outcome(() => desktopSource.extractAiSource(response, 'html')));
    });
  }

  const sections = [
    SECTION_HTML,
    '  <!-- app:block -->\n<ol><li>一</li></ol>',
    '<!-- app:block --><table><tr><td>表</td></tr></table>',
    '<p>没有分隔</p>',
    '<!-- app:block -->\n<div>没有段落、列表或表格</div>',
    '<!-- app:block -->\n<p></p>',
    '<!-- app:block -->\n<p><template>只有提示词</template></p>',
    '<!-- app:block -->\n<p>含围栏 ``` </p>',
    '<!-- app:block -->\n<P>大写段落</P>',
    '<!-- app:block -->\n<pre>pre 不算段落</pre>',
  ];
  for (const html of sections) {
    it(`checks ${JSON.stringify(html.slice(0, 30))} like the desktop`, () => {
      expect(outcome(() => checkSectionHtml(html))).toEqual(outcome(() => desktopAgent.checkSectionHtml(html)));
    });
  }
});

describe('finishSectionHtml', () => {
  it('extracts, checks, closes templates and checks the structure', () => {
    expect(finishSectionHtml(`\`\`\`html\n${SECTION_HTML}\n\`\`\``, 'stop')).toBe(SECTION_HTML);
    const swallowed = '<!-- app:block -->\n<figure data-app-size="wide"><template>画面</｜DSML｜><img alt="a"></figure>\n<p>后文</p>';
    expect(finishSectionHtml(swallowed, 'stop')).toBe('<!-- app:block -->\n<figure data-app-size="wide"><template>画面</template><img alt="a"></figure>\n<p>后文</p>');
  });

  it('rejects truncated output before anything else', () => {
    expect(() => finishSectionHtml(SECTION_HTML, 'length')).toThrow(new ContentSectionOutputError(CONTENT_SECTION_TRUNCATED_MESSAGE));
    expect(() => finishSectionHtml('', 'length')).toThrow(CONTENT_SECTION_TRUNCATED_MESSAGE);
  });

  it('rejects output that is not section HTML or is structurally incomplete', () => {
    expect(() => finishSectionHtml('<p>没有分隔</p>', 'stop')).toThrow(ContentSectionOutputError);
    expect(() => finishSectionHtml('```html\n<p>a</p>', 'stop')).toThrow(ContentSectionOutputError);
    expect(() => finishSectionHtml('<!-- app:block -->\n<p>一</p><div>未结束', 'stop')).toThrow(HtmlStructureError);
    // 源码中途结束只在保存时检查。
    expect(() => finishSectionHtml('<!-- app:block -->\n<p>一</p><!-- 未结束', null)).toThrow('注释尚未结束');
  });
});

// ---- 写作材料与桌面版的 generate-sections ----

const LEAF = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const OUTLINE: TechnicalPlanOutlineItem[] = [
  {
    id: '00000000-0000-4000-8000-0000000000a1',
    number: '1',
    title: '总体设计',
    description: '总体',
    children: [
      { id: LEAF(1), number: '1.1', title: '建设目标', description: '目标', content_mode: 'ai-generate' },
      { id: LEAF(2), number: '1.2', title: '总体架构 & “设计”', description: '', content_mode: 'ai-generate' },
      { id: LEAF(3), number: '1.3', title: '实施计划', description: '计划', content_mode: 'ai-generate' },
    ],
  },
];
const LEAVES = collectAiLeaves(OUTLINE);
const PLANS: Record<string, StoredContentPlan> = Object.fromEntries(
  LEAVES.map(({ item }, index) => [
    item.id,
    {
      plan_version: 6,
      table_requirement: 'light',
      plan: {
        writing_focus: `第 ${index + 1} 节的写作重点`,
        target_words: [1200, 0, 3000][index] ?? 0,
        image_suitability_score: [8, 0, 5][index] ?? 0,
        image_needed: [true, false, true][index] ?? false,
        knowledge: { item_ids: [] },
        table: index === 2 ? { needed: true, purpose: '对比各项措施' } : { needed: false, purpose: '' },
        original_material: { restored: false, optimized: false, source_hash: '', source_ranges: [], restored_words: 0 },
      } as StoredContentPlan['plan'],
    },
  ]),
);

function filesInput(overrides: Partial<ContentWritingFilesInput> = {}): ContentWritingFilesInput {
  return {
    outline: OUTLINE,
    targets: LEAVES,
    plans: PLANS,
    sectionStates: {},
    checkTotalWords: true,
    projectOverview: '某市智慧水务平台建设',
    globalFacts: [{ title: '工期', content: '180 天' }],
    globalFactsMode: 'omit',
    wordControl: { minimumWords: 3000, maximumWords: 6000, sectionWords: 1500 },
    generationOptions: {
      imageQuantity: 50,
      useAiImages: true,
      useMermaidImages: true,
      useHtmlImages: false,
      htmlImageTypes: '',
      useSingleImageLayout: true,
      useImageTextLayout: false,
      useThreeImagesLayout: true,
      useFourImagesLayout: false,
      tableRequirement: 'light',
    },
    requirement: '突出本地化服务',
    template: {
      id: '00000000-0000-4000-8000-0000000000ee',
      name: '标准投标',
      isSystem: true,
      config: { template_name: '标准投标' },
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      updatedAt: new Date('2026-02-03T04:05:06.000Z'),
    },
    documentIds: [],
    knowledgeDocuments: [],
    ...overrides,
  };
}

interface DesktopRun {
  requests: { messages: ChatMessage[]; output_token_limit: number | undefined; reject_truncated_output: boolean | undefined }[];
  outcome: { value: any } | { error: string };
}

/** 在临时工作区中执行桌面版的 generate-sections（模型替身记录请求；cheerio 是桩，写回会失败，只比较请求与提交前的检查）。 */
async function runDesktop(files: Record<string, string>): Promise<DesktopRun> {
  const dir = workspace(files);
  const requests: DesktopRun['requests'] = [];
  const aiService = {
    async chat(request: DesktopRun['requests'][number]) {
      requests.push({ messages: request.messages, output_token_limit: request.output_token_limit, reject_truncated_output: request.reject_truncated_output });
      return SECTION_HTML;
    },
  };
  const tools = desktopAgent.createContentGenerationTools({ aiService }, { Type: stub, workspaceDir: dir, setActiveTools: () => {}, baseline: null });
  const tool = tools.find((entry) => entry.name === 'generate-sections')!;
  try {
    return { requests, outcome: { value: await tool.execute('call-1', {}, undefined, undefined) } };
  } catch (error) {
    return { requests, outcome: { error: (error as Error).message } };
  }
}

function workspaceFiles(input: ContentWritingFilesInput, extra: Record<string, string> = {}): Record<string, string> {
  return { ...Object.fromEntries(buildContentWritingFiles(input).map((file) => [file.path, file.content])), ...extra };
}

const task = (sections: Record<string, unknown>[]) => JSON.stringify({ sections });

describe('readContentSectionsTask (desktop readTaskFile parity)', () => {
  const contents: [string, string | null][] = [
    ['missing', null],
    ['not JSON', '{"sections": ['],
    ['BOM', `﻿${task([{ section_id: LEAF(1), instructions: '', references: '' }])}`],
    ['empty list', task([])],
    ['missing fields', task([{ section_id: LEAF(1) }])],
    ['extra field', task([{ section_id: LEAF(1), instructions: '', references: '', number: '1.1' }])],
    ['wrong types', task([{ section_id: '', instructions: 1, references: null, regenerate: 'yes' }])],
    ['top-level extra', JSON.stringify({ sections: [{ section_id: LEAF(1), instructions: '', references: '' }], other: 1 })],
    ['not an object', '[]'],
    ['valid with regenerate', task([{ section_id: LEAF(2), instructions: '安排一张图', references: '摘录', regenerate: true }])],
  ];
  for (const [name, content] of contents) {
    it(`reads ${name} like the desktop`, () => {
      const dir = workspace(content === null ? {} : { [CONTENT_SECTIONS_TASK_FILE]: content });
      // 桌面版返回整个文件对象，调用处取 sections。
      expect(outcome(() => readContentSectionsTask(content))).toEqual(outcome(() => (desktopTaskFiles.readTaskFile(dir, 'sections') as { sections: unknown }).sections));
    });
  }
  it('throws ContentSectionTaskError', () => {
    expect(() => readContentSectionsTask(null)).toThrow(ContentSectionTaskError);
    expect(() => readContentSectionsTask('x')).toThrow(ContentSectionTaskError);
  });
});

describe('generate-sections requests (desktop parity)', () => {
  const materials = (input: ContentWritingFilesInput) => contentSectionWritingMaterials(buildContentWritingFiles(input));

  it('builds the same prefix warm-up and per-section messages as the desktop', async () => {
    for (const input of [filesInput(), filesInput({ documentIds: ['doc-1'], knowledgeDocuments: [{ documentId: 'doc-1', fileName: 'a.md', status: 'success', itemCount: 0, markdown: '知识', items: [] }], globalFactsMode: 'placeholder', requirement: '' })]) {
      const jobs: ContentSectionJob[] = [
        { section_id: LEAF(3), instructions: '  安排一组三列图片  ', references: '参考：某规范' },
        { section_id: LEAF(1), instructions: '', references: '' },
      ];
      const desktop = await runDesktop(workspaceFiles(input, { [CONTENT_SECTIONS_TASK_FILE]: task(jobs as unknown as Record<string, unknown>[]) }));
      const m = materials(input);
      const system = contentSectionWritingSystem(m);
      const shared = contentSectionSharedInput(m);
      // 多于一节时先预热公共前缀（只有 system 与公共材料，输出 1 个 token）。
      expect(desktop.requests[0]).toEqual({ messages: sharedPrefixMessages(system, shared), output_token_limit: 1, reject_truncated_output: undefined });
      expect(desktop.requests.slice(1).map((request) => request.reject_truncated_output)).toEqual([true, true]);
      expect(desktop.requests.slice(1).map((request) => request.messages)).toEqual(jobs.map((job) => contentSectionMessages(m, m.targets.get(job.section_id)!, job)));
    }
  });

  it('sends a single section without warm-up', async () => {
    const job = { section_id: LEAF(2), instructions: '无', references: '' };
    const desktop = await runDesktop(workspaceFiles(filesInput(), { [CONTENT_SECTIONS_TASK_FILE]: task([job]) }));
    const m = materials(filesInput());
    expect(desktop.requests.map((request) => request.messages)).toEqual([contentSectionMessages(m, m.targets.get(LEAF(2))!, job)]);
  });

  it('rejects non-target and duplicate sections with the desktop message', async () => {
    const input = filesInput({ targets: LEAVES.slice(0, 2) });
    const jobs = [
      { section_id: LEAF(1), instructions: '', references: '' },
      { section_id: LEAF(3), instructions: '', references: '' },
      { section_id: '1.1', instructions: '', references: '' },
      { section_id: LEAF(1), instructions: '', references: '' },
      { section_id: '1.1', instructions: '', references: '' },
    ];
    const desktop = await runDesktop(workspaceFiles(input, { [CONTENT_SECTIONS_TASK_FILE]: task(jobs) }));
    expect(desktop.requests).toEqual([]);
    const m = materials(input);
    const server = outcome(() => planContentSectionBatch(readContentSectionsTask(task(jobs)), m.targets, () => false));
    expect(server).toEqual(desktop.outcome);
    expect('error' in server && server.error).toContain(`${LEAF(3)}、1.1、${LEAF(1)}`);
  });

  it('skips generated sections unless regenerate is set, like the desktop', async () => {
    const jobs = [
      { section_id: LEAF(1), instructions: '', references: '' },
      { section_id: LEAF(2), instructions: '', references: '', regenerate: true },
      { section_id: LEAF(3), instructions: '', references: '' },
    ];
    // 第 1、2 节已有正文（空白文件不算），第 3 节的文件只有空白。
    const existing = { [contentSectionFile(LEAF(1))]: SECTION_HTML, [contentSectionFile(LEAF(2))]: SECTION_HTML, [contentSectionFile(LEAF(3))]: ' \n' };
    const desktop = await runDesktop(workspaceFiles(filesInput(), { ...existing, [CONTENT_SECTIONS_TASK_FILE]: task(jobs) }));
    const m = materials(filesInput());
    const batch = planContentSectionBatch(readContentSectionsTask(task(jobs)), m.targets, (id) => Boolean(existing[contentSectionFile(id)]?.trim()));
    expect(batch.ids).toEqual(jobs.map((job) => job.section_id));
    expect(batch.pending.map((job) => job.section_id)).toEqual([LEAF(2), LEAF(3)]);
    // 桌面版只为 pending 发出请求（多于一节时另有一次预热），跳过的小节原样出现在结果中。
    expect(desktop.requests.slice(1).map((request) => request.messages)).toEqual(batch.pending.map((job) => contentSectionMessages(m, m.targets.get(job.section_id)!, job)));
    const results = (desktop.outcome as { value: { details: { results: { section_id: string; status: string }[] } } }).value.details.results;
    expect(results[0]).toEqual(batch.skipped.get(LEAF(1)));
    expect(batch.skipped.get(LEAF(1))).toEqual({ section_id: LEAF(1), file: contentSectionFile(LEAF(1)), status: 'skipped' });
  });

  it('reads the server-side materials, not workspace copies', () => {
    const m = materials(filesInput());
    expect([...m.targets.keys()]).toEqual(LEAVES.map(({ item }) => item.id));
    expect(m.targets.get(LEAF(1))!.file).toBe(contentSectionFile(LEAF(1)));
    expect(contentSectionSharedInput(m)).toContain('用户额外要求：\n突出本地化服务');
    expect(() => contentSectionWritingMaterials(buildContentWritingFiles(filesInput()).filter((file) => file.path !== '全局事实设定.md'))).toThrow(TypeError);
  });
});

describe('results', () => {
  it('compacts results like the desktop', () => {
    const results = [
      { section_id: 'a', file: '正文/a.html', status: 'skipped' },
      { section_id: 'b', file: '正文/b.html', words: 10, status: 'success' },
      { section_id: 'c', status: 'error', error: '失败' },
      { section_id: 'd', status: 'cancelled', error: '已取消' },
    ] as const;
    expect(compactResults(results)).toEqual(desktopTaskFiles.compactResults([...results]));
  });

  it('counts words of a successful section with countHtmlWords', () => {
    const html = '<!-- app:block -->\n<p>十个汉字的段落正文。</p><figure data-app-size="wide"><template>不计入</template><img alt="x"></figure>';
    const target = { id: 'a', number: '1', title: 't', file: '正文/a.html' };
    expect(contentSectionSuccess(target, html)).toEqual({ section_id: 'a', file: '正文/a.html', words: desktopWordTools.countHtmlWords(html), status: 'success' });
  });
});
