// Agent 当前阶段可用的业务工具（路线图第 8 步 8.6c1，迁移 0042_agent_tool_scopes；docs/SERVER_DESIGN.md 第 7.24 节）。
//
// 桌面版按业务阶段切换 Pi 会话中可用的工具；Web 版的阶段限制在 worker 一侧执行（#91 确认：沙箱内的命令可以绕过入口直接调用
// POST /v1/tools/call，入口按阶段只登记部分桩工具不算控制）。执行者在发出每条提示词之前调用 setAgentToolScope，写下本阶段
// 可用的业务工具；工具调用的计数语句（src/agent/tools.ts 的 beginAgentToolCall）只放行其中的工具，其余 403 AGENT_TOOL_NOT_IN_STAGE、
// 不计入。还没有写下阶段（新执行）时所有业务工具都不可用。
//
// 可用工具的上界仍是任务类型登记的 agentTools（工具名不在其中的一律 404，见 tools.ts）；这里在写入前再检查一次：阶段的工具
// 必须是任务类型登记的工具的子集。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { AGENT_TOOL_NAME_PATTERN } from '../db/migrations/0037_agent_tool_calls.ts';
import { AGENT_TOOL_SCOPE_MAX_TOOLS } from '../db/migrations/0042_agent_tool_scopes.ts';
import type { Database } from '../db/schema.ts';
import { withOrgContext } from '../db/tenant.ts';
import type { RunRef } from '../jobs/store.ts';

export { AGENT_TOOL_SCOPE_MAX_TOOLS };

const TOOL_NAME = new RegExp(AGENT_TOOL_NAME_PATTERN);

/**
 * 写下本次执行当前阶段可用的业务工具（整体替换）。tools 必须是 allowed（任务类型登记的 agentTools）中不重复的工具名，
 * 否则抛 TypeError（执行者的编程错误）。任务不在本次执行中（不是 running、run_id 不符）或不是登记了上限的 Agent 任务时
 * 不写入，返回 false。
 */
export async function setAgentToolScope(db: Kysely<Database>, run: RunRef, tools: readonly string[], allowed: readonly string[]): Promise<boolean> {
  if (!Array.isArray(tools) || tools.length > AGENT_TOOL_SCOPE_MAX_TOOLS || new Set(tools).size !== tools.length) {
    throw new TypeError(`阶段的业务工具必须是至多 ${AGENT_TOOL_SCOPE_MAX_TOOLS} 个不重复的工具名`);
  }
  for (const name of tools) {
    if (typeof name !== 'string' || !TOOL_NAME.test(name) || !allowed.includes(name)) throw new TypeError(`阶段的业务工具 ${String(name)} 不是本任务类型登记的工具`);
  }
  const value = tools.length > 0 ? sql`ARRAY[${sql.join(tools.map((name) => sql`${name}`))}]::text[]` : sql`'{}'::text[]`;
  return withOrgContext(db, run.orgId, async (trx) => {
    const { rows } = await sql<{ job_id: string }>`
      INSERT INTO agent_tool_scopes (org_id, job_id, run_id, tools)
      SELECT ${run.orgId}::uuid, ${run.jobId}::uuid, ${run.runId}::uuid, ${value}
      WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = ${run.orgId}::uuid AND j.id = ${run.jobId}::uuid
                      AND j.status = 'running' AND j.run_id = ${run.runId}::uuid)
        AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.org_id = ${run.orgId}::uuid AND b.job_id = ${run.jobId}::uuid)
      ON CONFLICT (job_id, run_id) DO UPDATE SET tools = EXCLUDED.tools, updated_at = now()
      RETURNING job_id`.execute(trx);
    return rows.length > 0;
  });
}

/** 计数语句中的条件：本次执行当前阶段可用的工具中有 tool（没有写下阶段时为假）。 */
export function inAgentToolScope(jobId: string, runId: string, tool: string): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM agent_tool_scopes s WHERE s.job_id = ${jobId}::uuid AND s.run_id = ${runId}::uuid AND ${tool} = ANY (s.tools))`;
}
