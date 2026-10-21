// 标书查重结果导出为 Excel（取代桌面版 checkResultExportService.cjs 的 exportDuplicateExcel）：服务端同步生成 xlsx，
// 以附件下载，不需要队列。工作表、列、文案与桌面版相同；只导出签名与当前文件选择一致的分析结果，其余标为“结果已失效”。
import { fileTimestamp, formatDisplayTime } from '../xlsx/displayTime.ts';
import { writeWorkbook, type CellValue, type WorksheetSpec } from '../xlsx/writer.ts';
import type { DuplicateCheckState } from './store.ts';

const SHEET_NAMES = ['查重概览', '元数据', '目录重复', '文件相似度', '重复句子', '重复图片'] as const;

type Field = 'metadataAnalysis' | 'outlineAnalysis' | 'contentAnalysis' | 'imageAnalysis';
type Analysis = NonNullable<DuplicateCheckState[Field]>;

interface Descriptor<T extends Analysis = Analysis> {
  source: T | null;
  /** 有结果且签名与当前文件选择一致。 */
  valid: boolean;
}

function describe<T extends Analysis>(analysis: T | null, signature: string): Descriptor<T> {
  return { source: analysis, valid: analysis !== null && analysis.signature === signature };
}

function countRows(field: Field, analysis: Analysis | null): number {
  if (!analysis) return 0;
  if (field === 'metadataAnalysis') return (analysis as NonNullable<DuplicateCheckState['metadataAnalysis']>).rows.length;
  if (field === 'outlineAnalysis') return (analysis as NonNullable<DuplicateCheckState['outlineAnalysis']>).duplicateGroups.length;
  if (field === 'contentAnalysis') return (analysis as NonNullable<DuplicateCheckState['contentAnalysis']>).duplicateSentences.length;
  return (analysis as NonNullable<DuplicateCheckState['imageAnalysis']>).duplicateImages.length;
}

function hasRows(field: Field, analysis: Analysis | null): boolean {
  if (countRows(field, analysis) > 0) return true;
  return field === 'outlineAnalysis' && (analysis as NonNullable<DuplicateCheckState['outlineAnalysis']>).pairwiseSimilarities.length > 0;
}

const FIELDS: readonly Field[] = ['metadataAnalysis', 'outlineAnalysis', 'contentAnalysis', 'imageAnalysis'];

/** 是否有可导出的当前结果（与桌面版 selectCurrentDuplicateResults 的 exportable 相同）。 */
export function isExportable(state: DuplicateCheckState): boolean {
  return FIELDS.some((field) => {
    const descriptor = describe(state[field], state.signature);
    return descriptor.valid && (descriptor.source!.status === 'success' || hasRows(field, descriptor.source));
  });
}

function resultStatus(descriptor: Descriptor): string {
  const source = descriptor.source;
  if (!source) return '未执行';
  if (!descriptor.valid) return source.signature ? '结果已失效' : '未执行';
  if (source.status === 'success') return '已完成';
  if (source.status === 'error') return '失败';
  return '未执行';
}

function resultMessage(descriptor: Descriptor, resultCount: number, emptyMessage: string): string {
  const source = descriptor.source;
  if (!source) return '';
  if (!descriptor.valid) return source.signature ? '结果签名与当前检查输入不一致' : '';
  if (source.status === 'error') return source.message || '检查失败';
  if (source.status === 'success' && resultCount === 0) return emptyMessage;
  return source.message;
}

/** 下载文件名：标书查重结果_YYYYMMDD_HHMMSS.xlsx（与桌面版相同）。 */
export function exportFileName(exportedAt: Date): string {
  return `标书查重结果_${fileTimestamp(exportedAt)}.xlsx`;
}

function joinFileNames(fileIds: string[], fileNames: Map<string, string>): string {
  return fileIds
    .map((fileId) => fileNames.get(fileId) || fileId)
    .filter(Boolean)
    .join('；');
}

const percent = (value: number): CellValue => ({ percent: Number(value || 0) });

/** 按桌面版的工作表结构生成工作簿。 */
export function buildDuplicateWorkbook(state: DuplicateCheckState, exportedAt: Date): Buffer {
  const signature = state.signature;
  const metadata = describe(state.metadataAnalysis, signature);
  const outline = describe(state.outlineAnalysis, signature);
  const content = describe(state.contentAnalysis, signature);
  const image = describe(state.imageAnalysis, signature);
  const descriptors: Record<Field, Descriptor> = { metadataAnalysis: metadata, outlineAnalysis: outline, contentAnalysis: content, imageAnalysis: image };

  const fileNames = new Map([...state.tenderFiles, ...state.bidFiles].map((file) => [file.id, file.fileName]));
  const tenderNames = state.tenderFiles.map((file) => file.fileName).filter(Boolean).join('；');
  const bidNames = state.bidFiles.map((file) => file.fileName).filter(Boolean).join('；');
  const definitions: [string, Field][] = [
    ['元数据', 'metadataAnalysis'],
    ['目录', 'outlineAnalysis'],
    ['正文', 'contentAnalysis'],
    ['图片', 'imageAnalysis'],
  ];
  const sheets: WorksheetSpec[] = [];

  sheets.push({
    name: SHEET_NAMES[0],
    rows: [
      ['导出时间', formatDisplayTime(exportedAt)],
      [],
      ['分析维度', '状态', '结果数量', '更新时间', '招标文件', '投标文件', '说明'],
      ...definitions.map(([label, field]) => {
        const descriptor = descriptors[field];
        const resultCount = descriptor.valid ? countRows(field, descriptor.source) : 0;
        return [
          label,
          resultStatus(descriptor),
          resultCount,
          descriptor.source?.updatedAt.toISOString() ?? '',
          tenderNames,
          bidNames,
          resultMessage(descriptor, resultCount, '分析已完成，未发现重复项'),
        ];
      }),
      [],
      ['统计项', '数值'],
      ['识别图片总数', image.valid ? image.source!.totalImageCount : 0],
      ['招标目录排除数量', outline.valid ? outline.source!.tenderMatchedItemCount : 0],
      ['招标引用句子排除数量', content.valid ? content.source!.tenderMatchedSentenceCount : 0],
      ['正文句子总量', content.valid ? content.source!.totalSentenceCount : 0],
    ],
    columnWidths: [16, 14, 12, 22, 30, 34, 42],
  });

  const metadataSource = metadata.valid ? metadata.source : null;
  sheets.push({
    name: SHEET_NAMES[1],
    rows: [
      ['元数据项', '重复文件', '同日文件', ...state.bidFiles.map((file, index) => `投标文件${index + 1}：${file.fileName}`)],
      ...(metadataSource?.rows ?? []).map((row) => [
        row.label,
        joinFileNames(row.duplicateFileIds, fileNames),
        joinFileNames(row.sameDayFileIds, fileNames),
        ...state.bidFiles.map((file) => row.values[file.id]),
      ]),
    ],
    columnWidths: [24, 32, 32, ...state.bidFiles.map(() => 32)],
    filterHeaderRow: 0,
  });

  const outlineSource = outline.valid ? outline.source : null;
  sheets.push({
    name: SHEET_NAMES[2],
    rows: [
      ['序号', '类型', '标题', '相似度', '涉及文件', '路径明细'],
      ...(outlineSource?.duplicateGroups ?? []).map((group, index) => [
        index + 1,
        group.type === 'duplicate' ? '重复' : '相似',
        group.title,
        percent(group.score),
        joinFileNames(group.fileIds, fileNames),
        group.fileIds.flatMap((fileId) => (group.paths[fileId] ?? []).map((itemPath) => `${fileNames.get(fileId) || fileId}：${itemPath}`)).join('；'),
      ]),
    ],
    columnWidths: [8, 10, 32, 12, 34, 64],
    filterHeaderRow: 0,
  });

  const riskLabels: Record<string, string> = { high: '高', medium: '中', low: '低', none: '无' };
  sheets.push({
    name: SHEET_NAMES[3],
    rows: [
      ['文件 A', '文件 B', '综合相似度', '标题重合度', '路径重合度', '顺序相似度', '共享目录数量', '风险等级'],
      ...(outlineSource?.pairwiseSimilarities ?? []).map((item) => [
        fileNames.get(item.fileAId) || item.fileAId,
        fileNames.get(item.fileBId) || item.fileBId,
        percent(item.score),
        percent(item.titleOverlap),
        percent(item.pathOverlap),
        percent(item.orderSimilarity),
        item.sharedCount,
        riskLabels[item.risk] ?? '无',
      ]),
    ],
    columnWidths: [28, 28, 14, 14, 14, 14, 14, 12],
    filterHeaderRow: 0,
  });

  const occurrenceText = (fileIds: string[], occurrences: Record<string, number>) =>
    fileIds.map((fileId) => `${fileNames.get(fileId) || fileId} × ${Number(occurrences[fileId] ?? 0)}`).join('；');

  const contentSource = content.valid ? content.source : null;
  sheets.push({
    name: SHEET_NAMES[4],
    rows: [
      ['序号', '重复句子', '涉及文件', '各文件出现次数', '总出现次数'],
      ...(contentSource?.duplicateSentences ?? []).map((item, index) => [
        index + 1,
        item.sentence,
        joinFileNames(item.fileIds, fileNames),
        occurrenceText(item.fileIds, item.occurrences),
        Object.values(item.occurrences).reduce((sum, value) => sum + Number(value || 0), 0),
      ]),
    ],
    columnWidths: [8, 72, 34, 48, 14],
    filterHeaderRow: 0,
  });

  const imageSource = image.valid ? image.source : null;
  sheets.push({
    name: SHEET_NAMES[5],
    rows: [
      ['序号', '图片 Hash', '涉及文件', '各文件出现次数', '出现位置', '图片前文'],
      ...(imageSource?.duplicateImages ?? []).map((item, index) => {
        const entries = item.fileIds.flatMap((fileId) => (item.locations[fileId] ?? []).map((location) => ({ fileId, location })));
        return [
          index + 1,
          item.hash,
          joinFileNames(item.fileIds, fileNames),
          occurrenceText(item.fileIds, item.occurrences),
          entries
            .map(({ fileId, location }) => {
              const indexText = location.imageIndex === null ? '' : `（图片 ${location.imageIndex}）`;
              return `${fileNames.get(fileId) || fileId}：${location.directory || '未识别目录'}${indexText}`;
            })
            .join('；'),
          entries.map(({ fileId, location }) => `${fileNames.get(fileId) || fileId}：${location.previousSentence}`).join('；'),
        ];
      }),
    ],
    columnWidths: [8, 40, 34, 48, 64, 72],
    filterHeaderRow: 0,
  });

  return writeWorkbook({ title: '标书查重结果', createdAt: exportedAt, sheets });
}
