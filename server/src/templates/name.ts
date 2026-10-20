// 导出模板名称的归一化。名称取自 config.template_name（与桌面版相同），存库前写回 config，二者由 CHECK 约束保持一致。
import { EXPORT_TEMPLATE_NAME_MAX_LENGTH } from '../db/migrations/0010_export_templates.ts';
import { AppError } from '../errors.ts';

export { EXPORT_TEMPLATE_NAME_MAX_LENGTH };

/** 名称为空时的默认值（与桌面版相同）。 */
export const UNTITLED_TEMPLATE_NAME = '未命名模板';
const COPY_SUFFIX = ' 副本';

// 控制字符、零宽和双向文本控制字符（Unicode Cc / Cf）不进名称，避免显示时伪装成别的名称（与项目名称相同）。
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function clean(raw: unknown): string {
  return typeof raw === 'string' ? raw.normalize('NFC').replace(INVISIBLE_CHARACTERS, '').trim() : '';
}

/** NFC 归一化、去掉不可见字符和首尾空白；为空时用“未命名模板”，超过 200 字时拒绝。 */
export function normalizeTemplateName(raw: unknown): string {
  const name = clean(raw) || UNTITLED_TEMPLATE_NAME;
  if ([...name].length > EXPORT_TEMPLATE_NAME_MAX_LENGTH) {
    throw new AppError(400, 'TEMPLATE_INVALID', `模板名称不超过 ${EXPORT_TEMPLATE_NAME_MAX_LENGTH} 个字`);
  }
  return name;
}

/** 复制出的模板名称：原名称加“ 副本”，超长时截短原名称。 */
export function copyTemplateName(source: string): string {
  const base = [...source].slice(0, EXPORT_TEMPLATE_NAME_MAX_LENGTH - [...COPY_SUFFIX].length).join('').trimEnd();
  return `${base}${COPY_SUFFIX}`;
}
