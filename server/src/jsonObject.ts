// 存进 jsonb 列的 JSON 对象（组织设置的导出偏好、界面偏好，导出模板的配置）的通用检查：嵌套深度和序列化后的大小。
// 内容的归一化由前端完成（与桌面版相同），服务端不解释字段；数据库的 CHECK 约束是最后一道检查。

/** JSON 对象的最大嵌套深度；超过时不再往下遍历，也不交给 JSON.stringify，避免深层嵌套耗尽调用栈。 */
export const JSON_OBJECT_MAX_DEPTH = 32;

function depthWithin(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (depth > JSON_OBJECT_MAX_DEPTH) return false;
  return Object.values(value).every((child) => depthWithin(child, depth + 1));
}

/** 序列化 JSON 对象；嵌套过深返回 'too-deep'，超过 maxBytes 返回 'too-large'。 */
export function serializeJsonObject(value: Record<string, unknown>, maxBytes: number): string | 'too-deep' | 'too-large' {
  if (!depthWithin(value, 1)) return 'too-deep';
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, 'utf8') > maxBytes ? 'too-large' : json;
}
