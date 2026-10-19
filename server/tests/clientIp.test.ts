// 限流键中的客户端 IP（docs/SERVER_DESIGN.md 第 3.5 节）：只采信 TRUSTED_PROXIES 中的代理附加的 X-Forwarded-For。
// 用注册接口验证：限流在查库之前，令牌格式不合法时直接返回 400，不需要数据库。
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS } from '../src/auth/rateLimit.ts';
import { createLogCapture, fakeDatabase, fastHasher, sameSiteHeaders, testConfig } from './helpers.ts';

const CADDY = '172.30.0.2';
const LIMIT = 2;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(trustedProxies: readonly string[]) {
  app = await buildApp(
    { ...testConfig, trustedProxies },
    {
      database: fakeDatabase(),
      logStream: createLogCapture().stream,
      passwordHasher: await fastHasher(),
      rateLimits: { ...DEFAULT_AUTH_RATE_LIMITS, registerPerIp: { limit: LIMIT, windowMs: 60_000 } },
    },
  );
  await app.ready();
  const instance = app;
  return (remoteAddress: string, forwardedFor?: string) =>
    instance
      .inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress,
        headers: { ...sameSiteHeaders, ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }) },
        payload: { token: 'not-a-token', password: 'irrelevant' },
      })
      .then((response) => response.statusCode);
}

describe('默认不信任任何代理', () => {
  it('伪造 X-Forwarded-For 不能绕过限流：按连接对端地址计数', async () => {
    const register = await setup([]);
    expect(await register('203.0.113.10', '198.51.100.1')).toBe(400);
    expect(await register('203.0.113.10', '198.51.100.2')).toBe(400);
    expect(await register('203.0.113.10', '198.51.100.3, 198.51.100.4')).toBe(429);
    expect(await register('203.0.113.10')).toBe(429);
    // 其他客户端不受影响。
    expect(await register('203.0.113.11', '203.0.113.10')).toBe(400);
  });

  it('来自代理地址的请求同样不采信 X-Forwarded-For', async () => {
    const register = await setup([]);
    expect(await register(CADDY, '198.51.100.1')).toBe(400);
    expect(await register(CADDY, '198.51.100.2')).toBe(400);
    expect(await register(CADDY, '198.51.100.3')).toBe(429);
  });
});

describe('配置了可信代理', () => {
  it('经可信代理时按真实客户端 IP 分别计数', async () => {
    const register = await setup([CADDY]);
    for (let i = 0; i < LIMIT; i += 1) {
      expect(await register(CADDY, '198.51.100.1')).toBe(400);
      expect(await register(CADDY, '198.51.100.2')).toBe(400);
    }
    expect(await register(CADDY, '198.51.100.1')).toBe(429);
    expect(await register(CADDY, '198.51.100.2')).toBe(429);
    expect(await register(CADDY, '198.51.100.3')).toBe(400);
  });

  it('客户端经代理伪造 X-Forwarded-For：只采信代理附加的最右一项', async () => {
    const register = await setup([CADDY]);
    // 代理把真实地址 198.51.100.1 附加在客户端自带的值之后。
    expect(await register(CADDY, '1.1.1.1, 198.51.100.1')).toBe(400);
    expect(await register(CADDY, '2.2.2.2, 198.51.100.1')).toBe(400);
    expect(await register(CADDY, `${CADDY}, 198.51.100.1`)).toBe(429);
    expect(await register(CADDY, '198.51.100.1')).toBe(429);
  });

  it('绕过代理直连时不采信 X-Forwarded-For', async () => {
    const register = await setup([CADDY]);
    expect(await register('203.0.113.10', '198.51.100.1')).toBe(400);
    expect(await register('203.0.113.10', '198.51.100.2')).toBe(400);
    expect(await register('203.0.113.10', '198.51.100.3')).toBe(429);
    // 伪造的地址没有占用真实客户端的额度。
    expect(await register(CADDY, '198.51.100.1')).toBe(400);
  });

  it('CIDR 与 IPv4 映射的 IPv6 对端地址', async () => {
    const register = await setup(['172.30.0.0/24']);
    expect(await register(`::ffff:${CADDY}`, '198.51.100.1')).toBe(400);
    expect(await register('172.30.0.3', '198.51.100.1')).toBe(400);
    expect(await register(CADDY, '198.51.100.1')).toBe(429);
    expect(await register(CADDY, '198.51.100.2')).toBe(400);
  });
});
