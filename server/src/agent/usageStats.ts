// Agent 任务的费用与轮数统计（路线图第 8 步 8.7f1）：为“按真实任务 P95 的 2 倍重定 AGENT_TASK_LIMITS”（#70 决定事项第 8 项，8.7f2）
// 从数据库取出已结束的 Agent 任务的实际用量，按任务类型算出 P50 / P95 / 最大值与建议上限。
//
// - 只读、只读一个组织：经应用角色与 withOrgContext 查询，RLS 只放行该组织的任务与上限（不新增角色、策略或跨组织函数）；
//   测量在专门用于测量的组织中跑真实任务，再对该组织统计；
// - 样本：在时间窗口内成功完成（succeeded，按 finished_at）的任务；轮数取 agent_job_budgets.turns_used（模型调用请求次数，
//   含取回已保存结果的请求，#77 登记给 8.7 的口径），费用取 jobs.billed_amount（已扣费合计）；确认继续过的任务按全部用量计入；
// - 截断：因达到上限而没有成功完成的任务（失败 / 取消且记下过达到上限的原因）不进入样本，只计数（censored）——它们的真实用量
//   至少等于上限，数量不为 0 时 P95 偏低；
// - 建议上限 = P95 的 2 倍：轮数向上取整，费用向上取整到 0.01 元；样本少于 minSamples 时不给建议。
import { sql, type Kysely } from 'kysely';
import { UNITS_PER_YUAN } from '../billing/ledger.ts';
import type { Database } from '../db/schema.ts';
import { withOrgContext } from '../db/tenant.ts';
import { isValidAgentTaskLimits, type AgentTaskLimits } from './budget.ts';

/** 给出建议上限所需的最少样本数（默认）。 */
export const DEFAULT_MIN_SAMPLES = 20;
/** 费用建议值的取整单位：0.01 元。 */
const COST_ROUNDING_UNITS = UNITS_PER_YUAN / 100n;

export interface AgentTaskUsageSample {
  jobType: string;
  turnsUsed: number;
  /** 已扣费合计（计费单位）。 */
  billedAmount: bigint;
  confirmations: number;
}

export interface AgentTaskUsageInput {
  samples: AgentTaskUsageSample[];
  /** 按任务类型：因达到上限而失败 / 取消的任务数。 */
  censored: Map<string, number>;
  /** 本组织的覆盖值（迁移 0035）。 */
  overrides: Map<string, AgentTaskLimits>;
}

export interface Distribution<T> {
  p50: T;
  p95: T;
  max: T;
}

export interface AgentTaskUsageSummary {
  jobType: string;
  samples: number;
  /** 样本中确认继续过的任务数。 */
  confirmed: number;
  censored: number;
  turns: Distribution<number> | null;
  cost: Distribution<bigint> | null;
  /** 任务类型登记的起步值。 */
  defaults: AgentTaskLimits;
  /** 本组织的覆盖值（没有时为 null）。 */
  override: AgentTaskLimits | null;
  /** P95 的 2 倍；样本不足时为 null。 */
  suggested: AgentTaskLimits | null;
}

/** 最近秩法的分位数（p ∈ (0, 1]）：排序后取第 ⌈p·n⌉ 个；没有样本时为 null。 */
export function nearestRank<T extends number | bigint>(values: readonly T[], p: number): T | null {
  if (!(p > 0 && p <= 1)) throw new RangeError('分位数须在 (0, 1] 内');
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.ceil(p * sorted.length) - 1]!;
}

function distribution<T extends number | bigint>(values: readonly T[]): Distribution<T> | null {
  if (values.length === 0) return null;
  return { p50: nearestRank(values, 0.5)!, p95: nearestRank(values, 0.95)!, max: nearestRank(values, 1)! };
}

/** 建议上限：P95 的 2 倍，轮数向上取整、费用向上取整到 0.01 元，至少为 1 轮、0.01 元；超出登记范围时为 null。 */
export function suggestLimits(turnsP95: number, costP95: bigint): AgentTaskLimits | null {
  const turnLimit = Math.max(1, Math.ceil(turnsP95 * 2));
  const doubled = costP95 * 2n;
  const rounded = ((doubled + COST_ROUNDING_UNITS - 1n) / COST_ROUNDING_UNITS) * COST_ROUNDING_UNITS;
  const limits = { costLimit: rounded > 0n ? rounded : COST_ROUNDING_UNITS, turnLimit };
  return isValidAgentTaskLimits(limits) ? limits : null;
}

/**
 * 按任务类型汇总。agentTypes 为登记的 Agent 任务类型与起步值（registry 中 queue = 'agent' 的定义）：每个登记的类型都出现在结果中
 * （没有样本时分布为 null），未登记的类型（已下线的任务类型）的样本忽略。
 */
export function summarizeAgentTaskUsage(
  input: AgentTaskUsageInput,
  agentTypes: ReadonlyMap<string, AgentTaskLimits>,
  options: { minSamples?: number } = {},
): AgentTaskUsageSummary[] {
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  if (!Number.isSafeInteger(minSamples) || minSamples < 1) throw new RangeError('minSamples 须为正整数');
  const byType = new Map<string, AgentTaskUsageSample[]>();
  for (const sample of input.samples) {
    if (!agentTypes.has(sample.jobType)) continue;
    const list = byType.get(sample.jobType) ?? [];
    list.push(sample);
    byType.set(sample.jobType, list);
  }
  return [...agentTypes.keys()].sort().map((jobType) => {
    const samples = byType.get(jobType) ?? [];
    const turns = distribution(samples.map((sample) => sample.turnsUsed));
    const cost = distribution(samples.map((sample) => sample.billedAmount));
    return {
      jobType,
      samples: samples.length,
      confirmed: samples.filter((sample) => sample.confirmations > 0).length,
      censored: input.censored.get(jobType) ?? 0,
      turns,
      cost,
      defaults: agentTypes.get(jobType)!,
      override: input.overrides.get(jobType) ?? null,
      suggested: turns && cost && samples.length >= minSamples ? suggestLimits(turns.p95, cost.p95) : null,
    };
  });
}

export interface UsageWindow {
  /** 只统计 finished_at ≥ since 的任务（含）。 */
  since?: Date;
  /** 只统计 finished_at < until 的任务（不含）。 */
  until?: Date;
}

/** 读出一个组织在时间窗口内的样本、截断数与覆盖值（应用角色，按组织上下文经 RLS）。 */
export async function readAgentTaskUsage(db: Kysely<Database>, orgId: string, jobTypes: readonly string[], window: UsageWindow = {}): Promise<AgentTaskUsageInput> {
  const censored = new Map<string, number>();
  const overrides = new Map<string, AgentTaskLimits>();
  if (jobTypes.length === 0) return { samples: [], censored, overrides };
  return withOrgContext(db, orgId, async (trx) => {
    let finished = trx
      .selectFrom('jobs as j')
      .innerJoin('agent_job_budgets as b', (join) => join.onRef('b.org_id', '=', 'j.org_id').onRef('b.job_id', '=', 'j.id'))
      .where('j.type', 'in', [...jobTypes])
      .where('j.finished_at', 'is not', null);
    if (window.since) finished = finished.where('j.finished_at', '>=', window.since);
    if (window.until) finished = finished.where('j.finished_at', '<', window.until);

    const rows = await finished
      .select(['j.type', 'b.turns_used', 'j.billed_amount', 'b.confirmations'])
      .where('j.status', '=', 'succeeded')
      .execute();
    const censoredRows = await finished
      .select(['j.type', sql<string>`count(*)`.as('count')])
      .where('j.status', 'in', ['failed', 'cancelled'])
      .where('b.exhausted_reason', 'is not', null)
      .groupBy('j.type')
      .execute();
    for (const row of censoredRows) censored.set(row.type, Number(row.count));

    const overrideRows = await trx
      .selectFrom('agent_job_limit_overrides')
      .select(['job_type', 'cost_limit', 'turn_limit'])
      .where('job_type', 'in', [...jobTypes])
      .execute();
    for (const row of overrideRows) overrides.set(row.job_type, { costLimit: BigInt(row.cost_limit), turnLimit: row.turn_limit });

    return {
      samples: rows.map((row) => ({ jobType: row.type, turnsUsed: row.turns_used, billedAmount: BigInt(row.billed_amount), confirmations: row.confirmations })),
      censored,
      overrides,
    };
  });
}

/** 计费单位 → 元的十进制字符串（4 位小数）。 */
export function unitsToYuan(units: bigint): string {
  const negative = units < 0n;
  const value = negative ? -units : units;
  return `${negative ? '-' : ''}${value / UNITS_PER_YUAN}.${(value % UNITS_PER_YUAN).toString().padStart(4, '0')}`;
}

const limitsJson = (limits: AgentTaskLimits | null) => (limits ? { costYuan: unitsToYuan(limits.costLimit), turnLimit: limits.turnLimit } : null);

/** 汇总结果的 JSON 形式（费用换算为元的字符串，bigint 不进 JSON）。 */
export function usageSummaryToJson(summary: AgentTaskUsageSummary): Record<string, unknown> {
  return {
    jobType: summary.jobType,
    samples: summary.samples,
    confirmed: summary.confirmed,
    censored: summary.censored,
    turns: summary.turns,
    costYuan: summary.cost ? { p50: unitsToYuan(summary.cost.p50), p95: unitsToYuan(summary.cost.p95), max: unitsToYuan(summary.cost.max) } : null,
    defaults: limitsJson(summary.defaults),
    override: limitsJson(summary.override),
    suggested: limitsJson(summary.suggested),
  };
}
