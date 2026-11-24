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
//   不再被引用的配图由 Store 标为已被替换（迁移 0023），再由清理任务删除；
// - 配额：正文按 UTF-8 字节计入组织存储配额——0040 的配额函数 files_org_usage_bytes 加上本表（所属项目在恢复期内的照常计入，
//   超过恢复期的不再计入），函数的属主 bidtools_storage 多了本表 3 列的列级 SELECT 与一条只读策略；写入或改大正文时由触发器
//   检查配额（TP047，与文件、产物、快照共用同一个 advisory lock），改小或不变的照常写入；
// - 项目删除：软删除后两张表的行不可见（RLS）；超过恢复期由清理任务物理删除项目时，正文随项目级联删除，配图行随产物删除
//   （清理任务先删产物，配图引用的产物挡住项目的物理删除）。
//
// 修改了已有的定义者角色 bidtools_storage 的配额函数与授权；已有表的 RLS 策略不改。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, STORAGE_ROLE } from '../roles.ts';
import { ORG_STORAGE_QUOTA_BYTES } from './0006_files.ts';
import { PROJECT_RESTORE_DAYS } from './0007_projects.ts';
import { usageFunction } from './0040_agent_workspace_snapshots.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const storage = sql.id(STORAGE_ROLE);
const QUOTA = sql.lit(ORG_STORAGE_QUOTA_BYTES.toString());
const PROJECT_WINDOW = sql.raw(`interval '${PROJECT_RESTORE_DAYS} days'`);

/** 配额函数追加的计入项：本组织各 AI 小节正文的 UTF-8 字节数，所属项目超过恢复期的不再计入（与产物、快照相同）。 */
const SECTION_BODIES_USAGE = sql`
              + (SELECT coalesce(sum(octet_length(b.html)), 0) FROM public.technical_plan_section_bodies b
                 JOIN public.projects p ON p.id = b.project_id
                 WHERE b.org_id = p_org_id
                   AND (p.deleted_at IS NULL OR p.deleted_at > now() - ${PROJECT_WINDOW}))::bigint`;

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

    // 配额：写入或改大正文时检查（普通函数，配额统计经属主为 bidtools_storage 的配额函数，只统计当前组织）。
    // BEFORE 触发器求值时旧行仍在统计中，所以按“用量 − 旧大小 + 新大小”比较。
    sql`CREATE FUNCTION technical_plan_section_bodies_quota() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_old bigint := CASE WHEN TG_OP = 'UPDATE' THEN octet_length(OLD.html) ELSE 0 END;
            v_new bigint := octet_length(NEW.html);
          BEGIN
            IF v_new > v_old THEN
              -- 与 files_guard、artifacts_guard、agent_workspace_snapshots_guard 同一个锁，持锁到事务结束。
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('files_quota:' || NEW.org_id::text, 0));
              IF public.files_org_usage_bytes(NEW.org_id) - v_old + v_new > ${QUOTA}::bigint THEN
                RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'TP047';
              END IF;
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION technical_plan_section_bodies_quota() FROM PUBLIC`,
    sql`CREATE TRIGGER technical_plan_section_bodies_quota BEFORE INSERT OR UPDATE OF html ON technical_plan_section_bodies
          FOR EACH ROW EXECUTE FUNCTION technical_plan_section_bodies_quota()`,

    // 配额函数：bidtools_storage 只读本表配额要用的列；以它的身份重建（CREATE OR REPLACE 需要 schema 的 CREATE 权限，用完收回）。
    sql`GRANT SELECT (org_id, project_id, html) ON technical_plan_section_bodies TO ${storage}`,
    sql`CREATE POLICY technical_plan_section_bodies_storage_usage ON technical_plan_section_bodies FOR SELECT TO ${storage} USING (true)`,
    sql`GRANT CREATE ON SCHEMA public TO ${storage}`,
    sql`SET ROLE ${storage}`,
    usageFunction(true, SECTION_BODIES_USAGE),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${storage}`,

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
    // 先恢复 0040 的配额函数（不再引用本表），再删表与函数。表上的策略与列级授权随表删除。
    sql`GRANT CREATE ON SCHEMA public TO ${storage}`,
    sql`SET ROLE ${storage}`,
    usageFunction(true),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${storage}`,
    ...[...TECHNICAL_PLAN_SECTION_BODY_TABLES].reverse().map((table) => sql`DROP TABLE ${sql.id(table)}`),
    sql`DROP FUNCTION technical_plan_section_images_guard()`,
    sql`DROP FUNCTION technical_plan_section_bodies_quota()`,
  ]);
}
