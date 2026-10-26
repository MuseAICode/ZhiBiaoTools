// 任务的计费（docs/SERVER_DESIGN.md 第 10.1、10.3 节；路线图第 6 步 6.4）：worker 中的任务经 AI 网关调用模型，
// 用量记录带 job_id / job_type，费用在结算的同一事务中累加到 jobs.billed_amount；入队和继续前检查最低启动余额；
// 运行中冻结失败时任务暂停为 paused、原因 insufficient_balance。
//
// - jobs.billed_amount：本任务已扣费的合计（计费单位）。应用角色没有该列的 UPDATE 权限，只有 ai_usage_settle（属主
//   bidtools_billing）在扣费的同一事务中累加，只增不减（触发器）；任务结束后仍可累加（执行者失联后才结算的调用照常扣费），
//   其他列照旧不能改（JB001）；
// - usage_records.job_id 不加外键（决定事项第 10 项）：任务记录到保留期会被删除，用量记录永久保留，只保留 job_id / job_type 的值；
// - ai_usage_begin：source = 'job' 时任务必须属于本组织且正在执行（running），否则 BL015，不冻结；job_type 以任务记录为准；
// - jobs.pause_reason：只在 paused 时可以有值，目前只有 insufficient_balance（运行中冻结失败）；用户手动暂停为 NULL；
// - billing_job_start_check：入队和继续前检查“余额 − 进行中的冻结 ≥ 最低启动余额”（决定事项第 7 项：全局 1 元），否则 BL001。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, BILLING_ROLE } from '../roles.ts';
import { MAX_HOLD_SECONDS, MIN_HOLD_SECONDS } from './0004_ai_gateway.ts';
import { JOB_FINAL_STATUSES } from './0021_jobs.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const billing = sql.id(BILLING_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

/** 入队和继续前要求的最低可用余额（计费单位，0.0001 元）：1 元（决定事项第 7 项）。 */
export const JOB_MIN_START_BALANCE = 10_000n;
/** 暂停原因：只由 worker 写入；用户手动暂停时为空。 */
export const JOB_PAUSE_REASONS = ['insufficient_balance'] as const;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

/** 任务触发器：0021 的版本只允许改未结束的任务；本迁移允许已结束的任务只累加 billed_amount。 */
const JOBS_GUARD_0021 = sql`CREATE OR REPLACE FUNCTION jobs_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.status IN (${list(JOB_FINAL_STATUSES)}) THEN
              RAISE EXCEPTION 'job is finished' USING ERRCODE = 'JB001';
            END IF;
            NEW.updated_at := now();
            RETURN NEW;
          END
          $$`;

const JOBS_GUARD_0022 = sql`CREATE OR REPLACE FUNCTION jobs_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.billed_amount < OLD.billed_amount THEN
              RAISE EXCEPTION 'job billed amount cannot decrease' USING ERRCODE = 'JB002';
            END IF;
            IF OLD.status IN (${list(JOB_FINAL_STATUSES)}) THEN
              -- 已结束的任务只能累加费用（执行者失联后才到达的结算），其他列一律不能改，updated_at 保持结束时的值。
              IF (to_jsonb(NEW) - 'billed_amount' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'billed_amount' - 'updated_at') THEN
                RAISE EXCEPTION 'job is finished' USING ERRCODE = 'JB001';
              END IF;
              NEW.updated_at := OLD.updated_at;
              RETURN NEW;
            END IF;
            NEW.updated_at := now();
            RETURN NEW;
          END
          $$`;

/**
 * ai_usage_begin 的公共部分（与 0005 的版本相同，只多了任务检查）。up 中的版本在 source = 'job' 时检查任务属于本组织且
 * 正在执行，job_type 取任务记录中的值；down 时恢复 0005 的版本。
 */
function usageBegin(job: { declare: RawBuilder<unknown>; check: RawBuilder<unknown>; type: RawBuilder<unknown> }): RawBuilder<unknown> {
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
            ${job.declare}
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
            ${job.check}

            INSERT INTO public.org_balances (org_id) VALUES (v_org_id) ON CONFLICT (org_id) DO NOTHING;
            SELECT b.balance INTO v_balance FROM public.org_balances b WHERE b.org_id = v_org_id FOR UPDATE;

            SELECT p.* INTO v_price FROM public.model_prices p
              WHERE p.id = public.ai_model_price(v_org_id, p_provider, p_model);

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
                v_org_id, v_user_id, p_request_id, p_source, p_job_id, ${job.type}, p_provider, p_model, v_price.id,
                p_estimated_input_tokens, p_max_output_tokens, v_hold, now() + make_interval(secs => p_hold_seconds))
              RETURNING u.id, u.price_id, u.hold_amount, u.hold_expires_at, v_balance - v_held - v_hold;
          END
          $$`;
}

const BEGIN_0005 = { declare: sql``, check: sql``, type: sql`p_job_type` };

// 任务调用：任务必须属于本组织（RLS 下只看得到本组织的任务）且正在执行。取消中（cancelling）的任务不再开始新的调用；
// 已请求暂停的任务仍是 running，可以继续调用到下一个检查点。传入的任务类型与任务记录不符时拒绝。
const BEGIN_0022 = {
  declare: sql`v_job_type text;`,
  check: sql`IF p_source = 'job' THEN
              SELECT j.type INTO v_job_type FROM public.jobs j
                WHERE j.org_id = v_org_id AND j.id = p_job_id AND j.status = 'running';
              IF NOT FOUND THEN
                RAISE EXCEPTION 'job is not running' USING ERRCODE = 'BL015';
              END IF;
              IF p_job_type IS NOT NULL AND p_job_type <> v_job_type THEN
                RAISE EXCEPTION 'job type mismatch' USING ERRCODE = '22023';
              END IF;
            ELSE
              v_job_type := p_job_type;
            END IF;`,
  type: sql`v_job_type`,
};

/** ai_usage_settle（与 0004 的版本相同）；up 中的版本在扣费成功后、同一事务中累加 jobs.billed_amount。 */
function usageSettle(afterCharge: RawBuilder<unknown>): RawBuilder<unknown> {
  return sql`CREATE OR REPLACE FUNCTION ai_usage_settle(
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
            ${afterCharge}
            RETURN QUERY SELECT 'billed'::text, v_amount, v_balance_after, v_entry_id;
          END
          $$`;
}

// 任务记录已被保留期清理删除时影响 0 行，扣费照常（用量记录中仍有 job_id）。
const SETTLE_ADD_TO_JOB = sql`IF v_usage.job_id IS NOT NULL AND v_amount > 0 THEN
              UPDATE public.jobs j SET billed_amount = j.billed_amount + v_amount
                WHERE j.org_id = v_org_id AND j.id = v_usage.job_id;
            END IF;`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE jobs
          ADD COLUMN billed_amount bigint NOT NULL DEFAULT 0 CHECK (billed_amount >= 0),
          ADD COLUMN pause_reason text CHECK (pause_reason IN (${list(JOB_PAUSE_REASONS)})),
          ADD CONSTRAINT jobs_pause_reason_shape CHECK (pause_reason IS NULL OR status = 'paused')`,
    JOBS_GUARD_0022,
    // 应用角色（api 与 worker）可以写暂停原因，不能写 billed_amount。
    sql`GRANT UPDATE (pause_reason) ON jobs TO ${app}`,

    // 计费函数读任务（ai_usage_begin 的检查）和累加费用（ai_usage_settle），只限当前组织。
    sql`GRANT SELECT (id, org_id, type, status, billed_amount), UPDATE (billed_amount) ON jobs TO ${billing}`,
    sql`CREATE POLICY jobs_billing_select ON jobs FOR SELECT TO ${billing} USING (org_id = app_current_org_id())`,
    sql`CREATE POLICY jobs_billing_update ON jobs FOR UPDATE TO ${billing}
          USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id())`,

    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    usageBegin(BEGIN_0022),
    usageSettle(SETTLE_ADD_TO_JOB),
    // 入队、继续前的余额门槛：可用余额（余额 − 未到期的冻结）不低于最低启动余额。只读，不加锁：
    // 只是门槛，之后每次调用的冻结才是真正的额度控制。返回当时的可用余额。
    sql`CREATE FUNCTION billing_job_start_check() RETURNS bigint
          LANGUAGE plpgsql STABLE ${SECURE}
          AS $$
          DECLARE
            v_org_id uuid := public.app_current_org_id();
            v_available bigint;
          BEGIN
            IF v_org_id IS NULL THEN
              RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
            END IF;
            SELECT coalesce((SELECT b.balance FROM public.org_balances b WHERE b.org_id = v_org_id), 0)
                   - public.billing_active_holds(v_org_id)
              INTO v_available;
            IF v_available < ${sql.lit(JOB_MIN_START_BALANCE.toString())}::bigint THEN
              RAISE EXCEPTION 'insufficient balance to start job' USING ERRCODE = 'BL001';
            END IF;
            RETURN v_available;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION billing_job_start_check() FROM PUBLIC`,
    sql`GRANT EXECUTE ON FUNCTION billing_job_start_check() TO ${app}`,
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    sql`DROP FUNCTION billing_job_start_check()`,
    usageSettle(sql``),
    usageBegin(BEGIN_0005),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,

    sql`DROP POLICY jobs_billing_update ON jobs`,
    sql`DROP POLICY jobs_billing_select ON jobs`,
    sql`REVOKE ALL ON jobs FROM ${billing}`,
    JOBS_GUARD_0021,
    sql`ALTER TABLE jobs DROP CONSTRAINT jobs_pause_reason_shape, DROP COLUMN pause_reason, DROP COLUMN billed_amount`,
  ]);
}
