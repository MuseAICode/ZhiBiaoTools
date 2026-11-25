// 技术方案正文生成的正文写作阶段的输入（路线图第 8 步 8.10c1；docs/SERVER_DESIGN.md 第 7.42 节），取代桌面版 contentGenerationAgent.cjs 的
// buildContentGenerationFiles、buildRunSummary、buildContentGenerationPrompt 与 contentGenerationTaskFiles.cjs 的任务文件 Schema：
// - 材料（正文完整目录.json、项目概述.md、正文编排决策.json、受限HTML生成规范.md、配图类型对照表.md、正文模板.html、所选模板配置.json、
//   全局事实设定.md、知识库/*.md 与 知识库/索引.json）与桌面版逐字相同，只读已保存的编排，不重新分配字数、表格或配图；
// - 执行摘要与写作要求（字数、事实缺失、写作规则、配图要求与本轮布局名额）与桌面版相同；
// - 写作阶段的提示词（含目录变更后局部生成的前缀）与桌面版相同，其中提到的业务工具（generate-sections、配图工具、check-word-count、
//   提交问题修复）随 8.10c2～8.10e 接入；
// - 原方案还原的底稿（restored_content、已还原内容/*.md、restoration_requirements）属 8.11，本步不放入；
// - 与桌面版的差异：知识库索引中的文档只给出 id、文件名、状态与条目数（桌面版是整条本机记录，含本机路径）；所选模板配置.json 的
//   template_id 是 export_templates.id。
// 本模块只生成文字，不读写数据库与工作区；材料由 store.ts 的 readContentWritingSources 读取。
import { JobError } from '../jobs/definitions.ts';
import type { TechnicalPlanGlobalFactsMode } from '../db/schema.ts';
import { AI_IMAGE_STYLES } from './aiImageStyles.ts';
import type { ContentPlan, ContentWordControl, LeafContext, StoredContentPlan } from './contentPlanning.ts';
import { CONTENT_HTML_RULES, CONTENT_IMAGE_TYPES, CONTENT_TEMPLATE_HTML } from './contentWritingResources.ts';
import { allocateImageLayoutGroups, resolveImageLayoutShares, type ImageLayoutShares } from './imageLayout.ts';
import type { TechnicalPlanOutlineItem } from './outline.ts';
import type { ContentGenerationOptions } from './store.ts';

/** 写作阶段的材料（与桌面版 INPUT_FILES 相同）。 */
export const CONTENT_WRITING_INPUT_FILES = Object.freeze({
  overview: '项目概述.md',
  decisions: '正文编排决策.json',
  outline: '正文完整目录.json',
  rules: '受限HTML生成规范.md',
  imageTypes: '配图类型对照表.md',
  template: '正文模板.html',
  config: '所选模板配置.json',
  facts: '全局事实设定.md',
});
export const CONTENT_WRITING_KNOWLEDGE_INDEX_FILE = '知识库/索引.json';
/** 写作阶段的结果清单（与桌面版 RESULT_FILE 相同）。 */
export const CONTENT_RESULT_FILE = '正文生成结果.json';
export const CONTENT_WRITING_STAGE = 'generating';

/** 结果清单的预置 Schema（与桌面版 RESULT_SCHEMA 相同）。 */
export const CONTENT_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section_id', 'file', 'words'],
        properties: { section_id: { type: 'string' }, file: { type: 'string' }, words: { type: 'integer', minimum: 1 } },
      },
    },
  },
} as const;

// ---- 任务文件（与桌面版 contentGenerationTaskFiles.cjs 相同） ----

const TASK_DIR = '任务';
const TASK_FILES = {
  sections: '正文生成.json',
  images: '配图生成.json',
  renderHtml: 'HTML转图.json',
  renderMermaid: 'Mermaid转图.json',
  applyImages: '图片回填.json',
  repair: '一致性修复.json',
} as const;
export type ContentTaskFileKey = keyof typeof TASK_FILES;
export const TASK_FILE_WRITING = '写完再调用对应工具提交。';
/** 提交问题修复子任务的工具名与改由它并发修复的小节数（与桌面版 contentGenerationEditTools.cjs 相同，工具随 8.10c3）。 */
export const SUBMISSION_FIX_TOOL = 'fix-submission-issues';
export const SUBMISSION_FIX_PARALLEL_THRESHOLD = 5;

export function taskFilePath(key: ContentTaskFileKey): string {
  return `${TASK_DIR}/${TASK_FILES[key]}`;
}

const text = { type: 'string' };
const id = { type: 'string', minLength: 1 };
const regenerate = { type: 'boolean' };
const frameSize = { enum: ['square', 'wide', 'tall', 'panorama'] };
const aiSize = { type: 'string', pattern: '\\S' };
const aiStyle = { enum: Object.keys(AI_IMAGE_STYLES) };
const list = (key: string, items: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: [key],
  properties: { [key]: { type: 'array', minItems: 1, items } },
});
const object = (required: Record<string, unknown>, optional: Record<string, unknown> = {}) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(required),
  properties: { ...required, ...optional },
});
// 按生成方式补充必填项；then 中重复声明属性以满足 Ajv 严格模式。
const imageItem = {
  ...object({ image_id: id, kind: { enum: ['ai', 'html', 'mermaid'] }, prompt: { type: 'string', minLength: 1 } }, { size: aiSize, title: text, style: aiStyle, frame_size: frameSize, regenerate }),
  allOf: [
    { if: { properties: { kind: { const: 'ai' } } }, then: { properties: { size: aiSize, style: aiStyle }, required: ['size', 'style'] } },
    { if: { properties: { kind: { const: 'html' } } }, then: { properties: { frame_size: frameSize }, required: ['frame_size'] } },
  ],
};
/** 任务文件的 Schema（结构与桌面版工具参数一致；完整性由工具提交时按业务规则检查）。 */
export const CONTENT_TASK_FILE_SCHEMAS: Readonly<Record<ContentTaskFileKey, Record<string, unknown>>> = {
  sections: list('sections', object({ section_id: id, instructions: text, references: text }, { regenerate })),
  images: list('images', imageItem),
  renderHtml: list('images', object({ image_id: id, source_file: id, frame_size: frameSize }, { regenerate })),
  renderMermaid: list('images', object({ image_id: id, source_file: id }, { regenerate })),
  applyImages: list('images', object({ image_id: id, asset_ref: id, previous_asset_ref: text })),
  repair: object({ sections: list('sections', object({ section_id: id, instructions: text })).properties.sections }, { rules: text }),
};

/** 供 Agent 用 json-validation 自查（与桌面版 taskFileSchemas() 相同：主任务登记全部任务文件）。 */
export function contentTaskFileSchemas(): Record<string, Record<string, unknown>> {
  return Object.fromEntries((Object.keys(TASK_FILES) as ContentTaskFileKey[]).map((key) => [taskFilePath(key), CONTENT_TASK_FILE_SCHEMAS[key]]));
}

// ---- 写作要求（与桌面版相同） ----

/** 小节文件名由目录 ID 确定（与桌面版 sectionFile 相同）。 */
export function contentSectionFile(id: string): string {
  return `正文/${encodeURIComponent(id)}.html`;
}

/** 每个写作模型只承担本节目标；全文字数由主会话统一统计（与桌面版 wordInstructions 相同）。 */
export function wordInstructions(control: ContentWordControl, checkTotalWords: boolean): string {
  return `全文最少字数：${control.minimumWords || '不限制'}；全文最多字数：${control.maximumWords || '不限制'}。\n每节按 content_plan.target_words 指定的目标字数安排篇幅，0 表示不设目标；尽量接近目标，不为凑字数重复表达或删除必要信息。目标已经在编排阶段分配，不再自行分摊全文目标，也不让单个小节承担全文目标。${checkTotalWords ? '本轮全部目标生成完成后，由主 Agent 统一检查总字数。' : '本次仅统计目标小节字数，不承担全文字数达标。'}字数统计不含 HTML 标签及配图提示词。`;
}

/** 当前事实模式的中文要求（与桌面版 globalFactsInstructions 相同）。 */
export function globalFactsInstructions(mode: TechnicalPlanGlobalFactsMode): string {
  const requirement = mode === 'placeholder'
    ? '事实缺失处理方式：保留正文中需要说明的事项；核对相关参考材料后仍无法确定的具体事实，以“【待填写】”标记。已有占位符保持原样，不自行补入具体值。'
    : mode === 'omit'
      ? '事实缺失处理方式：保留必要事项，并采用不依赖未知具体值的概括性表述。未经参考材料提供，不得补入具体人员、时间、地点、业绩、证书或规格型号。'
      : '事实缺失处理方式：核对相关参考材料后仍缺少必要信息时，允许结合项目背景补充设定。新增设定应符合项目语境，并在各小节中保持一致。';
  return `${requirement} 补充事实前，应先核对相关参考材料和全局事实设定。只有未找到明确依据时，才适用当前事实缺失处理方式；材料与全局事实冲突时，以全局事实为准。允许补充设定只适用于缺失信息，不得覆盖或改变全局事实。禁止生成没有实际依据的引用。`;
}

/** 正文写作共用规则（与桌面版 writingInstructions 相同）。 */
export function writingInstructions(hasKnowledgeBase: boolean): string {
  return `根据项目背景、章节描述和编排重点编写投标正文。明确说明与本节相关的实施措施、执行条件、责任分工或交付成果。内容应准确、具体、可执行，使用正式、简洁的书面语言，避免宣传性表述、缺少具体内容的概括和重复表达。\n使用参考资料时，应将适用内容整理为当前项目的方案表述，不在正文中提及${hasKnowledgeBase ? '知识库、' : ''}历史文档或素材来源。全局事实设定用于统一项目事实口径，不是本节必须逐项覆盖的写作清单。本节内容范围以标题、章节描述和编排重点为准。仅在说明本节内容确有需要时使用相关事实，不为覆盖全局事实增加无关段落，也不在各节重复罗列项目概况、人员、设备或制度。写作内容和全局事实不冲突即可，不要求完全引用全局事实。全局事实未明确的信息，按本次事实缺失处理要求执行。\n只输出受限 HTML 正文，不输出 Markdown、代码围栏、外层章节标题或解释。除 img 等空元素外，每个元素都写出对应的结束标签；每个 figure 以 </figure> 结束并直接包含一个 img，figure 不放在段落、列表项或加粗、链接等行内元素中。篇幅较长时也要先保证 HTML 结构完整。内部层次用普通段落、列表或无编号加粗引导语；有序列表仅用于步骤、流程和时间顺序。\n正文禁止使用 LaTeX 语法，包括 $...$、$$...$$、\\(...\\)、\\[...\\] 及 \\frac、\\text、\\circ 等命令。公式、参数和单位使用普通文字、Unicode 数学符号及受限 HTML 的 <sup>、<sub> 表达，例如 22 ℃ ± 2 ℃、40%～65%、≥30 m<sup>3</sup>/(h·人)。参考材料中的 LaTeX 在写入正文时也须转换为上述表达，保持数值、单位和含义不变。`;
}

export type ContentImageOptions = Pick<
  ContentGenerationOptions,
  'imageQuantity' | 'useAiImages' | 'useHtmlImages' | 'useMermaidImages' | 'htmlImageTypes' | 'useSingleImageLayout' | 'useImageTextLayout' | 'useThreeImagesLayout' | 'useFourImagesLayout'
>;

/** 共用配图规则（与桌面版 imageInstructions 相同）。 */
export function imageInstructions(options: ContentImageOptions): string {
  const mode = options.imageQuantity > 0
    ? '配图：按本轮布局名额安排各类图片，名额为零的布局不使用。'
    : '无图：不安排配图、不留图片占位、不调用配图工具。';
  const aiPreference = options.imageQuantity > 0 && options.useAiImages
    ? '本轮批量生成的新增配图以 AI 生成为主，AI 图片目标占比为 60%。主 Agent 在并发写作前统筹本轮目标，不要求每个小节分别达到该比例；并发写作模型只执行本节分配，不独立承担占比目标。优先从正文中寻找适合实物、场景、效果、物理结构、工艺、操作等可视化表达的主题，再按配图类型对照表确定生成方式。需要准确表达流程、逻辑或数据时继续使用对照表规定的 HTML/Mermaid，不将这些图强行改为 AI 图片。占比按实际新增图片张数计算：单张图片和图片表格各 1 张，三列图片 3 张，四宫格 4 张；原方案图片不计入分子或分母，即使格式属性为 aiImage，也不视为本轮 AI 生图。60% 是整体规划目标，不是上限，不要求精确命中；保持布局名额，不额外加图凑比例。暂停重试沿用本轮安排，已完成的新图计入本轮统计；局部生成只统计本轮新增图片，单节修改不追补全文比例。'
    : '本轮不应用 AI 图片占比目标，按已开启的生成方式及配图类型对照表安排图片；无图时不新增配图。';
  // 画面差异化只约束 AI 图片画什么、怎么画，不改变数量、占比和布局名额。
  const aiDiversity = options.imageQuantity > 0 && options.useAiImages
    ? `\nAI 图片画面差异化：每张新增 AI 图片确定画面类型（配图类型对照表中的 AI 类型）、主体、视角景别（特写、中景、全景、鸟瞰、轴测、剖切等）和画面形式。画面形式可选：${Object.values(AI_IMAGE_STYLES).map(({ label, usage }) => `${label}（${usage}）`).join('、')}。全文 AI 图片在画面类型、主体、视角景别和画面形式上分散，避免多数图片都表现人员在工位或现场作业；管理、值守、协同类内容可改为表现设备实物、系统构成、空间全貌、作业对象细节或成果状态，相邻小节不重复相同组合。图组内的 AI 图片围绕共同主题，至少在主体或视角景别上明显不同；按步骤拆分时同时变换景别和主体，例如作业全景、部件特写、终端或仪表特写、完成状态，不能同一场景同一构图只换动作。同一图组使用同一画面形式，全文按内容选用多种画面形式。AI 图片提示词按主体、可见元素、视角景别与构图、环境光线正向描述画面，写出区分本图的具体视觉元素；不虚构的范围是数值、型号、品牌、单位名称和可读文字，设备外形、材质、空间、光线等示意性细节应具体描述，不堆叠否定约束。`
    : '';
  return `${mode}\n允许使用的类型：AI 图片（aiImage）${options.useAiImages ? '允许' : '不允许'}；HTML 图片（htmlImage）${options.useHtmlImages ? '允许' : '不允许'}；Mermaid 图片（mermaid）${options.useMermaidImages ? '允许' : '不允许'}。无图要求优先于类型开关；有图模式下仅使用允许的类型，三类均不允许时不安排配图或占位。\nHTML 图片允许的类型：${options.htmlImageTypes}。\nimage_needed 表示本节是否进入新增配图范围：为 false 时不新增图片；为 true 时可承接主 Agent 分配的布局。image_suitability_score 为 0～10 分的配图适配评分，用于选择更合适的布局承接小节，不用于取消本轮名额。不要求每个入选小节恰好一组，不设每节图片张数上限。\n批量生成时，主 Agent 按 image_layout_quota 完成本轮新增布局分配；并发写作模型只执行本节配图安排中的布局、组数、表达目的和生成方式，不自行改变生成方式，不自行承担或重新分配全局名额，未分配布局时不新增配图。single 为单张图片，图片本身应能表达意图；imageText 为左图右文，右侧文字解释左侧图片，仅含一张图。两者分别按分配组数执行，不互换名额。threeImages 为三列图片，fourImages 为四宫格，分别按分配组数执行，不自行拆成单张。组内图片围绕共同主题表达不同信息，避免重复。布局名额仅用于本轮批量生成，后续单节修改按用户要求执行，不重新分配全文名额。图片类型开关定义允许使用的生成方式，AI 占比目标用于本轮整体配图规划，各小节及全文均无须覆盖全部已开启类型。\n${aiPreference}${aiDiversity}\n根据新增图片要表达的内容和结构查阅配图类型对照表.md。未找到对应类型时，优先采用用途、结构相近类型所对应的生成方式；仍无法归类时，使用 AI 生图。始终遵守用户的图片类型开关设置：对照表仅用于确定生成方式，不代表该方式已获允许；无图模式下不新增图片；对应生成方式被关闭时，不生成该图，也不因该方式被关闭而改用其他方式。上述规则仅用于新增图片；已有原图按提供的对应关系复用，不受无图、类型开关或新增布局名额限制。`;
}

export interface ImageLayoutQuota extends ImageLayoutShares {
  readonly total_groups: number;
}

/** 按本轮可配图目标分配布局组数（与桌面版 buildImageLayoutQuota 相同）；用户关闭的布局份额已在共享公式中均分，全部关闭时等同无图。 */
export function buildImageLayoutQuota(sections: readonly { content_plan?: Partial<ContentPlan> | undefined }[], options: ContentImageOptions): ImageLayoutQuota {
  const shares = resolveImageLayoutShares(options);
  const hasLayout = Object.values(shares).some((share) => share > 0);
  const total =
    options.imageQuantity > 0 && hasLayout && (options.useAiImages || options.useHtmlImages || options.useMermaidImages)
      ? sections.filter((section) => section.content_plan?.image_needed === true).length
      : 0;
  return { total_groups: total, ...allocateImageLayoutGroups(total, shares) };
}

// ---- 材料 ----

export interface ContentWritingTemplate {
  readonly id: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly config: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ContentWritingKnowledgeDocument {
  readonly documentId: string;
  readonly fileName: string;
  readonly status: string;
  readonly itemCount: number;
  /** 文档的完整 Markdown（没有或读不到时为空）。 */
  readonly markdown: string;
  readonly items: readonly { readonly itemId: string; readonly title: string; readonly resume: string }[];
}

export interface ContentWritingFilesInput {
  readonly outline: readonly TechnicalPlanOutlineItem[];
  /** 本轮目标（目录顺序）。 */
  readonly targets: readonly LeafContext[];
  /** 已保存的编排（编排阶段写入之后的）。 */
  readonly plans: Readonly<Record<string, StoredContentPlan>>;
  readonly sectionStates: Readonly<Record<string, { readonly status?: string } | undefined>>;
  /** 全部目标都在本轮（非局部）时统一检查总字数（桌面版 !targetItemId && targets.length === leaves.length）。 */
  readonly checkTotalWords: boolean;
  readonly projectOverview: string;
  readonly globalFacts: readonly { readonly title: string; readonly content: string }[];
  readonly globalFactsMode: TechnicalPlanGlobalFactsMode;
  readonly wordControl: ContentWordControl;
  readonly generationOptions: ContentImageOptions & Pick<ContentGenerationOptions, 'tableRequirement'>;
  /** 用户额外要求（单节重新生成的要求随 8.11；整轮生成为空）。 */
  readonly requirement: string;
  /** 生成配置中选用的模板（null 时报错，与桌面版相同）。 */
  readonly template: ContentWritingTemplate | null;
  /** 生成配置引用的知识库文档 id（引用顺序）与读出的文档。 */
  readonly documentIds: readonly string[];
  readonly knowledgeDocuments: readonly ContentWritingKnowledgeDocument[];
}

export interface ContentWritingFile {
  readonly path: string;
  readonly content: string;
}

export const CONTENT_TEMPLATE_REQUIRED_CODE = 'TECHNICAL_PLAN_TEMPLATE_REQUIRED';
export const CONTENT_TEMPLATE_REQUIRED_MESSAGE = '请先在“长嘛样”选择有效的正文模板';

interface OutlineNode {
  id: string;
  number: string;
  title: string;
  description: string;
  content_mode?: string | undefined;
  children?: OutlineNode[];
  content_plan?: ContentPlan | undefined;
}

interface TargetSection extends OutlineNode {
  chapter_path: string;
  file: string;
}

/** 与桌面版去掉示例图片引用的方式相同：保留图组结构和配图提示词。 */
function templateSample(): string {
  return CONTENT_TEMPLATE_HTML.replace(/<img\b[^>]*>/gi, (tag) => tag.replace(/\s+(?:src|data-app-asset-ref)="[^"]*"/gi, ''));
}

/**
 * 写作阶段的材料（与桌面版 buildContentGenerationFiles 相同，原方案底稿属 8.11）：大小固定的要求和统计在前，随小节数增长的列表在后。
 * 没有模板时以 TECHNICAL_PLAN_TEMPLATE_REQUIRED 失败；引用的知识库文档没有完整正文时失败（与桌面版相同）。
 */
export function buildContentWritingFiles(input: ContentWritingFilesInput): ContentWritingFile[] {
  if (!input.template) throw new JobError(CONTENT_TEMPLATE_REQUIRED_CODE, CONTENT_TEMPLATE_REQUIRED_MESSAGE);
  const targetIds = new Set(input.targets.map(({ item }) => item.id));
  const sections: TargetSection[] = [];
  const completedSections: { id: string; number: string; title: string; file: string }[] = [];
  let totalAiSections = 0;
  const visit = (items: readonly TechnicalPlanOutlineItem[], parents: readonly string[] = []): OutlineNode[] =>
    items.map((item) => {
      const node: OutlineNode = { id: item.id, number: item.number, title: item.title, description: item.description || '', content_mode: item.content_mode };
      if (item.children?.length) node.children = visit(item.children, [...parents, item.title]);
      else if (item.content_mode === 'ai-generate') {
        totalAiSections += 1;
        if (targetIds.has(item.id)) {
          sections.push({ ...node, content_plan: input.plans[item.id]?.plan, chapter_path: [...parents, item.title].join(' > '), file: contentSectionFile(item.id) });
        } else {
          node.content_plan = input.plans[item.id]?.plan;
          if (input.sectionStates[item.id]?.status === 'success') {
            completedSections.push({ id: item.id, number: item.number, title: item.title, file: contentSectionFile(item.id) });
          }
        }
      }
      return node;
    });
  const tree = visit(input.outline);
  // 只汇总已保存的编排，不重新分配字数、表格或图片；完成列表是本轮启动前的快照。
  const executionSummary = {
    total_ai_sections: totalAiSections,
    target_sections: sections.length,
    completed_before_run: completedSections.length,
    target_words: sections.reduce((sum, section) => sum + ((section.content_plan?.target_words as number) || 0), 0),
    unspecified_word_target_sections: sections.filter((section) => !section.content_plan?.target_words).length,
    image_candidate_ids: sections.filter((section) => section.content_plan?.image_needed === true).map((section) => section.id),
    table_section_ids: sections.filter((section) => section.content_plan?.table?.needed === true).map((section) => section.id),
  };
  const hasKnowledgeBase = input.documentIds.length > 0;
  const referenceFiles = { ...CONTENT_WRITING_INPUT_FILES, ...(hasKnowledgeBase ? { knowledge_index: CONTENT_WRITING_KNOWLEDGE_INDEX_FILE } : {}) };
  const { wordControl, generationOptions } = input;
  const decisions = {
    execution_summary: executionSummary,
    image_layout_quota: buildImageLayoutQuota(sections, generationOptions),
    table_requirement: generationOptions.tableRequirement,
    word_requirements: wordInstructions(wordControl, input.checkTotalWords),
    word_control: { minimumWords: wordControl.minimumWords, maximumWords: wordControl.maximumWords, checkTotalWords: input.checkTotalWords },
    image_requirements: imageInstructions(generationOptions),
    global_facts_mode: input.globalFactsMode,
    global_facts_requirements: globalFactsInstructions(input.globalFactsMode),
    user_requirement: input.requirement || '',
    has_knowledge_base: hasKnowledgeBase,
    reference_files: referenceFiles,
    completed_sections: completedSections,
    targets: sections,
  };
  const template = input.template;
  const files: ContentWritingFile[] = [
    { path: CONTENT_WRITING_INPUT_FILES.outline, content: JSON.stringify({ outline: tree }, null, 2) },
    { path: CONTENT_WRITING_INPUT_FILES.overview, content: input.projectOverview || '未提供项目概述。' },
    { path: CONTENT_WRITING_INPUT_FILES.decisions, content: JSON.stringify(decisions, null, 2) },
    { path: CONTENT_WRITING_INPUT_FILES.rules, content: CONTENT_HTML_RULES },
    { path: CONTENT_WRITING_INPUT_FILES.imageTypes, content: CONTENT_IMAGE_TYPES },
    { path: CONTENT_WRITING_INPUT_FILES.template, content: templateSample() },
    {
      path: CONTENT_WRITING_INPUT_FILES.config,
      content: JSON.stringify(
        {
          template_id: template.id,
          template_name: template.name,
          config: template.config,
          is_system: template.isSystem,
          created_at: template.createdAt.toISOString(),
          updated_at: template.updatedAt.toISOString(),
        },
        null,
        2,
      ),
    },
    { path: CONTENT_WRITING_INPUT_FILES.facts, content: input.globalFacts.map((group) => `## ${group.title}\n${group.content}`).join('\n\n') || '未设定全局事实。' },
  ];
  if (!hasKnowledgeBase) return files;
  const byId = new Map(input.knowledgeDocuments.map((document) => [document.documentId, document]));
  const index: unknown[] = [];
  for (const documentId of input.documentIds) {
    const document = byId.get(documentId);
    if (!document?.markdown.trim()) {
      throw new JobError('TECHNICAL_PLAN_KNOWLEDGE_MARKDOWN_MISSING', `选中的知识库缺少完整正文：${document?.fileName || documentId}`);
    }
    const file = `知识库/${encodeURIComponent(documentId)}.md`;
    files.push({ path: file, content: document.markdown });
    index.push({
      document_id: documentId,
      file,
      document: { id: documentId, file_name: document.fileName, status: document.status, item_count: document.itemCount },
      items: document.items.map((item) => ({ id: `${documentId}::${item.itemId}`, title: item.title, resume: item.resume })),
    });
  }
  files.push({ path: CONTENT_WRITING_KNOWLEDGE_INDEX_FILE, content: JSON.stringify(index, null, 2) });
  return files;
}

// ---- 提示词 ----

export type ContentRunSummary = Record<string, unknown> & { execution_summary: Record<string, unknown> };

/** 提示词只内嵌大小固定的要求与统计数（与桌面版 buildRunSummary 相同）；目标、配图候选及表格 ID 等列表留在执行清单中按需读取。 */
export function buildContentRunSummary(decisionsJson: string): ContentRunSummary {
  const { targets: _targets, completed_sections: _completed, execution_summary: summary, ...requirements } = JSON.parse(decisionsJson) as Record<string, unknown> & {
    execution_summary: Record<string, unknown> & { image_candidate_ids?: unknown[]; table_section_ids?: unknown[] };
  };
  const { image_candidate_ids: candidates = [], table_section_ids: tables = [], ...counts } = summary;
  return { execution_summary: { ...counts, image_candidate_sections: candidates.length, table_sections: tables.length }, ...requirements };
}

export interface ContentWritingPromptInput {
  /** 本轮暂停后在原会话中继续（桌面版 resuming）。 */
  readonly resuming: boolean;
  readonly hasKnowledgeBase: boolean;
  readonly hasOriginalPlan: boolean;
  readonly runSummary: ContentRunSummary;
  /** 基础编排在同一会话中刚完成（桌面版 planningHandoff）。 */
  readonly planningHandoff: boolean;
  /** 目录变更后的局部生成：沿用上一轮的会话、不是本轮暂停后的继续、也不是编排交接（桌面版 reuseSession && !resuming && !planningHandoff）。 */
  readonly localRegeneration: boolean;
}

/** 写作阶段的提示词（与桌面版 generationPrompt + buildContentGenerationPrompt 相同）。 */
export function createContentWritingPrompt({ resuming, hasKnowledgeBase, hasOriginalPlan, runSummary, planningHandoff, localRegeneration }: ContentWritingPromptInput): string {
  const prefix = localRegeneration
    ? '本次为目录变更后的局部生成任务，在原会话中执行。重新读取已更新的输入文件，仅对当前 targets 执行生成和审计修复；本轮完成状态根据当前目标重新确认，不沿用上一轮的完成结论。保留其他小节的 HTML、图片及源码，新增配图源码使用新文件名，不覆盖已有文件。\n'
    : '';
  return `${prefix}你负责本次投标文件受限 HTML 正文生成，使用一个持久会话完成任务。
1. 下面是程序根据正文编排决策.json整理的本轮执行摘要，包含本轮全部要求、布局名额和统计数：
${JSON.stringify(runSummary)}
${planningHandoff ? '基础编排已由程序处理并保存：字数已校正，表格和配图已按设置选定。各目标的最终字数、表格安排和配图标记以正文编排决策.json 的 targets 为准，不沿用基础编排中的草稿或候选建议；继续本会话已有的写作重点和知识条目，不重新编排，也无需重复通读未变化的目录和招标资料。' : ''}随小节数增长的内容只保存在文件中：正文编排决策.json 的 targets（本轮目标、最终编排、HTML 路径和还原材料引用）、execution_summary 中的配图候选及表格入选小节 ID、completed_sections，以及正文完整目录.json 的完整目录，按需读取或检索，读取方式自行决定，可用 read 分页，也可用 rg、jq 等命令筛选。受限HTML生成规范.md 篇幅固定，须完整阅读；项目概述.md 按需读取。参考正文模板.html和所选模板配置.json。模板只是结构示例，不照抄示例正文，不要求每节套用全部元素。
2. ${hasKnowledgeBase ? '已选择知识库，可通过知识库/索引.json定位参考文档。编排中的 knowledge.item_ids 对应索引条目的 id；根据条目所属文档读取相关原文。索引标题和简介用于定位，具体内容以文档原文为准。' : ''}程序自动向每个小节写作请求提供全局事实设定.md的完整内容，无需为传递事实重复摘录；你可按需阅读，以核实相关要求和安排配图。主 Agent 负责按需检索并提供补充资料摘录，并发正文模型核对请求中提供的材料；编辑子 Agent 按需读取工作区文件。一致性审计阶段的阅读范围按审计指令执行。遵守执行摘要中的 global_facts_requirements（当前事实模式的中文要求）。
3. 只生成正文编排决策.json中 targets 列出的 AI 生成叶子小节，完整目录按需用于了解上下级和相邻章节。执行摘要的 execution_summary 已汇总全文 AI 小节数、本轮目标数与目标字数、未设置字数目标的小节数、配图候选及表格入选小节数；image_layout_quota 已计算本轮布局名额，直接使用这些结果，对应小节 ID 见正文编排决策.json。如发现信息不一致，可读取相关文件核实。统计与检查使用程序工具的结果：布局组数、生成方式分布，以及缺少图注、data-app-fit 或有效引用的图片以 list-section-images 返回的 summary 为准，字数以 check-word-count 为准，HTML 结构和图片块由程序在提交时统一校验；不另写脚本或中间文件重复这些统计和格式检查。completed_sections 仅记录本轮启动前已成功完成的非目标小节，不是实时进度；本轮暂停恢复时结合工具结果和实际文件继续，不能仅因 HTML 存在就认定图片、审计等步骤全部完成。遵守写作重点、表格和配图标记、全文及每小节字数要求、用户额外要求。各小节严格按照编排结果中的 content_plan.target_words 目标字数安排生成，不自行调整目标，不重新分配全文目标。字数校验可按约10%的容差判断，但该容差仅用于结果校验，不得写入 generate-sections 的补充要求或传递给正文生成模型。每节输出路径已给定，禁止修改输入文件和业务数据库。保留非目标小节的 HTML、图片及源码，新增配图源码使用新文件名，不覆盖已有文件。${hasOriginalPlan ? '本次使用已还原底稿：阅读执行摘要中的 restoration_requirements；工具会自动向每节写作请求加入本节完整底稿、原图引用对应关系和全局事实，各节 restored_content.file 按需阅读，用于安排配图和补充要求。已超过生效字数要求的底稿只整理、不扩写；冲突以全局事实设定为准。保留原表格和原图，以下配图与表格限制仅用于新增内容；原图直接引用已复制文件，不重新生图。无底稿小节按正常流程生成。' : ''}
4. 先完整阅读配图类型对照表.md及 image_requirements（用户配图要求），读取 image_layout_quota（本轮新增布局名额）：total_groups 为总组数，single、imageText、threeImages、fourImages 分别为单张图片、图片表格、三列图片、四宫格的组数。结合本轮 targets 中 image_needed=true 小节的主题、写作重点和适配评分统一分配布局，并按 image_requirements 的本轮 AI 图片占比要求，在并发写作前规划每张图的表达目的、图片类型及生成方式；AI 图片按 image_requirements 的画面差异化要求逐图确定画面类型、主体、视角景别和画面形式，保证全文及图组内画面分散；名额为零时不安排新增配图。可在合适小节安排多组，不要求逐节平均分配；单张图片、图片表格、三列图片和四宫格分别保持各自组数，不互换名额。暂停、失败重试沿用本轮名额，已完成的布局计入完成数量，只补未完成部分，不重新分配一整轮。检索需要的参考资料并完成本轮安排后，将本轮待生成小节写入 ${taskFilePath('sections')}，格式为 {"sections":[{"section_id":"targets 中的小节 id","instructions":"本节补充要求","references":"补充资料摘录"}]}；每项都必须包含 section_id、instructions 和 references，section_id 原样使用 targets 中对应小节的 id，无参考摘录时 references 填空字符串，不省略字段。写完后调用 generate-sections 提交：程序读取文件中的全部小节，AI 服务队列按用户设置的并发上限运行，超出上限的任务自动排队，空出名额后自动启动后续任务，无需你控制批次。已生成正文的小节自动跳过，确需整节重写时给该项加 "regenerate": true；暂停恢复或失败重试时可直接再次提交，失败项先在文件中修正要求。任务/ 目录下的任务文件是程序工具的输入，已预置 Schema，可用 json-validation 自查，提交工具读取时校验。${TASK_FILE_WRITING}工具会自动加入本节编排、项目概述、HTML规范、模板、配图类型对照表、字数及配图要求，直接使用已保存编排，不逐节重写写作重点或扩展详细提纲，段落组织由正文写作模型根据编排完成。instructions 只补充本节配图布局、组数、逐图表达目的、图片类型和生成方式（aiImage/htmlImage/mermaid），AI 图片另含画面类型、主体、视角景别和画面形式，以及确有必要的特殊要求；无需复述目标字数、写作重点、表格安排、全局事实和公共格式规则，也不重复编写图片标签、属性、编号或完整生图提示词，这些由正文写作模型按规范生成。没有新增配图和补充要求时 instructions 填空字符串，程序将其解释为无补充要求、未分配新增配图，已有原图仍按原规则保留。references 只提供实际需要的补充资料摘录。发现具体问题时仍可核实资料并提供针对性的修正要求，失败重试只说明需要纠正的问题。全局名额由你统筹，不得让每个并发任务自行分配或承担整轮名额。文本并发遵循用户现有模型配置，不要使用bash或脚本直接调用外部模型。
5. 正文布局保存后，调用 list-section-images：工具返回 summary，并将完整图片清单（小节、figure、生成方式、比例、提示词及当前引用）写入 程序清单/正文图片清单.json。完成本次要求的配图生成、失败项修复和正文图片引用更新，保留有效的已有成果。清单和源码的读取、任务整理及处理批次由你自主决定，可分批读取、分批保存和提交，无需一次掌握全部图片明细。发现结构或提示词问题可 read/edit 修复后按 section_ids 重新提取。image_id 原样沿用到图片工具和回填工具，不能自行重编；reused_original=true 的图片直接复用，文件缺失时修复原引用，不重新生图。已有有效图片无需重复生成。配图前完整阅读配图类型对照表.md，并遵守 image_requirements（用户配图要求）。无图不安排图片或占位，不调用配图工具；有图时按已分配的布局及逐图确定的生成方式完成配图；生成方式遵守类型开关和对照表，布局本身不绑定 AI、HTML 或 Mermaid，无须覆盖全部已开启类型。在当前会话中完成所需图片：将本轮待生成的 AI、HTML、Mermaid 图片写入 ${taskFilePath('images')}，格式为 {"images":[{"image_id":"清单标识","kind":"ai/html/mermaid","prompt":"…"}]}，写完后调用 generate-section-images 提交；每项提供清单 image_id、kind、prompt。AI 项 size 必填，逐图读取对应 figure 的 data-app-size，按 square=1:1、wide=3:2、tall=3:4、panorama=16:9 选择匹配的具体生图尺寸；gpt-image-2-1k 模型的 tall 使用已验证的 768x1024。不能把画框名称作为尺寸，不得省略 size 或统一使用默认方图；prompt 中保留相同的宽高比例和横向/竖向构图方向。AI 项 style 必填，按 template 注明的画面形式选择对应值；prompt 正向描述画面，不写与 style 冲突的风格，也不重复罗列品牌、水印、无关文字等由程序统一追加的限制。HTML 项必填 frame_size，与正文画框一致。HTML/Mermaid 的 prompt 写明图片类型、表达目的、准确内容和数据，不只给文件路径或要求并发模型自行检索。程序读取全部条目，同时向既有生图和文本队列提交任务，超限自动排队；每张源码生成完成立即本地转图，不等其他源码或 AI 图完成。已有有效图片的项自动跳过，需要替换已有图片时该项加 "regenerate": true，原方案图片不重新生成。每张成功图片由程序立即回填正文；提交结束后按返回的 unresolved 逐项检查 status、stage 和 error，按工具说明处理未成功项。有 source_file 的失败或未完成项直接读取、必要时修改源码后，按类型写入 ${taskFilePath('renderHtml')} 或 ${taskFilePath('renderMermaid')}（每项 image_id、source_file，HTML 另填 frame_size），再调用 render-html-image 或 render-mermaid-image，不重复生成成功源码；无源码的失败项才重新提交生成工具。设计宽度1240px，square/wide/tall/panorama对应高度1240/827/1653/698px，尺寸包含程序统一设置的四周40px内边距；以 body 为画布，用 Flex/Grid 合理铺满内部区域，不额外包一层画布或重复添加外层边距。采用正式简洁的配色和清晰层次，不在底部留下大块空白，不靠无意义文字或空卡片填满；Mermaid 图的语法问题通过修改已保存的 .mmd 源文件并提交 render-mermaid-image 修复。源码保存在图片/目录，配图 HTML 可使用 CSS，不受正文受限 HTML 标签限制。图片工具成功后由程序直接更新对应 img 的引用，无须再调用 apply-section-images，也不必手工编辑正文。仅对返回 applied=false 的项，按 apply_error 刷新清单后写入 ${taskFilePath('applyImages')}（每项 image_id、图片工具返回的 asset_ref 和 previous_asset_ref），再调用 apply-section-images 重试。不要回填状态非 success 的项，不填写 src，不虚构路径，不把源码嵌入正文。图组中每张图片均须生成。暂停恢复时先核对最新图片清单（成功图片已回填）与会话中工具返回的未完成项，复用已保存源码；已完成的图片再次提交时自动跳过，无源码的剩余项提交生成工具，已有源码的剩余项使用对应 render 工具。执行错误按工具反馈修复，失败不得默认为成功或改换生成方式。
6. ${resuming ? '本次继续原会话。先检查正文/已完成文件，保留有效正文、图片和源码，复用已存在且符合内容的图片引用；只补齐未完成、失败或明确需要修正的小节及图片。' : '每个小节保存为正文/下的独立HTML文件。'} 工具返回统计和失败小节；对失败小节修正要求后重试，可用read/edit检查和修正已有HTML。不要删除已完成的小节。
小节 id 是固定身份，number 才是显示编号。任务文件的 section_id、结果清单及文件名均使用 id；不得根据显示编号改写文件路径。
7. 所有并发生成任务及配图全部完成后，再次调用 list-section-images，依据 summary 核对本轮实际新增布局与名额一致、图注及图片引用完整，并按 image_requirements 核对本轮新增图片的生成方式分布及 AI 图片画面是否分散；AI 占比是规划目标，不因比例偏差新增失败条件或额外加图。原方案图片及布局不占新增名额，也不计入 AI 占比。核对完成后，再调用 check-word-count 统一检查实际字数，不能一边生成一边按部分结果调整；工具返回总字数和上下限，各节字数写入 程序清单/正文字数统计.json。完整检查后进入图片保护阶段：优先用 edit 修改正文文字，也可按需使用 bash 处理工作区文件，不能再调用正文生成或配图工具。已插入的所有图片块（包括原图、新图、图注及提示词）、图片顺序和图片表格布局不可修改；图文表格中的普通说明文字可以调整。提交时程序逐节核对图片块，不一致会退回并附上原始图片块，须原样恢复。本阶段只统计字数：统计后保持正文不变，不以任何方式（包括脚本批量删改）调整字数，如实写入结果清单并提交；字数要求由程序在本阶段提交后按设置统一处理。
8. 检查小节覆盖、字数及所有 img 的 data-app-asset-ref 对应图片文件已存在，图片占位全部完成后将所有本次目标写入正文生成结果.json，格式为{"sections":[{"section_id":"小节ID","file":"正文/小节ID.html","words":实际正文统计字数}]}，各节字数可取自 程序清单/正文字数统计.json。该 JSON 已预置 Schema，可用 json-validation 自查，内容较多时可分多次写入。正文内容仅保存于各小节 HTML 文件。结果清单只记录小节 ID、文件路径和实际字数。本轮生成、调整和检查结束后，在结果清单最后一次写入或更新操作上设置 task_complete=true，如实提交当前产物和字数。标记完成后程序统一提交校验结果清单、各小节 HTML 结构、图片引用和图片块，并还原被改动的输入资料和非目标小节；不通过时退回问题清单（完整清单在 程序清单/提交校验问题.json），问题涉及的小节超过 ${SUBMISSION_FIX_PARALLEL_THRESHOLD} 个时调用 ${SUBMISSION_FIX_TOOL} 并发修复，${SUBMISSION_FIX_PARALLEL_THRESHOLD} 个及以下直接修改，按程序要求修复后重新提交；程序根据进展统一决定继续修复、更换方法或接受质量遗留问题，最低目标修复后仍有阻塞问题才停止任务。
9. 提交本阶段结果后，程序会在同一会话中发出一致性审计任务；等待下一阶段要求，不自行转换 Word。
以下写作规则仅适用于小节 HTML 文件，不适用于结果清单：\n${writingInstructions(hasKnowledgeBase)}`;
}
