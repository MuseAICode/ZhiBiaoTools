// 导出格式（模板 config）的默认值与规范化：桌面版 client/electron/services/exportFormatDefaults.cjs 中
// defaultExportFormat / normalizeExportFormat 的服务端版本（路线图第 7 步 7.3a，#43 发现的问题第 1 项）。
// 服务端在样张与整本导出入队时规范化，导出沙箱中的助手不再收到缺字段的配置。逐字段与桌面版相同（包括桌面版
// 原样透传的字段，如 body_text 的 spacing_*、line_spacing_*），tests/templates/exportFormat.test.ts 用同一批输入
// （默认值、系统模板、各字段的各种类型、随机生成的配置）与桌面版的函数逐项比较。改桌面版时同步改这里。
//
// 规范化只补齐缺失与类型不符的字段，不限制取值范围；配置的大小由请求体上限与 EXPORT_TEMPLATE_CONFIG_MAX_BYTES 限制，
// 取值在导出沙箱中使用。

/** 规范化后的导出格式。各字段的取值见 defaultExportFormat。 */
export type ExportFormat = {
  template_name: string;
  page: Record<string, unknown>;
  heading_level1_page_break_before: boolean;
  heading_border: Record<string, unknown> & { level_cell_colors: string[] };
  headings: Array<Record<string, unknown>>;
  body_text: Record<string, unknown>;
  table: Record<string, unknown> & {
    header_row: Record<string, unknown>;
    first_column: Record<string, unknown>;
    body_cell: Record<string, unknown>;
  };
  image: Record<string, unknown>;
};

// 与桌面版相同：只要是非 null 的对象（包括数组）就按对象读取字段。
type Source = Record<string, any>;

export const DEFAULT_HEADING_BORDER_CELL_COLORS: readonly string[] = Object.freeze(['#eef5ff', '#f3f7ff', '#f8fbff', '#fbfdff', '#ffffff', '#ffffff']);

const defaultHeadings = [
  { font: '黑体', size: '小二', alignment: '居中对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '第{zh}章' },
  { font: '黑体', size: '四号', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '第{zh}节' },
  { font: '黑体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
  { font: '楷体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
  { font: '黑体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
  { font: '宋体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 0, spacing_after_pt: 0, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
];

const def = {
  template_name: '默认模版',
  page: {
    paper_size: 'a4',
    orientation: 'portrait',
    two_column: false,
    first_page_different: false,
    margin_top_cm: 2,
    margin_bottom_cm: 2,
    margin_left_cm: 2,
    margin_right_cm: 2,
    header_enabled: false,
    header_text: '',
    header_font: '宋体',
    header_size: '小五',
    header_alignment: '居中对齐',
    header_color: '#536176',
    header_footer_style: 'plain',
    header_badge_text: '',
    // null = 跟随所选样式的固有高度 / 默认文字位置
    header_chrome_height_cm: null,
    header_text_top_cm: null,
    header_text_left_cm: null,
    chrome_bar_color: '#e8eef5',
    chrome_accent_color: '#536176',
    footer_enabled: false,
    footer_text: '',
    footer_distance_cm: 0,
    footer_chrome_height_cm: null,
    footer_text_top_cm: null,
    footer_text_left_cm: null,
    footer_font: '宋体',
    footer_size: '小五',
    footer_alignment: '居中对齐',
    footer_color: '#536176',
    page_number_enabled: false,
    page_number_format: '第{page}页',
    page_number_start: 1,
    page_number_pad: 0,
  },
  heading_level1_page_break_before: false,
  heading_border: {
    enabled: false,
    include_headings: true,
    border_color: '#cfd8ee',
    heading_top_border_space_pt: 1,
    heading_bottom_border_space_pt: 1,
    heading_bottom_border_enabled: false,
    level_cell_colors: [...DEFAULT_HEADING_BORDER_CELL_COLORS],
    structure: '上下结构',
  },
  headings: defaultHeadings,
  body_text: {
    font: '宋体',
    size: '小四',
    alignment: '左对齐',
    spacing_before: 0,
    spacing_before_unit: 'lines',
    spacing_after: 0,
    spacing_after_unit: 'lines',
    first_line_indent_chars: 2,
    line_spacing_mode: 'multiple',
    line_spacing_value: 1.2,
    list_style: 'disc',
    ordered_list_style: 'decimal-dot',
    list_indent_chars: 2,
  },
  table: {
    border_width: 1,
    border_color: '#dcdff6',
    cell_padding_pt: 6,
    full_width: true,
    caption_font: '宋体',
    caption_size: '小四',
    caption_alignment: '居中对齐',
    caption_bold: true,
    caption_italic: false,
    header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#243048', background_color: '#eef5ff' },
    first_column: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
    body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
  },
  image: {
    max_width_percent: 90,
    alignment: '居中对齐',
    caption_font: '宋体',
    caption_size: '小五',
    caption_alignment: '居中对齐',
    caption_bold: false,
    caption_italic: false,
  },
};

const VALID_PAPER_SIZES = ['a4', 'a3', 'a5', 'b4', 'b5', 'letter', 'legal', '16k'];
const VALID_ORIENTATIONS = ['portrait', 'landscape'];
const VALID_NUMBERING_FORMATS = ['outline-decimal', 'custom'];
const VALID_HEADING_BORDER_STRUCTURES = ['上下结构', '左右结构'];
const VALID_HEADER_FOOTER_STYLES = ['plain', 'band', 'rules', 'top-bar', 'footer-badge', 'slant', 'letterhead', 'frame'];
const VALID_PAGE_NUMBER_PADS: unknown[] = [0, 2, 3];
const VALID_LIST_STYLES = ['none', 'disc', 'circle', 'square', 'diamond', 'dash', 'check', 'arrow', 'sparkle'];
const VALID_ORDERED_LIST_STYLES = ['decimal-dot', 'decimal-paren', 'decimal-full-paren', 'chinese-dot', 'chinese-paren', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman'];

function asSource(value: unknown): Source {
  return value && typeof value === 'object' ? value as Source : {};
}

/** 非空字符串取原值，否则取默认值。 */
function text(value: unknown, fallback: unknown) {
  return typeof value === 'string' && value ? value : fallback;
}

function number(value: unknown, fallback: unknown) {
  return typeof value === 'number' ? value : fallback;
}

function boolean(value: unknown, fallback: unknown) {
  return typeof value === 'boolean' ? value : fallback;
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' ? value : null;
}

/** 默认导出格式的深拷贝（桌面版 cloneDefaultExportFormat）。 */
export function defaultExportFormat(): ExportFormat {
  return {
    template_name: def.template_name,
    page: { ...def.page },
    heading_level1_page_break_before: def.heading_level1_page_break_before,
    heading_border: { ...def.heading_border, level_cell_colors: [...def.heading_border.level_cell_colors] },
    headings: def.headings.map((heading) => ({ ...heading })),
    body_text: { ...def.body_text },
    table: {
      border_width: def.table.border_width,
      border_color: def.table.border_color,
      cell_padding_pt: def.table.cell_padding_pt,
      full_width: def.table.full_width,
      caption_font: def.table.caption_font,
      caption_size: def.table.caption_size,
      caption_alignment: def.table.caption_alignment,
      caption_bold: def.table.caption_bold,
      caption_italic: def.table.caption_italic,
      header_row: { ...def.table.header_row },
      first_column: { ...def.table.first_column },
      body_cell: { ...def.table.body_cell },
    },
    image: { ...def.image },
  };
}

function normalizeTableCellStyle(source: unknown, fallback: Source) {
  const src = asSource(source);
  return {
    font: text(src.font, fallback.font),
    size: text(src.size, fallback.size),
    alignment: text(src.alignment, fallback.alignment),
    text_color: text(src.text_color, fallback.text_color),
    background_color: text(src.background_color, fallback.background_color),
  };
}

function normalizeImageStyle(source: unknown, fallback: Source) {
  const src = asSource(source);
  return {
    max_width_percent: number(src.max_width_percent, fallback.max_width_percent),
    alignment: text(src.alignment, fallback.alignment),
    caption_font: text(src.caption_font, fallback.caption_font),
    caption_size: text(src.caption_size, fallback.caption_size),
    caption_alignment: text(src.caption_alignment, fallback.caption_alignment),
    caption_bold: boolean(src.caption_bold, fallback.caption_bold),
    caption_italic: boolean(src.caption_italic, fallback.caption_italic),
  };
}

function headerFooterStyle(value: unknown) {
  let style = value;
  if (style === 'spine') style = 'letterhead';
  if (style === 'seal') style = 'frame';
  return typeof style === 'string' && VALID_HEADER_FOOTER_STYLES.includes(style) ? style : def.page.header_footer_style;
}

/** 补齐缺失与类型不符的字段，返回完整的导出格式（与桌面版 normalizeExportFormat 相同）。 */
export function normalizeExportFormat(input: unknown): ExportFormat {
  if (!input || typeof input !== 'object') return defaultExportFormat();
  const source = input as Source;

  const srcPage = asSource(source.page);
  const page = {
    paper_size: VALID_PAPER_SIZES.includes(srcPage.paper_size) ? srcPage.paper_size : def.page.paper_size,
    orientation: VALID_ORIENTATIONS.includes(srcPage.orientation) ? srcPage.orientation : def.page.orientation,
    two_column: boolean(srcPage.two_column, def.page.two_column),
    first_page_different: boolean(srcPage.first_page_different, def.page.first_page_different),
    margin_top_cm: number(srcPage.margin_top_cm, def.page.margin_top_cm),
    margin_bottom_cm: number(srcPage.margin_bottom_cm, def.page.margin_bottom_cm),
    margin_left_cm: number(srcPage.margin_left_cm, def.page.margin_left_cm),
    margin_right_cm: number(srcPage.margin_right_cm, def.page.margin_right_cm),
    header_enabled: boolean(srcPage.header_enabled, def.page.header_enabled),
    header_text: typeof srcPage.header_text === 'string' ? srcPage.header_text : def.page.header_text,
    header_font: text(srcPage.header_font, def.page.header_font),
    header_size: text(srcPage.header_size, def.page.header_size),
    header_alignment: text(srcPage.header_alignment, def.page.header_alignment),
    header_color: text(srcPage.header_color, def.page.header_color),
    header_footer_style: headerFooterStyle(srcPage.header_footer_style),
    header_badge_text: typeof srcPage.header_badge_text === 'string' ? srcPage.header_badge_text.slice(0, 4) : def.page.header_badge_text,
    header_chrome_height_cm: numberOrNull(srcPage.header_chrome_height_cm),
    header_text_top_cm: numberOrNull(srcPage.header_text_top_cm),
    header_text_left_cm: numberOrNull(srcPage.header_text_left_cm),
    chrome_bar_color: text(srcPage.chrome_bar_color, def.page.chrome_bar_color),
    chrome_accent_color: text(srcPage.chrome_accent_color, def.page.chrome_accent_color),
    footer_enabled: boolean(srcPage.footer_enabled, def.page.footer_enabled),
    footer_text: typeof srcPage.footer_text === 'string' ? srcPage.footer_text : def.page.footer_text,
    footer_distance_cm: number(srcPage.footer_distance_cm, def.page.footer_distance_cm),
    footer_chrome_height_cm: numberOrNull(srcPage.footer_chrome_height_cm),
    footer_text_top_cm: numberOrNull(srcPage.footer_text_top_cm),
    footer_text_left_cm: numberOrNull(srcPage.footer_text_left_cm),
    footer_font: text(srcPage.footer_font, def.page.footer_font),
    footer_size: text(srcPage.footer_size, def.page.footer_size),
    footer_alignment: text(srcPage.footer_alignment, def.page.footer_alignment),
    footer_color: text(srcPage.footer_color, def.page.footer_color),
    page_number_enabled: boolean(srcPage.page_number_enabled, def.page.page_number_enabled),
    page_number_format: text(srcPage.page_number_format, def.page.page_number_format),
    page_number_start: number(srcPage.page_number_start, def.page.page_number_start),
    page_number_pad: VALID_PAGE_NUMBER_PADS.includes(srcPage.page_number_pad) ? srcPage.page_number_pad : def.page.page_number_pad,
  };

  const srcHeadingBorder = asSource(source.heading_border);
  const srcHeadingCellColors: unknown[] = Array.isArray(srcHeadingBorder.level_cell_colors) ? srcHeadingBorder.level_cell_colors : [];
  const heading_border = {
    enabled: boolean(srcHeadingBorder.enabled, def.heading_border.enabled),
    include_headings: boolean(srcHeadingBorder.include_headings, def.heading_border.include_headings),
    border_color: text(srcHeadingBorder.border_color, def.heading_border.border_color),
    heading_top_border_space_pt: number(srcHeadingBorder.heading_top_border_space_pt, def.heading_border.heading_top_border_space_pt),
    heading_bottom_border_space_pt: number(srcHeadingBorder.heading_bottom_border_space_pt, def.heading_border.heading_bottom_border_space_pt),
    heading_bottom_border_enabled: boolean(srcHeadingBorder.heading_bottom_border_enabled, def.heading_border.heading_bottom_border_enabled),
    level_cell_colors: def.heading_border.level_cell_colors.map((color, index) => text(srcHeadingCellColors[index], color) as string),
    structure: typeof srcHeadingBorder.structure === 'string' && VALID_HEADING_BORDER_STRUCTURES.includes(srcHeadingBorder.structure)
      ? srcHeadingBorder.structure
      : def.heading_border.structure,
  };

  const srcHeadings: unknown[] = Array.isArray(source.headings) ? source.headings : [];
  const headings = def.headings.map((defH, index) => {
    const srcH = srcHeadings[index];
    if (!srcH || typeof srcH !== 'object') return { ...defH };
    const h = srcH as Source;
    return {
      font: text(h.font, defH.font),
      size: text(h.size, defH.size),
      alignment: text(h.alignment, defH.alignment),
      bold: boolean(h.bold, defH.bold),
      text_color: text(h.text_color, defH.text_color),
      spacing_before_pt: number(h.spacing_before_pt, defH.spacing_before_pt),
      spacing_after_pt: number(h.spacing_after_pt, defH.spacing_after_pt),
      first_line_indent_chars: number(h.first_line_indent_chars, defH.first_line_indent_chars),
      line_spacing: number(h.line_spacing, defH.line_spacing),
      numbering_format: typeof h.numbering_format === 'string' && VALID_NUMBERING_FORMATS.includes(h.numbering_format) ? h.numbering_format : defH.numbering_format,
      numbering_template: typeof h.numbering_template === 'string' ? h.numbering_template : defH.numbering_template,
    };
  });

  const srcBody = asSource(source.body_text);
  const body_text = {
    font: text(srcBody.font, def.body_text.font),
    size: text(srcBody.size, def.body_text.size),
    alignment: text(srcBody.alignment, def.body_text.alignment),
    // 以下四个字段桌面版只在缺失（null / undefined）时取默认值，其他取值原样保留。
    spacing_before: srcBody.spacing_before ?? def.body_text.spacing_before,
    spacing_before_unit: srcBody.spacing_before_unit ?? def.body_text.spacing_before_unit,
    spacing_after: srcBody.spacing_after ?? def.body_text.spacing_after,
    spacing_after_unit: srcBody.spacing_after_unit ?? def.body_text.spacing_after_unit,
    first_line_indent_chars: number(srcBody.first_line_indent_chars, def.body_text.first_line_indent_chars),
    line_spacing_mode: srcBody.line_spacing_mode ?? def.body_text.line_spacing_mode,
    line_spacing_value: srcBody.line_spacing_value ?? def.body_text.line_spacing_value,
    list_style: typeof srcBody.list_style === 'string' && VALID_LIST_STYLES.includes(srcBody.list_style) ? srcBody.list_style : def.body_text.list_style,
    ordered_list_style: typeof srcBody.ordered_list_style === 'string' && VALID_ORDERED_LIST_STYLES.includes(srcBody.ordered_list_style)
      ? srcBody.ordered_list_style
      : def.body_text.ordered_list_style,
    list_indent_chars: number(srcBody.list_indent_chars, def.body_text.list_indent_chars),
  };

  const srcTable = asSource(source.table);
  const table = {
    border_width: number(srcTable.border_width, def.table.border_width),
    border_color: text(srcTable.border_color, def.table.border_color),
    cell_padding_pt: number(srcTable.cell_padding_pt, def.table.cell_padding_pt),
    full_width: boolean(srcTable.full_width, def.table.full_width),
    caption_font: text(srcTable.caption_font, def.table.caption_font),
    caption_size: text(srcTable.caption_size, def.table.caption_size),
    caption_alignment: text(srcTable.caption_alignment, def.table.caption_alignment),
    caption_bold: boolean(srcTable.caption_bold, def.table.caption_bold),
    caption_italic: boolean(srcTable.caption_italic, def.table.caption_italic),
    header_row: normalizeTableCellStyle(srcTable.header_row, def.table.header_row),
    first_column: normalizeTableCellStyle(srcTable.first_column, def.table.first_column),
    body_cell: normalizeTableCellStyle(srcTable.body_cell, def.table.body_cell),
  };

  return {
    template_name: text(source.template_name, def.template_name) as string,
    page,
    heading_level1_page_break_before: boolean(source.heading_level1_page_break_before, def.heading_level1_page_break_before) as boolean,
    heading_border,
    headings,
    body_text,
    table,
    image: normalizeImageStyle(source.image, def.image),
  };
}
