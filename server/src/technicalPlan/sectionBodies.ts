// AI 小节正文的存储（迁移 0046_technical_plan_section_bodies，路线图第 8 步 8.10a）：取代桌面版正文 Agent 工作区中的
// 正文/<节点 id>.html 与其引用的配图文件。正文由第 8 步的正文生成任务写入（8.10c 起），整本导出、小节预览随 8.12 读取。
//
// 入库前一律经服务端受限 HTML 白名单（src/templates/restrictedHtml.ts 的 parseRestrictedHtml，与前端同一套规则）：
// - 有 error 级问题（危险或不支持的块标签、结构不合规等）时整节拒绝，返回问题清单，不保存任何部分——由调用方交回 Agent 修改；
// - warning 级的清洗（不在白名单中的行内标签只保留文字，如 <a>、<span>；不在白名单中的属性删除，如 href、src、style、
//   事件属性）照常进行，只保存规范化的结果（normalizedHtml，由解析树重新序列化），调用方给出的原文不保存；
// - img 的 data-app-asset-ref 必须是本项目已完成、未被替换的图片产物 id（小写 uuid，与整本导出的配图引用相同）；没有引用的
//   img（配图尚未生成）照常保存，是否完整由调用方的提交校验决定。
//
// 不再被任何小节引用的配图产物标为已被替换（迁移 0023），由清理任务删除，不留在组织存储配额中。
import { sql, type Kysely, type Transaction } from 'kysely';
import { TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES, TECHNICAL_PLAN_SECTION_IMAGES_MAX } from '../db/migrations/0046_technical_plan_section_bodies.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { parseRestrictedHtml } from '../templates/restrictedHtml.ts';

type Trx = Transaction<Database> | Kysely<Database>;

const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 规范化结果由 parse5 序列化：属性值一律用双引号，值中的 " 与 & 已转义，按此提取引用不会被正文内容干扰。 */
const ASSET_REF = /<img\b[^>]*?\sdata-app-asset-ref="([^"]*)"/g;
/** 拒绝时至多列出的问题数（逐条带块序号）。 */
const MAX_LISTED_ISSUES = 50;

export interface SectionBody {
  nodeId: string;
  /** 规范化后的受限 HTML。 */
  html: string;
  /** 引用的图片产物 id（按首次出现排序、去重）。 */
  imageArtifactIds: string[];
  updatedAt: Date;
}

export interface PreparedSectionBody {
  html: string;
  imageArtifactIds: string[];
}

/** 正文不能入库：issues 是给 Agent 修改用的问题清单（纯文本，不含正文原文）。 */
export class SectionBodyRejectedError extends AppError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(422, 'TECHNICAL_PLAN_SECTION_BODY_INVALID', `小节正文不符合受限 HTML 规范：${issues.slice(0, 3).join('；')}${issues.length > 3 ? ' 等' : ''}`);
    this.name = 'SectionBodyRejectedError';
    this.issues = issues;
  }
}

/**
 * 经白名单规范化一节正文（纯函数）：返回规范化的 HTML 与引用的图片产物 id；不能入库时抛 SectionBodyRejectedError。
 * 产物是否属于本项目由 writeSectionBody 在数据库中核对。
 */
export function prepareSectionBody(source: string): PreparedSectionBody {
  const raw = String(source ?? '');
  if (!raw.trim()) throw new SectionBodyRejectedError(['正文为空']);
  const parsed = parseRestrictedHtml(raw);
  const errors = parsed.issues.filter((issue) => issue.level === 'error');
  if (errors.length > 0 || parsed.normalizedHtml === null || !parsed.normalizedHtml.trim()) {
    const listed = errors.length > 0 ? errors : [{ blockIndex: 0, message: '没有可保存的正文块' }];
    throw new SectionBodyRejectedError(
      [...new Set(listed.map((issue) => `第 ${issue.blockIndex + 1} 块：${issue.message}`))].slice(0, MAX_LISTED_ISSUES),
    );
  }
  const html = parsed.normalizedHtml;
  if (Buffer.byteLength(html, 'utf8') > TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES) {
    throw new SectionBodyRejectedError([`正文超过 ${TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES / 1024 / 1024} MiB`]);
  }
  const all = assetRefs(html);
  const refs = all.filter((ref) => ARTIFACT_ID.test(ref));
  if (refs.length !== all.length) throw new SectionBodyRejectedError(['配图引用必须是本项目已生成的图片（data-app-asset-ref 为图片产物 id）']);
  if (refs.length > TECHNICAL_PLAN_SECTION_IMAGES_MAX) {
    throw new SectionBodyRejectedError([`一节正文至多引用 ${TECHNICAL_PLAN_SECTION_IMAGES_MAX} 张配图`]);
  }
  return { html, imageArtifactIds: refs };
}

/** 规范化正文中 img 的 data-app-asset-ref（按首次出现排序、去重）。 */
function assetRefs(html: string): string[] {
  return [...new Set([...html.matchAll(ASSET_REF)].map((match) => match[1]!.trim()))];
}

/** 本项目中已完成、未被替换的图片产物（RLS 下求值）中，ids 里存在的那些。 */
async function readyProjectImages(trx: Trx, projectId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await trx
    .selectFrom('artifacts')
    .select('id')
    .where('id', 'in', [...ids])
    .where('project_id', '=', projectId)
    .where('kind', '=', 'image')
    .where('status', '=', 'ready')
    .where('superseded_at', 'is', null)
    .execute();
  return new Set(rows.map((row) => row.id));
}

/** ids 中已不被本项目任何小节引用的产物标为已被替换（触发器写入时间；已被替换的不变）。 */
async function supersedeUnreferenced(trx: Trx, projectId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await trx
    .updateTable('artifacts')
    .set({ superseded_at: new Date() })
    .where('id', 'in', [...ids])
    .where('project_id', '=', projectId)
    .where('status', '=', 'ready')
    .where('superseded_at', 'is', null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('technical_plan_section_images as i')
            .select(sql.lit(1).as('one'))
            .where('i.project_id', '=', projectId)
            .whereRef('i.artifact_id', '=', 'artifacts.id'),
        ),
      ),
    )
    .execute();
}

/**
 * 在已设置上下文、已加项目锁的事务中写入一节正文（整体替换）：节点必须是本项目目录中的 ai-generate 叶子；引用的配图必须是
 * 本项目已完成、未被替换的图片产物（否则整节拒绝）；本节不再引用、其他小节也没有引用的配图标为已被替换。
 */
export async function writeSectionBody(
  trx: Transaction<Database>,
  orgId: string,
  projectId: string,
  nodeId: string,
  prepared: PreparedSectionBody,
): Promise<SectionBody> {
  const node = await trx
    .selectFrom('technical_plan_outline_nodes as n')
    .select(['n.content_mode'])
    .select(({ exists, selectFrom }) =>
      exists(selectFrom('technical_plan_outline_nodes as c').select(sql.lit(1).as('one')).where('c.project_id', '=', projectId).whereRef('c.parent_node_id', '=', 'n.node_id')).as(
        'has_children',
      ),
    )
    .where('n.project_id', '=', projectId)
    .where('n.node_id', '=', nodeId)
    .executeTakeFirst();
  if (!node) throw new AppError(404, 'TECHNICAL_PLAN_CHAPTER_NOT_FOUND', '当前目录中未找到该章节');
  if (node.content_mode !== 'ai-generate' || node.has_children) {
    throw new AppError(409, 'TECHNICAL_PLAN_SECTION_NOT_AI_GENERATED', '该章节不是 AI 生成的正文小节');
  }
  const ready = await readyProjectImages(trx, projectId, prepared.imageArtifactIds);
  const missing = prepared.imageArtifactIds.filter((id) => !ready.has(id));
  if (missing.length > 0) throw new SectionBodyRejectedError([`有 ${missing.length} 张配图不是本项目已生成的图片`]);

  const previous = (
    await trx.selectFrom('technical_plan_section_images').select('artifact_id').where('project_id', '=', projectId).where('node_id', '=', nodeId).execute()
  ).map((row) => row.artifact_id);
  const body = await trx
    .insertInto('technical_plan_section_bodies')
    .values({ org_id: orgId, project_id: projectId, node_id: nodeId, html: prepared.html })
    .onConflict((oc) => oc.columns(['project_id', 'node_id']).doUpdateSet({ html: prepared.html }))
    .returning(['updated_at'])
    .executeTakeFirstOrThrow();
  const next = new Set(prepared.imageArtifactIds);
  const removed = previous.filter((id) => !next.has(id));
  const added = prepared.imageArtifactIds.filter((id) => !previous.includes(id));
  if (removed.length > 0) {
    await trx.deleteFrom('technical_plan_section_images').where('project_id', '=', projectId).where('node_id', '=', nodeId).where('artifact_id', 'in', removed).execute();
  }
  if (added.length > 0) {
    await trx
      .insertInto('technical_plan_section_images')
      .values(added.map((artifactId) => ({ org_id: orgId, project_id: projectId, node_id: nodeId, artifact_id: artifactId })))
      .execute();
  }
  await supersedeUnreferenced(trx, projectId, removed);
  return { nodeId, html: prepared.html, imageArtifactIds: prepared.imageArtifactIds, updatedAt: body.updated_at };
}

/** 在已设置上下文的事务中读取一节正文；没有时返回 null。 */
export async function readSectionBody(trx: Trx, projectId: string, nodeId: string): Promise<SectionBody | null> {
  const row = await trx
    .selectFrom('technical_plan_section_bodies')
    .select(['html', 'updated_at'])
    .where('project_id', '=', projectId)
    .where('node_id', '=', nodeId)
    .executeTakeFirst();
  if (!row) return null;
  // 引用顺序以正文为准（行没有顺序）；行与正文由 writeSectionBody 在同一事务中一起写入。
  return { nodeId, html: row.html, imageArtifactIds: assetRefs(row.html), updatedAt: row.updated_at };
}

/**
 * 在已设置上下文、已加项目锁的事务中删除一些小节（nodeIds 为 null 时全部）的正文，配图行随之删除，不再被引用的配图产物标为
 * 已被替换。目录节点删除前必须先调用（节点的级联删除不会替换产物）。
 */
export async function discardSectionBodies(trx: Transaction<Database>, projectId: string, nodeIds: readonly string[] | null): Promise<void> {
  if (nodeIds !== null && nodeIds.length === 0) return;
  let images = trx.selectFrom('technical_plan_section_images').select('artifact_id').distinct().where('project_id', '=', projectId);
  if (nodeIds !== null) images = images.where('node_id', 'in', [...nodeIds]);
  const artifactIds = (await images.execute()).map((row) => row.artifact_id);
  let removal = trx.deleteFrom('technical_plan_section_bodies').where('project_id', '=', projectId);
  if (nodeIds !== null) removal = removal.where('node_id', 'in', [...nodeIds]);
  await removal.execute();
  await supersedeUnreferenced(trx, projectId, artifactIds);
}
