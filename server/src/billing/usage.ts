// AI 调用的预扣冻结与结算（docs/SERVER_DESIGN.md 第 10.3 节），数据库层见迁移 0004_ai_gateway：
// ai_usage_begin 冻结、ai_usage_settle 按实际用量结算、ai_usage_fail 不收费并释放冻结、ai_usage_expire_holds 清理到期冻结。
// 金额一律是 BigInt（计费单位）。组织和用户来自 TenantContext，不来自请求参数。
import { sql, type Kysely, type Transaction } from 'kysely';
import { GATEWAY_FAILURE_REASONS } from '../db/migrations/0004_ai_gateway.ts';
import type { BillingProvider, Database, UsageSource } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { toBillingError } from './ledger.ts';

export type GatewayFailureReason = (typeof GATEWAY_FAILURE_REASONS)[number];
export { GATEWAY_FAILURE_REASONS };

export interface BeginUsageInput {
  requestId: string;
  source: UsageSource;
  /** source = 'job' 时必填。 */
  jobId: string | null;
  jobType: string | null;
  provider: BillingProvider;
  model: string;
  /** 输入 token 数的上界（src/ai/estimate.ts）。 */
  estimatedInputTokens: number;
  maxOutputTokens: number;
  holdSeconds: number;
}

export interface UsageHold {
  usageId: string;
  priceId: string;
  holdAmount: bigint;
  holdExpiresAt: Date;
  /** 冻结后的可用余额。 */
  availableAfter: bigint;
}

export interface SettleUsageInput {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  usageSource: 'provider' | 'estimated';
}

export interface SettlementResult {
  /** unbilled：冻结已到期，或冻结后余额被冲正到不足，本次不收费。 */
  status: 'billed' | 'unbilled';
  amount: bigint;
  balanceAfter: bigint | null;
  ledgerEntryId: string | null;
}

function mapUsageError(error: unknown): unknown {
  if ((error as { code?: unknown } | null)?.code === 'BL010') {
    return new AppError(409, 'USAGE_NOT_PENDING', '该调用已经结算或已释放', { cause: error });
  }
  return toBillingError(error);
}

async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapUsageError(error);
  }
}

/**
 * 调用前冻结最高费用。余额减去进行中的冻结不足以冻结时抛 INSUFFICIENT_BALANCE（402）；
 * 模型不在白名单中（未登记、已停用、未定价、免费标记与价格矛盾，迁移 0005_platform_models）时抛对应的错误，
 * 见 src/ai/models.ts。都不写用量记录。
 */
export async function beginUsage(db: Kysely<Database>, context: TenantContext, input: BeginUsageInput): Promise<UsageHold> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<{ usage_id: string; price_id: string; hold_amount: string; hold_expires_at: Date; available_after: string }>`
        SELECT usage_id, price_id, hold_amount, hold_expires_at, available_after FROM ai_usage_begin(
          ${input.requestId}::uuid, ${input.source}, ${input.jobId}::uuid, ${input.jobType}, ${input.provider}, ${input.model},
          ${input.estimatedInputTokens}::bigint, ${input.maxOutputTokens}::bigint, ${input.holdSeconds}::integer)`.execute(trx);
      const row = result.rows[0]!;
      return {
        usageId: row.usage_id,
        priceId: row.price_id,
        holdAmount: BigInt(row.hold_amount),
        holdExpiresAt: row.hold_expires_at,
        availableAfter: BigInt(row.available_after),
      };
    }),
  );
}

/** 按实际用量结算：扣费不超过冻结额，多余的冻结释放。已结算或已释放的调用抛 USAGE_NOT_PENDING（409）。 */
export async function settleUsage(
  db: Kysely<Database>,
  context: TenantContext,
  usageId: string,
  usage: SettleUsageInput,
): Promise<SettlementResult> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<{ status: 'billed' | 'unbilled'; amount: string; balance_after: string | null; ledger_entry_id: string | null }>`
        SELECT status, amount, balance_after, ledger_entry_id FROM ai_usage_settle(
          ${usageId}::uuid, ${usage.inputTokens}::bigint, ${usage.cachedInputTokens}::bigint, ${usage.outputTokens}::bigint, ${usage.usageSource})`.execute(trx);
      const row = result.rows[0]!;
      return {
        status: row.status,
        amount: BigInt(row.amount),
        balanceAfter: row.balance_after === null ? null : BigInt(row.balance_after),
        ledgerEntryId: row.ledger_entry_id,
      };
    }),
  );
}

/** 调用失败：不收费，冻结全额释放。服务商返回了用量时一并传入（计算平台承担的上游成本）。返回是否改动了记录。 */
export async function failUsage(
  db: Kysely<Database>,
  context: TenantContext,
  usageId: string,
  reason: GatewayFailureReason,
  usage: Omit<SettleUsageInput, 'usageSource'> | null = null,
): Promise<boolean> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<{ released: boolean }>`
        SELECT ai_usage_fail(${usageId}::uuid, ${reason}, ${usage?.inputTokens ?? null}::bigint,
          ${usage?.cachedInputTokens ?? null}::bigint, ${usage?.outputTokens ?? null}::bigint) AS released`.execute(trx);
      return result.rows[0]!.released;
    }),
  );
}

/**
 * 把已到期、未结算的冻结标为 unbilled（abandoned）。跨组织，不需要租户上下文；由 src/server.ts 定时执行。
 * 到期的冻结在此之前就已经不占用余额，这里只是收尾。
 */
export async function expireStaleHolds(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ expired: number }>`SELECT ai_usage_expire_holds() AS expired`.execute(db);
  return result.rows[0]!.expired;
}

/**
 * 入队、继续任务前的余额门槛（迁移 0022_job_billing 的 billing_job_start_check）：可用余额低于最低启动余额（1 元）时
 * 抛 INSUFFICIENT_BALANCE（402）。在调用方的事务中执行（组织取该事务的 app.org_id），失败时整个事务回滚。
 */
export async function assertJobStartBalance(trx: Transaction<Database>): Promise<void> {
  try {
    await sql`SELECT billing_job_start_check()`.execute(trx);
  } catch (error) {
    throw mapUsageError(error);
  }
}

/** 可用余额 = 余额 − 进行中（未到期）的冻结，在同一事务中读取。 */
export async function getAvailableBalance(db: Kysely<Database>, context: TenantContext): Promise<{ balance: bigint; held: bigint; available: bigint }> {
  return withTenant(db, context, async (trx) => {
    const result = await sql<{ balance: string; held: string }>`
      SELECT
        coalesce((SELECT b.balance FROM org_balances b WHERE b.org_id = ${context.orgId}::uuid), 0)::text AS balance,
        coalesce((SELECT sum(u.hold_amount) FROM usage_records u
                  WHERE u.org_id = ${context.orgId}::uuid AND u.status = 'pending' AND u.hold_expires_at > now()), 0)::text AS held`.execute(trx);
    const balance = BigInt(result.rows[0]!.balance);
    const held = BigInt(result.rows[0]!.held);
    return { balance, held, available: balance - held };
  });
}
