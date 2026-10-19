// 登录、注册、找回密码的限流（docs/SERVER_DESIGN.md 第 3.5 节）：按 IP 和按邮箱两个维度，连续失败后指数退避。
//
// 目前是进程内存实现：开发和起步部署只有一个 api 进程。接入 Redis（第 6 步）后换成共享存储，
// 接口不变；多实例部署前必须完成替换，否则限额按实例数放大。
// 每个限流器的键数有上限，超出时淘汰最早写入的键，防止用随机邮箱把内存撑爆。

const DEFAULT_MAX_KEYS = 50_000;

export type Clock = () => number;

export interface RateLimitDecision {
  allowed: boolean;
  /** 被拒绝时，距离可以重试的毫秒数。 */
  retryAfterMs: number;
}

const ALLOWED: RateLimitDecision = Object.freeze({ allowed: true, retryAfterMs: 0 });

function evictOldest<V>(map: Map<string, V>, maxKeys: number): void {
  while (map.size > maxKeys) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

export interface FixedWindowOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: Clock;
}

/** 固定窗口计数：每个键在窗口内最多 limit 次。 */
export class FixedWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: Clock;
  readonly #windows = new Map<string, { count: number; resetAt: number }>();

  constructor(options: FixedWindowOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.#now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitDecision {
    const now = this.#now();
    let window = this.#windows.get(key);
    if (!window || window.resetAt <= now) {
      this.#windows.delete(key);
      window = { count: 0, resetAt: now + this.#windowMs };
      this.#windows.set(key, window);
      evictOldest(this.#windows, this.#maxKeys);
    }
    if (window.count >= this.#limit) return { allowed: false, retryAfterMs: window.resetAt - now };
    window.count += 1;
    return ALLOWED;
  }
}

export interface FailureBackoffOptions {
  /** 连续失败多少次之内不退避。 */
  freeFailures: number;
  /** 超过后第一次的锁定时长，此后每次翻倍。 */
  baseDelayMs: number;
  maxDelayMs: number;
  maxKeys?: number;
  now?: Clock;
}

/**
 * 连续失败后指数退避：第 freeFailures + n 次失败后锁定 baseDelayMs × 2^(n-1)（不超过 maxDelayMs），
 * 锁定期内一律拒绝；成功后清零。最近一次失败超过 maxDelayMs 的记录自动作废。
 * 按邮箱计数时对不存在的邮箱同样生效，不会因此暴露邮箱是否注册。
 */
export class FailureBackoff {
  readonly #options: Required<Omit<FailureBackoffOptions, 'now' | 'maxKeys'>>;
  readonly #maxKeys: number;
  readonly #now: Clock;
  readonly #entries = new Map<string, { failures: number; lockedUntil: number; lastFailureAt: number }>();

  constructor(options: FailureBackoffOptions) {
    this.#options = { freeFailures: options.freeFailures, baseDelayMs: options.baseDelayMs, maxDelayMs: options.maxDelayMs };
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.#now = options.now ?? Date.now;
  }

  #entry(key: string, now: number) {
    const entry = this.#entries.get(key);
    if (entry && now - entry.lastFailureAt > this.#options.maxDelayMs && entry.lockedUntil <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  check(key: string): RateLimitDecision {
    const now = this.#now();
    const entry = this.#entry(key, now);
    if (entry && entry.lockedUntil > now) return { allowed: false, retryAfterMs: entry.lockedUntil - now };
    return ALLOWED;
  }

  recordFailure(key: string): void {
    const now = this.#now();
    const entry = this.#entry(key, now) ?? { failures: 0, lockedUntil: 0, lastFailureAt: now };
    entry.failures += 1;
    entry.lastFailureAt = now;
    const excess = entry.failures - this.#options.freeFailures;
    if (excess > 0) {
      const delay = Math.min(this.#options.baseDelayMs * 2 ** (excess - 1), this.#options.maxDelayMs);
      entry.lockedUntil = now + delay;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    evictOldest(this.#entries, this.#maxKeys);
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface AuthRateLimitSettings {
  loginPerIp: FixedWindowOptions;
  loginPerEmail: FixedWindowOptions;
  loginFailures: FailureBackoffOptions;
  registerPerIp: FixedWindowOptions;
  resetRequestPerIp: FixedWindowOptions;
  resetRequestPerEmail: FixedWindowOptions;
  resetConfirmPerIp: FixedWindowOptions;
  changePasswordPerUser: FixedWindowOptions;
  /** 平台管理员资金操作（充值、冲正、定价）前的密码二次验证。 */
  adminStepUpPerUser: FixedWindowOptions;
}

export const DEFAULT_AUTH_RATE_LIMITS: Readonly<AuthRateLimitSettings> = Object.freeze({
  loginPerIp: { limit: 30, windowMs: 15 * MINUTE },
  loginPerEmail: { limit: 10, windowMs: 15 * MINUTE },
  loginFailures: { freeFailures: 5, baseDelayMs: 1_000, maxDelayMs: 15 * MINUTE },
  registerPerIp: { limit: 10, windowMs: HOUR },
  resetRequestPerIp: { limit: 10, windowMs: HOUR },
  resetRequestPerEmail: { limit: 3, windowMs: HOUR },
  resetConfirmPerIp: { limit: 10, windowMs: 15 * MINUTE },
  changePasswordPerUser: { limit: 5, windowMs: 15 * MINUTE },
  adminStepUpPerUser: { limit: 10, windowMs: 15 * MINUTE },
});

export function createAuthRateLimiters(settings: AuthRateLimitSettings, now?: Clock) {
  const window = (options: FixedWindowOptions) => new FixedWindowLimiter({ ...options, ...(now ? { now } : {}) });
  return {
    loginPerIp: window(settings.loginPerIp),
    loginPerEmail: window(settings.loginPerEmail),
    loginFailures: new FailureBackoff({ ...settings.loginFailures, ...(now ? { now } : {}) }),
    registerPerIp: window(settings.registerPerIp),
    resetRequestPerIp: window(settings.resetRequestPerIp),
    resetRequestPerEmail: window(settings.resetRequestPerEmail),
    resetConfirmPerIp: window(settings.resetConfirmPerIp),
    changePasswordPerUser: window(settings.changePasswordPerUser),
    adminStepUpPerUser: window(settings.adminStepUpPerUser),
  };
}

export type AuthRateLimiters = ReturnType<typeof createAuthRateLimiters>;
