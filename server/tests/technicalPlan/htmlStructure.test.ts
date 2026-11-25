// 小节 HTML 的结构检查（路线图第 8 步 8.10c2a，src/technicalPlan/htmlStructure.ts）与桌面版 client/electron/utils/htmlStructure.cjs 的对照。
// server/ 不安装 cheerio，桌面版的结果由 fixtures/generateHtmlStructureExpected.mjs（桌面版 cheerio 1.2.0）对同一输入预先生成：
// 每个输入的问题清单（不检查 / 检查源码完整性两种）与 closeOpenTemplates 的结果都须逐字相同。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_TEMPLATE_HTML } from '../../src/technicalPlan/contentWritingResources.ts';
import { assertHtmlStructure, closeOpenTemplates, findHtmlStructureIssues, HtmlStructureError } from '../../src/technicalPlan/htmlStructure.ts';

interface Expected {
  issues: string[];
  completeIssues: string[];
  closed: { html: string; closed: number };
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/htmlStructureCases.json', import.meta.url), 'utf8')) as {
  cases: { name: string; html: string }[];
  expected: Record<string, Expected>;
};
const inputs = [...fixture.cases, { name: '正文模板.html', html: CONTENT_TEMPLATE_HTML }];

describe('findHtmlStructureIssues / closeOpenTemplates (desktop parity)', () => {
  it('has a desktop result for every input', () => {
    expect(Object.keys(fixture.expected).sort()).toEqual(inputs.map((input) => input.name).sort());
    // 对照组：样本覆盖了每一类问题与补齐。
    const all = Object.values(fixture.expected);
    expect(all.some((item) => item.closed.closed > 1)).toBe(true);
    expect(all.some((item) => item.completeIssues.length > item.issues.length)).toBe(true);
    for (const fragment of ['缺少结束标签', '异常结束标记', '嵌套在另一个 figure 中', '被其他元素包裹', '仅包含一个 img', 'data-app-size', '须放在 figure 内', '注释尚未结束', '标签尚未结束', '标签尚未写完', '元素源码尚未结束']) {
      expect(all.some((item) => item.completeIssues.some((issue) => issue.includes(fragment))), fragment).toBe(true);
    }
  });

  for (const { name, html } of inputs) {
    it(`matches the desktop result: ${name}`, () => {
      const expected = fixture.expected[name]!;
      expect(findHtmlStructureIssues(html)).toEqual(expected.issues);
      expect(findHtmlStructureIssues(html, { checkSourceCompleteness: true })).toEqual(expected.completeIssues);
      expect(closeOpenTemplates(html)).toEqual(expected.closed);
    });
  }

  it('treats non-string input like the desktop (String(html || ""))', () => {
    expect(findHtmlStructureIssues(null)).toEqual([]);
    expect(findHtmlStructureIssues(undefined, { checkSourceCompleteness: true })).toEqual([]);
    expect(closeOpenTemplates(null)).toEqual({ html: '', closed: 0 });
  });
});

describe('assertHtmlStructure', () => {
  it('passes complete HTML and reports the first eight issues with the desktop wording', () => {
    expect(() => assertHtmlStructure('<p>一</p><figure data-app-size="wide"><img alt="a"></figure>')).not.toThrow();
    const html = Array.from({ length: 10 }, (_, index) => `<div id="d${index}">`).join('');
    let error: unknown;
    try {
      assertHtmlStructure(html);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HtmlStructureError);
    const issues = findHtmlStructureIssues(html);
    expect((error as HtmlStructureError).issues).toEqual(issues);
    expect((error as Error).message).toBe(
      `HTML 结构不完整，请修正后重新保存：${issues.slice(0, 8).join('；')}；另有 2 处。除 img 等空元素外，每个元素都要写出结束标签；每个 figure 以 </figure> 结束，并直接包含一个 img。`,
    );
  });

  it('checks source completeness only when asked', () => {
    expect(() => assertHtmlStructure('<p>一</p><!-- 未结束')).not.toThrow();
    expect(() => assertHtmlStructure('<p>一</p><!-- 未结束', { checkSourceCompleteness: true })).toThrow('注释尚未结束（eof-in-comment）');
  });
});
