// HTML 配图转 PNG 的 worker 一侧（src/render/htmlImages.ts，8.8a1）：请求的组装与校验、沙箱输出按不可信输入的校验、
// 经沙箱驱动的流程（创建、放入、执行、取回、总是销毁）与错误代码。真实沙箱中的转图见 tests/sandbox/docker/renderHtml.test.ts。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { JobError, JobInterruptedError } from '../../src/jobs/definitions.ts';
import {
  buildRenderHtmlRequest,
  HTML_CAPTURE_SCALE,
  HTML_DESIGN_WIDTH,
  HTML_FRAME_HEIGHTS,
  htmlImageId,
  renderHtmlImages,
  RenderHtmlOutputError,
  validateRenderHtmlOutput,
  type HtmlFrameSize,
  type HtmlImageInput,
  type RenderHtmlContext,
} from '../../src/render/htmlImages.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxExecResult, type SandboxRef } from '../../src/sandbox/driver.ts';
import { RENDER_HTML_MAX_ITEMS } from '../../src/sandbox/templates.ts';

const require = createRequire(import.meta.url);
const desktop = require('../../../client/electron/shared/htmlImageLayout.cjs') as {
  HTML_DESIGN_WIDTH: number;
  HTML_FRAME_HEIGHTS: Record<string, number>;
  HTML_CAPTURE_SCALE: number;
};

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

const pngOf = (frame: HtmlFrameSize) => fakePng(HTML_DESIGN_WIDTH * HTML_CAPTURE_SCALE, HTML_FRAME_HEIGHTS[frame] * HTML_CAPTURE_SCALE);
const json = (value: unknown): SandboxFile => ({ path: 'result.json', data: Buffer.from(JSON.stringify(value)) });
const rendered = (id: string, frame: HtmlFrameSize, issues: unknown = []) => ({ id, status: 'rendered', width: 2480, height: HTML_FRAME_HEIGHTS[frame] * 2, layout_issues: issues });

describe('constants', () => {
  it('match the desktop canvas (client/electron/shared/htmlImageLayout.cjs)', () => {
    expect(HTML_DESIGN_WIDTH).toBe(desktop.HTML_DESIGN_WIDTH);
    expect(HTML_CAPTURE_SCALE).toBe(desktop.HTML_CAPTURE_SCALE);
    expect({ ...HTML_FRAME_HEIGHTS }).toEqual({ ...desktop.HTML_FRAME_HEIGHTS });
  });
});

describe('buildRenderHtmlRequest', () => {
  const item: HtmlImageInput = { html: '<div>图</div>', frameSize: 'wide', checkLayout: true };

  it('assigns ids in order and sends only the fields of the entry', () => {
    const body = JSON.parse(buildRenderHtmlRequest([item, { ...item, frameSize: 'tall', checkLayout: false }]).toString('utf8'));
    expect(body).toEqual({
      version: 1,
      items: [
        { id: 'h001', html: '<div>图</div>', frame_size: 'wide', check_layout: true },
        { id: 'h002', html: '<div>图</div>', frame_size: 'tall', check_layout: false },
      ],
    });
    expect(htmlImageId(49)).toBe('h050');
  });

  it.each([
    ['no items', []],
    ['too many items', Array.from({ length: RENDER_HTML_MAX_ITEMS + 1 }, () => item)],
    ['an unknown frame', [{ ...item, frameSize: 'huge' }]],
    ['an inherited frame name', [{ ...item, frameSize: 'toString' }]],
    ['a non-boolean check', [{ ...item, checkLayout: 'yes' }]],
    ['a non-string html', [{ ...item, html: 1 }]],
    ['a lone surrogate', [{ ...item, html: 'a\ud800b' }]],
    ['an html over 1 MiB', [{ ...item, html: '图'.repeat(350_000) }]],
    ['a batch over 16 MiB', Array.from({ length: 17 }, () => ({ ...item, html: 'x'.repeat(1024 * 1024) }))],
  ])('rejects %s', (_name, items) => {
    expect(() => buildRenderHtmlRequest(items as HtmlImageInput[])).toThrow(expect.objectContaining({ code: 'RENDER_HTML_REQUEST_INVALID' }));
  });

  it('accepts exactly 1 MiB per image and 50 images', () => {
    expect(() => buildRenderHtmlRequest(Array.from({ length: 16 }, () => ({ ...item, html: 'x'.repeat(1024 * 1024) })))).not.toThrow();
    expect(() => buildRenderHtmlRequest(Array.from({ length: RENDER_HTML_MAX_ITEMS }, () => item))).not.toThrow();
  });
});

describe('validateRenderHtmlOutput', () => {
  const frames: HtmlFrameSize[] = ['wide', 'panorama', 'tall'];
  const good = (): SandboxFile[] => [
    json({ version: 1, items: [rendered('h001', 'wide', ['文字字号过小：div 为 12px，至少需要 24px']), { id: 'h002', status: 'failed', error: 'render_timeout' }, rendered('h003', 'tall')] }),
    { path: 'h001.png', data: pngOf('wide') },
    { path: 'h003.png', data: pngOf('tall') },
  ];

  it('returns the images and failures in request order', () => {
    const results = validateRenderHtmlOutput(good(), frames);
    expect(results.map((result) => (result.status === 'rendered' ? { size: [result.width, result.height], issues: result.layoutIssues } : result))).toEqual([
      { size: [2480, 1654], issues: ['文字字号过小：div 为 12px，至少需要 24px'] },
      { status: 'failed', error: 'render_timeout' },
      { size: [2480, 3306], issues: [] },
    ]);
  });

  const replaceResult = (items: unknown[], extra: Record<string, unknown> = {}) => [json({ version: 1, items, ...extra }), ...good().slice(1)];
  const cases: Array<[string, () => SandboxFile[], HtmlFrameSize[]?]> = [
    ['a missing result.json', () => good().slice(1)],
    ['invalid json', () => [{ path: 'result.json', data: Buffer.from('{') }, ...good().slice(1)]],
    ['invalid UTF-8', () => [{ path: 'result.json', data: Buffer.from([0xff, 0xfe]) }, ...good().slice(1)]],
    ['an extra top-level field', () => replaceResult(JSON.parse(good()[0]!.data.toString()).items, { note: 'x' })],
    ['another version', () => [json({ version: 2, items: [] }), ...good().slice(1)]],
    ['fewer items than requested', () => replaceResult([rendered('h001', 'wide'), { id: 'h002', status: 'failed', error: 'render_timeout' }])],
    ['ids out of order', () => replaceResult([{ id: 'h002', status: 'failed', error: 'render_timeout' }, rendered('h001', 'wide'), rendered('h003', 'tall')])],
    ['an unexpected id', () => replaceResult([rendered('h009', 'wide'), { id: 'h002', status: 'failed', error: 'render_timeout' }, rendered('h003', 'tall')])],
    ['an unknown failure code', () => replaceResult([rendered('h001', 'wide'), { id: 'h002', status: 'failed', error: 'oops' }, rendered('h003', 'tall')])],
    ['a failure with a message', () => replaceResult([rendered('h001', 'wide'), { id: 'h002', status: 'failed', error: 'render_failed', message: 'x' }, rendered('h003', 'tall')])],
    ['an unknown status', () => replaceResult([rendered('h001', 'wide'), { id: 'h002', status: 'done' }, rendered('h003', 'tall')])],
    ['a size that does not match the frame', () => replaceResult([rendered('h001', 'tall'), { id: 'h002', status: 'failed', error: 'render_timeout' }, rendered('h003', 'tall')])],
    ['too many layout issues', () => replaceResult([rendered('h001', 'wide', Array.from({ length: 13 }, () => 'x')), { id: 'h002', status: 'failed', error: 'render_timeout' }, rendered('h003', 'tall')])],
    ['a layout issue that is too long', () => replaceResult([rendered('h001', 'wide', ['x'.repeat(301)]), { id: 'h002', status: 'failed', error: 'render_timeout' }, rendered('h003', 'tall')])],
    ['a non-string layout issue', () => replaceResult([rendered('h001', 'wide', [{ html: '<b>' }]), { id: 'h002', status: 'failed', error: 'render_timeout' }, rendered('h003', 'tall')])],
    ['a missing image', () => good().slice(0, 2)],
    ['an image for a failed item', () => [...good(), { path: 'h002.png', data: pngOf('panorama') }]],
    ['an unexpected file', () => [...good(), { path: 'notes.json', data: Buffer.from('{}') }]],
    ['a duplicate file', () => [...good(), { path: 'h001.png', data: pngOf('wide') }]],
    ['an image that is not a png', () => [good()[0]!, { path: 'h001.png', data: Buffer.from('GIF89a'.padEnd(40, '\0')) }, good()[2]!]],
    ['a png of another size', () => [good()[0]!, { path: 'h001.png', data: fakePng(2480, 1653) }, good()[2]!]],
    ['frames that do not match', () => good(), ['tall', 'panorama', 'tall']],
  ];
  it.each(cases)('rejects %s', (_name, files, frameSizes = frames) => {
    expect(() => validateRenderHtmlOutput(files(), frameSizes)).toThrow(RenderHtmlOutputError);
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
  const ref = { id: 'sandbox-1', template: 'render-html' } as unknown as SandboxRef;
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

const context = (driver: SandboxDriver | null): RenderHtmlContext => ({ jobId: '3f0c8a8e-6d1b-4e55-9a5e-2b9f0e1c7d42', signal: new AbortController().signal, log: async () => {}, sandbox: driver as SandboxDriver });
const items: HtmlImageInput[] = [{ html: '<p>a</p>', frameSize: 'square', checkLayout: true }];

describe('renderHtmlImages', () => {
  it('creates a render-html sandbox, sends only request.json, runs the render command and always destroys the sandbox', async () => {
    const { driver, calls } = fakeDriver({ output: [json({ version: 1, items: [rendered('h001', 'square')] }), { path: 'h001.png', data: pngOf('square') }] });
    const results = await renderHtmlImages(context(driver), items, { createRetryDelaysMs: [] });
    expect(results).toMatchObject([{ status: 'rendered', width: 2480, height: 2480, layoutIssues: [] }]);
    expect(calls.created).toEqual(['render-html']);
    expect(calls.copied.map((files) => files.map((file) => file.path))).toEqual([['request.json']]);
    expect(calls.exec).toEqual([['render', []]]);
    expect(calls.destroyed).toBe(1);
  });

  it.each([
    ['{"error":"request_invalid"}', 'RENDER_HTML_REQUEST_INVALID'],
    ['{"error":"browser_failed"}', 'RENDER_HTML_FAILED'],
    ['{"error":"something else"}', 'RENDER_HTML_FAILED'],
    ['not json', 'RENDER_HTML_FAILED'],
  ])('maps the entry error %s to %s', async (stdout, code) => {
    const { driver, calls } = fakeDriver({ exec: async () => ({ exitCode: 65, stdout, stderr: 'browser said something', timedOut: false }) });
    const error = await renderHtmlImages(context(driver), items, { createRetryDelaysMs: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain('browser said');
    expect(calls.destroyed).toBe(1);
  });

  it('fails with RENDER_HTML_TIMEOUT when the command times out', async () => {
    const { driver, calls } = fakeDriver({ exec: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) });
    await expect(renderHtmlImages(context(driver), items, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_HTML_TIMEOUT' });
    expect(calls.destroyed).toBe(1);
  });

  it('rejects invalid output with RENDER_HTML_OUTPUT_REJECTED', async () => {
    const { driver, calls } = fakeDriver({ output: [json({ version: 1, items: [rendered('h001', 'wide')] })] });
    await expect(renderHtmlImages(context(driver), items, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_HTML_OUTPUT_REJECTED' });
    expect(calls.destroyed).toBe(1);
  });

  it('maps sandbox errors and aborts', async () => {
    const rejected = fakeDriver({ copyOutError: new SandboxError('SANDBOX_OUTPUT_REJECTED', 'bad archive') });
    await expect(renderHtmlImages(context(rejected.driver), items, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_HTML_OUTPUT_REJECTED' });
    expect(rejected.calls.destroyed).toBe(1);
    const aborted = fakeDriver({ copyOutError: new SandboxError('SANDBOX_ABORTED', 'aborted') });
    await expect(renderHtmlImages(context(aborted.driver), items, { createRetryDelaysMs: [] })).rejects.toBeInstanceOf(JobInterruptedError);
    const busy = fakeDriver({ createError: new SandboxError('SANDBOX_BUSY', 'busy') });
    await expect(renderHtmlImages(context(busy.driver), items, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_HTML_SANDBOX_BUSY' });
    expect(busy.calls.destroyed).toBe(0);
  });

  it('validates the request before creating a sandbox, and needs a sandbox driver', async () => {
    const { driver, calls } = fakeDriver({});
    await expect(renderHtmlImages(context(driver), [], { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_HTML_REQUEST_INVALID' });
    expect(calls.created).toEqual([]);
    await expect(renderHtmlImages(context(null), items)).rejects.toMatchObject({ code: 'RENDER_HTML_UNAVAILABLE' });
  });
});
