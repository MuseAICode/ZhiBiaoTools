// 正文小节的写作请求与输出检查（路线图第 8 步 8.10c2a；docs/SERVER_DESIGN.md 第 7.43 节），取代桌面版 contentGenerationAgent.cjs 中
// generate-sections 工具的纯逻辑部分，与桌面版逐项相同：
// - 任务文件 `任务/正文生成.json` 的读取与校验（contentGenerationTaskFiles.cjs 的 readTaskFile，再查只含本次目标、同一小节不重复）；
// - 已生成正文的小节跳过、regenerate 重写（skipped / pending 的划分）；
// - 每节一次写作请求的消息：全轮相同的规则放 system、公共材料单独一条 user 消息（便于服务商复用前缀缓存）、本节内容在后
//   （sharedPrefixMessages），文字与桌面版逐字相同；
// - 模型输出的边界与结构检查：唯一完整代码块或纯源码（extractAiSource）→ 带 app:block 分隔的有效受限 HTML（checkSectionHtml）
//   → 补齐被写成异常标记的提示词结束标签（closeOpenTemplates）→ 结构完整（assertHtmlStructure，含源码中途结束）；输出被截断的不保存；
// - 返回给 Agent 的统计（compactResults）。
//
// **写作材料取服务端的输入**（8.10c1 登记）：消息由 buildContentWritingFiles 生成的材料（服务端按已保存的编排、模板、全局事实等生成）
// 组成，不读工作区中可能被 Agent 改动的副本；任务文件是 Agent 写的不可信输入，只取其中的 section_id、instructions、references、
// regenerate，section_id 必须是本次目标。原方案底稿（restored_content）属 8.11，本步的目标没有底稿。
//
// 本模块只生成文字与检查文字，不调用模型、不读写数据库与工作区；工具的执行（模型调用、并发、计费、写回工作区、长时调用）随 8.10c2b。
import { Ajv } from 'ajv';
import type { ChatMessage } from '../ai/gateway.ts';
import { CONTENT_TASK_FILE_SCHEMAS, CONTENT_WRITING_INPUT_FILES, taskFilePath, writingInstructions, type ContentWritingFile } from './contentWriting.ts';
import { assertHtmlStructure, closeOpenTemplates } from './htmlStructure.ts';
import { countHtmlWords } from './readableWords.ts';

/** 正文生成的任务文件（与桌面版 taskFilePath('sections') 相同）。 */
export const CONTENT_SECTIONS_TASK_FILE = taskFilePath('sections');

/** 小节写作的输出不合格（说明按桌面版，交给 Agent 修正要求后重试；模型写出的内容不进入说明）。 */
export class ContentSectionOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentSectionOutputError';
  }
}

/** 任务文件不可用（不存在、不是 JSON、不符合 Schema、含非目标或重复的小节）：说明交给 Agent 修正文件后再次提交。 */
export class ContentSectionTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentSectionTaskError';
  }
}

// ---- 模型输出 ----

/** 提取唯一完整代码块，忽略外围说明；保留源码内部字符，不拼接或修复源码（与桌面版 aiSourceExtraction.cjs 相同）。 */
export function extractAiSource(response: string, kind: string): string {
  const text = response.trim();
  const fences = [...text.matchAll(/^[ \t]*`{3,}[^\r\n]*\r?$/gm)];
  if (!fences.length) {
    if (!text) throw new ContentSectionOutputError('AI 源码不能为空');
    return text;
  }
  const wrapped = text.match(/^[ \t]*```([^\r\n`]*)\r?\n([\s\S]*?)(?:\r?\n)?^[ \t]*```[ \t]*\r?$/m);
  if (fences.length !== 2 || !wrapped) {
    throw new ContentSectionOutputError('AI 源码须为纯源码或唯一完整代码块，不能包含多个代码块或未闭合围栏');
  }
  const language = wrapped[1]!.trim().toLowerCase();
  if (language && language !== kind) throw new ContentSectionOutputError(`源码围栏语言应为 ${kind}，实际为 ${language}`);
  if (!wrapped[2]!.trim()) throw new ContentSectionOutputError('AI 源码不能为空');
  return wrapped[2]!;
}

/** 输出边界只检查文件类型与有效正文，具体 HTML 结构按输入规范生成（与桌面版 checkSectionHtml 相同）。 */
export function checkSectionHtml(html: unknown): string {
  const content = String(html).trim();
  if (!content.startsWith('<!-- app:block -->') || content.includes('```') || !/<(?:p|ol|ul|table)\b/i.test(content) || !countHtmlWords(content)) {
    throw new ContentSectionOutputError('必须输出带 app:block 分隔的有效受限 HTML 正文，不得输出 Markdown 或代码围栏');
  }
  return content;
}

/**
 * 模型输出被截断（finish_reason 为 length）时不保存（桌面版 reject_truncated_output）。桌面版的说明另提示“在设置-文本模型中提高
 * 输出长度上限”；Web 版的输出上限由平台设置，说明只保留前半句。
 */
export const CONTENT_SECTION_TRUNCATED_MESSAGE = '模型输出达到长度上限被截断，本次结果未保存。';

/**
 * 一节的模型输出 → 可以写回工作区的小节 HTML（与桌面版 generate-sections 相同的顺序）：截断的回复直接失败；提示词结束标签被写成
 * 异常标记时程序无损补齐，其余结构问题不落盘，均作为本节失败交回 Agent 重试。结构问题抛 HtmlStructureError，其余抛
 * ContentSectionOutputError。
 */
export function finishSectionHtml(content: string, finishReason: string | null): string {
  if (finishReason === 'length') throw new ContentSectionOutputError(CONTENT_SECTION_TRUNCATED_MESSAGE);
  const html = closeOpenTemplates(checkSectionHtml(extractAiSource(content, 'html'))).html;
  assertHtmlStructure(html, { checkSourceCompleteness: true });
  return html;
}

// ---- 任务文件 ----

export interface ContentSectionJob {
  readonly section_id: string;
  readonly instructions: string;
  readonly references: string;
  readonly regenerate?: boolean;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSectionsTask = ajv.compile(CONTENT_TASK_FILE_SCHEMAS.sections);

/**
 * 读取任务文件（与桌面版 readTaskFile(workspaceDir, 'sections') 相同）：content 为文件内容，文件不存在时为 null。结构错误直接交回
 * Agent 修正。
 */
export function readContentSectionsTask(content: string | null): ContentSectionJob[] {
  const file = CONTENT_SECTIONS_TASK_FILE;
  if (content === null) throw new ContentSectionTaskError(`请先将任务写入 ${file}，再调用本工具提交`);
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^﻿/, ''));
  } catch (error) {
    throw new ContentSectionTaskError(`${file} 不是有效 JSON：${(error as Error).message}`);
  }
  if (!validateSectionsTask(value)) throw new ContentSectionTaskError(`${file} 格式错误：${ajv.errorsText(validateSectionsTask.errors, { dataVar: file })}`);
  return (value as { sections: ContentSectionJob[] }).sections;
}

export interface ContentSectionSkipped {
  readonly section_id: string;
  readonly file: string;
  readonly status: 'skipped';
}

export interface ContentSectionBatch {
  /** 任务文件中的小节 id（文件中的顺序）。 */
  readonly ids: readonly string[];
  /** 已生成正文、没有要求重写的小节（重复提交同一任务文件不会重写）。 */
  readonly skipped: ReadonlyMap<string, ContentSectionSkipped>;
  /** 要调用模型写作的小节。 */
  readonly pending: readonly ContentSectionJob[];
}

/**
 * 任务文件的小节 → 本次提交（与桌面版 generate-sections 的 execute 开头相同）：只能包含本次目标、同一小节不能重复（否则整次提交被拒绝，
 * 说明列出不符的 id）；已生成正文的小节（generated 为真）跳过，regenerate 明确要求整节重写。
 */
export function planContentSectionBatch(
  jobs: readonly ContentSectionJob[],
  targets: ReadonlyMap<string, { readonly file: string }>,
  generated: (sectionId: string) => boolean,
): ContentSectionBatch {
  const ids = jobs.map((job) => job.section_id);
  const invalid = ids.filter((id, index) => !targets.has(id) || ids.indexOf(id) !== index);
  if (invalid.length) throw new ContentSectionTaskError(`任务文件只能包含本次目标小节，且同一小节不能重复出现：${[...new Set(invalid)].join('、')}`);
  const skipped = new Map(
    jobs
      .filter((job) => !job.regenerate && generated(job.section_id))
      .map((job) => [job.section_id, { section_id: job.section_id, file: targets.get(job.section_id)!.file, status: 'skipped' as const }]),
  );
  return { ids, skipped, pending: jobs.filter((job) => !skipped.has(job.section_id)) };
}

// ---- 写作请求 ----

/** 写作阶段的一个目标小节（正文编排决策.json 的 targets 中的一项）。 */
export interface ContentWritingTarget {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly file: string;
  readonly [key: string]: unknown;
}

/** generate-sections 用到的材料（服务端生成的输入，与桌面版 loadInput 读取的文件相同）。 */
export interface ContentSectionWritingMaterials {
  readonly decisions: {
    readonly has_knowledge_base: boolean;
    readonly global_facts_requirements: string;
    readonly image_requirements: string;
    readonly word_requirements: string;
    readonly user_requirement: string;
    readonly targets: readonly ContentWritingTarget[];
  };
  /** 目标 id → 目标（目录顺序）。 */
  readonly targets: ReadonlyMap<string, ContentWritingTarget>;
  readonly overview: string;
  readonly facts: string;
  readonly rules: string;
  readonly imageTypes: string;
  readonly template: string;
  readonly config: string;
}

/** 从 buildContentWritingFiles 的输出取出写作请求的材料（缺少材料时为程序错误）。 */
export function contentSectionWritingMaterials(files: readonly ContentWritingFile[]): ContentSectionWritingMaterials {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const read = (path: string): string => {
    const content = byPath.get(path);
    if (content === undefined) throw new TypeError(`写作材料缺少 ${path}`);
    return content;
  };
  const decisions = JSON.parse(read(CONTENT_WRITING_INPUT_FILES.decisions)) as ContentSectionWritingMaterials['decisions'];
  return {
    decisions,
    targets: new Map(decisions.targets.map((section) => [section.id, section])),
    overview: read(CONTENT_WRITING_INPUT_FILES.overview),
    facts: read(CONTENT_WRITING_INPUT_FILES.facts),
    rules: read(CONTENT_WRITING_INPUT_FILES.rules),
    imageTypes: read(CONTENT_WRITING_INPUT_FILES.imageTypes),
    template: read(CONTENT_WRITING_INPUT_FILES.template),
    config: read(CONTENT_WRITING_INPUT_FILES.config),
  };
}

/** 全轮相同的写作规则（system，与桌面版相同）。 */
export function contentSectionWritingSystem(materials: ContentSectionWritingMaterials): string {
  const { decisions, rules, imageTypes } = materials;
  return `${writingInstructions(decisions.has_knowledge_base)}\n\n本次事实处理要求：\n${decisions.global_facts_requirements}\n\n${rules}\n\n配图类型对照表（据此确定新增图片的生成类型）：\n${imageTypes}\n\n本次配图要求：\n${decisions.image_requirements}\n\n写作执行要求：\n按本节 content_plan.target_words 的目标字数生成正文，0 表示不设目标；不能用全文上下限或其他小节字数代替本节目标。按本节 content_plan 执行：table.needed=false 时不新增数据表格；仅按本节配图安排与补充要求中主 Agent 分配的布局、组数、表达目的和生成方式新增图片，不自行改变生成方式；AI 图片的 template 按分配的画面类型、主体、视角景别正向描述画面，并注明画面形式名称，不自行分配全局名额或独立承担 AI 图片占比目标；未分配布局时不新增配图；无图、无允许类型或 image_needed=false 时不留新增配图块，并发正文写作阶段只生成新增图片的受限 HTML 结构，填写生成类型、用途说明、替代文本及必要图注，暂不填写图片资源引用。主 Agent 生成图片后补入工具返回的 asset_ref；已有原图直接使用提供的资源引用。你没有文件检索或图片生成工具，仅核对本次请求提供的材料；规范中要求主 Agent 读取文件、生成图片及提交结果清单的操作不由你执行，只返回本节 HTML，不虚构图片路径。`;
}

/** 各节共用的公共材料（单独一条 user 消息，与桌面版相同）。 */
export function contentSectionSharedInput(materials: ContentSectionWritingMaterials): string {
  const { decisions, overview, facts, template, config } = materials;
  return `项目概述：
${overview}

全局事实设定（完整内容）：
${facts}

字数要求：
${decisions.word_requirements}

用户额外要求：
${decisions.user_requirement}

受限 HTML 模板：
${template}

所选模板配置：
${config}`;
}

/** 本节内容（与桌面版相同；本节编排取服务端的材料，配图安排与参考资料取任务文件）。 */
export function contentSectionInput(section: ContentWritingTarget, job: Pick<ContentSectionJob, 'instructions' | 'references'>): string {
  return `本节编排决策：
${JSON.stringify(section, null, 2)}

本节配图安排与补充要求：
${job.instructions.trim() || '无补充要求，未分配新增配图；已有原图按本节底稿要求保留。'}

补充参考资料摘录：
${job.references || '未提供'}`;
}

/**
 * 公共材料单独作为一条 user 消息：模型服务只在消息边界复用前缀缓存（与桌面版 sharedPrefixMessages 相同）。不给 itemInput 时是
 * 预热公共前缀的请求（桌面版 warmPromptPrefix，多于一节时先发）。
 */
export function sharedPrefixMessages(system: string, sharedInput: string, itemInput?: string): ChatMessage[] {
  return [
    { role: 'system', content: system },
    ...(sharedInput ? [{ role: 'user' as const, content: sharedInput }] : []),
    ...(itemInput ? [{ role: 'user' as const, content: itemInput }] : []),
  ];
}

/** 一节的写作请求的消息。 */
export function contentSectionMessages(materials: ContentSectionWritingMaterials, section: ContentWritingTarget, job: ContentSectionJob): ChatMessage[] {
  return sharedPrefixMessages(contentSectionWritingSystem(materials), contentSectionSharedInput(materials), contentSectionInput(section, job));
}

// ---- 结果 ----

export type ContentSectionResult =
  | ContentSectionSkipped
  | { readonly section_id: string; readonly file: string; readonly words: number; readonly status: 'success' }
  | { readonly section_id: string; readonly status: 'error'; readonly error: string };

/** 写成功的一节（字数与桌面版相同，按 countHtmlWords）。 */
export function contentSectionSuccess(section: ContentWritingTarget, html: string): ContentSectionResult {
  return { section_id: section.id, file: section.file, words: countHtmlWords(html), status: 'success' };
}

/** 模型只接收统计和未成功项，逐项完整结果另存（与桌面版 compactResults 相同）。 */
export function compactResults<T extends { readonly status: string }>(results: readonly T[]): { total: number; success: number; skipped: number; unresolved: T[] } {
  const count = (status: string) => results.filter((item) => item.status === status).length;
  return {
    total: results.length,
    success: count('success'),
    skipped: count('skipped'),
    unresolved: results.filter((item) => !['success', 'skipped'].includes(item.status)),
  };
}
