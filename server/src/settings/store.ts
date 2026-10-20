// 组织设置与用户设置的读写（迁移 0009_settings）。组织和用户一律来自 TenantContext，所有查询都经 withTenant。
//
// 可见性和写权限由 RLS 保证：组织设置只能看到本组织的、只有 owner / admin 能写；用户设置只能看到、写入自己在
// 当前组织的那一行，成员关系删除后不可见。这里只在写组织设置前按 context.role 提前返回 403，便于给出明确的错误，
// 不替代数据库的检查。还没有写过的设置返回默认值，不预先插入行。
//
// 返回中不含任何 Key 或 Base URL：平台模型只返回 id、服务商、模型名和启用状态。
import type { Kysely, Selectable, Transaction } from 'kysely';
import {
  CONCURRENCY_LIMIT_MAX,
  CONCURRENCY_LIMIT_MIN,
  DEFAULT_CONCURRENCY_LIMIT,
  EXPORT_FORMAT_MAX_BYTES,
  ORG_SETTINGS_EDITOR_ROLES,
  UI_PREFERENCES_MAX_BYTES,
} from '../db/migrations/0009_settings.ts';
import type { BillingProvider, Database, MemberRole, OrgSettingsTable, UserSettingsTable } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { JSON_OBJECT_MAX_DEPTH, serializeJsonObject } from '../jsonObject.ts';

export { CONCURRENCY_LIMIT_MAX, CONCURRENCY_LIMIT_MIN, DEFAULT_CONCURRENCY_LIMIT, EXPORT_FORMAT_MAX_BYTES, UI_PREFERENCES_MAX_BYTES };

/** JSON 对象的最大嵌套深度。 */
export const SETTINGS_JSON_MAX_DEPTH = JSON_OBJECT_MAX_DEPTH;

export interface PlatformModelSummary {
  id: string;
  provider: BillingProvider;
  model: string;
  /** 已停用的模型仍保留在设置中，调用时被网关拒绝；设置页据此提示重新选择。 */
  enabled: boolean;
}

export interface OrgSettingsRecord {
  platformModelId: string | null;
  platformModel: PlatformModelSummary | null;
  concurrencyLimit: number;
  exportFormat: Record<string, unknown>;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface UserSettingsRecord {
  agentAutoAnswerEnabled: boolean;
  uiPreferences: Record<string, unknown>;
  updatedAt: Date | null;
}

export interface SettingsRecord {
  org: OrgSettingsRecord;
  user: UserSettingsRecord;
  /** 当前成员能否修改组织设置。 */
  canEditOrg: boolean;
}

export interface OrgSettingsPatch {
  platformModelId?: string | null;
  concurrencyLimit?: number;
  exportFormat?: Record<string, unknown>;
}

export interface UserSettingsPatch {
  agentAutoAnswerEnabled?: boolean;
  uiPreferences?: Record<string, unknown>;
}

export interface SettingsPatch {
  org?: OrgSettingsPatch;
  user?: UserSettingsPatch;
}

export function canEditOrgSettings(role: MemberRole): boolean {
  return (ORG_SETTINGS_EDITOR_ROLES as readonly string[]).includes(role);
}

function settingsInvalid(message: string, cause?: unknown): AppError {
  return new AppError(400, 'SETTINGS_INVALID', message, cause === undefined ? undefined : { cause });
}

/** 校验 JSON 对象的深度和大小，返回序列化结果。数据库的 CHECK 约束是最后一道检查。 */
function serializeObject(value: Record<string, unknown>, maxBytes: number, label: string): string {
  const json = serializeJsonObject(value, maxBytes);
  if (json === 'too-deep') throw settingsInvalid(`${label}嵌套层级过深`);
  if (json === 'too-large') throw settingsInvalid(`${label}过大`);
  return json;
}

function mapSettingsError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ST001') return new AppError(400, 'PLATFORM_MODEL_UNAVAILABLE', '所选模型不存在或已停用', { cause: error });
  // RLS 拒绝写入：成员角色在会话之后被降级、成员关系已删除等情况。
  if (code === '42501') return new AppError(403, 'SETTINGS_FORBIDDEN', '没有权限修改这些设置', { cause: error });
  // 23514：jsonb 超过大小上限；22P02 / 22P05：jsonb 不接受的字符（如 \u0000、不成对的代理项）。
  if (code === '23514' || code === '22P02' || code === '22P05') return settingsInvalid('设置内容不合法', error);
  return error;
}

function orgRecord(
  row: Selectable<OrgSettingsTable> | undefined,
  model: PlatformModelSummary | undefined,
): OrgSettingsRecord {
  return {
    platformModelId: row?.platform_model_id ?? null,
    platformModel: model ?? null,
    concurrencyLimit: row?.concurrency_limit ?? DEFAULT_CONCURRENCY_LIMIT,
    exportFormat: row?.export_format ?? {},
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function userRecord(row: Selectable<UserSettingsTable> | undefined): UserSettingsRecord {
  return {
    agentAutoAnswerEnabled: row?.agent_auto_answer_enabled ?? false,
    uiPreferences: row?.ui_preferences ?? {},
    updatedAt: row?.updated_at ?? null,
  };
}

async function read(trx: Transaction<Database>, context: TenantContext): Promise<SettingsRecord> {
  const org = await trx.selectFrom('org_settings').selectAll().where('org_id', '=', context.orgId).executeTakeFirst();
  const model = org?.platform_model_id
    ? await trx
        .selectFrom('platform_models')
        .select(['id', 'provider', 'model', 'enabled'])
        .where('id', '=', org.platform_model_id)
        .executeTakeFirst()
    : undefined;
  const user = await trx
    .selectFrom('user_settings')
    .selectAll()
    .where('org_id', '=', context.orgId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst();
  return { org: orgRecord(org, model), user: userRecord(user), canEditOrg: canEditOrgSettings(context.role) };
}

export async function loadSettings(db: Kysely<Database>, context: TenantContext): Promise<SettingsRecord> {
  return withTenant(db, context, (trx) => read(trx, context));
}

/** 部分更新：只改传入的字段，组织设置和用户设置在同一事务中写入。返回更新后的完整设置。 */
export async function updateSettings(db: Kysely<Database>, context: TenantContext, patch: SettingsPatch): Promise<SettingsRecord> {
  const org = patch.org && Object.keys(patch.org).length > 0 ? patch.org : undefined;
  const user = patch.user && Object.keys(patch.user).length > 0 ? patch.user : undefined;
  if (org && !canEditOrgSettings(context.role)) {
    throw new AppError(403, 'SETTINGS_FORBIDDEN', '只有组织所有者和管理员可以修改组织设置');
  }

  const orgValues = org && {
    ...(org.platformModelId !== undefined ? { platform_model_id: org.platformModelId } : {}),
    ...(org.concurrencyLimit !== undefined ? { concurrency_limit: org.concurrencyLimit } : {}),
    ...(org.exportFormat !== undefined ? { export_format: serializeObject(org.exportFormat, EXPORT_FORMAT_MAX_BYTES, '导出偏好') } : {}),
    updated_by: context.userId,
  };
  const userValues = user && {
    ...(user.agentAutoAnswerEnabled !== undefined ? { agent_auto_answer_enabled: user.agentAutoAnswerEnabled } : {}),
    ...(user.uiPreferences !== undefined ? { ui_preferences: serializeObject(user.uiPreferences, UI_PREFERENCES_MAX_BYTES, '界面偏好') } : {}),
  };

  try {
    return await withTenant(db, context, async (trx) => {
      if (orgValues) {
        // 先确保行存在、再 UPDATE，而不是 INSERT ... ON CONFLICT DO UPDATE：后者对拟插入的行同样触发 BEFORE INSERT，
        // 守卫会把“保持已选的、后来停用的模型不变”当成新选择而拒绝。
        await trx
          .insertInto('org_settings')
          .values({ org_id: context.orgId, updated_by: context.userId })
          .onConflict((conflict) => conflict.column('org_id').doNothing())
          .execute();
        await trx.updateTable('org_settings').set(orgValues).where('org_id', '=', context.orgId).execute();
      }
      if (userValues) {
        await trx
          .insertInto('user_settings')
          .values({ org_id: context.orgId, user_id: context.userId, ...userValues })
          .onConflict((conflict) => conflict.columns(['org_id', 'user_id']).doUpdateSet(userValues))
          .execute();
      }
      return read(trx, context);
    });
  } catch (error) {
    throw mapSettingsError(error);
  }
}
