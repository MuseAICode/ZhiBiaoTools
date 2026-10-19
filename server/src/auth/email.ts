// 邮箱归一化：去首尾空白、整体转小写（docs/SERVER_DESIGN.md 第 2.5 节，users.email 的 CHECK 约束要求小写）。
// 只做基本格式检查，真实性由邀请链接或重置链接送达证明。
const EMAIL_PATTERN = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u;
export const EMAIL_MAX_LENGTH = 254;

/** 格式不合法时返回 null。 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > EMAIL_MAX_LENGTH) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}
