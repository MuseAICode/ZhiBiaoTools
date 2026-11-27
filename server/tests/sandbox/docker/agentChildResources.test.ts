// 主会话 + 3 个并发子会话的资源测量（路线图第 8 步 8.10c3b2 登记、#127 之后用户要求提前到第 8 步）：在 8.6e1 的假模型端到端拓扑上
// （真实沙箱——CI 中 gVisor 与真实 agent 镜像——里真实的入口与 Pi 运行时，经转发容器连到宿主上真实的 agent-gw → worker 内部入口 →
// AI 网关 → 脚本化的假模型服务商），执行者驱动一条主会话的提示词：主会话调用长时工具，执行函数在同一沙箱内同时运行
// AGENT_CHILD_SESSION_CONCURRENCY（3）个子会话（与 8.10c3b3 的 fix-submission-issues 相同的用法），每个子会话带上较大的提示词
// （按桌面版预先提供规范与本节正文的用法放大到约 300 KiB），经几轮 read / bash / edit 改写自己的小节。
// 期间按 SAMPLE_INTERVAL_MS 经 Docker 的 stats 接口采样沙箱容器的内存（usage，及扣除 inactive_file 的工作集）与进程数（pids），记下峰值，
// 以一行 “[agent-child-resources] {...}” 输出到测试日志，并断言峰值不超过模板上限（2 GiB、pids 256）的 75%。
//
// 需要：TEST_SANDBOX_AGENT_IMAGE、TEST_DATABASE_ADMIN_URL、TEST_REDIS_URL / TEST_REDIS_PASSWORD（与 agentEndToEnd.test.ts 相同）。
import { randomBytes, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../../src/agent/budget.ts';
import { buildAgentEndpointApp } from '../../../src/agent/endpoint.ts';
import { AGENT_CHILD_SESSION_CONCURRENCY, withAgentRun, type AgentChildPromptOutcome, type AgentRun } from '../../../src/agent/execution.ts';
import { buildAgentGateway } from '../../../src/agent/gateway.ts';
import { createAgentLongTool } from '../../../src/agent/toolRequests.ts';
import { createAgentToolRegistry } from '../../../src/agent/tools.ts';
import { putCredential } from '../../../src/ai/credentials.ts';
import { createAiGateway, type GatewaySettings } from '../../../src/ai/gateway.ts';
import { createFileKeyWrapper } from '../../../src/ai/keyring.ts';
import { creditOrganization } from '../../../src/billing/ledger.ts';
import { migrateToLatest } from '../../../src/db/migrator.ts';
import type { Database } from '../../../src/db/schema.ts';
import type { TenantContext } from '../../../src/db/tenant.ts';
import type { ObjectStore } from '../../../src/files/objectStore.ts';
import { createJobTypeRegistry, type JobTypeDefinition } from '../../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../../src/jobs/runner.ts';
import { enqueueJob } from '../../../src/jobs/service.ts';
import { createLoggerOptions } from '../../../src/logger.ts';
import { bullmqConnection } from '../../../src/redis.ts';
import { createDockerSandboxDriver } from '../../../src/sandbox/docker.ts';
import { SANDBOX_CONTAINER_PREFIX, SANDBOX_TEMPLATES } from '../../../src/sandbox/templates.ts';
import { CHECK_WORD_COUNT_TOOL, CHECK_WORD_COUNT_TOOL_OPTIONS } from '../../../src/technicalPlan/contentWordCount.ts';
import { startMockProvider, type MockProvider } from '../../ai/mockProvider.ts';
import { connect, createTestDatabase, type TestDatabase } from '../../db/harness.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from '../../db/jobFixtures.ts';
import { docker, dockerRequest, sandboxEnv, silentLog } from './env.ts';

const image = sandboxEnv.agentImage ?? '';
const runE2E = Boolean(sandboxEnv.agentImage) && Boolean(process.env.TEST_REDIS_URL) && Boolean(process.env.TEST_DATABASE_ADMIN_URL);

const suffix = randomUUID();
const forwarderName = `zhibiao-test-child-gw-${suffix}`;
const API_KEY = `sk-mock-${randomBytes(16).toString('hex')}`;
const keyWrapper = createFileKeyWrapper(randomBytes(32), 1);
const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const MAX_OUTPUT = 1000;
const SETTINGS: GatewaySettings = { upstreamTimeoutMs: 30_000, holdTtlSeconds: 120, maxOutputTokens: MAX_OUTPUT, upstreamPrivateHosts: ['127.0.0.1'] };
const TEMPLATE = SANDBOX_TEMPLATES['agent-content'];
const SAMPLE_INTERVAL_MS = 250;
/** 每次模型回答前的停顿：让主会话与各子会话的进程确实同时存在。 */
const MODEL_DELAY_MS = 1_500;
/** 子会话提示词中的“预先提供的材料”（桌面版 preloadInput：规范全文与本节完整 HTML），放大到约 300 KiB。 */
const PRELOAD = `受限 HTML 生成规范（完整内容）：\n${'规范条目：段落使用 p，列表使用 ul / ol，表格使用 table。\n'.repeat(4_000)}`;
const SECTIONS = Array.from({ length: AGENT_CHILD_SESSION_CONCURRENCY }, (_, index) => ({ id: `c${index + 1}`, file: `正文/c${index + 1}.html` }));
const original = (id: string) => `<!-- app:block -->\n<p id="s_p001">${id} 原文：${'正文内容。'.repeat(2_000)}</p>`;

let testDb: TestDatabase | undefined;
let appDb: Kysely<Database> | undefined;
let redis: Redis | undefined;
let prefix = '';
let provider: MockProvider | undefined;
let endpoint: FastifyInstance | undefined;
let agentGw: FastifyInstance | undefined;
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];

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

function sse(res: ServerResponse, delta: Record<string, unknown>, finish: string | null): void {
  res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

/** 同时在途的模型调用（按会话标记）：确认子会话确实并发。 */
const inFlight = new Set<string>();
let maxInFlightChildren = 0;

/**
 * 假模型：按第一条用户消息中的标记区分会话，按已执行的工具次数决定下一步。
 * - 主会话：调用 check-word-count（长时工具，执行函数运行子会话），工具返回后结束；
 * - 子会话：read 本节 → bash 统计 → edit 本节 → 结束。
 */
function installModelScript(mock: MockProvider): void {
  mock.setHandler(async (request, res) => {
    const messages = (request.body.messages ?? []) as Array<{ role: string; content?: unknown }>;
    const firstUser = messages.find((message) => message.role === 'user');
    const text = typeof firstUser?.content === 'string' ? firstUser.content : JSON.stringify(firstUser?.content ?? '');
    const tools = messages.filter((message) => message.role === 'tool').length;
    const child = SECTIONS.find((section) => text.includes(`【子会话 ${section.id}】`));
    const key = child ? child.id : 'main';
    inFlight.add(`${key}:${randomUUID()}`);
    const mine = [...inFlight].at(-1)!;
    maxInFlightChildren = Math.max(maxInFlightChildren, [...inFlight].filter((item) => !item.startsWith('main:')).length);
    try {
      await new Promise((resolve) => setTimeout(resolve, MODEL_DELAY_MS));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const call = (name: string, args: Record<string, unknown>) => {
        sse(res, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${tools}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null);
        sse(res, {}, 'tool_calls');
      };
      if (!child) {
        if (tools === 0) call(CHECK_WORD_COUNT_TOOL, {});
        else {
          sse(res, { role: 'assistant', content: '主会话完成' }, null);
          sse(res, {}, 'stop');
        }
      } else if (tools === 0) {
        call('read', { path: child.file });
      } else if (tools === 1) {
        call('bash', { command: `wc -c ${child.file} && grep -c 正文 ${child.file} && ls 正文` });
      } else if (tools === 2) {
        call('edit', { path: child.file, edits: [{ oldText: `${child.id} 原文`, newText: `${child.id} 修改后` }] });
      } else {
        sse(res, { role: 'assistant', content: '本节已完成' }, null);
        sse(res, {}, 'stop');
      }
      res.write(`data: ${JSON.stringify({ id: 'c1', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } finally {
      inFlight.delete(mine);
    }
  });
}

interface ResourcePeaks {
  samples: number;
  memoryUsagePeak: number;
  workingSetPeak: number;
  pidsPeak: number;
  memoryLimit: number;
  pidsLimit: number;
}

/** 按间隔采样容器的 stats（docker stats 的同一个接口）：内存 usage、扣除 inactive_file 的工作集、pids。 */
function startSampler(containerName: string): { stop(): Promise<ResourcePeaks> } {
  const peaks: ResourcePeaks = { samples: 0, memoryUsagePeak: 0, workingSetPeak: 0, pidsPeak: 0, memoryLimit: 0, pidsLimit: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      const response = await dockerRequest('GET', `/containers/${containerName}/stats?stream=false&one-shot=true`).catch(() => null);
      const stats = response?.status === 200 ? (response.json as Record<string, any>) : null;
      if (stats?.memory_stats) {
        const usage = Number(stats.memory_stats.usage ?? 0);
        const inactive = Number(stats.memory_stats.stats?.inactive_file ?? stats.memory_stats.stats?.total_inactive_file ?? 0);
        peaks.samples += 1;
        peaks.memoryUsagePeak = Math.max(peaks.memoryUsagePeak, usage, Number(stats.memory_stats.max_usage ?? 0));
        peaks.workingSetPeak = Math.max(peaks.workingSetPeak, usage - inactive);
        peaks.pidsPeak = Math.max(peaks.pidsPeak, Number(stats.pids_stats?.current ?? 0));
        peaks.memoryLimit = Number(stats.memory_stats.limit ?? 0);
        peaks.pidsLimit = Number(stats.pids_stats?.limit ?? 0);
      }
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return peaks;
    },
  };
}

afterAll(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  if (redis && prefix) await wipeQueueKeys(redis, prefix);
  redis?.disconnect();
  await agentGw?.close();
  await endpoint?.close();
  await provider?.close();
  await appDb?.destroy();
  await testDb?.drop();
  if (runE2E) await dockerRequest('DELETE', `/containers/${forwarderName}?force=true`);
});

describe.runIf(runE2E)('主会话 + 3 个并发子会话的资源（8.10c3b2）', () => {
  it('内存与进程数的峰值在 agent-content 模板上限（2 GiB、pids 256）的 75% 以内', async () => {
    testDb = await createTestDatabase();
    const owner = connect(testDb.ownerConfig);
    try {
      expect((await migrateToLatest(owner)).error).toBeUndefined();
    } finally {
      await owner.destroy();
    }
    const superuser = testDb.admin;
    const platformOrg = randomUUID();
    const platformAdmin = randomUUID();
    const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };
    await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
    await superuser.insertInto('users').values({ id: platformAdmin, email: 'child-resources-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
    await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
    const past = new Date(Date.now() - 30 * 86_400_000);
    await superuser.insertInto('model_prices').values({ provider: 'deepseek', model: 'deepseek-chat', input_price_per_mtok: '20000', output_price_per_mtok: '80000', effective_from: past, created_at: past, created_by: platformAdmin }).execute();
    const modelId = (await superuser.insertInto('platform_models').values({ provider: 'deepseek', model: 'deepseek-chat', is_free: false, enabled: true, created_by: platformAdmin, updated_by: platformAdmin }).returning('id').executeTakeFirstOrThrow()).id;
    appDb = connect<Database>(testDb.appConfig, 8);
    redis = rawRedis();
    prefix = uniquePrefix();

    provider = await startMockProvider(API_KEY);
    installModelScript(provider);
    await putCredential(appDb, ctxAdmin, keyWrapper, { provider: 'deepseek', baseUrl: provider.baseUrl, apiKey: API_KEY });
    const aiGateway = createAiGateway({ db: appDb, keyWrapper, settings: SETTINGS, log: Fastify({ logger: createLoggerOptions({ level: 'warn' }) }).log });

    const type: JobTypeDefinition<Record<string, never>> = {
      type: 'child-resources',
      queue: 'agent',
      resumable: true,
      maxAttempts: 1,
      agentLimits: AGENT_TASK_LIMITS.contentGeneration,
      agentTools: [CHECK_WORD_COUNT_TOOL],
      agentWorkspace: { taskKind: 'child-resources' },
      agentSandboxTemplate: 'agent-content',
      parseParams: () => ({}),
      async run(context) {
        await withAgentRun(context.agent, (run) => step(run));
      },
    };
    const registry = createJobTypeRegistry([type]);
    endpoint = await buildAgentEndpointApp({
      db: appDb,
      relayKey: RELAY_KEY,
      logLevel: 'warn',
      gateway: aiGateway,
      maxOutputTokens: MAX_OUTPUT,
      tools: createAgentToolRegistry([createAgentLongTool(CHECK_WORD_COUNT_TOOL_OPTIONS)]),
      toolsForJobType: (name) => registry.get(name)?.agentTools ?? [],
    });
    await endpoint.listen({ host: '127.0.0.1', port: 0 });
    agentGw = await buildAgentGateway({ upstream: `http://127.0.0.1:${(endpoint.server.address() as AddressInfo).port}`, relayKey: RELAY_KEY, logLevel: 'warn' });
    await agentGw.listen({ host: '0.0.0.0', port: 0 });
    const gwPort = (agentGw.server.address() as AddressInfo).port;
    const forwarder = `
      const net = require('net');
      net.createServer((down) => {
        const up = net.connect(${gwPort}, 'host.docker.internal');
        down.on('error', () => up.destroy()); up.on('error', () => down.destroy());
        down.pipe(up); up.pipe(down);
      }).listen(8080, '0.0.0.0');`;
    expect((await dockerRequest('POST', `/containers/create?name=${forwarderName}`, {
      Image: image,
      Entrypoint: ['node'],
      Cmd: ['-e', forwarder],
      User: '10001:10001',
      HostConfig: { NetworkMode: 'bridge', ExtraHosts: ['host.docker.internal:host-gateway'], Runtime: 'runc', CapDrop: ['ALL'] },
    })).status).toBe(201);
    expect((await dockerRequest('POST', `/containers/${forwarderName}/start`)).status).toBe(204);
    const driver = createDockerSandboxDriver({ docker, runtime: sandboxEnv.runtime, images: { agent: image }, maxActive: 32, agentGateway: forwarderName, log: silentLog });

    let peaks: ResourcePeaks | null = null;
    let outcomes: AgentChildPromptOutcome[] = [];
    let finalFiles = new Map<string, string>();
    const step = async (run: AgentRun) => {
      await run.writeFiles(SECTIONS.map((section) => ({ path: section.file, data: Buffer.from(original(section.id)) })));
      const sampler = startSampler(`${SANDBOX_CONTAINER_PREFIX}${run.sandbox.id}`);
      try {
        await run.prompt({
          stage: 'writing',
          prompt: '【主会话】调用 check-word-count',
          tools: ['read', 'bash', CHECK_WORD_COUNT_TOOL],
          longTools: {
            [CHECK_WORD_COUNT_TOOL]: async ({ signal }) => {
              outcomes = await Promise.all(SECTIONS.map((section) => run.childPrompt({
                prompt: `【子会话 ${section.id}】你负责编辑小节 ${section.file}。\n\n${PRELOAD}`,
                signal,
              })));
              return { done: true };
            },
          },
        });
      } finally {
        peaks = await sampler.stop();
      }
      const files = await run.readFiles(SECTIONS.map((section) => section.file));
      finalFiles = new Map([...files].map(([path, file]) => [path, file.data?.toString('utf8') ?? '']));
    };

    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'child-resources-dispatch'), prefix });
    dispatchers.push(dispatcher);
    const runner = createJobRunner({
      db: appDb,
      registry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'child-resources-worker'),
      log: testLogger().log,
      prefix,
      leaseMs: 30_000,
      reconcileIntervalMs: 600_000,
      concurrency: { agent: 1 },
      objectStore: memoryStore(),
      sandbox: driver,
      gateway: aiGateway,
      agentQuota: { orgAgentRunningLimit: 10 },
      agentModel: { contextWindow: 200_000, maxOutputTokens: MAX_OUTPUT },
    });
    runners.push(runner);
    await runner.start();

    const orgId = randomUUID();
    const userId = randomUUID();
    await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
    await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x', email_verified_at: new Date() }).execute();
    await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
    await superuser.insertInto('org_settings').values({ org_id: orgId, platform_model_id: modelId, updated_by: userId }).execute();
    await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: 10_000_000n, reference: null, note: '测试充值' });
    const context: TenantContext = { orgId, userId, role: 'owner' };
    const projectId = (await superuser.insertInto('projects').values({ org_id: orgId, kind: 'technical-plan', name: '项目', created_by: userId }).returning('id').executeTakeFirstOrThrow()).id;
    const job = await enqueueJob({ db: appDb, registry, dispatcher, log: testLogger().log, agentQuota: { orgAgentRunningLimit: 10 } }, context, { type: 'child-resources', params: {}, projectId });
    const row = await waitFor(async () => {
      const current = await superuser.selectFrom('jobs').select(['status', 'error_code', 'error_message']).where('id', '=', job.id).executeTakeFirstOrThrow();
      return ['succeeded', 'failed', 'paused'].includes(current.status) ? current : null;
    }, 280_000, '任务结束');

    const measured = peaks as ResourcePeaks | null;
    const report = {
      runtime: sandboxEnv.runtime,
      template: TEMPLATE.name,
      children: SECTIONS.length,
      maxInFlightChildren,
      ...measured,
      memoryUsagePeakMiB: measured ? Math.round(measured.memoryUsagePeak / 2 ** 20) : null,
      workingSetPeakMiB: measured ? Math.round(measured.workingSetPeak / 2 ** 20) : null,
      memoryLimitMiB: Math.round(TEMPLATE.memoryBytes / 2 ** 20),
      templatePidsLimit: TEMPLATE.pidsLimit,
      job: row,
    };
    process.stdout.write(`[agent-child-resources] ${JSON.stringify(report)}\n`);

    expect(row.status).toBe('succeeded');
    expect(outcomes.map((outcome) => outcome.status)).toEqual(SECTIONS.map(() => 'completed'));
    for (const section of SECTIONS) expect(finalFiles.get(section.file)).toContain(`${section.id} 修改后`);
    // 3 个子会话的模型调用确实同时在途（进程同时存在）。
    expect(maxInFlightChildren).toBe(SECTIONS.length);
    expect(measured!.samples).toBeGreaterThan(10);
    expect(measured!.memoryUsagePeak).toBeGreaterThan(0);
    expect(measured!.memoryUsagePeak).toBeLessThanOrEqual(TEMPLATE.memoryBytes * 0.75);
    expect(measured!.pidsPeak).toBeGreaterThan(0);
    expect(measured!.pidsPeak).toBeLessThanOrEqual(TEMPLATE.pidsLimit * 0.75);
  }, 300_000);
});
