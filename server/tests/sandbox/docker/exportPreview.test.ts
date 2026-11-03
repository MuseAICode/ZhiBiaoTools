// 模板样张在真实 export-preview 沙箱中的生成（路线图 7.3b；src/export/preview.ts）：worker 端的 renderTemplatePreview 经
// 真实的 Docker 驱动（CI 中为 gVisor）完成整个流程——校验与规范化、新建沙箱、只放 request.json、执行登记的命令、取回并校验输出、销毁沙箱。
// - 桌面版的样张（正文模板换上打包后的图片地址，与前端 DOCUMENT_DISPLAY_TEMPLATE_HTML 相同）在每个系统模板下都能生成，
//   5 张固定样张配图都取自镜像、原样嵌入，没有配图告警；
// - 结果通过 worker 端的输出校验（ZIP 结构检查），正文中有样张的文字；
// - 沙箱用完即被销毁；不合法的样张不创建沙箱。
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderTemplatePreview, type PreviewContext } from '../../../src/export/preview.ts';
import { JobError } from '../../../src/jobs/definitions.ts';
import type { SandboxDriver } from '../../../src/sandbox/driver.ts';
import { SANDBOX_CONTAINER_PREFIX } from '../../../src/sandbox/templates.ts';
import { SYSTEM_EXPORT_TEMPLATES } from '../../../src/templates/systemTemplates.ts';
import { docker, sandboxEnv } from './env.ts';
import { readZipEntries } from './exportFixtures.ts';
import { createIsolationHarness } from './isolationSuite.ts';

const harness = createIsolationHarness('export-preview', sandboxEnv.exportImage ?? '');
const template = readFileSync(new URL('../../../../client/electron/resources/content-generation/正文模板.html', import.meta.url), 'utf8');
const previewAssetDirectory = new URL('../../../../client/assets/content-template-preview/', import.meta.url);
/** 前端样张：src 换成 Vite 打包后的地址（服务端不转发 src）。 */
const SAMPLE = template.replace(/src="assets\/([a-z-]+)\.webp"/g, (_match, name: string) => `src="/assets/${name}-Bx7Kq2Lm.webp"`);

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** 记录创建与销毁的驱动包装：确认每个沙箱都被销毁。 */
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

function contextOf(driver: SandboxDriver): PreviewContext {
  return { jobId: randomUUID(), signal: new AbortController().signal, sandbox: driver, log: async () => {} };
}

describe.runIf(sandboxEnv.exportImage)('template preview in the export-preview sandbox', () => {
  it.each(SYSTEM_EXPORT_TEMPLATES.map((item) => [item.key, item.config] as const))(
    'renders the desktop sample with system template %s, embedding the 5 built-in sample images',
    async (key, config) => {
      const { driver, created, destroyed } = trackingDriver();
      const started = Date.now();
      const output = await renderTemplatePreview(contextOf(driver), { html: SAMPLE, exportFormat: config });
      const elapsedMs = Date.now() - started;
      expect(output.imageWarnings).toEqual([]);
      expect(output.blockCount).toBeGreaterThan(10);
      const docx = readZipEntries(output.docx);
      const text = docx.get('word/document.xml')!.toString('utf8');
      // 正文模板中的文字出现在 Word 正文中。
      expect(text).toContain('项目实施总体方案');
      const embedded = [...docx].filter(([name]) => name.endsWith('.webp')).map(([, data]) => sha256(data)).sort();
      const expected = readdirSync(previewAssetDirectory).filter((name) => name.endsWith('.webp')).map((name) => sha256(readFileSync(new URL(name, previewAssetDirectory)))).sort();
      expect(expected).toHaveLength(5);
      expect(embedded).toEqual(expected);
      expect(created).toHaveLength(1);
      expect(destroyed).toEqual(created);
      console.info(JSON.stringify({ runtime: sandboxEnv.runtime, preview: key, elapsedMs }));
    },
  );

  it('destroys the sandbox when the entry fails, and reports only the code', async () => {
    const { driver, created, destroyed } = trackingDriver();
    // 在放入时多放一张配图（样张不接受 worker 放入的配图）：真实的入口拒绝请求，返回 request_invalid。
    const failing: SandboxDriver = { ...driver, copyIn: (ref, files, options) => driver.copyIn(ref, [...files, { path: 'assets/extra.png', data: Buffer.from('x') }], options) };
    const error = await renderTemplatePreview(contextOf(failing), { html: SAMPLE, exportFormat: {} }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('EXPORT_REQUEST_INVALID');
    expect(created).toHaveLength(1);
    expect(destroyed).toEqual(created);
    expect(await docker.inspectContainer(`${SANDBOX_CONTAINER_PREFIX}${created[0]!}`)).toBeNull();
  });

  it('rejects an invalid sample before creating any sandbox', async () => {
    const { driver, created } = trackingDriver();
    const error = await renderTemplatePreview(contextOf(driver), { html: `${SAMPLE}<script>alert(1)</script>`, exportFormat: {} }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('PREVIEW_HTML_INVALID');
    expect(created).toEqual([]);
  });
});
