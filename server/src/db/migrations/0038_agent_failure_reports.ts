// Agent 报告无法继续（report-failure，路线图第 8 步 8.4b；docs/SERVER_DESIGN.md 第 7.15 节）。
// 沙箱内的 Agent 经业务工具 report-failure 报告无法按要求继续的原因（src/agent/failureReport.ts），执行者据此结束任务
// （失败，AGENT_REPORTED_FAILURE），原因作为任务的失败说明给用户看：
//
// - agent_failure_reports：每次执行（run_id）至多一行，只记第一次报告；reason 是服务端规范化后的纯文本（1～500 个字符，
//   与 jobs.error_message 的上限相同）；
// - 写入只能为本组织 running 且 run_id 相符、登记了上限的 Agent 任务进行（RLS），应用角色只能写入 org_id、job_id、run_id、reason；
//   没有 UPDATE、DELETE 授权（报告不能被改写或撤回）；随任务记录删除。
//
// 不改已有表的 RLS 策略，不新增数据库角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { JOB_ERROR_MESSAGE_MAX_LENGTH } from './0021_jobs.ts';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 失败原因的最大字符数（与 jobs.error_message 相同，原因原样作为任务的失败说明）。 */
export const AGENT_FAILURE_REASON_MAX_LENGTH = JOB_ERROR_MESSAGE_MAX_LENGTH;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE TABLE agent_failure_reports (
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          run_id uuid NOT NULL,
          reason text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (job_id, run_id),
          CONSTRAINT agent_failure_reports_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE,
          CONSTRAINT agent_failure_reports_reason_check
            CHECK (char_length(reason) BETWEEN 1 AND ${sql.lit(AGENT_FAILURE_REASON_MAX_LENGTH)} AND reason = btrim(reason))
        )`,
    sql`CREATE INDEX agent_failure_reports_org_id_job_id_idx ON agent_failure_reports (org_id, job_id)`,

    sql`ALTER TABLE agent_failure_reports ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_failure_reports FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY agent_failure_reports_select_tenant ON agent_failure_reports FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    // 只能为本组织 running、run_id 相符且登记了上限的 Agent 任务写入（本次执行中的报告）。
    sql`CREATE POLICY agent_failure_reports_insert_running ON agent_failure_reports FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id()
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = agent_failure_reports.org_id AND j.id = agent_failure_reports.job_id
                          AND j.status = 'running' AND j.run_id = agent_failure_reports.run_id)
            AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.job_id = agent_failure_reports.job_id))`,
    sql`GRANT SELECT ON agent_failure_reports TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, run_id, reason) ON agent_failure_reports TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`DROP TABLE agent_failure_reports`]);
}
