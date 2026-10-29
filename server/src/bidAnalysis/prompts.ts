// 招标解析的提示词与调用流程（路线图第 6 步 6.11；取代桌面版 bidAnalysisTask.cjs、utils/segmentedAiResultMerger.cjs、
// utils/bidSectionContext.cjs）。技术方案的招标解析任务（src/technicalPlan/jobs.ts）和废标检查的无效与废标项解析
// （discardedBids.ts）共用。18 个解析项的提示词、公共前缀、分段结果的合并请求与桌面版逐字相同（tests/bidAnalysis/prompts.test.ts
// 加载桌面版文件，用同一输入对照完整的请求序列）。
//
// 流程（与桌面版 runBidAnalysisPromptTask 相同）：招标正文按上下文长度切分；只有一段时直接调用一次；多段时各段并发调用、
// 再调用一次合并。Markdown 解析项整项无结果（只返回“未提取到”）时完整重跑一次，第二次的结果原样返回。
// 步骤键由调用方给出前缀（招标解析为 item:<id>，废标检查为 extraction）：单段时为前缀本身，多段时为 <前缀>:segment:N 与
// <前缀>:merge，重跑一次时前缀加 :try-2。JSON 解析项与桌面版相同不解析 JSON，模型输出原样作为结果（桌面版另带
// response_format，网关暂不支持，见路线图第 6 步登记事项第 27 项）。
import type { ChatMessage } from '../ai/providers.ts';
import type { TechnicalPlanBidItemId } from '../db/schema.ts';
import type { JobChat } from '../jobs/chat.ts';
import { bidItemLabel } from '../technicalPlan/tender.ts';

const MARKDOWN_MISSING_RESULT = '未提取到';

export const STABLE_SYSTEM_PROMPT = `你是专业的投标资料分析助手。请严格基于用户提供的上下文完成提取和总结。

通用要求：
1. 保持信息全面、准确，优先使用用户提供上下文中的内容；除非具体任务明确要求或允许根据经验补充，否则不要自行编造
2. 已提取到相关内容但局部信息没有提及时，明确写“没有提及”
3. 只输出最终结果，不输出过程、提示语或客套话
4. 始终使用简体中文`;

function jsonTask(title: string, goals: string, outputJson: string): string {
  return `任务：${title}

目标：${goals}

约束：
1. 输出格式必须为 JSON。
2. 严格按照以下 JSON 格式输出，只修改 value，禁止修改 key 和结构。
3. 招标文件中没有的字段填充“没有提及”。

JSON 格式：
${outputJson}

仅输出 JSON，不要输出其他内容。`;
}

function buildInvalidBidAndRejectionItemsPrompt(): string {
  return `任务：提取并分析招标文件中的“无效投标”和“废标项”。

概念边界：
1. “无效投标”指投标人、投标文件、签章密封、递交时间、报价、保证金、资格条件、实质性响应等原因导致投标被认定为无效、否决、不予受理或按无效响应处理的情形。
2. “废标项”指可能导致项目废标、采购失败、重新招标、终止评审、有效投标人不足或实质性响应不足的条款或风险项。
3. 招标文件使用“否决投标”“投标无效”“不予受理”“无效响应”“重大偏差”“实质性偏离”“废标情形”等同义表达时，也要按上述边界归类。

输出要求：
1. 必须明确区分“无效投标”和“废标项”。
2. “招标文件中明确提到的”只能提取招标文件中明确出现或同义表达的内容，尽量保留招标文件中的关键句；如果没有提及，写“招标文件未提及”。
3. “此类标书还可能涉及的”需要根据你的经验，补充招标文件中未明确提及、但结合本招标文件类型和招投标经验判断非常重要的高风险遗漏项。
4. 不要罗列所有常见可能项，不要输出泛泛的通用清单；每个小节最多输出 3-5 条。
5. 不要使用表格，使用 Markdown 列表。
6. 仅输出下方格式，不要输出解释、过程或额外段落。
7. 不要输出三重引号、代码块标记或其他格式包裹符。

输出格式：
# 招标文件中明确提到的

## 无效投标
- ...

## 废标项
- ...

# 此类标书还可能涉及的

## 无效投标
- ...

## 废标项
- ...`;
}

interface PromptDefinition {
  id: TechnicalPlanBidItemId;
  output: 'markdown' | 'json';
  prompt: () => string;
}

const PROMPTS: readonly PromptDefinition[] = [
  {
    id: 'projectOverview', output: 'markdown',
    prompt: () => `任务：提取并总结项目概述信息。

请重点关注项目名称、基本信息、背景目的、规模预算、时间安排、实施内容、技术特点和其他关键要求。

工作要求：保持信息全面准确，尽量使用招标文件中的内容；只关注与项目实施有关的内容，不提取商务信息；直接返回整理好的项目概述。`,
  },
  {
    id: 'techRequirements', output: 'markdown',
    prompt: () => `任务：提取技术评分信息，并按语义区分“技术评分项”和“技术评分要求”。

重点识别“技术评分”“评标方法”“评分标准”“技术参数”“技术要求”“技术方案”“技术部分”“评审要素”相关章节，不要提取商务、价格、资质等无关条目。

分类原则：
1. 技术评分项：指投标人需要在技术方案中一一响应、展开编写，并可对应形成技术方案章节的具体评分内容，例如方案类、措施类、团队类、实施类、服务类、保障类、运维类、应急类、检查类等评分内容。
2. 技术评分要求：指用于约束评分、解释评分、定义扣分或判定规则的通用规则或说明，例如符合性要求、偏离扣分规则、判定口径、适用范围说明、表后说明、通用评审规则等。
3. 判断依据是该内容是否要求投标人在技术方案中展开具体方案内容；如果不是具体方案内容，即使带有分值或扣分规则，也归入技术评分要求。
4. 若原文存在层级关系，请保持顺序和来源，不要自行合并不相关条款。

输出格式：

## 技术评分项

【评分项名称】：<招标文件描述，保留专业术语>
【权重/分值】：<具体分值或占比>
【评分标准】：<详细规则>
【数据来源】：<章节、条款、页码或表格位置>

## 技术评分要求

【评分要求名称】：<要求或规则名称>
【适用范围】：<适用于哪些评分项或评审环节>
【要求/判定口径】：<具体要求、解释、扣分或判定规则>
【数据来源】：<章节、条款、页码或表格位置>

若某一类没有内容，请保留对应标题并写“没有提及”。直接返回提取结果。`,
  },
  { id: 'projectInfo', output: 'json', prompt: () => jsonTask('提取项目信息', '提取项目名称、项目编号、项目类型、项目预算、项目地址。', `{"project_name":"项目名称","project_number":"项目编号","project_type":"项目类型","project_budget":"项目预算","project_address":"项目地址"}`) },
  { id: 'partAInfo', output: 'json', prompt: () => jsonTask('提取甲方信息', '提取公司名称、地址、联系人、联系电话。', `{"company_name":"公司名称","address":"地址","contact_person":"联系人","contact_phone":"联系电话"}`) },
  { id: 'deliveryAndServiceRequirements', output: 'json', prompt: () => jsonTask('提取交货和服务要求', '提取实施周期/工期/交付期限、交付范围、交付/实施地点、验收要求、质保期、售后服务要求、响应时限、培训要求、资料/文档交付要求。', `{"implementation_period":"实施周期/工期/交付期限","delivery_scope":"交付范围","delivery_location":"交付/实施地点","acceptance_requirements":"验收要求","warranty_period":"质保期","after_sales_service":"售后服务要求","response_time":"响应时限","training_requirements":"培训要求","documentation_requirements":"资料/文档交付要求"}`) },
  {
    id: 'procurementList', output: 'markdown',
    prompt: () => `任务：提取招标文件、询比文件或采购文件中的采购清单/采购需求信息。

请从招标文件中识别与“采购清单、采购需求、采购内容、货物需求、服务内容、技术参数、规格要求、报价清单、分项报价、工程量清单”等含义相近的内容。

提取要求：
1. 优先保留招标文件中的表格、条目和字段含义，不要自行补充招标文件没有的信息。
2. 如果原文是表格，请尽量整理为 Markdown 表格；如果表格结构复杂，可以按“清单项 + 要求说明”的方式整理。
3. 如果不同章节分别描述采购内容、技术参数、数量、交付、验收、质保等要求，请合并整理，但要避免编造不存在的字段。
4. 字段名称不要求固定，按招标文件实际出现的信息组织，例如名称、规格型号、技术参数、单位、数量、预算/限价、交付地点、交付时间、验收要求、质保要求、备注等。
5. 如果没有找到明确采购清单，请说明“未找到明确采购清单”，并列出可能相关的采购需求段落摘要。
6. 只输出整理结果，不要输出分析过程。`,
  },
  {
    id: 'responseFileRequirements', output: 'markdown',
    prompt: () => `任务：提取招标文件、询比文件或采购文件中关于响应文件/投标文件编制与提交的要求。

请识别与“响应文件、投标文件、报价文件、资格证明文件、商务响应、技术响应、偏离表、响应文件格式、投标文件格式、递交要求、签字盖章、密封上传”等含义相近的内容。

提取要求：
1. 按招标文件实际结构整理，不要强制套用固定模板。
2. 重点提取响应文件需要包含哪些部分，例如报价文件、商务文件、技术文件、资格证明、承诺函、授权委托书、响应表、偏离表、分项报价表等。
3. 如果招标文件提供了固定格式、表格或附件模板，请提取模板名称、用途、填写要求和关键字段。
4. 提取签字盖章、文件命名、装订/密封、上传格式、份数、递交截止时间、递交方式等要求。
5. 保持投标文件中所列的响应文件顺序，保证后续编写响应文件时，可以直接按照你提取的结果一一对应编写。
6. 区分“必须提供”和“如适用/可选提供”的内容；如果招标文件没有明确区分，不要自行判断。
7. 不要生成供应商自己的最终响应文件，不要编造公司信息、报价、资质、承诺内容。
8. 如果没有找到明确响应文件要求，请说明“未找到明确响应文件要求”，并列出可能相关的投标/响应文件格式段落摘要。
9. 只输出整理结果，不要输出分析过程。`,
  },
  { id: 'agentInfo', output: 'json', prompt: () => jsonTask('提取代理机构信息', '提取代理机构名称、地址、联系人、电话、邮箱和银行账户信息。', `{"company_name":"公司名称","address":"地址","contact_person":"联系人","contact_phone":"联系电话","email":"联系邮箱","bank_account_name":"银行账户名称","bank_account_number":"银行账户账号","bank_account_address":"银行账户开户行","bank_account_address_detail":"银行账户开户行地址"}`) },
  { id: 'keyInfo', output: 'json', prompt: () => jsonTask('提取投标关键节点', '提取招标公告发布日期、招标文件获取方式、售价、获取时间、提交地点、截止时间、开标时间、开标地点和其他注意事项。', `{"bid_announcement_time":"招标公告发布日期","bid_file_get_way":"招标文件获取方式","bid_file_price":"招标文件售价","get_bid_file_time":"获取招标文件时间","bid_document_submission_location":"投标文件提交地点","bid_submission_deadline":"投标截止时间","bid_opening_time":"开标时间","bid_opening_address":"开标地点","other_notes":"其他注意事项"}`) },
  { id: 'marginInfo', output: 'json', prompt: () => jsonTask('提取投标保证金信息', '提取投标保证金、缴纳方式、截止日期、退还条件、不予退还情形和其他注意事项。', `{"bidding_deposit":"投标保证金","payment_method":"缴纳方式","due_date":"截止日期","refund_conditions":"退还条件","non_refundable_conditions":"不予退还的情形","other_notes":"其他注意事项"}`) },
  { id: 'qualificationReview', output: 'markdown', prompt: () => '任务：提取招标文件中关于投标人资格性审查的信息。整理成方便阅读的 Markdown，不要使用表格；如果招标文件是表格，请转换为列表。仅输出整理结果。' },
  { id: 'complianceCheck', output: 'markdown', prompt: () => '任务：总结招标文件中关于符合性检查的信息，包括文件完整性、文件有效性、文件规范、偏差处理等。整理成 Markdown，不要使用表格。仅输出整理结果。' },
  { id: 'openBid', output: 'json', prompt: () => jsonTask('提取开标信息', '提取时间地点、参与要求、无效标认定、异议处理、开标流程。', `{"time_place":"时间地点","part_req":"参与要求","invalid_bid":"无效标认定","objection":"异议处理","bid_process":"开标流程"}`) },
  { id: 'evaluationBid', output: 'json', prompt: () => jsonTask('提取评标信息', '提取评标委员会组成、职责、评分构成、评标方法类型、评标原则和方法细节、其他评标相关说明。', `{"committee":"评标委员会组成","duties":"评标委员会职责","scoring":"评分构成","method":"评标方法类型","principles":"评标原则和方法细节","others":"其他和评标相关的说明"}`) },
  { id: 'businessScoring', output: 'markdown', prompt: () => '任务：提取招标文件中的商务评分因素，为编写投标文件中的商务方案做准备。整理成 Markdown，不要使用表格。仅输出整理结果。' },
  { id: 'discardedBids', output: 'markdown', prompt: buildInvalidBidAndRejectionItemsPrompt },
  { id: 'signingProcess', output: 'json', prompt: () => jsonTask('提取合同授予和签订流程', '提取中标公示、合同签订、履约保证金、合同文本等信息。', `{"bid_notice":"中标公示","contract_sign":"合同签订","performance_bond":"履约保证金","contract_text":"合同文本"}`) },
  { id: 'terminationCondition', output: 'json', prompt: () => jsonTask('提取合同解除和终止条件', '提取违约解除、不可抗力、合同终止、争议解决等信息。', `{"breach_termination":"违约解除","force_majeure":"不可抗力","contract_termination":"合同终止","dispute_resolution":"争议解决"}`) },
];

const PROMPT_BY_ID = new Map(PROMPTS.map((definition) => [definition.id, definition]));

function definitionOf(id: TechnicalPlanBidItemId): PromptDefinition {
  const definition = PROMPT_BY_ID.get(id);
  if (!definition) throw new TypeError(`招标解析项不合法：${id}`);
  return definition;
}

/** 解析项的输出类型。 */
export function bidItemOutput(id: TechnicalPlanBidItemId): 'markdown' | 'json' {
  return definitionOf(id).output;
}

/** 解析项的任务提示词（与桌面版 buildTaskPrompt 相同：Markdown 解析项另加整项无结果规则）。 */
export function buildTaskPrompt(id: TechnicalPlanBidItemId): string {
  const definition = definitionOf(id);
  const prompt = definition.prompt();
  if (definition.output !== 'markdown') return prompt;
  return `${prompt}

整体无结果规则：仅当当前任务完全未提取到任何相关内容时，只返回“${MARKDOWN_MISSING_RESULT}”，不要附加标题、标点、解释或其他文字。只要提取到任何有效内容，就正常返回结果；局部字段或局部分类缺失时写“没有提及”，不要使用“${MARKDOWN_MISSING_RESULT}”。`;
}

function isMissingMarkdownResult(id: TechnicalPlanBidItemId, content: string): boolean {
  return definitionOf(id).output === 'markdown' && content.trim() === MARKDOWN_MISSING_RESULT;
}

/** 各解析项共用的前缀：system、投标范围提示（多标段时）与招标正文（与桌面版 buildTenderContextMessages 相同）。 */
export function buildTenderContextMessages(fileContent: string, sectionHint: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: STABLE_SYSTEM_PROMPT }];
  if (sectionHint) messages.push({ role: 'system', content: sectionHint });
  messages.push({ role: 'user', content: `以下是完整招标文件。后续任务需要基于这份招标文件完成；如后续消息提供补充上下文，请按具体任务要求综合使用：\n\n${fileContent}` });
  return messages;
}

function buildMessages(fileContent: string, id: TechnicalPlanBidItemId, sectionHint: string): ChatMessage[] {
  return [...buildTenderContextMessages(fileContent, sectionHint), { role: 'user', content: buildTaskPrompt(id) }];
}

interface SegmentResult {
  segmentIndex: number;
  totalSegments: number;
  content: string;
}

/** 分段结果的合并请求（与桌面版 segmentedAiResultMerger.cjs 的 buildMergeMessages 相同）。 */
function buildMergeMessages(segmentResults: readonly SegmentResult[], id: TechnicalPlanBidItemId, sectionHint: string): ChatMessage[] {
  const output = definitionOf(id).output;
  const messages: ChatMessage[] = [{ role: 'system', content: STABLE_SYSTEM_PROMPT }];
  if (sectionHint) messages.push({ role: 'system', content: sectionHint });
  const outputRequirement =
    output === 'json' ? '最终只返回一个 JSON 对象，不要输出 Markdown、代码块、解释或额外文字。' : '最终只返回整理后的 Markdown 内容，不要输出解释、过程或额外提示语。';
  const formatted = segmentResults.map((item) => `## 第 ${item.segmentIndex}/${item.totalSegments} 段解析结果\n${item.content.trim()}`).join('\n\n');
  messages.push({
    role: 'user',
    content: `以下内容来自同一份招标文件按段分别解析后的结果。每段结果只代表该片段内的信息，不代表整份文件的完整结论。

当前合并任务：${bidItemLabel(id) || '招标文件解析结果合并'}

合并要求：
1. 如果某段写“没有提及”“原文未提及”“本段未提及”或整段只有“未提取到”，只表示该片段没有相关信息；如果其他片段提供了有效信息，应以有效信息为准。
2. 删除重复、空泛、冲突的片段性表述，保留更完整、更具体的信息。
3. 保留所有有价值、可用于最终结果的信息，不要遗漏分段结果中的明确内容。
4. 不要新增分段结果中没有的信息，不要自行编造。
5. 如果所有分段都没有有效信息，遵守原始任务中的整体无结果规则。
6. 最终输出必须符合原始任务要求。
7. ${outputRequirement}

原始任务要求：
${buildTaskPrompt(id)}

分段解析结果：
${formatted}`,
  });
  return messages;
}

const normalizeHintText = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** 多标段时的投标范围提示（与桌面版 bidSectionContext.cjs 的 buildBidSectionContextHint 相同）。 */
export function buildBidSectionContextHint(
  section: { title?: unknown; headLine?: unknown; description?: unknown; evidence?: unknown } | null | undefined,
  options: { hasSelectedSection?: boolean } = {},
): string {
  const title = normalizeHintText(section?.title);
  const headLine = normalizeHintText(section?.headLine);
  const description = normalizeHintText(section?.description);
  const evidence = (Array.isArray(section?.evidence) ? section.evidence : []).map(normalizeHintText).filter(Boolean).slice(0, 6);
  if (!title && !headLine && !description && !evidence.length) {
    return options.hasSelectedSection === true ? '本项目为多标段，当前招标文件已按用户选择的投标范围处理。请以当前输入内容为准，不要主动扩展到其他标段。' : '';
  }
  const lines = ['本项目为多标段，当前招标文件已按用户选择的投标范围处理。请仅关注当前选择标段和当前输入内容，不要主动扩展到其他标段。'];
  if (title) lines.push(`当前选择标段：${title}`);
  if (headLine) lines.push(`AI 识别标题行：${headLine}`);
  if (description) lines.push(`AI 识别描述：${description}`);
  if (evidence.length) lines.push(`AI 识别依据：${evidence.join('；')}`);
  return lines.join('\n');
}

export interface BidAnalysisPromptInput {
  id: TechnicalPlanBidItemId;
  /** 招标正文已按上下文长度切分的结果（同一正文的各解析项共用）；空数组按一段处理。 */
  segments: readonly string[];
  sectionHint: string;
  /** 步骤键前缀（见文件头）。 */
  keyPrefix: string;
}

// 与桌面版相同，招标解析的调用不检查输出是否为空，由调用方处理。
const ALLOW_EMPTY = { allowEmpty: true } as const;

async function runOnce(chat: JobChat, input: BidAnalysisPromptInput, keyPrefix: string): Promise<string> {
  const { id, segments, sectionHint } = input;
  const label = bidItemLabel(id);
  if (segments.length <= 1) return chat.text(keyPrefix, buildMessages(segments[0] ?? '', id, sectionHint), `招标解析-${label}`, ALLOW_EMPTY);
  const segmentResults = await Promise.all(
    segments.map(async (segment, index) => ({
      segmentIndex: index + 1,
      totalSegments: segments.length,
      content: await chat.text(`${keyPrefix}:segment:${index + 1}`, buildMessages(segment, id, sectionHint), `招标解析-${label}-第${index + 1}段`, ALLOW_EMPTY),
    })),
  );
  return chat.text(`${keyPrefix}:merge`, buildMergeMessages(segmentResults, id, sectionHint), `招标解析合并-${label}`, ALLOW_EMPTY);
}

/** 运行一个解析项，返回模型输出（与桌面版 runBidAnalysisPromptTask 相同）。 */
export async function runBidAnalysisPrompt(chat: JobChat, input: BidAnalysisPromptInput): Promise<string> {
  const content = await runOnce(chat, input, input.keyPrefix);
  if (!isMissingMarkdownResult(input.id, content)) return content;
  return runOnce(chat, input, `${input.keyPrefix}:try-2`);
}
