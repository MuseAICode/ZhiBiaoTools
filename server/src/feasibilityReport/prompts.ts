// 可研报告任务的提示词与正文整理（路线图第 6 步 6.12）：从桌面版 feasibilityReportPrompts.cjs 与 feasibilityReportTasks.cjs
// 原样搬运资料分析、关键参数、正文生成与自然化审校用到的部分（tests/feasibilityReport/prompts.test.ts 加载桌面版逐项对照）。
// 目录生成 / 调整用到的大纲模板与提示词随第 8 步（Agent 沙箱）迁移，不在这里。
import type { ChatMessage } from '../ai/providers.ts';
import type { FeasibilityOutlineItem, FeasibilityProjectInfo } from './store.ts';

export const ANALYSIS_FIELDS: readonly (readonly [string, string])[] = [
  ['project_overview', '项目概况'],
  ['background_and_necessity', '建设背景与必要性'],
  ['demand_and_output', '需求分析与产出方案'],
  ['site_and_conditions', '项目选址与要素保障'],
  ['construction_and_technical_conditions', '建设内容与技术条件'],
  ['operation_conditions', '运营条件'],
  ['investment_and_financing', '投资与资金资料'],
  ['impact_and_risks', '影响效果与风险'],
  ['missing_information', '缺失资料清单'],
];

export function formatProjectInfo(info: Partial<FeasibilityProjectInfo> = {}): string {
  const typeLabel = info.projectType === 'enterprise' ? '企业投资项目' : '政府投资项目';
  return [
    `项目名称：${info.projectName || '【待补充】'}`,
    `项目类型：${typeLabel}`,
    `所属行业：${info.industry || '【待补充】'}`,
    `建设单位：${info.constructionUnit || '【待补充】'}`,
    `建设地点：${info.location || '【待补充】'}`,
    `建设内容与规模：${info.constructionContent || '【待补充】'}`,
    `建设期：${info.constructionPeriodYears || '【待补充】'} 年`,
    `运营期：${info.operationPeriodYears || '【待补充】'} 年`,
    `总投资：${info.totalInvestment || '【待补充】'}`,
    `资金来源：${info.fundingSource || '【待补充】'}`,
  ].join('\n');
}

export function buildAnalysisSystemPrompt(): string {
  return [
    '你是严谨的中国建设项目可行性研究资料分析专家。只能基于项目参数和用户资料提取事实；不得编造金额、规模、地点、期限、政策名称或技术参数。',
    '无资料文件时只使用项目参数（含建设内容与规模）；此时资料块可能为“未导入资料文件”。',
  ].join('');
}

export function buildAnalysisUserInstruction(segmentIndex: number, totalSegments: number): string {
  return `请把当前资料中可用于编制可行性研究报告的信息整理为 JSON。

要求：
1. project_overview：项目名称、单位、地点、性质、规模、建设内容、工期等。
2. background_and_necessity：背景、问题、规划政策关系和建设必要性。
3. demand_and_output：需求对象、现状缺口、建设规模依据和预期产出。
4. site_and_conditions：选址、用地、交通、市政、资源、审批和建设条件。
5. construction_and_technical_conditions：技术路线、工程、设备、数字化和建设管理资料。
6. operation_conditions：运营模式、组织、安全、绩效和运维资料。
7. investment_and_financing：投资、费用、资金来源、收益、成本和融资资料。
8. impact_and_risks：经济、社会、生态、能源、碳排放和风险资料。
9. missing_information：只列出本段明显缺失、矛盾或需要用户确认的关键资料；不要把当前分段未出现但可能存在于其他分段的内容武断判定为缺失。
10. 每个字段输出 Markdown 文本；没有信息时输出空字符串。只返回 JSON。

当前资料分段：${segmentIndex}/${totalSegments}

JSON 格式：
${JSON.stringify(Object.fromEntries(ANALYSIS_FIELDS.map(([key]) => [key, 'Markdown 文本'])), null, 2)}`;
}

export function buildAnalysisMergeSystemPrompt(): string {
  return '你是严谨的可行性研究资料合并专家。只能合并用户提供的分析结果，不得创造新事实。';
}

export function buildAnalysisMergeUserInstruction(): string {
  return '请合并重复信息、保留具体事实并标明资料矛盾。missing_information 只保留综合全部分段后仍然缺失、矛盾或需要确认的关键项。只返回与输入相同字段的 JSON。';
}

/** 模型返回的 JSON 是不可信数据：不是对象时按空对象处理，字段值与桌面版相同经 String() 转成文本。 */
export function analysisToMarkdown(payload: unknown): string {
  const fields = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  return ANALYSIS_FIELDS.map(([key, title]) => {
    const raw = String(fields[key] || '').trim();
    const body =
      raw || (key === 'missing_information' ? '- 【待补充】尚未识别到明确缺失项，请人工核对资料完整性。' : '【待补充】现有资料未提供足够信息。');
    return `## ${title}\n\n${body}`;
  }).join('\n\n');
}

export function buildParametersSystemPrompt(): string {
  return '你是可行性研究报告的关键参数审校专家。你必须区分已知事实与缺失信息，严禁自行编造数字、政策、设备参数、地点或资金安排。';
}

export function buildParametersUserInstruction(): string {
  return `请生成“关键参数与编制口径”Markdown，至少包含：项目身份信息、建设目标与规模、建设地点与条件、建设期与进度、技术路线与主要设备、投资与资金来源、运营期与组织、安全环保能源口径、经济社会效益口径、风险与待确认事项。

规则：
1. 已有明确事实直接写入。
2. 未提供的关键参数统一写“【待补充】”，不要填常见值或经验值。
3. 资料存在冲突时写“【待确认】”并列出冲突内容。
4. 本阶段不自动计算 NPV、IRR、回收期等财务指标。
5. 使用二级标题和简短 bullet，直接输出 Markdown。`;
}

export function buildContentSystemPrompt(): string {
  return '你是专业的可行性研究报告编制专家。正文必须基于用户提供的项目事实和资料，论证清晰、语言正式。不得编造金额、规模、地点、期限、批复、政策名称、设备参数或财务指标。';
}

export function buildContentWritingRules(): string {
  return `写作规则：
1. 只生成当前叶子章节正文，不重复输出章节标题。
2. 对已有资料进行分析、论证和结构化表达；可以使用 Markdown 小标题、列表和必要表格。
3. 没有依据的关键数据明确写“【待补充】”或采用不含虚构数字的定性表达。
4. 不把需求、建议或通用规范写成已经完成的事实。
5. 与全文关键参数保持一致。
6. 若当前章节涉及项目选址与建设条件、总图布置、工艺流程、环保设施或实施进度等工程技术/选址章节，请在最佳位置嵌入且仅嵌入 1 处插图指引框，格式固定为：
> 📸 **【插图指引】：图片名称**
> *说明：此处请插入...*
7. 直接输出 Markdown 正文。`;
}

export function buildHumanWritingSystemPrompt(): string {
  return [
    '你是中文公文与工程咨询报告润色编辑。请对给定章节做自然化审校，使行文更像人工撰写。',
    '保护事实和参数，压缩重复表达，改善中文词序，清理模板腔与模型腔，同时保持正式可研文风。',
    '必须完整保留所有数量、单位、金额、日期、比例，以及【待补充】【待确认】标记。',
    '不得新增事实、不得删改结论口径、不得计算财务指标。',
    '不得输出章节标题，不得补写资料中不存在的事实。只输出修订后的 Markdown 正文，不要解释。',
  ].join('');
}

export function renderOutlineForPrompt(items: readonly FeasibilityOutlineItem[] | undefined, prefix = ''): string {
  return (items || [])
    .flatMap((item, index) => {
      const number = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
      return [`${number} ${item.title}${item.description ? `：${item.description}` : ''}`, ...renderOutlineForPrompt(item.children, number)];
    })
    .join('\n');
}

// ---- 各任务的请求（与桌面版 feasibilityReportTasks.cjs 相同） ----

/** 提示词用到的状态。 */
export interface PromptState {
  projectInfo: FeasibilityProjectInfo;
  analysisMarkdown: string;
  keyParametersMarkdown: string;
}

export function buildAnalysisSegmentMessages(projectInfo: FeasibilityProjectInfo, content: string, index: number, total: number): ChatMessage[] {
  const sourceBlock = String(content || '').trim() || '未导入资料文件';
  return [
    { role: 'system', content: buildAnalysisSystemPrompt() },
    { role: 'user', content: `项目基础参数：\n${formatProjectInfo(projectInfo)}\n\n当前资料分段：${index}/${total}\n\n${sourceBlock}` },
    { role: 'user', content: buildAnalysisUserInstruction(index, total) },
  ];
}

export function buildAnalysisMergeMessages(projectInfo: FeasibilityProjectInfo, parts: readonly unknown[]): ChatMessage[] {
  return [
    { role: 'system', content: buildAnalysisMergeSystemPrompt() },
    { role: 'user', content: `项目基础参数：\n${formatProjectInfo(projectInfo)}\n\n分段分析结果：\n${JSON.stringify(parts, null, 2)}` },
    { role: 'user', content: buildAnalysisMergeUserInstruction() },
  ];
}

/** 关键参数的知识库轻量条目（桌面版 loadLightweightKnowledgeItems 的结果）。 */
export interface LightweightKnowledgeItem {
  id: string;
  title: string;
  resume: string;
}

export function buildParametersMessages(state: PromptState, outline: readonly FeasibilityOutlineItem[], knowledgeItems: readonly LightweightKnowledgeItem[]): ChatMessage[] {
  return [
    { role: 'system', content: buildParametersSystemPrompt() },
    { role: 'user', content: `项目基础参数：\n${formatProjectInfo(state.projectInfo)}\n\n项目资料分析：\n${state.analysisMarkdown}` },
    { role: 'user', content: `报告目录：\n${renderOutlineForPrompt(outline)}` },
    { role: 'user', content: `知识库轻量条目：\n${knowledgeItems.length ? JSON.stringify(knowledgeItems, null, 2) : '未选择知识库'}` },
    { role: 'user', content: buildParametersUserInstruction() },
  ];
}

/** 全文相同的材料和写作规则在前、本节内容在后，公共部分以消息边界结束，供预热和各节请求复用前缀缓存。 */
export function buildContentPrefixMessages(state: PromptState): ChatMessage[] {
  return [
    { role: 'system', content: buildContentSystemPrompt() },
    { role: 'user', content: `项目基础参数：\n${formatProjectInfo(state.projectInfo)}` },
    { role: 'user', content: `项目资料分析：\n${state.analysisMarkdown}` },
    { role: 'user', content: `全文关键参数与编制口径：\n${state.keyParametersMarkdown}` },
    { role: 'user', content: buildContentWritingRules() },
  ];
}

/** 审校各节共用的前缀，用法同 buildContentPrefixMessages。 */
export function buildReviewPrefixMessages(state: PromptState): ChatMessage[] {
  return [
    { role: 'system', content: buildHumanWritingSystemPrompt() },
    { role: 'user', content: `项目基础参数：\n${formatProjectInfo(state.projectInfo)}` },
    { role: 'user', content: `全文关键参数与编制口径：\n${state.keyParametersMarkdown}` },
  ];
}

export interface Leaf extends FeasibilityOutlineItem {
  trail: string[];
}

export function buildLeafContentMessages(state: PromptState, leaf: Leaf, knowledge: string, targetWords: number): ChatMessage[] {
  const chapterPath = (leaf.trail || []).join(' > ');
  const messages: ChatMessage[] = [
    ...buildContentPrefixMessages(state),
    {
      role: 'user',
      content: `当前章节路径：${chapterPath}\n章节写作重点：${leaf.description || '围绕章节标题展开充分论证。'}\n参考目标字数：约 ${targetWords} 字。`,
    },
  ];
  if (knowledge) {
    messages.push({
      role: 'user',
      content: `可吸收的知识库素材如下。请改写到本项目语境，不要提及“知识库”“历史文档”或资料来源：\n\n${knowledge}`,
    });
  }
  return messages;
}

export function buildLeafReviewMessages(state: PromptState, leaf: Leaf): ChatMessage[] {
  const chapterPath = (leaf.trail || []).join(' > ');
  return [
    ...buildReviewPrefixMessages(state),
    {
      role: 'user',
      content: `当前章节路径：${chapterPath}\n\n请只审校下面的已有正文。不得输出章节标题，不得补写资料中不存在的事实。\n\n${leaf.content}`,
    },
  ];
}

// ---- 目录与正文的整理（与桌面版相同） ----

export function collectLeaves(items: readonly FeasibilityOutlineItem[] = [], trail: string[] = [], leaves: Leaf[] = []): Leaf[] {
  for (const item of items || []) {
    const nextTrail = [...trail, item.title];
    if (item.children?.length) {
      collectLeaves(item.children, nextTrail, leaves);
    } else {
      leaves.push({ ...item, trail: nextTrail });
    }
  }
  return leaves;
}

export function hasContent(item: { content?: string } | undefined): boolean {
  return Boolean(String(item?.content || '').trim());
}

export function stripMarkdownFence(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

const PROTECTED_QUANTITY_PATTERN =
  /(?:\d+(?:\.\d+)?(?:\s*(?:-|～|~|至)\s*\d+(?:\.\d+)?)?\s*(?:亿元|万元|元|%|％|年|个月|月|日|天|小时|平方米|平方公里|亩|公里|米|千米|吨|千瓦时|千瓦|兆瓦|人|户|家|项|套|台|个|座|栋|层|次))/g;

function countProtectedWritingTokens(content: string): Map<string, number> {
  const source = String(content || '');
  const counts = new Map<string, number>();
  const quantities = source.match(PROTECTED_QUANTITY_PATTERN) || [];
  const markers = source.match(/【(?:待补充|待确认)】/g) || [];
  for (const token of [...quantities, ...markers]) {
    const normalized = token.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return counts;
}

function findMissingProtectedTokens(original: string, revised: string): string[] {
  const originalCounts = countProtectedWritingTokens(original);
  const revisedCounts = countProtectedWritingTokens(revised);
  const missing: string[] = [];
  for (const [token, count] of originalCounts) {
    if ((revisedCounts.get(token) || 0) < count) missing.push(token);
  }
  return missing;
}

/** 审校结果为空，或丢了原文中的数量、单位、【待补充】【待确认】标记时保留原文。 */
export function protectFacts(original: string, rewritten: string): string {
  const next = String(rewritten || '').trim();
  if (!next) return String(original || '');
  if (findMissingProtectedTokens(original, next).length) return String(original || '');
  return next;
}

/** 正文生成可吸收的知识库条目（桌面版 loadKnowledgeContentMap 的值）。 */
export interface KnowledgeContent {
  title: string;
  resume: string;
  content: string;
}

function scoreKnowledge(item: KnowledgeContent, chapter: FeasibilityOutlineItem): number {
  const query = `${chapter.title || ''}${chapter.description || ''}`;
  const target = `${item.title || ''}${item.resume || ''}`;
  const chars = [...new Set(query.replace(/[\s，。；：、（）()《》“”]/g, ''))];
  return chars.reduce((score, char) => score + (target.includes(char) ? 1 : 0), 0);
}

/** 本章引用的知识库素材：章节指定了条目时取指定的，否则按标题与说明的字面重合挑最多 3 条；合计不超过 24000 字。 */
export function selectKnowledgeContents(chapter: FeasibilityOutlineItem, knowledgeMap: ReadonlyMap<string, KnowledgeContent>): string {
  const explicitIds = Array.isArray(chapter.knowledge_item_ids) ? chapter.knowledge_item_ids : [];
  const explicit = explicitIds.map((id) => knowledgeMap.get(id)).filter((item): item is KnowledgeContent => Boolean(item));
  const selected = explicit.length
    ? explicit
    : Array.from(knowledgeMap.values())
        .map((item) => ({ item, score: scoreKnowledge(item, chapter) }))
        .filter((entry) => entry.score > 1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((entry) => entry.item);
  let used = 0;
  const blocks: string[] = [];
  for (const item of selected) {
    const block = `### ${item.title}\n\n${item.content}`.trim();
    if (used + block.length > 24000) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n\n');
}

/** 正文生成与审校的进度（与桌面版 contentProgress 相同）。 */
export function contentProgress(phase: 'generating' | 'human-writing' | 'done', completed: number, total: number): number {
  if (phase === 'done') return 100;
  const safeTotal = Math.max(total, 1);
  if (phase === 'human-writing') return Math.min(99, 70 + Math.round((completed / safeTotal) * 29));
  return Math.min(70, 5 + Math.round((completed / safeTotal) * 65));
}

/** 每章的参考目标字数（与桌面版相同：总字数按叶子章节平分，至少 600）。 */
export function perLeafWords(targetWords: number, leafCount: number): number {
  return Math.max(600, Math.round((targetWords || 30000) / Math.max(leafCount, 1)));
}
