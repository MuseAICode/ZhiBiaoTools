// Agent 报告无法继续（report-failure：src/agent/reportFailureTool.ts、src/agent/failureReport.ts、迁移 0038_agent_failure_reports，
// 路线图第 8 步 8.4b）对真实数据库的测试，工具调用经 agent-gw 转给 worker 的内部入口：
// - 对照组：报告写入规范化后的纯文本原因，返回 { reported: true }，通知执行者；身份只按令牌（只影响令牌的任务与本次执行）；
// - 原因：控制字符、双向文本与零宽字符被去掉，只有空白时 400（不写入），超长、缺少、多出字段 400；任务类型未登记该工具时 404；
// - 报告之后：本次执行的工具调用与模型调用一律 409，原因只记第一次；令牌失效时 401；
// - 结束：续租发现报告；除成功外的各种结果都以 AGENT_REPORTED_FAILURE 失败、已请求取消的仍为取消；失联后对账收回时同样失败；
//   旧执行的报告不影响续跑后的新执行；
// - 执行者端到端：执行中的 Agent 任务在报告后经控制频道立即中止并失败（不等定期续租），令牌随之失效；
// - 报告表的 RLS、授权与约束；日志中没有令牌与原因；回滚 0038。
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS, beginAgentTurn } from '../../src/agent/budget.ts';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import { AGENT_REPORTED_FAILURE_CODE, normalizeAgentFailureReason } from '../../src/agent/failureReport.ts';
import { buildAgentGateway } from '../../src/agent/gateway.ts';
import { reportFailureTool } from '../../src/agent/reportFailureTool.ts';
import { AGENT_RELAY_KEY_HEADER } from '../../src/agent/token.ts';
import { issueAgentJobToken, lookupAgentJobToken } from '../../src/agent/tokenStore.ts';
import { AGENT_TOOL_CALL_PATH, createAgentToolRegistry, type AgentToolDefinition } from '../../src/agent/tools.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { createEventPublisher, type EventPublisher } from '../../src/events/publisher.ts';
import { createJobTypeRegistry, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../src/jobs/runner.ts';
import { enqueueJob } from '../../src/jobs/service.ts';
import {
  claimJob,
  finishRun,
  insertJob,
  listJobEvents,
  recoverJob,
  renewRun,
  requestCancel,
  requestPause,
  type RunOutcome,
  type RunRef,
} from '../../src/jobs/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { createLogCapture } from '../helpers.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;
const REASON_MARKER = 'reason-marker-5d1e8b';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let endpoint: FastifyInstance;
let endpointOrigin: string;
let agentGw: FastifyInstance;
let gwOrigin: string;
let redis: Redis;
let prefix: string;
let publisher: EventPublisher;
const endpointLogs = createLogCapture();
const gwLogs = createLogCapture();
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];
/** 内部入口收到的“通知执行者”（任务 id）。 */
const notified: string[] = [];

const echoTool: AgentToolDefinition<{ text: string }> = {
  name: 'test-echo',
  argumentsSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 100 } } },
  maxArgumentBytes: 512,
  maxCallsPerJob: 1_000,
  maxCallsPerMinute: 600,
  run: async (_context, args) => ({ text: args.text }),
};

const TOOLS = createAgentToolRegistry([reportFailureTool, echoTool]);
const TOOLS_BY_TYPE: Record<string, readonly string[]> = {
  'test-agent': ['report-failure', 'test-echo'],
  'test-agent-hold': ['report-failure', 'test-echo'],
  'test-agent-noreport': ['test-echo'],
};

/** 假 Agent：一直运行到被中止（不调用模型）。 */
const agentHold: JobTypeDefinition<Record<string, never>> = {
  type: 'test-agent-hold',
  queue: 'agent',
  resumable: true,
  agentLimits: AGENT_TASK_LIMITS.outline,
  agentTools: ['report-failure', 'test-echo'],
  parseParams: () => ({}),
  run: (context: JobContext<Record<string, never>>) =>
    new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
};
const registry = createJobTypeRegistry([agentHold]);

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

async function runningJob(member: Member, options: { type?: string; agent?: boolean } = {}): Promise<RunRef> {
  const projectId = await newProject(member);
  const job = await insertJob(appDb, member.context, {
    type: options.type ?? 'test-agent',
    params: {},
    projectId,
    agentLimits: options.agent === false ? null : AGENT_TASK_LIMITS.outline,
  });
  const runId = randomUUID();
  const result = await claimJob(appDb, { orgId: member.orgId, jobId: job.id, runId, leaseMs: LEASE_MS, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 });
  expect(result.kind).toBe('claimed');
  return { orgId: member.orgId, jobId: job.id, runId };
}

async function tokenFor(member: Member, options: { type?: string } = {}) {
  const run = await runningJob(member, options);
  const issued = await issueAgentJobToken(appDb, run, TTL_MS);
  expect(issued).not.toBeNull();
  return { run, token: issued!.token };
}

async function call(token: string, payload: unknown, origin = gwOrigin): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (origin === endpointOrigin) headers[AGENT_RELAY_KEY_HEADER] = RELAY_KEY;
  const response = await fetch(`${origin}${AGENT_TOOL_CALL_PATH}`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

const report = (token: string, reason: unknown) => call(token, { name: 'report-failure', arguments: { reason } });

async function reportsOf(jobId: string) {
  return superuser.selectFrom('agent_failure_reports').select(['org_id', 'run_id', 'reason']).where('job_id', '=', jobId).orderBy('created_at').execute();
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').select(['status', 'error_code', 'error_message', 'pause_reason', 'run_id']).where('id', '=', jobId).executeTakeFirstOrThrow();
}

async function asApp<T>(member: Member, fn: (trx: any) => Promise<T>): Promise<T> {
  return withTenant(appDb, member.context, fn);
}

/** 直接写入一份报告（经应用角色与 RLS），用于结束与对账的用例。 */
async function insertReport(member: Member, run: RunRef, reason: string) {
  await asApp(member, (trx) => trx.insertInto('agent_failure_reports').values({ org_id: run.orgId, job_id: run.jobId, run_id: run.runId, reason }).execute());
}

async function startServers() {
  endpoint = await buildAgentEndpointApp({
    db: appDb,
    relayKey: RELAY_KEY,
    logLevel: 'info',
    logStream: endpointLogs.stream,
    tools: TOOLS,
    toolsForJobType: (type) => TOOLS_BY_TYPE[type] ?? [],
    notifyJobControl: async (jobId) => {
      notified.push(jobId);
      await publisher.notifyJobControl(jobId);
    },
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
  redis = rawRedis();
  prefix = uniquePrefix();
  publisher = createEventPublisher(redisConfig(), { log: testLogger().log, connectionName: 'test-failure-report-publisher', keyPrefix: prefix, queuePrefix: prefix });
  await startServers();
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await wipeQueueKeys(redis, prefix);
});

afterAll(async () => {
  await agentGw?.close();
  await endpoint?.close();
  await publisher?.close();
  redis?.disconnect();
  await database?.destroy();
  await testDb?.drop();
});

describe('规范化（纯函数）', () => {
  const ch = (code: number) => String.fromCodePoint(code);

  it('去掉控制字符、双向文本与零宽字符，换行统一、制表符改空格，空行至多一个，首尾去空白', () => {
    const raw = `  招标文件${ch(0)}缺少${ch(0x202e)}评分${ch(0x200b)}办法${ch(0xfeff)}${ch(0x7)}\r\n\r\n\r\n\r\n请补充\t后重试${ch(0x2028)}  \n `;
    expect(normalizeAgentFailureReason(raw)).toBe('招标文件缺少评分办法\n\n请补充 后重试');
  });

  it('只有空白与不可见字符 → 空串；超长按码点截断（不拆开代理对）', () => {
    expect(normalizeAgentFailureReason(` \n\t${ch(0x200b)}${ch(0x2066)} `)).toBe('');
    const long = '𠀀'.repeat(600);
    const normalized = normalizeAgentFailureReason(long);
    expect(Array.from(normalized)).toHaveLength(500);
    expect(normalized).toBe('𠀀'.repeat(500));
  });

  it('HTML 与 Markdown 原样保留为文本（不转义、不解析，显示时按纯文本输出）', () => {
    expect(normalizeAgentFailureReason('<script>alert(1)</script> [链接](javascript:alert(1))')).toBe('<script>alert(1)</script> [链接](javascript:alert(1))');
  });
});

describe('report-failure 工具', () => {
  it('对照组：写入规范化后的原因，返回 { reported: true }，通知执行者；只影响令牌的任务与本次执行', async () => {
    const member = await newMember();
    const other = await runningJob(member);
    const { run, token } = await tokenFor(member);
    const response = await report(token, `  招标文件缺少评分办法${String.fromCodePoint(0x202e)}，请补充后重试  `);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: { reported: true } });
    expect(await reportsOf(run.jobId)).toEqual([{ org_id: member.orgId, run_id: run.runId, reason: '招标文件缺少评分办法，请补充后重试' }]);
    expect(await reportsOf(other.jobId)).toEqual([]);
    expect(notified).toContain(run.jobId);
    expect(await renewRun(appDb, run, LEASE_MS)).toMatchObject({ status: 'running', agentFailureReported: true });
    expect(await renewRun(appDb, other, LEASE_MS)).toMatchObject({ status: 'running', agentFailureReported: false });
  });

  it('参数：只有空白 → 400、不写入；超长、缺少、类型不对、多出字段（含自称的任务）→ 400', async () => {
    const member = await newMember();
    const victim = await runningJob(member);
    const { run, token } = await tokenFor(member);
    const blank = await report(token, ` \n${String.fromCodePoint(0x200b)}\t`);
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('AGENT_TOOL_INVALID_ARGUMENTS');
    for (const payload of [
      { name: 'report-failure', arguments: { reason: 'a'.repeat(501) } },
      { name: 'report-failure', arguments: {} },
      { name: 'report-failure', arguments: { reason: 1 } },
      { name: 'report-failure', arguments: { reason: '' } },
      { name: 'report-failure', arguments: { reason: 'x', job_id: victim.jobId } },
      { name: 'report-failure', arguments: { reason: 'x' }, job_id: victim.jobId },
    ]) {
      const response = await call(token, payload);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AGENT_TOOL_INVALID_ARGUMENTS');
    }
    expect(await reportsOf(run.jobId)).toEqual([]);
    expect(await reportsOf(victim.jobId)).toEqual([]);
    // 500 个字符恰好可以（对照组）。
    expect((await report(token, '缺'.repeat(500))).status).toBe(200);
    expect((await reportsOf(run.jobId))[0]!.reason).toBe('缺'.repeat(500));
  });

  it('任务类型没有登记 report-failure → 404，不写入', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member, { type: 'test-agent-noreport' });
    const response = await report(token, '无法继续');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('AGENT_TOOL_NOT_FOUND');
    expect(await reportsOf(run.jobId)).toEqual([]);
  });

  it('报告之后：本次执行的工具调用（含再次报告）与模型调用一律 409，原因只记第一次', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    expect((await call(token, { name: 'test-echo', arguments: { text: 'a' } })).status).toBe(200);
    expect((await report(token, '第一次的原因')).status).toBe(200);

    const again = await report(token, '第二次的原因');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('JOB_NOT_RUNNING');
    const echo = await call(token, { name: 'test-echo', arguments: { text: 'a' } });
    expect(echo.status).toBe(409);
    expect(echo.body.error.code).toBe('JOB_NOT_RUNNING');
    expect(await reportsOf(run.jobId)).toEqual([{ org_id: member.orgId, run_id: run.runId, reason: '第一次的原因' }]);
    // 次数没有因被拒绝的调用增加。
    expect(await superuser.selectFrom('agent_tool_calls').select(['tool', 'calls']).where('job_id', '=', run.jobId).orderBy('tool').execute()).toEqual([
      { tool: 'report-failure', calls: 1 },
      { tool: 'test-echo', calls: 1 },
    ]);

    const turn = await beginAgentTurn(appDb, { tenant: member.context, jobId: run.jobId, runId: run.runId }).catch((error: unknown) => error);
    expect(turn).toMatchObject({ statusCode: 409, code: 'JOB_NOT_RUNNING' });
    const budget = await superuser.selectFrom('agent_job_budgets').select(['turns_used', 'exhausted_reason']).where('job_id', '=', run.jobId).executeTakeFirstOrThrow();
    expect(budget).toEqual({ turns_used: 0, exhausted_reason: null });
  });

  it('报告之后第一次调用的工具同样 409，不留下计数', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    expect((await report(token, '无法继续')).status).toBe(200);
    const echo = await call(token, { name: 'test-echo', arguments: { text: 'a' } });
    expect(echo.status).toBe(409);
    expect(await superuser.selectFrom('agent_tool_calls').select('tool').where('job_id', '=', run.jobId).execute()).toEqual([{ tool: 'report-failure' }]);
  });

  it('对照组：没有报告的任务照常计入模型调用', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    expect(await beginAgentTurn(appDb, { tenant: member.context, jobId: run.jobId, runId: run.runId })).toMatchObject({ turnsUsed: 1 });
  });

  it('令牌失效（请求暂停后）→ 401，不写入', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    await requestPause(appDb, member.context, run.jobId);
    expect((await report(token, '无法继续')).status).toBe(401);
    expect(await reportsOf(run.jobId)).toEqual([]);
  });

  it('日志中没有令牌原文与原因', async () => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    expect((await report(token, `无法继续 ${REASON_MARKER}`)).status).toBe(200);
    const logs = endpointLogs.text() + gwLogs.text();
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(REASON_MARKER);
    const lines = endpointLogs.lines().filter((line) => line.jobId === run.jobId && (line.msg === 'agent tool call' || line.msg === 'agent reported failure'));
    expect(lines.map((line) => line.msg)).toEqual(['agent reported failure', 'agent tool call']);
  });
});

describe('结束任务', () => {
  const outcomes: RunOutcome[] = [
    { kind: 'interrupted' },
    { kind: 'failed', code: 'JOB_FAILED', message: '任务执行失败' },
    { kind: 'insufficient-balance' },
    { kind: 'task-limit', reason: 'task_turn_limit' },
    { kind: 'agent-runtime-limit' },
  ];

  it.each(outcomes)('有报告时，结果 %o → 失败（AGENT_REPORTED_FAILURE，失败说明为报告的原因），事件记下错误码', async (outcome) => {
    const member = await newMember();
    const { run, token } = await tokenFor(member);
    await insertReport(member, run, '资料不足，无法继续');
    expect(await finishRun(appDb, run, outcome, true)).toBe('failed');
    expect(await jobRow(run.jobId)).toMatchObject({ status: 'failed', error_code: AGENT_REPORTED_FAILURE_CODE, error_message: '资料不足，无法继续', pause_reason: null, run_id: null });
    const events = await listJobEvents(appDb, member.context, run.jobId, 1);
    expect(events[0]).toMatchObject({ kind: 'failed', data: { code: AGENT_REPORTED_FAILURE_CODE } });
    // 任务结束后令牌失效。
    expect(await lookupAgentJobToken(appDb, token)).toBeNull();
  });

  it('对照组：没有报告时，中止按原规则回到 queued，达到上限按原规则暂停', async () => {
    const member = await newMember();
    const interrupted = await runningJob(member);
    expect(await finishRun(appDb, interrupted, { kind: 'interrupted' }, true)).toBe('queued');
    const limited = await runningJob(member);
    expect(await finishRun(appDb, limited, { kind: 'task-limit', reason: 'task_turn_limit' }, true)).toBe('paused');
  });

  it('已请求取消的仍为取消；执行者按成功返回时为成功', async () => {
    const member = await newMember();
    const cancelled = await runningJob(member);
    await insertReport(member, cancelled, '无法继续');
    await requestCancel(appDb, member.context, cancelled.jobId);
    expect(await finishRun(appDb, cancelled, { kind: 'interrupted' }, true)).toBe('cancelled');
    const succeeded = await runningJob(member);
    await insertReport(member, succeeded, '无法继续');
    expect(await finishRun(appDb, succeeded, { kind: 'succeeded' }, true)).toBe('succeeded');
  });

  it('执行者失联后对账收回：有报告时失败、不再续跑；没有报告时回到 queued（对照组）；旧执行的报告不影响新执行', async () => {
    const member = await newMember();
    const reported = await runningJob(member);
    await insertReport(member, reported, '无法继续');
    const silent = await runningJob(member);
    await superuser.updateTable('jobs').set({ lease_expires_at: sql`now() - interval '1 second'` }).where('id', 'in', [reported.jobId, silent.jobId]).execute();
    const resumable = () => true;
    expect(await recoverJob(appDb, { orgId: member.orgId, id: reported.jobId }, resumable)).toEqual({ kind: 'none', changed: true });
    expect(await jobRow(reported.jobId)).toMatchObject({ status: 'failed', error_code: AGENT_REPORTED_FAILURE_CODE, error_message: '无法继续' });
    expect(await recoverJob(appDb, { orgId: member.orgId, id: silent.jobId }, resumable)).toMatchObject({ kind: 'dispatch', changed: true });

    // 旧执行留下的报告：续跑后的新执行不受影响（报告按 run_id 区分）。
    const oldRun = await runningJob(member);
    await insertReport(member, oldRun, '旧执行的原因');
    await superuser.updateTable('jobs').set({ status: 'queued', run_id: null, lease_expires_at: null }).where('id', '=', oldRun.jobId).execute();
    const newRunId = randomUUID();
    expect((await claimJob(appDb, { orgId: member.orgId, jobId: oldRun.jobId, runId: newRunId, leaseMs: LEASE_MS, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 })).kind).toBe('claimed');
    const newRun = { orgId: member.orgId, jobId: oldRun.jobId, runId: newRunId };
    expect(await renewRun(appDb, newRun, LEASE_MS)).toMatchObject({ agentFailureReported: false });
    expect(await beginAgentTurn(appDb, { tenant: member.context, jobId: newRun.jobId, runId: newRun.runId })).toMatchObject({ turnsUsed: 1 });
    expect(await finishRun(appDb, newRun, { kind: 'interrupted' }, true)).toBe('queued');
  });
});

describe('执行者端到端', () => {
  it('执行中的 Agent 任务报告后经控制频道立即中止并失败（不等定期续租），令牌随之失效', async () => {
    const logs = testLogger();
    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-failure-report-dispatch'), prefix });
    dispatchers.push(dispatcher);
    const runner = createJobRunner({
      db: appDb,
      registry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'test-failure-report-worker'),
      log: logs.log,
      prefix,
      // 定期续租间隔远长于等待时间：任务能及时结束只能是控制频道触发的续租。
      leaseMs: 120_000,
      heartbeatMs: 60_000,
      reconcileIntervalMs: 600_000,
      concurrency: { agent: 2 },
    });
    runners.push(runner);
    await runner.start();

    const member = await newMember();
    const projectId = await newProject(member);
    const job = await enqueueJob({ db: appDb, registry, dispatcher, log: logs.log }, member.context, { type: agentHold.type, params: {}, projectId });
    const runId = await waitFor(async () => (await jobRow(job.id)).run_id, 15_000, '任务开始执行');
    const issued = await issueAgentJobToken(appDb, { orgId: member.orgId, jobId: job.id, runId }, TTL_MS);
    expect(issued).not.toBeNull();
    expect((await call(issued!.token, { name: 'test-echo', arguments: { text: 'a' } })).status).toBe(200);

    expect((await report(issued!.token, '招标文件没有技术评分表，无法生成目录')).status).toBe(200);
    const finished = await waitFor(async () => {
      const row = await jobRow(job.id);
      return row.status === 'failed' ? row : null;
    }, 10_000, '任务失败');
    expect(finished).toMatchObject({ error_code: AGENT_REPORTED_FAILURE_CODE, error_message: '招标文件没有技术评分表，无法生成目录' });
    expect(await lookupAgentJobToken(appDb, issued!.token)).toBeNull();
    expect((await call(issued!.token, { name: 'test-echo', arguments: { text: 'a' } })).status).toBe(401);
  });
});

describe('报告表的数据库约束', () => {
  it('RLS：其他组织看不到、不能为其他组织的任务写入', async () => {
    const member = await newMember();
    const stranger = await newMember();
    const run = await runningJob(member);
    await insertReport(member, run, '无法继续');
    expect(await asApp(stranger, (trx) => trx.selectFrom('agent_failure_reports').selectAll().where('job_id', '=', run.jobId).execute())).toEqual([]);
    expect(await asApp(member, (trx) => trx.selectFrom('agent_failure_reports').select('reason').where('job_id', '=', run.jobId).execute())).toEqual([{ reason: '无法继续' }]);
    const other = await runningJob(member);
    await expect(insertReport(stranger, other, '无法继续')).rejects.toThrow(/row-level security/);
    await expect(
      asApp(stranger, (trx) => trx.insertInto('agent_failure_reports').values({ org_id: stranger.orgId, job_id: other.jobId, run_id: other.runId, reason: 'x' }).execute()),
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it('只能为 running、run_id 相符的 Agent 任务写入；同一次执行只能一行', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    await expect(insertReport(member, { ...run, runId: randomUUID() }, '无法继续')).rejects.toThrow(/row-level security/);
    const plain = await runningJob(member, { type: 'test-plain', agent: false });
    await expect(insertReport(member, plain, '无法继续')).rejects.toThrow(/row-level security/);
    const paused = await runningJob(member);
    await requestPause(appDb, member.context, paused.jobId);
    await finishRun(appDb, paused, { kind: 'interrupted' }, true);
    await expect(insertReport(member, paused, '无法继续')).rejects.toThrow(/row-level security/);
    await insertReport(member, run, '第一次');
    await expect(insertReport(member, run, '第二次')).rejects.toThrow(/agent_failure_reports_pkey/);
  });

  it('原因的约束：空、超长、首尾空白被拒绝', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    for (const reason of ['', 'a'.repeat(501), ' 前面有空格', '后面有空格 ']) {
      await expect(insertReport(member, run, reason)).rejects.toThrow(/agent_failure_reports_reason_check/);
    }
  });

  it('授权：应用角色只有 SELECT 与 INSERT（指定列），不能改写或撤回报告', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    await insertReport(member, run, '无法继续');
    await expect(asApp(member, (trx) => sql`UPDATE agent_failure_reports SET reason = '改写' WHERE job_id = ${run.jobId}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(asApp(member, (trx) => sql`DELETE FROM agent_failure_reports WHERE job_id = ${run.jobId}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(
      asApp(member, (trx) =>
        sql`INSERT INTO agent_failure_reports (org_id, job_id, run_id, reason, created_at) VALUES (${run.orgId}::uuid, ${run.jobId}::uuid, ${randomUUID()}::uuid, 'x', now())`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
    const { rows } = await sql<{ privilege_type: string }>`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_name = 'agent_failure_reports' AND grantee = 'bidtools_app' ORDER BY privilege_type`.execute(superuser);
    expect(rows.map((row) => row.privilege_type)).toEqual(['SELECT']);
    const { rows: columns } = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_name = 'agent_failure_reports' AND grantee = 'bidtools_app' AND privilege_type = 'INSERT' ORDER BY column_name`.execute(superuser);
    expect(columns.map((row) => row.column_name)).toEqual(['job_id', 'org_id', 'reason', 'run_id']);
  });

  it('随任务记录删除', async () => {
    const member = await newMember();
    const run = await runningJob(member);
    await insertReport(member, run, '无法继续');
    await superuser.deleteFrom('jobs').where('id', '=', run.jobId).execute();
    expect(await reportsOf(run.jobId)).toEqual([]);
  });
});

describe('回滚 0038', () => {
  it('删除报告表，之后再升级成功', async () => {
    await agentGw.close();
    await endpoint.close();
    await database.destroy();
    const owner = connect(testDb.ownerConfig);
    try {
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0041_job_pause_storage_quota']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0040_agent_workspace_snapshots']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0039_agent_questions']);
      const down = await migrateDown(owner);
      expect(down.error).toBeUndefined();
      expect(down.results?.map((result) => result.migrationName)).toEqual(['0038_agent_failure_reports']);
      const { rows } = await sql<{ name: string | null }>`SELECT to_regclass('agent_failure_reports')::text AS name`.execute(superuser);
      expect(rows[0]!.name).toBeNull();
      expect((await migrateToLatest(owner)).error).toBeUndefined();
    } finally {
      await owner.destroy();
      database = createDatabase(testDb.appConfig);
      appDb = database.db;
    }
  });
});
