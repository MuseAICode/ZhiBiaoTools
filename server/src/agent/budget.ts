// Agent 任务的费用与轮数上限（迁移 0033_agent_job_budgets，路线图第 8 步 8.3a；“第 8 步说明”第 4 项）。
//
// - 入队：Agent 任务类型（queue = 'agent'）必须在定义中给出上限（JobTypeDefinition.agentLimits），入队时与任务在同一事务中写入；
// - 费用：ai_usage_begin 在冻结时检查“已扣费 + 本任务未到期的冻结 + 本次冻结 ≤ 费用上限”，否则 TASK_COST_LIMIT、不冻结；
// - 轮数：Agent 的模型调用路由每个请求先经 beginAgentTurn 原子地计入一轮（含取回已保存结果的请求），达到上限时 TASK_TURN_LIMIT，
//   不取回、不冻结、不调用服务商；没有登记上限的任务一律拒绝（不放行没有上限的 Agent 调用）；
// - 达到任一上限后记下原因（exhausted_reason，只能设置一次），之后的请求都被拒绝；执行者据此把任务暂停为 task_cost_limit /
//   task_turn_limit（JobTaskLimitError → finishRun），由发起人或组织管理员确认继续（src/jobs/store.ts 的 confirmTaskLimit，8.3b）：
//   上限各加一份（入队时的上限）、清除原因，改法与确认人由数据库守卫限定（迁移 0034_agent_job_budget_confirm）；
// - 按组织覆盖（8.3c，迁移 0035_agent_job_limit_overrides）：平台管理员可为某组织的某个 Agent 任务类型另设上限
//   （src/agent/limitOverrides.ts），入队时取覆盖值，只影响之后入队的任务。
import { sql, type Kysely, type Transaction } from 'kysely';
import { TASK_COST_LIMIT_CODE, TASK_COST_LIMIT_MESSAGE, UNITS_PER_YUAN } from '../billing/ledger.ts';
import { AGENT_BUDGET_MAX_COST_LIMIT, AGENT_BUDGET_MAX_TURN_LIMIT } from '../db/migrations/0033_agent_job_budgets.ts';
import type { AgentBudgetExhaustedReason, Database } from '../db/schema.ts';
import { withOrgContext, withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { findAgentFailureReport, noAgentFailureReport } from './failureReport.ts';

export { TASK_COST_LIMIT_CODE } from '../billing/ledger.ts';

export interface AgentTaskLimits {
  /** 费用上限（计费单位，0.0001 元）。 */
  costLimit: bigint;
  /** 轮数上限：模型调用请求次数（含取回已保存结果的请求）。 */
  turnLimit: number;
}

const yuan = (value: number) => BigInt(value) * UNITS_PER_YUAN;

/**
 * 各类 Agent 任务的上限起步值（#70 决定事项第 8 项，“第 8 步说明”第 4 项的表）；8.7 按真实任务 P95 的 2 倍重定。
 * 任务类型在 8.7 起登记时按类别取用。
 */
export const AGENT_TASK_LIMITS = Object.freeze({
  /** 正文生成（含配图、AI 生图）。 */
  contentGeneration: Object.freeze({ costLimit: yuan(30), turnLimit: 3_000 }),
  /** 章节重写、原方案还原。 */
  sectionRewrite: Object.freeze({ costLimit: yuan(5), turnLimit: 500 }),
  /** 技术方案目录 / 全局事实生成与调整、可研目录生成与调整。 */
  outline: Object.freeze({ costLimit: yuan(5), turnLimit: 500 }),
  /** 模板提取。 */
  templateExtraction: Object.freeze({ costLimit: yuan(3), turnLimit: 300 }),
} satisfies Record<string, AgentTaskLimits>);

export const TASK_TURN_LIMIT_CODE = 'TASK_TURN_LIMIT';

export function isValidAgentTaskLimits(limits: AgentTaskLimits): boolean {
  return (
    typeof limits.costLimit === 'bigint' &&
    limits.costLimit > 0n &&
    limits.costLimit <= AGENT_BUDGET_MAX_COST_LIMIT &&
    Number.isSafeInteger(limits.turnLimit) &&
    limits.turnLimit > 0 &&
    limits.turnLimit <= AGENT_BUDGET_MAX_TURN_LIMIT
  );
}

/**
 * 入队的同一事务中为任务写入上限（RLS 只允许为本组织 queued 的任务写入）。平台管理员为本组织的该任务类型设置了覆盖值时
 * （迁移 0035，8.3c）取覆盖值，否则取任务类型登记的起步值；“一份”额度由 0034 的写入触发器按写入的上限取值。
 * 返回实际写入的上限。
 */
export async function insertAgentJobBudget(
  trx: Transaction<Database>,
  job: { orgId: string; id: string; type: string },
  defaults: AgentTaskLimits,
): Promise<AgentTaskLimits> {
  if (!isValidAgentTaskLimits(defaults)) throw new TypeError('Agent 任务上限不合法');
  const override = await trx
    .selectFrom('agent_job_limit_overrides')
    .select(['cost_limit', 'turn_limit'])
    .where('org_id', '=', job.orgId)
    .where('job_type', '=', job.type)
    .executeTakeFirst();
  const limits = override ? { costLimit: BigInt(override.cost_limit), turnLimit: override.turn_limit } : defaults;
  await trx
    .insertInto('agent_job_budgets')
    .values({ org_id: job.orgId, job_id: job.id, cost_limit: limits.costLimit.toString(), turn_limit: limits.turnLimit })
    .execute();
  return limits;
}

export interface AgentJobBudget {
  costLimit: bigint;
  turnLimit: number;
  turnsUsed: number;
  exhaustedReason: AgentBudgetExhaustedReason | null;
  /** 本任务已扣费的合计（jobs.billed_amount）。 */
  billedAmount: bigint;
  /** 确认继续时上限各加的一份（入队时的上限，0034）。 */
  costStep: bigint;
  turnStep: number;
  /** 已确认继续的次数。 */
  confirmations: number;
}

async function readBudget(trx: Transaction<Database>, jobId: string): Promise<AgentJobBudget | null> {
  const row = await trx
    .selectFrom('agent_job_budgets as b')
    .innerJoin('jobs as j', (join) => join.onRef('j.org_id', '=', 'b.org_id').onRef('j.id', '=', 'b.job_id'))
    .select(['b.cost_limit', 'b.turn_limit', 'b.turns_used', 'b.exhausted_reason', 'b.cost_step', 'b.turn_step', 'b.confirmations', 'j.billed_amount'])
    .where('b.job_id', '=', jobId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    costLimit: BigInt(row.cost_limit),
    turnLimit: row.turn_limit,
    turnsUsed: row.turns_used,
    exhaustedReason: row.exhausted_reason,
    billedAmount: BigInt(row.billed_amount),
    costStep: BigInt(row.cost_step),
    turnStep: row.turn_step,
    confirmations: row.confirmations,
  };
}

/** 读出任务的上限与用量（worker 的系统操作，按组织上下文）；没有登记时为 null。 */
export async function findAgentJobBudget(db: Kysely<Database>, job: { orgId: string; jobId: string }): Promise<AgentJobBudget | null> {
  return withOrgContext(db, job.orgId, (trx) => readBudget(trx, job.jobId));
}

/** 读出任务的上限与用量（用户请求，按 TenantContext 与 RLS：本组织的任务）；没有登记时为 null。 */
export async function getAgentJobBudget(db: Kysely<Database>, context: TenantContext, jobId: string): Promise<AgentJobBudget | null> {
  return withTenant(db, context, (trx) => readBudget(trx, jobId));
}

/** 达到上限的错误：任务将暂停，由发起人或组织管理员确认继续。 */
export function taskLimitError(reason: AgentBudgetExhaustedReason): AppError {
  return reason === 'task_cost_limit'
    ? new AppError(409, TASK_COST_LIMIT_CODE, TASK_COST_LIMIT_MESSAGE)
    : new AppError(409, TASK_TURN_LIMIT_CODE, '本任务的模型调用次数已达到上限，任务将暂停，由发起人或组织管理员确认后可以继续');
}

export interface AgentTurnRef {
  /** 按令牌查出的身份（不来自请求）。 */
  tenant: TenantContext;
  jobId: string;
  runId: string;
}

/**
 * 计入一轮模型调用请求（含取回已保存结果的请求）。在一条 UPDATE 中原子地检查并递增：任务仍是本次执行（running、run_id 相符）、
 * 本次执行没有报告无法继续（8.4b）、尚未达到任何上限、已用轮数小于上限。达到轮数上限时记下 task_turn_limit 并抛 TASK_TURN_LIMIT；之前已达到任一上限时按该原因拒绝；
 * 没有登记上限时抛 AGENT_BUDGET_MISSING；任务已不在本次执行中时抛 JOB_NOT_RUNNING。都不调用服务商。
 */
export async function beginAgentTurn(db: Kysely<Database>, ref: AgentTurnRef): Promise<{ turnsUsed: number; turnLimit: number }> {
  const outcome = await withTenant(db, ref.tenant, async (trx) => {
    const advanced = await sql<{ turns_used: number; turn_limit: number }>`
      UPDATE agent_job_budgets b SET turns_used = b.turns_used + 1
      WHERE b.org_id = ${ref.tenant.orgId}::uuid AND b.job_id = ${ref.jobId}::uuid
        AND b.exhausted_reason IS NULL AND b.turns_used < b.turn_limit
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = b.org_id AND j.id = b.job_id AND j.status = 'running' AND j.run_id = ${ref.runId}::uuid)
        AND ${noAgentFailureReport(ref.jobId, ref.runId)}
      RETURNING b.turns_used, b.turn_limit`.execute(trx);
    const row = advanced.rows[0];
    if (row) return { kind: 'ok' as const, turnsUsed: row.turns_used, turnLimit: row.turn_limit };

    const current = await trx
      .selectFrom('agent_job_budgets as b')
      .innerJoin('jobs as j', (join) => join.onRef('j.org_id', '=', 'b.org_id').onRef('j.id', '=', 'b.job_id'))
      .select(['b.turns_used', 'b.turn_limit', 'b.exhausted_reason', 'j.status', 'j.run_id'])
      .where('b.job_id', '=', ref.jobId)
      .forUpdate('b')
      .executeTakeFirst();
    if (!current) return { kind: 'missing' as const };
    if (current.status !== 'running' || current.run_id !== ref.runId) return { kind: 'not-running' as const };
    // Agent 已报告无法继续（8.4b）：本次执行即将结束，按不在执行中处理。
    if ((await findAgentFailureReport(trx, ref.jobId, ref.runId)) !== null) return { kind: 'not-running' as const };
    if (current.exhausted_reason !== null) return { kind: 'exhausted' as const, reason: current.exhausted_reason };
    // 只剩“已用轮数达到上限”：记下原因（之后的请求直接按它拒绝）。
    await trx.updateTable('agent_job_budgets').set({ exhausted_reason: 'task_turn_limit' }).where('job_id', '=', ref.jobId).execute();
    return { kind: 'exhausted' as const, reason: 'task_turn_limit' as const };
  });
  switch (outcome.kind) {
    case 'ok':
      return { turnsUsed: outcome.turnsUsed, turnLimit: outcome.turnLimit };
    case 'missing':
      throw new AppError(409, 'AGENT_BUDGET_MISSING', '任务没有登记费用与轮数上限，不能调用模型');
    case 'not-running':
      throw new AppError(409, 'JOB_NOT_RUNNING', '任务不在执行中，不能调用模型');
    case 'exhausted':
      throw taskLimitError(outcome.reason);
  }
}

/**
 * 记下任务已达到上限（冻结时费用上限检查失败后调用）。已经记下过（任一原因）时不改；任务已不在本次执行中时不写。
 * 返回最终记下的原因（没有登记上限、不在执行中时为 null）。
 */
export async function markAgentBudgetExhausted(
  db: Kysely<Database>,
  ref: AgentTurnRef,
  reason: AgentBudgetExhaustedReason,
): Promise<AgentBudgetExhaustedReason | null> {
  return withTenant(db, ref.tenant, async (trx) => {
    await sql`
      UPDATE agent_job_budgets b SET exhausted_reason = ${reason}
      WHERE b.org_id = ${ref.tenant.orgId}::uuid AND b.job_id = ${ref.jobId}::uuid AND b.exhausted_reason IS NULL
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = b.org_id AND j.id = b.job_id AND j.status = 'running' AND j.run_id = ${ref.runId}::uuid)`.execute(trx);
    const row = await trx.selectFrom('agent_job_budgets').select('exhausted_reason').where('job_id', '=', ref.jobId).executeTakeFirst();
    return row?.exhausted_reason ?? null;
  });
}
