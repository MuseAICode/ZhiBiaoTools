// 模板样张 HTML 的服务端校验（路线图第 7 步决定事项第 8 项，7.3a）：样张 HTML 由前端传来，入队前必须按与前端
// restrictedHtml 同一套白名单重新校验，不通过即拒绝，不能只查大小和结构。规则：
// - UTF-8 不超过 PREVIEW_HTML_MAX_BYTES；
// - 按 parseRestrictedHtml（与前端相同）解析，必须至少有一个块，且没有任何错误或警告——前端遇到警告会删掉多余的
//   标签或属性后继续，这里一律拒绝。唯一的例外是 img 的 src：前端样张把它换成打包后的图片地址（与桌面版
//   DOCUMENT_DISPLAY_TEMPLATE_HTML 相同），按前端 allowImageSrc 的规则允许出现，但不转发；
// - 每个 img 都必须有 data-app-asset-ref，且只能引用固定的样张配图 PREVIEW_ASSET_REFS（与桌面版
//   client/assets/content-template-preview 中的文件对应，测试核对），样张不能引用任何项目或用户的文件。
// 通过后返回由解析树重新序列化的 HTML（不含 src；再解析一遍必须原样得到它），调用方只把它交给导出沙箱，
// 不转发前端的原文。
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { parseRestrictedHtml } from './restrictedHtml.ts';

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Element = DefaultTreeAdapterTypes.Element;

/** 样张 HTML 的大小上限（UTF-8 字节）。桌面版样张约 11 KB。 */
export const PREVIEW_HTML_MAX_BYTES = 256 * 1024;

/** 样张可以引用的固定配图：data-app-asset-ref 的取值。 */
export const PREVIEW_ASSET_REFS: readonly string[] = Object.freeze([
  'assets/standard-quality-control.webp',
  'assets/visual-master-plan-scene.webp',
  'assets/visual-quality-closed-loop.webp',
  'assets/visual-technical-architecture.webp',
  'assets/visual-wbs-mindmap.webp',
]);

const PREVIEW_ASSET_REF_SET = new Set(PREVIEW_ASSET_REFS);

/** 拒绝的原因：给调用方决定提示文字，不回显具体内容。 */
export type PreviewHtmlRejection = 'not_string' | 'too_large' | 'empty' | 'not_restricted_html' | 'asset_ref';

export type PreviewHtmlResult =
  | { ok: true; html: string; assetRefs: string[] }
  | { ok: false; reason: PreviewHtmlRejection; issueCount: number };

function reject(reason: PreviewHtmlRejection, issueCount = 0): PreviewHtmlResult {
  return { ok: false, reason, issueCount };
}

function isElement(node: DefaultTreeAdapterTypes.Node): node is Element {
  return 'tagName' in node;
}

/** 按文档顺序收集所有 img（含 template 内容中的，虽然校验后 template 中只有文字）。 */
function collectImages(parent: ParentNode, images: Element[]) {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    if (child.tagName === 'img') images.push(child);
    if ('content' in child) collectImages((child as DefaultTreeAdapterTypes.Template).content, images);
    collectImages(child, images);
  }
  return images;
}

/** 校验前端传来的样张 HTML，通过时返回交给导出沙箱的 HTML 与其中引用的配图。 */
export function validatePreviewHtml(source: unknown): PreviewHtmlResult {
  if (typeof source !== 'string') return reject('not_string');
  if (Buffer.byteLength(source, 'utf8') > PREVIEW_HTML_MAX_BYTES) return reject('too_large');

  const checked = parseRestrictedHtml(source, { allowImageSrc: true });
  if (checked.issues.length) return reject('not_restricted_html', checked.issues.length);
  if (!checked.blocks.length || !checked.normalizedHtml) return reject('empty');

  // 第二遍不允许 src：唯一的差别是删掉 img 的 src，其余与第一遍相同。
  const forwarded = parseRestrictedHtml(source);
  const unexpected = forwarded.issues.filter((issue) => issue.message !== '已删除 <img> 的属性 src');
  if (unexpected.length || forwarded.normalizedHtml === null || forwarded.blocks.length !== checked.blocks.length) {
    return reject('not_restricted_html', unexpected.length || 1);
  }
  const html = forwarded.normalizedHtml;
  // 转发的是重新序列化的结果：再解析一遍必须原样得到它、没有任何问题，避免序列化后再解析时结构发生变化。
  const reparsed = parseRestrictedHtml(html);
  if (reparsed.issues.length || reparsed.normalizedHtml !== html) return reject('not_restricted_html', reparsed.issues.length || 1);

  const refs = new Set<string>();
  for (const image of collectImages(parseFragment(html, { scriptingEnabled: false }), [])) {
    const names = image.attrs.map((attribute) => attribute.name);
    if (names.includes('src')) return reject('not_restricted_html', 1);
    const ref = image.attrs.find((attribute) => attribute.name === 'data-app-asset-ref')?.value;
    if (ref === undefined || !PREVIEW_ASSET_REF_SET.has(ref)) return reject('asset_ref');
    refs.add(ref);
  }
  return { ok: true, html, assetRefs: PREVIEW_ASSET_REFS.filter((ref) => refs.has(ref)) };
}
