// 平台管理员接口（docs/SERVER_DESIGN.md 第 3.4 节）：生成邀请（第一版只接受邀请注册，第 9 节第 5 项），
// 计费的手动充值、冲正和新增价格版本（第 10.4、10.5 节），平台模型白名单的登记、启用、停用（迁移 0005_platform_models），
// 以及 Agent 任务上限按组织覆盖（迁移 0035_agent_job_limit_overrides，路线图 8.3c，第 10.11 节）。
// 是否平台管理员每次从数据库读取（经 RLS，只能读到自己），不缓存在会话中，撤销后立即生效。
// 邀请表的 INSERT 策略同样要求平台管理员，应用层漏判时数据库仍会拒绝。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { normalizeEmail, EMAIL_MAX_LENGTH } from '../auth/email.ts';
import { tenantOf } from '../auth/hooks.ts';
import { PASSWORD_MAX_LENGTH, type PasswordHasher } from '../auth/password.ts';
import type { AuthRateLimiters } from '../auth/rateLimit.ts';
import { INVITATION_TTL_SECONDS } from '../auth/store.ts';
import { generateToken, hashToken } from '../auth/tokens.ts';
import {
  addImagePrice,
  addModelPrice,
  creditOrganization,
  MODEL_NAME_PATTERN,
  reverseLedgerEntry,
  type CreditType,
  type LedgerEntryResult,
} from '../billing/ledger.ts';
import { API_KEY_PATTERN, BASE_URL_MAX_LENGTH, listCredentialStatus, normalizeBaseUrl, putCredential, type CredentialStatus } from '../ai/credentials.ts';
import type { KeyWrapper } from '../ai/keyring.ts';
import { listModels, registerImageModel, registerModel, setModelEnabled, type PlatformModel } from '../ai/models.ts';
import { isValidAgentTaskLimits } from '../agent/budget.ts';
import { deleteAgentLimitOverride, listAgentLimitOverrides, setAgentLimitOverride, type AgentLimitOverride } from '../agent/limitOverrides.ts';
import { JOB_TYPE_PATTERN } from '../db/migrations/0021_jobs.ts';
import { AGENT_BUDGET_MAX_TURN_LIMIT } from '../db/migrations/0033_agent_job_budgets.ts';
import { AGENT_LIMIT_OVERRIDE_NOTE_MAX_LENGTH } from '../db/migrations/0035_agent_job_limit_overrides.ts';
import type { JobTypeRegistry } from '../jobs/definitions.ts';
import { BILLING_PROVIDERS, CREDENTIAL_KINDS, PLATFORM_MODEL_KINDS, type BillingProvider, type CredentialKind, type Database, type PlatformModelKind } from '../db/schema.ts';
import { withTenant } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { sendMailInBackground, type Mailer } from '../mail/mailer.ts';

export interface AdminRouteDependencies {
  db: Kysely<Database>;
  mailer: Mailer;
  publicOrigin: string;
  hasher: PasswordHasher;
  limiters: AuthRateLimiters;
  /** 用于加密平台凭据；未配置主密钥（AI_KEK_FILE）时为 null，凭据接口返回 503。 */
  keyWrapper: KeyWrapper | null;
  /** AI_UPSTREAM_PRIVATE_HOSTS：允许 http 的上游主机。 */
  upstreamPrivateHosts: readonly string[];
  /** 已登记的任务类型：Agent 上限覆盖只接受 agent 队列的任务类型，并返回各类型的起步值。 */
  jobRegistry: JobTypeRegistry;
}

const UUID_SCHEMA = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
/** 金额和单价以十进制整数字符串传入（计费单位），不接受 JSON 数字，避免任何浮点解析。 */
const POSITIVE_UNITS_SCHEMA = { type: 'string', pattern: '^[1-9][0-9]{0,14}$' } as const;
const UNITS_SCHEMA = { type: 'string', pattern: '^(0|[1-9][0-9]{0,14})$' } as const;
const NOTE_SCHEMA = { type: 'string', minLength: 1, maxLength: 500 } as const;
const STEP_UP_PASSWORD_SCHEMA = { type: 'string', minLength: 1, maxLength: PASSWORD_MAX_LENGTH } as const;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const MONEY_FIELDS = [
  'amount',
  'costLimit',
  'confirmAmount',
  'inputPricePerMtok',
  'outputPricePerMtok',
  'upstreamInputPricePerMtok',
  'upstreamOutputPricePerMtok',
  'imagePrice',
  'upstreamImagePrice',
] as const;

/**
 * Fastify 的校验默认会把 JSON 数字转换成字符串，所以在校验之前检查原始请求体：金额和单价必须是 JSON 字符串，
 * 不接受 JSON 数字（JSON 数字按双精度浮点解析，超过 2^53 时会静默丢精度）。
 */
async function rejectNumericMoney(request: FastifyRequest): Promise<void> {
  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== 'object') return;
  for (const field of MONEY_FIELDS) {
    if (field in body && typeof body[field] !== 'string') {
      throw new AppError(400, 'INVALID_AMOUNT', '金额必须是以计费单位表示的整数字符串');
    }
  }
}

function entryResponse(entry: LedgerEntryResult, type: string) {
  return {
    id: entry.entryId,
    orgId: entry.orgId,
    type,
    amount: entry.amount.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    createdAt: entry.createdAt.toISOString(),
  };
}

function modelResponse(model: PlatformModel) {
  return {
    id: model.id,
    provider: model.provider,
    model: model.model,
    kind: model.kind,
    isFree: model.isFree,
    enabled: model.enabled,
    status: model.status,
    note: model.note,
    inputPricePerMtok: model.inputPricePerMtok?.toString() ?? null,
    outputPricePerMtok: model.outputPricePerMtok?.toString() ?? null,
    imagePrice: model.imagePrice?.toString() ?? null,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

function limitOverrideResponse(override: AgentLimitOverride) {
  return {
    jobType: override.jobType,
    costLimit: override.costLimit.toString(),
    turnLimit: override.turnLimit,
    note: override.note,
    updatedBy: override.updatedBy,
    updatedAt: override.updatedAt.toISOString(),
  };
}

const AGENT_LIMIT_PARAMS_SCHEMA = {
  type: 'object',
  properties: { orgId: UUID_SCHEMA, jobType: { type: 'string', pattern: JOB_TYPE_PATTERN } },
  required: ['orgId', 'jobType'],
} as const;

function credentialResponse(status: CredentialStatus) {
  return { ...status, createdAt: status.createdAt.toISOString() };
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDependencies): Promise<void> {
  const { db, mailer, publicOrigin, hasher, limiters, keyWrapper, upstreamPrivateHosts, jobRegistry } = deps;
  const agentJobTypes = () => jobRegistry.types.filter((definition) => definition.queue === 'agent' && definition.agentLimits !== undefined);

  /**
   * 资金操作前的二次验证：重新输入当前密码，防止被盗用的会话直接动账。
   * 设计要求的是 TOTP（第 10.5 节），TOTP 尚未实现，所以单笔上限之上的大额充值暂时一律拒绝（迁移 0003_billing）。
   */
  async function verifyStepUp(request: FastifyRequest, reply: FastifyReply, password: string): Promise<void> {
    const context = tenantOf(request);
    const decision = await limiters.adminStepUpPerUser.consume(context.userId);
    if (!decision.allowed) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      throw new AppError(429, 'TOO_MANY_REQUESTS', '请求过于频繁，请稍后再试');
    }
    const user = await withTenant(db, context, (trx) =>
      trx.selectFrom('users').select('password_hash').where('id', '=', context.userId).executeTakeFirst(),
    );
    if (!user || !(await hasher.verify(password, user.password_hash))) {
      throw new AppError(400, 'INVALID_PASSWORD', '密码不正确');
    }
  }

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const context = tenantOf(request);
    const user = await withTenant(db, context, (trx) =>
      trx.selectFrom('users').select('is_platform_admin').where('id', '=', context.userId).executeTakeFirst(),
    );
    if (!user?.is_platform_admin) throw new AppError(403, 'FORBIDDEN', '没有权限执行此操作');
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.post<{ Body: { email: string } }>(
    '/invitations',
    {
      schema: {
        body: {
          type: 'object',
          properties: { email: { type: 'string', minLength: 1, maxLength: EMAIL_MAX_LENGTH + 64 } },
          required: ['email'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const context = tenantOf(request);
      const email = normalizeEmail(request.body.email);
      if (!email) throw new AppError(400, 'INVALID_EMAIL', '邮箱格式不正确');

      const token = generateToken();
      const invitation = await withTenant(db, context, (trx) =>
        trx
          .insertInto('invitations')
          .values({
            email,
            token_hash: hashToken(token),
            invited_by: context.userId,
            expires_at: sql<Date>`now() + make_interval(secs => ${INVITATION_TTL_SECONDS})`,
          })
          .returning(['id', 'email', 'expires_at'])
          .executeTakeFirstOrThrow(),
      );

      // 发信服务未选定前，管理员可以直接把链接转给受邀人；链接只在本次响应中出现一次。
      const link = `${publicOrigin}/register#token=${token}`;
      sendMailInBackground(request.log, mailer, {
        to: email,
        subject: '注册邀请',
        text: `你收到了注册邀请。请在 7 天内打开下面的链接设置密码完成注册（只能使用一次）：\n\n${link}`,
      });
      return reply.code(201).send({
        invitation: { id: invitation.id, email: invitation.email, expiresAt: invitation.expires_at.toISOString() },
        link,
      });
    },
  );

  app.post<{
    Body: { orgId: string; type: CreditType; amount: string; confirmAmount: string; reference?: string; note: string; password: string };
  }>(
    '/billing/credits',
    {
      preValidation: rejectNumericMoney,
      schema: {
        body: {
          type: 'object',
          properties: {
            orgId: UUID_SCHEMA,
            type: { type: 'string', enum: ['recharge', 'grant'] },
            amount: POSITIVE_UNITS_SCHEMA,
            // 二次确认：再次输入金额，两次不一致时拒绝，防止多输或少输一位。
            confirmAmount: { type: 'string', maxLength: 32 },
            reference: { type: 'string', maxLength: 200 },
            note: NOTE_SCHEMA,
            password: STEP_UP_PASSWORD_SCHEMA,
          },
          required: ['orgId', 'type', 'amount', 'confirmAmount', 'note', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.confirmAmount !== body.amount) throw new AppError(400, 'AMOUNT_MISMATCH', '两次输入的金额不一致');
      await verifyStepUp(request, reply, body.password);
      const context = tenantOf(request);
      const entry = await creditOrganization(db, context, {
        orgId: body.orgId.toLowerCase(),
        type: body.type,
        amount: BigInt(body.amount),
        reference: body.reference ?? null,
        note: body.note,
      });
      request.log.info(
        { billing: { action: 'credit', entryId: entry.entryId, orgId: entry.orgId, type: body.type, amount: entry.amount.toString(), operator: context.userId } },
        'billing credit',
      );
      return reply.code(201).send({ entry: entryResponse(entry, body.type) });
    },
  );

  app.post<{ Body: { entryId: string; note: string; password: string } }>(
    '/billing/reversals',
    {
      preValidation: rejectNumericMoney,
      schema: {
        body: {
          type: 'object',
          properties: { entryId: UUID_SCHEMA, note: NOTE_SCHEMA, password: STEP_UP_PASSWORD_SCHEMA },
          required: ['entryId', 'note', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      await verifyStepUp(request, reply, request.body.password);
      const context = tenantOf(request);
      const entry = await reverseLedgerEntry(db, context, { entryId: request.body.entryId.toLowerCase(), note: request.body.note });
      request.log.info(
        { billing: { action: 'reversal', entryId: entry.entryId, reversedEntryId: request.body.entryId, orgId: entry.orgId, amount: entry.amount.toString(), operator: context.userId } },
        'billing reversal',
      );
      return reply.code(201).send({ entry: { ...entryResponse(entry, 'reversal'), relatedEntryId: request.body.entryId.toLowerCase() } });
    },
  );

  app.post<{
    Body: {
      orgId?: string | null;
      provider: BillingProvider;
      model: string;
      inputPricePerMtok: string;
      outputPricePerMtok: string;
      effectiveFrom?: string;
      note?: string;
      upstreamInputPricePerMtok?: string;
      upstreamOutputPricePerMtok?: string;
      password: string;
    };
  }>(
    '/billing/prices',
    {
      preValidation: rejectNumericMoney,
      schema: {
        body: {
          type: 'object',
          properties: {
            orgId: { anyOf: [UUID_SCHEMA, { type: 'null' }] },
            provider: { type: 'string', enum: [...BILLING_PROVIDERS] },
            model: { type: 'string', pattern: MODEL_NAME_PATTERN.source },
            inputPricePerMtok: UNITS_SCHEMA,
            outputPricePerMtok: UNITS_SCHEMA,
            effectiveFrom: { type: 'string', maxLength: 40 },
            note: { type: 'string', maxLength: 500 },
            // 上游成本单价：两项同时提供或同时省略。
            upstreamInputPricePerMtok: UNITS_SCHEMA,
            upstreamOutputPricePerMtok: UNITS_SCHEMA,
            password: STEP_UP_PASSWORD_SCHEMA,
          },
          required: ['provider', 'model', 'inputPricePerMtok', 'outputPricePerMtok', 'password'],
          dependencies: {
            upstreamInputPricePerMtok: ['upstreamOutputPricePerMtok'],
            upstreamOutputPricePerMtok: ['upstreamInputPricePerMtok'],
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      let effectiveFrom: Date | null = null;
      if (body.effectiveFrom !== undefined) {
        effectiveFrom = ISO_TIMESTAMP_PATTERN.test(body.effectiveFrom) ? new Date(body.effectiveFrom) : new Date(NaN);
        if (Number.isNaN(effectiveFrom.getTime())) {
          throw new AppError(400, 'INVALID_EFFECTIVE_FROM', '生效时间格式不正确，应为带时区的 ISO 8601 时间');
        }
      }
      await verifyStepUp(request, reply, body.password);
      const context = tenantOf(request);
      const price = await addModelPrice(db, context, {
        orgId: body.orgId ? body.orgId.toLowerCase() : null,
        provider: body.provider,
        model: body.model,
        inputPricePerMtok: BigInt(body.inputPricePerMtok),
        outputPricePerMtok: BigInt(body.outputPricePerMtok),
        effectiveFrom,
        note: body.note ?? null,
        upstreamInputPricePerMtok: body.upstreamInputPricePerMtok === undefined ? null : BigInt(body.upstreamInputPricePerMtok),
        upstreamOutputPricePerMtok: body.upstreamOutputPricePerMtok === undefined ? null : BigInt(body.upstreamOutputPricePerMtok),
      });
      request.log.info(
        { billing: { action: 'price', priceId: price.priceId, orgId: body.orgId ?? null, provider: body.provider, model: body.model, operator: context.userId } },
        'billing price added',
      );
      return reply.code(201).send({ price: { id: price.priceId, effectiveFrom: price.effectiveFrom.toISOString() } });
    },
  );

  // 生图模型的按张价格（8.9，迁移 0045）：规则与 /billing/prices 相同（二次验证、生效时间不早于当前、金额为整数字符串）。
  app.post<{
    Body: { orgId?: string | null; provider: BillingProvider; model: string; imagePrice: string; effectiveFrom?: string; note?: string; upstreamImagePrice?: string; password: string };
  }>(
    '/billing/image-prices',
    {
      preValidation: rejectNumericMoney,
      schema: {
        body: {
          type: 'object',
          properties: {
            orgId: { anyOf: [UUID_SCHEMA, { type: 'null' }] },
            provider: { type: 'string', enum: [...BILLING_PROVIDERS] },
            model: { type: 'string', pattern: MODEL_NAME_PATTERN.source },
            imagePrice: UNITS_SCHEMA,
            effectiveFrom: { type: 'string', maxLength: 40 },
            note: { type: 'string', maxLength: 500 },
            upstreamImagePrice: UNITS_SCHEMA,
            password: STEP_UP_PASSWORD_SCHEMA,
          },
          required: ['provider', 'model', 'imagePrice', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      let effectiveFrom: Date | null = null;
      if (body.effectiveFrom !== undefined) {
        effectiveFrom = ISO_TIMESTAMP_PATTERN.test(body.effectiveFrom) ? new Date(body.effectiveFrom) : new Date(NaN);
        if (Number.isNaN(effectiveFrom.getTime())) {
          throw new AppError(400, 'INVALID_EFFECTIVE_FROM', '生效时间格式不正确，应为带时区的 ISO 8601 时间');
        }
      }
      await verifyStepUp(request, reply, body.password);
      const context = tenantOf(request);
      const price = await addImagePrice(db, context, {
        orgId: body.orgId ? body.orgId.toLowerCase() : null,
        provider: body.provider,
        model: body.model,
        imagePrice: BigInt(body.imagePrice),
        effectiveFrom,
        note: body.note ?? null,
        upstreamImagePrice: body.upstreamImagePrice === undefined ? null : BigInt(body.upstreamImagePrice),
      });
      request.log.info(
        { billing: { action: 'image_price', priceId: price.priceId, orgId: body.orgId ?? null, provider: body.provider, model: body.model, operator: context.userId } },
        'billing image price added',
      );
      return reply.code(201).send({ price: { id: price.priceId, effectiveFrom: price.effectiveFrom.toISOString() } });
    },
  );

  // 平台凭据（第 4.1~4.4 节）：只返回状态（是否已配置、末尾 4 位），任何接口都不返回明文。
  app.get('/ai/credentials', async (request) => {
    const credentials = await listCredentialStatus(db, tenantOf(request));
    return { credentials: credentials.map(credentialResponse) };
  });

  // 写入或替换某个服务商的 API Key 和 Base URL。每次都必须同时提供 Key：修改 Base URL 不沿用已保存的 Key（第 4.4 节）。
  // kind：text_model（默认，文本模型）或 image_model（生图，8.9）；两种各自保存 Base URL 与 Key。
  app.put<{ Params: { provider: BillingProvider }; Body: { kind?: CredentialKind; baseUrl: string; apiKey: string; password: string } }>(
    '/ai/credentials/:provider',
    {
      schema: {
        params: {
          type: 'object',
          properties: { provider: { type: 'string', enum: [...BILLING_PROVIDERS] } },
          required: ['provider'],
        },
        body: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...CREDENTIAL_KINDS] },
            baseUrl: { type: 'string', minLength: 1, maxLength: BASE_URL_MAX_LENGTH },
            apiKey: { type: 'string', minLength: 1, maxLength: 512 },
            password: STEP_UP_PASSWORD_SCHEMA,
          },
          required: ['baseUrl', 'apiKey', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!keyWrapper) throw new AppError(503, 'AI_GATEWAY_DISABLED', '未配置主密钥，暂时不能保存模型服务凭据');
      const body = request.body;
      const baseUrl = normalizeBaseUrl(body.baseUrl, upstreamPrivateHosts);
      if (!baseUrl) throw new AppError(400, 'INVALID_BASE_URL', 'Base URL 必须是 https 地址，且不能带用户名、查询参数或片段');
      if (!API_KEY_PATTERN.test(body.apiKey)) throw new AppError(400, 'INVALID_API_KEY', 'API Key 格式不正确');
      await verifyStepUp(request, reply, body.password);
      const context = tenantOf(request);
      const status = await putCredential(db, context, keyWrapper, { kind: body.kind ?? 'text_model', provider: request.params.provider, baseUrl, apiKey: body.apiKey });
      request.log.info(
        { ai: { action: 'credential', provider: status.provider, kind: status.kind, baseUrl: status.baseUrl, kekVersion: status.kekVersion, operator: context.userId } },
        'ai credential saved',
      );
      return reply.code(200).send({ credential: credentialResponse(status) });
    },
  );

  // 平台模型白名单：只有登记且启用、并有生效价格的服务商 + 模型才能调用。免费必须在登记时显式标记，登记后不能修改。
  app.get('/ai/models', async (request) => {
    const models = await listModels(db, tenantOf(request));
    return { models: models.map(modelResponse) };
  });

  // 登记：默认停用。登记免费模型等于让平台承担上游费用，所以与资金操作一样要求重新输入密码。
  // kind：text（默认）或 image（生图模型，8.9，按张计价）；登记后不能改。
  app.post<{ Body: { provider: BillingProvider; model: string; kind?: PlatformModelKind; isFree: boolean; note?: string; password: string } }>(
    '/ai/models',
    {
      // Fastify 的校验会把字符串 "false"、数字 0 等转换成布尔值，所以在校验之前检查：免费标记只接受 JSON 布尔值。
      preValidation: async (request) => {
        const body = request.body as Record<string, unknown> | null;
        if (body !== null && typeof body === 'object' && 'isFree' in body && typeof body.isFree !== 'boolean') {
          throw new AppError(400, 'INVALID_FREE_FLAG', 'isFree 必须是 JSON 布尔值');
        }
      },
      schema: {
        body: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: [...BILLING_PROVIDERS] },
            model: { type: 'string', pattern: MODEL_NAME_PATTERN.source },
            kind: { type: 'string', enum: [...PLATFORM_MODEL_KINDS] },
            // 必填，不设默认值：是否免费必须由管理员明确选择。
            isFree: { type: 'boolean' },
            note: { type: 'string', maxLength: 500 },
            password: STEP_UP_PASSWORD_SCHEMA,
          },
          required: ['provider', 'model', 'isFree', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      await verifyStepUp(request, reply, body.password);
      const context = tenantOf(request);
      const kind = body.kind ?? 'text';
      const input = { provider: body.provider, model: body.model, isFree: body.isFree, note: body.note ?? null };
      const model = kind === 'image' ? await registerImageModel(db, context, input) : await registerModel(db, context, input);
      request.log.info(
        { ai: { action: 'model_register', modelId: model.id, provider: body.provider, model: body.model, kind, isFree: body.isFree, operator: context.userId } },
        'ai model registered',
      );
      return reply.code(201).send({
        model: { id: model.id, provider: body.provider, model: body.model, kind, isFree: body.isFree, enabled: false, createdAt: model.createdAt.toISOString() },
      });
    },
  );

  // 启用要求重新输入密码（开始产生费用或由平台承担上游费用）；停用是收紧方向，不要求，便于紧急下线。
  app.post<{ Params: { id: string }; Body: { password: string } }>(
    '/ai/models/:id/enable',
    {
      schema: {
        params: { type: 'object', properties: { id: UUID_SCHEMA }, required: ['id'] },
        body: {
          type: 'object',
          properties: { password: STEP_UP_PASSWORD_SCHEMA },
          required: ['password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      await verifyStepUp(request, reply, request.body.password);
      const context = tenantOf(request);
      const model = await setModelEnabled(db, context, request.params.id.toLowerCase(), true);
      request.log.info(
        { ai: { action: 'model_enable', modelId: model.id, provider: model.provider, model: model.model, operator: context.userId } },
        'ai model enabled',
      );
      return { model: { ...model, updatedAt: model.updatedAt.toISOString() } };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/ai/models/:id/disable',
    { schema: { params: { type: 'object', properties: { id: UUID_SCHEMA }, required: ['id'] } } },
    async (request) => {
      const context = tenantOf(request);
      const model = await setModelEnabled(db, context, request.params.id.toLowerCase(), false);
      request.log.info(
        { ai: { action: 'model_disable', modelId: model.id, provider: model.provider, model: model.model, operator: context.userId } },
        'ai model disabled',
      );
      return { model: { ...model, updatedAt: model.updatedAt.toISOString() } };
    },
  );

  // Agent 任务上限按组织覆盖（8.3c）：列出已登记的 Agent 任务类型及起步值，以及该组织的覆盖值。
  app.get<{ Params: { orgId: string } }>(
    '/agent-limits/:orgId',
    { schema: { params: { type: 'object', properties: { orgId: UUID_SCHEMA }, required: ['orgId'] } } },
    async (request) => {
      const overrides = await listAgentLimitOverrides(db, tenantOf(request), request.params.orgId.toLowerCase());
      return {
        jobTypes: agentJobTypes().map((definition) => ({
          jobType: definition.type,
          costLimit: definition.agentLimits!.costLimit.toString(),
          turnLimit: definition.agentLimits!.turnLimit,
        })),
        overrides: overrides.map(limitOverrideResponse),
      };
    },
  );

  // 设置覆盖值：可以放宽也可以收紧，放宽等于允许该组织的单个任务花更多的钱，与资金操作一样要求重新输入密码。
  // 只影响之后入队的任务。
  app.put<{ Params: { orgId: string; jobType: string }; Body: { costLimit: string; turnLimit: number; note?: string; password: string } }>(
    '/agent-limits/:orgId/:jobType',
    {
      preValidation: async (request) => {
        await rejectNumericMoney(request);
        // Fastify 的校验会把字符串 "500" 转换成整数，所以在校验之前检查：轮数只接受 JSON 数字。
        const body = request.body as Record<string, unknown> | null;
        if (body !== null && typeof body === 'object' && 'turnLimit' in body && typeof body.turnLimit !== 'number') {
          throw new AppError(400, 'INVALID_TURN_LIMIT', '轮数上限必须是 JSON 整数');
        }
      },
      schema: {
        params: AGENT_LIMIT_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            costLimit: POSITIVE_UNITS_SCHEMA,
            turnLimit: { type: 'integer', minimum: 1, maximum: AGENT_BUDGET_MAX_TURN_LIMIT },
            note: { type: 'string', maxLength: AGENT_LIMIT_OVERRIDE_NOTE_MAX_LENGTH },
            password: STEP_UP_PASSWORD_SCHEMA,
          },
          required: ['costLimit', 'turnLimit', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { jobType } = request.params;
      const body = request.body;
      if (!agentJobTypes().some((definition) => definition.type === jobType)) {
        throw new AppError(404, 'AGENT_JOB_TYPE_NOT_FOUND', '没有这个 Agent 任务类型');
      }
      const limits = { costLimit: BigInt(body.costLimit), turnLimit: body.turnLimit };
      if (!isValidAgentTaskLimits(limits)) throw new AppError(400, 'AGENT_LIMIT_OUT_OF_RANGE', '费用上限不能超过 10,000 元，轮数上限不能超过 1,000,000');
      await verifyStepUp(request, reply, body.password);
      const context = tenantOf(request);
      const orgId = request.params.orgId.toLowerCase();
      const override = await setAgentLimitOverride(db, context, { orgId, jobType, limits, note: body.note ?? null });
      request.log.info(
        {
          agentLimit: {
            action: 'override_set',
            orgId,
            jobType,
            costLimit: override.costLimit.toString(),
            turnLimit: override.turnLimit,
            operator: context.userId,
          },
        },
        'agent limit override set',
      );
      return { override: limitOverrideResponse(override) };
    },
  );

  // 删除覆盖值，之后入队的任务恢复起步值。恢复起步值也可能是放宽，同样要求重新输入密码。
  // 不检查任务类型是否仍登记，以便清理已下线类型的覆盖值。
  app.delete<{ Params: { orgId: string; jobType: string }; Body: { password: string } }>(
    '/agent-limits/:orgId/:jobType',
    {
      schema: {
        params: AGENT_LIMIT_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: { password: STEP_UP_PASSWORD_SCHEMA },
          required: ['password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      await verifyStepUp(request, reply, request.body.password);
      const context = tenantOf(request);
      const orgId = request.params.orgId.toLowerCase();
      const { jobType } = request.params;
      const deleted = await deleteAgentLimitOverride(db, context, { orgId, jobType });
      if (!deleted) throw new AppError(404, 'AGENT_LIMIT_OVERRIDE_NOT_FOUND', '该组织没有为这个任务类型设置上限');
      request.log.info({ agentLimit: { action: 'override_delete', orgId, jobType, operator: context.userId } }, 'agent limit override deleted');
      return { deleted: true };
    },
  );
}
