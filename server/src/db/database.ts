// PostgreSQL 连接池与 Kysely 实例。连接参数来自 src/config.ts，密码不写日志。
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DatabaseConfig } from '../config.ts';
import type { Database } from './schema.ts';

export interface DatabaseHandle {
  readonly db: Kysely<Database>;
  /** 执行 SELECT 1，超时或连接失败时抛错。用于 /readyz。 */
  ping(timeoutMs?: number): Promise<void>;
  destroy(): Promise<void>;
}

export interface CreateDatabaseOptions {
  /** 连接池上限，默认 10。 */
  maxConnections?: number;
  applicationName?: string;
  /** 空闲连接出错（如数据库重启）时回调，用于写日志。 */
  onIdleError?: (error: Error) => void;
}

const DEFAULT_PING_TIMEOUT_MS = 2_000;

export function createPool(config: DatabaseConfig, options: CreateDatabaseOptions = {}): pg.Pool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName ?? 'bidtools-api',
  });
}

export function createDatabase(config: DatabaseConfig, options: CreateDatabaseOptions = {}): DatabaseHandle {
  const pool = createPool(config, options);
  // 空闲连接出错时 pg 会在池上触发 error 事件，不监听会让进程崩溃。
  // 坏连接已被移出池，下次查询会重新建连，这里只需记录。
  pool.on('error', (error) => options.onIdleError?.(error));
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  return {
    db,
    async ping(timeoutMs = DEFAULT_PING_TIMEOUT_MS) {
      // 建连阶段不受 query_timeout 约束，所以整体再套一层超时。
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`database ping timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      try {
        await Promise.race([pool.query({ text: 'SELECT 1', query_timeout: timeoutMs } as pg.QueryConfig), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async destroy() {
      // Kysely 只在执行过查询后才接管连接池；只调用过 ping 时池需要单独关闭。
      await db.destroy();
      if (!pool.ended) await pool.end();
    },
  };
}
