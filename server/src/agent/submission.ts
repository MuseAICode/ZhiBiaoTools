// Agent 结果的提交校验与修复决策（路线图第 8 步 8.6d1；docs/SERVER_DESIGN.md 第 7.27 节）。
//
// 与桌面版 client/electron/services/pi/piSubmissionPolicy.cjs 相同的规则：每次提交由任务按固定规则校验，得到问题清单
// （blocking：阻塞后续流程；quality：质量瑕疵）与“质量剩余量”；按相邻两次提交的进展决定接受、继续修复、更换方法或按最低目标
// 再修一轮，最低目标修复后仍有阻塞问题即停止。提交修复没有固定次数上限（与桌面版相同），由“连续两次没有进展”收敛；
// 每次修复都是一条新的提示词，同样计入任务的轮数与费用上限（8.3a），被注入的 Agent 不能借此无限消耗。
//
// 问题说明由任务（平台代码）按校验结果写出，可能引用 Agent 写出的内容（例如小节 id），在这里只当作纯文本拼进提示词。

export type AgentSubmissionSeverity = 'blocking' | 'quality';

export interface AgentSubmissionIssue {
  readonly severity: AgentSubmissionSeverity;
  readonly message: string;
}

export interface AgentSubmissionReport<V = unknown> {
  /** 通过时交给任务的结果（只在 accept 时使用）。 */
  readonly value: V | null;
  readonly issues: readonly AgentSubmissionIssue[];
  /** 质量剩余量（例如还差多少字）；省略时按 quality 问题的条数。 */
  readonly progress?: number;
  /** 最低目标修复时的完成目标；省略时用默认说明。 */
  readonly minimumGoal?: string;
}

export type AgentSubmissionDecision =
  | { readonly action: 'accept' }
  | { readonly action: 'stop' }
  | { readonly action: 'repair'; readonly mode: 'normal' | 'change-strategy' | 'minimum'; readonly attempt: number };

export interface AgentSubmissionPolicy {
  /** 已发出的修复次数。 */
  readonly attempts: number;
  inspect(report: AgentSubmissionReport): AgentSubmissionDecision;
}

/** 校验报告的问题条数与说明长度上限（报告来自平台代码，上限只防止任务写出过大的提示词）。 */
export const AGENT_SUBMISSION_MAX_ISSUES = 200;
export const AGENT_SUBMISSION_MAX_MESSAGE_CHARS = 2_000;

/** 检查任务给出的校验报告的形状（程序错误时抛 TypeError）。 */
export function assertAgentSubmissionReport(report: unknown): asserts report is AgentSubmissionReport {
  const value = report as Partial<AgentSubmissionReport> | null;
  if (typeof value !== 'object' || value === null || !Array.isArray(value.issues) || value.issues.length > AGENT_SUBMISSION_MAX_ISSUES) {
    throw new TypeError('提交校验报告不合法');
  }
  for (const issue of value.issues) {
    if (
      typeof issue !== 'object' || issue === null ||
      (issue.severity !== 'blocking' && issue.severity !== 'quality') ||
      typeof issue.message !== 'string' || issue.message.trim() === '' || issue.message.length > AGENT_SUBMISSION_MAX_MESSAGE_CHARS
    ) {
      throw new TypeError('提交校验报告不合法');
    }
  }
  if (value.progress !== undefined && !(Number.isFinite(value.progress) && value.progress >= 0)) throw new TypeError('提交校验报告不合法');
  if (value.minimumGoal !== undefined && (typeof value.minimumGoal !== 'string' || value.minimumGoal.length > AGENT_SUBMISSION_MAX_MESSAGE_CHARS)) {
    throw new TypeError('提交校验报告不合法');
  }
}

/** 按相邻两次提交的阻塞问题数与质量剩余量判断进展；每个阶段一个实例（与桌面版 createSubmissionPolicy 相同）。 */
export function createAgentSubmissionPolicy(): AgentSubmissionPolicy {
  let previous: { blocking: number; remaining: number } | null = null;
  let stalled = 0;
  let repairCount = 0;
  let minimumAttempted = false;
  return {
    get attempts() {
      return repairCount;
    },
    inspect(report) {
      assertAgentSubmissionReport(report);
      const blocking = report.issues.filter((issue) => issue.severity === 'blocking');
      if (minimumAttempted) return { action: blocking.length ? 'stop' : 'accept' };
      if (!report.issues.length) return { action: 'accept' };
      const current = {
        blocking: blocking.length,
        remaining: report.progress ?? report.issues.filter((issue) => issue.severity === 'quality').length,
      };
      if (previous) {
        const improved = current.blocking < previous.blocking || (current.blocking === 0 && previous.blocking === 0 && current.remaining < previous.remaining);
        stalled = improved ? 0 : stalled + 1;
      }
      previous = current;
      if (stalled >= 2 && !blocking.length) return { action: 'accept' };
      const mode = stalled >= 2 ? 'minimum' : stalled === 1 ? 'change-strategy' : 'normal';
      if (mode === 'minimum') minimumAttempted = true;
      repairCount += 1;
      return { action: 'repair', mode, attempt: repairCount };
    },
  };
}

const DEFAULT_MINIMUM_GOAL = '解决下列阻塞问题，使当前产物能被后续流程正常读取和使用。';

/** 提交修复的提示词（与桌面版 buildSubmissionRepairPrompt 相同）：业务提示给出文件与工具细节，这里统一决定换方法与最低目标。 */
export function buildAgentSubmissionRepairPrompt(
  report: AgentSubmissionReport,
  decision: Extract<AgentSubmissionDecision, { action: 'repair' }>,
  businessPrompt = '',
): string {
  const issues = decision.mode === 'minimum' ? report.issues.filter((issue) => issue.severity === 'blocking') : report.issues;
  const messages = issues.map((issue, index) => `${index + 1}. ${issue.message}`).join('\n');
  const instruction =
    decision.mode === 'minimum'
      ? `连续两次修复未取得进展。现在进行最后一轮最低目标修复。\n最低完成目标：${report.minimumGoal || DEFAULT_MINIMUM_GOAL}\n本轮只要求消除上述阻塞问题，暂不要求消除一致性、表格、字数等质量瑕疵；此前业务提示中的质量完成条件本轮不再作为验收条件。完成最低目标后重新提交；如果仍有阻塞问题，任务将停止。`
      : decision.mode === 'change-strategy'
        ? '上一轮修复未取得进展。先核对最新产物并定位原方法未解决问题的原因，再更换具体处理方法；不要重复相同操作。可使用当前可用工具和命令验证新的处理方法，修复后重新提交。'
        : '保留已完成成果，根据当前问题修复后重新提交。';
  return [businessPrompt, `本轮待修复问题：\n${messages}`, `这是本阶段第 ${decision.attempt} 次提交修复。`, instruction].filter(Boolean).join('\n\n');
}

/** 还原了受保护文件时附在修复提示词中的说明（与桌面版相同）。 */
export function restoredFilesNotice(restored: readonly string[]): string {
  return restored.length ? `程序已还原被改动的文件：${restored.join('、')}。这些文件由程序维护，不要修改。` : '';
}

/** 执行失败后的自动重试次数上限（与桌面版 MAX_RETRIES 相同）。 */
export const AGENT_MAX_EXECUTION_RETRIES = 3;

/**
 * 执行失败后的重试提示词（桌面版 buildRetryPrompt）：原因由 worker 按任务状态判断、是固定的说明（不采信沙箱的说法）；
 * outputFile 为任务给出的结果文件。
 */
export function buildAgentExecutionRetryPrompt(reason: string, outputFile: string, attempt: number, maxRetries: number): string {
  return `上一轮执行失败：${reason}

本次结果文件：${outputFile}。在当前会话和工作区中，根据上述错误修复该文件。继续遵守当前阶段的可修改范围、工具权限及完成条件；已有文件优先局部修正，不因重试扩大修改范围或重新执行已完成阶段。
这是第 ${attempt}/${maxRetries} 次自动修复机会。`;
}
