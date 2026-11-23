// AI 网关的生图调用（路线图第 8 步 8.9；#70 决定事项第 11 项；docs/SERVER_DESIGN.md 第 10.12 节）。与文本调用（src/ai/gateway.ts）
// 共用平台凭据的解密、白名单、并发名额、冻结与结算、步骤幂等，计价单位是“张”（迁移 0045_ai_image_generation）：
//
// 0. 校验请求：提示词 ≤ IMAGE_PROMPT_MAX_CHARS、每次 1～MAX_IMAGES_PER_CALL 张、尺寸格式；任务调用必须带任务编号与步骤键；
// 1. 任务步骤已有结果（续跑、并发的执行者先完成）：直接取回，不冻结、不调用服务商、不扣费；
// 2. 白名单（只认 kind = image 的模型与按张的价格）→ 并发名额 → 解密生图凭据（kind = image_model，解密在 src/ai/gateway.ts 中）；
// 3. 冻结“请求张数 × 单价”：余额与**任务费用上限**在同一事务中检查（ai_image_usage_begin），不足时不调用服务商；
// 4. 调用服务商（OpenAI 兼容的 /images/generations，非流式；出站防护同文本调用）；
// 5. 服务商返回的每一张图都是不可信内容：base64 按严格的字符集与 ≤ 10 MiB 解码；网址按 src/ai/imageDownload.ts 的规则下载
//    （只允许服务商域名、仅 https、不跟随跳转、拒绝内网地址、大小与时长上限）；多于请求张数的部分丢弃；
// 6. 交给调用方的 store（worker 一侧的 src/render/generatedImages.ts：经 render-html 沙箱转成 PNG、按上传图片的规则校验、入库为图片产物）；
// 7. 按**成功入库的张数**结算（不超过冻结额）；服务商失败、超时、返回的图全部无效、调用方取消、平台中断：不收费、冻结全额释放；
//    store 自身失败（沙箱不可用、存储配额已满）同样不收费，原错误抛给调用方。
//
// 任务步骤：结果（入库的产物编号与尺寸）与结算在同一事务中写入 job_step_results；同一步骤已有结果时本次不收费（duplicate_step），
// 本次入库的图片经 discard 丢弃，返回已有的结果。
//
// 不写入日志的内容：提示词、图片、图片网址（签名网址可能带临时凭据）、API Key。
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import { MODEL_NAME_PATTERN } from '../billing/ledger.ts';
import {
  beginImageUsage,
  failUsage,
  findJobStepResult,
  imageUsage,
  settleJobStep,
  settleUsage,
  type GatewayFailureReason,
  type ImageFailureReason,
  type JobStepFailureReason,
  type JobStepKey,
  type SettlementResult,
} from '../billing/usage.ts';
import { MAX_IMAGES_PER_CALL } from '../db/migrations/0045_ai_image_generation.ts';
import { JOB_STEP_KEY_PATTERN } from '../db/migrations/0025_job_step_results.ts';
import { DEFAULT_CONCURRENCY_LIMIT } from '../db/migrations/0009_settings.ts';
import { BILLING_PROVIDERS, type BillingProvider, type Database, type UsageSource } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { IMAGE_MAX_BYTES } from '../files/policy.ts';
import type { AiConcurrencyLimiter } from './concurrency.ts';
import { downloadImage, ImageDownloadError, type ImageDownloadFailure } from './imageDownload.ts';
import type { KeyWrapper } from './keyring.ts';
import { assertImageModelCallable } from './models.ts';
import { postUpstreamJson, UpstreamAbortedError, UpstreamError } from './upstream.ts';

export { MAX_IMAGES_PER_CALL };
/** 提示词的长度上限（字符）。 */
export const IMAGE_PROMPT_MAX_CHARS = 4000;
/** 单张图片（解码后 / 下载）的大小上限：与上传图片相同（10 MiB，src/files/policy.ts）。 */
export const MAX_PROVIDER_IMAGE_BYTES = IMAGE_MAX_BYTES;
/** 服务商响应体上限：至多 MAX_IMAGES_PER_CALL 张 10 MiB 的图片经 base64 编码（约 4/3）再加少量 JSON。 */
export const MAX_IMAGE_RESPONSE_BYTES = Math.ceil((MAX_IMAGES_PER_CALL * MAX_PROVIDER_IMAGE_BYTES * 4) / 3) + 1024 * 1024;
/** 尺寸：宽 x 高（或 宽*高），每边 256～4096。 */
const SIZE_PATTERN = /^([1-9][0-9]{2,3})[x*]([1-9][0-9]{2,3})$/;
const MAX_SIDE = 4096;
const MIN_SIDE = 256;
const JOB_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const STEP_KEY_PATTERN = new RegExp(JOB_STEP_KEY_PATTERN);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const DATA_URL_PREFIX = /^data:image\/[a-z0-9.+-]{1,32};base64,/i;

/**
 * 生图服务商适配：OpenAI 兼容的 /images/generations（通义千问的 OpenAI 兼容模式，Base URL 由平台管理员与 Key 一起配置）。
 * downloadHosts 是服务商以网址返回图片时允许的域名（与凭据 Base URL 的主机一起构成下载白名单，见 src/ai/imageDownload.ts）；
 * 以“.”开头表示该域名的子域名。通义千问的生成结果放在阿里云 OSS（*.aliyuncs.com）；DeepSeek 没有生图模型，不允许下载。
 * 真实服务商的返回格式与域名在第 9 步测试环境中核对。
 */
export interface ImageProviderAdapter {
  readonly path: string;
  readonly downloadHosts: readonly string[];
  buildBody(params: { model: string; prompt: string; count: number; size: string | undefined }): Record<string, unknown>;
}

export const IMAGE_PROVIDER_ADAPTERS: Readonly<Record<BillingProvider, ImageProviderAdapter>> = Object.freeze({
  deepseek: Object.freeze({ path: '/images/generations', downloadHosts: Object.freeze([]) as readonly string[], buildBody: openAiImageBody }),
  qwen: Object.freeze({ path: '/images/generations', downloadHosts: Object.freeze(['.aliyuncs.com']) as readonly string[], buildBody: openAiImageBody }),
});

function openAiImageBody(params: { model: string; prompt: string; count: number; size: string | undefined }): Record<string, unknown> {
  // 只转已校验的字段。
  return { model: params.model, prompt: params.prompt, n: params.count, ...(params.size !== undefined ? { size: params.size } : {}) };
}

export interface ImageGatewaySettings {
  /** 单次生图请求（不含下载）的时长上限（AI_IMAGE_UPSTREAM_TIMEOUT_MS）。 */
  imageUpstreamTimeoutMs: number;
  /** 下载一张图片的时长上限（AI_IMAGE_DOWNLOAD_TIMEOUT_MS）。 */
  imageDownloadTimeoutMs: number;
  /** 生图的冻结时长（AI_IMAGE_HOLD_TTL_SECONDS）：须覆盖请求、下载、转 PNG 与入库。 */
  imageHoldTtlSeconds: number;
  upstreamPrivateHosts: readonly string[];
  concurrencyMax?: number;
  concurrencyWaitMs?: number;
}

export interface ImageRequest {
  provider: BillingProvider;
  model: string;
  /** 提示词（任务中来自 Agent，不可信；只转给服务商，不写日志）。 */
  prompt: string;
  /** 请求的张数，1～MAX_IMAGES_PER_CALL；冻结按它计算。 */
  count: number;
  size?: string | undefined;
  source: UsageSource;
  jobId?: string | null;
  jobType?: string | null;
  stepKey?: string | null;
}

/** 服务商返回的一张图（不可信）：格式只按内容判断。 */
export interface ProviderImage {
  /** 在服务商结果中的序号（从 0 起）。 */
  index: number;
  data: Buffer;
  /** 服务商声明的类型（只作参考）。 */
  declaredType: string | null;
}

/** 入库后的一张图（PNG 图片产物）。 */
export interface StoredImage {
  artifactId: string;
  width: number;
  height: number;
}

/** 单张没有入库的原因（白名单内）。 */
export type ImageItemFailure = 'image_missing' | 'image_too_large' | 'image_invalid' | 'render_failed' | `download_${ImageDownloadFailure}`;

export interface ImageStoreResult {
  stored: StoredImage[];
  failures: ImageItemFailure[];
}

export interface ImageOptions {
  /**
   * 把服务商返回的图片转成 PNG 并入库（worker 一侧见 src/render/generatedImages.ts）。只返回成功入库的；
   * 抛错表示平台一侧失败（沙箱不可用、存储配额已满等），本次不收费。
   */
  store: (images: readonly ProviderImage[]) => Promise<ImageStoreResult>;
  /** 同一步骤已有结果（并发的执行者先完成）时，丢弃本次入库的图片。 */
  discard?: (artifactIds: readonly string[]) => Promise<void>;
  signal?: AbortSignal;
  log?: FastifyBaseLogger;
  concurrencyWaitMs?: number;
  /** signal 中止时调用：true 表示平台原因（worker 关闭、租约丢失）。两种中止都不收费，记下的原因不同。 */
  platformAborted?: () => boolean;
  /** 只用于测试：下载图片时信任的自签名证书。 */
  downloadCa?: string | Buffer;
}

export interface ImageResult {
  requestId: string;
  images: StoredImage[];
  /** 服务商返回但没有入库的张数与原因（不收费）。 */
  failures: ImageItemFailure[];
  /** true：取回的是本任务同一步骤已保存的结果，本次没有扣费。 */
  reused: boolean;
  billing: { status: SettlementResult['status']; amount: bigint; images: number };
}

export interface AiImageGateway {
  generate(context: TenantContext, request: ImageRequest, options: ImageOptions): Promise<ImageResult>;
}

function invalid(message: string): AppError {
  return new AppError(400, 'INVALID_AI_REQUEST', message);
}

export function assertImageRequest(request: ImageRequest): void {
  if (!(BILLING_PROVIDERS as readonly string[]).includes(request.provider)) throw invalid('不支持的生图服务商');
  if (typeof request.model !== 'string' || !MODEL_NAME_PATTERN.test(request.model)) throw invalid('模型名称不合法');
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '' || [...request.prompt].length > IMAGE_PROMPT_MAX_CHARS) {
    throw invalid(`提示词不能为空，且不超过 ${IMAGE_PROMPT_MAX_CHARS} 个字符`);
  }
  if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > MAX_IMAGES_PER_CALL) {
    throw invalid(`每次生成 1 到 ${MAX_IMAGES_PER_CALL} 张图片`);
  }
  if (request.size !== undefined) {
    const match = typeof request.size === 'string' ? SIZE_PATTERN.exec(request.size) : null;
    const sides = match ? [Number(match[1]), Number(match[2])] : [];
    if (!match || sides.some((side) => side < MIN_SIDE || side > MAX_SIDE)) throw invalid(`图片尺寸应为“宽x高”，每边 ${MIN_SIDE}～${MAX_SIDE}`);
  }
  if (request.source === 'job') {
    if (typeof request.jobId !== 'string' || !UUID_PATTERN.test(request.jobId)) throw invalid('任务调用必须带任务编号');
    if (request.jobType != null && !JOB_TYPE_PATTERN.test(request.jobType)) throw invalid('任务类型不合法');
    if (typeof request.stepKey !== 'string' || !STEP_KEY_PATTERN.test(request.stepKey)) throw invalid('任务调用必须带合法的步骤键');
  } else if (request.source !== 'interactive' || request.jobId != null || request.jobType != null || request.stepKey != null) {
    throw invalid('调用来源不合法');
  }
}

/** 请求内容的 SHA-256（带 image 标记，不会与文本调用的请求内容相同）。 */
function imageRequestHash(request: ImageRequest): Buffer {
  const canonical = JSON.stringify(['image', request.provider, request.model, request.prompt, request.count, request.size ?? null]);
  return createHash('sha256').update(canonical, 'utf8').digest();
}

/** 步骤结果的保存形式（job_step_results.content）。 */
function stepContent(images: readonly StoredImage[]): string {
  return JSON.stringify({ images: images.map((image) => ({ artifactId: image.artifactId, width: image.width, height: image.height })) });
}

/** 取回保存的步骤结果。格式不对按“没有结果”处理是不安全的（会再扣一次费），所以抛错。 */
function parseStepContent(content: string): StoredImage[] {
  const parsed = JSON.parse(content) as { images?: unknown };
  if (!Array.isArray(parsed.images) || parsed.images.length < 1 || parsed.images.length > MAX_IMAGES_PER_CALL) throw new Error('invalid image step result');
  return parsed.images.map((item: unknown) => {
    const image = item as Record<string, unknown>;
    if (typeof image.artifactId !== 'string' || !UUID_PATTERN.test(image.artifactId)) throw new Error('invalid image step result');
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)) throw new Error('invalid image step result');
    return { artifactId: image.artifactId, width: image.width as number, height: image.height as number };
  });
}

type ParsedItem = { kind: 'b64'; value: string } | { kind: 'url'; value: string } | { kind: 'missing' };

/** 服务商响应：{ data: [{ b64_json } | { url }] }。结构不对时整次按上游响应不合法处理（不收费）。 */
function parseImageResponse(body: Record<string, unknown>, count: number): ParsedItem[] {
  if (!Array.isArray(body.data) || body.data.length === 0) throw new UpstreamError('invalid_upstream_response');
  return body.data.slice(0, count).map((raw: unknown): ParsedItem => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'missing' };
    const item = raw as Record<string, unknown>;
    if (typeof item.b64_json === 'string' && item.b64_json !== '') return { kind: 'b64', value: item.b64_json };
    if (typeof item.url === 'string' && item.url !== '') return { kind: 'url', value: item.url };
    return { kind: 'missing' };
  });
}

/** 严格解码 base64：只接受标准字符集（允许 data: 前缀），解码前按长度先拒绝超过上限的。 */
function decodeBase64Image(value: string): Buffer | 'too_large' | 'invalid' {
  const text = value.replace(DATA_URL_PREFIX, '');
  if (text.length > Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4) return 'too_large';
  if (text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) return 'invalid';
  const data = Buffer.from(text, 'base64');
  if (data.length === 0) return 'invalid';
  if (data.length > MAX_PROVIDER_IMAGE_BYTES) return 'too_large';
  return data;
}

function failureError(reason: GatewayFailureReason): AppError {
  return reason === 'upstream_timeout'
    ? new AppError(504, 'AI_UPSTREAM_TIMEOUT', '生图服务响应超时，本次调用不收费')
    : new AppError(502, 'AI_UPSTREAM_ERROR', '生图服务调用失败，本次调用不收费');
}

export interface CreateAiImageGatewayOptions {
  db: Kysely<Database>;
  keyWrapper: KeyWrapper;
  settings: ImageGatewaySettings;
  log: FastifyBaseLogger;
  limiter?: AiConcurrencyLimiter | null;
}

/** 生图流程的核心。由 src/ai/gateway.ts 的 createAiImageGateway 创建：凭据只经 loadCredential 读取（解密只在 gateway.ts 中）。 */
export function createImageGatewayCore(
  options: Omit<CreateAiImageGatewayOptions, 'keyWrapper'> & {
    concurrencyMax: number;
    concurrencyWaitMs: number;
    loadCredential: (context: TenantContext, provider: BillingProvider, log: FastifyBaseLogger) => Promise<{ apiKey: string; baseUrl: string }>;
  },
): AiImageGateway {
  const { db, settings, concurrencyMax } = options;
  const limiter = options.limiter ?? null;

  async function concurrencyLimitOf(context: TenantContext): Promise<number> {
    const row = await withTenant(db, context, (trx) =>
      trx.selectFrom('org_settings').select('concurrency_limit').where('org_id', '=', context.orgId).executeTakeFirst(),
    );
    return Math.min(row?.concurrency_limit ?? DEFAULT_CONCURRENCY_LIMIT, concurrencyMax);
  }

  /** 取回服务商给出的每一张图（不可信）：base64 解码或按规则下载；单张失败只记原因。 */
  async function collectImages(
    items: readonly ParsedItem[],
    allowedHosts: readonly string[],
    signal: AbortSignal,
    imageOptions: ImageOptions,
  ): Promise<{ images: ProviderImage[]; failures: ImageItemFailure[] }> {
    const images: ProviderImage[] = [];
    const failures: ImageItemFailure[] = [];
    for (const [index, item] of items.entries()) {
      if (item.kind === 'missing') {
        failures.push('image_missing');
      } else if (item.kind === 'b64') {
        const data = decodeBase64Image(item.value);
        if (data === 'too_large') failures.push('image_too_large');
        else if (data === 'invalid') failures.push('image_invalid');
        else images.push({ index, data, declaredType: null });
      } else {
        try {
          const downloaded = await downloadImage({
            url: item.value,
            allowedHosts,
            privateHosts: settings.upstreamPrivateHosts,
            maxBytes: MAX_PROVIDER_IMAGE_BYTES,
            timeoutMs: settings.imageDownloadTimeoutMs,
            signal,
            ca: imageOptions.downloadCa,
          });
          if (downloaded.data.length === 0) failures.push('image_invalid');
          else images.push({ index, data: downloaded.data, declaredType: downloaded.contentType });
        } catch (error) {
          if (!(error instanceof ImageDownloadError)) throw error;
          // 调用方取消：整次按取消处理。
          if (error.reason === 'aborted') throw new UpstreamAbortedError();
          failures.push(`download_${error.reason}`);
        }
      }
    }
    return { images, failures };
  }

  async function release(context: TenantContext, usageId: string, reason: GatewayFailureReason | JobStepFailureReason | ImageFailureReason, log: FastifyBaseLogger, summary: object) {
    try {
      await failUsage(db, context, usageId, reason);
    } catch (error) {
      // 释放失败（如数据库不可用）：冻结到期后自动释放，不会收费。
      log.error({ err: error, ai: summary }, 'ai image usage release failed');
    }
    log.warn({ ai: { ...summary, status: 'unbilled', failureReason: reason } }, 'ai image call failed');
  }

  async function callWithSlot(context: TenantContext, request: ImageRequest, imageOptions: ImageOptions, log: FastifyBaseLogger, step: JobStepKey | null): Promise<ImageResult> {
    const adapter = IMAGE_PROVIDER_ADAPTERS[request.provider];
    const credential = await options.loadCredential(context, request.provider, log);
    if (imageOptions.signal?.aborted) throw new AppError(400, 'AI_REQUEST_ABORTED', '调用已取消');

    const requestId = randomUUID();
    const startedAt = Date.now();
    const hold = await beginImageUsage(db, context, {
      requestId,
      source: request.source,
      jobId: request.jobId ?? null,
      jobType: request.jobType ?? null,
      provider: request.provider,
      model: request.model,
      imageCount: request.count,
      holdSeconds: settings.imageHoldTtlSeconds,
    });
    const summary = {
      requestId,
      usageId: hold.usageId,
      provider: request.provider,
      model: request.model,
      source: request.source,
      jobId: request.jobId ?? null,
      requested: request.count,
      holdAmount: hold.holdAmount.toString(),
    };
    const caller = imageOptions.signal ?? new AbortController().signal;
    const aborted = async (): Promise<never> => {
      const platform = imageOptions.platformAborted?.() ?? false;
      await release(context, hold.usageId, platform ? 'platform_interrupted' : 'caller_aborted', log, { ...summary, durationMs: Date.now() - startedAt });
      throw platform
        ? new AppError(503, 'AI_CALL_INTERRUPTED', '调用因服务中断而停止，本次调用不收费')
        : new AppError(400, 'AI_REQUEST_ABORTED', '调用已取消，本次调用不收费');
    };

    // 4～5：调用服务商并取回图片。
    let collected: { images: ProviderImage[]; failures: ImageItemFailure[] };
    try {
      const timeout = AbortSignal.timeout(settings.imageUpstreamTimeoutMs);
      const body = await postUpstreamJson({
        baseUrl: credential.baseUrl,
        path: adapter.path,
        apiKey: credential.apiKey,
        body: adapter.buildBody({ model: request.model, prompt: request.prompt, count: request.count, size: request.size }),
        signal: AbortSignal.any([caller, timeout]),
        isTimeout: () => timeout.aborted,
        privateHosts: settings.upstreamPrivateHosts,
        maxResponseBytes: MAX_IMAGE_RESPONSE_BYTES,
      });
      const items = parseImageResponse(body, request.count);
      const baseHost = new URL(credential.baseUrl).hostname.toLowerCase();
      collected = await collectImages(items, [...adapter.downloadHosts, baseHost], caller, imageOptions);
    } catch (error) {
      if (error instanceof UpstreamAbortedError) return aborted();
      const reason: GatewayFailureReason = error instanceof UpstreamError ? error.reason : 'gateway_error';
      if (!(error instanceof UpstreamError)) log.error({ err: error, ai: { requestId } }, 'ai image gateway error');
      await release(context, hold.usageId, reason, log, { ...summary, durationMs: Date.now() - startedAt, upstream: error instanceof UpstreamError ? { status: error.status, code: error.upstreamCode } : undefined });
      throw failureError(reason);
    }
    if (caller.aborted) return aborted();
    if (collected.images.length === 0) {
      await release(context, hold.usageId, 'invalid_upstream_response', log, { ...summary, failures: collected.failures, durationMs: Date.now() - startedAt });
      throw new AppError(502, 'AI_IMAGE_INVALID', '生图服务没有返回可用的图片，本次调用不收费');
    }

    // 6：转 PNG 并入库（平台一侧失败时不收费）。
    let stored: ImageStoreResult;
    try {
      stored = await imageOptions.store(collected.images);
    } catch (error) {
      if (caller.aborted) return aborted();
      await release(context, hold.usageId, 'gateway_error', log, { ...summary, durationMs: Date.now() - startedAt });
      throw error;
    }
    const failures = [...collected.failures, ...stored.failures];
    const images = stored.stored.slice(0, request.count);
    if (images.length === 0) {
      await release(context, hold.usageId, 'invalid_upstream_response', log, { ...summary, failures, durationMs: Date.now() - startedAt });
      throw new AppError(502, 'AI_IMAGE_INVALID', '生图服务没有返回可用的图片，本次调用不收费');
    }

    // 7：按入库的张数结算。
    const usage = imageUsage(images.length);
    const logSettled = (status: string, amount: bigint, extra: object = {}) =>
      log.info({ ai: { ...summary, ...extra, status, amount: amount.toString(), images: images.length, failures, durationMs: Date.now() - startedAt } }, 'ai image call settled');
    if (step) {
      const stepped = await settleJobStep(db, context, hold.usageId, step, { requestId, content: stepContent(images), reasoningContent: '', toolCalls: [], finishReason: 'stop' }, usage);
      if (!stepped.stored) {
        await imageOptions.discard?.(images.map((image) => image.artifactId));
        logSettled('unbilled', 0n, { stepKey: step.stepKey, failureReason: 'duplicate_step' });
        const existing = parseStepContent(stepped.result.content);
        return { requestId: stepped.result.requestId, images: existing, failures: [], reused: true, billing: { status: 'unbilled', amount: 0n, images: 0 } };
      }
      logSettled(stepped.settlement.status, stepped.settlement.amount, { stepKey: step.stepKey });
      return { requestId, images, failures, reused: false, billing: { status: stepped.settlement.status, amount: stepped.settlement.amount, images: images.length } };
    }
    const settlement = await settleUsage(db, context, hold.usageId, usage);
    logSettled(settlement.status, settlement.amount);
    return { requestId, images, failures, reused: false, billing: { status: settlement.status, amount: settlement.amount, images: images.length } };
  }

  return {
    async generate(context, request, imageOptions) {
      const log = imageOptions.log ?? options.log;
      assertImageRequest(request);
      const step = request.source === 'job' ? { jobId: request.jobId!, stepKey: request.stepKey!, requestHash: imageRequestHash(request) } : null;
      if (step) {
        const found = await findJobStepResult(db, context, step);
        if (found) {
          log.info({ ai: { requestId: found.requestId, jobId: step.jobId, stepKey: step.stepKey, status: 'reused' } }, 'ai image call reused');
          return { requestId: found.requestId, images: parseStepContent(found.content), failures: [], reused: true, billing: { status: 'unbilled', amount: 0n, images: 0 } };
        }
      }
      await assertImageModelCallable(db, context, request.provider, request.model);
      const releaseSlot = limiter
        ? await limiter.acquire({
            orgId: context.orgId,
            provider: request.provider,
            limit: await concurrencyLimitOf(context),
            waitMs: imageOptions.concurrencyWaitMs ?? options.concurrencyWaitMs,
            signal: imageOptions.signal,
          })
        : null;
      try {
        return await callWithSlot(context, request, imageOptions, log, step);
      } finally {
        await releaseSlot?.();
      }
    },
  };
}
