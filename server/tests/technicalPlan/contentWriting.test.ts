// 技术方案正文写作阶段的输入（路线图第 8 步 8.10c1，src/technicalPlan/contentWriting.ts、imageLayout.ts、aiImageStyles.ts、
// contentWritingResources.ts）与桌面版的对照：
// - 固定材料（受限HTML生成规范.md、配图类型对照表.md、正文模板.html）与 client/electron/resources/content-generation/ 逐字相同；
// - 画面形式与 aiImageStyles.cjs、布局份额与组数与 shared/imageLayout/index.mjs（每个配图比例档位 × 16 种布局开关 × 0～40 组）相同；
// - 任务文件与结果清单的 Schema 与 contentGenerationTaskFiles.cjs、contentGenerationAgent.cjs 相同；
// - 材料与 buildContentGenerationFiles 的输出逐个文件相同（全部 / 部分目标、已完成小节、字数控制、三种事实模式、无图与布局开关、
//   知识库、没有模板、知识库缺少正文）；
// - 写作阶段的提示词与 runContentGenerationAgent 发出的相同（新会话、目录变更后的局部生成、编排交接、本轮暂停后继续，有无知识库）。
// 桌面版加载方式与 contentGenerationJob.test.ts 相同（ajv 换成 server/ 的同一版本，前端依赖换成桩）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { JobError } from '../../src/jobs/definitions.ts';
import { AI_IMAGE_STYLES } from '../../src/technicalPlan/aiImageStyles.ts';
import type { ContentWordControl, LeafContext, StoredContentPlan } from '../../src/technicalPlan/contentPlanning.ts';
import { collectAiLeaves } from '../../src/technicalPlan/contentPlanning.ts';
import {
  buildContentRunSummary,
  buildContentWritingFiles,
  CONTENT_RESULT_JSON_SCHEMA,
  contentTaskFileSchemas,
  createContentWritingPrompt,
  type ContentWritingFilesInput,
  type ContentWritingKnowledgeDocument,
  type ContentWritingTemplate,
} from '../../src/technicalPlan/contentWriting.ts';
import { CONTENT_HTML_RULES, CONTENT_IMAGE_TYPES, CONTENT_TEMPLATE_HTML } from '../../src/technicalPlan/contentWritingResources.ts';
import { allocateImageLayoutGroups, resolveImageLayoutShares } from '../../src/technicalPlan/imageLayout.ts';
import type { TechnicalPlanOutlineItem } from '../../src/technicalPlan/outline.ts';
import type { ContentGenerationOptions } from '../../src/technicalPlan/store.ts';

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
const desktopAgent = loadDesktop(`${DESKTOP}services/contentGenerationAgent.cjs`) as {
  buildContentGenerationFiles(input: Record<string, unknown>): Promise<{ path: string; content: string }[]>;
  runContentGenerationAgent(input: Record<string, unknown>): Promise<unknown>;
};
const desktopTaskFiles = loadDesktop(`${DESKTOP}services/contentGenerationTaskFiles.cjs`) as { taskFileSchemas(): Record<string, unknown> };
const desktopStyles = loadDesktop(`${DESKTOP}services/aiImageStyles.cjs`) as { AI_IMAGE_STYLES: Record<string, unknown> };
const desktopLayout = (await import(pathToFileURL(new URL(`${DESKTOP}shared/imageLayout/index.mjs`, import.meta.url).pathname).href)) as {
  resolveImageLayoutShares(options: Record<string, unknown>): Record<string, number>;
  allocateImageLayoutGroups(total: number, shares: Record<string, number>): Record<string, number>;
};
const desktopFile = (path: string) => readFileSync(new URL(`${DESKTOP}${path}`, import.meta.url), 'utf8');

const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

// ---- 输入 ----

const LEAF = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const OUTLINE: TechnicalPlanOutlineItem[] = [
  {
    id: '00000000-0000-4000-8000-0000000000a1',
    number: '1',
    title: '总体设计',
    description: '总体',
    children: [
      { id: LEAF(1), number: '1.1', title: '建设目标', description: '目标', content_mode: 'ai-generate' },
      {
        id: '00000000-0000-4000-8000-0000000000a2',
        number: '1.2',
        title: '架构 & “设计”',
        description: '',
        children: [
          { id: LEAF(2), number: '1.2.1', title: '总体架构', description: '', content_mode: 'ai-generate', content_mode_note: '结合现状' },
          { id: LEAF(3), number: '1.2.2', title: '数据<架构>', description: '数据', content_mode: 'ai-generate' },
        ],
      },
      { id: '00000000-0000-4000-8000-0000000000ff', number: '1.3', title: '资质证书', description: '证书', content_mode: 'manual-fill' },
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000000b1',
    number: '2',
    title: '实施方案',
    description: '实施',
    children: [
      { id: LEAF(4), number: '2.1', title: '实施计划', description: '计划', content_mode: 'ai-generate' },
      { id: LEAF(5), number: '2.2', title: '质量保障', description: '质量', content_mode: 'ai-generate' },
      { id: LEAF(6), number: '2.3', title: '售后服务', description: '售后', content_mode: 'ai-generate' },
    ],
  },
];
const LEAVES = collectAiLeaves(OUTLINE);

function storedPlan(index: number, overrides: Record<string, unknown> = {}): StoredContentPlan {
  return {
    plan_version: 6,
    table_requirement: 'light',
    plan: {
      writing_focus: `第 ${index + 1} 节的写作重点`,
      target_words: [1200, 0, 3000, 800, 2500, 1500][index] ?? 0,
      image_suitability_score: [8, 0, 5, 9, 5, 3][index] ?? 0,
      image_needed: [true, false, true, true, false, false][index] ?? false,
      knowledge: { item_ids: index % 2 ? ['doc-1::K000001'] : [] },
      table: index === 2 ? { needed: true, purpose: '对比各项措施' } : { needed: false, purpose: '' },
      original_material: { restored: false, optimized: false, source_hash: '', source_ranges: [], restored_words: 0 },
      ...overrides,
    } as StoredContentPlan['plan'],
  };
}
const PLANS: Record<string, StoredContentPlan> = Object.fromEntries(LEAVES.map(({ item }, index) => [item.id, storedPlan(index)]));

const OPTIONS: ContentGenerationOptions = {
  imageQuantity: 50,
  useAiImages: true,
  useMermaidImages: true,
  useHtmlImages: true,
  htmlImageOptimization: false,
  wordCountRepair: false,
  layoutCheck: false,
  useSingleImageLayout: true,
  useImageTextLayout: true,
  useThreeImagesLayout: true,
  useFourImagesLayout: true,
  htmlImageTypes: '流程图、组织架构图',
  tableRequirement: 'light',
};

const TEMPLATE: ContentWritingTemplate = {
  id: '00000000-0000-4000-8000-0000000000ee',
  name: '标准投标',
  isSystem: true,
  config: { template_name: '标准投标', page: { size: 'A4' }, heading: [{ level: 1, font: '黑体' }] },
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  updatedAt: new Date('2026-02-03T04:05:06.000Z'),
};

const KNOWLEDGE: ContentWritingKnowledgeDocument[] = [
  {
    documentId: 'doc-1',
    fileName: '运维资料.docx',
    status: 'success',
    itemCount: 2,
    markdown: '# 运维体系\n\n7×24 值守',
    items: [
      { itemId: 'K000001', title: '运维体系', resume: '7×24 运维' },
      { itemId: 'K000002', title: '培训', resume: '' },
    ],
  },
  { documentId: 'doc 2/特殊', fileName: '质量.pdf', status: 'success', itemCount: 0, markdown: '质量手册', items: [] },
];

const WORDS: ContentWordControl = { minimumWords: 30000, maximumWords: 50000, sectionWords: 3000 };

function serverInput(overrides: Partial<ContentWritingFilesInput> = {}): ContentWritingFilesInput {
  return {
    outline: OUTLINE,
    targets: LEAVES,
    plans: PLANS,
    sectionStates: {},
    checkTotalWords: true,
    projectOverview: '某市智慧水务平台建设',
    globalFacts: [
      { title: '项目团队', content: '项目经理 1 名' },
      { title: '工期', content: '180 天' },
    ],
    globalFactsMode: 'placeholder',
    wordControl: WORDS,
    generationOptions: OPTIONS,
    requirement: '',
    template: TEMPLATE,
    documentIds: [],
    knowledgeDocuments: [],
    ...overrides,
  };
}

/** 同一份输入换成桌面版 buildContentGenerationFiles 的参数（知识库索引中的文档按 Web 版给出的字段，见文件头）。 */
function desktopInput(input: ContentWritingFilesInput): Record<string, unknown> {
  const template = input.template;
  return {
    outline: input.outline,
    targets: input.targets,
    plans: input.plans,
    sectionStates: input.sectionStates,
    checkTotalWords: input.checkTotalWords,
    projectOverview: input.projectOverview,
    globalFacts: input.globalFacts,
    globalFactsMode: input.globalFactsMode,
    wordControl: input.wordControl,
    generationOptions: input.generationOptions,
    hasOriginalPlan: false,
    restoredContents: {},
    existingTotalWords: 0,
    requirement: input.requirement,
    template: template
      ? {
          template_id: template.id,
          template_name: template.name,
          config: template.config,
          is_system: template.isSystem,
          created_at: template.createdAt.toISOString(),
          updated_at: template.updatedAt.toISOString(),
        }
      : null,
    knowledgeBaseService: {
      readReferences: (ids: string[], options: Record<string, unknown>) => {
        expect(options).toEqual({ includeMarkdown: true, includeItems: true });
        return input.knowledgeDocuments
          .filter((document) => ids.includes(document.documentId))
          .map((document) => ({
            document: { id: document.documentId, file_name: document.fileName, status: document.status, item_count: document.itemCount },
            items: document.items.map((item) => ({ id: item.itemId, title: item.title, resume: item.resume, content: '条目正文' })),
            markdown: document.markdown,
          }));
      },
    },
    documentIds: input.documentIds,
  };
}

async function expectSameFiles(input: ContentWritingFilesInput): Promise<{ path: string; content: string }[]> {
  const desktop = await desktopAgent.buildContentGenerationFiles(desktopInput(input));
  const server = buildContentWritingFiles(input);
  expect(server.map((file) => file.path)).toEqual(desktop.map((file) => file.path));
  for (const [index, file] of server.entries()) expect(file.content, file.path).toBe(desktop[index]!.content);
  return server;
}

async function desktopError(input: ContentWritingFilesInput): Promise<Error> {
  try {
    await desktopAgent.buildContentGenerationFiles(desktopInput(input));
  } catch (error) {
    return error as Error;
  }
  throw new Error('desktop did not fail');
}

function serverError(input: ContentWritingFilesInput): JobError {
  try {
    buildContentWritingFiles(input);
  } catch (error) {
    if (error instanceof JobError) return error;
    throw error;
  }
  throw new Error('server did not fail');
}

describe('固定材料与常量', () => {
  it('受限HTML生成规范.md、配图类型对照表.md、正文模板.html 与桌面版逐字相同', () => {
    expect(CONTENT_HTML_RULES).toBe(desktopFile('resources/content-generation/受限HTML生成规范.md'));
    expect(CONTENT_IMAGE_TYPES).toBe(desktopFile('resources/content-generation/配图类型对照表.md'));
    expect(CONTENT_TEMPLATE_HTML).toBe(desktopFile('resources/content-generation/正文模板.html'));
  });

  it('画面形式、任务文件与结果清单的 Schema 与桌面版相同', () => {
    expect(AI_IMAGE_STYLES).toEqual(desktopStyles.AI_IMAGE_STYLES);
    expect(Object.keys(AI_IMAGE_STYLES)).toEqual(Object.keys(desktopStyles.AI_IMAGE_STYLES));
    expect(contentTaskFileSchemas()).toEqual(desktopTaskFiles.taskFileSchemas());
    // 桌面版 RESULT_SCHEMA 没有导出：取它的字面量求值。
    const source = desktopFile('services/contentGenerationAgent.cjs');
    const literal = /const RESULT_SCHEMA = (\{[\s\S]*?\n\});/.exec(source)?.[1];
    expect(literal).toBeDefined();
    expect(CONTENT_RESULT_JSON_SCHEMA).toEqual(new Function(`return (${literal});`)());
  });

  it('布局份额与组数：每个配图比例档位 × 16 种布局开关 × 0～40 组与桌面版相同', () => {
    const keys = ['useSingleImageLayout', 'useImageTextLayout', 'useThreeImagesLayout', 'useFourImagesLayout'] as const;
    for (const imageQuantity of [0, 10, 20, 30, 40, 50, 60, 80, 100] as const) {
      for (let mask = 0; mask < 16; mask += 1) {
        const options = { imageQuantity, ...Object.fromEntries(keys.map((key, index) => [key, (mask & (1 << index)) !== 0])) } as Parameters<typeof resolveImageLayoutShares>[0];
        const shares = resolveImageLayoutShares(options);
        expect(shares).toEqual(desktopLayout.resolveImageLayoutShares(options));
        for (let total = 0; total <= 40; total += 1) expect(allocateImageLayoutGroups(total, shares)).toEqual(desktopLayout.allocateImageLayoutGroups(total, shares));
      }
    }
  });
});

describe('写作阶段的材料（与桌面版 buildContentGenerationFiles 相同）', () => {
  it('全部目标：文件与顺序、执行清单、模板去掉示例图片引用、所选模板配置、全局事实', async () => {
    const files = await expectSameFiles(serverInput());
    expect(files.map((file) => file.path)).toEqual(['正文完整目录.json', '项目概述.md', '正文编排决策.json', '受限HTML生成规范.md', '配图类型对照表.md', '正文模板.html', '所选模板配置.json', '全局事实设定.md']);
    const decisions = JSON.parse(files[2]!.content);
    expect(decisions.execution_summary).toEqual({
      total_ai_sections: 6,
      target_sections: 6,
      completed_before_run: 0,
      target_words: 9000,
      unspecified_word_target_sections: 1,
      image_candidate_ids: [LEAF(1), LEAF(3), LEAF(4)],
      table_section_ids: [LEAF(3)],
    });
    expect(decisions.image_layout_quota).toEqual({ total_groups: 3, single: 1, imageText: 1, threeImages: 1, fourImages: 0 });
    expect(decisions.targets[2]).toMatchObject({ id: LEAF(3), chapter_path: '总体设计 > 架构 & “设计” > 数据<架构>', file: `正文/${LEAF(3)}.html` });
    expect(files[5]!.content).not.toMatch(/<img\b[^>]*\s(?:src|data-app-asset-ref)=/i);
    expect(JSON.parse(files[6]!.content)).toEqual({
      template_id: TEMPLATE.id,
      template_name: '标准投标',
      config: TEMPLATE.config,
      is_system: true,
      created_at: '2026-01-02T03:04:05.000Z',
      updated_at: '2026-02-03T04:05:06.000Z',
    });
    expect(files[7]!.content).toBe('## 项目团队\n项目经理 1 名\n\n## 工期\n180 天');
  });

  it('部分目标：已完成的非目标小节进入 completed_sections，非目标的编排留在目录中；只统计目标小节字数', async () => {
    const targets: LeafContext[] = [LEAVES[1]!, LEAVES[4]!];
    const files = await expectSameFiles(
      serverInput({ targets, checkTotalWords: false, sectionStates: { [LEAF(1)]: { status: 'success' }, [LEAF(3)]: { status: 'error' }, [LEAF(4)]: { status: 'success' } } }),
    );
    const decisions = JSON.parse(files[2]!.content);
    expect(decisions.completed_sections.map((section: { id: string }) => section.id)).toEqual([LEAF(1), LEAF(4)]);
    expect(decisions.word_control).toEqual({ minimumWords: 30000, maximumWords: 50000, checkTotalWords: false });
    expect(decisions.image_layout_quota.total_groups).toBe(0);
  });

  it('字数控制、三种事实模式、用户额外要求、项目概述为空、没有全局事实、没有编排、编排中的非布尔值', async () => {
    for (const globalFactsMode of ['placeholder', 'omit', 'fabricate'] as const) await expectSameFiles(serverInput({ globalFactsMode }));
    await expectSameFiles(serverInput({ wordControl: { minimumWords: 0, maximumWords: 0, sectionWords: 0 }, requirement: '突出本地化服务', projectOverview: '', globalFacts: [] }));
    await expectSameFiles(serverInput({ plans: {} }));
    // 编排中的值不是布尔值 / 数字时的判断与桌面版相同（image_needed 只认 true）。
    await expectSameFiles(serverInput({ plans: { ...PLANS, [LEAF(2)]: storedPlan(1, { image_needed: 1, target_words: 900 }), [LEAF(6)]: storedPlan(5, { image_needed: 'true' }) } }));
  });

  it('配图：无图、只开部分生成方式、全部关闭、关闭部分布局、配图比例各档', async () => {
    const variants: Partial<ContentGenerationOptions>[] = [
      { imageQuantity: 0 },
      { useAiImages: false },
      { useAiImages: false, useHtmlImages: false },
      { useAiImages: false, useHtmlImages: false, useMermaidImages: false },
      { useSingleImageLayout: false, useImageTextLayout: false },
      { useSingleImageLayout: false, useImageTextLayout: false, useThreeImagesLayout: false, useFourImagesLayout: false },
      { imageQuantity: 10 },
      { imageQuantity: 30, tableRequirement: 'none' },
      { imageQuantity: 100, tableRequirement: 'heavy' },
    ];
    for (const variant of variants) await expectSameFiles(serverInput({ generationOptions: { ...OPTIONS, ...variant } }));
  });

  it('知识库：每篇完整 Markdown 一个文件（文件名按 id 编码），索引带条目（id 为“文档::条目”）；只放入引用的文档', async () => {
    const files = await expectSameFiles(serverInput({ documentIds: ['doc 2/特殊', 'doc-1'], knowledgeDocuments: KNOWLEDGE }));
    expect(files.slice(8).map((file) => file.path)).toEqual([`知识库/${encodeURIComponent('doc 2/特殊')}.md`, '知识库/doc-1.md', '知识库/索引.json']);
    expect(JSON.parse(files[2]!.content)).toMatchObject({ has_knowledge_base: true, reference_files: { knowledge_index: '知识库/索引.json' } });
    expect(JSON.parse(files[10]!.content)[1]).toEqual({
      document_id: 'doc-1',
      file: '知识库/doc-1.md',
      document: { id: 'doc-1', file_name: '运维资料.docx', status: 'success', item_count: 2 },
      items: [
        { id: 'doc-1::K000001', title: '运维体系', resume: '7×24 运维' },
        { id: 'doc-1::K000002', title: '培训', resume: '' },
      ],
    });
    await expectSameFiles(serverInput({ documentIds: ['doc-1'], knowledgeDocuments: KNOWLEDGE }));
  });

  it('没有模板、引用的知识库文档没有完整正文（或读不到）时失败，文案与桌面版相同', async () => {
    const noTemplate = serverInput({ template: null });
    expect(serverError(noTemplate)).toMatchObject({ code: 'TECHNICAL_PLAN_TEMPLATE_REQUIRED', message: (await desktopError(noTemplate)).message });
    for (const knowledgeDocuments of [[{ ...KNOWLEDGE[0]!, markdown: '  \n' }], []]) {
      const input = serverInput({ documentIds: ['doc-1'], knowledgeDocuments });
      expect(serverError(input)).toMatchObject({ code: 'TECHNICAL_PLAN_KNOWLEDGE_MARKDOWN_MISSING', message: (await desktopError(input)).message });
    }
  });
});

describe('写作阶段的提示词（与桌面版 runContentGenerationAgent 发出的相同）', () => {
  /** 运行桌面版到发出写作阶段的提示词为止。session 为原会话的持久状态（null 表示没有原会话）。 */
  async function desktopPrompt(files: { path: string; content: string }[], options: { session: Record<string, unknown> | null; resume: boolean; hasKnowledgeBase: boolean }): Promise<string> {
    const workspace = mkdtempSync(join(tmpdir(), 'content-writing-'));
    workspaces.push(workspace);
    // 本轮暂停后继续时桌面版从工作区已有的执行清单整理摘要。
    writeFileSync(join(workspace, '正文编排决策.json'), files.find((file) => file.path === '正文编排决策.json')!.content);
    let prompt: string | null = null;
    const agentService = {
      hasPersistentTaskSession: () => options.session !== null,
      loadPersistentTask: () => (options.session ? { state: structuredClone(options.session), paths: { workspaceDir: workspace } } : null),
      updatePersistentTask() {},
      async runTask(request: { prompt: string; initial_stage: string }) {
        expect(request.initial_stage).toBe('generating');
        prompt = request.prompt;
        throw new Error('prompt captured');
      },
    };
    await expect(
      desktopAgent.runContentGenerationAgent({
        agentService,
        aiService: {},
        generationOptions: OPTIONS,
        resume: options.resume,
        hasKnowledgeBase: options.hasKnowledgeBase,
        hasOriginalPlan: false,
        signal: new AbortController().signal,
        planning: null,
        buildFiles: async () => files,
      }),
    ).rejects.toThrow('prompt captured');
    return prompt!;
  }

  it('新会话、目录变更后的局部生成、编排交接、本轮暂停后继续；有无知识库', async () => {
    for (const hasKnowledgeBase of [false, true]) {
      const files = buildContentWritingFiles(serverInput(hasKnowledgeBase ? { documentIds: ['doc-1'], knowledgeDocuments: KNOWLEDGE } : {}));
      const runSummary = buildContentRunSummary(files.find((file) => file.path === '正文编排决策.json')!.content);
      expect(runSummary.execution_summary).toMatchObject({ image_candidate_sections: 3, table_sections: 1 });
      expect(runSummary).not.toHaveProperty('targets');
      const cases = [
        { session: null, resume: false, server: { resuming: false, planningHandoff: false, localRegeneration: false } },
        { session: { phase: 'completed' }, resume: false, server: { resuming: false, planningHandoff: false, localRegeneration: true } },
        { session: { phase: 'content-planning' }, resume: false, server: { resuming: false, planningHandoff: true, localRegeneration: false } },
        { session: { phase: 'generating', prompted_stage: null }, resume: true, server: { resuming: true, planningHandoff: false, localRegeneration: false } },
      ];
      for (const { session, resume, server } of cases) {
        const expected = await desktopPrompt(files, { session, resume, hasKnowledgeBase });
        expect(createContentWritingPrompt({ ...server, hasKnowledgeBase, hasOriginalPlan: false, runSummary })).toBe(expected);
      }
    }
  });
});
