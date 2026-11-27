// 正文小节的并发编辑（src/technicalPlan/contentSectionEditing.ts，路线图第 8 步 8.10c3b2）：
// - 与桌面版 editContentSections 逐项相同（fixtures/contentSectionEditCases.json，由 generateContentSectionEditExpected.mjs 用桌面版
//   预先生成）：子任务的提示词、执行续接的说明、各节结果、本批以外被改动（含新建）的小节还原与还原的文件；
// - 执行重试：模型调用失败时在同一子会话中续接一次（没有会话文件时重新发出本节任务），用完后本节失败；报告失败、轮数上限、墙钟、
//   会话不可用不续接、说明固定；
// - 同一小节不能被两批同时编辑，非本轮目标与重复的小节被拒绝；致命错误中止本批其余子会话后按原因抛出，编辑状态随之清除；
// - 并发：各子会话同时进行时互不覆盖对方的文件（还原只针对本批以外、不在其他批次中的小节）；过大的小节不比较、不还原。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentChildPromptInput, AgentChildPromptOutcome, AgentWorkspaceFile } from '../../src/agent/execution.ts';
import { AgentToolRequestRejection } from '../../src/agent/toolRequests.ts';
import { JobTaskLimitError } from '../../src/jobs/definitions.ts';
import {
  contentSectionEditRetryPrompt,
  createContentSectionEditActivity,
  editContentSections,
  type EditContentSectionsOptions,
} from '../../src/technicalPlan/contentSectionEditing.ts';
import type { ContentSubmissionTarget } from '../../src/technicalPlan/contentSubmission.ts';

interface Case {
  name: string;
  title: '一致性修复' | '提交问题修复';
  instructions: string;
  preloadInput: boolean;
  preserveDataTables: boolean;
  factsRequirements: string;
  rules: string;
  targets: ContentSubmissionTarget[];
  files: Record<string, string>;
  jobs: { section_id: string; instructions: string }[];
  children: Record<string, { write?: Record<string, string>; fail?: string }>;
  issues: Record<string, { message: string }[]>;
}
interface Expected {
  children: Record<string, { prompt: string; retry: string; max_retries: number; timeout_ms: number }>;
  results: unknown[];
  restored: string[];
  files: Record<string, string | null>;
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/contentSectionEditCases.json', import.meta.url), 'utf8')) as { cases: Case[]; expected: Record<string, Expected> };

type Child = (input: AgentChildPromptInput, store: Map<string, Buffer>) => Promise<AgentChildPromptOutcome> | AgentChildPromptOutcome;
const SESSION = '2026-11-27T10-00-00-000Z_01a1e18b-3a01-73ab-8e86-dcac529abd40.jsonl';
const done = (fields: Partial<AgentChildPromptOutcome> = {}): AgentChildPromptOutcome => ({ status: 'completed', session: SESSION, turns: 2, reason: null, ...fields });

function memoryRun(files: Record<string, string>, child: Child) {
  const store = new Map<string, Buffer>(Object.entries(files).map(([path, data]) => [path, Buffer.from(data, 'utf8')]));
  const prompts: AgentChildPromptInput[] = [];
  const writes: string[][] = [];
  const removes: string[][] = [];
  const run: EditContentSectionsOptions['run'] = {
    async readFiles(paths, limits = {}): Promise<ReadonlyMap<string, AgentWorkspaceFile>> {
      return new Map(paths.filter((path) => store.has(path)).map((path) => {
        const data = store.get(path)!;
        return [path, { size: data.length, data: data.length <= (limits.maxFileBytes ?? Infinity) ? data : null }];
      }));
    },
    async writeFiles(list) {
      writes.push(list.map((file) => file.path));
      for (const file of list) store.set(file.path, file.data);
    },
    async removeFiles(paths) {
      removes.push([...paths]);
      for (const path of paths) store.delete(path);
    },
    async childPrompt(input) {
      prompts.push(input);
      return child(input, store);
    },
  };
  return { run, store, prompts, writes, removes };
}

const fileOf = (prompt: string, targets: readonly ContentSubmissionTarget[]) => targets.find((target) => prompt.includes(`文件为 ${target.file}。`)) ?? targets.find((target) => prompt.includes(`继续处理 ${target.file}，`))!;

function options(item: Case, run: EditContentSectionsOptions['run'], extra: Partial<EditContentSectionsOptions> = {}): EditContentSectionsOptions {
  return {
    run,
    jobs: item.jobs,
    targets: new Map(item.targets.map((target) => [target.id, target])),
    activity: createContentSectionEditActivity(),
    factsRequirements: item.factsRequirements,
    rules: item.rules,
    title: item.title,
    instructions: item.instructions,
    preserveDataTables: item.preserveDataTables,
    preloadInput: item.preloadInput,
    inspect: async (section) => ({ issues: item.issues[section.id] ?? [], facts: { section: section.id } }),
    signal: new AbortController().signal,
    ...extra,
  };
}

describe('与桌面版 editContentSections 相同', () => {
  it.each(fixture.cases.map((item) => [item.name, item] as const))('%s', async (name, item) => {
    const expected = fixture.expected[name]!;
    const { run, store, prompts } = memoryRun(item.files, (input, files) => {
      const section = fileOf(input.prompt, item.targets);
      const script = item.children[section.id] ?? {};
      for (const [path, content] of Object.entries(script.write ?? {})) files.set(path, Buffer.from(content, 'utf8'));
      return script.fail ? done({ status: 'reported', reason: script.fail }) : done();
    });
    const results: unknown[] = [];
    const outcome = await editContentSections(options(item, run, { onResult: (result) => results.push(result) }));
    expect(outcome.results).toEqual(expected.results);
    expect(outcome.restored).toEqual(expected.restored);
    for (const [path, content] of Object.entries(expected.files)) expect(store.get(path)?.toString('utf8') ?? null).toBe(content);
    // 子任务的提示词与续接说明逐字相同；设置（重试 1 次、墙钟 30 分钟）见 execution.ts 的默认值。
    for (const [id, child] of Object.entries(expected.children)) {
      const section = item.targets.find((target) => target.id === id)!;
      expect(prompts.find((input) => fileOf(input.prompt, item.targets).id === id)?.prompt).toBe(child.prompt);
      expect(contentSectionEditRetryPrompt(section, '模型调用失败', 1, child.max_retries)).toBe(child.retry);
      expect(child).toMatchObject({ max_retries: 1, timeout_ms: 30 * 60_000 });
    }
    // 只有成功检查过的小节才回调。
    expect(results).toEqual(expected.results.filter((result) => (result as { facts?: unknown }).facts !== undefined));
  });
});

const BASE = fixture.cases[0]!;

describe('执行重试与结束方式', () => {
  it('模型调用失败：在同一子会话中续接一次（说明与桌面版相同），仍失败时本节失败；没有会话文件时重新发出本节任务', async () => {
    const seen: Array<{ session: string | null | undefined; retry: boolean }> = [];
    const { run } = memoryRun(BASE.files, (input) => {
      const section = fileOf(input.prompt, BASE.targets);
      seen.push({ session: input.session, retry: input.prompt.startsWith('上一轮小节编辑执行中断') });
      if (section.id === 's1') return seen.filter((item) => item.retry).length ? done() : done({ status: 'model-failed', reason: '模型调用失败' });
      return done({ status: 'model-failed', session: null, reason: '连接平台服务失败' });
    });
    const outcome = await editContentSections(options(BASE, run));
    expect(outcome.results).toEqual([
      { section_id: 's1', status: 'success', facts: { section: 's1' } },
      { section_id: 's2', status: 'error', error: '连接平台服务失败' },
    ]);
    // s1：先新建，再在同一会话中续接；s2：没有会话文件，重新发出本节任务（不是续接说明），再失败即本节失败。
    expect(seen.filter((item) => item.retry)).toEqual([{ session: SESSION, retry: true }]);
    expect(seen.filter((item) => !item.retry && item.session == null)).toHaveLength(3);
  });

  it.each([
    [{ status: 'turn-limit' } as const, '子代理在一次任务提示后已连续执行 100 轮仍未结束，已停止本次子任务'],
    [{ status: 'time-limit' } as const, '子任务执行超过 30 分钟，已停止本次子任务'],
    [{ status: 'session-invalid' } as const, '子任务的会话不可用，已停止本次子任务'],
    [{ status: 'reported', reason: '无法继续' } as const, '无法继续'],
  ])('%o：不续接，本节失败', async (end, message) => {
    const { run, prompts } = memoryRun(BASE.files, () => done(end));
    const outcome = await editContentSections(options(BASE, run, { jobs: BASE.jobs.slice(0, 1) }));
    expect(outcome.results).toEqual([{ section_id: 's1', status: 'error', error: message }]);
    expect(prompts).toHaveLength(1);
  });

  it('预先提供正文时本节文件不存在或过大：本节失败，不启动子会话', async () => {
    const files = { ...BASE.files, '正文/s2.html': 'x'.repeat(8 * 1024 * 1024 + 1) };
    delete (files as Record<string, string>)['正文/s1.html'];
    const { run, prompts } = memoryRun(files, () => done());
    const outcome = await editContentSections(options(BASE, run));
    expect(outcome.results).toEqual([
      { section_id: 's1', status: 'error', error: '小节 HTML 文件不存在' },
      { section_id: 's2', status: 'error', error: '小节 HTML 文件过大，无法读取' },
    ]);
    expect(prompts).toHaveLength(0);
  });
});

describe('批次与并发', () => {
  it('非本轮目标、重复的小节被拒绝；同一小节不能被两批同时编辑，不同小节可以并发，结束后可以再次编辑', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { run } = memoryRun(BASE.files, async () => {
      await gate;
      return done();
    });
    const activity = createContentSectionEditActivity();
    await expect(editContentSections(options(BASE, run, { activity, jobs: [{ section_id: 'x', instructions: '' }] }))).rejects.toBeInstanceOf(AgentToolRequestRejection);
    await expect(editContentSections(options(BASE, run, { activity, jobs: [BASE.jobs[0]!, BASE.jobs[0]!] }))).rejects.toThrow('只能编辑本次目标小节');
    const first = editContentSections(options(BASE, run, { activity, jobs: [BASE.jobs[0]!] }));
    await new Promise((resolve) => setImmediate(resolve));
    expect([...activity.editing]).toEqual(['s1']);
    await expect(editContentSections(options(BASE, run, { activity, jobs: [BASE.jobs[0]!] }))).rejects.toThrow('以下小节正在其他批次中编辑，请等待结束后再提交：s1');
    const second = editContentSections(options(BASE, run, { activity, jobs: [BASE.jobs[1]!] }));
    release();
    await Promise.all([first, second]);
    expect(activity.editing.size).toBe(0);
    expect(activity.running.size).toBe(0);
    await expect(editContentSections(options(BASE, run, { activity, jobs: [BASE.jobs[0]!] }))).resolves.toBeDefined();
  });

  it('两批并发：各自修改的小节都保留，互不当作“本批以外被改动”还原；本批以外的仍被还原', async () => {
    const gates = new Map<string, () => void>();
    const { run, store } = memoryRun(BASE.files, async (input, files) => {
      const section = fileOf(input.prompt, BASE.targets);
      await new Promise<void>((resolve) => gates.set(section.id, resolve));
      files.set(section.file, Buffer.from(`${section.id} 修改后`));
      if (section.id === 's2') files.set('正文/s3.html', Buffer.from('被改动'));
      return done();
    });
    const activity = createContentSectionEditActivity();
    const first = editContentSections(options(BASE, run, { activity, jobs: [BASE.jobs[0]!] }));
    const second = editContentSections(options(BASE, run, { activity, jobs: [BASE.jobs[1]!] }));
    while (gates.size < 2) await new Promise((resolve) => setImmediate(resolve));
    // 第二批先结束：第一批正在编辑的 s1 不还原；第一批随后结束，s2 已不在编辑中，但它是期间另一批编辑的小节，也不还原（与桌面版的差异第 5 项）。
    gates.get('s2')!();
    const secondResult = await second;
    gates.get('s1')!();
    const firstResult = await first;
    expect(store.get('正文/s1.html')?.toString()).toBe('s1 修改后');
    expect(store.get('正文/s2.html')?.toString()).toBe('s2 修改后');
    expect(store.get('正文/s3.html')?.toString()).toBe(BASE.files['正文/s3.html']);
    expect(secondResult.restored).toEqual(['正文/s3.html']);
    expect(firstResult.restored).toEqual([]);
  });

  it('致命错误（如任务上限）：中止本批其余子会话后按原因抛出，编辑状态清除，不还原、不写入', async () => {
    const signals: AbortSignal[] = [];
    const { run, writes, removes } = memoryRun(BASE.files, async (input, files) => {
      signals.push(input.signal!);
      const section = fileOf(input.prompt, BASE.targets);
      if (section.id === 's1') {
        files.set('正文/s3.html', Buffer.from('被改动'));
        throw new JobTaskLimitError('task_turn_limit');
      }
      await new Promise((resolve) => input.signal!.addEventListener('abort', resolve, { once: true }));
      throw new Error('aborted');
    });
    const activity = createContentSectionEditActivity();
    await expect(editContentSections(options(BASE, run, { activity }))).rejects.toBeInstanceOf(JobTaskLimitError);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(activity.editing.size).toBe(0);
    expect(writes).toEqual([]);
    expect(removes).toEqual([]);
  });

  it('过大的小节不比较、不还原', async () => {
    const big = 'y'.repeat(8 * 1024 * 1024 + 1);
    const { run, store } = memoryRun({ ...BASE.files, '正文/s3.html': big }, (_input, files) => {
      files.set('正文/s3.html', Buffer.from('改小了'));
      return done();
    });
    const outcome = await editContentSections(options(BASE, run, { jobs: BASE.jobs.slice(0, 1) }));
    expect(outcome.restored).toEqual([]);
    expect(store.get('正文/s3.html')?.toString()).toBe('改小了');
  });
});
