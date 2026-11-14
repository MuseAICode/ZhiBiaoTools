// Agent 工作区快照的取回与放入（src/agent/workspaceSandbox.ts，路线图第 8 步 8.5b）的数据库测试：
// 1. 往返：沙箱的 /workspace（含中文文件名、目录、GNU 长名、PAX 头与 tar 记录对齐）取回后保存为只含普通文件、不带扩展头的归档，
//    文件数由取回时数出；放入新沙箱的字节与保存的完全相同，读回的文件与原来的一致；
// 2. 取回的恶意样本（符号链接、硬链接、设备文件、FIFO、../、绝对路径、扩展名、隐藏文件、中文路径的各种绕过、超大、超数、
//    文件与目录冲突、被截断）：整体拒绝（SANDBOX_OUTPUT_REJECTED），不留下新对象与登记行，旧快照仍是当前的、内容不变；
//    超出配额、中止同样不留痕；
// 3. 放入前再次校验：对象被篡改（SHA-256 不符）、缺失、被截断；绕过了 SHA-256 的不合规内容（模拟取回校验有缺陷时写进去的快照）、
//    文件数与记录不符：沙箱被销毁、抛 SANDBOX_INPUT_FAILED（cause 为原因），沙箱收不到结束块；放入失败时同样销毁；
// 4. 没有快照时返回 null、不碰沙箱；其他组织看不到；非 agent 沙箱是程序错误。
// 沙箱用内存桩（放入与 sandbox-runner 相同按模板的输入规则校验，取回经与真实 driver 相同的 toOutputArchive），对象存储用内存实现；
// 真实 agent 沙箱中的往返与恶意文件见 tests/sandbox/docker/agentWorkspace.test.ts。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { restoreWorkspaceSnapshot, saveWorkspaceSnapshot, type WorkspaceSandboxDriver } from '../../src/agent/workspaceSandbox.ts';
import { findWorkspaceSnapshot, WorkspaceSnapshotIntegrityError, writeWorkspaceSnapshot } from '../../src/agent/workspaceSnapshots.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { DOCUMENT_MAX_BYTES, ORG_STORAGE_QUOTA_BYTES } from '../../src/files/policy.ts';
import { createArchive, readArchive, SandboxArchiveError, validateArchiveStream } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxRef } from '../../src/sandbox/driver.ts';
import { toOutputArchive } from '../../src/sandbox/outputArchive.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { END_OF_ARCHIVE, paxEntry, tarEntry } from '../sandbox/tarFixtures.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const KIND = 'technical-plan-outline';
const QUOTA = Number(ORG_STORAGE_QUOTA_BYTES);

let testDb: TestDatabase;
let superuser: Kysely<any>;
let appDb: Kysely<Database>;

interface MemoryStore extends ObjectStore {
  objects: Map<string, Buffer>;
}

function createMemoryStore(): MemoryStore {
  const store: MemoryStore = {
    objects: new Map(),
    async put(key, body, options) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        options.signal?.throwIfAborted();
        chunks.push(Buffer.from(chunk));
      }
      options.signal?.throwIfAborted();
      store.objects.set(key, Buffer.concat(chunks));
    },
    async get(key) {
      const content = store.objects.get(key);
      if (!content) return null;
      // 分块返回，覆盖跨块的校验。
      const parts: Buffer[] = [];
      for (let offset = 0; offset < content.length; offset += 4096) parts.push(content.subarray(offset, offset + 4096));
      return { body: Readable.from(parts), size: content.length };
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

/** 沙箱的内存桩：copyOutArchive 产出 output（按块），copyInArchive 与 sandbox-runner 相同按模板的输入规则边读边校验。 */
function fakeDriver() {
  const state = {
    output: Buffer.alloc(0) as Buffer,
    /** 每个沙箱收到（通过放入校验）的字节；放入中途失败时为失败前收到的字节。 */
    received: new Map<string, Buffer>(),
    destroyed: [] as string[],
    copyInCalls: 0,
    /** 放入时 sandbox-runner 返回的错误（模拟沙箱内的 tar 失败）。 */
    copyInFailure: null as SandboxError | null,
  };
  async function* chunked(content: Buffer) {
    for (let offset = 0; offset < content.length; offset += 3000) yield content.subarray(offset, offset + 3000);
  }
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
      return toOutputArchive(chunked(state.output), SANDBOX_TEMPLATES[sandbox.template].output, { signal: options.signal });
    },
    async copyInArchive(sandbox, archive) {
      state.copyInCalls += 1;
      const parts: Buffer[] = [];
      try {
        for await (const chunk of validateArchiveStream(Buffer.isBuffer(archive) ? Readable.from([archive]) : archive, SANDBOX_TEMPLATES[sandbox.template].input)) {
          parts.push(chunk);
        }
      } catch (error) {
        // 与经 HTTP 时相同：driver 只知道放入失败，不知道源的错误。
        throw new SandboxError(error instanceof SandboxArchiveError ? 'SANDBOX_BAD_REQUEST' : 'SANDBOX_UNAVAILABLE', '放入失败', { cause: error });
      } finally {
        state.received.set(sandbox.id, Buffer.concat(parts));
      }
      if (state.copyInFailure) throw state.copyInFailure;
    },
    async destroy(sandbox) {
      state.destroyed.push(sandbox.id);
    },
  };
  return { driver, state };
}

let store: MemoryStore;
let fake: ReturnType<typeof fakeDriver>;
const deps = () => ({ db: appDb, store, driver: fake.driver });

beforeEach(() => {
  store = createMemoryStore();
  fake = fakeDriver();
});

function sandboxRef(template: SandboxRef['template'] = 'agent'): SandboxRef {
  return Object.freeze({ id: randomUUID(), template, jobId: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
}

async function newOrg(): Promise<TenantContext> {
  const orgId = randomUUID();
  await superuser.insertInto('organizations').values({ id: orgId, name: orgId, kind: 'team' }).execute();
  const userId = randomUUID();
  await superuser.insertInto('users').values({ id: userId, email: `${userId}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  return { orgId, userId, role: 'owner' };
}

async function newProject(ctx: TenantContext): Promise<string> {
  return (await superuser.insertInto('projects')
    .values({ org_id: ctx.orgId, kind: 'technical-plan', name: '项目', created_by: ctx.userId })
    .returning('id').executeTakeFirstOrThrow()).id;
}

async function setup() {
  const ctx = await newOrg();
  const projectId = await newProject(ctx);
  return { ctx, target: { projectId, taskKind: KIND } };
}

async function rows(projectId: string) {
  return superuser.selectFrom('agent_workspace_snapshots').selectAll().where('project_id', '=', projectId).orderBy('created_at').execute();
}

/** 沙箱内 GNU tar 产出的样子：目录条目、./ 前缀、超过 100 字节的名字用 GNU 长名、结尾有记录对齐。 */
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
    const name = `./${file.path}`;
    if (Buffer.byteLength(name) > 100) {
      parts.push(tarEntry({ name: '././@LongLink', type: 'L', data: Buffer.from(`${name}\0`), format: 'gnu' }));
      parts.push(tarEntry({ name: name.slice(0, 30), data: file.data, format: 'gnu' }));
    } else {
      parts.push(tarEntry({ name, data: file.data, format: 'gnu' }));
    }
  }
  return Buffer.concat([...parts, ...extra, END_OF_ARCHIVE, Buffer.alloc(8 * 1024)]);
}

const WORKSPACE = [
  { path: '任务/大纲.json', data: Buffer.from('{"章节":[1,2,3]}') },
  { path: '所选模板配置.json', data: Buffer.from('{}') },
  { path: `底稿/${'很长的中文文件名'.repeat(4)}/第一章（初稿）.md`, data: Buffer.from('# 第一章\n'.repeat(500)) },
  { path: 'images/图1.png', data: Buffer.alloc(70_000, 0x89) },
  { path: 'pi-sessions/2026-11-14T10-00-00-000Z_0f8e.jsonl', data: Buffer.from('{"type":"session"}\n') },
  { path: 'empty.txt', data: Buffer.alloc(0) },
];

async function readAll(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
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
  appDb = connect<Database>(testDb.appConfig, 6);
});

afterAll(async () => {
  await appDb?.destroy();
  await testDb?.drop();
});

describe('取回并保存', () => {
  it('中文文件名的工作区往返：保存为只含普通文件、不带扩展头的归档，放入新沙箱的字节与之相同', async () => {
    const { ctx, target } = await setup();
    fake.state.output = gnuTar(WORKSPACE, [paxEntry({ path: 'pax/附录.md' }), tarEntry({ name: 'ignored', data: Buffer.from('附录') })]);
    const record = await saveWorkspaceSnapshot(deps(), ctx, sandboxRef(), target);
    expect(record.fileCount).toBe(WORKSPACE.length + 1);
    const expected = createArchive([...WORKSPACE, { path: 'pax/附录.md', data: Buffer.from('附录') }], SANDBOX_TEMPLATES.agent.input);
    const saved = store.objects.get(record.storageKey)!;
    expect(saved.equals(expected)).toBe(true);
    expect(record.size).toBe(expected.length);
    // 每个头部都是普通文件（类型 0），没有目录与扩展头。
    for (let offset = 0; offset < saved.length - 1024; ) {
      expect(String.fromCharCode(saved[offset + 156]!)).toBe('0');
      const size = Number.parseInt(saved.subarray(offset + 124, offset + 135).toString('ascii'), 8);
      offset += 512 + Math.ceil(size / 512) * 512;
    }

    const next = sandboxRef('agent-content');
    const restored = await restoreWorkspaceSnapshot(deps(), ctx, next, target);
    expect(restored?.id).toBe(record.id);
    const received = fake.state.received.get(next.id)!;
    expect(received.equals(expected)).toBe(true);
    const files = await readArchive(Readable.from([received]), SANDBOX_TEMPLATES.agent.output);
    expect(files.map((file) => [file.path, file.data.toString('base64')])).toEqual(
      [...WORKSPACE, { path: 'pax/附录.md', data: Buffer.from('附录') }].map((file) => [file.path, file.data.toString('base64')]),
    );
    expect(fake.state.destroyed).toEqual([]);
  });

  it('空的工作区也能保存与恢复', async () => {
    const { ctx, target } = await setup();
    fake.state.output = gnuTar([]);
    const record = await saveWorkspaceSnapshot(deps(), ctx, sandboxRef(), target);
    expect(record.fileCount).toBe(0);
    const next = sandboxRef();
    await restoreWorkspaceSnapshot(deps(), ctx, next, target);
    expect(fake.state.received.get(next.id)!.equals(END_OF_ARCHIVE)).toBe(true);
  });

  const MALICIOUS: Array<[string, () => Buffer]> = [
    ['符号链接', () => gnuTar([], [tarEntry({ name: './x.md', type: '2', linkname: '/etc/passwd', format: 'gnu' })])],
    ['指向工作区外的硬链接', () => gnuTar([], [tarEntry({ name: './x.md', type: '1', linkname: '../../etc/shadow', format: 'gnu' })])],
    ['字符设备', () => gnuTar([], [tarEntry({ name: './null.md', type: '3', format: 'gnu' })])],
    ['FIFO', () => gnuTar([], [tarEntry({ name: './fifo.md', type: '6', format: 'gnu' })])],
    ['../ 穿越', () => gnuTar([], [tarEntry({ name: './任务/../../x.md', data: Buffer.from('x'), format: 'gnu' })])],
    ['GNU 长名中的穿越', () => gnuTar([], [tarEntry({ name: '././@LongLink', type: 'L', data: Buffer.from(`../${'a'.repeat(120)}.md\0`), format: 'gnu' }), tarEntry({ name: 'x.md', format: 'gnu' })])],
    ['绝对路径', () => gnuTar([], [paxEntry({ path: '/etc/cron.d/x.md' }), tarEntry({ name: 'x.md' })])],
    ['扩展名不在白名单', () => gnuTar([{ path: '任务/run.sh', data: Buffer.from('#!/bin/sh') }])],
    ['隐藏文件', () => gnuTar([{ path: '.bashrc.md', data: Buffer.from('x') }])],
    ['全角斜线', () => gnuTar([{ path: '任务／大纲.json', data: Buffer.from('{}') }])],
    ['全角的 ..', () => gnuTar([{ path: '．．/大纲.json', data: Buffer.from('{}') }])],
    ['零宽字符', () => gnuTar([{ path: '大纲​.json', data: Buffer.from('{}') }])],
    ['双向控制字符', () => gnuTar([{ path: '大纲‮nosj.md', data: Buffer.from('{}') }])],
    ['NFD 组合字符', () => gnuTar([{ path: 'é.md', data: Buffer.from('x') }])],
    ['折叠后同名', () => gnuTar([{ path: 'A.md', data: Buffer.from('1') }, { path: 'a.md', data: Buffer.from('2') }])],
    ['文件与目录冲突', () => gnuTar([{ path: 'a.md', data: Buffer.from('1') }], [tarEntry({ name: './a.md/b.md', data: Buffer.from('2'), format: 'gnu' })])],
    ['单个文件超大', () => gnuTar([], [tarEntry({ name: './big.png', size: 100 * 1024 * 1024 + 1, format: 'gnu' })])],
    ['超数', () => gnuTar(Array.from({ length: 10_001 }, (_, index) => ({ path: `f/${index}.md`, data: Buffer.alloc(0) })))],
    ['被截断', () => gnuTar(WORKSPACE).subarray(0, 6000)],
  ];

  it.each(MALICIOUS)('拒绝%s：不留下新快照，旧快照仍是当前的', async (_label, build) => {
    const { ctx, target } = await setup();
    fake.state.output = gnuTar(WORKSPACE.slice(0, 2));
    const old = await saveWorkspaceSnapshot(deps(), ctx, sandboxRef(), target);
    const oldBytes = Buffer.from(store.objects.get(old.storageKey)!);
    fake.state.output = build();
    const error = await saveWorkspaceSnapshot(deps(), ctx, sandboxRef(), target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' });
    expect((error as SandboxError).cause).toBeInstanceOf(SandboxArchiveError);
    expect((await rows(target.projectId)).map((row) => row.id)).toEqual([old.id]);
    expect([...store.objects.keys()]).toEqual([old.storageKey]);
    expect(store.objects.get(old.storageKey)!.equals(oldBytes)).toBe(true);
    expect((await findWorkspaceSnapshot(appDb, ctx, target))?.id).toBe(old.id);
  });

  it('超出组织配额时 413 STORAGE_QUOTA_EXCEEDED，不留痕', async () => {
    const { ctx, target } = await setup();
    for (let left = QUOTA; left > 0; left -= DOCUMENT_MAX_BYTES) {
      await superuser.insertInto('files').values({
        org_id: ctx.orgId, purpose: 'tender', display_name: 'filler.pdf', extension: 'pdf', status: 'uploaded', mime: 'application/pdf',
        size_bytes: Math.min(left, DOCUMENT_MAX_BYTES), sha256: Buffer.alloc(32), created_by: ctx.userId, uploaded_at: new Date(),
      }).execute();
    }
    fake.state.output = gnuTar(WORKSPACE.slice(0, 1));
    await expect(saveWorkspaceSnapshot(deps(), ctx, sandboxRef(), target)).rejects.toMatchObject({ statusCode: 413, code: 'STORAGE_QUOTA_EXCEEDED' });
    expect(await rows(target.projectId)).toEqual([]);
    expect(store.objects.size).toBe(0);
  });

  it('中止时不留痕', async () => {
    const { ctx, target } = await setup();
    fake.state.output = gnuTar(WORKSPACE);
    const controller = new AbortController();
    controller.abort();
    await expect(saveWorkspaceSnapshot(deps(), ctx, sandboxRef(), target, { signal: controller.signal })).rejects.toBeDefined();
    expect(await rows(target.projectId)).toEqual([]);
    expect(store.objects.size).toBe(0);
  });

  it('非 agent 沙箱是程序错误', async () => {
    const { ctx, target } = await setup();
    await expect(saveWorkspaceSnapshot(deps(), ctx, sandboxRef('parse'), target)).rejects.toBeInstanceOf(TypeError);
    await expect(restoreWorkspaceSnapshot(deps(), ctx, sandboxRef('export-document'), target)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('放入前再次校验', () => {
  async function saved() {
    const { ctx, target } = await setup();
    fake.state.output = gnuTar(WORKSPACE);
    const record = await saveWorkspaceSnapshot(deps(), ctx, sandboxRef(), target);
    return { ctx, target, record };
  }

  /** 改写对象并同步改写记录中的大小与 SHA-256（模拟取回校验有缺陷时写进去的快照：SHA-256 核对通过，内容不合规）。 */
  async function forge(record: { id: string; storageKey: string }, content: Buffer, fileCount?: number) {
    store.objects.set(record.storageKey, content);
    const digest = (await import('node:crypto')).createHash('sha256').update(content).digest();
    // 完成后的行只能被替换（AW003），这里以超级用户临时关掉守卫触发器直接改写，模拟数据被篡改。
    await sql`ALTER TABLE agent_workspace_snapshots DISABLE TRIGGER USER`.execute(superuser);
    try {
      await superuser.updateTable('agent_workspace_snapshots')
        .set({ size_bytes: content.length, sha256: digest, ...(fileCount === undefined ? {} : { file_count: fileCount }) })
        .where('id', '=', record.id).execute();
    } finally {
      await sql`ALTER TABLE agent_workspace_snapshots ENABLE TRIGGER USER`.execute(superuser);
    }
  }

  async function expectRejected(ctx: TenantContext, target: { projectId: string; taskKind: string }, cause: abstract new (...args: never[]) => Error, reason: string) {
    const sandbox = sandboxRef();
    const error = await restoreWorkspaceSnapshot(deps(), ctx, sandbox, target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ code: 'SANDBOX_INPUT_FAILED' });
    expect((error as SandboxError).cause).toBeInstanceOf(cause);
    expect((error as { cause: { reason: string } }).cause.reason).toBe(reason);
    // 沙箱被销毁；收到的字节不是完整的归档（没有结束块）。
    expect(fake.state.destroyed).toEqual([sandbox.id]);
    const received = fake.state.received.get(sandbox.id);
    if (received && received.length >= 1024) expect(received.subarray(-1024).equals(Buffer.alloc(1024))).toBe(false);
    return received;
  }

  it('对象被篡改（SHA-256 不符）：沙箱被销毁，收不到结束块', async () => {
    const { ctx, target, record } = await saved();
    const tampered = Buffer.from(store.objects.get(record.storageKey)!);
    tampered[600] = tampered[600]! ^ 0xff; // 第一个文件的内容
    store.objects.set(record.storageKey, tampered);
    await expectRejected(ctx, target, WorkspaceSnapshotIntegrityError, 'sha256');
  });

  it('对象缺失、被截断或多出字节', async () => {
    const { ctx, target, record } = await saved();
    const original = Buffer.from(store.objects.get(record.storageKey)!);
    store.objects.set(record.storageKey, original.subarray(0, original.length - 512));
    await expectRejected(ctx, target, WorkspaceSnapshotIntegrityError, 'size');
    fake.state.destroyed.length = 0;
    store.objects.set(record.storageKey, Buffer.concat([original, Buffer.alloc(512)]));
    await expectRejected(ctx, target, WorkspaceSnapshotIntegrityError, 'size');
    fake.state.destroyed.length = 0;
    store.objects.delete(record.storageKey);
    const received = await expectRejected(ctx, target, WorkspaceSnapshotIntegrityError, 'missing');
    expect(received).toBeUndefined();
  });

  it.each<[string, () => Buffer, string]>([
    ['符号链接', () => Buffer.concat([tarEntry({ name: 'x.md', type: '2', linkname: '/etc/passwd' }), END_OF_ARCHIVE]), 'symbolic link not allowed'],
    ['硬链接', () => Buffer.concat([tarEntry({ name: 'a.md', data: Buffer.from('x') }), tarEntry({ name: 'x.md', type: '1', linkname: 'a.md' }), END_OF_ARCHIVE]), 'hard link not allowed'],
    ['../ 穿越', () => Buffer.concat([tarEntry({ name: '../../x.md', data: Buffer.from('x') }), END_OF_ARCHIVE]), 'path traversal'],
    // 模板的放入规则不限扩展名：证明放入前按的是更严的取回规则。
    ['扩展名不在白名单', () => Buffer.concat([tarEntry({ name: 'run.sh', data: Buffer.from('x') }), END_OF_ARCHIVE]), 'file extension not allowed'],
    ['全角斜线', () => Buffer.concat([tarEntry({ name: 'a／b.md', data: Buffer.from('x') }), END_OF_ARCHIVE]), 'path segment not allowed'],
    ['双向控制字符', () => Buffer.concat([tarEntry({ name: 'a‮.md', data: Buffer.from('x') }), END_OF_ARCHIVE]), 'path segment not allowed'],
    ['折叠后同名', () => Buffer.concat([tarEntry({ name: 'A.md' }), tarEntry({ name: 'a.md' }), END_OF_ARCHIVE]), 'duplicate path'],
    ['被截断', () => tarEntry({ name: 'a.md', data: Buffer.from('x') }), 'archive truncated'],
  ])('SHA-256 核对通过但内容不合规（%s）：沙箱被销毁', async (_label, build, reason) => {
    const { ctx, target, record } = await saved();
    await forge(record, build());
    await expectRejected(ctx, target, SandboxArchiveError, reason);
  });

  it('文件数与记录不符：在结束块之前拒绝', async () => {
    const { ctx, target, record } = await saved();
    await forge(record, store.objects.get(record.storageKey)!, record.fileCount + 1);
    await expectRejected(ctx, target, SandboxArchiveError, 'file count mismatch');
  });

  it('放入本身失败（沙箱内的 tar 失败）时同样销毁沙箱，按 driver 的错误码抛出', async () => {
    const { ctx, target } = await saved();
    fake.state.copyInFailure = new SandboxError('SANDBOX_FAILED', '向沙箱放入文件失败');
    const sandbox = sandboxRef();
    await expect(restoreWorkspaceSnapshot(deps(), ctx, sandbox, target)).rejects.toMatchObject({ code: 'SANDBOX_FAILED' });
    expect(fake.state.destroyed).toEqual([sandbox.id]);
  });

  it('没有快照时返回 null、不碰沙箱；其他组织看不到这个快照', async () => {
    const { ctx, target } = await saved();
    const other = await newOrg();
    const sandbox = sandboxRef();
    expect(await restoreWorkspaceSnapshot(deps(), other, sandbox, target)).toBeNull();
    expect(await restoreWorkspaceSnapshot(deps(), ctx, sandbox, { ...target, taskKind: 'feasibility-outline' })).toBeNull();
    expect(fake.state.copyInCalls).toBe(0);
    expect(fake.state.destroyed).toEqual([]);
    // 对照组：本组织能恢复。
    expect(await restoreWorkspaceSnapshot(deps(), ctx, sandbox, target)).not.toBeNull();
  });

  it('写入时给出的文件数函数出错或超出范围时按失败处理、不留痕', async () => {
    const { ctx, target } = await setup();
    const body = createArchive(WORKSPACE.slice(0, 1), SANDBOX_TEMPLATES.agent.input);
    for (const fileCount of [() => { throw new Error('not consumed'); }, () => -1, () => 10_001]) {
      await expect(writeWorkspaceSnapshot(appDb, ctx, store, { ...target, fileCount }, Readable.from([body]))).rejects.toBeDefined();
    }
    expect(await rows(target.projectId)).toEqual([]);
    expect(store.objects.size).toBe(0);
  });
});
