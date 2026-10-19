// 项目接口（路线图第 5 步 5.1）。需要登录，组织取自会话；组织内成员都可以新建、改名、删除、恢复（组织内共享，第 9 节第 2 项）。
// 其他组织的 projectId 与不存在的一样返回 404。
//
// GET /api/projects?kind=&deleted=&limit=、POST /api/projects、GET/PATCH/DELETE /api/projects/:projectId、
// POST /api/projects/:projectId/restore。删除是软删除，7 天内可恢复；过期后不可访问、不可恢复，由后续的清理任务物理删除。
// 各模块的项目级接口（/api/projects/:projectId/technical-plan 等）在各自的路由中注册，先经 requireProject 校验归属。
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { PROJECT_ID_PARAMS, projectNotFound, requireProject } from '../projects/access.ts';
import {
  createProject,
  listProjects,
  PROJECT_KINDS,
  projectRestoreDeadline,
  renameProject,
  restoreProject,
  softDeleteProject,
  type ProjectKind,
  type ProjectRecord,
} from '../projects/store.ts';

export interface ProjectRouteDependencies {
  db: Kysely<Database>;
}

// 名称在 Store 中归一化后再校验长度（不超过 200 字）；这里只限制原始输入的大小。
const NAME_SCHEMA = { type: 'string', minLength: 1, maxLength: 1000 } as const;

function projectBody(record: ProjectRecord) {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    deletedAt: record.deletedAt?.toISOString() ?? null,
    restoreUntil: projectRestoreDeadline(record)?.toISOString() ?? null,
  };
}

interface ListQuery {
  kind?: ProjectKind;
  deleted?: boolean;
  limit?: number;
}

type ProjectParams = { Params: { projectId: string } };

export async function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDependencies): Promise<void> {
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
            kind: { type: 'string', enum: [...PROJECT_KINDS] },
            deleted: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const records = await listProjects(db, tenantOf(request), {
        deleted: request.query.deleted ?? false,
        ...(request.query.kind ? { kind: request.query.kind } : {}),
        limit: request.query.limit ?? 100,
      });
      return { projects: records.map(projectBody) };
    },
  );

  app.post<{ Body: { kind: ProjectKind; name: string } }>(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          properties: { kind: { type: 'string', enum: [...PROJECT_KINDS] }, name: NAME_SCHEMA },
          required: ['kind', 'name'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const record = await createProject(db, tenantOf(request), request.body);
      reply.code(201);
      return projectBody(record);
    },
  );

  app.get<ProjectParams>('/:projectId', { schema: { params: PROJECT_ID_PARAMS } }, async (request) => {
    return projectBody(await requireProject(db, tenantOf(request), request.params.projectId, null));
  });

  app.patch<ProjectParams & { Body: { name: string } }>(
    '/:projectId',
    {
      schema: {
        params: PROJECT_ID_PARAMS,
        body: { type: 'object', properties: { name: NAME_SCHEMA }, required: ['name'], additionalProperties: false },
      },
    },
    async (request) => {
      const record = await renameProject(db, tenantOf(request), request.params.projectId.toLowerCase(), request.body.name);
      if (!record) throw projectNotFound();
      return projectBody(record);
    },
  );

  app.delete<ProjectParams>('/:projectId', { schema: { params: PROJECT_ID_PARAMS } }, async (request) => {
    const record = await softDeleteProject(db, tenantOf(request), request.params.projectId.toLowerCase());
    if (!record) throw projectNotFound();
    return projectBody(record);
  });

  app.post<ProjectParams>('/:projectId/restore', { schema: { params: PROJECT_ID_PARAMS } }, async (request) => {
    const record = await restoreProject(db, tenantOf(request), request.params.projectId.toLowerCase());
    if (!record) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已超过恢复期');
    return projectBody(record);
  });
}
