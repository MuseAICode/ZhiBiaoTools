// 知识库文件夹与文档管理接口（路线图第 5 步 5.6）。需要登录，组织取自会话；组织内成员都可以查看和编辑
// （组织内共享，第 9 节第 2 项），可见性与写权限由 RLS 保证。对应桌面版 knowledgeBase.list / createFolder / renameFolder /
// reorderFolder / deleteFolder / uploadDocuments / moveDocument / deleteDocument。
//
// GET    /api/knowledge-base                                  文件夹与文档的完整列表
// POST   /api/knowledge-base/folders                          新建文件夹
// PATCH  /api/knowledge-base/folders/:folderId                重命名
// POST   /api/knowledge-base/folders/:folderId/reorder        拖到另一个文件夹之前或之后
// DELETE /api/knowledge-base/folders/:folderId                删除文件夹，其中文档的原件进回收站
// POST   /api/knowledge-base/folders/:folderId/documents      挂已上传的 knowledge 文件，逐个入队文档准备任务（6.13a）
// GET    /api/knowledge-base/documents/:documentId            单个文档（含最近的处理任务）
// POST   /api/knowledge-base/documents/:documentId/retry      重试失败的文档（202，已成功的步骤续用）
// POST   /api/knowledge-base/documents/:documentId/move       移到某个文件夹中某个文档之前或之后
// DELETE /api/knowledge-base/documents/:documentId            删除文档（软删除原件，7 天内可经 /api/files/:fileId/restore 恢复）
// GET    /api/knowledge-base/search?keyword=&page=             在已处理完成的文档的条目中检索（每页 100 条）
// GET    /api/knowledge-base/documents/:documentId/items       文档的最终条目及其来源块
// GET    /api/knowledge-base/documents/:documentId/analysis    文档的分析快照
// GET    /api/knowledge-base/documents/:documentId/markdown    解析出的 Markdown 原文（附件下载，还没有解析时为空）
//
// 检索与读取对应桌面版 search / readItems / readAnalysis / readMarkdown（5.7）；重试对应 retryDocument（6.13a），匹配随 6.13b。
// 文档带上最近的处理任务（job），处理中而任务已结束或不存在的文档按中断显示（src/knowledgeBase/jobs.ts 的 documentView）；
// 处理进度经 SSE 的 job / job.progress / job.log 事件推送（取代桌面版的 knowledge-base:event），前端按 job.id 对应到文档。
// 删除文档、文件夹之后取消其中文档的处理任务。其他组织的 id 与不存在的一样返回 404。
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import { KNOWLEDGE_FOLDER_NAME_MAX_LENGTH } from '../db/migrations/0012_knowledge_base.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { attachmentDisposition } from '../files/filename.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import type { JobServiceDependencies } from '../jobs/service.ts';
import { jobBody } from '../jobs/view.ts';
import {
  findDocumentMarkdown,
  KNOWLEDGE_SEARCH_KEYWORD_MAX,
  readAnalysis,
  readItems,
  searchKnowledgeBase,
  storageDisabled,
} from '../knowledgeBase/content.ts';
import {
  cancelDocumentJobs,
  documentView,
  getDocumentView,
  latestDocumentJobs,
  retryDocument,
  startNewDocuments,
  type KnowledgeDocumentView,
} from '../knowledgeBase/jobs.ts';
import {
  addDocuments,
  createFolder,
  deleteDocument,
  deleteFolder,
  getDocuments,
  listKnowledgeBase,
  moveDocument,
  renameFolder,
  reorderFolder,
  type DropPosition,
  type KnowledgeDocument,
  type KnowledgeFolder,
} from '../knowledgeBase/store.ts';

export interface KnowledgeBaseRouteDependencies {
  db: Kysely<Database>;
  /** 读取解析出的 Markdown 用；未配置时读取 Markdown 和分析返回 503（文档还没有 Markdown 时除外）。 */
  objectStore: ObjectStore | null;
  /** 文档准备任务的入队、取消（6.13a）。 */
  jobs: JobServiceDependencies;
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const UUID = { type: 'string', pattern: UUID_PATTERN } as const;
/** 一次请求最多挂的文件数。 */
const MAX_FILES_PER_REQUEST = 50;
const POSITION = { type: 'string', enum: ['before', 'after'] } as const;
// 归一化前的长度上限：留出去掉的不可见字符和空白的余量，归一化后另按 200 字检查。
const NAME = { type: 'string', maxLength: KNOWLEDGE_FOLDER_NAME_MAX_LENGTH * 4 } as const;

const NAME_SCHEMA = {
  type: 'object',
  properties: { name: NAME },
  required: ['name'],
  additionalProperties: false,
} as const;

const REORDER_SCHEMA = {
  type: 'object',
  properties: { targetFolderId: UUID, position: POSITION },
  required: ['targetFolderId', 'position'],
  additionalProperties: false,
} as const;

const DOCUMENTS_SCHEMA = {
  type: 'object',
  properties: { fileIds: { type: 'array', minItems: 1, maxItems: MAX_FILES_PER_REQUEST, items: UUID } },
  required: ['fileIds'],
  additionalProperties: false,
} as const;

const MOVE_SCHEMA = {
  type: 'object',
  properties: { targetFolderId: UUID, targetDocumentId: UUID, position: POSITION },
  required: ['targetFolderId'],
  additionalProperties: false,
} as const;

const FOLDER_ID_PARAMS = {
  type: 'object',
  properties: { folderId: UUID },
  required: ['folderId'],
  additionalProperties: false,
} as const;

const DOCUMENT_ID_PARAMS = {
  type: 'object',
  properties: { documentId: UUID },
  required: ['documentId'],
  additionalProperties: false,
} as const;

const SEARCH_QUERY = {
  type: 'object',
  properties: {
    // 归一化前的长度上限：留出首尾空白的余量。
    keyword: { type: 'string', maxLength: KNOWLEDGE_SEARCH_KEYWORD_MAX * 2 },
    page: { type: 'integer', minimum: 1, maximum: 1_000_000, default: 1 },
  },
  required: ['keyword'],
  additionalProperties: false,
} as const;

function folderBody(folder: KnowledgeFolder) {
  return { ...folder, createdAt: folder.createdAt.toISOString(), updatedAt: folder.updatedAt.toISOString() };
}

function documentBody(document: KnowledgeDocument | KnowledgeDocumentView) {
  const job = 'job' in document && document.job ? jobBody(document.job) : null;
  return { ...document, createdAt: document.createdAt.toISOString(), updatedAt: document.updatedAt.toISOString(), job };
}

type FolderParams = { Params: { folderId: string } };
type DocumentParams = { Params: { documentId: string } };

export async function registerKnowledgeBaseRoutes(app: FastifyInstance, deps: KnowledgeBaseRouteDependencies): Promise<void> {
  const { db, jobs } = deps;

  /** 文档附上最近的任务（先读任务再读文档，见 documentView）。 */
  async function withJobs(context: ReturnType<typeof tenantOf>, read: () => Promise<KnowledgeDocument[]>, documentIds?: string[]): Promise<KnowledgeDocumentView[]> {
    const latest = await latestDocumentJobs(db, context, documentIds);
    return (await read()).map((document) => documentView(document, latest.get(document.id) ?? null));
  }

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.get('/', async (request) => {
    const context = tenantOf(request);
    let folders: KnowledgeFolder[] = [];
    const documents = await withJobs(context, async () => {
      const index = await listKnowledgeBase(db, context);
      folders = index.folders;
      return index.documents;
    });
    return { folders: folders.map(folderBody), documents: documents.map(documentBody) };
  });

  app.post<{ Body: { name: string } }>('/folders', { schema: { body: NAME_SCHEMA } }, async (request, reply) =>
    reply.code(201).send(folderBody(await createFolder(db, tenantOf(request), request.body.name))),
  );

  app.patch<FolderParams & { Body: { name: string } }>(
    '/folders/:folderId',
    { schema: { params: FOLDER_ID_PARAMS, body: NAME_SCHEMA } },
    async (request) => folderBody(await renameFolder(db, tenantOf(request), request.params.folderId.toLowerCase(), request.body.name)),
  );

  app.post<FolderParams & { Body: { targetFolderId: string; position: DropPosition } }>(
    '/folders/:folderId/reorder',
    { schema: { params: FOLDER_ID_PARAMS, body: REORDER_SCHEMA } },
    async (request) => {
      const folders = await reorderFolder(
        db,
        tenantOf(request),
        request.params.folderId.toLowerCase(),
        request.body.targetFolderId.toLowerCase(),
        request.body.position,
      );
      return { folders: folders.map(folderBody) };
    },
  );

  app.delete<FolderParams>('/folders/:folderId', { schema: { params: FOLDER_ID_PARAMS } }, async (request) => {
    const context = tenantOf(request);
    const result = await deleteFolder(db, context, request.params.folderId.toLowerCase());
    await cancelDocumentJobs(jobs, context, result.documentIds);
    return { folder: folderBody(result.folder), deletedDocumentCount: result.deletedDocumentCount };
  });

  app.post<FolderParams & { Body: { fileIds: string[] } }>(
    '/folders/:folderId/documents',
    { schema: { params: FOLDER_ID_PARAMS, body: DOCUMENTS_SCHEMA } },
    async (request, reply) => {
      const context = tenantOf(request);
      const created = await addDocuments(db, context, request.params.folderId.toLowerCase(), request.body.fileIds);
      const ids = created.map((document) => document.id);
      await startNewDocuments(jobs, context, ids);
      // 入队之后重新读出（入队失败的文档已标为 error）。
      const documents = await withJobs(context, () => getDocuments(db, context, ids), ids);
      return reply.code(201).send({ documents: documents.map(documentBody) });
    },
  );

  app.post<DocumentParams & { Body: { targetFolderId: string; targetDocumentId?: string; position?: DropPosition } }>(
    '/documents/:documentId/move',
    { schema: { params: DOCUMENT_ID_PARAMS, body: MOVE_SCHEMA } },
    async (request) => {
      const { targetFolderId, targetDocumentId, position } = request.body;
      const context = tenantOf(request);
      const document = await moveDocument(db, context, request.params.documentId.toLowerCase(), targetFolderId.toLowerCase(), {
        ...(targetDocumentId ? { targetDocumentId: targetDocumentId.toLowerCase() } : {}),
        ...(position ? { position } : {}),
      });
      return { document: documentBody(await getDocumentView(db, context, document.id)) };
    },
  );

  app.get<DocumentParams>('/documents/:documentId', { schema: { params: DOCUMENT_ID_PARAMS } }, async (request) => ({
    document: documentBody(await getDocumentView(db, tenantOf(request), request.params.documentId.toLowerCase())),
  }));

  app.post<DocumentParams>('/documents/:documentId/retry', { schema: { params: DOCUMENT_ID_PARAMS } }, async (request, reply) =>
    reply.code(202).send({ document: documentBody(await retryDocument(jobs, tenantOf(request), request.params.documentId.toLowerCase())) }),
  );

  app.delete<DocumentParams>('/documents/:documentId', { schema: { params: DOCUMENT_ID_PARAMS } }, async (request) => {
    const context = tenantOf(request);
    const documentId = request.params.documentId.toLowerCase();
    const latest = await latestDocumentJobs(db, context, [documentId]);
    const document = await deleteDocument(db, context, documentId);
    await cancelDocumentJobs(jobs, context, [documentId]);
    return { document: documentBody(documentView(document, latest.get(documentId) ?? null)) };
  });

  app.get<{ Querystring: { keyword: string; page: number } }>('/search', { schema: { querystring: SEARCH_QUERY } }, async (request) => {
    const keyword = request.query.keyword.trim();
    if ([...keyword].length > KNOWLEDGE_SEARCH_KEYWORD_MAX) {
      throw new AppError(400, 'KNOWLEDGE_INVALID', `检索关键词不超过 ${KNOWLEDGE_SEARCH_KEYWORD_MAX} 个字`);
    }
    return searchKnowledgeBase(db, tenantOf(request), { keyword, page: request.query.page });
  });

  app.get<DocumentParams>('/documents/:documentId/items', { schema: { params: DOCUMENT_ID_PARAMS } }, async (request) => ({
    items: await readItems(db, tenantOf(request), request.params.documentId.toLowerCase()),
  }));

  app.get<DocumentParams>('/documents/:documentId/analysis', { schema: { params: DOCUMENT_ID_PARAMS } }, async (request) => {
    const analysis = await readAnalysis(db, deps.objectStore, tenantOf(request), request.params.documentId.toLowerCase());
    return {
      ...analysis,
      document: documentBody(analysis.document),
      report: analysis.report ? { ...analysis.report, createdAt: analysis.report.createdAt.toISOString() } : null,
    };
  });

  // 与 /api/artifacts/:artifactId/content 相同：一律附件、nosniff、sandbox CSP，Markdown 原文不会在本站内被当作页面渲染。
  app.get<DocumentParams>('/documents/:documentId/markdown', { schema: { params: DOCUMENT_ID_PARAMS } }, async (request, reply) => {
    const { artifact } = await findDocumentMarkdown(db, tenantOf(request), request.params.documentId.toLowerCase());
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
}
