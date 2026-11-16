// Agent 工作区中受保护文件的登记、比对与还原（src/agent/workspaceBaseline.ts，路线图第 8 步 8.6c2b）的单元测试：
// 1. 登记：write 放入沙箱并登记，路径按工作区的取回规则规范化；分组的追加、整体替换与解除互不影响；同一路径在几个分组中时内容同步刷新；
// 2. 还原：未改动的不放回（只取回一次、不放入）；内容被改（含大小相同）、被删的放回原件并返回路径；解除登记的不再还原；
// 3. 工作区不符合取回规则（符号链接等）时 AGENT_WORKSPACE_REJECTED，不放入；与已有文件或目录冲突（大小写不同的同名文件、上级目录
//    变成文件、文件变成目录）与放回失败时销毁沙箱、AGENT_PROTECTED_FILES_RESTORE_FAILED；中止照原样抛出；
// 4. 续跑：toState 经 JSON 往返后重建，recover 从刚放入的工作区取回与登记相符的原件，不相符的报告为不可用；需要放回不可用的原件时
//    AGENT_PROTECTED_FILES_UNAVAILABLE，重新 write 后恢复正常；
// 5. original 只给 worker 保存的原件（沙箱中的副本被改也不受影响），返回副本；参数与上限检查、checkpoint 中不合法的登记。
// 沙箱用内存桩：取回时按真实 driver 的 toOutputArchive 逐项校验并重新生成，放入时模拟沙箱内 GNU tar 的覆盖与失败。
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  AGENT_BASELINE_MAX_BYTES,
  AGENT_BASELINE_MAX_FILES,
  AGENT_BASELINE_MAX_GROUPS,
  AGENT_PROTECTED_FILES_RESTORE_FAILED_CODE,
  AGENT_PROTECTED_FILES_UNAVAILABLE_CODE,
  createAgentWorkspaceBaseline,
  type AgentWorkspaceBaselineState,
} from '../../src/agent/workspaceBaseline.ts';
import { AGENT_WORKSPACE_REJECTED_CODE } from '../../src/agent/workspaceJob.ts';
import type { WorkspaceSandboxDriver } from '../../src/agent/workspaceSandbox.ts';
import { JobError } from '../../src/jobs/definitions.ts';
import { createArchive, readArchive } from '../../src/sandbox/archive.ts';
import { SandboxError, type SandboxRef } from '../../src/sandbox/driver.ts';
import { toOutputArchive } from '../../src/sandbox/outputArchive.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { END_OF_ARCHIVE, paxEntry, tarEntry } from '../sandbox/tarFixtures.ts';

const SANDBOX: SandboxRef = Object.freeze({ id: '00000000-0000-4000-8000-000000000001', template: 'agent', jobId: '00000000-0000-4000-8000-000000000002', expiresAt: new Date(Date.now() + 3_600_000) });

/** 内存中的 /workspace：普通文件、目录（含空目录）与 Agent 建的符号链接。 */
function fakeSandbox() {
  const state = {
    files: new Map<string, Buffer>(),
    dirs: new Set<string>(),
    symlinks: new Set<string>(),
    copyOutCalls: 0,
    copyIns: [] as string[][],
    destroyed: [] as string[],
    copyInFailure: null as SandboxError | null,
  };
  async function* chunked(content: Buffer) {
    for (let offset = 0; offset < content.length; offset += 700) yield content.subarray(offset, offset + 700);
  }
  function entry(name: string, options: { type?: string; data?: Buffer; linkname?: string } = {}): Buffer {
    // 中文路径经 PAX 头给出（与 GNU tar 相同），避免截断在 name 字段中。
    return Buffer.concat([paxEntry({ path: name }), tarEntry({ name: 'x', ...options })]);
  }
  const driver: WorkspaceSandboxDriver = {
    async create() {
      throw new Error('not used');
    },
    async exec() {
      throw new Error('not used');
    },
    async copyOut() {
      throw new Error('not used');
    },
    async copyInArchive() {
      throw new Error('not used');
    },
    async copyOutArchive(sandbox, options = {}) {
      state.copyOutCalls += 1;
      const parts: Buffer[] = [];
      for (const dir of state.dirs) parts.push(entry(`${dir}/`, { type: '5' }));
      for (const [path, data] of state.files) parts.push(entry(path, { data }));
      for (const link of state.symlinks) parts.push(entry(link, { type: '2', linkname: '/etc/passwd' }));
      parts.push(END_OF_ARCHIVE);
      return toOutputArchive(chunked(Buffer.concat(parts)), SANDBOX_TEMPLATES[sandbox.template].output, { signal: options.signal });
    },
    async copyIn(sandbox, files, options = {}) {
      options.signal?.throwIfAborted();
      // 与 sandbox-runner 相同按模板的输入规则生成与校验归档，再按 GNU tar 的方式写入。
      const archive = createArchive(files as never, SANDBOX_TEMPLATES[sandbox.template].input);
      const entries = await readArchive(Readable.from([archive]), SANDBOX_TEMPLATES[sandbox.template].input);
      state.copyIns.push(entries.map((file) => file.path));
      if (state.copyInFailure) throw state.copyInFailure;
      for (const file of entries) {
        const segments = file.path.split('/');
        for (let index = 1; index < segments.length; index += 1) {
          const parent = segments.slice(0, index).join('/');
          if (state.files.has(parent)) throw new SandboxError('SANDBOX_FAILED', '向沙箱放入文件失败');
          state.dirs.add(parent);
        }
        if ([...state.files.keys(), ...state.dirs].some((other) => other.startsWith(`${file.path}/`))) throw new SandboxError('SANDBOX_FAILED', '向沙箱放入文件失败');
        // GNU tar 默认先删除已有的文件（含符号链接、空目录）再写入。
        state.symlinks.delete(file.path);
        state.dirs.delete(file.path);
        state.files.set(file.path, Buffer.from(file.data));
      }
    },
    async destroy(sandbox) {
      state.destroyed.push(sandbox.id);
    },
  };
  return { driver, state };
}

const text = (value: string) => Buffer.from(value, 'utf8');

async function expectJobError(promise: Promise<unknown>, code: string): Promise<JobError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(JobError);
  expect((error as JobError).code).toBe(code);
  return error as JobError;
}

describe('受保护文件的登记', () => {
  it('write 放入沙箱并登记，路径规范化；original 给出原件的副本', async () => {
    const { driver, state } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    const input = text('招标文件正文');
    await baseline.write(SANDBOX, 'inputs', [
      { path: './输入/招标文件.md', data: input },
      { path: '所选模板配置.json', data: text('{}') },
    ]);
    expect(state.copyIns).toEqual([['输入/招标文件.md', '所选模板配置.json']]);
    expect(state.files.get('输入/招标文件.md')?.toString()).toBe('招标文件正文');
    expect(baseline.paths('inputs')).toEqual(['输入/招标文件.md', '所选模板配置.json']);
    // 调用方之后改动自己的 Buffer、或改动返回的副本，都不影响原件。
    input.fill(0);
    const original = baseline.original('输入/招标文件.md')!;
    expect(original.toString()).toBe('招标文件正文');
    original.fill(0);
    expect(baseline.original('./输入/招标文件.md')!.toString()).toBe('招标文件正文');
    expect(baseline.original('不存在.md')).toBeNull();
  });

  it('分组的追加、整体替换与解除互不影响；同一路径在几个分组中时内容同步刷新', async () => {
    const { driver } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    await baseline.write(SANDBOX, 'inputs', [{ path: 'a.md', data: text('a1') }]);
    await baseline.write(SANDBOX, 'inputs', [{ path: 'b.md', data: text('b1') }]);
    await baseline.write(SANDBOX, 'sections', [{ path: 's1.html', data: text('s1') }, { path: 's2.html', data: text('s2') }]);
    expect(baseline.paths('inputs')).toEqual(['a.md', 'b.md']);
    await baseline.write(SANDBOX, 'sections', [{ path: 's2.html', data: text('s2') }], { replace: true });
    expect(baseline.paths('sections')).toEqual(['s2.html']);
    expect(baseline.paths('inputs')).toEqual(['a.md', 'b.md']);
    expect(baseline.release('inputs', ['a.md', 'c.md'])).toEqual(['a.md']);
    expect(baseline.paths('inputs')).toEqual(['b.md']);
    expect(baseline.release('unknown', ['b.md'])).toEqual([]);
    await baseline.write(SANDBOX, 'ledger', [{ path: 'b.md', data: text('b2') }]);
    expect(baseline.toState().groups.inputs!['b.md']).toEqual(baseline.toState().groups.ledger!['b.md']);
    expect(baseline.original('b.md')!.toString()).toBe('b2');
    // 整体替换为空：分组清空、不放入。
    await baseline.write(SANDBOX, 'sections', [], { replace: true });
    expect(baseline.paths('sections')).toEqual([]);
  });

  it('放入失败时登记不变', async () => {
    const { driver, state } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    await baseline.write(SANDBOX, 'inputs', [{ path: 'a.md', data: text('a1') }]);
    state.copyInFailure = new SandboxError('SANDBOX_UNAVAILABLE', '沙箱服务不可用');
    await expect(baseline.write(SANDBOX, 'inputs', [{ path: 'a.md', data: text('a2') }], { replace: true })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(baseline.original('a.md')!.toString()).toBe('a1');
    expect(baseline.paths('inputs')).toEqual(['a.md']);
  });

  it('参数与上限检查：不合法时不放入、不登记', async () => {
    const { driver, state } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    const bad: Array<[string, unknown[]]> = [
      ['../a.md', []],
      ['/etc/passwd.md', []],
      ['a.exe', []],
      ['.hidden.md', []],
      ['a b.md', []],
      ['目录/', []],
      ['a​.md', []],
    ];
    for (const [path] of bad) {
      await expect(baseline.write(SANDBOX, 'inputs', [{ path, data: text('x') }])).rejects.toBeInstanceOf(TypeError);
    }
    await expect(baseline.write(SANDBOX, 'Inputs', [{ path: 'a.md', data: text('x') }])).rejects.toBeInstanceOf(TypeError);
    await expect(baseline.write(SANDBOX, '__proto__', [{ path: 'a.md', data: text('x') }])).rejects.toBeInstanceOf(TypeError);
    await expect(baseline.write(SANDBOX, 'inputs', [{ path: 'a.md', data: text('x') }, { path: './a.md', data: text('y') }])).rejects.toBeInstanceOf(TypeError);
    await expect(baseline.write(SANDBOX, 'inputs', [{ path: 'a.md', data: 'x' as never }])).rejects.toBeInstanceOf(TypeError);
    await expect(baseline.write({ ...SANDBOX, template: 'parse' }, 'inputs', [{ path: 'a.md', data: text('x') }])).rejects.toBeInstanceOf(TypeError);
    const many = Array.from({ length: AGENT_BASELINE_MAX_FILES + 1 }, (_, index) => ({ path: `f${index}.md`, data: text(String(index)) }));
    await expect(baseline.write(SANDBOX, 'inputs', many)).rejects.toThrow('受保护文件过多');
    const big = Buffer.alloc(AGENT_BASELINE_MAX_BYTES / 2 + 1);
    await expect(baseline.write(SANDBOX, 'inputs', [{ path: 'big1.md', data: big }, { path: 'big2.md', data: Buffer.from(big).fill(1) }])).rejects.toThrow('合计大小');
    for (let index = 0; index < AGENT_BASELINE_MAX_GROUPS; index += 1) await baseline.write(SANDBOX, `g${index}`, []);
    await expect(baseline.write(SANDBOX, 'one-more', [])).rejects.toThrow('分组过多');
    expect(state.copyIns).toEqual([]);
    expect(baseline.paths('inputs')).toEqual([]);
  });

  it('分批写入时合计大小按不同内容计算，相同内容只算一次', async () => {
    const { driver } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    const half = Buffer.alloc(AGENT_BASELINE_MAX_BYTES / 2, 7);
    await baseline.write(SANDBOX, 'inputs', [{ path: 'a.md', data: half }]);
    await baseline.write(SANDBOX, 'copies', [{ path: 'b.md', data: half }]);
    await expect(baseline.write(SANDBOX, 'more', [{ path: 'c.md', data: Buffer.alloc(AGENT_BASELINE_MAX_BYTES / 2 + 1) }])).rejects.toThrow('合计大小');
    // 解除登记后释放额度。
    baseline.release('inputs', ['a.md']);
    baseline.release('copies', ['b.md']);
    await baseline.write(SANDBOX, 'more', [{ path: 'c.md', data: Buffer.alloc(AGENT_BASELINE_MAX_BYTES / 2 + 1) }]);
  });
});

describe('比对与还原', () => {
  it('未改动时只取回一次、不放入；被改（含大小相同）、被删的放回原件', async () => {
    const { driver, state } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    await baseline.write(SANDBOX, 'inputs', [
      { path: '输入/招标文件.md', data: text('原文 AAAA') },
      { path: '输入/评分办法.md', data: text('评分') },
      { path: '所选模板配置.json', data: text('{"a":1}') },
    ]);
    state.copyIns.length = 0;
    // Agent 自己的文件不受影响。
    state.files.set('结果.json', text('{}'));
    expect(await baseline.restore(SANDBOX)).toEqual([]);
    expect(state.copyOutCalls).toBe(1);
    expect(state.copyIns).toEqual([]);

    state.files.set('输入/招标文件.md', text('原文 BBBB'));
    state.files.delete('所选模板配置.json');
    expect(await baseline.restore(SANDBOX)).toEqual(['输入/招标文件.md', '所选模板配置.json']);
    expect(state.copyIns).toEqual([['输入/招标文件.md', '所选模板配置.json']]);
    expect(state.files.get('输入/招标文件.md')!.toString()).toBe('原文 AAAA');
    expect(state.files.get('所选模板配置.json')!.toString()).toBe('{"a":1}');
    expect(state.files.get('结果.json')!.toString()).toBe('{}');
    expect(state.destroyed).toEqual([]);
  });

  it('解除登记的文件不再还原；没有登记时不取回', async () => {
    const { driver, state } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    expect(await baseline.restore(SANDBOX)).toEqual([]);
    expect(state.copyOutCalls).toBe(0);
    await baseline.write(SANDBOX, 'sections', [{ path: '正文/1.html', data: text('<p>1</p>') }]);
    baseline.release('sections', ['正文/1.html']);
    state.files.set('正文/1.html', text('<p>改</p>'));
    expect(await baseline.restore(SANDBOX)).toEqual([]);
    expect(state.files.get('正文/1.html')!.toString()).toBe('<p>改</p>');
  });

  it('受保护文件被换成符号链接、或工作区中有其他不合规文件：AGENT_WORKSPACE_REJECTED，不放入', async () => {
    const { driver, state } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    await baseline.write(SANDBOX, 'inputs', [{ path: 'a.md', data: text('a') }]);
    state.copyIns.length = 0;
    state.files.delete('a.md');
    state.symlinks.add('a.md');
    const error = await expectJobError(baseline.restore(SANDBOX), AGENT_WORKSPACE_REJECTED_CODE);
    expect(error.message).toContain('链接');
    expect(error.message).not.toContain('a.md');
    expect(state.copyIns).toEqual([]);
    state.symlinks.clear();
    state.files.set('a.md', text('a'));
    state.files.set('脚本.sh', text('#!/bin/sh'));
    expect((await expectJobError(baseline.restore(SANDBOX), AGENT_WORKSPACE_REJECTED_CODE)).message).toContain('文件类型');
    expect(state.copyIns).toEqual([]);
  });

  it('与已有的文件或目录冲突时销毁沙箱、AGENT_PROTECTED_FILES_RESTORE_FAILED，不放入', async () => {
    const cases: Array<[string, (state: ReturnType<typeof fakeSandbox>['state']) => void]> = [
      // 删除后建了大小写不同的同名文件（放回会产生重名，快照会被拒绝）。
      [AGENT_PROTECTED_FILES_RESTORE_FAILED_CODE, (state) => {
        state.files.delete('任务/plan.json');
        state.files.set('任务/PLAN.json', text('{}'));
      }],
      // 文件变成了非空目录。
      [AGENT_PROTECTED_FILES_RESTORE_FAILED_CODE, (state) => {
        state.files.delete('任务/plan.json');
        state.files.set('任务/plan.json/内容.md', text('x'));
      }],
      // 上级目录变成了没有扩展名的文件：取回规则先拒绝（文件类型），同样不放入。
      [AGENT_WORKSPACE_REJECTED_CODE, (state) => {
        state.files.delete('任务/plan.json');
        state.dirs.delete('任务');
        state.files.set('任务', text('x'));
      }],
    ];
    for (const [code, mutate] of cases) {
      const { driver, state } = fakeSandbox();
      const baseline = createAgentWorkspaceBaseline({ driver });
      await baseline.write(SANDBOX, 'inputs', [{ path: '任务/plan.json', data: text('{"a":1}') }]);
      state.copyIns.length = 0;
      const error = await expectJobError((mutate(state), baseline.restore(SANDBOX)), code);
      expect(error.message).not.toContain('plan');
      expect(state.destroyed).toEqual(code === AGENT_PROTECTED_FILES_RESTORE_FAILED_CODE ? [SANDBOX.id] : []);
      expect(state.copyIns).toEqual([]);
    }
  });

  it('上级目录变成同名的合法文件时同样冲突', async () => {
    const { driver, state } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    await baseline.write(SANDBOX, 'inputs', [{ path: 'a.md/b.md', data: text('b') }]);
    state.copyIns.length = 0;
    state.files.delete('a.md/b.md');
    state.dirs.delete('a.md');
    state.files.set('A.md', text('x'));
    await expectJobError(baseline.restore(SANDBOX), AGENT_PROTECTED_FILES_RESTORE_FAILED_CODE);
    expect(state.destroyed).toEqual([SANDBOX.id]);
    expect(state.copyIns).toEqual([]);
  });

  it('空目录占了受保护文件的位置：GNU tar 删除空目录后写入', async () => {
    const { driver, state } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    await baseline.write(SANDBOX, 'inputs', [{ path: 'a.md', data: text('a') }]);
    state.files.delete('a.md');
    state.dirs.add('a.md');
    expect(await baseline.restore(SANDBOX)).toEqual(['a.md']);
    expect(state.files.get('a.md')!.toString()).toBe('a');
  });

  it('放回失败时销毁沙箱、AGENT_PROTECTED_FILES_RESTORE_FAILED；中止照原样抛出', async () => {
    const { driver, state } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    await baseline.write(SANDBOX, 'inputs', [{ path: 'a.md', data: text('a') }]);
    state.files.set('a.md', text('b'));
    state.copyInFailure = new SandboxError('SANDBOX_FAILED', '向沙箱放入文件失败');
    const error = await expectJobError(baseline.restore(SANDBOX), AGENT_PROTECTED_FILES_RESTORE_FAILED_CODE);
    expect(error.cause).toBe(state.copyInFailure);
    expect(state.destroyed).toEqual([SANDBOX.id]);

    state.destroyed.length = 0;
    state.copyInFailure = new SandboxError('SANDBOX_ABORTED', '沙箱操作已中止');
    await expect(baseline.restore(SANDBOX)).rejects.toBe(state.copyInFailure);
    expect(state.destroyed).toEqual([]);
  });

  it('original 始终给出 worker 保存的原件，不受沙箱中的副本影响', async () => {
    const { driver, state } = fakeSandbox();
    const baseline = createAgentWorkspaceBaseline({ driver });
    await baseline.write(SANDBOX, 'inputs', [{ path: 'a.md', data: text('原件') }]);
    await baseline.restore(SANDBOX);
    // 还原之后后台进程再次改动。
    state.files.set('a.md', text('被改'));
    expect(baseline.original('a.md')!.toString()).toBe('原件');
  });
});

describe('续跑', () => {
  it('toState 经 JSON 往返后重建；recover 取回相符的原件，不相符的报告为不可用', async () => {
    const first = fakeSandbox();
    const before = createAgentWorkspaceBaseline({ driver: first.driver });
    await before.write(SANDBOX, 'inputs', [
      { path: '输入/招标文件.md', data: text('招标') },
      { path: '所选模板配置.json', data: text('{}') },
    ]);
    await before.write(SANDBOX, 'images', [{ path: '原方案图片/1.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }]);
    const state = JSON.parse(JSON.stringify(before.toState())) as AgentWorkspaceBaselineState;

    // 新的执行：放入的快照中，招标文件被 Agent 改过（检查点之前没有还原），配置被删除，图片原样。
    const second = fakeSandbox();
    second.state.files.set('输入/招标文件.md', text('招改'));
    second.state.files.set('原方案图片/1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const after = createAgentWorkspaceBaseline({ driver: second.driver }, state);
    expect(after.paths('inputs')).toEqual(['输入/招标文件.md', '所选模板配置.json']);
    expect(after.original('原方案图片/1.png')).toBeNull();
    expect(await after.recover(SANDBOX)).toEqual(['输入/招标文件.md', '所选模板配置.json']);
    expect(after.original('原方案图片/1.png')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(after.original('输入/招标文件.md')).toBeNull();

    // 需要放回、但原件不可用：不把沙箱中的内容当作原件。
    const unavailable = await expectJobError(after.restore(SANDBOX), AGENT_PROTECTED_FILES_UNAVAILABLE_CODE);
    expect(unavailable.message).not.toContain('招标');
    expect(second.state.copyIns).toEqual([]);
    expect(second.state.files.get('输入/招标文件.md')!.toString()).toBe('招改');

    // 任务重新写入输入资料后恢复正常，图片的原件来自 recover。
    await after.write(SANDBOX, 'inputs', [
      { path: '输入/招标文件.md', data: text('招标') },
      { path: '所选模板配置.json', data: text('{}') },
    ], { replace: true });
    second.state.files.set('原方案图片/1.png', Buffer.from([0]));
    expect(await after.restore(SANDBOX)).toEqual(['原方案图片/1.png']);
    expect(second.state.files.get('原方案图片/1.png')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('recover 不保存大小与登记不符、或大小写不同的同名文件', async () => {
    const first = fakeSandbox();
    const before = createAgentWorkspaceBaseline({ driver: first.driver });
    await before.write(SANDBOX, 'inputs', [{ path: 'a.md', data: text('aaaa') }, { path: 'b.md', data: text('bbbb') }]);
    const second = fakeSandbox();
    second.state.files.set('a.md', Buffer.alloc(1024 * 1024));
    second.state.files.set('B.md', text('bbbb'));
    const after = createAgentWorkspaceBaseline({ driver: second.driver }, before.toState());
    expect(await after.recover(SANDBOX)).toEqual(['a.md', 'b.md']);
    expect(after.original('a.md')).toBeNull();
    expect(after.original('b.md')).toBeNull();
    // 没有登记时不取回。
    const empty = fakeSandbox();
    expect(await createAgentWorkspaceBaseline({ driver: empty.driver }).recover(SANDBOX)).toEqual([]);
    expect(empty.state.copyOutCalls).toBe(0);
  });

  it('checkpoint 中不合法的登记：TypeError', () => {
    const { driver } = fakeSandbox();
    const hash = 'a'.repeat(64);
    const invalid: unknown[] = [
      0,
      '',
      [],
      'x',
      { version: 2, groups: {} },
      { version: 1 },
      { version: 1, groups: [] },
      { version: 1, groups: { Bad: {} } },
      { version: 1, groups: { inputs: [] } },
      { version: 1, groups: { inputs: { './a.md': { sha256: hash, size: 1 } } } },
      { version: 1, groups: { inputs: { '../a.md': { sha256: hash, size: 1 } } } },
      { version: 1, groups: { inputs: { 'a.md': { sha256: 'A'.repeat(64), size: 1 } } } },
      { version: 1, groups: { inputs: { 'a.md': { sha256: hash, size: -1 } } } },
      { version: 1, groups: { inputs: { 'a.md': { sha256: hash, size: 1.5 } } } },
      { version: 1, groups: { inputs: { 'a.md': { sha256: hash } } } },
      { version: 1, groups: { inputs: { 'a.md': null } } },
      { version: 1, groups: Object.fromEntries(Array.from({ length: AGENT_BASELINE_MAX_GROUPS + 1 }, (_, index) => [`g${index}`, {}])) },
      { version: 1, groups: { inputs: Object.fromEntries(Array.from({ length: AGENT_BASELINE_MAX_FILES + 1 }, (_, index) => [`f${index}.md`, { sha256: hash, size: 1 }])) } },
      // 合计大小超过上限（不同内容，各 1 MiB）：recover 不能因此把超过上限的原件取回内存。
      { version: 1, groups: { inputs: Object.fromEntries(Array.from({ length: AGENT_BASELINE_MAX_BYTES / (1024 * 1024) + 1 }, (_, index) => [`f${index}.md`, { sha256: index.toString(16).padStart(64, '0'), size: 1024 * 1024 }])) } },
    ];
    for (const state of invalid) {
      expect(() => createAgentWorkspaceBaseline({ driver }, state as AgentWorkspaceBaselineState)).toThrow(TypeError);
    }
    expect(createAgentWorkspaceBaseline({ driver }, { version: 1, groups: { inputs: { 'a.md': { sha256: hash, size: 1 } } } }).paths('inputs')).toEqual(['a.md']);
    // 上限处照常；相同内容只算一次。
    const atLimit = Object.fromEntries(Array.from({ length: AGENT_BASELINE_MAX_BYTES / (1024 * 1024) }, (_, index) => [`f${index}.md`, { sha256: index.toString(16).padStart(64, '0'), size: 1024 * 1024 }]));
    expect(createAgentWorkspaceBaseline({ driver }, { version: 1, groups: { inputs: atLimit, copy: { 'g.md': { sha256: '0'.repeat(64), size: 1024 * 1024 } } } }).paths('copy')).toEqual(['g.md']);
  });
});
