// 生成 contentSubmissionCases.json 的 expected：把每个输入放进临时工作区，用桌面版 client/electron/services/contentGenerationAgent.cjs 的
// inspectContentArtifacts（cheerio 1.2.0、ajv 8.20.0，版本见 client/package-lock.json）计算提交校验的结果清单与问题清单。server/ 的测试
// 不安装 cheerio，所以按桌面版的结果预先生成、随仓库提交（tests/technicalPlan/contentSubmission.test.ts 逐条核对）。
// 用法：先在 client/ 下 npm ci，再在仓库根目录运行 node server/tests/technicalPlan/fixtures/generateContentSubmissionExpected.mjs。
// 桌面版模块引用的 electron 等与提交校验无关的依赖换成桩（与 contentSectionWriting.test.ts 相同）。
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
const { inspectContentArtifacts } = require('../../../../client/electron/services/contentGenerationAgent.cjs');
Module._load = original;

const casesFile = fileURLToPath(new URL('./contentSubmissionCases.json', import.meta.url));
const data = JSON.parse(readFileSync(casesFile, 'utf8'));
data.expected = {};
for (const { name, targets, files, images, dirs } of data.cases) {
  const workspace = mkdtempSync(join(tmpdir(), 'content-submission-'));
  try {
    const write = (path, content) => {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), content, 'utf8');
    };
    write('正文编排决策.json', JSON.stringify({ targets }));
    for (const [path, content] of Object.entries(files)) write(path, content);
    for (const path of images) write(path, 'PNG');
    for (const path of dirs) mkdirSync(join(workspace, path), { recursive: true });
    const { result, issues } = inspectContentArtifacts(workspace);
    data.expected[name] = { sections: result.sections, issues };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
writeFileSync(casesFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
