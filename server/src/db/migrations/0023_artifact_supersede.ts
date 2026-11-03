// 重新解析时替换旧产物（路线图第 6 步 6.6，第 5 步 #8 留下的“产物没有单独的删除接口”）。
//
// 解析任务写完新的 Markdown 和图片、改好文档的引用后，把同一来源文件之前的产物标为“已被替换”（superseded_at），
// 不在应用中删除：对象存储中的内容和行由 6.8 的清理任务删除（先删对象、再删行）。
// - artifacts.superseded_at：只能由空设为当前时间（触发器写入 now()，调用方不能指定时间），之后不能再改；
//   只有 ready 的产物能被替换（CHECK）；应用角色只多了这一列的 UPDATE 授权，其他列仍不可改（AR003）；
// - 已被替换的产物在清理之前仍计入组织存储配额（内容仍占用存储），配额函数不变；
// - 读取时（src/artifacts/store.ts 的 findArtifact、listArtifacts）不返回已被替换的产物；RLS 策略不变。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { ORG_STORAGE_QUOTA_BYTES } from './0006_files.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);
const QUOTA = sql.lit(ORG_STORAGE_QUOTA_BYTES.toString());

/** 0008 的守卫（down 时恢复）。 */
const ARTIFACTS_GUARD_0008 = sql`CREATE OR REPLACE FUNCTION artifacts_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.status = 'ready' THEN
              RAISE EXCEPTION 'ready artifact is immutable' USING ERRCODE = 'AR003';
            END IF;
            IF NEW.status = 'ready' THEN
              -- 与 files_guard 同一个锁：同一组织的上传完成和产物完成串行，持锁到事务结束。
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('files_quota:' || NEW.org_id::text, 0));
              IF public.files_org_usage_bytes(NEW.org_id) + NEW.size_bytes > ${QUOTA}::bigint THEN
                RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'AR001';
              END IF;
              NEW.completed_at := now();
            END IF;
            RETURN NEW;
          END
          $$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE artifacts ADD COLUMN superseded_at timestamptz`,
    sql`ALTER TABLE artifacts ADD CONSTRAINT artifacts_superseded_ready CHECK (superseded_at IS NULL OR status = 'ready')`,
    // 6.8 的清理任务按组织找出已被替换的产物。
    sql`CREATE INDEX artifacts_org_id_superseded_at_idx ON artifacts (org_id, superseded_at) WHERE superseded_at IS NOT NULL`,
    sql`CREATE OR REPLACE FUNCTION artifacts_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF OLD.status = 'ready' THEN
              -- 已完成的产物只允许标为已被替换一次（时间由这里写入），其他列一律不能改。
              IF OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
                 AND NEW.status = OLD.status
                 AND NEW.size_bytes IS NOT DISTINCT FROM OLD.size_bytes
                 AND NEW.sha256 IS NOT DISTINCT FROM OLD.sha256 THEN
                NEW.superseded_at := now();
                RETURN NEW;
              END IF;
              RAISE EXCEPTION 'ready artifact is immutable' USING ERRCODE = 'AR003';
            END IF;
            IF NEW.superseded_at IS NOT NULL THEN
              RAISE EXCEPTION 'only ready artifacts can be superseded' USING ERRCODE = 'AR003';
            END IF;
            IF NEW.status = 'ready' THEN
              -- 与 files_guard 同一个锁：同一组织的上传完成和产物完成串行，持锁到事务结束。
              PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('files_quota:' || NEW.org_id::text, 0));
              IF public.files_org_usage_bytes(NEW.org_id) + NEW.size_bytes > ${QUOTA}::bigint THEN
                RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'AR001';
              END IF;
              NEW.completed_at := now();
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`GRANT UPDATE (superseded_at) ON artifacts TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`REVOKE UPDATE (superseded_at) ON artifacts FROM ${app}`,
    ARTIFACTS_GUARD_0008,
    sql`DROP INDEX artifacts_org_id_superseded_at_idx`,
    sql`ALTER TABLE artifacts DROP CONSTRAINT artifacts_superseded_ready`,
    sql`ALTER TABLE artifacts DROP COLUMN superseded_at`,
  ]);
}
