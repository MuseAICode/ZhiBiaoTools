// HTML 配图转 PNG（路线图第 8 步 8.8a1）：worker 一侧组装请求、在 render-html 沙箱中执行、按不可信输入校验结果。
// 8.10 的业务工具 render-html-image 经它转图；本步不接任何任务。
//
// 流程：校验输入（每批 1～50 张、每张 HTML ≤ 1 MiB、合计 ≤ 16 MiB、画框名）→ 新建 render-html 沙箱（断网，禁用页面脚本）→
// copyIn 只放 request.json → 执行模板登记的 render 命令 → copyOut（归档已按模板校验：只有 png 与 json、数量与大小）→
// 校验内容：result.json 的结构、标识与顺序与请求一致；每张成功的图正好有一个 <id>.png，PNG 签名与 IHDR 的宽高等于
// 画框的 2 倍（2480 × 画框高 × 2）；布局问题至多 12 条、每条至多 300 个字符，按不可信纯文本保留（桌面版交给 Agent 修改源码）。
// 沙箱在 finally 中销毁；失败一律抛 JobError，代码由这里决定，不采用沙箱输出的文字。
import { JobError, JobInterruptedError, type JobContext } from '../jobs/definitions.ts';
import { createSandboxWithRetry } from '../sandbox/createWithRetry.ts';
import { SandboxError, type SandboxDriver } from '../sandbox/driver.ts';
import type { SandboxFile } from '../sandbox/archive.ts';
import { RENDER_HTML_MAX_ITEMS, RENDER_HTML_MAX_PNG_BYTES } from '../sandbox/templates.ts';

/** 画框的设计高度（CSS 像素），与桌面版 client/electron/shared/htmlImageLayout.cjs 的 HTML_FRAME_HEIGHTS 相同（测试核对）。 */
export const HTML_FRAME_HEIGHTS = Object.freeze({ square: 1240, wide: 827, tall: 1653, panorama: 698 });
export type HtmlFrameSize = keyof typeof HTML_FRAME_HEIGHTS;
/** 设计宽度与输出倍率，与桌面版 HTML_DESIGN_WIDTH、HTML_CAPTURE_SCALE 相同。 */
export const HTML_DESIGN_WIDTH = 1240;
export const HTML_CAPTURE_SCALE = 2;
export const RENDER_HTML_MAX_HTML_BYTES = 1024 * 1024;
export const RENDER_HTML_MAX_TOTAL_HTML_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_ISSUES = 12;
const MAX_ISSUE_CHARS = 300;
const RESULT_NAME = 'result.json';

export interface HtmlImageInput {
  /** AI 写的 HTML（不可信，只在禁用脚本、断网的沙箱中渲染）。 */
  html: string;
  frameSize: HtmlFrameSize;
  /** 是否检查布局（桌面版 checkLayout；正文关闭“HTML 配图二次优化”时为 false）。 */
  checkLayout: boolean;
}

/** 单张失败的原因（入口给出，白名单内）。 */
export const HTML_IMAGE_FAILURES = ['render_timeout', 'render_failed', 'output_too_large'] as const;
export type HtmlImageFailure = (typeof HTML_IMAGE_FAILURES)[number];

export type HtmlImageResult =
  | { status: 'rendered'; png: Buffer; width: number; height: number; layoutIssues: string[] }
  | { status: 'failed'; error: HtmlImageFailure };

/** 入口的整批错误代码（server/sandbox/export/render-html.mjs）。 */
const ENTRY_ERRORS: Readonly<Record<string, [code: string, message: string]>> = Object.freeze({
  request_invalid: ['RENDER_HTML_REQUEST_INVALID', 'HTML 配图转图请求不合法'],
  browser_failed: ['RENDER_HTML_FAILED', 'HTML 配图转图失败'],
});

export type RenderHtmlContext = Pick<JobContext<unknown>, 'jobId' | 'signal' | 'log' | 'sandbox'>;

export interface RenderHtmlOptions {
  /** 重试创建前的等待（毫秒）。 */
  createRetryDelaysMs?: readonly number[];
}

export const RENDER_HTML_CREATE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000, 8_000, 15_000]);

/** 转图输出不符合规则。reason 是固定的英文短语，不含输出中的内容。 */
export class RenderHtmlOutputError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`render-html output rejected: ${reason}`);
    this.name = 'RenderHtmlOutputError';
    this.reason = reason;
  }
}

function invalidRequest(): JobError {
  return new JobError('RENDER_HTML_REQUEST_INVALID', 'HTML 配图转图请求不合法');
}

function isFrameSize(value: unknown): value is HtmlFrameSize {
  return typeof value === 'string' && Object.hasOwn(HTML_FRAME_HEIGHTS, value);
}

/** 第 index 张（从 0 起）的标识，也是输出文件名。 */
export function htmlImageId(index: number): string {
  return `h${String(index + 1).padStart(3, '0')}`;
}

/** 校验输入并组装 request.json。不合法时抛 JobError（RENDER_HTML_REQUEST_INVALID）。 */
export function buildRenderHtmlRequest(items: readonly HtmlImageInput[]): Buffer {
  if (!Array.isArray(items) || items.length === 0 || items.length > RENDER_HTML_MAX_ITEMS) throw invalidRequest();
  let total = 0;
  const requestItems = items.map((item, index) => {
    if (typeof item?.html !== 'string' || !isFrameSize(item.frameSize) || typeof item.checkLayout !== 'boolean') throw invalidRequest();
    // 不是合法 UTF-16（孤立代理项）的字符串无法按 UTF-8 原样传入。
    if (!item.html.isWellFormed()) throw invalidRequest();
    const bytes = Buffer.byteLength(item.html, 'utf8');
    total += bytes;
    if (bytes > RENDER_HTML_MAX_HTML_BYTES || total > RENDER_HTML_MAX_TOTAL_HTML_BYTES) throw invalidRequest();
    return { id: htmlImageId(index), html: item.html, frame_size: item.frameSize, check_layout: item.checkLayout };
  });
  return Buffer.from(JSON.stringify({ version: 1, items: requestItems }), 'utf8');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('latin1', 12, 16) !== 'IHDR' || data.readUInt32BE(8) !== 13) return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function parseIssues(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_ISSUES) throw new RenderHtmlOutputError('layout issues are invalid');
  return raw.map((issue) => {
    if (typeof issue !== 'string' || issue.length === 0 || issue.length > MAX_ISSUE_CHARS || !issue.isWellFormed()) throw new RenderHtmlOutputError('layout issue is invalid');
    return issue;
  });
}

/** 校验取回的文件（归档已按模板校验）。frameSizes 为请求中各张的画框，顺序即标识的顺序。 */
export function validateRenderHtmlOutput(files: readonly SandboxFile[], frameSizes: readonly HtmlFrameSize[]): HtmlImageResult[] {
  const byPath = new Map<string, Buffer>();
  for (const file of files) {
    if (byPath.has(file.path)) throw new RenderHtmlOutputError('duplicate file');
    byPath.set(file.path, file.data);
  }
  const resultData = byPath.get(RESULT_NAME);
  if (!resultData) throw new RenderHtmlOutputError('result.json is missing');
  if (resultData.length > MAX_RESULT_BYTES) throw new RenderHtmlOutputError('result.json is too large');
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(resultData));
  } catch {
    throw new RenderHtmlOutputError('result.json is not valid json');
  }
  if (!isPlainObject(result) || !hasExactKeys(result, ['version', 'items']) || result.version !== 1 || !Array.isArray(result.items)) {
    throw new RenderHtmlOutputError('result.json has an unexpected shape');
  }
  if (result.items.length !== frameSizes.length) throw new RenderHtmlOutputError('item count does not match the request');
  const used = new Set<string>([RESULT_NAME]);
  const results = result.items.map((item: unknown, index: number): HtmlImageResult => {
    const id = htmlImageId(index);
    if (!isPlainObject(item) || item.id !== id) throw new RenderHtmlOutputError('item id does not match the request');
    if (item.status === 'failed') {
      if (!hasExactKeys(item, ['id', 'status', 'error']) || !(HTML_IMAGE_FAILURES as readonly unknown[]).includes(item.error)) throw new RenderHtmlOutputError('failed item is invalid');
      return { status: 'failed', error: item.error as HtmlImageFailure };
    }
    if (item.status !== 'rendered' || !hasExactKeys(item, ['id', 'status', 'width', 'height', 'layout_issues'])) throw new RenderHtmlOutputError('item is invalid');
    const width = HTML_DESIGN_WIDTH * HTML_CAPTURE_SCALE;
    const height = HTML_FRAME_HEIGHTS[frameSizes[index]!] * HTML_CAPTURE_SCALE;
    if (item.width !== width || item.height !== height) throw new RenderHtmlOutputError('image size does not match the frame');
    const name = `${id}.png`;
    const png = byPath.get(name);
    if (!png) throw new RenderHtmlOutputError('image is missing');
    if (png.length > RENDER_HTML_MAX_PNG_BYTES) throw new RenderHtmlOutputError('image is too large');
    const size = pngSize(png);
    if (!size || size.width !== width || size.height !== height) throw new RenderHtmlOutputError('image is not a png of the frame size');
    used.add(name);
    return { status: 'rendered', png, width, height, layoutIssues: parseIssues(item.layout_issues) };
  });
  for (const path of byPath.keys()) if (!used.has(path)) throw new RenderHtmlOutputError('unexpected file');
  return results;
}

/** 入口在标准输出最后一个非空行给出的整批错误代码；不在白名单内时为 null。 */
function entryError(stdout: string): [code: string, message: string] | null {
  const line = stdout.split('\n').map((item) => item.trim()).filter(Boolean).at(-1) ?? '';
  try {
    const code = (JSON.parse(line) as { error?: unknown }).error;
    if (typeof code === 'string' && Object.hasOwn(ENTRY_ERRORS, code)) return ENTRY_ERRORS[code]!;
  } catch {
    // 不是 JSON。
  }
  return null;
}

function unavailable(cause?: unknown): JobError {
  return new JobError('RENDER_HTML_UNAVAILABLE', '转图服务暂不可用，请稍后重试', cause === undefined ? undefined : { cause });
}

function sandboxFailure(error: SandboxError): Error {
  if (error.code === 'SANDBOX_ABORTED') return new JobInterruptedError();
  if (error.code === 'SANDBOX_OUTPUT_REJECTED') return new JobError('RENDER_HTML_OUTPUT_REJECTED', 'HTML 配图转图结果不符合要求，已拒绝', { cause: error });
  if (error.code === 'SANDBOX_UNAVAILABLE') return unavailable(error);
  return new JobError('RENDER_HTML_FAILED', 'HTML 配图转图失败', { cause: error });
}

/** 在新建的 render-html 沙箱中把一批 HTML 转成 PNG，结果与输入一一对应。沙箱在 finally 中销毁。 */
export async function renderHtmlImages(context: RenderHtmlContext, items: readonly HtmlImageInput[], options: RenderHtmlOptions = {}): Promise<HtmlImageResult[]> {
  const request = buildRenderHtmlRequest(items);
  const frameSizes = items.map((item) => item.frameSize);
  if (!context.sandbox) throw unavailable();
  const driver: SandboxDriver = context.sandbox;
  const sandbox = await createSandboxWithRetry(driver, context, {
    template: 'render-html',
    delaysMs: options.createRetryDelaysMs ?? RENDER_HTML_CREATE_RETRY_DELAYS_MS,
    busy: (cause) => new JobError('RENDER_HTML_SANDBOX_BUSY', '转图服务繁忙，请稍后重试', { cause }),
    unavailable,
    busyLog: '沙箱数已达上限，稍后重试',
    unavailableLog: '转图服务暂不可用，稍后重试',
  });
  try {
    try {
      await driver.copyIn(sandbox, [{ path: 'request.json', data: request }], { signal: context.signal });
      const result = await driver.exec(sandbox, 'render', [], { signal: context.signal });
      if (result.timedOut) throw new JobError('RENDER_HTML_TIMEOUT', 'HTML 配图转图超时，请稍后重试');
      if (result.exitCode !== 0) {
        const [code, message] = entryError(result.stdout) ?? ['RENDER_HTML_FAILED', 'HTML 配图转图失败'];
        throw new JobError(code, message);
      }
      return validateRenderHtmlOutput(await driver.copyOut(sandbox, { signal: context.signal }), frameSizes);
    } catch (error) {
      if (error instanceof SandboxError) throw sandboxFailure(error);
      if (error instanceof RenderHtmlOutputError) throw new JobError('RENDER_HTML_OUTPUT_REJECTED', 'HTML 配图转图结果不符合要求，已拒绝', { cause: error });
      throw error;
    }
  } finally {
    await driver.destroy(sandbox).catch(() => context.log('沙箱销毁失败，将由到期清理删除').catch(() => {}));
  }
}
