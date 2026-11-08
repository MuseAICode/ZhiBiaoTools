// 可研报告接口（路线图第 5 步 5.10）。需要登录，组织取自会话；先经 requireProject 校验项目属于本组织、未删除、
// kind 是 feasibility-report，不符一律 404。组织内成员都可以查看和编辑（组织内共享，第 9 节第 2 项），可见性、
// 写权限与删除可见性由 RLS 保证。对应桌面版 feasibilityReport.loadState / updateStep / saveProjectInfo / saveAnalysis /
// saveOutlineConfig / saveOutline / saveKeyParameters / saveChapterContent / importSourceDocuments / removeSourceDocument /
// readSourceMarkdown / clear。
//
// GET    /api/projects/:projectId/feasibility-report                              完整状态（含最近一次的各类任务）
// PATCH  /api/projects/:projectId/feasibility-report/step                         切换页面步骤
// PUT    /api/projects/:projectId/feasibility-report/project-info                 保存项目信息（清空资料分析、目录和关键参数）
// PUT    /api/projects/:projectId/feasibility-report/analysis                     保存资料分析（清空目录和关键参数）
// PUT    /api/projects/:projectId/feasibility-report/outline-config               保存目录模板、目标字数和引用的知识库文档
// PUT    /api/projects/:projectId/feasibility-report/outline                      保存目录（reason 协议，见 Store）
// PUT    /api/projects/:projectId/feasibility-report/key-parameters               保存关键参数（清空全部正文）
// PUT    /api/projects/:projectId/feasibility-report/chapters/:nodeId             保存一章正文
// PUT    /api/projects/:projectId/feasibility-report/sources                      导入可研资料（整体替换，挂已上传的 tender 文件，待解析）
// DELETE /api/projects/:projectId/feasibility-report/sources/:fileId              移除一份资料（原件进回收站）
// GET    /api/projects/:projectId/feasibility-report/sources/:fileId/markdown     资料解析出的 Markdown 原文（附件下载，还没有解析时为空）
// DELETE /api/projects/:projectId/feasibility-report                              清空（资料进回收站）
// POST   /api/projects/:projectId/feasibility-report/analysis-job                 开始资料分析（入队 feasibility-analysis）
// POST   /api/projects/:projectId/feasibility-report/key-parameters-job           开始生成关键参数（入队 feasibility-parameters）
// POST   /api/projects/:projectId/feasibility-report/content-job                  开始正文生成与审校（入队 feasibility-content，{ onlyMissing? }）
// POST   /api/projects/:projectId/feasibility-report/human-writing-job            开始自然化审校（入队 feasibility-human-writing）
// POST   /api/projects/:projectId/feasibility-report/export                       导出 Word（入队 feasibility-report-export，7.5e）
// GET    /api/projects/:projectId/feasibility-report/export/:requestId            导出的状态（pending / ready / expired）、提示与消息
// GET    /api/projects/:projectId/feasibility-report/export/:requestId/content    导出的 docx（附件下载）
//
// 导入资料后自动入队资料解析（6.6，src/parse/）。资料分析、关键参数、正文生成与审校是任务（6.12，src/feasibilityReport/jobs.ts），结果由任务
// 经 Store 函数写入，进度、取消、暂停、继续经 /api/jobs 与 SSE；与桌面版相同，保存项目信息、资料分析、目录、关键参数，导入、移除资料和清空时
// 取消本项目进行中的可研任务；正文生成或审校任务未结束时不能保存目录、手工改正文（409）。目录生成 / 调整随第 8 步；
// readCombinedSourceMarkdown（Renderer 未调用）由任务在服务端合并，不开放为接口。
//
// 导出 Word（7.5e，取代桌面版可研页面的 export.word 与 export.openFile；做法与技术方案整本导出的 7.4h 相同）：POST 的请求体为
// { templateId, options? }（模板 id 与桌面版的导出选项，多余字段拒绝），经 enqueueFeasibilityReportExport 取快照入队（没有目录、
// 模板不可见、选项不合法 400，快照过大 413，本项目已有未结束的可研导出 409 JOB_LOCKED，均不入队），按用户限流
// （feasibilityReportExportPerUser，超出 429，在取快照之前计数）；进度与结果经任务的 SSE，任务成功后按 requestId 取状态并下载。
// 请求属于项目、本组织内成员可见（RLS），不属于这个项目的与不存在的一样 404；新的导出入队后旧的请求被删除（404），
// 旧的产物被替换或 7 天后清理（410）。不计费、不检查余额（第 7 步决定事项第 7 项）。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { findArtifact } from '../artifacts/store.ts';
import type { RateLimitDecision } from '../auth/rateLimit.ts';
import { DOCX_MIME } from '../db/migrations/0027_template_preview.ts';
import { AppError } from '../errors.ts';
import { enqueueFeasibilityReportExport, FEASIBILITY_DEFAULT_PROJECT_NAME } from '../export/feasibilityJob.ts';
import {
  FEASIBILITY_EXPORT_OPTION_TEXT_MAX,
  findFeasibilityExportRequest,
  type FeasibilityExportOptionsInput,
  type FeasibilityExportRequestRecord,
} from '../export/feasibilityRequestStore.ts';
import { sanitizeDisplayName } from '../files/filename.ts';
import { fileTimestamp } from '../xlsx/displayTime.ts';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import {
  FEASIBILITY_CONTENT_MAX,
  FEASIBILITY_FIELD_MAX,
  FEASIBILITY_MARKDOWN_MAX,
  FEASIBILITY_NODE_ID_MAX,
  FEASIBILITY_OUTLINE_TEMPLATES,
  FEASIBILITY_PROJECT_TYPES,
  FEASIBILITY_REPORT_STEPS,
  FEASIBILITY_TARGET_WORDS_MAX,
  FEASIBILITY_TEXT_MAX,
} from '../db/migrations/0017_feasibility_report.ts';
import type { Database, FeasibilityReportStep } from '../db/schema.ts';
import {
  cancelFeasibilityReportJobs,
  startFeasibilityAnalysis,
  startFeasibilityContent,
  startFeasibilityHumanWriting,
  startFeasibilityParameters,
} from '../feasibilityReport/jobs.ts';
import {
  clearFeasibilityReport,
  FEASIBILITY_OUTLINE_NODES_MAX,
  FEASIBILITY_OUTLINE_SAVE_REASONS,
  FEASIBILITY_REFERENCE_DOCUMENTS_MAX,
  FEASIBILITY_SOURCES_MAX,
  findSourceMarkdown,
  importSources,
  loadFeasibilityReport,
  removeSource,
  saveAnalysis,
  saveChapterContent,
  saveKeyParameters,
  saveOutline,
  saveOutlineConfig,
  saveProjectInfo,
  updateStep,
  type OutlineConfigInput,
  type ProjectInfoInput,
  type SaveOutlineInput,
} from '../feasibilityReport/store.ts';
import { attachmentDisposition } from '../files/filename.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { storageDisabled } from '../knowledgeBase/content.ts';
import type { JobServiceDependencies } from '../jobs/service.ts';
import { jobBody } from '../jobs/view.ts';
import { enqueueDocumentParses } from '../parse/enqueue.ts';
import { PROJECT_ID_PARAMS, requireProject } from '../projects/access.ts';

export interface FeasibilityReportRouteDependencies {
  db: Kysely<Database>;
  /** 读取资料的 Markdown 用；未配置时读取已解析的资料返回 503（还没有 Markdown 时除外）。 */
  objectStore: ObjectStore | null;
  /** 导入后入队文档解析任务（6.6）、导出任务（7.5e）。 */
  jobs: JobServiceDependencies;
  /** 导出 Word 的入队按用户限流（7.5e）。 */
  exportLimiter: { consume(key: string): Promise<RateLimitDecision> };
}

const UUID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
const NODE_ID = { type: 'string', minLength: 1, maxLength: FEASIBILITY_NODE_ID_MAX } as const;

/** 目录保存的请求体上限：目录连同各章正文（每章最多 FEASIBILITY_CONTENT_MAX 字）一起提交，超过全局的 1 MB。 */
const OUTLINE_BODY_LIMIT = 8 * 1024 * 1024;
/** 单章正文、资料分析、关键参数的请求体上限（最多 100 万字，UTF-8 最多 4 字节）。 */
const MARKDOWN_BODY_LIMIT = 4 * 1024 * 1024 + 64 * 1024;

const SOURCE_PARAMS = {
  type: 'object',
  properties: { ...PROJECT_ID_PARAMS.properties, fileId: UUID },
  required: ['projectId', 'fileId'],
  additionalProperties: false,
} as const;

const CHAPTER_PARAMS = {
  type: 'object',
  properties: { ...PROJECT_ID_PARAMS.properties, nodeId: NODE_ID },
  required: ['projectId', 'nodeId'],
  additionalProperties: false,
} as const;

const STEP_SCHEMA = {
  type: 'object',
  properties: { step: { type: 'string', enum: [...FEASIBILITY_REPORT_STEPS] } },
  required: ['step'],
  additionalProperties: false,
} as const;

const FIELD = { type: 'string', maxLength: FEASIBILITY_FIELD_MAX } as const;

const PROJECT_INFO_SCHEMA = {
  type: 'object',
  properties: {
    projectInfo: {
      type: 'object',
      properties: {
        projectName: FIELD,
        projectType: { type: 'string', enum: [...FEASIBILITY_PROJECT_TYPES] },
        industry: FIELD,
        constructionUnit: FIELD,
        location: FIELD,
        constructionContent: { type: 'string', maxLength: FEASIBILITY_TEXT_MAX },
        constructionPeriodYears: FIELD,
        operationPeriodYears: FIELD,
        totalInvestment: FIELD,
        fundingSource: FIELD,
      },
      additionalProperties: false,
    },
  },
  required: ['projectInfo'],
  additionalProperties: false,
} as const;

const MARKDOWN_SCHEMA = {
  type: 'object',
  properties: { markdown: { type: 'string', maxLength: FEASIBILITY_MARKDOWN_MAX } },
  required: ['markdown'],
  additionalProperties: false,
} as const;

const OUTLINE_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    outlineTemplate: { type: 'string', enum: [...FEASIBILITY_OUTLINE_TEMPLATES] },
    targetWords: { type: 'integer', minimum: 0, maximum: FEASIBILITY_TARGET_WORDS_MAX },
    referenceDocumentIds: { type: 'array', maxItems: FEASIBILITY_REFERENCE_DOCUMENTS_MAX, items: UUID },
  },
  required: ['outlineTemplate', 'targetWords', 'referenceDocumentIds'],
  additionalProperties: false,
} as const;

// 目录树的结构、层级、节点数和各字段的长度由 Store 检查（逐层递归，深度受层级上限约束），这里不用递归的 JSON Schema，
// 避免深层嵌套的请求体在校验时递归过深。
const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    outlineData: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    reason: { type: 'string', enum: [...FEASIBILITY_OUTLINE_SAVE_REASONS] },
    idMap: { type: 'object', maxProperties: FEASIBILITY_OUTLINE_NODES_MAX, additionalProperties: NODE_ID },
    affectedNodeIds: { type: 'array', maxItems: FEASIBILITY_OUTLINE_NODES_MAX, items: { type: 'string', maxLength: FEASIBILITY_NODE_ID_MAX } },
  },
  required: ['outlineData', 'reason'],
  additionalProperties: false,
} as const;

const CHAPTER_SCHEMA = {
  type: 'object',
  properties: { content: { type: 'string', maxLength: FEASIBILITY_CONTENT_MAX } },
  required: ['content'],
  additionalProperties: false,
} as const;

const SOURCES_SCHEMA = {
  type: 'object',
  properties: { fileIds: { type: 'array', minItems: 1, maxItems: FEASIBILITY_SOURCES_MAX, items: UUID } },
  required: ['fileIds'],
  additionalProperties: false,
} as const;

// 只补充生成还没有正文的章节；请求体可以省略。
const CONTENT_JOB_SCHEMA = {
  type: 'object',
  properties: { onlyMissing: { type: 'boolean' } },
  additionalProperties: false,
} as const;

type ProjectParams = { Params: { projectId: string } };
type SourceParams = { Params: { projectId: string; fileId: string } };
type ExportParams = { Params: { projectId: string; requestId: string } };
type ExportBody = { Body: { templateId: string; options?: FeasibilityExportOptionsInput } };

const EXPORT_PARAMS = {
  type: 'object',
  properties: { ...PROJECT_ID_PARAMS.properties, requestId: UUID },
  required: ['projectId', 'requestId'],
  additionalProperties: false,
} as const;

const OPTION_TEXT = { type: 'string', maxLength: FEASIBILITY_EXPORT_OPTION_TEXT_MAX } as const;
/** 与桌面版 FeasibilityExportOptions 相同的六项；多余字段拒绝（长度以字符计的上限由 Store 再按字数检查）。 */
const EXPORT_BODY_SCHEMA = {
  type: 'object',
  properties: {
    templateId: UUID,
    options: {
      type: 'object',
      properties: {
        includeCover: { type: 'boolean' },
        includePreparationNotes: { type: 'boolean' },
        includeAppendixTables: { type: 'boolean' },
        preparationUnit: OPTION_TEXT,
        securityLevel: OPTION_TEXT,
        documentCode: OPTION_TEXT,
      },
      additionalProperties: false,
    },
  },
  required: ['templateId'],
  additionalProperties: false,
} as const;

function exportNotFound(): AppError {
  return new AppError(404, 'EXPORT_NOT_FOUND', '导出记录不存在或已被新的导出取代');
}

function exportExpired(): AppError {
  return new AppError(410, 'EXPORT_EXPIRED', '导出的 Word 已过期或已被新的导出替换，请重新导出');
}

/** 下载文件名：<项目名称>_YYYYMMDD_HHMMSS.docx（同桌面版 export.word 的默认文件名；项目名称为空时“可行性研究报告”，时间为完成时间，按北京时间）。 */
export function feasibilityExportFileName(request: FeasibilityExportRequestRecord): string {
  const name = request.projectName?.trim() ? request.projectName : FEASIBILITY_DEFAULT_PROJECT_NAME;
  return sanitizeDisplayName(`${name}_${fileTimestamp(request.completedAt ?? request.createdAt)}.docx`);
}
type ChapterParams = { Params: { projectId: string; nodeId: string } };

export async function registerFeasibilityReportRoutes(app: FastifyInstance, deps: FeasibilityReportRouteDependencies): Promise<void> {
  const { db } = deps;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** 校验项目并返回小写的 projectId。 */
  async function project(request: FastifyRequest<ProjectParams>): Promise<string> {
    return (await requireProject(db, tenantOf(request), request.params.projectId, 'feasibility-report')).id;
  }

  /**
   * 保存上游内容、资料变化和清空后取消进行中的可研任务。桌面版在提交前取消；这里在提交后取消，提交与取消之间旧任务的写入因签名不符
   * 被拒绝，响应中的状态在取消后重新读取。
   */
  async function cancelJobsAndReload(request: FastifyRequest, projectId: string) {
    await cancelFeasibilityReportJobs(deps.jobs, tenantOf(request), projectId);
    return loadFeasibilityReport(db, tenantOf(request), projectId);
  }

  app.get<ProjectParams>('/:projectId/feasibility-report', { schema: { params: PROJECT_ID_PARAMS } }, async (request) =>
    loadFeasibilityReport(db, tenantOf(request), await project(request)),
  );

  app.patch<ProjectParams & { Body: { step: FeasibilityReportStep } }>(
    '/:projectId/feasibility-report/step',
    { schema: { params: PROJECT_ID_PARAMS, body: STEP_SCHEMA } },
    async (request) => updateStep(db, tenantOf(request), await project(request), request.body.step),
  );

  app.put<ProjectParams & { Body: { projectInfo: ProjectInfoInput } }>(
    '/:projectId/feasibility-report/project-info',
    { schema: { params: PROJECT_ID_PARAMS, body: PROJECT_INFO_SCHEMA } },
    async (request) => {
      const projectId = await project(request);
      await saveProjectInfo(db, tenantOf(request), projectId, request.body.projectInfo);
      return cancelJobsAndReload(request, projectId);
    },
  );

  app.put<ProjectParams & { Body: { markdown: string } }>(
    '/:projectId/feasibility-report/analysis',
    { schema: { params: PROJECT_ID_PARAMS, body: MARKDOWN_SCHEMA }, bodyLimit: MARKDOWN_BODY_LIMIT },
    async (request) => {
      const projectId = await project(request);
      await saveAnalysis(db, tenantOf(request), projectId, request.body.markdown);
      return cancelJobsAndReload(request, projectId);
    },
  );

  app.put<ProjectParams & { Body: OutlineConfigInput }>(
    '/:projectId/feasibility-report/outline-config',
    { schema: { params: PROJECT_ID_PARAMS, body: OUTLINE_CONFIG_SCHEMA } },
    async (request) => saveOutlineConfig(db, tenantOf(request), await project(request), request.body),
  );

  app.put<ProjectParams & { Body: SaveOutlineInput }>(
    '/:projectId/feasibility-report/outline',
    { schema: { params: PROJECT_ID_PARAMS, body: OUTLINE_SCHEMA }, bodyLimit: OUTLINE_BODY_LIMIT },
    async (request) => {
      const projectId = await project(request);
      await saveOutline(db, tenantOf(request), projectId, request.body);
      return cancelJobsAndReload(request, projectId);
    },
  );

  app.put<ProjectParams & { Body: { markdown: string } }>(
    '/:projectId/feasibility-report/key-parameters',
    { schema: { params: PROJECT_ID_PARAMS, body: MARKDOWN_SCHEMA }, bodyLimit: MARKDOWN_BODY_LIMIT },
    async (request) => {
      const projectId = await project(request);
      await saveKeyParameters(db, tenantOf(request), projectId, request.body.markdown);
      return cancelJobsAndReload(request, projectId);
    },
  );

  app.put<ChapterParams & { Body: { content: string } }>(
    '/:projectId/feasibility-report/chapters/:nodeId',
    { schema: { params: CHAPTER_PARAMS, body: CHAPTER_SCHEMA }, bodyLimit: MARKDOWN_BODY_LIMIT },
    async (request) => saveChapterContent(db, tenantOf(request), await project(request), request.params.nodeId, request.body.content),
  );

  app.put<ProjectParams & { Body: { fileIds: string[] } }>(
    '/:projectId/feasibility-report/sources',
    { schema: { params: PROJECT_ID_PARAMS, body: SOURCES_SCHEMA } },
    async (request) => {
      const projectId = await project(request);
      const result = await importSources(db, tenantOf(request), projectId, request.body.fileIds);
      await enqueueDocumentParses(deps.jobs, tenantOf(request), projectId, 'feasibility-report', result.addedFileIds);
      return { ...result, state: await cancelJobsAndReload(request, projectId) };
    },
  );

  app.delete<SourceParams>('/:projectId/feasibility-report/sources/:fileId', { schema: { params: SOURCE_PARAMS } }, async (request) => {
    const projectId = await project(request);
    await removeSource(db, tenantOf(request), projectId, request.params.fileId);
    return cancelJobsAndReload(request, projectId);
  });

  // 与 /api/artifacts/:artifactId/content 相同：一律附件、nosniff、sandbox CSP，Markdown 原文不会在本站内被当作页面渲染。
  app.get<SourceParams>('/:projectId/feasibility-report/sources/:fileId/markdown', { schema: { params: SOURCE_PARAMS } }, async (request, reply) => {
    const { artifact } = await findSourceMarkdown(db, tenantOf(request), await project(request), request.params.fileId);
    reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', attachmentDisposition('content.md'))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox");
    // 与桌面版相同：还没有解析出 Markdown 时返回空内容。
    if (!artifact) return reply.send('');
    if (!deps.objectStore) throw storageDisabled();
    const object = await deps.objectStore.get(artifact.storageKey);
    if (!object) {
      request.log.error({ artifactId: artifact.id }, 'artifact object is missing from object storage');
      return reply.send('');
    }
    return reply.header('content-length', String(artifact.size)).send(object.body);
  });

  app.delete<ProjectParams>('/:projectId/feasibility-report', { schema: { params: PROJECT_ID_PARAMS } }, async (request) => {
    const projectId = await project(request);
    const result = await clearFeasibilityReport(db, tenantOf(request), projectId);
    await cancelFeasibilityReportJobs(deps.jobs, tenantOf(request), projectId);
    return result;
  });

  app.post<ProjectParams>('/:projectId/feasibility-report/analysis-job', { schema: { params: PROJECT_ID_PARAMS } }, async (request, reply) => {
    const job = await startFeasibilityAnalysis(deps.jobs, tenantOf(request), await project(request));
    return reply.code(202).send({ job: jobBody(job) });
  });

  app.post<ProjectParams>('/:projectId/feasibility-report/key-parameters-job', { schema: { params: PROJECT_ID_PARAMS } }, async (request, reply) => {
    const job = await startFeasibilityParameters(deps.jobs, tenantOf(request), await project(request));
    return reply.code(202).send({ job: jobBody(job) });
  });

  app.post<ProjectParams & { Body: { onlyMissing?: boolean } }>(
    '/:projectId/feasibility-report/content-job',
    {
      schema: { params: PROJECT_ID_PARAMS, body: CONTENT_JOB_SCHEMA },
      preValidation: async (request) => {
        request.body ??= {};
      },
    },
    async (request, reply) => {
      const job = await startFeasibilityContent(deps.jobs, tenantOf(request), await project(request), request.body);
      return reply.code(202).send({ job: jobBody(job) });
    },
  );

  app.post<ProjectParams>('/:projectId/feasibility-report/human-writing-job', { schema: { params: PROJECT_ID_PARAMS } }, async (request, reply) => {
    const job = await startFeasibilityHumanWriting(deps.jobs, tenantOf(request), await project(request));
    return reply.code(202).send({ job: jobBody(job) });
  });

  app.post<ProjectParams & ExportBody>(
    '/:projectId/feasibility-report/export',
    { schema: { params: PROJECT_ID_PARAMS, body: EXPORT_BODY_SCHEMA } },
    async (request, reply) => {
      const context = tenantOf(request);
      const projectId = await project(request);
      const decision = await deps.exportLimiter.consume(context.userId);
      if (!decision.allowed) {
        reply.header('retry-after', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
        throw new AppError(429, 'TOO_MANY_REQUESTS', '请求过于频繁，请稍后再试');
      }
      const enqueued = await enqueueFeasibilityReportExport(deps.jobs, context, projectId, {
        templateId: request.body.templateId.toLowerCase(),
        options: request.body.options ?? {},
      });
      return reply.code(202).send({ requestId: enqueued.request.id, job: jobBody(enqueued.job) });
    },
  );

  /** 本项目的导出请求与结果产物（产物已被替换或清理时为 null）。 */
  async function exportOf(request: FastifyRequest<ExportParams>) {
    const context = tenantOf(request);
    const projectId = await project(request);
    const record = await findFeasibilityExportRequest(db, context, request.params.requestId.toLowerCase());
    if (!record || record.projectId !== projectId) throw exportNotFound();
    const artifact = record.result === null ? null : await findArtifact(db, context, record.result.artifactId);
    return { record, artifact };
  }

  app.get<ExportParams>('/:projectId/feasibility-report/export/:requestId', { schema: { params: EXPORT_PARAMS } }, async (request) => {
    const { record, artifact } = await exportOf(request);
    const status = record.result === null ? 'pending' : artifact ? 'ready' : 'expired';
    return {
      id: record.id,
      status,
      fileName: status === 'ready' ? feasibilityExportFileName(record) : null,
      size: artifact?.size ?? null,
      warnings: record.result?.warnings ?? [],
      message: record.result?.message ?? null,
      createdAt: record.createdAt.toISOString(),
      completedAt: record.completedAt?.toISOString() ?? null,
    };
  });

  // 与文件下载相同：一律附件、nosniff、sandbox CSP，由 api 从对象存储流式转发；cache-control 由本插件的 onSend 设为 no-store。
  app.get<ExportParams>('/:projectId/feasibility-report/export/:requestId/content', { schema: { params: EXPORT_PARAMS } }, async (request, reply) => {
    if (!deps.objectStore) throw storageDisabled();
    const { record, artifact } = await exportOf(request);
    if (record.result === null) throw new AppError(409, 'EXPORT_NOT_READY', 'Word 尚未导出完成');
    if (!artifact) throw exportExpired();
    const object = await deps.objectStore.get(artifact.storageKey);
    if (!object) {
      request.log.error({ artifactId: artifact.id }, 'feasibility report export object is missing from object storage');
      throw exportExpired();
    }
    reply
      .header('content-type', DOCX_MIME)
      .header('content-length', String(artifact.size))
      .header('content-disposition', attachmentDisposition(feasibilityExportFileName(record)))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox");
    return reply.send(object.body);
  });
}
