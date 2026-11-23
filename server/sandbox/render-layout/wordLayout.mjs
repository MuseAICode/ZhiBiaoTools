// render-layout 沙箱中的 docx-editor 分页测量（路线图第 8 步 8.8c；“第 8 步说明”第 3 项，#61 决定事项第 4 项）。
// 格式自检要用与前端同一版本的 docx-editor 在浏览器中按 Canvas 字体测量排版，必须执行脚本；执行的只有镜像中由 build-page.mjs 打成的
// 页面脚本（平台的 page.mjs + layoutProjection.mjs + 按版本固定、打上 client/patches 补丁的 @docx-editor.dev/core），docx 只作为数据传入。
// 与 render-html、render-mermaid、export、agent 模板分开：专用镜像（只有 Chromium、字体、页面脚本与本入口）、专用模板
// （断网、gVisor、只读根文件系统、非 root、无能力，每次测量一个沙箱、用完即毁）。
//
// 一个新的浏览器上下文（没有任何存储）：
// - 页面、页面脚本与 docx 由 Playwright 的路由在固定地址 http://layout.invalid/ 直接给出（不落盘、不经网络），其余请求一律中止；
//   上下文离线、禁止 Service Worker；沙箱本身断网（--network none）；
// - 页面的 CSP（PAGE_CSP）只允许页面脚本执行（不允许内联脚本、事件属性、javascript:、eval 与 WebAssembly），connect-src 只允许
//   docx 的地址，图片、字体、样式表、框架、Worker 一律不允许加载；
// - 只把版式 JSON（layoutProjection.mjs 截取的字段）交出沙箱；错误只给代码。
import { readFile } from 'node:fs/promises';

/** 一个 docx 至多 100 MiB（与整本导出的输出上限一致，“第 8 步说明”第 3 项）。 */
export const MAX_DOCX_BYTES = 100 * 1024 * 1024;
/** 版式 JSON 至多 16 MiB。 */
export const MAX_LAYOUT_BYTES = 16 * 1024 * 1024;
/** 测量（启动浏览器之后：加载页面、读取 docx、排版、截取）的时限：比模板的命令墙钟（3 分钟）短，到时给出 layout_timeout。 */
export const LAYOUT_TIMEOUT_MS = 2 * 60_000 + 20_000;
/** 与桌面版隐藏窗口的默认尺寸相同；排版只取决于 docx 的页面设置，与视口无关。 */
export const VIEWPORT = Object.freeze({ width: 800, height: 600 });

/** 镜像构建时把 Playwright 下载的 chromium-headless-shell 目录链接到这里（server/sandbox/render-layout/Dockerfile）。 */
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

/** 镜像中的页面脚本（build-page.mjs 的输出）。 */
export const PAGE_SCRIPT_PATH = '/opt/render-layout/assets/docx-layout.js';

export const PAGE_ORIGIN = 'http://layout.invalid';
export const PAGE_URL = `${PAGE_ORIGIN}/`;
export const PAGE_SCRIPT_URL = `${PAGE_ORIGIN}/docx-layout.js`;
export const DOCUMENT_URL = `${PAGE_ORIGIN}/document.docx`;

/** 页面的 CSP：只允许页面脚本执行、只允许读取 docx，其余一律不允许（内联样式除外：docx-editor 可能写入元素样式）。 */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${PAGE_SCRIPT_URL}`,
  `connect-src ${DOCUMENT_URL}`,
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** 页面只有页面脚本，没有内联脚本。 */
export const PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}" />
  <script src="${PAGE_SCRIPT_URL}"></script>
</head>
<body></body>
</html>`;

export class RenderLayoutError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** 页面脚本可能给出的错误代码（page.mjs）。 */
const PAGE_ERRORS = new Set(['document_invalid', 'layout_failed']);

/** docx 是 ZIP（本地文件头签名 PK\x03\x04），不超过 100 MiB；不是时抛 request_invalid。 */
export function checkDocx(data) {
  if (!Buffer.isBuffer(data) || data.length < 4 || data.length > MAX_DOCX_BYTES || data.readUInt32LE(0) !== 0x04034b50) {
    throw new RenderLayoutError('request_invalid');
  }
  return data;
}

/** 读镜像中的页面脚本（入口启动时读一次）。 */
export async function loadPageScript() {
  return readFile(PAGE_SCRIPT_PATH);
}

/** 新建一个只认三个固定地址的浏览器上下文（允许页面脚本：受 CSP 约束，只有页面脚本能执行）。 */
export async function newLayoutContext(browser) {
  return browser.newContext({
    javaScriptEnabled: true,
    viewport: { ...VIEWPORT },
    deviceScaleFactor: 1,
    offline: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
    bypassCSP: false,
  });
}

/**
 * 给上下文登记路由：页面（带 CSP 响应头）、页面脚本与 docx 由路由直接给出，其余请求一律中止。docx 只给一次（页面脚本只读一次）。
 * onBlocked 只供测试统计被中止的请求。
 */
export async function routeLayoutPage(context, pageScript, docx, onBlocked) {
  let served = false;
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = request.url();
    if (url === PAGE_URL) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP }, body: PAGE_HTML });
    }
    if (url === PAGE_SCRIPT_URL) return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: pageScript });
    if (url === DOCUMENT_URL && request.method() === 'GET' && !served) {
      served = true;
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: docx });
    }
    onBlocked?.(url);
    return route.abort('blockedbyclient');
  });
}

async function withDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new RenderLayoutError('layout_timeout')), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 测量一个 docx。返回版式 JSON 的 UTF-8 字节（不超过 16 MiB）；失败抛 RenderLayoutError
 * （layout_timeout / layout_failed / document_invalid / output_too_large）。页面交回的内容按不可信处理：
 * 这里只核对外层结构与大小，逐项校验在 worker 中（server/src/render/wordLayout.ts）。
 */
export async function measureLayout(browser, pageScript, docx, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? LAYOUT_TIMEOUT_MS);
  let context;
  try {
    context = await withDeadline(newLayoutContext(browser), deadline);
    await routeLayoutPage(context, pageScript, docx, options.onBlocked);
    const run = async () => {
      const page = await context.newPage();
      await page.goto(PAGE_URL, { waitUntil: 'load', timeout: Math.max(1, deadline - Date.now()) });
      const ready = await page.evaluate(() => typeof window.__zhibiaoLayout?.read === 'function');
      if (!ready) throw new RenderLayoutError('layout_failed');
      // 平台的代码，由 Playwright 求值：页面脚本自己从固定地址读取 docx，这里不传入任何参数。
      const result = await page.evaluate(() => window.__zhibiaoLayout.read());
      if (!isPlainObject(result)) throw new RenderLayoutError('layout_failed');
      if (result.ok !== true) throw new RenderLayoutError(PAGE_ERRORS.has(result.error) ? result.error : 'layout_failed');
      if (!isPlainObject(result.layout) || result.layout.version !== 1) throw new RenderLayoutError('layout_failed');
      return result.layout;
    };
    const layout = await withDeadline(run(), deadline);
    const data = Buffer.from(`${JSON.stringify(layout)}\n`, 'utf8');
    if (data.length > MAX_LAYOUT_BYTES) throw new RenderLayoutError('output_too_large');
    return data;
  } catch (error) {
    if (error instanceof RenderLayoutError) throw error;
    if (Date.now() >= deadline) throw new RenderLayoutError('layout_timeout');
    throw new RenderLayoutError('layout_failed');
  } finally {
    // 关闭上下文即结束它的渲染进程（包括仍在执行、超时的页面）；入口随后也关闭浏览器。
    if (context) await closeContext(context);
  }
}

/** 关闭上下文至多等这么久（关不掉时入口照常关闭浏览器、结束进程）。 */
export const CONTEXT_CLOSE_TIMEOUT_MS = 10_000;
async function closeContext(context) {
  let timer;
  await Promise.race([
    context.close().catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, CONTEXT_CLOSE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
}
