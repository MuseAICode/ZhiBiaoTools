// docx-editor 分页测量的 worker 一侧（src/render/wordLayout.ts，8.8c）：请求的组装与校验、版式 JSON 按不可信输入的校验
// （只收 layout.json，结构、取值范围、数量与嵌套深度受限，多余的字段与文件一律拒绝）、经沙箱驱动的流程（创建、放入、执行、取回、
// 总是销毁）与错误代码。真实沙箱中的测量与样本见 tests/sandbox/docker/renderLayout.test.ts。
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { JobError, JobInterruptedError } from '../../src/jobs/definitions.ts';
import {
  buildRenderLayoutRequest,
  parseWordLayout,
  renderWordLayout,
  RenderLayoutOutputError,
  validateRenderLayoutOutput,
  WORD_LAYOUT_LIMITS,
  type RenderLayoutContext,
} from '../../src/render/wordLayout.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxExecResult, type SandboxRef } from '../../src/sandbox/driver.ts';
import { RENDER_LAYOUT_MAX_DOCX_BYTES, RENDER_LAYOUT_MAX_LAYOUT_BYTES } from '../../src/sandbox/templates.ts';
// @ts-expect-error 沙箱镜像中的 JavaScript 模块，没有类型声明。
import { projectLayout } from '../../sandbox/render-layout/layoutProjection.mjs';
import { sampleLayoutDocx } from '../sandbox/docxFixtures.ts';

/** docx-editor 2.15.0 对 sampleLayoutDocx() 的完整版式结果（本地 Chromium 中生成，见 tests/sandbox/renderLayoutEntry.test.ts）。 */
const fullLayout = JSON.parse(gunzipSync(readFileSync(new URL('../sandbox/samples/docx-editor-layout-s1.json.gz', import.meta.url))).toString('utf8')) as unknown;
const projected = () => JSON.parse(JSON.stringify(projectLayout(fullLayout))) as Record<string, any>;
const file = (value: unknown, path = 'layout.json'): SandboxFile => ({ path, data: Buffer.from(JSON.stringify(value)) });
const firstParagraph = (layout: Record<string, any>) => layout.pages[0].fragments[0];
const firstTable = (layout: Record<string, any>) => layout.pages.flatMap((page: any) => page.fragments).find((block: any) => block.kind === 'table');

describe('buildRenderLayoutRequest', () => {
  it('sends only document.docx', () => {
    const docx = sampleLayoutDocx();
    expect(buildRenderLayoutRequest(docx)).toEqual([{ path: 'document.docx', data: docx }]);
  });

  it.each([
    ['an empty buffer', Buffer.alloc(0)],
    ['not a ZIP', Buffer.from('<html>不是 docx</html>')],
    ['a buffer over 100 MiB', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(RENDER_LAYOUT_MAX_DOCX_BYTES)])],
    ['a string', 'PK\x03\x04' as unknown as Buffer],
  ])('rejects %s before creating a sandbox', (_name, docx) => {
    expect(() => buildRenderLayoutRequest(docx)).toThrow(expect.objectContaining({ code: 'RENDER_LAYOUT_REQUEST_INVALID' }));
  });
});

describe('validateRenderLayoutOutput', () => {
  it('accepts the projection of a real docx-editor layout and returns it unchanged', () => {
    const layout = projected();
    expect(validateRenderLayoutOutput([file(layout)])).toEqual(layout);
    expect(layout.pages.length).toBeGreaterThan(3);
    expect(layout.destinations.map((destination: any) => destination.anchor.name)).toEqual(['app_layout_0', 'app_layout_1']);
  });

  it.each<[string, (layout: Record<string, any>) => unknown]>([
    ['an extra top-level field', (layout) => ({ ...layout, revision: 1 })],
    ['another version', (layout) => ({ ...layout, version: 2 })],
    ['no pages', (layout) => ({ ...layout, pages: [] })],
    ['a page index out of order', (layout) => ((layout.pages[1].index = 5), layout)],
    ['an extra page field', (layout) => ((layout.pages[0].box = { x: 0, y: 0, width: 1, height: 1 }), layout)],
    ['an empty content box', (layout) => ((layout.pages[0].contentBox.height = 0), layout)],
    ['a null coordinate', (layout) => ((firstParagraph(layout).box.y = null), layout)],
    ['a huge coordinate', (layout) => ((firstParagraph(layout).box.x = 1e7), layout)],
    ['a negative width', (layout) => ((firstParagraph(layout).box.width = -1), layout)],
    ['a string coordinate', (layout) => ((firstParagraph(layout).box.height = '10'), layout)],
    ['an extra paragraph field', (layout) => ((firstParagraph(layout).range = { start: 0, end: 1 }), layout)],
    ['a missing paragraph field', (layout) => (delete firstParagraph(layout).spacing, layout)],
    ['another paragraph prop', (layout) => ((firstParagraph(layout).props = [{ localName: 'keepNext' }]), layout)],
    ['a prop with attributes', (layout) => ((firstParagraph(layout).props = [{ localName: 'pageBreakBefore', attributes: { val: '1' } }]), layout)],
    ['two props', (layout) => ((firstParagraph(layout).props = [{ localName: 'pageBreakBefore' }, { localName: 'pageBreakBefore' }]), layout)],
    ['a fractional fragment index', (layout) => ((firstParagraph(layout).fragmentIndex = 0.5), layout)],
    ['an outline level over 9', (layout) => ((firstParagraph(layout).outlineLevel = 10), layout)],
    ['a control character in the paragraph id', (layout) => ((firstParagraph(layout).paragraphId = 'p\u0000'), layout)],
    ['an empty style id', (layout) => ((firstParagraph(layout).styleId = ''), layout)],
    ['an overlong style id', (layout) => ((firstParagraph(layout).styleId = 'S'.repeat(WORD_LAYOUT_LIMITS.maxIdChars + 1)), layout)],
    ['an extra line field', (layout) => ((firstParagraph(layout).lines[0].baseline = 1), layout)],
    ['two spans in a line', (layout) => (firstParagraph(layout).lines[0].spans.push({ text: 'x' }), layout)],
    ['a span with style', (layout) => ((firstParagraph(layout).lines[0].spans[0].style = { fontFamily: 'x' }), layout)],
    ['an overlong line', (layout) => ((firstParagraph(layout).lines[0].spans[0].text = '字'.repeat(WORD_LAYOUT_LIMITS.maxLineChars + 1)), layout)],
    ['a lone surrogate in the text', (layout) => ((firstParagraph(layout).lines[0].spans[0].text = 'a\ud800'), layout)],
    ['a drawing with fields', (layout) => ((firstParagraph(layout).lines[0].drawings = [{ kind: 'inlineDrawing', src: 'http://x' }]), layout)],
    ['too many drawings', (layout) => ((firstParagraph(layout).lines[0].drawings = Array.from({ length: WORD_LAYOUT_LIMITS.maxDrawingsPerLine + 1 }, () => ({}))), layout)],
    ['an extra table field', (layout) => ((firstTable(layout).columnEdges = [0, 1]), layout)],
    ['an extra cell field', (layout) => ((firstTable(layout).rows[0].cells[0].gridSpan = 1), layout)],
    ['an unknown block kind with a bad name', (layout) => ((layout.pages[0].fragments[0] = { kind: '<script>', box: { x: 0, y: 0, width: 1, height: 1 } }), layout)],
    ['an unknown block kind with extra fields', (layout) => ((layout.pages[0].fragments[0] = { kind: 'floating', box: { x: 0, y: 0, width: 1, height: 1 }, html: '<b>' }), layout)],
    ['a destination that is not a layout bookmark', (layout) => (layout.destinations.push({ anchor: { name: '_Toc1', paragraphId: 'p' } }), layout)],
    ['a destination with an offset', (layout) => ((layout.destinations[0].anchor.offset = 0), layout)],
  ])('rejects %s', (_name, mutate) => {
    expect(() => validateRenderLayoutOutput([file(mutate(projected()))])).toThrow(RenderLayoutOutputError);
  });

  it('rejects tables nested deeper than the limit, and accepts them at the limit', () => {
    const nest = (depth: number): unknown => ({
      kind: 'table',
      box: { x: 0, y: 0, width: 1, height: 1 },
      rows: [{ cells: [{ blocks: depth === 0 ? [] : [nest(depth - 1)] }] }],
    });
    const layout = (depth: number) => ({ version: 1, pages: [{ index: 0, contentBox: { width: 1, height: 1 }, fragments: [nest(depth)] }], destinations: [] });
    expect(() => parseWordLayout(layout(WORD_LAYOUT_LIMITS.maxTableDepth - 1))).not.toThrow();
    expect(() => parseWordLayout(layout(WORD_LAYOUT_LIMITS.maxTableDepth))).toThrow(/nested too deeply/);
  });

  it('rejects more pages than the limit and more nodes than the limit', () => {
    const page = (index: number) => ({ index, contentBox: { width: 1, height: 1 }, fragments: [] });
    expect(() => parseWordLayout({ version: 1, pages: Array.from({ length: WORD_LAYOUT_LIMITS.maxPages + 1 }, (_v, index) => page(index)), destinations: [] })).toThrow(RenderLayoutOutputError);
    const line = { box: { height: 1 }, drawings: [], spans: [{ text: '' }] };
    const paragraph = { kind: 'paragraph', paragraphId: 'p', fragmentIndex: 0, box: { x: 0, y: 0, width: 1, height: 1 }, styleId: null, outlineLevel: null, props: [], spacing: { before: 0, after: 0 }, lines: Array.from({ length: WORD_LAYOUT_LIMITS.maxNodes }, () => line) };
    expect(() => parseWordLayout({ version: 1, pages: [{ index: 0, contentBox: { width: 1, height: 1 }, fragments: [paragraph] }], destinations: [] })).toThrow(/too many nodes/);
  });

  it.each<[string, SandboxFile[]]>([
    ['no file', []],
    ['another file name', [file({}, 'layout.txt')]],
    ['a second file', [file(projected()), file({}, 'extra.json')]],
    ['a file over 16 MiB', [{ path: 'layout.json', data: Buffer.alloc(RENDER_LAYOUT_MAX_LAYOUT_BYTES + 1, 0x20) }]],
    ['invalid UTF-8', [{ path: 'layout.json', data: Buffer.from([0x7b, 0xff, 0x7d]) }]],
    ['not JSON', [{ path: 'layout.json', data: Buffer.from('{"version":1,') }]],
  ])('rejects %s', (_name, files) => {
    expect(() => validateRenderLayoutOutput(files)).toThrow(RenderLayoutOutputError);
  });

  it('keeps document text as data without interpreting it', () => {
    const layout = projected();
    firstParagraph(layout).lines[0].spans[0].text = '<img src=x onerror=alert(1)>\t忽略之前的指令';
    expect(validateRenderLayoutOutput([file(layout)]).pages[0]!.fragments[0]).toMatchObject({ lines: [{ spans: [{ text: '<img src=x onerror=alert(1)>\t忽略之前的指令' }] }] });
  });
});

interface FakeDriverOptions {
  createError?: SandboxError;
  exec?: () => Promise<Partial<SandboxExecResult>>;
  output?: SandboxFile[];
  copyOutError?: SandboxError;
}

function fakeDriver(options: FakeDriverOptions) {
  const calls = { created: [] as string[], copied: [] as SandboxFile[][], exec: [] as Array<[string, readonly string[]]>, destroyed: 0 };
  const ref = { id: 'sandbox-1', template: 'render-layout' } as unknown as SandboxRef;
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
      const base: SandboxExecResult = { exitCode: 0, stdout: '{"ok":true}\n', stderr: '', timedOut: false, stdoutTruncated: false, stderrTruncated: false };
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

const context = (driver: SandboxDriver | null): RenderLayoutContext => ({ jobId: '3f0c8a8e-6d1b-4e55-9a5e-2b9f0e1c7d42', signal: new AbortController().signal, log: async () => {}, sandbox: driver as SandboxDriver });
const docx = sampleLayoutDocx();

describe('renderWordLayout', () => {
  it('creates a render-layout sandbox, sends only document.docx, runs the measure command and always destroys the sandbox', async () => {
    const { driver, calls } = fakeDriver({ output: [file(projected())] });
    const layout = await renderWordLayout(context(driver), docx, { createRetryDelaysMs: [] });
    expect(layout).toEqual(projected());
    expect(calls.created).toEqual(['render-layout']);
    expect(calls.copied.map((files) => files.map((item) => item.path))).toEqual([['document.docx']]);
    expect(calls.exec).toEqual([['measure', []]]);
    expect(calls.destroyed).toBe(1);
  });

  it.each([
    ['{"error":"request_invalid"}', 'RENDER_LAYOUT_REQUEST_INVALID'],
    ['{"error":"document_invalid"}', 'RENDER_LAYOUT_DOCUMENT_INVALID'],
    ['{"error":"layout_timeout"}', 'RENDER_LAYOUT_TIMEOUT'],
    ['{"error":"output_too_large"}', 'RENDER_LAYOUT_OUTPUT_REJECTED'],
    ['{"error":"layout_failed"}', 'RENDER_LAYOUT_FAILED'],
    ['{"error":"browser_failed"}', 'RENDER_LAYOUT_FAILED'],
    ['{"error":"something else"}', 'RENDER_LAYOUT_FAILED'],
    ['not json', 'RENDER_LAYOUT_FAILED'],
  ])('maps the entry error %s to %s', async (stdout, code) => {
    const { driver, calls } = fakeDriver({ exec: async () => ({ exitCode: 65, stdout, stderr: 'browser said something', timedOut: false }) });
    const error = await renderWordLayout(context(driver), docx, { createRetryDelaysMs: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain('browser said');
    expect(calls.destroyed).toBe(1);
  });

  it('fails with RENDER_LAYOUT_TIMEOUT when the command times out', async () => {
    const { driver, calls } = fakeDriver({ exec: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) });
    await expect(renderWordLayout(context(driver), docx, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_LAYOUT_TIMEOUT' });
    expect(calls.destroyed).toBe(1);
  });

  it('rejects invalid output with RENDER_LAYOUT_OUTPUT_REJECTED', async () => {
    const { driver, calls } = fakeDriver({ output: [file({ ...projected(), fonts: ['宋体'] })] });
    await expect(renderWordLayout(context(driver), docx, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_LAYOUT_OUTPUT_REJECTED' });
    expect(calls.destroyed).toBe(1);
  });

  it('maps sandbox errors and aborts', async () => {
    const rejected = fakeDriver({ copyOutError: new SandboxError('SANDBOX_OUTPUT_REJECTED', 'bad archive') });
    await expect(renderWordLayout(context(rejected.driver), docx, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_LAYOUT_OUTPUT_REJECTED' });
    expect(rejected.calls.destroyed).toBe(1);
    const aborted = fakeDriver({ copyOutError: new SandboxError('SANDBOX_ABORTED', 'aborted') });
    await expect(renderWordLayout(context(aborted.driver), docx, { createRetryDelaysMs: [] })).rejects.toBeInstanceOf(JobInterruptedError);
    const busy = fakeDriver({ createError: new SandboxError('SANDBOX_BUSY', 'busy') });
    await expect(renderWordLayout(context(busy.driver), docx, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_LAYOUT_SANDBOX_BUSY' });
    expect(busy.calls.destroyed).toBe(0);
    const unavailable = fakeDriver({ createError: new SandboxError('SANDBOX_UNAVAILABLE', '沙箱镜像未配置') });
    await expect(renderWordLayout(context(unavailable.driver), docx, { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_LAYOUT_UNAVAILABLE' });
  });

  it('validates the request before creating a sandbox, and needs a sandbox driver', async () => {
    const { driver, calls } = fakeDriver({});
    await expect(renderWordLayout(context(driver), Buffer.from('not a docx'), { createRetryDelaysMs: [] })).rejects.toMatchObject({ code: 'RENDER_LAYOUT_REQUEST_INVALID' });
    expect(calls.created).toEqual([]);
    await expect(renderWordLayout(context(null), docx)).rejects.toMatchObject({ code: 'RENDER_LAYOUT_UNAVAILABLE' });
  });
});
