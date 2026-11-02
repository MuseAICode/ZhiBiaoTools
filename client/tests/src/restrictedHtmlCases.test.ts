// @vitest-environment jsdom
// 受限 HTML 的共用用例（路线图第 7 步 7.3a）：tests/fixtures/restrictedHtmlCases.json 中每条用例的输入与前端
// parseRestrictedHtml 的输出。服务端的同名实现（server/src/templates/restrictedHtml.ts）在 server/tests/templates/
// restrictedHtml.test.ts 中跑同一份用例，两端都必须得到记录的结果，从而保证服务端与前端按同一套白名单校验。
// 改了前端的规则时，用 UPDATE_RESTRICTED_HTML_CASES=1 npm run test 重新记录，再同步修改服务端，直到服务端的测试也通过。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRestrictedHtml, type RestrictedHtmlParseOptions, type RestrictedHtmlParseResult } from '../../src/shared/bodyHtml/restrictedHtml';

interface RestrictedHtmlCase {
  name: string;
  html: string;
  options?: RestrictedHtmlParseOptions;
  expected: RestrictedHtmlParseResult;
}

const casesFile = path.resolve(__dirname, '../fixtures/restrictedHtmlCases.json');
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8')) as RestrictedHtmlCase[];

if (process.env.UPDATE_RESTRICTED_HTML_CASES === '1') {
  const updated = cases.map((item) => ({ ...item, expected: parseRestrictedHtml(item.html, item.options || {}) }));
  fs.writeFileSync(casesFile, `${JSON.stringify(updated, null, 2)}\n`);
}

describe('受限 HTML 共用用例（前端）', () => {
  it('用例覆盖通过、警告与拒绝三种结果', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(cases.map((item) => item.name)).size).toBe(cases.length);
    expect(cases.some((item) => item.expected.normalizedHtml !== null && item.expected.issues.length === 0)).toBe(true);
    expect(cases.some((item) => item.expected.normalizedHtml !== null && item.expected.issues.length > 0)).toBe(true);
    expect(cases.some((item) => item.expected.normalizedHtml === null)).toBe(true);
  });

  it.each(cases.map((item) => [item.name, item] as const))('%s', (_name, item) => {
    expect(parseRestrictedHtml(item.html, item.options || {})).toEqual(item.expected);
  });
});
