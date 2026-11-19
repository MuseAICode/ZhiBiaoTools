// 可研报告目录生成（路线图第 8 步 8.7a，src/feasibilityReport/jobs.ts 的 feasibility-outline、outlineAgent.ts、outlineTemplates.ts）
// 与桌面版 feasibilityOutlineTask.cjs、feasibilityReportPrompts.cjs 的对照：Store 换成内存实现（vi.mock），Agent 换成脚本化的
// 假 AgentRun（记下放入工作区的材料与阶段的请求，按脚本写出 outline.json），桌面版的 agentService.runTask 返回同一份 outline.json，
// 比较工作区材料、提示词、预置 Schema、结果文件、写入的目录（含项目名称与概述）。另覆盖：Agent 写出不规范的目录（编号标题、超过三级、
// 超过数量、不在本次清单中的知识库条目、非字符串字段、Agent 自己写的 id）按桌面版整理；不是合法 JSON / 没有可用目录时失败且说明不含
// 文件内容；续跑只发“继续之前的任务”、不重新放入材料，输入已变化时失败；写入时签名不符；节点数超过上限；资料分析为空；Agent 不可用。
// 数据库写入与接口见 tests/db/feasibilityReportJobs.test.ts。
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import { JobError, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';

const fake = vi.hoisted(() => ({
  state: null as unknown as Record<string, any>,
  knowledge: [] as { documentId: string; itemId: string; title: string; resume: string; content: string }[],
  signature: 'sig-1',
  /** 写入时核对的签名（模拟写入前输入已变化）。 */
  writeSignature: null as string | null,
  saved: [] as { input: Record<string, any>; signature: string }[],
}));

vi.mock('../../src/feasibilityReport/store.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/feasibilityReport/store.ts')>();
  return {
    ...original,
    inputSignature: async () => fake.signature,
    loadFeasibilityReport: async () => structuredClone(fake.state),
    readReferenceKnowledgeItems: async () => structuredClone(fake.knowledge),
    saveOutlineResult: async (_db: unknown, _context: unknown, _projectId: string, input: Record<string, any>, signature: string) => {
      if (signature !== (fake.writeSignature ?? fake.signature)) return false;
      fake.saved.push({ input: structuredClone(input), signature });
      return true;
    },
  };
});

const { createFeasibilityReportJobs, FEASIBILITY_OUTLINE_JOB_TYPE } = await import('../../src/feasibilityReport/jobs.ts');
const { buildOutlineTemplateMarkdown, formatOutlineTemplateTree, FEASIBILITY_OUTLINE_TEMPLATE_DEFINITIONS } = await import('../../src/feasibilityReport/outlineTemplates.ts');
const { finalizeFeasibilityOutline, FEASIBILITY_OUTLINE_JSON_SCHEMA } = await import('../../src/feasibilityReport/outlineAgent.ts');
const { FEASIBILITY_OUTLINE_TEMPLATES } = await import('../../src/db/migrations/0017_feasibility_report.ts');

const require = createRequire(import.meta.url);
const desktopTask = require('../../../client/electron/services/feasibilityOutlineTask.cjs') as {
  OUTLINE_OUTPUT_FILE: string;
  OUTLINE_JSON_SCHEMA: unknown;
  finalizeOutline(raw: unknown, allowed: Set<string>): unknown;
  runFeasibilityOutlineTask(options: Record<string, unknown>): Promise<void>;
};
const desktopPrompts = require('../../../client/electron/services/feasibilityReportPrompts.cjs') as {
  OUTLINE_TEMPLATES: Record<string, unknown>;
  formatOutlineTemplateTree(id: string): string;
  buildOutlineTemplateMarkdown(id: string, words: unknown): string;
};

// ---- 输入 ----

const PROJECT_INFO = {
  projectName: '城区供水管网改造工程',
  projectType: 'government',
  industry: '市政公用',
  constructionUnit: '城投公司',
  location: '某市主城区',
  constructionContent: '改造供水管网 12 公里',
  constructionPeriodYears: '2',
  operationPeriodYears: '20',
  totalInvestment: '',
  fundingSource: '财政资金',
};

const KNOWLEDGE = [
  { documentId: 'doc-1', itemId: 'item-1', title: '供水管网改造方案', resume: '管网工程方案与施工组织', content: '采用球墨铸铁管。' },
  { documentId: 'doc-1', itemId: 'item-2', title: '编制依据清单', resume: '规范与标准', content: '《室外给水设计标准》。' },
  { documentId: 'doc-1', itemId: 'item-3', title: '无简介条目', resume: '', content: '只有正文。' },
];

const ANALYSIS = `## 项目概况\n\n${'改造管网 12 公里，'.repeat(60)}`;

function baseState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    step: 'outline',
    projectInfo: { ...PROJECT_INFO },
    sourceFiles: [],
    analysisMarkdown: ANALYSIS,
    outlineTemplate: 'enterprise',
    targetWords: 50000,
    referenceDocumentIds: ['doc-1'],
    keyParametersMarkdown: '## 旧的关键参数',
    outlineData: null,
    analysisTask: null,
    outlineTask: null,
    outlineAdjustmentTask: null,
    parametersTask: null,
    contentTask: null,
    humanWritingTask: null,
    ...overrides,
  };
}

/** Agent 写出的 outline.json：带编号的标题、超过三级、不在清单中的条目、Agent 自己写的 id、非字符串字段、空白项。 */
const MESSY_OUTLINE = JSON.stringify({
  outline: [
    {
      id: 'x-1',
      title: '第一章 概述',
      description: ' 项目概况与结论 ',
      knowledge_item_ids: ['doc-1::item-1'],
      children: [
        { title: '1.1 项目概况', description: '', knowledge_item_ids: ['doc-1::item-1', 'doc-1::item-1', 'doc-9::other', 'doc-1::item-3', 42] },
        {
          title: '编制依据',
          description: '依据',
          children: [{ title: '规范', description: '标准', children: [{ title: '第四级', description: '不保留' }] }],
        },
      ],
    },
    { title: '', description: '' },
    { title: 123, description: { nested: true } },
    'not-an-object',
    { title: '二、项目建设方案', description: '方案', knowledge_item_ids: ['doc-1::item-2'] },
  ],
});

// ---- 桌面版 ----

async function runDesktop(state: Record<string, any>, outputContent: string, knowledge = KNOWLEDGE) {
  let workspace = structuredClone(state);
  const payloads: Record<string, any>[] = [];
  const agentService = {
    async runTask(payload: Record<string, any>) {
      payloads.push(payload);
      return { output_content: outputContent };
    },
    updatePersistentTask() {},
  };
  const knowledgeBaseService = {
    getOutlineReferences: () => ({
      items: knowledge.filter((item) => item.title && item.resume).map((item) => ({ id: `${item.documentId}::${item.itemId}`, title: item.title, resume: item.resume })),
    }),
  };
  let error: unknown = null;
  try {
    await desktopTask.runFeasibilityOutlineTask({
      agentService,
      workspaceStore: { loadFeasibilityReport: () => structuredClone(workspace) },
      knowledgeBaseService,
      updateTask: () => ({}),
      checkpointTask: (task: unknown, patch: Record<string, unknown> = {}) => {
        workspace = { ...workspace, ...structuredClone(patch) };
        return { task: task ?? {} };
      },
      taskControl: { signal: new AbortController().signal },
    });
  } catch (caught) {
    error = caught;
  }
  return { payload: payloads[0]!, state: workspace, error };
}

// ---- 服务端（假 AgentRun） ----

interface FakeRunOptions {
  output?: string | null;
  resumed?: boolean;
  taskCheckpoint?: Record<string, unknown> | null;
  promptedStage?: string | null;
  unavailable?: string[];
  /** 结果文件过大（readFiles 只给出大小）。 */
  tooLarge?: boolean;
}

interface FakeRun {
  written: { group: string; files: { path: string; content: string }[]; options: unknown }[];
  stages: AgentStageOptions<unknown>[];
  checkpoints: (Record<string, unknown> | null)[];
  closed: boolean;
}

function fakeAgent(options: FakeRunOptions): { agent: JobAgent; record: FakeRun } {
  const record: FakeRun = { written: [], stages: [], checkpoints: [], closed: false };
  const run = {
    sandbox: { id: 'sandbox-1' },
    resumed: options.resumed ?? false,
    unavailableProtectedFiles: options.unavailable ?? [],
    taskCheckpoint: options.taskCheckpoint ?? null,
    wasPrompted: (stage: string) => options.promptedStage === stage,
    baseline: {
      async write(_sandbox: unknown, group: string, files: { path: string; data: Buffer }[], writeOptions: unknown) {
        record.written.push({ group, files: files.map((file) => ({ path: file.path, content: file.data.toString('utf8') })), options: writeOptions });
      },
    },
    async readFiles(paths: readonly string[]) {
      const result = new Map<string, { size: number; data: Buffer | null }>();
      if (options.output !== null && options.output !== undefined) {
        const data = Buffer.from(options.output, 'utf8');
        result.set(paths[0]!, { size: data.length, data: options.tooLarge ? null : data });
      }
      return result;
    },
    async runStage(stage: AgentStageOptions<unknown>) {
      record.stages.push(stage);
      record.checkpoints.push(stage.checkpointAfterPrompt?.() ?? null);
      const report = await stage.validate({ attempt: 1, restored: [] });
      return { value: report.value, acceptedIssues: report.issues, repairs: 0, executionRetries: 0 };
    },
    async close() {
      record.closed = true;
    },
  };
  return { agent: { template: 'agent', resuming: run.resumed, open: async () => run as unknown as AgentRun }, record };
}

const job = createFeasibilityReportJobs().find((item) => item.type === FEASIBILITY_OUTLINE_JOB_TYPE)! as JobTypeDefinition<any>;

async function runServer(agent: JobAgent | null) {
  const logs: string[] = [];
  const context: JobContext<any> = {
    jobId: 'job-1',
    projectId: 'project-1',
    type: FEASIBILITY_OUTLINE_JOB_TYPE,
    attempt: 1,
    params: job.parseParams({}),
    checkpoint: null,
    tenant: { orgId: 'org-1', userId: 'user-1', role: 'owner' },
    db: null as never,
    signal: new AbortController().signal,
    async setProgress() {},
    async saveCheckpoint() {},
    async log(message) {
      logs.push(message);
    },
    ai: null as never,
    objectStore: null,
    sandbox: null,
    agentWorkspace: null,
    agent,
  };
  try {
    await job.run(context);
    return { logs, error: null as unknown };
  } catch (error) {
    return { logs, error };
  }
}

const textOf = (files: { path: string; content: string }[]) => files.map((file) => ({ path: file.path, content: file.content }));

beforeEach(() => {
  fake.state = baseState();
  fake.knowledge = structuredClone(KNOWLEDGE);
  fake.signature = 'sig-1';
  fake.writeSignature = null;
  fake.saved = [];
});

describe('通用大纲（与桌面版 feasibilityReportPrompts.cjs 相同）', () => {
  it('七个模板的内容、大纲树与“大纲模板.md”逐字相同；模板 id 与迁移 0017 的取值相同；未知模板按政府投资项目大纲', () => {
    expect(Object.keys(FEASIBILITY_OUTLINE_TEMPLATE_DEFINITIONS)).toEqual([...FEASIBILITY_OUTLINE_TEMPLATES]);
    expect(FEASIBILITY_OUTLINE_TEMPLATE_DEFINITIONS).toEqual(desktopPrompts.OUTLINE_TEMPLATES);
    for (const id of [...FEASIBILITY_OUTLINE_TEMPLATES, 'unknown']) {
      expect(formatOutlineTemplateTree(id)).toBe(desktopPrompts.formatOutlineTemplateTree(id));
      for (const words of [30000, 120000, 0]) expect(buildOutlineTemplateMarkdown(id, words)).toBe(desktopPrompts.buildOutlineTemplateMarkdown(id, words));
    }
  });
});

describe('目录生成（与桌面版 feasibilityOutlineTask.cjs 对照）', () => {
  it('工作区材料、提示词、预置 Schema、结果文件与工具和桌面版相同；材料登记为受保护文件；写入的目录、项目名称与概述相同', async () => {
    const desktop = await runDesktop(baseState(), MESSY_OUTLINE);
    expect(desktop.error).toBeNull();
    const { agent, record } = fakeAgent({ output: MESSY_OUTLINE });
    const server = await runServer(agent);
    expect(server.error).toBeNull();

    expect(record.written).toHaveLength(1);
    expect(record.written[0]!.group).toBe('input');
    expect(record.written[0]!.options).toMatchObject({ replace: true });
    expect(textOf(record.written[0]!.files)).toEqual(textOf(desktop.payload.files));
    expect(record.written[0]!.files.map((file) => file.path)).toEqual(['项目参数.md', '资料分析.md', '大纲模板.md', '参考知识库.md', '材料说明.md']);

    const stage = record.stages[0]!;
    expect(stage.prompt).toBe(desktop.payload.prompt);
    expect(stage.stage).toBe(desktop.payload.initial_stage);
    expect(stage.stageIndex).toBe(desktop.payload.initial_stage_index);
    expect(stage.outputFile).toBe(desktop.payload.output_file);
    expect(stage.maxExecutionRetries).toBe(desktop.payload.max_retries);
    expect(stage.jsonSchemas).toEqual(desktop.payload.json_validation_schemas);
    expect(FEASIBILITY_OUTLINE_JSON_SCHEMA).toEqual(desktopTask.OUTLINE_JSON_SCHEMA);
    // 桌面版顶层任务的默认工具：原生工具、json-validation、ask-user 与需用户确认的失败报告。
    expect(stage.tools).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'json-validation', 'ask-user', 'request-termination']);
    expect(record.checkpoints).toEqual([{ signature: 'sig-1' }]);
    expect(record.closed).toBe(true);

    expect(fake.saved).toHaveLength(1);
    const saved = fake.saved[0]!;
    expect(saved.signature).toBe('sig-1');
    expect(saved.input.outline).toEqual(desktop.state.outlineData.outline);
    expect(saved.input.projectName).toBe(desktop.state.outlineData.project_name);
    expect(saved.input.projectOverview).toBe(desktop.state.outlineData.project_overview);
    expect(desktop.state.keyParametersMarkdown).toBe('');
    expect(server.logs).toEqual([
      '开始生成报告目录。',
      '已读取 2 条知识库轻量条目。',
      '正在准备目录生成工作区材料。',
      'Agent 正在生成报告目录。',
      '已生成 3 个一级目录。',
      '报告目录生成完成。',
    ]);
  });

  it('不规范的目录按桌面版整理：去掉编号、最多三级、一级 16 个其余每级 20 个、只保留本次清单中的条目、程序分配 id', async () => {
    const allowed = new Set(['doc-1::item-1', 'doc-1::item-2']);
    expect(finalizeFeasibilityOutline(MESSY_OUTLINE, allowed)).toEqual(desktopTask.finalizeOutline(JSON.parse(MESSY_OUTLINE), allowed));
    const wide = JSON.stringify({
      outline: Array.from({ length: 20 }, (_, i) => ({
        title: `章${i}`,
        description: '',
        children: Array.from({ length: 25 }, (_, j) => ({ title: `节${j}`, description: 'x' })),
      })),
    });
    const result = finalizeFeasibilityOutline(wide, allowed);
    expect(result).toEqual(desktopTask.finalizeOutline(JSON.parse(wide), allowed));
    expect(result).toHaveLength(16);
    expect(result[0]!.children).toHaveLength(20);
    expect(result[15]!.children![19]!.id).toBe('16.20');
  });

  it('没有引用知识库时材料中没有“参考知识库.md”，提示词与桌面版相同；未知模板、目标字数为 0 时与桌面版相同', async () => {
    fake.knowledge = [];
    fake.state = baseState({ referenceDocumentIds: [], outlineTemplate: 'hi_tech', targetWords: 0 });
    const output = JSON.stringify({ outline: [{ title: '概述', description: '' }] });
    const desktop = await runDesktop(fake.state, output, []);
    const { agent, record } = fakeAgent({ output });
    const server = await runServer(agent);
    expect(server.error).toBeNull();
    expect(textOf(record.written[0]!.files)).toEqual(textOf(desktop.payload.files));
    expect(record.written[0]!.files.map((file) => file.path)).toEqual(['项目参数.md', '资料分析.md', '大纲模板.md', '材料说明.md']);
    expect(record.stages[0]!.prompt).toBe(desktop.payload.prompt);
    expect(server.logs[1]).toBe('本次未使用知识库条目。');
  });

  it('不是合法 JSON、文件不存在、没有可用目录时与桌面版相同地失败；说明是固定文字、不含文件内容；不写入', async () => {
    const secret = '{"outline": [ 注入的内容-ignore-previous';
    const desktopInvalid = await runDesktop(baseState(), secret);
    expect(String((desktopInvalid.error as Error).message)).toMatch(/^outline\.json不是合法 JSON：/);
    for (const output of [secret, null, '']) {
      const { agent } = fakeAgent({ output });
      const { error } = await runServer(agent);
      expect(error).toBeInstanceOf(JobError);
      expect((error as JobError).code).toBe('FEASIBILITY_REPORT_OUTLINE_INVALID');
      expect((error as JobError).message).toBe('outline.json不是合法 JSON');
    }
    const empty = JSON.stringify({ outline: [{ title: '', description: '' }] });
    const desktopEmpty = await runDesktop(baseState(), empty);
    expect((desktopEmpty.error as Error).message).toBe('模型未返回可用目录');
    const { agent } = fakeAgent({ output: empty });
    const { error } = await runServer(agent);
    expect((error as JobError).message).toBe('模型未返回可用目录');
    const large = fakeAgent({ output: '{}', tooLarge: true });
    expect(((await runServer(large.agent)).error as JobError).code).toBe('FEASIBILITY_REPORT_OUTLINE_INVALID');
    expect(fake.saved).toEqual([]);
  });

  it('节点数超过上限（2000）时失败、不写入', async () => {
    const huge = JSON.stringify({
      outline: Array.from({ length: 16 }, () => ({
        title: '章',
        description: '',
        children: Array.from({ length: 20 }, () => ({ title: '节', description: '', children: Array.from({ length: 20 }, () => ({ title: '小节', description: '' })) })),
      })),
    });
    const { agent } = fakeAgent({ output: huge });
    const { error } = await runServer(agent);
    expect((error as JobError).code).toBe('FEASIBILITY_REPORT_OUTLINE_TOO_LARGE');
    expect(fake.saved).toEqual([]);
  });

  it('续跑：已发出阶段要求时只发“继续之前的任务”，不重新放入材料，写入用首次执行的签名；原件不可用时按同一输入重新放入', async () => {
    const output = JSON.stringify({ outline: [{ title: '概述', description: '' }] });
    const resumed = fakeAgent({ output, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: 'feasibility-outline' });
    const first = await runServer(resumed.agent);
    expect(first.error).toBeNull();
    expect(resumed.record.written).toEqual([]);
    expect(resumed.record.stages[0]!.prompt).toBe('继续之前的任务');
    expect(first.logs[0]).toBe('Agent 继续生成报告目录。');
    expect(fake.saved.at(-1)!.signature).toBe('sig-1');

    const unavailable = fakeAgent({ output, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: null, unavailable: ['资料分析.md'] });
    expect((await runServer(unavailable.agent)).error).toBeNull();
    expect(unavailable.record.written).toHaveLength(1);
    expect(unavailable.record.stages[0]!.prompt).not.toBe('继续之前的任务');
  });

  it('续跑时输入已变化、或写入时签名不符：任务以 FEASIBILITY_REPORT_INPUT_CHANGED 失败，不写入', async () => {
    const output = JSON.stringify({ outline: [{ title: '概述', description: '' }] });
    fake.signature = 'sig-2';
    const changed = fakeAgent({ output, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: 'feasibility-outline' });
    const resumedRun = await runServer(changed.agent);
    expect((resumedRun.error as JobError).code).toBe('FEASIBILITY_REPORT_INPUT_CHANGED');
    expect(changed.record.stages).toEqual([]);
    expect(changed.record.closed).toBe(true);

    fake.signature = 'sig-1';
    fake.writeSignature = 'sig-3';
    const { agent } = fakeAgent({ output });
    expect(((await runServer(agent)).error as JobError).code).toBe('FEASIBILITY_REPORT_INPUT_CHANGED');
    expect(fake.saved).toEqual([]);
  });

  it('资料分析为空时不开始（与桌面版的“请先完成资料分析”相同）；Agent 不可用时 AGENT_UNAVAILABLE', async () => {
    fake.state = baseState({ analysisMarkdown: '  \n' });
    const desktop = await runDesktop(fake.state, '{}');
    expect((desktop.error as Error).message).toBe('请先完成资料分析');
    const { agent, record } = fakeAgent({ output: '{}' });
    const { error } = await runServer(agent);
    expect((error as JobError).code).toBe('FEASIBILITY_REPORT_ANALYSIS_REQUIRED');
    expect((error as JobError).message).toBe('请先完成资料分析');
    expect(record.stages).toEqual([]);

    fake.state = baseState();
    expect(((await runServer(null)).error as JobError).code).toBe('AGENT_UNAVAILABLE');
  });

  it('任务参数只接受空对象', () => {
    expect(job.parseParams({})).toEqual({});
    expect(() => job.parseParams({ outlineTemplate: 'government' })).toThrow(TypeError);
    expect(() => job.parseParams(null)).toThrow(TypeError);
  });
});
