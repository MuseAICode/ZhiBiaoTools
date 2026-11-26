// Agent 的模型调用被平台拒绝的原因（路线图第 8 步 8.6d3，迁移 0043_agent_model_rejections；docs/SERVER_DESIGN.md 第 7.29 节）。
//
// 沙箱中的模型调用被拒绝时，入口只报告 MODEL_FAILED（沙箱的说法，不采信）。模型调用路由（src/agent/chatCompletions.ts）在拒绝时
// 按令牌的执行记下原因（recordAgentModelRejection），执行者（src/agent/execution.ts）在执行入口之前读出本次执行被拒绝的次数，
// 入口报告 MODEL_FAILED 后只采信这之后的拒绝（agentModelRejectionSince）：
//
// - insufficient_balance（冻结时余额不足，含可用余额不低于最低启动余额 1 元、但不够一次调用的冻结额）：暂停为
//   insufficient_balance，充值后从 checkpoint 续跑——取代 8.6d1 按可用余额的猜测；
// - model_not_configured（组织没有选择模型）、model_unavailable（所选模型未登记、已停用、未定价，服务商或网关未配置）：需要管理员
//   处理，重试无用，按固定说明失败、不重试；
// - 没有记下拒绝：按模型调用失败（上游失败、超时等）重试，与 8.6d1 相同。
//
// 费用与轮数上限仍只按 agent_job_budgets 判断（8.3a），不在这里记。原因由平台按网关的错误代码决定，不来自沙箱的请求。
import { sql, type Kysely } from 'kysely';
import type { AgentModelRejectionReason, Database } from '../db/schema.ts';
import { withOrgContext, withTenant } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { JobError, JobModelUnavailableError } from '../jobs/definitions.ts';
import type { RunRef } from '../jobs/store.ts';
import type { AgentTurnRef } from './budget.ts';

export type { AgentModelRejectionReason } from '../db/schema.ts';

/** 网关与模型选择的错误代码 → 记下的原因；其余（上游失败、超时、并发、请求不合法、上限等）不记。 */
const REJECTION_BY_CODE: Readonly<Record<string, AgentModelRejectionReason>> = Object.freeze({
  INSUFFICIENT_BALANCE: 'insufficient_balance',
  AI_MODEL_NOT_CONFIGURED: 'model_not_configured',
  AI_GATEWAY_DISABLED: 'model_unavailable',
  AI_MODEL_NOT_REGISTERED: 'model_unavailable',
  AI_MODEL_DISABLED: 'model_unavailable',
  AI_MODEL_NOT_FOUND: 'model_unavailable',
  AI_MODEL_PRICE_CONFLICT: 'model_unavailable',
  MODEL_PRICE_NOT_CONFIGURED: 'model_unavailable',
  AI_PROVIDER_NOT_CONFIGURED: 'model_unavailable',
});

/** 模型调用路由的错误（AppError，或模型选择的 JobError）对应的拒绝原因；不需要记下时为 null。 */
export function agentModelRejectionReason(error: unknown): AgentModelRejectionReason | null {
  if (!(error instanceof AppError) && !(error instanceof JobError)) return null;
  return Object.hasOwn(REJECTION_BY_CODE, error.code) ? REJECTION_BY_CODE[error.code]! : null;
}

/**
 * 执行者自己经 JobAi 调用模型（如长时业务工具 generate-sections，8.10c2b2）时，没有选择模型 / 所选模型不可用的错误 → 与 Agent 的
 * 模型调用相同的暂停（#98 决定：暂停为 model_not_configured / model_unavailable、写明原因，修正配置后从断点续跑）；其他错误为 null。
 */
export function jobModelUnavailableError(error: unknown): JobModelUnavailableError | null {
  const reason = agentModelRejectionReason(error);
  if (reason === 'model_not_configured' || reason === 'model_unavailable') return new JobModelUnavailableError(reason, { cause: error });
  return null;
}

/**
 * 记下本次执行的模型调用被拒绝（最近一次的原因，次数加 1）。任务不在本次执行中（不是 running、run_id 不符）或不是登记了上限的
 * Agent 任务时不写入，返回 false。
 */
export async function recordAgentModelRejection(db: Kysely<Database>, ref: AgentTurnRef, reason: AgentModelRejectionReason): Promise<boolean> {
  return withTenant(db, ref.tenant, async (trx) => {
    const { rows } = await sql<{ job_id: string }>`
      INSERT INTO agent_model_rejections (org_id, job_id, run_id, reason)
      SELECT ${ref.tenant.orgId}::uuid, ${ref.jobId}::uuid, ${ref.runId}::uuid, ${reason}
      WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = ${ref.tenant.orgId}::uuid AND j.id = ${ref.jobId}::uuid
                      AND j.status = 'running' AND j.run_id = ${ref.runId}::uuid)
        AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.org_id = ${ref.tenant.orgId}::uuid AND b.job_id = ${ref.jobId}::uuid)
      ON CONFLICT (job_id, run_id) DO UPDATE
        SET reason = EXCLUDED.reason, rejections = agent_model_rejections.rejections + 1, updated_at = now()
      RETURNING job_id`.execute(trx);
    return rows.length > 0;
  });
}

export interface AgentModelRejection {
  reason: AgentModelRejectionReason;
  /** 本次执行被拒绝的次数。 */
  rejections: number;
}

/** 本次执行最近一次被拒绝的原因与次数（worker 的系统操作，按组织上下文）；没有被拒绝过时为 null。 */
export async function findAgentModelRejection(db: Kysely<Database>, run: RunRef): Promise<AgentModelRejection | null> {
  const row = await withOrgContext(db, run.orgId, (trx) =>
    trx.selectFrom('agent_model_rejections').select(['reason', 'rejections']).where('job_id', '=', run.jobId).where('run_id', '=', run.runId).executeTakeFirst(),
  );
  return row ? { reason: row.reason, rejections: row.rejections } : null;
}

/** 执行入口之前的拒绝次数（之后只采信比它多出来的拒绝）。 */
export async function agentModelRejectionMark(db: Kysely<Database>, run: RunRef): Promise<number> {
  return (await findAgentModelRejection(db, run))?.rejections ?? 0;
}

/** mark 之后（本条提示词或压缩中）最近一次被拒绝的原因；没有新的拒绝时为 null。 */
export async function agentModelRejectionSince(db: Kysely<Database>, run: RunRef, mark: number): Promise<AgentModelRejectionReason | null> {
  const current = await findAgentModelRejection(db, run);
  return current !== null && current.rejections > mark ? current.reason : null;
}
