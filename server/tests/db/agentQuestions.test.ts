// Agent 向用户提问（ask-user：src/agent/askUserTool.ts、src/agent/questions.ts、迁移 0039_agent_questions，路线图第 8 步 8.4c1）
// 对真实数据库的测试，工具调用经 agent-gw 转给 worker 的内部入口：
// - 规范化与选项规则（纯函数）；
// - 工具：对照组（提问、等待中回答即取回，推送问题状态）、未回答时返回 pending 且同一次执行重复提出同一问题不新建、
//   本次执行另有问题在等待时 409、参数不合法 400（不写入）、任务类型未登记 404、令牌失效 401、日志中没有令牌与问题；
// - 回答：发起人与 owner / admin 能回答，普通成员 403、其他组织 404，选项与自定义输入的检查，已回答 409，任务已结束 409；
// - 超时：续租发现超时、结束时暂停为 waiting_for_user（对照组：未超时、暂停前刚好被回答、已请求暂停）；暂停后普通继续 409，
//   回答后回到 queued、续跑时同一问题取回答案，不同问题作废旧问题；余额 / 当日时长不足时回答 429 且不改；执行者失联后新执行接手问题；
// - 执行者端到端：等待超时即暂停、令牌失效，回答后自动续跑并取回答案；
// - 问题表的 RLS、授权、触发器（AQ001）与约束；接口与 CSRF；回滚 0039。
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAskUserTool } from '../../src/agent/askUserTool.ts';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import { buildAgentGateway } from '../../src/agent/gateway.ts';
import { normalizeAgentQuestion } from '../../src/agent/questions.ts';
import { reportFailureTool } from '../../src/agent/reportFailureTool.ts';
import { AGENT_RELAY_KEY_HEADER } from '../../src/agent/token.ts';
import { issueAgentJobToken, lookupAgentJobToken } from '../../src/agent/tokenStore.ts';
import { AGENT_TOOL_CALL_PATH, createAgentToolRegistry } from '../../src/agent/tools.ts';
import { buildApp } from '../../src/app.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database, MemberRole } from '../../src/db/schema.ts';
import { withOrgContext, withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import { createEventPublisher, type EventPublisher } from '../../src/events/publisher.ts';
import { createJobTypeRegistry, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../src/jobs/runner.ts';
import { answerJobQuestion, enqueueJob, resumeJob, type JobServiceDependencies } from '../../src/jobs/service.ts';
import { claimJob, finishRun, insertJob, recoverJob, renewRun, requestPause, type RunRef } from '../../src/jobs/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { createLogCapture, fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;
const PASSWORD = 'quiet-harbor-maple-58';
const QUESTION_MARKER = 'question-marker-7c2f1a';
const WAIT_MS = 1_500;

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let endpoint: FastifyInstance;
let endpointOrigin: string;
let agentGw: FastifyInstance;
let gwOrigin: string;
let app: FastifyInstance;
let redis: Redis;
let prefix: string;
let publisher: EventPublisher;
const endpointLogs = createLogCapture();
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];
/** 内部入口推送的问题状态。 */
const questionEvents: { jobId: string; questionId: string; status: string }[] = [];

const askUser = createAskUserTool({ waitMs: WAIT_MS, pollMs: 50 });
const TOOLS = createAgentToolRegistry([askUser, reportFailureTool]);
const TOOLS_BY_TYPE: Record<string, readonly string[]> = {
  'test-agent': ['ask-user', 'report-failure'],
  'test-agent-hold': ['ask-user', 'report-failure'],
  'test-agent-noask': ['report-failure'],
};

/** 假 Agent：一直运行到被中止（不调用模型）。 */
const agentHold: JobTypeDefinition<Record<string, never>> = {
  type: 'test-agent-hold',
  queue: 'agent',
  resumable: true,
  agentLimits: AGENT_TASK_LIMITS.outline,
  agentTools: ['ask-user', 'report-failure'],
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
  email: string;
  context: TenantContext;
}

async function addMember(orgId: string, role: MemberRole): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { orgId, userId, email, context: { orgId, userId, role } };
}

async function newOrg(): Promise<Member> {
  const orgId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  return addMember(orgId, 'owner');
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

async function runningJob(member: Member, type = 'test-agent'): Promise<RunRef> {
  const projectId = await newProject(member);
  const job = await insertJob(appDb, member.context, { type, params: {}, projectId, agentLimits: AGENT_TASK_LIMITS.outline });
  return claim(member, job.id);
}

async function tokenOf(run: RunRef): Promise<string> {
  const issued = await issueAgentJobToken(appDb, run, TTL_MS);
  expect(issued).not.toBeNull();
  return issued!.token;
}

async function tokenFor(member: Member, type?: string) {
  const run = await runningJob(member, type);
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

const OPTIONS = [
  { label: '按推荐方案处理', description: '按招标文件的评分办法生成', custom: false },
  { label: '保持当前结果', custom: false },
  { label: '补充具体要求', description: '输入您的要求', custom: true },
];

const ask = (token: string, question = `是否按评分办法调整目录？${QUESTION_MARKER}`, options: unknown = OPTIONS) =>
  call(token, { name: 'ask-user', arguments: { question, options } });

async function questionsOf(jobId: string) {
  return superuser
    .selectFrom('agent_questions')
    .select(['id', 'run_id', 'status', 'question', 'options', 'answer_option', 'answer_text', 'answered_by', 'consumed_run_id', 'asked_at'])
    .where('job_id', '=', jobId)
    .orderBy('created_at')
    .execute();
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').select(['status', 'pause_reason', 'pause_requested', 'run_id']).where('id', '=', jobId).executeTakeFirstOrThrow();
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

/** 让本次执行的问题等待超时，执行者按 waiting-for-user 收尾，返回问题 id。 */
async function timedOutJob(member: Member): Promise<{ run: RunRef; questionId: string }> {
  const { run, token } = await tokenFor(member);
  const asked = await ask(token);
  expect(asked.status).toBe(200);
  expect(asked.body.result).toMatchObject({ answered: false, pending: true });
  const state = await renewRun(appDb, run, LEASE_MS, {}, { agentQuestionTimeoutSeconds: 0 });
  expect(state).toMatchObject({ agentQuestionExpired: true });
  expect(await finishRun(appDb, run, { kind: 'waiting-for-user' }, true)).toBe('paused');
  const [question] = await questionsOf(run.jobId);
  return { run, questionId: question!.id };
}

async function startServers() {
  endpoint = await buildAgentEndpointApp({
    db: appDb,
    relayKey: RELAY_KEY,
    logLevel: 'info',
    logStream: endpointLogs.stream,
    tools: TOOLS,
    toolsForJobType: (type) => TOOLS_BY_TYPE[type] ?? [],
    notifyJobControl: (jobId) => publisher.notifyJobControl(jobId),
    notifyQuestion: async (identity, questionId, status) => {
      questionEvents.push({ jobId: identity.jobId, questionId, status });
    },
  });
  await endpoint.listen({ host: '127.0.0.1', port: 0 });
  endpointOrigin = `http://127.0.0.1:${(endpoint.server.address() as AddressInfo).port}`;
  agentGw = await buildAgentGateway({ upstream: endpointOrigin, relayKey: RELAY_KEY, logLevel: 'info', logStream: createLogCapture().stream });
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
  publisher = createEventPublisher(redisConfig(), { log: testLogger().log, connectionName: 'test-agent-questions-publisher', keyPrefix: prefix, queuePrefix: prefix });
  await startServers();
  app = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    { database, passwordHasher: await fastHasher(), mailer: { send: async () => {} }, jobTypeRegistry: registry },
  );
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await wipeQueueKeys(redis, prefix);
  // 之前用例留下的未结束任务不能被之后启动的执行者认领（假 Agent 会一直占着并发名额）。
  await superuser
    .updateTable('jobs')
    .set({ status: 'cancelled', pause_requested: false, pause_reason: null, run_id: null, lease_expires_at: null, finished_at: sql`now()` })
    .where('status', 'in', ['queued', 'running', 'paused', 'cancelling'])
    .execute();
});

afterAll(async () => {
  await app?.close();
  await agentGw?.close();
  await endpoint?.close();
  await publisher?.close();
  redis?.disconnect();
  await database?.destroy();
  await testDb?.drop();
});

describe('规范化与选项规则（纯函数）', () => {
  const ch = (code: number) => String.fromCodePoint(code);

  it('问题去掉控制与不可见字符、保留分行；选项名称与说明合并为单行；相同内容的哈希相同', () => {
    const a = normalizeAgentQuestion({
      question: ` 请确认${ch(0x202e)}：${ch(0)}\r\n\r\n\r\n- 第一项\t要点 `,
      options: [
        { label: ` 按推荐${ch(0x200b)}\n方案 `, description: '说明\n第二行', custom: false },
        { label: '保持', custom: false },
      ],
    });
    expect(a.question).toBe('请确认：\n\n- 第一项 要点');
    expect(a.options).toEqual([
      { label: '按推荐 方案', description: '说明 第二行', custom: false },
      { label: '保持', description: '', custom: false },
    ]);
    const b = normalizeAgentQuestion({ question: '请确认：\n\n- 第一项 要点', options: [{ label: '按推荐 方案', description: '说明 第二行', custom: false }, { label: '保持', custom: false }] });
    expect(b.contentHash.equals(a.contentHash)).toBe(true);
    const c = normalizeAgentQuestion({ question: '请确认：\n\n- 第一项 要点', options: [{ label: '按推荐 方案', custom: false }, { label: '保持', custom: false }] });
    expect(c.contentHash.equals(a.contentHash)).toBe(false);
  });

  it('推荐项要求输入、两个自定义选项、重复名称、只有空白的问题或名称 → 400', () => {
    const base = { label: '甲', custom: false };
    const cases = [
      { question: 'q', options: [{ label: '甲', custom: true }, { label: '乙', custom: false }] },
      { question: 'q', options: [base, { label: '乙', custom: true }, { label: '丙', custom: true }] },
      { question: 'q', options: [base, { label: ' 甲 ', custom: false }] },
      { question: ` ${ch(0x200b)}\n`, options: [base, { label: '乙', custom: false }] },
      { question: 'q', options: [base, { label: `${ch(0x2066)} `, custom: false }] },
      { question: 'q', options: [base] },
    ];
    for (const input of cases) expect(() => normalizeAgentQuestion(input)).toThrow(AppError);
  });
});

describe('ask-user 工具', () => {
  it('对照组：提问后等待，回答后同一调用取回答案（字段与桌面版相同），推送问题状态；只影响令牌的任务', async () => {
    const owner = await newOrg();
    const other = await tokenFor(owner);
    const { run, token } = await tokenFor(owner);
    const pending = ask(token);
    const question = await waitFor(async () => (await questionsOf(run.jobId))[0], 5_000, '问题写入');
    expect(question).toMatchObject({ run_id: run.runId, status: 'pending', question: `是否按评分办法调整目录？${QUESTION_MARKER}` });
    expect(question.options).toEqual([
      { label: '按推荐方案处理', description: '按招标文件的评分办法生成', custom: false },
      { label: '保持当前结果', description: '', custom: false },
      { label: '补充具体要求', description: '输入您的要求', custom: true },
    ]);
    expect(questionEvents).toContainEqual({ jobId: run.jobId, questionId: question.id, status: 'pending' });

    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId: question.id, optionIndex: 2, customAnswer: ' 只调整第三章​ ' });
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body.result).toEqual({ answered: true, answer: '只调整第三章', selected_option: '补充具体要求', is_custom: true });
    expect((await questionsOf(run.jobId))[0]).toMatchObject({ status: 'consumed', consumed_run_id: run.runId, answered_by: owner.userId, answer_option: 2 });
    expect(await questionsOf(other.run.jobId)).toEqual([]);
    expect((await jobRow(run.jobId)).status).toBe('running');
  });

  it('未回答：等待 waitMs 后返回 pending；同一次执行重复提出同一问题不新建，之后选普通选项取回 label', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    const started = Date.now();
    const first = await ask(token);
    expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 100);
    expect(first.body.result).toMatchObject({ answered: false, pending: true });
    const again = ask(token);
    const [question] = await questionsOf(run.jobId);
    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId: question!.id, optionIndex: 0 });
    expect((await again).body.result).toEqual({ answered: true, answer: '按推荐方案处理', selected_option: '按推荐方案处理', is_custom: false });
    expect(await questionsOf(run.jobId)).toHaveLength(1);
    // 关闭后再提出同一个问题：新建一个问题。
    expect((await ask(token)).body.result).toMatchObject({ answered: false });
    expect((await questionsOf(run.jobId)).map((row) => row.status)).toEqual(['consumed', 'pending']);
  });

  it('本次执行已有另一个问题在等待 → 409 AGENT_QUESTION_PENDING，不新建', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    expect((await ask(token)).status).toBe(200);
    const other = await ask(token, '另一个问题');
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: { code: 'AGENT_QUESTION_PENDING' } });
    expect(await questionsOf(run.jobId)).toHaveLength(1);
  });

  it('参数不合法（选项规则、个数、多出字段、自称的任务、超长）→ 400，不写入', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    const bad: unknown[] = [
      [{ label: '甲', custom: true }, { label: '乙', custom: false }],
      [{ label: '甲', custom: false }, { label: '乙', custom: true }, { label: '丙', custom: true }],
      [{ label: '甲', custom: false }],
      Array.from({ length: 6 }, (_, index) => ({ label: `选项${index}`, custom: false })),
      [{ label: '甲', custom: false, jobId: run.jobId }, { label: '乙', custom: false }],
      [{ label: '甲'.repeat(61), custom: false }, { label: '乙', custom: false }],
      [{ label: '甲', custom: 'false' }, { label: '乙', custom: false }],
    ];
    for (const options of bad) {
      const response = await ask(token, '问题', options);
      expect(response.status, JSON.stringify(options)).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'AGENT_TOOL_INVALID_ARGUMENTS' } });
    }
    const extra = await call(token, { name: 'ask-user', arguments: { question: '问题', options: OPTIONS, orgId: randomUUID() } });
    expect(extra.status).toBe(400);
    expect((await ask(token, 'x'.repeat(2001))).status).toBe(400);
    expect((await ask(token, ' ​ ')).status).toBe(400);
    expect(await questionsOf(run.jobId)).toEqual([]);
  });

  it('任务类型没有登记 ask-user → 404；令牌失效（请求暂停后）→ 401；都不写入', async () => {
    const owner = await newOrg();
    const noAsk = await tokenFor(owner, 'test-agent-noask');
    expect((await ask(noAsk.token)).status).toBe(404);
    const { run, token } = await tokenFor(owner);
    await requestPause(appDb, owner.context, run.jobId);
    expect((await ask(token)).status).toBe(401);
    expect(await questionsOf(noAsk.run.jobId)).toEqual([]);
    expect(await questionsOf(run.jobId)).toEqual([]);
  });

  it('等待中任务被取消（不再是本次执行）→ 409 JOB_NOT_RUNNING', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    const pending = ask(token);
    await waitFor(async () => (await questionsOf(run.jobId))[0], 5_000, '问题写入');
    await finishRun(appDb, run, { kind: 'interrupted' }, true);
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'JOB_NOT_RUNNING' } });
  });

  it('日志中没有令牌原文与问题内容', async () => {
    const owner = await newOrg();
    const { token } = await tokenFor(owner);
    await ask(token);
    const text = endpointLogs.text();
    expect(text).toContain('agent asked user');
    expect(text).not.toContain(token);
    expect(text).not.toContain(QUESTION_MARKER);
  });
});

describe('回答', () => {
  it('发起人与 owner / admin 能回答；普通成员 403、其他组织 404；回答后再答 409', async () => {
    const owner = await newOrg();
    const creator = await addMember(owner.orgId, 'member');
    const admin = await addMember(owner.orgId, 'admin');
    const bystander = await addMember(owner.orgId, 'member');
    const stranger = await newOrg();
    for (const answerer of [creator, admin, owner]) {
      const { run, token } = await tokenFor(creator);
      await ask(token);
      const [question] = await questionsOf(run.jobId);
      await expectCode(answerJobQuestion(deps(), bystander.context, run.jobId, { questionId: question!.id, optionIndex: 0 }), 'JOB_ANSWER_FORBIDDEN');
      await expectCode(answerJobQuestion(deps(), stranger.context, run.jobId, { questionId: question!.id, optionIndex: 0 }), 'JOB_NOT_FOUND');
      await answerJobQuestion(deps(), answerer.context, run.jobId, { questionId: question!.id, optionIndex: 1 });
      expect((await questionsOf(run.jobId))[0]).toMatchObject({ status: 'answered', answered_by: answerer.userId, answer_option: 1, answer_text: null });
      await expectCode(answerJobQuestion(deps(), owner.context, run.jobId, { questionId: question!.id, optionIndex: 0 }), 'AGENT_QUESTION_NOT_PENDING');
    }
  });

  it('选项序号越界、自定义选项没有输入、普通选项带输入、问题不属于本任务 → 400 / 404，不改', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    await ask(token);
    const [question] = await questionsOf(run.jobId);
    const id = question!.id;
    await expectCode(answerJobQuestion(deps(), owner.context, run.jobId, { questionId: id, optionIndex: 3 }), 'AGENT_ANSWER_INVALID');
    await expectCode(answerJobQuestion(deps(), owner.context, run.jobId, { questionId: id, optionIndex: 2 }), 'AGENT_ANSWER_INVALID');
    await expectCode(answerJobQuestion(deps(), owner.context, run.jobId, { questionId: id, optionIndex: 2, customAnswer: ' ​\n' }), 'AGENT_ANSWER_INVALID');
    await expectCode(answerJobQuestion(deps(), owner.context, run.jobId, { questionId: id, optionIndex: 0, customAnswer: '多余' }), 'AGENT_ANSWER_INVALID');
    const other = await tokenFor(owner);
    await expectCode(answerJobQuestion(deps(), owner.context, other.run.jobId, { questionId: id, optionIndex: 0 }), 'AGENT_QUESTION_NOT_FOUND');
    expect((await questionsOf(run.jobId))[0]).toMatchObject({ status: 'pending' });
  });

  it('任务已结束（取消）→ 409 JOB_FINISHED', async () => {
    const owner = await newOrg();
    const { run, questionId } = await timedOutJob(owner);
    await superuser.updateTable('jobs').set({ status: 'cancelled', pause_reason: null, finished_at: sql`now()` }).where('id', '=', run.jobId).execute();
    await expectCode(answerJobQuestion(deps(), owner.context, run.jobId, { questionId, optionIndex: 0 }), 'JOB_FINISHED');
  });
});

describe('等待超时与续跑', () => {
  it('对照组：未超时时续租不报告超时；超时后暂停为 waiting_for_user 并记事件，普通继续 409', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    await ask(token);
    expect(await renewRun(appDb, run, LEASE_MS)).toMatchObject({ agentQuestionExpired: false });
    expect(await renewRun(appDb, run, LEASE_MS, {}, { agentQuestionTimeoutSeconds: 0 })).toMatchObject({ agentQuestionExpired: true });
    expect(await finishRun(appDb, run, { kind: 'waiting-for-user' }, true)).toBe('paused');
    expect(await jobRow(run.jobId)).toMatchObject({ status: 'paused', pause_reason: 'waiting_for_user', run_id: null });
    expect(await lookupAgentJobToken(appDb, token)).toBeNull();
    const events = await superuser.selectFrom('job_events').select(['kind', 'message']).where('job_id', '=', run.jobId).orderBy('id').execute();
    expect(events.at(-1)).toMatchObject({ kind: 'paused', message: 'Agent 的问题长时间未回答，任务已暂停，回答后会自动继续' });
    await expectCode(resumeJob(deps(), owner.context, run.jobId), 'JOB_ANSWER_REQUIRED');
  });

  it('暂停后回答：回到 queued；续跑时提出同一问题立即取回答案（不新建）', async () => {
    const owner = await newOrg();
    const { run, questionId } = await timedOutJob(owner);
    const job = await answerJobQuestion(deps(), owner.context, run.jobId, { questionId, optionIndex: 1 });
    expect(job).toMatchObject({ status: 'queued', pauseReason: null });
    const next = await claim(owner, run.jobId);
    const token = await tokenOf(next);
    const started = Date.now();
    const response = await ask(token);
    expect(Date.now() - started).toBeLessThan(WAIT_MS);
    expect(response.body.result).toEqual({ answered: true, answer: '保持当前结果', selected_option: '保持当前结果', is_custom: false });
    expect(await questionsOf(run.jobId)).toEqual([expect.objectContaining({ id: questionId, status: 'consumed', run_id: run.runId, consumed_run_id: next.runId })]);
  });

  it('续跑时提出不同的问题：旧问题作废，新问题等待', async () => {
    const owner = await newOrg();
    const { run, questionId } = await timedOutJob(owner);
    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId, optionIndex: 0 });
    const next = await claim(owner, run.jobId);
    const response = await ask(await tokenOf(next), '换了一个问题');
    expect(response.body.result).toMatchObject({ answered: false });
    expect((await questionsOf(run.jobId)).map((row) => [row.status, row.run_id])).toEqual([
      ['superseded', run.runId],
      ['pending', next.runId],
    ]);
  });

  it('暂停前刚好被回答：按中止收尾回到 queued（不暂停）；已请求暂停的按普通暂停收尾', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    await ask(token);
    const [question] = await questionsOf(run.jobId);
    await answerJobQuestion(deps(), owner.context, run.jobId, { questionId: question!.id, optionIndex: 0 });
    expect(await finishRun(appDb, run, { kind: 'waiting-for-user' }, true)).toBe('queued');

    const second = await tokenFor(owner);
    await ask(second.token);
    await requestPause(appDb, owner.context, second.run.jobId);
    expect(await finishRun(appDb, second.run, { kind: 'waiting-for-user' }, true)).toBe('paused');
    expect(await jobRow(second.run.jobId)).toMatchObject({ status: 'paused', pause_reason: null });
  });

  it('当日运行时长已用完时回答 → 429，问题仍在等待、任务仍暂停；对照组：时长可用时回答成功', async () => {
    const owner = await newOrg();
    const { run, questionId } = await timedOutJob(owner);
    await expectCode(
      answerAgentQuestionWithQuota(owner, run.jobId, questionId, { agentDailyRuntimeSeconds: 0 }),
      'AGENT_DAILY_RUNTIME_EXHAUSTED',
    );
    expect(await jobRow(run.jobId)).toMatchObject({ status: 'paused', pause_reason: 'waiting_for_user' });
    expect((await questionsOf(run.jobId))[0]).toMatchObject({ status: 'pending' });
    await answerAgentQuestionWithQuota(owner, run.jobId, questionId, {});
    expect(await jobRow(run.jobId)).toMatchObject({ status: 'queued' });
  });

  it('执行者失联：对账收回后新的执行提出同一问题即接手（run_id 改为新执行、重新计时）', async () => {
    const owner = await newOrg();
    const { run, token } = await tokenFor(owner);
    await ask(token);
    const [before] = await questionsOf(run.jobId);
    await superuser.updateTable('jobs').set({ lease_expires_at: sql`now() - interval '1 second'` }).where('id', '=', run.jobId).execute();
    expect(await recoverJob(appDb, { orgId: owner.orgId, id: run.jobId }, () => true)).toMatchObject({ kind: 'dispatch' });
    const next = await claim(owner, run.jobId);
    questionEvents.length = 0;
    expect((await ask(await tokenOf(next))).body.result).toMatchObject({ answered: false });
    const [after] = await questionsOf(run.jobId);
    expect(after).toMatchObject({ id: before!.id, status: 'pending', run_id: next.runId });
    expect(after!.asked_at.getTime()).toBeGreaterThan(before!.asked_at.getTime());
    expect(questionEvents).toEqual([{ jobId: run.jobId, questionId: before!.id, status: 'pending' }]);
  });
});

async function answerAgentQuestionWithQuota(member: Member, jobId: string, questionId: string, agentQuota: { agentDailyRuntimeSeconds?: number }) {
  return answerJobQuestion({ ...deps(), agentQuota }, member.context, jobId, { questionId, optionIndex: 0 });
}

describe('执行者端到端', () => {
  it('等待超时即暂停、令牌失效；回答后自动续跑，新执行提出同一问题取回答案', async () => {
    const logs = testLogger();
    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-agent-questions-dispatch'), prefix });
    dispatchers.push(dispatcher);
    const runner = createJobRunner({
      db: appDb,
      registry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'test-agent-questions-worker'),
      log: logs.log,
      prefix,
      leaseMs: 4_000,
      heartbeatMs: 200,
      reconcileIntervalMs: 600_000,
      concurrency: { agent: 2 },
      agentQuota: { agentQuestionTimeoutSeconds: 1 },
    });
    runners.push(runner);
    await runner.start();

    const owner = await newOrg();
    const projectId = await newProject(owner);
    const service = { db: appDb, registry, dispatcher, log: logs.log };
    const job = await enqueueJob(service, owner.context, { type: agentHold.type, params: {}, projectId });
    const runId = await waitFor(async () => (await jobRow(job.id)).run_id, 15_000, '任务开始执行');
    const token = await tokenOf({ orgId: owner.orgId, jobId: job.id, runId });
    // 超时（1 秒）短于工具的单次等待（1.5 秒）：等待中任务被暂停，调用以 409 结束。
    const waiting = await ask(token);
    expect(waiting.status).toBe(409);
    expect(waiting.body).toMatchObject({ error: { code: 'JOB_NOT_RUNNING' } });
    await waitFor(async () => (await jobRow(job.id)).status === 'paused', 10_000, '等待超时后暂停');
    expect(await jobRow(job.id)).toMatchObject({ pause_reason: 'waiting_for_user' });
    expect(await lookupAgentJobToken(appDb, token)).toBeNull();

    const [question] = await questionsOf(job.id);
    await answerJobQuestion(service, owner.context, job.id, { questionId: question!.id, optionIndex: 0 });
    const nextRunId = await waitFor(async () => {
      const row = await jobRow(job.id);
      return row.status === 'running' && row.run_id !== runId ? row.run_id : null;
    }, 15_000, '回答后续跑');
    const response = await ask(await tokenOf({ orgId: owner.orgId, jobId: job.id, runId: nextRunId! }));
    expect(response.body.result).toMatchObject({ answered: true, selected_option: '按推荐方案处理' });
  });
});

describe('问题表的数据库约束', () => {
  async function pendingQuestion(member: Member) {
    const { run, token } = await tokenFor(member);
    await ask(token);
    const [question] = await questionsOf(run.jobId);
    return { run, token, id: question!.id };
  }

  it('RLS：其他组织看不到、不能为其他组织的任务提问或回答', async () => {
    const owner = await newOrg();
    const stranger = await newOrg();
    const { run, id } = await pendingQuestion(owner);
    expect(await withTenant(appDb, stranger.context, (trx) => trx.selectFrom('agent_questions').selectAll().execute())).toEqual([]);
    const updated = await withTenant(appDb, stranger.context, (trx) =>
      trx.updateTable('agent_questions').set({ status: 'answered', answer_option: 0 }).where('id', '=', id).executeTakeFirst(),
    );
    expect(updated.numUpdatedRows).toBe(0n);
    await expect(
      withTenant(appDb, stranger.context, (trx) =>
        trx.insertInto('agent_questions').values({ org_id: owner.orgId, job_id: run.jobId, run_id: run.runId, content_hash: Buffer.alloc(32), question: 'q', options: JSON.stringify(OPTIONS) }).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('只能为 running、run_id 相符的 Agent 任务提问；每个任务至多一个未关闭的问题', async () => {
    const owner = await newOrg();
    const { run } = await pendingQuestion(owner);
    const insert = (runId: string) =>
      withTenant(appDb, owner.context, (trx) =>
        trx.insertInto('agent_questions').values({ org_id: owner.orgId, job_id: run.jobId, run_id: runId, content_hash: Buffer.alloc(32, 1), question: 'q', options: JSON.stringify(OPTIONS) }).execute(),
      );
    await expect(insert(randomUUID())).rejects.toMatchObject({ code: '42501' });
    await expect(insert(run.runId)).rejects.toMatchObject({ code: '23505' });
  });

  it('触发器：普通成员、没有用户上下文的连接不能回答；不能在同一次执行中作废或接手；答案只能交给当前执行；关闭后不能再改', async () => {
    const owner = await newOrg();
    const bystander = await addMember(owner.orgId, 'member');
    const { run, id } = await pendingQuestion(owner);
    const update = (context: TenantContext | null, set: Record<string, unknown>) =>
      context
        ? withTenant(appDb, context, (trx) => trx.updateTable('agent_questions').set(set).where('id', '=', id).execute())
        : withOrgContext(appDb, owner.orgId, (trx) => trx.updateTable('agent_questions').set(set).where('id', '=', id).execute());
    await expect(update(bystander.context, { status: 'answered', answer_option: 0 })).rejects.toMatchObject({ code: 'AQ001' });
    await expect(update(null, { status: 'answered', answer_option: 0 })).rejects.toMatchObject({ code: 'AQ001' });
    await expect(update(owner.context, { status: 'answered', answer_option: 2 })).rejects.toMatchObject({ code: 'AQ001' });
    await expect(update(owner.context, { status: 'answered', answer_option: 0, answer_text: '多余' })).rejects.toMatchObject({ code: 'AQ001' });
    await expect(update(owner.context, { status: 'answered', answer_option: 4 })).rejects.toMatchObject({ code: 'AQ001' });
    await expect(update(owner.context, { status: 'superseded' })).rejects.toMatchObject({ code: 'AQ001' });
    await expect(update(owner.context, { run_id: randomUUID() })).rejects.toMatchObject({ code: 'AQ001' });
    await expect(update(owner.context, { status: 'consumed', consumed_run_id: run.runId })).rejects.toMatchObject({ code: 'AQ001' });
    // 对照组：owner 回答成功；答案只能交给当前执行。
    await update(owner.context, { status: 'answered', answer_option: 2, answer_text: '要求' });
    await expect(update(owner.context, { status: 'consumed', consumed_run_id: randomUUID() })).rejects.toMatchObject({ code: 'AQ001' });
    await expect(update(owner.context, { answer_option: 1 })).rejects.toMatchObject({ code: 'AQ001' });
    await update(owner.context, { status: 'consumed', consumed_run_id: run.runId });
    await expect(update(owner.context, { status: 'pending' })).rejects.toMatchObject({ code: 'AQ001' });
  });

  it('授权：应用角色不能改问题内容、回答人与时间，没有 DELETE；随任务记录删除', async () => {
    const owner = await newOrg();
    const { run, id } = await pendingQuestion(owner);
    for (const set of [{ question: 'x' }, { answered_by: owner.userId }, { asked_at: new Date() }, { options: '[]' }]) {
      await expect(
        withTenant(appDb, owner.context, (trx) => trx.updateTable('agent_questions').set(set as never).where('id', '=', id).execute()),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(withTenant(appDb, owner.context, (trx) => trx.deleteFrom('agent_questions').where('id', '=', id).execute())).rejects.toMatchObject({
      code: '42501',
    });
    await superuser.deleteFrom('jobs').where('id', '=', run.jobId).execute();
    expect(await questionsOf(run.jobId)).toEqual([]);
  });
});

describe('接口', () => {
  async function login(email: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
    expect(response.statusCode, response.body).toBe(200);
    const header = response.headers['set-cookie'];
    return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
  }

  async function request(member: Member, method: 'GET' | 'POST', url: string, payload?: unknown) {
    const cookie = await login(member.email);
    return app.inject({ method, url, headers: { ...sameSiteHeaders, cookie: `__Host-session=${cookie}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  }

  it('GET 详情含等待回答的问题；POST answer：普通成员 403、缺少 CSRF 403、参数不合法 400、发起人回答后继续', async () => {
    const owner = await newOrg();
    const creator = await addMember(owner.orgId, 'member');
    const bystander = await addMember(owner.orgId, 'member');
    const { run, questionId } = await timedOutJob(creator);

    const detail = await request(bystander, 'GET', `/api/jobs/${run.jobId}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body).toMatchObject({
      status: 'paused',
      pauseReason: 'waiting_for_user',
      pendingQuestion: { id: questionId, question: `是否按评分办法调整目录？${QUESTION_MARKER}`, options: [{ label: '按推荐方案处理', custom: false }, { label: '保持当前结果' }, { label: '补充具体要求', custom: true }] },
    });
    expect(Date.parse(body.pendingQuestion.pauseAt) - Date.parse(body.pendingQuestion.askedAt)).toBe(600_000);

    const url = `/api/jobs/${run.jobId}/answer`;
    expect((await request(bystander, 'POST', url, { questionId, optionIndex: 0 })).statusCode).toBe(403);
    const cookie = await login(creator.email);
    expect((await app.inject({ method: 'POST', url, headers: { cookie: `__Host-session=${cookie}` }, payload: { questionId, optionIndex: 0 } })).statusCode).toBe(403);
    for (const payload of [{ questionId }, { questionId, optionIndex: 5 }, { questionId, optionIndex: 0, orgId: owner.orgId }, { questionId: 'x', optionIndex: 0 }, { questionId, optionIndex: 2, customAnswer: 'x'.repeat(2001) }]) {
      expect((await request(creator, 'POST', url, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const answered = await request(creator, 'POST', url, { questionId: questionId.toUpperCase(), optionIndex: 2, customAnswer: '只改第三章' });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toMatchObject({ id: run.jobId, status: 'queued', pauseReason: null });
    expect((await request(creator, 'GET', `/api/jobs/${run.jobId}`)).json()).toMatchObject({ pendingQuestion: null });
  });
});

describe('回滚 0039', () => {
  it('等待回答而暂停的任务改为普通暂停，删除问题表，之后再升级成功', async () => {
    const owner = await newOrg();
    const { run } = await timedOutJob(owner);
    await app.close();
    await agentGw.close();
    await endpoint.close();
    await database.destroy();
    const migrator = connect(testDb.ownerConfig);
    try {
      const down = await migrateDown(migrator);
      expect(down.error).toBeUndefined();
      expect(down.results?.map((result) => result.migrationName)).toEqual(['0039_agent_questions']);
      const { rows } = await sql<{ name: string | null }>`SELECT to_regclass('agent_questions')::text AS name`.execute(superuser);
      expect(rows[0]!.name).toBeNull();
      expect(await jobRow(run.jobId)).toMatchObject({ status: 'paused', pause_reason: null });
      expect((await migrateToLatest(migrator)).error).toBeUndefined();
    } finally {
      await migrator.destroy();
      database = createDatabase(testDb.appConfig);
      appDb = database.db;
      app = await buildApp({ ...testConfig, database: testDb.appConfig }, { database, passwordHasher: await fastHasher(), mailer: { send: async () => {} }, jobTypeRegistry: registry });
      await startServers();
    }
  });
});
