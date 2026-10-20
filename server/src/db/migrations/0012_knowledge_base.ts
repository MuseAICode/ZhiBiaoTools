// 知识库（一）（docs/SERVER_DESIGN.md 第 2.5 节；路线图第 5 步 5.6）：取代桌面版 SQLite 的 knowledge_folders、
// knowledge_documents、knowledge_document_steps。知识库是组织级的“跨项目复用的素材”，组织内成员都可以查看和编辑
// （组织内共享，第 9 节第 2 项）。切块、条目、匹配结果等其余七张表随 5.7。
//
// - knowledge_folders：文件夹，组织内按 sort_order 排序；
// - knowledge_documents：文件夹中的文档。原件是上传用途为 knowledge 的文件（files），本表只记 file_id，取代桌面版的
//   document_dir / source_path；解析出的 Markdown 是生成产物（artifacts），记 markdown_artifact_id，取代 markdown_path。
//   文件名取 files.display_name，不再单独存；状态、进度、计数等由第 6 步的解析任务写入；
// - knowledge_document_steps：文档准备的分步结果（断点续跑），随文档可见。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行，未设置上下文时什么都看不到；created_by / updated_by 必须是当前用户；
//   org_id、created_by、file_id 没有列级 UPDATE 授权，写入后不能改挂；文档的文件夹由复合外键保证属于本组织；
// - 文档只能挂本组织已上传、未删除、不属于任何项目的 knowledge 文件（INSERT 策略，files 自身的策略在子查询中同样生效），
//   每个文件只能挂一次；新文档的状态一律是 pending（status 没有 INSERT 授权）；
// - markdown_artifact_id 只能指向本组织已写完、种类为 markdown、来源文件就是本文档原件的产物（UPDATE 策略）；
// - 删除可见性：文档随原件的生命周期，原件已删除（进入回收站）时文档及其步骤查不到、改不了，恢复文件即一起恢复；
//   应用角色没有文档的 DELETE 授权，删除文档就是软删除原件。原件被清理任务物理删除时文档行随之级联删除；
//   文件夹与桌面版相同物理删除，其中的文档行由外键级联删除（删除前由应用先软删除这些文档的原件）；
// - 每个组织最多 500 个文件夹、10000 个文档（触发器 knowledge_base_guard，KB001）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

export const KNOWLEDGE_FOLDER_NAME_MAX_LENGTH = 200;
/** 每个组织的文件夹数、文档数上限。 */
export const KNOWLEDGE_FOLDERS_PER_ORG_MAX = 500;
export const KNOWLEDGE_DOCUMENTS_PER_ORG_MAX = 10_000;
/** 文档的进度说明、错误信息、解析器标签的字数上限。 */
export const KNOWLEDGE_MESSAGE_MAX = 2000;
export const KNOWLEDGE_ERROR_MAX = 20_000;
export const KNOWLEDGE_PARSER_LABEL_MAX = 200;
/** 步骤结果（jsonb 对象）序列化后的字节数上限。 */
export const KNOWLEDGE_STEP_RESULT_MAX_BYTES = 16 * 1024 * 1024;

/** 文档状态与处理步骤，与桌面版 knowledgeBaseStore.cjs 相同。 */
export const KNOWLEDGE_DOCUMENT_STATUSES = [
  'pending',
  'copying',
  'converting',
  'extracting',
  'ready_for_matching',
  'matching',
  'recovering',
  'analyzing',
  'saving',
  'success',
  'error',
] as const;
export const KNOWLEDGE_STEP_KEYS = [
  'copy_source',
  'convert_markdown',
  'build_blocks',
  'extract_first_items',
  'extract_supplement_items',
  'merge_candidates',
  'match_batches',
  'recover_missing',
  'save_result',
] as const;
export const KNOWLEDGE_STEP_STATUSES = ['idle', 'running', 'success', 'error'] as const;

/** 文档上由解析任务维护的计数列。 */
export const KNOWLEDGE_DOCUMENT_COUNT_COLUMNS = [
  'item_count',
  'block_count',
  'filtered_block_count',
  'candidate_item_count',
  'discarded_block_count',
  'system_discarded_after_retry_count',
] as const;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

const TENANT = sql`org_id = app_current_org_id()`;

// 文档的原件已上传、未删除（files 的策略在子查询中同样生效：只看得到本组织、所属项目未删除的文件）。
const DOCUMENT_FILE_LIVE = sql`EXISTS (
  SELECT 1 FROM files f WHERE f.id = knowledge_documents.file_id AND f.status = 'uploaded' AND f.deleted_at IS NULL)`;
// 新挂的文档另要求文件用途是知识库文档、不属于任何项目（知识库是组织级的）。
const DOCUMENT_FILE_ATTACHABLE = sql`EXISTS (
  SELECT 1 FROM files f WHERE f.id = knowledge_documents.file_id AND f.status = 'uploaded' AND f.deleted_at IS NULL
    AND f.purpose = 'knowledge' AND f.project_id IS NULL)`;
// 解析出的 Markdown 必须是本文档原件的产物（artifacts 的策略在子查询中同样生效：只看得到本组织、来源文件可用的产物）。
const DOCUMENT_MARKDOWN_VALID = sql`(markdown_artifact_id IS NULL OR EXISTS (
  SELECT 1 FROM artifacts a WHERE a.id = knowledge_documents.markdown_artifact_id AND a.kind = 'markdown' AND a.status = 'ready'
    AND a.source_file_id = knowledge_documents.file_id))`;
// 步骤随文档可见（knowledge_documents 的策略在子查询中同样生效）。
const STEP_DOCUMENT_LIVE = sql`EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.id = knowledge_document_steps.document_id)`;

const COUNT_COLUMNS = sql.join(KNOWLEDGE_DOCUMENT_COUNT_COLUMNS.map((column) => sql.id(column)));

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // 以调用者身份执行：应用角色在 RLS 下正好数到本组织（文档只数到原件仍可用的）。上限由触发器参数给出。
    // 同一组织同一张表的插入用事务级 advisory lock 串行，并发写入不会一起越过上限。
    sql`CREATE FUNCTION knowledge_base_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_count bigint;
          BEGIN
            PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(TG_TABLE_NAME || ':' || NEW.org_id::text, 0));
            EXECUTE format('SELECT count(*) FROM %I.%I WHERE org_id = $1', TG_TABLE_SCHEMA, TG_TABLE_NAME) INTO v_count USING NEW.org_id;
            IF v_count >= TG_ARGV[0]::bigint THEN
              RAISE EXCEPTION 'too many rows in %', TG_TABLE_NAME USING ERRCODE = 'KB001';
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`REVOKE ALL ON FUNCTION knowledge_base_guard() FROM PUBLIC`,

    // created_by / updated_by 不设外键，与 projects.created_by 相同，不随用户删除而改动。
    sql`CREATE TABLE knowledge_folders (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND ${sql.lit(KNOWLEDGE_FOLDER_NAME_MAX_LENGTH)} AND name = btrim(name)),
          sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
          created_by uuid NOT NULL,
          updated_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT knowledge_folders_org_id_id_key UNIQUE (org_id, id)
        )`,
    sql`CREATE INDEX knowledge_folders_org_id_sort_order_idx ON knowledge_folders (org_id, sort_order, created_at)`,
    sql`CREATE TRIGGER knowledge_folders_touch BEFORE UPDATE ON knowledge_folders FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,
    sql`CREATE TRIGGER knowledge_folders_guard BEFORE INSERT ON knowledge_folders
          FOR EACH ROW EXECUTE FUNCTION knowledge_base_guard(${sql.lit(String(KNOWLEDGE_FOLDERS_PER_ORG_MAX))})`,
    sql`ALTER TABLE knowledge_folders ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE knowledge_folders FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY knowledge_folders_select_tenant ON knowledge_folders FOR SELECT TO ${app} USING (${TENANT})`,
    sql`CREATE POLICY knowledge_folders_insert_tenant ON knowledge_folders FOR INSERT TO ${app}
          WITH CHECK (${TENANT} AND created_by = app_current_user_id() AND updated_by = app_current_user_id())`,
    sql`CREATE POLICY knowledge_folders_update_tenant ON knowledge_folders FOR UPDATE TO ${app}
          USING (${TENANT}) WITH CHECK (${TENANT} AND updated_by = app_current_user_id())`,
    sql`CREATE POLICY knowledge_folders_delete_tenant ON knowledge_folders FOR DELETE TO ${app} USING (${TENANT})`,
    sql`GRANT SELECT, DELETE ON knowledge_folders TO ${app}`,
    sql`GRANT INSERT (org_id, name, sort_order, created_by, updated_by) ON knowledge_folders TO ${app}`,
    sql`GRANT UPDATE (name, sort_order, updated_by) ON knowledge_folders TO ${app}`,

    // 文件夹删除时文档行级联删除；原件被清理任务物理删除时文档行级联删除（文档行本身不引用对象存储，没有孤儿对象）。
    // 产物被清理任务删除时只清空 markdown_artifact_id（PostgreSQL 15 起的列级 SET NULL），不动 org_id。
    sql`CREATE TABLE knowledge_documents (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          folder_id uuid NOT NULL,
          file_id uuid NOT NULL,
          status text NOT NULL DEFAULT 'pending' CHECK (status IN (${list(KNOWLEDGE_DOCUMENT_STATUSES)})),
          progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
          message text NOT NULL DEFAULT '等待处理' CHECK (char_length(message) <= ${sql.lit(KNOWLEDGE_MESSAGE_MAX)}),
          error text CHECK (char_length(error) <= ${sql.lit(KNOWLEDGE_ERROR_MAX)}),
          ${sql.join(KNOWLEDGE_DOCUMENT_COUNT_COLUMNS.map((column) => sql`${sql.id(column)} integer NOT NULL DEFAULT 0 CHECK (${sql.id(column)} >= 0)`))},
          last_batch_size integer CHECK (last_batch_size >= 0),
          markdown_artifact_id uuid,
          parser_label text CHECK (char_length(parser_label) <= ${sql.lit(KNOWLEDGE_PARSER_LABEL_MAX)}),
          sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
          created_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT knowledge_documents_org_id_id_key UNIQUE (org_id, id),
          CONSTRAINT knowledge_documents_file_id_key UNIQUE (file_id),
          CONSTRAINT knowledge_documents_folder_fkey FOREIGN KEY (org_id, folder_id) REFERENCES knowledge_folders (org_id, id) ON DELETE CASCADE,
          CONSTRAINT knowledge_documents_file_fkey FOREIGN KEY (org_id, file_id) REFERENCES files (org_id, id) ON DELETE CASCADE,
          CONSTRAINT knowledge_documents_markdown_fkey FOREIGN KEY (org_id, markdown_artifact_id) REFERENCES artifacts (org_id, id)
            ON DELETE SET NULL (markdown_artifact_id)
        )`,
    sql`CREATE INDEX knowledge_documents_org_id_folder_idx ON knowledge_documents (org_id, folder_id, sort_order, created_at DESC)`,
    sql`CREATE INDEX knowledge_documents_markdown_idx ON knowledge_documents (org_id, markdown_artifact_id) WHERE markdown_artifact_id IS NOT NULL`,
    sql`CREATE TRIGGER knowledge_documents_touch BEFORE UPDATE ON knowledge_documents FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,
    sql`CREATE TRIGGER knowledge_documents_guard BEFORE INSERT ON knowledge_documents
          FOR EACH ROW EXECUTE FUNCTION knowledge_base_guard(${sql.lit(String(KNOWLEDGE_DOCUMENTS_PER_ORG_MAX))})`,
    sql`ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE knowledge_documents FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY knowledge_documents_select_tenant ON knowledge_documents FOR SELECT TO ${app}
          USING (${TENANT} AND ${DOCUMENT_FILE_LIVE})`,
    sql`CREATE POLICY knowledge_documents_insert_tenant ON knowledge_documents FOR INSERT TO ${app}
          WITH CHECK (${TENANT} AND created_by = app_current_user_id() AND ${DOCUMENT_FILE_ATTACHABLE})`,
    sql`CREATE POLICY knowledge_documents_update_tenant ON knowledge_documents FOR UPDATE TO ${app}
          USING (${TENANT} AND ${DOCUMENT_FILE_LIVE}) WITH CHECK (${TENANT} AND ${DOCUMENT_MARKDOWN_VALID})`,
    // 不授予 DELETE：删除文档即软删除其原件（见文件头）。
    sql`GRANT SELECT ON knowledge_documents TO ${app}`,
    sql`GRANT INSERT (org_id, folder_id, file_id, sort_order, created_by) ON knowledge_documents TO ${app}`,
    sql`GRANT UPDATE (folder_id, sort_order, status, progress, message, error, ${COUNT_COLUMNS}, last_batch_size,
          markdown_artifact_id, parser_label) ON knowledge_documents TO ${app}`,

    // 时间与状态的组合与桌面版 saveDocumentStep 相同：running 只有开始时间，success / error 有开始和完成时间，
    // error 必有错误信息，idle 什么都没有。
    sql`CREATE TABLE knowledge_document_steps (
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          document_id uuid NOT NULL,
          step_key text NOT NULL CHECK (step_key IN (${list(KNOWLEDGE_STEP_KEYS)})),
          status text NOT NULL DEFAULT 'idle' CHECK (status IN (${list(KNOWLEDGE_STEP_STATUSES)})),
          result jsonb CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= ${sql.lit(KNOWLEDGE_STEP_RESULT_MAX_BYTES)}),
          error text CHECK (char_length(error) <= ${sql.lit(KNOWLEDGE_ERROR_MAX)}),
          started_at timestamptz,
          completed_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (document_id, step_key),
          CONSTRAINT knowledge_document_steps_document_fkey FOREIGN KEY (org_id, document_id)
            REFERENCES knowledge_documents (org_id, id) ON DELETE CASCADE,
          CONSTRAINT knowledge_document_steps_status_shape CHECK (CASE status
            WHEN 'idle' THEN started_at IS NULL AND completed_at IS NULL AND error IS NULL
            WHEN 'running' THEN started_at IS NOT NULL AND completed_at IS NULL AND error IS NULL
            WHEN 'success' THEN started_at IS NOT NULL AND completed_at IS NOT NULL AND error IS NULL
            ELSE started_at IS NOT NULL AND completed_at IS NOT NULL AND error IS NOT NULL
          END)
        )`,
    sql`CREATE INDEX knowledge_document_steps_org_id_document_idx ON knowledge_document_steps (org_id, document_id)`,
    sql`CREATE TRIGGER knowledge_document_steps_touch BEFORE UPDATE ON knowledge_document_steps
          FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,
    sql`ALTER TABLE knowledge_document_steps ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE knowledge_document_steps FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY knowledge_document_steps_select_tenant ON knowledge_document_steps FOR SELECT TO ${app}
          USING (${TENANT} AND ${STEP_DOCUMENT_LIVE})`,
    sql`CREATE POLICY knowledge_document_steps_insert_tenant ON knowledge_document_steps FOR INSERT TO ${app}
          WITH CHECK (${TENANT} AND ${STEP_DOCUMENT_LIVE})`,
    sql`CREATE POLICY knowledge_document_steps_update_tenant ON knowledge_document_steps FOR UPDATE TO ${app}
          USING (${TENANT} AND ${STEP_DOCUMENT_LIVE}) WITH CHECK (${TENANT})`,
    sql`CREATE POLICY knowledge_document_steps_delete_tenant ON knowledge_document_steps FOR DELETE TO ${app}
          USING (${TENANT} AND ${STEP_DOCUMENT_LIVE})`,
    sql`GRANT SELECT, DELETE ON knowledge_document_steps TO ${app}`,
    sql`GRANT INSERT (org_id, document_id, step_key, status, result, error, started_at, completed_at) ON knowledge_document_steps TO ${app}`,
    sql`GRANT UPDATE (status, result, error, started_at, completed_at) ON knowledge_document_steps TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`DROP TABLE knowledge_document_steps`,
    sql`DROP TABLE knowledge_documents`,
    sql`DROP TABLE knowledge_folders`,
    sql`DROP FUNCTION knowledge_base_guard()`,
  ]);
}
