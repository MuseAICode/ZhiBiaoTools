// 任务接口（路线图第 6 步 6.2）。需要登录，组织取自会话；任务在组织内共享（与项目相同），成员都可以查看和取消。
// 其他组织的 jobId 与不存在的一样返回 404。入队接口由各业务模块提供（6.6 起），这里只有查询和取消。
//
// GET /api/jobs?projectId=&active=&limit=、GET /api/jobs/:jobId（含最近的任务事件，Agent 任务另含费用与轮数上限）、
// POST /api/jobs/:jobId/cancel、POST /api/jobs/:jobId/confirm-limit（8.3b：达到上限后确认继续，限任务发起人或 owner / admin）、
// POST /api/jobs/:jobId/answer（8.4c1：回答 Agent 的问题，限任务发起人或 owner / admin）。GET /api/jobs/:jobId 另含等待回答中的问题
// （pendingQuestion：问题与选项是 AI 生成的纯文本，前端按纯文本显示）。
// 响应不含任务参数和 checkpoint（内部数据）。
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import { getAgentJobBudget, type AgentJobBudget } from '../agent/budget.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { requireProject } from '../projects/access.ts';
import type { JobNotifier } from '../jobs/notify.ts';
import { answerJobQuestion, confirmJobTaskLimit, type JobServiceDependencies } from '../jobs/service.ts';
import { findJob, isFinalStatus, listJobEvents, listJobs, requestCancel } from '../jobs/store.ts';
import { AGENT_QUESTION_MAX_LENGTH, AGENT_QUESTION_MAX_OPTIONS, AGENT_QUESTION_TIMEOUT_SECONDS, findPendingAgentQuestion } from '../agent/questions.ts';
import { withTenant } from '../db/tenant.ts';
import { jobBody, jobEventBody } from '../jobs/view.ts';

export interface JobRouteDependencies {
  db: Kysely<Database>;
  /** 状态变化后的推送（6.3）。 */
  notifier: JobNotifier;
  /** 确认继续后重新派发（任务类型登记与派发）。 */
  jobs: JobServiceDependencies;
}

/** Agent 任务的上限与用量（确认继续的页面显示）：金额为计费单位（0.0001 元）的十进制字符串。 */
function agentBudgetBody(budget: AgentJobBudget) {
  return {
    costLimit: budget.costLimit.toString(),
    turnLimit: budget.turnLimit,
    turnsUsed: budget.turnsUsed,
    exhaustedReason: budget.exhaustedReason,
    costStep: budget.costStep.toString(),
    turnStep: budget.turnStep,
    confirmations: budget.confirmations,
  };
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const EVENT_LIMIT = 200;

const JOB_ID_PARAMS = {
  type: 'object',
  properties: { jobId: { type: 'string', pattern: UUID_PATTERN } },
  required: ['jobId'],
  additionalProperties: false,
} as const;

function jobNotFound(): AppError {
  return new AppError(404, 'JOB_NOT_FOUND', '任务不存在');
}

interface ListQuery {
  projectId?: string;
  active?: boolean;
  limit?: number;
}

type JobParams = { Params: { jobId: string } };

interface AnswerBody {
  questionId: string;
  optionIndex: number;
  customAnswer?: string;
}

const ANSWER_BODY = {
  type: 'object',
  properties: {
    questionId: { type: 'string', pattern: UUID_PATTERN },
    optionIndex: { type: 'integer', minimum: 0, maximum: AGENT_QUESTION_MAX_OPTIONS - 1 },
    customAnswer: { type: 'string', maxLength: AGENT_QUESTION_MAX_LENGTH },
  },
  required: ['questionId', 'optionIndex'],
  additionalProperties: false,
} as const;

export async function registerJobRoutes(app: FastifyInstance, deps: JobRouteDependencies): Promise<void> {
  const { db } = deps;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.get<{ Querystring: ListQuery }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            projectId: { type: 'string', pattern: UUID_PATTERN },
            active: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const context = tenantOf(request);
      const { projectId, active, limit } = request.query;
      if (projectId !== undefined) await requireProject(db, context, projectId, null);
      const jobs = await listJobs(db, context, {
        ...(projectId !== undefined ? { projectId: projectId.toLowerCase() } : {}),
        ...(active !== undefined ? { active } : {}),
        limit: limit ?? 50,
      });
      return { jobs: jobs.map(jobBody) };
    },
  );

  app.get<JobParams>('/:jobId', { schema: { params: JOB_ID_PARAMS } }, async (request) => {
    const context = tenantOf(request);
    const jobId = request.params.jobId.toLowerCase();
    const job = await findJob(db, context, jobId);
    if (!job) throw jobNotFound();
    const events = await listJobEvents(db, context, jobId, EVENT_LIMIT);
    const budget = await getAgentJobBudget(db, context, jobId);
    // 等待回答中的问题（8.4c1）：已结束的任务不显示。问题与选项是 AI 生成的纯文本。
    const question = isFinalStatus(job.status) ? null : await withTenant(db, context, (trx) => findPendingAgentQuestion(trx, jobId));
    const pendingQuestion = question
      ? {
          id: question.id,
          question: question.question,
          options: question.options.map((option) => ({ label: option.label, description: option.description, custom: option.custom })),
          askedAt: question.asked_at.toISOString(),
          // 任务执行中时，超过这个时间仍未回答即暂停（等待回答超时而暂停后仍可回答，回答后自动继续）。
          pauseAt: new Date(question.asked_at.getTime() + AGENT_QUESTION_TIMEOUT_SECONDS * 1000).toISOString(),
        }
      : null;
    return { ...jobBody(job), agentBudget: budget ? agentBudgetBody(budget) : null, pendingQuestion, events: events.map(jobEventBody) };
  });

  app.post<JobParams>('/:jobId/cancel', { schema: { params: JOB_ID_PARAMS } }, async (request) => {
    const { job } = await requestCancel(db, tenantOf(request), request.params.jobId.toLowerCase());
    await deps.notifier.changed(job);
    return jobBody(job);
  });

  app.post<JobParams>('/:jobId/confirm-limit', { schema: { params: JOB_ID_PARAMS } }, async (request) => {
    const job = await confirmJobTaskLimit(deps.jobs, tenantOf(request), request.params.jobId.toLowerCase());
    return jobBody(job);
  });

  app.post<JobParams & { Body: AnswerBody }>('/:jobId/answer', { schema: { params: JOB_ID_PARAMS, body: ANSWER_BODY } }, async (request) => {
    const { questionId, optionIndex, customAnswer } = request.body;
    const job = await answerJobQuestion(deps.jobs, tenantOf(request), request.params.jobId.toLowerCase(), {
      questionId: questionId.toLowerCase(),
      optionIndex,
      ...(customAnswer !== undefined ? { customAnswer } : {}),
    });
    return jobBody(job);
  });
}
