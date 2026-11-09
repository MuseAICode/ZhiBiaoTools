// Agent 任务令牌的格式（路线图第 8 步 8.2a）：不依赖数据库，agent-gw（8.2b）只用这里的格式检查，不持有数据库连接。
//
// 令牌是 256 位随机数，base64url 编码后加前缀 agt_（共 47 个字符），只经模板注入沙箱内 Pi 进程的环境；库中只存 SHA-256。
// 日志中只记哈希的前 12 个十六进制字符（agentTokenLogId），不记令牌原文。
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
export const AGENT_TOKEN_PREFIX = 'agt_';
/** 前缀 + 32 字节的 base64url 编码（固定 43 个字符）。 */
const AGENT_TOKEN_PATTERN = /^agt_[A-Za-z0-9_-]{43}$/;
export const AGENT_TOKEN_LENGTH = AGENT_TOKEN_PREFIX.length + 43;

export function generateAgentToken(): string {
  return AGENT_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

/** 格式不对的输入（类型、前缀、长度、字符集）直接判为无效，不去查库。 */
export function isWellFormedAgentToken(value: unknown): value is string {
  return typeof value === 'string' && value.length === AGENT_TOKEN_LENGTH && AGENT_TOKEN_PATTERN.test(value);
}

export function hashAgentToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** 日志中标识一个令牌：哈希的前 12 个十六进制字符（48 位），不能反推出令牌。 */
export function agentTokenLogId(hash: Buffer): string {
  return hash.subarray(0, 6).toString('hex');
}
