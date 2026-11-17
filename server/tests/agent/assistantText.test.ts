// Agent 回复全文的取回（src/agent/assistantText.ts，路线图第 8 步 8.6d2）：会话文件在工作区中、可以被 Agent 的命令任意改写，
// 按不可信数据解析——严格 UTF-8 与每行一个 JSON 对象，否则整个文件不可用；只取最后一条 assistant 消息的文本段；去掉控制字符与
// 孤立的代理项、按字符数截断不拆开代理对；上限不合法时抛 TypeError。真实 Pi 写出的会话文件见 tests/agent/piSession.test.ts。
import { describe, expect, it } from 'vitest';
import {
  AGENT_ASSISTANT_TEXT_MAX_CHARS,
  AGENT_ASSISTANT_TEXT_MAX_CHARS_LIMIT,
  AGENT_SESSION_FILE_READ_MAX_BYTES,
  agentAssistantTextLimit,
  extractAgentAssistantText,
} from '../../src/agent/assistantText.ts';

const header = { type: 'session', version: 3, id: 'abc', timestamp: '2026-11-17T00:00:00.000Z', cwd: '/workspace' };
const message = (role: string, content: unknown) => ({ type: 'message', id: Math.random().toString(16).slice(2, 10), parentId: null, timestamp: '2026-11-17T00:00:00.000Z', message: { role, content } });
const text = (value: string) => ({ type: 'text', text: value });
const file = (...entries: unknown[]) => Buffer.from(entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n') + '\n');

describe('extractAgentAssistantText', () => {
  it('取最后一条 assistant 消息的文本段（按换行连接、去掉首尾空白），跳过工具调用、思考与其他条目', () => {
    const data = file(
      header,
      message('user', '生成目录'),
      message('assistant', [text('第一轮')]),
      message('toolResult', [text('工具输出')]),
      message('assistant', [{ type: 'thinking', thinking: '想一想' }, text('  目录已调整：'), { type: 'toolCall', name: 'bash', arguments: {} }, text('合并了第 3、4 章。  ')]),
      { type: 'compaction', summary: '摘要' },
      { type: 'custom', data: 1 },
    );
    expect(extractAgentAssistantText(data)).toEqual({ text: '目录已调整：\n合并了第 3、4 章。', truncated: false });
  });

  it('最后一条 assistant 消息没有文本时为空字符串；没有 assistant 消息时为 null', () => {
    expect(extractAgentAssistantText(file(header, message('assistant', [text('早先')]), message('assistant', [{ type: 'toolCall', name: 'ls' }])))).toEqual({ text: '', truncated: false });
    expect(extractAgentAssistantText(file(header, message('assistant', 'not an array')))).toEqual({ text: '', truncated: false });
    expect(extractAgentAssistantText(file(header, message('user', '只有提问')))).toBeNull();
    expect(extractAgentAssistantText(Buffer.alloc(0))).toBeNull();
  });

  it.each<[string, Buffer]>([
    ['不是合法的 UTF-8', Buffer.concat([file(header, message('assistant', [text('好')])), Buffer.from([0xff, 0xfe, 0x0a])])],
    ['有一行不是 JSON', file(header, message('assistant', [text('好')]), '{"type":')],
    ['有一行是数组', file(header, [message('assistant', [text('好')])])],
    ['有一行是字符串', file(header, '"text"', message('assistant', [text('好')]))],
    ['有一行是 null', file(header, 'null', message('assistant', [text('好')]))],
  ])('文件不可用：%s → null', (_name, data) => {
    expect(extractAgentAssistantText(data)).toBeNull();
  });

  it('只认文本段：text 不是字符串、段不是对象的跳过；原型污染的条目不影响结果', () => {
    const data = file(header, message('assistant', [{ type: 'text', text: 1 }, null, 'raw', text('有效')]));
    expect(extractAgentAssistantText(data)).toEqual({ text: '有效', truncated: false });
    const polluted = Buffer.from(`${JSON.stringify(header)}\n{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"正文"}]},"__proto__":{"role":"user"}}\n`);
    expect(extractAgentAssistantText(polluted)).toEqual({ text: '正文', truncated: false });
  });

  it('去掉控制字符（保留换行与制表符，\\r\\n 换成 \\n）与孤立的代理项', () => {
    const data = file(header, message('assistant', [text('a\u0000b\u001b[31mc\u007f\u0085d\r\ne\tf\rg\ud800h\udc00i😀')]));
    expect(extractAgentAssistantText(data)).toEqual({ text: 'ab[31mcd\ne\tf\nghi😀', truncated: false });
  });

  it('按字符数截断，不拆开代理对；上限默认 64 Ki 字符', () => {
    expect(AGENT_ASSISTANT_TEXT_MAX_CHARS).toBe(64 * 1024);
    const long = file(header, message('assistant', [text('x'.repeat(AGENT_ASSISTANT_TEXT_MAX_CHARS + 10))]));
    expect(extractAgentAssistantText(long)).toEqual({ text: 'x'.repeat(AGENT_ASSISTANT_TEXT_MAX_CHARS), truncated: true });
    const emoji = file(header, message('assistant', [text('ab😀c')]));
    expect(extractAgentAssistantText(emoji, 3)).toEqual({ text: 'ab', truncated: true });
    expect(extractAgentAssistantText(emoji, 4)).toEqual({ text: 'ab😀', truncated: true });
    expect(extractAgentAssistantText(emoji, 5)).toEqual({ text: 'ab😀c', truncated: false });
  });

  it('文件超过读取上限时为 null；字符上限不合法时抛 TypeError', () => {
    expect(extractAgentAssistantText(Buffer.alloc(AGENT_SESSION_FILE_READ_MAX_BYTES + 1, 0x20))).toBeNull();
    for (const bad of [0, -1, 1.5, AGENT_ASSISTANT_TEXT_MAX_CHARS_LIMIT + 1, Number.NaN]) {
      expect(() => agentAssistantTextLimit(bad)).toThrow(TypeError);
      expect(() => extractAgentAssistantText(Buffer.alloc(0), bad)).toThrow(TypeError);
    }
    expect(agentAssistantTextLimit()).toBe(AGENT_ASSISTANT_TEXT_MAX_CHARS);
    expect(agentAssistantTextLimit(AGENT_ASSISTANT_TEXT_MAX_CHARS_LIMIT)).toBe(AGENT_ASSISTANT_TEXT_MAX_CHARS_LIMIT);
  });
});
