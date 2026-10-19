// 项目（docs/SERVER_DESIGN.md 第 2.2、2.4 节；路线图第 5 步 5.1）：技术方案、可研报告、废标检查、标书查重各自一种 kind，
// 取代桌面版各模块的单行 meta。项目级业务表（5.8 起）都挂在 projects 下，files 加可空的 project_id。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织（app.org_id）的项目，created_by 必须是当前用户；
// - kind、created_by 建好后不能改（没有列级 UPDATE 授权）；
// - 只能软删除（deleted_at），应用角色没有 DELETE 权限，删除后 7 天内可以恢复，过期抛 PJ002；
//   已删除的项目除恢复外不能再改（PJ004）。物理删除由后续的清理任务完成，项目级表随之级联删除；
// - 子表一律用 (org_id, project_id) 复合外键指向 projects (org_id, id)：外键检查不受 RLS 约束，
//   子记录挂不到别的组织的项目上，即使应用代码传错了 projectId。
//
// 另建通用触发器函数 app_touch_updated_at()，供项目级表维护 updated_at（模板见 tests/db/fixtures/exampleProjectTable.ts）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

export const PROJECT_KINDS = ['technical-plan', 'feasibility-report', 'rejection-check', 'duplicate-check'] as const;
/** 删除后可恢复的天数；与文件相同（第 9 节第 17 项）。 */
export const PROJECT_RESTORE_DAYS = 7;
export const PROJECT_NAME_MAX_LENGTH = 200;

const RESTORE_WINDOW = sql.raw(`interval '${PROJECT_RESTORE_DAYS} days'`);

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE FUNCTION app_touch_updated_at() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            NEW.updated_at := now();
            RETURN NEW;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION app_touch_updated_at() FROM PUBLIC`,

    // org_id 外键不级联：项目下的文件要先由清理任务删除对象存储中的内容（与 files 相同）。
    // created_by / deleted_by 不设外键，与 files 相同，不随用户删除而改动。
    sql`CREATE TABLE projects (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id),
          kind text NOT NULL CHECK (kind IN (${sql.join(PROJECT_KINDS.map((kind) => sql.lit(kind)))})),
          name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND ${sql.lit(PROJECT_NAME_MAX_LENGTH)} AND name = btrim(name)),
          created_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz,
          deleted_by uuid,
          CONSTRAINT projects_org_id_id_key UNIQUE (org_id, id),
          CONSTRAINT projects_deleted_shape CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
        )`,
    sql`CREATE INDEX projects_org_id_kind_created_at_idx ON projects (org_id, kind, created_at DESC)`,

    sql`CREATE FUNCTION projects_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.deleted_at IS NOT NULL THEN
              IF NEW.deleted_at IS NOT NULL THEN
                RAISE EXCEPTION 'project is deleted' USING ERRCODE = 'PJ004';
              END IF;
              IF OLD.deleted_at <= now() - ${RESTORE_WINDOW} THEN
                RAISE EXCEPTION 'restore window has expired' USING ERRCODE = 'PJ002';
              END IF;
            END IF;
            NEW.updated_at := now();
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER projects_guard BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION projects_guard()`,
    sql`REVOKE ALL ON FUNCTION projects_guard() FROM PUBLIC`,

    sql`ALTER TABLE projects ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE projects FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY projects_select_tenant ON projects FOR SELECT TO ${app}
          USING (org_id = app_current_org_id())`,
    sql`CREATE POLICY projects_insert_tenant ON projects FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND created_by = app_current_user_id())`,
    sql`CREATE POLICY projects_update_tenant ON projects FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id())
          WITH CHECK (org_id = app_current_org_id() AND (deleted_by IS NULL OR deleted_by = app_current_user_id()))`,
    sql`GRANT SELECT ON projects TO ${app}`,
    sql`GRANT INSERT (org_id, kind, name, created_by) ON projects TO ${app}`,
    sql`GRANT UPDATE (name, deleted_at, deleted_by) ON projects TO ${app}`,

    // 文件可以挂到本组织的一个项目下（用户上传的原件）。外键不级联：项目被清理前，清理任务先删除文件的对象和元数据。
    sql`ALTER TABLE files ADD COLUMN project_id uuid`,
    sql`ALTER TABLE files ADD CONSTRAINT files_project_fkey FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id)`,
    sql`CREATE INDEX files_org_id_project_id_idx ON files (org_id, project_id) WHERE project_id IS NOT NULL`,
    sql`GRANT INSERT (project_id), UPDATE (project_id) ON files TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE files DROP COLUMN project_id`,
    sql`DROP TABLE projects`,
    sql`DROP FUNCTION projects_guard()`,
    sql`DROP FUNCTION app_touch_updated_at()`,
  ]);
}
