// 文件归属项目后不能再改（路线图第 5 步 5.8 的后续）：files.project_id 只能从空设为某个项目，设置后不能改成别的项目，
// 也不能改回空。
//
// 用触发器而不是改 RLS 策略：UPDATE 策略的 WITH CHECK 只能看到新行，看不到旧值，表达不了“设置后不能再改”；
// 收回 project_id 的列级 UPDATE 授权又会挡住“从空设为项目”（标书查重等模块挂文件就靠它）。触发器能比较新旧值，
// 而且对所有角色生效（包括表属主和以后的清理任务），不依赖应用代码。已有的 files 策略与 files_guard 都不改动。
import { sql, type Kysely, type RawBuilder } from 'kysely';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE FUNCTION files_project_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.project_id IS NOT NULL AND NEW.project_id IS DISTINCT FROM OLD.project_id THEN
              RAISE EXCEPTION 'file project is immutable once set' USING ERRCODE = 'FS005';
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION files_project_guard() FROM PUBLIC`,
    sql`CREATE TRIGGER files_project_guard BEFORE UPDATE OF project_id ON files
          FOR EACH ROW EXECUTE FUNCTION files_project_guard()`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`DROP TRIGGER files_project_guard ON files`, sql`DROP FUNCTION files_project_guard()`]);
}
