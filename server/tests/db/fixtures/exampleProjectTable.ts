// 项目级表的迁移模板（路线图第 5 步 5.1）。5.2 起每个模块新建项目级表时，照这里写迁移，
// 再用 tests/db/projectTable.ts 的 describeProjectTable 给每张新表跑一遍隔离测试。
// 本文件只在测试中执行（tests/db/projects.test.ts），不登记到 src/db/migrations/index.ts。
//
// 约定（docs/SERVER_DESIGN.md 第 2.4 节）：
// - 每张表都有 org_id NOT NULL 和 project_id NOT NULL；即使能从父表推出 org_id 也要冗余，RLS 策略和索引只看本表；
// - 用 (org_id, project_id) 复合外键指向 projects (org_id, id) ON DELETE CASCADE：外键检查不受 RLS 约束，
//   子记录挂不到别的组织的项目上；项目只能软删除，物理删除（清理任务）时子表随之删除；
// - 引用上传的原件同样用复合外键 (org_id, <列>) 指向 files (org_id, id)，不级联：文件的对象要先由清理任务删除；
//   数据库中不出现任何服务器文件系统路径（原 *_path、document_dir 一律改为 files.id 或生成产物 id）；
// - 单行 meta 表（桌面版 id = 1）主键改为 project_id；其他表的主键用 uuid（桌面版已有的文本 UUID 原样保留）
//   或 bigint GENERATED ALWAYS AS IDENTITY；
// - 时间一律 timestamptz（不用 TEXT ISO 字符串），updated_at 由迁移 0007 的触发器函数 app_touch_updated_at() 维护；
//   JSON 一律 jsonb，并用 CHECK 约束顶层类型（jsonb_typeof）；
// - 索引以 org_id, project_id 开头；
// - ENABLE + FORCE ROW LEVEL SECURITY，策略只授予应用角色，USING 与 WITH CHECK 都是 org_id = app_current_org_id()；
//   只授予需要的权限（不需要物理删除的表不授 DELETE，不能改的列用列级 UPDATE 授权）；
// - down 按依赖倒序删除。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../../../src/db/roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

export const EXAMPLE_TABLES = ['example_project_meta', 'example_project_items'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 单行 meta：每个项目一行，主键是 project_id。
    sql`CREATE TABLE example_project_meta (
          project_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          step text NOT NULL DEFAULT 'start' CHECK (char_length(step) <= 64),
          options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT example_project_meta_project_fkey FOREIGN KEY (org_id, project_id)
            REFERENCES projects (org_id, id) ON DELETE CASCADE
        )`,
    sql`CREATE INDEX example_project_meta_org_id_idx ON example_project_meta (org_id, project_id)`,
    sql`CREATE TRIGGER example_project_meta_touch BEFORE UPDATE ON example_project_meta
          FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,

    // 多行子表：引用项目和上传的原件。
    sql`CREATE TABLE example_project_items (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          source_file_id uuid,
          title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
          sort_order integer NOT NULL DEFAULT 0,
          payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT example_project_items_project_fkey FOREIGN KEY (org_id, project_id)
            REFERENCES projects (org_id, id) ON DELETE CASCADE,
          CONSTRAINT example_project_items_source_file_fkey FOREIGN KEY (org_id, source_file_id)
            REFERENCES files (org_id, id)
        )`,
    sql`CREATE INDEX example_project_items_org_id_project_id_idx ON example_project_items (org_id, project_id, sort_order)`,
    sql`CREATE TRIGGER example_project_items_touch BEFORE UPDATE ON example_project_items
          FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,

    ...EXAMPLE_TABLES.flatMap((table) => [
      sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`,
      sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`,
      sql`CREATE POLICY ${sql.id(`${table}_tenant`)} ON ${sql.table(table)} TO ${app}
            USING (org_id = app_current_org_id())
            WITH CHECK (org_id = app_current_org_id())`,
      sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ${sql.table(table)} TO ${app}`,
    ]),
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`DROP TABLE example_project_items`, sql`DROP TABLE example_project_meta`]);
}
