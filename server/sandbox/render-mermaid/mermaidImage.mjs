// render-mermaid 沙箱中的 Mermaid 转 PNG（路线图第 8 步 8.8b；“第 8 步说明”第 3 项，#61 决定事项第 4 项）。
// Mermaid 只能由 mermaid.js 在浏览器中排版，必须执行脚本；执行的只有镜像中按版本固定的 mermaid.min.js 与平台的入口页面脚本
// （page.js），AI 写的源码只作为数据传入。与 render-html、export、agent 模板分开：专用镜像（只有 Chromium、mermaid.min.js 与本入口）、
// 专用模板（断网、gVisor、只读根文件系统、非 root、无能力，每次调用一个沙箱、用完即毁）。
//
// 每段源码一个新的浏览器上下文（没有任何存储，之间不共享状态）：
// - 页面、mermaid.min.js 与 page.js 由 Playwright 的路由在固定地址 http://mermaid.invalid/ 直接给出（不落盘、不经网络），
//   其余请求一律中止；上下文离线、禁止 Service Worker；沙箱本身断网（--network none）；
// - 页面的 CSP（PAGE_CSP）只允许这两个脚本执行，不允许内联脚本、事件属性、javascript: 与 eval，图片、字体、样式表、连接、框架一律不允许
//   加载（只允许内联样式：Mermaid 把样式写在 SVG 的 <style> 中）；
// - Mermaid 设为 securityLevel 'strict'（click 回调不绑定、链接地址经清理），图表内的指令不能改变安全级别与 HTML 标签等设置
//   （page.js 的 SECURE_KEYS），HTML 标签关闭；
// - 只把截图（PNG）交出沙箱，Mermaid 生成的 SVG 只留在页面中，随上下文关闭；
// - 错误只给代码；Mermaid 的语法错误另给截断后的文字（diagram_invalid 的 message），worker 按不可信纯文本处理。
import { readFile } from 'node:fs/promises';

/** 每批至多 50 段，每段源码至多 64 KiB（UTF-8），合计至多 1 MiB（“第 8 步说明”第 3 项的起步值）。 */
export const MAX_ITEMS = 50;
export const MAX_CODE_BYTES = 64 * 1024;
export const MAX_TOTAL_CODE_BYTES = 1024 * 1024;
/** 每张 PNG 至多 10 MiB（与上传图片上限一致）。 */
export const MAX_PNG_BYTES = 10 * 1024 * 1024;
/** 每段（加载页面、渲染、截图）的时限。 */
export const ITEM_TIMEOUT_MS = 30_000;
/** 段标识：worker 分配，也是输出文件名（<id>.png）。 */
export const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 与桌面版相同：参考宽度 680（约 A4 正文可用宽）、3 倍像素输出；内容小于 24 像素视为未正确渲染。 */
export const RENDER_WIDTH = 680;
export const CAPTURE_SCALE = 3;
export const MIN_CONTENT_SIZE = 24;
/** 截图的 CSS 高度上限：PNG 不超过 3306 像素高（render-html 的像素上限，page.js 按它等比缩小过高的图）。 */
export const MAX_CAPTURE_HEIGHT = 1102;
export const MAX_OUTPUT_WIDTH = RENDER_WIDTH * CAPTURE_SCALE;
export const MAX_OUTPUT_HEIGHT = MAX_CAPTURE_HEIGHT * CAPTURE_SCALE;
/** diagram_invalid 的说明至多 1000 个字符。 */
export const MAX_MESSAGE_CHARS = 1000;

/** 镜像构建时把 Playwright 下载的 chromium-headless-shell 目录链接到这里（server/sandbox/render-mermaid/Dockerfile）。 */
export const CHROMIUM_EXECUTABLE = '/opt/chromium/chrome-headless-shell';
/** 与 export 镜像的 LAUNCH_ARGS（server/sandbox/export/render.mjs）相同（测试核对）。 */
export const LAUNCH_ARGS = Object.freeze([
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
  '--metrics-recording-only',
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--force-color-profile=srgb',
]);

/** 镜像中的文件（server/sandbox/render-mermaid/Dockerfile）。 */
export const MERMAID_SCRIPT_PATH = '/opt/render-mermaid/assets/mermaid.min.js';
export const PAGE_SCRIPT_PATH = '/opt/render-mermaid/page.js';

export const PAGE_ORIGIN = 'http://mermaid.invalid';
export const PAGE_URL = `${PAGE_ORIGIN}/`;
export const MERMAID_SCRIPT_URL = `${PAGE_ORIGIN}/mermaid.min.js`;
export const PAGE_SCRIPT_URL = `${PAGE_ORIGIN}/page.js`;

/** 页面的 CSP：只允许两个固定脚本，其余一律不允许（内联样式除外）。 */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${MERMAID_SCRIPT_URL} ${PAGE_SCRIPT_URL}`,
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "font-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** 与桌面版 buildMermaidDocument 相同的页面样式；脚本只有两个外部脚本，没有内联脚本。 */
export const PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      width: fit-content;
      height: fit-content;
      overflow: hidden;
    }
    #app-capture-root {
      display: inline-block;
      margin: 0;
      padding: 8px;
      background: #ffffff;
      width: fit-content;
      height: fit-content;
      min-width: 1px;
      min-height: 1px;
      line-height: 0;
    }
    #app-capture-root svg {
      display: block;
    }
  </style>
  <script src="${MERMAID_SCRIPT_URL}"></script>
  <script src="${PAGE_SCRIPT_URL}"></script>
</head>
<body>
  <div id="app-capture-root"></div>
</body>
</html>`;

export class RenderMermaidError extends Error {
  constructor(code, message) {
    super(code);
    this.code = code;
    if (message !== undefined) this.detail = message;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验 request.json：{ version: 1, items: [{ id, code }] }，字段不多不少，每段至多 64 KiB、合计至多 1 MiB、1～50 段。
 * 不合法时抛 request_invalid。
 */
export function parseRenderMermaidRequest(raw) {
  const invalid = () => new RenderMermaidError('request_invalid');
  if (!isPlainObject(raw)) throw invalid();
  if (Object.keys(raw).sort().join(',') !== 'items,version' || raw.version !== 1 || !Array.isArray(raw.items)) throw invalid();
  if (raw.items.length === 0 || raw.items.length > MAX_ITEMS) throw invalid();
  const ids = new Set();
  let total = 0;
  return raw.items.map((item) => {
    if (!isPlainObject(item) || Object.keys(item).sort().join(',') !== 'code,id') throw invalid();
    const { id, code } = item;
    if (typeof id !== 'string' || !ITEM_ID.test(id) || ids.has(id)) throw invalid();
    ids.add(id);
    if (typeof code !== 'string' || code.trim() === '') throw invalid();
    const bytes = Buffer.byteLength(code, 'utf8');
    total += bytes;
    if (bytes > MAX_CODE_BYTES || total > MAX_TOTAL_CODE_BYTES) throw invalid();
    return { id, code };
  });
}

/** PNG 的宽高（IHDR）；不是 PNG 时为 null。 */
export function pngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 交回的说明只保留可见文字与换行、制表符，截到 1000 个字符；为空时用固定文字。 */
export function sanitizeMessage(raw) {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .slice(0, MAX_MESSAGE_CHARS);
  const trimmed = text.trim();
  return trimmed && text.isWellFormed() ? trimmed : 'Mermaid 渲染失败';
}

/** 读镜像中的两个脚本（入口启动时读一次）。 */
export async function loadPageAssets() {
  const [mermaidScript, pageScript] = await Promise.all([readFile(MERMAID_SCRIPT_PATH), readFile(PAGE_SCRIPT_PATH)]);
  return Object.freeze({ mermaidScript, pageScript });
}

/** 新建一个只认三个固定地址的浏览器上下文（允许页面脚本：受 CSP 约束，只有两个固定脚本能执行）。 */
export async function newMermaidContext(browser) {
  return browser.newContext({
    javaScriptEnabled: true,
    viewport: { width: RENDER_WIDTH, height: 1200 },
    deviceScaleFactor: CAPTURE_SCALE,
    offline: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
    bypassCSP: false,
  });
}

/**
 * 给上下文登记路由：页面（带 CSP 响应头）、mermaid.min.js 与 page.js 由路由直接给出，其余请求一律中止。
 * onBlocked 只供测试统计被中止的请求。
 */
export async function routeMermaidPage(context, assets, onBlocked) {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url === PAGE_URL) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP }, body: PAGE_HTML });
    }
    if (url === MERMAID_SCRIPT_URL) return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: assets.mermaidScript });
    if (url === PAGE_SCRIPT_URL) return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: assets.pageScript });
    onBlocked?.(url);
    return route.abort('blockedbyclient');
  });
}

/** 打开入口页面，确认两个脚本都已执行（__zhibiaoMermaid 存在）。 */
export async function openMermaidPage(context, deadline) {
  const page = await context.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: Math.max(1, deadline - Date.now()) });
  const ready = await page.evaluate(() => typeof window.__zhibiaoMermaid?.render === 'function');
  if (!ready) throw new RenderMermaidError('render_failed');
  return page;
}

async function withDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new RenderMermaidError('render_timeout')), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isDimension(value, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

/**
 * 转一段 Mermaid。返回 { png, width, height }（PNG 像素）；失败抛 RenderMermaidError
 * （render_timeout / render_failed / output_too_large / diagram_invalid，最后一种带 detail）。
 * options.onStuck：上下文关不掉时调用（入口随后丢弃这个浏览器、下一段重新启动）。
 */
export async function renderMermaidImage(browser, assets, item, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? ITEM_TIMEOUT_MS);
  let context;
  try {
    context = await withDeadline(newMermaidContext(browser), deadline);
    await routeMermaidPage(context, assets);
    const run = async () => {
      const page = await openMermaidPage(context, deadline);
      // 平台的代码，由 Playwright 求值：源码只作为字符串参数传给页面脚本。页面返回的内容同样按不可信处理。
      const result = await page.evaluate((code) => window.__zhibiaoMermaid.render(code), item.code);
      if (!isPlainObject(result)) throw new RenderMermaidError('render_failed');
      if (result.ok !== true) throw new RenderMermaidError('diagram_invalid', sanitizeMessage(result.message));
      const { width: rawWidth, height: rawHeight } = result;
      if (typeof rawWidth !== 'number' || typeof rawHeight !== 'number' || !Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) throw new RenderMermaidError('render_failed');
      if (rawWidth < MIN_CONTENT_SIZE || rawHeight < MIN_CONTENT_SIZE) {
        // 与桌面版相同的说明（不含源码）。
        throw new RenderMermaidError('diagram_invalid', `Mermaid 内容尺寸异常（${Math.max(0, Math.round(rawWidth))}x${Math.max(0, Math.round(rawHeight))}），可能未正确渲染`);
      }
      const width = Math.min(RENDER_WIDTH, Math.ceil(rawWidth));
      const height = Math.ceil(rawHeight);
      if (height > MAX_CAPTURE_HEIGHT) throw new RenderMermaidError('render_failed');
      const png = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width, height },
        animations: 'disabled',
        timeout: Math.max(1, deadline - Date.now()),
      });
      return { png, width: width * CAPTURE_SCALE, height: height * CAPTURE_SCALE };
    };
    const image = await withDeadline(run(), deadline);
    if (image.png.length > MAX_PNG_BYTES) throw new RenderMermaidError('output_too_large');
    const size = pngSize(image.png);
    if (!size || size.width !== image.width || size.height !== image.height || !isDimension(size.width, MAX_OUTPUT_WIDTH) || !isDimension(size.height, MAX_OUTPUT_HEIGHT)) {
      throw new RenderMermaidError('render_failed');
    }
    return image;
  } catch (error) {
    if (error instanceof RenderMermaidError) throw error;
    if (Date.now() >= deadline) throw new RenderMermaidError('render_timeout');
    throw new RenderMermaidError('render_failed');
  } finally {
    // 关闭上下文即结束它的渲染进程（包括仍在执行脚本、超时的页面，实测几毫秒）；关不掉时通知调用方换一个浏览器。
    if (context && !(await closeContext(context))) options.onStuck?.();
  }
}

/** 关闭上下文至多等这么久。 */
export const CONTEXT_CLOSE_TIMEOUT_MS = 10_000;
async function closeContext(context) {
  let timer;
  const closed = await Promise.race([
    context.close().then(() => true, () => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), CONTEXT_CLOSE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  return closed;
}
