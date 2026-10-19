// 生成产物（docs/SERVER_DESIGN.md 第 6.3 节；路线图第 5 步 5.2）：解析出的 Markdown、提取的图片等派生文件的元数据。
// 内容在对象存储中，本表只存对象键。写入方是第 6 步的解析任务，本步只提供 Store 函数和只读接口。
//
// 不变式由数据库保证，不依赖应用代码：
// - 对象键是生成列 'org/{org_id}/artifacts/{id}'，id 是数据库生成的随机 UUID，任何角色都不能指定；
// - 产物至少挂在一个项目或一个来源文件下：(org_id, project_id) → projects、(org_id, source_file_id) → files，
//   复合外键都不级联，挂不到别的组织的项目或文件上；对象存储中的内容要先由清理任务删除；
// - 强制 RLS：应用角色只能看到、写入当前组织的行，created_by 必须是当前用户；
// - 与 files 相同分两步写入：先登记 writing（不计入配额）→ 写对象 → 完成时由触发器检查组织存储配额（AR001），
//   与上传文件共用同一个 advisory lock，二者并发也不会一起越过配额；完成后内容不能再改（AR003）；
//   应用角色只能物理删除仍在写入中的行。
//
// 另外把项目软删除与其下的文件、产物联动起来（5.1 留下），由 RLS 强制，不依赖应用代码：
// - 应用角色的 files 策略：所属项目已删除的行查不到、改不了、删不掉，也不能新挂到已删除的项目下；
// - 应用角色的 artifacts 策略：所属项目已删除、或来源文件不可访问（未上传完成、已删除，或所在项目已删除，
//   后者由 files 自身的策略在子查询中生效）的行同样不可见；
// - 删除状态不复制到文件和产物上：恢复项目即一起恢复；项目删除前就单独删除的文件仍留在回收站，按自己的恢复期处理；
// - 项目条件写成“不存在同 id 的已删除项目”：项目由复合外键保证属于本组织，跨组织的 project_id 仍由外键报错。
//
// 配额函数 files_org_usage_bytes 要统计应用角色看不到的行（已删除项目下的文件在恢复期内仍占配额，
// 否则“删除项目 → 继续上传 → 恢复项目”可以越过配额），所以改为 SECURITY DEFINER，属主是新角色 bidtools_storage
// （NOLOGIN、无 BYPASSRLS，只有为它单独建的只读策略和列级 SELECT 授权），并且只允许统计当前上下文的组织（AR004）。
// 统计范围：文件和产物合计；所属项目或来源文件仍在恢复期内的照常计入，超过恢复期的不再计入，之后由清理任务（第 6 步）物理删除。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, STORAGE_ROLE } from '../roles.ts';
import { FILE_RESTORE_DAYS, MAX_FILE_BYTES, ORG_STORAGE_QUOTA_BYTES } from './0006_files.ts';
import { PROJECT_RESTORE_DAYS } from './0007_projects.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const storage = sql.id(STORAGE_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

/** 产物种类与允许的 MIME：只有 Markdown 和位图，不存 HTML / SVG 等能在浏览器中执行脚本的类型。 */
export const ARTIFACT_MIMES = {
  markdown: ['text/markdown; charset=utf-8'],
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'],
} as const;
export const ARTIFACT_KINDS = Object.keys(ARTIFACT_MIMES) as (keyof typeof ARTIFACT_MIMES)[];
/** 产物名称由服务端生成（例如 content.md、image-001.png），只用作下载时的文件名。 */
export const ARTIFACT_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';
/** 单个产物的大小上限，与上传文件的数据库上限相同（100 MiB）。 */
export const MAX_ARTIFACT_BYTES = MAX_FILE_BYTES;

const FILE_WINDOW = sql.raw(`interval '${FILE_RESTORE_DAYS} days'`);
const PROJECT_WINDOW = sql.raw(`interval '${PROJECT_RESTORE_DAYS} days'`);
const QUOTA = sql.lit(ORG_STORAGE_QUOTA_BYTES.toString());

// 行不属于项目，或同 id 的项目未删除（在应用角色的 RLS 下求值，只看得到本组织的项目）。
const fileProjectLive = sql`(files.project_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM projects p WHERE p.id = files.project_id AND p.deleted_at IS NOT NULL))`;
const artifactProjectLive = sql`(artifacts.project_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM projects p WHERE p.id = artifacts.project_id AND p.deleted_at IS NOT NULL))`;
// 来源文件已上传、未删除；files 的策略在子查询中同样生效，所以来源文件所在项目已删除时也不成立。
const artifactSourceLive = sql`(artifacts.source_file_id IS NULL OR EXISTS (
  SELECT 1 FROM files f WHERE f.id = artifacts.source_file_id AND f.status = 'uploaded' AND f.deleted_at IS NULL))`;

// 0006 / 0007 的配额函数（down 时恢复）。
const LEGACY_USAGE_FUNCTION = sql`CREATE FUNCTION files_org_usage_bytes(p_org_id uuid) RETURNS bigint
      LANGUAGE sql STABLE
      AS $$
        SELECT coalesce(sum(f.size_bytes), 0)::bigint FROM public.files f
        WHERE f.org_id = p_org_id AND f.status = 'uploaded'
          AND (f.deleted_at IS NULL OR f.deleted_at > now() - ${FILE_WINDOW})
      $$`;

const KIND_MIME_CHECK = sql.join(
  ARTIFACT_KINDS.map(
    (kind) => sql`(kind = ${sql.lit(kind)} AND mime IN (${sql.join(ARTIFACT_MIMES[kind].map((mime) => sql.lit(mime)))}))`,
  ),
  sql` OR `,
);

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE TABLE artifacts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id),
          project_id uuid,
          source_file_id uuid,
          storage_key text GENERATED ALWAYS AS ('org/' || org_id::text || '/artifacts/' || id::text) STORED,
          kind text NOT NULL,
          name text NOT NULL CHECK (name ~ ${sql.lit(ARTIFACT_NAME_PATTERN)}),
          mime text NOT NULL,
          status text NOT NULL DEFAULT 'writing' CHECK (status IN ('writing', 'ready')),
          size_bytes bigint CHECK (size_bytes BETWEEN 0 AND ${sql.lit(MAX_ARTIFACT_BYTES.toString())}::bigint),
          sha256 bytea CHECK (octet_length(sha256) = 32),
          created_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz,
          CONSTRAINT artifacts_org_id_id_key UNIQUE (org_id, id),
          CONSTRAINT artifacts_project_fkey FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id),
          CONSTRAINT artifacts_source_file_fkey FOREIGN KEY (org_id, source_file_id) REFERENCES files (org_id, id),
          CONSTRAINT artifacts_owner_present CHECK (project_id IS NOT NULL OR source_file_id IS NOT NULL),
          CONSTRAINT artifacts_kind_mime CHECK (${KIND_MIME_CHECK}),
          CONSTRAINT artifacts_ready_shape CHECK (CASE status
            WHEN 'ready' THEN size_bytes IS NOT NULL AND sha256 IS NOT NULL AND completed_at IS NOT NULL
            ELSE size_bytes IS NULL AND sha256 IS NULL AND completed_at IS NULL
          END)
        )`,
    sql`CREATE INDEX artifacts_org_id_project_id_idx ON artifacts (org_id, project_id, created_at) WHERE project_id IS NOT NULL`,
    sql`CREATE INDEX artifacts_org_id_source_file_id_idx ON artifacts (org_id, source_file_id, created_at) WHERE source_file_id IS NOT NULL`,

    // 项目软删除联动：重建应用角色的 files 策略，加上所属项目未删除的条件（其余条件与 0006 相同）。
    sql`DROP POLICY files_select_tenant ON files`,
    sql`DROP POLICY files_insert_tenant ON files`,
    sql`DROP POLICY files_update_tenant ON files`,
    sql`DROP POLICY files_delete_uploading ON files`,
    sql`CREATE POLICY files_select_tenant ON files FOR SELECT TO ${app}
          USING (org_id = app_current_org_id() AND ${fileProjectLive})`,
    sql`CREATE POLICY files_insert_tenant ON files FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND created_by = app_current_user_id() AND status = 'uploading' AND ${fileProjectLive})`,
    sql`CREATE POLICY files_update_tenant ON files FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id() AND ${fileProjectLive})
          WITH CHECK (org_id = app_current_org_id() AND (deleted_by IS NULL OR deleted_by = app_current_user_id()) AND ${fileProjectLive})`,
    sql`CREATE POLICY files_delete_uploading ON files FOR DELETE TO ${app}
          USING (org_id = app_current_org_id() AND status = 'uploading' AND ${fileProjectLive})`,

    // 配额函数的属主 bidtools_storage：只读，只授函数用到的列；策略只对它生效，应用角色不受影响。
    sql`GRANT USAGE ON SCHEMA public TO ${storage}`,
    sql`GRANT SELECT (id, org_id, project_id, status, size_bytes, deleted_at) ON files TO ${storage}`,
    sql`GRANT SELECT (org_id, project_id, source_file_id, status, size_bytes) ON artifacts TO ${storage}`,
    sql`GRANT SELECT (id, deleted_at) ON projects TO ${storage}`,
    sql`CREATE POLICY files_storage_usage ON files FOR SELECT TO ${storage} USING (true)`,
    sql`CREATE POLICY artifacts_storage_usage ON artifacts FOR SELECT TO ${storage} USING (true)`,
    sql`CREATE POLICY projects_storage_usage ON projects FOR SELECT TO ${storage} USING (true)`,

    // 以 bidtools_storage 的身份重建配额函数，使其成为属主；建完即收回它在 public 的 CREATE 权限。
    // files_guard 按名称调用它，签名不变。
    sql`DROP FUNCTION files_org_usage_bytes(uuid)`,
    sql`GRANT CREATE ON SCHEMA public TO ${storage}`,
    sql`SET ROLE ${storage}`,
    sql`CREATE FUNCTION files_org_usage_bytes(p_org_id uuid) RETURNS bigint
          LANGUAGE plpgsql STABLE ${SECURE}
          AS $$
          DECLARE
            v_used bigint;
          BEGIN
            -- 只统计调用者当前上下文的组织：应用角色不能借它探测别的组织的用量。
            IF p_org_id IS NULL OR p_org_id IS DISTINCT FROM public.app_current_org_id() THEN
              RAISE EXCEPTION 'usage of another organization' USING ERRCODE = 'AR004';
            END IF;
            WITH counted_files AS (
              SELECT f.id, f.size_bytes FROM public.files f
              LEFT JOIN public.projects p ON p.id = f.project_id
              WHERE f.org_id = p_org_id AND f.status = 'uploaded'
                AND (f.deleted_at IS NULL OR f.deleted_at > now() - ${FILE_WINDOW})
                AND (p.deleted_at IS NULL OR p.deleted_at > now() - ${PROJECT_WINDOW})
            )
            SELECT (SELECT coalesce(sum(size_bytes), 0) FROM counted_files)::bigint
              + (SELECT coalesce(sum(a.size_bytes), 0) FROM public.artifacts a
                 LEFT JOIN public.projects p ON p.id = a.project_id
                 WHERE a.org_id = p_org_id AND a.status = 'ready'
                   AND (p.deleted_at IS NULL OR p.deleted_at > now() - ${PROJECT_WINDOW})
                   AND (a.source_file_id IS NULL OR a.source_file_id IN (SELECT id FROM counted_files)))::bigint
            INTO v_used;
            RETURN v_used;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION files_org_usage_bytes(uuid) FROM PUBLIC`,
    sql`GRANT EXECUTE ON FUNCTION files_org_usage_bytes(uuid) TO ${app}`,
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${storage}`,

    // 状态转换的守卫。普通函数（SECURITY INVOKER）：配额统计受 RLS 约束，只统计当前组织。
    sql`CREATE FUNCTION artifacts_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.status = 'ready' THEN
              RAISE EXCEPTION 'ready artifact is immutable' USING ERRCODE = 'AR003';
            END IF;
            IF NEW.status = 'ready' THEN
              -- 与 files_guard 同一个锁：同一组织的上传完成和产物完成串行，持锁到事务结束。
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('files_quota:' || NEW.org_id::text, 0));
              IF public.files_org_usage_bytes(NEW.org_id) + NEW.size_bytes > ${QUOTA}::bigint THEN
                RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'AR001';
              END IF;
              NEW.completed_at := now();
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER artifacts_guard BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION artifacts_guard()`,
    sql`REVOKE ALL ON FUNCTION artifacts_guard() FROM PUBLIC`,

    sql`ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE artifacts FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY artifacts_select_tenant ON artifacts FOR SELECT TO ${app}
          USING (org_id = app_current_org_id() AND ${artifactProjectLive} AND ${artifactSourceLive})`,
    sql`CREATE POLICY artifacts_insert_tenant ON artifacts FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND created_by = app_current_user_id() AND status = 'writing'
            AND ${artifactProjectLive} AND ${artifactSourceLive})`,
    sql`CREATE POLICY artifacts_update_tenant ON artifacts FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id() AND ${artifactProjectLive} AND ${artifactSourceLive})
          WITH CHECK (org_id = app_current_org_id())`,
    sql`CREATE POLICY artifacts_delete_writing ON artifacts FOR DELETE TO ${app}
          USING (org_id = app_current_org_id() AND status = 'writing' AND ${artifactProjectLive} AND ${artifactSourceLive})`,
    sql`GRANT SELECT, DELETE ON artifacts TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, source_file_id, kind, name, mime, created_by) ON artifacts TO ${app}`,
    sql`GRANT UPDATE (status, size_bytes, sha256) ON artifacts TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 先恢复 0006 的配额函数（属主为迁移角色、不引用 artifacts、projects），再删表和 bidtools_storage 的授权。
    sql`SET ROLE ${storage}`,
    sql`DROP FUNCTION files_org_usage_bytes(uuid)`,
    sql`RESET ROLE`,
    LEGACY_USAGE_FUNCTION,
    sql`REVOKE ALL ON FUNCTION files_org_usage_bytes(uuid) FROM PUBLIC`,
    sql`GRANT EXECUTE ON FUNCTION files_org_usage_bytes(uuid) TO ${app}`,
    sql`DROP TABLE artifacts`,
    sql`DROP FUNCTION artifacts_guard()`,

    sql`DROP POLICY files_storage_usage ON files`,
    sql`DROP POLICY projects_storage_usage ON projects`,
    // 列级授权不随表级 REVOKE 收回，逐一收回。
    sql`REVOKE SELECT (id, org_id, project_id, status, size_bytes, deleted_at) ON files FROM ${storage}`,
    sql`REVOKE SELECT (id, deleted_at) ON projects FROM ${storage}`,
    sql`REVOKE USAGE ON SCHEMA public FROM ${storage}`,

    // 恢复 0006 的 files 策略。
    sql`DROP POLICY files_select_tenant ON files`,
    sql`DROP POLICY files_insert_tenant ON files`,
    sql`DROP POLICY files_update_tenant ON files`,
    sql`DROP POLICY files_delete_uploading ON files`,
    sql`CREATE POLICY files_select_tenant ON files FOR SELECT TO ${app}
          USING (org_id = app_current_org_id())`,
    sql`CREATE POLICY files_insert_tenant ON files FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND created_by = app_current_user_id() AND status = 'uploading')`,
    sql`CREATE POLICY files_update_tenant ON files FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id())
          WITH CHECK (org_id = app_current_org_id() AND (deleted_by IS NULL OR deleted_by = app_current_user_id()))`,
    sql`CREATE POLICY files_delete_uploading ON files FOR DELETE TO ${app}
          USING (org_id = app_current_org_id() AND status = 'uploading')`,
  ]);
}
