// artifacts 表的读写（迁移 0008_artifacts）。组织和用户一律来自 TenantContext，所有查询都经 withTenant，
// 由 RLS 保证只能看到、修改本组织的产物；跨组织的 artifactId 与不存在的一样返回 null。
//
// 写入方是第 6 步的解析任务：writeArtifact 一次完成“登记 → 写对象 → 完成（检查配额）”，失败时删除对象和登记行。
// 重新解析时旧产物经 supersedeArtifacts 标为已被替换（迁移 0023），读取时不再返回，由清理任务（6.8）删除。
// 项目或来源文件已删除时产物不可访问，由 RLS 保证（迁移 0008_artifacts），这里不再重复判断。
// 模板样张（template-preview，迁移 0027）不属于项目或来源文件，带样张输入的哈希，创建 24 小时后由清理任务删除。
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Kysely, Selectable } from 'kysely';
import { ARTIFACT_NAME_PATTERN, MAX_ARTIFACT_BYTES } from '../db/migrations/0008_artifacts.ts';
import { ARTIFACT_KINDS, ARTIFACT_MIMES, TEMPLATE_PREVIEW_KIND } from '../db/migrations/0027_template_preview.ts';
import type { ArtifactsTable, Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import type { ObjectStore } from '../files/objectStore.ts';

export { ARTIFACT_KINDS, ARTIFACT_MIMES, MAX_ARTIFACT_BYTES };
export type ArtifactKind = keyof typeof ARTIFACT_MIMES;

export interface ArtifactRecord {
  id: string;
  storageKey: string;
  kind: ArtifactKind;
  name: string;
  mime: string;
  /** 所属项目；不属于项目时为 null。 */
  projectId: string | null;
  /** 由哪个上传文件生成；没有时为 null。 */
  sourceFileId: string | null;
  size: number;
  sha256: string;
  createdBy: string;
  createdAt: Date;
  completedAt: Date;
}

export interface NewArtifact {
  kind: ArtifactKind;
  /** 服务端生成的文件名（例如 content.md、image-001.png），只用作下载时的文件名。 */
  name: string;
  mime: string;
  projectId?: string | null;
  sourceFileId?: string | null;
  /** 样张输入的 SHA-256（32 字节）：template-preview 必填（且不能有项目和来源文件），其他种类不能有。 */
  previewSha256?: Buffer | null;
}

export interface PendingArtifact {
  id: string;
  storageKey: string;
}

const NAME_PATTERN = new RegExp(ARTIFACT_NAME_PATTERN);

function toRecord(row: Selectable<ArtifactsTable>): ArtifactRecord {
  return {
    id: row.id,
    storageKey: row.storage_key,
    kind: row.kind,
    name: row.name,
    mime: row.mime,
    projectId: row.project_id,
    sourceFileId: row.source_file_id,
    size: Number(row.size_bytes),
    sha256: row.sha256!.toString('hex'),
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at!,
  };
}

/** 调用方（解析任务）传错参数是程序错误，抛 TypeError；数据库的 CHECK 约束另外兜底。 */
function assertNewArtifact(input: NewArtifact): void {
  if (!(ARTIFACT_KINDS as readonly string[]).includes(input.kind)) throw new TypeError('产物种类不合法');
  if (!(ARTIFACT_MIMES[input.kind] as readonly string[]).includes(input.mime)) throw new TypeError('产物 MIME 与种类不符');
  if (!NAME_PATTERN.test(input.name)) throw new TypeError('产物名称只能由字母、数字和 ._- 组成');
  if (input.kind === TEMPLATE_PREVIEW_KIND) {
    if (input.projectId || input.sourceFileId) throw new TypeError('样张产物不属于项目或来源文件');
    if (!input.previewSha256 || input.previewSha256.length !== 32) throw new TypeError('样张产物必须有 32 字节的输入哈希');
    return;
  }
  if (input.previewSha256) throw new TypeError('只有样张产物有输入哈希');
  if (!input.projectId && !input.sourceFileId) throw new TypeError('产物必须属于一个项目或一个来源文件');
}

function mapArtifactError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'AR001') {
    return new AppError(413, 'STORAGE_QUOTA_EXCEEDED', '组织存储空间已满，请删除不需要的文件后再试', { cause: error });
  }
  return error;
}

/** 登记一个产物（status = writing，不计入配额），对象键由数据库生成。 */
export async function beginArtifact(db: Kysely<Database>, context: TenantContext, input: NewArtifact): Promise<PendingArtifact> {
  assertNewArtifact(input);
  return withTenant(db, context, async (trx) => {
    const row = await trx
      .insertInto('artifacts')
      .values({
        org_id: context.orgId,
        project_id: input.projectId ?? null,
        source_file_id: input.sourceFileId ?? null,
        preview_sha256: input.previewSha256 ?? null,
        kind: input.kind,
        name: input.name,
        mime: input.mime,
        created_by: context.userId,
      })
      .returning(['id', 'storage_key'])
      .executeTakeFirstOrThrow();
    return { id: row.id, storageKey: row.storage_key };
  });
}

/** 写完对象后标记完成：触发器在此检查配额（超出抛 413 STORAGE_QUOTA_EXCEEDED）。 */
export async function completeArtifact(
  db: Kysely<Database>,
  context: TenantContext,
  artifactId: string,
  content: { size: number; sha256: Buffer },
): Promise<ArtifactRecord> {
  try {
    return await withTenant(db, context, async (trx) => {
      const row = await trx
        .updateTable('artifacts')
        .set({ status: 'ready', size_bytes: content.size, sha256: content.sha256 })
        .where('id', '=', artifactId)
        .where('status', '=', 'writing')
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new Error('artifact is not pending');
      return toRecord(row);
    });
  } catch (error) {
    throw mapArtifactError(error);
  }
}

/** 放弃写入：删除 writing 的行（已完成的行 RLS 不允许物理删除）。 */
export async function abandonArtifact(db: Kysely<Database>, context: TenantContext, artifactId: string): Promise<void> {
  await withTenant(db, context, (trx) =>
    trx.deleteFrom('artifacts').where('id', '=', artifactId).where('status', '=', 'writing').execute(),
  );
}

/**
 * 写入一个产物：登记 → 写对象 → 完成。任何一步失败都删除对象和登记行，不占配额，再把错误抛给调用方。
 * 产物是解析结果（Markdown、图片）或样张 docx，在内存中生成，所以只接受 Buffer。
 */
export async function writeArtifact(
  db: Kysely<Database>,
  context: TenantContext,
  store: ObjectStore,
  input: NewArtifact,
  content: Buffer,
): Promise<ArtifactRecord> {
  if (content.length > Number(MAX_ARTIFACT_BYTES)) throw new TypeError('产物超过大小上限');
  const pending = await beginArtifact(db, context, input);
  try {
    await store.put(pending.storageKey, Readable.from(content), { contentType: 'application/octet-stream' });
    return await completeArtifact(db, context, pending.id, {
      size: content.length,
      sha256: createHash('sha256').update(content).digest(),
    });
  } catch (error) {
    // 删除失败时对象成为孤儿，由清理任务按对象键前缀处理；登记行照样删除，不占配额。
    await store.delete(pending.storageKey).catch(() => {});
    await abandonArtifact(db, context, pending.id);
    throw error;
  }
}

/**
 * 把来源文件之前的产物标为已被替换（重新解析后调用）：除 keepIds 之外、该来源文件下全部已完成且未被替换的产物。
 * 返回标记的数量。
 */
export async function supersedeArtifacts(
  db: Kysely<Database>,
  context: TenantContext,
  sourceFileId: string,
  keepIds: readonly string[],
): Promise<number> {
  return withTenant(db, context, async (trx) => {
    let query = trx
      .updateTable('artifacts')
      .set({ superseded_at: new Date() })
      .where('source_file_id', '=', sourceFileId)
      .where('status', '=', 'ready')
      .where('superseded_at', 'is', null);
    if (keepIds.length > 0) query = query.where('id', 'not in', [...keepIds]);
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows);
  });
}

/** 已完成、可访问的产物；其他组织的、写入中的、已被替换的、项目或来源文件已删除的都返回 null。 */
export async function findArtifact(db: Kysely<Database>, context: TenantContext, artifactId: string): Promise<ArtifactRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('artifacts')
      .selectAll()
      .where('id', '=', artifactId)
      .where('status', '=', 'ready')
      .where('superseded_at', 'is', null)
      .executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

export type ListArtifactsOptions = ({ projectId: string; sourceFileId?: undefined } | { sourceFileId: string; projectId?: undefined }) & {
  kind?: ArtifactKind;
  limit: number;
};

/** 某个项目或某个来源文件下可访问、未被替换的产物，按生成时间排列。 */
export async function listArtifacts(db: Kysely<Database>, context: TenantContext, options: ListArtifactsOptions): Promise<ArtifactRecord[]> {
  const rows = await withTenant(db, context, (trx) => {
    let query = trx
      .selectFrom('artifacts')
      .selectAll()
      .where('status', '=', 'ready')
      .where('superseded_at', 'is', null);
    query = options.projectId !== undefined
      ? query.where('project_id', '=', options.projectId)
      : query.where('source_file_id', '=', options.sourceFileId!);
    if (options.kind) query = query.where('kind', '=', options.kind);
    return query.orderBy('created_at').orderBy('id').limit(options.limit).execute();
  });
  return rows.map(toRecord);
}
