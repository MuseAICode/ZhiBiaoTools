// Agent 任务上限按组织覆盖（迁移 0035_agent_job_limit_overrides、src/agent/limitOverrides.ts、/api/admin/agent-limits，
// 路线图第 8 步 8.3c）：
// - 入队：有覆盖值时写入覆盖值（“一份”额度随之取覆盖值，确认继续时按覆盖值加一份），没有时取起步值；覆盖只对本组织、本任务类型生效；
//   只影响之后入队的任务；删除后恢复起步值；
// - 权限：只有平台管理员能设置、删除、跨组织列出（接口与数据库函数各检查一次）；组织成员（含 owner）不能经函数或直接写表
//   改自己的上限，只能读本组织的覆盖值；没有用户上下文的连接同样被拒绝；
// - 接口：密码二次验证、任务类型必须是已登记的 Agent 任务类型、范围、金额只接受字符串、轮数只接受 JSON 整数、组织不存在、日志不含密码；
// - 回滚 0035：已入队任务的上限保留，之后再升级成功。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS, type AgentTaskLimits } from '../../src/agent/budget.ts';
import { deleteAgentLimitOverride, listAgentLimitOverrides, setAgentLimitOverride } from '../../src/agent/limitOverrides.ts';
import { buildApp } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { AGENT_BUDGET_MAX_COST_LIMIT, AGENT_BUDGET_MAX_TURN_LIMIT } from '../../src/db/migrations/0033_agent_job_budgets.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database, MemberRole } from '../../src/db/schema.ts';
import { withOrgContext, withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import { createJobTypeRegistry, type JobTypeRegistry } from '../../src/jobs/definitions.ts';
import { claimJob, finishRun } from '../../src/jobs/store.ts';
import { confirmJobTaskLimit, enqueueJob, type JobServiceDependencies } from '../../src/jobs/service.ts';
import { createLogCapture, fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { testLogger } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const ADMIN_PASSWORD = 'tidy-orbit-lantern-42';
const USER_PASSWORD = 'brisk-meadow-copper-77';

const RELAXED_LIMITS: AuthRateLimitSettings = Object.fromEntries(
  Object.entries(DEFAULT_AUTH_RATE_LIMITS).map(([key, value]) => [
    key,
    'limit' in value ? { ...value, limit: 10_000 } : { ...value, freeFailures: 10_000 },
  ]),
) as unknown as AuthRateLimitSettings;

const DEFAULTS = AGENT_TASK_LIMITS.outline;
const OTHER_DEFAULTS = AGENT_TASK_LIMITS.templateExtraction;
const OVERRIDE = { costLimit: 123_456n, turnLimit: 7 } satisfies AgentTaskLimits;

const noop = async () => {};
const params = (raw: unknown) => raw as Record<string, unknown>;
const registry: JobTypeRegistry = createJobTypeRegistry([
  { type: 'test-agent-outline', queue: 'agent', resumable: true, billable: true, agentLimits: DEFAULTS, parseParams: params, run: noop },
  { type: 'test-agent-template', queue: 'agent', resumable: true, billable: true, agentLimits: OTHER_DEFAULTS, parseParams: params, run: noop },
  { type: 'test-plain', queue: 'ai', resumable: true, parseParams: params, run: noop },
]);

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let app: FastifyInstance;
let logs: ReturnType<typeof createLogCapture>;
let adminCookie: string;
let ownerCookie: string;

const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };
let customer: TenantContext;
let customerEmail: string;

const offline = (): JobServiceDependencies => ({ db: appDb, registry, dispatcher: null, log: testLogger().log });

async function seedUser(orgId: string, role: MemberRole, options: { platformAdmin?: boolean; userId?: string } = {}) {
  const hasher = await fastHasher();
  const userId = options.userId ?? randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('users').values({
    id: userId, email, password_hash: await hasher.hash(options.platformAdmin ? ADMIN_PASSWORD : USER_PASSWORD), email_verified_at: new Date(),
    is_platform_admin: options.platformAdmin ?? false,
  }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { context: { orgId, userId, role } satisfies TenantContext, email };
}

async function newOrg(): Promise<{ context: TenantContext; email: string }> {
  const orgId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: 10_000_000n, reference: null, note: '测试充值' });
  return seedUser(orgId, 'owner');
}

async function login(email: string, password: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

function request(method: 'GET' | 'PUT' | 'DELETE', url: string, cookie: string, payload?: object): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, headers: { ...sameSiteHeaders, cookie: `__Host-session=${cookie}` }, ...(payload ? { payload } : {}) });
}

const putBody = (overrides: Record<string, unknown> = {}) => ({
  costLimit: OVERRIDE.costLimit.toString(),
  turnLimit: OVERRIDE.turnLimit,
  note: '大客户',
  password: ADMIN_PASSWORD,
  ...overrides,
});

async function enqueueAgent(ctx: TenantContext, type = 'test-agent-outline'): Promise<string> {
  const job = await enqueueJob(offline(), ctx, { type, params: {} });
  return job.id;
}

async function budgetRow(jobId: string) {
  return superuser.selectFrom('agent_job_budgets').selectAll().where('job_id', '=', jobId).executeTakeFirstOrThrow();
}

async function overrideRows(orgId: string) {
  return superuser.selectFrom('agent_job_limit_overrides').selectAll().where('org_id', '=', orgId).orderBy('job_type').execute();
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `应当失败：${code}`).not.toBeNull();
  const actual = error instanceof AppError ? error.code : (error as { code?: unknown }).code;
  expect(actual).toBe(code);
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
  await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
  const admin = await seedUser(platformOrg, 'owner', { platformAdmin: true, userId: platformAdmin });
  ({ context: customer, email: customerEmail } = await newOrg());
  logs = createLogCapture();
  app = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    { database, logStream: logs.stream, passwordHasher: await fastHasher(), rateLimits: RELAXED_LIMITS, mailer: { send: async () => {} }, jobTypeRegistry: registry },
  );
  adminCookie = await login(admin.email, ADMIN_PASSWORD);
  ownerCookie = await login(customerEmail, USER_PASSWORD);
});

afterAll(async () => {
  await app?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('入队时取覆盖值', () => {
  it('没有覆盖值时取起步值（对照组）', async () => {
    const { context } = await newOrg();
    const row = await budgetRow(await enqueueAgent(context));
    expect(row).toMatchObject({ cost_limit: DEFAULTS.costLimit.toString(), turn_limit: DEFAULTS.turnLimit });
  });

  it('有覆盖值时写入覆盖值，“一份”额度随之取覆盖值；只对本组织、本任务类型生效', async () => {
    const { context } = await newOrg();
    const { context: other } = await newOrg();
    await setAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline', limits: OVERRIDE, note: null });

    const overridden = await budgetRow(await enqueueAgent(context));
    expect(overridden).toMatchObject({
      cost_limit: OVERRIDE.costLimit.toString(), turn_limit: OVERRIDE.turnLimit,
      cost_step: OVERRIDE.costLimit.toString(), turn_step: OVERRIDE.turnLimit,
    });
    // 同组织的另一个 Agent 任务类型、另一个组织的同一类型都不受影响。
    expect(await budgetRow(await enqueueAgent(context, 'test-agent-template'))).toMatchObject({
      cost_limit: OTHER_DEFAULTS.costLimit.toString(), turn_limit: OTHER_DEFAULTS.turnLimit,
    });
    expect(await budgetRow(await enqueueAgent(other))).toMatchObject({ cost_limit: DEFAULTS.costLimit.toString(), turn_limit: DEFAULTS.turnLimit });
  });

  it('只影响之后入队的任务；修改与删除后，之后的任务取新值 / 起步值，已入队的不变', async () => {
    const { context } = await newOrg();
    const before = await enqueueAgent(context);
    await setAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline', limits: OVERRIDE, note: null });
    const during = await enqueueAgent(context);
    await setAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline', limits: { costLimit: 9_999n, turnLimit: 2 }, note: null });
    const changed = await enqueueAgent(context);
    expect(await deleteAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline' })).toBe(true);
    expect(await deleteAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline' })).toBe(false);
    const after = await enqueueAgent(context);

    expect(await budgetRow(before)).toMatchObject({ cost_limit: DEFAULTS.costLimit.toString(), turn_limit: DEFAULTS.turnLimit });
    expect(await budgetRow(during)).toMatchObject({ cost_limit: OVERRIDE.costLimit.toString(), turn_limit: OVERRIDE.turnLimit });
    expect(await budgetRow(changed)).toMatchObject({ cost_limit: '9999', turn_limit: 2 });
    expect(await budgetRow(after)).toMatchObject({ cost_limit: DEFAULTS.costLimit.toString(), turn_limit: DEFAULTS.turnLimit });
  });

  it('确认继续时按覆盖值加一份；之后再修改覆盖值不影响该任务的一份额度', async () => {
    const { context } = await newOrg();
    await setAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline', limits: OVERRIDE, note: null });
    const jobId = await enqueueAgent(context);
    await setAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline', limits: { costLimit: 1n, turnLimit: 1 }, note: null });
    const run = { orgId: context.orgId, jobId, runId: randomUUID() };
    const claim = await claimJob(appDb, { ...run, leaseMs: 60_000, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 });
    expect(claim.kind).toBe('claimed');
    expect(await finishRun(appDb, run, { kind: 'task-limit', reason: 'task_turn_limit' }, true)).toBe('paused');
    await confirmJobTaskLimit(offline(), context, jobId);
    expect(await budgetRow(jobId)).toMatchObject({
      cost_limit: (OVERRIDE.costLimit * 2n).toString(), turn_limit: OVERRIDE.turnLimit * 2, confirmations: 1,
    });
  });
});

describe('权限（数据库）', () => {
  it('组织成员（含 owner）经函数设置、删除、列出一律 42501，表不变', async () => {
    const { context } = await newOrg();
    await setAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline', limits: OVERRIDE, note: null });
    const snapshot = await overrideRows(context.orgId);
    await expectCode(setAgentLimitOverride(appDb, context, { orgId: context.orgId, jobType: 'test-agent-outline', limits: { costLimit: AGENT_BUDGET_MAX_COST_LIMIT, turnLimit: AGENT_BUDGET_MAX_TURN_LIMIT }, note: null }), 'FORBIDDEN');
    await expectCode(setAgentLimitOverride(appDb, context, { orgId: context.orgId, jobType: 'test-agent-template', limits: OVERRIDE, note: null }), 'FORBIDDEN');
    await expectCode(deleteAgentLimitOverride(appDb, context, { orgId: context.orgId, jobType: 'test-agent-outline' }), 'FORBIDDEN');
    await expectCode(listAgentLimitOverrides(appDb, context, context.orgId), 'FORBIDDEN');
    // 没有用户上下文（worker 的系统操作）同样被拒绝。
    await expectCode(
      withOrgContext(appDb, context.orgId, (trx) => sql`SELECT * FROM agent_admin_set_limit_override(${context.orgId}::uuid, 'test-agent-outline', 1::bigint, 1, null)`.execute(trx)),
      '42501',
    );
    expect(await overrideRows(context.orgId)).toEqual(snapshot);
  });

  it('应用角色不能直接写表（没有写授权），只能读本组织的覆盖值', async () => {
    const { context } = await newOrg();
    const { context: other } = await newOrg();
    await setAgentLimitOverride(appDb, ctxAdmin, { orgId: other.orgId, jobType: 'test-agent-outline', limits: OVERRIDE, note: '另一组织' });
    await setAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline', limits: OVERRIDE, note: null });

    const tenant = <T>(run: (trx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) => withTenant(appDb, context, run);
    await expectCode(
      tenant((trx) => sql`INSERT INTO agent_job_limit_overrides (org_id, job_type, cost_limit, turn_limit, created_by, updated_by)
        VALUES (${context.orgId}::uuid, 'test-agent-template', 1, 1, ${context.userId}::uuid, ${context.userId}::uuid)`.execute(trx)),
      '42501',
    );
    await expectCode(tenant((trx) => sql`UPDATE agent_job_limit_overrides SET turn_limit = 1000000`.execute(trx)), '42501');
    await expectCode(tenant((trx) => sql`DELETE FROM agent_job_limit_overrides`.execute(trx)), '42501');

    const visible = await tenant((trx) => trx.selectFrom('agent_job_limit_overrides').select(['org_id', 'job_type']).execute());
    expect(visible).toEqual([{ org_id: context.orgId, job_type: 'test-agent-outline' }]);
    expect(await overrideRows(other.orgId)).toHaveLength(1);
  });

  it('函数检查范围与组织：超出范围 22023、组织不存在 404，表的 CHECK 兜底', async () => {
    await expectCode(setAgentLimitOverride(appDb, ctxAdmin, { orgId: customer.orgId, jobType: 'test-agent-outline', limits: { costLimit: AGENT_BUDGET_MAX_COST_LIMIT + 1n, turnLimit: 1 }, note: null }), 'BAD_REQUEST');
    await expectCode(setAgentLimitOverride(appDb, ctxAdmin, { orgId: customer.orgId, jobType: 'test-agent-outline', limits: { costLimit: 1n, turnLimit: 0 }, note: null }), 'BAD_REQUEST');
    await expectCode(setAgentLimitOverride(appDb, ctxAdmin, { orgId: customer.orgId, jobType: 'Bad Type', limits: OVERRIDE, note: null }), 'BAD_REQUEST');
    await expectCode(setAgentLimitOverride(appDb, ctxAdmin, { orgId: randomUUID(), jobType: 'test-agent-outline', limits: OVERRIDE, note: null }), 'ORGANIZATION_NOT_FOUND');
    await expectCode(listAgentLimitOverrides(appDb, ctxAdmin, randomUUID()), 'ORGANIZATION_NOT_FOUND');
    await expectCode(
      superuser.insertInto('agent_job_limit_overrides').values({
        org_id: customer.orgId, job_type: 'test-agent-outline', cost_limit: (AGENT_BUDGET_MAX_COST_LIMIT + 1n).toString(), turn_limit: 1,
        created_by: platformAdmin, updated_by: platformAdmin,
      }).execute(),
      '23514',
    );
  });

  it('硬上限（10,000 元 / 1,000,000 次）由数据库强制：函数与表的 CHECK 各拦一次，含 UPDATE；边界值可以写入（对照组）', async () => {
    const { context } = await newOrg();
    const MAX = { costLimit: AGENT_BUDGET_MAX_COST_LIMIT, turnLimit: AGENT_BUDGET_MAX_TURN_LIMIT } satisfies AgentTaskLimits;
    const set = (limits: AgentTaskLimits) => setAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline', limits, note: null });

    // 函数：任一项超出 1 都拒绝，表不变。
    await expectCode(set({ costLimit: MAX.costLimit + 1n, turnLimit: MAX.turnLimit }), 'BAD_REQUEST');
    await expectCode(set({ costLimit: MAX.costLimit, turnLimit: MAX.turnLimit + 1 }), 'BAD_REQUEST');
    expect(await overrideRows(context.orgId)).toEqual([]);

    // 对照组：恰好等于硬上限可以写入，入队时写入的也是硬上限。
    expect(await set(MAX)).toMatchObject(MAX);
    const jobId = await enqueueAgent(context);
    expect(await budgetRow(jobId)).toMatchObject({ cost_limit: MAX.costLimit.toString(), turn_limit: MAX.turnLimit });

    // 表的 CHECK：绕过函数与 RLS（超级用户）直接写，INSERT 与 UPDATE 都被拒绝。
    const insert = (cost: bigint, turn: number) =>
      superuser.insertInto('agent_job_limit_overrides').values({
        org_id: context.orgId, job_type: 'test-agent-template', cost_limit: cost.toString(), turn_limit: turn,
        created_by: platformAdmin, updated_by: platformAdmin,
      }).execute();
    await expectCode(insert(MAX.costLimit + 1n, 1), '23514');
    await expectCode(insert(1n, MAX.turnLimit + 1), '23514');
    const update = (values: { cost_limit?: string; turn_limit?: number }) =>
      superuser.updateTable('agent_job_limit_overrides').set(values).where('org_id', '=', context.orgId).execute();
    await expectCode(update({ cost_limit: (MAX.costLimit + 1n).toString() }), '23514');
    await expectCode(update({ turn_limit: MAX.turnLimit + 1 }), '23514');
    expect(await overrideRows(context.orgId)).toEqual([expect.objectContaining({ cost_limit: MAX.costLimit.toString(), turn_limit: MAX.turnLimit })]);

    // 覆盖值等于硬上限时，确认继续再加一份会超出硬上限：409，上限不变。
    const run = { orgId: context.orgId, jobId, runId: randomUUID() };
    expect((await claimJob(appDb, { ...run, leaseMs: 60_000, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 })).kind).toBe('claimed');
    expect(await finishRun(appDb, run, { kind: 'task-limit', reason: 'task_turn_limit' }, true)).toBe('paused');
    await expectCode(confirmJobTaskLimit(offline(), context, jobId), 'TASK_LIMIT_MAX_REACHED');
    expect(await budgetRow(jobId)).toMatchObject({ cost_limit: MAX.costLimit.toString(), turn_limit: MAX.turnLimit, confirmations: 0 });
  });
});

describe('/api/admin/agent-limits', () => {
  it('平台管理员设置、列出、删除；记下操作人；日志不含密码', async () => {
    const { context } = await newOrg();
    const base = `/api/admin/agent-limits/${context.orgId}`;
    const put = await request('PUT', `${base}/test-agent-outline`, adminCookie, putBody());
    expect(put.statusCode, put.body).toBe(200);
    expect(put.headers['cache-control']).toBe('no-store');
    expect(put.json().override).toMatchObject({ jobType: 'test-agent-outline', costLimit: OVERRIDE.costLimit.toString(), turnLimit: OVERRIDE.turnLimit, note: '大客户', updatedBy: platformAdmin });

    const list = await request('GET', base, adminCookie);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({
      jobTypes: [
        { jobType: 'test-agent-outline', costLimit: DEFAULTS.costLimit.toString(), turnLimit: DEFAULTS.turnLimit },
        { jobType: 'test-agent-template', costLimit: OTHER_DEFAULTS.costLimit.toString(), turnLimit: OTHER_DEFAULTS.turnLimit },
      ],
      overrides: [expect.objectContaining({ jobType: 'test-agent-outline', costLimit: OVERRIDE.costLimit.toString(), turnLimit: OVERRIDE.turnLimit })],
    });
    expect(await budgetRow(await enqueueAgent(context))).toMatchObject({ cost_limit: OVERRIDE.costLimit.toString(), turn_limit: OVERRIDE.turnLimit });

    const removed = await request('DELETE', `${base}/test-agent-outline`, adminCookie, { password: ADMIN_PASSWORD });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await overrideRows(context.orgId)).toEqual([]);
    const again = await request('DELETE', `${base}/test-agent-outline`, adminCookie, { password: ADMIN_PASSWORD });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('AGENT_LIMIT_OVERRIDE_NOT_FOUND');

    expect(logs.text()).toContain('agent limit override set');
    expect(logs.text()).toContain('agent limit override deleted');
    expect(logs.text()).not.toContain(ADMIN_PASSWORD);
  });

  it('组织 owner 不能设置、删除、列出自己组织的上限（403），表不变', async () => {
    const base = `/api/admin/agent-limits/${customer.orgId}`;
    for (const response of [
      await request('PUT', `${base}/test-agent-outline`, ownerCookie, putBody({ password: USER_PASSWORD })),
      await request('DELETE', `${base}/test-agent-outline`, ownerCookie, { password: USER_PASSWORD }),
      await request('GET', base, ownerCookie),
    ]) {
      expect(response.statusCode, response.body).toBe(403);
    }
    expect(await overrideRows(customer.orgId)).toEqual([]);
  });

  it('请求校验：密码错误、未登记或非 Agent 的任务类型、超出范围、金额为 JSON 数字、轮数为字符串、组织不存在', async () => {
    const base = `/api/admin/agent-limits/${customer.orgId}`;
    const cases: [LightMyRequestResponse, number, string][] = [
      [await request('PUT', `${base}/test-agent-outline`, adminCookie, putBody({ password: 'wrong-password' })), 400, 'INVALID_PASSWORD'],
      [await request('PUT', `${base}/test-plain`, adminCookie, putBody()), 404, 'AGENT_JOB_TYPE_NOT_FOUND'],
      [await request('PUT', `${base}/not-registered`, adminCookie, putBody()), 404, 'AGENT_JOB_TYPE_NOT_FOUND'],
      [await request('PUT', `${base}/test-agent-outline`, adminCookie, putBody({ costLimit: (AGENT_BUDGET_MAX_COST_LIMIT + 1n).toString() })), 400, 'AGENT_LIMIT_OUT_OF_RANGE'],
      [await request('PUT', `${base}/test-agent-outline`, adminCookie, putBody({ costLimit: 123456 })), 400, 'INVALID_AMOUNT'],
      [await request('PUT', `${base}/test-agent-outline`, adminCookie, putBody({ costLimit: '0' })), 400, 'BAD_REQUEST'],
      [await request('PUT', `${base}/test-agent-outline`, adminCookie, putBody({ turnLimit: '7' })), 400, 'INVALID_TURN_LIMIT'],
      [await request('PUT', `${base}/test-agent-outline`, adminCookie, putBody({ turnLimit: AGENT_BUDGET_MAX_TURN_LIMIT + 1 })), 400, 'BAD_REQUEST'],
      [await request('PUT', `${base}/test-agent-outline`, adminCookie, putBody({ turnLimit: 1.5 })), 400, 'BAD_REQUEST'],
      [await request('PUT', `${base}/test-agent-outline`, adminCookie, putBody({ orgId: randomUUID() })), 400, 'BAD_REQUEST'],
      [await request('PUT', `/api/admin/agent-limits/${randomUUID()}/test-agent-outline`, adminCookie, putBody()), 404, 'ORGANIZATION_NOT_FOUND'],
      [await request('GET', `/api/admin/agent-limits/${randomUUID()}`, adminCookie), 404, 'ORGANIZATION_NOT_FOUND'],
      [await request('DELETE', `${base}/test-agent-outline`, adminCookie, { password: 'wrong-password' }), 400, 'INVALID_PASSWORD'],
    ];
    for (const [response, status, code] of cases) {
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json().error.code, response.body).toBe(code);
    }
    expect(await overrideRows(customer.orgId)).toEqual([]);
  });
});

describe('回滚 0035', () => {
  it('已入队任务的上限保留，之后再升级成功', async () => {
    const { context } = await newOrg();
    await setAgentLimitOverride(appDb, ctxAdmin, { orgId: context.orgId, jobType: 'test-agent-outline', limits: OVERRIDE, note: null });
    const jobId = await enqueueAgent(context);
    const owner = connect(testDb.ownerConfig);
    try {
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0040_agent_workspace_snapshots']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0039_agent_questions']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0038_agent_failure_reports']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0037_agent_tool_calls']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0036_agent_job_runs']);
      const down = await migrateDown(owner);
      expect(down.error).toBeUndefined();
      expect(down.results?.map((result) => result.migrationName)).toEqual(['0035_agent_job_limit_overrides']);
      expect(await budgetRow(jobId)).toMatchObject({ cost_limit: OVERRIDE.costLimit.toString(), turn_limit: OVERRIDE.turnLimit });
      expect((await migrateToLatest(owner)).error).toBeUndefined();
    } finally {
      await owner.destroy();
    }
    expect(await budgetRow(await enqueueAgent(context))).toMatchObject({ cost_limit: DEFAULTS.costLimit.toString(), turn_limit: DEFAULTS.turnLimit });
  });
});
