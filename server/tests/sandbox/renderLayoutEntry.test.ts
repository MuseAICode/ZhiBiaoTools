// render-layout 入口（server/sandbox/render-layout/，8.8c）不需要 Docker 的部分：
// 1. 版式投影与桌面版格式自检等价：samples/docx-editor-layout-*.json.gz 是 docx-editor 2.15.0（打上 client/patches 的补丁）在 Chromium 中
//    对 docxFixtures.ts 的 sampleLayoutDocx()（单栏 s1 / 两栏 s2）用 Canvas 测量得到的完整版式结果；桌面版的 analyzeLayout
//    （client/electron/services/contentGenerationLayout.cjs）读完整结果与读投影结果给出相同的留白（且确实找到留白），投影不含其余字段；
// 2. 页面的安全设置：CSP 只允许一个页面脚本、只允许读取 docx 的固定地址，没有内联脚本、eval 与 WebAssembly；页面脚本的做法与桌面版
//    wordLayoutPreload.cjs 相同（Canvas 测量器、openDocumentForExport、用完 dispose）；
// 3. 入口、镜像与 worker 三处的约定一致：上限、启动参数、书签名规则、镜像中复制的文件、docx-editor 版本与补丁、依赖与前端 / export 镜像相同。
// 真实沙箱中的测量与样本见 tests/sandbox/docker/renderLayout.test.ts。
//
// 重新生成 samples 中的完整版式（升级 docx-editor 或修改 sampleLayoutDocx 时）：用 build-page.mjs 同样的方式打一个只暴露
// session.layout() 原始结果的测试页面，在 Chromium 中打开 sampleLayoutDocx() / sampleLayoutDocx({ twoColumn: true }) 的输出，
// 把 JSON 结果 gzip 后保存。
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LAYOUT_BOOKMARK, parseWordLayout } from '../../src/render/wordLayout.ts';
import { RENDER_LAYOUT_MAX_DOCX_BYTES, RENDER_LAYOUT_MAX_LAYOUT_BYTES, SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
// @ts-expect-error 沙箱镜像中的 JavaScript 模块，没有类型声明。
import * as projection from '../../sandbox/render-layout/layoutProjection.mjs';
// @ts-expect-error 沙箱镜像中的 JavaScript 模块，没有类型声明。
import * as entry from '../../sandbox/render-layout/wordLayout.mjs';
// @ts-expect-error 沙箱镜像中的 JavaScript 模块，没有类型声明。
import * as mermaid from '../../sandbox/render-mermaid/mermaidImage.mjs';

const sandboxDirectory = new URL('../../sandbox/render-layout/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, sandboxDirectory), 'utf8');
const clientRoot = new URL('../../../client/', import.meta.url);
const { analyzeLayout } = createRequire(import.meta.url)('../../../client/electron/services/contentGenerationLayout.cjs') as {
  analyzeLayout: (layout: unknown, sources: unknown[], targetIds: Set<string>, twoColumn?: boolean) => Array<Record<string, unknown>>;
};
const fullLayout = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`samples/docx-editor-layout-${name}.json.gz`, import.meta.url))).toString('utf8')) as Record<string, unknown>;
const sources = [
  { name: 'app_layout_0', section_id: 's1', file: '第一章.html', block_index: 12, figure_ids: ['fig-1'], text: '总体架构图', image: true },
  { name: 'app_layout_1', section_id: 's1', file: '第一章.html', block_index: 20, figure_ids: ['fig-2'], text: '部署图', image: true },
];

describe('layout projection', () => {
  it.each([
    ['s1', false],
    ['s2', true],
  ])('gives the desktop analyzeLayout the same gaps as the full docx-editor layout (%s, two columns: %s)', (name, twoColumn) => {
    const full = fullLayout(name);
    const projected = JSON.parse(JSON.stringify(projection.projectLayout(full)));
    const expected = analyzeLayout(full, sources, new Set(['s1']), twoColumn);
    expect(expected.length).toBeGreaterThan(0);
    expect(analyzeLayout(projected, sources, new Set(['s1']), twoColumn)).toEqual(expected);
    // 另一节为目标时两者都没有留白。
    expect(analyzeLayout(projected, sources, new Set(['s2']), twoColumn)).toEqual(analyzeLayout(full, sources, new Set(['s2']), twoColumn));
    // 投影通过 worker 的校验。
    expect(parseWordLayout(projected)).toEqual(projected);
  });

  it('keeps only what the layout check reads', () => {
    const full = fullLayout('s1');
    const text = JSON.stringify(projection.projectLayout(full));
    expect(text.length).toBeLessThan(JSON.stringify(full).length / 5);
    for (const dropped of ['rFonts', 'fontFamily', 'attributes', 'revision', 'contentControls', 'documentMetadata', 'paintBounds', 'unrelated_bookmark', 'pageStack', 'range']) {
      expect(text, dropped).not.toContain(dropped);
    }
    expect(text).toContain('"localName":"pageBreakBefore"');
    expect(text).toContain('第一章 总体方案');
  });

  it('turns missing and non-finite values into values the worker rejects or reads the same way', () => {
    const layout = projection.projectLayout({
      pages: [{ index: 0, contentBox: { width: 100, height: 200 }, fragments: [
        { kind: 'paragraph', paragraphId: 'p', fragmentIndex: 0, box: { x: 0, y: 0, width: 10, height: 10 }, spacing: { before: Number.NaN }, lines: [{ box: { height: 5 }, spans: [{ text: 'a' }, {}, { text: 'b' }] }] },
        { kind: 'floating', box: { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 } },
      ] }],
      destinations: [{ anchor: { name: 'app_layout_3', paragraphId: 'p' } }, { anchor: { name: '_GoBack', paragraphId: 'p' } }],
    });
    expect(layout.pages[0].fragments[0]).toEqual({
      kind: 'paragraph', paragraphId: 'p', fragmentIndex: 0, box: { x: 0, y: 0, width: 10, height: 10 }, styleId: null, outlineLevel: null, props: [],
      spacing: { before: 0, after: 0 }, lines: [{ box: { height: 5 }, drawings: [], spans: [{ text: 'ab' }] }],
    });
    expect(layout.destinations).toEqual([{ anchor: { name: 'app_layout_3', paragraphId: 'p' } }]);
    // 无穷大经 JSON 变为 null，worker 拒绝。
    expect(() => parseWordLayout(JSON.parse(JSON.stringify(layout)))).toThrow(/number is out of range/);
  });

  it('uses the same bookmark rule as the worker and as OpenXmlHelper', () => {
    expect(projection.LAYOUT_BOOKMARK.source).toBe(LAYOUT_BOOKMARK.source);
    const renderer = readFileSync(new URL('../../../openxmlhelper/src/OpenXmlHelper/Jobs/RestrictedHtmlDocumentRenderer.cs', import.meta.url), 'utf8');
    expect(renderer).toContain('const string prefix = "APPMARKLAYOUT:app_layout_";');
    expect(readFileSync(new URL('electron/services/technicalPlanExport.cjs', clientRoot), 'utf8')).toContain('const name = `app_layout_${layoutSources.length}`;');
  });
});

describe('render-layout page', () => {
  const page = read('page.mjs');

  it('allows only the page script and only the docx address, without inline scripts, eval or WebAssembly', () => {
    const directives = Object.fromEntries(entry.PAGE_CSP.split('; ').map((directive: string) => [directive.split(' ')[0], directive.split(' ').slice(1).join(' ')]));
    expect(directives['default-src']).toBe("'none'");
    expect(directives['script-src']).toBe('http://layout.invalid/docx-layout.js');
    expect(directives['connect-src']).toBe('http://layout.invalid/document.docx');
    for (const name of ['img-src', 'font-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src', 'manifest-src', 'form-action', 'base-uri']) expect(directives[name], name).toBe("'none'");
    expect(entry.PAGE_CSP).not.toMatch(/unsafe-eval|wasm-unsafe-eval|strict-dynamic|data:|blob:|\*/);
    expect(entry.PAGE_HTML.match(/<script\b[^>]*>/g)).toEqual(['<script src="http://layout.invalid/docx-layout.js">']);
    expect(entry.PAGE_HTML).toContain('</script>');
    expect(entry.PAGE_HTML.replace(/<script src="[^"]+"><\/script>/, '')).not.toMatch(/<script|\son[a-z]+\s*=/i);
    expect(page).toContain(`const DOCUMENT_URL = '${entry.DOCUMENT_URL}';`);
  });

  it('routes only the page, the page script and the docx (once), and aborts everything else', () => {
    const source = read('wordLayout.mjs');
    expect(source).toContain("if (url === DOCUMENT_URL && request.method() === 'GET' && !served) {");
    expect(source).toContain("return route.abort('blockedbyclient');");
    expect(source).toMatch(/offline: true,\n\s+serviceWorkers: 'block',\n\s+acceptDownloads: false,\n\s+bypassCSP: false,/);
    // docx 不经 evaluate 的参数传入，页面脚本自己读取。
    expect(source).toContain('page.evaluate(() => window.__zhibiaoLayout.read())');
  });

  it('measures like the desktop preload: canvas measurer, openDocumentForExport, dispose', () => {
    const preload = readFileSync(new URL('electron/services/wordLayoutPreload.cjs', clientRoot), 'utf8');
    for (const line of [
      'await document.fonts.ready;',
      "const metrics = resolveDefaultSurfaceMeasurer(96 / 72, { context: document.createElement('canvas').getContext('2d') });",
      "if (metrics.producer !== 'canvas-measurer')",
      'opened.session.dispose();',
    ]) {
      expect(preload, line).toContain(line);
      expect(page, line).toContain(line);
    }
    expect(preload).toContain('openDocumentForExport(new Uint8Array(fs.readFileSync(file)), { measurer: metrics.measurer, producer: metrics.producer })');
    expect(page).toContain('openDocumentForExport(bytes, { measurer: metrics.measurer, producer: metrics.producer })');
    expect(page).toContain('projectLayout(await opened.session.layout())');
    expect(page).toContain("import { openDocumentForExport } from '@docx-editor.dev/core/export';");
    expect(page).toContain("import { resolveDefaultSurfaceMeasurer } from '@docx-editor.dev/core/layout';");
  });

  it('builds one bundle with stubs for the Node loaders and HarfBuzz, and checks it for eval, WebAssembly and the patch', () => {
    const build = read('build-page.mjs');
    expect(build).toContain("const EXPECTED_STUBS = ['fs', 'fs/promises', 'harfbuzz', 'path', 'url'];");
    expect(build).toContain("for (const forbidden of ['WebAssembly', 'new Function', 'eval(', 'import(']) {");
    expect(build).toContain("if (!script.includes('app-keep-probe')) throw new Error('the docx-editor patch is not applied');");
    expect(build).toContain("format: 'iife',");
    expect(readFileSync(new URL('patches/@docx-editor.dev+core+2.15.0.patch', clientRoot), 'utf8')).toContain('app-keep-probe');
  });
});

describe('render-layout entry, image and worker agree', () => {
  it('shares the limits with the template and the worker', () => {
    const template = SANDBOX_TEMPLATES['render-layout'];
    expect(entry.MAX_DOCX_BYTES).toBe(RENDER_LAYOUT_MAX_DOCX_BYTES);
    expect(entry.MAX_LAYOUT_BYTES).toBe(RENDER_LAYOUT_MAX_LAYOUT_BYTES);
    expect(template.input.maxFileBytes).toBe(RENDER_LAYOUT_MAX_DOCX_BYTES);
    expect(template.output.maxFileBytes).toBe(RENDER_LAYOUT_MAX_LAYOUT_BYTES);
    // 入口的时限比命令墙钟短（到时仍能写出错误代码），并留出启动浏览器的时间。
    expect(entry.LAYOUT_TIMEOUT_MS + 20_000 + 10_000).toBeLessThan(template.commands.measure!.timeoutMs);
    expect(read('entry.mjs')).toContain("const INPUT_NAME = 'document.docx';");
    expect(read('entry.mjs')).toContain("const LAYOUT_NAME = 'layout.json';");
  });

  it('launches Chromium exactly like the export and render-mermaid images', () => {
    // export/render.mjs 引用 playwright-core（单元测试中没有安装），按源码读出常量。
    const exportRender = readFileSync(new URL('../../sandbox/export/render.mjs', import.meta.url), 'utf8');
    const args = /export const LAUNCH_ARGS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(exportRender)![1]!;
    expect([...entry.LAUNCH_ARGS]).toEqual([...args.matchAll(/'([^']+)'/g)].map((match) => match[1]));
    expect(exportRender).toContain(`export const CHROMIUM_EXECUTABLE = '${entry.CHROMIUM_EXECUTABLE}';`);
    expect(read('Dockerfile')).toContain('RUN ln -s "$(readlink -f /opt/ms-playwright/current)" /opt/chromium');
    expect(entry.LAUNCH_ARGS).toEqual(mermaid.LAUNCH_ARGS);
    expect(entry.CHROMIUM_EXECUTABLE).toBe(mermaid.CHROMIUM_EXECUTABLE);
    expect(read('entry.mjs')).toContain("env: { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' },");
  });

  it('accepts only a ZIP of at most 100 MiB', () => {
    expect(entry.checkDocx(Buffer.from('PK\x03\x04rest'))).toBeInstanceOf(Buffer);
    for (const bad of [Buffer.from('PK'), Buffer.from('%PDF-1.7'), Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(RENDER_LAYOUT_MAX_DOCX_BYTES)]), 'PK\x03\x04']) {
      expect(() => entry.checkDocx(bad)).toThrow(expect.objectContaining({ code: 'request_invalid' }));
    }
  });

  it('copies only the entry, the bundle, playwright-core and the shared font mapping into the image', () => {
    const dockerfile = read('Dockerfile');
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf('FROM ${NODE_IMAGE}'));
    const copies = finalStage.split('\n').filter((line) => line.startsWith('COPY'));
    expect(copies).toEqual([
      'COPY --chmod=0644 --from=fonts 65-zhibiao-cjk.conf /etc/fonts/conf.d/65-zhibiao-cjk.conf',
      'COPY --from=deps /opt/ms-playwright /opt/ms-playwright',
      'COPY --from=deps /opt/render-layout/node_modules/playwright-core /opt/render-layout/node_modules/playwright-core',
      'COPY --chmod=0644 --from=deps /opt/render-layout/assets/docx-layout.js /opt/render-layout/assets/docx-layout.js',
      'COPY --chmod=0644 package.json entry.mjs wordLayout.mjs /opt/render-layout/',
    ]);
    expect(dockerfile).toContain('--build-context patches=client/patches');
    expect(dockerfile).toContain('--build-context fonts=server/sandbox/export/fonts');
    expect(dockerfile).toContain('COPY --from=patches @docx-editor.dev+core+2.15.0.patch /tmp/docx-editor.patch');
    expect(dockerfile).toContain('patch -p1 --forward --batch --fuzz=0 --no-backup-if-mismatch < /tmp/docx-editor.patch');
    expect(dockerfile).toContain('npm ci --ignore-scripts --no-audit --no-fund');
    expect(readdirSync(new URL('patches/', clientRoot))).toEqual(['@docx-editor.dev+core+2.15.0.patch']);
    expect(read('entry.mjs')).toContain("from './wordLayout.mjs'");
  });

  it('pins docx-editor and esbuild to the frontend versions and playwright-core to the export image version, with the same lockfile entries', () => {
    const manifest = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, Record<string, unknown>> };
    const client = JSON.parse(readFileSync(new URL('package-lock.json', clientRoot), 'utf8')) as { packages: Record<string, Record<string, unknown>> };
    const clientManifest = JSON.parse(readFileSync(new URL('package.json', clientRoot), 'utf8')) as { dependencies: Record<string, string> };
    const exportLock = JSON.parse(readFileSync(new URL('../../sandbox/export/package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, Record<string, unknown>> };
    expect(manifest.dependencies).toEqual({ 'playwright-core': exportLock.packages['node_modules/playwright-core']!.version });
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(['@docx-editor.dev/core', 'esbuild']);
    expect(manifest.devDependencies['@docx-editor.dev/core']).toBe(clientManifest.dependencies['@docx-editor.dev/core']);
    for (const name of Object.keys(manifest.devDependencies)) expect(manifest.devDependencies[name], name).toBe(client.packages[`node_modules/${name}`]!.version);
    const entries = Object.entries(lock.packages).filter(([key]) => key !== '');
    expect(entries.length).toBeGreaterThan(20);
    for (const [key, value] of entries) {
      const original = key === 'node_modules/playwright-core' ? exportLock.packages[key] : client.packages[key];
      expect(original, key).toBeDefined();
      for (const field of ['version', 'resolved', 'integrity', 'license', 'dependencies', 'optionalDependencies']) expect(value[field], `${key} ${field}`).toEqual(original![field]);
      // 只有 esbuild 有安装脚本（构建阶段 --ignore-scripts，不执行；平台二进制来自 @esbuild/linux-x64）。
      expect(value.hasInstallScript, key).toBe(key === 'node_modules/esbuild' ? true : undefined);
      // 构建阶段的依赖不进入最终镜像（只复制 playwright-core 与打出的页面脚本）。
      expect(value.dev, key).toBe(key === 'node_modules/playwright-core' ? undefined : true);
    }
  });
});
