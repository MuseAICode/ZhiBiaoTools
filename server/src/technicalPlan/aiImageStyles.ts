// AI 配图的画面形式（路线图第 8 步 8.10c1），与桌面版 client/electron/services/aiImageStyles.cjs 的 AI_IMAGE_STYLES 相同（测试核对）：
// 正文写作的配图要求据此列出可选形式，配图任务文件的 style 只能取其中的键；生图时追加的风格说明（hint）随 8.10d 的配图工具使用。
export interface AiImageStyle {
  readonly label: string;
  readonly usage: string;
  readonly hint: string;
}

export const AI_IMAGE_STYLES: Readonly<Record<string, AiImageStyle>> = Object.freeze({
  realistic_photo: { label: '写实摄影', usage: '现场、作业、环境', hint: '画面采用专业写实摄影风格，真实材质与自然光线，构图克制，适合投标技术方案插图。' },
  product_shot: { label: '设备特写摄影', usage: '实物、部件细节', hint: '画面采用设备产品特写摄影风格，主体突出、背景简洁纯净，材质与细节清晰。' },
  architectural_render: { label: '建筑/场地效果图', usage: '效果图、园区、空间全貌', hint: '画面采用建筑与场地可视化效果图风格，空间尺度清晰，光影自然，整体完成效果明确。' },
  '3d_render': { label: '三维模型渲染', usage: '设备、系统立体构成', hint: '画面采用干净的三维模型渲染风格，材质简洁，光照柔和，体块与部件关系清楚。' },
  isometric_illustration: { label: '轴测插画', usage: '场景布局、系统空间关系', hint: '画面采用等轴测视角的工程插画风格，结构清晰、配色统一克制，空间与分区关系一目了然。' },
  cutaway_illustration: { label: '剖视透视插画', usage: '剖视图、物理结构、原理', hint: '画面采用剖切透视的技术插画风格，剖开外壳或结构层展示内部构造，层次与连接关系清楚。' },
  exploded_view: { label: '爆炸分解图', usage: '组件构成、装配关系', hint: '画面采用爆炸分解图风格，各组成部件沿装配方向有序分离排布，装配关系清楚。' },
  line_drawing: { label: '技术线稿', usage: '工艺、结构、操作要点', hint: '画面采用简洁的单色技术线稿风格，线条规整、疏密有度，重点部位清晰。' },
  flat_illustration: { label: '扁平矢量插画', usage: '概念图、对比示意', hint: '画面采用扁平矢量插画风格，色块简洁、造型概括，主题关系清晰。' },
});
