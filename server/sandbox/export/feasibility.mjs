// 可研报告导出 Word 在 export 沙箱中的运行规则（路线图第 7 步 7.5b，#61 决定事项第 1 项方案 A）。由 entry.mjs 的 feasibility
// 模式调用；本模块不碰固定路径，读取配图、WebP 转换与装饰转图都由调用方传入，便于在不启动沙箱时测试。
//
// 生成本身是桌面版同一份代码（client/electron/services/exportService.cjs 的 buildDocxResult，镜像构建时复制），这里只提供：
// - parseFeasibilityRequest：request.json 的形态校验，只把已知字段交给 buildDocxResult（不转发 base_dir 等会让桌面版读本机
//   文件的字段）；
// - createFeasibilityRuntime：注入 buildDocxResult 的运行时（7.5a）。配图只认两种来源——本项目的产物地址
//   /api/artifacts/<uuid>/content（worker 已把本项目可见的图片产物放进 assets/<产物 id>）与 data URL（与桌面版相同的解码）；
//   app-asset://、http(s)、本机路径等一律读不到，由桌面版代码在原位提示“未找到可用图片数据”。WebP 转 PNG 与装饰转图由
//   调用方给出（Chromium 禁用 JavaScript，render.mjs）；
// - sanitizeWarnings：桌面版生成的提示文字（含正文中的图片名称）在写进 result.json 之前去掉控制字符、限制条数与长度。

export const FEASIBILITY_IMAGE_URL = /^\/api\/artifacts\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/content$/;
export const MAX_WARNINGS = 2_000;
export const MAX_WARNING_CHARS = 400;
/** 目录的上限：与服务端可研目录相同（2,000 个节点、64 层以内，实际不超过六级）；正文总量由 request.json 的大小上限约束。 */
const MAX_OUTLINE_NODES = 2_000;
const MAX_OUTLINE_DEPTH = 64;
const MAX_TEXT_CHARS = 1_000;
const OPTION_FLAGS = ['includeCover', 'includePreparationNotes', 'includeAppendixTables'];
const OPTION_TEXTS = ['preparationUnit', 'securityLevel', 'documentCode'];
const PROJECT_INFO_KEYS = [
  'projectName', 'projectType', 'industry', 'constructionUnit', 'location', 'constructionContent',
  'constructionPeriodYears', 'operationPeriodYears', 'totalInvestment', 'fundingSource',
];

export class FeasibilityRequestError extends Error {
  constructor(reason) {
    super(`feasibility request invalid: ${reason}`);
    this.reason = reason;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(reason) {
  return new FeasibilityRequestError(reason);
}

function boundedString(value, max, what) {
  if (typeof value !== 'string' || [...value].length > max) throw invalid(`${what} is not a bounded string`);
  return value;
}

function parseOutline(raw, depth, counter) {
  if (!Array.isArray(raw) || depth > MAX_OUTLINE_DEPTH) throw invalid('outline is not a bounded array');
  return raw.map((item) => {
    if (!isPlainObject(item)) throw invalid('outline item is not an object');
    counter.count += 1;
    if (counter.count > MAX_OUTLINE_NODES) throw invalid('outline has too many nodes');
    const { id, title, description, content, children, ...rest } = item;
    if (Object.keys(rest).length > 0) throw invalid('outline item has unexpected fields');
    const node = { id: boundedString(id, 200, 'id'), title: boundedString(title, MAX_TEXT_CHARS, 'title') };
    if (description !== undefined) node.description = boundedString(description, 10_000, 'description');
    // 正文长度由 request.json 的大小上限约束，这里只要求是字符串。
    if (content !== undefined) {
      if (typeof content !== 'string') throw invalid('content is not a string');
      node.content = content;
    }
    if (children !== undefined) node.children = parseOutline(children, depth + 1, counter);
    return node;
  });
}

function parseOptions(raw) {
  if (!isPlainObject(raw)) throw invalid('feasibility_options is not an object');
  const { project_info: projectInfo, ...rest } = raw;
  const options = {};
  for (const [key, value] of Object.entries(rest)) {
    if (OPTION_FLAGS.includes(key)) {
      if (typeof value !== 'boolean') throw invalid(`${key} is not a boolean`);
      options[key] = value;
    } else if (OPTION_TEXTS.includes(key)) {
      options[key] = boundedString(value, MAX_TEXT_CHARS, key);
    } else {
      throw invalid('feasibility_options has unexpected fields');
    }
  }
  if (!isPlainObject(projectInfo)) throw invalid('project_info is not an object');
  options.project_info = {};
  for (const [key, value] of Object.entries(projectInfo)) {
    if (!PROJECT_INFO_KEYS.includes(key)) throw invalid('project_info has unexpected fields');
    // constructionContent 等是多行说明，放宽到 20,000 字（服务端可研项目信息的上限之内）。
    options.project_info[key] = boundedString(value, 20_000, key);
  }
  return options;
}

/**
 * request.json（已由 entry.mjs 解析为对象）：{ project_name, outline, export_format, feasibility_options, asset_types? }。
 * 返回交给 buildDocxResult 的 payload（只有这四个字段）。asset_types 由 entry.mjs 与放入的文件核对。
 */
export function parseFeasibilityRequest(request) {
  if (!isPlainObject(request)) throw invalid('request is not an object');
  const { project_name: projectName, outline, export_format: exportFormat, feasibility_options: options, asset_types: _assetTypes, ...rest } = request;
  if (Object.keys(rest).length > 0) throw invalid('request has unexpected fields');
  if (!isPlainObject(exportFormat)) throw invalid('export_format is not an object');
  const parsedOutline = parseOutline(outline, 1, { count: 0 });
  if (parsedOutline.length === 0) throw invalid('outline is empty');
  return {
    project_name: boundedString(projectName, MAX_TEXT_CHARS, 'project_name'),
    outline: parsedOutline,
    export_format: exportFormat,
    feasibility_options: parseOptions(options),
  };
}

/** 与桌面版 exportService.imageTypeFromMime 相同（data URL 的类型）。 */
export function imageTypeFromMime(mime) {
  if (!mime) return null;
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  if (mime.includes('webp')) return 'webp';
  return null;
}

/** 按文件头识别产物的类型（桌面版按扩展名，产物没有可信的扩展名）；其他格式返回 null，由桌面版代码原位提示。 */
export function imageTypeFromBytes(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('latin1'))) return 'gif';
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

const DATA_URL = /^data:([^;,]+);base64,(.+)$/i;

/**
 * 注入 buildDocxResult 的运行时（7.5a 的 loadImage、normalizeImage、renderChromePngs）。
 * @param {object} deps
 * @param {(id: string) => Promise<Buffer | null>} deps.readAsset   读 assets/<产物 id>（没有放入时返回 null）
 * @param {(webp: Buffer) => Promise<Buffer | null>} deps.convertWebp  WebP → PNG（失败时返回 null）
 * @param {(page: object) => Promise<object>} deps.renderChromePngs   与桌面版 chromeAssetService.renderChromePngs 相同的返回值
 */
export function createFeasibilityRuntime({ readAsset, convertWebp, renderChromePngs }) {
  return Object.freeze({
    async loadImage(source) {
      const url = String(source || '').trim();
      if (!url) return null;
      const data = DATA_URL.exec(url);
      if (data) return { buffer: Buffer.from(data[2], 'base64'), type: imageTypeFromMime(data[1]) };
      const artifact = FEASIBILITY_IMAGE_URL.exec(url);
      if (!artifact) return null;
      const buffer = await readAsset(artifact[1].toLowerCase());
      if (!buffer) return null;
      return { buffer, type: imageTypeFromBytes(buffer) };
    },
    async normalizeImage(loaded) {
      if (!loaded?.buffer || !loaded.type || loaded.type !== 'webp') return loaded;
      const png = await convertWebp(loaded.buffer);
      // 与桌面版 normalizeImageForDocx 解码失败时相同的原因，由桌面版代码在原位提示。
      if (!png) throw new Error('WebP 图片转换失败');
      return { buffer: png, type: 'png' };
    },
    renderChromePngs: (page) => renderChromePngs(page),
  });
}

/**
 * 与桌面版 chromeAssetService.renderChromePngs 相同的返回值：buildChrome 的几何与文字层，装饰 SVG 由 rasterize 转成 PNG
 * （render.mjs 的 rasterizeSvg，Chromium 禁用 JavaScript）。同一份 SVG 只转一次。
 */
export async function renderChromeWith(buildChrome, rasterize, page) {
  const chrome = buildChrome(isPlainObject(page) ? page : {});
  const widthCm = chrome.layout.widthCm;
  const memo = new Map();
  const emit = async (svg, heightCm) => {
    if (!svg || !(heightCm > 0)) return null;
    if (!memo.has(svg)) memo.set(svg, await rasterize(svg, widthCm, heightCm));
    return { buffer: memo.get(svg), widthCm, heightCm };
  };
  return {
    header: await emit(chrome.headerSvg, chrome.layout.headerHeightCm),
    footer: await emit(chrome.footerSvg, chrome.layout.footerHeightCm),
    layout: chrome.layout,
    textLayout: chrome.textLayout,
    colors: chrome.colors,
  };
}

/** 写进 result.json 的提示：只保留字符串，去掉控制字符，至多 2,000 条、每条 400 个字符。 */
export function sanitizeWarnings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => typeof item === 'string')
    .slice(0, MAX_WARNINGS)
    .map((item) => [...item.replace(/[\u0000-\u001f\u007f]/g, ' ')].slice(0, MAX_WARNING_CHARS).join(''));
}
