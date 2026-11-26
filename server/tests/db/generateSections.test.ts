// 业务工具 generate-sections（路线图第 8 步 8.10c2b2）经 agent-gw 与真实数据库的长时调用交接（迁移 0047_agent_tool_requests）：
// 沙箱一侧以空参数调用，未完成时 pending、以相同参数再次调用；执行者一侧 serveAgentToolRequests 认领请求、用 generate-sections 的执行函数
// 生成并写回各节（工作区与 JobAi 是替身），结果（统计与未成功项）交回调用方；任务文件的问题 422（说明交给 Agent）；余额不足等
// 致命错误 503（固定说明），执行者停止认领并交出该错误。工具登记的参数、次数上限与生产登记相同，只缩短等待。
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import type { AgentWorkspaceFile } from '../../src/agent/execution.ts';
import { buildAgentGateway } from '../../src/agent/gateway.ts';
import { issueAgentJobToken } from '../../src/agent/tokenStore.ts';
import { AGENT_TOOL_FAILED_MESSAGE, createAgentLongTool, serveAgentToolRequests } from '../../src/agent/toolRequests.ts';
import { agentToolRegistry } from '../../src/agent/toolRegistry.ts';
import { setAgentToolScope } from '../../src/agent/toolScope.ts';
import { AGENT_TOOL_CALL_PATH, createAgentToolRegistry } from '../../src/agent/tools.ts';
import type { ChatResult } from '../../src/ai/gateway.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { JobBalanceExhaustedError, type JobAi } from '../../src/jobs/definitions.ts';
import { claimJob, insertJob, type RunRef } from '../../src/jobs/store.ts';
import {
  createGenerateSectionsExecutor,
  GENERATE_SECTIONS_TOOL,
  GENERATE_SECTIONS_TOOL_OPTIONS,
  generateSectionsTool,
} from '../../src/technicalPlan/contentSectionGeneration.ts';
import { CONTENT_SECTIONS_TASK_FILE } from '../../src/technicalPlan/contentSectionWriting.ts';
import { contentSectionFile } from '../../src/technicalPlan/contentWriting.ts';
import { createLogCapture } from '../helpers.ts';
import { LEAF, MATERIALS } from '../technicalPlan/generateSectionsFixture.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;
const WAIT_MS = 400;
const TOOLS = createAgentToolRegistry([createAgentLongTool({ ...GENERATE_SECTIONS_TOOL_OPTIONS, waitMs: WAIT_MS, pollMs: 20 })]);
const MODEL = { provider: 'deepseek', model: 'deepseek-chat' } as const;
const HTML = (n: number) => `<!-- app:block -->\n<p>第 ${n} 节的正文段落。</p>`;

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let endpoint: FastifyInstance;
let agentGw: FastifyInstance;
let gwOrigin: string;

interface Member {
  orgId: string;
  context: TenantContext;
}

async function newOrg(): Promise<Member> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x', email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, context: { orgId, userId, role: 'owner' } };
}

async function runningJob(member: Member): Promise<{ run: RunRef; token: string }> {
  const project = await withTenant(appDb, member.context, (trx) =>
    trx.insertInto('projects').values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.context.userId }).returning('id').executeTakeFirstOrThrow(),
  );
  const job = await insertJob(appDb, member.context, { type: 'content-generation', params: {}, projectId: project.id, agentLimits: AGENT_TASK_LIMITS.contentGeneration });
  const runId = randomUUID();
  const claimed = await claimJob(appDb, { orgId: member.orgId, jobId: job.id, runId, leaseMs: LEASE_MS, orgRunningLimit: 100, agentQuota: { orgAgentRunningLimit: 100 }, attemptsFor: () => 5 });
  expect(claimed.kind).toBe('claimed');
  const run = { orgId: member.orgId, jobId: job.id, runId };
  const issued = await issueAgentJobToken(appDb, run, TTL_MS);
  expect(await setAgentToolScope(appDb, run, [GENERATE_SECTIONS_TOOL], [GENERATE_SECTIONS_TOOL])).toBe(true);
  return { run, token: issued!.token };
}

async function call(token: string, args: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${gwOrigin}${AGENT_TOOL_CALL_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: GENERATE_SECTIONS_TOOL, arguments: args }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

/** 沙箱内的桩：pending 时以相同参数再次调用，直到拿到结果或错误。 */
async function callUntilDone(token: string): Promise<{ status: number; body: Record<string, any>; calls: number }> {
  for (let calls = 1; calls <= 50; calls += 1) {
    const response = await call(token, {});
    if (response.status !== 200 || response.body.result?.pending !== true) return { ...response, calls };
  }
  throw new Error('generate-sections did not finish');
}

function memoryRun(files: Record<string, string>) {
  const store = new Map<string, Buffer>(Object.entries(files).map(([path, data]) => [path, Buffer.from(data, 'utf8')]));
  return {
    store,
    async readFiles(paths: readonly string[]): Promise<ReadonlyMap<string, AgentWorkspaceFile>> {
      return new Map(paths.filter((path) => store.has(path)).map((path) => [path, { size: store.get(path)!.length, data: store.get(path)! }]));
    },
    async writeFiles(list: readonly { path: string; data: Buffer }[]): Promise<void> {
      for (const file of list) store.set(file.path, file.data);
    },
  };
}

function fakeAi(reply: (stepKey: string) => string | Error): JobAi {
  return {
    async chat(request) {
      const value = reply(request.stepKey);
      if (value instanceof Error) throw value;
      // 模型调用要花一些时间：第一次工具调用拿到 pending。
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS + 200));
      return { requestId: randomUUID(), content: value, reasoningContent: '', toolCalls: [], finishReason: 'stop', aborted: false, reused: false, usage: {} as ChatResult['usage'], billing: { status: 'billed', amount: 0n } };
    },
  };
}

const sectionNumber = (stepKey: string) => Number(stepKey.split(':')[1]!.slice(-2));

function serve(member: Member, run: RunRef, execute: ReturnType<typeof createGenerateSectionsExecutor>['execute']) {
  const controller = new AbortController();
  const serving = serveAgentToolRequests({
    db: appDb,
    ref: { tenant: member.context, jobId: run.jobId, runId: run.runId },
    executors: new Map([[GENERATE_SECTIONS_TOOL, execute]]),
    signal: controller.signal,
    pollMs: 20,
  });
  return { controller, serving };
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
    toolsForJobType: (type) => (type === 'content-generation' ? [GENERATE_SECTIONS_TOOL] : []),
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

describe('generate-sections 经 agent-gw', () => {
  it('生产登记的工具与这里的参数、上限相同（只缩短等待）', () => {
    const registered = agentToolRegistry.get(GENERATE_SECTIONS_TOOL)!;
    expect(registered.name).toBe(generateSectionsTool.name);
    const tested = TOOLS.get(GENERATE_SECTIONS_TOOL)!;
    for (const key of ['argumentsSchema', 'maxArgumentBytes', 'maxCallsPerJob', 'maxCallsPerMinute'] as const) {
      expect(tested[key]).toEqual(registered[key]);
      expect(registered[key]).toEqual(generateSectionsTool[key]);
    }
  });

  it('pending 后以相同参数取回结果；各节写回工作区；参数不是空对象时 400', async () => {
    const member = await newOrg();
    const { run, token } = await runningJob(member);
    expect((await call(token, { section_ids: [LEAF(1)] })).status).toBe(400);
    const workspace = memoryRun({ [CONTENT_SECTIONS_TASK_FILE]: JSON.stringify({ sections: [1, 2].map((n) => ({ section_id: LEAF(n), instructions: '', references: '' })) }) });
    const executor = createGenerateSectionsExecutor({ run: workspace, ai: fakeAi((key) => (key.startsWith('content-section:') ? HTML(sectionNumber(key)) : '')), model: MODEL, materials: MATERIALS, warmupSettleMs: 0 });
    const { controller, serving } = serve(member, run, executor.execute);
    const done = await callUntilDone(token);
    controller.abort();
    expect(await serving).toBeNull();
    expect(done.status).toBe(200);
    expect(done.calls).toBeGreaterThan(1);
    expect(done.body.result).toEqual({ total: 2, success: 2, skipped: 0, unresolved: [] });
    expect(workspace.store.get(contentSectionFile(LEAF(2)))!.toString('utf8')).toBe(HTML(2));
    const rows = await superuser.selectFrom('agent_tool_requests').select(['tool', 'status', 'outcome']).where('job_id', '=', run.jobId).execute();
    expect(rows).toEqual([{ tool: GENERATE_SECTIONS_TOOL, status: 'consumed', outcome: 'succeeded' }]);
  });

  it('任务文件的问题 422，说明交给 Agent，执行者继续认领', async () => {
    const member = await newOrg();
    const { run, token } = await runningJob(member);
    const workspace = memoryRun({});
    const executor = createGenerateSectionsExecutor({ run: workspace, ai: fakeAi(() => new Error('the model must not be called')), model: MODEL, materials: MATERIALS });
    const { controller, serving } = serve(member, run, executor.execute);
    const done = await callUntilDone(token);
    expect(done.status).toBe(422);
    expect(done.body.error).toMatchObject({ code: 'AGENT_TOOL_REJECTED', message: `请先将任务写入 ${CONTENT_SECTIONS_TASK_FILE}，再调用本工具提交` });
    // 修正后再次提交。
    workspace.store.set(CONTENT_SECTIONS_TASK_FILE, Buffer.from(JSON.stringify({ sections: [{ section_id: 'x', instructions: '', references: '' }] })));
    expect((await callUntilDone(token)).body.error).toMatchObject({ code: 'AGENT_TOOL_REJECTED', message: '任务文件只能包含本次目标小节，且同一小节不能重复出现：x' });
    controller.abort();
    expect(await serving).toBeNull();
  });

  it('余额不足：503 固定说明，执行者停止认领并交出该错误', async () => {
    const member = await newOrg();
    const { run, token } = await runningJob(member);
    const workspace = memoryRun({ [CONTENT_SECTIONS_TASK_FILE]: JSON.stringify({ sections: [{ section_id: LEAF(1), instructions: '', references: '' }] }) });
    const exhausted = new JobBalanceExhaustedError();
    const executor = createGenerateSectionsExecutor({ run: workspace, ai: fakeAi(() => exhausted), model: MODEL, materials: MATERIALS });
    const { serving } = serve(member, run, executor.execute);
    const done = await callUntilDone(token);
    expect(done.status).toBe(503);
    expect(done.body.error).toMatchObject({ code: 'AGENT_TOOL_FAILED', message: AGENT_TOOL_FAILED_MESSAGE });
    expect(await serving).toBe(exhausted);
    expect(workspace.store.has(contentSectionFile(LEAF(1)))).toBe(false);
  });
});
