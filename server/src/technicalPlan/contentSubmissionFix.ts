// 业务工具 fix-submission-issues（路线图第 8 步 8.10c3b3；docs/SERVER_DESIGN.md 第 7.49 节），取代桌面版 contentGenerationEditTools.cjs 的
// createSubmissionFixTool 与 formatSectionIssues / formatImageBlocks / batchResponse。
//
// 与桌面版相同：
// - 读取 程序清单/提交校验问题.json（提交校验退回时由程序写入，8.10c3c）中的小节 id，按出现顺序去重、只取本轮目标小节；清单中的问题
//   说明不使用，派发前按最新文件复查（inspectContentSection）：已没有问题的小节跳过（skipped），有子任务无法处理的问题（fixable=false：
//   正文或图片文件缺失、图片引用等）的小节列入 unresolved、说明由主 Agent 直接处理，其余每节交给一个子会话（8.10c3b2 的
//   editContentSections，title「提交问题修复」、preloadInput：子会话获得本节完整 HTML 与受限 HTML 规范）；
// - 子任务的要求逐字相同（本节问题的编号列表，有原始图片块时附恢复说明；本批共用“只修复本次列出的问题，不改写其他正文。”与结构规则）；
// - 子会话结束后经 readContentSectionFiles 与 inspectContentSection 复查本节；返回 total、success、skipped、unresolved 与还原的文件
//   （batchResponse）。
//
// 与桌面版的差异（#130 说明）：
// 1. 问题清单的读取：经 run.readFiles 读取（≤ 8 MiB）；清单不存在时说明相同，过大、不是 JSON 或没有 issues 数组时按固定说明交回 Agent
//    （桌面版直接抛出 JSON 的解析错误）；清单只用来确定小节，其余内容不使用（清单在工作区中，Agent 可以改写）；
// 2. 复查的规则：与 8.10c3a 的提交校验相同（含 Web 版另加的受限 HTML 检查、过大的小节）；图片块的比对（保护开始时的记录、原始图片块，
//    桌面版 expectedImages）随 8.10d，残留数据表格（requireNoDataTables）随 8.10e；
// 3. 结果中各节的 facts（桌面版 inspectSectionArtifact 的 has_data_tables）不给出，随 8.10e；
// 4. 结果的上限：长时工具的结果至多 AGENT_TOOL_REQUEST_RESULT_MAX_BYTES（迁移 0047），超过 CONTENT_SUBMISSION_FIX_RESULT_MAX_BYTES 时
//    unresolved 改为只含小节、状态与截断的说明（完整的问题在下一次提交校验的清单中），仍超过时从末尾省略并给出省略数；
// 5. “请等待上一批生成或编辑任务全部结束”：每个任务同时至多一个未关闭的长时工具请求（迁移 0047，409），不另行检查；同一小节不能被两批
//    同时编辑仍由 editContentSections 的 activity 检查；
// 6. 进度（onActivity）随 8.10c3c 与第 9 步。
//
// 问题说明、子会话报告失败的原因来自 Agent 写出的内容或沙箱，只作为纯文本交回同一个主 Agent。本模块不写日志。
import type { AgentRun } from '../agent/execution.ts';
import {
  AGENT_TOOL_REQUEST_RESULT_MAX_BYTES,
  AgentToolRequestRejection,
  createAgentLongTool,
  type AgentLongToolExecutor,
  type AgentLongToolOptions,
} from '../agent/toolRequests.ts';
import {
  editContentSections,
  type ContentSectionEditActivity,
  type ContentSectionEditJob,
  type ContentSectionEditResult,
} from './contentSectionEditing.ts';
import { compactResults, type ContentSectionWritingMaterials } from './contentSectionWriting.ts';
import { CONTENT_SUBMISSION_ISSUES_FILE, inspectContentSection, STRUCTURE_RULE, type ContentSectionIssue, type ContentSubmissionTarget } from './contentSubmission.ts';
import { CONTENT_SECTION_READ_MAX_BYTES, readContentSectionFiles } from './contentWordCount.ts';
import { SUBMISSION_FIX_TOOL } from './contentWriting.ts';

export { SUBMISSION_FIX_TOOL };

/**
 * 内部入口一侧的工具（登记在 src/agent/toolRegistry.ts）。参数为空对象（与桌面版相同 additionalProperties: false）；次数与频率上限与
 * generate-sections、check-word-count 相同。
 */
export const SUBMISSION_FIX_TOOL_OPTIONS: AgentLongToolOptions = Object.freeze({
  name: SUBMISSION_FIX_TOOL,
  argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
  maxArgumentBytes: 1024,
  maxCallsPerJob: 2_000,
  maxCallsPerMinute: 20,
});
export const submissionFixTool = createAgentLongTool(SUBMISSION_FIX_TOOL_OPTIONS);

/** 本批共用的要求（与桌面版 createSubmissionFixTool 的 instructions 相同，structureRule 为 STRUCTURE_RULE）。 */
export const SUBMISSION_FIX_INSTRUCTIONS = `只修复本次列出的问题，不改写其他正文。${STRUCTURE_RULE}`;
/** 交给 Agent 的结果至多这么多字节（长时工具结果的上限之内留出余量，见文件头差异第 4 项）。 */
export const CONTENT_SUBMISSION_FIX_RESULT_MAX_BYTES = AGENT_TOOL_REQUEST_RESULT_MAX_BYTES - 16 * 1024;
/** 精简结果中每节说明的长度上限。 */
export const CONTENT_SUBMISSION_FIX_COMPACT_ERROR_CHARS = 500;

const NO_ISSUES = '当前没有待修复的提交校验问题';
const ISSUES_TOO_LARGE = `${CONTENT_SUBMISSION_ISSUES_FILE} 过大，无法读取`;
const ISSUES_INVALID = `${CONTENT_SUBMISSION_ISSUES_FILE} 不是有效的问题清单，请重新提交，由程序重新生成问题清单`;

/** 一项小节问题（桌面版的问题对象；图片块问题另有原始图片块，8.10d）。 */
export interface SubmissionFixIssue {
  readonly message: string;
  readonly original_image_blocks?: readonly string[];
}

/** 与桌面版 formatImageBlocks 相同。 */
export function formatImageBlocks(blocks: readonly string[]): string {
  return blocks.length ? blocks.map((block, index) => `【原始图片块 ${index + 1}】\n${block}`).join('\n\n') : '本节原本没有图片块，删除新增的图片块。';
}

/** 与桌面版 formatSectionIssues 相同：问题清单转换为本节修复要求。 */
export function formatSectionIssues(issues: readonly SubmissionFixIssue[]): string {
  return issues
    .map((item, index) => `${index + 1}. ${item.message}${item.original_image_blocks ? `。请把图片部分原样恢复为以下原始图片块，保留文字修改：\n${formatImageBlocks(item.original_image_blocks)}` : ''}`)
    .join('\n');
}

/** 一节的结果（与桌面版相同：跳过、子任务无法处理、或子会话编辑的结果）。 */
export type SubmissionFixResult = ContentSectionEditResult | { readonly section_id: string; readonly status: 'skipped' };

/** 与桌面版 batchResponse 相同：统计、未成功项及还原的本批以外小节。 */
export function submissionFixResponse(results: readonly SubmissionFixResult[], restored: readonly string[]): Record<string, unknown> {
  return { ...compactResults(results), ...(restored.length ? { restored_files: [...restored] } : {}) };
}

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const truncateChars = (text: string, max: number): string => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};

/** 结果超过上限时精简（见文件头差异第 4 项）；不超过时原样返回。 */
export function boundSubmissionFixResponse(response: Record<string, unknown>, maxBytes = CONTENT_SUBMISSION_FIX_RESULT_MAX_BYTES): Record<string, unknown> {
  if (byteLength(response) <= maxBytes) return response;
  const unresolved = (response.unresolved as readonly { section_id: string; status: string; error?: string }[]).map((item) => ({
    section_id: item.section_id,
    status: item.status,
    ...(item.error !== undefined ? { error: truncateChars(item.error, CONTENT_SUBMISSION_FIX_COMPACT_ERROR_CHARS) } : {}),
  }));
  let omitted = 0;
  const compact = (): Record<string, unknown> => ({ ...response, unresolved, ...(omitted ? { omitted_unresolved: omitted } : {}) });
  while (unresolved.length && byteLength(compact()) > maxBytes) {
    unresolved.pop();
    omitted += 1;
  }
  return compact();
}

/** 问题清单中的小节 id（按出现顺序去重）；清单不合格时抛 AgentToolRequestRejection。 */
async function readIssueSectionIds(run: Pick<AgentRun, 'readFiles'>): Promise<string[]> {
  const file = (await run.readFiles([CONTENT_SUBMISSION_ISSUES_FILE], { maxFileBytes: CONTENT_SECTION_READ_MAX_BYTES, maxTotalBytes: CONTENT_SECTION_READ_MAX_BYTES })).get(CONTENT_SUBMISSION_ISSUES_FILE);
  if (!file) throw new AgentToolRequestRejection(NO_ISSUES);
  if (file.data === null) throw new AgentToolRequestRejection(ISSUES_TOO_LARGE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.data.toString('utf8'));
  } catch {
    throw new AgentToolRequestRejection(ISSUES_INVALID);
  }
  const issues = parsed !== null && typeof parsed === 'object' ? (parsed as { issues?: unknown }).issues : undefined;
  if (!Array.isArray(issues)) throw new AgentToolRequestRejection(ISSUES_INVALID);
  const ids: string[] = [];
  for (const item of issues) {
    const id = item !== null && typeof item === 'object' ? (item as { section_id?: unknown }).section_id : undefined;
    if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 按最新文件检查若干小节（与提交校验相同的规则；8.10d 起另比对图片块）。 */
async function checkSections(run: Pick<AgentRun, 'readFiles'>, sections: readonly ContentSubmissionTarget[]): Promise<Map<string, ContentSectionIssue[]>> {
  if (!sections.length) return new Map();
  const { files, existingImages } = await readContentSectionFiles(run, sections);
  return new Map(sections.map((section) => [section.id, inspectContentSection(section, files.get(section.file), existingImages).issues]));
}

export interface SubmissionFixOptions {
  readonly run: Pick<AgentRun, 'readFiles' | 'writeFiles' | 'removeFiles' | 'childPrompt'>;
  /** 服务端生成的写作材料：目标小节、受限 HTML 生成规范与事实处理要求（不读工作区的副本）。 */
  readonly materials: {
    readonly targets: ReadonlyMap<string, ContentSubmissionTarget>;
    readonly rules: ContentSectionWritingMaterials['rules'];
    readonly decisions: Pick<ContentSectionWritingMaterials['decisions'], 'global_facts_requirements'>;
  };
  /** 本任务的编辑状态（与 8.10f 的一致性修复共用，createContentSectionEditActivity）。 */
  readonly activity: ContentSectionEditActivity;
  /** 本批的表格保留要求（桌面版 () => !requireNoDataTables；去表格阶段随 8.10e，此前保留原表格）。 */
  readonly preserveDataTables?: () => boolean;
}

/** 执行者一侧的执行函数（见文件头；写作阶段的提示词经 AgentPromptInput.longTools 给出，8.10c3c 接入）。 */
export function createSubmissionFixExecutor(options: SubmissionFixOptions): AgentLongToolExecutor {
  const { run, materials, activity } = options;
  return async ({ signal }) => {
    const ids = (await readIssueSectionIds(run)).filter((id) => materials.targets.has(id));
    const checked = await checkSections(run, ids.map((id) => materials.targets.get(id)!));
    const jobs: ContentSectionEditJob[] = [];
    const settled = new Map<string, SubmissionFixResult>();
    for (const id of ids) {
      const issues = checked.get(id)!;
      const manual = issues.filter((item) => !item.fixable);
      if (!issues.length) settled.set(id, { section_id: id, status: 'skipped' });
      else if (manual.length) settled.set(id, { section_id: id, status: 'error', error: `子任务无法处理，请直接修复：${manual.map((item) => item.message).join('；')}` });
      else jobs.push({ section_id: id, instructions: `修复程序提交校验发现的以下问题，只改与问题相关的内容：\n${formatSectionIssues(issues)}` });
    }
    const { results: edited, restored } = jobs.length
      ? await editContentSections({
          run,
          jobs,
          targets: materials.targets,
          activity,
          factsRequirements: materials.decisions.global_facts_requirements,
          rules: materials.rules,
          title: '提交问题修复',
          instructions: SUBMISSION_FIX_INSTRUCTIONS,
          preserveDataTables: options.preserveDataTables?.() ?? true,
          preloadInput: true,
          inspect: async (section) => ({ issues: (await checkSections(run, [section])).get(section.id)! }),
          signal,
        })
      : { results: [], restored: [] };
    const byId = new Map(edited.map((item) => [item.section_id, item]));
    const results = ids.map((id) => settled.get(id) ?? byId.get(id)!);
    return boundSubmissionFixResponse(submissionFixResponse(results, restored));
  };
}
