// 项目级表的隔离测试模板（路线图第 5 步 5.1）：每张带 project_id 的表都调用一次 describeProjectTable，
// 证明 RLS 强制生效、未设置上下文时返回 0 行、组织之间读写互相隔离、复合外键挡住跨组织的 project_id。
// 迁移的写法见 tests/db/fixtures/exampleProjectTable.ts。
//
// 每次调用自己建两个组织、各自的用户和项目，数据只经应用角色在各自的上下文中写入，不与调用方的数据混在一起。
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';

/** withTenant 的无类型版本：模板表和以后新增的表不一定在 Database 类型中。 */
export function withTenantAny<T>(db: Kysely<any>, context: TenantContext, fn: (trx: Transaction<any>) => Promise<T>): Promise<T> {
  return withTenant(db as Kysely<Database>, context, fn as (trx: Transaction<Database>) => Promise<T>);
}

export interface ProjectRowScope {
  orgId: string;
  projectId: string;
  userId: string;
}

export interface ProjectTableSpec {
  table: string;
  /** 行的主键列（单行 meta 表是 project_id）。 */
  idColumn: string;
  /** 在当前上下文中插入一行，返回主键值。scope 中的 projectId 可能故意属于别的组织。 */
  insert(trx: Transaction<any>, scope: ProjectRowScope): Promise<string>;
  /** 应用角色有权执行的一个普通更新（不改 org_id / project_id），用来验证跨组织更新影响 0 行。 */
  update: Record<string, unknown>;
  /** 项目被物理删除（清理任务）时：子表随之删除，还是挡住删除（引用对象存储内容的表）。 */
  onProjectDelete: 'cascade' | 'restrict';
  /** project_id 可空（只有 files：不属于项目的文件）。项目级表一律不可空。 */
  projectIdNullable?: boolean;
}

export interface ProjectTableEnv {
  /** 超级用户连接，绕过 RLS，用于建组织和核对结果。 */
  admin(): Kysely<any>;
  /** 应用角色连接。 */
  app(): Kysely<any>;
}

interface Tenant {
  context: TenantContext;
  projectId: string;
  /** 本组织第二个项目，没有任何子记录。 */
  emptyProjectId: string;
}

async function createTenant(admin: Kysely<any>): Promise<Tenant> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await admin.insertInto('organizations').values({ id: orgId, name: `org-${orgId}`, kind: 'personal' }).execute();
  await admin.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await admin.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  const projects = await admin
    .insertInto('projects')
    .values([
      { org_id: orgId, kind: 'technical-plan', name: '项目', created_by: userId },
      { org_id: orgId, kind: 'technical-plan', name: '空项目', created_by: userId },
    ])
    .returning('id')
    .execute();
  return { context: { orgId, userId, role: 'owner' }, projectId: projects[0]!.id, emptyProjectId: projects[1]!.id };
}

function scopeOf(tenant: Tenant, projectId = tenant.projectId): ProjectRowScope {
  return { orgId: tenant.context.orgId, userId: tenant.context.userId, projectId };
}

export function describeProjectTable(spec: ProjectTableSpec, env: ProjectTableEnv): void {
  const { table, idColumn } = spec;

  describe(`项目级表 ${table}`, () => {
    let a: Tenant;
    let b: Tenant;
    let rowA: string;
    let rowB: string;

    const count = async (db: Kysely<any>, orgId?: string) => {
      let query = db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('n'));
      if (orgId) query = query.where('org_id', '=', orgId);
      return Number((await query.executeTakeFirstOrThrow()).n);
    };

    beforeAll(async () => {
      a = await createTenant(env.admin());
      b = await createTenant(env.admin());
      rowA = await withTenantAny(env.app(), a.context, (trx) => spec.insert(trx, scopeOf(a)));
      rowB = await withTenantAny(env.app(), b.context, (trx) => spec.insert(trx, scopeOf(b)));
    });

    it('启用并强制 RLS，策略只授予应用角色', async () => {
      const result = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean; roles: string[] }>`
        SELECT c.relrowsecurity, c.relforcerowsecurity,
               array(SELECT DISTINCT pg_get_userbyid(r)::text FROM pg_policy p, unnest(p.polroles) r WHERE p.polrelid = c.oid) AS roles
        FROM pg_class c WHERE c.oid = ${table}::regclass`.execute(env.admin());
      expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, roles: [APP_ROLE] }]);
    });

    it(spec.projectIdNullable ? 'org_id 不可空，project_id 可空' : '有 org_id、project_id 两列且都不可空', async () => {
      const result = await sql<{ attname: string; attnotnull: boolean }>`
        SELECT attname, attnotnull FROM pg_attribute
        WHERE attrelid = ${table}::regclass AND attname IN ('org_id', 'project_id') ORDER BY attname`.execute(env.admin());
      expect(result.rows).toEqual([
        { attname: 'org_id', attnotnull: true },
        { attname: 'project_id', attnotnull: !spec.projectIdNullable },
      ]);
    });

    it('未设置上下文：查询返回 0 行，更新、删除影响 0 行，插入被拒绝', async () => {
      expect(await count(env.admin(), a.context.orgId)).toBe(1);
      expect(await count(env.app())).toBe(0);
      expect(await env.app().selectFrom(table).selectAll().where(idColumn, '=', rowA).execute()).toEqual([]);
      const updated = await env.app().updateTable(table).set(spec.update).executeTakeFirst();
      expect(updated.numUpdatedRows).toBe(0n);
      const deleted = await env.app().deleteFrom(table).executeTakeFirst().catch((error: unknown) => error);
      // 不授予 DELETE 的表直接报权限错误，同样删不到任何行。
      if (deleted instanceof Error) expect(deleted.message).toMatch(/permission denied/);
      else expect((deleted as { numDeletedRows: bigint }).numDeletedRows).toBe(0n);
      await expect(
        env.app().transaction().execute((trx) => spec.insert(trx, scopeOf(a, a.emptyProjectId))),
      ).rejects.toThrow(/row-level security|permission denied/);
      expect(await count(env.admin(), a.context.orgId)).toBe(1);
    });

    it('组织 A 只看到自己的行，按主键查不到组织 B 的行', async () => {
      await withTenantAny(env.app(), a.context, async (trx) => {
        expect(await trx.selectFrom(table).select(idColumn).execute()).toEqual([{ [idColumn]: rowA }]);
        expect(await trx.selectFrom(table).selectAll().where(idColumn, '=', rowB).execute()).toEqual([]);
      });
    });

    it('组织 A 改不到、删不到组织 B 的行', async () => {
      await withTenantAny(env.app(), a.context, async (trx) => {
        const updated = await trx.updateTable(table).set(spec.update).where(idColumn, '=', rowB).executeTakeFirst();
        expect(updated.numUpdatedRows).toBe(0n);
      });
      const deleted = await withTenantAny(env.app(), a.context, (trx) =>
        trx.deleteFrom(table).where(idColumn, '=', rowB).executeTakeFirst(),
      ).catch((error: unknown) => error);
      if (deleted instanceof Error) expect(deleted.message).toMatch(/permission denied/);
      else expect((deleted as { numDeletedRows: bigint }).numDeletedRows).toBe(0n);
      expect(await count(env.admin(), b.context.orgId)).toBe(1);
    });

    it('组织 A 不能以组织 B 的 org_id 写入', async () => {
      await expect(
        withTenantAny(env.app(), a.context, (trx) => spec.insert(trx, { ...scopeOf(b, b.emptyProjectId), userId: a.context.userId })),
      ).rejects.toThrow(/row-level security/);
    });

    it('复合外键：组织 A 不能把行挂到组织 B 的项目上（插入和改挂都拒绝）', async () => {
      await expect(
        withTenantAny(env.app(), a.context, (trx) => spec.insert(trx, scopeOf(a, b.emptyProjectId))),
      ).rejects.toThrow(/foreign key constraint/);
      await expect(
        withTenantAny(env.app(), a.context, (trx) =>
          trx.updateTable(table).set({ project_id: b.emptyProjectId }).where(idColumn, '=', rowA).execute(),
        ),
      ).rejects.toThrow(/foreign key constraint|permission denied/);
      const rows = await env.admin().selectFrom(table).select(['org_id', 'project_id']).where('org_id', '=', a.context.orgId).execute();
      expect(rows).toEqual([{ org_id: a.context.orgId, project_id: a.projectId }]);
    });

    it('不能把行改到组织 B（改 org_id 被 RLS 拒绝）', async () => {
      await expect(
        withTenantAny(env.app(), a.context, (trx) =>
          trx.updateTable(table).set({ org_id: b.context.orgId }).where(idColumn, '=', rowA).execute(),
        ),
      ).rejects.toThrow(/row-level security|permission denied/);
    });

    if (spec.onProjectDelete === 'cascade') {
      it('项目被物理删除时，子表的行随之删除', async () => {
        await env.admin().deleteFrom('projects').where('id', '=', b.projectId).execute();
        expect(await count(env.admin(), b.context.orgId)).toBe(0);
        expect(await count(env.admin(), a.context.orgId)).toBe(1);
      });
    } else {
      it('项目还有子记录时不能物理删除（先由清理任务处理子记录）', async () => {
        await expect(env.admin().deleteFrom('projects').where('id', '=', b.projectId).execute()).rejects.toThrow(/foreign key constraint/);
        expect(await count(env.admin(), b.context.orgId)).toBe(1);
      });
    }
  });
}
