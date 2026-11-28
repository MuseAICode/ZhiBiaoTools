// 生成 contentSubmissionFixCases.json 的 expected：把每个输入放进临时工作区，执行桌面版 contentGenerationAgent.cjs 的
// createContentGenerationTools 中的 fix-submission-issues（复查为桌面版的 sectionSubmissionIssues / inspectSectionArtifact，cheerio 1.2.0；
// 编辑为 contentGenerationEditTools.cjs 的 editContentSections，子任务用桩代替 agentService.runTask：记下提示词，再按用例改写文件或报告
// 失败），记下交给模型的结果、各节文件与子任务的提示词。另记下 formatImageBlocks 的两种输出。server/ 的测试不安装 cheerio，所以按桌面版
// 的结果预先生成、随仓库提交（tests/technicalPlan/contentSubmissionFix.test.ts 逐条核对）。
// 用法：先在 client/ 下 npm ci，再在仓库根目录运行 node server/tests/technicalPlan/fixtures/generateContentSubmissionFixExpected.mjs。
// 桌面版模块引用的 electron 等与本工具无关的依赖换成桩（与 generateContentSubmissionExpected.mjs 相同）。
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
const { createContentGenerationTools } = require('../../../../client/electron/services/contentGenerationAgent.cjs');
const { formatImageBlocks } = require('../../../../client/electron/services/contentGenerationEditTools.cjs');
Module._load = original;

const ISSUES_FILE = '程序清单/提交校验问题.json';
const casesFile = fileURLToPath(new URL('./contentSubmissionFixCases.json', import.meta.url));
const data = JSON.parse(readFileSync(casesFile, 'utf8'));
data.expected = {};
for (const item of data.cases) {
  const workspace = mkdtempSync(join(tmpdir(), 'content-submission-fix-'));
  try {
    const write = (path, content) => {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), content, 'utf8');
    };
    write('正文编排决策.json', JSON.stringify({ targets: item.targets, global_facts_requirements: item.factsRequirements }));
    write('受限HTML生成规范.md', item.rules);
    for (const [path, content] of Object.entries(item.files)) write(path, content);
    for (const path of item.images) write(path, 'PNG');
    if (item.issues) write(ISSUES_FILE, JSON.stringify(item.issues, null, 2));
    const prompts = {};
    const agentService = {
      async runTask(payload) {
        const id = item.targets.find((target) => payload.output_file === target.file).id;
        prompts[id] = payload.prompt;
        const script = item.children[id] ?? {};
        for (const [path, content] of Object.entries(script.write ?? {})) write(path, content);
        if (script.fail) throw new Error(script.fail);
        return {};
      },
    };
    const tool = createContentGenerationTools(
      { agentService, signal: new AbortController().signal },
      { Type: stub, workspaceDir: workspace, setActiveTools: () => {}, baseline: null },
    ).find((entry) => entry.name === 'fix-submission-issues');
    const files = () => Object.fromEntries(item.targets.map((target) => {
      try {
        return [target.file, readFileSync(join(workspace, target.file), 'utf8')];
      } catch {
        return [target.file, null];
      }
    }));
    try {
      const result = await tool.execute('call', {}, new AbortController().signal);
      data.expected[item.name] = { result: JSON.parse(result.content[0].text), prompts, files: files() };
    } catch (error) {
      data.expected[item.name] = { error: error.message, prompts, files: files() };
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
data.formatImageBlocks = {
  blocks: ['<figure id="s_f001"><img alt="a" data-app-asset-ref="图片/a.png"><figcaption>图 1</figcaption></figure>', '<img alt="b" data-app-asset-ref="图片/b.png">'],
};
data.formatImageBlocks.expected = { blocks: formatImageBlocks(data.formatImageBlocks.blocks), empty: formatImageBlocks([]) };
writeFileSync(casesFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
