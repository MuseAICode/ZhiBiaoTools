// export 沙箱的导出入口（路线图第 7 步 7.1；docs/SERVER_DESIGN.md 第 7.9 节）。由 sandbox-runner 按 export 模板执行：
//   node /opt/export/entry.mjs preview     模板样张（export-preview 模板）
//   node /opt/export/entry.mjs document    整本导出（export-document 模板）
// 参数只有模式名，由模板写死，调用方不能追加。输入由 worker 经 copyIn 放进 /work：
//   request.json   { html: 受限 HTML, export_format: 已规范化的导出模板配置, asset_types?: { 引用: MIME } }
//   assets/…       配图（只有一层，文件名就是 data-app-asset-ref；worker 只放本项目可见的图片产物）
// 流程：校验输入 → 用与桌面版同一份的装饰生成器（/opt/export/chrome，构建时从 client/electron/shared/chrome 复制）
// 生成页眉页脚 SVG → Chromium 栅格化成 PNG（禁用 JavaScript，render.mjs）→ 运行 OpenXmlHelper 一次（--run）→
// 只把 document.docx 和 result.json 写到 /output：
//   result.json    { version: 1, blockCount, imageWarnings: [{ assetRef, reason }] }
// 整本导出（document）先把 WebP 配图转成 PNG（7.4i，见 convertWebpAssets）。
// 失败时 /output 为空，在标准输出最后一行写 {"error":"代码"}：参数不合法退出码 64，导出失败 65。
// 错误只给代码，助手和浏览器的错误文字不外传；给用户看的文案由 worker 按代码决定。
// 本进程没有网络、没有凭据；它的输出在 worker 中按不可信输入校验（src/sandbox/archive.ts）。
import { spawn } from 'node:child_process';
import { open, copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { buildChrome } from './chrome/index.mjs';
import { buildImageFrameHtml, rasterizeSvg, withRenderer } from './render.mjs';
import { inflateSync } from 'node:zlib';
import { isWebp, parseWebp, pngHasVisiblePixels } from './webp.mjs';

const MODES = Object.freeze({
  // 时限都比模板的命令墙钟（60 秒 / 20 分钟）短，超时由入口先结束助手并给出代码，而不是整个沙箱被终止。
  // convertWebp（7.4i）：整本导出把 WebP 配图转成 PNG（与桌面版 normalizeImageForDocx 一致）；样张的固定配图与桌面版相同，原样嵌入。
  preview: Object.freeze({ wholeDocument: false, helperTimeoutMs: 45_000, builtInAssets: true, convertWebp: false }),
  document: Object.freeze({ wholeDocument: true, helperTimeoutMs: 18 * 60_000, builtInAssets: false, convertWebp: true }),
});
const WORK = '/work';
const OUTPUT = '/output';
const HELPER = '/opt/openxmlhelper/openxmlhelper';
/** 助手的任务编号与任务目录（工作区为 /work，见 openxmlhelper/开发说明.md）。 */
const JOB_ID = 'export';
const JOB_DIR = `${WORK}/openxml-jobs/${JOB_ID}`;
const DOCX_NAME = 'document.docx';
/** 装饰 PNG 的目录（相对工作区，交给助手的 chrome_assets.root）。 */
const CHROME_ROOT = 'chrome';
const ASSET_ROOT = 'assets';
/** 镜像中的固定样张配图与它们在工作区中的位置（助手的 asset_root）。 */
const PREVIEW_ASSET_SOURCE = '/opt/export/preview-assets';
const PREVIEW_ROOT = 'preview';
/** request.json 的上限：整本导出的 HTML 不含图片（图片在 assets/ 中）。 */
const MAX_REQUEST_BYTES = 256 * 1024 * 1024;
/** 输出 docx 的上限（决定事项第 5 项），与 export 模板的取回上限相同。 */
const MAX_DOCX_BYTES = 100 * 1024 * 1024;
const MAX_ASSETS = 2_000;
/** 输入合计上限（request.json 与配图），与 export-document 模板的 input.maxTotalBytes 相同（7.4b）；WebP 转成 PNG 后重新按它检查（7.4i）。 */
const MAX_INPUT_TOTAL_BYTES = 128 * 1024 * 1024;
/** WebP 转换的工作目录（页面与静态帧），转换完成后删除。 */
const CONVERT_ROOT = 'webp-convert';
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIME = /^image\/[a-z0-9.+-]{1,64}$/;
const MAX_WARNINGS = MAX_ASSETS;
const MAX_REASON_CHARS = 200;

function fail(code, exitCode) {
  process.stdout.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(exitCode);
}

class ExportError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * /work 中只能有 request.json 和 assets/ 下的普通文件（copyIn 只放普通文件，这里再核对一次，防止与助手的目录冲突）。
 * 样张（builtInAssets）只能有 request.json，请求中也不能有 asset_types。
 */
async function readInput(mode) {
  const top = await readdir(WORK);
  for (const name of top) {
    if (name !== 'request.json' && (mode.builtInAssets || name !== ASSET_ROOT)) throw new ExportError('request_invalid');
  }
  const requestStat = await lstat(`${WORK}/request.json`).catch(() => null);
  if (!requestStat?.isFile() || requestStat.size > MAX_REQUEST_BYTES) throw new ExportError('request_invalid');
  const assets = new Set();
  if (top.includes(ASSET_ROOT)) {
    const assetStat = await lstat(`${WORK}/${ASSET_ROOT}`);
    if (!assetStat.isDirectory()) throw new ExportError('request_invalid');
    const names = await readdir(`${WORK}/${ASSET_ROOT}`);
    if (names.length > MAX_ASSETS) throw new ExportError('too_many_images');
    for (const name of names) {
      const entry = await lstat(`${WORK}/${ASSET_ROOT}/${name}`);
      if (!ASSET_NAME.test(name) || !entry.isFile()) throw new ExportError('request_invalid');
      assets.add(name);
    }
  } else {
    await mkdir(`${WORK}/${ASSET_ROOT}`);
  }

  let request;
  try {
    request = JSON.parse(await readFile(`${WORK}/request.json`, 'utf8'));
  } catch {
    throw new ExportError('request_invalid');
  }
  if (!isPlainObject(request) || typeof request.html !== 'string' || request.html.trim() === '' || !isPlainObject(request.export_format)) {
    throw new ExportError('request_invalid');
  }
  const assetTypes = {};
  if (request.asset_types !== undefined) {
    if (mode.builtInAssets || !isPlainObject(request.asset_types)) throw new ExportError('request_invalid');
    for (const [name, type] of Object.entries(request.asset_types)) {
      if (!assets.has(name) || typeof type !== 'string' || !MIME.test(type)) throw new ExportError('request_invalid');
      assetTypes[name] = type;
    }
  }
  return { html: request.html, exportFormat: request.export_format, assetTypes, assets: [...assets].sort() };
}

async function readHeader(path) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function inputTotalBytes(assets) {
  let total = (await stat(`${WORK}/request.json`)).size;
  for (const name of assets) {
    const entry = await stat(`${WORK}/${ASSET_ROOT}/${name}`).catch(() => null);
    if (entry) total += entry.size;
  }
  return total;
}

/**
 * 整本导出的 WebP 配图转成 PNG（7.4i，与桌面版 exportService.normalizeImageForDocx 一致：兼容不支持 WebP 的旧版 Word 与 WPS）。
 * 按文件头识别（不只看声明的类型）；动图取第一帧，放在画布中原来的位置，其余透明；由 Chromium（禁用 JavaScript）按原始像素
 * 栅格化成透明背景的 PNG，覆盖原文件，asset_types 改为 image/png。单张转换失败时删除该配图，由助手原位提示（与桌面版
 * 单张图片无法导出时相同）。每转一张都按转换后的大小重新计算输入合计，超过上限时整体失败（images_too_large），不再继续。
 */
async function convertWebpAssets(input) {
  const pending = [];
  for (const name of input.assets) {
    if (isWebp(await readHeader(`${WORK}/${ASSET_ROOT}/${name}`))) pending.push(name);
  }
  if (pending.length === 0) return;
  const root = `${WORK}/${CONVERT_ROOT}`;
  await mkdir(root);
  try {
    await withRenderer(async (renderer) => {
      for (const [index, name] of pending.entries()) {
        const path = `${WORK}/${ASSET_ROOT}/${name}`;
        let png = null;
        try {
          const image = parseWebp(await readFile(path));
          // 静态图直接引用原文件（Chromium 按内容识别格式），动图的首帧另存一份。
          let src = `../${ASSET_ROOT}/${name}`;
          if (image.animated) {
            src = `frame-${index}.webp`;
            await writeFile(`${root}/${src}`, image.frame.data);
          }
          const page = `${root}/frame-${index}.html`;
          await writeFile(page, buildImageFrameHtml({
            src,
            width: image.width,
            height: image.height,
            x: image.frame.x,
            y: image.frame.y,
            frameWidth: image.frame.width,
            frameHeight: image.frame.height,
          }));
          png = await renderer.renderFileToTransparentPng({ url: `file://${page}`, width: image.width, height: image.height });
          // 解码失败时截图全透明：按转换失败处理。
          if (!pngHasVisiblePixels(png, inflateSync)) png = null;
        } catch {
          png = null;
        }
        if (png) {
          // 转换后的大小重新计入输入合计：超过上限时整体失败，不写入。
          const before = (await stat(path)).size;
          if ((await inputTotalBytes(input.assets)) - before + png.length > MAX_INPUT_TOTAL_BYTES) throw new ExportError('images_too_large');
          await writeFile(path, png);
          input.assetTypes[name] = 'image/png';
        } else {
          await rm(path, { force: true });
          delete input.assetTypes[name];
        }
        await rm(`${root}/frame-${index}.webp`, { force: true });
      }
    });
  } catch (error) {
    throw error instanceof ExportError ? error : new ExportError('export_failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 把镜像中的固定样张配图复制到 /work/preview/assets/，返回助手的 asset_root。只复制普通文件，名称按配图规则核对。 */
async function prepareBuiltInAssets() {
  const target = `${WORK}/${PREVIEW_ROOT}/${ASSET_ROOT}`;
  await mkdir(target, { recursive: true });
  for (const name of await readdir(PREVIEW_ASSET_SOURCE)) {
    const entry = await lstat(`${PREVIEW_ASSET_SOURCE}/${name}`);
    if (!ASSET_NAME.test(name) || !entry.isFile()) throw new ExportError('export_failed');
    await copyFile(`${PREVIEW_ASSET_SOURCE}/${name}`, `${target}/${name}`);
  }
  return PREVIEW_ROOT;
}

/** 页眉页脚装饰：与桌面版 chromeAssetService.buildChromeAssets 相同的几何与文字层，PNG 写到 /work/chrome。 */
async function buildChromeAssets(page) {
  let chrome;
  try {
    chrome = buildChrome(isPlainObject(page) ? page : {});
  } catch {
    throw new ExportError('request_invalid');
  }
  const result = { root: CHROME_ROOT, header: null, footer: null, layout: chrome.layout, textLayout: chrome.textLayout };
  const pending = [
    ['header', chrome.headerSvg, chrome.layout.headerHeightCm],
    ['footer', chrome.footerSvg, chrome.layout.footerHeightCm],
  ].filter(([, svg, heightCm]) => svg && heightCm > 0);
  if (pending.length === 0) return result;

  await mkdir(`${WORK}/${CHROME_ROOT}`);
  try {
    await withRenderer(async (renderer) => {
      for (const [tag, svg, heightCm] of pending) {
        const png = await rasterizeSvg(renderer, svg, chrome.layout.widthCm, heightCm);
        await writeFile(`${WORK}/${CHROME_ROOT}/${tag}.png`, png);
        result[tag] = `${tag}.png`;
      }
    });
  } catch {
    throw new ExportError('chrome_render_failed');
  }
  return result;
}

/** 运行助手一次（独立进程组，超时对整个进程组 SIGKILL）。只把退出码交回，助手的输出一律丢弃。 */
function runHelper(timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(HELPER, ['--workspace', WORK, '--run', JOB_ID], {
      cwd: '/tmp',
      detached: true,
      stdio: 'ignore',
      env: {
        HOME: '/tmp',
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8',
        // 不创建诊断用的 IPC 通道（/tmp 下的 socket），不需要调试与性能采集。
        DOTNET_EnableDiagnostics: '0',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      },
    });
    let timedOut = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // 进程组已结束。
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      killGroup();
      resolve({ code, timedOut });
    });
  });
}

function sanitizeWarnings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_WARNINGS).flatMap((item) => {
    if (!isPlainObject(item) || typeof item.assetRef !== 'string') return [];
    const reason = typeof item.reason === 'string' ? item.reason.slice(0, MAX_REASON_CHARS) : '';
    return [{ assetRef: item.assetRef.slice(0, 256), reason }];
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !Object.hasOwn(MODES, args[0])) fail('bad_arguments', 64);
  const mode = MODES[args[0]];

  try {
    if ((await readdir(OUTPUT)).length > 0) throw new ExportError('request_invalid');
    const input = await readInput(mode);
    const assetRoot = mode.builtInAssets ? await prepareBuiltInAssets() : ASSET_ROOT;
    if (mode.convertWebp) await convertWebpAssets(input);
    const chrome = await buildChromeAssets(input.exportFormat.page);

    await mkdir(JOB_DIR, { recursive: true });
    await writeFile(
      `${JOB_DIR}/request.json`,
      `${JSON.stringify({
        action: 'render-restricted-html-docx',
        html: input.html,
        output: DOCX_NAME,
        whole_document: mode.wholeDocument,
        export_format: input.exportFormat,
        asset_root: assetRoot,
        asset_types: input.assetTypes,
        chrome_assets: {
          root: chrome.root,
          header: chrome.header,
          footer: chrome.footer,
          header_height_cm: chrome.layout.headerHeightCm,
          footer_height_cm: chrome.layout.footerHeightCm,
          footer_top_cm: chrome.layout.footerTopCm,
          footer_distance_cm: chrome.layout.footerDistanceCm,
          header_distance_cm: chrome.layout.headerDistanceCm,
          margin_top_cm: chrome.layout.marginTopCm,
          margin_bottom_cm: chrome.layout.marginBottomCm,
          text_layout: chrome.textLayout,
        },
      })}\n`,
    );

    let run;
    try {
      run = await runHelper(mode.helperTimeoutMs);
    } catch {
      throw new ExportError('helper_failed');
    }
    if (run.timedOut) throw new ExportError('helper_timeout');

    let result;
    try {
      result = JSON.parse(await readFile(`${JOB_DIR}/result.json`, 'utf8'));
    } catch {
      throw new ExportError('helper_failed');
    }
    if (run.code !== 0 || !isPlainObject(result) || result.ok !== true) throw new ExportError('helper_failed');

    const docx = await lstat(`${JOB_DIR}/${DOCX_NAME}`).catch(() => null);
    if (!docx?.isFile()) throw new ExportError('helper_failed');
    if (docx.size > MAX_DOCX_BYTES) throw new ExportError('output_too_large');
    await copyFile(`${JOB_DIR}/${DOCX_NAME}`, `${OUTPUT}/${DOCX_NAME}`);
    await writeFile(
      `${OUTPUT}/result.json`,
      `${JSON.stringify({
        version: 1,
        blockCount: Number.isSafeInteger(result.blockCount) ? result.blockCount : 0,
        imageWarnings: sanitizeWarnings(result.imageWarnings),
      })}\n`,
    );
    if ((await stat(`${OUTPUT}/${DOCX_NAME}`)).size !== docx.size) throw new ExportError('helper_failed');
  } catch (error) {
    // 失败时不留下部分输出。
    await rm(`${OUTPUT}/${DOCX_NAME}`, { force: true }).catch(() => {});
    await rm(`${OUTPUT}/result.json`, { force: true }).catch(() => {});
    fail(error instanceof ExportError ? error.code : 'export_failed', 65);
  }
}

await main();
