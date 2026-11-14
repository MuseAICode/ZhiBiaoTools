// 业务工具 request-termination（路线图第 8 步 8.4c2）：Agent 判断当前任务无法按要求继续时请求终止，由用户决定是否终止
// （桌面版 piTaskFailureTool.cjs 的 requestTerminationDecision 分支，问题、选项与继续时的执行要求沿用桌面版文字）。
//
// - 参数只有 reason（与 report-failure 相同，服务端规范化为纯文本）；问题与选项由服务端按固定文字生成，Agent 不能改选项；
// - 问题经 ask-user 的同一套存储与回答（src/agent/questions.ts、POST /api/jobs/:jobId/answer）：一次调用至多等待 50 秒，
//   仍未回答返回 { answered: false, pending: true }，由沙箱内的桩以相同的参数再次调用（8.6）；等待超过 10 分钟任务暂停为
//   waiting_for_user，回答后自动继续，续跑时 Agent 以相同的 reason 再次请求即取回答案；
// - 用户选择“终止任务”：在取回答案的同一个事务中写入失败报告（agent_failure_reports，原因后附“已按您的选择终止任务”），
//   通知执行者，任务以 AGENT_REPORTED_FAILURE 失败（与 8.4b 相同）；返回 { terminated: true }，Agent 应立即停止；
// - 用户选择继续（或补充要求）：返回 { terminated: false, instruction }，instruction 是放宽后的执行要求（与桌面版相同）；
//   用户的补充要求是不可信文本（已规范化），只作为工具结果交给 Agent；
// - 同一会话再次请求终止时桌面版要求人工确认（不自动作答）：Web 版没有自动确认，每次都由用户回答，自然满足。
//
// 失败交回父 Agent 的子会话（桌面版 failure_handled_by_parent）不经用户决定，使用 8.4b 的 report-failure；
// 一个任务类型只能登记两者之一（createJobTypeRegistry 检查）。
import { AppError } from '../errors.ts';
import { ASK_USER_POLL_MS, ASK_USER_WAIT_MS, waitForAgentAnswer } from './askUserTool.ts';
import { AGENT_FAILURE_REASON_MAX_LENGTH, normalizeAgentFailureReason, normalizeAgentPlainText, recordAgentFailureReport } from './failureReport.ts';
import { normalizeAgentQuestion, type AgentAnswer, type AgentQuestionInput } from './questions.ts';
import type { AgentToolDefinition } from './tools.ts';

export const REQUEST_TERMINATION_TOOL_NAME = 'request-termination';

/** 选项（与桌面版相同）。第一项“降低质量继续”为推荐项。 */
export const TERMINATION_CONTINUE_OPTION = { label: '降低质量继续', description: '放宽质量要求，只保证流程能完成，结果需要人工核对', custom: false } as const;
export const TERMINATION_TERMINATE_OPTION = { label: '终止任务', description: '结束当前任务，可补充资料或调整设置后重新执行', custom: false } as const;
export const TERMINATION_CUSTOM_OPTION = { label: '补充处理要求', description: '输入您希望 Agent 如何继续处理', custom: true } as const;
export const TERMINATION_OPTIONS = [TERMINATION_CONTINUE_OPTION, TERMINATION_TERMINATE_OPTION, TERMINATION_CUSTOM_OPTION] as const;

/** 用户选择终止时附在失败说明后面的文字（与桌面版相同）。 */
export const TERMINATED_BY_USER_SUFFIX = '（已按您的选择终止任务）';

export interface RequestTerminationArguments {
  reason: string;
}

export type RequestTerminationResult =
  | { terminated: true; reason: string }
  | { terminated: false; selected_option: string; user_reply?: string; instruction: string }
  | { answered: false; pending: true; message: string };

const PENDING_MESSAGE = '用户尚未决定是否终止，请以完全相同的参数再次调用 request-termination 继续等待';

/** 向用户提出的问题（与桌面版 buildTerminationQuestion 相同）。reason 已规范化。 */
export function buildTerminationQuestion(reason: string): AgentQuestionInput {
  return {
    question: `Agent 认为当前任务无法按原要求继续：\n\n${reason}\n\n继续执行需要降低质量要求：数量、篇幅、专业性和资料依据都会放宽，内容可能不完整、与项目实际不符，需要您后续人工核对。是否终止当前任务？`,
    options: TERMINATION_OPTIONS,
  };
}

/** 用户选择继续时交给 Agent 的执行要求（与桌面版 buildContinueInstruction 相同）。 */
export function buildContinueInstruction(answer: AgentAnswer): string {
  const lines = [
    '用户选择不终止任务，要求继续执行。',
    '- 质量要求已放宽：任务要求中的数量、篇幅、层级、专业性、资料依据和真实性等质量要求均可降低或放弃，不足部分可用通用内容、推测内容或占位内容补齐。',
    '- 唯一底线：按任务要求写出必需文件，结构和格式通过程序校验，使流程能够稳定进入下一步。',
    '- 不得以同一原因再次请求终止，立即调整做法继续执行。',
  ];
  if (answer.is_custom) {
    lines.push(`用户补充要求：${answer.answer}`, '该要求优先执行，与上述放宽规则冲突时以用户要求为准。');
  }
  return lines.join('\n');
}

/** 写入失败报告的原因：reason 截短到与后缀合起来不超过 AGENT_FAILURE_REASON_MAX_LENGTH 个字符。 */
export function terminatedFailureReason(reason: string): string {
  const room = AGENT_FAILURE_REASON_MAX_LENGTH - Array.from(TERMINATED_BY_USER_SUFFIX).length;
  return `${normalizeAgentPlainText(reason, room)}${TERMINATED_BY_USER_SUFFIX}`;
}

export interface RequestTerminationToolOptions {
  waitMs?: number;
  pollMs?: number;
}

export function createRequestTerminationTool(options: RequestTerminationToolOptions = {}): AgentToolDefinition<RequestTerminationArguments, RequestTerminationResult> {
  const waitMs = options.waitMs ?? ASK_USER_WAIT_MS;
  const pollMs = options.pollMs ?? ASK_USER_POLL_MS;
  return {
    name: REQUEST_TERMINATION_TOOL_NAME,
    argumentsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['reason'],
      properties: {
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: AGENT_FAILURE_REASON_MAX_LENGTH,
          description: '面向普通用户的无法继续原因，会展示给用户用于决定是否终止任务（纯文本）。',
        },
      },
    },
    // 与 report-failure 相同：500 个字符按 UTF-8 与 JSON 转义留出余量。
    maxArgumentBytes: 4096,
    // 一次请求等到超时暂停约 13 次调用；够约 20 次请求都等到超时（跨执行累计）。参数不合法的调用同样计入。
    maxCallsPerJob: 300,
    maxCallsPerMinute: 20,
    async run(context, args) {
      const reason = normalizeAgentFailureReason(args.reason);
      if (reason.length === 0) throw new AppError(400, 'AGENT_TOOL_INVALID_ARGUMENTS', '工具参数不合法：/reason 去掉空白与控制字符后不能为空');
      const ref = { tenant: context.tenant, jobId: context.identity.jobId, runId: context.identity.runId };
      let terminated = false;
      const answer = await waitForAgentAnswer(context, normalizeAgentQuestion(buildTerminationQuestion(reason)), {
        waitMs,
        pollMs,
        // 用户选择终止：与取回答案在同一个事务中写入失败报告（任务行已锁住、仍是本次执行且没有报告）；写不进去时整体回滚。
        onConsumed: async (trx, consumed) => {
          if (consumed.selected_option !== TERMINATION_TERMINATE_OPTION.label) return;
          const recorded = await recordAgentFailureReport(trx, ref, terminatedFailureReason(reason));
          if (recorded === null) throw new AppError(409, 'JOB_NOT_RUNNING', '任务不在执行中，不能调用工具');
          terminated = true;
        },
      });
      if (answer === null) return { answered: false, pending: true, message: PENDING_MESSAGE };
      if (terminated) {
        // 执行者立即续租一次，发现报告后中止本次执行（与 report-failure 相同）。
        await context.notifyExecutor();
        context.log.info({ jobId: ref.jobId, tokenId: context.identity.logId }, 'agent terminated by user decision');
        return { terminated: true, reason };
      }
      return {
        terminated: false,
        selected_option: answer.selected_option,
        ...(answer.is_custom ? { user_reply: answer.answer } : {}),
        instruction: buildContinueInstruction(answer),
      };
    },
  };
}

export const requestTerminationTool = createRequestTerminationTool();
