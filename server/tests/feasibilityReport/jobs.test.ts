// 可研报告的四类任务（src/feasibilityReport/jobs.ts、prompts.ts）与桌面版 feasibilityReportTasks.cjs 的对照：Store 换成内存实现
// （vi.mock），桌面版与服务端用同一输入、同一模型输出，比较完整的请求序列（消息逐字相同）与写入的结果。覆盖资料分析的单段与分段
// 合并、关键参数（含知识库轻量条目）、正文生成（预热、知识库素材、目标字数）接着审校（预热、保护事实）、只补充未完成章节、单独的
// 自然化审校；续跑：审校结果写入后、checkpoint 保存前中断，续跑不重复调用（同一步骤键、同一请求只计一次）。
// 数据库读写、签名核对、接口与经 worker 的执行见 tests/db/feasibilityReportJobs.test.ts。
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/ai/providers.ts';
import type { JobChatRequest, JobContext, JobTypeDefinition } from '../../src/jobs/definitions.ts';

// ---- 内存中的 Store ----

const fake = vi.hoisted(() => {
  interface Item {
    id: string;
    title: string;
    description: string;
    knowledge_item_ids?: string[];
    content?: string;
    children?: Item[];
  }
  const store = {
    state: null as unknown as Record<string, any>,
    sources: '',
    knowledge: [] as { documentId: string; itemId: string; title: string; resume: string; content: string }[],
    signature: 'sig-1',
    /** 写入后抛出一次（模拟写入后、checkpoint 前中断）。 */
    failAfterWrite: null as null | ((nodeId: string) => boolean),
  };
  const walk = (items: Item[] | undefined, visit: (item: Item) => void) => {
    for (const item of items ?? []) {
      visit(item);
      walk(item.children, visit);
    }
  };
  return { store, walk };
});

vi.mock('../../src/feasibilityReport/store.ts', () => {
  const { store, walk } = fake;
  const clone = <T>(value: T): T => structuredClone(value);
  return {
    FEASIBILITY_ANALYSIS_JOB_TYPE: 'feasibility-analysis',
    FEASIBILITY_PARAMETERS_JOB_TYPE: 'feasibility-parameters',
    FEASIBILITY_CONTENT_JOB_TYPE: 'feasibility-content',
    FEASIBILITY_HUMAN_WRITING_JOB_TYPE: 'feasibility-human-writing',
    FEASIBILITY_OUTLINE_JOB_TYPE: 'feasibility-outline',
    FEASIBILITY_OUTLINE_NODES_MAX: 2000,
    FEASIBILITY_JOB_TYPES: ['feasibility-analysis', 'feasibility-outline', 'feasibility-parameters', 'feasibility-content', 'feasibility-human-writing'],
    feasibilityReportLockKey: (projectId: string) => `project:${projectId}:feasibility-report`,
    inputSignature: async () => store.signature,
    loadFeasibilityReport: async () => clone(store.state),
    readCombinedSourceMarkdown: async () => store.sources,
    readReferenceKnowledgeItems: async () => clone(store.knowledge),
    saveAnalysisResult: async (_db: unknown, _context: unknown, _projectId: string, markdown: string, signature: string) => {
      if (signature !== store.signature) return false;
      Object.assign(store.state, { analysisMarkdown: markdown.trim(), outlineData: null, keyParametersMarkdown: '' });
      return true;
    },
    saveKeyParametersResult: async (_db: unknown, _context: unknown, _projectId: string, markdown: string, signature: string) => {
      if (signature !== store.signature) return false;
      store.state.keyParametersMarkdown = markdown.trim();
      walk(store.state.outlineData?.outline, (item) => delete item.content);
      return true;
    },
    clearChapterContents: async (_db: unknown, _context: unknown, _projectId: string, signature: string) => {
      if (signature !== store.signature) return false;
      walk(store.state.outlineData?.outline, (item) => delete item.content);
      return true;
    },
    saveChapterResult: async (_db: unknown, _context: unknown, _projectId: string, nodeId: string, content: string, signature: string) => {
      if (signature !== store.signature) return false;
      let found = false;
      walk(store.state.outlineData?.outline, (item) => {
        if (item.id !== nodeId) return;
        found = true;
        if (content) item.content = content;
        else delete item.content;
      });
      if (found && store.failAfterWrite?.(nodeId)) {
        store.failAfterWrite = null;
        throw new Error('simulated crash after write');
      }
      return found;
    },
  };
});

vi.mock('../../src/jobs/chat.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/jobs/chat.ts')>();
  return { ...original, resolveJobModel: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }) };
});

const { createFeasibilityReportJobs, FEASIBILITY_ANALYSIS_JOB_TYPE, FEASIBILITY_CONTENT_JOB_TYPE, FEASIBILITY_HUMAN_WRITING_JOB_TYPE, FEASIBILITY_PARAMETERS_JOB_TYPE } =
  await import('../../src/feasibilityReport/jobs.ts');

const require = createRequire(import.meta.url);
const desktop = require('../../../client/electron/services/feasibilityReportTasks.cjs') as Record<string, (options: Record<string, unknown>) => Promise<void>>;

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

function outline() {
  return [
    {
      id: '1',
      title: '概述',
      description: '项目概况与结论',
      children: [
        { id: '1.1', title: '项目概况', description: '' },
        { id: '1.2', title: '编制依据', description: '依据与范围', knowledge_item_ids: ['doc-1::item-2'] },
      ],
    },
    { id: '2', title: '项目建设方案', description: '管网工程方案' },
  ];
}

const KNOWLEDGE = [
  { documentId: 'doc-1', itemId: 'item-1', title: '供水管网改造方案', resume: '管网工程方案与施工组织', content: '采用球墨铸铁管，分段施工。' },
  { documentId: 'doc-1', itemId: 'item-2', title: '编制依据清单', resume: '规范与标准', content: '《室外给水设计标准》。' },
  { documentId: 'doc-1', itemId: 'item-3', title: '无简介条目', resume: '', content: '只有正文。' },
];

function baseState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    step: 'materials',
    projectInfo: { ...PROJECT_INFO },
    sourceFiles: [{ id: 'f1', status: 'success', markdownArtifactId: 'a1' }],
    analysisMarkdown: '## 项目概况\n\n改造管网 12 公里。',
    outlineTemplate: 'government',
    targetWords: 6000,
    referenceDocumentIds: ['doc-1'],
    keyParametersMarkdown: '## 项目身份信息\n\n- 管网 12 公里',
    outlineData: { outline: outline() },
    analysisTask: null,
    outlineTask: null,
    outlineAdjustmentTask: null,
    parametersTask: null,
    contentTask: null,
    humanWritingTask: null,
    ...overrides,
  };
}

// ---- 模型桩（桌面版与服务端共用） ----

const ANALYSIS_JSON = (label: string) =>
  JSON.stringify({ project_overview: `${label}概况：管网 12 公里`, background_and_necessity: `${label}背景`, missing_information: '' });

/** 按请求内容给出输出：分析返回 JSON，关键参数返回 Markdown，正文按章节路径，审校去掉一个数量（保护事实时保留原文）或改写。 */
function respond(messages: readonly ChatMessage[]): string {
  const last = messages.at(-1)!.content;
  const system = messages[0]!.content;
  if (last.includes('只返回 JSON') && last.includes('当前资料分段')) return ANALYSIS_JSON(/当前资料分段：(\d+\/\d+)/.exec(last)![1]!);
  if (last.includes('只返回与输入相同字段的 JSON')) return ANALYSIS_JSON('合并');
  if (last.includes('关键参数与编制口径')) return '## 项目身份信息\n\n- 新的关键参数';
  const path = /当前章节路径：([^\n]*)/.exec(messages.map((message) => message.content).join('\n'))?.[1];
  if (system.includes('润色编辑')) {
    if (path?.includes('编制依据')) return '```markdown\n审校后的编制依据，共 3 个段落。\n```';
    return '审校后丢了数量';
  }
  if (path) return `\`\`\`markdown\n${path} 的正文，共 3 个段落。\n\`\`\``;
  return '';
}

interface Call {
  stepKey?: string;
  messages: ChatMessage[];
  warmup: boolean;
}

/** 桌面版的请求序列与结束时的状态。 */
async function runDesktop(task: string, state: Record<string, any>, options: { sources?: string; contextLengthLimit?: number; payload?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  let workspace = structuredClone(state);
  const record = (request: { messages: ChatMessage[]; output_token_limit?: number }) => {
    calls.push({ messages: request.messages, warmup: request.output_token_limit === 1 });
    return respond(request.messages);
  };
  const aiService = {
    getConfig: () => ({ context_length_limit: options.contextLengthLimit ?? 400000 }),
    async chat(request: { messages: ChatMessage[]; output_token_limit?: number }) {
      return record(request);
    },
    async requestJson(request: { messages: ChatMessage[] }) {
      return JSON.parse(record(request));
    },
  };
  const toDesktopItems = KNOWLEDGE.map((item) => ({ id: item.itemId, title: item.title, resume: item.resume, content: item.content }));
  const knowledgeBaseService = {
    readReferences: () => [{ document: { id: 'doc-1', status: 'success' }, items: toDesktopItems }],
    getOutlineReferences: () => ({
      items: toDesktopItems.filter((item) => item.title && item.resume).map((item) => ({ id: `doc-1::${item.id}`, title: item.title, resume: item.resume })),
    }),
  };
  const controller = new AbortController();
  await desktop[task]!({
    aiService,
    workspaceStore: { loadFeasibilityReport: () => structuredClone(workspace), readCombinedSourceMarkdown: () => options.sources ?? '' },
    knowledgeBaseService,
    updateTask: () => {},
    checkpointTask: (_task: unknown, patch: Record<string, unknown> = {}) => {
      workspace = { ...workspace, ...structuredClone(patch) };
    },
    payload: options.payload ?? {},
    taskControl: { signal: controller.signal, isPauseRequested: () => false },
    previousState: {},
  });
  return { calls, state: workspace };
}

const jobs = createFeasibilityReportJobs({ warmupSettleMs: 0 });
const jobOf = (type: string) => jobs.find((job) => job.type === type)! as JobTypeDefinition<any>;

/** 模拟网关的步骤幂等：同一步骤键、同一请求内容的调用取回已保存的结果，只有新的调用计费。 */
const stepResults = new Map<string, string>();
let billedCalls = 0;

interface ServerRun {
  calls: Call[];
  error: unknown;
  logs: string[];
  checkpoint: Record<string, unknown> | null;
}

async function runServer(type: string, params: unknown, options: { checkpoint?: Record<string, unknown> | null; contextLengthLimit?: number; onChat?: () => void } = {}): Promise<ServerRun> {
  const definition = options.contextLengthLimit ? (createFeasibilityReportJobs({ warmupSettleMs: 0, contextLengthLimit: options.contextLengthLimit }).find((job) => job.type === type)! as JobTypeDefinition<any>) : jobOf(type);
  const calls: Call[] = [];
  const logs: string[] = [];
  let checkpoint = options.checkpoint ?? null;
  const context: JobContext<any> = {
    jobId: 'job-1',
    projectId: 'project-1',
    type,
    attempt: 1,
    params: definition.parseParams(params),
    checkpoint,
    tenant: { orgId: 'org-1', userId: 'user-1', role: 'owner' },
    db: null as never,
    signal: new AbortController().signal,
    async setProgress() {},
    async saveCheckpoint(next) {
      checkpoint = structuredClone(next);
    },
    async log(message) {
      logs.push(message);
    },
    ai: {
      async chat(request: JobChatRequest) {
        calls.push({ stepKey: request.stepKey, messages: [...request.messages], warmup: request.maxOutputTokens === 1 });
        options.onChat?.();
        const key = `${request.stepKey}\u0000${createHash('sha256').update(JSON.stringify(request.messages)).digest('hex')}`;
        let content = stepResults.get(key);
        if (content === undefined) {
          billedCalls += 1;
          content = respond(request.messages);
          stepResults.set(key, content);
        }
        return { requestId: 'r', content, reasoningContent: '', toolCalls: [], finishReason: 'stop', aborted: false, reused: false, usage: {} as never, billing: { status: 'billed', amount: 1n } };
      },
    },
    objectStore: null,
    sandbox: null,
    agentWorkspace: null,
    agent: null,
  };
  try {
    await definition.run(context);
    return { calls, error: null, logs, checkpoint };
  } catch (error) {
    return { calls, error, logs, checkpoint };
  }
}

const messagesOf = (calls: Call[]) => calls.map((call) => ({ messages: call.messages, warmup: call.warmup }));

/** 内存状态中的各章正文。 */
function contents(state: Record<string, any>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  fake.walk(state.outlineData?.outline, (item) => {
    result[item.id] = item.content || undefined;
  });
  return result;
}

beforeEach(() => {
  fake.store.state = baseState();
  fake.store.sources = '';
  fake.store.knowledge = structuredClone(KNOWLEDGE);
  fake.store.signature = 'sig-1';
  fake.store.failAfterWrite = null;
  stepResults.clear();
  billedCalls = 0;
});

describe('资料分析（feasibility-analysis）', () => {
  it('单段：请求与桌面版相同，结果整理成九个板块的 Markdown 并清空下游', async () => {
    fake.store.sources = '## 资料.docx\n\n管网长度 12 公里。';
    const reference = await runDesktop('runFeasibilityAnalysisTask', baseState(), { sources: fake.store.sources });
    const result = await runServer(FEASIBILITY_ANALYSIS_JOB_TYPE, {});
    expect(result.error).toBeNull();
    expect(result.calls.map((call) => call.stepKey)).toEqual(['analysis']);
    expect(messagesOf(result.calls)).toEqual(messagesOf(reference.calls));
    expect(fake.store.state.analysisMarkdown).toBe(reference.state.analysisMarkdown);
    expect(fake.store.state.analysisMarkdown).toContain('## 缺失资料清单\n\n- 【待补充】尚未识别到明确缺失项');
    expect(fake.store.state).toMatchObject({ outlineData: null, keyParametersMarkdown: '' });
  });

  it('没有资料时只按项目参数分析（“未导入资料文件”）', async () => {
    const reference = await runDesktop('runFeasibilityAnalysisTask', baseState());
    const result = await runServer(FEASIBILITY_ANALYSIS_JOB_TYPE, {});
    expect(result.error).toBeNull();
    expect(messagesOf(result.calls)).toEqual(messagesOf(reference.calls));
    expect(result.calls[0]!.messages[1]!.content).toContain('未导入资料文件');
    expect(result.logs[0]).toBe('未导入资料文件，仅根据项目参数分析。');
  });

  it('超过上下文长度时逐段分析后合并，请求序列与桌面版相同', async () => {
    fake.store.sources = Array.from({ length: 12 }, (_, index) => `## 第 ${index + 1} 节\n\n${'资料内容。'.repeat(20)}`).join('\n\n');
    const reference = await runDesktop('runFeasibilityAnalysisTask', baseState(), { sources: fake.store.sources, contextLengthLimit: 600 });
    const result = await runServer(FEASIBILITY_ANALYSIS_JOB_TYPE, {}, { contextLengthLimit: 600 });
    expect(result.error).toBeNull();
    expect(reference.calls.length).toBeGreaterThan(2);
    expect(result.calls.map((call) => call.stepKey)).toEqual([...Array.from({ length: reference.calls.length - 1 }, (_, index) => `analysis:segment:${index + 1}`), 'analysis:merge']);
    expect(messagesOf(result.calls)).toEqual(messagesOf(reference.calls));
    expect(fake.store.state.analysisMarkdown).toBe(reference.state.analysisMarkdown);
  });

  it('输入已变化时结果不写入，任务以 FEASIBILITY_REPORT_INPUT_CHANGED 失败', async () => {
    const before = fake.store.state.analysisMarkdown;
    const result = await runServer(FEASIBILITY_ANALYSIS_JOB_TYPE, {}, { onChat: () => (fake.store.signature = 'sig-2') });
    expect(result.error).toMatchObject({ code: 'FEASIBILITY_REPORT_INPUT_CHANGED' });
    expect(fake.store.state.analysisMarkdown).toBe(before);
  });
});

describe('关键参数（feasibility-parameters）', () => {
  it('请求含目录与知识库轻量条目（标题、简介都不为空），与桌面版相同；写入后清空全部正文', async () => {
    fake.store.state = baseState({ outlineData: { outline: outline().map((item) => ({ ...item, content: '旧正文' })) } });
    const reference = await runDesktop('runFeasibilityParametersTask', fake.store.state);
    const result = await runServer(FEASIBILITY_PARAMETERS_JOB_TYPE, {});
    expect(result.error).toBeNull();
    expect(result.calls.map((call) => call.stepKey)).toEqual(['parameters']);
    expect(messagesOf(result.calls)).toEqual(messagesOf(reference.calls));
    expect(result.calls[0]!.messages[3]!.content).toContain('"id": "doc-1::item-1"');
    expect(result.calls[0]!.messages[3]!.content).not.toContain('item-3');
    expect(fake.store.state.keyParametersMarkdown).toBe(reference.state.keyParametersMarkdown);
    expect(Object.values(contents(fake.store.state)).every((content) => content === undefined)).toBe(true);
  });

  it('没有引用知识库时写“未选择知识库”', async () => {
    fake.store.knowledge = [];
    const reference = await runDesktop('runFeasibilityParametersTask', baseState({ referenceDocumentIds: [] }));
    const result = await runServer(FEASIBILITY_PARAMETERS_JOB_TYPE, {});
    expect(messagesOf(result.calls)).toEqual(messagesOf(reference.calls));
    expect(result.calls[0]!.messages[3]!.content).toBe('知识库轻量条目：\n未选择知识库');
  });

  it('没有目录时失败（“请先生成报告目录”）', async () => {
    fake.store.state = baseState({ outlineData: null });
    const result = await runServer(FEASIBILITY_PARAMETERS_JOB_TYPE, {});
    expect(result.error).toMatchObject({ code: 'FEASIBILITY_REPORT_OUTLINE_REQUIRED', message: '请先生成报告目录' });
    expect(result.calls).toEqual([]);
  });
});

describe('正文生成与审校（feasibility-content）', () => {
  it('全部生成：清空旧正文，预热后逐章生成（知识库素材、目标字数），接着预热后逐章审校；请求与结果与桌面版相同', async () => {
    fake.store.state = baseState({ outlineData: { outline: outline().map((item) => (item.id === '2' ? { ...item, content: '旧正文' } : item)) } });
    const reference = await runDesktop('runFeasibilityContentTask', baseState({ outlineData: { outline: outline() } }));
    const result = await runServer(FEASIBILITY_CONTENT_JOB_TYPE, { onlyMissing: false });
    expect(result.error).toBeNull();
    expect(result.calls.map((call) => call.stepKey)).toEqual([
      'content:warmup',
      'content:1.1',
      'content:1.2',
      'content:2',
      'review:warmup',
      'review:1.1',
      'review:1.2',
      'review:2',
    ]);
    expect(messagesOf(result.calls)).toEqual(messagesOf(reference.calls));
    // 1.2 指定了知识库条目；2 按字面重合选到“供水管网改造方案”；目标字数 6000 / 3 章。
    expect(result.calls[2]!.messages.at(-1)!.content).toContain('### 编制依据清单');
    expect(result.calls[3]!.messages.at(-1)!.content).toContain('### 供水管网改造方案');
    expect(result.calls[1]!.messages.at(-1)!.content).toContain('参考目标字数：约 2000 字。');
    expect(contents(fake.store.state)).toEqual(contents(reference.state));
    // 审校丢了数量时保留原文；去掉代码围栏。
    expect(contents(fake.store.state)).toMatchObject({ '1.1': '概述 > 项目概况 的正文，共 3 个段落。', '1.2': '审校后的编制依据，共 3 个段落。' });
  });

  it('只补充未完成章节：已有正文的不再生成，审校全部有正文的章节；与桌面版 onlyMissing 相同', async () => {
    const withContent = () => ({ outline: outline().map((item) => (item.id === '2' ? { ...item, content: '已有正文 5 公里' } : item)) });
    fake.store.state = baseState({ outlineData: withContent() });
    const reference = await runDesktop('runFeasibilityContentTask', baseState({ outlineData: withContent() }), { payload: { onlyMissing: true } });
    const result = await runServer(FEASIBILITY_CONTENT_JOB_TYPE, { onlyMissing: true });
    expect(result.error).toBeNull();
    expect(result.calls.map((call) => call.stepKey)).toEqual(['content:warmup', 'content:1.1', 'content:1.2', 'review:warmup', 'review:1.1', 'review:1.2', 'review:2']);
    expect(messagesOf(result.calls)).toEqual(messagesOf(reference.calls));
    expect(contents(fake.store.state)).toEqual(contents(reference.state));
    expect(contents(fake.store.state)['2']).toBe('已有正文 5 公里');
  });

  it('审校结果写入后、checkpoint 保存前中断：续跑不重复调用（全部调用各计费一次），结果与不中断相同', async () => {
    const clean = await runServer(FEASIBILITY_CONTENT_JOB_TYPE, { onlyMissing: false });
    expect(clean.error).toBeNull();
    const expected = contents(fake.store.state);
    const cleanBilled = billedCalls;

    fake.store.state = baseState();
    stepResults.clear();
    billedCalls = 0;
    let writes = 0;
    // 三章生成之后，第二章（1.2）的审校结果写入后中断。
    fake.store.failAfterWrite = () => {
      writes += 1;
      return writes === 5;
    };
    const first = await runServer(FEASIBILITY_CONTENT_JOB_TYPE, { onlyMissing: false });
    expect(String(first.error)).toContain('simulated crash');
    expect(first.checkpoint).toMatchObject({ phase: 'human-writing', reviewedNodeIds: ['1.1'], reviewing: { nodeId: '1.2' } });
    const second = await runServer(FEASIBILITY_CONTENT_JOB_TYPE, { onlyMissing: false }, { checkpoint: first.checkpoint });
    expect(second.error).toBeNull();
    // 续跑没有重新清空、没有重新生成，1.2 已写入、不再审校，只审校 2。
    expect(second.calls.map((call) => call.stepKey)).toEqual(['review:2']);
    expect(billedCalls).toBe(cleanBilled);
    expect(contents(fake.store.state)).toEqual(expected);
  });

  it('生成阶段中断后续跑：已写入正文的章节不再生成，同一步骤的调用取回已保存的结果', async () => {
    fake.store.failAfterWrite = (nodeId) => nodeId === '1.2';
    const first = await runServer(FEASIBILITY_CONTENT_JOB_TYPE, { onlyMissing: false });
    expect(String(first.error)).toContain('simulated crash');
    const second = await runServer(FEASIBILITY_CONTENT_JOB_TYPE, { onlyMissing: false }, { checkpoint: first.checkpoint });
    expect(second.error).toBeNull();
    expect(second.calls.map((call) => call.stepKey)).toEqual(['content:2', 'review:warmup', 'review:1.1', 'review:1.2', 'review:2']);
    // 与不中断时相同的 8 次调用（预热、三章生成、预热、三章审校），各计费一次。
    expect(billedCalls).toBe(8);
  });

  it('没有关键参数时失败（“请先生成关键参数”）；输入变化时不再写入', async () => {
    fake.store.state = baseState({ keyParametersMarkdown: '  ' });
    expect((await runServer(FEASIBILITY_CONTENT_JOB_TYPE, { onlyMissing: false })).error).toMatchObject({
      code: 'FEASIBILITY_REPORT_KEY_PARAMETERS_REQUIRED',
      message: '请先生成关键参数',
    });
    fake.store.state = baseState();
    fake.store.failAfterWrite = () => {
      fake.store.signature = 'sig-2';
      return false;
    };
    const result = await runServer(FEASIBILITY_CONTENT_JOB_TYPE, { onlyMissing: false });
    expect(result.error).toMatchObject({ code: 'FEASIBILITY_REPORT_INPUT_CHANGED' });
    expect(Object.values(contents(fake.store.state)).filter(Boolean)).toHaveLength(1);
  });

  it('参数只接受 onlyMissing', () => {
    const definition = jobOf(FEASIBILITY_CONTENT_JOB_TYPE);
    expect(definition.parseParams({ onlyMissing: true })).toEqual({ onlyMissing: true });
    expect(() => definition.parseParams({})).toThrow();
    expect(() => definition.parseParams({ onlyMissing: false, resume: true })).toThrow();
  });
});

describe('自然化审校（feasibility-human-writing）', () => {
  it('审校全部有正文的章节，不预热；请求与结果与桌面版相同', async () => {
    const written = () => ({
      outline: outline().map((item) =>
        item.id === '1' ? { ...item, children: item.children!.map((child) => (child.id === '1.2' ? { ...child, content: '依据 3 项【待确认】' } : child)) } : { ...item, content: '方案 12 公里' },
      ),
    });
    fake.store.state = baseState({ outlineData: written() });
    const reference = await runDesktop('runFeasibilityHumanWritingTask', baseState({ outlineData: written() }));
    const result = await runServer(FEASIBILITY_HUMAN_WRITING_JOB_TYPE, {});
    expect(result.error).toBeNull();
    expect(result.calls.map((call) => call.stepKey)).toEqual(['review:1.2', 'review:2']);
    expect(messagesOf(result.calls)).toEqual(messagesOf(reference.calls));
    expect(contents(fake.store.state)).toEqual(contents(reference.state));
  });

  it('没有正文时失败（“请先生成正文，再进行自然化审校”）', async () => {
    const result = await runServer(FEASIBILITY_HUMAN_WRITING_JOB_TYPE, {});
    expect(result.error).toMatchObject({ code: 'FEASIBILITY_REPORT_CONTENT_REQUIRED', message: '请先生成正文，再进行自然化审校' });
  });
});
