// 平台模型白名单（docs/SERVER_DESIGN.md 第 10.3、10.8 节）：只有平台管理员登记且启用、并在价格表中有生效价格的
// 服务商 + 模型才能调用，其他一律拒绝，不冻结、不调用服务商。
//
// 0004 之前的规则是“价格表里有生效价格就能调用”：任何录过价的模型都能调用，价格为 0 / 0 的版本等于默认免费。
// 本迁移改为：
// - 调用前（ai_usage_begin，以及网关在解密 Key 之前的预检 ai_model_check）经 ai_model_price 逐项检查：
//   未登记 BL011、已停用 BL012、没有生效价格 BL002；
// - 免费必须显式标记：platform_models.is_free 为 false 时，输入、输出单价都为 0 的价格版本视为未定价（BL002）；
//   is_free 为 true 时生效价格必须为 0 / 0，否则 BL013（标记与价格矛盾，拒绝而不是按哪一边算）；
// - 白名单只控制“能不能调用”，扣费仍按冻结时确定的价格版本（0004 的规则不变）。
//
// 登记、启用、停用只能经平台管理员的 SECURITY DEFINER 函数（属主 bidtools_billing）。登记后默认停用；
// 服务商、模型名和免费标记登记后不能修改，记录不能删除（停用即可）。应用角色只读。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, BILLING_ROLE } from '../roles.ts';
import { MAX_HOLD_SECONDS, MIN_HOLD_SECONDS } from './0004_ai_gateway.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const billing = sql.id(BILLING_ROLE);

const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

const APP_FUNCTIONS = [
  'ai_model_check(text, text)',
  'ai_admin_register_model(text, text, boolean, text)',
  'ai_admin_set_model_enabled(uuid, boolean)',
] as const;
const INTERNAL_FUNCTIONS = ['ai_model_price(uuid, text, text)'] as const;

/** ai_usage_begin 的公共部分；up 中的版本在取价格之前经白名单检查，down 时恢复 0004 的版本。 */
function usageBegin(selectPrice: RawBuilder<unknown>): RawBuilder<unknown> {
  return sql`CREATE OR REPLACE FUNCTION ai_usage_begin(
          p_request_id uuid, p_source text, p_job_id uuid, p_job_type text, p_provider text, p_model text,
          p_estimated_input_tokens bigint, p_max_output_tokens bigint, p_hold_seconds integer
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
          BEGIN
            IF v_org_id IS NULL OR v_user_id IS NULL THEN
              RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
            END IF;
            IF p_hold_seconds IS NULL OR p_hold_seconds < ${sql.raw(String(MIN_HOLD_SECONDS))}
               OR p_hold_seconds > ${sql.raw(String(MAX_HOLD_SECONDS))} THEN
              RAISE EXCEPTION 'invalid hold duration' USING ERRCODE = '22023';
            END IF;
            IF p_estimated_input_tokens IS NULL OR p_max_output_tokens IS NULL THEN
              RAISE EXCEPTION 'token bounds are required' USING ERRCODE = '22023';
            END IF;

            INSERT INTO public.org_balances (org_id) VALUES (v_org_id) ON CONFLICT (org_id) DO NOTHING;
            SELECT b.balance INTO v_balance FROM public.org_balances b WHERE b.org_id = v_org_id FOR UPDATE;

            ${selectPrice}

            v_hold := public.billing_charge_amount(
              p_estimated_input_tokens, p_max_output_tokens, v_price.input_price_per_mtok, v_price.output_price_per_mtok);
            v_held := public.billing_active_holds(v_org_id);
            IF v_balance - v_held - v_hold < 0 THEN
              RAISE EXCEPTION 'insufficient balance' USING ERRCODE = 'BL001';
            END IF;

            RETURN QUERY
              INSERT INTO public.usage_records AS u (
                org_id, user_id, request_id, source, job_id, job_type, provider, model, price_id,
                estimated_input_tokens, max_output_tokens, hold_amount, hold_expires_at)
              VALUES (
                v_org_id, v_user_id, p_request_id, p_source, p_job_id, p_job_type, p_provider, p_model, v_price.id,
                p_estimated_input_tokens, p_max_output_tokens, v_hold, now() + make_interval(secs => p_hold_seconds))
              RETURNING u.id, u.price_id, u.hold_amount, u.hold_expires_at, v_balance - v_held - v_hold;
          END
          $$`;
}

const SELECT_PRICE_0004 = sql`SELECT p.* INTO v_price FROM public.model_prices p
              WHERE p.provider = p_provider AND p.model = p_model AND p.effective_from <= now()
                AND (p.org_id IS NULL OR p.org_id = v_org_id)
              ORDER BY (p.org_id IS NOT NULL) DESC, p.effective_from DESC
              LIMIT 1;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'no price for model' USING ERRCODE = 'BL002';
            END IF;`;

const SELECT_PRICE_0005 = sql`SELECT p.* INTO v_price FROM public.model_prices p
              WHERE p.id = public.ai_model_price(v_org_id, p_provider, p_model);`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 每个 (服务商, 模型) 一行。created_by / updated_by 不设外键，理由同 model_prices.created_by。
    sql`CREATE TABLE platform_models (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          provider text NOT NULL CHECK (provider IN ('deepseek', 'qwen')),
          model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
          is_free boolean NOT NULL DEFAULT false,
          enabled boolean NOT NULL DEFAULT false,
          note text CHECK (char_length(note) <= 500),
          created_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_by uuid NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT platform_models_provider_model_key UNIQUE (provider, model)
        )`,

    // 登记后只有启用状态（和操作人、时间）可以改；任何角色都不能删除（表属主同样受约束）。
    sql`CREATE FUNCTION ai_platform_model_guard_update() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider
               OR NEW.model IS DISTINCT FROM OLD.model OR NEW.is_free IS DISTINCT FROM OLD.is_free
               OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_by IS DISTINCT FROM OLD.created_by
               OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
              RAISE EXCEPTION 'platform model is immutable' USING ERRCODE = 'BL003';
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER platform_models_guard_update BEFORE UPDATE ON platform_models
          FOR EACH ROW EXECUTE FUNCTION ai_platform_model_guard_update()`,
    sql`CREATE TRIGGER platform_models_no_delete BEFORE DELETE ON platform_models
          FOR EACH ROW EXECUTE FUNCTION billing_reject_change()`,
    sql`CREATE TRIGGER platform_models_no_truncate BEFORE TRUNCATE ON platform_models
          FOR EACH STATEMENT EXECUTE FUNCTION billing_reject_change()`,

    sql`ALTER TABLE platform_models ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE platform_models FORCE ROW LEVEL SECURITY`,
    // 应用角色只读（设置页的模型列表、管理后台）；未设置组织上下文时什么都读不到。
    sql`CREATE POLICY platform_models_select ON platform_models FOR SELECT TO ${app}
          USING (app_current_org_id() IS NOT NULL)`,
    sql`GRANT SELECT ON platform_models TO ${app}`,
    sql`GRANT SELECT, INSERT, UPDATE (enabled, updated_by, updated_at) ON platform_models TO ${billing}`,
    sql`CREATE POLICY platform_models_billing ON platform_models TO ${billing} USING (true) WITH CHECK (true)`,

    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,

    // 白名单检查，返回该组织当前生效的价格版本（专属价优先于默认价）。内部函数，不授权给应用角色：
    // 它接受任意组织编号，直接开放会让应用角色探测别的组织的专属价。
    sql`CREATE FUNCTION ai_model_price(p_org_id uuid, p_provider text, p_model text) RETURNS uuid
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
          $$`,

    // 网关在解密 Key、冻结之前的预检，组织取 app.org_id。ai_usage_begin 内部会再查一次（与冻结在同一事务）。
    sql`CREATE FUNCTION ai_model_check(p_provider text, p_model text) RETURNS void
          LANGUAGE plpgsql STABLE ${SECURE}
          AS $$
          DECLARE
            v_org_id uuid := public.app_current_org_id();
          BEGIN
            IF v_org_id IS NULL THEN
              RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
            END IF;
            PERFORM public.ai_model_price(v_org_id, p_provider, p_model);
          END
          $$`,

    usageBegin(SELECT_PRICE_0005),

    // 登记模型：默认停用，由管理员确认价格后再启用。服务商和模型名由表的 CHECK 约束校验。
    sql`CREATE FUNCTION ai_admin_register_model(p_provider text, p_model text, p_is_free boolean, p_note text)
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
              INSERT INTO public.platform_models AS m (provider, model, is_free, enabled, note, created_by, updated_by)
              VALUES (p_provider, p_model, p_is_free, false, NULLIF(btrim(p_note), ''), v_operator, v_operator)
              RETURNING m.id, m.created_at;
          END
          $$`,

    sql`CREATE FUNCTION ai_admin_set_model_enabled(p_model_id uuid, p_enabled boolean)
          RETURNS TABLE (model_id uuid, provider text, model text, is_free boolean, enabled boolean, updated_at timestamptz)
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_operator uuid := public.billing_require_platform_admin();
          BEGIN
            IF p_enabled IS NULL THEN
              RAISE EXCEPTION 'enabled is required' USING ERRCODE = '22023';
            END IF;
            RETURN QUERY
              UPDATE public.platform_models m SET enabled = p_enabled, updated_by = v_operator, updated_at = now()
              WHERE m.id = p_model_id
              RETURNING m.id, m.provider, m.model, m.is_free, m.enabled, m.updated_at;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'platform model not found' USING ERRCODE = 'BL014';
            END IF;
          END
          $$`,

    ...[...APP_FUNCTIONS, ...INTERNAL_FUNCTIONS].map((signature) => sql`REVOKE ALL ON FUNCTION ${sql.raw(signature)} FROM PUBLIC`),
    ...APP_FUNCTIONS.map((signature) => sql`GRANT EXECUTE ON FUNCTION ${sql.raw(signature)} TO ${app}`),

    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 函数属主是 bidtools_billing，以它的身份替换和删除。先恢复 0004 的 ai_usage_begin（不再引用 ai_model_price）。
    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    usageBegin(SELECT_PRICE_0004),
    ...[...APP_FUNCTIONS, ...INTERNAL_FUNCTIONS].map((signature) => sql`DROP FUNCTION ${sql.raw(signature)}`),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,

    sql`DROP TABLE platform_models`,
    sql`DROP FUNCTION ai_platform_model_guard_update()`,
  ]);
}
