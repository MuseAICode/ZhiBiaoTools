// 登录、注册、找回密码限流的 Redis 共享计数（src/auth/rateLimitStore.ts；路线图第 6 步 6.14）。
// 需要 TEST_REDIS_URL / TEST_REDIS_PASSWORD（见 tests/db/redis.test.ts）；接口测试另需 TEST_DATABASE_ADMIN_URL。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createRedisRateLimitStore, rateLimitKey, type RateLimitStore } from '../../src/auth/rateLimitStore.ts';
import { loadConfig, type RedisConfig } from '../../src/config.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { createLogCapture, fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

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

const prefix = `test:ratelimit:${randomUUID()}`;
let testDb: TestDatabase;
let inspector: Redis;
const stores: RateLimitStore[] = [];
const apps: FastifyInstance[] = [];
const databases: DatabaseHandle[] = [];

async function newStore(storePrefix = prefix): Promise<RateLimitStore> {
  const store = createRedisRateLimitStore(redisConfig(), { prefix: storePrefix });
  stores.push(store);
  await store.ready();
  return store;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  const config = redisConfig();
  inspector = new Redis({ host: config.host, port: config.port, ...(config.username ? { username: config.username } : {}), password: config.password });
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

afterAll(async () => {
  const keys = await inspector.keys(`${prefix}:*`);
  if (keys.length > 0) await inspector.del(...keys);
  await inspector.quit();
  await testDb?.drop();
});

describe('固定窗口', () => {
  it('窗口内最多 limit 次，被拒绝时给出剩余时长，窗口结束后恢复，各键独立', async () => {
    const store = await newStore();
    const options = { limit: 2, windowMs: 400 };
    expect((await store.consumeWindow('w1', 'a', options)).allowed).toBe(true);
    expect((await store.consumeWindow('w1', 'a', options)).allowed).toBe(true);
    const denied = await store.consumeWindow('w1', 'a', options);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(400);
    // 被拒绝的请求不计数、不延长窗口。
    expect(await inspector.get(rateLimitKey(prefix, 'w1', 'a'))).toBe('2');
    expect((await store.consumeWindow('w1', 'b', options)).allowed).toBe(true);
    expect((await store.consumeWindow('w2', 'a', options)).allowed).toBe(true);

    await sleep(450);
    expect((await store.consumeWindow('w1', 'a', options)).allowed).toBe(true);
  });

  it('多个实例共用一份限额', async () => {
    const first = await newStore();
    const second = await newStore();
    const options = { limit: 3, windowMs: 60_000 };
    expect((await first.consumeWindow('shared', 'ip', options)).allowed).toBe(true);
    expect((await second.consumeWindow('shared', 'ip', options)).allowed).toBe(true);
    expect((await first.consumeWindow('shared', 'ip', options)).allowed).toBe(true);
    expect((await second.consumeWindow('shared', 'ip', options)).allowed).toBe(false);
  });

  it('键中不出现原始邮箱，并带过期时间', async () => {
    const store = await newStore();
    await store.consumeWindow('email', 'Someone@Example.com', { limit: 5, windowMs: 60_000 });
    const keys = await inspector.keys(`${prefix}:email:*`);
    expect(keys).toEqual([rateLimitKey(prefix, 'email', 'Someone@Example.com')]);
    expect(keys[0]).not.toMatch(/example/i);
    expect(keys[0]).toMatch(/^.+:email:[0-9a-f]{32}$/);
    const ttl = await inspector.pttl(keys[0]!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});

describe('连续失败退避', () => {
  const options = { freeFailures: 1, baseDelayMs: 200, maxDelayMs: 400 };

  it('超过 freeFailures 后指数退避并有上限，成功后清零', async () => {
    const store = await newStore();
    await store.recordBackoffFailure('login', 'k', options);
    expect((await store.checkBackoff('login', 'k')).allowed).toBe(true);

    await store.recordBackoffFailure('login', 'k', options);
    const first = await store.checkBackoff('login', 'k');
    expect(first.allowed).toBe(false);
    expect(first.retryAfterMs).toBeGreaterThan(100);
    expect(first.retryAfterMs).toBeLessThanOrEqual(200);

    await store.recordBackoffFailure('login', 'k', options);
    expect((await store.checkBackoff('login', 'k')).retryAfterMs).toBeGreaterThan(300);
    await store.recordBackoffFailure('login', 'k', options);
    // 上限 400 毫秒。
    expect((await store.checkBackoff('login', 'k')).retryAfterMs).toBeLessThanOrEqual(400);

    await store.resetBackoff('login', 'k');
    expect((await store.checkBackoff('login', 'k')).allowed).toBe(true);
    expect(await inspector.exists(rateLimitKey(prefix, 'login', 'k'))).toBe(0);
  });

  it('锁定到期后放行；最近一次失败超过 maxDelayMs 后记录作废', async () => {
    const store = await newStore();
    await store.recordBackoffFailure('login', 'expire', options);
    await store.recordBackoffFailure('login', 'expire', options);
    expect((await store.checkBackoff('login', 'expire')).allowed).toBe(false);
    await sleep(250);
    expect((await store.checkBackoff('login', 'expire')).allowed).toBe(true);
    await sleep(200);
    // 记录已过期：再失败一次按第 1 次算，不锁定。
    expect(await inspector.exists(rateLimitKey(prefix, 'login', 'expire'))).toBe(0);
    await store.recordBackoffFailure('login', 'expire', options);
    expect((await store.checkBackoff('login', 'expire')).allowed).toBe(true);
  });

  it('失败次数很多时锁定时长仍不超过上限', async () => {
    const store = await newStore();
    for (let i = 0; i < 80; i += 1) await store.recordBackoffFailure('login', 'many', options);
    const decision = await store.checkBackoff('login', 'many');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBeLessThanOrEqual(400);
  });
});

describe('登录接口', () => {
  const STRICT: AuthRateLimitSettings = { ...DEFAULT_AUTH_RATE_LIMITS, loginPerIp: { limit: 2, windowMs: 60_000 } };

  async function newApp(store: RateLimitStore | null, trustedProxies: readonly string[] = []): Promise<FastifyInstance> {
    const database = createDatabase(testDb.appConfig);
    databases.push(database);
    const app = await buildApp(
      { ...testConfig, database: testDb.appConfig, trustedProxies },
      {
        database,
        logStream: createLogCapture().stream,
        passwordHasher: await fastHasher(),
        rateLimits: STRICT,
        rateLimitStore: store,
        mailer: { send: async () => undefined },
      },
    );
    apps.push(app);
    return app;
  }

  function login(app: FastifyInstance, ip: string, forwardedFor?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...sameSiteHeaders, ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }) },
      payload: { email: 'nobody@example.com', password: 'wrong-password-123' },
      remoteAddress: ip,
    });
  }

  it('两个 api 实例按同一份限额计数', async () => {
    const first = await newApp(await newStore());
    const second = await newApp(await newStore());
    const ip = `10.${Math.floor(Math.random() * 250)}.0.1`;
    expect((await login(first, ip)).statusCode).toBe(401);
    expect((await login(second, ip)).statusCode).toBe(401);
    const limited = await login(first, ip);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login(second, ip)).statusCode).toBe(429);
  });

  it('Redis 不可用时退回进程内存计数，照常限流', async () => {
    const broken = createRedisRateLimitStore({ ...redisConfig(), port: 1 }, { prefix });
    stores.push(broken);
    const app = await newApp(broken);
    expect((await login(app, '10.255.0.1')).statusCode).toBe(401);
    expect((await login(app, '10.255.0.1')).statusCode).toBe(401);
    expect((await login(app, '10.255.0.1')).statusCode).toBe(429);
  });

  // 计数存在 Redis 时，按 IP 的键仍取 request.ip（Fastify 按 TRUSTED_PROXIES 解析，见 src/app.ts 的 trustProxy），
  // 与 tests/clientIp.test.ts（进程内存计数）的规则相同。每个用例用独立前缀，直接核对 Redis 中按哪个 IP 计数。
  describe('客户端 IP（TRUSTED_PROXIES）', () => {
    const CADDY = '172.30.0.2';

    async function setup(trustedProxies: readonly string[]) {
      const ownPrefix = `${prefix}:ip:${randomUUID()}`;
      const app = await newApp(await newStore(ownPrefix), trustedProxies);
      const countFor = async (ip: string) => Number((await inspector.get(rateLimitKey(ownPrefix, 'loginPerIp', ip))) ?? 0);
      return { app, countFor };
    }

    it('默认不信任代理：伪造 X-Forwarded-For 不能绕过，按连接对端地址计数', async () => {
      const { app, countFor } = await setup([]);
      expect((await login(app, '203.0.113.10', '198.51.100.1')).statusCode).toBe(401);
      expect((await login(app, '203.0.113.10', '198.51.100.2')).statusCode).toBe(401);
      expect((await login(app, '203.0.113.10', '198.51.100.3, 198.51.100.4')).statusCode).toBe(429);
      expect(await countFor('203.0.113.10')).toBe(2);
      for (const forged of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) expect(await countFor(forged)).toBe(0);
    });

    it('经可信代理时按真实客户端计数，客户端在左侧伪造的值不被采信', async () => {
      const { app, countFor } = await setup([CADDY]);
      // 代理把真实地址 198.51.100.1 附加在客户端自带的值之后。
      expect((await login(app, CADDY, '1.1.1.1, 198.51.100.1')).statusCode).toBe(401);
      expect((await login(app, CADDY, '2.2.2.2, 198.51.100.1')).statusCode).toBe(401);
      expect((await login(app, CADDY, `${CADDY}, 198.51.100.1`)).statusCode).toBe(429);
      expect((await login(app, CADDY, '198.51.100.2')).statusCode).toBe(401);
      expect(await countFor('198.51.100.1')).toBe(2);
      expect(await countFor('198.51.100.2')).toBe(1);
      for (const ip of ['1.1.1.1', '2.2.2.2', CADDY]) expect(await countFor(ip)).toBe(0);
    });

    it('绕过可信代理直连时不采信 X-Forwarded-For', async () => {
      const { app, countFor } = await setup([CADDY]);
      expect((await login(app, '203.0.113.20', '198.51.100.1')).statusCode).toBe(401);
      expect((await login(app, '203.0.113.20', '198.51.100.2')).statusCode).toBe(401);
      expect((await login(app, '203.0.113.20', '198.51.100.3')).statusCode).toBe(429);
      expect(await countFor('203.0.113.20')).toBe(2);
      expect(await countFor('198.51.100.1')).toBe(0);
      // 伪造的地址没有占用真实客户端的额度。
      expect((await login(app, CADDY, '198.51.100.1')).statusCode).toBe(401);
    });
  });
});
