// Agent 任务令牌的格式（src/agent/token.ts，路线图第 8 步 8.2a）；与模板的最长存活时间核对令牌的最长有效期。
import { describe, expect, it } from 'vitest';
import { agentTokenLogId, AGENT_TOKEN_LENGTH, generateAgentToken, hashAgentToken, isWellFormedAgentToken } from '../../src/agent/token.ts';
import { AGENT_TOKEN_MAX_TTL_MS } from '../../src/agent/tokenStore.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';

describe('Agent 任务令牌的格式', () => {
  it('生成的令牌是 agt_ 加 43 个 base64url 字符，每次不同', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateAgentToken()));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(token).toMatch(/^agt_[A-Za-z0-9_-]{43}$/);
      expect(token).toHaveLength(AGENT_TOKEN_LENGTH);
      expect(isWellFormedAgentToken(token)).toBe(true);
    }
  });

  it('格式不对的输入一律无效', () => {
    const valid = generateAgentToken();
    for (const value of [
      undefined,
      null,
      42,
      {},
      [valid],
      '',
      valid.slice(4),
      `AGT_${valid.slice(4)}`,
      `xyz_${valid.slice(4)}`,
      valid.slice(0, -1),
      `${valid}A`,
      `${valid.slice(0, -1)}=`,
      `${valid.slice(0, -1)}+`,
      `${valid.slice(0, -1)}/`,
      ` ${valid}`,
      `${valid}\n`,
      `Bearer ${valid}`,
      `${valid.slice(0, -1)}а`,
    ]) {
      expect(isWellFormedAgentToken(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('只存 SHA-256；日志标识是哈希的前 12 个十六进制字符，不含令牌原文', () => {
    const token = generateAgentToken();
    const hash = hashAgentToken(token);
    expect(hash).toHaveLength(32);
    expect(hashAgentToken(token).equals(hash)).toBe(true);
    const logId = agentTokenLogId(hash);
    expect(logId).toMatch(/^[0-9a-f]{12}$/);
    expect(logId).toBe(hash.toString('hex').slice(0, 12));
    expect(token).not.toContain(logId);
  });

  it('令牌最长有效期等于 agent 模板中最长的沙箱存活时间', () => {
    const agentLifetimes = Object.values(SANDBOX_TEMPLATES)
      .filter((template) => template.network === 'agent')
      .map((template) => template.lifetimeMs);
    expect(agentLifetimes.length).toBeGreaterThan(0);
    expect(AGENT_TOKEN_MAX_TTL_MS).toBe(Math.max(...agentLifetimes));
  });
});
