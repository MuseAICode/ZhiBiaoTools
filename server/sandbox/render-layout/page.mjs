// render-layout 沙箱的页面脚本源码（路线图第 8 步 8.8c）。镜像构建时由 build-page.mjs 与按版本固定、打上 client/patches 补丁的
// @docx-editor.dev/core 一起打成一个浏览器脚本（/opt/render-layout/assets/docx-layout.js），由 wordLayout.mjs 以
// http://layout.invalid/docx-layout.js 的地址交给页面；页面的 CSP 只允许这一个脚本执行（不允许内联脚本、事件属性、eval 与 WebAssembly），
// connect-src 只允许 http://layout.invalid/document.docx（本脚本读取 docx 的唯一地址，由路由直接给出）。
//
// 做法与桌面版 client/electron/services/wordLayoutPreload.cjs 相同：等字体就绪，用 Canvas 字体测量器（与页面预览同一种测量，
// 不用导出 API 的近似测量默认值），openDocumentForExport 打开 docx，session.layout() 取分页结果；不同的是结果先按
// layoutProjection.mjs 截取成版式 JSON 再交回（只有格式自检读取的字段）。docx 只作为数据传入，执行的只有平台固定的代码。
import { openDocumentForExport } from '@docx-editor.dev/core/export';
import { resolveDefaultSurfaceMeasurer } from '@docx-editor.dev/core/layout';
import { projectLayout } from './layoutProjection.mjs';

const DOCUMENT_URL = 'http://layout.invalid/document.docx';

/**
 * 读取并测量 docx。返回 { ok: true, layout }（版式 JSON）或 { ok: false, error }：
 * error 为 document_invalid（docx-editor 无法打开）或 layout_failed（测量器不可用、读取或测量出错），不带任何文字。
 */
async function read() {
  try {
    await document.fonts.ready;
    const metrics = resolveDefaultSurfaceMeasurer(96 / 72, { context: document.createElement('canvas').getContext('2d') });
    if (metrics.producer !== 'canvas-measurer') return { ok: false, error: 'layout_failed' };
    const response = await fetch(DOCUMENT_URL, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) return { ok: false, error: 'layout_failed' };
    const bytes = new Uint8Array(await response.arrayBuffer());
    let opened;
    try {
      opened = openDocumentForExport(bytes, { measurer: metrics.measurer, producer: metrics.producer });
    } catch {
      return { ok: false, error: 'document_invalid' };
    }
    if (!opened || !opened.ok) return { ok: false, error: 'document_invalid' };
    try {
      return { ok: true, layout: projectLayout(await opened.session.layout()) };
    } finally {
      opened.session.dispose();
    }
  } catch {
    return { ok: false, error: 'layout_failed' };
  }
}

Object.defineProperty(window, '__zhibiaoLayout', { value: Object.freeze({ read }), writable: false, configurable: false, enumerable: false });
