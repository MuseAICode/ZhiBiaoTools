// 技术方案（二）（docs/SERVER_DESIGN.md 第 2.5 节；路线图第 5 步 5.12）：取代桌面版 SQLite 的 technical_plan_outline_nodes 和
// technical_plan_global_fact_groups，并给 technical_plan_meta（迁移 0018）加上目录的项目名称、概述和字数控制快照。两张新表都是
// 项目级表，挂在 kind = 'technical-plan' 的项目下，照 exampleProjectTable 模板写：
//
// - technical_plan_outline_nodes：目录与各节正文（正文在 5.13 之前只随目录保存与清空）。节点 id 是程序分配的稳定 UUID，
//   与桌面版相同以 node_id 关联、parent_node_id 表示父子关系、sort_order 表示同级顺序；显示编号读取时按树的顺序现算，不存；
// - technical_plan_global_fact_groups：全局事实，整体替换。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行，未设置上下文时什么都看不到；项目由复合外键 (org_id, project_id) 保证属于
//   本组织（不级联到别的组织），org_id、project_id、node_id、group_id 写入后不能改；
// - 删除可见性：所属项目已删除（或不是技术方案项目）时两张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复；
//   条件写成“不存在同 id 的已删除或其他 kind 的项目”，跨组织的 project_id 仍由复合外键报错（与 0018 相同）；
// - 目录节点的父节点由复合外键指向同一项目的节点，随父节点级联删除，DEFERRABLE INITIALLY DEFERRED（同一次保存中可以先写子节点、
//   先移动再删除）；层级与是否有父节点一致，节点不能以自己为父（CHECK）；
// - 全局事实整体替换，不授予 UPDATE。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { TECHNICAL_PLAN_BID_ITEM_CONTENT_MAX, TECHNICAL_PLAN_KEY_MAX, TECHNICAL_PLAN_TEXT_MAX, TECHNICAL_PLAN_TITLE_MAX } from './0018_technical_plan.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 叶子节点的正文处理方式（与桌面版 Renderer 的 OutlineContentMode 相同）。 */
export const TECHNICAL_PLAN_CONTENT_MODES = ['ai-generate', 'template-fill', 'directory-generate', 'manual-fill', 'other'] as const;
/** 目录的最大层级（桌面版目录生成要求不超过 6 级，手工添加子目录另留余量）。 */
export const TECHNICAL_PLAN_OUTLINE_DEPTH_MAX = 10;
/** 单节正文的字数上限。 */
export const TECHNICAL_PLAN_CONTENT_MAX = 500_000;
/** 节点引用的知识库条目 id（jsonb 数组）的大小上限。 */
export const TECHNICAL_PLAN_KNOWLEDGE_IDS_MAX_BYTES = 64 * 1024;
/** 字数控制快照（jsonb 对象）的大小上限。 */
export const TECHNICAL_PLAN_WORD_CONTROL_MAX_BYTES = 1024;
/** 全局事实分组 id 的字数上限（桌面版重复时追加 _2、_3……，留出余量）。 */
export const TECHNICAL_PLAN_FACT_ID_MAX = 1000;
/** 一组全局事实内容的字数上限。 */
export const TECHNICAL_PLAN_FACT_CONTENT_MAX = 100_000;

/** 两张新表，按依赖顺序（down 倒序删除）。 */
export const TECHNICAL_PLAN_OUTLINE_TABLES = ['technical_plan_outline_nodes', 'technical_plan_global_fact_groups'] as const;

type Table = (typeof TECHNICAL_PLAN_OUTLINE_TABLES)[number];

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

const SORT_ORDER = sql`sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0)`;
const TENANT = sql`org_id = app_current_org_id()`;

function projectFkey(table: Table): RawBuilder<unknown> {
  return sql`CONSTRAINT ${sql.id(`${table}_project_fkey`)} FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE`;
}

/** 所属项目未删除、是技术方案项目（在应用角色的 RLS 下求值，只看得到本组织的项目；跨组织的 project_id 由外键报错）。 */
function projectLive(table: Table): RawBuilder<unknown> {
  return sql`NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${sql.id(table)}.project_id
    AND (p.deleted_at IS NOT NULL OR p.kind <> 'technical-plan'))`;
}

function policies(table: Table, commands: readonly ('INSERT' | 'UPDATE' | 'DELETE')[]): RawBuilder<unknown>[] {
  const t = sql.id(table);
  const live = projectLive(table);
  return [
    sql`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY ${sql.id(`${table}_select_tenant`)} ON ${t} FOR SELECT TO ${app} USING (${TENANT} AND ${live})`,
    ...(commands.includes('INSERT')
      ? [sql`CREATE POLICY ${sql.id(`${table}_insert_tenant`)} ON ${t} FOR INSERT TO ${app} WITH CHECK (${TENANT} AND ${live})`]
      : []),
    ...(commands.includes('UPDATE')
      ? [sql`CREATE POLICY ${sql.id(`${table}_update_tenant`)} ON ${t} FOR UPDATE TO ${app} USING (${TENANT} AND ${live}) WITH CHECK (${TENANT})`]
      : []),
    ...(commands.includes('DELETE')
      ? [sql`CREATE POLICY ${sql.id(`${table}_delete_tenant`)} ON ${t} FOR DELETE TO ${app} USING (${TENANT} AND ${live})`]
      : []),
  ];
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // ---- 页面状态的新列 ----

    // 目录的项目名称与概述（桌面版 outline_project_*；概述由目录生成任务取自招标解析的项目概述，上限与解析项相同），
    // 字数控制快照（桌面版 outline_word_control_snapshot_json，目录生成时生效的字数控制，正文生成用）。
    sql`ALTER TABLE technical_plan_meta
          ADD COLUMN outline_project_name text CHECK (char_length(outline_project_name) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_TITLE_MAX)}),
          ADD COLUMN outline_project_overview text
            CHECK (char_length(outline_project_overview) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_BID_ITEM_CONTENT_MAX)}),
          ADD COLUMN outline_word_control_snapshot jsonb CHECK (jsonb_typeof(outline_word_control_snapshot) = 'object'
            AND octet_length(outline_word_control_snapshot::text) <= ${sql.lit(TECHNICAL_PLAN_WORD_CONTROL_MAX_BYTES)})`,
    sql`GRANT INSERT (outline_project_name, outline_project_overview, outline_word_control_snapshot) ON technical_plan_meta TO ${app}`,
    sql`GRANT UPDATE (outline_project_name, outline_project_overview, outline_word_control_snapshot) ON technical_plan_meta TO ${app}`,

    // ---- 目录与正文 ----

    sql`CREATE TABLE technical_plan_outline_nodes (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          node_id uuid NOT NULL,
          parent_node_id uuid,
          ${SORT_ORDER},
          level integer NOT NULL CHECK (level BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_OUTLINE_DEPTH_MAX)}),
          title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_TITLE_MAX)}),
          description text NOT NULL DEFAULT '' CHECK (char_length(description) <= ${sql.lit(TECHNICAL_PLAN_TEXT_MAX)}),
          content_mode text CHECK (content_mode IN (${list(TECHNICAL_PLAN_CONTENT_MODES)})),
          content_mode_note text CHECK (char_length(content_mode_note) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_TEXT_MAX)}),
          source_requirement_id text CHECK (char_length(source_requirement_id) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_KEY_MAX)}),
          source_requirement_title text CHECK (char_length(source_requirement_title) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_TITLE_MAX)}),
          knowledge_item_ids jsonb CHECK (jsonb_typeof(knowledge_item_ids) = 'array'
            AND octet_length(knowledge_item_ids::text) <= ${sql.lit(TECHNICAL_PLAN_KNOWLEDGE_IDS_MAX_BYTES)}),
          content text NOT NULL DEFAULT '' CHECK (char_length(content) <= ${sql.lit(TECHNICAL_PLAN_CONTENT_MAX)}),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, node_id),
          CONSTRAINT technical_plan_outline_nodes_scope_key UNIQUE (org_id, project_id, node_id),
          CONSTRAINT technical_plan_outline_nodes_parent_shape CHECK ((parent_node_id IS NULL) = (level = 1)),
          CONSTRAINT technical_plan_outline_nodes_not_own_parent CHECK (parent_node_id <> node_id),
          CONSTRAINT technical_plan_outline_nodes_note_mode CHECK (content_mode_note IS NULL OR content_mode = 'other'),
          ${projectFkey('technical_plan_outline_nodes')},
          CONSTRAINT technical_plan_outline_nodes_parent_fkey FOREIGN KEY (org_id, project_id, parent_node_id)
            REFERENCES technical_plan_outline_nodes (org_id, project_id, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
        )`,
    sql`CREATE INDEX technical_plan_outline_nodes_org_id_project_id_idx
          ON technical_plan_outline_nodes (org_id, project_id, level, parent_node_id, sort_order)`,
    sql`CREATE TRIGGER technical_plan_outline_nodes_touch BEFORE UPDATE ON technical_plan_outline_nodes
          FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,
    ...policies('technical_plan_outline_nodes', ['INSERT', 'UPDATE', 'DELETE']),
    // 排序只改位置、编辑只改标题与说明，节点身份不变（node_id 没有 UPDATE 授权）。
    sql`GRANT SELECT, DELETE ON technical_plan_outline_nodes TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, node_id, parent_node_id, sort_order, level, title, description, content_mode, content_mode_note,
          source_requirement_id, source_requirement_title, knowledge_item_ids, content) ON technical_plan_outline_nodes TO ${app}`,
    sql`GRANT UPDATE (parent_node_id, sort_order, level, title, description, content_mode, content_mode_note, source_requirement_id,
          source_requirement_title, knowledge_item_ids, content) ON technical_plan_outline_nodes TO ${app}`,

    // ---- 全局事实 ----

    // 分组 id 与桌面版 normalizeGlobalFactId 相同只含小写字母、数字、下划线和连字符。updated_at 由 Store 写入（内容未变的分组
    // 沿用原值），不授予 UPDATE。
    sql`CREATE TABLE technical_plan_global_fact_groups (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          group_id text NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_FACT_ID_MAX)}
            AND group_id ~ '^[a-z0-9_-]+$'),
          title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_TITLE_MAX)}),
          content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_FACT_CONTENT_MAX)}),
          ${SORT_ORDER},
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, group_id),
          ${projectFkey('technical_plan_global_fact_groups')}
        )`,
    sql`CREATE INDEX technical_plan_global_fact_groups_org_id_project_id_idx ON technical_plan_global_fact_groups (org_id, project_id, sort_order)`,
    ...policies('technical_plan_global_fact_groups', ['INSERT', 'DELETE']),
    sql`GRANT SELECT, DELETE ON technical_plan_global_fact_groups TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, group_id, title, content, sort_order, updated_at) ON technical_plan_global_fact_groups TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    ...[...TECHNICAL_PLAN_OUTLINE_TABLES].reverse().map((table) => sql`DROP TABLE ${sql.id(table)}`),
    sql`ALTER TABLE technical_plan_meta
          DROP COLUMN outline_word_control_snapshot,
          DROP COLUMN outline_project_overview,
          DROP COLUMN outline_project_name`,
  ]);
}
