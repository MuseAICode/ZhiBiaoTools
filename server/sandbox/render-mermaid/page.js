// render-mermaid 沙箱的入口页面脚本（路线图第 8 步 8.8b）。由 mermaidImage.mjs 以 http://mermaid.invalid/page.js 的地址交给页面，
// 页面的 CSP 只允许这个脚本与镜像中按版本固定的 mermaid.min.js 执行（script-src 写死两个地址，不允许内联脚本、事件属性与 eval）。
// AI 写的 Mermaid 源码不进入页面：入口经 Playwright 把它作为字符串参数交给 __zhibiaoMermaid.render。
//
// 与桌面版 localImageRenderService.buildMermaidDocument 的做法相同（strict、SVG 按固有尺寸、过宽时等比缩小到 664 像素宽、外边距 8 像素），
// 另有以下不同（#70 决定事项第 4 项、路线图 8.8b）：
// - 图表内的 init 指令与 frontmatter 的 config 不能改变下面 SECURE_KEYS 中的设置：除 Mermaid 默认锁定的 securityLevel 等，另锁定
//   htmlLabels（关闭 HTML 标签，文字用 SVG 的 text 排版）、dompurifyConfig（放宽清理规则）、themeCSS、fontFamily、altFontFamily
//   （可写入 CSS 的 url() 与 @import）；
// - 过高的图另按 1086 像素高等比缩小，PNG 不超过 2040 × 3306（render-html 的像素上限）；
// - maxTextSize 设为 65536：入口已限制每段源码至多 64 KiB，Mermaid 不会把超长的源码换成“超出大小”的提示图。
// 本文件是平台的代码，镜像构建时按原样复制；测试的对照组按 SECURE_KEYS 与 CONFIG 两行改写出放宽的页面（只在测试中）。
(() => {
  'use strict';
  const SECURE_KEYS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'dompurifyConfig', 'themeCSS', 'fontFamily', 'altFontFamily'];
  const CONFIG = { startOnLoad: false, theme: 'default', securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: 65536, suppressErrorRendering: true };
  /** 与桌面版 WORD_FRIENDLY_RENDER_WIDTH - 16 相同；高度上限为 3306 / 3 取整后减去上下外边距。 */
  const MAX_WIDTH = 664;
  const MAX_HEIGHT = 1086;
  const MAX_MESSAGE_CHARS = 1000;

  mermaid.initialize({ ...CONFIG, secure: SECURE_KEYS });

  const parseSize = (value) => {
    const n = parseFloat(String(value || '').replace('px', '').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  /** 按桌面版的规则取 SVG 的固有尺寸并写成明确的宽高（过宽或过高时等比缩小）。 */
  function fitSvg(svgEl) {
    let w = parseSize(svgEl.getAttribute('width'));
    let h = parseSize(svgEl.getAttribute('height'));
    if (!w || !h) {
      const vb = String(svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
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
      const scale = Math.min(1, MAX_WIDTH / w, MAX_HEIGHT / h);
      const outW = Math.max(1, Math.round(w * scale));
      const outH = Math.max(1, Math.round(h * scale));
      svgEl.setAttribute('width', String(outW));
      svgEl.setAttribute('height', String(outH));
      svgEl.style.width = outW + 'px';
      svgEl.style.height = outH + 'px';
      svgEl.style.maxWidth = 'none';
    }
  }

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  /**
   * 渲染一段 Mermaid 源码。返回 { ok: true, width, height }（#app-capture-root 的 CSS 像素尺寸）或
   * { ok: false, message }（Mermaid 给出的语法或渲染错误，入口截断后按不可信纯文本交回）。
   */
  async function render(code) {
    const root = document.getElementById('app-capture-root');
    if (typeof code !== 'string' || !root) return { ok: false, message: 'Mermaid 渲染失败' };
    let svg;
    try {
      ({ svg } = await mermaid.render('zhibiao-mermaid', code));
    } catch (error) {
      const message = String((error && error.message) || error || '').slice(0, MAX_MESSAGE_CHARS);
      return { ok: false, message: message || 'Mermaid 渲染失败' };
    }
    root.innerHTML = svg;
    const svgEl = root.querySelector('svg');
    if (svgEl) fitSvg(svgEl);
    await document.fonts.ready;
    await nextFrame();
    await nextFrame();
    const rect = root.getBoundingClientRect();
    return { ok: true, width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  }

  Object.defineProperty(window, '__zhibiaoMermaid', { value: Object.freeze({ render }), writable: false, configurable: false, enumerable: false });
})();
