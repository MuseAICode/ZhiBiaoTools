// protocol.mjs 的类型（测试从 TypeScript 导入）。
import type { Readable, Writable } from 'node:stream';

export const PROTOCOL_VERSION: 1;
export const MAX_REQUEST_BYTES: number;
export const MAX_RESULT_BYTES: number;
export const GATEWAY_BASE_URL: string;
export const GATEWAY_TIMEOUT_MS: number;

export type EntryErrorCode = 'BAD_REQUEST' | 'TOKEN_INVALID' | 'GATEWAY_UNAVAILABLE' | 'GATEWAY_FAILED' | 'INTERNAL';
export const ENTRY_ERROR_MESSAGES: Readonly<Record<EntryErrorCode, string>>;

export class EntryError extends Error {
  readonly code: EntryErrorCode;
  constructor(code: EntryErrorCode);
}

export interface EntryRequest {
  version: 1;
  action: 'session';
  token: string;
}

export function readRequest(stream: AsyncIterable<Buffer> & { destroy?: () => void }, maxBytes?: number): Promise<Buffer>;
export function parseRequest(bytes: Buffer): EntryRequest;
export function querySession(options: { baseUrl?: string; token: string; timeoutMs?: number }): Promise<{ expiresAt: string }>;
export function formatResult(result: Record<string, unknown>): string;
export function runEntry(options: { stdin: Readable | AsyncIterable<Buffer>; stdout: Writable; baseUrl?: string; timeoutMs?: number }): Promise<0 | 1>;
