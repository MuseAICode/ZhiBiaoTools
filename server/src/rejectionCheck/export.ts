// 废标检查结果导出为 Excel（取代桌面版 checkResultExportService.cjs 的 exportRejectionExcel）：服务端同步生成 xlsx，
// 以附件下载，不需要队列。工作表、列、文案与桌面版相同；只导出输入签名与当前输入一致的检查结果，其余标为“结果已失效”。
// 签名由服务端按当前文档、解析结果和自定义检查项现算（桌面版由 Renderer 传入）。
import { fileTimestamp, formatDisplayTime } from '../xlsx/displayTime.ts';
import { writeWorkbook, type CellValue, type WorksheetSpec } from '../xlsx/writer.ts';
import type { CheckResult, RejectionCheckState } from './store.ts';

const SHEET_NAMES = ['检查概览', '废标项', '错别字', '逻辑问题'] as const;

interface Descriptor<F> {
  source: CheckResult<F>;
  /** 结果的输入签名与当前输入一致。 */
  valid: boolean;
  /** 有效时的问题，失效时为空。 */
  findings: F[];
}

function describe<F>(result: CheckResult<F>, expectedSignature: string): Descriptor<F> {
  const valid = result.inputSignature !== null && result.inputSignature === expectedSignature;
  return { source: result, valid, findings: valid ? result.findings : [] };
}

/** 三类结果与各自应匹配的签名（与桌面版相同：废标项看完整输入，错别字、逻辑问题只看投标文件）。 */
function descriptors(state: RejectionCheckState) {
  return {
    rejection: describe(state.rejectionCheckResult, state.signatures.rejectionInput),
    typo: describe(state.typoCheckResult, state.signatures.bid),
    logic: describe(state.logicCheckResult, state.signatures.bid),
  };
}

/** 是否有可导出的当前结果（与桌面版 selectCurrentRejectionResults 的 exportable 相同）。 */
export function isExportable(state: RejectionCheckState): boolean {
  return Object.values(descriptors(state)).some(
    (descriptor) => descriptor.valid && (descriptor.source.status === 'success' || descriptor.findings.length > 0),
  );
}

function resultStatus(descriptor: Descriptor<unknown>): string {
  const source = descriptor.source;
  if (!descriptor.valid) return source.inputSignature ? '结果已失效' : '未执行';
  if (source.status === 'success') return '已完成';
  if (source.status === 'error') return '失败';
  return '未执行';
}

function resultMessage(descriptor: Descriptor<unknown>): string {
  const source = descriptor.source;
  if (!descriptor.valid) return source.inputSignature ? '结果签名与当前检查输入不一致' : '';
  if (source.status === 'error') return source.error || source.progressMessage || '检查失败';
  if (source.status === 'success' && descriptor.findings.length === 0) return '检查已完成，未发现问题';
  return source.progressMessage ?? '';
}

/** 下载文件名：废标检查结果_YYYYMMDD_HHMMSS.xlsx（与桌面版相同）。 */
export function exportFileName(exportedAt: Date): string {
  return `废标检查结果_${fileTimestamp(exportedAt)}.xlsx`;
}

const SEVERITY_LABELS: Record<string, string> = { high: '高风险', medium: '中风险', low: '低风险' };

/** 按桌面版的工作表结构生成工作簿。 */
export function buildRejectionWorkbook(state: RejectionCheckState, exportedAt: Date): Buffer {
  const { rejection, typo, logic } = descriptors(state);
  const bidNames = state.bidDocuments.map((document) => document.fileName).filter(Boolean).join('；');
  // 投标文件序号与文件名（与桌面版 getDocumentColumns 相同，找不到时留空）。
  const documents = new Map(state.bidDocuments.map((document, index) => [document.id, [index + 1, document.fileName] as CellValue[]]));
  const documentColumns = (bidDocumentId: string): CellValue[] => documents.get(bidDocumentId) ?? ['', ''];
  const definitions: [string, Descriptor<unknown>][] = [
    ['废标项检查', rejection],
    ['错别字检查', typo],
    ['逻辑问题检查', logic],
  ];
  const sheets: WorksheetSpec[] = [
    {
      name: SHEET_NAMES[0],
      rows: [
        ['导出时间', formatDisplayTime(exportedAt)],
        [],
        ['检查类型', '状态', '问题数量', '更新时间', '检查对象', '说明'],
        ...definitions.map(([label, descriptor]) => [
          label,
          resultStatus(descriptor),
          descriptor.findings.length,
          descriptor.source.updatedAt?.toISOString() ?? '',
          bidNames,
          resultMessage(descriptor),
        ]),
      ],
      columnWidths: [16, 14, 12, 22, 32, 42],
    },
    {
      name: SHEET_NAMES[1],
      rows: [
        ['序号', '投标文件序号', '投标文件名', '类型', '风险等级', '标题', '摘要', '招标要求', '投标证据', '风险原因', '修改建议'],
        ...rejection.findings.map((finding, index) => [
          index + 1,
          ...documentColumns(finding.bidDocumentId),
          finding.type === 'invalidBid' ? '无效标' : '废标项',
          SEVERITY_LABELS[finding.severity] ?? '',
          finding.title,
          finding.summary,
          finding.requirement,
          finding.bidEvidence,
          finding.riskReason,
          finding.suggestion,
        ]),
      ],
      columnWidths: [8, 14, 28, 12, 12, 24, 36, 42, 42, 42, 42],
      filterHeaderRow: 0,
    },
    {
      name: SHEET_NAMES[2],
      rows: [
        ['序号', '投标文件序号', '投标文件名', '错误文本', '建议改正', '位置', '原文摘录', '判断原因'],
        ...typo.findings.map((finding, index) => [
          index + 1,
          ...documentColumns(finding.bidDocumentId),
          finding.wrongText,
          finding.correctText,
          finding.locationHint,
          finding.originalExcerpt,
          finding.reason,
        ]),
      ],
      columnWidths: [8, 14, 28, 18, 18, 26, 48, 38],
      filterHeaderRow: 0,
    },
    {
      name: SHEET_NAMES[3],
      rows: [
        ['序号', '投标文件序号', '投标文件名', '标题', '位置', '原文', '问题原因', '修改建议'],
        ...logic.findings.map((finding, index) => [
          index + 1,
          ...documentColumns(finding.bidDocumentId),
          finding.title,
          finding.locationHint,
          finding.originalText,
          finding.fallacyReason,
          finding.suggestion,
        ]),
      ],
      columnWidths: [8, 14, 28, 24, 28, 48, 42, 42],
      filterHeaderRow: 0,
    },
  ];
  return writeWorkbook({ title: '废标检查结果', createdAt: exportedAt, sheets });
}
