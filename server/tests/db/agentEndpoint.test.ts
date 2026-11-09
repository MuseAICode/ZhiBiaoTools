// worker 的 Agent 内部入口（src/agent/endpoint.ts，路线图第 8 步 8.2b）的数据库测试，以及经 agent-gw 转发的端到端用例：
// 每个请求按令牌重新查身份（令牌失效后下一个请求立即 401，不缓存），各种无效令牌一律 401 且不区分原因，
// 请求中自称的组织、任务等字段不影响结果，响应不返回内部标识，日志中没有令牌原文。
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import { buildAgentGateway } from '../../src/agent/gateway.ts';
import { generateAgentToken } from '../../src/agent/token.ts';
import { issueAgentJobToken, revokeAgentJobTokens } from '../../src/agent/tokenStore.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { claimJob, insertJob, requestCancel, requestPause, type RunRef } from '../../src/jobs/store.ts';
import { createLogCapture } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let endpoint: FastifyInstance;
let endpointOrigin: string;
let gateway: FastifyInstance;
let gatewayOrigin: string;
const endpointLogs = createLogCapture();
const gatewayLogs = createLogCapture();

interface Member {
  orgId: string;
  userId: string;
  context: TenantContext;
}

async function newMember(): Promise<Member> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: 'x', email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, userId, context: { orgId, userId, role: 'owner' } };
}

async function runningJob(member: Member): Promise<RunRef> {
  const project = await withTenant(appDb, member.context, (trx) =>
    trx.insertInto('projects').values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId }).returning('id').executeTakeFirstOrThrow(),
  );
  const job = await insertJob(appDb, member.context, { type: 'test-agent', params: {}, projectId: project.id });
  const runId = randomUUID();
  const result = await claimJob(appDb, { orgId: member.orgId, jobId: job.id, runId, leaseMs: LEASE_MS, orgRunningLimit: 100, attemptsFor: () => 5 });
  expect(result.kind).toBe('claimed');
  return { orgId: member.orgId, jobId: job.id, runId };
}

async function issue(run: RunRef): Promise<string> {
  const issued = await issueAgentJobToken(appDb, run, TTL_MS);
  expect(issued).not.toBeNull();
  return issued!.token;
}

async function get(origin: string, token: string | null, init: { path?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${origin}${init.path ?? '/v1/session'}`, {
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...init.headers },
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
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
  endpoint = await buildAgentEndpointApp({ db: appDb, logLevel: 'info', logStream: endpointLogs.stream });
  await endpoint.listen({ host: '127.0.0.1', port: 0 });
  endpointOrigin = `http://127.0.0.1:${(endpoint.server.address() as AddressInfo).port}`;
  gateway = await buildAgentGateway({ upstream: endpointOrigin, logLevel: 'info', logStream: gatewayLogs.stream });
  await gateway.listen({ host: '127.0.0.1', port: 0 });
  gatewayOrigin = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway?.close();
  await endpoint?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('按令牌查身份', () => {
  it('对照组：有效令牌 → 200，只返回到期时间，不返回组织、项目、用户等标识', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    const token = await issue(run);
    const response = await get(endpointOrigin, token);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['expiresAt', 'status']);
    expect(response.body.status).toBe('active');
    expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const text = JSON.stringify(response.body);
    for (const id of [member.orgId, member.userId, run.jobId, run.runId]) expect(text).not.toContain(id);
  });

  it.each([
    ['缺失', null],
    ['格式不对', 'not-a-token'],
    ['格式正确但不存在', generateAgentToken()],
  ])('%s → 401', async (_name, token) => {
    const response = await get(endpointOrigin, token);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('AGENT_TOKEN_INVALID');
  });

  it('不缓存身份：作废、请求暂停、取消后，下一个请求立即 401（与“不存在”的响应相同）', async () => {
    const member = await newMember();
    const unknown = await get(endpointOrigin, generateAgentToken());

    const revoked = await runningJob(member);
    const revokedToken = await issue(revoked);
    expect((await get(endpointOrigin, revokedToken)).status).toBe(200);
    await revokeAgentJobTokens(appDb, revoked);
    const afterRevoke = await get(endpointOrigin, revokedToken);
    expect(afterRevoke.status).toBe(401);
    expect({ ...afterRevoke.body.error, requestId: null }).toEqual({ ...unknown.body.error, requestId: null });

    const paused = await runningJob(member);
    const pausedToken = await issue(paused);
    expect((await get(endpointOrigin, pausedToken)).status).toBe(200);
    await requestPause(appDb, member.context, paused.jobId);
    expect((await get(endpointOrigin, pausedToken)).status).toBe(401);

    const cancelled = await runningJob(member);
    const cancelledToken = await issue(cancelled);
    expect((await get(endpointOrigin, cancelledToken)).status).toBe(200);
    await requestCancel(appDb, member.context, cancelled.jobId);
    expect((await get(endpointOrigin, cancelledToken)).status).toBe(401);
  });

  it('发起人被移出组织后立即 401', async () => {
    const member = await newMember();
    const token = await issue(await runningJob(member));
    expect((await get(endpointOrigin, token)).status).toBe(200);
    await superuser.deleteFrom('org_memberships').where('org_id', '=', member.orgId).where('user_id', '=', member.userId).execute();
    expect((await get(endpointOrigin, token)).status).toBe(401);
  });

  it('自称的组织、任务、用户头部与查询串不影响结果：另一个组织的有效令牌只代表它自己的任务', async () => {
    const a = await newMember();
    const b = await newMember();
    const tokenB = await issue(await runningJob(b));
    const forged = { 'x-org-id': a.orgId, 'x-user-id': a.userId, 'x-job-id': randomUUID() };
    const ok = await get(endpointOrigin, tokenB, { headers: forged, path: `/v1/session?org_id=${a.orgId}` });
    expect(ok.status).toBe(200);
    const log = endpointLogs.lines().filter((line) => line.msg === 'agent endpoint request').at(-1)!;
    expect(log.jobId).not.toBe(forged['x-job-id']);
    // 没有令牌时，自称身份的头部不能代替令牌。
    expect((await get(endpointOrigin, null, { headers: forged })).status).toBe(401);
  });

  it('有效令牌访问未登记的路径 → 404', async () => {
    const token = await issue(await runningJob(await newMember()));
    expect((await get(endpointOrigin, token, { path: '/v1/admin' })).status).toBe(404);
  });
});

describe('经 agent-gw 转发（端到端）', () => {
  it('对照组：有效令牌经 agent-gw → worker → 数据库查出身份', async () => {
    const token = await issue(await runningJob(await newMember()));
    const response = await get(gatewayOrigin, token);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('active');
  });

  it('格式正确但无效的令牌经 agent-gw 转给 worker，由 worker 拒绝（401）', async () => {
    const response = await get(gatewayOrigin, generateAgentToken());
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('AGENT_TOKEN_INVALID');
  });

  it('作废后经 agent-gw 的下一个请求立即 401', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    const token = await issue(run);
    expect((await get(gatewayOrigin, token)).status).toBe(200);
    await revokeAgentJobTokens(appDb, run);
    expect((await get(gatewayOrigin, token)).status).toBe(401);
  });

  it('日志中没有令牌原文', async () => {
    const token = await issue(await runningJob(await newMember()));
    await get(gatewayOrigin, token);
    await get(endpointOrigin, token);
    expect(gatewayLogs.text()).not.toContain(token);
    expect(endpointLogs.text()).not.toContain(token);
    expect(endpointLogs.text()).not.toContain(token.slice(4, 24));
  });
});
