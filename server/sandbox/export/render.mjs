// export 沙箱中的离屏渲染（路线图第 7 步 7.1；决定事项第 9 项）：把页眉页脚装饰 SVG 栅格化成 PNG。
// 与桌面版 chromeAssetService.rasterizeSvg + localImageRenderService.renderExactHtmlToPng 的做法相同：
// SVG 内联进固定尺寸的页面，加载后直接按固定画布截图，不等待也不执行任何页面脚本。
//
// 安全约定：
// - 浏览器上下文禁用 JavaScript（javaScriptEnabled: false）：页面中的 <script>、事件属性、javascript: 链接都不执行。
//   第 7 步只有装饰转图用到 Chromium，不需要脚本；第 8 步中必须执行脚本的功能届时逐项由用户决定。
// - 关闭 Chromium 自身的沙箱（--no-sandbox）：外层是断网、只读根文件系统、非 root、无任何能力的 gVisor 沙箱。
// - 不发起任何网络请求的保证来自沙箱断网（--network none）；有测试证明装饰中的外部引用在沙箱中不被请求。
import { chromium } from 'playwright-core';

/** 镜像构建时把 Playwright 下载的 chromium-headless-shell 目录链接到这里（server/sandbox/export/Dockerfile）。 */
export const CHROMIUM_EXECUTABLE = '/opt/chromium/chrome-headless-shell';

const CSS_DPI = 96;
/** 栅格化倍率：装饰按 cm 生成，按约 300 dpi 截图。桌面版 renderExactHtmlToPng 把 300/96 取整为 3，这里相同。 */
export const CAPTURE_SCALE = 3;
/** 启动浏览器、加载页面、截图各自的时限。 */
const STEP_TIMEOUT_MS = 20_000;

export const LAUNCH_ARGS = Object.freeze([
  '--no-sandbox',
  // /dev/shm 只有 64 MiB，共享内存改用 /tmp（tmpfs，计入沙箱的内存上限）。
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
  // 与桌面版离屏渲染相同的文字与颜色设置，同一份 SVG 在两端栅格化的结果一致。
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--force-color-profile=srgb',
]);

export function cmToCssPx(cm) {
  return Math.max(1, Math.round((cm * CSS_DPI) / 2.54));
}

/** 与桌面版 buildExactHtmlDocument 相同的固定画布页面。 */
function buildExactHtmlDocument(html, width, height) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      width: ${width}px !important;
      height: ${height}px !important;
      overflow: hidden !important;
      background: #ffffff !important;
    }
    #app-capture-root {
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
    }
    *, *::before, *::after { box-sizing: border-box; }
  </style>
</head>
<body>
  <div id="app-capture-root">${html}</div>
</body>
</html>`;
}

/** 与桌面版 chromeAssetService.rasterizeSvg 相同：SVG 精确铺满固定尺寸的容器。 */
export function buildDecorationHtml(svg, width, height) {
  return (
    `<div style="width:${width}px;height:${height}px;overflow:hidden;line-height:0">` +
    String(svg).replace('<svg ', `<svg style="display:block;width:${width}px;height:${height}px" `) +
    '</div>'
  );
}

/**
 * 启动一次浏览器，执行 work(renderer)，结束后关闭。renderer.renderExactHtmlToPng 按固定画布截图，返回 PNG。
 * 每次截图都是新的浏览器上下文（禁用 JavaScript、没有任何存储），之间不共享状态。
 */
export async function withRenderer(work) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_EXECUTABLE,
    headless: true,
    args: [...LAUNCH_ARGS],
    // 不把入口进程的环境变量传给浏览器。
    env: { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' },
    timeout: STEP_TIMEOUT_MS,
  });
  try {
    return await work({
      async renderExactHtmlToPng({ html, width, height }) {
        const safeWidth = Math.max(1, Math.round(Number(width) || 1));
        const safeHeight = Math.max(1, Math.round(Number(height) || 1));
        const context = await browser.newContext({
          javaScriptEnabled: false,
          viewport: { width: safeWidth, height: safeHeight },
          deviceScaleFactor: CAPTURE_SCALE,
          serviceWorkers: 'block',
          acceptDownloads: false,
        });
        try {
          const page = await context.newPage();
          await page.setContent(buildExactHtmlDocument(html, safeWidth, safeHeight), { waitUntil: 'load', timeout: STEP_TIMEOUT_MS });
          return await page.screenshot({
            type: 'png',
            clip: { x: 0, y: 0, width: safeWidth, height: safeHeight },
            animations: 'disabled',
            timeout: STEP_TIMEOUT_MS,
          });
        } finally {
          await context.close();
        }
      },
      /**
       * 把一个本地页面（file://，入口写在 /work 中，只含一张静态 WebP）按固定画布截图，背景透明（7.4i：WebP 转 PNG）。
       * 倍率为 1，图片按原始像素绘制；与装饰相同，浏览器上下文禁用 JavaScript。
       */
      async renderFileToTransparentPng({ url, width, height }) {
        const context = await browser.newContext({
          javaScriptEnabled: false,
          viewport: { width, height },
          deviceScaleFactor: 1,
          serviceWorkers: 'block',
          acceptDownloads: false,
        });
        try {
          const page = await context.newPage();
          await page.goto(url, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS });
          return await page.screenshot({
            type: 'png',
            clip: { x: 0, y: 0, width, height },
            omitBackground: true,
            animations: 'disabled',
            timeout: STEP_TIMEOUT_MS,
          });
        } finally {
          await context.close();
        }
      },
    });
  } finally {
    await browser.close();
  }
}

/**
 * 栅格化一张静态 WebP 的页面：画布 width × height（透明），图片按原始尺寸放在 (x, y)。src 是同目录下的文件名。
 * 不缩放、不平滑，PNG 的像素与 WebP 解码结果相同（7.4i）。
 */
export function buildImageFrameHtml({ src, width, height, x, y, frameWidth, frameHeight }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
    img { position: absolute; left: ${x}px; top: ${y}px; width: ${frameWidth}px; height: ${frameHeight}px; image-rendering: pixelated; }
  </style>
</head>
<body><img src="${src}" alt=""></body>
</html>`;
}

/** 把一段装饰 SVG 栅格化成 PNG（宽高为 cm）。 */
export async function rasterizeSvg(renderer, svg, widthCm, heightCm) {
  const width = cmToCssPx(widthCm);
  const height = cmToCssPx(heightCm);
  return renderer.renderExactHtmlToPng({ html: buildDecorationHtml(svg, width, height), width, height });
}
