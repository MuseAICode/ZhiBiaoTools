// 废标检查接口（路线图第 5 步 5.9；从技术方案读取招标文件随 5.13）。需要登录，组织取自会话；先经 requireProject 校验项目属于本组织、未删除、
// kind 是 rejection-check，不符一律 404。组织内成员都可以查看和编辑（组织内共享，第 9 节第 2 项），可见性、
// 写权限与删除可见性由 RLS 保证。对应桌面版 rejectionCheck.loadState / importDocument / removeDocument / saveUiState /
// updateState（Renderer 的部分）/ clear / exportExcel / importTenderFromTechnicalPlan。
//
// GET    /api/projects/:projectId/rejection-check                                    完整状态（文档、页面状态、解析结果、三类检查，任务状态随第 6 步）
// POST   /api/projects/:projectId/rejection-check/documents                          导入招标文件或投标文件（挂已上传的 tender 文件，待解析）
// DELETE /api/projects/:projectId/rejection-check/documents/:fileId                  移除一份文档（原件进回收站）
// POST   /api/projects/:projectId/rejection-check/tender-from-technical-plan         从技术方案项目复制招标文件（整体替换招标文件）
// PATCH  /api/projects/:projectId/rejection-check/ui-state                           保存页面状态、自定义检查项和检查选项
// PATCH  /api/projects/:projectId/rejection-check/results/:resultType                切换当前问题
// DELETE /api/projects/:projectId/rejection-check/results/:resultType/findings/:findingId  删除单条问题
// DELETE /api/projects/:projectId/rejection-check                                    清空（导入的文档进回收站）
// GET    /api/projects/:projectId/rejection-check/export                             当前结果导出为 Excel（附件下载）
//
// 文档解析、废标项解析与三类检查随第 6 步的任务队列，结果由任务经 saveDocumentParse / saveExtraction / saveCheckResult
// 写入；桌面版 updateState 中任务写入的部分不开放为接口。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import {
  REJECTION_CHECK_CUSTOM_ITEMS_MAX,
  REJECTION_CHECK_DOCUMENT_ROLES,
  REJECTION_CHECK_KEY_MAX,
  REJECTION_CHECK_RESULT_TABS,
  REJECTION_CHECK_RESULT_TYPES,
  REJECTION_CHECK_STEPS,
} from '../db/migrations/0016_rejection_check.ts';
import type { Database, RejectionCheckResultType } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { attachmentDisposition } from '../files/filename.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { PROJECT_ID_PARAMS, requireProject } from '../projects/access.ts';
import { importTenderFromTechnicalPlan } from '../rejectionCheck/fromTechnicalPlan.ts';
import { buildRejectionWorkbook, exportFileName, isExportable } from '../rejectionCheck/export.ts';
import {
  clearRejectionCheck,
  deleteFinding,
  importDocuments,
  loadRejectionCheck,
  REJECTION_CHECK_BID_DOCUMENTS_MAX,
  removeDocument,
  saveUiState,
  setActiveFinding,
  type ImportDocumentsInput,
  type UiStatePatch,
} from '../rejectionCheck/store.ts';

export interface RejectionCheckRouteDependencies {
  db: Kysely<Database>;
  /** 从技术方案复制招标文件用；未配置时该接口返回 503。 */
  objectStore: ObjectStore | null;
  /** 测试用：导出时间。 */
  now?: () => Date;
}

const UUID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
const KEY = { type: 'string', minLength: 1, maxLength: REJECTION_CHECK_KEY_MAX } as const;

const DOCUMENT_PARAMS = {
  type: 'object',
  properties: { ...PROJECT_ID_PARAMS.properties, fileId: UUID },
  required: ['projectId', 'fileId'],
  additionalProperties: false,
} as const;

const RESULT_PARAMS = {
  type: 'object',
  properties: { ...PROJECT_ID_PARAMS.properties, resultType: { type: 'string', enum: [...REJECTION_CHECK_RESULT_TYPES] } },
  required: ['projectId', 'resultType'],
  additionalProperties: false,
} as const;

const FINDING_PARAMS = {
  type: 'object',
  properties: { ...RESULT_PARAMS.properties, findingId: KEY },
  required: ['projectId', 'resultType', 'findingId'],
  additionalProperties: false,
} as const;

// 一次导入的数量不超过投标文件的上限；每类文档的总数由 Store 按已导入的数量检查。
const IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: [...REJECTION_CHECK_DOCUMENT_ROLES] },
    fileIds: { type: 'array', minItems: 1, maxItems: REJECTION_CHECK_BID_DOCUMENTS_MAX, items: UUID },
  },
  required: ['role', 'fileIds'],
  additionalProperties: false,
} as const;

const UI_STATE_SCHEMA = {
  type: 'object',
  properties: {
    step: { type: 'string', enum: [...REJECTION_CHECK_STEPS] },
    activeDocumentTab: KEY,
    activeResultTab: { type: 'string', enum: [...REJECTION_CHECK_RESULT_TABS] },
    activeCheckResultTab: { type: 'string', enum: [...REJECTION_CHECK_RESULT_TYPES] },
    customCheckItems: { type: 'string', maxLength: REJECTION_CHECK_CUSTOM_ITEMS_MAX },
    checkOptions: {
      type: 'object',
      properties: { rejectionCheck: { type: 'boolean' }, typoCheck: { type: 'boolean' }, logicCheck: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  minProperties: 1,
  additionalProperties: false,
} as const;

const RESULT_SCHEMA = {
  type: 'object',
  properties: { activeFindingId: { anyOf: [KEY, { type: 'null' }] } },
  required: ['activeFindingId'],
  additionalProperties: false,
} as const;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const FROM_TECHNICAL_PLAN_SCHEMA = {
  type: 'object',
  properties: { technicalPlanProjectId: PROJECT_ID_PARAMS.properties.projectId },
  required: ['technicalPlanProjectId'],
  additionalProperties: false,
} as const;

type ProjectParams = { Params: { projectId: string } };
type DocumentParams = { Params: { projectId: string; fileId: string } };
type ResultParams = { Params: { projectId: string; resultType: RejectionCheckResultType } };
type FindingParams = { Params: { projectId: string; resultType: RejectionCheckResultType; findingId: string } };

export async function registerRejectionCheckRoutes(app: FastifyInstance, deps: RejectionCheckRouteDependencies): Promise<void> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** 校验项目并返回小写的 projectId。 */
  async function project(request: FastifyRequest<ProjectParams>): Promise<string> {
    return (await requireProject(db, tenantOf(request), request.params.projectId, 'rejection-check')).id;
  }

  app.get<ProjectParams>('/:projectId/rejection-check', { schema: { params: PROJECT_ID_PARAMS } }, async (request) =>
    loadRejectionCheck(db, tenantOf(request), await project(request)),
  );

  app.post<ProjectParams & { Body: ImportDocumentsInput }>(
    '/:projectId/rejection-check/documents',
    { schema: { params: PROJECT_ID_PARAMS, body: IMPORT_SCHEMA } },
    async (request) => importDocuments(db, tenantOf(request), await project(request), request.body),
  );

  app.delete<DocumentParams>('/:projectId/rejection-check/documents/:fileId', { schema: { params: DOCUMENT_PARAMS } }, async (request) =>
    removeDocument(db, tenantOf(request), await project(request), request.params.fileId),
  );

  app.post<ProjectParams & { Body: { technicalPlanProjectId: string } }>(
    '/:projectId/rejection-check/tender-from-technical-plan',
    { schema: { params: PROJECT_ID_PARAMS, body: FROM_TECHNICAL_PLAN_SCHEMA } },
    async (request) =>
      importTenderFromTechnicalPlan(db, tenantOf(request), deps.objectStore, await project(request), request.body.technicalPlanProjectId),
  );

  app.patch<ProjectParams & { Body: UiStatePatch }>(
    '/:projectId/rejection-check/ui-state',
    { schema: { params: PROJECT_ID_PARAMS, body: UI_STATE_SCHEMA } },
    async (request) => saveUiState(db, tenantOf(request), await project(request), request.body),
  );

  app.patch<ResultParams & { Body: { activeFindingId: string | null } }>(
    '/:projectId/rejection-check/results/:resultType',
    { schema: { params: RESULT_PARAMS, body: RESULT_SCHEMA } },
    async (request) =>
      setActiveFinding(db, tenantOf(request), await project(request), request.params.resultType, request.body.activeFindingId),
  );

  app.delete<FindingParams>(
    '/:projectId/rejection-check/results/:resultType/findings/:findingId',
    { schema: { params: FINDING_PARAMS } },
    async (request) => deleteFinding(db, tenantOf(request), await project(request), request.params.resultType, request.params.findingId),
  );

  app.delete<ProjectParams>('/:projectId/rejection-check', { schema: { params: PROJECT_ID_PARAMS } }, async (request) =>
    clearRejectionCheck(db, tenantOf(request), await project(request)),
  );

  // 与文件下载相同：一律附件、nosniff、sandbox CSP。单元格文本一律写成内联字符串，危险前缀另加 quotePrefix，不会被当作公式求值。
  app.get<ProjectParams>('/:projectId/rejection-check/export', { schema: { params: PROJECT_ID_PARAMS } }, async (request, reply) => {
    const projectId = await project(request);
    const state = await loadRejectionCheck(db, tenantOf(request), projectId);
    if (!isExportable(state)) throw new AppError(409, 'REJECTION_CHECK_NOTHING_TO_EXPORT', '没有可导出的当前废标检查结果');
    const exportedAt = now();
    const content = buildRejectionWorkbook(state, exportedAt);
    return reply
      .header('content-type', XLSX_MIME)
      .header('content-disposition', attachmentDisposition(exportFileName(exportedAt)))
      .header('content-length', String(content.length))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(content);
  });
}
