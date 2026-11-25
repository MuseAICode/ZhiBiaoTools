// 技术方案正文生成的基础编排阶段（路线图第 8 步 8.10b1，src/technicalPlan/contentGenerationJob.ts、contentPlanning.ts）与桌面版
// contentGenerationTask.cjs（runContentGenerationTask 的基础编排：preparePlanning、createContentPlanningStage、persistContentPlans）、
// contentGenerationAgent.cjs（基础编排阶段的 runTask 请求）的对照：Store 换成内存实现（vi.mock），Agent 换成脚本化的假 AgentRun（记下放入
// 工作区的文件、阶段的请求与检查点，按脚本给出 正文编排结果.json），桌面版的 agentService.runTask 用同一份文件调用它自己的
// validateOutput / continueTask，在进入正文写作阶段（取模板）时停下。比较开始时的检查、日志、放入的材料、提示词、预置 Schema、工具、
// 结果文件、提交校验的问题清单、保存的编排与运行进度（字数分配、表格与配图选择、复用、目录变更后的新增小节、全文重新生成）。另覆盖：
// 续跑、输入已变化、编排已保存后的续跑、会话的续用与丢弃、后续阶段的固定错误、失败后重试（8.10b2，与桌面版 retryFailedSections 的
// continuingPlanning 对照）。数据库与接口见 tests/db/technicalPlanContentGeneration.test.ts。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOpenOptions, AgentRun, AgentStageOptions, JobAgent } from '../../src/agent/execution.ts';
import { JobError, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';

const fake = vi.hoisted(() => ({
  state: null as unknown as Record<string, any>,
  signature: 'sig-1',
  writeSignature: null as string | null,
  saved: [] as { input: any; signature: string }[],
  knowledge: [] as { documentId: string; itemId: string; title: string; resume: string; content: string }[],
  discarded: [] as unknown[],
  continuable: null as unknown,
  continuationQueries: 0,
  retry: null as unknown,
  retryQueries: 0,
}));

vi.mock('../../src/technicalPlan/store.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/technicalPlan/store.ts')>();
  return {
    ...original,
    contentGenerationInputSignature: async () => fake.signature,
    loadTechnicalPlan: async () => structuredClone(fake.state),
    readGlobalFactsKnowledgeItems: async () => structuredClone(fake.knowledge),
    contentGenerationRetrySource: async () => {
      fake.retryQueries += 1;
      return structuredClone(fake.retry);
    },
    saveContentPlanningResult: async (_db: unknown, _context: unknown, _projectId: string, input: unknown, signature: string) => {
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

vi.mock('../../src/agent/continuation.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/agent/continuation.ts')>();
  return {
    ...original,
    findContinuableAgentSession: async () => {
      fake.continuationQueries += 1;
      return fake.continuable;
    },
  };
});

const { createTechnicalPlanJobs, CONTENT_GENERATION_JOB_TYPE } = await import('../../src/technicalPlan/jobs.ts');
const { CONTENT_PLANNING_JSON_SCHEMA, validateContentPlanningOutput } = await import('../../src/technicalPlan/contentPlanning.ts');

// 桌面版依赖 client/ 的 ajv、cheerio 等（CI 的 server 任务不安装 client/ 的依赖）：ajv 换成 server/ 中同一版本（8.20.0）的，只在基础编排之后
// 的阶段用到的 cheerio、docx、electron、image-size、mime-types 换成桩（任意属性与调用都返回桩本身，模块加载时读取的常量不报错），
// 其余模块用桌面版原文件。
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
const desktop = loadDesktop('../../../client/electron/services/contentGenerationTask.cjs') as {
  runContentGenerationTask(options: Record<string, unknown>): Promise<void>;
};

// ---- 输入 ----

const ROOT_A = '00000000-0000-4000-8000-00000000000a';
const ROOT_B = '00000000-0000-4000-8000-00000000000b';
const LEAF = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const MANUAL = '00000000-0000-4000-8000-0000000000ff';
const AI_LEAVES = [LEAF(1), LEAF(2), LEAF(3), LEAF(4), LEAF(5), LEAF(6)];

const OUTLINE = [
  {
    id: ROOT_A,
    number: '1',
    title: '总体设计',
    description: '总体',
    children: [
      { id: LEAF(1), number: '1.1', title: '建设目标', description: '目标', content_mode: 'ai-generate' },
      { id: LEAF(2), number: '1.2', title: '总体架构', description: '', content_mode: 'ai-generate', content_mode_note: ' 结合现状 ' },
      { id: MANUAL, number: '1.3', title: '资质证书', description: '证书', content_mode: 'manual-fill' },
    ],
  },
  {
    id: ROOT_B,
    number: '2',
    title: '实施方案',
    description: '实施',
    children: [
      { id: LEAF(3), number: '2.1', title: '实施计划', description: '计划', content_mode: 'ai-generate' },
      { id: LEAF(4), number: '2.2', title: '质量保障', description: '质量', content_mode: 'ai-generate' },
      { id: LEAF(5), number: '2.3', title: '培训方案', description: '培训', content_mode: 'ai-generate' },
      { id: LEAF(6), number: '2.4', title: '售后服务', description: '售后', content_mode: 'ai-generate' },
    ],
  },
];

const OPTIONS = {
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
  htmlImageTypes: '流程图',
  tableRequirement: 'light',
};

function baseState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    projectOverview: '解析出的项目概述',
    bidAnalysisTasks: {
      projectInfo: { id: 'projectInfo', status: 'success', content: '项目名称：智慧水务' },
      partAInfo: { id: 'partAInfo', status: 'error', content: '失败的不放入' },
      deliveryAndServiceRequirements: { id: 'deliveryAndServiceRequirements', status: 'success', content: '工期 90 天' },
    },
    originalPlanFile: null,
    outlineData: { outline: structuredClone(OUTLINE), project_overview: '目录中的项目概述' },
    outlineWordControlSnapshot: { minimumWords: 30000, maximumWords: 50000, sectionWords: 3000 },
    globalFacts: [{ id: 'g1', title: '项目团队', content: '项目经理 1 名' }],
    referenceKnowledgeDocumentIds: ['doc-1'],
    contentGenerationOptions: { ...OPTIONS },
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentGenerationRuntime: null,
    ...overrides,
  };
}

const KNOWLEDGE = [
  { documentId: 'doc-1', itemId: 'K000001', title: '运维体系', resume: '7×24 运维', content: '正文' },
  { documentId: 'doc-1', itemId: 'K000002', title: '培训', resume: '', content: '没有简介的不用' },
  { documentId: 'doc-1', itemId: 'K000003', title: '质量管理', resume: 'ISO 9001', content: '正文' },
];

/** 桌面版 storedPlan（与 baseState 同一份输入）。 */
function storedPlanOf(state: Record<string, any>): Record<string, unknown> {
  return {
    projectOverview: state.projectOverview,
    bidAnalysisTasks: state.bidAnalysisTasks,
    outlineData: state.outlineData,
    outlineWordControlSnapshot: state.outlineWordControlSnapshot,
    globalFacts: state.globalFacts,
    globalFactsTask: { status: 'success' },
    referenceKnowledgeDocumentIds: state.referenceKnowledgeDocumentIds,
    contentGenerationOptions: state.contentGenerationOptions,
    contentGenerationSections: state.contentGenerationSections,
    contentGenerationPlans: state.contentGenerationPlans,
    contentGenerationRuntime: state.contentGenerationRuntime ?? undefined,
  };
}

/** Agent 写出的编排：目标按 ids，第 n 个的字数为 (n + 1) × 1000，配图评分与表格按 spec。 */
function planningOutput(ids: readonly string[], spec: (id: string, index: number) => Record<string, unknown> = () => ({})): string {
  return JSON.stringify({
    plans: ids.map((id, index) => ({
      id,
      content_plan: {
        writing_focus: `  第 ${index + 1} 节的\n写作重点 `,
        target_words: (index + 1) * 1000,
        image_suitability_score: [8, 0, 5, 9, 5, 3][index % 6],
        knowledge: { item_ids: index % 2 ? ['doc-1::K000001'] : [] },
        table: index % 2 ? { needed: true, purpose: ' 对比各项措施 ' } : { needed: false, purpose: '' },
        ...spec(id, index),
      },
    })),
  });
}

// ---- 桌面版 ----

const TEMPLATE_REACHED = 'desktop reached content generation';
const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

interface DesktopRun {
  payload: Record<string, any> | null;
  report: { value: unknown; issues: { severity: string; message: string }[] } | null;
  logs: string[];
  plans: Record<string, any> | null;
  runtime: Record<string, any> | null;
  reachedGeneration: boolean;
  error: unknown;
}

/** 运行桌面版：基础编排阶段用给出的结果文件调用它自己的 validateOutput / continueTask；进入正文写作（取模板）时停下。 */
async function runDesktop(state: Record<string, any>, output: string | null, payload: Record<string, unknown> = {}, session: Record<string, unknown> | null = null): Promise<DesktopRun> {
  const result: DesktopRun = { payload: null, report: null, logs: [], plans: null, runtime: null, reachedGeneration: false, error: null };
  const workspace = mkdtempSync(join(tmpdir(), 'content-planning-'));
  workspaces.push(workspace);
  const record = (partial: Record<string, any>, workspacePartial: Record<string, any> = {}) => {
    if (Array.isArray(partial.logs) && partial.logs.length >= result.logs.length) result.logs = [...partial.logs];
    if (workspacePartial.contentGenerationPlans) result.plans = structuredClone(workspacePartial.contentGenerationPlans);
    const runtime = workspacePartial.contentGenerationRuntime;
    if (runtime?.completed_stages?.includes('planning') && runtime.phase === 'planning') result.runtime = structuredClone(runtime);
    return { task: partial };
  };
  const agentService = {
    hasPersistentTaskSession: () => session !== null,
    loadPersistentTask: () => (session ? { state: structuredClone(session), paths: { workspaceDir: workspace } } : null),
    updatePersistentTask() {},
    async runTask(request: Record<string, any>) {
      if (request.initial_stage !== 'content-planning') {
        // 没有编排目标时直接进入正文写作：取模板时停下。
        await request.create_tools?.({ workspaceDir: workspace, baseline: null, setActiveTools() {} });
        throw new Error('unexpected desktop stage');
      }
      result.payload = request;
      if (output !== null) writeFileSync(join(workspace, request.output_file === '正文生成结果.json' ? '正文编排结果.json' : request.output_file), output);
      const report = request.validateOutput({}, { workspace_dir: workspace });
      result.report = report;
      if (report.issues.length) throw Object.assign(new Error('submission blocked'), { report });
      return request.continueTask({}, { workspace_dir: workspace, validation_result: report.value, writeFiles: async () => {} });
    },
  };
  try {
    await desktop.runContentGenerationTask({
      aiService: { getConfig: () => ({ concurrency_limit: 10 }), isDeveloperMode: () => false },
      agentService,
      workspaceStore: { loadTechnicalPlan: () => structuredClone(storedPlanOf(state)) },
      knowledgeBaseService: {
        readReferences: (ids: string[]) =>
          ids.map((id) => ({
            document: { id, status: 'success' },
            items: fake.knowledge.filter((item) => item.documentId === id).map((item) => ({ id: item.itemId, title: item.title, resume: item.resume })),
          })),
      },
      templateStore: {
        getTemplate: () => {
          result.reachedGeneration = true;
          throw new Error(TEMPLATE_REACHED);
        },
      },
      openXmlHelperService: null,
      updateTask: (partial: Record<string, any>, workspacePartial?: Record<string, any>) => record(partial, workspacePartial),
      checkpointTask: (partial: Record<string, any>, workspacePartial?: Record<string, any>) => record(partial, workspacePartial),
      taskControl: { signal: new AbortController().signal, isPauseRequested: () => false },
      payload,
      previousState: {},
    });
  } catch (error) {
    result.error = error;
  }
  // 桌面版的“文本模型并发上限”一条随 8.10c 的写作阶段（Web 版的并发由组织的 AI 设置决定）。
  result.logs = result.logs.filter((line) => !line.startsWith('文本模型并发上限'));
  return result;
}

/** 桌面版保存的编排去掉时间（Web 版由数据库写入）。 */
function withoutTimes(plans: Record<string, any> | null): Record<string, any> | null {
  if (!plans) return null;
  return Object.fromEntries(Object.entries(plans).map(([id, { updated_at: _time, ...plan }]) => [id, plan]));
}

// ---- 服务端（假 AgentRun） ----

interface FakeRun {
  opened: AgentOpenOptions[];
  written: { group: string; files: { path: string; content: string }[]; options: unknown }[];
  released: { group: string; paths: readonly string[] }[];
  stages: AgentStageOptions<unknown>[];
  reports: { value: unknown; issues: readonly { severity: string; message: string }[] }[];
  checkpoints: { after: Record<string, unknown> | null; explicit: { task: Record<string, unknown> | null; progress?: number }[] };
}

function fakeAgent(
  options: { output?: string | null; resumed?: boolean; promptedStage?: string | null; unavailable?: string[] } = {},
): { agent: JobAgent; record: FakeRun } {
  const record: FakeRun = { opened: [], written: [], released: [], stages: [], reports: [], checkpoints: { after: null, explicit: [] } };
  const resumed = options.resumed ?? false;
  const run = {
    sandbox: { id: 'sandbox-1' },
    resumed,
    // 与执行者相同：给出 continueFrom 时为接着另一个任务的会话。
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
    async checkpoint(task: Record<string, unknown> | null, progress?: number) {
      record.checkpoints.explicit.push({ task: structuredClone(task), ...(progress !== undefined ? { progress } : {}) });
    },
    async close() {},
  };
  return {
    agent: {
      template: 'agent',
      resuming: resumed,
      open: async (openOptions?: AgentOpenOptions) => {
        record.opened.push(openOptions ?? {});
        run.continued = openOptions?.continueFrom !== undefined;
        return run as unknown as AgentRun;
      },
    },
    record,
  };
}

const job = createTechnicalPlanJobs().find((item) => item.type === CONTENT_GENERATION_JOB_TYPE)! as JobTypeDefinition<any>;

async function runServer(agent: JobAgent | null, options: { checkpoint?: Record<string, unknown> | null; regenerate?: boolean; retryOf?: string } = {}) {
  const logs: string[] = [];
  const savedCheckpoints: Record<string, unknown>[] = [];
  const context: JobContext<any> = {
    jobId: 'job-1',
    projectId: 'project-1',
    type: job.type,
    attempt: 1,
    params: job.parseParams({ regenerate: options.regenerate ?? false, ...(options.retryOf ? { retryOf: options.retryOf } : {}) }),
    checkpoint: options.checkpoint ?? null,
    tenant: { orgId: 'org-1', userId: 'user-1', role: 'owner' },
    db: null as never,
    signal: new AbortController().signal,
    async setProgress() {},
    async saveCheckpoint(checkpoint) {
      savedCheckpoints.push(structuredClone(checkpoint));
    },
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
    return { logs, savedCheckpoints, error: null as unknown };
  } catch (error) {
    return { logs, savedCheckpoints, error };
  }
}

const STAGE_UNAVAILABLE = { code: 'TECHNICAL_PLAN_CONTENT_STAGE_UNAVAILABLE' };

/** 两边各运行一次，比较基础编排的全部可见结果。 */
async function compare(output: string, payload: Record<string, unknown> = {}) {
  const desktopRun = await runDesktop(fake.state, output, payload);
  expect(desktopRun.reachedGeneration).toBe(true);
  const { agent, record } = fakeAgent({ output });
  const server = await runServer(agent, { regenerate: payload.regenerate === true });
  expect(server.error).toMatchObject(STAGE_UNAVAILABLE);
  const request = desktopRun.payload!;
  // 材料：桌面版的 files 中预置的空结果文件，Web 版另写在交给 Agent 的分组中（解除登记）。
  expect(record.written[0]).toMatchObject({ group: 'content-planning-inputs', options: { replace: true } });
  expect(record.written[0]!.files).toEqual(request.files.filter((file: { path: string }) => file.path !== '正文编排结果.json'));
  expect(request.files.find((file: { path: string }) => file.path === '正文编排结果.json')).toEqual({ path: '正文编排结果.json', content: '' });
  expect(record.written[1]).toMatchObject({ group: 'content-planning-output', files: [{ path: '正文编排结果.json', content: '' }] });
  expect(record.released).toEqual([{ group: 'content-planning-output', paths: ['正文编排结果.json'] }]);
  expect(request.prepare_output_files).toEqual(['正文编排结果.json']);
  const stage = record.stages[0]!;
  expect(stage.stage).toBe(request.initial_stage);
  expect(stage.prompt).toBe(request.prompt);
  expect(stage.outputFile).toBe('正文编排结果.json');
  expect(stage.jsonSchemas).toEqual({ '正文编排结果.json': request.json_validation_schemas['正文编排结果.json'] });
  // 顶层任务的 report-failure 是需用户确认的 request-termination（与 8.7 各任务相同）。
  expect(stage.tools).toEqual(request.active_tools.map((tool: string) => (tool === 'report-failure' ? 'request-termination' : tool)));
  expect(stage.maxExecutionRetries).toBe(request.max_retries);
  expect(await stage.retryPrompt!({ reason: 'x', attempt: 1, maxRetries: 1 })).toBe(request.buildRetryPrompt({ kind: 'execution' }, {}));
  expect(record.reports[0]!.issues).toEqual([]);
  expect(fake.saved).toHaveLength(1);
  expect(fake.saved[0]!.input.plans).toEqual(withoutTimes(desktopRun.plans));
  const { updated_at: _serverTime, ...serverRuntime } = fake.saved[0]!.input.runtime;
  const { updated_at: _desktopTime, ...desktopRuntime } = desktopRun.runtime!;
  expect(serverRuntime).toEqual(JSON.parse(JSON.stringify(desktopRuntime)));
  expect(desktopRun.logs.slice(0, server.logs.length)).toEqual(server.logs);
  return { desktopRun, server, record };
}

beforeEach(() => {
  fake.state = baseState();
  fake.signature = 'sig-1';
  fake.writeSignature = null;
  fake.saved = [];
  fake.knowledge = structuredClone(KNOWLEDGE);
  fake.discarded = [];
  fake.continuable = null;
  fake.continuationQueries = 0;
  fake.retry = null;
  fake.retryQueries = 0;
});

describe('正文生成：基础编排（与桌面版 runContentGenerationTask 对照）', () => {
  it('首次生成（全文字数目标、表格“少量”、配图 50%、知识库）：材料、提示词、Schema、工具、日志、字数分配、表格与配图选择、保存的编排与运行进度和桌面版相同', async () => {
    const { server, record } = await compare(planningOutput(AI_LEAVES));
    // 字数按比例校正到本次合计（全文基准 40000 字）；表格上限 floor(6 × 0.2) = 1，从 3 个候选中均匀选 1 个；配图名额 3 个。
    const plans = fake.saved[0]!.input.plans;
    expect(AI_LEAVES.reduce((sum, id) => sum + plans[id].plan.target_words, 0)).toBe(40000);
    expect(AI_LEAVES.filter((id) => plans[id].plan.table.needed)).toEqual([LEAF(4)]);
    expect(AI_LEAVES.filter((id) => plans[id].plan.image_needed)).toEqual([LEAF(1), LEAF(3), LEAF(4)]);
    expect(Object.values(plans).every((plan: any) => plan.plan_version === 6 && plan.table_requirement === 'light')).toBe(true);
    expect(plans[LEAF(2)].plan.writing_focus).toBe('第 2 节的 写作重点');
    // 只有标题与简介都不为空的知识库条目。
    expect(JSON.parse(record.written[0]!.files[0]!.content)).toEqual([
      { id: 'doc-1::K000001', title: '运维体系', resume: '7×24 运维' },
      { id: 'doc-1::K000003', title: '质量管理', resume: 'ISO 9001' },
    ]);
    expect(server.logs).toContain('正文编排已读取 2 条知识库轻量条目。');
    expect(record.checkpoints.after).toEqual({ signature: 'sig-1', planningTargetIds: AI_LEAVES });
    expect(record.checkpoints.explicit).toEqual([{ task: { signature: 'sig-1', planningTargetIds: AI_LEAVES, planned: true }, progress: 15 }]);
    expect(record.opened).toEqual([{}]);
  });

  it('提交校验的问题清单与桌面版相同（不是合法 JSON 时不附解析器的错误信息）', async () => {
    const cases: string[] = [
      '{"plans": [',
      JSON.stringify({ plans: [{ id: LEAF(1) }] }),
      JSON.stringify({ outline: [] }),
      planningOutput([...AI_LEAVES, MANUAL]),
      planningOutput([...AI_LEAVES, LEAF(1)]),
      planningOutput(AI_LEAVES.slice(1)),
      planningOutput(AI_LEAVES, (_id, index) => (index === 2 ? { knowledge: { item_ids: ['doc-1::K000002'] } } : {})),
      planningOutput(AI_LEAVES, (_id, index) => (index === 3 ? { table: { needed: true, purpose: '   ' } } : {})),
      planningOutput(AI_LEAVES, (_id, index) => (index === 0 ? { table: { needed: false, purpose: '多余' } } : {})),
      planningOutput(AI_LEAVES, (_id, index) => (index === 4 ? { target_words: 0 } : {})),
      planningOutput(AI_LEAVES, (_id, index) => (index === 4 ? { writing_focus: '   ' } : {})),
      planningOutput(AI_LEAVES, () => ({ image_suitability_score: 11, extra: true })),
    ];
    for (const output of cases) {
      const desktopRun = await runDesktop(fake.state, output);
      expect(desktopRun.report?.issues.length).toBeGreaterThan(0);
      const { agent, record } = fakeAgent({ output });
      const server = await runServer(agent);
      expect(server.error).toMatchObject({ code: 'AGENT_SUBMISSION_FAILED' });
      const desktopIssues = desktopRun.report!.issues.map(({ severity, message }) => ({ severity, message: message.replace(/^(正文编排结果\.json不是合法 JSON)：.*$/s, '$1') }));
      expect(record.reports[0]!.issues).toEqual(desktopIssues);
      expect(fake.saved).toEqual([]);
    }
    // 结果文件还不存在。
    const report = validateContentPlanningOutput(null, { outline: OUTLINE as never, allowedKnowledgeItemIds: new Set(), targetItemIds: AI_LEAVES, wordControl: { minimumWords: 0, maximumWords: 0, sectionWords: 0 }, totalSections: 6, isIncremental: false });
    expect(report.issues).toEqual([{ severity: 'blocking', message: '正文编排结果.json 尚未生成，请按本阶段要求保存结果。' }]);
  });

  it('全文目标字数不足以分配时为阻塞问题（与桌面版相同）', async () => {
    fake.state = baseState({ outlineWordControlSnapshot: { minimumWords: 3, maximumWords: 0, sectionWords: 0 } });
    const output = planningOutput(AI_LEAVES);
    const desktopRun = await runDesktop(fake.state, output);
    const { agent, record } = fakeAgent({ output });
    await runServer(agent);
    expect(record.reports[0]!.issues).toEqual(desktopRun.report!.issues.map(({ severity, message }) => ({ severity, message })));
    expect(record.reports[0]!.issues[0]!.message).toContain('正文目标字数不足');
  });

  it('没有全文字数目标：每节按建议字数；表格“大量”保持候选；无知识库；招标关键信息与桌面版相同', async () => {
    fake.state = baseState({
      outlineWordControlSnapshot: { minimumWords: 0, maximumWords: 0, sectionWords: 2500 },
      contentGenerationOptions: { ...OPTIONS, tableRequirement: 'heavy', imageQuantity: 0 },
      referenceKnowledgeDocumentIds: [],
      bidAnalysisTasks: {},
      outlineData: { outline: structuredClone(OUTLINE) },
      projectOverview: '',
    });
    const { server, record } = await compare(planningOutput(AI_LEAVES, () => ({ knowledge: { item_ids: [] } })));
    const plans = fake.saved[0]!.input.plans;
    expect(AI_LEAVES.every((id) => plans[id].plan.target_words === 2500 && plans[id].plan.image_needed === false)).toBe(true);
    expect(AI_LEAVES.filter((id) => plans[id].plan.table.needed)).toEqual([LEAF(2), LEAF(4), LEAF(6)]);
    expect(record.written[0]!.files[1]).toEqual({ path: '招标文件关键信息.md', content: '未提供' });
    expect(server.logs).toContain('本次正文编排未选择参考知识库。');
  });

  it('表格“不要”：Agent 给出的表格一律清除；表格“适中”的上限', async () => {
    fake.state = baseState({ contentGenerationOptions: { ...OPTIONS, tableRequirement: 'none' } });
    // Agent 不按要求给出表格：程序清除。
    await compare(planningOutput(AI_LEAVES, () => ({ table: { needed: true, purpose: '表格' } })));
    expect(Object.values(fake.saved[0]!.input.plans).some((plan: any) => plan.plan.table.needed || plan.plan.table.purpose)).toBe(false);
    fake.saved = [];
    fake.state = baseState({ contentGenerationOptions: { ...OPTIONS, tableRequirement: 'moderate' } });
    await compare(planningOutput(AI_LEAVES, () => ({ table: { needed: true, purpose: '表格' } })));
    expect(AI_LEAVES.filter((id) => fake.saved[0]!.input.plans[id].plan.table.needed)).toHaveLength(2);
  });

  it('复用已保存的编排：只编排缺少的小节，已保留的表格计入上限，配图按全文评分选择；版本或表格需求不同的不复用', async () => {
    const stored = (score: number, table: boolean, extra: Record<string, unknown> = {}) => ({
      plan_version: 6,
      plan: {
        writing_focus: '已有重点',
        target_words: 5000,
        image_suitability_score: score,
        knowledge: { item_ids: ['doc-1::K000003', 'doc-1::gone'] },
        table: { needed: table, purpose: table ? '已有表格' : '' },
        original_material: { restored: false, optimized: false, source_hash: '', source_ranges: [], restored_words: 0 },
      },
      table_requirement: 'light',
      updated_at: '2026-11-01T00:00:00.000Z',
      ...extra,
    });
    fake.state = baseState({
      contentGenerationPlans: {
        [LEAF(1)]: stored(10, true),
        [LEAF(2)]: stored(9, false, { plan_version: 5 }),
        [LEAF(3)]: stored(9, false, { table_requirement: 'heavy' }),
        [MANUAL]: stored(9, false),
      },
    });
    const targets = [LEAF(2), LEAF(3), LEAF(4), LEAF(5), LEAF(6)];
    const { server, record } = await compare(planningOutput(targets));
    expect(JSON.parse(record.written[0]!.files[3]!.content)).toEqual({ target_ids: targets });
    expect(server.logs).toContain('继续整体编排决策，共 6 个小节，复用 1 个历史编排。');
    // 与桌面版相同：本次目标中复用的编排（LEAF(1)）不计入“已保留”，上限 1 照常从候选中再选 1 个。
    expect(AI_LEAVES.filter((id) => fake.saved[0]!.input.plans[id].plan.table.needed)).toEqual([LEAF(1), LEAF(5)]);
    // 与桌面版相同：复用的编排不是本次编排的目标，按已保存的原样写回。
    expect(fake.saved[0]!.input.plans[LEAF(1)].plan.knowledge.item_ids).toEqual(['doc-1::K000003', 'doc-1::gone']);
    expect(fake.saved[0]!.input.plans[MANUAL]).toBeUndefined();
  });

  it('全部可以复用：不打开沙箱，整理后保存（与桌面版相同）', async () => {
    const plans = Object.fromEntries(
      AI_LEAVES.map((id, index) => [
        id,
        { plan_version: 6, plan: { writing_focus: '重点', target_words: 1000, image_suitability_score: index, knowledge: { item_ids: [] }, table: { needed: false, purpose: '' } }, table_requirement: 'light' },
      ]),
    );
    fake.state = baseState({ contentGenerationPlans: plans });
    const desktopRun = await runDesktop(fake.state, null);
    expect(desktopRun.payload).toBeNull();
    expect(desktopRun.reachedGeneration).toBe(true);
    const { agent, record } = fakeAgent();
    const server = await runServer(agent);
    expect(server.error).toMatchObject(STAGE_UNAVAILABLE);
    expect(record.opened).toEqual([]);
    expect(fake.saved[0]!.input.plans).toEqual(withoutTimes(desktopRun.plans));
    expect(desktopRun.logs.slice(0, server.logs.length)).toEqual(server.logs);
    expect(server.savedCheckpoints).toEqual([{ task: { signature: 'sig-1', planningTargetIds: [], planned: true } }]);
  });

  it('没有待生成的小节：不编排、不保存，以固定错误结束', async () => {
    const sections = Object.fromEntries(AI_LEAVES.map((id) => [id, { id, title: 't', status: 'success', content: '<p>正文</p>', error: null }]));
    const runtime = { generation_started: true, section_words: Object.fromEntries(AI_LEAVES.map((id) => [id, 100])) };
    fake.state = baseState({ contentGenerationSections: sections, contentGenerationRuntime: runtime });
    const desktopRun = await runDesktop(fake.state, null);
    expect(desktopRun.payload).toBeNull();
    const { agent, record } = fakeAgent();
    const server = await runServer(agent);
    expect(server.error).toMatchObject(STAGE_UNAVAILABLE);
    expect(record.opened).toEqual([]);
    expect(fake.saved).toEqual([]);
    expect(server.logs.at(-1)).toBe('本次没有待生成的 AI 小节。');
    expect(desktopRun.logs.slice(0, server.logs.length)).toEqual(server.logs);
  });

  it('目录变更后新增的小节：只编排待生成小节，固定 3000 字（增量提示词），其他小节的字数记录与待生成清单保留', async () => {
    const sections = Object.fromEntries(AI_LEAVES.map((id) => [id, { id, title: 't', status: 'success', content: '<p>正文</p>', error: null }]));
    const runtime = {
      generation_started: true,
      // LEAF(4) 没有字数记录、但不在待生成清单中：本次不处理。
      section_words: Object.fromEntries(AI_LEAVES.slice(0, 3).map((id) => [id, 100])),
      pending_item_ids: [LEAF(5), LEAF(6)],
      direct_generation_item_ids: [LEAF(6)],
    };
    fake.state = baseState({ contentGenerationSections: sections, contentGenerationRuntime: runtime });
    const { record } = await compare(planningOutput([LEAF(5), LEAF(6)], () => ({ target_words: 7 })));
    expect(record.stages[0]!.prompt).toContain('本次为目录变更后的新增小节编排，每节 target_words 固定填 3000');
    expect([LEAF(5), LEAF(6)].map((id) => fake.saved[0]!.input.plans[id].plan.target_words)).toEqual([3000, 3000]);
    expect(fake.saved[0]!.input.runtime).toMatchObject({ pending_item_ids: [LEAF(5), LEAF(6)], direct_generation_item_ids: [LEAF(6)] });
    // 正文阶段已开始：查找可以续用的正文会话（这里没有，开新会话）。
    expect(fake.continuationQueries).toBe(1);
  });

  it('全文重新生成：全部小节重新编排，不复用编排，丢弃正文的会话，运行进度不沿用之前的', async () => {
    const sections = Object.fromEntries(AI_LEAVES.map((id) => [id, { id, title: 't', status: 'success', content: '<p>正文</p>', error: null }]));
    const plans = Object.fromEntries(
      AI_LEAVES.map((id) => [id, { plan_version: 6, plan: { writing_focus: '重点', target_words: 1000, image_suitability_score: 1, knowledge: { item_ids: [] }, table: { needed: false, purpose: '' } }, table_requirement: 'light' }]),
    );
    const runtime = { generation_started: true, section_words: { [LEAF(1)]: 100 }, pending_item_ids: [LEAF(2)] };
    fake.state = baseState({ contentGenerationSections: sections, contentGenerationPlans: plans, contentGenerationRuntime: runtime });
    await compare(planningOutput(AI_LEAVES), { regenerate: true });
    expect(fake.discarded).toEqual([{ projectId: 'project-1', kinds: ['technical-plan-content-generation'] }]);
    expect(fake.continuationQueries).toBe(0);
    expect(fake.saved[0]!.input.runtime).toMatchObject({ section_words: {}, pending_item_ids: [] });
  });

  it('开始时的检查：文案与桌面版相同', async () => {
    const leafOnly = [{ id: ROOT_A, number: '1', title: '总体', description: '', children: [{ id: LEAF(1), number: '1.1', title: '资质', description: '', content_mode: 'manual-fill' }] }];
    const cases: [Record<string, unknown>, string, string][] = [
      [{ outlineWordControlSnapshot: null }, 'TECHNICAL_PLAN_WORD_CONTROL_REQUIRED', '当前目录没有字数控制生效快照，请重新生成目录'],
      [{ outlineData: null }, 'TECHNICAL_PLAN_OUTLINE_REQUIRED', '请先生成目录，再生成正文'],
      [{ globalFacts: [{ id: 'g', title: '空', content: '  ' }] }, 'TECHNICAL_PLAN_GLOBAL_FACTS_REQUIRED', '请先完成全局事实设定，再生成正文'],
      [{ originalPlanFile: { status: 'error', markdownArtifactId: null } }, 'TECHNICAL_PLAN_ORIGINAL_PLAN_FAILED', '原方案解析失败，请移除后重新上传'],
      [{ originalPlanFile: { status: 'parsing', markdownArtifactId: null } }, 'TECHNICAL_PLAN_ORIGINAL_PLAN_NOT_READY', '原方案尚未解析完成，请稍后再试'],
      [{ outlineData: { outline: leafOnly } }, 'TECHNICAL_PLAN_CONTENT_SECTIONS_REQUIRED', '当前目录没有标记为“AI生成”的正文小节'],
    ];
    for (const [overrides, code, message] of cases) {
      fake.state = baseState(overrides);
      const { agent, record } = fakeAgent();
      const server = await runServer(agent);
      expect(server.error).toMatchObject({ code, message });
      expect(record.opened).toEqual([]);
      if (code === 'TECHNICAL_PLAN_WORD_CONTROL_REQUIRED' || code.startsWith('TECHNICAL_PLAN_ORIGINAL_PLAN')) continue;
      const desktopRun = await runDesktop(fake.state, null);
      expect(desktopRun.error).toMatchObject({ message });
    }
  });
});

describe('正文生成：续跑、会话与输入变化', () => {
  it('续跑（编排要求已发出）：沿用 checkpoint 中的目标，只发“继续之前的任务”，不重新放入材料与结果文件；原件不可用时重新放入', async () => {
    const checkpoint = { agent: {}, task: { signature: 'sig-1', planningTargetIds: [LEAF(1), LEAF(2)] } };
    const { agent, record } = fakeAgent({ output: planningOutput([LEAF(1), LEAF(2)]), resumed: true, promptedStage: 'content-planning' });
    const server = await runServer(agent, { checkpoint });
    expect(server.error).toMatchObject(STAGE_UNAVAILABLE);
    expect(record.stages[0]!.prompt).toBe('继续之前的任务');
    expect(record.written).toEqual([]);
    expect(Object.keys(fake.saved[0]!.input.plans).sort()).toEqual([LEAF(1), LEAF(2)]);
    // 日志不重复开始时的说明。
    expect(server.logs.some((line) => line.startsWith('准备生成正文'))).toBe(false);
    const again = fakeAgent({ output: planningOutput([LEAF(1), LEAF(2)]), resumed: true, unavailable: ['正文编排目录.json'] });
    await runServer(again.agent, { checkpoint });
    expect(again.record.written.map((item) => item.group)).toEqual(['content-planning-inputs']);
    expect(again.record.stages[0]!.prompt).not.toBe('继续之前的任务');
  });

  it('输入已变化：续跑时失败；写入时签名不符也失败，不写入', async () => {
    const { agent, record } = fakeAgent({ output: planningOutput(AI_LEAVES), resumed: true });
    const server = await runServer(agent, { checkpoint: { agent: {}, task: { signature: 'sig-0', planningTargetIds: AI_LEAVES } } });
    expect(server.error).toMatchObject({ code: 'TECHNICAL_PLAN_INPUT_CHANGED' });
    expect(record.opened).toEqual([]);
    fake.writeSignature = 'sig-2';
    const second = fakeAgent({ output: planningOutput(AI_LEAVES) });
    const result = await runServer(second.agent);
    expect(result.error).toMatchObject({ code: 'TECHNICAL_PLAN_INPUT_CHANGED' });
    expect(fake.saved).toEqual([]);
    expect(second.record.checkpoints.explicit).toEqual([]);
  });

  it('编排已保存后续跑：不打开沙箱，直接以固定错误结束；checkpoint 形状不对时失败', async () => {
    const { agent, record } = fakeAgent();
    const server = await runServer(agent, { checkpoint: { task: { signature: 'sig-1', planningTargetIds: [], planned: true } } });
    expect(server.error).toMatchObject(STAGE_UNAVAILABLE);
    expect(record.opened).toEqual([]);
    for (const task of [{ signature: '' }, { signature: 'sig-1', planningTargetIds: [1] }, { planned: true }]) {
      const broken = await runServer(fakeAgent().agent, { checkpoint: { task } });
      expect(broken.error).toMatchObject({ code: 'TECHNICAL_PLAN_FAILED' });
    }
  });

  it('正文阶段已开始且有可以续用的会话时接着它；没有开始时不查找', async () => {
    const state = { version: 1, session: 's.jsonl', snapshot: 'snap-1' };
    fake.continuable = { jobId: 'job-0', state };
    fake.state = baseState({ contentGenerationRuntime: { generation_started: true } });
    const { agent, record } = fakeAgent({ output: planningOutput(AI_LEAVES) });
    await runServer(agent);
    expect(record.opened).toEqual([{ continueFrom: state }]);
    fake.state = baseState();
    fake.continuationQueries = 0;
    const second = fakeAgent({ output: planningOutput(AI_LEAVES) });
    await runServer(second.agent);
    expect(fake.continuationQueries).toBe(0);
    expect(second.record.opened).toEqual([{}]);
  });

  it('预置 Schema 与桌面版相同；Agent 给出的已知字段之外的内容不保存，写作重点按上限截短', async () => {
    const desktopRun = await runDesktop(fake.state, planningOutput(AI_LEAVES));
    expect(CONTENT_PLANNING_JSON_SCHEMA).toEqual(desktopRun.payload!.json_validation_schemas['正文编排结果.json']);
    const long = planningOutput(AI_LEAVES, (_id, index) => (index === 0 ? { writing_focus: '长'.repeat(5000) } : {}));
    const { agent } = fakeAgent({ output: long });
    await runServer(agent);
    const plan = fake.saved[0]!.input.plans[LEAF(1)].plan;
    expect(plan.writing_focus).toHaveLength(1000);
    expect(Object.keys(plan).sort()).toEqual(['image_needed', 'image_suitability_score', 'knowledge', 'original_material', 'table', 'target_words', 'writing_focus']);
  });
});

describe('正文生成：失败后重试（8.10b2）', () => {
  const FAILED = '00000000-0000-4000-8000-0000000000f1';
  const SOURCE = { version: 1, session: 's.jsonl', stage: 'content-planning', stageIndex: 0, promptedStage: 'content-planning', snapshot: 'snap-1' };
  const retrySource = (task: Record<string, unknown> = { signature: 'sig-1', planningTargetIds: AI_LEAVES }, regenerate = false) => ({
    jobId: FAILED,
    regenerate,
    state: structuredClone(SOURCE),
    task,
  });

  it('基础编排失败后重试：接着失败任务的会话（保留阶段），沿用它的编排目标，重新放入材料、保留结果文件的草稿，只发“继续之前的任务”；与桌面版 continuingPlanning 相同', async () => {
    const output = planningOutput(AI_LEAVES);
    const desktopRun = await runDesktop(fake.state, output, { retryFailedSections: true }, { phase: 'content-planning', prompted_stage: 'content-planning' });
    expect(desktopRun.reachedGeneration).toBe(true);
    fake.retry = retrySource();
    const { agent, record } = fakeAgent({ output, promptedStage: 'content-planning' });
    const server = await runServer(agent, { retryOf: FAILED });
    expect(server.error).toMatchObject(STAGE_UNAVAILABLE);
    expect(record.opened).toEqual([{ continueFrom: SOURCE, retainStages: true }]);
    const request = desktopRun.payload!;
    // 材料重新放入；结果文件不预置（保留草稿），与桌面版相同。
    expect(request.files.some((file: { path: string }) => file.path === '正文编排结果.json')).toBe(false);
    expect(record.written).toHaveLength(1);
    expect(record.written[0]).toMatchObject({ group: 'content-planning-inputs', options: { replace: true } });
    expect(record.written[0]!.files).toEqual(request.files);
    expect(record.released).toEqual([]);
    expect(request.prompt).toBe('继续之前的任务');
    expect(record.stages[0]!.prompt).toBe('继续之前的任务');
    expect(fake.saved[0]!.input.plans).toEqual(withoutTimes(desktopRun.plans));
    expect(desktopRun.logs.slice(0, server.logs.length)).toEqual(server.logs);
    expect(server.logs.slice(0, 2)).toEqual(['准备生成正文，共 6 个小节。', '开始重试 6 个失败或未完成正文小节。']);
    // 不丢弃会话，也不按“正文阶段已开始”另找会话。
    expect(fake.discarded).toEqual([]);
    expect(fake.continuationQueries).toBe(0);
    expect(record.checkpoints.after).toEqual({ signature: 'sig-1', planningTargetIds: AI_LEAVES });
  });

  it('沿用失败任务的编排目标与 regenerate（全文重新生成的重试不丢弃会话）；要求还没有发出时发完整的编排要求', async () => {
    fake.retry = retrySource({ signature: 'sig-1', planningTargetIds: [LEAF(2), LEAF(3)] }, true);
    const { agent, record } = fakeAgent({ output: planningOutput([LEAF(2), LEAF(3)]) });
    const server = await runServer(agent, { retryOf: FAILED, regenerate: true });
    expect(server.error).toMatchObject(STAGE_UNAVAILABLE);
    expect(fake.discarded).toEqual([]);
    expect(Object.keys(fake.saved[0]!.input.plans).sort()).toEqual([LEAF(2), LEAF(3)]);
    expect(JSON.parse(record.written[0]!.files.find((file) => file.path === '正文编排目标.json')!.content)).toEqual({ target_ids: [LEAF(2), LEAF(3)] });
    expect(record.stages[0]!.prompt).not.toBe('继续之前的任务');
    // regenerate 与失败任务不同：不可重试。
    fake.saved = [];
    const mismatch = await runServer(fakeAgent().agent, { retryOf: FAILED, regenerate: false });
    expect(mismatch.error).toMatchObject({ code: 'TECHNICAL_PLAN_CONTENT_RETRY_UNAVAILABLE' });
  });

  it('执行时再核对：没有可以重试的任务、不是要重试的那个、编排已保存、checkpoint 不可用、输入已变化时失败，不打开沙箱', async () => {
    const cases: [unknown, Record<string, unknown>][] = [
      [null, { code: 'TECHNICAL_PLAN_CONTENT_RETRY_UNAVAILABLE' }],
      [{ ...retrySource(), jobId: '00000000-0000-4000-8000-0000000000f2' }, { code: 'TECHNICAL_PLAN_CONTENT_RETRY_UNAVAILABLE' }],
      [retrySource({ signature: 'sig-1', planningTargetIds: AI_LEAVES, planned: true }), { code: 'TECHNICAL_PLAN_CONTENT_RETRY_UNAVAILABLE' }],
      [retrySource({ signature: 'sig-1' }), { code: 'TECHNICAL_PLAN_CONTENT_RETRY_UNAVAILABLE' }],
      [retrySource({ signature: 'sig-1', planningTargetIds: [1] }), { code: 'TECHNICAL_PLAN_FAILED' }],
      [retrySource({ signature: 'sig-0', planningTargetIds: AI_LEAVES }), { code: 'TECHNICAL_PLAN_INPUT_CHANGED' }],
    ];
    for (const [source, error] of cases) {
      fake.retry = source;
      const { agent, record } = fakeAgent({ output: planningOutput(AI_LEAVES) });
      const server = await runServer(agent, { retryOf: FAILED });
      expect(server.error).toMatchObject(error);
      expect(record.opened).toEqual([]);
    }
    expect(fake.saved).toEqual([]);
  });

  it('重试任务暂停后续跑：用自己的 checkpoint，不再查找失败任务的会话', async () => {
    fake.retry = retrySource();
    const { agent, record } = fakeAgent({ output: planningOutput(AI_LEAVES), resumed: true, promptedStage: 'content-planning' });
    const server = await runServer(agent, { retryOf: FAILED, checkpoint: { agent: {}, task: { signature: 'sig-1', planningTargetIds: AI_LEAVES } } });
    expect(server.error).toMatchObject(STAGE_UNAVAILABLE);
    expect(fake.retryQueries).toBe(0);
    expect(record.opened).toEqual([{}]);
    expect(record.written).toEqual([]);
    expect(record.stages[0]!.prompt).toBe('继续之前的任务');
  });

  it('参数：retryOf 须是 uuid', () => {
    expect(job.parseParams({ regenerate: false, retryOf: FAILED })).toEqual({ regenerate: false, retryOf: FAILED });
    for (const retryOf of ['', 'job-1', 1, null]) expect(() => job.parseParams({ regenerate: false, retryOf })).toThrow(TypeError);
  });
});
