// 登录前查询的 SECURITY DEFINER 函数（0002_auth）：属性、授权，以及不能被用来列举或越权读写其他数据。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { APP_ROLE, AUTH_ROLE, OWNER_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const FUNCTIONS = {
  auth_login_lookup: 'text',
  auth_session_lookup: 'bytea',
  auth_revoke_my_sessions: '',
  auth_issue_password_reset: 'text, bytea',
  auth_reset_password: 'bytea, text',
  auth_consume_invitation: 'bytea',
} as const;

const ARGON2_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';

let testDb: TestDatabase;
let admin: Kysely<Database>;
let appDb: Kysely<Database>;

const ids = {
  orgA: randomUUID(),
  teamOrg: randomUUID(),
  orgB: randomUUID(),
  orgDisabled: randomUUID(),
  orgUnverified: randomUUID(),
  userA: randomUUID(),
  userB: randomUUID(),
  userDisabled: randomUUID(),
  userUnverified: randomUUID(),
};

const tokens = {
  sessionA: randomBytes(32),
  sessionATeam: randomBytes(32),
  sessionB: randomBytes(32),
  revoked: randomBytes(32),
  expired: randomBytes(32),
  disabledUser: randomBytes(32),
};

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest();
const inOneDay = () => new Date(Date.now() + 86_400_000);
const yesterday = () => new Date(Date.now() - 86_400_000);

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  admin = testDb.admin as Kysely<Database>;
  appDb = connect<Database>(testDb.appConfig);

  await admin.insertInto('organizations').values([
    { id: ids.orgA, name: 'A 的个人组织', kind: 'personal' },
    { id: ids.teamOrg, name: '团队', kind: 'team' },
    { id: ids.orgB, name: 'B 的个人组织', kind: 'personal' },
    { id: ids.orgDisabled, name: '停用用户的组织', kind: 'personal' },
    { id: ids.orgUnverified, name: '未验证用户的组织', kind: 'personal' },
  ]).execute();
  const verified = new Date();
  await admin.insertInto('users').values([
    { id: ids.userA, email: 'a@example.com', password_hash: 'hash-a', email_verified_at: verified },
    { id: ids.userB, email: 'b@example.com', password_hash: 'hash-b', email_verified_at: verified },
    { id: ids.userDisabled, email: 'disabled@example.com', password_hash: 'hash-d', email_verified_at: verified, status: 'disabled' },
    { id: ids.userUnverified, email: 'unverified@example.com', password_hash: 'hash-u', email_verified_at: null },
  ]).execute();
  // A 先加入团队组织、后有个人组织，登录时仍应进入个人组织。
  await admin.insertInto('org_memberships').values([
    { org_id: ids.teamOrg, user_id: ids.userA, role: 'member', created_at: yesterday() },
    { org_id: ids.orgA, user_id: ids.userA, role: 'owner' },
    { org_id: ids.teamOrg, user_id: ids.userB, role: 'owner' },
    { org_id: ids.orgB, user_id: ids.userB, role: 'owner' },
    { org_id: ids.orgDisabled, user_id: ids.userDisabled, role: 'owner' },
    { org_id: ids.orgUnverified, user_id: ids.userUnverified, role: 'owner' },
  ]).execute();
});

beforeEach(async () => {
  await admin.deleteFrom('sessions').execute();
  await admin.deleteFrom('auth_tokens').execute();
  await admin.deleteFrom('invitations').execute();
  await admin.insertInto('sessions').values([
    { org_id: ids.orgA, user_id: ids.userA, token_hash: sha(tokens.sessionA), expires_at: inOneDay() },
    { org_id: ids.teamOrg, user_id: ids.userA, token_hash: sha(tokens.sessionATeam), expires_at: inOneDay() },
    { org_id: ids.orgB, user_id: ids.userB, token_hash: sha(tokens.sessionB), expires_at: inOneDay() },
    { org_id: ids.orgA, user_id: ids.userA, token_hash: sha(tokens.revoked), expires_at: inOneDay(), revoked_at: new Date() },
    { org_id: ids.orgA, user_id: ids.userA, token_hash: sha(tokens.expired), expires_at: yesterday() },
    { org_id: ids.orgDisabled, user_id: ids.userDisabled, token_hash: sha(tokens.disabledUser), expires_at: inOneDay() },
  ]).execute();
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

function loginLookup(email: string | null) {
  return sql<Record<string, unknown>>`SELECT * FROM auth_login_lookup(${email})`.execute(appDb).then((r) => r.rows);
}

function sessionLookup(hash: Buffer | null) {
  return sql<Record<string, unknown>>`SELECT * FROM auth_session_lookup(${hash})`.execute(appDb).then((r) => r.rows);
}

async function issueReset(email: string | null, hash: Buffer): Promise<boolean> {
  const result = await sql<{ issued: boolean }>`SELECT auth_issue_password_reset(${email}, ${hash}) AS issued`.execute(appDb);
  return result.rows[0]!.issued;
}

async function resetPassword(hash: Buffer, passwordHash: string): Promise<boolean> {
  const result = await sql<{ ok: boolean }>`SELECT auth_reset_password(${hash}, ${passwordHash}) AS ok`.execute(appDb);
  return result.rows[0]!.ok;
}

async function liveSessions(userId: string): Promise<number> {
  const row = await admin
    .selectFrom('sessions')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

describe('函数属性与授权', () => {
  it('属主角色不能登录、不是超级用户、没有 BYPASSRLS', async () => {
    const result = await sql<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${AUTH_ROLE}`.execute(admin);
    expect(result.rows).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false }]);
  });

  it.each(Object.entries(FUNCTIONS))('%s：SECURITY DEFINER、固定 search_path、属主为专用角色，只授权给应用角色', async (name, args) => {
    const signature = `${name}(${args})`;
    const result = await sql<{ prosecdef: boolean; proconfig: string[]; owner: string; public_acl: boolean }>`
      SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_acl
      FROM pg_proc p WHERE p.oid = ${signature}::regprocedure`.execute(admin);
    expect(result.rows).toEqual([
      { prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], owner: AUTH_ROLE, public_acl: false },
    ]);

    const privileges = await sql<{ app: boolean; owner: boolean }>`
      SELECT has_function_privilege(${APP_ROLE}, ${signature}, 'EXECUTE') AS app,
             has_function_privilege(${OWNER_ROLE}, ${signature}, 'EXECUTE') AS owner`.execute(admin);
    // 迁移角色是专用角色的成员但不继承其权限，同样不能直接调用。
    expect(privileges.rows).toEqual([{ app: true, owner: false }]);
  });

  it('应用角色和迁移角色都不能以专用角色的身份执行', async () => {
    await expect(sql`SET ROLE ${sql.id(AUTH_ROLE)}`.execute(appDb)).rejects.toThrow(/permission denied/);
    const owner = connect(testDb.ownerConfig);
    try {
      // 迁移角色可以 SET ROLE（只用于迁移中建删函数），但不继承专用角色的策略，直接查询仍是 0 行。
      expect(await owner.selectFrom('users' as never).selectAll().execute()).toEqual([]);
    } finally {
      await owner.destroy();
    }
  });

  it('专用角色只有函数用到的列权限：读不到手机号、平台管理员标记等其他列', async () => {
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.column_privileges
      WHERE grantee = ${AUTH_ROLE} AND table_name = 'users' AND privilege_type = 'SELECT' ORDER BY column_name`.execute(admin);
    expect(result.rows.map((row) => row.column_name)).toEqual(['email', 'email_verified_at', 'id', 'password_hash', 'status']);
  });

  it('其他角色不能调用（PUBLIC 的 EXECUTE 已收回）', async () => {
    const role = `bidtools_test_other_${randomBytes(4).toString('hex')}`;
    await sql`CREATE ROLE ${sql.id(role)} NOLOGIN`.execute(admin);
    try {
      for (const [name, args] of Object.entries(FUNCTIONS)) {
        const result = await sql<{ allowed: boolean }>`
          SELECT has_function_privilege(${role}, ${`${name}(${args})`}, 'EXECUTE') AS allowed`.execute(admin);
        expect(result.rows[0]!.allowed, name).toBe(false);
      }
    } finally {
      await sql`DROP ROLE ${sql.id(role)}`.execute(admin);
    }
  });
});

describe('auth_login_lookup', () => {
  it('按完整邮箱返回一行，只有登录所需的四个字段，优先个人组织', async () => {
    const rows = await loginLookup('a@example.com');
    expect(rows).toEqual([{ user_id: ids.userA, password_hash: 'hash-a', org_id: ids.orgA, member_role: 'owner' }]);
  });

  it.each([
    ['LIKE 通配符', '%'],
    ['后缀通配', '%@example.com'],
    ['单字符通配', '_@example.com'],
    ['正则', '.*'],
    ['空字符串', ''],
    ['大写（调用方负责归一化）', 'A@EXAMPLE.COM'],
    ['首尾空白', ' a@example.com'],
    ['SQL 注入', "' OR '1'='1"],
    ['NULL', null],
  ])('不能列举：%s → 0 行', async (_name, email) => {
    expect(await loginLookup(email)).toEqual([]);
  });

  it('停用或未验证邮箱的用户返回 0 行（与不存在的邮箱无法区分）', async () => {
    expect(await loginLookup('disabled@example.com')).toEqual([]);
    expect(await loginLookup('unverified@example.com')).toEqual([]);
    expect(await loginLookup('nobody@example.com')).toEqual([]);
  });

  it('返回类型固定：不能通过 SELECT * 拿到其他列', async () => {
    const result = await sql<{ result: string }>`
      SELECT pg_get_function_result('auth_login_lookup(text)'::regprocedure) AS result`.execute(admin);
    expect(result.rows[0]!.result).toBe('TABLE(user_id uuid, password_hash text, org_id uuid, member_role text)');
  });
});

describe('auth_session_lookup', () => {
  it('有效令牌返回一行，只含会话、用户、组织、角色和最近活动时间', async () => {
    const rows = await sessionLookup(sha(tokens.sessionA));
    expect(rows).toEqual([
      { session_id: expect.any(String), user_id: ids.userA, org_id: ids.orgA, member_role: 'owner', last_seen_at: expect.any(Date) },
    ]);
  });

  it.each([
    ['随机哈希', () => sha(randomBytes(32))],
    ['令牌原文（不是哈希）', () => tokens.sessionA],
    ['空字节串', () => Buffer.alloc(0)],
    ['NULL', () => null],
    ['已吊销', () => sha(tokens.revoked)],
    ['已过期', () => sha(tokens.expired)],
    ['用户已停用', () => sha(tokens.disabledUser)],
  ])('%s → 0 行', async (_name, hash) => {
    expect(await sessionLookup(hash())).toEqual([]);
  });

  it('移出组织后会话立即失效', async () => {
    const member = randomUUID();
    await admin.insertInto('users').values({ id: member, email: `m-${member}@example.com`, password_hash: 'x', email_verified_at: new Date() }).execute();
    await admin.insertInto('org_memberships').values({ org_id: ids.teamOrg, user_id: member, role: 'member' }).execute();
    const token = randomBytes(32);
    await admin.insertInto('sessions').values({ org_id: ids.teamOrg, user_id: member, token_hash: sha(token), expires_at: inOneDay() }).execute();
    expect(await sessionLookup(sha(token))).toHaveLength(1);
    await admin.deleteFrom('org_memberships').where('user_id', '=', member).execute();
    expect(await sessionLookup(sha(token))).toEqual([]);
  });
});

describe('auth_revoke_my_sessions', () => {
  it('未设置上下文时不影响任何会话', async () => {
    const result = await sql<{ n: number }>`SELECT auth_revoke_my_sessions() AS n`.execute(appDb);
    expect(result.rows[0]!.n).toBe(0);
    // A 有两个有效会话和一个已过期但未吊销的会话。
    expect(await liveSessions(ids.userA)).toBe(3);
    expect(await liveSessions(ids.userB)).toBe(1);
  });

  it('只吊销当前用户在所有组织中的会话，不影响其他用户', async () => {
    const revoked = await withTenant(appDb, { orgId: ids.orgA, userId: ids.userA, role: 'owner' }, async (trx) => {
      const result = await sql<{ n: number }>`SELECT auth_revoke_my_sessions() AS n`.execute(trx);
      return result.rows[0]!.n;
    });
    expect(revoked).toBe(3);
    expect(await liveSessions(ids.userA)).toBe(0);
    expect(await liveSessions(ids.userB)).toBe(1);
  });
});

describe('auth_issue_password_reset', () => {
  async function tokenCount(): Promise<number> {
    const row = await admin.selectFrom('auth_tokens').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    return Number(row.n);
  }

  it.each([
    ['不存在的邮箱', 'nobody@example.com'],
    ['通配符', '%'],
    ['停用用户', 'disabled@example.com'],
    ['NULL', null],
  ])('%s：返回 false，不写入任何令牌', async (_name, email) => {
    expect(await issueReset(email, sha(randomBytes(32)))).toBe(false);
    expect(await tokenCount()).toBe(0);
  });

  it('正常用户：写入 30 分钟后过期的令牌，并作废之前未用的令牌', async () => {
    const first = sha(randomBytes(32));
    const second = sha(randomBytes(32));
    expect(await issueReset('a@example.com', first)).toBe(true);
    expect(await issueReset('a@example.com', second)).toBe(true);
    const rows = await admin.selectFrom('auth_tokens').selectAll().orderBy('created_at').execute();
    expect(rows).toHaveLength(2);
    const [old, current] = rows.sort((x, y) => (x.token_hash.equals(first) ? -1 : y.token_hash.equals(first) ? 1 : 0));
    expect(old!.consumed_at).not.toBeNull();
    expect(current!.consumed_at).toBeNull();
    expect(current!.user_id).toBe(ids.userA);
    expect(current!.kind).toBe('password_reset');
    const ttl = current!.expires_at.getTime() - current!.created_at.getTime();
    expect(ttl).toBe(30 * 60_000);
    // 旧令牌已不能使用。
    expect(await resetPassword(first, ARGON2_HASH)).toBe(false);
  });
});

describe('auth_reset_password', () => {
  async function issue(email = 'a@example.com'): Promise<Buffer> {
    const hash = sha(randomBytes(32));
    expect(await issueReset(email, hash)).toBe(true);
    return hash;
  }

  async function passwordOf(userId: string): Promise<string> {
    const row = await admin.selectFrom('users').select('password_hash').where('id', '=', userId).executeTakeFirstOrThrow();
    return row.password_hash;
  }

  it('有效令牌：更新密码、吊销该用户全部会话；同一令牌重放失败', async () => {
    const hash = await issue();
    expect(await resetPassword(hash, ARGON2_HASH)).toBe(true);
    expect(await passwordOf(ids.userA)).toBe(ARGON2_HASH);
    expect(await liveSessions(ids.userA)).toBe(0);
    expect(await liveSessions(ids.userB)).toBe(1);

    const other = `${ARGON2_HASH.slice(0, -2)}xx`;
    expect(await resetPassword(hash, other)).toBe(false);
    expect(await passwordOf(ids.userA)).toBe(ARGON2_HASH);
  });

  it('过期令牌失败，密码不变', async () => {
    await admin.updateTable('users').set({ password_hash: 'hash-a' }).where('id', '=', ids.userA).execute();
    const hash = await issue();
    await admin.updateTable('auth_tokens').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    expect(await resetPassword(hash, ARGON2_HASH)).toBe(false);
    expect(await passwordOf(ids.userA)).toBe('hash-a');
    expect(await liveSessions(ids.userA)).toBe(3);
  });

  it('其他类型的令牌（邮箱验证）不能用来重置密码', async () => {
    const token = sha(randomBytes(32));
    await admin.insertInto('auth_tokens').values({ user_id: ids.userB, kind: 'email_verification', token_hash: token, expires_at: inOneDay() }).execute();
    expect(await resetPassword(token, ARGON2_HASH)).toBe(false);
    expect(await passwordOf(ids.userB)).toBe('hash-b');
  });

  it('随机哈希、NULL 失败', async () => {
    expect(await resetPassword(sha(randomBytes(32)), ARGON2_HASH)).toBe(false);
    const result = await sql<{ ok: boolean | null }>`SELECT auth_reset_password(NULL, ${ARGON2_HASH}) AS ok`.execute(appDb);
    expect(result.rows[0]!.ok).toBe(false);
  });

  it('签发后用户被停用：令牌作废，密码不变', async () => {
    const hash = await issue('b@example.com');
    await admin.updateTable('users').set({ status: 'disabled' }).where('id', '=', ids.userB).execute();
    try {
      expect(await resetPassword(hash, ARGON2_HASH)).toBe(false);
      expect(await passwordOf(ids.userB)).toBe('hash-b');
    } finally {
      await admin.updateTable('users').set({ status: 'active' }).where('id', '=', ids.userB).execute();
    }
    expect(await resetPassword(hash, ARGON2_HASH)).toBe(false);
  });

  it('拒绝非 argon2id 的密码哈希（防止写入明文）', async () => {
    const hash = await issue();
    await expect(resetPassword(hash, 'plaintext-password')).rejects.toThrow(/argon2id/);
    // 出错时整个调用回滚，令牌仍然可用。
    expect(await resetPassword(hash, ARGON2_HASH)).toBe(true);
  });
});

describe('auth_consume_invitation', () => {
  async function invite(overrides: { expires_at?: Date } = {}): Promise<Buffer> {
    const hash = sha(randomBytes(32));
    await admin.insertInto('invitations').values({
      email: `invitee-${randomUUID()}@example.com`,
      token_hash: hash,
      invited_by: ids.userA,
      expires_at: overrides.expires_at ?? inOneDay(),
    }).execute();
    return hash;
  }

  /** 以“即将创建的新用户”为上下文兑换，并在同一事务中创建该用户（与注册流程一致）。 */
  async function consume(hash: Buffer | null): Promise<string | null> {
    const context = { orgId: randomUUID(), userId: randomUUID(), role: 'owner' as const };
    return withTenant(appDb, context, async (trx) => {
      const result = await sql<{ email: string | null }>`SELECT auth_consume_invitation(${hash}) AS email`.execute(trx);
      const email = result.rows[0]!.email;
      if (email) {
        await trx.insertInto('users').values({ id: context.userId, email, password_hash: 'x' }).execute();
      }
      return email;
    });
  }

  it('有效邀请返回受邀邮箱并记录兑换人；重放返回 NULL', async () => {
    const hash = await invite();
    const email = await consume(hash);
    expect(email).toMatch(/^invitee-.*@example\.com$/);
    const row = await admin.selectFrom('invitations').selectAll().where('token_hash', '=', hash).executeTakeFirstOrThrow();
    expect(row.consumed_at).not.toBeNull();
    expect(row.consumed_by).not.toBeNull();
    expect(await consume(hash)).toBeNull();
  });

  it('过期、随机、NULL 都返回 NULL', async () => {
    expect(await consume(await invite({ expires_at: new Date(Date.now() - 1000) }))).toBeNull();
    expect(await consume(sha(randomBytes(32)))).toBeNull();
    expect(await consume(null)).toBeNull();
  });

  it('未设置 app.user_id 时不兑换', async () => {
    const hash = await invite();
    const result = await sql<{ email: string | null }>`SELECT auth_consume_invitation(${hash}) AS email`.execute(appDb);
    expect(result.rows[0]!.email).toBeNull();
    const row = await admin.selectFrom('invitations').select('consumed_at').where('token_hash', '=', hash).executeTakeFirstOrThrow();
    expect(row.consumed_at).toBeNull();
  });

  it('事务回滚（例如创建用户失败）后邀请保持未用', async () => {
    const hash = await invite();
    await expect(
      withTenant(appDb, { orgId: randomUUID(), userId: randomUUID(), role: 'owner' }, async (trx) => {
        await sql`SELECT auth_consume_invitation(${hash})`.execute(trx);
        throw new Error('注册失败');
      }),
    ).rejects.toThrow('注册失败');
    expect(await consume(hash)).not.toBeNull();
  });

  it('兑换后未创建对应用户时，提交被延迟外键拒绝', async () => {
    const hash = await invite();
    await expect(
      withTenant(appDb, { orgId: randomUUID(), userId: randomUUID(), role: 'owner' }, async (trx) => {
        await sql`SELECT auth_consume_invitation(${hash})`.execute(trx);
      }),
    ).rejects.toThrow(/foreign key/);
    expect(await consume(hash)).not.toBeNull();
  });
});

describe('应用角色对 users 和 invitations 的写权限', () => {
  const ctxA = () => ({ orgId: ids.orgA, userId: ids.userA, role: 'owner' as const });

  it('不能把自己设为平台管理员，也不能改状态、邮箱', async () => {
    for (const change of [{ is_platform_admin: true }, { status: 'active' as const }, { email: 'x@example.com' }]) {
      await expect(
        withTenant(appDb, ctxA(), (trx) => trx.updateTable('users').set(change).where('id', '=', ids.userA).execute()),
      ).rejects.toThrow(/permission denied/);
    }
    // 可以改自己的密码。
    const changed = await withTenant(appDb, ctxA(), (trx) =>
      trx.updateTable('users').set({ password_hash: 'hash-a' }).where('id', '=', ids.userA).executeTakeFirst(),
    );
    expect(changed.numUpdatedRows).toBe(1n);
  });

  it('注册时不能直接创建平台管理员', async () => {
    const context = { orgId: randomUUID(), userId: randomUUID(), role: 'owner' as const };
    await expect(
      withTenant(appDb, context, (trx) =>
        trx.insertInto('users').values({ id: context.userId, email: 'sneaky@example.com', password_hash: 'x', is_platform_admin: true }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('非平台管理员不能发邀请；平台管理员只能看到自己发出的邀请', async () => {
    const values = (invitedBy: string) => ({
      email: 'new@example.com',
      token_hash: sha(randomBytes(32)),
      invited_by: invitedBy,
      expires_at: inOneDay(),
    });
    await expect(
      withTenant(appDb, ctxA(), (trx) => trx.insertInto('invitations').values(values(ids.userA)).execute()),
    ).rejects.toThrow(/row-level security/);

    await admin.updateTable('users').set({ is_platform_admin: true }).where('id', '=', ids.userA).execute();
    try {
      await withTenant(appDb, ctxA(), (trx) => trx.insertInto('invitations').values(values(ids.userA)).execute());
      // 不能以别人的名义发邀请。
      await expect(
        withTenant(appDb, ctxA(), (trx) => trx.insertInto('invitations').values(values(ids.userB)).execute()),
      ).rejects.toThrow(/row-level security/);
      await admin.insertInto('invitations').values(values(ids.userB)).execute();
      const visible = await withTenant(appDb, ctxA(), (trx) => trx.selectFrom('invitations').select('invited_by').execute());
      expect(visible).toEqual([{ invited_by: ids.userA }]);
      // 应用角色不能改、删邀请（兑换只能经函数）。
      await expect(
        withTenant(appDb, ctxA(), (trx) => trx.updateTable('invitations').set({ consumed_at: new Date() }).execute()),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await admin.updateTable('users').set({ is_platform_admin: false }).where('id', '=', ids.userA).execute();
    }
  });
});
