// 可研报告目录生成的 Agent 材料与结果整理（路线图第 8 步 8.7a）：与桌面版 client/electron/services/feasibilityOutlineTask.cjs
// 的提示词、预置 Schema、工作区材料与目录整理相同（tests/feasibilityReport/outlineJob.test.ts 加载桌面版逐项对照）。
//
// 结果文件 outline.json 由沙箱中的 Agent 写出，按不可信数据处理：只取 title、description、knowledge_item_ids、children 并转成字符串，
// 最多三级，层级与同级数量按桌面版截短（一级 16 个、其余每级 20 个），knowledge_item_ids 只保留本次提供的知识库条目 id。
// 节点 id 由程序按位置分配（1、1.1、1.1.1），不采用 Agent 写出的 id。
import type { FeasibilityProjectInfo, FeasibilityOutlineItem } from './store.ts';
import { formatProjectInfo, type LightweightKnowledgeItem } from './prompts.ts';
import { buildOutlineTemplateMarkdown } from './outlineTemplates.ts';

/** 结果文件（与桌面版 OUTLINE_OUTPUT_FILE 相同）。 */
export const FEASIBILITY_OUTLINE_OUTPUT_FILE = 'outline.json';

const TITLE_PREFIX_PATTERN = /^第?[一二三四五六七八九十百零〇\d.、\s]+[章节篇]?\s*/;
const UNTITLED = '未命名章节';

function createOutlineNodeSchema(level: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    id: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    knowledge_item_ids: {
      type: 'array',
      items: { type: 'string' },
    },
  };
  if (level < 3) {
    properties.children = {
      type: 'array',
      minItems: 1,
      items: createOutlineNodeSchema(level + 1),
    };
  }
  return {
    type: 'object',
    required: ['title', 'description'],
    additionalProperties: false,
    properties,
  };
}

/** json-validation 为 outline.json 预置的 Schema（与桌面版 OUTLINE_JSON_SCHEMA 相同）。 */
export const FEASIBILITY_OUTLINE_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['outline'],
  additionalProperties: false,
  properties: {
    outline: {
      type: 'array',
      minItems: 1,
      items: createOutlineNodeSchema(1),
    },
  },
};

interface RawOutlineItem {
  title: string;
  description: string;
  knowledge_item_ids?: string[];
  children?: RawOutlineItem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const text = (value: unknown): string => String(value || '');

/** 与桌面版 normalizeOutline 相同：去掉标题中的章节编号，只保留叶子节点中本次提供的知识库条目 id，丢弃完全空白的项。 */
function normalizeOutline(items: unknown, allowedKnowledgeIds: ReadonlySet<string>, level = 1): RawOutlineItem[] {
  if (!Array.isArray(items) || level > 3) return [];
  return items
    .map((value: unknown) => {
      const item = isRecord(value) ? value : {};
      const title = text(item.title).replace(TITLE_PREFIX_PATTERN, '').trim();
      const children = normalizeOutline(item.children, allowedKnowledgeIds, level + 1);
      const rawIds = item.knowledge_item_ids;
      const knowledgeItemIds =
        !children.length && Array.isArray(rawIds)
          ? [...new Set(rawIds.map((id: unknown) => text(id).trim()).filter((id) => allowedKnowledgeIds.has(id)))]
          : [];
      return {
        title: title || UNTITLED,
        description: text(item.description).trim(),
        ...(knowledgeItemIds.length ? { knowledge_item_ids: knowledgeItemIds } : {}),
        ...(children.length ? { children } : {}),
      };
    })
    .filter((item) => (item.title && item.title !== UNTITLED) || item.description.trim() || item.children?.length);
}

/** 与桌面版 trimToThreeLevels 相同。 */
function trimToThreeLevels(items: readonly RawOutlineItem[], level = 1): RawOutlineItem[] {
  return items.map((item) => {
    if (level >= 3 || !item.children?.length) {
      const { children: _children, ...leaf } = item;
      return leaf;
    }
    return { ...item, children: trimToThreeLevels(item.children, level + 1) };
  });
}

/** 与桌面版 assignOutlineIds 相同：按位置编号，一级最多 16 个、其余每级最多 20 个。 */
function assignOutlineIds(items: readonly RawOutlineItem[], prefix = ''): FeasibilityOutlineItem[] {
  return items
    .map((item, index) => {
      const id = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
      const children = item.children?.length ? assignOutlineIds(item.children, id) : undefined;
      const knowledgeItemIds = Array.isArray(item.knowledge_item_ids)
        ? [...new Set(item.knowledge_item_ids.map((value) => text(value).trim()).filter(Boolean))]
        : [];
      return {
        id,
        title: text(item.title || UNTITLED).trim() || UNTITLED,
        description: text(item.description).trim(),
        ...(!children && knowledgeItemIds.length ? { knowledge_item_ids: knowledgeItemIds } : {}),
        ...(children ? { children } : {}),
      };
    })
    .slice(0, prefix ? 20 : 16);
}

/** 结果不可用（不是合法 JSON、没有可用目录）时的固定说明：不含 Agent 写出的内容。 */
export class FeasibilityOutlineResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeasibilityOutlineResultError';
  }
}

/**
 * 与桌面版 readJson + finalizeOutline 相同：解析 outline.json 并整理成目录。不是合法 JSON 时说明为“outline.json不是合法 JSON”
 * （桌面版另附解析器的错误信息，其中可能摘录文件内容，这里不附），没有可用目录时为“模型未返回可用目录”。
 */
export function finalizeFeasibilityOutline(content: string, allowedKnowledgeIds: ReadonlySet<string>): FeasibilityOutlineItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(String(content || '').trim());
  } catch {
    throw new FeasibilityOutlineResultError(`${FEASIBILITY_OUTLINE_OUTPUT_FILE}不是合法 JSON`);
  }
  const outline = assignOutlineIds(trimToThreeLevels(normalizeOutline(isRecord(raw) ? raw.outline : undefined, allowedKnowledgeIds)));
  if (!outline.length) throw new FeasibilityOutlineResultError('模型未返回可用目录');
  return outline;
}

/** 目录的节点总数。 */
export function countOutlineNodes(items: readonly FeasibilityOutlineItem[] | undefined): number {
  let total = 0;
  for (const item of items ?? []) total += 1 + countOutlineNodes(item.children);
  return total;
}

function formatKnowledgeCatalog(items: readonly LightweightKnowledgeItem[]): string {
  if (!items.length) return '未选择知识库';
  return JSON.stringify(items, null, 2);
}

/** 与桌面版 buildFileCatalog 相同。 */
function buildFileCatalog(hasKnowledge: boolean): string {
  const lines = [
    '- 项目参数.md：用户填写的项目基础参数，用于确定目录口径；缺项按【待补充】理解，不要编造。',
    '- 资料分析.md：STEP 03 已提取的九板块事实，是细化二三级目录的主要依据。',
    '- 大纲模板.md：选用的通用大纲，含一级章节及作为细化起点的二级标题。',
  ];
  if (hasKnowledge) {
    lines.push('- 参考知识库.md：轻量条目清单（id、标题、简介）。叶子节点 knowledge_item_ids 只能从这些 id 中选择。');
  }
  lines.push('- 材料说明.md：本次实际提供的文件清单，与上述用途一致。');
  return lines.join('\n');
}

/** 与桌面版 createFeasibilityOutlinePrompt 相同。 */
function createFeasibilityOutlinePrompt(fileCatalog: string, hasKnowledge: boolean, targetWords: number): string {
  return `请只在当前工作目录内工作。已有材料足以判断时自主执行，不要调用 ask-user。

任务：在给定大纲框架内形成完整、可执行、可编辑的三级以内可行性研究报告目录，写入 ${FEASIBILITY_OUTLINE_OUTPUT_FILE}。

材料用途：
${fileCatalog}

工作原则：
1. 你是可行性研究报告总编。一级目录原则上保留通用大纲主框架，可根据项目明显不适用的内容合并或调整，但不得遗漏结论、风险、影响和投资相关内容。
2. 二、三级目录必须结合本项目资料具体化，避免只有空泛通用标题。大纲模板中的二级标题是细化起点，应写入目录后再按资料具体化。
3. description 写明本节应论证的重点、已知资料和缺失资料处理要求。
4. 只能在叶子节点填写 knowledge_item_ids，只能从参考知识库 id 中选择，可以为空数组。不要输出正文 content，不要编造项目事实。
5. 目录最多三级。title 只写纯标题，不要带章节编号或 Markdown 标记。
6. 目标总字数约 ${Number(targetWords) || 30000} 字，叶子章节的 description 应能支撑后续按该总量分配写作。
${hasKnowledge ? '7. 用参考知识库补充已有章节的写作重点，不要仅因知识库出现新话题就新增一级章。' : ''}

输出：
1. 只写入 ${FEASIBILITY_OUTLINE_OUTPUT_FILE}，必须是纯 JSON，不要 Markdown 代码块。
2. 根对象只有 outline；每项包含 title、description，非叶子项再包含 children；叶子可包含 knowledge_item_ids。
3. 程序已为该文件预置 Schema。写入后调用 json-validation，只传 {"file_path":"${FEASIBILITY_OUTLINE_OUTPUT_FILE}"}；失败则先改文件再校验，直到通过。

格式示意：
{
  "outline": [
    {
      "title": "概述",
      "description": "本章说明",
      "children": [
        {
          "title": "项目概况",
          "description": "本节写作重点",
          "knowledge_item_ids": ["documentId::itemId"]
        }
      ]
    }
  ]
}`;
}

export interface FeasibilityOutlineInputState {
  projectInfo: FeasibilityProjectInfo;
  analysisMarkdown: string;
  outlineTemplate: string;
  targetWords: number;
}

export interface FeasibilityOutlineAgentInput {
  /** 放入工作区的材料（受保护文件，与桌面版 files 相同的顺序与内容）。 */
  files: { path: string; content: string }[];
  prompt: string;
}

/** 与桌面版 runFeasibilityOutlineTask 相同的工作区材料与提示词。 */
export function buildFeasibilityOutlineAgentInput(state: FeasibilityOutlineInputState, knowledgeItems: readonly LightweightKnowledgeItem[]): FeasibilityOutlineAgentInput {
  const hasKnowledge = knowledgeItems.length > 0;
  const files = [
    { path: '项目参数.md', content: formatProjectInfo(state.projectInfo) },
    { path: '资料分析.md', content: String(state.analysisMarkdown || '').trim() || '资料未提供。' },
    { path: '大纲模板.md', content: buildOutlineTemplateMarkdown(state.outlineTemplate, state.targetWords) },
  ];
  if (hasKnowledge) files.push({ path: '参考知识库.md', content: formatKnowledgeCatalog(knowledgeItems) });
  const fileCatalog = buildFileCatalog(hasKnowledge);
  files.push({ path: '材料说明.md', content: `本次任务实际提供的材料如下。只使用这些文件，不要猜测未提供的材料。\n\n${fileCatalog}` });
  return { files, prompt: createFeasibilityOutlinePrompt(fileCatalog, hasKnowledge, state.targetWords) };
}
