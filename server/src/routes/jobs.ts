// 任务接口（路线图第 6 步 6.2）。需要登录，组织取自会话；任务在组织内共享（与项目相同），成员都可以查看和取消。
// 其他组织的 jobId 与不存在的一样返回 404。入队接口由各业务模块提供（6.6 起），这里只有查询和取消。
//
// GET /api/jobs?projectId=&active=&limit=、GET /api/jobs/:jobId（含最近的任务事件）、POST /api/jobs/:jobId/cancel。
// 响应不含任务参数和 checkpoint（内部数据）。
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { requireProject } from '../projects/access.ts';
import type { JobNotifier } from '../jobs/notify.ts';
import { findJob, listJobEvents, listJobs, requestCancel } from '../jobs/store.ts';
import { jobBody, jobEventBody } from '../jobs/view.ts';

export interface JobRouteDependencies {
  db: Kysely<Database>;
  /** 状态变化后的推送（6.3）。 */
  notifier: JobNotifier;
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
    return { ...jobBody(job), events: events.map(jobEventBody) };
  });

  app.post<JobParams>('/:jobId/cancel', { schema: { params: JOB_ID_PARAMS } }, async (request) => {
    const { job } = await requestCancel(db, tenantOf(request), request.params.jobId.toLowerCase());
    await deps.notifier.changed(job);
    return jobBody(job);
  });
}
