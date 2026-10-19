import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { createLogCapture, testConfig } from '../helpers.ts';
import { createTestDatabase, type TestDatabase } from './harness.ts';

let testDb: TestDatabase;
let app: FastifyInstance | undefined;
let database: DatabaseHandle | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterEach(async () => {
  await app?.close();
  await database?.destroy();
  app = undefined;
  database = undefined;
});

afterAll(async () => {
  await testDb?.drop();
});

async function inject(config: TestDatabase['appConfig']) {
  const logs = createLogCapture();
  database = createDatabase(config);
  app = await buildApp({ ...testConfig, database: config }, { database, logStream: logs.stream });
  return app.inject({ method: 'GET', url: '/readyz' });
}

describe('GET /readyz（真实数据库）', () => {
  it('应用角色能连上时返回 200', async () => {
    const response = await inject(testDb.appConfig);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('密码错误时返回 503，不暴露数据库信息', async () => {
    const response = await inject({ ...testDb.appConfig, password: 'wrong-hunter2' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(response.body).not.toMatch(/hunter2|bidtools|password|5432/);
  });

  it('数据库不可达时在超时内返回 503', async () => {
    const started = Date.now();
    // 192.0.2.0/24 是文档保留地址（RFC 5737），连接会一直挂起直到超时。
    const response = await inject({ ...testDb.appConfig, host: '192.0.2.1' });
    expect(response.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
