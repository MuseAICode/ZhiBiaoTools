// 废标检查（docs/SERVER_DESIGN.md 第 2.5 节；路线图第 5 步 5.9）：取代桌面版 SQLite 的 rejection_check_* 七张表
// （rejection_check_tasks 不迁移，由第 6 步的 jobs 取代）。全部是项目级表，挂在 kind = 'rejection-check' 的项目下，
// 取代桌面版的单例页面（id = 1）：
//
// - rejection_check_meta：每个项目一行，页面步骤、当前文档 / 结果页签、自定义检查项和检查选项；
// - rejection_check_documents：导入的招标文件（tender）和投标文件（bid）。原件是上传用途为 tender 的文件，本表只记
//   file_id，取代桌面版的 document_id / markdown_path；文件名取 files；解析出的 Markdown 是生成产物，记
//   markdown_artifact_id。新文档一律待解析（status 没有 INSERT 授权），解析由第 6 步的任务写入。桌面版合并的招标正文
//   （document_id = 'tender'）不再存，由任务按招标文件的顺序合并；
// - rejection_check_extraction：无效投标与废标项的解析结果，每个项目一行；
// - rejection_check_results：废标项、错别字、逻辑问题三类检查的状态；
// - rejection_check_risk_findings / _typo_findings / _logic_findings：三类检查的问题，由第 6 步的检查任务整体替换写入，
//   用户只能删除单条。bid_document_id 是投标文件的 file_id。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行，未设置上下文时什么都看不到；项目由复合外键 (org_id, project_id)
//   保证属于本组织（不级联到别的组织），org_id、project_id、file_id 写入后不能改；
// - 删除可见性：所属项目已删除（或不是废标检查项目）时七张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复；
//   条件写成“不存在同 id 的已删除或其他 kind 的项目”，跨组织的 project_id 仍由复合外键报错（与 artifacts 相同）；
// - 文档随原件的生命周期：原件已删除（进入回收站）、未上传完成或已不属于本项目时，文档行和引用它的问题都不可见，
//   恢复文件即一起恢复；应用角色没有文档的 DELETE 授权，移除文档就是软删除原件。原件被清理任务物理删除时，
//   文档行及其问题由外键级联删除；
// - 只能导入本组织已上传、未删除、用途是 tender、且已挂到本项目（files.project_id）的文件（INSERT 策略）；
// - markdown_artifact_id 只能指向本组织已写完、种类为 markdown、来源文件就是该文档原件的产物（UPDATE 策略）；
// - 问题只能指向本项目的投标文件（INSERT 策略要求文档可见且 role = 'bid'）；
// - 写法与桌面版相同“整体替换”：问题只授予 SELECT、INSERT 和 DELETE，不授予 UPDATE；页面状态、解析结果、检查状态
//   按字段更新，页面状态不能删除（清空时恢复默认值）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

export const REJECTION_CHECK_STEPS = ['documents', 'items', 'results'] as const;
export const REJECTION_CHECK_RESULT_TABS = ['analysis', 'custom'] as const;
/** 三类检查，同时是检查结果页签的取值。 */
export const REJECTION_CHECK_RESULT_TYPES = ['rejection', 'typo', 'logic'] as const;
export const REJECTION_CHECK_DOCUMENT_ROLES = ['tender', 'bid'] as const;
/** 文档的解析状态（第 6 步的解析任务写入）。 */
export const REJECTION_CHECK_DOCUMENT_STATUSES = ['pending', 'running', 'success', 'error'] as const;
/** 解析结果与三类检查的状态，与桌面版 Renderer 类型相同。 */
export const REJECTION_CHECK_RUN_STATUSES = ['idle', 'running', 'success', 'error'] as const;
export const REJECTION_CHECK_EXTRACTION_SOURCES = ['ai', 'technical-plan'] as const;
export const REJECTION_CHECK_FINDING_TYPES = ['invalidBid', 'rejectionItem'] as const;
export const REJECTION_CHECK_SEVERITIES = ['high', 'medium', 'low'] as const;

/** 问题 id、当前文档页签、签名、哈希等短文本的字数上限。 */
export const REJECTION_CHECK_KEY_MAX = 200;
/** 进度说明、标题、错误文本与建议文本的字数上限。 */
export const REJECTION_CHECK_TITLE_MAX = 2000;
/** 错误信息、问题的要求 / 证据 / 原因 / 原文等文本的字数上限。 */
export const REJECTION_CHECK_TEXT_MAX = 20_000;
/** 自定义检查项的字数上限（用户输入）。 */
export const REJECTION_CHECK_CUSTOM_ITEMS_MAX = 100_000;
/** 无效投标与废标项解析结果的字数上限。 */
export const REJECTION_CHECK_EXTRACTION_MAX = 1_000_000;
/** 解析器标签的字数上限。 */
export const REJECTION_CHECK_PARSER_LABEL_MAX = 200;

/** 七张表，按依赖顺序（down 倒序删除）。 */
export const REJECTION_CHECK_TABLES = [
  'rejection_check_meta',
  'rejection_check_documents',
  'rejection_check_extraction',
  'rejection_check_results',
  'rejection_check_risk_findings',
  'rejection_check_typo_findings',
  'rejection_check_logic_findings',
] as const;

type Table = (typeof REJECTION_CHECK_TABLES)[number];

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

function text(column: string, max: number, nullable = false): RawBuilder<unknown> {
  return sql`${sql.id(column)} text ${nullable ? sql`` : sql`NOT NULL`} CHECK (char_length(${sql.id(column)}) <= ${sql.lit(max)})`;
}

function key(column: string, nullable = false): RawBuilder<unknown> {
  return sql`${sql.id(column)} text ${nullable ? sql`` : sql`NOT NULL`} CHECK (char_length(${sql.id(column)}) BETWEEN 1 AND ${sql.lit(REJECTION_CHECK_KEY_MAX)})`;
}

const SORT_ORDER = sql`sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0)`;

function projectFkey(table: Table): RawBuilder<unknown> {
  return sql`CONSTRAINT ${sql.id(`${table}_project_fkey`)} FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE`;
}

/** 问题对投标文件的引用：随文档行删除（清理任务删除原件时）。 */
function documentFkey(table: Table): RawBuilder<unknown> {
  return sql`CONSTRAINT ${sql.id(`${table}_document_fkey`)} FOREIGN KEY (org_id, project_id, bid_document_id)
    REFERENCES rejection_check_documents (org_id, project_id, file_id) ON DELETE CASCADE`;
}

const TENANT = sql`org_id = app_current_org_id()`;

/** 所属项目未删除、是废标检查项目（在应用角色的 RLS 下求值，只看得到本组织的项目；跨组织的 project_id 由外键报错）。 */
function projectLive(table: Table): RawBuilder<unknown> {
  return sql`NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${sql.id(table)}.project_id
    AND (p.deleted_at IS NOT NULL OR p.kind <> 'rejection-check'))`;
}

/** 原件已上传、未删除、仍挂在本项目下（files 的策略在子查询中同样生效）。 */
const DOCUMENT_FILE_LIVE = sql`EXISTS (SELECT 1 FROM files f WHERE f.id = rejection_check_documents.file_id
  AND f.status = 'uploaded' AND f.deleted_at IS NULL AND f.project_id = rejection_check_documents.project_id)`;
/** 新导入的文档另要求原件用途是 tender（招标文件、投标文件都用它）。 */
const DOCUMENT_FILE_ATTACHABLE = sql`EXISTS (SELECT 1 FROM files f WHERE f.id = rejection_check_documents.file_id
  AND f.status = 'uploaded' AND f.deleted_at IS NULL AND f.project_id = rejection_check_documents.project_id
  AND f.purpose = 'tender')`;
/** 解析出的 Markdown 必须是本文档原件的产物（artifacts 的策略在子查询中同样生效）。 */
const DOCUMENT_MARKDOWN_VALID = sql`(markdown_artifact_id IS NULL OR EXISTS (
  SELECT 1 FROM artifacts a WHERE a.id = rejection_check_documents.markdown_artifact_id AND a.kind = 'markdown' AND a.status = 'ready'
    AND a.source_file_id = rejection_check_documents.file_id))`;

/** 问题引用的投标文件可见（rejection_check_documents 的策略在子查询中同样生效：项目、原件都要可用）。 */
function documentLive(table: Table): RawBuilder<unknown> {
  return sql`EXISTS (SELECT 1 FROM rejection_check_documents d WHERE d.project_id = ${sql.id(table)}.project_id
    AND d.file_id = ${sql.id(table)}.bid_document_id)`;
}

/** 新写的问题只能指向投标文件。 */
function documentIsBid(table: Table): RawBuilder<unknown> {
  return sql`EXISTS (SELECT 1 FROM rejection_check_documents d WHERE d.project_id = ${sql.id(table)}.project_id
    AND d.file_id = ${sql.id(table)}.bid_document_id AND d.role = 'bid')`;
}

interface PolicySpec {
  /** 行可见的条件（SELECT、UPDATE、DELETE 的 USING，INSERT 的 WITH CHECK）。 */
  live: RawBuilder<unknown>;
  /** INSERT 另加的条件。 */
  insert?: RawBuilder<unknown>;
  /** UPDATE 的 WITH CHECK 另加的条件。 */
  update?: RawBuilder<unknown>;
  commands: readonly ('INSERT' | 'UPDATE' | 'DELETE')[];
}

function policies(table: Table, spec: PolicySpec): RawBuilder<unknown>[] {
  const t = sql.id(table);
  const insertCheck = spec.insert ? sql`${TENANT} AND ${spec.live} AND ${spec.insert}` : sql`${TENANT} AND ${spec.live}`;
  const updateCheck = spec.update ? sql`${TENANT} AND ${spec.update}` : TENANT;
  return [
    sql`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY ${sql.id(`${table}_select_tenant`)} ON ${t} FOR SELECT TO ${app} USING (${TENANT} AND ${spec.live})`,
    ...(spec.commands.includes('INSERT')
      ? [sql`CREATE POLICY ${sql.id(`${table}_insert_tenant`)} ON ${t} FOR INSERT TO ${app} WITH CHECK (${insertCheck})`]
      : []),
    ...(spec.commands.includes('UPDATE')
      ? [sql`CREATE POLICY ${sql.id(`${table}_update_tenant`)} ON ${t} FOR UPDATE TO ${app} USING (${TENANT} AND ${spec.live}) WITH CHECK (${updateCheck})`]
      : []),
    ...(spec.commands.includes('DELETE')
      ? [sql`CREATE POLICY ${sql.id(`${table}_delete_tenant`)} ON ${t} FOR DELETE TO ${app} USING (${TENANT} AND ${spec.live})`]
      : []),
  ];
}

function columns(names: readonly string[]): RawBuilder<unknown> {
  return sql.join(names.map((name) => sql.id(name)));
}

/** 整体替换的问题表：SELECT、DELETE 和列级 INSERT，不授予 UPDATE。 */
function replaceGrants(table: Table, insertColumns: readonly string[]): RawBuilder<unknown>[] {
  const t = sql.id(table);
  return [sql`GRANT SELECT, DELETE ON ${t} TO ${app}`, sql`GRANT INSERT (${columns(insertColumns)}) ON ${t} TO ${app}`];
}

function touch(table: Table): RawBuilder<unknown> {
  return sql`CREATE TRIGGER ${sql.id(`${table}_touch`)} BEFORE UPDATE ON ${sql.id(table)} FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`;
}

/** 三张问题表共有的列与约束。 */
function findingTable(table: Table, body: RawBuilder<unknown>): RawBuilder<unknown> {
  return sql`CREATE TABLE ${sql.id(table)} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    ${key('finding_id')},
    bid_document_id uuid NOT NULL,
    ${body},
    ${SORT_ORDER},
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ${sql.id(`${table}_finding_key`)} UNIQUE (project_id, finding_id),
    ${projectFkey(table)},
    ${documentFkey(table)}
  )`;
}

function findingStatements(table: Table, body: RawBuilder<unknown>, insertColumns: readonly string[]): RawBuilder<unknown>[] {
  return [
    findingTable(table, body),
    sql`CREATE INDEX ${sql.id(`${table}_org_id_project_id_idx`)} ON ${sql.id(table)} (org_id, project_id, sort_order)`,
    sql`CREATE INDEX ${sql.id(`${table}_document_idx`)} ON ${sql.id(table)} (org_id, project_id, bid_document_id)`,
    ...policies(table, { live: documentLive(table), insert: documentIsBid(table), commands: ['INSERT', 'DELETE'] }),
    ...replaceGrants(table, ['org_id', 'project_id', 'finding_id', 'bid_document_id', ...insertColumns, 'sort_order']),
  ];
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // ---- 页面状态 ----

    // active_document_tab 是 'tender'（合并的招标正文）或某个文档的 file_id，读出时与桌面版相同回退到可用的页签。
    // 检查选项中废标项检查始终开启（与桌面版相同），只存错别字、逻辑问题两项。
    sql`CREATE TABLE rejection_check_meta (
          project_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          step text NOT NULL DEFAULT 'documents' CHECK (step IN (${list(REJECTION_CHECK_STEPS)})),
          ${key('active_document_tab')} DEFAULT 'tender',
          active_result_tab text NOT NULL DEFAULT 'analysis' CHECK (active_result_tab IN (${list(REJECTION_CHECK_RESULT_TABS)})),
          active_check_result_tab text NOT NULL DEFAULT 'rejection' CHECK (active_check_result_tab IN (${list(REJECTION_CHECK_RESULT_TYPES)})),
          ${text('custom_check_items', REJECTION_CHECK_CUSTOM_ITEMS_MAX)} DEFAULT '',
          typo_check boolean NOT NULL DEFAULT true,
          logic_check boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          ${projectFkey('rejection_check_meta')}
        )`,
    sql`CREATE INDEX rejection_check_meta_org_id_project_id_idx ON rejection_check_meta (org_id, project_id)`,
    touch('rejection_check_meta'),
    ...policies('rejection_check_meta', { live: projectLive('rejection_check_meta'), commands: ['INSERT', 'UPDATE'] }),
    // 不授予 DELETE：清空时恢复默认值。
    sql`GRANT SELECT ON rejection_check_meta TO ${app}`,
    sql`GRANT INSERT (project_id, org_id, step, active_document_tab, active_result_tab, active_check_result_tab, custom_check_items,
          typo_check, logic_check) ON rejection_check_meta TO ${app}`,
    sql`GRANT UPDATE (step, active_document_tab, active_result_tab, active_check_result_tab, custom_check_items, typo_check, logic_check)
          ON rejection_check_meta TO ${app}`,

    // ---- 文档 ----

    // 每个文件只能导入一次（同一文件不能既是招标文件又是投标文件，也不能挂到两个项目，files.project_id 只有一个）。
    // 产物被清理任务删除时只清空 markdown_artifact_id（PostgreSQL 15 起的列级 SET NULL）。
    sql`CREATE TABLE rejection_check_documents (
          file_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          role text NOT NULL CHECK (role IN (${list(REJECTION_CHECK_DOCUMENT_ROLES)})),
          ${SORT_ORDER},
          status text NOT NULL DEFAULT 'pending' CHECK (status IN (${list(REJECTION_CHECK_DOCUMENT_STATUSES)})),
          markdown_artifact_id uuid,
          content_chars integer NOT NULL DEFAULT 0 CHECK (content_chars >= 0),
          ${key('content_hash', true)},
          ${text('parser_label', REJECTION_CHECK_PARSER_LABEL_MAX, true)},
          ${text('error', REJECTION_CHECK_TEXT_MAX, true)},
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT rejection_check_documents_scope_key UNIQUE (org_id, project_id, file_id),
          ${projectFkey('rejection_check_documents')},
          CONSTRAINT rejection_check_documents_file_fkey FOREIGN KEY (org_id, file_id) REFERENCES files (org_id, id) ON DELETE CASCADE,
          CONSTRAINT rejection_check_documents_markdown_fkey FOREIGN KEY (org_id, markdown_artifact_id)
            REFERENCES artifacts (org_id, id) ON DELETE SET NULL (markdown_artifact_id)
        )`,
    sql`CREATE INDEX rejection_check_documents_org_id_project_id_idx ON rejection_check_documents (org_id, project_id, role, sort_order)`,
    sql`CREATE INDEX rejection_check_documents_markdown_idx ON rejection_check_documents (org_id, markdown_artifact_id)
          WHERE markdown_artifact_id IS NOT NULL`,
    touch('rejection_check_documents'),
    ...policies('rejection_check_documents', {
      live: sql`${projectLive('rejection_check_documents')} AND ${DOCUMENT_FILE_LIVE}`,
      insert: DOCUMENT_FILE_ATTACHABLE,
      update: DOCUMENT_MARKDOWN_VALID,
      commands: ['INSERT', 'UPDATE'],
    }),
    // 不授予 DELETE：移除文档就是软删除原件。status 等解析结果没有 INSERT 授权，新文档一律待解析。
    sql`GRANT SELECT ON rejection_check_documents TO ${app}`,
    sql`GRANT INSERT (file_id, org_id, project_id, role, sort_order) ON rejection_check_documents TO ${app}`,
    sql`GRANT UPDATE (status, markdown_artifact_id, content_chars, content_hash, parser_label, error) ON rejection_check_documents TO ${app}`,

    // ---- 无效投标与废标项解析结果 ----

    // tender_signature 是解析时招标文件的签名，与当前招标文件的签名不同即已失效。
    sql`CREATE TABLE rejection_check_extraction (
          project_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          status text NOT NULL DEFAULT 'idle' CHECK (status IN (${list(REJECTION_CHECK_RUN_STATUSES)})),
          ${text('content', REJECTION_CHECK_EXTRACTION_MAX)} DEFAULT '',
          source text CHECK (source IN (${list(REJECTION_CHECK_EXTRACTION_SOURCES)})),
          ${key('tender_signature', true)},
          ${text('error', REJECTION_CHECK_TEXT_MAX, true)},
          updated_at timestamptz NOT NULL DEFAULT now(),
          ${projectFkey('rejection_check_extraction')}
        )`,
    sql`CREATE INDEX rejection_check_extraction_org_id_project_id_idx ON rejection_check_extraction (org_id, project_id)`,
    touch('rejection_check_extraction'),
    ...policies('rejection_check_extraction', {
      live: projectLive('rejection_check_extraction'),
      commands: ['INSERT', 'UPDATE', 'DELETE'],
    }),
    sql`GRANT SELECT, DELETE ON rejection_check_extraction TO ${app}`,
    sql`GRANT INSERT (project_id, org_id, status, content, source, tender_signature, error) ON rejection_check_extraction TO ${app}`,
    sql`GRANT UPDATE (status, content, source, tender_signature, error) ON rejection_check_extraction TO ${app}`,

    // ---- 三类检查 ----

    // input_signature 是检查时输入的签名（废标项：投标文件、解析结果与自定义检查项；错别字、逻辑问题：投标文件），
    // 与当前输入的签名不同即已失效。
    sql`CREATE TABLE rejection_check_results (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          result_type text NOT NULL CHECK (result_type IN (${list(REJECTION_CHECK_RESULT_TYPES)})),
          status text NOT NULL DEFAULT 'idle' CHECK (status IN (${list(REJECTION_CHECK_RUN_STATUSES)})),
          ${key('input_signature', true)},
          ${key('active_finding_id', true)},
          ${text('progress_message', REJECTION_CHECK_TITLE_MAX, true)},
          ${text('error', REJECTION_CHECK_TEXT_MAX, true)},
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, result_type),
          ${projectFkey('rejection_check_results')}
        )`,
    sql`CREATE INDEX rejection_check_results_org_id_project_id_idx ON rejection_check_results (org_id, project_id)`,
    touch('rejection_check_results'),
    ...policies('rejection_check_results', { live: projectLive('rejection_check_results'), commands: ['INSERT', 'UPDATE', 'DELETE'] }),
    sql`GRANT SELECT, DELETE ON rejection_check_results TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, result_type, status, input_signature, active_finding_id, progress_message, error)
          ON rejection_check_results TO ${app}`,
    sql`GRANT UPDATE (status, input_signature, active_finding_id, progress_message, error) ON rejection_check_results TO ${app}`,

    ...findingStatements(
      'rejection_check_risk_findings',
      sql`type text NOT NULL CHECK (type IN (${list(REJECTION_CHECK_FINDING_TYPES)})),
          severity text NOT NULL CHECK (severity IN (${list(REJECTION_CHECK_SEVERITIES)})),
          ${text('title', REJECTION_CHECK_TITLE_MAX)},
          ${text('summary', REJECTION_CHECK_TEXT_MAX)},
          ${text('requirement', REJECTION_CHECK_TEXT_MAX)},
          ${text('bid_evidence', REJECTION_CHECK_TEXT_MAX)},
          ${text('risk_reason', REJECTION_CHECK_TEXT_MAX)},
          ${text('suggestion', REJECTION_CHECK_TEXT_MAX)}`,
      ['type', 'severity', 'title', 'summary', 'requirement', 'bid_evidence', 'risk_reason', 'suggestion'],
    ),
    ...findingStatements(
      'rejection_check_typo_findings',
      sql`${text('wrong_text', REJECTION_CHECK_TITLE_MAX)},
          ${text('correct_text', REJECTION_CHECK_TITLE_MAX)},
          ${text('original_excerpt', REJECTION_CHECK_TEXT_MAX)},
          ${text('reason', REJECTION_CHECK_TEXT_MAX)},
          ${text('location_hint', REJECTION_CHECK_TITLE_MAX, true)}`,
      ['wrong_text', 'correct_text', 'original_excerpt', 'reason', 'location_hint'],
    ),
    ...findingStatements(
      'rejection_check_logic_findings',
      sql`${text('title', REJECTION_CHECK_TITLE_MAX)},
          ${text('original_text', REJECTION_CHECK_TEXT_MAX)},
          ${text('location_hint', REJECTION_CHECK_TITLE_MAX)},
          ${text('fallacy_reason', REJECTION_CHECK_TEXT_MAX)},
          ${text('suggestion', REJECTION_CHECK_TEXT_MAX)}`,
      ['title', 'original_text', 'location_hint', 'fallacy_reason', 'suggestion'],
    ),
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(
    db,
    [...REJECTION_CHECK_TABLES].reverse().map((table) => sql`DROP TABLE ${sql.id(table)}`),
  );
}
