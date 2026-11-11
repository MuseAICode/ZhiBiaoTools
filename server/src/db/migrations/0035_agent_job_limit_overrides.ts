// Agent 任务上限按组织覆盖（路线图第 8 步 8.3c，#70 决定事项第 10 项 b；docs/SERVER_DESIGN.md 第 10.11 节）。
// 0033 的上限取任务类型登记的起步值（AGENT_TASK_LIMITS）；本迁移允许**平台管理员**为某个组织的某个 Agent 任务类型另设上限，
// 入队时取覆盖值写入 agent_job_budgets（“一份”额度随之取覆盖值，由 0034 的写入触发器按写入的上限取值，不需要另改）。
//
// - agent_job_limit_overrides：每个（组织, 任务类型）至多一行，cost_limit / turn_limit 的范围与 0033 相同（费用 ≤ 10,000 元、
//   轮数 ≤ 1,000,000），两项一起覆盖；记下最后修改人与时间；随组织删除；
// - 写入、删除、跨组织列出只能经平台管理员的 SECURITY DEFINER 函数（属主 bidtools_billing，开头调用
//   billing_require_platform_admin()），应用角色没有写授权；
// - 应用角色只能读本组织的行（入队时在租户上下文中读取），组织成员看不到也改不了，不能借此放宽自己的上限；
// - 覆盖只影响之后入队的任务：已入队任务的上限已写入 agent_job_budgets，不随覆盖变化。
//
// 不改已有表的 RLS 策略，不新增数据库角色：只为 bidtools_billing 新增对新表的授权与只对它生效的策略。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, BILLING_ROLE } from '../roles.ts';
import { JOB_TYPE_PATTERN } from './0021_jobs.ts';
import { AGENT_BUDGET_MAX_COST_LIMIT, AGENT_BUDGET_MAX_TURN_LIMIT } from './0033_agent_job_budgets.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const billing = sql.id(BILLING_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

/** 覆盖说明的长度上限。 */
export const AGENT_LIMIT_OVERRIDE_NOTE_MAX_LENGTH = 500;

const APP_FUNCTIONS = [
  'agent_admin_set_limit_override(uuid, text, bigint, integer, text)',
  'agent_admin_delete_limit_override(uuid, text)',
  'agent_admin_list_limit_overrides(uuid)',
] as const;

const MAX_COST = sql.lit(AGENT_BUDGET_MAX_COST_LIMIT.toString());
const MAX_TURN = sql.lit(AGENT_BUDGET_MAX_TURN_LIMIT);

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // created_by / updated_by 不设外键，理由同 model_prices.created_by（操作人被删除后记录仍保留）。
    sql`CREATE TABLE agent_job_limit_overrides (
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          job_type text NOT NULL CHECK (job_type ~ ${sql.lit(JOB_TYPE_PATTERN)}),
          cost_limit bigint NOT NULL CHECK (cost_limit > 0 AND cost_limit <= ${MAX_COST}::bigint),
          turn_limit integer NOT NULL CHECK (turn_limit > 0 AND turn_limit <= ${MAX_TURN}),
          note text CHECK (char_length(note) <= ${sql.lit(AGENT_LIMIT_OVERRIDE_NOTE_MAX_LENGTH)}),
          created_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_by uuid NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (org_id, job_type)
        )`,

    sql`ALTER TABLE agent_job_limit_overrides ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_job_limit_overrides FORCE ROW LEVEL SECURITY`,
    // 应用角色只读本组织的行（入队时取覆盖值）；没有任何写授权。
    sql`CREATE POLICY agent_job_limit_overrides_select_tenant ON agent_job_limit_overrides FOR SELECT TO ${app}
          USING (org_id = app_current_org_id())`,
    sql`GRANT SELECT ON agent_job_limit_overrides TO ${app}`,
    // 平台管理员函数的属主：跨组织读写（函数开头校验平台管理员）。
    sql`CREATE POLICY agent_job_limit_overrides_billing ON agent_job_limit_overrides TO ${billing} USING (true) WITH CHECK (true)`,
    sql`GRANT SELECT, INSERT, UPDATE, DELETE ON agent_job_limit_overrides TO ${billing}`,

    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,

    // 设置（新建或替换）覆盖值。组织不存在 BL007；范围不合法 22023（表的 CHECK 兜底）。
    sql`CREATE FUNCTION agent_admin_set_limit_override(
          p_org_id uuid, p_job_type text, p_cost_limit bigint, p_turn_limit integer, p_note text
        ) RETURNS TABLE (org_id uuid, job_type text, cost_limit bigint, turn_limit integer, note text, updated_by uuid, updated_at timestamptz)
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          #variable_conflict use_column
          DECLARE
            v_operator uuid := public.billing_require_platform_admin();
          BEGIN
            IF p_org_id IS NULL OR p_job_type IS NULL OR p_job_type !~ ${sql.lit(JOB_TYPE_PATTERN)} THEN
              RAISE EXCEPTION 'invalid job type' USING ERRCODE = '22023';
            END IF;
            IF p_cost_limit IS NULL OR p_cost_limit <= 0 OR p_cost_limit > ${MAX_COST}::bigint
               OR p_turn_limit IS NULL OR p_turn_limit <= 0 OR p_turn_limit > ${MAX_TURN} THEN
              RAISE EXCEPTION 'limit out of range' USING ERRCODE = '22023';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org_id) THEN
              RAISE EXCEPTION 'organization not found' USING ERRCODE = 'BL007';
            END IF;
            RETURN QUERY
              INSERT INTO public.agent_job_limit_overrides AS x (org_id, job_type, cost_limit, turn_limit, note, created_by, updated_by)
              VALUES (p_org_id, p_job_type, p_cost_limit, p_turn_limit, NULLIF(btrim(p_note), ''), v_operator, v_operator)
              ON CONFLICT ON CONSTRAINT agent_job_limit_overrides_pkey DO UPDATE
                SET cost_limit = EXCLUDED.cost_limit, turn_limit = EXCLUDED.turn_limit, note = EXCLUDED.note,
                    updated_by = v_operator, updated_at = now()
              RETURNING x.org_id, x.job_type, x.cost_limit, x.turn_limit, x.note, x.updated_by, x.updated_at;
          END
          $$`,

    // 删除覆盖值（恢复任务类型的起步值）。返回是否删除了一行。
    sql`CREATE FUNCTION agent_admin_delete_limit_override(p_org_id uuid, p_job_type text) RETURNS boolean
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_operator uuid := public.billing_require_platform_admin();
          BEGIN
            DELETE FROM public.agent_job_limit_overrides x WHERE x.org_id = p_org_id AND x.job_type = p_job_type;
            RETURN FOUND;
          END
          $$`,

    // 列出某个组织的全部覆盖值。组织不存在 BL007。
    sql`CREATE FUNCTION agent_admin_list_limit_overrides(p_org_id uuid)
          RETURNS TABLE (job_type text, cost_limit bigint, turn_limit integer, note text, updated_by uuid, updated_at timestamptz)
          LANGUAGE plpgsql STABLE ${SECURE}
          AS $$
          #variable_conflict use_column
          DECLARE
            v_operator uuid := public.billing_require_platform_admin();
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org_id) THEN
              RAISE EXCEPTION 'organization not found' USING ERRCODE = 'BL007';
            END IF;
            RETURN QUERY
              SELECT x.job_type, x.cost_limit, x.turn_limit, x.note, x.updated_by, x.updated_at
              FROM public.agent_job_limit_overrides x WHERE x.org_id = p_org_id ORDER BY x.job_type;
          END
          $$`,

    ...APP_FUNCTIONS.map((signature) => sql`REVOKE ALL ON FUNCTION ${sql.raw(signature)} FROM PUBLIC`),
    ...APP_FUNCTIONS.map((signature) => sql`GRANT EXECUTE ON FUNCTION ${sql.raw(signature)} TO ${app}`),

    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 函数属主是 bidtools_billing，以它的身份删除。已入队任务的上限已写入 agent_job_budgets，回滚不影响它们。
    sql`GRANT CREATE ON SCHEMA public TO ${billing}`,
    sql`SET ROLE ${billing}`,
    ...APP_FUNCTIONS.map((signature) => sql`DROP FUNCTION ${sql.raw(signature)}`),
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${billing}`,
    sql`DROP TABLE agent_job_limit_overrides`,
  ]);
}
