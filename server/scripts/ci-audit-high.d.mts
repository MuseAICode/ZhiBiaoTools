// 类型声明：ci-audit-high.mjs 的纯逻辑 evaluateAudit（供 tests/ci/auditHigh.test.ts 在 nodenext 下类型检查）。
export interface AuditVia {
  url?: string;
  severity?: string;
  title?: string;
}
export interface AuditVuln {
  severity: string;
  via: Array<string | AuditVia>;
}
export interface AuditReport {
  vulnerabilities?: Record<string, AuditVuln>;
}
export interface AllowEntry {
  id: string;
  until: string;
  reason?: string;
}
export interface SevereAdvisory {
  id: string;
  severity: string;
  title: string;
  until?: string;
}
export interface AuditResult {
  ok: boolean;
  active: SevereAdvisory[];
  expired: AllowEntry[];
  blocking: SevereAdvisory[];
  highPackages: string[];
}
export const AUDIT_ALLOWLIST: ReadonlyArray<AllowEntry>;
export function evaluateAudit(audit: AuditReport, now: Date, allowlist?: ReadonlyArray<AllowEntry>): AuditResult;
