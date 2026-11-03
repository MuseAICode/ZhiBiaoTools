// AI 网关（docs/SERVER_DESIGN.md 第 1.1、4.3、10 节）：唯一解密平台 API Key 的地方，也是唯一的计量点。
//
// 每次调用：
// 0. 检查平台模型白名单（src/ai/models.ts）：未登记、已停用、未定价（含未标记免费的零价格）、免费标记与价格矛盾的
//    服务商 + 模型一律拒绝，不解密 Key、不冻结、不调用服务商；冻结时（ai_usage_begin）在同一事务中再检查一次；
//    随后按“组织 + 服务商”的并发上限排队取得名额（src/ai/concurrency.ts，配置了 Redis 时），调用结束后释放；
// 1. 读取并解密该服务商的平台凭据（明文只存在于本次调用的局部变量里，不缓存、不写日志、不进错误信息）；
// 2. 按“输入 token 上界 + 最大输出 token”冻结最高费用（src/billing/usage.ts），余额不足时拒绝、不调用服务商；
// 3. 以流式请求调用服务商，输出上限 max_tokens 就是冻结时的最大输出 token；
// 4. 成功：按服务商返回的用量结算（缺失时本地估算），多余冻结释放；
//    用户中途断开：按已产生的用量结算（第 10.1 节），用量缺失时本地估算；
//    服务商出错、超时、连接失败、响应不合法：不收费，冻结全额释放；
//    进程在调用中途崩溃：冻结到期后自动不再占用余额，到期后的结算一律不收费。
//
// 任务调用的步骤幂等（路线图 6.4a，迁移 0025_job_step_results）：任务调用必须带步骤键（stepKey）。调用前先按
// “任务 + 步骤键 + 请求内容的 SHA-256”查已保存的结果，有则直接返回（reused），不冻结、不调用服务商、不扣费；
// 调用完成时结果与结算在同一事务中写入，续跑时同一步骤不会再调用服务商、再扣费。因平台原因中止的调用
// （ChatOptions.platformAborted，worker 关闭、租约丢失）不收费（platform_interrupted），也不保存结果。
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import { MODEL_NAME_PATTERN } from '../billing/ledger.ts';
import {
  beginUsage,
  failUsage,
  findJobStepResult,
  settleJobStep,
  settleUsage,
  type JobStepKey,
  type GatewayFailureReason,
  type SettleUsageInput,
  type SettlementResult,
} from '../billing/usage.ts';
import { BILLING_PROVIDERS, type BillingProvider, type Database, type UsageSource } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { DEFAULT_CONCURRENCY_LIMIT } from '../db/migrations/0009_settings.ts';
import { JOB_STEP_KEY_PATTERN } from '../db/migrations/0025_job_step_results.ts';
import type { AiConcurrencyLimiter } from './concurrency.ts';
import { credentialAad } from './credentials.ts';
import { estimateInputTokens, estimateTokens, inputTokenUpperBound } from './estimate.ts';
import type { KeyWrapper } from './keyring.ts';
import { assertModelCallable } from './models.ts';
import { PROVIDER_ADAPTERS, type ChatMessage, type ProviderUsage } from './providers.ts';
import { streamChatCompletion, UpstreamAbortedError, UpstreamError } from './upstream.ts';

export type { ChatMessage } from './providers.ts';

export interface GatewaySettings {
  upstreamTimeoutMs: number;
  holdTtlSeconds: number;
  maxOutputTokens: number;
  upstreamPrivateHosts: readonly string[];
  /** 平台对每个“组织 + 服务商”的并发上限（AI_CONCURRENCY_MAX）；组织设置的上限更小时取组织的。 */
  concurrencyMax?: number;
  /** 交互式调用等待并发名额的最长时间（AI_CONCURRENCY_WAIT_MS），超过返回 429。 */
  concurrencyWaitMs?: number;
}

export interface ChatRequest {
  provider: BillingProvider;
  model: string;
  messages: readonly ChatMessage[];
  /** 不指定时取 AI_MAX_OUTPUT_TOKENS；不能超过它。 */
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
  source: UsageSource;
  /** 所属任务（source = 'job' 时必填，任务必须正在执行），写入 usage_records；任务类型以任务记录为准。 */
  jobId?: string | null;
  jobType?: string | null;
  /**
   * 任务内的步骤键（source = 'job' 时必填）：标识“同一次逻辑调用”，续跑时同一步骤键、同一请求内容的调用直接取回已保存的
   * 结果。同一任务内不同的调用要用不同的键；有意重试（例如输出不合格再调一次）也要换键（如 section:3:try-2）。
   */
  stepKey?: string | null;
}

export interface ChatDelta {
  content?: string;
  reasoningContent?: string;
}

export interface ChatOptions {
  /** 调用方取消（用户断开、任务取消）。 */
  signal?: AbortSignal;
  onDelta?: (delta: ChatDelta) => void;
  log?: FastifyBaseLogger;
  /** 等待并发名额的最长时间，默认取 settings.concurrencyWaitMs；任务中的调用传 Infinity（一直等到被取消）。 */
  concurrencyWaitMs?: number;
  /**
   * signal 中止时调用：返回 true 表示是平台原因（worker 关闭、租约丢失）中止的，本次调用不收费（platform_interrupted），
   * 否则（用户断开、取消、暂停）按已产生的用量结算。
   */
  platformAborted?: () => boolean;
}

export interface ChatResult {
  requestId: string;
  content: string;
  reasoningContent: string;
  finishReason: string | null;
  /** true 表示调用方中途取消，content 只是已产生的部分。 */
  aborted: boolean;
  /** true 表示取回的是本任务同一步骤已保存的结果（续跑时，或并发的执行者先完成），本次没有扣费。 */
  reused: boolean;
  usage: SettleUsageInput;
  billing: { status: SettlementResult['status']; amount: bigint };
}

export interface AiGateway {
  chat(context: TenantContext, request: ChatRequest, options?: ChatOptions): Promise<ChatResult>;
}

/** 单次调用的响应体上限。 */
export const MAX_UPSTREAM_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TOKENS = 1_000_000_000;
const ROLES = new Set(['system', 'user', 'assistant']);
const JOB_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const STEP_KEY_PATTERN = new RegExp(JOB_STEP_KEY_PATTERN);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_AI_CONCURRENCY_MAX = 10;
export const DEFAULT_AI_CONCURRENCY_WAIT_MS = 30_000;

interface CredentialRow {
  id: string;
  kind: 'text_model';
  provider: BillingProvider;
  base_url: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  wrapped_dek: Buffer;
  kek_version: number;
}

/** 解密平台凭据。只在本模块内使用；DEK 用完立即清零。失败时抛出的错误不含任何密钥材料。 */
function openCredential(wrapper: KeyWrapper, row: CredentialRow): string {
  const aad = credentialAad({ id: row.id, kind: row.kind, provider: row.provider, baseUrl: row.base_url });
  const dek = wrapper.unwrap(row.wrapped_dek, aad, row.kek_version);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, row.iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

function invalid(message: string): AppError {
  return new AppError(400, 'INVALID_AI_REQUEST', message);
}

function assertRequest(request: ChatRequest, settings: GatewaySettings): number {
  if (!(BILLING_PROVIDERS as readonly string[]).includes(request.provider)) throw invalid('不支持的模型服务商');
  if (typeof request.model !== 'string' || !MODEL_NAME_PATTERN.test(request.model)) throw invalid('模型名称不合法');
  if (!Array.isArray(request.messages) || request.messages.length === 0) throw invalid('消息不能为空');
  for (const message of request.messages) {
    if (!ROLES.has(message?.role) || typeof message.content !== 'string') throw invalid('消息格式不正确');
  }
  const maxOutputTokens = request.maxOutputTokens ?? settings.maxOutputTokens;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > settings.maxOutputTokens) {
    throw invalid(`最大输出 token 数应为 1 到 ${settings.maxOutputTokens} 之间的整数`);
  }
  if (request.temperature !== undefined && !(Number.isFinite(request.temperature) && request.temperature >= 0 && request.temperature <= 2)) {
    throw invalid('temperature 应在 0 到 2 之间');
  }
  if (request.source === 'job') {
    if (typeof request.jobId !== 'string' || !UUID_PATTERN.test(request.jobId)) throw invalid('任务调用必须带任务编号');
    if (request.jobType != null && !JOB_TYPE_PATTERN.test(request.jobType)) throw invalid('任务类型不合法');
    if (typeof request.stepKey !== 'string' || !STEP_KEY_PATTERN.test(request.stepKey)) throw invalid('任务调用必须带合法的步骤键');
  } else if (request.source !== 'interactive' || request.jobId != null || request.jobType != null || request.stepKey != null) {
    throw invalid('调用来源不合法');
  }
  return maxOutputTokens;
}

/** 请求内容的 SHA-256：同一步骤键下请求不同（例如暂停期间用户改了输入）就是新的调用。 */
function requestHash(request: ChatRequest, maxOutputTokens: number): Buffer {
  const canonical = JSON.stringify([
    request.provider,
    request.model,
    maxOutputTokens,
    request.temperature ?? null,
    request.messages.map((message) => [message.role, message.content]),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest();
}

const clampTokens = (value: number) => Math.min(Math.max(0, Math.floor(value)), MAX_TOKENS);

function failureError(reason: GatewayFailureReason): AppError {
  return reason === 'upstream_timeout'
    ? new AppError(504, 'AI_UPSTREAM_TIMEOUT', '模型服务响应超时，本次调用不收费')
    : new AppError(502, 'AI_UPSTREAM_ERROR', '模型服务调用失败，本次调用不收费');
}

export interface CreateAiGatewayOptions {
  db: Kysely<Database>;
  keyWrapper: KeyWrapper;
  settings: GatewaySettings;
  log: FastifyBaseLogger;
  /** 按“组织 + 服务商”的并发信号量；未配置 Redis 时为 null，不限制并发。 */
  limiter?: AiConcurrencyLimiter | null;
}

export function createAiGateway(options: CreateAiGatewayOptions): AiGateway {
  const { db, keyWrapper, settings } = options;
  const limiter = options.limiter ?? null;
  const concurrencyMax = settings.concurrencyMax ?? DEFAULT_AI_CONCURRENCY_MAX;

  /** 本组织的并发上限：组织设置（默认 10）与平台上限的较小值。 */
  async function concurrencyLimitOf(context: TenantContext): Promise<number> {
    const row = await withTenant(db, context, (trx) =>
      trx.selectFrom('org_settings').select('concurrency_limit').where('org_id', '=', context.orgId).executeTakeFirst(),
    );
    return Math.min(row?.concurrency_limit ?? DEFAULT_CONCURRENCY_LIMIT, concurrencyMax);
  }

  async function loadApiKey(context: TenantContext, provider: BillingProvider, log: FastifyBaseLogger): Promise<{ apiKey: string; baseUrl: string }> {
    const row = await withTenant(db, context, (trx) =>
      trx
        .selectFrom('provider_credentials')
        .select(['id', 'kind', 'provider', 'base_url', 'ciphertext', 'iv', 'auth_tag', 'wrapped_dek', 'kek_version'])
        .where('kind', '=', 'text_model')
        .where('provider', '=', provider)
        .executeTakeFirst(),
    );
    if (!row) throw new AppError(503, 'AI_PROVIDER_NOT_CONFIGURED', '该模型服务尚未配置，暂时无法使用');
    try {
      return { apiKey: openCredential(keyWrapper, row), baseUrl: row.base_url };
    } catch {
      // 主密钥不对、密文或 Base URL 被改动。不记录原始错误，避免带出任何密钥材料。
      log.error({ ai: { provider, credentialId: row.id, kekVersion: row.kek_version } }, 'ai credential decrypt failed');
      throw new AppError(503, 'AI_PROVIDER_UNAVAILABLE', '模型服务暂不可用，请稍后再试');
    }
  }

  /** 取得并发名额之后的部分：解密 Key、冻结、调用服务商、结算或释放。 */
  async function callWithSlot(
    context: TenantContext,
    request: ChatRequest,
    chatOptions: ChatOptions,
    log: FastifyBaseLogger,
    maxOutputTokens: number,
    step: JobStepKey | null,
  ): Promise<ChatResult> {
    const adapter = PROVIDER_ADAPTERS[request.provider];
    const credential = await loadApiKey(context, request.provider, log);
    // 调用方在此之前已经取消（例如用户在请求处理开始前就断开）：不冻结、不调用服务商。
    if (chatOptions.signal?.aborted) throw new AppError(400, 'AI_REQUEST_ABORTED', '调用已取消');

    const requestId = randomUUID();
    const startedAt = Date.now();
    const hold = await beginUsage(db, context, {
      requestId,
      source: request.source,
      jobId: request.jobId ?? null,
      jobType: request.jobType ?? null,
      provider: request.provider,
      model: request.model,
      estimatedInputTokens: clampTokens(inputTokenUpperBound(request.messages)),
      maxOutputTokens,
      holdSeconds: settings.holdTtlSeconds,
    });

    const timeout = AbortSignal.timeout(settings.upstreamTimeoutMs);
    const signal = chatOptions.signal ? AbortSignal.any([chatOptions.signal, timeout]) : timeout;
    let content = '';
    let reasoningContent = '';
    let finishReason: string | null = null;
    let providerUsage: ProviderUsage | null = null;
    let failure: GatewayFailureReason | null = null;
    let failureDetail: { status?: number; upstreamCode?: string } = {};
    let aborted = false;

    const events = streamChatCompletion({
      baseUrl: credential.baseUrl,
      path: adapter.chatPath,
      apiKey: credential.apiKey,
      body: adapter.buildBody({ model: request.model, messages: request.messages, maxOutputTokens, temperature: request.temperature }),
      signal,
      isTimeout: () => timeout.aborted,
      privateHosts: settings.upstreamPrivateHosts,
      maxResponseBytes: MAX_UPSTREAM_RESPONSE_BYTES,
    });
    try {
      let step = await events.next();
      while (!step.done) {
        const event = step.value;
        if ('error' in event) throw new UpstreamError('upstream_error');
        if (event.usage != null) providerUsage = adapter.parseUsage(event.usage) ?? providerUsage;
        const choice = Array.isArray(event.choices) ? (event.choices[0] as Record<string, unknown> | undefined) : undefined;
        const delta = (choice?.delta ?? null) as { content?: unknown; reasoning_content?: unknown } | null;
        const piece: ChatDelta = {};
        if (typeof delta?.content === 'string' && delta.content !== '') piece.content = delta.content;
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') piece.reasoningContent = delta.reasoning_content;
        if (piece.content !== undefined || piece.reasoningContent !== undefined) {
          content += piece.content ?? '';
          reasoningContent += piece.reasoningContent ?? '';
          chatOptions.onDelta?.(piece);
        }
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        step = await events.next();
      }
      // 既没有 [DONE] 也没有 finish_reason：输出被截断，按上游失败处理。
      if (!step.value.done && finishReason === null) throw new UpstreamError('invalid_upstream_response');
    } catch (error) {
      if (error instanceof UpstreamAbortedError) {
        aborted = true;
      } else if (error instanceof UpstreamError) {
        failure = error.reason;
        failureDetail = { ...(error.status ? { status: error.status } : {}), ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}) };
      } else {
        failure = 'gateway_error';
        log.error({ err: error, ai: { requestId } }, 'ai gateway error');
      }
    } finally {
      // 提前结束时关闭上游连接。
      await events.return({ done: false }).catch(() => undefined);
    }

    const summary = {
      requestId,
      usageId: hold.usageId,
      provider: request.provider,
      model: request.model,
      source: request.source,
      jobId: request.jobId ?? null,
      holdAmount: hold.holdAmount.toString(),
      durationMs: Date.now() - startedAt,
    };

    // 平台原因中止（worker 关闭、租约丢失）：续跑时会重做这一步，本次不收费。
    if (aborted && chatOptions.platformAborted?.()) {
      try {
        await failUsage(db, context, hold.usageId, 'platform_interrupted', providerUsage);
      } catch (error) {
        log.error({ err: error, ai: summary }, 'ai usage release failed');
      }
      log.warn({ ai: { ...summary, status: 'unbilled', failureReason: 'platform_interrupted' } }, 'ai call interrupted');
      throw new AppError(503, 'AI_CALL_INTERRUPTED', '调用因服务中断而停止，本次调用不收费');
    }

    if (failure !== null) {
      try {
        await failUsage(db, context, hold.usageId, failure, providerUsage);
      } catch (error) {
        // 释放失败（如数据库不可用）：冻结到期后自动释放，不会收费。
        log.error({ err: error, ai: summary }, 'ai usage release failed');
      }
      log.warn({ ai: { ...summary, status: 'unbilled', failureReason: failure, upstream: failureDetail } }, 'ai call failed');
      throw failureError(failure);
    }

    const usage: SettleUsageInput = providerUsage
      ? { ...providerUsage, usageSource: 'provider' }
      : {
          inputTokens: clampTokens(estimateInputTokens(request.messages)),
          cachedInputTokens: 0,
          outputTokens: clampTokens(estimateTokens(content) + estimateTokens(reasoningContent)),
          usageSource: 'estimated',
        };
    // 任务步骤：完整的结果与结算在同一事务中写入。被用户取消、暂停中止的部分结果不保存（续跑时重新调用）。
    if (step && !aborted) {
      const stepped = await settleJobStep(db, context, hold.usageId, step, { requestId, content, reasoningContent, finishReason }, usage);
      log.info(
        {
          ai: {
            ...summary,
            stepKey: step.stepKey,
            status: stepped.stored ? stepped.settlement.status : 'unbilled',
            failureReason: stepped.stored ? undefined : 'duplicate_step',
            amount: stepped.settlement.amount.toString(),
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            usageSource: usage.usageSource,
          },
        },
        'ai call settled',
      );
      return {
        ...stepped.result,
        aborted: false,
        reused: !stepped.stored,
        billing: { status: stepped.settlement.status, amount: stepped.settlement.amount },
      };
    }

    const settlement = await settleUsage(db, context, hold.usageId, usage);
    log.info(
      {
        ai: {
          ...summary,
          status: settlement.status,
          aborted,
          amount: settlement.amount.toString(),
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          usageSource: usage.usageSource,
        },
      },
      'ai call settled',
    );
    return {
      requestId,
      content,
      reasoningContent,
      finishReason,
      aborted,
      reused: false,
      usage,
      billing: { status: settlement.status, amount: settlement.amount },
    };
  }

  return {
    async chat(context, request, chatOptions = {}) {
      const log = chatOptions.log ?? options.log;
      const maxOutputTokens = assertRequest(request, settings);
      const step = request.source === 'job' ? { jobId: request.jobId!, stepKey: request.stepKey!, requestHash: requestHash(request, maxOutputTokens) } : null;
      if (step) {
        const stored = await findJobStepResult(db, context, step);
        if (stored) {
          log.info({ ai: { ...stored.usage, requestId: stored.requestId, jobId: step.jobId, stepKey: step.stepKey, status: 'reused' } }, 'ai call reused');
          return { ...stored, aborted: false, reused: true, billing: { status: 'unbilled', amount: 0n } };
        }
      }
      await assertModelCallable(db, context, request.provider, request.model);
      const release = limiter
        ? await limiter.acquire({
            orgId: context.orgId,
            provider: request.provider,
            limit: await concurrencyLimitOf(context),
            waitMs: chatOptions.concurrencyWaitMs ?? settings.concurrencyWaitMs ?? DEFAULT_AI_CONCURRENCY_WAIT_MS,
            signal: chatOptions.signal,
          })
        : null;
      try {
        return await callWithSlot(context, request, chatOptions, log, maxOutputTokens, step);
      } finally {
        await release?.();
      }
    },
  };
}
