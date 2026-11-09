// Agent 任务令牌（迁移 0031_agent_job_tokens、src/agent/tokenStore.ts，路线图第 8 步 8.2a）的数据库测试：
// 签发条件、每个任务一个有效令牌、作废只能一次、应用角色读不到哈希、按令牌查身份的各种失效情形（恶意样本）与有效令牌（对照组）、
// 用户间数据隔离、随任务记录删除，以及 agent_token_lookup 的属主与授权。
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateAgentToken, hashAgentToken } from '../../src/agent/token.ts';
import {
  agentTenantContext,
  AgentTokenProjectRequiredError,
  AGENT_TOKEN_MAX_TTL_MS,
  issueAgentJobToken,
  lookupAgentJobToken,
  revokeAgentJobTokens,
  type IssuedAgentToken,
} from '../../src/agent/tokenStore.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { AGENT_AUTH_GRANTS } from '../../src/db/migrations/0031_agent_job_tokens.ts';
import { AGENT_AUTH_ROLE, APP_ROLE, AUTH_ROLE, OWNER_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withOrgContext, withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { claimJob, finishRun, insertJob, recoverJob, requestCancel, requestPause, requestResume, type RunRef } from '../../src/jobs/store.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;

interface Member {
  userId: string;
  orgId: string;
  context: TenantContext;
}

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;

async function newMember(orgId: string = randomUUID()): Promise<Member> {
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  const existing = await superuser.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
  if (!existing) await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: 'x', email_verified_at: new Date() }).execute();
  const role = existing ? 'member' : 'owner';
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { userId, orgId, context: { orgId, userId, role } };
}

async function createProject(member: Member): Promise<string> {
  const row = await withTenant(appDb, member.context, (trx) =>
    trx
      .insertInto('projects')
      .values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}

/** 新建一个属于项目的任务（未给出项目时新建一个）并认领为 running，返回本次执行。 */
async function runningJob(member: Member, projectId?: string): Promise<RunRef> {
  const job = await insertJob(appDb, member.context, { type: 'test-agent', params: {}, projectId: projectId ?? (await createProject(member)) });
  return claim(member.orgId, job.id);
}

/** 不属于项目的（组织级）任务，认领为 running。 */
async function runningOrgJob(member: Member): Promise<RunRef> {
  const job = await insertJob(appDb, member.context, { type: 'test-agent', params: {} });
  return claim(member.orgId, job.id);
}

async function claim(orgId: string, jobId: string): Promise<RunRef> {
  const runId = randomUUID();
  const result = await claimJob(appDb, { orgId, jobId, runId, leaseMs: LEASE_MS, orgRunningLimit: 100, attemptsFor: () => 5 });
  expect(result.kind).toBe('claimed');
  return { orgId, jobId, runId };
}

async function issue(run: RunRef, ttlMs = TTL_MS): Promise<IssuedAgentToken> {
  const issued = await issueAgentJobToken(appDb, run, ttlMs);
  expect(issued).not.toBeNull();
  return issued!;
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

describe('签发与按令牌查身份', () => {
  it('对照组：为 running 的任务签发，按令牌查出组织、任务、执行、项目、用户、类型与角色', async () => {
    const a = await newMember();
    const projectId = await createProject(a);
    const run = await runningJob(a, projectId);
    const issued = await issue(run);
    expect(issued.token).toMatch(/^agt_[A-Za-z0-9_-]{43}$/);
    expect(issued.logId).toMatch(/^[0-9a-f]{12}$/);

    const identity = await lookupAgentJobToken(appDb, issued.token);
    expect(identity).toMatchObject({
      orgId: a.orgId,
      jobId: run.jobId,
      runId: run.runId,
      projectId,
      userId: a.userId,
      jobType: 'test-agent',
      role: 'owner',
      logId: issued.logId,
    });
    // 有效期取令牌与租约中较早者：租约 60 秒，比令牌的 30 分钟早。
    expect(identity!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + LEASE_MS + 5_000);
    expect(agentTenantContext(identity!)).toEqual(a.context);

    // 库中只有哈希。
    const stored = await superuser.selectFrom('agent_job_tokens').select(['token_hash', 'expires_at', 'created_at']).where('job_id', '=', run.jobId).execute();
    expect(stored).toHaveLength(1);
    const [row] = stored as [{ token_hash: Buffer; expires_at: Date; created_at: Date }];
    expect(Buffer.from(row.token_hash).equals(hashAgentToken(issued.token))).toBe(true);
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(TTL_MS);
  });

  it('不属于项目的任务不签发：Store 拒绝，直接写入被 RLS 拒绝', async () => {
    const a = await newMember();
    const run = await runningOrgJob(a);
    await expect(issueAgentJobToken(appDb, run, TTL_MS)).rejects.toThrow(AgentTokenProjectRequiredError);
    await expect(
      withOrgContext(appDb, a.orgId, (trx) =>
        trx
          .insertInto('agent_job_tokens')
          .values({ org_id: a.orgId, job_id: run.jobId, run_id: run.runId, token_hash: hashAgentToken(generateAgentToken()), expires_at: new Date(Date.now() + 60_000) })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await superuser.selectFrom('agent_job_tokens').select('id').where('job_id', '=', run.jobId).execute()).toEqual([]);
    // 对照组：同一组织、同样状态的项目任务能签发。
    await issue(await runningJob(a));
  });

  it('即使库中有不属于项目的任务的令牌（绕过签发条件写入），也查不到', async () => {
    const a = await newMember();
    const run = await runningOrgJob(a);
    const token = generateAgentToken();
    await superuser
      .insertInto('agent_job_tokens')
      .values({ org_id: a.orgId, job_id: run.jobId, run_id: run.runId, token_hash: hashAgentToken(token), expires_at: sql`now() + interval '10 minutes'` })
      .execute();
    expect(await lookupAgentJobToken(appDb, token)).toBeNull();
  });

  it('格式不对、不存在的令牌查不到', async () => {
    for (const value of [undefined, null, '', 'agt_short', 123, { token: 'x' }, `Bearer ${generateAgentToken()}`]) {
      expect(await lookupAgentJobToken(appDb, value)).toBeNull();
    }
    expect(await lookupAgentJobToken(appDb, generateAgentToken())).toBeNull();
  });

  it('只为本次执行签发：queued、run_id 不符、已请求暂停、已结束的任务都不签发', async () => {
    const a = await newMember();
    const queued = await insertJob(appDb, a.context, { type: 'test-agent', params: {} });
    expect(await issueAgentJobToken(appDb, { orgId: a.orgId, jobId: queued.id, runId: randomUUID() }, TTL_MS)).toBeNull();

    const run = await runningJob(a);
    expect(await issueAgentJobToken(appDb, { ...run, runId: randomUUID() }, TTL_MS)).toBeNull();
    // 其他组织的上下文看不到这个任务。
    const b = await newMember();
    expect(await issueAgentJobToken(appDb, { ...run, orgId: b.orgId }, TTL_MS)).toBeNull();

    await requestPause(appDb, a.context, run.jobId);
    expect(await issueAgentJobToken(appDb, run, TTL_MS)).toBeNull();
    await requestResume(appDb, a.context, run.jobId);
    expect(await issueAgentJobToken(appDb, run, TTL_MS)).not.toBeNull();

    await finishRun(appDb, run, { kind: 'succeeded' }, false);
    expect(await issueAgentJobToken(appDb, run, TTL_MS)).toBeNull();
  });

  it('有效期必须在 1 秒到 135 分钟之间', async () => {
    const a = await newMember();
    const run = await runningJob(a);
    for (const ttl of [0, 999, AGENT_TOKEN_MAX_TTL_MS + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(issueAgentJobToken(appDb, run, ttl), String(ttl)).rejects.toThrow(TypeError);
    }
    await issue(run, AGENT_TOKEN_MAX_TTL_MS);
  });

  it('每个任务最多一个有效令牌：再次签发时旧令牌作废', async () => {
    const a = await newMember();
    const run = await runningJob(a);
    const first = await issue(run);
    const second = await issue(run);
    expect(await lookupAgentJobToken(appDb, first.token)).toBeNull();
    expect(await lookupAgentJobToken(appDb, second.token)).toMatchObject({ jobId: run.jobId });
    const rows = await superuser.selectFrom('agent_job_tokens').select('revoked_at').where('job_id', '=', run.jobId).orderBy('created_at').execute();
    expect(rows.map((row: { revoked_at: Date | null }) => row.revoked_at !== null).sort()).toEqual([false, true]);
  });
});

describe('令牌失效（恶意样本：失效后一律查不到）', () => {
  let a: Member;

  beforeAll(async () => {
    a = await newMember();
  });

  async function expectInvalidAfter(change: (run: RunRef) => Promise<unknown>, setup?: () => Promise<RunRef>): Promise<void> {
    const run = setup ? await setup() : await runningJob(a);
    const { token } = await issue(run);
    expect(await lookupAgentJobToken(appDb, token)).not.toBeNull();
    await change(run);
    expect(await lookupAgentJobToken(appDb, token)).toBeNull();
  }

  it('作废后', async () => {
    await expectInvalidAfter(async (run) => expect(await revokeAgentJobTokens(appDb, run)).toBe(1));
  });

  it('过期后', async () => {
    const run = await runningJob(a);
    const { token } = await issue(run, 1000);
    expect(await lookupAgentJobToken(appDb, token)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await lookupAgentJobToken(appDb, token)).toBeNull();
  });

  it('租约过期后（执行者失联，即使还没被对账收回）', async () => {
    await expectInvalidAfter((run) => superuser.updateTable('jobs').set({ lease_expires_at: sql`now() - interval '1 second'` }).where('id', '=', run.jobId).execute());
  });

  it('请求暂停后；撤销暂停请求后同一执行的令牌恢复有效', async () => {
    const run = await runningJob(a);
    const { token } = await issue(run);
    await requestPause(appDb, a.context, run.jobId);
    expect(await lookupAgentJobToken(appDb, token)).toBeNull();
    await requestResume(appDb, a.context, run.jobId);
    expect(await lookupAgentJobToken(appDb, token)).not.toBeNull();
    await requestPause(appDb, a.context, run.jobId);
    await finishRun(appDb, run, { kind: 'interrupted' }, true);
    expect((await superuser.selectFrom('jobs').select('status').where('id', '=', run.jobId).executeTakeFirstOrThrow()).status).toBe('paused');
    expect(await lookupAgentJobToken(appDb, token)).toBeNull();
  });

  it('请求取消后', async () => {
    await expectInvalidAfter((run) => requestCancel(appDb, a.context, run.jobId));
  });

  it('任务成功、失败、余额不足暂停后', async () => {
    await expectInvalidAfter((run) => finishRun(appDb, run, { kind: 'succeeded' }, true));
    await expectInvalidAfter((run) => finishRun(appDb, run, { kind: 'failed', code: 'X', message: 'x' }, true));
    await expectInvalidAfter((run) => finishRun(appDb, run, { kind: 'insufficient-balance' }, true));
  });

  it('续跑换了执行者（run_id 变更）后；新执行签发的令牌有效', async () => {
    const run = await runningJob(a);
    const old = await issue(run);
    await superuser.updateTable('jobs').set({ lease_expires_at: sql`now() - interval '1 second'` }).where('id', '=', run.jobId).execute();
    expect(await recoverJob(appDb, { orgId: a.orgId, id: run.jobId }, () => true)).toMatchObject({ kind: 'dispatch' });
    const next = await claim(a.orgId, run.jobId);
    expect(next.runId).not.toBe(run.runId);
    expect(await lookupAgentJobToken(appDb, old.token)).toBeNull();
    // 旧执行者不能再为自己签发。
    expect(await issueAgentJobToken(appDb, run, TTL_MS)).toBeNull();
    const fresh = await issue(next);
    expect(await lookupAgentJobToken(appDb, fresh.token)).toMatchObject({ runId: next.runId });
    // 旧执行者的作废不影响新执行的令牌。
    expect(await revokeAgentJobTokens(appDb, run)).toBe(0);
    expect(await lookupAgentJobToken(appDb, fresh.token)).not.toBeNull();
  });

  it('发起人被移出组织后', async () => {
    const owner = await newMember();
    const member = await newMember(owner.orgId);
    await expectInvalidAfter(
      () => superuser.deleteFrom('org_memberships').where('org_id', '=', member.orgId).where('user_id', '=', member.userId).execute(),
      () => runningJob(member),
    );
  });

  it('发起人账号停用后', async () => {
    const member = await newMember();
    await expectInvalidAfter(
      () => superuser.updateTable('users').set({ status: 'disabled' }).where('id', '=', member.userId).execute(),
      () => runningJob(member),
    );
  });

  it('任务所属项目删除后', async () => {
    const projectId = await createProject(a);
    await expectInvalidAfter(
      () => superuser.updateTable('projects').set({ deleted_at: new Date(), deleted_by: a.userId }).where('id', '=', projectId).execute(),
      () => runningJob(a, projectId),
    );
  });

  it('发起人的角色变化后，查出的是当前角色', async () => {
    const owner = await newMember();
    const member = await newMember(owner.orgId);
    const { token } = await issue(await runningJob(member));
    expect((await lookupAgentJobToken(appDb, token))!.role).toBe('member');
    await superuser.updateTable('org_memberships').set({ role: 'admin' }).where('user_id', '=', member.userId).execute();
    expect((await lookupAgentJobToken(appDb, token))!.role).toBe('admin');
  });
});

describe('表的权限与约束', () => {
  let a: Member;
  let b: Member;
  let runA: RunRef;
  let tokenA: IssuedAgentToken;

  beforeAll(async () => {
    a = await newMember();
    b = await newMember();
    runA = await runningJob(a);
    tokenA = await issue(runA);
  });

  it('应用角色读不到 token_hash；未设置上下文时看不到任何令牌', async () => {
    await expect(withOrgContext(appDb, a.orgId, (trx) => sql`SELECT token_hash FROM agent_job_tokens`.execute(trx))).rejects.toThrow(/permission denied/);
    expect(await appDb.selectFrom('agent_job_tokens').select('id').execute()).toEqual([]);
    const rows = await withOrgContext(appDb, a.orgId, (trx) => trx.selectFrom('agent_job_tokens').select(['job_id', 'run_id']).execute());
    expect(rows).toEqual([{ job_id: runA.jobId, run_id: runA.runId }]);
  });

  it('用户间数据隔离：组织 B 看不到、作废不了组织 A 的令牌，也不能为 A 的任务写入令牌', async () => {
    await withTenant(appDb, b.context, async (trx) => {
      expect(await trx.selectFrom('agent_job_tokens').select('id').execute()).toEqual([]);
      const changed = await trx.updateTable('agent_job_tokens').set({ revoked_at: sql`now()` }).where('job_id', '=', runA.jobId).executeTakeFirst();
      expect(changed.numUpdatedRows).toBe(0n);
    });
    expect(await revokeAgentJobTokens(appDb, { ...runA, orgId: b.orgId })).toBe(0);
    expect(await lookupAgentJobToken(appDb, tokenA.token)).not.toBeNull();

    const forged = (orgId: string) =>
      withOrgContext(appDb, b.orgId, (trx) =>
        trx
          .insertInto('agent_job_tokens')
          .values({ org_id: orgId, job_id: runA.jobId, run_id: runA.runId, token_hash: hashAgentToken(generateAgentToken()), expires_at: new Date(Date.now() + 60_000) })
          .execute(),
      );
    await expect(forged(a.orgId)).rejects.toThrow(/row-level security/);
    await expect(forged(b.orgId)).rejects.toThrow(/row-level security|foreign key/);
  });

  it('直接写入也只能为 running、run_id 相符、未请求暂停的任务写入，且有效期不超过 135 分钟', async () => {
    const run = await runningJob(a);
    const insert = (values: { run_id?: string; expires_at?: unknown; created_at?: unknown }) =>
      withOrgContext(appDb, a.orgId, (trx) =>
        trx
          .insertInto('agent_job_tokens')
          .values({
            org_id: a.orgId,
            job_id: run.jobId,
            run_id: values.run_id ?? run.runId,
            token_hash: hashAgentToken(generateAgentToken()),
            expires_at: (values.expires_at ?? new Date(Date.now() + 60_000)) as Date,
          })
          .execute(),
      );
    await expect(insert({ run_id: randomUUID() })).rejects.toThrow(/row-level security/);
    await expect(insert({ expires_at: sql`now() + interval '136 minutes'` })).rejects.toThrow(/agent_job_tokens_ttl/);
    await expect(insert({ expires_at: sql`now()` })).rejects.toThrow(/agent_job_tokens_ttl/);
    await insert({});
    // 已有一个有效令牌时不能再写入第二个（签发须先作废旧的）。
    await expect(insert({})).rejects.toThrow(/agent_job_tokens_live_key/);
    // 不能在写入时指定作废时间、创建时间或 id。
    await expect(
      withOrgContext(appDb, a.orgId, (trx) =>
        sql`INSERT INTO agent_job_tokens (org_id, job_id, run_id, token_hash, expires_at, created_at)
            VALUES (${a.orgId}, ${run.jobId}, ${run.runId}, ${hashAgentToken(generateAgentToken())}, now() + interval '1 minute', now() - interval '1 hour')`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('只能作废一次，作废时间取 now()；不能改其他列、不能删除', async () => {
    const run = await runningJob(a);
    await issue(run);
    await withOrgContext(appDb, a.orgId, async (trx) => {
      await trx.updateTable('agent_job_tokens').set({ revoked_at: new Date('2000-01-01T00:00:00Z') }).where('job_id', '=', run.jobId).execute();
    });
    const row = await superuser.selectFrom('agent_job_tokens').select(['revoked_at', 'created_at']).where('job_id', '=', run.jobId).executeTakeFirstOrThrow();
    expect(row.revoked_at.getTime()).toBeGreaterThanOrEqual(row.created_at.getTime());
    await expect(
      withOrgContext(appDb, a.orgId, (trx) => trx.updateTable('agent_job_tokens').set({ revoked_at: sql`now()` }).where('job_id', '=', run.jobId).execute()),
    ).rejects.toThrow(/can only be revoked once/);
    for (const statement of [
      sql`UPDATE agent_job_tokens SET expires_at = now() + interval '1 minute' WHERE job_id = ${run.jobId}`,
      sql`UPDATE agent_job_tokens SET run_id = ${randomUUID()} WHERE job_id = ${run.jobId}`,
      sql`UPDATE agent_job_tokens SET token_hash = ${hashAgentToken(generateAgentToken())} WHERE job_id = ${run.jobId}`,
      sql`DELETE FROM agent_job_tokens WHERE job_id = ${run.jobId}`,
    ]) {
      await expect(withOrgContext(appDb, a.orgId, (trx) => statement.execute(trx))).rejects.toThrow(/permission denied/);
    }
  });

  it('令牌随任务记录删除', async () => {
    const run = await runningJob(a);
    await issue(run);
    await superuser.deleteFrom('jobs').where('id', '=', run.jobId).execute();
    expect(await superuser.selectFrom('agent_job_tokens').select('id').where('job_id', '=', run.jobId).execute()).toEqual([]);
  });
});

describe('agent_token_lookup 与 bidtools_agent_auth', () => {
  it('SECURITY DEFINER、固定 search_path、属主为 bidtools_agent_auth，只授权给应用角色', async () => {
    const signature = 'agent_token_lookup(bytea)';
    const result = await sql<{ prosecdef: boolean; proconfig: string[]; owner: string; public_acl: boolean; volatile: string }>`
      SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.provolatile AS volatile,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_acl
      FROM pg_proc p WHERE p.oid = ${signature}::regprocedure`.execute(superuser);
    expect(result.rows).toEqual([
      { prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], owner: AGENT_AUTH_ROLE, public_acl: false, volatile: 's' },
    ]);
    const privileges = await sql<{ app: boolean; owner: boolean }>`
      SELECT has_function_privilege(${APP_ROLE}, ${signature}, 'EXECUTE') AS app,
             has_function_privilege(${OWNER_ROLE}, ${signature}, 'EXECUTE') AS owner`.execute(superuser);
    expect(privileges.rows).toEqual([{ app: true, owner: false }]);
  });

  it('属主角色不能登录、不是超级用户、不能绕过 RLS，迁移角色只能 SET、不继承', async () => {
    const result = await sql`
      SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreatedb, rolcreaterole, rolreplication
      FROM pg_roles WHERE rolname = ${AGENT_AUTH_ROLE}`.execute(superuser);
    expect(result.rows).toEqual([
      { rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false },
    ]);
    const members = await sql`
      SELECT pg_get_userbyid(member) AS member, inherit_option, set_option, admin_option
      FROM pg_auth_members WHERE roleid = ${AGENT_AUTH_ROLE}::regrole`.execute(superuser);
    expect(members.rows).toEqual([{ member: OWNER_ROLE, inherit_option: false, set_option: true, admin_option: false }]);
    await expect(sql`SET ROLE ${sql.id(AGENT_AUTH_ROLE)}`.execute(appDb)).rejects.toThrow(/permission denied/);
  });

  it('只对函数用到的列有只读权限，对计费、会话、凭据等其他表没有任何权限', async () => {
    const columns = await sql<{ table_name: string; privilege_type: string; column_name: string }>`
      SELECT table_name, privilege_type, column_name FROM information_schema.column_privileges
      WHERE grantee = ${AGENT_AUTH_ROLE} ORDER BY table_name, column_name`.execute(superuser);
    expect(new Set(columns.rows.map((row) => row.privilege_type))).toEqual(new Set(['SELECT']));
    const expected = Object.fromEntries(AGENT_AUTH_GRANTS.map(([table, cols]) => [table, [...cols].sort()]));
    const actual: Record<string, string[]> = {};
    for (const row of columns.rows) (actual[row.table_name] ??= []).push(row.column_name);
    expect(actual).toEqual(expected);

    // 表级授权：一个都没有（只有列级 SELECT）。
    const tables = await sql`
      SELECT table_name, privilege_type FROM information_schema.table_privileges WHERE grantee = ${AGENT_AUTH_ROLE}`.execute(superuser);
    expect(tables.rows).toEqual([]);

    // 逐表核对：计费、用量、凭据、会话等表上没有任何权限，也没有为它建的策略。
    for (const table of [
      'org_balances',
      'billing_ledger',
      'model_prices',
      'usage_records',
      'provider_credentials',
      'platform_models',
      'sessions',
      'auth_tokens',
      'invitations',
      'files',
      'artifacts',
      'job_events',
      'job_step_results',
      'organizations',
    ]) {
      const check = await sql<{ any: boolean }>`
        SELECT has_any_column_privilege(${AGENT_AUTH_ROLE}, ${table}::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
            OR has_table_privilege(${AGENT_AUTH_ROLE}, ${table}::regclass, 'DELETE, TRUNCATE, TRIGGER') AS any`.execute(superuser);
      expect(check.rows[0]!.any, table).toBe(false);
    }
    const policies = await sql<{ table: string }>`
      SELECT c.relname AS table FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE ${AGENT_AUTH_ROLE}::regrole = ANY (p.polroles) ORDER BY c.relname`.execute(superuser);
    expect(policies.rows.map((row) => row.table)).toEqual(AGENT_AUTH_GRANTS.map(([table]) => table).sort());

    // 函数之外不能执行其他定义者函数，也没有建函数的权限。
    const create = await sql<{ create: boolean }>`SELECT has_schema_privilege(${AGENT_AUTH_ROLE}, 'public', 'CREATE') AS create`.execute(superuser);
    expect(create.rows).toEqual([{ create: false }]);
  });

  it('bidtools_auth 的权限不因本迁移扩大：对 agent_job_tokens、jobs、projects 没有任何权限', async () => {
    for (const table of ['agent_job_tokens', 'jobs', 'projects']) {
      const check = await sql<{ any: boolean }>`
        SELECT has_any_column_privilege(${AUTH_ROLE}, ${table}::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') AS any`.execute(superuser);
      expect(check.rows[0]!.any, table).toBe(false);
    }
  });
});
