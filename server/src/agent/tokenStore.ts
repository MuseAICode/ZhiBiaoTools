// Agent 任务令牌的签发、作废与按令牌查身份（迁移 0031_agent_job_tokens，路线图第 8 步 8.2a）。
//
// - 签发：worker 为正在执行的 agent 任务创建沙箱前调用，按组织上下文（withOrgContext）写入，RLS 只允许为本组织中 running、
//   run_id 相符、未请求暂停的任务签发；同一任务之前未作废的令牌在同一事务中先作废（每个任务最多一个有效令牌）；
// - 作废：沙箱销毁、执行结束时调用；任务结束、暂停、取消、换执行者、发起人被移出组织后，令牌在查询时即已无效，作废只是收尾；
// - 查身份：agent-gw 转来的请求只带令牌，worker 按令牌哈希经 agent_token_lookup 查出组织、任务、项目、用户与任务类型，
//   这是令牌所代表身份的唯一来源，请求中出现的这些字段一律不采信（8.2b 起）。
import { sql, type Kysely } from 'kysely';
import { AGENT_TOKEN_MAX_TTL_MINUTES } from '../db/migrations/0031_agent_job_tokens.ts';
import { MEMBER_ROLES, type Database, type MemberRole } from '../db/schema.ts';
import { withOrgContext, type TenantContext } from '../db/tenant.ts';
import type { RunRef } from '../jobs/store.ts';
import { agentTokenLogId, generateAgentToken, hashAgentToken, isWellFormedAgentToken } from './token.ts';

export const AGENT_TOKEN_MAX_TTL_MS = AGENT_TOKEN_MAX_TTL_MINUTES * 60_000;
const AGENT_TOKEN_MIN_TTL_MS = 1000;

export interface IssuedAgentToken {
  /** 令牌原文：只交给沙箱模板注入 Pi 进程的环境，不写日志、不入库。 */
  token: string;
  /** 日志中用的标识（哈希前缀）。 */
  logId: string;
  expiresAt: Date;
}

/** 令牌代表的身份，全部由服务端按令牌查出。 */
export interface AgentTokenIdentity {
  orgId: string;
  jobId: string;
  runId: string;
  projectId: string | null;
  userId: string;
  jobType: string;
  /** 发起用户当前在组织中的角色。 */
  role: MemberRole;
  /** 令牌与任务租约中较早的到期时间。 */
  expiresAt: Date;
  logId: string;
}

/**
 * 为一次执行签发令牌。ttlMs 取该任务类型的墙钟上限（最长 135 分钟，数据库 CHECK 兜底），实际有效期还受租约限制（查询时现算）。
 * 执行已不属于本执行者（被收回、已结束）、任务已请求暂停时返回 null，不签发。
 */
export async function issueAgentJobToken(db: Kysely<Database>, run: RunRef, ttlMs: number): Promise<IssuedAgentToken | null> {
  if (!Number.isInteger(ttlMs) || ttlMs < AGENT_TOKEN_MIN_TTL_MS || ttlMs > AGENT_TOKEN_MAX_TTL_MS) {
    throw new TypeError(`令牌有效期必须是 ${AGENT_TOKEN_MIN_TTL_MS}～${AGENT_TOKEN_MAX_TTL_MS} 毫秒的整数`);
  }
  const token = generateAgentToken();
  const hash = hashAgentToken(token);
  return withOrgContext(db, run.orgId, async (trx) => {
    // 锁住任务行：与暂停、取消、结束串行，签发时看到的就是提交时的状态。
    const job = await trx
      .selectFrom('jobs')
      .select('id')
      .where('id', '=', run.jobId)
      .where('run_id', '=', run.runId)
      .where('status', '=', 'running')
      .where('pause_requested', '=', false)
      .forUpdate()
      .executeTakeFirst();
    if (!job) return null;
    await trx.updateTable('agent_job_tokens').set({ revoked_at: sql<Date>`now()` }).where('job_id', '=', run.jobId).where('revoked_at', 'is', null).execute();
    const row = await trx
      .insertInto('agent_job_tokens')
      .values({
        org_id: run.orgId,
        job_id: run.jobId,
        run_id: run.runId,
        token_hash: hash,
        expires_at: sql<Date>`now() + make_interval(secs => ${ttlMs / 1000})`,
      })
      .returning('expires_at')
      .executeTakeFirstOrThrow();
    return { token, logId: agentTokenLogId(hash), expiresAt: row.expires_at };
  });
}

/** 作废本次执行的令牌（沙箱销毁、执行结束时）。返回作废的个数。 */
export async function revokeAgentJobTokens(db: Kysely<Database>, run: RunRef): Promise<number> {
  const result = await withOrgContext(db, run.orgId, (trx) =>
    trx
      .updateTable('agent_job_tokens')
      .set({ revoked_at: sql<Date>`now()` })
      .where('job_id', '=', run.jobId)
      .where('run_id', '=', run.runId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst(),
  );
  return Number(result.numUpdatedRows);
}

/**
 * 按令牌查身份。格式不对的输入不查库；令牌无效（不存在、已作废、已过期、任务不在本次执行中、发起人已不是成员、项目已删除）
 * 一律返回 null，不区分原因。
 */
export async function lookupAgentJobToken(db: Kysely<Database>, token: unknown): Promise<AgentTokenIdentity | null> {
  if (!isWellFormedAgentToken(token)) return null;
  const hash = hashAgentToken(token);
  const { rows } = await sql<{
    org_id: string;
    job_id: string;
    run_id: string;
    project_id: string | null;
    user_id: string;
    job_type: string;
    member_role: string;
    expires_at: Date;
  }>`SELECT org_id, job_id, run_id, project_id, user_id, job_type, member_role, expires_at FROM agent_token_lookup(${hash})`.execute(db);
  const row = rows[0];
  if (!row || !(MEMBER_ROLES as readonly string[]).includes(row.member_role)) return null;
  return {
    orgId: row.org_id,
    jobId: row.job_id,
    runId: row.run_id,
    projectId: row.project_id,
    userId: row.user_id,
    jobType: row.job_type,
    role: row.member_role as MemberRole,
    expiresAt: row.expires_at,
    logId: agentTokenLogId(hash),
  };
}

/** 按令牌身份建立的租户上下文：业务读写以发起用户的身份经 RLS 进行（8.4 的业务工具 RPC）。 */
export function agentTenantContext(identity: AgentTokenIdentity): TenantContext {
  return { orgId: identity.orgId, userId: identity.userId, role: identity.role };
}
