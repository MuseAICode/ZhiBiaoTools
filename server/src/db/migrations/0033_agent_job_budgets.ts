// Agent 任务的费用与轮数上限（路线图第 8 步 8.3a，“第 8 步说明”第 4 项“计费”；docs/SERVER_DESIGN.md 第 10.11 节）。
// 被注入的 Agent 可以无限调用模型直到余额耗尽（威胁模型 T5），因此每个 Agent 任务在入队时登记一份上限，由数据库强制：
//
// - agent_job_budgets：每个 Agent 任务一行（入队时与任务在同一事务中写入，只能为本组织 queued 的任务写入），
//   cost_limit（计费单位）、turn_limit（模型调用请求次数）、turns_used（已计入的请求次数）、exhausted_reason（达到哪个上限）；
//   - 上限写入后不能改（8.3b 的“确认继续”另行处理）；turns_used 每次只能加 1、不能超过 turn_limit、不能减少；
//     exhausted_reason 只能从空设为某个原因一次、不能清除；均由触发器检查（AB001），不依赖应用代码；
//   - 只有任务正在执行（running）时才能更新（策略）；随任务记录删除（外键级联）；
// - ai_usage_begin：source = 'job' 且任务登记了上限时，在锁住组织余额的同一事务中检查
//   “jobs.billed_amount + 本任务未到期的冻结 + 本次冻结 ≤ cost_limit”，否则 BL016、不冻结、不调用服务商。结算同样先锁组织余额，
//   所以并发的冻结与结算按顺序检查，已扣费不会超过上限（第 4 项：最多差一次调用的冻结额，而冻结额本身也计入检查）；
// - jobs.pause_reason 新增 task_cost_limit、task_turn_limit：达到上限时任务暂停为这两个原因，只能由发起人或组织管理员确认继续（8.3b）。
//
// 轮数在 Agent 的模型调用路由（src/agent/chatCompletions.ts）按令牌的任务原子递增，**取回已保存结果的请求同样计入**（#75 确认时的要求）：
// 这类请求不冻结、不写 usage_records，若按用量记录计数，被注入的 Agent 可以无限重发同一请求。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, BILLING_ROLE } from '../roles.ts';
import { MAX_HOLD_SECONDS, MIN_HOLD_SECONDS } from './0004_ai_gateway.ts';
import { JOB_PAUSE_REASONS as JOB_PAUSE_REASONS_0022 } from './0022_job_billing.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const billing = sql.id(BILLING_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

/** 达到上限的原因，同时是任务的暂停原因。 */
export const AGENT_BUDGET_EXHAUSTED_REASONS = ['task_cost_limit', 'task_turn_limit'] as const;
/** 暂停原因：0022 的 insufficient_balance 加上任务上限的两个原因。 */
export const JOB_PAUSE_REASONS = [...JOB_PAUSE_REASONS_0022, ...AGENT_BUDGET_EXHAUSTED_REASONS] as const;
/** 费用上限的范围（计费单位，0.0001 元）：至多 10,000 元，防止写入失误的极大值等于不设上限。 */
export const AGENT_BUDGET_MAX_COST_LIMIT = 100_000_000n;
/** 轮数上限的范围。 */
export const AGENT_BUDGET_MAX_TURN_LIMIT = 1_000_000;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

/**
 * ai_usage_begin：与 0022 的版本相同；taskLimit 为 true 时（up）在算出本次冻结额之后检查任务的费用上限，down 时恢复 0022 的版本。
 * 两个版本只在标出的两处不同。
 */
function usageBegin(taskLimit: boolean): RawBuilder<unknown> {
  const declare = taskLimit ? sql`v_cost_limit bigint; v_job_billed bigint; v_job_held bigint;` : sql``;
  const loadLimit = taskLimit
    ? sql`SELECT b.cost_limit INTO v_cost_limit FROM public.agent_job_budgets b
                WHERE b.org_id = v_org_id AND b.job_id = p_job_id;`
    : sql``;
  const checkLimit = taskLimit
    ? sql`-- 任务费用上限：已扣费 + 本任务未到期的冻结 + 本次冻结。组织余额已锁住，结算也先锁它，所以这里读到的是一致的值。
            IF v_cost_limit IS NOT NULL THEN
              SELECT j.billed_amount INTO v_job_billed FROM public.jobs j WHERE j.org_id = v_org_id AND j.id = p_job_id;
              SELECT coalesce(sum(u.hold_amount), 0) INTO v_job_held FROM public.usage_records u
                WHERE u.org_id = v_org_id AND u.job_id = p_job_id AND u.status = 'pending' AND u.hold_expires_at > now();
              IF v_job_billed + v_job_held + v_hold > v_cost_limit THEN
                RAISE EXCEPTION 'task cost limit reached' USING ERRCODE = 'BL016';
              END IF;
            END IF;`
    : sql``;
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
            v_job_type text;
            ${declare}
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
            IF p_source = 'job' THEN
              SELECT j.type INTO v_job_type FROM public.jobs j
                WHERE j.org_id = v_org_id AND j.id = p_job_id AND j.status = 'running';
              IF NOT FOUND THEN
                RAISE EXCEPTION 'job is not running' USING ERRCODE = 'BL015';
              END IF;
              IF p_job_type IS NOT NULL AND p_job_type <> v_job_type THEN
                RAISE EXCEPTION 'job type mismatch' USING ERRCODE = '22023';
              END IF;
              ${loadLimit}
            ELSE
              v_job_type := p_job_type;
            END IF;

            INSERT INTO public.org_balances (org_id) VALUES (v_org_id) ON CONFLICT (org_id) DO NOTHING;
            SELECT b.balance INTO v_balance FROM public.org_balances b WHERE b.org_id = v_org_id FOR UPDATE;

            SELECT p.* INTO v_price FROM public.model_prices p
              WHERE p.id = public.ai_model_price(v_org_id, p_provider, p_model);

            v_hold := public.billing_charge_amount(
              p_estimated_input_tokens, p_max_output_tokens, v_price.input_price_per_mtok, v_price.output_price_per_mtok);
            ${checkLimit}
            v_held := public.billing_active_holds(v_org_id);
            IF v_balance - v_held - v_hold < 0 THEN
              RAISE EXCEPTION 'insufficient balance' USING ERRCODE = 'BL001';
            END IF;

            RETURN QUERY
              INSERT INTO public.usage_records AS u (
                org_id, user_id, request_id, source, job_id, job_type, provider, model, price_id,
                estimated_input_tokens, max_output_tokens, hold_amount, hold_expires_at)
              VALUES (
                v_org_id, v_user_id, p_request_id, p_source, p_job_id, v_job_type, p_provider, p_model, v_price.id,
                p_estimated_input_tokens, p_max_output_tokens, v_hold, now() + make_interval(secs => p_hold_seconds))
              RETURNING u.id, u.price_id, u.hold_amount, u.hold_expires_at, v_balance - v_held - v_hold;
          END
          $$`;
}

function pauseReasonCheck(reasons: readonly string[]): RawBuilder<unknown> {
  return sql`ALTER TABLE jobs ADD CONSTRAINT jobs_pause_reason_check CHECK (pause_reason IN (${list(reasons)}))`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE jobs DROP CONSTRAINT jobs_pause_reason_check`,
    pauseReasonCheck(JOB_PAUSE_REASONS),

    sql`CREATE TABLE agent_job_budgets (
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          cost_limit bigint NOT NULL CHECK (cost_limit > 0 AND cost_limit <= ${sql.lit(AGENT_BUDGET_MAX_COST_LIMIT.toString())}::bigint),
          turn_limit integer NOT NULL CHECK (turn_limit > 0 AND turn_limit <= ${sql.lit(AGENT_BUDGET_MAX_TURN_LIMIT)}),
          turns_used integer NOT NULL DEFAULT 0,
          exhausted_reason text CHECK (exhausted_reason IN (${list(AGENT_BUDGET_EXHAUSTED_REASONS)})),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (org_id, job_id),
          CONSTRAINT agent_job_budgets_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE,
          CONSTRAINT agent_job_budgets_turns_shape CHECK (turns_used >= 0 AND turns_used <= turn_limit)
        )`,

    // 不变式：标识与上限不能改；轮数只能逐次加 1，达到上限后不再增加；达到上限的原因只能设置一次、不能清除。
    sql`CREATE FUNCTION agent_job_budgets_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
               OR NEW.cost_limit IS DISTINCT FROM OLD.cost_limit OR NEW.turn_limit IS DISTINCT FROM OLD.turn_limit
               OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
              RAISE EXCEPTION 'agent job budget limits are immutable' USING ERRCODE = 'AB001';
            END IF;
            IF NEW.turns_used <> OLD.turns_used AND (NEW.turns_used <> OLD.turns_used + 1 OR OLD.exhausted_reason IS NOT NULL) THEN
              RAISE EXCEPTION 'agent job turns can only advance by one' USING ERRCODE = 'AB001';
            END IF;
            IF NEW.exhausted_reason IS DISTINCT FROM OLD.exhausted_reason AND OLD.exhausted_reason IS NOT NULL THEN
              RAISE EXCEPTION 'agent job budget exhaustion cannot be cleared' USING ERRCODE = 'AB001';
            END IF;
            NEW.updated_at := now();
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER agent_job_budgets_guard BEFORE UPDATE ON agent_job_budgets FOR EACH ROW EXECUTE FUNCTION agent_job_budgets_guard()`,
    sql`REVOKE ALL ON FUNCTION agent_job_budgets_guard() FROM PUBLIC`,

    sql`ALTER TABLE agent_job_budgets ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_job_budgets FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY agent_job_budgets_select_tenant ON agent_job_budgets FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    // 只在入队的同一事务中写入（任务仍是 queued、还没有计入任何轮数）；跨组织的 job_id 由复合外键报错。
    sql`CREATE POLICY agent_job_budgets_insert_queued ON agent_job_budgets FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND turns_used = 0 AND exhausted_reason IS NULL AND EXISTS (
            SELECT 1 FROM jobs j WHERE j.id = agent_job_budgets.job_id AND j.status = 'queued'))`,
    // 计入轮数、记下达到上限只在任务执行中。
    sql`CREATE POLICY agent_job_budgets_update_running ON agent_job_budgets FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id() AND EXISTS (
            SELECT 1 FROM jobs j WHERE j.id = agent_job_budgets.job_id AND j.status = 'running'))
          WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT SELECT ON agent_job_budgets TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, cost_limit, turn_limit) ON agent_job_budgets TO ${app}`,
    sql`GRANT UPDATE (turns_used, exhausted_reason) ON agent_job_budgets TO ${app}`,

    // 计费函数只读费用上限，只限当前组织。
    sql`GRANT SELECT (org_id, job_id, cost_limit) ON agent_job_budgets TO ${billing}`,
    sql`CREATE POLICY agent_job_budgets_billing_select ON agent_job_budgets FOR SELECT TO ${billing} USING (org_id = app_current_org_id())`,

    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    usageBegin(true),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    usageBegin(false),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,
    sql`DROP TABLE agent_job_budgets`,
    sql`DROP FUNCTION agent_job_budgets_guard()`,
    // 因达到任务上限而暂停的任务回滚后按手动暂停处理（仍是 paused，可以继续）。
    // 属主同样受强制 RLS 约束，改写所有组织的行时临时取消 FORCE，改完立即恢复（同一事务）。
    sql`ALTER TABLE jobs DROP CONSTRAINT jobs_pause_reason_check`,
    sql`ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY`,
    sql`UPDATE jobs SET pause_reason = NULL WHERE pause_reason IN (${list(AGENT_BUDGET_EXHAUSTED_REASONS)})`,
    sql`ALTER TABLE jobs FORCE ROW LEVEL SECURITY`,
    pauseReasonCheck(JOB_PAUSE_REASONS_0022),
  ]);
}
