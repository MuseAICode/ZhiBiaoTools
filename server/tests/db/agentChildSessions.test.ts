// 沙箱内的子会话（src/agent/execution.ts 的 childPrompt / removeFiles、src/technicalPlan/contentSectionEditing.ts，路线图第 8 步 8.10c3b2）
// 对真实数据库、Redis、agent-gw、worker 内部入口与 AI 网关（本机模拟服务商）的测试。沙箱用内存桩，入口用假入口：主会话的入口调用长时
// 工具并等待结果，子会话的入口以请求中的任务令牌经 agent-gw 调用模型（与真实的 Pi 子会话相同的路径），再改写内存工作区。
// #126 用户要求的三项：
// 1. 并发子会话对同一工作区的读写不互相覆盖：几个子会话同时改写各自的小节，结束后都保留；本批以外被改动、被新建的小节被还原 / 删除；
// 2. 所有子会话的模型调用计入同一任务的费用与轮数上限：轮数与费用按令牌记到本任务（与主会话相同的预算），达到轮数上限 / 费用上限时
//    子会话被拒绝、本批中止，任务暂停为 task_turn_limit / task_cost_limit；
// 3. 并发下受保护文件仍能正确还原：几个子会话同时改写、删除受保护文件，下一条提示词之前全部还原为原件。
// 另外：同时运行的子会话至多 AGENT_CHILD_SESSION_CONCURRENCY 个；子会话的请求用同一个令牌、只有原生工具、不改动业务工具的范围；
// 只能在一条提示词执行期间运行；受保护文件不能经 removeFiles 删除。
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS, type AgentTaskLimits } from '../../src/agent/budget.ts';
import { AGENT_CHAT_PATH } from '../../src/agent/chatCompletions.ts';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import { AGENT_NATIVE_TOOLS } from '../../src/agent/entry.ts';
import { AGENT_CHILD_SESSION_CONCURRENCY, AGENT_CHILD_TIMEOUT_MS, withAgentRun, type AgentRun } from '../../src/agent/execution.ts';
import { buildAgentGateway } from '../../src/agent/gateway.ts';
import { agentTenantContext, lookupAgentJobToken } from '../../src/agent/tokenStore.ts';
import { openAgentToolRequest, pollAgentToolRequest, type AgentToolRequestResult } from '../../src/agent/toolRequests.ts';
import type { WorkspaceSandboxDriver } from '../../src/agent/workspaceSandbox.ts';
import { putCredential } from '../../src/ai/credentials.ts';
import { createAiGateway, type GatewaySettings } from '../../src/ai/gateway.ts';
import { createFileKeyWrapper } from '../../src/ai/keyring.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { createJobTypeRegistry, type JobTypeDefinition } from '../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../src/jobs/runner.ts';
import { enqueueJob } from '../../src/jobs/service.ts';
import { createLoggerOptions } from '../../src/logger.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { createArchive, readArchive } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxExecResult, type SandboxRef } from '../../src/sandbox/driver.ts';
import { toOutputArchive } from '../../src/sandbox/outputArchive.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { createContentSectionEditActivity, editContentSections, type EditContentSectionsResult } from '../../src/technicalPlan/contentSectionEditing.ts';
import type { ContentSubmissionTarget } from '../../src/technicalPlan/contentSubmission.ts';
import { startMockProvider, type MockProvider } from '../ai/mockProvider.ts';
import { createLogCapture } from '../helpers.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const API_KEY = `sk-mock-${randomBytes(16).toString('hex')}`;
const keyWrapper = createFileKeyWrapper(randomBytes(32), 1);
const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const SETTINGS: GatewaySettings = { upstreamTimeoutMs: 5_000, holdTtlSeconds: 60, maxOutputTokens: 1000, upstreamPrivateHosts: ['127.0.0.1'] };
const LONG_TOOL = 'test-edit-sections';
const PROTECTED = '输入/受限HTML生成规范.md';
const PROTECTED_ORIGINAL = '# 规范原件';
const TARGETS: ContentSubmissionTarget[] = Array.from({ length: 7 }, (_, index) => ({ id: `s${index + 1}`, number: `1.${index + 1}`, title: `第 ${index + 1} 节`, file: `正文/s${index + 1}.html` }));
const original = (id: string) => `<!-- app:block -->\n<p id="s_p001">${id} 原文</p>`;
const edited = (id: string) => `<!-- app:block -->\n<p id="s_p001">${id} 修改后</p>`;
/** 本批编辑 s1～s5；s6 有正文、s7 原本没有文件（本批以外）。 */
const BATCH = TARGETS.slice(0, 5);
const CALLS_PER_CHILD = 2;

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let redis: Redis;
let prefix: string;
let provider: MockProvider;
let endpoint: FastifyInstance;
let agentGw: FastifyInstance;
let gwOrigin: string;
let platformModelId: string;
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];
const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

function memoryStore(): ObjectStore {
  const objects = new Map<string, Buffer>();
  return {
    async put(key, body) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    },
    async get(key) {
      const content = objects.get(key);
      return content ? { body: Readable.from([content]), size: content.length } : null;
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

const execResult = (value: unknown, exitCode = 0): SandboxExecResult => ({ exitCode, timedOut: false, stdout: `${JSON.stringify({ version: 1, ...(value as object) })}\n`, stderr: '', stdoutTruncated: false, stderrTruncated: false });
const sessionName = () => `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.jsonl`;

interface ChildCall {
  request: Record<string, any>;
  token: string;
  scope: string[] | null;
}
type ChildScript = (call: ChildCall, ws: Map<string, Buffer>) => Promise<Record<string, unknown>>;

/** 内存中的 agent 沙箱：主会话的入口调用长时工具并等待；子会话的入口执行 childScript；remove 删除内存工作区中的文件。 */
function fakeDriver() {
  const state = {
    workspaces: new Map<string, Map<string, Buffer>>(),
    destroyed: [] as string[],
    children: [] as ChildCall[],
    running: 0,
    maxRunning: 0,
    mainTokens: [] as string[],
    childScript: (async () => ({ session: null, turns: 1, outcome: 'stop', reason: null })) as ChildScript,
    longResults: [] as AgentToolRequestResult[],
  };
  const workspaceOf = (sandbox: SandboxRef) => {
    const ws = state.workspaces.get(sandbox.id);
    if (!ws || state.destroyed.includes(sandbox.id)) throw new SandboxError('SANDBOX_NOT_FOUND', '沙箱不存在');
    return ws;
  };
  const driver: WorkspaceSandboxDriver = {
    async create(template, options) {
      const id = randomUUID();
      state.workspaces.set(id, new Map());
      return Object.freeze({ id, template, jobId: options.jobId, expiresAt: new Date(Date.now() + SANDBOX_TEMPLATES[template].lifetimeMs) });
    },
    async copyIn(sandbox, files) {
      const ws = workspaceOf(sandbox);
      for (const file of files) ws.set(file.path, Buffer.from((file as { data: Buffer }).data));
    },
    async exec(sandbox, _command, _args, options = {}) {
      const ws = workspaceOf(sandbox);
      const { token, ...request } = JSON.parse(options.input!.toString('utf8')) as Record<string, any>;
      if (request.action === 'remove') {
        let removed = 0;
        for (const path of request.paths as string[]) if (ws.delete(path)) removed += 1;
        return execResult({ ok: true, action: 'remove', removed });
      }
      if (request.action === 'child-prompt') {
        const identity = await lookupAgentJobToken(appDb, token);
        const scope = identity ? (await superuser.selectFrom('agent_tool_scopes').select('tools').where('job_id', '=', identity.jobId).executeTakeFirst())?.tools ?? null : null;
        const call = { request, token, scope };
        state.children.push(call);
        state.running += 1;
        state.maxRunning = Math.max(state.maxRunning, state.running);
        try {
          if (options.signal?.aborted) throw new SandboxError('SANDBOX_ABORTED', '已中止');
          const outcome = await state.childScript(call, ws);
          if (options.signal?.aborted) throw new SandboxError('SANDBOX_ABORTED', '已中止');
          return execResult({ ok: true, action: 'child-prompt', ...outcome });
        } finally {
          state.running -= 1;
        }
      }
      // 主会话：第一条提示词调用长时工具并等待结果（与沙箱内的桩相同），之后的提示词直接结束。
      state.mainTokens.push(token);
      if (state.mainTokens.length === 1) state.longResults.push(await callLongTool(token));
      return execResult({ ok: true, action: 'prompt', session: request.session ?? sessionName(), turns: 1, stopReason: 'stop' });
    },
    async copyOut() {
      throw new Error('not used');
    },
    async copyOutArchive(sandbox, options = {}) {
      const ws = workspaceOf(sandbox);
      const tar = createArchive([...ws].map(([path, data]) => ({ path, data })), SANDBOX_TEMPLATES[sandbox.template].output);
      return toOutputArchive(Readable.from([tar]), SANDBOX_TEMPLATES[sandbox.template].output, { signal: options.signal });
    },
    async copyInArchive(sandbox, archive) {
      const ws = workspaceOf(sandbox);
      const source = Buffer.isBuffer(archive) ? Readable.from([archive]) : Readable.from(archive as AsyncIterable<Buffer>);
      for (const file of await readArchive(source, SANDBOX_TEMPLATES[sandbox.template].input)) ws.set(file.path, file.data);
    },
    async destroy(sandbox) {
      state.destroyed.push(sandbox.id);
    },
  };
  return { driver, state };
}

/** 主会话的桩：登记长时工具请求并等待执行者写下结果。 */
async function callLongTool(token: string): Promise<AgentToolRequestResult> {
  const identity = (await lookupAgentJobToken(appDb, token))!;
  const tenant = agentTenantContext(identity);
  const ref = { tenant, jobId: identity.jobId, runId: identity.runId };
  let state = await withTenant(appDb, tenant, (trx) => openAgentToolRequest(trx, ref, LONG_TOOL, {}));
  for (let index = 0; index < 600 && state.kind === 'pending'; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const requestId = state.requestId;
    state = await withTenant(appDb, tenant, (trx) => pollAgentToolRequest(trx, ref, requestId));
  }
  if (state.kind !== 'finished') return { outcome: 'failed' };
  return state.result;
}

/** 子会话的模型调用：以请求中的令牌经 agent-gw（与 Pi 子会话相同的路径），每次的内容不同。 */
async function childChat(token: string, text: string): Promise<number> {
  const response = await fetch(`${gwOrigin}${AGENT_CHAT_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: text }], stream: true, max_tokens: 500 }),
  });
  await response.text();
  return response.status;
}

/** 默认的子会话：调用模型 CALLS_PER_CHILD 次（被拒绝即按模型调用失败结束），改写本节；s1 的子会话另改动本批以外与受保护的文件。 */
const defaultChild: ChildScript = async (call, ws) => {
  const section = BATCH.find((target) => call.request.prompt.includes(`文件为 ${target.file}。`))!;
  const session = call.request.session ?? sessionName();
  for (let index = 0; index < CALLS_PER_CHILD; index += 1) {
    if ((await childChat(call.token, `${section.id} 第 ${index + 1} 次 ${randomUUID()}`)) !== 200) return { session, turns: index + 1, outcome: 'model-failed', reason: null };
  }
  // 停留一下，让各子会话确实重叠。
  await new Promise((resolve) => setTimeout(resolve, 100));
  ws.set(section.file, Buffer.from(edited(section.id)));
  // 并发地改写、删除受保护文件，改动本批以外的小节、新建本批以外原本不存在的小节。
  ws.set(PROTECTED, Buffer.from(`被 ${section.id} 改写`));
  if (section.id === 's1') {
    ws.set('正文/s6.html', Buffer.from('被子任务改动'));
    ws.set('正文/s7.html', Buffer.from('被子任务新建'));
  }
  if (section.id === 's2') ws.delete(PROTECTED);
  return { session, turns: CALLS_PER_CHILD, outcome: 'stop', reason: null };
};

let fake: ReturnType<typeof fakeDriver>;
let step: (run: AgentRun) => Promise<void> = async () => {};

function childType(type: string, agentLimits: AgentTaskLimits): JobTypeDefinition<Record<string, never>> {
  return {
    type,
    queue: 'agent',
    resumable: true,
    maxAttempts: 3,
    agentLimits,
    agentTools: ['ask-user', LONG_TOOL],
    agentWorkspace: { taskKind: 'technical-plan-content' },
    agentSandboxTemplate: 'agent-content',
    parseParams: () => ({}),
    async run(context) {
      await withAgentRun(context.agent, (run) => step(run));
    },
  };
}
const registry = createJobTypeRegistry([
  childType('test-children', AGENT_TASK_LIMITS.contentGeneration),
  childType('test-children-turns', { costLimit: AGENT_TASK_LIMITS.contentGeneration.costLimit, turnLimit: 6 }),
  childType('test-children-cost', { costLimit: 1n, turnLimit: 3_000 }),
]);

/** 任务：放入受保护文件与正文，执行一条带长时工具的提示词（执行函数并发编辑 BATCH），再执行一条提示词（之前还原受保护文件）。 */
function editingStep(outcomes: { edit?: EditContentSectionsResult; restored?: readonly string[]; errors: unknown[] }) {
  return async (run: AgentRun) => {
    await run.baseline.write(run.sandbox, 'inputs', [{ path: PROTECTED, data: Buffer.from(PROTECTED_ORIGINAL) }]);
    await run.writeFiles(TARGETS.slice(0, 6).map((target) => ({ path: target.file, data: Buffer.from(original(target.id)) })));
    // 一条提示词之外不能运行子会话；受保护文件不能删除。
    for (const promise of [run.childPrompt({ prompt: '修复' }), run.removeFiles([PROTECTED])]) outcomes.errors.push(await promise.then(() => null, (error: unknown) => error));
    const activity = createContentSectionEditActivity();
    await run.prompt({
      stage: 'writing',
      prompt: '写作',
      tools: ['read', 'ask-user'],
      longTools: {
        [LONG_TOOL]: async ({ signal }) => {
          outcomes.edit = await editContentSections({
            run,
            jobs: BATCH.map((target) => ({ section_id: target.id, instructions: `修复 ${target.id}` })),
            targets: new Map(TARGETS.map((target) => [target.id, target])),
            activity,
            factsRequirements: '按全局事实设定执行。',
            rules: PROTECTED_ORIGINAL,
            title: '提交问题修复',
            instructions: '只修复本次列出的问题。',
            preloadInput: true,
            inspect: async () => ({ issues: [] }),
            signal,
          });
          return { results: outcomes.edit.results, restored: outcomes.edit.restored };
        },
      },
    });
    outcomes.restored = (await run.prompt({ stage: 'writing', prompt: '继续', tools: ['read'] })).restored;
  };
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
  await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'agent-children-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
  const past = new Date(Date.now() - 30 * 86_400_000);
  await superuser.insertInto('model_prices').values({ provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: '20000', output_price_per_mtok: '80000', effective_from: past, created_at: past, created_by: platformAdmin }).execute();
  platformModelId = (await superuser.insertInto('platform_models').values({ provider: 'deepseek', model: 'deepseek-chat', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin }).returning('id').executeTakeFirstOrThrow()).id;
  database = createDatabase(testDb.appConfig);
  appDb = database.db;
  provider = await startMockProvider(API_KEY);
  await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'deepseek', baseUrl: provider.baseUrl, apiKey: API_KEY });
  const aiGateway = createAiGateway({ db: appDb, keyWrapper, settings: SETTINGS, log: Fastify({ logger: createLoggerOptions({ level: 'info', stream: createLogCapture().stream }) }).log });
  endpoint = await buildAgentEndpointApp({ db: appDb, relayKey: RELAY_KEY, logLevel: 'info', logStream: createLogCapture().stream, gateway: aiGateway, maxOutputTokens: 1000 });
  await endpoint.listen({ host: '127.0.0.1', port: 0 });
  agentGw = await buildAgentGateway({ upstream: `http://127.0.0.1:${(endpoint.server.address() as AddressInfo).port}`, relayKey: RELAY_KEY, logLevel: 'info', logStream: createLogCapture().stream });
  await agentGw.listen({ host: '127.0.0.1', port: 0 });
  gwOrigin = `http://127.0.0.1:${(agentGw.server.address() as AddressInfo).port}`;
  redis = rawRedis();
  prefix = uniquePrefix();
});

beforeEach(() => {
  fake = fakeDriver();
  fake.state.childScript = defaultChild;
  provider.reset();
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await wipeQueueKeys(redis, prefix);
});

afterAll(async () => {
  redis?.disconnect();
  await agentGw?.close();
  await endpoint?.close();
  await provider?.close();
  await database?.destroy();
  await testDb?.drop();
});

async function start(type: string) {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x', email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  await superuser.insertInto('org_settings').values({ org_id: orgId, platform_model_id: platformModelId, updated_by: userId }).execute();
  await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: 10_000_000n, reference: null, note: '测试充值' });
  const context: TenantContext = { orgId, userId, role: 'owner' };
  const projectId = (await superuser.insertInto('projects').values({ org_id: orgId, kind: 'technical-plan', name: '项目', created_by: userId }).returning('id').executeTakeFirstOrThrow()).id;
  const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-children-dispatch'), prefix });
  dispatchers.push(dispatcher);
  const runner = createJobRunner({
    db: appDb,
    registry,
    dispatcher,
    connection: bullmqConnection(redisConfig(), 'worker', 'test-children-worker'),
    log: testLogger().log,
    prefix,
    leaseMs: 8_000,
    reconcileIntervalMs: 600_000,
    concurrency: { agent: 2 },
    objectStore: memoryStore(),
    sandbox: fake.driver,
    agentQuota: { orgAgentRunningLimit: 10 },
    agentModel: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    agentSandboxCreateDelaysMs: [],
  });
  runners.push(runner);
  await runner.start();
  const job = await enqueueJob({ db: appDb, registry, dispatcher, log: testLogger().log, agentQuota: { orgAgentRunningLimit: 10 } }, context, { type, params: {}, projectId });
  return job.id;
}

async function waitStatus(jobId: string, status: string) {
  return waitFor(async () => {
    const row = await superuser.selectFrom('jobs').select(['status', 'pause_reason', 'error_code']).where('id', '=', jobId).executeTakeFirstOrThrow();
    return row.status === status ? row : null;
  }, 30_000, `任务 ${status}`);
}

describe('沙箱内的并发子会话（8.10c3b2）', () => {
  it('并发子会话：读写互不覆盖、本批以外的小节还原；模型调用计入本任务的轮数与费用；受保护文件全部还原；至多 3 个同时运行', async () => {
    const outcomes: { edit?: EditContentSectionsResult; restored?: readonly string[]; errors: unknown[] } = { errors: [] };
    step = editingStep(outcomes);
    const jobId = await start('test-children');
    await waitStatus(jobId, 'succeeded');
    const ws = fake.state.workspaces.values().next().value!;

    // 程序错误：一条提示词之外不能运行子会话；受保护文件不能删除。
    expect(outcomes.errors).toEqual([expect.any(TypeError), expect.any(TypeError)]);
    // 1. 各子会话改写的小节都保留；本批以外被改动的还原、被新建的删除。
    expect(outcomes.edit!.results).toEqual(BATCH.map((target) => ({ section_id: target.id, status: 'success' })));
    expect(outcomes.edit!.restored).toEqual(['正文/s6.html', '正文/s7.html']);
    for (const target of BATCH) expect(ws.get(target.file)?.toString('utf8')).toBe(edited(target.id));
    expect(ws.get('正文/s6.html')?.toString('utf8')).toBe(original('s6'));
    expect(ws.has('正文/s7.html')).toBe(false);
    expect(fake.state.longResults).toEqual([{ outcome: 'succeeded', result: { results: outcomes.edit!.results, restored: ['正文/s6.html', '正文/s7.html'] } }]);
    // 3. 受保护文件被几个子会话同时改写、删除，下一条提示词之前还原为原件。
    expect(outcomes.restored).toEqual([PROTECTED]);
    expect(ws.get(PROTECTED)?.toString('utf8')).toBe(PROTECTED_ORIGINAL);

    // 并发：5 个子会话，同时至多 3 个，确实达到 3 个。
    expect(fake.state.children).toHaveLength(BATCH.length);
    expect(fake.state.maxRunning).toBe(AGENT_CHILD_SESSION_CONCURRENCY);
    // 子会话用主会话的同一个令牌，只有原生工具，业务工具的范围不变（仍是主会话本条提示词写下的 ask-user）。
    for (const child of fake.state.children) {
      expect(child.token).toBe(fake.state.mainTokens[0]);
      expect(child.request).toMatchObject({ action: 'child-prompt', tools: [...AGENT_NATIVE_TOOLS], maxTurns: 100 });
      expect(child.request.timeoutMs).toBeLessThanOrEqual(AGENT_CHILD_TIMEOUT_MS);
      expect(child.scope).toEqual(['ask-user']);
    }
    // 2. 所有子会话的模型调用计入本任务：轮数与费用都记在同一个任务上。
    const calls = BATCH.length * CALLS_PER_CHILD;
    const budget = await superuser.selectFrom('agent_job_budgets').select(['turns_used', 'exhausted_reason']).where('job_id', '=', jobId).executeTakeFirstOrThrow();
    expect(budget).toEqual({ turns_used: calls, exhausted_reason: null });
    const usage = await superuser.selectFrom('usage_records').select(['status', 'amount', 'job_id']).where('job_id', '=', jobId).execute();
    expect(usage).toHaveLength(calls);
    expect(usage.every((row) => row.status === 'billed')).toBe(true);
    expect(usage.every((row) => BigInt(row.amount) > 0n)).toBe(true);
    expect(provider.requests).toHaveLength(calls);
  });

  it.each([
    ['test-children-turns', 'task_turn_limit'],
    ['test-children-cost', 'task_cost_limit'],
  ] as const)('%s：子会话的模型调用达到本任务的上限时被拒绝，本批中止，任务暂停为 %s', async (type, reason) => {
    const outcomes: { edit?: EditContentSectionsResult; restored?: readonly string[]; errors: unknown[] } = { errors: [] };
    step = editingStep(outcomes);
    const jobId = await start(type);
    const row = await waitStatus(jobId, 'paused');
    expect(row.pause_reason).toBe(reason);
    expect(outcomes.edit).toBeUndefined();
    const budget = await superuser.selectFrom('agent_job_budgets').select(['turns_used', 'exhausted_reason']).where('job_id', '=', jobId).executeTakeFirstOrThrow();
    expect(budget.exhausted_reason).toBe(reason);
    if (reason === 'task_turn_limit') expect(budget.turns_used).toBe(6);
    // 长时工具按 failed 写下（主会话只得到固定说明），沙箱随之销毁。
    expect(fake.state.longResults).toEqual([{ outcome: 'failed' }]);
    expect(fake.state.destroyed).toHaveLength(1);
  });

  it('子会话报告失败：只影响本节（原因交回主 Agent），不写失败报告、任务继续', async () => {
    fake.state.childScript = async (call, ws) => {
      const section = BATCH.find((target) => call.request.prompt.includes(`文件为 ${target.file}。`))!;
      if (section.id === 's3') return { session: sessionName(), turns: 1, outcome: 'reported', reason: '本节缺少招标文件中的参数' };
      ws.set(section.file, Buffer.from(edited(section.id)));
      return { session: sessionName(), turns: 1, outcome: 'stop', reason: null };
    };
    const outcomes: { edit?: EditContentSectionsResult; restored?: readonly string[]; errors: unknown[] } = { errors: [] };
    step = editingStep(outcomes);
    const jobId = await start('test-children');
    await waitStatus(jobId, 'succeeded');
    expect(outcomes.edit!.results.find((result) => result.section_id === 's3')).toEqual({ section_id: 's3', status: 'error', error: '本节缺少招标文件中的参数' });
    expect(await superuser.selectFrom('agent_failure_reports').select('job_id').where('job_id', '=', jobId).execute()).toEqual([]);
  });
});
