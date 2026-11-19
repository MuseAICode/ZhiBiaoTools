// 技术方案接口（路线图第 5 步 5.11~5.13）。需要登录，组织取自会话；先经 requireProject 校验项目属于本组织、未删除、
// kind 是 technical-plan，不符一律 404。组织内成员都可以查看和编辑（组织内共享，第 9 节第 2 项），可见性、写权限与删除
// 可见性由 RLS 保证。对应桌面版 technicalPlan.loadState / updateStep / clear / saveGenerationConfig / saveBidAnalysisConfig /
// saveContentGenerationOptions / importTenderDocument / removeTenderDocument / importOriginalPlanDocument /
// removeOriginalPlanDocument / readTenderMarkdown / readTenderSourceMarkdown / selectBidSection / saveOutline / saveGlobalFacts /
// saveChapterContent / resetContentGeneration。
//
// GET    /api/projects/:projectId/technical-plan                                    完整状态（任务状态随第 6 步）
// PATCH  /api/projects/:projectId/technical-plan/step                               切换页面步骤
// PATCH  /api/projects/:projectId/technical-plan/generation-config                  局部保存生成配置（切换单 / 多标段时清空下游）
// PUT    /api/projects/:projectId/technical-plan/bid-analysis-config                保存招标解析模式与选中的解析项
// PUT    /api/projects/:projectId/technical-plan/content-options                    保存正文生成选项
// POST   /api/projects/:projectId/technical-plan/tender-files                       导入招标文件（追加，挂已上传的 tender 文件，待解析）
// DELETE /api/projects/:projectId/technical-plan/tender-files/:fileId               移除一份招标文件（原件进回收站）
// GET    /api/projects/:projectId/technical-plan/tender-files/:fileId/markdown      一份招标文件的 Markdown 原文（附件下载）
// GET    /api/projects/:projectId/technical-plan/tender-markdown                    当前投标范围的招标正文（合并、按标段裁剪，附件下载）
// PUT    /api/projects/:projectId/technical-plan/original-plan                      上传原方案（替换，旧原件进回收站）
// DELETE /api/projects/:projectId/technical-plan/original-plan                      移除原方案（原件进回收站）
// PUT    /api/projects/:projectId/technical-plan/bid-section                        选择投标范围
// PUT    /api/projects/:projectId/technical-plan/outline                            保存目录（reason 协议，见 Store）
// PUT    /api/projects/:projectId/technical-plan/global-facts                       保存全局事实（同时清空正文阶段）
// PUT    /api/projects/:projectId/technical-plan/chapters/:nodeId                   手工保存一节正文
// DELETE /api/projects/:projectId/technical-plan/content-generation                 重置正文阶段（保留目录、全局事实和生成配置）
// DELETE /api/projects/:projectId/technical-plan                                    清空（招标文件与原方案进回收站）
// POST   /api/projects/:projectId/technical-plan/bid-section-extraction             开始多标段识别（入队 bid-section-extraction）
// POST   /api/projects/:projectId/technical-plan/bid-analysis                       开始招标解析（入队 bid-analysis）
// POST   /api/projects/:projectId/technical-plan/global-facts-generation            开始生成全局事实（入队 global-facts-generation，agent 队列，8.7c1）
// POST   /api/projects/:projectId/technical-plan/export                             整本导出 Word（入队 technical-plan-export，7.4h）
// GET    /api/projects/:projectId/technical-plan/export/:requestId                  整本导出的状态（pending / ready / expired）、提示与消息
// GET    /api/projects/:projectId/technical-plan/export/:requestId/content          导出的 docx（附件下载）
//
// 导入招标文件、上传原方案后自动入队文档解析（6.6，src/parse/）。多标段识别与招标解析是任务（6.11，src/technicalPlan/jobs.ts），结果由任务
// 经 Store 函数写入，进度、取消、暂停、继续经 /api/jobs 与 SSE；与桌面版相同，招标文件变化（导入、移除）和清空时取消本项目进行中的技术方案
// 任务。疑似多标段检测（桌面版 checkBidSections）由解析任务在 worker 中算出，在 GET 的 bidSectionDetection 中返回。
// 全局事实生成在 agent 沙箱中执行（8.7c1，src/technicalPlan/jobs.ts），全局事实的写法与引用的知识库文档取已保存的生成配置，请求体不采用。
// 目录生成 / 调整、全局事实调整、正文生成、小节 Word 预览 previewContentWord 随第 8 步；openBidTemplate 随第 8 步（它打开的投标模板由模板提取生成，模板提取随第 8 步）。
//
// 整本导出 Word（7.4h，取代桌面版 export.word 的技术方案整本导出与 export.openFile）：POST 经 enqueueTechnicalPlanExport 取快照入队
// （没有目录、没有有效模板、标题超过六级 400，快照过大 413，本项目已有未结束的整本导出 409 JOB_LOCKED，均不入队），按用户限流
// （technicalPlanExportPerUser，超出 429，在取快照之前计数）；进度与结果经任务的 SSE，任务成功后按 requestId 取状态（提示与消息）
// 并下载。请求属于项目、本组织内成员可见（RLS），不属于这个项目的与不存在的一样 404；每个项目只保留最近一次：新的导出入队后
// 旧的请求被删除（404），旧的产物被替换或 7 天后清理（410）。桌面版保存后“打开文件”在 Web 版就是浏览器下载这个附件。
// 不计费、不检查余额（第 7 步决定事项第 7 项）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import {
  TECHNICAL_PLAN_BID_ANALYSIS_MODES,
  TECHNICAL_PLAN_BID_ITEM_IDS,
  TECHNICAL_PLAN_BID_SECTION_MODES,
  TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES,
  TECHNICAL_PLAN_GLOBAL_FACTS_MODES,
  TECHNICAL_PLAN_HTML_IMAGE_TYPES_MAX,
  TECHNICAL_PLAN_IMAGE_QUANTITIES,
  TECHNICAL_PLAN_KEY_MAX,
  TECHNICAL_PLAN_OUTLINE_EXPANSION_MODES,
  TECHNICAL_PLAN_OUTLINE_MODES,
  TECHNICAL_PLAN_STEPS,
  TECHNICAL_PLAN_TABLE_REQUIREMENTS,
  TECHNICAL_PLAN_TITLE_MAX,
  TECHNICAL_PLAN_WORDS_MAX,
} from '../db/migrations/0018_technical_plan.ts';
import { TECHNICAL_PLAN_CONTENT_MAX, TECHNICAL_PLAN_FACT_CONTENT_MAX, TECHNICAL_PLAN_FACT_ID_MAX } from '../db/migrations/0019_technical_plan_outline.ts';
import { findArtifact } from '../artifacts/store.ts';
import type { RateLimitDecision } from '../auth/rateLimit.ts';
import { DOCX_MIME } from '../db/migrations/0027_template_preview.ts';
import type { Database, TechnicalPlanBidItemId, TechnicalPlanStep } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { enqueueTechnicalPlanExport } from '../export/documentJob.ts';
import { findTechnicalPlanExportRequest, type TechnicalPlanExportRequestRecord } from '../export/documentRequestStore.ts';
import { attachmentDisposition, sanitizeDisplayName } from '../files/filename.ts';
import { fileTimestamp } from '../xlsx/displayTime.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { storageDisabled } from '../knowledgeBase/content.ts';
import type { JobServiceDependencies } from '../jobs/service.ts';
import { jobBody } from '../jobs/view.ts';
import { enqueueDocumentParses } from '../parse/enqueue.ts';
import { PROJECT_ID_PARAMS, requireProject } from '../projects/access.ts';
import {
  TECHNICAL_PLAN_FACT_GROUPS_MAX,
  TECHNICAL_PLAN_OUTLINE_NODES_MAX,
  TECHNICAL_PLAN_OUTLINE_SAVE_REASONS,
} from '../technicalPlan/outline.ts';
import { cancelTechnicalPlanJobs, startBidAnalysis, startBidSectionExtraction, startGlobalFactsGeneration } from '../technicalPlan/jobs.ts';
import {
  clearTechnicalPlan,
  findTenderFileMarkdown,
  importTenderFiles,
  loadTechnicalPlan,
  readTenderMarkdown,
  removeOriginalPlan,
  removeTenderFile,
  resetContentGeneration,
  saveBidAnalysisConfig,
  saveChapterContent,
  saveContentGenerationOptions,
  saveGenerationConfig,
  saveGlobalFacts,
  saveOutline,
  selectBidSection,
  setOriginalPlan,
  TECHNICAL_PLAN_REFERENCE_DOCUMENTS_MAX,
  TECHNICAL_PLAN_TENDER_FILES_MAX,
  updateStep,
  type BidAnalysisConfigInput,
  type ContentGenerationOptions,
  type GenerationConfigPatch,
  type SaveOutlineInput,
} from '../technicalPlan/store.ts';

export interface TechnicalPlanRouteDependencies {
  db: Kysely<Database>;
  /** 读取招标文件的 Markdown 用；未配置时读取已解析的文件返回 503（还没有 Markdown 时除外）。 */
  objectStore: ObjectStore | null;
  /** 导入后入队文档解析任务（6.6）、整本导出任务（7.4h）。 */
  jobs: JobServiceDependencies;
  /** 整本导出的入队按用户限流（7.4h）。 */
  exportLimiter: { consume(key: string): Promise<RateLimitDecision> };
}

const UUID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;

const FILE_PARAMS = {
  type: 'object',
  properties: { ...PROJECT_ID_PARAMS.properties, fileId: UUID },
  required: ['projectId', 'fileId'],
  additionalProperties: false,
} as const;

const STEP_SCHEMA = {
  type: 'object',
  properties: { step: { type: 'string', enum: [...TECHNICAL_PLAN_STEPS] } },
  required: ['step'],
  additionalProperties: false,
} as const;

const BID_TASK_IDS = { type: 'array', maxItems: TECHNICAL_PLAN_BID_ITEM_IDS.length, items: { type: 'string', enum: [...TECHNICAL_PLAN_BID_ITEM_IDS] } } as const;
const WORDS = { type: 'integer', minimum: 0, maximum: TECHNICAL_PLAN_WORDS_MAX } as const;

const CONTENT_OPTIONS = {
  type: 'object',
  properties: {
    imageQuantity: { type: 'integer', enum: [...TECHNICAL_PLAN_IMAGE_QUANTITIES] },
    useAiImages: { type: 'boolean' },
    useMermaidImages: { type: 'boolean' },
    useHtmlImages: { type: 'boolean' },
    htmlImageOptimization: { type: 'boolean' },
    wordCountRepair: { type: 'boolean' },
    layoutCheck: { type: 'boolean' },
    useSingleImageLayout: { type: 'boolean' },
    useImageTextLayout: { type: 'boolean' },
    useThreeImagesLayout: { type: 'boolean' },
    useFourImagesLayout: { type: 'boolean' },
    htmlImageTypes: { type: 'string', maxLength: TECHNICAL_PLAN_HTML_IMAGE_TYPES_MAX },
    tableRequirement: { type: 'string', enum: [...TECHNICAL_PLAN_TABLE_REQUIREMENTS] },
  },
  additionalProperties: false,
} as const;

// 每个字段都可省略（局部保存）；与桌面版相同，contentGenerationOptions、outlineWordControlOptions 给出时整份替换。
const GENERATION_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    bidAnalysisMode: { type: 'string', enum: [...TECHNICAL_PLAN_BID_ANALYSIS_MODES] },
    bidAnalysisSelectedTaskIds: BID_TASK_IDS,
    bidSectionMode: { type: 'string', enum: [...TECHNICAL_PLAN_BID_SECTION_MODES] },
    outlineMode: { type: 'string', enum: [...TECHNICAL_PLAN_OUTLINE_MODES] },
    outlineExpansionMode: { type: 'string', enum: [...TECHNICAL_PLAN_OUTLINE_EXPANSION_MODES] },
    outlineWordControlOptions: {
      type: 'object',
      properties: { minimumWords: WORDS, maximumWords: WORDS, sectionWords: WORDS },
      additionalProperties: false,
    },
    referenceKnowledgeDocumentIds: { type: 'array', maxItems: TECHNICAL_PLAN_REFERENCE_DOCUMENTS_MAX, items: UUID },
    globalFactsMode: { type: 'string', enum: [...TECHNICAL_PLAN_GLOBAL_FACTS_MODES] },
    exportTemplateId: { anyOf: [UUID, { type: 'null' }] },
    exportTemplateScope: { type: 'string', enum: [...TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES] },
    contentGenerationOptions: CONTENT_OPTIONS,
  },
  additionalProperties: false,
} as const;

const BID_ANALYSIS_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: [...TECHNICAL_PLAN_BID_ANALYSIS_MODES] },
    selectedTaskIds: BID_TASK_IDS,
    bidSectionMode: { type: 'string', enum: [...TECHNICAL_PLAN_BID_SECTION_MODES] },
  },
  required: ['mode', 'selectedTaskIds'],
  additionalProperties: false,
} as const;

const CONTENT_OPTIONS_SCHEMA = {
  type: 'object',
  properties: { contentGenerationOptions: CONTENT_OPTIONS },
  required: ['contentGenerationOptions'],
  additionalProperties: false,
} as const;

const TENDER_FILES_SCHEMA = {
  type: 'object',
  properties: { fileIds: { type: 'array', minItems: 1, maxItems: TECHNICAL_PLAN_TENDER_FILES_MAX, items: UUID } },
  required: ['fileIds'],
  additionalProperties: false,
} as const;

const ORIGINAL_PLAN_SCHEMA = {
  type: 'object',
  properties: { fileId: UUID },
  required: ['fileId'],
  additionalProperties: false,
} as const;

const BID_SECTION_SCHEMA = {
  type: 'object',
  properties: { sectionId: { type: 'string', minLength: 1, maxLength: TECHNICAL_PLAN_KEY_MAX } },
  required: ['sectionId'],
  additionalProperties: false,
} as const;

// 目录的结构与字段由 Store 逐项校验（与桌面版 Renderer 的 TechnicalPlanOutlineData 相同）；节点带正文，请求体上限放宽。
const OUTLINE_BODY_LIMIT = 16 * 1024 * 1024;

const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    outlineData: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    reason: { type: 'string', enum: [...TECHNICAL_PLAN_OUTLINE_SAVE_REASONS] },
    affectedNodeIds: { type: 'array', maxItems: TECHNICAL_PLAN_OUTLINE_NODES_MAX, items: UUID },
  },
  required: ['outlineData', 'reason'],
  additionalProperties: false,
} as const;

// 与桌面版 Renderer 的 GlobalFactGroup 相同；updated_at 由服务端决定，请求中的忽略。
const GLOBAL_FACTS_BODY_LIMIT = 16 * 1024 * 1024;

const GLOBAL_FACTS_SCHEMA = {
  type: 'object',
  properties: {
    globalFacts: {
      type: 'array',
      maxItems: TECHNICAL_PLAN_FACT_GROUPS_MAX,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: TECHNICAL_PLAN_FACT_ID_MAX },
          group_id: { type: 'string', maxLength: TECHNICAL_PLAN_FACT_ID_MAX },
          title: { type: 'string', maxLength: TECHNICAL_PLAN_TITLE_MAX },
          content: { type: 'string', maxLength: TECHNICAL_PLAN_FACT_CONTENT_MAX },
          updated_at: { type: 'string', maxLength: 64 },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['globalFacts'],
  additionalProperties: false,
} as const;

// 只重新解析其中的项（taskIds）或全部重新解析（forceRerun）；请求体可以省略。
const BID_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    taskIds: { ...BID_TASK_IDS, minItems: 1 },
    forceRerun: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

const CHAPTER_PARAMS = {
  type: 'object',
  properties: { ...PROJECT_ID_PARAMS.properties, nodeId: UUID },
  required: ['projectId', 'nodeId'],
  additionalProperties: false,
} as const;

// 单节正文最多 TECHNICAL_PLAN_CONTENT_MAX 字（Store 按 Unicode 字符再查一次），UTF-8 下中文 3 字节，另留转义的余量。
const CHAPTER_BODY_LIMIT = 4 * 1024 * 1024 + 64 * 1024;

const CHAPTER_SCHEMA = {
  type: 'object',
  properties: { content: { type: 'string', maxLength: TECHNICAL_PLAN_CONTENT_MAX } },
  required: ['content'],
  additionalProperties: false,
} as const;

type ProjectParams = { Params: { projectId: string } };
type ChapterParams = { Params: { projectId: string; nodeId: string } };
type ExportParams = { Params: { projectId: string; requestId: string } };

const EXPORT_PARAMS = {
  type: 'object',
  properties: { ...PROJECT_ID_PARAMS.properties, requestId: UUID },
  required: ['projectId', 'requestId'],
  additionalProperties: false,
} as const;

function exportNotFound(): AppError {
  return new AppError(404, 'EXPORT_NOT_FOUND', '导出记录不存在或已被新的导出取代');
}

function exportExpired(): AppError {
  return new AppError(410, 'EXPORT_EXPIRED', '导出的 Word 已过期或已被新的导出替换，请重新导出');
}

/** 下载文件名：<项目名称>_YYYYMMDD_HHMMSS.docx（同桌面版 export.word 的默认文件名；时间为完成时间，按北京时间）。 */
export function technicalPlanExportFileName(request: TechnicalPlanExportRequestRecord): string {
  const name = request.projectName?.trim() ? request.projectName : '标书文档';
  return sanitizeDisplayName(`${name}_${fileTimestamp(request.completedAt ?? request.createdAt)}.docx`);
}
type FileParams = { Params: { projectId: string; fileId: string } };

/** 与 /api/artifacts/:artifactId/content 相同：一律附件、nosniff、sandbox CSP，Markdown 原文不会在本站内被当作页面渲染。 */
function markdownHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('content-type', 'text/markdown; charset=utf-8')
    .header('content-disposition', attachmentDisposition('content.md'))
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox");
}

export async function registerTechnicalPlanRoutes(app: FastifyInstance, deps: TechnicalPlanRouteDependencies): Promise<void> {
  const { db } = deps;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** 校验项目并返回小写的 projectId。 */
  async function project(request: FastifyRequest<ProjectParams>): Promise<string> {
    return (await requireProject(db, tenantOf(request), request.params.projectId, 'technical-plan')).id;
  }

  /**
   * 招标文件变化、清空后取消进行中的技术方案任务。桌面版在提交前取消；这里在提交后取消，提交与取消之间旧任务的写入因签名不符被拒绝，
   * 响应中的状态在取消后重新读取，与桌面版一致。
   */
  async function cancelJobs(request: FastifyRequest, projectId: string): Promise<void> {
    await cancelTechnicalPlanJobs(deps.jobs, tenantOf(request), projectId);
  }

  app.get<ProjectParams>('/:projectId/technical-plan', { schema: { params: PROJECT_ID_PARAMS } }, async (request) =>
    loadTechnicalPlan(db, tenantOf(request), await project(request)),
  );

  app.patch<ProjectParams & { Body: { step: TechnicalPlanStep } }>(
    '/:projectId/technical-plan/step',
    { schema: { params: PROJECT_ID_PARAMS, body: STEP_SCHEMA } },
    async (request) => updateStep(db, tenantOf(request), await project(request), request.body.step),
  );

  app.patch<ProjectParams & { Body: GenerationConfigPatch }>(
    '/:projectId/technical-plan/generation-config',
    { schema: { params: PROJECT_ID_PARAMS, body: GENERATION_CONFIG_SCHEMA } },
    async (request) => saveGenerationConfig(db, tenantOf(request), await project(request), request.body),
  );

  app.put<ProjectParams & { Body: BidAnalysisConfigInput }>(
    '/:projectId/technical-plan/bid-analysis-config',
    { schema: { params: PROJECT_ID_PARAMS, body: BID_ANALYSIS_CONFIG_SCHEMA } },
    async (request) => saveBidAnalysisConfig(db, tenantOf(request), await project(request), request.body),
  );

  app.put<ProjectParams & { Body: { contentGenerationOptions: Partial<ContentGenerationOptions> } }>(
    '/:projectId/technical-plan/content-options',
    { schema: { params: PROJECT_ID_PARAMS, body: CONTENT_OPTIONS_SCHEMA } },
    async (request) => saveContentGenerationOptions(db, tenantOf(request), await project(request), request.body.contentGenerationOptions),
  );

  app.post<ProjectParams & { Body: { fileIds: string[] } }>(
    '/:projectId/technical-plan/tender-files',
    { schema: { params: PROJECT_ID_PARAMS, body: TENDER_FILES_SCHEMA } },
    async (request) => {
      const projectId = await project(request);
      const result = await importTenderFiles(db, tenantOf(request), projectId, request.body.fileIds);
      await enqueueDocumentParses(deps.jobs, tenantOf(request), projectId, 'technical-plan-tender', result.addedFileIds);
      if (result.addedCount === 0) return result;
      await cancelJobs(request, projectId);
      return { ...result, state: await loadTechnicalPlan(db, tenantOf(request), projectId) };
    },
  );

  app.delete<FileParams>('/:projectId/technical-plan/tender-files/:fileId', { schema: { params: FILE_PARAMS } }, async (request) => {
    const projectId = await project(request);
    await removeTenderFile(db, tenantOf(request), projectId, request.params.fileId);
    await cancelJobs(request, projectId);
    return loadTechnicalPlan(db, tenantOf(request), projectId);
  });

  app.get<FileParams>('/:projectId/technical-plan/tender-files/:fileId/markdown', { schema: { params: FILE_PARAMS } }, async (request, reply) => {
    const { artifact } = await findTenderFileMarkdown(db, tenantOf(request), await project(request), request.params.fileId);
    markdownHeaders(reply);
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

  app.get<ProjectParams>('/:projectId/technical-plan/tender-markdown', { schema: { params: PROJECT_ID_PARAMS } }, async (request, reply) => {
    const markdown = await readTenderMarkdown(db, tenantOf(request), await project(request), deps.objectStore);
    // 与桌面版读取的 tender.md 相同：非空时末尾带一个换行。
    return markdownHeaders(reply).send(markdown ? `${markdown}\n` : '');
  });

  app.put<ProjectParams & { Body: { fileId: string } }>(
    '/:projectId/technical-plan/original-plan',
    { schema: { params: PROJECT_ID_PARAMS, body: ORIGINAL_PLAN_SCHEMA } },
    async (request) => {
      const projectId = await project(request);
      const state = await setOriginalPlan(db, tenantOf(request), projectId, request.body.fileId);
      // 新上传的原方案（待解析）入队；已是本项目原方案的文件不重复入队。
      const plan = state.originalPlanFile;
      if (plan && plan.id === request.body.fileId.toLowerCase() && plan.status === 'pending') {
        await enqueueDocumentParses(deps.jobs, tenantOf(request), projectId, 'technical-plan-original-plan', [plan.id]);
      }
      return state;
    },
  );

  app.delete<ProjectParams>('/:projectId/technical-plan/original-plan', { schema: { params: PROJECT_ID_PARAMS } }, async (request) =>
    removeOriginalPlan(db, tenantOf(request), await project(request)),
  );

  app.put<ProjectParams & { Body: { sectionId: string } }>(
    '/:projectId/technical-plan/bid-section',
    { schema: { params: PROJECT_ID_PARAMS, body: BID_SECTION_SCHEMA } },
    async (request) => selectBidSection(db, tenantOf(request), await project(request), request.body.sectionId, deps.objectStore),
  );

  app.put<ProjectParams & { Body: SaveOutlineInput }>(
    '/:projectId/technical-plan/outline',
    { schema: { params: PROJECT_ID_PARAMS, body: OUTLINE_SCHEMA }, bodyLimit: OUTLINE_BODY_LIMIT },
    async (request) => saveOutline(db, tenantOf(request), await project(request), request.body),
  );

  app.put<ProjectParams & { Body: { globalFacts: unknown[] } }>(
    '/:projectId/technical-plan/global-facts',
    { schema: { params: PROJECT_ID_PARAMS, body: GLOBAL_FACTS_SCHEMA }, bodyLimit: GLOBAL_FACTS_BODY_LIMIT },
    async (request) => saveGlobalFacts(db, tenantOf(request), await project(request), request.body.globalFacts),
  );

  app.put<ChapterParams & { Body: { content: string } }>(
    '/:projectId/technical-plan/chapters/:nodeId',
    { schema: { params: CHAPTER_PARAMS, body: CHAPTER_SCHEMA }, bodyLimit: CHAPTER_BODY_LIMIT },
    async (request) => saveChapterContent(db, tenantOf(request), await project(request), request.params.nodeId, request.body.content),
  );

  app.delete<ProjectParams>('/:projectId/technical-plan/content-generation', { schema: { params: PROJECT_ID_PARAMS } }, async (request) =>
    resetContentGeneration(db, tenantOf(request), await project(request)),
  );

  app.delete<ProjectParams>('/:projectId/technical-plan', { schema: { params: PROJECT_ID_PARAMS } }, async (request) => {
    const projectId = await project(request);
    const result = await clearTechnicalPlan(db, tenantOf(request), projectId);
    await cancelJobs(request, projectId);
    return result;
  });

  app.post<ProjectParams>('/:projectId/technical-plan/bid-section-extraction', { schema: { params: PROJECT_ID_PARAMS } }, async (request, reply) => {
    const job = await startBidSectionExtraction(deps.jobs, tenantOf(request), await project(request));
    return reply.code(202).send({ job: jobBody(job) });
  });

  app.post<ProjectParams & { Body: { taskIds?: TechnicalPlanBidItemId[]; forceRerun?: boolean } }>(
    '/:projectId/technical-plan/bid-analysis',
    {
      schema: { params: PROJECT_ID_PARAMS, body: BID_ANALYSIS_SCHEMA },
      preValidation: async (request) => {
        request.body ??= {};
      },
    },
    async (request, reply) => {
      const job = await startBidAnalysis(deps.jobs, tenantOf(request), await project(request), request.body);
      return reply.code(202).send({ job: jobBody(job) });
    },
  );

  app.post<ProjectParams>('/:projectId/technical-plan/global-facts-generation', { schema: { params: PROJECT_ID_PARAMS } }, async (request, reply) => {
    const job = await startGlobalFactsGeneration(deps.jobs, tenantOf(request), await project(request));
    return reply.code(202).send({ job: jobBody(job) });
  });

  app.post<ProjectParams>('/:projectId/technical-plan/export', { schema: { params: PROJECT_ID_PARAMS } }, async (request, reply) => {
    const context = tenantOf(request);
    const projectId = await project(request);
    const decision = await deps.exportLimiter.consume(context.userId);
    if (!decision.allowed) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      throw new AppError(429, 'TOO_MANY_REQUESTS', '请求过于频繁，请稍后再试');
    }
    const enqueued = await enqueueTechnicalPlanExport(deps.jobs, context, projectId);
    return reply.code(202).send({ requestId: enqueued.request.id, job: jobBody(enqueued.job) });
  });

  /** 本项目的整本导出请求与结果产物（产物已被替换或清理时为 null）。 */
  async function exportOf(request: FastifyRequest<ExportParams>) {
    const context = tenantOf(request);
    const projectId = await project(request);
    const record = await findTechnicalPlanExportRequest(db, context, request.params.requestId.toLowerCase());
    if (!record || record.projectId !== projectId) throw exportNotFound();
    const artifact = record.result === null ? null : await findArtifact(db, context, record.result.artifactId);
    return { record, artifact };
  }

  app.get<ExportParams>('/:projectId/technical-plan/export/:requestId', { schema: { params: EXPORT_PARAMS } }, async (request) => {
    const { record, artifact } = await exportOf(request);
    const status = record.result === null ? 'pending' : artifact ? 'ready' : 'expired';
    return {
      id: record.id,
      status,
      fileName: status === 'ready' ? technicalPlanExportFileName(record) : null,
      size: artifact?.size ?? null,
      warnings: record.result?.warnings ?? [],
      message: record.result?.message ?? null,
      createdAt: record.createdAt.toISOString(),
      completedAt: record.completedAt?.toISOString() ?? null,
    };
  });

  // 与文件下载相同：一律附件、nosniff、sandbox CSP，由 api 从对象存储流式转发。
  app.get<ExportParams>('/:projectId/technical-plan/export/:requestId/content', { schema: { params: EXPORT_PARAMS } }, async (request, reply) => {
    if (!deps.objectStore) throw storageDisabled();
    const { record, artifact } = await exportOf(request);
    if (record.result === null) throw new AppError(409, 'EXPORT_NOT_READY', 'Word 尚未导出完成');
    if (!artifact) throw exportExpired();
    const object = await deps.objectStore.get(artifact.storageKey);
    if (!object) {
      request.log.error({ artifactId: artifact.id }, 'technical plan export object is missing from object storage');
      throw exportExpired();
    }
    reply
      .header('content-type', DOCX_MIME)
      .header('content-length', String(artifact.size))
      .header('content-disposition', attachmentDisposition(technicalPlanExportFileName(record)))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox");
    // cache-control 由本插件的 onSend 统一设为 no-store。
    return reply.send(object.body);
  });
}
