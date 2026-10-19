// 文件存储（docs/SERVER_DESIGN.md 第 6 节）：上传文件的元数据。文件内容在对象存储中，本表只存对象键。
//
// 不变式由数据库保证，不依赖应用代码：
// - 对象键是生成列 'org/{org_id}/files/{id}'，id 是数据库生成的随机 UUID，任何角色都不能指定；
//   用户提供的文件名只进 display_name，从不参与对象键，路径穿越无从谈起；
// - 强制 RLS：应用角色只能看到、写入当前组织（app.org_id）的行，created_by 必须是当前用户；
// - 已上传的文件只能软删除（deleted_at），应用角色只能物理删除仍在上传中（uploading）的行，
//   所以删除后 7 天的恢复期（第 9 节第 17 项）不会被应用代码绕过；物理删除由后续的清理任务完成；
// - 上传完成（uploading → uploaded）时由触发器检查组织存储配额（第 9 节第 15 项），超出抛 FS001。
//   同一组织的检查用事务级 advisory lock 串行，并发上传不会一起越过配额。
//   计入配额的是已上传、未删除或仍在恢复期内的文件；上传中（含中断后遗留）的行不计入；
// - 已上传文件的内容字段（大小、哈希、类型）不能再改；恢复只能在删除后 7 天内进行，过期抛 FS002。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 每组织的存储配额（字节）：20 GiB。改配额需要新迁移。 */
export const ORG_STORAGE_QUOTA_BYTES = 20n * 1024n * 1024n * 1024n;
/** 删除后可恢复的天数；过期后不再计入配额，也不能恢复。 */
export const FILE_RESTORE_DAYS = 7;
/** 单文件大小的数据库上限（字节），按用途的上限在应用层（src/files/policy.ts），这里兜底：100 MiB。 */
export const MAX_FILE_BYTES = 100n * 1024n * 1024n;

export const FILE_PURPOSES = ['tender', 'knowledge', 'duplicate-check', 'credential-image'] as const;

const RESTORE_WINDOW = sql.raw(`interval '${FILE_RESTORE_DAYS} days'`);

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // org_id 外键不级联：对象存储中的内容要先由清理任务删除，组织不能连带删掉元数据而留下孤儿对象。
    // created_by / deleted_by 不设外键，与账本的操作人相同，不随用户删除而改动。
    sql`CREATE TABLE files (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id),
          storage_key text GENERATED ALWAYS AS ('org/' || org_id::text || '/files/' || id::text) STORED,
          purpose text NOT NULL CHECK (purpose IN (${sql.join(FILE_PURPOSES.map((purpose) => sql.lit(purpose)))})),
          display_name text NOT NULL CHECK (char_length(display_name) >= 1 AND octet_length(display_name) <= 255),
          extension text NOT NULL CHECK (extension ~ '^[a-z0-9]{1,16}$'),
          status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'uploaded')),
          mime text CHECK (char_length(mime) <= 200),
          size_bytes bigint CHECK (size_bytes BETWEEN 1 AND ${sql.lit(MAX_FILE_BYTES.toString())}::bigint),
          sha256 bytea CHECK (octet_length(sha256) = 32),
          created_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          uploaded_at timestamptz,
          deleted_at timestamptz,
          deleted_by uuid,
          CONSTRAINT files_org_id_id_key UNIQUE (org_id, id),
          CONSTRAINT files_uploaded_shape CHECK (CASE status
            WHEN 'uploaded' THEN mime IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND uploaded_at IS NOT NULL
            ELSE mime IS NULL AND size_bytes IS NULL AND sha256 IS NULL AND uploaded_at IS NULL
          END),
          CONSTRAINT files_deleted_shape CHECK (
            (deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND status = 'uploaded')
          )
        )`,
    sql`CREATE INDEX files_org_id_created_at_idx ON files (org_id, created_at DESC)`,
    sql`CREATE INDEX files_org_id_sha256_idx ON files (org_id, sha256)`,

    // 计入配额的字节数：已上传、未删除或仍在恢复期内。以调用者身份执行，RLS 下只看得到当前组织。
    sql`CREATE FUNCTION files_org_usage_bytes(p_org_id uuid) RETURNS bigint
          LANGUAGE sql STABLE
          AS $$
            SELECT coalesce(sum(f.size_bytes), 0)::bigint FROM public.files f
            WHERE f.org_id = p_org_id AND f.status = 'uploaded'
              AND (f.deleted_at IS NULL OR f.deleted_at > now() - ${RESTORE_WINDOW})
          $$`,

    // 状态转换的守卫。普通函数（SECURITY INVOKER）：配额统计受 RLS 约束，只统计当前组织。
    sql`CREATE FUNCTION files_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_used bigint;
          BEGIN
            IF OLD.status = 'uploaded' THEN
              IF NEW.status <> 'uploaded' OR NEW.mime IS DISTINCT FROM OLD.mime OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
                 OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
                RAISE EXCEPTION 'uploaded file content is immutable' USING ERRCODE = 'FS003';
              END IF;
              IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND OLD.deleted_at <= now() - ${RESTORE_WINDOW} THEN
                RAISE EXCEPTION 'restore window has expired' USING ERRCODE = 'FS002';
              END IF;
              IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL THEN
                RAISE EXCEPTION 'file is already deleted' USING ERRCODE = 'FS004';
              END IF;
              RETURN NEW;
            END IF;

            IF NEW.deleted_at IS NOT NULL THEN
              RAISE EXCEPTION 'file is not uploaded' USING ERRCODE = 'FS004';
            END IF;
            IF NEW.status = 'uploaded' THEN
              -- 同一组织的上传完成从这里开始串行，持锁到事务结束。
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('files_quota:' || NEW.org_id::text, 0));
              v_used := public.files_org_usage_bytes(NEW.org_id);
              IF v_used + NEW.size_bytes > ${sql.lit(ORG_STORAGE_QUOTA_BYTES.toString())}::bigint THEN
                RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'FS001';
              END IF;
              NEW.uploaded_at := now();
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER files_guard BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION files_guard()`,

    sql`ALTER TABLE files ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE files FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY files_select_tenant ON files FOR SELECT TO ${app}
          USING (org_id = app_current_org_id())`,
    sql`CREATE POLICY files_insert_tenant ON files FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND created_by = app_current_user_id() AND status = 'uploading')`,
    sql`CREATE POLICY files_update_tenant ON files FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id())
          WITH CHECK (org_id = app_current_org_id() AND (deleted_by IS NULL OR deleted_by = app_current_user_id()))`,
    sql`CREATE POLICY files_delete_uploading ON files FOR DELETE TO ${app}
          USING (org_id = app_current_org_id() AND status = 'uploading')`,
    sql`GRANT SELECT, DELETE ON files TO ${app}`,
    sql`GRANT INSERT (org_id, purpose, display_name, extension, created_by) ON files TO ${app}`,
    sql`GRANT UPDATE (status, mime, size_bytes, sha256, uploaded_at, deleted_at, deleted_by) ON files TO ${app}`,
    sql`REVOKE ALL ON FUNCTION files_guard() FROM PUBLIC`,
    sql`REVOKE ALL ON FUNCTION files_org_usage_bytes(uuid) FROM PUBLIC`,
    sql`GRANT EXECUTE ON FUNCTION files_org_usage_bytes(uuid) TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`DROP TABLE files`,
    sql`DROP FUNCTION files_guard()`,
    sql`DROP FUNCTION files_org_usage_bytes(uuid)`,
  ]);
}
