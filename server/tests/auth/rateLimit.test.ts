import { describe, expect, it } from 'vitest';
import { FailureBackoff, FixedWindowLimiter } from '../../src/auth/rateLimit.ts';

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
