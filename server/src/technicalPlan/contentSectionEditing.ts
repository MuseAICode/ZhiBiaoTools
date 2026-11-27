// 正文小节的并发编辑（路线图第 8 步 8.10c3b2；docs/SERVER_DESIGN.md 第 7.48 节），取代桌面版 contentGenerationEditTools.cjs 的
// editContentSections：每个小节交给一个**子会话**（#126 用户决定：在同一沙箱内并发子会话执行，与桌面版相同），子会话用原生工具直接
// 修改本节 HTML，结束后由程序检查本节。提交问题修复（fix-submission-issues，8.10c3b3）与一致性修复（8.10f）共用。
//
// 与桌面版相同：
// - 只能编辑本次目标小节，同一批中不能重复；同一小节不能被两批同时编辑（activity.editing，同一任务的各个编辑工具共用），不同小节可以并发；
// - 子会话的提示词逐字相同（同批共用的规则在前，本节任务与正文在最后，便于复用请求前缀缓存）；preloadInput 时附上受限 HTML 生成规范的
//   完整内容与本节启动时的完整 HTML；执行异常在同一子会话中续接一次（max_retries 1，续接说明相同），报告失败、轮数上限、墙钟到期不续接；
// - 本批以外、且不在其他批次编辑中的目标小节在派发前记下内容，结束后被改动的直接还原（原本不存在的删除），返回还原的文件；
// - 子会话结束后只检查一次本节（inspect），问题交回主 Agent 统一处理。
//
// 与桌面版的差异（#127 说明）：
// 1. 规则与事实处理要求取服务端生成的材料（受限HTML生成规范.md 与 正文编排决策.json 的 global_facts_requirements），不读工作区的副本；
//    本节 HTML 经 run.readFiles 读取（不存在或过大时本节失败，说明为固定文字）；
// 2. 并发：同时运行的子会话由执行者限定为 AGENT_CHILD_SESSION_CONCURRENCY 个（桌面版为文本并发上限的 2 倍）；
// 3. 子任务的墙钟（30 分钟）由沙箱内的入口按一条提示词执行（桌面版为 30 分钟无进展）；
// 4. 致命错误（余额不足、任务上限、模型不可用、中止、本次执行的时限、沙箱失败）不记为本节失败：中止本批其余子会话后按原因抛出，
//    执行者随之中止主会话的入口（与 generate-sections 相同，第 7.45 节）；桌面版的这类错误在父任务中另行处理；
// 5. 两批并发时，先结束的批次编辑过的小节不被后结束的批次还原（桌面版只看结束时是否仍在编辑中，会把它当作本批以外被改动而还原）；
//    Web 版每个任务同时至多一个未关闭的长时工具请求（迁移 0047），两批目前不会重叠，这一项只是让共用的机制本身正确；
// 6. 进度（onActivity）随 8.10c3c 与第 9 步。
//
// 子会话报告失败的原因、检查出的问题说明来自沙箱或 Agent 写出的内容，只作为纯文本交回同一个主 Agent。本模块不写日志。
import { AGENT_CHILD_MAX_TURNS_PER_PROMPT, AGENT_WRITE_MAX_FILES, AGENT_WRITE_TOTAL_MAX_BYTES, type AgentChildPromptOutcome, type AgentRun } from '../agent/execution.ts';
import { AgentToolRequestRejection } from '../agent/toolRequests.ts';
import { JobInterruptedError } from '../jobs/definitions.ts';
import type { ContentSubmissionTarget } from './contentSubmission.ts';
import { CONTENT_SECTION_READ_MAX_BYTES, readContentSectionFiles } from './contentWordCount.ts';

/** 编辑类工具的标题（桌面版的 title；步骤名随进度显示，第 9 步）。 */
export type ContentSectionEditTitle = '一致性修复' | '提交问题修复';

/** 一个小节的编辑任务。 */
export interface ContentSectionEditJob {
  readonly section_id: string;
  readonly instructions: string;
}

/** 跨批共享的编辑状态（桌面版 activity.editing）：同一任务的各个编辑工具共用一个。 */
export interface ContentSectionEditActivity {
  /** 正在编辑的小节。 */
  readonly editing: Set<string>;
  /** 正在运行的各批记下的“期间其他批次编辑过的小节”（结束时不还原它们）。 */
  readonly running: Set<Set<string>>;
}

export function createContentSectionEditActivity(): ContentSectionEditActivity {
  return { editing: new Set(), running: new Set() };
}

/** 本节编辑结束后的检查结果（8.10c3b3：inspectContentSection 的问题；8.10f：一致性问题与事实）。 */
export interface ContentSectionEditInspection {
  readonly issues: readonly { readonly message: string }[];
  readonly facts?: unknown;
}

export interface ContentSectionEditResult {
  readonly section_id: string;
  readonly status: 'success' | 'error';
  readonly facts?: unknown;
  readonly issues?: readonly { readonly message: string }[];
  readonly error?: string;
}

export interface EditContentSectionsOptions {
  readonly run: Pick<AgentRun, 'readFiles' | 'writeFiles' | 'removeFiles' | 'childPrompt'>;
  readonly jobs: readonly ContentSectionEditJob[];
  /** 本轮目标小节（服务端生成的 正文编排决策.json 的 targets，按目录顺序）。 */
  readonly targets: ReadonlyMap<string, ContentSubmissionTarget>;
  readonly activity: ContentSectionEditActivity;
  /** 服务端生成的 正文编排决策.json 的 global_facts_requirements。 */
  readonly factsRequirements: string;
  /** 服务端生成的 受限HTML生成规范.md（preloadInput 时附上）。 */
  readonly rules: string;
  readonly title: ContentSectionEditTitle;
  /** 本批共用的要求（工具给出）。 */
  readonly instructions: string;
  readonly preserveDataTables?: boolean;
  readonly preloadInput?: boolean;
  /** 子会话结束后检查本节（经 run.readFiles 读取最新文件）。 */
  inspect(section: ContentSubmissionTarget): Promise<ContentSectionEditInspection>;
  /** 长时工具执行函数的 signal（本条提示词结束、任务中止时中止）。 */
  readonly signal: AbortSignal;
  onResult?(result: ContentSectionEditResult): void;
}

export interface EditContentSectionsResult {
  readonly results: ContentSectionEditResult[];
  /** 还原的本批以外被改动的小节文件。 */
  readonly restored: string[];
}

/** 子会话的执行重试次数（桌面版 max_retries: 1）。 */
export const CONTENT_SECTION_EDIT_MAX_RETRIES = 1;

const SECTION_MISSING = '小节 HTML 文件不存在';
const SECTION_TOO_LARGE = '小节 HTML 文件过大，无法读取';

function stopMessage(outcome: AgentChildPromptOutcome): string {
  switch (outcome.status) {
    case 'reported':
      return outcome.reason ?? 'Agent 无法继续当前任务';
    case 'turn-limit':
      // 与桌面版 AGENT_TURN_LIMIT 的说明相同。
      return `子代理在一次任务提示后已连续执行 ${AGENT_CHILD_MAX_TURNS_PER_PROMPT} 轮仍未结束，已停止本次子任务`;
    case 'time-limit':
      return '子任务执行超过 30 分钟，已停止本次子任务';
    case 'session-invalid':
      return '子任务的会话不可用，已停止本次子任务';
    default:
      return outcome.reason ?? '模型调用失败';
  }
}

/** 子会话的提示词（与桌面版 editContentSections 的 prompt 逐字相同）。 */
export function contentSectionEditPrompt(input: {
  readonly title: ContentSectionEditTitle;
  readonly section: ContentSubmissionTarget;
  readonly job: ContentSectionEditJob;
  readonly factsRequirements: string;
  readonly instructions: string;
  readonly preserveDataTables: boolean;
  /** preloadInput 时给出：规范全文与本节启动时的完整 HTML。 */
  readonly preload: { readonly rules: string; readonly html: string } | null;
}): string {
  const { title, section, job, factsRequirements, instructions, preserveDataTables, preload } = input;
  const number = section.number ?? '';
  const sharedInput = preload ? `\n\n受限 HTML 生成规范（完整内容）：\n${preload.rules}` : '';
  const sectionInput = preload ? `\n\n本小节启动时的完整 HTML（${section.file}）：\n${preload.html}` : '';
  const readingInstructions = preload
    ? '优先使用已提供的正文和规范直接修改，通常无需重复读取。需要核对最新内容、定位编辑位置或补充上下文时，可使用 grep、read 或 bash；修改后以最新文件为准。'
    : '阅读受限 HTML 规范，并根据本次任务读取目标正文；需要全文自查时分段覆盖，需要局部修改时先定位再读取相关上下文。优先使用 edit 保存修改，必要时可使用其他可用工具辅助处理。';
  return `你负责编辑投标正文中的一个小节，执行${title}。具体小节、文件和本次要求见末尾“本次任务”。\n本项目事实缺失处理要求（仅适用于本任务允许补充的内容，不扩大本次编辑范围）：${factsRequirements}\n优先使用原生 edit 修改本次任务指定的小节文件，可按需使用 bash 处理工作区文件；不要改其他小节、输入资料或结果清单，程序会还原这些文件。已有图片块（含图注与提示词）、图片引用和顺序、图片表格布局不得删除、替换、复制、调序或修改；可以调整图文表格中的普通说明文字。编辑结束后程序检查本节结构、图片引用和图片块，问题交由主 Agent 统一处理。保留受限 HTML 结构并保持所有元素完整闭合，保留原有图片及引用、${preserveDataTables ? '原表格、' : '表格中的全部数据和含义、'}实质信息、事实参数和承诺。本次新增或改写的正文禁止使用 LaTeX 语法，包括 $...$、$$...$$、\\(...\\)、\\[...\\] 及 \\frac、\\text、\\circ 等命令。公式、参数和单位使用普通文字、Unicode 数学符号及受限 HTML 的 <sup>、<sub> 表达，例如 22 ℃ ± 2 ℃、40%～65%、≥30 m<sup>3</sup>/(h·人)。参考材料中的 LaTeX 在写入正文时也须转换为上述表达，保持数值、单位和含义不变。${instructions} 事实冲突以全局事实设定.md为准，按需读取。本次要求尚未完全达成时，保留真实正文并提交，由主 Agent 统一验收；只有无法继续执行的实际阻断才调用 report-failure。edit 返回文本未匹配等错误时，重新读取最新文件，依据实际原文修正编辑参数并重试。修改由当前子任务直接写入目标 HTML，不以返回补丁文本代替文件修改。完成本次编辑并核实真实结果后，在最后一次成功的 edit、bash 或 read 上标记 task_complete=true，不承担全文达标或修改其他小节的任务。${sharedInput}\n\n本次任务：\n你负责编辑小节 ${number} ${section.title}，文件为 ${section.file}。${readingInstructions}再按以下要求${title}：\n${job.instructions}${sectionInput}`;
}

/** 执行异常后的续接说明（与桌面版 buildRetryPrompt 相同）。 */
export function contentSectionEditRetryPrompt(section: ContentSubmissionTarget, reason: string, attempt: number, maxRetries: number): string {
  return `上一轮小节编辑执行中断：${Array.from(reason).slice(0, 12000).join('')}\n在当前会话中继续处理 ${section.file}，保留已经完成的修改；完成本次编辑后标记 task_complete=true。这是第 ${attempt}/${maxRetries} 次执行续接。`;
}

const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/** 本节失败：子会话的结束方式（不重试的、或重试用完的）。 */
class SectionEditFailure extends Error {}

/** 读取若干小节文件的当前内容：不存在为 null，过大为 undefined（无法比较，不还原）。 */
async function readSectionContents(run: EditContentSectionsOptions['run'], sections: readonly ContentSubmissionTarget[]): Promise<Map<string, Buffer | null | undefined>> {
  const { files } = await readContentSectionFiles(run, sections);
  return new Map(sections.map((section) => {
    const file = files.get(section.file);
    return [section.file, file === undefined ? null : file.data ?? undefined];
  }));
}

/** 按 writeFiles 的个数与合计上限分批（单个小节不超过读取上限 8 MiB）。 */
function writeChunks(files: readonly { path: string; data: Buffer }[]): { path: string; data: Buffer }[][] {
  const chunks: { path: string; data: Buffer }[][] = [];
  let chunk: { path: string; data: Buffer }[] = [];
  let bytes = 0;
  for (const file of files) {
    if (chunk.length && (chunk.length >= AGENT_WRITE_MAX_FILES || bytes + file.data.length > AGENT_WRITE_TOTAL_MAX_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(file);
    bytes += file.data.length;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/**
 * 并发编辑若干小节（见文件头）。jobs 中有非本轮目标或重复的小节、或小节正在其他批次中编辑时抛 AgentToolRequestRejection（说明交给
 * 主 Agent）。致命错误按原因抛出（本批其余子会话被中止）。
 */
export async function editContentSections(options: EditContentSectionsOptions): Promise<EditContentSectionsResult> {
  const { run, jobs, targets, activity, signal } = options;
  const ids = jobs.map((job) => job.section_id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !targets.has(id))) throw new AgentToolRequestRejection('只能编辑本次目标小节，同一任务中不能重复出现同一小节');
  const busy = ids.filter((id) => activity.editing.has(id));
  if (busy.length) throw new AgentToolRequestRejection(`以下小节正在其他批次中编辑，请等待结束后再提交：${busy.join('、')}`);
  const preserveDataTables = options.preserveDataTables ?? true;
  for (const id of ids) activity.editing.add(id);
  // 正在运行的其他批次记下本批的小节：它们结束时不把本批改过的小节当作“本批以外被改动”还原（桌面版只看结束时是否仍在编辑中）。
  for (const others of activity.running) for (const id of ids) others.add(id);
  const others = new Set<string>();
  activity.running.add(others);
  // 本批的中止：致命错误时中止其余子会话（终止沙箱），之后按第一个致命错误抛出。
  const batch = new AbortController();
  const batchSignal = AbortSignal.any([signal, batch.signal]);
  let fatal: { error: unknown } | null = null;
  try {
    // 本批以外且未在其他批次编辑的目标小节不应被子任务改动，结束后与派发前比对，被改的直接还原。
    const untouchedSections = [...targets.values()].filter((section) => !activity.editing.has(section.id));
    const untouched = await readSectionContents(run, untouchedSections);

    const results = await Promise.all(jobs.map(async (job): Promise<ContentSectionEditResult> => {
      const section = targets.get(job.section_id)!;
      try {
        batchSignal.throwIfAborted();
        let preload: { rules: string; html: string } | null = null;
        if (options.preloadInput) {
          // 每次派发都读取当前文件，不复用旧快照。
          const file = (await run.readFiles([section.file], { maxFileBytes: CONTENT_SECTION_READ_MAX_BYTES, maxTotalBytes: CONTENT_SECTION_READ_MAX_BYTES })).get(section.file);
          if (!file) throw new SectionEditFailure(SECTION_MISSING);
          if (file.data === null) throw new SectionEditFailure(SECTION_TOO_LARGE);
          preload = { rules: options.rules, html: file.data.toString('utf8') };
        }
        const prompt = contentSectionEditPrompt({ title: options.title, section, job, factsRequirements: options.factsRequirements, instructions: options.instructions, preserveDataTables, preload });
        let outcome = await run.childPrompt({ prompt, signal: batchSignal });
        // 子任务只续接执行异常；产物检查与修复决策交由父阶段处理。
        for (let attempt = 1; outcome.status === 'model-failed' && attempt <= CONTENT_SECTION_EDIT_MAX_RETRIES; attempt += 1) {
          const reason = outcome.reason ?? '模型调用失败';
          // 还没有写出会话文件（第一次模型调用就失败）：重新发出本节任务。
          const next = outcome.session === null ? prompt : contentSectionEditRetryPrompt(section, reason, attempt, CONTENT_SECTION_EDIT_MAX_RETRIES);
          outcome = await run.childPrompt({ prompt: next, session: outcome.session, signal: batchSignal });
        }
        if (outcome.status !== 'completed') throw new SectionEditFailure(stopMessage(outcome));
        batchSignal.throwIfAborted();
        // 子任务交付后只检查一次当前产物，不在子会话内启动修复循环。
        const inspected = await options.inspect(section);
        const result: ContentSectionEditResult = {
          section_id: section.id,
          status: inspected.issues.length ? 'error' : 'success',
          ...(inspected.facts !== undefined ? { facts: inspected.facts } : {}),
          ...(inspected.issues.length ? { issues: inspected.issues, error: inspected.issues.map((issue) => issue.message).join('\n') } : {}),
        };
        options.onResult?.(result);
        return result;
      } catch (error) {
        if (error instanceof SectionEditFailure) return { section_id: section.id, status: 'error', error: error.message };
        fatal ??= { error: isAbortError(error) ? new JobInterruptedError() : error };
        batch.abort();
        return { section_id: section.id, status: 'error' };
      }
    }));
    if (fatal) throw (fatal as { error: unknown }).error;
    if (signal.aborted) throw new JobInterruptedError();

    // 期间开始的其他批次正在编辑的小节由该批自行处理。
    const current = await readSectionContents(run, untouchedSections.filter((section) => !activity.editing.has(section.id) && !others.has(section.id)));
    const restored: string[] = [];
    const rewrite: { path: string; data: Buffer }[] = [];
    const remove: string[] = [];
    for (const [file, after] of current) {
      const before = untouched.get(file);
      // 过大的无法比较（派发前或结束后），不还原。
      if (before === undefined || after === undefined) continue;
      if (before === null ? after === null : after !== null && before.equals(after)) continue;
      if (before === null) remove.push(file);
      else rewrite.push({ path: file, data: before });
      restored.push(file);
    }
    for (const chunk of writeChunks(rewrite)) await run.writeFiles(chunk);
    for (let index = 0; index < remove.length; index += AGENT_WRITE_MAX_FILES) await run.removeFiles(remove.slice(index, index + AGENT_WRITE_MAX_FILES));
    return { results, restored };
  } finally {
    activity.running.delete(others);
    for (const id of ids) activity.editing.delete(id);
  }
}
