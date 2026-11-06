// 技术方案整本导出的请求（路线图第 7 步 7.4f）：入队时取的快照（目录与人工正文、项目名称、模板范围、所选模板规范化后的
// 配置）与导出的结果。整本导出任务（7.4g）只以请求 id 为参数（0021 的约定），从这里读快照，完成后写回结果；
// 任务参数（16 KiB）与 checkpoint（1 MiB）都放不下整本目录，所以单独建表。
//
// - 项目级表（tests/db/fixtures/exampleProjectTable.ts 的写法）：挂在 kind = 'technical-plan' 的项目下，(org_id, project_id)
//   复合外键级联删除；项目已删除时由 RLS 隐藏（与 0018 的技术方案表相同），在本组织内可见（与项目的其他数据、整本导出产物相同）；
// - 新写入的请求只能由当前用户以自己的身份创建（created_by），结果为空；
// - 结果只能写一次：唯一的 UPDATE 就是“完成”——写入结果产物、提示与消息，同时清空快照中的目录（释放空间），完成时间由
//   触发器写入；已完成的请求不能再改（TX001），未完成与已完成两种形态由 CHECK 约束（result_shape）；
// - 保留：每个项目只需要最近一次的请求。应用角色有 DELETE 授权，入队成功后由 7.4g 删除本项目的其他请求（项目的整本导出
//   任务由 lock_key 互斥，此时其他请求的任务都已结束）、入队失败时删除刚保存的请求；项目物理删除时随之删除。
//   因此不需要清理角色，0024 的清理角色与策略都不改；
// - 结果产物 artifact_id 不设外键：整本导出产物 7 天后（或被替换后）由清理任务删除，读取经 findArtifact，删除后即为过期。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES, TECHNICAL_PLAN_TITLE_MAX } from './0018_technical_plan.ts';
import { TEMPLATE_PREVIEW_EXPORT_FORMAT_MAX_BYTES } from './0027_template_preview.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

export const TECHNICAL_PLAN_EXPORT_REQUESTS_TABLE = 'technical_plan_export_requests';
/**
 * 快照中目录（jsonb 的文本形式）的字节上限。目录本身至多 2,000 个节点（TECHNICAL_PLAN_OUTLINE_NODES_MAX），快照只保留导出
 * 用得到的字段与人工正文；64 MiB 远小于 export 入口 request.json 的上限（256 MiB），渲染后的整本 HTML 不会因此超限。
 */
export const TECHNICAL_PLAN_EXPORT_OUTLINE_MAX_BYTES = 64 * 1024 * 1024;
/** 规范化后的导出配置的字节上限，与样张请求相同（0027）。 */
export const TECHNICAL_PLAN_EXPORT_FORMAT_MAX_BYTES = TEMPLATE_PREVIEW_EXPORT_FORMAT_MAX_BYTES;
/** 结果提示（jsonb 字符串数组的文本形式）的字节上限：每个小节至多一条组装提示和一条配图提示。 */
export const TECHNICAL_PLAN_EXPORT_WARNINGS_MAX_BYTES = 4 * 1024 * 1024;
/** 结果消息的字数上限（桌面版 build / exportService 的消息不超过百字）。 */
export const TECHNICAL_PLAN_EXPORT_MESSAGE_MAX = 2000;

const TENANT = sql`org_id = app_current_org_id()`;
/** 所属项目未删除、是技术方案项目（与 0018 的 projectLive 相同）。 */
const PROJECT_LIVE = sql`NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = technical_plan_export_requests.project_id
  AND (p.deleted_at IS NOT NULL OR p.kind <> 'technical-plan'))`;
const SCOPES = sql.join(TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES.map((scope) => sql.lit(scope)));

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE TABLE technical_plan_export_requests (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          created_by uuid NOT NULL,
          project_name text CHECK (char_length(project_name) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_TITLE_MAX)}),
          export_template_scope text NOT NULL CHECK (export_template_scope IN (${SCOPES})),
          export_format jsonb NOT NULL CHECK (jsonb_typeof(export_format) = 'object'
            AND octet_length(export_format::text) <= ${sql.lit(TECHNICAL_PLAN_EXPORT_FORMAT_MAX_BYTES)}),
          outline jsonb CHECK (jsonb_typeof(outline) = 'array' AND jsonb_array_length(outline) > 0
            AND octet_length(outline::text) <= ${sql.lit(TECHNICAL_PLAN_EXPORT_OUTLINE_MAX_BYTES)}),
          artifact_id uuid,
          warnings jsonb CHECK (jsonb_typeof(warnings) = 'array'
            AND octet_length(warnings::text) <= ${sql.lit(TECHNICAL_PLAN_EXPORT_WARNINGS_MAX_BYTES)}),
          message text CHECK (char_length(message) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_EXPORT_MESSAGE_MAX)}),
          created_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz,
          CONSTRAINT technical_plan_export_requests_project_fkey FOREIGN KEY (org_id, project_id)
            REFERENCES projects (org_id, id) ON DELETE CASCADE,
          -- 未完成：有目录、没有结果；已完成：目录已清空，结果产物、提示与消息齐全。
          CONSTRAINT technical_plan_export_requests_result_shape CHECK (CASE WHEN completed_at IS NULL
            THEN outline IS NOT NULL AND artifact_id IS NULL AND warnings IS NULL AND message IS NULL
            ELSE outline IS NULL AND artifact_id IS NOT NULL AND warnings IS NOT NULL AND message IS NOT NULL
          END)
        )`,
    sql`CREATE INDEX technical_plan_export_requests_org_id_project_id_idx
          ON technical_plan_export_requests (org_id, project_id, created_at)`,
    sql`CREATE FUNCTION technical_plan_export_requests_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            -- 唯一的 UPDATE 是完成（结果只能写一次）；结果是否齐全由 CHECK result_shape 检查。
            IF OLD.completed_at IS NOT NULL THEN
              RAISE EXCEPTION 'technical plan export request result is immutable' USING ERRCODE = 'TX001';
            END IF;
            NEW.completed_at := now();
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER technical_plan_export_requests_guard BEFORE UPDATE ON technical_plan_export_requests
          FOR EACH ROW EXECUTE FUNCTION technical_plan_export_requests_guard()`,
    sql`REVOKE ALL ON FUNCTION technical_plan_export_requests_guard() FROM PUBLIC`,

    sql`ALTER TABLE technical_plan_export_requests ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE technical_plan_export_requests FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY technical_plan_export_requests_select_tenant ON technical_plan_export_requests FOR SELECT TO ${app}
          USING (${TENANT} AND ${PROJECT_LIVE})`,
    sql`CREATE POLICY technical_plan_export_requests_insert_tenant ON technical_plan_export_requests FOR INSERT TO ${app}
          WITH CHECK (${TENANT} AND ${PROJECT_LIVE} AND created_by = app_current_user_id() AND completed_at IS NULL)`,
    sql`CREATE POLICY technical_plan_export_requests_update_tenant ON technical_plan_export_requests FOR UPDATE TO ${app}
          USING (${TENANT} AND ${PROJECT_LIVE})
          WITH CHECK (${TENANT})`,
    sql`CREATE POLICY technical_plan_export_requests_delete_tenant ON technical_plan_export_requests FOR DELETE TO ${app}
          USING (${TENANT} AND ${PROJECT_LIVE})`,
    sql`GRANT SELECT, DELETE ON technical_plan_export_requests TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, created_by, project_name, export_template_scope, export_format, outline)
          ON technical_plan_export_requests TO ${app}`,
    sql`GRANT UPDATE (outline, artifact_id, warnings, message) ON technical_plan_export_requests TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`DROP TABLE technical_plan_export_requests`,
    sql`DROP FUNCTION technical_plan_export_requests_guard()`,
  ]);
}
