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
// 另外把项目软删除与其下的文件、产物联动起来（5.1 留下）：
// - 不复制删除状态，而是在读取时判断：文件所属的项目已删除时文件不可访问；产物所属的项目已删除、
//   或来源文件不可访问（自身已删除，或所在项目已删除）时产物不可访问。恢复项目即一起恢复，
//   项目删除前就单独删除的文件仍留在回收站中，按自己的恢复期处理；
// - 配额函数 files_org_usage_bytes 改为统计文件和产物：项目或来源文件仍在恢复期内的照常计入，
//   超过恢复期的不再计入（与单独删除的文件相同），之后由清理任务（第 6 步）与项目一起物理删除。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { FILE_RESTORE_DAYS, MAX_FILE_BYTES, ORG_STORAGE_QUOTA_BYTES } from './0006_files.ts';
import { PROJECT_RESTORE_DAYS } from './0007_projects.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

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

    // 配额：文件和产物合计。文件计入的条件不变（已上传，未删除或仍在恢复期内），另要求所属项目未删除或仍在恢复期内；
    // 产物要求已完成、所属项目同上、来源文件仍计入配额。以调用者身份执行，RLS 下只看得到当前组织。
    sql`CREATE OR REPLACE FUNCTION files_org_usage_bytes(p_org_id uuid) RETURNS bigint
          LANGUAGE sql STABLE
          AS $$
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
          $$`,

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
          USING (org_id = app_current_org_id())`,
    sql`CREATE POLICY artifacts_insert_tenant ON artifacts FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND created_by = app_current_user_id() AND status = 'writing')`,
    sql`CREATE POLICY artifacts_update_tenant ON artifacts FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id())
          WITH CHECK (org_id = app_current_org_id())`,
    sql`CREATE POLICY artifacts_delete_writing ON artifacts FOR DELETE TO ${app}
          USING (org_id = app_current_org_id() AND status = 'writing')`,
    sql`GRANT SELECT, DELETE ON artifacts TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, source_file_id, kind, name, mime, created_by) ON artifacts TO ${app}`,
    sql`GRANT UPDATE (status, size_bytes, sha256) ON artifacts TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 先恢复 0006 的配额函数（不再引用 artifacts、projects），再删表。
    sql`CREATE OR REPLACE FUNCTION files_org_usage_bytes(p_org_id uuid) RETURNS bigint
          LANGUAGE sql STABLE
          AS $$
            SELECT coalesce(sum(f.size_bytes), 0)::bigint FROM public.files f
            WHERE f.org_id = p_org_id AND f.status = 'uploaded'
              AND (f.deleted_at IS NULL OR f.deleted_at > now() - ${FILE_WINDOW})
          $$`,
    sql`DROP TABLE artifacts`,
    sql`DROP FUNCTION artifacts_guard()`,
  ]);
}
