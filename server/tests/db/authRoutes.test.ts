// 鉴权接口端到端测试（真实数据库）：平台管理员命令行、登录、会话、登出、邀请注册、找回密码、修改密码、限流。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import type { PasswordHasher } from '../../src/auth/password.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { MailMessage } from '../../src/mail/mailer.ts';
import { createLogCapture, fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'tidy-orbit-lantern-42';
const NEW_PASSWORD = 'brisk-meadow-copper-77';

/** 宽松的限流参数：功能测试不受限流干扰；限流单独测试。 */
const RELAXED_LIMITS: AuthRateLimitSettings = Object.fromEntries(
  Object.entries(DEFAULT_AUTH_RATE_LIMITS).map(([key, value]) => [
    key,
    'limit' in value ? { ...value, limit: 10_000 } : { ...value, freeFailures: 10_000 },
  ]),
) as unknown as AuthRateLimitSettings;

let testDb: TestDatabase;
let admin: Kysely<Database>;
const handles: DatabaseHandle[] = [];
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  admin = testDb.admin as Kysely<Database>;
});

afterAll(async () => {
  for (const app of apps) await app.close();
  for (const handle of handles) await handle.destroy();
  await testDb?.drop();
});

const createAdminEntry = fileURLToPath(new URL('../../src/cli/create-admin.ts', import.meta.url));

function runCreateAdmin(args: string[], stdin: string) {
  return spawnSync(process.execPath, [createAdminEntry, ...args], {
    env: {
      PATH: process.env.PATH,
      DATABASE_HOST: testDb.ownerConfig.host,
      DATABASE_PORT: String(testDb.ownerConfig.port),
      DATABASE_NAME: testDb.name,
      MIGRATION_DATABASE_USER: testDb.ownerConfig.user,
      MIGRATION_DATABASE_PASSWORD: testDb.ownerConfig.password,
    },
    input: stdin,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

interface Harness {
  app: FastifyInstance;
  mails: MailMessage[];
  logs: ReturnType<typeof createLogCapture>;
  hasherCalls: { verify: number; verifyDummy: number };
  call(method: 'GET' | 'POST', url: string, options?: { payload?: object; cookie?: string | null; ip?: string }): Promise<LightMyRequestResponse>;
}

async function createHarness(options: { limits?: AuthRateLimitSettings; nodeEnv?: 'test' | 'development'; mailer?: 'capture' | 'log' } = {}): Promise<Harness> {
  const database = createDatabase(testDb.appConfig);
  handles.push(database);
  const mails: MailMessage[] = [];
  const logs = createLogCapture();
  const base = await fastHasher();
  const hasherCalls = { verify: 0, verifyDummy: 0 };
  const hasher: PasswordHasher = {
    hash: base.hash,
    verify: (password, encoded) => {
      hasherCalls.verify += 1;
      return base.verify(password, encoded);
    },
    verifyDummy: (password) => {
      hasherCalls.verifyDummy += 1;
      return base.verifyDummy(password);
    },
  };
  const app = await buildApp(
    { ...testConfig, nodeEnv: options.nodeEnv ?? 'test', database: testDb.appConfig },
    {
      database,
      logStream: logs.stream,
      passwordHasher: hasher,
      rateLimits: options.limits ?? RELAXED_LIMITS,
      ...(options.mailer === 'log' ? {} : { mailer: { send: async (message) => void mails.push(message) } }),
    },
  );
  apps.push(app);
  return {
    app,
    mails,
    logs,
    hasherCalls,
    call(method, url, { payload, cookie, ip } = {}) {
      return app.inject({
        method,
        url,
        headers: { ...(method === 'POST' ? sameSiteHeaders : {}), ...(cookie ? { cookie: `__Host-session=${cookie}` } : {}) },
        ...(payload ? { payload } : {}),
        ...(ip ? { remoteAddress: ip } : {}),
      });
    },
  };
}

function sessionToken(response: LightMyRequestResponse): string {
  const header = response.headers['set-cookie'];
  const cookie = Array.isArray(header) ? header[0] : header;
  const match = /^__Host-session=([A-Za-z0-9_-]{43});/.exec(cookie ?? '');
  if (!match) throw new Error(`响应没有设置会话 Cookie：${String(cookie)}`);
  return match[1]!;
}

const sha = (value: string) => createHash('sha256').update(value).digest();
const flushMail = () => new Promise((resolve) => setImmediate(resolve));
const tokenFrom = (text: string) => /#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? null;

async function login(h: Harness, email: string, password: string, ip?: string) {
  return h.call('POST', '/api/auth/login', { payload: { email, password }, ...(ip ? { ip } : {}) });
}

async function loginToken(h: Harness, email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> {
  const response = await login(h, email, password);
  expect(response.statusCode, response.body).toBe(200);
  return sessionToken(response);
}

/** 管理员发邀请，返回链接中的令牌。 */
async function invite(h: Harness, adminCookie: string, email: string): Promise<string> {
  const response = await h.call('POST', '/api/admin/invitations', { payload: { email }, cookie: adminCookie });
  expect(response.statusCode, response.body).toBe(201);
  return tokenFrom(response.json().link)!;
}

async function register(h: Harness, token: string, password = NEW_PASSWORD) {
  return h.call('POST', '/api/auth/register', { payload: { token, password } });
}

async function createUser(h: Harness, adminCookie: string, email: string, password = NEW_PASSWORD): Promise<string> {
  const response = await register(h, await invite(h, adminCookie, email), password);
  expect(response.statusCode, response.body).toBe(201);
  return sessionToken(response);
}

describe('命令行创建平台管理员', () => {
  it('创建已验证邮箱的平台管理员及其个人组织，输出不含密码', async () => {
    const result = runCreateAdmin(['--email', ' Admin@Example.com '], `${ADMIN_PASSWORD}\n`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(ADMIN_PASSWORD);
    const line = JSON.parse(result.stdout.trim()) as Record<string, string>;
    expect(line).toMatchObject({ level: 'info', msg: 'platform admin created', email: ADMIN_EMAIL });

    const user = await admin.selectFrom('users').selectAll().where('email', '=', ADMIN_EMAIL).executeTakeFirstOrThrow();
    expect(user).toMatchObject({ id: line.userId, is_platform_admin: true, status: 'active' });
    expect(user.email_verified_at).not.toBeNull();
    expect(user.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const membership = await admin.selectFrom('org_memberships').innerJoin('organizations', 'organizations.id', 'org_memberships.org_id')
      .select(['role', 'kind']).where('user_id', '=', user.id).execute();
    expect(membership).toEqual([{ role: 'owner', kind: 'personal' }]);
  });

  it('邮箱已注册、弱密码、缺少参数时退出码为 1，不创建用户', async () => {
    const duplicate = runCreateAdmin(['--email', ADMIN_EMAIL], `${ADMIN_PASSWORD}\n`);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain('该邮箱已注册');

    const weak = runCreateAdmin(['--email', 'weak@example.com'], '1234567890\n');
    expect(weak.status).toBe(1);
    expect(weak.stderr).not.toContain('1234567890');
    expect(await admin.selectFrom('users').select('id').where('email', '=', 'weak@example.com').execute()).toEqual([]);

    expect(runCreateAdmin([], `${ADMIN_PASSWORD}\n`).status).toBe(1);
    expect(runCreateAdmin(['--email', 'x@example.com', '--password', 'p'], '').status).toBe(1);
  });
});

describe('登录', () => {
  it('成功：签发 __Host- 会话 Cookie，库中只存令牌的 SHA-256', async () => {
    const h = await createHarness();
    const response = await login(h, 'ADMIN@example.com', ADMIN_PASSWORD);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    const token = sessionToken(response);
    const body = response.json();
    expect(body).toEqual({ user: { id: expect.any(String) }, org: { id: expect.any(String), role: 'owner' } });

    const stored = await admin.selectFrom('sessions').selectAll().where('token_hash', '=', sha(token)).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ user_id: body.user.id, org_id: body.org.id, revoked_at: null, ip_summary: '127.0.0.0/24' });
    // 令牌原文不出现在库中任何会话字段里。
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('邮箱不存在与密码错误：状态码和响应体相同，都做一次完整的密码哈希校验', async () => {
    const h = await createHarness();
    const wrong = await login(h, ADMIN_EMAIL, 'wrong-password-123');
    expect(h.hasherCalls).toEqual({ verify: 1, verifyDummy: 0 });
    const unknown = await login(h, 'nobody@example.com', 'wrong-password-123');
    expect(h.hasherCalls).toEqual({ verify: 1, verifyDummy: 1 });
    const malformed = await login(h, 'not-an-email', 'wrong-password-123');
    expect(h.hasherCalls).toEqual({ verify: 1, verifyDummy: 2 });

    const strip = (r: LightMyRequestResponse) => ({ status: r.statusCode, error: { ...r.json().error, requestId: undefined } });
    expect(strip(wrong)).toEqual({ status: 401, error: { code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误', requestId: undefined } });
    expect(strip(unknown)).toEqual(strip(wrong));
    expect(strip(malformed)).toEqual(strip(wrong));
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('停用的用户与密码错误无法区分', async () => {
    const h = await createHarness();
    const adminCookie = await loginToken(h);
    await createUser(h, adminCookie, 'tobedisabled@example.com');
    await admin.updateTable('users').set({ status: 'disabled' }).where('email', '=', 'tobedisabled@example.com').execute();
    const response = await login(h, 'tobedisabled@example.com', NEW_PASSWORD);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('登录时轮换令牌：请求自带的旧会话被吊销', async () => {
    const h = await createHarness();
    const first = await loginToken(h);
    const second = sessionToken(await h.call('POST', '/api/auth/login', { payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, cookie: first }));
    expect(second).not.toBe(first);
    expect((await h.call('GET', '/api/auth/me', { cookie: first })).statusCode).toBe(401);
    expect((await h.call('GET', '/api/auth/me', { cookie: second })).statusCode).toBe(200);
  });

  it('请求体多余字段、超长密码被拒绝', async () => {
    const h = await createHarness();
    expect((await h.call('POST', '/api/auth/login', { payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, admin: true } })).statusCode).toBe(400);
    expect((await login(h, ADMIN_EMAIL, 'x'.repeat(10_000))).statusCode).toBe(400);
  });
});

describe('会话', () => {
  it('/me 返回当前用户；篡改、过期、吊销的令牌一律 401 并清除 Cookie', async () => {
    const h = await createHarness();
    const token = await loginToken(h);
    const me = await h.call('GET', '/api/auth/me', { cookie: token });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: ADMIN_EMAIL, isPlatformAdmin: true }, org: { role: 'owner' } });

    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const rejected = await h.call('GET', '/api/auth/me', { cookie: tampered });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.headers['set-cookie']).toMatch(/^__Host-session=; Max-Age=0/);

    // 用令牌哈希当令牌（库被拖走的场景）也不能登录。
    expect((await h.call('GET', '/api/auth/me', { cookie: sha(token).toString('base64url').slice(0, 43) })).statusCode).toBe(401);

    await admin.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1000) }).where('token_hash', '=', sha(token)).execute();
    expect((await h.call('GET', '/api/auth/me', { cookie: token })).statusCode).toBe(401);

    const another = await loginToken(h);
    await admin.updateTable('sessions').set({ revoked_at: new Date() }).where('token_hash', '=', sha(another)).execute();
    expect((await h.call('GET', '/api/auth/me', { cookie: another })).statusCode).toBe(401);
  });

  it('滑动续期：超过 10 分钟未活动时续期，但不超过创建后 30 天', async () => {
    const h = await createHarness();
    const token = await loginToken(h);
    const day = 86_400_000;
    const createdAt = new Date(Date.now() - 29.5 * day);
    await admin.updateTable('sessions')
      .set({ created_at: createdAt, last_seen_at: new Date(Date.now() - 11 * 60_000), expires_at: new Date(Date.now() + day) } as never)
      .where('token_hash', '=', sha(token)).execute();
    expect((await h.call('GET', '/api/auth/me', { cookie: token })).statusCode).toBe(200);
    const row = await admin.selectFrom('sessions').selectAll().where('token_hash', '=', sha(token)).executeTakeFirstOrThrow();
    expect(Date.now() - row.last_seen_at.getTime()).toBeLessThan(60_000);
    // 空闲期限本应是 7 天后，但被绝对期限截断为 created_at + 30 天。
    expect(row.expires_at.getTime()).toBe(createdAt.getTime() + 30 * day);

    // 10 分钟内的请求不写库。
    await admin.updateTable('sessions').set({ last_seen_at: new Date(Date.now() - 5 * 60_000) }).where('token_hash', '=', sha(token)).execute();
    const before = await admin.selectFrom('sessions').select('last_seen_at').where('token_hash', '=', sha(token)).executeTakeFirstOrThrow();
    await h.call('GET', '/api/auth/me', { cookie: token });
    const after = await admin.selectFrom('sessions').select('last_seen_at').where('token_hash', '=', sha(token)).executeTakeFirstOrThrow();
    expect(after.last_seen_at).toEqual(before.last_seen_at);
  });

  it('登出：吊销会话、清除 Cookie，旧令牌重放无效；没有会话时登出也返回 204', async () => {
    const h = await createHarness();
    const token = await loginToken(h);
    const response = await h.call('POST', '/api/auth/logout', { cookie: token });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toMatch(/^__Host-session=; Max-Age=0/);
    expect((await h.call('GET', '/api/auth/me', { cookie: token })).statusCode).toBe(401);
    expect((await h.call('POST', '/api/auth/logout')).statusCode).toBe(204);
  });

  it('登出也要通过跨站校验（防止跨站强制登出）', async () => {
    const h = await createHarness();
    const token = await loginToken(h);
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: 'https://evil.example', 'x-requested-with': 'app', cookie: `__Host-session=${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect((await h.call('GET', '/api/auth/me', { cookie: token })).statusCode).toBe(200);
  });
});

describe('邀请与注册', () => {
  it('平台管理员生成邀请：链接中的令牌在 # 之后，库中只存哈希，邮件内容与链接一致', async () => {
    const h = await createHarness();
    const adminCookie = await loginToken(h);
    const response = await h.call('POST', '/api/admin/invitations', { payload: { email: ' Invitee@Example.com ' }, cookie: adminCookie });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.invitation).toMatchObject({ email: 'invitee@example.com' });
    expect(body.link).toMatch(new RegExp(`^${testConfig.publicOrigin}/register#token=[A-Za-z0-9_-]{43}$`));
    const token = tokenFrom(body.link)!;
    const stored = await admin.selectFrom('invitations').selectAll().where('id', '=', body.invitation.id).executeTakeFirstOrThrow();
    expect(stored.token_hash.equals(sha(token))).toBe(true);
    expect(stored.expires_at.getTime() - stored.created_at.getTime()).toBe(7 * 86_400_000);

    await flushMail();
    expect(h.mails).toEqual([expect.objectContaining({ to: 'invitee@example.com', subject: '注册邀请' })]);
    expect(tokenFrom(h.mails[0]!.text)).toBe(token);
  });

  it('凭邀请注册：创建已验证邮箱的用户和个人组织并登录；邀请不能重放', async () => {
    const h = await createHarness();
    const adminCookie = await loginToken(h);
    const token = await invite(h, adminCookie, 'newbie@example.com');
    const response = await register(h, token);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ user: { email: 'newbie@example.com' }, org: { role: 'owner' } });
    const cookie = sessionToken(response);
    const me = await h.call('GET', '/api/auth/me', { cookie });
    expect(me.json()).toMatchObject({ user: { email: 'newbie@example.com', isPlatformAdmin: false } });

    const user = await admin.selectFrom('users').selectAll().where('email', '=', 'newbie@example.com').executeTakeFirstOrThrow();
    expect(user.email_verified_at).not.toBeNull();
    expect(user.is_platform_admin).toBe(false);

    const replay = await register(h, token, 'another-strong-pass-9');
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe('INVALID_INVITATION');
    // 新密码可以登录。
    expect((await login(h, 'newbie@example.com', NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('过期、伪造、格式不对的邀请令牌被拒绝', async () => {
    const h = await createHarness();
    const adminCookie = await loginToken(h);
    const token = await invite(h, adminCookie, 'late@example.com');
    await admin.updateTable('invitations').set({ expires_at: new Date(Date.now() - 1000) }).where('email', '=', 'late@example.com').execute();
    for (const candidate of [token, 'A'.repeat(43), 'short', `${token}=`]) {
      const response = await register(h, candidate);
      expect(response.statusCode, candidate).toBe(400);
      expect(response.json().error.code).toBe('INVALID_INVITATION');
    }
    expect(await admin.selectFrom('users').select('id').where('email', '=', 'late@example.com').execute()).toEqual([]);
  });

  it('弱密码、包含邮箱用户名、邮箱已注册时失败，邀请保持未用', async () => {
    const h = await createHarness();
    const adminCookie = await loginToken(h);
    const token = await invite(h, adminCookie, 'careful.user@example.com');
    const weak = await register(h, token, '1234567890');
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('WEAK_PASSWORD');
    const containsEmail = await register(h, token, 'careful.user-2026');
    expect(containsEmail.statusCode).toBe(400);
    expect(containsEmail.json().error.message).toBe('密码不能包含邮箱用户名');
    expect((await register(h, token)).statusCode).toBe(201);

    const duplicate = await invite(h, adminCookie, ADMIN_EMAIL);
    const conflict = await register(h, duplicate);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('EMAIL_TAKEN');
    const row = await admin.selectFrom('invitations').select('consumed_at').where('token_hash', '=', sha(duplicate)).executeTakeFirstOrThrow();
    expect(row.consumed_at).toBeNull();
  });

  it('越权：普通用户不能发邀请（403），未登录 401，跨站 403', async () => {
    const h = await createHarness();
    const adminCookie = await loginToken(h);
    const userCookie = await createUser(h, adminCookie, 'plain@example.com');
    const forbidden = await h.call('POST', '/api/admin/invitations', { payload: { email: 'x@example.com' }, cookie: userCookie });
    expect(forbidden.statusCode).toBe(403);
    expect((await h.call('POST', '/api/admin/invitations', { payload: { email: 'x@example.com' } })).statusCode).toBe(401);
    const crossSite = await h.app.inject({
      method: 'POST',
      url: '/api/admin/invitations',
      headers: { cookie: `__Host-session=${adminCookie}`, origin: 'https://evil.example', 'x-requested-with': 'app' },
      payload: { email: 'x@example.com' },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(await admin.selectFrom('invitations').select('id').where('email', '=', 'x@example.com').execute()).toEqual([]);
  });

  it('撤销平台管理员后立即失去发邀请的权限', async () => {
    const h = await createHarness();
    const adminCookie = await loginToken(h);
    await admin.updateTable('users').set({ is_platform_admin: false }).where('email', '=', ADMIN_EMAIL).execute();
    try {
      const response = await h.call('POST', '/api/admin/invitations', { payload: { email: 'y@example.com' }, cookie: adminCookie });
      expect(response.statusCode).toBe(403);
    } finally {
      await admin.updateTable('users').set({ is_platform_admin: true }).where('email', '=', ADMIN_EMAIL).execute();
    }
  });
});

describe('找回密码', () => {
  it('邮箱存在与否响应相同，只给存在的邮箱发信', async () => {
    const h = await createHarness();
    const known = await h.call('POST', '/api/auth/password-reset/request', { payload: { email: ADMIN_EMAIL } });
    const unknown = await h.call('POST', '/api/auth/password-reset/request', { payload: { email: 'nobody@example.com' } });
    const malformed = await h.call('POST', '/api/auth/password-reset/request', { payload: { email: 'nope' } });
    for (const response of [known, unknown, malformed]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: 'accepted' });
    }
    await flushMail();
    expect(h.mails.map((mail) => mail.to)).toEqual([ADMIN_EMAIL]);
    expect(h.mails[0]!.text).toMatch(new RegExp(`${testConfig.publicOrigin}/reset-password#token=`));
  });

  it('重置：一次性，吊销全部会话，新密码可登录、旧密码不行', async () => {
    const h = await createHarness();
    const adminCookie = await loginToken(h);
    const userCookie = await createUser(h, adminCookie, 'forgetful@example.com');
    const otherDevice = await loginToken(h, 'forgetful@example.com', NEW_PASSWORD);

    await h.call('POST', '/api/auth/password-reset/request', { payload: { email: 'forgetful@example.com' } });
    await flushMail();
    const token = tokenFrom(h.mails.at(-1)!.text)!;
    const stored = await admin.selectFrom('auth_tokens').selectAll().where('token_hash', '=', sha(token)).executeTakeFirstOrThrow();
    expect(stored.kind).toBe('password_reset');

    const reset = await h.call('POST', '/api/auth/password-reset/confirm', { payload: { token, password: 'fresh-harbor-violet-31' } });
    expect(reset.statusCode).toBe(204);
    expect(reset.headers['set-cookie']).toMatch(/^__Host-session=; Max-Age=0/);
    for (const cookie of [userCookie, otherDevice]) {
      expect((await h.call('GET', '/api/auth/me', { cookie })).statusCode).toBe(401);
    }
    expect((await login(h, 'forgetful@example.com', NEW_PASSWORD)).statusCode).toBe(401);
    expect((await login(h, 'forgetful@example.com', 'fresh-harbor-violet-31')).statusCode).toBe(200);

    const replay = await h.call('POST', '/api/auth/password-reset/confirm', { payload: { token, password: 'another-harbor-12' } });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe('INVALID_TOKEN');
    expect((await login(h, 'forgetful@example.com', 'fresh-harbor-violet-31')).statusCode).toBe(200);
  });

  it('过期令牌、被新请求作废的令牌、伪造令牌都失败；弱密码不消耗令牌', async () => {
    const h = await createHarness();
    const request = async () => {
      await h.call('POST', '/api/auth/password-reset/request', { payload: { email: ADMIN_EMAIL } });
      await flushMail();
      return tokenFrom(h.mails.at(-1)!.text)!;
    };
    const confirm = (token: string, password = 'quiet-river-stone-55') =>
      h.call('POST', '/api/auth/password-reset/confirm', { payload: { token, password } });

    const expired = await request();
    await admin.updateTable('auth_tokens').set({ expires_at: new Date(Date.now() - 1000) }).where('token_hash', '=', sha(expired)).execute();
    expect((await confirm(expired)).statusCode).toBe(400);

    const superseded = await request();
    const latest = await request();
    expect((await confirm(superseded)).statusCode).toBe(400);
    expect((await confirm('B'.repeat(43))).statusCode).toBe(400);
    expect((await confirm('not-a-token')).statusCode).toBe(400);

    const weak = await confirm(latest, 'password123');
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('WEAK_PASSWORD');
    expect((await confirm(latest, ADMIN_PASSWORD)).statusCode).toBe(204);
  });

  it('非开发环境的日志发信实现不把令牌写进日志', async () => {
    const h = await createHarness({ mailer: 'log' });
    await h.call('POST', '/api/auth/password-reset/request', { payload: { email: ADMIN_EMAIL } });
    await flushMail();
    const text = h.logs.text();
    expect(text).toContain('mail not sent');
    expect(text).not.toMatch(/#token=/);
    expect(text).not.toContain(ADMIN_EMAIL);
  });
});

describe('修改密码', () => {
  it('当前密码错误时失败；成功后吊销本人全部会话（含其他组织），当前设备换发新令牌', async () => {
    const h = await createHarness();
    const adminCookie = await loginToken(h);
    const cookie = await createUser(h, adminCookie, 'changer@example.com');
    const otherDevice = await loginToken(h, 'changer@example.com', NEW_PASSWORD);

    const wrong = await h.call('POST', '/api/auth/password', { payload: { currentPassword: 'not-my-password', newPassword: 'solid-ember-castle-8' }, cookie });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('INVALID_PASSWORD');

    const weak = await h.call('POST', '/api/auth/password', { payload: { currentPassword: NEW_PASSWORD, newPassword: 'changer-12345' }, cookie });
    expect(weak.json().error.code).toBe('WEAK_PASSWORD');

    const response = await h.call('POST', '/api/auth/password', { payload: { currentPassword: NEW_PASSWORD, newPassword: 'solid-ember-castle-8' }, cookie });
    expect(response.statusCode).toBe(204);
    const rotated = sessionToken(response);
    expect((await h.call('GET', '/api/auth/me', { cookie })).statusCode).toBe(401);
    expect((await h.call('GET', '/api/auth/me', { cookie: otherDevice })).statusCode).toBe(401);
    expect((await h.call('GET', '/api/auth/me', { cookie: rotated })).statusCode).toBe(200);
    expect((await login(h, 'changer@example.com', 'solid-ember-castle-8')).statusCode).toBe(200);
  });

  it('未登录 401', async () => {
    const h = await createHarness();
    const response = await h.call('POST', '/api/auth/password', { payload: { currentPassword: 'a', newPassword: 'b' } });
    expect(response.statusCode).toBe(401);
  });
});

describe('限流', () => {
  const tight = (overrides: Partial<AuthRateLimitSettings>): AuthRateLimitSettings => ({ ...RELAXED_LIMITS, ...overrides });
  const window = (limit: number) => ({ limit, windowMs: 60_000 });

  function expect429(response: LightMyRequestResponse) {
    expect(response.statusCode, response.body).toBe(429);
    expect(response.json().error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  }

  it('登录：按 IP', async () => {
    const h = await createHarness({ limits: tight({ loginPerIp: window(3) }) });
    for (let i = 0; i < 3; i += 1) expect((await login(h, `u${i}@example.com`, 'whatever-123', '10.0.0.1')).statusCode).toBe(401);
    expect429(await login(h, ADMIN_EMAIL, ADMIN_PASSWORD, '10.0.0.1'));
    expect((await login(h, ADMIN_EMAIL, ADMIN_PASSWORD, '10.0.0.2')).statusCode).toBe(200);
  });

  it('登录：按邮箱（跨 IP 计数，邮箱大小写视为同一个）', async () => {
    const h = await createHarness({ limits: tight({ loginPerEmail: window(2) }) });
    expect((await login(h, ADMIN_EMAIL, 'wrong-pass-1', '10.0.1.1')).statusCode).toBe(401);
    expect((await login(h, 'ADMIN@example.com', 'wrong-pass-2', '10.0.1.2')).statusCode).toBe(401);
    expect429(await login(h, ADMIN_EMAIL, ADMIN_PASSWORD, '10.0.1.3'));
  });

  it('登录：连续失败后指数退避，锁定期间正确密码也被拒绝；不存在的邮箱同样处理', async () => {
    const h = await createHarness({ limits: tight({ loginFailures: { freeFailures: 2, baseDelayMs: 60_000, maxDelayMs: 600_000 } }) });
    for (const email of [ADMIN_EMAIL, 'ghost@example.com']) {
      expect((await login(h, email, 'wrong-pass-1')).statusCode).toBe(401);
      expect((await login(h, email, 'wrong-pass-2')).statusCode).toBe(401);
      expect((await login(h, email, 'wrong-pass-3')).statusCode).toBe(401);
      const locked = await login(h, email, ADMIN_PASSWORD);
      expect429(locked);
      expect(Number(locked.headers['retry-after'])).toBe(60);
    }
  });

  it('注册：按 IP', async () => {
    const h = await createHarness({ limits: tight({ registerPerIp: window(2) }) });
    for (let i = 0; i < 2; i += 1) expect((await register(h, 'C'.repeat(43))).statusCode).toBe(400);
    expect429(await register(h, 'C'.repeat(43)));
  });

  it('找回密码：按邮箱和按 IP；被限流时不发信', async () => {
    const h = await createHarness({ limits: tight({ resetRequestPerEmail: window(1), resetRequestPerIp: window(3) }) });
    const requestReset = (email: string) => h.call('POST', '/api/auth/password-reset/request', { payload: { email } });
    expect((await requestReset(ADMIN_EMAIL)).statusCode).toBe(202);
    expect429(await requestReset(ADMIN_EMAIL));
    expect((await requestReset('other1@example.com')).statusCode).toBe(202);
    expect429(await requestReset('other2@example.com'));
    await flushMail();
    expect(h.mails).toHaveLength(1);

    const confirm = await createHarness({ limits: tight({ resetConfirmPerIp: window(1) }) });
    const confirmReset = () => confirm.call('POST', '/api/auth/password-reset/confirm', { payload: { token: 'D'.repeat(43), password: 'quiet-river-stone-55' } });
    expect((await confirmReset()).statusCode).toBe(400);
    expect429(await confirmReset());
  });

  it('修改密码：按用户', async () => {
    const h = await createHarness({ limits: tight({ changePasswordPerUser: window(1) }) });
    const cookie = await loginToken(h);
    const change = () => h.call('POST', '/api/auth/password', { payload: { currentPassword: 'wrong-current-1', newPassword: 'solid-ember-castle-8' }, cookie });
    expect((await change()).statusCode).toBe(400);
    expect429(await change());
  });
});
