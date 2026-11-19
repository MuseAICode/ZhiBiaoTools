// 技术方案目录调整（路线图第 8 步 8.7d，src/technicalPlan/jobs.ts 的 outline-adjustment、outlineAgent.ts）与桌面版 outlineAdjustmentTask.cjs、
// outlineGenerationTaskV2.cjs、technicalPlanOutline.cjs 的对照：Store 换成内存实现（vi.mock），会话的查找换成桩，Agent 换成脚本化的假 AgentRun
// （记下打开时接着的会话、放入工作区的文件、阶段的请求与检查点，按脚本给出 outline.json 与最后一条回复），桌面版的 agentService.runTask 用同一份
// 文件调用它自己的 validateOutput 并返回同一条回复。比较放入的 outline.json、提示词、预置 Schema、结果文件、阶段与工具、提交校验的问题清单、
// 写回 outline.json 与写入的目录（新节点的 id 由程序分配，比较时换成占位）、调整说明。另覆盖：说明取不到时用固定说明、过长时截短；没有目录、
// 会话不能续用时失败（文案与桌面版相同）；续跑用本任务的现场、只发“继续之前的任务”、不覆盖 outline.json；输入已变化时失败；结果不可用时为
// 阻塞问题；服务端新增的检查（空目录、目录上限、层级、问题条数、id 截短）；预置 Schema 与 checkSchema 时的校验与桌面版相同；参数检查。
// 数据库与接口见 tests/db/technicalPlanGlobalFacts.test.ts。
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOpenOptions, AgentRun, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import { JobError, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';

const fake = vi.hoisted(() => ({
  state: null as unknown as Record<string, any>,
  signature: 'sig-1',
  writeSignature: null as string | null,
  saved: [] as { outlineData: any; signature: string }[],
  session: null as null | { jobId: string; state: Record<string, unknown> },
  lookups: [] as unknown[],
}));

vi.mock('../../src/technicalPlan/store.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/technicalPlan/store.ts')>();
  return {
    ...original,
    outlineAdjustmentInputSignature: async () => fake.signature,
    loadTechnicalPlan: async () => structuredClone(fake.state),
    saveOutlineAdjustmentResult: async (_db: unknown, _context: unknown, _projectId: string, outlineData: unknown, signature: string) => {
      if (signature !== (fake.writeSignature ?? fake.signature)) return false;
      fake.saved.push({ outlineData: structuredClone(outlineData), signature });
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

const { createTechnicalPlanJobs, OUTLINE_ADJUSTMENT_JOB_TYPE } = await import('../../src/technicalPlan/jobs.ts');
const { buildAgentOutlineInput, OUTLINE_JSON_SCHEMA, validateOutlineOutput } = await import('../../src/technicalPlan/outlineAgent.ts');

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
const desktopAdjustment = loadDesktop('../../../client/electron/services/outlineAdjustmentTask.cjs') as { runOutlineAdjustmentTask(options: Record<string, unknown>): Promise<void> };
const desktopGeneration = loadDesktop('../../../client/electron/services/outlineGenerationTaskV2.cjs') as {
  OUTLINE_JSON_SCHEMA: unknown;
  validateOutlineOutput(content: string, knownIds?: Set<string>, options?: { checkSchema?: boolean }): { value: any; issues: { severity: string; message: string }[] };
};

// ---- 输入 ----

const ID = {
  root1: '0b3c1f0e-1d1c-4c1a-9a51-0a6b0b9f3b11',
  leaf11: '1c4d2a1f-2e2d-4d2b-8b62-1b7c1c0a4c22',
  leaf12: '2d5e3b2a-3f3e-4e3c-9c73-2c8d2d1b5d33',
  root2: '3e6f4c3b-4a4f-4f4d-ad84-3d9e3e2c6e44',
};

/** 当前目录（数据库中的形式）：带正文、来源要求与知识库条目等业务字段，标题带空白，有一节说明为空，一节为 other。 */
const OUTLINE = [
  {
    id: ID.root1,
    number: '1',
    title: ' 技术方案 ',
    description: '总体',
    children: [
      { id: ID.leaf11, number: '1.1', title: '总体设计', description: '', content_mode: 'ai-generate', content: '旧正文', source_requirement_id: 'R1', knowledge_item_ids: ['k1'] },
      { id: ID.leaf12, number: '1.2', title: '进度计划', description: '工期', content_mode: 'other', content_mode_note: ' 附甘特图 ' },
    ],
  },
  { id: ID.root2, number: '2', title: '报价', description: '报价表', content_mode: 'manual-fill' },
];

function baseState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    step: 'outline-generation',
    outlineData: { outline: structuredClone(OUTLINE), project_name: '智慧水务平台', project_overview: '某市智慧水务平台建设' },
    outlineAdjustmentTask: null,
    outlineAdjustment: null,
    outlineAdjustable: true,
    ...overrides,
  };
}

/** Agent 改写后的 outline.json：改名、删一节、在第一章下新增一节（id 为 null），一级目录带 attr。 */
const ADJUSTED = JSON.stringify({
  outline: [
    {
      id: ID.root1,
      number: '1',
      title: '技术方案 ',
      description: '总体',
      attr: '技术',
      children: [
        { id: ID.leaf11, number: '1.1', title: '总体架构设计', description: '架构', content_mode: 'ai-generate' },
        { id: null, number: '1.2', title: '质量保障', description: '质量', content_mode: 'other', content_mode_note: ' 附质量体系证书 ' },
      ],
    },
    { id: ID.root2, number: '2', title: '报价', description: '报价表', attr: '报价', content_mode: 'manual-fill' },
  ],
});

const SUMMARY = '已把总体设计改名为总体架构设计，删除进度计划并新增质量保障。';

const SOURCE_STATE: Record<string, unknown> = {
  version: 1,
  session: '2026-11-19T01-02-03-004Z_0b3c1f0e-1d1c-4c1a-9a51-0a6b0b9f3b11.jsonl',
  stage: 'outline-review',
  stageIndex: 5,
  promptedStage: 'outline-review',
  compactionPending: null,
  baseline: { version: 1, groups: {} },
  snapshot: '6f0d1b51-9b2a-4f63-8f5e-3a0a8c2d4e11',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 新节点的 id 由程序随机分配：换成占位后比较（已有节点的 id 不变）。 */
function withPlaceholderIds(value: unknown, known: ReadonlySet<string> = new Set(Object.values(ID))): unknown {
  if (Array.isArray(value)) return value.map((item) => withPlaceholderIds(item, known));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, key === 'id' && typeof item === 'string' && !known.has(item) ? (UUID.test(item) ? '<new>' : item) : withPlaceholderIds(item, known)]),
  );
}

/** 提交校验报告的对照形式：问题只比较级别与说明；不是合法 JSON 时服务端不附解析器的错误信息（只比较冒号之前的部分）。 */
function comparable(report: { value: unknown; issues: readonly { severity: string; message: string }[] }) {
  return {
    value: report.issues.length ? null : withPlaceholderIds(report.value),
    issues: report.issues.map(({ severity, message }) => ({ severity, message: message.replace(/^(outline\.json不是合法 JSON)：.*$/s, '$1') })),
  };
}

// ---- 桌面版 ----

async function runDesktop(state: Record<string, any>, outputContent: string, assistantText: string, requirement: string, options: { hasSession?: boolean } = {}) {
  const payloads: Record<string, any>[] = [];
  const reports: { value: unknown; issues: { severity: string; message: string }[] }[] = [];
  const writes: { path: string; content: string }[][] = [];
  let finished: { task: Record<string, any>; patch: Record<string, any> } | null = null;
  let savedOutline: Record<string, any> | null = null;
  const agentService = {
    hasPersistentTaskSession: () => options.hasSession ?? true,
    updatePersistentTask() {},
    async runTask(payload: Record<string, any>) {
      payloads.push(payload);
      const report = payload.validateOutput({ output_content: outputContent });
      reports.push(report);
      if (report.issues.length) throw Object.assign(new Error('submission blocked'), { report });
      await payload.continueTask({}, { validation_result: report.value, writeFiles: async (files: { path: string; content: string }[]) => writes.push(files) });
      return { validation_result: report.value, assistant_text: assistantText };
    },
  };
  let error: unknown = null;
  try {
    await desktopAdjustment.runOutlineAdjustmentTask({
      agentService,
      workspaceStore: {
        loadTechnicalPlan: () => ({ outlineData: structuredClone(state.outlineData) }),
        saveOutline: (input: { outlineData: Record<string, any>; reason: string }) => {
          savedOutline = structuredClone(input);
          return { outlineData: input.outlineData };
        },
      },
      updateTask: () => ({}),
      checkpointTask: (task: Record<string, any>, _a: unknown = {}, patch: Record<string, any> = {}) => {
        if (task.status === 'success') finished = { task: structuredClone(task), patch: structuredClone(patch) };
        return { task: { task_id: 'desktop-task', ...task } };
      },
      taskControl: { signal: new AbortController().signal },
      payload: { requirement },
    });
  } catch (caught) {
    error = caught;
  }
  return {
    payload: payloads[0]!,
    reports,
    writes,
    saved: savedOutline as { outlineData: Record<string, any>; reason: string } | null,
    finished: finished as { task: Record<string, any>; patch: Record<string, any> } | null,
    error,
  };
}

// ---- 服务端（假 AgentRun） ----

interface FakeRunOptions {
  output?: string | null;
  reply?: string | null;
  resumed?: boolean;
  taskCheckpoint?: Record<string, unknown> | null;
  promptedStage?: string | null;
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
    unavailableProtectedFiles: [],
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

const job = createTechnicalPlanJobs().find((item) => item.type === OUTLINE_ADJUSTMENT_JOB_TYPE)! as JobTypeDefinition<any>;

async function runServer(agent: JobAgent | null, requirement = '把总体设计改名为总体架构设计') {
  const logs: string[] = [];
  const context: JobContext<any> = {
    jobId: 'job-1',
    projectId: 'project-1',
    type: job.type,
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
  fake.signature = 'sig-1';
  fake.writeSignature = null;
  fake.saved = [];
  fake.session = { jobId: 'source-job', state: structuredClone(SOURCE_STATE) };
  fake.lookups = [];
});

describe('目录调整（与桌面版 outlineAdjustmentTask.cjs 对照）', () => {
  it('接着生成的会话；outline.json、提示词、阶段、预置 Schema、结果文件与工具和桌面版相同；写回的 outline.json、写入的目录与说明相同', async () => {
    const requirement = '把总体设计改名为总体架构设计';
    const desktop = await runDesktop(baseState(), ADJUSTED, SUMMARY, requirement);
    expect(desktop.error).toBeNull();
    const { agent, record } = fakeAgent({ output: ADJUSTED, reply: `  ${SUMMARY}\n` });
    const server = await runServer(agent, requirement);
    expect(server.error).toBeNull();

    expect(fake.lookups).toEqual([{ projectId: 'project-1', taskKind: 'technical-plan-outline-generation', jobTypes: ['outline-generation', 'outline-adjustment'] }]);
    expect(record.opened).toEqual([{ continueFrom: SOURCE_STATE }]);

    // 当前目录写入 outline.json（只含结构字段），交给 Agent 修改（写入后解除登记）。
    expect(record.written[0]!.group).toBe('outline-output');
    expect(record.written[0]!.options).toMatchObject({ replace: true });
    expect(record.written[0]!.files).toEqual(desktop.payload.files);
    expect(record.written[0]!.files[0]!.content).not.toContain('旧正文');
    expect(record.written[0]!.files[0]!.content).not.toContain('k1');
    expect(record.released[0]).toEqual({ group: 'outline-output', paths: ['outline.json'] });

    const stage = record.stages[0]!;
    expect(stage.prompt).toBe(desktop.payload.prompt);
    expect(stage.prompt).toContain(`用户的调整要求：\n${requirement}`);
    expect(stage.stage).toBe(desktop.payload.initial_stage);
    expect(stage.outputFile).toBe(desktop.payload.output_file);
    expect(stage.maxExecutionRetries).toBe(desktop.payload.max_retries);
    expect(stage.jsonSchemas).toEqual(desktop.payload.json_validation_schemas);
    expect(stage.tools).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'json-validation', 'ask-user', 'request-termination']);
    expect(record.reports.map(comparable)).toEqual(desktop.reports.map(comparable));
    expect(record.reports[0]!.issues).toEqual([]);
    expect(record.checkpoints.after).toEqual({ signature: 'sig-1' });

    // 与桌面版 continueTask 相同写回整理后的 outline.json（新节点已分配 id）。
    expect(record.written).toHaveLength(2);
    expect(record.released[1]).toEqual({ group: 'outline-output', paths: ['outline.json'] });
    const writtenBack = JSON.parse(record.written[1]!.files[0]!.content);
    expect(withPlaceholderIds(writtenBack)).toEqual(withPlaceholderIds(JSON.parse(desktop.writes[0]![0]!.content)));
    expect(writtenBack.outline[0].children[1].id).toMatch(UUID);

    expect(record.checkpoints.explicit).toEqual([{ task: { signature: 'sig-1', summary: desktop.finished!.task.stats.adjustment.summary }, progress: 95 }]);
    expect(desktop.finished!.task.stats.adjustment).toEqual({ requirement, summary: SUMMARY });
    expect(record.closed).toBe(true);

    // 写入的目录与桌面版 saveOutline 收到的相同（项目名称、概述沿用原目录的；桌面版用 replace 清空正文）。
    expect(desktop.saved!.reason).toBe('replace');
    expect(fake.saved).toHaveLength(1);
    expect(fake.saved[0]!.signature).toBe('sig-1');
    expect(withPlaceholderIds(fake.saved[0]!.outlineData)).toEqual(withPlaceholderIds(desktop.saved!.outlineData));
    // 写回工作区的与写入数据库的是同一份（同一个新 id）。
    expect(fake.saved[0]!.outlineData.outline).toEqual(writtenBack.outline);

    expect(server.logs).toEqual(['开始 AI 调整目录', 'Agent 正在调整目录。', '目录 AI 调整完成']);
    expect(desktop.finished!.task.logs).toEqual(['开始 AI 调整目录', '目录 AI 调整完成']);
    expect(server.logs.join('\n')).not.toContain(SUMMARY);
    expect(server.logs.join('\n')).not.toContain(requirement);
  });

  it('buildAgentOutlineInput：只保留结构字段，说明为空时取标题，other 方式才带说明', () => {
    expect(buildAgentOutlineInput(OUTLINE as never)).toEqual({
      outline: [
        {
          id: ID.root1,
          number: '1',
          title: '技术方案',
          description: '总体',
          children: [
            { id: ID.leaf11, number: '1.1', title: '总体设计', description: '总体设计', content_mode: 'ai-generate' },
            { id: ID.leaf12, number: '1.2', title: '进度计划', description: '工期', content_mode: 'other', content_mode_note: '附甘特图' },
          ],
        },
        { id: ID.root2, number: '2', title: '报价', description: '报价表', content_mode: 'manual-fill' },
      ],
    });
  });

  it('取不到回复时说明为桌面版的固定说明；过长的回复截到 2000 字', async () => {
    const desktop = await runDesktop(baseState(), ADJUSTED, '   ', '调整');
    const empty = fakeAgent({ output: ADJUSTED, reply: null });
    expect((await runServer(empty.agent, '调整')).error).toBeNull();
    expect(empty.record.checkpoints.explicit[0]!.task).toEqual({ signature: 'sig-1', summary: desktop.finished!.task.stats.adjustment.summary });
    expect(desktop.finished!.task.stats.adjustment.summary).toBe('目录已按要求调整完成。');

    const long = fakeAgent({ output: ADJUSTED, reply: '说'.repeat(5000) });
    expect((await runServer(long.agent, '调整')).error).toBeNull();
    expect((long.record.checkpoints.explicit[0]!.task!.summary as string).length).toBe(2000);
  });

  it('没有目录、会话不能续用时失败（文案与桌面版相同），不打开沙箱；Agent 不可用时失败', async () => {
    fake.state = baseState({ outlineData: null });
    const desktopEmpty = (await runDesktop(fake.state, ADJUSTED, SUMMARY, '调整')).error as Error;
    const noOutline = fakeAgent({ output: ADJUSTED });
    const empty = await runServer(noOutline.agent);
    expect(empty.error).toMatchObject({ code: 'TECHNICAL_PLAN_OUTLINE_REQUIRED', message: desktopEmpty.message });
    expect(noOutline.record.opened).toEqual([]);
    expect(fake.lookups).toEqual([]);

    fake.state = baseState();
    fake.session = null;
    const desktopMissing = (await runDesktop(fake.state, ADJUSTED, SUMMARY, '调整', { hasSession: false })).error as Error;
    const { agent, record } = fakeAgent({ output: ADJUSTED });
    const { error } = await runServer(agent);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: 'TECHNICAL_PLAN_OUTLINE_SESSION_MISSING', message: desktopMissing.message });
    expect((error as JobError).message).toBe('目录生成的 Agent 工作空间不存在，请重新生成目录后再使用 AI 调整');
    expect(record.opened).toEqual([]);

    fake.session = { jobId: 'source-job', state: structuredClone(SOURCE_STATE) };
    expect(((await runServer(null)).error as JobError).code).toBe('AGENT_UNAVAILABLE');
  });

  it('续跑：用本任务的现场（不查找），只发“继续之前的任务”，不覆盖 outline.json；输入已变化或写入时签名不符：TECHNICAL_PLAN_INPUT_CHANGED', async () => {
    const resumed = fakeAgent({ output: ADJUSTED, reply: SUMMARY, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: 'outline-adjustment' });
    const first = await runServer(resumed.agent);
    expect(first.error).toBeNull();
    expect(fake.lookups).toEqual([]);
    expect(resumed.record.opened).toEqual([undefined]);
    // 只有校验通过后的写回。
    expect(resumed.record.written).toHaveLength(1);
    expect(resumed.record.stages[0]!.prompt).toBe('继续之前的任务');
    expect(first.logs[0]).toBe('Agent 继续调整目录。');

    fake.signature = 'sig-2';
    const changed = fakeAgent({ output: ADJUSTED, resumed: true, taskCheckpoint: { signature: 'sig-1' }, promptedStage: 'outline-adjustment' });
    expect(((await runServer(changed.agent)).error as JobError).code).toBe('TECHNICAL_PLAN_INPUT_CHANGED');
    expect(changed.record.stages).toEqual([]);
    expect(changed.record.closed).toBe(true);

    fake.signature = 'sig-1';
    fake.writeSignature = 'sig-3';
    fake.saved = [];
    const mismatch = fakeAgent({ output: ADJUSTED, reply: SUMMARY });
    expect(((await runServer(mismatch.agent)).error as JobError).code).toBe('TECHNICAL_PLAN_INPUT_CHANGED');
    expect(fake.saved).toEqual([]);
  });

  it('结果不可用（为空、不是合法 JSON、结构错误、未知 / 重复的 id）时为阻塞问题（问题清单与桌面版相同），不保存说明、不写入', async () => {
    const outputs = [
      '',
      '{"outline": [',
      JSON.stringify({ outline: 'x' }),
      JSON.stringify({ outline: [null, 3] }),
      JSON.stringify({ outline: [{ id: randomUUID(), title: '未知' }] }),
      JSON.stringify({ outline: [{ id: ID.root1, title: 'a' }, { id: ID.root1, title: 'b' }] }),
      JSON.stringify({ outline: [{ title: '缺 id' }] }),
      JSON.stringify({ outline: [{ id: ID.root1, title: 'a', children: 'xy' }] }),
    ];
    for (const output of outputs) {
      const desktop = await runDesktop(baseState(), output, SUMMARY, '调整');
      const { agent, record } = fakeAgent({ output: output || null, reply: SUMMARY });
      const { error } = await runServer(agent, '调整');
      expect((error as JobError).code, output).toBe('AGENT_SUBMISSION_FAILED');
      expect(record.reports.map(comparable), output).toEqual(desktop.reports.map(comparable));
      expect(record.reports[0]!.issues.length).toBeGreaterThan(0);
      expect(record.checkpoints.explicit).toEqual([]);
    }
    expect(fake.saved).toEqual([]);
  });

  it('服务端新增的检查：整理后为空、处理方式不在列表中、超过层级为阻塞问题；问题至多 200 条；问题说明中的 id 截短', async () => {
    const known = new Set(Object.values(ID));
    for (const output of [JSON.stringify({ outline: [] }), JSON.stringify({}), 'null']) {
      // 桌面版接受为空目录（保存时即删除目录）。
      expect(desktopGeneration.validateOutlineOutput(output, known, { checkSchema: false }).issues).toEqual([]);
      expect(validateOutlineOutput(output, known, { checkSchema: false }).issues).toEqual([{ severity: 'blocking', message: 'outline.json 中没有目录节点，请写入完整目录' }]);
    }
    const badMode = validateOutlineOutput(JSON.stringify({ outline: [{ id: null, title: 'a', content_mode: 'magic' }] }), known, { checkSchema: false });
    expect(badMode.issues[0]!.message).toMatch(/^outline\.json 超出限制：处理方式不合法/);

    let deep: Record<string, unknown> = { id: null, title: 'leaf' };
    for (let level = 0; level < 12; level += 1) deep = { id: null, title: `l${level}`, children: [deep] };
    const tooDeep = validateOutlineOutput(JSON.stringify({ outline: [deep] }), known, { checkSchema: false });
    expect(tooDeep.issues).toHaveLength(1);
    expect(tooDeep.issues[0]!.message).toMatch(/超过 10 级$/);

    const many = validateOutlineOutput(JSON.stringify({ outline: Array.from({ length: 500 }, (_, index) => ({ id: `x${index}`, title: 't' })) }), known, { checkSchema: false });
    expect(many.issues).toHaveLength(200);
    expect(many.issues.at(-1)!.message).toBe('outline.json 另有 301 个问题');

    const longId = validateOutlineOutput(JSON.stringify({ outline: [{ id: 'i'.repeat(5000), title: 't' }] }), known, { checkSchema: false });
    expect(longId.issues[0]!.message).toBe(`目录包含未知 ID：${'i'.repeat(100)}…；新节点请使用 id:null`);
  });

  it('预置 Schema 与桌面版相同；checkSchema 时（8.7e 的目录生成）问题清单与桌面版相同', () => {
    expect(OUTLINE_JSON_SCHEMA).toEqual(desktopGeneration.OUTLINE_JSON_SCHEMA);
    const known = new Set(Object.values(ID));
    for (const output of [
      ADJUSTED,
      JSON.stringify({ outline: [{ id: null, number: '1', title: '商务', description: '资信', attr: '商务/资信', content_mode: 'ai-generate' }] }),
      JSON.stringify({ outline: [{ id: null, title: '', description: 'x', attr: '技术', content_mode: 'ai-generate' }] }),
      JSON.stringify({ outline: [{ id: null, title: 'a', description: 'b', attr: '技术', content_mode: 'ai-generate' }] }),
    ]) {
      expect(comparable(validateOutlineOutput(output, known)), output).toEqual(comparable(desktopGeneration.validateOutlineOutput(output, known)));
    }
  });

  it('任务参数只接受去掉首尾空白、不为空、至多 2000 字的调整要求', () => {
    expect(job.parseParams({ requirement: '删去进度计划' })).toEqual({ requirement: '删去进度计划' });
    expect(job.parseParams({ requirement: '字'.repeat(2000) })).toEqual({ requirement: '字'.repeat(2000) });
    for (const bad of [{}, { requirement: '' }, { requirement: ' 删去 ' }, { requirement: '字'.repeat(2001) }, { requirement: '删去', extra: true }, null]) {
      expect(() => job.parseParams(bad)).toThrow(TypeError);
    }
  });
});
