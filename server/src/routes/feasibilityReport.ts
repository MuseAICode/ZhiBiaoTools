// 可研报告接口（路线图第 5 步 5.10）。需要登录，组织取自会话；先经 requireProject 校验项目属于本组织、未删除、
// kind 是 feasibility-report，不符一律 404。组织内成员都可以查看和编辑（组织内共享，第 9 节第 2 项），可见性、
// 写权限与删除可见性由 RLS 保证。对应桌面版 feasibilityReport.loadState / updateStep / saveProjectInfo / saveAnalysis /
// saveOutlineConfig / saveOutline / saveKeyParameters / saveChapterContent / importSourceDocuments / removeSourceDocument /
// readSourceMarkdown / clear。
//
// GET    /api/projects/:projectId/feasibility-report                              完整状态（任务状态随第 6 步）
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
//
// 导入资料后自动入队资料解析（6.6，src/parse/）；资料分析、关键参数随第 6 步的任务队列，目录生成 / 调整第 6 步核实（可能第 8 步），正文生成随第 8 步；
// readCombinedSourceMarkdown（Renderer 未调用）由任务在服务端合并，不开放为接口；Word 导出随第 7 步。
import type { FastifyInstance, FastifyRequest } from 'fastify';
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
import { enqueueDocumentParses } from '../parse/enqueue.ts';
import { PROJECT_ID_PARAMS, requireProject } from '../projects/access.ts';

export interface FeasibilityReportRouteDependencies {
  db: Kysely<Database>;
  /** 读取资料的 Markdown 用；未配置时读取已解析的资料返回 503（还没有 Markdown 时除外）。 */
  objectStore: ObjectStore | null;
  /** 导入后入队文档解析任务（6.6）。 */
  jobs: JobServiceDependencies;
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

type ProjectParams = { Params: { projectId: string } };
type SourceParams = { Params: { projectId: string; fileId: string } };
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
    async (request) => saveProjectInfo(db, tenantOf(request), await project(request), request.body.projectInfo),
  );

  app.put<ProjectParams & { Body: { markdown: string } }>(
    '/:projectId/feasibility-report/analysis',
    { schema: { params: PROJECT_ID_PARAMS, body: MARKDOWN_SCHEMA }, bodyLimit: MARKDOWN_BODY_LIMIT },
    async (request) => saveAnalysis(db, tenantOf(request), await project(request), request.body.markdown),
  );

  app.put<ProjectParams & { Body: OutlineConfigInput }>(
    '/:projectId/feasibility-report/outline-config',
    { schema: { params: PROJECT_ID_PARAMS, body: OUTLINE_CONFIG_SCHEMA } },
    async (request) => saveOutlineConfig(db, tenantOf(request), await project(request), request.body),
  );

  app.put<ProjectParams & { Body: SaveOutlineInput }>(
    '/:projectId/feasibility-report/outline',
    { schema: { params: PROJECT_ID_PARAMS, body: OUTLINE_SCHEMA }, bodyLimit: OUTLINE_BODY_LIMIT },
    async (request) => saveOutline(db, tenantOf(request), await project(request), request.body),
  );

  app.put<ProjectParams & { Body: { markdown: string } }>(
    '/:projectId/feasibility-report/key-parameters',
    { schema: { params: PROJECT_ID_PARAMS, body: MARKDOWN_SCHEMA }, bodyLimit: MARKDOWN_BODY_LIMIT },
    async (request) => saveKeyParameters(db, tenantOf(request), await project(request), request.body.markdown),
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
      return result;
    },
  );

  app.delete<SourceParams>('/:projectId/feasibility-report/sources/:fileId', { schema: { params: SOURCE_PARAMS } }, async (request) =>
    removeSource(db, tenantOf(request), await project(request), request.params.fileId),
  );

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

  app.delete<ProjectParams>('/:projectId/feasibility-report', { schema: { params: PROJECT_ID_PARAMS } }, async (request) =>
    clearFeasibilityReport(db, tenantOf(request), await project(request)),
  );
}
