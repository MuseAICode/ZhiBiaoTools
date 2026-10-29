// 招标文件中“无效投标”和“废标项”的解析（取代桌面版 bidAnalysisTask.cjs 的 runInvalidBidAndRejectionItemsExtraction）：废标检查的
// rejection-items-extraction 任务使用。提示词与流程与招标解析的“无效标与废标项”一项相同（prompts.ts），不带投标范围提示。
// 步骤键：单段时 extraction，多段时 extraction:segment:N 与 extraction:merge；整项无结果时重跑一次，前缀为 extraction:try-2。
import { splitTextByContextLimit, type SplitOptions } from '../ai/textSplit.ts';
import type { JobChat } from '../jobs/chat.ts';
import { runBidAnalysisPrompt } from './prompts.ts';

/** 解析无效投标与废标项，返回模型输出的 Markdown（外层的 ''' 由 saveExtraction 去掉）。 */
export async function extractInvalidBidAndRejectionItems(chat: JobChat, fileContent: string, split: SplitOptions = {}): Promise<string> {
  const segments = splitTextByContextLimit(fileContent, split);
  return runBidAnalysisPrompt(chat, { id: 'discardedBids', segments: segments.length ? segments : [fileContent], sectionHint: '', keyPrefix: 'extraction' });
}
