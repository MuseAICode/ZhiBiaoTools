// 技术方案整本导出的存储（路线图第 7 步 7.4d；第 7 步决定事项第 6 项：整本导出的 docx 每个项目只保留最近一次，
// 7 天后由清理任务删除，计入组织存储配额）。导出任务（7.4e）和接口（7.4f）在之后的 PR 中接上，本迁移只建存储：
//
// - 产物种类 technical-plan-export（MIME 为 docx）：必须属于一个项目、不能有来源文件和样张哈希（CHECK artifacts_owner_present）；
//   可见性与写入沿用 0008 的 RLS 策略（本组织内可见，项目删除后不可见），策略不改；
// - 每个项目只保留最近一次：同一项目中“已完成、未被替换”的整本导出至多一个（部分唯一索引，由数据库保证）。新的导出完成时，
//   在同一事务中先把旧的标为已被替换（0023 的 superseded_at，之后不能撤销），再标记完成（src/artifacts/store.ts）；
//   完成失败（例如超出配额）时整个事务回滚，旧的导出原样保留；
// - 配额：0008 的配额函数统计本组织全部 ready 的产物，整本导出照常计入，已被替换的在清理之前仍计入，函数不改；
// - 保留期：被替换的整本导出立即过期，未被替换的创建 7 天后过期，由清理任务（0024）删除，先删对象、再删行。过期条件写进
//   0024 的清理函数与只对清理角色生效的 DELETE 策略（同一份表达式，0027 的写法），清理角色的授权不变（0024 已授
//   created_at、superseded_at，0027 已授 kind）。过期是单调的：created_at 不变，被替换不能撤销（AR003），AR005 禁止登记
//   24 小时后才完成写入。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { CLEANUP_ROLE } from '../roles.ts';
import {
  artifactCleanupFunctions,
  artifactCleanupPolicy,
  artifactExpired as artifactExpired0027,
  ARTIFACT_MIMES as ARTIFACT_MIMES_0027,
  DOCX_MIME,
  kindMimeCheck,
  OWNER_PRESENT_0027,
  TEMPLATE_PREVIEW_KIND,
} from './0027_template_preview.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const cleanup = sql.id(CLEANUP_ROLE);

export const TECHNICAL_PLAN_EXPORT_KIND = 'technical-plan-export';
/** 产物种类与允许的 MIME（0027 的种类加上整本导出）；仍不存 HTML / SVG 等能在浏览器中执行脚本的类型。 */
export const ARTIFACT_MIMES = { ...ARTIFACT_MIMES_0027, [TECHNICAL_PLAN_EXPORT_KIND]: [DOCX_MIME] } as const;
export const ARTIFACT_KINDS = Object.keys(ARTIFACT_MIMES) as (keyof typeof ARTIFACT_MIMES)[];
/** 每个项目只保留最近一个（完成时替换同一项目中的旧产物）的种类。 */
export const PROJECT_SINGLETON_KINDS = [TECHNICAL_PLAN_EXPORT_KIND] as const;
/** 整本导出的保留期：创建后 7 天（决定事项第 6 项）。 */
export const TECHNICAL_PLAN_EXPORT_RETENTION_DAYS = 7;

const RETENTION = sql.raw(`interval '${TECHNICAL_PLAN_EXPORT_RETENTION_DAYS} days'`);
const EXPORT = sql.lit(TECHNICAL_PLAN_EXPORT_KIND);
const PREVIEW = sql.lit(TEMPLATE_PREVIEW_KIND);

/** 0027 的过期条件加上“整本导出已被替换，或创建超过 7 天”。别名由调用处给出（策略中是表名本身，函数中是别名）。 */
export function artifactExpired(a: string): RawBuilder<unknown> {
  const c = (column: string) => sql.ref(`${a}.${column}`);
  return sql`(${artifactExpired0027(a)} OR (${c('kind')} = ${EXPORT}
    AND (${c('superseded_at')} IS NOT NULL OR ${c('created_at')} <= now() - ${RETENTION})))`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_mime`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_mime CHECK (${kindMimeCheck(ARTIFACT_MIMES)})`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_owner_present`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_owner_present CHECK (CASE
          WHEN kind = ${PREVIEW} THEN project_id IS NULL AND source_file_id IS NULL AND preview_sha256 IS NOT NULL
          WHEN kind = ${EXPORT} THEN project_id IS NOT NULL AND source_file_id IS NULL AND preview_sha256 IS NULL
          ELSE (project_id IS NOT NULL OR source_file_id IS NOT NULL) AND preview_sha256 IS NULL
        END)`,
    // 每个项目至多一个当前的整本导出；按项目查找最近的导出也用它。
    sql`CREATE UNIQUE INDEX artifacts_technical_plan_export_current_key ON artifacts (org_id, project_id)
          WHERE kind = ${EXPORT} AND status = 'ready' AND superseded_at IS NULL`,

    // 清理：产物的过期条件加上整本导出（CREATE OR REPLACE 需要 schema 的 CREATE 权限，用完收回）。
    artifactCleanupPolicy(artifactExpired),
    sql`GRANT CREATE ON SCHEMA public TO ${cleanup}`,
    sql`SET ROLE ${cleanup}`,
    ...artifactCleanupFunctions(artifactExpired),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${cleanup}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`GRANT CREATE ON SCHEMA public TO ${cleanup}`,
    sql`SET ROLE ${cleanup}`,
    ...artifactCleanupFunctions(artifactExpired0027),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${cleanup}`,
    artifactCleanupPolicy(artifactExpired0027),

    // 整本导出的行在回滚时删除（只用于开发环境；对象成为孤儿，由清理任务按对象键前缀删除）。表强制 RLS，属主也受策略约束，
    // 删除前临时取消强制。
    sql`ALTER TABLE artifacts NO FORCE ROW LEVEL SECURITY`,
    sql`DELETE FROM artifacts WHERE kind = ${EXPORT}`,
    sql`ALTER TABLE artifacts FORCE ROW LEVEL SECURITY`,
    sql`DROP INDEX artifacts_technical_plan_export_current_key`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_owner_present`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_owner_present ${OWNER_PRESENT_0027}`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_mime`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_mime CHECK (${kindMimeCheck(ARTIFACT_MIMES_0027)})`,
  ]);
}
