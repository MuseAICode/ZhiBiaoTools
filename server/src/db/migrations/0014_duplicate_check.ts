// 标书查重（docs/SERVER_DESIGN.md 第 2.5 节；路线图第 5 步 5.8）：取代桌面版 SQLite 的 duplicate_check_* 十三张表
// （duplicate_check_tasks 不迁移，由第 6 步的 jobs 取代）。全部是项目级表，挂在 kind = 'duplicate-check' 的项目下，
// 取代桌面版的单例页面（id = 1）：
//
// - duplicate_check_meta：每个项目一行，页面步骤和当前分析页签（文件选择的签名按可见的文件现算，不存）；
// - duplicate_check_files：选中的招标文件（tender）和投标文件（bid）。原件是上传用途为 duplicate-check 的文件，
//   本表只记 file_id，取代桌面版的 file_path；文件名、扩展名、大小取 files；
// - duplicate_check_analysis_sections：元数据、目录、正文、图片四类分析的状态与统计；
// - 其余十张表是四类分析的结果，由第 6 步的查重任务整体替换写入：正文提取（content_files，Markdown 是生成产物，
//   记 content_artifact_id，取代 content_path）、元数据项、目录项、目录重复 / 相似组、目录两两相似度、重复句及其出现次数、
//   单文件图片统计、重复图片（预览图是生成产物，记 preview_artifact_id，取代 preview_url）及其出现次数和位置。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行，未设置上下文时什么都看不到；项目由复合外键 (org_id, project_id)
//   保证属于本组织（不级联到别的组织），org_id、project_id、file_id 写入后不能改；
// - 删除可见性：所属项目已删除（或不是查重项目）时十三张表的行查不到、改不了、删不掉，也不能新写，恢复项目即一起恢复；
//   条件写成“不存在同 id 的已删除或其他 kind 的项目”，跨组织的 project_id 仍由复合外键报错（与 artifacts 相同）；
// - 选中的文件随原件的生命周期：原件已删除（进入回收站）、未上传完成或已不属于本项目时，文件行和引用它的分析结果
//   （正文提取、元数据项、目录项、两两相似度、重复句与重复图片的出现次数、单文件图片统计）都不可见，恢复文件即一起恢复；
//   files 的策略在子查询中同样生效。原件被清理任务物理删除时，文件行及其分析结果由外键级联删除；
// - 只能选本组织已上传、未删除、用途是 duplicate-check、且已挂到本项目（files.project_id）的文件（INSERT 策略）；
// - content_artifact_id 只能指向本组织已写完、种类为 markdown、来源文件就是该文件的产物；preview_artifact_id 只能指向
//   本组织已写完、种类为 image、属于本项目的产物（INSERT 策略）；
// - 写法与桌面版相同“整体替换”：分析结果只授予 INSERT 和 DELETE，不授予 UPDATE；页面状态和分析状态按字段更新，
//   页面状态不能删除（清空时恢复默认值）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

export const DUPLICATE_CHECK_STEPS = ['upload', 'analysis'] as const;
/** 四类分析，同时是分析页签的取值。 */
export const DUPLICATE_CHECK_SECTIONS = ['metadata', 'outline', 'content', 'image'] as const;
export const DUPLICATE_CHECK_STATUSES = ['pending', 'running', 'success', 'error'] as const;
export const DUPLICATE_CHECK_FILE_ROLES = ['tender', 'bid'] as const;
export const DUPLICATE_CHECK_OUTLINE_SOURCES = ['catalog', 'heading', 'semantic'] as const;
export const DUPLICATE_CHECK_GROUP_TYPES = ['duplicate', 'similar'] as const;
export const DUPLICATE_CHECK_RISKS = ['high', 'medium', 'low', 'none'] as const;

/** 业务 id（目录项、目录组、重复句、重复图片的 id）、元数据键、签名、哈希等短文本的字数上限。 */
export const DUPLICATE_CHECK_KEY_MAX = 200;
/** 进度说明、标题、元数据项名称的字数上限。 */
export const DUPLICATE_CHECK_TITLE_MAX = 2000;
/** 错误信息、元数据值、目录路径、招标原句的字数上限。 */
export const DUPLICATE_CHECK_TEXT_MAX = 20_000;
/** 重复句原文与归一化文本的字数上限。 */
export const DUPLICATE_CHECK_SENTENCE_MAX = 100_000;
/** 解析器标签的字数上限。 */
export const DUPLICATE_CHECK_PARSER_LABEL_MAX = 200;
/** 统计、目录组的文件与路径、图片位置（jsonb）序列化后的字节数上限。 */
export const DUPLICATE_CHECK_JSON_MAX_BYTES = 16 * 1024 * 1024;
/** 目录项的标题路径（jsonb 数组）序列化后的字节数上限。 */
export const DUPLICATE_CHECK_PATH_MAX_BYTES = 64 * 1024;
/** 相似度、置信度的上限（正常不超过 1，留出余量；同时挡住 NaN 和 Infinity）。 */
export const DUPLICATE_CHECK_SCORE_MAX = 1000;
/** 目录层级上限。 */
export const DUPLICATE_CHECK_LEVEL_MAX = 100;

/** 十三张表，按依赖顺序（down 倒序删除）。 */
export const DUPLICATE_CHECK_TABLES = [
  'duplicate_check_meta',
  'duplicate_check_files',
  'duplicate_check_analysis_sections',
  'duplicate_check_content_files',
  'duplicate_check_metadata_items',
  'duplicate_check_outline_items',
  'duplicate_check_outline_groups',
  'duplicate_check_outline_pairwise',
  'duplicate_check_content_duplicates',
  'duplicate_check_content_occurrences',
  'duplicate_check_image_files',
  'duplicate_check_duplicate_images',
  'duplicate_check_image_occurrences',
] as const;

type Table = (typeof DUPLICATE_CHECK_TABLES)[number];

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

function text(column: string, max: number, nullable = false): RawBuilder<unknown> {
  return sql`${sql.id(column)} text ${nullable ? sql`` : sql`NOT NULL`} CHECK (char_length(${sql.id(column)}) <= ${sql.lit(max)})`;
}

function key(column: string): RawBuilder<unknown> {
  return sql`${sql.id(column)} text NOT NULL CHECK (char_length(${sql.id(column)}) BETWEEN 1 AND ${sql.lit(DUPLICATE_CHECK_KEY_MAX)})`;
}

function json(column: string, type: 'array' | 'object', max: number, nullable = false): RawBuilder<unknown> {
  const c = sql.id(column);
  const empty = sql.lit(type === 'array' ? '[]' : '{}');
  return sql`${c} jsonb ${nullable ? sql`` : sql`NOT NULL DEFAULT ${empty}::jsonb`}
    CHECK (jsonb_typeof(${c}) = ${sql.lit(type)} AND octet_length(${c}::text) <= ${sql.lit(max)})`;
}

/** BETWEEN 同时挡住 NaN 和 Infinity（PostgreSQL 中 NaN 大于任何数）。 */
function score(column: string): RawBuilder<unknown> {
  return sql`${sql.id(column)} double precision NOT NULL DEFAULT 0 CHECK (${sql.id(column)} BETWEEN 0 AND ${sql.lit(DUPLICATE_CHECK_SCORE_MAX)})`;
}

function count(column: string): RawBuilder<unknown> {
  return sql`${sql.id(column)} integer NOT NULL DEFAULT 0 CHECK (${sql.id(column)} >= 0)`;
}

const SORT_ORDER = sql`sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0)`;

function projectFkey(table: Table): RawBuilder<unknown> {
  return sql`CONSTRAINT ${sql.id(`${table}_project_fkey`)} FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE`;
}

/** 分析结果对选中文件的引用：随文件行删除（重新选择文件、清理任务删除原件时）。 */
function fileFkey(table: Table, column = 'file_id'): RawBuilder<unknown> {
  return sql`CONSTRAINT ${sql.id(`${table}_${column}_fkey`)} FOREIGN KEY (org_id, project_id, ${sql.id(column)})
    REFERENCES duplicate_check_files (org_id, project_id, file_id) ON DELETE CASCADE`;
}

const TENANT = sql`org_id = app_current_org_id()`;

/** 所属项目未删除、是查重项目（在应用角色的 RLS 下求值，只看得到本组织的项目；跨组织的 project_id 由外键报错）。 */
function projectLive(table: Table): RawBuilder<unknown> {
  return sql`NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${sql.id(table)}.project_id
    AND (p.deleted_at IS NOT NULL OR p.kind <> 'duplicate-check'))`;
}

/** 原件已上传、未删除、仍挂在本项目下（files 的策略在子查询中同样生效）。 */
const SELECTED_FILE_LIVE = sql`EXISTS (SELECT 1 FROM files f WHERE f.id = duplicate_check_files.file_id
  AND f.status = 'uploaded' AND f.deleted_at IS NULL AND f.project_id = duplicate_check_files.project_id)`;
/** 新选的文件另要求用途是标书查重。 */
const SELECTED_FILE_ATTACHABLE = sql`EXISTS (SELECT 1 FROM files f WHERE f.id = duplicate_check_files.file_id
  AND f.status = 'uploaded' AND f.deleted_at IS NULL AND f.project_id = duplicate_check_files.project_id
  AND f.purpose = 'duplicate-check')`;

/** 行引用的选中文件可见（duplicate_check_files 的策略在子查询中同样生效：项目、原件都要可用）。 */
function fileLive(table: Table, column = 'file_id'): RawBuilder<unknown> {
  return sql`EXISTS (SELECT 1 FROM duplicate_check_files d WHERE d.project_id = ${sql.id(table)}.project_id
    AND d.file_id = ${sql.id(table)}.${sql.id(column)})`;
}

const CONTENT_ARTIFACT_VALID = sql`(content_artifact_id IS NULL OR EXISTS (
  SELECT 1 FROM artifacts a WHERE a.id = duplicate_check_content_files.content_artifact_id AND a.kind = 'markdown' AND a.status = 'ready'
    AND a.source_file_id = duplicate_check_content_files.file_id))`;
const PREVIEW_ARTIFACT_VALID = sql`(preview_artifact_id IS NULL OR EXISTS (
  SELECT 1 FROM artifacts a WHERE a.id = duplicate_check_duplicate_images.preview_artifact_id AND a.kind = 'image' AND a.status = 'ready'
    AND a.project_id = duplicate_check_duplicate_images.project_id))`;

interface PolicySpec {
  /** 行可见的条件（SELECT、UPDATE、DELETE 的 USING，INSERT 的 WITH CHECK）。 */
  live: RawBuilder<unknown>;
  /** INSERT 另加的条件。 */
  insert?: RawBuilder<unknown>;
  commands: readonly ('INSERT' | 'UPDATE' | 'DELETE')[];
}

function policies(table: Table, spec: PolicySpec): RawBuilder<unknown>[] {
  const t = sql.id(table);
  const insertCheck = spec.insert ? sql`${TENANT} AND ${spec.live} AND ${spec.insert}` : sql`${TENANT} AND ${spec.live}`;
  return [
    sql`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY ${sql.id(`${table}_select_tenant`)} ON ${t} FOR SELECT TO ${app} USING (${TENANT} AND ${spec.live})`,
    ...(spec.commands.includes('INSERT')
      ? [sql`CREATE POLICY ${sql.id(`${table}_insert_tenant`)} ON ${t} FOR INSERT TO ${app} WITH CHECK (${insertCheck})`]
      : []),
    ...(spec.commands.includes('UPDATE')
      ? [sql`CREATE POLICY ${sql.id(`${table}_update_tenant`)} ON ${t} FOR UPDATE TO ${app} USING (${TENANT} AND ${spec.live}) WITH CHECK (${TENANT})`]
      : []),
    ...(spec.commands.includes('DELETE')
      ? [sql`CREATE POLICY ${sql.id(`${table}_delete_tenant`)} ON ${t} FOR DELETE TO ${app} USING (${TENANT} AND ${spec.live})`]
      : []),
  ];
}

function columns(names: readonly string[]): RawBuilder<unknown> {
  return sql.join(names.map((name) => sql.id(name)));
}

/** 整体替换的结果表：SELECT、DELETE 和列级 INSERT，不授予 UPDATE。 */
function replaceGrants(table: Table, insertColumns: readonly string[]): RawBuilder<unknown>[] {
  const t = sql.id(table);
  return [sql`GRANT SELECT, DELETE ON ${t} TO ${app}`, sql`GRANT INSERT (${columns(insertColumns)}) ON ${t} TO ${app}`];
}

function touch(table: Table): RawBuilder<unknown> {
  return sql`CREATE TRIGGER ${sql.id(`${table}_touch`)} BEFORE UPDATE ON ${sql.id(table)} FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // ---- 页面状态与文件选择 ----

    sql`CREATE TABLE duplicate_check_meta (
          project_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          step text NOT NULL DEFAULT 'upload' CHECK (step IN (${list(DUPLICATE_CHECK_STEPS)})),
          active_analysis_tab text NOT NULL DEFAULT 'metadata' CHECK (active_analysis_tab IN (${list(DUPLICATE_CHECK_SECTIONS)})),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          ${projectFkey('duplicate_check_meta')}
        )`,
    sql`CREATE INDEX duplicate_check_meta_org_id_project_id_idx ON duplicate_check_meta (org_id, project_id)`,
    touch('duplicate_check_meta'),
    ...policies('duplicate_check_meta', { live: projectLive('duplicate_check_meta'), commands: ['INSERT', 'UPDATE'] }),
    // 不授予 DELETE：清空时恢复默认值。
    sql`GRANT SELECT ON duplicate_check_meta TO ${app}`,
    sql`GRANT INSERT (project_id, org_id, step, active_analysis_tab) ON duplicate_check_meta TO ${app}`,
    sql`GRANT UPDATE (step, active_analysis_tab) ON duplicate_check_meta TO ${app}`,

    // 每个文件只能被选一次（同一文件不能既是招标文件又是投标文件，也不能挂到两个项目，files.project_id 只有一个）。
    // 原件被清理任务物理删除时行级联删除（行本身不引用对象存储，没有孤儿对象）。
    sql`CREATE TABLE duplicate_check_files (
          file_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          role text NOT NULL CHECK (role IN (${list(DUPLICATE_CHECK_FILE_ROLES)})),
          ${SORT_ORDER},
          content_hash text CHECK (char_length(content_hash) BETWEEN 1 AND ${sql.lit(DUPLICATE_CHECK_KEY_MAX)}),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT duplicate_check_files_scope_key UNIQUE (org_id, project_id, file_id),
          ${projectFkey('duplicate_check_files')},
          CONSTRAINT duplicate_check_files_file_fkey FOREIGN KEY (org_id, file_id) REFERENCES files (org_id, id) ON DELETE CASCADE
        )`,
    sql`CREATE INDEX duplicate_check_files_org_id_project_id_idx ON duplicate_check_files (org_id, project_id, role, sort_order)`,
    touch('duplicate_check_files'),
    ...policies('duplicate_check_files', {
      live: sql`${projectLive('duplicate_check_files')} AND ${SELECTED_FILE_LIVE}`,
      insert: SELECTED_FILE_ATTACHABLE,
      commands: ['INSERT', 'UPDATE', 'DELETE'],
    }),
    sql`GRANT SELECT, DELETE ON duplicate_check_files TO ${app}`,
    sql`GRANT INSERT (file_id, org_id, project_id, role, sort_order) ON duplicate_check_files TO ${app}`,
    sql`GRANT UPDATE (content_hash) ON duplicate_check_files TO ${app}`,

    // ---- 分析状态 ----

    // stats 是各类分析的统计（子任务进度、日志、每个文件的状态摘要等），由任务按字段合并写入。
    sql`CREATE TABLE duplicate_check_analysis_sections (
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          section text NOT NULL CHECK (section IN (${list(DUPLICATE_CHECK_SECTIONS)})),
          status text NOT NULL DEFAULT 'pending' CHECK (status IN (${list(DUPLICATE_CHECK_STATUSES)})),
          progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
          ${text('message', DUPLICATE_CHECK_TITLE_MAX)} DEFAULT '',
          signature text CHECK (char_length(signature) BETWEEN 1 AND ${sql.lit(DUPLICATE_CHECK_KEY_MAX)}),
          ${json('stats', 'object', DUPLICATE_CHECK_JSON_MAX_BYTES)},
          started_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, section),
          ${projectFkey('duplicate_check_analysis_sections')}
        )`,
    sql`CREATE INDEX duplicate_check_analysis_sections_org_id_project_id_idx ON duplicate_check_analysis_sections (org_id, project_id)`,
    touch('duplicate_check_analysis_sections'),
    ...policies('duplicate_check_analysis_sections', {
      live: projectLive('duplicate_check_analysis_sections'),
      commands: ['INSERT', 'UPDATE', 'DELETE'],
    }),
    sql`GRANT SELECT, DELETE ON duplicate_check_analysis_sections TO ${app}`,
    sql`GRANT INSERT (org_id, project_id, section, status, progress, message, signature, stats, started_at)
          ON duplicate_check_analysis_sections TO ${app}`,
    sql`GRANT UPDATE (status, progress, message, signature, stats, started_at) ON duplicate_check_analysis_sections TO ${app}`,

    // ---- 元数据分析 ----

    // 产物被清理任务删除时只清空 content_artifact_id（PostgreSQL 15 起的列级 SET NULL）。
    sql`CREATE TABLE duplicate_check_content_files (
          file_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          status text NOT NULL DEFAULT 'pending' CHECK (status IN (${list(DUPLICATE_CHECK_STATUSES)})),
          content_artifact_id uuid,
          ${count('content_length')},
          ${text('parser_label', DUPLICATE_CHECK_PARSER_LABEL_MAX, true)},
          ${text('error', DUPLICATE_CHECK_TEXT_MAX, true)},
          updated_at timestamptz NOT NULL DEFAULT now(),
          ${projectFkey('duplicate_check_content_files')},
          ${fileFkey('duplicate_check_content_files')},
          CONSTRAINT duplicate_check_content_files_artifact_fkey FOREIGN KEY (org_id, content_artifact_id)
            REFERENCES artifacts (org_id, id) ON DELETE SET NULL (content_artifact_id)
        )`,
    sql`CREATE INDEX duplicate_check_content_files_org_id_project_id_idx ON duplicate_check_content_files (org_id, project_id)`,
    sql`CREATE INDEX duplicate_check_content_files_artifact_idx ON duplicate_check_content_files (org_id, content_artifact_id)
          WHERE content_artifact_id IS NOT NULL`,
    ...policies('duplicate_check_content_files', {
      live: fileLive('duplicate_check_content_files'),
      insert: CONTENT_ARTIFACT_VALID,
      commands: ['INSERT', 'DELETE'],
    }),
    ...replaceGrants('duplicate_check_content_files', [
      'file_id',
      'org_id',
      'project_id',
      'status',
      'content_artifact_id',
      'content_length',
      'parser_label',
      'error',
    ]),

    sql`CREATE TABLE duplicate_check_metadata_items (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          file_id uuid NOT NULL,
          ${key('key')},
          ${text('label', DUPLICATE_CHECK_TITLE_MAX)},
          ${text('value', DUPLICATE_CHECK_TEXT_MAX)} DEFAULT '',
          ${text('normalized', DUPLICATE_CHECK_TEXT_MAX, true)},
          date_day text CHECK (char_length(date_day) BETWEEN 1 AND 32),
          comparable boolean NOT NULL DEFAULT false,
          date_comparable boolean NOT NULL DEFAULT false,
          ${SORT_ORDER},
          CONSTRAINT duplicate_check_metadata_items_key_key UNIQUE (project_id, file_id, key),
          ${projectFkey('duplicate_check_metadata_items')},
          ${fileFkey('duplicate_check_metadata_items')}
        )`,
    sql`CREATE INDEX duplicate_check_metadata_items_org_id_project_id_idx ON duplicate_check_metadata_items (org_id, project_id, file_id, sort_order)`,
    ...policies('duplicate_check_metadata_items', { live: fileLive('duplicate_check_metadata_items'), commands: ['INSERT', 'DELETE'] }),
    ...replaceGrants('duplicate_check_metadata_items', [
      'org_id',
      'project_id',
      'file_id',
      'key',
      'label',
      'value',
      'normalized',
      'date_day',
      'comparable',
      'date_comparable',
      'sort_order',
    ]),

    // ---- 目录分析 ----

    // item_id 只在单个文件内唯一（桌面版落库时拼成 file_id::item_id，这里由 (project_id, file_id, item_id) 唯一表示）。
    // 父目录项由复合外键指向同一文件的目录项，延迟到事务结束检查：同一次整体替换中子项可以先于父项写入。
    sql`CREATE TABLE duplicate_check_outline_items (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          file_id uuid NOT NULL,
          ${key('item_id')},
          parent_item_id text,
          level integer NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND ${sql.lit(DUPLICATE_CHECK_LEVEL_MAX)}),
          number text CHECK (char_length(number) BETWEEN 1 AND ${sql.lit(DUPLICATE_CHECK_KEY_MAX)}),
          ${text('title', DUPLICATE_CHECK_TITLE_MAX)},
          ${text('normalized_title', DUPLICATE_CHECK_TITLE_MAX)},
          ${json('path_titles', 'array', DUPLICATE_CHECK_PATH_MAX_BYTES)},
          ${text('normalized_path', DUPLICATE_CHECK_TEXT_MAX)},
          source text NOT NULL CHECK (source IN (${list(DUPLICATE_CHECK_OUTLINE_SOURCES)})),
          ${score('confidence')},
          ${SORT_ORDER},
          from_tender boolean NOT NULL DEFAULT false,
          ${text('matched_tender_sentence', DUPLICATE_CHECK_TEXT_MAX, true)},
          CONSTRAINT duplicate_check_outline_items_item_key UNIQUE (org_id, project_id, file_id, item_id),
          CONSTRAINT duplicate_check_outline_items_parent_fkey FOREIGN KEY (org_id, project_id, file_id, parent_item_id)
            REFERENCES duplicate_check_outline_items (org_id, project_id, file_id, item_id) ON DELETE CASCADE
            DEFERRABLE INITIALLY DEFERRED,
          ${projectFkey('duplicate_check_outline_items')},
          ${fileFkey('duplicate_check_outline_items')}
        )`,
    sql`CREATE INDEX duplicate_check_outline_items_org_id_project_id_idx ON duplicate_check_outline_items (org_id, project_id, file_id, sort_order)`,
    ...policies('duplicate_check_outline_items', { live: fileLive('duplicate_check_outline_items'), commands: ['INSERT', 'DELETE'] }),
    ...replaceGrants('duplicate_check_outline_items', [
      'org_id',
      'project_id',
      'file_id',
      'item_id',
      'parent_item_id',
      'level',
      'number',
      'title',
      'normalized_title',
      'path_titles',
      'normalized_path',
      'source',
      'confidence',
      'sort_order',
      'from_tender',
      'matched_tender_sentence',
    ]),

    // file_ids 是涉及的文件 id，item_ids / paths 是按文件 id 分组的目录项 id 和路径（与桌面版相同，不设外键）。
    sql`CREATE TABLE duplicate_check_outline_groups (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          ${key('group_id')},
          type text NOT NULL CHECK (type IN (${list(DUPLICATE_CHECK_GROUP_TYPES)})),
          ${text('title', DUPLICATE_CHECK_TITLE_MAX)},
          ${score('score')},
          ${json('file_ids', 'array', DUPLICATE_CHECK_JSON_MAX_BYTES)},
          ${json('item_ids', 'object', DUPLICATE_CHECK_JSON_MAX_BYTES)},
          ${json('paths', 'object', DUPLICATE_CHECK_JSON_MAX_BYTES)},
          ${SORT_ORDER},
          CONSTRAINT duplicate_check_outline_groups_group_key UNIQUE (project_id, group_id),
          ${projectFkey('duplicate_check_outline_groups')}
        )`,
    sql`CREATE INDEX duplicate_check_outline_groups_org_id_project_id_idx ON duplicate_check_outline_groups (org_id, project_id, sort_order)`,
    ...policies('duplicate_check_outline_groups', { live: projectLive('duplicate_check_outline_groups'), commands: ['INSERT', 'DELETE'] }),
    ...replaceGrants('duplicate_check_outline_groups', [
      'org_id',
      'project_id',
      'group_id',
      'type',
      'title',
      'score',
      'file_ids',
      'item_ids',
      'paths',
      'sort_order',
    ]),

    sql`CREATE TABLE duplicate_check_outline_pairwise (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          file_a_id uuid NOT NULL,
          file_b_id uuid NOT NULL,
          ${score('score')},
          ${score('title_overlap')},
          ${score('path_overlap')},
          ${score('order_similarity')},
          ${count('shared_count')},
          risk text NOT NULL DEFAULT 'none' CHECK (risk IN (${list(DUPLICATE_CHECK_RISKS)})),
          ${SORT_ORDER},
          CONSTRAINT duplicate_check_outline_pairwise_pair_key UNIQUE (project_id, file_a_id, file_b_id),
          ${projectFkey('duplicate_check_outline_pairwise')},
          ${fileFkey('duplicate_check_outline_pairwise', 'file_a_id')},
          ${fileFkey('duplicate_check_outline_pairwise', 'file_b_id')}
        )`,
    sql`CREATE INDEX duplicate_check_outline_pairwise_org_id_project_id_idx ON duplicate_check_outline_pairwise (org_id, project_id, score DESC)`,
    ...policies('duplicate_check_outline_pairwise', {
      live: sql`${fileLive('duplicate_check_outline_pairwise', 'file_a_id')} AND ${fileLive('duplicate_check_outline_pairwise', 'file_b_id')}`,
      commands: ['INSERT', 'DELETE'],
    }),
    ...replaceGrants('duplicate_check_outline_pairwise', [
      'org_id',
      'project_id',
      'file_a_id',
      'file_b_id',
      'score',
      'title_overlap',
      'path_overlap',
      'order_similarity',
      'shared_count',
      'risk',
      'sort_order',
    ]),

    // ---- 正文分析 ----

    sql`CREATE TABLE duplicate_check_content_duplicates (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          ${key('duplicate_id')},
          ${text('sentence', DUPLICATE_CHECK_SENTENCE_MAX)},
          ${text('normalized', DUPLICATE_CHECK_SENTENCE_MAX)},
          ${json('file_ids', 'array', DUPLICATE_CHECK_JSON_MAX_BYTES)},
          first_order integer NOT NULL DEFAULT 0 CHECK (first_order >= 0),
          CONSTRAINT duplicate_check_content_duplicates_duplicate_key UNIQUE (org_id, project_id, duplicate_id),
          ${projectFkey('duplicate_check_content_duplicates')}
        )`,
    sql`CREATE INDEX duplicate_check_content_duplicates_org_id_project_id_idx ON duplicate_check_content_duplicates (org_id, project_id, first_order)`,
    ...policies('duplicate_check_content_duplicates', { live: projectLive('duplicate_check_content_duplicates'), commands: ['INSERT', 'DELETE'] }),
    ...replaceGrants('duplicate_check_content_duplicates', ['org_id', 'project_id', 'duplicate_id', 'sentence', 'normalized', 'file_ids', 'first_order']),

    sql`CREATE TABLE duplicate_check_content_occurrences (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          duplicate_id text NOT NULL,
          file_id uuid NOT NULL,
          ${count('occurrence_count')},
          CONSTRAINT duplicate_check_content_occurrences_key UNIQUE (project_id, duplicate_id, file_id),
          CONSTRAINT duplicate_check_content_occurrences_duplicate_fkey FOREIGN KEY (org_id, project_id, duplicate_id)
            REFERENCES duplicate_check_content_duplicates (org_id, project_id, duplicate_id) ON DELETE CASCADE,
          ${projectFkey('duplicate_check_content_occurrences')},
          ${fileFkey('duplicate_check_content_occurrences')}
        )`,
    sql`CREATE INDEX duplicate_check_content_occurrences_org_id_project_id_idx ON duplicate_check_content_occurrences (org_id, project_id, duplicate_id)`,
    ...policies('duplicate_check_content_occurrences', { live: fileLive('duplicate_check_content_occurrences'), commands: ['INSERT', 'DELETE'] }),
    ...replaceGrants('duplicate_check_content_occurrences', ['org_id', 'project_id', 'duplicate_id', 'file_id', 'occurrence_count']),

    // ---- 图片分析 ----

    sql`CREATE TABLE duplicate_check_image_files (
          file_id uuid PRIMARY KEY,
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          status text NOT NULL DEFAULT 'pending' CHECK (status IN (${list(DUPLICATE_CHECK_STATUSES)})),
          ${count('image_count')},
          ${count('unique_image_count')},
          ${text('error', DUPLICATE_CHECK_TEXT_MAX, true)},
          updated_at timestamptz NOT NULL DEFAULT now(),
          ${projectFkey('duplicate_check_image_files')},
          ${fileFkey('duplicate_check_image_files')}
        )`,
    sql`CREATE INDEX duplicate_check_image_files_org_id_project_id_idx ON duplicate_check_image_files (org_id, project_id)`,
    ...policies('duplicate_check_image_files', { live: fileLive('duplicate_check_image_files'), commands: ['INSERT', 'DELETE'] }),
    ...replaceGrants('duplicate_check_image_files', ['file_id', 'org_id', 'project_id', 'status', 'image_count', 'unique_image_count', 'error']),

    sql`CREATE TABLE duplicate_check_duplicate_images (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          ${key('image_id')},
          ${key('hash')},
          preview_artifact_id uuid,
          ${json('file_ids', 'array', DUPLICATE_CHECK_JSON_MAX_BYTES)},
          ${SORT_ORDER},
          CONSTRAINT duplicate_check_duplicate_images_image_key UNIQUE (org_id, project_id, image_id),
          ${projectFkey('duplicate_check_duplicate_images')},
          CONSTRAINT duplicate_check_duplicate_images_artifact_fkey FOREIGN KEY (org_id, preview_artifact_id)
            REFERENCES artifacts (org_id, id) ON DELETE SET NULL (preview_artifact_id)
        )`,
    sql`CREATE INDEX duplicate_check_duplicate_images_org_id_project_id_idx ON duplicate_check_duplicate_images (org_id, project_id, sort_order)`,
    sql`CREATE INDEX duplicate_check_duplicate_images_artifact_idx ON duplicate_check_duplicate_images (org_id, preview_artifact_id)
          WHERE preview_artifact_id IS NOT NULL`,
    ...policies('duplicate_check_duplicate_images', {
      live: projectLive('duplicate_check_duplicate_images'),
      insert: PREVIEW_ARTIFACT_VALID,
      commands: ['INSERT', 'DELETE'],
    }),
    ...replaceGrants('duplicate_check_duplicate_images', ['org_id', 'project_id', 'image_id', 'hash', 'preview_artifact_id', 'file_ids', 'sort_order']),

    // locations 是该图片在该文件中出现的位置（图片序号、所在目录、前一句），由任务写入。
    sql`CREATE TABLE duplicate_check_image_occurrences (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          project_id uuid NOT NULL,
          image_id text NOT NULL,
          file_id uuid NOT NULL,
          ${count('occurrence_count')},
          ${json('locations', 'array', DUPLICATE_CHECK_JSON_MAX_BYTES)},
          CONSTRAINT duplicate_check_image_occurrences_key UNIQUE (project_id, image_id, file_id),
          CONSTRAINT duplicate_check_image_occurrences_image_fkey FOREIGN KEY (org_id, project_id, image_id)
            REFERENCES duplicate_check_duplicate_images (org_id, project_id, image_id) ON DELETE CASCADE,
          ${projectFkey('duplicate_check_image_occurrences')},
          ${fileFkey('duplicate_check_image_occurrences')}
        )`,
    sql`CREATE INDEX duplicate_check_image_occurrences_org_id_project_id_idx ON duplicate_check_image_occurrences (org_id, project_id, image_id)`,
    ...policies('duplicate_check_image_occurrences', { live: fileLive('duplicate_check_image_occurrences'), commands: ['INSERT', 'DELETE'] }),
    ...replaceGrants('duplicate_check_image_occurrences', ['org_id', 'project_id', 'image_id', 'file_id', 'occurrence_count', 'locations']),
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(
    db,
    [...DUPLICATE_CHECK_TABLES].reverse().map((table) => sql`DROP TABLE ${sql.id(table)}`),
  );
}
