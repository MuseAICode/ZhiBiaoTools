// 样张在 export-preview 沙箱中的生成流程（src/export/preview.ts，路线图 7.3b），用记录调用的假 SandboxDriver 验证：
// 只放 request.json（重新序列化的 HTML 与规范化的配置），不放任何配图；入队前校验不通过时不创建沙箱；
// 失败只按错误代码给出原因；不论成败都销毁沙箱；沙箱忙时按间隔重试。真实沙箱中的端到端测试见 tests/sandbox/docker/exportPreview.test.ts。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderTemplatePreview, buildPreviewRequest, preparePreviewRequest, type PreviewContext } from '../../src/export/preview.ts';
import { JobError, JobInterruptedError } from '../../src/jobs/definitions.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxExecResult, type SandboxRef } from '../../src/sandbox/driver.ts';
import { defaultExportFormat, normalizeExportFormat } from '../../src/templates/exportFormat.ts';
import { parseRestrictedHtml } from '../../src/templates/restrictedHtml.ts';
import { buildZip } from '../sandbox/zipFixtures.ts';

const template = readFileSync(new URL('../../../client/electron/resources/content-generation/正文模板.html', import.meta.url), 'utf8');
const SAMPLE = template.replace(/src="assets\/([a-z-]+)\.webp"/g, (_match, name: string) => `src="/assets/${name}-Bx7Kq2Lm.webp"`);
const DOCX = buildZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
]);
const OK_FILES: SandboxFile[] = [
  { path: 'document.docx', data: DOCX },
  { path: 'result.json', data: Buffer.from(JSON.stringify({ version: 1, blockCount: 30, imageWarnings: [] })) },
];

interface FakeOptions {
  create?: (attempt: number) => void;
  exec?: SandboxExecResult | (() => never);
  output?: SandboxFile[] | (() => never);
}

function execResult(exitCode: number | null, stdout = '', timedOut = false): SandboxExecResult {
  return { exitCode, timedOut, stdout, stderr: '助手的错误文字', stdoutTruncated: false, stderrTruncated: false };
}

function fakeDriver(options: FakeOptions = {}) {
  const calls: string[] = [];
  const copied: SandboxFile[][] = [];
  let creates = 0;
  const ref: SandboxRef = { id: 'sbx', template: 'export-preview', jobId: 'job-1', expiresAt: new Date(Date.now() + 60_000) };
  const driver: SandboxDriver = {
    async create(templateName, { jobId }) {
      calls.push(`create:${templateName}:${jobId}`);
      creates += 1;
      options.create?.(creates);
      return ref;
    },
    async copyIn(_sandbox, files) {
      calls.push('copyIn');
      copied.push([...files]);
    },
    async exec(_sandbox, command, args) {
      calls.push(`exec:${command}:${args.length}`);
      const result = options.exec ?? execResult(0);
      return typeof result === 'function' ? result() : result;
    },
    async copyOut() {
      calls.push('copyOut');
      const output = options.output ?? OK_FILES;
      return typeof output === 'function' ? output() : output;
    },
    async destroy() {
      calls.push('destroy');
    },
  };
  return { driver, calls, copied };
}

function context(driver: SandboxDriver | null, logs: string[] = [], signal = new AbortController().signal): PreviewContext {
  return { jobId: 'job-1', signal, sandbox: driver, log: async (message: string) => void logs.push(message) };
}

async function failure(promise: Promise<unknown>): Promise<JobError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(JobError);
    return error as JobError;
  }
  throw new Error('expected a JobError');
}

/** 递归按键名倒序重排对象（模拟 jsonb 读回后键的顺序变化）。 */
function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().reverse().map((key) => [key, reorder((value as Record<string, unknown>)[key])]));
}

describe('preparePreviewRequest', () => {
  it('returns the request body with its SHA-256, and the same hash when prepared again from its own (reordered) output', () => {
    const format = { ...defaultExportFormat(), template_name: '哈希' };
    const first = preparePreviewRequest({ html: SAMPLE, exportFormat: format });
    expect(first.body.equals(buildPreviewRequest({ html: SAMPLE, exportFormat: format }))).toBe(true);
    expect(first.sha256.equals(createHash('sha256').update(first.body).digest())).toBe(true);
    expect(JSON.parse(first.body.toString('utf8'))).toEqual({ html: first.html, export_format: first.exportFormat });
    const again = preparePreviewRequest({ html: first.html, exportFormat: reorder(first.exportFormat) });
    expect(again.body.equals(first.body)).toBe(true);
    expect(again.sha256.equals(first.sha256)).toBe(true);
  });

  it('gives a different hash when the HTML or the format changes', () => {
    const base = preparePreviewRequest({ html: SAMPLE, exportFormat: defaultExportFormat() });
    const html = preparePreviewRequest({ html: SAMPLE.replace('。', '！'), exportFormat: defaultExportFormat() });
    const format = preparePreviewRequest({ html: SAMPLE, exportFormat: { ...defaultExportFormat(), template_name: '另一个' } });
    expect(html.sha256.equals(base.sha256)).toBe(false);
    expect(format.sha256.equals(base.sha256)).toBe(false);
  });

  it('rejects an invalid sample before hashing', () => {
    expect(() => preparePreviewRequest({ html: '<script>alert(1)</script><p>x</p>', exportFormat: {} })).toThrow(JobError);
  });
});

describe('renderTemplatePreview', () => {
  it('sends only request.json with the re-serialized HTML and the normalized format, and destroys the sandbox', async () => {
    const { driver, calls, copied } = fakeDriver();
    const output = await renderTemplatePreview(context(driver), { html: SAMPLE, exportFormat: { page: { header_text: '页眉' } } });
    expect(output).toEqual({ docx: DOCX, blockCount: 30, imageWarnings: [] });
    expect(calls).toEqual(['create:export-preview:job-1', 'copyIn', 'exec:export:0', 'copyOut', 'destroy']);
    expect(copied).toHaveLength(1);
    expect(copied[0]!.map((file) => file.path)).toEqual(['request.json']);
    const request = JSON.parse(copied[0]![0]!.data.toString('utf8')) as { html: string; export_format: unknown };
    expect(Object.keys(request).sort()).toEqual(['export_format', 'html']);
    expect(request.html).toBe(parseRestrictedHtml(template).normalizedHtml);
    expect(request.html).not.toContain('Bx7Kq2Lm');
    expect(request.export_format).toEqual(normalizeExportFormat({ page: { header_text: '页眉' } }));
  });

  it('normalizes a missing or broken format to the defaults', () => {
    const request = JSON.parse(buildPreviewRequest({ html: SAMPLE, exportFormat: 'not an object' }).toString('utf8')) as { export_format: unknown };
    expect(request.export_format).toEqual(defaultExportFormat());
  });

  it.each([
    ['not a string', 42],
    ['a script', '<!-- app:block -->\n<p id="p1">x</p><script>alert(1)</script>'],
    ['an event handler', '<!-- app:block -->\n<p id="p1" onclick="x()">x</p>'],
    ['a project image', '<!-- app:block -->\n<figure id="f1" data-app-generation="aiImage" data-app-size="wide"><img data-app-asset-ref="artifact:00000000-0000-0000-0000-000000000000" alt="x"></figure>'],
  ])('rejects %s before creating any sandbox', async (_label, html) => {
    const { driver, calls } = fakeDriver();
    const error = await failure(renderTemplatePreview(context(driver), { html, exportFormat: {} }));
    expect(error.code).toBe('PREVIEW_HTML_INVALID');
    expect(calls).toEqual([]);
  });

  it('fails as unavailable when the worker has no sandbox runner', async () => {
    expect((await failure(renderTemplatePreview(context(null), { html: SAMPLE, exportFormat: {} }))).code).toBe('EXPORT_UNAVAILABLE');
  });

  it.each([
    ['request_invalid', 'EXPORT_REQUEST_INVALID'],
    ['chrome_render_failed', 'EXPORT_DECORATION_FAILED'],
    ['helper_failed', 'EXPORT_WORD_FAILED'],
    ['helper_timeout', 'EXPORT_TIMEOUT'],
    ['output_too_large', 'EXPORT_OUTPUT_TOO_LARGE'],
    ['something_else', 'EXPORT_FAILED'],
  ])('maps the entry code %s to %s, without the helper text, and destroys the sandbox', async (entryCode, jobCode) => {
    const { driver, calls } = fakeDriver({ exec: execResult(65, `{"error":"${entryCode}"}\n`) });
    const error = await failure(renderTemplatePreview(context(driver), { html: SAMPLE, exportFormat: {} }));
    expect(error.code).toBe(jobCode);
    expect(error.message).not.toContain('助手');
    expect(calls).toEqual(['create:export-preview:job-1', 'copyIn', 'exec:export:0', 'destroy']);
  });

  it('fails with EXPORT_TIMEOUT when the command hits the template wall clock', async () => {
    const { driver, calls } = fakeDriver({ exec: execResult(null, '', true) });
    expect((await failure(renderTemplatePreview(context(driver), { html: SAMPLE, exportFormat: {} }))).code).toBe('EXPORT_TIMEOUT');
    expect(calls.at(-1)).toBe('destroy');
  });

  it('rejects output whose content does not pass validation', async () => {
    const { driver, calls } = fakeDriver({ output: [OK_FILES[0]!, { path: 'result.json', data: Buffer.from('{"version":1,"blockCount":1,"imageWarnings":[],"log":"x"}') }] });
    expect((await failure(renderTemplatePreview(context(driver), { html: SAMPLE, exportFormat: {} }))).code).toBe('EXPORT_OUTPUT_REJECTED');
    expect(calls.at(-1)).toBe('destroy');
  });

  it('rejects output the archive check refused', async () => {
    const { driver } = fakeDriver({ output: () => { throw new SandboxError('SANDBOX_OUTPUT_REJECTED', 'symlink'); } });
    expect((await failure(renderTemplatePreview(context(driver), { html: SAMPLE, exportFormat: {} }))).code).toBe('EXPORT_OUTPUT_REJECTED');
  });

  it('turns an aborted sandbox operation into an interruption', async () => {
    const { driver, calls } = fakeDriver({ exec: () => { throw new SandboxError('SANDBOX_ABORTED', 'aborted'); } });
    await expect(renderTemplatePreview(context(driver), { html: SAMPLE, exportFormat: {} })).rejects.toBeInstanceOf(JobInterruptedError);
    expect(calls.at(-1)).toBe('destroy');
  });

  it('retries creating while the runner is busy, then succeeds', async () => {
    const logs: string[] = [];
    const { driver, calls } = fakeDriver({ create: (attempt) => { if (attempt < 3) throw new SandboxError('SANDBOX_BUSY', 'busy'); } });
    await renderTemplatePreview(context(driver, logs), { html: SAMPLE, exportFormat: {} }, { createRetryDelaysMs: [1, 1, 1] });
    expect(calls.filter((call) => call.startsWith('create')).length).toBe(3);
    expect(logs).toEqual(['沙箱数已达上限，稍后重试', '沙箱数已达上限，稍后重试']);
  });

  it.each([
    ['SANDBOX_BUSY', 'EXPORT_SANDBOX_BUSY'],
    ['SANDBOX_UNAVAILABLE', 'EXPORT_UNAVAILABLE'],
  ] as const)('fails with %s → %s once the retries are used up', async (sandboxCode, jobCode) => {
    const { driver, calls } = fakeDriver({ create: () => { throw new SandboxError(sandboxCode, 'x'); } });
    expect((await failure(renderTemplatePreview(context(driver), { html: SAMPLE, exportFormat: {} }, { createRetryDelaysMs: [1, 1] }))).code).toBe(jobCode);
    expect(calls).toEqual(['create:export-preview:job-1', 'create:export-preview:job-1', 'create:export-preview:job-1']);
  });

  it('stops waiting for a retry when the job is aborted', async () => {
    const controller = new AbortController();
    const { driver } = fakeDriver({ create: () => { controller.abort(); throw new SandboxError('SANDBOX_BUSY', 'busy'); } });
    await expect(renderTemplatePreview(context(driver, [], controller.signal), { html: SAMPLE, exportFormat: {} }, { createRetryDelaysMs: [60_000] })).rejects.toBeInstanceOf(JobInterruptedError);
  });
});
