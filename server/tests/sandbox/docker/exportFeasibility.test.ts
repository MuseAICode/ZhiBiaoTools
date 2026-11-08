// 可研报告 Word 在真实 export-feasibility 沙箱中的生成（路线图 7.5b；src/export/feasibility.ts、server/sandbox/export/feasibility.mjs）：
// 桌面版同一份的 exportService.buildDocxResult 在断网沙箱中运行（CI 中为 gVisor），经真实的 Docker 驱动完成整个流程——新建沙箱、
// 流式放入配图、执行登记的命令、取回并校验输出、销毁沙箱。
// - 封面、编制说明、附表与正文都在；装饰 PNG 在页眉页脚中；
// - 本项目产物（PNG、WebP、动图）与正文中的 data URL WebP 都以 PNG 嵌入，docx 中没有任何 WebP 部件；
// - 没有放入的产物、app-asset://、http(s)、本机路径一律读不到，按桌面版的文字在原位提示；内容损坏的 WebP 提示“WebP 图片转换失败”；
// - 正文中的原始 HTML 只转换成 Word 元素：<script> 与事件属性的内容不进入文档；
// - 请求不合法时以 EXPORT_REQUEST_INVALID 失败，沙箱同样被销毁。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { DocumentExportAsset, DocumentExportContext } from '../../../src/export/document.ts';
import { renderFeasibilityReportDocument, type FeasibilityExportInput } from '../../../src/export/feasibility.ts';
import type { StoredObject } from '../../../src/files/objectStore.ts';
import type { SandboxDriver } from '../../../src/sandbox/driver.ts';
import { normalizeExportFormat } from '../../../src/templates/exportFormat.ts';
import { sandboxEnv } from './env.ts';
import { decodePng, grayPng, readZipEntries } from './exportFixtures.ts';
import { createIsolationHarness } from './isolationSuite.ts';

const harness = createIsolationHarness('export-feasibility', sandboxEnv.exportImage ?? '');
const sample = (name: string) => readFileSync(new URL(`../samples/webp/${name}.webp`, import.meta.url));
const PNG = grayPng(64, 48);

function trackingDriver() {
  const created: string[] = [];
  const destroyed: string[] = [];
  const driver: SandboxDriver = {
    async create(name, options) {
      const ref = await harness.driver.create(name, options);
      created.push(ref.id);
      return ref;
    },
    copyIn: (ref, files, options) => harness.driver.copyIn(ref, files, options),
    exec: (ref, command, args, options) => harness.driver.exec(ref, command, args, options),
    copyOut: (ref, options) => harness.driver.copyOut(ref, options),
    async destroy(ref) {
      destroyed.push(ref.id);
      await harness.driver.destroy(ref);
    },
  };
  return { driver, created, destroyed };
}

function contextOf(driver: SandboxDriver): DocumentExportContext {
  return { jobId: randomUUID(), signal: new AbortController().signal, sandbox: driver, log: async () => {}, setProgress: async () => {} };
}

interface Image {
  id: string;
  data: Buffer;
  mime: string;
}

const image = (data: Buffer, mime: string): Image => ({ id: randomUUID(), data, mime });

function inputOf(images: readonly Image[], content: string, overrides: Partial<FeasibilityExportInput> = {}) {
  const objects = new Map(images.map((item) => [`org/x/artifacts/${item.id}`, item.data]));
  const store = {
    async get(key: string): Promise<StoredObject | null> {
      const data = objects.get(key);
      return data ? { body: Readable.from([data]), size: data.length } : null;
    },
  };
  const assets: DocumentExportAsset[] = images.map((item) => ({ id: item.id, mime: item.mime, size: item.data.length, storageKey: `org/x/artifacts/${item.id}` }));
  const input: FeasibilityExportInput = {
    projectName: '示例产业园可行性研究报告',
    outline: [
      { id: 'c1', title: '总论', description: '', children: [{ id: 'c1-1', title: '项目概况', description: '', content }] },
      { id: 'c2', title: '建设条件', description: '', content: '建设条件的正文。' },
    ],
    exportFormat: normalizeExportFormat({ page: { header_footer_style: 'band', header_enabled: true, header_text: '可研页眉', footer_enabled: true, footer_text: '可研页脚' } }),
    options: {
      includeCover: true, includePreparationNotes: true, includeAppendixTables: true,
      preparationUnit: '编制中心', securityLevel: '内部资料', documentCode: 'KYBG-123456',
      projectInfo: { projectName: '示例产业园', constructionUnit: '示例公司', location: '某市', totalInvestment: '1000' },
    },
    assets,
    ...overrides,
  };
  return { input, store };
}

async function exportOf(images: readonly Image[], content: string, overrides: Partial<FeasibilityExportInput> = {}) {
  const { input, store } = inputOf(images, content, overrides);
  const { driver, created, destroyed } = trackingDriver();
  const started = Date.now();
  const result = await renderFeasibilityReportDocument(contextOf(driver), store, input)
    .then((output) => ({ output, error: null }), (error: unknown) => ({ output: null, error }));
  return { ...result, created, destroyed, elapsedMs: Date.now() - started };
}

/** 某个部件按顺序引用的图片部件。 */
function embeddedImages(docx: Map<string, Buffer>, part: string): Array<{ name: string; data: Buffer }> {
  const relsName = part.replace(/^word\//, 'word/_rels/') + '.rels';
  const rels = docx.get(relsName)?.toString('utf8') ?? '';
  const targets = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="([^"]+)"/g)].map((match) => [match[1] ?? match[4]!, match[2] ?? match[3]!]));
  const xml = docx.get(part)!.toString('utf8');
  return [...xml.matchAll(/r:embed="([^"]+)"/g)].map((match) => {
    const target = targets.get(match[1]!)!;
    const name = target.startsWith('/') ? target.slice(1) : `word/${target}`;
    return { name, data: docx.get(name)! };
  });
}

describe.runIf(sandboxEnv.exportImage)('feasibility report in the export-feasibility sandbox', () => {
  it('runs the desktop export code: cover, notes, appendix, decorations, every image as PNG, other sources reported in place', async () => {
    const png = image(PNG, 'image/png');
    const webp = image(sample('lossy-alpha'), 'image/webp');
    const animated = image(sample('animated'), 'image/webp');
    const hidden = randomUUID();
    const inline = `data:image/webp;base64,${sample('opaque-lossy').toString('base64')}`;
    const content = [
      '可研正文的第一段。',
      `![产物PNG](/api/artifacts/${png.id}/content)`,
      `![产物WebP](/api/artifacts/${webp.id}/content)`,
      `![产物动图](/api/artifacts/${animated.id.toUpperCase()}/content)`,
      `![内嵌WebP](${inline})`,
      `![不可见](/api/artifacts/${hidden}/content)`,
      '![本机](app-asset://imported-images/a.png)',
      '![远程](https://example.com/a.png)',
      '![路径](/etc/passwd)',
      '<p onclick="window.pwnedClick=1">原始 <strong>HTML</strong> 段落</p><script>document.title="pwned-script"</script>',
    ].join('\n\n');
    const run = await exportOf([png, webp, animated], content);
    expect(run.error).toBeNull();
    expect(run.output!.warnings).toEqual([
      '图片无法导出：不可见，未找到可用图片数据',
      '图片无法导出：本机，未找到可用图片数据',
      '图片无法导出：远程，未找到可用图片数据',
      '图片无法导出：路径，未找到可用图片数据',
    ]);
    expect(run.output!.message).toBe('Word 已导出，但有 4 处图片未能插入，请打开文档核对。');

    const docx = readZipEntries(run.output!.docx);
    const text = docx.get('word/document.xml')!.toString('utf8');
    for (const expected of ['可行性研究报告', 'KYBG-123456', '编制中心', '可研正文的第一段', '原始 ', '建设条件的正文']) expect(text, expected).toContain(expected);
    for (const forbidden of ['pwned', 'onclick']) expect(text, forbidden).not.toContain(forbidden);
    expect([...docx.keys()].filter((name) => name.toLowerCase().endsWith('.webp'))).toEqual([]);
    expect(docx.get('[Content_Types].xml')!.toString('utf8')).not.toContain('image/webp');

    const body = embeddedImages(docx, 'word/document.xml');
    expect(body).toHaveLength(4);
    for (const part of body) expect(part.name).toMatch(/\.png$/);
    expect(body[0]!.data.equals(PNG)).toBe(true);
    for (const [index, size] of [[1, [64, 48]], [2, [64, 48]], [3, [64, 48]]] as const) {
      const decoded = decodePng(body[index]!.data);
      expect([decoded.width, decoded.height], `image ${index}`).toEqual(size);
    }
    // 动图只取第一帧：帧外透明（不是后续帧的颜色）。
    expect(decodePng(body[2]!.data).alpha(60, 44)).toBe(0);

    const headers = [...docx.keys()].filter((name) => /^word\/header\d+\.xml$/.test(name));
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.flatMap((name) => embeddedImages(docx, name)).length).toBeGreaterThan(0);
    expect(run.created).toHaveLength(1);
    expect(run.destroyed).toEqual(run.created);
    console.info(JSON.stringify({ runtime: sandboxEnv.runtime, template: 'export-feasibility', elapsedMs: run.elapsedMs }));
  }, 180_000);

  it('reports a corrupt WebP like the desktop code (conversion failed) and still exports the rest', async () => {
    const corrupt = Buffer.from(sample('opaque-lossy'));
    corrupt.fill(0xab, 30);
    const bad = image(corrupt, 'image/webp');
    const good = image(PNG, 'image/png');
    const run = await exportOf([bad, good], `![坏图](/api/artifacts/${bad.id}/content)\n\n![好图](/api/artifacts/${good.id}/content)`);
    expect(run.error).toBeNull();
    expect(run.output!.warnings).toEqual(['图片无法导出：坏图，WebP 图片转换失败']);
    expect(embeddedImages(readZipEntries(run.output!.docx), 'word/document.xml')).toHaveLength(1);
    expect(run.destroyed).toEqual(run.created);
  }, 180_000);

  it('fails with EXPORT_REQUEST_INVALID for an empty outline and destroys the sandbox', async () => {
    const run = await exportOf([], '', { outline: [] });
    expect(run.error).toMatchObject({ code: 'EXPORT_REQUEST_INVALID' });
    expect(run.created).toHaveLength(1);
    expect(run.destroyed).toEqual(run.created);
  }, 180_000);
});
