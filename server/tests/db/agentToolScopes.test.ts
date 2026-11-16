// Agent 当前阶段可用的业务工具（迁移 0042_agent_tool_scopes、src/agent/toolScope.ts、src/agent/tools.ts 的计数语句，
// 路线图第 8 步 8.6c1）对真实数据库的测试，请求经 agent-gw 转给 worker 的内部入口：
// 1. 没有写下阶段时所有业务工具 403 AGENT_TOOL_NOT_IN_STAGE、处理函数不执行、不计入；写下后放行（对照组）；
// 2. 切换阶段：只放行当前阶段的工具；切到空阶段后一律 403；
// 3. **绕过入口直接调用**（#91 确认，必做）：沙箱内的命令拿到令牌后直接向 agent-gw 发 POST /v1/tools/call——当前阶段以外的工具 403、
//    任务类型没有登记的工具 404、自称的组织 / 项目 / 任务 / 用户 400、其他项目的资源 404，都不执行、不越权；对照组为同一令牌调用当前阶段的工具成功；
// 4. 续跑：新执行不继承旧执行的阶段（403，直到执行者写下新的阶段）；旧执行的阶段不能再改；
// 5. setAgentToolScope：阶段的工具必须是任务类型登记的工具（否则 TypeError）；任务不在本次执行中、不是 Agent 任务时不写入；
// 6. RLS、授权与 CHECK；随任务删除；回滚 0042。
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import { runAgentPrompt, type AgentPromptRequest } from '../../src/agent/entry.ts';
import { buildAgentGateway } from '../../src/agent/gateway.ts';
import { AGENT_RELAY_KEY_HEADER } from '../../src/agent/token.ts';
import { issueAgentJobToken } from '../../src/agent/tokenStore.ts';
import { AGENT_TOOL_CALL_PATH, createAgentToolRegistry, resolveProjectArtifact, type AgentToolDefinition } from '../../src/agent/tools.ts';
import { AGENT_TOOL_SCOPE_MAX_TOOLS, setAgentToolScope } from '../../src/agent/toolScope.ts';
import { ARTIFACT_MIMES } from '../../src/artifacts/store.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { SandboxExecResult, SandboxRef } from '../../src/sandbox/driver.ts';
import { withOrgContext, withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { claimJob, finishRun, insertJob, type RunRef } from '../../src/jobs/store.ts';
import { createLogCapture } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;

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

/** 处理函数执行过的调用（工具名与任务），用于断言被拒绝的调用没有执行。 */
const executed: Array<{ tool: string; jobId: string }> = [];

const emptyArgs = { type: 'object', additionalProperties: false, properties: {} } as const;

function simpleTool(name: string): AgentToolDefinition {
  return {
    name,
    argumentsSchema: emptyArgs,
    maxArgumentBytes: 256,
    maxCallsPerJob: 1_000,
    maxCallsPerMinute: 600,
    async run(context) {
      executed.push({ tool: name, jobId: context.identity.jobId });
      return { tool: name };
    },
  };
}

const artifactTool: AgentToolDefinition<{ artifactId: string }> = {
  name: 'test-stage-artifact',
  argumentsSchema: { type: 'object', additionalProperties: false, required: ['artifactId'], properties: { artifactId: { type: 'string', maxLength: 64 } } },
  maxArgumentBytes: 1024,
  maxCallsPerJob: 1_000,
  maxCallsPerMinute: 600,
  async run(context, args) {
    const artifact = await withTenant(context.db, context.tenant, (trx) => resolveProjectArtifact(trx, context, args.artifactId));
    executed.push({ tool: 'test-stage-artifact', jobId: context.identity.jobId });
    return { name: artifact.name };
  },
};

const TOOLS = createAgentToolRegistry([simpleTool('test-stage-a'), simpleTool('test-stage-b'), simpleTool('test-stage-other'), artifactTool]);
const TYPE_TOOLS = ['test-stage-a', 'test-stage-b', 'test-stage-artifact'];
const TOOLS_BY_TYPE: Record<string, readonly string[]> = {
  'test-agent': TYPE_TOOLS,
  'test-agent-other': ['test-stage-other'],
};

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

async function runningJob(member: Member, options: { type?: string; projectId?: string } = {}): Promise<RunRef & { projectId: string }> {
  const projectId = options.projectId ?? (await newProject(member));
  const job = await insertJob(appDb, member.context, { type: options.type ?? 'test-agent', params: {}, projectId, agentLimits: AGENT_TASK_LIMITS.outline });
  return { ...(await claim(member, job.id)), projectId };
}

async function tokenOf(run: RunRef): Promise<string> {
  const issued = await issueAgentJobToken(appDb, run, TTL_MS);
  expect(issued).not.toBeNull();
  return issued!.token;
}

async function artifactIn(member: Member, projectId: string): Promise<string> {
  const row = await superuser
    .insertInto('artifacts')
    .values({
      org_id: member.orgId,
      project_id: projectId,
      kind: 'markdown',
      name: 'content.md',
      mime: ARTIFACT_MIMES.markdown[0]!,
      status: 'ready',
      size_bytes: 10,
      sha256: Buffer.alloc(32),
      completed_at: new Date(),
      created_by: member.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function call(token: string, payload: unknown, origin = gwOrigin): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (origin === endpointOrigin) headers[AGENT_RELAY_KEY_HEADER] = RELAY_KEY;
  const response = await fetch(`${origin}${AGENT_TOOL_CALL_PATH}`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

const callTool = (token: string, name: string, args: Record<string, unknown> = {}) => call(token, { name, arguments: args });

async function callCount(jobId: string, tool: string): Promise<number> {
  const row = await superuser.selectFrom('agent_tool_calls').select('calls').where('job_id', '=', jobId).where('tool', '=', tool).executeTakeFirst();
  return row?.calls ?? 0;
}

async function scopeRow(run: RunRef): Promise<string[] | undefined> {
  const row = await superuser.selectFrom('agent_tool_scopes').select('tools').where('job_id', '=', run.jobId).where('run_id', '=', run.runId).executeTakeFirst();
  return row?.tools as string[] | undefined;
}

function expectNotInStage(response: { status: number; body: Record<string, any> }, tool: string) {
  expect(response.status).toBe(403);
  expect(response.body.error).toMatchObject({ code: 'AGENT_TOOL_NOT_IN_STAGE', message: `当前阶段不能调用 ${tool}，请只使用当前阶段说明的工具。` });
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
    logStream: endpointLogs.stream,
    tools: TOOLS,
    toolsForJobType: (type) => TOOLS_BY_TYPE[type] ?? [],
  });
  await endpoint.listen({ host: '127.0.0.1', port: 0 });
  endpointOrigin = `http://127.0.0.1:${(endpoint.server.address() as AddressInfo).port}`;
  agentGw = await buildAgentGateway({ upstream: endpointOrigin, relayKey: RELAY_KEY, logLevel: 'info', logStream: gwLogs.stream });
  await agentGw.listen({ host: '127.0.0.1', port: 0 });
  gwOrigin = `http://127.0.0.1:${(agentGw.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await agentGw?.close();
  await endpoint?.close();
  await database?.destroy();
  await testDb?.drop();
});

describe('当前阶段的业务工具', () => {
  it('没有写下阶段时一律 403、不执行、不计入；写下后放行（对照组）', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    const token = await tokenOf(run);
    const before = executed.length;
    for (const name of TYPE_TOOLS) expectNotInStage(await callTool(token, name, name === 'test-stage-artifact' ? { artifactId: randomUUID() } : {}), name);
    expect(executed.length).toBe(before);
    for (const name of TYPE_TOOLS) expect(await callCount(run.jobId, name)).toBe(0);

    expect(await setAgentToolScope(appDb, run, ['test-stage-a'], TYPE_TOOLS)).toBe(true);
    const response = await callTool(token, 'test-stage-a');
    expect(response).toEqual({ status: 200, body: { result: { tool: 'test-stage-a' } } });
    expect(executed.slice(before)).toEqual([{ tool: 'test-stage-a', jobId: run.jobId }]);
    expect(await callCount(run.jobId, 'test-stage-a')).toBe(1);
    // 日志记下结果码，不记参数。
    const codes = endpointLogs.lines().filter((line) => line.msg === 'agent tool call' && line.jobId === run.jobId).map((line) => line.code);
    expect(codes).toEqual(['not-in-stage', 'not-in-stage', 'not-in-stage', 'ok']);
  });

  it('切换阶段：只放行当前阶段的工具；切到空阶段后一律 403；已计入的次数不受影响', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    const token = await tokenOf(run);
    expect(await setAgentToolScope(appDb, run, ['test-stage-a'], TYPE_TOOLS)).toBe(true);
    expect((await callTool(token, 'test-stage-a')).status).toBe(200);
    expectNotInStage(await callTool(token, 'test-stage-b'), 'test-stage-b');

    expect(await setAgentToolScope(appDb, run, ['test-stage-b'], TYPE_TOOLS)).toBe(true);
    expect(await scopeRow(run)).toEqual(['test-stage-b']);
    expect((await callTool(token, 'test-stage-b')).status).toBe(200);
    expectNotInStage(await callTool(token, 'test-stage-a'), 'test-stage-a');

    expect(await setAgentToolScope(appDb, run, ['test-stage-a', 'test-stage-b'], TYPE_TOOLS)).toBe(true);
    expect((await callTool(token, 'test-stage-a')).status).toBe(200);
    expect((await callTool(token, 'test-stage-b')).status).toBe(200);

    expect(await setAgentToolScope(appDb, run, [], TYPE_TOOLS)).toBe(true);
    expect(await scopeRow(run)).toEqual([]);
    expectNotInStage(await callTool(token, 'test-stage-a'), 'test-stage-a');
    expectNotInStage(await callTool(token, 'test-stage-b'), 'test-stage-b');
    expect(await callCount(run.jobId, 'test-stage-a')).toBe(2);
    expect(await callCount(run.jobId, 'test-stage-b')).toBe(2);
  });

  it('绕过入口直接调用 POST /v1/tools/call（#91）：阶段外 403、任务类型未登记 404、自称身份 400、其他项目的资源 404；对照组：当前阶段的工具成功', async () => {
    const victim = await newMember();
    const victimRun = await runningJob(victim);
    const victimArtifact = await artifactIn(victim, victimRun.projectId);
    const member = await newMember();
    const run = await runningJob(member);
    const otherProjectArtifact = await artifactIn(member, await newProject(member));
    const ownArtifact = await artifactIn(member, run.projectId);
    // 沙箱内的命令拿到的就是入口用的同一个令牌；入口只为当前阶段登记了 test-stage-artifact 的桩。
    const token = await tokenOf(run);
    expect(await setAgentToolScope(appDb, run, ['test-stage-artifact'], TYPE_TOOLS)).toBe(true);
    const before = executed.length;

    // 当前阶段以外、但任务类型登记了的工具：403（只有 worker 一侧的阶段限制拦得住）。
    expectNotInStage(await callTool(token, 'test-stage-a'), 'test-stage-a');
    expectNotInStage(await callTool(token, 'test-stage-b'), 'test-stage-b');
    // 任务类型没有登记的工具、未登记的工具名：404。
    for (const name of ['test-stage-other', 'report-failure', 'ask-user', 'no-such-tool']) {
      const response = await callTool(token, name);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('AGENT_TOOL_NOT_FOUND');
    }
    // 自称其他组织 / 项目 / 任务 / 用户：400，不执行。
    for (const extra of [{ org_id: victim.orgId }, { project_id: victimRun.projectId }, { job_id: victimRun.jobId }, { user_id: victim.userId }]) {
      const response = await call(token, { name: 'test-stage-artifact', arguments: { artifactId: ownArtifact }, ...extra });
      expect(response.status).toBe(400);
    }
    const nested = await callTool(token, 'test-stage-artifact', { artifactId: ownArtifact, projectId: victimRun.projectId });
    expect(nested.status).toBe(400);
    // 其他组织、本组织其他项目的资源：404。
    for (const artifactId of [victimArtifact, otherProjectArtifact]) {
      const response = await callTool(token, 'test-stage-artifact', { artifactId });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('AGENT_RESOURCE_NOT_FOUND');
    }
    // 直接打 worker 的内部入口（网络配置出错时）同样被拦住。
    expectNotInStage(await call(token, { name: 'test-stage-a', arguments: {} }, endpointOrigin), 'test-stage-a');
    expect(executed.slice(before)).toEqual([]);
    expect(await callCount(run.jobId, 'test-stage-a')).toBe(0);

    // 对照组：同一令牌调用当前阶段的工具、本项目的资源成功。
    const ok = await callTool(token, 'test-stage-artifact', { artifactId: ownArtifact });
    expect(ok).toEqual({ status: 200, body: { result: { name: 'content.md' } } });
    expect(executed.slice(before)).toEqual([{ tool: 'test-stage-artifact', jobId: run.jobId }]);
    // 受害组织没有任何计数与阶段记录。
    expect(await superuser.selectFrom('agent_tool_calls').select('tool').where('org_id', '=', victim.orgId).execute()).toEqual([]);
    expect(await superuser.selectFrom('agent_tool_scopes').select('job_id').where('org_id', '=', victim.orgId).execute()).toEqual([]);
  });

  it('续跑：新执行不继承旧执行的阶段；旧执行的阶段不能再改', async () => {
    const member = await newMember();
    const first = await runningJob(member);
    expect(await setAgentToolScope(appDb, first, ['test-stage-a'], TYPE_TOOLS)).toBe(true);
    // 执行中止（如 worker 关闭），任务回到队列后由新的执行接手。
    expect(await finishRun(appDb, first, { kind: 'interrupted' }, true)).toBe('queued');
    const second = await claim(member, first.jobId);
    const token = await tokenOf(second);
    expectNotInStage(await callTool(token, 'test-stage-a'), 'test-stage-a');
    // 旧执行的阶段不能再改（RLS：任务的 run_id 已不是它）。
    expect(await setAgentToolScope(appDb, first, ['test-stage-a', 'test-stage-b'], TYPE_TOOLS)).toBe(false);
    expect(await scopeRow(first)).toEqual(['test-stage-a']);
    await expect(
      withOrgContext(appDb, member.orgId, (trx) => sql`UPDATE agent_tool_scopes SET tools = ARRAY['test-stage-b'] WHERE job_id = ${first.jobId}::uuid`.execute(trx)),
    ).resolves.toMatchObject({ numAffectedRows: 0n });
    expect(await scopeRow(first)).toEqual(['test-stage-a']);

    expect(await setAgentToolScope(appDb, second, ['test-stage-a'], TYPE_TOOLS)).toBe(true);
    expect((await callTool(token, 'test-stage-a')).status).toBe(200);
  });
});

describe('setAgentToolScope', () => {
  it('阶段的工具必须是任务类型登记的、不重复的工具名，否则 TypeError、不写入', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    for (const tools of [['test-stage-other'], ['test-stage-a', 'test-stage-a'], ['Bad'], [''], [1 as never], Array.from({ length: AGENT_TOOL_SCOPE_MAX_TOOLS + 1 }, (_, i) => `tool-${i}`)]) {
      await expect(setAgentToolScope(appDb, run, tools, [...TYPE_TOOLS, ...tools.filter((name) => typeof name === 'string' && name.startsWith('tool-'))])).rejects.toThrow(TypeError);
    }
    expect(await scopeRow(run)).toBeUndefined();
  });

  it('任务不在本次执行中（run_id 不符、已结束）、不是登记了上限的 Agent 任务时不写入，返回 false', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    expect(await setAgentToolScope(appDb, { ...run, runId: randomUUID() }, ['test-stage-a'], TYPE_TOOLS)).toBe(false);
    // 其他组织的上下文写不进来（RLS）。
    const other = await newMember();
    expect(await setAgentToolScope(appDb, { ...run, orgId: other.orgId }, ['test-stage-a'], TYPE_TOOLS)).toBe(false);
    expect(await scopeRow(run)).toBeUndefined();

    const project = await newProject(member);
    const plain = await insertJob(appDb, member.context, { type: 'test-plain', params: {}, projectId: project });
    const plainRun = await claim(member, plain.id);
    expect(await setAgentToolScope(appDb, plainRun, ['test-stage-a'], TYPE_TOOLS)).toBe(false);

    expect(await finishRun(appDb, run, { kind: 'succeeded' }, true)).toBe('succeeded');
    expect(await setAgentToolScope(appDb, run, ['test-stage-a'], TYPE_TOOLS)).toBe(false);
    expect(await superuser.selectFrom('agent_tool_scopes').select('job_id').where('job_id', 'in', [run.jobId, plain.id]).execute()).toEqual([]);
  });
});

describe('runAgentPrompt', () => {
  const SESSION = '2026-11-16T00-00-00-000Z_01234567-89ab-4def-8123-456789abcdef.jsonl';
  const sandbox: SandboxRef = { id: 'sandbox', template: 'agent', jobId: 'job', expiresAt: new Date() };

  function fakeDriver(onExec: () => Promise<void> | void) {
    const inputs: Buffer[] = [];
    return {
      inputs,
      async exec(_ref: SandboxRef, _command: string, _args: readonly string[], options: { input?: Buffer } = {}): Promise<SandboxExecResult> {
        inputs.push(options.input!);
        await onExec();
        const stdout = `${JSON.stringify({ version: 1, ok: true, action: 'prompt', session: SESSION, turns: 1, stopReason: 'stop' })}\n`;
        return { exitCode: 0, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false };
      },
    };
  }

  it('先写下请求中的业务工具作为本阶段（入口执行时已生效），再执行入口；任务不在本次执行中时不执行、返回 RUN_ENDED', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    const token = await tokenOf(run);
    const request: AgentPromptRequest = { action: 'prompt', token, prompt: '生成目录', session: null, tools: ['read', 'bash', 'test-stage-a' as never], maxTurns: 5, model: { contextWindow: 128_000, maxOutputTokens: 8_192 } };
    // 入口只认得 ask-user / report-failure / request-termination：其他名字在编码时即拒绝，不写阶段。
    await expect(runAgentPrompt(appDb, fakeDriver(() => {}), sandbox, run, request, TYPE_TOOLS)).rejects.toThrow(TypeError);
    expect(await scopeRow(run)).toBeUndefined();

    const allowed = ['ask-user', 'report-failure'];
    let scopeDuringExec: string[] | undefined;
    const driver = fakeDriver(async () => {
      scopeDuringExec = await scopeRow(run);
    });
    const result = await runAgentPrompt(appDb, driver, sandbox, run, { ...request, tools: ['read', 'ask-user'] }, allowed);
    expect(result).toEqual({ ok: true, action: 'prompt', session: SESSION, turns: 1, stopReason: 'stop' });
    expect(scopeDuringExec).toEqual(['ask-user']);
    // 下一条提示词换阶段：只有 report-failure。
    await runAgentPrompt(appDb, driver, sandbox, run, { ...request, tools: ['report-failure'] }, allowed);
    expect(scopeDuringExec).toEqual(['report-failure']);
    // 没有业务工具的提示词：阶段为空。
    await runAgentPrompt(appDb, driver, sandbox, run, { ...request, tools: ['read'] }, allowed);
    expect(scopeDuringExec).toEqual([]);
    expect(driver.inputs).toHaveLength(3);
    // 任务类型没有登记的业务工具：TypeError，不执行。
    await expect(runAgentPrompt(appDb, driver, sandbox, run, { ...request, tools: ['request-termination'] }, allowed)).rejects.toThrow(TypeError);
    expect(driver.inputs).toHaveLength(3);

    expect(await finishRun(appDb, run, { kind: 'interrupted' }, true)).toBe('queued');
    expect(await runAgentPrompt(appDb, driver, sandbox, run, { ...request, tools: ['ask-user'] }, allowed)).toEqual({ ok: false, code: 'RUN_ENDED' });
    expect(driver.inputs).toHaveLength(3);
  });
});

describe('RLS、授权与约束', () => {
  it('应用角色：不能为其他组织、不在执行中的任务写入；不能改标识列；没有 DELETE；只看得到本组织的行', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    expect(await setAgentToolScope(appDb, run, ['test-stage-a'], TYPE_TOOLS)).toBe(true);
    const other = await newMember();
    const otherRun = await runningJob(other);
    const asOrg = <T>(orgId: string, fn: (trx: any) => Promise<T>) => withOrgContext(appDb, orgId, fn);

    // 其他组织的任务、本组织但 run_id 不符：RLS 拒绝写入。
    await expect(asOrg(member.orgId, (trx) => sql`INSERT INTO agent_tool_scopes (org_id, job_id, run_id, tools) VALUES (${other.orgId}::uuid, ${otherRun.jobId}::uuid, ${otherRun.runId}::uuid, '{}')`.execute(trx))).rejects.toThrow(/row-level security/);
    await expect(asOrg(member.orgId, (trx) => sql`INSERT INTO agent_tool_scopes (org_id, job_id, run_id, tools) VALUES (${member.orgId}::uuid, ${run.jobId}::uuid, ${randomUUID()}::uuid, '{}')`.execute(trx))).rejects.toThrow(/row-level security/);
    // 标识列没有 UPDATE 授权；没有 DELETE 授权；updated_at 不能直接写入。
    for (const set of [`run_id = '${randomUUID()}'`, `job_id = '${otherRun.jobId}'`, `org_id = '${other.orgId}'`]) {
      await expect(asOrg(member.orgId, (trx) => sql`UPDATE agent_tool_scopes SET ${sql.raw(set)} WHERE job_id = ${run.jobId}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    }
    await expect(asOrg(member.orgId, (trx) => sql`DELETE FROM agent_tool_scopes WHERE job_id = ${run.jobId}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(asOrg(member.orgId, (trx) => sql`INSERT INTO agent_tool_scopes (org_id, job_id, run_id, tools, updated_at) VALUES (${member.orgId}::uuid, ${run.jobId}::uuid, ${run.runId}::uuid, '{}', now())`.execute(trx))).rejects.toThrow(/permission denied/);
    // 其他组织改不了、看不到本组织的行。
    await expect(asOrg(other.orgId, (trx) => sql`UPDATE agent_tool_scopes SET tools = '{}' WHERE job_id = ${run.jobId}::uuid`.execute(trx))).resolves.toMatchObject({ numAffectedRows: 0n });
    expect(await asOrg(other.orgId, (trx) => trx.selectFrom('agent_tool_scopes').select('job_id').execute())).toEqual([]);
    expect(await asOrg(member.orgId, (trx) => trx.selectFrom('agent_tool_scopes').select('tools').execute())).toEqual([{ tools: ['test-stage-a'] }]);
    expect(await scopeRow(run)).toEqual(['test-stage-a']);
  });

  it('CHECK：工具名须符合格式、不能有 NULL、至多 32 个、只能是一维数组', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    const write = (tools: string) =>
      withOrgContext(appDb, member.orgId, (trx) => sql`INSERT INTO agent_tool_scopes (org_id, job_id, run_id, tools) VALUES (${member.orgId}::uuid, ${run.jobId}::uuid, ${run.runId}::uuid, ${sql.raw(tools)})`.execute(trx));
    const tooMany = `ARRAY[${Array.from({ length: AGENT_TOOL_SCOPE_MAX_TOOLS + 1 }, (_, i) => `'tool-${i}'`).join(',')}]`;
    for (const tools of [`ARRAY['Bad']`, `ARRAY['a']`, `ARRAY['ok-tool', NULL]`, `ARRAY[NULL]::text[]`, `ARRAY['ok,tool']`, `ARRAY[['test-stage-a'],['test-stage-b']]`, tooMany]) {
      await expect(write(tools)).rejects.toThrow(/agent_tool_scopes_tools_check/);
    }
    const max = `ARRAY[${Array.from({ length: AGENT_TOOL_SCOPE_MAX_TOOLS }, (_, i) => `'tool-${i}'`).join(',')}]`;
    await expect(write(max)).resolves.toBeDefined();
  });

  it('随任务记录删除', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    expect(await setAgentToolScope(appDb, run, ['test-stage-a'], TYPE_TOOLS)).toBe(true);
    await superuser.deleteFrom('jobs').where('id', '=', run.jobId).execute();
    expect(await scopeRow(run)).toBeUndefined();
  });
});

describe('回滚 0042', () => {
  it('删除阶段表，之后再升级成功', async () => {
    await agentGw.close();
    await endpoint.close();
    await database.destroy();
    const owner = connect(testDb.ownerConfig);
    try {
      const down = await migrateDown(owner);
      expect(down.error).toBeUndefined();
      expect(down.results?.map((result) => result.migrationName)).toEqual(['0042_agent_tool_scopes']);
      const { rows } = await sql<{ name: string | null }>`SELECT to_regclass('agent_tool_scopes')::text AS name`.execute(superuser);
      expect(rows[0]!.name).toBeNull();
      expect((await migrateToLatest(owner)).error).toBeUndefined();
    } finally {
      await owner.destroy();
    }
  });
});
