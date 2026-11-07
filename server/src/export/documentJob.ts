// 技术方案整本导出 Word 的任务（路线图第 7 步 7.4g；取代桌面版 export.word → technicalPlanExport.prepare / build），export 队列，
// 不调用模型（决定事项第 7 项：不计费、不检查余额）。接口（7.4h）调用 enqueueTechnicalPlanExport 入队。
//
// - 入队：在一个事务中取快照存为整本导出请求（7.4f 的 saveTechnicalPlanExportRequest；没有目录、没有有效模板、标题超过六级、
//   快照过大时直接拒绝，不入队），任务参数只有请求 id（0021 的约定）；lock_key 按项目（project:{id}:technical-plan-export），
//   同一项目同时只有一个整本导出，已有时 409 JOB_LOCKED。入队成功后删除本项目的其他请求（此时它们的任务都已结束），
//   入队失败时删除刚保存的请求；
// - 执行：以发起用户的身份读请求（必须属于任务的项目）→ 用 7.4c 的 assembleDocumentHtml 组装整本 HTML → 只把引用中本项目可见的
//   图片产物以 assets/<产物 id> 放入（asset_types 取产物表登记的 MIME；不可见的不放，由助手在原位提示）→ 新建沙箱之前按合计大小
//   拒绝（7.4b）→ 在 export-document 沙箱中生成（src/export/document.ts，配图经 7.4e 的 objectInputFile 流式放入）→ 存为
//   technical-plan-export 产物（7.4d：计入组织存储配额，同一事务中替换本项目旧的导出）→ 用 summarizeDocumentExport 汇总提示
//   与消息 → 经 completeTechnicalPlanExportRequest 写回结果；
// - WebP（7.4g 核对）：桌面版先经 nativeImage 转为 PNG 再交给助手；助手按文件头识别 WebP 并以 image/webp 图片部件直接嵌入
//   （openxmlhelper 的 ImageFormatTests），本步不转换；按 #59 确认时的决定由 7.4i 在 export 沙箱内转为 PNG（兼容旧版 Word 和 WPS）；
// - 进度经 setProgress（SSE 推送）；可续跑：worker 崩溃或关闭后从头重新执行（快照不变，结果相同），已有结果时直接结束；
// - 任务日志只写阶段与计数，不写目录标题、正文和配图。
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { JobError, JobInterruptedError, type JobTypeDefinition } from '../jobs/definitions.ts';
import { enqueueJob, type JobServiceDependencies } from '../jobs/service.ts';
import type { JobRecord } from '../jobs/store.ts';
import { renderTechnicalPlanDocument } from './document.ts';
import { assembleDocumentHtml, DocumentHtmlError, summarizeDocumentExport, type ExportImageWarning } from './documentHtml.ts';
import {
  completeTechnicalPlanExportRequest,
  deleteTechnicalPlanExportRequests,
  findTechnicalPlanExportRequest,
  saveTechnicalPlanExportRequest,
  type TechnicalPlanExportRequestRecord,
} from './documentRequestStore.ts';
import { listTechnicalPlanExportImages, writeTechnicalPlanExportArtifact } from './documentStore.ts';

export const TECHNICAL_PLAN_EXPORT_JOB_TYPE = 'technical-plan-export';

/** 引用了、但不是本项目可见的图片产物（其他项目或组织的、已被删除或替换的、不是图片的）：不放入沙箱，助手原位提示。 */
export const IMAGE_NOT_AVAILABLE_REASON = '图片不属于本项目或已被删除，无法读取';
/** 放入了、但助手无法嵌入（内容无法识别或已损坏）。助手的原因文字不采用（src/export/output.ts）。 */
export const IMAGE_NOT_EMBEDDABLE_REASON = '图片内容无法识别或已损坏';

export interface TechnicalPlanExportParams {
  requestId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseParams(raw: unknown): TechnicalPlanExportParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('整本导出任务参数不合法');
  const { requestId, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) throw new TypeError('整本导出任务参数不合法');
  return { requestId };
}

/** 整本导出的互斥键：同一项目同时只有一个整本导出（与技术方案的生成任务互不影响，导出读的是入队时的快照）。 */
export function technicalPlanExportLockKey(projectId: string): string {
  return `project:${projectId}:technical-plan-export`;
}

function requestMissing(): JobError {
  return new JobError('EXPORT_REQUEST_NOT_FOUND', '导出请求不存在或已被新的导出取代，请重新导出');
}

export interface TechnicalPlanExportJobOptions {
  /** 沙箱数已达上限时重试创建前的等待（毫秒），见 src/export/document.ts。 */
  createRetryDelaysMs?: readonly number[];
}

export function createTechnicalPlanExportJob(options: TechnicalPlanExportJobOptions = {}): JobTypeDefinition<TechnicalPlanExportParams> {
  return {
    type: TECHNICAL_PLAN_EXPORT_JOB_TYPE,
    queue: 'export',
    resumable: true,
    parseParams,
    async run(context) {
      const { db, tenant, params } = context;
      const request = await findTechnicalPlanExportRequest(db, tenant, params.requestId);
      if (!request || context.projectId === null || request.projectId !== context.projectId) throw requestMissing();
      if (request.result !== null || request.snapshot === null) {
        await context.log('Word 已导出');
        return;
      }
      const objectStore = context.objectStore;
      if (!objectStore) throw new JobError('EXPORT_UNAVAILABLE', '导出服务暂不可用，请稍后重试');

      let document;
      try {
        document = assembleDocumentHtml(request.snapshot);
      } catch (error) {
        if (error instanceof DocumentHtmlError) throw new JobError(error.code, error.message, { cause: error });
        throw error;
      }
      const assets = await listTechnicalPlanExportImages(db, tenant, request.projectId, document.assetRefs);
      if (context.signal.aborted) throw new JobInterruptedError();
      await context.log('开始导出 Word', {
        sectionCount: document.sectionCount,
        skippedCount: document.skippedCount,
        imageCount: document.assetRefs.length,
        availableImageCount: assets.length,
      });
      await context.setProgress(5);

      const output = await renderTechnicalPlanDocument(context, objectStore, { html: document.html, exportFormat: request.exportFormat, assets }, {
        ...(options.createRetryDelaysMs ? { createRetryDelaysMs: options.createRetryDelaysMs } : {}),
      });
      if (context.signal.aborted) throw new JobInterruptedError();
      await context.setProgress(90);

      let artifactId: string;
      try {
        artifactId = (await writeTechnicalPlanExportArtifact(db, tenant, objectStore, request.projectId, output.docx)).id;
      } catch (error) {
        if (error instanceof AppError) throw new JobError(error.code, error.message, { cause: error });
        throw error;
      }
      // 助手的原因文字不采用：放入了的配图按“无法识别”，没有放入的按“不可见”。
      const available = new Set(assets.map((asset) => asset.id));
      const imageWarnings: ExportImageWarning[] = output.imageWarnings.map((assetRef) => ({
        assetRef,
        reason: available.has(assetRef) ? IMAGE_NOT_EMBEDDABLE_REASON : IMAGE_NOT_AVAILABLE_REASON,
      }));
      const { warnings, message } = summarizeDocumentExport(document, imageWarnings);
      await context.log('Word 已导出', { blockCount: output.blockCount, warningCount: warnings.length });
      if (context.signal.aborted) throw new JobInterruptedError();
      await complete(db, tenant, request, { artifactId, warnings, message });
    },
  };
}

/** 写回结果。已有结果（同一请求的另一次执行先写了）时不覆盖；请求已不存在（被新的导出删除）时失败。 */
async function complete(
  db: Kysely<Database>,
  tenant: TenantContext,
  request: TechnicalPlanExportRequestRecord,
  result: { artifactId: string; warnings: string[]; message: string },
): Promise<void> {
  if (await completeTechnicalPlanExportRequest(db, tenant, request.id, result)) return;
  const current = await findTechnicalPlanExportRequest(db, tenant, request.id);
  if (!current) throw requestMissing();
}

export const technicalPlanExportJob = createTechnicalPlanExportJob();

export interface EnqueuedTechnicalPlanExport {
  job: JobRecord;
  request: TechnicalPlanExportRequestRecord;
}

/**
 * 取快照并入队（7.4h 的接口调用，路由先经 requireProject 校验项目）：入队前就能确定的错误按 saveTechnicalPlanExportRequest
 * 抛 400 / 413，不入队；本项目已有未结束的整本导出时抛 409 JOB_LOCKED，并删除刚保存的请求。入队成功后删除本项目的其他请求。
 */
export async function enqueueTechnicalPlanExport(
  deps: JobServiceDependencies,
  context: TenantContext,
  projectId: string,
): Promise<EnqueuedTechnicalPlanExport> {
  const request = await saveTechnicalPlanExportRequest(deps.db, context, projectId);
  let job: JobRecord;
  try {
    job = await enqueueJob(deps, context, {
      type: TECHNICAL_PLAN_EXPORT_JOB_TYPE,
      projectId,
      lockKey: technicalPlanExportLockKey(projectId),
      params: { requestId: request.id },
    });
  } catch (error) {
    await deleteTechnicalPlanExportRequests(deps.db, context, projectId, { onlyId: request.id }).catch((cleanupError: unknown) => {
      deps.log.warn({ err: cleanupError, projectId }, 'technical plan export request cleanup failed');
    });
    throw error;
  }
  // 任务按项目互斥：此时本项目其他请求的任务都已结束，它们的结果不再需要（每个项目只保留最近一次）。
  await deleteTechnicalPlanExportRequests(deps.db, context, projectId, { exceptId: request.id }).catch((cleanupError: unknown) => {
    deps.log.warn({ err: cleanupError, projectId }, 'technical plan export request cleanup failed');
  });
  return { job, request };
}
