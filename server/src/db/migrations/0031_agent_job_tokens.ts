// Agent 任务令牌（路线图第 8 步 8.2a，决定事项第 1 项；docs/SERVER_DESIGN.md 第 7.11 节）：agent 沙箱访问平台的唯一凭据。
//
// 令牌是 256 位随机数，交给沙箱内的 Pi 进程，库中只存 SHA-256。每次执行（jobs.run_id）签发，绑定一个任务的一次执行；
// 令牌代表的身份（组织、任务、项目、发起用户、任务类型）一律由服务端按令牌从 jobs 查出，不来自沙箱的请求。
//
// 有效的条件全部在查询时现算（agent_token_lookup），不依赖应用代码在状态变化时记得作废：
// - 令牌未作废（revoked_at）、未过期（expires_at，签发时按任务墙钟给出，最长 135 分钟）；
// - 任务仍是 running、没有请求暂停、run_id 仍是签发时的那一次执行、租约未过期：任务结束、暂停（含请求暂停）、取消（cancelling）、
//   被对账收回或续跑换了执行者，令牌立即失效；续跑时签发新令牌；
// - 发起用户仍是该组织成员、账号正常；任务属于项目时项目未删除。
//
// 不变式由数据库保证：
// - 强制 RLS：应用角色只能为本组织（app.org_id）中正在执行、run_id 相符、未请求暂停的任务签发；每个任务最多一个未作废的令牌
//   （部分唯一索引），签发新令牌前须先作废旧的；
// - 应用角色读不到 token_hash（没有列级 SELECT 授权），按令牌查身份只能经 agent_token_lookup；
// - 写入后只能作废：应用角色只有 revoked_at 的 UPDATE 授权，作废不能撤销，作废时间由触发器取 now()（AT001）；没有 DELETE 授权，
//   令牌随任务记录删除（外键级联，清理任务删除 jobs 时一并删除，见 0024_cleanup）。
//
// agent_token_lookup 与 auth_session_lookup（0002）相同：属主 bidtools_auth（NOLOGIN、无 BYPASSRLS），按完整的令牌哈希精确匹配，
// 最多返回一行，只返回调用方需要的字段；本迁移为 bidtools_auth 增加 agent_job_tokens、jobs、projects 中函数用到的列的只读授权与策略。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, AUTH_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const auth = sql.id(AUTH_ROLE);
const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

/** 令牌最长有效期（分钟）：agent-content 沙箱的最长存活时间（src/sandbox/templates.ts），由测试核对。 */
export const AGENT_TOKEN_MAX_TTL_MINUTES = 135;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE TABLE agent_job_tokens (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          run_id uuid NOT NULL,
          token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
          created_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL,
          revoked_at timestamptz,
          CONSTRAINT agent_job_tokens_token_hash_key UNIQUE (token_hash),
          CONSTRAINT agent_job_tokens_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE,
          CONSTRAINT agent_job_tokens_ttl CHECK (
            expires_at > created_at AND expires_at <= created_at + make_interval(mins => ${sql.lit(AGENT_TOKEN_MAX_TTL_MINUTES)})),
          CONSTRAINT agent_job_tokens_revoked_shape CHECK (revoked_at IS NULL OR revoked_at >= created_at)
        )`,
    sql`CREATE UNIQUE INDEX agent_job_tokens_live_key ON agent_job_tokens (org_id, job_id) WHERE revoked_at IS NULL`,

    sql`CREATE FUNCTION agent_job_tokens_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
              RAISE EXCEPTION 'agent token can only be revoked once' USING ERRCODE = 'AT001';
            END IF;
            NEW.revoked_at := now();
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER agent_job_tokens_guard BEFORE UPDATE ON agent_job_tokens FOR EACH ROW EXECUTE FUNCTION agent_job_tokens_guard()`,
    sql`REVOKE ALL ON FUNCTION agent_job_tokens_guard() FROM PUBLIC`,

    sql`ALTER TABLE agent_job_tokens ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_job_tokens FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY agent_job_tokens_select_tenant ON agent_job_tokens FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    // 任务条件在应用角色的 RLS 下求值，只看得到本组织的任务；跨组织的 job_id 由复合外键报错。
    sql`CREATE POLICY agent_job_tokens_insert_running ON agent_job_tokens FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND revoked_at IS NULL AND EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.id = agent_job_tokens.job_id AND j.run_id = agent_job_tokens.run_id
              AND j.status = 'running' AND NOT j.pause_requested))`,
    sql`CREATE POLICY agent_job_tokens_update_tenant ON agent_job_tokens FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id())
          WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT SELECT (id, org_id, job_id, run_id, created_at, expires_at, revoked_at) ON agent_job_tokens TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, run_id, token_hash, expires_at) ON agent_job_tokens TO ${app}`,
    sql`GRANT UPDATE (revoked_at) ON agent_job_tokens TO ${app}`,

    // bidtools_auth：只授函数用到的列；策略只对它生效（TO bidtools_auth），应用角色不受影响。
    sql`GRANT SELECT (org_id, job_id, run_id, token_hash, expires_at, revoked_at) ON agent_job_tokens TO ${auth}`,
    sql`GRANT SELECT (id, org_id, project_id, user_id, type, status, pause_requested, run_id, lease_expires_at) ON jobs TO ${auth}`,
    sql`GRANT SELECT (id, org_id, deleted_at) ON projects TO ${auth}`,
    sql`CREATE POLICY agent_job_tokens_auth_functions ON agent_job_tokens FOR SELECT TO ${auth} USING (true)`,
    sql`CREATE POLICY jobs_auth_functions ON jobs FOR SELECT TO ${auth} USING (true)`,
    sql`CREATE POLICY projects_auth_functions ON projects FOR SELECT TO ${auth} USING (true)`,

    sql`GRANT CREATE ON SCHEMA public TO ${auth}`,
    sql`SET ROLE ${auth}`,
    // 按令牌哈希查身份：只返回未作废、未过期，任务仍在本次执行中（running、未请求暂停、run_id 相符、租约未过期），
    // 发起用户仍是成员且账号正常，项目（如有）未删除的令牌。expires_at 是令牌与租约中较早的到期时间。
    sql`CREATE FUNCTION agent_token_lookup(p_token_hash bytea)
          RETURNS TABLE (org_id uuid, job_id uuid, run_id uuid, project_id uuid, user_id uuid, job_type text,
                         member_role text, expires_at timestamptz)
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT t.org_id, t.job_id, t.run_id, j.project_id, j.user_id, j.type, m.role,
                   least(t.expires_at, j.lease_expires_at)
            FROM public.agent_job_tokens t
            JOIN public.jobs j ON j.org_id = t.org_id AND j.id = t.job_id
            JOIN public.org_memberships m ON m.org_id = j.org_id AND m.user_id = j.user_id
            JOIN public.users u ON u.id = j.user_id
            WHERE t.token_hash = p_token_hash AND t.revoked_at IS NULL AND t.expires_at > now()
              AND j.status = 'running' AND NOT j.pause_requested AND j.run_id = t.run_id AND j.lease_expires_at > now()
              AND u.status = 'active'
              AND (j.project_id IS NULL OR EXISTS (
                SELECT 1 FROM public.projects p WHERE p.org_id = j.org_id AND p.id = j.project_id AND p.deleted_at IS NULL))
            LIMIT 1
          $$`,
    sql`REVOKE ALL ON FUNCTION agent_token_lookup(bytea) FROM PUBLIC`,
    sql`GRANT EXECUTE ON FUNCTION agent_token_lookup(bytea) TO ${app}`,
    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${auth}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`SET ROLE ${auth}`,
    sql`DROP FUNCTION agent_token_lookup(bytea)`,
    sql`RESET ROLE`,
    sql`DROP POLICY projects_auth_functions ON projects`,
    sql`DROP POLICY jobs_auth_functions ON jobs`,
    sql`REVOKE SELECT (id, org_id, deleted_at) ON projects FROM ${auth}`,
    sql`REVOKE SELECT (id, org_id, project_id, user_id, type, status, pause_requested, run_id, lease_expires_at) ON jobs FROM ${auth}`,
    sql`DROP TABLE agent_job_tokens`,
    sql`DROP FUNCTION agent_job_tokens_guard()`,
  ]);
}
