// 业务工具 check-word-count（src/technicalPlan/contentWordCount.ts，路线图第 8 步 8.10c3b1）与图片保护的状态
// （src/technicalPlan/contentImageProtection.ts）。工作区换成内存中的替身（经 agent-gw 与真实数据库的长时调用见
// tests/db/agentToolRequests.test.ts）：
// - 交给模型的结果、程序清单/正文字数统计.json 的内容、是否进入图片保护、工具错误的说明与桌面版逐个相同（20 个工作区输入；桌面版的
//   结果由 fixtures/generateContentWordCountExpected.mjs 用桌面版 cheerio 1.2.0 预先生成并提交）；
// - Web 版另加的受限 HTML 检查同样拦住进入保护；读取过大的小节、合计上限之外的小节下一轮再读；
// - 进入保护后 generate-sections 交回 Agent；保护状态的保存与解析。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentWorkspaceFile } from '../../src/agent/execution.ts';
import { AGENT_READ_TOTAL_MAX_BYTES } from '../../src/agent/execution.ts';
import { AgentToolRequestRejection } from '../../src/agent/toolRequests.ts';
import { createContentImageProtection, parseContentImageProtectionState } from '../../src/technicalPlan/contentImageProtection.ts';
import { createGenerateSectionsExecutor, GENERATE_SECTIONS_TOOL } from '../../src/technicalPlan/contentSectionGeneration.ts';
import type { ContentSubmissionTarget } from '../../src/technicalPlan/contentSubmission.ts';
import {
  CHECK_WORD_COUNT_TOOL,
  CHECK_WORD_COUNT_TOOL_OPTIONS,
  checkWordCountTool,
  CONTENT_SECTION_READ_MAX_BYTES,
  CONTENT_WORD_COUNT_FILE,
  contentWordCount,
  createCheckWordCountExecutor,
  readContentSectionFiles,
  WORD_COUNT_ONLY_NOTE,
  type ContentWordCountControl,
} from '../../src/technicalPlan/contentWordCount.ts';
import { MATERIALS } from './generateSectionsFixture.ts';

interface WordCountCase {
  name: string;
  targets: ContentSubmissionTarget[];
  word_control: ContentWordCountControl;
  files: Record<string, string>;
  images: string[];
  dirs: string[];
}
interface WordCountExpected {
  result?: Record<string, unknown>;
  error?: string;
  list_file: string | null;
  protection: boolean;
}
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/contentWordCountCases.json', import.meta.url), 'utf8')) as {
  cases: WordCountCase[];
  expected: Record<string, WordCountExpected>;
};

/** 内存中的工作区：只有文件（目录不在读取结果中，与 sandbox-runner 的归档相同）；readFiles 的上限与执行者相同。 */
function memoryRun(files: Record<string, string | Buffer>) {
  const store = new Map(Object.entries(files).map(([path, data]) => [path, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')]));
  const reads: { paths: string[]; maxFileBytes?: number; maxTotalBytes?: number }[] = [];
  const writes: { path: string; data: Buffer }[][] = [];
  return {
    store,
    reads,
    writes,
    async readFiles(paths: readonly string[], limits: { maxFileBytes?: number; maxTotalBytes?: number } = {}): Promise<ReadonlyMap<string, AgentWorkspaceFile>> {
      reads.push({ paths: [...paths], ...limits });
      const result = new Map<string, AgentWorkspaceFile>();
      let total = 0;
      for (const path of paths) {
        const data = store.get(path);
        if (!data) continue;
        const keep = data.length <= (limits.maxFileBytes ?? Infinity) && total + data.length <= (limits.maxTotalBytes ?? Infinity);
        if (keep) total += data.length;
        result.set(path, { size: data.length, data: keep ? data : null });
      }
      return result;
    },
    async writeFiles(list: readonly { path: string; data: Buffer }[]): Promise<void> {
      writes.push([...list]);
      for (const file of list) store.set(file.path, file.data);
    },
  };
}

const caseRun = (item: WordCountCase) => memoryRun({ ...item.files, ...Object.fromEntries(item.images.map((path) => [path, 'PNG'])) });

async function execute(options: Parameters<typeof createCheckWordCountExecutor>[0]): Promise<unknown> {
  return createCheckWordCountExecutor(options)({ requestId: 'r', args: {}, signal: new AbortController().signal });
}

describe('check-word-count 与桌面版逐个相同', () => {
  it.each(FIXTURE.cases.map((item) => [item.name, item] as const))('%s', async (_name, item) => {
    const expected = FIXTURE.expected[item.name]!;
    const run = caseRun(item);
    const protection = createContentImageProtection();
    const outcome = execute({ run, targets: item.targets, wordControl: item.word_control, protection });
    if (expected.error !== undefined) {
      const error = await outcome.then(
        () => null,
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(AgentToolRequestRejection);
      // 与桌面版相同的问题在前；Web 版另加的受限 HTML 检查的问题在后（入库规则，桌面版没有）。
      const message = (error as Error).message;
      const extra = message.slice(expected.error.length);
      expect(message.startsWith(expected.error)).toBe(true);
      expect(extra).toMatch(/^(；不符合受限 HTML 规范：[^；]+)*$/);
      if (item.name === '配图引用越出工作区') expect(extra).not.toBe('');
    } else {
      expect(await outcome).toEqual(expected.result);
    }
    const listFile = run.store.get(CONTENT_WORD_COUNT_FILE);
    expect(listFile === undefined ? null : listFile.toString('utf8')).toBe(expected.list_file);
    expect(protection.active).toBe(expected.protection);
  });

  it('覆盖了各种情形（进入保护、未就绪、各类问题）', () => {
    const values = Object.values(FIXTURE.expected);
    expect(values.filter((value) => value.protection)).toHaveLength(9);
    expect(values.filter((value) => value.result?.complete === false)).toHaveLength(4);
    expect(values.filter((value) => value.error !== undefined)).toHaveLength(7);
    // 交给模型的结果中没有差额、方向与是否达标；说明与桌面版相同。
    for (const value of values) {
      if (!value.result) continue;
      expect(Object.keys(value.result)).toEqual(['complete', 'total_words', 'minimum_words', 'maximum_words', 'check_total_words', 'section_count', 'missing_count', 'detail_file', 'note']);
      expect(value.result.note).toBe(WORD_COUNT_ONLY_NOTE);
    }
  });
});

const TARGETS: ContentSubmissionTarget[] = [
  { id: 'n-1', number: '1.1', title: '施工组织', file: '正文/n-1.html' },
  { id: 'n-2', number: '1.2', title: '质量保证', file: '正文/n-2.html' },
];
const CONTROL: ContentWordCountControl = { minimumWords: 10, maximumWords: 1000, checkTotalWords: true };
const OK = '<!-- app:block -->\n<p id="s_p001">本节说明施工组织安排。</p>';

describe('check-word-count 的 Web 版规则', () => {
  it('不符合受限 HTML 规范的正文（桌面版放行）同样不能进入保护，不写清单', async () => {
    const run = memoryRun({ [TARGETS[0]!.file]: OK, [TARGETS[1]!.file]: '<!-- app:block -->\n<p>缺少块 id 的段落。</p>' });
    const protection = createContentImageProtection();
    await expect(execute({ run, targets: TARGETS, wordControl: CONTROL, protection })).rejects.toThrow(/^正文\/n-2\.html：不符合受限 HTML 规范：/);
    expect(protection.active).toBe(false);
    expect(run.writes).toEqual([]);
  });

  it('链接、内联样式等 warning 级的清洗不拦截', async () => {
    const html = '<!-- app:block -->\n<p id="s_p001" style="color:red">本节说明<a href="https://example.com">施工组织</a>安排。</p>';
    const protection = createContentImageProtection();
    await execute({ run: memoryRun({ [TARGETS[0]!.file]: html, [TARGETS[1]!.file]: OK }), targets: TARGETS, wordControl: CONTROL, protection });
    expect(protection.active).toBe(true);
  });

  it('过大的小节按“无法读取”，字数为 0、记为缺失，不进入保护', async () => {
    const big = Buffer.alloc(CONTENT_SECTION_READ_MAX_BYTES + 1, 0x61);
    const run = memoryRun({ [TARGETS[0]!.file]: OK, [TARGETS[1]!.file]: big });
    const protection = createContentImageProtection();
    const result = (await execute({ run, targets: TARGETS, wordControl: CONTROL, protection })) as Record<string, unknown>;
    expect(result).toMatchObject({ complete: false, section_count: 1, missing_count: 1 });
    expect(JSON.parse(run.store.get(CONTENT_WORD_COUNT_FILE)!.toString('utf8')).missing_section_ids).toEqual(['n-2']);
    expect(protection.active).toBe(false);
  });

  it('合计上限之外的小节下一轮再读，每节都读到；图片只确认存在、不读内容', async () => {
    const size = 7 * 1024 * 1024;
    const filler = (n: number) => `<!-- app:block -->\n<p id="s_p001">第 ${n} 节正文。</p><!--${'x'.repeat(size)}-->`;
    const targets = Array.from({ length: 12 }, (_, index) => ({ id: `n-${index}`, number: `1.${index}`, title: `第 ${index} 节`, file: `正文/n-${index}.html` }));
    const run = memoryRun(Object.fromEntries(targets.map((target, index) => [target.file, filler(index)])));
    const { files } = await readContentSectionFiles(run, targets);
    expect([...files.values()].every((file) => file.data !== null)).toBe(true);
    expect(files.size).toBe(12);
    // 12 × 7 MiB 超过一次 64 MiB 的合计上限：分两轮读。
    expect(run.reads).toHaveLength(2);
    expect(run.reads.every((read) => read.maxTotalBytes === AGENT_READ_TOTAL_MAX_BYTES && read.maxFileBytes === CONTENT_SECTION_READ_MAX_BYTES)).toBe(true);

    const withImage = memoryRun({
      [TARGETS[0]!.file]: `${OK}\n<!-- app:block -->\n<figure id="f1" data-app-generation="aiImage" data-app-size="wide"><img alt="图" data-app-asset-ref="图片/a.png"><figcaption>图 1</figcaption></figure>`,
      '图片/a.png': 'PNG',
    });
    const read = await readContentSectionFiles(withImage, TARGETS);
    expect([...read.existingImages]).toEqual(['图片/a.png']);
    expect(withImage.reads.at(-1)).toEqual({ paths: ['图片/a.png'], maxFileBytes: 0, maxTotalBytes: 0 });
  }, 60_000);

  it('再次调用（已进入保护）照常统计，保护不变', async () => {
    const run = memoryRun({ [TARGETS[0]!.file]: OK, [TARGETS[1]!.file]: OK });
    const protection = createContentImageProtection({ active: true });
    await execute({ run, targets: TARGETS, wordControl: CONTROL, protection });
    expect(protection.active).toBe(true);
    expect(run.writes).toHaveLength(1);
  });

  it('字数的差额与方向（与桌面版 checkWordCount 相同；只用于程序校正，不交给模型）', () => {
    const words = (values: number[]) => new Map(values.map((value, index) => [TARGETS[index]!.id, value]));
    expect(contentWordCount(TARGETS, words([5, 3]), { minimumWords: 10, maximumWords: 20, checkTotalWords: true })).toMatchObject({ difference: 2, direction: 'expand', in_range: false });
    expect(contentWordCount(TARGETS, words([15, 10]), { minimumWords: 10, maximumWords: 20, checkTotalWords: true })).toMatchObject({ difference: 5, direction: 'shrink', in_range: false });
    expect(contentWordCount(TARGETS, words([15, 10]), { minimumWords: 10, maximumWords: 20, checkTotalWords: false })).toMatchObject({ difference: 0, direction: 'none', in_range: true });
    expect(contentWordCount(TARGETS, words([15, 0]), { minimumWords: 0, maximumWords: 0, checkTotalWords: true })).toMatchObject({ complete: false, in_range: false, missing_section_ids: ['n-2'] });
  });

  it('内部入口一侧：长时工具，参数为空对象、不接受多余的键', () => {
    expect(checkWordCountTool.name).toBe(CHECK_WORD_COUNT_TOOL);
    expect(CHECK_WORD_COUNT_TOOL_OPTIONS.argumentsSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });
});

describe('图片保护', () => {
  it('进入保护后 generate-sections 交回 Agent（桌面版 beforeToolCall 的说明），不读取任务文件', async () => {
    const protection = createContentImageProtection();
    const run = memoryRun({});
    const ai = { chat: async () => { throw new Error('不应调用模型'); } };
    const executor = createGenerateSectionsExecutor({ run, ai: ai as never, model: { provider: 'deepseek', model: 'deepseek-chat' } as never, materials: MATERIALS, protection });
    protection.enter();
    await expect(executor.execute({ requestId: 'r', args: {}, signal: new AbortController().signal })).rejects.toEqual(
      new AgentToolRequestRejection(`正文编辑期间不能调用 ${GENERATE_SECTIONS_TOOL}，请只调整文字并保留图片。`),
    );
    expect(run.reads).toEqual([]);
  });

  it('状态随 checkpoint 保存，续跑时传回；不合法的状态是程序错误', () => {
    const protection = createContentImageProtection();
    expect(protection.state()).toEqual({ active: false });
    expect(() => protection.assertToolAllowed('x')).not.toThrow();
    protection.enter();
    protection.enter();
    expect(protection.state()).toEqual({ active: true });
    expect(createContentImageProtection(protection.state()).active).toBe(true);
    expect(parseContentImageProtectionState(null)).toEqual({ active: false });
    for (const bad of [{}, { active: 1 }, { active: true, extra: 1 }, [], 'x']) expect(() => parseContentImageProtectionState(bad)).toThrow(TypeError);
  });
});
