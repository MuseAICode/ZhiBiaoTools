// 迁移命令：node src/db/migrate.ts <latest|down>（编译后为 dist/db/migrate.js）。
// 用表属主角色连接（MIGRATION_DATABASE_USER / MIGRATION_DATABASE_PASSWORD[_FILE]），
// 每个结果输出一行 JSON 到 stdout；失败时输出到 stderr 并以退出码 1 退出。
// latest 成功后再幂等同步系统导出模板（src/templates/system.ts，迁移 0010），每次部署都执行，改预设样式不需要写迁移。
import { Kysely, PostgresDialect } from 'kysely';
import type { MigrationResultSet } from 'kysely/migration';
import { ConfigError, loadMigrationConfig } from '../config.ts';
import { syncSystemTemplates, type SystemTemplateSyncResult } from '../templates/system.ts';
import { createPool } from './database.ts';
import type { Database } from './schema.ts';
import { migrateDown, migrateToLatest } from './migrator.ts';

const COMMANDS = {
  latest: migrateToLatest,
  down: migrateDown,
} as const;

function writeLine(stream: NodeJS.WriteStream, entry: Record<string, unknown>): void {
  stream.write(`${JSON.stringify({ time: Date.now(), ...entry })}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const command = process.argv[2];
if (command !== 'latest' && command !== 'down') {
  writeLine(process.stderr, { level: 'fatal', msg: '用法：migrate <latest|down>' });
  process.exit(1);
}

let config;
try {
  config = loadMigrationConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    writeLine(process.stderr, { level: 'fatal', msg: error.message, issues: error.issues });
    process.exit(1);
  }
  throw error;
}

const db = new Kysely<unknown>({
  dialect: new PostgresDialect({ pool: createPool(config, { maxConnections: 1, applicationName: 'bidtools-migrate' }) }),
});

let resultSet: MigrationResultSet;
let synced: SystemTemplateSyncResult | null = null;
let syncError: unknown;
try {
  resultSet = await COMMANDS[command](db);
  if (command === 'latest' && resultSet.error === undefined) {
    try {
      synced = await syncSystemTemplates(db as Kysely<Database>);
    } catch (error) {
      syncError = error;
    }
  }
} catch (error) {
  resultSet = { error };
} finally {
  await db.destroy();
}

for (const result of resultSet.results ?? []) {
  writeLine(result.status === 'Error' ? process.stderr : process.stdout, {
    level: result.status === 'Error' ? 'error' : 'info',
    msg: 'migration',
    migration: result.migrationName,
    direction: result.direction,
    status: result.status,
  });
}

if (resultSet.error !== undefined) {
  writeLine(process.stderr, { level: 'fatal', msg: 'migration failed', error: errorMessage(resultSet.error) });
  process.exit(1);
}

if ((resultSet.results ?? []).length === 0) {
  writeLine(process.stdout, { level: 'info', msg: command === 'latest' ? 'already up to date' : 'nothing to roll back' });
}

if (syncError !== undefined) {
  writeLine(process.stderr, { level: 'fatal', msg: 'system export template sync failed', error: errorMessage(syncError) });
  process.exit(1);
}
if (synced) writeLine(process.stdout, { level: 'info', msg: 'system export templates synced', ...synced });
