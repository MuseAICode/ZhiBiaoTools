// agent 沙箱入口中的本地工具 json-validation（server/sandbox/agent/jsonValidation*.mjs，路线图第 8 步 8.6c2a）。覆盖：
// - 与桌面版相同的规则：预置 Schema 优先、没有预置时必须给出、Ajv 的 allErrors + strict、stage 与错误的结构；
// - 文件只能是工作区内的普通文件（绝对路径、../、经符号链接到工作区外、目录、过大一律 read 失败）；
// - 结果有上限：错误至多 MAX_REPORTED_ERRORS 条（另给总数）、说明截短、过大的 params 省略；
// - 在工作线程中执行：灾难性正则超时后终止线程、入口的事件循环不被卡住；超出堆上限、被中止时返回失败而不抛异常；
// - 工具定义与桌面版 piJsonValidationTool.cjs 相同（名称、参数），失败时为工具错误。
// 真实的 Pi 经真实的模型调用路由调用本工具见 tests/agent/piSession.test.ts。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJsonValidationTool, runJsonValidation, VALIDATION_TIMEOUT_MS } from '../../sandbox/agent/jsonValidation.mjs';
import { MAX_JSON_FILE_BYTES, MAX_REPORTED_ERRORS, normalizeWorkspaceFilePath, validateJsonFile } from '../../sandbox/agent/jsonValidationCore.mjs';

// TypeBox 与 Ajv 在 sandbox/agent/node_modules 中（CI 在单元测试前安装，类型检查时尚未安装），TypeBox 运行时按路径加载。
const TYPEBOX_URL = new URL('../../sandbox/agent/node_modules/typebox/build/index.mjs', import.meta.url).href;
const { Type } = (await import(TYPEBOX_URL)) as { Type: unknown };

let root: string;
let workspaceDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zhibiao-json-'));
  workspaceDir = join(root, 'workspace');
  mkdirSync(workspaceDir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (name: string, content: unknown) => {
  const path = join(workspaceDir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
};
const validate = (filePath: unknown, options: { schema?: unknown; presetSchemas?: Record<string, unknown> } = {}) => validateJsonFile({ workspaceDir, filePath, ...options });

const OUTLINE_SCHEMA = { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: { type: 'string' } } } };

describe('validateJsonFile', () => {
  it('通过：与桌面版相同的结果', () => {
    write('目录.json', { items: ['概述'] });
    expect(validate('目录.json', { schema: OUTLINE_SCHEMA })).toEqual({ valid: true, stage: 'success', file_path: '目录.json', errors: [], message: 'JSON.parse 和 Ajv 校验均已通过。' });
    // 路径的写法：去掉首尾空白、反斜杠换成 /、规范化。
    mkdirSync(join(workspaceDir, '输出'));
    write('输出/结果.json', { items: [] });
    for (const path of [' 输出/结果.json ', '输出\\结果.json', './输出/../输出/结果.json']) {
      expect(validate(path, { schema: OUTLINE_SCHEMA })).toMatchObject({ valid: true, file_path: '输出/结果.json' });
    }
  });

  it('预置 Schema 优先于 Agent 给出的；没有预置时必须给出 schema', () => {
    write('目录.json', { items: [1] });
    const presetSchemas = { '目录.json': OUTLINE_SCHEMA };
    // Agent 给出的 true（什么都放行）被忽略。
    expect(validate('目录.json', { presetSchemas, schema: true })).toMatchObject({ valid: false, stage: 'validation', errors: [{ instancePath: '/items/0', keyword: 'type', params: { type: 'string' } }] });
    expect(validate('./目录.json', { presetSchemas })).toMatchObject({ valid: false, stage: 'validation' });
    // 预置为 false 时一律不通过；预置的 true 放行。
    expect(validate('目录.json', { presetSchemas: { '目录.json': false }, schema: true })).toMatchObject({ valid: false, stage: 'validation' });
    expect(validate('目录.json', { presetSchemas: { '目录.json': true }, schema: false })).toMatchObject({ valid: true });
    // 其他文件没有预置。
    write('其他.json', {});
    const missing = validate('其他.json', { presetSchemas });
    expect(missing).toMatchObject({ valid: false, stage: 'schema' });
    expect(missing.errors[0]!.message).toBe('任务未为 其他.json 预置 Schema，调用时必须提供 schema');
    // 预置的键为 __proto__ 等时只按自有属性匹配。
    write('constructor', '{}');
    expect(validate('constructor', { presetSchemas: {} })).toMatchObject({ stage: 'schema' });
  });

  it('JSON 无效时 stage = parse；schema 无效或用了未知关键字（strict）时 stage = schema', () => {
    write('坏.json', '{"items": [');
    expect(validate('坏.json', { schema: true })).toMatchObject({ valid: false, stage: 'parse', file_path: '坏.json' });
    write('好.json', '{}');
    expect(validate('好.json', { schema: { type: 'objekt' } })).toMatchObject({ valid: false, stage: 'schema' });
    expect(validate('好.json', { schema: { type: 'object', unknownKeyword: 1 } })).toMatchObject({ valid: false, stage: 'schema' });
    // 远程引用不会去下载，按缺少引用报告。
    expect(validate('好.json', { schema: { $ref: 'http://127.0.0.1:9/schema.json' } })).toMatchObject({ valid: false, stage: 'schema' });
    expect(validate('好.json', { schema: { type: 'object', properties: { a: { pattern: '(' } } } })).toMatchObject({ valid: false, stage: 'schema' });
  });

  it.each<[string, unknown]>([
    ['空路径', ''],
    ['只有空白', '  '],
    ['不是字符串', undefined],
    ['绝对路径', '/etc/passwd'],
    ['反斜杠的绝对路径', '\\etc\\passwd'],
    ['超出工作区', '../outside.json'],
    ['规范化后超出工作区', 'a/../../outside.json'],
    ['工作区本身', '.'],
    ['不存在', '没有.json'],
  ])('读取失败（stage = read）：%s', (_name, filePath) => {
    write('../outside.json', '{}');
    expect(validate(filePath, { schema: true })).toMatchObject({ valid: false, stage: 'read' });
  });

  it('符号链接：解析后在工作区内的照常校验，指向工作区外的拒绝；目录与过大的文件拒绝', () => {
    writeFileSync(join(root, 'outside.json'), '{}');
    symlinkSync(join(root, 'outside.json'), join(workspaceDir, '外部.json'));
    expect(validate('外部.json', { schema: true })).toMatchObject({ valid: false, stage: 'read' });
    symlinkSync(root, join(workspaceDir, '上级'));
    expect(validate('上级/outside.json', { schema: true })).toMatchObject({ valid: false, stage: 'read' });
    write('内部.json', '{}');
    symlinkSync('内部.json', join(workspaceDir, '链接.json'));
    expect(validate('链接.json', { schema: true })).toMatchObject({ valid: true });
    mkdirSync(join(workspaceDir, '目录.json'));
    expect(validate('目录.json', { schema: true })).toMatchObject({ valid: false, stage: 'read' });
    const big = write('大.json', '');
    truncateSync(big, MAX_JSON_FILE_BYTES + 1);
    const tooLarge = validate('大.json', { schema: true });
    expect(tooLarge).toMatchObject({ valid: false, stage: 'read' });
    expect(tooLarge.errors[0]!.message).toContain('16 MiB');
    // 上限处照常读取（内容是空格，解析失败而不是读取失败）。
    truncateSync(big, MAX_JSON_FILE_BYTES);
    expect(validate('大.json', { schema: true })).toMatchObject({ stage: 'parse' });
  });

  it('结果有上限：错误至多 MAX_REPORTED_ERRORS 条并给出总数，说明与路径截短，过大的 params 省略', () => {
    write('多.json', Array.from({ length: 250 }, () => 'x'));
    const many = validate('多.json', { schema: { type: 'array', items: { type: 'integer' } } });
    expect(many.errors).toHaveLength(MAX_REPORTED_ERRORS);
    expect(many.error_count).toBe(250);
    expect(many.message).toContain('共 250 处错误，只列出前 100 处');
    // 恰好 MAX_REPORTED_ERRORS 条时不给 error_count。
    write('整.json', Array.from({ length: MAX_REPORTED_ERRORS }, () => 'x'));
    expect(validate('整.json', { schema: { type: 'array', items: { type: 'integer' } } })).not.toHaveProperty('error_count');
    // 很长的键名：instancePath 截短。
    const longKey = 'k'.repeat(5_000);
    write('长.json', { [longKey]: 1 });
    const long = validate('长.json', { schema: { type: 'object', additionalProperties: { type: 'string' } } });
    expect(Array.from(long.errors[0]!.instancePath!).length).toBeLessThanOrEqual(501);
    // enum 很大时 params（allowedValues）省略；小的照常给出。
    write('枚举.json', '"z"');
    expect(validate('枚举.json', { schema: { enum: Array.from({ length: 1_000 }, (_, index) => `value-${index}`) } }).errors[0]!.params).toEqual({});
    expect(validate('枚举.json', { schema: { enum: ['a', 'b'] } }).errors[0]!.params).toEqual({ allowedValues: ['a', 'b'] });
  });

  it('normalizeWorkspaceFilePath', () => {
    expect(normalizeWorkspaceFilePath(' a\\b/./c.json ')).toBe('a/b/c.json');
    for (const bad of ['', '/a', '..', '../a', 'a/../../b', '.']) expect(() => normalizeWorkspaceFilePath(bad)).toThrow();
  });
});

describe('runJsonValidation（工作线程）', () => {
  it('结果与直接校验相同', async () => {
    write('目录.json', { items: [1] });
    const options = { workspaceDir, filePath: '目录.json', presetSchemas: { '目录.json': OUTLINE_SCHEMA } };
    expect(await runJsonValidation(options)).toEqual(validateJsonFile(options));
    expect(VALIDATION_TIMEOUT_MS).toBe(30_000);
  });

  it('灾难性正则：超时后终止线程，返回 stage = timeout；期间入口的事件循环照常运行', async () => {
    write('正则.json', JSON.stringify(`${'a'.repeat(40)}!`));
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 20);
    const started = Date.now();
    try {
      const result = await runJsonValidation({ workspaceDir, filePath: '正则.json', schema: { type: 'string', pattern: '^(a+)+$' }, timeoutMs: 500 });
      expect(result).toMatchObject({ valid: false, stage: 'timeout', file_path: '正则.json' });
      expect(result.errors[0]!.message).toContain('pattern');
    } finally {
      clearInterval(interval);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ticks).toBeGreaterThan(5);
  });

  it('超出堆上限：返回 stage = resource，不抛异常', async () => {
    // 约 14 MiB、180 万个对象的数组，解析后远超 16 MiB 的堆。
    write('大.json', `[${Array.from({ length: 1_800_000 }, () => '{"a":1}').join(',')}]`);
    const result = await runJsonValidation({ workspaceDir, filePath: '大.json', schema: true, heapMb: 16 });
    expect(result).toMatchObject({ valid: false, stage: 'resource' });
  }, 30_000);

  it('中止：已中止时不启动线程，执行中中止时终止线程', async () => {
    write('正则.json', JSON.stringify(`${'a'.repeat(40)}!`));
    const controller = new AbortController();
    controller.abort();
    expect(await runJsonValidation({ workspaceDir, filePath: '正则.json', schema: true, signal: controller.signal })).toMatchObject({ stage: 'aborted' });
    const running = new AbortController();
    const pending = runJsonValidation({ workspaceDir, filePath: '正则.json', schema: { type: 'string', pattern: '^(a+)+$' }, signal: running.signal });
    setTimeout(() => running.abort(), 200);
    expect(await pending).toMatchObject({ stage: 'aborted' });
  });
});

describe('createJsonValidationTool', () => {
  it('名称、说明与参数沿用桌面版；失败时为工具错误；预置 Schema 交给校验', async () => {
    const seen: unknown[] = [];
    const presetSchemas = { '目录.json': OUTLINE_SCHEMA };
    const tool = createJsonValidationTool({
      Type,
      workspaceDir,
      presetSchemas,
      validate: async (input) => {
        seen.push(input);
        return validateJsonFile(input);
      },
    });
    expect(tool.name).toBe('json-validation');
    expect(tool.label).toBe('JSON 校验');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['file_path'],
      properties: { file_path: { type: 'string', minLength: 1 }, schema: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'boolean' }] } },
    });
    write('目录.json', { items: ['概述'] });
    const ok = await tool.execute('call-1', { file_path: '目录.json' });
    expect(ok).not.toHaveProperty('isError');
    expect(JSON.parse(ok.content[0]!.text)).toEqual(ok.details);
    expect(seen).toEqual([{ workspaceDir, filePath: '目录.json', presetSchemas, schema: undefined, signal: undefined }]);
    const failed = await tool.execute('call-2', { file_path: '没有.json', schema: true });
    expect(failed).toMatchObject({ isError: true, details: { valid: false, stage: 'read' } });
  });

  it('默认在工作线程中执行', async () => {
    const tool = createJsonValidationTool({ Type, workspaceDir });
    write('a.json', '{"a":1}');
    expect((await tool.execute('call', { file_path: 'a.json', schema: { type: 'object' } })).details).toMatchObject({ valid: true });
  });
});
