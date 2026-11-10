// AI 网关的工具调用（路线图第 8 步 8.2c1；docs/SERVER_DESIGN.md 第 7.13 节）：Agent（Pi 运行时）需要 OpenAI 兼容的
// function calling。本模块只做三件事，计费、步骤幂等、并发都沿用网关原有的实现：
//
// 1. 校验请求中的工具定义、工具选择和带工具字段的消息（assertToolRequest）。8.2c2 起这些内容来自 agent 沙箱，按不可信输入
//    处理：工具数、名称、说明、参数 schema 的大小与嵌套深度都有上限；只有 assistant 消息能带 toolCalls，只有 tool 消息能带
//    toolCallId，且 tool 消息必须回应前面 assistant 消息中出现过的调用 id；工具选择指定的工具必须在工具列表中。
//    不合法时 400、不冻结、不调用服务商。发给服务商的请求体只由校验过的字段重新组装（src/ai/providers.ts），其他字段不转。
// 2. 汇总流式输出中的 delta.tool_calls（ToolCallAccumulator）：按 index 归并，id、name 取第一次出现的非空值，arguments 依次拼接。
//    **结构**由服务商决定——index 不是 0～上限的整数、同一 index 出现两个不同的 id、字段类型不对、结束时缺 id——按上游响应
//    不合法处理（不收费，与截断的输出相同）；**内容**由模型决定——工具名不在列表中、名称为空或带奇怪字符、arguments 不是合法
//    JSON——照常收费、原样返回，由调用方（Pi）处理。否则提示注入可以让模型故意写坏工具调用来白用模型。
// 3. 冻结与估算用的字节数（toolRequestBytes / toolCallBytes），以及步骤幂等的请求内容（canonicalTools）。
import { JOB_STEP_MAX_TOOL_CALLS } from '../db/migrations/0032_job_step_tool_calls.ts';
import type { ChatMessage, ChatTool, ChatToolCall, ChatToolChoice } from './providers.ts';
import { UpstreamError } from './upstream.ts';

/** 一次请求最多的工具数。 */
export const MAX_TOOLS = 128;
/** 一条 assistant 消息、一次输出中最多的工具调用数（步骤结果按同一上限保存，迁移 0032）。 */
export const MAX_TOOL_CALLS = JOB_STEP_MAX_TOOL_CALLS;
/** 工具名（OpenAI 的规则）。 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 工具调用 id：由服务商生成，只收可见 ASCII。 */
export const TOOL_CALL_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
export const MAX_TOOL_DESCRIPTION_CHARS = 8 * 1024;
/** 单个工具参数 schema 序列化后的字节数上限、全部工具定义合计的上限。 */
export const MAX_TOOL_PARAMETERS_BYTES = 64 * 1024;
export const MAX_TOOLS_TOTAL_BYTES = 512 * 1024;
/** 参数 schema 的嵌套深度上限。 */
export const MAX_TOOL_SCHEMA_DEPTH = 32;

export class ToolRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRequestError';
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** 只含 JSON 类型（对象、数组、字符串、有限数字、布尔、null），嵌套深度不超过上限。迭代检查，不递归。 */
function isJsonValue(root: unknown, maxDepth: number): boolean {
  const stack: Array<[unknown, number]> = [[root, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (depth > maxDepth) return false;
    if (Array.isArray(value)) {
      for (const item of value) stack.push([item, depth + 1]);
    } else if (isPlainObject(value)) {
      for (const item of Object.values(value)) stack.push([item, depth + 1]);
    } else {
      return false;
    }
  }
  return true;
}

function assertTools(tools: unknown): readonly ChatTool[] {
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > MAX_TOOLS) throw new ToolRequestError(`工具数应为 1 到 ${MAX_TOOLS} 个`);
  const names = new Set<string>();
  let total = 0;
  for (const tool of tools as unknown[]) {
    if (!isPlainObject(tool)) throw new ToolRequestError('工具定义不合法');
    const { name, description, parameters } = tool;
    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) throw new ToolRequestError('工具名不合法');
    if (names.has(name)) throw new ToolRequestError('工具名重复');
    names.add(name);
    if (description !== undefined && (typeof description !== 'string' || description.length > MAX_TOOL_DESCRIPTION_CHARS)) {
      throw new ToolRequestError('工具说明不合法');
    }
    if (!isPlainObject(parameters) || !isJsonValue(parameters, MAX_TOOL_SCHEMA_DEPTH)) throw new ToolRequestError('工具参数定义不合法');
    const bytes = Buffer.byteLength(JSON.stringify(parameters), 'utf8');
    if (bytes > MAX_TOOL_PARAMETERS_BYTES) throw new ToolRequestError('工具参数定义过大');
    total += bytes + Buffer.byteLength(name, 'utf8') + Buffer.byteLength((description as string | undefined) ?? '', 'utf8');
    if (total > MAX_TOOLS_TOTAL_BYTES) throw new ToolRequestError('工具定义合计过大');
  }
  return tools as readonly ChatTool[];
}

function assertToolChoice(choice: unknown, tools: readonly ChatTool[] | undefined): void {
  if (!tools) throw new ToolRequestError('没有工具时不能指定工具选择');
  if (choice === 'auto' || choice === 'none' || choice === 'required') return;
  if (isPlainObject(choice) && Object.keys(choice).length === 1 && typeof choice.name === 'string' && tools.some((tool) => tool.name === choice.name)) return;
  throw new ToolRequestError('工具选择不合法');
}

function assertToolCalls(calls: unknown, seen: Set<string>): void {
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_TOOL_CALLS) throw new ToolRequestError('工具调用记录不合法');
  for (const call of calls as unknown[]) {
    if (!isPlainObject(call)) throw new ToolRequestError('工具调用记录不合法');
    const { id, name, arguments: args } = call;
    if (typeof id !== 'string' || !TOOL_CALL_ID_PATTERN.test(id)) throw new ToolRequestError('工具调用 id 不合法');
    // 名称与 arguments 是模型输出，不按 TOOL_NAME_PATTERN 检查（见文件头第 2 条），大小由请求整体的上限约束。
    if (typeof name !== 'string' || typeof args !== 'string') throw new ToolRequestError('工具调用记录不合法');
    seen.add(id);
  }
}

/**
 * 校验工具定义、工具选择与消息中的工具字段（消息的角色与 content 由网关先行校验）。不合法时抛 ToolRequestError。
 */
export function assertToolRequest(messages: readonly ChatMessage[], tools: unknown, toolChoice: unknown): void {
  const checkedTools = tools === undefined ? undefined : assertTools(tools);
  if (toolChoice !== undefined) assertToolChoice(toolChoice, checkedTools);
  const callIds = new Set<string>();
  for (const message of messages) {
    if (message.toolCalls !== undefined) {
      if (message.role !== 'assistant') throw new ToolRequestError('只有 assistant 消息能带工具调用');
      assertToolCalls(message.toolCalls, callIds);
    }
    if (message.role === 'tool') {
      // 必须回应前面出现过的工具调用：凭空的 tool 消息由服务商拒绝前先在这里拒绝。
      if (typeof message.toolCallId !== 'string' || !callIds.has(message.toolCallId)) throw new ToolRequestError('工具结果没有对应的工具调用');
    } else if (message.toolCallId !== undefined) {
      throw new ToolRequestError('只有 tool 消息能带 toolCallId');
    }
  }
}

/** 工具调用的字节数（id、名称、arguments），用于冻结上界与本地估算。 */
export function toolCallBytes(calls: readonly ChatToolCall[] | undefined): number {
  if (!calls) return 0;
  let total = 0;
  for (const call of calls) total += Buffer.byteLength(call.id, 'utf8') + Buffer.byteLength(call.name, 'utf8') + Buffer.byteLength(call.arguments, 'utf8');
  return total;
}

/** 工具定义序列化后的字节数（名称、说明、参数 schema），用于冻结上界与本地估算。 */
export function toolDefinitionBytes(tool: ChatTool): number {
  return Buffer.byteLength(tool.name, 'utf8') + Buffer.byteLength(tool.description ?? '', 'utf8') + Buffer.byteLength(JSON.stringify(tool.parameters), 'utf8');
}

/** 步骤幂等的请求内容中工具定义与工具选择的部分。 */
export function canonicalTools(tools: readonly ChatTool[] | undefined, toolChoice: ChatToolChoice | undefined): unknown {
  return [
    tools?.map((tool) => [tool.name, tool.description ?? null, JSON.stringify(tool.parameters)]) ?? null,
    toolChoice === undefined ? null : typeof toolChoice === 'string' ? toolChoice : { name: toolChoice.name },
  ];
}

/** 流式输出中工具调用的一段（已按 index 归位），交给 onDelta。 */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

const invalidResponse = () => new UpstreamError('invalid_upstream_response');

/** 汇总流式输出中的 delta.tool_calls。结构不合法时抛 UpstreamError（invalid_upstream_response，不收费）。 */
export class ToolCallAccumulator {
  private readonly calls: PartialCall[] = [];
  private lastIndex = -1;

  /** 处理一个块中的 delta.tool_calls，返回归位后的各段（没有时为空数组）。 */
  add(raw: unknown): ToolCallDelta[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_TOOL_CALLS) throw invalidResponse();
    const pieces: ToolCallDelta[] = [];
    for (const item of raw as unknown[]) {
      if (!isPlainObject(item)) throw invalidResponse();
      let index = item.index;
      // 个别服务商只有一个调用时省略 index：沿用上一个（还没有时为 0）。
      if (index === undefined && raw.length === 1) index = Math.max(this.lastIndex, 0);
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_TOOL_CALLS) throw invalidResponse();
      // 新的调用只能紧接着已有的（index 连续），不能跳号。
      if (index > this.calls.length) throw invalidResponse();
      if (item.type !== undefined && item.type !== null && item.type !== 'function') throw invalidResponse();
      const fn = item.function;
      if (fn !== undefined && fn !== null && !isPlainObject(fn)) throw invalidResponse();
      const id = item.id;
      const name = (fn as Record<string, unknown> | null | undefined)?.name;
      const args = (fn as Record<string, unknown> | null | undefined)?.arguments;
      if ((id !== undefined && id !== null && typeof id !== 'string') || (name !== undefined && name !== null && typeof name !== 'string')) throw invalidResponse();
      if (args !== undefined && args !== null && typeof args !== 'string') throw invalidResponse();

      const call = this.calls[index] ?? (this.calls[index] = { id: '', name: '', arguments: '' });
      this.lastIndex = index;
      const piece: ToolCallDelta = { index };
      if (typeof id === 'string' && id !== '') {
        if (call.id === '') {
          call.id = id;
          piece.id = id;
        } else if (call.id !== id) {
          throw invalidResponse();
        }
      }
      // 名称是模型输出：取第一次出现的非空值，之后重复的同名忽略，不同的名称不改（原样保留第一次的）。
      if (typeof name === 'string' && name !== '' && call.name === '') {
        call.name = name;
        piece.name = name;
      }
      if (typeof args === 'string' && args !== '') {
        call.arguments += args;
        piece.arguments = args;
      }
      if (piece.id !== undefined || piece.name !== undefined || piece.arguments !== undefined) pieces.push(piece);
    }
    return pieces;
  }

  /** 输出结束：返回按 index 排列的工具调用。缺 id（服务商没有给出）时抛 UpstreamError。 */
  finish(): ChatToolCall[] {
    for (const call of this.calls) {
      if (!TOOL_CALL_ID_PATTERN.test(call.id)) throw invalidResponse();
    }
    return this.snapshot();
  }

  /** 目前为止的工具调用（调用中途取消时，按已产生的用量估算用；id 可能为空）。 */
  snapshot(): ChatToolCall[] {
    return this.calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }));
  }
}
