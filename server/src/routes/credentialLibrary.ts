// 资信库接口（路线图第 5 步 5.5）。需要登录，组织取自会话；组织内成员都可以查看和编辑（组织内共享，第 9 节第 2 项），
// 可见性与写权限由 RLS 保证。对应桌面版 credentialLibrary.load / saveProfile / addProfileImages / deleteImage
// 以及证书、人员、业绩、其他资料的保存与删除；importTestData（开发者功能）不迁移。
//
// GET    /api/credential-library                      完整快照
// PATCH  /api/credential-library/profile              按 patch 保存企业信息
// POST   /api/credential-library/profile/images       给企业信息的一个栏目挂已上传的 credential-image 文件
// DELETE /api/credential-library/images/:imageId      删除图片（软删除其文件，7 天内可经 /api/files/:fileId/restore 恢复）
// POST   /api/credential-library/:type                新建记录（:type 为 certificates / employees / projects / other-materials）
// PUT    /api/credential-library/:type/:recordId      整份保存记录，并提交其图片的新增、删除、改名
// DELETE /api/credential-library/:type/:recordId      删除记录及其图片
//
// 图片内容经 GET /api/files/:fileId/content 读取。其他组织的 id 与不存在的一样返回 404。
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import { PROFILE_TEXT_FIELDS, RECORD_TEXT_FIELDS, type CredentialRecordType } from '../credentialLibrary/fields.ts';
import {
  addProfileImages,
  createRecord,
  deleteImage,
  deleteRecord,
  loadLibrary,
  saveProfile,
  updateRecord,
  type CredentialLibrarySnapshot,
  type NewCredentialImage,
  type SaveRecordInput,
} from '../credentialLibrary/store.ts';
import {
  CREDENTIAL_IMAGE_FIELDS,
  CREDENTIAL_IMAGE_NAME_MAX,
  CREDENTIAL_PROJECT_TYPES,
  CREDENTIAL_VALIDITY_MODES,
} from '../db/migrations/0011_credential_library.ts';
import type { Database } from '../db/schema.ts';

export interface CredentialLibraryRouteDependencies {
  db: Kysely<Database>;
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const UUID = { type: 'string', pattern: UUID_PATTERN } as const;
/** 一次请求最多新增的图片数、最多删除或改名的图片数。 */
const MAX_NEW_IMAGES = 50;
const MAX_IMAGE_CHANGES = 200;

/** 路径中的记录类型（与桌面版 bridge 方法名对应的复数形式）。 */
const RECORD_PATHS: Readonly<Record<string, CredentialRecordType>> = Object.freeze({
  certificates: 'certificate',
  employees: 'employee',
  projects: 'project',
  'other-materials': 'other',
});

// 枚举字段：与桌面版 Renderer 的类型相同，数据库另有 CHECK 约束。
const ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  validityMode: CREDENTIAL_VALIDITY_MODES,
  idValidityMode: CREDENTIAL_VALIDITY_MODES,
  projectType: CREDENTIAL_PROJECT_TYPES,
});

function textProperties(fields: Readonly<Record<string, { maxLength: number }>>) {
  return Object.fromEntries(
    Object.entries(fields).map(([field, { maxLength }]) => [
      field,
      ENUM_FIELDS[field] ? { type: 'string', enum: [...ENUM_FIELDS[field]] } : { type: 'string', maxLength },
    ]),
  );
}

const CUSTOM_NAME = { type: 'string', maxLength: CREDENTIAL_IMAGE_NAME_MAX } as const;

const PROFILE_SCHEMA = {
  type: 'object',
  properties: { ...textProperties(PROFILE_TEXT_FIELDS), watermarkEnabled: { type: 'boolean' } },
  additionalProperties: false,
} as const;

const PROFILE_IMAGES_SCHEMA = {
  type: 'object',
  properties: {
    fieldKey: { type: 'string', enum: [...CREDENTIAL_IMAGE_FIELDS.profile] },
    images: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_NEW_IMAGES,
      items: {
        type: 'object',
        properties: { fileId: UUID, customName: CUSTOM_NAME },
        required: ['fileId'],
        additionalProperties: false,
      },
    },
  },
  required: ['fieldKey', 'images'],
  additionalProperties: false,
} as const;

function recordSchema(type: CredentialRecordType, update: boolean) {
  const newImages = {
    type: 'array',
    maxItems: MAX_NEW_IMAGES,
    items: {
      type: 'object',
      properties: { fieldKey: { type: 'string', enum: [...CREDENTIAL_IMAGE_FIELDS[type]] }, fileId: UUID, customName: CUSTOM_NAME },
      required: ['fieldKey', 'fileId'],
      additionalProperties: false,
    },
  };
  return {
    type: 'object',
    properties: {
      record: { type: 'object', properties: textProperties(RECORD_TEXT_FIELDS[type]), additionalProperties: false },
      newImages,
      ...(update
        ? {
            removedImageIds: { type: 'array', maxItems: MAX_IMAGE_CHANGES, items: UUID },
            imageNameUpdates: {
              type: 'array',
              maxItems: MAX_IMAGE_CHANGES,
              items: {
                type: 'object',
                properties: { imageId: UUID, customName: CUSTOM_NAME },
                required: ['imageId', 'customName'],
                additionalProperties: false,
              },
            },
          }
        : {}),
    },
    required: ['record'],
    additionalProperties: false,
  };
}

const IMAGE_ID_PARAMS = {
  type: 'object',
  properties: { imageId: UUID },
  required: ['imageId'],
  additionalProperties: false,
} as const;

const RECORD_ID_PARAMS = {
  type: 'object',
  properties: { recordId: UUID },
  required: ['recordId'],
  additionalProperties: false,
} as const;

function iso(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function snapshotBody(snapshot: CredentialLibrarySnapshot) {
  const record = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, iso(value)]));
  return {
    profile: record(snapshot.profile),
    certificates: snapshot.certificates.map(record),
    employees: snapshot.employees.map(record),
    projects: snapshot.projects.map(record),
    otherMaterials: snapshot.otherMaterials.map(record),
    images: snapshot.images.map((image) => ({ ...image, createdAt: image.createdAt.toISOString() })),
  };
}

type RecordBody = { Body: SaveRecordInput };
type RecordParams = { Params: { recordId: string } };

export async function registerCredentialLibraryRoutes(app: FastifyInstance, deps: CredentialLibraryRouteDependencies): Promise<void> {
  const { db } = deps;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.get('/', async (request) => snapshotBody(await loadLibrary(db, tenantOf(request))));

  app.patch<{ Body: Record<string, string | boolean> }>('/profile', { schema: { body: PROFILE_SCHEMA } }, async (request) =>
    snapshotBody(await saveProfile(db, tenantOf(request), request.body)),
  );

  app.post<{ Body: { fieldKey: string; images: NewCredentialImage[] } }>(
    '/profile/images',
    { schema: { body: PROFILE_IMAGES_SCHEMA } },
    async (request) => snapshotBody(await addProfileImages(db, tenantOf(request), request.body.fieldKey, request.body.images)),
  );

  app.delete<{ Params: { imageId: string } }>('/images/:imageId', { schema: { params: IMAGE_ID_PARAMS } }, async (request) =>
    snapshotBody(await deleteImage(db, tenantOf(request), request.params.imageId.toLowerCase())),
  );

  for (const [path, type] of Object.entries(RECORD_PATHS)) {
    app.post<RecordBody>(`/${path}`, { schema: { body: recordSchema(type, false) } }, async (request, reply) => {
      const result = await createRecord(db, tenantOf(request), type, request.body);
      return reply.code(201).send({ id: result.id, snapshot: snapshotBody(result.snapshot) });
    });

    app.put<RecordParams & RecordBody>(
      `/${path}/:recordId`,
      { schema: { params: RECORD_ID_PARAMS, body: recordSchema(type, true) } },
      async (request) => {
        const body = request.body;
        const result = await updateRecord(db, tenantOf(request), type, request.params.recordId.toLowerCase(), {
          ...body,
          ...(body.removedImageIds ? { removedImageIds: body.removedImageIds.map((id) => id.toLowerCase()) } : {}),
          ...(body.imageNameUpdates
            ? { imageNameUpdates: body.imageNameUpdates.map((update) => ({ ...update, imageId: update.imageId.toLowerCase() })) }
            : {}),
        });
        return { id: result.id, snapshot: snapshotBody(result.snapshot) };
      },
    );

    app.delete<RecordParams>(`/${path}/:recordId`, { schema: { params: RECORD_ID_PARAMS } }, async (request) =>
      snapshotBody(await deleteRecord(db, tenantOf(request), type, request.params.recordId.toLowerCase())),
    );
  }
}
