// 招标文件中“无效投标”和“废标项”的解析（取代桌面版 bidAnalysisTask.cjs 的 runInvalidBidAndRejectionItemsExtraction，提示词与流程
// 原样搬运）：废标检查的 rejection-items-extraction 任务使用；6.11 迁移招标解析时，其余解析项与本文件的公共部分合并到同一模块。
//
// 流程：招标正文按上下文长度切分；只有一段时直接调用一次；多段时各段并发调用、再调用一次合并。整项无结果（只返回“未提取到”）
// 时完整重跑一次，第二次的结果原样返回。步骤键：extraction[:try-2]:segment:N / :merge / 单段时 extraction[:try-2]。
import type { ChatMessage } from '../ai/providers.ts';
import { splitTextByContextLimit, type SplitOptions } from '../ai/textSplit.ts';
import type { JobChat } from '../jobs/chat.ts';

const MARKDOWN_MISSING_RESULT = '未提取到';

const STABLE_SYSTEM_PROMPT = `你是专业的投标资料分析助手。请严格基于用户提供的上下文完成提取和总结。

通用要求：
1. 保持信息全面、准确，优先使用用户提供上下文中的内容；除非具体任务明确要求或允许根据经验补充，否则不要自行编造
2. 已提取到相关内容但局部信息没有提及时，明确写“没有提及”
3. 只输出最终结果，不输出过程、提示语或客套话
4. 始终使用简体中文`;

const DISCARDED_BIDS_LABEL = '无效标与废标项';

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

/** Markdown 解析项统一约定整项无结果标记（与桌面版 buildTaskPrompt 相同）。 */
function buildTaskPrompt(): string {
  return `${buildInvalidBidAndRejectionItemsPrompt()}

整体无结果规则：仅当当前任务完全未提取到任何相关内容时，只返回“${MARKDOWN_MISSING_RESULT}”，不要附加标题、标点、解释或其他文字。只要提取到任何有效内容，就正常返回结果；局部字段或局部分类缺失时写“没有提及”，不要使用“${MARKDOWN_MISSING_RESULT}”。`;
}

function buildMessages(fileContent: string): ChatMessage[] {
  return [
    { role: 'system', content: STABLE_SYSTEM_PROMPT },
    { role: 'user', content: `以下是完整招标文件。后续任务需要基于这份招标文件完成；如后续消息提供补充上下文，请按具体任务要求综合使用：\n\n${fileContent}` },
    { role: 'user', content: buildTaskPrompt() },
  ];
}

interface SegmentResult {
  segmentIndex: number;
  totalSegments: number;
  content: string;
}

/** 分段结果的合并请求（与桌面版 segmentedAiResultMerger.cjs 的 buildMergeMessages 相同，输出为 Markdown）。 */
function buildMergeMessages(segmentResults: readonly SegmentResult[]): ChatMessage[] {
  const formatted = segmentResults
    .map((item) => `## 第 ${item.segmentIndex}/${item.totalSegments} 段解析结果\n${item.content.trim()}`)
    .join('\n\n');
  return [
    { role: 'system', content: STABLE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `以下内容来自同一份招标文件按段分别解析后的结果。每段结果只代表该片段内的信息，不代表整份文件的完整结论。

当前合并任务：${DISCARDED_BIDS_LABEL}

合并要求：
1. 如果某段写“没有提及”“原文未提及”“本段未提及”或整段只有“未提取到”，只表示该片段没有相关信息；如果其他片段提供了有效信息，应以有效信息为准。
2. 删除重复、空泛、冲突的片段性表述，保留更完整、更具体的信息。
3. 保留所有有价值、可用于最终结果的信息，不要遗漏分段结果中的明确内容。
4. 不要新增分段结果中没有的信息，不要自行编造。
5. 如果所有分段都没有有效信息，遵守原始任务中的整体无结果规则。
6. 最终输出必须符合原始任务要求。
7. 最终只返回整理后的 Markdown 内容，不要输出解释、过程或额外提示语。

原始任务要求：
${buildTaskPrompt()}

分段解析结果：
${formatted}`,
    },
  ];
}

// 与桌面版相同，招标解析的调用不检查输出是否为空，由任务按“模型未返回解析内容”处理。
const ALLOW_EMPTY = { allowEmpty: true } as const;

async function extractOnce(chat: JobChat, fileContent: string, keyPrefix: string, split: SplitOptions): Promise<string> {
  const segments = splitTextByContextLimit(fileContent, split);
  if (segments.length <= 1) return chat.text(keyPrefix, buildMessages(segments[0] ?? fileContent), `招标解析-${DISCARDED_BIDS_LABEL}`, ALLOW_EMPTY);
  const segmentResults = await Promise.all(
    segments.map(async (segment, index) => ({
      segmentIndex: index + 1,
      totalSegments: segments.length,
      content: await chat.text(`${keyPrefix}:segment:${index + 1}`, buildMessages(segment), `招标解析-${DISCARDED_BIDS_LABEL}-第${index + 1}段`, ALLOW_EMPTY),
    })),
  );
  return chat.text(`${keyPrefix}:merge`, buildMergeMessages(segmentResults), `招标解析合并-${DISCARDED_BIDS_LABEL}`, ALLOW_EMPTY);
}

/** 解析无效投标与废标项，返回模型输出的 Markdown（外层的 ''' 由 saveExtraction 去掉）。 */
export async function extractInvalidBidAndRejectionItems(chat: JobChat, fileContent: string, split: SplitOptions = {}): Promise<string> {
  const content = await extractOnce(chat, fileContent, 'extraction', split);
  if (content.trim() !== MARKDOWN_MISSING_RESULT) return content;
  return extractOnce(chat, fileContent, 'extraction:try-2', split);
}
