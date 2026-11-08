// 可研报告 Word 在 export-feasibility 沙箱中的生成流程（src/export/feasibility.ts，路线图 7.5b），用记录调用的假 SandboxDriver 验证：
// - request.json 只有桌面版 buildDocxResult 用到的四个字段（目录节点与导出选项也只保留已知字段）；
// - 新建沙箱之前按 export-feasibility 模板（与 export-document 相同）的输入规则拒绝；
// - 放入 request.json 与按需读取的配图（assets/<产物 id>），使用 export-feasibility 模板，不论成败都销毁沙箱；
// - 输出只能是 document.docx 与 { version: 1, warnings: [有界的纯文本] }，其他一律拒绝；消息与桌面版 export.word 相同。
// 失败代码的映射与整本导出共用（runExportSandbox，见 tests/export/document.test.ts）。真实沙箱见 tests/sandbox/docker/exportFeasibility.test.ts。
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { DocumentExportContext } from '../../src/export/document.ts';
import {
  buildFeasibilityRequest,
  feasibilityExportMessage,
  renderFeasibilityReportDocument,
  type FeasibilityExportInput,
} from '../../src/export/feasibility.ts';
import { validateFeasibilityExportOutput } from '../../src/export/output.ts';
import type { StoredObject } from '../../src/files/objectStore.ts';
import { JobError } from '../../src/jobs/definitions.ts';
import { createArchiveStream, readArchive, type SandboxFile, type SandboxInputFile } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxExecResult } from '../../src/sandbox/driver.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { normalizeExportFormat } from '../../src/templates/exportFormat.ts';
import { buildZip } from '../sandbox/zipFixtures.ts';

const MIB = 1024 * 1024;
const LIMITS = SANDBOX_TEMPLATES['export-feasibility'].input;
const DOCX = buildZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
]);
const ID_A = '0b6f1f8e-3c1a-4d0e-9a51-0e2f7f9d1a01';
const FORMAT = normalizeExportFormat({ template_name: '可研' });

function input(extra: Partial<FeasibilityExportInput> = {}): FeasibilityExportInput {
  return {
    projectName: '示例产业园可行性研究报告',
    outline: [{ id: 'c1', title: '总论', description: '', children: [{ id: 'c1-1', title: '概况', description: '说明', content: `正文\n\n![图](/api/artifacts/${ID_A}/content)` }] }],
    exportFormat: FORMAT,
    options: {
      includeCover: true, includePreparationNotes: true, includeAppendixTables: false,
      preparationUnit: '编制中心', securityLevel: '内部资料', documentCode: 'KYBG-123456',
      projectInfo: { projectName: '示例产业园', constructionUnit: '示例公司' },
    },
    assets: [],
    ...extra,
  };
}

const resultJson = (value: unknown) => Buffer.from(JSON.stringify(value));

function execResult(exitCode: number | null, stdout = ''): SandboxExecResult {
  return { exitCode, timedOut: false, stdout, stderr: '桌面版代码的输出', stdoutTruncated: false, stderrTruncated: false };
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

function fakeDriver(options: { exec?: SandboxExecResult; output?: SandboxFile[] } = {}) {
  const calls: string[] = [];
  let copied: SandboxFile[] = [];
  const driver: SandboxDriver = {
    async create(templateName, { jobId }) {
      calls.push(`create:${templateName}:${jobId}`);
      return { id: 'sbx', template: templateName, jobId, expiresAt: new Date(Date.now() + 60_000) };
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
      return options.exec ?? execResult(0);
    },
    async copyOut() {
      calls.push('copyOut');
      return options.output ?? [{ path: 'document.docx', data: DOCX }, { path: 'result.json', data: resultJson({ version: 1, warnings: [] }) }];
    },
    async destroy() {
      calls.push('destroy');
    },
  };
  return { driver, calls, copied: () => copied };
}

function contextOf(driver: SandboxDriver | null): DocumentExportContext {
  return { jobId: 'job-1', signal: new AbortController().signal, sandbox: driver, log: async () => {}, setProgress: async () => {} };
}

describe('request.json', () => {
  it('has only the four fields used by buildDocxResult, with the known outline and option fields', () => {
    const outline = [{ id: 'a', title: 't', description: 'd', content: 'c', children: [], knowledge_item_ids: ['k'], number: '1' }] as never;
    const options = { ...input().options, baseDir: '/etc', extra: true } as never;
    const body = JSON.parse(buildFeasibilityRequest(input({ outline, options })).toString('utf8'));
    expect(Object.keys(body).sort()).toEqual(['export_format', 'feasibility_options', 'outline', 'project_name']);
    expect(body.outline).toEqual([{ id: 'a', title: 't', description: 'd', content: 'c' }]);
    expect(body.feasibility_options).toEqual({
      includeCover: true, includePreparationNotes: true, includeAppendixTables: false,
      preparationUnit: '编制中心', securityLevel: '内部资料', documentCode: 'KYBG-123456',
      project_info: { projectName: '示例产业园', constructionUnit: '示例公司' },
    });
    expect(body.export_format).toEqual(FORMAT);
  });
});

describe('renderFeasibilityReportDocument', () => {
  it('puts request.json and the images into a new export-feasibility sandbox, runs export and destroys it', async () => {
    const png = Buffer.from('png bytes');
    const store = fakeStore({ [`org/x/artifacts/${ID_A}`]: png });
    const warnings = ['图片无法导出：本机，未找到可用图片数据'];
    const { driver, calls, copied } = fakeDriver({ output: [{ path: 'document.docx', data: DOCX }, { path: 'result.json', data: resultJson({ version: 1, warnings }) }] });
    const result = await renderFeasibilityReportDocument(contextOf(driver), store, input({ assets: [{ id: ID_A, mime: 'image/png', size: png.length, storageKey: `org/x/artifacts/${ID_A}` }] }));
    expect(calls).toEqual(['create:export-feasibility:job-1', 'copyIn', 'exec:export:0', 'copyOut', 'destroy']);
    expect(copied().map((file) => file.path)).toEqual(['request.json', `assets/${ID_A}`]);
    expect(copied()[1]!.data.equals(png)).toBe(true);
    expect(result).toEqual({ docx: DOCX, warnings, message: 'Word 已导出，但有 1 处图片未能插入，请打开文档核对。' });
    expect(feasibilityExportMessage([])).toBe('Word 已导出，请打开文档核对图片、表格和版式。');
  });

  it('rejects inputs over the template limits before creating a sandbox or reading any image', async () => {
    const { driver, calls } = fakeDriver();
    const store = fakeStore({});
    const assets = [{ id: ID_A, mime: 'image/png', size: LIMITS.maxTotalBytes, storageKey: 'a' }];
    const error = await renderFeasibilityReportDocument(contextOf(driver), store, input({ assets })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: 'EXPORT_IMAGES_TOO_LARGE', message: expect.stringContaining('128 MiB') });
    const many = Array.from({ length: LIMITS.maxFiles }, (_item, index) => ({ id: `${index}`, mime: 'image/png', size: 1, storageKey: `${index}` }));
    expect(await renderFeasibilityReportDocument(contextOf(driver), store, input({ assets: many })).catch((caught: unknown) => caught)).toMatchObject({ code: 'EXPORT_TOO_MANY_IMAGES' });
    expect(calls).toEqual([]);
    expect(store.gets).toEqual([]);
    expect(LIMITS).toEqual(SANDBOX_TEMPLATES['export-document'].input);
    expect(LIMITS.maxTotalBytes).toBe(128 * MIB);
  });

  it('maps entry errors like the whole-document export and never uses the sandbox text', async () => {
    const { driver, calls } = fakeDriver({ exec: execResult(65, `日志\n${JSON.stringify({ error: 'helper_failed' })}\n`) });
    const error = await renderFeasibilityReportDocument(contextOf(driver), fakeStore({}), input()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXPORT_WORD_FAILED' });
    expect((error as Error).message).not.toContain('桌面版');
    expect(calls.at(-1)).toBe('destroy');
  });

  it('rejects output that is not document.docx plus a well-formed result.json', async () => {
    const run = async (result: unknown, docx: Buffer = DOCX) => {
      const output = [{ path: 'document.docx', data: docx }, { path: 'result.json', data: Buffer.isBuffer(result) ? result : resultJson(result) }];
      return renderFeasibilityReportDocument(contextOf(fakeDriver({ output }).driver), fakeStore({}), input()).catch((caught: unknown) => caught);
    };
    for (const bad of [
      { version: 1, blockCount: 1, imageWarnings: [] },
      { version: 2, warnings: [] },
      { version: 1, warnings: [], message: '沙箱给的消息' },
      { version: 1, warnings: 'x' },
      { version: 1, warnings: [1] },
      { version: 1, warnings: ['a\nb'] },
      { version: 1, warnings: ['x'.repeat(401)] },
      { version: 1, warnings: Array.from({ length: 2_001 }, () => 'w') },
      Buffer.from([0xff, 0xfe]),
    ]) {
      expect(await run(bad), JSON.stringify(bad)).toMatchObject({ code: 'EXPORT_OUTPUT_REJECTED' });
    }
    expect(await run({ version: 1, warnings: [] }, Buffer.from('not a zip'))).toMatchObject({ code: 'EXPORT_OUTPUT_REJECTED' });
    expect(await run({ version: 1, warnings: ['图'.repeat(400)] })).toMatchObject({ warnings: ['图'.repeat(400)] });
    await expect(validateFeasibilityExportOutput([{ path: 'document.docx', data: DOCX }])).rejects.toThrow('output must contain only');
  });

  it('without a sandbox driver: EXPORT_UNAVAILABLE', async () => {
    expect(await renderFeasibilityReportDocument(contextOf(null), fakeStore({}), input()).catch((caught: unknown) => caught)).toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
  });
});
