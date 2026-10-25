// 任务队列（docs/SERVER_DESIGN.md 第 5 节；路线图第 6 步 6.2）：jobs 是任务状态的唯一权威，BullMQ（Redis）只负责派发；
// job_events 取代桌面版的 task_logs，只追加。
//
// Redis（Valkey）不持久化（第 8.4 节），重启或被清空后队列里的内容全部丢失，所以：
// - 入队先写 jobs（status = 'queued'），提交后才放进 BullMQ；放不进去也不要紧，worker 的对账会把仍是 queued 的任务重新放进去；
// - BullMQ 的任务 id 就是 jobs.id，重复放入是空操作；同一任务被派发多次时，只有把 queued 改成 running 的那一次认领成功；
// - 认领时生成 run_id、写入租约 lease_expires_at，执行中定期续租；之后的写入（进度、checkpoint、结束）都带 run_id 条件，
//   租约过期被收回后，原来的执行者再写入只影响 0 行（隔离令牌），同一任务不会有两个执行者同时生效；
// - 租约过期的任务由对账按任务类型处理：可续跑的回到 queued（从 checkpoint 继续），不可续跑的标为 failed。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织（app.org_id）的任务和事件；新建时 user_id 必须是当前用户、状态必须是 queued；
//   org_id、project_id、user_id、type、lock_key、params 写入后不能改（没有列级 UPDATE 授权）；没有 DELETE 授权；
// - 互斥：同一组织内 lock_key 相同的未结束任务（queued / running / paused / cancelling）最多一个（部分唯一索引）；
// - 已结束（succeeded / failed / cancelled）的任务不能再改（JB001）；状态与 run_id、租约、结束时间、错误的组合由 CHECK 约束；
// - project_id 可空（组织级任务，如知识库、清理）；不空时由复合外键保证属于本组织，新建时项目必须未删除；
// - job_events 只追加：应用角色只有 SELECT、INSERT；以复合外键挂在同一组织的任务上。
//
// 跨组织对账：jobs_dispatch_candidates 是 SECURITY DEFINER 函数，属主为新角色 bidtools_jobs（NOLOGIN、无 BYPASSRLS），
// 只返回未结束任务的 id 和组织 id（不返回类型、参数、状态等内容），每个任务之后的处理仍按其组织的上下文经 RLS 进行。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, JOBS_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const jobsRole = sql.id(JOBS_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

export const JOB_STATUSES = ['queued', 'running', 'paused', 'cancelling', 'succeeded', 'failed', 'cancelled'] as const;
/** 未结束的状态：持有互斥锁（lock_key）。 */
export const JOB_ACTIVE_STATUSES = ['queued', 'running', 'paused', 'cancelling'] as const;
/** 有执行者（run_id、租约）的状态。 */
export const JOB_RUN_STATUSES = ['running', 'cancelling'] as const;
export const JOB_FINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

export const JOB_EVENT_KINDS = [
  'queued',
  'started',
  'log',
  'pause-requested',
  'paused',
  'resumed',
  'cancel-requested',
  'cancelled',
  'succeeded',
  'failed',
  'recovered',
  'released',
] as const;

/** 任务类型：小写字母开头，只含小写字母、数字和连字符（沿用桌面版 taskDefinitions 的键，如 bid-analysis）。 */
export const JOB_TYPE_PATTERN = '^[a-z][a-z0-9-]{0,63}$';
export const JOB_LOCK_KEY_MAX_LENGTH = 200;
/** 任务参数只放 id 和少量选项，不放凭据和正文。 */
export const JOB_PARAMS_MAX_BYTES = 16 * 1024;
export const JOB_CHECKPOINT_MAX_BYTES = 1024 * 1024;
export const JOB_ERROR_MESSAGE_MAX_LENGTH = 500;
export const JOB_EVENT_MESSAGE_MAX_LENGTH = 1000;
export const JOB_EVENT_DATA_MAX_BYTES = 4096;
/** 对账一次最多返回的任务数。 */
export const JOB_DISPATCH_BATCH_MAX = 1000;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

function jsonObject(column: string, maxBytes: number): RawBuilder<unknown> {
  const c = sql.id(column);
  return sql`jsonb_typeof(${c}) = 'object' AND octet_length(${c}::text) <= ${sql.lit(maxBytes)}`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // org_id 外键不级联，与 projects 相同。user_id 不设外键，与 projects.created_by 相同。
    // 项目被清理任务物理删除时，其下任务随之删除（任务记录本来就有保留期，用量记录只保留 job_id 的值，见决定事项第 10 项）。
    sql`CREATE TABLE jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id),
          project_id uuid,
          user_id uuid NOT NULL,
          type text NOT NULL CHECK (type ~ ${sql.lit(JOB_TYPE_PATTERN)}),
          lock_key text CHECK (char_length(lock_key) BETWEEN 1 AND ${sql.lit(JOB_LOCK_KEY_MAX_LENGTH)}),
          status text NOT NULL DEFAULT 'queued' CHECK (status IN (${list(JOB_STATUSES)})),
          pause_requested boolean NOT NULL DEFAULT false,
          progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
          params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (${jsonObject('params', JOB_PARAMS_MAX_BYTES)}),
          checkpoint jsonb CHECK (${jsonObject('checkpoint', JOB_CHECKPOINT_MAX_BYTES)}),
          error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
          error_message text CHECK (char_length(error_message) BETWEEN 1 AND ${sql.lit(JOB_ERROR_MESSAGE_MAX_LENGTH)}),
          attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
          run_id uuid,
          lease_expires_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          started_at timestamptz,
          finished_at timestamptz,
          CONSTRAINT jobs_org_id_id_key UNIQUE (org_id, id),
          CONSTRAINT jobs_project_fkey FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE,
          CONSTRAINT jobs_run_shape CHECK (
            (status IN (${list(JOB_RUN_STATUSES)})) = (run_id IS NOT NULL) AND (run_id IS NULL) = (lease_expires_at IS NULL)),
          CONSTRAINT jobs_finished_shape CHECK ((status IN (${list(JOB_FINAL_STATUSES)})) = (finished_at IS NOT NULL)),
          CONSTRAINT jobs_error_shape CHECK (
            (status = 'failed') = (error_code IS NOT NULL) AND (error_code IS NULL) = (error_message IS NULL)),
          CONSTRAINT jobs_pause_shape CHECK (NOT pause_requested OR status = 'running')
        )`,
    sql`CREATE UNIQUE INDEX jobs_org_id_lock_key_active_key ON jobs (org_id, lock_key)
          WHERE lock_key IS NOT NULL AND status IN (${list(JOB_ACTIVE_STATUSES)})`,
    sql`CREATE INDEX jobs_org_id_created_at_idx ON jobs (org_id, created_at DESC)`,
    sql`CREATE INDEX jobs_org_id_project_id_created_at_idx ON jobs (org_id, project_id, created_at DESC) WHERE project_id IS NOT NULL`,
    // 组织级并发计数（认领时）与对账扫描。
    sql`CREATE INDEX jobs_org_id_running_idx ON jobs (org_id) WHERE status IN (${list(JOB_RUN_STATUSES)})`,
    sql`CREATE INDEX jobs_dispatch_idx ON jobs (created_at, id) WHERE status IN ('queued', ${list(JOB_RUN_STATUSES)})`,

    sql`CREATE FUNCTION jobs_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.status IN (${list(JOB_FINAL_STATUSES)}) THEN
              RAISE EXCEPTION 'job is finished' USING ERRCODE = 'JB001';
            END IF;
            NEW.updated_at := now();
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER jobs_guard BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_guard()`,
    sql`REVOKE ALL ON FUNCTION jobs_guard() FROM PUBLIC`,

    sql`ALTER TABLE jobs ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE jobs FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY jobs_select_tenant ON jobs FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    // 项目条件在应用角色的 RLS 下求值，只看得到本组织的项目；跨组织的 project_id 由复合外键报错。
    sql`CREATE POLICY jobs_insert_tenant ON jobs FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND user_id = app_current_user_id() AND status = 'queued'
            AND (project_id IS NULL OR EXISTS (
              SELECT 1 FROM projects p WHERE p.id = jobs.project_id AND p.deleted_at IS NULL)))`,
    sql`CREATE POLICY jobs_update_tenant ON jobs FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id())
          WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT SELECT ON jobs TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, user_id, type, lock_key, params) ON jobs TO ${app}`,
    sql`GRANT UPDATE (status, pause_requested, progress, checkpoint, error_code, error_message, attempt, run_id,
          lease_expires_at, started_at, finished_at) ON jobs TO ${app}`,

    sql`CREATE TABLE job_events (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          kind text NOT NULL CHECK (kind IN (${list(JOB_EVENT_KINDS)})),
          message text CHECK (char_length(message) BETWEEN 1 AND ${sql.lit(JOB_EVENT_MESSAGE_MAX_LENGTH)}),
          data jsonb CHECK (${jsonObject('data', JOB_EVENT_DATA_MAX_BYTES)}),
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT job_events_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE
        )`,
    sql`CREATE INDEX job_events_org_id_job_id_id_idx ON job_events (org_id, job_id, id)`,
    sql`ALTER TABLE job_events ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE job_events FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY job_events_select_tenant ON job_events FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    sql`CREATE POLICY job_events_insert_tenant ON job_events FOR INSERT TO ${app} WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT SELECT ON job_events TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, kind, message, data) ON job_events TO ${app}`,

    // 对账函数的属主 bidtools_jobs：只读，只授函数用到的列；策略只对它生效，应用角色不受影响。
    sql`GRANT USAGE ON SCHEMA public TO ${jobsRole}`,
    sql`GRANT SELECT (id, org_id, status, lease_expires_at, created_at) ON jobs TO ${jobsRole}`,
    sql`CREATE POLICY jobs_dispatch_scan ON jobs FOR SELECT TO ${jobsRole} USING (true)`,
    sql`GRANT CREATE ON SCHEMA public TO ${jobsRole}`,
    sql`SET ROLE ${jobsRole}`,
    // 未结束且需要 worker 处理的任务：queued（可能不在 Redis 中，重新放入），以及租约已过期的 running / cancelling（执行者已失联）。
    // paused 不需要派发。按 (created_at, id) 分页，先入队的先处理。
    sql`CREATE FUNCTION jobs_dispatch_candidates(p_after_created_at timestamptz, p_after_id uuid, p_limit integer)
          RETURNS TABLE (id uuid, org_id uuid, created_at timestamptz)
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT j.id, j.org_id, j.created_at FROM public.jobs j
            WHERE (j.status = 'queued' OR (j.status IN (${list(JOB_RUN_STATUSES)}) AND j.lease_expires_at < now()))
              AND (p_after_created_at IS NULL OR (j.created_at, j.id) > (p_after_created_at, p_after_id))
            ORDER BY j.created_at, j.id
            LIMIT least(greatest(coalesce(p_limit, 1), 1), ${sql.lit(JOB_DISPATCH_BATCH_MAX)})
          $$`,
    sql`REVOKE ALL ON FUNCTION jobs_dispatch_candidates(timestamptz, uuid, integer) FROM PUBLIC`,
    sql`GRANT EXECUTE ON FUNCTION jobs_dispatch_candidates(timestamptz, uuid, integer) TO ${app}`,
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${jobsRole}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`SET ROLE ${jobsRole}`,
    sql`DROP FUNCTION jobs_dispatch_candidates(timestamptz, uuid, integer)`,
    sql`RESET ROLE`,
    sql`DROP TABLE job_events`,
    sql`DROP TABLE jobs`,
    sql`DROP FUNCTION jobs_guard()`,
    sql`REVOKE USAGE ON SCHEMA public FROM ${jobsRole}`,
  ]);
}
