// AI 小节正文的存储（路线图第 8 步 8.10a；docs/SERVER_DESIGN.md 第 2.5 节）：取代桌面版正文 Agent 工作区中的
// 正文/<节点 id>.html 与其引用的配图文件（#61 决定事项第 6 项、#70 决定事项第 5 项的 C：业务结果写数据库与产物）。
// 两张新表都是项目级表，挂在 kind = 'technical-plan' 的项目下，照 exampleProjectTable 模板写：
//
// - technical_plan_section_bodies：各 AI 小节的正文（受限 HTML，入库前经服务端白名单 parseRestrictedHtml 规范化，
//   只保存规范化的结果，见 src/technicalPlan/sectionBodies.ts）；
// - technical_plan_section_images：正文引用的配图（img 的 data-app-asset-ref 就是图片产物 id，与整本导出相同）。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行，未设置上下文时什么都看不到；项目由复合外键 (org_id, project_id) 保证属于
//   本组织，org_id、project_id、node_id、artifact_id 写入后不能改（没有 UPDATE 授权）；
// - 删除可见性：所属项目已删除（或不是技术方案项目）时两张表的行查不到、改不了、删不掉，也不能新写（与 0020 相同）；
// - 正文只能挂在同一项目的目录节点上（复合外键 → technical_plan_outline_nodes，节点删除时随之删除）；配图行挂在同一节的
//   正文上（复合外键 → technical_plan_section_bodies，正文删除时随之删除）；
// - 配图只能引用同一组织、同一项目中已完成、未被替换的 image 产物（触发器在写入时检查，TP046；产物删除时配图行随之删除）。
//   不再被引用的配图由 Store 标为已被替换（迁移 0023），再由清理任务删除。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 一节正文（规范化后的受限 HTML，UTF-8 字节）的大小上限。 */
export const TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES = 2 * 1024 * 1024;
/** 一节正文至多引用的配图数（同一产物只算一次）。 */
export const TECHNICAL_PLAN_SECTION_IMAGES_MAX = 200;

/** 两张新表，按依赖顺序（down 倒序删除）。 */
export const TECHNICAL_PLAN_SECTION_BODY_TABLES = ['technical_plan_section_bodies', 'technical_plan_section_images'] as const;

type Table = (typeof TECHNICAL_PLAN_SECTION_BODY_TABLES)[number];

const TENANT = sql`org_id = app_current_org_id()`;

/** 所属项目未删除、是技术方案项目（在应用角色的 RLS 下求值，只看得到本组织的项目；跨组织的 project_id 由外键报错）。 */
function projectLive(table: Table): RawBuilder<unknown> {
  return sql`NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${sql.id(table)}.project_id
    AND (p.deleted_at IS NOT NULL OR p.kind <> 'technical-plan'))`;
}

function policies(table: Table, touch: boolean): RawBuilder<unknown>[] {
  const t = sql.id(table);
  const live = projectLive(table);
  return [
    sql`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY ${sql.id(`${table}_select_tenant`)} ON ${t} FOR SELECT TO ${app} USING (${TENANT} AND ${live})`,
    sql`CREATE POLICY ${sql.id(`${table}_insert_tenant`)} ON ${t} FOR INSERT TO ${app} WITH CHECK (${TENANT} AND ${live})`,
    sql`CREATE POLICY ${sql.id(`${table}_update_tenant`)} ON ${t} FOR UPDATE TO ${app} USING (${TENANT} AND ${live}) WITH CHECK (${TENANT})`,
    sql`CREATE POLICY ${sql.id(`${table}_delete_tenant`)} ON ${t} FOR DELETE TO ${app} USING (${TENANT} AND ${live})`,
    ...(touch ? [sql`CREATE TRIGGER ${sql.id(`${table}_touch`)} BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`] : []),
  ];
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // ---- 各节正文 ----

    sql`CREATE TABLE technical_plan_section_bodies (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          node_id uuid NOT NULL,
          html text NOT NULL CHECK (octet_length(html) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES)}),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, node_id),
          CONSTRAINT technical_plan_section_bodies_org_key UNIQUE (org_id, project_id, node_id),
          CONSTRAINT technical_plan_section_bodies_project_fkey FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE,
          CONSTRAINT technical_plan_section_bodies_node_fkey FOREIGN KEY (org_id, project_id, node_id)
            REFERENCES technical_plan_outline_nodes (org_id, project_id, node_id) ON DELETE CASCADE
        )`,
    ...policies('technical_plan_section_bodies', true),
    sql`GRANT SELECT, DELETE ON technical_plan_section_bodies TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, node_id, html) ON technical_plan_section_bodies TO ${app}`,
    sql`GRANT UPDATE (html) ON technical_plan_section_bodies TO ${app}`,

    // ---- 正文引用的配图 ----

    sql`CREATE TABLE technical_plan_section_images (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          node_id uuid NOT NULL,
          artifact_id uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, node_id, artifact_id),
          CONSTRAINT technical_plan_section_images_body_fkey FOREIGN KEY (org_id, project_id, node_id)
            REFERENCES technical_plan_section_bodies (org_id, project_id, node_id) ON DELETE CASCADE,
          CONSTRAINT technical_plan_section_images_artifact_fkey FOREIGN KEY (org_id, artifact_id)
            REFERENCES artifacts (org_id, id) ON DELETE CASCADE
        )`,
    sql`CREATE INDEX technical_plan_section_images_artifact_idx ON technical_plan_section_images (org_id, artifact_id)`,
    ...policies('technical_plan_section_images', false),
    sql`GRANT SELECT, DELETE ON technical_plan_section_images TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, node_id, artifact_id) ON technical_plan_section_images TO ${app}`,

    // 普通函数（SECURITY INVOKER）：产物在应用角色的 RLS 下查找，只看得到本组织、项目未删除的产物。
    sql`CREATE FUNCTION technical_plan_section_images_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM public.artifacts a
              WHERE a.id = NEW.artifact_id AND a.org_id = NEW.org_id AND a.project_id = NEW.project_id
                AND a.kind = 'image' AND a.status = 'ready' AND a.superseded_at IS NULL
            ) THEN
              RAISE EXCEPTION 'section image must be a ready image artifact of the same project' USING ERRCODE = 'TP046';
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION technical_plan_section_images_guard() FROM PUBLIC`,
    sql`CREATE TRIGGER technical_plan_section_images_guard BEFORE INSERT ON technical_plan_section_images
          FOR EACH ROW EXECUTE FUNCTION technical_plan_section_images_guard()`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    ...[...TECHNICAL_PLAN_SECTION_BODY_TABLES].reverse().map((table) => sql`DROP TABLE ${sql.id(table)}`),
    sql`DROP FUNCTION technical_plan_section_images_guard()`,
  ]);
}
