import type { Kysely } from 'kysely';
import { Migrator, NO_MIGRATIONS, type MigrationResultSet } from 'kysely/migration';
import { migrations } from './migrations/index.ts';

export function createMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => ({ ...migrations }) },
  });
}

/** 迁移到最新版本。已执行过的迁移跳过，重复执行是空操作。每个迁移在独立事务中执行，并由咨询锁串行化。 */
export function migrateToLatest(db: Kysely<unknown>): Promise<MigrationResultSet> {
  return createMigrator(db).migrateToLatest();
}

/** 回滚最近一个迁移。 */
export function migrateDown(db: Kysely<unknown>): Promise<MigrationResultSet> {
  return createMigrator(db).migrateDown();
}

/** 回滚全部迁移（只用于测试和重建开发库）。 */
export function migrateDownAll(db: Kysely<unknown>): Promise<MigrationResultSet> {
  return createMigrator(db).migrateTo(NO_MIGRATIONS);
}
