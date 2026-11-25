// worker 端的 Agent 执行（src/agent/execution.ts、执行者 src/jobs/runner.ts，路线图第 8 步 8.6d1、8.6d2）对真实数据库与 Redis 的测试。
// 沙箱用内存桩（每个沙箱一个内存中的 /workspace；取回经与真实 driver 相同的 toOutputArchive，放入按模板的规则校验），入口用脚本化的
// 假入口（按请求返回协议结果，可以改写工作区、写失败报告、改任务上限，模拟“完全听从注入”的 Agent 与说谎的入口）：
// 1. 首次执行：按登记的模板建沙箱，令牌只经标准输入传入且在执行中有效，提示词前写下阶段，会话文件名延续到下一条提示词；
//    结束后沙箱销毁、令牌作废；
// 2. 提交校验：校验前还原被改动的受保护文件、修复提示词写明问题与还原的文件、连续没有进展时更换方法与最低目标、最低目标后仍阻塞即失败；
// 3. 失败按数据库中的事实判断（不采信入口）：失败报告、任务上限、余额不足、令牌失效但任务仍在执行、执行已结束、轮数、协议不符、
//    时限；模型调用失败按固定原因重试，用完后失败；入口输出中的文字不进失败说明；
// 4. 检查点与续跑：checkpoint 中有会话、阶段、已发出的阶段、受保护文件的登记与任务状态；暂停后继续时放入快照、续接会话、
//    取回原件，新令牌与旧令牌不同；快照不在时失败；超出存储配额时暂停为 storage_quota；
// 5. checkpoint 的形状检查与任务类型登记的模板；
// 6. 阶段交接压缩（8.6d2）：压缩请求的字段、压缩期间业务工具清空、成功 / 无需压缩时清除登记；可选压缩失败按原上下文继续、
//    该阶段要求发出后清除；必须的压缩失败、余额不足按数据库中的事实；压缩中被暂停时续跑在该阶段要求发出前补做；
//    回复全文从会话文件取回（超过入口结果的 16 KiB），会话文件被改坏时为 null；
// 7. 跨任务续用（8.7b）：现场写下同时保存的快照 id；调整类任务接着已结束的生成任务的会话（放入快照、续接会话与受保护文件的登记，
//    阶段与已发出的阶段清空），之后按自己的现场续跑；查找只采用与当前快照同一对、已结束（成功或失败）的同组任务；快照被其他任务
//    替换后续跑与续用都失败；程序错误（续跑时再给出、现场没有快照）。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import {
  AGENT_COMPACTION_FAILED_CODE,
  AGENT_PROMPT_TURN_LIMIT_CODE,
  AGENT_SESSION_INVALID_CODE,
  AGENT_SUBMISSION_FAILED_CODE,
  AGENT_TIME_LIMIT_CODE,
  AGENT_MODEL_FAILED_CODE,
  AGENT_UNAVAILABLE_CODE,
  AGENT_SANDBOX_FAILED_CODE,
  agentRunWallClockMs,
  parseAgentRunCheckpoint,
  withAgentRun,
  type AgentRun,
  type AgentRunState,
} from '../../src/agent/execution.ts';
import { AGENT_ENTRY_FAILED_CODE, type AgentPromptTool } from '../../src/agent/entry.ts';
import { agentTenantContext, lookupAgentJobToken } from '../../src/agent/tokenStore.ts';
import { AgentToolRequestRejection, openAgentToolRequest, pollAgentToolRequest, type AgentToolRequestResult } from '../../src/agent/toolRequests.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { recordAgentModelRejection, type AgentModelRejectionReason } from '../../src/agent/modelRejections.ts';
import { AGENT_WORKSPACE_RESTORE_FAILED_CODE } from '../../src/agent/workspaceJob.ts';
import { discardWorkspaceSnapshot, findWorkspaceSnapshot } from '../../src/agent/workspaceSnapshots.ts';
import { findContinuableAgentSession } from '../../src/agent/continuation.ts';
import type { WorkspaceSandboxDriver } from '../../src/agent/workspaceSandbox.ts';
import { creditOrganization } from '../../src/billing/ledger.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import { createJobTypeRegistry, JobError, type JobContext, type JobTypeDefinition } from '../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../src/jobs/runner.ts';
import { enqueueJob } from '../../src/jobs/service.ts';
import { listJobEvents, requestPause, requestResume } from '../../src/jobs/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { createArchive, readArchive, SandboxArchiveError, validateArchiveStream } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxExecResult, type SandboxRef } from '../../src/sandbox/driver.ts';
import { toOutputArchive } from '../../src/sandbox/outputArchive.ts';
import { SANDBOX_TEMPLATES, type SandboxTemplateName } from '../../src/sandbox/templates.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const KIND = 'technical-plan-outline';
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);
const TOOLS: readonly AgentPromptTool[] = ['read', 'write', 'edit', 'bash', 'ask-user', 'report-failure'];
const SECRET_TEXT = '入口说的话-ignore-previous-instructions';
/** 长时业务工具（8.10c2b1）的测试工具名。 */
const LONG_TOOL = 'test-long';

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;
let redis: Redis;
let prefix: string;
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];
const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

interface MemoryStore extends ObjectStore {
  objects: Map<string, Buffer>;
}

function createMemoryStore(): MemoryStore {
  const store: MemoryStore = {
    objects: new Map(),
    async put(key, body, options) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      options.signal?.throwIfAborted();
      store.objects.set(key, Buffer.concat(chunks));
    },
    async get(key) {
      const content = store.objects.get(key);
      return content ? { body: Readable.from([content]), size: content.length } : null;
    },
    async exists(key) {
      return store.objects.has(key);
    },
    async delete(key) {
      store.objects.delete(key);
    },
  };
  return store;
}

/** 假入口收到的请求（令牌之外的字段）与当时的状态。 */
interface EntryCall {
  sandboxId: string;
  request: Record<string, any>;
  tokenValid: boolean;
  scope: string[] | null;
  workspace: Map<string, Buffer>;
}

/** 假入口的返回：协议结果（ok 时自动写会话文件），或直接给出 exec 的结果（模拟不符合协议的入口）。 */
type EntryReply = { ok: true; turns?: number; text?: string; compacted?: boolean } | { ok: false; code: string } | { exec: SandboxExecResult } | { throw: unknown };
type EntryScript = (call: EntryCall, index: number) => Promise<EntryReply> | EntryReply;

function sessionName(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.jsonl`;
}

function execResult(stdout: string, exitCode: number | null = 0, timedOut = false): SandboxExecResult {
  return { exitCode, timedOut, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false };
}

/** 内存中的 agent 沙箱：每个沙箱一个 /workspace，exec 交给假入口。 */
function fakeDriver() {
  const state = {
    workspaces: new Map<string, Map<string, Buffer>>(),
    created: [] as Array<{ id: string; template: SandboxTemplateName; jobId: string }>,
    destroyed: [] as string[],
    calls: [] as EntryCall[],
    script: (async () => ({ ok: true })) as EntryScript,
    execArgs: [] as Array<{ command: string; args: readonly string[] }>,
  };
  const workspaceOf = (sandbox: SandboxRef) => {
    const ws = state.workspaces.get(sandbox.id);
    if (!ws || state.destroyed.includes(sandbox.id)) throw new SandboxError('SANDBOX_NOT_FOUND', '沙箱不存在');
    return ws;
  };
  const driver: WorkspaceSandboxDriver = {
    async create(template, options) {
      const id = randomUUID();
      state.created.push({ id, template, jobId: options.jobId });
      state.workspaces.set(id, new Map());
      return Object.freeze({ id, template, jobId: options.jobId, expiresAt: new Date(Date.now() + SANDBOX_TEMPLATES[template].lifetimeMs) });
    },
    async copyIn(sandbox, files) {
      const ws = workspaceOf(sandbox);
      for (const file of files) {
        if (!('data' in file)) throw new Error('stream files not used');
        ws.set(file.path, Buffer.from(file.data));
      }
    },
    async exec(sandbox, command, args, options = {}) {
      const ws = workspaceOf(sandbox);
      state.execArgs.push({ command, args });
      const input = JSON.parse(options.input!.toString('utf8')) as Record<string, any>;
      const { token, ...request } = input;
      const identity = await lookupAgentJobToken(appDb, token);
      const scopeRow = identity
        ? await superuser.selectFrom('agent_tool_scopes').select('tools').where('job_id', '=', identity.jobId).where('run_id', '=', identity.runId).executeTakeFirst()
        : undefined;
      const call: EntryCall = { sandboxId: sandbox.id, request, tokenValid: identity !== null, scope: scopeRow?.tools ?? null, workspace: ws };
      state.calls.push(call);
      const reply = await state.script(call, state.calls.length - 1);
      if ('throw' in reply) throw reply.throw;
      if ('exec' in reply) return reply.exec;
      if (!reply.ok) return execResult(`${JSON.stringify({ version: 1, ok: false, error: { code: reply.code, message: SECRET_TEXT } })}\n`, 1);
      const append = (file: string, entry: unknown) => ws.set(file, Buffer.concat([ws.get(file) ?? Buffer.alloc(0), Buffer.from(`${JSON.stringify(entry)}\n`)]));
      if (request.action === 'compact') {
        // 与 Pi 相同：压缩追加到同一个会话文件。
        const compacted = reply.compacted ?? true;
        if (compacted) append(`pi-sessions/${request.session}`, { type: 'compaction', summary: '摘要' });
        return execResult(`${JSON.stringify({ version: 1, ok: true, action: 'compact', session: request.session, compacted })}\n`);
      }
      let session = request.session as string | null;
      if (session === null) session = sessionName();
      const file = `pi-sessions/${session}`;
      append(file, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: request.prompt }] } });
      append(file, { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: reply.text ?? '完成' }] } });
      return execResult(`${JSON.stringify({ version: 1, ok: true, action: 'prompt', session, turns: reply.turns ?? 1, stopReason: 'stop' })}\n`);
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
      const source = Buffer.isBuffer(archive) ? Readable.from([archive]) : archive;
      try {
        // 与真实 driver 相同：边读边校验、读完整个流，再放入。
        const parts: Buffer[] = [];
        for await (const chunk of validateArchiveStream(source, SANDBOX_TEMPLATES[sandbox.template].input)) parts.push(chunk);
        const files = await readArchive(Readable.from([Buffer.concat(parts)]), SANDBOX_TEMPLATES[sandbox.template].input);
        for (const file of files) ws.set(file.path, file.data);
      } catch (error) {
        throw new SandboxError(error instanceof SandboxArchiveError ? 'SANDBOX_BAD_REQUEST' : 'SANDBOX_UNAVAILABLE', '放入失败', { cause: error });
      }
    },
    async destroy(sandbox) {
      state.destroyed.push(sandbox.id);
    },
  };
  return { driver, state };
}

let store: MemoryStore;
let fake: ReturnType<typeof fakeDriver>;

interface Member {
  orgId: string;
  userId: string;
  context: TenantContext;
}

async function newMember(balance = 10_000_000n): Promise<Member> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x', email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  if (balance > 0n) await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: balance, reference: null, note: '测试充值' });
  return { orgId, userId, context: { orgId, userId, role: 'owner' } };
}

async function newProject(member: Member): Promise<string> {
  return (await superuser.insertInto('projects')
    .values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

async function fillQuota(member: Member): Promise<string[]> {
  const ids: string[] = [];
  for (let left = QUOTA; left > 0; left -= DOCUMENT_MAX_BYTES) {
    const row = await superuser.insertInto('files').values({
      org_id: member.orgId, purpose: 'tender', display_name: 'filler.pdf', extension: 'pdf', status: 'uploaded', mime: 'application/pdf',
      size_bytes: Math.min(left, DOCUMENT_MAX_BYTES), sha256: Buffer.alloc(32), created_by: member.userId, uploaded_at: new Date(),
    }).returning('id').executeTakeFirstOrThrow();
    ids.push(row.id);
  }
  return ids;
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
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'agent-exec-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
  appDb = connect<Database>(testDb.appConfig, 8);
  redis = rawRedis();
  prefix = uniquePrefix();
});

beforeEach(() => {
  store = createMemoryStore();
  fake = fakeDriver();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await wipeQueueKeys(redis, prefix);
});

afterAll(async () => {
  redis?.disconnect();
  await appDb?.destroy();
  await testDb?.drop();
});

type Step = (run: AgentRun, context: JobContext<Record<string, never>>) => Promise<void>;
let steps: Step[] = [];
/** 续用类测试任务（test-agent-continue）首次执行时接着的现场：按 continuation 查找（8.7b）。 */
const CONTINUE_TYPES = ['test-agent-keep', 'test-agent-continue'];
let continueLookup: ((context: JobContext<Record<string, never>>) => Promise<AgentRunState | undefined>) | null = null;
/** 失败后重试（8.10b2）：open 时给出的 retainStages（undefined 时不给出）。 */
let retainStages: boolean | undefined;
let executions = 0;
const seenAgent: boolean[] = [];

function agentType(type: string, extra: Partial<JobTypeDefinition<Record<string, never>>> = {}): JobTypeDefinition<Record<string, never>> {
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
      seenAgent.push(context.agent !== null);
      const step = steps[executions];
      executions += 1;
      if (!step) return;
      const continueFrom = continueLookup && type === 'test-agent-continue' && !context.agent?.resuming ? await continueLookup(context) : undefined;
      const openOptions = { ...(continueFrom ? { continueFrom } : {}), ...(retainStages !== undefined ? { retainStages } : {}) };
      await withAgentRun(context.agent, (run) => step(run, context), Object.keys(openOptions).length ? openOptions : undefined);
    },
    ...extra,
  };
}

const registry = createJobTypeRegistry([
  agentType('test-agent-exec'),
  agentType('test-agent-content', { agentSandboxTemplate: 'agent-content' }),
  (({ agentWorkspace: _omitted, ...rest }) => rest)(agentType('test-agent-no-workspace')),
  agentType('test-agent-keep', { agentWorkspace: { taskKind: KIND, keepAfterSuccess: true } }),
  agentType('test-agent-continue', { agentWorkspace: { taskKind: KIND, keepAfterSuccess: true } }),
  agentType('test-agent-other', { agentWorkspace: { taskKind: KIND, keepAfterSuccess: true } }),
  agentType('test-agent-long', { agentTools: ['ask-user', 'report-failure', LONG_TOOL] }),
]);

beforeEach(() => {
  steps = [];
  executions = 0;
  seenAgent.length = 0;
  continueLookup = null;
  retainStages = undefined;
});

async function startRunner() {
  const logs = testLogger();
  const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-agent-exec-dispatch'), prefix });
  dispatchers.push(dispatcher);
  const runner = createJobRunner({
    db: appDb,
    registry,
    dispatcher,
    connection: bullmqConnection(redisConfig(), 'worker', 'test-agent-exec-worker'),
    log: logs.log,
    prefix,
    leaseMs: 8_000,
    reconcileIntervalMs: 600_000,
    concurrency: { agent: 2 },
    objectStore: store,
    sandbox: fake.driver,
    agentQuota: { orgAgentRunningLimit: 10 },
    agentModel: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    agentSandboxCreateDelaysMs: [],
  });
  runners.push(runner);
  await runner.start();
  return { dispatcher, logs };
}

async function jobRow(jobId: string) {
  return superuser.selectFrom('jobs').select(['status', 'pause_reason', 'error_code', 'error_message', 'checkpoint', 'attempt']).where('id', '=', jobId).executeTakeFirstOrThrow();
}

async function waitStatus(jobId: string, status: string, what: string) {
  return waitFor(async () => {
    const row = await jobRow(jobId);
    return row.status === status ? row : null;
  }, 15_000, what);
}

async function enqueue(member: Member, dispatcher: JobDispatcher, type = 'test-agent-exec', project?: string) {
  const projectId = project ?? (await newProject(member));
  const job = await enqueueJob({ db: appDb, registry, dispatcher, log: testLogger().log, agentQuota: { orgAgentRunningLimit: 10 } }, member.context, { type, params: {}, projectId });
  return { job, projectId };
}

async function tokensOf(jobId: string) {
  return superuser.selectFrom('agent_job_tokens').select(['run_id', 'revoked_at', 'token_hash']).where('job_id', '=', jobId).execute();
}

const PROMPT = { stage: 'outline', prompt: '生成目录', tools: TOOLS } as const;

describe('首次执行', () => {
  it('按登记的模板建沙箱，令牌只经标准输入且执行中有效，提示词前写下阶段，会话延续；结束后沙箱销毁、令牌作废', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    let sandboxSeen: SandboxRef | null = null;
    steps = [async (run) => {
      sandboxSeen = run.sandbox;
      expect(run.resumed).toBe(false);
      expect(run.session).toBeNull();
      expect(run.wasPrompted('outline')).toBe(false);
      const first = await run.prompt({ ...PROMPT, stageIndex: 1 });
      expect(first).toEqual({ turns: 1, stopReason: 'stop', restored: [] });
      expect(run.session).toMatch(/\.jsonl$/);
      expect(run.wasPrompted('outline')).toBe(true);
      await run.prompt({ stage: 'review', prompt: '检查目录', tools: ['read', 'ask-user'] });
      expect(run.stage).toBe('review');
      expect(run.stageIndex).toBe(1);
    }];
    const { job } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(seenAgent).toEqual([true]);
    expect(fake.state.created).toEqual([{ id: sandboxSeen!.id, template: 'agent', jobId: job.id }]);
    expect(fake.state.execArgs).toEqual([{ command: 'run', args: [] }, { command: 'run', args: [] }]);
    const [first, second] = fake.state.calls;
    expect(first!.tokenValid).toBe(true);
    expect(first!.scope).toEqual(['ask-user', 'report-failure']);
    expect(first!.request).toMatchObject({ action: 'prompt', prompt: '生成目录', session: null, maxTurns: 1_000, model: { contextWindow: 128_000, maxOutputTokens: 8_192 } });
    expect(second!.scope).toEqual(['ask-user']);
    expect(second!.request.session).toBe(run_session(first!));
    expect(fake.state.destroyed).toEqual([sandboxSeen!.id]);
    const tokens = await tokensOf(job.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.revoked_at).not.toBeNull();
  });

  it('agent-content 模板：沙箱与令牌有效期按 2 小时的墙钟', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    steps = [async (run) => {
      await run.prompt(PROMPT);
    }];
    const { job } = await enqueue(member, dispatcher, 'test-agent-content');
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(fake.state.created.map((entry) => entry.template)).toEqual(['agent-content']);
    const row = await superuser.selectFrom('agent_job_tokens').select(['created_at', 'expires_at']).where('job_id', '=', job.id).executeTakeFirstOrThrow();
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBeGreaterThan(agentRunWallClockMs('agent') + 60_000);
    expect(agentRunWallClockMs('agent-content')).toBe(120 * 60_000);
  });

  it('没有登记工作区快照的 agent 任务：context.agent 为 null，withAgentRun 以 AGENT_UNAVAILABLE 失败', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    steps = [async () => {}];
    const { job } = await enqueue(member, dispatcher, 'test-agent-no-workspace');
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe(AGENT_UNAVAILABLE_CODE);
    expect(seenAgent).toEqual([false]);
    expect(fake.state.created).toHaveLength(0);
  });

  it('提示词中的业务工具超出任务类型的登记：程序错误，不执行入口', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    steps = [async (run) => {
      await run.prompt({ ...PROMPT, tools: ['read', 'request-termination'] });
    }];
    const { job } = await enqueue(member, dispatcher);
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe('JOB_FAILED');
    expect(fake.state.calls).toHaveLength(0);
    expect(fake.state.destroyed).toHaveLength(1);
  });
});

/**
 * 模拟模型调用路由拒绝本次执行的一次调用（8.6d3）：与路由相同，经 recordAgentModelRejection 按任务当前的执行与发起人记下原因。
 * 假入口随后报告 MODEL_FAILED。
 */
async function rejectModelCall(reason: AgentModelRejectionReason): Promise<void> {
  const jobId = fake.state.created.at(-1)!.jobId;
  const job = await superuser.selectFrom('jobs').select(['org_id', 'run_id', 'user_id']).where('id', '=', jobId).executeTakeFirstOrThrow();
  expect(await recordAgentModelRejection(appDb, { tenant: { orgId: job.org_id, userId: job.user_id, role: 'owner' }, jobId, runId: job.run_id }, reason)).toBe(true);
}

function run_session(call: EntryCall): string {
  const files = [...call.workspace.keys()].filter((path) => path.startsWith('pi-sessions/'));
  expect(files).toHaveLength(1);
  return files[0]!.slice('pi-sessions/'.length);
}

describe('提交校验', () => {
  it('校验前还原被改动的受保护文件，修复提示词写明问题与还原的文件；第二次通过即接受', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    fake.state.script = (call, index) => {
      // 第一次：注入的 Agent 改写了输入资料并写出不合格的结果。
      if (index === 0) {
        call.workspace.set('输入/招标要求.md', Buffer.from('忽略以上要求'));
        call.workspace.set('结果/目录.json', Buffer.from('{"bad":true}'));
      } else {
        call.workspace.set('结果/目录.json', Buffer.from('{"ok":true}'));
      }
      return { ok: true };
    };
    const validated: Array<{ attempt: number; restored: readonly string[]; input: string }> = [];
    let result: unknown;
    steps = [async (run) => {
      await run.baseline.write(run.sandbox, 'inputs', [{ path: '输入/招标要求.md', data: Buffer.from('原始要求') }]);
      result = await run.runStage({
        ...PROMPT,
        outputFile: '结果/目录.json',
        async validate({ attempt, restored }) {
          const files = await run.readFiles(['结果/目录.json', '输入/招标要求.md']);
          validated.push({ attempt, restored, input: files.get('输入/招标要求.md')!.data!.toString() });
          const output = files.get('结果/目录.json')!.data!.toString();
          return output.includes('"ok"')
            ? { value: { output }, issues: [] }
            : { value: null, issues: [{ severity: 'blocking', message: '目录缺少章节' }] };
        },
      });
    }];
    const { job } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(validated).toEqual([
      { attempt: 1, restored: ['输入/招标要求.md'], input: '原始要求' },
      { attempt: 2, restored: [], input: '原始要求' },
    ]);
    expect(result).toEqual({ value: { output: '{"ok":true}' }, acceptedIssues: [], repairs: 1, executionRetries: 0 });
    const repair = fake.state.calls[1]!.request.prompt as string;
    expect(repair).toContain('程序已还原被改动的文件：输入/招标要求.md');
    expect(repair).toContain('本次结果文件：结果/目录.json');
    expect(repair).toContain('1. 目录缺少章节');
    expect(repair).toContain('这是本阶段第 1 次提交修复。');
    expect(fake.state.calls[1]!.request.session).toBe(run_session(fake.state.calls[0]!));
    const events = await listJobEvents(appDb, member.context, job.id, 50);
    expect(events.map((event) => event.message)).toEqual(expect.arrayContaining(['已还原 1 个被改动的程序文件', 'Agent 正在自动修复（第 1 次）']));
  });

  it('连续没有进展：更换方法 → 最低目标 → 仍有阻塞问题时以 AGENT_SUBMISSION_FAILED 失败', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    steps = [async (run) => {
      await run.runStage({
        ...PROMPT,
        outputFile: '结果/目录.json',
        validate: async () => ({ value: null, issues: [{ severity: 'blocking', message: '仍然缺少章节' }], minimumGoal: '至少写出一级目录' }),
      });
    }];
    const { job } = await enqueue(member, dispatcher);
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe(AGENT_SUBMISSION_FAILED_CODE);
    expect(row.error_message).toContain('仍然缺少章节');
    const prompts = fake.state.calls.map((call) => call.request.prompt as string);
    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain('保留已完成成果');
    expect(prompts[2]).toContain('更换具体处理方法');
    expect(prompts[3]).toContain('最低完成目标：至少写出一级目录');
  });
});

describe('失败按数据库中的事实判断', () => {
  async function runFailing(script: EntryScript, options: { balance?: bigint; step?: Step } = {}) {
    const { dispatcher } = await startRunner();
    const member = await newMember(options.balance ?? 10_000_000n);
    fake.state.script = script;
    steps = [options.step ?? (async (run) => {
      await run.prompt(PROMPT);
    })];
    const { job } = await enqueue(member, dispatcher);
    return { job, member };
  }

  it('Agent 报告了失败（数据库中有报告）：任务以 AGENT_REPORTED_FAILURE 失败，原因取报告', async () => {
    const { job } = await runFailing(async () => {
      const jobId = fake.state.created[0]!.jobId;
      const current = await superuser.selectFrom('jobs').select(['org_id', 'run_id']).where('id', '=', jobId).executeTakeFirstOrThrow();
      await superuser.insertInto('agent_failure_reports').values({ org_id: current.org_id, job_id: jobId, run_id: current.run_id, reason: '资料不足，无法继续' }).execute();
      return { ok: false, code: 'REPORTED_FAILURE' };
    });
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row).toMatchObject({ error_code: 'AGENT_REPORTED_FAILURE', error_message: '资料不足，无法继续' });
  });

  it('入口自称报告了失败、数据库中没有报告：不采信，按入口失败结束；入口的说明不进失败说明', async () => {
    const { job } = await runFailing(() => ({ ok: false, code: 'REPORTED_FAILURE' }));
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe(AGENT_ENTRY_FAILED_CODE);
    expect(row.error_message).not.toContain(SECRET_TEXT);
    expect(fake.state.destroyed).toHaveLength(1);
  });

  it('达到任务的费用上限：暂停为 task_cost_limit', async () => {
    const { job } = await runFailing(async () => {
      await superuser.updateTable('agent_job_budgets').set({ exhausted_reason: 'task_cost_limit' }).where('job_id', '=', fake.state.created[0]!.jobId).execute();
      return { ok: false, code: 'MODEL_FAILED' };
    });
    const row = await waitStatus(job.id, 'paused', '任务暂停');
    expect(row.pause_reason).toBe('task_cost_limit');
  });

  it('模型调用失败、路由记下余额不足（8.6d3）：暂停为 insufficient_balance', async () => {
    const { job } = await runFailing(async () => {
      await rejectModelCall('insufficient_balance');
      return { ok: false, code: 'MODEL_FAILED' };
    }, { balance: 0n });
    const row = await waitStatus(job.id, 'paused', '任务暂停');
    expect(row.pause_reason).toBe('insufficient_balance');
    expect(fake.state.calls).toHaveLength(1);
  });

  it('可用余额 ≥ 1 元但不够一次冻结（8.6d3，#96 确认）：暂停为 insufficient_balance 而不是重试后失败；充值后继续，从 checkpoint 续跑', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember(15_000n);
    let resumed: { resumed: boolean; task: unknown } | null = null;
    fake.state.script = () => ({ ok: true });
    steps = [
      async (run) => {
        await run.prompt(PROMPT);
        await run.checkpoint({ step: 1 });
        fake.state.script = async () => {
          await rejectModelCall('insufficient_balance');
          return { ok: false, code: 'MODEL_FAILED' };
        };
        await run.runStage({ ...PROMPT, outputFile: '结果/目录.json', maxExecutionRetries: 3, validate: async () => ({ value: null, issues: [] }) });
      },
      async (run) => {
        resumed = { resumed: run.resumed, task: run.taskCheckpoint };
        await run.prompt({ ...PROMPT, prompt: '继续之前的任务' });
      },
    ];
    const { job } = await enqueue(member, dispatcher);
    const paused = await waitStatus(job.id, 'paused', '任务暂停');
    expect(paused.pause_reason).toBe('insufficient_balance');
    expect(paused.checkpoint).toMatchObject({ task: { step: 1 } });
    // 不重试：第一条提示词与被拒绝的一条。
    expect(fake.state.calls).toHaveLength(2);

    fake.state.script = () => ({ ok: true });
    await creditOrganization(appDb, ctxAdmin, { orgId: member.orgId, type: 'recharge', amount: 10_000_000n, reference: null, note: '测试充值' });
    expect((await requestResume(appDb, member.context, job.id)).dispatch).toBe(true);
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-agent-exec', queue: 'agent' });
    await waitStatus(job.id, 'succeeded', '续跑后成功');
    expect(resumed).toEqual({ resumed: true, task: { step: 1 } });
    expect(fake.state.calls.at(-1)!.request.prompt).toBe('继续之前的任务');
  });

  it('只采信本条提示词中的拒绝（8.6d3）：之前的提示词中记下的余额不足不影响之后的模型失败（按重试处理）', async () => {
    const { job } = await runFailing(async (_call, index) => {
      // 第一条提示词成功，但其间路由拒绝过一次（例如沙箱内遗留进程的调用）。
      if (index === 0) {
        await rejectModelCall('insufficient_balance');
        return { ok: true };
      }
      return index === 1 ? { ok: false, code: 'MODEL_FAILED' } : { ok: true };
    }, {
      step: async (run) => {
        await run.prompt(PROMPT);
        const result = await run.runStage({ ...PROMPT, outputFile: '结果/目录.json', validate: async () => ({ value: 1, issues: [] }) });
        expect(result).toMatchObject({ value: 1, executionRetries: 1 });
      },
    });
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(fake.state.calls).toHaveLength(3);
  });

  it('旧执行记下的拒绝不影响续跑后的新执行（8.6d3）', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    steps = [
      async (run, context) => {
        await run.prompt(PROMPT);
        await rejectModelCall('model_unavailable');
        await run.checkpoint({ step: 1 });
        await requestPause(appDb, member.context, context.jobId);
        fake.state.script = () => ({ ok: false, code: 'RUN_ENDED' });
        await run.prompt(PROMPT);
      },
      async (run) => {
        // 新执行的第一条提示词模型调用失败（没有记下拒绝）：按重试处理，不采信旧执行的 model_unavailable。
        fake.state.script = () => (retried ? { ok: true } : ((retried = true), { ok: false, code: 'MODEL_FAILED' }));
        const result = await run.runStage({ ...PROMPT, outputFile: '结果/目录.json', validate: async () => ({ value: 1, issues: [] }) });
        expect(result).toMatchObject({ value: 1, executionRetries: 1 });
      },
    ];
    let retried = false;
    fake.state.script = () => ({ ok: true });
    const { job } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'paused', '任务暂停');
    await requestResume(appDb, member.context, job.id);
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-agent-exec', queue: 'agent' });
    await waitStatus(job.id, 'succeeded', '续跑后成功');
    expect(retried).toBe(true);
  });

  it('路由记下组织没有选择模型 / 所选模型不可用（8.6d3，#98 确认）：与余额不足一致暂停、写明原因、不重试；在设置中选择可用模型后继续，从 checkpoint 续跑', async () => {
    const cases: Array<[AgentModelRejectionReason, string]> = [
      ['model_not_configured', '尚未选择文本模型，任务已暂停，请在设置中选择模型后继续'],
      ['model_unavailable', '所选模型暂时不能使用（未登记、已停用、未定价或服务未配置），任务已暂停，请在设置中选择可用的模型后继续'],
    ];
    for (const [reason, message] of cases) {
      const { dispatcher } = await startRunner();
      const member = await newMember();
      fake.state.calls.length = 0;
      executions = 0;
      let resumed: { resumed: boolean; task: unknown } | null = null;
      fake.state.script = () => ({ ok: true });
      steps = [
        async (run) => {
          await run.prompt(PROMPT);
          await run.checkpoint({ step: 1 });
          fake.state.script = async () => {
            await rejectModelCall(reason);
            return { ok: false, code: 'MODEL_FAILED' };
          };
          await run.runStage({ ...PROMPT, outputFile: '结果/目录.json', maxExecutionRetries: 3, validate: async () => ({ value: null, issues: [] }) });
        },
        async (run) => {
          resumed = { resumed: run.resumed, task: run.taskCheckpoint };
          await run.prompt({ ...PROMPT, prompt: '继续之前的任务' });
        },
      ];
      const { job } = await enqueue(member, dispatcher);
      const paused = await waitStatus(job.id, 'paused', '任务暂停');
      expect(paused).toMatchObject({ pause_reason: reason, error_code: null, checkpoint: { task: { step: 1 } } });
      // 不重试：第一条提示词与被拒绝的一条。
      expect(fake.state.calls).toHaveLength(2);
      const event = (await listJobEvents(appDb, member.context, job.id, 100)).find((item) => item.kind === 'paused');
      expect(event?.message).toBe(message);
      expect(event?.message).not.toContain(SECRET_TEXT);

      // 用户或管理员在设置中选择可用的模型后经普通的“继续”续跑（模型调用不再被拒绝）。
      fake.state.script = () => ({ ok: true });
      expect((await requestResume(appDb, member.context, job.id)).dispatch).toBe(true);
      await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-agent-exec', queue: 'agent' });
      await waitStatus(job.id, 'succeeded', '续跑后成功');
      expect(resumed).toEqual({ resumed: true, task: { step: 1 } });
      expect(fake.state.calls.at(-1)!.request.prompt).toBe('继续之前的任务');
    }
  });

  it('压缩时路由记下所选模型不可用（8.6d3）：可选压缩也暂停为 model_unavailable，不按原上下文继续', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    fake.state.script = () => ({ ok: true });
    steps = [async (run) => {
      await run.prompt(PROMPT);
      fake.state.script = async (call) => {
        if (call.request.action !== 'compact') return { ok: true };
        await rejectModelCall('model_unavailable');
        return { ok: false, code: 'MODEL_FAILED' };
      };
      await run.compact({ stage: 'content', instructions: '请总结，供下一阶段继续使用。', optional: true });
      await run.prompt({ stage: 'content', prompt: '不应发出', tools: ['read'] });
    }];
    const { job } = await enqueue(member, dispatcher);
    expect((await waitStatus(job.id, 'paused', '任务暂停')).pause_reason).toBe('model_unavailable');
    expect(fake.state.calls.map((call) => call.request.action)).toEqual(['prompt', 'compact']);
  });

  it('模型调用失败、余额充足：按固定原因重试（不含入口的说明），重试用完后以 AGENT_MODEL_FAILED 失败', async () => {
    const { job } = await runFailing(() => ({ ok: false, code: 'MODEL_FAILED' }), {
      step: async (run) => {
        await run.runStage({ ...PROMPT, outputFile: '结果/目录.json', maxExecutionRetries: 2, validate: async () => ({ value: null, issues: [] }) });
      },
    });
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe(AGENT_MODEL_FAILED_CODE);
    const prompts = fake.state.calls.map((call) => call.request.prompt as string);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('上一轮执行失败：模型调用失败');
    expect(prompts[1]).toContain('这是第 1/2 次自动修复机会。');
    expect(prompts[2]).toContain('这是第 2/2 次自动修复机会。');
    expect(prompts.join('\n')).not.toContain(SECRET_TEXT);
  });

  it('模型调用失败一次后成功：阶段照常完成', async () => {
    const { job } = await runFailing((_call, index) => (index === 0 ? { ok: false, code: 'MODEL_FAILED' } : { ok: true }), {
      step: async (run) => {
        const result = await run.runStage({ ...PROMPT, outputFile: '结果/目录.json', validate: async () => ({ value: 1, issues: [] }) });
        expect(result).toMatchObject({ value: 1, executionRetries: 1, repairs: 0 });
      },
    });
    await waitStatus(job.id, 'succeeded', '任务成功');
  });

  it('令牌无效但任务仍在本次执行中：不采信，按入口失败结束（不重试）', async () => {
    const { job } = await runFailing(() => ({ ok: false, code: 'TOKEN_INVALID' }), {
      step: async (run) => {
        await run.runStage({ ...PROMPT, outputFile: '结果/目录.json', maxExecutionRetries: 3, validate: async () => ({ value: null, issues: [] }) });
      },
    });
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe(AGENT_ENTRY_FAILED_CODE);
    expect(fake.state.calls).toHaveLength(1);
  });

  it('入口执行中任务被请求暂停：按中止收尾（暂停），不按入口的代码失败', async () => {
    const { job, member } = await runFailing(async () => {
      await requestPause(appDb, member.context, fake.state.created[0]!.jobId);
      return { ok: false, code: 'RUN_ENDED' };
    });
    const row = await waitStatus(job.id, 'paused', '任务暂停');
    // 手动暂停没有原因（pause_reason 为 null），不是失败。
    expect(row).toMatchObject({ pause_reason: null, error_code: null });
  });

  it('一条提示词之内轮数用完：AGENT_PROMPT_TURN_LIMIT', async () => {
    const { job } = await runFailing(() => ({ ok: false, code: 'TURN_LIMIT' }), {
      step: async (run) => {
        await run.prompt({ ...PROMPT, maxTurns: 20 });
      },
    });
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row).toMatchObject({ error_code: AGENT_PROMPT_TURN_LIMIT_CODE, error_message: expect.stringContaining('20 轮') });
  });

  it('会话文件不可用：AGENT_SESSION_INVALID', async () => {
    const { job } = await runFailing(() => ({ ok: false, code: 'SESSION_INVALID' }));
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe(AGENT_SESSION_INVALID_CODE);
  });

  it('入口的结果不符合协议：AGENT_ENTRY_FAILED，之后不能再用这个沙箱', async () => {
    const after: unknown[] = [];
    const { job } = await runFailing(() => ({ exec: execResult(`${SECRET_TEXT}\n`) }), {
      step: async (run) => {
        await run.prompt(PROMPT).catch((error: unknown) => after.push(error));
        await run.prompt(PROMPT).catch((error: unknown) => after.push(error));
        throw after[1];
      },
    });
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe(AGENT_ENTRY_FAILED_CODE);
    expect(row.error_message).not.toContain(SECRET_TEXT);
    expect(fake.state.calls).toHaveLength(1);
    expect(after[1]).toBe(after[0]);
  });

  it('沙箱操作失败：AGENT_SANDBOX_FAILED', async () => {
    const { job } = await runFailing(() => ({ throw: new SandboxError('SANDBOX_FAILED', SECRET_TEXT) }));
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe(AGENT_SANDBOX_FAILED_CODE);
    expect(row.error_message).not.toContain(SECRET_TEXT);
  });

  it('本次执行的时限用完：AGENT_TIME_LIMIT，不再执行入口', async () => {
    const { job } = await runFailing(() => ({ ok: true }), {
      step: async (run) => {
        await run.prompt(PROMPT);
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + agentRunWallClockMs('agent') + 60_000);
        await run.prompt(PROMPT);
      },
    });
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row).toMatchObject({ error_code: AGENT_TIME_LIMIT_CODE, error_message: expect.stringContaining('30 分钟') });
    expect(fake.state.calls).toHaveLength(1);
  });
});

describe('检查点与续跑', () => {
  it('暂停后继续：放入快照、续接会话、取回原件、只发“继续”；新令牌与旧令牌不同', async () => {
    const { dispatcher, logs } = await startRunner();
    const member = await newMember();
    let resumedRun: { resumed: boolean; session: string | null; task: unknown; prompted: boolean; unavailable: readonly string[]; original: string | null } | null = null;
    let firstSession: string | null = null;
    steps = [
      async (run, context) => {
        await run.baseline.write(run.sandbox, 'inputs', [{ path: '输入/资料.md', data: Buffer.from('原件') }]);
        await run.prompt({ ...PROMPT, stageIndex: 2 });
        firstSession = run.session;
        await run.checkpoint({ step: 1 }, 40);
        await requestPause(appDb, member.context, context.jobId);
        // 暂停之后的提示词：入口报告执行已结束，按中止收尾。
        fake.state.script = () => ({ ok: false, code: 'RUN_ENDED' });
        await run.prompt({ ...PROMPT, prompt: '不应在续跑后重发' });
      },
      async (run) => {
        resumedRun = {
          resumed: run.resumed,
          session: run.session,
          task: run.taskCheckpoint,
          prompted: run.wasPrompted('outline'),
          unavailable: run.unavailableProtectedFiles,
          original: run.baseline.original('输入/资料.md')?.toString() ?? null,
        };
        expect(run.stage).toBe('outline');
        expect(run.stageIndex).toBe(2);
        await run.prompt({ ...PROMPT, prompt: run.wasPrompted('outline') ? '继续之前的任务' : '生成目录' });
      },
    ];
    const { job, projectId } = await enqueue(member, dispatcher);
    const paused = await waitStatus(job.id, 'paused', '任务暂停');
    expect(paused.checkpoint).toMatchObject({
      agent: { version: 1, session: firstSession, stage: 'outline', stageIndex: 2, promptedStage: 'outline', baseline: { version: 1, groups: { inputs: { '输入/资料.md': { size: 6 } } } } },
      task: { step: 1 },
    });
    expect(JSON.stringify(paused.checkpoint)).not.toContain('agt_');
    const pausedSnapshot = await findWorkspaceSnapshot(appDb, member.context, { projectId, taskKind: KIND });
    expect(pausedSnapshot).not.toBeNull();
    // 现场写下同时保存的快照 id（8.7b）。
    expect((paused.checkpoint as { agent: { snapshot: string } }).agent.snapshot).toBe(pausedSnapshot!.id);

    fake.state.script = () => ({ ok: true });
    expect((await requestResume(appDb, member.context, job.id)).dispatch).toBe(true);
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-agent-exec', queue: 'agent' });
    await waitFor(async () => {
      const row = await jobRow(job.id);
      if (row.status === 'failed') throw new Error(`续跑失败：${row.error_code} ${row.error_message} ${JSON.stringify(logs.entries.filter((entry) => entry.level === 'error').map((entry) => String((entry.obj as { err?: Error }).err?.stack)))}`);
      return row.status === 'succeeded';
    }, 15_000, '续跑后成功');
    expect(resumedRun).toEqual({ resumed: true, session: firstSession, task: { step: 1 }, prompted: true, unavailable: [], original: '原件' });
    const last = fake.state.calls.at(-1)!;
    expect(last.request).toMatchObject({ prompt: '继续之前的任务', session: firstSession });
    expect(last.workspace.get('输入/资料.md')?.toString()).toBe('原件');
    expect(fake.state.created).toHaveLength(2);
    expect(fake.state.destroyed).toEqual(fake.state.created.map((entry) => entry.id));
    const tokens = await tokensOf(job.id);
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens.map((token) => token.run_id)).size).toBe(2);
    expect(tokens.every((token) => token.revoked_at !== null)).toBe(true);
  });

  it('checkpoint 中有会话、快照却不在了：AGENT_WORKSPACE_RESTORE_FAILED，不从头开始', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    steps = [
      async (run, context) => {
        await run.prompt(PROMPT);
        await run.checkpoint({ step: 1 });
        await requestPause(appDb, member.context, context.jobId);
        fake.state.script = () => ({ ok: false, code: 'RUN_ENDED' });
        await run.prompt(PROMPT);
      },
      async (run) => {
        await run.prompt(PROMPT);
      },
    ];
    const { job, projectId } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'paused', '任务暂停');
    await superuser.deleteFrom('agent_workspace_snapshots').where('project_id', '=', projectId).execute();
    const calls = fake.state.calls.length;
    await requestResume(appDb, member.context, job.id);
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-agent-exec', queue: 'agent' });
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe(AGENT_WORKSPACE_RESTORE_FAILED_CODE);
    expect(fake.state.calls).toHaveLength(calls);
    expect(fake.state.destroyed).toEqual(fake.state.created.map((entry) => entry.id));
  });

  it('检查点超出存储配额：暂停为 storage_quota，沙箱销毁、令牌作废，之后不再执行入口', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    steps = [async (run) => {
      await run.prompt(PROMPT);
      await fillQuota(member);
      await run.checkpoint({ step: 1 }).catch(() => {});
      await run.prompt(PROMPT);
    }];
    const { job } = await enqueue(member, dispatcher);
    const row = await waitStatus(job.id, 'paused', '任务暂停');
    expect(row.pause_reason).toBe('storage_quota');
    expect(fake.state.calls).toHaveLength(1);
    expect(fake.state.destroyed).toHaveLength(1);
    expect((await tokensOf(job.id)).every((token) => token.revoked_at !== null)).toBe(true);
  });

  it('checkpointAfterPrompt：每条提示词成功后、校验前保存检查点', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    const checkpoints: unknown[] = [];
    steps = [async (run, context) => {
      let round = 0;
      await run.runStage({
        ...PROMPT,
        outputFile: '结果/目录.json',
        checkpointAfterPrompt: () => ({ round: ++round }),
        validate: async () => {
          checkpoints.push((await jobRow(context.jobId)).checkpoint);
          return round < 2 ? { value: null, issues: [{ severity: 'quality', message: '字数不足' }], progress: 10 } : { value: null, issues: [] };
        },
      });
    }];
    const { job } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(checkpoints).toMatchObject([{ task: { round: 1 } }, { task: { round: 2 } }]);
  });
});

describe('阶段交接压缩与回复全文（8.6d2）', () => {
  const COMPACTION = { stage: 'content', instructions: '请用简体中文总结，供下一阶段「正文生成」继续使用。' } as const;

  it('压缩：请求带会话、指令与模型上限，压缩期间业务工具清空；成功与无需压缩都清除登记；还没有会话时不执行入口', async () => {
    const { dispatcher, logs } = await startRunner();
    const member = await newMember();
    const statuses: unknown[] = [];
    steps = [async (run) => {
      statuses.push(await run.compact(COMPACTION));
      await run.prompt(PROMPT);
      statuses.push(await run.compact(COMPACTION));
      statuses.push(run.compactionPending);
      fake.state.script = (call) => ({ ok: true, compacted: call.request.action !== 'compact' });
      statuses.push(await run.compact({ ...COMPACTION, optional: true }));
      statuses.push(run.compactionPending);
      await run.prompt({ stage: 'content', prompt: '生成正文', tools: ['read', 'ask-user'] });
    }];
    const { job } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(statuses).toEqual(['noop', 'compacted', null, 'noop', null]);
    const calls = fake.state.calls;
    expect(calls.map((call) => call.request.action)).toEqual(['prompt', 'compact', 'compact', 'prompt']);
    const session = calls[0]!.request.session ?? calls[1]!.request.session;
    expect(calls[1]!.request).toEqual({ version: 1, action: 'compact', session, instructions: COMPACTION.instructions, model: { contextWindow: 128_000, maxOutputTokens: 8_192 } });
    expect(calls[1]!.tokenValid).toBe(true);
    expect(calls[1]!.scope).toEqual([]);
    expect(calls[3]!.scope).toEqual(['ask-user']);
    expect(calls[3]!.request.session).toBe(session);
    const messages = logs.entries.map((entry) => entry.msg);
    expect(messages).not.toContain(SECRET_TEXT);
    const events = (await listJobEvents(appDb, member.context, job.id, 100)).map((event) => event.message);
    expect(events.filter((message) => message === 'Agent 上下文压缩完成')).toHaveLength(1);
    expect(events.filter((message) => message === '当前上下文无需压缩，继续执行下一阶段')).toHaveLength(2);
  });

  it('可选压缩失败（模型调用失败、入口内部错误）：按原上下文继续、登记保留；该阶段的要求发出后清除', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    const seen: unknown[] = [];
    steps = [async (run) => {
      await run.prompt(PROMPT);
      for (const code of ['MODEL_FAILED', 'INTERNAL', 'GATEWAY_UNAVAILABLE']) {
        fake.state.script = (call) => (call.request.action === 'compact' ? { ok: false, code } : { ok: true });
        seen.push(await run.compact({ ...COMPACTION, optional: true }));
      }
      seen.push(run.compactionPending);
      await run.prompt({ stage: 'content', prompt: '生成正文', tools: ['read'] });
      seen.push(run.compactionPending);
    }];
    const { job } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(seen).toEqual(['failed', 'failed', 'failed', { stage: 'content', instructions: COMPACTION.instructions, optional: true }, null]);
    // 可选压缩不重试：每次只执行一次入口。
    expect(fake.state.calls.map((call) => call.request.action)).toEqual(['prompt', 'compact', 'compact', 'compact', 'prompt']);
    const events = (await listJobEvents(appDb, member.context, job.id, 100)).map((event) => event.message);
    expect(events.filter((message) => message === '上下文压缩失败，按原上下文继续')).toHaveLength(3);
    expect(events.filter((message) => message === '上下文压缩未完成，正在重新压缩')).toHaveLength(2);
    expect(events.join('\n')).not.toContain(SECRET_TEXT);
  });

  it('必须的压缩失败：AGENT_COMPACTION_FAILED（说明不含入口的输出），沙箱不再使用', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    steps = [async (run) => {
      await run.prompt(PROMPT);
      fake.state.script = (call) => (call.request.action === 'compact' ? { ok: false, code: 'MODEL_FAILED' } : { ok: true });
      await run.compact(COMPACTION).catch(() => {});
      await run.prompt({ stage: 'content', prompt: '不应发出', tools: ['read'] });
    }];
    const { job } = await enqueue(member, dispatcher);
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row.error_code).toBe(AGENT_COMPACTION_FAILED_CODE);
    expect(row.error_message).not.toContain(SECRET_TEXT);
    expect(fake.state.calls.map((call) => call.request.action)).toEqual(['prompt', 'compact']);
  });

  it('压缩时达到费用上限、路由记下余额不足：按数据库中的事实暂停（可选压缩也一样，不按原上下文继续）', async () => {
    const { dispatcher } = await startRunner();
    const limited = await newMember();
    steps = [async (run) => {
      await run.prompt(PROMPT);
      fake.state.script = async (call) => {
        if (call.request.action !== 'compact') return { ok: true };
        await superuser.updateTable('agent_job_budgets').set({ exhausted_reason: 'task_cost_limit' }).where('job_id', '=', fake.state.created.at(-1)!.jobId).execute();
        return { ok: false, code: 'MODEL_FAILED' };
      };
      await run.compact({ ...COMPACTION, optional: true });
      await run.prompt({ stage: 'content', prompt: '不应发出', tools: ['read'] });
    }];
    const first = await enqueue(limited, dispatcher);
    expect((await waitStatus(first.job.id, 'paused', '任务暂停')).pause_reason).toBe('task_cost_limit');
    expect(fake.state.calls.map((call) => call.request.action)).toEqual(['prompt', 'compact']);

    const poor = await newMember(0n);
    executions = 0;
    fake.state.calls.length = 0;
    fake.state.script = () => ({ ok: true });
    steps = [async (run) => {
      await run.prompt(PROMPT);
      fake.state.script = async (call) => {
        if (call.request.action !== 'compact') return { ok: true };
        await rejectModelCall('insufficient_balance');
        return { ok: false, code: 'MODEL_FAILED' };
      };
      await run.compact({ ...COMPACTION, optional: true });
      await run.prompt({ stage: 'content', prompt: '不应发出', tools: ['read'] });
    }];
    const second = await enqueue(poor, dispatcher);
    expect((await waitStatus(second.job.id, 'paused', '任务暂停')).pause_reason).toBe('insufficient_balance');
    expect(fake.state.calls.map((call) => call.request.action)).toEqual(['prompt', 'compact']);
  });

  it('压缩中被暂停（登记后先保存检查点）：续跑时在该阶段要求发出前补做压缩，之后清除登记', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    const resumed: unknown[] = [];
    steps = [
      async (run, context) => {
        await run.prompt(PROMPT);
        fake.state.script = async (call) => {
          if (call.request.action !== 'compact') return { ok: true };
          await requestPause(appDb, member.context, context.jobId);
          return { ok: false, code: 'RUN_ENDED' };
        };
        await run.compact({ ...COMPACTION, optional: true, checkpoint: { task: { step: 'compacting' } } });
      },
      async (run) => {
        resumed.push(run.compactionPending, run.wasPrompted('content'), run.taskCheckpoint);
        await run.prompt({ stage: 'content', prompt: '生成正文', tools: ['read'] });
        resumed.push(run.compactionPending);
        // 补做只在续跑后的第一条提示词之前检查一次。
        await run.prompt({ stage: 'content', prompt: '再检查一遍', tools: ['read'] });
      },
    ];
    const { job } = await enqueue(member, dispatcher);
    const paused = await waitStatus(job.id, 'paused', '任务暂停');
    expect(paused.checkpoint).toMatchObject({
      agent: { stage: 'outline', promptedStage: 'outline', compactionPending: { stage: 'content', instructions: COMPACTION.instructions, optional: true } },
      task: { step: 'compacting' },
    });
    const before = fake.state.calls.length;
    fake.state.script = () => ({ ok: true });
    await requestResume(appDb, member.context, job.id);
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-agent-exec', queue: 'agent' });
    await waitStatus(job.id, 'succeeded', '续跑后成功');
    expect(resumed).toEqual([{ stage: 'content', instructions: COMPACTION.instructions, optional: true }, false, { step: 'compacting' }, null]);
    const after = fake.state.calls.slice(before);
    expect(after.map((call) => call.request.action)).toEqual(['compact', 'prompt', 'prompt']);
    expect(after[0]!.request.session).toBe(fake.state.calls[0]!.request.session ?? after[1]!.request.session);
  });

  it('续跑时待补压缩的阶段已发出过要求、或第一条提示词属于其他阶段：不补做', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    steps = [
      async (run, context) => {
        await run.prompt(PROMPT);
        fake.state.script = (call) => (call.request.action === 'compact' ? { ok: false, code: 'MODEL_FAILED' } : { ok: true });
        expect(await run.compact({ ...COMPACTION, stage: 'review', optional: true })).toBe('failed');
        await run.checkpoint({ step: 1 });
        await requestPause(appDb, member.context, context.jobId);
        fake.state.script = () => ({ ok: false, code: 'RUN_ENDED' });
        await run.prompt(PROMPT);
      },
      async (run) => {
        expect(run.compactionPending).toMatchObject({ stage: 'review' });
        await run.prompt({ ...PROMPT, prompt: '继续之前的任务' });
        await run.prompt({ stage: 'review', prompt: '检查目录', tools: ['read'] });
      },
    ];
    const { job } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'paused', '任务暂停');
    const before = fake.state.calls.length;
    fake.state.script = () => ({ ok: true });
    await requestResume(appDb, member.context, job.id);
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-agent-exec', queue: 'agent' });
    await waitStatus(job.id, 'succeeded', '续跑后成功');
    expect(fake.state.calls.slice(before).map((call) => call.request.action)).toEqual(['prompt', 'prompt']);
  });

  it('回复全文从会话文件取回（超过入口结果的 16 KiB）；还没有会话、会话文件被改坏或不存在时为 null；上限不合法是程序错误', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    const long = `${'目录已调整。'.repeat(4_000)}完`;
    const seen: unknown[] = [];
    steps = [async (run) => {
      seen.push(await run.assistantText());
      fake.state.script = () => ({ ok: true, text: long });
      await run.prompt(PROMPT);
      seen.push(await run.assistantText());
      seen.push(await run.assistantText({ maxChars: 6 }));
      await expect(run.assistantText({ maxChars: 0 })).rejects.toBeInstanceOf(TypeError);
      const ws = fake.state.workspaces.get(run.sandbox.id)!;
      const file = `pi-sessions/${run.session}`;
      ws.set(file, Buffer.concat([ws.get(file)!, Buffer.from('{"type":\n')]));
      seen.push(await run.assistantText());
      ws.delete(file);
      seen.push(await run.assistantText());
    }];
    const { job } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(Buffer.byteLength(long)).toBeGreaterThan(16 * 1024);
    expect(seen).toEqual([null, { text: long, truncated: false }, { text: '目录已调整。', truncated: true }, null, null]);
  });
});

describe('跨任务续用（8.7b）', () => {
  const STAGE_A = { stage: 'outline', prompt: '生成目录', tools: TOOLS } as const;
  const STAGE_B = { stage: 'outline-adjustment', prompt: '调整目录', tools: TOOLS } as const;
  const target = (projectId: string) => ({ projectId, taskKind: KIND, jobTypes: CONTINUE_TYPES });

  async function waitDone(jobId: string, status: 'succeeded' | 'failed' | 'paused', what: string) {
    return waitFor(async () => {
      const row = await jobRow(jobId);
      if (row.status !== status && ['succeeded', 'failed', 'cancelled'].includes(row.status)) throw new Error(`${what}：${row.status} ${row.error_code} ${row.error_message}`);
      return row.status === status ? row : null;
    }, 15_000, what);
  }

  /** 生成任务：写入受保护的材料，一条提示词，检查点（工作区中另有交给 Agent 的结果文件）。 */
  async function generate(member: Member, dispatcher: JobDispatcher, projectId?: string) {
    let session: string | null = null;
    steps.push(async (run) => {
      await run.baseline.write(run.sandbox, 'input', [{ path: '材料.md', data: Buffer.from('原件') }]);
      await run.prompt(STAGE_A);
      run.sandbox && fake.state.calls.at(-1)!.workspace.set('outline.json', Buffer.from('{"outline":[]}'));
      session = run.session;
      await run.checkpoint({ step: 'generated' });
    });
    const { job, projectId: project } = await enqueue(member, dispatcher, 'test-agent-keep', projectId);
    const row = await waitDone(job.id, 'succeeded', '生成成功');
    return { job, projectId: project, row, session: session as string | null };
  }

  it('接着已结束的生成任务的会话：放入快照、续接会话与受保护文件的登记，阶段清空；之后的检查点写下新的快照 id，再下一次调整接着它', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    const generated = await generate(member, dispatcher);
    const snapshot = await findWorkspaceSnapshot(appDb, member.context, { projectId: generated.projectId, taskKind: KIND });
    expect(snapshot).not.toBeNull();
    expect((generated.row.checkpoint as { agent: AgentRunState }).agent.snapshot).toBe(snapshot!.id);
    const source = await findContinuableAgentSession(appDb, member.context, target(generated.projectId));
    expect(source).toEqual({ jobId: generated.job.id, state: (generated.row.checkpoint as { agent: AgentRunState }).agent, task: { step: 'generated' } });

    continueLookup = async (context) => (await findContinuableAgentSession(appDb, member.context, target(context.projectId!)))?.state;
    let seen: Record<string, unknown> | null = null;
    steps.push(async (run) => {
      seen = {
        resumed: run.resumed,
        continued: run.continued,
        session: run.session,
        stage: run.stage,
        stageIndex: run.stageIndex,
        promptedA: run.wasPrompted('outline'),
        promptedB: run.wasPrompted('outline-adjustment'),
        task: run.taskCheckpoint,
        unavailable: run.unavailableProtectedFiles,
        original: run.baseline.original('材料.md')?.toString() ?? null,
        output: (await run.readFiles(['outline.json'])).get('outline.json')?.data?.toString() ?? null,
      };
      await run.prompt({ ...STAGE_B, prompt: run.wasPrompted('outline-adjustment') ? '继续之前的任务' : '调整目录' });
      await run.checkpoint({ step: 'adjusted' });
    });
    const { job: adjust } = await enqueue(member, dispatcher, 'test-agent-continue', generated.projectId);
    const adjusted = await waitDone(adjust.id, 'succeeded', '调整成功');
    expect(seen).toEqual({
      resumed: false,
      continued: true,
      session: generated.session,
      stage: null,
      stageIndex: 0,
      promptedA: false,
      promptedB: false,
      task: null,
      unavailable: [],
      original: '原件',
      output: '{"outline":[]}',
    });
    const last = fake.state.calls.at(-1)!;
    expect(last.request).toMatchObject({ prompt: '调整目录', session: generated.session });
    expect(last.workspace.get('材料.md')?.toString()).toBe('原件');
    const after = await findWorkspaceSnapshot(appDb, member.context, { projectId: generated.projectId, taskKind: KIND });
    expect(after!.id).not.toBe(snapshot!.id);
    expect(adjusted.checkpoint).toMatchObject({
      agent: { session: generated.session, stage: 'outline-adjustment', promptedStage: 'outline-adjustment', snapshot: after!.id, baseline: { groups: { input: { '材料.md': { size: 6 } } } } },
      task: { step: 'adjusted' },
    });
    // 生成任务的现场与当前快照不再是同一对：下一次调整接着调整任务的会话。
    expect((await findContinuableAgentSession(appDb, member.context, target(generated.projectId)))?.jobId).toBe(adjust.id);
    let second: Record<string, unknown> | null = null;
    steps.push(async (run) => {
      second = { continued: run.continued, session: run.session, promptedB: run.wasPrompted('outline-adjustment') };
      await run.prompt(STAGE_B);
    });
    const { job: again } = await enqueue(member, dispatcher, 'test-agent-continue', generated.projectId);
    await waitDone(again.id, 'succeeded', '第二次调整成功');
    // 新任务的要求照常发出（已发出的阶段不从上一个任务继承）。
    expect(second).toEqual({ continued: true, session: generated.session, promptedB: false });
    expect(fake.state.calls.at(-1)!.request).toMatchObject({ prompt: '调整目录', session: generated.session });
  });

  it('失败后重试（retainStages，8.10b2）：接着失败任务的会话，阶段、已发出的阶段与待补压缩保留，任务状态为空；不给 continueFrom 时 TypeError', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    // 失败的任务：发出阶段 A 的要求、保存检查点后失败。
    steps.push(async (run) => {
      await run.baseline.write(run.sandbox, 'input', [{ path: '材料.md', data: Buffer.from('原件') }]);
      await run.prompt(STAGE_A);
      fake.state.calls.at(-1)!.workspace.set('结果.json', Buffer.from('草稿'));
      await run.checkpoint({ step: 'failed' });
      throw new JobError('TEST_FAILED', '失败');
    });
    const { job: failedJob, projectId } = await enqueue(member, dispatcher, 'test-agent-keep');
    const failedRow = await waitDone(failedJob.id, 'failed', '失败');
    const source = await findContinuableAgentSession(appDb, member.context, target(projectId));
    expect(source).toEqual({ jobId: failedJob.id, state: (failedRow.checkpoint as { agent: AgentRunState }).agent, task: { step: 'failed' } });

    continueLookup = async () => source!.state;
    retainStages = true;
    let seen: Record<string, unknown> | null = null;
    steps.push(async (run) => {
      seen = {
        resumed: run.resumed,
        continued: run.continued,
        session: run.session,
        stage: run.stage,
        promptedA: run.wasPrompted('outline'),
        task: run.taskCheckpoint,
        output: (await run.readFiles(['结果.json'])).get('结果.json')?.data?.toString() ?? null,
      };
      await run.prompt({ ...STAGE_A, prompt: run.wasPrompted('outline') ? '继续之前的任务' : '生成目录' });
    });
    const { job: retry } = await enqueue(member, dispatcher, 'test-agent-continue', projectId);
    await waitDone(retry.id, 'succeeded', '重试成功');
    expect(seen).toEqual({ resumed: false, continued: true, session: source!.state.session, stage: 'outline', promptedA: true, task: null, output: '草稿' });
    expect(fake.state.calls.at(-1)!.request).toMatchObject({ prompt: '继续之前的任务', session: source!.state.session });

    // retainStages 不与 continueFrom 一起给出：程序错误，不建沙箱。
    continueLookup = null;
    steps.push(async (run) => {
      await run.prompt(STAGE_A);
    });
    const created = fake.state.created.length;
    const { job: bad } = await enqueue(member, dispatcher, 'test-agent-exec');
    const badRow = await waitDone(bad.id, 'failed', '程序错误');
    expect(badRow.error_code).toBe('JOB_FAILED');
    expect(fake.state.created).toHaveLength(created);
  });

  it('调整任务暂停后续跑：用自己的现场（不再接着其他会话），只发“继续”', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    const generated = await generate(member, dispatcher);
    const lookups: string[] = [];
    continueLookup = async (context) => {
      lookups.push(context.jobId);
      return (await findContinuableAgentSession(appDb, member.context, target(context.projectId!)))?.state;
    };
    let resumedState: Record<string, unknown> | null = null;
    steps.push(
      async (run, context) => {
        await run.prompt(STAGE_B);
        await run.checkpoint({ step: 1 });
        await requestPause(appDb, member.context, context.jobId);
        fake.state.script = () => ({ ok: false, code: 'RUN_ENDED' });
        await run.prompt(STAGE_B);
      },
      async (run) => {
        resumedState = { resumed: run.resumed, continued: run.continued, session: run.session, prompted: run.wasPrompted('outline-adjustment'), task: run.taskCheckpoint };
        await run.prompt({ ...STAGE_B, prompt: run.wasPrompted('outline-adjustment') ? '继续之前的任务' : '调整目录' });
      },
    );
    const { job } = await enqueue(member, dispatcher, 'test-agent-continue', generated.projectId);
    await waitDone(job.id, 'paused', '调整暂停');
    fake.state.script = () => ({ ok: true });
    await requestResume(appDb, member.context, job.id);
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-agent-continue', queue: 'agent' });
    await waitDone(job.id, 'succeeded', '续跑成功');
    expect(lookups).toEqual([job.id]);
    expect(resumedState).toEqual({ resumed: true, continued: false, session: generated.session, prompted: true, task: { step: 1 } });
    expect(fake.state.calls.at(-1)!.request).toMatchObject({ prompt: '继续之前的任务', session: generated.session });
  });

  it('查找：只采用与当前快照同一对、已结束（成功或失败）的同组任务；被取消的、其他类型的、其他组织的、快照已被替换或丢弃的不采用', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    const generated = await generate(member, dispatcher);
    const current = (await findWorkspaceSnapshot(appDb, member.context, { projectId: generated.projectId, taskKind: KIND }))!;
    const checkpoint = generated.row.checkpoint as Record<string, unknown>;
    expect((await findContinuableAgentSession(appDb, member.context, target(generated.projectId)))?.jobId).toBe(generated.job.id);
    // 同一现场写到其他状态、其他类型的任务上：都不采用（以生成任务为准）。
    const later = async (type: string, status: string, value: unknown = checkpoint) => {
      const row = await superuser.insertInto('jobs').values({
        org_id: member.orgId, project_id: generated.projectId, user_id: member.userId, type, status, params: '{}', checkpoint: JSON.stringify(value),
        created_at: new Date(Date.now() + 60_000), ...(['succeeded', 'failed', 'cancelled'].includes(status) ? { finished_at: new Date() } : {}),
        ...(status === 'failed' ? { error_code: 'JOB_FAILED', error_message: '失败' } : {}),
      }).returning('id').executeTakeFirstOrThrow();
      return row.id;
    };
    for (const [type, status] of [['test-agent-continue', 'cancelled'], ['test-agent-other', 'succeeded'], ['test-agent-continue', 'paused']] as const) {
      const id = await later(type, status);
      expect((await findContinuableAgentSession(appDb, member.context, target(generated.projectId)))?.jobId).toBe(generated.job.id);
      await superuser.deleteFrom('jobs').where('id', '=', id).execute();
    }
    // 较新的失败的同组任务：采用它。
    const failed = await later('test-agent-continue', 'failed');
    expect((await findContinuableAgentSession(appDb, member.context, target(generated.projectId)))?.jobId).toBe(failed);
    await superuser.deleteFrom('jobs').where('id', '=', failed).execute();
    // 最新的同一对的现场形状不对、没有会话：不采用（也不退回更早的任务，按没有可续用的会话处理）。
    for (const agent of [{ ...(checkpoint.agent as object), session: null }, { ...(checkpoint.agent as object), version: 9 }]) {
      const id = await later('test-agent-continue', 'succeeded', { agent });
      expect(await findContinuableAgentSession(appDb, member.context, target(generated.projectId))).toBeNull();
      await superuser.deleteFrom('jobs').where('id', '=', id).execute();
    }
    // 其他组织看不到；类型列表为空时为 null。
    const other = await newMember();
    expect(await findContinuableAgentSession(appDb, other.context, target(generated.projectId))).toBeNull();
    expect(await findContinuableAgentSession(appDb, member.context, { ...target(generated.projectId), jobTypes: [] })).toBeNull();
    // 快照被丢弃：没有可续用的会话。
    expect(await discardWorkspaceSnapshot(appDb, member.context, null, { projectId: generated.projectId, taskKind: KIND })).toBe(true);
    expect(await findContinuableAgentSession(appDb, member.context, target(generated.projectId))).toBeNull();
    // 只标为已被替换（没有对象存储），对象留给清理任务。
    expect(store.objects.has(current.storageKey)).toBe(true);
  });

  it('快照被其他任务替换后：接着旧现场、按旧现场续跑都以 AGENT_WORKSPACE_RESTORE_FAILED 失败，不执行入口', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    const generated = await generate(member, dispatcher);
    const stale = (generated.row.checkpoint as { agent: AgentRunState }).agent;
    // 另一个同类任务写下新的快照（例如被取消的任务在退出前保存了检查点）。
    steps.push(async (run) => {
      await run.prompt(STAGE_A);
      await run.checkpoint(null);
    });
    await waitDone((await enqueue(member, dispatcher, 'test-agent-other', generated.projectId)).job.id, 'succeeded', '其他任务成功');
    continueLookup = async () => stale;
    steps.push(async (run) => {
      await run.prompt(STAGE_B);
    });
    const calls = fake.state.calls.length;
    const { job } = await enqueue(member, dispatcher, 'test-agent-continue', generated.projectId);
    const row = await waitDone(job.id, 'failed', '续用失败');
    expect(row.error_code).toBe(AGENT_WORKSPACE_RESTORE_FAILED_CODE);
    expect(fake.state.calls).toHaveLength(calls);
    expect(fake.state.destroyed).toEqual(fake.state.created.map((entry) => entry.id));

    // 本任务暂停期间快照被另一个同类任务替换：续跑失败。步骤按执行顺序：暂停的任务、替换快照的任务、续跑。
    steps.push(
      async (run, context) => {
        await run.prompt(STAGE_A);
        await run.checkpoint({ step: 1 });
        await requestPause(appDb, member.context, context.jobId);
        fake.state.script = () => ({ ok: false, code: 'RUN_ENDED' });
        await run.prompt(STAGE_A);
      },
      async (run) => {
        await run.prompt(STAGE_A);
        await run.checkpoint(null);
      },
      async (run) => {
        await run.prompt(STAGE_A);
      },
    );
    const { job: paused } = await enqueue(member, dispatcher, 'test-agent-exec');
    const pausedRow = await waitDone(paused.id, 'paused', '任务暂停');
    const projectId = (await superuser.selectFrom('jobs').select('project_id').where('id', '=', paused.id).executeTakeFirstOrThrow()).project_id as string;
    fake.state.script = () => ({ ok: true });
    // 直接以另一个任务在同一项目写下新的快照（互斥键之外的情形）。
    await superuser.updateTable('jobs').set({ lock_key: null }).where('id', '=', paused.id).execute();
    const replacing = await enqueue(member, dispatcher, 'test-agent-other', projectId);
    await waitDone(replacing.job.id, 'succeeded', '替换快照');
    expect((await findWorkspaceSnapshot(appDb, member.context, { projectId, taskKind: KIND }))!.id).not.toBe((pausedRow.checkpoint as { agent: AgentRunState }).agent.snapshot);
    const before = fake.state.calls.length;
    await requestResume(appDb, member.context, paused.id);
    await dispatcher.dispatch({ id: paused.id, orgId: member.orgId, type: 'test-agent-exec', queue: 'agent' });
    const resumed = await waitDone(paused.id, 'failed', '续跑失败');
    expect(resumed.error_code).toBe(AGENT_WORKSPACE_RESTORE_FAILED_CODE);
    expect(fake.state.calls).toHaveLength(before);
  });

  it('程序错误：续跑时再给出 continueFrom、现场没有会话或快照 id 时 TypeError，不建沙箱', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    const generated = await generate(member, dispatcher);
    const state = (generated.row.checkpoint as { agent: AgentRunState }).agent;
    for (const bad of [{ ...state, snapshot: null }, { ...state, session: null }, { ...state, session: '../x' }]) {
      continueLookup = async () => bad;
      steps.push(async (run) => {
        await run.prompt(STAGE_B);
      });
      const created = fake.state.created.length;
      const { job } = await enqueue(member, dispatcher, 'test-agent-continue', generated.projectId);
      const row = await waitDone(job.id, 'failed', '程序错误');
      expect(row.error_code).toBe('JOB_FAILED');
      expect(fake.state.created).toHaveLength(created);
    }
  });
});

describe('checkpoint 的形状与登记', () => {
  const base = { version: 1, session: null, stage: null, stageIndex: 0, promptedStage: null, compactionPending: null, baseline: { version: 1, groups: {} }, snapshot: null };
  const pending = { stage: 'content', instructions: '总结已完成的阶段', optional: true };

  it('没有 agent 键时为首次执行；合法的现场原样读出；8.6d1 写下的现场（没有待补压缩）按 null 读出', () => {
    expect(parseAgentRunCheckpoint(null)).toBeNull();
    expect(parseAgentRunCheckpoint({ step: 1 })).toBeNull();
    expect(parseAgentRunCheckpoint({ agent: base, task: { a: 1 } })).toEqual({ agent: base, task: { a: 1 } });
    expect(parseAgentRunCheckpoint({ agent: base })).toEqual({ agent: base, task: null });
    expect(parseAgentRunCheckpoint({ agent: { ...base, compactionPending: pending } })).toEqual({ agent: { ...base, compactionPending: pending }, task: null });
    const { compactionPending: _omitted, snapshot: _snapshot, ...legacy } = base;
    expect(parseAgentRunCheckpoint({ agent: legacy })).toEqual({ agent: base, task: null });
    // 8.7b 之前写下的现场没有快照 id：按 null 读出。
    const withSnapshot = { ...base, snapshot: randomUUID() };
    expect(parseAgentRunCheckpoint({ agent: withSnapshot })).toEqual({ agent: withSnapshot, task: null });
  });

  it.each([
    ['agent 不是对象', { agent: [] }],
    ['版本不对', { agent: { ...base, version: 2 } }],
    ['会话文件名不合法', { agent: { ...base, session: '../../etc/passwd' } }],
    ['阶段名不合法', { agent: { ...base, stage: 'Outline Stage' } }],
    ['阶段序号为负', { agent: { ...base, stageIndex: -1 } }],
    ['阶段序号不是整数', { agent: { ...base, stageIndex: 1.5 } }],
    ['已发出的阶段不合法', { agent: { ...base, promptedStage: 3 } }],
    ['没有受保护文件的登记', { agent: { ...base, baseline: null } }],
    ['待补压缩不是对象', { agent: { ...base, compactionPending: 'content' } }],
    ['待补压缩的阶段名不合法', { agent: { ...base, compactionPending: { ...pending, stage: '../x' } } }],
    ['待补压缩的指令为空', { agent: { ...base, compactionPending: { ...pending, instructions: ' ' } } }],
    ['待补压缩的指令过长', { agent: { ...base, compactionPending: { ...pending, instructions: 'x'.repeat(16 * 1024 + 1) } } }],
    ['待补压缩的 optional 不是布尔值', { agent: { ...base, compactionPending: { ...pending, optional: 'yes' } } }],
    ['待补压缩多余字段', { agent: { ...base, compactionPending: { ...pending, session: 'x' } } }],
    ['任务状态不是对象', { agent: base, task: 'x' }],
    ['快照 id 不是 UUID', { agent: { ...base, snapshot: '../x' } }],
    ['快照 id 不是字符串', { agent: { ...base, snapshot: 1 } }],
    ['快照 id 大写', { agent: { ...base, snapshot: randomUUID().toUpperCase() } }],
  ])('不合法：%s', (_name, checkpoint) => {
    expect(() => parseAgentRunCheckpoint(checkpoint as Record<string, unknown>)).toThrow(TypeError);
  });

  it('只有 agent 队列能登记沙箱模板，模板须是 agent / agent-content', () => {
    const base = agentType('test-agent-template');
    expect(() => createJobTypeRegistry([{ ...base, agentSandboxTemplate: 'export-document' as never }])).toThrow(TypeError);
    const { agentLimits: _limits, agentTools: _tools, agentWorkspace: _ws, ...plain } = base;
    expect(() => createJobTypeRegistry([{ ...plain, queue: 'ai', agentSandboxTemplate: 'agent' }])).toThrow(TypeError);
    expect(() => createJobTypeRegistry([{ ...base, agentSandboxTemplate: 'agent-content' }])).not.toThrow();
  });
});

describe('长时业务工具（8.10c2b1）', () => {
  /** 模拟沙箱内的桩经内部入口调用长时工具：登记请求并等待，直到执行者写下结果（与 createAgentLongTool 的等待相同）。 */
  async function callLongTool(call: EntryCall, args: Record<string, unknown>): Promise<AgentToolRequestResult> {
    const identity = await lookupAgentJobToken(appDb, call.request.token ?? tokenOfCall(call));
    expect(identity).not.toBeNull();
    const tenant = agentTenantContext(identity!);
    const ref = { tenant, jobId: identity!.jobId, runId: identity!.runId };
    let state = await withTenant(appDb, tenant, (trx) => openAgentToolRequest(trx, ref, LONG_TOOL, args));
    for (let index = 0; index < 300 && state.kind === 'pending'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const requestId = state.requestId;
      state = await withTenant(appDb, tenant, (trx) => pollAgentToolRequest(trx, ref, requestId));
    }
    expect(state.kind).toBe('finished');
    return (state as { result: AgentToolRequestResult }).result;
  }
  const tokens = new Map<string, string>();
  function tokenOfCall(call: EntryCall): string {
    return tokens.get(call.sandboxId)!;
  }

  async function startLong(script: EntryScript, step: Step) {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    fake.state.script = script;
    steps = [step];
    const { job } = await enqueue(member, dispatcher, 'test-agent-long');
    return { job, member };
  }

  beforeEach(() => {
    tokens.clear();
    // 假入口拿不到请求中的令牌（EntryCall 去掉了令牌）：exec 时记下。
    const exec = fake.driver.exec.bind(fake.driver);
    fake.driver.exec = async (sandbox, command, args, options = {}) => {
      const input = JSON.parse(options.input!.toString('utf8')) as Record<string, any>;
      tokens.set(sandbox.id, input.token);
      return exec(sandbox, command, args, options);
    };
  });

  it('本条提示词执行期间执行者执行请求、写回工作区，结果交给 Agent；拒绝的说明交给 Agent、本条提示词继续', async () => {
    const results: AgentToolRequestResult[] = [];
    const seen: unknown[] = [];
    const { job } = await startLong(async (call, index) => {
      if (index > 0) return { ok: true };
      results.push(await callLongTool(call, { items: ['1.1'] }));
      results.push(await callLongTool(call, { items: ['bad'] }));
      expect(call.workspace.get('正文/1.1.html')?.toString('utf8')).toBe('<p>第一节</p>');
      return { ok: true };
    }, async (run) => {
      const outcome = await run.prompt({
        ...PROMPT,
        longTools: {
          [LONG_TOOL]: async ({ args, signal }) => {
            expect(signal.aborted).toBe(false);
            seen.push(args);
            const items = args.items as string[];
            if (items[0] === 'bad') throw new AgentToolRequestRejection('任务文件中的小节不是本次的目标');
            await run.writeFiles([{ path: '正文/1.1.html', data: Buffer.from('<p>第一节</p>') }]);
            return { generated: items };
          },
        },
      });
      expect(outcome.stopReason).toBe('stop');
      // 提示词结束后不再执行（没有登记执行函数的提示词照常执行）。
      await run.prompt(PROMPT);
    });
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(seen).toEqual([{ items: ['1.1'] }, { items: ['bad'] }]);
    expect(results).toEqual([
      { outcome: 'succeeded', result: { generated: ['1.1'] } },
      { outcome: 'rejected', message: '任务文件中的小节不是本次的目标' },
    ]);
    const rows = await superuser.selectFrom('agent_tool_requests').select(['status', 'outcome']).where('job_id', '=', job.id).orderBy('created_at').execute();
    expect(rows).toEqual([
      { status: 'consumed', outcome: 'succeeded' },
      { status: 'consumed', outcome: 'rejected' },
    ]);
  });

  it('执行函数的其他错误：中止入口，任务按该错误结束；Agent 只得到固定说明', async () => {
    const results: AgentToolRequestResult[] = [];
    const { job } = await startLong(async (call) => {
      results.push(await callLongTool(call, { items: ['1.1'] }));
      // 真实的入口随 exec 中止而结束。
      return { throw: new SandboxError('SANDBOX_UNAVAILABLE', '已中止') };
    }, async (run) => {
      await run.prompt({
        ...PROMPT,
        longTools: {
          [LONG_TOOL]: async () => {
            throw new JobError('TEST_SECTIONS_FAILED', '连续多个小节生成失败，任务已停止');
          },
        },
      });
    });
    const row = await waitStatus(job.id, 'failed', '任务失败');
    expect(row).toMatchObject({ error_code: 'TEST_SECTIONS_FAILED', error_message: '连续多个小节生成失败，任务已停止' });
    expect(results).toEqual([{ outcome: 'failed' }]);
    expect(fake.state.destroyed).toHaveLength(1);
  });

  it('程序错误：长时工具不是任务类型登记的业务工具、执行函数不是函数；writeFiles 的路径、重复与受保护文件', async () => {
    const errors: string[] = [];
    const { job } = await startLong(async () => ({ ok: true }), async (run) => {
      const expectTypeError = async (promise: Promise<unknown>) => {
        const error = await promise.then(() => null, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(TypeError);
        errors.push((error as Error).message);
      };
      await expectTypeError(run.prompt({ ...PROMPT, longTools: { 'not-registered': async () => 1 } }));
      await expectTypeError(run.prompt({ ...PROMPT, longTools: { [LONG_TOOL]: 'x' as never } }));
      await run.baseline.write(run.sandbox, 'inputs', [{ path: '输入/材料.md', data: Buffer.from('原件') }]);
      await expectTypeError(run.writeFiles([{ path: '输入/材料.md', data: Buffer.from('改动') }]));
      await expectTypeError(run.writeFiles([{ path: '../逃逸.html', data: Buffer.from('x') }]));
      await expectTypeError(run.writeFiles([{ path: '正文/a.html', data: Buffer.from('1') }, { path: '正文/a.html', data: Buffer.from('2') }]));
      await expectTypeError(run.writeFiles([{ path: '正文/a.html', data: 'x' as never }]));
      // 对照组：写入成功、替换同名文件。
      await run.writeFiles([{ path: '正文/a.html', data: Buffer.from('1') }]);
      await run.writeFiles([{ path: '正文/a.html', data: Buffer.from('2') }]);
      expect((await run.readFiles(['正文/a.html'])).get('正文/a.html')?.data?.toString('utf8')).toBe('2');
    });
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(errors).toHaveLength(6);
    expect(fake.state.calls).toHaveLength(0);
  });
});

