// 导出模板库的读写（迁移 0010_export_templates）。组织和用户一律来自 TenantContext，所有查询都经 withTenant。
//
// 可见性和写权限由 RLS 保证，这里不判断：只能看到本组织的模板和系统模板；修改、删除只对本组织的模板生效，
// 对系统模板和其他组织的模板都影响 0 行。影响 0 行时才回头查一次，区分“系统模板不能改”（403）和“不存在”（404），
// 只为给出明确的错误。其他组织的模板与不存在的一样返回 404。
import type { Kysely, Selectable, Transaction } from 'kysely';
import { EXPORT_TEMPLATE_CONFIG_MAX_BYTES, EXPORT_TEMPLATES_PER_ORG_MAX } from '../db/migrations/0010_export_templates.ts';
import type { Database, ExportTemplatesTable } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { serializeJsonObject } from '../jsonObject.ts';
import { copyTemplateName, normalizeTemplateName } from './name.ts';

export { EXPORT_TEMPLATE_CONFIG_MAX_BYTES, EXPORT_TEMPLATES_PER_ORG_MAX };

export interface ExportTemplateRecord {
  id: string;
  name: string;
  isSystem: boolean;
  config: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: Selectable<ExportTemplatesTable>): ExportTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    isSystem: row.org_id === null,
    config: row.config,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function templateInvalid(message: string, cause?: unknown): AppError {
  return new AppError(400, 'TEMPLATE_INVALID', message, cause === undefined ? undefined : { cause });
}

export function templateNotFound(): AppError {
  return new AppError(404, 'TEMPLATE_NOT_FOUND', '模板不存在或已被删除');
}

function mapTemplateError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ET001') {
    return new AppError(409, 'TEMPLATE_LIMIT_REACHED', `每个组织最多保存 ${EXPORT_TEMPLATES_PER_ORG_MAX} 个模板`, { cause: error });
  }
  // 23514：配置超过大小上限；22P02 / 22P05：jsonb 不接受的字符（如 \u0000、不成对的代理项）。
  if (code === '23514' || code === '22P02' || code === '22P05') return templateInvalid('模板配置不合法', error);
  return error;
}

/** 名称取自 config.template_name 并写回 config，返回名称和序列化后的配置。 */
function prepare(config: Record<string, unknown>, name = normalizeTemplateName(config.template_name)) {
  const json = serializeJsonObject({ ...config, template_name: name }, EXPORT_TEMPLATE_CONFIG_MAX_BYTES);
  if (json === 'too-deep') throw templateInvalid('模板配置嵌套层级过深');
  if (json === 'too-large') throw templateInvalid('模板配置过大');
  return { name, config: json };
}

async function insert(trx: Transaction<Database>, context: TenantContext, values: { name: string; config: string }) {
  return trx
    .insertInto('export_templates')
    .values({ org_id: context.orgId, ...values, created_by: context.userId, updated_by: context.userId })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** 修改、删除影响 0 行时：可见的系统模板返回 403，其余（不存在、其他组织的）返回 404。 */
async function explainMiss(trx: Transaction<Database>, templateId: string, action: '编辑' | '删除'): Promise<AppError> {
  const row = await trx.selectFrom('export_templates').select('org_id').where('id', '=', templateId).executeTakeFirst();
  if (row && row.org_id === null) {
    return new AppError(403, 'TEMPLATE_READ_ONLY', action === '编辑' ? '系统预设模板不可编辑，请先复制为我的模板' : '系统预设模板不可删除');
  }
  return templateNotFound();
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapTemplateError(error);
  }
}

/** 系统模板在前（按定义顺序），组织模板按最近修改在后。每个组织最多 100 个模板，不分页。 */
export async function listTemplates(db: Kysely<Database>, context: TenantContext): Promise<ExportTemplateRecord[]> {
  const rows = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('export_templates')
      .selectAll()
      .orderBy((eb) => eb('org_id', 'is', null), 'desc')
      .orderBy('sort_order')
      .orderBy('updated_at', 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .execute(),
  );
  return rows.map(toRecord);
}

/** 本组织的模板或系统模板；其他组织的、不存在的返回 null。 */
export async function findTemplate(db: Kysely<Database>, context: TenantContext, templateId: string): Promise<ExportTemplateRecord | null> {
  const row = await withTenant(db, context, (trx) =>
    trx.selectFrom('export_templates').selectAll().where('id', '=', templateId).executeTakeFirst(),
  );
  return row ? toRecord(row) : null;
}

export async function createTemplate(db: Kysely<Database>, context: TenantContext, config: Record<string, unknown>): Promise<ExportTemplateRecord> {
  const values = prepare(config);
  return guarded(async () => toRecord(await withTenant(db, context, (trx) => insert(trx, context, values))));
}

/** 整份替换配置（与桌面版相同）。 */
export async function updateTemplate(
  db: Kysely<Database>,
  context: TenantContext,
  templateId: string,
  config: Record<string, unknown>,
): Promise<ExportTemplateRecord> {
  const values = prepare(config);
  return guarded(() =>
    withTenant(db, context, async (trx) => {
      const row = await trx
        .updateTable('export_templates')
        .set({ ...values, updated_by: context.userId })
        .where('id', '=', templateId)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw await explainMiss(trx, templateId, '编辑');
      return toRecord(row);
    }),
  );
}

export async function deleteTemplate(db: Kysely<Database>, context: TenantContext, templateId: string): Promise<void> {
  await withTenant(db, context, async (trx) => {
    const result = await trx.deleteFrom('export_templates').where('id', '=', templateId).executeTakeFirst();
    if (result.numDeletedRows === 0n) throw await explainMiss(trx, templateId, '删除');
  });
}

/** 把任意可见的模板（含系统模板）复制成本组织的模板，名称加“ 副本”。 */
export async function duplicateTemplate(db: Kysely<Database>, context: TenantContext, templateId: string): Promise<ExportTemplateRecord> {
  return guarded(() =>
    withTenant(db, context, async (trx) => {
      const source = await trx.selectFrom('export_templates').select(['name', 'config']).where('id', '=', templateId).executeTakeFirst();
      if (!source) throw templateNotFound();
      return toRecord(await insert(trx, context, prepare(source.config, copyTemplateName(source.name))));
    }),
  );
}
