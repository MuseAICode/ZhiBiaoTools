// 可研报告（docs/SERVER_DESIGN.md 第 2.5 节；路线图第 5 步 5.10）：取代桌面版 SQLite 的 feasibility_report_meta 和
// feasibility_report_outline_nodes（feasibility_report_tasks 不迁移，由第 6 步的 jobs 取代）。全部是项目级表，挂在
// kind = 'feasibility-report' 的项目下，取代桌面版的单例页面（id = 1）：
//
// - feasibility_report_meta：每个项目一行，页面步骤、项目信息（桌面版的 project_info_json 拆成列）、资料分析、目录配置、
//   关键参数，以及目录的项目名称与概述；
// - feasibility_report_sources：可研资料。桌面版存在 meta 的 source_files_json 中（本地 Markdown 路径），这里拆成表：
//   原件是上传用途为 tender 的文件，本表只记 file_id；解析出的 Markdown 是生成产物，记 markdown_artifact_id。新资料一律
//   待解析（status 没有 INSERT 授权），解析由第 6 步的任务写入；
// - feasibility_report_reference_docs：目录生成引用的知识库文档。桌面版存在 meta 的 reference_document_ids_json 中，
//   这里拆成表，以复合外键指向本组织的知识库文档；
// - feasibility_report_outline_nodes：报告目录与各章正文，节点 id 是桌面版 Renderer 重新编号后的 '1'、'1.2' 等文本。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行，未设置上下文时什么都看不到；项目由复合外键 (org_id, project_id)
//   保证属于本组织（不级联到别的组织），org_id、project_id、file_id、document_id 写入后不能改；
// - 删除可见性：所属项目已删除（或不是可研报告项目）时四张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复；
//   条件写成“不存在同 id 的已删除或其他 kind 的项目”，跨组织的 project_id 仍由复合外键报错（与 artifacts 相同）；
// - 资料随原件的生命周期：原件已删除（进入回收站）、未上传完成或已不属于本项目时资料行不可见，恢复文件即一起恢复；
//   应用角色没有资料的 DELETE 授权，移除资料就是软删除原件。原件被清理任务物理删除时资料行由外键级联删除；
// - 只能登记本组织已上传、未删除、用途是 tender、且已挂到本项目（files.project_id）的文件（INSERT 策略）；
// - markdown_artifact_id 只能指向本组织已写完、种类为 markdown、来源文件就是该资料原件的产物（UPDATE 策略）；
// - 引用的知识库文档随文档的可见性：文档不可见（原件进回收站）时引用行同样不可见，也不能新引用；文档被删除时引用行由
//   外键级联删除（knowledge_documents 的策略在子查询中同样生效）；
// - 目录与桌面版相同整体替换：节点只授予 SELECT、INSERT、DELETE 和 content 列的 UPDATE（保存单章正文）；
//   父节点由复合外键指向同一项目的节点，随父节点级联删除，DEFERRABLE INITIALLY DEFERRED（同一次替换中可以先写子节点）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

export const FEASIBILITY_REPORT_STEPS = ['materials', 'sources', 'analysis', 'outline', 'parameters', 'content'] as const;
export const FEASIBILITY_PROJECT_TYPES = ['government', 'enterprise'] as const;
export const FEASIBILITY_OUTLINE_TEMPLATES = [
  'government',
  'enterprise',
  'industrial',
  'hi_tech',
  'infrastructure',
  'eco_environmental',
  'commercial_realestate',
] as const;
/** 资料的解析状态（第 6 步的解析任务写入）。 */
export const FEASIBILITY_SOURCE_STATUSES = ['pending', 'running', 'success', 'error'] as const;

/** 项目信息中单行字段的字数上限。 */
export const FEASIBILITY_FIELD_MAX = 500;
/** 建设内容、目录概述与说明、错误信息等文本的字数上限。 */
export const FEASIBILITY_TEXT_MAX = 20_000;
/** 目录标题、目录项目名称的字数上限。 */
export const FEASIBILITY_TITLE_MAX = 2000;
/** 资料分析、关键参数（Markdown）的字数上限。 */
export const FEASIBILITY_MARKDOWN_MAX = 1_000_000;
/** 单章正文的字数上限。 */
export const FEASIBILITY_CONTENT_MAX = 500_000;
/** 目录节点 id 的字数上限（桌面版 Renderer 编号为 '1.2.3'）。 */
export const FEASIBILITY_NODE_ID_MAX = 64;
/** 目录的最大层级。 */
export const FEASIBILITY_OUTLINE_DEPTH_MAX = 10;
/** 正文哈希的字数上限。 */
export const FEASIBILITY_KEY_MAX = 200;
/** 解析器标签的字数上限。 */
export const FEASIBILITY_PARSER_LABEL_MAX = 200;
/** 目标字数的范围（桌面版不足 1000 时取默认 30000）。 */
export const FEASIBILITY_TARGET_WORDS_MIN = 1000;
export const FEASIBILITY_TARGET_WORDS_MAX = 1_000_000;
/** 章节引用的知识库条目 id（jsonb 数组）的大小上限。 */
export const FEASIBILITY_KNOWLEDGE_IDS_MAX_BYTES = 64 * 1024;

/** 四张表，按依赖顺序（down 倒序删除）。 */
export const FEASIBILITY_REPORT_TABLES = [
  'feasibility_report_meta',
  'feasibility_report_sources',
  'feasibility_report_reference_docs',
  'feasibility_report_outline_nodes',
] as const;

type Table = (typeof FEASIBILITY_REPORT_TABLES)[number];

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

function text(column: string, max: number, nullable = false): RawBuilder<unknown> {
  return sql`${sql.id(column)} text ${nullable ? sql`` : sql`NOT NULL`} CHECK (char_length(${sql.id(column)}) <= ${sql.lit(max)})`;
}

const SORT_ORDER = sql`sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0)`;

function projectFkey(table: Table): RawBuilder<unknown> {
  return sql`CONSTRAINT ${sql.id(`${table}_project_fkey`)} FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE`;
}

const TENANT = sql`org_id = app_current_org_id()`;

/** 所属项目未删除、是可研报告项目（在应用角色的 RLS 下求值，只看得到本组织的项目；跨组织的 project_id 由外键报错）。 */
function projectLive(table: Table): RawBuilder<unknown> {
  return sql`NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${sql.id(table)}.project_id
    AND (p.deleted_at IS NOT NULL OR p.kind <> 'feasibility-report'))`;
}

/** 原件已上传、未删除、仍挂在本项目下（files 的策略在子查询中同样生效）。 */
const SOURCE_FILE_LIVE = sql`EXISTS (SELECT 1 FROM files f WHERE f.id = feasibility_report_sources.file_id
  AND f.status = 'uploaded' AND f.deleted_at IS NULL AND f.project_id = feasibility_report_sources.project_id)`;
/** 新登记的资料另要求原件用途是 tender（招标文件、原方案、可研资料都用它）。 */
const SOURCE_FILE_ATTACHABLE = sql`EXISTS (SELECT 1 FROM files f WHERE f.id = feasibility_report_sources.file_id
  AND f.status = 'uploaded' AND f.deleted_at IS NULL AND f.project_id = feasibility_report_sources.project_id
  AND f.purpose = 'tender')`;
/** 解析出的 Markdown 必须是本资料原件的产物（artifacts 的策略在子查询中同样生效）。 */
const SOURCE_MARKDOWN_VALID = sql`(markdown_artifact_id IS NULL OR EXISTS (
  SELECT 1 FROM artifacts a WHERE a.id = feasibility_report_sources.markdown_artifact_id AND a.kind = 'markdown' AND a.status = 'ready'
    AND a.source_file_id = feasibility_report_sources.file_id))`;
/** 引用的知识库文档可见（knowledge_documents 的策略在子查询中同样生效：本组织、原件未删除）。 */
const REFERENCE_DOCUMENT_LIVE = sql`EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.id = feasibility_report_reference_docs.document_id)`;

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

function touch(table: Table): RawBuilder<unknown> {
  return sql`CREATE TRIGGER ${sql.id(`${table}_touch`)} BEFORE UPDATE ON ${sql.id(table)} FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // ---- 页面状态 ----

    // 项目信息的默认值与桌面版 emptyProjectInfo 相同；目录的项目名称与概述为空表示没有目录。
    sql`CREATE TABLE feasibility_report_meta (
          project_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          step text NOT NULL DEFAULT 'materials' CHECK (step IN (${list(FEASIBILITY_REPORT_STEPS)})),
          ${text('project_name', FEASIBILITY_FIELD_MAX)} DEFAULT '',
          project_type text NOT NULL DEFAULT 'government' CHECK (project_type IN (${list(FEASIBILITY_PROJECT_TYPES)})),
          ${text('industry', FEASIBILITY_FIELD_MAX)} DEFAULT '',
          ${text('construction_unit', FEASIBILITY_FIELD_MAX)} DEFAULT '',
          ${text('location', FEASIBILITY_FIELD_MAX)} DEFAULT '',
          ${text('construction_content', FEASIBILITY_TEXT_MAX)} DEFAULT '',
          ${text('construction_period_years', FEASIBILITY_FIELD_MAX)} DEFAULT '2',
          ${text('operation_period_years', FEASIBILITY_FIELD_MAX)} DEFAULT '20',
          ${text('total_investment', FEASIBILITY_FIELD_MAX)} DEFAULT '',
          ${text('funding_source', FEASIBILITY_FIELD_MAX)} DEFAULT '',
          ${text('analysis_markdown', FEASIBILITY_MARKDOWN_MAX)} DEFAULT '',
          outline_template text NOT NULL DEFAULT 'government' CHECK (outline_template IN (${list(FEASIBILITY_OUTLINE_TEMPLATES)})),
          target_words integer NOT NULL DEFAULT 30000
            CHECK (target_words BETWEEN ${sql.lit(FEASIBILITY_TARGET_WORDS_MIN)} AND ${sql.lit(FEASIBILITY_TARGET_WORDS_MAX)}),
          ${text('key_parameters_markdown', FEASIBILITY_MARKDOWN_MAX)} DEFAULT '',
          ${text('outline_project_name', FEASIBILITY_TITLE_MAX, true)},
          ${text('outline_project_overview', FEASIBILITY_TEXT_MAX, true)},
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          ${projectFkey('feasibility_report_meta')}
        )`,
    sql`CREATE INDEX feasibility_report_meta_org_id_project_id_idx ON feasibility_report_meta (org_id, project_id)`,
    touch('feasibility_report_meta'),
    ...policies('feasibility_report_meta', { live: projectLive('feasibility_report_meta'), commands: ['INSERT', 'UPDATE'] }),
    // 不授予 DELETE：清空时恢复默认值。
    sql`GRANT SELECT ON feasibility_report_meta TO ${app}`,
    sql`GRANT INSERT (project_id, org_id, step, project_name, project_type, industry, construction_unit, location, construction_content,
          construction_period_years, operation_period_years, total_investment, funding_source, analysis_markdown, outline_template,
          target_words, key_parameters_markdown, outline_project_name, outline_project_overview) ON feasibility_report_meta TO ${app}`,
    sql`GRANT UPDATE (step, project_name, project_type, industry, construction_unit, location, construction_content,
          construction_period_years, operation_period_years, total_investment, funding_source, analysis_markdown, outline_template,
          target_words, key_parameters_markdown, outline_project_name, outline_project_overview) ON feasibility_report_meta TO ${app}`,

    // ---- 可研资料 ----

    // 每个文件只能登记一次（files.project_id 只有一个，也不能同时是两个项目的资料）。
    // 产物被清理任务删除时只清空 markdown_artifact_id（PostgreSQL 15 起的列级 SET NULL）。
    sql`CREATE TABLE feasibility_report_sources (
          file_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          ${SORT_ORDER},
          status text NOT NULL DEFAULT 'pending' CHECK (status IN (${list(FEASIBILITY_SOURCE_STATUSES)})),
          markdown_artifact_id uuid,
          content_chars integer NOT NULL DEFAULT 0 CHECK (content_chars >= 0),
          content_hash text CHECK (char_length(content_hash) BETWEEN 1 AND ${sql.lit(FEASIBILITY_KEY_MAX)}),
          ${text('parser_label', FEASIBILITY_PARSER_LABEL_MAX, true)},
          ${text('error', FEASIBILITY_TEXT_MAX, true)},
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          ${projectFkey('feasibility_report_sources')},
          CONSTRAINT feasibility_report_sources_file_fkey FOREIGN KEY (org_id, file_id) REFERENCES files (org_id, id) ON DELETE CASCADE,
          CONSTRAINT feasibility_report_sources_markdown_fkey FOREIGN KEY (org_id, markdown_artifact_id)
            REFERENCES artifacts (org_id, id) ON DELETE SET NULL (markdown_artifact_id)
        )`,
    sql`CREATE INDEX feasibility_report_sources_org_id_project_id_idx ON feasibility_report_sources (org_id, project_id, sort_order)`,
    sql`CREATE INDEX feasibility_report_sources_markdown_idx ON feasibility_report_sources (org_id, markdown_artifact_id)
          WHERE markdown_artifact_id IS NOT NULL`,
    touch('feasibility_report_sources'),
    ...policies('feasibility_report_sources', {
      live: sql`${projectLive('feasibility_report_sources')} AND ${SOURCE_FILE_LIVE}`,
      insert: SOURCE_FILE_ATTACHABLE,
      update: SOURCE_MARKDOWN_VALID,
      commands: ['INSERT', 'UPDATE'],
    }),
    // 不授予 DELETE：移除资料就是软删除原件。status 等解析结果没有 INSERT 授权，新资料一律待解析；
    // sort_order 可以改（重新导入时按给出的顺序重排）。
    sql`GRANT SELECT ON feasibility_report_sources TO ${app}`,
    sql`GRANT INSERT (file_id, org_id, project_id, sort_order) ON feasibility_report_sources TO ${app}`,
    sql`GRANT UPDATE (sort_order, status, markdown_artifact_id, content_chars, content_hash, parser_label, error)
          ON feasibility_report_sources TO ${app}`,

    // ---- 引用的知识库文档 ----

    sql`CREATE TABLE feasibility_report_reference_docs (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          document_id uuid NOT NULL,
          ${SORT_ORDER},
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, document_id),
          ${projectFkey('feasibility_report_reference_docs')},
          CONSTRAINT feasibility_report_reference_docs_document_fkey FOREIGN KEY (org_id, document_id)
            REFERENCES knowledge_documents (org_id, id) ON DELETE CASCADE
        )`,
    sql`CREATE INDEX feasibility_report_reference_docs_org_id_project_id_idx ON feasibility_report_reference_docs (org_id, project_id, sort_order)`,
    sql`CREATE INDEX feasibility_report_reference_docs_document_idx ON feasibility_report_reference_docs (org_id, document_id)`,
    ...policies('feasibility_report_reference_docs', {
      live: sql`${projectLive('feasibility_report_reference_docs')} AND ${REFERENCE_DOCUMENT_LIVE}`,
      commands: ['INSERT', 'DELETE'],
    }),
    // 整体替换：不授予 UPDATE。
    sql`GRANT SELECT, DELETE ON feasibility_report_reference_docs TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, document_id, sort_order) ON feasibility_report_reference_docs TO ${app}`,

    // ---- 报告目录与正文 ----

    sql`CREATE TABLE feasibility_report_outline_nodes (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          node_id text NOT NULL CHECK (char_length(node_id) BETWEEN 1 AND ${sql.lit(FEASIBILITY_NODE_ID_MAX)}),
          parent_node_id text,
          ${SORT_ORDER},
          level integer NOT NULL CHECK (level BETWEEN 1 AND ${sql.lit(FEASIBILITY_OUTLINE_DEPTH_MAX)}),
          title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${sql.lit(FEASIBILITY_TITLE_MAX)}),
          ${text('description', FEASIBILITY_TEXT_MAX)} DEFAULT '',
          knowledge_item_ids jsonb CHECK (jsonb_typeof(knowledge_item_ids) = 'array'
            AND octet_length(knowledge_item_ids::text) <= ${sql.lit(FEASIBILITY_KNOWLEDGE_IDS_MAX_BYTES)}),
          ${text('content', FEASIBILITY_CONTENT_MAX)} DEFAULT '',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, node_id),
          CONSTRAINT feasibility_report_outline_nodes_scope_key UNIQUE (org_id, project_id, node_id),
          CONSTRAINT feasibility_report_outline_nodes_parent_shape CHECK ((parent_node_id IS NULL) = (level = 1)),
          ${projectFkey('feasibility_report_outline_nodes')},
          CONSTRAINT feasibility_report_outline_nodes_parent_fkey FOREIGN KEY (org_id, project_id, parent_node_id)
            REFERENCES feasibility_report_outline_nodes (org_id, project_id, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
        )`,
    sql`CREATE INDEX feasibility_report_outline_nodes_org_id_project_id_idx
          ON feasibility_report_outline_nodes (org_id, project_id, level, parent_node_id, sort_order)`,
    touch('feasibility_report_outline_nodes'),
    ...policies('feasibility_report_outline_nodes', {
      live: projectLive('feasibility_report_outline_nodes'),
      commands: ['INSERT', 'UPDATE', 'DELETE'],
    }),
    sql`GRANT SELECT, DELETE ON feasibility_report_outline_nodes TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, node_id, parent_node_id, sort_order, level, title, description, knowledge_item_ids, content)
          ON feasibility_report_outline_nodes TO ${app}`,
    sql`GRANT UPDATE (content) ON feasibility_report_outline_nodes TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(
    db,
    [...FEASIBILITY_REPORT_TABLES].reverse().map((table) => sql`DROP TABLE ${sql.id(table)}`),
  );
}
