// 导出模板可选的字体名（路线图第 7 步 7.2；决定事项第 3 项）。取代桌面版的 systemFonts.list（枚举本机字体）。
//
// 这是固定清单，不是服务器上实际安装的字体：导出的 docx 保留模板选择的原字体名，由用户的 Word 用本机字体显示；
// 服务端（export 沙箱）只装 Noto CJK，按 server/sandbox/export/fonts/65-zhibiao-cjk.conf 把这些名字映射到衬线 / 无衬线体，
// 只影响排版测量和装饰 PNG 中的文字。
//
// 与前端 client/src/shared/types/exportFormat.ts 的 FONT_OPTIONS 逐项相同、顺序相同（tests/templates/fonts.test.ts 核对）；
// 前端字体选择器把它与 FONT_OPTIONS、模板中已用的字体名合并去重，所以这里不需要、也不应该加入别的名字。
export const TEMPLATE_FONT_NAMES: readonly string[] = Object.freeze([
  '宋体',
  '新宋体',
  '黑体',
  '楷体',
  '仿宋',
  '微软雅黑',
  '微软雅黑 Light',
  '等线',
  '等线 Light',
  '隶书',
  '幼圆',
  '华文宋体',
  '华文黑体',
  '华文楷体',
  '华文仿宋',
  '华文中宋',
  '华文细黑',
  '苹方',
  'PingFang SC',
  '宋体-简',
  '黑体-简',
  '楷体-简',
  '冬青黑体简体中文',
  'Hiragino Sans GB',
  '思源宋体',
  '思源黑体',
  'Source Han Serif SC',
  'Source Han Sans SC',
]);
