// 技术方案（一）（docs/SERVER_DESIGN.md 第 2.5 节；路线图第 5 步 5.11）：取代桌面版 SQLite 的 technical_plan_meta、
// technical_plan_generation_config、technical_plan_generation_bid_tasks、technical_plan_generation_reference_docs 和
// technical_plan_bid_items（technical_plan_tasks 不迁移，由第 6 步的 jobs 取代；目录、全局事实随 5.12，正文随 5.13）。
// 全部是项目级表，挂在 kind = 'technical-plan' 的项目下，取代桌面版的单例页面（id = 1）：
//
// - technical_plan_meta：每个项目一行，页面步骤、多标段识别结果（标段列表、识别状态与错误）和选中的投标范围；
// - technical_plan_documents：招标文件（tender）和原方案（original-plan）。桌面版存在 meta 的 tender_files_json 和
//   original_plan_* 列中（本地 Markdown 路径），这里与 rejection_check_documents 相同拆成表：原件是上传用途为 tender 的
//   文件，本表只记 file_id；解析出的 Markdown 是生成产物，记 markdown_artifact_id。新文档一律待解析（status 没有 INSERT
//   授权），解析由第 6 步的任务写入。桌面版合并的招标正文和按投标范围裁剪的工作副本不再存，读取时由各文件的 Markdown 现算；
// - technical_plan_generation_config：统一生成配置，每个项目一行。export_template_id 以单列外键指向导出模板（组织模板或
//   org_id 为空的系统模板，不能用复合外键），由策略保证只能引用当前组织可见的模板；
// - technical_plan_generation_bid_tasks：选中的招标解析项；
// - technical_plan_generation_reference_docs：引用的知识库文档，复合外键指向本组织的知识库文档；
// - technical_plan_bid_items：招标解析项的结果，由第 6 步的解析任务写入。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行，未设置上下文时什么都看不到；项目由复合外键 (org_id, project_id)
//   保证属于本组织（不级联到别的组织），org_id、project_id、file_id、document_id、item_id 写入后不能改；
// - 删除可见性：所属项目已删除（或不是技术方案项目）时六张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复；
//   条件写成“不存在同 id 的已删除或其他 kind 的项目”，跨组织的 project_id 仍由复合外键报错（与 artifacts 相同）；
// - 文档随原件的生命周期：原件已删除（进入回收站）、未上传完成或已不属于本项目时文档行不可见，恢复文件即一起恢复；
//   应用角色没有文档的 DELETE 授权，移除文档就是软删除原件。原件被清理任务物理删除时文档行由外键级联删除；
// - 只能登记本组织已上传、未删除、用途是 tender、且已挂到本项目（files.project_id）的文件（INSERT 策略）；
// - markdown_artifact_id 只能指向本组织已写完、种类为 markdown、来源文件就是该文档原件的产物（UPDATE 策略）；
// - 引用的知识库文档随文档的可见性：文档不可见（原件进回收站）时引用行同样不可见，也不能新引用；文档被删除时引用行由
//   外键级联删除（knowledge_documents 的策略在子查询中同样生效）；
// - 导出模板只能是当前组织的模板或系统模板（INSERT / UPDATE 策略，export_templates 的策略在子查询中同样生效）；
//   模板被删除（组织模板被用户删除、系统模板同步时下线）时只清空 export_template_id；
// - 选中的招标解析项、引用的知识库文档整体替换，不授予 UPDATE；页面状态、生成配置不能删除（清空时恢复默认值）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

export const TECHNICAL_PLAN_STEPS = [
  'document-analysis',
  'generation-settings',
  'bid-analysis',
  'outline-generation',
  'global-facts',
  'content-edit',
  'expand',
] as const;
export const TECHNICAL_PLAN_DOCUMENT_ROLES = ['tender', 'original-plan'] as const;
/** 文档的解析状态（第 6 步的解析任务写入）。 */
export const TECHNICAL_PLAN_DOCUMENT_STATUSES = ['pending', 'running', 'success', 'error'] as const;
/** 多标段识别与招标解析项的状态，与桌面版 Renderer 类型相同。 */
export const TECHNICAL_PLAN_RUN_STATUSES = ['idle', 'running', 'success', 'error'] as const;
export const TECHNICAL_PLAN_BID_ANALYSIS_MODES = ['key', 'full', 'custom'] as const;
export const TECHNICAL_PLAN_BID_SECTION_MODES = ['single', 'multiple'] as const;
export const TECHNICAL_PLAN_OUTLINE_MODES = ['response-file', 'standalone-technical', 'standalone-business'] as const;
export const TECHNICAL_PLAN_OUTLINE_EXPANSION_MODES = ['original-only', 'ai-complement'] as const;
export const TECHNICAL_PLAN_GLOBAL_FACTS_MODES = ['fabricate', 'omit', 'placeholder'] as const;
export const TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES = ['ai-only', 'document'] as const;
export const TECHNICAL_PLAN_TABLE_REQUIREMENTS = ['none', 'light', 'moderate', 'heavy'] as const;
/** 配图比例（百分比，与桌面版 Renderer 的 ContentImageQuantity 相同）。 */
export const TECHNICAL_PLAN_IMAGE_QUANTITIES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;
/** 招标解析项，顺序与桌面版 bidAnalysisTask.cjs 的任务列表相同（也是结果的排序）。 */
export const TECHNICAL_PLAN_BID_ITEM_IDS = [
  'projectOverview',
  'techRequirements',
  'projectInfo',
  'partAInfo',
  'deliveryAndServiceRequirements',
  'procurementList',
  'responseFileRequirements',
  'agentInfo',
  'keyInfo',
  'marginInfo',
  'qualificationReview',
  'complianceCheck',
  'openBid',
  'evaluationBid',
  'businessScoring',
  'discardedBids',
  'signingProcess',
  'terminationCondition',
] as const;

/** 错误信息、识别错误等文本的字数上限。 */
export const TECHNICAL_PLAN_TEXT_MAX = 20_000;
/** 正文哈希、标段 id 的字数上限。 */
export const TECHNICAL_PLAN_KEY_MAX = 200;
/** 解析器标签、解析项名称的字数上限。 */
export const TECHNICAL_PLAN_LABEL_MAX = 200;
/** 标段标题的字数上限。 */
export const TECHNICAL_PLAN_TITLE_MAX = 2000;
/** 招标解析项结果（Markdown 或 JSON 文本）的字数上限。 */
export const TECHNICAL_PLAN_BID_ITEM_CONTENT_MAX = 1_000_000;
/** 标段列表（jsonb 数组）的大小上限。 */
export const TECHNICAL_PLAN_BID_SECTIONS_MAX_BYTES = 1024 * 1024;
/** HTML 配图类型说明的字数上限。 */
export const TECHNICAL_PLAN_HTML_IMAGE_TYPES_MAX = 2000;
/** HTML 配图类型说明的默认值（与桌面版 defaultHtmlImageTypes 相同）。 */
export const TECHNICAL_PLAN_DEFAULT_HTML_IMAGE_TYPES =
  '甘特图、进度网络图、组织架构图、泳道图、RACI 职责矩阵、风险矩阵、系统架构与拓扑图、WBS 工作分解结构图、鱼骨图、柱状图、折线图、饼图';
/** 目录字数控制的上限。 */
export const TECHNICAL_PLAN_WORDS_MAX = 10_000_000;

/** 六张表，按依赖顺序（down 倒序删除）。 */
export const TECHNICAL_PLAN_TABLES = [
  'technical_plan_meta',
  'technical_plan_documents',
  'technical_plan_generation_config',
  'technical_plan_generation_bid_tasks',
  'technical_plan_generation_reference_docs',
  'technical_plan_bid_items',
] as const;

type Table = (typeof TECHNICAL_PLAN_TABLES)[number];

function list(values: readonly (string | number)[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

function text(column: string, max: number, nullable = false): RawBuilder<unknown> {
  return sql`${sql.id(column)} text ${nullable ? sql`` : sql`NOT NULL`} CHECK (char_length(${sql.id(column)}) <= ${sql.lit(max)})`;
}

function oneOf(column: string, values: readonly string[], fallback: string): RawBuilder<unknown> {
  return sql`${sql.id(column)} text NOT NULL DEFAULT ${sql.lit(fallback)} CHECK (${sql.id(column)} IN (${list(values)}))`;
}

function words(column: string): RawBuilder<unknown> {
  return sql`${sql.id(column)} integer NOT NULL DEFAULT 0 CHECK (${sql.id(column)} BETWEEN 0 AND ${sql.lit(TECHNICAL_PLAN_WORDS_MAX)})`;
}

const SORT_ORDER = sql`sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0)`;

function projectFkey(table: Table): RawBuilder<unknown> {
  return sql`CONSTRAINT ${sql.id(`${table}_project_fkey`)} FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE`;
}

const TENANT = sql`org_id = app_current_org_id()`;

/** 所属项目未删除、是技术方案项目（在应用角色的 RLS 下求值，只看得到本组织的项目；跨组织的 project_id 由外键报错）。 */
function projectLive(table: Table): RawBuilder<unknown> {
  return sql`NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${sql.id(table)}.project_id
    AND (p.deleted_at IS NOT NULL OR p.kind <> 'technical-plan'))`;
}

/** 原件已上传、未删除、仍挂在本项目下（files 的策略在子查询中同样生效）。 */
const DOCUMENT_FILE_LIVE = sql`EXISTS (SELECT 1 FROM files f WHERE f.id = technical_plan_documents.file_id
  AND f.status = 'uploaded' AND f.deleted_at IS NULL AND f.project_id = technical_plan_documents.project_id)`;
/** 新登记的文档另要求原件用途是 tender（招标文件、原方案、可研资料都用它）。 */
const DOCUMENT_FILE_ATTACHABLE = sql`EXISTS (SELECT 1 FROM files f WHERE f.id = technical_plan_documents.file_id
  AND f.status = 'uploaded' AND f.deleted_at IS NULL AND f.project_id = technical_plan_documents.project_id
  AND f.purpose = 'tender')`;
/** 解析出的 Markdown 必须是本文档原件的产物（artifacts 的策略在子查询中同样生效）。 */
const DOCUMENT_MARKDOWN_VALID = sql`(markdown_artifact_id IS NULL OR EXISTS (
  SELECT 1 FROM artifacts a WHERE a.id = technical_plan_documents.markdown_artifact_id AND a.kind = 'markdown' AND a.status = 'ready'
    AND a.source_file_id = technical_plan_documents.file_id))`;
/** 导出模板是当前组织的模板或系统模板（export_templates 的策略在子查询中同样生效）。 */
const TEMPLATE_VISIBLE = sql`(export_template_id IS NULL OR EXISTS (
  SELECT 1 FROM export_templates t WHERE t.id = technical_plan_generation_config.export_template_id))`;
/** 引用的知识库文档可见（knowledge_documents 的策略在子查询中同样生效：本组织、原件未删除）。 */
const REFERENCE_DOCUMENT_LIVE = sql`EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.id = technical_plan_generation_reference_docs.document_id)`;

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

    // 标段列表是多标段识别任务的结果（桌面版 bid_sections_json）；选中的投标范围只记 id 和标题，工作副本读取时现算。
    sql`CREATE TABLE technical_plan_meta (
          project_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          ${oneOf('step', TECHNICAL_PLAN_STEPS, 'document-analysis')},
          bid_sections jsonb CHECK (jsonb_typeof(bid_sections) = 'array'
            AND octet_length(bid_sections::text) <= ${sql.lit(TECHNICAL_PLAN_BID_SECTIONS_MAX_BYTES)}),
          ${oneOf('bid_section_extraction_status', TECHNICAL_PLAN_RUN_STATUSES, 'idle')},
          ${text('bid_section_extraction_error', TECHNICAL_PLAN_TEXT_MAX, true)},
          selected_section_id text CHECK (char_length(selected_section_id) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_KEY_MAX)}),
          ${text('selected_section_title', TECHNICAL_PLAN_TITLE_MAX, true)},
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          ${projectFkey('technical_plan_meta')}
        )`,
    sql`CREATE INDEX technical_plan_meta_org_id_project_id_idx ON technical_plan_meta (org_id, project_id)`,
    touch('technical_plan_meta'),
    ...policies('technical_plan_meta', { live: projectLive('technical_plan_meta'), commands: ['INSERT', 'UPDATE'] }),
    // 不授予 DELETE：清空时恢复默认值。
    sql`GRANT SELECT ON technical_plan_meta TO ${app}`,
    sql`GRANT INSERT (project_id, org_id, step, bid_sections, bid_section_extraction_status, bid_section_extraction_error,
          selected_section_id, selected_section_title) ON technical_plan_meta TO ${app}`,
    sql`GRANT UPDATE (step, bid_sections, bid_section_extraction_status, bid_section_extraction_error, selected_section_id,
          selected_section_title) ON technical_plan_meta TO ${app}`,

    // ---- 招标文件与原方案 ----

    // 每个文件只能登记一次（files.project_id 只有一个，同一文件不能既是招标文件又是原方案）。原方案每个项目只有一份由
    // Store 在项目锁内保证：替换时旧原件进回收站，行仍在表中（不可见），不能用唯一索引表达。
    // 产物被清理任务删除时只清空 markdown_artifact_id（PostgreSQL 15 起的列级 SET NULL）。
    sql`CREATE TABLE technical_plan_documents (
          file_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          role text NOT NULL CHECK (role IN (${list(TECHNICAL_PLAN_DOCUMENT_ROLES)})),
          ${SORT_ORDER},
          status text NOT NULL DEFAULT 'pending' CHECK (status IN (${list(TECHNICAL_PLAN_DOCUMENT_STATUSES)})),
          markdown_artifact_id uuid,
          content_chars integer NOT NULL DEFAULT 0 CHECK (content_chars >= 0),
          content_hash text CHECK (char_length(content_hash) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_KEY_MAX)}),
          ${text('parser_label', TECHNICAL_PLAN_LABEL_MAX, true)},
          ${text('error', TECHNICAL_PLAN_TEXT_MAX, true)},
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          ${projectFkey('technical_plan_documents')},
          CONSTRAINT technical_plan_documents_file_fkey FOREIGN KEY (org_id, file_id) REFERENCES files (org_id, id) ON DELETE CASCADE,
          CONSTRAINT technical_plan_documents_markdown_fkey FOREIGN KEY (org_id, markdown_artifact_id)
            REFERENCES artifacts (org_id, id) ON DELETE SET NULL (markdown_artifact_id)
        )`,
    sql`CREATE INDEX technical_plan_documents_org_id_project_id_idx ON technical_plan_documents (org_id, project_id, role, sort_order)`,
    sql`CREATE INDEX technical_plan_documents_markdown_idx ON technical_plan_documents (org_id, markdown_artifact_id)
          WHERE markdown_artifact_id IS NOT NULL`,
    touch('technical_plan_documents'),
    ...policies('technical_plan_documents', {
      live: sql`${projectLive('technical_plan_documents')} AND ${DOCUMENT_FILE_LIVE}`,
      insert: DOCUMENT_FILE_ATTACHABLE,
      update: DOCUMENT_MARKDOWN_VALID,
      commands: ['INSERT', 'UPDATE'],
    }),
    // 不授予 DELETE：移除文档就是软删除原件。status 等解析结果没有 INSERT 授权，新文档一律待解析；role、sort_order 写入后
    // 不能改（招标文件按导入顺序追加）。
    sql`GRANT SELECT ON technical_plan_documents TO ${app}`,
    sql`GRANT INSERT (file_id, org_id, project_id, role, sort_order) ON technical_plan_documents TO ${app}`,
    sql`GRANT UPDATE (status, markdown_artifact_id, content_chars, content_hash, parser_label, error) ON technical_plan_documents TO ${app}`,

    // ---- 统一生成配置 ----

    // 默认值与桌面版 createDefaultGenerationConfig 相同（outline_mode 取代码中的默认值，桌面版建表语句中的默认值不生效）；export_template_id 的默认值（系统模板“标准投标”）由 Store 写入。
    sql`CREATE TABLE technical_plan_generation_config (
          project_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          ${oneOf('bid_analysis_mode', TECHNICAL_PLAN_BID_ANALYSIS_MODES, 'key')},
          ${oneOf('bid_section_mode', TECHNICAL_PLAN_BID_SECTION_MODES, 'single')},
          ${oneOf('outline_mode', TECHNICAL_PLAN_OUTLINE_MODES, 'standalone-technical')},
          ${oneOf('outline_expansion_mode', TECHNICAL_PLAN_OUTLINE_EXPANSION_MODES, 'ai-complement')},
          ${words('minimum_words')},
          ${words('maximum_words')},
          ${words('section_words')},
          ${oneOf('global_facts_mode', TECHNICAL_PLAN_GLOBAL_FACTS_MODES, 'fabricate')},
          export_template_id uuid,
          ${oneOf('export_template_scope', TECHNICAL_PLAN_EXPORT_TEMPLATE_SCOPES, 'ai-only')},
          use_ai_images boolean NOT NULL DEFAULT true,
          use_mermaid_images boolean NOT NULL DEFAULT true,
          use_html_images boolean NOT NULL DEFAULT true,
          html_image_types text NOT NULL DEFAULT ${sql.lit(TECHNICAL_PLAN_DEFAULT_HTML_IMAGE_TYPES)}
            CHECK (char_length(html_image_types) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_HTML_IMAGE_TYPES_MAX)}),
          ${oneOf('table_requirement', TECHNICAL_PLAN_TABLE_REQUIREMENTS, 'heavy')},
          image_quantity integer NOT NULL DEFAULT 30 CHECK (image_quantity IN (${list(TECHNICAL_PLAN_IMAGE_QUANTITIES)})),
          html_image_optimization boolean NOT NULL DEFAULT false,
          word_count_repair boolean NOT NULL DEFAULT false,
          layout_check boolean NOT NULL DEFAULT false,
          use_single_image_layout boolean NOT NULL DEFAULT true,
          use_image_text_layout boolean NOT NULL DEFAULT true,
          use_three_images_layout boolean NOT NULL DEFAULT true,
          use_four_images_layout boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          ${projectFkey('technical_plan_generation_config')},
          CONSTRAINT technical_plan_generation_config_template_fkey FOREIGN KEY (export_template_id)
            REFERENCES export_templates (id) ON DELETE SET NULL
        )`,
    sql`CREATE INDEX technical_plan_generation_config_org_id_project_id_idx ON technical_plan_generation_config (org_id, project_id)`,
    sql`CREATE INDEX technical_plan_generation_config_template_idx ON technical_plan_generation_config (export_template_id)
          WHERE export_template_id IS NOT NULL`,
    touch('technical_plan_generation_config'),
    ...policies('technical_plan_generation_config', {
      live: projectLive('technical_plan_generation_config'),
      insert: TEMPLATE_VISIBLE,
      update: TEMPLATE_VISIBLE,
      commands: ['INSERT', 'UPDATE'],
    }),
    // 不授予 DELETE：清空时恢复默认值。
    sql`GRANT SELECT ON technical_plan_generation_config TO ${app}`,
    sql`GRANT INSERT (project_id, org_id, bid_analysis_mode, bid_section_mode, outline_mode, outline_expansion_mode, minimum_words,
          maximum_words, section_words, global_facts_mode, export_template_id, export_template_scope, use_ai_images, use_mermaid_images,
          use_html_images, html_image_types, table_requirement, image_quantity, html_image_optimization, word_count_repair, layout_check,
          use_single_image_layout, use_image_text_layout, use_three_images_layout, use_four_images_layout)
          ON technical_plan_generation_config TO ${app}`,
    sql`GRANT UPDATE (bid_analysis_mode, bid_section_mode, outline_mode, outline_expansion_mode, minimum_words, maximum_words,
          section_words, global_facts_mode, export_template_id, export_template_scope, use_ai_images, use_mermaid_images, use_html_images,
          html_image_types, table_requirement, image_quantity, html_image_optimization, word_count_repair, layout_check,
          use_single_image_layout, use_image_text_layout, use_three_images_layout, use_four_images_layout)
          ON technical_plan_generation_config TO ${app}`,

    // ---- 选中的招标解析项 ----

    sql`CREATE TABLE technical_plan_generation_bid_tasks (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          task_id text NOT NULL CHECK (task_id IN (${list(TECHNICAL_PLAN_BID_ITEM_IDS)})),
          ${SORT_ORDER},
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, task_id),
          ${projectFkey('technical_plan_generation_bid_tasks')}
        )`,
    sql`CREATE INDEX technical_plan_generation_bid_tasks_org_id_project_id_idx ON technical_plan_generation_bid_tasks (org_id, project_id, sort_order)`,
    ...policies('technical_plan_generation_bid_tasks', {
      live: projectLive('technical_plan_generation_bid_tasks'),
      commands: ['INSERT', 'DELETE'],
    }),
    // 整体替换：不授予 UPDATE。
    sql`GRANT SELECT, DELETE ON technical_plan_generation_bid_tasks TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, task_id, sort_order) ON technical_plan_generation_bid_tasks TO ${app}`,

    // ---- 引用的知识库文档 ----

    sql`CREATE TABLE technical_plan_generation_reference_docs (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          document_id uuid NOT NULL,
          ${SORT_ORDER},
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, document_id),
          ${projectFkey('technical_plan_generation_reference_docs')},
          CONSTRAINT technical_plan_generation_reference_docs_document_fkey FOREIGN KEY (org_id, document_id)
            REFERENCES knowledge_documents (org_id, id) ON DELETE CASCADE
        )`,
    sql`CREATE INDEX technical_plan_generation_reference_docs_org_id_project_id_idx
          ON technical_plan_generation_reference_docs (org_id, project_id, sort_order)`,
    sql`CREATE INDEX technical_plan_generation_reference_docs_document_idx ON technical_plan_generation_reference_docs (org_id, document_id)`,
    ...policies('technical_plan_generation_reference_docs', {
      live: sql`${projectLive('technical_plan_generation_reference_docs')} AND ${REFERENCE_DOCUMENT_LIVE}`,
      commands: ['INSERT', 'DELETE'],
    }),
    // 整体替换：不授予 UPDATE。
    sql`GRANT SELECT, DELETE ON technical_plan_generation_reference_docs TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, document_id, sort_order) ON technical_plan_generation_reference_docs TO ${app}`,

    // ---- 招标解析项的结果 ----

    sql`CREATE TABLE technical_plan_bid_items (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          item_id text NOT NULL CHECK (item_id IN (${list(TECHNICAL_PLAN_BID_ITEM_IDS)})),
          label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND ${sql.lit(TECHNICAL_PLAN_LABEL_MAX)}),
          ${oneOf('status', TECHNICAL_PLAN_RUN_STATUSES, 'idle')},
          ${text('content', TECHNICAL_PLAN_BID_ITEM_CONTENT_MAX)} DEFAULT '',
          ${text('error', TECHNICAL_PLAN_TEXT_MAX, true)},
          ${SORT_ORDER},
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, item_id),
          ${projectFkey('technical_plan_bid_items')}
        )`,
    sql`CREATE INDEX technical_plan_bid_items_org_id_project_id_idx ON technical_plan_bid_items (org_id, project_id, sort_order)`,
    touch('technical_plan_bid_items'),
    ...policies('technical_plan_bid_items', { live: projectLive('technical_plan_bid_items'), commands: ['INSERT', 'UPDATE', 'DELETE'] }),
    sql`GRANT SELECT, DELETE ON technical_plan_bid_items TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, item_id, label, status, content, error, sort_order) ON technical_plan_bid_items TO ${app}`,
    sql`GRANT UPDATE (label, status, content, error, sort_order) ON technical_plan_bid_items TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(
    db,
    [...TECHNICAL_PLAN_TABLES].reverse().map((table) => sql`DROP TABLE ${sql.id(table)}`),
  );
}
