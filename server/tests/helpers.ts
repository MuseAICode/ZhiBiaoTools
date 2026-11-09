import { Writable } from 'node:stream';
import type { Kysely } from 'kysely';
import { createPasswordHasher } from '../src/auth/password.ts';
import type { AppConfig } from '../src/config.ts';
import type { Database } from '../src/db/schema.ts';

export const testConfig: AppConfig = Object.freeze({
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'info',
  publicOrigin: 'http://localhost:3000',
  trustedProxies: Object.freeze([]),
  database: Object.freeze({
    host: '127.0.0.1',
    port: 5432,
    name: 'bidtools',
    user: 'bidtools_app',
    password: 'unused-in-unit-tests',
  }),
  ai: Object.freeze({
    kekFile: null,
    kekVersion: 1,
    upstreamTimeoutMs: 300_000,
    holdTtlSeconds: 900,
    maxOutputTokens: 8192,
    upstreamPrivateHosts: Object.freeze([]),
    concurrencyMax: 10,
    concurrencyWaitMs: 30_000,
  }),
  storage: null,
  redis: null,
  sandbox: null,
  agentEndpoint: null,
});

/** 数据库桩：单元测试不连接真实数据库，/readyz 的结果由 ping 决定；访问 db 即抛错，确保单元测试不会意外查库。 */
export function fakeDatabase(ping: () => Promise<void> = async () => {}) {
  const db = new Proxy({} as Kysely<Database>, {
    get() {
      throw new Error('单元测试不应访问数据库');
    },
  });
  return { ping, db };
}

/** 通过 CSRF 校验的请求头（同源 Origin + 自定义头）。 */
export const sameSiteHeaders = Object.freeze({ origin: testConfig.publicOrigin, 'x-requested-with': 'app' });

/** 收集日志行，供断言日志内容。 */
export function createLogCapture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    text: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** 单元测试用的低参数 argon2id，只为跑得快；真实参数的测试见 tests/auth/password.test.ts。 */
export function fastHasher() {
  return createPasswordHasher({ memory: 64, passes: 1, parallelism: 1 });
}
