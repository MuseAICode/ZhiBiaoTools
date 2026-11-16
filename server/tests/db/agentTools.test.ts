// Agent 业务工具 RPC 框架（src/agent/tools.ts、迁移 0037_agent_tool_calls，路线图第 8 步 8.4a）对真实数据库的测试，
// 请求经 agent-gw 转给 worker 的内部入口（并发用例直接打内部入口，绕开 agent-gw 的每令牌并发上限）：
// - 工具名：未登记与本任务类型不可用的一律 404（响应相同），不计入；
// - 身份只按令牌：处理函数拿到的组织、项目、任务、用户与令牌一致，请求体与头部中自称的身份被拒绝或不采信；
// - 参数：不做类型转换，不合法 400（说明只含位置与要求），超过工具的字节上限 413；
// - 资源标识在本项目范围内重新解析：其他项目、其他组织、不存在、格式不对的产物 id 一律同一个 404；
// - 调用次数与频率：原子计入（20 个并发恰好放行上限个），参数不合法的调用同样计入，窗口过后恢复；
// - 计数表的 RLS、授权与不变式（AT101）；处理函数出错不泄露内部消息；沙箱断开时中止处理函数；
// - 日志中没有令牌原文与参数内容；回滚 0037。
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import { buildAgentGateway } from '../../src/agent/gateway.ts';
import { AGENT_RELAY_KEY_HEADER } from '../../src/agent/token.ts';
import { issueAgentJobToken } from '../../src/agent/tokenStore.ts';
import { setAgentToolScope } from '../../src/agent/toolScope.ts';
import {
  AGENT_TOOL_CALL_PATH,
  AGENT_TOOL_MAX_BODY_BYTES,
  beginAgentToolCall,
  createAgentToolRegistry,
  resolveProjectArtifact,
  type AgentToolContext,
  type AgentToolDefinition,
} from '../../src/agent/tools.ts';
import { ARTIFACT_MIMES } from '../../src/artifacts/store.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import { claimJob, insertJob, requestPause, type RunRef } from '../../src/jobs/store.ts';
import { createLogCapture } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;
const SECRET_MARKER = 'argument-marker-7f3a9c';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let endpoint: FastifyInstance;
let endpointOrigin: string;
let agentGw: FastifyInstance;
let gwOrigin: string;
const endpointLogs = createLogCapture();
const gwLogs = createLogCapture();

/** 处理函数收到的上下文（每次调用记下，供断言身份）。 */
const seen: Array<{ tool: string; context: AgentToolContext; args: unknown }> = [];
let slowStarted: (() => void) | null = null;
let slowAborted: ((reason: unknown) => void) | null = null;

function record(tool: string, context: AgentToolContext, args: unknown) {
  seen.push({ tool, context, args });
}

const echoTool: AgentToolDefinition<{ text: string; count?: number }> = {
  name: 'test-echo',
  argumentsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string', maxLength: 600 }, count: { type: 'integer', minimum: 0, maximum: 10 } },
  },
  maxArgumentBytes: 512,
  maxCallsPerJob: 1_000,
  maxCallsPerMinute: 600,
  async run(context, args) {
    record('test-echo', context, args);
    return { text: args.text, count: args.count ?? 0 };
  },
};

const artifactTool: AgentToolDefinition<{ artifactId: string }> = {
  name: 'test-artifact',
  argumentsSchema: { type: 'object', additionalProperties: false, required: ['artifactId'], properties: { artifactId: { type: 'string', maxLength: 64 } } },
  maxArgumentBytes: 1024,
  maxCallsPerJob: 1_000,
  maxCallsPerMinute: 600,
  async run(context, args) {
    const artifact = await withTenant(context.db, context.tenant, (trx) => resolveProjectArtifact(trx, context, args.artifactId));
    return { name: artifact.name, kind: artifact.kind };
  },
};

const emptyArgs = { type: 'object', additionalProperties: false, properties: {} } as const;

const limitedTool: AgentToolDefinition = {
  name: 'test-limited',
  argumentsSchema: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer' } } },
  maxArgumentBytes: 256,
  maxCallsPerJob: 3,
  maxCallsPerMinute: 600,
  run: async () => ({ ok: true }),
};

const rateTool: AgentToolDefinition = { name: 'test-rate', argumentsSchema: emptyArgs, maxArgumentBytes: 256, maxCallsPerJob: 100, maxCallsPerMinute: 2, run: async () => ({ ok: true }) };

const otherTool: AgentToolDefinition = {
  name: 'test-other',
  argumentsSchema: emptyArgs,
  maxArgumentBytes: 256,
  maxCallsPerJob: 100,
  maxCallsPerMinute: 100,
  async run(context, args) {
    record('test-other', context, args);
    return { ok: true };
  },
};

const failingTool: AgentToolDefinition<{ app?: boolean }> = {
  name: 'test-failing',
  argumentsSchema: { type: 'object', additionalProperties: false, properties: { app: { type: 'boolean' } } },
  maxArgumentBytes: 256,
  maxCallsPerJob: 100,
  maxCallsPerMinute: 100,
  async run(_context, args) {
    if (args.app) throw new AppError(409, 'TEST_TOOL_CONFLICT', '工具自己的业务错误');
    throw new Error('internal detail: database password is hunter2');
  },
};

const slowTool: AgentToolDefinition = {
  name: 'test-slow',
  argumentsSchema: emptyArgs,
  maxArgumentBytes: 256,
  maxCallsPerJob: 100,
  maxCallsPerMinute: 100,
  run: (context) =>
    new Promise((_resolve, reject) => {
      slowStarted?.();
      context.signal.addEventListener('abort', () => {
        slowAborted?.(context.signal.reason);
        reject(new Error('aborted'));
      });
    }),
};

const TOOLS = createAgentToolRegistry([echoTool, artifactTool, limitedTool, rateTool, otherTool, failingTool, slowTool]);
const TOOLS_BY_TYPE: Record<string, readonly string[]> = {
  'test-agent': ['test-echo', 'test-artifact', 'test-limited', 'test-rate', 'test-failing', 'test-slow'],
  'test-agent-other': ['test-other'],
};

interface Member {
  orgId: string;
  userId: string;
  context: TenantContext;
}

async function newMember(role: 'owner' | 'member' = 'owner'): Promise<Member> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'team' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: 'x', email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { orgId, userId, context: { orgId, userId, role } };
}

async function newProject(member: Member): Promise<string> {
  const project = await withTenant(appDb, member.context, (trx) =>
    trx.insertInto('projects').values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId }).returning('id').executeTakeFirstOrThrow(),
  );
  return project.id;
}

async function runningJob(member: Member, options: { type?: string; projectId?: string } = {}): Promise<RunRef & { projectId: string }> {
  const projectId = options.projectId ?? (await newProject(member));
  const job = await insertJob(appDb, member.context, { type: options.type ?? 'test-agent', params: {}, projectId, agentLimits: AGENT_TASK_LIMITS.outline });
  const runId = randomUUID();
  const result = await claimJob(appDb, { orgId: member.orgId, jobId: job.id, runId, leaseMs: LEASE_MS, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 });
  expect(result.kind).toBe('claimed');
  return { orgId: member.orgId, jobId: job.id, runId, projectId };
}

/** 写下本次执行当前阶段可用的业务工具（迁移 0042，8.6c1）：测试中为任务类型登记的全部工具。 */
async function scopeAllTools(run: RunRef): Promise<void> {
  const { type } = await superuser.selectFrom('jobs').select('type').where('id', '=', run.jobId).executeTakeFirstOrThrow();
  const tools = TOOLS_BY_TYPE[type as string] ?? [];
  expect(await setAgentToolScope(appDb, run, tools, tools)).toBe(true);
}

async function tokenFor(member: Member, options: { type?: string; projectId?: string } = {}) {
  const run = await runningJob(member, options);
  const issued = await issueAgentJobToken(appDb, run, TTL_MS);
  expect(issued).not.toBeNull();
  await scopeAllTools(run);
  return { run, token: issued!.token };
}

async function artifactIn(member: Member, projectId: string, options: { superseded?: boolean; writing?: boolean } = {}): Promise<string> {
  const writing = options.writing ?? false;
  const row = await superuser
    .insertInto('artifacts')
    .values({
      org_id: member.orgId,
      project_id: projectId,
      kind: 'markdown',
      name: 'content.md',
      mime: ARTIFACT_MIMES.markdown[0]!,
      status: writing ? 'writing' : 'ready',
      size_bytes: writing ? null : 10,
      sha256: writing ? null : Buffer.alloc(32),
      completed_at: writing ? null : new Date(),
      created_by: member.userId,
      superseded_at: options.superseded ? new Date() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function call(
  token: string,
  payload: unknown,
  init: { origin?: string; headers?: Record<string, string>; raw?: string; signal?: AbortSignal } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const origin = init.origin ?? gwOrigin;
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers };
  if (origin === endpointOrigin) headers[AGENT_RELAY_KEY_HEADER] = RELAY_KEY;
  const response = await fetch(`${origin}${AGENT_TOOL_CALL_PATH}`, { method: 'POST', headers, body: init.raw ?? JSON.stringify(payload), signal: init.signal ?? null });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

async function callsRow(jobId: string, tool: string): Promise<{ calls: number; window_calls: number } | undefined> {
  return superuser.selectFrom('agent_tool_calls').select(['calls', 'window_calls']).where('job_id', '=', jobId).where('tool', '=', tool).executeTakeFirst();
}

async function asApp<T>(member: Member, fn: (trx: any) => Promise<T>): Promise<T> {
  return withTenant(appDb, member.context, fn);
}

async function startServers() {
  endpoint = await buildAgentEndpointApp({
    db: appDb,
    relayKey: RELAY_KEY,
    logLevel: 'info',
    logStream: endpointLogs.stream,
    tools: TOOLS,
    toolsForJobType: (type) => TOOLS_BY_TYPE[type] ?? [],
  });
  await endpoint.listen({ host: '127.0.0.1', port: 0 });
  endpointOrigin = `http://127.0.0.1:${(endpoint.server.address() as AddressInfo).port}`;
  agentGw = await buildAgentGateway({ upstream: endpointOrigin, relayKey: RELAY_KEY, logLevel: 'info', logStream: gwLogs.stream });
  await agentGw.listen({ host: '127.0.0.1', port: 0 });
  gwOrigin = `http://127.0.0.1:${(agentGw.server.address() as AddressInfo).port}`;
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
  await startServers();
});

afterAll(async () => {
  await agentGw?.close();
  await endpoint?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('对照组与身份', () => {
  it('对照组：经 agent-gw 调用登记的工具 → 200 { result }；处理函数拿到的身份与令牌一致', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    const response = await call(token, { name: 'test-echo', arguments: { text: '你好', count: 2 } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: { text: '你好', count: 2 } });
    const entry = seen.findLast((item) => item.tool === 'test-echo')!;
    expect(entry.context.identity).toMatchObject({ orgId: member.orgId, userId: member.userId, jobId: run.jobId, runId: run.runId, projectId: run.projectId, jobType: 'test-agent' });
    expect(entry.context.tenant).toEqual({ orgId: member.orgId, userId: member.userId, role: 'owner' });
    expect(await callsRow(run.jobId, 'test-echo')).toEqual({ calls: 1, window_calls: 1 });
  });

  it('伪造身份：请求体顶层自称的组织 / 项目 / 任务 / 用户 → 400；参数中多出的字段 → 400；头部中自称的身份不采信', async () => {
    const victim = await newMember();
    const victimJob = await runningJob(victim);
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    for (const extra of [{ org_id: victim.orgId }, { project_id: victimJob.projectId }, { job_id: victimJob.jobId }, { user_id: victim.userId }, { model: 'x' }]) {
      const response = await call(token, { name: 'test-echo', arguments: { text: 'a' }, ...extra });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AGENT_TOOL_INVALID_ARGUMENTS');
    }
    const nested = await call(token, { name: 'test-echo', arguments: { text: 'a', projectId: victimJob.projectId } });
    expect(nested.status).toBe(400);
    expect(nested.body.error.code).toBe('AGENT_TOOL_INVALID_ARGUMENTS');

    const before = seen.length;
    const headers = { 'x-org-id': victim.orgId, 'x-project-id': victimJob.projectId, 'x-job-id': victimJob.jobId, 'x-user-id': victim.userId };
    for (const origin of [gwOrigin, endpointOrigin]) {
      const response = await call(token, { name: 'test-echo', arguments: { text: 'a' } }, { origin, headers });
      expect(response.status).toBe(200);
    }
    for (const entry of seen.slice(before)) {
      expect(entry.context.identity).toMatchObject({ orgId: member.orgId, projectId: run.projectId, jobId: run.jobId, userId: member.userId });
    }
    // 受害组织没有任何计数。
    expect(await superuser.selectFrom('agent_tool_calls').select('tool').where('org_id', '=', victim.orgId).execute()).toEqual([]);
  });

  it('令牌无效（请求暂停后）→ 401，处理函数不执行、不计入', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    expect((await call(token, { name: 'test-echo', arguments: { text: 'a' } })).status).toBe(200);
    await requestPause(appDb, member.context, run.jobId);
    const before = seen.length;
    const response = await call(token, { name: 'test-echo', arguments: { text: 'a' } });
    expect(response.status).toBe(401);
    expect(seen.length).toBe(before);
    expect(await callsRow(run.jobId, 'test-echo')).toEqual({ calls: 1, window_calls: 1 });
  });
});

describe('工具名', () => {
  it('未登记的工具与本任务类型不可用的工具 → 同一个 404，不执行、不计入；同一工具对登记了它的任务类型可用（对照组）', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    const before = seen.length;
    const unknown = await call(token, { name: 'no-such-tool', arguments: {} });
    const notAllowed = await call(token, { name: 'test-other', arguments: {} });
    const malformed = await call(token, { name: 'Test_Other', arguments: {} });
    const missing = await call(token, { arguments: {} });
    for (const response of [unknown, notAllowed, malformed, missing]) {
      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({ code: 'AGENT_TOOL_NOT_FOUND', message: unknown.body.error.message });
    }
    expect(seen.length).toBe(before);
    expect(await superuser.selectFrom('agent_tool_calls').select('tool').where('job_id', '=', run.jobId).execute()).toEqual([]);

    const other = await tokenFor(member, { type: 'test-agent-other' });
    expect((await call(other.token, { name: 'test-other', arguments: {} })).status).toBe(200);
    // 反过来，test-agent 的工具对 test-agent-other 不可用。
    expect((await call(other.token, { name: 'test-echo', arguments: { text: 'a' } })).status).toBe(404);
  });

  it('请求体不是 JSON 对象 → 404 / 400，不执行', async () => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    for (const raw of ['[]', '"test-echo"', 'null']) {
      const response = await call(token, null, { raw });
      expect([400, 404]).toContain(response.status);
    }
    expect((await call(token, null, { raw: '{"name":"test-echo",' })).status).toBe(400);
  });
});

describe('参数', () => {
  it('不做类型转换、缺少必填、超出 schema 的范围 → 400，说明只含位置与要求；参数不合法的调用同样计入', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    const cases: unknown[] = [
      { text: 'a', count: '1' },
      { text: 1 },
      {},
      { text: 'a', count: 11 },
      { text: 'a', count: 1.5 },
      'not-an-object',
      ['a'],
    ];
    for (const args of cases) {
      const response = await call(token, { name: 'test-echo', arguments: args });
      expect(response.status, JSON.stringify(args)).toBe(400);
      expect(response.body.error.code).toBe('AGENT_TOOL_INVALID_ARGUMENTS');
      expect(response.body.error.message).toMatch(/^工具参数不合法/);
    }
    const typed = await call(token, { name: 'test-echo', arguments: { text: 'a', count: '1' } });
    expect(typed.body.error.message).toContain('/count');
    expect(await callsRow(run.jobId, 'test-echo')).toMatchObject({ calls: cases.length + 1 });
  });

  it('超过工具自己的字节上限 → 413（字符串长度在 schema 之内）；超过整个请求体上限 → agent-gw 413', async () => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    // 600 个汉字在 maxLength 之内，但超过 512 字节。
    const tooLarge = await call(token, { name: 'test-echo', arguments: { text: '中'.repeat(600) } });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error.code).toBe('AGENT_TOOL_ARGUMENTS_TOO_LARGE');
    const ok = await call(token, { name: 'test-echo', arguments: { text: '中'.repeat(100) } });
    expect(ok.status).toBe(200);
    const huge = await call(token, { name: 'test-echo', arguments: { text: 'a'.repeat(AGENT_TOOL_MAX_BODY_BYTES) } });
    expect(huge.status).toBe(413);
    // 直接打内部入口：worker 自己执行请求体上限。
    const direct = await call(token, { name: 'test-echo', arguments: { text: 'a'.repeat(AGENT_TOOL_MAX_BODY_BYTES) } }, { origin: endpointOrigin });
    expect(direct.status).toBe(413);
  });
});

describe('资源标识在本项目范围内重新解析', () => {
  it('本项目的产物可以取到（对照组）；其他项目、其他组织、未完成、已替换、不存在、格式不对的 id 一律同一个 404', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    const own = await artifactIn(member, run.projectId);
    const ok = await call(token, { name: 'test-artifact', arguments: { artifactId: own } });
    expect(ok.status).toBe(200);
    expect(ok.body.result).toEqual({ name: 'content.md', kind: 'markdown' });

    const otherProject = await artifactIn(member, await newProject(member));
    const stranger = await newMember();
    const strangerArtifact = await artifactIn(stranger, await newProject(stranger));
    const writing = await artifactIn(member, run.projectId, { writing: true });
    const superseded = await artifactIn(member, run.projectId, { superseded: true });
    const ids = [otherProject, strangerArtifact, writing, superseded, randomUUID(), 'not-a-uuid', own.toUpperCase(), `${own} `];
    const bodies = [];
    for (const artifactId of ids) {
      const response = await call(token, { name: 'test-artifact', arguments: { artifactId } });
      expect(response.status, artifactId).toBe(404);
      bodies.push(response.body.error.code + response.body.error.message);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('AGENT_RESOURCE_NOT_FOUND');
  });

  it('同一组织另一个项目的任务令牌取不到本项目的产物', async () => {
    const member = await newMember();
    const first = await tokenFor(member);
    const second = await tokenFor(member);
    const artifact = await artifactIn(member, first.run.projectId);
    expect((await call(first.token, { name: 'test-artifact', arguments: { artifactId: artifact } })).status).toBe(200);
    expect((await call(second.token, { name: 'test-artifact', arguments: { artifactId: artifact } })).status).toBe(404);
  });
});

describe('调用次数与频率', () => {
  it('累计次数达到上限 → 429 AGENT_TOOL_CALL_LIMIT，处理函数不执行；另一个任务的次数独立（对照组）', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    for (let i = 0; i < 3; i += 1) expect((await call(token, { name: 'test-limited', arguments: {} })).status).toBe(200);
    const over = await call(token, { name: 'test-limited', arguments: {} });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('AGENT_TOOL_CALL_LIMIT');
    expect(await callsRow(run.jobId, 'test-limited')).toEqual({ calls: 3, window_calls: 3 });
    // 参数不合法的调用到上限后同样被拒绝（不进入校验）。
    expect((await call(token, { name: 'test-limited', arguments: { n: 'x' } })).status).toBe(429);

    const other = await tokenFor(member);
    expect((await call(other.token, { name: 'test-limited', arguments: {} })).status).toBe(200);
  });

  it('20 个并发调用恰好放行上限（3）个', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    const responses = await Promise.all(Array.from({ length: 20 }, () => call(token, { name: 'test-limited', arguments: {} }, { origin: endpointOrigin })));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(17);
    expect(await callsRow(run.jobId, 'test-limited')).toMatchObject({ calls: 3 });
  });

  it('每分钟频率达到上限 → 429 AGENT_TOOL_RATE_LIMIT；窗口过后重新计数', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    expect((await call(token, { name: 'test-rate', arguments: {} })).status).toBe(200);
    expect((await call(token, { name: 'test-rate', arguments: {} })).status).toBe(200);
    const limited = await call(token, { name: 'test-rate', arguments: {} });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('AGENT_TOOL_RATE_LIMIT');
    // 把窗口开始时间移到 61 秒前（超级用户关闭触发器模拟时间流逝）。
    await superuser.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await sql`UPDATE agent_tool_calls SET window_started_at = now() - interval '61 seconds', created_at = now() - interval '61 seconds' WHERE job_id = ${run.jobId}::uuid`.execute(trx);
    });
    expect((await call(token, { name: 'test-rate', arguments: {} })).status).toBe(200);
    expect(await callsRow(run.jobId, 'test-rate')).toEqual({ calls: 3, window_calls: 1 });
  });

  it('beginAgentToolCall：run_id 不符、任务不在执行中、没有登记上限的任务 → not-running，不计入', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    await scopeAllTools(run);
    const ref = { tenant: member.context, jobId: run.jobId, runId: run.runId, tool: 'test-echo', maxCallsPerJob: 10, maxCallsPerMinute: 10 };
    expect(await beginAgentToolCall(appDb, ref)).toBeNull();
    expect(await beginAgentToolCall(appDb, { ...ref, runId: randomUUID() })).toBe('not-running');
    const project = await newProject(member);
    const plain = await insertJob(appDb, member.context, { type: 'test-plain', params: {}, projectId: project });
    const plainRun = randomUUID();
    expect((await claimJob(appDb, { orgId: member.orgId, jobId: plain.id, runId: plainRun, leaseMs: LEASE_MS, orgRunningLimit: 100, attemptsFor: () => 5 })).kind).toBe('claimed');
    expect(await beginAgentToolCall(appDb, { ...ref, jobId: plain.id, runId: plainRun })).toBe('not-running');
    await requestPause(appDb, member.context, run.jobId);
    // 请求暂停时任务仍是 running：计数照常（令牌已失效，路由层面在此之前就 401）。
    expect(await beginAgentToolCall(appDb, ref)).toBeNull();
    expect(await callsRow(run.jobId, 'test-echo')).toMatchObject({ calls: 2 });
    expect(await callsRow(plain.id, 'test-echo')).toBeUndefined();
  });
});

describe('计数表的 RLS、授权与不变式', () => {
  it('应用角色：只能逐次加 1、窗口只能计数或从 now() 重新开始、标识不能改、没有 DELETE；只看得到本组织的行', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    await scopeAllTools(run);
    const ref = { tenant: member.context, jobId: run.jobId, runId: run.runId, tool: 'test-echo', maxCallsPerJob: 10, maxCallsPerMinute: 10 };
    expect(await beginAgentToolCall(appDb, ref)).toBeNull();
    const update = (set: string) =>
      asApp(member, (trx) => sql`UPDATE agent_tool_calls SET ${sql.raw(set)} WHERE job_id = ${run.jobId}::uuid`.execute(trx));
    await expect(update('calls = calls + 2, window_calls = window_calls + 1')).rejects.toMatchObject({ code: 'AT101' });
    await expect(update('calls = 1, window_calls = 1')).rejects.toMatchObject({ code: 'AT101' });
    await expect(update('calls = calls + 1, window_calls = 1')).rejects.toMatchObject({ code: 'AT101' });
    await expect(update("calls = calls + 1, window_started_at = now() - interval '1 hour', window_calls = 1")).rejects.toMatchObject({ code: 'AT101' });
    await expect(update("tool = 'test-other'")).rejects.toThrow();
    await expect(asApp(member, (trx) => sql`DELETE FROM agent_tool_calls WHERE job_id = ${run.jobId}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    // 对照组：合法的加 1 可以写入。
    await update('calls = calls + 1, window_calls = window_calls + 1');
    expect(await callsRow(run.jobId, 'test-echo')).toEqual({ calls: 2, window_calls: 2 });

    const stranger = await newMember();
    expect(await asApp(stranger, (trx) => trx.selectFrom('agent_tool_calls').selectAll().where('job_id', '=', run.jobId).execute())).toEqual([]);
    expect(await asApp(member, (trx) => trx.selectFrom('agent_tool_calls').select('tool').where('job_id', '=', run.jobId).execute())).toEqual([{ tool: 'test-echo' }]);
  });

  it('写入：不能为其他组织的任务、不在执行中的任务写入，不能直接写计数；工具名受 CHECK 约束', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    const stranger = await newMember();
    const strangerRun = await runningJob(stranger);
    const insert = (values: Record<string, unknown>) => asApp(member, (trx) => trx.insertInto('agent_tool_calls').values(values).execute());
    await expect(insert({ org_id: stranger.orgId, job_id: strangerRun.jobId, tool: 'test-echo' })).rejects.toThrow();
    await expect(insert({ org_id: member.orgId, job_id: run.jobId, tool: 'test-echo', calls: 0 })).rejects.toThrow(/permission denied/);
    await expect(insert({ org_id: member.orgId, job_id: run.jobId, tool: 'BAD NAME' })).rejects.toThrow(/agent_tool_calls_tool_check/);
    const queued = await insertJob(appDb, member.context, { type: 'test-agent', params: {}, projectId: run.projectId, agentLimits: AGENT_TASK_LIMITS.outline });
    await expect(insert({ org_id: member.orgId, job_id: queued.id, tool: 'test-echo' })).rejects.toThrow(/row-level security/);
    // 对照组：为本组织 running 的 Agent 任务写入成功，初值为 1。
    await insert({ org_id: member.orgId, job_id: run.jobId, tool: 'test-echo' });
    expect(await callsRow(run.jobId, 'test-echo')).toEqual({ calls: 1, window_calls: 1 });
  });

  it('授权：应用角色只有 SELECT、INSERT（标识列）、UPDATE（计数列）', async () => {
    const { rows } = await sql<{ privilege_type: string; column_name: string }>`
      SELECT privilege_type, column_name FROM information_schema.column_privileges
      WHERE table_name = 'agent_tool_calls' AND grantee = 'bidtools_app' AND privilege_type IN ('INSERT', 'UPDATE')
      ORDER BY privilege_type, column_name`.execute(superuser);
    expect(rows).toEqual([
      { privilege_type: 'INSERT', column_name: 'job_id' },
      { privilege_type: 'INSERT', column_name: 'org_id' },
      { privilege_type: 'INSERT', column_name: 'tool' },
      { privilege_type: 'UPDATE', column_name: 'calls' },
      { privilege_type: 'UPDATE', column_name: 'window_calls' },
      { privilege_type: 'UPDATE', column_name: 'window_started_at' },
    ]);
    const table = await sql<{ privilege_type: string }>`
      SELECT privilege_type FROM information_schema.table_privileges WHERE table_name = 'agent_tool_calls' AND grantee = 'bidtools_app' ORDER BY privilege_type`.execute(superuser);
    expect(table.rows.map((row) => row.privilege_type)).toEqual(['SELECT']);
  });
});

describe('错误、中止与日志', () => {
  it('处理函数抛出普通错误 → 500，不泄露内部消息；抛出 AppError → 原样返回', async () => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    const internal = await call(token, { name: 'test-failing', arguments: {} });
    expect(internal.status).toBe(500);
    expect(internal.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(internal.body)).not.toContain('hunter2');
    const business = await call(token, { name: 'test-failing', arguments: { app: true } });
    expect(business.status).toBe(409);
    expect(business.body.error).toMatchObject({ code: 'TEST_TOOL_CONFLICT', message: '工具自己的业务错误' });
  });

  it('沙箱断开时中止处理函数（signal）', async () => {
    const member = await newMember();
    const { token } = await tokenFor(member);
    const started = new Promise<void>((resolve) => (slowStarted = resolve));
    const aborted = new Promise<unknown>((resolve) => (slowAborted = resolve));
    const controller = new AbortController();
    const pending = call(token, { name: 'test-slow', arguments: {} }, { signal: controller.signal }).catch((error: unknown) => error);
    await started;
    controller.abort();
    expect(await aborted).toBe('client');
    expect(await pending).toBeInstanceOf(Error);
  });

  it('日志中没有令牌原文与参数内容，有工具名与令牌哈希前缀', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    expect((await call(token, { name: 'test-echo', arguments: { text: SECRET_MARKER } })).status).toBe(200);
    expect((await call(token, { name: 'test-echo', arguments: { text: SECRET_MARKER, count: 'bad' } })).status).toBe(400);
    const logs = endpointLogs.text() + gwLogs.text();
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(SECRET_MARKER);
    const lines = endpointLogs.lines().filter((line) => line.msg === 'agent tool call' && line.jobId === run.jobId);
    expect(lines.map((line) => line.code)).toEqual(['ok', 'invalid']);
    expect(lines[0]).toMatchObject({ tool: 'test-echo', tokenId: expect.stringMatching(/^[0-9a-f]{12}$/) });
  });
});

describe('回滚 0037', () => {
  it('删除计数表，之后再升级成功', async () => {
    await agentGw.close();
    await endpoint.close();
    await database.destroy();
    const owner = connect(testDb.ownerConfig);
    try {
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0042_agent_tool_scopes']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0041_job_pause_storage_quota']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0040_agent_workspace_snapshots']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0039_agent_questions']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0038_agent_failure_reports']);
      const down = await migrateDown(owner);
      expect(down.error).toBeUndefined();
      expect(down.results?.map((result) => result.migrationName)).toEqual(['0037_agent_tool_calls']);
      const { rows } = await sql<{ name: string | null }>`SELECT to_regclass('agent_tool_calls')::text AS name`.execute(superuser);
      expect(rows[0]!.name).toBeNull();
      expect((await migrateToLatest(owner)).error).toBeUndefined();
    } finally {
      await owner.destroy();
      database = createDatabase(testDb.appConfig);
      appDb = database.db;
    }
  });
});
