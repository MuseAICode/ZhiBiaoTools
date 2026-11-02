// 受限 HTML 的解析、清洗与校验：前端 client/src/shared/bodyHtml/restrictedHtml.ts 中 parseRestrictedHtml 的服务端版本
// （路线图第 7 步 7.3a）。前端在浏览器中用 DOMParser，这里用同一套 HTML5 解析算法的 parse5（脚本关闭，与 DOMParser 相同），
// 逐个函数对应、提示文字相同。白名单与前端由测试逐项核对（tests/templates/restrictedHtml.test.ts 读前端源码中的常量），
// 行为由同一份用例在两端核对（client/tests/fixtures/restrictedHtmlCases.json：前端在 jsdom 中、服务端在这里各跑一遍，
// 结果都必须与记录的相同）。改前端的规则时同步改这里，否则两端的测试会失败。
//
// 服务端只把 normalizedHtml（由解析树重新序列化的结果）交给导出沙箱，不转发调用方的原文，避免解析差异。
import { parse, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5';

type Node = DefaultTreeAdapterTypes.Node;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Element = DefaultTreeAdapterTypes.Element;
type Template = DefaultTreeAdapterTypes.Template;

export const RESTRICTED_HTML_BLOCK_MARKER = '<!-- app:block -->';

const BLOCK_MARKER_PATTERN = /<!--\s*app:block\s*-->/gi;
export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const ROOT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ol', 'ul', 'figure', 'table']);
export const INLINE_TAGS = new Set(['strong', 'em', 'u', 'sup', 'sub', 'br']);
export const ALLOWED_TAGS = new Set([
  ...ROOT_TAGS,
  ...INLINE_TAGS,
  'li',
  'template',
  'img',
  'figcaption',
  'caption',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'aside',
]);
export const DANGEROUS_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'base', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'select', 'textarea', 'video', 'audio', 'source', 'canvas', 'svg', 'math',
]);
export const UNKNOWN_BLOCK_TAGS = new Set([
  'html', 'head', 'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'blockquote', 'pre',
  'dl', 'dt', 'dd', 'fieldset', 'details', 'summary', 'hr',
]);
export const FIGURE_GENERATIONS = new Set(['aiImage', 'mermaid', 'htmlImage']);
export const FIGURE_SIZES = new Set(['square', 'wide', 'tall', 'panorama']);
export const FIGURE_FITS = new Set(['contain', 'cover']);
export const TABLE_PRESETS = new Set([
  'plain', 'headerRow', 'headerColumn', 'headerRowAndColumn', 'imageText', 'threeImages', 'fourImages',
]);

export interface RestrictedHtmlIssue {
  blockIndex: number;
  level: 'error' | 'warning';
  message: string;
}

export interface RestrictedHtmlBlock {
  index: number;
  id: string;
  kind: string;
  html: string;
  valid: boolean;
  issues: RestrictedHtmlIssue[];
}

export interface RestrictedHtmlParseResult {
  blocks: RestrictedHtmlBlock[];
  issues: RestrictedHtmlIssue[];
  normalizedHtml: string | null;
  previewHtml: string;
}

export interface RestrictedHtmlParseOptions {
  /** 仅供内置展示模板保留已打包的本地图片地址。 */
  allowImageSrc?: boolean;
}

interface BlockContext {
  index: number;
  issues: RestrictedHtmlIssue[];
}

// ---- 与 DOM 对应的最小操作（parse5 的默认树） ----

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function isText(node: Node): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text';
}

function isTemplate(element: Element): element is Template {
  return 'content' in element;
}

/** element.children：只取元素子节点（template 的内容在 content 中，与 DOM 相同不算子节点）。 */
function elementChildren(parent: ParentNode): Element[] {
  return parent.childNodes.filter(isElement);
}

/** Node.textContent：后代文本节点按顺序拼接，注释不计。 */
function textContent(node: ParentNode): string {
  let text = '';
  for (const child of node.childNodes) {
    if (isText(child)) text += child.value;
    else if (isElement(child)) text += textContent(child);
  }
  return text;
}

function meaningfulNodes(element: Element) {
  return element.childNodes.filter((node) => !isText(node) || Boolean(node.value.trim()));
}

function tagName(element: Element) {
  return element.tagName.toLowerCase();
}

function getAttribute(element: Element, name: string): string | null {
  const attribute = element.attrs.find((item) => attributeName(item) === name);
  return attribute ? attribute.value : null;
}

function hasAttribute(element: Element, name: string) {
  return getAttribute(element, name) !== null;
}

/** Attr.name：带前缀的外来属性（只出现在 svg / math 中，它们整块删除）写成 prefix:name。 */
function attributeName(attribute: Element['attrs'][number]) {
  return attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
}

function removeNode(node: ChildNode) {
  const parent = node.parentNode;
  if (!parent) return;
  parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
  node.parentNode = null;
}

/** node.replaceWith(...nodes) */
function replaceWith(node: ChildNode, nodes: ChildNode[]) {
  const parent = node.parentNode;
  if (!parent) return;
  for (const item of nodes) item.parentNode = parent;
  parent.childNodes.splice(parent.childNodes.indexOf(node), 1, ...nodes);
  node.parentNode = null;
}

function addIssue(context: BlockContext, level: RestrictedHtmlIssue['level'], message: string) {
  context.issues.push({ blockIndex: context.index, level, message });
}

function replaceTag(element: Element, nextTag: string) {
  const replacement: Element = {
    nodeName: nextTag,
    tagName: nextTag,
    attrs: element.attrs.map((attribute) => ({ name: attributeName(attribute), value: attribute.value })),
    namespaceURI: element.namespaceURI,
    parentNode: null,
    childNodes: [],
  };
  const children = element.childNodes.splice(0);
  for (const child of children) child.parentNode = replacement;
  replacement.childNodes = children;
  replaceWith(element, [replacement]);
  return replacement;
}

function unwrapElement(element: Element) {
  replaceWith(element, element.childNodes.slice());
  element.childNodes = [];
}

// ---- 以下与前端逐个函数对应 ----

function allowedAttributes(element: Element, options: RestrictedHtmlParseOptions) {
  const tag = tagName(element);
  const names = new Set<string>();
  if (ROOT_TAGS.has(tag)) names.add('id');
  if (tag === 'ol') names.add('start');
  if (tag === 'figure') {
    names.add('data-app-generation');
    names.add('data-app-size');
    names.add('data-app-fit');
  }
  if (tag === 'template' || tag === 'aside') names.add('data-app-role');
  if (tag === 'img') {
    names.add('alt');
    names.add('data-app-asset-ref');
    if (options.allowImageSrc) names.add('src');
  }
  if (tag === 'table') names.add('data-app-preset');
  if (tag === 'th' || tag === 'td') {
    names.add('rowspan');
    names.add('colspan');
  }
  if (tag === 'th') names.add('scope');
  return names;
}

function sanitizeElement(element: Element, context: BlockContext, options: RestrictedHtmlParseOptions) {
  let current = element;
  let tag = tagName(current);

  if (DANGEROUS_TAGS.has(tag)) {
    addIssue(context, 'error', `禁止使用 <${tag}>`);
    removeNode(current);
    return;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    if (UNKNOWN_BLOCK_TAGS.has(tag)) {
      addIssue(context, 'error', `不支持块标签 <${tag}>`);
      removeNode(current);
      return;
    }
    addIssue(context, 'warning', `已移除行内标签 <${tag}>，并保留其中的文字`);
    for (const child of elementChildren(current)) sanitizeElement(child, context, options);
    unwrapElement(current);
    return;
  }

  if (tag === 'b') current = replaceTag(current, 'strong');
  if (tag === 'i') current = replaceTag(current, 'em');
  tag = tagName(current);

  const whitelist = allowedAttributes(current, options);
  for (const item of current.attrs.slice()) {
    const attribute = { name: attributeName(item) };
    if (!whitelist.has(attribute.name.toLowerCase())) {
      current.attrs.splice(current.attrs.indexOf(item), 1);
      addIssue(context, 'warning', `已删除 <${tag}> 的属性 ${attribute.name}`);
    }
  }

  for (const child of elementChildren(current)) sanitizeElement(child, context, options);
}

function onlyWhitespaceTextOutside(element: Element, allowed: Set<string>) {
  return element.childNodes.every((node) => {
    if (isText(node)) return !node.value.trim();
    return isElement(node) && allowed.has(tagName(node));
  });
}

function hasOnlyInlineContent(element: Element): boolean {
  return element.childNodes.every((node) => {
    if (isText(node)) return true;
    if (!isElement(node)) return false;
    return INLINE_TAGS.has(tagName(node)) && (tagName(node) === 'br' || hasOnlyInlineContent(node));
  });
}

function positiveIntegerAttribute(element: Element, name: string, context: BlockContext, required = false) {
  const value = getAttribute(element, name);
  if (value == null) {
    if (required) addIssue(context, 'error', `<${tagName(element)}> 缺少 ${name}`);
    return 1;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    addIssue(context, 'error', `<${tagName(element)}> 的 ${name} 必须是正整数`);
    return 1;
  }
  return Number(value);
}

function validateId(element: Element, context: BlockContext, ids: Map<string, number>) {
  const id = getAttribute(element, 'id') || '';
  if (!ID_PATTERN.test(id)) {
    addIssue(context, 'error', `<${tagName(element)}> 缺少合法 id`);
    return;
  }
  const previous = ids.get(id);
  if (previous != null) {
    addIssue(context, 'error', `id ${id} 与第 ${previous + 1} 个块重复`);
    return;
  }
  ids.set(id, context.index);
}

function validateInlineContainer(element: Element, context: BlockContext) {
  if (!hasOnlyInlineContent(element)) addIssue(context, 'error', `<${tagName(element)}> 包含不允许的子节点`);
}

function validateList(list: Element, context: BlockContext) {
  if (!onlyWhitespaceTextOutside(list, new Set(['li']))) {
    addIssue(context, 'error', `<${tagName(list)}> 只能直接包含 li`);
  }
  if (tagName(list) === 'ol' && hasAttribute(list, 'start')) positiveIntegerAttribute(list, 'start', context);
  for (const item of elementChildren(list).filter((child) => tagName(child) === 'li')) {
    for (const node of item.childNodes) {
      if (isText(node)) continue;
      if (!isElement(node)) {
        addIssue(context, 'error', 'li 包含不支持的内容');
        continue;
      }
      const child = node;
      const childTag = tagName(child);
      if (INLINE_TAGS.has(childTag)) validateInlineContainer(child, context);
      else if (childTag === 'ol' || childTag === 'ul') validateList(child, context);
      else addIssue(context, 'error', `li 不能包含 <${childTag}>`);
    }
  }
}

function validateFigure(figure: Element, context: BlockContext, ids: Map<string, number>) {
  validateId(figure, context, ids);
  const generation = getAttribute(figure, 'data-app-generation') || '';
  if (!FIGURE_GENERATIONS.has(generation)) addIssue(context, 'error', 'figure 缺少合法 data-app-generation');
  const size = getAttribute(figure, 'data-app-size') || '';
  if (!FIGURE_SIZES.has(size)) addIssue(context, 'error', 'figure 缺少合法 data-app-size');
  const fit = getAttribute(figure, 'data-app-fit');
  if (fit !== null && !FIGURE_FITS.has(fit)) addIssue(context, 'error', 'figure 的 data-app-fit 只能是 contain 或 cover');
  if (!onlyWhitespaceTextOutside(figure, new Set(['template', 'img', 'figcaption']))) {
    addIssue(context, 'error', 'figure 只能包含 template、img 和 figcaption');
  }
  const templates = elementChildren(figure).filter((child) => tagName(child) === 'template');
  const images = elementChildren(figure).filter((child) => tagName(child) === 'img');
  const captions = elementChildren(figure).filter((child) => tagName(child) === 'figcaption');
  if (templates.length !== 1) addIssue(context, 'error', 'figure 必须包含一个配图提示 template');
  if (images.length !== 1) addIssue(context, 'error', 'figure 必须包含一个 img');
  if (captions.length > 1) addIssue(context, 'error', 'figure 最多包含一个 figcaption');
  const prompt = templates[0];
  if (prompt) {
    if (getAttribute(prompt, 'data-app-role') !== 'prompt') addIssue(context, 'error', 'template 的 data-app-role 必须为 prompt');
    const promptContent: ParentNode = isTemplate(prompt) ? prompt.content : prompt;
    if (elementChildren(promptContent).length || !textContent(promptContent).trim()) {
      addIssue(context, 'error', '配图提示 template 只能包含非空文字');
    }
  }
  const image = images[0];
  if (image) {
    if (!getAttribute(image, 'alt')?.trim()) addIssue(context, 'error', 'img 必须包含非空 alt');
    const assetRef = getAttribute(image, 'data-app-asset-ref');
    if (assetRef != null && !isWorkspaceRelativeAssetRef(assetRef)) {
      addIssue(context, 'error', 'data-app-asset-ref 必须是工作区内的相对路径');
    }
  }
  if (captions[0]) validateInlineContainer(captions[0], context);
}

/** 校验图片资产引用，只允许使用正斜杠表示的工作区相对路径。 */
function isWorkspaceRelativeAssetRef(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.includes('\\') || normalized.startsWith('/')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)) return false;
  return !normalized.split('/').some((part) => part === '..');
}

function tableRows(table: Element) {
  const rows: Element[] = [];
  for (const section of elementChildren(table).filter((child) => ['thead', 'tbody'].includes(tagName(child)))) {
    rows.push(...elementChildren(section).filter((child) => tagName(child) === 'tr'));
  }
  return rows;
}

function sectionRows(section: Element) {
  return elementChildren(section).filter((child) => tagName(child) === 'tr');
}

function rowCells(row: Element) {
  return elementChildren(row).filter((child) => ['th', 'td'].includes(tagName(child)));
}

function validateTableGrid(table: Element, context: BlockContext) {
  const carry: number[] = [];
  let expectedColumns: number | null = null;
  for (const row of tableRows(table)) {
    let column = 0;
    for (const cell of rowCells(row)) {
      while ((carry[column] || 0) > 0) column += 1;
      const colspan = positiveIntegerAttribute(cell, 'colspan', context);
      const rowspan = positiveIntegerAttribute(cell, 'rowspan', context);
      for (let offset = 0; offset < colspan; offset += 1) {
        if ((carry[column + offset] || 0) > 0) addIssue(context, 'error', '表格合并单元格发生重叠');
        if (rowspan > 1) carry[column + offset] = rowspan;
      }
      column += colspan;
    }
    let width = column;
    while ((carry[width] || 0) > 0) width += 1;
    if (expectedColumns == null) expectedColumns = width;
    else if (width !== expectedColumns) addIssue(context, 'error', '表格各行逻辑列数不一致');
    for (let index = 0; index < carry.length; index += 1) carry[index] = Math.max(0, (carry[index] || 0) - 1);
  }
  if (carry.some((remaining) => remaining > 0)) addIssue(context, 'error', 'rowspan 超出表格末行');
}

function directFigure(cell: Element) {
  const nodes = meaningfulNodes(cell);
  const only = nodes.length === 1 ? nodes[0]! : null;
  return only && isElement(only) && tagName(only) === 'figure' ? only : null;
}

function validateImagePreset(table: Element, preset: string, context: BlockContext) {
  const tbody = elementChildren(table).find((child) => tagName(child) === 'tbody');
  const rows = tbody ? elementChildren(tbody).filter((child) => tagName(child) === 'tr') : [];
  const expectedRows = preset === 'fourImages' ? 2 : 1;
  const expectedCells = preset === 'threeImages' ? 3 : 2;
  if (rows.length !== expectedRows || rows.some((row) => rowCells(row).length !== expectedCells)) {
    addIssue(context, 'error', `${preset} 的行列结构不符合规范`);
    return;
  }
  for (const [rowIndex, row] of rows.entries()) {
    for (const [cellIndex, cell] of rowCells(row).entries()) {
      if (hasAttribute(cell, 'rowspan') || hasAttribute(cell, 'colspan')) addIssue(context, 'error', `${preset} 禁止合并单元格`);
      if (preset === 'imageText' && (rowIndex !== 0 || cellIndex === 1)) continue;
      const figure = directFigure(cell);
      if (!figure) addIssue(context, 'error', `${preset} 的图片单元格必须只包含一个 figure`);
      else if (preset !== 'imageText' && !elementChildren(figure).some((child) => tagName(child) === 'figcaption')) {
        addIssue(context, 'error', `${preset} 的每张图片都必须包含图注`);
      }
    }
  }
}

function validateTable(table: Element, context: BlockContext, ids: Map<string, number>) {
  validateId(table, context, ids);
  const preset = getAttribute(table, 'data-app-preset') || '';
  if (!TABLE_PRESETS.has(preset)) addIssue(context, 'error', 'table 缺少合法 data-app-preset');
  if (!onlyWhitespaceTextOutside(table, new Set(['caption', 'thead', 'tbody']))) {
    addIssue(context, 'error', 'table 只能直接包含 caption、thead 和 tbody');
  }
  const captions = elementChildren(table).filter((child) => tagName(child) === 'caption');
  const heads = elementChildren(table).filter((child) => tagName(child) === 'thead');
  const bodies = elementChildren(table).filter((child) => tagName(child) === 'tbody');
  if (captions.length > 1 || heads.length > 1 || bodies.length !== 1) addIssue(context, 'error', 'table 的 caption、thead 或 tbody 数量不符合规范');
  if (bodies[0] && sectionRows(bodies[0]).length === 0) addIssue(context, 'error', 'tbody 至少包含一行');
  for (const caption of captions) validateInlineContainer(caption, context);
  for (const section of [...heads, ...bodies]) {
    if (!onlyWhitespaceTextOutside(section, new Set(['tr']))) addIssue(context, 'error', `<${tagName(section)}> 只能包含 tr`);
    for (const row of elementChildren(section).filter((child) => tagName(child) === 'tr')) {
      if (!onlyWhitespaceTextOutside(row, new Set(['th', 'td']))) addIssue(context, 'error', 'tr 只能包含 th 或 td');
      for (const cell of rowCells(row)) {
        positiveIntegerAttribute(cell, 'rowspan', context);
        positiveIntegerAttribute(cell, 'colspan', context);
        const scope = getAttribute(cell, 'scope');
        if (scope && (tagName(cell) !== 'th' || !['row', 'col'].includes(scope))) addIssue(context, 'error', 'scope 只能在 th 上使用 row 或 col');
        for (const child of elementChildren(cell)) {
          const childTag = tagName(child);
          if (INLINE_TAGS.has(childTag) || childTag === 'p') validateInlineContainer(child, context);
          else if (childTag === 'ol' || childTag === 'ul') validateList(child, context);
          else if (childTag === 'figure') validateFigure(child, context, ids);
          else if (childTag === 'table') validateTable(child, context, ids);
          else addIssue(context, 'error', `单元格不能包含 <${childTag}>`);
        }
      }
    }
  }
  const firstHeadCells = heads[0] ? sectionRows(heads[0]).flatMap(rowCells) : [];
  const bodyRows = bodies[0] ? sectionRows(bodies[0]) : [];
  if (preset === 'headerRow' || preset === 'headerRowAndColumn') {
    if (!heads[0] || firstHeadCells.some((cell) => tagName(cell) !== 'th' || getAttribute(cell, 'scope') !== 'col')) {
      addIssue(context, 'error', `${preset} 的表头必须使用 th scope="col"`);
    }
  }
  if (preset === 'headerColumn' || preset === 'headerRowAndColumn') {
    if (bodyRows.some((row) => {
      const first = rowCells(row)[0];
      return !first || tagName(first) !== 'th' || getAttribute(first, 'scope') !== 'row';
    })) addIssue(context, 'error', `${preset} 的首列必须使用 th scope="row"`);
  }
  if (['imageText', 'threeImages', 'fourImages'].includes(preset)) validateImagePreset(table, preset, context);
  validateTableGrid(table, context);
}

function validateBlock(root: Element, aside: Element | null, context: BlockContext, ids: Map<string, number>) {
  const tag = tagName(root);
  if (/^h[1-6]$/.test(tag)) {
    validateId(root, context, ids);
    if (elementChildren(root).length || !textContent(root).trim()) addIssue(context, 'error', '标题只能包含非空纯文本');
  } else if (tag === 'p') {
    validateId(root, context, ids);
    validateInlineContainer(root, context);
    if (!textContent(root).trim()) addIssue(context, 'error', '段落不能为空');
  } else if (tag === 'ol' || tag === 'ul') {
    validateId(root, context, ids);
    validateList(root, context);
  } else if (tag === 'figure') {
    validateFigure(root, context, ids);
  } else if (tag === 'table') {
    validateTable(root, context, ids);
  }
  if (aside) {
    if (tag !== 'table' || getAttribute(aside, 'data-app-role') !== 'table-notes') addIssue(context, 'error', 'aside 只能作为表格后的 table-notes');
    if (!onlyWhitespaceTextOutside(aside, new Set(['p']))) addIssue(context, 'error', '表注 aside 只能包含 p');
    for (const paragraph of elementChildren(aside)) validateInlineContainer(paragraph, context);
  }
}

/** DOMParser.parseFromString(fragment, 'text/html').body：html 下的 body（或 frameset）。 */
function documentBody(fragment: string): Element {
  // DOMParser 创建的文档不执行脚本，noscript 的内容按标记解析；parse5 默认按开启脚本处理，这里显式关闭。
  const document = parse(fragment, { scriptingEnabled: false });
  const html = elementChildren(document).find((child) => tagName(child) === 'html');
  const body = html && elementChildren(html).find((child) => tagName(child) === 'body' || tagName(child) === 'frameset');
  if (!body) throw new Error('HTML 文档缺少 body');
  return body;
}

function parseFragment(fragment: string, index: number, ids: Map<string, number>, options: RestrictedHtmlParseOptions): RestrictedHtmlBlock {
  const context: BlockContext = { index, issues: [] };
  const body = documentBody(fragment);
  for (const child of elementChildren(body)) sanitizeElement(child, context, options);
  const roots = elementChildren(body);
  const root = roots[0] || null;
  const aside = roots.length === 2 && tagName(roots[1]!) === 'aside' ? roots[1]! : null;
  if (!root || !ROOT_TAGS.has(tagName(root))) addIssue(context, 'error', '片段缺少合法主块');
  if (roots.length !== (aside ? 2 : 1)) addIssue(context, 'error', '每个片段只能包含一个主块，表格可额外包含一个表注');
  if (root && ROOT_TAGS.has(tagName(root))) validateBlock(root, aside, context, ids);
  const html = root ? [serializeOuter(root), aside ? serializeOuter(aside) : ''].filter(Boolean).join('\n') : '';
  return {
    index,
    id: (root && getAttribute(root, 'id')) || '',
    kind: root ? tagName(root) : 'invalid',
    html,
    valid: !context.issues.some((issue) => issue.level === 'error'),
    issues: context.issues,
  };
}

/** 解析、清洗并校验一段智标受限 HTML（与前端 parseRestrictedHtml 相同）。 */
export function parseRestrictedHtml(source: string, options: RestrictedHtmlParseOptions = {}): RestrictedHtmlParseResult {
  const raw = String(source || '');
  const markerMatches = raw.match(BLOCK_MARKER_PATTERN) || [];
  const pieces = raw.split(BLOCK_MARKER_PATTERN);
  const globalIssues: RestrictedHtmlIssue[] = [];
  if (pieces[0]?.trim()) globalIssues.push({ blockIndex: 0, level: 'error', message: '首个正文块前缺少 app:block 分隔注释' });
  const fragments = pieces.slice(markerMatches.length ? 1 : 0).filter((piece) => piece.trim());
  if (!markerMatches.length && raw.trim()) {
    fragments.splice(0, fragments.length, raw);
  }
  const ids = new Map<string, number>();
  const blocks = fragments.map((fragment, index) => parseFragment(fragment, index, ids, options));
  if (!raw.trim()) return { blocks: [], issues: [], normalizedHtml: '', previewHtml: '' };
  if (!blocks.length) globalIssues.push({ blockIndex: 0, level: 'error', message: '没有可解析的正文块' });
  const issues = [...globalIssues, ...blocks.flatMap((block) => block.issues)];
  const validBlocks = blocks.filter((block) => block.valid);
  const normalized = validBlocks.map((block) => `${RESTRICTED_HTML_BLOCK_MARKER}\n${block.html}`).join('\n\n');
  return {
    blocks,
    issues,
    normalizedHtml: issues.some((issue) => issue.level === 'error') ? null : normalized,
    previewHtml: validBlocks.map((block) => block.html).join('\n'),
  };
}
