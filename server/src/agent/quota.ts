// 每组织的 Agent 任务并发与每日运行时长（路线图第 8 步 8.3d，迁移 0036_agent_job_runs；docs/SERVER_DESIGN.md 第 5.3 节）。
//
// - 并发：同一组织同时运行（running / cancelling）的 Agent 任务至多 AGENT_ORG_RUNNING_LIMIT 个，认领时检查（claimJob），
//   超出的留在 queued，按入队时间排队（先入队的 Agent 任务没有开始之前，后入队的不认领）；
// - 每日运行时长：同一组织当日（AGENT_RUNTIME_TIME_ZONE 的自然日）所有 Agent 任务执行时长之和至多 AGENT_DAILY_RUNTIME_SECONDS。
//   入队、继续（含确认继续）时已用完的拒绝（429 AGENT_DAILY_RUNTIME_EXHAUSTED）；认领时已用完的暂停；执行中每次续租时
//   检查，用完即中止并暂停为 agent_daily_runtime，次日可继续（从 checkpoint 续跑）。
// Agent 任务 = 登记了费用与轮数上限（agent_job_budgets 有行）的任务：agent 队列的任务类型必须登记上限（src/jobs/definitions.ts）。
import { sql, type Transaction } from 'kysely';
import { AGENT_DAILY_RUNTIME_PAUSE_REASON } from '../db/migrations/0036_agent_job_runs.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';

export { AGENT_DAILY_RUNTIME_PAUSE_REASON };

/** 每组织同时运行的 Agent 任务数（设计第 5.3 节）。 */
export const AGENT_ORG_RUNNING_LIMIT = 1;
/** 每组织每日 Agent 运行时长（设计第 9 节第 15 项：8 小时）。 */
export const AGENT_DAILY_RUNTIME_SECONDS = 8 * 3600;
/** “每日”按北京时间的自然日（面向中国大陆用户，设计第 8.0 节）。 */
export const AGENT_RUNTIME_TIME_ZONE = 'Asia/Shanghai';

export const AGENT_DAILY_RUNTIME_EXHAUSTED_CODE = 'AGENT_DAILY_RUNTIME_EXHAUSTED';

export interface AgentQuotaOptions {
  /** 同时运行的 Agent 任务数上限，默认 AGENT_ORG_RUNNING_LIMIT。 */
  orgAgentRunningLimit?: number;
  /** 每日运行时长上限（秒），默认 AGENT_DAILY_RUNTIME_SECONDS。 */
  agentDailyRuntimeSeconds?: number;
  /** 等待用户回答多久后暂停（秒，ask-user，8.4c1），默认 AGENT_QUESTION_TIMEOUT_SECONDS（测试用）。 */
  agentQuestionTimeoutSeconds?: number;
}

type Trx = Transaction<Database>;

const ZONE = sql.lit(AGENT_RUNTIME_TIME_ZONE);

/**
 * 在已设置组织上下文的事务中算出当日已用的 Agent 运行时长（秒）。每次执行按 [started_at, last_seen_at] 计，与当日的交集求和：
 * 跨天的执行只计当日的部分；执行中的按最后一次续租计（续租时先推进 last_seen_at 再检查）。
 */
export async function agentRuntimeUsedToday(trx: Trx, orgId: string): Promise<number> {
  const { rows } = await sql<{ seconds: string | number | null }>`
    WITH day AS (
      SELECT (date_trunc('day', now() AT TIME ZONE ${ZONE}) AT TIME ZONE ${ZONE}) AS day_start
    )
    SELECT coalesce(sum(extract(epoch FROM
             least(r.last_seen_at, day.day_start + interval '1 day') - greatest(r.started_at, day.day_start))), 0) AS seconds
    FROM agent_job_runs r, day
    WHERE r.org_id = ${orgId} AND r.last_seen_at > day.day_start AND r.started_at < day.day_start + interval '1 day'`.execute(trx);
  return Number(rows[0]?.seconds ?? 0);
}

export function dailyRuntimeLimitOf(options: AgentQuotaOptions | undefined): number {
  return options?.agentDailyRuntimeSeconds ?? AGENT_DAILY_RUNTIME_SECONDS;
}

export function agentRunningLimitOf(options: AgentQuotaOptions | undefined): number {
  return options?.orgAgentRunningLimit ?? AGENT_ORG_RUNNING_LIMIT;
}

export async function isAgentDailyRuntimeExhausted(trx: Trx, orgId: string, options?: AgentQuotaOptions): Promise<boolean> {
  return (await agentRuntimeUsedToday(trx, orgId)) >= dailyRuntimeLimitOf(options);
}

function hours(seconds: number): string {
  const value = seconds / 3600;
  return Number.isInteger(value) ? `${value} 小时` : `${Math.round(value * 100) / 100} 小时`;
}

export function dailyRuntimeExhaustedMessage(options?: AgentQuotaOptions): string {
  return `本组织今日的 Agent 运行时长（${hours(dailyRuntimeLimitOf(options))}）已用完，请明日再试`;
}

/** 入队、继续前检查当日运行时长，已用完时 429 AGENT_DAILY_RUNTIME_EXHAUSTED。 */
export async function assertAgentDailyRuntimeAvailable(trx: Trx, orgId: string, options?: AgentQuotaOptions): Promise<void> {
  if (await isAgentDailyRuntimeExhausted(trx, orgId, options)) {
    throw new AppError(429, AGENT_DAILY_RUNTIME_EXHAUSTED_CODE, dailyRuntimeExhaustedMessage(options));
  }
}

/** 任务是否是 Agent 任务（登记了上限）。 */
export async function isAgentJob(trx: Trx, jobId: string): Promise<boolean> {
  const row = await trx.selectFrom('agent_job_budgets').select('job_id').where('job_id', '=', jobId).executeTakeFirst();
  return row !== undefined;
}

/**
 * 认领一个 Agent 任务前的并发检查（在 claimJob 的组织咨询锁内调用）。按入队时间排队：同一组织正在运行（running / cancelling）的
 * Agent 任务数，加上比本任务更早入队、仍在排队的 Agent 任务数，达到上限时返回 true，本次认领延后（先入队的先开始）。
 */
export async function shouldDeferAgentClaim(
  trx: Trx,
  job: { id: string; orgId: string },
  options?: AgentQuotaOptions,
): Promise<boolean> {
  const limit = agentRunningLimitOf(options);
  // 入队时间在数据库中比较（JS Date 只到毫秒）。
  const { rows } = await sql<{ ahead: string }>`
    SELECT count(*) AS ahead FROM (
      SELECT 1 FROM jobs j, jobs self
      WHERE self.id = ${job.id} AND j.org_id = ${job.orgId} AND j.id <> self.id
        AND (j.status IN ('running', 'cancelling') OR (j.status = 'queued' AND (j.created_at, j.id) < (self.created_at, self.id)))
        AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.job_id = j.id)
      LIMIT ${limit}
    ) ahead`.execute(trx);
  return Number(rows[0]?.ahead ?? 0) >= limit;
}

/** 认领成功后在同一事务中记下本次执行的开始（只对 Agent 任务，RLS 另外检查）。 */
export async function startAgentJobRun(trx: Trx, run: { orgId: string; jobId: string; runId: string }): Promise<void> {
  await trx.insertInto('agent_job_runs').values({ org_id: run.orgId, job_id: run.jobId, run_id: run.runId }).execute();
}

/** 续租时推进本次执行的 last_seen_at；返回是否是 Agent 任务的执行（不是时什么都不改）。 */
export async function touchAgentJobRun(trx: Trx, runId: string): Promise<boolean> {
  const rows = await trx
    .updateTable('agent_job_runs')
    .set({ last_seen_at: sql<Date>`now()` })
    .where('run_id', '=', runId)
    .where('ended_at', 'is', null)
    .returning('run_id')
    .execute();
  return rows.length > 0;
}

/** 执行结束（正常结束、中止、暂停）：本次执行计到 now()。 */
export async function endAgentJobRun(trx: Trx, runId: string): Promise<void> {
  await trx
    .updateTable('agent_job_runs')
    .set({ last_seen_at: sql<Date>`now()`, ended_at: sql<Date>`now()` })
    .where('run_id', '=', runId)
    .where('ended_at', 'is', null)
    .execute();
}

/** 执行者失联（租约过期）后由对账收尾：只计到最后一次续租，失联的那段不计入。 */
export async function closeLostAgentJobRun(trx: Trx, runId: string): Promise<void> {
  await trx
    .updateTable('agent_job_runs')
    .set({ ended_at: sql<Date>`last_seen_at` })
    .where('run_id', '=', runId)
    .where('ended_at', 'is', null)
    .execute();
}
