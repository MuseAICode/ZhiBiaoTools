// 生成产物的只读接口（路线图第 5 步 5.2）。需要登录，组织取自会话；产物只能在本组织内访问（RLS），
// 其他组织的、项目或来源文件已删除的产物与不存在的一样返回 404。写入方是第 6 步的解析任务，没有写接口。
//
// GET /api/artifacts?projectId=… 或 ?sourceFileId=…（二选一，可加 kind、limit）、GET /api/artifacts/:artifactId、
// GET /api/artifacts/:artifactId/content。下载与文件相同：由 api 从对象存储流式转发，一律附件，
// Content-Type 用登记的值（只有 Markdown 和位图），另加 nosniff 和 sandbox CSP。
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { ARTIFACT_KINDS, findArtifact, listArtifacts, type ArtifactKind, type ArtifactRecord } from '../artifacts/store.ts';
import { tenantOf } from '../auth/hooks.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { attachmentDisposition } from '../files/filename.ts';
import type { ObjectStore } from '../files/objectStore.ts';

export interface ArtifactRouteDependencies {
  db: Kysely<Database>;
  /** 未配置对象存储（S3_BUCKET）时为 null，下载接口返回 503。 */
  objectStore: ObjectStore | null;
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const ARTIFACT_ID_PARAMS = {
  type: 'object',
  properties: { artifactId: { type: 'string', pattern: UUID_PATTERN } },
  required: ['artifactId'],
  additionalProperties: false,
} as const;

function artifactBody(record: ArtifactRecord) {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    mime: record.mime,
    projectId: record.projectId,
    sourceFileId: record.sourceFileId,
    size: record.size,
    sha256: record.sha256,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt.toISOString(),
  };
}

function notFound(): AppError {
  return new AppError(404, 'ARTIFACT_NOT_FOUND', '内容不存在');
}

interface ListQuery {
  projectId?: string;
  sourceFileId?: string;
  kind?: ArtifactKind;
  limit?: number;
}

type ArtifactParams = { Params: { artifactId: string } };

export async function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRouteDependencies): Promise<void> {
  const { db } = deps;

  app.get<{ Querystring: ListQuery }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            projectId: { type: 'string', pattern: UUID_PATTERN },
            sourceFileId: { type: 'string', pattern: UUID_PATTERN },
            kind: { type: 'string', enum: [...ARTIFACT_KINDS] },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { projectId, sourceFileId, kind } = request.query;
      if ((projectId === undefined) === (sourceFileId === undefined)) {
        throw new AppError(400, 'ARTIFACT_QUERY_INVALID', 'projectId 和 sourceFileId 必须且只能提供一个');
      }
      const owner = projectId !== undefined ? { projectId: projectId.toLowerCase() } : { sourceFileId: sourceFileId!.toLowerCase() };
      const records = await listArtifacts(db, tenantOf(request), {
        ...owner,
        ...(kind ? { kind } : {}),
        limit: request.query.limit ?? 200,
      });
      reply.header('cache-control', 'no-store');
      return { artifacts: records.map(artifactBody) };
    },
  );

  app.get<ArtifactParams>('/:artifactId', { schema: { params: ARTIFACT_ID_PARAMS } }, async (request, reply) => {
    const record = await findArtifact(db, tenantOf(request), request.params.artifactId.toLowerCase());
    if (!record) throw notFound();
    reply.header('cache-control', 'no-store');
    return artifactBody(record);
  });

  app.get<ArtifactParams>('/:artifactId/content', { schema: { params: ARTIFACT_ID_PARAMS } }, async (request, reply) => {
    if (!deps.objectStore) throw new AppError(503, 'FILE_STORAGE_DISABLED', '文件存储暂未开放');
    const record = await findArtifact(db, tenantOf(request), request.params.artifactId.toLowerCase());
    if (!record) throw notFound();
    const object = await deps.objectStore.get(record.storageKey);
    if (!object) {
      request.log.error({ artifactId: record.id }, 'artifact object is missing from object storage');
      throw notFound();
    }
    reply
      .header('content-type', record.mime)
      .header('content-length', String(record.size))
      .header('content-disposition', attachmentDisposition(record.name))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, no-store');
    return reply.send(object.body);
  });
}
