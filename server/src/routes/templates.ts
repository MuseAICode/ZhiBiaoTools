// 导出模板接口（路线图第 5 步 5.4）。需要登录，组织取自会话；组织内成员都可以新建、修改、删除本组织的模板
// （组织内共享，第 9 节第 2 项）。系统模板所有人可读、可复制，不能修改和删除（由 RLS 保证）。
//
// GET /api/export-templates、POST /api/export-templates、GET/PUT/DELETE /api/export-templates/:templateId、
// POST /api/export-templates/:templateId/duplicate。其他组织的 templateId 与不存在的一样返回 404。
// 模板样张 renderPreview、Word 导出随第 7 步。
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import type { Database } from '../db/schema.ts';
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  findTemplate,
  listTemplates,
  templateNotFound,
  updateTemplate,
  type ExportTemplateRecord,
} from '../templates/store.ts';

export interface TemplateRouteDependencies {
  db: Kysely<Database>;
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const TEMPLATE_ID_PARAMS = {
  type: 'object',
  properties: { templateId: { type: 'string', pattern: UUID_PATTERN } },
  required: ['templateId'],
  additionalProperties: false,
} as const;

// 配置由前端归一化（与桌面版相同），服务端只要求是对象，深度和大小在 Store 中检查；名称取自 config.template_name。
const BODY_SCHEMA = {
  type: 'object',
  properties: { config: { type: 'object', maxProperties: 200 } },
  required: ['config'],
  additionalProperties: false,
} as const;

function templateBody(record: ExportTemplateRecord) {
  return {
    id: record.id,
    name: record.name,
    isSystem: record.isSystem,
    config: record.config,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

type TemplateParams = { Params: { templateId: string } };
type TemplateBody = { Body: { config: Record<string, unknown> } };

export async function registerTemplateRoutes(app: FastifyInstance, deps: TemplateRouteDependencies): Promise<void> {
  const { db } = deps;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.get('/', async (request) => ({ templates: (await listTemplates(db, tenantOf(request))).map(templateBody) }));

  app.post<TemplateBody>('/', { schema: { body: BODY_SCHEMA } }, async (request, reply) => {
    const record = await createTemplate(db, tenantOf(request), request.body.config);
    return reply.code(201).send(templateBody(record));
  });

  app.get<TemplateParams>('/:templateId', { schema: { params: TEMPLATE_ID_PARAMS } }, async (request) => {
    const record = await findTemplate(db, tenantOf(request), request.params.templateId.toLowerCase());
    if (!record) throw templateNotFound();
    return templateBody(record);
  });

  app.put<TemplateParams & TemplateBody>(
    '/:templateId',
    { schema: { params: TEMPLATE_ID_PARAMS, body: BODY_SCHEMA } },
    async (request) => templateBody(await updateTemplate(db, tenantOf(request), request.params.templateId.toLowerCase(), request.body.config)),
  );

  app.delete<TemplateParams>('/:templateId', { schema: { params: TEMPLATE_ID_PARAMS } }, async (request, reply) => {
    await deleteTemplate(db, tenantOf(request), request.params.templateId.toLowerCase());
    return reply.code(204).send();
  });

  app.post<TemplateParams>('/:templateId/duplicate', { schema: { params: TEMPLATE_ID_PARAMS } }, async (request, reply) => {
    const record = await duplicateTemplate(db, tenantOf(request), request.params.templateId.toLowerCase());
    return reply.code(201).send(templateBody(record));
  });
}
