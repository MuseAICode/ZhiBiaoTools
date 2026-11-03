// 模板样张的存储（路线图第 7 步 7.3c；第 7 步决定事项第 6 项：样张结果 1 天后删除、计入组织存储配额）。
// 样张任务（7.3d）和接口（7.3e）在之后的 PR 中接上，本迁移只建存储：
//
// 1. 样张产物：artifacts 新增种类 template-preview（MIME 为 docx），它不属于任何项目或来源文件，按“样张输入的哈希”
//    （preview_sha256，重新序列化的样张 HTML 与规范化后的配置，见 src/export/preview.ts）在同一组织内复用最近的结果；
//    - 归属（CHECK artifacts_owner_present）：template-preview 必须没有项目和来源文件、必须有 preview_sha256，其他种类与 0008
//      相同必须属于项目或来源文件、不能有 preview_sha256；
//    - 可见性与写入沿用 0008 的 RLS 策略，策略不改：没有项目和来源文件的行在本组织内可见（与模板相同是组织内共享的配置）；
//    - 配额：0008 的配额函数统计本组织全部 ready 的产物，没有项目和来源文件的行照常计入，函数不改；
//    - 保留期：创建 24 小时后过期，由清理任务（0024）删除，先删对象、再删行。过期条件写进 0024 的清理函数与只对清理角色生效的
//      DELETE 策略（同一份表达式），清理角色只多了 artifacts.kind 的列级 SELECT；过期是单调的（created_at 不变，AR005 禁止
//      登记 24 小时后才完成写入）。复用只取 23 小时内的结果，给下载留出至少 1 小时（src/export/previewStore.ts）。
// 2. 样张请求 template_preview_requests：前端传来的样张经服务端校验、规范化之后的内容（任务参数只放 id，见 0021 的
//    “参数里只放 id 和少量选项”），任务完成后写入结果产物的 id。
//    - 强制 RLS：应用角色只能看到、写入本组织中自己创建的请求（created_by 必须是当前用户），任务以发起用户的身份读取；
//    - 内容写入后不能改（没有列级 UPDATE 授权），artifact_id 只能由空设为一个值一次（触发器，TP001），completed_at 由触发器写入；
//      artifact_id 不设外键：产物的保留期先于引用它的请求结束（复用 23 小时内的结果），读取一律经 RLS 下的 findArtifact，
//      已删除的与不存在的一样；
//    - 没有应用角色的 DELETE 授权；创建 24 小时后由清理函数 cleanup_delete_template_preview_requests 删除（属主 bidtools_cleanup，
//      只授 id、created_at 的列级 SELECT 与 DELETE，DELETE 策略只放行过期的行）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, CLEANUP_ROLE } from '../roles.ts';
import { ARTIFACT_MIMES as ARTIFACT_MIMES_0008 } from './0008_artifacts.ts';
import { artifactExpired as artifactExpired0024, CLEANUP_BATCH_MAX } from './0024_cleanup.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const cleanup = sql.id(CLEANUP_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
const BATCH = sql.raw(`least(greatest(coalesce(p_limit, 1), 1), ${CLEANUP_BATCH_MAX})`);

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const TEMPLATE_PREVIEW_KIND = 'template-preview';
/** 产物种类与允许的 MIME（0008 的种类加上样张）；仍不存 HTML / SVG 等能在浏览器中执行脚本的类型。 */
export const ARTIFACT_MIMES = { ...ARTIFACT_MIMES_0008, [TEMPLATE_PREVIEW_KIND]: [DOCX_MIME] } as const;
export const ARTIFACT_KINDS = Object.keys(ARTIFACT_MIMES) as (keyof typeof ARTIFACT_MIMES)[];
/** 样张产物与样张请求的保留期：创建后 24 小时（决定事项第 6 项“样张结果 1 天后删除”）。 */
export const TEMPLATE_PREVIEW_RETENTION_HOURS = 24;
/** 复用已有样张的时间窗：比保留期短 1 小时，复用的结果至少还能下载 1 小时。 */
export const TEMPLATE_PREVIEW_REUSE_HOURS = TEMPLATE_PREVIEW_RETENTION_HOURS - 1;
/**
 * 样张请求中重新序列化的 HTML 的字节上限。输入不超过 256 KiB（PREVIEW_HTML_MAX_BYTES），重新序列化时转义（如 & → &amp;、
 * 属性中的 " → &quot;）最多放大到 6 倍以内，这里取 2 MiB。
 */
export const TEMPLATE_PREVIEW_HTML_MAX_BYTES = 2 * 1024 * 1024;
/** 样张请求中规范化后的配置（jsonb 的文本形式）的字节上限：模板配置上限（64 KiB）的 2 倍，留给规范化补上的默认字段。 */
export const TEMPLATE_PREVIEW_EXPORT_FORMAT_MAX_BYTES = 128 * 1024;

const RETENTION = sql.raw(`interval '${TEMPLATE_PREVIEW_RETENTION_HOURS} hours'`);
const PREVIEW = sql.lit(TEMPLATE_PREVIEW_KIND);

function kindMimeCheck(mimes: Readonly<Record<string, readonly string[]>>): RawBuilder<unknown> {
  return sql.join(
    Object.entries(mimes).map(([kind, list]) => sql`(kind = ${sql.lit(kind)} AND mime IN (${sql.join(list.map((mime) => sql.lit(mime)))}))`),
    sql` OR `,
  );
}

/** 0024 的过期条件加上“样张创建超过 24 小时”。别名由调用处给出（策略中是表名本身，函数中是别名）。 */
export function artifactExpired(a: string): RawBuilder<unknown> {
  const c = (column: string) => sql.ref(`${a}.${column}`);
  return sql`(${artifactExpired0024(a)} OR (${c('kind')} = ${PREVIEW} AND ${c('created_at')} <= now() - ${RETENTION}))`;
}

function previewRequestExpired(r: string): RawBuilder<unknown> {
  return sql`(${sql.ref(`${r}.created_at`)} <= now() - ${RETENTION})`;
}

/** 清理角色的产物 DELETE 策略与两个产物清理函数（与 0024 的写法相同，只换过期条件）。须在 SET ROLE 清理角色之前与之后分别执行。 */
function artifactCleanupPolicy(expired: (a: string) => RawBuilder<unknown>): RawBuilder<unknown> {
  return sql`ALTER POLICY artifacts_cleanup_delete ON artifacts USING (${expired('artifacts')})`;
}

function artifactCleanupFunctions(expired: (a: string) => RawBuilder<unknown>): RawBuilder<unknown>[] {
  return [
    sql`CREATE OR REPLACE FUNCTION cleanup_artifact_candidates(p_limit integer)
          RETURNS TABLE (id uuid, storage_key text, stale boolean)
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT a.id, a.storage_key, a.status = 'writing' FROM public.artifacts a
            WHERE ${expired('a')}
            ORDER BY a.created_at, a.id
            LIMIT ${BATCH}
          $$`,
    sql`CREATE OR REPLACE FUNCTION cleanup_delete_artifact(p_id uuid) RETURNS boolean
          LANGUAGE sql VOLATILE ${SECURE}
          AS $$
            WITH deleted AS (
              DELETE FROM public.artifacts a WHERE a.id = p_id AND ${expired('a')} RETURNING 1)
            SELECT EXISTS (SELECT 1 FROM deleted)
          $$`,
  ];
}

const OWNER_PRESENT_0008 = sql`CHECK (project_id IS NOT NULL OR source_file_id IS NOT NULL)`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 1. 样张产物。
    sql`ALTER TABLE artifacts ADD COLUMN preview_sha256 bytea CHECK (octet_length(preview_sha256) = 32)`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_mime`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_mime CHECK (${kindMimeCheck(ARTIFACT_MIMES)})`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_owner_present`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_owner_present CHECK (CASE WHEN kind = ${PREVIEW}
          THEN project_id IS NULL AND source_file_id IS NULL AND preview_sha256 IS NOT NULL
          ELSE (project_id IS NOT NULL OR source_file_id IS NOT NULL) AND preview_sha256 IS NULL
        END)`,
    // 按样张输入的哈希查找最近的结果；清理按 created_at 扫描时也用得上。
    sql`CREATE INDEX artifacts_org_id_preview_sha256_idx ON artifacts (org_id, preview_sha256, created_at DESC)
          WHERE kind = ${PREVIEW}`,
    sql`GRANT INSERT (preview_sha256) ON artifacts TO ${app}`,

    // 2. 样张请求。created_by 不设外键，与 projects.created_by 相同。
    sql`CREATE TABLE template_preview_requests (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id),
          created_by uuid NOT NULL,
          input_sha256 bytea NOT NULL CHECK (octet_length(input_sha256) = 32),
          html text NOT NULL CHECK (octet_length(html) BETWEEN 1 AND ${sql.lit(TEMPLATE_PREVIEW_HTML_MAX_BYTES)}),
          export_format jsonb NOT NULL CHECK (jsonb_typeof(export_format) = 'object'
            AND octet_length(export_format::text) <= ${sql.lit(TEMPLATE_PREVIEW_EXPORT_FORMAT_MAX_BYTES)}),
          artifact_id uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz,
          CONSTRAINT template_preview_requests_org_id_id_key UNIQUE (org_id, id),
          CONSTRAINT template_preview_requests_result_shape CHECK ((artifact_id IS NULL) = (completed_at IS NULL))
        )`,
    sql`CREATE INDEX template_preview_requests_created_at_idx ON template_preview_requests (created_at)`,
    sql`CREATE FUNCTION template_preview_requests_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            -- 结果只能由空设为一个产物 id 一次；其他列没有应用角色的 UPDATE 授权。
            IF OLD.artifact_id IS NOT NULL OR NEW.artifact_id IS NULL THEN
              RAISE EXCEPTION 'template preview request result is immutable' USING ERRCODE = 'TP001';
            END IF;
            NEW.completed_at := now();
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER template_preview_requests_guard BEFORE UPDATE ON template_preview_requests
          FOR EACH ROW EXECUTE FUNCTION template_preview_requests_guard()`,
    sql`REVOKE ALL ON FUNCTION template_preview_requests_guard() FROM PUBLIC`,
    sql`ALTER TABLE template_preview_requests ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE template_preview_requests FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY template_preview_requests_select_own ON template_preview_requests FOR SELECT TO ${app}
          USING (org_id = app_current_org_id() AND created_by = app_current_user_id())`,
    sql`CREATE POLICY template_preview_requests_insert_own ON template_preview_requests FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND created_by = app_current_user_id() AND artifact_id IS NULL)`,
    sql`CREATE POLICY template_preview_requests_update_own ON template_preview_requests FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id() AND created_by = app_current_user_id())
          WITH CHECK (org_id = app_current_org_id() AND created_by = app_current_user_id())`,
    sql`GRANT SELECT ON template_preview_requests TO ${app}`,
    sql`GRANT INSERT (org_id, created_by, input_sha256, html, export_format) ON template_preview_requests TO ${app}`,
    sql`GRANT UPDATE (artifact_id) ON template_preview_requests TO ${app}`,

    // 3. 清理：产物的过期条件加上样张，样张请求 24 小时后删除。
    sql`GRANT SELECT (kind) ON artifacts TO ${cleanup}`,
    artifactCleanupPolicy(artifactExpired),
    sql`GRANT SELECT (id, created_at), DELETE ON template_preview_requests TO ${cleanup}`,
    sql`CREATE POLICY template_preview_requests_cleanup_select ON template_preview_requests FOR SELECT TO ${cleanup} USING (true)`,
    sql`CREATE POLICY template_preview_requests_cleanup_delete ON template_preview_requests FOR DELETE TO ${cleanup}
          USING (${previewRequestExpired('template_preview_requests')})`,
    sql`GRANT CREATE ON SCHEMA public TO ${cleanup}`,
    sql`SET ROLE ${cleanup}`,
    ...artifactCleanupFunctions(artifactExpired),
    sql`CREATE FUNCTION cleanup_delete_template_preview_requests(p_limit integer) RETURNS integer
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_count integer;
          BEGIN
            DELETE FROM public.template_preview_requests r WHERE r.id IN (
              SELECT x.id FROM public.template_preview_requests x
              WHERE ${previewRequestExpired('x')}
              ORDER BY x.created_at, x.id
              LIMIT ${BATCH})
              AND ${previewRequestExpired('r')};
            GET DIAGNOSTICS v_count = ROW_COUNT;
            RETURN v_count;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION cleanup_delete_template_preview_requests(integer) FROM PUBLIC`,
    sql`GRANT EXECUTE ON FUNCTION cleanup_delete_template_preview_requests(integer) TO ${app}`,
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${cleanup}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 清理恢复 0024 的过期条件（CREATE OR REPLACE 同样需要 schema 的 CREATE 权限，用完收回）。
    sql`GRANT CREATE ON SCHEMA public TO ${cleanup}`,
    sql`SET ROLE ${cleanup}`,
    sql`DROP FUNCTION cleanup_delete_template_preview_requests(integer)`,
    ...artifactCleanupFunctions(artifactExpired0024),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${cleanup}`,
    artifactCleanupPolicy(artifactExpired0024),
    sql`REVOKE SELECT (kind) ON artifacts FROM ${cleanup}`,

    sql`DROP TABLE template_preview_requests`,
    sql`DROP FUNCTION template_preview_requests_guard()`,

    // 样张产物的行在回滚时删除（只用于开发环境；对象成为孤儿，由清理任务按对象键前缀删除）。表强制 RLS，属主也受策略约束，
    // 删除前临时取消强制。
    sql`ALTER TABLE artifacts NO FORCE ROW LEVEL SECURITY`,
    sql`DELETE FROM artifacts WHERE kind = ${PREVIEW}`,
    sql`ALTER TABLE artifacts FORCE ROW LEVEL SECURITY`,
    sql`REVOKE INSERT (preview_sha256) ON artifacts FROM ${app}`,
    sql`DROP INDEX artifacts_org_id_preview_sha256_idx`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_owner_present`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_owner_present ${OWNER_PRESENT_0008}`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_mime`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_mime CHECK (${kindMimeCheck(ARTIFACT_MIMES_0008)})`,
    sql`ALTER TABLE artifacts DROP COLUMN preview_sha256`,
  ]);
}
