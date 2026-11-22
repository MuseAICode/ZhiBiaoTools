const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, app: electronApp, nativeImage } = require('electron');
// HTML 配图的画布、页面与布局测量脚本：与 Web 版 render-html 沙箱同一份（electron/shared/htmlImageLayout.cjs）。
const {
  HTML_CAPTURE_SCALE,
  HTML_DESIGN_WIDTH,
  HTML_FRAME_HEIGHTS,
  LAYOUT_POLL_MS,
  LAYOUT_SETTLE_MS,
  buildHtmlDocument,
  buildHtmlLayoutProbeScript,
  buildLayoutMetricsScript,
} = require('../shared/htmlImageLayout.cjs');

const DEFAULT_COMPONENT_CONCURRENCY = 5;
const MIN_COMPONENT_CONCURRENCY = 1;
const MAX_COMPONENT_CONCURRENCY = 20;
/** Mermaid 本地渲染参考宽度（约 A4 正文可用宽） */
const WORD_FRIENDLY_RENDER_WIDTH = 680;
/** Mermaid 使用 3 倍像素输出，保证 Word 缩放和高分屏查看时仍清晰 */
const MERMAID_CAPTURE_SCALE = 3;
/** HTML 高度超过该值后会在 Word 中触发二次缩小 */
const HTML_MAX_DESIGN_HEIGHT = 1800;
const MERMAID_RENDER_TIMEOUT_MS = 30000;
const HTML_RENDER_TIMEOUT_MS = 120000;
const MAX_CAPTURE_SEGMENT_HEIGHT = 8192;
const PAUSE_POLL_MS = LAYOUT_POLL_MS;

let serviceInstance = null;

// 若调用方已请求暂停则立即抛出。
function throwIfPaused(options, fallbackMessage = '转图已暂停') {
  if (options?.isPauseRequested?.()) {
    throw options.createPauseError?.() || new Error(fallbackMessage);
  }
}

// 限制组件并发量到合法区间。
function clampConcurrency(value, fallback = DEFAULT_COMPONENT_CONCURRENCY) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_COMPONENT_CONCURRENCY, Math.max(MIN_COMPONENT_CONCURRENCY, Math.round(number)));
}

// 解析 mermaid 浏览器脚本路径。
function resolveMermaidBrowserScript() {
  try {
    return require.resolve('mermaid/dist/mermaid.min.js');
  } catch {
    const candidates = [
      path.join(electronApp.getAppPath(), 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
      path.join(__dirname, '..', '..', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('未找到 mermaid 浏览器脚本，无法本地渲染 Mermaid');
  }
}

// 简易异步并发池。
function createConcurrencyPool(getLimit) {
  let active = 0;
  const queue = [];

  function pump() {
    const limit = Math.max(1, Number(getLimit()) || DEFAULT_COMPONENT_CONCURRENCY);
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return function run(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  };
}

// 等待指定毫秒。
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 创建隐藏渲染窗口。
function createRenderWindow(width, height) {
  const win = new BrowserWindow({
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  return win;
}

// 确保页面调试器已附着。
async function ensureDebugger(webContents) {
  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach('1.3');
  }
}

// 设置设备视口尺寸。
async function setDeviceMetrics(webContents, width, height, deviceScaleFactor = 1) {
  await ensureDebugger(webContents);
  await webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    deviceScaleFactor: Math.max(1, Number(deviceScaleFactor) || 1),
    mobile: false,
  });
}

// 截取指定矩形区域 PNG。
async function captureClip(webContents, clip) {
  await ensureDebugger(webContents);
  const result = await webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
      scale: 1,
    },
  });
  if (!result?.data) throw new Error('页面截图失败：未返回图像数据');
  return Buffer.from(result.data, 'base64');
}

// 返回 PNG 的实际像素尺寸。
function getPngResult(buffer, fallbackWidth, fallbackHeight) {
  const image = nativeImage.createFromBuffer(buffer);
  const size = image.isEmpty() ? {} : image.getSize();
  return {
    buffer,
    width: Math.max(1, Number(size.width) || fallbackWidth),
    height: Math.max(1, Number(size.height) || fallbackHeight),
  };
}

// 用 nativeImage 纵向无缝拼接多段 PNG，尺寸以截图的实际像素为准。
function stitchPngVertically(buffers) {
  const images = buffers.map((buffer) => {
    const image = nativeImage.createFromBuffer(buffer);
    return { image, size: image.getSize() };
  });
  const totalWidth = Math.max(1, ...images.map(({ size }) => size.width));
  const totalHeight = Math.max(1, images.reduce((sum, { size }) => sum + size.height, 0));
  const canvas = Buffer.alloc(totalWidth * totalHeight * 4, 255);
  let offsetY = 0;
  for (const { image, size } of images) {
    const bitmap = image.toBitmap();
    const rowBytes = size.width * 4;
    for (let y = 0; y < size.height; y += 1) {
      const srcStart = y * rowBytes;
      const destStart = ((offsetY + y) * totalWidth) * 4;
      bitmap.copy(canvas, destStart, srcStart, srcStart + rowBytes);
    }
    offsetY += size.height;
  }
  const stitched = nativeImage.createFromBitmap(canvas, { width: totalWidth, height: totalHeight });
  const png = stitched.toPNG();
  if (!png?.length) throw new Error('拼接截图失败');
  return { buffer: png, width: totalWidth, height: totalHeight };
}

// 按内容高度完整截图，必要时分段后无缝拼接。
async function captureFullContent(webContents, width, height, options = {}) {
  throwIfPaused(options);
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const captureScale = Math.max(1, Math.round(Number(options.captureScale) || 1));
  const maxSegmentHeight = Math.max(1, Math.floor(MAX_CAPTURE_SEGMENT_HEIGHT / captureScale));
  if (safeHeight <= maxSegmentHeight) {
    await setDeviceMetrics(webContents, safeWidth, safeHeight, captureScale);
    throwIfPaused(options);
    const buffer = await captureClip(webContents, {
      x: 0,
      y: 0,
      width: safeWidth,
      height: safeHeight,
    });
    return getPngResult(buffer, safeWidth * captureScale, safeHeight * captureScale);
  }

  const segments = [];
  let y = 0;
  while (y < safeHeight) {
    throwIfPaused(options);
    const segmentHeight = Math.min(maxSegmentHeight, safeHeight - y);
    await setDeviceMetrics(webContents, safeWidth, segmentHeight, captureScale);
    const buffer = await captureClip(webContents, {
      x: 0,
      y,
      width: safeWidth,
      height: segmentHeight,
    });
    segments.push(buffer);
    y += segmentHeight;
  }
  return stitchPngVertically(segments);
}

// 轮询页面资源与布局状态（单次不阻塞，便于主进程响应暂停）。
// contentOnly：只量 #app-capture-root 内容包围盒，避免 body 固定宽导致右侧留白。
async function probeLayoutMetrics(webContents, minWidth, contentOnly = false) {
  return webContents.executeJavaScript(buildLayoutMetricsScript(minWidth, contentOnly), true);
}

async function probeHtmlLayoutIssues(webContents) {
  const result = await webContents.executeJavaScript(buildHtmlLayoutProbeScript(), true);
  return Array.isArray(result) ? result.map((issue) => String(issue || '').trim()).filter(Boolean) : [];
}

// 等待页面布局与资源稳定，并返回内容真实宽高；等待期间响应暂停。
async function waitForLayoutReady(webContents, timeoutMs, minWidth = 1, options = {}) {
  const contentOnly = options.contentOnly === true;
  const started = Date.now();
  let stableSince = 0;
  let lastKey = '';

  while (Date.now() - started < timeoutMs) {
    throwIfPaused(options);
    try {
      const metrics = await probeLayoutMetrics(webContents, minWidth, contentOnly);
      if (metrics?.ready && metrics.width > 0 && metrics.height > 0) {
        const key = `${metrics.width}x${metrics.height}`;
        if (key !== lastKey) {
          lastKey = key;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= LAYOUT_SETTLE_MS) {
          return { width: metrics.width, height: metrics.height };
        }
      } else {
        lastKey = '';
        stableSince = 0;
      }
    } catch {
      lastKey = '';
      stableSince = 0;
    }
    await delay(PAUSE_POLL_MS);
  }
  throw new Error('等待页面布局稳定超时');
}

function buildExactHtmlDocument(html, width, height) {
  const source = String(html || '').trim();
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      width: ${safeWidth}px !important;
      height: ${safeHeight}px !important;
      overflow: hidden !important;
      background: #ffffff !important;
    }
    #app-capture-root {
      width: ${safeWidth}px;
      height: ${safeHeight}px;
      overflow: hidden;
    }
    *, *::before, *::after { box-sizing: border-box; }
  </style>
</head>
<body>
  <div id="app-capture-root">${source}</div>
</body>
</html>`;
}

// 构建 Mermaid 本地渲染页面：保留 SVG 真实尺寸，过宽时等比缩小，页面随内容收缩。
function buildMermaidDocument(code, mermaidScriptUrl) {
  const escaped = JSON.stringify(String(code || ''));
  const maxContentWidth = WORD_FRIENDLY_RENDER_WIDTH - 16;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
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
  <script src="${mermaidScriptUrl}"></script>
</head>
<body>
  <div id="app-capture-root"></div>
  <script>
    (async () => {
      try {
        const code = ${escaped};
        const maxW = ${maxContentWidth};
        window.__appMermaidReady = false;
        window.__appMermaidError = '';
        mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
        const id = 'mermaid-' + Date.now();
        const { svg } = await mermaid.render(id, code);
        const root = document.getElementById('app-capture-root');
        root.innerHTML = svg;
        const svgEl = root.querySelector('svg');
        if (svgEl) {
          // 解析 mermaid 给出的固有尺寸；禁止直接删除 width/height，否则会塌成白图小黑点。
          const parseSize = (value) => {
            const n = parseFloat(String(value || '').replace('px', '').trim());
            return Number.isFinite(n) && n > 0 ? n : 0;
          };
          let w = parseSize(svgEl.getAttribute('width'));
          let h = parseSize(svgEl.getAttribute('height'));
          if (!w || !h) {
            const vb = String(svgEl.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
            if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
              w = vb[2];
              h = vb[3];
            }
          }
          if (!w || !h) {
            try {
              const box = svgEl.getBBox();
              if (box && box.width > 0 && box.height > 0) {
                w = box.width;
                h = box.height;
              }
            } catch {}
          }
          if (w > 0 && h > 0) {
            const scale = w > maxW ? (maxW / w) : 1;
            const outW = Math.max(1, Math.round(w * scale));
            const outH = Math.max(1, Math.round(h * scale));
            svgEl.setAttribute('width', String(outW));
            svgEl.setAttribute('height', String(outH));
            svgEl.style.width = outW + 'px';
            svgEl.style.height = outH + 'px';
            svgEl.style.maxWidth = 'none';
          }
        }
        window.__appMermaidReady = true;
      } catch (error) {
        window.__appMermaidError = error && error.message ? error.message : String(error || 'Mermaid 渲染失败');
        window.__appMermaidReady = true;
      }
    })();
  </script>
</body>
</html>`;
}

// 写入临时 HTML 文件并加载，便于引用本地 mermaid 脚本；加载期间响应暂停。
async function loadHtmlDocument(win, html, timeoutMs, options = {}) {
  throwIfPaused(options);
  const tempDir = path.join(os.tmpdir(), 'app-local-image-render');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempFile = path.join(tempDir, `render-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tempFile, html, 'utf-8');
  const fileUrl = pathToFileURL(tempFile).href;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('加载渲染页面超时')), timeoutMs);
      const pauseWatcher = options.isPauseRequested
        ? setInterval(() => {
          if (options.isPauseRequested?.() && !settled) {
            try {
              win.webContents.stop();
            } catch {
              // ignore
            }
            finish(options.createPauseError?.() || new Error('转图已暂停'));
          }
        }, PAUSE_POLL_MS)
        : null;

      const cleanup = () => {
        clearTimeout(timer);
        if (pauseWatcher) clearInterval(pauseWatcher);
        win.webContents.removeListener('did-finish-load', onLoad);
        win.webContents.removeListener('did-fail-load', onFail);
      };

      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };

      const onLoad = () => finish(null);
      const onFail = (_event, code, description) => {
        if (options.isPauseRequested?.()) {
          finish(options.createPauseError?.() || new Error('转图已暂停'));
          return;
        }
        finish(new Error(`加载渲染页面失败：${description || code}`));
      };

      win.webContents.once('did-finish-load', onLoad);
      win.webContents.once('did-fail-load', onFail);
      win.loadURL(fileUrl).catch((error) => {
        if (options.isPauseRequested?.()) {
          finish(options.createPauseError?.() || new Error('转图已暂停'));
          return;
        }
        finish(error);
      });
    });
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // ignore
    }
  }
}

// 关闭窗口并拆卸调试器。
function destroyWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.webContents?.debugger?.isAttached?.()) {
      win.webContents.debugger.detach();
    }
  } catch {
    // ignore
  }
  win.destroy();
}

// 在超时控制下执行任务。
async function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 创建本地图片渲染服务。
function createLocalImageRenderService({ configStore } = {}) {
  const runMermaid = createConcurrencyPool(() => clampConcurrency(
    configStore?.load?.()?.components?.mermaid_concurrency_limit,
    DEFAULT_COMPONENT_CONCURRENCY,
  ));
  const runHtml = createConcurrencyPool(() => clampConcurrency(
    configStore?.load?.()?.components?.html_concurrency_limit,
    DEFAULT_COMPONENT_CONCURRENCY,
  ));

  // 本地渲染 Mermaid 为 PNG。
  async function renderMermaidToPng(code, options = {}) {
    return runMermaid(async () => {
      throwIfPaused(options, 'Mermaid 转图已暂停');
      const mermaidScriptPath = resolveMermaidBrowserScript();
      const mermaidScriptUrl = pathToFileURL(mermaidScriptPath).href;
      const html = buildMermaidDocument(code, mermaidScriptUrl);
      const win = createRenderWindow(WORD_FRIENDLY_RENDER_WIDTH, 480);
      try {
        await withTimeout(
          loadHtmlDocument(win, html, MERMAID_RENDER_TIMEOUT_MS, options),
          MERMAID_RENDER_TIMEOUT_MS,
          'Mermaid 页面加载超时',
        );
        // 先给足够视口，让 SVG 按固有尺寸排版后再量内容包围盒。
        await setDeviceMetrics(win.webContents, WORD_FRIENDLY_RENDER_WIDTH, 1200);
        const ready = await withTimeout((async () => {
          const started = Date.now();
          while (Date.now() - started < MERMAID_RENDER_TIMEOUT_MS) {
            throwIfPaused(options, 'Mermaid 转图已暂停');
            const state = await win.webContents.executeJavaScript(`({
              ready: Boolean(window.__appMermaidReady),
              error: String(window.__appMermaidError || ''),
            })`, true);
            if (state.ready) return state;
            await delay(PAUSE_POLL_MS);
          }
          throw new Error('Mermaid 渲染超时');
        })(), MERMAID_RENDER_TIMEOUT_MS, 'Mermaid 渲染超时');
        if (ready.error) throw new Error(ready.error);
        const metrics = await waitForLayoutReady(win.webContents, MERMAID_RENDER_TIMEOUT_MS, 1, {
          ...options,
          contentOnly: true,
        });
        // 按内容包围盒截图，不强制铺满 680；过宽已在页面内等比缩小。
        const rawWidth = Math.ceil(metrics.width || 0);
        const rawHeight = Math.ceil(metrics.height || 0);
        if (rawWidth < 24 || rawHeight < 24) {
          throw new Error(`Mermaid 内容尺寸异常（${rawWidth}x${rawHeight}），可能未正确渲染`);
        }
        const width = Math.min(WORD_FRIENDLY_RENDER_WIDTH, Math.max(1, rawWidth));
        const height = Math.max(1, rawHeight);
        return await captureFullContent(win.webContents, width, height, {
          ...options,
          captureScale: MERMAID_CAPTURE_SCALE,
        });
      } finally {
        destroyWindow(win);
      }
    });
  }

  // 只做 HTML 渲染和布局质检，不生成 PNG
  async function probeHtmlLayoutOnly(html, options = {}) {
    return runHtml(async () => {
      throwIfPaused(options, 'HTML 质检已暂停');
      const width = HTML_DESIGN_WIDTH;
      const height = HTML_FRAME_HEIGHTS[options.frameSize];
      const documentHtml = buildHtmlDocument(html, height);
      const win = createRenderWindow(width, height);
      try {
        await withTimeout(
          loadHtmlDocument(win, documentHtml, HTML_RENDER_TIMEOUT_MS, options),
          HTML_RENDER_TIMEOUT_MS,
          'HTML 页面加载超时',
        );
        throwIfPaused(options, 'HTML 质检已暂停');
        await setDeviceMetrics(win.webContents, width, height);
        await withTimeout(
          waitForLayoutReady(win.webContents, HTML_RENDER_TIMEOUT_MS, HTML_DESIGN_WIDTH, options),
          HTML_RENDER_TIMEOUT_MS,
          'HTML 布局等待超时',
        );
        const layoutIssues = await probeHtmlLayoutIssues(win.webContents);
        return { width, height, layout_issues: layoutIssues };
      } finally {
        destroyWindow(win);
      }
    });
  }

  // 按固定画布截图，溢出通过 layout_issues 反馈，不扩展截图或缩小内容。
  async function renderHtmlToPng(html, options = {}) {
    return runHtml(async () => {
      throwIfPaused(options, 'HTML 转图已暂停');
      const width = HTML_DESIGN_WIDTH;
      const height = HTML_FRAME_HEIGHTS[options.frameSize];
      const documentHtml = buildHtmlDocument(html, height);
      const win = createRenderWindow(width, height);
      try {
        await withTimeout(
          loadHtmlDocument(win, documentHtml, HTML_RENDER_TIMEOUT_MS, options),
          HTML_RENDER_TIMEOUT_MS,
          'HTML 页面加载超时',
        );
        throwIfPaused(options, 'HTML 转图已暂停');
        // 布局和截图使用相同视口，避免百分比或视口单位在截图时发生重排。
        await setDeviceMetrics(win.webContents, width, height);
        await withTimeout(
          waitForLayoutReady(win.webContents, HTML_RENDER_TIMEOUT_MS, HTML_DESIGN_WIDTH, options),
          HTML_RENDER_TIMEOUT_MS,
          'HTML 布局等待超时',
        );
        // 正文可关闭二次优化；其他调用默认保留现有布局检测。
        const layoutIssues = options.checkLayout === false ? [] : await probeHtmlLayoutIssues(win.webContents);
        throwIfPaused(options, 'HTML 转图已暂停');
        const captured = await captureFullContent(win.webContents, width, height, {
          ...options,
          captureScale: HTML_CAPTURE_SCALE,
        });
        return { ...captured, layout_issues: layoutIssues };
      } finally {
        destroyWindow(win);
      }
    });
  }

  async function renderExactHtmlToPng({ html, width, height, scale = 2 } = {}, options = {}) {
    return runHtml(async () => {
      throwIfPaused(options, 'HTML 转图已暂停');
      const safeWidth = Math.max(1, Math.round(Number(width) || 1));
      const safeHeight = Math.max(1, Math.round(Number(height) || 1));
      const captureScale = Math.max(1, Math.round(Number(scale) || 2));
      const documentHtml = buildExactHtmlDocument(html, safeWidth, safeHeight);
      const win = createRenderWindow(safeWidth, safeHeight);
      try {
        await withTimeout(
          loadHtmlDocument(win, documentHtml, HTML_RENDER_TIMEOUT_MS, options),
          HTML_RENDER_TIMEOUT_MS,
          'HTML 页面加载超时',
        );
        throwIfPaused(options, 'HTML 转图已暂停');
        await setDeviceMetrics(win.webContents, safeWidth, safeHeight, captureScale);
        await delay(LAYOUT_SETTLE_MS);
        throwIfPaused(options, 'HTML 转图已暂停');
        const buffer = await captureClip(win.webContents, {
          x: 0,
          y: 0,
          width: safeWidth,
          height: safeHeight,
        });
        return getPngResult(buffer, safeWidth * captureScale, safeHeight * captureScale);
      } finally {
        destroyWindow(win);
      }
    });
  }

  return {
    renderMermaidToPng,
    renderHtmlToPng,
    renderExactHtmlToPng,
    probeHtmlLayoutOnly,
    wordFriendlyRenderWidth: WORD_FRIENDLY_RENDER_WIDTH,
    htmlDesignWidth: HTML_DESIGN_WIDTH,
  };
}

// 初始化全局本地转图服务。
function initLocalImageRenderService(options = {}) {
  serviceInstance = createLocalImageRenderService(options);
  return serviceInstance;
}

// 获取全局本地转图服务。
function getLocalImageRenderService() {
  if (!serviceInstance) {
    serviceInstance = createLocalImageRenderService();
  }
  return serviceInstance;
}

module.exports = {
  HTML_CAPTURE_SCALE,
  HTML_DESIGN_WIDTH,
  HTML_MAX_DESIGN_HEIGHT,
  WORD_FRIENDLY_RENDER_WIDTH,
  createLocalImageRenderService,
  getLocalImageRenderService,
  initLocalImageRenderService,
  __test__: { buildHtmlLayoutProbeScript },
};
