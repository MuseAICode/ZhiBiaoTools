// render-html 沙箱（路线图第 8 步 8.8a1）：按 render-html 模板创建真实的沙箱（CI 中为 gVisor），经 worker 一侧的
// renderHtmlImages（src/render/htmlImages.ts）与模板写死的生产命令转图，结果按不可信输入校验。
// - 镜像：画布、页面与布局测量脚本是桌面版同一份文件（client/electron/shared/htmlImageLayout.cjs，逐字节核对）；
// - 端到端：四种画框都输出 2480 × 画框高 × 2 的 PNG；布局检查与桌面版的脚本给出同样的问题（字号过小、超出画布），
//   check_layout 为 false 时不检查；单张失败不影响其他图（实测耗时写进 CI 日志）；
// - 页面脚本不执行：7 种脚本执行方式（<script>、img / object / body 的事件属性、SVG 中的脚本与 onload、javascript: 框架）都会把正文换成
//   5px 的字，生产命令下没有一种生效（没有“字号过小”）；对照组（同一镜像、同一渲染代码，只把浏览器上下文改为允许 JavaScript）
//   中每一种都生效了；
// - 外部引用：远程图片、样式表、@import、CSS url()、字体、iframe 在沙箱中不被请求；去掉 --network none 的对照组中同样不被
//   请求（浏览器上下文离线并中止一切请求，第二层防护），而对照组的连通性另由沙箱内的 Node 直接请求证明；
// - 错误：请求不合法时只给错误代码，输出目录为空。
// - 图片转 PNG（8.8a2）：SVG 等比放进 1920 × 2880，WebP 只缩小、透明保留、动图取第一帧，坏图只让该项失败（image_invalid）；
//   SVG 中的 5 种脚本执行方式与外部引用（image、use、样式表、CSS url()）不执行、不被请求（去掉断网的对照组中同样不被请求）；
//   样本有效性的对照组：同一份 SVG 作为文档、在测试专用的允许 JavaScript 的浏览器上下文中打开时，5 种方式都生效。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderHtmlImages, type HtmlImageInput, type RenderHtmlContext, type RenderImageInput } from '../../../src/render/htmlImages.ts';
import type { SandboxRef } from '../../../src/sandbox/driver.ts';
import { sandboxEnv } from './env.ts';
import { decodePng } from './exportFixtures.ts';
import { bridgeGateway, createIsolationHarness } from './isolationSuite.ts';

const exportImage = sandboxEnv.exportImage ?? '';
const harness = createIsolationHarness('render-html', exportImage);
const sharedLayout = new URL('../../../../client/electron/shared/htmlImageLayout.cjs', import.meta.url);
const JOB_ID = '3f0c8a8e-6d1b-4e55-9a5e-2b9f0e1c7d42';

function contextOf(driver = harness.driver): RenderHtmlContext {
  return { jobId: JOB_ID, signal: new AbortController().signal, log: async () => {}, sandbox: driver };
}

const OK_HTML = '<div style="display:flex;gap:24px;font-size:32px"><div style="background:#1f6f5c;color:#fff;padding:24px">需求调研</div><div style="padding:24px">方案设计</div></div>';
/**
 * 脚本生效时把正文换成 5px 的字（布局检查报告字号过小）。脚本中不含 `<`：否则 SVG 中的 <script> 文本会被 HTML 解析器当作标签，
 * 不执行脚本也会生成 5px 的元素，样本失效。
 */
const PWNED = "var p=document.createElement('p');p.style.fontSize='5px';p.textContent='pwned';document.body.replaceChildren(p)";
const SCRIPT_SAMPLES: Record<string, string> = {
  'script tag': `<p style="font-size:30px">原文</p><script>${PWNED}</script>`,
  'img onerror': `<p style="font-size:30px">原文</p><img src="x" onerror="${PWNED}">`,
  'body onload': `<html><body onload="${PWNED}"><p style="font-size:30px">原文</p></body></html>`,
  'svg onload': `<p style="font-size:30px">原文</p><svg width="10" height="10" onload="${PWNED}"></svg>`,
  'svg script': `<p style="font-size:30px">原文</p><svg width="10" height="10"><script>${PWNED}</script></svg>`,
  'javascript: iframe': `<p style="font-size:30px">原文</p><iframe src="javascript:with(parent){${PWNED}}"></iframe>`,
  'object onerror': `<p style="font-size:30px">原文</p><object data="missing.bin" onerror="${PWNED}"></object>`,
};
const SMALL_FONT = /^文字字号过小：p 为 5px/;
const webpSample = (name: string) => readFileSync(new URL(`../samples/webp/${name}.webp`, import.meta.url));
const svgOf = (body: string, attributes = 'width="64" height="32"') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attributes}>${body}</svg>`);
/**
 * SVG 中的脚本执行方式（8.8a2；样本有效性见下面的对照组）。每一种生效时都在根元素上留下 data-<名称> 标记并把左半的红色
 * 矩形改成蓝色，根元素的 onload 另把宽度改成 1。脚本中不含 `<`，否则 SVG 不是合法的 XML，样本会因解码失败而无效。
 */
const SVG_SCRIPT_VECTORS = ['root-onload', 'script', 'animate-onbegin', 'image-onerror', 'foreign-onerror'] as const;
const svgAction = (name: (typeof SVG_SCRIPT_VECTORS)[number]) =>
  `document.documentElement.setAttribute('data-${name}','ran');document.querySelector('rect').setAttribute('fill','#0000ff')`;
/** 左半红色、右半透明的 SVG，带全部脚本执行方式与外部引用（image、use、样式表、CSS url()）。 */
const svgWithScripts = (base: string) =>
  svgOf(
    `<rect width="32" height="32" fill="#ff0000"/>` +
      `<script>${svgAction('script')}</script>` +
      `<rect x="60" width="1" height="1" fill-opacity="0"><animate attributeName="x" from="60" to="61" dur="1s" onbegin="${svgAction('animate-onbegin')}"/></rect>` +
      `<image href="${base}/svg-image.png" x="40" width="8" height="8" onerror="${svgAction('image-onerror')}"/><image xlink:href="${base}/svg-xlink.png" x="48" width="8" height="8"/>` +
      `<foreignObject width="1" height="1"><div xmlns="http://www.w3.org/1999/xhtml"><img src="missing.png" onerror="${svgAction('foreign-onerror')}"/></div></foreignObject>` +
      `<use href="${base}/svg-use.svg#x"/><rect class="x" x="56" y="24" width="8" height="8"/><style>@import url(${base}/svg-import.css);.x{fill:url(${base}/svg-fill.svg#p)}</style>`,
    `width="64" height="32" onload="${svgAction('root-onload')};document.documentElement.setAttribute('width','1')"`,
  );

describe.runIf(sandboxEnv.exportImage)('render-html sandbox', () => {
  it('carries the desktop canvas and layout probe unchanged', async () => {
    const ref = await harness.createSandbox();
    const digest = await harness.probe<string>(
      ref,
      "console.log(JSON.stringify(require('crypto').createHash('sha256').update(require('fs').readFileSync('/opt/export/desktop/electron/shared/htmlImageLayout.cjs')).digest('hex')))",
    );
    expect(digest).toBe(createHash('sha256').update(readFileSync(sharedLayout)).digest('hex'));
  });

  it('renders every frame at twice the design size and reports the desktop layout issues', async () => {
    const items: HtmlImageInput[] = [
      { html: OK_HTML, frameSize: 'square', checkLayout: true },
      { html: OK_HTML, frameSize: 'wide', checkLayout: true },
      { html: OK_HTML, frameSize: 'tall', checkLayout: true },
      { html: OK_HTML, frameSize: 'panorama', checkLayout: true },
      { html: '<div style="font-size:12px">字太小</div>', frameSize: 'wide', checkLayout: true },
      { html: '<div style="font-size:12px">字太小</div>', frameSize: 'wide', checkLayout: false },
      { html: `<div style="font-size:30px;width:3000px;white-space:nowrap">${'很长的一行文字'.repeat(40)}</div>`, frameSize: 'wide', checkLayout: true },
    ];
    const started = Date.now();
    const results = await renderHtmlImages(contextOf(), items, { createRetryDelaysMs: [] });
    console.info(JSON.stringify({ renderHtmlBatch: { images: items.length, ms: Date.now() - started } }));
    expect(results.map((result) => (result.status === 'rendered' ? [result.width, result.height] : result.error))).toEqual([
      [2480, 2480],
      [2480, 1654],
      [2480, 3306],
      [2480, 1396],
      [2480, 1654],
      [2480, 1654],
      [2480, 1654],
    ]);
    const issues = results.map((result) => (result.status === 'rendered' ? result.layoutIssues : null));
    expect(issues.slice(0, 4)).toEqual([[], [], [], []]);
    expect(issues[4]).toEqual(['文字字号过小：div 为 12px，至少需要 24px']);
    expect(issues[5]).toEqual([]);
    expect(issues[6]).toEqual(['文字超出截图画布：div', '元素超出画布内容区域：div']);
  });

  it('never runs page scripts in production, while the JavaScript-enabled control runs every sample', async () => {
    const names = Object.keys(SCRIPT_SAMPLES);
    const results = await renderHtmlImages(
      contextOf(),
      names.map((name) => ({ html: SCRIPT_SAMPLES[name]!, frameSize: 'wide', checkLayout: true })),
      { createRetryDelaysMs: [] },
    );
    for (const [index, name] of names.entries()) {
      const result = results[index]!;
      expect(result.status, name).toBe('rendered');
      if (result.status === 'rendered') expect(result.layoutIssues.filter((issue) => SMALL_FONT.test(issue)), name).toEqual([]);
    }

    // 对照组：同一镜像中的同一渲染代码，只把浏览器上下文改为允许 JavaScript（生产入口不能这样调用）。
    const ref = await harness.createSandbox();
    const control = await harness.probe<Record<string, string[] | string>>(ref, controlScript(SCRIPT_SAMPLES, true));
    for (const name of names) {
      const issues = control[name];
      expect(Array.isArray(issues) && issues.some((issue) => SMALL_FONT.test(issue)), `${name}: ${JSON.stringify(issues)}`).toBe(true);
    }
  });

  describe('external references', () => {
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

    const externalHtml = () =>
      `<link rel="stylesheet" href="${base}/link.css"><style>@import "${base}/import.css";@font-face{font-family:x;src:url(${base}/font.woff)}div{font-family:x}</style>` +
      `<div style="font-size:30px;background:url(${base}/bg.png)">外部引用</div><img src="${base}/img.png"><iframe src="${base}/frame.html"></iframe>`;

    const externalItems = (): RenderImageInput[] => [
      { html: externalHtml(), frameSize: 'square', checkLayout: true },
      { kind: 'image', format: 'svg', data: svgWithScripts(base) },
    ];
    /** SVG 中的脚本与事件属性都不执行：仍是左半红色、右半透明，宽高不变。 */
    const expectSvgUntouched = (result: Awaited<ReturnType<typeof renderHtmlImages>>[number]) => {
      expect(result.status).toBe('rendered');
      if (result.status !== 'rendered') return;
      expect([result.width, result.height]).toEqual([1920, 960]);
      const png = decodePng(result.png);
      expect(png.pixel(100, 100)).toEqual([255, 0, 0]);
      expect(png.alpha(1800, 100)).toBe(0);
    };

    it('requests nothing inside the sandbox', async () => {
      requests.length = 0;
      const results = await renderHtmlImages(contextOf(), externalItems(), { createRetryDelaysMs: [] });
      expect(results[0]!.status).toBe('rendered');
      expectSvgUntouched(results[1]!);
      expect(requests).toEqual([]);
    });

    it('every SVG script sample takes effect when the same bytes are opened as an SVG document with scripts allowed (sample-validity control)', async () => {
      // 对照组只在测试中：在同一镜像中用测试自己的浏览器上下文（允许 JavaScript）把同一份 SVG 作为文档打开，
      // 生产入口与 imageConvert.mjs 没有打开脚本的选项（tests/sandbox/renderHtmlEntry.test.ts 核对）。
      requests.length = 0;
      const ref = await harness.createSandbox();
      const control = await harness.probe<{ allowed: string[]; blocked: string[] }>(ref, svgControlScript(svgWithScripts(base).toString('utf8')));
      expect(control.allowed).toEqual([...SVG_SCRIPT_VECTORS].sort());
      // 同一上下文只改为禁用 JavaScript 时一种也不生效（对照组本身的开关有效）。
      expect(control.blocked).toEqual([]);
      expect(requests).toEqual([]);
    });

    it('still requests nothing with the network attached (offline context and aborted requests), although the sandbox can reach the host', async () => {
      const weakened = harness.weakenedDriver((spec) => {
        spec.HostConfig.NetworkMode = 'bridge';
      });
      requests.length = 0;
      const results = await renderHtmlImages(contextOf(weakened), externalItems(), { createRetryDelaysMs: [] });
      expect(results[0]!.status).toBe('rendered');
      expectSvgUntouched(results[1]!);
      expect(requests).toEqual([]);
      // 对照：同样去掉断网的沙箱中，Node 能直接连到测试服务器。
      const ref: SandboxRef = await weakened.create('render-html', { jobId: JOB_ID });
      harness.track(ref, weakened);
      const reached = await harness.run(ref, ['node', '-e', `fetch(${JSON.stringify(`${base}/reachable`)}).then((r) => console.log(r.status))`], 30_000, weakened);
      expect(reached.stdout.trim()).toBe('200');
      expect(requests).toEqual(['/reachable']);
    });
  });

  it('converts SVG and WebP images to PNG next to HTML items; a broken image only fails its own item (8.8a2)', async () => {
    const items: RenderImageInput[] = [
      { kind: 'image', format: 'svg', data: svgOf('<rect width="32" height="32" fill="#ff0000"/>') },
      { kind: 'image', format: 'svg', data: svgOf('<rect width="100" height="200" fill="#00a000"/>', 'viewBox="0 0 100 200"') },
      { kind: 'image', format: 'webp', data: webpSample('animated') },
      { kind: 'image', format: 'webp', data: webpSample('lossy-alpha') },
      { html: OK_HTML, frameSize: 'wide', checkLayout: true },
      { kind: 'image', format: 'svg', data: Buffer.from('不是 SVG') },
      { kind: 'image', format: 'webp', data: svgOf('') },
    ];
    const results = await renderHtmlImages(contextOf(), items, { createRetryDelaysMs: [] });
    expect(results.map((result) => (result.status === 'rendered' ? [result.width, result.height] : result.error))).toEqual([
      [1920, 960],
      [1440, 2880],
      [64, 48],
      [64, 48],
      [2480, 1654],
      'image_invalid',
      'image_invalid',
    ]);
    const png = (index: number) => {
      const result = results[index]!;
      if (result.status !== 'rendered') throw new Error('not rendered');
      return decodePng(result.png);
    };
    // SVG 等比放大：左半红色、右半透明。
    expect(png(0).pixel(100, 100)).toEqual([255, 0, 0]);
    expect(png(0).alpha(100, 100)).toBe(255);
    expect(png(0).alpha(1800, 900)).toBe(0);
    expect(png(1).pixel(720, 1440)).toEqual([0, 160, 0]);
    // 动图只取第一帧（左半红色、右半透明，不是后续帧的蓝色或绿色）；有损带透明的透明部分仍然透明。
    expect(png(2).pixel(8, 24)).toEqual([255, 0, 0]);
    expect(png(2).alpha(56, 24)).toBe(0);
    expect(png(3).alpha(8, 24)).toBe(255);
    expect(png(3).alpha(56, 24)).toBe(0);
  });

  it('rejects an invalid request with an error code only and leaves no output', async () => {
    const ref = await harness.createSandbox();
    await harness.driver.copyIn(ref, [{ path: 'request.json', data: Buffer.from(JSON.stringify({ version: 1, items: [{ id: 'h001', html: 'x', frame_size: 'huge', check_layout: true }] })) }]);
    const result = await harness.driver.exec(ref, 'render', []);
    expect(result.exitCode).toBe(65);
    expect(result.stdout.trim().split('\n').at(-1)).toBe('{"error":"request_invalid"}');
    expect(await harness.driver.copyOut(ref)).toEqual([]);
  });
});

/**
 * SVG 样本的对照组（测试专用）：在沙箱内用镜像中的 Chromium 把 SVG 作为文档（image/svg+xml）打开，分别在允许与禁用 JavaScript 的
 * 浏览器上下文中读出根元素上的 data-* 标记（生效的脚本执行方式）。上下文离线并中止其他一切请求。
 */
function svgControlScript(svg: string): string {
  return `
    (async () => {
      const { createRequire } = require('module');
      const req = createRequire('/opt/export/package.json');
      const { chromium } = req('playwright-core');
      const { CHROMIUM_EXECUTABLE, LAUNCH_ARGS } = await import('/opt/export/render.mjs');
      const browser = await chromium.launch({ executablePath: CHROMIUM_EXECUTABLE, headless: true, args: [...LAUNCH_ARGS], env: { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' } });
      const svg = ${JSON.stringify(svg)};
      const markers = async (javaScriptEnabled) => {
        const context = await browser.newContext({ javaScriptEnabled, offline: true });
        await context.route('**/*', (route) => route.request().url() === 'http://render.invalid/'
          ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg })
          : route.abort('blockedbyclient'));
        const page = await context.newPage();
        await page.goto('http://render.invalid/', { waitUntil: 'load' });
        // 等动画开始与加载失败的事件。
        await page.waitForTimeout(500);
        const names = await page.evaluate(() => [...document.documentElement.attributes].map((item) => item.name).filter((name) => name.startsWith('data-')).map((name) => name.slice(5)).sort());
        await context.close();
        return names;
      };
      const out = { allowed: await markers(true), blocked: await markers(false) };
      await browser.close();
      process.stdout.write(JSON.stringify(out));
    })().catch((error) => { console.error(error); process.exit(1); });`;
}

/** 在沙箱内用镜像中的渲染代码转图并返回每张的布局问题（失败时为错误代码）；javaScriptEnabled 只有测试能打开。 */
function controlScript(samples: Record<string, string>, javaScriptEnabled: boolean): string {
  return `
    (async () => {
      const { createRequire } = require('module');
      const req = createRequire('/opt/export/package.json');
      const { chromium } = req('playwright-core');
      const layout = req('/opt/export/desktop/electron/shared/htmlImageLayout.cjs');
      const { CHROMIUM_EXECUTABLE, LAUNCH_ARGS } = await import('/opt/export/render.mjs');
      const { renderHtmlImage } = await import('/opt/export/htmlImage.mjs');
      const browser = await chromium.launch({ executablePath: CHROMIUM_EXECUTABLE, headless: true, args: [...LAUNCH_ARGS], env: { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' } });
      const samples = ${JSON.stringify(samples)};
      const out = {};
      for (const [name, html] of Object.entries(samples)) {
        try {
          out[name] = (await renderHtmlImage(browser, layout, { id: 'c', html, frameSize: 'wide', checkLayout: true }, { javaScriptEnabled: ${javaScriptEnabled} })).layoutIssues;
        } catch (error) {
          out[name] = String(error && error.code);
        }
      }
      await browser.close();
      process.stdout.write(JSON.stringify(out));
    })().catch((error) => { console.error(error); process.exit(1); });`;
}
