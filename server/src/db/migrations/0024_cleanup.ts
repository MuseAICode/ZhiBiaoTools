// 清理任务（路线图第 6 步 6.8，“决定事项（#23）”第 9、10 项）：跨组织物理删除超过保留期的数据。
//
// - 文件、产物、项目：删除后超过 7 天恢复期（文件 / 产物所属的项目超过恢复期、产物的来源文件超过恢复期、被替换的产物
//   被替换超过 7 天，同样算过期）；遗留的 uploading 文件和 writing 产物：登记超过 24 小时（上传超时）；
// - 任务记录：已结束超过 90 天的 jobs（其 job_events 随之级联删除），创建超过 30 天的 job_events（决定事项第 10 项）；
// - 对象存储中的内容由 worker（src/cleanup/）先删除、确认成功后再调用这里的函数删行；按前缀找出的孤儿对象只经
//   cleanup_unreferenced_keys 判断“没有对应的行”，删除由 worker 按对象的修改时间（超过 7 天）决定。
//
// 不变式由数据库保证，不依赖应用代码：
// - 函数的属主是新角色 bidtools_cleanup（NOLOGIN、无 BYPASSRLS）。删除条件写在函数中，同时写进只对它生效的 DELETE 策略：
//   即使函数写错，它也删不掉恢复期内的行。函数只接受行 id 和批量上限，不接受时间、保留期或组织；传入未过期的 id
//   只影响 0 行；
// - bidtools_cleanup 只对 files、artifacts、projects、jobs、job_events 有列级 SELECT（只有判断条件要用的列）和 DELETE，
//   对计费账本、余额、价格表、用量记录、平台凭据、平台模型以及其他表没有任何授权，也没有为它建的策略。
//   也没有 UPDATE，所以批量删除不用 FOR UPDATE：多个 worker 同时删同一行时，后到的只影响 0 行；
//   项目、文件被删除时级联到项目级表、文档表的外键动作由表属主执行，不需要给它授权；
// - 过期是单调的：恢复期满后不能恢复（FS002、PJ002），被替换、已结束的状态不能撤销（AR003、JB001），
//   本迁移另外禁止在登记 24 小时后才完成上传或写入（FS006、AR005）。所以 worker 删掉对象之后，这一行一定仍然可删，
//   不会留下“行还在、对象已删”的记录；
// - 冻结到期收尾仍是 bidtools_billing 所属的 ai_usage_expire_holds，由 worker 以应用角色调用，不经本角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, CLEANUP_ROLE } from '../roles.ts';
import { FILE_RESTORE_DAYS, ORG_STORAGE_QUOTA_BYTES } from './0006_files.ts';
import { PROJECT_RESTORE_DAYS } from './0007_projects.ts';
import { JOB_FINAL_STATUSES } from './0021_jobs.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const cleanup = sql.id(CLEANUP_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
const QUOTA = sql.lit(ORG_STORAGE_QUOTA_BYTES.toString());

/** 遗留的 uploading 文件、writing 产物：登记后超过这么多小时仍未完成即视为放弃，之后也不能再完成。 */
export const STALE_UPLOAD_HOURS = 24;
/** 被替换的产物保留的天数，与文件、项目的恢复期相同。 */
export const SUPERSEDED_ARTIFACT_DAYS = FILE_RESTORE_DAYS;
/** 已结束的任务保留的天数（决定事项第 10 项）。 */
export const JOB_RETENTION_DAYS = 90;
/** 任务事件保留的天数（决定事项第 10 项）。 */
export const JOB_EVENT_RETENTION_DAYS = 30;
/** 每次调用最多处理的行数 / 对象键数。 */
export const CLEANUP_BATCH_MAX = 1000;

const FILE_WINDOW = sql.raw(`interval '${FILE_RESTORE_DAYS} days'`);
const PROJECT_WINDOW = sql.raw(`interval '${PROJECT_RESTORE_DAYS} days'`);
const SUPERSEDED_WINDOW = sql.raw(`interval '${SUPERSEDED_ARTIFACT_DAYS} days'`);
const STALE_WINDOW = sql.raw(`interval '${STALE_UPLOAD_HOURS} hours'`);
const JOB_WINDOW = sql.raw(`interval '${JOB_RETENTION_DAYS} days'`);
const JOB_EVENT_WINDOW = sql.raw(`interval '${JOB_EVENT_RETENTION_DAYS} days'`);
const BATCH = sql.raw(`least(greatest(coalesce(p_limit, 1), 1), ${CLEANUP_BATCH_MAX})`);

const FINAL_STATUSES = sql.join(JOB_FINAL_STATUSES.map((status) => sql.lit(status)));

// 过期条件。别名由调用处给出：策略中是表名本身，函数中是别名。函数与策略用同一份表达式，二者不会不一致。
function projectExpired(p: string): RawBuilder<unknown> {
  return sql`(${sql.ref(`${p}.deleted_at`)} <= now() - ${PROJECT_WINDOW})`;
}

function projectOfExpired(orgColumn: string, projectColumn: string): RawBuilder<unknown> {
  return sql`EXISTS (SELECT 1 FROM public.projects xp
    WHERE xp.org_id = ${sql.ref(orgColumn)} AND xp.id = ${sql.ref(projectColumn)} AND ${projectExpired('xp')})`;
}

function fileExpired(f: string): RawBuilder<unknown> {
  const c = (column: string) => sql.ref(`${f}.${column}`);
  return sql`((${c('status')} = 'uploaded' AND (${c('deleted_at')} <= now() - ${FILE_WINDOW}
      OR ${projectOfExpired(`${f}.org_id`, `${f}.project_id`)}))
    OR (${c('status')} = 'uploading' AND ${c('created_at')} <= now() - ${STALE_WINDOW}))`;
}

function artifactExpired(a: string): RawBuilder<unknown> {
  const c = (column: string) => sql.ref(`${a}.${column}`);
  return sql`((${c('status')} = 'writing' AND ${c('created_at')} <= now() - ${STALE_WINDOW})
    OR ${c('superseded_at')} <= now() - ${SUPERSEDED_WINDOW}
    OR ${projectOfExpired(`${a}.org_id`, `${a}.project_id`)}
    OR EXISTS (SELECT 1 FROM public.files xf
      WHERE xf.org_id = ${c('org_id')} AND xf.id = ${c('source_file_id')} AND ${fileExpired('xf')}))`;
}

function jobExpired(j: string): RawBuilder<unknown> {
  return sql`(${sql.ref(`${j}.status`)} IN (${FINAL_STATUSES}) AND ${sql.ref(`${j}.finished_at`)} <= now() - ${JOB_WINDOW})`;
}

function jobEventExpired(e: string): RawBuilder<unknown> {
  return sql`(${sql.ref(`${e}.created_at`)} <= now() - ${JOB_EVENT_WINDOW})`;
}

// 外键不级联：产物删完才能删来源文件，文件和产物都删完才能删项目。
function fileFree(f: string): RawBuilder<unknown> {
  return sql`NOT EXISTS (SELECT 1 FROM public.artifacts ya WHERE ya.org_id = ${sql.ref(`${f}.org_id`)} AND ya.source_file_id = ${sql.ref(`${f}.id`)})`;
}

function projectFree(p: string): RawBuilder<unknown> {
  const org = sql.ref(`${p}.org_id`);
  const id = sql.ref(`${p}.id`);
  return sql`NOT EXISTS (SELECT 1 FROM public.files yf WHERE yf.org_id = ${org} AND yf.project_id = ${id})
    AND NOT EXISTS (SELECT 1 FROM public.artifacts ya WHERE ya.org_id = ${org} AND ya.project_id = ${id})`;
}

// 0006 的 files_guard（down 时恢复）。
const FILES_GUARD_0006 = sql`CREATE OR REPLACE FUNCTION files_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_used bigint;
          BEGIN
            IF OLD.status = 'uploaded' THEN
              IF NEW.status <> 'uploaded' OR NEW.mime IS DISTINCT FROM OLD.mime OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
                 OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
                RAISE EXCEPTION 'uploaded file content is immutable' USING ERRCODE = 'FS003';
              END IF;
              IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND OLD.deleted_at <= now() - ${FILE_WINDOW} THEN
                RAISE EXCEPTION 'restore window has expired' USING ERRCODE = 'FS002';
              END IF;
              IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL THEN
                RAISE EXCEPTION 'file is already deleted' USING ERRCODE = 'FS004';
              END IF;
              RETURN NEW;
            END IF;

            IF NEW.deleted_at IS NOT NULL THEN
              RAISE EXCEPTION 'file is not uploaded' USING ERRCODE = 'FS004';
            END IF;
            IF NEW.status = 'uploaded' THEN
              -- 同一组织的上传完成从这里开始串行，持锁到事务结束。
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('files_quota:' || NEW.org_id::text, 0));
              v_used := public.files_org_usage_bytes(NEW.org_id);
              IF v_used + NEW.size_bytes > ${QUOTA}::bigint THEN
                RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'FS001';
              END IF;
              NEW.uploaded_at := now();
            END IF;
            RETURN NEW;
          END
          $$`;

// 0023 的 artifacts_guard（down 时恢复）。
const ARTIFACTS_GUARD_0023 = sql`CREATE OR REPLACE FUNCTION artifacts_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.status = 'ready' THEN
              -- 已完成的产物只允许标为已被替换一次（时间由这里写入），其他列一律不能改。
              IF OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
                 AND NEW.status = OLD.status
                 AND NEW.size_bytes IS NOT DISTINCT FROM OLD.size_bytes
                 AND NEW.sha256 IS NOT DISTINCT FROM OLD.sha256 THEN
                NEW.superseded_at := now();
                RETURN NEW;
              END IF;
              RAISE EXCEPTION 'ready artifact is immutable' USING ERRCODE = 'AR003';
            END IF;
            IF NEW.superseded_at IS NOT NULL THEN
              RAISE EXCEPTION 'only ready artifacts can be superseded' USING ERRCODE = 'AR003';
            END IF;
            IF NEW.status = 'ready' THEN
              -- 与 files_guard 同一个锁：同一组织的上传完成和产物完成串行，持锁到事务结束。
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('files_quota:' || NEW.org_id::text, 0));
              IF public.files_org_usage_bytes(NEW.org_id) + NEW.size_bytes > ${QUOTA}::bigint THEN
                RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'AR001';
              END IF;
              NEW.completed_at := now();
            END IF;
            RETURN NEW;
          END
          $$`;

const FUNCTIONS = [
  'cleanup_artifact_candidates(integer)',
  'cleanup_delete_artifact(uuid)',
  'cleanup_file_candidates(integer)',
  'cleanup_delete_file(uuid)',
  'cleanup_delete_projects(integer)',
  'cleanup_delete_jobs(integer)',
  'cleanup_delete_job_events(integer)',
  'cleanup_unreferenced_keys(text[])',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 登记超过 24 小时的上传 / 写入不能再完成：清理任务删掉它的对象之后，这一行不会再变成已上传 / 已完成。
    sql`CREATE OR REPLACE FUNCTION files_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_used bigint;
          BEGIN
            IF OLD.status = 'uploaded' THEN
              IF NEW.status <> 'uploaded' OR NEW.mime IS DISTINCT FROM OLD.mime OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
                 OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
                RAISE EXCEPTION 'uploaded file content is immutable' USING ERRCODE = 'FS003';
              END IF;
              IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND OLD.deleted_at <= now() - ${FILE_WINDOW} THEN
                RAISE EXCEPTION 'restore window has expired' USING ERRCODE = 'FS002';
              END IF;
              IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL THEN
                RAISE EXCEPTION 'file is already deleted' USING ERRCODE = 'FS004';
              END IF;
              RETURN NEW;
            END IF;

            IF NEW.deleted_at IS NOT NULL THEN
              RAISE EXCEPTION 'file is not uploaded' USING ERRCODE = 'FS004';
            END IF;
            IF NEW.status = 'uploaded' THEN
              IF OLD.created_at <= now() - ${STALE_WINDOW} THEN
                RAISE EXCEPTION 'upload is stale' USING ERRCODE = 'FS006';
              END IF;
              -- 同一组织的上传完成从这里开始串行，持锁到事务结束。
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('files_quota:' || NEW.org_id::text, 0));
              v_used := public.files_org_usage_bytes(NEW.org_id);
              IF v_used + NEW.size_bytes > ${QUOTA}::bigint THEN
                RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'FS001';
              END IF;
              NEW.uploaded_at := now();
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`CREATE OR REPLACE FUNCTION artifacts_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.status = 'ready' THEN
              -- 已完成的产物只允许标为已被替换一次（时间由这里写入），其他列一律不能改。
              IF OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
                 AND NEW.status = OLD.status
                 AND NEW.size_bytes IS NOT DISTINCT FROM OLD.size_bytes
                 AND NEW.sha256 IS NOT DISTINCT FROM OLD.sha256 THEN
                NEW.superseded_at := now();
                RETURN NEW;
              END IF;
              RAISE EXCEPTION 'ready artifact is immutable' USING ERRCODE = 'AR003';
            END IF;
            IF NEW.superseded_at IS NOT NULL THEN
              RAISE EXCEPTION 'only ready artifacts can be superseded' USING ERRCODE = 'AR003';
            END IF;
            IF NEW.status = 'ready' THEN
              IF OLD.created_at <= now() - ${STALE_WINDOW} THEN
                RAISE EXCEPTION 'artifact write is stale' USING ERRCODE = 'AR005';
              END IF;
              -- 与 files_guard 同一个锁：同一组织的上传完成和产物完成串行，持锁到事务结束。
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('files_quota:' || NEW.org_id::text, 0));
              IF public.files_org_usage_bytes(NEW.org_id) + NEW.size_bytes > ${QUOTA}::bigint THEN
                RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'AR001';
              END IF;
              NEW.completed_at := now();
            END IF;
            RETURN NEW;
          END
          $$`,

    // 清理函数的属主 bidtools_cleanup：只授判断条件要用的列和 DELETE；SELECT 策略看得到全部行（判断“还有没有引用”），
    // DELETE 策略只放行过期的行。策略只对它生效，应用角色不受影响。
    sql`GRANT USAGE ON SCHEMA public TO ${cleanup}`,
    sql`GRANT SELECT (id, org_id, deleted_at), DELETE ON projects TO ${cleanup}`,
    sql`GRANT SELECT (id, org_id, project_id, status, created_at, deleted_at, storage_key), DELETE ON files TO ${cleanup}`,
    sql`GRANT SELECT (id, org_id, project_id, source_file_id, status, created_at, superseded_at, storage_key), DELETE
          ON artifacts TO ${cleanup}`,
    sql`GRANT SELECT (id, status, finished_at), DELETE ON jobs TO ${cleanup}`,
    sql`GRANT SELECT (id, created_at), DELETE ON job_events TO ${cleanup}`,
    sql`CREATE POLICY projects_cleanup_select ON projects FOR SELECT TO ${cleanup} USING (true)`,
    sql`CREATE POLICY projects_cleanup_delete ON projects FOR DELETE TO ${cleanup} USING (${projectExpired('projects')})`,
    sql`CREATE POLICY files_cleanup_select ON files FOR SELECT TO ${cleanup} USING (true)`,
    sql`CREATE POLICY files_cleanup_delete ON files FOR DELETE TO ${cleanup} USING (${fileExpired('files')})`,
    sql`CREATE POLICY artifacts_cleanup_select ON artifacts FOR SELECT TO ${cleanup} USING (true)`,
    sql`CREATE POLICY artifacts_cleanup_delete ON artifacts FOR DELETE TO ${cleanup} USING (${artifactExpired('artifacts')})`,
    sql`CREATE POLICY jobs_cleanup_select ON jobs FOR SELECT TO ${cleanup} USING (true)`,
    sql`CREATE POLICY jobs_cleanup_delete ON jobs FOR DELETE TO ${cleanup} USING (${jobExpired('jobs')})`,
    sql`CREATE POLICY job_events_cleanup_select ON job_events FOR SELECT TO ${cleanup} USING (true)`,
    sql`CREATE POLICY job_events_cleanup_delete ON job_events FOR DELETE TO ${cleanup} USING (${jobEventExpired('job_events')})`,

    sql`GRANT CREATE ON SCHEMA public TO ${cleanup}`,
    sql`SET ROLE ${cleanup}`,
    // 可以删除的产物（含其对象键）：worker 先删对象，成功后调用 cleanup_delete_artifact。
    sql`CREATE FUNCTION cleanup_artifact_candidates(p_limit integer)
          RETURNS TABLE (id uuid, storage_key text, stale boolean)
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT a.id, a.storage_key, a.status = 'writing' FROM public.artifacts a
            WHERE ${artifactExpired('a')}
            ORDER BY a.created_at, a.id
            LIMIT ${BATCH}
          $$`,
    sql`CREATE FUNCTION cleanup_delete_artifact(p_id uuid) RETURNS boolean
          LANGUAGE sql VOLATILE ${SECURE}
          AS $$
            WITH deleted AS (
              DELETE FROM public.artifacts a WHERE a.id = p_id AND ${artifactExpired('a')} RETURNING 1)
            SELECT EXISTS (SELECT 1 FROM deleted)
          $$`,
    // 可以删除的文件：还挂着产物的不返回（产物先删），以免对象删了、行却因外键删不掉。
    sql`CREATE FUNCTION cleanup_file_candidates(p_limit integer)
          RETURNS TABLE (id uuid, storage_key text, stale boolean)
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT f.id, f.storage_key, f.status = 'uploading' FROM public.files f
            WHERE ${fileExpired('f')} AND ${fileFree('f')}
            ORDER BY f.created_at, f.id
            LIMIT ${BATCH}
          $$`,
    // 文件下的文档行（知识库、资信库图片、各模块的文档表）由外键级联删除。
    sql`CREATE FUNCTION cleanup_delete_file(p_id uuid) RETURNS boolean
          LANGUAGE sql VOLATILE ${SECURE}
          AS $$
            WITH deleted AS (
              DELETE FROM public.files f WHERE f.id = p_id AND ${fileExpired('f')} AND ${fileFree('f')} RETURNING 1)
            SELECT EXISTS (SELECT 1 FROM deleted)
          $$`,
    // 项目没有对象；其下的文件和产物删完后删除，项目级表和任务记录由外键级联删除。
    sql`CREATE FUNCTION cleanup_delete_projects(p_limit integer) RETURNS integer
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_count integer;
          BEGIN
            DELETE FROM public.projects p WHERE p.id IN (
              SELECT x.id FROM public.projects x
              WHERE ${projectExpired('x')} AND ${projectFree('x')}
              ORDER BY x.deleted_at, x.id
              LIMIT ${BATCH})
              AND ${projectExpired('p')} AND ${projectFree('p')};
            GET DIAGNOSTICS v_count = ROW_COUNT;
            RETURN v_count;
          END
          $$`,
    // 已结束超过 90 天的任务，其事件随之级联删除。用量记录只保留 job_id 的值（没有外键），不受影响。
    sql`CREATE FUNCTION cleanup_delete_jobs(p_limit integer) RETURNS integer
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_count integer;
          BEGIN
            DELETE FROM public.jobs j WHERE j.id IN (
              SELECT x.id FROM public.jobs x
              WHERE ${jobExpired('x')}
              ORDER BY x.finished_at, x.id
              LIMIT ${BATCH})
              AND ${jobExpired('j')};
            GET DIAGNOSTICS v_count = ROW_COUNT;
            RETURN v_count;
          END
          $$`,
    sql`CREATE FUNCTION cleanup_delete_job_events(p_limit integer) RETURNS integer
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_count integer;
          BEGIN
            DELETE FROM public.job_events e WHERE e.id IN (
              SELECT x.id FROM public.job_events x
              WHERE ${jobEventExpired('x')}
              ORDER BY x.id
              LIMIT ${BATCH})
              AND ${jobEventExpired('e')};
            GET DIAGNOSTICS v_count = ROW_COUNT;
            RETURN v_count;
          END
          $$`,
    // 孤儿对象：在给定的对象键中，返回形如 org/{org_id}/files/{id} 或 org/{org_id}/artifacts/{id}、却没有对应行的键。
    // 只读；其他形式的键一律不返回（不删除不认识的对象）。
    sql`CREATE FUNCTION cleanup_unreferenced_keys(p_keys text[]) RETURNS SETOF text
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT k.key FROM (
              SELECT DISTINCT key FROM unnest(p_keys[1:${sql.lit(CLEANUP_BATCH_MAX)}]) AS u(key)
              WHERE key ~ '^org/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(files|artifacts)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            ) k
            WHERE NOT EXISTS (SELECT 1 FROM public.files f
                WHERE f.id = split_part(k.key, '/', 4)::uuid AND f.storage_key = k.key)
              AND NOT EXISTS (SELECT 1 FROM public.artifacts a
                WHERE a.id = split_part(k.key, '/', 4)::uuid AND a.storage_key = k.key)
          $$`,
    ...FUNCTIONS.map((signature) => sql`REVOKE ALL ON FUNCTION ${sql.raw(signature)} FROM PUBLIC`),
    ...FUNCTIONS.map((signature) => sql`GRANT EXECUTE ON FUNCTION ${sql.raw(signature)} TO ${app}`),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${cleanup}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`SET ROLE ${cleanup}`,
    ...FUNCTIONS.map((signature) => sql`DROP FUNCTION ${sql.raw(signature)}`),
    sql`RESET ROLE`,
    ...['projects', 'files', 'artifacts', 'jobs', 'job_events'].flatMap((table) => [
      sql`DROP POLICY ${sql.id(`${table}_cleanup_select`)} ON ${sql.id(table)}`,
      sql`DROP POLICY ${sql.id(`${table}_cleanup_delete`)} ON ${sql.id(table)}`,
    ]),
    // 列级授权不随表级 REVOKE 收回，逐一收回。
    sql`REVOKE SELECT (id, org_id, deleted_at), DELETE ON projects FROM ${cleanup}`,
    sql`REVOKE SELECT (id, org_id, project_id, status, created_at, deleted_at, storage_key), DELETE ON files FROM ${cleanup}`,
    sql`REVOKE SELECT (id, org_id, project_id, source_file_id, status, created_at, superseded_at, storage_key), DELETE
          ON artifacts FROM ${cleanup}`,
    sql`REVOKE SELECT (id, status, finished_at), DELETE ON jobs FROM ${cleanup}`,
    sql`REVOKE SELECT (id, created_at), DELETE ON job_events FROM ${cleanup}`,
    sql`REVOKE USAGE ON SCHEMA public FROM ${cleanup}`,
    ARTIFACTS_GUARD_0023,
    FILES_GUARD_0006,
  ]);
}
