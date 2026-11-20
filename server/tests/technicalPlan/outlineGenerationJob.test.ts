// 技术方案目录生成的一级目录与确认（路线图第 8 步 8.7e1，src/technicalPlan/jobs.ts 的 outline-generation、outlineAgent.ts）与桌面版
// outlineGenerationTaskV2.cjs（runOutlineGenerationTaskV2 的一级目录阶段、waitForOutlineSelection 之后无需 AI 扩展的整理）、taskService.cjs
// （确认）的对照：Store 换成内存实现（vi.mock），Agent 换成脚本化的假 AgentRun（记下放入工作区的文件、阶段的请求与检查点，按脚本给出
// outline.json），桌面版的 agentService.runTask 用同一份文件调用它自己的 validateOutput / continueTask。比较放入的材料、提示词、预置 Schema、
// 结果文件、阶段与工具、提交校验的问题清单、写回的 outline.json、待确认的一级目录与默认选择（三种组织方式）、确认后写入的目录、字数控制
// 与日志。另覆盖：开始时的检查（文案与桌面版相同）、无技术评分项与只按原方案的材料、知识库、确认前被继续时再次等待、需要 AI 扩展时失败
// （8.7e2 之前）、输入已变化、确认的校验、服务端新增的一级目录上限、isMissingTechnicalScoreItems。
// 数据库、暂停与确认接口见 tests/db/technicalPlanOutlineGeneration.test.ts。
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOpenOptions, AgentRun, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import { JobError, JobSelectionRequiredError, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';

const fake = vi.hoisted(() => ({
  state: null as unknown as Record<string, any>,
  signature: 'sig-1',
  writeSignature: null as string | null,
  saved: [] as { input: any; signature: string }[],
  originalPlan: '',
  knowledge: [] as string[],
  knowledgeReads: 0,
  discarded: [] as unknown[],
}));

vi.mock('../../src/technicalPlan/store.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/technicalPlan/store.ts')>();
  return {
    ...original,
    outlineGenerationInputSignature: async () => fake.signature,
    loadTechnicalPlan: async () => structuredClone(fake.state),
    readGlobalFactsSources: async () => ({ tenderFiles: [], originalPlanMarkdown: fake.originalPlan }),
    readOutlineKnowledgeMarkdowns: async () => {
      fake.knowledgeReads += 1;
      return [...fake.knowledge];
    },
    saveOutlineGenerationResult: async (_db: unknown, _context: unknown, _projectId: string, input: unknown, signature: string) => {
      if (signature !== (fake.writeSignature ?? fake.signature)) return false;
      fake.saved.push({ input: structuredClone(input), signature });
      return true;
    },
  };
});

vi.mock('../../src/agent/workspaceJob.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/agent/workspaceJob.ts')>();
  return {
    ...original,
    discardAgentWorkspaceSnapshots: async (_db: unknown, _context: unknown, _store: unknown, projectId: string, kinds: unknown) => {
      fake.discarded.push({ projectId, kinds });
    },
  };
});

const { createTechnicalPlanJobs, OUTLINE_GENERATION_JOB_TYPE, OUTLINE_STAGE_UNAVAILABLE_CODE } = await import('../../src/technicalPlan/jobs.ts');
const outlineAgent = await import('../../src/technicalPlan/outlineAgent.ts');
const { applyOutlineSelection, isMissingTechnicalScoreItems, OUTLINE_JSON_SCHEMA, OutlineSelectionInputError, validateInitialOutlineOutput } = outlineAgent;

// 桌面版依赖 client/ 的 ajv（CI 的 server 任务不安装 client/ 的依赖）：换成 server/ 中同一版本（8.20.0）的 ajv，其余模块用桌面版原文件。
const require = createRequire(import.meta.url);
function loadDesktop(path: string): any {
  const Module = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = Module._load;
  const ajv = require('ajv') as unknown;
  Module._load = function load(request: string, parent: unknown, isMain: boolean) {
    if (request === 'ajv') return ajv;
    return original.call(this, request, parent, isMain);
  };
  try {
    return require(path);
  } finally {
    Module._load = original;
  }
}
const desktop = loadDesktop('../../../client/electron/services/outlineGenerationTaskV2.cjs') as {
  runOutlineGenerationTaskV2(options: Record<string, unknown>): Promise<void>;
  isMissingTechnicalScoreItems(content: string): boolean;
  validateOutlineOutput(content: string, knownIds?: Set<string>, options?: { checkSchema?: boolean }): { value: any; issues: { severity: string; message: string }[] };
  OUTLINE_JSON_SCHEMA: unknown;
};

// ---- 输入 ----

const TECH_REQUIREMENTS = '## 技术评分项\n1. 总体设计（10 分）\n2. 实施方案（20 分）';
const NO_TECH_SCORE = '## 技术评分项\n没有提及\n## 商务评分项\n业绩 5 分';
const RESPONSE_FILE = '投标文件由投标函、技术方案、商务文件、报价组成。';
const OVERVIEW = '某市智慧水务平台建设。';
const ORIGINAL_PLAN = '# 原方案\n## 一、总体设计\n## 二、实施计划';

function baseState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    step: 'outline-generation',
    bidAnalysisTasks: {
      techRequirements: { id: 'techRequirements', status: 'success', content: TECH_REQUIREMENTS },
      responseFileRequirements: { id: 'responseFileRequirements', status: 'success', content: RESPONSE_FILE },
    },
    techRequirements: TECH_REQUIREMENTS,
    projectOverview: OVERVIEW,
    originalPlanFile: null,
    outlineMode: 'response-file',
    outlineExpansionMode: 'ai-complement',
    outlineWordControlOptions: { minimumWords: 30000, maximumWords: 50000, sectionWords: 3000 },
    referenceKnowledgeDocumentIds: [],
    outlineData: null,
    ...overrides,
  };
}

/** 桌面版 storedPlan（与 baseState 同一份输入）。 */
function storedPlanOf(state: Record<string, any>): Record<string, unknown> {
  return {
    techRequirements: state.techRequirements,
    projectOverview: state.projectOverview,
    bidAnalysisTasks: state.bidAnalysisTasks,
    outlineMode: state.outlineMode,
    outlineExpansionMode: state.outlineExpansionMode,
    outlineWordControlOptions: state.outlineWordControlOptions,
    referenceKnowledgeDocumentIds: state.referenceKnowledgeDocumentIds,
    ...(state.originalPlanFile ? { originalPlanFile: { name: '原方案.docx' } } : {}),
  };
}

/** Agent 写出的一级目录：投标文件目录、技术方案、商务文件（other 带说明）、报价。 */
const INITIAL = JSON.stringify({
  outline: [
    { id: null, title: ' 投标文件目录 ', description: '目录', attr: '目录', content_mode: 'directory-generate' },
    { id: null, title: '技术方案', description: '技术响应', attr: '技术', content_mode: 'ai-generate' },
    { id: null, title: '商务文件', description: '商务响应', attr: '其他', content_mode: 'other', content_mode_note: ' 按招标文件格式 ' },
    { id: null, title: '投标报价', description: '报价表', attr: '报价', content_mode: 'manual-fill' },
  ],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 程序分配的 id 换成按出现顺序的占位（两边各自随机分配）。 */
function placeholders(value: unknown): unknown {
  const ids = new Map<string, string>();
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item === 'string' && UUID.test(item)) {
      if (!ids.has(item)) ids.set(item, `<id${ids.size + 1}>`);
      return ids.get(item);
    }
    if (typeof item !== 'object' || item === null) return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
  };
  return visit(value);
}

function comparable(report: { value: unknown; issues: readonly { severity: string; message: string }[] }) {
  return {
    value: report.issues.length ? null : placeholders(report.value),
    issues: report.issues.map(({ severity, message }) => ({ severity, message: message.replace(/^(outline\.json不是合法 JSON)：.*$/s, '$1') })),
  };
}

// ---- 桌面版 ----

interface DesktopRun {
  payloads: Record<string, any>[];
  reports: { value: unknown; issues: { severity: string; message: string }[] }[];
  writes: { path: string; content: string }[][];
  selection: Record<string, any> | null;
  finished: { task: Record<string, any>; workspace: Record<string, any> } | null;
  error: unknown;
}

/**
 * 运行桌面版：一级目录阶段的 runTask 用给出的 outline.json 调用它自己的 validateOutput / continueTask；confirm 给出时按它确认（items 与
 * selectedIds 由测试按服务端的结果给出，两边的 id 相同），否则在等待确认处停下。
 */
async function runDesktop(
  state: Record<string, any>,
  outputContent: string,
  options: { confirm?: (selection: Record<string, any>) => { items: unknown[]; selectedIds: string[] }; payload?: Record<string, unknown>; knowledge?: string[] } = {},
): Promise<DesktopRun> {
  const result: DesktopRun = { payloads: [], reports: [], writes: [], selection: null, finished: null, error: null };
  const agentService = {
    updatePersistentTask() {},
    async runTask(payload: Record<string, any>) {
      result.payloads.push(payload);
      if (payload.initial_stage !== 'initial-outline') throw new Error('desktop stage not scripted');
      const report = payload.validateOutput({ output_content: outputContent });
      result.reports.push(report);
      if (report.issues.length) throw Object.assign(new Error('submission blocked'), { report });
      await payload.continueTask({}, { validation_result: report.value, writeFiles: async (files: { path: string; content: string }[]) => result.writes.push(files) });
      return { validation_result: report.value };
    },
  };
  let task: Record<string, any> = { task_id: 'desktop-task' };
  try {
    await desktop.runOutlineGenerationTaskV2({
      agentService,
      ordinaryAgentService: { forkPersistentTask: async () => {} },
      workspaceStore: {
        loadTechnicalPlan: () => storedPlanOf(state),
        readOriginalPlanMarkdown: () => fake.originalPlan,
        listTenderSourceDocxRelativePaths: () => [],
        clearBidTemplate() {},
        hasBidTemplate: () => false,
      },
      knowledgeBaseService: {
        readReferences: (ids: string[], readOptions: Record<string, unknown>) => {
          expect(readOptions).toEqual({ includeMarkdown: true, includeItems: false });
          return ids.map((_id, index) => ({ markdown: options.knowledge?.[index] ?? '' }));
        },
      },
      openXmlHelperService: null,
      updateTask: (partial: Record<string, any>) => {
        task = { ...task, ...partial };
        return task;
      },
      checkpointTask: (partial: Record<string, any>, workspace: Record<string, any> = {}) => {
        task = { ...task, ...partial };
        if (partial.stats?.outline_selection) result.selection = structuredClone(partial.stats.outline_selection);
        if (partial.status === 'success') result.finished = { task: structuredClone(task), workspace: structuredClone(workspace) };
        return { task };
      },
      taskControl: {
        signal: new AbortController().signal,
        waitForOutlineSelection: async () => {
          if (!options.confirm) throw new Error('waiting for selection');
          return options.confirm(result.selection!);
        },
      },
      payload: { outline_mode: state.outlineMode, word_control_options: state.outlineWordControlOptions, ...(options.payload ?? {}) },
    });
  } catch (error) {
    result.error = error;
  }
  return result;
}

// ---- 服务端（假 AgentRun） ----

interface FakeRun {
  opened: number;
  written: { group: string; files: { path: string; content: string }[]; options: unknown }[];
  released: { group: string; paths: readonly string[] }[];
  stages: AgentStageOptions<unknown>[];
  reports: { value: unknown; issues: readonly { severity: string; message: string }[] }[];
  checkpoints: { after: Record<string, unknown> | null; explicit: { task: Record<string, unknown> | null; progress?: number }[] };
  closed: boolean;
}

function fakeAgent(options: { output?: string | null; resumed?: boolean; promptedStage?: string | null; unavailable?: string[] } = {}): { agent: JobAgent; record: FakeRun } {
  const record: FakeRun = { opened: 0, written: [], released: [], stages: [], reports: [], checkpoints: { after: null, explicit: [] }, closed: false };
  const resumed = options.resumed ?? false;
  const run = {
    sandbox: { id: 'sandbox-1' },
    resumed,
    continued: false,
    unavailableProtectedFiles: options.unavailable ?? [],
    taskCheckpoint: null,
    wasPrompted: (stage: string) => options.promptedStage === stage,
    baseline: {
      async write(_sandbox: unknown, group: string, files: { path: string; data: Buffer }[], writeOptions: unknown) {
        record.written.push({ group, files: files.map((file) => ({ path: file.path, content: file.data.toString('utf8') })), options: writeOptions });
      },
      release(group: string, paths: readonly string[]) {
        record.released.push({ group, paths: [...paths] });
        return [...paths];
      },
    },
    async readFiles(paths: readonly string[]) {
      const result = new Map<string, { size: number; data: Buffer | null }>();
      if (options.output !== null && options.output !== undefined) {
        const data = Buffer.from(options.output, 'utf8');
        result.set(paths[0]!, { size: data.length, data });
      }
      return result;
    },
    async runStage(stage: AgentStageOptions<unknown>) {
      record.stages.push(stage);
      record.checkpoints.after = stage.checkpointAfterPrompt?.() ?? null;
      const report = await stage.validate({ attempt: 1, restored: [] });
      record.reports.push(report as FakeRun['reports'][number]);
      if (report.issues.some((issue) => issue.severity === 'blocking')) throw new JobError('AGENT_SUBMISSION_FAILED', 'blocked');
      return { value: report.value, acceptedIssues: report.issues, repairs: 0, executionRetries: 0 };
    },
    async assistantText() {
      return null;
    },
    async checkpoint(task: Record<string, unknown> | null, progress?: number) {
      record.checkpoints.explicit.push({ task: structuredClone(task), ...(progress !== undefined ? { progress } : {}) });
    },
    async close() {
      record.closed = true;
    },
  };
  return {
    agent: {
      template: 'agent',
      resuming: resumed,
      open: async (_openOptions?: AgentOpenOptions) => {
        record.opened += 1;
        return run as unknown as AgentRun;
      },
    },
    record,
  };
}

const job = createTechnicalPlanJobs().find((item) => item.type === OUTLINE_GENERATION_JOB_TYPE)! as JobTypeDefinition<any>;

async function runServer(agent: JobAgent | null, options: { checkpoint?: Record<string, unknown> | null; noTechnicalScoreMode?: boolean } = {}) {
  const logs: string[] = [];
  const progress: number[] = [];
  const context: JobContext<any> = {
    jobId: 'job-1',
    projectId: 'project-1',
    type: job.type,
    attempt: 1,
    params: job.parseParams({ noTechnicalScoreMode: options.noTechnicalScoreMode ?? false }),
    checkpoint: options.checkpoint ?? null,
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

/** 运行服务端的一级目录阶段，返回等待确认时写下的 checkpoint 中任务自己的状态。 */
async function generateServer(output = INITIAL, noTechnicalScoreMode = false) {
  const { agent, record } = fakeAgent({ output });
  const server = await runServer(agent, { noTechnicalScoreMode });
  return { server, record, task: record.checkpoints.explicit.at(-1)?.task as Record<string, any> | undefined };
}

const AGENT_STATE = { version: 1, session: 's.jsonl', stage: 'initial-outline', stageIndex: 0, promptedStage: 'initial-outline', compactionPending: null, baseline: { version: 1, groups: {} }, snapshot: null };

beforeEach(() => {
  fake.state = baseState();
  fake.signature = 'sig-1';
  fake.writeSignature = null;
  fake.saved = [];
  fake.originalPlan = '';
  fake.knowledge = [];
  fake.knowledgeReads = 0;
  fake.discarded = [];
});

describe('目录生成：一级目录阶段（与桌面版 runOutlineGenerationTaskV2 对照）', () => {
  it('材料、提示词、阶段、结果文件、工具、预置 Schema、提交校验、写回的 outline.json、待确认的一级目录与默认选择和桌面版相同；暂停等待确认', async () => {
    const desktopRun = await runDesktop(fake.state, INITIAL);
    expect(desktopRun.error).toMatchObject({ message: 'waiting for selection' });
    const { server, record, task } = await generateServer();
    expect(server.error).toBeInstanceOf(JobSelectionRequiredError);
    const payload = desktopRun.payloads[0]!;

    // 材料（受保护文件）与预置的空 outline.json（交给 Agent 写入，解除登记）。
    expect(record.written[0]!.group).toBe('outline-generation-inputs');
    expect(record.written[0]!.options).toMatchObject({ replace: true });
    expect(record.written[0]!.files).toEqual(payload.files);
    expect(payload.files.map((file: { path: string }) => file.path)).toEqual(['响应文件要求.md', '项目概述.md']);
    expect(record.written[1]).toMatchObject({ group: 'outline-output', files: [{ path: 'outline.json', content: '' }] });
    expect(payload.prepare_output_files).toEqual(['outline.json']);
    expect(record.released[0]).toEqual({ group: 'outline-output', paths: ['outline.json'] });

    const stage = record.stages[0]!;
    expect(stage.prompt).toBe(payload.prompt);
    expect(stage.stage).toBe(payload.initial_stage);
    expect(stage.stageIndex).toBe(payload.initial_stage_index);
    expect(stage.outputFile).toBe(payload.output_file);
    expect(stage.maxExecutionRetries).toBe(payload.max_retries);
    // 执行失败不重试（桌面版 buildRetryPrompt 对 execution 返回 null）；提交修复的说明与桌面版相同。
    expect(await stage.retryPrompt!({ reason: 'x', attempt: 1, maxRetries: 1 })).toBeNull();
    expect(await payload.buildRetryPrompt({ kind: 'execution' }, { workflow_stage: 'initial-outline' })).toBeNull();
    expect(await stage.repairPrompt!({ report: { value: null, issues: [] }, mode: 'normal', attempt: 1 })).toBe(
      await payload.buildRetryPrompt({ kind: 'submission' }, { workflow_stage: 'initial-outline' }),
    );
    // 一级目录阶段只预置 outline.json 的 Schema（桌面版一次预置全部阶段的，其余随 8.7e2）。
    expect(stage.jsonSchemas).toEqual({ 'outline.json': payload.json_validation_schemas['outline.json'] });
    expect(OUTLINE_JSON_SCHEMA).toEqual(desktop.OUTLINE_JSON_SCHEMA);
    expect(stage.tools).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'json-validation', 'ask-user', 'request-termination']);
    expect(record.reports.map(comparable)).toEqual(desktopRun.reports.map(comparable));
    expect(record.checkpoints.after).toEqual({ signature: 'sig-1' });

    // 写回的 outline.json（分配了 id、编号）与桌面版 continueTask 相同。
    const writtenBack = JSON.parse(record.written[2]!.files[0]!.content);
    expect(placeholders(writtenBack)).toEqual(placeholders(JSON.parse(desktopRun.writes[0]![0]!.content)));
    expect(record.released[1]).toEqual({ group: 'outline-output', paths: ['outline.json'] });

    // 待确认的一级目录与默认选择（响应文件模式：全部）。
    expect(record.checkpoints.explicit).toHaveLength(1);
    expect(record.checkpoints.explicit[0]!.progress).toBe(30);
    expect(task!.signature).toBe('sig-1');
    expect(placeholders(task!.selection)).toEqual(placeholders({ items: desktopRun.selection!.items, selectedIds: desktopRun.selection!.selected_ids }));
    expect(desktopRun.selection!.confirmed).toBe(false);
    expect(task!.selection.items).toEqual(writtenBack.outline);
    expect(record.closed).toBe(true);

    expect(server.logs).toEqual(['开始生成一级目录', '一级目录已生成，等待用户确认']);
    expect(fake.saved).toEqual([]);
  });

  it('默认选择：单独技术分册只选“技术”，单独商务分册只选模板填写、目录、报价（与桌面版相同）', async () => {
    for (const mode of ['standalone-technical', 'standalone-business'] as const) {
      fake.state = baseState({ outlineMode: mode });
      const desktopRun = await runDesktop(fake.state, INITIAL);
      const { task } = await generateServer();
      expect(placeholders(task!.selection)).toEqual(placeholders({ items: desktopRun.selection!.items, selectedIds: desktopRun.selection!.selected_ids }));
      expect(task!.selection.selectedIds).toHaveLength(mode === 'standalone-technical' ? 1 : 2);
    }
  });

  it('各模式的材料与提示词与桌面版相同：单独技术分册、原方案、只按原方案、无技术评分项（含知识库，空文档不放入）', async () => {
    const cases: { state: Record<string, unknown>; noTech?: boolean; knowledge?: string[]; paths: string[]; readsKnowledge: boolean }[] = [
      { state: { outlineMode: 'standalone-technical' }, paths: ['响应文件要求.md', '技术评分信息.md', '项目概述.md'], readsKnowledge: false },
      { state: { originalPlanFile: { status: 'success', markdownArtifactId: 'a1' } }, paths: ['响应文件要求.md', '项目概述.md', '原方案.md'], readsKnowledge: false },
      {
        state: { originalPlanFile: { status: 'success', markdownArtifactId: 'a1' }, outlineExpansionMode: 'original-only', referenceKnowledgeDocumentIds: ['d1'] },
        paths: ['原方案.md'],
        readsKnowledge: false,
      },
      {
        state: { techRequirements: NO_TECH_SCORE, bidAnalysisTasks: { ...baseState().bidAnalysisTasks, techRequirements: { status: 'success', content: NO_TECH_SCORE } }, referenceKnowledgeDocumentIds: ['d1', 'd2', 'd3'] },
        noTech: true,
        knowledge: ['# 知识一', '   ', '# 知识三'],
        paths: ['响应文件要求.md', '项目概述.md', '参考知识库/参考资料-1.md', '参考知识库/参考资料-3.md'],
        readsKnowledge: true,
      },
      {
        state: {
          techRequirements: NO_TECH_SCORE,
          bidAnalysisTasks: { ...baseState().bidAnalysisTasks, techRequirements: { status: 'success', content: NO_TECH_SCORE } },
          originalPlanFile: { status: 'success', markdownArtifactId: 'a1' },
          outlineMode: 'standalone-technical',
          referenceKnowledgeDocumentIds: ['d1'],
        },
        noTech: true,
        knowledge: ['# 知识一'],
        paths: ['响应文件要求.md', '项目概述.md', '原方案.md', '参考知识库/参考资料-1.md'],
        readsKnowledge: true,
      },
      {
        state: {
          techRequirements: NO_TECH_SCORE,
          bidAnalysisTasks: { ...baseState().bidAnalysisTasks, techRequirements: { status: 'success', content: NO_TECH_SCORE } },
          originalPlanFile: { status: 'success', markdownArtifactId: 'a1' },
          outlineExpansionMode: 'original-only',
          outlineMode: 'standalone-technical',
          referenceKnowledgeDocumentIds: ['d1'],
        },
        noTech: true,
        paths: ['原方案.md'],
        readsKnowledge: false,
      },
    ];
    for (const item of cases) {
      fake.state = baseState(item.state);
      fake.originalPlan = ORIGINAL_PLAN;
      fake.knowledge = item.knowledge ?? [];
      fake.knowledgeReads = 0;
      const desktopRun = await runDesktop(fake.state, INITIAL, { payload: { no_technical_score_mode: item.noTech === true }, knowledge: item.knowledge ?? [] });
      const { record, server } = await generateServer(INITIAL, item.noTech === true);
      expect(server.error).toBeInstanceOf(JobSelectionRequiredError);
      expect(record.written[0]!.files).toEqual(desktopRun.payloads[0]!.files);
      expect(record.written[0]!.files.map((file) => file.path)).toEqual(item.paths);
      expect(record.stages[0]!.prompt).toBe(desktopRun.payloads[0]!.prompt);
      expect(fake.knowledgeReads).toBe(item.readsKnowledge ? 1 : 0);
    }
  });

  it('开始时的检查与桌面版相同：技术评分要求未解析成功、技术评分项缺失而未确认无技术评分项模式；原方案未解析完成（Web 版新增）', async () => {
    const notParsed = baseState({ techRequirements: '', bidAnalysisTasks: { techRequirements: { status: 'error', content: '' } } });
    const noTech = baseState({ techRequirements: '未提取到', bidAnalysisTasks: { techRequirements: { status: 'success', content: '未提取到' } } });
    for (const state of [notParsed, noTech]) {
      fake.state = state;
      const desktopError = (await runDesktop(state, INITIAL)).error as Error;
      const { agent, record } = fakeAgent({ output: INITIAL });
      const server = await runServer(agent);
      expect(server.error).toBeInstanceOf(JobError);
      expect((server.error as JobError).message).toBe(desktopError.message);
      expect(record.opened).toBe(0);
    }
    fake.state = baseState({ originalPlanFile: { status: 'parsing', markdownArtifactId: null } });
    const pending = await runServer(fakeAgent({ output: INITIAL }).agent);
    expect(pending.error).toMatchObject({ code: 'TECHNICAL_PLAN_ORIGINAL_PLAN_NOT_READY' });
    fake.state = baseState({ originalPlanFile: { status: 'error', markdownArtifactId: null } });
    expect((await runServer(fakeAgent({ output: INITIAL }).agent)).error).toMatchObject({ code: 'TECHNICAL_PLAN_ORIGINAL_PLAN_FAILED' });
  });

  it('提交校验与桌面版 validateOutlineOutput 相同（空文件、不是 JSON、Schema、已有 id）；服务端另限一级目录数与大小', () => {
    const samples = [
      '',
      '{"outline":',
      JSON.stringify({ outline: [] }),
      JSON.stringify({ outline: [{ id: null, title: '技术', description: '说明', attr: '商务/资信', content_mode: 'ai-generate' }] }),
      JSON.stringify({ outline: [{ id: '0b3c1f0e-1d1c-4c1a-9a51-0a6b0b9f3b11', title: '技术', description: '说明', attr: '技术', content_mode: 'ai-generate' }] }),
      INITIAL,
    ];
    for (const sample of samples) expect(comparable(validateInitialOutlineOutput(sample))).toEqual(comparable(desktop.validateOutlineOutput(sample)));
    const many = JSON.stringify({ outline: Array.from({ length: 101 }, (_, index) => ({ id: null, title: `目录${index}`, description: '说明', attr: '技术', content_mode: 'ai-generate' })) });
    expect(desktop.validateOutlineOutput(many).issues).toEqual([]);
    expect(validateInitialOutlineOutput(many).issues).toEqual([{ severity: 'blocking', message: 'outline.json 超出限制：一级目录最多 100 项' }]);
    const long = JSON.stringify({ outline: Array.from({ length: 50 }, (_, index) => ({ id: null, title: `目录${index}`, description: '长'.repeat(1900), attr: '技术', content_mode: 'ai-generate' })) });
    expect(validateInitialOutlineOutput(long).issues).toEqual([{ severity: 'blocking', message: 'outline.json 超出限制：一级目录内容过长，请精简标题与说明' }]);
  });

  it('结果不可用时为阻塞问题、不暂停；续跑只发“继续之前的任务”、不覆盖材料与 outline.json，原件不可用时重新放入', async () => {
    const broken = fakeAgent({ output: '{"outline":' });
    const failed = await runServer(broken.agent);
    expect(failed.error).toMatchObject({ code: 'AGENT_SUBMISSION_FAILED' });
    expect(broken.record.checkpoints.explicit).toEqual([]);

    const resumed = fakeAgent({ output: INITIAL, resumed: true, promptedStage: 'initial-outline' });
    const server = await runServer(resumed.agent, { checkpoint: { agent: AGENT_STATE, task: { signature: 'sig-1' } } });
    expect(server.error).toBeInstanceOf(JobSelectionRequiredError);
    expect(resumed.record.stages[0]!.prompt).toBe('继续之前的任务');
    expect(resumed.record.written.map((item) => item.group)).toEqual(['outline-output']);
    expect(server.logs).toEqual(['一级目录已生成，等待用户确认']);

    const unavailable = fakeAgent({ output: INITIAL, resumed: true, unavailable: ['项目概述.md'] });
    await runServer(unavailable.agent, { checkpoint: { agent: AGENT_STATE, task: { signature: 'sig-1' } } });
    expect(unavailable.record.written[0]!.group).toBe('outline-generation-inputs');
    expect(unavailable.record.stages[0]!.prompt).not.toBe('继续之前的任务');
  });

  it('续跑时输入已变化即失败，不打开沙箱', async () => {
    const { agent, record } = fakeAgent({ output: INITIAL, resumed: true });
    const server = await runServer(agent, { checkpoint: { agent: AGENT_STATE, task: { signature: 'old-sig' } } });
    expect(server.error).toMatchObject({ code: 'TECHNICAL_PLAN_INPUT_CHANGED' });
    expect(record.opened).toBe(0);
  });

  it('isMissingTechnicalScoreItems 与桌面版相同', () => {
    for (const text of ['未提取到', ' 未提取到 ', NO_TECH_SCORE, TECH_REQUIREMENTS, '## 技术评分项\n没有提及', '## 技术评分项 \r\n 没有提及 \n# 其他', '## 技术评分项\n没有提及，详见附件', '']) {
      expect(isMissingTechnicalScoreItems(text)).toBe(desktop.isMissingTechnicalScoreItems(text));
    }
  });
});

describe('目录生成：一级目录确认之后', () => {
  /** 服务端生成后按 selectedIds / changes 确认，得到确认后的 checkpoint。 */
  async function confirmedCheckpoint(pick: (items: any[]) => { selectedIds: string[]; changes?: { id: string; attr?: string; contentMode?: string }[] }) {
    const { task } = await generateServer();
    const { selectedIds, changes } = pick(task!.selection.items);
    const confirmed = applyOutlineSelection(task!.selection.items, selectedIds, changes ?? []);
    return { task: task!, confirmed, checkpoint: { agent: AGENT_STATE, task: { ...task!, confirmed } } };
  }

  it('所选一级目录无需 AI 扩展：整理后写入的目录、项目概述、字数控制与日志和桌面版相同；不打开沙箱，丢弃全局事实的会话', async () => {
    // 选投标文件目录与报价，并把报价改为 other（桌面版确认对话框可以改属性与处理模式）。
    const { task, confirmed, checkpoint } = await confirmedCheckpoint((items) => ({
      selectedIds: [items[3].id, items[0].id],
      changes: [{ id: items[3].id, attr: '其他', contentMode: 'other' }],
    }));
    expect(confirmed.selectedIds).toEqual([task.selection.items[0].id, task.selection.items[3].id]);
    const desktopRun = await runDesktop(fake.state, INITIAL, { confirm: () => ({ items: confirmed.items, selectedIds: confirmed.selectedIds }) });
    expect(desktopRun.error).toBeNull();

    const { agent, record } = fakeAgent();
    const server = await runServer(agent, { checkpoint });
    expect(server.error).toBeNull();
    expect(record.opened).toBe(0);
    expect(fake.saved).toHaveLength(1);
    expect(fake.saved[0]!.signature).toBe('sig-1');
    const workspace = desktopRun.finished!.workspace;
    expect({ outline: fake.saved[0]!.input.outline, project_overview: fake.saved[0]!.input.projectOverview }).toEqual(workspace.outlineData);
    expect(fake.saved[0]!.input.wordControl).toEqual(workspace.outlineWordControlSnapshot);
    expect(workspace.outlineData.outline.map((item: { number: string }) => item.number)).toEqual(['1', '2']);
    expect(fake.discarded).toEqual([{ projectId: 'project-1', kinds: ['technical-plan-global-facts'] }]);

    // 两次执行的日志合起来与桌面版的相同。
    const generated = (await generateServer()).server.logs;
    expect([...generated, ...server.logs]).toEqual(desktopRun.finished!.task.logs);
  });

  it('所选一级目录需要 AI 扩展时失败（后续阶段随 8.7e2），不写入', async () => {
    const { checkpoint } = await confirmedCheckpoint((items) => ({ selectedIds: [items[1].id] }));
    const server = await runServer(fakeAgent().agent, { checkpoint });
    expect(server.error).toMatchObject({ code: OUTLINE_STAGE_UNAVAILABLE_CODE });
    expect(fake.saved).toEqual([]);
    // 把技术方案改为人工填写后不再需要 AI 扩展。
    const manual = await confirmedCheckpoint((items) => ({ selectedIds: [items[1].id], changes: [{ id: items[1].id, contentMode: 'manual-fill' }] }));
    expect((await runServer(fakeAgent().agent, { checkpoint: manual.checkpoint })).error).toBeNull();
  });

  it('已生成、尚未确认（确认前被继续）时再次等待确认，不打开沙箱、不重新生成', async () => {
    const { task } = await generateServer();
    const { agent, record } = fakeAgent({ resumed: true });
    const server = await runServer(agent, { checkpoint: { agent: AGENT_STATE, task } });
    expect(server.error).toBeInstanceOf(JobSelectionRequiredError);
    expect(record.opened).toBe(0);
  });

  it('确认后输入已变化（签名不符）时失败；写入时签名不符同样失败', async () => {
    const { checkpoint } = await confirmedCheckpoint((items) => ({ selectedIds: [items[0].id] }));
    fake.signature = 'sig-2';
    expect((await runServer(fakeAgent().agent, { checkpoint })).error).toMatchObject({ code: 'TECHNICAL_PLAN_INPUT_CHANGED' });
    fake.signature = 'sig-1';
    fake.writeSignature = 'sig-3';
    expect((await runServer(fakeAgent().agent, { checkpoint })).error).toMatchObject({ code: 'TECHNICAL_PLAN_INPUT_CHANGED' });
    expect(fake.saved).toEqual([]);
  });

  it('applyOutlineSelection：选择须非空、不重复、都已生成；修改只能改属性与处理模式（取值在列表中），改为非 other 时去掉说明；按原顺序', async () => {
    const { task } = await generateServer();
    const items = task!.selection.items as any[];
    const ids = items.map((item) => item.id);
    expect(() => applyOutlineSelection(items, [])).toThrow(OutlineSelectionInputError);
    expect(() => applyOutlineSelection(items, [ids[0], ids[0]])).toThrow('一级目录重复选择');
    expect(() => applyOutlineSelection(items, ['0b3c1f0e-1d1c-4c1a-9a51-0a6b0b9f3b11'])).toThrow('选择的一级目录不存在，请重新打开后再选择');
    expect(() => applyOutlineSelection(items, [1])).toThrow(OutlineSelectionInputError);
    expect(() => applyOutlineSelection(items, [ids[0]], [{ id: 'x' }])).toThrow('修改的一级目录不存在，请重新打开后再选择');
    expect(() => applyOutlineSelection(items, [ids[0]], [{ id: ids[0], attr: '其它' }])).toThrow('目录属性不合法');
    expect(() => applyOutlineSelection(items, [ids[0]], [{ id: ids[0], contentMode: 'ai' }])).toThrow('内容处理模式不合法');
    expect(() => applyOutlineSelection(items, [ids[0]], [{ id: ids[0] }, { id: ids[0] }])).toThrow(OutlineSelectionInputError);
    const result = applyOutlineSelection(items, [ids[2], ids[1]], [{ id: ids[2], contentMode: 'template-fill' }]);
    expect(result.selectedIds).toEqual([ids[1], ids[2]]);
    expect(items[2].content_mode_note).toBe('按招标文件格式');
    expect(result.items[2]).toEqual({ ...items[2], content_mode: 'template-fill', content_mode_note: undefined } as never);
    expect('content_mode_note' in result.items[2]!).toBe(false);
    expect(result.items[1]).toBe(items[1]);
  });
});
