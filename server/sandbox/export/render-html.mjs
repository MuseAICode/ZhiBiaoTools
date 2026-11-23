// render-html 沙箱的入口（路线图第 8 步 8.8a1；8.8a2 加图片转 PNG）。由 sandbox-runner 按 render-html 模板执行：
// node /opt/export/render-html.mjs，不接受参数。输入由 worker 经 copyIn 放进 /work：request.json，以及每个图片项一个 <id>.<format>：
//   { version: 1, items: [{ id, kind: 'html', html, frame_size, check_layout } | { id, kind: 'image', format }] }
//   见 htmlImage.mjs 的 parseRenderHtmlRequest；/work 中不能有多余或缺少的文件，图片每张至多 10 MiB、合计至多 64 MiB
// 每项转成 /output/<id>.png，结果写 /output/result.json：
//   { version: 1, items: [{ id, status: 'rendered', width, height, layout_issues } （HTML）| { id, status: 'rendered', width, height }（图片）
//                       | { id, status: 'failed', error }] }
// 单张失败（render_timeout / render_failed / output_too_large，图片另有 image_invalid）不影响其他图，与桌面版逐张转图、逐张报告相同；
// 整批的时限到了，剩下的图记为 render_timeout。
// 请求不合法、浏览器启动失败时 /output 为空，在标准输出最后一行写 {"error":"代码"}，退出码 65（参数不合法 64）。
// 错误只给代码，浏览器的错误文字不外传。本进程没有网络、没有凭据；输出在 worker 中按不可信输入校验（src/render/htmlImages.ts）。
import { createRequire } from 'node:module';
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CHROMIUM_EXECUTABLE, LAUNCH_ARGS } from './render.mjs';
import { ITEM_TIMEOUT_MS, MAX_PNG_BYTES, MAX_TOTAL_HTML_BYTES, parseRenderHtmlRequest, pngSize, renderHtmlImage, RenderHtmlError } from './htmlImage.mjs';
import { convertImage, ImageConvertError, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from './imageConvert.mjs';

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

/** 读 /work 中的一个普通文件；不是普通文件或超过 maxBytes 时抛 request_invalid。 */
async function readWorkFile(name, maxBytes) {
  const info = await lstat(`${WORK}/${name}`);
  if (!info.isFile() || info.size > maxBytes) throw new RenderHtmlError('request_invalid');
  const data = await readFile(`${WORK}/${name}`);
  if (data.length > maxBytes) throw new RenderHtmlError('request_invalid');
  return data;
}

/** 读请求与图片：/work 中正好是 request.json 与每个图片项的 <id>.<format>。图片项带上 bytes。 */
async function readRequest() {
  const names = new Set(await readdir(WORK));
  if (!names.has('request.json')) throw new RenderHtmlError('request_invalid');
  let raw;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readWorkFile('request.json', MAX_REQUEST_BYTES)));
  } catch {
    throw new RenderHtmlError('request_invalid');
  }
  const items = parseRenderHtmlRequest(raw);
  const expected = new Set(['request.json', ...items.filter((item) => item.kind === 'image').map((item) => `${item.id}.${item.format}`)]);
  if (names.size !== expected.size || [...names].some((name) => !expected.has(name))) throw new RenderHtmlError('request_invalid');
  let total = 0;
  for (const item of items) {
    if (item.kind !== 'image') continue;
    item.bytes = await readWorkFile(`${item.id}.${item.format}`, MAX_IMAGE_BYTES);
    total += item.bytes.length;
    if (item.bytes.length === 0 || total > MAX_TOTAL_IMAGE_BYTES) throw new RenderHtmlError('request_invalid');
  }
  return items;
}

/** 转一项：HTML 配图（8.8a1）或图片转 PNG（8.8a2）。返回结果项（不含 id、status）与 PNG。 */
async function renderItem(browser, item, timeoutMs) {
  if (item.kind === 'image') {
    const image = await convertImage(browser, item, item.bytes, { timeoutMs, maxPngBytes: MAX_PNG_BYTES, pngSize });
    return { png: image.png, fields: { width: image.width, height: image.height } };
  }
  const image = await renderHtmlImage(browser, layout, item, { timeoutMs });
  return { png: image.png, fields: { width: image.width, height: image.height, layout_issues: image.layoutIssues } };
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
          const { png, fields } = await renderItem(browser, item, Math.min(remaining, ITEM_TIMEOUT_MS));
          const path = `${OUTPUT}/${item.id}.png`;
          written.push(path);
          await writeFile(path, png);
          results.push({ id: item.id, status: 'rendered', ...fields });
        } catch (error) {
          const known = error instanceof RenderHtmlError || error instanceof ImageConvertError;
          results.push({ id: item.id, status: 'failed', error: known ? error.code : 'render_failed' });
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
