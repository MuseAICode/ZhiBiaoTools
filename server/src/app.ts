import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AiConcurrencyLimiter } from './ai/concurrency.ts';
import { createAiGateway } from './ai/gateway.ts';
import type { KeyWrapper } from './ai/keyring.ts';
import { registerAuthHooks } from './auth/hooks.ts';
import { createPasswordHasher, type PasswordHasher } from './auth/password.ts';
import { createAuthRateLimiters, DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from './auth/rateLimit.ts';
import type { AppConfig } from './config.ts';
import type { DatabaseHandle } from './db/database.ts';
import { registerErrorHandlers } from './errors.ts';
import type { EventHub } from './events/hub.ts';
import type { ObjectStore } from './files/objectStore.ts';
import { createLoggerOptions } from './logger.ts';
import { NULL_JOB_NOTIFIER, type JobNotifier } from './jobs/notify.ts';
import type { JobDispatcher } from './jobs/queue.ts';
import { jobTypeRegistry } from './jobs/registry.ts';
import type { JobServiceDependencies } from './jobs/service.ts';
import { createLogMailer, type Mailer } from './mail/mailer.ts';
import type { RedisHandle } from './redis.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAiRoutes } from './routes/ai.ts';
import { registerArtifactRoutes } from './routes/artifacts.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCredentialLibraryRoutes } from './routes/credentialLibrary.ts';
import { registerDuplicateCheckRoutes } from './routes/duplicateCheck.ts';
import { registerEventRoutes, type EventRouteDependencies } from './routes/events.ts';
import { registerFeasibilityReportRoutes } from './routes/feasibilityReport.ts';
import { registerFileRoutes, type FileRouteDependencies } from './routes/files.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerJobRoutes } from './routes/jobs.ts';
import { registerKnowledgeBaseRoutes } from './routes/knowledgeBase.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerRejectionCheckRoutes } from './routes/rejectionCheck.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerTechnicalPlanRoutes } from './routes/technicalPlan.ts';
import { registerTemplateRoutes } from './routes/templates.ts';

export interface BuildAppOptions {
  /** 数据库由调用方创建和关闭（src/server.ts），测试中可以替换为桩。 */
  database: Pick<DatabaseHandle, 'ping' | 'db'>;
  /** Redis 由调用方创建和关闭（src/server.ts）。未提供时 /readyz 不检查 Redis。 */
  redis?: Pick<RedisHandle, 'ping'> | null;
  /** 测试用：把日志写到指定流。 */
  logStream?: NodeJS.WritableStream;
  /** 发信实现；默认输出到日志（发信服务未选定，见 src/mail/mailer.ts）。 */
  mailer?: Mailer;
  /** 测试用：替换密码哈希实现或限流参数、时钟。 */
  passwordHasher?: PasswordHasher;
  rateLimits?: AuthRateLimitSettings;
  now?: () => number;
  /**
   * 主密钥（src/server.ts 按 AI_KEK_FILE 加载）。未提供时 AI 网关和平台凭据接口关闭，返回 503。
   * 主密钥只交给 AI 网关和凭据加密，不放进配置对象。
   */
  keyWrapper?: KeyWrapper | null;
  /** AI 网关按“组织 + 服务商”的并发信号量（src/server.ts 按 REDIS_URL 创建，由调用方关闭）。未提供时不限制并发。 */
  aiLimiter?: AiConcurrencyLimiter | null;
  /** 对象存储（src/server.ts 按 S3_* 创建）。未提供时文件接口和产物下载接口返回 503。 */
  objectStore?: ObjectStore | null;
  /** 测试用：替换上传并发上限和空闲超时。 */
  uploadLimits?: Pick<FileRouteDependencies, 'maxConcurrentUploads' | 'uploadIdleTimeoutMs'>;
  /** 事件推送（src/server.ts 按 REDIS_URL 创建，由调用方关闭）。未提供时 GET /api/events 返回 503，任务状态变化不推送。 */
  events?: { hub: EventHub; notifier: JobNotifier } | null;
  /** 测试用：替换推送连接的心跳、会话重新校验间隔和连接数上限。 */
  eventLimits?: Pick<EventRouteDependencies, 'heartbeatMs' | 'sessionCheckMs' | 'maxConnectionsPerUser'>;
  /**
   * 任务派发（src/server.ts 按 REDIS_URL 创建，由调用方关闭）。未提供时入队只写 jobs，由 worker 的对账派发（最长约 15 秒）。
   * 6.6 起导入文档后入队解析任务。
   */
  dispatcher?: JobDispatcher | null;
}

export async function buildApp(config: AppConfig, options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: createLoggerOptions({
      level: config.logLevel,
      ...(options.logStream ? { stream: options.logStream } : {}),
    }),
    // 请求 ID 由服务端生成，不采用客户端传来的值，避免日志被伪造关联。
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
    // 只采信可信代理（TRUSTED_PROXIES）附加的 X-Forwarded-For：从右往左跳过可信地址，取第一个不可信的地址作为
    // request.ip（限流键和会话的 IP 摘要）。未配置时不信任任何代理，request.ip 就是 TCP 对端地址，
    // 客户端自带的 X-Forwarded-For 一律忽略。X-Forwarded-Host / Proto 同样只在对端可信时采信；
    // CSRF 校验和邮件链接用的是配置 PUBLIC_ORIGIN，不依赖这两个头。
    trustProxy: config.trustedProxies.length > 0 ? [...config.trustedProxies] : false,
    // 请求体中 schema 未声明的字段直接拒绝（Fastify 默认静默删除），避免客户端以为多传的字段生效了。
    ajv: { customOptions: { removeAdditional: false } },
  });

  // 安全响应头，取值见 docs/SERVER_DESIGN.md 第 6.4、8.2 节。
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true, preload: false },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xFrameOptions: { action: 'deny' },
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('x-request-id', request.id);
    return payload;
  });

  registerErrorHandlers(app);
  // CSRF 校验与会话解析对全部路由生效，必须在注册路由之前添加。
  registerAuthHooks(app, { db: options.database.db, publicOrigin: config.publicOrigin, ...(options.now ? { now: options.now } : {}) });

  const redis = options.redis ?? null;
  await app.register(registerHealthRoutes, {
    pingDatabase: () => options.database.ping(),
    ...(redis ? { pingRedis: () => redis.ping() } : {}),
  });

  const db = options.database.db;
  const mailer = options.mailer ?? createLogMailer(app.log, config.nodeEnv);
  const hasher = options.passwordHasher ?? (await createPasswordHasher());
  const limiters = createAuthRateLimiters(options.rateLimits ?? DEFAULT_AUTH_RATE_LIMITS, options.now);
  await app.register(registerAuthRoutes, { prefix: '/api/auth', db, hasher, mailer, limiters, publicOrigin: config.publicOrigin });
  const keyWrapper = options.keyWrapper ?? null;
  await app.register(registerAdminRoutes, {
    prefix: '/api/admin',
    db,
    mailer,
    publicOrigin: config.publicOrigin,
    hasher,
    limiters,
    keyWrapper,
    upstreamPrivateHosts: config.ai.upstreamPrivateHosts,
  });
  const gateway = keyWrapper
    ? createAiGateway({ db, keyWrapper, settings: config.ai, log: app.log, limiter: options.aiLimiter ?? null })
    : null;
  await app.register(registerAiRoutes, { prefix: '/api/ai', gateway, maxOutputTokens: config.ai.maxOutputTokens });
  await app.register(registerFileRoutes, { prefix: '/api/files', db, objectStore: options.objectStore ?? null, ...options.uploadLimits });
  await app.register(registerProjectRoutes, { prefix: '/api/projects', db });
  await app.register(registerJobRoutes, { prefix: '/api/jobs', db, notifier: options.events?.notifier ?? NULL_JOB_NOTIFIER });
  await app.register(registerEventRoutes, { prefix: '/api/events', db, hub: options.events?.hub ?? null, ...options.eventLimits });
  // 业务接口入队任务（6.6 起：导入后的文档解析）。先写 jobs，提交后放进 BullMQ；放入失败时由 worker 的对账派发。
  const jobs: JobServiceDependencies = {
    db,
    registry: jobTypeRegistry,
    dispatcher: options.dispatcher ?? null,
    log: app.log,
    notifier: options.events?.notifier ?? NULL_JOB_NOTIFIER,
  };
  await app.register(registerArtifactRoutes, { prefix: '/api/artifacts', db, objectStore: options.objectStore ?? null });
  await app.register(registerSettingsRoutes, { prefix: '/api/settings', db });
  await app.register(registerTemplateRoutes, { prefix: '/api/export-templates', db });
  await app.register(registerCredentialLibraryRoutes, { prefix: '/api/credential-library', db });
  await app.register(registerKnowledgeBaseRoutes, { prefix: '/api/knowledge-base', db, objectStore: options.objectStore ?? null, jobs });
  await app.register(registerDuplicateCheckRoutes, { prefix: '/api/projects', db, jobs });
  await app.register(registerRejectionCheckRoutes, { prefix: '/api/projects', db, objectStore: options.objectStore ?? null, jobs });
  await app.register(registerFeasibilityReportRoutes, { prefix: '/api/projects', db, objectStore: options.objectStore ?? null, jobs });
  await app.register(registerTechnicalPlanRoutes, { prefix: '/api/projects', db, objectStore: options.objectStore ?? null, jobs });

  return app;
}
