// 技术方案接口（路线图第 5 步 5.11、5.12）。需要登录，组织取自会话；先经 requireProject 校验项目属于本组织、未删除、
// kind 是 technical-plan，不符一律 404。组织内成员都可以查看和编辑（组织内共享，第 9 节第 2 项），可见性、写权限与删除
// 可见性由 RLS 保证。对应桌面版 technicalPlan.loadState / updateStep / clear / saveGenerationConfig / saveBidAnalysisConfig /
// saveContentGenerationOptions / importTenderDocument / removeTenderDocument / importOriginalPlanDocument /
// removeOriginalPlanDocument / readTenderMarkdown / readTenderSourceMarkdown / selectBidSection / saveOutline / saveGlobalFacts。
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
// PUT    /api/projects/:projectId/technical-plan/global-facts                       保存全局事实（同时清空全部正文）
// DELETE /api/projects/:projectId/technical-plan                                    清空（招标文件与原方案进回收站）
//
// 文档解析、多标段识别、招标解析随第 6 步的任务队列；checkBidSections（疑似多标段的检测）随第 6 步由任务在服务端计算；
// 目录生成 / 调整、全局事实生成 / 调整随第 6 步（或第 8 步）；正文随 5.13；openBidTemplate、previewContentWord 随第 7 步。
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
import { TECHNICAL_PLAN_FACT_CONTENT_MAX, TECHNICAL_PLAN_FACT_ID_MAX } from '../db/migrations/0019_technical_plan_outline.ts';
import type { Database, TechnicalPlanStep } from '../db/schema.ts';
import { attachmentDisposition } from '../files/filename.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { storageDisabled } from '../knowledgeBase/content.ts';
import { PROJECT_ID_PARAMS, requireProject } from '../projects/access.ts';
import {
  TECHNICAL_PLAN_FACT_GROUPS_MAX,
  TECHNICAL_PLAN_OUTLINE_NODES_MAX,
  TECHNICAL_PLAN_OUTLINE_SAVE_REASONS,
} from '../technicalPlan/outline.ts';
import {
  clearTechnicalPlan,
  findTenderFileMarkdown,
  importTenderFiles,
  loadTechnicalPlan,
  readTenderMarkdown,
  removeOriginalPlan,
  removeTenderFile,
  saveBidAnalysisConfig,
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

type ProjectParams = { Params: { projectId: string } };
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
    async (request) => importTenderFiles(db, tenantOf(request), await project(request), request.body.fileIds),
  );

  app.delete<FileParams>('/:projectId/technical-plan/tender-files/:fileId', { schema: { params: FILE_PARAMS } }, async (request) =>
    removeTenderFile(db, tenantOf(request), await project(request), request.params.fileId),
  );

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
    async (request) => setOriginalPlan(db, tenantOf(request), await project(request), request.body.fileId),
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

  app.delete<ProjectParams>('/:projectId/technical-plan', { schema: { params: PROJECT_ID_PARAMS } }, async (request) =>
    clearTechnicalPlan(db, tenantOf(request), await project(request)),
  );
}
