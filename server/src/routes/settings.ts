// 设置接口（路线图第 5 步 5.3）。需要登录，组织和用户取自会话。
//
// GET /api/settings：组织设置（选用的平台模型、并发上限、导出偏好）和当前用户在本组织的设置（界面偏好、
//   agent_auto_answer_enabled），以及当前成员能否修改组织设置。还没有写过时返回默认值。
// PATCH /api/settings：部分更新，{ org?: {...}, user?: {...} }，只改传入的字段；修改组织设置需要 owner / admin。
//
// 返回中不含任何 Key、Base URL 或上游配置。设置页“选择模型 + 查看单价”的前端接入随第 3 步后续 PR。
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { tenantOf } from '../auth/hooks.ts';
import type { Database } from '../db/schema.ts';
import {
  CONCURRENCY_LIMIT_MAX,
  CONCURRENCY_LIMIT_MIN,
  loadSettings,
  updateSettings,
  type SettingsPatch,
  type SettingsRecord,
} from '../settings/store.ts';

export interface SettingsRouteDependencies {
  db: Kysely<Database>;
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

// 导出偏好、界面偏好由前端归一化（与桌面版 user_config.json 相同），服务端只要求是对象并限制深度和大小（Store 中检查）。
const JSON_OBJECT_SCHEMA = { type: 'object', maxProperties: 200 } as const;

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    org: {
      type: 'object',
      properties: {
        platformModelId: { anyOf: [{ type: 'string', pattern: UUID_PATTERN }, { type: 'null' }] },
        concurrencyLimit: { type: 'integer', minimum: CONCURRENCY_LIMIT_MIN, maximum: CONCURRENCY_LIMIT_MAX },
        exportFormat: JSON_OBJECT_SCHEMA,
      },
      additionalProperties: false,
      minProperties: 1,
    },
    user: {
      type: 'object',
      properties: {
        agentAutoAnswerEnabled: { type: 'boolean' },
        uiPreferences: JSON_OBJECT_SCHEMA,
      },
      additionalProperties: false,
      minProperties: 1,
    },
  },
  additionalProperties: false,
  minProperties: 1,
} as const;

function settingsBody(record: SettingsRecord) {
  return {
    org: {
      platformModelId: record.org.platformModelId,
      platformModel: record.org.platformModel,
      concurrencyLimit: record.org.concurrencyLimit,
      exportFormat: record.org.exportFormat,
      updatedBy: record.org.updatedBy,
      updatedAt: record.org.updatedAt?.toISOString() ?? null,
    },
    user: {
      agentAutoAnswerEnabled: record.user.agentAutoAnswerEnabled,
      uiPreferences: record.user.uiPreferences,
      updatedAt: record.user.updatedAt?.toISOString() ?? null,
    },
    canEditOrg: record.canEditOrg,
  };
}

export async function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDependencies): Promise<void> {
  const { db } = deps;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.get('/', async (request) => settingsBody(await loadSettings(db, tenantOf(request))));

  app.patch<{ Body: SettingsPatch }>('/', { schema: { body: PATCH_SCHEMA } }, async (request) => {
    const { org, user } = request.body;
    const patch: SettingsPatch = user ? { user } : {};
    if (org) patch.org = typeof org.platformModelId === 'string' ? { ...org, platformModelId: org.platformModelId.toLowerCase() } : org;
    return settingsBody(await updateSettings(db, tenantOf(request), patch));
  });
}
