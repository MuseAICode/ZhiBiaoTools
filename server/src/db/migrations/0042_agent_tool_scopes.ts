// Agent 当前阶段可用的业务工具（路线图第 8 步 8.6c1；docs/SERVER_DESIGN.md 第 7.24 节）。
// #91 确认（纵深防御评估选 A）：凡是需要限制的业务工具调用都在 worker 一侧执行。桌面版在 Pi 会话中按业务阶段切换可用的工具
// （setActiveToolsByName / beforeToolCall），Web 版的 Pi 在沙箱中、按攻击者的代码处理——沙箱内的命令可以绕过入口直接调用
// agent-gw 的 POST /v1/tools/call——所以阶段的工具范围由执行者写在这里，工具调用的计数语句（src/agent/tools.ts）原子地检查：
//
// - agent_tool_scopes：每次执行（job_id、run_id）一行，tools 是当前阶段可用的业务工具名（任务类型登记的 agentTools 的子集，
//   由 src/agent/toolScope.ts 在写入前检查）；执行者在发出每条提示词之前写入（新执行没有行，此时所有业务工具都不可用）；
// - 写入与更新只能为本组织 running、run_id 相符且登记了上限的 Agent 任务进行（RLS）：旧执行的行不能再改；
//   应用角色只能写入 org_id、job_id、run_id、tools 与更新 tools、updated_at；没有 DELETE 授权；随任务记录删除；
// - tools 的元素须符合工具名格式（与 0037 相同）、不能为 NULL、至多 AGENT_TOOL_SCOPE_MAX_TOOLS 个（CHECK）。
//
// 不改已有表的 RLS 策略，不新增数据库角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 一个阶段至多可用的业务工具数。 */
export const AGENT_TOOL_SCOPE_MAX_TOOLS = 32;
/**
 * 工具名列表（以逗号连接）的格式：每个元素与 0037 的 AGENT_TOOL_NAME_PATTERN 相同；NULL 元素按 * 连接，不符合格式。
 * 另要求元素中没有逗号（否则 'a1,b2' 这样的一个元素连接后也符合格式）。
 */
const TOOL_LIST_PATTERN = '^[a-z][a-z0-9-]{0,62}[a-z0-9](,[a-z][a-z0-9-]{0,62}[a-z0-9])*$';

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE TABLE agent_tool_scopes (
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          run_id uuid NOT NULL,
          tools text[] NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (job_id, run_id),
          CONSTRAINT agent_tool_scopes_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE,
          CONSTRAINT agent_tool_scopes_tools_check CHECK (
            cardinality(tools) <= ${sql.lit(AGENT_TOOL_SCOPE_MAX_TOOLS)}
            AND (cardinality(tools) = 0
                 OR (array_ndims(tools) = 1
                     AND strpos(array_to_string(tools, ''), ',') = 0
                     AND array_to_string(tools, ',', '*') ~ ${sql.lit(TOOL_LIST_PATTERN)}))
          )
        )`,
    sql`CREATE INDEX agent_tool_scopes_org_id_job_id_idx ON agent_tool_scopes (org_id, job_id)`,

    sql`ALTER TABLE agent_tool_scopes ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_tool_scopes FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY agent_tool_scopes_select_tenant ON agent_tool_scopes FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    // 只能为本组织 running、run_id 相符且登记了上限的 Agent 任务写入（本次执行的阶段）。
    sql`CREATE POLICY agent_tool_scopes_insert_running ON agent_tool_scopes FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id()
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = agent_tool_scopes.org_id AND j.id = agent_tool_scopes.job_id
                          AND j.status = 'running' AND j.run_id = agent_tool_scopes.run_id)
            AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.job_id = agent_tool_scopes.job_id))`,
    // 切换阶段：同样只能改本次执行的行（旧执行的行不能再改）。
    sql`CREATE POLICY agent_tool_scopes_update_running ON agent_tool_scopes FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id()
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = agent_tool_scopes.org_id AND j.id = agent_tool_scopes.job_id
                          AND j.status = 'running' AND j.run_id = agent_tool_scopes.run_id))
          WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT SELECT ON agent_tool_scopes TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, run_id, tools) ON agent_tool_scopes TO ${app}`,
    sql`GRANT UPDATE (tools, updated_at) ON agent_tool_scopes TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`DROP TABLE agent_tool_scopes`]);
}
