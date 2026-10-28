// 任务中调用模型的公共部分（取代桌面版 aiService.chat / collectJsonResponse 在任务中的用法）：
// - 模型取组织设置中选择的平台模型（org_settings.platform_model_id），任务开始时读取一次；没有选择时任务失败；
// - text：一次调用，输出为空时失败；
// - json：与桌面版 collectJsonResponse 相同，最多调用 3 次，每次输出不合法时先请模型修复一次，仍不合法再重新调用。
// 每次调用的步骤键由调用方给出的键派生（重新调用 :try-N，修复 :repair-N），续跑时同一步骤取回已保存的结果，不再扣费
// （路线图 6.4a）。中止的调用（取消、暂停、租约丢失）只返回部分内容，一律按中断处理，不当作结果使用。
import type { Kysely } from 'kysely';
import { buildJsonRepairMessages, jsonIssues, parseJsonContent } from '../ai/json.ts';
import type { ChatMessage } from '../ai/providers.ts';
import type { BillingProvider, Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { JobError, JobInterruptedError, type JobAi } from './definitions.ts';

export interface JobModel {
  provider: BillingProvider;
  model: string;
}

/** 组织设置中选择的平台模型。没有选择时抛 JobError（模型已停用由网关拒绝）。 */
export async function resolveJobModel(db: Kysely<Database>, context: TenantContext): Promise<JobModel> {
  const row = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('org_settings as s')
      .innerJoin('platform_models as m', 'm.id', 's.platform_model_id')
      .select(['m.provider', 'm.model'])
      .where('s.org_id', '=', context.orgId)
      .executeTakeFirst(),
  );
  if (!row) throw new JobError('AI_MODEL_NOT_CONFIGURED', '尚未选择文本模型，请先在设置中选择模型');
  return { provider: row.provider, model: row.model };
}

export interface JsonRequestOptions {
  /** 进度与修复时的说明（与桌面版 progressLabel 相同）。 */
  progressLabel: string;
  /** 3 次都不合法时给用户看的原因（与桌面版 failureMessage 相同）。 */
  failureMessage: string;
  onProgress?: (message: string) => void;
}

export interface JobChat {
  readonly model: JobModel;
  /** 返回模型输出；输出为空时抛 JobError（“{label}未返回内容”），allowEmpty 时原样返回。 */
  text(stepKey: string, messages: readonly ChatMessage[], label: string, options?: { maxOutputTokens?: number; allowEmpty?: boolean }): Promise<string>;
  /** 返回解析出的 JSON（不可信数据，由调用方逐字段整理）。 */
  json(stepKey: string, messages: readonly ChatMessage[], options: JsonRequestOptions): Promise<unknown>;
}

const JSON_ATTEMPTS = 3;

export function createJobChat(ai: JobAi, model: JobModel): JobChat {
  async function call(stepKey: string, messages: readonly ChatMessage[], maxOutputTokens?: number): Promise<string> {
    const result = await ai.chat({
      provider: model.provider,
      model: model.model,
      messages,
      stepKey,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });
    if (result.aborted) throw new JobInterruptedError();
    return result.content;
  }

  return {
    model,
    async text(stepKey, messages, label, options = {}) {
      const content = await call(stepKey, messages, options.maxOutputTokens);
      if (!content.trim() && !options.allowEmpty) throw new JobError('AI_EMPTY_RESPONSE', `${label}未返回内容`);
      return content;
    },
    async json(stepKey, messages, options) {
      for (let attempt = 1; attempt <= JSON_ATTEMPTS; attempt += 1) {
        const content = await call(attempt === 1 ? stepKey : `${stepKey}:try-${attempt}`, messages);
        let issues: string[];
        try {
          return parseJsonContent(content);
        } catch (error) {
          issues = jsonIssues(error);
        }
        options.onProgress?.(`${options.progressLabel}格式校验失败，正在基于当前结果进行修复。`);
        const repaired = await call(`${stepKey}:repair-${attempt}`, buildJsonRepairMessages(content, issues, options.progressLabel));
        try {
          return parseJsonContent(repaired);
        } catch {
          if (attempt === JSON_ATTEMPTS) {
            options.onProgress?.(`${options.progressLabel}连续 ${JSON_ATTEMPTS} 次校验失败。`);
          } else {
            options.onProgress?.(`${options.progressLabel}第 ${attempt}/${JSON_ATTEMPTS} 次校验失败，正在重试。`);
          }
        }
      }
      // 解析错误的细节可能含模型输出，不写进给用户看的原因。
      throw new JobError('AI_INVALID_JSON', options.failureMessage);
    },
  };
}
