// 技术方案全局事实生成的 Agent 材料、提示词与提交校验（路线图第 8 步 8.7c1）：与桌面版 client/electron/services/globalFactsTaskV2.cjs
// 及其引用的 globalFactsTask.cjs（formatOutlineForPrompt、formatBidAnalysisFactsForPrompt、loadKnowledgeItems、
// normalizeGlobalFactsResponse、validateGlobalFactsResponse）、utils/bidSectionContext.cjs 的提示词、预置 Schema、工作区材料与提交
// 校验相同（tests/technicalPlan/globalFactsJob.test.ts 加载桌面版逐项对照）。
//
// - 结果文件 global-facts.json 由沙箱中的 Agent 写出，按不可信数据处理：先按预置 Schema（Ajv，allErrors + strict，与桌面版相同）
//   校验，再按桌面版整理（标题压成一行、内容去掉首尾空白、id 规范化并去重），任一步不通过都是阻塞问题，经提交修复退回 Agent；
//   与桌面版不同，不是合法 JSON 时问题说明不附解析器的错误信息（其中可能摘录文件内容，见 8.7a）；
// - 另按服务端的全局事实上限（分组数、标题与内容的字数，src/technicalPlan/outline.ts 的 normalizeGlobalFactGroups）检查，超出时同样是
//   阻塞问题（桌面版没有上限）；
// - 招标文件的工作区文件名：与桌面版相同由文件名得出；不符合 agent 工作区的中文路径规则（8.5b：空格、符号、超过 100 个 UTF-8 字节等）
//   时，不允许的字符换成 _ 并按字节截短，仍不符合时只用序号（桌面版的文件名在 Web 版可能无法取回工作区快照）。
import { Ajv, type ErrorObject } from 'ajv';
import { buildBidSectionContextHint } from '../bidAnalysis/prompts.ts';
import type { TechnicalPlanBidItemId, TechnicalPlanBidSection, TechnicalPlanGlobalFactsMode } from '../db/schema.ts';
import { SandboxArchiveError, validateRelativePath } from '../sandbox/archive.ts';
import { SANDBOX_TEMPLATES } from '../sandbox/templates.ts';
import { AGENT_SUBMISSION_MAX_ISSUES, type AgentSubmissionIssue } from '../agent/submission.ts';
import { normalizeGlobalFactGroups, OutlineInputError, type TechnicalPlanOutlineItem } from './outline.ts';
import type { TechnicalPlanBidItem } from './store.ts';

/** 结果文件（与桌面版 GLOBAL_FACTS_OUTPUT_FILE 相同）。 */
export const GLOBAL_FACTS_OUTPUT_FILE = 'global-facts.json';

/** json-validation 为 global-facts.json 预置的 Schema，提交校验同样使用（与桌面版 GLOBAL_FACTS_JSON_SCHEMA 相同）。 */
export const GLOBAL_FACTS_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['groups'],
  additionalProperties: false,
  properties: {
    groups: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'content'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          content: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

const validateFactsSchema = new Ajv({ allErrors: true, strict: true }).compile(GLOBAL_FACTS_JSON_SCHEMA);

/** 一组全局事实（整理后，与桌面版 normalizeGlobalFactsResponse 的结果相同）。 */
export interface GlobalFactGroup {
  id: string;
  title: string;
  content: string;
}

const singleLine = (value: unknown): string =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

/** 与桌面版 normalizeFactId 相同。 */
function normalizeFactId(value: unknown, index: number): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || `fact_${String(index + 1).padStart(3, '0')}`;
}

/** 与桌面版 ensureUniqueId 相同。 */
function ensureUniqueId(id: string, used: Set<string>): string {
  let nextId = id;
  let suffix = 2;
  while (used.has(nextId)) {
    nextId = `${id}_${suffix}`;
    suffix += 1;
  }
  used.add(nextId);
  return nextId;
}

/**
 * 与桌面版 normalizeGlobalFactsResponse 相同，只用于已通过预置 Schema 的结果（根对象只有 groups，每项的 id、title、content 都是
 * 非空字符串）：标题压成一行，内容去掉首尾空白，任一为空的项丢弃；id 按 normalizeFactId 整理并去重。
 */
function normalizeGlobalFactsResponse(value: { groups: { id: string; title: string; content: string }[] }): { groups: GlobalFactGroup[] } {
  const used = new Set<string>();
  const groups: GlobalFactGroup[] = [];
  value.groups.forEach((group, index) => {
    const title = singleLine(group.title);
    const content = group.content.trim();
    if (!title || !content) return;
    groups.push({ id: ensureUniqueId(normalizeFactId(group.id || title, index), used), title, content });
  });
  return { groups };
}

/** 提交校验的结果：value 在没有阻塞问题时为整理后的分组。 */
export interface GlobalFactsSubmission {
  value: GlobalFactGroup[] | null;
  issues: AgentSubmissionIssue[];
}

const blocking = (message: string): AgentSubmissionIssue => ({ severity: 'blocking', message });

/** Schema 错误转成问题清单：至多 AGENT_SUBMISSION_MAX_ISSUES 条（提交校验报告的上限），超出的合并为最后一条（桌面版不限）。 */
function schemaIssues(errors: readonly ErrorObject[]): AgentSubmissionIssue[] {
  const issues = errors.map((item) => blocking(`${GLOBAL_FACTS_OUTPUT_FILE} 格式错误：${item.instancePath || '/'} ${item.message}`));
  if (issues.length <= AGENT_SUBMISSION_MAX_ISSUES) return issues;
  const kept = issues.slice(0, AGENT_SUBMISSION_MAX_ISSUES - 1);
  return [...kept, blocking(`${GLOBAL_FACTS_OUTPUT_FILE} 另有 ${issues.length - kept.length} 项格式错误`)];
}

/**
 * 与桌面版 validateGlobalFactsOutput 相同的提交校验（生成与调整共用）：不是合法 JSON、不符合预置 Schema、整理后没有可用分组时为阻塞
 * 问题，问题说明与桌面版相同（不是合法 JSON 时不附解析器的错误信息）；另按服务端的上限检查。content 为文件内容（来自沙箱）。
 */
export function validateGlobalFactsOutput(content: string): GlobalFactsSubmission {
  let generated: unknown;
  try {
    generated = JSON.parse(String(content || '').trim());
  } catch {
    return { value: null, issues: [blocking(`${GLOBAL_FACTS_OUTPUT_FILE}不是合法 JSON`)] };
  }
  if (!validateFactsSchema(generated)) {
    return { value: null, issues: schemaIssues(validateFactsSchema.errors ?? []) };
  }
  const normalized = normalizeGlobalFactsResponse(generated as { groups: { id: string; title: string; content: string }[] });
  // 与桌面版 validateGlobalFactsResponse 相同：整理后的每项都有 id、title、content，只需检查是否为空。
  if (!normalized.groups.length) return { value: null, issues: [blocking('全局事实结果缺少 groups')] };
  try {
    normalizeGlobalFactGroups(normalized.groups);
  } catch (error) {
    if (error instanceof OutlineInputError) return { value: null, issues: [blocking(error.message)] };
    throw error;
  }
  return { value: normalized.groups, issues: [] };
}

// ---- 工作区材料 ----

/** 与桌面版 formatOutlineForPrompt 相同。 */
export function formatOutlineForPrompt(items: readonly TechnicalPlanOutlineItem[] | undefined, level = 1, lines: string[] = []): string {
  for (const item of items ?? []) {
    const number = singleLine(item.number);
    const title = singleLine(item?.title || '未命名章节');
    const description = singleLine(item?.description || '');
    lines.push(`${'  '.repeat(Math.max(0, level - 1))}- ${number} ${title}${description ? `：${description}` : ''}`);
    if (item?.children?.length) formatOutlineForPrompt(item.children, level + 1, lines);
  }
  return lines.join('\n');
}

type BidItems = Partial<Record<TechnicalPlanBidItemId, TechnicalPlanBidItem>>;

function formatBidAnalysisFactForPrompt(items: BidItems, itemId: TechnicalPlanBidItemId, label: string): string {
  const item = items[itemId];
  const content = item?.status === 'success' ? String(item.content || '').trim() : '';
  return content ? `## ${label}\n${content}` : '';
}

/** 与桌面版 formatBidAnalysisFactsForPrompt 相同。 */
export function formatBidAnalysisFactsForPrompt(items: BidItems): string {
  return (
    [
      formatBidAnalysisFactForPrompt(items, 'projectInfo', '项目信息'),
      formatBidAnalysisFactForPrompt(items, 'partAInfo', '甲方信息'),
      formatBidAnalysisFactForPrompt(items, 'deliveryAndServiceRequirements', '交货和服务要求'),
    ]
      .filter(Boolean)
      .join('\n\n') || '未提供招标文件关键解析结果。'
  );
}

/** 知识库的完整条目（与桌面版 loadKnowledgeItems 的结果相同）。 */
export interface GlobalFactsKnowledgeItem {
  id: string;
  title: string;
  resume: string;
  content: string;
}

/** 与桌面版 loadKnowledgeItems 相同：标题与正文都不为空的条目，id 为“文档::条目”，按引用顺序。 */
export function globalFactsKnowledgeItems(items: readonly { documentId: string; itemId: string; title: string; resume: string; content: string }[]): GlobalFactsKnowledgeItem[] {
  const result: GlobalFactsKnowledgeItem[] = [];
  for (const item of items) {
    const title = singleLine(item.title);
    const content = String(item.content || '').trim();
    if (!title || !content) continue;
    result.push({ id: `${String(item.documentId || '').trim()}::${singleLine(item.itemId)}`, title, resume: singleLine(item.resume), content });
  }
  return result;
}

/** 与桌面版 formatKnowledgeItemFile 相同。 */
function formatKnowledgeItemFile(item: GlobalFactsKnowledgeItem): string {
  const title = String(item?.title || '知识库条目').trim();
  const resume = String(item?.resume || '').trim() || '无';
  const content = String(item?.content || '').trim();
  return `# ${title}\n\n简介：${resume}\n\n${content}`.trim();
}

/** 与桌面版 sanitizeFileName 相同。 */
function sanitizeFileName(value: string, fallback: string): string {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .replace(/\.md$/i, '');
  const stem = cleaned || fallback;
  return Array.from(stem).slice(0, 80).join('');
}

const padIndex = (index: number) => String(index + 1).padStart(2, '0');

/** agent 工作区放入与取回的路径规则（8.5b）。 */
const WORKSPACE_LIMITS = SANDBOX_TEMPLATES.agent.output;
/** 路径段中允许的字符（与 src/sandbox/archive.ts 的 unicode 规则相同，不含首字符的限制：文件名前面总有“招标文件-NN-”）。 */
const SEGMENT_CHAR = /^[\p{L}\p{N}._\-()（）【】《》、·]$/u;
const SEGMENT_MAX_BYTES = 100;

function isWorkspacePath(path: string): boolean {
  try {
    validateRelativePath(path, WORKSPACE_LIMITS, false);
    return true;
  } catch (error) {
    if (error instanceof SandboxArchiveError) return false;
    throw error;
  }
}

/**
 * 招标文件在工作区中的路径（桌面版 招标文件/招标文件-NN-文件名.md）。桌面版的路径不符合 agent 工作区的路径规则时，文件名中不允许的
 * 字符换成 _、按 UTF-8 字节截短；仍不符合时为 招标文件/招标文件-NN.md。
 */
export function tenderWorkspacePath(fileName: string, index: number): string {
  const stem = sanitizeFileName(fileName, `招标文件${index + 1}`);
  const desktop = `招标文件/招标文件-${padIndex(index)}-${stem}.md`;
  if (isWorkspacePath(desktop)) return desktop;
  const prefix = `招标文件-${padIndex(index)}-`;
  let budget = SEGMENT_MAX_BYTES - Buffer.byteLength(`${prefix}.md`, 'utf8');
  let safe = '';
  for (const char of stem.normalize('NFC')) {
    const next = SEGMENT_CHAR.test(char) && char.normalize('NFKC') === char ? char : '_';
    const bytes = Buffer.byteLength(next, 'utf8');
    if (bytes > budget) break;
    budget -= bytes;
    safe += next;
  }
  const replaced = `招标文件/${prefix}${safe}.md`;
  return isWorkspacePath(replaced) ? replaced : `招标文件/招标文件-${padIndex(index)}.md`;
}

interface FileCatalogInput {
  tenderPaths: readonly string[];
  isWorkingCopy: boolean;
  hasSectionHint: boolean;
  knowledgeCount: number;
  hasOriginalPlan: boolean;
}

/** 与桌面版 buildFileCatalog 相同。 */
function buildFileCatalog({ tenderPaths, isWorkingCopy, hasSectionHint, knowledgeCount, hasOriginalPlan }: FileCatalogInput): string {
  const lines: string[] = [];
  if (tenderPaths.length) {
    const listed = tenderPaths.join('、');
    if (isWorkingCopy) {
      lines.push(`- ${listed}：排除其他标段后的当前投标范围正文，用于确定大项并提取明确事实；不要扩展到其他标段。`);
    } else {
      const multiNote = tenderPaths.length > 1 ? '；多份都要看' : '';
      lines.push(`- ${listed}：招标原文，用于确定大项并提取明确事实${multiNote}。`);
    }
  }
  lines.push('- 项目概述.md：项目背景和术语，用于确定大项，不作为商务/资格材料来源。');
  lines.push('- 招标解析结果.md：招标文件解析阶段已抽出的项目信息、甲方信息、交货和服务要求，用于确定大项并提取明确值。');
  lines.push('- 技术方案目录.md：已确认目录，用于判断正文会反复用到哪些统一口径。');
  if (hasSectionHint) lines.push('- 标段说明.md：本次投标范围，只关注该范围内的事实。');
  if (knowledgeCount > 0) lines.push('- 参考知识库/条目-*.md：补充已有大项的具体内容。');
  if (hasOriginalPlan) lines.push('- 原方案.md：用户上传的优化扩写底稿，补充已有大项的具体内容。');
  lines.push('- 材料说明.md：本次实际提供的文件清单，与上述用途一致。');
  return lines.join('\n');
}

/** 与桌面版 buildWorkPrinciples 相同。 */
function buildWorkPrinciples(hasKnowledge: boolean, hasOriginalPlan: boolean): string {
  const supplementNames = [hasKnowledge ? '知识库' : '', hasOriginalPlan ? '原方案' : ''].filter(Boolean);
  const principles = [
    '1. 先根据招标文件、项目概述、招标解析结果和技术方案目录，确定全部全局事实大项（id、title）。凡这些材料表明后续正文需要统一口径的事项，都必须建项；招标文件有多份时要综合全部招标原文，不要因为某一份没写就漏项。',
  ];
  let fillRule = '2. 再为每个大项填写 content。优先使用招标文件和招标解析结果中的明确值';
  if (supplementNames.length) fillRule += `；然后再用${supplementNames.join('、')}补充这些已有大项的具体内容`;
  principles.push(`${fillRule}。`);

  let next = 3;
  if (supplementNames.length) {
    principles.push(`${next}. ${supplementNames.join('和')}只用于补充已有大项的 content，不要靠它们新增大项。`);
    next += 1;
  }
  principles.push(
    `${next}. 全局事实不是招标要求摘录、评分规则或待办清单，而是正文要统一采用的方案事实、响应设定、承诺口径或执行安排。材料给出的是要求或约束时，不要原样摘录要求句，应转写为本方案统一口径。`,
  );
  next += 1;
  principles.push(`${next}. 每条 content 只写简体中文短 bullet，回答“后续正文遇到这个事项时统一写什么”。不写分析过程、来源说明、风险提示、正文草稿、商务报价或资格材料。`);
  next += 1;
  principles.push(`${next}. 必须包含工期、运维期或交货时间中的至少一个相关变量；缺具体值时按本任务给定的写法填写，不要省略该项。`);
  next += 1;
  principles.push(
    `${next}. 材料较长时，先结合章节结构分段检查，再用 grep 定位具体事实和关联条款。多份招标材料分别跟踪已处理范围，逐步整理事实大项；补充具体值时按主题读取相关材料。可用 node、jq 辅助合并条目和定位重复项，事实含义及冲突由你判断。`,
  );
  if (hasKnowledge) {
    next += 1;
    principles.push(`${next}. 用参考知识库补充已有大项的具体内容，不要仅因知识库出现新话题就新增大项。`);
  }
  if (hasOriginalPlan) {
    next += 1;
    principles.push(`${next}. 用原方案补充已有大项的具体内容；原方案与招标明确事实冲突时，原方案已落地的安排优先替换对应 bullet。不要仅因原方案出现新话题就新增大项。`);
  }
  return principles.join('\n');
}

/** 与桌面版 buildMissingValueRule 相同。 */
function buildMissingValueRule(mode: TechnicalPlanGlobalFactsMode): string {
  if (mode === 'omit') {
    return '用户资料已经给出明确事实时，使用资料中的事实值。用户资料没有给出具体值时，该项仍须保留，写成不涉及具体时间、地点、人员、业绩、证书、规格型号、工艺步骤、数量指标的正确笼统承诺，表明本方案按招标要求执行该项，但不展开具体做法。严禁省略该项，也严禁杜撰具体值。必须包含工期、运维期或交货时间中的至少一个相关变量；没有具体值时同样使用笼统承诺，不要编造日期或周期。笼统但正确的承诺口径不是空泛内容，定稿时不得因不够具体而删除。';
  }
  if (mode === 'placeholder') {
    return '用户资料已经给出明确事实时，使用资料中的事实值。用户资料没有给出具体值时，该项仍须保留，值必须逐字写成【待填写】，不要改写成“待定”“TBD”或其他说法，也不要编造具体值。严禁省略该项。必须包含工期、运维期或交货时间中的至少一个相关变量；没有具体值时使用【待填写】。【待填写】不是空泛内容，定稿时不得因不够具体而删除。';
  }
  return '用户资料已经给出明确事实时，使用资料中的事实值。用户资料没有给出具体值，但该信息对全文一致性重要时，根据项目语境补足一套合理、稳定、不冲突的具体事实值。必须包含工期、运维期或交货时间中的至少一个相关变量；分段或材料不足时，若项目概述或招标解析结果中已有明确内容应写入，否则按项目语境补足具体周期。';
}

/** 与桌面版 buildJsonExample 相同。 */
function buildJsonExample(mode: TechnicalPlanGlobalFactsMode): string {
  if (mode === 'placeholder') {
    return `{
  "groups": [
    {
      "id": "project_team",
      "title": "项目角色变量",
      "content": "- 项目经理：【待填写】。\\n- 技术负责人：【待填写】。"
    }
  ]
}`;
  }
  if (mode === 'omit') {
    return `{
  "groups": [
    {
      "id": "project_team",
      "title": "项目角色变量",
      "content": "- 项目经理：按招标文件对该岗位的要求配备。\\n- 技术负责人：按招标文件对该岗位的要求配备。"
    }
  ]
}`;
  }
  return `{
  "groups": [
    {
      "id": "project_team",
      "title": "项目角色变量",
      "content": "- 项目经理：张伟，负责总体协调。\\n- 技术负责人：李明，负责方案设计和联调验收。"
    }
  ]
}`;
}

/** 与桌面版 createGlobalFactsPrompt 相同。 */
function createGlobalFactsPrompt(fileCatalog: string, hasKnowledge: boolean, hasOriginalPlan: boolean, mode: TechnicalPlanGlobalFactsMode): string {
  return `请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。

任务：整理后续技术方案正文必须统一采用的全局事实变量，写入 ${GLOBAL_FACTS_OUTPUT_FILE}。

工作流程由你自主安排，但必须遵守下面的材料用途和先后原则。

材料用途：
${fileCatalog}

工作原则：
${buildWorkPrinciples(hasKnowledge, hasOriginalPlan)}

缺具体值时的写法：
${buildMissingValueRule(mode)}

输出：
1. 最终结果写入 ${GLOBAL_FACTS_OUTPUT_FILE}，必须是纯 JSON，不要 Markdown 代码块。
2. 根对象只有 groups；每项包含 id、title、content。
3. 程序已为该文件预置 Schema，可用 json-validation 自查，只传 file_path。确认全部工作完成时，在最后一次成功的写入或修改中传 task_complete=true；结束后程序统一校验，不通过会退回问题清单继续修复。

格式示意：
${buildJsonExample(mode)}`;
}

export interface GlobalFactsAgentInputState {
  /** 招标正文：多标段且选择了投标范围时为按投标范围裁剪的一份（isWorkingCopy），否则为各招标文件的原文，按导入顺序。 */
  tenderSources: readonly { fileName: string; markdown: string; isWorkingCopy: boolean }[];
  /** 选中的投标范围（多标段时，用于标段说明）。 */
  selectedSection: TechnicalPlanBidSection | null;
  projectOverview: string;
  bidAnalysisTasks: BidItems;
  outline: readonly TechnicalPlanOutlineItem[];
  /** 原方案的正文（没有原方案时为空）。 */
  originalPlanMarkdown: string;
  globalFactsMode: TechnicalPlanGlobalFactsMode;
}

export interface GlobalFactsAgentInput {
  /** 放入工作区的材料（受保护文件，与桌面版 files 相同的顺序与内容）。 */
  files: { path: string; content: string }[];
  prompt: string;
}

/** 与桌面版 runGlobalFactsTaskV2 相同的工作区材料与提示词。 */
export function buildGlobalFactsAgentInput(state: GlobalFactsAgentInputState, knowledgeItems: readonly GlobalFactsKnowledgeItem[]): GlobalFactsAgentInput {
  const usingWorkingCopy = state.tenderSources.some((source) => source.isWorkingCopy);
  const sectionHint = usingWorkingCopy ? buildBidSectionContextHint(state.selectedSection, { hasSelectedSection: true }) : '';
  const tenderFiles = state.tenderSources.map((source, index) =>
    source.isWorkingCopy
      ? { path: '招标文件/招标文件-当前投标范围.md', content: source.markdown }
      : { path: tenderWorkspacePath(source.fileName, index), content: source.markdown },
  );
  const files = [
    ...tenderFiles,
    { path: '项目概述.md', content: String(state.projectOverview || '').trim() || '未提供项目概述。' },
    { path: '招标解析结果.md', content: formatBidAnalysisFactsForPrompt(state.bidAnalysisTasks) },
    { path: '技术方案目录.md', content: formatOutlineForPrompt(state.outline) },
  ];
  if (sectionHint) files.push({ path: '标段说明.md', content: sectionHint });
  knowledgeItems.forEach((item, index) => files.push({ path: `参考知识库/条目-${index + 1}.md`, content: formatKnowledgeItemFile(item) }));
  const originalPlanMarkdown = String(state.originalPlanMarkdown || '').trim();
  if (originalPlanMarkdown) files.push({ path: '原方案.md', content: originalPlanMarkdown });
  const fileCatalog = buildFileCatalog({
    tenderPaths: tenderFiles.map((file) => file.path),
    isWorkingCopy: usingWorkingCopy,
    hasSectionHint: Boolean(sectionHint),
    knowledgeCount: knowledgeItems.length,
    hasOriginalPlan: Boolean(originalPlanMarkdown),
  });
  files.push({ path: '材料说明.md', content: `本次任务实际提供的材料如下。只使用这些文件，不要猜测未提供的材料。\n\n${fileCatalog}` });
  return { files, prompt: createGlobalFactsPrompt(fileCatalog, knowledgeItems.length > 0, Boolean(originalPlanMarkdown), state.globalFactsMode) };
}
