// Agent 向用户提问（ask-user，路线图第 8 步 8.4c1，迁移 0039_agent_questions；docs/SERVER_DESIGN.md 第 7.17 节）。
//
// 桌面版的 ask-user（piUserQuestionTool.cjs）在工具调用中等待用户在对话框中选择；Web 版中工具经 RPC 执行
// （src/agent/askUserTool.ts），问题存进 agent_questions，用户经 POST /api/jobs/:jobId/answer 回答：
//
// - 问题与选项是**沙箱给出的不可信文本**（可能被提示注入，威胁模型 T10）：服务端规范化为纯文本（去掉控制字符、双向文本与
//   零宽字符），问题至多 AGENT_QUESTION_MAX_LENGTH 个字符，选项名称与说明为单行文本；前端按纯文本显示、标明由 AI 生成
//   （第 9 步）。选项的规则与桌面版相同：2～5 个，第一项是推荐项且不能要求用户输入，至多一个“自定义输入”选项；
// - 每个任务同时至多一个未关闭的问题。工具调用至多等待 waitMs（短于 agent-gw 的转发时限），没有回答时返回 { answered: false }，
//   沙箱内的桩以相同的参数再次调用继续等待（8.6）；同一次执行中重复提出同一个问题不会新建问题；
// - 等待超过 AGENT_QUESTION_TIMEOUT_SECONDS（10 分钟）：执行者在续租时发现，中止本次执行并暂停为 waiting_for_user
//   （释放沙箱与并发名额，之后的等待不计入每日运行时长）；用户回答后任务自动回到 queued，续跑时 Agent 再次提出同一个问题
//   （按问题与选项的 SHA-256 认出）即取回答案；续跑中提出了不同的问题时旧问题作废；
// - 回答人限任务发起人或组织 owner / admin（数据库触发器再检查一次）。
import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import {
  AGENT_QUESTION_MAX_LENGTH,
  AGENT_QUESTION_MAX_OPTIONS,
  AGENT_QUESTION_MIN_OPTIONS,
  AGENT_WAITING_FOR_USER_PAUSE_REASON,
} from '../db/migrations/0039_agent_questions.ts';
import type { AgentQuestionOption, AgentQuestionStatus, Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { findAgentFailureReport, normalizeAgentPlainText } from './failureReport.ts';

export {
  AGENT_QUESTION_ANSWER_ROLES,
  AGENT_QUESTION_MAX_LENGTH,
  AGENT_QUESTION_MAX_OPTIONS,
  AGENT_QUESTION_MIN_OPTIONS,
  AGENT_WAITING_FOR_USER_PAUSE_REASON,
} from '../db/migrations/0039_agent_questions.ts';

/** 等待用户回答多久后暂停（秒；8.4c1 开始前用户确认：10 分钟）。 */
export const AGENT_QUESTION_TIMEOUT_SECONDS = 10 * 60;
/** 选项名称、说明的最大字符数（单行）。 */
export const AGENT_QUESTION_LABEL_MAX_LENGTH = 60;
export const AGENT_QUESTION_DESCRIPTION_MAX_LENGTH = 300;

type Trx = Transaction<Database>;

export interface AgentQuestionInput {
  question: string;
  options: readonly { label: string; description?: string; custom: boolean }[];
}

export interface NormalizedAgentQuestion {
  question: string;
  options: AgentQuestionOption[];
  /** 问题与选项（规范化后）的 SHA-256：续跑时认出同一个问题。 */
  contentHash: Buffer;
}

/** 交给 Agent 的回答（字段与桌面版相同）。 */
export interface AgentAnswer {
  answered: true;
  answer: string;
  selected_option: string;
  is_custom: boolean;
}

function invalid(message: string): AppError {
  return new AppError(400, 'AGENT_TOOL_INVALID_ARGUMENTS', `工具参数不合法：${message}`);
}

/** 规范化并检查 Agent 给出的问题；不合法时抛 400 AGENT_TOOL_INVALID_ARGUMENTS（说明供模型修正）。 */
export function normalizeAgentQuestion(input: AgentQuestionInput): NormalizedAgentQuestion {
  const question = normalizeAgentPlainText(input.question, AGENT_QUESTION_MAX_LENGTH);
  if (question.length === 0) throw invalid('/question 去掉空白与控制字符后不能为空');
  if (input.options.length < AGENT_QUESTION_MIN_OPTIONS || input.options.length > AGENT_QUESTION_MAX_OPTIONS) {
    throw invalid(`/options 须有 ${AGENT_QUESTION_MIN_OPTIONS}～${AGENT_QUESTION_MAX_OPTIONS} 个选项`);
  }
  const options = input.options.map((option, index) => {
    const label = normalizeAgentPlainText(option.label, AGENT_QUESTION_LABEL_MAX_LENGTH, { singleLine: true });
    if (label.length === 0) throw invalid(`/options/${index}/label 去掉空白与控制字符后不能为空`);
    const description = normalizeAgentPlainText(option.description ?? '', AGENT_QUESTION_DESCRIPTION_MAX_LENGTH, { singleLine: true });
    return { label, description, custom: option.custom === true };
  });
  if (options[0]!.custom) throw invalid('推荐选项（第一项）不能要求用户补充输入，请调整选项后重新提问');
  if (options.filter((option) => option.custom).length > 1) throw invalid('自定义输入选项最多只能有一个，请调整选项后重新提问');
  if (new Set(options.map((option) => option.label)).size !== options.length) throw invalid('选项名称不能重复');
  const contentHash = createHash('sha256').update(JSON.stringify({ question, options }), 'utf8').digest();
  return { question, options, contentHash };
}

/** 用户的回答规范化（自定义输入的要求）；不合法时抛 400。 */
export function normalizeAgentCustomAnswer(raw: string): string {
  return normalizeAgentPlainText(raw, AGENT_QUESTION_MAX_LENGTH);
}

interface QuestionRow {
  id: string;
  run_id: string;
  content_hash: Buffer;
  status: AgentQuestionStatus;
  options: AgentQuestionOption[];
  answer_option: number | null;
  answer_text: string | null;
}

function answerOf(row: QuestionRow): AgentAnswer {
  const option = row.options[row.answer_option ?? -1];
  if (!option) throw new Error('agent question answer is out of range');
  return { answered: true, answer: option.custom ? (row.answer_text ?? '') : option.label, selected_option: option.label, is_custom: option.custom };
}

export interface AgentQuestionRef {
  /** 按令牌查出的身份（不来自请求）。 */
  tenant: TenantContext;
  jobId: string;
  runId: string;
}

export type AgentQuestionState =
  /** 已回答：答案已交给本次执行（问题关闭）。 */
  | { kind: 'answered'; questionId: string; answer: AgentAnswer }
  /** 等待回答。created：本次调用新建或（续跑时）接手了问题，需要推送。 */
  | { kind: 'pending'; questionId: string; created: boolean }
  /** 任务不在本次执行中（或 Agent 已报告无法继续），或问题已被作废。 */
  | { kind: 'not-running' }
  /** 本次执行已有另一个问题在等待回答。 */
  | { kind: 'conflict' };

const OPEN_STATUSES = ['pending', 'answered'] as const;

/** 锁住任务行（与回答接口串行），任务仍是本次执行且没有失败报告时返回 true。 */
async function lockCurrentRun(trx: Trx, ref: AgentQuestionRef): Promise<boolean> {
  const job = await trx.selectFrom('jobs').select(['status', 'run_id']).where('id', '=', ref.jobId).forUpdate().executeTakeFirst();
  if (!job || job.status !== 'running' || job.run_id !== ref.runId) return false;
  return (await findAgentFailureReport(trx, ref.jobId, ref.runId)) === null;
}

async function consume(trx: Trx, ref: AgentQuestionRef, row: QuestionRow): Promise<AgentQuestionState> {
  await trx.updateTable('agent_questions').set({ status: 'consumed', consumed_run_id: ref.runId }).where('id', '=', row.id).execute();
  return { kind: 'answered', questionId: row.id, answer: answerOf(row) };
}

const QUESTION_COLUMNS = ['id', 'run_id', 'content_hash', 'status', 'options', 'answer_option', 'answer_text'] as const;

/**
 * 提出问题（在 withTenant 的事务中调用）。同一个问题（按 content_hash）已回答的直接取回答案；等待中的继续等待
 * （续跑时由本次执行接手、重新计时）；旧执行的另一个问题作废后新建；本次执行已有另一个问题在等待时返回 conflict。
 */
export async function openAgentQuestion(trx: Trx, ref: AgentQuestionRef, question: NormalizedAgentQuestion): Promise<AgentQuestionState> {
  if (!(await lockCurrentRun(trx, ref))) return { kind: 'not-running' };
  const open = (await trx
    .selectFrom('agent_questions')
    .select(QUESTION_COLUMNS)
    .where('job_id', '=', ref.jobId)
    .where('status', 'in', OPEN_STATUSES)
    .forUpdate()
    .executeTakeFirst()) as QuestionRow | undefined;
  if (open && open.content_hash.equals(question.contentHash)) {
    if (open.status === 'answered') return consume(trx, ref, open);
    if (open.run_id === ref.runId) return { kind: 'pending', questionId: open.id, created: false };
    await trx.updateTable('agent_questions').set({ run_id: ref.runId, status: 'pending' }).where('id', '=', open.id).execute();
    return { kind: 'pending', questionId: open.id, created: true };
  }
  if (open) {
    if (open.run_id === ref.runId) return { kind: 'conflict' };
    await trx.updateTable('agent_questions').set({ status: 'superseded' }).where('id', '=', open.id).execute();
  }
  const inserted = await trx
    .insertInto('agent_questions')
    .values({
      org_id: ref.tenant.orgId,
      job_id: ref.jobId,
      run_id: ref.runId,
      content_hash: question.contentHash,
      question: question.question,
      options: JSON.stringify(question.options),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('job_events')
    .values({ org_id: ref.tenant.orgId, job_id: ref.jobId, kind: 'log', message: 'Agent 提出了一个问题，等待回答', data: JSON.stringify({ questionId: inserted.id }) })
    .execute();
  return { kind: 'pending', questionId: inserted.id, created: true };
}

/** 等待中检查一次（在 withTenant 的事务中调用）：已回答即取回答案；问题被作废、任务不在本次执行中时 not-running。 */
export async function pollAgentQuestion(trx: Trx, ref: AgentQuestionRef, questionId: string): Promise<AgentQuestionState> {
  if (!(await lockCurrentRun(trx, ref))) return { kind: 'not-running' };
  const row = (await trx.selectFrom('agent_questions').select(QUESTION_COLUMNS).where('id', '=', questionId).where('job_id', '=', ref.jobId).forUpdate().executeTakeFirst()) as
    | QuestionRow
    | undefined;
  if (!row) return { kind: 'not-running' };
  if (row.status === 'answered') return consume(trx, ref, row);
  if (row.status === 'pending' && row.run_id === ref.runId) return { kind: 'pending', questionId: row.id, created: false };
  return { kind: 'not-running' };
}

/** 本次执行中等待回答已超过 timeoutSeconds 的问题（renewRun 检查，在设置了组织上下文的事务中调用）。 */
export async function hasExpiredAgentQuestion(trx: Trx, jobId: string, runId: string, timeoutSeconds: number): Promise<boolean> {
  const row = await trx
    .selectFrom('agent_questions')
    .select('id')
    .where('job_id', '=', jobId)
    .where('run_id', '=', runId)
    .where('status', '=', 'pending')
    .where('asked_at', '<=', sql<Date>`now() - make_interval(secs => ${timeoutSeconds})`)
    .executeTakeFirst();
  return row !== undefined;
}

/** 任务等待回答中的问题（没有时 null）。在设置了组织上下文的事务中调用。 */
export async function findPendingAgentQuestion(trx: Trx, jobId: string, runId?: string) {
  let query = trx
    .selectFrom('agent_questions')
    .select(['id', 'run_id', 'question', 'options', 'asked_at'])
    .where('job_id', '=', jobId)
    .where('status', '=', 'pending');
  if (runId !== undefined) query = query.where('run_id', '=', runId);
  return (await query.executeTakeFirst()) ?? null;
}

export function isWaitingForUserReason(reason: string | null): boolean {
  return reason === AGENT_WAITING_FOR_USER_PAUSE_REASON;
}
