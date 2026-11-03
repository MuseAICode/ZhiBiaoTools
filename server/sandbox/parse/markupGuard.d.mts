// markupGuard.mjs 的类型声明，供宿主上的单元测试（server/tests/sandbox/markupGuard.test.ts）使用。
export type MarkupGuardCode =
  | 'xml_invalid'
  | 'xml_doctype'
  | 'xml_external_reference'
  | 'rtf_invalid'
  | 'mht_invalid'
  | 'mht_too_complex'
  | 'mht_no_html';
export declare class MarkupGuardError extends Error {
  readonly code: MarkupGuardCode;
}
export interface MhtLimits {
  readonly maxDepth: number;
  readonly maxParts: number;
  readonly maxHeaderBytes: number;
  readonly maxHeaderFields: number;
}
export declare const MHT_LIMITS: MhtLimits;
export declare const RTF_MAX_DEPTH: number;
export declare function assertSafeXml(buffer: Buffer): { text: string; bytes: Buffer };
export declare function sanitizeRtf(buffer: Buffer): Buffer;
export declare function parseContentType(value: string | null | undefined): { type: string; params: Map<string, string> };
export declare function extractMht(
  buffer: Buffer,
  limits?: MhtLimits,
): { html: string; resolveResource(src: string): { mime: string; buffer: Buffer } | null; partCount: number };
export declare function decodeHtmlBytes(buffer: Buffer, charset?: string | null): string;
