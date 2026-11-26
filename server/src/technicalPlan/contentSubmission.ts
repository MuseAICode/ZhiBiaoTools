// 正文写作阶段的提交校验（路线图第 8 步 8.10c3a；docs/SERVER_DESIGN.md 第 7.46 节），取代桌面版 contentGenerationAgent.cjs 的
// inspectContentArtifacts、inspectSectionArtifact、contentSubmissionInstructions 与 contentGenerationImageTools.cjs 的
// validateContentImageReferences。Agent 标记完成后，任务按固定规则检查工作区中的结果，与桌面版逐项相同：
// - 结果清单 正文生成结果.json：存在、是 JSON、符合预置 Schema（Ajv 版本与桌面版相同），覆盖本轮全部目标、文件路径与目标相同；
// - 每个目标小节的 HTML：文件存在；带 app:block 分隔的有效受限 HTML 正文（checkSectionHtml）；每个 img 都有 data-app-asset-ref、
//   是工作区内的相对路径且图片文件存在（进入 <template> 的内容，第一个不合格的即停止）；元素闭合与图片结构（findHtmlStructureIssues）；
// - 问题清单的写法（类型、可否由修复子任务处理、所在小节）与顺序相同，小节问题另写进 程序清单/提交校验问题.json 供 Agent 读取；
//   修复提示词的业务说明（问题涉及的小节超过 5 个时调用 fix-submission-issues 并发修复）与桌面版 buildRetryPrompt 相同。
//
// **Web 版另加的检查**（8.10a 登记：入库前经白名单，有 error 级问题整节拒绝，交回 Agent 修改）：每节正文再按入库的同一规则
// （sectionBodies.ts 的 normalizeSectionHtml，即 parseRestrictedHtml）检查，危险或不支持的块标签、结构不合规、规范化后超过单节上限
// 的都是阻塞问题（restricted-html）。链接、内联样式、事件属性等 warning 级的清洗不拦截，入库时照常去掉（8.10c3c 的注入端到端测试断言）。
// 读取超过上限的小节文件按阻塞问题（too-large）处理。
//
// 与桌面版的差异：结果清单不是 JSON 时说明为固定文字（桌面版附 V8 的解析错误，其中可能带出文件片段）；问题超过
// AGENT_SUBMISSION_MAX_ISSUES 条时只列前面的、末条说明未列出的条数（完整的小节问题仍在清单文件中），单条说明截到
// AGENT_SUBMISSION_MAX_MESSAGE_CHARS。图片保护（图片块与开始时的记录比对，8.10d）、去表格后残留表格（8.10e）、一致性审计（8.10f）
// 的问题随各阶段接入。
//
// 问题说明可能含 Agent 写出的内容（图片的 alt、引用路径、元素 id、标签名），只当作纯文本交回同一个 Agent。本模块只检查文字，
// 不读写工作区：文件由任务经 run.readFiles 读出后传入（8.10c3c 接入）。
import { posix } from 'node:path';
import { Ajv } from 'ajv';
import { AGENT_SUBMISSION_MAX_ISSUES, AGENT_SUBMISSION_MAX_MESSAGE_CHARS, type AgentSubmissionReport } from '../agent/submission.ts';
import { checkSectionHtml } from './contentSectionWriting.ts';
import { CONTENT_RESULT_FILE, CONTENT_RESULT_JSON_SCHEMA, SUBMISSION_FIX_PARALLEL_THRESHOLD, SUBMISSION_FIX_TOOL } from './contentWriting.ts';
import { elementAttributes, findHtmlStructureIssues } from './htmlStructure.ts';
import { countHtmlWords } from './readableWords.ts';
import { normalizeSectionHtml, SectionBodyRejectedError } from './sectionBodies.ts';

/** 程序清单中的提交校验问题（与桌面版 LIST_DIR / LIST_FILES.submission 相同）。 */
export const CONTENT_SUBMISSION_ISSUES_FILE = '程序清单/提交校验问题.json';
/** 最低目标修复时的完成目标（与桌面版 validateContentStageSubmission 的 minimumGoal 相同）。 */
export const CONTENT_SUBMISSION_MINIMUM_GOAL = '结果清单是有效 JSON，覆盖本轮全部目标小节；正文完整且可转换为 Word，必要图片引用和受保护图片块有效。保留已有正文、原图和任务范围。';

/** 本轮目标小节（正文编排决策.json 的 targets，取服务端按 8.10c1 生成的材料，不读工作区副本）。 */
export interface ContentSubmissionTarget {
  readonly id: string;
  readonly number?: string;
  readonly title: string;
  readonly file: string;
}

/** 工作区中读出的文件（与 AgentWorkspaceFile 相同：超过读取上限的只有大小）。 */
export interface ContentSubmissionFile {
  readonly size: number;
  readonly data: Buffer | null;
}

export interface ContentSectionSummary {
  readonly section_id: string;
  readonly number?: string;
  readonly title: string;
  readonly file: string;
  readonly words: number;
}

export interface ContentManifestIssue {
  readonly type: 'manifest';
  readonly severity: 'blocking';
  readonly file: string;
  readonly message: string;
}

/** 小节问题的类型：前四种与桌面版相同，restricted-html 与 too-large 是 Web 版另加的。 */
export type ContentSectionIssueType = 'missing' | 'content' | 'image-ref' | 'structure' | 'restricted-html' | 'too-large';

export interface ContentSectionIssue {
  readonly section_id: string;
  readonly number?: string;
  readonly title: string;
  readonly file: string;
  readonly type: ContentSectionIssueType;
  readonly severity: 'blocking';
  readonly message: string;
  /** 能否交给提交问题修复子任务处理（文件缺失、图片引用等由主 Agent 直接处理）。 */
  readonly fixable: boolean;
}

export type ContentSubmissionIssue = ContentManifestIssue | ContentSectionIssue;

export interface ContentSubmissionInspection {
  /** 各目标小节的实际字数（与桌面版 result.sections 相同，按目标顺序）。 */
  readonly sections: readonly ContentSectionSummary[];
  readonly issues: readonly ContentSubmissionIssue[];
}

const resultAjv = new Ajv({ allErrors: true, strict: true });
const validateResultManifest = resultAjv.compile(CONTENT_RESULT_JSON_SCHEMA);
const IMAGE_PATH_MESSAGE = '图片或源码路径必须是当前工作区内使用正斜杠的相对路径';
const SECTION_ISSUE_TYPES: ReadonlySet<string> = new Set<ContentSectionIssueType>(['missing', 'content', 'image-ref', 'structure', 'restricted-html', 'too-large']);

/**
 * 配图引用对应的工作区路径（桌面版 resolveImageWorkspaceFile 的检查，再按 path.join 的方式规范化）；不是工作区内使用正斜杠的
 * 相对路径时为 null。规范化后不会越出工作区（含 .. 的已被拒绝）。
 */
export function contentImageWorkspacePath(reference: string): string | null {
  if (!reference || reference.includes('\\') || reference.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference) || reference.split('/').includes('..')) {
    return null;
  }
  return posix.normalize(reference);
}

/** 正文中 img 的配图引用对应的工作区路径（任务据此确认哪些图片文件存在）。 */
export function contentImagePaths(html: string): string[] {
  const paths = new Set<string>();
  for (const attributes of elementAttributes(html, 'img')) {
    const path = contentImageWorkspacePath(attributes.get('data-app-asset-ref') ?? '');
    if (path !== null) paths.add(path);
  }
  return [...paths];
}

/** 与桌面版 validateContentImageReferences 相同：第一个不合格的 img 的说明，都合格时为 null。 */
function imageReferenceIssue(html: string, existingImages: ReadonlySet<string>): string | null {
  for (const attributes of elementAttributes(html, 'img')) {
    const reference = attributes.get('data-app-asset-ref');
    if (!reference) return `图片尚未生成或未填写 data-app-asset-ref：${attributes.get('alt') || '未命名图片'}`;
    const path = contentImageWorkspacePath(reference);
    if (path === null) return IMAGE_PATH_MESSAGE;
    if (!existingImages.has(path)) return `正文引用的图片文件不存在：${reference}`;
  }
  return null;
}

function sectionBase(section: ContentSubmissionTarget): Omit<ContentSectionSummary, 'words'> {
  return { section_id: section.id, ...(section.number !== undefined ? { number: section.number } : {}), title: section.title, file: section.file };
}

/**
 * 检查一节的实际产物（与桌面版 inspectSectionArtifact 相同的顺序，未进入图片保护）。existingImages 为工作区中存在的图片文件
 * （contentImagePaths 给出的路径中，经 readFiles 确认是文件的那些）。
 */
export function inspectContentSection(
  section: ContentSubmissionTarget,
  file: ContentSubmissionFile | undefined,
  existingImages: ReadonlySet<string>,
): { section: ContentSectionSummary; issues: ContentSectionIssue[] } {
  const base = sectionBase(section);
  const issue = (type: ContentSectionIssueType, message: string, fixable: boolean): ContentSectionIssue => ({ ...base, type, severity: 'blocking', message, fixable });
  if (!file) return { section: { ...base, words: 0 }, issues: [issue('missing', '小节 HTML 文件不存在', false)] };
  if (file.data === null) return { section: { ...base, words: 0 }, issues: [issue('too-large', '小节 HTML 文件过大，无法读取', false)] };
  const html = file.data.toString('utf8');
  const words = countHtmlWords(html);
  const issues: ContentSectionIssue[] = [];
  try {
    checkSectionHtml(html);
  } catch (error) {
    issues.push(issue('content', (error as Error).message, Boolean(words)));
  }
  const reference = imageReferenceIssue(html, existingImages);
  if (reference !== null) issues.push(issue('image-ref', reference, false));
  for (const message of findHtmlStructureIssues(html)) issues.push(issue('structure', message, true));
  // Web 版：按入库的同一规则检查（见文件头）；空白正文已由 checkSectionHtml 报告。
  if (html.trim()) {
    try {
      normalizeSectionHtml(html);
    } catch (error) {
      if (!(error instanceof SectionBodyRejectedError)) throw error;
      for (const message of error.issues) issues.push(issue('restricted-html', `不符合受限 HTML 规范：${message}`, true));
    }
  }
  return { section: { ...base, words }, issues };
}

function inspectManifest(targets: readonly ContentSubmissionTarget[], file: ContentSubmissionFile | undefined): ContentManifestIssue[] {
  const issue = (message: string): ContentManifestIssue => ({ type: 'manifest', severity: 'blocking', file: CONTENT_RESULT_FILE, message });
  if (!file) return [issue(`${CONTENT_RESULT_FILE} 尚未生成`)];
  if (file.data === null) return [issue(`${CONTENT_RESULT_FILE} 过大，无法读取`)];
  let manifest: unknown;
  try {
    manifest = JSON.parse(file.data.toString('utf8'));
  } catch {
    return [issue(`${CONTENT_RESULT_FILE} 不是有效 JSON，请修正后再次提交`)];
  }
  if (!validateResultManifest(manifest)) {
    return (validateResultManifest.errors ?? []).map((error) => issue(`${CONTENT_RESULT_FILE} ${error.instancePath} ${error.message}`));
  }
  const sections = manifest.sections as readonly { section_id: string; file: string }[];
  const issues: ContentManifestIssue[] = [];
  const entries = new Map(sections.map((item) => [item.section_id, item]));
  if (entries.size !== targets.length || sections.length !== targets.length) issues.push(issue('正文生成结果清单与本次目标小节不一致'));
  for (const section of targets) {
    if (entries.get(section.id)?.file !== section.file) issues.push(issue(`正文结果缺少小节或文件路径不匹配：${section.id}`));
  }
  return issues;
}

/**
 * 一次检查结果清单与各目标小节（与桌面版 inspectContentArtifacts 相同：清单问题在前，小节问题按目标顺序）。files 为经 readFiles
 * 读出的结果清单与各节 HTML（不存在的不在其中）。
 */
export function inspectContentSubmission(input: {
  readonly targets: readonly ContentSubmissionTarget[];
  readonly files: ReadonlyMap<string, ContentSubmissionFile>;
  readonly existingImages: ReadonlySet<string>;
}): ContentSubmissionInspection {
  const issues: ContentSubmissionIssue[] = inspectManifest(input.targets, input.files.get(CONTENT_RESULT_FILE));
  const sections: ContentSectionSummary[] = [];
  for (const target of input.targets) {
    const inspected = inspectContentSection(target, input.files.get(target.file), input.existingImages);
    sections.push(inspected.section);
    issues.push(...inspected.issues);
  }
  return { sections, issues };
}

const truncate = (message: string): string =>
  message.length > AGENT_SUBMISSION_MAX_MESSAGE_CHARS ? `${message.slice(0, AGENT_SUBMISSION_MAX_MESSAGE_CHARS - 1)}…` : message;

/** 交给提交策略的报告（见文件头的差异：至多 AGENT_SUBMISSION_MAX_ISSUES 条，单条截断）；通过时 value 为各节字数。 */
export function contentSubmissionReport(inspection: ContentSubmissionInspection): AgentSubmissionReport<{ sections: readonly ContentSectionSummary[] }> {
  const all = inspection.issues.map((issue) => ({ severity: issue.severity, message: truncate(issue.message) }));
  const issues = all.length > AGENT_SUBMISSION_MAX_ISSUES
    ? [
        ...all.slice(0, AGENT_SUBMISSION_MAX_ISSUES - 1),
        { severity: 'blocking' as const, message: `另有 ${all.length - AGENT_SUBMISSION_MAX_ISSUES + 1} 项问题未在此列出，小节问题的完整清单见 ${CONTENT_SUBMISSION_ISSUES_FILE}` },
      ]
    : all;
  return { value: issues.length ? null : { sections: inspection.sections }, issues, minimumGoal: CONTENT_SUBMISSION_MINIMUM_GOAL };
}

const STRUCTURE_RULE = '除 img 等空元素外，每个元素都写出对应的结束标签；每个 figure 以 </figure> 结束并直接包含一个 img，figure 不放在段落、列表项或加粗、链接等行内元素中。';
/** 图片保护开始后不能再重新生成正文，只按结构规则修正（与桌面版 structureFixRule 相同）。 */
const structureFixRule = (protectionActive: boolean): string =>
  `${STRUCTURE_RULE}${protectionActive ? '' : '出现异常结束标记的小节多为写作输出中断，在生成任务文件中给该节加 "regenerate": true 重新生成。'}`;

export interface ContentSubmissionRepair {
  /** 修复提示词的业务说明（与桌面版 buildRetryPrompt 对提交校验的说明相同）。 */
  readonly prompt: string;
  /** 要写进工作区的小节问题清单（没有小节问题时为 null）。 */
  readonly issuesFile: { readonly path: string; readonly content: string } | null;
}

/**
 * 提交修复的业务说明与小节问题清单（与桌面版 contentSubmissionInstructions 与 buildRetryPrompt 相同）：最低目标修复只列阻塞问题；
 * 涉及的小节超过 SUBMISSION_FIX_PARALLEL_THRESHOLD 个时调用 fix-submission-issues 并发修复（8.10c3b 接入）。
 */
export function contentSubmissionRepair(
  issues: readonly ContentSubmissionIssue[],
  { mode, protectionActive }: { mode: 'normal' | 'change-strategy' | 'minimum'; protectionActive: boolean },
): ContentSubmissionRepair {
  const listed = mode === 'minimum' ? issues.filter((issue) => issue.severity === 'blocking') : issues;
  const sectionIssues = listed.filter((issue): issue is ContentSectionIssue => 'section_id' in issue && SECTION_ISSUE_TYPES.has(issue.type));
  const suffix = ' 保留已完成内容，不重新执行已结束阶段；本轮处理后重新提交，由程序判断是否继续。';
  const head = `本次结果文件：${CONTENT_RESULT_FILE}。`;
  if (!sectionIssues.length) return { prompt: `${head}按问题说明修正当前结果，保留已完成内容和当前阶段范围。${suffix}`, issuesFile: null };
  const sectionCount = new Set(sectionIssues.map((issue) => issue.section_id)).size;
  const manual = sectionIssues.some((issue) => !issue.fixable);
  const route = sectionCount > SUBMISSION_FIX_PARALLEL_THRESHOLD
    ? `涉及小节超过 ${SUBMISSION_FIX_PARALLEL_THRESHOLD} 个，调用 ${SUBMISSION_FIX_TOOL} 并发修复${manual ? '，正文或图片文件缺失等子任务无法处理的问题由你直接处理' : ''}`
    : '由你直接修改对应小节';
  return {
    prompt: `${head}完整小节问题见 ${CONTENT_SUBMISSION_ISSUES_FILE}。${route}，修复后重新提交。图片块按清单中的原始图片块恢复，保留文字修改。${structureFixRule(protectionActive)}${suffix}`,
    issuesFile: { path: CONTENT_SUBMISSION_ISSUES_FILE, content: JSON.stringify({ issues: sectionIssues }, null, 2) },
  };
}
