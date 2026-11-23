// render-layout 沙箱的入口（路线图第 8 步 8.8c）。由 sandbox-runner 按 render-layout 模板执行：node /opt/render-layout/entry.mjs，
// 不接受参数。输入由 worker 经 copyIn 放进 /work，只有 document.docx（≤ 100 MiB）。
// 成功时写 /output/layout.json（版式 JSON，≤ 16 MiB，结构见 layoutProjection.mjs），标准输出最后一行 {"ok":true}，退出码 0。
// 失败时 /output 为空，在标准输出最后一行写 {"error":"代码"}，退出码 65（参数不合法 64）：
//   request_invalid（输入不合法）/ document_invalid（docx-editor 无法打开）/ layout_timeout / layout_failed / output_too_large / browser_failed。
// 本进程没有网络、没有凭据；输出在 worker 中按不可信输入校验（src/render/wordLayout.ts）。
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CHROMIUM_EXECUTABLE, checkDocx, LAUNCH_ARGS, loadPageScript, MAX_DOCX_BYTES, measureLayout, RenderLayoutError } from './wordLayout.mjs';

const WORK = '/work';
const OUTPUT = '/output';
const INPUT_NAME = 'document.docx';
const LAYOUT_NAME = 'layout.json';
const LAUNCH_TIMEOUT_MS = 20_000;

function fail(code, exitCode) {
  process.stdout.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(exitCode);
}

/** /work 中正好只有 document.docx（普通文件、不超过上限、是 ZIP）。 */
async function readDocument() {
  const names = await readdir(WORK);
  if (names.length !== 1 || names[0] !== INPUT_NAME) throw new RenderLayoutError('request_invalid');
  const info = await lstat(`${WORK}/${INPUT_NAME}`);
  if (!info.isFile() || info.size > MAX_DOCX_BYTES) throw new RenderLayoutError('request_invalid');
  return checkDocx(await readFile(`${WORK}/${INPUT_NAME}`));
}

async function launchBrowser() {
  try {
    return await chromium.launch({
      executablePath: CHROMIUM_EXECUTABLE,
      headless: true,
      args: [...LAUNCH_ARGS],
      // 不把入口进程的环境变量传给浏览器。
      env: { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' },
      timeout: LAUNCH_TIMEOUT_MS,
    });
  } catch {
    throw new RenderLayoutError('browser_failed');
  }
}

async function main() {
  if (process.argv.length !== 2) fail('bad_arguments', 64);
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
  let browser;
  let code = null;
  try {
    if ((await readdir(OUTPUT)).length > 0) throw new RenderLayoutError('request_invalid');
    const docx = await readDocument();
    const pageScript = await loadPageScript();
    browser = await launchBrowser();
    const layout = await measureLayout(browser, pageScript, docx);
    await writeFile(`${OUTPUT}/${LAYOUT_NAME}`, layout);
  } catch (error) {
    // 失败时不留下部分输出。
    await rm(`${OUTPUT}/${LAYOUT_NAME}`, { force: true }).catch(() => {});
    code = error instanceof RenderLayoutError ? error.code : 'layout_failed';
  } finally {
    await browser?.close().catch(() => {});
  }
  if (code) fail(code, 65);
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

await main();
