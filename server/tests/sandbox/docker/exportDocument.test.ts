// 技术方案整本 Word 在真实 export-document 沙箱中的生成（路线图 7.4g、7.4i；src/export/document.ts、server/sandbox/export/entry.mjs）：
// 7.4c 组装的整本 HTML 与按需从对象存储读取的配图经真实的 Docker 驱动（CI 中为 gVisor）完成整个流程——新建沙箱、流式放入、
// 执行登记的命令、取回并校验输出、销毁沙箱。
// - PNG 配图原样嵌入；没有放入的引用（不可见的产物）由助手原位提示，imageWarnings 中只有它；
// - WebP 配图（7.4i，与桌面版一致）转成 PNG 后嵌入，docx 中没有任何 WebP 部件：无损带透明、有损带透明、有损不透明、
//   动图（只取第一帧，帧外透明）的尺寸、颜色与透明度逐项核对；转换失败的（内容损坏）由助手原位提示；
// - 转换后的大小重新计入输入合计（128 MiB）与 docx 上限（100 MiB）：转换之前都在上限内、转换之后超出时以对应的代码失败；
// - 沙箱用完即被销毁；配图在放入时已被删除时失败并销毁沙箱。
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { renderTechnicalPlanDocument, type DocumentExportAsset, type DocumentExportContext } from '../../../src/export/document.ts';
import { assembleDocumentHtml } from '../../../src/export/documentHtml.ts';
import type { StoredObject } from '../../../src/files/objectStore.ts';
import type { SandboxDriver } from '../../../src/sandbox/driver.ts';
import { SANDBOX_TEMPLATES } from '../../../src/sandbox/templates.ts';
import { normalizeExportFormat } from '../../../src/templates/exportFormat.ts';
import { sandboxEnv } from './env.ts';
import { decodePng, grayPng, noisePng, readZipEntries } from './exportFixtures.ts';
import { createIsolationHarness } from './isolationSuite.ts';

const harness = createIsolationHarness('export-document', sandboxEnv.exportImage ?? '');
const MIB = 1024 * 1024;
const sample = (name: string) => readFileSync(new URL(`../samples/webp/${name}.webp`, import.meta.url));
const PNG = grayPng(64, 48);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

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

function image(data: Buffer, mime: string): Image {
  return { id: randomUUID(), data, mime };
}

/** 一个手写小节依次引用 images（每张一次），外加 hidden 中的不可见引用；返回组装结果与可见配图的对象存储。 */
function documentOf(images: readonly Image[], hidden: readonly string[] = []) {
  const content = ['整本正文的第一段。', ...[...images.map((item) => item.id), ...hidden].map((id, index) => `![配图 ${index}](/api/artifacts/${id}/content)`)].join('\n\n');
  const document = assembleDocumentHtml({
    projectName: '整本导出测试',
    exportTemplateScope: 'document',
    outline: [
      { id: randomUUID(), title: '总体方案', description: '', number: '', content_mode: 'manual-fill', content },
      { id: randomUUID(), title: 'AI 小节', description: '', number: '', content_mode: 'ai-generate' },
    ],
  });
  const objects = new Map(images.map((item) => [`org/x/artifacts/${item.id}`, item.data]));
  const store = {
    async get(key: string): Promise<StoredObject | null> {
      const data = objects.get(key);
      return data ? { body: Readable.from([data]), size: data.length } : null;
    },
  };
  const assets: DocumentExportAsset[] = images.map((item) => ({ id: item.id, mime: item.mime, size: item.data.length, storageKey: `org/x/artifacts/${item.id}` }));
  return { document, store, objects, assets };
}

async function exportImages(images: readonly Image[], hidden: readonly string[] = []) {
  const { document, store, assets } = documentOf(images, hidden);
  const { driver, created, destroyed } = trackingDriver();
  const started = Date.now();
  const result = await renderTechnicalPlanDocument(contextOf(driver), store, { html: document.html, exportFormat: normalizeExportFormat({}), assets })
    .then((output) => ({ output, error: null }), (error: unknown) => ({ output: null, error }));
  return { ...result, created, destroyed, elapsedMs: Date.now() - started };
}

/** docx 中按文档顺序引用的图片部件（document.xml 中 r:embed 的顺序）。 */
function embeddedImages(docx: Map<string, Buffer>): Array<{ name: string; data: Buffer }> {
  const rels = docx.get('word/_rels/document.xml.rels')!.toString('utf8');
  const targets = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="([^"]+)"/g)].map((match) => [match[1] ?? match[4]!, match[2] ?? match[3]!]));
  const xml = docx.get('word/document.xml')!.toString('utf8');
  return [...xml.matchAll(/r:embed="([^"]+)"/g)].map((match) => {
    const target = targets.get(match[1]!)!;
    const name = target.startsWith('/') ? target.slice(1) : `word/${target}`;
    return { name, data: docx.get(name)! };
  });
}

describe.runIf(sandboxEnv.exportImage)('technical plan document in the export-document sandbox', () => {
  it('embeds the streamed PNG unchanged, reports the image that was not put in, and destroys the sandbox', async () => {
    const hidden = randomUUID();
    const run = await exportImages([image(PNG, 'image/png')], [hidden]);
    expect(run.error).toBeNull();
    expect(run.output!.imageWarnings).toEqual([hidden]);
    const docx = readZipEntries(run.output!.docx);
    const text = docx.get('word/document.xml')!.toString('utf8');
    expect(text).toContain('整本正文的第一段');
    expect(text).toContain('总体方案');
    expect(embeddedImages(docx).map((item) => sha256(item.data))).toEqual([sha256(PNG)]);
    expect(run.created).toHaveLength(1);
    expect(run.destroyed).toEqual(run.created);
    console.info(JSON.stringify({ runtime: sandboxEnv.runtime, template: 'export-document', job: 'technical-plan-export', elapsedMs: run.elapsedMs }));
  }, 180_000);

  // 7.4i：样本左半为不透明的纯色、右半全透明（opaque-lossy 整幅不透明）；动图第一帧左半红色、之后整幅蓝色和绿色。
  it('converts every WebP (lossless and lossy, with alpha, opaque, animated) to a PNG with the same pixels; no WebP part remains', async () => {
    const cases = [
      { name: 'lossless-alpha', left: [255, 0, 0], rightAlpha: 0 },
      { name: 'lossy-alpha', left: [0, 128, 255], rightAlpha: 0 },
      { name: 'opaque-lossy', left: [0, 160, 0], rightAlpha: 255 },
      { name: 'animated', left: [255, 0, 0], rightAlpha: 0 },
    ] as const;
    const images = cases.map((item) => image(sample(item.name), 'image/webp'));
    const run = await exportImages(images);
    expect(run.error).toBeNull();
    expect(run.output!.imageWarnings).toEqual([]);
    const docx = readZipEntries(run.output!.docx);
    expect([...docx.keys()].filter((name) => name.toLowerCase().endsWith('.webp'))).toEqual([]);
    expect(docx.get('[Content_Types].xml')!.toString('utf8')).not.toContain('image/webp');
    const embedded = embeddedImages(docx);
    expect(embedded).toHaveLength(cases.length);
    cases.forEach((item, index) => {
      const part = embedded[index]!;
      expect(part.name, item.name).toMatch(/\.png$/);
      const png = decodePng(part.data);
      expect([png.width, png.height], item.name).toEqual([64, 48]);
      // 左半：颜色（有损编码允许小的误差）、不透明。
      for (const [x, y] of [[4, 4], [16, 24], [28, 44]] as const) {
        const [r, g, b] = png.pixel(x, y);
        expect(Math.abs(r - item.left[0]) + Math.abs(g - item.left[1]) + Math.abs(b - item.left[2]), `${item.name} (${x},${y})`).toBeLessThanOrEqual(24);
        expect(png.alpha(x, y), `${item.name} (${x},${y})`).toBe(255);
      }
      // 右半：透明的仍然透明（动图帧外也是透明，不是后续帧的蓝色或绿色）；不透明的仍然不透明。
      for (const [x, y] of [[40, 4], [60, 44]] as const) expect(png.alpha(x, y), `${item.name} (${x},${y})`).toBe(item.rightAlpha);
    });
    expect(run.destroyed).toEqual(run.created);
    console.info(JSON.stringify({ runtime: sandboxEnv.runtime, template: 'export-document', webpConversions: cases.length, elapsedMs: run.elapsedMs }));
  }, 180_000);

  it('reports a WebP whose bitstream is corrupt in place (conversion failed), and still exports the rest', async () => {
    const corrupt = Buffer.from(sample('opaque-lossy'));
    corrupt.fill(0xab, 30);
    const good = image(sample('lossless-alpha'), 'image/webp');
    const broken = image(corrupt, 'image/webp');
    const run = await exportImages([good, broken]);
    expect(run.error).toBeNull();
    expect(run.output!.imageWarnings).toEqual([broken.id]);
    const docx = readZipEntries(run.output!.docx);
    expect(embeddedImages(docx).map((item) => item.name)).toEqual([expect.stringMatching(/\.png$/)]);
    expect(docx.get('word/document.xml')!.toString('utf8')).toContain('图片无法导出');
  }, 180_000);

  it('counts the converted size against the 128 MiB input total: fails with EXPORT_IMAGES_TOO_LARGE when it grows past it', async () => {
    const padding = [image(noisePng(60 * MIB), 'image/png'), image(noisePng(60 * MIB), 'image/png')];
    const noise = Array.from({ length: 4 }, () => image(sample('noise'), 'image/webp'));
    const before = [...padding, ...noise].reduce((sum, item) => sum + item.data.length, 0);
    expect(before).toBeLessThan(SANDBOX_TEMPLATES['export-document'].input.maxTotalBytes - MIB);
    const run = await exportImages([...padding, ...noise]);
    expect(run.error).toMatchObject({ code: 'EXPORT_IMAGES_TOO_LARGE', message: expect.stringContaining('WebP 配图转为 PNG 后') });
    expect(run.destroyed).toEqual(run.created);
  }, 300_000);

  it('counts the converted size against the 100 MiB docx limit: fails with EXPORT_OUTPUT_TOO_LARGE when it grows past it', async () => {
    const padding = image(noisePng(95 * MIB), 'image/png');
    const noise = Array.from({ length: 4 }, () => image(sample('noise'), 'image/webp'));
    // 不转换时 docx 约 96 MiB，在上限之内；转换之后超过 100 MiB。
    expect(padding.data.length + noise.reduce((sum, item) => sum + item.data.length, 0)).toBeLessThan(97 * MIB);
    const run = await exportImages([padding, ...noise]);
    expect(run.error).toMatchObject({ code: 'EXPORT_OUTPUT_TOO_LARGE', message: expect.stringContaining('WebP') });
    expect(run.destroyed).toEqual(run.created);
  }, 300_000);

  it('fails with EXPORT_IMAGE_UNAVAILABLE when an image is gone from the object store, and destroys the sandbox', async () => {
    const first = image(PNG, 'image/png');
    const second = image(sample('lossless-alpha'), 'image/webp');
    const { document, store, objects, assets } = documentOf([first, second]);
    objects.delete(`org/x/artifacts/${second.id}`);
    const { driver, created, destroyed } = trackingDriver();
    const error = await renderTechnicalPlanDocument(contextOf(driver), store, { html: document.html, exportFormat: normalizeExportFormat({}), assets }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXPORT_IMAGE_UNAVAILABLE' });
    expect(created).toHaveLength(1);
    expect(destroyed).toEqual(created);
  }, 180_000);
});
