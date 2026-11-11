// Agent 任务达到上限后的确认继续（路线图第 8 步 8.3b，“第 8 步说明”第 4 项“计费”；docs/SERVER_DESIGN.md 第 10.11 节）。
// 0033 的上限写入后不能改；本迁移只放开一种改法：“确认继续”，由数据库强制，不依赖应用代码：
//
// - 新列 cost_step / turn_step（“一份”额度，写入时由触发器取入队时的上限，之后不能改）与 confirmations（已确认次数）；
// - 上限只能在一次 UPDATE 中同时各加一份、confirmations 加 1、清除 exhausted_reason，而且：
//   - 之前确实已达到上限（exhausted_reason 不为空）：一次达到上限只能确认一次，并发确认只有一个成功（第二个看到原因已清除）；
//   - 任务是 paused，暂停原因是 task_cost_limit / task_turn_limit；
//   - 当前用户（app.user_id）是本组织的成员，并且是任务发起人或组织的 owner / admin；没有用户上下文（worker、超级用户直接改）一律拒绝；
//   - 已用轮数不变；
//   违反时 AB001。上限合计仍受 0033 的范围约束（费用 ≤ 10,000 元、轮数 ≤ 1,000,000），超出时 CHECK 失败；
// - 其他改动沿用 0033 的规则，另加一条：计入轮数、记下达到上限只在任务 running 时（与 0033 的更新策略相同，触发器中再检查一次，
//   使新增的“暂停中可更新”策略不放宽这两列）；
// - 新增更新策略 agent_job_budgets_update_confirm：任务因上限暂停时可以更新（只可能是确认继续，由触发器限定）；
// - 应用角色新增 cost_limit、turn_limit、confirmations 三列的 UPDATE 授权（改法由触发器限定）。
//
// 已有表的 RLS 策略不变（0033 的三条策略照旧），数据库角色不变。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { AGENT_BUDGET_EXHAUSTED_REASONS } from './0033_agent_job_budgets.ts';
import { ORG_SETTINGS_EDITOR_ROLES } from './0009_settings.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

/** 可以确认继续的组织角色（与组织设置的编辑者相同：owner / admin）；任务发起人另外可以确认。 */
export const AGENT_BUDGET_CONFIRM_ROLES = ORG_SETTINGS_EDITOR_ROLES;

const REASONS = list(AGENT_BUDGET_EXHAUSTED_REASONS);

/** 0033 的守卫（down 时恢复）。 */
const GUARD_0033 = sql`CREATE OR REPLACE FUNCTION agent_job_budgets_guard() RETURNS trigger
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
          $$`;

const GUARD_0034 = sql`CREATE OR REPLACE FUNCTION agent_job_budgets_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_user_id uuid := public.app_current_user_id();
          BEGIN
            IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
               OR NEW.cost_step IS DISTINCT FROM OLD.cost_step OR NEW.turn_step IS DISTINCT FROM OLD.turn_step
               OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
              RAISE EXCEPTION 'agent job budget identity is immutable' USING ERRCODE = 'AB001';
            END IF;

            IF NEW.cost_limit IS DISTINCT FROM OLD.cost_limit OR NEW.turn_limit IS DISTINCT FROM OLD.turn_limit
               OR NEW.confirmations IS DISTINCT FROM OLD.confirmations THEN
              -- 确认继续：上限各加一份、次数加 1、清除原因、轮数不变，只能在一次 UPDATE 中同时完成。
              IF NEW.cost_limit <> OLD.cost_limit + OLD.cost_step OR NEW.turn_limit <> OLD.turn_limit + OLD.turn_step
                 OR NEW.confirmations <> OLD.confirmations + 1 OR NEW.turns_used <> OLD.turns_used
                 OR OLD.exhausted_reason IS NULL OR NEW.exhausted_reason IS NOT NULL THEN
                RAISE EXCEPTION 'agent job budget can only grow by one step after reaching a limit' USING ERRCODE = 'AB001';
              END IF;
              IF NOT EXISTS (
                   SELECT 1 FROM public.jobs j
                   WHERE j.org_id = OLD.org_id AND j.id = OLD.job_id AND j.status = 'paused' AND j.pause_reason IN (${REASONS}))
              THEN
                RAISE EXCEPTION 'job is not paused for a task limit' USING ERRCODE = 'AB001';
              END IF;
              -- 确认人：本组织成员，且是任务发起人或 owner / admin。没有用户上下文时一律拒绝。
              IF v_user_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM public.org_memberships m JOIN public.jobs j ON j.org_id = m.org_id
                   WHERE m.org_id = OLD.org_id AND m.user_id = v_user_id AND j.id = OLD.job_id
                     AND (j.user_id = v_user_id OR m.role IN (${list(AGENT_BUDGET_CONFIRM_ROLES)})))
              THEN
                RAISE EXCEPTION 'only the job creator or an organization admin can confirm' USING ERRCODE = 'AB001';
              END IF;
              NEW.updated_at := now();
              RETURN NEW;
            END IF;

            IF NEW.turns_used <> OLD.turns_used AND (NEW.turns_used <> OLD.turns_used + 1 OR OLD.exhausted_reason IS NOT NULL) THEN
              RAISE EXCEPTION 'agent job turns can only advance by one' USING ERRCODE = 'AB001';
            END IF;
            IF NEW.exhausted_reason IS DISTINCT FROM OLD.exhausted_reason AND OLD.exhausted_reason IS NOT NULL THEN
              RAISE EXCEPTION 'agent job budget exhaustion cannot be cleared' USING ERRCODE = 'AB001';
            END IF;
            -- 计入轮数、记下达到上限只在执行中（暂停中的更新策略只为确认继续）。
            IF (NEW.turns_used <> OLD.turns_used OR NEW.exhausted_reason IS DISTINCT FROM OLD.exhausted_reason) AND NOT EXISTS (
                 SELECT 1 FROM public.jobs j WHERE j.org_id = OLD.org_id AND j.id = OLD.job_id AND j.status = 'running')
            THEN
              RAISE EXCEPTION 'agent job turns can only advance while running' USING ERRCODE = 'AB001';
            END IF;
            NEW.updated_at := now();
            RETURN NEW;
          END
          $$`;

/** 写入时“一份”额度取入队时的上限，已确认次数为 0（不采用写入的值；应用角色也没有这三列的写入授权）。 */
const INSERT_DEFAULTS = sql`CREATE FUNCTION agent_job_budgets_insert_defaults() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            NEW.cost_step := NEW.cost_limit;
            NEW.turn_step := NEW.turn_limit;
            NEW.confirmations := 0;
            RETURN NEW;
          END
          $$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE agent_job_budgets ADD COLUMN cost_step bigint, ADD COLUMN turn_step integer,
          ADD COLUMN confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations >= 0)`,
    // 已有的行：一份 = 当前上限（0033 的上限不能改，就是入队时的值）。属主同样受强制 RLS 约束，临时取消 FORCE（同一事务）。
    // 守卫在补列时仍是 0033 的版本（不检查新列），先补列再换守卫。
    sql`ALTER TABLE agent_job_budgets NO FORCE ROW LEVEL SECURITY`,
    sql`UPDATE agent_job_budgets SET cost_step = cost_limit, turn_step = turn_limit`,
    sql`ALTER TABLE agent_job_budgets FORCE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_job_budgets ALTER COLUMN cost_step SET NOT NULL, ALTER COLUMN turn_step SET NOT NULL`,
    sql`ALTER TABLE agent_job_budgets ADD CONSTRAINT agent_job_budgets_step_shape CHECK (cost_step > 0 AND turn_step > 0)`,

    INSERT_DEFAULTS,
    sql`CREATE TRIGGER agent_job_budgets_insert_defaults BEFORE INSERT ON agent_job_budgets FOR EACH ROW EXECUTE FUNCTION agent_job_budgets_insert_defaults()`,
    sql`REVOKE ALL ON FUNCTION agent_job_budgets_insert_defaults() FROM PUBLIC`,
    GUARD_0034,

    // 任务因上限暂停时可以更新：只可能是确认继续（由守卫限定），确认人由守卫检查。
    sql`CREATE POLICY agent_job_budgets_update_confirm ON agent_job_budgets FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id() AND EXISTS (
            SELECT 1 FROM jobs j WHERE j.id = agent_job_budgets.job_id AND j.status = 'paused' AND j.pause_reason IN (${REASONS})))
          WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT UPDATE (cost_limit, turn_limit, confirmations) ON agent_job_budgets TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 已确认继续而加大的上限保留（回滚后不能再改）。
    sql`REVOKE UPDATE (cost_limit, turn_limit, confirmations) ON agent_job_budgets FROM ${app}`,
    sql`DROP POLICY agent_job_budgets_update_confirm ON agent_job_budgets`,
    GUARD_0033,
    sql`DROP TRIGGER agent_job_budgets_insert_defaults ON agent_job_budgets`,
    sql`DROP FUNCTION agent_job_budgets_insert_defaults()`,
    sql`ALTER TABLE agent_job_budgets DROP CONSTRAINT agent_job_budgets_step_shape`,
    sql`ALTER TABLE agent_job_budgets DROP COLUMN confirmations, DROP COLUMN turn_step, DROP COLUMN cost_step`,
  ]);
}
