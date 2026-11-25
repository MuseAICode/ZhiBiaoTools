// 长时业务工具调用的交接（src/agent/toolRequests.ts、迁移 0047_agent_tool_requests，路线图第 8 步 8.10c2b1）对真实数据库的测试，
// 工具调用经 agent-gw 转给 worker 的内部入口：
// - 内部入口一侧：未完成返回 pending，以相同参数（键的顺序不同也算）再次调用不新建、完成后取回结果并关闭请求；另有不同请求在等待时 409；
//   rejected 422（说明交给 Agent）、failed 503（固定说明）；已完成未取回的请求遇到不同请求时作废后新建；任务不在本次执行中 409；
//   续跑后新执行的请求作废旧执行的请求；参数上限的登记检查；
// - 执行者一侧：只认领本次执行、登记了执行函数的工具的请求；执行函数的返回值、AgentToolRequestRejection、其他错误（致命）、过大的结果；
//   中止后停止；
// - 请求表的 RLS、授权、触发器（AR001）与约束；回滚 0047。
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import { buildAgentGateway } from '../../src/agent/gateway.ts';
import { reportFailureTool } from '../../src/agent/reportFailureTool.ts';
import { issueAgentJobToken } from '../../src/agent/tokenStore.ts';
import {
  AGENT_TOOL_FAILED_MESSAGE,
  AGENT_TOOL_REQUEST_ARGS_MAX_BYTES,
  AGENT_TOOL_REQUEST_RESULT_MAX_BYTES,
  AgentToolRequestRejection,
  claimAgentToolRequest,
  createAgentLongTool,
  finishAgentToolRequest,
  serveAgentToolRequests,
  type AgentLongToolExecutor,
} from '../../src/agent/toolRequests.ts';
import { setAgentToolScope } from '../../src/agent/toolScope.ts';
import { AGENT_TOOL_CALL_PATH, createAgentToolRegistry } from '../../src/agent/tools.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { claimJob, finishRun, insertJob, recoverJob, type RunRef } from '../../src/jobs/store.ts';
import { createLogCapture } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;
const WAIT_MS = 600;
const LONG = 'test-long';
const OTHER = 'test-long-other';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let endpoint: FastifyInstance;
let agentGw: FastifyInstance;
let gwOrigin: string;

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
    note: { type: 'string', maxLength: 200 },
  },
} as const;
const longTool = (name: string) => createAgentLongTool({ name, argumentsSchema: schema, maxArgumentBytes: 16 * 1024, maxCallsPerJob: 1_000, maxCallsPerMinute: 600, waitMs: WAIT_MS, pollMs: 20 });
const TOOLS = createAgentToolRegistry([longTool(LONG), longTool(OTHER), reportFailureTool]);
const TOOLS_BY_TYPE: Record<string, readonly string[]> = { 'test-agent': [LONG, OTHER, 'report-failure'] };

interface Member {
  orgId: string;
  userId: string;
  context: TenantContext;
}

async function newOrg(): Promise<Member> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x', email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, userId, context: { orgId, userId, role: 'owner' } };
}

async function claim(member: Member, jobId: string): Promise<RunRef> {
  const runId = randomUUID();
  const result = await claimJob(appDb, { orgId: member.orgId, jobId, runId, leaseMs: LEASE_MS, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 });
  expect(result.kind).toBe('claimed');
  return { orgId: member.orgId, jobId, runId };
}

async function runningJob(member: Member): Promise<RunRef> {
  const project = await withTenant(appDb, member.context, (trx) =>
    trx.insertInto('projects').values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId }).returning('id').executeTakeFirstOrThrow(),
  );
  const job = await insertJob(appDb, member.context, { type: 'test-agent', params: {}, projectId: project.id, agentLimits: AGENT_TASK_LIMITS.outline });
  return claim(member, job.id);
}

async function tokenOf(run: RunRef): Promise<string> {
  const issued = await issueAgentJobToken(appDb, run, TTL_MS);
  expect(issued).not.toBeNull();
  const tools = TOOLS_BY_TYPE['test-agent']!;
  expect(await setAgentToolScope(appDb, run, tools, tools)).toBe(true);
  return issued!.token;
}

async function tokenFor(member: Member) {
  const run = await runningJob(member);
  return { run, token: await tokenOf(run) };
}

async function call(token: string, name: string, args: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${gwOrigin}${AGENT_TOOL_CALL_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

async function requestsOf(jobId: string) {
  return superuser
    .selectFrom('agent_tool_requests')
    .select(['id', 'run_id', 'tool', 'args', 'status', 'outcome', 'result', 'message', 'claimed_at', 'finished_at', 'consumed_at'])
    .where('job_id', '=', jobId)
    .orderBy('created_at')
    .execute();
}

const refOf = (member: Member, run: RunRef) => ({ tenant: member.context, jobId: run.jobId, runId: run.runId });

/** 执行者认领并写下结果（模拟 serveAgentToolRequests 的一次处理）。 */
async function finishOne(member: Member, run: RunRef, result: Parameters<typeof finishAgentToolRequest>[3], tools = [LONG]) {
  const claimed = await claimAgentToolRequest(appDb, refOf(member, run), tools);
  expect(claimed).not.toBeNull();
  await finishAgentToolRequest(appDb, refOf(member, run), claimed!.id, result);
  return claimed!;
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
  endpoint = await buildAgentEndpointApp({
    db: appDb,
    relayKey: RELAY_KEY,
    logLevel: 'info',
    logStream: createLogCapture().stream,
    tools: TOOLS,
    toolsForJobType: (type) => TOOLS_BY_TYPE[type] ?? [],
  });
  await endpoint.listen({ host: '127.0.0.1', port: 0 });
  const endpointOrigin = `http://127.0.0.1:${(endpoint.server.address() as AddressInfo).port}`;
  agentGw = await buildAgentGateway({ upstream: endpointOrigin, relayKey: RELAY_KEY, logLevel: 'info', logStream: createLogCapture().stream });
  await agentGw.listen({ host: '127.0.0.1', port: 0 });
  gwOrigin = `http://127.0.0.1:${(agentGw.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await agentGw?.close();
  await endpoint?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('内部入口一侧', () => {
  it('未完成返回 pending；以相同参数再次调用不新建，完成后取回结果并关闭请求', async () => {
    const member = await newOrg();
    const { run, token } = await tokenFor(member);
    const first = await call(token, LONG, { items: ['1.1', '1.2'], note: '说明' });
    expect(first.status).toBe(200);
    expect(first.body.result).toEqual({ completed: false, pending: true, message: '工具仍在执行，请以完全相同的参数再次调用以取回结果' });
    const [row] = await requestsOf(run.jobId);
    expect(row).toMatchObject({ run_id: run.runId, tool: LONG, args: { items: ['1.1', '1.2'], note: '说明' }, status: 'pending', outcome: null });

    // 键的顺序不同也是同一请求；等待中被执行者完成即取回。
    const again = call(token, LONG, { note: '说明', items: ['1.1', '1.2'] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const claimed = await finishOne(member, run, { outcome: 'succeeded', result: { generated: 2, failed: [] } });
    expect(claimed).toEqual({ id: row!.id, tool: LONG, args: { items: ['1.1', '1.2'], note: '说明' } });
    const done = await again;
    expect(done).toEqual({ status: 200, body: { result: { generated: 2, failed: [] } } });
    const [closed] = await requestsOf(run.jobId);
    expect(closed).toMatchObject({ id: row!.id, status: 'consumed', outcome: 'succeeded' });
    expect(closed!.claimed_at).not.toBeNull();
    expect(closed!.finished_at).not.toBeNull();
    expect(closed!.consumed_at).not.toBeNull();

    // 取回后以相同参数再次调用：新的请求。
    expect((await call(token, LONG, { items: ['1.1', '1.2'], note: '说明' })).body.result).toMatchObject({ pending: true });
    expect((await requestsOf(run.jobId)).map((request) => request.status)).toEqual(['consumed', 'pending']);
  });

  it('另有不同的请求在等待或执行时 409；rejected 422 带说明，failed 503 固定说明', async () => {
    const member = await newOrg();
    const { run, token } = await tokenFor(member);
    await call(token, LONG, { items: ['a'] });
    const conflict = await call(token, LONG, { items: ['b'] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'AGENT_TOOL_REQUEST_PENDING' });
    expect((await call(token, OTHER, { items: ['a'] })).status).toBe(409);
    // 执行中同样冲突。
    const claimed = await claimAgentToolRequest(appDb, refOf(member, run), [LONG]);
    expect((await call(token, LONG, { items: ['b'] })).status).toBe(409);
    await finishAgentToolRequest(appDb, refOf(member, run), claimed!.id, { outcome: 'rejected', message: '任务文件中的小节 9.9 不是本次的目标' });
    const rejected = await call(token, LONG, { items: ['a'] });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error).toMatchObject({ code: 'AGENT_TOOL_REJECTED', message: '任务文件中的小节 9.9 不是本次的目标' });

    await call(token, LONG, { items: ['c'] });
    await finishOne(member, run, { outcome: 'failed' });
    const failed = await call(token, LONG, { items: ['c'] });
    expect(failed.status).toBe(503);
    expect(failed.body.error).toMatchObject({ code: 'AGENT_TOOL_FAILED', message: AGENT_TOOL_FAILED_MESSAGE });
    expect((await requestsOf(run.jobId)).map((request) => [request.status, request.outcome])).toEqual([
      ['consumed', 'rejected'],
      ['consumed', 'failed'],
    ]);
  });

  it('已完成未取回的请求遇到不同的请求时作废后新建', async () => {
    const member = await newOrg();
    const { run, token } = await tokenFor(member);
    await call(token, LONG, { items: ['a'] });
    await finishOne(member, run, { outcome: 'succeeded', result: { ok: true } });
    expect((await call(token, LONG, { items: ['b'] })).body.result).toMatchObject({ pending: true });
    expect((await requestsOf(run.jobId)).map((request) => [request.status, request.args])).toEqual([
      ['superseded', { items: ['a'] }],
      ['pending', { items: ['b'] }],
    ]);
  });

  it('任务不在本次执行中 409 JOB_NOT_RUNNING；续跑后新执行的请求作废旧执行的请求，旧执行不能再认领或写下结果', async () => {
    const member = await newOrg();
    const { run, token } = await tokenFor(member);
    await call(token, LONG, { items: ['a'] });
    const stale = await claimAgentToolRequest(appDb, refOf(member, run), [LONG]);
    expect(stale).not.toBeNull();
    // 执行者失联：恢复为 queued 后由新的执行认领。
    await superuser.updateTable('jobs').set({ lease_expires_at: new Date(Date.now() - 1000) }).where('id', '=', run.jobId).execute();
    expect(await recoverJob(appDb, { orgId: run.orgId, id: run.jobId }, () => true)).toMatchObject({ kind: 'dispatch' });
    // 旧执行的令牌随之失效。
    expect((await call(token, LONG, { items: ['a'] })).status).toBe(401);

    const next = await claim(member, run.jobId);
    const nextToken = await tokenOf(next);
    expect((await call(nextToken, LONG, { items: ['a'] })).body.result).toMatchObject({ pending: true });
    const rows = await requestsOf(run.jobId);
    expect(rows.map((request) => [request.run_id, request.status])).toEqual([
      [run.runId, 'superseded'],
      [next.runId, 'pending'],
    ]);
    // 旧执行：认领不到新执行的请求，旧请求不能写下结果。
    expect(await claimAgentToolRequest(appDb, refOf(member, run), [LONG])).toBeNull();
    await finishAgentToolRequest(appDb, refOf(member, run), stale!.id, { outcome: 'succeeded', result: 1 });
    expect((await requestsOf(run.jobId))[0]).toMatchObject({ status: 'superseded', outcome: null });
  });

  it('参数不合法 400、不登记；长时工具的参数上限不能超过请求表的上限', async () => {
    const member = await newOrg();
    const { run, token } = await tokenFor(member);
    expect((await call(token, LONG, { items: 'x' })).status).toBe(400);
    expect(await requestsOf(run.jobId)).toEqual([]);
    expect(() => createAgentLongTool({ name: 'too-big', argumentsSchema: schema, maxArgumentBytes: AGENT_TOOL_REQUEST_ARGS_MAX_BYTES + 1, maxCallsPerJob: 1, maxCallsPerMinute: 1 })).toThrow(TypeError);
  });
});

describe('执行者一侧', () => {
  async function serveUntil(member: Member, run: RunRef, executors: Record<string, AgentLongToolExecutor>, untilStatus: string) {
    const controller = new AbortController();
    const serving = serveAgentToolRequests({ db: appDb, ref: refOf(member, run), executors: new Map(Object.entries(executors)), signal: controller.signal, pollMs: 20 });
    for (let index = 0; index < 200; index += 1) {
      const rows = await requestsOf(run.jobId);
      if (rows.at(-1)?.status === untilStatus) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    return serving;
  }

  it('只认领本次执行中登记了执行函数的工具；返回值与 AgentToolRequestRejection 写下结果，正常停止返回 null', async () => {
    const member = await newOrg();
    const { run, token } = await tokenFor(member);
    await call(token, OTHER, { items: ['a'] });
    expect(await claimAgentToolRequest(appDb, refOf(member, run), [LONG])).toBeNull();
    const seen: unknown[] = [];
    const fatal = await serveUntil(member, run, {
      [OTHER]: async ({ args, signal }) => {
        seen.push(args);
        expect(signal.aborted).toBe(false);
        return { done: args.items };
      },
    }, 'finished');
    expect(fatal).toBeNull();
    expect(seen).toEqual([{ items: ['a'] }]);
    expect((await requestsOf(run.jobId))[0]).toMatchObject({ status: 'finished', outcome: 'succeeded', result: { done: ['a'] } });
    expect((await call(token, OTHER, { items: ['a'] })).body.result).toEqual({ done: ['a'] });

    await call(token, OTHER, { items: ['b'] });
    expect(await serveUntil(member, run, { [OTHER]: async () => { throw new AgentToolRequestRejection('  任务文件不存在  '); } }, 'finished')).toBeNull();
    expect((await requestsOf(run.jobId))[1]).toMatchObject({ outcome: 'rejected', message: '任务文件不存在' });
  });

  it('其他错误与过大的结果按 failed 写下并作为致命错误返回', async () => {
    const member = await newOrg();
    const { run, token } = await tokenFor(member);
    await call(token, LONG, { items: ['a'] });
    const boom = new Error('balance');
    expect(await serveUntil(member, run, { [LONG]: async () => { throw boom; } }, 'finished')).toBe(boom);
    expect((await requestsOf(run.jobId))[0]).toMatchObject({ status: 'finished', outcome: 'failed', result: null, message: null });

    await call(token, LONG, { items: ['a'] }); // 取回 failed
    await call(token, LONG, { items: ['b'] });
    const fatal = await serveUntil(member, run, { [LONG]: async () => 'x'.repeat(AGENT_TOOL_REQUEST_RESULT_MAX_BYTES) }, 'finished');
    expect(fatal).toBeInstanceOf(Error);
    expect((await requestsOf(run.jobId))[1]).toMatchObject({ outcome: 'failed', result: null });
  });

  it('说明超过 500 个字符时截短；空说明用固定说明', () => {
    expect(new AgentToolRequestRejection('字'.repeat(600)).message).toBe('字'.repeat(500));
    expect(new AgentToolRequestRejection('   ').message).toBe(AGENT_TOOL_FAILED_MESSAGE);
  });
});

describe('请求表的数据库约束', () => {
  async function pendingRequest(member: Member) {
    const { run, token } = await tokenFor(member);
    await call(token, LONG, { items: ['a'] });
    const [row] = await requestsOf(run.jobId);
    return { run, token, id: row!.id as string };
  }
  const update = (member: Member, id: string, set: Record<string, unknown>) =>
    withTenant(appDb, member.context, (trx) => trx.updateTable('agent_tool_requests').set(set as never).where('id', '=', id).execute());

  it('RLS：其他组织看不到、改不了、不能为其他组织的任务登记', async () => {
    const owner = await newOrg();
    const stranger = await newOrg();
    const { run, id } = await pendingRequest(owner);
    expect(await withTenant(appDb, stranger.context, (trx) => trx.selectFrom('agent_tool_requests').selectAll().execute())).toEqual([]);
    const updated = await withTenant(appDb, stranger.context, (trx) => trx.updateTable('agent_tool_requests').set({ status: 'running' }).where('id', '=', id).executeTakeFirst());
    expect(updated.numUpdatedRows).toBe(0n);
    await expect(
      withTenant(appDb, stranger.context, (trx) =>
        trx.insertInto('agent_tool_requests').values({ org_id: owner.orgId, job_id: run.jobId, run_id: run.runId, tool: LONG, args_hash: Buffer.alloc(32), args: '{}' }).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('只能为 running、run_id 相符的 Agent 任务登记；每个任务至多一个未关闭的请求', async () => {
    const owner = await newOrg();
    const { run } = await pendingRequest(owner);
    const insert = (runId: string) =>
      withTenant(appDb, owner.context, (trx) =>
        trx.insertInto('agent_tool_requests').values({ org_id: owner.orgId, job_id: run.jobId, run_id: runId, tool: LONG, args_hash: Buffer.alloc(32, 1), args: '{}' }).execute(),
      );
    await expect(insert(randomUUID())).rejects.toMatchObject({ code: '42501' });
    await expect(insert(run.runId)).rejects.toMatchObject({ code: '23505' });
  });

  it('触发器：状态只能按规定改变，结果只在完成时写下，时间由数据库填写，关闭后不能再改；任务结束后只能写下 failed', async () => {
    const owner = await newOrg();
    const { run, id } = await pendingRequest(owner);
    for (const set of [
      { status: 'finished', outcome: 'succeeded', result: '1' },
      { status: 'consumed' },
      { status: 'superseded' },
      { outcome: 'failed' },
      { result: '1' },
    ]) {
      await expect(update(owner, id, set)).rejects.toMatchObject({ code: 'AR001' });
    }
    await update(owner, id, { status: 'running' });
    await expect(update(owner, id, { status: 'pending' })).rejects.toMatchObject({ code: 'AR001' });
    await expect(update(owner, id, { status: 'finished' })).rejects.toMatchObject({ code: 'AR001' });
    await expect(update(owner, id, { status: 'finished', outcome: 'succeeded' })).rejects.toMatchObject({ code: '23514' });
    await expect(update(owner, id, { status: 'finished', outcome: 'rejected', result: '1', message: 'x' })).rejects.toMatchObject({ code: '23514' });
    // 任务不再是本次执行：succeeded 写不下，failed 可以。
    await superuser.updateTable('jobs').set({ lease_expires_at: new Date(Date.now() - 1000) }).where('id', '=', run.jobId).execute();
    expect(await finishRun(appDb, run, { kind: 'failed', code: 'X', message: '失败' }, false)).toBe('failed');
    await expect(update(owner, id, { status: 'finished', outcome: 'succeeded', result: '1' })).rejects.toMatchObject({ code: 'AR001' });
    await update(owner, id, { status: 'finished', outcome: 'failed' });
    await expect(update(owner, id, { status: 'consumed' })).rejects.toMatchObject({ code: 'AR001' });
  });

  it('同一次执行中不能作废未完成的请求；consumed 后不能再改', async () => {
    const owner = await newOrg();
    const { run, token, id } = await pendingRequest(owner);
    await expect(update(owner, id, { status: 'superseded' })).rejects.toMatchObject({ code: 'AR001' });
    await finishOne(owner, run, { outcome: 'succeeded', result: { ok: 1 } });
    await call(token, LONG, { items: ['a'] });
    await expect(update(owner, id, { status: 'superseded' })).rejects.toMatchObject({ code: 'AR001' });
  });

  it('授权：应用角色不能改标识、参数与时间，没有 DELETE；随任务记录删除', async () => {
    const owner = await newOrg();
    const { run, id } = await pendingRequest(owner);
    for (const set of [{ args: '{}' }, { tool: OTHER }, { run_id: randomUUID() }, { claimed_at: new Date() }, { consumed_at: new Date() }]) {
      await expect(update(owner, id, set)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(withTenant(appDb, owner.context, (trx) => trx.deleteFrom('agent_tool_requests').where('id', '=', id).execute())).rejects.toMatchObject({ code: '42501' });
    await superuser.deleteFrom('jobs').where('id', '=', run.jobId).execute();
    expect(await requestsOf(run.jobId)).toEqual([]);
  });

  it('约束：工具名、参数大小与形状', async () => {
    const owner = await newOrg();
    const run = await runningJob(owner);
    await issueAgentJobToken(appDb, run, TTL_MS);
    const insert = (values: Record<string, unknown>) =>
      withTenant(appDb, owner.context, (trx) =>
        trx.insertInto('agent_tool_requests').values({ org_id: owner.orgId, job_id: run.jobId, run_id: run.runId, tool: LONG, args_hash: Buffer.alloc(32), args: '{}', ...values } as never).execute(),
      );
    await expect(insert({ tool: 'Bad_Name' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ args: '[]' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ args_hash: Buffer.alloc(31) })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ args: JSON.stringify({ x: 'y'.repeat(AGENT_TOOL_REQUEST_ARGS_MAX_BYTES) }) })).rejects.toMatchObject({ code: '23514' });
  });
});

describe('回滚 0047', () => {
  it('删除请求表与触发器函数', async () => {
    const owner = connect(testDb.ownerConfig);
    try {
      const down = await migrateDown(owner);
      expect(down.error).toBeUndefined();
      expect(down.results?.map((result) => result.migrationName)).toEqual(['0047_agent_tool_requests']);
      const { rows } = await sql<{ name: string | null }>`SELECT to_regclass('agent_tool_requests')::text AS name`.execute(superuser);
      expect(rows[0]!.name).toBeNull();
      const functions = await sql<{ count: string }>`SELECT count(*) AS count FROM pg_proc WHERE proname = 'agent_tool_requests_guard'`.execute(superuser);
      expect(Number(functions.rows[0]!.count)).toBe(0);
      expect((await migrateToLatest(owner)).error).toBeUndefined();
    } finally {
      await owner.destroy();
    }
  });
});
