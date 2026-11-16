// Agent 请求终止、由用户决定（request-termination：src/agent/requestTerminationTool.ts，路线图第 8 步 8.4c2）
// 对真实数据库的测试，工具调用经 agent-gw 转给 worker 的内部入口：
// - 纯函数：问题与选项沿用桌面版文字、最长原因也在问题长度之内，失败说明的后缀与截短，继续时的执行要求；
// - 登记：一个任务类型不能同时登记 report-failure 与 request-termination；
// - 工具：对照组（提问、选“终止任务”后写入失败报告并通知执行者、之后的调用 409、结束时以 AGENT_REPORTED_FAILURE 失败），
//   选择继续 / 补充要求时返回放宽后的执行要求且不写报告、之后再次请求新建问题，未回答返回 pending 且不重复新建，
//   参数不合法（含 Agent 自带选项、自称的任务）400 不写入，未登记 404，另有问题在等待 409，日志中没有令牌与原因；
// - 原子性：选“终止任务”后写不进报告时，取回答案一起回滚（问题仍为 answered），对照组写入成功；
// - 等待超时：暂停为 waiting_for_user，回答“终止任务”后续跑，新执行以相同原因再次请求即终止；
// - 执行者端到端：用户选择终止后经控制频道立即中止并失败。
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAskUserTool } from '../../src/agent/askUserTool.ts';
import { AGENT_TASK_LIMITS, beginAgentTurn } from '../../src/agent/budget.ts';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import { AGENT_FAILURE_REASON_MAX_LENGTH, AGENT_REPORTED_FAILURE_CODE } from '../../src/agent/failureReport.ts';
import { buildAgentGateway } from '../../src/agent/gateway.ts';
import { AGENT_QUESTION_MAX_LENGTH, normalizeAgentQuestion } from '../../src/agent/questions.ts';
import { reportFailureTool } from '../../src/agent/reportFailureTool.ts';
import {
  buildContinueInstruction,
  buildTerminationQuestion,
  createRequestTerminationTool,
  REQUEST_TERMINATION_TOOL_NAME,
  TERMINATED_BY_USER_SUFFIX,
  terminatedFailureReason,
} from '../../src/agent/requestTerminationTool.ts';
import { agentToolRegistry } from '../../src/agent/toolRegistry.ts';
import { issueAgentJobToken, lookupAgentJobToken } from '../../src/agent/tokenStore.ts';
import { setAgentToolScope } from '../../src/agent/toolScope.ts';
import { AGENT_TOOL_CALL_PATH, createAgentToolRegistry } from '../../src/agent/tools.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database, MemberRole } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { createEventPublisher, type EventPublisher } from '../../src/events/publisher.ts';
import { createJobTypeRegistry, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../src/jobs/runner.ts';
import { answerJobQuestion, enqueueJob, type JobServiceDependencies } from '../../src/jobs/service.ts';
import { claimJob, finishRun, insertJob, renewRun, type RunRef } from '../../src/jobs/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { AppError } from '../../src/errors.ts';
import { createLogCapture, fastHasher } from '../helpers.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;
const PASSWORD = 'quiet-harbor-maple-58';
const REASON_MARKER = 'termination-marker-3b9e0d';
const REASON = `招标文件没有技术评分表，无法按评分项生成目录。${REASON_MARKER}`;
const WAIT_MS = 1_500;
const TERMINATE = 1;
const CONTINUE = 0;
const CUSTOM = 2;

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let endpoint: FastifyInstance;
let agentGw: FastifyInstance;
let gwOrigin: string;
let redis: Redis;
let prefix: string;
let publisher: EventPublisher;
const endpointLogs = createLogCapture();
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];
/** 内部入口收到的“通知执行者”（任务 id）。 */
const notified: string[] = [];
const questionEvents: { jobId: string; questionId: string; status: string }[] = [];

const TOOLS = createAgentToolRegistry([
  createAskUserTool({ waitMs: WAIT_MS, pollMs: 50 }),
  createRequestTerminationTool({ waitMs: WAIT_MS, pollMs: 50 }),
  reportFailureTool,
]);
const TOOLS_BY_TYPE: Record<string, readonly string[]> = {
  'test-agent': ['ask-user', 'request-termination'],
  'test-agent-hold': ['ask-user', 'request-termination'],
  'test-agent-direct': ['report-failure'],
};

/** 假 Agent：一直运行到被中止（不调用模型）。 */
const agentHold: JobTypeDefinition<Record<string, never>> = {
  type: 'test-agent-hold',
  queue: 'agent',
  resumable: true,
  agentLimits: AGENT_TASK_LIMITS.outline,
  agentTools: ['ask-user', 'request-termination'],
  parseParams: () => ({}),
  run: (context: JobContext<Record<string, never>>) =>
    new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
};
const testAgent: JobTypeDefinition<Record<string, never>> = { ...agentHold, type: 'test-agent' };
const registry = createJobTypeRegistry([agentHold, testAgent]);

function deps(): JobServiceDependencies {
  return { db: appDb, registry, dispatcher: null, log: testLogger().log };
}

interface Member {
  orgId: string;
  userId: string;
  context: TenantContext;
}

async function newOrg(): Promise<Member> {
  const orgId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  return addMember(orgId, 'owner');
}

async function addMember(orgId: string, role: MemberRole): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { orgId, userId, context: { orgId, userId, role } };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `应当失败：${code}`).not.toBeNull();
  expect(error instanceof AppError ? error.code : (error as { code?: unknown }).code).toBe(code);
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

/** 写下本次执行当前阶段可用的业务工具（迁移 0042，8.6c1）：测试中为任务类型登记的全部工具。 */
async function scopeAllTools(run: RunRef): Promise<void> {
  const { type } = await superuser.selectFrom('jobs').select('type').where('id', '=', run.jobId).executeTakeFirstOrThrow();
  const tools = TOOLS_BY_TYPE[type as string] ?? [];
  expect(await setAgentToolScope(appDb, run, tools, tools)).toBe(true);
}

async function tokenOf(run: RunRef): Promise<string> {
  const issued = await issueAgentJobToken(appDb, run, TTL_MS);
  expect(issued).not.toBeNull();
  await scopeAllTools(run);
  return issued!.token;
}

async function tokenFor(member: Member, type = 'test-agent') {
  const projectId = await newProject(member);
  const job = await insertJob(appDb, member.context, { type, params: {}, projectId, agentLimits: AGENT_TASK_LIMITS.outline });
  const run = await claim(member, job.id);
  return { run, token: await tokenOf(run) };
}

async function call(token: string, payload: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${gwOrigin}${AGENT_TOOL_CALL_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

const terminate = (token: string, reason = REASON) => call(token, { name: REQUEST_TERMINATION_TOOL_NAME, arguments: { reason } });

async function questionsOf(jobId: string) {
  return superuser
    .selectFrom('agent_questions')
    .select(['id', 'run_id', 'status', 'question', 'options', 'answer_option', 'consumed_run_id'])
    .where('job_id', '=', jobId)
    .orderBy('created_at')
    .execute();
}

async function reportsOf(jobId: string) {
  return superuser.selectFrom('agent_failure_reports').select(['run_id', 'reason']).where('job_id', '=', jobId).execute();
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').select(['status', 'pause_reason', 'run_id', 'error_code', 'error_message']).where('id', '=', jobId).executeTakeFirstOrThrow();
}

/** 发起请求并等问题写入，返回进行中的调用与问题 id。 */
async function requestAndWait(token: string, jobId: string, reason = REASON) {
  const pending = terminate(token, reason);
  const question = await waitFor(async () => (await questionsOf(jobId)).find((row) => row.status === 'pending'), 5_000, '问题写入');
  return { pending, questionId: question.id };
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
  publisher = createEventPublisher(redisConfig(), { log: testLogger().log, connectionName: 'test-agent-termination-publisher', keyPrefix: prefix, queuePrefix: prefix });
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
    notifyQuestion: async (identity, questionId, status) => {
      questionEvents.push({ jobId: identity.jobId, questionId, status });
    },
  });
  await endpoint.listen({ host: '127.0.0.1', port: 0 });
  const endpointOrigin = `http://127.0.0.1:${(endpoint.server.address() as AddressInfo).port}`;
  agentGw = await buildAgentGateway({ upstream: endpointOrigin, relayKey: RELAY_KEY, logLevel: 'info', logStream: createLogCapture().stream });
  await agentGw.listen({ host: '127.0.0.1', port: 0 });
  gwOrigin = `http://127.0.0.1:${(agentGw.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await wipeQueueKeys(redis, prefix);
  await superuser
    .updateTable('jobs')
    .set({ status: 'cancelled', pause_requested: false, pause_reason: null, run_id: null, lease_expires_at: null, finished_at: sql`now()` })
    .where('status', 'in', ['queued', 'running', 'paused', 'cancelling'])
    .execute();
});

afterAll(async () => {
  await agentGw?.close();
  await endpoint?.close();
  await publisher?.close();
  redis?.disconnect();
  await database?.destroy();
  await testDb?.drop();
});

describe('问题、选项与执行要求（纯函数）', () => {
  it('问题与选项沿用桌面版文字；最长的原因也在问题长度之内，规范化后不变', () => {
    const longest = '甲'.repeat(AGENT_FAILURE_REASON_MAX_LENGTH);
    const question = normalizeAgentQuestion(buildTerminationQuestion(longest));
    expect(Array.from(question.question).length).toBeLessThanOrEqual(AGENT_QUESTION_MAX_LENGTH);
    expect(question.question).toContain(longest);
    expect(question.question.startsWith('Agent 认为当前任务无法按原要求继续：\n\n')).toBe(true);
    expect(question.question.endsWith('是否终止当前任务？')).toBe(true);
    expect(question.options.map((option) => [option.label, option.custom])).toEqual([
      ['降低质量继续', false],
      ['终止任务', false],
      ['补充处理要求', true],
    ]);
  });

  it('失败说明：后附“已按您的选择终止任务”，最长的原因截短后合计不超过上限', () => {
    expect(terminatedFailureReason('资料不足')).toBe(`资料不足${TERMINATED_BY_USER_SUFFIX}`);
    const longest = terminatedFailureReason('乙'.repeat(AGENT_FAILURE_REASON_MAX_LENGTH));
    expect(Array.from(longest).length).toBe(AGENT_FAILURE_REASON_MAX_LENGTH);
    expect(longest.endsWith(TERMINATED_BY_USER_SUFFIX)).toBe(true);
  });

  it('继续时的执行要求：普通选项不含用户输入，补充要求附在最后且优先', () => {
    const plain = buildContinueInstruction({ answered: true, answer: '降低质量继续', selected_option: '降低质量继续', is_custom: false });
    expect(plain.split('\n')[0]).toBe('用户选择不终止任务，要求继续执行。');
    expect(plain).not.toContain('用户补充要求');
    const custom = buildContinueInstruction({ answered: true, answer: '只保留第三章', selected_option: '补充处理要求', is_custom: true });
    expect(custom.split('\n').slice(-2)).toEqual(['用户补充要求：只保留第三章', '该要求优先执行，与上述放宽规则冲突时以用户要求为准。']);
  });
});

describe('登记', () => {
  const base = { ...agentHold, type: 'test-exclusive' };

  it('一个任务类型同时登记 report-failure 与 request-termination → 拒绝；对照组：各登记其一可以', () => {
    expect(() => createJobTypeRegistry([{ ...base, agentTools: ['report-failure', 'request-termination'] }])).toThrow(/只能登记其中一个/);
    expect(() => createJobTypeRegistry([{ ...base, agentTools: ['ask-user', 'request-termination', 'report-failure'] }])).toThrow(TypeError);
    expect(() => createJobTypeRegistry([{ ...base, agentTools: ['report-failure'] }])).not.toThrow();
    expect(() => createJobTypeRegistry([{ ...base, agentTools: ['ask-user', 'request-termination'] }])).not.toThrow();
  });

  it('生产环境登记了 request-termination', () => {
    expect(agentToolRegistry.get(REQUEST_TERMINATION_TOOL_NAME)).toBeDefined();
  });
});

describe('request-termination 工具', () => {
  it('对照组：用户选“终止任务”→ 写入失败报告（原因后附说明）、通知执行者，之后的调用 409，结束时以 AGENT_REPORTED_FAILURE 失败', async () => {
    const owner = await newOrg();
    const other = await tokenFor(owner);
    const { run, token } = await tokenFor(owner);
    const { pending, questionId } = await requestAndWait(token, run.jobId);
    const [question] = await questionsOf(run.jobId);
    expect(question!.question).toContain(REASON);
    expect(questionEvents).toContainEqual({ jobId: run.jobId, questionId, status: 'pending' });
    expect(await reportsOf(run.jobId)).toEqual([]);

    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId, optionIndex: TERMINATE });
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body.result).toEqual({ terminated: true, reason: REASON });
    expect(await reportsOf(run.jobId)).toEqual([{ run_id: run.runId, reason: `${REASON}${TERMINATED_BY_USER_SUFFIX}` }]);
    expect((await questionsOf(run.jobId))[0]).toMatchObject({ status: 'consumed', consumed_run_id: run.runId });
    expect(notified).toContain(run.jobId);
    expect(notified).not.toContain(other.run.jobId);

    expect((await terminate(token)).status).toBe(409);
    expect((await call(token, { name: 'ask-user', arguments: { question: '还能问吗', options: [{ label: '甲', custom: false }, { label: '乙', custom: false }] } })).status).toBe(409);
    expect(await renewRun(appDb, run, LEASE_MS)).toMatchObject({ status: 'running', agentFailureReported: true });
    expect(await renewRun(appDb, other.run, LEASE_MS)).toMatchObject({ agentFailureReported: false });
    expect(await finishRun(appDb, run, { kind: 'interrupted' }, true)).toBe('failed');
    expect(await jobRow(run.jobId)).toMatchObject({ status: 'failed', error_code: AGENT_REPORTED_FAILURE_CODE, error_message: `${REASON}${TERMINATED_BY_USER_SUFFIX}` });
  });

  it('用户选“降低质量继续”→ 返回放宽后的执行要求，不写报告、不通知执行者；之后再次请求新建问题', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    const { pending, questionId } = await requestAndWait(token, run.jobId);
    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId, optionIndex: CONTINUE });
    const result = (await pending).body.result;
    expect(result).toEqual({
      terminated: false,
      selected_option: '降低质量继续',
      instruction: buildContinueInstruction({ answered: true, answer: '降低质量继续', selected_option: '降低质量继续', is_custom: false }),
    });
    expect(await reportsOf(run.jobId)).toEqual([]);
    expect(notified).not.toContain(run.jobId);
    expect(await renewRun(appDb, run, LEASE_MS)).toMatchObject({ status: 'running', agentFailureReported: false });
    // 同一会话再次请求终止：仍由用户回答（新建问题，不自动作答）。
    expect((await terminate(token)).body.result).toMatchObject({ answered: false, pending: true });
    expect((await questionsOf(run.jobId)).map((row) => row.status)).toEqual(['consumed', 'pending']);
  });

  it('用户选“补充处理要求”→ 用户输入按纯文本清理后附在执行要求中，不写报告', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    const { pending, questionId } = await requestAndWait(token, run.jobId);
    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId, optionIndex: CUSTOM, customAnswer: ' 只保留第三章‮ ' });
    const result = (await pending).body.result;
    expect(result).toMatchObject({ terminated: false, selected_option: '补充处理要求', user_reply: '只保留第三章' });
    expect(result.instruction).toContain('用户补充要求：只保留第三章');
    expect(await reportsOf(run.jobId)).toEqual([]);
  });

  it('未回答：等待 waitMs 后返回 pending；以相同原因再次调用不新建问题', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    const started = Date.now();
    const first = await terminate(token);
    expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 100);
    expect(first.body.result).toMatchObject({ answered: false, pending: true });
    expect((await terminate(token)).body.result).toMatchObject({ answered: false, pending: true });
    expect(await questionsOf(run.jobId)).toHaveLength(1);
    expect(await reportsOf(run.jobId)).toEqual([]);
    expect((await jobRow(run.jobId)).status).toBe('running');
  });

  it('参数不合法（空白、超长、Agent 自带选项、自称的任务、类型不对）→ 400，不写入', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    const bad: unknown[] = [
      { reason: ' ​\n' },
      { reason: 'x'.repeat(AGENT_FAILURE_REASON_MAX_LENGTH + 1) },
      { reason: '原因', options: [{ label: '终止任务', custom: false }, { label: '乙', custom: false }] },
      { reason: '原因', jobId: run.jobId },
      { reason: 42 },
      {},
    ];
    for (const args of bad) {
      const response = await call(token, { name: REQUEST_TERMINATION_TOOL_NAME, arguments: args });
      expect(response.status, JSON.stringify(args)).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'AGENT_TOOL_INVALID_ARGUMENTS' } });
    }
    expect(await questionsOf(run.jobId)).toEqual([]);
    expect(await reportsOf(run.jobId)).toEqual([]);
  });

  it('任务类型没有登记 request-termination → 404；只登记 report-failure 的任务类型照常直接报告（对照组）', async () => {
    const owner = await newOrg();
    const direct = await tokenFor(owner, 'test-agent-direct');
    expect((await terminate(direct.token)).status).toBe(404);
    expect(await questionsOf(direct.run.jobId)).toEqual([]);
    const reported = await call(direct.token, { name: 'report-failure', arguments: { reason: '资料不足' } });
    expect(reported.body.result).toEqual({ reported: true });
    expect(await reportsOf(direct.run.jobId)).toEqual([{ run_id: direct.run.runId, reason: '资料不足' }]);
    // 登记了 request-termination 的任务类型不能直接报告。
    const { token } = await tokenFor(owner);
    expect((await call(token, { name: 'report-failure', arguments: { reason: '资料不足' } })).status).toBe(404);
  });

  it('本次执行已有 ask-user 的问题在等待 → 409 AGENT_QUESTION_PENDING，不新建', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    await call(token, { name: 'ask-user', arguments: { question: '先问一个问题', options: [{ label: '甲', custom: false }, { label: '乙', custom: false }] } });
    const response = await terminate(token);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'AGENT_QUESTION_PENDING' } });
    expect(await questionsOf(run.jobId)).toHaveLength(1);
  });

  it('原子性：选“终止任务”后写不进报告时取回答案一起回滚（问题仍为 answered、任务仍在执行）', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    const { pending, questionId } = await requestAndWait(token, run.jobId);
    expect((await pending).body.result).toMatchObject({ pending: true });
    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId, optionIndex: TERMINATE });
    // 模拟写入报告时出错（临时触发器）。
    await sql`CREATE FUNCTION test_block_failure_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'blocked'; END $$`.execute(superuser);
    await sql`CREATE TRIGGER test_block_failure_report BEFORE INSERT ON agent_failure_reports FOR EACH ROW EXECUTE FUNCTION test_block_failure_report()`.execute(superuser);
    try {
      const failed = await terminate(token);
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain('blocked');
    } finally {
      await sql`DROP TRIGGER test_block_failure_report ON agent_failure_reports`.execute(superuser);
      await sql`DROP FUNCTION test_block_failure_report()`.execute(superuser);
    }
    expect((await questionsOf(run.jobId))[0]).toMatchObject({ status: 'answered', consumed_run_id: null });
    expect(await reportsOf(run.jobId)).toEqual([]);
    expect(notified).not.toContain(run.jobId);
    expect((await jobRow(run.jobId)).status).toBe('running');
    // 对照组：去掉触发器后再次调用即终止。
    expect((await terminate(token)).body.result).toEqual({ terminated: true, reason: REASON });
    expect(await reportsOf(run.jobId)).toHaveLength(1);
  });

  it('日志中没有令牌原文与原因', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    const { pending, questionId } = await requestAndWait(token, run.jobId);
    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId, optionIndex: TERMINATE });
    await pending;
    const text = endpointLogs.text();
    expect(text).toContain('agent terminated by user decision');
    expect(text).not.toContain(token);
    expect(text).not.toContain(REASON_MARKER);
  });
});

describe('回答人、计费与不可信原因', () => {
  it('普通成员回答终止问题 → 403，不写报告、任务仍在执行、问题仍在等待；对照组：发起人（普通成员）与 admin 能回答', async () => {
    const owner = await newOrg();
    const creator = await addMember(owner.orgId, 'member');
    const admin = await addMember(owner.orgId, 'admin');
    const bystander = await addMember(owner.orgId, 'member');
    for (const answerer of [creator, admin]) {
      const { run, token } = await tokenFor(creator);
      const { pending, questionId } = await requestAndWait(token, run.jobId);
      for (const optionIndex of [TERMINATE, CONTINUE]) {
        await expectCode(answerJobQuestion(deps(), bystander.context, run.jobId, { questionId, optionIndex }), 'JOB_ANSWER_FORBIDDEN');
      }
      // 越权回答没有生效：这次等待仍返回 pending，没有报告，任务仍在执行。
      expect((await pending).body.result).toMatchObject({ answered: false, pending: true });
      expect((await questionsOf(run.jobId))[0]).toMatchObject({ id: questionId, status: 'pending', answer_option: null });
      expect(await reportsOf(run.jobId)).toEqual([]);
      expect(await jobRow(run.jobId)).toMatchObject({ status: 'running', run_id: run.runId });
      expect(await renewRun(appDb, run, LEASE_MS)).toMatchObject({ status: 'running', agentFailureReported: false });
      expect(notified).not.toContain(run.jobId);
      // 对照组：发起人或 admin 选择终止后生效。
      await answerJobQuestion(deps(), answerer.context, run.jobId, { questionId, optionIndex: TERMINATE });
      expect((await terminate(token)).body.result).toEqual({ terminated: true, reason: REASON });
      expect(await reportsOf(run.jobId)).toHaveLength(1);
    }
  });

  it('等待期间不计轮数、不扣费、没有用量记录；终止后模型调用 409、轮数不变；对照组：未终止的任务照常计入模型调用', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    for (let index = 0; index < 3; index += 1) {
      expect((await terminate(token)).body.result, `第 ${index + 1} 次`).toMatchObject({ answered: false, pending: true });
    }
    const budgetOf = () => superuser.selectFrom('agent_job_budgets').select(['turns_used', 'exhausted_reason']).where('job_id', '=', run.jobId).executeTakeFirstOrThrow();
    const billedOf = async () => BigInt((await superuser.selectFrom('jobs').select('billed_amount').where('id', '=', run.jobId).executeTakeFirstOrThrow()).billed_amount);
    const usageOf = () => superuser.selectFrom('usage_records').select('id').where('job_id', '=', run.jobId).execute();
    expect(await budgetOf()).toEqual({ turns_used: 0, exhausted_reason: null });
    expect(await billedOf()).toBe(0n);
    expect(await usageOf()).toEqual([]);
    expect(await superuser.selectFrom('agent_tool_calls').select(['tool', 'calls']).where('job_id', '=', run.jobId).execute()).toEqual([{ tool: REQUEST_TERMINATION_TOOL_NAME, calls: 3 }]);

    const [question] = await questionsOf(run.jobId);
    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId: question!.id, optionIndex: TERMINATE });
    expect((await terminate(token)).body.result).toMatchObject({ terminated: true });
    const turn = await beginAgentTurn(appDb, { tenant: owner.context, jobId: run.jobId, runId: run.runId }).catch((error: unknown) => error);
    expect(turn).toMatchObject({ statusCode: 409, code: 'JOB_NOT_RUNNING' });
    expect(await budgetOf()).toEqual({ turns_used: 0, exhausted_reason: null });
    expect(await billedOf()).toBe(0n);
    expect(await usageOf()).toEqual([]);

    // 对照组：另一个未终止的任务照常计入模型调用（上面的 409 不是因为模型调用本来就不可用）。
    const other = await tokenFor(owner);
    expect(await beginAgentTurn(appDb, { tenant: owner.context, jobId: other.run.jobId, runId: other.run.runId })).toMatchObject({ turnsUsed: 1 });
  });

  it('原因中的控制字符、双向文本控制与零宽字符在问题与失败报告中都被去掉', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    const dirty = `\u0000资料\u0007不足\u202e，\u2066无法\u200b继续\ufeff\u001b[31m\u0085。\r\n\r\n\r\n第二段\u2028\t说明 `;
    const clean = '资料不足，无法继续[31m。\n\n第二段 说明';
    const { pending, questionId } = await requestAndWait(token, run.jobId, dirty);
    const [question] = await questionsOf(run.jobId);
    const forbidden = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\u2028\u2029\r\t]/;
    expect(question!.question).not.toMatch(forbidden);
    expect(question!.question).toContain(`继续：\n\n${clean}\n\n继续执行`);
    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId, optionIndex: TERMINATE });
    expect((await pending).body.result).toEqual({ terminated: true, reason: clean });
    const [report] = await reportsOf(run.jobId);
    expect(report!.reason).toBe(`${clean}${TERMINATED_BY_USER_SUFFIX}`);
    expect(report!.reason).not.toMatch(forbidden);
    expect(await finishRun(appDb, run, { kind: 'interrupted' }, true)).toBe('failed');
    expect((await jobRow(run.jobId)).error_message).toBe(`${clean}${TERMINATED_BY_USER_SUFFIX}`);
  });
});

describe('等待超时与续跑', () => {
  it('等待超时暂停为 waiting_for_user；回答“终止任务”后续跑，新执行以相同原因再次请求即终止、报告记在新执行', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    expect((await terminate(token)).body.result).toMatchObject({ pending: true });
    expect(await renewRun(appDb, run, LEASE_MS, {}, { agentQuestionTimeoutSeconds: 0 })).toMatchObject({ agentQuestionExpired: true });
    expect(await finishRun(appDb, run, { kind: 'waiting-for-user' }, true)).toBe('paused');
    expect(await jobRow(run.jobId)).toMatchObject({ status: 'paused', pause_reason: 'waiting_for_user' });
    const [question] = await questionsOf(run.jobId);
    expect(await answerJobQuestion(deps(), owner.context, run.jobId, { questionId: question!.id, optionIndex: TERMINATE })).toMatchObject({ status: 'queued' });
    expect(await reportsOf(run.jobId)).toEqual([]);

    const next = await claim(owner, run.jobId);
    const started = Date.now();
    const response = await terminate(await tokenOf(next));
    expect(Date.now() - started).toBeLessThan(WAIT_MS);
    expect(response.body.result).toEqual({ terminated: true, reason: REASON });
    expect(await reportsOf(run.jobId)).toEqual([{ run_id: next.runId, reason: `${REASON}${TERMINATED_BY_USER_SUFFIX}` }]);
    expect(await finishRun(appDb, next, { kind: 'interrupted' }, true)).toBe('failed');
    expect(await jobRow(run.jobId)).toMatchObject({ status: 'failed', error_code: AGENT_REPORTED_FAILURE_CODE });
  });
});

describe('执行者端到端', () => {
  it('用户选择终止后经控制频道立即中止并失败（不等定期续租），令牌随之失效', async () => {
    const logs = testLogger();
    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-termination-dispatch'), prefix });
    dispatchers.push(dispatcher);
    const runner = createJobRunner({
      db: appDb,
      registry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'test-termination-worker'),
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

    const owner = await newOrg();
    const projectId = await newProject(owner);
    const job = await enqueueJob({ db: appDb, registry, dispatcher, log: logs.log }, owner.context, { type: agentHold.type, params: {}, projectId });
    const runId = await waitFor(async () => (await jobRow(job.id)).run_id, 15_000, '任务开始执行');
    const token = await tokenOf({ orgId: owner.orgId, jobId: job.id, runId });
    const { pending, questionId } = await requestAndWait(token, job.id);
    await answerJobQuestion(deps(), owner.context, job.id, { questionId, optionIndex: TERMINATE });
    expect((await pending).body.result).toMatchObject({ terminated: true });
    const finished = await waitFor(async () => {
      const row = await jobRow(job.id);
      return row.status === 'failed' ? row : null;
    }, 10_000, '任务失败');
    expect(finished).toMatchObject({ error_code: AGENT_REPORTED_FAILURE_CODE, error_message: `${REASON}${TERMINATED_BY_USER_SUFFIX}` });
    expect(await lookupAgentJobToken(appDb, token)).toBeNull();
  });
});
