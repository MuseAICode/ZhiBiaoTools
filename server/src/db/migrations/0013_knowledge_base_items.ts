// 知识库（二）（docs/SERVER_DESIGN.md 第 2.5 节；路线图第 5 步 5.7）：取代桌面版 SQLite 的 knowledge_blocks、
// knowledge_candidate_items、knowledge_items、knowledge_item_blocks、knowledge_discarded_groups、knowledge_reports、
// knowledge_match_batches。七张表都是文档准备（第 6 步的解析任务）的产物，全部挂在 knowledge_documents 下，组织级
// （组织内共享，第 9 节第 2 项）：
//
// - knowledge_blocks：Markdown 切出的块，is_filtered 区分进入 AI 分析的有效块和程序筛除的块；
// - knowledge_candidate_items：候选条目（首轮、补充、补漏提取，合并后整体替换）；
// - knowledge_items：最终条目，检索与引用的对象；
// - knowledge_item_blocks：最终条目引用的来源块；
// - knowledge_discarded_groups：AI 舍弃和系统重试后舍弃的块组；
// - knowledge_reports：每个文档一份分析报告；
// - knowledge_match_batches：段落匹配的分批状态（断点续跑）。
//
// 不变式由数据库保证，不依赖应用代码：
// - 强制 RLS：应用角色只能看到、写入当前组织的行，未设置上下文时什么都看不到；文档由复合外键 (org_id, document_id)
//   保证属于本组织，org_id、document_id 写入后不能改；
// - 删除可见性：七张表都随文档可见（策略以文档在应用角色下可见为条件，knowledge_documents 的策略在子查询中同样生效），
//   原件已删除（进入回收站）时查不到、改不了、删不掉，也不能新写，恢复文件即一起恢复；文档行被删除（删除文件夹、
//   清理任务物理删除原件）时由外键级联删除；
// - 写法与桌面版相同“整体替换”：块、候选条目、最终条目及其来源块、舍弃块组、报告只授予 INSERT 和 DELETE，
//   不授予 UPDATE；只有匹配批次按批更新状态；
// - 条目的来源块由复合外键指向本文档的条目，随条目删除；状态与时间、错误的组合与 knowledge_document_steps 相同（CHECK）。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { KNOWLEDGE_ERROR_MAX, KNOWLEDGE_MESSAGE_MAX, KNOWLEDGE_STEP_RESULT_MAX_BYTES, KNOWLEDGE_STEP_STATUSES } from './0012_knowledge_base.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 块 id、条目 id（单文档内的 P000001 / K000001 等）和块类型、条目来源的字数上限。 */
export const KNOWLEDGE_KEY_MAX = 64;
/** 条目标题、摘要（summary / resume）、来源文件名、舍弃与筛除原因的字数上限。 */
export const KNOWLEDGE_TITLE_MAX = 2000;
export const KNOWLEDGE_SUMMARY_MAX = 20_000;
export const KNOWLEDGE_SOURCE_FILE_MAX = 1000;
export const KNOWLEDGE_REASON_MAX = KNOWLEDGE_MESSAGE_MAX;
/** 块、条目正文的字数上限（原件不超过 100 MiB，解析出的单个块或条目不应接近这个量级）。 */
export const KNOWLEDGE_CONTENT_MAX = 10_000_000;
/** 块的标题路径（jsonb 数组）序列化后的字节数上限。 */
export const KNOWLEDGE_HEADING_PATH_MAX_BYTES = 64 * 1024;
/** 舍弃块组的块 id、匹配批次的指纹与结果（jsonb）序列化后的字节数上限，与步骤结果相同。 */
export const KNOWLEDGE_JSON_MAX_BYTES = KNOWLEDGE_STEP_RESULT_MAX_BYTES;
/** 报告中覆盖率、匹配率的上限（正常不超过 1，留出余量）。 */
export const KNOWLEDGE_RATE_MAX = 1000;
/** 舍弃块组的来源：AI 建议舍弃 / 系统重试后舍弃。 */
export const KNOWLEDGE_DISCARD_SOURCES = ['ai', 'system'] as const;
/** 报告上的计数列。 */
export const KNOWLEDGE_REPORT_COUNT_COLUMNS = [
  'total_blocks',
  'filtered_blocks_count',
  'candidate_items_count',
  'final_items_count',
  'matched_blocks_count',
  'discarded_blocks_count',
  'system_discarded_after_retry_count',
  'new_items_from_recovery_count',
  'recovery_attempt_count',
] as const;

/** 由文档准备产生、随文档可见的七张表。 */
export const KNOWLEDGE_CONTENT_TABLES = [
  'knowledge_blocks',
  'knowledge_candidate_items',
  'knowledge_items',
  'knowledge_item_blocks',
  'knowledge_discarded_groups',
  'knowledge_reports',
  'knowledge_match_batches',
] as const;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

function key(column: string): RawBuilder<unknown> {
  return sql`${sql.id(column)} text NOT NULL CHECK (char_length(${sql.id(column)}) BETWEEN 1 AND ${sql.lit(KNOWLEDGE_KEY_MAX)})`;
}

function text(column: string, max: number, nullable = false): RawBuilder<unknown> {
  return sql`${sql.id(column)} text ${nullable ? sql`` : sql`NOT NULL`} CHECK (char_length(${sql.id(column)}) <= ${sql.lit(max)})`;
}

function jsonArray(column: string, max: number): RawBuilder<unknown> {
  return sql`${sql.id(column)} jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(${sql.id(column)}) = 'array' AND octet_length(${sql.id(column)}::text) <= ${sql.lit(max)})`;
}

const TENANT = sql`org_id = app_current_org_id()`;

/** 行随文档可见（knowledge_documents 的策略在子查询中同样生效：原件已删除的文档不可见）。 */
function documentLive(table: string): RawBuilder<unknown> {
  return sql`EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.id = ${sql.id(table)}.document_id)`;
}

function documentFkey(table: string): RawBuilder<unknown> {
  return sql`CONSTRAINT ${sql.id(`${table}_document_fkey`)} FOREIGN KEY (org_id, document_id) REFERENCES knowledge_documents (org_id, id) ON DELETE CASCADE`;
}

/** 强制 RLS、随文档可见的策略；commands 是授予应用角色的命令。 */
function policies(table: string, commands: readonly ('INSERT' | 'UPDATE' | 'DELETE')[]): RawBuilder<unknown>[] {
  const t = sql.id(table);
  const live = documentLive(table);
  return [
    sql`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY ${sql.id(`${table}_select_tenant`)} ON ${t} FOR SELECT TO ${app} USING (${TENANT} AND ${live})`,
    ...(commands.includes('INSERT')
      ? [sql`CREATE POLICY ${sql.id(`${table}_insert_tenant`)} ON ${t} FOR INSERT TO ${app} WITH CHECK (${TENANT} AND ${live})`]
      : []),
    ...(commands.includes('UPDATE')
      ? [sql`CREATE POLICY ${sql.id(`${table}_update_tenant`)} ON ${t} FOR UPDATE TO ${app} USING (${TENANT} AND ${live}) WITH CHECK (${TENANT})`]
      : []),
    ...(commands.includes('DELETE')
      ? [sql`CREATE POLICY ${sql.id(`${table}_delete_tenant`)} ON ${t} FOR DELETE TO ${app} USING (${TENANT} AND ${live})`]
      : []),
  ];
}

function grant(table: string, insertColumns: readonly string[], extra: readonly RawBuilder<unknown>[] = []): RawBuilder<unknown>[] {
  const t = sql.id(table);
  return [
    sql`GRANT SELECT, DELETE ON ${t} TO ${app}`,
    sql`GRANT INSERT (${sql.join(insertColumns.map((column) => sql.id(column)))}) ON ${t} TO ${app}`,
    ...extra,
  ];
}

const REPORT_COUNTS = KNOWLEDGE_REPORT_COUNT_COLUMNS.map((column) => sql`${sql.id(column)} integer NOT NULL DEFAULT 0 CHECK (${sql.id(column)} >= 0)`);

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    // is_filtered 为真时是程序筛除的块，filter_reason 是筛除原因；有效块没有原因。
    // 同一文档中有效块和筛除块的 id 各自唯一（与桌面版相同）。
    sql`CREATE TABLE knowledge_blocks (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          document_id uuid NOT NULL,
          ${key('block_id')},
          ${key('type')},
          ${jsonArray('heading_path', KNOWLEDGE_HEADING_PATH_MAX_BYTES)},
          ${text('content', KNOWLEDGE_CONTENT_MAX)},
          content_chars integer NOT NULL DEFAULT 0 CHECK (content_chars >= 0),
          is_filtered boolean NOT NULL DEFAULT false,
          ${text('filter_reason', KNOWLEDGE_REASON_MAX, true)},
          sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
          CONSTRAINT knowledge_blocks_block_key UNIQUE (document_id, is_filtered, block_id),
          CONSTRAINT knowledge_blocks_filter_reason_shape CHECK (is_filtered OR filter_reason IS NULL),
          ${documentFkey('knowledge_blocks')}
        )`,
    sql`CREATE INDEX knowledge_blocks_org_id_document_idx ON knowledge_blocks (org_id, document_id, is_filtered, sort_order)`,
    ...policies('knowledge_blocks', ['INSERT', 'DELETE']),
    ...grant('knowledge_blocks', [
      'org_id',
      'document_id',
      'block_id',
      'type',
      'heading_path',
      'content',
      'content_chars',
      'is_filtered',
      'filter_reason',
      'sort_order',
    ]),

    // source 是提取来源（first / supplement / merged / recovery_N 等，由任务写入），桌面版未限定取值。
    sql`CREATE TABLE knowledge_candidate_items (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          document_id uuid NOT NULL,
          ${key('item_id')},
          ${text('title', KNOWLEDGE_TITLE_MAX)},
          ${text('summary', KNOWLEDGE_SUMMARY_MAX)},
          source text CHECK (char_length(source) BETWEEN 1 AND ${sql.lit(KNOWLEDGE_KEY_MAX)}),
          sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT knowledge_candidate_items_item_key UNIQUE (document_id, item_id),
          ${documentFkey('knowledge_candidate_items')}
        )`,
    sql`CREATE INDEX knowledge_candidate_items_org_id_document_idx ON knowledge_candidate_items (org_id, document_id, sort_order)`,
    ...policies('knowledge_candidate_items', ['INSERT', 'DELETE']),
    ...grant('knowledge_candidate_items', ['org_id', 'document_id', 'item_id', 'title', 'summary', 'source', 'sort_order']),

    // (org_id, document_id, item_id) 唯一，供来源块的复合外键引用。
    sql`CREATE TABLE knowledge_items (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          document_id uuid NOT NULL,
          ${key('item_id')},
          ${text('title', KNOWLEDGE_TITLE_MAX)},
          ${text('resume', KNOWLEDGE_SUMMARY_MAX)},
          ${text('content', KNOWLEDGE_CONTENT_MAX)},
          ${text('source_file', KNOWLEDGE_SOURCE_FILE_MAX, true)},
          content_chars integer NOT NULL DEFAULT 0 CHECK (content_chars >= 0),
          sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT knowledge_items_item_key UNIQUE (org_id, document_id, item_id),
          ${documentFkey('knowledge_items')}
        )`,
    sql`CREATE INDEX knowledge_items_org_id_document_idx ON knowledge_items (org_id, document_id, sort_order)`,
    ...policies('knowledge_items', ['INSERT', 'DELETE']),
    ...grant('knowledge_items', ['org_id', 'document_id', 'item_id', 'title', 'resume', 'content', 'source_file', 'content_chars', 'sort_order']),

    // 来源块的 block_id 与桌面版相同不设外键（块与条目由同一任务写入，重新切块时条目一并清除）。
    sql`CREATE TABLE knowledge_item_blocks (
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          document_id uuid NOT NULL,
          item_id text NOT NULL,
          ${key('block_id')},
          sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
          PRIMARY KEY (document_id, item_id, block_id),
          CONSTRAINT knowledge_item_blocks_item_fkey FOREIGN KEY (org_id, document_id, item_id)
            REFERENCES knowledge_items (org_id, document_id, item_id) ON DELETE CASCADE,
          ${documentFkey('knowledge_item_blocks')}
        )`,
    sql`CREATE INDEX knowledge_item_blocks_org_id_document_idx ON knowledge_item_blocks (org_id, document_id, item_id, sort_order)`,
    ...policies('knowledge_item_blocks', ['INSERT', 'DELETE']),
    ...grant('knowledge_item_blocks', ['org_id', 'document_id', 'item_id', 'block_id', 'sort_order']),

    sql`CREATE TABLE knowledge_discarded_groups (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          document_id uuid NOT NULL,
          source text NOT NULL CHECK (source IN (${list(KNOWLEDGE_DISCARD_SOURCES)})),
          ${text('reason', KNOWLEDGE_REASON_MAX)},
          ${jsonArray('block_ids', KNOWLEDGE_JSON_MAX_BYTES)},
          sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
          ${documentFkey('knowledge_discarded_groups')}
        )`,
    sql`CREATE INDEX knowledge_discarded_groups_org_id_document_idx ON knowledge_discarded_groups (org_id, document_id, sort_order)`,
    ...policies('knowledge_discarded_groups', ['INSERT', 'DELETE']),
    ...grant('knowledge_discarded_groups', ['org_id', 'document_id', 'source', 'reason', 'block_ids', 'sort_order']),

    // 每个文档一份，保存匹配结果时整体替换；created_at 是报告生成时间。
    sql`CREATE TABLE knowledge_reports (
          document_id uuid PRIMARY KEY,
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          ${sql.join(REPORT_COUNTS)},
          batch_size integer NOT NULL DEFAULT 20 CHECK (batch_size >= 0),
          -- BETWEEN 同时挡住 NaN 和 Infinity（PostgreSQL 中 NaN 大于任何数）。
          coverage_rate double precision NOT NULL DEFAULT 0 CHECK (coverage_rate BETWEEN 0 AND ${sql.lit(KNOWLEDGE_RATE_MAX)}),
          matched_rate double precision NOT NULL DEFAULT 0 CHECK (matched_rate BETWEEN 0 AND ${sql.lit(KNOWLEDGE_RATE_MAX)}),
          created_at timestamptz NOT NULL DEFAULT now(),
          ${documentFkey('knowledge_reports')}
        )`,
    sql`CREATE INDEX knowledge_reports_org_id_document_idx ON knowledge_reports (org_id, document_id)`,
    ...policies('knowledge_reports', ['INSERT', 'DELETE']),
    ...grant('knowledge_reports', ['org_id', 'document_id', ...KNOWLEDGE_REPORT_COUNT_COLUMNS, 'batch_size', 'coverage_rate', 'matched_rate']),

    // item_ids 是本批的指纹（桌面版为 { block_ids, item_ids } 对象，旧数据是数组），matches 是本批的匹配结果数组。
    sql`CREATE TABLE knowledge_match_batches (
          org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
          document_id uuid NOT NULL,
          batch_index integer NOT NULL CHECK (batch_index >= 0),
          status text NOT NULL DEFAULT 'idle' CHECK (status IN (${list(KNOWLEDGE_STEP_STATUSES)})),
          item_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(item_ids) IN ('array', 'object')
            AND octet_length(item_ids::text) <= ${sql.lit(KNOWLEDGE_JSON_MAX_BYTES)}),
          matches jsonb CHECK (jsonb_typeof(matches) = 'array' AND octet_length(matches::text) <= ${sql.lit(KNOWLEDGE_JSON_MAX_BYTES)}),
          ${text('error', KNOWLEDGE_ERROR_MAX, true)},
          started_at timestamptz,
          completed_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (document_id, batch_index),
          CONSTRAINT knowledge_match_batches_status_shape CHECK (CASE status
            WHEN 'idle' THEN started_at IS NULL AND completed_at IS NULL AND error IS NULL
            WHEN 'running' THEN started_at IS NOT NULL AND completed_at IS NULL AND error IS NULL
            WHEN 'success' THEN started_at IS NOT NULL AND completed_at IS NOT NULL AND error IS NULL
            ELSE started_at IS NOT NULL AND completed_at IS NOT NULL AND error IS NOT NULL
          END),
          ${documentFkey('knowledge_match_batches')}
        )`,
    sql`CREATE INDEX knowledge_match_batches_org_id_document_idx ON knowledge_match_batches (org_id, document_id, batch_index)`,
    sql`CREATE TRIGGER knowledge_match_batches_touch BEFORE UPDATE ON knowledge_match_batches
          FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()`,
    ...policies('knowledge_match_batches', ['INSERT', 'UPDATE', 'DELETE']),
    ...grant(
      'knowledge_match_batches',
      ['org_id', 'document_id', 'batch_index', 'status', 'item_ids', 'matches', 'error', 'started_at', 'completed_at'],
      [sql`GRANT UPDATE (status, item_ids, matches, error, started_at, completed_at) ON knowledge_match_batches TO ${app}`],
    ),
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(
    db,
    [...KNOWLEDGE_CONTENT_TABLES].reverse().map((table) => sql`DROP TABLE ${sql.id(table)}`),
  );
}
