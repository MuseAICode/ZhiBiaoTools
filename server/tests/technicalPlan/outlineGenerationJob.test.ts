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
  /** 已交给 Agent 的回答（按时间），findLatestConsumedAgentAnswer 返回最后一个。 */
  answers: [] as { selected_option: string }[],
  answerQueries: [] as unknown[],
}));

vi.mock('../../src/agent/questions.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/agent/questions.ts')>();
  return {
    ...original,
    agentQuestionClock: async () => '2026-11-20T00:00:00.000Z',
    findLatestConsumedAgentAnswer: async (_db: unknown, _tenant: unknown, jobId: string, since: string, options: unknown) => {
      fake.answerQueries.push({ jobId, since, options });
      const last = fake.answers.at(-1);
      return last ? { answered: true, answer: last.selected_option, selected_option: last.selected_option, is_custom: false } : null;
    },
  };
});

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

/** 后续阶段的一步：Agent 按本阶段放入的 outline.json 写出的目录、（审查阶段）outline-review.json 与本阶段中用户对 ask-user 的回答。 */
interface DirectoryStep {
  outline: (current: any) => unknown;
  review?: unknown;
  answer?: string;
}

const textOf = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

interface DesktopStage {
  stage: string;
  index: number;
  prompt: string;
  files: { path: string; content: string }[];
  prepare: string[];
}

interface DesktopRun {
  stages: DesktopStage[];
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
  options: {
    confirm?: (selection: Record<string, any>) => { items: unknown[]; selectedIds: string[] };
    payload?: Record<string, unknown>;
    knowledge?: string[];
    steps?: DirectoryStep[];
  } = {},
): Promise<DesktopRun> {
  const result: DesktopRun = { stages: [], payloads: [], reports: [], writes: [], selection: null, finished: null, error: null };
  const agentService = {
    updatePersistentTask() {},
    async runTask(payload: Record<string, any>) {
      result.payloads.push(payload);
      if (payload.initial_stage !== 'initial-outline') {
        // 后续阶段：与 piRuntimeService.runTask 相同，按 continueTask 返回的阶段接着执行（阶段序号每次加 1）。
        if (!options.steps) throw new Error('desktop stage not scripted');
        let stage = payload.initial_stage as string;
        let prompt = payload.prompt as string;
        let files = (payload.files ?? []) as { path: string; content: string }[];
        let prepare = (payload.prepare_output_files ?? []) as string[];
        let index = payload.initial_stage_index as number;
        const answers: Record<string, unknown>[] = [];
        for (const step of options.steps) {
          result.stages.push({ stage, index, prompt, files, prepare });
          const current = JSON.parse(files.find((file) => file.path === 'outline.json')?.content ?? 'null');
          if (step.answer) answers.push({ workflow_stage: stage, question: 'q', answer: step.answer, selected_option: step.answer, is_custom: false });
          const output = textOf(step.outline(current));
          const meta = {
            workflow_stage: stage,
            user_question_answers: answers,
            readFile: async (file: string) => {
              if (file === 'outline-review.json') return textOf(step.review ?? '');
              if (file === '原方案.md') return fake.originalPlan;
              throw new Error(`desktop read not scripted: ${file}`);
            },
            writeFiles: async (written: { path: string; content: string }[]) => result.writes.push(written),
          };
          const report = await payload.validateOutput({ output_content: output }, meta);
          result.reports.push(report);
          if (report.issues.length) throw Object.assign(new Error('submission blocked'), { report });
          const next = await payload.continueTask({ output_content: output }, { ...meta, validation_result: report.value });
          if (!next || next.complete === true || !next.prompt) return { output_content: output };
          stage = next.stage;
          prompt = next.prompt;
          files = next.files ?? [];
          prepare = next.prepare_output_files ?? [];
          index = Number.isFinite(Number(next.stage_index)) ? Number(next.stage_index) : index + 1;
        }
        throw new Error('desktop steps exhausted');
      }
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
  fake.answers = [];
  fake.answerQueries = [];
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
    // 与桌面版相同一次预置全部阶段的 Schema；评分模式的评分规划与叶子分配三份随 8.7e2b。
    expect(stage.jsonSchemas).toEqual({ 'outline.json': payload.json_validation_schemas['outline.json'], 'outline-review.json': payload.json_validation_schemas['outline-review.json'] });
    expect(Object.keys(payload.json_validation_schemas)).toEqual(['outline.json', 'technical-score-groups.json', 'score-directory-plan.json', 'leaf-allocation.json', 'outline-review.json']);
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

  it('有技术评分项时所选一级目录需要 AI 扩展：失败（评分模式的后续阶段随 8.7e2b），不打开沙箱、不写入', async () => {
    const { checkpoint } = await confirmedCheckpoint((items) => ({ selectedIds: [items[1].id] }));
    const unavailable = fakeAgent();
    const server = await runServer(unavailable.agent, { checkpoint });
    expect(server.error).toMatchObject({ code: OUTLINE_STAGE_UNAVAILABLE_CODE });
    expect(unavailable.record.opened).toBe(0);
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

// ---- 确认之后的后续阶段（8.7e2a，无技术评分项模式） ----

interface DirectoryRecord {
  opened: number;
  /** 每个阶段的提示词发出之前放入工作区的文件（分组、路径、内容）。 */
  stageWrites: { group: string; path: string; content: string }[][];
  released: { group: string; paths: string[] }[];
  stages: AgentStageOptions<unknown>[];
  reports: { value: unknown; issues: readonly { severity: string; message: string }[] }[];
  afterPrompt: (Record<string, unknown> | null)[];
  explicit: { task: Record<string, any> | null; progress?: number }[];
  workspace: Map<string, string>;
  closed: boolean;
}

/** 假 AgentRun：工作区与受保护文件的原件在内存中；每个阶段按脚本写出 outline.json（与 outline-review.json）后校验一次。 */
function directoryAgent(steps: DirectoryStep[], options: { taskCheckpoint: Record<string, unknown>; workspace?: Record<string, string>; originals?: Record<string, string>; unavailable?: string[] }) {
  const record: DirectoryRecord = { opened: 0, stageWrites: [], released: [], stages: [], reports: [], afterPrompt: [], explicit: [], workspace: new Map(Object.entries(options.workspace ?? {})), closed: false };
  const originals = new Map(Object.entries(options.originals ?? {}));
  let pending: DirectoryRecord['stageWrites'][number] = [];
  let index = 0;
  const run = {
    sandbox: { id: 'sandbox-1' },
    resumed: true,
    continued: false,
    unavailableProtectedFiles: options.unavailable ?? [],
    taskCheckpoint: options.taskCheckpoint,
    wasPrompted: () => {
      throw new Error('后续阶段不按执行者现场判断已发出的阶段');
    },
    baseline: {
      async write(_sandbox: unknown, group: string, files: { path: string; data: Buffer }[]) {
        for (const file of files) {
          const content = file.data.toString('utf8');
          pending.push({ group, path: file.path, content });
          record.workspace.set(file.path, content);
          originals.set(file.path, content);
        }
      },
      release(group: string, paths: readonly string[]) {
        record.released.push({ group, paths: [...paths] });
        for (const path of paths) originals.delete(path);
        return [...paths];
      },
      original(path: string) {
        const content = originals.get(path);
        return content === undefined ? null : Buffer.from(content, 'utf8');
      },
    },
    async readFiles(paths: readonly string[]) {
      const result = new Map<string, { size: number; data: Buffer | null }>();
      for (const path of paths) {
        const content = record.workspace.get(path);
        if (content !== undefined) result.set(path, { size: Buffer.byteLength(content), data: Buffer.from(content, 'utf8') });
      }
      return result;
    },
    async runStage(stage: AgentStageOptions<unknown>) {
      record.stages.push(stage);
      record.stageWrites.push(pending);
      pending = [];
      const step = steps[index++];
      if (!step) throw new Error('server steps exhausted');
      if (step.answer) fake.answers.push({ selected_option: step.answer });
      record.workspace.set('outline.json', textOf(step.outline(JSON.parse(record.workspace.get('outline.json') ?? 'null'))));
      if (step.review !== undefined) record.workspace.set('outline-review.json', textOf(step.review));
      record.afterPrompt.push(stage.checkpointAfterPrompt?.() ?? null);
      const report = await stage.validate({ attempt: 1, restored: [] });
      record.reports.push(report as DirectoryRecord['reports'][number]);
      if (report.issues.some((issue) => issue.severity === 'blocking')) throw new JobError('AGENT_SUBMISSION_FAILED', 'blocked');
      return { value: report.value, acceptedIssues: report.issues, repairs: 0, executionRetries: 0 };
    },
    async assistantText() {
      return null;
    },
    async checkpoint(task: Record<string, unknown> | null, progress?: number) {
      record.explicit.push({ task: structuredClone(task) as Record<string, any> | null, ...(progress !== undefined ? { progress } : {}) });
    },
    async close() {
      record.closed = true;
    },
  };
  const agent: JobAgent = {
    template: 'agent',
    resuming: true,
    open: async () => {
      record.opened += 1;
      return run as unknown as AgentRun;
    },
  };
  return { agent, record };
}

/** 文本中的 UUID 按出现顺序换成占位（两边各自为新节点随机分配 id）。 */
function normalizeIds(text: string): string {
  const ids = new Map<string, string>();
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, (id) => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
    return ids.get(id)!;
  });
}

const sortedFiles = (files: { path: string; content: string }[]) =>
  files.map((file) => ({ path: file.path, content: normalizeIds(file.content) })).sort((a, b) => a.path.localeCompare(b.path));

/** 无技术评分项模式的状态。 */
function noTechState(overrides: Record<string, unknown> = {}) {
  return baseState({
    techRequirements: NO_TECH_SCORE,
    bidAnalysisTasks: { ...baseState().bidAnalysisTasks, techRequirements: { status: 'success', content: NO_TECH_SCORE } },
    ...overrides,
  });
}

/** 把“技术方案”展开为三个 AI 生成叶子（子目录生成）。 */
function expandTechnical(current: any) {
  return {
    outline: current.outline.map((root: any) =>
      root.title === '技术方案'
        ? {
            id: root.id,
            title: root.title,
            description: root.description,
            attr: root.attr,
            children: [
              { id: null, title: '总体设计', description: '设计思路', content_mode: 'ai-generate' },
              {
                id: null,
                title: '实施方案',
                description: '实施安排',
                children: [
                  { id: null, title: '进度计划', description: '进度', content_mode: 'ai-generate' },
                  { id: null, title: '质量保障', description: '质量', content_mode: 'ai-generate' },
                ],
              },
            ],
          }
        : root,
    ),
  };
}

/** 在“技术方案”下追加一个 AI 生成叶子（叶子调整）。 */
function addLeaf(current: any) {
  return {
    outline: current.outline.map((root: any) =>
      root.title === '技术方案' ? { ...root, children: [...root.children, { id: null, title: '运维服务', description: '运维', content_mode: 'ai-generate' }] } : root,
    ),
  };
}

const keep = (current: any) => current;
const REVIEW = { status: 'simple_fix', issues: [], user_feedback: '', summary: '标题已规范' };

describe('目录生成：无技术评分项模式的后续阶段（与桌面版 runOutlineGenerationTaskV2 对照，8.7e2a）', () => {
  /** 服务端生成一级目录（无技术评分项模式）并按默认选择确认，得到确认后的 checkpoint。 */
  async function confirmedNoTech(pick?: (items: any[]) => string[]) {
    const { task } = await generateServer(INITIAL, true);
    const items = task!.selection.items as any[];
    const confirmed = applyOutlineSelection(items, pick ? pick(items) : task!.selection.selectedIds);
    const taskState = { ...task!, confirmed };
    return { confirmed, checkpoint: { agent: AGENT_STATE, task: taskState }, taskState };
  }

  async function compareWithDesktop(steps: DirectoryStep[], pick?: (items: any[]) => string[]) {
    const { confirmed, checkpoint, taskState } = await confirmedNoTech(pick);
    const desktopRun = await runDesktop(fake.state, INITIAL, {
      payload: { no_technical_score_mode: true },
      confirm: () => ({ items: confirmed.items, selectedIds: confirmed.selectedIds }),
      steps,
    });
    expect(desktopRun.error).toBeNull();
    const desktopAnswers = fake.answers;
    fake.answers = [];
    void desktopAnswers;
    const { agent, record } = directoryAgent(steps, { taskCheckpoint: taskState });
    const server = await runServer(agent, { checkpoint, noTechnicalScoreMode: true });
    return { desktopRun, record, server, checkpoint };
  }

  it('子目录生成 → 两次叶子调整（允许调整、接受当前结果）→ 目录审查：阶段、序号、提示词、放入的文件、预置 Schema、提交校验、写入的目录与日志和桌面版相同', async () => {
    fake.state = noTechState();
    const steps: DirectoryStep[] = [{ outline: expandTechnical }, { outline: addLeaf, answer: '允许 Agent 自行调整' }, { outline: keep, answer: '接受当前结果' }, { outline: keep, review: REVIEW }];
    const { desktopRun, record, server } = await compareWithDesktop(steps);
    expect(server.error).toBeNull();
    expect(record.opened).toBe(1);
    expect(record.closed).toBe(true);

    // 阶段名为桌面版的连字符形式，序号相同。
    expect(desktopRun.stages.map((stage) => stage.stage)).toEqual(['children_generation', 'leaf_adjustment', 'leaf_adjustment', 'outline_review']);
    expect(record.stages.map((stage) => stage.stage)).toEqual(['children-generation', 'leaf-adjustment', 'leaf-adjustment', 'outline-review']);
    expect(record.stages.map((stage) => stage.stageIndex)).toEqual(desktopRun.stages.map((stage) => stage.index));
    const payload = desktopRun.payloads[1]!;
    for (const [index, stage] of record.stages.entries()) {
      const desktopStage = desktopRun.stages[index]!;
      expect(normalizeIds(stage.prompt)).toBe(normalizeIds(desktopStage.prompt));
      expect(stage.tools).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'json-validation', 'ask-user', 'request-termination']);
      expect(stage.jsonSchemas).toEqual(payload.json_validation_schemas);
      expect(stage.outputFile).toBe(payload.output_file);
      expect(stage.maxExecutionRetries).toBe(payload.max_retries);
      expect(await stage.retryPrompt!({ reason: 'x', attempt: 1, maxRetries: 1 })).toBeNull();
      expect(await stage.repairPrompt!({ report: { value: null, issues: [] }, mode: 'normal', attempt: 1 })).toBe(
        await payload.buildRetryPrompt({ kind: 'submission' }, { workflow_stage: desktopStage.stage }),
      );
      // 放入的文件：预置为空的结果文件对应桌面版的 prepare_output_files，其余与桌面版 files 相同。
      const writes = record.stageWrites[index]!;
      expect(sortedFiles(writes.filter((file) => !(file.content === '' && desktopStage.prepare.includes(file.path))))).toEqual(sortedFiles(desktopStage.files));
      expect(writes.filter((file) => file.content === '').map((file) => file.path)).toEqual(desktopStage.prepare);
    }
    // 材料是受保护文件；outline.json 与 outline-review.json 交给 Agent（解除登记）；审查材料受保护。
    expect(record.stageWrites[0]!.map((file) => file.group)).toEqual(['outline-generation-inputs', 'outline-generation-inputs', 'outline-output']);
    expect(record.stageWrites[3]!.map((file) => [file.group, file.path])).toEqual([
      ['outline-output', 'outline.json'],
      ['outline-review-context', 'outline-review-context.json'],
      ['outline-output', 'outline-review.json'],
    ]);
    expect(record.released.every((item) => item.group === 'outline-output')).toBe(true);
    // 提交校验的问题清单（桌面版的第一份是一级目录阶段的）；通过时的目录与桌面版相同。
    const issuesOf = (reports: DirectoryRecord['reports']) => reports.map((report) => comparable(report).issues);
    expect(issuesOf(record.reports)).toEqual(issuesOf(desktopRun.reports.slice(1)));
    expect(record.reports.map((report) => placeholders((report.value as any).outline))).toEqual(desktopRun.reports.slice(1).map((report: any) => placeholders(report.value['outline.json'])));

    // 写入的目录、项目概述、字数控制与桌面版相同；整理后的目录写回 outline.json。
    expect(fake.saved).toHaveLength(1);
    const workspace = desktopRun.finished!.workspace;
    expect(placeholders({ outline: fake.saved[0]!.input.outline, project_overview: fake.saved[0]!.input.projectOverview })).toEqual(placeholders(workspace.outlineData));
    expect(fake.saved[0]!.input.wordControl).toEqual(workspace.outlineWordControlSnapshot);
    expect(JSON.parse(record.workspace.get('outline.json')!).outline).toEqual(fake.saved[0]!.input.outline);
    expect(countLeaves(fake.saved[0]!.input.outline)).toBe(4);
    expect(fake.discarded).toEqual([{ projectId: 'project-1', kinds: ['technical-plan-global-facts'] }]);

    // 两次执行的日志合起来与桌面版的相同（接连两次叶子调整只写一次，叶子数与目标不同、用户接受时的提示在最后）。
    const generated = (await generateServer(INITIAL, true)).server.logs;
    expect([...generated, ...server.logs]).toEqual(desktopRun.finished!.task.logs);
    expect(server.logs.at(-1)).toBe('AI 生成小节目标为 14，用户已确认最终保留当前 4 个。');
    expect(server.progress).toEqual([35, 75, 75, 88, 95, 98]);

    // 叶子调整的回答：第一次叶子调整开始时记下起点，排除终止确认。
    expect(fake.answerQueries).toHaveLength(2);
    expect(fake.answerQueries[0]).toEqual({ jobId: 'job-1', since: '2026-11-20T00:00:00.000Z', options: { excludeOptionLabels: ['降低质量继续', '终止任务', '补充处理要求'] } });
  });

  it('检查点：每个阶段的要求发出前保存（prompted 为 false），发出后保存（prompted 为 true）；签名与一级目录一并保留', async () => {
    fake.state = noTechState();
    const steps: DirectoryStep[] = [{ outline: expandTechnical }, { outline: keep, answer: '接受当前结果' }, { outline: keep, review: REVIEW }];
    const { record, checkpoint } = await compareWithDesktop(steps);
    const base = checkpoint.task as Record<string, any>;
    expect(record.afterPrompt.map((task) => (task as any).directory.stage)).toEqual(['children-generation', 'leaf-adjustment', 'outline-review']);
    expect(record.afterPrompt.every((task) => (task as any).directory.prompted === true)).toBe(true);
    for (const task of record.afterPrompt) expect(task).toMatchObject({ signature: base.signature, selection: base.selection, confirmed: base.confirmed });
    expect(record.explicit.map((item) => [item.task!.directory.stage, item.task!.directory.prompted, item.progress])).toEqual([
      ['leaf-adjustment', false, 75],
      ['outline-review', false, 88],
    ]);
    const leaf = record.explicit[0]!.task!.directory;
    expect(leaf).toMatchObject({ stageIndex: 3, actualLeafCount: 3, leafWarning: '', leafSince: '2026-11-20T00:00:00.000Z' });
    expect(new Set(leaf.knownIds)).toEqual(collectIds(JSON.parse(record.stageWrites[1]![0]!.content).outline));
    expect(record.explicit[1]!.task!.directory).toMatchObject({ actualLeafCount: 3, leafWarning: 'AI 生成小节目标为 14，用户已接受当前 3 个。' });
  });

  it('没有设置字数（目标为 null）：子目录生成后直接审查；只按原方案时审查附上原方案；单独技术分册的完成日志；与桌面版相同', async () => {
    fake.state = noTechState({
      outlineWordControlOptions: { minimumWords: 0, maximumWords: 0, sectionWords: 0 },
      originalPlanFile: { status: 'success', markdownArtifactId: 'a1' },
      outlineExpansionMode: 'original-only',
      outlineMode: 'standalone-technical',
    });
    fake.originalPlan = ORIGINAL_PLAN;
    const steps: DirectoryStep[] = [{ outline: expandTechnical }, { outline: keep, review: { ...REVIEW, status: 'passed' } }];
    const { desktopRun, record, server } = await compareWithDesktop(steps);
    expect(server.error).toBeNull();
    expect(record.stages.map((stage) => stage.stage)).toEqual(['children-generation', 'outline-review']);
    for (const [index, stage] of record.stages.entries()) expect(normalizeIds(stage.prompt)).toBe(normalizeIds(desktopRun.stages[index]!.prompt));
    expect(record.stages[1]!.prompt).toContain('【文件开始：原方案.md】');
    expect(record.stageWrites[0]!.filter((file) => file.group === 'outline-generation-inputs').map((file) => file.path)).toEqual(['原方案.md']);
    expect(placeholders(fake.saved[0]!.input.outline)).toEqual(placeholders(desktopRun.finished!.workspace.outlineData.outline));
    const generated = (await generateServer(INITIAL, true)).server.logs;
    expect([...generated, ...server.logs]).toEqual(desktopRun.finished!.task.logs);
    expect(server.logs.at(-1)).toBe('目录生成与审核完成');
    expect(fake.answerQueries).toEqual([]);
  });

  it('目录审查结果不合法（outline-review.json 为空、不符合 Schema；目录出现未知 id）时的问题清单与桌面版相同', async () => {
    fake.state = noTechState({ outlineWordControlOptions: { minimumWords: 0, maximumWords: 0, sectionWords: 0 } });
    const unknown = (current: any) => ({ outline: [...current.outline, { id: '0b3c1f0e-1d1c-4c1a-9a51-0a6b0b9f3b11', title: '附加', description: '说明', attr: '技术', content_mode: 'ai-generate' }] });
    for (const review of ['', { status: 'done', issues: [{ category: 'x' }], user_feedback: '' }, REVIEW]) {
      for (const outline of review === REVIEW ? [unknown] : [keep]) {
        fake.saved = [];
        const steps: DirectoryStep[] = [{ outline: expandTechnical }, { outline, review }];
        const { confirmed, checkpoint, taskState } = await confirmedNoTech();
        const desktopRun = await runDesktop(fake.state, INITIAL, { payload: { no_technical_score_mode: true }, confirm: () => ({ items: confirmed.items, selectedIds: confirmed.selectedIds }), steps });
        const { agent, record } = directoryAgent(steps, { taskCheckpoint: taskState });
        const server = await runServer(agent, { checkpoint, noTechnicalScoreMode: true });
        expect(server.error).toMatchObject({ code: 'AGENT_SUBMISSION_FAILED' });
        expect(record.reports.map((report) => comparable(report).issues)).toEqual(desktopRun.reports.slice(1).map((report) => comparable(report).issues));
        expect(record.reports.at(-1)!.issues.length).toBeGreaterThan(0);
        expect(fake.saved).toEqual([]);
      }
    }
  });

  it('续跑：阶段要求已发出时只发“继续之前的任务”、不再放入文件；交接后尚未发出时按 checkpoint 与工作区重新发出同样的要求', async () => {
    fake.state = noTechState();
    const steps: DirectoryStep[] = [{ outline: expandTechnical }, { outline: keep, answer: '接受当前结果' }, { outline: keep, review: REVIEW }];
    const first = await compareWithDesktop(steps);
    expect(first.server.error).toBeNull();
    const savedOutline = fake.saved[0]!.input.outline;

    // 叶子调整的要求发出后中断：从发出后的检查点续跑。
    fake.saved = [];
    fake.answers = [{ selected_option: '接受当前结果' }];
    const leafPrompted = first.record.afterPrompt[1]!;
    const workspace = Object.fromEntries(first.record.workspace);
    const resumedLeaf = directoryAgent([{ outline: keep }, { outline: keep, review: REVIEW }], { taskCheckpoint: leafPrompted, workspace: { ...workspace, 'outline.json': first.record.stageWrites[1]![0]!.content } });
    const leafServer = await runServer(resumedLeaf.agent, { checkpoint: { agent: AGENT_STATE, task: leafPrompted }, noTechnicalScoreMode: true });
    expect(leafServer.error).toBeNull();
    expect(resumedLeaf.record.stages.map((stage) => [stage.stage, stage.prompt === '继续之前的任务'])).toEqual([
      ['leaf-adjustment', true],
      ['outline-review', false],
    ]);
    expect(resumedLeaf.record.stageWrites[0]).toEqual([]);
    expect(normalizeIds(resumedLeaf.record.stages[1]!.prompt)).toBe(normalizeIds(first.record.stages[2]!.prompt));
    expect(placeholders(fake.saved[0]!.input.outline)).toEqual(placeholders(savedOutline));

    // 交接到目录审查后、要求发出前中断：按工作区中的 outline.json 与受保护的审查材料重新发出同样的要求。
    fake.saved = [];
    const reviewPending = first.record.explicit[1]!.task!;
    const reviewWrites = first.record.stageWrites[2]!;
    const reviewWorkspace = Object.fromEntries(reviewWrites.map((file) => [file.path, file.content]));
    const resumedReview = directoryAgent([{ outline: keep, review: REVIEW }], {
      taskCheckpoint: reviewPending,
      workspace: reviewWorkspace,
      originals: { 'outline-review-context.json': reviewWorkspace['outline-review-context.json']! },
    });
    const reviewServer = await runServer(resumedReview.agent, { checkpoint: { agent: AGENT_STATE, task: reviewPending }, noTechnicalScoreMode: true });
    expect(reviewServer.error).toBeNull();
    expect(resumedReview.record.stages[0]!.prompt).toBe(first.record.stages[2]!.prompt);
    expect(resumedReview.record.stageWrites[0]).toEqual([]);
    // 审查材料原件不可用：不能重新发出要求，任务失败、不写入。
    fake.saved = [];
    const noOriginal = directoryAgent([{ outline: keep, review: REVIEW }], { taskCheckpoint: reviewPending, workspace: reviewWorkspace });
    expect((await runServer(noOriginal.agent, { checkpoint: { agent: AGENT_STATE, task: reviewPending }, noTechnicalScoreMode: true })).error).toMatchObject({ code: 'TECHNICAL_PLAN_OUTLINE_INVALID' });
    expect(fake.saved).toEqual([]);

    // 叶子调整交接后、要求发出前中断：按 checkpoint 中的叶子数重新发出同样的要求。
    fake.saved = [];
    const leafPending = first.record.explicit[0]!.task!;
    const resumedLeafPending = directoryAgent([{ outline: keep }, { outline: keep, review: REVIEW }], { taskCheckpoint: leafPending, workspace: { 'outline.json': first.record.stageWrites[1]![0]!.content } });
    expect((await runServer(resumedLeafPending.agent, { checkpoint: { agent: AGENT_STATE, task: leafPending }, noTechnicalScoreMode: true })).error).toBeNull();
    expect(resumedLeafPending.record.stages[0]!.prompt).toBe(first.record.stages[1]!.prompt);

    // 子目录生成的要求发出后中断：材料原件不可用时按同一输入重新放入。
    fake.saved = [];
    const childrenPrompted = first.record.afterPrompt[0]!;
    const unavailable = directoryAgent([{ outline: expandTechnical }, { outline: keep, answer: '接受当前结果' }, { outline: keep, review: REVIEW }], {
      taskCheckpoint: childrenPrompted,
      workspace: { 'outline.json': first.record.stageWrites[0]!.find((file) => file.path === 'outline.json')!.content },
      unavailable: ['项目概述.md'],
    });
    expect((await runServer(unavailable.agent, { checkpoint: { agent: AGENT_STATE, task: childrenPrompted }, noTechnicalScoreMode: true })).error).toBeNull();
    expect(unavailable.record.stages[0]!.prompt).toBe('继续之前的任务');
    expect(unavailable.record.stageWrites[0]!.map((file) => file.group)).toEqual(['outline-generation-inputs', 'outline-generation-inputs']);
  });

  it('没有选择“接受当前结果”且叶子数仍与目标不同：再次叶子调整（与桌面版相同，由用户的回答决定）；终止确认之外没有回答时同样再次调整', async () => {
    fake.state = noTechState();
    const steps: DirectoryStep[] = [{ outline: expandTechnical }, { outline: keep }, { outline: keep, answer: '自定义需求' }, { outline: keep, answer: '接受当前结果' }, { outline: keep, review: REVIEW }];
    const { desktopRun, record, server } = await compareWithDesktop(steps);
    expect(server.error).toBeNull();
    expect(record.stages.map((stage) => stage.stage)).toEqual(desktopRun.stages.map((stage) => stage.stage.replaceAll('_', '-')));
    expect(record.stages.map((stage) => stage.stage)).toEqual(['children-generation', 'leaf-adjustment', 'leaf-adjustment', 'leaf-adjustment', 'outline-review']);
  });

  it('checkpoint 中的后续阶段进度形状不对时失败（不打开后续阶段）', async () => {
    fake.state = noTechState();
    const { checkpoint, taskState } = await confirmedNoTech();
    for (const directory of [{ stage: 'x' }, { stage: 'leaf-adjustment', stageIndex: -1, prompted: false, knownIds: [], actualLeafCount: 0, leafWarning: '', leafSince: null }, { stage: 'outline-review', stageIndex: 2, prompted: true, knownIds: [1], actualLeafCount: 0, leafWarning: '', leafSince: null }]) {
      const task = { ...taskState, directory };
      const { agent, record } = directoryAgent([], { taskCheckpoint: task });
      const server = await runServer(agent, { checkpoint: { ...checkpoint, task } as never, noTechnicalScoreMode: true });
      expect(server.error).toBeInstanceOf(TypeError);
      expect(record.stages).toEqual([]);
    }
  });
});

function countLeaves(items: any[]): number {
  return items.reduce((total, item) => total + (item.children?.length ? countLeaves(item.children) : item.content_mode === 'ai-generate' ? 1 : 0), 0);
}

function collectIds(items: any[], ids = new Set<string>()): Set<string> {
  for (const item of items) {
    ids.add(item.id);
    if (item.children) collectIds(item.children, ids);
  }
  return ids;
}
