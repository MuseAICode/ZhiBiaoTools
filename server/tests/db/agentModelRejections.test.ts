// Agent 的模型调用被平台拒绝的原因（迁移 0043_agent_model_rejections、src/agent/modelRejections.ts，路线图第 8 步 8.6d3）
// 对真实数据库的测试（路由与执行者的端到端用例见 tests/db/agentChat.test.ts、tests/db/agentExecution.test.ts）：
// 1. recordAgentModelRejection：记下最近一次的原因、次数每次加 1；任务不在本次执行中（run_id 不符、已结束）、不是登记了上限的
//    Agent 任务、其他组织的上下文时不写入；
// 2. agentModelRejectionSince：只采信 mark 之后的拒绝；不同执行互不影响；
// 3. agentModelRejectionReason：错误代码到原因的对应，其余错误不记；
// 4. RLS、授权与 CHECK；随任务删除；jobs.pause_reason 接受 model_not_configured / model_unavailable（#98 确认的暂停）；
//    回滚 0043（因模型不可用暂停的任务改为普通暂停）。
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import {
  agentModelRejectionMark,
  agentModelRejectionReason,
  agentModelRejectionSince,
  findAgentModelRejection,
  recordAgentModelRejection,
} from '../../src/agent/modelRejections.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withOrgContext, withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import { JobError } from '../../src/jobs/definitions.ts';
import { claimJob, finishRun, insertJob, type RunRef } from '../../src/jobs/store.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const LEASE_MS = 60_000;

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;

interface Member {
  orgId: string;
  userId: string;
  context: TenantContext;
}

async function newMember(): Promise<Member> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'team' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: 'x', email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, userId, context: { orgId, userId, role: 'owner' } };
}

async function newProject(member: Member): Promise<string> {
  const project = await withTenant(appDb, member.context, (trx) =>
    trx.insertInto('projects').values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId }).returning('id').executeTakeFirstOrThrow(),
  );
  return project.id;
}

async function claim(member: Member, jobId: string): Promise<RunRef> {
  const runId = randomUUID();
  const result = await claimJob(appDb, { orgId: member.orgId, jobId, runId, leaseMs: LEASE_MS, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 });
  expect(result.kind).toBe('claimed');
  return { orgId: member.orgId, jobId, runId };
}

async function runningJob(member: Member): Promise<RunRef> {
  const job = await insertJob(appDb, member.context, { type: 'test-agent', params: {}, projectId: await newProject(member), agentLimits: AGENT_TASK_LIMITS.outline });
  return claim(member, job.id);
}

function refOf(member: Member, run: RunRef) {
  return { tenant: member.context, jobId: run.jobId, runId: run.runId };
}

async function rows(jobId: string) {
  return superuser.selectFrom('agent_model_rejections').select(['org_id', 'run_id', 'reason', 'rejections']).where('job_id', '=', jobId).execute();
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  database = createDatabase(testDb.appConfig);
  appDb = database.db;
});

afterAll(async () => {
  await database?.destroy();
  await testDb?.drop();
});

describe('recordAgentModelRejection', () => {
  it('记下最近一次的原因，次数每次加 1；没有被拒绝过时为 null', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    expect(await findAgentModelRejection(appDb, run)).toBeNull();
    expect(await agentModelRejectionMark(appDb, run)).toBe(0);
    expect(await recordAgentModelRejection(appDb, refOf(member, run), 'model_unavailable')).toBe(true);
    expect(await findAgentModelRejection(appDb, run)).toEqual({ reason: 'model_unavailable', rejections: 1 });
    expect(await recordAgentModelRejection(appDb, refOf(member, run), 'insufficient_balance')).toBe(true);
    expect(await findAgentModelRejection(appDb, run)).toEqual({ reason: 'insufficient_balance', rejections: 2 });
    expect(await rows(run.jobId)).toEqual([{ org_id: member.orgId, run_id: run.runId, reason: 'insufficient_balance', rejections: 2 }]);
  });

  it('任务不在本次执行中（run_id 不符、已结束）、不是登记了上限的 Agent 任务、其他组织的上下文：不写入，返回 false', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    expect(await recordAgentModelRejection(appDb, { ...refOf(member, run), runId: randomUUID() }, 'insufficient_balance')).toBe(false);
    const other = await newMember();
    expect(await recordAgentModelRejection(appDb, { ...refOf(member, run), tenant: other.context }, 'insufficient_balance')).toBe(false);

    const plain = await insertJob(appDb, member.context, { type: 'test-plain', params: {}, projectId: await newProject(member) });
    const plainRun = await claim(member, plain.id);
    expect(await recordAgentModelRejection(appDb, refOf(member, plainRun), 'insufficient_balance')).toBe(false);

    expect(await finishRun(appDb, run, { kind: 'succeeded' }, true)).toBe('succeeded');
    expect(await recordAgentModelRejection(appDb, refOf(member, run), 'insufficient_balance')).toBe(false);
    expect(await superuser.selectFrom('agent_model_rejections').select('job_id').where('job_id', 'in', [run.jobId, plain.id]).execute()).toEqual([]);
  });
});

describe('agentModelRejectionSince', () => {
  it('只采信 mark 之后的拒绝；不同执行互不影响', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    const other = await runningJob(member);
    await recordAgentModelRejection(appDb, refOf(member, run), 'model_unavailable');
    const mark = await agentModelRejectionMark(appDb, run);
    expect(mark).toBe(1);
    expect(await agentModelRejectionSince(appDb, run, mark)).toBeNull();
    expect(await agentModelRejectionSince(appDb, run, 0)).toBe('model_unavailable');
    await recordAgentModelRejection(appDb, refOf(member, run), 'insufficient_balance');
    expect(await agentModelRejectionSince(appDb, run, mark)).toBe('insufficient_balance');
    expect(await agentModelRejectionSince(appDb, other, 0)).toBeNull();
    // 其他组织的上下文读不到（RLS）。
    const stranger = await newMember();
    expect(await agentModelRejectionSince(appDb, { ...run, orgId: stranger.orgId }, 0)).toBeNull();
  });
});

describe('agentModelRejectionReason', () => {
  it('错误代码到原因的对应；其余错误（上游失败、超时、并发、上限、请求不合法、非 AppError）不记', () => {
    expect(agentModelRejectionReason(new AppError(402, 'INSUFFICIENT_BALANCE', 'x'))).toBe('insufficient_balance');
    expect(agentModelRejectionReason(new JobError('AI_MODEL_NOT_CONFIGURED', 'x'))).toBe('model_not_configured');
    for (const code of ['AI_GATEWAY_DISABLED', 'AI_MODEL_NOT_REGISTERED', 'AI_MODEL_DISABLED', 'AI_MODEL_NOT_FOUND', 'AI_MODEL_PRICE_CONFLICT', 'MODEL_PRICE_NOT_CONFIGURED', 'AI_PROVIDER_NOT_CONFIGURED']) {
      expect(agentModelRejectionReason(new AppError(503, code, 'x'))).toBe('model_unavailable');
    }
    for (const code of ['AI_UPSTREAM_ERROR', 'AI_UPSTREAM_TIMEOUT', 'AI_CONCURRENCY_LIMITED', 'AI_PROVIDER_UNAVAILABLE', 'TASK_COST_LIMIT', 'TASK_TURN_LIMIT', 'INVALID_AI_REQUEST', 'JOB_NOT_RUNNING', 'toString', '__proto__']) {
      expect(agentModelRejectionReason(new AppError(409, code, 'x'))).toBeNull();
    }
    const fake = Object.assign(new Error('x'), { code: 'INSUFFICIENT_BALANCE' });
    expect(agentModelRejectionReason(fake)).toBeNull();
    expect(agentModelRejectionReason(null)).toBeNull();
  });
});

describe('RLS、授权与约束', () => {
  it('应用角色：不能为其他组织、不在执行中的任务写入；不能改标识列；没有 DELETE；只看得到本组织的行', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    expect(await recordAgentModelRejection(appDb, refOf(member, run), 'insufficient_balance')).toBe(true);
    const other = await newMember();
    const otherRun = await runningJob(other);
    const asOrg = <T>(orgId: string, fn: (trx: any) => Promise<T>) => withOrgContext(appDb, orgId, fn);

    await expect(asOrg(member.orgId, (trx) => sql`INSERT INTO agent_model_rejections (org_id, job_id, run_id, reason) VALUES (${other.orgId}::uuid, ${otherRun.jobId}::uuid, ${otherRun.runId}::uuid, 'insufficient_balance')`.execute(trx))).rejects.toThrow(/row-level security/);
    const fresh = await runningJob(member);
    await expect(asOrg(member.orgId, (trx) => sql`INSERT INTO agent_model_rejections (org_id, job_id, run_id, reason) VALUES (${member.orgId}::uuid, ${fresh.jobId}::uuid, ${randomUUID()}::uuid, 'insufficient_balance')`.execute(trx))).rejects.toThrow(/row-level security/);
    for (const set of [`run_id = '${randomUUID()}'`, `job_id = '${otherRun.jobId}'`, `org_id = '${other.orgId}'`]) {
      await expect(asOrg(member.orgId, (trx) => sql`UPDATE agent_model_rejections SET ${sql.raw(set)} WHERE job_id = ${run.jobId}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    }
    await expect(asOrg(member.orgId, (trx) => sql`DELETE FROM agent_model_rejections WHERE job_id = ${run.jobId}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(asOrg(member.orgId, (trx) => sql`INSERT INTO agent_model_rejections (org_id, job_id, run_id, reason, rejections) VALUES (${member.orgId}::uuid, ${fresh.jobId}::uuid, ${fresh.runId}::uuid, 'insufficient_balance', 5)`.execute(trx))).rejects.toThrow(/permission denied/);
    // 其他组织改不了、看不到本组织的行。
    await expect(asOrg(other.orgId, (trx) => sql`UPDATE agent_model_rejections SET reason = 'model_unavailable' WHERE job_id = ${run.jobId}::uuid`.execute(trx))).resolves.toMatchObject({ numAffectedRows: 0n });
    expect(await asOrg(other.orgId, (trx) => trx.selectFrom('agent_model_rejections').select('job_id').execute())).toEqual([]);
    expect(await asOrg(member.orgId, (trx) => trx.selectFrom('agent_model_rejections').select('reason').execute())).toEqual([{ reason: 'insufficient_balance' }]);

    // 执行结束后旧执行的行不能再改。
    expect(await finishRun(appDb, run, { kind: 'succeeded' }, true)).toBe('succeeded');
    await expect(asOrg(member.orgId, (trx) => sql`UPDATE agent_model_rejections SET reason = 'model_unavailable' WHERE job_id = ${run.jobId}::uuid`.execute(trx))).resolves.toMatchObject({ numAffectedRows: 0n });
    expect(await rows(run.jobId)).toMatchObject([{ reason: 'insufficient_balance', rejections: 1 }]);
  });

  it('CHECK：原因只能是登记的三种，次数至少为 1', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    const write = (reason: string) =>
      withOrgContext(appDb, member.orgId, (trx) => sql`INSERT INTO agent_model_rejections (org_id, job_id, run_id, reason) VALUES (${member.orgId}::uuid, ${run.jobId}::uuid, ${run.runId}::uuid, ${reason})`.execute(trx));
    for (const reason of ['task_cost_limit', 'INSUFFICIENT_BALANCE', '']) await expect(write(reason)).rejects.toThrow(/agent_model_rejections_reason_check/);
    await expect(write('model_not_configured')).resolves.toBeDefined();
    await expect(withOrgContext(appDb, member.orgId, (trx) => sql`UPDATE agent_model_rejections SET rejections = 0 WHERE job_id = ${run.jobId}::uuid`.execute(trx))).rejects.toThrow(/agent_model_rejections_rejections_check/);
  });

  it('随任务记录删除', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    expect(await recordAgentModelRejection(appDb, refOf(member, run), 'insufficient_balance')).toBe(true);
    await superuser.deleteFrom('jobs').where('id', '=', run.jobId).execute();
    expect(await rows(run.jobId)).toEqual([]);
  });
});

describe('暂停原因', () => {
  it('jobs.pause_reason 接受 model_not_configured、model_unavailable，其他值仍被拒绝', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    for (const reason of ['model_not_configured', 'model_unavailable']) {
      await superuser.updateTable('jobs').set({ status: 'paused', pause_reason: reason, run_id: null, lease_expires_at: null }).where('id', '=', run.jobId).execute();
    }
    await expect(superuser.updateTable('jobs').set({ pause_reason: 'model_missing' }).where('id', '=', run.jobId).execute()).rejects.toThrow(/jobs_pause_reason_check/);
  });

  it('finishRun：model-unavailable 暂停为该原因并写明说明；已请求取消时仍为取消', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    expect(await finishRun(appDb, run, { kind: 'model-unavailable', reason: 'model_not_configured' }, true)).toBe('paused');
    const row = await superuser.selectFrom('jobs').select(['status', 'pause_reason', 'checkpoint']).where('id', '=', run.jobId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'paused', pause_reason: 'model_not_configured' });
    const event = await superuser.selectFrom('job_events').select(['message', 'data']).where('job_id', '=', run.jobId).where('kind', '=', 'paused').executeTakeFirstOrThrow();
    expect(event).toMatchObject({ message: '尚未选择文本模型，任务已暂停，请在设置中选择模型后继续', data: { reason: 'model_not_configured' } });

    const cancelled = await runningJob(member);
    await superuser.updateTable('jobs').set({ status: 'cancelling' }).where('id', '=', cancelled.jobId).execute();
    expect(await finishRun(appDb, cancelled, { kind: 'model-unavailable', reason: 'model_unavailable' }, true)).toBe('cancelled');
  });
});

describe('回滚 0043', () => {
  it('删除拒绝原因表，因模型不可用暂停的任务改为普通暂停，之后再升级成功', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    expect(await finishRun(appDb, run, { kind: 'model-unavailable', reason: 'model_unavailable' }, true)).toBe('paused');
    await database.destroy();
    const owner = connect(testDb.ownerConfig);
    try {
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0044_job_pause_selection']);
      const down = await migrateDown(owner);
      expect(down.error).toBeUndefined();
      expect(down.results?.map((result) => result.migrationName)).toEqual(['0043_agent_model_rejections']);
      const { rows: tables } = await sql<{ name: string | null }>`SELECT to_regclass('agent_model_rejections')::text AS name`.execute(superuser);
      expect(tables[0]!.name).toBeNull();
      expect(await superuser.selectFrom('jobs').select(['status', 'pause_reason']).where('id', '=', run.jobId).executeTakeFirstOrThrow()).toEqual({ status: 'paused', pause_reason: null });
      expect((await migrateToLatest(owner)).error).toBeUndefined();
    } finally {
      await owner.destroy();
    }
  });
});
