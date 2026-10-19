// 文件上传、下载与删除（docs/SERVER_DESIGN.md 第 6 节）。需要登录，组织取自会话；
// 文件只能在本组织内访问（RLS），其他组织的 fileId 与不存在的一样返回 404。
//
// 上传：POST /api/files?purpose=<用途>&name=<文件名>，请求体是文件的原始字节（Content-Type: application/octet-stream），
// 不用 multipart：没有 multipart 解析器的攻击面，且 octet-stream 不是跨站表单能发送的类型（CSRF 钩子另外要求同源 Origin 和自定义头）。
// 流程：按用途检查扩展名 → 按 Content-Length 和剩余配额预检 → 登记 uploading 行（不计入配额）
// → 流式写入对象存储，同时校验真实类型、大小和 SHA-256 → 完成时由数据库触发器再检查配额。
// 任何一步失败（含客户端中断）都放弃分片上传、删除对象和 uploading 行，不占配额。
//
// 下载：GET /api/files/:fileId/content，由 api 从对象存储流式转发，不签发预签名链接（无法撤销）；
// 一律 Content-Disposition: attachment，Content-Type 用上传时按内容判断的值，另加 nosniff 和 sandbox CSP，
// 浏览器不会在本站源下渲染上传的内容。
//
// 删除：DELETE /api/files/:fileId 软删除，7 天内可经 POST /api/files/:fileId/restore 恢复；过期后不可访问、不计入配额，
// 对象由后续的清理任务物理删除。
import { finished, Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { attachmentDisposition, extensionOf, sanitizeDisplayName } from '../files/filename.ts';
import { InspectionStream } from '../files/inspect.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { FILE_PURPOSES, PURPOSE_POLICIES, type FilePurpose } from '../files/policy.ts';
import {
  abandonUpload,
  beginUpload,
  completeUpload,
  findFile,
  listFiles,
  restoreDeadline,
  restoreFile,
  softDeleteFile,
  storageUsage,
  type FileRecord,
} from '../files/store.ts';

export interface FileRouteDependencies {
  db: Kysely<Database>;
  /** 未配置对象存储（S3_BUCKET）时为 null，接口返回 503。 */
  objectStore: ObjectStore | null;
  /** 本进程同时进行的上传数上限，超出返回 429。默认 8。 */
  maxConcurrentUploads?: number;
  /** 上传过程中多久收不到数据就中断（毫秒）。默认 60 秒。 */
  uploadIdleTimeoutMs?: number;
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const FILE_ID_PARAMS = {
  type: 'object',
  properties: { fileId: { type: 'string', pattern: UUID_PATTERN } },
  required: ['fileId'],
  additionalProperties: false,
} as const;

function fileBody(record: FileRecord) {
  return {
    id: record.id,
    purpose: record.purpose,
    name: record.displayName,
    extension: record.extension,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
    createdAt: record.createdAt.toISOString(),
    uploadedAt: record.uploadedAt.toISOString(),
    deletedAt: record.deletedAt?.toISOString() ?? null,
    restoreUntil: restoreDeadline(record)?.toISOString() ?? null,
  };
}

function notFound(): AppError {
  return new AppError(404, 'FILE_NOT_FOUND', '文件不存在');
}

function fileTooLarge(maxBytes: number): AppError {
  return new AppError(413, 'FILE_TOO_LARGE', `文件超过大小上限（${Math.floor(maxBytes / 1024 / 1024)} MB）`);
}

function quotaExceeded(): AppError {
  return new AppError(413, 'STORAGE_QUOTA_EXCEEDED', '组织存储空间已满，请删除不需要的文件后再上传');
}

function requireStore(store: ObjectStore | null): ObjectStore {
  if (!store) throw new AppError(503, 'FILE_STORAGE_DISABLED', '文件存储暂未开放');
  return store;
}

/** 拒绝上传时请求体可能还没读完：让连接在响应后关闭，不再读取剩下的数据。 */
function closeConnection(reply: FastifyReply): void {
  reply.header('connection', 'close');
}

interface UploadQuery {
  purpose: FilePurpose;
  name: string;
}

interface ListQuery {
  deleted?: boolean;
  purpose?: FilePurpose;
  limit?: number;
}

export async function registerFileRoutes(app: FastifyInstance, deps: FileRouteDependencies): Promise<void> {
  const { db } = deps;
  const maxConcurrentUploads = deps.maxConcurrentUploads ?? 8;
  const idleTimeoutMs = deps.uploadIdleTimeoutMs ?? 60_000;
  let activeUploads = 0;

  // 请求体原样以流交给处理函数，不缓冲；大小由 InspectionStream 限制。只在本插件内生效。
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  app.post<{ Querystring: UploadQuery }>(
    '/',
    {
      config: { uploadBody: true },
      schema: {
        querystring: {
          type: 'object',
          properties: {
            purpose: { type: 'string', enum: [...FILE_PURPOSES] },
            name: { type: 'string', minLength: 1, maxLength: 1024 },
          },
          required: ['purpose', 'name'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      closeConnection(reply);
      const store = requireStore(deps.objectStore);
      const context = tenantOf(request);
      const policy = PURPOSE_POLICIES[request.query.purpose];
      const displayName = sanitizeDisplayName(request.query.name);
      const extension = extensionOf(displayName);
      if (extension === null || !policy.extensions.has(extension)) {
        throw new AppError(415, 'FILE_EXTENSION_NOT_ALLOWED', `该用途只支持以下格式：${[...policy.extensions].join('、')}`);
      }
      const body = request.body;
      if (!(body instanceof Readable)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请以 application/octet-stream 上传文件内容');

      const declared = request.headers['content-length'] === undefined ? null : Number(request.headers['content-length']);
      if (declared !== null && declared > policy.maxBytes) throw fileTooLarge(policy.maxBytes);
      const usage = await storageUsage(db, context);
      const remaining = usage.quota - usage.used;
      if (remaining <= 0 || (declared !== null && declared > remaining)) throw quotaExceeded();
      if (activeUploads >= maxConcurrentUploads) throw new AppError(429, 'TOO_MANY_UPLOADS', '同时上传的文件过多，请稍后再试');

      activeUploads += 1;
      try {
        const pending = await beginUpload(db, context, { purpose: request.query.purpose, displayName, extension });
        const limit = Math.min(policy.maxBytes, remaining);
        const inspector = new InspectionStream({
          extension,
          maxBytes: limit,
          tooLarge: () => (limit < policy.maxBytes ? quotaExceeded() : fileTooLarge(policy.maxBytes)),
        });

        // 客户端断开或长时间不发数据：中止对象存储的分片上传。超时时连接仍在，返回 408；断开时响应已无法送达。
        const controller = new AbortController();
        const idleTimer = setTimeout(() => {
          inspector.destroy(new AppError(408, 'UPLOAD_TIMEOUT', '上传超时，请重新上传'));
          controller.abort();
        }, idleTimeoutMs);
        body.on('data', () => {
          idleTimer.refresh();
        });
        let clientGone = false;
        finished(body, (error) => {
          clearTimeout(idleTimer);
          if (error) {
            clientGone = true;
            inspector.destroy(error);
            controller.abort();
          }
        });
        body.pipe(inspector);

        try {
          await store.put(pending.storageKey, inspector, { contentType: 'application/octet-stream', signal: controller.signal });
          const record = await completeUpload(db, context, pending.id, inspector.result);
          reply.code(201);
          return fileBody(record);
        } catch (error) {
          clearTimeout(idleTimer);
          inspector.destroy();
          // 对象可能已经写完（例如完成时配额检查失败），一并删除；删除失败只记日志，元数据行照样删除。
          await store.delete(pending.storageKey).catch((cleanupError: unknown) => {
            request.log.warn({ err: cleanupError, fileId: pending.id }, 'failed to delete rejected upload object');
          });
          await abandonUpload(db, context, pending.id);
          if (clientGone) throw new AppError(400, 'UPLOAD_ABORTED', '上传已中断', { cause: error });
          // 校验不通过时，inspector 的错误是给用户看的原因；对象存储返回的可能是包装过的错误。
          const reason = inspector.errored ?? error;
          throw reason instanceof AppError ? reason : error;
        }
      } finally {
        activeUploads -= 1;
      }
    },
  );

  app.get<{ Querystring: ListQuery }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            deleted: { type: 'boolean' },
            purpose: { type: 'string', enum: [...FILE_PURPOSES] },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const records = await listFiles(db, tenantOf(request), {
        deleted: request.query.deleted ?? false,
        ...(request.query.purpose ? { purpose: request.query.purpose } : {}),
        limit: request.query.limit ?? 100,
      });
      reply.header('cache-control', 'no-store');
      return { files: records.map(fileBody) };
    },
  );

  app.get('/usage', async (request, reply) => {
    const usage = await storageUsage(db, tenantOf(request));
    reply.header('cache-control', 'no-store');
    return { usedBytes: usage.used, quotaBytes: usage.quota };
  });

  app.get<{ Params: { fileId: string } }>('/:fileId', { schema: { params: FILE_ID_PARAMS } }, async (request, reply) => {
    const record = await findFile(db, tenantOf(request), request.params.fileId.toLowerCase());
    if (!record) throw notFound();
    reply.header('cache-control', 'no-store');
    return fileBody(record);
  });

  app.get<{ Params: { fileId: string } }>('/:fileId/content', { schema: { params: FILE_ID_PARAMS } }, async (request, reply) => {
    const store = requireStore(deps.objectStore);
    const record = await findFile(db, tenantOf(request), request.params.fileId.toLowerCase());
    if (!record) throw notFound();
    const object = await store.get(record.storageKey);
    if (!object) {
      request.log.error({ fileId: record.id }, 'file object is missing from object storage');
      throw notFound();
    }
    reply
      .header('content-type', record.mime)
      .header('content-length', String(record.size))
      .header('content-disposition', attachmentDisposition(record.displayName))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, no-store');
    return reply.send(object.body);
  });

  app.delete<{ Params: { fileId: string } }>('/:fileId', { schema: { params: FILE_ID_PARAMS } }, async (request, reply) => {
    const record = await softDeleteFile(db, tenantOf(request), request.params.fileId.toLowerCase());
    if (!record) throw notFound();
    reply.header('cache-control', 'no-store');
    return fileBody(record);
  });

  app.post<{ Params: { fileId: string } }>('/:fileId/restore', { schema: { params: FILE_ID_PARAMS } }, async (request, reply) => {
    const record = await restoreFile(db, tenantOf(request), request.params.fileId.toLowerCase());
    if (!record) throw new AppError(404, 'FILE_NOT_FOUND', '文件不存在或已超过恢复期');
    reply.header('cache-control', 'no-store');
    return fileBody(record);
  });
}
