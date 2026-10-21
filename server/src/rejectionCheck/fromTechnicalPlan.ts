// 废标检查从技术方案读取招标文件（取代桌面版 rejectionCheckStore.importTenderFromTechnicalPlan；路线图第 5 步 5.13）。
//
// 桌面版只有一个技术方案和一个废标检查，直接复制技术方案中各招标文件的 Markdown。Web 版每个项目各自管理文件，文件的
// project_id 设置后不能再改（迁移 0015），废标检查的文档又必须引用挂在本项目下的原件（迁移 0016 的策略），所以这里为每份
// 已解析的招标文件复制一份原件和一份 Markdown 产物到废标检查项目，再由 replaceTenderDocuments 整体替换招标文件。副本与
// 原件一样计入组织配额（超出时 413），之后两个项目各自删除、恢复，互不影响。
//
// - 来源项目必须是本组织未删除的技术方案项目（RLS 与 requireProject），否则 404 REJECTION_CHECK_TECHNICAL_PLAN_NOT_FOUND；
// - 只复制已解析出 Markdown、正文不为空的招标文件（与桌面版相同跳过空正文），一份都没有时 409；
// - 技术方案的“无效投标与废标项”解析成功时一并写入解析结果（来源 technical-plan）；
// - 复制先于数据库替换进行（对象存储的读写不放在事务中）；任何一步失败时删除已写的对象、放弃登记，已完成的副本原件软删除
//   （应用角色不能物理删除已上传的文件），原有的招标文件不受影响。
import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import type { Kysely } from 'kysely';
import { abandonArtifact, beginArtifact, completeArtifact } from '../artifacts/store.ts';
import type { Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { abandonUpload, beginUpload, completeUpload, softDeleteFile } from '../files/store.ts';
import { storageDisabled } from '../knowledgeBase/content.ts';
import { findProject } from '../projects/store.ts';
import { replaceTenderDocuments, type CopiedTenderDocument, type RejectionCheckState } from './store.ts';

interface SourceDocument {
  displayName: string;
  extension: string;
  file: { storageKey: string; mime: string; size: number; sha256: Buffer };
  markdown: { storageKey: string; name: string; mime: string; size: number; sha256: Buffer };
  contentChars: number;
  contentHash: string | null;
  parserLabel: string | null;
}

interface Source {
  documents: SourceDocument[];
  /** 技术方案中解析成功的“无效投标与废标项”，没有时为 null。 */
  discardedBids: string | null;
}

/** 来源项目中已解析出 Markdown 的招标文件（按导入顺序）与无效投标与废标项的解析结果；RLS 下只看得到可访问的文件与产物。 */
async function readSource(db: Kysely<Database>, context: TenantContext, technicalPlanProjectId: string): Promise<Source> {
  return withTenant(db, context, async (trx) => {
    const rows = await trx
      .selectFrom('technical_plan_documents as d')
      .innerJoin('files as f', 'f.id', 'd.file_id')
      .innerJoin('artifacts as a', 'a.id', 'd.markdown_artifact_id')
      .select([
        'f.display_name',
        'f.extension',
        'f.storage_key as file_key',
        'f.mime as file_mime',
        'f.size_bytes as file_size',
        'f.sha256 as file_sha256',
        'a.storage_key as markdown_key',
        'a.name as markdown_name',
        'a.mime as markdown_mime',
        'a.size_bytes as markdown_size',
        'a.sha256 as markdown_sha256',
        'd.content_chars',
        'd.content_hash',
        'd.parser_label',
      ])
      .where('d.project_id', '=', technicalPlanProjectId)
      .where('d.role', '=', 'tender')
      .where('d.content_chars', '>', 0)
      .where('a.status', '=', 'ready')
      .orderBy('d.sort_order')
      .orderBy('d.created_at')
      .orderBy('d.file_id')
      .execute();
    const item = await trx
      .selectFrom('technical_plan_bid_items')
      .select(['status', 'content'])
      .where('project_id', '=', technicalPlanProjectId)
      .where('item_id', '=', 'discardedBids')
      .executeTakeFirst();
    return {
      documents: rows.map((row) => ({
        displayName: row.display_name,
        extension: row.extension,
        file: { storageKey: row.file_key, mime: row.file_mime!, size: Number(row.file_size), sha256: row.file_sha256! },
        markdown: { storageKey: row.markdown_key, name: row.markdown_name, mime: row.markdown_mime, size: Number(row.markdown_size), sha256: row.markdown_sha256! },
        contentChars: row.content_chars,
        contentHash: row.content_hash,
        parserLabel: row.parser_label,
      })),
      discardedBids: item?.status === 'success' && item.content.trim() ? item.content : null,
    };
  });
}

/** 边复制边计算大小和 SHA-256。 */
class Digest extends Transform {
  readonly hash = createHash('sha256');
  size = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.size += chunk.length;
    callback(null, chunk);
  }
}

/** 流式复制一个对象，并核对大小与 SHA-256 与来源登记的一致（不一致说明来源对象已损坏，不写出副本）。 */
async function copyObject(store: ObjectStore, from: { storageKey: string; size: number; sha256: Buffer }, toKey: string, contentType: string): Promise<void> {
  const object = await store.get(from.storageKey);
  if (!object) throw new Error('source object is missing from object storage');
  const digest = new Digest();
  object.body.once('error', (error) => digest.destroy(error));
  await store.put(toKey, object.body.pipe(digest), { contentType });
  if (digest.size !== from.size || !digest.hash.digest().equals(from.sha256)) {
    await store.delete(toKey).catch(() => {});
    throw new Error('copied object does not match the source');
  }
}

export interface ImportFromTechnicalPlanResult {
  importedCount: number;
  state: RejectionCheckState;
}

/**
 * 从技术方案项目读取招标文件（取代桌面版 importTenderFromTechnicalPlan）：复制原件与 Markdown 后整体替换本项目的招标文件，
 * 见文件头。projectId 已由路由经 requireProject 校验（kind = rejection-check）。
 */
export async function importTenderFromTechnicalPlan(
  db: Kysely<Database>,
  context: TenantContext,
  objectStore: ObjectStore | null,
  projectId: string,
  technicalPlanProjectId: string,
): Promise<ImportFromTechnicalPlanResult> {
  const sourceProject = await findProject(db, context, technicalPlanProjectId.toLowerCase());
  if (!sourceProject || sourceProject.orgId !== context.orgId || sourceProject.kind !== 'technical-plan') {
    throw new AppError(404, 'REJECTION_CHECK_TECHNICAL_PLAN_NOT_FOUND', '技术方案项目不存在或已删除');
  }
  const source = await readSource(db, context, sourceProject.id);
  if (source.documents.length === 0) {
    throw new AppError(409, 'REJECTION_CHECK_TECHNICAL_PLAN_EMPTY', '技术方案中暂无可读取的招标文件正文');
  }
  if (!objectStore) throw storageDisabled();

  const pendingFiles: { id: string; storageKey: string }[] = [];
  const completedFiles: string[] = [];
  const pendingArtifacts: { id: string; storageKey: string }[] = [];
  try {
    const copies: CopiedTenderDocument[] = [];
    for (const document of source.documents) {
      const file = await beginUpload(db, context, { purpose: 'tender', displayName: document.displayName, extension: document.extension });
      pendingFiles.push(file);
      await copyObject(objectStore, document.file, file.storageKey, 'application/octet-stream');
      await completeUpload(db, context, file.id, { mime: document.file.mime, size: document.file.size, sha256: document.file.sha256 });
      pendingFiles.pop();
      completedFiles.push(file.id);

      const artifact = await beginArtifact(db, context, {
        kind: 'markdown',
        name: document.markdown.name,
        mime: document.markdown.mime,
        projectId,
        sourceFileId: file.id,
      });
      pendingArtifacts.push(artifact);
      await copyObject(objectStore, document.markdown, artifact.storageKey, 'application/octet-stream');
      await completeArtifact(db, context, artifact.id, { size: document.markdown.size, sha256: document.markdown.sha256 });
      pendingArtifacts.pop();

      copies.push({
        fileId: file.id,
        markdownArtifactId: artifact.id,
        contentChars: document.contentChars,
        contentHash: document.contentHash,
        parserLabel: document.parserLabel,
      });
    }
    const state = await replaceTenderDocuments(db, context, projectId, copies, source.discardedBids);
    return { importedCount: copies.length, state };
  } catch (error) {
    // 清理失败不掩盖原来的错误：残留的对象由清理任务按对象键前缀处理（第 6 步）。
    for (const artifact of pendingArtifacts) {
      await objectStore.delete(artifact.storageKey).catch(() => {});
      await abandonArtifact(db, context, artifact.id).catch(() => {});
    }
    for (const file of pendingFiles) {
      await objectStore.delete(file.storageKey).catch(() => {});
      await abandonUpload(db, context, file.id).catch(() => {});
    }
    for (const fileId of completedFiles) await softDeleteFile(db, context, fileId).catch(() => {});
    throw error;
  }
}
