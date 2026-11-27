// 业务工具 check-word-count（路线图第 8 步 8.10c3b1）经 agent-gw 与真实数据库的长时调用交接（迁移 0047_agent_tool_requests）：
// 沙箱一侧以空参数调用；执行者一侧 serveAgentToolRequests 认领请求、用 check-word-count 的执行函数统计各节字数并写回清单（工作区是
// 替身），结果交回调用方；正文有问题时 422（说明交给 Agent）；进入图片保护后 generate-sections 422。工具登记的参数、次数上限与生产
// 登记相同，只缩短等待。
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
import { createAgentLongTool, serveAgentToolRequests, type AgentLongToolExecutor } from '../../src/agent/toolRequests.ts';
import { agentToolRegistry } from '../../src/agent/toolRegistry.ts';
import { setAgentToolScope } from '../../src/agent/toolScope.ts';
import { AGENT_TOOL_CALL_PATH, createAgentToolRegistry } from '../../src/agent/tools.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { claimJob, insertJob, type RunRef } from '../../src/jobs/store.ts';
import { createContentImageProtection } from '../../src/technicalPlan/contentImageProtection.ts';
import { createGenerateSectionsExecutor, GENERATE_SECTIONS_TOOL, GENERATE_SECTIONS_TOOL_OPTIONS } from '../../src/technicalPlan/contentSectionGeneration.ts';
import {
  CHECK_WORD_COUNT_TOOL,
  CHECK_WORD_COUNT_TOOL_OPTIONS,
  checkWordCountTool,
  CONTENT_WORD_COUNT_FILE,
  createCheckWordCountExecutor,
  WORD_COUNT_ONLY_NOTE,
} from '../../src/technicalPlan/contentWordCount.ts';
import { createLogCapture } from '../helpers.ts';
import { MATERIALS } from '../technicalPlan/generateSectionsFixture.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;
const WAIT_MS = 400;
const TOOLS = createAgentToolRegistry([
  createAgentLongTool({ ...CHECK_WORD_COUNT_TOOL_OPTIONS, waitMs: WAIT_MS, pollMs: 20 }),
  createAgentLongTool({ ...GENERATE_SECTIONS_TOOL_OPTIONS, waitMs: WAIT_MS, pollMs: 20 }),
]);
const BOTH = [CHECK_WORD_COUNT_TOOL, GENERATE_SECTIONS_TOOL];
const TARGETS = MATERIALS.decisions.targets;
const HTML = (n: number) => `<!-- app:block -->\n<p id="s_p001">第 ${n} 节的正文段落。</p>`;

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
  expect(await setAgentToolScope(appDb, run, BOTH, BOTH)).toBe(true);
  return { run, token: issued!.token };
}

/** 沙箱内的桩：pending 时以相同参数再次调用，直到拿到结果或错误。 */
async function callUntilDone(token: string, name: string, args: unknown = {}): Promise<{ status: number; body: Record<string, any> }> {
  for (let calls = 1; calls <= 50; calls += 1) {
    const response = await fetch(`${gwOrigin}${AGENT_TOOL_CALL_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, any>) : {};
    if (response.status !== 200 || body.result?.pending !== true) return { status: response.status, body };
  }
  throw new Error(`${name} did not finish`);
}

function memoryRun(files: Record<string, string>) {
  const store = new Map<string, Buffer>(Object.entries(files).map(([path, data]) => [path, Buffer.from(data, 'utf8')]));
  return {
    store,
    async readFiles(paths: readonly string[], limits: { maxFileBytes?: number } = {}): Promise<ReadonlyMap<string, AgentWorkspaceFile>> {
      return new Map(paths.filter((path) => store.has(path)).map((path) => [path, { size: store.get(path)!.length, data: store.get(path)!.length <= (limits.maxFileBytes ?? Infinity) ? store.get(path)! : null }]));
    },
    async writeFiles(list: readonly { path: string; data: Buffer }[]): Promise<void> {
      for (const file of list) store.set(file.path, file.data);
    },
  };
}

function serve(member: Member, run: RunRef, executors: Map<string, AgentLongToolExecutor>) {
  const controller = new AbortController();
  const serving = serveAgentToolRequests({ db: appDb, ref: { tenant: member.context, jobId: run.jobId, runId: run.runId }, executors, signal: controller.signal, pollMs: 20 });
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
    toolsForJobType: (type) => (type === 'content-generation' ? BOTH : []),
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

describe('check-word-count 经 agent-gw', () => {
  it('生产登记的工具与这里的参数、上限相同（只缩短等待）', () => {
    const registered = agentToolRegistry.get(CHECK_WORD_COUNT_TOOL)!;
    expect(registered.name).toBe(checkWordCountTool.name);
    const tested = TOOLS.get(CHECK_WORD_COUNT_TOOL)!;
    for (const key of ['argumentsSchema', 'maxArgumentBytes', 'maxCallsPerJob', 'maxCallsPerMinute'] as const) {
      expect(tested[key]).toEqual(registered[key]);
      expect(registered[key]).toEqual(checkWordCountTool[key]);
    }
  });

  it('全部正文就绪：结果交回、清单写回工作区、进入图片保护；之后 generate-sections 422；参数不是空对象时 400', async () => {
    const member = await newOrg();
    const { run, token } = await runningJob(member);
    expect((await callUntilDone(token, CHECK_WORD_COUNT_TOOL, { force: true })).status).toBe(400);
    const workspace = memoryRun(Object.fromEntries(TARGETS.map((target, index) => [target.file, HTML(index + 1)])));
    const protection = createContentImageProtection();
    const ai = { chat: async () => { throw new Error('the model must not be called'); } };
    const executors = new Map<string, AgentLongToolExecutor>([
      [CHECK_WORD_COUNT_TOOL, createCheckWordCountExecutor({ run: workspace, targets: TARGETS, wordControl: MATERIALS.decisions.word_control, protection })],
      [GENERATE_SECTIONS_TOOL, createGenerateSectionsExecutor({ run: workspace, ai: ai as never, model: { provider: 'deepseek', model: 'deepseek-chat' } as never, materials: MATERIALS, protection }).execute],
    ]);
    const { controller, serving } = serve(member, run, executors);
    const done = await callUntilDone(token, CHECK_WORD_COUNT_TOOL);
    expect(done.status).toBe(200);
    expect(done.body.result).toMatchObject({ complete: true, section_count: TARGETS.length, missing_count: 0, detail_file: CONTENT_WORD_COUNT_FILE, note: WORD_COUNT_ONLY_NOTE });
    expect(done.body.result).not.toHaveProperty('difference');
    expect(JSON.parse(workspace.store.get(CONTENT_WORD_COUNT_FILE)!.toString('utf8')).sections).toHaveLength(TARGETS.length);
    expect(protection.active).toBe(true);
    const blocked = await callUntilDone(token, GENERATE_SECTIONS_TOOL);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toMatchObject({ code: 'AGENT_TOOL_REJECTED', message: `正文编辑期间不能调用 ${GENERATE_SECTIONS_TOOL}，请只调整文字并保留图片。` });
    controller.abort();
    expect(await serving).toBeNull();
    const rows = await superuser.selectFrom('agent_tool_requests').select(['tool', 'status', 'outcome']).where('job_id', '=', run.jobId).orderBy('created_at').execute();
    expect(rows).toEqual([
      { tool: CHECK_WORD_COUNT_TOOL, status: 'consumed', outcome: 'succeeded' },
      { tool: GENERATE_SECTIONS_TOOL, status: 'consumed', outcome: 'rejected' },
    ]);
  });

  it('正文有问题：422，说明交给 Agent，不进入保护、不写清单；修正后再次调用通过', async () => {
    const member = await newOrg();
    const { run, token } = await runningJob(member);
    const files = Object.fromEntries(TARGETS.map((target, index) => [target.file, HTML(index + 1)]));
    files[TARGETS[1]!.file] = '# 第二节\n\nMarkdown 正文';
    const workspace = memoryRun(files);
    const protection = createContentImageProtection();
    const executors = new Map([[CHECK_WORD_COUNT_TOOL, createCheckWordCountExecutor({ run: workspace, targets: TARGETS, wordControl: MATERIALS.decisions.word_control, protection })]]);
    const { controller, serving } = serve(member, run, executors);
    const rejected = await callUntilDone(token, CHECK_WORD_COUNT_TOOL);
    expect(rejected.status).toBe(422);
    expect(rejected.body.error).toMatchObject({ code: 'AGENT_TOOL_REJECTED' });
    expect(rejected.body.error.message).toMatch(new RegExp(`^${TARGETS[1]!.file}：必须输出带 app:block 分隔的有效受限 HTML 正文`));
    expect(protection.active).toBe(false);
    expect(workspace.store.has(CONTENT_WORD_COUNT_FILE)).toBe(false);
    workspace.store.set(TARGETS[1]!.file, Buffer.from(HTML(2)));
    expect((await callUntilDone(token, CHECK_WORD_COUNT_TOOL)).status).toBe(200);
    expect(protection.active).toBe(true);
    controller.abort();
    expect(await serving).toBeNull();
  });
});
