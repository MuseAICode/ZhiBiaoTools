// 鉴权相关的数据库访问。登录前的查询只经 0002_auth 迁移中的 SECURITY DEFINER 函数；
// 拿到身份之后的读写一律经 withTenant，受 RLS 约束。
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, MemberRole } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';

/** 空闲 7 天、绝对 30 天（第 3.2 节）。expires_at 取二者较早者，每次续期时重算。 */
export const SESSION_IDLE_TTL_SECONDS = 7 * 24 * 3600;
export const SESSION_ABSOLUTE_TTL_SECONDS = 30 * 24 * 3600;
/** 最近活动时间的写库频率上限。 */
export const SESSION_TOUCH_INTERVAL_MS = 10 * 60_000;
/** 邀请链接有效期。 */
export const INVITATION_TTL_SECONDS = 7 * 24 * 3600;

export interface LoginCandidate {
  userId: string;
  passwordHash: string;
  orgId: string;
  role: MemberRole;
}

export interface SessionRecord {
  sessionId: string;
  context: TenantContext;
  lastSeenAt: Date;
}

export interface NewSession {
  tokenHash: Buffer;
  userAgent: string | null;
  ipSummary: string | null;
}

export async function findLoginCandidate(db: Kysely<Database>, email: string): Promise<LoginCandidate | null> {
  const result = await sql<{ user_id: string; password_hash: string; org_id: string; member_role: MemberRole }>`
    SELECT user_id, password_hash, org_id, member_role FROM auth_login_lookup(${email})`.execute(db);
  const row = result.rows[0];
  return row ? { userId: row.user_id, passwordHash: row.password_hash, orgId: row.org_id, role: row.member_role } : null;
}

export async function findSession(db: Kysely<Database>, tokenHash: Buffer): Promise<SessionRecord | null> {
  const result = await sql<{ session_id: string; user_id: string; org_id: string; member_role: MemberRole; last_seen_at: Date }>`
    SELECT session_id, user_id, org_id, member_role, last_seen_at FROM auth_session_lookup(${tokenHash})`.execute(db);
  const row = result.rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    context: { orgId: row.org_id, userId: row.user_id, role: row.member_role },
    lastSeenAt: row.last_seen_at,
  };
}

/** 个人组织的默认名称，以后可在设置页修改。 */
export const PERSONAL_ORG_NAME = '个人空间';

export interface NewAccount {
  email: string;
  passwordHash: string;
  /** 只有命令行（迁移角色）能设置；应用角色没有这一列的写权限。 */
  platformAdmin?: true;
}

/**
 * 新建用户及其个人组织（第 2.2 节），用户是该组织的 owner。邮箱视为已验证：注册凭邀请链接（发到该邮箱），
 * 平台管理员由运维在命令行创建。上下文必须是 { orgId: 新组织, userId: 新用户, role: 'owner' }。
 */
export async function insertPersonalAccount(trx: Transaction<Database>, context: TenantContext, account: NewAccount): Promise<void> {
  await trx.insertInto('organizations').values({ id: context.orgId, name: PERSONAL_ORG_NAME, kind: 'personal' }).execute();
  await trx
    .insertInto('users')
    .values({
      id: context.userId,
      email: account.email,
      password_hash: account.passwordHash,
      email_verified_at: sql<Date>`now()`,
      ...(account.platformAdmin ? { is_platform_admin: true } : {}),
    })
    .execute();
  await trx.insertInto('org_memberships').values({ org_id: context.orgId, user_id: context.userId, role: 'owner' }).execute();
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: unknown; constraint?: unknown } | null;
  return pgError?.code === '23505' && pgError.constraint === constraint;
}

/** 在当前上下文（组织 + 用户）中新建会话。 */
export async function insertSession(trx: Transaction<Database>, context: TenantContext, session: NewSession): Promise<void> {
  await trx
    .insertInto('sessions')
    .values({
      org_id: context.orgId,
      user_id: context.userId,
      token_hash: session.tokenHash,
      expires_at: sql<Date>`now() + make_interval(secs => ${SESSION_IDLE_TTL_SECONDS})`,
      user_agent: session.userAgent,
      ip_summary: session.ipSummary,
    })
    .execute();
}

export function createSession(db: Kysely<Database>, context: TenantContext, session: NewSession): Promise<void> {
  return withTenant(db, context, (trx) => insertSession(trx, context, session));
}

/** 滑动续期：空闲期限从现在重算，但不超过创建时间 + 绝对期限。 */
export async function touchSession(db: Kysely<Database>, record: SessionRecord): Promise<void> {
  await withTenant(db, record.context, (trx) =>
    trx
      .updateTable('sessions')
      .set({
        last_seen_at: sql<Date>`now()`,
        expires_at: sql<Date>`least(now() + make_interval(secs => ${SESSION_IDLE_TTL_SECONDS}),
                                    created_at + make_interval(secs => ${SESSION_ABSOLUTE_TTL_SECONDS}))`,
      })
      .where('id', '=', record.sessionId)
      .where('revoked_at', 'is', null)
      .execute(),
  );
}

export async function revokeSession(db: Kysely<Database>, record: SessionRecord): Promise<void> {
  await withTenant(db, record.context, (trx) =>
    trx.updateTable('sessions').set({ revoked_at: sql<Date>`now()` }).where('id', '=', record.sessionId).execute(),
  );
}

/** 吊销当前用户在所有组织中的会话（修改密码）。 */
export async function revokeAllSessionsOfCurrentUser(trx: Transaction<Database>): Promise<number> {
  const result = await sql<{ revoked: number }>`SELECT auth_revoke_my_sessions() AS revoked`.execute(trx);
  return result.rows[0]?.revoked ?? 0;
}

export async function issuePasswordReset(db: Kysely<Database>, email: string, tokenHash: Buffer): Promise<boolean> {
  const result = await sql<{ issued: boolean }>`SELECT auth_issue_password_reset(${email}, ${tokenHash}) AS issued`.execute(db);
  return result.rows[0]?.issued === true;
}

export async function resetPassword(db: Kysely<Database>, tokenHash: Buffer, passwordHash: string): Promise<boolean> {
  const result = await sql<{ reset: boolean }>`SELECT auth_reset_password(${tokenHash}, ${passwordHash}) AS reset`.execute(db);
  return result.rows[0]?.reset === true;
}

/** 兑换邀请，返回受邀邮箱；调用前事务上下文的 app.user_id 必须是即将创建的新用户。 */
export async function consumeInvitation(trx: Transaction<Database>, tokenHash: Buffer): Promise<string | null> {
  const result = await sql<{ email: string | null }>`SELECT auth_consume_invitation(${tokenHash}) AS email`.execute(trx);
  return result.rows[0]?.email ?? null;
}
