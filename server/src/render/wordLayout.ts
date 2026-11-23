// docx-editor 分页测量（路线图第 8 步 8.8c）：worker 一侧放入 docx、在 render-layout 沙箱中测量、按不可信输入校验版式 JSON。
// 8.10 的格式自检（桌面版 contentGenerationLayout.cjs 的 runContentLayoutCheck：导出自检 Word → 测量 → analyzeLayout 找图片前的
// 页 / 栏留白）经它测量；本步不接任何任务。
//
// 流程：校验输入（ZIP 签名、≤ 100 MiB）→ 新建 render-layout 沙箱（专用镜像、断网，只执行固定的 docx-editor 与入口页面脚本）→
// copyIn 只放 document.docx → 执行模板登记的 measure 命令 → copyOut（归档已按模板校验：只有 json、一个文件、≤ 16 MiB）→
// 校验内容：只有 layout.json，结构与 server/sandbox/render-layout/layoutProjection.mjs 截取的版式 JSON 完全一致（字段不多不少、
// 类型、取值范围、数量与嵌套深度受限），见 parseWordLayout。
// 沙箱在 finally 中销毁；失败一律抛 JobError，代码由这里决定，不采用沙箱输出的文字。版式 JSON 中的文字（span 的 text）是 docx 的
// 正文，只作为数据返回（8.10 用来计字数与截取前文，按不可信纯文本处理）。
import { JobError, JobInterruptedError, type JobContext } from '../jobs/definitions.ts';
import { createSandboxWithRetry } from '../sandbox/createWithRetry.ts';
import { SandboxError, type SandboxDriver } from '../sandbox/driver.ts';
import type { SandboxFile } from '../sandbox/archive.ts';
import { RENDER_LAYOUT_MAX_DOCX_BYTES, RENDER_LAYOUT_MAX_LAYOUT_BYTES } from '../sandbox/templates.ts';

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutLine {
  box: { height: number };
  /** 行中的绘图（图片等），只保留个数。 */
  drawings: Record<string, never>[];
  /** 一行的文字合成一个 span。 */
  spans: [{ text: string }];
}

export interface LayoutParagraph {
  kind: 'paragraph';
  paragraphId: string;
  fragmentIndex: number;
  box: LayoutBox;
  styleId: string | null;
  outlineLevel: number | null;
  /** 只保留 pageBreakBefore（存在时为一项）。 */
  props: [] | [{ localName: 'pageBreakBefore' }];
  spacing: { before: number; after: number };
  lines: LayoutLine[];
}

export interface LayoutTable {
  kind: 'table';
  box: LayoutBox;
  rows: { cells: { blocks: LayoutBlock[] }[] }[];
}

export interface LayoutOtherBlock {
  kind: string;
  box: LayoutBox;
}

export type LayoutBlock = LayoutParagraph | LayoutTable | LayoutOtherBlock;

export interface LayoutPage {
  index: number;
  contentBox: { width: number; height: number };
  fragments: LayoutBlock[];
}

/** 版式 JSON（与桌面版 analyzeLayout 读取的 docx-editor 版式结果同构的子集）。 */
export interface WordLayout {
  version: 1;
  pages: LayoutPage[];
  destinations: { anchor: { name: string; paragraphId: string } }[];
}

/** 校验的上限：页数、每页的块数、全部节点（块、行、表格行与单元格、绘图、书签）的总数、表格嵌套深度、坐标绝对值、字符串长度。 */
export const WORD_LAYOUT_LIMITS = Object.freeze({
  maxPages: 10_000,
  maxFragmentsPerPage: 10_000,
  maxNodes: 2_000_000,
  maxTableDepth: 16,
  maxCoordinate: 1_000_000,
  maxIdChars: 512,
  maxLineChars: 4_096,
  maxDrawingsPerLine: 1_000,
  maxOutlineLevel: 9,
});

/** 定位书签名（与 layoutProjection.mjs 的 LAYOUT_BOOKMARK 相同，测试核对）。 */
export const LAYOUT_BOOKMARK = /^app_layout_[0-9]{1,6}$/;
/** 其他块的类型名（docx-editor 的 kind，例如浮动对象）。 */
const OTHER_KIND = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
/** 控制字符（标识与样式名中不允许）。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const LAYOUT_NAME = 'layout.json';
const INPUT_NAME = 'document.docx';

/** 入口的错误代码（server/sandbox/render-layout/entry.mjs）。 */
const ENTRY_ERRORS: Readonly<Record<string, [code: string, message: string]>> = Object.freeze({
  request_invalid: ['RENDER_LAYOUT_REQUEST_INVALID', '格式自检请求不合法'],
  document_invalid: ['RENDER_LAYOUT_DOCUMENT_INVALID', '格式自检无法打开 Word 文档'],
  layout_timeout: ['RENDER_LAYOUT_TIMEOUT', '格式自检超时，请稍后重试'],
  output_too_large: ['RENDER_LAYOUT_OUTPUT_REJECTED', '格式自检结果不符合要求，已拒绝'],
  layout_failed: ['RENDER_LAYOUT_FAILED', '格式自检失败'],
  browser_failed: ['RENDER_LAYOUT_FAILED', '格式自检失败'],
});

export type RenderLayoutContext = Pick<JobContext<unknown>, 'jobId' | 'signal' | 'log' | 'sandbox'>;

export interface RenderLayoutOptions {
  /** 重试创建前的等待（毫秒）。 */
  createRetryDelaysMs?: readonly number[];
}

export const RENDER_LAYOUT_CREATE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000, 8_000, 15_000]);

/** 版式输出不符合规则。reason 是固定的英文短语，不含输出中的内容。 */
export class RenderLayoutOutputError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`render-layout output rejected: ${reason}`);
    this.name = 'RenderLayoutOutputError';
    this.reason = reason;
  }
}

/** 校验输入并组装放入沙箱的唯一文件 document.docx。不合法时抛 JobError（RENDER_LAYOUT_REQUEST_INVALID）。 */
export function buildRenderLayoutRequest(docx: Buffer): SandboxFile[] {
  if (!Buffer.isBuffer(docx) || docx.length < 4 || docx.length > RENDER_LAYOUT_MAX_DOCX_BYTES || docx.readUInt32LE(0) !== 0x04034b50) {
    throw new JobError('RENDER_LAYOUT_REQUEST_INVALID', '格式自检请求不合法');
  }
  return [{ path: INPUT_NAME, data: docx }];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

class Parser {
  private nodes = 0;

  private reject(reason: string): never {
    throw new RenderLayoutOutputError(reason);
  }

  private count(n = 1): void {
    this.nodes += n;
    if (this.nodes > WORD_LAYOUT_LIMITS.maxNodes) this.reject('layout has too many nodes');
  }

  private number(value: unknown, options: { min?: number } = {}): number {
    const min = options.min ?? -WORD_LAYOUT_LIMITS.maxCoordinate;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > WORD_LAYOUT_LIMITS.maxCoordinate) this.reject('number is out of range');
    return value;
  }

  private integer(value: unknown, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) this.reject('integer is out of range');
    return value;
  }

  private id(value: unknown): string {
    if (typeof value !== 'string' || value === '' || value.length > WORD_LAYOUT_LIMITS.maxIdChars || !value.isWellFormed() || CONTROL_CHARS.test(value)) {
      this.reject('identifier is invalid');
    }
    return value;
  }

  private box(value: unknown): LayoutBox {
    if (!isPlainObject(value) || !hasExactKeys(value, ['x', 'y', 'width', 'height'])) this.reject('box is invalid');
    return { x: this.number(value.x), y: this.number(value.y), width: this.number(value.width, { min: 0 }), height: this.number(value.height, { min: 0 }) };
  }

  private array(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) this.reject('array is invalid');
    return value;
  }

  private line(value: unknown): LayoutLine {
    this.count();
    if (!isPlainObject(value) || !hasExactKeys(value, ['box', 'drawings', 'spans'])) this.reject('line is invalid');
    if (!isPlainObject(value.box) || !hasExactKeys(value.box, ['height'])) this.reject('line box is invalid');
    const drawings = this.array(value.drawings, WORD_LAYOUT_LIMITS.maxDrawingsPerLine).map((drawing) => {
      if (!isPlainObject(drawing) || Object.keys(drawing).length !== 0) this.reject('drawing is invalid');
      return {} as Record<string, never>;
    });
    this.count(drawings.length);
    const spans = this.array(value.spans, 1);
    const span = spans[0];
    if (spans.length !== 1 || !isPlainObject(span) || !hasExactKeys(span, ['text'])) this.reject('span is invalid');
    const text = span.text;
    if (typeof text !== 'string' || text.length > WORD_LAYOUT_LIMITS.maxLineChars || !text.isWellFormed()) this.reject('line text is invalid');
    return { box: { height: this.number(value.box.height, { min: 0 }) }, drawings, spans: [{ text }] };
  }

  private paragraph(value: Record<string, unknown>): LayoutParagraph {
    const keys = ['kind', 'paragraphId', 'fragmentIndex', 'box', 'styleId', 'outlineLevel', 'props', 'spacing', 'lines'];
    if (!hasExactKeys(value, keys)) this.reject('paragraph is invalid');
    const props = this.array(value.props, 1);
    if (props.length === 1 && !(isPlainObject(props[0]) && hasExactKeys(props[0], ['localName']) && props[0].localName === 'pageBreakBefore')) this.reject('paragraph props are invalid');
    if (!isPlainObject(value.spacing) || !hasExactKeys(value.spacing, ['before', 'after'])) this.reject('paragraph spacing is invalid');
    return {
      kind: 'paragraph',
      paragraphId: this.id(value.paragraphId),
      fragmentIndex: this.integer(value.fragmentIndex, WORD_LAYOUT_LIMITS.maxCoordinate),
      box: this.box(value.box),
      styleId: value.styleId === null ? null : this.id(value.styleId),
      outlineLevel: value.outlineLevel === null ? null : this.integer(value.outlineLevel, WORD_LAYOUT_LIMITS.maxOutlineLevel),
      props: props.length === 1 ? [{ localName: 'pageBreakBefore' }] : [],
      spacing: { before: this.number(value.spacing.before), after: this.number(value.spacing.after) },
      lines: this.array(value.lines, WORD_LAYOUT_LIMITS.maxNodes).map((line) => this.line(line)),
    };
  }

  private table(value: Record<string, unknown>, depth: number): LayoutTable {
    if (depth >= WORD_LAYOUT_LIMITS.maxTableDepth) this.reject('tables are nested too deeply');
    if (!hasExactKeys(value, ['kind', 'box', 'rows'])) this.reject('table is invalid');
    const rows = this.array(value.rows, WORD_LAYOUT_LIMITS.maxNodes).map((row) => {
      this.count();
      if (!isPlainObject(row) || !hasExactKeys(row, ['cells'])) this.reject('table row is invalid');
      const cells = this.array(row.cells, WORD_LAYOUT_LIMITS.maxNodes).map((cell) => {
        this.count();
        if (!isPlainObject(cell) || !hasExactKeys(cell, ['blocks'])) this.reject('table cell is invalid');
        return { blocks: this.array(cell.blocks, WORD_LAYOUT_LIMITS.maxNodes).map((block) => this.block(block, depth + 1)) };
      });
      return { cells };
    });
    return { kind: 'table', box: this.box(value.box), rows };
  }

  block(value: unknown, depth: number): LayoutBlock {
    this.count();
    if (!isPlainObject(value) || typeof value.kind !== 'string') this.reject('block is invalid');
    if (value.kind === 'paragraph') return this.paragraph(value);
    if (value.kind === 'table') return this.table(value, depth);
    if (!OTHER_KIND.test(value.kind) || !hasExactKeys(value, ['kind', 'box'])) this.reject('block is invalid');
    return { kind: value.kind, box: this.box(value.box) };
  }

  layout(value: unknown): WordLayout {
    if (!isPlainObject(value) || !hasExactKeys(value, ['version', 'pages', 'destinations']) || value.version !== 1) this.reject('layout has an unexpected shape');
    const rawPages = this.array(value.pages, WORD_LAYOUT_LIMITS.maxPages);
    if (rawPages.length === 0) this.reject('layout has no pages');
    const pages = rawPages.map((page, index): LayoutPage => {
      this.count();
      if (!isPlainObject(page) || !hasExactKeys(page, ['index', 'contentBox', 'fragments']) || page.index !== index) this.reject('page is invalid');
      const box = page.contentBox;
      if (!isPlainObject(box) || !hasExactKeys(box, ['width', 'height'])) this.reject('page content box is invalid');
      const width = this.number(box.width, { min: 0 });
      const height = this.number(box.height, { min: 0 });
      if (width <= 0 || height <= 0) this.reject('page content box is empty');
      return {
        index,
        contentBox: { width, height },
        fragments: this.array(page.fragments, WORD_LAYOUT_LIMITS.maxFragmentsPerPage).map((block) => this.block(block, 0)),
      };
    });
    const destinations = this.array(value.destinations, WORD_LAYOUT_LIMITS.maxNodes).map((destination) => {
      this.count();
      if (!isPlainObject(destination) || !hasExactKeys(destination, ['anchor'])) this.reject('destination is invalid');
      const anchor = destination.anchor;
      if (!isPlainObject(anchor) || !hasExactKeys(anchor, ['name', 'paragraphId']) || typeof anchor.name !== 'string' || !LAYOUT_BOOKMARK.test(anchor.name)) {
        this.reject('destination is invalid');
      }
      return { anchor: { name: anchor.name, paragraphId: this.id(anchor.paragraphId) } };
    });
    return { version: 1, pages, destinations };
  }
}

/** 按版式 JSON 的规则解析（不可信输入）。不合法时抛 RenderLayoutOutputError。 */
export function parseWordLayout(value: unknown): WordLayout {
  return new Parser().layout(value);
}

/** 校验取回的文件（归档已按模板校验）：正好只有 layout.json，UTF-8 的 JSON，按版式 JSON 的规则解析。 */
export function validateRenderLayoutOutput(files: readonly SandboxFile[]): WordLayout {
  if (files.length !== 1 || files[0]!.path !== LAYOUT_NAME) throw new RenderLayoutOutputError('unexpected files');
  const data = files[0]!.data;
  if (data.length > RENDER_LAYOUT_MAX_LAYOUT_BYTES) throw new RenderLayoutOutputError('layout.json is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new RenderLayoutOutputError('layout.json is not valid json');
  }
  return parseWordLayout(raw);
}

/** 入口在标准输出最后一个非空行给出的错误代码；不在白名单内时为 null。 */
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
  return new JobError('RENDER_LAYOUT_UNAVAILABLE', '格式自检服务暂不可用，请稍后重试', cause === undefined ? undefined : { cause });
}

function sandboxFailure(error: SandboxError): Error {
  if (error.code === 'SANDBOX_ABORTED') return new JobInterruptedError();
  if (error.code === 'SANDBOX_OUTPUT_REJECTED') return new JobError('RENDER_LAYOUT_OUTPUT_REJECTED', '格式自检结果不符合要求，已拒绝', { cause: error });
  if (error.code === 'SANDBOX_UNAVAILABLE') return unavailable(error);
  return new JobError('RENDER_LAYOUT_FAILED', '格式自检失败', { cause: error });
}

/** 在新建的 render-layout 沙箱中测量一个 docx 的分页，返回校验后的版式 JSON。沙箱在 finally 中销毁。 */
export async function renderWordLayout(context: RenderLayoutContext, docx: Buffer, options: RenderLayoutOptions = {}): Promise<WordLayout> {
  const files = buildRenderLayoutRequest(docx);
  if (!context.sandbox) throw unavailable();
  const driver: SandboxDriver = context.sandbox;
  const sandbox = await createSandboxWithRetry(driver, context, {
    template: 'render-layout',
    delaysMs: options.createRetryDelaysMs ?? RENDER_LAYOUT_CREATE_RETRY_DELAYS_MS,
    busy: (cause) => new JobError('RENDER_LAYOUT_SANDBOX_BUSY', '格式自检服务繁忙，请稍后重试', { cause }),
    unavailable,
    busyLog: '沙箱数已达上限，稍后重试',
    unavailableLog: '格式自检服务暂不可用，稍后重试',
  });
  try {
    try {
      await driver.copyIn(sandbox, files, { signal: context.signal });
      const result = await driver.exec(sandbox, 'measure', [], { signal: context.signal });
      if (result.timedOut) throw new JobError('RENDER_LAYOUT_TIMEOUT', '格式自检超时，请稍后重试');
      if (result.exitCode !== 0) {
        const [code, message] = entryError(result.stdout) ?? ['RENDER_LAYOUT_FAILED', '格式自检失败'];
        throw new JobError(code, message);
      }
      return validateRenderLayoutOutput(await driver.copyOut(sandbox, { signal: context.signal }));
    } catch (error) {
      if (error instanceof SandboxError) throw sandboxFailure(error);
      if (error instanceof RenderLayoutOutputError) throw new JobError('RENDER_LAYOUT_OUTPUT_REJECTED', '格式自检结果不符合要求，已拒绝', { cause: error });
      throw error;
    }
  } finally {
    await driver.destroy(sandbox).catch(() => context.log('沙箱销毁失败，将由到期清理删除').catch(() => {}));
  }
}
