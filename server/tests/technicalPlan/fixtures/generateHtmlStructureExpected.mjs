// 生成 htmlStructureCases.json 的 expected：用桌面版 client/electron/utils/htmlStructure.cjs（cheerio 1.2.0，版本见 client/package-lock.json）
// 对每个输入计算 findHtmlStructureIssues（两种 checkSourceCompleteness）、closeOpenTemplates 的结果。server/ 的测试不安装 cheerio，
// 所以按桌面版的结果预先生成、随仓库提交（tests/technicalPlan/htmlStructure.test.ts 逐条核对）。
// 用法：先在 client/ 下 npm ci，再在仓库根目录运行 node server/tests/technicalPlan/fixtures/generateHtmlStructureExpected.mjs。
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const casesFile = fileURLToPath(new URL('./htmlStructureCases.json', import.meta.url));
const { findHtmlStructureIssues, closeOpenTemplates } = require('../../../../client/electron/utils/htmlStructure.cjs');
const template = readFileSync(fileURLToPath(new URL('../../../../client/electron/resources/content-generation/正文模板.html', import.meta.url)), 'utf8');

const data = JSON.parse(readFileSync(casesFile, 'utf8'));
const inputs = [...data.cases, { name: '正文模板.html', html: template }];
data.expected = Object.fromEntries(inputs.map(({ name, html }) => [name, {
  issues: findHtmlStructureIssues(html),
  completeIssues: findHtmlStructureIssues(html, { checkSourceCompleteness: true }),
  closed: closeOpenTemplates(html),
}]));
writeFileSync(casesFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
