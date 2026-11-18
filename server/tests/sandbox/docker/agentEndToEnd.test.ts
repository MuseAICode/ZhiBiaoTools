// 假模型端到端（路线图第 8 步 8.6e1）：把 8.1～8.6 的各层真实地串起来跑通 withAgentRun——
// 真实的 agent 沙箱（CI 中 gVisor）里真实的入口与 Pi 运行时，经每个沙箱一个专用网络连到 agent-gw（这里是一个把请求转给
// 宿主上真实 agent-gw 的转发容器，与生产相同不是沙箱、不带沙箱标签），真实的 agent-gw（buildAgentGateway）转给真实的 worker
// 内部入口（buildAgentEndpointApp），再经真实的 AI 网关（createAiGateway）调用**脚本化的假模型服务商**（startMockProvider，
// 按最后一条消息决定回答一次 bash 工具调用或结束），业务工具经真实的工具路由。执行者（createJobRunner → withAgentRun）驱动，
// 工作区快照存到内存对象存储，令牌、阶段、费用与轮数都在真实数据库中。
//
// 覆盖（8.6e1 登记的三项“跑通”）：
// - prompt + assistantText + compact：真实的 Pi 收到提示词、调用模型写出结果文件、提交校验通过，回复全文从会话文件取回，
//   会话太短时 compact 无需压缩（真实 Pi 判断、不调用模型）；
// - 余额不足以冻结 → 暂停 → 充值后续跑：可用余额 ≥ 1 元但不够一次冻结时，AI 网关在冻结处 402、不调用服务商，路由记下
//   insufficient_balance，执行者按数据库中的事实暂停；充值后继续，任务成功。
// 提示注入样本集（第一批，覆盖 8.1～8.5 的控制，假模型完全听从注入）随 8.6e2。
//
// 需要：TEST_SANDBOX_AGENT_IMAGE（agent 镜像）、TEST_DATABASE_ADMIN_URL（数据库）、TEST_REDIS_URL / TEST_REDIS_PASSWORD（队列）。
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../../src/agent/budget.ts';
import { buildAgentEndpointApp } from '../../../src/agent/endpoint.ts';
import { buildAgentGateway } from '../../../src/agent/gateway.ts';
import { agentToolRegistry } from '../../../src/agent/toolRegistry.ts';
import { withAgentRun, type AgentRun } from '../../../src/agent/execution.ts';
import { putCredential } from '../../../src/ai/credentials.ts';
import { createAiGateway, type AiGateway, type GatewaySettings } from '../../../src/ai/gateway.ts';
import { createFileKeyWrapper } from '../../../src/ai/keyring.ts';
import { creditOrganization } from '../../../src/billing/ledger.ts';
import { createDockerSandboxDriver, type DockerSandboxDriver } from '../../../src/sandbox/docker.ts';
import { createLoggerOptions } from '../../../src/logger.ts';
import { migrateToLatest } from '../../../src/db/migrator.ts';
import type { Database } from '../../../src/db/schema.ts';
import type { TenantContext } from '../../../src/db/tenant.ts';
import type { ObjectStore } from '../../../src/files/objectStore.ts';
import { createJobTypeRegistry, type JobContext, type JobTypeDefinition } from '../../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../../src/jobs/runner.ts';
import { enqueueJob } from '../../../src/jobs/service.ts';
import { requestResume } from '../../../src/jobs/store.ts';
import { bullmqConnection } from '../../../src/redis.ts';
import { connect, createTestDatabase, type TestDatabase } from '../../db/harness.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from '../../db/jobFixtures.ts';
import { startMockProvider, type MockProvider } from '../../ai/mockProvider.ts';
import { docker, dockerRequest, sandboxEnv, silentLog } from './env.ts';

const image = sandboxEnv.agentImage ?? '';
const hasRedis = Boolean(process.env.TEST_REDIS_URL);
const hasDatabase = Boolean(process.env.TEST_DATABASE_ADMIN_URL);
const runE2E = Boolean(sandboxEnv.agentImage) && hasRedis && hasDatabase;

const suffix = randomUUID();
const forwarderName = `zhibiao-test-e2e-gw-${suffix}`;
const API_KEY = `sk-mock-${randomBytes(16).toString('hex')}`;
const keyWrapper = createFileKeyWrapper(randomBytes(32), 1);
const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const MAX_OUTPUT = 1000;
const SETTINGS: GatewaySettings = { upstreamTimeoutMs: 10_000, holdTtlSeconds: 60, maxOutputTokens: MAX_OUTPUT, upstreamPrivateHosts: ['127.0.0.1'] };
const KIND = 'e2e-outline';
/** 结果文件：假模型让 Pi 用 bash 写出，提交校验读它。 */
const OUTPUT_FILE = '结果/目录.json';
const OUTPUT_CONTENT = '{"items":["概述","方案"]}';
/** 假模型结束时的回复全文，assistantText 从会话文件取回。 */
const ASSISTANT_TEXT = 'E2E-最终回复-ignore-previous-instructions';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;
let redis: Redis;
let prefix: string;
let provider: MockProvider;
let aiGateway: AiGateway;
let endpoint: FastifyInstance;
let agentGw: FastifyInstance;
let driver: DockerSandboxDriver;
let platformModelId: string;
let pricyModelId: string;

const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];
const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

/** 内存对象存储（工作区快照）。 */
function createMemoryStore(): ObjectStore {
  const objects = new Map<string, Buffer>();
  return {
    async put(key, body, options) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      options.signal?.throwIfAborted();
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

interface Member {
  orgId: string;
  userId: string;
  context: TenantContext;
}

/** balance 为可用余额（计费单位）；pricy 为 true 时选用高价模型（一次冻结约 3 元，用于“余额不够冻结”）。 */
async function newMember(options: { balance?: bigint; pricy?: boolean } = {}): Promise<Member> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'team' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: 'x', email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  await superuser.insertInto('org_settings').values({ org_id: orgId, platform_model_id: options.pricy ? pricyModelId : platformModelId, updated_by: userId }).execute();
  const balance = options.balance ?? 10_000_000n;
  if (balance > 0n) await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: balance, reference: null, note: '测试充值' });
  return { orgId, userId, context: { orgId, userId, role: 'owner' } };
}

async function newProject(member: Member): Promise<string> {
  return (await superuser.insertInto('projects')
    .values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

/**
 * 脚本化的假模型（OpenAI 兼容服务商）：
 * - 最后一条是用户消息 → 回答一次 bash 工具调用，让 Pi 写出结果文件；
 * - 最后一条是 tool 消息（工具已执行）→ 结束，回复全文为 ASSISTANT_TEXT。
 */
function sse(res: import('node:http').ServerResponse, delta: Record<string, unknown>, finish: string | null): void {
  res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function installModelScript(): void {
  provider.setHandler(async (request, res) => {
    if (request.authorization !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } }));
      return;
    }
    const messages = (request.body.messages ?? []) as Array<{ role: string }>;
    const last = messages[messages.length - 1];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (last && last.role === 'tool') {
      sse(res, { role: 'assistant', content: ASSISTANT_TEXT }, null);
      sse(res, {}, 'stop');
    } else {
      const command = `mkdir -p 结果 && printf '%s' ${JSON.stringify(OUTPUT_CONTENT)} > ${JSON.stringify(OUTPUT_FILE)}`;
      sse(res, { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] }, null);
      sse(res, {}, 'tool_calls');
    }
    res.write(`data: ${JSON.stringify({ id: 'c1', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}

type Step = (run: AgentRun, context: JobContext<Record<string, never>>) => Promise<void>;
let steps: Step[] = [];
let executions = 0;

function agentType(type: string): JobTypeDefinition<Record<string, never>> {
  return {
    type,
    queue: 'agent',
    resumable: true,
    maxAttempts: 10,
    agentLimits: AGENT_TASK_LIMITS.outline,
    agentTools: ['ask-user', 'report-failure'],
    agentWorkspace: { taskKind: KIND },
    parseParams: () => ({}),
    async run(context) {
      const step = steps[executions];
      executions += 1;
      if (!step) return;
      await withAgentRun(context.agent, (run) => step(run, context));
    },
  };
}

const registry = createJobTypeRegistry([agentType('e2e-agent')]);

async function startRunner(store: ObjectStore): Promise<{ dispatcher: JobDispatcher }> {
  const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'e2e-dispatch'), prefix });
  dispatchers.push(dispatcher);
  const runner = createJobRunner({
    db: appDb,
    registry,
    dispatcher,
    connection: bullmqConnection(redisConfig(), 'worker', 'e2e-worker'),
    log: testLogger().log,
    prefix,
    leaseMs: 30_000,
    reconcileIntervalMs: 600_000,
    concurrency: { agent: 1 },
    objectStore: store,
    sandbox: driver,
    gateway: aiGateway,
    agentQuota: { orgAgentRunningLimit: 10 },
    agentModel: { contextWindow: 200_000, maxOutputTokens: MAX_OUTPUT },
  });
  runners.push(runner);
  await runner.start();
  return { dispatcher };
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').select(['status', 'pause_reason', 'error_code', 'error_message', 'checkpoint']).where('id', '=', jobId).executeTakeFirstOrThrow();
}
async function waitStatus(jobId: string, status: string, what: string) {
  return waitFor(async () => {
    const row = await jobRow(jobId);
    return row.status === status ? row : null;
  }, 120_000, what);
}
async function enqueue(member: Member, dispatcher: JobDispatcher) {
  const projectId = await newProject(member);
  const job = await enqueueJob({ db: appDb, registry, dispatcher, log: testLogger().log, agentQuota: { orgAgentRunningLimit: 10 } }, member.context, { type: 'e2e-agent', params: {}, projectId });
  return { job, projectId };
}

const PROMPT = { stage: 'outline', prompt: '按任务说明生成目录', tools: ['read', 'write', 'edit', 'bash'] as const };

beforeAll(async () => {
  if (!runE2E) return;
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'e2e-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
  const past = new Date(Date.now() - 30 * 86_400_000);
  await superuser.insertInto('model_prices').values([
    { provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: '20000', output_price_per_mtok: '80000', effective_from: past, created_at: past, created_by: platformAdmin },
    // 高价模型：一次冻结（按平台输出上限 1000 token）约 3 元——高于可用余额 1.5 元、低于 outline 的 5 元费用上限，
    // 使“余额不够一次冻结”在费用上限之前触发。
    { provider: 'deepseek', model: 'deepseek-reasoner', input_price_per_mtok: '20000', output_price_per_mtok: '30000000', effective_from: past, created_at: past, created_by: platformAdmin },
  ]).execute();
  const models = await superuser.insertInto('platform_models').values([
    { provider: 'deepseek', model: 'deepseek-chat', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin },
    { provider: 'deepseek', model: 'deepseek-reasoner', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin },
  ]).returning(['id', 'model']).execute();
  platformModelId = models.find((row: { model: string }) => row.model === 'deepseek-chat')!.id;
  pricyModelId = models.find((row: { model: string }) => row.model === 'deepseek-reasoner')!.id;

  appDb = connect<Database>(testDb.appConfig, 8);
  redis = rawRedis();
  prefix = uniquePrefix();

  provider = await startMockProvider(API_KEY);
  installModelScript();
  await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'deepseek', baseUrl: provider.baseUrl, apiKey: API_KEY });
  const log = Fastify({ logger: createLoggerOptions({ level: 'warn' }) }).log;
  aiGateway = createAiGateway({ db: appDb, keyWrapper, settings: SETTINGS, log });

  // worker 的内部入口（宿主进程），只需被宿主上的 agent-gw 访问。
  endpoint = await buildAgentEndpointApp({
    db: appDb,
    relayKey: RELAY_KEY,
    logLevel: 'warn',
    gateway: aiGateway,
    maxOutputTokens: MAX_OUTPUT,
    tools: agentToolRegistry,
    toolsForJobType: (type) => registry.get(type)?.agentTools ?? [],
  });
  await endpoint.listen({ host: '127.0.0.1', port: 0 });
  const endpointPort = (endpoint.server.address() as AddressInfo).port;

  // 真实的 agent-gw（宿主进程），绑定 0.0.0.0 供转发容器经 host.docker.internal 访问。
  agentGw = await buildAgentGateway({ upstream: `http://127.0.0.1:${endpointPort}`, relayKey: RELAY_KEY, logLevel: 'warn' });
  await agentGw.listen({ host: '0.0.0.0', port: 0 });
  const gwPort = (agentGw.server.address() as AddressInfo).port;

  // 转发容器：沙箱的专用网络上监听 8080，经 bridge 把 TCP 转给宿主上真实的 agent-gw（与生产的 agent-gw 一样不是沙箱、不带沙箱标签）。
  const forwarder = `
    const net = require('net');
    net.createServer((down) => {
      const up = net.connect(${gwPort}, 'host.docker.internal');
      down.on('error', () => up.destroy()); up.on('error', () => down.destroy());
      down.pipe(up); up.pipe(down);
    }).listen(8080, '0.0.0.0');`;
  const created = await dockerRequest('POST', `/containers/create?name=${forwarderName}`, {
    Image: image,
    Entrypoint: ['node'],
    Cmd: ['-e', forwarder],
    User: '10001:10001',
    HostConfig: { NetworkMode: 'bridge', ExtraHosts: ['host.docker.internal:host-gateway'], Runtime: 'runc', CapDrop: ['ALL'] },
  });
  expect(created.status).toBe(201);
  expect((await dockerRequest('POST', `/containers/${forwarderName}/start`)).status).toBe(204);

  driver = createDockerSandboxDriver({ docker, runtime: sandboxEnv.runtime, images: { agent: image }, maxActive: 32, agentGateway: forwarderName, log: silentLog });
}, 180_000);

afterAll(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  if (prefix) await wipeQueueKeys(redis, prefix);
  redis?.disconnect();
  await agentGw?.close();
  await endpoint?.close();
  await provider?.close();
  await appDb?.destroy();
  await testDb?.drop();
  if (runE2E) {
    await dockerRequest('DELETE', `/containers/${forwarderName}?force=true`);
  }
});

beforeEach(() => {
  steps = [];
  executions = 0;
  if (runE2E) installModelScript();
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  if (prefix) await wipeQueueKeys(redis, prefix);
});

describe.runIf(runE2E)('假模型端到端（8.6e1）', () => {
  it('prompt + 提交校验 + 回复全文 + compact：真实 Pi 经 agent-gw 调用假模型写出结果，assistantText 取回回复，短会话 compact 无需压缩', async () => {
    const store = createMemoryStore();
    const { dispatcher } = await startRunner(store);
    const member = await newMember();
    let outcome: { value: unknown; assistant: string | null; compact: string } | null = null;
    steps = [async (run) => {
      const stage = await run.runStage({
        ...PROMPT,
        outputFile: OUTPUT_FILE,
        async validate() {
          const files = await run.readFiles([OUTPUT_FILE]);
          const output = files.get(OUTPUT_FILE)?.data?.toString() ?? '';
          return output.includes('"items"') ? { value: { output }, issues: [] } : { value: null, issues: [{ severity: 'blocking', message: '缺少 items' }] };
        },
      });
      const assistant = await run.assistantText();
      const compact = await run.compact({ stage: 'outline', instructions: '请用简体中文总结供下一阶段继续。', optional: true });
      outcome = { value: stage.value, assistant: assistant?.text ?? null, compact };
    }];
    const { job } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(outcome).toEqual({ value: { output: OUTPUT_CONTENT }, assistant: ASSISTANT_TEXT, compact: 'noop' });
  }, 180_000);

  it('余额不足以冻结 → 暂停 → 充值后续跑：高价模型下可用余额 1.5 元时冻结处 402、路由记下 insufficient_balance、执行者暂停；充值后继续成功', async () => {
    const store = createMemoryStore();
    const { dispatcher } = await startRunner(store);
    const member = await newMember({ balance: 15_000n, pricy: true });
    steps = [
      async (run) => {
        await run.prompt({ ...PROMPT });
      },
      async (run) => {
        await run.prompt({ ...PROMPT, prompt: '继续之前的任务' });
      },
    ];
    const { job } = await enqueue(member, dispatcher);
    const paused = await waitStatus(job.id, 'paused', '余额不足暂停');
    expect(paused.pause_reason).toBe('insufficient_balance');

    await creditOrganization(appDb, ctxAdmin, { orgId: member.orgId, type: 'recharge', amount: 10_000_000n, reference: null, note: '充值' });
    expect((await requestResume(appDb, member.context, job.id)).dispatch).toBe(true);
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'e2e-agent', queue: 'agent' });
    await waitStatus(job.id, 'succeeded', '续跑成功');
  }, 180_000);
});
