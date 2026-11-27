// 业务工具 generate-sections 的执行（路线图第 8 步 8.10c2b2；docs/SERVER_DESIGN.md 第 7.45 节），取代桌面版 contentGenerationAgent.cjs
// 中 generate-sections 的 execute。纯逻辑（任务文件、跳过规则、写作请求、输出检查）在 contentSectionWriting.ts（8.10c2a），长时调用的
// 交接在 src/agent/toolRequests.ts（8.10c2b1，#123 用户确认由执行者执行）。
//
// - 内部入口一侧（generateSectionsTool）：参数为空对象；登记请求、至多等 50 秒，未完成时沙箱内的桩以相同参数再次调用。每次等待都计入
//   调用次数（一次 2 小时的执行约 150 次）。
// - 执行者一侧（createGenerateSectionsExecutor，由写作阶段的提示词经 AgentPromptInput.longTools 给出，8.10c3 接入）：
//   1. 经 run.readFiles 读取 `任务/正文生成.json`（Agent 写的不可信输入）与本次各目标小节的正文文件；任务文件不可用时按
//      AgentToolRequestRejection 交回 Agent 修正（说明是固定文字，不回显文件内容）；
//   2. 已生成正文（文件非空白）的跳过，regenerate 重写；多于一节时先预热公共前缀；
//   3. 每节一次文本模型调用（经 JobAi：计费、冻结与结算、余额不足暂停、任务上限、按“组织 + 服务商”的并发排队与其他任务相同），
//      全部小节同时提交、由网关排队；写作材料取服务端的输入（ContentSectionWritingMaterials），不读工作区的副本；
//   4. 输出检查通过后经 run.writeFiles 写回 `正文/<id>.html`（各节依次写入，不并发放入）；输出不合格的本节失败、交回 Agent 重试；
//   5. 服务端连续 10 个请求本身失败且其间没有成功（createAiBatchGuard）时中止剩余各节，按 AI_UPSTREAM_UNAVAILABLE 结束任务；
//      余额不足、达到任务上限、任务中断、写回失败与其他错误同样中止剩余各节并作为致命错误抛出（执行者中止入口、按该错误结束）；
//      没有选择模型、所选模型未登记 / 已停用 / 未定价、服务未配置等平台配置问题（#124 用户决定，与 #98 一致）转成
//      JobModelUnavailableError：任务暂停为 model_not_configured / model_unavailable（写明原因），修正配置后从断点续跑，不计入连续失败。
// - 步骤键在续跑时可重算：`content-section:<小节 id>:<n>`，n 为本任务中该小节的第几次写作（从 1 开始）；预热为
//   `content-section-prefix:<m>`，m 为第几次提交。计数随任务的 checkpoint 保存（state()，8.10c3 写入）：worker 崩溃后从上次的
//   checkpoint 续跑，同一小节、同一请求内容的调用取回已保存的结果、不再扣费；regenerate 与失败后的重试换用新的 n，重新调用模型。
//
// 进入图片保护（check-word-count 确认正文全部就绪，8.10c3b1，contentImageProtection.ts）之后不再生成正文：按 AgentToolRequestRejection
// 交回 Agent（桌面版此时已从 Agent 可用的工具中去掉 generate-sections）。
//
// 返回给 Agent 的只有统计与未成功项（compactResults），日志不记写作材料、模型输出与任务文件的内容。
import {
  AgentToolRequestRejection,
  createAgentLongTool,
  type AgentLongToolExecutor,
  type AgentLongToolOptions,
  type AgentToolRequestExecution,
} from '../agent/toolRequests.ts';
import type { AgentRun } from '../agent/execution.ts';
import { jobModelUnavailableError } from '../agent/modelRejections.ts';
import type { ChatResult } from '../ai/gateway.ts';
import { abortableDelay } from '../jobs/control.ts';
import { createAiBatchGuard, isAiUpstreamFailure } from '../jobs/aiBatchGuard.ts';
import type { JobModel } from '../jobs/chat.ts';
import type { ContentImageProtection } from './contentImageProtection.ts';
import { JobError, JobInterruptedError, type JobAi } from '../jobs/definitions.ts';
import {
  compactResults,
  CONTENT_SECTIONS_TASK_FILE,
  ContentSectionOutputError,
  ContentSectionTaskError,
  contentSectionInput,
  contentSectionSharedInput,
  contentSectionSuccess,
  contentSectionWritingSystem,
  finishSectionHtml,
  planContentSectionBatch,
  readContentSectionsTask,
  sharedPrefixMessages,
  type ContentSectionJob,
  type ContentSectionResult,
  type ContentSectionWritingMaterials,
  type ContentWritingTarget,
} from './contentSectionWriting.ts';
import { HtmlStructureError } from './htmlStructure.ts';

export const GENERATE_SECTIONS_TOOL = 'generate-sections';

/**
 * 内部入口一侧的工具（登记在 src/agent/toolRegistry.ts）。参数与桌面版相同为空对象；次数与频率上限与 ask-user 相同（每次 50 秒的等待
 * 都计入：一次 2 小时的执行约 150 次，加上失败后的再次提交与暂停后的续跑）。
 */
export const GENERATE_SECTIONS_TOOL_OPTIONS: AgentLongToolOptions = Object.freeze({
  name: GENERATE_SECTIONS_TOOL,
  argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
  maxArgumentBytes: 1024,
  maxCallsPerJob: 2_000,
  maxCallsPerMinute: 20,
});
export const generateSectionsTool = createAgentLongTool(GENERATE_SECTIONS_TOOL_OPTIONS);

/** 任务文件至多这么多字节（instructions 与 references 是 Agent 的补充要求与资料摘录）。 */
export const CONTENT_SECTIONS_TASK_MAX_BYTES = 4 * 1024 * 1024;
/** 判断“已生成正文”时每个正文文件至多读这么多字节（更大的文件按非空白处理）。 */
const SECTION_FILE_CHECK_MAX_BYTES = 1024 * 1024;
/** readFiles 一次至多读取的文件数（AGENT_READ_MAX_FILES）。 */
const READ_BATCH = 256;
/** 部分服务在请求结束后才异步构建前缀缓存，预热后稍候再放开后续请求（与桌面版 PREFIX_WARMUP_SETTLE_MS 相同）。 */
export const CONTENT_PREFIX_WARMUP_SETTLE_MS = 1500;

/** 写作次数的计数（随任务的 checkpoint 保存，续跑时据此重算步骤键）。 */
export interface GenerateSectionsState {
  /** 小节 id → 已发出的写作次数。 */
  readonly attempts: Readonly<Record<string, number>>;
  /** 已发出的预热次数。 */
  readonly warmups: number;
}

const MAX_COUNTER = 1_000_000;
const isCounter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER;

/** 解析 checkpoint 中的计数（不合法时抛 TypeError：checkpoint 由执行者写下，不合法是程序错误）。 */
export function parseGenerateSectionsState(raw: unknown): GenerateSectionsState {
  if (raw === null || raw === undefined) return { attempts: {}, warmups: 0 };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('generate-sections 的计数不合法');
  const { attempts, warmups } = raw as Record<string, unknown>;
  if (typeof attempts !== 'object' || attempts === null || Array.isArray(attempts) || !isCounter(warmups)) throw new TypeError('generate-sections 的计数不合法');
  const entries = Object.entries(attempts as Record<string, unknown>);
  if (!entries.every(([, value]) => isCounter(value))) throw new TypeError('generate-sections 的计数不合法');
  return { attempts: Object.fromEntries(entries) as Record<string, number>, warmups };
}

export interface GeneratedSection {
  readonly section_id: string;
  readonly file: string;
  readonly words: number;
}

export interface GenerateSectionsOptions {
  /** 本次执行的工作区（读取任务文件与正文文件、写回正文）。 */
  readonly run: Pick<AgentRun, 'readFiles' | 'writeFiles'>;
  readonly ai: JobAi;
  /** 组织选用的文本模型（resolveJobModel）。 */
  readonly model: JobModel;
  /** 服务端按 8.10c1 生成的写作材料。 */
  readonly materials: ContentSectionWritingMaterials;
  /** 上次 checkpoint 中的计数（首次执行省略）。 */
  readonly state?: GenerateSectionsState;
  /** 本任务的图片保护（8.10c3b1，与 check-word-count 共用）：进入保护后不再生成正文。 */
  readonly protection?: Pick<ContentImageProtection, 'assertToolAllowed'>;
  /** 一节写回工作区之后调用（8.10c3 写入运行进度与字数）。抛出的错误按致命错误处理。 */
  onSectionSaved?(section: GeneratedSection): void | Promise<void>;
  /** 测试用：预热之后的等待。 */
  readonly warmupSettleMs?: number;
}

export interface GenerateSectionsExecutor {
  readonly execute: AgentLongToolExecutor;
  /** 当前的计数（保存 checkpoint 时写入）。 */
  state(): GenerateSectionsState;
}

/** 说明中可以带出的小节 id（目标 id 是 UUID；其他写法按“无法识别”给出，不回显 Agent 写的任意文字）。 */
const SAFE_ID = /^[0-9A-Za-z._-]{1,64}$/;

/**
 * 任务文件的问题 → 交给 Agent 的说明（桌面版的文字）。说明是固定文字：JSON 解析错误不带出文件内容的片段（V8 的说明会摘录输入）；
 * Schema 的问题只有数据中的位置与 Schema 的要求。
 */
function taskRejection(error: ContentSectionTaskError): AgentToolRequestRejection {
  if (error.message.startsWith(`${CONTENT_SECTIONS_TASK_FILE} 不是有效 JSON`)) {
    return new AgentToolRequestRejection(`${CONTENT_SECTIONS_TASK_FILE} 不是有效 JSON，请修正后再次提交`);
  }
  return new AgentToolRequestRejection(error.message);
}

/** 非目标与重复的小节（桌面版的文字；不合规的 id 不原样回显）。 */
function invalidTargetsRejection(jobs: readonly ContentSectionJob[], targets: ReadonlyMap<string, unknown>): AgentToolRequestRejection {
  const ids = jobs.map((job) => job.section_id);
  const invalid = [...new Set(ids.filter((id, index) => !targets.has(id) || ids.indexOf(id) !== index))];
  const shown = invalid.map((id) => (SAFE_ID.test(id) ? id : '（无法识别的 id）'));
  return new AgentToolRequestRejection(`任务文件只能包含本次目标小节，且同一小节不能重复出现：${[...new Set(shown)].join('、')}`);
}

const decodeUtf8 = (data: Buffer): string => data.toString('utf8');

export function createGenerateSectionsExecutor(options: GenerateSectionsOptions): GenerateSectionsExecutor {
  const { run, ai, model, materials } = options;
  const initial = parseGenerateSectionsState(options.state ?? null);
  const attempts = new Map(Object.entries(initial.attempts));
  let warmups = initial.warmups;
  const warmupSettleMs = options.warmupSettleMs ?? CONTENT_PREFIX_WARMUP_SETTLE_MS;
  const system = contentSectionWritingSystem(materials);
  const sharedInput = contentSectionSharedInput(materials);

  async function readTask(): Promise<ContentSectionJob[]> {
    const file = (await run.readFiles([CONTENT_SECTIONS_TASK_FILE], { maxFileBytes: CONTENT_SECTIONS_TASK_MAX_BYTES, maxTotalBytes: CONTENT_SECTIONS_TASK_MAX_BYTES })).get(
      CONTENT_SECTIONS_TASK_FILE,
    );
    if (file && file.data === null) throw new AgentToolRequestRejection(`${CONTENT_SECTIONS_TASK_FILE} 过大，请精简补充要求与资料摘录后再次提交`);
    try {
      return readContentSectionsTask(file ? decodeUtf8(file.data!) : null);
    } catch (error) {
      if (error instanceof ContentSectionTaskError) throw taskRejection(error);
      throw error;
    }
  }

  /** 本次各小节的正文文件是否已有非空白的内容。 */
  async function generatedSections(jobs: readonly ContentSectionJob[]): Promise<Set<string>> {
    const files = [...new Set(jobs.map((job) => materials.targets.get(job.section_id)!.file))];
    const nonBlank = new Set<string>();
    for (let index = 0; index < files.length; index += READ_BATCH) {
      const read = await run.readFiles(files.slice(index, index + READ_BATCH), { maxFileBytes: SECTION_FILE_CHECK_MAX_BYTES });
      for (const [path, file] of read) {
        if (file.data === null ? file.size > 0 : decodeUtf8(file.data).trim() !== '') nonBlank.add(path);
      }
    }
    return new Set(jobs.filter((job) => nonBlank.has(materials.targets.get(job.section_id)!.file)).map((job) => job.section_id));
  }

  /** 没有选择模型 / 所选模型不可用（未登记、已停用、未定价、服务未配置）转成暂停（#98，见文件头）；不计入连续失败。 */
  const chat = async (stepKey: string, messages: ReturnType<typeof sharedPrefixMessages>, signal: AbortSignal, maxOutputTokens?: number): Promise<ChatResult> => {
    try {
      return await ai.chat({ provider: model.provider, model: model.model, messages, stepKey, ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) }, { signal });
    } catch (error) {
      throw jobModelUnavailableError(error) ?? error;
    }
  };

  /** 预热公共前缀（与桌面版 warmPromptPrefix 相同）：模型服务的普通失败不影响后续请求；暂停、上限、中断等照常抛出。 */
  async function warmUp(signal: AbortSignal): Promise<void> {
    warmups += 1;
    try {
      const result = await chat(`content-section-prefix:${warmups}`, sharedPrefixMessages(system, sharedInput), signal, 1);
      if (result.aborted) throw new JobInterruptedError();
      await abortableDelay(warmupSettleMs, signal);
    } catch (error) {
      if (signal.aborted) throw new JobInterruptedError();
      // 模型服务的普通失败忽略；模型不可用（已转成 JobModelUnavailableError）与暂停类错误照常抛出。
      if (error instanceof JobError) return;
      throw error;
    }
  }

  async function execute(request: AgentToolRequestExecution): Promise<unknown> {
    options.protection?.assertToolAllowed(GENERATE_SECTIONS_TOOL);
    const jobs = await readTask();
    try {
      planContentSectionBatch(jobs, materials.targets, () => false);
    } catch (error) {
      if (error instanceof ContentSectionTaskError) throw invalidTargetsRejection(jobs, materials.targets);
      throw error;
    }
    const generated = await generatedSections(jobs);
    const batch = planContentSectionBatch(jobs, materials.targets, (id) => generated.has(id));

    // 致命错误中止本批剩余各节；守卫在连续失败时中止。
    const fatalController = new AbortController();
    const guard = createAiBatchGuard({ signal: AbortSignal.any([request.signal, fatalController.signal]) });
    let fatal: { error: unknown } | null = null;
    const recordFatal = (error: unknown) => {
      fatal ??= { error };
      fatalController.abort();
    };
    // 写回依次进行（sandbox-runner 的放入不并发）。
    let writes: Promise<void> = Promise.resolve();
    const writeSection = (section: ContentWritingTarget, html: string): Promise<void> => {
      const next = writes.then(async () => {
        guard.signal.throwIfAborted();
        await run.writeFiles([{ path: section.file, data: Buffer.from(html, 'utf8') }]);
      });
      writes = next.catch(() => {});
      return next;
    };

    async function writeOne(job: ContentSectionJob): Promise<ContentSectionResult> {
      const section = materials.targets.get(job.section_id)!;
      try {
        guard.signal.throwIfAborted();
        const attempt = (attempts.get(section.id) ?? 0) + 1;
        attempts.set(section.id, attempt);
        const result = await chat(`content-section:${section.id}:${attempt}`, sharedPrefixMessages(system, sharedInput, contentSectionInput(section, job)), guard.signal);
        if (result.aborted) throw new JobInterruptedError();
        // 截断、不合规与结构问题不落盘，作为本节失败交回 Agent 重试。
        const html = finishSectionHtml(result.content, result.finishReason);
        guard.signal.throwIfAborted();
        guard.success();
        await writeSection(section, html);
        const saved = contentSectionSuccess(section, html) as GeneratedSection & { status: 'success' };
        await options.onSectionSaved?.({ section_id: saved.section_id, file: saved.file, words: saved.words });
        return saved;
      } catch (error) {
        // 本批已中止（守卫触发、致命错误、请求中止）之后的结果按取消处理，执行函数随后抛出中止的原因。
        if (guard.signal.aborted) return { section_id: section.id, status: 'error', error: '已取消' };
        // 本节失败、交回 Agent 重试：输出不合格（清零守卫的计数）与服务商一侧的失败（计入守卫）。
        if (error instanceof ContentSectionOutputError || error instanceof HtmlStructureError || isAiUpstreamFailure(error)) {
          guard.failure(error);
          return { section_id: section.id, status: 'error', error: error.message };
        }
        // 其余是致命错误：余额不足、任务上限、没有选择模型 / 所选模型不可用（暂停，#98）、中断等 JobAi 的错误，写回工作区或
        // onSectionSaved 失败，程序错误。
        recordFatal(error);
        return { section_id: section.id, status: 'error', error: '已取消' };
      }
    }

    if (batch.pending.length > 1) {
      try {
        await warmUp(guard.signal);
      } catch (error) {
        recordFatal(error);
      }
    }
    const written = fatal === null ? new Map((await Promise.all(batch.pending.map(writeOne))).map((result) => [result.section_id, result])) : new Map();
    await writes;
    if (fatal !== null) throw (fatal as { error: unknown }).error;
    if (request.signal.aborted) throw new JobInterruptedError();
    if (guard.error) throw guard.error;
    const results = batch.ids.map((id) => batch.skipped.get(id) ?? written.get(id)!);
    return compactResults(results);
  }

  return {
    execute,
    state: () => ({ attempts: Object.fromEntries(attempts), warmups }),
  };
}
