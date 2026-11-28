// 业务工具 fix-submission-issues（路线图第 8 步 8.10c3b3）经 agent-gw 与真实数据库的长时调用交接（迁移 0047_agent_tool_requests）：
// 沙箱一侧以空参数调用；执行者一侧 serveAgentToolRequests 认领请求、用 fix-submission-issues 的执行函数读取问题清单、复查并派发子会话
// （工作区与子会话是替身；真实沙箱中的并发子会话见 tests/db/agentChildSessions.test.ts），结果交回调用方；没有问题清单时 422（说明交给
// Agent）；参数不是空对象时 400。工具登记的参数、次数上限与生产登记相同，只缩短等待。
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import { buildAgentEndpointApp } from '../../src/agent/endpoint.ts';
import type { AgentChildPromptInput, AgentWorkspaceFile } from '../../src/agent/execution.ts';
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
import { createContentSectionEditActivity } from '../../src/technicalPlan/contentSectionEditing.ts';
import { CONTENT_SUBMISSION_ISSUES_FILE } from '../../src/technicalPlan/contentSubmission.ts';
import { createSubmissionFixExecutor, SUBMISSION_FIX_TOOL, SUBMISSION_FIX_TOOL_OPTIONS, submissionFixTool } from '../../src/technicalPlan/contentSubmissionFix.ts';
import { createLogCapture } from '../helpers.ts';
import { MATERIALS } from '../technicalPlan/generateSectionsFixture.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');
const TTL_MS = 30 * 60_000;
const LEASE_MS = 60_000;
const WAIT_MS = 400;
const TOOLS = createAgentToolRegistry([createAgentLongTool({ ...SUBMISSION_FIX_TOOL_OPTIONS, waitMs: WAIT_MS, pollMs: 20 })]);
const TARGETS = MATERIALS.decisions.targets;
const HTML = (n: number) => `<!-- app:block -->\n<p id="s_p001">第 ${n} 节的正文段落。</p>`;
const UNCLOSED = (n: number) => `<!-- app:block -->\n<p id="s_p001">第 ${n} 节的正文段落<strong>未闭合</p>`;

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
  expect(await setAgentToolScope(appDb, run, [SUBMISSION_FIX_TOOL], [SUBMISSION_FIX_TOOL])).toBe(true);
  return { run, token: issued!.token };
}

/** 沙箱内的桩：pending 时以相同参数再次调用，直到拿到结果或错误。 */
async function callUntilDone(token: string, args: unknown = {}): Promise<{ status: number; body: Record<string, any>; calls: number }> {
  for (let calls = 1; calls <= 100; calls += 1) {
    const response = await fetch(`${gwOrigin}${AGENT_TOOL_CALL_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: SUBMISSION_FIX_TOOL, arguments: args }),
    });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, any>) : {};
    if (response.status !== 200 || body.result?.pending !== true) return { status: response.status, body, calls };
  }
  throw new Error(`${SUBMISSION_FIX_TOOL} did not finish`);
}

/** 工作区与子会话的替身：子会话等待一段时间（使长时调用经历 pending）后把本节改为闭合的正文。 */
function memoryRun(files: Record<string, string>, childDelayMs = 0) {
  const store = new Map<string, Buffer>(Object.entries(files).map(([path, data]) => [path, Buffer.from(data, 'utf8')]));
  const prompts: AgentChildPromptInput[] = [];
  return {
    store,
    prompts,
    async readFiles(paths: readonly string[], limits: { maxFileBytes?: number } = {}): Promise<ReadonlyMap<string, AgentWorkspaceFile>> {
      return new Map(paths.filter((path) => store.has(path)).map((path) => [path, { size: store.get(path)!.length, data: store.get(path)!.length <= (limits.maxFileBytes ?? Infinity) ? store.get(path)! : null }]));
    },
    async writeFiles(list: readonly { path: string; data: Buffer }[]): Promise<void> {
      for (const file of list) store.set(file.path, file.data);
    },
    async removeFiles(paths: readonly string[]): Promise<void> {
      for (const path of paths) store.delete(path);
    },
    async childPrompt(input: AgentChildPromptInput) {
      prompts.push(input);
      await new Promise((resolve) => setTimeout(resolve, childDelayMs));
      const index = TARGETS.findIndex((target) => input.prompt.includes(`文件为 ${target.file}。`));
      store.set(TARGETS[index]!.file, Buffer.from(HTML(index + 1)));
      return { status: 'completed' as const, session: 'child.jsonl', turns: 3, reason: null };
    },
  };
}

function serve(member: Member, run: RunRef, executor: AgentLongToolExecutor) {
  const controller = new AbortController();
  const serving = serveAgentToolRequests({
    db: appDb,
    ref: { tenant: member.context, jobId: run.jobId, runId: run.runId },
    executors: new Map([[SUBMISSION_FIX_TOOL, executor]]),
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
    toolsForJobType: (type) => (type === 'content-generation' ? [SUBMISSION_FIX_TOOL] : []),
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

describe('fix-submission-issues 经 agent-gw', () => {
  it('生产登记的工具与这里的参数、上限相同（只缩短等待）', () => {
    const registered = agentToolRegistry.get(SUBMISSION_FIX_TOOL)!;
    expect(registered.name).toBe(submissionFixTool.name);
    const tested = TOOLS.get(SUBMISSION_FIX_TOOL)!;
    for (const key of ['argumentsSchema', 'maxArgumentBytes', 'maxCallsPerJob', 'maxCallsPerMinute'] as const) {
      expect(tested[key]).toEqual(registered[key]);
      expect(registered[key]).toEqual(submissionFixTool[key]);
    }
  });

  it('有问题的小节交给子会话修复：pending 后取回结果，各节写回工作区；参数不是空对象时 400', async () => {
    const member = await newOrg();
    const { run, token } = await runningJob(member);
    expect((await callUntilDone(token, { section_ids: ['x'] })).status).toBe(400);
    const files = Object.fromEntries(TARGETS.map((target, index) => [target.file, index === 0 ? HTML(1) : UNCLOSED(index + 1)]));
    files[CONTENT_SUBMISSION_ISSUES_FILE] = JSON.stringify({ issues: TARGETS.map((target) => ({ section_id: target.id })) });
    const workspace = memoryRun(files, WAIT_MS * 2);
    const executor = createSubmissionFixExecutor({ run: workspace, materials: MATERIALS, activity: createContentSectionEditActivity() });
    const { controller, serving } = serve(member, run, executor);
    const done = await callUntilDone(token);
    expect(done.status).toBe(200);
    // 子会话比一次等待更久：桩经历了 pending 后以相同参数再次调用。
    expect(done.calls).toBeGreaterThan(1);
    expect(done.body.result).toEqual({ total: TARGETS.length, success: TARGETS.length - 1, skipped: 1, unresolved: [] });
    expect(workspace.prompts).toHaveLength(TARGETS.length - 1);
    TARGETS.forEach((target, index) => expect(workspace.store.get(target.file)!.toString('utf8')).toBe(HTML(index + 1)));
    controller.abort();
    expect(await serving).toBeNull();
    const rows = await superuser.selectFrom('agent_tool_requests').select(['tool', 'status', 'outcome']).where('job_id', '=', run.jobId).execute();
    expect(rows).toEqual([{ tool: SUBMISSION_FIX_TOOL, status: 'consumed', outcome: 'succeeded' }]);
  });

  it('没有问题清单：422，说明交给 Agent，不派发子会话', async () => {
    const member = await newOrg();
    const { run, token } = await runningJob(member);
    const workspace = memoryRun({ [TARGETS[0]!.file]: HTML(1) });
    const executor = createSubmissionFixExecutor({ run: workspace, materials: MATERIALS, activity: createContentSectionEditActivity() });
    const { controller, serving } = serve(member, run, executor);
    const rejected = await callUntilDone(token);
    expect(rejected.status).toBe(422);
    expect(rejected.body.error).toMatchObject({ code: 'AGENT_TOOL_REJECTED', message: '当前没有待修复的提交校验问题' });
    expect(workspace.prompts).toEqual([]);
    controller.abort();
    expect(await serving).toBeNull();
  });
});
