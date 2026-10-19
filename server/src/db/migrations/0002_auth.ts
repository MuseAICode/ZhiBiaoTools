// 鉴权（docs/SERVER_DESIGN.md 第 2.6、3 节）：邀请表、登录前查询的受控入口、users 的列级授权。
//
// 登录、按令牌查会话、找回密码、兑换邀请都发生在拿到用户和组织之前，在 0001 的 RLS 策略下查不到任何行。
// 这些查询只能经下面的 SECURITY DEFINER 函数完成：
// - 函数属主是专用角色 bidtools_auth（NOLOGIN、无 BYPASSRLS），表上只为它建了策略、授了函数要用到的列；
// - 固定 search_path = pg_catalog, pg_temp，表和函数一律写全限定名，防止调用方用同名对象劫持；
// - 按完整的邮箱或令牌哈希精确匹配，最多返回一行、只返回调用方需要的字段，不能用来列举；
// - 收回 PUBLIC 的 EXECUTE，只授权给应用角色 bidtools_app。
//
// 另外收紧 users 的写权限：应用角色只能写入注册所需的列、只能修改密码，不能把自己设为平台管理员或改状态。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE, AUTH_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const auth = sql.id(AUTH_ROLE);

/** 函数签名，up 中授权和 down 中删除共用。 */
const FUNCTIONS = [
  'auth_login_lookup(text)',
  'auth_session_lookup(bytea)',
  'auth_revoke_my_sessions()',
  'auth_issue_password_reset(text, bytea)',
  'auth_reset_password(bytea, text)',
  'auth_consume_invitation(bytea)',
] as const;

const SECURE = sql.raw('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 平台级邀请：由平台管理员发出，凭链接注册，注册时自动创建个人组织（第 3.1 节，第 9 节第 5 项）。
    // 组织 owner 邀请成员加入团队组织留到团队功能（届时另建 org_invitations）。
    // consumed_by 外键延迟到提交时检查：兑换邀请在创建用户之前，二者在同一事务中。
    sql`CREATE TABLE invitations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
          token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
          invited_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          expires_at timestamptz NOT NULL,
          consumed_at timestamptz,
          consumed_by uuid REFERENCES users (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT invitations_token_hash_key UNIQUE (token_hash)
        )`,
    sql`CREATE INDEX invitations_invited_by_idx ON invitations (invited_by)`,
    sql`ALTER TABLE invitations ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE invitations FORCE ROW LEVEL SECURITY`,
    // 平台管理员只能看到自己发出的邀请；只有平台管理员能以自己的名义发邀请。
    // 判断“是否平台管理员”时读 users 同样受 RLS 约束：只能看到当前组织的成员（含自己）。
    sql`CREATE POLICY invitations_select_own ON invitations FOR SELECT
          USING (invited_by = app_current_user_id())`,
    sql`CREATE POLICY invitations_insert_platform_admin ON invitations FOR INSERT
          WITH CHECK (invited_by = app_current_user_id() AND EXISTS (
            SELECT 1 FROM users u WHERE u.id = app_current_user_id() AND u.is_platform_admin
          ))`,
    sql`GRANT SELECT, INSERT ON invitations TO ${app}`,

    // users：应用角色只能写入注册所需的列，只能修改密码。status、is_platform_admin、phone 取默认值，
    // 由运维（平台管理员命令行）或以后的专门入口修改。
    sql`REVOKE INSERT, UPDATE ON users FROM ${app}`,
    sql`GRANT INSERT (id, email, password_hash, email_verified_at) ON users TO ${app}`,
    sql`GRANT UPDATE (password_hash, updated_at) ON users TO ${app}`,

    // bidtools_auth：只授函数用到的列；策略只对它生效（TO bidtools_auth），应用角色不受影响。
    sql`GRANT USAGE ON SCHEMA public TO ${auth}`,
    sql`GRANT SELECT (id, email, password_hash, status, email_verified_at), UPDATE (password_hash, updated_at) ON users TO ${auth}`,
    sql`GRANT SELECT (id, kind) ON organizations TO ${auth}`,
    sql`GRANT SELECT (org_id, user_id, role, created_at) ON org_memberships TO ${auth}`,
    sql`GRANT SELECT (id, org_id, user_id, token_hash, last_seen_at, expires_at, revoked_at), UPDATE (revoked_at) ON sessions TO ${auth}`,
    sql`GRANT SELECT (user_id, kind, token_hash, expires_at, consumed_at), INSERT (user_id, kind, token_hash, expires_at),
          UPDATE (consumed_at) ON auth_tokens TO ${auth}`,
    sql`GRANT SELECT (email, token_hash, expires_at, consumed_at), UPDATE (consumed_at, consumed_by) ON invitations TO ${auth}`,
    sql`CREATE POLICY users_auth_functions ON users TO ${auth} USING (true) WITH CHECK (true)`,
    sql`CREATE POLICY organizations_auth_functions ON organizations FOR SELECT TO ${auth} USING (true)`,
    sql`CREATE POLICY org_memberships_auth_functions ON org_memberships FOR SELECT TO ${auth} USING (true)`,
    sql`CREATE POLICY sessions_auth_functions ON sessions TO ${auth} USING (true) WITH CHECK (true)`,
    sql`CREATE POLICY auth_tokens_auth_functions ON auth_tokens TO ${auth}
          USING (kind = 'password_reset') WITH CHECK (kind = 'password_reset')`,
    sql`CREATE POLICY invitations_auth_functions ON invitations TO ${auth} USING (true) WITH CHECK (true)`,

    // 以 bidtools_auth 的身份建函数，使其成为属主；建完即收回它在 public 的 CREATE 权限。
    sql`GRANT CREATE ON SCHEMA public TO ${auth}`,
    sql`SET ROLE ${auth}`,

    // 登录：按完整邮箱查一个正常、已验证邮箱的用户，返回密码哈希和登录后进入的组织（优先个人组织）。
    // 邮箱不存在、已停用、未验证都返回 0 行，由调用方用假哈希做同样耗时的校验。
    sql`CREATE FUNCTION auth_login_lookup(p_email text)
          RETURNS TABLE (user_id uuid, password_hash text, org_id uuid, member_role text)
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT u.id, u.password_hash, m.org_id, m.role
            FROM public.users u
            JOIN public.org_memberships m ON m.user_id = u.id
            JOIN public.organizations o ON o.id = m.org_id
            WHERE u.email = p_email AND u.status = 'active' AND u.email_verified_at IS NOT NULL
            ORDER BY (o.kind = 'personal') DESC, m.created_at, m.org_id
            LIMIT 1
          $$`,

    // 按令牌哈希查会话：只返回未吊销、未过期、用户正常且仍是该组织成员的会话。
    sql`CREATE FUNCTION auth_session_lookup(p_token_hash bytea)
          RETURNS TABLE (session_id uuid, user_id uuid, org_id uuid, member_role text, last_seen_at timestamptz)
          LANGUAGE sql STABLE ${SECURE}
          AS $$
            SELECT s.id, s.user_id, s.org_id, m.role, s.last_seen_at
            FROM public.sessions s
            JOIN public.org_memberships m ON m.org_id = s.org_id AND m.user_id = s.user_id
            JOIN public.users u ON u.id = s.user_id
            WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'
            LIMIT 1
          $$`,

    // 吊销当前用户（app.user_id）在所有组织中的会话，用于修改密码。会话表的策略按“组织 + 用户”隔离，
    // 应用角色只能改到当前组织的会话。未设置上下文时不影响任何行。
    sql`CREATE FUNCTION auth_revoke_my_sessions()
          RETURNS integer
          LANGUAGE sql VOLATILE ${SECURE}
          AS $$
            WITH revoked AS (
              UPDATE public.sessions SET revoked_at = now()
              WHERE user_id = public.app_current_user_id() AND revoked_at IS NULL
              RETURNING 1
            )
            SELECT count(*)::integer FROM revoked
          $$`,

    // 找回密码第一步：邮箱属于正常用户时作废该用户之前未用的重置令牌，写入新令牌（30 分钟过期）。
    // 只返回是否已签发；有效期在函数内固定，调用方不能签发长期令牌。
    sql`CREATE FUNCTION auth_issue_password_reset(p_email text, p_token_hash bytea)
          RETURNS boolean
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_user_id uuid;
          BEGIN
            SELECT u.id INTO v_user_id FROM public.users u WHERE u.email = p_email AND u.status = 'active';
            IF v_user_id IS NULL THEN
              RETURN false;
            END IF;
            UPDATE public.auth_tokens t SET consumed_at = now()
              WHERE t.user_id = v_user_id AND t.kind = 'password_reset' AND t.consumed_at IS NULL;
            INSERT INTO public.auth_tokens (user_id, kind, token_hash, expires_at)
              VALUES (v_user_id, 'password_reset', p_token_hash, now() + interval '30 minutes');
            RETURN true;
          END
          $$`,

    // 找回密码第二步：令牌一次性、限时。标记已用、更新密码、吊销该用户全部会话，三者在同一事务。
    // 并发重放时第二个 UPDATE 等待行锁后重新检查 consumed_at，影响 0 行。
    sql`CREATE FUNCTION auth_reset_password(p_token_hash bytea, p_password_hash text)
          RETURNS boolean
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_user_id uuid;
          BEGIN
            IF p_password_hash IS NULL OR left(p_password_hash, 10) <> '$argon2id$' THEN
              RAISE EXCEPTION 'password hash must be argon2id' USING ERRCODE = '22023';
            END IF;
            UPDATE public.auth_tokens t SET consumed_at = now()
              WHERE t.token_hash = p_token_hash AND t.kind = 'password_reset'
                AND t.consumed_at IS NULL AND t.expires_at > now()
              RETURNING t.user_id INTO v_user_id;
            IF v_user_id IS NULL THEN
              RETURN false;
            END IF;
            UPDATE public.users u SET password_hash = p_password_hash, updated_at = now()
              WHERE u.id = v_user_id AND u.status = 'active';
            IF NOT FOUND THEN
              RETURN false;
            END IF;
            UPDATE public.sessions s SET revoked_at = now() WHERE s.user_id = v_user_id AND s.revoked_at IS NULL;
            RETURN true;
          END
          $$`,

    // 兑换邀请：调用方先把新用户的 ID 设为 app.user_id，函数把邀请标记为由该用户兑换，返回受邀邮箱。
    // 无效、过期、已用都返回 NULL。之后在同一事务中创建用户；事务回滚时邀请保持未用。
    sql`CREATE FUNCTION auth_consume_invitation(p_token_hash bytea)
          RETURNS text
          LANGUAGE plpgsql VOLATILE ${SECURE}
          AS $$
          DECLARE
            v_user_id uuid := public.app_current_user_id();
            v_email text;
          BEGIN
            IF v_user_id IS NULL THEN
              RETURN NULL;
            END IF;
            UPDATE public.invitations i SET consumed_at = now(), consumed_by = v_user_id
              WHERE i.token_hash = p_token_hash AND i.consumed_at IS NULL AND i.expires_at > now()
              RETURNING i.email INTO v_email;
            RETURN v_email;
          END
          $$`,

    ...FUNCTIONS.flatMap((signature) => [
      sql`REVOKE ALL ON FUNCTION ${sql.raw(signature)} FROM PUBLIC`,
      sql`GRANT EXECUTE ON FUNCTION ${sql.raw(signature)} TO ${app}`,
    ]),

    sql`RESET ROLE`,
    sql`REVOKE CREATE ON SCHEMA public FROM ${auth}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 函数属主是 bidtools_auth，以它的身份删除。
    sql`SET ROLE ${auth}`,
    ...FUNCTIONS.map((signature) => sql`DROP FUNCTION ${sql.raw(signature)}`),
    sql`RESET ROLE`,

    sql`DROP POLICY users_auth_functions ON users`,
    sql`DROP POLICY organizations_auth_functions ON organizations`,
    sql`DROP POLICY org_memberships_auth_functions ON org_memberships`,
    sql`DROP POLICY sessions_auth_functions ON sessions`,
    sql`DROP POLICY auth_tokens_auth_functions ON auth_tokens`,
    sql`REVOKE ALL ON users, organizations, org_memberships, sessions, auth_tokens FROM ${auth}`,
    // 列级授权不随表级 REVOKE 收回，逐一收回。
    sql`REVOKE SELECT (id, email, password_hash, status, email_verified_at), UPDATE (password_hash, updated_at) ON users FROM ${auth}`,
    sql`REVOKE SELECT (id, kind) ON organizations FROM ${auth}`,
    sql`REVOKE SELECT (org_id, user_id, role, created_at) ON org_memberships FROM ${auth}`,
    sql`REVOKE SELECT (id, org_id, user_id, token_hash, last_seen_at, expires_at, revoked_at), UPDATE (revoked_at) ON sessions FROM ${auth}`,
    sql`REVOKE SELECT (user_id, kind, token_hash, expires_at, consumed_at), INSERT (user_id, kind, token_hash, expires_at),
          UPDATE (consumed_at) ON auth_tokens FROM ${auth}`,
    sql`REVOKE USAGE ON SCHEMA public FROM ${auth}`,

    sql`REVOKE INSERT (id, email, password_hash, email_verified_at), UPDATE (password_hash, updated_at) ON users FROM ${app}`,
    sql`GRANT INSERT, UPDATE ON users TO ${app}`,

    sql`DROP TABLE invitations`,
  ]);
}
