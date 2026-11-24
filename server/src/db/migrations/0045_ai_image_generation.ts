// AI 网关的生图调用（路线图第 8 步 8.9；#70 决定事项第 11 项“生图按张计价，预扣冻结，计入任务上限”；docs/SERVER_DESIGN.md 第 10.12 节）。
//
// 价格表、白名单、用量记录、冻结与结算原来只有“按 token”一种计价单位。本迁移加上“按张”，其余规则全部沿用：
//
// - platform_models.kind：text（文本模型，0005 起的全部模型）或 image（生图模型）。登记后不能改（与服务商、模型名相同），
//   生图模型只能经 ai_admin_register_image_model 登记；文本调用（ai_model_price / ai_usage_begin）只认 text，
//   生图调用（ai_image_model_price / ai_image_usage_begin）只认 image，类别不符按“未登记”（BL011）拒绝；
// - model_prices.image_price（计费单位 / 张）与 upstream_image_price（上游成本 / 张，平台管理员可见）：按张计价的价格版本
//   两个 token 单价必须为 0、不带 token 的上游单价；新增只能经 billing_admin_add_image_price。白名单的“免费必须显式标记”
//   同样适用于按张的价格（未标记免费的零价格视为未定价，免费标记与非零价格矛盾时 BL013）；
//   价格形状与模型类别不符（文本模型的生效价格是按张的、生图模型的生效价格是按 token 的）时按未定价（BL002）拒绝；
// - usage_records.unit：token 或 image。按张计价的调用（unit = 'image'）中，max_output_tokens 是请求的张数（冻结依据，
//   1～4），output_tokens 是结算时**成功入库**的张数，输入 token 记 0；张数的取值由 CHECK 约束保证；unit 与其他标识列一样不能改；
// - ai_image_usage_begin：与 ai_usage_begin（0033 的版本）相同的租户、任务（running、类型一致）、余额与**任务费用上限**检查
//   （jobs.billed_amount + 本任务未到期的冻结 + 本次冻结 ≤ cost_limit，否则 BL016），冻结额 = 张数 × 单价；
// - 结算、不收费、到期释放沿用 ai_usage_settle / ai_usage_fail / ai_usage_expire_holds（同一条用量记录、同一套状态）：
//   账本触发器对按张的用量按“张数 × 冻结时的单价”计价（仍不超过冻结额），并检查张数在 1～请求张数之内、输入 token 为 0；
//   不经冻结的直接扣费不接受按张的价格（BL002）。上游成本按价格版本的形状计算（按张时为张数 × 上游单价）；
// - ai_usage_fail 新增不收费原因 caller_aborted：生图没有“已产生的部分用量”，调用方中途取消时整次不收费；
// - provider_credentials.kind 新增 image_model：生图服务的 Base URL 与 Key 与文本模型分开保存（AAD 绑定 kind，互相替换无法解密）。
//
// 不新增表，不改已有表的 RLS 策略，不新增数据库角色；新函数与已有计费函数一样属于 bidtools_billing（SECURITY DEFINER），
// 只授权给应用角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, BILLING_ROLE } from '../roles.ts';
import { GATEWAY_FAILURE_REASONS, MAX_HOLD_SECONDS, MIN_HOLD_SECONDS } from './0004_ai_gateway.ts';
import { JOB_STEP_FAILURE_REASONS } from './0025_job_step_results.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const billing = sql.id(BILLING_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

/** 每次生图调用至多请求的张数（8.9 起步值）。 */
export const MAX_IMAGES_PER_CALL = 4;
/** 模型类别。 */
export const PLATFORM_MODEL_KINDS = ['text', 'image'] as const;
/** 用量的计价单位。 */
export const USAGE_UNITS = ['token', 'image'] as const;
/** 平台凭据的种类。 */
export const CREDENTIAL_KINDS = ['text_model', 'image_model'] as const;
/** 本迁移新增的不收费原因：调用方（用户、任务）中途取消生图。 */
export const IMAGE_FAILURE_REASONS = ['caller_aborted'] as const;

const FAILURE_REASONS_0025 = [...GATEWAY_FAILURE_REASONS, 'hold_expired', 'abandoned', 'insufficient_balance', ...JOB_STEP_FAILURE_REASONS] as const;
const FAILURE_REASONS_0045 = [...FAILURE_REASONS_0025, ...IMAGE_FAILURE_REASONS] as const;
/** ai_usage_fail 接受的原因（网关上报的）：0025 的版本与本迁移的版本。 */
const FAIL_INPUT_0025 = [...GATEWAY_FAILURE_REASONS, ...JOB_STEP_FAILURE_REASONS] as const;
const FAIL_INPUT_0045 = [...FAIL_INPUT_0025, ...IMAGE_FAILURE_REASONS] as const;

const NEW_APP_FUNCTIONS = [
  'ai_image_model_check(text, text)',
  'ai_image_usage_begin(uuid, text, uuid, text, text, text, integer, integer)',
  'ai_admin_register_image_model(text, text, boolean, text)',
  'billing_admin_add_image_price(uuid, text, text, bigint, timestamptz, text, bigint)',
] as const;
const NEW_INTERNAL_FUNCTIONS = ['ai_model_price_for(uuid, text, text, text)'] as const;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

/** 账本触发器：images 为 false 时与 0004 的版本逐字相同（down 时恢复），为 true 时只在标出的三处不同。 */
function ledgerApply(images: boolean): RawBuilder<unknown> {
  const imageCheck = images
    ? sql`-- 按张计价（0045）：张数在 1～请求张数之内、输入 token 为 0，价格版本必须是按张的。
              IF v_usage.unit = 'image' AND (NEW.input_tokens <> 0 OR NEW.output_tokens < 1
                 OR NEW.output_tokens > v_usage.max_output_tokens OR v_price.image_price IS NULL) THEN
                RAISE EXCEPTION 'invalid image charge' USING ERRCODE = '22023';
              END IF;`
    : sql``;
  const usageAmount = images
    ? sql`CASE WHEN v_usage.unit = 'image' THEN (NEW.output_tokens::numeric * v_price.image_price)::bigint
                ELSE public.billing_charge_amount(
                  NEW.input_tokens, NEW.output_tokens, v_price.input_price_per_mtok, v_price.output_price_per_mtok) END`
    : sql`public.billing_charge_amount(
                  NEW.input_tokens, NEW.output_tokens, v_price.input_price_per_mtok, v_price.output_price_per_mtok)`;
  const directCheck = images
    ? sql`-- 按张的价格不能用于不经冻结的直接扣费（0045）。
              IF v_price.image_price IS NOT NULL THEN
                RAISE EXCEPTION 'no price for model' USING ERRCODE = 'BL002';
              END IF;`
    : sql``;
  return sql`CREATE OR REPLACE FUNCTION billing_ledger_apply() RETURNS trigger
          LANGUAGE plpgsql ${SECURE}
          AS $$
          DECLARE
            v_balance bigint;
            v_held bigint := 0;
            v_price public.model_prices%ROWTYPE;
            v_original public.billing_ledger%ROWTYPE;
            v_usage public.usage_records%ROWTYPE;
          BEGIN
            INSERT INTO public.org_balances (org_id) VALUES (NEW.org_id) ON CONFLICT (org_id) DO NOTHING;
            SELECT b.balance INTO v_balance FROM public.org_balances b WHERE b.org_id = NEW.org_id FOR UPDATE;

            NEW.created_at := now();
            IF NEW.entry_type <> 'charge' AND NEW.usage_id IS NOT NULL THEN
              RAISE EXCEPTION 'only charges can reference usage' USING ERRCODE = '22023';
            END IF;
            IF NEW.entry_type = 'charge' AND NEW.usage_id IS NOT NULL THEN
              SELECT u.* INTO v_usage FROM public.usage_records u
                WHERE u.id = NEW.usage_id AND u.org_id = NEW.org_id FOR UPDATE;
              IF NOT FOUND OR v_usage.status <> 'pending' OR v_usage.hold_expires_at <= now() THEN
                RAISE EXCEPTION 'hold is not active' USING ERRCODE = 'BL010';
              END IF;
              IF NEW.input_tokens IS NULL OR NEW.output_tokens IS NULL THEN
                RAISE EXCEPTION 'charge requires token counts' USING ERRCODE = '23502';
              END IF;
              SELECT p.* INTO v_price FROM public.model_prices p WHERE p.id = v_usage.price_id;
              ${imageCheck}
              NEW.request_id := v_usage.request_id;
              NEW.provider := v_usage.provider;
              NEW.model := v_usage.model;
              NEW.price_id := v_price.id;
              NEW.amount := -least(
                ${usageAmount},
                v_usage.hold_amount);
              NEW.operator_user_id := public.app_current_user_id();
            ELSIF NEW.entry_type = 'charge' THEN
              IF NEW.request_id IS NULL OR NEW.provider IS NULL OR NEW.model IS NULL
                 OR NEW.input_tokens IS NULL OR NEW.output_tokens IS NULL THEN
                RAISE EXCEPTION 'charge requires request_id, provider, model and token counts' USING ERRCODE = '23502';
              END IF;
              IF EXISTS (SELECT 1 FROM public.billing_ledger l WHERE l.org_id = NEW.org_id AND l.request_id = NEW.request_id) THEN
                RETURN NULL;
              END IF;
              SELECT p.* INTO v_price FROM public.model_prices p
                WHERE p.provider = NEW.provider AND p.model = NEW.model AND p.effective_from <= now()
                  AND (p.org_id IS NULL OR p.org_id = NEW.org_id)
                ORDER BY (p.org_id IS NOT NULL) DESC, p.effective_from DESC
                LIMIT 1;
              IF NOT FOUND THEN
                RAISE EXCEPTION 'no price for model' USING ERRCODE = 'BL002';
              END IF;
              ${directCheck}
              NEW.price_id := v_price.id;
              NEW.amount := -public.billing_charge_amount(
                NEW.input_tokens, NEW.output_tokens, v_price.input_price_per_mtok, v_price.output_price_per_mtok);
              NEW.operator_user_id := public.app_current_user_id();
              v_held := public.billing_active_holds(NEW.org_id);
            ELSIF NEW.entry_type = 'reversal' THEN
              SELECT l.* INTO v_original FROM public.billing_ledger l
                WHERE l.id = NEW.related_entry_id AND l.org_id = NEW.org_id;
              IF NOT FOUND OR v_original.entry_type = 'reversal' OR v_original.amount = 0 THEN
                RAISE EXCEPTION 'entry cannot be reversed' USING ERRCODE = 'BL004';
              END IF;
              IF EXISTS (SELECT 1 FROM public.billing_ledger l
                         WHERE l.related_entry_id = NEW.related_entry_id AND l.entry_type = 'reversal') THEN
                RAISE EXCEPTION 'entry already reversed' USING ERRCODE = 'BL005';
              END IF;
              NEW.amount := -v_original.amount;
            ELSIF NEW.amount IS NULL THEN
              RAISE EXCEPTION 'amount is required' USING ERRCODE = '23502';
            END IF;

            IF v_balance - v_held + NEW.amount < 0 THEN
              RAISE EXCEPTION 'insufficient balance' USING ERRCODE = 'BL001';
            END IF;
            NEW.balance_after := v_balance + NEW.amount;
            UPDATE public.org_balances SET balance = NEW.balance_after, updated_at = now() WHERE org_id = NEW.org_id;
            RETURN NEW;
          END
          $$`;
}

/** 上游成本：images 为 false 时与 0004 的版本相同；为 true 时按张的价格版本按“张数（output_tokens）× 上游单价”计算。 */
function upstreamCost(images: boolean): RawBuilder<unknown> {
  const token = sql`public.billing_charge_amount(
              p_input_tokens, p_output_tokens, p.upstream_input_price_per_mtok, p.upstream_output_price_per_mtok)`;
  const expression = images
    ? sql`CASE WHEN p.image_price IS NOT NULL THEN (p_output_tokens::numeric * p.upstream_image_price)::bigint ELSE ${token} END`
    : token;
  return sql`CREATE OR REPLACE FUNCTION billing_upstream_cost(p_price_id uuid, p_input_tokens bigint, p_output_tokens bigint) RETURNS bigint
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT ${expression}
            FROM public.model_prices p WHERE p.id = p_price_id
          $$`;
}

/** ai_usage_fail（与 0025 的版本相同，只有允许的原因不同）。 */
function usageFail(reasons: readonly string[]): RawBuilder<unknown> {
  return sql`CREATE OR REPLACE FUNCTION ai_usage_fail(
          p_usage_id uuid, p_reason text, p_input_tokens bigint, p_cached_input_tokens bigint, p_output_tokens bigint
        ) RETURNS boolean
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_org_id uuid := public.app_current_org_id();
            v_known boolean := p_input_tokens IS NOT NULL AND p_output_tokens IS NOT NULL;
          BEGIN
            IF v_org_id IS NULL THEN
              RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
            END IF;
            IF p_reason IS NULL OR p_reason NOT IN (${list(reasons)}) THEN
              RAISE EXCEPTION 'invalid failure reason' USING ERRCODE = '22023';
            END IF;
            UPDATE public.usage_records u SET status = 'unbilled', failure_reason = p_reason,
              input_tokens = CASE WHEN v_known THEN p_input_tokens END,
              cached_input_tokens = CASE WHEN v_known THEN p_cached_input_tokens END,
              output_tokens = CASE WHEN v_known THEN p_output_tokens END,
              usage_source = CASE WHEN v_known THEN 'provider' END,
              upstream_cost = CASE WHEN v_known THEN public.billing_upstream_cost(u.price_id, p_input_tokens, p_output_tokens) END,
              finished_at = now()
              WHERE u.id = p_usage_id AND u.org_id = v_org_id AND u.status = 'pending';
            RETURN FOUND;
          END
          $$`;
}

function failureReasonCheck(values: readonly string[]): RawBuilder<unknown> {
  return sql`ALTER TABLE usage_records
          DROP CONSTRAINT usage_records_failure_reason_check,
          ADD CONSTRAINT usage_records_failure_reason_check CHECK (failure_reason IN (${list(values)}))`;
}

/** 白名单检查：0005 的 ai_model_price 加上模型类别与价格形状（按 token / 按张）。内部函数，不授权给应用角色。 */
const MODEL_PRICE_FOR = sql`CREATE FUNCTION ai_model_price_for(p_org_id uuid, p_provider text, p_model text, p_kind text) RETURNS uuid
          LANGUAGE plpgsql STABLE ${SECURE}
          AS $$
          DECLARE
            v_model public.platform_models%ROWTYPE;
            v_price public.model_prices%ROWTYPE;
            v_zero boolean;
          BEGIN
            SELECT m.* INTO v_model FROM public.platform_models m WHERE m.provider = p_provider AND m.model = p_model;
            -- 类别不符（用文本调用登记为生图的模型，或反之）按未登记处理。
            IF NOT FOUND OR v_model.kind IS DISTINCT FROM p_kind THEN
              RAISE EXCEPTION 'model not registered' USING ERRCODE = 'BL011';
            END IF;
            IF NOT v_model.enabled THEN
              RAISE EXCEPTION 'model disabled' USING ERRCODE = 'BL012';
            END IF;
            SELECT p.* INTO v_price FROM public.model_prices p
              WHERE p.provider = p_provider AND p.model = p_model AND p.effective_from <= now()
                AND (p.org_id IS NULL OR p.org_id = p_org_id)
              ORDER BY (p.org_id IS NOT NULL) DESC, p.effective_from DESC
              LIMIT 1;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'no price for model' USING ERRCODE = 'BL002';
            END IF;
            -- 价格形状与类别不符：按未定价拒绝。
            IF (p_kind = 'image') <> (v_price.image_price IS NOT NULL) THEN
              RAISE EXCEPTION 'price unit does not match the model kind' USING ERRCODE = 'BL002';
            END IF;
            IF p_kind = 'image' THEN
              v_zero := v_price.image_price = 0;
            ELSE
              v_zero := v_price.input_price_per_mtok = 0 AND v_price.output_price_per_mtok = 0;
            END IF;
            IF v_zero AND NOT v_model.is_free THEN
              RAISE EXCEPTION 'zero price requires the free flag' USING ERRCODE = 'BL002';
            END IF;
            IF v_model.is_free AND NOT v_zero THEN
              RAISE EXCEPTION 'free model has a non-zero price' USING ERRCODE = 'BL013';
            END IF;
            RETURN v_price.id;
          END
          $$`;

/** 0005 的 ai_model_price（down 时恢复）；up 时改为只认文本模型的包装。 */
function modelPrice(kinds: boolean): RawBuilder<unknown> {
  if (kinds) {
    return sql`CREATE OR REPLACE FUNCTION ai_model_price(p_org_id uuid, p_provider text, p_model text) RETURNS uuid
          LANGUAGE plpgsql STABLE ${SECURE}
          AS $$
          BEGIN
            RETURN public.ai_model_price_for(p_org_id, p_provider, p_model, 'text');
          END
          $$`;
  }
  return sql`CREATE OR REPLACE FUNCTION ai_model_price(p_org_id uuid, p_provider text, p_model text) RETURNS uuid
          LANGUAGE plpgsql STABLE ${SECURE}
          AS $$
          DECLARE
            v_model public.platform_models%ROWTYPE;
            v_price public.model_prices%ROWTYPE;
            v_zero boolean;
          BEGIN
            SELECT m.* INTO v_model FROM public.platform_models m WHERE m.provider = p_provider AND m.model = p_model;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'model not registered' USING ERRCODE = 'BL011';
            END IF;
            IF NOT v_model.enabled THEN
              RAISE EXCEPTION 'model disabled' USING ERRCODE = 'BL012';
            END IF;
            SELECT p.* INTO v_price FROM public.model_prices p
              WHERE p.provider = p_provider AND p.model = p_model AND p.effective_from <= now()
                AND (p.org_id IS NULL OR p.org_id = p_org_id)
              ORDER BY (p.org_id IS NOT NULL) DESC, p.effective_from DESC
              LIMIT 1;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'no price for model' USING ERRCODE = 'BL002';
            END IF;
            v_zero := v_price.input_price_per_mtok = 0 AND v_price.output_price_per_mtok = 0;
            IF v_zero AND NOT v_model.is_free THEN
              -- 未显式标记免费的模型，零价格不等于免费，按未定价拒绝。
              RAISE EXCEPTION 'zero price requires the free flag' USING ERRCODE = 'BL002';
            END IF;
            IF v_model.is_free AND NOT v_zero THEN
              RAISE EXCEPTION 'free model has a non-zero price' USING ERRCODE = 'BL013';
            END IF;
            RETURN v_price.id;
          END
          $$`;
}

/** 用量记录的不变式（0004 的 ai_usage_guard_update）；up 时 unit 也不能改。 */
function usageGuard(unit: boolean): RawBuilder<unknown> {
  const unitCheck = unit ? sql`OR NEW.unit IS DISTINCT FROM OLD.unit` : sql``;
  return sql`CREATE OR REPLACE FUNCTION ai_usage_guard_update() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.status <> 'pending'
               OR NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
               OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
               OR NEW.source IS DISTINCT FROM OLD.source OR NEW.job_id IS DISTINCT FROM OLD.job_id
               OR NEW.job_type IS DISTINCT FROM OLD.job_type OR NEW.provider IS DISTINCT FROM OLD.provider
               OR NEW.model IS DISTINCT FROM OLD.model OR NEW.price_id IS DISTINCT FROM OLD.price_id
               OR NEW.estimated_input_tokens IS DISTINCT FROM OLD.estimated_input_tokens
               OR NEW.max_output_tokens IS DISTINCT FROM OLD.max_output_tokens
               OR NEW.hold_amount IS DISTINCT FROM OLD.hold_amount OR NEW.started_at IS DISTINCT FROM OLD.started_at
               ${unitCheck} THEN
              RAISE EXCEPTION 'usage record is immutable' USING ERRCODE = 'BL003';
            END IF;
            RETURN NEW;
          END
          $$`;
}

/** 平台模型的不变式（0005 的 ai_platform_model_guard_update）；up 时 kind 也不能改。 */
function modelGuard(kind: boolean): RawBuilder<unknown> {
  const kindCheck = kind ? sql`OR NEW.kind IS DISTINCT FROM OLD.kind` : sql``;
  return sql`CREATE OR REPLACE FUNCTION ai_platform_model_guard_update() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider
               OR NEW.model IS DISTINCT FROM OLD.model OR NEW.is_free IS DISTINCT FROM OLD.is_free
               OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_by IS DISTINCT FROM OLD.created_by
               OR NEW.created_at IS DISTINCT FROM OLD.created_at ${kindCheck} THEN
              RAISE EXCEPTION 'platform model is immutable' USING ERRCODE = 'BL003';
            END IF;
            RETURN NEW;
          END
          $$`;
}

function credentialKindCheck(kinds: readonly string[]): RawBuilder<unknown> {
  return sql`ALTER TABLE provider_credentials
          DROP CONSTRAINT provider_credentials_kind_check,
          ADD CONSTRAINT provider_credentials_kind_check CHECK (kind IN (${list(kinds)}))`;
}

/**
 * 生图调用前冻结。与 ai_usage_begin（0033 的版本）逐项相同的检查：租户上下文、冻结时长、任务正在执行且类型一致、
 * 白名单（只认生图模型与按张的价格）、任务费用上限（BL016）、余额（BL001）；冻结额 = 张数 × 单价。
 * 以后修改 ai_usage_begin 的检查时，这里要同步（tests/db/aiImageGateway.test.ts 覆盖任务上限与余额）。
 */
const IMAGE_USAGE_BEGIN = sql`CREATE FUNCTION ai_image_usage_begin(
          p_request_id uuid, p_source text, p_job_id uuid, p_job_type text, p_provider text, p_model text,
          p_image_count integer, p_hold_seconds integer
        ) RETURNS TABLE (usage_id uuid, price_id uuid, hold_amount bigint, hold_expires_at timestamptz, available_after bigint)
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_org_id uuid := public.app_current_org_id();
            v_user_id uuid := public.app_current_user_id();
            v_balance bigint;
            v_held bigint;
            v_hold bigint;
            v_price public.model_prices%ROWTYPE;
            v_job_type text;
            v_cost_limit bigint;
            v_job_billed bigint;
            v_job_held bigint;
          BEGIN
            IF v_org_id IS NULL OR v_user_id IS NULL THEN
              RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
            END IF;
            IF p_hold_seconds IS NULL OR p_hold_seconds < ${sql.raw(String(MIN_HOLD_SECONDS))}
               OR p_hold_seconds > ${sql.raw(String(MAX_HOLD_SECONDS))} THEN
              RAISE EXCEPTION 'invalid hold duration' USING ERRCODE = '22023';
            END IF;
            IF p_image_count IS NULL OR p_image_count < 1 OR p_image_count > ${sql.raw(String(MAX_IMAGES_PER_CALL))} THEN
              RAISE EXCEPTION 'invalid image count' USING ERRCODE = '22023';
            END IF;
            IF p_source = 'job' THEN
              SELECT j.type INTO v_job_type FROM public.jobs j
                WHERE j.org_id = v_org_id AND j.id = p_job_id AND j.status = 'running';
              IF NOT FOUND THEN
                RAISE EXCEPTION 'job is not running' USING ERRCODE = 'BL015';
              END IF;
              IF p_job_type IS NOT NULL AND p_job_type <> v_job_type THEN
                RAISE EXCEPTION 'job type mismatch' USING ERRCODE = '22023';
              END IF;
              SELECT b.cost_limit INTO v_cost_limit FROM public.agent_job_budgets b
                WHERE b.org_id = v_org_id AND b.job_id = p_job_id;
            ELSE
              v_job_type := p_job_type;
            END IF;

            INSERT INTO public.org_balances (org_id) VALUES (v_org_id) ON CONFLICT (org_id) DO NOTHING;
            SELECT b.balance INTO v_balance FROM public.org_balances b WHERE b.org_id = v_org_id FOR UPDATE;

            SELECT p.* INTO v_price FROM public.model_prices p
              WHERE p.id = public.ai_model_price_for(v_org_id, p_provider, p_model, 'image');

            v_hold := (p_image_count::numeric * v_price.image_price)::bigint;
            -- 任务费用上限：已扣费 + 本任务未到期的冻结（文本与生图）+ 本次冻结。
            IF v_cost_limit IS NOT NULL THEN
              SELECT j.billed_amount INTO v_job_billed FROM public.jobs j WHERE j.org_id = v_org_id AND j.id = p_job_id;
              SELECT coalesce(sum(u.hold_amount), 0) INTO v_job_held FROM public.usage_records u
                WHERE u.org_id = v_org_id AND u.job_id = p_job_id AND u.status = 'pending' AND u.hold_expires_at > now();
              IF v_job_billed + v_job_held + v_hold > v_cost_limit THEN
                RAISE EXCEPTION 'task cost limit reached' USING ERRCODE = 'BL016';
              END IF;
            END IF;
            v_held := public.billing_active_holds(v_org_id);
            IF v_balance - v_held - v_hold < 0 THEN
              RAISE EXCEPTION 'insufficient balance' USING ERRCODE = 'BL001';
            END IF;

            RETURN QUERY
              INSERT INTO public.usage_records AS u (
                org_id, user_id, request_id, source, job_id, job_type, provider, model, price_id, unit,
                estimated_input_tokens, max_output_tokens, hold_amount, hold_expires_at)
              VALUES (
                v_org_id, v_user_id, p_request_id, p_source, p_job_id, v_job_type, p_provider, p_model, v_price.id, 'image',
                0, p_image_count, v_hold, now() + make_interval(secs => p_hold_seconds))
              RETURNING u.id, u.price_id, u.hold_amount, u.hold_expires_at, v_balance - v_held - v_hold;
          END
          $$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE platform_models
          ADD COLUMN kind text NOT NULL DEFAULT 'text' CONSTRAINT platform_models_kind_check CHECK (kind IN (${list(PLATFORM_MODEL_KINDS)}))`,
    modelGuard(true),

    sql`ALTER TABLE model_prices
          ADD COLUMN image_price bigint CHECK (image_price >= 0),
          ADD COLUMN upstream_image_price bigint CHECK (upstream_image_price >= 0),
          ADD CONSTRAINT model_prices_image_shape CHECK (
            (image_price IS NOT NULL OR upstream_image_price IS NULL)
            AND (image_price IS NULL OR (input_price_per_mtok = 0 AND output_price_per_mtok = 0
              AND upstream_input_price_per_mtok IS NULL AND upstream_output_price_per_mtok IS NULL)))`,
    // 应用角色可以读按张的单价，读不到上游成本单价（与 0004 相同）。
    sql`GRANT SELECT (image_price) ON model_prices TO ${app}`,

    sql`ALTER TABLE usage_records
          ADD COLUMN unit text NOT NULL DEFAULT 'token' CONSTRAINT usage_records_unit_check CHECK (unit IN (${list(USAGE_UNITS)})),
          ADD CONSTRAINT usage_records_image_shape CHECK (unit = 'token' OR (
            estimated_input_tokens = 0 AND max_output_tokens <= ${sql.lit(MAX_IMAGES_PER_CALL)}
            AND (input_tokens IS NULL OR input_tokens = 0) AND (cached_input_tokens IS NULL OR cached_input_tokens = 0)
            AND (output_tokens IS NULL OR output_tokens <= max_output_tokens)))`,
    sql`GRANT SELECT (unit) ON usage_records TO ${app}`,
    usageGuard(true),
    failureReasonCheck(FAILURE_REASONS_0045),

    credentialKindCheck(CREDENTIAL_KINDS),

    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    ledgerApply(true),
    upstreamCost(true),
    usageFail(FAIL_INPUT_0045),
    MODEL_PRICE_FOR,
    modelPrice(true),

    sql`CREATE FUNCTION ai_image_model_check(p_provider text, p_model text) RETURNS void
          LANGUAGE plpgsql STABLE ${SECURE}
          AS $$
          DECLARE
            v_org_id uuid := public.app_current_org_id();
          BEGIN
            IF v_org_id IS NULL THEN
              RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
            END IF;
            PERFORM public.ai_model_price_for(v_org_id, p_provider, p_model, 'image');
          END
          $$`,

    IMAGE_USAGE_BEGIN,

    // 登记生图模型：与 ai_admin_register_model 相同（默认停用、免费必须显式选择），类别为 image。
    sql`CREATE FUNCTION ai_admin_register_image_model(p_provider text, p_model text, p_is_free boolean, p_note text)
          RETURNS TABLE (model_id uuid, created_at timestamptz)
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_operator uuid := public.billing_require_platform_admin();
          BEGIN
            IF p_is_free IS NULL THEN
              RAISE EXCEPTION 'free flag is required' USING ERRCODE = '22023';
            END IF;
            RETURN QUERY
              INSERT INTO public.platform_models AS m (provider, model, kind, is_free, enabled, note, created_by, updated_by)
              VALUES (p_provider, p_model, 'image', p_is_free, false, NULLIF(btrim(p_note), ''), v_operator, v_operator)
              RETURNING m.id, m.created_at;
          END
          $$`,

    // 新增按张的价格版本：规则与 billing_admin_add_price 相同（生效时间不早于当前时刻、组织必须存在）。
    sql`CREATE FUNCTION billing_admin_add_image_price(
          p_org_id uuid, p_provider text, p_model text, p_image_price bigint,
          p_effective_from timestamptz, p_note text, p_upstream_image_price bigint
        ) RETURNS TABLE (price_id uuid, effective_from timestamptz)
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_operator uuid := public.billing_require_platform_admin();
            v_effective_from timestamptz := coalesce(p_effective_from, now());
          BEGIN
            IF v_effective_from < now() THEN
              RAISE EXCEPTION 'effective_from must not be in the past' USING ERRCODE = 'BL008';
            END IF;
            IF p_org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org_id) THEN
              RAISE EXCEPTION 'organization not found' USING ERRCODE = 'BL007';
            END IF;
            IF p_image_price IS NULL THEN
              RAISE EXCEPTION 'image price is required' USING ERRCODE = '22023';
            END IF;
            RETURN QUERY
              INSERT INTO public.model_prices AS p
                (org_id, provider, model, input_price_per_mtok, output_price_per_mtok, image_price, upstream_image_price,
                 effective_from, created_by, note)
              VALUES (p_org_id, p_provider, p_model, 0, 0, p_image_price, p_upstream_image_price,
                      v_effective_from, v_operator, NULLIF(btrim(p_note), ''))
              RETURNING p.id, p.effective_from;
          END
          $$`,

    ...[...NEW_APP_FUNCTIONS, ...NEW_INTERNAL_FUNCTIONS].map((signature) => sql`REVOKE ALL ON FUNCTION ${sql.raw(signature)} FROM PUBLIC`),
    ...NEW_APP_FUNCTIONS.map((signature) => sql`GRANT EXECUTE ON FUNCTION ${sql.raw(signature)} TO ${app}`),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    ...[...NEW_APP_FUNCTIONS].map((signature) => sql`DROP FUNCTION ${sql.raw(signature)}`),
    modelPrice(false),
    sql`DROP FUNCTION ai_model_price_for(uuid, text, text, text)`,
    usageFail(FAIL_INPUT_0025),
    upstreamCost(false),
    ledgerApply(false),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,

    // 生图凭据回滚后没有对应的种类，删除（只有密文，删除即作废）。属主同样受强制 RLS 约束，临时取消 FORCE。
    sql`ALTER TABLE provider_credentials NO FORCE ROW LEVEL SECURITY`,
    sql`DELETE FROM provider_credentials WHERE kind = 'image_model'`,
    sql`ALTER TABLE provider_credentials FORCE ROW LEVEL SECURITY`,
    credentialKindCheck(['text_model']),

    // 与 0025 的回滚相同：已有 caller_aborted 的用量记录时恢复约束失败（用量记录不可修改、不可删除）。
    failureReasonCheck(FAILURE_REASONS_0025),
    usageGuard(false),
    sql`REVOKE SELECT (unit) ON usage_records FROM ${app}`,
    sql`ALTER TABLE usage_records DROP CONSTRAINT usage_records_image_shape, DROP COLUMN unit`,

    sql`REVOKE SELECT (image_price) ON model_prices FROM ${app}`,
    sql`ALTER TABLE model_prices DROP CONSTRAINT model_prices_image_shape, DROP COLUMN image_price, DROP COLUMN upstream_image_price`,

    // 生图模型回滚后会被当作文本模型：先停用（按张的价格去掉单价后是 0 / 0，免费的生图模型否则会成为可调用的免费文本模型）。
    sql`ALTER TABLE platform_models NO FORCE ROW LEVEL SECURITY`,
    sql`UPDATE platform_models SET enabled = false, updated_at = now() WHERE kind = 'image' AND enabled`,
    sql`ALTER TABLE platform_models FORCE ROW LEVEL SECURITY`,
    modelGuard(false),
    sql`ALTER TABLE platform_models DROP COLUMN kind`,
  ]);
}
