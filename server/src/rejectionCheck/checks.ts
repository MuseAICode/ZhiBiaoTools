// 废标项、错别字、逻辑谬误三类检查（取代桌面版 rejectionCheckTask.cjs 的 runRejectionItemCheck / runTypoCheck / runLogicCheck 及其
// 整理、滚动状态与去重函数，流程原样搬运），提示词见 src/rejectionCheck/prompts.ts。
//
// - 输入不超过上下文长度的 60% 时一次检查（废标项分析、检查、定稿三轮）；超过时按投标包分段滚动检查：每段返回增量 patch，
//   由程序合并为累计状态，最后按 20 条一批定稿、全局合稿；错别字按文件分段检查（70%）。
// - 模型输出是不可信数据：逐字段整理、截短，bidDocumentId 必须是输入中的投标文件（只有一份投标文件时缺省为它），
//   错别字必须能在原文中找到，摘录与位置由程序按原文重新生成，不采用模型的摘录。
// - 与桌面版的差异：模型没给 id 时，桌面版用随机 id，这里按内容的哈希生成：滚动检查和合稿的请求中带有这些 id，续跑时
//   同一步骤的请求必须与上次相同，才能取回已保存的结果、不再扣费（路线图 6.4a）。保存前问题 id 统一改为
//   rejection-finding-1 等（src/rejectionCheck/jobs.ts），不采用模型给出的 id。
import { createHash } from 'node:crypto';
import { splitTextByContextLimit, type SplitOptions } from '../ai/textSplit.ts';
import type { JobChat } from '../jobs/chat.ts';
import type { RejectionCheckFindingType, RejectionCheckSeverity } from '../db/schema.ts';
import {
  bidDocumentDisplayName,
  buildLogicCheckMessages,
  buildLogicFinalBatchMessages,
  buildLogicGlobalMergeMessages,
  buildRejectionCheckAnalysisMessages,
  buildRejectionCheckFinalMessages,
  buildRejectionCheckInspectionMessages,
  buildRejectionFinalBatchMessages,
  buildRejectionGlobalMergeMessages,
  buildRollingLogicSegmentMessages,
  buildRollingRejectionSegmentMessages,
  buildTypoCheckMessages,
  formatBidDocumentsForPrompt,
  type BidDocumentInput,
  type BidSegment,
  type RejectionInput,
} from './prompts.ts';

const TYPO_EXCERPT_RADIUS = 8;
const FULL_PROMPT_LIMIT_RATIO = 0.6;
const ROLLING_SEGMENT_LIMIT_RATIO = 0.55;
const TYPO_SEGMENT_LIMIT_RATIO = 0.7;
const ROLLING_SUMMARY_EVIDENCE_LIMIT = 60;
const ROLLING_SUMMARY_RESOLVED_LIMIT = 40;
const ROLLING_SUMMARY_CONFIRMED_LIMIT = 60;
const FINAL_CANDIDATE_BATCH_SIZE = 20;

type Item = Record<string, unknown>;

export type Progress = (message: string) => void;

/** 检查的公共参数：模型调用与上下文长度（测试中用很小的值触发分段）。 */
export interface CheckRuntime {
  chat: JobChat;
  split?: Pick<SplitOptions, 'contextLengthLimit'>;
}

export interface RiskFindingDraft {
  id: string;
  bidDocumentId: string;
  type: RejectionCheckFindingType;
  severity: RejectionCheckSeverity;
  title: string;
  summary: string;
  requirement: string;
  bidEvidence: string;
  riskReason: string;
  suggestion: string;
}

export interface TypoFindingDraft {
  id: string;
  bidDocumentId: string;
  wrongText: string;
  correctText: string;
  originalExcerpt: string;
  reason: string;
  locationHint: string;
  /** 在原文中的位置（UTF-16 下标），只用于去重，不保存。 */
  position: number;
}

export interface LogicFindingDraft {
  id: string;
  bidDocumentId: string;
  title: string;
  originalText: string;
  locationHint: string;
  fallacyReason: string;
  suggestion: string;
}

// ---- 通用整理 ----

/** 与桌面版 normalizeText 相同：假值为空串，其余转成字符串并去掉首尾空白。 */
function text(value: unknown): string {
  return String(value || '').trim();
}

function isItem(value: unknown): value is Item {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 模型没给 id 时按内容生成（同一输出得到同一 id）。 */
function contentId(prefix: string, item: Item): string {
  return `${prefix}_${createHash('sha1').update(JSON.stringify(item)).digest('hex').slice(0, 12)}`;
}

function getArrayPayload(parsed: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!isItem(parsed)) return [];
  for (const key of keys) {
    const value = parsed[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function bidDocumentIdOf(item: Item, bidDocumentIds: ReadonlySet<string>): string {
  const candidates = [item.bidDocumentId, item.bid_document_id, item.documentId, item.document_id, item.fileId, item.file_id, item.sourceFile, item.source_file]
    .map(text)
    .filter(Boolean);
  for (const candidate of candidates) if (bidDocumentIds.has(candidate)) return candidate;
  return bidDocumentIds.size === 1 ? [...bidDocumentIds][0]! : '';
}

function idSet(bidDocuments: readonly BidDocumentInput[]): Set<string> {
  return new Set(bidDocuments.map((document) => document.id).filter(Boolean));
}

function packageBidDocumentId(item: Item, bidDocuments: readonly BidDocumentInput[], fallback = ''): string {
  const ids = idSet(bidDocuments);
  return bidDocumentIdOf(item, ids) || (ids.has(fallback) ? fallback : '');
}

function normalizeFindingType(value: unknown): RejectionCheckFindingType {
  const raw = String(value || '').trim();
  return raw === 'invalidBid' || raw.includes('无效') ? 'invalidBid' : 'rejectionItem';
}

function normalizeSeverity(value: unknown): RejectionCheckSeverity {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'high' || raw.includes('高')) return 'high';
  if (raw === 'low' || raw.includes('低')) return 'low';
  return 'medium';
}

/** 与桌面版 truncatePromptText 相同（按 UTF-16 长度截短并加省略号）。 */
function truncate(value: unknown, maxLength: number): string {
  const normalized = text(value);
  if (!normalized || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function limitDedupe<T>(items: readonly T[], maxCount: number, keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (!item) continue;
    const key = text(keyOf(item)) || JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maxCount) break;
  }
  return result;
}

function dedupe<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return limitDedupe(items, Number.MAX_SAFE_INTEGER, keyOf);
}

const SEP = '\u0000';

// ---- 结果整理 ----

export function normalizeRejectionCheckFindings(parsed: unknown, bidDocuments: readonly BidDocumentInput[]): RiskFindingDraft[] {
  const ids = idSet(bidDocuments);
  return getArrayPayload(parsed, ['findings', 'items', 'risks'])
    .filter(isItem)
    .map((item) => {
      const title = text(item.title).slice(0, 80);
      return {
        id: text(item.id) || contentId('rejection_finding', item),
        bidDocumentId: bidDocumentIdOf(item, ids),
        type: normalizeFindingType(item.type),
        severity: normalizeSeverity(item.severity),
        title,
        summary: text(item.summary) || title,
        requirement: text(item.requirement || item.source) || '未明确引用具体检查依据，请人工复核。',
        bidEvidence: text(item.bidEvidence || item.evidence || item.bid_evidence),
        riskReason: text(item.riskReason || item.reason || item.risk_reason),
        suggestion: text(item.suggestion) || '请结合招标文件要求和投标文件原文人工复核后处理。',
      };
    })
    .filter((item) => item.bidDocumentId && item.title && item.bidEvidence && item.riskReason);
}

interface SegmentRange {
  segmentStartOffset?: number;
  segmentEndOffset?: number;
}

function findVerifiedTypoPosition(content: string, wrongText: string, originalExcerpt: string, range: SegmentRange = {}): number {
  if (!wrongText) return -1;
  const start = Number.isFinite(Number(range.segmentStartOffset)) ? Math.max(0, Math.floor(Number(range.segmentStartOffset))) : 0;
  const end = Number.isFinite(Number(range.segmentEndOffset))
    ? Math.min(content.length, Math.max(start, Math.floor(Number(range.segmentEndOffset))))
    : content.length;
  if (start > 0 || end < content.length) {
    const segment = content.slice(start, end);
    if (originalExcerpt) {
      const excerptIndex = segment.indexOf(originalExcerpt);
      const wrongInExcerpt = originalExcerpt.indexOf(wrongText);
      if (excerptIndex >= 0 && wrongInExcerpt >= 0) return start + excerptIndex + wrongInExcerpt;
    }
    const wrongInSegment = segment.indexOf(wrongText);
    if (wrongInSegment >= 0) return start + wrongInSegment;
  }
  if (originalExcerpt) {
    const excerptIndex = content.indexOf(originalExcerpt);
    const wrongInExcerpt = originalExcerpt.indexOf(wrongText);
    if (excerptIndex >= 0 && wrongInExcerpt >= 0) return excerptIndex + wrongInExcerpt;
  }
  return content.indexOf(wrongText);
}

function verifiedTypoExcerpt(content: string, position: number, wrongText: string): string {
  let start = Math.max(0, position - TYPO_EXCERPT_RADIUS);
  let end = Math.min(content.length, position + wrongText.length + TYPO_EXCERPT_RADIUS);
  // 摘录不从 HTML 标签中间开始或结束。
  const startTagOpen = content.lastIndexOf('<', start);
  const startTagClose = content.lastIndexOf('>', start);
  if (startTagOpen > startTagClose) {
    const tagEnd = content.indexOf('>', start);
    if (tagEnd >= 0 && tagEnd < position) start = tagEnd + 1;
  }
  const endTagOpen = content.lastIndexOf('<', end);
  const endTagClose = content.lastIndexOf('>', end);
  if (endTagOpen > endTagClose) {
    const tagEnd = content.indexOf('>', end);
    if (tagEnd >= 0) end = Math.min(content.length, tagEnd + 1);
  }
  return content.slice(start, end).trim();
}

function lineLocationHint(content: string, position: number): string {
  return `原文第 ${content.slice(0, Math.max(0, position)).split(/\r\n|\r|\n/).length} 行附近`;
}

export function normalizeTypoCheckFindings(parsed: unknown, bidDocuments: readonly BidDocumentInput[], range: SegmentRange = {}): TypoFindingDraft[] {
  const ids = idSet(bidDocuments);
  const byId = new Map(bidDocuments.map((document) => [document.id, document]));
  const seen = new Set<string>();
  const findings: TypoFindingDraft[] = [];
  for (const item of getArrayPayload(parsed, ['findings', 'items', 'typos'])) {
    if (!isItem(item)) continue;
    const bidDocumentId = bidDocumentIdOf(item, ids);
    const document = byId.get(bidDocumentId);
    if (!document?.content) continue;
    const wrongText = text(item.wrongText || item.wrong_text || item.wrong || item.typo).slice(0, 60);
    const correctText = text(item.correctText || item.correct_text || item.correct || item.suggestion).slice(0, 60);
    const originalExcerpt = text(item.originalExcerpt || item.original_excerpt || item.excerpt || item.context);
    const reason = text(item.reason || item.riskReason || item.detail) || '疑似错别字，请结合原文复核。';
    if (!wrongText || !correctText || wrongText === correctText) continue;
    const position = findVerifiedTypoPosition(document.content, wrongText, originalExcerpt, range);
    if (position < 0) continue;
    const key = [bidDocumentId, wrongText, correctText, position].join(SEP);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      id: text(item.id) || contentId('typo_finding', item),
      bidDocumentId,
      wrongText,
      correctText,
      originalExcerpt: verifiedTypoExcerpt(document.content, position, wrongText),
      reason,
      locationHint: lineLocationHint(document.content, position),
      position,
    });
  }
  return findings;
}

export function normalizeLogicCheckFindings(parsed: unknown, bidDocuments: readonly BidDocumentInput[]): LogicFindingDraft[] {
  const ids = idSet(bidDocuments);
  const seen = new Set<string>();
  const findings: LogicFindingDraft[] = [];
  for (const item of getArrayPayload(parsed, ['findings', 'items', 'risks', 'issues'])) {
    if (!isItem(item)) continue;
    const bidDocumentId = bidDocumentIdOf(item, ids);
    const title = text(item.title || item.summary).slice(0, 80);
    const originalText = text(item.originalText || item.original_text || item.evidence || item.bidEvidence) || '未提供明确原文摘录，请结合位置线索复核。';
    const locationHint = text(item.locationHint || item.location_hint || item.location || item.position) || '未明确具体位置，请结合原文摘录复核。';
    const fallacyReason = text(item.fallacyReason || item.fallacy_reason || item.reason || item.riskReason);
    const suggestion = text(item.suggestion || item.recommendation) || '请结合投标文件上下文人工复核后修改。';
    if (!bidDocumentId || !title || !fallacyReason) continue;
    const key = [bidDocumentId, title, fallacyReason].join(SEP);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ id: text(item.id) || contentId('logic_finding', item), bidDocumentId, title, originalText, locationHint, fallacyReason, suggestion });
  }
  return findings;
}

function dedupeRejectionFindings(findings: readonly RiskFindingDraft[]): RiskFindingDraft[] {
  return dedupe(findings, (item) => [item.bidDocumentId, item.type, item.title, item.bidEvidence, item.riskReason].join(SEP));
}

function dedupeTypoFindings(findings: readonly TypoFindingDraft[]): TypoFindingDraft[] {
  return dedupe(findings, (item) => [item.bidDocumentId, item.wrongText, item.correctText, String(Math.floor(item.position))].join(SEP));
}

function dedupeLogicFindings(findings: readonly LogicFindingDraft[]): LogicFindingDraft[] {
  return dedupe(findings, (item) => [item.bidDocumentId, item.title, item.locationHint, item.fallacyReason].join(SEP));
}

// ---- 分段 ----

interface DocumentSegment {
  content: string;
  startOffset: number;
  endOffset: number;
  segmentIndex: number;
  totalSegments: number;
}

function documentSegments(document: BidDocumentInput, split: CheckRuntime['split'], limitRatio: number): DocumentSegment[] {
  const parts = splitTextByContextLimit(document.content, { ...split, limitRatio });
  let startOffset = 0;
  return parts.map((content, index) => {
    const endOffset = startOffset + content.length;
    const segment = { content, startOffset, endOffset, segmentIndex: index + 1, totalSegments: parts.length };
    startOffset = endOffset;
    return segment;
  });
}

function packageSegments(bidDocuments: readonly BidDocumentInput[], split: CheckRuntime['split'], limitRatio: number): BidSegment[] {
  const local: Omit<BidSegment, 'segmentIndex' | 'totalSegments'>[] = [];
  for (const [documentIndex, document] of bidDocuments.entries()) {
    const documentLabel = bidDocumentDisplayName(document, documentIndex);
    for (const segment of documentSegments(document, split, limitRatio)) {
      local.push({
        documentId: document.id,
        documentLabel,
        content: `【${documentLabel}｜bidDocumentId：${document.id}｜文件名：${document.fileName || document.id}】\n【当前文件片段：第 ${segment.segmentIndex}/${segment.totalSegments} 段】\n${segment.content}`,
      });
    }
  }
  return local.map((segment, index) => ({ ...segment, segmentIndex: index + 1, totalSegments: local.length }));
}

function needsSegments(promptText: string, split: CheckRuntime['split'], limitRatio = FULL_PROMPT_LIMIT_RATIO): boolean {
  return splitTextByContextLimit(promptText, { ...split, limitRatio }).length > 1;
}

/** 废标项检查是否走滚动检查（与桌面版 shouldUseSegmentedRejectionFlow 相同）。 */
export function usesSegmentedRejectionFlow(input: RejectionInput, split: CheckRuntime['split']): boolean {
  return needsSegments([input.invalidBidAndRejectionItems, input.customCheckItems, formatBidDocumentsForPrompt(input.bidDocuments)].join('\n\n'), split);
}

/** 错别字、逻辑检查是否分段（与桌面版 shouldUseSegmentedBidDocuments 相同）。 */
export function usesSegmentedBidDocuments(bidDocuments: readonly BidDocumentInput[], split: CheckRuntime['split']): boolean {
  return needsSegments(formatBidDocumentsForPrompt(bidDocuments), split);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function takeRecent<T>(items: readonly T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

function sequentialId(prefix: string, sequence: number): string {
  return `${prefix}_${String(sequence).padStart(4, '0')}`;
}

function patchReferenceId(item: Item, keys: readonly string[]): string {
  for (const key of keys) {
    const value = text(item[key]);
    if (value) return value;
  }
  return '';
}

/** 与桌面版 mergeDefinedFields 相同：只覆盖给出且非空的字段。 */
function mergeDefined<T extends object>(target: T, update: Partial<Record<keyof T, unknown>>, fields: readonly (keyof T)[]): T {
  const next = { ...target };
  for (const field of fields) {
    const value = update[field];
    if (value !== undefined && value !== '') (next as Record<keyof T, unknown>)[field] = value;
  }
  return next;
}

// ---- 废标项滚动检查的累计状态 ----

interface Evidence {
  id: string;
  bidDocumentId: string;
  name: string;
  evidence: string;
  locationHint: string;
  source: string;
}

interface PendingRisk {
  id: string;
  bidDocumentId: string;
  type: RejectionCheckFindingType;
  severity: RejectionCheckSeverity;
  title: string;
  summary: string;
  requirement: string;
  bidEvidence: string;
  riskReason: string;
  suggestion: string;
  statusReason: string;
  locationHint?: string;
}

interface Resolved {
  id: string;
  riskId?: string;
  issueId?: string;
  title: string;
  reason: string;
  locationHint: string | undefined;
}

interface RejectionState {
  nextEvidenceSeq: number;
  nextRiskSeq: number;
  submittedEvidence: Evidence[];
  pendingRisks: PendingRisk[];
  resolvedRisks: Resolved[];
  confirmedRisks: (RiskFindingDraft | PendingRisk)[];
}

type RiskUpdate = Partial<Omit<PendingRisk, 'id'>> & { id: string };

interface ResolveInput {
  id: string;
  title: string;
  reason: string;
  locationHint: string;
}

interface RejectionPatch {
  evidenceAdds: Omit<Evidence, 'id'>[];
  pendingRiskAdds: Omit<PendingRisk, 'id'>[];
  pendingRiskUpdates: RiskUpdate[];
  pendingRiskResolves: ResolveInput[];
  confirmedRiskAdds: RiskFindingDraft[];
}

function rollingEvidence(item: unknown, bidDocuments: readonly BidDocumentInput[], fallback: string): Omit<Evidence, 'id'> | null {
  if (!isItem(item)) return null;
  const name = truncate(item.name || item.title || item.material || item.item || item.requirement, 80);
  const evidence = truncate(item.evidence || item.originalText || item.original_text || item.excerpt || item.content || item.description, 600);
  if (!name && !evidence) return null;
  return {
    bidDocumentId: packageBidDocumentId(item, bidDocuments, fallback),
    name: name || truncate(evidence, 80),
    evidence,
    locationHint: truncate(item.locationHint || item.location_hint || item.location || item.position, 160),
    source: truncate(item.source || item.requirement || item.reason, 240),
  };
}

function rollingRisk(item: unknown, bidDocuments: readonly BidDocumentInput[], fallback: string): Omit<PendingRisk, 'id'> | null {
  if (!isItem(item)) return null;
  const title = truncate(item.title || item.summary || item.requirement, 80);
  if (!title) return null;
  return {
    bidDocumentId: packageBidDocumentId(item, bidDocuments, fallback),
    type: normalizeFindingType(item.type),
    severity: normalizeSeverity(item.severity),
    title,
    summary: truncate(item.summary || title, 180),
    requirement: truncate(item.requirement || item.source, 360),
    bidEvidence: truncate(item.bidEvidence || item.evidence || item.bid_evidence, 600),
    riskReason: truncate(item.riskReason || item.reason || item.risk_reason, 600),
    suggestion: truncate(item.suggestion || item.recommendation, 300),
    statusReason: truncate(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

const RISK_ID_KEYS = ['id', 'riskId', 'risk_id', 'pendingRiskId', 'pending_risk_id'] as const;

function rollingRiskUpdate(item: unknown, bidDocuments: readonly BidDocumentInput[], fallback: string): RiskUpdate | null {
  if (!isItem(item)) return null;
  const id = patchReferenceId(item, RISK_ID_KEYS);
  if (!id) return null;
  return {
    id,
    bidDocumentId: packageBidDocumentId(item, bidDocuments, fallback),
    ...(item.type ? { type: normalizeFindingType(item.type) } : {}),
    ...(item.severity ? { severity: normalizeSeverity(item.severity) } : {}),
    title: truncate(item.title || item.summary || item.requirement, 80),
    summary: truncate(item.summary, 180),
    requirement: truncate(item.requirement || item.source, 360),
    bidEvidence: truncate(item.bidEvidence || item.evidence || item.bid_evidence, 600),
    riskReason: truncate(item.riskReason || item.reason || item.risk_reason, 600),
    suggestion: truncate(item.suggestion || item.recommendation, 300),
    statusReason: truncate(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

function rollingResolve(item: unknown, keys: readonly string[]): ResolveInput | null {
  if (!isItem(item)) return null;
  const id = patchReferenceId(item, keys);
  if (!id) return null;
  return {
    id,
    title: truncate(item.title || item.summary || item.name, 100),
    reason: truncate(item.reason || item.resolvedReason || item.resolved_reason || item.evidence, 360),
    locationHint: truncate(item.locationHint || item.location_hint || item.location, 160),
  };
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

function normalizeRollingRejectionPatch(parsed: unknown, bidDocuments: readonly BidDocumentInput[], fallback: string): RejectionPatch {
  const source = isItem(parsed) ? parsed : {};
  return {
    evidenceAdds: getArrayPayload(source, ['evidenceAdds', 'evidence_adds', 'submittedEvidenceAdds', 'submitted_evidence_adds', 'submittedEvidence', 'submitted_evidence'])
      .map((item) => rollingEvidence(item, bidDocuments, fallback))
      .filter(nonNull),
    pendingRiskAdds: getArrayPayload(source, ['pendingRiskAdds', 'pending_risk_adds', 'pendingRisks', 'pending_risks'])
      .map((item) => rollingRisk(item, bidDocuments, fallback))
      .filter(nonNull),
    pendingRiskUpdates: getArrayPayload(source, ['pendingRiskUpdates', 'pending_risk_updates', 'riskUpdates', 'risk_updates'])
      .map((item) => rollingRiskUpdate(item, bidDocuments, fallback))
      .filter(nonNull),
    pendingRiskResolves: getArrayPayload(source, ['pendingRiskResolves', 'pending_risk_resolves', 'riskResolves', 'risk_resolves', 'resolvedRisks', 'resolved_risks'])
      .map((item) => rollingResolve(item, RISK_ID_KEYS))
      .filter(nonNull),
    confirmedRiskAdds: normalizeRejectionCheckFindings(
      {
        findings: getArrayPayload(source, ['confirmedRiskAdds', 'confirmed_risk_adds', 'confirmedRisks', 'confirmed_risks', 'confirmedFindings', 'confirmed_findings', 'findings']),
      },
      bidDocuments,
    ),
  };
}

const evidenceKey = (item: Pick<Evidence, 'bidDocumentId' | 'name' | 'evidence'>) => [item.bidDocumentId, item.name, item.evidence].join(SEP);
const pendingRiskKey = (item: Pick<PendingRisk, 'bidDocumentId' | 'type' | 'title' | 'requirement'>) => [item.bidDocumentId, item.type, item.title, item.requirement].join(SEP);
const confirmedRiskKey = (item: Pick<PendingRisk, 'bidDocumentId' | 'type' | 'title' | 'bidEvidence'>) => [item.bidDocumentId, item.type, item.title, item.bidEvidence].join(SEP);
const resolvedKey = (item: Resolved) => [item.title, item.reason].join(SEP);

function applyRollingRejectionPatch(state: RejectionState, patch: RejectionPatch): RejectionState {
  const next: RejectionState = {
    ...state,
    submittedEvidence: [...state.submittedEvidence],
    pendingRisks: [...state.pendingRisks],
    resolvedRisks: [...state.resolvedRisks],
    confirmedRisks: [...state.confirmedRisks],
  };
  for (const item of patch.evidenceAdds) {
    if (next.submittedEvidence.some((evidence) => evidenceKey(evidence) === evidenceKey(item))) continue;
    next.submittedEvidence.push({ ...item, id: sequentialId('evidence', next.nextEvidenceSeq) });
    next.nextEvidenceSeq += 1;
  }
  for (const item of patch.pendingRiskAdds) {
    const key = pendingRiskKey(item);
    if (next.pendingRisks.some((risk) => pendingRiskKey(risk) === key) || next.confirmedRisks.some((risk) => pendingRiskKey(risk) === key)) continue;
    next.pendingRisks.push({ ...item, id: sequentialId('risk', next.nextRiskSeq) });
    next.nextRiskSeq += 1;
  }
  for (const update of patch.pendingRiskUpdates) {
    next.pendingRisks = next.pendingRisks.map((risk) =>
      risk.id === update.id
        ? mergeDefined(risk, update, ['type', 'severity', 'title', 'summary', 'requirement', 'bidEvidence', 'riskReason', 'suggestion', 'statusReason'])
        : risk,
    );
  }
  for (const resolve of patch.pendingRiskResolves) {
    const index = next.pendingRisks.findIndex((risk) => risk.id === resolve.id);
    if (index < 0) continue;
    const [risk] = next.pendingRisks.splice(index, 1);
    next.resolvedRisks.push({
      id: `resolved_${risk!.id}`,
      riskId: risk!.id,
      title: resolve.title || risk!.title,
      reason: resolve.reason || '后续片段已提供线索，原待确认风险被排除。',
      locationHint: resolve.locationHint || risk!.locationHint,
    });
  }
  for (const item of patch.confirmedRiskAdds) {
    if (next.confirmedRisks.some((risk) => confirmedRiskKey(risk) === confirmedRiskKey(item))) continue;
    next.confirmedRisks.push({ ...item, id: sequentialId('risk', next.nextRiskSeq) });
    next.nextRiskSeq += 1;
  }
  return {
    ...next,
    submittedEvidence: dedupe(next.submittedEvidence, evidenceKey),
    pendingRisks: dedupe(next.pendingRisks, pendingRiskKey),
    resolvedRisks: dedupe(next.resolvedRisks, resolvedKey),
    confirmedRisks: dedupe(next.confirmedRisks, confirmedRiskKey),
  };
}

function emptyRejectionState(): RejectionState {
  return { nextEvidenceSeq: 1, nextRiskSeq: 1, submittedEvidence: [], pendingRisks: [], resolvedRisks: [], confirmedRisks: [] };
}

function rollingRejectionSummary(state: RejectionState) {
  return {
    counts: {
      submittedEvidence: state.submittedEvidence.length,
      pendingRisks: state.pendingRisks.length,
      resolvedRisks: state.resolvedRisks.length,
      confirmedRisks: state.confirmedRisks.length,
    },
    submittedEvidence: takeRecent(state.submittedEvidence, ROLLING_SUMMARY_EVIDENCE_LIMIT).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      name: item.name,
      evidence: truncate(item.evidence, 220),
      locationHint: item.locationHint,
      source: truncate(item.source, 160),
    })),
    pendingRisks: state.pendingRisks.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      type: item.type,
      severity: item.severity,
      title: item.title,
      requirement: truncate(item.requirement, 220),
      bidEvidence: truncate(item.bidEvidence, 260),
      riskReason: truncate(item.riskReason, 260),
      statusReason: truncate(item.statusReason, 180),
    })),
    resolvedRisks: takeRecent(state.resolvedRisks, ROLLING_SUMMARY_RESOLVED_LIMIT),
    confirmedRisks: takeRecent(state.confirmedRisks, ROLLING_SUMMARY_CONFIRMED_LIMIT).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      type: item.type,
      severity: item.severity,
      title: item.title,
      bidEvidence: truncate(item.bidEvidence, 260),
      riskReason: truncate(item.riskReason, 260),
    })),
  };
}

function finalRejectionSummary(state: RejectionState) {
  return {
    counts: {
      submittedEvidence: state.submittedEvidence.length,
      pendingRisks: state.pendingRisks.length,
      resolvedRisks: state.resolvedRisks.length,
      confirmedRisks: state.confirmedRisks.length,
    },
    submittedEvidenceIndex: state.submittedEvidence.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      name: item.name,
      evidence: truncate(item.evidence, 180),
      locationHint: item.locationHint,
      source: truncate(item.source, 120),
    })),
    resolvedRisks: state.resolvedRisks.map((item) => ({
      id: item.id,
      riskId: item.riskId,
      title: item.title,
      reason: truncate(item.reason, 220),
      locationHint: item.locationHint,
    })),
  };
}

// ---- 逻辑滚动检查的累计状态 ----

interface Fact {
  id: string;
  bidDocumentId: string;
  category: string;
  name: string;
  value: string;
  evidence: string;
  locationHint: string;
}

interface PendingIssue {
  id: string;
  bidDocumentId: string;
  title: string;
  originalText: string;
  locationHint: string;
  fallacyReason: string;
  suggestion: string;
  statusReason: string;
}

interface LogicState {
  nextFactSeq: number;
  nextIssueSeq: number;
  factRegister: Fact[];
  pendingIssues: PendingIssue[];
  resolvedIssues: Resolved[];
  confirmedIssues: (LogicFindingDraft | PendingIssue)[];
}

type IssueUpdate = Partial<Omit<PendingIssue, 'id'>> & { id: string };

interface LogicPatch {
  factAdds: Omit<Fact, 'id'>[];
  pendingIssueAdds: Omit<PendingIssue, 'id'>[];
  pendingIssueUpdates: IssueUpdate[];
  pendingIssueResolves: ResolveInput[];
  confirmedIssueAdds: LogicFindingDraft[];
}

function logicFact(item: unknown, bidDocuments: readonly BidDocumentInput[], fallback: string): Omit<Fact, 'id'> | null {
  if (!isItem(item)) return null;
  const name = truncate(item.name || item.title || item.fieldName || item.field_name, 100);
  const value = truncate(item.value || item.fact || item.content || item.description, 500);
  const evidence = truncate(item.evidence || item.originalText || item.original_text || item.excerpt, 500);
  if (!name && !value && !evidence) return null;
  return {
    bidDocumentId: packageBidDocumentId(item, bidDocuments, fallback),
    category: truncate(item.category || item.type || item.field || '关键事实', 60),
    name: name || truncate(value || evidence, 100),
    value,
    evidence,
    locationHint: truncate(item.locationHint || item.location_hint || item.location || item.position, 160),
  };
}

function rollingIssue(item: unknown, bidDocuments: readonly BidDocumentInput[], fallback: string): Omit<PendingIssue, 'id'> | null {
  if (!isItem(item)) return null;
  const title = truncate(item.title || item.summary || item.name, 80);
  const fallacyReason = truncate(item.fallacyReason || item.fallacy_reason || item.reason || item.riskReason, 600);
  if (!title && !fallacyReason) return null;
  return {
    bidDocumentId: packageBidDocumentId(item, bidDocuments, fallback),
    title: title || truncate(fallacyReason, 80),
    originalText: truncate(item.originalText || item.original_text || item.evidence || item.bidEvidence, 700),
    locationHint: truncate(item.locationHint || item.location_hint || item.location || item.position, 180),
    fallacyReason,
    suggestion: truncate(item.suggestion || item.recommendation, 300),
    statusReason: truncate(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

const ISSUE_ID_KEYS = ['id', 'issueId', 'issue_id', 'pendingIssueId', 'pending_issue_id'] as const;

function rollingIssueUpdate(item: unknown, bidDocuments: readonly BidDocumentInput[], fallback: string): IssueUpdate | null {
  if (!isItem(item)) return null;
  const id = patchReferenceId(item, ISSUE_ID_KEYS);
  if (!id) return null;
  return {
    id,
    bidDocumentId: packageBidDocumentId(item, bidDocuments, fallback),
    title: truncate(item.title || item.summary || item.name, 80),
    originalText: truncate(item.originalText || item.original_text || item.evidence || item.bidEvidence, 700),
    locationHint: truncate(item.locationHint || item.location_hint || item.location || item.position, 180),
    fallacyReason: truncate(item.fallacyReason || item.fallacy_reason || item.reason || item.riskReason, 600),
    suggestion: truncate(item.suggestion || item.recommendation, 300),
    statusReason: truncate(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

function normalizeRollingLogicPatch(parsed: unknown, bidDocuments: readonly BidDocumentInput[], fallback: string): LogicPatch {
  const source = isItem(parsed) ? parsed : {};
  return {
    factAdds: getArrayPayload(source, ['factAdds', 'fact_adds', 'factRegisterAdds', 'fact_register_adds', 'facts', 'factRegister', 'fact_register'])
      .map((item) => logicFact(item, bidDocuments, fallback))
      .filter(nonNull),
    pendingIssueAdds: getArrayPayload(source, ['pendingIssueAdds', 'pending_issue_adds', 'pendingIssues', 'pending_issues'])
      .map((item) => rollingIssue(item, bidDocuments, fallback))
      .filter(nonNull),
    pendingIssueUpdates: getArrayPayload(source, ['pendingIssueUpdates', 'pending_issue_updates', 'issueUpdates', 'issue_updates'])
      .map((item) => rollingIssueUpdate(item, bidDocuments, fallback))
      .filter(nonNull),
    pendingIssueResolves: getArrayPayload(source, ['pendingIssueResolves', 'pending_issue_resolves', 'issueResolves', 'issue_resolves', 'resolvedIssues', 'resolved_issues'])
      .map((item) => rollingResolve(item, ISSUE_ID_KEYS))
      .filter(nonNull),
    confirmedIssueAdds: normalizeLogicCheckFindings(
      {
        findings: getArrayPayload(source, ['confirmedIssueAdds', 'confirmed_issue_adds', 'confirmedIssues', 'confirmed_issues', 'confirmedFindings', 'confirmed_findings', 'findings']),
      },
      bidDocuments,
    ),
  };
}

const factKey = (item: Pick<Fact, 'bidDocumentId' | 'category' | 'name' | 'value'>) => [item.bidDocumentId, item.category, item.name, item.value].join(SEP);
const issueKey = (item: Pick<PendingIssue, 'bidDocumentId' | 'title' | 'fallacyReason'>) => [item.bidDocumentId, item.title, item.fallacyReason].join(SEP);

function applyRollingLogicPatch(state: LogicState, patch: LogicPatch): LogicState {
  const next: LogicState = {
    ...state,
    factRegister: [...state.factRegister],
    pendingIssues: [...state.pendingIssues],
    resolvedIssues: [...state.resolvedIssues],
    confirmedIssues: [...state.confirmedIssues],
  };
  for (const item of patch.factAdds) {
    if (next.factRegister.some((fact) => factKey(fact) === factKey(item))) continue;
    next.factRegister.push({ ...item, id: sequentialId('fact', next.nextFactSeq) });
    next.nextFactSeq += 1;
  }
  for (const item of patch.pendingIssueAdds) {
    const key = issueKey(item);
    if (next.pendingIssues.some((issue) => issueKey(issue) === key) || next.confirmedIssues.some((issue) => issueKey(issue) === key)) continue;
    next.pendingIssues.push({ ...item, id: sequentialId('issue', next.nextIssueSeq) });
    next.nextIssueSeq += 1;
  }
  for (const update of patch.pendingIssueUpdates) {
    next.pendingIssues = next.pendingIssues.map((issue) =>
      issue.id === update.id ? mergeDefined(issue, update, ['title', 'originalText', 'locationHint', 'fallacyReason', 'suggestion', 'statusReason']) : issue,
    );
  }
  for (const resolve of patch.pendingIssueResolves) {
    const index = next.pendingIssues.findIndex((issue) => issue.id === resolve.id);
    if (index < 0) continue;
    const [issue] = next.pendingIssues.splice(index, 1);
    next.resolvedIssues.push({
      id: `resolved_${issue!.id}`,
      issueId: issue!.id,
      title: resolve.title || issue!.title,
      reason: resolve.reason || '后续片段已解释或修正，原待确认问题被排除。',
      locationHint: resolve.locationHint || issue!.locationHint,
    });
  }
  for (const item of patch.confirmedIssueAdds) {
    if (next.confirmedIssues.some((issue) => issueKey(issue) === issueKey(item))) continue;
    next.confirmedIssues.push({ ...item, id: sequentialId('issue', next.nextIssueSeq) });
    next.nextIssueSeq += 1;
  }
  return {
    ...next,
    factRegister: dedupe(next.factRegister, factKey),
    pendingIssues: dedupe(next.pendingIssues, issueKey),
    resolvedIssues: dedupe(next.resolvedIssues, resolvedKey),
    confirmedIssues: dedupe(next.confirmedIssues, issueKey),
  };
}

function emptyLogicState(): LogicState {
  return { nextFactSeq: 1, nextIssueSeq: 1, factRegister: [], pendingIssues: [], resolvedIssues: [], confirmedIssues: [] };
}

function rollingLogicSummary(state: LogicState) {
  return {
    counts: {
      factRegister: state.factRegister.length,
      pendingIssues: state.pendingIssues.length,
      resolvedIssues: state.resolvedIssues.length,
      confirmedIssues: state.confirmedIssues.length,
    },
    factRegister: takeRecent(state.factRegister, ROLLING_SUMMARY_EVIDENCE_LIMIT).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      category: item.category,
      name: item.name,
      value: truncate(item.value, 220),
      evidence: truncate(item.evidence, 220),
      locationHint: item.locationHint,
    })),
    pendingIssues: state.pendingIssues.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      title: item.title,
      originalText: truncate(item.originalText, 260),
      locationHint: item.locationHint,
      fallacyReason: truncate(item.fallacyReason, 260),
      statusReason: truncate(item.statusReason, 180),
    })),
    resolvedIssues: takeRecent(state.resolvedIssues, ROLLING_SUMMARY_RESOLVED_LIMIT),
    confirmedIssues: takeRecent(state.confirmedIssues, ROLLING_SUMMARY_CONFIRMED_LIMIT).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      title: item.title,
      originalText: truncate(item.originalText, 260),
      locationHint: item.locationHint,
      fallacyReason: truncate(item.fallacyReason, 260),
    })),
  };
}

function finalLogicSummary(state: LogicState) {
  return {
    counts: {
      factRegister: state.factRegister.length,
      pendingIssues: state.pendingIssues.length,
      resolvedIssues: state.resolvedIssues.length,
      confirmedIssues: state.confirmedIssues.length,
    },
    factRegisterIndex: state.factRegister.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      category: item.category,
      name: item.name,
      value: truncate(item.value, 180),
      evidence: truncate(item.evidence, 180),
      locationHint: item.locationHint,
    })),
    resolvedIssues: state.resolvedIssues.map((item) => ({
      id: item.id,
      issueId: item.issueId,
      title: item.title,
      reason: truncate(item.reason, 220),
      locationHint: item.locationHint,
    })),
  };
}

// ---- 三类检查 ----

async function runRollingRejectionItemCheck(runtime: CheckRuntime, input: RejectionInput, onProgress: Progress): Promise<RiskFindingDraft[]> {
  const { chat, split } = runtime;
  const segments = packageSegments(input.bidDocuments, split, ROLLING_SEGMENT_LIMIT_RATIO);
  let state = emptyRejectionState();
  onProgress('正在按上下文长度滚动审阅投标包。');
  for (const segment of segments) {
    onProgress(`${segment.documentLabel}：正在滚动审阅投标包第 ${segment.segmentIndex}/${segment.totalSegments} 段。`);
    const payload = await chat.json(`rejection:segment:${segment.segmentIndex}`, buildRollingRejectionSegmentMessages(input, segment, rollingRejectionSummary(state)), {
      progressLabel: '投标包废标项滚动审阅',
      failureMessage: '废标项滚动审阅状态格式无效，请重新检查',
      onProgress,
    });
    state = applyRollingRejectionPatch(state, normalizeRollingRejectionPatch(payload, input.bidDocuments, segment.documentId));
  }

  onProgress('正在基于全投标包状态定稿废标项风险。');
  const candidates = [
    ...state.confirmedRisks.map((item) => ({ ...item, candidateStatus: 'confirmed' })),
    ...state.pendingRisks.map((item) => ({ ...item, candidateStatus: 'pending' })),
  ];
  if (!candidates.length) return [];
  const batches = chunk(candidates, FINAL_CANDIDATE_BATCH_SIZE);
  const finalSummary = finalRejectionSummary(state);
  const findings: RiskFindingDraft[] = [];
  for (const [batchIndex, batch] of batches.entries()) {
    onProgress(`正在定稿废标项风险第 ${batchIndex + 1}/${batches.length} 批。`);
    const payload = await chat.json(`rejection:final:${batchIndex + 1}`, buildRejectionFinalBatchMessages(input, batch, finalSummary, batchIndex + 1, batches.length), {
      progressLabel: '投标包废标项检查定稿',
      failureMessage: '废标项检查结果格式无效，请重新检查',
      onProgress,
    });
    findings.push(...normalizeRejectionCheckFindings(payload, input.bidDocuments));
  }
  const merged = dedupeRejectionFindings(findings);
  if (!merged.length) return [];
  onProgress('正在全局合并废标项风险。');
  const payload = await chat.json('rejection:merge', buildRejectionGlobalMergeMessages(input, merged, finalSummary), {
    progressLabel: '废标项风险全局合稿',
    failureMessage: '废标项风险全局合稿结果格式无效，请重新检查',
    onProgress,
  });
  return dedupeRejectionFindings(normalizeRejectionCheckFindings(payload, input.bidDocuments));
}

export async function runRejectionItemCheck(runtime: CheckRuntime, input: RejectionInput, onProgress: Progress): Promise<RiskFindingDraft[]> {
  if (usesSegmentedRejectionFlow(input, runtime.split)) return runRollingRejectionItemCheck(runtime, input, onProgress);
  const { chat } = runtime;
  onProgress('第一轮：正在分析检查范围。');
  const analysis = await chat.text('rejection:analysis', buildRejectionCheckAnalysisMessages(input), '第一轮分析');
  onProgress('第二轮：正在逐项检查投标文件。');
  const draftFindings = await chat.text('rejection:inspection', buildRejectionCheckInspectionMessages(input, analysis), '第二轮检查');
  onProgress('第三轮：正在补充、去重并生成结果。');
  const payload = await chat.json('rejection:final', buildRejectionCheckFinalMessages(input, analysis, draftFindings), {
    progressLabel: '废标项检查结果',
    failureMessage: '废标项检查结果格式无效，请重新检查',
    onProgress,
  });
  return normalizeRejectionCheckFindings(payload, input.bidDocuments);
}

export async function runTypoCheck(runtime: CheckRuntime, bidDocuments: readonly BidDocumentInput[], onProgress: Progress): Promise<TypoFindingDraft[]> {
  const { chat, split } = runtime;
  if (!usesSegmentedBidDocuments(bidDocuments, split)) {
    onProgress('正在识别错别字候选。');
    const payload = await chat.json('typo', buildTypoCheckMessages(bidDocuments), {
      progressLabel: '错别字检查结果',
      failureMessage: '错别字检查结果格式无效，请重新检查',
      onProgress,
    });
    onProgress('正在校验错别字原文位置。');
    return normalizeTypoCheckFindings(payload, bidDocuments);
  }
  const findings: TypoFindingDraft[] = [];
  onProgress('正在按上下文长度分段识别错别字。');
  for (const [documentIndex, document] of bidDocuments.entries()) {
    const label = bidDocumentDisplayName(document, documentIndex);
    for (const segment of documentSegments(document, split, TYPO_SEGMENT_LIMIT_RATIO)) {
      onProgress(`${label}：正在识别第 ${segment.segmentIndex}/${segment.totalSegments} 段错别字。`);
      const payload = await chat.json(
        `typo:document:${documentIndex + 1}:segment:${segment.segmentIndex}`,
        buildTypoCheckMessages([{ ...document, content: segment.content }]),
        { progressLabel: `${label}错别字检查`, failureMessage: '错别字检查结果格式无效，请重新检查', onProgress },
      );
      findings.push(...normalizeTypoCheckFindings(payload, [document], { segmentStartOffset: segment.startOffset, segmentEndOffset: segment.endOffset }));
    }
  }
  onProgress('正在合并并校验错别字原文位置。');
  return dedupeTypoFindings(findings);
}

async function runRollingLogicCheck(runtime: CheckRuntime, bidDocuments: readonly BidDocumentInput[], onProgress: Progress): Promise<LogicFindingDraft[]> {
  const { chat, split } = runtime;
  const input = { bidDocuments };
  const segments = packageSegments(bidDocuments, split, ROLLING_SEGMENT_LIMIT_RATIO);
  let state = emptyLogicState();
  onProgress('正在按上下文长度滚动检查投标包逻辑谬误。');
  for (const segment of segments) {
    onProgress(`${segment.documentLabel}：正在滚动检查投标包第 ${segment.segmentIndex}/${segment.totalSegments} 段逻辑。`);
    const payload = await chat.json(`logic:segment:${segment.segmentIndex}`, buildRollingLogicSegmentMessages(input, segment, rollingLogicSummary(state)), {
      progressLabel: '投标包逻辑滚动检查',
      failureMessage: '逻辑谬误滚动检查状态格式无效，请重新检查',
      onProgress,
    });
    state = applyRollingLogicPatch(state, normalizeRollingLogicPatch(payload, bidDocuments, segment.documentId));
  }

  onProgress('正在基于全投标包状态定稿逻辑问题。');
  const candidates = [
    ...state.confirmedIssues.map((item) => ({ ...item, candidateStatus: 'confirmed' })),
    ...state.pendingIssues.map((item) => ({ ...item, candidateStatus: 'pending' })),
  ];
  if (!candidates.length) return [];
  const batches = chunk(candidates, FINAL_CANDIDATE_BATCH_SIZE);
  const finalSummary = finalLogicSummary(state);
  const findings: LogicFindingDraft[] = [];
  for (const [batchIndex, batch] of batches.entries()) {
    onProgress(`正在定稿逻辑问题第 ${batchIndex + 1}/${batches.length} 批。`);
    const payload = await chat.json(`logic:final:${batchIndex + 1}`, buildLogicFinalBatchMessages(input, batch, finalSummary, batchIndex + 1, batches.length), {
      progressLabel: '投标包逻辑谬误检查定稿',
      failureMessage: '逻辑谬误检查结果格式无效，请重新检查',
      onProgress,
    });
    findings.push(...normalizeLogicCheckFindings(payload, bidDocuments));
  }
  const merged = dedupeLogicFindings(findings);
  if (!merged.length) return [];
  onProgress('正在全局合并逻辑问题。');
  const payload = await chat.json('logic:merge', buildLogicGlobalMergeMessages(input, merged, finalSummary), {
    progressLabel: '逻辑问题全局合稿',
    failureMessage: '逻辑问题全局合稿结果格式无效，请重新检查',
    onProgress,
  });
  return dedupeLogicFindings(normalizeLogicCheckFindings(payload, bidDocuments));
}

export async function runLogicCheck(runtime: CheckRuntime, bidDocuments: readonly BidDocumentInput[], onProgress: Progress): Promise<LogicFindingDraft[]> {
  if (usesSegmentedBidDocuments(bidDocuments, runtime.split)) return runRollingLogicCheck(runtime, bidDocuments, onProgress);
  onProgress('正在检查逻辑谬误。');
  const payload = await runtime.chat.json('logic', buildLogicCheckMessages(bidDocuments), {
    progressLabel: '逻辑谬误检查结果',
    failureMessage: '逻辑谬误检查结果格式无效，请重新检查',
    onProgress,
  });
  return normalizeLogicCheckFindings(payload, bidDocuments);
}
