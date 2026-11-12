// 每组织的 Agent 任务并发与每日运行时长（路线图第 8 步 8.3d；docs/SERVER_DESIGN.md 第 5.3 节、第 9 节第 15 项）。
// 被注入的 Agent 可以长期占用沙箱与模型（威胁模型 T5、T6），因此除了每个任务的费用与轮数上限（0033～0035），每个组织另有：
// - 同时运行的 Agent 任务至多 1 个：认领时检查（src/jobs/store.ts 的 claimJob，同一组织的认领由咨询锁串行），超出的留在 queued 排队；
// - 每日 Agent 运行时长至多 8 小时（按北京时间的自然日）：按本表记下的每次执行的起止时间现算，入队、继续、认领时检查，
//   执行中每次续租时检查，用完即暂停（pause_reason = agent_daily_runtime），次日可继续。
//
// - agent_job_runs：每次执行（run_id）一行，在认领的同一事务中写入（只能为本组织 running、run_id 相符且登记了上限的 Agent 任务写入）；
//   started_at / last_seen_at 取数据库时间（应用角色只能写入 org_id、job_id、run_id）；执行中每次续租把 last_seen_at 推进到 now()，
//   结束时 ended_at = last_seen_at（正常结束为 now()；执行者失联时为最后一次续租的时间，失联的那段不计入）；
//   运行时长 = last_seen_at − started_at，跨天的按自然日切分；
// - 不变式由触发器检查（AR001）：标识与 started_at 不能改；last_seen_at 只能前进、不能超过 now()；ended_at 只能设置一次、
//   之后整行不能再改；没有 DELETE 授权（不能借删除记录重置当日时长）；随任务记录删除（任务只经项目的物理删除被删除，
//   在 7 天恢复期之后，不影响当日的时长）；
// - jobs.pause_reason 新增 agent_daily_runtime。
//
// 不改已有表的 RLS 策略，不新增数据库角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { JOB_PAUSE_REASONS as JOB_PAUSE_REASONS_0033 } from './0033_agent_job_budgets.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 每日 Agent 运行时长用完时的暂停原因。 */
export const AGENT_DAILY_RUNTIME_PAUSE_REASON = 'agent_daily_runtime';
/** 暂停原因：0033 的三个加上每日运行时长用完。 */
export const JOB_PAUSE_REASONS = [...JOB_PAUSE_REASONS_0033, AGENT_DAILY_RUNTIME_PAUSE_REASON] as const;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

function pauseReasonCheck(reasons: readonly string[]): RawBuilder<unknown> {
  return sql`ALTER TABLE jobs ADD CONSTRAINT jobs_pause_reason_check CHECK (pause_reason IN (${list(reasons)}))`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE jobs DROP CONSTRAINT jobs_pause_reason_check`,
    pauseReasonCheck(JOB_PAUSE_REASONS),

    sql`CREATE TABLE agent_job_runs (
          run_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          started_at timestamptz NOT NULL DEFAULT now(),
          last_seen_at timestamptz NOT NULL DEFAULT now(),
          ended_at timestamptz,
          CONSTRAINT agent_job_runs_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE,
          CONSTRAINT agent_job_runs_time_shape CHECK (last_seen_at >= started_at AND (ended_at IS NULL OR ended_at = last_seen_at))
        )`,
    // 当日时长：按组织、结束（或最后一次续租）时间不早于当日开始的执行求和。
    sql`CREATE INDEX agent_job_runs_org_id_last_seen_at_idx ON agent_job_runs (org_id, last_seen_at)`,
    sql`CREATE INDEX agent_job_runs_org_id_job_id_idx ON agent_job_runs (org_id, job_id)`,

    sql`CREATE FUNCTION agent_job_runs_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
               OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
              RAISE EXCEPTION 'agent job run identity is immutable' USING ERRCODE = 'AR001';
            END IF;
            IF OLD.ended_at IS NOT NULL THEN
              RAISE EXCEPTION 'agent job run has ended' USING ERRCODE = 'AR001';
            END IF;
            IF NEW.last_seen_at < OLD.last_seen_at OR NEW.last_seen_at > now() THEN
              RAISE EXCEPTION 'agent job run time can only advance up to now' USING ERRCODE = 'AR001';
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER agent_job_runs_guard BEFORE UPDATE ON agent_job_runs FOR EACH ROW EXECUTE FUNCTION agent_job_runs_guard()`,
    sql`REVOKE ALL ON FUNCTION agent_job_runs_guard() FROM PUBLIC`,

    sql`ALTER TABLE agent_job_runs ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_job_runs FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY agent_job_runs_select_tenant ON agent_job_runs FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    // 只在认领的同一事务中写入：任务已是本次执行（running、run_id 相符），且是登记了上限的 Agent 任务。
    sql`CREATE POLICY agent_job_runs_insert_running ON agent_job_runs FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND ended_at IS NULL
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = agent_job_runs.job_id AND j.status = 'running' AND j.run_id = agent_job_runs.run_id)
            AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.job_id = agent_job_runs.job_id))`,
    // 续租与结束只改未结束的执行（结束后整行不能再改，触发器另外检查）。
    sql`CREATE POLICY agent_job_runs_update_open ON agent_job_runs FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id() AND ended_at IS NULL)
          WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT SELECT ON agent_job_runs TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, run_id) ON agent_job_runs TO ${app}`,
    sql`GRANT UPDATE (last_seen_at, ended_at) ON agent_job_runs TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`DROP TABLE agent_job_runs`,
    sql`DROP FUNCTION agent_job_runs_guard()`,
    // 因每日时长用完而暂停的任务回滚后按手动暂停处理（仍是 paused，可以继续）。做法同 0033 的回滚。
    sql`ALTER TABLE jobs DROP CONSTRAINT jobs_pause_reason_check`,
    sql`ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY`,
    sql`UPDATE jobs SET pause_reason = NULL WHERE pause_reason = ${sql.lit(AGENT_DAILY_RUNTIME_PAUSE_REASON)}`,
    sql`ALTER TABLE jobs FORCE ROW LEVEL SECURITY`,
    pauseReasonCheck(JOB_PAUSE_REASONS_0033),
  ]);
}
