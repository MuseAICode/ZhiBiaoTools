// Agent 业务工具的登记检查（src/agent/tools.ts，路线图第 8 步 8.4a）：工具名、上限、封闭的参数 schema，
// 任务类型登记的工具（JobTypeDefinition.agentTools），agent-gw 的路由登记。数据库与端到端用例见 tests/db/agentTools.test.ts。
import { describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import { AGENT_GATEWAY_ROUTES } from '../../src/agent/gateway.ts';
import { AGENT_TOOLS, agentToolRegistry } from '../../src/agent/toolRegistry.ts';
import {
  AGENT_TOOL_CALL_PATH,
  AGENT_TOOL_MAX_ARGUMENT_BYTES,
  AGENT_TOOL_MAX_BODY_BYTES,
  AGENT_TOOL_MAX_CALLS_PER_JOB,
  AGENT_TOOL_MAX_CALLS_PER_MINUTE,
  agentToolCallBodySchema,
  assertAgentToolsRegistered,
  assertClosedSchema,
  createAgentToolRegistry,
  isValidAgentToolName,
  parseAgentResourceId,
  type AgentToolDefinition,
} from '../../src/agent/tools.ts';
import { createJobTypeRegistry, type JobTypeDefinition } from '../../src/jobs/definitions.ts';
import { jobTypeRegistry } from '../../src/jobs/registry.ts';

const closed = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', maxLength: 10 } } } as const;

function tool(overrides: Partial<AgentToolDefinition> = {}): AgentToolDefinition {
  return { name: 'demo-tool', argumentsSchema: closed, maxArgumentBytes: 1024, maxCallsPerJob: 10, maxCallsPerMinute: 10, run: async () => null, ...overrides };
}

describe('工具名', () => {
  it.each(['ab', 'report-failure', 'json-validation', 'a1', `a${'b'.repeat(63)}`])('合法：%s', (name) => {
    expect(isValidAgentToolName(name)).toBe(true);
  });
  it.each(['', 'a', 'A-tool', 'tool_', 'tool-', '-tool', '1tool', 'to ol', 'tool/x', `a${'b'.repeat(64)}`, 'ToolName'])('不合法：%j', (name) => {
    expect(isValidAgentToolName(name)).toBe(false);
    expect(() => createAgentToolRegistry([tool({ name })])).toThrow(TypeError);
  });
});

describe('登记检查', () => {
  it('对照组：合法的工具可以登记', () => {
    const registry = createAgentToolRegistry([tool(), tool({ name: 'other-tool' })]);
    expect(registry.names).toEqual(['demo-tool', 'other-tool']);
    expect(registry.get('demo-tool')?.maxCallsPerJob).toBe(10);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('重复登记、没有处理函数 → TypeError', () => {
    expect(() => createAgentToolRegistry([tool(), tool()])).toThrow(/重复/);
    expect(() => createAgentToolRegistry([tool({ run: undefined as never })])).toThrow(/处理函数/);
  });

  it.each([
    ['maxArgumentBytes', 0],
    ['maxArgumentBytes', AGENT_TOOL_MAX_ARGUMENT_BYTES + 1],
    ['maxCallsPerJob', 0],
    ['maxCallsPerJob', AGENT_TOOL_MAX_CALLS_PER_JOB + 1],
    ['maxCallsPerJob', 1.5],
    ['maxCallsPerMinute', 0],
    ['maxCallsPerMinute', AGENT_TOOL_MAX_CALLS_PER_MINUTE + 1],
    ['maxCallsPerMinute', Number.NaN],
  ])('上限 %s = %s → TypeError', (field, value) => {
    expect(() => createAgentToolRegistry([tool({ [field]: value })])).toThrow(TypeError);
  });

  it('参数上限留出外层字段的余量，不超过请求体上限', () => {
    expect(AGENT_TOOL_MAX_ARGUMENT_BYTES).toBeLessThan(AGENT_TOOL_MAX_BODY_BYTES);
    expect(() => createAgentToolRegistry([tool({ maxArgumentBytes: AGENT_TOOL_MAX_ARGUMENT_BYTES })])).not.toThrow();
  });

  it('顶层参数必须是对象', () => {
    expect(() => createAgentToolRegistry([tool({ argumentsSchema: { type: 'string', maxLength: 1 } })])).toThrow(/对象/);
    expect(() => createAgentToolRegistry([tool({ argumentsSchema: { anyOf: [closed] } })])).toThrow(/对象/);
  });
});

describe('参数 schema 必须封闭', () => {
  const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', additionalProperties: false, properties, ...extra });

  it.each([
    ['顶层没有 additionalProperties: false', { type: 'object', properties: {} }],
    ['additionalProperties: true', { type: 'object', additionalProperties: true, properties: {} }],
    ['additionalProperties 为 schema', { type: 'object', additionalProperties: { type: 'string', maxLength: 1 }, properties: {} }],
    ['嵌套对象不封闭', object({ inner: { type: 'object', properties: {} } })],
    ['数组元素是不封闭的对象', object({ list: { type: 'array', maxItems: 2, items: { type: 'object', properties: {} } } })],
    ['anyOf 分支不封闭', object({ value: { anyOf: [{ type: 'object', properties: {} }] } })],
    ['没有 properties', { type: 'object', additionalProperties: false }],
    ['required 列出未定义的属性', object({}, { required: ['org_id'] })],
    ['字符串没有 maxLength', object({ text: { type: 'string' } })],
    ['数组没有 maxItems', object({ list: { type: 'array', items: { type: 'string', maxLength: 1 } } })],
    ['数组没有 items', object({ list: { type: 'array', maxItems: 2 } })],
    ['$ref', object({ value: { $ref: '#/definitions/x' } })],
    ['patternProperties', { type: 'object', additionalProperties: false, properties: {}, patternProperties: { '.*': {} } }],
    ['if / then', object({ value: { type: 'string', maxLength: 1, if: {}, then: {} } })],
    ['allOf', object({ value: { allOf: [{ type: 'string', maxLength: 1 }] } })],
    ['not', object({ value: { not: {} } })],
    ['type 为数组', object({ value: { type: ['string', 'null'], maxLength: 1 } })],
    ['没有 type', object({ value: { maxLength: 1 } })],
    ['未知的 type', object({ value: { type: 'any' } })],
    ['不允许的 format', object({ value: { type: 'string', maxLength: 100, format: 'uri' } })],
    ['字符串使用数组的关键字', object({ value: { type: 'string', maxLength: 1, maxItems: 1 } })],
    ['enum 中有对象', object({ value: { enum: [{}] } })],
    ['空 enum', object({ value: { enum: [] } })],
    ['anyOf 与其他关键字一起', object({ value: { type: 'string', anyOf: [{ type: 'string', maxLength: 1 }] } })],
    ['schema 不是普通对象', object({ value: [] })],
    ['default（不做默认值填充）', object({ value: { type: 'string', maxLength: 1, default: 'x' } })],
  ])('%s → TypeError', (_name, schema) => {
    expect(() => assertClosedSchema(schema)).toThrow(TypeError);
    expect(() => createAgentToolRegistry([tool({ argumentsSchema: schema as never })])).toThrow(TypeError);
  });

  it('嵌套过深 → TypeError', () => {
    let schema: Record<string, unknown> = { type: 'string', maxLength: 1 };
    for (let i = 0; i < 20; i += 1) schema = object({ inner: schema });
    expect(() => assertClosedSchema(schema)).toThrow(/嵌套过深/);
  });

  it('对照组：常见的封闭 schema 可以登记', () => {
    const schema = object(
      {
        id: { type: 'string', maxLength: 36, format: 'uuid' },
        ids: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', maxLength: 36 } },
        mode: { enum: ['a', 'b'] },
        flag: { type: 'boolean', description: '开关' },
        count: { type: 'integer', minimum: 0, maximum: 10 },
        nested: object({ value: { anyOf: [{ type: 'string', maxLength: 5 }, { type: 'null' }] } }, { required: ['value'] }),
        fixed: { const: 'x' },
      },
      { required: ['id'] },
    );
    expect(() => assertClosedSchema(schema)).not.toThrow();
  });
});

describe('请求体 schema', () => {
  it('顶层只有 name 与 arguments；每个工具的参数 schema 按工具名套用', () => {
    const registry = createAgentToolRegistry([tool(), tool({ name: 'other-tool' })]);
    const schema = agentToolCallBodySchema(registry) as Record<string, any>;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(['name', 'arguments']);
    expect(schema.required).toEqual(['name', 'arguments']);
    expect(schema.allOf).toHaveLength(2);
    expect(schema.allOf[0].if.properties.name.const).toBe('demo-tool');
    expect(schema.allOf[0].then.properties.arguments).toBe(registry.get('demo-tool')!.argumentsSchema);
    // 没有工具时不生成空的 allOf。
    expect(agentToolCallBodySchema(createAgentToolRegistry([]))).not.toHaveProperty('allOf');
  });
});

describe('资源标识的格式', () => {
  it('只接受小写的 UUID，其余一律 404 AGENT_RESOURCE_NOT_FOUND', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseAgentResourceId(id)).toBe(id);
    for (const value of [id.toUpperCase(), `${id} `, '', 'x', 1, null, undefined, {}, `../${id}`]) {
      expect(() => parseAgentResourceId(value)).toThrow(expect.objectContaining({ statusCode: 404, code: 'AGENT_RESOURCE_NOT_FOUND' }));
    }
  });
});

describe('任务类型登记的工具', () => {
  const agent = (overrides: Partial<JobTypeDefinition> = {}): JobTypeDefinition => ({
    type: 'agent-demo',
    queue: 'agent',
    resumable: true,
    billable: true,
    agentLimits: AGENT_TASK_LIMITS.outline,
    parseParams: (raw) => raw,
    run: async () => {},
    ...overrides,
  });

  it('对照组：agent 队列的任务类型可以登记工具', () => {
    expect(createJobTypeRegistry([agent({ agentTools: ['demo-tool'] })]).get('agent-demo')?.agentTools).toEqual(['demo-tool']);
  });

  it('非 agent 队列不能登记；工具名不合法、重复 → TypeError', () => {
    expect(() => createJobTypeRegistry([agent({ type: 'ai-demo', queue: 'ai', agentLimits: undefined, agentTools: ['demo-tool'] } as never)])).toThrow(/agent 队列/);
    expect(() => createJobTypeRegistry([agent({ agentTools: ['Bad_Name'] })])).toThrow(TypeError);
    expect(() => createJobTypeRegistry([agent({ agentTools: ['demo-tool', 'demo-tool'] })])).toThrow(TypeError);
  });

  it('assertAgentToolsRegistered：登记了未定义的工具 → TypeError', () => {
    const registry = createAgentToolRegistry([tool()]);
    expect(() => assertAgentToolsRegistered([{ type: 'agent-demo', agentTools: ['demo-tool'] }], registry)).not.toThrow();
    expect(() => assertAgentToolsRegistered([{ type: 'agent-demo', agentTools: ['missing-tool'] }], registry)).toThrow(/missing-tool/);
  });

  it('生产登记：任务类型登记的工具都已定义（worker 启动时同样检查）', () => {
    expect(agentToolRegistry.names).toEqual(AGENT_TOOLS.map((item) => item.name));
    expect(() => assertAgentToolsRegistered(jobTypeRegistry.types, agentToolRegistry)).not.toThrow();
  });
});

describe('agent-gw 的路由登记', () => {
  it('业务工具 RPC 只有一个路径，带自己的请求体上限', () => {
    expect(AGENT_GATEWAY_ROUTES).toContainEqual({ method: 'POST', path: AGENT_TOOL_CALL_PATH, bodyLimit: AGENT_TOOL_MAX_BODY_BYTES });
    expect(AGENT_GATEWAY_ROUTES.filter((route) => route.path.startsWith('/v1/tools'))).toHaveLength(1);
  });
});
