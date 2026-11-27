// 生成 contentSectionEditCases.json 的 expected：把每个输入放进临时工作区，执行桌面版 client/electron/services/contentGenerationEditTools.cjs
// 的 editContentSections（子任务用桩代替 agentService.runTask：记下子任务的标题、提示词、工具、重试与时限设置，以“模型调用失败”调用
// buildRetryPrompt 记下续接说明，再按用例改写文件或报告失败），记下各节结果与还原的文件。server/ 的测试不安装 cheerio，所以按桌面版的
// 结果预先生成、随仓库提交（tests/technicalPlan/contentSectionEditing.test.ts 逐条核对）。
// 用法：先在 client/ 下 npm ci，再在仓库根目录运行 node server/tests/technicalPlan/fixtures/generateContentSectionEditExpected.mjs。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const STUBBED = new Set(['docx', 'electron', 'image-size', 'mime-types']);
const stub = new Proxy(function stubbed() {}, {
  get: (_target, key) => (key === Symbol.toPrimitive ? () => '' : stub),
  apply: () => stub,
  construct: () => stub,
});
const original = Module._load;
Module._load = function load(request, parent, isMain) {
  if (STUBBED.has(request)) return stub;
  return original.call(this, request, parent, isMain);
};
const { editContentSections } = require('../../../../client/electron/services/contentGenerationEditTools.cjs');
Module._load = original;

const casesFile = fileURLToPath(new URL('./contentSectionEditCases.json', import.meta.url));
const data = JSON.parse(readFileSync(casesFile, 'utf8'));
data.expected = {};
for (const item of data.cases) {
  const workspace = mkdtempSync(join(tmpdir(), 'content-section-edit-'));
  try {
    const write = (path, content) => {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), content, 'utf8');
    };
    for (const [path, content] of Object.entries(item.files)) write(path, content);
    write('正文编排决策.json', JSON.stringify({ global_facts_requirements: item.factsRequirements }));
    write('受限HTML生成规范.md', item.rules);
    const targets = new Map(item.targets.map((target) => [target.id, target]));
    const children = {};
    const agentService = {
      async runTask(payload) {
        const id = item.targets.find((target) => payload.output_file === target.file).id;
        const retry = await payload.buildRetryPrompt({ kind: 'execution', error: new Error('模型调用失败') }, { attempt: 1, max_retries: payload.max_retries });
        children[id] = {
          title: payload.title,
          prompt: payload.prompt,
          retry,
          active_tools: payload.active_tools,
          max_retries: payload.max_retries,
          timeout_ms: payload.timeout_ms,
          failure_handled_by_parent: payload.failure_handled_by_parent,
        };
        const script = item.children[id] ?? {};
        for (const [path, content] of Object.entries(script.write ?? {})) write(path, content);
        if (script.fail) throw new Error(script.fail);
        return {};
      },
    };
    const { results, restored } = await editContentSections({
      jobs: item.jobs,
      targets,
      workspaceDir: workspace,
      agentService,
      signal: new AbortController().signal,
      activity: { pending: 0 },
      inspectSection: (section) => ({ issues: item.issues[section.id] ?? [], facts: { section: section.id } }),
      title: item.title,
      instructions: item.instructions,
      preserveDataTables: item.preserveDataTables,
      preloadInput: item.preloadInput,
    });
    const after = Object.fromEntries(item.targets.map((target) => {
      try {
        return [target.file, readFileSync(join(workspace, target.file), 'utf8')];
      } catch {
        return [target.file, null];
      }
    }));
    data.expected[item.name] = { children, results, restored, files: after };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
writeFileSync(casesFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
