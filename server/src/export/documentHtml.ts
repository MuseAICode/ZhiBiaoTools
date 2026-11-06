// 技术方案整本导出的 HTML 组装（路线图第 7 步 7.4c）：与桌面版 client/electron/services/technicalPlanExport.cjs 的 build
// （非格式自检）和 exportService.cjs 的 collectOutlineExportEntries、getPendingContentModeMessage、
// renderMarkdownForRestrictedHtml 相同，结果由 tests/export/documentHtml.test.ts 按桌面版记录的共用用例
// （client/tests/fixtures/technicalPlanExportCases.json）逐项核对。纯函数，不访问数据库、对象存储与网络。
//
// 与桌面版的差别：
// - 配图：人工正文（Markdown）中的图片只认本系统的产物地址 /api/artifacts/<uuid>/content（解析与上传写入的图片都是这种
//   地址），data-app-asset-ref 统一为产物 id（小写 uuid，也是 export 沙箱 assets/ 下的文件名，同一产物只放一次）；
//   远程地址、data:、本机路径等一律不读取（服务端不能按用户给的地址发请求或读文件），原位改为“图片无法导出”的提示，
//   与桌面版读取失败时相同。产物是否属于本项目、是否可见，由整本导出任务（7.4e）在 RLS 下解析，这里只收集引用；
// - ai-generate 小节：正文在 Agent 工作区（第 8 步），之前一律按桌面版“正文未生成”处理（仅保留标题并提示）；
// - 格式自检（layoutCheck，定位标记 APPMARKLAYOUT）随第 8 步，这里不做；
// - 组装失败抛 DocumentHtmlError（代码 + 给用户看的原因），不是普通 Error。
import MarkdownIt from 'markdown-it';
import cjkFriendly from 'markdown-it-cjk-friendly';
import taskLists from 'markdown-it-task-lists';
import { defaultTreeAdapter, parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import type { TechnicalPlanExportTemplateScope } from '../db/schema.ts';
import type { TechnicalPlanOutlineItem } from '../technicalPlan/outline.ts';

type Node = DefaultTreeAdapterTypes.Node;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

const HTML_NS = 'http://www.w3.org/1999/xhtml' as DefaultTreeAdapterTypes.Element['namespaceURI'];

/** 转换器（OpenXmlHelper）支持的最深标题级别；目录本身最多 10 级（TECHNICAL_PLAN_OUTLINE_DEPTH_MAX）。 */
export const DOCUMENT_HEADING_LEVEL_MAX = 6;
/** 人工正文中可导出的图片地址：本系统的产物内容地址。 */
const ARTIFACT_IMAGE_SRC = /^\/api\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content$/i;
/** 人工正文中不是产物地址的图片的原因（桌面版能读本机路径、data: 与远程地址，服务端一律不读）。 */
export const UNSUPPORTED_IMAGE_REASON = '图片不是本系统中已上传或解析出的图片，无法读取';
/** 桌面版 readAiSection 在没有正文时的原因；第 8 步之前所有 ai-generate 小节都是这种情况。 */
const AI_SECTION_PENDING_REASON = '正文未生成';
/** 没有提示时桌面版 exportService 的成功消息。 */
export const EXPORT_DONE_MESSAGE = 'Word 已导出，请打开文档核对图片、表格和版式。';

/** 组装失败：code 给任务记录，message 给用户看。 */
export class DocumentHtmlError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DocumentHtmlError';
    this.code = code;
  }
}

/** 入队时取的快照（7.4e）：目录（含人工正文）、项目名称与模板范围。 */
export interface DocumentSnapshot {
  projectName?: string | null;
  exportTemplateScope: TechnicalPlanExportTemplateScope;
  outline: readonly TechnicalPlanOutlineItem[];
}

export interface DocumentHtml {
  /** 交给 export-document 沙箱的整本受限 HTML（按范围分为 section）。 */
  html: string;
  /** 目录节点数（含父节点）。 */
  sectionCount: number;
  /** 未导出正文的 AI 小节数。 */
  skippedCount: number;
  /** 组装阶段的提示（未导出正文的小节），按目录顺序。 */
  warnings: string[];
  /** 引用的产物 id（小写 uuid），按首次出现的顺序、不重复；7.4e 只把其中本项目可见的图片产物放入沙箱。 */
  assetRefs: string[];
  /**
   * 产物 id → 每一处引用所在的小节（“编号 标题”，按文档顺序，同一产物引用几次就有几项）。转换器对每一处无法导出的图片
   * 各返回一条 imageWarnings（按文档顺序），据此把第 k 条归到该产物第 k 处引用的小节。
   */
  imageSections: Map<string, string[]>;
  /** 小节 → 组装阶段就无法导出的图片原因（每张一条）。 */
  imageFailures: Map<string, string[]>;
}

export interface ExportImageWarning {
  assetRef: string;
  reason: string;
}

/** 与桌面版 technicalPlanExport.cjs 的 escapeHtml 相同：转义程序插入的项目名、目录标题和占位提示。 */
function escapeHtml(text: unknown): string {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 与桌面版 exportService.cjs 的 getPendingContentModeMessage 相同：尚未填写的节点提示。 */
export function getPendingContentModeMessage(item: Pick<TechnicalPlanOutlineItem, 'content_mode' | 'content_mode_note'>): string {
  if (item.content_mode === 'template-fill') return '待模板填写：后续将从招标文件提取并填充内容。';
  if (item.content_mode === 'directory-generate') return '待目录生成：请在导出后生成或更新目录。';
  if (item.content_mode === 'manual-fill') return '待人工填写：请在导出后补充内容。';
  if (item.content_mode === 'other') return `待处理：${String(item.content_mode_note || '').trim() || '该小节采用其他特殊处理模式。'}`;
  return '';
}

export interface OutlineExportEntry {
  item: TechnicalPlanOutlineItem;
  level: number;
  useTemplate: boolean;
  sectionTemplate: boolean;
}

/**
 * 与桌面版 exportService.cjs 的 collectOutlineExportEntries 相同：按树的顺序展开目录并重新编号；只有全部后代都为 AI 生成时，
 * 父标题才套用模板；混合目录的公共父标题保持基础样式，但跟随首个子目录的页面。
 */
export function collectOutlineExportEntries(
  items: readonly TechnicalPlanOutlineItem[] | undefined,
  aiOnly: boolean,
  level = 1,
  prefix = '',
): OutlineExportEntry[] {
  return (items || []).flatMap((source, index) => {
    const number = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    const item = { ...source, number };
    const descendants = collectOutlineExportEntries(item.children, aiOnly, level + 1, number);
    const useTemplate = !aiOnly || (descendants.length ? descendants.every((entry) => entry.useTemplate) : item.content_mode === 'ai-generate');
    return [{ item, level, useTemplate, sectionTemplate: descendants[0]?.sectionTemplate ?? useTemplate }, ...descendants];
  });
}

let markdownRenderer: MarkdownIt | null = null;

/** 与桌面版 renderMarkdownHtml（allowRawHtml: true、enableGfm: true）相同的 markdown-it 配置与插件。 */
function renderMarkdown(content: string): string {
  if (!markdownRenderer) {
    markdownRenderer = new MarkdownIt('default', { html: true, linkify: false, typographer: false, breaks: false });
    markdownRenderer.use(cjkFriendly);
    markdownRenderer.use(taskLists, { enabled: true, label: true, labelAfter: true });
  }
  return markdownRenderer.render(content);
}

// ---- parse5 默认树上的最小操作 ----

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function getAttribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attribute) => !attribute.prefix && attribute.name === name)?.value;
}

function createElement(tagName: string, attrs: Record<string, string> = {}): Element {
  return defaultTreeAdapter.createElement(tagName, HTML_NS, Object.entries(attrs).map(([name, value]) => ({ name, value })));
}

function appendText(parent: Element, text: string) {
  defaultTreeAdapter.insertText(parent, text);
}

function appendChild(parent: ParentNode, child: ChildNode) {
  defaultTreeAdapter.appendChild(parent, child);
}

function replaceWith(node: ChildNode, replacement: ChildNode) {
  const parent = node.parentNode;
  if (!parent) return;
  replacement.parentNode = parent;
  parent.childNodes.splice(parent.childNodes.indexOf(node), 1, replacement);
  node.parentNode = null;
}

/** 按文档顺序收集全部 img（含 template 的内容，保证用户的原始 HTML 中不留下任何自带的 data-app-asset-ref）。 */
function collectImages(parent: ParentNode, images: Element[] = []): Element[] {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    if (child.tagName === 'img') images.push(child);
    collectImages(child, images);
    if ('content' in child) collectImages((child as DefaultTreeAdapterTypes.Template).content, images);
  }
  return images;
}

/** 图片是段落中唯一的节点时整段替换（块级 figure 不能放在 Markdown 图片默认的 p 中）。 */
function replaceImage(img: Element, replacement: Element, wrapInParagraph: boolean) {
  const parent = img.parentNode;
  if (parent && isElement(parent) && parent.tagName === 'p' && parent.childNodes.length === 1) {
    if (wrapInParagraph) {
      const paragraph = createElement('p');
      appendChild(paragraph, replacement);
      replaceWith(parent, paragraph);
    } else {
      replaceWith(parent, replacement);
    }
  } else {
    replaceWith(img, replacement);
  }
}

/**
 * 与桌面版 renderMarkdownForRestrictedHtml 相同：人工正文按 Markdown（允许原始 HTML）渲染，每张图片改为
 * figure（wide、contain，有 alt 时作为图注），无法导出的图片原位改为文字提示并记下原因；图片的全部原有属性都不保留。
 */
function renderManualSection(content: string, refs: string[], failures: string[]): string {
  const fragment = parseFragment(renderMarkdown(content));
  for (const img of collectImages(fragment)) {
    const source = getAttribute(img, 'src') || '';
    const alt = getAttribute(img, 'alt') || '';
    const match = ARTIFACT_IMAGE_SRC.exec(source.trim());
    if (!match) {
      failures.push(UNSUPPORTED_IMAGE_REASON);
      const notice = createElement('em');
      appendText(notice, alt ? `[图片无法导出：${alt}]` : '[图片无法导出]');
      replaceImage(img, notice, true);
      continue;
    }
    const ref = (match[1] ?? '').toLowerCase();
    refs.push(ref);
    const figure = createElement('figure', { 'data-app-size': 'wide', 'data-app-fit': 'contain' });
    appendChild(figure, createElement('img', { 'data-app-asset-ref': ref }));
    if (alt) {
      const caption = createElement('figcaption');
      appendText(caption, alt);
      appendChild(figure, caption);
    }
    replaceImage(img, figure, false);
  }
  return serialize(fragment);
}

interface Range {
  html: string;
  useTemplate: boolean;
  sectionTemplate: boolean;
}

/**
 * 按目录顺序组装整本 HTML（桌面版 technicalPlanExport.build 的组装部分）：封面两行、每节一个带目录编号
 * （data-app-outline-number）的标题加正文，相邻同样式的节合并为一个 section（data-app-export-template /
 * data-app-export-page-template）。目录为空或标题超过六级时抛 DocumentHtmlError。
 */
export function assembleDocumentHtml(snapshot: DocumentSnapshot): DocumentHtml {
  const aiOnly = snapshot.exportTemplateScope === 'ai-only';
  const entries = collectOutlineExportEntries(snapshot.outline, aiOnly);
  const first = entries[0];
  if (!first) throw new DocumentHtmlError('EXPORT_EMPTY', '没有可导出的目录内容');
  const ranges: Range[] = [];
  const warnings: string[] = [];
  const assetRefs = new Set<string>();
  const imageSections = new Map<string, string[]>();
  const imageFailures = new Map<string, string[]>();
  let skippedCount = 0;
  const append = (html: string, useTemplate: boolean, sectionTemplate: boolean) => {
    const previous = ranges.at(-1);
    if (previous?.useTemplate === useTemplate && previous.sectionTemplate === sectionTemplate) previous.html += `\n${html}`;
    else ranges.push({ html, useTemplate, sectionTemplate });
  };
  append(
    `<p style="text-align:center"><em>内容由 AI 生成</em></p><p style="text-align:center"><strong>${escapeHtml(snapshot.projectName || '投标技术文件')}</strong></p>`,
    !aiOnly,
    first.sectionTemplate,
  );
  for (const { item, level, useTemplate, sectionTemplate } of entries) {
    if (level > DOCUMENT_HEADING_LEVEL_MAX) throw new DocumentHtmlError('EXPORT_HEADING_TOO_DEEP', '当前转换器最多支持六级章节标题');
    const label = `${item.number} ${item.title}`;
    let body = '';
    try {
      if (!item.children?.length) {
        if (item.content_mode === 'ai-generate') {
          skippedCount += 1;
          warnings.push(`小节 ${label} 未导出正文：${AI_SECTION_PENDING_REASON}`);
          body = '<p><em>[本小节未完成，未导出正文]</em></p>';
        } else if (String(item.content || '').trim()) {
          const refs: string[] = [];
          const failures: string[] = [];
          body = renderManualSection(String(item.content), refs, failures);
          for (const ref of refs) {
            assetRefs.add(ref);
            imageSections.set(ref, [...(imageSections.get(ref) ?? []), label]);
          }
          if (failures.length) imageFailures.set(label, [...(imageFailures.get(label) ?? []), ...failures]);
        } else {
          const message = getPendingContentModeMessage(item);
          body = message ? `<p><em>[${escapeHtml(message)}]</em></p>` : '';
        }
      }
    } catch (error) {
      throw new DocumentHtmlError('EXPORT_SECTION_FAILED', `小节 ${label} 导出失败`, { cause: error });
    }
    append(`<h${level} data-app-outline-number="${item.number}">${escapeHtml(item.title)}</h${level}>\n${body}`, useTemplate, sectionTemplate);
  }
  const html = ranges
    .map((range) => `<section data-app-export-template="${range.useTemplate}" data-app-export-page-template="${range.sectionTemplate}">${range.html}</section>`)
    .join('\n');
  return { html, sectionCount: entries.length, skippedCount, warnings, assetRefs: [...assetRefs], imageSections, imageFailures };
}

/**
 * 转换完成后的提示与消息（桌面版 technicalPlanExport.build 的收尾与 exportService 的成功消息）：转换器返回的 imageWarnings
 * 按引用逐处归到小节（同一产物的第 k 条归到它第 k 处引用；不在本次引用中或多出的忽略），每个小节一条“有 N 张图片无法导出”的提示，排在组装阶段的提示之后。
 */
export function summarizeDocumentExport(
  document: Pick<DocumentHtml, 'warnings' | 'skippedCount' | 'imageSections' | 'imageFailures'>,
  imageWarnings: readonly ExportImageWarning[],
): { warnings: string[]; message: string } {
  const failures = new Map<string, string[]>();
  for (const [label, reasons] of document.imageFailures) failures.set(label, [...reasons]);
  const seen = new Map<string, number>();
  for (const { assetRef, reason } of imageWarnings) {
    const index = seen.get(assetRef) ?? 0;
    seen.set(assetRef, index + 1);
    const label = document.imageSections.get(assetRef)?.[index];
    if (label !== undefined) failures.set(label, [...(failures.get(label) ?? []), reason]);
  }
  const warnings = [...document.warnings];
  let failedImageCount = 0;
  for (const [label, reasons] of failures) {
    failedImageCount += reasons.length;
    warnings.push(`小节 ${label} 有 ${reasons.length} 张图片无法导出，已在原位置用文字标出：${[...new Set(reasons)].join('；')}`);
  }
  if (!warnings.length) return { warnings, message: EXPORT_DONE_MESSAGE };
  const parts = [
    document.skippedCount ? `其中 ${document.skippedCount} 个 AI 小节未完成，仅保留标题，请完成后重新导出` : '',
    failedImageCount ? `${failedImageCount} 张图片无法导出，已在原位置用文字标出，请打开文档核对` : '',
  ].filter(Boolean);
  return { warnings, message: `Word 已导出，${parts.join('；')}。` };
}
