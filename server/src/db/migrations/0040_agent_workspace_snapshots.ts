// Agent 工作区快照的存储（路线图第 8 步 8.5a；拆分计划“5. 工作区”与决定事项第 12、13 项；docs/SERVER_DESIGN.md 第 7.19 节）。
// 中间文件与 Pi 会话文件只用于续跑，存为每个项目、每类任务一个 tar 归档；业务结果另行入库与产物，快照丢失不影响已生成的结果。
// 本迁移只建存储；从沙箱取回与放入（8.5b）、检查点与续跑（8.5c）在之后的 PR 中接上。
//
// 不变式由数据库保证，不依赖应用代码：
// - 对象键是生成列 'org/{org_id}/agent-workspaces/{id}'，id 是数据库生成的随机 UUID，任何角色都不能指定；
// - 快照必须属于本组织的一个项目（复合外键，不级联：对象存储中的内容要先由清理任务删除）；task_kind 是服务端给出的任务类别；
// - 与产物相同分两步写入：先登记 writing（不计入配额）→ 写对象 → 完成时由触发器检查组织存储配额（AW001，与文件、产物共用同一个
//   advisory lock）；登记超过 24 小时不能再完成（AW005）；完成后内容不能再改，只能标为已被替换一次（AW003）；
// - 只保留最近一次：同一项目、同一类任务“已完成、未被替换”的快照至多一个（部分唯一索引）。新快照完成时在同一事务中把旧的标为
//   已被替换（src/agent/workspaceSnapshots.ts），完成失败时整个事务回滚、旧的原样保留；被替换的立即过期；
// - 强制 RLS：应用角色只能看到、写入本组织的行，created_by 必须是当前用户；所属项目已删除的行不可见、不能写；
//   应用角色只能物理删除写入中或已被替换的行（先删对象、再删行，失败时留给清理任务），不能删除当前的快照；
// - 配额（决定事项第 13 项）：0008 的配额函数 files_org_usage_bytes 加上本表已完成的行（项目在恢复期内的照常计入），
//   函数的属主 bidtools_storage 多了本表 4 列的列级 SELECT 与一条只读策略；
// - 清理（0024 的机制）：写入中超过 24 小时、已被替换、或所属项目超过恢复期的行过期，同一份表达式写进新的清理函数与只对清理角色
//   生效的 DELETE 策略；清理角色多了本表的列级 SELECT 与 DELETE。项目要等其下的快照删完才能删除（cleanup_delete_projects），
//   孤儿对象的判断加上本表（cleanup_unreferenced_keys）。过期是单调的：created_at 不变，被替换不能撤销，AW005 禁止登记 24 小时后
//   才完成写入，项目超过恢复期后不能恢复（PJ002）。
//
// 修改了已有的两个定义者角色的函数与授权（bidtools_storage 的配额函数、bidtools_cleanup 的两个清理函数），已有表的 RLS 策略不改。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, CLEANUP_ROLE, STORAGE_ROLE } from '../roles.ts';
import { FILE_RESTORE_DAYS, ORG_STORAGE_QUOTA_BYTES } from './0006_files.ts';
import { PROJECT_RESTORE_DAYS } from './0007_projects.ts';
import {
  CLEANUP_BATCH_MAX,
  cleanupDeleteProjectsFunction,
  cleanupUnreferencedKeysFunction,
  OBJECT_TABLES_0024,
  projectFree as projectFree0024,
  projectOfExpired,
  STALE_UPLOAD_HOURS,
} from './0024_cleanup.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const storage = sql.id(STORAGE_ROLE);
const cleanup = sql.id(CLEANUP_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
const QUOTA = sql.lit(ORG_STORAGE_QUOTA_BYTES.toString());

/** 快照中的文件数上限（决定事项第 13 项）。 */
export const AGENT_WORKSPACE_MAX_FILES = 10_000;
/** 快照中文件内容的合计上限（决定事项第 13 项）：512 MiB。 */
export const AGENT_WORKSPACE_MAX_CONTENT_BYTES = 512 * 1024 * 1024;
/**
 * 归档对象的大小上限：内容合计加上每个文件的 ustar 头部与对齐（至多 1024 字节）和结束块。快照由 worker 按 archive.ts 的写法
 * 重新生成（8.5b），不带扩展头。
 */
export const AGENT_WORKSPACE_MAX_ARCHIVE_BYTES = AGENT_WORKSPACE_MAX_CONTENT_BYTES + AGENT_WORKSPACE_MAX_FILES * 1024 + 1024;
/** 任务类别：2～64 个小写字母、数字与连字符，首尾不能是连字符（与业务工具名的规则相同），由服务端按任务类型给出。 */
export const AGENT_WORKSPACE_TASK_KIND_PATTERN = '^[a-z][a-z0-9-]{0,62}[a-z0-9]$';

const FILE_WINDOW = sql.raw(`interval '${FILE_RESTORE_DAYS} days'`);
const PROJECT_WINDOW = sql.raw(`interval '${PROJECT_RESTORE_DAYS} days'`);
const STALE_WINDOW = sql.raw(`interval '${STALE_UPLOAD_HOURS} hours'`);
const BATCH = sql.raw(`least(greatest(coalesce(p_limit, 1), 1), ${CLEANUP_BATCH_MAX})`);

// 行所属的项目未删除（在应用角色的 RLS 下求值，只看得到本组织的项目）。
const projectLive = sql`NOT EXISTS (
  SELECT 1 FROM projects p WHERE p.id = agent_workspace_snapshots.project_id AND p.deleted_at IS NOT NULL)`;

/** 过期条件。别名由调用处给出（策略中是表名本身，函数中是别名），函数与策略用同一份表达式。 */
export function snapshotExpired(s: string): RawBuilder<unknown> {
  const c = (column: string) => sql.ref(`${s}.${column}`);
  return sql`((${c('status')} = 'writing' AND ${c('created_at')} <= now() - ${STALE_WINDOW})
    OR ${c('superseded_at')} IS NOT NULL
    OR ${projectOfExpired(`${s}.org_id`, `${s}.project_id`)})`;
}

// 项目的文件、产物与快照都删完才能删项目。
function projectFree(p: string): RawBuilder<unknown> {
  return sql`${projectFree0024(p)}
    AND NOT EXISTS (SELECT 1 FROM public.agent_workspace_snapshots ys
      WHERE ys.org_id = ${sql.ref(`${p}.org_id`)} AND ys.project_id = ${sql.ref(`${p}.id`)})`;
}

const OBJECT_TABLES = [...OBJECT_TABLES_0024, { segment: 'agent-workspaces', table: 'agent_workspace_snapshots' }];

/**
 * 配额函数（属主 bidtools_storage）。withSnapshots 为 false 时与 0008 的定义相同（回滚时恢复）。
 * 只统计当前上下文的组织（AR004）；文件、产物与快照合计，所属项目或来源文件超过恢复期的不再计入。
 * extra 是之后的迁移追加的计入项（0046 的 AI 小节正文），以 `+ (...)::bigint` 的形式接在最后；本迁移不传。
 */
export function usageFunction(withSnapshots: boolean, extra: RawBuilder<unknown> = sql``): RawBuilder<unknown> {
  const snapshots = withSnapshots
    ? sql`
              + (SELECT coalesce(sum(s.size_bytes), 0) FROM public.agent_workspace_snapshots s
                 JOIN public.projects p ON p.id = s.project_id
                 WHERE s.org_id = p_org_id AND s.status = 'ready'
                   AND (p.deleted_at IS NULL OR p.deleted_at > now() - ${PROJECT_WINDOW}))::bigint`
    : sql``;
  return sql`CREATE OR REPLACE FUNCTION files_org_usage_bytes(p_org_id uuid) RETURNS bigint
          LANGUAGE plpgsql STABLE ${SECURE}
          AS $$
          DECLARE
            v_used bigint;
          BEGIN
            -- 只统计调用者当前上下文的组织：应用角色不能借它探测别的组织的用量。
            IF p_org_id IS NULL OR p_org_id IS DISTINCT FROM public.app_current_org_id() THEN
              RAISE EXCEPTION 'usage of another organization' USING ERRCODE = 'AR004';
            END IF;
            WITH counted_files AS (
              SELECT f.id, f.size_bytes FROM public.files f
              LEFT JOIN public.projects p ON p.id = f.project_id
              WHERE f.org_id = p_org_id AND f.status = 'uploaded'
                AND (f.deleted_at IS NULL OR f.deleted_at > now() - ${FILE_WINDOW})
                AND (p.deleted_at IS NULL OR p.deleted_at > now() - ${PROJECT_WINDOW})
            )
            SELECT (SELECT coalesce(sum(size_bytes), 0) FROM counted_files)::bigint
              + (SELECT coalesce(sum(a.size_bytes), 0) FROM public.artifacts a
                 LEFT JOIN public.projects p ON p.id = a.project_id
                 WHERE a.org_id = p_org_id AND a.status = 'ready'
                   AND (p.deleted_at IS NULL OR p.deleted_at > now() - ${PROJECT_WINDOW})
                   AND (a.source_file_id IS NULL OR a.source_file_id IN (SELECT id FROM counted_files)))::bigint${snapshots}${extra}
            INTO v_used;
            RETURN v_used;
          END
          $$`;
}

const NEW_CLEANUP_FUNCTIONS = ['cleanup_agent_workspace_candidates(integer)', 'cleanup_delete_agent_workspace(uuid)'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE TABLE agent_workspace_snapshots (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id),
          project_id uuid NOT NULL,
          task_kind text NOT NULL CHECK (task_kind ~ ${sql.lit(AGENT_WORKSPACE_TASK_KIND_PATTERN)}),
          storage_key text GENERATED ALWAYS AS ('org/' || org_id::text || '/agent-workspaces/' || id::text) STORED,
          status text NOT NULL DEFAULT 'writing' CHECK (status IN ('writing', 'ready')),
          size_bytes bigint CHECK (size_bytes BETWEEN 0 AND ${sql.lit(AGENT_WORKSPACE_MAX_ARCHIVE_BYTES)}::bigint),
          file_count integer CHECK (file_count BETWEEN 0 AND ${sql.lit(AGENT_WORKSPACE_MAX_FILES)}),
          sha256 bytea CHECK (octet_length(sha256) = 32),
          created_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz,
          superseded_at timestamptz,
          CONSTRAINT agent_workspace_snapshots_org_id_id_key UNIQUE (org_id, id),
          CONSTRAINT agent_workspace_snapshots_project_fkey FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id),
          CONSTRAINT agent_workspace_snapshots_ready_shape CHECK (CASE status
            WHEN 'ready' THEN size_bytes IS NOT NULL AND file_count IS NOT NULL AND sha256 IS NOT NULL AND completed_at IS NOT NULL
            ELSE size_bytes IS NULL AND file_count IS NULL AND sha256 IS NULL AND completed_at IS NULL AND superseded_at IS NULL
          END)
        )`,
    // 每个项目、每类任务至多一个当前的快照；按项目查找当前的快照也用它。
    sql`CREATE UNIQUE INDEX agent_workspace_snapshots_current_key ON agent_workspace_snapshots (org_id, project_id, task_kind)
          WHERE status = 'ready' AND superseded_at IS NULL`,
    // 清理任务判断“项目下还有没有快照”。
    sql`CREATE INDEX agent_workspace_snapshots_org_id_project_id_idx ON agent_workspace_snapshots (org_id, project_id)`,

    // 状态转换的守卫。普通函数（SECURITY INVOKER）：配额统计经属主为 bidtools_storage 的配额函数，只统计当前组织。
    sql`CREATE FUNCTION agent_workspace_snapshots_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.status = 'ready' THEN
              -- 已完成的快照只允许标为已被替换一次（时间由这里写入），其他列一律不能改。
              IF OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
                 AND NEW.status = OLD.status
                 AND NEW.size_bytes IS NOT DISTINCT FROM OLD.size_bytes
                 AND NEW.file_count IS NOT DISTINCT FROM OLD.file_count
                 AND NEW.sha256 IS NOT DISTINCT FROM OLD.sha256 THEN
                NEW.superseded_at := now();
                RETURN NEW;
              END IF;
              RAISE EXCEPTION 'ready snapshot is immutable' USING ERRCODE = 'AW003';
            END IF;
            IF NEW.superseded_at IS NOT NULL THEN
              RAISE EXCEPTION 'only ready snapshots can be superseded' USING ERRCODE = 'AW003';
            END IF;
            IF NEW.status = 'ready' THEN
              IF OLD.created_at <= now() - ${STALE_WINDOW} THEN
                RAISE EXCEPTION 'snapshot write is stale' USING ERRCODE = 'AW005';
              END IF;
              -- 与 files_guard、artifacts_guard 同一个锁：同一组织的上传完成、产物完成与快照完成串行，持锁到事务结束。
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('files_quota:' || NEW.org_id::text, 0));
              IF public.files_org_usage_bytes(NEW.org_id) + NEW.size_bytes > ${QUOTA}::bigint THEN
                RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'AW001';
              END IF;
              NEW.completed_at := now();
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER agent_workspace_snapshots_guard BEFORE UPDATE ON agent_workspace_snapshots
          FOR EACH ROW EXECUTE FUNCTION agent_workspace_snapshots_guard()`,
    sql`REVOKE ALL ON FUNCTION agent_workspace_snapshots_guard() FROM PUBLIC`,

    sql`ALTER TABLE agent_workspace_snapshots ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_workspace_snapshots FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY agent_workspace_snapshots_select_tenant ON agent_workspace_snapshots FOR SELECT TO ${app}
          USING (org_id = app_current_org_id() AND ${projectLive})`,
    sql`CREATE POLICY agent_workspace_snapshots_insert_tenant ON agent_workspace_snapshots FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND created_by = app_current_user_id() AND status = 'writing' AND ${projectLive})`,
    sql`CREATE POLICY agent_workspace_snapshots_update_tenant ON agent_workspace_snapshots FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id() AND ${projectLive})
          WITH CHECK (org_id = app_current_org_id())`,
    sql`CREATE POLICY agent_workspace_snapshots_delete_tenant ON agent_workspace_snapshots FOR DELETE TO ${app}
          USING (org_id = app_current_org_id() AND (status = 'writing' OR superseded_at IS NOT NULL) AND ${projectLive})`,
    sql`GRANT SELECT, DELETE ON agent_workspace_snapshots TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, task_kind, created_by) ON agent_workspace_snapshots TO ${app}`,
    sql`GRANT UPDATE (status, size_bytes, file_count, sha256, superseded_at) ON agent_workspace_snapshots TO ${app}`,

    // 配额：bidtools_storage 只读本表配额要用的列；以它的身份重建配额函数（CREATE OR REPLACE 需要 schema 的 CREATE 权限，用完收回）。
    sql`GRANT SELECT (org_id, project_id, status, size_bytes) ON agent_workspace_snapshots TO ${storage}`,
    sql`CREATE POLICY agent_workspace_snapshots_storage_usage ON agent_workspace_snapshots FOR SELECT TO ${storage} USING (true)`,
    sql`GRANT CREATE ON SCHEMA public TO ${storage}`,
    sql`SET ROLE ${storage}`,
    usageFunction(true),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${storage}`,

    // 清理：只授判断条件要用的列和 DELETE；DELETE 策略只放行过期的行。
    sql`GRANT SELECT (id, org_id, project_id, status, created_at, superseded_at, storage_key), DELETE
          ON agent_workspace_snapshots TO ${cleanup}`,
    sql`CREATE POLICY agent_workspace_snapshots_cleanup_select ON agent_workspace_snapshots FOR SELECT TO ${cleanup} USING (true)`,
    sql`CREATE POLICY agent_workspace_snapshots_cleanup_delete ON agent_workspace_snapshots FOR DELETE TO ${cleanup}
          USING (${snapshotExpired('agent_workspace_snapshots')})`,
    sql`GRANT CREATE ON SCHEMA public TO ${cleanup}`,
    sql`SET ROLE ${cleanup}`,
    // 可以删除的快照（含其对象键）：worker 先删对象，成功后调用 cleanup_delete_agent_workspace。
    sql`CREATE FUNCTION cleanup_agent_workspace_candidates(p_limit integer)
          RETURNS TABLE (id uuid, storage_key text, stale boolean)
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT s.id, s.storage_key, s.status = 'writing' FROM public.agent_workspace_snapshots s
            WHERE ${snapshotExpired('s')}
            ORDER BY s.created_at, s.id
            LIMIT ${BATCH}
          $$`,
    sql`CREATE FUNCTION cleanup_delete_agent_workspace(p_id uuid) RETURNS boolean
          LANGUAGE sql VOLATILE ${SECURE}
          AS $$
            WITH deleted AS (
              DELETE FROM public.agent_workspace_snapshots s WHERE s.id = p_id AND ${snapshotExpired('s')} RETURNING 1)
            SELECT EXISTS (SELECT 1 FROM deleted)
          $$`,
    cleanupDeleteProjectsFunction('CREATE OR REPLACE', projectFree),
    cleanupUnreferencedKeysFunction('CREATE OR REPLACE', OBJECT_TABLES),
    ...NEW_CLEANUP_FUNCTIONS.map((signature) => sql`REVOKE ALL ON FUNCTION ${sql.raw(signature)} FROM PUBLIC`),
    ...NEW_CLEANUP_FUNCTIONS.map((signature) => sql`GRANT EXECUTE ON FUNCTION ${sql.raw(signature)} TO ${app}`),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${cleanup}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 先恢复引用本表的函数（0024 的两个清理函数、0008 的配额函数），再删新函数与表。表上的策略与列级授权随表删除。
    // 快照的对象在回滚后成为孤儿（只用于开发环境；0024 的孤儿判断不认识这类键，不会删除它们）。
    sql`GRANT CREATE ON SCHEMA public TO ${cleanup}`,
    sql`SET ROLE ${cleanup}`,
    ...NEW_CLEANUP_FUNCTIONS.map((signature) => sql`DROP FUNCTION ${sql.raw(signature)}`),
    cleanupDeleteProjectsFunction('CREATE OR REPLACE', projectFree0024),
    cleanupUnreferencedKeysFunction('CREATE OR REPLACE', OBJECT_TABLES_0024),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${cleanup}`,
    sql`GRANT CREATE ON SCHEMA public TO ${storage}`,
    sql`SET ROLE ${storage}`,
    usageFunction(false),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${storage}`,
    sql`DROP TABLE agent_workspace_snapshots`,
    sql`DROP FUNCTION agent_workspace_snapshots_guard()`,
  ]);
}
