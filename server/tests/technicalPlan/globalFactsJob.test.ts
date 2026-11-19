// 技术方案全局事实生成（路线图第 8 步 8.7c1，src/technicalPlan/jobs.ts 的 global-facts-generation、globalFactsAgent.ts）与桌面版
// globalFactsTaskV2.cjs（及其引用的 globalFactsTask.cjs、utils/bidSectionContext.cjs）的对照：Store 换成内存实现（vi.mock），Agent 换成
// 脚本化的假 AgentRun（记下放入工作区的材料与阶段的请求，按脚本给出 global-facts.json），桌面版的 agentService.runTask 用同一份文件
// 调用它自己的 validateOutput。比较工作区材料、提示词（三种缺值写法）、预置 Schema、阶段与工具、提交校验的问题清单、写入的全局事实
// 与日志。另覆盖：多份招标文件 / 多标段的投标范围 / 知识库与原方案、不符合 agent 工作区路径规则的招标文件名、Schema 错误超过提交校验
// 报告上限、服务端的全局事实上限、结果文件过大或不存在、续跑与输入变化、写入时签名不符、开始时的各项检查、Agent 不可用、任务参数。
// 数据库读写与接口见 tests/db/technicalPlanGlobalFacts.test.ts。
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import { JobError, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';
import { validateRelativePath } from '../../src/sandbox/archive.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';

const fake = vi.hoisted(() => ({
  state: null as unknown as Record<string, any>,
  tenderFiles: [] as { fileName: string; markdown: string }[],
  workingCopy: '',
  originalPlan: '',
  knowledge: [] as { documentId: string; itemId: string; title: string; resume: string; content: string }[],
  signature: 'sig-1',
  /** 写入时核对的签名（模拟写入前输入已变化）。 */
  writeSignature: null as string | null,
  saved: [] as { groups: unknown; signature: string }[],
  reads: [] as { tenders: boolean }[],
}));

vi.mock('../../src/technicalPlan/store.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/technicalPlan/store.ts')>();
  return {
    ...original,
    globalFactsInputSignature: async () => fake.signature,
    loadTechnicalPlan: async () => structuredClone(fake.state),
    readGlobalFactsSources: async (_db: unknown, _context: unknown, _projectId: string, _store: unknown, options: { tenders: boolean }) => {
      fake.reads.push(options);
      return { tenderFiles: options.tenders ? structuredClone(fake.tenderFiles) : [], originalPlanMarkdown: fake.originalPlan };
    },
    readTenderMarkdown: async () => fake.workingCopy,
    readGlobalFactsKnowledgeItems: async () => structuredClone(fake.knowledge),
    saveGlobalFactsResult: async (_db: unknown, _context: unknown, _projectId: string, groups: unknown, signature: string) => {
      if (signature !== (fake.writeSignature ?? fake.signature)) return false;
      fake.saved.push({ groups: structuredClone(groups), signature });
      return true;
    },
  };
});

const { createTechnicalPlanJobs, GLOBAL_FACTS_JOB_TYPE } = await import('../../src/technicalPlan/jobs.ts');
const { GLOBAL_FACTS_JSON_SCHEMA, GLOBAL_FACTS_OUTPUT_FILE, tenderWorkspacePath, validateGlobalFactsOutput } = await import('../../src/technicalPlan/globalFactsAgent.ts');
const { AGENT_SUBMISSION_MAX_ISSUES } = await import('../../src/agent/submission.ts');

// 桌面版依赖 client/ 的 ajv（CI 的 server 任务不安装 client/ 的依赖）：换成 server/ 中同一版本（8.20.0）的 ajv，其余模块用桌面版原文件。
const require = createRequire(import.meta.url);
function loadDesktop(): any {
  const Module = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = Module._load;
  const ajv = require('ajv') as unknown;
  Module._load = function load(request: string, parent: unknown, isMain: boolean) {
    if (request === 'ajv') return ajv;
    return original.call(this, request, parent, isMain);
  };
  try {
    return require('../../../client/electron/services/globalFactsTaskV2.cjs');
  } finally {
    Module._load = original;
  }
}
const desktopTask = loadDesktop() as {
  GLOBAL_FACTS_OUTPUT_FILE: string;
  GLOBAL_FACTS_JSON_SCHEMA: unknown;
  validateGlobalFactsOutput(content: string): { value: unknown; issues: { severity: string; message: string }[] };
  runGlobalFactsTaskV2(options: Record<string, unknown>): Promise<void>;
};

// ---- 输入 ----

const OUTLINE = [
  {
    id: 'n1',
    number: '1',
    title: '项目理解',
    description: '项目背景与需求',
    children: [
      { id: 'n1-1', number: '1.1', title: '建设背景', description: '' },
      { id: 'n1-2', number: '1.2', title: '建设目标', description: '目标\n与范围' },
    ],
  },
  { id: 'n2', number: '2', title: '实施方案', description: '', children: [{ id: 'n2-1', number: '2.1', title: '进度计划', description: '工期安排' }] },
];

const BID_ITEMS = {
  projectOverview: { id: 'projectOverview', label: '项目概述', status: 'success', content: '某市智慧水务平台建设', error: null },
  projectInfo: { id: 'projectInfo', label: '项目信息', status: 'success', content: '项目名称：某市智慧水务平台\n预算：500 万元', error: null },
  partAInfo: { id: 'partAInfo', label: '甲方信息', status: 'error', content: '失败的不采用', error: '解析失败' },
  deliveryAndServiceRequirements: { id: 'deliveryAndServiceRequirements', label: '交货和服务要求', status: 'success', content: '工期 180 日历天', error: null },
};

const SECTIONS = [
  { id: 's1', index: 1, unit: '标段', title: '第一标段：平台软件', headLine: '第一标段', description: '平台软件开发', includeRanges: [{ startLine: 1, endLine: 10 }], evidence: ['标段划分表', '第一标段'] },
  { id: 's2', index: 2, unit: '标段', title: '第二标段：硬件', headLine: '第二标段', description: '', includeRanges: [{ startLine: 11, endLine: 20 }], evidence: [] },
];

const KNOWLEDGE = [
  { documentId: 'doc-1', itemId: 'item-1', title: '  水务平台\n案例 ', resume: '同类项目', content: '项目经理：王工。' },
  { documentId: 'doc-1', itemId: 'item-2', title: '无正文条目', resume: '只有简介', content: '   ' },
  { documentId: 'doc-2', itemId: 'item-9', title: '运维承诺', resume: '', content: '7×24 小时响应。' },
];

const TENDERS = [
  { id: 'f1', fileName: '招标文件（正文）.docx', markdown: '# 招标公告\n\n工期：180 日历天。' },
  { id: 'f2', fileName: '技术规范书.pdf', markdown: '## 技术要求\n\n7×24 运维。' },
];

function baseState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    step: 'global-facts',
    tenderFiles: TENDERS.map((file) => ({ id: file.id, fileName: file.fileName, status: 'success', markdownArtifactId: `a-${file.id}` })),
    originalPlanFile: null,
    selectedSection: null,
    bidSectionMode: 'single',
    bidSections: [],
    projectOverview: BID_ITEMS.projectOverview.content,
    bidAnalysisTasks: structuredClone(BID_ITEMS),
    outlineData: { outline: structuredClone(OUTLINE) },
    referenceKnowledgeDocumentIds: ['doc-1', 'doc-2'],
    globalFactsMode: 'fabricate',
    globalFacts: [],
    ...overrides,
  };
}

/** 服务端状态对应的桌面版 storedPlan。 */
function desktopPlan(state: Record<string, any>): Record<string, any> {
  return {
    bidSectionMode: state.bidSectionMode,
    tenderFile: state.selectedSection ? { fileName: '招标文件', selectedSectionId: state.selectedSection.id } : { fileName: '招标文件' },
    bidSections: state.bidSections,
    tenderFiles: state.tenderFiles.map((file: Record<string, any>) => ({ id: file.id, fileName: file.fileName })),
    originalPlanFile: state.originalPlanFile ? { fileName: '原方案.docx' } : undefined,
    projectOverview: state.projectOverview,
    bidAnalysisTasks: state.bidAnalysisTasks,
    outlineData: state.outlineData,
    referenceKnowledgeDocumentIds: state.referenceKnowledgeDocumentIds,
    globalFactsMode: state.globalFactsMode,
  };
}

const VALID_OUTPUT = JSON.stringify({
  groups: [
    { id: 'Project Team!', title: '  项目角色\n变量 ', content: '\n- 项目经理：张伟。\n' },
    { id: 'project_team', title: '工期变量', content: '- 工期：180 日历天。' },
    { id: 'blank', title: '   ', content: '- 丢弃' },
    { id: '中文', title: '运维变量', content: '- 7×24 小时响应。' },
  ],
});

// ---- 桌面版 ----

async function runDesktop(state: Record<string, any>, outputContent: string, payload: Record<string, unknown> = {}) {
  const plan = desktopPlan(state);
  const payloads: Record<string, any>[] = [];
  const logs: string[] = [];
  let saved: unknown = undefined;
  const agentService = {
    async runTask(request: Record<string, any>) {
      payloads.push(request);
      const report = request.validateOutput({ output_content: outputContent });
      if (report.issues.length) throw Object.assign(new Error('submission blocked'), { report });
      return { validation_result: report.value };
    },
    updatePersistentTask() {},
  };
  const workspaceStore = {
    loadTechnicalPlan: () => structuredClone(plan),
    readTenderMarkdown: () => fake.workingCopy,
    readTenderSourceMarkdown: (id: string) => TENDERS.find((file) => file.id === id)?.markdown ?? '',
    readOriginalPlanMarkdown: () => fake.originalPlan,
  };
  const knowledgeBaseService = {
    readReferences: (ids: string[]) =>
      ids.map((id) => ({
        document: { id },
        items: fake.knowledge.filter((item) => item.documentId === id).map((item) => ({ id: item.itemId, title: item.title, resume: item.resume, content: item.content })),
      })),
  };
  let error: unknown = null;
  try {
    await desktopTask.runGlobalFactsTaskV2({
      agentService,
      workspaceStore,
      knowledgeBaseService,
      updateTask: (task: { logs?: string[] }) => {
        if (task.logs) logs.splice(0, logs.length, ...task.logs);
        return task;
      },
      checkpointTask: (task: { logs?: string[] }, patch: Record<string, unknown> = {}) => {
        if (task.logs) logs.splice(0, logs.length, ...task.logs);
        if ('globalFacts' in patch) saved = structuredClone(patch.globalFacts);
        return { task: { task_id: 'task-1', ...task } };
      },
      taskControl: { signal: new AbortController().signal },
      payload,
    });
  } catch (caught) {
    error = caught;
  }
  return { payload: payloads[0]!, saved, logs, error };
}

// ---- 服务端（假 AgentRun） ----

interface FakeRunOptions {
  output?: string | null;
  resumed?: boolean;
  taskCheckpoint?: Record<string, unknown> | null;
  promptedStage?: string | null;
  unavailable?: string[];
  tooLarge?: boolean;
}

interface FakeRun {
  written: { group: string; files: { path: string; content: string }[]; options: unknown }[];
  stages: AgentStageOptions<unknown>[];
  reports: { value: unknown; issues: readonly { severity: string; message: string }[] }[];
  checkpoints: (Record<string, unknown> | null)[];
  closed: boolean;
}

function fakeAgent(options: FakeRunOptions): { agent: JobAgent; record: FakeRun } {
  const record: FakeRun = { written: [], stages: [], reports: [], checkpoints: [], closed: false };
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
      record.reports.push(report as FakeRun['reports'][number]);
      // 真实的 runStage 在有阻塞问题时退回修复、最终以 AGENT_SUBMISSION_FAILED 停止；这里直接停止。
      if (report.issues.some((issue) => issue.severity === 'blocking')) throw new JobError('AGENT_SUBMISSION_FAILED', 'blocked');
      return { value: report.value, acceptedIssues: report.issues, repairs: 0, executionRetries: 0 };
    },
    async close() {
      record.closed = true;
    },
  };
  return { agent: { template: 'agent', resuming: run.resumed, open: async () => run as unknown as AgentRun }, record };
}

const job = createTechnicalPlanJobs().find((item) => item.type === GLOBAL_FACTS_JOB_TYPE)! as JobTypeDefinition<any>;

async function runServer(agent: JobAgent | null) {
  const logs: string[] = [];
  const progress: number[] = [];
  const context: JobContext<any> = {
    jobId: 'job-1',
    projectId: 'project-1',
    type: GLOBAL_FACTS_JOB_TYPE,
    attempt: 1,
    params: job.parseParams({}),
    checkpoint: null,
    tenant: { orgId: 'org-1', userId: 'user-1', role: 'owner' },
    db: null as never,
    signal: new AbortController().signal,
    async setProgress(value) {
      progress.push(value);
    },
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
    return { logs, progress, error: null as unknown };
  } catch (error) {
    return { logs, progress, error };
  }
}

const textOf = (files: { path: string; content: string }[]) => files.map((file) => ({ path: file.path, content: file.content }));
const WORKSPACE = SANDBOX_TEMPLATES.agent.output;

beforeEach(() => {
  fake.state = baseState();
  fake.tenderFiles = TENDERS.map((file) => ({ fileName: file.fileName, markdown: file.markdown }));
  fake.workingCopy = '# 第一标段\n\n平台软件，工期 120 天。';
  fake.originalPlan = '';
  fake.knowledge = structuredClone(KNOWLEDGE);
  fake.signature = 'sig-1';
  fake.writeSignature = null;
  fake.saved = [];
  fake.reads = [];
});

describe('全局事实生成（与桌面版 globalFactsTaskV2.cjs 对照）', () => {
  it('多份招标文件 + 知识库：工作区材料、提示词、Schema、阶段与工具和桌面版相同；材料登记为受保护文件；写入的全局事实与日志相同', async () => {
    const desktop = await runDesktop(fake.state, VALID_OUTPUT);
    expect(desktop.error).toBeNull();
    const { agent, record } = fakeAgent({ output: VALID_OUTPUT });
    const server = await runServer(agent);
    expect(server.error).toBeNull();

    expect(record.written).toHaveLength(1);
    expect(record.written[0]!.group).toBe('input');
    expect(record.written[0]!.options).toMatchObject({ replace: true });
    expect(textOf(record.written[0]!.files)).toEqual(textOf(desktop.payload.files));
    expect(record.written[0]!.files.map((file) => file.path)).toEqual([
      '招标文件/招标文件-01-招标文件（正文）.docx.md',
      '招标文件/招标文件-02-技术规范书.pdf.md',
      '项目概述.md',
      '招标解析结果.md',
      '技术方案目录.md',
      '参考知识库/条目-1.md',
      '参考知识库/条目-2.md',
      '材料说明.md',
    ]);
    for (const file of record.written[0]!.files) expect(() => validateRelativePath(file.path, WORKSPACE, false)).not.toThrow();

    const stage = record.stages[0]!;
    expect(stage.prompt).toBe(desktop.payload.prompt);
    expect(stage.stage).toBe(desktop.payload.initial_stage);
    expect(stage.stageIndex).toBe(desktop.payload.initial_stage_index);
    expect(stage.outputFile).toBe(desktop.payload.output_file);
    expect(stage.maxExecutionRetries).toBe(desktop.payload.max_retries);
    expect(stage.jsonSchemas).toEqual(desktop.payload.json_validation_schemas);
    expect(GLOBAL_FACTS_JSON_SCHEMA).toEqual(desktopTask.GLOBAL_FACTS_JSON_SCHEMA);
    expect(GLOBAL_FACTS_OUTPUT_FILE).toBe(desktopTask.GLOBAL_FACTS_OUTPUT_FILE);
    expect(stage.tools).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'json-validation', 'ask-user', 'request-termination']);
    expect(record.checkpoints).toEqual([{ signature: 'sig-1' }]);
    expect(record.closed).toBe(true);
    expect(fake.reads).toEqual([{ tenders: true }]);

    expect(fake.saved).toEqual([{ groups: desktop.saved, signature: 'sig-1' }]);
    expect(desktop.saved).toEqual([
      { id: 'project_team', title: '项目角色 变量', content: '- 项目经理：张伟。' },
      { id: 'project_team_2', title: '工期变量', content: '- 工期：180 日历天。' },
      { id: 'fact_004', title: '运维变量', content: '- 7×24 小时响应。' },
    ]);
    // 桌面版的日志（不含 Agent 活动的进度标题，Web 版不转发）。
    expect(server.logs).toEqual(desktop.logs);
    expect(server.logs).toEqual([
      '开始生成全局事实变量。',
      '已读取 2 条知识库完整条目。',
      '正在准备全局事实工作区材料。',
      'Agent 正在整理全局事实变量。',
      '全局事实变量整理完成：3 个大项。',
      '全局事实变量生成完成。',
    ]);
    expect(server.progress).toEqual([5, 14, 14, 18, 95]);
  });

  it('三种缺值写法的提示词与桌面版相同；没有引用知识库、只有一份招标文件时材料与日志相同', async () => {
    fake.tenderFiles = fake.tenderFiles.slice(0, 1);
    for (const mode of ['fabricate', 'omit', 'placeholder']) {
      fake.state = baseState({ globalFactsMode: mode, referenceKnowledgeDocumentIds: [], tenderFiles: baseState().tenderFiles.slice(0, 1) });
      fake.saved = [];
      const desktop = await runDesktop(fake.state, VALID_OUTPUT, { globalFactsMode: mode });
      expect(desktop.error).toBeNull();
      const { agent, record } = fakeAgent({ output: VALID_OUTPUT });
      const server = await runServer(agent);
      expect(server.error).toBeNull();
      expect(record.stages[0]!.prompt).toBe(desktop.payload.prompt);
      expect(textOf(record.written[0]!.files)).toEqual(textOf(desktop.payload.files));
      expect(server.logs).toEqual(desktop.logs);
      expect(server.logs[1]).toBe('未选择参考知识库。');
      expect(server.progress.slice(0, 3)).toEqual([5, 8, 12]);
    }
  });

  it('多标段且选择了投标范围：只放入按投标范围裁剪的正文与标段说明；有原方案时放入原方案；与桌面版相同', async () => {
    fake.originalPlan = '\n# 原方案\n\n项目经理：李工。\n';
    fake.state = baseState({
      bidSectionMode: 'multiple',
      bidSections: SECTIONS,
      selectedSection: { id: 's1', title: SECTIONS[0]!.title },
      originalPlanFile: { id: 'p1', fileName: '原方案.docx', status: 'success', markdownArtifactId: 'a-p1' },
    });
    const desktop = await runDesktop(fake.state, VALID_OUTPUT);
    expect(desktop.error).toBeNull();
    const { agent, record } = fakeAgent({ output: VALID_OUTPUT });
    expect((await runServer(agent)).error).toBeNull();
    expect(textOf(record.written[0]!.files)).toEqual(textOf(desktop.payload.files));
    expect(record.written[0]!.files.map((file) => file.path)).toEqual([
      '招标文件/招标文件-当前投标范围.md',
      '项目概述.md',
      '招标解析结果.md',
      '技术方案目录.md',
      '标段说明.md',
      '参考知识库/条目-1.md',
      '参考知识库/条目-2.md',
      '原方案.md',
      '材料说明.md',
    ]);
    expect(record.stages[0]!.prompt).toBe(desktop.payload.prompt);
    expect(fake.reads).toEqual([{ tenders: false }]);

    // 选择的标段已不在识别结果中：与桌面版相同用不带标段信息的说明。
    fake.state.selectedSection = { id: 'gone', title: '已失效' };
    const stale = await runDesktop(fake.state, VALID_OUTPUT);
    const again = fakeAgent({ output: VALID_OUTPUT });
    expect((await runServer(again.agent)).error).toBeNull();
    expect(textOf(again.record.written[0]!.files)).toEqual(textOf(stale.payload.files));
  });

  it('多标段但还没有选择投标范围、或单标段时留有投标范围：与桌面版相同按各招标文件的原文', async () => {
    for (const overrides of [
      { bidSectionMode: 'multiple', bidSections: SECTIONS },
      { bidSectionMode: 'single', bidSections: SECTIONS, selectedSection: { id: 's1', title: SECTIONS[0]!.title } },
    ]) {
      fake.state = baseState(overrides);
      fake.reads = [];
      const desktop = await runDesktop(fake.state, VALID_OUTPUT);
      const { agent, record } = fakeAgent({ output: VALID_OUTPUT });
      expect((await runServer(agent)).error).toBeNull();
      expect(textOf(record.written[0]!.files)).toEqual(textOf(desktop.payload.files));
      expect(fake.reads).toEqual([{ tenders: true }]);
    }
  });

  it('招标文件名不符合 agent 工作区的路径规则时：不允许的字符换成 _、按 UTF-8 字节截短，仍不符合时只用序号；符合时与桌面版相同', () => {
    expect(tenderWorkspacePath('招标文件（正文）.docx', 0)).toBe('招标文件/招标文件-01-招标文件（正文）.docx.md');
    const cases = ['某市 智慧水务 招标文件.docx', `${'很长的文件名'.repeat(20)}.pdf`, '…；！@#.docx', '​零宽.docx', 'é.docx', '', '   ', '.hidden'];
    const paths = cases.map((name, index) => tenderWorkspacePath(name, index));
    for (const path of paths) expect(() => validateRelativePath(path, WORKSPACE, false)).not.toThrow();
    expect(paths[0]).toBe('招标文件/招标文件-01-某市_智慧水务_招标文件.docx.md');
    expect(Buffer.byteLength(paths[1]!.split('/')[1]!, 'utf8')).toBeLessThanOrEqual(100);
    expect(paths[1]!.startsWith('招标文件/招标文件-02-很长的文件名')).toBe(true);
    expect(paths[5]).toBe('招标文件/招标文件-06-招标文件6.md');
    expect(paths[6]).toBe('招标文件/招标文件-07-招标文件7.md');
  });

  it('提交校验与桌面版 validateGlobalFactsOutput 相同：Schema 错误、整理后没有可用分组；不是合法 JSON 时说明不附解析器的错误信息', () => {
    const inputs = [
      VALID_OUTPUT,
      '{}',
      '[]',
      '"text"',
      JSON.stringify({ groups: [] }),
      JSON.stringify({ groups: [{ id: '', title: 1, content: null, extra: true }], other: 1 }),
      JSON.stringify({ groups: [{ id: 'a', title: '  ', content: 'x' }, { id: 'b', title: 't', content: ' \n ' }] }),
      JSON.stringify({ groups: 'x' }),
      JSON.stringify({ groups: [null, 'x', { id: 'a' }] }),
    ];
    for (const input of inputs) {
      const server = validateGlobalFactsOutput(input);
      const desktop = desktopTask.validateGlobalFactsOutput(input);
      expect(server.issues.map(({ severity, message }) => ({ severity, message }))).toEqual(desktop.issues.map(({ severity, message }) => ({ severity, message })));
      if (!desktop.issues.length) expect(server.value).toEqual((desktop.value as { groups: unknown }).groups);
      else expect(server.value).toBeNull();
    }
    const secret = '{"groups": [ 注入的内容-ignore-previous';
    expect(desktopTask.validateGlobalFactsOutput(secret).issues[0]!.message).toMatch(/^global-facts\.json不是合法 JSON：/);
    expect(validateGlobalFactsOutput(secret).issues).toEqual([{ severity: 'blocking', message: 'global-facts.json不是合法 JSON' }]);
    expect(validateGlobalFactsOutput('').issues).toEqual([{ severity: 'blocking', message: 'global-facts.json不是合法 JSON' }]);
  });

  it('Schema 错误超过提交校验报告的上限时合并为最后一条；超过服务端的全局事实上限（100 组）时是阻塞问题（桌面版不限）', () => {
    const many = JSON.stringify({ groups: Array.from({ length: 150 }, () => ({ id: 1, title: 2, content: 3 })) });
    const desktop = desktopTask.validateGlobalFactsOutput(many);
    expect(desktop.issues.length).toBe(450);
    const server = validateGlobalFactsOutput(many);
    expect(server.issues).toHaveLength(AGENT_SUBMISSION_MAX_ISSUES);
    expect(server.issues.slice(0, -1)).toEqual(desktop.issues.slice(0, AGENT_SUBMISSION_MAX_ISSUES - 1).map(({ severity, message }) => ({ severity, message })));
    expect(server.issues.at(-1)).toEqual({ severity: 'blocking', message: `global-facts.json 另有 ${450 - AGENT_SUBMISSION_MAX_ISSUES + 1} 项格式错误` });

    const tooMany = JSON.stringify({ groups: Array.from({ length: 101 }, (_, i) => ({ id: `g${i}`, title: `组${i}`, content: '- 内容' })) });
    expect(desktopTask.validateGlobalFactsOutput(tooMany).issues).toEqual([]);
    expect(validateGlobalFactsOutput(tooMany)).toEqual({ value: null, issues: [{ severity: 'blocking', message: '全局事实最多 100 组' }] });
  });

  it('结果有阻塞问题时任务不写入；结果文件过大时是阻塞问题，文件不存在时按不是合法 JSON', async () => {
    for (const [options, message] of [
      [{ output: '{"groups": []}' }, 'global-facts.json 格式错误：/groups must NOT have fewer than 1 items'],
      [{ output: '{}', tooLarge: true }, 'global-facts.json过大，无法读取'],
      [{ output: null }, 'global-facts.json不是合法 JSON'],
    ] as const) {
      const { agent, record } = fakeAgent(options);
      const { error } = await runServer(agent);
      expect((error as JobError).code).toBe('AGENT_SUBMISSION_FAILED');
      expect(record.reports[0]!.issues).toEqual([{ severity: 'blocking', message }]);
    }
    expect(fake.saved).toEqual([]);
  });

  it('续跑：已发出阶段要求时只发“继续之前的任务”，不重新放入材料，写入用首次执行的签名；原件不可用时按同一输入重新放入', async () => {
    const resumed = fakeAgent({ output: VALID_OUTPUT, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: 'global-facts' });
    const first = await runServer(resumed.agent);
    expect(first.error).toBeNull();
    expect(resumed.record.written).toEqual([]);
    expect(resumed.record.stages[0]!.prompt).toBe('继续之前的任务');
    expect(first.logs[0]).toBe('Agent 继续整理全局事实变量。');
    expect(fake.saved.at(-1)!.signature).toBe('sig-1');

    const unavailable = fakeAgent({ output: VALID_OUTPUT, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: null, unavailable: ['项目概述.md'] });
    expect((await runServer(unavailable.agent)).error).toBeNull();
    expect(unavailable.record.written).toHaveLength(1);
    expect(unavailable.record.stages[0]!.prompt).not.toBe('继续之前的任务');
  });

  it('续跑时输入已变化、或写入时签名不符：任务以 TECHNICAL_PLAN_INPUT_CHANGED 失败，不写入', async () => {
    fake.signature = 'sig-2';
    const changed = fakeAgent({ output: VALID_OUTPUT, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: 'global-facts' });
    const resumedRun = await runServer(changed.agent);
    expect((resumedRun.error as JobError).code).toBe('TECHNICAL_PLAN_INPUT_CHANGED');
    expect(changed.record.stages).toEqual([]);
    expect(changed.record.closed).toBe(true);

    fake.signature = 'sig-1';
    fake.writeSignature = 'sig-3';
    const { agent } = fakeAgent({ output: VALID_OUTPUT });
    const written = await runServer(agent);
    expect((written.error as JobError).code).toBe('TECHNICAL_PLAN_INPUT_CHANGED');
    expect((written.error as JobError).message).toBe('招标文件、解析结果、目录或全局事实已变化，本次结果已丢弃，请重新开始');
    expect(fake.saved).toEqual([]);
  });

  it('开始时的检查：没有招标文件 / 招标正文为空 / 没有目录 / 原方案正文为空时与桌面版的说明相同；原方案未解析完成或失败时不开始；Agent 不可用', async () => {
    const check = async (state: Record<string, any>, code: string, message: string, desktopState: Record<string, any> | null = state) => {
      fake.state = state;
      if (desktopState) expect(((await runDesktop(desktopState, VALID_OUTPUT)).error as Error).message).toBe(message);
      const { agent, record } = fakeAgent({ output: VALID_OUTPUT });
      const { error } = await runServer(agent);
      expect(error).toBeInstanceOf(JobError);
      expect((error as JobError).code).toBe(code);
      expect((error as JobError).message).toBe(message);
      expect(record.stages).toEqual([]);
    };
    // 没有招标文件时合并的正文同样为空（桌面版回退到 tender.md）。
    fake.workingCopy = '';
    await check(baseState({ tenderFiles: [] }), 'TECHNICAL_PLAN_TENDER_MISSING', '请先上传招标文件，再生成全局事实');
    fake.tenderFiles = [{ fileName: '空.docx', markdown: '  \n' }];
    await check(baseState(), 'TECHNICAL_PLAN_TENDER_EMPTY', '请先上传招标文件，再生成全局事实', null);
    fake.tenderFiles = TENDERS.map((file) => ({ fileName: file.fileName, markdown: file.markdown }));
    await check(baseState({ outlineData: null }), 'TECHNICAL_PLAN_OUTLINE_REQUIRED', '请先生成目录，再生成全局事实');
    await check(baseState({ outlineData: { outline: [] } }), 'TECHNICAL_PLAN_OUTLINE_REQUIRED', '请先生成目录，再生成全局事实');
    fake.originalPlan = ' \n';
    await check(
      baseState({ originalPlanFile: { id: 'p1', fileName: '原方案.docx', status: 'success', markdownArtifactId: 'a-p1' } }),
      'TECHNICAL_PLAN_ORIGINAL_PLAN_REQUIRED',
      '请先上传原方案，再生成全局事实',
    );
    await check(baseState({ originalPlanFile: { id: 'p1', status: 'pending', markdownArtifactId: null } }), 'TECHNICAL_PLAN_ORIGINAL_PLAN_NOT_READY', '原方案尚未解析完成，请稍后再试', null);
    await check(baseState({ originalPlanFile: { id: 'p1', status: 'error', markdownArtifactId: null } }), 'TECHNICAL_PLAN_ORIGINAL_PLAN_FAILED', '原方案解析失败，请移除后重新上传', null);
    await check(baseState({ tenderFiles: [{ id: 'f1', fileName: 'a', status: 'running', markdownArtifactId: null }] }), 'TECHNICAL_PLAN_DOCUMENT_NOT_READY', '招标文件尚未全部解析完成，请稍后再试', null);
    expect(fake.saved).toEqual([]);

    fake.state = baseState();
    expect(((await runServer(null)).error as JobError).code).toBe('AGENT_UNAVAILABLE');
  });

  it('任务参数只接受空对象（全局事实的写法取已保存的生成配置）', () => {
    expect(job.parseParams({})).toEqual({});
    expect(() => job.parseParams({ globalFactsMode: 'omit' })).toThrow(TypeError);
    expect(() => job.parseParams(null)).toThrow(TypeError);
  });
});
