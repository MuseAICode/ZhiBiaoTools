// render-html 沙箱中的 HTML 配图转 PNG（路线图第 8 步 8.8a1；“第 8 步说明”第 3 项，#70 决定事项第 4 项）。
// 与桌面版 localImageRenderService.renderHtmlToPng 的做法相同：AI 写的 HTML 由 buildHtmlDocument 包成 body 为固定画布
// （宽 1240、高按画框）的页面，等资源与布局稳定后用 buildHtmlLayoutProbeScript 检查布局问题，再按 2 倍像素截取整个画布。
// 画布尺寸、页面包装与两段测量脚本是桌面版同一份代码（client/electron/shared/htmlImageLayout.cjs，镜像构建时复制，
// 调用方经 layout 参数传入），这里只有浏览器的驱动方式不同。
//
// 安全约定：
// - 页面脚本一律不执行：浏览器上下文 javaScriptEnabled: false，页面中的 <script>、事件属性、javascript: 链接都不执行
//   （桌面版执行）。两段测量脚本是平台的代码，由 Playwright 在页面中求值；页面自身的脚本从未运行，求值环境不会被页面篡改；
// - 不发起网络请求：沙箱断网（--network none）；另外浏览器上下文设为离线并中止一切请求（远程图片、CSS url()、字体），
//   AI 写的外部引用只会加载失败；
// - 每张图一个新的浏览器上下文（没有任何存储），之间不共享状态；
// - 返回给 worker 的布局问题是桌面版脚本生成的中文短句（含 AI 写的类名），worker 按不可信纯文本处理。
// 同一请求中还可以有图片转 PNG 的项（8.8a2，kind: 'image'，见 imageConvert.mjs）。
import { IMAGE_FORMATS } from './imageConvert.mjs';

/** 画框名（与桌面版 HTML_FRAME_HEIGHTS 的键相同）。 */
export const FRAME_SIZES = Object.freeze(['square', 'wide', 'tall', 'panorama']);
/** 每批至多 50 张，每张 HTML 至多 1 MiB（UTF-8），合计至多 16 MiB（“第 8 步说明”第 3 项的起步值）。 */
export const MAX_ITEMS = 50;
export const MAX_HTML_BYTES = 1024 * 1024;
export const MAX_TOTAL_HTML_BYTES = 16 * 1024 * 1024;
/** 每张 PNG 至多 10 MiB（与上传图片上限一致）。 */
export const MAX_PNG_BYTES = 10 * 1024 * 1024;
/** 每张图（加载、等待布局、检查、截图）的时限。 */
export const ITEM_TIMEOUT_MS = 30_000;
/** 图片标识：worker 分配，也是输出文件名（<id>.png）。 */
export const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 布局问题：桌面版至多 12 条；每条截到 300 个字符。 */
const MAX_ISSUES = 12;
const MAX_ISSUE_CHARS = 300;

export class RenderHtmlError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验 request.json：{ version: 1, items: [...] }，每项字段不多不少，按 kind 分两种（8.8a2 新增 kind）：
 * - { id, kind: 'html', html, frame_size, check_layout }：HTML 配图。check_layout 对应桌面版的 checkLayout（正文关闭“HTML 配图二次优化”
 *   时为 false，不检查布局）；HTML 每张至多 1 MiB、合计至多 16 MiB；
 * - { id, kind: 'image', format }：图片转 PNG（imageConvert.mjs），内容在 /work/<id>.<format>，大小由入口读文件时检查。
 * 不合法时抛 request_invalid。
 */
export function parseRenderHtmlRequest(raw) {
  const invalid = () => new RenderHtmlError('request_invalid');
  if (!isPlainObject(raw)) throw invalid();
  const keys = Object.keys(raw).sort();
  if (keys.join(',') !== 'items,version' || raw.version !== 1 || !Array.isArray(raw.items)) throw invalid();
  if (raw.items.length === 0 || raw.items.length > MAX_ITEMS) throw invalid();
  const ids = new Set();
  let total = 0;
  return raw.items.map((item) => {
    if (!isPlainObject(item)) throw invalid();
    const { id, kind } = item;
    if (typeof id !== 'string' || !ITEM_ID.test(id) || ids.has(id)) throw invalid();
    ids.add(id);
    if (kind === 'image') {
      if (Object.keys(item).sort().join(',') !== 'format,id,kind' || !IMAGE_FORMATS.includes(item.format)) throw invalid();
      return { id, kind, format: item.format };
    }
    if (kind !== 'html' || Object.keys(item).sort().join(',') !== 'check_layout,frame_size,html,id,kind') throw invalid();
    const { html, frame_size: frameSize, check_layout: checkLayout } = item;
    if (typeof html !== 'string' || !FRAME_SIZES.includes(frameSize) || typeof checkLayout !== 'boolean') throw invalid();
    const bytes = Buffer.byteLength(html, 'utf8');
    total += bytes;
    if (bytes > MAX_HTML_BYTES || total > MAX_TOTAL_HTML_BYTES) throw invalid();
    return { id, kind, html, frameSize, checkLayout };
  });
}

/** PNG 的宽高（IHDR）；不是 PNG 时为 null。 */
export function pngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeIssues(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((issue) => String(issue ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_ISSUES)
    .map((issue) => issue.slice(0, MAX_ISSUE_CHARS));
}

/** 与桌面版 waitForLayoutReady 相同：资源就绪且尺寸连续 LAYOUT_SETTLE_MS 不变才算稳定，按 LAYOUT_POLL_MS 轮询。 */
async function waitForLayoutReady(page, layout, minWidth, deadline) {
  let stableSince = 0;
  let lastKey = '';
  while (Date.now() < deadline) {
    try {
      const metrics = await page.evaluate(layout.buildLayoutMetricsScript(minWidth, false));
      if (metrics?.ready && metrics.width > 0 && metrics.height > 0) {
        const key = `${metrics.width}x${metrics.height}`;
        if (key !== lastKey) {
          lastKey = key;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= layout.LAYOUT_SETTLE_MS) {
          return;
        }
      } else {
        lastKey = '';
        stableSince = 0;
      }
    } catch {
      lastKey = '';
      stableSince = 0;
    }
    await delay(layout.LAYOUT_POLL_MS);
  }
  throw new RenderHtmlError('render_timeout');
}

async function withDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new RenderHtmlError('render_timeout')), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 转一张图。返回 { png, width, height, layoutIssues }；失败抛 RenderHtmlError（render_timeout / render_failed / output_too_large）。
 * javaScriptEnabled 只供测试证明样本有效（开启时页面脚本会执行），入口一律为 false。
 */
export async function renderHtmlImage(browser, layout, item, options = {}) {
  const width = layout.HTML_DESIGN_WIDTH;
  const height = layout.HTML_FRAME_HEIGHTS[item.frameSize];
  const scale = layout.HTML_CAPTURE_SCALE;
  const deadline = Date.now() + (options.timeoutMs ?? ITEM_TIMEOUT_MS);
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled === true,
    viewport: { width, height },
    deviceScaleFactor: scale,
    offline: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  try {
    await context.route('**/*', (route) => route.abort('blockedbyclient'));
    const page = await context.newPage();
    const run = async () => {
      await page.setContent(layout.buildHtmlDocument(item.html, height), { waitUntil: 'load', timeout: Math.max(1, deadline - Date.now()) });
      await waitForLayoutReady(page, layout, width, deadline);
      const layoutIssues = item.checkLayout ? sanitizeIssues(await page.evaluate(layout.buildHtmlLayoutProbeScript())) : [];
      const png = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width, height },
        animations: 'disabled',
        timeout: Math.max(1, deadline - Date.now()),
      });
      return { png, layoutIssues };
    };
    const { png, layoutIssues } = await withDeadline(run(), deadline);
    if (png.length > MAX_PNG_BYTES) throw new RenderHtmlError('output_too_large');
    const size = pngSize(png);
    if (!size || size.width !== width * scale || size.height !== height * scale) throw new RenderHtmlError('render_failed');
    return { png, width: size.width, height: size.height, layoutIssues };
  } catch (error) {
    if (error instanceof RenderHtmlError) throw error;
    if (Date.now() >= deadline) throw new RenderHtmlError('render_timeout');
    throw new RenderHtmlError('render_failed');
  } finally {
    await context.close().catch(() => {});
  }
}
