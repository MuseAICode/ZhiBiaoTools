// HTML 交给 LibreOffice / SheetJS 之前的清理（路线图第 6 步 6.7；“第 6 步解析要求”中“HTML / MHT / RTF 禁止加载任何远程资源”）。
// 实测 LibreOffice 即使在镜像的安全设置下（BlockUntrustedRefererLinks 等），导入 HTML 时仍会请求 <link> 样式表和 CSS 背景图片，
// 所以不能只靠解析器的设置：这里用 HTML 解析器（cheerio / parse5，不访问网络）读出文档，再按白名单重新生成一份只含正文结构的 HTML：
// - 元素白名单（段落、标题、列表、表格、强调等）；脚本、样式、<link>、<base>、<meta>、<iframe> / <frame>、<object> / <embed> /
//   <applet>、音视频、SVG / MathML、表单控件等连同内容去掉；其他未知元素（含 Word 的 o:p、v:shape 等带前缀的元素）只保留其中的文字；
// - 属性白名单：表格的 colspan / rowspan、有序列表的 start、图片的 alt / width / height、链接的 href（只收 http / https / mailto
//   的绝对地址和页内 #锚点，链接不会被加载）；style、class、background、srcset 等一律去掉，CSS 的 url() / @import 随之消失；
// - 图片只保留 data: 内嵌的位图（png / jpeg / gif / webp / bmp，文件头与类型一致），或调用方从 MHT 包内找到的部分（同样转成 data:）；
//   其他（远程地址、file:、相对路径、cid: 找不到的）连同 <img> 一起去掉；
// - 注释、条件注释、处理指令都不输出。
import * as cheerio from 'cheerio';

/** 单个文件中保留的图片上限（与解析入口的图片上限相同）。 */
export const HTML_MAX_IMAGES = 2_000;

const DROPPED_ELEMENTS = new Set([
  'script', 'style', 'noscript', 'template', 'link', 'meta', 'base', 'title', 'head',
  'iframe', 'frame', 'frameset', 'noframes', 'object', 'embed', 'applet', 'param',
  'audio', 'video', 'source', 'track', 'picture', 'canvas', 'map', 'area', 'svg', 'math',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output',
  'bgsound', 'marquee', 'portal', 'slot', 'dialog', 'xml',
]);

const KEPT_ELEMENTS = new Set([
  'p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'small', 'big', 'font', 'center', 'mark',
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'tt', 'q', 'cite', 'abbr', 'address',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'article', 'section', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption',
  'a', 'img',
]);

const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'col']);

const IMAGE_SIGNATURES = Object.freeze({
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'image/bmp': [[0x42, 0x4d]],
});

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

function matchesSignature(mime, buffer) {
  const signatures = IMAGE_SIGNATURES[mime];
  return Boolean(signatures?.some((signature) => buffer.length > signature.length && signature.every((byte, index) => buffer[index] === byte)));
}

/** 解出 data: 图片；只收 base64 编码的位图。 */
export function parseDataImage(src) {
  const match = /^data:(image\/[a-z0-9.+-]+)((?:;[^,;]*)*);base64,([a-z0-9+/=\s]*)$/is.exec(String(src ?? '').trim());
  if (!match) return null;
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  return { mime, buffer: Buffer.from(match[3].replace(/\s+/g, ''), 'base64') };
}

function safeHref(value) {
  const href = String(value ?? '').trim();
  if (/^#[^\s"'<>]*$/.test(href)) return href;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

function positiveInteger(value, max) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const number = Number(text);
  return number >= 1 && number <= max ? String(number) : null;
}

/**
 * 清理 HTML，返回重新生成的完整 UTF-8 HTML 文档。
 * @param {string} html 已解码的 HTML
 * @param {{ resolveImage?: (src: string) => ({ mime: string, buffer: Buffer } | null) }} [options]
 *   resolveImage 为 MHT 提供包内查找（cid:、Content-Location）；data: 图片总是由这里自己解出。
 */
export function sanitizeHtml(html, options = {}) {
  const resolveImage = options.resolveImage ?? null;
  const $ = cheerio.load(html, { xml: false });
  let images = 0;

  function imageSource(src) {
    let image = parseDataImage(src);
    if (!image && resolveImage && !/^data:/i.test(String(src ?? '').trim())) image = resolveImage(String(src ?? ''));
    if (!image || !matchesSignature(image.mime, image.buffer)) return null;
    images += 1;
    if (images > HTML_MAX_IMAGES) {
      const error = new Error('too many images');
      error.code = 'too_many_images';
      throw error;
    }
    return `data:${image.mime};base64,${image.buffer.toString('base64')}`;
  }

  function attributes(name, attribs) {
    const kept = [];
    const add = (key, value) => {
      if (value !== null && value !== undefined) kept.push(` ${key}="${escapeAttribute(value)}"`);
    };
    if (name === 'td' || name === 'th') {
      add('colspan', positiveInteger(attribs.colspan, 1000));
      add('rowspan', positiveInteger(attribs.rowspan, 65535));
    } else if (name === 'ol') {
      add('start', positiveInteger(attribs.start, 1_000_000));
    } else if (name === 'a') {
      add('href', attribs.href === undefined ? null : safeHref(attribs.href));
    }
    return kept.join('');
  }

  function render(node) {
    if (node.type === 'text') return escapeText(node.data);
    if (node.type !== 'tag') return ''; // script、style、注释、指令、CDATA
    const name = String(node.name).toLowerCase();
    if (DROPPED_ELEMENTS.has(name)) return '';
    const children = () => (node.children ?? []).map(render).join('');
    if (!KEPT_ELEMENTS.has(name)) return children();
    if (name === 'img') {
      const src = imageSource(node.attribs?.src);
      if (!src) return '';
      const alt = node.attribs?.alt;
      const width = positiveInteger(node.attribs?.width, 20_000);
      const height = positiveInteger(node.attribs?.height, 20_000);
      return `<img src="${src}"${alt ? ` alt="${escapeAttribute(alt)}"` : ''}${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}>`;
    }
    const attrs = attributes(name, node.attribs ?? {});
    if (VOID_ELEMENTS.has(name)) return `<${name}${attrs}>`;
    return `<${name}${attrs}>${children()}</${name}>`;
  }

  const body = $('body').get(0);
  const content = body ? (body.children ?? []).map(render).join('') : '';
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title></title></head><body>${content}</body></html>\n`;
}
