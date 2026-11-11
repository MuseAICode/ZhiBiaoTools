// Agent 任务上限按组织覆盖（路线图第 8 步 8.3c，迁移 0035_agent_job_limit_overrides；#70 决定事项第 10 项 b）。
// 平台管理员为某个组织的某个 Agent 任务类型另设费用与轮数上限，入队时取覆盖值（src/agent/budget.ts 的 insertAgentJobBudget）。
// 读写都经平台管理员的 SECURITY DEFINER 函数：是否平台管理员由数据库函数校验，操作人取 context.userId；应用角色对表没有写授权。
// 覆盖只影响之后入队的任务。
import { sql, type Kysely } from 'kysely';
import { toBillingError } from '../billing/ledger.ts';
import type { Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import type { AgentTaskLimits } from './budget.ts';

export interface AgentLimitOverride extends AgentTaskLimits {
  jobType: string;
  note: string | null;
  updatedBy: string;
  updatedAt: Date;
}

interface OverrideRow {
  job_type: string;
  cost_limit: string;
  turn_limit: number;
  note: string | null;
  updated_by: string;
  updated_at: Date;
}

function toOverride(row: OverrideRow): AgentLimitOverride {
  return {
    jobType: row.job_type,
    costLimit: BigInt(row.cost_limit),
    turnLimit: row.turn_limit,
    note: row.note,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toBillingError(error);
  }
}

/** 设置（新建或替换）覆盖值。组织不存在 404 ORGANIZATION_NOT_FOUND；不是平台管理员 403。任务类型是否登记由调用方检查。 */
export async function setAgentLimitOverride(
  db: Kysely<Database>,
  context: TenantContext,
  input: { orgId: string; jobType: string; limits: AgentTaskLimits; note: string | null },
): Promise<AgentLimitOverride> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<OverrideRow>`
        SELECT job_type, cost_limit, turn_limit, note, updated_by, updated_at FROM agent_admin_set_limit_override(
          ${input.orgId}::uuid, ${input.jobType}, ${input.limits.costLimit.toString()}::bigint, ${input.limits.turnLimit}::integer, ${input.note})`.execute(trx);
      return toOverride(result.rows[0]!);
    }),
  );
}

/** 删除覆盖值（恢复起步值）。返回是否删除了一行。 */
export async function deleteAgentLimitOverride(db: Kysely<Database>, context: TenantContext, input: { orgId: string; jobType: string }): Promise<boolean> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<{ deleted: boolean }>`
        SELECT agent_admin_delete_limit_override(${input.orgId}::uuid, ${input.jobType}) AS deleted`.execute(trx);
      return result.rows[0]!.deleted;
    }),
  );
}

/** 列出某个组织的全部覆盖值。组织不存在 404 ORGANIZATION_NOT_FOUND。 */
export async function listAgentLimitOverrides(db: Kysely<Database>, context: TenantContext, orgId: string): Promise<AgentLimitOverride[]> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<OverrideRow>`
        SELECT job_type, cost_limit, turn_limit, note, updated_by, updated_at FROM agent_admin_list_limit_overrides(${orgId}::uuid)`.execute(trx);
      return result.rows.map(toOverride);
    }),
  );
}
