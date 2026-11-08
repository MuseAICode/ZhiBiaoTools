// 在 export-feasibility 沙箱中生成可研报告 Word（路线图第 7 步 7.5b；#61 决定事项第 1 项方案 A；docs/SERVER_DESIGN.md 第 7.9 节）。
// 可研导出任务（7.5d）调用，本模块不接任务与接口。
//
// 沙箱中运行的是与桌面版同一份的 exportService.buildDocxResult（server/sandbox/export/feasibility.mjs），这里只负责：
// - request.json：{ project_name, outline, export_format, feasibility_options }，只放组装所需的字段（目录节点只有 id、title、
//   description、content、children；导出选项只有桌面版的六项与项目信息），不转发任何其他字段；
// - 配图：正文中引用的、本项目可见的图片产物（由调用方解析）以 assets/<产物 id> 经 objectInputFile 按需读取、流式放入；
//   沙箱只认 /api/artifacts/<uuid>/content 与 data URL 两种来源，其余在原位提示（与桌面版找不到图片时相同的文字）；
// - 新建沙箱之前按 export-feasibility 模板的输入规则检查（与整本导出相同：配图 2,000 张、合计 128 MiB）；
// - 输出校验（validateFeasibilityExportOutput）与失败的映射与整本导出相同（runExportSandbox）；
// - 消息与桌面版 export.word 相同：有提示时“Word 已导出，但有 N 处图片未能插入，请打开文档核对。”。
import type { ObjectStore } from '../files/objectStore.ts';
import { SANDBOX_TEMPLATES } from '../sandbox/templates.ts';
import type { ExportFormat } from '../templates/exportFormat.ts';
import { checkDocumentInputSize, runExportSandbox, type DocumentExportAsset, type DocumentExportContext, type DocumentExportOptions } from './document.ts';
import { validateFeasibilityExportOutput } from './output.ts';

/** 可研目录的一个节点（交给桌面版代码的字段）。 */
export interface FeasibilityExportOutlineItem {
  id: string;
  title: string;
  description?: string;
  content?: string;
  children?: FeasibilityExportOutlineItem[];
}

/** 与桌面版 Renderer 的 FeasibilityExportOptions 相同（documentCode 已由调用方补齐）。 */
export interface FeasibilityExportOptions {
  includeCover: boolean;
  includePreparationNotes: boolean;
  includeAppendixTables: boolean;
  preparationUnit: string;
  securityLevel: string;
  documentCode: string;
  /** 与桌面版 FeasibilityProjectInfo 相同的字段（值都是字符串）。 */
  projectInfo: Readonly<Record<string, string>>;
}

export interface FeasibilityExportInput {
  projectName: string;
  outline: readonly FeasibilityExportOutlineItem[];
  /** 规范化后的模板配置。 */
  exportFormat: ExportFormat;
  options: FeasibilityExportOptions;
  /** 本项目可见的图片产物（正文中引用的）。 */
  assets: readonly DocumentExportAsset[];
}

export interface FeasibilityExportResult {
  docx: Buffer;
  warnings: string[];
  message: string;
}

const FEASIBILITY_LIMITS = SANDBOX_TEMPLATES['export-feasibility'].input;

/** 与桌面版 exportService.exportWord 没有 buildResult.message 时的消息相同。 */
export function feasibilityExportMessage(warnings: readonly string[]): string {
  return warnings.length
    ? `Word 已导出，但有 ${warnings.length} 处图片未能插入，请打开文档核对。`
    : 'Word 已导出，请打开文档核对图片、表格和版式。';
}

function outlineItems(items: readonly FeasibilityExportOutlineItem[]): FeasibilityExportOutlineItem[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.content !== undefined ? { content: item.content } : {}),
    ...(item.children?.length ? { children: outlineItems(item.children) } : {}),
  }));
}

/** 交给沙箱的 request.json：只有桌面版 buildDocxResult 用到的四个字段（见文件头）。 */
export function buildFeasibilityRequest(input: Omit<FeasibilityExportInput, 'assets'>): Buffer {
  const { options } = input;
  return Buffer.from(JSON.stringify({
    project_name: input.projectName,
    outline: outlineItems(input.outline),
    export_format: input.exportFormat,
    feasibility_options: {
      includeCover: options.includeCover,
      includePreparationNotes: options.includePreparationNotes,
      includeAppendixTables: options.includeAppendixTables,
      preparationUnit: options.preparationUnit,
      securityLevel: options.securityLevel,
      documentCode: options.documentCode,
      project_info: { ...options.projectInfo },
    },
  }), 'utf8');
}

/** 在新建的 export-feasibility 沙箱中生成可研报告 Word，返回校验过的 docx、提示与消息。沙箱在 finally 中销毁。 */
export async function renderFeasibilityReportDocument(
  context: DocumentExportContext,
  objectStore: Pick<ObjectStore, 'get'>,
  input: FeasibilityExportInput,
  options: DocumentExportOptions = {},
): Promise<FeasibilityExportResult> {
  const request = buildFeasibilityRequest(input);
  checkDocumentInputSize(request, input.assets, FEASIBILITY_LIMITS);
  const output = await runExportSandbox(
    context,
    objectStore,
    { template: 'export-feasibility', request, assets: input.assets, validate: validateFeasibilityExportOutput },
    options,
  );
  return { docx: output.docx, warnings: output.warnings, message: feasibilityExportMessage(output.warnings) };
}
