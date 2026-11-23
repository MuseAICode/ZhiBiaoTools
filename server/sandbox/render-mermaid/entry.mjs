// render-mermaid 沙箱的入口（路线图第 8 步 8.8b）。由 sandbox-runner 按 render-mermaid 模板执行：node /opt/render-mermaid/entry.mjs，
// 不接受参数。输入由 worker 经 copyIn 放进 /work，只有 request.json：
//   { version: 1, items: [{ id, code }] }（见 mermaidImage.mjs 的 parseRenderMermaidRequest）
// 每段转成 /output/<id>.png，结果写 /output/result.json：
//   { version: 1, items: [{ id, status: 'rendered', width, height } | { id, status: 'failed', error } | { id, status: 'failed', error: 'diagram_invalid', message }] }
// 单段失败（render_timeout / render_failed / output_too_large / diagram_invalid）不影响其他段，与桌面版逐张转图、逐张报告相同；
// 整批的时限到了，剩下的段记为 render_timeout。浏览器进程退出（例如超出沙箱的内存上限被结束）时，下一段重新启动浏览器。
// 请求不合法、浏览器启动失败时 /output 为空，在标准输出最后一行写 {"error":"代码"}，退出码 65（参数不合法 64）。
// 只把 PNG 交出沙箱，Mermaid 生成的 SVG 不写入任何文件。本进程没有网络、没有凭据；输出在 worker 中按不可信输入校验
// （src/render/mermaidImages.ts）。
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CHROMIUM_EXECUTABLE, ITEM_TIMEOUT_MS, LAUNCH_ARGS, loadPageAssets, parseRenderMermaidRequest, renderMermaidImage, RenderMermaidError } from './mermaidImage.mjs';

const WORK = '/work';
const OUTPUT = '/output';
/** request.json 的上限：源码合计 1 MiB，JSON 转义后至多约 6 倍，另加字段。 */
const MAX_REQUEST_BYTES = 6 * 1024 * 1024 + 64 * 1024;
/** 整批的时限：比模板的命令墙钟（5 分钟）短，到时剩下的段记为超时，入口仍正常写出结果。 */
const BATCH_TIMEOUT_MS = 4 * 60_000 + 30_000;
const LAUNCH_TIMEOUT_MS = 20_000;

function fail(code, exitCode) {
  process.stdout.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(exitCode);
}

/** /work 中正好只有 request.json（普通文件、不超过上限）。 */
async function readRequest() {
  const names = await readdir(WORK);
  if (names.length !== 1 || names[0] !== 'request.json') throw new RenderMermaidError('request_invalid');
  const info = await lstat(`${WORK}/request.json`);
  if (!info.isFile() || info.size > MAX_REQUEST_BYTES) throw new RenderMermaidError('request_invalid');
  let raw;
  try {
    const data = await readFile(`${WORK}/request.json`);
    if (data.length > MAX_REQUEST_BYTES) throw new Error('too large');
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new RenderMermaidError('request_invalid');
  }
  return parseRenderMermaidRequest(raw);
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
    throw new RenderMermaidError('browser_failed');
  }
}

async function main() {
  if (process.argv.length !== 2) fail('bad_arguments', 64);
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
  const written = [];
  let browser;
  try {
    if ((await readdir(OUTPUT)).length > 0) throw new RenderMermaidError('request_invalid');
    const items = await readRequest();
    const assets = await loadPageAssets();
    browser = await launchBrowser();
    const batchDeadline = Date.now() + BATCH_TIMEOUT_MS;
    const results = [];
    let stuck = false;
    for (const item of items) {
      const remaining = batchDeadline - Date.now();
      if (remaining <= 0) {
        results.push({ id: item.id, status: 'failed', error: 'render_timeout' });
        continue;
      }
      try {
        // 上一段把浏览器进程耗尽（例如被内存上限结束）或上下文关不掉时，换一个浏览器（旧的不等它关闭）。
        if (stuck || !browser.isConnected()) {
          browser.close().catch(() => {});
          stuck = false;
          browser = await launchBrowser();
        }
        const image = await renderMermaidImage(browser, assets, item, {
          timeoutMs: Math.min(remaining, ITEM_TIMEOUT_MS),
          onStuck: () => {
            stuck = true;
          },
        });
        const path = `${OUTPUT}/${item.id}.png`;
        written.push(path);
        await writeFile(path, image.png);
        results.push({ id: item.id, status: 'rendered', width: image.width, height: image.height });
      } catch (error) {
        if (error instanceof RenderMermaidError && error.code === 'browser_failed') {
          results.push({ id: item.id, status: 'failed', error: 'render_failed' });
        } else if (error instanceof RenderMermaidError && error.code === 'diagram_invalid') {
          results.push({ id: item.id, status: 'failed', error: 'diagram_invalid', message: error.detail });
        } else {
          results.push({ id: item.id, status: 'failed', error: error instanceof RenderMermaidError ? error.code : 'render_failed' });
        }
      }
    }
    await writeFile(`${OUTPUT}/result.json`, `${JSON.stringify({ version: 1, items: results })}\n`);
  } catch (error) {
    // 失败时不留下部分输出。
    for (const path of [...written, `${OUTPUT}/result.json`]) await rm(path, { force: true }).catch(() => {});
    fail(error instanceof RenderMermaidError ? error.code : 'render_failed', 65);
  } finally {
    await browser?.close().catch(() => {});
  }
}

await main();

