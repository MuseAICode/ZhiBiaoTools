import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const TABLES = ['organizations', 'users', 'org_memberships', 'sessions', 'auth_tokens', 'invitations'] as const;

let testDb: TestDatabase;
let appDb: Kysely<Database>;

const orgA = randomUUID();
const orgB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const ctxA: TenantContext = { orgId: orgA, userId: userA, role: 'owner' };
const ctxB: TenantContext = { orgId: orgB, userId: userB, role: 'owner' };

function tokenHash(): Buffer {
  return createHash('sha256').update(randomUUID()).digest();
}

const inOneDay = () => new Date(Date.now() + 86_400_000);

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    const resultSet = await migrateToLatest(owner);
    expect(resultSet.error).toBeUndefined();
  } finally {
    await owner.destroy();
  }

  // 用超级用户准备两个组织的数据（超级用户不受 RLS 约束）。
  const admin = testDb.admin as Kysely<Database>;
  await admin.insertInto('organizations').values([
    { id: orgA, name: '组织 A', kind: 'personal' },
    { id: orgB, name: '组织 B', kind: 'personal' },
  ]).execute();
  await admin.insertInto('users').values([
    { id: userA, email: 'a@example.com', password_hash: 'x' },
    { id: userB, email: 'b@example.com', password_hash: 'x' },
  ]).execute();
  await admin.insertInto('org_memberships').values([
    { org_id: orgA, user_id: userA, role: 'owner' },
    { org_id: orgB, user_id: userB, role: 'owner' },
  ]).execute();
  await admin.insertInto('sessions').values([
    { org_id: orgA, user_id: userA, token_hash: tokenHash(), expires_at: inOneDay() },
    { org_id: orgB, user_id: userB, token_hash: tokenHash(), expires_at: inOneDay() },
  ]).execute();
  await admin.insertInto('auth_tokens').values([
    { user_id: userA, kind: 'email_verification', token_hash: tokenHash(), expires_at: inOneDay() },
    { user_id: userB, kind: 'password_reset', token_hash: tokenHash(), expires_at: inOneDay() },
  ]).execute();
  await admin.insertInto('invitations').values([
    { email: 'invitee-a@example.com', token_hash: tokenHash(), invited_by: userA, expires_at: inOneDay() },
    { email: 'invitee-b@example.com', token_hash: tokenHash(), invited_by: userB, expires_at: inOneDay() },
  ]).execute();

  appDb = connect<Database>(testDb.appConfig);
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

async function countRows(db: Kysely<Database>, table: (typeof TABLES)[number]): Promise<number> {
  const row = await db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
  return Number(row.n);
}

describe('应用角色', () => {
  it('非超级用户、无 BYPASSRLS、不是任何表的属主', async () => {
    const role = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`.execute(appDb);
    expect(role.rows).toEqual([{ rolname: testDb.appConfig.user, rolsuper: false, rolbypassrls: false }]);

    const owned = await sql<{ relname: string }>`
      SELECT c.relname FROM pg_class c WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`.execute(appDb);
    expect(owned.rows).toEqual([]);
  });

  it('不能关闭 RLS', async () => {
    await expect(sql`ALTER TABLE organizations DISABLE ROW LEVEL SECURITY`.execute(appDb)).rejects.toThrow(/must be owner/);
    await expect(sql`ALTER TABLE organizations NO FORCE ROW LEVEL SECURITY`.execute(appDb)).rejects.toThrow(/must be owner/);
    await expect(sql`DROP POLICY organizations_tenant ON organizations`.execute(appDb)).rejects.toThrow(/must be owner/);
    // row_security = off 对受策略约束的角色不是“绕过”，而是让查询直接报错。
    await expect(
      appDb.transaction().execute(async (trx) => {
        await sql`SET LOCAL row_security = off`.execute(trx);
        await trx.selectFrom('organizations').selectAll().execute();
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('不能在 public 中建表（绕开迁移新建无 RLS 的表）', async () => {
    await expect(sql`CREATE TABLE sneaky (id int)`.execute(appDb)).rejects.toThrow(/permission denied/);
  });
});

describe('未设置组织上下文', () => {
  it.each(TABLES)('%s 查询返回 0 行', async (table) => {
    expect(await countRows(appDb, table)).toBe(0);
  });

  it('按主键直接查询也查不到', async () => {
    expect(await appDb.selectFrom('organizations').selectAll().where('id', '=', orgA).execute()).toEqual([]);
    expect(await appDb.selectFrom('users').selectAll().where('email', '=', 'a@example.com').execute()).toEqual([]);
  });

  it('更新和删除不影响任何行，插入被拒绝', async () => {
    const updated = await appDb.updateTable('organizations').set({ name: 'x' }).executeTakeFirst();
    expect(updated.numUpdatedRows).toBe(0n);
    const deleted = await appDb.deleteFrom('org_memberships').executeTakeFirst();
    expect(deleted.numDeletedRows).toBe(0n);
    await expect(
      appDb.insertInto('organizations').values({ name: 'x', kind: 'personal' }).execute(),
    ).rejects.toThrow(/row-level security/);
  });

  it('表属主（迁移角色）同样受 RLS 约束', async () => {
    const owner = connect<Database>(testDb.ownerConfig);
    try {
      for (const table of TABLES) expect(await countRows(owner, table), table).toBe(0);
    } finally {
      await owner.destroy();
    }
  });
});

describe('组织间隔离', () => {
  it('组织 A 的上下文只看到组织 A 的数据', async () => {
    await withTenant(appDb, ctxA, async (trx) => {
      expect(await trx.selectFrom('organizations').select('id').execute()).toEqual([{ id: orgA }]);
      expect(await trx.selectFrom('users').select('id').execute()).toEqual([{ id: userA }]);
      expect(await trx.selectFrom('org_memberships').select(['org_id', 'user_id']).execute()).toEqual([
        { org_id: orgA, user_id: userA },
      ]);
      expect(await trx.selectFrom('sessions').select('org_id').execute()).toEqual([{ org_id: orgA }]);
      expect(await trx.selectFrom('auth_tokens').select('user_id').execute()).toEqual([{ user_id: userA }]);
    });
  });

  it('组织 A 按 ID 查不到组织 B 的数据', async () => {
    await withTenant(appDb, ctxA, async (trx) => {
      expect(await trx.selectFrom('organizations').selectAll().where('id', '=', orgB).execute()).toEqual([]);
      expect(await trx.selectFrom('users').selectAll().where('id', '=', userB).execute()).toEqual([]);
      expect(await trx.selectFrom('org_memberships').selectAll().where('org_id', '=', orgB).execute()).toEqual([]);
      expect(await trx.selectFrom('sessions').selectAll().where('user_id', '=', userB).execute()).toEqual([]);
      expect(await trx.selectFrom('auth_tokens').selectAll().where('user_id', '=', userB).execute()).toEqual([]);
    });
  });

  it('组织 A 不能修改或删除组织 B 的数据', async () => {
    await withTenant(appDb, ctxA, async (trx) => {
      const renamed = await trx.updateTable('organizations').set({ name: '篡改' }).where('id', '=', orgB).executeTakeFirst();
      expect(renamed.numUpdatedRows).toBe(0n);
      const changed = await trx.updateTable('users').set({ password_hash: 'x' }).where('id', '=', userB).executeTakeFirst();
      expect(changed.numUpdatedRows).toBe(0n);
      const removed = await trx.deleteFrom('org_memberships').where('org_id', '=', orgB).executeTakeFirst();
      expect(removed.numDeletedRows).toBe(0n);
      const revoked = await trx.deleteFrom('sessions').where('user_id', '=', userB).executeTakeFirst();
      expect(revoked.numDeletedRows).toBe(0n);
    });
    const b = await (testDb.admin as Kysely<Database>).selectFrom('organizations').select('name').where('id', '=', orgB).executeTakeFirstOrThrow();
    expect(b.name).toBe('组织 B');
  });

  it.each<[string, (trx: Kysely<Database>) => Promise<unknown>]>([
    ['把自己加入组织 B', (trx: Kysely<Database>) =>
      trx.insertInto('org_memberships').values({ org_id: orgB, user_id: userA, role: 'owner' }).execute()],
    ['把本组织的数据改挂到组织 B', (trx: Kysely<Database>) =>
      trx.updateTable('org_memberships').set({ org_id: orgB }).where('org_id', '=', orgA).execute()],
    ['以组织 B 的用户身份建会话', (trx: Kysely<Database>) =>
      trx.insertInto('sessions').values({ org_id: orgB, user_id: userB, token_hash: tokenHash(), expires_at: inOneDay() }).execute()],
    ['给组织 B 的用户建令牌', (trx: Kysely<Database>) =>
      trx.insertInto('auth_tokens').values({ user_id: userB, kind: 'password_reset', token_hash: tokenHash(), expires_at: inOneDay() }).execute()],
  ])('组织 A 不能写入组织 B：%s', async (_name, write) => {
    await expect(withTenant(appDb, ctxA, (trx) => write(trx))).rejects.toThrow(/row-level security/);
  });

  it('组织 B 的上下文同样只看到组织 B', async () => {
    await withTenant(appDb, ctxB, async (trx) => {
      expect(await trx.selectFrom('organizations').select('id').execute()).toEqual([{ id: orgB }]);
      expect(await trx.selectFrom('users').select('id').execute()).toEqual([{ id: userB }]);
    });
  });

  it('上下文中的 userId 不是当前组织成员时，改不到该用户', async () => {
    // 用户只能修改自己；即便上下文的 userId 被伪造成组织 B 的用户，因不是组织 A 的成员也改不到。
    const forged: TenantContext = { orgId: orgA, userId: userB, role: 'owner' };
    await withTenant(appDb, forged, async (trx) => {
      const result = await trx.updateTable('users').set({ password_hash: 'x' }).where('id', '=', userB).executeTakeFirst();
      expect(result.numUpdatedRows).toBe(0n);
    });
  });
});

describe('TenantContext', () => {
  it('上下文只在事务内有效：连接回到池中后查询返回 0 行而不是报错', async () => {
    const single = connect<Database>(testDb.appConfig, 1);
    try {
      await withTenant(single, ctxA, async (trx) => {
        expect(await countRows(trx, 'organizations')).toBe(1);
      });
      // 同一个物理连接：set_config(..., true) 已随事务结束清除，current_setting 返回空字符串。
      for (const table of TABLES) expect(await countRows(single, table), table).toBe(0);
    } finally {
      await single.destroy();
    }
  });

  it('事务回滚后上下文同样被清除', async () => {
    const single = connect<Database>(testDb.appConfig, 1);
    try {
      await expect(
        withTenant(single, ctxA, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await countRows(single, 'organizations')).toBe(0);
    } finally {
      await single.destroy();
    }
  });

  it.each([
    ['orgId 不是 UUID', { ...ctxA, orgId: "' OR 1=1 --" }],
    ['userId 不是 UUID', { ...ctxA, userId: '' }],
    ['role 不合法', { ...ctxA, role: 'superadmin' as TenantContext['role'] }],
  ])('%s 时拒绝执行', async (_name, context) => {
    let ran = false;
    await expect(
      withTenant(appDb, context, async () => {
        ran = true;
      }),
    ).rejects.toThrow(TypeError);
    expect(ran).toBe(false);
  });

  it('注册流程：在新组织、新用户的上下文中依次建组织、用户、成员关系、会话', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    await withTenant(appDb, { orgId, userId, role: 'owner' }, async (trx) => {
      await trx.insertInto('organizations').values({ id: orgId, name: '新用户的个人组织', kind: 'personal' }).execute();
      await trx.insertInto('users').values({ id: userId, email: 'new@example.com', password_hash: 'x' }).execute();
      await trx.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
      await trx.insertInto('sessions').values({ org_id: orgId, user_id: userId, token_hash: tokenHash(), expires_at: inOneDay() }).execute();
      expect(await trx.selectFrom('users').select('email').execute()).toEqual([{ email: 'new@example.com' }]);
    });
    // 新数据对组织 A 不可见。
    await withTenant(appDb, ctxA, async (trx) => {
      expect(await trx.selectFrom('users').selectAll().where('id', '=', userId).execute()).toEqual([]);
    });
  });
});
