// Redis 连接与 /readyz 的集成测试：需要 TEST_REDIS_URL（带 ACL 用户名）和 TEST_REDIS_PASSWORD 指向一个开启 ACL 的
// Valkey / Redis（CI 中见 .github/workflows/ci.yml；本机可用 docker-compose.yml 的 redis 服务）。
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { loadConfig, type RedisConfig } from '../../src/config.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { createRedis, type RedisHandle } from '../../src/redis.ts';
import { createLogCapture, testConfig } from '../helpers.ts';
import { createTestDatabase, type TestDatabase } from './harness.ts';

function redisConfig(): RedisConfig {
  const url = process.env.TEST_REDIS_URL;
  const password = process.env.TEST_REDIS_PASSWORD;
  if (!url || !password) {
    throw new Error('Redis 集成测试需要 TEST_REDIS_URL 和 TEST_REDIS_PASSWORD，例如 TEST_REDIS_URL=redis://bidtools@127.0.0.1:6379');
  }
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PASSWORD: 'unused', REDIS_URL: url, REDIS_PASSWORD: password }).redis;
  if (!config) throw new Error('TEST_REDIS_URL 未生效');
  return config;
}

let testDb: TestDatabase;
let app: FastifyInstance | undefined;
let database: DatabaseHandle | undefined;
let redis: RedisHandle | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterEach(async () => {
  await app?.close();
  await database?.destroy();
  await redis?.destroy();
  app = undefined;
  database = undefined;
  redis = undefined;
});

afterAll(async () => {
  await testDb?.drop();
});

/** 等待客户端完成首次连接（或确认连不上）：ping 在未连接时立即失败，不排队。 */
async function settle(handle: RedisHandle, attempts = 20): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await handle.ping();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

async function readyz(config: RedisConfig) {
  const logs = createLogCapture();
  const errors: Error[] = [];
  redis = createRedis(config, { onError: (error) => errors.push(error) });
  await settle(redis);
  database = createDatabase(testDb.appConfig);
  app = await buildApp({ ...testConfig, database: testDb.appConfig, redis: config }, { database, redis, logStream: logs.stream });
  const response = await app.inject({ method: 'GET', url: '/readyz' });
  return { response, logs, errors };
}

describe('Redis（真实 Valkey）', () => {
  it('ACL 用户和密码正确时 /readyz 返回 200', async () => {
    const { response } = await readyz(redisConfig());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('密码错误时 /readyz 返回 503，响应和日志都不含密码', async () => {
    const config = { ...redisConfig(), password: 'wrong-hunter2' };
    const { response, logs, errors } = await readyz(config);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(response.body).not.toMatch(/hunter2|6379|redis/i);
    expect(logs.lines().find((line) => line.msg === 'readiness check failed')).toMatchObject({ dependency: 'redis' });
    expect(logs.text()).not.toContain('hunter2');
    expect(errors.some((error) => /WRONGPASS/.test(error.message))).toBe(true);
    expect(errors.map((error) => error.message).join('\n')).not.toContain('hunter2');
  });

  it('default 用户已禁用：不带用户名时连接被拒绝', async () => {
    const { response } = await readyz({ ...redisConfig(), username: null });
    expect(response.statusCode).toBe(503);
  });

  it('Redis 不可达时在超时内返回 503', async () => {
    const started = Date.now();
    // 192.0.2.0/24 是文档保留地址（RFC 5737），连接会一直挂起；ping 在未连接时立即失败，不等待连接超时。
    redis = createRedis({ ...redisConfig(), host: '192.0.2.1' }, { onError: () => {} });
    database = createDatabase(testDb.appConfig);
    const logs = createLogCapture();
    app = await buildApp({ ...testConfig, database: testDb.appConfig }, { database, redis, logStream: logs.stream });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('应用用户不能执行管理命令和清空命令（ACL）', async () => {
    const { Redis } = await import('ioredis');
    const config = redisConfig();
    const client = new Redis({ host: config.host, port: config.port, username: config.username ?? undefined, password: config.password, lazyConnect: true });
    try {
      await client.connect();
      await expect(client.call('CONFIG', 'GET', 'maxmemory')).rejects.toThrow(/NOPERM/);
      await expect(client.call('FLUSHALL')).rejects.toThrow(/NOPERM/);
      await expect(client.call('ACL', 'LIST')).rejects.toThrow(/NOPERM/);
    } finally {
      client.disconnect();
    }
  });
});
