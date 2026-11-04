// 模板样张任务（路线图第 7 步 7.3d；取代桌面版 templateIpc → openXmlHelperService 的样张预览队列），export 队列，
// 不调用模型（决定事项第 7 项：不计费、不检查余额），组织级（没有项目）。接口（7.3e，POST /api/export-templates/preview）
// 调用 enqueueTemplatePreview 入队。
//
// 两个任务类型，执行完全相同（同一个 createTemplatePreviewJob）：
// - template-preview：页面上的样张预览，参与“新请求取代旧请求”；
// - template-word-export（7.3e）：样张导出 Word（桌面版 export.word 的 template_html），“固定使用本次导出的设置、不参与预览请求合并”：
//   不取消别的请求，也不会被之后的样张预览取消（取代只按同一任务类型）。按输入哈希复用时与样张共用结果。
//
// - 入队：样张 HTML 经 validatePreviewHtml 校验、配置经 normalizeExportFormat 规范化（preparePreviewRequest），不通过返回 400、
//   不入队；样张请求存进 template_preview_requests（只有创建者可见），任务参数只有请求 id（0021 的约定）；
// - 取代旧请求（对应桌面版“新请求取代旧请求”，#50 确认时决定不用 lock_key）：新建样张任务的同一事务中，把本用户排队中的样张任务
//   改为 cancelled，运行中的继续（src/jobs/store.ts 的 supersedeQueued）；同一用户任何时候最多一个排队中的样张；
// - 执行：以发起用户的身份读样张请求 → 重新准备一次，哈希必须与保存时相同 → 本组织 23 小时内同一输入的结果直接复用 →
//   否则在 export-preview 沙箱中生成（renderTemplatePreview）并存为 template-preview 产物（计入组织存储配额）→ 写回请求的结果；
// - 可续跑：worker 崩溃或关闭后从头重新执行；产物已写入而结果未写回时，重新执行按输入哈希复用那份产物，不再生成；
// - 任务日志只写阶段与块数，不写样张内容。
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { JobError, JobInterruptedError, type JobTypeDefinition } from '../jobs/definitions.ts';
import { enqueueJobSuperseding, type JobServiceDependencies } from '../jobs/service.ts';
import type { JobRecord } from '../jobs/store.ts';
import { preparePreviewRequest, renderTemplatePreview, type TemplatePreviewInput } from './preview.ts';
import {
  completeTemplatePreviewRequest,
  findReusableTemplatePreview,
  findTemplatePreviewRequest,
  saveTemplatePreviewRequest,
  writeTemplatePreviewArtifact,
  type TemplatePreviewRequestRecord,
} from './previewStore.ts';

export const TEMPLATE_PREVIEW_JOB_TYPE = 'template-preview';
export const TEMPLATE_WORD_EXPORT_JOB_TYPE = 'template-word-export';

/** 样张请求的用途：preview 为页面预览（新请求取代排队中的旧请求），word 为导出 Word（不参与取代）。 */
export type TemplatePreviewPurpose = 'preview' | 'word';
export const TEMPLATE_PREVIEW_PURPOSES: readonly TemplatePreviewPurpose[] = Object.freeze(['preview', 'word']);

export interface TemplatePreviewParams {
  requestId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseParams(raw: unknown): TemplatePreviewParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('样张任务参数不合法');
  const { requestId, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) throw new TypeError('样张任务参数不合法');
  return { requestId };
}

function requestMissing(): JobError {
  return new JobError('PREVIEW_REQUEST_NOT_FOUND', '样张请求不存在或已过期，请重新生成');
}

export interface TemplatePreviewJobOptions {
  /** 任务类型，默认 template-preview；样张导出 Word 为 template-word-export。 */
  type?: typeof TEMPLATE_PREVIEW_JOB_TYPE | typeof TEMPLATE_WORD_EXPORT_JOB_TYPE;
  /** 沙箱数已达上限时重试创建前的等待（毫秒），见 src/export/preview.ts。 */
  createRetryDelaysMs?: readonly number[];
}

export function createTemplatePreviewJob(options: TemplatePreviewJobOptions = {}): JobTypeDefinition<TemplatePreviewParams> {
  return {
    type: options.type ?? TEMPLATE_PREVIEW_JOB_TYPE,
    queue: 'export',
    resumable: true,
    parseParams,
    async run(context) {
      const { db, tenant, params } = context;
      const request = await findTemplatePreviewRequest(db, tenant, params.requestId);
      if (!request) throw requestMissing();
      if (request.artifactId !== null) {
        await context.log('样张已生成');
        return;
      }
      // 读回的内容重新准备一次：校验规则若已收紧，旧请求在这里被拒绝；哈希必须与保存时相同（保存后内容不能改，见迁移 0027）。
      const prepared = preparePreviewRequest({ html: request.html, exportFormat: request.exportFormat });
      if (prepared.sha256.toString('hex') !== request.inputSha256) throw new JobError('PREVIEW_REQUEST_INVALID', '样张请求不合法，请重新生成');

      let artifactId: string;
      const reusable = await findReusableTemplatePreview(db, tenant, prepared.sha256);
      if (reusable) {
        artifactId = reusable.id;
        await context.log('复用相同设置最近生成的样张');
      } else {
        const objectStore = context.objectStore;
        if (!objectStore) throw new JobError('EXPORT_UNAVAILABLE', '导出服务暂不可用，请稍后重试');
        await context.log('开始生成样张');
        const output = await renderTemplatePreview(context, { html: request.html, exportFormat: request.exportFormat }, {
          ...(options.createRetryDelaysMs ? { createRetryDelaysMs: options.createRetryDelaysMs } : {}),
        });
        if (context.signal.aborted) throw new JobInterruptedError();
        await context.setProgress(90);
        try {
          artifactId = (await writeTemplatePreviewArtifact(db, tenant, objectStore, prepared.sha256, output.docx)).id;
        } catch (error) {
          if (error instanceof AppError) throw new JobError(error.code, error.message, { cause: error });
          throw error;
        }
        await context.log('样张已生成', { blockCount: output.blockCount, imageWarnings: output.imageWarnings.length });
      }
      if (context.signal.aborted) throw new JobInterruptedError();
      await complete(db, tenant, request, artifactId);
    },
  };
}

/** 写回结果。已有结果（同一请求的另一次执行先写了）时不覆盖；请求已不存在（被清理）时失败。 */
async function complete(db: Kysely<Database>, tenant: TenantContext, request: TemplatePreviewRequestRecord, artifactId: string): Promise<void> {
  if (await completeTemplatePreviewRequest(db, tenant, request.id, artifactId)) return;
  const current = await findTemplatePreviewRequest(db, tenant, request.id);
  if (!current) throw requestMissing();
}

export const templatePreviewJob = createTemplatePreviewJob();
export const templateWordExportJob = createTemplatePreviewJob({ type: TEMPLATE_WORD_EXPORT_JOB_TYPE });

export interface EnqueuedTemplatePreview {
  job: JobRecord;
  request: TemplatePreviewRequestRecord;
  /** 被这次请求取代（取消）的排队中样张任务。 */
  superseded: JobRecord[];
}

/**
 * 校验样张并入队（7.3e 的接口调用）：不合法时抛 400 PREVIEW_HTML_INVALID，不保存、不入队；内容超过存储上限时抛 413
 * PREVIEW_TOO_LARGE。用途为 preview（默认）时同一事务中取消本用户排队中的样张任务；为 word 时入队 template-word-export，
 * 不取消任何任务。
 */
export async function enqueueTemplatePreview(
  deps: JobServiceDependencies,
  context: TenantContext,
  input: TemplatePreviewInput,
  purpose: TemplatePreviewPurpose = 'preview',
): Promise<EnqueuedTemplatePreview> {
  let prepared;
  try {
    prepared = preparePreviewRequest(input);
  } catch (error) {
    if (error instanceof JobError) throw new AppError(400, error.code, error.message, { cause: error });
    throw error;
  }
  const request = await saveTemplatePreviewRequest(deps.db, context, prepared);
  const { job, superseded } = await enqueueJobSuperseding(deps, context, {
    type: purpose === 'word' ? TEMPLATE_WORD_EXPORT_JOB_TYPE : TEMPLATE_PREVIEW_JOB_TYPE,
    projectId: null,
    lockKey: null,
    params: { requestId: request.id },
    supersedeQueued: purpose !== 'word',
  });
  return { job, request, superseded };
}
