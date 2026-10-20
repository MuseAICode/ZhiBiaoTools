// 系统导出模板的同步（迁移 0010_export_templates）：把 systemTemplates.ts 的定义幂等写进 export_templates，
// 存在则整份覆盖（id 不变，组织模板和以后的引用不受影响），不存在则插入，定义中没有的旧系统模板删除。
//
// 只用迁移角色调用（迁移命令在迁移到最新后执行）：它在本表上的策略只覆盖 org_id 为空的行，
// 应用角色对系统模板只读，api 进程无论如何都改不了系统模板。
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import { normalizeTemplateName } from './name.ts';
import { SYSTEM_EXPORT_TEMPLATES, type SystemTemplateDefinition } from './systemTemplates.ts';

export interface SystemTemplateSyncResult {
  upserted: number;
  removed: number;
}

export async function syncSystemTemplates(
  db: Kysely<Database>,
  definitions: readonly SystemTemplateDefinition[] = SYSTEM_EXPORT_TEMPLATES,
): Promise<SystemTemplateSyncResult> {
  const rows = definitions.map((definition, index) => {
    const name = normalizeTemplateName(definition.config.template_name);
    return {
      system_key: definition.key,
      name,
      config: JSON.stringify({ ...definition.config, template_name: name }),
      sort_order: index,
    };
  });
  if (new Set(rows.map((row) => row.system_key)).size !== rows.length) throw new TypeError('系统模板的 key 重复');

  return db.transaction().execute(async (trx) => {
    if (rows.length > 0) {
      await trx
        .insertInto('export_templates')
        .values(rows)
        .onConflict((conflict) =>
          conflict.column('system_key').doUpdateSet((eb) => ({
            name: eb.ref('excluded.name'),
            config: eb.ref('excluded.config'),
            sort_order: eb.ref('excluded.sort_order'),
          })),
        )
        .execute();
    }
    let removal = trx.deleteFrom('export_templates').where('org_id', 'is', null);
    if (rows.length > 0) removal = removal.where('system_key', 'not in', rows.map((row) => row.system_key));
    const removed = await removal.executeTakeFirst();
    return { upserted: rows.length, removed: Number(removed.numDeletedRows) };
  });
}
