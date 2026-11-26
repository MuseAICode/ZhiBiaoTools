// 批量模型调用的连续失败守卫（src/jobs/aiBatchGuard.ts，路线图第 8 步 8.10c2b2）与桌面版 utils/aiBatchGuard.cjs 的对照：同一串成功 /
// 请求失败 / 其他失败在两边于同一步触发（或都不触发）、触发后中止本批、之后的结果不再计入；调用方中止后的失败不计入。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { AI_UPSTREAM_FAILURE_LIMIT, AI_UPSTREAM_UNAVAILABLE, createAiBatchGuard, isAiUpstreamFailure } from '../../src/jobs/aiBatchGuard.ts';
import { JobBalanceExhaustedError, JobError } from '../../src/jobs/definitions.ts';

const require = createRequire(import.meta.url);
const desktop = require('../../../client/electron/utils/aiBatchGuard.cjs') as {
  AI_UPSTREAM_FAILURE_LIMIT: number;
  AI_UPSTREAM_UNAVAILABLE: string;
  createAiBatchGuard(options?: { signal?: AbortSignal; limit?: number }): { signal: AbortSignal; error: Error | null; success(): void; failure(error: unknown): void };
};

type Event = 'ok' | 'upstream' | 'invalid';

const upstream = () => new JobError('AI_UPSTREAM_ERROR', '模型服务调用失败，本次调用不收费');

/** 依次喂入事件，返回触发时是第几个事件（从 1 开始），没有触发为 0。 */
function tripStep(guard: { signal: AbortSignal; success(): void; failure(error: unknown): void }, events: readonly Event[], errorOf: (event: Event) => unknown): number {
  for (const [index, event] of events.entries()) {
    if (event === 'ok') guard.success();
    else guard.failure(errorOf(event));
    if (guard.signal.aborted) return index + 1;
  }
  return 0;
}

const serverError = (event: Event) => (event === 'upstream' ? upstream() : new Error('输出不合格'));
const desktopError = (event: Event) => (event === 'upstream' ? Object.assign(new Error('模型服务调用失败'), { isAiRequestError: true }) : new Error('输出不合格'));

describe('createAiBatchGuard (desktop parity)', () => {
  it('uses the desktop limit and code', () => {
    expect(AI_UPSTREAM_FAILURE_LIMIT).toBe(desktop.AI_UPSTREAM_FAILURE_LIMIT);
    expect(AI_UPSTREAM_UNAVAILABLE).toBe(desktop.AI_UPSTREAM_UNAVAILABLE);
  });

  const sequences: [string, Event[]][] = [
    ['ten upstream failures', Array(10).fill('upstream')],
    ['nine upstream failures', Array(9).fill('upstream')],
    ['a success resets the count', [...Array(9).fill('upstream'), 'ok', ...Array(9).fill('upstream')]],
    ['an invalid output resets the count', [...Array(9).fill('upstream'), 'invalid', ...Array(10).fill('upstream')]],
    ['mixed', ['upstream', 'ok', 'invalid', ...Array(12).fill('upstream')]],
    ['only successes', Array(20).fill('ok')],
  ];
  for (const [name, events] of sequences) {
    it(`trips at the same step as the desktop: ${name}`, () => {
      const step = tripStep(createAiBatchGuard(), events, serverError);
      expect(step).toBe(tripStep(desktop.createAiBatchGuard(), events, desktopError));
    });
  }

  it('aborts the batch with a JobError and ignores later results', () => {
    const guard = createAiBatchGuard({ limit: 2 });
    guard.failure(upstream());
    expect(guard.error).toBeNull();
    guard.failure(upstream());
    expect(guard.signal.aborted).toBe(true);
    expect(guard.error).toBeInstanceOf(JobError);
    expect(guard.error!.code).toBe(AI_UPSTREAM_UNAVAILABLE);
    expect(guard.error!.message).toBe('AI 服务连续 2 个请求失败，已停止派发剩余请求，已完成结果已保留，服务恢复后重试即可接着处理。最后一次错误：模型服务调用失败，本次调用不收费');
    const tripped = guard.error;
    guard.success();
    guard.failure(upstream());
    expect(guard.error).toBe(tripped);
  });

  it('does not count failures after the caller aborted', () => {
    const controller = new AbortController();
    const guard = createAiBatchGuard({ signal: controller.signal, limit: 1 });
    controller.abort();
    expect(guard.signal.aborted).toBe(true);
    guard.failure(upstream());
    expect(guard.error).toBeNull();
  });

  it('counts only upstream-side gateway failures', () => {
    expect(isAiUpstreamFailure(new JobError('AI_UPSTREAM_ERROR', 'x'))).toBe(true);
    expect(isAiUpstreamFailure(new JobError('AI_UPSTREAM_TIMEOUT', 'x'))).toBe(true);
    expect(isAiUpstreamFailure(new JobError('AI_CONCURRENCY_UNAVAILABLE', 'x'))).toBe(true);
    expect(isAiUpstreamFailure(new JobError('AI_MODEL_DISABLED', 'x'))).toBe(false);
    expect(isAiUpstreamFailure(new JobBalanceExhaustedError())).toBe(false);
    expect(isAiUpstreamFailure(Object.assign(new Error('x'), { code: 'AI_UPSTREAM_ERROR' }))).toBe(false);
  });
});
