// 登录、注册、找回密码的限流（docs/SERVER_DESIGN.md 第 3.5 节）：按 IP 和按邮箱两个维度，连续失败后指数退避。
//
// 配置了 Redis 时计数存在 Redis（src/auth/rateLimitStore.ts），api 的所有实例共用一份限额（路线图第 6 步 6.14）；
// Redis 暂时不可用时退回本进程内存计数，不放行也不拒绝全部请求（多实例时这段时间的限额按实例数放大）。
// 未配置 Redis 时（开发、测试）只用进程内存。
// 进程内存的每个限流器键数有上限，超出时淘汰最早写入的键，防止用随机邮箱把内存撑爆。
import type { RateLimitStore } from './rateLimitStore.ts';

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
  /**
   * 模板样张与样张导出 Word 的请求（路线图 7.3e，决定事项第 7 项：导出不计费，靠并发、取代与请求频率控制用量）。
   * 不属于登录类限流，与它们共用同一套计数实现（Redis 共享、不可用时退回进程内存）。
   */
  templatePreviewPerUser: FixedWindowOptions;
  /** 技术方案整本导出 Word 的入队请求（路线图 7.4h，同上：导出不计费，靠按项目互斥与请求频率控制用量）。 */
  technicalPlanExportPerUser: FixedWindowOptions;
  /** 可研报告导出 Word 的入队请求（路线图 7.5e，同上）。 */
  feasibilityReportExportPerUser: FixedWindowOptions;
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
  templatePreviewPerUser: { limit: 120, windowMs: 10 * MINUTE },
  technicalPlanExportPerUser: { limit: 30, windowMs: 10 * MINUTE },
  feasibilityReportExportPerUser: { limit: 30, windowMs: 10 * MINUTE },
});

/** 固定窗口限流器：每次请求计一次。 */
export interface WindowRateLimiter {
  consume(key: string): Promise<RateLimitDecision>;
}

/** 连续失败退避：请求前检查，失败时记录，成功后清零。 */
export interface BackoffRateLimiter {
  check(key: string): Promise<RateLimitDecision>;
  recordFailure(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

export interface CreateAuthRateLimitersOptions {
  /** 测试用：进程内存计数的时钟。Redis 计数一律用 Redis 服务器的时钟。 */
  now?: Clock;
  /** 共享计数（src/server.ts 按 REDIS_URL 创建，由调用方关闭）。未提供时只用进程内存。 */
  store?: RateLimitStore | null;
  log?: { warn(obj: unknown, msg?: string): void };
  /** 退回进程内存计数期间，重复写告警日志的最短间隔。默认 1 分钟。 */
  degradedReportMs?: number;
}

const DEFAULT_DEGRADED_REPORT_MS = 60_000;

export function createAuthRateLimiters(settings: AuthRateLimitSettings, options: CreateAuthRateLimitersOptions = {}) {
  const { now, store = null, log } = options;
  const clock = now ? { now } : {};

  // Redis 出错时退回进程内存计数。不逐次写日志，避免 Redis 长时间不可用时刷屏，只写三种 warn：
  // 进入时一条；仍在退回中时最多每 degradedReportMs 一条，写明已持续多久（degradedMs）；恢复时一条，写明一共退回了多久。
  // 退回期间各实例分别计数，限额按实例数放大，告警据此判断影响范围。
  const reportEveryMs = options.degradedReportMs ?? DEFAULT_DEGRADED_REPORT_MS;
  let degradedSince: number | null = null;
  let lastReportAt = 0;
  async function shared<T>(remote: () => Promise<T>, local: () => T): Promise<T> {
    if (!store) return local();
    try {
      const result = await remote();
      if (degradedSince !== null) {
        const degradedMs = Math.max(0, Date.now() - degradedSince);
        degradedSince = null;
        log?.warn({ degradedMs }, 'auth rate limit redis recovered, shared limits restored');
      }
      return result;
    } catch (error) {
      const at = Date.now();
      if (degradedSince === null) {
        degradedSince = at;
        lastReportAt = at;
        log?.warn({ err: error, degradedMs: 0 }, 'auth rate limit redis unavailable, falling back to in-process limits');
      } else if (at - lastReportAt >= reportEveryMs) {
        lastReportAt = at;
        log?.warn({ err: error, degradedMs: at - degradedSince }, 'auth rate limit still falling back to in-process limits');
      }
      return local();
    }
  }

  const window = (name: keyof AuthRateLimitSettings, options: FixedWindowOptions): WindowRateLimiter => {
    const memory = new FixedWindowLimiter({ ...options, ...clock });
    return {
      consume: (key) =>
        shared(
          () => store!.consumeWindow(name, key, options),
          () => memory.consume(key),
        ),
    };
  };

  const backoff = (name: keyof AuthRateLimitSettings, options: FailureBackoffOptions): BackoffRateLimiter => {
    const memory = new FailureBackoff({ ...options, ...clock });
    return {
      check: (key) =>
        shared(
          () => store!.checkBackoff(name, key),
          () => memory.check(key),
        ),
      recordFailure: (key) =>
        shared(
          () => store!.recordBackoffFailure(name, key, options),
          () => memory.recordFailure(key),
        ),
      reset: async (key) => {
        // 两边都清：Redis 恢复前在进程内存中累积的失败不应在登录成功后继续生效。
        memory.reset(key);
        await shared(
          () => store!.resetBackoff(name, key),
          () => undefined,
        );
      },
    };
  };

  return {
    loginPerIp: window('loginPerIp', settings.loginPerIp),
    loginPerEmail: window('loginPerEmail', settings.loginPerEmail),
    loginFailures: backoff('loginFailures', settings.loginFailures),
    registerPerIp: window('registerPerIp', settings.registerPerIp),
    resetRequestPerIp: window('resetRequestPerIp', settings.resetRequestPerIp),
    resetRequestPerEmail: window('resetRequestPerEmail', settings.resetRequestPerEmail),
    resetConfirmPerIp: window('resetConfirmPerIp', settings.resetConfirmPerIp),
    changePasswordPerUser: window('changePasswordPerUser', settings.changePasswordPerUser),
    adminStepUpPerUser: window('adminStepUpPerUser', settings.adminStepUpPerUser),
    templatePreviewPerUser: window('templatePreviewPerUser', settings.templatePreviewPerUser),
    technicalPlanExportPerUser: window('technicalPlanExportPerUser', settings.technicalPlanExportPerUser),
    feasibilityReportExportPerUser: window('feasibilityReportExportPerUser', settings.feasibilityReportExportPerUser),
  };
}

export type AuthRateLimiters = ReturnType<typeof createAuthRateLimiters>;
