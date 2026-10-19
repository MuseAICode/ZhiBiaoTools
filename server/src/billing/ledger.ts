// 计费账本的服务端入口（docs/SERVER_DESIGN.md 第 10 节）。数据库层的规则见迁移 0003_billing：
// 扣费金额、余额更新、幂等和余额不足都由账本触发器在同一事务中完成，这里只负责入参校验、调用和错误映射。
//
// 金额一律是 BigInt，单位为计费单位（0.0001 元），不经过 number，更不经过浮点。
import { sql, type Kysely } from 'kysely';
import { MAX_MANUAL_CREDIT_UNITS } from '../db/migrations/0003_billing.ts';
import { BILLING_PROVIDERS, type BillingProvider, type Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';

/** 1 元 = 10000 计费单位。 */
export const UNITS_PER_YUAN = 10_000n;
export { MAX_MANUAL_CREDIT_UNITS };

/** 单次调用的 token 数上限，与 billing_ledger 的 CHECK 约束一致。 */
export const MAX_TOKENS_PER_CHARGE = 1_000_000_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export interface UsageCharge {
  /** AI 网关为每次上游调用生成的 UUID；同一组织内重复提交只扣一次。 */
  requestId: string;
  provider: BillingProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ChargeResult {
  entryId: string;
  /** 本次扣费金额（正数，计费单位）。 */
  amount: bigint;
  /** 该笔入账后的余额；重复提交时是首次入账后的余额。 */
  balanceAfter: bigint;
  priceId: string;
  /** true 表示该请求编号已经扣过费，本次没有再扣。 */
  duplicate: boolean;
}

export type CreditType = 'recharge' | 'grant';

export interface CreditInput {
  orgId: string;
  type: CreditType;
  amount: bigint;
  /** 线下收款凭证号，可空。 */
  reference: string | null;
  note: string;
}

export interface LedgerEntryResult {
  entryId: string;
  orgId: string;
  amount: bigint;
  balanceAfter: bigint;
  createdAt: Date;
}

export interface NewPrice {
  /** 为空表示平台默认价。 */
  orgId: string | null;
  provider: BillingProvider;
  model: string;
  inputPricePerMtok: bigint;
  outputPricePerMtok: bigint;
  /** 为空表示立即生效；不能早于当前时刻。 */
  effectiveFrom: Date | null;
  note: string | null;
  /** 上游成本单价（每百万 token），仅平台管理员可见；两项同时为空表示未录入（迁移 0004_ai_gateway）。 */
  upstreamInputPricePerMtok?: bigint | null;
  upstreamOutputPricePerMtok?: bigint | null;
}

function pgErrorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** 把数据库抛出的计费错误（迁移 0003_billing ~ 0005_platform_models 中的 SQLSTATE）转成给用户看的 AppError，其他错误原样抛出。 */
export function toBillingError(error: unknown): unknown {
  switch (pgErrorCode(error)) {
    case 'BL001':
      return new AppError(402, 'INSUFFICIENT_BALANCE', '余额不足，请充值后再试', { cause: error });
    case 'BL002':
      return new AppError(503, 'MODEL_PRICE_NOT_CONFIGURED', '该模型尚未定价，暂时无法使用', { cause: error });
    case 'BL004':
      return new AppError(404, 'LEDGER_ENTRY_NOT_FOUND', '账本记录不存在或不能冲正', { cause: error });
    case 'BL005':
      return new AppError(409, 'LEDGER_ENTRY_ALREADY_REVERSED', '该记录已经冲正过', { cause: error });
    case 'BL006':
      return new AppError(
        422,
        'CREDIT_LIMIT_EXCEEDED',
        `单笔充值不能超过 ${MAX_MANUAL_CREDIT_UNITS / UNITS_PER_YUAN} 元；大额充值需要二次验证和双人复核，暂未开放`,
        { cause: error },
      );
    case 'BL007':
      return new AppError(404, 'ORGANIZATION_NOT_FOUND', '组织不存在', { cause: error });
    case 'BL008':
      return new AppError(400, 'EFFECTIVE_FROM_IN_PAST', '生效时间不能早于当前时间', { cause: error });
    case 'BL011':
      return new AppError(404, 'AI_MODEL_NOT_REGISTERED', '该模型未在平台登记，不能调用', { cause: error });
    case 'BL012':
      return new AppError(403, 'AI_MODEL_DISABLED', '该模型已停用，暂时不能调用', { cause: error });
    case 'BL013':
      return new AppError(503, 'AI_MODEL_PRICE_CONFLICT', '该模型标记为免费但价格不为零，暂时无法使用', { cause: error });
    case 'BL014':
      return new AppError(404, 'AI_MODEL_NOT_FOUND', '模型不存在', { cause: error });
    case '22023':
      return new AppError(400, 'BAD_REQUEST', '请求不合法', { cause: error });
    case '42501':
      return new AppError(403, 'FORBIDDEN', '没有权限执行此操作', { cause: error });
    case '23505':
      if ((error as { constraint?: unknown }).constraint === 'model_prices_version_key') {
        return new AppError(409, 'PRICE_VERSION_EXISTS', '该模型在这个生效时间已有价格版本', { cause: error });
      }
      if ((error as { constraint?: unknown }).constraint === 'platform_models_provider_model_key') {
        return new AppError(409, 'AI_MODEL_EXISTS', '该服务商的这个模型已经登记过', { cause: error });
      }
      return error;
    default:
      return error;
  }
}

async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toBillingError(error);
  }
}

function assertUsage(usage: UsageCharge): void {
  if (typeof usage.requestId !== 'string' || !UUID_PATTERN.test(usage.requestId)) {
    throw new TypeError('UsageCharge.requestId 必须是 UUID');
  }
  if (!(BILLING_PROVIDERS as readonly string[]).includes(usage.provider)) {
    throw new TypeError('UsageCharge.provider 不合法');
  }
  if (typeof usage.model !== 'string' || !MODEL_NAME_PATTERN.test(usage.model)) {
    throw new TypeError('UsageCharge.model 不合法');
  }
  for (const tokens of [usage.inputTokens, usage.outputTokens]) {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > MAX_TOKENS_PER_CHARGE) {
      throw new TypeError('UsageCharge 的 token 数必须是 0 到 10 亿之间的整数');
    }
  }
}

/**
 * 按价格表对一次模型调用扣费。扣费、余额更新在同一事务中完成；同一组织同一 requestId 只扣一次，
 * 重复提交返回首次的结果（duplicate = true），用量不一致时拒绝。余额不足抛 INSUFFICIENT_BALANCE，不入账。
 * 组织来自 TenantContext（会话或任务令牌），不来自请求参数。
 */
export async function chargeUsage(db: Kysely<Database>, context: TenantContext, usage: UsageCharge): Promise<ChargeResult> {
  assertUsage(usage);
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const columns = ['id', 'amount', 'balance_after', 'price_id', 'provider', 'model', 'input_tokens', 'output_tokens'] as const;
      const inserted = await trx
        .insertInto('billing_ledger')
        .values({
          org_id: context.orgId,
          entry_type: 'charge',
          request_id: usage.requestId,
          provider: usage.provider,
          model: usage.model,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
        })
        .returning(columns)
        .executeTakeFirst();
      // 触发器发现该请求编号已经入账时跳过本行，RETURNING 为空。
      const row =
        inserted ??
        (await trx
          .selectFrom('billing_ledger')
          .select(columns)
          .where('entry_type', '=', 'charge')
          .where('request_id', '=', usage.requestId)
          .executeTakeFirstOrThrow());
      if (
        !inserted &&
        (row.provider !== usage.provider ||
          row.model !== usage.model ||
          row.input_tokens !== String(usage.inputTokens) ||
          row.output_tokens !== String(usage.outputTokens))
      ) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一请求编号的用量与已入账的记录不一致');
      }
      return {
        entryId: row.id,
        amount: -BigInt(row.amount),
        balanceAfter: BigInt(row.balance_after),
        priceId: row.price_id as string,
        duplicate: !inserted,
      };
    }),
  );
}

/** 当前组织的余额（计费单位）；从未入账的组织为 0。 */
export async function getBalance(db: Kysely<Database>, context: TenantContext): Promise<bigint> {
  const row = await withTenant(db, context, (trx) =>
    trx.selectFrom('org_balances').select('balance').where('org_id', '=', context.orgId).executeTakeFirst(),
  );
  return row ? BigInt(row.balance) : 0n;
}

/**
 * 平台管理员给任意组织手动充值或赠送。是否平台管理员、单笔上限、备注必填都由数据库函数校验，
 * 操作人取 context.userId。调用方负责二次验证（见 src/routes/admin.ts）。
 */
export async function creditOrganization(db: Kysely<Database>, context: TenantContext, input: CreditInput): Promise<LedgerEntryResult> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<{ entry_id: string; balance_after: string; created_at: Date }>`
        SELECT entry_id, balance_after, created_at
        FROM billing_admin_credit(${input.orgId}::uuid, ${input.type}, ${input.amount.toString()}::bigint, ${input.reference}, ${input.note})`.execute(trx);
      const row = result.rows[0]!;
      return {
        entryId: row.entry_id,
        orgId: input.orgId,
        amount: input.amount,
        balanceAfter: BigInt(row.balance_after),
        createdAt: row.created_at,
      };
    }),
  );
}

/** 平台管理员冲正一笔记录：新增一笔金额相反、引用原记录的 reversal，每笔最多冲正一次。 */
export async function reverseLedgerEntry(
  db: Kysely<Database>,
  context: TenantContext,
  input: { entryId: string; note: string },
): Promise<LedgerEntryResult> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<{ entry_id: string; org_id: string; amount: string; balance_after: string; created_at: Date }>`
        SELECT entry_id, org_id, amount, balance_after, created_at
        FROM billing_admin_reverse(${input.entryId}::uuid, ${input.note})`.execute(trx);
      const row = result.rows[0]!;
      return {
        entryId: row.entry_id,
        orgId: row.org_id,
        amount: BigInt(row.amount),
        balanceAfter: BigInt(row.balance_after),
        createdAt: row.created_at,
      };
    }),
  );
}

/** 平台管理员新增价格版本（可带上游成本单价）。已有版本不能修改，改价只能新增生效时间不早于当前时刻的版本。 */
export async function addModelPrice(
  db: Kysely<Database>,
  context: TenantContext,
  price: NewPrice,
): Promise<{ priceId: string; effectiveFrom: Date }> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<{ price_id: string; effective_from: Date }>`
        SELECT price_id, effective_from
        FROM billing_admin_add_price(
          ${price.orgId}::uuid, ${price.provider}, ${price.model},
          ${price.inputPricePerMtok.toString()}::bigint, ${price.outputPricePerMtok.toString()}::bigint,
          ${price.effectiveFrom}::timestamptz, ${price.note},
          ${price.upstreamInputPricePerMtok?.toString() ?? null}::bigint, ${price.upstreamOutputPricePerMtok?.toString() ?? null}::bigint)`.execute(trx);
      const row = result.rows[0]!;
      return { priceId: row.price_id, effectiveFrom: row.effective_from };
    }),
  );
}
