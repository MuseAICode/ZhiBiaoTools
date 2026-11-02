// export 沙箱的导出入口与专用隔离测试（路线图第 7 步 7.1；docs/SERVER_DESIGN.md 第 7.9 节）：按 export 模板创建真实的沙箱
// （CI 中为 gVisor），放入请求、执行模板中登记的导出命令、取回结果并按模板校验。
// - 镜像：装饰生成器与桌面版同一份代码（逐个文件核对），模板可选字体按决定事项第 3 项映射到 Noto CJK；
// - 装饰与桌面版逐项核对（7.2）：同一页面配置在沙箱中生成的 SVG、几何与文字层与宿主上的桌面版生成器相同；入口交给 Chromium 的
//   SVG 与交给助手的 chrome_assets 与桌面版相同；
// - 端到端：样张（含装饰与配图）与整本导出都能在沙箱中完成，.NET 与 Chromium 在当前运行时下能运行（实测耗时写进 CI 日志）；
// - 错误：请求不合法、助手失败时只给错误代码，输出目录为空，助手的错误文字不外传；
// - Chromium 禁用 JavaScript：恶意装饰（7 种脚本执行方式）经完整的导出流程栅格化，脚本都没有执行；对照组（只把浏览器上下文
//   改为允许 JavaScript）中每一种都执行了；
// - 外部引用：装饰与受限 HTML 中的远程图片、样式表、CSS url() 在沙箱中不被请求；对照组（去掉 --network none）中装饰的外部引用确实被请求；
// - 任务间隔离：一次导出结束后，新的沙箱中看不到上一次的输入、装饰、浏览器配置目录和助手的任务目录，导出结果中没有上一次的内容。
// 恶意装饰经 Node 的模块加载钩子（node --import）替换装饰生成器的输出：入口、渲染、助手都是镜像中的原样代码，
// 生产命令（模板写死的 node /opt/export/entry.mjs <模式>）不接受这类参数，钩子只能由测试经 execArgv 加上。
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxFile } from '../../../src/sandbox/archive.ts';
import type { DockerSandboxDriver } from '../../../src/sandbox/docker.ts';
import type { SandboxRef } from '../../../src/sandbox/driver.ts';
import type { SandboxTemplateName } from '../../../src/sandbox/templates.ts';
import { sandboxEnv } from './env.ts';
import {
  DECORATION_STYLES,
  DESKTOP_CHROME_MODULE,
  SANDBOX_DIGEST_SCRIPT,
  decorationCases,
  desktopChromeAssets,
  digestChrome,
  type ChromeDigest,
} from './exportDecorationCases.ts';
import { decodePng, grayPng, readZipEntries } from './exportFixtures.ts';
import { bridgeGateway, createIsolationHarness } from './isolationSuite.ts';

const exportImage = sandboxEnv.exportImage ?? '';
const preview = createIsolationHarness('export-preview', exportImage);
const document = createIsolationHarness('export-document', exportImage);
const harnessOf = (template: SandboxTemplateName) => (template === 'export-document' ? document : preview);

const chromeDirectory = new URL('../../../../client/electron/shared/chrome/', import.meta.url);
const exportFormatSource = new URL('../../../../client/src/shared/types/exportFormat.ts', import.meta.url);

/** 带页眉页脚装饰（band 样式）与页码的页面配置。 */
const DECORATED_PAGE = {
  header_footer_style: 'band',
  header_enabled: true,
  header_text: '智标导出测试',
  header_badge_text: '智标',
  footer_enabled: true,
  footer_text: '第一页',
  page_number_enabled: true,
};

interface ExportRequest {
  html: string;
  export_format: Record<string, unknown>;
  asset_types?: Record<string, string>;
}

interface ExportRun {
  ref: SandboxRef;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  files: SandboxFile[];
  timings: { createMs: number; execMs: number };
}

function requestFiles(request: ExportRequest | Buffer, assets: Record<string, Buffer> = {}): SandboxFile[] {
  return [
    { path: 'request.json', data: Buffer.isBuffer(request) ? request : Buffer.from(JSON.stringify(request)) },
    ...Object.entries(assets).map(([name, data]) => ({ path: `assets/${name}`, data })),
  ];
}

/**
 * 在新的 export 沙箱中导出一次。默认经模板写死的生产命令（driver.exec 'export'）；给出 hook 时改为
 * node --import <钩子> /opt/export/entry.mjs <模式>（只有测试能这样执行）。
 */
async function exportIn(
  template: SandboxTemplateName,
  files: SandboxFile[],
  options: { hook?: Record<string, string>; driver?: DockerSandboxDriver } = {},
): Promise<ExportRun> {
  const harness = harnessOf(template);
  const target = options.driver ?? harness.driver;
  const createStarted = Date.now();
  const ref = await harness.createSandbox(target);
  const createMs = Date.now() - createStarted;
  await target.copyIn(ref, files);
  if (options.hook) await writeHook(target, ref, options.hook);
  const started = Date.now();
  const mode = template === 'export-document' ? 'document' : 'preview';
  const result = options.hook
    ? await target.execArgv(ref, ['node', '--import', 'file:///tmp/hook/register.mjs', '/opt/export/entry.mjs', mode], { timeoutMs: 120_000 })
    : await target.exec(ref, 'export', []);
  const execMs = Date.now() - started;
  const outputFiles = result.exitCode === 0 ? await target.copyOut(ref) : await target.copyOut(ref).catch(() => []);
  return { ref, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, files: outputFiles, timings: { createMs, execMs } };
}

async function writeHook(target: DockerSandboxDriver, ref: SandboxRef, files: Record<string, string>) {
  const script = "const fs = require('fs'); fs.mkdirSync('/tmp/hook'); for (const [name, text] of Object.entries(JSON.parse(process.argv[1]))) fs.writeFileSync('/tmp/hook/' + name, text);";
  const result = await target.execArgv(ref, ['node', '-e', script, JSON.stringify(files)], { timeoutMs: 30_000 });
  expect(result.exitCode, result.stderr).toBe(0);
}

function outputOf(run: ExportRun) {
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.files.map((file) => file.path).sort()).toEqual(['document.docx', 'result.json']);
  const docx = readZipEntries(run.files.find((file) => file.path === 'document.docx')!.data);
  const result = JSON.parse(run.files.find((file) => file.path === 'result.json')!.data.toString('utf8')) as { version: number; blockCount: number; imageWarnings: unknown[] };
  return { docx, result };
}

function errorCodeOf(run: ExportRun): string {
  const last = run.stdout.trim().split('\n').at(-1) ?? '';
  return (JSON.parse(last) as { error: string }).error;
}

/** docx 中页眉（或页脚）部件引用的图片。 */
function partImages(docx: Map<string, Buffer>, part: 'header' | 'footer'): Buffer[] {
  const images: Buffer[] = [];
  for (const [name, data] of docx) {
    const match = new RegExp(`^word/_rels/(${part}\\d*\\.xml)\\.rels$`).exec(name);
    if (!match) continue;
    for (const target of data.toString('utf8').matchAll(/Target="([^"]+\.png)"/g)) {
      const path = target[1]!.startsWith('/') ? target[1]!.slice(1) : `word/${target[1]!}`;
      images.push(docx.get(path)!);
    }
  }
  return images;
}

/** 文档正文、页眉、页脚的全部 XML 文字。 */
function docxText(docx: Map<string, Buffer>): string {
  return [...docx].filter(([name]) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(name)).map(([, data]) => data.toString('utf8')).join('\n');
}

describe.runIf(sandboxEnv.exportImage)('export image', () => {
  it('carries the desktop decoration generator unchanged', async () => {
    const ref = await preview.createSandbox();
    const result = await preview.probe<Record<string, string>>(
      ref,
      `const fs = require('fs'), crypto = require('crypto'); const out = {};
       for (const name of fs.readdirSync('/opt/export/chrome')) out[name] = crypto.createHash('sha256').update(fs.readFileSync('/opt/export/chrome/' + name)).digest('hex');
       console.log(JSON.stringify(out));`,
    );
    const expected = Object.fromEntries(
      readdirSync(chromeDirectory)
        .filter((name) => name.endsWith('.mjs'))
        .map((name) => [name, createHash('sha256').update(readFileSync(new URL(name, chromeDirectory))).digest('hex')]),
    );
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    expect(result).toEqual(expected);
  });

  it('maps every font name a template can choose to Noto CJK (serif to serif, sans to sans)', async () => {
    // 期望值取自前端的 FONT_TO_CSS：每个字体名的 CSS 回退族是 serif 还是 sans-serif（决定事项第 3 项）。
    const source = readFileSync(exportFormatSource, 'utf8');
    const table = source.slice(source.indexOf('export const FONT_TO_CSS'));
    const fonts = [...table.slice(0, table.indexOf('};')).matchAll(/^\s+'([^']+)':\s+"[^"]*,\s*(serif|sans-serif)",?$/gm)].map((match) => ({ name: match[1]!, generic: match[2]! }));
    expect(fonts.length).toBeGreaterThanOrEqual(20);
    for (const required of ['宋体', '仿宋', '黑体']) expect(fonts.map((font) => font.name)).toContain(required);
    const ref = await preview.createSandbox();
    const result = await preview.run(ref, ['sh', '-c', 'for name in "$@"; do fc-match -f "%{family[0]}\\n" "$name"; done', 'fc-match', ...fonts.map((font) => font.name)]);
    expect(result.exitCode, result.stderr).toBe(0);
    const matched = result.stdout.trim().split('\n');
    expect(Object.fromEntries(fonts.map((font, index) => [font.name, matched[index]]))).toEqual(
      Object.fromEntries(fonts.map((font) => [font.name, font.generic === 'serif' ? 'Noto Serif CJK SC' : 'Noto Sans CJK SC'])),
    );
  });
});

interface DesktopChrome {
  style: string;
  headerSvg: string | null;
  footerSvg: string | null;
  layout: Record<string, number>;
  colors: unknown;
  textLayout: unknown;
}
const loadDesktopChrome = async () => (await import(DESKTOP_CHROME_MODULE.href)) as { buildChrome(page: Record<string, unknown>): DesktopChrome };

/** 测试钩子：包装入口导入的渲染模块，把每次交给 Chromium 的装饰 SVG 与尺寸记到 /tmp/hook/svg-<序号>.json，其余不变。 */
const RECORD_SVG_HOOK: Record<string, string> = {
  'register.mjs': "import { register } from 'node:module'; register('file:///tmp/hook/hooks.mjs');",
  'hooks.mjs': `export async function resolve(specifier, context, next) {
    if (context.parentURL === 'file:///opt/export/entry.mjs' && specifier === './render.mjs') return { url: 'file:///tmp/hook/render.mjs', shortCircuit: true };
    return next(specifier, context);
  }`,
  'render.mjs': `import { writeFileSync } from 'node:fs';
    import * as real from 'file:///opt/export/render.mjs';
    export * from 'file:///opt/export/render.mjs';
    let count = 0;
    export function rasterizeSvg(renderer, svg, widthCm, heightCm) {
      writeFileSync('/tmp/hook/svg-' + count++ + '.json', JSON.stringify({ svg, widthCm, heightCm }));
      return real.rasterizeSvg(renderer, svg, widthCm, heightCm);
    }`,
};

/** 导出结束后读出钩子记下的 SVG（摘要）与入口写给助手的 chrome_assets。 */
const RECORDED_SCRIPT = `
const crypto = require('crypto'); const fs = require('fs');
const svgs = fs.readdirSync('/tmp/hook').filter((name) => /^svg-\\d+\\.json$/.test(name)).sort().map((name) => {
  const { svg, widthCm, heightCm } = JSON.parse(fs.readFileSync('/tmp/hook/' + name, 'utf8'));
  return { svg: crypto.createHash('sha256').update(svg).digest('hex'), widthCm, heightCm };
});
const request = JSON.parse(fs.readFileSync('/work/openxml-jobs/export/request.json', 'utf8'));
console.log(JSON.stringify({ svgs, chromeAssets: request.chrome_assets, page: request.export_format.page }));`;

describe.runIf(sandboxEnv.exportImage)('decorations match the desktop', () => {
  const cases = decorationCases();

  it('buildChrome in the sandbox gives the desktop SVG, geometry and text layout for every case', async () => {
    const { buildChrome } = await loadDesktopChrome();
    const expected = Object.fromEntries(cases.map((item) => [item.name, digestChrome(buildChrome(item.page))]));
    // 每种样式都确实画出了装饰（plain 除外），核对不是在比两个空值。
    for (const style of DECORATION_STYLES) {
      const full = expected[`${style}/full`]!;
      expect(full.style).toBe(style);
      if (style !== 'plain') expect(full.headerSvg ?? full.footerSvg).not.toBeNull();
    }
    expect(new Set(Object.values(expected).map((digest) => digest.headerSvg).filter(Boolean)).size).toBeGreaterThan(DECORATION_STYLES.length);

    const ref = await preview.createSandbox();
    await preview.driver.copyIn(ref, [{ path: 'pages.json', data: Buffer.from(JSON.stringify(cases)) }]);
    const actual = await preview.probe<Record<string, ChromeDigest>>(ref, SANDBOX_DIGEST_SCRIPT);
    expect(actual).toEqual(expected);
  });

  it.each(DECORATION_STYLES)('the export entry rasterizes the desktop SVG and hands the helper the desktop chrome_assets (%s)', async (style) => {
    const { buildChrome } = await loadDesktopChrome();
    const page = cases.find((item) => item.name === `${style}/full`)!.page;
    const chrome = buildChrome(page);
    const run = await exportIn('export-preview', requestFiles({ html: '<p>装饰核对</p>', export_format: { page } }), { hook: RECORD_SVG_HOOK });
    const { docx } = outputOf(run);
    const recorded = await preview.probe<{ svgs: Array<{ svg: string; widthCm: number; heightCm: number }>; chromeAssets: Record<string, unknown>; page: unknown }>(run.ref, RECORDED_SCRIPT);

    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    const expectedSvgs = [
      [chrome.headerSvg, chrome.layout.headerHeightCm],
      [chrome.footerSvg, chrome.layout.footerHeightCm],
    ].flatMap(([svg, heightCm]) => (svg && Number(heightCm) > 0 ? [{ svg: sha256(String(svg)), widthCm: chrome.layout.widthCm, heightCm }] : []));
    expect(recorded.page).toEqual(page);
    expect(recorded.svgs).toEqual(expectedSvgs);
    const { root, header, footer, ...geometry } = recorded.chromeAssets;
    expect(root).toBe('chrome');
    expect({ header: header === 'header.png', footer: footer === 'footer.png', ...geometry }).toEqual(desktopChromeAssets(chrome));
    expect(header === null || header === 'header.png').toBe(true);
    expect(footer === null || footer === 'footer.png').toBe(true);
    // 栅格化后的装饰确实进了 docx（plain 没有装饰图）。
    expect(partImages(docx, 'header').length + partImages(docx, 'footer').length).toBe(expectedSvgs.length);
  });
});

describe.runIf(sandboxEnv.exportImage)('export entry', () => {
  it('exports a sample with decorations and an image through the registered command (preview)', async () => {
    const run = await exportIn(
      'export-preview',
      requestFiles(
        {
          html: '<h1>第一章 总体方案</h1><p>样张正文。</p><figure id="fig_001" data-app-generation="htmlImage" data-app-size="wide"><img alt="示意图" data-app-asset-ref="figure.png"><figcaption>图 1 示意图</figcaption></figure>',
          export_format: { page: DECORATED_PAGE },
          asset_types: { 'figure.png': 'image/png' },
        },
        { 'figure.png': grayPng(300, 200) },
      ),
    );
    const { docx, result } = outputOf(run);
    expect(result).toMatchObject({ version: 1, imageWarnings: [] });
    expect(result.blockCount).toBeGreaterThan(0);
    expect(docxText(docx)).toContain('样张正文');
    expect(partImages(docx, 'header').length).toBe(1);
    expect(partImages(docx, 'footer').length).toBe(1);
    // 页眉装饰、页脚装饰、正文配图。
    expect([...docx.keys()].filter((name) => name.endsWith('.png')).length).toBe(3);
    // 实测（路线图 7.1：.NET 与 Chromium 在 gVisor 下能运行，样张约 1 秒级以实测为准），写在 CI 日志中。
    console.info(JSON.stringify({ runtime: sandboxEnv.runtime, template: 'export-preview', ...run.timings }));
  });

  it('exports a whole document through the registered command (document)', async () => {
    const run = await exportIn(
      'export-document',
      requestFiles({
        html: '<h1 data-app-outline-number="1">总体方案</h1><p>整本正文。</p><h2 data-app-outline-number="1.1">实施步骤</h2><p>第二段。</p>',
        export_format: { page: DECORATED_PAGE },
      }),
    );
    const { docx, result } = outputOf(run);
    expect(result.blockCount).toBeGreaterThan(0);
    expect(docxText(docx)).toContain('整本正文');
    console.info(JSON.stringify({ runtime: sandboxEnv.runtime, template: 'export-document', ...run.timings }));
  });

  it.each([
    ['malformed request.json', () => requestFiles(Buffer.from('{not json'))],
    ['a request without html', () => requestFiles({ html: '', export_format: {} })],
    ['an extra file next to the request', () => [...requestFiles({ html: '<p>x</p>', export_format: {} }), { path: 'openxml-jobs', data: Buffer.from('x') }]],
    ['an asset type for a missing asset', () => requestFiles({ html: '<p>x</p>', export_format: {}, asset_types: { 'missing.png': 'image/png' } })],
  ])('rejects %s with request_invalid and no output', async (_name, files) => {
    const run = await exportIn('export-preview', files());
    expect(run.exitCode).toBe(65);
    expect(errorCodeOf(run)).toBe('request_invalid');
    expect(run.files).toEqual([]);
  });

  it('reports helper failures by code only and leaves no output', async () => {
    const run = await exportIn('export-preview', requestFiles({ html: '<figure data-app-size="huge"><img alt="x" data-app-asset-ref="a.png"></figure>', export_format: {} }));
    expect(run.exitCode).toBe(65);
    expect(errorCodeOf(run)).toBe('helper_failed');
    // 助手的错误文字（如“data-app-size”）不外传。
    expect(run.stdout.trim()).toBe('{"error":"helper_failed"}');
    expect(run.files).toEqual([]);
  });
});

// 7 种在页面中执行脚本的方式，每种成功时把自己的格子从白色涂成红色。格子在 SVG 中横向排开（viewBox 宽 700，拉伸铺满装饰）。
const VECTORS = ['svg-script', 'svg-image-onerror', 'foreign-object-img-onerror', 'iframe-srcdoc', 'smil-onbegin', 'html-script', 'svg-onload'] as const;
const paint = (index: number) => `document.getElementById('v${index}').setAttribute('fill','#ff0000')`;

function maliciousSvg(externalBase: string | null): string {
  const cells = VECTORS.map((_, index) => `<rect id="v${index}" x="${index * 100}" y="0" width="100" height="60" fill="#ffffff"/>`).join('');
  const external = externalBase
    ? `<image href="${externalBase}/svg-image.png" x="0" y="0" width="1" height="1"/>` +
      `<foreignObject x="0" y="0" width="1" height="1"><img src="${externalBase}/foreign-object-img.png"/><link rel="stylesheet" href="${externalBase}/foreign-object-link.css"/></foreignObject>` +
      `<style>@import url("${externalBase}/svg-import.css"); #v0 { stroke: url("${externalBase}/svg-css-url.svg#x"); }</style>`
    : '';
  return (
    `<svg onload="${paint(6)}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 60" preserveAspectRatio="none">` +
    cells +
    `<script>${paint(0)}</script>` +
    `<image href="data:image/png;base64,AAAA" x="0" y="0" width="1" height="1" onerror="${paint(1)}"/>` +
    `<foreignObject x="0" y="0" width="1" height="1"><img src="data:image/png;base64,AAAA" onerror="${paint(2)}"/></foreignObject>` +
    `<foreignObject x="0" y="0" width="1" height="1"><iframe srcdoc="&lt;script&gt;parent.${paint(3).replace(/'/g, '&#39;')}&lt;/script&gt;"></iframe></foreignObject>` +
    `<rect x="0" y="0" width="1" height="1" fill="#ffffff"><animate attributeName="opacity" from="1" to="1" begin="0s" dur="1s" onbegin="${paint(4)}"/></rect>` +
    external +
    `</svg><script>${paint(5)}</script>`
  );
}

/**
 * 测试钩子：把入口导入的装饰生成器换成返回恶意页眉 SVG 的版本（其余几何与文字层不变）；enableJavaScript 时（对照组）
 * 另把渲染模块导入的 playwright-core 换成一层包装，只把浏览器上下文的 javaScriptEnabled 改为 true。
 */
function hookFiles(svg: string, enableJavaScript: boolean): Record<string, string> {
  return {
    'register.mjs': "import { register } from 'node:module'; register('file:///tmp/hook/hooks.mjs');",
    'hooks.mjs': `export async function resolve(specifier, context, next) {
      if (context.parentURL === 'file:///opt/export/entry.mjs' && specifier === './chrome/index.mjs') return { url: 'file:///tmp/hook/chrome.mjs', shortCircuit: true };
      if (${enableJavaScript} && context.parentURL === 'file:///opt/export/render.mjs' && specifier === 'playwright-core') return { url: 'file:///tmp/hook/playwright.mjs', shortCircuit: true };
      return next(specifier, context);
    }`,
    'chrome.mjs': `import * as real from 'file:///opt/export/chrome/index.mjs';
      export * from 'file:///opt/export/chrome/index.mjs';
      export function buildChrome(page) { return { ...real.buildChrome(page), headerSvg: ${JSON.stringify(svg)} }; }`,
    'playwright.mjs': `import { chromium as real } from 'file:///opt/export/node_modules/playwright-core/index.mjs';
      export const chromium = { async launch(options) {
        const browser = await real.launch(options);
        const newContext = browser.newContext.bind(browser);
        browser.newContext = (contextOptions) => newContext({ ...contextOptions, javaScriptEnabled: true });
        return browser;
      } };`,
  };
}

/** 每个格子中心的颜色：white / red / other。 */
function vectorColors(png: Buffer): Record<string, string> {
  const image = decodePng(png);
  return Object.fromEntries(
    VECTORS.map((name, index) => {
      const [r, g, b] = image.pixel(((index + 0.5) / VECTORS.length) * image.width, image.height / 2);
      return [name, r > 240 && g > 240 && b > 240 ? 'white' : r > 200 && g < 60 && b < 60 ? 'red' : `rgb(${r},${g},${b})`];
    }),
  );
}

const MALICIOUS_REQUEST = { html: '<p>正文</p>', export_format: { page: DECORATED_PAGE } };

describe.runIf(sandboxEnv.exportImage)('Chromium runs without JavaScript during export', () => {
  it('does not execute any script in a malicious decoration, and the export still completes', async () => {
    const run = await exportIn('export-preview', requestFiles(MALICIOUS_REQUEST), { hook: hookFiles(maliciousSvg(null), false) });
    const { docx } = outputOf(run);
    const [header] = partImages(docx, 'header');
    expect(Object.values(vectorColors(header!))).toEqual(VECTORS.map(() => 'white'));
  });

  it('control: with JavaScript enabled in the browser context every one of the scripts runs', async () => {
    const run = await exportIn('export-preview', requestFiles(MALICIOUS_REQUEST), { hook: hookFiles(maliciousSvg(null), true) });
    const { docx } = outputOf(run);
    const [header] = partImages(docx, 'header');
    expect(vectorColors(header!)).toEqual(Object.fromEntries(VECTORS.map((name) => [name, 'red'])));
  });
});

describe.runIf(sandboxEnv.exportImage)('external references', () => {
  let server: Server;
  let base: string;
  const requests: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    base = `http://${await bridgeGateway()}:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // 受限 HTML 中的远程样式表、CSS url()、配图的 src（配图只按 data-app-asset-ref 取沙箱内的文件）；助手能正常导出这段 HTML。
  const request = () => ({
    html:
      `<link rel="stylesheet" href="${base}/html-link.css">` +
      `<style>@import url("${base}/html-import.css"); p { background: url("${base}/html-css-url.png"); }</style>` +
      `<p style="background-image: url('${base}/html-inline-url.png')">正文</p>` +
      `<figure id="fig_001" data-app-generation="htmlImage" data-app-size="wide"><img alt="x" data-app-asset-ref="figure.png" src="${base}/html-figure-src.png"><figcaption>图 1</figcaption></figure>`,
    export_format: { page: DECORATED_PAGE },
  });
  const files = () => requestFiles(request(), { 'figure.png': grayPng(30, 20) });

  it('requests nothing from the decoration or the restricted HTML inside the sandbox', async () => {
    requests.length = 0;
    const run = await exportIn('export-preview', files(), { hook: hookFiles(maliciousSvg(base), false) });
    const { docx } = outputOf(run);
    expect(docxText(docx)).toContain('正文');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(requests).toEqual([]);
  });

  it('control: without --network none the decoration does request its external references', async () => {
    requests.length = 0;
    const weakened = preview.weakenedDriver((spec) => {
      spec.HostConfig.NetworkMode = 'bridge';
    });
    outputOf(await exportIn('export-preview', files(), { hook: hookFiles(maliciousSvg(base), false), driver: weakened }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    // 实际被请求的地址写进 CI 日志：装饰（Chromium）的请求证明探测有效；受限 HTML 中的地址（/html-*）是否被助手请求一并记录。
    console.info(JSON.stringify({ externalReferencesControl: [...new Set(requests)].sort() }));
    expect(requests.some((path) => path.startsWith('/svg-') || path.startsWith('/foreign-object-'))).toBe(true);
  });
});

describe.runIf(sandboxEnv.exportImage)('isolation between exports', () => {
  it.each(['export-preview', 'export-document'] as const)('%s: a new sandbox sees nothing of the previous export', async (template) => {
    const secret = `SECRET-${randomUUID()}`;
    // 整本导出的配图要在 7.4 组装的范围标记内，这里只有样张带配图；两者都放入一张配图。
    const figure = template === 'export-preview' ? `<figure id="fig_001" data-app-generation="htmlImage" data-app-size="wide"><img alt="x" data-app-asset-ref="secret.png"><figcaption>${secret}</figcaption></figure>` : '';
    const first = await exportIn(
      template,
      requestFiles({ html: `<p>${secret}</p>${figure}`, export_format: { page: { ...DECORATED_PAGE, header_text: secret } } }, { 'secret.png': grayPng(64, 48) }),
    );
    expect(docxText(outputOf(first).docx)).toContain(secret);
    const harness = harnessOf(template);
    // 上一次导出的沙箱中留下了输入、装饰 PNG、助手的任务目录和浏览器配置目录。
    const leftovers = await harness.run(first.ref, ['sh', '-c', 'find /work /tmp -mindepth 1 | sort']);
    expect(leftovers.stdout).toContain('/work/openxml-jobs/export/document.docx');
    expect(leftovers.stdout).toContain('/work/chrome/header.png');

    const second = await harness.createSandbox();
    const listing = await harness.run(second, ['sh', '-c', `find ${['/work', '/output', '/tmp'].join(' ')} -mindepth 1; grep -rl ${secret} /work /output /tmp 2>/dev/null; echo done`]);
    expect(listing.stdout.trim()).toBe('done');
    await harness.driver.copyIn(second, requestFiles({ html: '<p>第二次导出</p>', export_format: { page: DECORATED_PAGE } }));
    const result = await harness.driver.exec(second, 'export', []);
    expect(result.exitCode, result.stdout).toBe(0);
    const files = await harness.driver.copyOut(second);
    const text = docxText(readZipEntries(files.find((file) => file.path === 'document.docx')!.data));
    expect(text).toContain('第二次导出');
    expect(text).not.toContain(secret);
  });
});
