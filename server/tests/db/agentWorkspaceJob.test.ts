// Agent 工作区快照接入续跑（src/agent/workspaceJob.ts、迁移 0041_job_pause_storage_quota、执行者 src/jobs/runner.ts，路线图第 8 步 8.5c）
// 对真实数据库（与 Redis，执行者端到端）的测试：
// 1. 检查点：先保存快照、再保存 checkpoint；超出组织存储配额抛 JobStorageQuotaError、checkpoint 不前进、旧快照保留，之后的检查点
//    不再取回；工作区不符合规则时 AGENT_WORKSPACE_REJECTED（说明写类别、不含文件名，不改名、不跳过），过大时 AGENT_WORKSPACE_TOO_LARGE；
// 2. 恢复：没有快照返回 null、不碰沙箱；有快照时放入的字节与保存的相同；快照被篡改时沙箱被销毁、快照被丢弃，AGENT_WORKSPACE_RESTORE_FAILED；
// 3. 重置：discardAgentWorkspaceSnapshots 只丢弃给出的类别，其他项目、其他类别、其他组织不受影响；
// 4. 登记：只有 agent 队列能登记，类别须符合 0040 的规则；
// 5. 执行者端到端：成功后丢弃快照（keepAfterSuccess 保留）；超出配额暂停为 storage_quota（任务吞掉错误也暂停），删除文件后普通的“继续”
//    从上一个检查点续跑；等待用户确认选择时暂停为 waiting_for_selection（8.7e1），确认后续跑；暂停后继续时恢复上次的工作区；恢复失败、工作区被拒绝时任务失败；没有对象存储或 driver 不能整体取回时为 null；
// 6. 回滚 0041：storage_quota 暂停的任务按手动暂停处理。
// 沙箱用内存桩（取回经与真实 driver 相同的 toOutputArchive，放入按模板的输入规则校验），对象存储用内存实现。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS } from '../../src/agent/budget.ts';
import type { WorkspaceSandboxDriver } from '../../src/agent/workspaceSandbox.ts';
import {
  AGENT_WORKSPACE_REJECTED_CODE,
  AGENT_WORKSPACE_RESTORE_FAILED_CODE,
  AGENT_WORKSPACE_TOO_LARGE_CODE,
  agentWorkspaceRejectedMessage,
  agentWorkspaceRejectionCategory,
  createJobAgentWorkspace,
  discardAgentWorkspaceSnapshots,
  isWorkspaceSandboxDriver,
} from '../../src/agent/workspaceJob.ts';
import { findWorkspaceSnapshot } from '../../src/agent/workspaceSnapshots.ts';
import { migrateDown, migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import {
  createJobTypeRegistry,
  JobError,
  JobSelectionRequiredError,
  JobStorageQuotaError,
  type JobContext,
  type JobTypeDefinition,
} from '../../src/jobs/definitions.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../src/jobs/runner.ts';
import { enqueueJob } from '../../src/jobs/service.ts';
import { confirmJobSelection, listJobEvents, requestPause, requestResume } from '../../src/jobs/store.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { readArchive, SandboxArchiveError, validateArchiveStream } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxRef } from '../../src/sandbox/driver.ts';
import { toOutputArchive } from '../../src/sandbox/outputArchive.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { END_OF_ARCHIVE, tarEntry } from '../sandbox/tarFixtures.ts';
import { rawRedis, redisConfig, testLogger, uniquePrefix, waitFor, wipeQueueKeys } from './jobFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const KIND = 'technical-plan-outline';
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;
let redis: Redis;
let prefix: string;
const runners: JobRunner[] = [];
const dispatchers: JobDispatcher[] = [];

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

/** 沙箱的内存桩：copyOutArchive 产出 output（沙箱内 GNU tar 的输出），copyInArchive 按模板的输入规则边读边校验并记下收到的字节。 */
function fakeDriver() {
  const state = {
    output: Buffer.alloc(0) as Buffer,
    received: new Map<string, Buffer>(),
    destroyed: [] as string[],
    copyOutCalls: 0,
    copyInCalls: 0,
    /** 取回时直接抛出的错误（模拟写入快照时的错误）。 */
    copyOutFailure: null as unknown,
  };
  const driver: WorkspaceSandboxDriver = {
    async create() {
      throw new Error('not used');
    },
    async copyIn() {
      throw new Error('not used');
    },
    async exec() {
      throw new Error('not used');
    },
    async copyOut() {
      throw new Error('not used');
    },
    async copyOutArchive(sandbox, options = {}) {
      state.copyOutCalls += 1;
      if (state.copyOutFailure) {
        const failure = state.copyOutFailure;
        return {
          chunks: (async function* () {
            yield Buffer.alloc(512);
            throw failure;
          })(),
          fileCount: 0,
        };
      }
      return toOutputArchive(Readable.from([state.output]), SANDBOX_TEMPLATES[sandbox.template].output, { signal: options.signal });
    },
    async copyInArchive(sandbox, archive) {
      state.copyInCalls += 1;
      const parts: Buffer[] = [];
      try {
        for await (const chunk of validateArchiveStream(Buffer.isBuffer(archive) ? Readable.from([archive]) : archive, SANDBOX_TEMPLATES[sandbox.template].input)) {
          parts.push(chunk);
        }
      } catch (error) {
        throw new SandboxError(error instanceof SandboxArchiveError ? 'SANDBOX_BAD_REQUEST' : 'SANDBOX_UNAVAILABLE', '放入失败', { cause: error });
      } finally {
        state.received.set(sandbox.id, Buffer.concat(parts));
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

beforeEach(() => {
  store = createMemoryStore();
  fake = fakeDriver();
});

function sandboxRef(jobId: string = randomUUID()): SandboxRef {
  return Object.freeze({ id: randomUUID(), template: 'agent', jobId, expiresAt: new Date(Date.now() + 3_600_000) });
}

/** 沙箱内 GNU tar 的输出：./ 目录条目、./ 前缀、结尾有记录对齐。 */
function gnuTar(files: ReadonlyArray<{ path: string; data: Buffer }>, extra: Buffer[] = []): Buffer {
  const parts: Buffer[] = [tarEntry({ name: './', type: '5', format: 'gnu' })];
  const dirs = new Set<string>();
  for (const file of files) {
    const segments = file.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const dir = segments.slice(0, index).join('/');
      if (!dirs.has(dir)) {
        dirs.add(dir);
        parts.push(tarEntry({ name: `./${dir}/`, type: '5', format: 'gnu' }));
      }
    }
    parts.push(tarEntry({ name: `./${file.path}`, data: file.data, format: 'gnu' }));
  }
  return Buffer.concat([...parts, ...extra, END_OF_ARCHIVE, Buffer.alloc(8 * 1024)]);
}

const WORKSPACE = [
  { path: '任务/大纲.json', data: Buffer.from('{"章节":[1,2,3]}') },
  { path: '底稿/第一章（初稿）.md', data: Buffer.from('# 第一章\n'.repeat(200)) },
  { path: 'pi-sessions/2026-11-15T10-00-00-000Z_0f8e.jsonl', data: Buffer.from('{"type":"session"}\n') },
];
const WORKSPACE_2 = [{ path: '任务/大纲.json', data: Buffer.from('{"章节":[1,2,3,4]}') }];

interface Member {
  orgId: string;
  userId: string;
  context: TenantContext;
}

async function newMember(): Promise<Member> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x', email_verified_at: new Date() }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, userId, context: { orgId, userId, role: 'owner' } };
}

async function newProject(member: Member): Promise<string> {
  return (await superuser.insertInto('projects')
    .values({ org_id: member.orgId, kind: 'technical-plan', name: '项目', created_by: member.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

/** 用占位文件占满组织的存储配额，返回占位文件的 id。 */
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

async function freeQuota(ids: readonly string[]): Promise<void> {
  await superuser.deleteFrom('files').where('id', 'in', [...ids]).execute();
}

async function snapshotRows(projectId: string) {
  return superuser.selectFrom('agent_workspace_snapshots').select(['id', 'task_kind', 'status', 'superseded_at']).where('project_id', '=', projectId).execute();
}

async function filesOf(archive: Buffer): Promise<Record<string, string>> {
  const files = await readArchive(Readable.from([archive]), SANDBOX_TEMPLATES.agent.input);
  return Object.fromEntries(files.map((file) => [file.path, file.data.toString('utf8')]));
}

/** 直接创建 context.agentWorkspace（不经执行者），记下 checkpoint 的保存与配额回调。 */
function workspaceFor(member: Member, projectId: string, taskKind = KIND) {
  const calls = { checkpoints: [] as Array<{ checkpoint: Record<string, unknown>; progress: number | undefined; snapshotAtSave: string | null }>, quota: 0 };
  const workspace = createJobAgentWorkspace({
    db: appDb,
    store,
    driver: fake.driver,
    tenant: member.context,
    projectId,
    taskKind,
    signal: new AbortController().signal,
    async saveCheckpoint(checkpoint, progress) {
      // 保存 checkpoint 时新快照已是当前的（先快照、后 checkpoint）。
      const current = await findWorkspaceSnapshot(appDb, member.context, { projectId, taskKind });
      calls.checkpoints.push({ checkpoint, progress, snapshotAtSave: current?.id ?? null });
    },
    onStorageQuotaExceeded() {
      calls.quota += 1;
    },
  });
  return { workspace, calls };
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
  appDb = connect<Database>(testDb.appConfig, 8);
  redis = rawRedis();
  prefix = uniquePrefix();
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await wipeQueueKeys(redis, prefix);
});

afterAll(async () => {
  redis?.disconnect();
  await appDb?.destroy();
  await testDb?.drop();
});

describe('检查点', () => {
  it('先保存快照、再保存 checkpoint；下一个检查点替换旧快照', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const { workspace, calls } = workspaceFor(member, projectId);
    expect(workspace.taskKind).toBe(KIND);
    fake.state.output = gnuTar(WORKSPACE);
    const first = await workspace.saveCheckpoint(sandboxRef(), { step: 1 }, 10);
    expect(first).toMatchObject({ projectId, taskKind: KIND, fileCount: WORKSPACE.length });
    expect(calls.checkpoints).toEqual([{ checkpoint: { step: 1 }, progress: 10, snapshotAtSave: first.id }]);

    fake.state.output = gnuTar(WORKSPACE_2);
    const second = await workspace.saveCheckpoint(sandboxRef(), { step: 2 });
    expect(calls.checkpoints.at(-1)).toEqual({ checkpoint: { step: 2 }, progress: undefined, snapshotAtSave: second.id });
    expect((await snapshotRows(projectId)).map((row) => row.id)).toEqual([second.id]);
    expect(await filesOf(store.objects.get(second.storageKey)!)).toEqual({ '任务/大纲.json': '{"章节":[1,2,3,4]}' });
    expect(calls.quota).toBe(0);
  });

  it('超出组织存储配额：JobStorageQuotaError，checkpoint 不前进，旧快照保留；之后的检查点不再取回', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const { workspace, calls } = workspaceFor(member, projectId);
    fake.state.output = gnuTar(WORKSPACE);
    const old = await workspace.saveCheckpoint(sandboxRef(), { step: 1 });
    const oldBytes = Buffer.from(store.objects.get(old.storageKey)!);

    await fillQuota(member);
    fake.state.output = gnuTar(WORKSPACE_2);
    const error = await workspace.saveCheckpoint(sandboxRef(), { step: 2 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobStorageQuotaError);
    expect((error as Error).cause).toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
    expect(calls.quota).toBe(1);
    expect(calls.checkpoints.map((call) => call.checkpoint)).toEqual([{ step: 1 }]);
    expect((await findWorkspaceSnapshot(appDb, member.context, { projectId, taskKind: KIND }))?.id).toBe(old.id);
    expect(store.objects.get(old.storageKey)!.equals(oldBytes)).toBe(true);
    expect(store.objects.size).toBe(1);

    const callsBefore = fake.state.copyOutCalls;
    await expect(workspace.saveCheckpoint(sandboxRef(), { step: 3 })).rejects.toBeInstanceOf(JobStorageQuotaError);
    expect(fake.state.copyOutCalls).toBe(callsBefore);
    expect(calls.checkpoints).toHaveLength(1);
  });

  // 每类规则各一个样本：说明写类别、不含文件名，旧快照保留，checkpoint 不前进。
  const REJECTED: ReadonlyArray<{ name: string; output: () => Buffer; category: ReturnType<typeof agentWorkspaceRejectionCategory> }> = [
    { name: '白名单外的扩展名', output: () => gnuTar([{ path: '投标模版源文件-secret9.docx', data: Buffer.from('x') }]), category: 'file-type' },
    { name: '含空格的文件名', output: () => gnuTar([{ path: '底稿/第一章 secret9.md', data: Buffer.from('x') }]), category: 'naming' },
    { name: '以 . 开头的文件', output: () => gnuTar([{ path: '.secret9.md', data: Buffer.from('x') }]), category: 'naming' },
    { name: '符号链接', output: () => gnuTar([], [tarEntry({ name: './secret9.md', type: '2', linkname: '/etc/passwd', format: 'gnu' })]), category: 'special-file' },
    { name: '硬链接', output: () => gnuTar(WORKSPACE.slice(0, 1), [tarEntry({ name: './secret9.md', type: '1', linkname: './任务/大纲.json', format: 'gnu' })]), category: 'special-file' },
    { name: 'FIFO', output: () => gnuTar([], [tarEntry({ name: './secret9.md', type: '6', format: 'gnu' })]), category: 'special-file' },
    { name: '校验和错误', output: () => gnuTar([], [tarEntry({ name: './secret9.md', data: Buffer.from('x'), badChecksum: true, format: 'gnu' })]), category: 'format' },
  ];

  for (const sample of REJECTED) {
    it(`工作区不符合规则（${sample.name}）：AGENT_WORKSPACE_REJECTED，说明只写类别，旧快照保留`, async () => {
      const member = await newMember();
      const projectId = await newProject(member);
      const { workspace, calls } = workspaceFor(member, projectId);
      fake.state.output = gnuTar(WORKSPACE);
      const old = await workspace.saveCheckpoint(sandboxRef(), { step: 1 });

      fake.state.output = sample.output();
      const error = await workspace.saveCheckpoint(sandboxRef(), { step: 2 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(JobError);
      expect(error).toMatchObject({ code: AGENT_WORKSPACE_REJECTED_CODE, message: agentWorkspaceRejectedMessage(sample.category) });
      expect((error as Error).message).not.toContain('secret9');
      expect(calls.checkpoints.map((call) => call.checkpoint)).toEqual([{ step: 1 }]);
      expect(calls.quota).toBe(0);
      expect((await snapshotRows(projectId)).map((row) => row.id)).toEqual([old.id]);
      expect(store.objects.size).toBe(1);
    });
  }

  it('工作区超过快照的大小上限：AGENT_WORKSPACE_TOO_LARGE；其他错误原样抛出', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const { workspace, calls } = workspaceFor(member, projectId);
    // 写入快照时超过上限的错误（8.5a 已测上限本身，这里只测映射，避免写 512 MiB）。
    fake.state.copyOutFailure = new AppError(413, 'AGENT_WORKSPACE_TOO_LARGE', '工作区快照超过大小上限');
    await expect(workspace.saveCheckpoint(sandboxRef(), { step: 1 })).rejects.toMatchObject({ name: 'JobError', code: AGENT_WORKSPACE_TOO_LARGE_CODE });
    const unavailable = new SandboxError('SANDBOX_FAILED', '取回失败');
    fake.state.copyOutFailure = unavailable;
    await expect(workspace.saveCheckpoint(sandboxRef(), { step: 1 })).rejects.toBe(unavailable);
    expect(calls.checkpoints).toEqual([]);
    expect(await snapshotRows(projectId)).toEqual([]);
    expect(store.objects.size).toBe(0);
  });

  it('取回被拒绝的原因归类（纯函数）', () => {
    expect(agentWorkspaceRejectionCategory('file extension not allowed')).toBe('file-type');
    for (const reason of ['symbolic link not allowed', 'hard link not allowed', 'device file not allowed', 'fifo not allowed', 'entry type not allowed']) {
      expect(agentWorkspaceRejectionCategory(reason), reason).toBe('special-file');
    }
    for (const reason of ['path segment not allowed', 'path not normalized', 'path encoding invalid', 'path conflict', 'duplicate path', 'path too deep', 'path too long', 'path traversal', 'absolute path', 'empty path', 'file path ends with a slash']) {
      expect(agentWorkspaceRejectionCategory(reason), reason).toBe('naming');
    }
    for (const reason of ['too many files', 'too many entries', 'file too large', 'archive too large']) {
      expect(agentWorkspaceRejectionCategory(reason), reason).toBe('size');
    }
    for (const reason of ['header checksum mismatch', 'archive truncated', 'malformed header', null]) {
      expect(agentWorkspaceRejectionCategory(reason), String(reason)).toBe('format');
    }
  });
});

describe('恢复', () => {
  it('没有快照时返回 null、不碰沙箱；有快照时放入的字节与保存的相同', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const { workspace } = workspaceFor(member, projectId);
    const empty = sandboxRef();
    expect(await workspace.restore(empty)).toBeNull();
    expect(fake.state.copyInCalls).toBe(0);
    expect(fake.state.destroyed).toEqual([]);

    fake.state.output = gnuTar(WORKSPACE);
    const saved = await workspace.saveCheckpoint(sandboxRef(), { step: 1 });
    const target = sandboxRef();
    expect((await workspace.restore(target))?.id).toBe(saved.id);
    expect(fake.state.received.get(target.id)!.equals(store.objects.get(saved.storageKey)!)).toBe(true);
    expect(fake.state.destroyed).toEqual([]);
  });

  it('快照被篡改：沙箱被销毁、快照被丢弃，AGENT_WORKSPACE_RESTORE_FAILED', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const { workspace } = workspaceFor(member, projectId);
    fake.state.output = gnuTar(WORKSPACE);
    const saved = await workspace.saveCheckpoint(sandboxRef(), { step: 1 });
    const bytes = store.objects.get(saved.storageKey)!;
    bytes[600] = bytes[600]! ^ 0xff;

    const target = sandboxRef();
    const error = await workspace.restore(target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: AGENT_WORKSPACE_RESTORE_FAILED_CODE });
    expect((error as Error).cause).toMatchObject({ code: 'SANDBOX_INPUT_FAILED' });
    expect(fake.state.destroyed).toEqual([target.id]);
    expect(await findWorkspaceSnapshot(appDb, member.context, { projectId, taskKind: KIND })).toBeNull();
    expect(await snapshotRows(projectId)).toEqual([]);
    expect(store.objects.size).toBe(0);
  });

  it('放入本身失败（非快照的问题）时原样抛出，快照保留', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const { workspace } = workspaceFor(member, projectId);
    fake.state.output = gnuTar(WORKSPACE);
    const saved = await workspace.saveCheckpoint(sandboxRef(), { step: 1 });
    const failure = new SandboxError('SANDBOX_UNAVAILABLE', 'sandbox-runner 不可用');
    fake.driver.copyInArchive = async () => {
      throw failure;
    };
    await expect(workspace.restore(sandboxRef())).rejects.toBe(failure);
    expect((await findWorkspaceSnapshot(appDb, member.context, { projectId, taskKind: KIND }))?.id).toBe(saved.id);
  });
});

describe('重置', () => {
  it('只丢弃给出的类别；其他项目、其他类别、其他组织不受影响', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const otherProject = await newProject(member);
    fake.state.output = gnuTar(WORKSPACE);
    for (const [project, kind] of [[projectId, KIND], [projectId, 'technical-plan-global-facts'], [projectId, 'technical-plan-content'], [otherProject, KIND]] as const) {
      await workspaceFor(member, project, kind).workspace.saveCheckpoint(sandboxRef(), {});
    }
    const stranger = await newMember();
    expect(await discardAgentWorkspaceSnapshots(appDb, stranger.context, store, projectId, [KIND])).toEqual([]);
    expect(await discardAgentWorkspaceSnapshots(appDb, member.context, store, projectId, [KIND, 'technical-plan-global-facts', KIND, 'feasibility-outline'])).toEqual([
      KIND,
      'technical-plan-global-facts',
    ]);
    expect((await snapshotRows(projectId)).map((row) => row.task_kind)).toEqual(['technical-plan-content']);
    expect((await snapshotRows(otherProject)).map((row) => row.task_kind)).toEqual([KIND]);
    expect(store.objects.size).toBe(2);
  });
});

describe('登记', () => {
  const base = { resumable: true, parseParams: () => ({}), run: async () => {} };
  const agent = { ...base, queue: 'agent' as const, agentLimits: AGENT_TASK_LIMITS.outline };

  it('只有 agent 队列能登记；类别须符合 0040 的规则；keepAfterSuccess 须是布尔值', () => {
    expect(() => createJobTypeRegistry([{ ...agent, type: 'test-ws-ok', agentWorkspace: { taskKind: KIND } }])).not.toThrow();
    expect(() => createJobTypeRegistry([{ ...agent, type: 'test-ws-keep', agentWorkspace: { taskKind: KIND, keepAfterSuccess: true } }])).not.toThrow();
    // 几个任务类型可以登记同一类别。
    expect(() => createJobTypeRegistry([
      { ...agent, type: 'test-ws-a', agentWorkspace: { taskKind: KIND } },
      { ...agent, type: 'test-ws-b', agentWorkspace: { taskKind: KIND } },
    ])).not.toThrow();
    expect(() => createJobTypeRegistry([{ ...base, type: 'test-ws-ai', queue: 'ai', agentWorkspace: { taskKind: KIND } }])).toThrow(/只有 agent 队列/);
    for (const taskKind of ['', 'Technical', 'a', 'technical_plan', '-outline', 'outline-', '技术方案', 'x'.repeat(65)]) {
      expect(() => createJobTypeRegistry([{ ...agent, type: 'test-ws-bad', agentWorkspace: { taskKind } }]), taskKind).toThrow(/工作区快照不合法/);
    }
    expect(() => createJobTypeRegistry([{ ...agent, type: 'test-ws-bad', agentWorkspace: { taskKind: KIND, keepAfterSuccess: 'yes' as never } }])).toThrow(/工作区快照不合法/);
    expect(() => createJobTypeRegistry([{ ...agent, type: 'test-ws-bad', agentWorkspace: null as never }])).toThrow(/工作区快照不合法/);
  });

  it('isWorkspaceSandboxDriver：只有能整体放入与取回归档的 driver', () => {
    expect(isWorkspaceSandboxDriver(fake.driver)).toBe(true);
    const { copyInArchive: _in, copyOutArchive: _out, ...plain } = fake.driver;
    expect(isWorkspaceSandboxDriver(plain as SandboxDriver)).toBe(false);
    expect(isWorkspaceSandboxDriver(null)).toBe(false);
  });
});

describe('执行者端到端', () => {
  type Step = (context: JobContext<Record<string, never>>) => Promise<void>;
  /** 每次执行调用 steps[第几次执行 - 1]（attempt 从 1 开始，暂停后继续也递增）；记下每次看到的 context.agentWorkspace。 */
  let steps: Step[] = [];
  const seen: Array<{ type: string; workspace: boolean; checkpoint: Record<string, unknown> | null }> = [];
  let executions = 0;

  function agentType(type: string, extra: Partial<JobTypeDefinition<Record<string, never>>> = {}): JobTypeDefinition<Record<string, never>> {
    return {
      type,
      queue: 'agent',
      resumable: true,
      maxAttempts: 10,
      agentLimits: AGENT_TASK_LIMITS.outline,
      agentWorkspace: { taskKind: KIND },
      parseParams: () => ({}),
      async run(context) {
        seen.push({ type, workspace: context.agentWorkspace !== null, checkpoint: context.checkpoint });
        const step = steps[executions];
        executions += 1;
        if (step) await step(context);
      },
      ...extra,
    };
  }

  const registry = createJobTypeRegistry([
    agentType('test-ws-job'),
    agentType('test-ws-keep', { agentWorkspace: { taskKind: KIND, keepAfterSuccess: true } }),
    (({ agentWorkspace: _omitted, ...rest }) => rest)(agentType('test-ws-none')),
  ]);

  beforeEach(() => {
    steps = [];
    seen.length = 0;
    executions = 0;
  });

  async function startRunner(options: { objectStore?: ObjectStore | null; sandbox?: SandboxDriver | null } = {}) {
    const logs = testLogger();
    const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-workspace-job-dispatch'), prefix });
    dispatchers.push(dispatcher);
    const runner = createJobRunner({
      db: appDb,
      registry,
      dispatcher,
      connection: bullmqConnection(redisConfig(), 'worker', 'test-workspace-job-worker'),
      log: logs.log,
      prefix,
      leaseMs: 8_000,
      reconcileIntervalMs: 600_000,
      concurrency: { agent: 2 },
      objectStore: options.objectStore === undefined ? store : options.objectStore,
      sandbox: options.sandbox === undefined ? fake.driver : options.sandbox,
      agentQuota: { orgAgentRunningLimit: 10 },
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

  async function enqueue(member: Member, dispatcher: JobDispatcher, type = 'test-ws-job') {
    const projectId = await newProject(member);
    const job = await enqueueJob({ db: appDb, registry, dispatcher, log: testLogger().log, agentQuota: { orgAgentRunningLimit: 10 } }, member.context, { type, params: {}, projectId });
    return { job, projectId };
  }

  it('成功完成后丢弃快照；登记 keepAfterSuccess 的保留', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    fake.state.output = gnuTar(WORKSPACE);
    steps = [async (context) => {
      await context.agentWorkspace!.saveCheckpoint(sandboxRef(context.jobId), { step: 1 }, 50);
    }];
    const { job, projectId } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(fake.state.copyOutCalls).toBe(1);
    await waitFor(async () => (await snapshotRows(projectId)).length === 0, 5_000, '快照被丢弃');
    expect(store.objects.size).toBe(0);

    executions = 0;
    steps = [async (context) => {
      await context.agentWorkspace!.saveCheckpoint(sandboxRef(context.jobId), { step: 1 });
    }];
    const kept = await enqueue(member, dispatcher, 'test-ws-keep');
    await waitStatus(kept.job.id, 'succeeded', '任务成功');
    expect((await snapshotRows(kept.projectId)).map((row) => row.superseded_at)).toEqual([null]);
    expect(store.objects.size).toBe(1);
  });

  it('超出存储配额：暂停为 storage_quota、checkpoint 不前进；删除文件后普通的“继续”从上一个检查点续跑并恢复上次的工作区', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    fake.state.output = gnuTar(WORKSPACE);
    let filler: string[] = [];
    const restored: Array<string | null> = [];
    steps = [
      async (context) => {
        await context.agentWorkspace!.saveCheckpoint(sandboxRef(context.jobId), { step: 1 }, 30);
        filler = await fillQuota(member);
        fake.state.output = gnuTar(WORKSPACE_2);
        await context.agentWorkspace!.saveCheckpoint(sandboxRef(context.jobId), { step: 2 }, 60);
        throw new Error('not reached');
      },
      async (context) => {
        const target = sandboxRef(context.jobId);
        restored.push((await context.agentWorkspace!.restore(target))?.id ?? null);
        expect(await filesOf(fake.state.received.get(target.id)!)).toEqual(Object.fromEntries(WORKSPACE.map((file) => [file.path, file.data.toString('utf8')])));
        await context.agentWorkspace!.saveCheckpoint(target, { step: 2 }, 60);
      },
    ];
    const { job, projectId } = await enqueue(member, dispatcher);
    const paused = await waitStatus(job.id, 'paused', '任务暂停');
    expect(paused).toMatchObject({ pause_reason: 'storage_quota', checkpoint: { step: 1 } });
    const events = await listJobEvents(appDb, member.context, job.id, 50);
    expect(events.find((event) => event.kind === 'paused')).toMatchObject({ message: expect.stringContaining('存储空间已满'), data: { reason: 'storage_quota' } });
    const [oldSnapshot] = await snapshotRows(projectId);

    await freeQuota(filler);
    expect((await requestResume(appDb, member.context, job.id)).dispatch).toBe(true);
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-ws-job', queue: 'agent' });
    await waitStatus(job.id, 'succeeded', '续跑后成功');
    expect(seen.map((entry) => entry.checkpoint)).toEqual([null, { step: 1 }]);
    expect(restored).toEqual([oldSnapshot!.id]);
    await waitFor(async () => (await snapshotRows(projectId)).length === 0, 5_000, '快照被丢弃');
  });

  it('任务吞掉 JobStorageQuotaError 后以其他错误退出：仍暂停为 storage_quota', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    fake.state.output = gnuTar(WORKSPACE);
    steps = [async (context) => {
      await fillQuota(member);
      await context.agentWorkspace!.saveCheckpoint(sandboxRef(context.jobId), { step: 1 }).catch(() => {});
      throw new JobError('SOMETHING_ELSE', '其他错误');
    }];
    const { job } = await enqueue(member, dispatcher);
    expect(await waitStatus(job.id, 'paused', '任务暂停')).toMatchObject({ pause_reason: 'storage_quota', checkpoint: null });
  });

  it('任务抛出 JobSelectionRequiredError（8.7e1）：暂停为 waiting_for_selection、checkpoint 保留；普通继续 409，确认后回到 queued，续跑时看到确认的选择', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    fake.state.output = gnuTar(WORKSPACE);
    steps = [
      async (context) => {
        await context.agentWorkspace!.saveCheckpoint(sandboxRef(context.jobId), { step: 1 }, 30);
        throw new JobSelectionRequiredError();
      },
      async () => {},
    ];
    const { job, projectId } = await enqueue(member, dispatcher, 'test-ws-keep');
    expect(await waitStatus(job.id, 'paused', '等待确认')).toMatchObject({ pause_reason: 'waiting_for_selection', checkpoint: { step: 1 } });
    const events = await listJobEvents(appDb, member.context, job.id, 50);
    expect(events.find((event) => event.kind === 'paused')).toMatchObject({ message: '等待确认，确认后任务会继续', data: { reason: 'waiting_for_selection' } });
    await expect(requestResume(appDb, member.context, job.id)).rejects.toMatchObject({ code: 'JOB_SELECTION_REQUIRED' });
    // 类型或项目不符按不存在处理；apply 的结果写进 checkpoint。
    await expect(confirmJobSelection(appDb, member.context, job.id, { projectId, type: 'test-ws-job', apply: (checkpoint) => checkpoint! })).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    await expect(confirmJobSelection(appDb, member.context, job.id, { projectId: randomUUID(), type: 'test-ws-keep', apply: (checkpoint) => checkpoint! })).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    const change = await confirmJobSelection(appDb, member.context, job.id, { projectId, type: 'test-ws-keep', apply: (checkpoint) => ({ ...checkpoint, confirmed: true }) });
    expect(change).toMatchObject({ dispatch: true, job: { status: 'queued', pauseReason: null } });
    await expect(confirmJobSelection(appDb, member.context, job.id, { projectId, type: 'test-ws-keep', apply: (checkpoint) => checkpoint! })).rejects.toMatchObject({ code: 'JOB_SELECTION_NOT_PENDING' });
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-ws-keep', queue: 'agent' });
    await waitStatus(job.id, 'succeeded', '确认后续跑成功');
    expect(seen.map((entry) => entry.checkpoint)).toEqual([null, { step: 1, confirmed: true }]);
    expect((await snapshotRows(projectId)).map((row) => row.superseded_at)).toEqual([null]);
  });

  it('暂停后继续：恢复上次检查点的工作区；快照被篡改时任务以 AGENT_WORKSPACE_RESTORE_FAILED 失败、快照被丢弃', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    fake.state.output = gnuTar(WORKSPACE);
    steps = [
      async (context) => {
        await context.agentWorkspace!.saveCheckpoint(sandboxRef(context.jobId), { step: 1 });
        await requestPause(appDb, member.context, context.jobId);
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('paused');
      },
      async (context) => {
        await context.agentWorkspace!.restore(sandboxRef(context.jobId));
      },
    ];
    const { job, projectId } = await enqueue(member, dispatcher);
    expect(await waitStatus(job.id, 'paused', '任务暂停')).toMatchObject({ pause_reason: null, checkpoint: { step: 1 } });
    const [snapshot] = await superuser.selectFrom('agent_workspace_snapshots').select('storage_key').where('project_id', '=', projectId).execute();
    const bytes = store.objects.get(snapshot!.storage_key)!;
    bytes[bytes.length - 2048] = 0x41;

    await requestResume(appDb, member.context, job.id);
    await dispatcher.dispatch({ id: job.id, orgId: member.orgId, type: 'test-ws-job', queue: 'agent' });
    expect(await waitStatus(job.id, 'failed', '任务失败')).toMatchObject({ error_code: AGENT_WORKSPACE_RESTORE_FAILED_CODE, error_message: '上次保存的 Agent 工作区不可用，已丢弃，请重新发起任务' });
    expect(fake.state.destroyed).toHaveLength(1);
    expect(await snapshotRows(projectId)).toEqual([]);
    expect(store.objects.size).toBe(0);
  });

  it('工作区被拒绝：任务以 AGENT_WORKSPACE_REJECTED 失败，失败说明不含文件名，旧快照保留', async () => {
    const { dispatcher } = await startRunner();
    const member = await newMember();
    fake.state.output = gnuTar(WORKSPACE);
    steps = [async (context) => {
      await context.agentWorkspace!.saveCheckpoint(sandboxRef(context.jobId), { step: 1 });
      fake.state.output = gnuTar([{ path: '投标模版源文件-secret9.docx', data: Buffer.from('x') }]);
      await context.agentWorkspace!.saveCheckpoint(sandboxRef(context.jobId), { step: 2 });
    }];
    const { job, projectId } = await enqueue(member, dispatcher);
    const failed = await waitStatus(job.id, 'failed', '任务失败');
    expect(failed).toMatchObject({ error_code: AGENT_WORKSPACE_REJECTED_CODE, error_message: agentWorkspaceRejectedMessage('file-type'), checkpoint: { step: 1 } });
    expect(failed.error_message).not.toContain('secret9');
    expect((await snapshotRows(projectId)).map((row) => row.superseded_at)).toEqual([null]);
  });

  it('未登记、没有对象存储、driver 不能整体取回归档时 context.agentWorkspace 为 null', async () => {
    const member = await newMember();
    const { copyInArchive: _in, copyOutArchive: _out, ...plain } = fake.driver;
    for (const [type, options] of [
      ['test-ws-none', {}],
      ['test-ws-job', { objectStore: null }],
      ['test-ws-job', { sandbox: plain as SandboxDriver }],
      ['test-ws-job', { sandbox: null }],
    ] as const) {
      const { dispatcher } = await startRunner(options);
      seen.length = 0;
      executions = 0;
      const { job } = await enqueue(member, dispatcher, type);
      await waitStatus(job.id, 'succeeded', '任务成功');
      expect(seen, `${type} ${JSON.stringify(Object.keys(options))}`).toEqual([{ type, workspace: false, checkpoint: null }]);
      await Promise.all(runners.splice(0).map((runner) => runner.close()));
    }
    // 对照组：都具备时提供。
    const { dispatcher } = await startRunner();
    seen.length = 0;
    const { job } = await enqueue(member, dispatcher);
    await waitStatus(job.id, 'succeeded', '任务成功');
    expect(seen).toEqual([{ type: 'test-ws-job', workspace: true, checkpoint: null }]);
  });
});

describe('迁移 0041', () => {
  it('pause_reason 只收登记的原因；回滚后 storage_quota 暂停的任务按手动暂停处理，再升级恢复约束', async () => {
    const member = await newMember();
    const projectId = await newProject(member);
    const job = await superuser.insertInto('jobs')
      .values({ org_id: member.orgId, project_id: projectId, user_id: member.userId, type: 'test-ws-job', status: 'paused', params: {}, pause_reason: 'storage_quota' })
      .returning('id').executeTakeFirstOrThrow();
    await expect(superuser.updateTable('jobs').set({ pause_reason: 'disk_full' }).where('id', '=', job.id).execute()).rejects.toThrow(/jobs_pause_reason_check/);

    const owner = connect(testDb.ownerConfig);
    try {
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0046_technical_plan_section_bodies']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0045_ai_image_generation']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0044_job_pause_selection']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0043_agent_model_rejections']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0042_agent_tool_scopes']);
      expect((await migrateDown(owner)).results?.map((result) => result.migrationName)).toEqual(['0041_job_pause_storage_quota']);
      expect(await superuser.selectFrom('jobs').select(['status', 'pause_reason']).where('id', '=', job.id).executeTakeFirstOrThrow()).toEqual({ status: 'paused', pause_reason: null });
      await expect(superuser.updateTable('jobs').set({ pause_reason: 'storage_quota' }).where('id', '=', job.id).execute()).rejects.toThrow(/jobs_pause_reason_check/);
      await superuser.updateTable('jobs').set({ pause_reason: 'waiting_for_user' }).where('id', '=', job.id).execute();
    } finally {
      expect((await migrateToLatest(owner)).error).toBeUndefined();
      await owner.destroy();
    }
    await superuser.updateTable('jobs').set({ pause_reason: 'storage_quota' }).where('id', '=', job.id).execute();
  });
});

