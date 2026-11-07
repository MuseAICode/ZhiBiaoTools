// 整本 Word 在 export-document 沙箱中的生成流程（src/export/document.ts，路线图 7.4g），用记录调用的假 SandboxDriver 验证：
// 放入 request.json（服务端组装的 HTML、规范化的配置、配图的 MIME）与按需读取的配图（assets/<产物 id>，读取时才访问对象存储）；
// 新建沙箱之前按模板的输入规则拒绝（数量、单个、合计）；失败只按错误代码给出原因；配图读取失败时提示重新导出；
// 不论成败都销毁沙箱。真实沙箱中的端到端测试见 tests/sandbox/docker/exportDocument.test.ts。
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  buildDocumentRequest,
  checkDocumentInputSize,
  renderTechnicalPlanDocument,
  type DocumentExportAsset,
  type DocumentExportContext,
} from '../../src/export/document.ts';
import type { StoredObject } from '../../src/files/objectStore.ts';
import { JobError, JobInterruptedError } from '../../src/jobs/definitions.ts';
import { readArchive, createArchiveStream, type SandboxFile, type SandboxInputFile } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxExecResult, type SandboxRef } from '../../src/sandbox/driver.ts';
import { ObjectInputError } from '../../src/sandbox/objectInput.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { normalizeExportFormat } from '../../src/templates/exportFormat.ts';
import { buildZip } from '../sandbox/zipFixtures.ts';

const MIB = 1024 * 1024;
const LIMITS = SANDBOX_TEMPLATES['export-document'].input;
const DOCX = buildZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
]);
const ID_A = '0b6f1f8e-3c1a-4d0e-9a51-0e2f7f9d1a01';
const ID_B = '0b6f1f8e-3c1a-4d0e-9a51-0e2f7f9d1a02';
const HTML = `<section data-app-export-template="true" data-app-export-page-template="true"><h1 data-app-outline-number="1">第一章</h1><figure data-app-size="wide" data-app-fit="contain"><img data-app-asset-ref="${ID_A}"></figure></section>`;
const FORMAT = normalizeExportFormat({ template_name: '整本' });

function resultJson(imageWarnings: Array<{ assetRef: string; reason: string }> = []) {
  return Buffer.from(JSON.stringify({ version: 1, blockCount: 12, imageWarnings }));
}

function execResult(exitCode: number | null, stdout = '', timedOut = false): SandboxExecResult {
  return { exitCode, timedOut, stdout, stderr: '助手的错误文字', stdoutTruncated: false, stderrTruncated: false };
}

function fakeStore(objects: Record<string, Buffer>) {
  const gets: string[] = [];
  return {
    gets,
    async get(key: string): Promise<StoredObject | null> {
      gets.push(key);
      const data = objects[key];
      return data ? { body: Readable.from([data]), size: data.length } : null;
    },
  };
}

interface FakeOptions {
  create?: (attempt: number) => void;
  exec?: SandboxExecResult | (() => never);
  output?: SandboxFile[];
}

/** 假驱动：copyIn 按真实的规则生成归档并读回（按需读取的文件在这里才被读取），记下放入的文件。 */
function fakeDriver(options: FakeOptions = {}) {
  const calls: string[] = [];
  let copied: SandboxFile[] = [];
  let creates = 0;
  const ref: SandboxRef = { id: 'sbx', template: 'export-document', jobId: 'job-1', expiresAt: new Date(Date.now() + 60_000) };
  const driver: SandboxDriver = {
    async create(templateName, { jobId }) {
      calls.push(`create:${templateName}:${jobId}`);
      creates += 1;
      options.create?.(creates);
      return ref;
    },
    async copyIn(_sandbox, files: readonly SandboxInputFile[]) {
      calls.push('copyIn');
      const stream = createArchiveStream(files, LIMITS);
      try {
        copied = await readArchive(stream.chunks, LIMITS);
      } catch (error) {
        if (stream.failure && !(stream.failure instanceof SandboxError)) throw new SandboxError('SANDBOX_INPUT_FAILED', 'input failed', { cause: stream.failure });
        throw error;
      }
    },
    async exec(_sandbox, command, args) {
      calls.push(`exec:${command}:${args.length}`);
      const result = options.exec ?? execResult(0);
      return typeof result === 'function' ? result() : result;
    },
    async copyOut() {
      calls.push('copyOut');
      return options.output ?? [{ path: 'document.docx', data: DOCX }, { path: 'result.json', data: resultJson() }];
    },
    async destroy() {
      calls.push('destroy');
    },
  };
  return { driver, calls, copied: () => copied };
}

function contextOf(driver: SandboxDriver | null, signal = new AbortController().signal) {
  const logs: string[] = [];
  const progress: number[] = [];
  const context: DocumentExportContext = {
    jobId: 'job-1',
    signal,
    sandbox: driver,
    async log(message) {
      logs.push(message);
    },
    async setProgress(value) {
      progress.push(value);
    },
  };
  return { context, logs, progress };
}

function asset(id: string, data: Buffer, mime = 'image/png'): DocumentExportAsset {
  return { id, mime, size: data.length, storageKey: `org/x/artifacts/${id}` };
}

describe('request.json', () => {
  it('has only the assembled html, the normalized format and the registered MIME of each asset', () => {
    const body = JSON.parse(buildDocumentRequest({ html: HTML, exportFormat: FORMAT, assets: [asset(ID_A, Buffer.from('a')), asset(ID_B, Buffer.from('b'), 'image/webp')] }).toString('utf8'));
    expect(body).toEqual({ html: HTML, export_format: FORMAT, asset_types: { [ID_A]: 'image/png', [ID_B]: 'image/webp' } });
    expect(Object.keys(JSON.parse(buildDocumentRequest({ html: HTML, exportFormat: FORMAT, assets: [] }).toString('utf8')))).toEqual(['html', 'export_format']);
  });
});

describe('size check before creating a sandbox (7.4b)', () => {
  const request = Buffer.alloc(1_000);
  it('accepts inputs up to the template limits', () => {
    expect(() => checkDocumentInputSize(request, [{ size: LIMITS.maxTotalBytes - request.length }])).not.toThrow();
    expect(() => checkDocumentInputSize(request, Array.from({ length: LIMITS.maxFiles - 1 }, () => ({ size: 1 })))).not.toThrow();
  });

  it.each([
    ['images over 128 MiB in total', () => checkDocumentInputSize(request, [{ size: 100 * MIB }, { size: 28 * MIB - request.length + 1 }]), 'EXPORT_IMAGES_TOO_LARGE'],
    ['more than 2,000 images', () => checkDocumentInputSize(request, Array.from({ length: LIMITS.maxFiles }, () => ({ size: 1 }))), 'EXPORT_TOO_MANY_IMAGES'],
    ['a request.json larger than a single input file', () => checkDocumentInputSize(Buffer.alloc(LIMITS.maxFileBytes + 1), []), 'EXPORT_TOO_LARGE'],
  ])('rejects %s', (_name, check, code) => {
    let error: unknown;
    try {
      check();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code });
  });

  it('fails before creating a sandbox or reading any image', async () => {
    const { driver, calls } = fakeDriver();
    const store = fakeStore({});
    const big = { id: ID_A, mime: 'image/png', size: 100 * MIB, storageKey: 'a' };
    const big2 = { id: ID_B, mime: 'image/png', size: 30 * MIB, storageKey: 'b' };
    const error = await renderTechnicalPlanDocument(contextOf(driver).context, store, { html: HTML, exportFormat: FORMAT, assets: [big, big2] }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXPORT_IMAGES_TOO_LARGE', message: expect.stringContaining('128 MiB') });
    expect(calls).toEqual([]);
    expect(store.gets).toEqual([]);
  });
});

describe('renderTechnicalPlanDocument', () => {
  it('puts request.json and the images (read on demand) into a new export-document sandbox, runs export and destroys it', async () => {
    const png = Buffer.from('png bytes');
    const webp = Buffer.from('RIFF....WEBP');
    const store = fakeStore({ [`org/x/artifacts/${ID_A}`]: png, [`org/x/artifacts/${ID_B}`]: webp });
    const output = [{ path: 'document.docx', data: DOCX }, { path: 'result.json', data: resultJson([{ assetRef: ID_B, reason: '助手的原因' }]) }];
    const { driver, calls, copied } = fakeDriver({ output });
    const { context, progress } = contextOf(driver);
    const result = await renderTechnicalPlanDocument(context, store, { html: HTML, exportFormat: FORMAT, assets: [asset(ID_A, png), asset(ID_B, webp, 'image/webp')] });
    expect(calls).toEqual(['create:export-document:job-1', 'copyIn', 'exec:export:0', 'copyOut', 'destroy']);
    expect(copied().map((file) => file.path)).toEqual(['request.json', `assets/${ID_A}`, `assets/${ID_B}`]);
    expect(copied()[1]!.data.equals(png)).toBe(true);
    expect(copied()[2]!.data.equals(webp)).toBe(true);
    expect(JSON.parse(copied()[0]!.data.toString('utf8'))).toEqual({ html: HTML, export_format: FORMAT, asset_types: { [ID_A]: 'image/png', [ID_B]: 'image/webp' } });
    expect(store.gets).toEqual([`org/x/artifacts/${ID_A}`, `org/x/artifacts/${ID_B}`]);
    expect(result).toEqual({ docx: DOCX, blockCount: 12, imageWarnings: [ID_B] });
    expect(progress).toEqual([20, 80]);
  });

  it('maps an image deleted from the object store to EXPORT_IMAGE_UNAVAILABLE and destroys the sandbox', async () => {
    const { driver, calls } = fakeDriver();
    const error = await renderTechnicalPlanDocument(contextOf(driver).context, fakeStore({}), { html: HTML, exportFormat: FORMAT, assets: [asset(ID_A, Buffer.from('png'))] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: 'EXPORT_IMAGE_UNAVAILABLE', message: '部分配图已被删除或已变化，请重新导出' });
    expect(((error as JobError).cause as SandboxError).cause).toBeInstanceOf(ObjectInputError);
    expect(calls).toEqual(['create:export-document:job-1', 'copyIn', 'destroy']);
  });

  it('maps an object store failure while reading an image to EXPORT_UNAVAILABLE', async () => {
    const { driver, calls } = fakeDriver();
    const store = { async get(): Promise<StoredObject | null> { throw new Error('s3 down'); } };
    const error = await renderTechnicalPlanDocument(contextOf(driver).context, store, { html: HTML, exportFormat: FORMAT, assets: [asset(ID_A, Buffer.from('png'))] }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
    expect(calls.at(-1)).toBe('destroy');
  });

  it.each([
    ['bad_arguments', 'EXPORT_FAILED'],
    ['request_invalid', 'EXPORT_REQUEST_INVALID'],
    ['too_many_images', 'EXPORT_TOO_MANY_IMAGES'],
    ['chrome_render_failed', 'EXPORT_DECORATION_FAILED'],
    ['helper_failed', 'EXPORT_WORD_FAILED'],
    ['helper_timeout', 'EXPORT_TIMEOUT'],
    ['output_too_large', 'EXPORT_OUTPUT_TOO_LARGE'],
    ['export_failed', 'EXPORT_FAILED'],
  ])('entry error %s → %s, without the helper text, and destroys the sandbox', async (entryCode, jobCode) => {
    const { driver, calls } = fakeDriver({ exec: execResult(65, `日志\n${JSON.stringify({ error: entryCode })}\n`) });
    const error = await renderTechnicalPlanDocument(contextOf(driver).context, fakeStore({}), { html: HTML, exportFormat: FORMAT, assets: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: jobCode });
    expect((error as Error).message).not.toContain('助手');
    expect(calls.at(-1)).toBe('destroy');
  });

  it('timeout, rejected output and unknown codes', async () => {
    const run = async (options: FakeOptions) => renderTechnicalPlanDocument(contextOf(fakeDriver(options).driver).context, fakeStore({}), { html: HTML, exportFormat: FORMAT, assets: [] }).catch((caught: unknown) => caught);
    expect(await run({ exec: execResult(null, '', true) })).toMatchObject({ code: 'EXPORT_TIMEOUT' });
    expect(await run({ exec: execResult(65, '{"error":"made_up"}') })).toMatchObject({ code: 'EXPORT_FAILED' });
    expect(await run({ output: [{ path: 'document.docx', data: Buffer.from('not a zip') }, { path: 'result.json', data: resultJson() }] })).toMatchObject({ code: 'EXPORT_OUTPUT_REJECTED' });
    expect(await run({ output: [{ path: 'document.docx', data: DOCX }] })).toMatchObject({ code: 'EXPORT_OUTPUT_REJECTED' });
    expect(await run({ exec: () => { throw new SandboxError('SANDBOX_OUTPUT_REJECTED', 'x'); } })).toMatchObject({ code: 'EXPORT_OUTPUT_REJECTED' });
    expect(await run({ exec: () => { throw new SandboxError('SANDBOX_UNAVAILABLE', 'x'); } })).toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
    expect(await run({ exec: () => { throw new SandboxError('SANDBOX_FAILED', 'x'); } })).toMatchObject({ code: 'EXPORT_FAILED' });
    expect(await run({ exec: () => { throw new SandboxError('SANDBOX_ABORTED', 'x'); } })).toBeInstanceOf(JobInterruptedError);
  });

  it('retries creating while the sandbox count is at its limit, then fails with EXPORT_SANDBOX_BUSY', async () => {
    const busy = fakeDriver({ create: (attempt) => { if (attempt < 3) throw new SandboxError('SANDBOX_BUSY', 'busy'); } });
    const { context, logs } = contextOf(busy.driver);
    await renderTechnicalPlanDocument(context, fakeStore({}), { html: HTML, exportFormat: FORMAT, assets: [] }, { createRetryDelaysMs: [1, 1, 1] });
    expect(busy.calls.filter((call) => call.startsWith('create'))).toHaveLength(3);
    expect(logs.filter((line) => line.includes('上限'))).toHaveLength(2);

    const always = fakeDriver({ create: () => { throw new SandboxError('SANDBOX_BUSY', 'busy'); } });
    const error = await renderTechnicalPlanDocument(contextOf(always.driver).context, fakeStore({}), { html: HTML, exportFormat: FORMAT, assets: [] }, { createRetryDelaysMs: [1] }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXPORT_SANDBOX_BUSY' });
    expect(always.calls).toEqual(['create:export-document:job-1', 'create:export-document:job-1']);
  });

  it('without a sandbox driver: EXPORT_UNAVAILABLE', async () => {
    const error = await renderTechnicalPlanDocument(contextOf(null).context, fakeStore({}), { html: HTML, exportFormat: FORMAT, assets: [] }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
  });
});
