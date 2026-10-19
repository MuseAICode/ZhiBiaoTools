// CSRF / 跨站校验与“默认需要登录”：不连数据库（fakeDatabase 的 db 一旦被访问即抛错）。
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createLogCapture, fakeDatabase, fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  app = await buildApp(testConfig, {
    database: fakeDatabase(),
    logStream: createLogCapture().stream,
    passwordHasher: await fastHasher(),
  });
  app.post('/test/public', { config: { access: 'public' } }, async (request) => ({ body: request.body ?? null }));
  app.post('/test/private', async () => ({ ok: true }));
  app.get('/test/private', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('跨站请求校验（改变状态的请求）', () => {
  it('同源 Origin + X-Requested-With + JSON 放行', async () => {
    const app = await setup();
    const response = await app.inject({ method: 'POST', url: '/test/public', headers: sameSiteHeaders, payload: { a: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: { a: 1 } });
  });

  it('没有请求体时不要求 Content-Type', async () => {
    const app = await setup();
    const response = await app.inject({ method: 'POST', url: '/test/public', headers: sameSiteHeaders });
    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['缺少 Origin 和 Referer', { 'x-requested-with': 'app' }],
    ['跨站 Origin', { origin: 'https://evil.example', 'x-requested-with': 'app' }],
    ['同主机不同端口', { origin: 'http://localhost:3001', 'x-requested-with': 'app' }],
    ['Origin 为 null（沙箱 iframe、本地文件）', { origin: 'null', 'x-requested-with': 'app' }],
    ['跨站 Referer', { referer: 'https://evil.example/page', 'x-requested-with': 'app' }],
    ['缺少 X-Requested-With', { origin: testConfig.publicOrigin }],
    ['X-Requested-With 值不对', { origin: testConfig.publicOrigin, 'x-requested-with': 'XMLHttpRequest' }],
  ])('%s → 403', async (_name, headers) => {
    const app = await setup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/test/public', headers: headers as Record<string, string> });
      expect(response.statusCode, method).toBe(403);
      expect(response.json().error.code).toBe('CROSS_SITE_REQUEST');
    }
  });

  it('Origin 缺失时用 Referer 判断', async () => {
    const app = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/test/public',
      headers: { referer: `${testConfig.publicOrigin}/login?next=/`, 'x-requested-with': 'app' },
    });
    expect(response.statusCode).toBe(200);
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    '跨站表单能发送的 Content-Type（%s）→ 415',
    async (contentType) => {
      const app = await setup();
      const response = await app.inject({
        method: 'POST',
        url: '/test/public',
        headers: { ...sameSiteHeaders, 'content-type': contentType },
        payload: '{"a":1}',
      });
      expect(response.statusCode).toBe(415);
    },
  );

  it('GET 不做跨站校验', async () => {
    const app = await setup();
    const response = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' } });
    expect(response.statusCode).toBe(200);
  });

  it('跨站校验先于会话解析：跨站请求不查库', async () => {
    const app = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/test/private',
      headers: { origin: 'https://evil.example', 'x-requested-with': 'app', cookie: `__Host-session=${'a'.repeat(43)}` },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('默认需要登录', () => {
  it('没有会话 Cookie 时返回 401，不查库', async () => {
    const app = await setup();
    for (const [method, url] of [['GET', '/test/private'], ['POST', '/test/private'], ['GET', '/api/auth/me']] as const) {
      const response = await app.inject({ method, url, headers: sameSiteHeaders });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('格式不对的会话令牌不查库，直接视为未登录并让浏览器删除 Cookie', async () => {
    const app = await setup();
    const response = await app.inject({ method: 'GET', url: '/test/private', headers: { cookie: "__Host-session=' OR 1=1 --" } });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toMatch(/^__Host-session=; Max-Age=0/);
  });

  it('健康检查和声明为 public 的路由无需登录；未知路由仍返回 404', async () => {
    const app = await setup();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/test/public', headers: sameSiteHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
  });
});
