// 受限 HTML 的服务端实现与前端一致（路线图第 7 步 7.3a）：
// - 白名单：标签、属性取值、id 规则等常量与前端 client/src/shared/bodyHtml/restrictedHtml.ts 源码中的逐项相同，
//   allowedAttributes 的函数体相同（去掉注释后），所有提示文字相同；
// - 行为：client/tests/fixtures/restrictedHtmlCases.json 中的每条用例（前端在 jsdom 中记录、client 的测试核对）
//   在服务端得到完全相同的结果，包括块、问题列表、规范化后的 HTML 与预览 HTML；
// - 规范化后的 HTML 是不动点：再解析一遍原样得到它、没有任何问题（服务端只转发它）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TAGS,
  DANGEROUS_TAGS,
  FIGURE_FITS,
  FIGURE_GENERATIONS,
  FIGURE_SIZES,
  ID_PATTERN,
  INLINE_TAGS,
  parseRestrictedHtml,
  RESTRICTED_HTML_BLOCK_MARKER,
  ROOT_TAGS,
  TABLE_PRESETS,
  UNKNOWN_BLOCK_TAGS,
  type RestrictedHtmlParseOptions,
  type RestrictedHtmlParseResult,
} from '../../src/templates/restrictedHtml.ts';

const clientSource = readFileSync(new URL('../../../client/src/shared/bodyHtml/restrictedHtml.ts', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../../src/templates/restrictedHtml.ts', import.meta.url), 'utf8');

interface RestrictedHtmlCase {
  name: string;
  html: string;
  options?: RestrictedHtmlParseOptions;
  expected: RestrictedHtmlParseResult;
}

const cases = JSON.parse(
  readFileSync(new URL('../../../client/tests/fixtures/restrictedHtmlCases.json', import.meta.url), 'utf8'),
) as RestrictedHtmlCase[];

/** 前端源码中 `const NAME = new Set([...])` 的字符串成员（含展开的其他集合）。 */
function clientSet(name: string): Set<string> {
  const start = clientSource.indexOf(`const ${name} = new Set([`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const body = clientSource.slice(start, clientSource.indexOf(']);', start));
  const values = new Set([...body.matchAll(/'([^']+)'/g)].map((match) => match[1]!));
  for (const spread of body.matchAll(/\.\.\.([A-Z_]+)/g)) for (const value of clientSet(spread[1]!)) values.add(value);
  return values;
}

/** 函数体（到下一个顶层的 `\n}\n`），去掉整行注释与缩进。 */
function functionBody(source: string, signature: string): string[] {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  return source
    .slice(start, source.indexOf('\n}\n', start))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'));
}

/** 源码中所有提示文字：addIssue / globalIssues.push 的 message 参数（字符串或模板字符串）。 */
function issueMessages(source: string): string[] {
  const messages = [
    ...[...source.matchAll(/addIssue\(context, '(?:error|warning)', (`[^`]*`|'[^']*')\)/g)].map((match) => match[1]!),
    ...[...source.matchAll(/level: '(?:error|warning)', message: ('[^']*')/g)].map((match) => match[1]!),
  ];
  return [...new Set(messages)].sort();
}

describe('受限 HTML 白名单与前端一致', () => {
  it.each([
    ['ROOT_TAGS', ROOT_TAGS],
    ['INLINE_TAGS', INLINE_TAGS],
    ['ALLOWED_TAGS', ALLOWED_TAGS],
    ['DANGEROUS_TAGS', DANGEROUS_TAGS],
    ['UNKNOWN_BLOCK_TAGS', UNKNOWN_BLOCK_TAGS],
    ['FIGURE_GENERATIONS', FIGURE_GENERATIONS],
    ['FIGURE_SIZES', FIGURE_SIZES],
    ['FIGURE_FITS', FIGURE_FITS],
    ['TABLE_PRESETS', TABLE_PRESETS],
  ] as const)('%s 与前端逐项相同', (name, values) => {
    const client = clientSet(name);
    expect(client.size).toBeGreaterThan(0);
    expect([...values].sort()).toEqual([...client].sort());
  });

  it('id 规则与分隔注释相同', () => {
    expect(clientSource).toContain(`const ID_PATTERN = ${ID_PATTERN.toString()};`);
    expect(clientSource).toContain(`export const RESTRICTED_HTML_BLOCK_MARKER = '${RESTRICTED_HTML_BLOCK_MARKER}';`);
    expect(clientSource).toContain('const BLOCK_MARKER_PATTERN = /<!--\\s*app:block\\s*-->/gi;');
    expect(serverSource).toContain('const BLOCK_MARKER_PATTERN = /<!--\\s*app:block\\s*-->/gi;');
  });

  it('各标签允许的属性（allowedAttributes）逐行相同', () => {
    const signature = 'function allowedAttributes(element: Element, options: RestrictedHtmlParseOptions) {';
    const client = functionBody(clientSource, signature);
    expect(client.length).toBeGreaterThan(15);
    expect(functionBody(serverSource, signature)).toEqual(client);
  });

  it('引用路径、整数属性与表格网格的规则逐行相同', () => {
    for (const signature of [
      'function isWorkspaceRelativeAssetRef(value: string) {',
      'function validateTableGrid(table: Element, context: BlockContext) {',
      'export function parseRestrictedHtml(',
    ]) {
      const client = functionBody(clientSource, signature);
      expect(client.length, signature).toBeGreaterThanOrEqual(5);
      expect(functionBody(serverSource, signature), signature).toEqual(client);
    }
  });

  it('所有提示文字相同', () => {
    const client = issueMessages(clientSource);
    expect(client.length).toBeGreaterThanOrEqual(40);
    expect(issueMessages(serverSource)).toEqual(client);
  });
});

describe('受限 HTML 共用用例（服务端）', () => {
  it('用例覆盖通过、警告与拒绝三种结果', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.some((item) => item.expected.normalizedHtml !== null && item.expected.issues.length === 0)).toBe(true);
    expect(cases.some((item) => item.expected.normalizedHtml !== null && item.expected.issues.length > 0)).toBe(true);
    expect(cases.some((item) => item.expected.normalizedHtml === null)).toBe(true);
  });

  it.each(cases.map((item) => [item.name, item] as const))('%s', (_name, item) => {
    expect(parseRestrictedHtml(item.html, item.options || {})).toStrictEqual(item.expected);
  });

  it('规范化后的 HTML 再解析一遍原样得到、没有任何问题', () => {
    const normalized = cases.map((item) => item.expected.normalizedHtml).filter((html): html is string => Boolean(html));
    expect(normalized.length).toBeGreaterThanOrEqual(10);
    for (const html of normalized) {
      const options = { allowImageSrc: html.includes(' src=') };
      const again = parseRestrictedHtml(html, options);
      expect(again.issues).toEqual([]);
      expect(again.normalizedHtml).toBe(html);
    }
  });
});
