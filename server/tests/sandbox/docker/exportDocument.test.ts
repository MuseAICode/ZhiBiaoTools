// 技术方案整本 Word 在真实 export-document 沙箱中的生成（路线图 7.4g；src/export/document.ts）：7.4c 组装的整本 HTML 与
// 按需从对象存储读取的配图经真实的 Docker 驱动（CI 中为 gVisor）完成整个流程——新建沙箱、流式放入、执行登记的命令、
// 取回并校验输出、销毁沙箱。
// - PNG 与 WebP 配图都原样嵌入 docx（WebP 不经转换，助手按文件头识别、以 image/webp 图片部件嵌入，7.4g 核对）；
// - 没有放入的引用（不可见的产物）由助手原位提示，imageWarnings 中只有它；
// - 沙箱用完即被销毁；配图在放入时已被删除时失败并销毁沙箱。
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { renderTechnicalPlanDocument, type DocumentExportAsset, type DocumentExportContext } from '../../../src/export/document.ts';
import { assembleDocumentHtml } from '../../../src/export/documentHtml.ts';
import type { StoredObject } from '../../../src/files/objectStore.ts';
import type { SandboxDriver } from '../../../src/sandbox/driver.ts';
import { normalizeExportFormat } from '../../../src/templates/exportFormat.ts';
import { sandboxEnv } from './env.ts';
import { grayPng, readZipEntries } from './exportFixtures.ts';
import { createIsolationHarness } from './isolationSuite.ts';

const harness = createIsolationHarness('export-document', sandboxEnv.exportImage ?? '');
const WEBP = readFileSync(new URL('../../../../client/assets/content-template-preview/visual-wbs-mindmap.webp', import.meta.url));
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

function memoryStore(objects: Map<string, Buffer>) {
  return {
    async get(key: string): Promise<StoredObject | null> {
      const data = objects.get(key);
      return data ? { body: Readable.from([data]), size: data.length } : null;
    },
  };
}

const pngId = randomUUID();
const webpId = randomUUID();
const hiddenId = randomUUID();

function snapshot() {
  const content = [
    '整本正文的第一段。',
    `![PNG 配图](/api/artifacts/${pngId}/content)`,
    `![WebP 配图](/api/artifacts/${webpId}/content)`,
    `![不可见的配图](/api/artifacts/${hiddenId}/content)`,
  ].join('\n\n');
  return {
    projectName: '整本导出测试',
    exportTemplateScope: 'document' as const,
    outline: [
      { id: randomUUID(), title: '总体方案', description: '', number: '', content_mode: 'manual-fill' as const, content },
      { id: randomUUID(), title: 'AI 小节', description: '', number: '', content_mode: 'ai-generate' as const },
    ],
  };
}

describe.runIf(sandboxEnv.exportImage)('technical plan document in the export-document sandbox', () => {
  it('embeds the streamed PNG and WebP images unchanged, reports the image that was not put in, and destroys the sandbox', async () => {
    const document = assembleDocumentHtml(snapshot());
    expect(document.assetRefs).toEqual([pngId, webpId, hiddenId]);
    const objects = new Map([[`org/x/artifacts/${pngId}`, PNG], [`org/x/artifacts/${webpId}`, WEBP]]);
    const assets: DocumentExportAsset[] = [
      { id: pngId, mime: 'image/png', size: PNG.length, storageKey: `org/x/artifacts/${pngId}` },
      { id: webpId, mime: 'image/webp', size: WEBP.length, storageKey: `org/x/artifacts/${webpId}` },
    ];
    const { driver, created, destroyed } = trackingDriver();
    const started = Date.now();
    const output = await renderTechnicalPlanDocument(contextOf(driver), memoryStore(objects), { html: document.html, exportFormat: normalizeExportFormat({}), assets });
    const elapsedMs = Date.now() - started;
    expect(output.imageWarnings).toEqual([hiddenId]);
    const docx = readZipEntries(output.docx);
    const text = docx.get('word/document.xml')!.toString('utf8');
    expect(text).toContain('整本正文的第一段');
    expect(text).toContain('总体方案');
    // 图片部件的位置由 Open XML SDK 决定（不一定在 word/media/ 下），按扩展名与内容在全部条目中查找（同样张的测试）。
    const media = [...docx];
    expect(media.filter(([name]) => name.endsWith('.webp')).map(([, data]) => sha256(data))).toEqual([sha256(WEBP)]);
    expect(media.filter(([, data]) => sha256(data) === sha256(PNG))).toHaveLength(1);
    expect(docx.get('[Content_Types].xml')!.toString('utf8')).toContain('image/webp');
    expect(created).toHaveLength(1);
    expect(destroyed).toEqual(created);
    console.info(JSON.stringify({ runtime: sandboxEnv.runtime, template: 'export-document', job: 'technical-plan-export', elapsedMs }));
  }, 180_000);

  it('fails with EXPORT_IMAGE_UNAVAILABLE when an image is gone from the object store, and destroys the sandbox', async () => {
    const document = assembleDocumentHtml(snapshot());
    const assets: DocumentExportAsset[] = [
      { id: pngId, mime: 'image/png', size: PNG.length, storageKey: `org/x/artifacts/${pngId}` },
      { id: webpId, mime: 'image/webp', size: WEBP.length, storageKey: `org/x/artifacts/${webpId}` },
    ];
    const { driver, created, destroyed } = trackingDriver();
    const error = await renderTechnicalPlanDocument(contextOf(driver), memoryStore(new Map([[`org/x/artifacts/${pngId}`, PNG]])), {
      html: document.html,
      exportFormat: normalizeExportFormat({}),
      assets,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXPORT_IMAGE_UNAVAILABLE' });
    expect(created).toHaveLength(1);
    expect(destroyed).toEqual(created);
  }, 180_000);
});
