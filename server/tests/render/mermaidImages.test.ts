// Mermaid 转 PNG 的 worker 一侧（src/render/mermaidImages.ts，8.8b）：请求的组装与校验、沙箱输出按不可信输入的校验
// （只收 PNG 与 result.json，Mermaid 生成的 SVG 等多余文件一律拒绝）、经沙箱驱动的流程（创建、放入、执行、取回、总是销毁）与错误代码。
// 真实沙箱中的转图与注入样本见 tests/sandbox/docker/renderMermaid.test.ts。
import { describe, expect, it } from 'vitest';
import { JobError, JobInterruptedError } from '../../src/jobs/definitions.ts';
import {
  buildRenderMermaidRequest,
  mermaidImageId,
  renderMermaidImages,
  RenderMermaidOutputError,
  validateRenderMermaidOutput,
  type RenderMermaidContext,
} from '../../src/render/mermaidImages.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxExecResult, type SandboxRef } from '../../src/sandbox/driver.ts';
import { RENDER_MERMAID_MAX_ITEMS } from '../../src/sandbox/templates.ts';

/** 只有签名与 IHDR 的 PNG（校验只读这两部分）。 */
function fakePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

const json = (value: unknown): SandboxFile => ({ path: 'result.json', data: Buffer.from(JSON.stringify(value)) });
const rendered = (id: string, width = 621, height = 534) => ({ id, status: 'rendered', width, height });
const pngFile = (id: string, width = 621, height = 534): SandboxFile => ({ path: `${id}.png`, data: fakePng(width, height) });

describe('buildRenderMermaidRequest', () => {
  it('assigns ids in order and sends only request.json with the fields of the entry', () => {
    const files = buildRenderMermaidRequest(['flowchart TD\n  A --> B', 'sequenceDiagram\n  A->>B: 你好']);
    expect(files.map((file) => file.path)).toEqual(['request.json']);
    expect(JSON.parse(files[0]!.data.toString('utf8'))).toEqual({
      version: 1,
      items: [
        { id: 'm001', code: 'flowchart TD\n  A --> B' },
        { id: 'm002', code: 'sequenceDiagram\n  A->>B: 你好' },
      ],
    });
    expect(mermaidImageId(49)).toBe('m050');
  });

  it.each([
    ['no items', []],
    ['too many items', Array.from({ length: RENDER_MERMAID_MAX_ITEMS + 1 }, () => 'flowchart TD')],
    ['blank code', ['  \n ']],
    ['non-string code', [1 as unknown as string]],
    ['a lone surrogate', ['flowchart TD\n  A["\ud800"]']],
    ['code over 64 KiB in UTF-8', ['图'.repeat(21_846)]],
    ['a batch over 1 MiB', Array.from({ length: 17 }, () => 'x'.repeat(64 * 1024))],
  ])('rejects %s before creating a sandbox', (_name, codes) => {
    expect(() => buildRenderMermaidRequest(codes as string[])).toThrow(expect.objectContaining({ code: 'RENDER_MERMAID_REQUEST_INVALID' }));
  });

  it('accepts exactly 64 KiB per item, 1 MiB per batch and 50 items', () => {
    expect(() => buildRenderMermaidRequest(Array.from({ length: 16 }, () => 'x'.repeat(64 * 1024)))).not.toThrow();
    expect(() => buildRenderMermaidRequest(Array.from({ length: RENDER_MERMAID_MAX_ITEMS }, () => 'flowchart TD'))).not.toThrow();
  });
});

describe('validateRenderMermaidOutput', () => {
  const goodItems = () => [
    rendered('m001'),
    { id: 'm002', status: 'failed', error: 'diagram_invalid', message: "Parse error on line 2:\n...A[\n---^\nExpecting 'SQE'" },
    { id: 'm003', status: 'failed', error: 'render_timeout' },
    rendered('m004', 2040, 3306),
  ];
  const goodFiles = (items: unknown[] = goodItems(), pngs: SandboxFile[] = [pngFile('m001'), pngFile('m004', 2040, 3306)]) => [json({ version: 1, items }), ...pngs];

  it('returns the images and failures in request order', () => {
    expect(validateRenderMermaidOutput(goodFiles(), 4)).toEqual([
      { status: 'rendered', png: fakePng(621, 534), width: 621, height: 534 },
      { status: 'failed', error: 'diagram_invalid', message: "Parse error on line 2:\n...A[\n---^\nExpecting 'SQE'" },
      { status: 'failed', error: 'render_timeout' },
      { status: 'rendered', png: fakePng(2040, 3306), width: 2040, height: 3306 },
    ]);
  });

  it.each([
    ['no result.json', [pngFile('m001')]],
    ['a result.json that is not json', [{ path: 'result.json', data: Buffer.from('{') }, pngFile('m001')]],
    ['a result.json that is not UTF-8', [{ path: 'result.json', data: Buffer.from([0xff, 0xfe]) }]],
    ['an extra top-level field', [json({ version: 1, items: [rendered('m001')], svg: '<svg/>' }), pngFile('m001')]],
    ['another version', [json({ version: 2, items: [rendered('m001')] }), pngFile('m001')]],
    ['fewer items than requested', [json({ version: 1, items: [] })]],
    ['an item with another id', [json({ version: 1, items: [rendered('m002')] }), pngFile('m002')]],
    ['a rendered item without its png', [json({ version: 1, items: [rendered('m001')] })]],
    ['a png of another size', [json({ version: 1, items: [rendered('m001')] }), pngFile('m001', 621, 537)]],
    ['a png that is not a png', [json({ version: 1, items: [rendered('m001')] }), { path: 'm001.png', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }]],
    ['a png over 10 MiB', [json({ version: 1, items: [rendered('m001')] }), { path: 'm001.png', data: Buffer.concat([fakePng(621, 534), Buffer.alloc(10 * 1024 * 1024)]) }]],
    ['a width over 2040', [json({ version: 1, items: [rendered('m001', 2043, 534)] }), pngFile('m001', 2043, 534)]],
    ['a height over 3306', [json({ version: 1, items: [rendered('m001', 621, 3309)] }), pngFile('m001', 621, 3309)]],
    ['a size that is not a multiple of the capture scale', [json({ version: 1, items: [rendered('m001', 620, 534)] }), pngFile('m001', 620, 534)]],
    ['a fractional size', [json({ version: 1, items: [rendered('m001', 621.5, 534)] }), pngFile('m001', 621, 534)]],
    ['an extra field on a rendered item', [json({ version: 1, items: [{ ...rendered('m001'), svg: '<svg/>' }] }), pngFile('m001')]],
    ['an unknown failure', [json({ version: 1, items: [{ id: 'm001', status: 'failed', error: 'pwned' }] })]],
    ['a message on another failure', [json({ version: 1, items: [{ id: 'm001', status: 'failed', error: 'render_failed', message: 'x' }] })]],
    ['diagram_invalid without a message', [json({ version: 1, items: [{ id: 'm001', status: 'failed', error: 'diagram_invalid' }] })]],
    ['a blank message', [json({ version: 1, items: [{ id: 'm001', status: 'failed', error: 'diagram_invalid', message: ' ' }] })]],
    ['a message over 1000 characters', [json({ version: 1, items: [{ id: 'm001', status: 'failed', error: 'diagram_invalid', message: 'x'.repeat(1001) }] })]],
    ['a message with control characters', [json({ version: 1, items: [{ id: 'm001', status: 'failed', error: 'diagram_invalid', message: 'a\u001b[31mb' }] })]],
    ['a message with bidi controls', [json({ version: 1, items: [{ id: 'm001', status: 'failed', error: 'diagram_invalid', message: 'a‮b' }] })]],
    ['a non-string message', [json({ version: 1, items: [{ id: 'm001', status: 'failed', error: 'diagram_invalid', message: { html: '<b>' } }] })]],
    ['an unknown status', [json({ version: 1, items: [{ id: 'm001', status: 'skipped' }] })]],
    ['the SVG next to the PNG', [json({ version: 1, items: [rendered('m001')] }), pngFile('m001'), { path: 'm001.svg', data: Buffer.from('<svg/>') }]],
    ['a png of a failed item', [json({ version: 1, items: [{ id: 'm001', status: 'failed', error: 'render_failed' }] }), pngFile('m001')]],
    ['a duplicate file', [json({ version: 1, items: [rendered('m001')] }), pngFile('m001'), pngFile('m001')]],
  ])('rejects %s', (_name, files) => {
    expect(() => validateRenderMermaidOutput(files, 1)).toThrow(RenderMermaidOutputError);
  });

  it('rejects a result.json over 1 MiB', () => {
    expect(() => validateRenderMermaidOutput([{ path: 'result.json', data: Buffer.alloc(1024 * 1024 + 1, 0x20) }], 1)).toThrow(RenderMermaidOutputError);
  });

  it('keeps the error reason free of output content', () => {
    try {
      validateRenderMermaidOutput([json({ version: 1, items: [{ id: 'm001', status: 'failed', error: '<script>x</script>' }] })], 1);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(RenderMermaidOutputError);
      expect((error as Error).message).not.toContain('script');
    }
  });
});

interface Calls {
  created: string[];
  copied: SandboxFile[][];
  exec: Array<[string, readonly string[]]>;
  destroyed: number;
}

function fakeDriver(options: { exec?: () => Promise<Partial<SandboxExecResult>>; output?: SandboxFile[]; createError?: SandboxError; copyOutError?: SandboxError }): { driver: SandboxDriver; calls: Calls } {
  const calls: Calls = { created: [], copied: [], exec: [], destroyed: 0 };
  const ref = { id: 'sandbox-1', template: 'render-mermaid' } as unknown as SandboxRef;
  const driver: SandboxDriver = {
    async create(template) {
      calls.created.push(template);
      if (options.createError) throw options.createError;
      return ref;
    },
    async copyIn(_sandbox, files) {
      calls.copied.push([...files] as SandboxFile[]);
    },
    async exec(_sandbox, command, args) {
      calls.exec.push([command, args]);
      const base: SandboxExecResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false, stdoutTruncated: false, stderrTruncated: false };
      return { ...base, ...(options.exec ? await options.exec() : {}) };
    },
    async copyOut() {
      if (options.copyOutError) throw options.copyOutError;
      return options.output ?? [];
    },
    async destroy() {
      calls.destroyed += 1;
    },
  };
  return { driver, calls };
}

const context = (driver: SandboxDriver | null): RenderMermaidContext => ({ jobId: '3f0c8a8e-6d1b-4e55-9a5e-2b9f0e1c7d42', signal: new AbortController().signal, log: async () => {}, sandbox: driver as SandboxDriver });
const codes = ['flowchart TD\n  A --> B'];

describe('renderMermaidImages', () => {
  it('creates a render-mermaid sandbox, sends only request.json, runs the render command and always destroys the sandbox', async () => {
    const { driver, calls } = fakeDriver({ output: [json({ version: 1, items: [rendered('m001')] }), pngFile('m001')] });
    const results = await renderMermaidImages(context(driver), codes, { createRetryDelaysMs: [] });
    expect(results).toMatchObject([{ status: 'rendered', width: 621, height: 534 }]);
    expect(calls.created).toEqual(['render-mermaid']);
    expect(calls.copied.map((files) => files.map((file) => file.path))).toEqual([['request.json']]);
    expect(calls.exec).toEqual([['render', []]]);
    expect(calls.destroyed).toBe(1);
  });

  it.each([
    ['{"error":"request_invalid"}', 'RENDER_MERMAID_REQUEST_INVALID'],
    ['{"error":"browser_failed"}', 'RENDER_MERMAID_FAILED'],
    ['{"error":"something else"}', 'RENDER_MERMAID_FAILED'],
    ['not json', 'RENDER_MERMAID_FAILED'],
  ])('maps the entry error %s to %s', async (stdout, code) => {
    const { driver, calls } = fakeDriver({ exec: async () => ({ exitCode: 65, stdout, stderr: 'browser said something', timedOut: false }) });
    const error = await renderMermaidImages(context(driver), codes, { createRetryDelaysMs: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain('browser said');
    expect(calls.destroyed).toBe(1);
  });

  it('fails with RENDER_MERMAID_TIMEOUT when the command times out', async () => {
    const { driver, calls } = fakeDriver({ exec: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) });
    await expect(renderMermaidImages(context(driver), codes, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_MERMAID_TIMEOUT' });
    expect(calls.destroyed).toBe(1);
  });

  it('rejects invalid output with RENDER_MERMAID_OUTPUT_REJECTED', async () => {
    const { driver, calls } = fakeDriver({ output: [json({ version: 1, items: [rendered('m001')] }), pngFile('m001'), { path: 'm001.svg', data: Buffer.from('<svg/>') }] });
    await expect(renderMermaidImages(context(driver), codes, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_MERMAID_OUTPUT_REJECTED' });
    expect(calls.destroyed).toBe(1);
  });

  it('maps sandbox errors and aborts', async () => {
    const rejected = fakeDriver({ copyOutError: new SandboxError('SANDBOX_OUTPUT_REJECTED', 'bad archive') });
    await expect(renderMermaidImages(context(rejected.driver), codes, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_MERMAID_OUTPUT_REJECTED' });
    expect(rejected.calls.destroyed).toBe(1);
    const aborted = fakeDriver({ copyOutError: new SandboxError('SANDBOX_ABORTED', 'aborted') });
    await expect(renderMermaidImages(context(aborted.driver), codes, { createRetryDelaysMs: [] })).rejects.toBeInstanceOf(JobInterruptedError);
    const busy = fakeDriver({ createError: new SandboxError('SANDBOX_BUSY', 'busy') });
    await expect(renderMermaidImages(context(busy.driver), codes, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_MERMAID_SANDBOX_BUSY' });
    expect(busy.calls.destroyed).toBe(0);
    const unavailable = fakeDriver({ createError: new SandboxError('SANDBOX_UNAVAILABLE', '沙箱镜像未配置') });
    await expect(renderMermaidImages(context(unavailable.driver), codes, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_MERMAID_UNAVAILABLE' });
  });

  it('validates the request before creating a sandbox, and needs a sandbox driver', async () => {
    const { driver, calls } = fakeDriver({});
    await expect(renderMermaidImages(context(driver), [], { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_MERMAID_REQUEST_INVALID' });
    expect(calls.created).toEqual([]);
    await expect(renderMermaidImages(context(null), codes)).rejects.toMatchObject({ code: 'RENDER_MERMAID_UNAVAILABLE' });
  });
});
