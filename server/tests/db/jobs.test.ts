// 任务表（迁移 0021_jobs）的数据库与接口测试：jobs / job_events 的 RLS、列级授权、守卫与约束、互斥索引，
// 跨组织对账函数 jobs_dispatch_candidates（属主 bidtools_jobs），以及 /api/jobs 接口。不需要 Redis（执行见 jobQueue.test.ts）。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { APP_ROLE, JOBS_ROLE } from '../../src/db/roles.ts';
import type { Database } from '../../src/db/schema.ts';
import { withOrgContext, withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { claimJob, insertJob, listDispatchCandidates, type JobRecord } from '../../src/jobs/store.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const PASSWORD = 'quiet-harbor-maple-58';

const RELAXED_LIMITS: AuthRateLimitSettings = Object.fromEntries(
  Object.entries(DEFAULT_AUTH_RATE_LIMITS).map(([key, value]) => [
    key,
    'limit' in value ? { ...value, limit: 10_000 } : { ...value, freeFailures: 10_000 },
  ]),
) as unknown as AuthRateLimitSettings;

interface Member {
  userId: string;
  orgId: string;
  cookie: string;
  context: TenantContext;
}

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let app: FastifyInstance;

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

async function newMember(orgId: string = randomUUID()): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  const existing = await superuser.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
  if (!existing) await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  const role = existing ? 'member' : 'owner';
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { userId, orgId, cookie: await login(email), context: { orgId, userId, role } };
}

function call(member: Member | null, method: 'GET' | 'POST', url: string) {
  return app.inject({
    method,
    url,
    headers: { ...sameSiteHeaders, ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}) },
  });
}

async function newJob(member: Member, input: { lockKey?: string; projectId?: string } = {}): Promise<JobRecord> {
  return insertJob(appDb, member.context, { type: 'test-echo', params: { steps: 1 }, ...input });
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
  app = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    { database, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} } },
  );
});

afterAll(async () => {
  await app?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('jobs / job_events 表', () => {
  let a: Member;
  let b: Member;
  let jobA: JobRecord;
  let jobB: JobRecord;

  beforeAll(async () => {
    a = await newMember();
    b = await newMember();
    jobA = await newJob(a);
    jobB = await newJob(b);
  });

  it('未设置上下文：查询返回 0 行，更新影响 0 行，插入被拒绝', async () => {
    expect(await appDb.selectFrom('jobs').selectAll().execute()).toEqual([]);
    expect(await appDb.selectFrom('job_events').selectAll().execute()).toEqual([]);
    const updated = await appDb.updateTable('jobs').set({ progress: 50 }).executeTakeFirst();
    expect(updated.numUpdatedRows).toBe(0n);
    await expect(
      appDb.insertInto('jobs').values({ org_id: a.orgId, user_id: a.userId, type: 'test-echo', params: '{}' }).execute(),
    ).rejects.toThrow(/row-level security/);
  });

  it('组织 A 只看到自己的任务和事件，改不到组织 B 的任务', async () => {
    await withTenant(appDb, a.context, async (trx) => {
      expect(await trx.selectFrom('jobs').select('id').execute()).toEqual([{ id: jobA.id }]);
      const events = await trx.selectFrom('job_events').select(['job_id', 'kind']).execute();
      expect(events).toEqual([{ job_id: jobA.id, kind: 'queued' }]);
      const changed = await trx.updateTable('jobs').set({ status: 'cancelled', finished_at: new Date() }).where('id', '=', jobB.id).executeTakeFirst();
      expect(changed.numUpdatedRows).toBe(0n);
    });
    // 只设置组织（worker 的系统操作）时同样只看得到本组织。
    await withOrgContext(appDb, a.orgId, async (trx) => {
      expect(await trx.selectFrom('jobs').select('id').execute()).toEqual([{ id: jobA.id }]);
    });
    expect((await superuser.selectFrom('jobs').select('status').where('id', '=', jobB.id).executeTakeFirstOrThrow()).status).toBe('queued');
  });

  it.each<[string, (trx: Kysely<Database>) => Promise<unknown>, RegExp]>([
    ['在组织 B 中建任务', (trx) => trx.insertInto('jobs').values({ org_id: b.orgId, user_id: a.userId, type: 'test-echo', params: '{}' }).execute(), /row-level security/],
    ['以别的用户的身份建任务', (trx) => trx.insertInto('jobs').values({ org_id: a.orgId, user_id: b.userId, type: 'test-echo', params: '{}' }).execute(), /row-level security/],
    ['建任务时直接指定状态', (trx) =>
      trx.insertInto('jobs').values({ org_id: a.orgId, user_id: a.userId, type: 'test-echo', params: '{}', status: 'running' } as never).execute(), /permission denied/],
    ['物理删除任务', (trx) => trx.deleteFrom('jobs').where('id', '=', jobA.id).execute(), /permission denied/],
    ['修改任务类型', (trx) => trx.updateTable('jobs').set({ type: 'other' } as never).where('id', '=', jobA.id).execute(), /permission denied/],
    ['修改任务参数', (trx) => trx.updateTable('jobs').set({ params: '{}' } as never).where('id', '=', jobA.id).execute(), /permission denied/],
    ['修改发起用户', (trx) => trx.updateTable('jobs').set({ user_id: b.userId } as never).where('id', '=', jobA.id).execute(), /permission denied/],
    ['修改互斥键', (trx) => trx.updateTable('jobs').set({ lock_key: 'x' } as never).where('id', '=', jobA.id).execute(), /permission denied/],
    ['修改 org_id', (trx) => trx.updateTable('jobs').set({ org_id: b.orgId } as never).where('id', '=', jobA.id).execute(), /permission denied/],
    ['修改任务事件', (trx) => trx.updateTable('job_events').set({ message: 'x' } as never).where('job_id', '=', jobA.id).execute(), /permission denied/],
    ['删除任务事件', (trx) => trx.deleteFrom('job_events').where('job_id', '=', jobA.id).execute(), /permission denied/],
    ['给组织 B 的任务写事件', (trx) => trx.insertInto('job_events').values({ org_id: b.orgId, job_id: jobB.id, kind: 'log', message: 'x' }).execute(), /row-level security/],
    ['把事件挂到组织 B 的任务上', (trx) => trx.insertInto('job_events').values({ org_id: a.orgId, job_id: jobB.id, kind: 'log', message: 'x' }).execute(), /foreign key/],
    ['任务类型名称不合法', (trx) => trx.insertInto('jobs').values({ org_id: a.orgId, user_id: a.userId, type: 'Bad Type', params: '{}' }).execute(), /check constraint/],
    ['参数不是对象', (trx) => trx.insertInto('jobs').values({ org_id: a.orgId, user_id: a.userId, type: 'test-echo', params: '[]' }).execute(), /check constraint/],
    ['参数超过 16 KiB', (trx) =>
      trx.insertInto('jobs').values({ org_id: a.orgId, user_id: a.userId, type: 'test-echo', params: JSON.stringify({ x: 'a'.repeat(17_000) }) }).execute(), /check constraint/],
    ['running 但没有执行者', (trx) => trx.updateTable('jobs').set({ status: 'running' }).where('id', '=', jobA.id).execute(), /check constraint/],
    ['failed 但没有错误代码', (trx) => trx.updateTable('jobs').set({ status: 'failed', finished_at: new Date() }).where('id', '=', jobA.id).execute(), /check constraint/],
    ['进度超过 100', (trx) => trx.updateTable('jobs').set({ progress: 101 }).where('id', '=', jobA.id).execute(), /check constraint/],
  ])('组织 A 的应用角色不能%s', async (_name, write, error) => {
    await expect(withTenant(appDb, a.context, (trx) => write(trx))).rejects.toThrow(error);
    const row = await superuser.selectFrom('jobs').selectAll().where('id', '=', jobA.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: a.orgId, user_id: a.userId, type: 'test-echo', status: 'queued', progress: 0 });
  });

  it('已结束的任务不能再改（JB001）', async () => {
    const job = await newJob(a);
    await withTenant(appDb, a.context, (trx) =>
      trx.updateTable('jobs').set({ status: 'cancelled', finished_at: new Date() }).where('id', '=', job.id).execute(),
    );
    await expect(
      withTenant(appDb, a.context, (trx) => trx.updateTable('jobs').set({ status: 'queued', finished_at: null }).where('id', '=', job.id).execute()),
    ).rejects.toMatchObject({ code: 'JB001' });
  });

  it('互斥：同一组织内 lock_key 相同的未结束任务最多一个；结束后可以再建；不同组织互不影响', async () => {
    const lockKey = `project:${randomUUID()}:technical-plan`;
    const first = await newJob(a, { lockKey });
    await expect(newJob(a, { lockKey })).rejects.toMatchObject({ statusCode: 409, code: 'JOB_LOCKED' });
    await newJob(b, { lockKey });
    // 暂停中的任务仍持有锁。
    await withTenant(appDb, a.context, (trx) => trx.updateTable('jobs').set({ status: 'paused' }).where('id', '=', first.id).execute());
    await expect(newJob(a, { lockKey })).rejects.toMatchObject({ code: 'JOB_LOCKED' });
    await withTenant(appDb, a.context, (trx) =>
      trx.updateTable('jobs').set({ status: 'cancelled', finished_at: new Date() }).where('id', '=', first.id).execute(),
    );
    await newJob(a, { lockKey });
    // 并发入队也只有一个成功（部分唯一索引兜底）。
    const raced = `knowledge-document:${randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => newJob(a, { lockKey: raced })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('project_id：必须是本组织未删除的项目', async () => {
    const projectA = await createProject(a);
    const projectB = await createProject(b);
    expect((await newJob(a, { projectId: projectA })).projectId).toBe(projectA);
    await expect(newJob(a, { projectId: projectB })).rejects.toThrow(/row-level security|foreign key/);
    await withTenant(appDb, a.context, (trx) =>
      trx.updateTable('projects').set({ deleted_at: new Date(), deleted_by: a.userId }).where('id', '=', projectA).execute(),
    );
    await expect(newJob(a, { projectId: projectA })).rejects.toThrow(/row-level security/);
  });

  it('认领：只有 queued 能被认领，同一任务并发认领只有一次成功；组织并发上限之外的延后', async () => {
    const member = await newMember();
    const job = await newJob(member);
    const claim = (runId: string, limit = 3) =>
      claimJob(appDb, { orgId: member.orgId, jobId: job.id, runId, leaseMs: 60_000, orgRunningLimit: limit, attemptsFor: () => 3 });
    const results = await Promise.all(Array.from({ length: 5 }, () => claim(randomUUID())));
    expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'skipped')).toHaveLength(4);
    const other = await newJob(member);
    expect(
      await claimJob(appDb, { orgId: member.orgId, jobId: other.id, runId: randomUUID(), leaseMs: 60_000, orgRunningLimit: 1, attemptsFor: () => 3 }),
    ).toEqual({ kind: 'deferred' });
    expect((await superuser.selectFrom('jobs').select('status').where('id', '=', other.id).executeTakeFirstOrThrow()).status).toBe('queued');
  });
});

describe('跨组织对账函数 jobs_dispatch_candidates', () => {
  it('只返回 id、组织 id 和入队时间：queued 与租约过期的 running / cancelling，不含 paused、租约有效的和已结束的', async () => {
    const a = await newMember();
    const b = await newMember();
    const queued = await newJob(a);
    const queuedB = await newJob(b);
    const paused = await newJob(a);
    const live = await newJob(a);
    const expired = await newJob(b);
    const finished = await newJob(b);
    await superuser.updateTable('jobs').set({ status: 'paused' }).where('id', '=', paused.id).execute();
    await superuser
      .updateTable('jobs')
      .set({ status: 'running', run_id: randomUUID(), lease_expires_at: sql`now() + interval '1 minute'` })
      .where('id', '=', live.id)
      .execute();
    await superuser
      .updateTable('jobs')
      .set({ status: 'cancelling', run_id: randomUUID(), lease_expires_at: sql`now() - interval '1 second'` })
      .where('id', '=', expired.id)
      .execute();
    await superuser.updateTable('jobs').set({ status: 'succeeded', finished_at: new Date() }).where('id', '=', finished.id).execute();

    const all: string[] = [];
    let after: { cursor: string; id: string } | null = null;
    for (;;) {
      const page = await listDispatchCandidates(appDb, after, 2);
      all.push(...page.map((candidate) => candidate.id));
      if (page.length < 2) break;
      after = { cursor: page.at(-1)!.cursor, id: page.at(-1)!.id };
    }
    expect(all).toEqual(expect.arrayContaining([queued.id, queuedB.id, expired.id]));
    expect(all).not.toContain(paused.id);
    expect(all).not.toContain(live.id);
    expect(all).not.toContain(finished.id);
    expect(new Set(all).size).toBe(all.length);

    const { rows } = await sql<Record<string, unknown>>`SELECT * FROM jobs_dispatch_candidates(NULL, NULL, 1)`.execute(appDb);
    expect(Object.keys(rows[0]!).sort()).toEqual(['created_at', 'id', 'org_id']);
  });

  it('属主是 bidtools_jobs（SECURITY DEFINER、固定 search_path），只授权给应用角色；属主只能读 jobs 的几列', async () => {
    const { rows } = await sql<{ owner: string; secdef: boolean; config: string[] | null }>`
      SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS secdef, proconfig AS config FROM pg_proc
      WHERE proname = 'jobs_dispatch_candidates'`.execute(superuser);
    expect(rows).toEqual([{ owner: JOBS_ROLE, secdef: true, config: ['search_path=pg_catalog, pg_temp'] }]);
    const privileges = await sql<{ grantee: string }>`
      SELECT grantee FROM information_schema.routine_privileges
      WHERE routine_name = 'jobs_dispatch_candidates' AND privilege_type = 'EXECUTE' ORDER BY grantee`.execute(superuser);
    expect(privileges.rows.map((row) => row.grantee).sort()).toEqual([APP_ROLE, JOBS_ROLE].sort());

    const attributes = await sql<Record<string, boolean>>`
      SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = ${JOBS_ROLE}`.execute(superuser);
    expect(attributes.rows).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false }]);

    const columns = await sql<{ column_name: string; privilege_type: string }>`
      SELECT column_name, privilege_type FROM information_schema.column_privileges
      WHERE grantee = ${JOBS_ROLE} AND table_name = 'jobs' ORDER BY column_name`.execute(superuser);
    expect(columns.rows).toEqual(['created_at', 'id', 'lease_expires_at', 'org_id', 'status'].map((column_name) => ({ column_name, privilege_type: 'SELECT' })));
    const tables = await sql<{ table: string; any: boolean }>`
      SELECT c.relname AS table,
             has_table_privilege(${JOBS_ROLE}, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
             OR has_any_column_privilege(${JOBS_ROLE}, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') AS any
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE 'kysely\\_%'`.execute(superuser);
    expect(tables.rows.filter((row) => row.any).map((row) => row.table)).toEqual(['jobs']);
  });
});

describe('/api/jobs', () => {
  let a: Member;
  let a2: Member;
  let b: Member;

  beforeAll(async () => {
    a = await newMember();
    a2 = await newMember(a.orgId);
    b = await newMember();
  });

  it('未登录返回 401；jobId 格式不对返回 400', async () => {
    expect((await call(null, 'GET', '/api/jobs')).statusCode).toBe(401);
    expect((await call(null, 'POST', `/api/jobs/${randomUUID()}/cancel`)).statusCode).toBe(401);
    expect((await call(a, 'GET', '/api/jobs/not-a-uuid')).statusCode).toBe(400);
  });

  it('列出本组织的任务（组织内共享），不含参数和 checkpoint；可按项目、是否结束筛选', async () => {
    const project = await createProject(a);
    const mine = await newJob(a, { projectId: project });
    const colleague = await newJob(a2);
    const foreign = await newJob(b);
    const response = await call(a, 'GET', '/api/jobs');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const ids = response.json().jobs.map((job: { id: string }) => job.id);
    expect(ids).toEqual(expect.arrayContaining([mine.id, colleague.id]));
    expect(ids).not.toContain(foreign.id);
    const body = response.json().jobs.find((job: { id: string }) => job.id === mine.id);
    expect(body).toEqual({
      id: mine.id,
      type: 'test-echo',
      projectId: project,
      status: 'queued',
      pauseRequested: false,
      progress: 0,
      attempt: 0,
      error: null,
      createdBy: a.userId,
      createdAt: mine.createdAt.toISOString(),
      updatedAt: mine.updatedAt.toISOString(),
      startedAt: null,
      finishedAt: null,
    });

    const byProject = await call(a, 'GET', `/api/jobs?projectId=${project}`);
    expect(byProject.json().jobs.map((job: { id: string }) => job.id)).toEqual([mine.id]);
    expect((await call(a, 'GET', '/api/jobs?active=false')).json().jobs.map((job: { id: string }) => job.id)).not.toContain(mine.id);
    // 别的组织的项目与不存在的一样返回 404。
    const foreignProject = await createProject(b);
    expect((await call(a, 'GET', `/api/jobs?projectId=${foreignProject}`)).statusCode).toBe(404);
  });

  it('查看任务详情含事件；其他组织的任务返回 404', async () => {
    const job = await newJob(a);
    const response = await call(a2, 'GET', `/api/jobs/${job.id.toUpperCase()}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: job.id, status: 'queued', events: [{ kind: 'queued', message: null }] });
    expect(response.json()).not.toHaveProperty('params');
    expect((await call(b, 'GET', `/api/jobs/${job.id}`)).statusCode).toBe(404);
  });

  it('取消：排队中的立即取消；执行中的进入 cancelling；已结束的返回 409；其他组织的返回 404；需要通过跨站校验', async () => {
    const queued = await newJob(a);
    expect((await call(b, 'POST', `/api/jobs/${queued.id}/cancel`)).statusCode).toBe(404);
    const noCsrf = await app.inject({ method: 'POST', url: `/api/jobs/${queued.id}/cancel`, headers: { cookie: `__Host-session=${a.cookie}` } });
    expect(noCsrf.statusCode).toBe(403);
    const cancelled = await call(a2, 'POST', `/api/jobs/${queued.id}/cancel`);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
    expect((await call(a, 'POST', `/api/jobs/${queued.id}/cancel`)).json()).toMatchObject({ error: { code: 'JOB_FINISHED' } });

    const running = await newJob(a);
    await superuser
      .updateTable('jobs')
      .set({ status: 'running', run_id: randomUUID(), lease_expires_at: sql`now() + interval '1 minute'` })
      .where('id', '=', running.id)
      .execute();
    const response = await call(a, 'POST', `/api/jobs/${running.id}/cancel`);
    expect(response.json()).toMatchObject({ status: 'cancelling' });
    expect((await call(a, 'GET', `/api/jobs/${running.id}`)).json().events.map((event: { kind: string }) => event.kind)).toEqual([
      'queued',
      'cancel-requested',
    ]);
  });
});
