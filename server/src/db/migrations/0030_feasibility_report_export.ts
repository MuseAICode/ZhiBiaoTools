// 可研报告导出 Word 的存储（路线图第 7 步 7.5c；#61 决定事项第 1 项：沿用整本导出的保存规则——每个项目只保留最近一次、
// 7 天后由清理任务删除、计入组织存储配额）。导出任务（7.5d）与接口（7.5e）在之后的 PR 中接上，本迁移只建存储，两部分：
//
// 一、产物种类 feasibility-report-export（MIME 为 docx），写法与 0028 的 technical-plan-export 完全相同：
// - 必须属于一个项目、不能有来源文件和样张哈希（CHECK artifacts_owner_present）；可见性与写入沿用 0008 的 RLS 策略（本组织内可见，
//   项目删除后不可见），策略不改；
// - 每个项目只保留最近一次：同一项目中“已完成、未被替换”的可研导出至多一个（部分唯一索引）。新的导出完成时在同一事务中先把旧的
//   标为已被替换，再标记完成（src/artifacts/store.ts 的 PROJECT_SINGLETON_KINDS）；
// - 配额：0008 的配额函数照常计入；
// - 保留期：被替换的立即过期，未被替换的创建 7 天后过期，由清理任务（0024）删除。过期条件写进 0024 的清理函数与只对清理角色
//   生效的 DELETE 策略（同一份表达式，0027 / 0028 的写法）；清理角色的授权不变（0024 已授 created_at、superseded_at，0027 已授 kind）。
//
// 二、项目级表 feasibility_report_export_requests：入队时的快照与导出结果，写法与 0029 的 technical_plan_export_requests 相同：
// - 挂在 kind = 'feasibility-report' 的项目下，(org_id, project_id) 复合外键级联删除；项目已删除时由 RLS 隐藏（与 0017 相同），
//   在本组织内可见；新写入的请求只能由当前用户以自己的身份创建；
// - 快照：项目名称（桌面版取项目信息中的名称）、所选模板规范化后的配置、导出选项（封面、编制说明、附表三个开关，编制单位、密级、
//   文件编号与项目信息）、只含导出用得到的字段的目录（父节点的正文不导出，不放进快照）；
// - 结果只能写一次：唯一的 UPDATE 是“完成”——写入结果产物、提示与消息，同时清空快照中的目录，完成时间由触发器写入；
//   已完成的请求不能再改（FX001）；
// - 每个项目只需要最近一次的请求：应用角色有 DELETE 授权，由 7.5d 在入队后删除本项目的其他请求，不需要清理角色；
// - 结果产物 artifact_id 不设外键：产物 7 天后（或被替换后）由清理任务删除，读取经 findArtifact，删除后即为过期。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, CLEANUP_ROLE } from '../roles.ts';
import { artifactCleanupFunctions, artifactCleanupPolicy, DOCX_MIME, kindMimeCheck, TEMPLATE_PREVIEW_KIND } from './0027_template_preview.ts';
import {
  artifactExpired as artifactExpired0028,
  ARTIFACT_MIMES as ARTIFACT_MIMES_0028,
  PROJECT_SINGLETON_KINDS as PROJECT_SINGLETON_KINDS_0028,
  TECHNICAL_PLAN_EXPORT_KIND,
  TECHNICAL_PLAN_EXPORT_RETENTION_DAYS,
} from './0028_technical_plan_export.ts';
import {
  TECHNICAL_PLAN_EXPORT_FORMAT_MAX_BYTES,
  TECHNICAL_PLAN_EXPORT_MESSAGE_MAX,
  TECHNICAL_PLAN_EXPORT_OUTLINE_MAX_BYTES,
  TECHNICAL_PLAN_EXPORT_WARNINGS_MAX_BYTES,
} from './0029_technical_plan_export_requests.ts';
import { FEASIBILITY_FIELD_MAX } from './0017_feasibility_report.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const cleanup = sql.id(CLEANUP_ROLE);

export const FEASIBILITY_REPORT_EXPORT_KIND = 'feasibility-report-export';
/** 产物种类与允许的 MIME（0028 的种类加上可研导出）。 */
export const ARTIFACT_MIMES = { ...ARTIFACT_MIMES_0028, [FEASIBILITY_REPORT_EXPORT_KIND]: [DOCX_MIME] } as const;
export const ARTIFACT_KINDS = Object.keys(ARTIFACT_MIMES) as (keyof typeof ARTIFACT_MIMES)[];
/** 每个项目只保留最近一个（完成时替换同一项目中的旧产物）的种类。 */
export const PROJECT_SINGLETON_KINDS = [...PROJECT_SINGLETON_KINDS_0028, FEASIBILITY_REPORT_EXPORT_KIND] as const;
/** 可研导出的保留期：与整本导出相同（#61 决定事项第 1 项）。 */
export const FEASIBILITY_REPORT_EXPORT_RETENTION_DAYS = TECHNICAL_PLAN_EXPORT_RETENTION_DAYS;

export const FEASIBILITY_REPORT_EXPORT_REQUESTS_TABLE = 'feasibility_report_export_requests';
/** 快照中目录的字节上限，与整本导出相同（可研目录至多 2,000 个节点、每节正文至多 50 万字）。 */
export const FEASIBILITY_REPORT_EXPORT_OUTLINE_MAX_BYTES = TECHNICAL_PLAN_EXPORT_OUTLINE_MAX_BYTES;
/** 规范化后的导出配置的字节上限，与整本导出相同。 */
export const FEASIBILITY_REPORT_EXPORT_FORMAT_MAX_BYTES = TECHNICAL_PLAN_EXPORT_FORMAT_MAX_BYTES;
/** 导出选项（含项目信息，其中建设内容至多 2 万字）的字节上限。 */
export const FEASIBILITY_REPORT_EXPORT_OPTIONS_MAX_BYTES = 256 * 1024;
/** 结果提示的字节上限，与整本导出相同。 */
export const FEASIBILITY_REPORT_EXPORT_WARNINGS_MAX_BYTES = TECHNICAL_PLAN_EXPORT_WARNINGS_MAX_BYTES;
/** 结果消息的字数上限，与整本导出相同。 */
export const FEASIBILITY_REPORT_EXPORT_MESSAGE_MAX = TECHNICAL_PLAN_EXPORT_MESSAGE_MAX;
/** 项目名称（项目信息中的名称，为空时由桌面版代码用“可行性研究报告”）的字数上限，与项目信息字段相同（0017）。 */
export const FEASIBILITY_REPORT_EXPORT_PROJECT_NAME_MAX = FEASIBILITY_FIELD_MAX;

const RETENTION = sql.raw(`interval '${FEASIBILITY_REPORT_EXPORT_RETENTION_DAYS} days'`);
const FEASIBILITY_EXPORT = sql.lit(FEASIBILITY_REPORT_EXPORT_KIND);
const DOCUMENT_EXPORT = sql.lit(TECHNICAL_PLAN_EXPORT_KIND);
const PREVIEW = sql.lit(TEMPLATE_PREVIEW_KIND);

/** 0028 的过期条件加上“可研导出已被替换，或创建超过 7 天”。 */
export function artifactExpired(a: string): RawBuilder<unknown> {
  const c = (column: string) => sql.ref(`${a}.${column}`);
  return sql`(${artifactExpired0028(a)} OR (${c('kind')} = ${FEASIBILITY_EXPORT}
    AND (${c('superseded_at')} IS NOT NULL OR ${c('created_at')} <= now() - ${RETENTION})))`;
}

/** 0028 的产物归属规则加上可研导出（与整本导出相同：属于项目、没有来源文件与样张哈希）。 */
const OWNER_PRESENT = sql`CHECK (CASE
  WHEN kind = ${PREVIEW} THEN project_id IS NULL AND source_file_id IS NULL AND preview_sha256 IS NOT NULL
  WHEN kind IN (${DOCUMENT_EXPORT}, ${FEASIBILITY_EXPORT}) THEN project_id IS NOT NULL AND source_file_id IS NULL AND preview_sha256 IS NULL
  ELSE (project_id IS NOT NULL OR source_file_id IS NOT NULL) AND preview_sha256 IS NULL
END)`;
const OWNER_PRESENT_0028 = sql`CHECK (CASE
  WHEN kind = ${PREVIEW} THEN project_id IS NULL AND source_file_id IS NULL AND preview_sha256 IS NOT NULL
  WHEN kind = ${DOCUMENT_EXPORT} THEN project_id IS NOT NULL AND source_file_id IS NULL AND preview_sha256 IS NULL
  ELSE (project_id IS NOT NULL OR source_file_id IS NOT NULL) AND preview_sha256 IS NULL
END)`;

const TENANT = sql`org_id = app_current_org_id()`;
/** 所属项目未删除、是可研报告项目（与 0017 的写法相同）。 */
const PROJECT_LIVE = sql`NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = feasibility_report_export_requests.project_id
  AND (p.deleted_at IS NOT NULL OR p.kind <> 'feasibility-report'))`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 一、产物种类。
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_mime`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_mime CHECK (${kindMimeCheck(ARTIFACT_MIMES)})`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_owner_present`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_owner_present ${OWNER_PRESENT}`,
    sql`CREATE UNIQUE INDEX artifacts_feasibility_report_export_current_key ON artifacts (org_id, project_id)
          WHERE kind = ${FEASIBILITY_EXPORT} AND status = 'ready' AND superseded_at IS NULL`,
    // 清理：产物的过期条件加上可研导出（CREATE OR REPLACE 需要 schema 的 CREATE 权限，用完收回）。
    artifactCleanupPolicy(artifactExpired),
    sql`GRANT CREATE ON SCHEMA public TO ${cleanup}`,
    sql`SET ROLE ${cleanup}`,
    ...artifactCleanupFunctions(artifactExpired),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${cleanup}`,

    // 二、请求表。
    sql`CREATE TABLE feasibility_report_export_requests (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          created_by uuid NOT NULL,
          project_name text CHECK (char_length(project_name) BETWEEN 1 AND ${sql.lit(FEASIBILITY_REPORT_EXPORT_PROJECT_NAME_MAX)}),
          export_format jsonb NOT NULL CHECK (jsonb_typeof(export_format) = 'object'
            AND octet_length(export_format::text) <= ${sql.lit(FEASIBILITY_REPORT_EXPORT_FORMAT_MAX_BYTES)}),
          options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'object'
            AND octet_length(options::text) <= ${sql.lit(FEASIBILITY_REPORT_EXPORT_OPTIONS_MAX_BYTES)}),
          outline jsonb CHECK (jsonb_typeof(outline) = 'array' AND jsonb_array_length(outline) > 0
            AND octet_length(outline::text) <= ${sql.lit(FEASIBILITY_REPORT_EXPORT_OUTLINE_MAX_BYTES)}),
          artifact_id uuid,
          warnings jsonb CHECK (jsonb_typeof(warnings) = 'array'
            AND octet_length(warnings::text) <= ${sql.lit(FEASIBILITY_REPORT_EXPORT_WARNINGS_MAX_BYTES)}),
          message text CHECK (char_length(message) BETWEEN 1 AND ${sql.lit(FEASIBILITY_REPORT_EXPORT_MESSAGE_MAX)}),
          created_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz,
          CONSTRAINT feasibility_report_export_requests_project_fkey FOREIGN KEY (org_id, project_id)
            REFERENCES projects (org_id, id) ON DELETE CASCADE,
          -- 未完成：有目录、没有结果；已完成：目录已清空，结果产物、提示与消息齐全。
          CONSTRAINT feasibility_report_export_requests_result_shape CHECK (CASE WHEN completed_at IS NULL
            THEN outline IS NOT NULL AND artifact_id IS NULL AND warnings IS NULL AND message IS NULL
            ELSE outline IS NULL AND artifact_id IS NOT NULL AND warnings IS NOT NULL AND message IS NOT NULL
          END)
        )`,
    sql`CREATE INDEX feasibility_report_export_requests_org_id_project_id_idx
          ON feasibility_report_export_requests (org_id, project_id, created_at)`,
    sql`CREATE FUNCTION feasibility_report_export_requests_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            -- 唯一的 UPDATE 是完成（结果只能写一次）；结果是否齐全由 CHECK result_shape 检查。
            IF OLD.completed_at IS NOT NULL THEN
              RAISE EXCEPTION 'feasibility report export request result is immutable' USING ERRCODE = 'FX001';
            END IF;
            NEW.completed_at := now();
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER feasibility_report_export_requests_guard BEFORE UPDATE ON feasibility_report_export_requests
          FOR EACH ROW EXECUTE FUNCTION feasibility_report_export_requests_guard()`,
    sql`REVOKE ALL ON FUNCTION feasibility_report_export_requests_guard() FROM PUBLIC`,

    sql`ALTER TABLE feasibility_report_export_requests ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE feasibility_report_export_requests FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY feasibility_report_export_requests_select_tenant ON feasibility_report_export_requests FOR SELECT TO ${app}
          USING (${TENANT} AND ${PROJECT_LIVE})`,
    sql`CREATE POLICY feasibility_report_export_requests_insert_tenant ON feasibility_report_export_requests FOR INSERT TO ${app}
          WITH CHECK (${TENANT} AND ${PROJECT_LIVE} AND created_by = app_current_user_id() AND completed_at IS NULL)`,
    sql`CREATE POLICY feasibility_report_export_requests_update_tenant ON feasibility_report_export_requests FOR UPDATE TO ${app}
          USING (${TENANT} AND ${PROJECT_LIVE})
          WITH CHECK (${TENANT})`,
    sql`CREATE POLICY feasibility_report_export_requests_delete_tenant ON feasibility_report_export_requests FOR DELETE TO ${app}
          USING (${TENANT} AND ${PROJECT_LIVE})`,
    sql`GRANT SELECT, DELETE ON feasibility_report_export_requests TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, created_by, project_name, export_format, options, outline)
          ON feasibility_report_export_requests TO ${app}`,
    sql`GRANT UPDATE (outline, artifact_id, warnings, message) ON feasibility_report_export_requests TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`DROP TABLE feasibility_report_export_requests`,
    sql`DROP FUNCTION feasibility_report_export_requests_guard()`,

    sql`GRANT CREATE ON SCHEMA public TO ${cleanup}`,
    sql`SET ROLE ${cleanup}`,
    ...artifactCleanupFunctions(artifactExpired0028),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${cleanup}`,
    artifactCleanupPolicy(artifactExpired0028),
    // 可研导出的行在回滚时删除（只用于开发环境；对象成为孤儿，由清理任务按对象键前缀删除）。表强制 RLS，删除前临时取消强制。
    sql`ALTER TABLE artifacts NO FORCE ROW LEVEL SECURITY`,
    sql`DELETE FROM artifacts WHERE kind = ${FEASIBILITY_EXPORT}`,
    sql`ALTER TABLE artifacts FORCE ROW LEVEL SECURITY`,
    sql`DROP INDEX artifacts_feasibility_report_export_current_key`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_owner_present`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_owner_present ${OWNER_PRESENT_0028}`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_mime`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_mime CHECK (${kindMimeCheck(ARTIFACT_MIMES_0028)})`,
  ]);
}
