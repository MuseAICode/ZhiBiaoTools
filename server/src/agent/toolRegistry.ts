// 生产环境登记的 Agent 业务工具（8.4a 起；src/agent/tools.ts）。8.4b 起的各工具在这里追加，测试用的工具只在 tests/ 中登记。
// 每个 Agent 任务类型在 JobTypeDefinition.agentTools 中列出自己可用的工具，worker 启动时检查都已登记。
import { askUserTool } from './askUserTool.ts';
import { reportFailureTool } from './reportFailureTool.ts';
import { requestTerminationTool } from './requestTerminationTool.ts';
import { createAgentToolRegistry, type AgentToolDefinition } from './tools.ts';
import { generateSectionsTool } from '../technicalPlan/contentSectionGeneration.ts';
import { submissionFixTool } from '../technicalPlan/contentSubmissionFix.ts';
import { checkWordCountTool } from '../technicalPlan/contentWordCount.ts';

export const AGENT_TOOLS: readonly AgentToolDefinition<any, any>[] = Object.freeze([
  // 8.4b：Agent 报告无法继续，执行者据此结束任务（AGENT_REPORTED_FAILURE）。
  reportFailureTool,
  // 8.4c1：Agent 向用户提问，等待回答（超过 10 分钟任务暂停为 waiting_for_user）。
  askUserTool,
  // 8.4c2：Agent 请求终止，由用户决定是否终止（与 report-failure 二选一登记）。
  requestTerminationTool,
  // 8.10c2b2：正文生成写作阶段的批量小节生成（长时工具，由执行者执行，src/agent/toolRequests.ts）。
  generateSectionsTool,
  // 8.10c3b1：正文写作阶段的字数统计（长时工具，由执行者执行）；全部正文就绪后进入图片保护。
  checkWordCountTool,
  // 8.10c3b3：提交校验退回的小节问题由沙箱内的并发子会话修复（长时工具，由执行者执行）。
  submissionFixTool,
]);

export const agentToolRegistry = createAgentToolRegistry(AGENT_TOOLS);
