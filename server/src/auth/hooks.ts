// 全局请求钩子：CSRF / 跨站校验（第 3.3 节）和会话解析（第 3.4 节）。
//
// - 改变状态的请求（GET / HEAD / OPTIONS 以外）必须同时满足：Origin（缺失时看 Referer）是本站、
//   带 X-Requested-With: app、有请求体时 Content-Type 是 application/json。跨站表单和简单请求都做不到。
//   声明了 config.uploadBody 的路由（文件上传）改为只接受 application/octet-stream，同样不是跨站表单能发送的类型。
// - 会话：从 __Host-session Cookie 取令牌，经 auth_session_lookup 按哈希查找；有效则挂到 request.auth，
//   最近活动时间超过 10 分钟时滑动续期。
// - 默认需要登录。只有声明了 config.access = 'public' 的路由（登录、注册、找回密码、健康检查）和未知路由放行。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { clearSessionCookie, readSessionCookie } from './cookie.ts';
import { findSession, SESSION_TOUCH_INTERVAL_MS, touchSession, type SessionRecord } from './store.ts';
import { hashToken, isWellFormedToken } from './tokens.ts';

export type RouteAccess = 'public';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** 不声明即需要登录。 */
    access?: RouteAccess;
    /** 请求体是原始文件内容（application/octet-stream），不是 JSON。 */
    uploadBody?: boolean;
  }
  interface FastifyRequest {
    /** 已登录时为当前会话，否则为 null。 */
    session: SessionRecord | null;
  }
}

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'app';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestSource(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (typeof origin === 'string') return origin;
  const referer = request.headers.referer;
  if (typeof referer !== 'string') return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function assertSameSite(request: FastifyRequest, publicOrigin: string): void {
  if (requestSource(request) !== publicOrigin || request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
    throw new AppError(403, 'CROSS_SITE_REQUEST', '请求来源不被允许');
  }
  const contentType = request.headers['content-type'];
  const allowed = request.routeOptions.config?.uploadBody ? /^application\/octet-stream\s*$/i : /^application\/json\s*(?:;|$)/i;
  if (contentType !== undefined && !allowed.test(contentType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '不支持的内容类型');
  }
}

export interface AuthHookOptions {
  db: Kysely<Database>;
  publicOrigin: string;
  now?: () => number;
}

export function registerAuthHooks(app: FastifyInstance, options: AuthHookOptions): void {
  const now = options.now ?? Date.now;
  // text/plain 是跨站可以直接发送的“简单请求”类型，不接受。
  app.removeContentTypeParser('text/plain');
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (request, reply) => {
    if (!SAFE_METHODS.has(request.method)) assertSameSite(request, options.publicOrigin);

    const token = readSessionCookie(request.headers.cookie);
    if (token !== null) {
      const record = isWellFormedToken(token) ? await findSession(options.db, hashToken(token)) : null;
      if (record) {
        request.session = record;
        if (now() - record.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
          await touchSession(options.db, record);
        }
      } else {
        // 过期、吊销或伪造的令牌：让浏览器删掉。
        reply.header('set-cookie', clearSessionCookie());
      }
    }

    if (request.routeOptions.config?.access === 'public' || request.is404) return;
    if (!request.session) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
  });
}

/** 已登录路由中取当前上下文；钩子已保证存在。 */
export function requireSession(request: FastifyRequest): SessionRecord {
  if (!request.session) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
  return request.session;
}

export function tenantOf(request: FastifyRequest): TenantContext {
  return requireSession(request).context;
}
