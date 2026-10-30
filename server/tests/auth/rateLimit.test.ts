import { describe, expect, it, vi } from 'vitest';
import {
  createAuthRateLimiters,
  DEFAULT_AUTH_RATE_LIMITS,
  FailureBackoff,
  FixedWindowLimiter,
  type AuthRateLimitSettings,
} from '../../src/auth/rateLimit.ts';
import type { RateLimitStore } from '../../src/auth/rateLimitStore.ts';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('FixedWindowLimiter', () => {
  it('窗口内最多 limit 次，窗口结束后恢复，各键独立', () => {
    const time = clock();
    const limiter = new FixedWindowLimiter({ limit: 3, windowMs: 60_000, now: time.now });
    for (let i = 0; i < 3; i += 1) expect(limiter.consume('a').allowed).toBe(true);
    const denied = limiter.consume('a');
    expect(denied).toEqual({ allowed: false, retryAfterMs: 60_000 });
    expect(limiter.consume('b').allowed).toBe(true);
    time.advance(59_999);
    expect(limiter.consume('a').allowed).toBe(false);
    time.advance(1);
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('键数超过上限时淘汰最早的键，内存有界', () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    limiter.consume('a');
    limiter.consume('b');
    limiter.consume('c');
    // a 被淘汰后重新计数。
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('c').allowed).toBe(false);
  });
});

describe('FailureBackoff', () => {
  it('前 freeFailures 次失败不锁定，之后指数退避并有上限', () => {
    const time = clock();
    const backoff = new FailureBackoff({ freeFailures: 2, baseDelayMs: 1_000, maxDelayMs: 4_000, now: time.now });
    backoff.recordFailure('k');
    backoff.recordFailure('k');
    expect(backoff.check('k').allowed).toBe(true);

    backoff.recordFailure('k');
    expect(backoff.check('k')).toEqual({ allowed: false, retryAfterMs: 1_000 });
    time.advance(1_000);
    backoff.recordFailure('k');
    expect(backoff.check('k').retryAfterMs).toBe(2_000);
    time.advance(2_000);
    backoff.recordFailure('k');
    expect(backoff.check('k').retryAfterMs).toBe(4_000);
    time.advance(4_000);
    backoff.recordFailure('k');
    expect(backoff.check('k').retryAfterMs).toBe(4_000);
  });

  it('成功后清零；长时间没有失败的记录作废', () => {
    const time = clock();
    const backoff = new FailureBackoff({ freeFailures: 1, baseDelayMs: 1_000, maxDelayMs: 10_000, now: time.now });
    backoff.recordFailure('k');
    backoff.recordFailure('k');
    expect(backoff.check('k').allowed).toBe(false);
    backoff.reset('k');
    expect(backoff.check('k').allowed).toBe(true);

    backoff.recordFailure('k');
    time.advance(10_001);
    backoff.recordFailure('k');
    // 上一次失败已过期，本次重新从第 1 次算起，不锁定。
    expect(backoff.check('k').allowed).toBe(true);
  });
});

const STRICT: AuthRateLimitSettings = {
  ...DEFAULT_AUTH_RATE_LIMITS,
  loginPerIp: { limit: 2, windowMs: 60_000 },
  loginFailures: { freeFailures: 1, baseDelayMs: 1_000, maxDelayMs: 10_000 },
};

/** 记录调用的共享计数桩；broken 为 true 时每个操作都抛错（模拟 Redis 不可用）。 */
function fakeStore() {
  const calls: string[] = [];
  const state = { broken: false };
  const fail = () => {
    if (state.broken) throw new Error('redis down');
  };
  const store: RateLimitStore = {
    async consumeWindow(name, key) {
      calls.push(`window:${name}:${key}`);
      fail();
      return { allowed: false, retryAfterMs: 42_000 };
    },
    async checkBackoff(name, key) {
      calls.push(`check:${name}:${key}`);
      fail();
      return { allowed: true, retryAfterMs: 0 };
    },
    async recordBackoffFailure(name, key) {
      calls.push(`failure:${name}:${key}`);
      fail();
    },
    async resetBackoff(name, key) {
      calls.push(`reset:${name}:${key}`);
      fail();
    },
    ready: async () => undefined,
    close: async () => undefined,
  };
  return { store, calls, state };
}

function captureLog() {
  const entries: { obj: Record<string, unknown>; msg: string | undefined }[] = [];
  return {
    entries,
    warn: (obj: unknown, msg?: string) => void entries.push({ obj: obj as Record<string, unknown>, msg }),
  };
}

describe('createAuthRateLimiters', () => {
  it('没有共享计数时按进程内存计数', async () => {
    const limiters = createAuthRateLimiters(STRICT);
    expect((await limiters.loginPerIp.consume('1.1.1.1')).allowed).toBe(true);
    expect((await limiters.loginPerIp.consume('1.1.1.1')).allowed).toBe(true);
    expect((await limiters.loginPerIp.consume('1.1.1.1')).allowed).toBe(false);
  });

  it('有共享计数时以共享计数的结果为准，按限流器名区分', async () => {
    const { store, calls } = fakeStore();
    const limiters = createAuthRateLimiters(STRICT, { store });
    expect(await limiters.loginPerIp.consume('1.1.1.1')).toEqual({ allowed: false, retryAfterMs: 42_000 });
    await limiters.loginFailures.recordFailure('a@example.com');
    await limiters.loginFailures.check('a@example.com');
    await limiters.loginFailures.reset('a@example.com');
    expect(calls).toEqual([
      'window:loginPerIp:1.1.1.1',
      'failure:loginFailures:a@example.com',
      'check:loginFailures:a@example.com',
      'reset:loginFailures:a@example.com',
    ]);
  });

  it('共享计数出错时退回进程内存计数，不放行超限请求', async () => {
    const { store, state } = fakeStore();
    const limiters = createAuthRateLimiters(STRICT, { store });
    state.broken = true;
    expect((await limiters.loginPerIp.consume('1.1.1.1')).allowed).toBe(true);
    expect((await limiters.loginPerIp.consume('1.1.1.1')).allowed).toBe(true);
    expect((await limiters.loginPerIp.consume('1.1.1.1')).allowed).toBe(false);

    await limiters.loginFailures.recordFailure('a@example.com');
    await limiters.loginFailures.recordFailure('a@example.com');
    expect((await limiters.loginFailures.check('a@example.com')).allowed).toBe(false);

    state.broken = false;
    expect(await limiters.loginPerIp.consume('1.1.1.1')).toEqual({ allowed: false, retryAfterMs: 42_000 });
  });

  it('退回与恢复各写一条 warn，退回期间按间隔写持续时长，不逐次写', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const { store, state } = fakeStore();
      const log = captureLog();
      const limiters = createAuthRateLimiters(STRICT, { store, log, degradedReportMs: 60_000 });
      state.broken = true;
      await limiters.registerPerIp.consume('1.1.1.1');
      vi.advanceTimersByTime(30_000);
      await limiters.registerPerIp.consume('1.1.1.1');
      await limiters.loginFailures.check('a@example.com');
      expect(log.entries).toHaveLength(1);
      expect(log.entries[0]!.msg).toBe('auth rate limit redis unavailable, falling back to in-process limits');
      expect(log.entries[0]!.obj).toMatchObject({ degradedMs: 0 });
      expect(log.entries[0]!.obj.err).toBeInstanceOf(Error);

      vi.advanceTimersByTime(30_000);
      await limiters.registerPerIp.consume('1.1.1.1');
      await limiters.registerPerIp.consume('1.1.1.1');
      expect(log.entries).toHaveLength(2);
      expect(log.entries[1]).toMatchObject({ msg: 'auth rate limit still falling back to in-process limits', obj: { degradedMs: 60_000 } });

      vi.advanceTimersByTime(15_000);
      state.broken = false;
      await limiters.registerPerIp.consume('1.1.1.1');
      await limiters.registerPerIp.consume('1.1.1.1');
      expect(log.entries).toHaveLength(3);
      expect(log.entries[2]).toEqual({ msg: 'auth rate limit redis recovered, shared limits restored', obj: { degradedMs: 75_000 } });

      // 再次出错时重新计时。
      state.broken = true;
      vi.advanceTimersByTime(5_000);
      await limiters.registerPerIp.consume('1.1.1.1');
      expect(log.entries[3]).toMatchObject({ msg: 'auth rate limit redis unavailable, falling back to in-process limits', obj: { degradedMs: 0 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('登录成功清零时进程内存和共享计数都清掉', async () => {
    const { store, state, calls } = fakeStore();
    const limiters = createAuthRateLimiters(STRICT, { store });
    state.broken = true;
    await limiters.loginFailures.recordFailure('a@example.com');
    await limiters.loginFailures.recordFailure('a@example.com');
    expect((await limiters.loginFailures.check('a@example.com')).allowed).toBe(false);
    // Redis 仍不可用时清零不报错，进程内存的记录已清掉。
    await limiters.loginFailures.reset('a@example.com');
    expect((await limiters.loginFailures.check('a@example.com')).allowed).toBe(true);
    state.broken = false;
    await limiters.loginFailures.reset('a@example.com');
    expect(calls.filter((call) => call.startsWith('reset:'))).toHaveLength(2);
  });
});
