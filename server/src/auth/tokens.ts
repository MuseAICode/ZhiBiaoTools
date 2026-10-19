// 不透明令牌（会话、找回密码、邀请）：256 位随机数，base64url 编码交给用户；库中只存 SHA-256（32 字节）。
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
/** 32 字节的 base64url 编码固定为 43 个字符。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** 格式不对的输入（长度、字符集）直接判为无效，不去查库。 */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
