// render-mermaid 入口（server/sandbox/render-mermaid/，8.8b）不需要 Docker 的部分：请求校验、说明的清理、PNG 尺寸读取，
// 页面的安全设置（CSP 只允许两个固定脚本、Mermaid 的 strict 与锁定的设置、源码只作为参数传入），以及入口、镜像与 worker 三处的约定一致
// （上限、启动参数、镜像中复制的文件、依赖版本与前端 / export 镜像相同）。真实沙箱中的转图与注入样本见 tests/sandbox/docker/renderMermaid.test.ts。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MERMAID_CAPTURE_SCALE, MERMAID_MAX_MESSAGE_CHARS } from '../../src/render/mermaidImages.ts';
import {
  RENDER_MERMAID_MAX_CODE_BYTES,
  RENDER_MERMAID_MAX_HEIGHT,
  RENDER_MERMAID_MAX_ITEMS,
  RENDER_MERMAID_MAX_PNG_BYTES,
  RENDER_MERMAID_MAX_TOTAL_CODE_BYTES,
  RENDER_MERMAID_MAX_WIDTH,
} from '../../src/sandbox/templates.ts';
// @ts-expect-error 沙箱镜像中的 JavaScript 模块，没有类型声明。
import * as entry from '../../sandbox/render-mermaid/mermaidImage.mjs';

const sandboxDirectory = new URL('../../sandbox/render-mermaid/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, sandboxDirectory), 'utf8');
const pageScript = read('page.js');

const item = { id: 'm001', code: 'flowchart TD\n  A --> B' };

describe('parseRenderMermaidRequest', () => {
  it('accepts the request built by the worker', () => {
    expect(entry.parseRenderMermaidRequest({ version: 1, items: [item, { id: 'm002', code: '图' }] })).toEqual([item, { id: 'm002', code: '图' }]);
  });

  it.each([
    ['not an object', []],
    ['another version', { version: 2, items: [item] }],
    ['an extra field', { version: 1, items: [item], extra: 1 }],
    ['no items', { version: 1, items: [] }],
    ['too many items', { version: 1, items: Array.from({ length: 51 }, (_, index) => ({ id: `m${index}`, code: 'x' })) }],
    ['an item with an extra field', { version: 1, items: [{ ...item, config: { securityLevel: 'loose' } }] }],
    ['an item without code', { version: 1, items: [{ id: 'm001' }] }],
    ['blank code', { version: 1, items: [{ id: 'm001', code: ' \n ' }] }],
    ['non-string code', { version: 1, items: [{ id: 'm001', code: 1 }] }],
    ['a bad id', { version: 1, items: [{ ...item, id: '../m001' }] }],
    ['a duplicate id', { version: 1, items: [item, item] }],
    ['code over 64 KiB', { version: 1, items: [{ id: 'm001', code: 'x'.repeat(64 * 1024 + 1) }] }],
    ['code over 64 KiB in UTF-8', { version: 1, items: [{ id: 'm001', code: '图'.repeat(21_846) }] }],
    ['a batch over 1 MiB', { version: 1, items: Array.from({ length: 17 }, (_, index) => ({ id: `m${index}`, code: 'x'.repeat(64 * 1024) })) }],
  ])('rejects %s', (_name, raw) => {
    expect(() => entry.parseRenderMermaidRequest(raw)).toThrow(expect.objectContaining({ code: 'request_invalid' }));
  });

  it('accepts code of exactly 64 KiB and a batch of exactly 1 MiB', () => {
    expect(entry.parseRenderMermaidRequest({ version: 1, items: Array.from({ length: 16 }, (_, index) => ({ id: `m${index}`, code: 'x'.repeat(64 * 1024) })) })).toHaveLength(16);
  });
});

describe('sanitizeMessage', () => {
  it('keeps visible text and line breaks, drops control and bidi characters, and truncates', () => {
    expect(entry.sanitizeMessage('Parse error on line 2:\n...A[\n---^')).toBe('Parse error on line 2:\n...A[\n---^');
    expect(entry.sanitizeMessage('a\u0000b\u001bc‮d​e')).toBe('abcde');
    expect(entry.sanitizeMessage('x'.repeat(5000))).toHaveLength(1000);
    expect(entry.sanitizeMessage('')).toBe('Mermaid 渲染失败');
    expect(entry.sanitizeMessage(' \u0000 ')).toBe('Mermaid 渲染失败');
    expect(entry.sanitizeMessage(undefined)).toBe('Mermaid 渲染失败');
    expect(entry.sanitizeMessage('\ud800')).toBe('Mermaid 渲染失败');
  });
});

describe('pngSize', () => {
  it('reads the IHDR size and rejects other data', () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(2040, 16);
    png.writeUInt32BE(3306, 20);
    expect(entry.pngSize(png)).toEqual({ width: 2040, height: 3306 });
    expect(entry.pngSize(Buffer.from('<svg/>'))).toBeNull();
  });
});

describe('page security settings', () => {
  it('only lets the two fixed scripts run and loads nothing else', () => {
    const csp = entry.PAGE_CSP as string;
    const directives = Object.fromEntries(csp.split('; ').map((directive) => [directive.split(' ')[0], directive.split(' ').slice(1)]));
    expect(directives['default-src']).toEqual(["'none'"]);
    expect(directives['script-src']).toEqual(['http://mermaid.invalid/mermaid.min.js', 'http://mermaid.invalid/page.js']);
    // 只允许内联样式（Mermaid 把样式写在 SVG 的 <style> 中）；不允许内联脚本、事件属性与 eval。
    expect(directives['style-src']).toEqual(["'unsafe-inline'"]);
    expect(csp).not.toMatch(/unsafe-eval|unsafe-hashes|nonce-|sha256-|data:|blob:|\*/);
    for (const name of ['img-src', 'font-src', 'connect-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src', 'manifest-src', 'form-action', 'base-uri']) {
      expect(directives[name], name).toEqual(["'none'"]);
    }
    // 页面本身同样带这份 CSP（响应头另有一份），只有两个外部脚本、没有内联脚本。
    const html = entry.PAGE_HTML as string;
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script src="http://mermaid.invalid/mermaid.min.js">', '<script src="http://mermaid.invalid/page.js">']);
    expect(html).not.toMatch(/<script>|\son[a-z]+=/);
  });

  it('serves the page with the CSP header and aborts every other request', () => {
    const source = read('mermaidImage.mjs');
    expect(source).toContain("'content-security-policy': PAGE_CSP");
    expect(source).toContain("return route.abort('blockedbyclient');");
    expect(source).toMatch(/offline: true,\n\s+serviceWorkers: 'block',\n\s+acceptDownloads: false,\n\s+bypassCSP: false,/);
  });

  it('passes the AI code only as an argument to the page script, never into the page', () => {
    const source = read('mermaidImage.mjs');
    expect(source).toContain('page.evaluate((code) => window.__zhibiaoMermaid.render(code), item.code)');
    expect(source).not.toMatch(/setContent|addScriptTag|addInitScript|exposeFunction/);
    expect(read('entry.mjs')).not.toMatch(/setContent|addScriptTag|addInitScript|exposeFunction|\.svg/);
  });

  it('renders in strict mode, without HTML labels, and locks the settings a diagram directive could use against the page', () => {
    const secure = /const SECURE_KEYS = (\[.*\]);/.exec(pageScript)![1]!;
    const keys = JSON.parse(secure.replaceAll("'", '"')) as string[];
    // Mermaid 默认锁定的设置之外，另锁定 HTML 标签、清理规则与可写入 CSS 的设置。
    for (const key of ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'dompurifyConfig', 'themeCSS', 'fontFamily', 'altFontFamily']) {
      expect(keys, key).toContain(key);
    }
    const config = /const CONFIG = (\{.*\});/.exec(pageScript)![1]!;
    expect(config).toContain("securityLevel: 'strict'");
    expect(config).toContain('htmlLabels: false, flowchart: { htmlLabels: false }');
    expect(config).toContain('startOnLoad: false');
    expect(pageScript).toContain('mermaid.initialize({ ...CONFIG, secure: SECURE_KEYS });');
    // 页面脚本不调用 bindFunctions（click 回调只在 loose 下才有），也不使用 eval。
    expect(pageScript).not.toMatch(/bindFunctions|eval\(|new Function|loose/);
  });

  it('uses the desktop layout rules and caps the PNG at the render-html pixel limit', () => {
    const desktop = readFileSync(new URL('../../../client/electron/services/localImageRenderService.cjs', import.meta.url), 'utf8');
    expect(desktop).toContain(`const WORD_FRIENDLY_RENDER_WIDTH = ${entry.RENDER_WIDTH};`);
    expect(desktop).toContain(`const MERMAID_CAPTURE_SCALE = ${entry.CAPTURE_SCALE};`);
    expect(desktop).toContain("mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });");
    expect(desktop).toContain('if (rawWidth < 24 || rawHeight < 24) {');
    expect(entry.MIN_CONTENT_SIZE).toBe(24);
    expect(pageScript).toContain(`const MAX_WIDTH = ${entry.RENDER_WIDTH - 16};`);
    expect(pageScript).toContain(`const MAX_HEIGHT = ${entry.MAX_CAPTURE_HEIGHT - 16};`);
    expect(entry.MAX_CAPTURE_HEIGHT).toBe(Math.floor(3306 / entry.CAPTURE_SCALE));
  });
});

describe('entry, image and worker agree', () => {
  it('use the same limits', () => {
    expect(entry.MAX_ITEMS).toBe(RENDER_MERMAID_MAX_ITEMS);
    expect(entry.MAX_CODE_BYTES).toBe(RENDER_MERMAID_MAX_CODE_BYTES);
    expect(entry.MAX_TOTAL_CODE_BYTES).toBe(RENDER_MERMAID_MAX_TOTAL_CODE_BYTES);
    expect(entry.MAX_PNG_BYTES).toBe(RENDER_MERMAID_MAX_PNG_BYTES);
    expect(entry.MAX_OUTPUT_WIDTH).toBe(RENDER_MERMAID_MAX_WIDTH);
    expect(entry.MAX_OUTPUT_HEIGHT).toBe(RENDER_MERMAID_MAX_HEIGHT);
    expect(entry.CAPTURE_SCALE).toBe(MERMAID_CAPTURE_SCALE);
    expect(entry.MAX_MESSAGE_CHARS).toBe(MERMAID_MAX_MESSAGE_CHARS);
    expect(entry.ITEM_TIMEOUT_MS).toBe(30_000);
    expect(pageScript).toContain(`const MAX_MESSAGE_CHARS = ${MERMAID_MAX_MESSAGE_CHARS};`);
    // maxTextSize 不小于每段的字节上限：Mermaid 不会把源码换成“超出大小”的提示图。
    expect(pageScript).toContain(`maxTextSize: ${RENDER_MERMAID_MAX_CODE_BYTES}`);
  });

  it('launch Chromium like the export image', () => {
    // export/render.mjs 引用 playwright-core（单元测试中没有安装），按源码读出两处常量。
    const exportRender = readFileSync(new URL('../../sandbox/export/render.mjs', import.meta.url), 'utf8');
    const args = /export const LAUNCH_ARGS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(exportRender)![1]!;
    expect([...entry.LAUNCH_ARGS]).toEqual([...args.matchAll(/'([^']+)'/g)].map((match) => match[1]));
    expect(exportRender).toContain(`export const CHROMIUM_EXECUTABLE = '${entry.CHROMIUM_EXECUTABLE}';`);
    expect(read('Dockerfile')).toContain('RUN ln -s "$(readlink -f /opt/ms-playwright/current)" /opt/chromium');
  });

  it('copy only the entry, the page script and the browser bundle of mermaid into the image', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/^COPY --chmod=0644 package\.json entry\.mjs mermaidImage\.mjs page\.js \/opt\/render-mermaid\/$/m);
    expect(dockerfile).toContain(`COPY --chmod=0644 --from=deps /opt/render-mermaid/node_modules/mermaid/dist/mermaid.min.js ${entry.MERMAID_SCRIPT_PATH}`);
    expect(entry.PAGE_SCRIPT_PATH).toBe('/opt/render-mermaid/page.js');
    expect(dockerfile).toContain('COPY --from=deps /opt/render-mermaid/node_modules/playwright-core /opt/render-mermaid/node_modules/playwright-core');
    expect(dockerfile).toContain('npm ci --omit=dev --ignore-scripts');
    // 与 export 镜像分开：不复制 OpenXmlHelper、桌面版代码与导出入口。
    const copies = dockerfile.split('\n').filter((line) => line.startsWith('COPY'));
    expect(copies).toHaveLength(5);
    for (const line of copies) expect(line).not.toMatch(/openxmlhelper|desktop|export|render-html|htmlImage|chrome=/i);
    expect(read('entry.mjs')).toContain("from './mermaidImage.mjs'");
  });

  it('pin mermaid to the frontend version and playwright-core to the export image version, with the same lockfile entries', () => {
    const manifest = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, Record<string, unknown>> };
    const client = JSON.parse(readFileSync(new URL('../../../client/package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, Record<string, unknown>> };
    const exportLock = JSON.parse(readFileSync(new URL('../../sandbox/export/package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, Record<string, unknown>> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['mermaid', 'playwright-core']);
    expect(manifest.dependencies.mermaid).toBe(client.packages['node_modules/mermaid']!.version);
    expect(manifest.dependencies['playwright-core']).toBe(exportLock.packages['node_modules/playwright-core']!.version);
    const entries = Object.entries(lock.packages).filter(([key]) => key !== '');
    expect(entries.length).toBeGreaterThan(10);
    for (const [key, value] of entries) {
      const original = key === 'node_modules/playwright-core' ? exportLock.packages[key] : client.packages[key];
      expect(original, key).toBeDefined();
      for (const field of ['version', 'resolved', 'integrity', 'license', 'dependencies']) expect(value[field], `${key} ${field}`).toEqual(original![field]);
      expect(value.hasInstallScript, key).toBeUndefined();
    }
  });
});
