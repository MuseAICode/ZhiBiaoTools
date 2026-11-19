// 可研报告目录调整（路线图第 8 步 8.7b，src/feasibilityReport/jobs.ts 的 feasibility-outline-adjustment、outlineAgent.ts）与桌面版
// feasibilityOutlineAdjustmentTask.cjs 的对照：Store 换成内存实现（vi.mock），会话的查找（src/agent/continuation.ts）换成桩，Agent 换成
// 脚本化的假 AgentRun（记下打开时接着的会话、放入工作区的文件、阶段的请求与检查点，按脚本写出 outline.json 与最后一条回复），桌面版的
// agentService.runTask 返回同一份 outline.json 与回复，比较放入的 outline.json、提示词、预置 Schema、结果文件、阶段、写入的目录（含项目
// 名称与概述）与调整说明。另覆盖：outline.json 交给 Agent 修改（写入后解除登记）；说明取不到时用桌面版的固定说明、过长时截短；会话不能
// 续用、没有目录时失败（文案与桌面版相同）；续跑用本任务的现场、只发“继续之前的任务”、不覆盖 outline.json；生成时的材料原件不可用时按
// 当前输入重新放入；输入已变化时失败；结果不可用时失败；参数检查。数据库、经 worker 的执行与接口见 tests/db/feasibilityReportJobs.test.ts。
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOpenOptions, AgentRun, AgentRunState, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import { JobError, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';

const fake = vi.hoisted(() => ({
  state: null as unknown as Record<string, any>,
  knowledge: [] as { documentId: string; itemId: string; title: string; resume: string; content: string }[],
  signature: 'sig-1',
  writeSignature: null as string | null,
  saved: [] as { input: Record<string, any>; signature: string }[],
  session: null as null | { jobId: string; state: Record<string, unknown> },
  lookups: [] as unknown[],
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

vi.mock('../../src/agent/continuation.ts', () => ({
  findContinuableAgentSession: async (_db: unknown, _context: unknown, target: unknown) => {
    fake.lookups.push(target);
    return structuredClone(fake.session);
  },
  findContinuableAgentSessionIn: async () => structuredClone(fake.session),
}));

const { createFeasibilityReportJobs, FEASIBILITY_OUTLINE_ADJUSTMENT_JOB_TYPE } = await import('../../src/feasibilityReport/jobs.ts');
const { buildAgentOutlineInput, buildFeasibilityOutlineAgentInput } = await import('../../src/feasibilityReport/outlineAgent.ts');
const { lightweightKnowledgeItems } = await import('../../src/feasibilityReport/jobs.ts');

const require = createRequire(import.meta.url);
const desktopAdjustment = require('../../../client/electron/services/feasibilityOutlineAdjustmentTask.cjs') as {
  runFeasibilityOutlineAdjustmentTask(options: Record<string, unknown>): Promise<void>;
};
const desktopTask = require('../../../client/electron/services/feasibilityOutlineTask.cjs') as {
  buildAgentOutlineInput(outlineData: unknown): unknown;
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
];

/** 当前目录（用户可能手动改过）：叶子带知识库条目与正文，含空白的标题与说明。 */
const OUTLINE = [
  {
    id: '1',
    title: ' 概述 ',
    description: '项目概况与结论',
    children: [
      { id: '1.1', title: '项目概况', description: '', knowledge_item_ids: ['doc-1::item-1', ' '], content: '已有的正文' },
      { id: '1.2', title: '编制依据', description: '依据', knowledge_item_ids: [] },
    ],
  },
  { id: '2', title: '项目建设方案', description: '方案', content: '方案正文' },
];

function baseState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    step: 'outline',
    projectInfo: { ...PROJECT_INFO },
    sourceFiles: [],
    analysisMarkdown: '## 项目概况\n\n改造管网 12 公里。',
    outlineTemplate: 'enterprise',
    targetWords: 50000,
    referenceDocumentIds: ['doc-1'],
    keyParametersMarkdown: '## 关键参数',
    outlineData: { outline: structuredClone(OUTLINE), project_name: '目录中的项目名称', project_overview: '目录中的概述' },
    analysisTask: null,
    outlineTask: null,
    outlineAdjustmentTask: null,
    outlineAdjustment: null,
    outlineAdjustable: true,
    parametersTask: null,
    contentTask: null,
    humanWritingTask: null,
    ...overrides,
  };
}

/** Agent 改写后的 outline.json：合并第二章、带编号的标题、不在清单中的条目。 */
const ADJUSTED = JSON.stringify({
  outline: [
    { id: '1', title: '第一章 概述', description: '项目概况与结论', children: [{ title: '1.1 项目概况', description: '', knowledge_item_ids: ['doc-1::item-1', 'doc-9::x'] }] },
    { title: '项目建设方案与实施', description: '合并后的章节', knowledge_item_ids: ['doc-1::item-2'] },
  ],
});

const SUMMARY = '已合并第二章与第三章，并删除了重复的编制依据小节。';

const SOURCE_STATE: Record<string, unknown> = {
  version: 1,
  session: '2026-11-19T01-02-03-004Z_0b3c1f0e-1d1c-4c1a-9a51-0a6b0b9f3b11.jsonl',
  stage: 'feasibility-outline',
  stageIndex: 0,
  promptedStage: 'feasibility-outline',
  compactionPending: null,
  baseline: { version: 1, groups: {} },
  snapshot: '6f0d1b51-9b2a-4f63-8f5e-3a0a8c2d4e11',
};

// ---- 桌面版 ----

async function runDesktop(state: Record<string, any>, outputContent: string, assistantText: string, requirement: string) {
  const payloads: Record<string, any>[] = [];
  const saved: Record<string, any>[] = [];
  let finished: Record<string, any> | null = null;
  const agentService = {
    hasPersistentTaskSession: () => true,
    updatePersistentTask() {},
    async runTask(payload: Record<string, any>) {
      payloads.push(payload);
      return { output_content: outputContent, assistant_text: assistantText };
    },
  };
  const knowledgeBaseService = {
    getOutlineReferences: () => ({
      items: fake.knowledge.filter((item) => item.title && item.resume).map((item) => ({ id: `${item.documentId}::${item.itemId}`, title: item.title, resume: item.resume })),
    }),
  };
  let error: unknown = null;
  try {
    await desktopAdjustment.runFeasibilityOutlineAdjustmentTask({
      agentService,
      workspaceStore: {
        loadFeasibilityReport: () => structuredClone(state),
        saveOutline: (payload: Record<string, any>) => {
          saved.push(structuredClone(payload));
          return { outlineData: payload.outlineData, keyParametersMarkdown: '' };
        },
      },
      knowledgeBaseService,
      updateTask: () => ({}),
      checkpointTask: (task: Record<string, any>) => {
        if (task.status === 'success') finished = structuredClone(task);
        return { task: { task_id: 'desktop-task', ...task } };
      },
      taskControl: { signal: new AbortController().signal },
      payload: { requirement },
    });
  } catch (caught) {
    error = caught;
  }
  return { payload: payloads[0]!, saved: saved[0]!, finished: finished as Record<string, any> | null, error };
}

// ---- 服务端（假 AgentRun） ----

interface FakeRunOptions {
  output?: string | null;
  reply?: string | null;
  resumed?: boolean;
  taskCheckpoint?: Record<string, unknown> | null;
  promptedStage?: string | null;
  unavailable?: string[];
}

interface FakeRun {
  opened: (AgentOpenOptions | undefined)[];
  written: { group: string; files: { path: string; content: string }[]; options: unknown }[];
  released: { group: string; paths: readonly string[] }[];
  stages: AgentStageOptions<unknown>[];
  checkpoints: { after: Record<string, unknown> | null; explicit: { task: Record<string, unknown> | null; progress?: number }[] };
  closed: boolean;
}

function fakeAgent(options: FakeRunOptions): { agent: JobAgent; record: FakeRun } {
  const record: FakeRun = { opened: [], written: [], released: [], stages: [], checkpoints: { after: null, explicit: [] }, closed: false };
  const resumed = options.resumed ?? false;
  const run = {
    sandbox: { id: 'sandbox-1' },
    resumed,
    continued: !resumed,
    unavailableProtectedFiles: options.unavailable ?? [],
    taskCheckpoint: options.taskCheckpoint ?? null,
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
      return { value: report.value, acceptedIssues: report.issues, repairs: 0, executionRetries: 0 };
    },
    async assistantText(input: { maxChars?: number } = {}) {
      if (options.reply === null || options.reply === undefined) return null;
      const max = input.maxChars ?? Infinity;
      return { text: options.reply.slice(0, max), truncated: options.reply.length > max };
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
      open: async (openOptions?: AgentOpenOptions) => {
        record.opened.push(openOptions);
        return run as unknown as AgentRun;
      },
    },
    record,
  };
}

const job = createFeasibilityReportJobs().find((item) => item.type === FEASIBILITY_OUTLINE_ADJUSTMENT_JOB_TYPE)! as JobTypeDefinition<any>;

async function runServer(agent: JobAgent | null, requirement = '把第二章拆成建设方案与实施进度两章') {
  const logs: string[] = [];
  const context: JobContext<any> = {
    jobId: 'job-1',
    projectId: 'project-1',
    type: FEASIBILITY_OUTLINE_ADJUSTMENT_JOB_TYPE,
    attempt: 1,
    params: job.parseParams({ requirement }),
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

beforeEach(() => {
  fake.state = baseState();
  fake.knowledge = structuredClone(KNOWLEDGE);
  fake.signature = 'sig-1';
  fake.writeSignature = null;
  fake.saved = [];
  fake.session = { jobId: 'source-job', state: structuredClone(SOURCE_STATE) };
  fake.lookups = [];
});

describe('目录调整（与桌面版 feasibilityOutlineAdjustmentTask.cjs 对照）', () => {
  it('buildAgentOutlineInput 与桌面版相同：只含 id、标题、说明、叶子的知识库条目与子目录，不含正文', () => {
    expect(buildAgentOutlineInput(OUTLINE)).toEqual(desktopTask.buildAgentOutlineInput({ outline: OUTLINE }));
    expect(JSON.stringify(buildAgentOutlineInput(OUTLINE))).not.toContain('正文');
    expect(buildAgentOutlineInput([])).toEqual(desktopTask.buildAgentOutlineInput({ outline: [] }));
  });

  it('接着生成的会话；outline.json、提示词、阶段、预置 Schema、结果文件与工具和桌面版相同；写入的目录、项目名称、概述与说明相同', async () => {
    const requirement = '把第二章拆成建设方案与实施进度两章';
    const desktop = await runDesktop(baseState(), ADJUSTED, SUMMARY, requirement);
    expect(desktop.error).toBeNull();
    const { agent, record } = fakeAgent({ output: ADJUSTED, reply: `  ${SUMMARY}\n` });
    const server = await runServer(agent, requirement);
    expect(server.error).toBeNull();

    // 接着的会话：按目录生成与调整共用的快照类别查找，交给 open。
    expect(fake.lookups).toEqual([{ projectId: 'project-1', taskKind: 'feasibility-outline', jobTypes: ['feasibility-outline', 'feasibility-outline-adjustment'] }]);
    expect(record.opened).toEqual([{ continueFrom: SOURCE_STATE }]);

    // 当前目录写入 outline.json，交给 Agent 修改（写入后解除登记）；生成时的材料不重新放入。
    expect(record.written).toHaveLength(1);
    expect(record.written[0]!.group).toBe('output');
    expect(record.written[0]!.files).toEqual(desktop.payload.files);
    expect(record.released).toEqual([{ group: 'output', paths: ['outline.json'] }]);

    const stage = record.stages[0]!;
    expect(stage.prompt).toBe(desktop.payload.prompt);
    expect(stage.prompt).toContain(requirement);
    expect(stage.stage).toBe(desktop.payload.initial_stage);
    expect(stage.outputFile).toBe(desktop.payload.output_file);
    expect(stage.maxExecutionRetries).toBe(desktop.payload.max_retries);
    expect(stage.jsonSchemas).toEqual(desktop.payload.json_validation_schemas);
    expect(stage.tools).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'json-validation', 'ask-user', 'request-termination']);
    expect(record.checkpoints.after).toEqual({ signature: 'sig-1' });
    // 说明随最后的检查点保存（之后才写入目录）。
    expect(record.checkpoints.explicit).toEqual([{ task: { signature: 'sig-1', summary: desktop.finished!.stats.adjustment.summary }, progress: 95 }]);
    expect(record.closed).toBe(true);

    expect(fake.saved).toHaveLength(1);
    const saved = fake.saved[0]!;
    expect(saved.signature).toBe('sig-1');
    expect(saved.input.outline).toEqual(desktop.saved.outlineData.outline);
    expect(saved.input.projectName).toBe(desktop.saved.outlineData.project_name);
    expect(saved.input.projectOverview).toBe(desktop.saved.outlineData.project_overview);
    expect(desktop.saved.reason).toBe('replace');
    expect(desktop.finished!.stats.adjustment).toEqual({ requirement, summary: SUMMARY });
    // 任务日志不含调整要求与 AI 的说明。
    expect(server.logs).toEqual(['开始 AI 调整报告目录。', 'Agent 正在调整报告目录。', '报告目录 AI 调整完成。']);
    expect(server.logs.join('\n')).not.toContain(SUMMARY);
    expect(server.logs.join('\n')).not.toContain(requirement);
  });

  it('原目录没有项目名称、概述时与桌面版相同（项目名称取项目参数，概述为空）', async () => {
    const state = baseState({ outlineData: { outline: structuredClone(OUTLINE) } });
    fake.state = state;
    const desktop = await runDesktop(state, ADJUSTED, SUMMARY, '调整');
    const { agent } = fakeAgent({ output: ADJUSTED, reply: SUMMARY });
    expect((await runServer(agent, '调整')).error).toBeNull();
    expect(fake.saved[0]!.input.projectName).toBe(desktop.saved.outlineData.project_name);
    expect(fake.saved[0]!.input.projectName).toBe(PROJECT_INFO.projectName);
    expect(desktop.saved.outlineData.project_overview).toBeUndefined();
    expect(fake.saved[0]!.input.projectOverview).toBe('');
  });

  it('取不到回复时说明为桌面版的固定说明；过长的回复截到 2000 字', async () => {
    const desktop = await runDesktop(baseState(), ADJUSTED, '   ', '调整');
    const empty = fakeAgent({ output: ADJUSTED, reply: null });
    expect((await runServer(empty.agent, '调整')).error).toBeNull();
    expect(empty.record.checkpoints.explicit[0]!.task).toEqual({ signature: 'sig-1', summary: desktop.finished!.stats.adjustment.summary });
    expect(desktop.finished!.stats.adjustment.summary).toBe('报告目录已按要求调整完成。');

    const long = fakeAgent({ output: ADJUSTED, reply: '说'.repeat(5000) });
    expect((await runServer(long.agent, '调整')).error).toBeNull();
    expect((long.record.checkpoints.explicit[0]!.task!.summary as string).length).toBe(2000);
  });

  it('会话不能续用时失败（文案与桌面版相同），不打开沙箱；没有目录时失败（文案与桌面版相同）', async () => {
    fake.session = null;
    const { agent, record } = fakeAgent({ output: ADJUSTED });
    const { error } = await runServer(agent);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('FEASIBILITY_REPORT_OUTLINE_SESSION_MISSING');
    expect((error as JobError).message).toBe('报告目录生成的 Agent 工作空间不存在，请重新生成后再使用 AI 调整');
    expect(record.opened).toEqual([]);

    fake.session = { jobId: 'source-job', state: structuredClone(SOURCE_STATE) };
    fake.state = baseState({ outlineData: null });
    const desktopError = (await runDesktop(fake.state, ADJUSTED, SUMMARY, '调整')).error as Error;
    const noOutline = await runServer(fakeAgent({ output: ADJUSTED }).agent);
    expect((noOutline.error as JobError).code).toBe('FEASIBILITY_REPORT_OUTLINE_REQUIRED');
    expect((noOutline.error as JobError).message).toBe(desktopError.message);
    expect(fake.lookups).toHaveLength(1);
    fake.state = baseState();
    expect(((await runServer(null)).error as JobError).code).toBe('AGENT_UNAVAILABLE');
  });

  it('续跑：用本任务的现场（不查找、不接着其他会话），只发“继续之前的任务”，不覆盖 outline.json；生成时的材料原件不可用时按当前输入重新放入', async () => {
    const resumed = fakeAgent({ output: ADJUSTED, reply: SUMMARY, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: 'feasibility-outline-adjustment' });
    const first = await runServer(resumed.agent);
    expect(first.error).toBeNull();
    expect(fake.lookups).toEqual([]);
    expect(resumed.record.opened).toEqual([undefined]);
    expect(resumed.record.written).toEqual([]);
    expect(resumed.record.stages[0]!.prompt).toBe('继续之前的任务');
    expect(first.logs[0]).toBe('Agent 继续调整报告目录。');
    expect(fake.saved.at(-1)!.signature).toBe('sig-1');

    const unavailable = fakeAgent({ output: ADJUSTED, reply: SUMMARY, resumed: true, taskCheckpoint: { signature: 'sig-1' }, unavailable: ['资料分析.md'] });
    expect((await runServer(unavailable.agent)).error).toBeNull();
    expect(unavailable.record.written).toHaveLength(1);
    expect(unavailable.record.written[0]!.group).toBe('input');
    const expected = buildFeasibilityOutlineAgentInput(fake.state as never, lightweightKnowledgeItems(fake.knowledge)).files;
    expect(unavailable.record.written[0]!.files).toEqual(expected);
    expect(unavailable.record.stages[0]!.prompt).not.toBe('继续之前的任务');
  });

  it('续跑时输入已变化、或写入时签名不符：FEASIBILITY_REPORT_INPUT_CHANGED，不写入', async () => {
    fake.signature = 'sig-2';
    const changed = fakeAgent({ output: ADJUSTED, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: 'feasibility-outline-adjustment' });
    expect(((await runServer(changed.agent)).error as JobError).code).toBe('FEASIBILITY_REPORT_INPUT_CHANGED');
    expect(changed.record.stages).toEqual([]);
    expect(changed.record.closed).toBe(true);

    fake.signature = 'sig-1';
    fake.writeSignature = 'sig-3';
    expect(((await runServer(fakeAgent({ output: ADJUSTED, reply: SUMMARY }).agent)).error as JobError).code).toBe('FEASIBILITY_REPORT_INPUT_CHANGED');
    expect(fake.saved).toEqual([]);
  });

  it('结果不可用时失败（与生成相同的固定说明，不含文件内容），不保存说明、不写入', async () => {
    for (const output of ['{"outline": [', JSON.stringify({ outline: [] }), null]) {
      const { agent, record } = fakeAgent({ output, reply: SUMMARY });
      const { error } = await runServer(agent);
      expect((error as JobError).code).toBe('FEASIBILITY_REPORT_OUTLINE_INVALID');
      expect((error as JobError).message).not.toContain('outline": [');
      expect(record.checkpoints.explicit).toEqual([]);
    }
    expect(fake.saved).toEqual([]);
  });

  it('任务参数只接受去掉首尾空白、不为空、至多 2000 字的调整要求', () => {
    expect(job.parseParams({ requirement: '合并第二章' })).toEqual({ requirement: '合并第二章' });
    expect(job.parseParams({ requirement: '字'.repeat(2000) })).toEqual({ requirement: '字'.repeat(2000) });
    for (const bad of [{}, { requirement: '' }, { requirement: ' 合并 ' }, { requirement: '字'.repeat(2001) }, { requirement: '合并', onlyMissing: true }, null]) {
      expect(() => job.parseParams(bad)).toThrow(TypeError);
    }
  });
});

// 现场的类型检查（编译期）：交给 open 的是 AgentRunState。
const _typed: AgentRunState | undefined = undefined;
void _typed;
