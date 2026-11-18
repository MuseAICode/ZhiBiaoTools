// CI 的 server 根依赖审计门（替代裸 `npm audit --audit-level=high`）：按公告编号给出**带到期日的临时豁免**，
// 只放行白名单中、且未到期的 high / critical 公告，其余 high / critical 一律使 CI 失败。到期后白名单项自动失效、
// 恢复拦截该编号。为什么需要豁免、范围与到期日见仓库根目录 CLAUDE.md 的「已接受风险（CI 审计豁免）」。
//
// 纯逻辑在 evaluateAudit（供 tests/ci/auditHigh.test.ts 验证），命令行部分跑 `npm audit --json` 后据此决定退出码。
import { execFileSync } from 'node:child_process';

/** 需要拦截的严重级别（与 --audit-level=high 一致）。 */
const SEVERE = new Set(['high', 'critical']);

/**
 * 带到期日的公告豁免白名单。每项：
 * - id：GitHub 公告编号（GHSA-...），与 npm audit 的 advisory url 末段一致；
 * - until：到期日（UTC 当天 00:00 起失效，之后该编号重新拦截）；
 * - reason：为什么可暂时接受（范围、是否进入生产）。
 * 到期后请删除该项或在修复后一并移除。
 */
export const AUDIT_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: 'GHSA-fc5q-39xc-vjpf',
    until: '2026-12-02',
    reason: 'picomatch ReDoS，仅经 vitest/vite 的开发依赖链间接引入（server 生产依赖树与运行时镜像不含，npm ls picomatch --omit=dev 为空）；尚无 >4.0.7 的修复版本。',
  }),
]);

/** 从 advisory 的 url 取出公告编号（末段）。 */
function advisoryId(url) {
  return typeof url === 'string' ? url.split('/').filter(Boolean).pop() : null;
}

/**
 * 判定一次 `npm audit --json` 的结果。
 * @param {any} audit  解析后的 npm audit JSON（含 vulnerabilities）。
 * @param {Date} now   当前时间（判断豁免是否到期）。
 * @param {ReadonlyArray<{id:string,until:string,reason?:string}>} allowlist
 * @returns {{ ok: boolean, active: Array, expired: Array, blocking: Array, highPackages: string[] }}
 *   - active：本次放行的豁免编号（命中且未到期）；
 *   - expired：已到期、因而不再放行的白名单项（若其编号本次出现则进入 blocking）；
 *   - blocking：使 CI 失败的 high/critical 公告（编号、严重级别、标题）；
 *   - highPackages：本次 high/critical 的包名（用于日志）。
 */
export function evaluateAudit(audit, now, allowlist = AUDIT_ALLOWLIST) {
  const vulns = (audit && audit.vulnerabilities) || {};
  const activeAllow = new Map();
  const expired = [];
  for (const entry of allowlist) {
    const expiry = new Date(`${entry.until}T00:00:00Z`);
    if (now < expiry) activeAllow.set(entry.id, entry);
    else expired.push(entry);
  }

  // 收集所有 high/critical 的根公告对象（每个有漏洞的包上都带它自己的 advisory 对象；下游包以字符串引用它）。
  const severeAdvisories = new Map(); // id -> { id, severity, title }
  const highPackages = new Set();
  for (const [pkg, info] of Object.entries(vulns)) {
    if (SEVERE.has(info.severity)) highPackages.add(pkg);
    for (const via of info.via || []) {
      if (via && typeof via === 'object' && SEVERE.has(via.severity)) {
        const id = advisoryId(via.url);
        if (id && !severeAdvisories.has(id)) severeAdvisories.set(id, { id, severity: via.severity, title: (via.title || '').slice(0, 120) });
      }
    }
  }

  const active = [];
  const blocking = [];
  for (const adv of severeAdvisories.values()) {
    if (activeAllow.has(adv.id)) active.push({ ...adv, until: activeAllow.get(adv.id).until });
    else blocking.push(adv);
  }

  // 防御：出现了 high/critical 的包，却没有解析到任何根公告对象（无法逐项核对）——按失败处理。
  if (highPackages.size > 0 && severeAdvisories.size === 0) {
    blocking.push({ id: 'UNKNOWN', severity: 'high', title: '检测到 high/critical 漏洞，但无法解析其公告编号' });
  }

  return { ok: blocking.length === 0, active, expired, blocking, highPackages: [...highPackages].sort() };
}

/** 跑 `npm audit --json`（在当前工作目录）。npm 在有漏洞时以非零退出，但照样输出 JSON，这里从 stdout 取回。 */
function runNpmAudit() {
  try {
    return execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error && typeof error.stdout === 'string' && error.stdout.length > 0) return error.stdout;
    throw error;
  }
}

function main() {
  let parsed;
  try {
    parsed = JSON.parse(runNpmAudit());
  } catch (error) {
    console.error('npm audit 执行或解析失败：', error && error.message ? error.message : error);
    process.exit(2);
  }
  const result = evaluateAudit(parsed, new Date());
  console.log(`[ci-audit-high] high/critical 包：${result.highPackages.length ? result.highPackages.join(', ') : '无'}`);
  for (const adv of result.active) {
    console.log(`[ci-audit-high] 已临时豁免（到期 ${adv.until}）：${adv.id} [${adv.severity}] ${adv.title}`);
  }
  for (const entry of result.expired) {
    console.log(`[ci-audit-high] 豁免已到期、恢复拦截：${entry.id}（到期日 ${entry.until}）`);
  }
  if (!result.ok) {
    console.error('[ci-audit-high] 存在未豁免的 high/critical 漏洞，CI 失败：');
    for (const adv of result.blocking) console.error(`  - ${adv.id} [${adv.severity}] ${adv.title}`);
    console.error('修复依赖或（仅当确属可接受的开发期风险、且有到期日）在 server/scripts/ci-audit-high.mjs 的 AUDIT_ALLOWLIST 登记。');
    process.exit(1);
  }
  console.log('[ci-audit-high] 没有未豁免的 high/critical 漏洞。');
}

// 仅作为脚本直接运行时执行（被测试 import 时不跑）。
if (import.meta.url === `file://${process.argv[1]}`) main();
