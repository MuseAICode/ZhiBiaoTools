// render-layout 沙箱（路线图第 8 步 8.8c）：按 render-layout 模板创建真实的沙箱（CI 中为 gVisor），经 worker 一侧的 renderWordLayout
// （src/render/wordLayout.ts）与模板写死的生产命令测量，结果按不可信输入校验。docx 一律按不可信输入处理：
// - 镜像：专用镜像中只有打好的页面脚本（含补丁）、入口与 playwright-core，没有 esbuild、docx-editor 的 node_modules 与其他镜像的代码；
//   字体映射与 export 镜像同一份，模板常用的中文字体名映射到 Noto CJK；
// - 测量：单栏与两栏的自检文档都能测量，结果交给桌面版的 analyzeLayout 找到图片前的留白；只交出 layout.json，其中没有字体、样式属性与
//   其他书签；
// - 样本：
//   A. 不是 docx 的 ZIP、ZIP 炸弹、40 层嵌套的表格、200 万字的段落：docx-editor 拒绝打开（RENDER_LAYOUT_DOCUMENT_INVALID），输出为空；
//   B. 版式 JSON 超过 16 MiB 的文档（3 万段正文）：RENDER_LAYOUT_OUTPUT_REJECTED，输出为空；
//   C. 外部引用（外部图片 r:link、外部超链接、INCLUDEPICTURE 域、altChunk 中的 HTML 与其中的 img / script、正文中的 HTML 文字）：
//      生产入口在断网沙箱与去掉断网的沙箱中都不发出任何请求；对照组（去掉断网、页面不设 CSP、上下文不离线并放行外部请求）中
//      docx-editor 同样不请求任何样本地址，而同一页面直接请求测试服务器能到达（证明对照组的网络路径可用，docx-editor 不加载外部资源）；
//   D. 时限：测量超过时限时给出 layout_timeout、关闭浏览器上下文，同一浏览器随后照常测量。
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderWordLayout, type RenderLayoutContext } from '../../../src/render/wordLayout.ts';
import { bodyParagraphs, buildDocx, sampleLayoutDocx, type DocxFixtureOptions } from '../docxFixtures.ts';
import { buildZip } from '../zipFixtures.ts';
import { sandboxEnv } from './env.ts';
import { bridgeGateway, createIsolationHarness } from './isolationSuite.ts';

const harness = createIsolationHarness('render-layout', sandboxEnv.layoutImage ?? '');
const JOB_ID = '7c2a4d1e-9b3f-4e8a-a6d5-1f0e2c3b4a59';
const fontConfig = readFileSync(new URL('../../../sandbox/export/fonts/65-zhibiao-cjk.conf', import.meta.url));
const { analyzeLayout } = createRequire(import.meta.url)('../../../../client/electron/services/contentGenerationLayout.cjs') as {
  analyzeLayout: (layout: unknown, sources: unknown[], targetIds: Set<string>, twoColumn?: boolean) => Array<Record<string, unknown>>;
};
const sources = [
  { name: 'app_layout_0', section_id: 's1', file: '第一章.html', block_index: 12, figure_ids: ['fig-1'], text: '总体架构图', image: true },
  { name: 'app_layout_1', section_id: 's1', file: '第一章.html', block_index: 20, figure_ids: ['fig-2'], text: '部署图', image: true },
];

function contextOf(driver = harness.driver): RenderLayoutContext {
  return { jobId: JOB_ID, signal: new AbortController().signal, log: async () => {}, sandbox: driver };
}
const measure = (docx: Buffer, driver = harness.driver) => renderWordLayout(contextOf(driver), docx, { createRetryDelaysMs: [] });

/** 在沙箱中直接执行生产命令，返回退出码、标准输出与取回的文件。 */
async function runEntry(docx: Buffer, driver = harness.driver) {
  const ref = await harness.createSandbox(driver);
  await driver.copyIn(ref, [{ path: 'document.docx', data: docx }]);
  const exec = await driver.exec(ref, 'measure', []);
  return { exec, files: await driver.copyOut(ref) };
}

/** C：外部引用（base 为测试服务器的地址）。 */
function externalDocx(base: string): Buffer {
  const linkedImage = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="3600000" cy="3600000"/><wp:docPr id="9" name="x"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="9" name="x"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="rIdExt"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const options: DocxFixtureOptions = {
    relationships: `<Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${base}/linked-image.png" TargetMode="External"/><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${base}/hyperlink" TargetMode="External"/><Relationship Id="rIdChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/>`,
    contentTypes: '<Default Extension="html" ContentType="text/html"/>',
    extraEntries: [{ name: 'word/chunk.html', data: Buffer.from(`<html><body><img src="${base}/alt-chunk.png"><script>fetch("${base}/alt-chunk-script")</script></body></html>`) }],
  };
  return buildDocx(
    [
      { kind: 'raw', xml: linkedImage },
      { kind: 'raw', xml: '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>外部链接</w:t></w:r></w:hyperlink></w:p>' },
      { kind: 'raw', xml: `<w:p><w:fldSimple w:instr=' INCLUDEPICTURE "${base}/include-picture.png" \\d '><w:r><w:t>域</w:t></w:r></w:fldSimple></w:p>` },
      { kind: 'raw', xml: '<w:altChunk r:id="rIdChunk"/>' },
      { kind: 'paragraph', text: `<img src="${base}/text-img.png" onerror="fetch('${base}/text-onerror')"><script>fetch("${base}/text-script")</script>` },
    ],
    options,
  );
}

function nestedTables(depth: number): string {
  return depth === 0 ? '<w:p><w:r><w:t>深处</w:t></w:r></w:p>' : `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>${nestedTables(depth - 1)}<w:p/></w:tc></w:tr></w:tbl>`;
}

describe.runIf(sandboxEnv.layoutImage)('render-layout sandbox', () => {
  it('carries the patched page bundle, the entry, playwright-core and the shared font mapping, and nothing of the build stage', async () => {
    const ref = await harness.createSandbox();
    const facts = await harness.probe<{ files: string[]; modules: string[]; bundle: Record<string, boolean>; fonts: string; others: boolean; match: Record<string, string> }>(
      ref,
      `const fs = require('fs');
       const { execFileSync } = require('child_process');
       const bundle = fs.readFileSync('/opt/render-layout/assets/docx-layout.js', 'utf8');
       const match = {};
       for (const name of ['宋体', '仿宋', '黑体', '微软雅黑']) match[name] = execFileSync('fc-match', ['-f', '%{family[0]}', name], { encoding: 'utf8' });
       console.log(JSON.stringify({
         files: fs.readdirSync('/opt/render-layout').sort(),
         modules: fs.readdirSync('/opt/render-layout/node_modules').sort(),
         bundle: { patch: bundle.includes('app-keep-probe'), entry: bundle.includes('__zhibiaoLayout'), wasm: bundle.includes('WebAssembly'), eval: bundle.includes('new Function') },
         fonts: require('crypto').createHash('sha256').update(fs.readFileSync('/etc/fonts/conf.d/65-zhibiao-cjk.conf')).digest('hex'),
         others: ['/opt/export', '/opt/openxmlhelper', '/opt/agent', '/opt/parse', '/opt/render-mermaid', '/opt/render-layout/node_modules/esbuild', '/opt/render-layout/node_modules/@docx-editor.dev'].some((path) => fs.existsSync(path)),
         match,
       }))`,
    );
    expect(facts.files).toEqual(['assets', 'entry.mjs', 'node_modules', 'package.json', 'wordLayout.mjs']);
    expect(facts.modules).toEqual(['playwright-core']);
    expect(facts.bundle).toEqual({ patch: true, entry: true, wasm: false, eval: false });
    expect(facts.fonts).toBe(createHash('sha256').update(fontConfig).digest('hex'));
    expect(facts.others).toBe(false);
    expect(facts.match).toEqual({ 宋体: 'Noto Serif CJK SC', 仿宋: 'Noto Serif CJK SC', 黑体: 'Noto Sans CJK SC', 微软雅黑: 'Noto Sans CJK SC' });
  });

  it.each([
    ['one column', false],
    ['two columns', true],
  ])('measures the layout-check document (%s) and the desktop analyzeLayout finds the gap before the pushed image', async (_name, twoColumn) => {
    const started = Date.now();
    const layout = await measure(sampleLayoutDocx({ twoColumn }));
    console.info(JSON.stringify({ renderLayout: { twoColumn, pages: layout.pages.length, ms: Date.now() - started } }));
    expect(layout.pages.length).toBeGreaterThan(2);
    expect(layout.destinations.map((destination) => destination.anchor.name)).toEqual(['app_layout_0', 'app_layout_1']);
    const gaps = analyzeLayout(layout, sources, new Set(['s1']), twoColumn);
    expect(gaps.map((gap) => gap.figure_ids)).toContainEqual(['fig-1']);
    for (const gap of gaps) {
      expect(gap.suggested_words as number).toBeGreaterThan(0);
      expect(gap.preceding_text).toMatch(/本项目按招标文件的要求组织实施/);
    }
  });

  it('returns only layout.json from the production command, without fonts, style properties or other bookmarks', async () => {
    const { exec, files } = await runEntry(sampleLayoutDocx());
    expect(exec.exitCode, exec.stdout).toBe(0);
    expect(exec.stdout.trim()).toBe('{"ok":true}');
    expect(files.map((file) => file.path)).toEqual(['layout.json']);
    const text = files[0]!.data.toString('utf8');
    // 书签名不交出（只有 app_layout_<n>）；书签所在段落的正文（“其他书签”）照常作为文字保留。
    for (const dropped of ['rFonts', 'fontFamily', '宋体', 'Times New Roman', 'attributes', 'unrelated_bookmark']) expect(text, dropped).not.toContain(dropped);
    expect(text).toContain('第一章 总体方案');
    expect(text).toContain('{"text":"其他书签"}');
  });

  describe('A. documents docx-editor refuses to open', () => {
    it.each<[string, Buffer]>([
      ['a ZIP that is not a docx', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(1000, 7)])],
      ['a ZIP bomb (900 MiB document.xml)', buildZip([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'word/document.xml', data: Buffer.alloc(900 * 1024 * 1024, 0x20) }])],
      ['tables nested 40 deep', buildDocx([{ kind: 'raw', xml: nestedTables(40) }])],
      ['a paragraph of 2,000,000 characters', buildDocx([{ kind: 'paragraph', text: '字'.repeat(2_000_000) }])],
    ])('%s: RENDER_LAYOUT_DOCUMENT_INVALID, nothing returned, host healthy', async (_name, docx) => {
      await expect(measure(docx)).rejects.toMatchObject({ code: 'RENDER_LAYOUT_DOCUMENT_INVALID' });
      const { exec, files } = await runEntry(docx);
      expect(exec.exitCode).toBe(65);
      expect(exec.stdout.trim().split('\n').at(-1)).toBe('{"error":"document_invalid"}');
      expect(files).toEqual([]);
      await harness.expectHostHealthy();
    });
  });

  it('B. rejects a layout over 16 MiB (30,000 paragraphs) without returning anything', { timeout: 240_000 }, async () => {
    const docx = buildDocx(bodyParagraphs(30_000));
    const started = Date.now();
    const { exec, files } = await runEntry(docx);
    console.info(JSON.stringify({ renderLayoutTooLarge: { ms: Date.now() - started, stdout: exec.stdout.trim() } }));
    expect(exec.exitCode).toBe(65);
    expect(exec.stdout.trim().split('\n').at(-1)).toBe('{"error":"output_too_large"}');
    expect(files).toEqual([]);
    await expect(measure(docx)).rejects.toMatchObject({ code: 'RENDER_LAYOUT_OUTPUT_REJECTED' });
  });

  describe('C. external references', () => {
    let server: Server;
    let base = '';
    const requests: string[] = [];
    beforeAll(async () => {
      server = createServer((request, response) => {
        requests.push(request.url ?? '');
        response.end('x');
      });
      await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
      base = `http://${await bridgeGateway()}:${(server.address() as { port: number }).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const weakenedNetwork = () =>
      harness.weakenedDriver((spec) => {
        spec.HostConfig.NetworkMode = 'bridge';
      });

    it('request nothing from the production entry, with or without the network', async () => {
      requests.length = 0;
      for (const driver of [harness.driver, weakenedNetwork()]) {
        const layout = await measure(externalDocx(base), driver);
        expect(layout.pages.length).toBeGreaterThan(0);
      }
      expect(requests).toEqual([]);
    });

    it('control: docx-editor loads none of them even without the network isolation, the CSP and the offline context, while the page itself reaches the test server', { timeout: 120_000 }, async () => {
      const weakened = weakenedNetwork();
      const ref = await harness.createSandbox(weakened);
      await weakened.copyIn(ref, [{ path: 'document.docx', data: externalDocx(base) }]);
      requests.length = 0;
      // 测试自己的页面（不设 CSP）、上下文不离线、放行发往测试服务器的请求；页面脚本与 docx 仍由路由给出。另关闭 Chromium 的本地网络访问检查
      // （公网来源的页面不能请求私有地址，测试服务器在网桥的私有地址上）。
      const script = `
        const { chromium } = require('/opt/render-layout/node_modules/playwright-core');
        const fs = require('fs');
        (async () => {
          const browser = await chromium.launch({ executablePath: '/opt/chromium/chrome-headless-shell', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
          const context = await browser.newContext({ offline: false });
          const seen = [];
          await context.route('**/*', (route) => {
            const url = route.request().url();
            if (url === 'http://layout.invalid/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><script src="http://layout.invalid/docx-layout.js"></script>' });
            if (url === 'http://layout.invalid/docx-layout.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync('/opt/render-layout/assets/docx-layout.js') });
            if (url === 'http://layout.invalid/document.docx') return route.fulfill({ status: 200, body: fs.readFileSync('/work/document.docx') });
            seen.push(url);
            return route.continue();
          });
          const page = await context.newPage();
          await page.goto('http://layout.invalid/');
          const result = await page.evaluate(() => window.__zhibiaoLayout.read());
          const control = await page.evaluate((url) => fetch(url, { mode: 'no-cors' }).then(() => 'reached', (error) => String(error)), ${JSON.stringify(`${base}/control`)});
          console.log(JSON.stringify({ ok: result.ok, pages: result.ok ? result.layout.pages.length : 0, seen, control }));
          await browser.close();
        })();`;
      const result = await weakened.execArgv(ref, ['node', '-e', script], { timeoutMs: 90_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      const facts = JSON.parse(result.stdout) as { ok: boolean; pages: number; seen: string[]; control: string };
      expect(facts).toMatchObject({ ok: true, control: 'reached' });
      expect(facts.pages).toBeGreaterThan(0);
      expect(facts.seen.filter((url) => url.startsWith(base))).toEqual([`${base}/control`]);
      expect(requests).toEqual(['/control']);
    });
  });

  it('D. stops a measurement at its time limit, closes the context, and the same browser measures again', { timeout: 120_000 }, async () => {
    const ref = await harness.createSandbox();
    await harness.driver.copyIn(ref, [{ path: 'document.docx', data: sampleLayoutDocx() }]);
    // 入口的模块由测试直接调用：时限改为 1 毫秒（生产入口固定用 LAYOUT_TIMEOUT_MS，没有可传入的选项）。
    const script = `
      import('/opt/render-layout/wordLayout.mjs').then(async (layout) => {
        const { chromium } = await import('/opt/render-layout/node_modules/playwright-core/index.mjs');
        const fs = await import('node:fs');
        const browser = await chromium.launch({ executablePath: layout.CHROMIUM_EXECUTABLE, args: [...layout.LAUNCH_ARGS] });
        const script = await layout.loadPageScript();
        const docx = layout.checkDocx(fs.readFileSync('/work/document.docx'));
        const short = await layout.measureLayout(browser, script, docx, { timeoutMs: 1 }).then(() => 'ok', (error) => error.code);
        const contexts = browser.contexts().length;
        const again = await layout.measureLayout(browser, script, docx).then((data) => JSON.parse(data).pages.length, (error) => error.code);
        console.log(JSON.stringify({ short, contexts, again }));
        await browser.close();
      });`;
    const result = await harness.run(ref, ['node', '-e', script], 100_000);
    expect(result.exitCode, result.stderr).toBe(0);
    const facts = JSON.parse(result.stdout) as { short: string; contexts: number; again: number | string };
    expect(facts.short).toBe('layout_timeout');
    expect(facts.contexts).toBe(0);
    expect(facts.again).toBeGreaterThan(2);
  });
});
