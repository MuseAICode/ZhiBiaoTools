// TenantContext：所有访问业务数据的代码都经 withTenant 拿到事务，不直接使用裸连接
// （docs/SERVER_DESIGN.md 第 2.6 节）。
//
// withTenant 在事务开头用 set_config(..., true) 设置 app.org_id / app.user_id，作用域只在本事务，
// 提交或回滚后自动清除，连接回到池中不会把上一个请求的组织带给下一个请求。
// 数据库层的 RLS 策略据此过滤；未设置时一律返回 0 行。
import { sql, type Kysely, type Transaction } from 'kysely';
import { MEMBER_ROLES, type Database, type MemberRole } from './schema.ts';

export interface TenantContext {
  readonly orgId: string;
  readonly userId: string;
  readonly role: MemberRole;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidContext(context: TenantContext): void {
  if (typeof context.orgId !== 'string' || !UUID_PATTERN.test(context.orgId)) {
    throw new TypeError('TenantContext.orgId 必须是 UUID');
  }
  if (typeof context.userId !== 'string' || !UUID_PATTERN.test(context.userId)) {
    throw new TypeError('TenantContext.userId 必须是 UUID');
  }
  if (!(MEMBER_ROLES as readonly string[]).includes(context.role)) {
    throw new TypeError('TenantContext.role 不合法');
  }
}

export async function withTenant<T>(
  db: Kysely<Database>,
  context: TenantContext,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  assertValidContext(context);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.org_id', ${context.orgId}, true), set_config('app.user_id', ${context.userId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * 只设置 app.org_id、不设置 app.user_id 的事务，只供 worker 的系统操作使用（src/jobs/：认领任务、续租、对账）：
 * 这些操作发生在“某个组织的任务”上，但不代表任何用户。要求 app.user_id 的策略在此一律不成立（失败即关闭）；
 * 执行任务本身的业务读写仍经 withTenant，用任务记录中的用户和该用户当前在组织中的角色。
 */
export async function withOrgContext<T>(
  db: Kysely<Database>,
  orgId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (typeof orgId !== 'string' || !UUID_PATTERN.test(orgId)) throw new TypeError('orgId 必须是 UUID');
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.org_id', ${orgId}, true)`.execute(trx);
    return fn(trx);
  });
}
