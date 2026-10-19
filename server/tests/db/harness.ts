// 数据库集成测试的环境：每个测试文件新建一个独立的库，结束时删除。
// 需要 TEST_DATABASE_ADMIN_URL 指向一个超级用户连接（CI 中是 PostgreSQL 服务容器，见 .github/workflows/ci.yml）。
// 角色的创建方式与开发环境 server/db/init/10-provision.sh 一致，修改时两边同步。
import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DatabaseConfig } from '../../src/config.ts';
import { APP_ROLE, AUTH_ROLE, BILLING_ROLE, OWNER_ROLE } from '../../src/db/roles.ts';

export interface TestDatabase {
  readonly name: string;
  /** 迁移角色（表属主）。 */
  readonly ownerConfig: DatabaseConfig;
  /** 应用角色。 */
  readonly appConfig: DatabaseConfig;
  /** 超级用户连接到测试库，用于准备数据和检查系统目录，绕过 RLS。 */
  readonly admin: Kysely<any>;
  drop(): Promise<void>;
}

function adminUrl(): URL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL;
  if (!raw) {
    throw new Error('数据库集成测试需要 TEST_DATABASE_ADMIN_URL（超级用户连接串），例如 postgres://postgres:postgres@127.0.0.1:5432/postgres');
  }
  return new URL(raw);
}

function poolFor(url: URL, database: string): pg.Pool {
  return new pg.Pool({
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    max: 2,
  });
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensureRole(client: pg.Pool, role: string, password: string): Promise<void> {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const verb = exists.rowCount ? 'ALTER' : 'CREATE';
  await client.query(
    `${verb} ROLE ${quoteIdent(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${quoteLiteral(password)}`,
  );
}

/**
 * SECURITY DEFINER 函数的属主（登录前查询 bidtools_auth、计费 bidtools_billing）：不能登录；
 * 迁移角色可以 SET ROLE 成它（不继承它的权限），用于在迁移中建删函数。
 */
async function ensureFunctionOwnerRole(client: pg.Pool, role: string): Promise<void> {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const verb = exists.rowCount ? 'ALTER' : 'CREATE';
  await client.query(
    `${verb} ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
  );
  await client.query(`GRANT ${quoteIdent(role)} TO ${quoteIdent(OWNER_ROLE)} WITH INHERIT FALSE, SET TRUE`);
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const url = adminUrl();
  const name = `bidtools_test_${randomBytes(6).toString('hex')}`;
  const ownerPassword = randomBytes(18).toString('hex');
  const appPassword = randomBytes(18).toString('hex');

  const maintenance = poolFor(url, decodeURIComponent(url.pathname.slice(1)) || 'postgres');
  try {
    await ensureRole(maintenance, OWNER_ROLE, ownerPassword);
    await ensureRole(maintenance, APP_ROLE, appPassword);
    await ensureFunctionOwnerRole(maintenance, AUTH_ROLE);
    await ensureFunctionOwnerRole(maintenance, BILLING_ROLE);
    await maintenance.query(`CREATE DATABASE ${quoteIdent(name)} OWNER ${quoteIdent(OWNER_ROLE)}`);
    await maintenance.query(`REVOKE ALL ON DATABASE ${quoteIdent(name)} FROM PUBLIC`);
    await maintenance.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${quoteIdent(name)} TO ${quoteIdent(APP_ROLE)}`);
  } finally {
    await maintenance.end();
  }

  const adminPool = poolFor(url, name);
  await adminPool.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(APP_ROLE)}`);
  const admin = new Kysely<any>({ dialect: new PostgresDialect({ pool: adminPool }) });

  const base = { host: url.hostname, port: Number(url.port || 5432), name };
  return {
    name,
    ownerConfig: Object.freeze({ ...base, user: OWNER_ROLE, password: ownerPassword }),
    appConfig: Object.freeze({ ...base, user: APP_ROLE, password: appPassword }),
    admin,
    async drop() {
      await admin.destroy();
      if (!adminPool.ended) await adminPool.end();
      const pool = poolFor(url, decodeURIComponent(url.pathname.slice(1)) || 'postgres');
      try {
        await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
      } finally {
        await pool.end();
      }
    },
  };
}

/** 用指定角色连接测试库的 Kysely 实例。 */
export function connect<T = any>(config: DatabaseConfig, maxConnections = 2): Kysely<T> {
  return new Kysely<T>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        host: config.host,
        port: config.port,
        database: config.name,
        user: config.user,
        password: config.password,
        max: maxConnections,
      }),
    }),
  });
}
