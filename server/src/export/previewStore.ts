// 模板样张的存储（路线图第 7 步 7.3c，迁移 0027_template_preview）：样张请求的读写、样张产物的写入与按输入哈希复用。
// 样张任务（7.3d）与接口（7.3e）调用，本模块不接任务和接口。组织和用户一律来自 TenantContext，所有查询都经 withTenant：
// - 样张请求只有创建者本人可见（RLS），任务以发起用户的身份读取；内容是 preparePreviewRequest 的结果（重新序列化的 HTML、
//   规范化后的配置与二者的哈希），读回后由任务重新准备一次，哈希必须一致；
// - 样张产物在本组织内可见（与模板相同是组织内共享的配置），按输入哈希复用 23 小时内最近的结果，创建 24 小时后由清理任务删除；
// - 样张产物计入组织存储配额（迁移 0008 的配额函数），超出时 writeTemplatePreviewArtifact 抛 413 STORAGE_QUOTA_EXCEEDED。
import { sql, type Kysely, type Selectable } from 'kysely';
import { findArtifact, writeArtifact, type ArtifactRecord } from '../artifacts/store.ts';
import {
  DOCX_MIME,
  TEMPLATE_PREVIEW_EXPORT_FORMAT_MAX_BYTES,
  TEMPLATE_PREVIEW_HTML_MAX_BYTES,
  TEMPLATE_PREVIEW_KIND,
  TEMPLATE_PREVIEW_REUSE_HOURS,
} from '../db/migrations/0027_template_preview.ts';
import type { Database, TemplatePreviewRequestsTable } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { serializeJsonObject } from '../jsonObject.ts';
import type { PreparedPreviewRequest } from './preview.ts';

/** 样张产物的文件名（下载时使用）。 */
export const TEMPLATE_PREVIEW_ARTIFACT_NAME = 'template-preview.docx';

export interface TemplatePreviewRequestRecord {
  id: string;
  createdBy: string;
  /** 样张输入的 SHA-256（十六进制）。 */
  inputSha256: string;
  html: string;
  exportFormat: Record<string, unknown>;
  /** 结果产物；未完成时为 null。产物可能已过期删除，读取经 findArtifact。 */
  artifactId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

const REUSE_WINDOW = sql.raw(`interval '${TEMPLATE_PREVIEW_REUSE_HOURS} hours'`);

function toRecord(row: Selectable<TemplatePreviewRequestsTable>): TemplatePreviewRequestRecord {
  return {
    id: row.id,
    createdBy: row.created_by,
    inputSha256: row.input_sha256.toString('hex'),
    html: row.html,
    exportFormat: row.export_format,
    artifactId: row.artifact_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function tooLarge(): AppError {
  return new AppError(413, 'PREVIEW_TOO_LARGE', '样张内容过大');
}

/** 保存一个样张请求（内容为 preparePreviewRequest 的结果）。超过存储上限时抛 413 PREVIEW_TOO_LARGE。 */
export async function saveTemplatePreviewRequest(
  db: Kysely<Database>,
  context: TenantContext,
  prepared: PreparedPreviewRequest,
): Promise<TemplatePreviewRequestRecord> {
  if (Buffer.byteLength(prepared.html, 'utf8') > TEMPLATE_PREVIEW_HTML_MAX_BYTES) throw tooLarge();
  const exportFormat = serializeJsonObject(prepared.exportFormat as Record<string, unknown>, TEMPLATE_PREVIEW_EXPORT_FORMAT_MAX_BYTES);
  if (exportFormat === 'too-deep' || exportFormat === 'too-large') throw tooLarge();
  const row = await withTenant(db, context, (trx) =>
    trx
      .insertInto('template_preview_requests')
      .values({
        org_id: context.orgId,
        created_by: context.userId,
        input_sha256: prepared.sha256,
        html: prepared.html,
        export_format: exportFormat,
      })
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
  return toRecord(row);
}

/** 本人创建的样张请求；其他用户、其他组织的、已被清理的都返回 null。 */
export async function findTemplatePreviewRequest(
  db: Kysely<Database>,
  context: TenantContext,
  requestId: string,
): Promise<TemplatePreviewRequestRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx.selectFrom('template_preview_requests').selectAll().where('id', '=', requestId).executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

/** 写入样张请求的结果产物（只能写一次）。请求不存在或已有结果时返回 null。 */
export async function completeTemplatePreviewRequest(
  db: Kysely<Database>,
  context: TenantContext,
  requestId: string,
  artifactId: string,
): Promise<TemplatePreviewRequestRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx
      .updateTable('template_preview_requests')
      .set({ artifact_id: artifactId })
      .where('id', '=', requestId)
      .where('artifact_id', 'is', null)
      .returningAll()
      .executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

/** 本组织内同一输入哈希、23 小时内最近完成的样张产物；没有时返回 null。 */
export async function findReusableTemplatePreview(
  db: Kysely<Database>,
  context: TenantContext,
  inputSha256: Buffer,
): Promise<ArtifactRecord | null> {
  if (inputSha256.length !== 32) throw new TypeError('样张输入哈希必须是 32 字节');
  const row = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('artifacts')
      .select('id')
      .where('kind', '=', TEMPLATE_PREVIEW_KIND)
      .where('preview_sha256', '=', inputSha256)
      .where('status', '=', 'ready')
      .where('created_at', '>', sql<Date>`now() - ${REUSE_WINDOW}`)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst(),
  );
  return row ? findArtifact(db, context, row.id) : null;
}

/** 把生成的样张 docx 存为产物（登记 → 写对象 → 完成并检查配额）。 */
export async function writeTemplatePreviewArtifact(
  db: Kysely<Database>,
  context: TenantContext,
  store: ObjectStore,
  inputSha256: Buffer,
  docx: Buffer,
): Promise<ArtifactRecord> {
  return writeArtifact(
    db,
    context,
    store,
    { kind: TEMPLATE_PREVIEW_KIND, name: TEMPLATE_PREVIEW_ARTIFACT_NAME, mime: DOCX_MIME, previewSha256: inputSha256 },
    docx,
  );
}
