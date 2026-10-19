import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAiGateway } from './ai/gateway.ts';
import type { KeyWrapper } from './ai/keyring.ts';
import { registerAuthHooks } from './auth/hooks.ts';
import { createPasswordHasher, type PasswordHasher } from './auth/password.ts';
import { createAuthRateLimiters, DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from './auth/rateLimit.ts';
import type { AppConfig } from './config.ts';
import type { DatabaseHandle } from './db/database.ts';
import { registerErrorHandlers } from './errors.ts';
import type { ObjectStore } from './files/objectStore.ts';
import { createLoggerOptions } from './logger.ts';
import { createLogMailer, type Mailer } from './mail/mailer.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAiRoutes } from './routes/ai.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerFileRoutes, type FileRouteDependencies } from './routes/files.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerProjectRoutes } from './routes/projects.ts';

export interface BuildAppOptions {
  /** 数据库由调用方创建和关闭（src/server.ts），测试中可以替换为桩。 */
  database: Pick<DatabaseHandle, 'ping' | 'db'>;
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
  /** 对象存储（src/server.ts 按 S3_* 创建）。未提供时文件接口返回 503。 */
  objectStore?: ObjectStore | null;
  /** 测试用：替换上传并发上限和空闲超时。 */
  uploadLimits?: Pick<FileRouteDependencies, 'maxConcurrentUploads' | 'uploadIdleTimeoutMs'>;
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

  await app.register(registerHealthRoutes, { pingDatabase: () => options.database.ping() });

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
  const gateway = keyWrapper ? createAiGateway({ db, keyWrapper, settings: config.ai, log: app.log }) : null;
  await app.register(registerAiRoutes, { prefix: '/api/ai', gateway, maxOutputTokens: config.ai.maxOutputTokens });
  await app.register(registerFileRoutes, { prefix: '/api/files', db, objectStore: options.objectStore ?? null, ...options.uploadLimits });
  await app.register(registerProjectRoutes, { prefix: '/api/projects', db });

  return app;
}
