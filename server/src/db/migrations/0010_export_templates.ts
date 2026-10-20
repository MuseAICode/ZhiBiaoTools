// 导出模板库（docs/SERVER_DESIGN.md 第 2.5 节；路线图第 5 步 5.4）：取代桌面版 SQLite 的 export_templates。
// config 保存完整的导出格式配置（与 org_settings.export_format 同一结构），技术方案生成设置按模板 id 引用（5.11 起）。
//
// - 组织模板：org_id 为本组织，组织内成员都可以新建、修改、删除（组织内共享，第 9 节第 2 项）；
// - 系统模板：org_id 为空、system_key 为稳定的标识，所有组织可读、任何组织都不能修改或删除，只能复制成组织模板。
//   内容的真源是 src/templates/systemTemplates.ts，由迁移命令在迁移到最新后幂等同步（src/templates/system.ts），
//   改预设样式不需要写迁移。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到本组织的模板和系统模板（未设置上下文时什么都看不到），只能写入、修改、删除本组织的模板；
//   系统模板对应用角色只读，修改、删除影响 0 行，不能新写 org_id 为空的行，也不能把组织模板改成系统模板；
// - 系统模板只由迁移角色维护：它在本表上只有一条策略，只覆盖 org_id 为空的行，看不到也写不了任何组织的模板；
// - 组织模板 created_by / updated_by 必须是当前用户；system_key 没有应用角色的写授权；
// - 名称与 config.template_name 一致（CHECK），config 只接受对象并限制大小；每个组织最多 100 个模板（触发器，ET001）。
//
// 删除是物理删除，与桌面版相同：模板是可随时复制的配置，不设回收站；组织删除时其模板随之级联删除。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, OWNER_ROLE } from '../roles.ts';
import { EXPORT_FORMAT_MAX_BYTES } from './0009_settings.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const owner = sql.id(OWNER_ROLE);

export const EXPORT_TEMPLATE_NAME_MAX_LENGTH = 200;
/** 模板配置序列化后的字节上限，与组织设置中的导出偏好相同。 */
export const EXPORT_TEMPLATE_CONFIG_MAX_BYTES = EXPORT_FORMAT_MAX_BYTES;
/** 每个组织的模板数上限（系统模板不计）。 */
export const EXPORT_TEMPLATES_PER_ORG_MAX = 100;
export const SYSTEM_TEMPLATE_KEY_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$';

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // created_by / updated_by 不设外键，与 projects.created_by 相同，不随用户删除而改动。
    sql`CREATE TABLE export_templates (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
          system_key text UNIQUE CHECK (system_key ~ ${sql.lit(SYSTEM_TEMPLATE_KEY_PATTERN)}),
          name text NOT NULL
            CHECK (char_length(name) BETWEEN 1 AND ${sql.lit(EXPORT_TEMPLATE_NAME_MAX_LENGTH)} AND name = btrim(name)),
          config jsonb NOT NULL
            CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= ${sql.lit(EXPORT_TEMPLATE_CONFIG_MAX_BYTES)}),
          sort_order integer NOT NULL DEFAULT 0,
          created_by uuid,
          updated_by uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT export_templates_org_id_id_key UNIQUE (org_id, id),
          CONSTRAINT export_templates_name_matches_config CHECK (config ->> 'template_name' = name),
          CONSTRAINT export_templates_owner_shape CHECK (
            CASE WHEN org_id IS NULL
              THEN system_key IS NOT NULL AND created_by IS NULL AND updated_by IS NULL
              ELSE system_key IS NULL AND created_by IS NOT NULL AND updated_by IS NOT NULL
            END
          )
        )`,
    sql`CREATE INDEX export_templates_org_id_updated_at_idx ON export_templates (org_id, updated_at DESC)`,
    sql`CREATE TRIGGER export_templates_touch BEFORE UPDATE ON export_templates
          FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,

    // 以调用者身份执行：应用角色在 RLS 下正好能数到本组织的模板。同一组织的插入用事务级 advisory lock 串行，
    // 并发新建不会一起越过上限。
    sql`CREATE FUNCTION export_templates_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.org_id IS NOT NULL THEN
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('export_templates:' || NEW.org_id::text, 0));
              IF (SELECT count(*) FROM export_templates t WHERE t.org_id = NEW.org_id) >= ${sql.lit(EXPORT_TEMPLATES_PER_ORG_MAX)} THEN
                RAISE EXCEPTION 'too many export templates' USING ERRCODE = 'ET001';
              END IF;
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION export_templates_guard() FROM PUBLIC`,
    sql`CREATE TRIGGER export_templates_guard BEFORE INSERT ON export_templates
          FOR EACH ROW EXECUTE FUNCTION export_templates_guard()`,

    sql`ALTER TABLE export_templates ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE export_templates FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY export_templates_select_visible ON export_templates FOR SELECT TO ${app}
          USING (app_current_org_id() IS NOT NULL AND (org_id IS NULL OR org_id = app_current_org_id()))`,
    sql`CREATE POLICY export_templates_insert_tenant ON export_templates FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND created_by = app_current_user_id() AND updated_by = app_current_user_id())`,
    sql`CREATE POLICY export_templates_update_tenant ON export_templates FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id())
          WITH CHECK (org_id = app_current_org_id() AND updated_by = app_current_user_id())`,
    sql`CREATE POLICY export_templates_delete_tenant ON export_templates FOR DELETE TO ${app}
          USING (org_id = app_current_org_id())`,
    sql`GRANT SELECT, DELETE ON export_templates TO ${app}`,
    sql`GRANT INSERT (org_id, name, config, created_by, updated_by) ON export_templates TO ${app}`,
    sql`GRANT UPDATE (name, config, updated_by) ON export_templates TO ${app}`,

    // 迁移角色是表属主，FORCE RLS 下同样受策略约束：只给它系统模板这一部分，用于同步系统模板。
    sql`CREATE POLICY export_templates_system_sync ON export_templates TO ${owner}
          USING (org_id IS NULL) WITH CHECK (org_id IS NULL)`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`DROP TABLE export_templates`, sql`DROP FUNCTION export_templates_guard()`]);
}
