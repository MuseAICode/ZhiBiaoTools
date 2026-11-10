// Agent 任务令牌的格式（路线图第 8 步 8.2a）：不依赖数据库，agent-gw（8.2b）只用这里的格式检查，不持有数据库连接。
//
// 令牌是 256 位随机数，base64url 编码后加前缀 agt_（共 47 个字符），只经模板注入沙箱内 Pi 进程的环境；库中只存 SHA-256。
// 日志中只记哈希的前 12 个十六进制字符（agentTokenLogId），不记令牌原文。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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

/**
 * 从 Authorization 头取令牌：只接受恰好一个 `Bearer <令牌>`（大小写、空白、多个值都不接受），且令牌格式正确；否则 null。
 * agent-gw 与 worker 的内部入口共用（8.2b）。
 */
export function parseAgentBearer(header: unknown): string | null {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  return isWellFormedAgentToken(token) ? token : null;
}

export function hashAgentToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** 日志中标识一个令牌：哈希的前 12 个十六进制字符（48 位），不能反推出令牌。 */
export function agentTokenLogId(hash: Buffer): string {
  return hash.subarray(0, 6).toString('hex');
}

/**
 * agent-gw 转给 worker 的 Agent 内部入口时带的专用共享密钥（8.2b，#73 确认）：只用于 agent-gw → worker 这一跳，不是平台的敏感凭据。
 * 网络配置出错、沙箱能直接连到 worker 时，没有它的请求即使带着有效的任务令牌也被拒绝，沙箱绕不过 agent-gw 的过滤。
 * agent-gw 只转发自己设置的这个头部，沙箱发来的同名头部被丢弃。
 */
export const AGENT_RELAY_KEY_HEADER = 'x-agent-relay-key';
export const AGENT_RELAY_KEY_MIN_LENGTH = 32;

/** 常量时间比较：比较两边的 SHA-256 摘要，长度固定，不因长度或前缀不同而提前返回。 */
export function createRelayKeyVerifier(expected: string): (value: unknown) => boolean {
  if (expected.length < AGENT_RELAY_KEY_MIN_LENGTH) throw new TypeError(`Agent 中继密钥至少 ${AGENT_RELAY_KEY_MIN_LENGTH} 个字符`);
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return (value) => typeof value === 'string' && value.length > 0 && timingSafeEqual(createHash('sha256').update(value, 'utf8').digest(), expectedDigest);
}
