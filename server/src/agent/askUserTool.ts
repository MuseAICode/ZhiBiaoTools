// 业务工具 ask-user（路线图第 8 步 8.4c1；src/agent/questions.ts）：Agent 在关键事项无法从材料中确定时向用户提一个问题，
// 等待用户在页面上回答。参数与桌面版相同（question、options[{ label, description?, custom }]），服务端规范化为纯文本并检查选项规则；
// 任务的组织、项目与本次执行全部按令牌取。
//
// 一次调用至多等待 waitMs（默认 50 秒，短于 agent-gw 的转发时限），期间每 pollMs 查一次：
// - 已回答：返回 { answered: true, answer, selected_option, is_custom }（与桌面版相同）；
// - 仍未回答：返回 { answered: false, pending: true, ... }，沙箱内的桩以相同的参数再次调用继续等待（8.6；同一个问题不会重复新建）；
// - 任务不在本次执行中、问题已被作废：409 JOB_NOT_RUNNING；本次执行已有另一个问题在等待：409 AGENT_QUESTION_PENDING。
// 等待超过 10 分钟由执行者暂停任务（waiting_for_user），与本工具的单次等待无关。
import { withTenant } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import {
  AGENT_QUESTION_DESCRIPTION_MAX_LENGTH,
  AGENT_QUESTION_LABEL_MAX_LENGTH,
  AGENT_QUESTION_MAX_LENGTH,
  AGENT_QUESTION_MAX_OPTIONS,
  AGENT_QUESTION_MIN_OPTIONS,
  normalizeAgentQuestion,
  openAgentQuestion,
  pollAgentQuestion,
  type AgentAnswer,
  type AgentAnswerConsumedHook,
  type AgentQuestionInput,
  type AgentQuestionState,
  type NormalizedAgentQuestion,
} from './questions.ts';
import type { AgentToolContext, AgentToolDefinition } from './tools.ts';

export const ASK_USER_TOOL_NAME = 'ask-user';

/** 一次调用至多等待的时间（毫秒）：短于 agent-gw 的转发时限（AGENT_GW_RESPONSE_TIMEOUT_MS，10 分钟）。 */
export const ASK_USER_WAIT_MS = 50_000;
/** 等待中查询回答的间隔（毫秒）。 */
export const ASK_USER_POLL_MS = 1_000;

export interface AskUserPending {
  answered: false;
  pending: true;
  message: string;
}

export type AskUserResult = AgentAnswer | AskUserPending;

const PENDING_MESSAGE = '用户尚未回答，请以完全相同的参数再次调用 ask-user 继续等待';

function notRunning(): AppError {
  return new AppError(409, 'JOB_NOT_RUNNING', '任务不在执行中，不能调用工具');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface AskUserToolOptions {
  waitMs?: number;
  pollMs?: number;
}

export interface AgentAnswerWaitOptions {
  waitMs: number;
  pollMs: number;
  /** 答案交给本次执行时在同一事务中调用（见 AgentAnswerConsumedHook）。 */
  onConsumed?: AgentAnswerConsumedHook;
}

/**
 * 提出问题并至多等待 waitMs（ask-user 与 8.4c2 的 request-termination 共用）：已回答返回答案，仍未回答返回 null
 * （由沙箱内的桩以相同参数再次调用）；本次执行另有问题在等待 409 AGENT_QUESTION_PENDING，任务不在本次执行中 409 JOB_NOT_RUNNING。
 */
export async function waitForAgentAnswer(
  context: AgentToolContext,
  question: NormalizedAgentQuestion,
  options: AgentAnswerWaitOptions,
): Promise<AgentAnswer | null> {
  const ref = { tenant: context.tenant, jobId: context.identity.jobId, runId: context.identity.runId };
  let state: AgentQuestionState = await withTenant(context.db, context.tenant, (trx) => openAgentQuestion(trx, ref, question, options.onConsumed));
  if (state.kind === 'pending' && state.created) {
    context.log.info({ jobId: ref.jobId, tokenId: context.identity.logId, questionId: state.questionId }, 'agent asked user');
    await context.notifyQuestion(state.questionId, 'pending');
  }
  const deadline = Date.now() + options.waitMs;
  while (state.kind === 'pending' && Date.now() < deadline && !context.signal.aborted) {
    await sleep(Math.min(options.pollMs, Math.max(deadline - Date.now(), 0)), context.signal);
    if (context.signal.aborted) break;
    const questionId: string = state.questionId;
    state = await withTenant(context.db, context.tenant, (trx) => pollAgentQuestion(trx, ref, questionId, options.onConsumed));
  }
  if (state.kind === 'answered') return state.answer;
  if (state.kind === 'conflict') throw new AppError(409, 'AGENT_QUESTION_PENDING', '已有一个问题在等待用户回答，请先等待该问题的回答');
  if (state.kind === 'not-running') throw notRunning();
  return null;
}

export function createAskUserTool(options: AskUserToolOptions = {}): AgentToolDefinition<AgentQuestionInput, AskUserResult> {
  const waitMs = options.waitMs ?? ASK_USER_WAIT_MS;
  const pollMs = options.pollMs ?? ASK_USER_POLL_MS;
  return {
    name: ASK_USER_TOOL_NAME,
    argumentsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'options'],
      properties: {
        question: {
          type: 'string',
          minLength: 1,
          maxLength: AGENT_QUESTION_MAX_LENGTH,
          description: '需要普通用户确认的具体业务问题（纯文本，可分行列出要点）。',
        },
        options: {
          type: 'array',
          minItems: AGENT_QUESTION_MIN_OPTIONS,
          maxItems: AGENT_QUESTION_MAX_OPTIONS,
          description: '候选选项，第一项必须是 custom=false 的推荐选项；至多一个 custom=true 的选项。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'custom'],
            properties: {
              label: { type: 'string', minLength: 1, maxLength: AGENT_QUESTION_LABEL_MAX_LENGTH, description: '简短明确的操作名称。' },
              description: { type: 'string', maxLength: AGENT_QUESTION_DESCRIPTION_MAX_LENGTH, description: '该选项的业务结果或影响。' },
              custom: { type: 'boolean', description: '选中后是否需要用户输入具体要求。' },
            },
          },
        },
      },
    },
    // 问题 2,000 个字符、5 个选项各 360 个字符，按 UTF-8 与 JSON 转义留出余量。
    maxArgumentBytes: 32 * 1024,
    // 每次调用至多等待 50 秒，一个问题等待 10 分钟约 12 次；参数不合法的调用同样计入。
    maxCallsPerJob: 2_000,
    maxCallsPerMinute: 20,
    async run(context, args) {
      const answer = await waitForAgentAnswer(context, normalizeAgentQuestion(args), { waitMs, pollMs });
      return answer ?? { answered: false, pending: true, message: PENDING_MESSAGE };
    },
  };
}

export const askUserTool = createAskUserTool();
