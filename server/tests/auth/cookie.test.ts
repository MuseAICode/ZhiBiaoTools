import { describe, expect, it } from 'vitest';
import { clearSessionCookie, readSessionCookie, serializeSessionCookie, summarizeIp } from '../../src/auth/cookie.ts';
import { generateToken, hashToken, isWellFormedToken } from '../../src/auth/tokens.ts';

describe('会话 Cookie', () => {
  it('__Host- 前缀，HttpOnly、Secure、SameSite=Lax、Path=/，不带 Domain', () => {
    const cookie = serializeSessionCookie('tok');
    expect(cookie).toMatch(/^__Host-session=tok; /);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toMatch(/domain/i);
    expect(clearSessionCookie()).toMatch(/^__Host-session=; Max-Age=0; .*Secure/);
  });

  it('读取 Cookie：忽略其他 Cookie，同名出现多次视为无效', () => {
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie('a=1; __Host-session=abc; b=2')).toBe('abc');
    expect(readSessionCookie('session=abc')).toBeNull();
    expect(readSessionCookie('__Host-session=abc; __Host-session=def')).toBeNull();
  });

  it('IP 只保留摘要', () => {
    expect(summarizeIp('203.0.113.77')).toBe('203.0.113.0/24');
    expect(summarizeIp('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
    expect(summarizeIp('2001:db8:1:2::1')).toBe('2001:db8:1::/48');
    expect(summarizeIp(undefined)).toBeNull();
  });
});

describe('不透明令牌', () => {
  it('256 位随机数，base64url 43 字符；哈希为 32 字节 SHA-256', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
    expect(hashToken(token)).toHaveLength(32);
    expect(isWellFormedToken(token)).toBe(true);
    expect(isWellFormedToken(`${token}x`)).toBe(false);
    expect(isWellFormedToken("' OR 1=1 --")).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
  });
});
