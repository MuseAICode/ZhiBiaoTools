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

  it('登记的业务任务类型：6.6 的文档解析（parse 队列、可续跑、不调用模型），6.9 的废标检查两类（ai 队列、可续跑、调用模型），6.10 的标书查重（ai 队列、可续跑、不调用模型），6.11 的技术方案两类、6.12 的可研报告四类（ai 队列、可续跑、调用模型）', () => {
    expect(JOB_TYPES.map((item) => item.type)).toEqual([
      'document-parse',
      'rejection-items-extraction',
      'rejection-check-run',
      'duplicate-analysis',
      'bid-section-extraction',
      'bid-analysis',
      'feasibility-analysis',
      'feasibility-parameters',
      'feasibility-content',
      'feasibility-human-writing',
    ]);
    const parse = jobTypeRegistry.get('document-parse')!;
    expect(parse.queue).toBe('parse');
    expect(parse.resumable).toBe(true);
    expect(parse.billable).toBeFalsy();
    for (const type of [
      'rejection-items-extraction',
      'rejection-check-run',
      'bid-section-extraction',
      'bid-analysis',
      'feasibility-analysis',
      'feasibility-parameters',
      'feasibility-content',
      'feasibility-human-writing',
    ]) {
      const definition = jobTypeRegistry.get(type)!;
      expect(definition.queue).toBe('ai');
      expect(definition.resumable).toBe(true);
      expect(definition.billable).toBe(true);
    }
    const duplicate = jobTypeRegistry.get('duplicate-analysis')!;
    expect(duplicate.queue).toBe('ai');
    expect(duplicate.resumable).toBe(true);
    expect(duplicate.billable).toBeFalsy();
  });
});
