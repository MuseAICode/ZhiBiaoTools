import MarkdownIt from 'markdown-it';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';
import markdownItTaskLists from 'markdown-it-task-lists';

export interface RenderMarkdownHtmlOptions {
  allowRawHtml?: boolean;
  enableGfm?: boolean;
}

const rendererCache = new Map<string, MarkdownIt>();

// 禁用原始 HTML 时，仍识别不带属性的 <br>、<mark>：AI 表格单元格换行和查错高亮依赖它们。
// 输出的是固定标签，不复制源文本，其余 HTML 照常按文本转义。
const SAFE_INLINE_TAG = /^<(\/?)(br|mark)\s*\/?>/i;

type InlineRule = Parameters<MarkdownIt['inline']['ruler']['before']>[2];

const safeInlineTags: InlineRule = (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x3c) return false;
  const match = SAFE_INLINE_TAG.exec(state.src.slice(state.pos, state.pos + 8));
  if (!match) return false;
  if (!silent) {
    const tag = match[2].toLowerCase();
    const token = state.push('html_inline', '', 0);
    token.content = tag === 'br' ? '<br />' : `<${match[1]}mark>`;
  }
  state.pos += match[0].length;
  return true;
};

function createMarkdownRenderer(options: Required<RenderMarkdownHtmlOptions>): MarkdownIt {
  const renderer = new MarkdownIt(options.enableGfm ? 'default' : 'commonmark', {
    html: options.allowRawHtml,
    linkify: false,
    typographer: false,
    breaks: false,
  });

  if (!options.allowRawHtml) {
    renderer.inline.ruler.before('html_inline', 'safe_inline_tags', safeInlineTags);
  }
  renderer.use(markdownItCjkFriendly);
  if (options.enableGfm) {
    renderer.use(markdownItTaskLists, { enabled: true, label: true, labelAfter: true });
  }

  return renderer;
}

function getMarkdownRenderer(options: RenderMarkdownHtmlOptions = {}): MarkdownIt {
  const normalized: Required<RenderMarkdownHtmlOptions> = {
    allowRawHtml: options.allowRawHtml === true,
    enableGfm: options.enableGfm !== false,
  };
  const cacheKey = `${normalized.allowRawHtml ? 'html' : 'no-html'}:${normalized.enableGfm ? 'gfm' : 'commonmark'}`;
  const cached = rendererCache.get(cacheKey);
  if (cached) return cached;

  const renderer = createMarkdownRenderer(normalized);
  rendererCache.set(cacheKey, renderer);
  return renderer;
}

export function renderMarkdownHtml(content: string, options: RenderMarkdownHtmlOptions = {}): string {
  return getMarkdownRenderer(options).render(String(content || ''));
}
