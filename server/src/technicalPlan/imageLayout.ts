// 正文新增配图的布局份额与组数（路线图第 8 步 8.10c1），与桌面版 client/electron/shared/imageLayout/index.mjs 相同（页面展示与 Main 名额计算
// 共用的公式；tests/technicalPlan/contentWriting.test.ts 逐档核对）。份额均为整数百分比；顺序固定为单张图片、图片表格、三列图片、四宫格，
// 余数补位按此顺序。
import type { ContentGenerationOptions } from './store.ts';

export type ImageLayoutKey = 'single' | 'imageText' | 'threeImages' | 'fourImages';
export type ImageLayoutShares = Record<ImageLayoutKey, number>;

type LayoutOptionKey = 'useSingleImageLayout' | 'useImageTextLayout' | 'useThreeImagesLayout' | 'useFourImagesLayout';

export const IMAGE_LAYOUTS: readonly { readonly key: ImageLayoutKey; readonly optionKey: LayoutOptionKey }[] = Object.freeze([
  Object.freeze({ key: 'single', optionKey: 'useSingleImageLayout' }),
  Object.freeze({ key: 'imageText', optionKey: 'useImageTextLayout' }),
  Object.freeze({ key: 'threeImages', optionKey: 'useThreeImagesLayout' }),
  Object.freeze({ key: 'fourImages', optionKey: 'useFourImagesLayout' }),
] as const);

function toShares(values: readonly [number, number, number, number]): ImageLayoutShares {
  return { single: values[0], imageText: values[1], threeImages: values[2], fourImages: values[3] };
}

/** 配图比例档位的默认份额；份额为 0 的布局视为关闭，不可开启。 */
export function getDefaultImageLayoutShares(imageQuantity: number): ImageLayoutShares {
  const quantity = Number(imageQuantity) || 0;
  if (quantity <= 0) return toShares([0, 0, 0, 0]);
  if (quantity >= 60) return toShares([40, 30, 20, 10]);
  if (quantity >= 40) return toShares([50, 30, 20, 0]);
  if (quantity >= 20) return toShares([80, 20, 0, 0]);
  return toShares([100, 0, 0, 0]);
}

export type ImageLayoutOptions = Pick<ContentGenerationOptions, 'imageQuantity' | LayoutOptionKey>;

/** 被用户关闭布局的默认份额求和后整数均分给仍开启的布局；结果只取决于关闭了哪些布局。 */
export function resolveImageLayoutShares(options: ImageLayoutOptions): ImageLayoutShares {
  const defaults = getDefaultImageLayoutShares(options.imageQuantity);
  const enabled = IMAGE_LAYOUTS.filter(({ key, optionKey }) => defaults[key] > 0 && options[optionKey] !== false);
  const removed = IMAGE_LAYOUTS.reduce((sum, layout) => sum + (enabled.includes(layout) ? 0 : defaults[layout.key]), 0);
  const shares = toShares([0, 0, 0, 0]);
  if (!enabled.length) return shares;
  const base = Math.floor(removed / enabled.length);
  const remainder = removed % enabled.length;
  enabled.forEach(({ key }, index) => {
    shares[key] = defaults[key] + base + (index < remainder ? 1 : 0);
  });
  return shares;
}

/** 按份额分配组数：先向下取整，剩余组按余数降序补齐，同余数按布局顺序；整数余数避免浮点误差。 */
export function allocateImageLayoutGroups(total: number, shares: ImageLayoutShares): ImageLayoutShares {
  const hasShare = IMAGE_LAYOUTS.some(({ key }) => (shares[key] || 0) > 0);
  const count = hasShare ? Math.max(0, Math.floor(Number(total) || 0)) : 0;
  const groups = IMAGE_LAYOUTS.map(({ key }) => Math.floor((count * (shares[key] || 0)) / 100));
  const remaining = count - groups.reduce((sum, value) => sum + value, 0);
  const order = IMAGE_LAYOUTS.map(({ key }, index) => ({ index, remainder: (count * (shares[key] || 0)) % 100 })).sort(
    (left, right) => right.remainder - left.remainder || left.index - right.index,
  );
  for (const { index } of order.slice(0, remaining)) groups[index]! += 1;
  return toShares(groups as [number, number, number, number]);
}
