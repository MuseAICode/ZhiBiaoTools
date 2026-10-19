// 计费账本（docs/SERVER_DESIGN.md 第 10.2、10.4、10.5 节）：组织余额、只追加的账本、带版本的价格表。
// 本迁移不调用任何 AI，只提供扣费、充值、冲正和定价的数据库层。
//
// 金额一律是 bigint 整数，单位为“计费单位”（0.0001 元），任何地方都不用浮点。
//
// 不变式由数据库保证，不依赖应用代码：
// - 余额只能经账本变化：org_balances 对应用角色只读，账本的 BEFORE INSERT 触发器（属主 bidtools_billing）
//   在同一语句中锁住余额行、计算 balance_after、更新余额。插入失败时余额更新随语句一起回滚，
//   所以 balance = Σ billing_ledger.amount 恒成立；
// - 余额不为负：触发器先 SELECT ... FOR UPDATE 锁住本组织的余额行（同一组织的扣费因此串行），
//   不足时抛 BL001；表上另有 CHECK (balance >= 0) 兜底；
// - 扣费幂等：同一组织同一 request_id 只扣一次。触发器在持锁后发现已有记录时返回 NULL（跳过本行，不报错），
//   (org_id, request_id) 唯一约束兜底。不能用 ON CONFLICT DO NOTHING：BEFORE 触发器先于冲突检测执行，
//   被跳过的行也会改到余额；
// - 扣费金额由触发器按价格表计算，应用只能写入用量（列级授权），不能指定金额；
// - 账本和价格表只追加：没有任何角色被授予 UPDATE / DELETE / TRUNCATE，另有触发器拒绝这三种操作（表属主同样）；
//   录错只能由平台管理员新增一笔冲正（reversal），改价只能新增生效时间不早于当前时刻的新版本；
// - 应用角色只能插入本组织的扣费（charge）；充值、赠送、冲正、新增价格只能经下面的 SECURITY DEFINER 函数，
//   函数内校验调用者（app.user_id）是正常状态的平台管理员。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, BILLING_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const billing = sql.id(BILLING_ROLE);

/**
 * 管理员单笔手动充值 / 赠送的上限（计费单位）：1,000 元。
 * 设计要求大额充值经 TOTP 二次验证和第二位平台管理员复核（第 10.5 节），两者都尚未实现，
 * 所以超过上限的充值暂时一律拒绝（docs/MIGRATION_PLAN.md 第 3 步说明）。改上限需要新迁移。
 */
export const MAX_MANUAL_CREDIT_UNITS = 10_000_000n;

/** 函数签名，up 中授权和 down 中删除共用。 */
const ADMIN_FUNCTIONS = [
  'billing_admin_credit(uuid, text, bigint, text, text)',
  'billing_admin_reverse(uuid, text)',
  'billing_admin_add_price(uuid, text, text, bigint, bigint, timestamptz, text)',
] as const;
const INTERNAL_FUNCTIONS = ['billing_require_platform_admin()', 'billing_ledger_apply()'] as const;

const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 计价：用量 + 单价（每百万 token）→ 金额，向上取整到计费单位。numeric 精确计算，不经过浮点；
    // 结果超出 bigint 时报错而不是截断。纯函数，属主为迁移角色，所有人可调用。
    sql`CREATE FUNCTION billing_charge_amount(
          p_input_tokens bigint, p_output_tokens bigint, p_input_price bigint, p_output_price bigint
        ) RETURNS bigint
          LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
          AS $$
            SELECT ceil((p_input_tokens::numeric * p_input_price + p_output_tokens::numeric * p_output_price) / 1000000)::bigint
          $$`,

    // 每组织一行。没有行等价于余额 0，首次入账时由触发器创建。
    sql`CREATE TABLE org_balances (
          org_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
          balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`,

    // 价格表。org_id 为空是平台默认价，非空是该组织的专属价（优先于默认价）。
    // 同一 (组织, 服务商, 模型) 在某一时刻生效的是 effective_from 最晚且不晚于该时刻的版本；
    // 没有 effective_to，旧版本不需要被改写。effective_from 不早于录入时刻，历史扣费不会因新版本而变。
    // created_by 不设外键：价格是财务记录，不随用户删除而改动。
    sql`CREATE TABLE model_prices (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid REFERENCES organizations (id),
          provider text NOT NULL CHECK (provider IN ('deepseek', 'qwen')),
          model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
          input_price_per_mtok bigint NOT NULL CHECK (input_price_per_mtok >= 0),
          output_price_per_mtok bigint NOT NULL CHECK (output_price_per_mtok >= 0),
          effective_from timestamptz NOT NULL,
          created_by uuid NOT NULL,
          note text CHECK (char_length(note) <= 500),
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT model_prices_not_backdated CHECK (effective_from >= created_at),
          CONSTRAINT model_prices_version_key UNIQUE NULLS NOT DISTINCT (org_id, provider, model, effective_from)
        )`,
    sql`CREATE INDEX model_prices_lookup_idx ON model_prices (provider, model, effective_from DESC)`,

    // 只追加的账本。amount 有符号：充值、赠送为正，扣费为负或 0，冲正与原记录相反。
    // org_id 外键不级联：有账本的组织不能被直接删除（财务记录的保留期待第 11 节确认）。
    // operator_user_id 不设外键，理由同 created_by：扣费为触发调用的用户，充值和冲正为平台管理员。
    sql`CREATE TABLE billing_ledger (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id),
          entry_type text NOT NULL CHECK (entry_type IN ('recharge', 'grant', 'charge', 'reversal')),
          amount bigint NOT NULL,
          balance_after bigint NOT NULL CHECK (balance_after >= 0),
          request_id uuid,
          provider text CHECK (provider IN ('deepseek', 'qwen')),
          model text CHECK (char_length(model) <= 128),
          input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 1000000000),
          output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 1000000000),
          price_id uuid REFERENCES model_prices (id),
          reference text CHECK (char_length(reference) <= 200),
          note text CHECK (char_length(note) <= 500),
          operator_user_id uuid,
          related_entry_id uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT billing_ledger_org_id_id_key UNIQUE (org_id, id),
          CONSTRAINT billing_ledger_request_key UNIQUE (org_id, request_id),
          -- 冲正只能引用同一组织的记录。
          CONSTRAINT billing_ledger_related_fkey FOREIGN KEY (org_id, related_entry_id)
            REFERENCES billing_ledger (org_id, id),
          CONSTRAINT billing_ledger_shape CHECK (CASE entry_type
            WHEN 'charge' THEN amount <= 0 AND request_id IS NOT NULL AND provider IS NOT NULL AND model IS NOT NULL
              AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND price_id IS NOT NULL
              AND related_entry_id IS NULL AND reference IS NULL
            WHEN 'reversal' THEN amount <> 0 AND related_entry_id IS NOT NULL AND operator_user_id IS NOT NULL
              AND note IS NOT NULL AND request_id IS NULL
            ELSE amount > 0 AND operator_user_id IS NOT NULL AND note IS NOT NULL
              AND request_id IS NULL AND related_entry_id IS NULL
          END)
        )`,
    // 每笔记录最多被冲正一次。
    sql`CREATE UNIQUE INDEX billing_ledger_reversal_key ON billing_ledger (related_entry_id) WHERE entry_type = 'reversal'`,
    sql`CREATE INDEX billing_ledger_org_id_created_at_idx ON billing_ledger (org_id, created_at)`,

    // 只追加：拒绝 UPDATE / DELETE / TRUNCATE，表属主同样受约束（普通函数，属主为迁移角色）。
    sql`CREATE FUNCTION billing_reject_change() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'BL003';
          END
          $$`,
    ...['billing_ledger', 'model_prices'].flatMap((table) => [
      sql`CREATE TRIGGER ${sql.id(`${table}_append_only`)} BEFORE UPDATE OR DELETE ON ${sql.table(table)}
            FOR EACH ROW EXECUTE FUNCTION billing_reject_change()`,
      sql`CREATE TRIGGER ${sql.id(`${table}_no_truncate`)} BEFORE TRUNCATE ON ${sql.table(table)}
            FOR EACH STATEMENT EXECUTE FUNCTION billing_reject_change()`,
    ]),

    ...['org_balances', 'model_prices', 'billing_ledger'].flatMap((table) => [
      sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`,
      sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`,
    ]),

    // 应用角色：余额和账本只能读本组织；账本只能插入本组织的扣费，且只能写用量列。
    // 价格表能读平台默认价和本组织的专属价；未设置组织上下文时什么都读不到。
    sql`CREATE POLICY org_balances_tenant ON org_balances FOR SELECT TO ${app}
          USING (org_id = app_current_org_id())`,
    sql`CREATE POLICY billing_ledger_select_tenant ON billing_ledger FOR SELECT TO ${app}
          USING (org_id = app_current_org_id())`,
    sql`CREATE POLICY billing_ledger_insert_charge ON billing_ledger FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND entry_type = 'charge')`,
    sql`CREATE POLICY model_prices_select_visible ON model_prices FOR SELECT TO ${app}
          USING (app_current_org_id() IS NOT NULL AND (org_id IS NULL OR org_id = app_current_org_id()))`,
    sql`GRANT SELECT ON org_balances, model_prices, billing_ledger TO ${app}`,
    sql`GRANT INSERT (org_id, entry_type, request_id, provider, model, input_tokens, output_tokens) ON billing_ledger TO ${app}`,

    // bidtools_billing：账本和价格表只有 SELECT、INSERT；余额由触发器读写；
    // 校验平台管理员要读 users 的三列，校验组织存在要读 organizations.id。
    sql`GRANT USAGE ON SCHEMA public TO ${billing}`,
    sql`GRANT SELECT, INSERT, UPDATE (balance, updated_at) ON org_balances TO ${billing}`,
    sql`GRANT SELECT, INSERT ON billing_ledger, model_prices TO ${billing}`,
    sql`GRANT SELECT (id, is_platform_admin, status) ON users TO ${billing}`,
    sql`GRANT SELECT (id) ON organizations TO ${billing}`,
    sql`CREATE POLICY org_balances_billing ON org_balances TO ${billing} USING (true) WITH CHECK (true)`,
    sql`CREATE POLICY billing_ledger_billing ON billing_ledger TO ${billing} USING (true) WITH CHECK (true)`,
    sql`CREATE POLICY model_prices_billing ON model_prices TO ${billing} USING (true) WITH CHECK (true)`,
    sql`CREATE POLICY users_billing_functions ON users FOR SELECT TO ${billing} USING (true)`,
    sql`CREATE POLICY organizations_billing_functions ON organizations FOR SELECT TO ${billing} USING (true)`,

    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,

    // 账本的 BEFORE INSERT 触发器：所有入账（扣费、充值、赠送、冲正）都经过这里。
    sql`CREATE FUNCTION billing_ledger_apply() RETURNS trigger
          LANGUAGE plpgsql ${SECURE}
          AS $$
          DECLARE
            v_balance bigint;
            v_price public.model_prices%ROWTYPE;
            v_original public.billing_ledger%ROWTYPE;
          BEGIN
            -- 锁住本组织的余额行：同一组织的入账从这里开始串行，持锁到事务结束。
            INSERT INTO public.org_balances (org_id) VALUES (NEW.org_id) ON CONFLICT (org_id) DO NOTHING;
            SELECT b.balance INTO v_balance FROM public.org_balances b WHERE b.org_id = NEW.org_id FOR UPDATE;

            NEW.created_at := now();
            IF NEW.entry_type = 'charge' THEN
              IF NEW.request_id IS NULL OR NEW.provider IS NULL OR NEW.model IS NULL
                 OR NEW.input_tokens IS NULL OR NEW.output_tokens IS NULL THEN
                RAISE EXCEPTION 'charge requires request_id, provider, model and token counts' USING ERRCODE = '23502';
              END IF;
              -- 幂等：持锁后再查，并发的同一请求只有第一个入账，其余跳过本行。
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
          $$`,

    // 触发器由表属主创建：建触发器时需要函数的 EXECUTE 权限，所以在收回 PUBLIC 的权限之前创建（触发时不再检查）。
    sql`RESET ROLE`,
    sql`CREATE TRIGGER billing_ledger_apply BEFORE INSERT ON billing_ledger
          FOR EACH ROW EXECUTE FUNCTION billing_ledger_apply()`,
    sql`SET ROLE ${billing}`,

    // 调用者（app.user_id）必须是正常状态的平台管理员，否则抛 42501。只在下面的函数内部使用。
    sql`CREATE FUNCTION billing_require_platform_admin() RETURNS uuid
          LANGUAGE plpgsql STABLE ${SECURE}
          AS $$
          DECLARE
            v_user_id uuid := public.app_current_user_id();
          BEGIN
            IF v_user_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.users u WHERE u.id = v_user_id AND u.is_platform_admin AND u.status = 'active'
            ) THEN
              RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
            END IF;
            RETURN v_user_id;
          END
          $$`,

    // 管理员手动充值 / 赠送：金额为正且不超过单笔上限，必须填写备注；操作人取 app.user_id。
    sql`CREATE FUNCTION billing_admin_credit(
          p_org_id uuid, p_entry_type text, p_amount bigint, p_reference text, p_note text
        ) RETURNS TABLE (entry_id uuid, balance_after bigint, created_at timestamptz)
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_operator uuid := public.billing_require_platform_admin();
          BEGIN
            IF p_entry_type IS NULL OR p_entry_type NOT IN ('recharge', 'grant') THEN
              RAISE EXCEPTION 'invalid credit type' USING ERRCODE = '22023';
            END IF;
            IF p_amount IS NULL OR p_amount <= 0 THEN
              RAISE EXCEPTION 'amount must be positive' USING ERRCODE = '22023';
            END IF;
            IF p_amount > ${sql.raw(MAX_MANUAL_CREDIT_UNITS.toString())} THEN
              RAISE EXCEPTION 'credit exceeds manual limit' USING ERRCODE = 'BL006';
            END IF;
            IF p_note IS NULL OR btrim(p_note) = '' THEN
              RAISE EXCEPTION 'note is required' USING ERRCODE = '22023';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org_id) THEN
              RAISE EXCEPTION 'organization not found' USING ERRCODE = 'BL007';
            END IF;
            RETURN QUERY
              INSERT INTO public.billing_ledger AS l (org_id, entry_type, amount, reference, note, operator_user_id)
              VALUES (p_org_id, p_entry_type, p_amount, NULLIF(btrim(p_reference), ''), btrim(p_note), v_operator)
              RETURNING l.id, l.balance_after, l.created_at;
          END
          $$`,

    // 冲正：新增一笔与原记录金额相反的记录并引用它，每笔最多冲正一次；冲正后余额不能为负。
    sql`CREATE FUNCTION billing_admin_reverse(p_entry_id uuid, p_note text)
          RETURNS TABLE (entry_id uuid, org_id uuid, amount bigint, balance_after bigint, created_at timestamptz)
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_operator uuid := public.billing_require_platform_admin();
            v_org_id uuid;
          BEGIN
            IF p_note IS NULL OR btrim(p_note) = '' THEN
              RAISE EXCEPTION 'note is required' USING ERRCODE = '22023';
            END IF;
            SELECT l.org_id INTO v_org_id FROM public.billing_ledger l WHERE l.id = p_entry_id;
            IF v_org_id IS NULL THEN
              RAISE EXCEPTION 'entry cannot be reversed' USING ERRCODE = 'BL004';
            END IF;
            RETURN QUERY
              INSERT INTO public.billing_ledger AS l (org_id, entry_type, related_entry_id, note, operator_user_id)
              VALUES (v_org_id, 'reversal', p_entry_id, btrim(p_note), v_operator)
              RETURNING l.id, l.org_id, l.amount, l.balance_after, l.created_at;
          END
          $$`,

    // 新增价格版本：生效时间不早于当前时刻（缺省为立即生效）；org_id 为空表示平台默认价。
    sql`CREATE FUNCTION billing_admin_add_price(
          p_org_id uuid, p_provider text, p_model text, p_input_price bigint, p_output_price bigint,
          p_effective_from timestamptz, p_note text
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
            RETURN QUERY
              INSERT INTO public.model_prices AS p
                (org_id, provider, model, input_price_per_mtok, output_price_per_mtok, effective_from, created_by, note)
              VALUES (p_org_id, p_provider, p_model, p_input_price, p_output_price, v_effective_from, v_operator,
                      NULLIF(btrim(p_note), ''))
              RETURNING p.id, p.effective_from;
          END
          $$`,

    ...[...ADMIN_FUNCTIONS, ...INTERNAL_FUNCTIONS].map((signature) => sql`REVOKE ALL ON FUNCTION ${sql.raw(signature)} FROM PUBLIC`),
    ...ADMIN_FUNCTIONS.map((signature) => sql`GRANT EXECUTE ON FUNCTION ${sql.raw(signature)} TO ${app}`),

    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`DROP TABLE billing_ledger, model_prices, org_balances`,
    sql`DROP FUNCTION billing_reject_change()`,
    sql`DROP FUNCTION billing_charge_amount(bigint, bigint, bigint, bigint)`,

    // 函数属主是 bidtools_billing，以它的身份删除。
    sql`SET ROLE ${billing}`,
    ...[...ADMIN_FUNCTIONS, ...INTERNAL_FUNCTIONS].map((signature) => sql`DROP FUNCTION ${sql.raw(signature)}`),
    sql`RESET ROLE`,

    sql`DROP POLICY users_billing_functions ON users`,
    sql`DROP POLICY organizations_billing_functions ON organizations`,
    // 列级授权不随表级 REVOKE 收回，逐一收回。
    sql`REVOKE SELECT (id, is_platform_admin, status) ON users FROM ${billing}`,
    sql`REVOKE SELECT (id) ON organizations FROM ${billing}`,
    sql`REVOKE USAGE ON SCHEMA public FROM ${billing}`,
  ]);
}
