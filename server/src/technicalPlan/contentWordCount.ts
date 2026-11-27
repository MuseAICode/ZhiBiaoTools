// 业务工具 check-word-count（路线图第 8 步 8.10c3b1；docs/SERVER_DESIGN.md 第 7.47 节），取代桌面版 contentGenerationWordTools.cjs 的
// checkWordCount、reportWordCount 与 check-word-count 的 execute。
//
// 与桌面版相同：读取各目标小节的实际 HTML，按 countHtmlWords 统计字数（不含配图提示词），字数为 0 的小节记为缺失；全部小节都有正文时
// 先要求各节没有提交校验的问题（与 inspectContentSection 的规则相同，含 Web 版另加的受限 HTML 检查），再进入图片保护（不再能调用
// generate-sections 与配图工具，contentImageProtection.ts）。各节字数与缺失小节写进 `程序清单/正文字数统计.json`，交给 Agent 的只有
// 总字数、上下限、节数与说明：差额与方向不交给模型，避免主 Agent 自行增删字数（字数要求由程序在本阶段提交后统一处理，8.10e）。
//
// - 内部入口一侧（checkWordCountTool）：长时工具（src/agent/toolRequests.ts），参数为空对象；执行很快，通常在第一次等待内取回。
// - 执行者一侧（createCheckWordCountExecutor，写作阶段的提示词经 AgentPromptInput.longTools 给出，8.10c3c 接入）：经 run.readFiles
//   读取各节 HTML 与其中引用的图片文件是否存在，经 run.writeFiles 写回清单。目标小节与字数要求取服务端生成的材料，不读工作区的副本。
// - 桌面版“仍有生成或编辑任务运行”的检查：Web 版每个任务同时至多一个未关闭的长时工具请求（迁移 0047），generate-sections 执行期间
//   再调用本工具得到 409 AGENT_TOOL_REQUEST_PENDING，不需要另行检查。
//
// 交给 Agent 的问题说明可能含 Agent 写出的内容（alt、引用路径、元素 id），只当作纯文本交回同一个 Agent；超过 500 字时截断
// （AgentToolRequestRejection），完整的问题在提交校验时另有清单。
import { AGENT_READ_MAX_FILES, AGENT_READ_TOTAL_MAX_BYTES, type AgentRun, type AgentWorkspaceFile } from '../agent/execution.ts';
import { AgentToolRequestRejection, createAgentLongTool, type AgentLongToolExecutor, type AgentLongToolOptions } from '../agent/toolRequests.ts';
import type { ContentImageProtection } from './contentImageProtection.ts';
import { contentImagePaths, inspectContentSection, type ContentSubmissionTarget } from './contentSubmission.ts';

export const CHECK_WORD_COUNT_TOOL = 'check-word-count';
/** 程序清单中的各节字数（与桌面版 LIST_DIR / LIST_FILES.words 相同）。 */
export const CONTENT_WORD_COUNT_FILE = '程序清单/正文字数统计.json';
/** 与桌面版 WORD_COUNT_ONLY_NOTE 相同。 */
export const WORD_COUNT_ONLY_NOTE = '本工具只统计实际字数：保持正文不变，不以任何方式（包括脚本批量删改）调整字数；字数要求由程序在本阶段提交后按设置统一处理。';

/**
 * 内部入口一侧的工具（登记在 src/agent/toolRegistry.ts）。参数为空对象（桌面版的 schema 不限制多余的键，Web 版与其他长时工具相同
 * 不接受，见 #126 差异第 2 项）；次数与频率上限与 generate-sections 相同。
 */
export const CHECK_WORD_COUNT_TOOL_OPTIONS: AgentLongToolOptions = Object.freeze({
  name: CHECK_WORD_COUNT_TOOL,
  argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
  maxArgumentBytes: 1024,
  maxCallsPerJob: 2_000,
  maxCallsPerMinute: 20,
});
export const checkWordCountTool = createAgentLongTool(CHECK_WORD_COUNT_TOOL_OPTIONS);

/** 每个小节 HTML 至多读这么多字节（更大的按“过大，无法读取”报告；入库上限为规范化后 2 MiB）。 */
export const CONTENT_SECTION_READ_MAX_BYTES = 8 * 1024 * 1024;

/** 正文编排决策.json 的 word_control（服务端生成的材料）。 */
export interface ContentWordCountControl {
  readonly minimumWords: number;
  readonly maximumWords: number;
  readonly checkTotalWords: boolean;
}

export interface ContentWordCountSection {
  readonly section_id: string;
  readonly number?: string;
  readonly file: string;
  readonly words: number;
}

/** 与桌面版 checkWordCount 的返回值相同。 */
export interface ContentWordCount {
  readonly complete: boolean;
  readonly missing_section_ids: string[];
  readonly sections: ContentWordCountSection[];
  readonly total_words: number;
  readonly minimum_words: number;
  readonly maximum_words: number;
  readonly check_total_words: boolean;
  readonly difference: number;
  readonly direction: 'none' | 'expand' | 'shrink';
  readonly in_range: boolean;
}

/** 与桌面版 checkWordCount 相同：按各节的实际字数（检查时已统计）计算总数与差额。 */
export function contentWordCount(
  targets: readonly ContentSubmissionTarget[],
  words: ReadonlyMap<string, number>,
  control: ContentWordCountControl,
): ContentWordCount {
  const sections: ContentWordCountSection[] = [];
  const missing: string[] = [];
  for (const section of targets) {
    const count = words.get(section.id) ?? 0;
    if (count <= 0) missing.push(section.id);
    else sections.push({ section_id: section.id, ...(section.number !== undefined ? { number: section.number } : {}), file: section.file, words: count });
  }
  const total = sections.reduce((sum, section) => sum + section.words, 0);
  const { minimumWords, maximumWords, checkTotalWords } = control;
  const difference = !checkTotalWords ? 0 : minimumWords > 0 && total < minimumWords ? minimumWords - total : maximumWords > 0 && total > maximumWords ? total - maximumWords : 0;
  const direction = !difference ? 'none' : minimumWords > 0 && total < minimumWords ? 'expand' : 'shrink';
  return {
    complete: missing.length === 0,
    missing_section_ids: missing,
    sections,
    total_words: total,
    minimum_words: minimumWords,
    maximum_words: maximumWords,
    check_total_words: checkTotalWords,
    difference,
    direction,
    in_range: missing.length === 0 && difference === 0,
  };
}

/** 清单文件的内容与交给 Agent 的结果（与桌面版 reportWordCount 及 execute 去掉差额、方向、是否达标之后的相同）。 */
export function contentWordCountReport(words: ContentWordCount): { file: { path: string; content: string }; result: Record<string, unknown> } {
  const { sections, missing_section_ids: missing, difference: _difference, direction: _direction, in_range: _inRange, ...totals } = words;
  return {
    file: { path: CONTENT_WORD_COUNT_FILE, content: JSON.stringify({ total_words: words.total_words, sections, missing_section_ids: missing }, null, 2) },
    result: { ...totals, section_count: sections.length, missing_count: missing.length, detail_file: CONTENT_WORD_COUNT_FILE, note: WORD_COUNT_ONLY_NOTE },
  };
}

/**
 * 读取各目标小节的 HTML 与其中引用的图片文件是否存在（经 run.readFiles；8.10c3c 的提交校验、8.10c3b2 的修复复查同样使用）。
 * 超过 CONTENT_SECTION_READ_MAX_BYTES 的小节只有大小；因一次读取的合计上限没有读到的，下一轮再读（每轮至少读到一个）。
 */
export async function readContentSectionFiles(
  run: Pick<AgentRun, 'readFiles'>,
  targets: readonly ContentSubmissionTarget[],
): Promise<{ files: Map<string, AgentWorkspaceFile>; existingImages: Set<string> }> {
  const files = new Map<string, AgentWorkspaceFile>();
  let pending = [...new Set(targets.map((target) => target.file))];
  while (pending.length) {
    const batch = pending.slice(0, AGENT_READ_MAX_FILES);
    const read = await run.readFiles(batch, { maxFileBytes: CONTENT_SECTION_READ_MAX_BYTES, maxTotalBytes: AGENT_READ_TOTAL_MAX_BYTES });
    const retry: string[] = [];
    for (const path of batch) {
      const file = read.get(path);
      if (!file) continue;
      // 合计上限之外的（自身不超过单个上限）下一轮再读。
      if (file.data === null && file.size <= CONTENT_SECTION_READ_MAX_BYTES) retry.push(path);
      else files.set(path, file);
    }
    if (retry.length === batch.length) throw new TypeError('读取正文文件没有进展');
    pending = [...retry, ...pending.slice(batch.length)];
  }
  const images = [...new Set([...files.values()].flatMap((file) => (file.data ? contentImagePaths(file.data.toString('utf8')) : [])))];
  const existingImages = new Set<string>();
  for (let index = 0; index < images.length; index += AGENT_READ_MAX_FILES) {
    const read = await run.readFiles(images.slice(index, index + AGENT_READ_MAX_FILES), { maxFileBytes: 0, maxTotalBytes: 0 });
    for (const path of read.keys()) existingImages.add(path);
  }
  return { files, existingImages };
}

export interface CheckWordCountOptions {
  readonly run: Pick<AgentRun, 'readFiles' | 'writeFiles'>;
  /** 本轮目标小节（服务端生成的 正文编排决策.json 的 targets）。 */
  readonly targets: readonly ContentSubmissionTarget[];
  /** 服务端生成的 正文编排决策.json 的 word_control。 */
  readonly wordControl: ContentWordCountControl;
  /** 本任务的图片保护（与 generate-sections、配图工具共用）。 */
  readonly protection: ContentImageProtection;
}

/** 执行者一侧的执行函数（见文件头）。 */
export function createCheckWordCountExecutor(options: CheckWordCountOptions): AgentLongToolExecutor {
  const { run, targets, wordControl, protection } = options;
  return async () => {
    const { files, existingImages } = await readContentSectionFiles(run, targets);
    const inspections = targets.map((target) => inspectContentSection(target, files.get(target.file), existingImages));
    const words = contentWordCount(targets, new Map(inspections.map(({ section }) => [section.section_id, section.words])), wordControl);
    // 正文全部就绪才进入保护（与桌面版 enterProtection 相同）：保护只建立在没有问题的正文上，第一个有问题的小节交回 Agent。
    if (words.complete) {
      for (const [index, { issues }] of inspections.entries()) {
        if (issues.length) throw new AgentToolRequestRejection(`${targets[index]!.file}：${issues.map((issue) => issue.message).join('；')}`);
      }
      protection.enter();
    }
    const { file, result } = contentWordCountReport(words);
    await run.writeFiles([{ path: file.path, data: Buffer.from(file.content, 'utf8') }]);
    return result;
  };
}
