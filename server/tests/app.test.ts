import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { AppError } from '../src/errors.ts';
import { createLogCapture, fakeDatabase, fastHasher, sameSiteHeaders, testConfig } from './helpers.ts';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(register?: (instance: FastifyInstance) => void, database = fakeDatabase()) {
  const logs = createLogCapture();
  app = await buildApp(testConfig, { database, logStream: logs.stream, passwordHasher: await fastHasher() });
  // 测试中临时注册的路由不需要登录。
  app.addHook('onRoute', (route) => {
    route.config = { ...route.config, access: 'public' };
  });
  register?.(app);
  await app.ready();
  return { app, logs };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('GET /healthz', () => {
  it('返回 200 和固定内容，不暴露版本等内部信息', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('正常请求不写 info 级日志', async () => {
    const { app, logs } = await setup();
    await app.inject({ method: 'GET', url: '/healthz' });
    expect(logs.text()).not.toContain('/healthz');
  });
});

describe('GET /readyz', () => {
  it('数据库可用时返回 200', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('数据库不可用时返回 503，响应不含错误细节，原因写入日志', async () => {
    const detail = 'connect ECONNREFUSED 10.0.0.5:5432 password authentication failed for user "bidtools_app"';
    const { app, logs } = await setup(undefined, fakeDatabase(async () => {
      throw new Error(detail);
    }));
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(response.body).not.toMatch(/ECONNREFUSED|5432|bidtools_app|database/);
    const entry = logs.lines().find((line) => line.msg === 'readiness check failed');
    expect(entry).toMatchObject({ level: 40, dependency: 'database' });
    expect(JSON.stringify(entry)).toContain('ECONNREFUSED');
  });

  it('/healthz 不检查数据库：数据库不可用时仍返回 200', async () => {
    let pinged = false;
    const { app } = await setup(undefined, fakeDatabase(async () => {
      pinged = true;
      throw new Error('down');
    }));
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(pinged).toBe(false);
  });
});

describe('安全响应头', () => {
  it.each(['/healthz', '/readyz', '/not-found'])('%s 带安全响应头', async (url) => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url });
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'self';img-src 'self' blob: data:;object-src 'none';frame-ancestors 'none';base-uri 'self'",
    );
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(response.headers['x-request-id']).toMatch(UUID_PATTERN);
  });
});

describe('请求 ID', () => {
  it('不采用客户端传入的请求 ID', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'request-id': 'forged', 'x-request-id': 'forged' },
    });
    expect(response.headers['x-request-id']).toMatch(UUID_PATTERN);
  });
});

describe('统一错误处理', () => {
  const internalDetail = 'connect ECONNREFUSED 10.0.0.5:5432 password=hunter2';

  it('未知路由返回统一的 404', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body).toEqual({ error: { code: 'NOT_FOUND', message: '资源不存在', requestId: expect.any(String) } });
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('未预期的异常返回 500 通用文案，不泄露消息和堆栈，但写入日志', async () => {
    const { app, logs } = await setup((instance) => {
      instance.get('/boom', async () => {
        throw new Error(internalDetail);
      });
    });
    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误', requestId: response.headers['x-request-id'] },
    });
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toMatch(/\bat \S+ \(/);

    const errorLog = logs.lines().find((line) => line.msg === 'request failed');
    expect(errorLog).toMatchObject({ level: 50, reqId: response.headers['x-request-id'] });
    expect(JSON.stringify(errorLog)).toContain('ECONNREFUSED');
  });

  it('非 Error 的抛出值同样按 500 处理', async () => {
    const { app } = await setup((instance) => {
      instance.get('/throw-string', async () => {
        throw internalDetail;
      });
    });
    const response = await app.inject({ method: 'GET', url: '/throw-string' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('hunter2');
  });

  it('带 5xx statusCode 的内部错误不透传消息', async () => {
    const { app } = await setup((instance) => {
      instance.get('/bad-gateway', async () => {
        throw Object.assign(new Error(internalDetail), { statusCode: 502 });
      });
    });
    const response = await app.inject({ method: 'GET', url: '/bad-gateway' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('hunter2');
  });

  it('AppError 返回其状态码、错误码和面向用户的文案', async () => {
    const { app } = await setup((instance) => {
      instance.get('/conflict', async () => {
        throw new AppError(409, 'TASK_RUNNING', '同类任务正在运行', { cause: new Error(internalDetail) });
      });
    });
    const response = await app.inject({ method: 'GET', url: '/conflict' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'TASK_RUNNING', message: '同类任务正在运行' });
    expect(response.body).not.toContain('hunter2');
  });

  it('JSON 解析失败返回 400 通用文案，不带解析器细节', async () => {
    const { app } = await setup((instance) => {
      instance.post('/echo', async (request) => request.body);
    });
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { ...sameSiteHeaders, 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'BAD_REQUEST', message: '请求不合法' });
    expect(response.body).not.toMatch(/JSON|FST_/);
  });

  it('入参校验失败返回 400，不回显 schema 结构', async () => {
    const { app } = await setup((instance) => {
      instance.post(
        '/typed',
        {
          schema: {
            body: {
              type: 'object',
              properties: { internalFieldName: { type: 'integer' } },
              required: ['internalFieldName'],
            },
          },
        },
        async () => ({ ok: true }),
      );
    });
    const response = await app.inject({ method: 'POST', url: '/typed', headers: sameSiteHeaders, payload: { other: 1 } });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('internalFieldName');
  });

  it('不支持的内容类型返回 415', async () => {
    const { app } = await setup((instance) => {
      instance.post('/echo', async (request) => request.body);
    });
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { ...sameSiteHeaders, 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('请求体超过上限返回 413', async () => {
    const { app } = await setup((instance) => {
      instance.post('/echo', async (request) => request.body);
    });
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { ...sameSiteHeaders, 'content-type': 'application/json' },
      payload: JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 1) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
