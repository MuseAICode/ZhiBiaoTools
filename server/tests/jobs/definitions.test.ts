import { describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
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

  it('登记的业务任务类型：6.6 的文档解析（parse 队列、可续跑、不调用模型），6.9 的废标检查两类（ai 队列、可续跑、调用模型），6.10 的标书查重（ai 队列、可续跑、不调用模型），6.11 的技术方案两类、6.12 的可研报告四类、6.13a 的知识库文档准备与 6.13b 的知识库匹配（ai 队列、可续跑、调用模型），7.3d 的模板样张（export 队列、可续跑、不调用模型），8.7a 的可研目录生成与 8.7b 的可研目录调整（agent 队列、可续跑、调用模型、Agent 上限与工具、共用的工作区快照、成功后保留），8.7c1 的技术方案全局事实生成与 8.7c2 的全局事实调整、8.7e1 的技术方案目录生成与 8.7d 的技术方案目录调整（agent 队列、可续跑、调用模型、Agent 上限与工具、共用的工作区快照、成功后保留），8.10b1 的技术方案正文生成（agent 队列、可续跑、调用模型、正文生成的上限、agent-content 沙箱、工作区快照、成功后保留）', () => {
    expect(JOB_TYPES.map((item) => item.type)).toEqual([
      'document-parse',
      'rejection-items-extraction',
      'rejection-check-run',
      'duplicate-analysis',
      'bid-section-extraction',
      'bid-analysis',
      'global-facts-generation',
      'global-facts-adjustment',
      'outline-generation',
      'outline-adjustment',
      'content-generation',
      'feasibility-analysis',
      'feasibility-outline',
      'feasibility-outline-adjustment',
      'feasibility-parameters',
      'feasibility-content',
      'feasibility-human-writing',
      'knowledge-document-prepare',
      'knowledge-document-match',
      'template-preview',
      'template-word-export',
      'technical-plan-export',
      'feasibility-report-export',
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
      'knowledge-document-prepare',
      'knowledge-document-match',
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
    const preview = jobTypeRegistry.get('template-preview')!;
    expect(preview.queue).toBe('export');
    expect(preview.resumable).toBe(true);
    expect(preview.billable).toBeFalsy();
    const wordExport = jobTypeRegistry.get('template-word-export')!;
    expect(wordExport.queue).toBe('export');
    expect(wordExport.resumable).toBe(true);
    expect(wordExport.billable).toBeFalsy();
    const documentExport = jobTypeRegistry.get('technical-plan-export')!;
    expect(documentExport.queue).toBe('export');
    expect(documentExport.resumable).toBe(true);
    expect(documentExport.billable).toBeFalsy();
    const feasibilityExport = jobTypeRegistry.get('feasibility-report-export')!;
    expect(feasibilityExport.queue).toBe('export');
    expect(feasibilityExport.resumable).toBe(true);
    expect(feasibilityExport.billable).toBeFalsy();
    const feasibilityOutline = jobTypeRegistry.get('feasibility-outline')!;
    expect(feasibilityOutline.queue).toBe('agent');
    expect(feasibilityOutline.resumable).toBe(true);
    expect(feasibilityOutline.billable).toBe(true);
    expect(feasibilityOutline.agentLimits).toEqual(AGENT_TASK_LIMITS.outline);
    expect(feasibilityOutline.agentTools).toEqual(['ask-user', 'request-termination']);
    expect(feasibilityOutline.agentWorkspace).toEqual({ taskKind: 'feasibility-outline', keepAfterSuccess: true });
    expect(feasibilityOutline.agentSandboxTemplate ?? 'agent').toBe('agent');
    const globalFacts = jobTypeRegistry.get('global-facts-generation')!;
    expect(globalFacts.queue).toBe('agent');
    expect(globalFacts.resumable).toBe(true);
    expect(globalFacts.billable).toBe(true);
    expect(globalFacts.agentLimits).toEqual(AGENT_TASK_LIMITS.outline);
    expect(globalFacts.agentTools).toEqual(['ask-user', 'request-termination']);
    expect(globalFacts.agentWorkspace).toEqual({ taskKind: 'technical-plan-global-facts', keepAfterSuccess: true });
    expect(globalFacts.agentSandboxTemplate ?? 'agent').toBe('agent');
    expect(globalFacts.parseParams({})).toEqual({});
    for (const bad of [{ globalFactsMode: 'omit' }, null, []]) expect(() => globalFacts.parseParams(bad)).toThrow(TypeError);
    const factsAdjustment = jobTypeRegistry.get('global-facts-adjustment')!;
    expect(factsAdjustment.queue).toBe('agent');
    expect(factsAdjustment.resumable).toBe(true);
    expect(factsAdjustment.billable).toBe(true);
    expect(factsAdjustment.agentLimits).toEqual(AGENT_TASK_LIMITS.outline);
    expect(factsAdjustment.agentTools).toEqual(['ask-user', 'request-termination']);
    expect(factsAdjustment.agentWorkspace).toEqual({ taskKind: 'technical-plan-global-facts', keepAfterSuccess: true });
    expect(factsAdjustment.agentSandboxTemplate ?? 'agent').toBe('agent');
    expect(factsAdjustment.parseParams({ requirement: '统一工期' })).toEqual({ requirement: '统一工期' });
    for (const bad of [{}, { requirement: '' }, { requirement: '  有空白  ' }, { requirement: 'x'.repeat(2001) }, { requirement: 1 }, { requirement: '统一', extra: 1 }, null, []]) {
      expect(() => factsAdjustment.parseParams(bad)).toThrow(TypeError);
    }
    const outlineGeneration = jobTypeRegistry.get('outline-generation')!;
    expect(outlineGeneration.queue).toBe('agent');
    expect(outlineGeneration.resumable).toBe(true);
    expect(outlineGeneration.billable).toBe(true);
    expect(outlineGeneration.agentLimits).toEqual(AGENT_TASK_LIMITS.outline);
    expect(outlineGeneration.agentTools).toEqual(['ask-user', 'request-termination']);
    expect(outlineGeneration.agentWorkspace).toEqual({ taskKind: 'technical-plan-outline-generation', keepAfterSuccess: true });
    expect(outlineGeneration.agentSandboxTemplate ?? 'agent').toBe('agent');
    expect(outlineGeneration.parseParams({ noTechnicalScoreMode: false })).toEqual({ noTechnicalScoreMode: false });
    expect(outlineGeneration.parseParams({ noTechnicalScoreMode: true })).toEqual({ noTechnicalScoreMode: true });
    for (const bad of [{}, { noTechnicalScoreMode: 'true' }, { noTechnicalScoreMode: false, outlineMode: 'response-file' }, null, []]) {
      expect(() => outlineGeneration.parseParams(bad)).toThrow(TypeError);
    }
    const outlineAdjustment = jobTypeRegistry.get('outline-adjustment')!;
    expect(outlineAdjustment.queue).toBe('agent');
    expect(outlineAdjustment.resumable).toBe(true);
    expect(outlineAdjustment.billable).toBe(true);
    expect(outlineAdjustment.agentLimits).toEqual(AGENT_TASK_LIMITS.outline);
    expect(outlineAdjustment.agentTools).toEqual(['ask-user', 'request-termination']);
    expect(outlineAdjustment.agentWorkspace).toEqual({ taskKind: 'technical-plan-outline-generation', keepAfterSuccess: true });
    expect(outlineAdjustment.agentSandboxTemplate ?? 'agent').toBe('agent');
    expect(outlineAdjustment.parseParams({ requirement: '删去进度计划' })).toEqual({ requirement: '删去进度计划' });
    for (const bad of [{}, { requirement: '' }, { requirement: '  有空白  ' }, { requirement: 'x'.repeat(2001) }, { requirement: 1 }, { requirement: '删去', extra: 1 }, null, []]) {
      expect(() => outlineAdjustment.parseParams(bad)).toThrow(TypeError);
    }
    const contentGeneration = jobTypeRegistry.get('content-generation')!;
    expect(contentGeneration.queue).toBe('agent');
    expect(contentGeneration.resumable).toBe(true);
    expect(contentGeneration.billable).toBe(true);
    expect(contentGeneration.agentLimits).toEqual(AGENT_TASK_LIMITS.contentGeneration);
    expect(contentGeneration.agentTools).toEqual(['ask-user', 'request-termination', 'generate-sections']);
    expect(contentGeneration.agentWorkspace).toEqual({ taskKind: 'technical-plan-content-generation', keepAfterSuccess: true });
    expect(contentGeneration.agentSandboxTemplate).toBe('agent-content');
    expect(contentGeneration.parseParams({ regenerate: false })).toEqual({ regenerate: false });
    expect(contentGeneration.parseParams({ regenerate: true })).toEqual({ regenerate: true });
    for (const bad of [{}, { regenerate: 'true' }, { regenerate: false, targetItemId: 'x' }, null, []]) {
      expect(() => contentGeneration.parseParams(bad)).toThrow(TypeError);
    }
    const adjustment = jobTypeRegistry.get('feasibility-outline-adjustment')!;
    expect(adjustment.queue).toBe('agent');
    expect(adjustment.resumable).toBe(true);
    expect(adjustment.billable).toBe(true);
    expect(adjustment.agentLimits).toEqual(AGENT_TASK_LIMITS.outline);
    expect(adjustment.agentTools).toEqual(['ask-user', 'request-termination']);
    expect(adjustment.agentWorkspace).toEqual({ taskKind: 'feasibility-outline', keepAfterSuccess: true });
    expect(adjustment.agentSandboxTemplate ?? 'agent').toBe('agent');
    expect(adjustment.parseParams({ requirement: '合并第二章' })).toEqual({ requirement: '合并第二章' });
    for (const bad of [{}, { requirement: '' }, { requirement: '  有空白  ' }, { requirement: 'x'.repeat(2001) }, { requirement: 1 }, { requirement: '合并', extra: 1 }, null, []]) {
      expect(() => adjustment.parseParams(bad)).toThrow(TypeError);
    }
  });
});
