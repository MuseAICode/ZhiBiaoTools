// Agent 业务工具的调用次数与频率（路线图第 8 步 8.4a；docs/SERVER_DESIGN.md 第 7.15 节）。
// 被注入的 Agent 可以反复调用业务工具（威胁模型 T5、T6、T8），每个任务对每个工具有调用次数上限与每分钟的频率上限，
// 上限由工具登记时给出（src/agent/tools.ts），本表只计数：
//
// - agent_tool_calls：每个 Agent 任务、每个工具一行。calls 是本任务累计的调用次数（跨执行累计，续跑不清零），
//   window_started_at / window_calls 是当前一分钟窗口的开始时间与窗口内的次数；
// - 计数只经 src/agent/tools.ts 的一条 INSERT ... ON CONFLICT DO UPDATE 原子地进行：任务仍在本次执行中（running、run_id 相符），
//   且未达到次数上限、窗口内未达到频率上限，才加 1；
// - 不变式由触发器检查（AT101）：标识与 created_at 不能改；calls 只能逐次加 1；窗口要么不变（window_calls 加 1），
//   要么前进到 now() 并重新从 1 计数；没有 DELETE 授权（不能借删除记录重置次数）；随任务记录删除；
// - 写入只能为本组织 running 且登记了上限的 Agent 任务进行（RLS），初值取默认值（应用角色只能写入 org_id、job_id、tool）。
//
// 不改已有表的 RLS 策略，不新增数据库角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 工具名的格式（与 src/agent/tools.ts 的登记检查相同）。 */
export const AGENT_TOOL_NAME_PATTERN = '^[a-z][a-z0-9-]{0,62}[a-z0-9]$';

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE TABLE agent_tool_calls (
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          tool text NOT NULL,
          calls integer NOT NULL DEFAULT 1,
          window_started_at timestamptz NOT NULL DEFAULT now(),
          window_calls integer NOT NULL DEFAULT 1,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (job_id, tool),
          CONSTRAINT agent_tool_calls_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE,
          CONSTRAINT agent_tool_calls_tool_check CHECK (tool ~ ${sql.lit(AGENT_TOOL_NAME_PATTERN)}),
          CONSTRAINT agent_tool_calls_counts_check CHECK (calls >= 1 AND window_calls >= 1 AND window_calls <= calls)
        )`,
    sql`CREATE INDEX agent_tool_calls_org_id_job_id_idx ON agent_tool_calls (org_id, job_id)`,

    sql`CREATE FUNCTION agent_tool_calls_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.tool IS DISTINCT FROM OLD.tool
               OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
              RAISE EXCEPTION 'agent tool call identity is immutable' USING ERRCODE = 'AT101';
            END IF;
            IF NEW.calls <> OLD.calls + 1 THEN
              RAISE EXCEPTION 'agent tool calls can only advance by one' USING ERRCODE = 'AT101';
            END IF;
            IF NOT ((NEW.window_started_at = OLD.window_started_at AND NEW.window_calls = OLD.window_calls + 1)
                    OR (NEW.window_started_at = now() AND NEW.window_started_at > OLD.window_started_at AND NEW.window_calls = 1)) THEN
              RAISE EXCEPTION 'agent tool call window can only count up or restart now' USING ERRCODE = 'AT101';
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER agent_tool_calls_guard BEFORE UPDATE ON agent_tool_calls FOR EACH ROW EXECUTE FUNCTION agent_tool_calls_guard()`,
    sql`REVOKE ALL ON FUNCTION agent_tool_calls_guard() FROM PUBLIC`,

    sql`ALTER TABLE agent_tool_calls ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_tool_calls FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY agent_tool_calls_select_tenant ON agent_tool_calls FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    // 第一次调用时写入：只能为本组织 running 且登记了上限的 Agent 任务（run_id 由计数语句检查）。
    sql`CREATE POLICY agent_tool_calls_insert_running ON agent_tool_calls FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id()
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = agent_tool_calls.job_id AND j.status = 'running')
            AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.job_id = agent_tool_calls.job_id))`,
    // 计数：本组织的行（只能加，触发器检查；是否在执行中由计数语句检查）。
    sql`CREATE POLICY agent_tool_calls_update_tenant ON agent_tool_calls FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id())
          WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT SELECT ON agent_tool_calls TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, tool) ON agent_tool_calls TO ${app}`,
    sql`GRANT UPDATE (calls, window_started_at, window_calls) ON agent_tool_calls TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`DROP TABLE agent_tool_calls`, sql`DROP FUNCTION agent_tool_calls_guard()`]);
}
