// 第一批表：身份与租户（docs/SERVER_DESIGN.md 第 2.5、2.6、3 节）。
//
// 隔离方式：
// - 每张表 ENABLE + FORCE ROW LEVEL SECURITY，表属主（迁移角色）同样受策略约束；
// - 上下文来自事务级设置 app.org_id / app.user_id（src/db/tenant.ts 的 withTenant），
//   未设置时 app_current_org_id() / app_current_user_id() 为 NULL，所有策略都不成立，查询返回 0 行；
// - 应用角色 bidtools_app 只有增删改查权限，不是表属主，不能关闭 RLS。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  // 带参数的查询走扩展协议，一次只能执行一条语句，所以逐条执行。
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 设置被清空后（SET LOCAL 所在事务结束、连接回到池中）current_setting 返回空字符串而不是 NULL，
    // 用 NULLIF 统一为 NULL，避免 ''::uuid 报错。
    sql`CREATE FUNCTION app_current_org_id() RETURNS uuid
          LANGUAGE sql STABLE PARALLEL SAFE
          AS $$ SELECT NULLIF(pg_catalog.current_setting('app.org_id', true), '')::uuid $$`,
    sql`CREATE FUNCTION app_current_user_id() RETURNS uuid
          LANGUAGE sql STABLE PARALLEL SAFE
          AS $$ SELECT NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid $$`,

    sql`CREATE TABLE organizations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
          kind text NOT NULL CHECK (kind IN ('personal', 'team')),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`,

    sql`CREATE TABLE users (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
          password_hash text NOT NULL,
          email_verified_at timestamptz,
          phone text CHECK (phone ~ '^\\+[1-9][0-9]{6,14}$'),
          phone_verified_at timestamptz,
          status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          is_platform_admin boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT users_email_key UNIQUE (email),
          CONSTRAINT users_phone_key UNIQUE (phone),
          CONSTRAINT users_phone_verified_requires_phone CHECK (phone_verified_at IS NULL OR phone IS NOT NULL)
        )`,

    sql`CREATE TABLE org_memberships (
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (org_id, user_id)
        )`,
    sql`CREATE INDEX org_memberships_user_id_idx ON org_memberships (user_id)`,

    // 会话的当前组织必须是该用户所属的组织：复合外键指向成员关系，移出组织时会话随之删除。
    sql`CREATE TABLE sessions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          user_id uuid NOT NULL,
          token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
          created_at timestamptz NOT NULL DEFAULT now(),
          last_seen_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL,
          revoked_at timestamptz,
          user_agent text CHECK (char_length(user_agent) <= 512),
          ip_summary text CHECK (char_length(ip_summary) <= 64),
          CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
          CONSTRAINT sessions_membership_fkey FOREIGN KEY (org_id, user_id)
            REFERENCES org_memberships (org_id, user_id) ON DELETE CASCADE
        )`,
    sql`CREATE INDEX sessions_org_id_user_id_idx ON sessions (org_id, user_id)`,
    sql`CREATE INDEX sessions_user_id_idx ON sessions (user_id)`,

    // 一次性令牌只存哈希。短信验证码（第二版）只有 6 位，不同用户可能撞值，所以唯一约束不覆盖 sms_login。
    sql`CREATE TABLE auth_tokens (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          kind text NOT NULL CHECK (kind IN ('email_verification', 'password_reset', 'sms_login')),
          token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
          expires_at timestamptz NOT NULL,
          consumed_at timestamptz,
          attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          created_at timestamptz NOT NULL DEFAULT now()
        )`,
    sql`CREATE UNIQUE INDEX auth_tokens_token_hash_key ON auth_tokens (token_hash) WHERE kind <> 'sms_login'`,
    sql`CREATE INDEX auth_tokens_user_id_kind_idx ON auth_tokens (user_id, kind)`,

    ...['organizations', 'users', 'org_memberships', 'sessions', 'auth_tokens'].flatMap((table) => [
      sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`,
      sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`,
    ]),

    sql`CREATE POLICY organizations_tenant ON organizations
          USING (id = app_current_org_id())
          WITH CHECK (id = app_current_org_id())`,

    sql`CREATE POLICY org_memberships_tenant ON org_memberships
          USING (org_id = app_current_org_id())
          WITH CHECK (org_id = app_current_org_id())`,

    // users 不属于某个组织（一个用户可加入多个组织），能看到的是当前组织的成员。
    // 新建用户时还没有成员关系，所以 INSERT 单独按 app.user_id 放行；
    // 只能修改自己；不授予 DELETE（注销删除走后台维护角色，第 2.6 节）。
    sql`CREATE POLICY users_select_members ON users FOR SELECT
          USING (EXISTS (
            SELECT 1 FROM org_memberships m
            WHERE m.org_id = app_current_org_id() AND m.user_id = users.id
          ))`,
    sql`CREATE POLICY users_insert_self ON users FOR INSERT
          WITH CHECK (id = app_current_user_id())`,
    sql`CREATE POLICY users_update_self ON users FOR UPDATE
          USING (id = app_current_user_id() AND EXISTS (
            SELECT 1 FROM org_memberships m
            WHERE m.org_id = app_current_org_id() AND m.user_id = users.id
          ))
          WITH CHECK (id = app_current_user_id())`,

    sql`CREATE POLICY sessions_tenant ON sessions
          USING (org_id = app_current_org_id() AND user_id = app_current_user_id())
          WITH CHECK (org_id = app_current_org_id() AND user_id = app_current_user_id())`,

    sql`CREATE POLICY auth_tokens_self ON auth_tokens
          USING (user_id = app_current_user_id())
          WITH CHECK (user_id = app_current_user_id())`,

    sql`GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, org_memberships, sessions, auth_tokens TO ${app}`,
    sql`GRANT SELECT, INSERT, UPDATE ON users TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // users 的策略引用 org_memberships，org_memberships 又外键引用 users，所以在一条语句里一起删除。
    sql`DROP TABLE auth_tokens, sessions, org_memberships, users, organizations`,
    sql`DROP FUNCTION app_current_user_id()`,
    sql`DROP FUNCTION app_current_org_id()`,
  ]);
}
