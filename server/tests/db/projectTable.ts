// 项目级表的隔离测试模板（路线图第 5 步 5.1）：每张带 project_id 的表都调用一次 describeProjectTable，
// 证明 RLS 强制生效、未设置上下文时返回 0 行、组织之间读写互相隔离、复合外键挡住跨组织的 project_id。
// 迁移的写法见 tests/db/fixtures/exampleProjectTable.ts。
//
// 5.3 起组织级表（没有 project_id，如 org_settings）同样调用本模板，声明 scope: 'org'：跳过与项目有关的用例，
// 改为检查表中没有 project_id 列。只属于某个成员的行（如 user_settings）另声明 userColumn：模板再检查同组织的
// 其他成员看不到、改不到、不能代写，以及成员关系删除后行随之删除。
//
// 5.4 起组织级表中另有 org_id 为空、所有组织只读的系统行时（如系统导出模板），声明 systemRows：模板改为检查
// org_id 可空，并检查系统行两个组织都能读、未设置上下文时读不到、应用角色改不到删不到也不能新写或改出系统行，
// 以及维护系统行的角色（迁移角色）只看得到、只改得到系统行。
//
// 5.7 起只整体替换、不授予 UPDATE 的表（如知识库的切块、条目）省略 update：模板改为检查应用角色对该表没有任何
// UPDATE 权限，原来“更新影响 0 行”的用例一律改为更新被拒绝。
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
  /**
   * 应用角色有权执行的一个普通更新（不改 org_id / project_id），用来验证跨组织更新影响 0 行。
   * 不授予 UPDATE 的表省略，模板改为检查应用角色没有 UPDATE 权限、任何更新都被拒绝。
   */
  update?: Record<string, unknown>;
  /** 项目被物理删除（清理任务）时：子表随之删除，还是挡住删除（引用对象存储内容的表）。项目级表必填，组织级表不填。 */
  onProjectDelete?: 'cascade' | 'restrict';
  /** project_id 可空（只有 files：不属于项目的文件）。项目级表一律不可空。 */
  projectIdNullable?: boolean;
  /** 'org'：组织级表，没有 project_id，insert 忽略 scope.projectId。默认 'project'。 */
  scope?: 'project' | 'org';
  /**
   * 行只属于一个成员时的用户列（如 user_settings.user_id）：insert 按 scope.userId 写入该列，
   * 并由复合外键 (org_id, <列>) → org_memberships 级联删除。
   */
  userColumn?: string;
  /**
   * 除应用角色外另有策略的 SECURITY DEFINER 函数属主（例如配额函数的 bidtools_storage）。
   * 必须显式列出；模板另外检查这些角色不能登录、没有 BYPASSRLS，且对本表只有 SELECT 策略。
   */
  definerRoles?: readonly string[];
  /** org_id 为空、所有组织只读的系统行。只用于组织级表。 */
  systemRows?: SystemRowsSpec;
}

export interface SystemRowsSpec {
  /** 用超级用户写入一行系统行，返回主键值。 */
  insert(admin: Kysely<any>): Promise<string>;
  /** 维护系统行的角色（有策略但不是函数属主，可以登录，例如迁移角色）。 */
  writerRole: string;
  /** 以 writerRole 登录的连接。 */
  writer(): Kysely<any>;
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

/** 在已有组织中加一个普通成员。 */
async function addMember(admin: Kysely<any>, orgId: string): Promise<TenantContext> {
  const userId = randomUUID();
  await admin.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await admin.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'member' }).execute();
  return { orgId, userId, role: 'member' };
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
  const orgScoped = spec.scope === 'org';
  if (orgScoped === (spec.onProjectDelete !== undefined)) throw new TypeError(`${table}：onProjectDelete 项目级表必填，组织级表不填`);
  if (spec.systemRows && !orgScoped) throw new TypeError(`${table}：systemRows 只用于组织级表`);
  const systemRows = spec.systemRows;
  const policyRoles = [APP_ROLE, ...(spec.definerRoles ?? []), ...(systemRows ? [systemRows.writerRole] : [])].sort();

  describe(`${orgScoped ? '组织级表' : '项目级表'} ${table}`, () => {
    let a: Tenant;
    let b: Tenant;
    let rowA: string;
    let rowB: string;
    let systemRow: string;

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
      if (systemRows) systemRow = await systemRows.insert(env.admin());
    });

    /**
     * 执行 spec.update，断言影响 0 行；不授予 UPDATE 的表（省略 update）断言被拒绝（改不到任何行）。
     * where 给出时只更新匹配的行。
     */
    const expectNoRowUpdated = async (db: Kysely<any>, where?: (query: any) => any) => {
      const values = spec.update ?? { [idColumn]: sql.ref(idColumn) };
      let query = db.updateTable(table).set(values);
      if (where) query = where(query);
      const result = await query.executeTakeFirst().catch((error: unknown) => error);
      if (spec.update) {
        expect((result as { numUpdatedRows: bigint }).numUpdatedRows).toBe(0n);
      } else {
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toMatch(/permission denied/);
      }
    };

    /** 组织的行（系统行除外）。 */
    const orgRows = <T extends { where: (...args: any[]) => any }>(query: T): T => (systemRows ? query.where('org_id', 'is not', null) : query);

    it(policyRoles.length > 1 ? '启用并强制 RLS，策略只授予应用角色和声明的角色' : '启用并强制 RLS，策略只授予应用角色', async () => {
      const result = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean; roles: string[] }>`
        SELECT c.relrowsecurity, c.relforcerowsecurity,
               array(SELECT DISTINCT pg_get_userbyid(r)::text FROM pg_policy p, unnest(p.polroles) r WHERE p.polrelid = c.oid ORDER BY 1) AS roles
        FROM pg_class c WHERE c.oid = ${table}::regclass`.execute(env.admin());
      expect(result.rows).toEqual([
        { relrowsecurity: true, relforcerowsecurity: true, roles: policyRoles },
      ]);
      if (!spec.update) {
        const privilege = await sql<{ table: boolean; columns: boolean }>`
          SELECT has_table_privilege(${APP_ROLE}, ${table}::regclass, 'UPDATE') AS table,
                 has_any_column_privilege(${APP_ROLE}, ${table}::regclass, 'UPDATE') AS columns`.execute(env.admin());
        expect(privilege.rows).toEqual([{ table: false, columns: false }]);
      }
      for (const role of spec.definerRoles ?? []) {
        const attributes = await sql<{ rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean }>`
          SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = ${role}`.execute(env.admin());
        expect(attributes.rows, role).toEqual([{ rolcanlogin: false, rolbypassrls: false, rolsuper: false }]);
        const commands = await sql<{ polcmd: string }>`
          SELECT DISTINCT p.polcmd FROM pg_policy p WHERE p.polrelid = ${table}::regclass AND ${role}::regrole = ANY (p.polroles)`.execute(env.admin());
        expect(commands.rows, role).toEqual([{ polcmd: 'r' }]);
      }
    });

    const columnsTitle = orgScoped
      ? systemRows
        ? 'org_id 可空（系统行），没有 project_id 列'
        : 'org_id 不可空，没有 project_id 列'
      : spec.projectIdNullable
        ? 'org_id 不可空，project_id 可空'
        : '有 org_id、project_id 两列且都不可空';
    it(columnsTitle, async () => {
      const result = await sql<{ attname: string; attnotnull: boolean }>`
        SELECT attname, attnotnull FROM pg_attribute
        WHERE attrelid = ${table}::regclass AND attname IN ('org_id', 'project_id') AND NOT attisdropped ORDER BY attname`.execute(env.admin());
      expect(result.rows).toEqual([
        { attname: 'org_id', attnotnull: !systemRows },
        ...(orgScoped ? [] : [{ attname: 'project_id', attnotnull: !spec.projectIdNullable }]),
      ]);
    });

    it('未设置上下文：查询返回 0 行，更新、删除影响 0 行，插入被拒绝', async () => {
      expect(await count(env.admin(), a.context.orgId)).toBe(1);
      expect(await count(env.app())).toBe(0);
      expect(await env.app().selectFrom(table).selectAll().where(idColumn, '=', rowA).execute()).toEqual([]);
      await expectNoRowUpdated(env.app());
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
        expect(await orgRows(trx.selectFrom(table).select(idColumn)).execute()).toEqual([{ [idColumn]: rowA }]);
        expect(await trx.selectFrom(table).selectAll().where(idColumn, '=', rowB).execute()).toEqual([]);
      });
    });

    it('组织 A 改不到、删不到组织 B 的行', async () => {
      await withTenantAny(env.app(), a.context, (trx) => expectNoRowUpdated(trx, (query) => query.where(idColumn, '=', rowB)));
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

    if (spec.userColumn) {
      const userColumn = spec.userColumn;
      let peer: TenantContext;

      beforeAll(async () => {
        peer = await addMember(env.admin(), a.context.orgId);
      });

      it('同组织的其他成员看不到、改不到该行，也不能以该成员的身份写入', async () => {
        await withTenantAny(env.app(), peer, async (trx) => {
          expect(await trx.selectFrom(table).selectAll().execute()).toEqual([]);
        });
        await withTenantAny(env.app(), peer, (trx) => expectNoRowUpdated(trx, (query) => query.where(userColumn, '=', a.context.userId)));
        await expect(
          withTenantAny(env.app(), peer, (trx) => spec.insert(trx, scopeOf(a))),
        ).rejects.toThrow(/row-level security/);
        await expect(
          withTenantAny(env.app(), peer, (trx) => trx.updateTable(table).set({ [userColumn]: peer.userId }).where(userColumn, '=', a.context.userId).execute()),
        ).rejects.toThrow(/permission denied/);
        const rows = await env.admin().selectFrom(table).select(userColumn).where('org_id', '=', a.context.orgId).execute();
        expect(rows).toEqual([{ [userColumn]: a.context.userId }]);
      });
    }

    it('不能把行改到组织 B（改 org_id 被 RLS 拒绝）', async () => {
      await expect(
        withTenantAny(env.app(), a.context, (trx) =>
          trx.updateTable(table).set({ org_id: b.context.orgId }).where(idColumn, '=', rowA).execute(),
        ),
      ).rejects.toThrow(/row-level security|permission denied/);
    });

    if (systemRows) {
      it('系统行：两个组织都能读到，未设置上下文时读不到', async () => {
        for (const tenant of [a, b]) {
          await withTenantAny(env.app(), tenant.context, async (trx) => {
            expect(await trx.selectFrom(table).select(['org_id', idColumn]).where(idColumn, '=', systemRow).execute()).toEqual([
              { org_id: null, [idColumn]: systemRow },
            ]);
          });
        }
        expect(await env.app().selectFrom(table).selectAll().where(idColumn, '=', systemRow).execute()).toEqual([]);
      });

      it('系统行：应用角色改不到、删不到，不能新写系统行，也不能把本组织的行改成系统行', async () => {
        const before = await env.admin().selectFrom(table).selectAll().where(idColumn, '=', systemRow).executeTakeFirstOrThrow();
        await withTenantAny(env.app(), a.context, (trx) => expectNoRowUpdated(trx, (query) => query.where(idColumn, '=', systemRow)));
        const deleted = await withTenantAny(env.app(), a.context, (trx) =>
          trx.deleteFrom(table).where(idColumn, '=', systemRow).executeTakeFirst(),
        ).catch((error: unknown) => error);
        if (deleted instanceof Error) expect(deleted.message).toMatch(/permission denied/);
        else expect((deleted as { numDeletedRows: bigint }).numDeletedRows).toBe(0n);
        await expect(
          withTenantAny(env.app(), a.context, (trx) => spec.insert(trx, { ...scopeOf(a), orgId: null as unknown as string })),
        ).rejects.toThrow(/row-level security/);
        await expect(
          withTenantAny(env.app(), a.context, (trx) => trx.updateTable(table).set({ org_id: null }).where(idColumn, '=', rowA).execute()),
        ).rejects.toThrow(/row-level security|permission denied/);
        expect(await env.admin().selectFrom(table).selectAll().where(idColumn, '=', systemRow).executeTakeFirstOrThrow()).toEqual(before);
        expect(await count(env.admin(), a.context.orgId)).toBe(1);
      });

      it('维护系统行的角色只看得到、只改得到系统行', async () => {
        const writer = systemRows.writer();
        const visible = await writer.selectFrom(table).select(['org_id']).execute();
        expect(visible.length).toBeGreaterThan(0);
        expect(visible.every((row: { org_id: string | null }) => row.org_id === null)).toBe(true);
        await expectNoRowUpdated(writer, (query) => query.where(idColumn, 'in', [rowA, rowB]));
        const deleted = await writer.deleteFrom(table).where(idColumn, 'in', [rowA, rowB]).executeTakeFirst();
        expect(deleted.numDeletedRows).toBe(0n);
        await expect(
          writer.updateTable(table).set({ org_id: a.context.orgId }).where(idColumn, '=', systemRow).execute(),
        ).rejects.toThrow(/row-level security/);
        expect(await count(env.admin(), a.context.orgId)).toBe(1);
        expect(await count(env.admin(), b.context.orgId)).toBe(1);
      });
    }

    if (orgScoped) {
      if (spec.userColumn) {
        const userColumn = spec.userColumn;
        it('成员关系删除（移出组织）后，该成员的行随之删除', async () => {
          await env.admin().deleteFrom('org_memberships').where('org_id', '=', b.context.orgId).where('user_id', '=', b.context.userId).execute();
          expect(await env.admin().selectFrom(table).select(userColumn).where('org_id', '=', b.context.orgId).execute()).toEqual([]);
          expect(await count(env.admin(), a.context.orgId)).toBe(1);
        });
      }
    } else {
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
    }
  });
}
