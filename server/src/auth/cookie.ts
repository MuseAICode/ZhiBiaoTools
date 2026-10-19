// 会话 Cookie（docs/SERVER_DESIGN.md 第 3.2 节）：__Host- 前缀要求 Secure、Path=/、不带 Domain，
// 浏览器据此拒绝子域或明文 HTTP 页面覆盖它。HttpOnly 使脚本读不到；SameSite=Lax 挡住跨站的子请求和表单 POST。
import { SESSION_ABSOLUTE_TTL_SECONDS } from './store.ts';

export const SESSION_COOKIE = '__Host-session';

const ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Lax';

export function serializeSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_ABSOLUTE_TTL_SECONDS}; ${ATTRIBUTES}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
}

/** 从 Cookie 请求头取会话令牌；同名 Cookie 出现多次时视为无效（不猜测哪一个可信）。 */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  let found: string | null = null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    if (found !== null) return null;
    found = part.slice(eq + 1).trim();
  }
  return found;
}

/** 会话中只记 IP 摘要：IPv4 保留 /24，IPv6 保留 /48。 */
export function summarizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(':')) {
    const groups = ip.split('::', 1)[0]!.split(':').filter(Boolean).slice(0, 3);
    while (groups.length < 3) groups.push('0');
    return `${groups.join(':')}::/48`;
  }
  return null;
}
