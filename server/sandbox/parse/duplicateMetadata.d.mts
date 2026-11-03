// duplicateMetadata.mjs 的类型声明，供宿主上的单元测试与数据库测试（构造元数据输出）使用。
export interface CfbEntry {
  name?: string;
  type?: number;
  size?: number;
  content?: Uint8Array | number[] | null;
}
export interface CfbContainer {
  FileIndex: CfbEntry[];
  FullPaths: string[];
}
export interface CfbApi {
  read(buffer: Buffer, options: { type: 'buffer' }): CfbContainer;
  find(cfb: CfbContainer, path: string): CfbEntry | null | undefined;
}
export interface PdfInfoResult {
  info?: Record<string, unknown>;
  metadata?: unknown;
  total?: number;
  pages?: number;
  numpages?: number;
  version?: string;
  fingerprints?: unknown;
  permission?: unknown;
}
export interface DocumentMetadataOutput {
  version: 1;
  fields: Array<[string, string]>;
}
export const METADATA_LIMITS: Readonly<{ maxFields: number; maxKeyLength: number; maxValueLength: number; maxTotalLength: number }>;
export const METADATA_ERRORS: Readonly<{ failed: string; ole: string; convertedDocx: string }>;
export const WORKER_METADATA_KEYS: readonly string[];
export const FORMAT_METADATA_KEYS: readonly string[];
export const PROPERTY_SET_KEYS: readonly string[];
export const WORD_TEXT_FORMATS: readonly string[];
export const METADATA_FORMATS: readonly string[];
export function extractDocxMetadata(buffer: Buffer): Promise<Map<string, string>>;
export function extractOleMetadata(buffer: Buffer, cfbApi: CfbApi): Map<string, string>;
export function extractPdfMetadata(buffer: Buffer, readPdfInfo: (buffer: Buffer) => Promise<PdfInfoResult>): Promise<Map<string, string>>;
export function isDocumentMetadataKey(key: string): boolean;
export function isMetadataErrorValue(value: string): boolean;
export function finalizeMetadataFields(fields: ReadonlyMap<string, string>): Array<[string, string]>;
export function extractDocumentMetadata(input: {
  format: string;
  buffer: Buffer;
  cfb: CfbApi;
  readPdfInfo: (buffer: Buffer) => Promise<PdfInfoResult>;
  toDocx: (format: string, buffer: Buffer) => Promise<Buffer>;
}): Promise<DocumentMetadataOutput>;
