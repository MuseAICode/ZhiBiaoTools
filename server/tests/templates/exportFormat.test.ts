// 导出格式的规范化与桌面版一致（路线图第 7 步 7.3a）：同一批输入经服务端 normalizeExportFormat 与桌面版
// client/electron/services/exportFormatDefaults.cjs 的同名函数，结果逐项相同（Object.is 比较，-0 与 0 也区分）。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { defaultExportFormat, normalizeExportFormat } from '../../src/templates/exportFormat.ts';
import { SYSTEM_EXPORT_TEMPLATES } from '../../src/templates/systemTemplates.ts';

const require = createRequire(import.meta.url);
const desktop = require('../../../client/electron/services/exportFormatDefaults.cjs') as {
  defaultExportFormat: Record<string, unknown>;
  cloneDefaultExportFormat(): Record<string, unknown>;
  normalizeExportFormat(source: unknown): Record<string, unknown>;
};

/** 默认配置中所有叶子字段的路径（数组按下标展开），用来逐字段构造输入。 */
function leafPaths(value: unknown, prefix: Array<string | number> = []): Array<Array<string | number>> {
  if (Array.isArray(value)) return value.flatMap((item, index) => leafPaths(item, [...prefix, index]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => leafPaths(item, [...prefix, key]));
  return [prefix];
}

function withPath(path: Array<string | number>, leaf: unknown): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string | number, unknown> = root;
  path.forEach((key, index) => {
    if (index === path.length - 1) {
      current[key] = leaf;
      return;
    }
    const next: Record<string | number, unknown> = typeof path[index + 1] === 'number' ? [] as unknown as Record<number, unknown> : {};
    current[key] = next;
    current = next;
  });
  return root;
}

/** 各字段尝试的取值：各种类型、空值、边界与各枚举的合法 / 非法取值。 */
const LEAF_VALUES: unknown[] = [
  undefined, null, '', ' ', 'x', '超过四个字的角标文字', 0, -0, 1, 1.5, -3, 1e308, Number.NaN, Number.POSITIVE_INFINITY, true, false,
  [], ['#000000'], {}, { nested: 1 },
  'a3', 'letter', '16k', 'A4', 'landscape', 'spine', 'seal', 'band', 'frame', 'unknown-style', 2, 3, '2',
  'outline-decimal', 'custom', '左右结构', 'square', 'upper-roman', 'decimal-dot', 'none', 'points', 'exact',
];

/** 可复现的伪随机数（mulberry32）。 */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomConfig(next: () => number, paths: Array<Array<string | number>>) {
  const config: Record<string, unknown> = {};
  for (const path of paths) {
    if (next() < 0.5) continue;
    const leaf = LEAF_VALUES[Math.floor(next() * LEAF_VALUES.length)];
    // 按路径写入；中间节点偶尔换成非对象，覆盖“整段不是对象”的情况。
    let current: Record<string | number, unknown> = config;
    for (const [index, key] of path.entries()) {
      if (index === path.length - 1) {
        current[key] = leaf;
        break;
      }
      const existing = current[key];
      if (existing === undefined) {
        current[key] = next() < 0.03 ? LEAF_VALUES[Math.floor(next() * LEAF_VALUES.length)] : (typeof path[index + 1] === 'number' ? [] : {});
      }
      const child = current[key];
      if (!child || typeof child !== 'object') break;
      current = child as Record<string | number, unknown>;
    }
  }
  return config;
}

function expectSame(input: unknown) {
  // 两端可能原样返回输入中的对象，各自用一份深拷贝，避免一端的结果影响另一端。
  const copy = () => (input === undefined ? undefined : structuredClone(input));
  expect(normalizeExportFormat(copy())).toStrictEqual(desktop.normalizeExportFormat(copy()));
}

describe('导出格式的默认值', () => {
  it('与桌面版 cloneDefaultExportFormat 逐项相同，每次返回新的对象', () => {
    expect(defaultExportFormat()).toStrictEqual(desktop.cloneDefaultExportFormat());
    expect(defaultExportFormat()).toStrictEqual(desktop.defaultExportFormat);
    const first = defaultExportFormat();
    const second = defaultExportFormat();
    expect(first).not.toBe(second);
    expect(first.page).not.toBe(second.page);
    expect(first.headings[0]).not.toBe(second.headings[0]);
    expect(first.heading_border.level_cell_colors).not.toBe(second.heading_border.level_cell_colors);
    expect(first.table.header_row).not.toBe(second.table.header_row);
    first.page.paper_size = 'a3';
    expect(defaultExportFormat().page.paper_size).toBe('a4');
  });
});

describe('normalizeExportFormat 与桌面版一致', () => {
  const paths = leafPaths(desktop.cloneDefaultExportFormat());

  it('默认配置有足够多的字段可供比较', () => {
    expect(paths.length).toBeGreaterThan(100);
  });

  it('非对象与空对象', () => {
    for (const input of [undefined, null, 0, 1, '', 'x', true, false, [], {}, [{ page: { paper_size: 'a3' } }]]) expectSame(input);
  });

  it('默认配置、桌面版与服务端的系统模板原样不变', () => {
    expectSame(desktop.cloneDefaultExportFormat());
    expect(normalizeExportFormat(desktop.cloneDefaultExportFormat())).toStrictEqual(desktop.cloneDefaultExportFormat());
    expect(SYSTEM_EXPORT_TEMPLATES.length).toBeGreaterThan(0);
    for (const template of SYSTEM_EXPORT_TEMPLATES) {
      expectSame(template.config);
      expect(normalizeExportFormat(structuredClone(template.config))).toStrictEqual(desktop.normalizeExportFormat(structuredClone(template.config)));
    }
  });

  it('逐字段：每个叶子字段取各种类型与取值', () => {
    let count = 0;
    for (const path of paths) {
      for (const leaf of LEAF_VALUES) {
        expectSame(withPath(path, leaf));
        count += 1;
      }
    }
    expect(count).toBe(paths.length * LEAF_VALUES.length);
  });

  it('逐段：每一段（page、headings 等）整体换成各种非对象的取值', () => {
    for (const key of Object.keys(desktop.cloneDefaultExportFormat())) {
      for (const leaf of LEAF_VALUES) expectSame({ [key]: leaf });
    }
    for (const leaf of LEAF_VALUES) {
      expectSame({ headings: [leaf, leaf] });
      expectSame({ table: { header_row: leaf, first_column: leaf, body_cell: leaf } });
      expectSame({ heading_border: { level_cell_colors: [leaf, '#000000', leaf] } });
    }
  });

  it('随机生成的配置（2,000 份，固定种子）', () => {
    const next = random(0x7a3);
    for (let index = 0; index < 2000; index += 1) expectSame(randomConfig(next, paths));
  });

  it('桌面版原样透传的字段：服务端同样透传（不深拷贝），其余字段都是新对象', () => {
    const spacing = { nested: true };
    const input = { body_text: { spacing_before: spacing }, page: { paper_size: 'a3' } };
    const result = normalizeExportFormat(input);
    expect(result.body_text.spacing_before).toBe(spacing);
    expect(result.page).not.toBe(input.page);
    expect(desktop.normalizeExportFormat(input).body_text).toHaveProperty('spacing_before', spacing);
  });
});
