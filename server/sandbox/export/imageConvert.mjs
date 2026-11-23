// render-html 沙箱中的图片转 PNG（路线图第 8 步 8.8a2；“第 8 步说明”第 3 项：同一模板顺带把 AI 生图返回的 SVG / WebP 等转成 PNG）。
// 8.9 的生图调用在服务商返回 SVG 或 WebP 时经这里转成 PNG 再入库；本步不接任何任务。
//
// 做法：每张图一个新的浏览器上下文，页面只有一个 <img>，图片以 http://render.invalid/image 的地址由 Playwright 的路由直接给出
// （不落盘、不经网络），其余请求一律中止。先读出浏览器解码后的固有尺寸，再按下面的规则缩放、截图（背景透明）：
// - WebP（位图）：只缩小不放大，长宽不超过 1920 × 2880（与桌面版 compressGeneratedImage 的上限相同）。动图取第一帧，放在画布中
//   原来的位置，其余透明（与整本导出的 WebP 转 PNG 相同，见 webp.mjs，7.4i）；
// - SVG（矢量）：按固有尺寸等比缩放到正好放进 1920 × 2880（可放大）。没有写宽高时用浏览器给出的固有尺寸（只有 viewBox 时按其比例）。
//
// 安全约定（与 HTML 配图相同，见 htmlImage.mjs）：
// - 浏览器上下文禁用 JavaScript、离线、中止除这两个地址外的一切请求；
// - SVG 只作为 <img> 的图片解码：浏览器对图片中的 SVG 不执行脚本、不加载任何外部资源（再加上前两层与沙箱断网）；
// - 解码失败、格式不符一律为 image_invalid；错误只给代码。
import { parseWebp } from './webp.mjs';

/** 待转格式（入口按扩展名读 /work/<id>.<format>）。 */
export const IMAGE_FORMATS = Object.freeze(['svg', 'webp']);
/** 每张至多 10 MiB、每批合计至多 64 MiB（“第 8 步说明”第 3 项的起步值）。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
/** 输出的长宽上限：与桌面版生图落盘前的压缩上限相同（client/electron/utils/imageCompression.cjs）。 */
export const MAX_OUTPUT_WIDTH = 1920;
export const MAX_OUTPUT_HEIGHT = 2880;

const ORIGIN = 'http://render.invalid';
const PAGE_URL = `${ORIGIN}/`;
const IMAGE_URL = `${ORIGIN}/image`;
const CONTENT_TYPES = Object.freeze({ svg: 'image/svg+xml', webp: 'image/webp' });

export class ImageConvertError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
    img { position: absolute; left: 0; top: 0; display: block; }
  </style>
</head>
<body><img id="source" src="${IMAGE_URL}" alt=""></body>
</html>`;

/** SVG 是 UTF-8 文本且含有 <svg 根元素的开始标记；其余由浏览器解码时判断。 */
function isSvgText(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return !text.includes('\0') && text.includes('<svg');
}

/**
 * 按格式确定要解码的数据与画布：WebP 在这里解析容器（不合法、超出像素上限时抛错），动图换成第一帧的静态 WebP；
 * SVG 的画布由浏览器给出的固有尺寸决定（canvas 为 null）。
 */
function prepareSource(format, bytes) {
  if (format === 'webp') {
    let image;
    try {
      image = parseWebp(bytes);
    } catch {
      throw new ImageConvertError('image_invalid');
    }
    return { data: image.animated ? image.frame.data : bytes, canvas: { width: image.width, height: image.height }, frame: image.frame, vector: false };
  }
  if (!isSvgText(bytes)) throw new ImageConvertError('image_invalid');
  return { data: bytes, canvas: null, frame: null, vector: true };
}

/** 输出尺寸：位图只缩小，矢量图等比放进上限；至少 1 像素。 */
export function outputScale(width, height, vector) {
  const fit = Math.min(MAX_OUTPUT_WIDTH / width, MAX_OUTPUT_HEIGHT / height);
  const scale = vector ? fit : Math.min(1, fit);
  return {
    scale,
    width: Math.min(MAX_OUTPUT_WIDTH, Math.max(1, Math.round(width * scale))),
    height: Math.min(MAX_OUTPUT_HEIGHT, Math.max(1, Math.round(height * scale))),
  };
}

async function withDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new ImageConvertError('render_timeout')), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 转一张图。item 为 { id, format }，bytes 为图片内容。返回 { png, width, height }；失败抛 ImageConvertError
 * （image_invalid / render_timeout / render_failed / output_too_large）。pngSize 由调用方传入（htmlImage.mjs 的同名函数）。
 */
export async function convertImage(browser, item, bytes, { timeoutMs, maxPngBytes, pngSize }) {
  if (!IMAGE_FORMATS.includes(item.format) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new ImageConvertError('image_invalid');
  const source = prepareSource(item.format, bytes);
  const deadline = Date.now() + timeoutMs;
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1, height: 1 },
    deviceScaleFactor: 1,
    offline: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  try {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url === PAGE_URL) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE_HTML });
      if (url === IMAGE_URL) return route.fulfill({ status: 200, contentType: CONTENT_TYPES[item.format], body: source.data });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const run = async () => {
      await page.goto(PAGE_URL, { waitUntil: 'load', timeout: Math.max(1, deadline - Date.now()) });
      // 平台的代码，由 Playwright 求值（页面脚本被禁用）。解码失败时 decode() 拒绝。
      const natural = await page.evaluate(() => {
        const image = document.getElementById('source');
        return image.decode().then(
          () => ({ width: image.naturalWidth, height: image.naturalHeight }),
          () => null,
        );
      });
      if (!natural || !(natural.width > 0) || !(natural.height > 0)) throw new ImageConvertError('image_invalid');
      const canvas = source.canvas ?? natural;
      const frame = source.frame ?? { x: 0, y: 0, width: natural.width, height: natural.height };
      // WebP 的位流尺寸已在容器中核对；浏览器解码出的尺寸与之不同时不采用。
      if (!source.vector && (natural.width !== frame.width || natural.height !== frame.height)) throw new ImageConvertError('image_invalid');
      const output = outputScale(canvas.width, canvas.height, source.vector);
      await page.setViewportSize({ width: output.width, height: output.height });
      await page.evaluate(
        ([left, top, width, height]) => {
          const style = document.getElementById('source').style;
          style.left = `${left}px`;
          style.top = `${top}px`;
          style.width = `${width}px`;
          style.height = `${height}px`;
        },
        [frame.x * output.scale, frame.y * output.scale, frame.width * output.scale, frame.height * output.scale],
      );
      const png = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: output.width, height: output.height },
        omitBackground: true,
        animations: 'disabled',
        timeout: Math.max(1, deadline - Date.now()),
      });
      return { png, width: output.width, height: output.height };
    };
    const result = await withDeadline(run(), deadline);
    if (result.png.length > maxPngBytes) throw new ImageConvertError('output_too_large');
    const size = pngSize(result.png);
    if (!size || size.width !== result.width || size.height !== result.height) throw new ImageConvertError('render_failed');
    return result;
  } catch (error) {
    if (error instanceof ImageConvertError) throw error;
    if (Date.now() >= deadline) throw new ImageConvertError('render_timeout');
    throw new ImageConvertError('render_failed');
  } finally {
    await context.close().catch(() => {});
  }
}
