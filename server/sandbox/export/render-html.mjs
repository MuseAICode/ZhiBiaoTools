// render-html 沙箱的入口（路线图第 8 步 8.8a1）。由 sandbox-runner 按 render-html 模板执行：node /opt/export/render-html.mjs，
// 不接受参数。输入由 worker 经 copyIn 放进 /work，只有 request.json：
//   { version: 1, items: [{ id, html, frame_size, check_layout }] }   见 htmlImage.mjs 的 parseRenderHtmlRequest
// 每张图转成 /output/<id>.png，结果写 /output/result.json：
//   { version: 1, items: [{ id, status: 'rendered', width, height, layout_issues } | { id, status: 'failed', error }] }
// 单张失败（render_timeout / render_failed / output_too_large）不影响其他图，与桌面版逐张转图、逐张报告相同；整批的时限到了，
// 剩下的图记为 render_timeout。
// 请求不合法、浏览器启动失败时 /output 为空，在标准输出最后一行写 {"error":"代码"}，退出码 65（参数不合法 64）。
// 错误只给代码，浏览器的错误文字不外传。本进程没有网络、没有凭据；输出在 worker 中按不可信输入校验（src/render/htmlImages.ts）。
import { createRequire } from 'node:module';
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CHROMIUM_EXECUTABLE, LAUNCH_ARGS } from './render.mjs';
import { ITEM_TIMEOUT_MS, MAX_TOTAL_HTML_BYTES, parseRenderHtmlRequest, renderHtmlImage, RenderHtmlError } from './htmlImage.mjs';

const require = createRequire(import.meta.url);
/** 桌面版同一份的画布、页面与测量脚本（镜像构建时从 client/electron/shared 复制）。 */
const layout = require('/opt/export/desktop/electron/shared/htmlImageLayout.cjs');

const WORK = '/work';
const OUTPUT = '/output';
/** request.json 的上限：HTML 合计 16 MiB，JSON 转义后至多约 6 倍，另加字段。 */
const MAX_REQUEST_BYTES = 6 * MAX_TOTAL_HTML_BYTES + 64 * 1024;
/** 整批的时限：比模板的命令墙钟（5 分钟）短，到时剩下的图记为超时，入口仍正常写出结果。 */
const BATCH_TIMEOUT_MS = 4 * 60_000 + 30_000;
const LAUNCH_TIMEOUT_MS = 20_000;

function fail(code, exitCode) {
  process.stdout.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(exitCode);
}

async function readRequest() {
  const names = await readdir(WORK);
  if (names.length !== 1 || names[0] !== 'request.json') throw new RenderHtmlError('request_invalid');
  const info = await lstat(`${WORK}/request.json`);
  if (!info.isFile() || info.size > MAX_REQUEST_BYTES) throw new RenderHtmlError('request_invalid');
  let raw;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(`${WORK}/request.json`)));
  } catch {
    throw new RenderHtmlError('request_invalid');
  }
  return parseRenderHtmlRequest(raw);
}

async function main() {
  if (process.argv.length !== 2) fail('bad_arguments', 64);
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
  const written = [];
  try {
    if ((await readdir(OUTPUT)).length > 0) throw new RenderHtmlError('request_invalid');
    const items = await readRequest();
    let browser;
    try {
      browser = await chromium.launch({
        executablePath: CHROMIUM_EXECUTABLE,
        headless: true,
        args: [...LAUNCH_ARGS],
        // 不把入口进程的环境变量传给浏览器。
        env: { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' },
        timeout: LAUNCH_TIMEOUT_MS,
      });
    } catch {
      throw new RenderHtmlError('browser_failed');
    }
    const batchDeadline = Date.now() + BATCH_TIMEOUT_MS;
    const results = [];
    try {
      for (const item of items) {
        const remaining = batchDeadline - Date.now();
        if (remaining <= 0) {
          results.push({ id: item.id, status: 'failed', error: 'render_timeout' });
          continue;
        }
        try {
          const image = await renderHtmlImage(browser, layout, item, { timeoutMs: Math.min(remaining, ITEM_TIMEOUT_MS) });
          const path = `${OUTPUT}/${item.id}.png`;
          written.push(path);
          await writeFile(path, image.png);
          results.push({ id: item.id, status: 'rendered', width: image.width, height: image.height, layout_issues: image.layoutIssues });
        } catch (error) {
          results.push({ id: item.id, status: 'failed', error: error instanceof RenderHtmlError ? error.code : 'render_failed' });
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
    await writeFile(`${OUTPUT}/result.json`, `${JSON.stringify({ version: 1, items: results })}\n`);
  } catch (error) {
    // 失败时不留下部分输出。
    for (const path of [...written, `${OUTPUT}/result.json`]) await rm(path, { force: true }).catch(() => {});
    fail(error instanceof RenderHtmlError ? error.code : 'render_failed', 65);
  }
}

await main();
