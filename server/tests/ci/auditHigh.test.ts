// CI 审计门（server/scripts/ci-audit-high.mjs）的验证：带到期日的公告豁免只放行白名单中、未到期的 high/critical，
// 其他 high/critical 仍使 CI 失败，到期后恢复拦截。这满足「只忽略 GHSA-fc5q-39xc-vjpf 一个编号、其余仍失败、有验证」。
import { describe, expect, it } from 'vitest';
import { evaluateAudit, type AuditReport, type AllowEntry } from '../../scripts/ci-audit-high.mjs';

const PICO = 'GHSA-fc5q-39xc-vjpf';
const ALLOW: AllowEntry[] = [{ id: PICO, until: '2026-12-02', reason: 'test' }];
const BEFORE = new Date('2026-11-18T00:00:00Z');
const AFTER = new Date('2026-12-02T00:00:00Z');

/** 还原真实的 npm audit 形状：picomatch 带 high 根公告，fdir/tinyglobby/vite/vitest 以字符串下游引用它；另有若干 moderate/low。 */
function picomatchChainAudit(): AuditReport {
  return {
    vulnerabilities: {
      picomatch: { severity: 'high', via: [{ url: `https://github.com/advisories/${PICO}`, severity: 'high', title: 'picomatch ReDoS' }] },
      fdir: { severity: 'high', via: ['picomatch'] },
      tinyglobby: { severity: 'high', via: ['fdir', 'picomatch'] },
      vite: { severity: 'high', via: ['picomatch', 'tinyglobby'] },
      vitest: { severity: 'high', via: ['@vitest/mocker', 'picomatch', 'tinyglobby'] },
      'fast-uri': { severity: 'moderate', via: [{ url: 'https://github.com/advisories/GHSA-w74x-v6f9-j3xg', severity: 'moderate', title: 'fast-uri' }] },
      fastify: { severity: 'low', via: [{ url: 'https://github.com/advisories/GHSA-389g-gv7q-r4x8', severity: 'low', title: 'fastify' }] },
    },
  };
}

describe('ci-audit-high：带到期日的公告豁免', () => {
  it('到期前：只豁免 picomatch 链的那一个编号，CI 通过，moderate/low 不影响', () => {
    const result = evaluateAudit(picomatchChainAudit(), BEFORE, ALLOW);
    expect(result.ok).toBe(true);
    expect(result.active.map((a) => a.id)).toEqual([PICO]);
    expect(result.blocking).toEqual([]);
    // 四个下游高危包 + picomatch 都在 high 包清单中。
    expect(result.highPackages).toEqual(['fdir', 'picomatch', 'tinyglobby', 'vite', 'vitest']);
  });

  it('到期后：同一编号不再放行，CI 失败并列为 blocking/expired', () => {
    const result = evaluateAudit(picomatchChainAudit(), AFTER, ALLOW);
    expect(result.ok).toBe(false);
    expect(result.blocking.map((a) => a.id)).toContain(PICO);
    expect(result.expired.map((e) => e.id)).toEqual([PICO]);
    expect(result.active).toEqual([]);
  });

  it('出现另一个未豁免的 high/critical：即使 picomatch 被豁免，CI 仍失败', () => {
    const audit = picomatchChainAudit();
    audit.vulnerabilities!['some-lib'] = {
      severity: 'critical',
      via: [{ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'critical', title: '另一个严重漏洞' }],
    };
    const result = evaluateAudit(audit, BEFORE, ALLOW);
    expect(result.ok).toBe(false);
    expect(result.blocking.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    // picomatch 仍被豁免，不在 blocking 中。
    expect(result.blocking.map((a) => a.id)).not.toContain(PICO);
    expect(result.active.map((a) => a.id)).toEqual([PICO]);
  });

  it('没有 high/critical（只有 moderate/low）：CI 通过', () => {
    const audit: AuditReport = {
      vulnerabilities: {
        'fast-uri': { severity: 'moderate', via: [{ url: 'https://github.com/advisories/GHSA-w74x-v6f9-j3xg', severity: 'moderate', title: 'fast-uri' }] },
      },
    };
    const result = evaluateAudit(audit, BEFORE, ALLOW);
    expect(result.ok).toBe(true);
    expect(result.blocking).toEqual([]);
    expect(result.active).toEqual([]);
  });

  it('防御：有 high 包却解析不到公告编号时，按失败处理', () => {
    const audit = { vulnerabilities: { mystery: { severity: 'high', via: ['something'] } } };
    const result = evaluateAudit(audit, BEFORE, ALLOW);
    expect(result.ok).toBe(false);
    expect(result.blocking.map((a) => a.id)).toContain('UNKNOWN');
  });

  it('空白名单：picomatch 不再豁免，CI 失败（证明放行确实来自白名单）', () => {
    const result = evaluateAudit(picomatchChainAudit(), BEFORE, []);
    expect(result.ok).toBe(false);
    expect(result.blocking.map((a) => a.id)).toEqual([PICO]);
  });
});
