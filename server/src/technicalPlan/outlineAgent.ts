// 技术方案目录的 Agent 材料、提示词与提交校验（路线图第 8 步 8.7d 目录调整）：与桌面版 client/electron/services/outlineAdjustmentTask.cjs
// （buildAgentOutlineInput、createOutlineAdjustmentPrompt）、outlineGenerationTaskV2.cjs（OUTLINE_OUTPUT_FILE、OUTLINE_JSON_SCHEMA、
// validateJsonOutput、validateOutlineOutput、buildFinalOutline）与 technicalPlanOutline.cjs（NODE_ID_PATTERN、collectOutlineIds、
// acceptAgentOutline）相同（tests/technicalPlan/outlineAdjustmentJob.test.ts 加载桌面版逐项对照）。8.7e 的目录生成沿用本模块。
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
const OUTLINE_ATTRIBUTES = ['通用', '商务/资信', '技术', '其他', '目录', '报价', '业绩'];
const CONTENT_MODES = ['ai-generate', 'template-fill', 'directory-generate', 'manual-fill', 'other'];
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
      content_mode: { type: 'string', enum: CONTENT_MODES },
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

function schemaIssues(errors: readonly ErrorObject[]): AgentSubmissionIssue[] {
  return errors.map((item) => blocking(`${OUTLINE_OUTPUT_FILE} 不符合结构要求：${item.instancePath || '/'} ${item.message}`));
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
