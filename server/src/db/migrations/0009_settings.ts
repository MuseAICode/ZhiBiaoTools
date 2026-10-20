// 配置（docs/SERVER_DESIGN.md 第 2.5、4.1 节；路线图第 5 步 5.3）：由桌面版 user_config.json 拆分出的组织级、用户级设置。
// Web 版不再有用户填写的服务商、Base URL 和 API Key（平台统一提供 AI），两张表都不存任何凭据。
//
// - org_settings：每个组织一行（主键 org_id）。选用的平台模型 platform_model_id、并发上限、导出偏好 export_format；
// - user_settings：每个组织的每个成员一行（主键 (org_id, user_id)）。界面偏好 ui_preferences、agent_auto_answer_enabled。
//   用户可以属于多个组织，设置按组织分开，与“每张业务表都有 org_id”的规则一致（第 2.4 节第 1 条）。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行；
// - 组织设置所有成员可读，只有 owner / admin 能写（策略按 org_memberships 中当前用户的角色判断），updated_by 必须是当前用户；
// - 用户设置只有本人能看到、能写；成员关系删除（移出组织、注销）后不可见，由 RLS 强制（策略要求成员关系仍存在），
//   并由复合外键 (org_id, user_id) → org_memberships 级联物理删除；
// - 选用的平台模型必须已登记且启用（触发器 org_settings_guard，ST001）；之后才停用的模型照常保留在设置中，
//   调用时由 ai_model_price 拒绝（BL012），设置页据 platform_models.enabled 提示重新选择；platform_models 不能删除；
// - jsonb 只接受对象，并限制大小；不授予 DELETE（恢复默认值由接口写回默认值）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 并发上限的范围与默认值（桌面版文本模型默认 10，组件并发上限 1~20）。 */
export const CONCURRENCY_LIMIT_MIN = 1;
export const CONCURRENCY_LIMIT_MAX = 20;
export const DEFAULT_CONCURRENCY_LIMIT = 10;
/** jsonb 列序列化后的字节上限。 */
export const EXPORT_FORMAT_MAX_BYTES = 64 * 1024;
export const UI_PREFERENCES_MAX_BYTES = 16 * 1024;
/** 能修改组织设置的成员角色。 */
export const ORG_SETTINGS_EDITOR_ROLES = ['owner', 'admin'] as const;

const EDITOR = sql`EXISTS (
            SELECT 1 FROM org_memberships m
            WHERE m.org_id = org_settings.org_id AND m.user_id = app_current_user_id()
              AND m.role IN (${sql.join(ORG_SETTINGS_EDITOR_ROLES.map((role) => sql.lit(role)))})
          )`;

const SELF = sql`user_id = app_current_user_id() AND EXISTS (
            SELECT 1 FROM org_memberships m
            WHERE m.org_id = user_settings.org_id AND m.user_id = user_settings.user_id
          )`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // updated_by 不设外键，与 projects.created_by 相同，不随用户删除而改动。
    sql`CREATE TABLE org_settings (
          org_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
          platform_model_id uuid REFERENCES platform_models (id),
          concurrency_limit integer NOT NULL DEFAULT ${sql.lit(DEFAULT_CONCURRENCY_LIMIT)}
            CHECK (concurrency_limit BETWEEN ${sql.lit(CONCURRENCY_LIMIT_MIN)} AND ${sql.lit(CONCURRENCY_LIMIT_MAX)}),
          export_format jsonb NOT NULL DEFAULT '{}'::jsonb
            CHECK (jsonb_typeof(export_format) = 'object' AND octet_length(export_format::text) <= ${sql.lit(EXPORT_FORMAT_MAX_BYTES)}),
          updated_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`,
    sql`CREATE TRIGGER org_settings_touch BEFORE UPDATE ON org_settings
          FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,

    // 以调用者身份执行：应用角色在组织上下文中能读 platform_models（迁移 0005）。只在选择发生变化时检查，
    // 已选的模型被停用后，修改其他设置不受影响。
    sql`CREATE FUNCTION org_settings_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.platform_model_id IS NOT NULL
               AND (TG_OP = 'INSERT' OR NEW.platform_model_id IS DISTINCT FROM OLD.platform_model_id)
               AND NOT EXISTS (SELECT 1 FROM platform_models m WHERE m.id = NEW.platform_model_id AND m.enabled) THEN
              RAISE EXCEPTION 'platform model is not available' USING ERRCODE = 'ST001';
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION org_settings_guard() FROM PUBLIC`,
    sql`CREATE TRIGGER org_settings_guard BEFORE INSERT OR UPDATE ON org_settings
          FOR EACH ROW EXECUTE FUNCTION org_settings_guard()`,

    sql`CREATE TABLE user_settings (
          org_id uuid NOT NULL,
          user_id uuid NOT NULL,
          agent_auto_answer_enabled boolean NOT NULL DEFAULT false,
          ui_preferences jsonb NOT NULL DEFAULT '{}'::jsonb
            CHECK (jsonb_typeof(ui_preferences) = 'object' AND octet_length(ui_preferences::text) <= ${sql.lit(UI_PREFERENCES_MAX_BYTES)}),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (org_id, user_id),
          CONSTRAINT user_settings_membership_fkey FOREIGN KEY (org_id, user_id)
            REFERENCES org_memberships (org_id, user_id) ON DELETE CASCADE
        )`,
    sql`CREATE TRIGGER user_settings_touch BEFORE UPDATE ON user_settings
          FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,

    sql`ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE org_settings FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY org_settings_select_tenant ON org_settings FOR SELECT TO ${app}
          USING (org_id = app_current_org_id())`,
    sql`CREATE POLICY org_settings_insert_editor ON org_settings FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND updated_by = app_current_user_id() AND ${EDITOR})`,
    sql`CREATE POLICY org_settings_update_editor ON org_settings FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id() AND ${EDITOR})
          WITH CHECK (org_id = app_current_org_id() AND updated_by = app_current_user_id() AND ${EDITOR})`,
    sql`GRANT SELECT ON org_settings TO ${app}`,
    sql`GRANT INSERT (org_id, platform_model_id, concurrency_limit, export_format, updated_by) ON org_settings TO ${app}`,
    sql`GRANT UPDATE (platform_model_id, concurrency_limit, export_format, updated_by) ON org_settings TO ${app}`,

    sql`ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE user_settings FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY user_settings_self ON user_settings TO ${app}
          USING (org_id = app_current_org_id() AND ${SELF})
          WITH CHECK (org_id = app_current_org_id() AND ${SELF})`,
    sql`GRANT SELECT ON user_settings TO ${app}`,
    sql`GRANT INSERT (org_id, user_id, agent_auto_answer_enabled, ui_preferences) ON user_settings TO ${app}`,
    sql`GRANT UPDATE (agent_auto_answer_enabled, ui_preferences) ON user_settings TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`DROP TABLE user_settings`, sql`DROP TABLE org_settings`, sql`DROP FUNCTION org_settings_guard()`]);
}
