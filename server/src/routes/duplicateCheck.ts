// 标书查重接口（路线图第 5 步 5.8）。需要登录，组织取自会话；先经 requireProject 校验项目属于本组织、未删除、
// kind 是 duplicate-check，不符一律 404。组织内成员都可以查看和编辑（组织内共享，第 9 节第 2 项），可见性、
// 写权限与删除可见性由 RLS 保证。对应桌面版 duplicateCheck.loadState / saveFiles / saveUiState / clear / exportExcel。
//
// GET    /api/projects/:projectId/duplicate-check            完整状态（文件选择、页面状态、四类分析结果，任务状态随第 6 步）
// PUT    /api/projects/:projectId/duplicate-check/files      重新选择招标文件、投标文件（挂已上传的 duplicate-check 文件），清空分析结果
// PATCH  /api/projects/:projectId/duplicate-check/ui-state   保存页面步骤和分析页签
// DELETE /api/projects/:projectId/duplicate-check            清空（选中的文件进回收站）
// GET    /api/projects/:projectId/duplicate-check/export     当前结果导出为 Excel（附件下载）
//
// 查重分析本身（解析、元数据、目录、正文、图片）随第 6 步的任务队列，分析结果由任务经 saveAnalysisSection 写入；
// 桌面版的 updateState 只给任务用，不开放为接口。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import { DUPLICATE_CHECK_SECTIONS, DUPLICATE_CHECK_STEPS } from '../db/migrations/0014_duplicate_check.ts';
import type { Database, DuplicateCheckSection, DuplicateCheckStep } from '../db/schema.ts';
import { buildDuplicateWorkbook, exportFileName, isExportable } from '../duplicateCheck/export.ts';
import {
  clearDuplicateCheck,
  DUPLICATE_CHECK_BID_FILES_MAX,
  DUPLICATE_CHECK_TENDER_FILES_MAX,
  loadDuplicateCheck,
  saveFiles,
  saveUiState,
  type SaveFilesInput,
} from '../duplicateCheck/store.ts';
import { AppError } from '../errors.ts';
import { attachmentDisposition } from '../files/filename.ts';
import { PROJECT_ID_PARAMS, requireProject } from '../projects/access.ts';

export interface DuplicateCheckRouteDependencies {
  db: Kysely<Database>;
  /** 测试用：导出时间。 */
  now?: () => Date;
}

const UUID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
const STEP = { type: 'string', enum: [...DUPLICATE_CHECK_STEPS] } as const;
const TAB = { type: 'string', enum: [...DUPLICATE_CHECK_SECTIONS] } as const;

const FILES_SCHEMA = {
  type: 'object',
  properties: {
    tenderFileIds: { type: 'array', maxItems: DUPLICATE_CHECK_TENDER_FILES_MAX, items: UUID },
    bidFileIds: { type: 'array', maxItems: DUPLICATE_CHECK_BID_FILES_MAX, items: UUID },
    step: STEP,
    activeAnalysisTab: TAB,
  },
  required: ['tenderFileIds', 'bidFileIds'],
  additionalProperties: false,
} as const;

const UI_STATE_SCHEMA = {
  type: 'object',
  properties: { step: STEP, activeAnalysisTab: TAB },
  minProperties: 1,
  additionalProperties: false,
} as const;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type ProjectParams = { Params: { projectId: string } };

export async function registerDuplicateCheckRoutes(app: FastifyInstance, deps: DuplicateCheckRouteDependencies): Promise<void> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** 校验项目并返回小写的 projectId。 */
  async function project(request: FastifyRequest<ProjectParams>): Promise<string> {
    return (await requireProject(db, tenantOf(request), request.params.projectId, 'duplicate-check')).id;
  }

  app.get<ProjectParams>('/:projectId/duplicate-check', { schema: { params: PROJECT_ID_PARAMS } }, async (request) =>
    loadDuplicateCheck(db, tenantOf(request), await project(request)),
  );

  app.put<ProjectParams & { Body: SaveFilesInput }>(
    '/:projectId/duplicate-check/files',
    { schema: { params: PROJECT_ID_PARAMS, body: FILES_SCHEMA } },
    async (request) => saveFiles(db, tenantOf(request), await project(request), request.body),
  );

  app.patch<ProjectParams & { Body: { step?: DuplicateCheckStep; activeAnalysisTab?: DuplicateCheckSection } }>(
    '/:projectId/duplicate-check/ui-state',
    { schema: { params: PROJECT_ID_PARAMS, body: UI_STATE_SCHEMA } },
    async (request) => saveUiState(db, tenantOf(request), await project(request), request.body),
  );

  app.delete<ProjectParams>('/:projectId/duplicate-check', { schema: { params: PROJECT_ID_PARAMS } }, async (request) =>
    clearDuplicateCheck(db, tenantOf(request), await project(request)),
  );

  // 与文件下载相同：一律附件、nosniff、sandbox CSP。单元格文本一律写成内联字符串，不会被当作公式求值。
  app.get<ProjectParams>('/:projectId/duplicate-check/export', { schema: { params: PROJECT_ID_PARAMS } }, async (request, reply) => {
    const projectId = await project(request);
    const state = await loadDuplicateCheck(db, tenantOf(request), projectId);
    if (!isExportable(state)) throw new AppError(409, 'DUPLICATE_CHECK_NOTHING_TO_EXPORT', '没有可导出的当前标书查重结果');
    const exportedAt = now();
    const content = buildDuplicateWorkbook(state, exportedAt);
    return reply
      .header('content-type', XLSX_MIME)
      .header('content-disposition', attachmentDisposition(exportFileName(exportedAt)))
      .header('content-length', String(content.length))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(content);
  });
}
