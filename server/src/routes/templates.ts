// 导出模板接口（路线图第 5 步 5.4）。需要登录，组织取自会话；组织内成员都可以新建、修改、删除本组织的模板
// （组织内共享，第 9 节第 2 项）。系统模板所有人可读、可复制，不能修改和删除（由 RLS 保证）。
//
// GET /api/export-templates、POST /api/export-templates、GET/PUT/DELETE /api/export-templates/:templateId、
// POST /api/export-templates/:templateId/duplicate。其他组织的 templateId 与不存在的一样返回 404。
//
// 模板样张与样张导出 Word（路线图第 7 步 7.3e，取代桌面版 templates.renderPreview 与 export.word 的 template_html）：
// POST /api/export-templates/preview                       { html, exportFormat, purpose? } → 202 { requestId, job, supersededJobIds }
// GET  /api/export-templates/preview/:requestId            样张请求的状态（pending / ready / expired）
// GET  /api/export-templates/preview/:requestId/content    生成的 docx，附件下载（前端交给 docx-editor 预览，或保存为 Word）
// - 入队前经 validatePreviewHtml 校验（与前端 restrictedHtml 同一套白名单），不通过返回 400、不保存、不入队；
// - purpose 为 preview（默认）时新请求取消本用户排队中的样张（运行中的继续）；为 word 时不参与取代（src/export/previewJob.ts）；
// - 进度与结果经任务的 SSE 推送（GET /api/events），任务成功后按 requestId 下载；
// - 样张请求只有创建者本人可见（RLS），其他用户、其他组织的与不存在的一样返回 404；结果 24 小时后由清理任务删除，之后返回 410；
// - 按用户限流（templatePreviewPerUser），超出返回 429。不计费、不检查余额（第 7 步决定事项第 7 项）。
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { findArtifact } from '../artifacts/store.ts';
import { tenantOf } from '../auth/hooks.ts';
import type { RateLimitDecision } from '../auth/rateLimit.ts';
import { DOCX_MIME } from '../db/migrations/0027_template_preview.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { enqueueTemplatePreview, TEMPLATE_PREVIEW_PURPOSES, type TemplatePreviewPurpose } from '../export/previewJob.ts';
import { findTemplatePreviewRequest, type TemplatePreviewRequestRecord } from '../export/previewStore.ts';
import { attachmentDisposition, sanitizeDisplayName } from '../files/filename.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import type { JobServiceDependencies } from '../jobs/service.ts';
import { jobBody } from '../jobs/view.ts';
import { PREVIEW_HTML_MAX_BYTES } from '../templates/previewHtml.ts';
import { fileTimestamp } from '../xlsx/displayTime.ts';
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
  /** 样张入队（7.3e）。 */
  jobs: JobServiceDependencies;
  /** 未配置对象存储（S3_BUCKET）时为 null，样张下载返回 503。 */
  objectStore: ObjectStore | null;
  /** 样张请求按用户限流。 */
  previewLimiter: { consume(key: string): Promise<RateLimitDecision> };
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

// 样张：HTML 的字节上限由 validatePreviewHtml 检查（超出时 400），这里按字符数先挡住明显过大的请求体；配置与模板相同只要求是对象，
// 由 normalizeExportFormat 规范化。
const PREVIEW_BODY_SCHEMA = {
  type: 'object',
  properties: {
    html: { type: 'string', maxLength: PREVIEW_HTML_MAX_BYTES },
    exportFormat: { type: 'object', maxProperties: 200 },
    purpose: { type: 'string', enum: [...TEMPLATE_PREVIEW_PURPOSES] },
  },
  required: ['html', 'exportFormat'],
  additionalProperties: false,
} as const;

const PREVIEW_REQUEST_PARAMS = {
  type: 'object',
  properties: { requestId: { type: 'string', pattern: UUID_PATTERN } },
  required: ['requestId'],
  additionalProperties: false,
} as const;

type PreviewBody = { Body: { html: string; exportFormat: Record<string, unknown>; purpose?: TemplatePreviewPurpose } };
type PreviewParams = { Params: { requestId: string } };

function previewNotFound(): AppError {
  return new AppError(404, 'PREVIEW_NOT_FOUND', '样张不存在');
}

function enforce(reply: FastifyReply, decision: RateLimitDecision): void {
  if (decision.allowed) return;
  reply.header('retry-after', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
  throw new AppError(429, 'TOO_MANY_REQUESTS', '请求过于频繁，请稍后再试');
}

/** 下载文件名：<模板名>_YYYYMMDD_HHMMSS.docx（同桌面版样张导出 Word 的默认文件名，时间按北京时间）。 */
export function previewFileName(request: TemplatePreviewRequestRecord): string {
  const name = typeof request.exportFormat.template_name === 'string' && request.exportFormat.template_name.trim() !== ''
    ? request.exportFormat.template_name
    : '模板样张';
  return sanitizeDisplayName(`${name}_${fileTimestamp(request.completedAt ?? request.createdAt)}.docx`);
}

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

  app.post<PreviewBody>('/preview', { schema: { body: PREVIEW_BODY_SCHEMA } }, async (request, reply) => {
    const context = tenantOf(request);
    enforce(reply, await deps.previewLimiter.consume(context.userId));
    const { html, exportFormat, purpose } = request.body;
    const enqueued = await enqueueTemplatePreview(deps.jobs, context, { html, exportFormat }, purpose ?? 'preview');
    return reply.code(202).send({
      requestId: enqueued.request.id,
      job: jobBody(enqueued.job),
      supersededJobIds: enqueued.superseded.map((job) => job.id),
    });
  });

  /** 本人的样张请求与结果产物（产物已被清理时为 null）。 */
  async function previewOf(context: ReturnType<typeof tenantOf>, requestId: string) {
    const record = await findTemplatePreviewRequest(db, context, requestId.toLowerCase());
    if (!record) throw previewNotFound();
    const artifact = record.artifactId === null ? null : await findArtifact(db, context, record.artifactId);
    return { record, artifact };
  }

  app.get<PreviewParams>('/preview/:requestId', { schema: { params: PREVIEW_REQUEST_PARAMS } }, async (request) => {
    const { record, artifact } = await previewOf(tenantOf(request), request.params.requestId);
    const status = record.artifactId === null ? 'pending' : artifact ? 'ready' : 'expired';
    return {
      id: record.id,
      status,
      fileName: status === 'ready' ? previewFileName(record) : null,
      size: artifact?.size ?? null,
      createdAt: record.createdAt.toISOString(),
      completedAt: record.completedAt?.toISOString() ?? null,
    };
  });

  // 与文件下载相同：一律附件、nosniff、sandbox CSP，由 api 从对象存储流式转发。
  app.get<PreviewParams>('/preview/:requestId/content', { schema: { params: PREVIEW_REQUEST_PARAMS } }, async (request, reply) => {
    if (!deps.objectStore) throw new AppError(503, 'FILE_STORAGE_DISABLED', '文件存储暂未开放');
    const { record, artifact } = await previewOf(tenantOf(request), request.params.requestId);
    if (record.artifactId === null) throw new AppError(409, 'PREVIEW_NOT_READY', '样张尚未生成');
    if (!artifact) throw new AppError(410, 'PREVIEW_EXPIRED', '样张已过期，请重新生成');
    const object = await deps.objectStore.get(artifact.storageKey);
    if (!object) {
      request.log.error({ artifactId: artifact.id }, 'template preview object is missing from object storage');
      throw new AppError(410, 'PREVIEW_EXPIRED', '样张已过期，请重新生成');
    }
    reply
      .header('content-type', DOCX_MIME)
      .header('content-length', String(artifact.size))
      .header('content-disposition', attachmentDisposition(previewFileName(record)))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, no-store');
    return reply.send(object.body);
  });

  app.post<TemplateParams>('/:templateId/duplicate', { schema: { params: TEMPLATE_ID_PARAMS } }, async (request, reply) => {
    const record = await duplicateTemplate(db, tenantOf(request), request.params.templateId.toLowerCase());
    return reply.code(201).send(templateBody(record));
  });
}
