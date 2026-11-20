// 技术方案目录的 Agent 材料、提示词与提交校验（路线图第 8 步 8.7d 目录调整、8.7e1 目录生成的一级目录与确认、8.7e2a 无技术评分项模式的
// 后续阶段）：与桌面版 client/electron/services/outlineAdjustmentTask.cjs
// （buildAgentOutlineInput、createOutlineAdjustmentPrompt）、outlineGenerationTaskV2.cjs（OUTLINE_OUTPUT_FILE、OUTLINE_JSON_SCHEMA、
// validateJsonOutput、validateOutlineOutput、buildFinalOutline、isMissingTechnicalScoreItems、createInitialPrompt、初始材料与默认选择；
// OUTLINE_REVIEW_SCHEMA、deriveTargetLeafCount、countAiLeaves、countLeavesByMode、collectOutlineStructure、buildOutlineReviewContext、
// createNoTechnicalScoreChildrenPrompt、createLeafAdjustmentPrompt、createNoTechnicalScoreReviewPrompt）、
// taskService.cjs（一级目录确认）与 technicalPlanOutline.cjs（NODE_ID_PATTERN、collectOutlineIds、acceptAgentOutline）相同
// （tests/technicalPlan/outlineAdjustmentJob.test.ts、outlineGenerationJob.test.ts 加载桌面版逐项对照）。
//
// - 结果文件 outline.json 由沙箱中的 Agent 写出，按不可信数据处理。目录调整与桌面版相同不在提交校验中检查预置 Schema（checkSchema: false，
//   Schema 只预置给 json-validation 供 Agent 自查）；检查 JSON、目录结构与节点 id（只能沿用当前目录的 id，新节点填 null），通过后为新节点
//   分配 id 并编号；任一问题都是阻塞问题，经提交修复退回 Agent；
// - 与桌面版不同：不是合法 JSON 时问题说明不附解析器的错误信息（同 8.7a）；问题说明中的 id 至多 100 个字符；超过服务端目录层级上限的
//   部分不再展开（报告一条阻塞问题）；问题至多 AGENT_SUBMISSION_MAX_ISSUES 条；整理后目录为空、或超出服务端目录上限（节点数、层级、
//   字数，src/technicalPlan/outline.ts 的 flattenOutline）、处理方式不在列表中时为阻塞问题（桌面版保存空目录即删除目录，且不限）。
import { randomUUID } from 'node:crypto';
import { Ajv, type ErrorObject } from 'ajv';
import { TECHNICAL_PLAN_OUTLINE_DEPTH_MAX } from '../db/migrations/0019_technical_plan_outline.ts';
import { AGENT_SUBMISSION_MAX_ISSUES, type AgentSubmissionIssue } from '../agent/submission.ts';
import { flattenOutline, numberOutline, OutlineInputError, type TechnicalPlanOutlineItem } from './outline.ts';

/** 结果文件（与桌面版 OUTLINE_OUTPUT_FILE 相同）。 */
export const OUTLINE_OUTPUT_FILE = 'outline.json';

/** 节点 id 的格式（与桌面版 NODE_ID_PATTERN 相同：小写的 UUID v4）。 */
export const OUTLINE_NODE_ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const OUTLINE_ATTRIBUTES = ['通用', '商务/资信', '技术', '其他', '目录', '报价', '业绩'];
export const OUTLINE_CONTENT_MODES = ['ai-generate', 'template-fill', 'directory-generate', 'manual-fill', 'other'];
const ATTRIBUTE_CONTENT_MODE_RULES: Record<string, string> = {
  '商务/资信': 'template-fill',
  目录: 'directory-generate',
  报价: 'manual-fill',
  业绩: 'template-fill',
};
/** 问题说明中引用的 id 的字数上限（Web 版新增：id 来自沙箱，可能很长）。 */
const ISSUE_ID_MAX_CHARS = 100;

/** 与桌面版 createDirectoryNodeSchema 相同。 */
function createDirectoryNodeSchema(level: number, root = false): Record<string, unknown> {
  const baseProperties = {
    id: { anyOf: [{ type: 'string', pattern: OUTLINE_NODE_ID_PATTERN }, { type: 'null' }] },
    number: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    ...(root ? { attr: { type: 'string', enum: OUTLINE_ATTRIBUTES } } : {}),
  };
  const baseRequired = ['id', 'title', 'description', ...(root ? ['attr'] : [])];
  const leafSchema = {
    type: 'object',
    required: [...baseRequired, 'content_mode'],
    additionalProperties: false,
    properties: {
      ...baseProperties,
      content_mode: { type: 'string', enum: OUTLINE_CONTENT_MODES },
      content_mode_note: { type: 'string' },
    },
    ...(root
      ? {
          allOf: Object.entries(ATTRIBUTE_CONTENT_MODE_RULES).map(([attr, contentMode]) => ({
            if: { properties: { attr: { const: attr } }, required: ['attr'] },
            then: { properties: { content_mode: { const: contentMode } } },
          })),
        }
      : {}),
  };
  if (level < 6) {
    const branchSchema = {
      type: 'object',
      required: [...baseRequired, 'children'],
      additionalProperties: false,
      properties: {
        ...baseProperties,
        children: { type: 'array', minItems: 2, items: createDirectoryNodeSchema(level + 1) },
      },
    };
    return { oneOf: [leafSchema, branchSchema] };
  }
  return leafSchema;
}

/** json-validation 为 outline.json 预置的 Schema（与桌面版 OUTLINE_JSON_SCHEMA 相同）。 */
export const OUTLINE_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['outline'],
  additionalProperties: false,
  properties: {
    outline: { type: 'array', minItems: 1, items: createDirectoryNodeSchema(1, true) },
  },
};

const validateOutlineSchema = new Ajv({ allErrors: true, strict: true }).compile(OUTLINE_JSON_SCHEMA);

// ---- 工作区材料与提示词 ----

/** 交给 Agent 的目录节点（与桌面版 buildAgentOutlineInput 的结果相同；Web 版的目录没有 attr，与桌面版保存后的目录相同）。 */
export interface AgentOutlineInputItem {
  id: string;
  number: string;
  title: string;
  description: string;
  children?: AgentOutlineInputItem[];
  content_mode?: string;
  content_mode_note?: string;
}

/** 与桌面版 buildAgentOutlineInput 相同：只保留目录结构字段，正文等业务字段不进入 Agent 工作区。 */
export function buildAgentOutlineInput(outline: readonly TechnicalPlanOutlineItem[]): { outline: AgentOutlineInputItem[] } {
  const strip = (items: readonly TechnicalPlanOutlineItem[] | undefined): AgentOutlineInputItem[] =>
    (items ?? []).map((item) => {
      const hasChildren = Array.isArray(item.children) && item.children.length > 0;
      const title = String(item.title || '').trim();
      const node: AgentOutlineInputItem = { id: item.id, number: item.number, title, description: String(item.description || '').trim() || title };
      if (hasChildren) {
        node.children = strip(item.children);
      } else {
        if (item.content_mode !== undefined) node.content_mode = item.content_mode;
        if (item.content_mode === 'other' && String(item.content_mode_note || '').trim()) node.content_mode_note = String(item.content_mode_note).trim();
      }
      return node;
    });
  return { outline: strip(outline) };
}

/** 目录调整放入的 outline.json（与桌面版 files 中的内容相同）。 */
export function outlineAdjustmentFile(outline: readonly TechnicalPlanOutlineItem[]): string {
  return JSON.stringify(buildAgentOutlineInput(outline), null, 2);
}

/** 与桌面版 createOutlineAdjustmentPrompt 相同。 */
export function createOutlineAdjustmentPrompt(requirement: string): string {
  return `用户已经在最终目录基础上提出新的调整要求。程序已把当前最新的完整目录覆盖写入 ${OUTLINE_OUTPUT_FILE}（用户可能在主界面手动修改过目录，请以该文件为准，不要沿用你记忆中的旧目录）。

用户的调整要求：
${requirement}

请按以下要求完成目录调整：
1. 以当前文件为准，先定位用户要求涉及的节点或事实项，并读取必要上下文。优先使用 edit 局部修改；涉及多个节点或条目的统一调整时，可使用 bash 配合 node、jq 处理。
2. 修改后仍须保持完整根结构 {"outline":[一级目录节点]}：一级目录包含 attr（从"通用""商务/资信""技术""其他""目录""报价""业绩"中选择），子目录不包含 attr；已有节点 id 原样保留，新节点 id 填 null，由程序分配唯一 ID；数组顺序决定排序，number 是程序计算的显示编号，不得填入 id。
3. 每个最终叶子节点必须填写 content_mode：技术方案正文为 ai-generate；商务/资信和业绩材料为 template-fill；投标文件目录为 directory-generate；报价为 manual-fill；其他特殊内容为 other，并用 content_mode_note 说明。父节点只包含 children，不包含 content_mode 或 content_mode_note。
4. 任意非叶子节点的 children 至少包含两个节点，目录最多六级；title 只写纯标题，不包含章节编号或 Markdown 标记。
5. 如果用户要求含糊或存在多种理解，选择最符合投标文件专业惯例的做法直接执行，不要调用 ask-user 反复确认；只有当要求明显违反上述结构规则且无法合理变通时，才在最终回复中说明未执行的部分及原因。
6. 将调整结果保存到 ${OUTLINE_OUTPUT_FILE}，保存后保持完整文件结构和未涉及内容。程序已为该文件预置 Schema，写入后调用 json-validation，只传 {"file_path":"${OUTLINE_OUTPUT_FILE}"}；校验失败后必须先修改文件，再重新校验。
7. 全部完成后，用简体中文输出一段简短的最终总结（不超过 200 字，不使用 Markdown 标题），说明本次实际做了哪些目录调整；如有未能执行的要求，一并说明原因。该总结会直接展示给用户。`;
}

// ---- 提交校验 ----

/** 与桌面版 collectOutlineIds 相同。 */
export function collectOutlineIds(items: readonly { id: string; children?: readonly unknown[] }[] | undefined, ids = new Set<string>()): Set<string> {
  for (const item of items ?? []) {
    ids.add(item.id);
    collectOutlineIds(item.children as { id: string; children?: unknown[] }[] | undefined, ids);
  }
  return ids;
}

/** 接受后的目录节点（与桌面版 acceptAgentOutline 的结果相同；attr 只在一级目录，保存时不存）。 */
export interface AcceptedOutlineItem {
  id: string;
  number: string;
  title: string;
  description: string;
  attr?: unknown;
  children?: AcceptedOutlineItem[];
  content_mode?: unknown;
  content_mode_note?: string;
}

/** 提交校验的结果：value 在没有阻塞问题时为接受后的目录（新节点已分配 id、已编号）。 */
export interface OutlineSubmission {
  value: { outline: AcceptedOutlineItem[] } | null;
  issues: AgentSubmissionIssue[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const blocking = (message: string): AgentSubmissionIssue => ({ severity: 'blocking', message });

/** 问题说明中的 id：与桌面版相同按字符串拼入，过长时截短（Web 版新增）。 */
function idText(id: unknown): string {
  const text = String(id);
  const chars = [...text];
  return chars.length > ISSUE_ID_MAX_CHARS ? `${chars.slice(0, ISSUE_ID_MAX_CHARS).join('')}…` : text;
}

/** 问题清单至多 AGENT_SUBMISSION_MAX_ISSUES 条（提交校验报告的上限），超出的合并为最后一条（桌面版不限）。 */
function capped(issues: AgentSubmissionIssue[]): AgentSubmissionIssue[] {
  if (issues.length <= AGENT_SUBMISSION_MAX_ISSUES) return issues;
  const kept = issues.slice(0, AGENT_SUBMISSION_MAX_ISSUES - 1);
  return [...kept, blocking(`${OUTLINE_OUTPUT_FILE} 另有 ${issues.length - kept.length} 个问题`)];
}

function schemaIssues(errors: readonly ErrorObject[], file = OUTLINE_OUTPUT_FILE): AgentSubmissionIssue[] {
  return errors.map((item) => blocking(`${file} 不符合结构要求：${item.instancePath || '/'} ${item.message}`));
}

/** 与桌面版 acceptAgentOutline 相同（只用于已通过 id 检查的目录）：新节点分配 id，标题与说明去掉首尾空白，编号。 */
function acceptAgentOutline(items: readonly Record<string, unknown>[]): AcceptedOutlineItem[] {
  const visit = (nodes: readonly Record<string, unknown>[], root: boolean): AcceptedOutlineItem[] =>
    nodes.map((item) => {
      const id = item.id === null ? randomUUID() : String(item.id);
      const children = item.children;
      const branch = Array.isArray(children) && children.length > 0;
      const node: Omit<AcceptedOutlineItem, 'number'> = { id, title: String(item.title || '').trim(), description: String(item.description || '').trim() };
      if (root) node.attr = item.attr;
      if (branch) {
        node.children = visit(children as Record<string, unknown>[], false) as AcceptedOutlineItem[];
      } else {
        node.content_mode = item.content_mode;
        // 桌面版在说明不是字符串时抛错（执行异常）；这里按没有说明处理。
        const note = typeof item.content_mode_note === 'string' ? item.content_mode_note.trim() : '';
        if (item.content_mode === 'other' && note) node.content_mode_note = note;
      }
      return node as AcceptedOutlineItem;
    });
  return numberOutline(visit(items, true));
}

/**
 * 与桌面版 validateOutlineOutput 相同的提交校验（目录生成与调整共用；调整时 checkSchema 为 false，与桌面版相同）：outline.json 为空、
 * 不是合法 JSON、（checkSchema 时）不符合预置 Schema、目录结构错误、包含未知或重复的 id 时为阻塞问题，问题说明与桌面版相同（差异见文件头）；
 * 通过后为新节点分配 id 并编号，再按服务端的目录上限检查。content 为文件内容（来自沙箱），knownIds 为当前目录的节点 id。
 */
export function validateOutlineOutput(content: string, knownIds: ReadonlySet<string>, options: { checkSchema?: boolean } = {}): OutlineSubmission {
  const text = String(content || '').trim();
  if (!text) return { value: null, issues: [blocking(`${OUTLINE_OUTPUT_FILE} 未写入或内容为空，请写入完整的 JSON`)] };
  let generated: unknown;
  try {
    generated = JSON.parse(text);
  } catch {
    return { value: null, issues: [blocking(`${OUTLINE_OUTPUT_FILE}不是合法 JSON`)] };
  }
  if ((options.checkSchema ?? true) && !validateOutlineSchema(generated)) {
    return { value: null, issues: capped(schemaIssues(validateOutlineSchema.errors ?? [])) };
  }
  const issues: AgentSubmissionIssue[] = [];
  const seen = new Set<unknown>();
  // 模型产物的遍历结构错误进入提交修复，不作为执行异常中断任务。
  const visit = (items: unknown, parentPath: string, level: number) => {
    if (!Array.isArray(items)) {
      issues.push(blocking(`目录结构错误：${parentPath} 必须是数组`));
      return;
    }
    if (level > TECHNICAL_PLAN_OUTLINE_DEPTH_MAX) {
      issues.push(blocking(`目录结构错误：${parentPath} 超过 ${TECHNICAL_PLAN_OUTLINE_DEPTH_MAX} 级`));
      return;
    }
    items.forEach((item: unknown, index) => {
      const nodePath = `${parentPath}/${index}`;
      if (!isObject(item)) {
        issues.push(blocking(`目录结构错误：${nodePath} 必须是非空对象`));
        return;
      }
      if (item.id !== null) {
        if (typeof item.id !== 'string' || !knownIds.has(item.id)) issues.push(blocking(`目录包含未知 ID：${idText(item.id)}；新节点请使用 id:null`));
        if (seen.has(item.id)) issues.push(blocking(`目录 ID 重复：${idText(item.id)}`));
        seen.add(item.id);
      }
      const children = item.children as { length?: unknown } | null | undefined;
      if (children?.length) visit(children, `${nodePath}/children`, level + 1);
    });
  };
  const outline = isObject(generated) ? generated.outline : undefined;
  visit(outline || [], '/outline', 1);
  if (issues.length) return { value: null, issues: capped(issues) };
  const accepted = acceptAgentOutline((outline || []) as Record<string, unknown>[]);
  if (!accepted.length) return { value: null, issues: [blocking(`${OUTLINE_OUTPUT_FILE} 中没有目录节点，请写入完整目录`)] };
  try {
    flattenOutline(accepted);
  } catch (error) {
    if (error instanceof OutlineInputError) return { value: null, issues: [blocking(`${OUTLINE_OUTPUT_FILE} 超出限制：${error.message}`)] };
    throw error;
  }
  return { value: { outline: accepted }, issues: [] };
}

// ---- 目录生成：一级目录（8.7e1） ----

/** 一级目录阶段（与桌面版 initial_stage 相同）。 */
export const INITIAL_OUTLINE_STAGE = 'initial-outline';
/**
 * 后续阶段（8.7e2a）：桌面版的阶段名含下划线（children_generation、leaf_adjustment、outline_review），执行层的阶段名只允许小写字母、
 * 数字与 -，换成连字符形式（#106 登记）。评分规划、叶子分配随 8.7e2b。
 */
export const CHILDREN_GENERATION_STAGE = 'children-generation';
export const LEAF_ADJUSTMENT_STAGE = 'leaf-adjustment';
export const OUTLINE_REVIEW_STAGE = 'outline-review';
/** 目录审查的结果文件与程序计算的审查材料（与桌面版 OUTLINE_REVIEW_FILE、OUTLINE_REVIEW_CONTEXT_FILE 相同）。 */
export const OUTLINE_REVIEW_FILE = 'outline-review.json';
export const OUTLINE_REVIEW_CONTEXT_FILE = 'outline-review-context.json';
/** 各阶段的必需文件（与桌面版 STAGE_OUTPUT_FILES 相同，阶段名为连字符形式；评分规划、叶子分配随 8.7e2b）。 */
const STAGE_OUTPUT_FILES: Readonly<Record<string, readonly string[]>> = {
  [INITIAL_OUTLINE_STAGE]: [OUTLINE_OUTPUT_FILE],
  [CHILDREN_GENERATION_STAGE]: [OUTLINE_OUTPUT_FILE],
  [LEAF_ADJUSTMENT_STAGE]: [OUTLINE_OUTPUT_FILE],
  [OUTLINE_REVIEW_STAGE]: [OUTLINE_OUTPUT_FILE, OUTLINE_REVIEW_FILE],
};
/** 与桌面版 ORIGINAL_ONLY_DIRECTORY_RULE 相同。 */
export const ORIGINAL_ONLY_DIRECTORY_RULE =
  '目录来源仅限原方案.md：提取并补齐原方案中实际存在的目录，保留其顺序和层级；不得依据其他资料或专业经验新增原方案中不存在的章节，也不得为凑字数或小节数量新增、拆分章节。';

/** 与桌面版 createOutputFileRequirements 相同。 */
export function createOutputFileRequirements(stage: string): string {
  const files = STAGE_OUTPUT_FILES[stage];
  if (!files) throw new TypeError(`未知的目录生成阶段：${stage}`);
  return `本阶段必需文件：${files.join('、')}。程序已在当前工作目录根目录准备好这些文件，你只负责填入或修改内容，不要自行创建其他位置的副本、改名或删除文件。已有目录必须保留用户确认的内容和节点 ID。所有必需文件都必须包含完整、有效且符合 Schema 的纯 JSON；空文件不算完成，只在回复中输出 JSON 不算写入。全部文件写入并通过校验后才能结束本阶段。`;
}

/** 与桌面版 createOutputRepairPrompt 的提交修复部分相同（执行失败时返回 null：不重试）。 */
export function createOutputRepairPrompt(stage: string): string {
  return `${createOutputFileRequirements(stage)}\n沿用已有材料和用户确认结果，只修复本次提交报告中的问题；已通过的文件保留，不要重复询问已确认事项。`;
}

/** 与桌面版 isMissingTechnicalScoreItems 相同：按解析协议识别整项缺失或仅技术评分项缺失。 */
export function isMissingTechnicalScoreItems(content: string): boolean {
  const text = String(content || '').trim();
  if (text === '未提取到') return true;
  const section = text.match(/^##[\t ]+技术评分项[\t ]*\r?\n([\s\S]*?)(?=^#{1,2}[\t ]|$(?![\s\S]))/m);
  return section?.[1]?.trim() === '没有提及';
}

/** 目录的组织方式（与桌面版 outline_mode 相同）。 */
export type OutlineGenerationMode = 'response-file' | 'standalone-technical' | 'standalone-business';

/** 与桌面版 createInitialPrompt 相同。 */
export function createInitialPrompt(taskInstruction: string, options: { standaloneTechnical?: boolean; noTechnicalScoreMode?: boolean } = {}): string {
  const standaloneTechnical = options.standaloneTechnical ?? false;
  const noTechnicalScoreMode = options.noTechnicalScoreMode ?? false;
  const goal = standaloneTechnical
    ? noTechnicalScoreMode
      ? '我们的目标是为没有技术评分项的单独装订技术文件准备一级目录。'
      : '我们的目标是为单独装订的技术文件准备一级目录。一级目录必须直接对应技术评分大项。'
    : '我们的目标是为编写响应文件/投标文件准备一级目录。';
  const modeRequirements = standaloneTechnical
    ? noTechnicalScoreMode
      ? `6. 本模式只生成技术文件独立分册：一级目录必须是适合展开技术正文的专业主题，attr 必须为“技术”，content_mode 必须为 ai-generate。
7. 招标文件已确认没有可用的技术评分项。优先采用已有资料中的明确要求；资料没有给出目录结构时，根据项目类型和专业经验补充通用、合理的技术方案主题，但不得编造具体项目事实、参数、业绩或承诺。
8. 不得创建“技术方案”“项目管理方案”“监理大纲”“监理大纲（暗标）”“施工组织设计”“技术标”等外层总目录，也不得加入商务/资信、投标函、授权委托书等非技术章节。`
      : `6. 本模式只生成技术文件独立分册：只能保留适合展开技术正文的评分大项，attr 必须为“技术”，content_mode 必须为 ai-generate。
7. 每个一级目录直接对应一个技术评分大项，并保持评分大项的原顺序和正式表述；不得创建“技术方案”“项目管理方案”“监理大纲”“监理大纲（暗标）”“施工组织设计”“技术标”等外层总目录，也不得加入商务/资信、投标函、授权委托书等非技术章节。
8. 完整结构示例：{"outline":[{"id":null,"title":"评分大项一","description":"评分大项一的技术响应范围","attr":"技术","content_mode":"ai-generate"},{"id":null,"title":"评分大项二","description":"评分大项二的技术响应范围","attr":"技术","content_mode":"ai-generate"}]}。`
    : `6. 每个一级目录当前都是叶子节点，必须根据属性和后续处理方式填写 content_mode：技术方案正文使用 ai-generate；attr=商务/资信或业绩时必须使用 template-fill；attr=目录时必须使用 directory-generate；attr=报价时必须使用 manual-fill；无法归类的特殊内容使用 other，并在 content_mode_note 说明原因。
7. 完整结构示例：{"outline":[{"id":null,"title":"投标文件目录","description":"投标文件目录说明","attr":"目录","content_mode":"directory-generate"},{"id":null,"title":"技术方案","description":"技术方案目录说明","attr":"技术","content_mode":"ai-generate"},{"id":null,"title":"投标报价","description":"投标报价目录说明","attr":"报价","content_mode":"manual-fill"}]}。content_mode_note 只在 content_mode=other 且确有说明时填写。`;
  return `请只在当前工作目录内工作。
${createOutputFileRequirements(INITIAL_OUTLINE_STAGE)}

任务：
${goal}
${taskInstruction}

请生成一级目录 JSON，并将结果写入 ${OUTLINE_OUTPUT_FILE}。

字段要求：
1. 顶层必须是对象，唯一字段 outline 是一级目录数组；此阶段暂时不要生成 children。
2. 所有新节点 id 填 null，程序接收后分配唯一 ID。数组顺序表示目录顺序；number 由程序计算，不要用编号充当 ID。
3. title 必须是可直接用于投标文件目录的正式标题，不得包含“附件1”“附件一”“第一章”等编号或前缀。
4. description 是目录说明。
5. attr 必须从“通用”“商务/资信”“技术”“其他”“目录”“报价”“业绩”中选择。
${modeRequirements}
8. ${OUTLINE_OUTPUT_FILE} 必须是纯 JSON，不包含 Markdown 代码块或解释文字。
9. 程序已为 ${OUTLINE_OUTPUT_FILE} 预置 Schema，可用 json-validation 自查，只传 file_path；本阶段结束后程序统一校验，不通过会退回问题清单继续修复。`;
}

/** 目录生成读取的输入（与桌面版 runOutlineGenerationTaskV2 开始时从 storedPlan 读取的相同）。 */
export interface OutlineGenerationSource {
  outlineMode: OutlineGenerationMode;
  /** 是否有原方案（桌面版 Boolean(storedPlan.originalPlanFile)）。 */
  hasOriginalPlan: boolean;
  /** 原方案目录扩展方式：original-only 只按原方案。 */
  outlineExpansionMode: string;
  originalPlanMarkdown: string;
  /** 招标解析项“响应文件要求”的内容（与桌面版相同，不看状态）。 */
  responseFileRequirements: string;
  projectOverview: string;
  techRequirements: string;
  /** 无技术评分项模式（技术评分项缺失时须由用户确认）。 */
  noTechnicalScoreMode: boolean;
  /** 引用的知识库文档的 Markdown（桌面版 buildKnowledgeFiles，按引用顺序；为空的不放入）。 */
  knowledgeMarkdowns: readonly string[];
}

export interface AgentInputFile {
  path: string;
  content: string;
}

export interface InitialOutlineInput {
  /** 工作区材料（受保护文件）。 */
  files: AgentInputFile[];
  prompt: string;
  standaloneTechnical: boolean;
  standaloneBusiness: boolean;
  originalOnly: boolean;
}

/** 是否需要读取知识库文档（与桌面版 knowledgeFiles 相同：无技术评分项且只按原方案时不读；一级目录阶段只在无技术评分项模式放入）。 */
export function initialOutlineNeedsKnowledge(source: Pick<OutlineGenerationSource, 'noTechnicalScoreMode' | 'hasOriginalPlan' | 'outlineExpansionMode'>): boolean {
  const originalOnly = source.hasOriginalPlan && source.outlineExpansionMode === 'original-only';
  return source.noTechnicalScoreMode && !originalOnly;
}

/** 一级目录阶段的材料与提示词（与桌面版 initialFiles、taskInstruction 与 createInitialPrompt 相同）。 */
export function buildInitialOutlineInput(source: OutlineGenerationSource): InitialOutlineInput {
  const standaloneTechnical = source.outlineMode === 'standalone-technical';
  const standaloneBusiness = source.outlineMode === 'standalone-business';
  const { hasOriginalPlan, noTechnicalScoreMode } = source;
  const originalOnly = hasOriginalPlan && source.outlineExpansionMode === 'original-only';
  const originalPlan = hasOriginalPlan ? source.originalPlanMarkdown : '';
  const knowledgeFiles: AgentInputFile[] = noTechnicalScoreMode && originalOnly
    ? []
    : source.knowledgeMarkdowns
        .map((markdown, index) => ({ path: `参考知识库/参考资料-${index + 1}.md`, content: String(markdown || '').trim() }))
        .filter((file) => file.content);
  let files: AgentInputFile[];
  let taskInstruction: string;
  if (originalOnly) {
    files = [{ path: '原方案.md', content: originalPlan }];
    taskInstruction = noTechnicalScoreMode ? ORIGINAL_ONLY_DIRECTORY_RULE : '只根据原方案材料提取一级目录。';
  } else if (noTechnicalScoreMode) {
    files = [
      { path: '响应文件要求.md', content: source.responseFileRequirements },
      { path: '项目概述.md', content: source.projectOverview || '' },
      ...(hasOriginalPlan ? [{ path: '原方案.md', content: originalPlan }] : []),
      ...knowledgeFiles,
    ];
    taskInstruction = standaloneTechnical
      ? '招标文件已确认没有技术评分项。根据已有资料和专业经验生成技术文件一级目录，不得判断或补造评分项。'
      : '招标文件已确认没有技术评分项。优先按响应文件要求生成一级目录，并根据已有资料和专业经验补充必要的技术方案入口，不得判断或补造评分项。';
  } else {
    files = [
      { path: '响应文件要求.md', content: source.responseFileRequirements },
      ...(standaloneTechnical ? [{ path: '技术评分信息.md', content: source.techRequirements || '' }] : []),
      { path: '项目概述.md', content: source.projectOverview || '' },
      ...(hasOriginalPlan ? [{ path: '原方案.md', content: originalPlan }] : []),
    ];
    taskInstruction = standaloneTechnical
      ? '严格按照技术评分信息.md 中适合技术方案响应的评分大项组织一级目录，只生成技术方案独立分册。评分大项原文、顺序和数量是一级目录的权威依据；响应文件要求.md 只提供装订和响应约束，项目概述.md 仅用于理解背景和术语，原方案.md 仅用于参考下级标题表达。'
      : hasOriginalPlan
        ? '严格按照响应文件要求.md 组织一级目录，它是目录结构和标题来源的唯一依据。项目概述.md 仅用于理解背景和术语，不得据此新增一级目录；原方案.md 仅用于参考标题表达。'
        : '严格按照响应文件要求.md 组织一级目录，它是目录结构和标题来源的唯一依据。项目概述.md 仅用于理解背景和术语，不得据此新增一级目录。';
  }
  return {
    files,
    prompt: createInitialPrompt(taskInstruction, { standaloneTechnical, noTechnicalScoreMode }),
    standaloneTechnical,
    standaloneBusiness,
    originalOnly,
  };
}

// ---- 一级目录确认（8.7e1） ----

/** 待确认的一级目录至多这么多项（Web 版新增：待确认的内容写在任务 checkpoint 中，checkpoint 有大小上限）。 */
export const OUTLINE_SELECTION_ITEMS_MAX = 100;
/** 待确认内容（JSON）的最大字节数（Web 版新增，同上）。 */
export const OUTLINE_SELECTION_MAX_BYTES = 256 * 1024;

/** 一级目录阶段的提交校验：与桌面版 validateOutlineOutput(content) 相同（Schema、没有已知 id），另限制一级目录数与大小（Web 版新增）。 */
export function validateInitialOutlineOutput(content: string): OutlineSubmission {
  const report = validateOutlineOutput(content, new Set());
  if (!report.value) return report;
  if (report.value.outline.length > OUTLINE_SELECTION_ITEMS_MAX) {
    return { value: null, issues: [blocking(`${OUTLINE_OUTPUT_FILE} 超出限制：一级目录最多 ${OUTLINE_SELECTION_ITEMS_MAX} 项`)] };
  }
  if (Buffer.byteLength(JSON.stringify(report.value), 'utf8') > OUTLINE_SELECTION_MAX_BYTES) {
    return { value: null, issues: [blocking(`${OUTLINE_OUTPUT_FILE} 超出限制：一级目录内容过长，请精简标题与说明`)] };
  }
  return report;
}

/** 一级目录的默认选择（与桌面版 defaultSelectedIds 相同）。 */
export function defaultOutlineSelection(items: readonly AcceptedOutlineItem[], mode: OutlineGenerationMode): string[] {
  if (mode === 'standalone-business') {
    return items.filter((item) => ['template-fill', 'directory-generate', 'manual-fill'].includes(String(item.content_mode))).map((item) => item.id);
  }
  if (mode === 'standalone-technical') return items.filter((item) => item.attr === '技术').map((item) => item.id);
  return items.map((item) => item.id);
}

/** 用户对某个一级目录的修改（桌面版确认对话框只能改属性与内容处理模式）。 */
export interface OutlineSelectionChange {
  id: string;
  attr?: string;
  contentMode?: string;
}

export class OutlineSelectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutlineSelectionInputError';
  }
}

/**
 * 按用户的选择与修改得到确认后的一级目录（与桌面版确认对话框与 applyConfirmedSelection 相同）：选择须非空、不重复、都是待确认的
 * 一级目录；修改只能改属性与内容处理模式（取值在列表中），改为 other 以外的处理模式时去掉说明；标题、说明与 id 以服务端保存的为准
 * （桌面版取 Renderer 传回的整份目录）。不合法时抛 OutlineSelectionInputError。返回修改后的全部一级目录与按原顺序的选择。
 */
export function applyOutlineSelection(
  items: readonly AcceptedOutlineItem[],
  selectedIds: readonly unknown[],
  changes: readonly OutlineSelectionChange[] = [],
): { items: AcceptedOutlineItem[]; selectedIds: string[] } {
  const known = new Map(items.map((item) => [item.id, item]));
  if (selectedIds.length === 0) throw new OutlineSelectionInputError('请至少选择一个一级目录');
  const selected = new Set<string>();
  for (const id of selectedIds) {
    if (typeof id !== 'string' || !known.has(id)) throw new OutlineSelectionInputError('选择的一级目录不存在，请重新打开后再选择');
    if (selected.has(id)) throw new OutlineSelectionInputError('一级目录重复选择');
    selected.add(id);
  }
  const changed = new Map<string, OutlineSelectionChange>();
  for (const change of changes) {
    if (!known.has(change.id) || changed.has(change.id)) throw new OutlineSelectionInputError('修改的一级目录不存在，请重新打开后再选择');
    if (change.attr !== undefined && !OUTLINE_ATTRIBUTES.includes(change.attr)) throw new OutlineSelectionInputError('目录属性不合法');
    if (change.contentMode !== undefined && !OUTLINE_CONTENT_MODES.includes(change.contentMode)) throw new OutlineSelectionInputError('内容处理模式不合法');
    changed.set(change.id, change);
  }
  const next = items.map((item) => {
    const change = changed.get(item.id);
    if (!change) return item;
    const node: AcceptedOutlineItem = { ...item };
    if (change.attr !== undefined) node.attr = change.attr;
    if (change.contentMode !== undefined) {
      node.content_mode = change.contentMode;
      if (change.contentMode !== 'other') delete node.content_mode_note;
    }
    return node;
  });
  return { items: next, selectedIds: next.filter((item) => selected.has(item.id)).map((item) => item.id) };
}

/** 与桌面版 applyConfirmedSelection 相同：按确认的选择保留一级目录（原顺序）并重新编号。 */
export function lockedOutlineRoots(items: readonly AcceptedOutlineItem[], selectedIds: readonly string[]): AcceptedOutlineItem[] {
  const selected = new Set(selectedIds);
  return numberOutline(items.filter((item) => selected.has(item.id)));
}

/** 与桌面版 buildFinalOutline 相同（只用于 id 都已知的目录）：接受后的目录，attr 只在一级目录。 */
export function finalOutlineOf(roots: readonly AcceptedOutlineItem[]): AcceptedOutlineItem[] {
  return acceptAgentOutline(roots as unknown as Record<string, unknown>[]);
}

/** 写在目录生成任务 checkpoint 中的一级目录（待确认的与确认后的）。 */
export interface OutlineSelectionRecord {
  items: AcceptedOutlineItem[];
  selectedIds: string[];
}

function parseSelectionRecord(value: unknown): OutlineSelectionRecord | null {
  if (!isObject(value) || !Array.isArray(value.items) || !Array.isArray(value.selectedIds)) return null;
  const items = value.items as unknown[];
  if (items.length === 0 || items.length > OUTLINE_SELECTION_ITEMS_MAX) return null;
  if (!items.every((item) => isObject(item) && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.description === 'string' && typeof item.number === 'string')) {
    return null;
  }
  const ids = new Set((items as AcceptedOutlineItem[]).map((item) => item.id));
  if (ids.size !== items.length || !(value.selectedIds as unknown[]).every((id) => typeof id === 'string' && ids.has(id))) return null;
  return { items: items as AcceptedOutlineItem[], selectedIds: [...(value.selectedIds as string[])] };
}

/**
 * 读出目录生成任务 checkpoint 中任务自己的状态（task 部分）里的一级目录：selection 为待确认的（一级目录阶段完成时写入，selectedIds 为
 * 默认选择），confirmed 为用户确认后的（确认接口写入）。形状不对的按没有处理。
 */
export function readOutlineSelectionState(task: unknown): { selection: OutlineSelectionRecord | null; confirmed: OutlineSelectionRecord | null } {
  if (!isObject(task)) return { selection: null, confirmed: null };
  return { selection: parseSelectionRecord(task.selection), confirmed: parseSelectionRecord(task.confirmed) };
}

// ---- 目录生成：确认之后的后续阶段（8.7e2a 无技术评分项模式；评分规划、叶子分配随 8.7e2b） ----

/** 需要 AI 扩展的内容处理模式（与桌面版 AI_CONTENT_MODE 相同）。 */
export const AI_CONTENT_MODE = 'ai-generate';
/** 估算的每节字数（与桌面版 DEFAULT_ESTIMATED_SECTION_WORDS 相同）。 */
const DEFAULT_ESTIMATED_SECTION_WORDS = 3000;
/** 叶子调整的固定选项中“接受当前结果”（与桌面版相同）。 */
export const LEAF_ADJUSTMENT_ACCEPT_OPTION = '接受当前结果';

/** json-validation 为 outline-review.json 预置的 Schema（与桌面版 OUTLINE_REVIEW_SCHEMA 相同）。 */
export const OUTLINE_REVIEW_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['status', 'issues', 'user_feedback', 'summary'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['passed', 'simple_fix', 'user_feedback', 'user_refuse'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['category', 'problem', 'repair', 'confirmation_required'],
        additionalProperties: false,
        properties: {
          category: {
            type: 'string',
            enum: ['leaf-count', 'score-coverage', 'duplicate-directory', 'professional-structure'],
          },
          problem: { type: 'string', minLength: 1 },
          repair: { type: 'string', minLength: 1 },
          confirmation_required: { type: 'boolean' },
        },
      },
    },
    user_feedback: { type: 'string' },
    summary: { type: 'string', minLength: 1 },
  },
};

const validateOutlineReviewSchema = new Ajv({ allErrors: true, strict: true }).compile(OUTLINE_REVIEW_SCHEMA);

/**
 * 目录生成各阶段预置给 json-validation 的 Schema（与桌面版 jsonValidationSchemas 相同，一次预置全部阶段的）。评分规划与叶子分配的
 * 三份（technical-score-groups.json、score-directory-plan.json、leaf-allocation.json）随 8.7e2b 在评分模式下加入。
 */
export function outlineGenerationJsonSchemas(): Readonly<Record<string, unknown>> {
  return { [OUTLINE_OUTPUT_FILE]: OUTLINE_JSON_SCHEMA, [OUTLINE_REVIEW_FILE]: OUTLINE_REVIEW_SCHEMA };
}

/** 字数控制（与桌面版 normalizeWordControlOptions 的结果相同；服务端保存时已规范化为非负整数）。 */
export interface OutlineWordControl {
  minimumWords: number;
  maximumWords: number;
  sectionWords: number;
}

/** 与桌面版 deriveTargetLeafCount 相同：“AI 生成”叶子的目标数，没有设置字数时为 null。 */
export function deriveTargetLeafCount(options: OutlineWordControl): number | null {
  const sectionWords = options.sectionWords > 0 ? options.sectionWords : DEFAULT_ESTIMATED_SECTION_WORDS;
  if (options.minimumWords > 0 && options.maximumWords > 0) {
    return Math.ceil((options.minimumWords + options.maximumWords) / 2 / sectionWords);
  }
  if (options.maximumWords > 0) return Math.floor(options.maximumWords / sectionWords) - 2;
  if (options.minimumWords > 0) return Math.ceil(options.minimumWords / sectionWords) + 2;
  return null;
}

interface OutlineNodeLike {
  id?: unknown;
  title?: unknown;
  content_mode?: unknown;
  children?: readonly OutlineNodeLike[];
}

/** 与桌面版 countAiLeaves 相同。 */
export function countAiLeaves(items: readonly OutlineNodeLike[] | undefined): number {
  return (items ?? []).reduce(
    (total, item) => (Array.isArray(item?.children) && item.children.length ? total + countAiLeaves(item.children) : total + (item?.content_mode === AI_CONTENT_MODE ? 1 : 0)),
    0,
  );
}

/** 与桌面版 countLeavesByMode 相同。 */
export function countLeavesByMode(items: readonly OutlineNodeLike[] | undefined, counts: Record<string, number> = Object.fromEntries(OUTLINE_CONTENT_MODES.map((mode) => [mode, 0]))): Record<string, number> {
  for (const item of items ?? []) {
    if (Array.isArray(item?.children) && item.children.length) {
      countLeavesByMode(item.children, counts);
    } else if (OUTLINE_CONTENT_MODES.includes(item?.content_mode as string)) {
      counts[item.content_mode as string]! += 1;
    }
  }
  return counts;
}

/** 与桌面版 collectOutlineStructure 相同：目录层级、父节点与内容处理模式等确定性结构信息。 */
export function collectOutlineStructure(items: readonly OutlineNodeLike[] | undefined) {
  const result = {
    max_depth: 0,
    parent_count: 0,
    single_child_nodes: [] as { id: unknown; title: unknown; child_count: number }[],
    invalid_leaf_content_modes: [] as { id: unknown; title: unknown; content_mode: unknown }[],
  };
  const visit = (nodes: readonly OutlineNodeLike[] | undefined, depth: number) => {
    for (const item of nodes ?? []) {
      result.max_depth = Math.max(result.max_depth, depth);
      const children = Array.isArray(item?.children) ? item.children : [];
      if (children.length) {
        result.parent_count += 1;
        if (children.length < 2) result.single_child_nodes.push({ id: item.id, title: item.title, child_count: children.length });
        visit(children, depth + 1);
      } else if (!OUTLINE_CONTENT_MODES.includes(item?.content_mode as string)) {
        result.invalid_leaf_content_modes.push({ id: item.id, title: item.title, content_mode: item?.content_mode || '' });
      }
    }
  };
  visit(items, 1);
  return result;
}

/**
 * 与桌面版 buildOutlineReviewContext 相同：供目录审查直接采用的确定性检查结果（outline-review-context.json）。评分映射的检查
 * （score_mapping，桌面版 collectScoreMappingCoverage）只在评分模式下给出，随 8.7e2b。
 */
export function buildOutlineReviewContext(input: { outline: { outline: readonly OutlineNodeLike[] }; targetLeafCount: number | null }) {
  const items = input.outline?.outline || [];
  const { targetLeafCount } = input;
  const leafCounts = countLeavesByMode(items);
  const structure = collectOutlineStructure(items);
  const acceptableMin = targetLeafCount === null ? null : Math.max(1, targetLeafCount - 2);
  const acceptableMax = targetLeafCount === null ? null : targetLeafCount + 2;
  return {
    leaf_count: {
      target: targetLeafCount,
      current_ai_generate: leafCounts[AI_CONTENT_MODE],
      acceptable_min: acceptableMin,
      acceptable_max: acceptableMax,
      within_acceptable_range: targetLeafCount === null ? true : leafCounts[AI_CONTENT_MODE]! >= acceptableMin! && leafCounts[AI_CONTENT_MODE]! <= acceptableMax!,
      by_content_mode: leafCounts,
    },
    structure: {
      ...structure,
      valid: structure.max_depth <= 6 && structure.single_child_nodes.length === 0 && structure.invalid_leaf_content_modes.length === 0,
    },
  };
}

/** 与桌面版 createNoTechnicalScoreChildrenPrompt 相同：无技术评分项模式的子目录生成。 */
export function createNoTechnicalScoreChildrenPrompt(options: { targetLeafCount: number | null; standaloneTechnical: boolean; originalOnly?: boolean }): string {
  const { targetLeafCount, standaloneTechnical } = options;
  const originalOnly = options.originalOnly ?? false;
  const leafInstruction = targetLeafCount === null
    ? '本次未设置总字数目标，请根据项目复杂度自主确定合理的“AI生成”叶子节点数量。'
    : `最终完整目录合计应有约 ${targetLeafCount} 个 content_mode=ai-generate 的叶子节点。`;
  const scopeInstruction = standaloneTechnical
    ? '所有一级目录均属于技术文件，只生成技术方案正文相关的二级及以下目录。'
    : '只扩展 attr=技术 且 content_mode=ai-generate 的一级目录；其他一级目录保持原样，不得增加子目录。';
  return `用户已确认招标文件没有技术评分项，请直接根据确定的无技术评分项规则生成完整目录，不要判断是否存在评分项，也不要创建评分清单或评分映射。
${createOutputFileRequirements(CHILDREN_GENERATION_STAGE)}

请阅读 ${OUTLINE_OUTPUT_FILE}、${originalOnly ? '原方案.md' : '响应文件要求.md、项目概述.md，以及存在的原方案.md 和参考知识库目录'}，然后覆盖写回 ${OUTLINE_OUTPUT_FILE}。

要求：
1. ${scopeInstruction}
2. 一级目录的数量、顺序、id、title、description 和 attr 已由用户确认，必须保持不变；未扩展为父节点的一级目录还必须保留原 content_mode。
3. ${originalOnly ? ORIGINAL_ONLY_DIRECTORY_RULE : '优先采用资料中的明确要求，并根据项目类型、实施内容和专业逻辑组织技术方案目录；资料不足时可以用专业经验补充通用、合理的章节，但不得编造具体项目事实、参数、业绩或承诺。'}
4. ${leafInstruction}目录质量优先于机械凑数。
5. 每个最终叶子节点必须填写 content_mode：技术方案正文为 ai-generate；商务/资信和业绩材料为 template-fill；投标文件目录为 directory-generate；报价为 manual-fill；其他特殊内容为 other，并用 content_mode_note 说明。父节点不得包含 content_mode 或 content_mode_note。
6. 任意非叶子节点的 children 至少包含两个节点；目录最多六级，已有节点保留 id，新节点 id 填 null；number 是程序计算的显示编号。
7. title 只写正式、专业的纯标题，不包含章节编号或 Markdown 标记；避免重复、近义和空泛目录。
8. 程序已为 ${OUTLINE_OUTPUT_FILE} 预置 Schema，可用 json-validation 自查，只传 file_path；本阶段结束后程序统一校验，不通过会退回问题清单继续修复。`;
}

/** 评分规划文件（与桌面版 SCORE_DIRECTORY_PLAN_FILE 相同；评分模式的叶子调整提示词中引用，评分规划随 8.7e2b）。 */
const SCORE_DIRECTORY_PLAN_FILE = 'score-directory-plan.json';

/** 与桌面版 createLeafAdjustmentPrompt 相同：“AI 生成”叶子数与目标不同时请用户决定。 */
export function createLeafAdjustmentPrompt(targetLeafCount: number, actualLeafCount: number, options: { noTechnicalScoreMode?: boolean; originalOnly?: boolean } = {}): string {
  const noTechnicalScoreMode = options.noTechnicalScoreMode ?? false;
  const originalOnly = options.originalOnly ?? false;
  const adjustmentBoundary = noTechnicalScoreMode
    ? `2. 用户已确认采用无技术评分项模式。选择调整时，只能根据现有资料和专业逻辑调整技术目录，不得编造具体项目事实、参数、业绩或承诺。
3. 只通过合理调整 ai-generate 叶子的目录结构满足数量目标，不得为了凑数把 template-fill、directory-generate、manual-fill 或 other 改成 ai-generate，也不得改变非 AI 叶子的处理模式。
4. 调整后仍须保持完整根结构 {"outline":[一级目录节点]}，已有节点必须保留 id，新节点 id 填 null，number 由程序计算；用户已确认的一级目录不得修改；父节点只含 children，不含 content_mode，叶子节点只含 content_mode，不含 children。`
    : `2. 用户选择“允许 Agent 自行调整”或“自定义需求”时，必须继续遵循 ${SCORE_DIRECTORY_PLAN_FILE}：不得删除、移动或改变评分项对应节点的目标层级，不得新增未经批准的同层级大项；优先调整评分项节点下面的更深层目录。
3. 只通过合理调整 ai-generate 叶子的目录结构满足数量目标，不得为了凑数把 template-fill、directory-generate、manual-fill 或 other 改成 ai-generate，也不得改变非 AI 叶子的处理模式。
4. 调整后仍须保持完整根结构 {"outline":[一级目录节点]}，已有节点必须保留 id，新节点 id 填 null，number 由程序计算；技术一级目录的 id 必须与 ${SCORE_DIRECTORY_PLAN_FILE} 中对应的 root_id 一致，不能因增删、移动或重新编号而改变；父节点只含 children，不含 content_mode，叶子节点只含 content_mode，不含 children。`;
  return `程序计算当前完整目录共有 ${actualLeafCount} 个“AI生成”叶子节点，目标是 ${targetLeafCount} 个。
${createOutputFileRequirements(LEAF_ADJUSTMENT_STAGE)}

请先调用一次 ask-user，说明目标数、当前数、差距及目录质量影响，只能按以下顺序提供三个固定选项，不得改名、增删或调整顺序：
1. “接受当前结果”，custom=false：保持当前目录并进入最终审核。
2. “允许 Agent 自行调整”，custom=false：由你在不破坏目录质量的前提下合理调整一次。
3. “自定义需求”，custom=true：按用户填写的具体要求调整。

根据本轮 ask-user 回答处理：
1. 用户选择“接受当前结果”时，不要修改 ${OUTLINE_OUTPUT_FILE}。
${adjustmentBoundary}
${noTechnicalScoreMode && originalOnly ? ORIGINAL_ONLY_DIRECTORY_RULE : ''}
5. 不要机械增加重复、空泛或近义目录。程序已为 ${OUTLINE_OUTPUT_FILE} 预置 Schema，可用 json-validation 自查，只传 file_path；本阶段结束后程序统一校验，不通过会退回问题清单继续修复。`;
}

/** 与桌面版 createNoTechnicalScoreReviewPrompt 相同：无技术评分项模式的目录审查（本阶段材料附在提示词后）。 */
export function createNoTechnicalScoreReviewPrompt(options: { targetLeafCount: number | null; actualLeafCount: number; originalOnly?: boolean; inputFiles: readonly AgentInputFile[] }): string {
  const { targetLeafCount, actualLeafCount, inputFiles } = options;
  const originalOnly = options.originalOnly ?? false;
  const leafCountReview = targetLeafCount === null
    ? ''
    : `\n- “AI生成”叶子数量：程序计算目标为 ${targetLeafCount} 个，当前为 ${actualLeafCount} 个，可接受范围为 ${Math.max(1, targetLeafCount - 2)} 至 ${targetLeafCount + 2} 个。`;
  return `请对当前无技术评分项模式生成的完整技术方案目录执行最终审核，并在用户确认后完成必要修复。
${createOutputFileRequirements(OUTLINE_REVIEW_STAGE)}

以下已提供本阶段最新完整材料。${OUTLINE_REVIEW_CONTEXT_FILE} 是宿主程序计算的确定性审核结果，直接采用其中的叶子数量和结构检查。优先使用本次已提供的最新材料和程序计算结果，通常无需重复读取或重新统计。需要确认具体节点、补足上下文或排查结果异常时，可使用 grep、read 或 bash 定位相关部分；已有结果足以判断时直接继续审核。用户已确认招标文件没有技术评分项，不要判断、补造或检查评分项。

审核维度：${leafCountReview}
- 重复目录：检查子目录中是否存在重复、近义或含义重叠的节点。
${originalOnly
    ? `- 来源与完整性：根据下附原方案.md，核对目录是否忠实覆盖原方案中的章节。${ORIGINAL_ONLY_DIRECTORY_RULE}不得以缺少通用技术主题为由新增目录。`
    : '- 专业合理性：检查目录是否覆盖项目实施所需的通用技术主题，层级、颗粒度、逻辑顺序、标题和内容处理模式是否适合正式投标文件。\n- 事实边界：专业经验只能补充通用目录结构，不得编造具体项目事实、参数、业绩或承诺。'}

审核与修复流程：
1. 必须先完整审核并形成问题清单，不得边审核边修改。
2. 没有问题时不要修改 ${OUTLINE_OUTPUT_FILE}；写入 ${OUTLINE_REVIEW_FILE}，status=passed、issues=[]、user_feedback=""。
3. 仅标题专业化和明显重复子目录合并可静默修复并设置 status=simple_fix；一级目录调整、增加或拆分目录、明显结构重排和叶子数量超出合理范围必须先集中调用一次 ask-user。
4. 用户要求修改时设置 status=user_feedback；用户要求保留现状时不修改目录并设置 status=user_refuse。修改完成后不得再次询问。
5. 用户已确认的一级目录数量、顺序、标题、描述和属性不得修改。所有叶子保留合法 content_mode，父节点至少有两个 children，目录最多六级，id 与实际父子位置一致。
6. issues 的 category 只能使用 leaf-count、duplicate-directory 或 professional-structure。最终将完整问题清单和处理结果写入 ${OUTLINE_REVIEW_FILE}。
7. 程序已为 ${OUTLINE_OUTPUT_FILE} 和 ${OUTLINE_REVIEW_FILE} 预置 Schema，可用 json-validation 自查，只传 file_path；本阶段结束后程序统一校验两份文件，不通过会退回问题清单继续修复。未修改 ${OUTLINE_OUTPUT_FILE} 时不要为了校验而重写目录。

本阶段输入材料：
${inputFiles.map((file) => `【文件开始：${file.path}】\n${file.content}\n【文件结束：${file.path}】`).join('\n\n')}`;
}

/** 目录审查的结果（outline-review.json，与桌面版 OUTLINE_REVIEW_SCHEMA 相同的形状）。内容是 AI 生成的，只用于选择任务日志。 */
export interface OutlineReview {
  status: 'passed' | 'simple_fix' | 'user_feedback' | 'user_refuse';
  [key: string]: unknown;
}

/** 与桌面版 validateJsonOutput 相同（Web 版与 8.7a 相同不附解析器的错误信息）：空文件、不是合法 JSON、不符合 Schema 为阻塞问题。 */
function validateJsonFile<V>(content: string, file: string, validate: { (value: unknown): boolean; errors?: ErrorObject[] | null }): { value: V | null; issues: AgentSubmissionIssue[] } {
  const text = String(content || '').trim();
  if (!text) return { value: null, issues: [blocking(`${file} 未写入或内容为空，请写入完整的 JSON`)] };
  let generated: unknown;
  try {
    generated = JSON.parse(text);
  } catch {
    return { value: null, issues: [blocking(`${file}不是合法 JSON`)] };
  }
  if (!validate(generated)) {
    const issues = schemaIssues(validate.errors ?? [], file);
    const kept = issues.length > AGENT_SUBMISSION_MAX_ISSUES ? [...issues.slice(0, AGENT_SUBMISSION_MAX_ISSUES - 1), blocking(`${file} 另有 ${issues.length - AGENT_SUBMISSION_MAX_ISSUES + 1} 个问题`)] : issues;
    return { value: null, issues: kept };
  }
  return { value: generated as V, issues: [] };
}

/**
 * 目录审查阶段的提交校验（与桌面版 validateStageOutputs 的 outline_review 相同）：outline.json 按 validateOutlineOutput（Schema、
 * 节点 id 只能沿用审查前目录的），outline-review.json 按 OUTLINE_REVIEW_SCHEMA；两份文件的问题合在一起（至多
 * AGENT_SUBMISSION_MAX_ISSUES 条）。content 为文件内容（来自沙箱）。
 */
export function validateOutlineReviewOutputs(
  outlineContent: string,
  reviewContent: string,
  knownIds: ReadonlySet<string>,
): { value: { outline: { outline: AcceptedOutlineItem[] }; review: OutlineReview } | null; issues: AgentSubmissionIssue[] } {
  const outline = validateOutlineOutput(outlineContent, knownIds);
  const review = validateJsonFile<OutlineReview>(reviewContent, OUTLINE_REVIEW_FILE, validateOutlineReviewSchema);
  const issues = [...outline.issues, ...review.issues];
  if (issues.length) return { value: null, issues: issues.slice(0, AGENT_SUBMISSION_MAX_ISSUES) };
  return { value: { outline: outline.value!, review: review.value! }, issues: [] };
}

/** 与桌面版目录审查完成后的日志相同（按 outline-review.json 的 status）。 */
export function outlineReviewMessage(review: OutlineReview): string {
  return review.status === 'passed'
    ? '目录审核通过'
    : review.status === 'simple_fix'
      ? '目录审核完成，Agent 已自动微调简单问题'
      : review.status === 'user_feedback'
        ? '目录审核完成，已按用户反馈修复'
        : '目录审核完成，用户选择保留当前目录';
}
