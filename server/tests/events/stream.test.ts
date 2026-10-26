// 事件推送的纯函数（src/events/stream.ts、src/events/publisher.ts）：Stream ID 比较、事件解析与序列化。
import { describe, expect, it } from 'vitest';
import { serializeEvent } from '../../src/events/publisher.ts';
import { compareStreamIds, EVENT_MAX_BYTES, parseStreamEvent } from '../../src/events/stream.ts';

describe('compareStreamIds', () => {
  it('先比毫秒再比序号，按数值而不是字符串比较', () => {
    expect(compareStreamIds('1-0', '1-0')).toBe(0);
    expect(compareStreamIds('9-0', '10-0')).toBe(-1);
    expect(compareStreamIds('10-2', '10-10')).toBe(-1);
    expect(compareStreamIds('1792974606710-1', '1792974606710-0')).toBe(1);
    expect(['10-0', '9-5', '9-10'].sort(compareStreamIds)).toEqual(['9-5', '9-10', '10-0']);
  });
});

describe('parseStreamEvent', () => {
  it('解析合法事件，保留可选的 userId', () => {
    expect(parseStreamEvent('1-0', '{"type":"job","data":{"a":1}}')).toEqual({ id: '1-0', type: 'job', data: { a: 1 } });
    expect(parseStreamEvent('1-0', '{"type":"job.log","data":{},"userId":"u"}')).toEqual({ id: '1-0', type: 'job.log', data: {}, userId: 'u' });
  });

  it('格式不对时返回 null', () => {
    for (const [id, json] of [
      ['x', '{"type":"job","data":{}}'],
      ['1-0', 'not json'],
      ['1-0', 'null'],
      ['1-0', '{"type":"Job Type","data":{}}'],
      ['1-0', '{"type":"job","data":[]}'],
      ['1-0', '{"type":"job"}'],
      ['1-0', '{"type":"job","data":{},"userId":1}'],
    ] as const) {
      expect(parseStreamEvent(id, json), json).toBeNull();
    }
  });
});

describe('serializeEvent', () => {
  it('类型不合法或过大时抛 TypeError，换行等字符经 JSON 转义（不会拆开 SSE 的 data 行）', () => {
    expect(() => serializeEvent({ type: 'bad type', data: {} })).toThrow(TypeError);
    expect(() => serializeEvent({ type: 'job', data: { text: 'x'.repeat(EVENT_MAX_BYTES) } })).toThrow(TypeError);
    const json = serializeEvent({ type: 'job.log', data: { message: '第一行\n\nevent: forged\ndata: {}' } });
    expect(json).not.toContain('\n');
    expect(parseStreamEvent('1-0', json)?.data).toEqual({ message: '第一行\n\nevent: forged\ndata: {}' });
  });
});
