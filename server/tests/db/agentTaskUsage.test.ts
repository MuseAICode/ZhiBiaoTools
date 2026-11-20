// Agent 任务用量统计的读取（src/agent/usageStats.ts 的 readAgentTaskUsage，8.7f1）经真实数据库：
// - 样本只取时间窗口内成功完成的任务，轮数取 agent_job_budgets.turns_used、费用取 jobs.billed_amount；
// - 因达到上限而失败 / 取消的任务只计入截断数，未达到上限而失败 / 取消的、未结束的任务不计入；
// - 应用角色经 RLS 只读到所查组织的任务与覆盖值（另一组织的同类任务不出现）；未登记上限的任务不出现；
// - 汇总后的建议上限为 P95 的 2 倍。
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS, type AgentTaskLimits } from '../../src/agent/budget.ts';
import { readAgentTaskUsage, summarizeAgentTaskUsage } from '../../src/agent/usageStats.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database, JobStatus } from '../../src/db/schema.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const TYPE = 'technical-plan-outline-generation-test';
const OTHER_TYPE = 'feasibility-outline-test';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;

async function newOrg(): Promise<{ orgId: string; userId: string }> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, userId };
}

interface JobSpec {
  type?: string;
  status?: JobStatus;
  finishedAt?: Date | null;
  turns?: number;
  billed?: bigint;
  confirmations?: number;
  exhausted?: 'task_cost_limit' | 'task_turn_limit' | null;
  budget?: boolean;
}

/** 直接写入任务与上限的终态（超级用户在本事务中停用触发器：这些守卫限定的是执行过程，本测试只关心统计）。 */
async function insertJob(org: { orgId: string; userId: string }, spec: JobSpec): Promise<void> {
  const status = spec.status ?? 'succeeded';
  const finishedAt = spec.finishedAt === undefined ? new Date('2026-11-10T00:00:00Z') : spec.finishedAt;
  await superuser.transaction().execute(async (trx) => {
    await sql`SET LOCAL session_replication_role = replica`.execute(trx);
    const job = await trx
      .insertInto('jobs')
      .values({
        org_id: org.orgId,
        user_id: org.userId,
        type: spec.type ?? TYPE,
        status,
        params: JSON.stringify({}),
        started_at: new Date('2026-11-09T00:00:00Z'),
        finished_at: finishedAt,
        billed_amount: (spec.billed ?? 0n).toString(),
        ...(status === 'failed' ? { error_code: 'TEST_FAILED', error_message: '测试' } : {}),
        ...(status === 'running' ? { run_id: randomUUID(), lease_expires_at: new Date(Date.now() + 60_000) } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (spec.budget === false) return;
    await trx
      .insertInto('agent_job_budgets')
      .values({
        org_id: org.orgId,
        job_id: job.id,
        cost_limit: AGENT_TASK_LIMITS.outline.costLimit.toString(),
        // 确认继续过的任务上限已累加，这里只需不小于已用轮数。
        turn_limit: Math.max(AGENT_TASK_LIMITS.outline.turnLimit, spec.turns ?? 0),
        cost_step: AGENT_TASK_LIMITS.outline.costLimit.toString(),
        turn_step: AGENT_TASK_LIMITS.outline.turnLimit,
        turns_used: spec.turns ?? 0,
        confirmations: spec.confirmations ?? 0,
        exhausted_reason: spec.exhausted ?? null,
      })
      .execute();
  });
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
  appDb = connect<Database>(testDb.appConfig);
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

describe('readAgentTaskUsage', () => {
  it('样本、截断数、窗口与组织隔离', async () => {
    const org = await newOrg();
    const other = await newOrg();
    for (let i = 1; i <= 20; i += 1) await insertJob(org, { turns: i * 10, billed: BigInt(i * 1_000), confirmations: i === 20 ? 1 : 0 });
    await insertJob(org, { type: OTHER_TYPE, turns: 3, billed: 7n });
    // 截断：达到上限后失败 / 取消的计数；未达到上限而失败、仍在执行、窗口外、没有上限的都不计入。
    await insertJob(org, { status: 'failed', turns: 500, exhausted: 'task_turn_limit' });
    await insertJob(org, { status: 'cancelled', turns: 400, exhausted: 'task_cost_limit' });
    await insertJob(org, { status: 'failed', turns: 9 });
    await insertJob(org, { status: 'running', finishedAt: null, turns: 999 });
    await insertJob(org, { turns: 999, finishedAt: new Date('2026-10-01T00:00:00Z') });
    await insertJob(org, { turns: 999, budget: false });
    // 另一组织的同类任务与覆盖值。
    await insertJob(other, { turns: 999, billed: 999_999n });
    await superuser.insertInto('agent_job_limit_overrides').values({ org_id: org.orgId, job_type: TYPE, cost_limit: '20000', turn_limit: 50, created_by: org.userId, updated_by: org.userId }).execute();
    await superuser.insertInto('agent_job_limit_overrides').values({ org_id: other.orgId, job_type: OTHER_TYPE, cost_limit: '30000', turn_limit: 60, created_by: other.userId, updated_by: other.userId }).execute();

    const window = { since: new Date('2026-11-01T00:00:00Z'), until: new Date('2026-12-01T00:00:00Z') };
    const input = await readAgentTaskUsage(appDb, org.orgId, [TYPE, OTHER_TYPE], window);
    const turns = input.samples.filter((sample) => sample.jobType === TYPE).map((sample) => sample.turnsUsed).sort((a, b) => a - b);
    expect(turns).toEqual(Array.from({ length: 20 }, (_, index) => (index + 1) * 10));
    expect(input.samples.filter((sample) => sample.jobType === OTHER_TYPE)).toEqual([{ jobType: OTHER_TYPE, turnsUsed: 3, billedAmount: 7n, confirmations: 0 }]);
    expect(input.censored).toEqual(new Map([[TYPE, 2]]));
    expect(input.overrides).toEqual(new Map([[TYPE, { costLimit: 20_000n, turnLimit: 50 }]]));

    const types = new Map<string, AgentTaskLimits>([[TYPE, AGENT_TASK_LIMITS.outline], [OTHER_TYPE, AGENT_TASK_LIMITS.outline]]);
    const [other_, main] = summarizeAgentTaskUsage(input, types);
    expect(main).toMatchObject({
      jobType: TYPE,
      samples: 20,
      confirmed: 1,
      censored: 2,
      turns: { p50: 100, p95: 190, max: 200 },
      cost: { p50: 10_000n, p95: 19_000n, max: 20_000n },
      suggested: { costLimit: 38_000n, turnLimit: 380 },
    });
    expect(other_).toMatchObject({ jobType: OTHER_TYPE, samples: 1, suggested: null });

    // 不限窗口时窗口外的任务计入。
    const all = await readAgentTaskUsage(appDb, org.orgId, [TYPE]);
    expect(all.samples.map((sample) => sample.turnsUsed)).toContain(999);
    expect(all.samples).toHaveLength(21);

    // 另一组织只看到自己的任务与覆盖值。
    const otherInput = await readAgentTaskUsage(appDb, other.orgId, [TYPE, OTHER_TYPE]);
    expect(otherInput.samples).toEqual([{ jobType: TYPE, turnsUsed: 999, billedAmount: 999_999n, confirmations: 0 }]);
    expect(otherInput.overrides).toEqual(new Map([[OTHER_TYPE, { costLimit: 30_000n, turnLimit: 60 }]]));
  });

  it('没有组织上下文以外的数据泄漏：未知组织为空，没有任务类型时不查询', async () => {
    const empty = await readAgentTaskUsage(appDb, randomUUID(), [TYPE]);
    expect(empty.samples).toEqual([]);
    expect(empty.censored.size).toBe(0);
    expect(await readAgentTaskUsage(appDb, randomUUID(), [])).toEqual({ samples: [], censored: new Map(), overrides: new Map() });
  });
});
