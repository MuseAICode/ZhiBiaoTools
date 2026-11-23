// Mermaid 转 PNG（路线图第 8 步 8.8b）：worker 一侧组装请求、在 render-mermaid 沙箱中执行、按不可信输入校验结果。
// 8.10 的正文生成（Agent 生成 Mermaid 源码后转图）经它转图；本步不接任何任务。
//
// 流程：校验输入（每批 1～50 段、每段源码 ≤ 64 KiB、合计 ≤ 1 MiB、合法 UTF-16）→ 新建 render-mermaid 沙箱（专用镜像、断网，
// 只执行固定的 mermaid.js 与入口页面脚本）→ copyIn 只放 request.json → 执行模板登记的 render 命令 → copyOut（归档已按模板校验：
// 只有 png 与 json、数量与大小）→ 校验内容：result.json 的结构、标识与顺序与请求一致；每张成功的图正好有一个 <id>.png，PNG 签名与
// IHDR 的宽高与结果项一致、在 1～2040 × 1～3306 之内且是 3 的倍数（3 倍像素截图）；diagram_invalid 的说明（Mermaid 的语法错误）
// 至多 1000 个字符、不含控制字符，按不可信纯文本保留（桌面版交给 Agent 修改源码）。
// 沙箱在 finally 中销毁；失败一律抛 JobError，代码由这里决定，不采用沙箱输出的文字（diagram_invalid 的说明除外，只作为数据返回）。
// Mermaid 生成的 SVG 不出沙箱：取回规则只收 png 与 json，这里另外拒绝任何多余的文件。
import { JobError, JobInterruptedError, type JobContext } from '../jobs/definitions.ts';
import { createSandboxWithRetry } from '../sandbox/createWithRetry.ts';
import { SandboxError, type SandboxDriver } from '../sandbox/driver.ts';
import type { SandboxFile } from '../sandbox/archive.ts';
import {
  RENDER_MERMAID_MAX_CODE_BYTES,
  RENDER_MERMAID_MAX_HEIGHT,
  RENDER_MERMAID_MAX_ITEMS,
  RENDER_MERMAID_MAX_PNG_BYTES,
  RENDER_MERMAID_MAX_TOTAL_CODE_BYTES,
  RENDER_MERMAID_MAX_WIDTH,
} from '../sandbox/templates.ts';

/** 截图倍率，与桌面版 MERMAID_CAPTURE_SCALE 相同。 */
export const MERMAID_CAPTURE_SCALE = 3;
/** diagram_invalid 的说明至多 1000 个字符。 */
export const MERMAID_MAX_MESSAGE_CHARS = 1000;
const MAX_RESULT_BYTES = 1024 * 1024;
const RESULT_NAME = 'result.json';

/** 单段失败的原因（入口给出，白名单内）。diagram_invalid：Mermaid 无法解析或渲染（带说明，交给 Agent 修改源码）。 */
export const MERMAID_IMAGE_FAILURES = ['render_timeout', 'render_failed', 'output_too_large', 'diagram_invalid'] as const;
export type MermaidImageFailure = (typeof MERMAID_IMAGE_FAILURES)[number];

export type MermaidImageResult =
  | { status: 'rendered'; png: Buffer; width: number; height: number }
  | { status: 'failed'; error: Exclude<MermaidImageFailure, 'diagram_invalid'> }
  | { status: 'failed'; error: 'diagram_invalid'; message: string };

/** 入口的整批错误代码（server/sandbox/render-mermaid/entry.mjs）。 */
const ENTRY_ERRORS: Readonly<Record<string, [code: string, message: string]>> = Object.freeze({
  request_invalid: ['RENDER_MERMAID_REQUEST_INVALID', 'Mermaid 转图请求不合法'],
  browser_failed: ['RENDER_MERMAID_FAILED', 'Mermaid 转图失败'],
});

export type RenderMermaidContext = Pick<JobContext<unknown>, 'jobId' | 'signal' | 'log' | 'sandbox'>;

export interface RenderMermaidOptions {
  /** 重试创建前的等待（毫秒）。 */
  createRetryDelaysMs?: readonly number[];
}

export const RENDER_MERMAID_CREATE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000, 8_000, 15_000]);

/** 转图输出不符合规则。reason 是固定的英文短语，不含输出中的内容。 */
export class RenderMermaidOutputError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`render-mermaid output rejected: ${reason}`);
    this.name = 'RenderMermaidOutputError';
    this.reason = reason;
  }
}

function invalidRequest(): JobError {
  return new JobError('RENDER_MERMAID_REQUEST_INVALID', 'Mermaid 转图请求不合法');
}

/** 第 index 段（从 0 起）的标识，也是输出文件名。 */
export function mermaidImageId(index: number): string {
  return `m${String(index + 1).padStart(3, '0')}`;
}

/** 校验输入并组装放入沙箱的唯一文件 request.json。不合法时抛 JobError（RENDER_MERMAID_REQUEST_INVALID）。 */
export function buildRenderMermaidRequest(codes: readonly string[]): SandboxFile[] {
  if (!Array.isArray(codes) || codes.length === 0 || codes.length > RENDER_MERMAID_MAX_ITEMS) throw invalidRequest();
  let total = 0;
  const items = codes.map((code, index) => {
    // 不是合法 UTF-16（孤立代理项）的字符串无法按 UTF-8 原样传入。
    if (typeof code !== 'string' || code.trim() === '' || !code.isWellFormed()) throw invalidRequest();
    const bytes = Buffer.byteLength(code, 'utf8');
    total += bytes;
    if (bytes > RENDER_MERMAID_MAX_CODE_BYTES || total > RENDER_MERMAID_MAX_TOTAL_CODE_BYTES) throw invalidRequest();
    return { id: mermaidImageId(index), code };
  });
  return [{ path: 'request.json', data: Buffer.from(JSON.stringify({ version: 1, items }), 'utf8') }];
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

function isDimension(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MERMAID_CAPTURE_SCALE && value <= max && value % MERMAID_CAPTURE_SCALE === 0;
}

/** 控制字符（换行、制表符除外）、零宽与双向控制字符。 */
const UNSAFE_MESSAGE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

function parseMessage(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > MERMAID_MAX_MESSAGE_CHARS || !raw.isWellFormed() || UNSAFE_MESSAGE_CHARS.test(raw)) {
    throw new RenderMermaidOutputError('diagram message is invalid');
  }
  return raw;
}

/** 校验取回的文件（归档已按模板校验）。count 为请求中的段数，顺序即标识的顺序。 */
export function validateRenderMermaidOutput(files: readonly SandboxFile[], count: number): MermaidImageResult[] {
  const byPath = new Map<string, Buffer>();
  for (const file of files) {
    if (byPath.has(file.path)) throw new RenderMermaidOutputError('duplicate file');
    byPath.set(file.path, file.data);
  }
  const resultData = byPath.get(RESULT_NAME);
  if (!resultData) throw new RenderMermaidOutputError('result.json is missing');
  if (resultData.length > MAX_RESULT_BYTES) throw new RenderMermaidOutputError('result.json is too large');
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(resultData));
  } catch {
    throw new RenderMermaidOutputError('result.json is not valid json');
  }
  if (!isPlainObject(result) || !hasExactKeys(result, ['version', 'items']) || result.version !== 1 || !Array.isArray(result.items)) {
    throw new RenderMermaidOutputError('result.json has an unexpected shape');
  }
  if (result.items.length !== count) throw new RenderMermaidOutputError('item count does not match the request');
  const used = new Set<string>([RESULT_NAME]);
  const results = result.items.map((item: unknown, index: number): MermaidImageResult => {
    const id = mermaidImageId(index);
    if (!isPlainObject(item) || item.id !== id) throw new RenderMermaidOutputError('item id does not match the request');
    if (item.status === 'failed') {
      if (item.error === 'diagram_invalid') {
        if (!hasExactKeys(item, ['id', 'status', 'error', 'message'])) throw new RenderMermaidOutputError('failed item is invalid');
        return { status: 'failed', error: 'diagram_invalid', message: parseMessage(item.message) };
      }
      if (!hasExactKeys(item, ['id', 'status', 'error']) || !(MERMAID_IMAGE_FAILURES as readonly unknown[]).includes(item.error)) throw new RenderMermaidOutputError('failed item is invalid');
      return { status: 'failed', error: item.error as Exclude<MermaidImageFailure, 'diagram_invalid'> };
    }
    if (item.status !== 'rendered' || !hasExactKeys(item, ['id', 'status', 'width', 'height'])) throw new RenderMermaidOutputError('item is invalid');
    if (!isDimension(item.width, RENDER_MERMAID_MAX_WIDTH) || !isDimension(item.height, RENDER_MERMAID_MAX_HEIGHT)) throw new RenderMermaidOutputError('image size is out of range');
    const name = `${id}.png`;
    const png = byPath.get(name);
    if (!png) throw new RenderMermaidOutputError('image is missing');
    if (png.length > RENDER_MERMAID_MAX_PNG_BYTES) throw new RenderMermaidOutputError('image is too large');
    const size = pngSize(png);
    if (!size || size.width !== item.width || size.height !== item.height) throw new RenderMermaidOutputError('image is not a png of the reported size');
    used.add(name);
    return { status: 'rendered', png, width: item.width, height: item.height };
  });
  for (const path of byPath.keys()) if (!used.has(path)) throw new RenderMermaidOutputError('unexpected file');
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
  return new JobError('RENDER_MERMAID_UNAVAILABLE', '转图服务暂不可用，请稍后重试', cause === undefined ? undefined : { cause });
}

function sandboxFailure(error: SandboxError): Error {
  if (error.code === 'SANDBOX_ABORTED') return new JobInterruptedError();
  if (error.code === 'SANDBOX_OUTPUT_REJECTED') return new JobError('RENDER_MERMAID_OUTPUT_REJECTED', 'Mermaid 转图结果不符合要求，已拒绝', { cause: error });
  if (error.code === 'SANDBOX_UNAVAILABLE') return unavailable(error);
  return new JobError('RENDER_MERMAID_FAILED', 'Mermaid 转图失败', { cause: error });
}

/** 在新建的 render-mermaid 沙箱中把一批 Mermaid 源码转成 PNG，结果与输入一一对应。沙箱在 finally 中销毁。 */
export async function renderMermaidImages(context: RenderMermaidContext, codes: readonly string[], options: RenderMermaidOptions = {}): Promise<MermaidImageResult[]> {
  const files = buildRenderMermaidRequest(codes);
  if (!context.sandbox) throw unavailable();
  const driver: SandboxDriver = context.sandbox;
  const sandbox = await createSandboxWithRetry(driver, context, {
    template: 'render-mermaid',
    delaysMs: options.createRetryDelaysMs ?? RENDER_MERMAID_CREATE_RETRY_DELAYS_MS,
    busy: (cause) => new JobError('RENDER_MERMAID_SANDBOX_BUSY', '转图服务繁忙，请稍后重试', { cause }),
    unavailable,
    busyLog: '沙箱数已达上限，稍后重试',
    unavailableLog: '转图服务暂不可用，稍后重试',
  });
  try {
    try {
      await driver.copyIn(sandbox, files, { signal: context.signal });
      const result = await driver.exec(sandbox, 'render', [], { signal: context.signal });
      if (result.timedOut) throw new JobError('RENDER_MERMAID_TIMEOUT', 'Mermaid 转图超时，请稍后重试');
      if (result.exitCode !== 0) {
        const [code, message] = entryError(result.stdout) ?? ['RENDER_MERMAID_FAILED', 'Mermaid 转图失败'];
        throw new JobError(code, message);
      }
      return validateRenderMermaidOutput(await driver.copyOut(sandbox, { signal: context.signal }), codes.length);
    } catch (error) {
      if (error instanceof SandboxError) throw sandboxFailure(error);
      if (error instanceof RenderMermaidOutputError) throw new JobError('RENDER_MERMAID_OUTPUT_REJECTED', 'Mermaid 转图结果不符合要求，已拒绝', { cause: error });
      throw error;
    }
  } finally {
    await driver.destroy(sandbox).catch(() => context.log('沙箱销毁失败，将由到期清理删除').catch(() => {}));
  }
}
