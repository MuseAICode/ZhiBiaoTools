// 可研报告导出 Word 的任务（路线图第 7 步 7.5d；取代桌面版可研页面的 export.word），export 队列，不调用模型（决定事项第 7 项：
// 不计费、不检查余额）。接口（7.5e）调用 enqueueFeasibilityReportExport 入队。写法与技术方案整本导出（src/export/documentJob.ts）相同：
//
// - 入队：在一个事务中取快照存为可研导出请求（7.5c 的 saveFeasibilityExportRequest；没有目录、模板不可见、导出选项不合法、
//   快照过大时直接拒绝，不入队），任务参数只有请求 id（0021 的约定）；lock_key 按项目（project:{id}:feasibility-report-export），
//   同一项目同时只有一个可研导出，已有时 409 JOB_LOCKED；与可研的生成任务（feasibilityReportLockKey）互不影响，导出读的是快照。
//   入队成功后删除本项目的其他请求，入队失败时删除刚保存的请求；
// - 执行：以发起用户的身份读请求（必须属于任务的项目）→ 从快照的正文中找出引用的产物地址（/api/artifacts/<uuid>/content）→
//   只把其中本项目可见的图片产物以 assets/<产物 id> 放入（documentStore.ts 的 listTechnicalPlanExportImages，与整本导出相同；
//   不可见的不放，桌面版代码在原位提示“未找到可用图片数据”）→ 在 export-feasibility 沙箱中运行桌面版的可研导出代码
//   （src/export/feasibility.ts，新建沙箱之前按合计大小拒绝）→ 存为 feasibility-report-export 产物（7.5c：计入配额，同一事务中
//   替换本项目旧的导出）→ 写回提示与消息（completeFeasibilityExportRequest）；
// - 进度经 setProgress（SSE 推送）；可续跑：worker 崩溃或关闭后从头重新执行（快照不变），已有结果时直接结束；
// - 任务日志只写阶段与计数，不写目录标题、正文和配图。
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { JobError, JobInterruptedError, type JobTypeDefinition } from '../jobs/definitions.ts';
import { enqueueJob, type JobServiceDependencies } from '../jobs/service.ts';
import type { JobRecord } from '../jobs/store.ts';
import { listTechnicalPlanExportImages } from './documentStore.ts';
import { renderFeasibilityReportDocument, type FeasibilityExportOutlineItem } from './feasibility.ts';
import {
  completeFeasibilityExportRequest,
  deleteFeasibilityExportRequests,
  findFeasibilityExportRequest,
  saveFeasibilityExportRequest,
  type FeasibilityExportRequestRecord,
  type SaveFeasibilityExportRequestInput,
} from './feasibilityRequestStore.ts';
import { writeFeasibilityExportArtifact } from './feasibilityStore.ts';

export const FEASIBILITY_REPORT_EXPORT_JOB_TYPE = 'feasibility-report-export';
/** 项目名称为空时与桌面版 Renderer 相同的默认值（state.projectInfo.projectName || '可行性研究报告'）。 */
export const FEASIBILITY_DEFAULT_PROJECT_NAME = '可行性研究报告';

export interface FeasibilityReportExportParams {
  requestId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 正文中的产物地址：与沙箱入口（server/sandbox/export/feasibility.mjs 的 FEASIBILITY_IMAGE_URL）认的形式相同（id 不区分大小写）。 */
const ARTIFACT_URL = /\/api\/artifacts\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/content/g;

function parseParams(raw: unknown): FeasibilityReportExportParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('可研导出任务参数不合法');
  const { requestId, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) throw new TypeError('可研导出任务参数不合法');
  return { requestId };
}

/** 可研导出的互斥键：同一项目同时只有一个可研导出（与可研的生成任务互不影响，导出读的是入队时的快照）。 */
export function feasibilityReportExportLockKey(projectId: string): string {
  return `project:${projectId}:feasibility-report-export`;
}

/**
 * 快照目录中引用的产物 id（小写、去重，按首次出现的顺序）。只看叶子的正文（快照只保存叶子的正文）；
 * 地址是否真的出现在图片中由桌面版代码决定，这里多找到的（例如普通链接）只会多查一次、不会放入不可见的产物。
 */
export function collectFeasibilityImageRefs(outline: readonly FeasibilityExportOutlineItem[]): string[] {
  const refs = new Set<string>();
  const visit = (items: readonly FeasibilityExportOutlineItem[]) => {
    for (const item of items) {
      if (item.content) for (const match of item.content.matchAll(ARTIFACT_URL)) refs.add(match[1]!.toLowerCase());
      if (item.children) visit(item.children);
    }
  };
  visit(outline);
  return [...refs];
}

function requestMissing(): JobError {
  return new JobError('EXPORT_REQUEST_NOT_FOUND', '导出请求不存在或已被新的导出取代，请重新导出');
}

export interface FeasibilityReportExportJobOptions {
  /** 沙箱数已达上限时重试创建前的等待（毫秒），见 src/export/document.ts。 */
  createRetryDelaysMs?: readonly number[];
}

export function createFeasibilityReportExportJob(options: FeasibilityReportExportJobOptions = {}): JobTypeDefinition<FeasibilityReportExportParams> {
  return {
    type: FEASIBILITY_REPORT_EXPORT_JOB_TYPE,
    queue: 'export',
    resumable: true,
    parseParams,
    async run(context) {
      const { db, tenant, params } = context;
      const request = await findFeasibilityExportRequest(db, tenant, params.requestId);
      if (!request || context.projectId === null || request.projectId !== context.projectId) throw requestMissing();
      if (request.result !== null || request.outline === null) {
        await context.log('Word 已导出');
        return;
      }
      const objectStore = context.objectStore;
      if (!objectStore) throw new JobError('EXPORT_UNAVAILABLE', '导出服务暂不可用，请稍后重试');

      const refs = collectFeasibilityImageRefs(request.outline);
      const assets = await listTechnicalPlanExportImages(db, tenant, request.projectId, refs);
      if (context.signal.aborted) throw new JobInterruptedError();
      await context.log('开始导出 Word', { imageCount: refs.length, availableImageCount: assets.length });
      await context.setProgress(5);

      const output = await renderFeasibilityReportDocument(context, objectStore, {
        projectName: request.projectName ?? FEASIBILITY_DEFAULT_PROJECT_NAME,
        outline: request.outline,
        exportFormat: request.exportFormat,
        options: request.options,
        assets,
      }, {
        ...(options.createRetryDelaysMs ? { createRetryDelaysMs: options.createRetryDelaysMs } : {}),
      });
      if (context.signal.aborted) throw new JobInterruptedError();
      await context.setProgress(90);

      let artifactId: string;
      try {
        artifactId = (await writeFeasibilityExportArtifact(db, tenant, objectStore, request.projectId, output.docx)).id;
      } catch (error) {
        if (error instanceof AppError) throw new JobError(error.code, error.message, { cause: error });
        throw error;
      }
      await context.log('Word 已导出', { warningCount: output.warnings.length });
      if (context.signal.aborted) throw new JobInterruptedError();
      await complete(db, tenant, request, { artifactId, warnings: output.warnings, message: output.message });
    },
  };
}

/** 写回结果。已有结果（同一请求的另一次执行先写了）时不覆盖；请求已不存在（被新的导出删除）时失败。 */
async function complete(
  db: Kysely<Database>,
  tenant: TenantContext,
  request: FeasibilityExportRequestRecord,
  result: { artifactId: string; warnings: string[]; message: string },
): Promise<void> {
  if (await completeFeasibilityExportRequest(db, tenant, request.id, result)) return;
  const current = await findFeasibilityExportRequest(db, tenant, request.id);
  if (!current) throw requestMissing();
}

export const feasibilityReportExportJob = createFeasibilityReportExportJob();

export interface EnqueuedFeasibilityReportExport {
  job: JobRecord;
  request: FeasibilityExportRequestRecord;
}

/**
 * 取快照并入队（7.5e 的接口调用，路由先经 requireProject 校验项目）：入队前就能确定的错误按 saveFeasibilityExportRequest
 * 抛 400 / 413，不入队；本项目已有未结束的可研导出时抛 409 JOB_LOCKED，并删除刚保存的请求。入队成功后删除本项目的其他请求。
 */
export async function enqueueFeasibilityReportExport(
  deps: JobServiceDependencies,
  context: TenantContext,
  projectId: string,
  input: SaveFeasibilityExportRequestInput,
): Promise<EnqueuedFeasibilityReportExport> {
  const request = await saveFeasibilityExportRequest(deps.db, context, projectId, input);
  let job: JobRecord;
  try {
    job = await enqueueJob(deps, context, {
      type: FEASIBILITY_REPORT_EXPORT_JOB_TYPE,
      projectId,
      lockKey: feasibilityReportExportLockKey(projectId),
      params: { requestId: request.id },
    });
  } catch (error) {
    await deleteFeasibilityExportRequests(deps.db, context, projectId, { onlyId: request.id }).catch((cleanupError: unknown) => {
      deps.log.warn({ err: cleanupError, projectId }, 'feasibility report export request cleanup failed');
    });
    throw error;
  }
  // 任务按项目互斥：此时本项目其他请求的任务都已结束，它们的结果不再需要（每个项目只保留最近一次）。
  await deleteFeasibilityExportRequests(deps.db, context, projectId, { exceptId: request.id }).catch((cleanupError: unknown) => {
    deps.log.warn({ err: cleanupError, projectId }, 'feasibility report export request cleanup failed');
  });
  return { job, request };
}
