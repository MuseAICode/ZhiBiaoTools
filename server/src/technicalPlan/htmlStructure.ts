// 小节 HTML 的结构检查（路线图第 8 步 8.10c2a；docs/SERVER_DESIGN.md 第 7.43 节），与桌面版 client/electron/utils/htmlStructure.cjs 的
// findHtmlStructureIssues、assertHtmlStructure、closeOpenTemplates 相同（repairHtmlStructure 属整本导出的修复，随 8.12）。
//
// 桌面版用 cheerio（parse5 + htmlparser2 树）解析，这里直接用 parse5 的默认树，按 cheerio 的遍历规则还原同样的结果：
// - 片段解析：cheerio 的 load(html, options, false) 即 parse5.parseFragment(html, { scriptingEnabled: true, ... })，上下文为空（template）；
// - `$('*')`、`$(node).find(...)` 会进入 <template> 的内容（htmlparser2 树把内容作为 template 的唯一子节点），文档顺序为先序遍历；
// - `closest` / `parents` 只沿元素向上，到 template 内容的根（以及片段的根）即停止；
// - closeOpenTemplates 取 template 内容中第一个 type 为 'tag' 的子节点：htmlparser2 树中 script / style 的 type 不是 'tag'，不算。
// 测试按桌面版（cheerio 1.2.0）对同一输入的结果逐条核对（tests/technicalPlan/htmlStructure.test.ts）。
//
// 本模块只检查 Agent 与模型写出的 HTML（不可信输入）；入库时另经 parseRestrictedHtml（8.10a）规范化，这里不承担清洗。
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';

type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Template = DefaultTreeAdapterTypes.Template;

// 空元素没有结束标签；可省略结束标签的元素会被后续标签自然结束，不会把后面的小节吞进来。
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const OPTIONAL_END_ELEMENTS = new Set(['p', 'li', 'dt', 'dd', 'rt', 'rp', 'optgroup', 'option', 'colgroup', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
const FIGURE_SIZES = new Set(['square', 'wide', 'tall', 'panorama']);
// `</` 后不是标签名时，解析器把它连同到下一个 > 为止的内容当注释丢弃。模型把工具调用标记（如 DSML）混入正文时出现，
// 常见于把 </template> 写错或输出中途结束；注释内的文字跳过。
const INVALID_END_TAG = /<!--[\s\S]*?(?:-->|$)|<\/(?![A-Za-z])[^>]*>?/g;
const stripInvalidEndTags = (html: string): string => html.replace(INVALID_END_TAG, (match) => (match.startsWith('</') ? '' : match));
const invalidEndTags = (html: string): RegExpExecArray[] => [...html.matchAll(INVALID_END_TAG)].filter((match) => match[0].startsWith('</'));

const isElement = (node: ChildNode | ParentNode): node is Element => 'tagName' in node;

/** 子节点：template 的子节点是它的内容（与 htmlparser2 树相同），其余元素与片段为 childNodes。 */
function childrenOf(node: ParentNode): readonly ChildNode[] {
  if (isElement(node) && node.tagName === 'template') return (node as Template).content.childNodes;
  return 'childNodes' in node ? node.childNodes : [];
}

/** 先序遍历全部元素（cheerio 的 `*`、find 会进入 template 的内容）。 */
function descendants(node: ParentNode): Element[] {
  const result: Element[] = [];
  const visit = (parent: ParentNode) => {
    for (const child of childrenOf(parent)) {
      if (!isElement(child)) continue;
      result.push(child);
      visit(child);
    }
  };
  visit(node);
  return result;
}

/** 元素的上级元素：父节点不是元素（片段根、template 内容的根）时为 null（与 cheerio 的 closest / parents 相同）。 */
function parentElement(node: Element): Element | null {
  const parent = node.parentNode;
  return parent && isElement(parent) ? parent : null;
}

function closest(node: Element, tagName: string): Element | null {
  for (let current: Element | null = node; current; current = parentElement(current)) {
    if (current.tagName === tagName) return current;
  }
  return null;
}

function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((attr) => attr.name === name)?.value;
}

// 只取属于该 figure 自身的图片，不含嵌套 figure 内的图片。
function ownImages(figure: Element): Element[] {
  return descendants(figure).filter((node) => node.tagName === 'img' && closest(node, 'figure') === figure);
}

function describe(node: Element): string {
  const id = attribute(node, 'id');
  const at = node.sourceCodeLocation?.startLine;
  return `${at ? `第 ${at} 行` : ''}<${node.tagName}${id ? ` id="${id}"` : ''}>`;
}

export interface HtmlStructureOptions {
  /** 正文生成保存时同时检查源码是否在标签或注释中途结束。 */
  readonly checkSourceCompleteness?: boolean;
}

/** 找出元素闭合和图片结构问题（与桌面版 findHtmlStructureIssues 相同，说明文字与顺序相同）。 */
export function findHtmlStructureIssues(html: unknown, { checkSourceCompleteness = false }: HtmlStructureOptions = {}): string[] {
  const source = String(html || '');
  // 解析器补建的格式元素沿用原标签位置，按源码位置去重，不同元素分别报告。
  const issues = new Map<string, string>();
  const root = parseFragment(source, {
    sourceCodeLocationInfo: true,
    scriptingEnabled: true,
    // 复用本次解析，只将 EOF 类错误作为源码未结束，普通文本比较符等容错提示不拦截。
    onParseError(error) {
      if (!checkSourceCompleteness || !error.code.startsWith('eof-')) return;
      const reason = error.code === 'eof-in-comment' ? '注释尚未结束'
        : error.code === 'eof-in-tag' ? '标签尚未结束'
          : error.code === 'eof-before-tag-name' ? '标签尚未写完' : '元素源码尚未结束';
      issues.set(`${error.startOffset}|${error.code}`, `第 ${error.startLine} 行第 ${error.startCol} 列：${reason}（${error.code}）`);
    },
  });
  const add = (node: Element, message: string) => issues.set(`${node.sourceCodeLocation?.startOffset}|${message}`, message);
  // 异常标记通常是其后未闭合问题的起因，排在最前，便于在截取的说明中看到。
  for (const match of invalidEndTags(source)) {
    issues.set(`${match.index}|invalid`, `第 ${source.slice(0, match.index).split('\n').length} 行出现异常结束标记（</ 后不是标签名），多为模型输出异常，标记之后的内容可能缺失`);
  }
  const elements = descendants(root);
  for (const node of elements) {
    const location = node.sourceCodeLocation;
    if (location?.startTag && !location.endTag && !VOID_ELEMENTS.has(node.tagName) && !OPTIONAL_END_ELEMENTS.has(node.tagName)) {
      add(node, `${describe(node)} 缺少结束标签 </${node.tagName}>`);
    }
  }
  for (const node of elements.filter((element) => element.tagName === 'figure')) {
    if (parentElement(node) && closest(parentElement(node)!, 'figure')) add(node, `${describe(node)} 嵌套在另一个 figure 中`);
    const direct = node.childNodes.filter((child) => isElement(child) && child.tagName === 'img').length;
    const wrapped = ownImages(node).length - direct;
    if (direct !== 1) {
      add(node, direct === 0 && wrapped
        ? `${describe(node)} 的 img 被其他元素包裹，须作为 figure 的直接子元素`
        : `${describe(node)} 须直接包含且仅包含一个 img，当前为 ${direct} 个`);
    }
    if (!FIGURE_SIZES.has((attribute(node, 'data-app-size') || '').trim())) add(node, `${describe(node)} 缺少合法的 data-app-size`);
  }
  for (const node of elements.filter((element) => element.tagName === 'img')) {
    if (!closest(node, 'figure')) add(node, `${describe(node)} 须放在 figure 内`);
  }
  return [...issues.values()];
}

/** 与桌面版 assertHtmlStructure 相同的说明；message 交给 Agent 或写作模型的调用方，按不可信纯文本处理。 */
export class HtmlStructureError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`HTML 结构不完整，请修正后重新保存：${issues.slice(0, 8).join('；')}${issues.length > 8 ? `；另有 ${issues.length - 8} 处` : ''}。除 img 等空元素外，每个元素都要写出结束标签；每个 figure 以 </figure> 结束，并直接包含一个 img。`);
    this.name = 'HtmlStructureError';
    this.issues = issues;
  }
}

/** 保存前校验：有问题时抛 HtmlStructureError（说明可直接交给 Agent 修复）。 */
export function assertHtmlStructure(html: unknown, options?: HtmlStructureOptions): void {
  const issues = findHtmlStructureIssues(html, options);
  if (issues.length) throw new HtmlStructureError(issues);
}

/**
 * 按文档顺序列出某种元素的属性（与桌面版 cheerio 的 `$(tag)` 相同：片段解析、进入 <template> 的内容；同名属性取第一个）。
 * 供提交校验检查 img 的配图引用（8.10c3a，contentSubmission.ts，桌面版 validateContentImageReferences）。
 */
export function elementAttributes(html: unknown, tagName: string): ReadonlyMap<string, string>[] {
  const root = parseFragment(String(html), { scriptingEnabled: true });
  return descendants(root)
    .filter((node) => node.tagName === tagName)
    .map((node) => {
      const attributes = new Map<string, string>();
      for (const attr of node.attrs) if (!attributes.has(attr.name)) attributes.set(attr.name, attr.value);
      return attributes;
    });
}

/** template 内容中第一个 htmlparser2 树中 type 为 'tag' 的子节点（script / style 不算）。 */
function firstTag(template: Template): Element | undefined {
  return template.content.childNodes.find((child): child is Element => isElement(child) && child.tagName !== 'script' && child.tagName !== 'style');
}

/**
 * 提示词模板只含文字。模型把 </template> 写成异常标记时，后面的 img、图注乃至本节后续正文都会并入模板；在模板的第一个子元素前
 * 补上结束标签并删除其中的异常标记即可无损恢复。逐个修复后重新解析，直到没有可补的模板（与桌面版 closeOpenTemplates 相同）。
 */
export function closeOpenTemplates(html: unknown): { html: string; closed: number } {
  let source = String(html || '');
  let closed = 0;
  for (;;) {
    const root = parseFragment(source, { sourceCodeLocationInfo: true, scriptingEnabled: true });
    const target = descendants(root)
      .filter((node): node is Template => node.tagName === 'template')
      .map((node) => [node, firstTag(node)] as const)
      .find(([node, first]) => {
        const location = node.sourceCodeLocation;
        const start = first?.sourceCodeLocation?.startOffset;
        return Boolean(location?.startTag && !location.endTag && start !== undefined && start >= location.startTag.endOffset);
      });
    if (!target) return { html: source, closed };
    const [node, first] = target;
    const start = node.sourceCodeLocation!.startTag!.endOffset;
    const end = first!.sourceCodeLocation!.startOffset;
    const inner = stripInvalidEndTags(source.slice(start, end));
    const prompt = inner.trimEnd();
    source = `${source.slice(0, start)}${prompt}</template>${inner.slice(prompt.length)}${source.slice(end)}`;
    closed += 1;
  }
}
