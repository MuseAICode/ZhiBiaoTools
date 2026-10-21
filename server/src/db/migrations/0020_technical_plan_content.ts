// 技术方案（三）（docs/SERVER_DESIGN.md 第 2.5 节；路线图第 5 步 5.13）：取代桌面版 SQLite 的 technical_plan_content_sections
// 和 technical_plan_content_plans，并给 technical_plan_meta（迁移 0018）加上正文生成的运行进度（桌面版
// content_generation_runtime_json）。两张新表都是项目级表，挂在 kind = 'technical-plan' 的项目下，照 exampleProjectTable 模板写：
//
// - technical_plan_content_sections：各节的正文生成状态与错误（正文本身仍在 technical_plan_outline_nodes.content）；
// - technical_plan_content_plans：各节的正文编排（plan_version、plan、表格要求），由第 8 步的正文生成任务写入。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行，未设置上下文时什么都看不到；项目由复合外键 (org_id, project_id) 保证属于
//   本组织（不级联到别的组织），org_id、project_id、node_id 写入后不能改；
// - 删除可见性：所属项目已删除（或不是技术方案项目）时两张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复；
//   条件写成“不存在同 id 的已删除或其他 kind 的项目”，跨组织的 project_id 仍由复合外键报错（与 0018、0019 相同）；
// - 只能挂在同一项目的目录节点上（复合外键 (org_id, project_id, node_id) → technical_plan_outline_nodes），节点删除时
//   随之删除（与桌面版外键相同），目录整体替换或删除不会留下孤立的状态与编排。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { TECHNICAL_PLAN_RUN_STATUSES, TECHNICAL_PLAN_TABLE_REQUIREMENTS, TECHNICAL_PLAN_TEXT_MAX } from './0018_technical_plan.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 一节正文编排（jsonb 对象）的大小上限。 */
export const TECHNICAL_PLAN_CONTENT_PLAN_MAX_BYTES = 256 * 1024;
/** 正文生成运行进度（jsonb 对象）的大小上限。 */
export const TECHNICAL_PLAN_CONTENT_RUNTIME_MAX_BYTES = 1024 * 1024;

/** 两张新表，按依赖顺序（down 倒序删除）。 */
export const TECHNICAL_PLAN_CONTENT_TABLES = ['technical_plan_content_sections', 'technical_plan_content_plans'] as const;

type Table = (typeof TECHNICAL_PLAN_CONTENT_TABLES)[number];

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

const TENANT = sql`org_id = app_current_org_id()`;

function foreignKeys(table: Table): RawBuilder<unknown> {
  return sql`CONSTRAINT ${sql.id(`${table}_project_fkey`)} FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE,
    CONSTRAINT ${sql.id(`${table}_node_fkey`)} FOREIGN KEY (org_id, project_id, node_id)
      REFERENCES technical_plan_outline_nodes (org_id, project_id, node_id) ON DELETE CASCADE`;
}

/** 所属项目未删除、是技术方案项目（在应用角色的 RLS 下求值，只看得到本组织的项目；跨组织的 project_id 由外键报错）。 */
function projectLive(table: Table): RawBuilder<unknown> {
  return sql`NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${sql.id(table)}.project_id
    AND (p.deleted_at IS NOT NULL OR p.kind <> 'technical-plan'))`;
}

function policies(table: Table): RawBuilder<unknown>[] {
  const t = sql.id(table);
  const live = projectLive(table);
  return [
    sql`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY ${sql.id(`${table}_select_tenant`)} ON ${t} FOR SELECT TO ${app} USING (${TENANT} AND ${live})`,
    sql`CREATE POLICY ${sql.id(`${table}_insert_tenant`)} ON ${t} FOR INSERT TO ${app} WITH CHECK (${TENANT} AND ${live})`,
    sql`CREATE POLICY ${sql.id(`${table}_update_tenant`)} ON ${t} FOR UPDATE TO ${app} USING (${TENANT} AND ${live}) WITH CHECK (${TENANT})`,
    sql`CREATE POLICY ${sql.id(`${table}_delete_tenant`)} ON ${t} FOR DELETE TO ${app} USING (${TENANT} AND ${live})`,
    sql`CREATE TRIGGER ${sql.id(`${table}_touch`)} BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,
  ];
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // ---- 正文生成的运行进度 ----

    // 桌面版 content_generation_runtime_json：已确认的各节字数、生成范围、阶段等，由第 8 步的正文生成任务写入，保存目录时
    // 按 reason 协议保留或清空（Store）。
    sql`ALTER TABLE technical_plan_meta
          ADD COLUMN content_generation_runtime jsonb CHECK (jsonb_typeof(content_generation_runtime) = 'object'
            AND octet_length(content_generation_runtime::text) <= ${sql.lit(TECHNICAL_PLAN_CONTENT_RUNTIME_MAX_BYTES)})`,
    sql`GRANT INSERT (content_generation_runtime) ON technical_plan_meta TO ${app}`,
    sql`GRANT UPDATE (content_generation_runtime) ON technical_plan_meta TO ${app}`,

    // ---- 各节的生成状态 ----

    sql`CREATE TABLE technical_plan_content_sections (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          node_id uuid NOT NULL,
          status text NOT NULL DEFAULT 'idle' CHECK (status IN (${list(TECHNICAL_PLAN_RUN_STATUSES)})),
          error text CHECK (char_length(error) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_TEXT_MAX)}),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, node_id),
          ${foreignKeys('technical_plan_content_sections')}
        )`,
    sql`CREATE INDEX technical_plan_content_sections_org_id_project_id_idx ON technical_plan_content_sections (org_id, project_id, node_id)`,
    ...policies('technical_plan_content_sections'),
    sql`GRANT SELECT, DELETE ON technical_plan_content_sections TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, node_id, status, error) ON technical_plan_content_sections TO ${app}`,
    sql`GRANT UPDATE (status, error) ON technical_plan_content_sections TO ${app}`,

    // ---- 各节的正文编排 ----

    sql`CREATE TABLE technical_plan_content_plans (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          node_id uuid NOT NULL,
          plan_version integer NOT NULL CHECK (plan_version > 0),
          plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'
            AND octet_length(plan::text) <= ${sql.lit(TECHNICAL_PLAN_CONTENT_PLAN_MAX_BYTES)}),
          table_requirement text CHECK (table_requirement IN (${list(TECHNICAL_PLAN_TABLE_REQUIREMENTS)})),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, node_id),
          ${foreignKeys('technical_plan_content_plans')}
        )`,
    sql`CREATE INDEX technical_plan_content_plans_org_id_project_id_idx ON technical_plan_content_plans (org_id, project_id, node_id)`,
    ...policies('technical_plan_content_plans'),
    sql`GRANT SELECT, DELETE ON technical_plan_content_plans TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, node_id, plan_version, plan, table_requirement) ON technical_plan_content_plans TO ${app}`,
    sql`GRANT UPDATE (plan_version, plan, table_requirement) ON technical_plan_content_plans TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    ...[...TECHNICAL_PLAN_CONTENT_TABLES].reverse().map((table) => sql`DROP TABLE ${sql.id(table)}`),
    sql`ALTER TABLE technical_plan_meta DROP COLUMN content_generation_runtime`,
  ]);
}
