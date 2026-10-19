// 鉴权接口（docs/SERVER_DESIGN.md 第 3 节）：登录、登出、当前用户、凭邀请注册、找回密码、修改密码。
//
// - 登录失败统一返回“邮箱或密码错误”；邮箱不存在时用假哈希做一次同样耗时的校验。
// - 登录、注册、修改密码时签发新令牌（轮换），旧会话吊销。
// - 找回密码：不论邮箱是否存在都返回同样的 202，邮件在响应之后异步发送。
// - 令牌只经请求体传入；邮件中的链接把令牌放在 # 之后，不进入服务器访问日志和 Referer。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { serializeSessionCookie, clearSessionCookie, summarizeIp } from '../auth/cookie.ts';
import { normalizeEmail, EMAIL_MAX_LENGTH } from '../auth/email.ts';
import { requireSession, tenantOf } from '../auth/hooks.ts';
import {
  checkPasswordStrength,
  PASSWORD_MAX_LENGTH,
  PASSWORD_PROBLEM_MESSAGES,
  type PasswordHasher,
} from '../auth/password.ts';
import type { AuthRateLimiters, RateLimitDecision } from '../auth/rateLimit.ts';
import {
  consumeInvitation,
  createSession,
  findLoginCandidate,
  insertPersonalAccount,
  insertSession,
  isUniqueViolation,
  issuePasswordReset,
  resetPassword,
  revokeAllSessionsOfCurrentUser,
  revokeSession,
  type NewSession,
} from '../auth/store.ts';
import { generateToken, hashToken, isWellFormedToken } from '../auth/tokens.ts';
import type { Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { sendMailInBackground, type Mailer } from '../mail/mailer.ts';

export interface AuthRouteDependencies {
  db: Kysely<Database>;
  hasher: PasswordHasher;
  mailer: Mailer;
  limiters: AuthRateLimiters;
  publicOrigin: string;
}

const emailSchema = { type: 'string', minLength: 1, maxLength: EMAIL_MAX_LENGTH + 64 } as const;
/** 登录时不做强度检查，只限制长度，避免超长输入拖慢哈希。 */
const passwordSchema = { type: 'string', minLength: 1, maxLength: PASSWORD_MAX_LENGTH * 4 } as const;
const tokenSchema = { type: 'string', minLength: 1, maxLength: 128 } as const;

function bodySchema(properties: Record<string, object>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } as const;
}

const INVALID_CREDENTIALS = () => new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');

function enforce(reply: FastifyReply, ...decisions: RateLimitDecision[]): void {
  const denied = decisions.filter((decision) => !decision.allowed);
  if (denied.length === 0) return;
  const retryAfterMs = Math.max(...denied.map((decision) => decision.retryAfterMs));
  reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  throw new AppError(429, 'TOO_MANY_REQUESTS', '请求过于频繁，请稍后再试');
}

function newSessionFor(request: FastifyRequest, token: string): NewSession {
  const userAgent = request.headers['user-agent'];
  return {
    tokenHash: hashToken(token),
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
    ipSummary: summarizeIp(request.ip),
  };
}

function assertStrongPassword(password: string, email?: string): void {
  const problem = checkPasswordStrength(password, email);
  if (problem) throw new AppError(400, 'WEAK_PASSWORD', PASSWORD_PROBLEM_MESSAGES[problem]);
}

function sessionResponse(context: TenantContext) {
  return { user: { id: context.userId }, org: { id: context.orgId, role: context.role } };
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDependencies): Promise<void> {
  const { db, hasher, mailer, limiters, publicOrigin } = deps;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** 吊销请求自带的旧会话（登录时轮换令牌）；失败不影响登录。 */
  async function revokePrevious(request: FastifyRequest): Promise<void> {
    if (!request.session) return;
    try {
      await revokeSession(db, request.session);
    } catch (error) {
      request.log.warn({ err: error }, 'failed to revoke previous session');
    }
  }

  app.post<{ Body: { email: string; password: string } }>(
    '/login',
    { config: { access: 'public' }, schema: { body: bodySchema({ email: emailSchema, password: passwordSchema }) } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      // 格式不合法的邮箱同样计数，键用原始输入的小写形式。
      const emailKey = email ?? request.body.email.trim().toLowerCase();
      enforce(
        reply,
        limiters.loginPerIp.consume(request.ip),
        limiters.loginPerEmail.consume(emailKey),
        limiters.loginFailures.check(emailKey),
      );

      const candidate = email ? await findLoginCandidate(db, email) : null;
      const valid = candidate
        ? await hasher.verify(request.body.password, candidate.passwordHash)
        : await hasher.verifyDummy(request.body.password);
      if (!candidate || !valid) {
        limiters.loginFailures.recordFailure(emailKey);
        throw INVALID_CREDENTIALS();
      }
      limiters.loginFailures.reset(emailKey);

      await revokePrevious(request);
      const context: TenantContext = { orgId: candidate.orgId, userId: candidate.userId, role: candidate.role };
      const token = generateToken();
      await createSession(db, context, newSessionFor(request, token));
      reply.header('set-cookie', serializeSessionCookie(token));
      return sessionResponse(context);
    },
  );

  // 登出不要求会话有效：无论如何都清掉浏览器中的 Cookie。
  app.post('/logout', { config: { access: 'public' } }, async (request, reply) => {
    if (request.session) await revokeSession(db, request.session);
    reply.header('set-cookie', clearSessionCookie());
    return reply.code(204).send();
  });

  app.get('/me', async (request) => {
    const context = tenantOf(request);
    const user = await withTenant(db, context, (trx) =>
      trx
        .selectFrom('users')
        .select(['id', 'email', 'is_platform_admin'])
        .where('id', '=', context.userId)
        .executeTakeFirst(),
    );
    if (!user) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
    return {
      user: { id: user.id, email: user.email, isPlatformAdmin: user.is_platform_admin },
      org: { id: context.orgId, role: context.role },
    };
  });

  // 凭邀请注册：兑换邀请、创建个人组织、用户（邮箱即受邀邮箱，凭链接送达视为已验证）、成员关系和会话，
  // 全部在一个事务中；任何一步失败都整体回滚，邀请保持未用。
  app.post<{ Body: { token: string; password: string } }>(
    '/register',
    { config: { access: 'public' }, schema: { body: bodySchema({ token: tokenSchema, password: passwordSchema }) } },
    async (request, reply) => {
      enforce(reply, limiters.registerPerIp.consume(request.ip));
      const { token, password } = request.body;
      if (!isWellFormedToken(token)) throw new AppError(400, 'INVALID_INVITATION', '邀请链接无效或已过期');
      assertStrongPassword(password);
      const passwordHash = await hasher.hash(password);

      const context: TenantContext = { orgId: randomUUID(), userId: randomUUID(), role: 'owner' };
      const sessionToken = generateToken();
      let email: string;
      try {
        email = await withTenant(db, context, async (trx) => {
          const invited = await consumeInvitation(trx, hashToken(token));
          if (!invited) throw new AppError(400, 'INVALID_INVITATION', '邀请链接无效或已过期');
          assertStrongPassword(password, invited);
          await insertPersonalAccount(trx, context, { email: invited, passwordHash });
          await insertSession(trx, context, newSessionFor(request, sessionToken));
          return invited;
        });
      } catch (error) {
        if (isUniqueViolation(error, 'users_email_key')) {
          throw new AppError(409, 'EMAIL_TAKEN', '该邮箱已注册，请直接登录', { cause: error });
        }
        throw error;
      }

      await revokePrevious(request);
      reply.header('set-cookie', serializeSessionCookie(sessionToken));
      return reply.code(201).send({ ...sessionResponse(context), user: { id: context.userId, email } });
    },
  );

  app.post<{ Body: { email: string } }>(
    '/password-reset/request',
    { config: { access: 'public' }, schema: { body: bodySchema({ email: emailSchema }) } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      enforce(
        reply,
        limiters.resetRequestPerIp.consume(request.ip),
        limiters.resetRequestPerEmail.consume(email ?? request.body.email.trim().toLowerCase()),
      );
      if (email) {
        const token = generateToken();
        if (await issuePasswordReset(db, email, hashToken(token))) {
          sendMailInBackground(request.log, mailer, {
            to: email,
            subject: '重置密码',
            text:
              `我们收到了重置密码的请求。请在 30 分钟内打开下面的链接设置新密码（只能使用一次）：\n\n` +
              `${publicOrigin}/reset-password#token=${token}\n\n如果不是你本人操作，请忽略本邮件。`,
          });
        }
      }
      return reply.code(202).send({ status: 'accepted' });
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    '/password-reset/confirm',
    { config: { access: 'public' }, schema: { body: bodySchema({ token: tokenSchema, password: passwordSchema }) } },
    async (request, reply) => {
      enforce(reply, limiters.resetConfirmPerIp.consume(request.ip));
      const { token, password } = request.body;
      if (!isWellFormedToken(token)) throw new AppError(400, 'INVALID_TOKEN', '重置链接无效或已过期');
      assertStrongPassword(password);
      const passwordHash = await hasher.hash(password);
      // 函数内一次完成：令牌作废、更新密码、吊销该用户全部会话。
      if (!(await resetPassword(db, hashToken(token), passwordHash))) {
        throw new AppError(400, 'INVALID_TOKEN', '重置链接无效或已过期');
      }
      reply.header('set-cookie', clearSessionCookie());
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/password',
    { schema: { body: bodySchema({ currentPassword: passwordSchema, newPassword: passwordSchema }) } },
    async (request, reply) => {
      const session = requireSession(request);
      const context = session.context;
      enforce(reply, limiters.changePasswordPerUser.consume(context.userId));

      const user = await withTenant(db, context, (trx) =>
        trx.selectFrom('users').select(['email', 'password_hash']).where('id', '=', context.userId).executeTakeFirst(),
      );
      if (!user || !(await hasher.verify(request.body.currentPassword, user.password_hash))) {
        throw new AppError(400, 'INVALID_PASSWORD', '当前密码不正确');
      }
      assertStrongPassword(request.body.newPassword, user.email);
      const passwordHash = await hasher.hash(request.body.newPassword);

      // 吊销本人在所有组织的全部会话（含当前会话），再给当前设备签发新会话。
      const token = generateToken();
      await withTenant(db, context, async (trx) => {
        await trx
          .updateTable('users')
          .set({ password_hash: passwordHash, updated_at: sql<Date>`now()` })
          .where('id', '=', context.userId)
          .execute();
        await revokeAllSessionsOfCurrentUser(trx);
        await insertSession(trx, context, newSessionFor(request, token));
      });
      reply.header('set-cookie', serializeSessionCookie(token));
      return reply.code(204).send();
    },
  );
}
