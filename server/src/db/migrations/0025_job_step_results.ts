// 任务步骤的幂等（路线图第 6 步 6.4a）：平台自身故障（worker 崩溃、租约收回、重启）导致的重复调用不向用户收费。
//
// 6.4 留下的窗口：任务中的一次调用已结算、任务还没保存 checkpoint 时 worker 崩溃，续跑会重做这一步，服务商被再调用一次、
// 用户被再扣一次费。本迁移用“步骤幂等键”消除这个窗口：任务的每次模型调用带一个步骤键（src/jobs/definitions.ts 的
// JobChatRequest.stepKey），调用结果与结算在同一事务中写入 job_step_results（src/billing/usage.ts 的 settleJobStep），
// 续跑时同一步骤、同一请求的调用直接取回已保存的结果，不再冻结、不再调用服务商、不再扣费。
//
// - 键是 (org_id, job_id, step_key, request_hash)。request_hash 是请求内容（服务商、模型、消息、最大输出、temperature）的
//   SHA-256：暂停期间用户改了输入、续跑时同一步骤的请求不同，就是新的调用，照常收费；
// - 结算与写结果在同一事务中提交：提交前崩溃，结算和结果都不存在，冻结到期后不收费（abandoned），续跑时重新调用、只扣这一次；
//   提交后崩溃，续跑时取回结果，不调用服务商；
// - 同一步骤被两个执行者同时完成（原执行者失联但仍在运行、租约已被收回）：后提交的一方插入冲突，在同一事务中把自己的调用
//   改为不收费（duplicate_step），返回先提交的结果；
// - 因平台原因中止的调用（worker 关闭、租约丢失时任务被中止）不按已产生的用量收费，改为不收费（platform_interrupted），
//   续跑时重新调用；用户取消、暂停中止的调用照旧按已产生的用量收费（第 10.1 节），不保存结果；
// - 只能为本组织的任务、引用本任务尚未结算的用量记录写结果（INSERT 策略），每条用量记录最多一条结果；应用角色没有
//   UPDATE、DELETE 授权。结果随任务记录的保留期删除（外键级联，清理任务删除 jobs 时一并删除，见 0024_cleanup）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, BILLING_ROLE } from '../roles.ts';
import { GATEWAY_FAILURE_REASONS } from './0004_ai_gateway.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const billing = sql.id(BILLING_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

/** 步骤键：由任务代码给出，在同一任务内标识“同一次逻辑调用”（如 section:12、outline:try-2）。 */
export const JOB_STEP_KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$';
/** 保存的输出上限，与网关单次调用的响应体上限（src/ai/gateway.ts 的 MAX_UPSTREAM_RESPONSE_BYTES）相同。 */
export const JOB_STEP_RESULT_MAX_BYTES = 32 * 1024 * 1024;
/** 本迁移新增的网关失败原因（不收费）。 */
export const JOB_STEP_FAILURE_REASONS = ['platform_interrupted', 'duplicate_step'] as const;

const FAILURE_REASONS_0004 = [...GATEWAY_FAILURE_REASONS, 'hold_expired', 'abandoned', 'insufficient_balance'] as const;
const FAILURE_REASONS_0025 = [...FAILURE_REASONS_0004, ...JOB_STEP_FAILURE_REASONS] as const;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

function failureReasonCheck(values: readonly string[]): RawBuilder<unknown> {
  return sql`ALTER TABLE usage_records
          DROP CONSTRAINT usage_records_failure_reason_check,
          ADD CONSTRAINT usage_records_failure_reason_check CHECK (failure_reason IN (${list(values)}))`;
}

/** ai_usage_fail（与 0004 的版本相同，只有允许的原因不同）。 */
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

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    failureReasonCheck(FAILURE_REASONS_0025),
    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    usageFail([...GATEWAY_FAILURE_REASONS, ...JOB_STEP_FAILURE_REASONS]),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,

    // usage_id 引用用量记录（永久保留）；任务记录被删除时结果随之删除。
    sql`CREATE TABLE job_step_results (
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          step_key text NOT NULL CHECK (step_key ~ ${sql.lit(JOB_STEP_KEY_PATTERN)}),
          request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
          usage_id uuid NOT NULL,
          content text NOT NULL CHECK (octet_length(content) <= ${sql.lit(JOB_STEP_RESULT_MAX_BYTES)}),
          reasoning_content text NOT NULL CHECK (octet_length(reasoning_content) <= ${sql.lit(JOB_STEP_RESULT_MAX_BYTES)}),
          finish_reason text CHECK (char_length(finish_reason) BETWEEN 1 AND 64),
          input_tokens bigint NOT NULL CHECK (input_tokens BETWEEN 0 AND 1000000000),
          cached_input_tokens bigint NOT NULL CHECK (cached_input_tokens BETWEEN 0 AND 1000000000 AND cached_input_tokens <= input_tokens),
          output_tokens bigint NOT NULL CHECK (output_tokens BETWEEN 0 AND 1000000000),
          usage_source text NOT NULL CHECK (usage_source IN ('provider', 'estimated')),
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT job_step_results_pkey PRIMARY KEY (org_id, job_id, step_key, request_hash),
          CONSTRAINT job_step_results_usage_key UNIQUE (usage_id),
          CONSTRAINT job_step_results_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE,
          CONSTRAINT job_step_results_usage_fkey FOREIGN KEY (org_id, usage_id) REFERENCES usage_records (org_id, id)
        )`,
    sql`ALTER TABLE job_step_results ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE job_step_results FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY job_step_results_select_tenant ON job_step_results FOR SELECT TO ${app}
          USING (org_id = app_current_org_id())`,
    // 只能引用本任务、尚未结算的用量记录（结算在同一事务中随后进行）；usage_records 的策略在子查询中同样生效。
    sql`CREATE POLICY job_step_results_insert_tenant ON job_step_results FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND EXISTS (
            SELECT 1 FROM usage_records u
            WHERE u.id = job_step_results.usage_id AND u.org_id = job_step_results.org_id
              AND u.job_id = job_step_results.job_id AND u.status = 'pending'))`,
    sql`GRANT SELECT ON job_step_results TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, step_key, request_hash, usage_id, content, reasoning_content, finish_reason,
          input_tokens, cached_input_tokens, output_tokens, usage_source) ON job_step_results TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`DROP TABLE job_step_results`,
    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    usageFail(GATEWAY_FAILURE_REASONS),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,
    failureReasonCheck(FAILURE_REASONS_0004),
  ]);
}
