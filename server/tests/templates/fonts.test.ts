// 导出模板可选字体名的固定清单（路线图第 7 步 7.2）：与前端 FONT_OPTIONS 一致；GET /api/fonts 需要登录。
// 登录后的返回内容见 tests/db/exportTemplates.test.ts。
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { TEMPLATE_FONT_NAMES } from '../../src/templates/fonts.ts';
import { createLogCapture, fakeDatabase, fastHasher, testConfig } from '../helpers.ts';

const exportFormatSource = new URL('../../../client/src/shared/types/exportFormat.ts', import.meta.url);

/** 前端 FONT_OPTIONS 的字体名（按源码顺序）。 */
function clientFontOptions(): string[] {
  const source = readFileSync(exportFormatSource, 'utf8');
  const start = source.indexOf('export const FONT_OPTIONS = [');
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf('] as const;', start));
  return [...body.matchAll(/^\s+'([^']+)',$/gm)].map((match) => match[1]!);
}

/** 前端 FONT_TO_CSS 的键。 */
function clientFontToCssKeys(): string[] {
  const source = readFileSync(exportFormatSource, 'utf8');
  const start = source.indexOf('export const FONT_TO_CSS');
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf('};', start));
  return [...body.matchAll(/^\s+'([^']+)':/gm)].map((match) => match[1]!);
}

describe('模板可选字体名', () => {
  it('与前端 FONT_OPTIONS 逐项相同、顺序相同', () => {
    const client = clientFontOptions();
    expect(client.length).toBeGreaterThanOrEqual(20);
    expect(TEMPLATE_FONT_NAMES).toEqual(client);
  });

  it('不重复、都是去掉首尾空白的非空名称，且都有前端的 CSS 回退（export 沙箱的字体映射按它核对）', () => {
    expect(new Set(TEMPLATE_FONT_NAMES).size).toBe(TEMPLATE_FONT_NAMES.length);
    for (const name of TEMPLATE_FONT_NAMES) expect(name.trim()).toBe(name);
    expect(TEMPLATE_FONT_NAMES.every((name) => name.length > 0)).toBe(true);
    const cssKeys = new Set(clientFontToCssKeys());
    expect(TEMPLATE_FONT_NAMES.filter((name) => !cssKeys.has(name))).toEqual([]);
  });

  it('清单不可修改', () => {
    expect(Object.isFrozen(TEMPLATE_FONT_NAMES)).toBe(true);
  });
});

describe('GET /api/fonts', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(testConfig, { database: fakeDatabase(), logStream: createLogCapture().stream, passwordHasher: await fastHasher() });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('未登录返回 401，不返回清单', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/fonts' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(response.body).not.toContain('宋体');
  });
});
