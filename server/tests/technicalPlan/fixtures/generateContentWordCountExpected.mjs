// 生成 contentWordCountCases.json 的 expected：把每个输入放进临时工作区，执行桌面版 client/electron/services/contentGenerationWordTools.cjs
// 的 check-word-count（小节检查为 contentGenerationAgent.cjs 的 inspectSectionArtifact；cheerio 1.2.0、ajv 8.20.0，版本见
// client/package-lock.json），记下交给模型的结果、程序清单/正文字数统计.json 的内容、是否进入图片保护（setActiveTools 被调用）
// 或工具错误的说明。server/ 的测试不安装 cheerio，所以按桌面版的结果预先生成、随仓库提交（tests/technicalPlan/contentWordCount.test.ts
// 逐条核对）。
// 用法：先在 client/ 下 npm ci，再在仓库根目录运行 node server/tests/technicalPlan/fixtures/generateContentWordCountExpected.mjs。
// 桌面版模块引用的 electron 等与字数统计无关的依赖换成桩（与 generateContentSubmissionExpected.mjs 相同）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const { inspectSectionArtifact } = require('../../../../client/electron/services/contentGenerationAgent.cjs');
const { createContentGenerationWordTools } = require('../../../../client/electron/services/contentGenerationWordTools.cjs');
Module._load = original;

const WORDS_FILE = '程序清单/正文字数统计.json';
const casesFile = fileURLToPath(new URL('./contentWordCountCases.json', import.meta.url));
const data = JSON.parse(readFileSync(casesFile, 'utf8'));
data.expected = {};
for (const { name, targets, word_control: wordControl, files, images, dirs } of data.cases) {
  const workspace = mkdtempSync(join(tmpdir(), 'content-word-count-'));
  try {
    const write = (path, content) => {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), content, 'utf8');
    };
    write('正文编排决策.json', JSON.stringify({ targets, word_control: wordControl }));
    for (const [path, content] of Object.entries(files)) write(path, content);
    for (const path of images) write(path, 'PNG');
    for (const path of dirs) mkdirSync(join(workspace, path), { recursive: true });
    let protection = false;
    const tools = createContentGenerationWordTools(
      { activity: { pending: 0 }, inspectSection: (section, options) => inspectSectionArtifact(workspace, section, options) },
      { Type: { Object: () => ({}) }, workspaceDir: workspace, setActiveTools: () => { protection = true; } },
    );
    const tool = tools.find((item) => item.name === 'check-word-count');
    const listFile = () => (existsSync(join(workspace, WORDS_FILE)) ? readFileSync(join(workspace, WORDS_FILE), 'utf8') : null);
    try {
      const result = await tool.execute();
      data.expected[name] = { result: JSON.parse(result.content[0].text), list_file: listFile(), protection };
    } catch (error) {
      data.expected[name] = { error: error.message, list_file: listFile(), protection };
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
writeFileSync(casesFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
