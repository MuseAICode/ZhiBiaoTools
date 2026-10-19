// 平台模型白名单（迁移 0005_platform_models）：只有平台管理员登记且启用、并在价格表中有生效价格的服务商 + 模型
// 才能调用。是否可调用由数据库函数 ai_model_price 判定，网关的预检（assertModelCallable）和冻结（ai_usage_begin）
// 用的是同一个函数。免费必须显式标记（is_free），零价格不等于免费。
import { sql, type Kysely } from 'kysely';
import { toBillingError } from '../billing/ledger.ts';
import type { BillingProvider, Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';

/**
 * 按平台默认价判断的状态（管理后台展示用）：
 * available 可调用；disabled 已停用；unpriced 没有生效价格，或未标记免费却是零价格；price_conflict 标记免费但价格不为零。
 * 组织专属价可能让个别组织的结果不同，以调用时的检查为准。
 */
export type PlatformModelStatus = 'available' | 'disabled' | 'unpriced' | 'price_conflict';

export interface PlatformModel {
  id: string;
  provider: BillingProvider;
  model: string;
  isFree: boolean;
  enabled: boolean;
  note: string | null;
  /** 当前生效的平台默认价（计费单位 / 百万 token），没有时为 null。 */
  inputPricePerMtok: bigint | null;
  outputPricePerMtok: bigint | null;
  status: PlatformModelStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterModelInput {
  provider: BillingProvider;
  model: string;
  /** 免费模型：生效价格必须为 0 / 0，调用不扣费。只能在登记时显式指定。 */
  isFree: boolean;
  note: string | null;
}

async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toBillingError(error);
  }
}

export function modelStatus(model: { enabled: boolean; isFree: boolean; inputPricePerMtok: bigint | null; outputPricePerMtok: bigint | null }): PlatformModelStatus {
  if (!model.enabled) return 'disabled';
  if (model.inputPricePerMtok === null || model.outputPricePerMtok === null) return 'unpriced';
  const zero = model.inputPricePerMtok === 0n && model.outputPricePerMtok === 0n;
  if (zero && !model.isFree) return 'unpriced';
  if (!zero && model.isFree) return 'price_conflict';
  return 'available';
}

/**
 * 调用前检查该组织能否调用这个服务商 + 模型。不能调用时抛 AI_MODEL_NOT_REGISTERED（404）、AI_MODEL_DISABLED（403）、
 * MODEL_PRICE_NOT_CONFIGURED（503）或 AI_MODEL_PRICE_CONFLICT（503）。
 */
export async function assertModelCallable(db: Kysely<Database>, context: TenantContext, provider: BillingProvider, model: string): Promise<void> {
  await mapErrors(() => withTenant(db, context, (trx) => sql`SELECT ai_model_check(${provider}, ${model})`.execute(trx)));
}

/** 平台管理员登记模型，登记后为停用状态。是否平台管理员由数据库函数校验，操作人取 context.userId。 */
export async function registerModel(db: Kysely<Database>, context: TenantContext, input: RegisterModelInput): Promise<{ id: string; createdAt: Date }> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<{ model_id: string; created_at: Date }>`
        SELECT model_id, created_at FROM ai_admin_register_model(${input.provider}, ${input.model}, ${input.isFree}, ${input.note})`.execute(trx);
      const row = result.rows[0]!;
      return { id: row.model_id, createdAt: row.created_at };
    }),
  );
}

/** 平台管理员启用或停用模型。停用立即对之后的调用生效，进行中的调用照常结算。 */
export async function setModelEnabled(
  db: Kysely<Database>,
  context: TenantContext,
  modelId: string,
  enabled: boolean,
): Promise<{ id: string; provider: BillingProvider; model: string; isFree: boolean; enabled: boolean; updatedAt: Date }> {
  return mapErrors(() =>
    withTenant(db, context, async (trx) => {
      const result = await sql<{ model_id: string; provider: BillingProvider; model: string; is_free: boolean; enabled: boolean; updated_at: Date }>`
        SELECT model_id, provider, model, is_free, enabled, updated_at FROM ai_admin_set_model_enabled(${modelId}::uuid, ${enabled})`.execute(trx);
      const row = result.rows[0]!;
      return { id: row.model_id, provider: row.provider, model: row.model, isFree: row.is_free, enabled: row.enabled, updatedAt: row.updated_at };
    }),
  );
}

/** 全部登记的模型，附当前生效的平台默认价和状态。 */
export async function listModels(db: Kysely<Database>, context: TenantContext): Promise<PlatformModel[]> {
  const rows = await withTenant(db, context, async (trx) => {
    const result = await sql<{
      id: string;
      provider: BillingProvider;
      model: string;
      is_free: boolean;
      enabled: boolean;
      note: string | null;
      created_at: Date;
      updated_at: Date;
      input_price_per_mtok: string | null;
      output_price_per_mtok: string | null;
    }>`
      SELECT m.id, m.provider, m.model, m.is_free, m.enabled, m.note, m.created_at, m.updated_at,
             p.input_price_per_mtok, p.output_price_per_mtok
      FROM platform_models m
      LEFT JOIN LATERAL (
        SELECT x.input_price_per_mtok, x.output_price_per_mtok FROM model_prices x
        WHERE x.org_id IS NULL AND x.provider = m.provider AND x.model = m.model AND x.effective_from <= now()
        ORDER BY x.effective_from DESC
        LIMIT 1
      ) p ON true
      ORDER BY m.provider, m.model`.execute(trx);
    return result.rows;
  });
  return rows.map((row) => {
    const model = {
      id: row.id,
      provider: row.provider,
      model: row.model,
      isFree: row.is_free,
      enabled: row.enabled,
      note: row.note,
      inputPricePerMtok: row.input_price_per_mtok === null ? null : BigInt(row.input_price_per_mtok),
      outputPricePerMtok: row.output_price_per_mtok === null ? null : BigInt(row.output_price_per_mtok),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return { ...model, status: modelStatus(model) };
  });
}
