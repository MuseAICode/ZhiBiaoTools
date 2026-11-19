// 技术方案全局事实调整（路线图第 8 步 8.7c2，src/technicalPlan/jobs.ts 的 global-facts-adjustment、globalFactsAgent.ts）与桌面版
// globalFactsAdjustmentTask.cjs 的对照：Store 换成内存实现（vi.mock），会话的查找（src/agent/continuation.ts）换成桩，Agent 换成脚本化的
// 假 AgentRun（记下打开时接着的会话、放入工作区的文件、阶段的请求与检查点，按脚本给出 global-facts.json 与最后一条回复），桌面版的
// agentService.runTask 用同一份文件调用它自己的 validateOutput 并返回同一条回复。比较放入的 global-facts.json、提示词、预置 Schema、结果
// 文件、阶段与工具、提交校验的问题清单、写入的全局事实与调整说明。另覆盖：global-facts.json 交给 Agent 修改（写入后解除登记）；说明取不到
// 时用桌面版的固定说明、过长时截短；没有全局事实、会话不能续用时失败（文案与桌面版相同）；续跑用本任务的现场、只发“继续之前的任务”、
// 不覆盖 global-facts.json；生成时的材料原件不可用时按当前输入重新放入（与生成放入的相同）；输入已变化时失败；结果不可用时为阻塞问题
// （经提交修复）；参数检查。数据库与接口见 tests/db/technicalPlanGlobalFacts.test.ts。
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOpenOptions, AgentRun, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import { JobError, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';

/** 提交校验报告的对照形式（同 tests/technicalPlan/globalFactsJob.test.ts）：桌面版的 value 是 { groups }，服务端是分组；问题只比较级别与说明，
 * 不是合法 JSON 时服务端不附解析器的错误信息（8.7c1 的差异），只比较冒号之前的部分。 */
function comparable(report: { value: unknown; issues: readonly { severity: string; message: string }[] }, desktop: boolean) {
  // 有问题时服务端的 value 一律为 null（同 8.7c1 的对照），不比较。
  const value = report.issues.length ? null : desktop ? (report.value as { groups: unknown }).groups : report.value;
  return { value, issues: report.issues.map(({ severity, message }) => ({ severity, message: message.replace(/^(global-facts\.json不是合法 JSON)：.*$/s, '$1') })) };
}

const fake = vi.hoisted(() => ({
  state: null as unknown as Record<string, any>,
  tenderFiles: [] as { fileName: string; markdown: string }[],
  knowledge: [] as { documentId: string; itemId: string; title: string; resume: string; content: string }[],
  signature: 'sig-1',
  writeSignature: null as string | null,
  saved: [] as { groups: unknown; signature: string }[],
  session: null as null | { jobId: string; state: Record<string, unknown> },
  lookups: [] as unknown[],
}));

vi.mock('../../src/technicalPlan/store.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/technicalPlan/store.ts')>();
  return {
    ...original,
    globalFactsInputSignature: async () => fake.signature,
    loadTechnicalPlan: async () => structuredClone(fake.state),
    readGlobalFactsSources: async (_db: unknown, _context: unknown, _projectId: string, _store: unknown, options: { tenders: boolean }) => ({
      tenderFiles: options.tenders ? structuredClone(fake.tenderFiles) : [],
      originalPlanMarkdown: '',
    }),
    readTenderMarkdown: async () => '',
    readGlobalFactsKnowledgeItems: async () => structuredClone(fake.knowledge),
    saveGlobalFactsResult: async (_db: unknown, _context: unknown, _projectId: string, groups: unknown, signature: string) => {
      if (signature !== (fake.writeSignature ?? fake.signature)) return false;
      fake.saved.push({ groups: structuredClone(groups), signature });
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

const { createTechnicalPlanJobs, GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE, GLOBAL_FACTS_JOB_TYPE } = await import('../../src/technicalPlan/jobs.ts');
const { buildAgentFactsInput } = await import('../../src/technicalPlan/globalFactsAgent.ts');

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
    return require('../../../client/electron/services/globalFactsAdjustmentTask.cjs');
  } finally {
    Module._load = original;
  }
}
const desktopAdjustment = loadDesktop() as { runGlobalFactsAdjustmentTask(options: Record<string, unknown>): Promise<void> };

// ---- 输入 ----

const OUTLINE = [
  { id: 'n1', number: '1', title: '项目理解', description: '背景', children: [{ id: 'n1-1', number: '1.1', title: '建设目标', description: '' }] },
  { id: 'n2', number: '2', title: '实施方案', description: '', children: [{ id: 'n2-1', number: '2.1', title: '进度计划', description: '工期' }] },
];

const BID_ITEMS = {
  projectOverview: { id: 'projectOverview', label: '项目概述', status: 'success', content: '某市智慧水务平台建设', error: null },
  projectInfo: { id: 'projectInfo', label: '项目信息', status: 'success', content: '预算：500 万元', error: null },
};

const KNOWLEDGE = [{ documentId: 'doc-1', itemId: 'item-1', title: '水务平台案例', resume: '同类项目', content: '项目经理：王工。' }];

/** 当前的全局事实（用户可能手动改过）：标题带空白、内容带首尾换行、带 updated_at。 */
const FACTS = [
  { id: 'schedule', title: '  工期变量 ', content: '\n- 工期：180 日历天。\n', updated_at: '2026-11-19T01:02:03.000Z' },
  { id: 'team', title: '项目角色变量', content: '- 项目经理：张伟。', updated_at: '2026-11-19T01:02:03.000Z' },
];

function baseState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    step: 'global-facts',
    tenderFiles: [{ id: 'f1', fileName: '招标文件.docx', status: 'success', markdownArtifactId: 'a-f1' }],
    originalPlanFile: null,
    selectedSection: null,
    bidSectionMode: 'single',
    bidSections: [],
    projectOverview: BID_ITEMS.projectOverview.content,
    bidAnalysisTasks: structuredClone(BID_ITEMS),
    outlineData: { outline: structuredClone(OUTLINE) },
    referenceKnowledgeDocumentIds: ['doc-1'],
    globalFactsMode: 'fabricate',
    globalFacts: structuredClone(FACTS),
    globalFactsAdjustmentTask: null,
    globalFactsAdjustment: null,
    globalFactsAdjustable: true,
    ...overrides,
  };
}

/** Agent 改写后的 global-facts.json：工期改为 150 天、新增一组、id 需要规范化。 */
const ADJUSTED = JSON.stringify({
  groups: [
    { id: 'schedule', title: '工期变量', content: '- 工期：150 日历天。' },
    { id: 'team', title: '项目角色变量', content: '- 项目经理：张伟。' },
    { id: 'Quality Plan', title: ' 质量变量\n', content: '\n- 质量目标：合格。' },
  ],
});

const SUMMARY = '已把工期统一改为 150 日历天，并新增质量变量。';

const SOURCE_STATE: Record<string, unknown> = {
  version: 1,
  session: '2026-11-19T01-02-03-004Z_0b3c1f0e-1d1c-4c1a-9a51-0a6b0b9f3b11.jsonl',
  stage: 'global-facts',
  stageIndex: 0,
  promptedStage: 'global-facts',
  compactionPending: null,
  baseline: { version: 1, groups: {} },
  snapshot: '6f0d1b51-9b2a-4f63-8f5e-3a0a8c2d4e11',
};

// ---- 桌面版 ----

async function runDesktop(state: Record<string, any>, outputContent: string, assistantText: string, requirement: string, options: { hasSession?: boolean } = {}) {
  const payloads: Record<string, any>[] = [];
  const reports: { value: unknown; issues: { severity: string; message: string }[] }[] = [];
  let finished: { task: Record<string, any>; patch: Record<string, any> } | null = null;
  const agentService = {
    hasPersistentTaskSession: () => options.hasSession ?? true,
    updatePersistentTask() {},
    async runTask(payload: Record<string, any>) {
      payloads.push(payload);
      const report = payload.validateOutput({ output_content: outputContent });
      reports.push(report);
      if (report.issues.length) throw Object.assign(new Error('submission blocked'), { report });
      return { validation_result: report.value, assistant_text: assistantText };
    },
  };
  let error: unknown = null;
  try {
    await desktopAdjustment.runGlobalFactsAdjustmentTask({
      agentService,
      workspaceStore: { loadTechnicalPlan: () => ({ globalFacts: structuredClone(state.globalFacts) }) },
      updateTask: () => ({}),
      checkpointTask: (task: Record<string, any>, patch: Record<string, any> = {}) => {
        if (task.status === 'success') finished = { task: structuredClone(task), patch: structuredClone(patch) };
        return { task: { task_id: 'desktop-task', ...task } };
      },
      taskControl: { signal: new AbortController().signal },
      payload: { requirement },
    });
  } catch (caught) {
    error = caught;
  }
  return { payload: payloads[0]!, reports, finished: finished as { task: Record<string, any>; patch: Record<string, any> } | null, error };
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
  reports: { value: unknown; issues: readonly { severity: string; message: string }[] }[];
  checkpoints: { after: Record<string, unknown> | null; explicit: { task: Record<string, unknown> | null; progress?: number }[] };
  closed: boolean;
}

function fakeAgent(options: FakeRunOptions): { agent: JobAgent; record: FakeRun } {
  const record: FakeRun = { opened: [], written: [], released: [], stages: [], reports: [], checkpoints: { after: null, explicit: [] }, closed: false };
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
      record.reports.push(report as FakeRun['reports'][number]);
      // 真实的 runStage 在有阻塞问题时退回修复、最终以 AGENT_SUBMISSION_FAILED 停止；这里直接停止。
      if (report.issues.some((issue) => issue.severity === 'blocking')) throw new JobError('AGENT_SUBMISSION_FAILED', 'blocked');
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

const jobs = createTechnicalPlanJobs();
const job = jobs.find((item) => item.type === GLOBAL_FACTS_ADJUSTMENT_JOB_TYPE)! as JobTypeDefinition<any>;
const generationJob = jobs.find((item) => item.type === GLOBAL_FACTS_JOB_TYPE)! as JobTypeDefinition<any>;

async function runServer(agent: JobAgent | null, requirement = '把工期统一改为 150 日历天', definition: JobTypeDefinition<any> = job) {
  const logs: string[] = [];
  const context: JobContext<any> = {
    jobId: 'job-1',
    projectId: 'project-1',
    type: definition.type,
    attempt: 1,
    params: definition === job ? job.parseParams({ requirement }) : {},
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
    await definition.run(context);
    return { logs, error: null as unknown };
  } catch (error) {
    return { logs, error };
  }
}

beforeEach(() => {
  fake.state = baseState();
  fake.tenderFiles = [{ fileName: '招标文件.docx', markdown: '# 招标公告\n\n工期：180 日历天。' }];
  fake.knowledge = structuredClone(KNOWLEDGE);
  fake.signature = 'sig-1';
  fake.writeSignature = null;
  fake.saved = [];
  fake.session = { jobId: 'source-job', state: structuredClone(SOURCE_STATE) };
  fake.lookups = [];
});

describe('全局事实调整（与桌面版 globalFactsAdjustmentTask.cjs 对照）', () => {
  it('接着生成的会话；global-facts.json、提示词、阶段、预置 Schema、结果文件与工具和桌面版相同；写入的全局事实与说明相同', async () => {
    const requirement = '把工期统一改为 150 日历天';
    const desktop = await runDesktop(baseState(), ADJUSTED, SUMMARY, requirement);
    expect(desktop.error).toBeNull();
    const { agent, record } = fakeAgent({ output: ADJUSTED, reply: `  ${SUMMARY}\n` });
    const server = await runServer(agent, requirement);
    expect(server.error).toBeNull();

    // 接着的会话：按生成与调整共用的快照类别查找，交给 open。
    expect(fake.lookups).toEqual([{ projectId: 'project-1', taskKind: 'technical-plan-global-facts', jobTypes: ['global-facts-generation', 'global-facts-adjustment'] }]);
    expect(record.opened).toEqual([{ continueFrom: SOURCE_STATE }]);

    // 当前全局事实写入 global-facts.json（不含 updated_at），交给 Agent 修改（写入后解除登记）；生成时的材料不重新放入。
    expect(record.written).toHaveLength(1);
    expect(record.written[0]!.group).toBe('output');
    expect(record.written[0]!.options).toMatchObject({ replace: true });
    expect(record.written[0]!.files).toEqual(desktop.payload.files);
    expect(record.written[0]!.files[0]!.content).not.toContain('updated_at');
    expect(record.released).toEqual([{ group: 'output', paths: ['global-facts.json'] }]);

    const stage = record.stages[0]!;
    expect(stage.prompt).toBe(desktop.payload.prompt);
    expect(stage.prompt).toContain(`用户的调整要求：\n${requirement}`);
    expect(stage.stage).toBe(desktop.payload.initial_stage);
    expect(stage.outputFile).toBe(desktop.payload.output_file);
    expect(stage.maxExecutionRetries).toBe(desktop.payload.max_retries);
    expect(stage.jsonSchemas).toEqual(desktop.payload.json_validation_schemas);
    expect(stage.tools).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'json-validation', 'ask-user', 'request-termination']);
    // 提交校验与桌面版相同（经提交修复）。
    expect(record.reports.map((report) => comparable(report, false))).toEqual(desktop.reports.map((report) => comparable(report, true)));
    expect(record.reports[0]!.issues).toEqual([]);
    expect(record.checkpoints.after).toEqual({ signature: 'sig-1' });
    // 说明随最后的检查点保存（之后才写入全局事实）。
    expect(record.checkpoints.explicit).toEqual([{ task: { signature: 'sig-1', summary: desktop.finished!.task.stats.adjustment.summary }, progress: 95 }]);
    expect(record.closed).toBe(true);

    expect(fake.saved).toEqual([{ groups: desktop.finished!.patch.globalFacts, signature: 'sig-1' }]);
    // 与桌面版相同，写入全局事实时清空正文阶段（saveGlobalFactsResult 与 saveGlobalFacts 相同）。
    expect(desktop.finished!.patch.invalidateContentGeneration).toBe(true);
    expect(desktop.finished!.task.stats.adjustment).toEqual({ requirement, summary: SUMMARY });
    // 任务日志与桌面版相同，不含调整要求与 AI 的说明。
    expect(server.logs).toEqual(['开始 AI 调整全局事实', 'Agent 正在调整全局事实。', '全局事实 AI 调整完成']);
    expect(desktop.finished!.task.logs).toEqual(['开始 AI 调整全局事实', '全局事实 AI 调整完成']);
    expect(server.logs.join('\n')).not.toContain(SUMMARY);
    expect(server.logs.join('\n')).not.toContain(requirement);
  });

  it('buildAgentFactsInput 与桌面版放入的文件相同：只含 id、去掉首尾空白的标题与原样的内容', async () => {
    expect(buildAgentFactsInput(FACTS)).toEqual({
      groups: [
        { id: 'schedule', title: '工期变量', content: '\n- 工期：180 日历天。\n' },
        { id: 'team', title: '项目角色变量', content: '- 项目经理：张伟。' },
      ],
    });
    const desktop = await runDesktop(baseState(), ADJUSTED, SUMMARY, '调整');
    expect(JSON.parse(desktop.payload.files[0].content)).toEqual(buildAgentFactsInput(FACTS));
  });

  it('取不到回复时说明为桌面版的固定说明；过长的回复截到 2000 字', async () => {
    const desktop = await runDesktop(baseState(), ADJUSTED, '   ', '调整');
    const empty = fakeAgent({ output: ADJUSTED, reply: null });
    expect((await runServer(empty.agent, '调整')).error).toBeNull();
    expect(empty.record.checkpoints.explicit[0]!.task).toEqual({ signature: 'sig-1', summary: desktop.finished!.task.stats.adjustment.summary });
    expect(desktop.finished!.task.stats.adjustment.summary).toBe('全局事实已按要求调整完成。');

    const long = fakeAgent({ output: ADJUSTED, reply: '说'.repeat(5000) });
    expect((await runServer(long.agent, '调整')).error).toBeNull();
    expect((long.record.checkpoints.explicit[0]!.task!.summary as string).length).toBe(2000);
  });

  it('没有全局事实、会话不能续用时失败（文案与桌面版相同），不打开沙箱；Agent 不可用时失败', async () => {
    fake.state = baseState({ globalFacts: [] });
    const desktopEmpty = (await runDesktop(fake.state, ADJUSTED, SUMMARY, '调整')).error as Error;
    const noFacts = fakeAgent({ output: ADJUSTED });
    const empty = await runServer(noFacts.agent);
    expect((empty.error as JobError).code).toBe('TECHNICAL_PLAN_GLOBAL_FACTS_REQUIRED');
    expect((empty.error as JobError).message).toBe(desktopEmpty.message);
    expect(noFacts.record.opened).toEqual([]);
    expect(fake.lookups).toEqual([]);

    fake.state = baseState();
    fake.session = null;
    const desktopMissing = (await runDesktop(fake.state, ADJUSTED, SUMMARY, '调整', { hasSession: false })).error as Error;
    const { agent, record } = fakeAgent({ output: ADJUSTED });
    const { error } = await runServer(agent);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('TECHNICAL_PLAN_GLOBAL_FACTS_SESSION_MISSING');
    expect((error as JobError).message).toBe(desktopMissing.message);
    expect((error as JobError).message).toBe('全局事实设定的 Agent 工作空间不存在，请重新生成后再使用 AI 调整');
    expect(record.opened).toEqual([]);

    fake.session = { jobId: 'source-job', state: structuredClone(SOURCE_STATE) };
    expect(((await runServer(null)).error as JobError).code).toBe('AGENT_UNAVAILABLE');
  });

  it('续跑：用本任务的现场（不查找、不接着其他会话），只发“继续之前的任务”，不覆盖 global-facts.json；生成时的材料原件不可用时按当前输入重新放入（与生成放入的相同）', async () => {
    const resumed = fakeAgent({ output: ADJUSTED, reply: SUMMARY, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: 'global-facts-adjustment' });
    const first = await runServer(resumed.agent);
    expect(first.error).toBeNull();
    expect(fake.lookups).toEqual([]);
    expect(resumed.record.opened).toEqual([undefined]);
    expect(resumed.record.written).toEqual([]);
    expect(resumed.record.released).toEqual([]);
    expect(resumed.record.stages[0]!.prompt).toBe('继续之前的任务');
    expect(first.logs[0]).toBe('Agent 继续调整全局事实。');
    expect(fake.saved.at(-1)!.signature).toBe('sig-1');

    const generation = fakeAgent({ output: ADJUSTED });
    expect((await runServer(generation.agent, '', generationJob)).error).toBeNull();
    const unavailable = fakeAgent({ output: ADJUSTED, reply: SUMMARY, resumed: true, taskCheckpoint: { signature: 'sig-1' }, unavailable: ['项目概述.md'] });
    expect((await runServer(unavailable.agent)).error).toBeNull();
    expect(unavailable.record.written).toHaveLength(1);
    expect(unavailable.record.written[0]!.group).toBe('input');
    expect(unavailable.record.written[0]!.files).toEqual(generation.record.written[0]!.files);
    expect(unavailable.record.stages[0]!.prompt).not.toBe('继续之前的任务');

    // 重新放入材料时前置条件不满足（例如目录已被清空）：失败，文案与生成相同。
    fake.state = baseState({ outlineData: null });
    const noOutline = fakeAgent({ output: ADJUSTED, reply: SUMMARY, resumed: true, taskCheckpoint: { signature: 'sig-1' }, unavailable: ['技术方案目录.md'] });
    const failed = await runServer(noOutline.agent);
    expect(failed.error).toMatchObject({ code: 'TECHNICAL_PLAN_OUTLINE_REQUIRED', message: '请先生成目录，再生成全局事实' });
    expect(noOutline.record.stages).toEqual([]);
  });

  it('续跑时输入已变化、或写入时签名不符：TECHNICAL_PLAN_INPUT_CHANGED，不写入', async () => {
    fake.signature = 'sig-2';
    const changed = fakeAgent({ output: ADJUSTED, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: 'global-facts-adjustment' });
    expect(((await runServer(changed.agent)).error as JobError).code).toBe('TECHNICAL_PLAN_INPUT_CHANGED');
    expect(changed.record.stages).toEqual([]);
    expect(changed.record.closed).toBe(true);

    fake.signature = 'sig-1';
    fake.writeSignature = 'sig-3';
    const mismatch = fakeAgent({ output: ADJUSTED, reply: SUMMARY });
    expect(((await runServer(mismatch.agent)).error as JobError).code).toBe('TECHNICAL_PLAN_INPUT_CHANGED');
    expect(fake.saved).toEqual([]);
  });

  it('结果不可用（不是合法 JSON、不符合 Schema、没有可用分组、不存在）时为阻塞问题（问题清单与桌面版相同），不保存说明、不写入', async () => {
    for (const output of ['{"groups": [', JSON.stringify({ groups: [{ id: 'a', title: '缺内容' }] }), JSON.stringify({ groups: [{ id: 'a', title: '   ', content: 'x' }] }), '']) {
      const desktop = await runDesktop(baseState(), output, SUMMARY, '调整');
      const { agent, record } = fakeAgent({ output: output || null, reply: SUMMARY });
      const { error } = await runServer(agent, '调整');
      expect((error as JobError).code).toBe('AGENT_SUBMISSION_FAILED');
      expect(record.reports.map((report) => comparable(report, false))).toEqual(desktop.reports.map((report) => comparable(report, true)));
      expect(record.reports[0]!.issues.length).toBeGreaterThan(0);
      expect(record.checkpoints.explicit).toEqual([]);
    }
    expect(fake.saved).toEqual([]);
  });

  it('任务参数只接受去掉首尾空白、不为空、至多 2000 字的调整要求', () => {
    expect(job.parseParams({ requirement: '统一工期' })).toEqual({ requirement: '统一工期' });
    expect(job.parseParams({ requirement: '字'.repeat(2000) })).toEqual({ requirement: '字'.repeat(2000) });
    for (const bad of [{}, { requirement: '' }, { requirement: ' 统一 ' }, { requirement: '字'.repeat(2001) }, { requirement: '统一', extra: true }, null]) {
      expect(() => job.parseParams(bad)).toThrow(TypeError);
    }
  });
});
