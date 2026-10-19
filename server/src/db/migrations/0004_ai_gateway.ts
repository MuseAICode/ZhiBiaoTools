// AI 网关的计费（docs/SERVER_DESIGN.md 第 4、10 节）：平台凭据的密文、每次模型调用的用量记录、调用前的预扣冻结。
//
// 预扣冻结（第 10.3 节）：
// - 调用前经 ai_usage_begin 按“已知输入 token 的上界 + 最大输出 token”和当时生效的价格算出最高费用，
//   持本组织余额行的行锁检查“余额 − 进行中的冻结 ≥ 本次冻结”，不足时抛 BL001、不调用服务商；
//   通过时写一行 status = 'pending' 的 usage_records，这一行就是冻结（hold_amount、hold_expires_at）；
// - 调用结束经 ai_usage_settle 按实际用量结算：插入一笔引用该用量记录的扣费（账本触发器用冻结时确定的价格版本计价，
//   金额不超过冻结额），用量记录改为 billed，多余的冻结随之释放；
// - 服务商出错、超时经 ai_usage_fail 改为 unbilled、不收费，冻结全额释放；
// - 冻结超时自动释放：可用余额只计算 hold_expires_at 未到的 pending 记录，进程中途崩溃、没有结算的冻结到期后
//   立即不再占用余额，不依赖任何后台任务；ai_usage_expire_holds 只负责把这些记录标为 unbilled（abandoned）。
//   到期后才到达的结算一律不收费（hold_expired），所以余额仍然不会为负。
//
// 权限沿用 0003_billing：应用角色对 usage_records 只读（且读不到 upstream_cost），写入只能经下面的
// SECURITY DEFINER 函数（属主 bidtools_billing），组织和用户一律取 app.org_id / app.user_id；
// 已结束的用量记录不能再修改，任何角色都不能删除。上游成本单价对应用角色不可见。
//
// 平台凭据（provider_credentials）是平台级配置，没有 org_id。表中只有 AES-256-GCM 密文和被主密钥（KEK）包装的
// 数据密钥，主密钥不进数据库（第 4.2 节）；写入只能经平台管理员函数，解密只在 AI 网关（src/ai/gateway.ts）中进行。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, BILLING_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const billing = sql.id(BILLING_ROLE);

const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

/** 冻结时长的上下限（秒）。网关的上游超时必须短于冻结时长（src/config.ts 校验）。 */
export const MIN_HOLD_SECONDS = 1;
export const MAX_HOLD_SECONDS = 3600;

/** 网关上报的失败原因；hold_expired、abandoned、insufficient_balance 只由数据库函数写入。 */
export const GATEWAY_FAILURE_REASONS = [
  'upstream_error',
  'upstream_timeout',
  'upstream_unreachable',
  'invalid_upstream_response',
  'gateway_error',
] as const;
const FAILURE_REASONS = [...GATEWAY_FAILURE_REASONS, 'hold_expired', 'abandoned', 'insufficient_balance'] as const;

const inList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '));

/** 应用角色可以读的 model_prices 列：除上游成本单价以外的全部列（与 0003_billing 建表时一致）。 */
const MODEL_PRICE_PUBLIC_COLUMNS = sql.raw(
  'id, org_id, provider, model, input_price_per_mtok, output_price_per_mtok, effective_from, created_by, note, created_at',
);
/** 应用角色可以读的 usage_records 列：除 upstream_cost 以外的全部列。 */
const USAGE_PUBLIC_COLUMNS = sql.raw(
  'id, org_id, user_id, request_id, source, job_id, job_type, provider, model, price_id, estimated_input_tokens, ' +
    'max_output_tokens, hold_amount, hold_expires_at, status, failure_reason, input_tokens, cached_input_tokens, ' +
    'output_tokens, usage_source, amount, ledger_entry_id, started_at, finished_at',
);

const APP_FUNCTIONS = [
  'ai_usage_begin(uuid, text, uuid, text, text, text, bigint, bigint, integer)',
  'ai_usage_settle(uuid, bigint, bigint, bigint, text)',
  'ai_usage_fail(uuid, text, bigint, bigint, bigint)',
  'ai_usage_expire_holds()',
  'ai_admin_put_credential(uuid, text, text, text, bytea, bytea, bytea, bytea, integer, text)',
  'billing_admin_add_price(uuid, text, text, bigint, bigint, timestamptz, text, bigint, bigint)',
] as const;
const INTERNAL_FUNCTIONS = ['billing_active_holds(uuid)', 'billing_upstream_cost(uuid, bigint, bigint)'] as const;

/** 账本触发器在 0003_billing 中的定义，down 时恢复。 */
const LEDGER_APPLY_0003 = sql`CREATE OR REPLACE FUNCTION billing_ledger_apply() RETURNS trigger
      LANGUAGE plpgsql ${SECURE}
      AS $$
      DECLARE
        v_balance bigint;
        v_price public.model_prices%ROWTYPE;
        v_original public.billing_ledger%ROWTYPE;
      BEGIN
        INSERT INTO public.org_balances (org_id) VALUES (NEW.org_id) ON CONFLICT (org_id) DO NOTHING;
        SELECT b.balance INTO v_balance FROM public.org_balances b WHERE b.org_id = NEW.org_id FOR UPDATE;

        NEW.created_at := now();
        IF NEW.entry_type = 'charge' THEN
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
          NEW.price_id := v_price.id;
          NEW.amount := -public.billing_charge_amount(
            NEW.input_tokens, NEW.output_tokens, v_price.input_price_per_mtok, v_price.output_price_per_mtok);
          NEW.operator_user_id := public.app_current_user_id();
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

        IF v_balance + NEW.amount < 0 THEN
          RAISE EXCEPTION 'insufficient balance' USING ERRCODE = 'BL001';
        END IF;
        NEW.balance_after := v_balance + NEW.amount;
        UPDATE public.org_balances SET balance = NEW.balance_after, updated_at = now() WHERE org_id = NEW.org_id;
        RETURN NEW;
      END
      $$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 上游成本单价（每百万 token，计费单位），仅平台管理员可见，用于 usage_records.upstream_cost。
    // 两列同时为空表示未录入，此时上游成本记为未知（NULL）。
    sql`ALTER TABLE model_prices
          ADD COLUMN upstream_input_price_per_mtok bigint CHECK (upstream_input_price_per_mtok >= 0),
          ADD COLUMN upstream_output_price_per_mtok bigint CHECK (upstream_output_price_per_mtok >= 0),
          ADD CONSTRAINT model_prices_upstream_pair
            CHECK ((upstream_input_price_per_mtok IS NULL) = (upstream_output_price_per_mtok IS NULL))`,
    sql`REVOKE SELECT ON model_prices FROM ${app}`,
    sql`GRANT SELECT (${MODEL_PRICE_PUBLIC_COLUMNS}) ON model_prices TO ${app}`,

    // 每次模型调用一行，包括不收费的调用。status = 'pending' 的行同时是该调用的冻结。
    // org_id 外键不级联、user_id 不设外键，理由同 billing_ledger（财务记录）。job_id 暂不设外键：jobs 表在第 6 步建。
    sql`CREATE TABLE usage_records (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id),
          user_id uuid NOT NULL,
          request_id uuid NOT NULL,
          source text NOT NULL CHECK (source IN ('interactive', 'job')),
          job_id uuid,
          job_type text CHECK (job_type ~ '^[a-z][a-z0-9-]{0,63}$'),
          provider text NOT NULL CHECK (provider IN ('deepseek', 'qwen')),
          model text NOT NULL CHECK (char_length(model) <= 128),
          price_id uuid NOT NULL REFERENCES model_prices (id),
          estimated_input_tokens bigint NOT NULL CHECK (estimated_input_tokens BETWEEN 0 AND 1000000000),
          max_output_tokens bigint NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 1000000000),
          hold_amount bigint NOT NULL CHECK (hold_amount >= 0),
          hold_expires_at timestamptz NOT NULL,
          status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'billed', 'unbilled')),
          failure_reason text CHECK (failure_reason IN (${inList(FAILURE_REASONS)})),
          input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 1000000000),
          cached_input_tokens bigint CHECK (cached_input_tokens BETWEEN 0 AND 1000000000 AND cached_input_tokens <= input_tokens),
          output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 1000000000),
          usage_source text CHECK (usage_source IN ('provider', 'estimated')),
          amount bigint NOT NULL DEFAULT 0 CHECK (amount >= 0 AND amount <= hold_amount),
          upstream_cost bigint CHECK (upstream_cost >= 0),
          ledger_entry_id uuid,
          started_at timestamptz NOT NULL DEFAULT now(),
          finished_at timestamptz,
          CONSTRAINT usage_records_org_id_id_key UNIQUE (org_id, id),
          CONSTRAINT usage_records_request_key UNIQUE (org_id, request_id),
          CONSTRAINT usage_records_ledger_fkey FOREIGN KEY (org_id, ledger_entry_id) REFERENCES billing_ledger (org_id, id),
          CONSTRAINT usage_records_job CHECK ((source = 'job') = (job_id IS NOT NULL) AND (job_type IS NULL OR job_id IS NOT NULL)),
          CONSTRAINT usage_records_shape CHECK (CASE status
            WHEN 'pending' THEN finished_at IS NULL AND failure_reason IS NULL AND amount = 0 AND ledger_entry_id IS NULL
              AND input_tokens IS NULL AND output_tokens IS NULL AND usage_source IS NULL
            WHEN 'billed' THEN finished_at IS NOT NULL AND failure_reason IS NULL AND ledger_entry_id IS NOT NULL
              AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND usage_source IS NOT NULL
            ELSE finished_at IS NOT NULL AND failure_reason IS NOT NULL AND amount = 0 AND ledger_entry_id IS NULL
          END)
        )`,
    sql`CREATE INDEX usage_records_org_id_started_at_idx ON usage_records (org_id, started_at)`,
    sql`CREATE INDEX usage_records_org_id_job_id_idx ON usage_records (org_id, job_id) WHERE job_id IS NOT NULL`,
    sql`CREATE INDEX usage_records_org_model_idx ON usage_records (org_id, provider, model, started_at)`,
    sql`CREATE INDEX usage_records_pending_org_idx ON usage_records (org_id, hold_expires_at) WHERE status = 'pending'`,
    sql`CREATE INDEX usage_records_pending_expiry_idx ON usage_records (hold_expires_at) WHERE status = 'pending'`,

    // 结算的扣费引用用量记录；每条用量记录最多结算一次。只有计费函数能写这一列（应用角色没有该列的 INSERT 权限）。
    sql`ALTER TABLE billing_ledger
          ADD COLUMN usage_id uuid,
          ADD CONSTRAINT billing_ledger_usage_fkey FOREIGN KEY (org_id, usage_id) REFERENCES usage_records (org_id, id),
          ADD CONSTRAINT billing_ledger_usage_charge CHECK (usage_id IS NULL OR entry_type = 'charge')`,
    sql`CREATE UNIQUE INDEX billing_ledger_usage_key ON billing_ledger (usage_id) WHERE usage_id IS NOT NULL`,

    // 已结束的用量记录不可修改，标识列在任何时候都不可修改；任何角色都不能删除（表属主同样受约束）。
    sql`CREATE FUNCTION ai_usage_guard_update() RETURNS trigger
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
               OR NEW.hold_amount IS DISTINCT FROM OLD.hold_amount OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
              RAISE EXCEPTION 'usage record is immutable' USING ERRCODE = 'BL003';
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER usage_records_guard_update BEFORE UPDATE ON usage_records
          FOR EACH ROW EXECUTE FUNCTION ai_usage_guard_update()`,
    sql`CREATE TRIGGER usage_records_no_delete BEFORE DELETE ON usage_records
          FOR EACH ROW EXECUTE FUNCTION billing_reject_change()`,
    sql`CREATE TRIGGER usage_records_no_truncate BEFORE TRUNCATE ON usage_records
          FOR EACH STATEMENT EXECUTE FUNCTION billing_reject_change()`,

    // 平台凭据：每个 (kind, provider) 一条。AAD 绑定 id | kind | provider | base_url（src/ai/credentials.ts），
    // 把密文复制到另一行或改掉 Base URL，解密都会失败。
    sql`CREATE TABLE provider_credentials (
          id uuid PRIMARY KEY,
          kind text NOT NULL CHECK (kind IN ('text_model')),
          provider text NOT NULL CHECK (provider IN ('deepseek', 'qwen')),
          base_url text NOT NULL CHECK (char_length(base_url) BETWEEN 1 AND 500),
          ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 4096),
          iv bytea NOT NULL CHECK (octet_length(iv) = 12),
          auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
          wrapped_dek bytea NOT NULL CHECK (octet_length(wrapped_dek) BETWEEN 1 AND 1024),
          kek_version integer NOT NULL CHECK (kek_version >= 1),
          last4 text NOT NULL CHECK (char_length(last4) <= 4),
          created_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT provider_credentials_kind_provider_key UNIQUE (kind, provider)
        )`,

    ...['usage_records', 'provider_credentials'].flatMap((table) => [
      sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`,
      sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`,
    ]),

    // 应用角色：用量记录只能读本组织的、读不到上游成本；平台凭据只读（只有密文，没有主密钥无法解密），
    // 未设置组织上下文时什么都读不到。
    sql`CREATE POLICY usage_records_select_tenant ON usage_records FOR SELECT TO ${app}
          USING (org_id = app_current_org_id())`,
    sql`CREATE POLICY provider_credentials_select ON provider_credentials FOR SELECT TO ${app}
          USING (app_current_org_id() IS NOT NULL)`,
    sql`GRANT SELECT (${USAGE_PUBLIC_COLUMNS}) ON usage_records TO ${app}`,
    sql`GRANT SELECT ON provider_credentials TO ${app}`,

    sql`GRANT SELECT, INSERT, UPDATE ON usage_records TO ${billing}`,
    sql`GRANT SELECT, INSERT, DELETE ON provider_credentials TO ${billing}`,
    sql`CREATE POLICY usage_records_billing ON usage_records TO ${billing} USING (true) WITH CHECK (true)`,
    sql`CREATE POLICY provider_credentials_billing ON provider_credentials TO ${billing} USING (true) WITH CHECK (true)`,

    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,

    // 本组织进行中的冻结总额：pending 且未到期。到期的冻结不再占用余额（自动释放）。
    sql`CREATE FUNCTION billing_active_holds(p_org_id uuid) RETURNS bigint
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT coalesce(sum(u.hold_amount), 0)::bigint FROM public.usage_records u
            WHERE u.org_id = p_org_id AND u.status = 'pending' AND u.hold_expires_at > now()
          $$`,

    // 上游成本：按该价格版本的上游单价计算；未录入上游单价时为 NULL（未知）。
    sql`CREATE FUNCTION billing_upstream_cost(p_price_id uuid, p_input_tokens bigint, p_output_tokens bigint) RETURNS bigint
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT public.billing_charge_amount(
              p_input_tokens, p_output_tokens, p.upstream_input_price_per_mtok, p.upstream_output_price_per_mtok)
            FROM public.model_prices p WHERE p.id = p_price_id
          $$`,

    // 账本触发器：在 0003_billing 的基础上增加两点。
    // 1. 结算（usage_id 非空）：用量记录必须是本组织未到期的冻结；价格用冻结时确定的版本，金额不超过冻结额；
    // 2. 不经冻结的直接扣费（chargeUsage）：余额检查扣除进行中的冻结，不会占用别的调用已冻结的金额。
    sql`CREATE OR REPLACE FUNCTION billing_ledger_apply() RETURNS trigger
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
              NEW.request_id := v_usage.request_id;
              NEW.provider := v_usage.provider;
              NEW.model := v_usage.model;
              NEW.price_id := v_price.id;
              NEW.amount := -least(
                public.billing_charge_amount(
                  NEW.input_tokens, NEW.output_tokens, v_price.input_price_per_mtok, v_price.output_price_per_mtok),
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
          $$`,

    // 调用前冻结：组织和用户取自 app.org_id / app.user_id。冻结额按 numeric 精确计算后向上取整。
    sql`CREATE FUNCTION ai_usage_begin(
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

            SELECT p.* INTO v_price FROM public.model_prices p
              WHERE p.provider = p_provider AND p.model = p_model AND p.effective_from <= now()
                AND (p.org_id IS NULL OR p.org_id = v_org_id)
              ORDER BY (p.org_id IS NOT NULL) DESC, p.effective_from DESC
              LIMIT 1;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'no price for model' USING ERRCODE = 'BL002';
            END IF;

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
          $$`,

    // 按实际用量结算。先锁余额行、再锁用量记录（与账本触发器的加锁顺序一致）。
    // 冻结已到期：不收费（hold_expired）；结算时余额已不足（冻结后被冲正）：不收费（insufficient_balance）。
    sql`CREATE FUNCTION ai_usage_settle(
          p_usage_id uuid, p_input_tokens bigint, p_cached_input_tokens bigint, p_output_tokens bigint, p_usage_source text
        ) RETURNS TABLE (status text, amount bigint, balance_after bigint, ledger_entry_id uuid)
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_org_id uuid := public.app_current_org_id();
            v_usage public.usage_records%ROWTYPE;
            v_entry_id uuid;
            v_amount bigint;
            v_balance_after bigint;
            v_cost bigint;
          BEGIN
            IF v_org_id IS NULL THEN
              RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
            END IF;
            IF p_usage_source IS NULL OR p_usage_source NOT IN ('provider', 'estimated')
               OR p_input_tokens IS NULL OR p_output_tokens IS NULL THEN
              RAISE EXCEPTION 'invalid usage' USING ERRCODE = '22023';
            END IF;
            PERFORM 1 FROM public.org_balances b WHERE b.org_id = v_org_id FOR UPDATE;
            SELECT u.* INTO v_usage FROM public.usage_records u WHERE u.id = p_usage_id AND u.org_id = v_org_id FOR UPDATE;
            IF NOT FOUND OR v_usage.status <> 'pending' THEN
              RAISE EXCEPTION 'usage is not pending' USING ERRCODE = 'BL010';
            END IF;
            v_cost := public.billing_upstream_cost(v_usage.price_id, p_input_tokens, p_output_tokens);

            IF v_usage.hold_expires_at <= now() THEN
              UPDATE public.usage_records u SET status = 'unbilled', failure_reason = 'hold_expired',
                input_tokens = p_input_tokens, cached_input_tokens = p_cached_input_tokens, output_tokens = p_output_tokens,
                usage_source = p_usage_source, upstream_cost = v_cost, finished_at = now()
                WHERE u.id = p_usage_id;
              RETURN QUERY SELECT 'unbilled'::text, 0::bigint, NULL::bigint, NULL::uuid;
              RETURN;
            END IF;

            BEGIN
              INSERT INTO public.billing_ledger AS l (org_id, entry_type, usage_id, input_tokens, output_tokens)
                VALUES (v_org_id, 'charge', p_usage_id, p_input_tokens, p_output_tokens)
                RETURNING l.id, -l.amount, l.balance_after INTO v_entry_id, v_amount, v_balance_after;
            EXCEPTION WHEN SQLSTATE 'BL001' THEN
              UPDATE public.usage_records u SET status = 'unbilled', failure_reason = 'insufficient_balance',
                input_tokens = p_input_tokens, cached_input_tokens = p_cached_input_tokens, output_tokens = p_output_tokens,
                usage_source = p_usage_source, upstream_cost = v_cost, finished_at = now()
                WHERE u.id = p_usage_id;
              RETURN QUERY SELECT 'unbilled'::text, 0::bigint, NULL::bigint, NULL::uuid;
              RETURN;
            END;

            UPDATE public.usage_records u SET status = 'billed', input_tokens = p_input_tokens,
              cached_input_tokens = p_cached_input_tokens, output_tokens = p_output_tokens, usage_source = p_usage_source,
              amount = v_amount, upstream_cost = v_cost, ledger_entry_id = v_entry_id, finished_at = now()
              WHERE u.id = p_usage_id;
            RETURN QUERY SELECT 'billed'::text, v_amount, v_balance_after, v_entry_id;
          END
          $$`,

    // 调用失败：不收费，冻结全额释放。服务商返回了用量时一并记录，用于计算平台承担的上游成本。
    sql`CREATE FUNCTION ai_usage_fail(
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
            IF p_reason IS NULL OR p_reason NOT IN (${inList(GATEWAY_FAILURE_REASONS)}) THEN
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
          $$`,

    // 把已到期、未结算的冻结标为 unbilled（abandoned）。跨组织执行，只处理到期的 pending 记录；
    // 跳过正被结算锁住的行，多个实例同时执行也不会互相等待。到期的冻结在此之前就已不占用余额。
    sql`CREATE FUNCTION ai_usage_expire_holds() RETURNS integer
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_count integer;
          BEGIN
            UPDATE public.usage_records u SET status = 'unbilled', failure_reason = 'abandoned', finished_at = now()
              WHERE u.id IN (
                SELECT x.id FROM public.usage_records x
                WHERE x.status = 'pending' AND x.hold_expires_at <= now()
                ORDER BY x.hold_expires_at
                LIMIT 1000
                FOR UPDATE SKIP LOCKED);
            GET DIAGNOSTICS v_count = ROW_COUNT;
            RETURN v_count;
          END
          $$`,

    // 平台管理员写入（替换）一条平台凭据。加密在应用中完成，这里只存密文；操作人取 app.user_id。
    sql`CREATE FUNCTION ai_admin_put_credential(
          p_id uuid, p_kind text, p_provider text, p_base_url text, p_ciphertext bytea, p_iv bytea, p_auth_tag bytea,
          p_wrapped_dek bytea, p_kek_version integer, p_last4 text
        ) RETURNS TABLE (credential_id uuid, created_at timestamptz)
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_operator uuid := public.billing_require_platform_admin();
          BEGIN
            DELETE FROM public.provider_credentials c WHERE c.kind = p_kind AND c.provider = p_provider;
            RETURN QUERY
              INSERT INTO public.provider_credentials AS c
                (id, kind, provider, base_url, ciphertext, iv, auth_tag, wrapped_dek, kek_version, last4, created_by)
              VALUES (p_id, p_kind, p_provider, p_base_url, p_ciphertext, p_iv, p_auth_tag, p_wrapped_dek, p_kek_version,
                      p_last4, v_operator)
              RETURNING c.id, c.created_at;
          END
          $$`,

    // 新增价格版本，带上游成本单价（0003_billing 的 7 参数版本保留，上游单价为空）。
    sql`CREATE FUNCTION billing_admin_add_price(
          p_org_id uuid, p_provider text, p_model text, p_input_price bigint, p_output_price bigint,
          p_effective_from timestamptz, p_note text, p_upstream_input_price bigint, p_upstream_output_price bigint
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
            IF (p_upstream_input_price IS NULL) <> (p_upstream_output_price IS NULL) THEN
              RAISE EXCEPTION 'upstream prices must be set together' USING ERRCODE = '22023';
            END IF;
            RETURN QUERY
              INSERT INTO public.model_prices AS p
                (org_id, provider, model, input_price_per_mtok, output_price_per_mtok, effective_from, created_by, note,
                 upstream_input_price_per_mtok, upstream_output_price_per_mtok)
              VALUES (p_org_id, p_provider, p_model, p_input_price, p_output_price, v_effective_from, v_operator,
                      NULLIF(btrim(p_note), ''), p_upstream_input_price, p_upstream_output_price)
              RETURNING p.id, p.effective_from;
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
    // 先恢复 0003 的触发器函数（不再引用 usage_records），再删表。函数属主是 bidtools_billing，以它的身份替换和删除。
    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    LEDGER_APPLY_0003,
    ...[...APP_FUNCTIONS, ...INTERNAL_FUNCTIONS].map((signature) => sql`DROP FUNCTION ${sql.raw(signature)}`),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,

    sql`DROP INDEX billing_ledger_usage_key`,
    sql`ALTER TABLE billing_ledger DROP CONSTRAINT billing_ledger_usage_charge, DROP CONSTRAINT billing_ledger_usage_fkey`,
    sql`DROP TABLE usage_records, provider_credentials`,
    sql`ALTER TABLE billing_ledger DROP COLUMN usage_id`,
    sql`DROP FUNCTION ai_usage_guard_update()`,

    // 列级授权不随表级 REVOKE 收回，逐一收回后恢复 0003 的表级授权。
    sql`REVOKE SELECT (${MODEL_PRICE_PUBLIC_COLUMNS}) ON model_prices FROM ${app}`,
    sql`GRANT SELECT ON model_prices TO ${app}`,
    sql`ALTER TABLE model_prices DROP CONSTRAINT model_prices_upstream_pair,
          DROP COLUMN upstream_input_price_per_mtok, DROP COLUMN upstream_output_price_per_mtok`,
  ]);
}
