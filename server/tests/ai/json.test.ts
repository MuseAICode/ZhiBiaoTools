// 从模型输出中解析 JSON（src/ai/json.ts，取代桌面版 aiService.cjs 的 parseJsonContent / buildJsonRepairMessages）。
import { describe, expect, it } from 'vitest';
import { buildJsonRepairMessages, jsonIssues, parseJsonContent } from '../../src/ai/json.ts';

describe('parseJsonContent', () => {
  it('整段、代码块包裹、夹在说明中的 JSON 都能解析', () => {
    expect(parseJsonContent('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonContent('\uFEFF ```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonContent('结果如下：```\n[{"x":"y"}]\n```以上')).toEqual([{ x: 'y' }]);
    expect(parseJsonContent('结果是 {"findings":[{"t":"a}b"}]} 请查收')).toEqual({ findings: [{ t: 'a}b' }] });
  });

  it('修复字符串中的非法反斜杠转义（Markdown 转义去掉反斜杠，其他保留为字面反斜杠）', () => {
    expect(parseJsonContent('{"a":"1\\. 条款"}')).toEqual({ a: '1. 条款' });
    expect(parseJsonContent('{"a":"C:\\q","b":"\\u12"}')).toEqual({ a: 'C:\\q', b: '\\u12' });
  });

  it('都不合法时抛 SyntaxError；括号配平最多从前 32 个左括号开始，病态输入不会长时间占用 CPU', () => {
    expect(() => parseJsonContent('没有 JSON')).toThrow(SyntaxError);
    expect(() => parseJsonContent('')).toThrow(SyntaxError);
    const started = Date.now();
    expect(() => parseJsonContent('{'.repeat(200_000))).toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(parseJsonContent(`${'{'.repeat(31)} {"ok":true}`)).toEqual({ ok: true });
  });
});

describe('修复请求', () => {
  it('问题说明与修复消息与桌面版相同，待修复内容最多 60,000 字', () => {
    let syntax: unknown;
    try {
      JSON.parse('{');
    } catch (error) {
      syntax = error;
    }
    expect(jsonIssues(syntax)[0]).toMatch(/^JSON 语法错误：/);
    expect(jsonIssues(new Error('缺少字段'))).toEqual(['缺少字段']);
    const messages = buildJsonRepairMessages('x'.repeat(70_000), ['问题一', '问题二'], '错别字检查结果');
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'user', 'user', 'user']);
    expect(messages[1]!.content).toBe('目标结果类型：错别字检查结果');
    expect(messages[2]!.content).toBe('当前校验问题：\n1. 问题一\n2. 问题二');
    expect(messages[3]!.content).toBe(`待修复内容：\n\`\`\`json\n${'x'.repeat(60_000)}\n\`\`\``);
  });
});
