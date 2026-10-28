// duplicateText.mjs 的类型声明，供宿主上的单元测试与数据库测试（构造解析输出）使用。
export interface DuplicateOutlineItem {
  id: string;
  level: number;
  number: string | null;
  title: string;
  normalizedTitle: string;
  pathTitles: string[];
  normalizedPath: string;
  source: 'catalog' | 'heading' | 'semantic';
  confidence: number;
  order: number;
  parentId: string | null;
}
export interface DuplicateDocumentAnalysis {
  version: 1;
  outline: { items: DuplicateOutlineItem[]; source: 'catalog' | 'heading' | 'semantic' | null; confidence: number };
  tenderSentences: Array<{ text: string; normalized: string }>;
  sentences: Array<{ sentence: string; normalized: string }>;
  images: Array<{ path: string; index: number; directory: string; previousSentence: string }>;
}
export type ExtractTableBlocks = (tableHtml: string) => string[];
export declare function normalizeValue(value: unknown): string;
export declare function normalizeOutlineTitle(value: string): string;
export declare function normalizeContentSentence(value: string): string;
export declare function cleanContentSentence(value: string): string;
export declare function addContentTextBlock(blocks: string[], value: string): void;
export declare function splitTenderSentences(markdown: string): DuplicateDocumentAnalysis['tenderSentences'];
export declare function buildOutlineItems(markdown: string): DuplicateDocumentAnalysis['outline'];
export declare function splitContentSentences(markdown: string, extractTableBlocks: ExtractTableBlocks): DuplicateDocumentAnalysis['sentences'];
export declare function extractImageOccurrences(markdown: string): DuplicateDocumentAnalysis['images'];
export declare function analyzeDuplicateCheckDocument(markdown: string, extractTableBlocks: ExtractTableBlocks): DuplicateDocumentAnalysis;
