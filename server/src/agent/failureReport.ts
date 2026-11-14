// Agent 报告无法继续（路线图第 8 步 8.4b，迁移 0038_agent_failure_reports；docs/SERVER_DESIGN.md 第 7.15 节）。
//
// 桌面版的 report-failure 工具（piTaskFailureTool.cjs）由 Agent 给出面向用户的原因，运行时立即中止会话，任务以
// AGENT_REPORTED_FAILURE 失败、原因作为失败说明。Web 版中工具经 RPC 执行（src/agent/reportFailureTool.ts）：
//
// - 原因是**沙箱给出的不可信文本**（可能被提示注入）：服务端规范化为纯文本（去掉控制字符、双向文本与零宽字符，合并多余空行，
//   首尾去空白），至多 AGENT_FAILURE_REASON_MAX_LENGTH 个字符；只作为纯文本保存与显示（前端不得按 HTML / Markdown 渲染，
//   第 9 步），错误码 AGENT_REPORTED_FAILURE 表明这是 AI 生成的说明；
// - 每次执行只记第一次报告（数据库只允许为本组织 running 且 run_id 相符的 Agent 任务写入）；报告之后本次执行的模型调用与
//   工具调用一律 409（beginAgentTurn、beginAgentToolCall 检查），Agent 不能在报告失败后继续消耗费用；
// - 执行者在下一次续租时发现报告（工具写入后经任务控制频道立即触发一次续租），中止本次执行；结束时（finishRun）以及执行者失联后
//   对账收回时（recoverJob），只要本次执行有报告，任务即以 AGENT_REPORTED_FAILURE 失败（已请求取消的仍为取消），不再暂停或续跑。
//
// 由用户决定是否终止（桌面版的 requestTerminationDecision）是另一个工具 request-termination（8.4c2，src/agent/requestTerminationTool.ts，
// 复用 8.4c1 的问题与回答）：用户选择终止时同样写入这里的报告。一个任务类型只登记两者之一。
import { sql, type Transaction } from 'kysely';
import { AGENT_FAILURE_REASON_MAX_LENGTH } from '../db/migrations/0038_agent_failure_reports.ts';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';

export { AGENT_FAILURE_REASON_MAX_LENGTH } from '../db/migrations/0038_agent_failure_reports.ts';

/** 任务因 Agent 报告无法继续而失败的错误码（与桌面版相同）。 */
export const AGENT_REPORTED_FAILURE_CODE = 'AGENT_REPORTED_FAILURE';

/** 报告的原因规范化后为空时（不会写入，兜底用）的失败说明。 */
export const AGENT_REPORTED_FAILURE_FALLBACK_MESSAGE = 'Agent 无法继续当前任务';

// 换行与制表符以外的 C0 控制字符、DEL 与 C1 控制字符。
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// 双向文本控制（可让显示顺序与实际内容不同）、零宽字符、BOM、行与段分隔符。
const INVISIBLE_CHARS = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\u2028\u2029]/g;

/**
 * 把沙箱给出的文本规范化为纯文本：换行统一为 \n，制表符改为空格，去掉其他控制字符与不可见字符，去掉行尾空白，
 * 连续的空行至多保留一个，首尾去空白，超出 maxLength 个字符（按码点）的截断。singleLine 时换行改为空格、连续空白合并为一个。
 * 结果可能为空。不做 HTML 转义：保存的是纯文本，显示时由前端按文本输出。ask-user（8.4c1）的问题、选项与回答同样经它规范化。
 */
export function normalizeAgentPlainText(raw: string, maxLength: number, options: { singleLine?: boolean } = {}): string {
  let text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '');
  text = options.singleLine
    ? text.replace(/\s+/g, ' ').trim()
    : text
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
  const codePoints = Array.from(text);
  return codePoints.length <= maxLength ? text : codePoints.slice(0, maxLength).join('').trimEnd();
}

/** Agent 给出的失败原因规范化为纯文本（normalizeAgentPlainText），至多 AGENT_FAILURE_REASON_MAX_LENGTH 个字符。 */
export function normalizeAgentFailureReason(raw: string): string {
  return normalizeAgentPlainText(raw, AGENT_FAILURE_REASON_MAX_LENGTH);
}

export interface AgentFailureReportRef {
  /** 按令牌查出的身份（不来自请求）。 */
  tenant: TenantContext;
  jobId: string;
  runId: string;
}

/**
 * 记下本次执行的失败报告（在 withTenant 的事务中调用）。只记第一次：本次执行已有报告时不改，返回已记下的原因。
 * 任务不在本次执行中（不是 running、run_id 不符）或不是登记了上限的 Agent 任务时返回 null（不写入）。
 */
export async function recordAgentFailureReport(trx: Transaction<Database>, ref: AgentFailureReportRef, reason: string): Promise<string | null> {
  await sql`
    INSERT INTO agent_failure_reports (org_id, job_id, run_id, reason)
    SELECT ${ref.tenant.orgId}::uuid, ${ref.jobId}::uuid, ${ref.runId}::uuid, ${reason}
    WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = ${ref.tenant.orgId}::uuid AND j.id = ${ref.jobId}::uuid
                    AND j.status = 'running' AND j.run_id = ${ref.runId}::uuid)
      AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.org_id = ${ref.tenant.orgId}::uuid AND b.job_id = ${ref.jobId}::uuid)
    ON CONFLICT (job_id, run_id) DO NOTHING`.execute(trx);
  return findAgentFailureReport(trx, ref.jobId, ref.runId);
}

/** 本次执行的失败报告（原因）；没有时为 null。在设置了组织上下文的事务中调用（RLS 限定本组织）。 */
export async function findAgentFailureReport(trx: Transaction<Database>, jobId: string, runId: string): Promise<string | null> {
  const row = await trx.selectFrom('agent_failure_reports').select('reason').where('job_id', '=', jobId).where('run_id', '=', runId).executeTakeFirst();
  return row?.reason ?? null;
}

/** 供计数语句使用的条件：本次执行还没有失败报告（报告之后模型调用与工具调用一律拒绝）。 */
export function noAgentFailureReport(jobId: string, runId: string) {
  return sql<boolean>`NOT EXISTS (SELECT 1 FROM agent_failure_reports r WHERE r.job_id = ${jobId}::uuid AND r.run_id = ${runId}::uuid)`;
}
