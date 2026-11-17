// Agent 的模型调用被平台拒绝的原因（路线图第 8 步 8.6d3；docs/SERVER_DESIGN.md 第 7.29 节）。
// 沙箱中的模型调用被拒绝时，入口只报告 MODEL_FAILED（沙箱的说法不可信）；8.6d1 的执行者再按组织的可用余额猜测原因，可用余额
// 不低于最低启动余额（1 元）、但不够一次调用的冻结额时会按模型失败重试、最后失败（#96 确认改为精确方案）。这里由模型调用路由
// （src/agent/chatCompletions.ts）在拒绝时记下原因，执行者按记下的原因判断（src/agent/modelRejections.ts）：
//
// - agent_model_rejections：每次执行（job_id、run_id）一行，reason 是**最近一次**被拒绝的原因（insufficient_balance：余额不足以
//   冻结；model_not_configured：组织没有选择模型；model_unavailable：所选模型未登记、已停用、未定价，或服务商 / 网关未配置），
//   rejections 是本次执行被拒绝的次数（每次加 1）：执行者在执行入口之前读出次数，失败后只采信这之后的拒绝，之前的提示词中的
//   拒绝不影响本条提示词；
// - 费用上限（TASK_COST_LIMIT）与轮数上限仍只记在 agent_job_budgets.exhausted_reason（8.3a），不在这里重复；
// - 写入与更新只能为本组织 running、run_id 相符且登记了上限的 Agent 任务进行（RLS）：旧执行的行不能再改；应用角色只能写入
//   org_id、job_id、run_id、reason 与更新 reason、rejections、updated_at；没有 DELETE 授权；随任务记录删除。
//
// 不改已有表的 RLS 策略，不新增数据库角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 记下的拒绝原因。 */
export const AGENT_MODEL_REJECTION_REASONS = ['insufficient_balance', 'model_not_configured', 'model_unavailable'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE TABLE agent_model_rejections (
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          run_id uuid NOT NULL,
          reason text NOT NULL,
          rejections integer NOT NULL DEFAULT 1,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (job_id, run_id),
          CONSTRAINT agent_model_rejections_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE,
          CONSTRAINT agent_model_rejections_reason_check CHECK (reason IN (${sql.join(AGENT_MODEL_REJECTION_REASONS.map((reason) => sql.lit(reason)))})),
          CONSTRAINT agent_model_rejections_rejections_check CHECK (rejections >= 1)
        )`,
    sql`CREATE INDEX agent_model_rejections_org_id_job_id_idx ON agent_model_rejections (org_id, job_id)`,

    sql`ALTER TABLE agent_model_rejections ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_model_rejections FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY agent_model_rejections_select_tenant ON agent_model_rejections FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    // 只能为本组织 running、run_id 相符且登记了上限的 Agent 任务写入（本次执行中的拒绝）。
    sql`CREATE POLICY agent_model_rejections_insert_running ON agent_model_rejections FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id()
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = agent_model_rejections.org_id AND j.id = agent_model_rejections.job_id
                          AND j.status = 'running' AND j.run_id = agent_model_rejections.run_id)
            AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.job_id = agent_model_rejections.job_id))`,
    // 再次被拒绝：同样只能改本次执行的行（旧执行的行不能再改）。
    sql`CREATE POLICY agent_model_rejections_update_running ON agent_model_rejections FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id()
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = agent_model_rejections.org_id AND j.id = agent_model_rejections.job_id
                          AND j.status = 'running' AND j.run_id = agent_model_rejections.run_id))
          WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT SELECT ON agent_model_rejections TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, run_id, reason) ON agent_model_rejections TO ${app}`,
    sql`GRANT UPDATE (reason, rejections, updated_at) ON agent_model_rejections TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`DROP TABLE agent_model_rejections`]);
}
