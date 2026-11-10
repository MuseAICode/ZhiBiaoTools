// AI 网关的工具调用（src/ai/tools.ts、src/ai/providers.ts、src/ai/estimate.ts；路线图 8.2c1）的单元测试：
// 请求校验（工具定义、工具选择、消息中的工具字段）、流式工具调用的汇总（结构不合法 → 上游响应不合法；模型写的内容原样保留）、
// 发给服务商的请求体只含校验过的字段、冻结上界计入工具字节且不用工具时不变。
import { describe, expect, it } from 'vitest';
import { estimateInputTokens, inputTokenUpperBound, TOOLS_OVERHEAD_TOKENS } from '../../src/ai/estimate.ts';
import { PROVIDER_ADAPTERS, type ChatMessage, type ChatTool } from '../../src/ai/providers.ts';
import {
  assertToolRequest,
  MAX_TOOL_CALLS,
  MAX_TOOL_PARAMETERS_BYTES,
  MAX_TOOL_SCHEMA_DEPTH,
  MAX_TOOLS,
  MAX_TOOLS_TOTAL_BYTES,
  ToolCallAccumulator,
  ToolRequestError,
} from '../../src/ai/tools.ts';
import { UpstreamError } from '../../src/ai/upstream.ts';

const BASH: ChatTool = {
  name: 'bash',
  description: '执行一条 shell 命令',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
};
const READ: ChatTool = { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
const CALL = { id: 'call_0', name: 'bash', arguments: '{"command":"ls"}' };
const CONVERSATION: ChatMessage[] = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '列出文件' },
  { role: 'assistant', content: '', toolCalls: [CALL] },
  { role: 'tool', content: 'a.txt', toolCallId: 'call_0' },
];

function rejects(messages: readonly ChatMessage[], tools: unknown, toolChoice?: unknown) {
  expect(() => assertToolRequest(messages, tools, toolChoice)).toThrow(ToolRequestError);
}

function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { type: 'string' };
  for (let level = 1; level < depth; level += 1) value = { items: value };
  return value;
}

describe('请求校验', () => {
  it('对照组：工具定义、各种工具选择、带工具调用与工具结果的对话都通过；不用工具的请求不受影响', () => {
    expect(() => assertToolRequest(CONVERSATION, [BASH, READ], undefined)).not.toThrow();
    for (const choice of ['auto', 'none', 'required', { name: 'read' }]) {
      expect(() => assertToolRequest(CONVERSATION, [BASH, READ], choice)).not.toThrow();
    }
    expect(() => assertToolRequest([{ role: 'user', content: 'hi' }], undefined, undefined)).not.toThrow();
    // 历史中的工具调用名称是模型输出：不在工具列表中、为空也照样接受（由服务商与 Pi 处理）。
    expect(() => assertToolRequest([{ role: 'assistant', content: '', toolCalls: [{ id: 'x', name: '', arguments: 'not json' }] }], undefined, undefined)).not.toThrow();
    // 嵌套深度、大小恰好在上限内。
    expect(() => assertToolRequest([], [{ name: 'deep', parameters: nested(MAX_TOOL_SCHEMA_DEPTH) }], undefined)).not.toThrow();
  });

  it('工具定义：空列表、超过上限、名称不合法或重复、说明过长、参数不是普通 JSON 对象、过深、过大都拒绝', () => {
    const many = Array.from({ length: MAX_TOOLS + 1 }, (_value, index) => ({ name: `t${index}`, parameters: {} }));
    const bad: unknown[] = [
      [],
      {},
      many,
      [null],
      [{ name: 'bad name', parameters: {} }],
      [{ name: 'a'.repeat(65), parameters: {} }],
      [{ name: '工具', parameters: {} }],
      [{ parameters: {} }],
      [BASH, { ...READ, name: 'bash' }],
      [{ name: 'x', description: 'a'.repeat(8 * 1024 + 1), parameters: {} }],
      [{ name: 'x', description: 1, parameters: {} }],
      [{ name: 'x' }],
      [{ name: 'x', parameters: [] }],
      [{ name: 'x', parameters: 'object' }],
      [{ name: 'x', parameters: { bad: Number.NaN } }],
      [{ name: 'x', parameters: { bad: undefined } }],
      [{ name: 'x', parameters: { bad: () => 1 } }],
      [{ name: 'x', parameters: { bad: new Date() } }],
      [{ name: 'x', parameters: Object.create({ inherited: true }) }],
      [{ name: 'deep', parameters: nested(MAX_TOOL_SCHEMA_DEPTH + 1) }],
      [{ name: 'big', parameters: { description: 'x'.repeat(MAX_TOOL_PARAMETERS_BYTES) } }],
      Array.from({ length: 10 }, (_value, index) => ({ name: `t${index}`, parameters: { d: 'x'.repeat(MAX_TOOLS_TOTAL_BYTES / 10) } })),
    ];
    for (const tools of bad) rejects([], tools);
  });

  it('工具选择：没有工具时不能指定；只能是 auto / none / required 或列表中的工具名', () => {
    rejects([], undefined, 'auto');
    for (const choice of ['any', '', { name: 'missing' }, { name: 'bash', extra: 1 }, { type: 'function', function: { name: 'bash' } }, null, 1]) {
      rejects([], [BASH], choice);
    }
  });

  it('消息中的工具字段：只有 assistant 能带工具调用、只有 tool 能带 toolCallId，tool 消息必须回应前面的调用', () => {
    const cases: ChatMessage[][] = [
      [{ role: 'user', content: 'x', toolCalls: [CALL] }],
      [{ role: 'system', content: 'x', toolCalls: [CALL] }],
      [{ role: 'user', content: 'x', toolCallId: 'call_0' }],
      [{ role: 'assistant', content: 'x', toolCallId: 'call_0' }],
      [{ role: 'tool', content: 'x' }],
      // 凭空的工具结果、回应后面才出现的调用。
      [{ role: 'tool', content: 'x', toolCallId: 'call_0' }],
      [{ role: 'tool', content: 'x', toolCallId: 'call_0' }, { role: 'assistant', content: '', toolCalls: [CALL] }],
      [{ role: 'assistant', content: '', toolCalls: [CALL] }, { role: 'tool', content: 'x', toolCallId: 'call_1' }],
      [{ role: 'assistant', content: '', toolCalls: [] }],
      [{ role: 'assistant', content: '', toolCalls: Array.from({ length: MAX_TOOL_CALLS + 1 }, (_value, index) => ({ ...CALL, id: `c${index}` })) }],
      [{ role: 'assistant', content: '', toolCalls: [{ ...CALL, id: '' }] }],
      [{ role: 'assistant', content: '', toolCalls: [{ ...CALL, id: 'has space' }] }],
      [{ role: 'assistant', content: '', toolCalls: [{ ...CALL, id: 'a'.repeat(129) }] }],
      [{ role: 'assistant', content: '', toolCalls: [{ ...CALL, arguments: { command: 'ls' } as unknown as string }] }],
      [{ role: 'assistant', content: '', toolCalls: [{ id: 'x', arguments: '{}' } as unknown as typeof CALL] }],
      [{ role: 'assistant', content: '', toolCalls: 'call_0' as unknown as [] }],
    ];
    for (const messages of cases) rejects(messages, undefined);
  });
});

describe('流式工具调用的汇总', () => {
  it('按 index 归并：id、name 取第一次出现的值，arguments 依次拼接；多个调用按顺序返回；各段归位后交给 onDelta', () => {
    const acc = new ToolCallAccumulator();
    expect(acc.add(undefined)).toEqual([]);
    expect(acc.add(null)).toEqual([]);
    expect(acc.add([{ index: 0, id: 'call_a', type: 'function', function: { name: 'bash', arguments: '' } }])).toEqual([{ index: 0, id: 'call_a', name: 'bash' }]);
    // 通义千问的后续块：id 为空串、name 为 null。
    expect(acc.add([{ index: 0, id: '', function: { name: null, arguments: '{"command":' } }])).toEqual([{ index: 0, arguments: '{"command":' }]);
    expect(acc.add([{ index: 0, id: 'call_a', function: { name: 'bash', arguments: '"ls"}' } }])).toEqual([{ index: 0, arguments: '"ls"}' }]);
    expect(acc.add([{ index: 1, id: 'call_b', function: { name: 'read', arguments: '{}' } }])).toEqual([{ index: 1, id: 'call_b', name: 'read', arguments: '{}' }]);
    expect(acc.finish()).toEqual([
      { id: 'call_a', name: 'bash', arguments: '{"command":"ls"}' },
      { id: 'call_b', name: 'read', arguments: '{}' },
    ]);
  });

  it('只有一个调用时省略 index：沿用上一个调用（还没有时为 0）', () => {
    const acc = new ToolCallAccumulator();
    acc.add([{ id: 'call_a', function: { name: 'bash' } }]);
    acc.add([{ function: { arguments: '{}' } }]);
    expect(acc.finish()).toEqual([{ id: 'call_a', name: 'bash', arguments: '{}' }]);
  });

  it('模型写的内容原样保留（照常收费）：名称不在列表中或带奇怪字符、名称不一致（保留第一次）、arguments 不是 JSON', () => {
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 0, id: 'call_a', function: { name: 'rm -rf /', arguments: 'not json' } }]);
    acc.add([{ index: 0, function: { name: 'other' } }]);
    acc.add([{ index: 1, id: 'call_b', function: { arguments: '{}' } }]);
    expect(acc.finish()).toEqual([
      { id: 'call_a', name: 'rm -rf /', arguments: 'not json' },
      { id: 'call_b', name: '', arguments: '{}' },
    ]);
  });

  it('结构不合法（服务商的责任）：按上游响应不合法处理（不收费）', () => {
    const bad: unknown[][] = [
      [{ index: -1, id: 'a' }],
      [{ index: 1.5, id: 'a' }],
      [{ index: '0', id: 'a' }],
      [{ index: MAX_TOOL_CALLS, id: 'a' }],
      // 跳号。
      [{ index: 1, id: 'a' }],
      // 多个调用时缺 index。
      [{ id: 'a' }, { id: 'b' }],
      [{ index: 0, id: 1 }],
      [{ index: 0, type: 'code_interpreter' }],
      [{ index: 0, function: 'bash' }],
      [{ index: 0, function: { name: 1 } }],
      [{ index: 0, function: { arguments: { a: 1 } } }],
      ['call'],
      Array.from({ length: MAX_TOOL_CALLS + 1 }, (_value, index) => ({ index, id: `c${index}` })),
    ];
    for (const chunk of bad) {
      expect(() => new ToolCallAccumulator().add(chunk), JSON.stringify(chunk).slice(0, 80)).toThrow(UpstreamError);
    }
    expect(() => new ToolCallAccumulator().add({ index: 0 })).toThrow(UpstreamError);
    // 同一 index 出现两个不同的 id。
    const conflict = new ToolCallAccumulator();
    conflict.add([{ index: 0, id: 'a' }]);
    expect(() => conflict.add([{ index: 0, id: 'b' }])).toThrow(UpstreamError);
    // 结束时缺 id。
    const missing = new ToolCallAccumulator();
    missing.add([{ index: 0, function: { name: 'bash', arguments: '{}' } }]);
    expect(() => missing.finish()).toThrow(UpstreamError);
    expect(missing.snapshot()).toEqual([{ id: '', name: 'bash', arguments: '{}' }]);
  });
});

describe('发给服务商的请求体', () => {
  const build = (messages: readonly ChatMessage[], extra: Partial<Parameters<typeof PROVIDER_ADAPTERS.deepseek.buildBody>[0]> = {}) =>
    PROVIDER_ADAPTERS.deepseek.buildBody({ model: 'deepseek-chat', messages, maxOutputTokens: 100, temperature: undefined, ...extra });

  it('工具定义、工具选择、工具调用与工具结果按 OpenAI 兼容格式转出；只有工具调用的 assistant 消息 content 为 null', () => {
    const body = build(CONVERSATION, { tools: [BASH], toolChoice: { name: 'bash' } });
    expect(body).toMatchObject({
      tools: [{ type: 'function', function: { name: 'bash', description: '执行一条 shell 命令', parameters: BASH.parameters } }],
      tool_choice: { type: 'function', function: { name: 'bash' } },
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '列出文件' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
        { role: 'tool', tool_call_id: 'call_0', content: 'a.txt' },
      ],
    });
    expect(build([{ role: 'user', content: 'x' }], { tools: [READ], toolChoice: 'required' })).toMatchObject({ tool_choice: 'required' });
  });

  it('消息与工具上的其他字段（Base URL、自称的组织等）不转给服务商；不用工具的请求体与之前相同', () => {
    const forged = [
      { role: 'user', content: 'x', name: 'admin', base_url: 'http://evil', org_id: 'other' },
      { role: 'assistant', content: 'y', toolCalls: [{ ...CALL, type: 'code', extra: 1 }], tool_call_id: 'z' },
      { role: 'tool', content: 'r', toolCallId: 'call_0', name: 'bash' },
    ] as unknown as ChatMessage[];
    const body = build(forged, { tools: [{ ...BASH, strict: true } as ChatTool] });
    expect(body.messages).toEqual([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'y', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'call_0', content: 'r' },
    ]);
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'bash', description: '执行一条 shell 命令', parameters: BASH.parameters } }]);

    expect(build([{ role: 'user', content: 'x' }])).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 100,
      stream: true,
      stream_options: { include_usage: true },
    });
  });
});

describe('冻结上界与估算', () => {
  it('不用工具时与之前的公式相同；工具定义、工具调用、工具结果的字节都计入上界，并且不小于其 UTF-8 字节数', () => {
    const plain: ChatMessage[] = [{ role: 'user', content: '你好' }];
    expect(inputTokenUpperBound(plain)).toBe(64 + 16 + 4 + 6);
    expect(inputTokenUpperBound(plain, undefined)).toBe(inputTokenUpperBound(plain));

    const withTools = inputTokenUpperBound(CONVERSATION, [BASH, READ]);
    const toolBytes = [BASH, READ].reduce((total, tool) => total + Buffer.byteLength(JSON.stringify(tool), 'utf8'), 0);
    const callBytes = Buffer.byteLength(JSON.stringify(CALL), 'utf8') + Buffer.byteLength('call_0', 'utf8');
    expect(withTools).toBeGreaterThanOrEqual(inputTokenUpperBound(CONVERSATION) + TOOLS_OVERHEAD_TOKENS + toolBytes - 100);
    expect(inputTokenUpperBound(CONVERSATION)).toBeGreaterThanOrEqual(inputTokenUpperBound(CONVERSATION.map(({ role, content }) => ({ role, content }))) + callBytes - 40);
    // 工具参数越大，上界越大（逐字节）。
    const bigger = { ...BASH, parameters: { ...BASH.parameters, description: 'x'.repeat(1000) } };
    expect(inputTokenUpperBound(CONVERSATION, [bigger]) - inputTokenUpperBound(CONVERSATION, [BASH])).toBeGreaterThanOrEqual(1000);
    expect(estimateInputTokens(CONVERSATION, [bigger])).toBeGreaterThan(estimateInputTokens(CONVERSATION, [BASH]));
    expect(estimateInputTokens(CONVERSATION)).toBeGreaterThan(estimateInputTokens(CONVERSATION.map(({ role, content }) => ({ role, content }))));
  });
});
