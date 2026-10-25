import { describe, expect, it } from 'vitest';
import { createJobTypeRegistry, DEFAULT_MAX_ATTEMPTS, maxAttemptsOf, type JobTypeDefinition } from '../../src/jobs/definitions.ts';
import { JOB_TYPES, jobTypeRegistry } from '../../src/jobs/registry.ts';

function definition(type: string, overrides: Partial<JobTypeDefinition> = {}): JobTypeDefinition {
  return { type, queue: 'ai', resumable: true, parseParams: (raw) => raw, run: async () => {}, ...overrides };
}

describe('任务类型登记', () => {
  it('按类型查找；未登记的返回 undefined', () => {
    const registry = createJobTypeRegistry([definition('bid-analysis'), definition('parse-document', { queue: 'parse' })]);
    expect(registry.get('parse-document')?.queue).toBe('parse');
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.types.map((item) => item.type)).toEqual(['bid-analysis', 'parse-document']);
  });

  it('拒绝不合法的名称、队列和重复登记', () => {
    expect(() => createJobTypeRegistry([definition('Bad Type')])).toThrow(/名称不合法/);
    expect(() => createJobTypeRegistry([definition('x', { queue: 'other' as never })])).toThrow(/队列不合法/);
    expect(() => createJobTypeRegistry([definition('dup'), definition('dup')])).toThrow(/重复登记/);
  });

  it('最多执行次数默认 3', () => {
    expect(maxAttemptsOf(definition('a'))).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(maxAttemptsOf(definition('a', { maxAttempts: 1 }))).toBe(1);
  });

  it('6.2 还没有登记任何业务任务类型', () => {
    expect(JOB_TYPES).toEqual([]);
    expect(jobTypeRegistry.types).toEqual([]);
  });
});
