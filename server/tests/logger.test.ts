import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { REDACTED } from '../src/logger.ts';
import { createLogCapture, fakeDatabase, testConfig } from './helpers.ts';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('日志脱敏', () => {
  it('凭据字段在任意前两层嵌套中都被替换', async () => {
    const logs = createLogCapture();
    app = await buildApp(testConfig, { database: fakeDatabase(), logStream: logs.stream });
    app.log.info(
      {
        apiKey: 'sk-top',
        provider: { api_key: 'sk-nested', baseUrl: 'https://api.example.com' },
        user: { profile: { password: 'pw-deep' } },
        headers: { authorization: 'Bearer abc', cookie: 'session=xyz', 'set-cookie': 'session=new' },
      },
      'test entry',
    );

    const text = logs.text();
    for (const secret of ['sk-top', 'sk-nested', 'pw-deep', 'Bearer abc', 'session=xyz', 'session=new']) {
      expect(text).not.toContain(secret);
    }
    const entry = logs.lines().find((line) => line.msg === 'test entry');
    expect(entry).toMatchObject({
      apiKey: REDACTED,
      provider: { api_key: REDACTED, baseUrl: 'https://api.example.com' },
      user: { profile: { password: REDACTED } },
      headers: { authorization: REDACTED, cookie: REDACTED, 'set-cookie': REDACTED },
    });
  });

  it('请求日志只记录方法和路径，不记录查询串和请求头', async () => {
    const logs = createLogCapture();
    app = await buildApp(testConfig, { database: fakeDatabase(), logStream: logs.stream });
    await app.inject({
      method: 'GET',
      url: '/reset-password?token=one-time-secret',
      headers: { authorization: 'Bearer abc', cookie: 'session=xyz' },
    });

    const text = logs.text();
    expect(text).not.toContain('one-time-secret');
    expect(text).not.toContain('Bearer abc');
    expect(text).not.toContain('session=xyz');
    const incoming = logs.lines().find((line) => line.msg === 'incoming request');
    expect(incoming?.req).toEqual({ method: 'GET', path: '/reset-password' });
  });
});
