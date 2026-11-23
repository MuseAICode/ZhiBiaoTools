// render-layout 沙箱的版式投影（路线图第 8 步 8.8c）：把 docx-editor 的 session.layout() 结果截取成“版式 JSON”。
// 镜像构建时与页面脚本（page.mjs）、docx-editor 一起打进浏览器脚本，在页面中执行；测试直接导入本文件。
//
// 版式 JSON 只保留桌面版格式自检（client/electron/services/contentGenerationLayout.cjs 的 analyzeLayout）读取的字段，
// 结构与 docx-editor 的版式结果相同（字段名、嵌套一致），所以 analyzeLayout 不经修改就能读：
//   { version: 1,
//     pages: [{ index, contentBox: { width, height }, fragments: [Block] }],
//     destinations: [{ anchor: { name, paragraphId } }] }       // 只有 APPMARKLAYOUT 定位书签（app_layout_<n>）
//   Block = { kind: 'paragraph', paragraphId, fragmentIndex, box, styleId, outlineLevel, props, spacing: { before, after },
//             lines: [{ box: { height }, drawings: [{}…], spans: [{ text }] }] }
//         | { kind: 'table', box, rows: [{ cells: [{ blocks: [Block] }] }] }
//         | { kind: <其他>, box }
//   box = { x, y, width, height }（pt，相对于页面正文区）
// 截取规则（与 analyzeLayout 的读法等价，tests/sandbox/renderLayoutEntry.test.ts 用 docx-editor 的完整结果核对）：
// - props 只保留 pageBreakBefore（analyzeLayout 只判断它是否存在）；
// - 一行的各个 span 合成一个 span（analyzeLayout 只把它们的文字拼接或判断是否有非空白文字）；
// - drawings 只保留个数（每个绘图一个空对象，analyzeLayout 只看个数）；
// - spacing 的 before / after 不是有限数时记为 0（analyzeLayout 按 `|| 0` 读）；
// - 其他字段（字体、样式属性、修订、内容控件、元数据等）一律不交出沙箱。
// 投影不截断文字、不改坐标；结果在 worker 中按不可信输入逐项校验（server/src/render/wordLayout.ts）。

export const LAYOUT_VERSION = 1;
/** 交出沙箱的定位书签名（OpenXmlHelper 的 RestrictedHtmlDocumentRenderer 按 APPMARKLAYOUT:app_layout_<n> 写入）。 */
export const LAYOUT_BOOKMARK = /^app_layout_[0-9]{1,6}$/;

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const coordinate = (value) => (typeof value === 'number' ? value : NaN);

function box(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return { x: coordinate(value.x), y: coordinate(value.y), width: coordinate(value.width), height: coordinate(value.height) };
}

function lineOf(raw) {
  const spans = Array.isArray(raw?.spans) ? raw.spans : [];
  const drawings = Array.isArray(raw?.drawings) ? raw.drawings : [];
  return {
    box: { height: coordinate(raw?.box?.height) },
    drawings: drawings.map(() => ({})),
    spans: [{ text: spans.map((span) => (typeof span?.text === 'string' ? span.text : '')).join('') }],
  };
}

function blockOf(raw) {
  const kind = typeof raw?.kind === 'string' ? raw.kind : 'unknown';
  if (kind === 'paragraph') {
    const props = Array.isArray(raw.props) && raw.props.some((prop) => prop?.localName === 'pageBreakBefore') ? [{ localName: 'pageBreakBefore' }] : [];
    return {
      kind,
      paragraphId: raw.paragraphId,
      fragmentIndex: raw.fragmentIndex,
      box: box(raw.box),
      styleId: typeof raw.styleId === 'string' ? raw.styleId : null,
      outlineLevel: typeof raw.outlineLevel === 'number' ? raw.outlineLevel : null,
      props,
      spacing: { before: finite(raw.spacing?.before), after: finite(raw.spacing?.after) },
      lines: (Array.isArray(raw.lines) ? raw.lines : []).map(lineOf),
    };
  }
  if (kind === 'table') {
    return {
      kind,
      box: box(raw.box),
      rows: (Array.isArray(raw.rows) ? raw.rows : []).map((row) => ({
        cells: (Array.isArray(row?.cells) ? row.cells : []).map((cell) => ({ blocks: (Array.isArray(cell?.blocks) ? cell.blocks : []).map(blockOf) })),
      })),
    };
  }
  return { kind, box: box(raw?.box) };
}

/** 把 docx-editor 的版式结果截取成版式 JSON（纯函数，不读写任何外部状态）。 */
export function projectLayout(layout) {
  const pages = Array.isArray(layout?.pages) ? layout.pages : [];
  const destinations = Array.isArray(layout?.destinations) ? layout.destinations : [];
  return {
    version: LAYOUT_VERSION,
    pages: pages.map((page) => ({
      index: page?.index,
      contentBox: { width: coordinate(page?.contentBox?.width), height: coordinate(page?.contentBox?.height) },
      fragments: (Array.isArray(page?.fragments) ? page.fragments : []).map(blockOf),
    })),
    destinations: destinations
      .filter((destination) => typeof destination?.anchor?.name === 'string' && LAYOUT_BOOKMARK.test(destination.anchor.name))
      .map((destination) => ({ anchor: { name: destination.anchor.name, paragraphId: destination.anchor.paragraphId } })),
  };
}
