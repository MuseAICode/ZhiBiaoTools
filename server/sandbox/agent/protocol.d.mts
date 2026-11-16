// protocol.mjs 的类型（测试从 TypeScript 导入）。
import type { Readable, Writable } from 'node:stream';

export const PROTOCOL_VERSION: 1;
export const MAX_REQUEST_BYTES: number;
export const MAX_RESULT_BYTES: number;
export const GATEWAY_BASE_URL: string;
export const GATEWAY_TIMEOUT_MS: number;
export const NATIVE_TOOLS: readonly ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
export const BUSINESS_TOOLS: readonly ['ask-user', 'report-failure', 'request-termination'];
export const LOCAL_TOOLS: readonly ['json-validation'];
export const MAX_JSON_SCHEMAS: number;
export const MAX_WORKSPACE_PATH_BYTES: number;
export const MAX_WORKSPACE_PATH_DEPTH: number;
export function isWorkspaceRelativePath(value: unknown): value is string;
export const EXCLUSIVE_BUSINESS_TOOLS: readonly (readonly string[])[];
export const SESSION_FILE_PATTERN: RegExp;
export const MAX_PROMPT_CHARS: number;
export const MAX_TURNS_PER_PROMPT: number;
export const CONTEXT_WINDOW_RANGE: Readonly<{ min: number; max: number }>;
export const MAX_OUTPUT_TOKENS_RANGE: Readonly<{ min: number; max: number }>;

export type EntryErrorCode =
  | 'BAD_REQUEST'
  | 'TOKEN_INVALID'
  | 'GATEWAY_UNAVAILABLE'
  | 'GATEWAY_FAILED'
  | 'SESSION_INVALID'
  | 'TURN_LIMIT'
  | 'MODEL_FAILED'
  | 'REPORTED_FAILURE'
  | 'RUN_ENDED'
  | 'INTERNAL';
export const ENTRY_ERROR_MESSAGES: Readonly<Record<EntryErrorCode, string>>;

export class EntryError extends Error {
  readonly code: EntryErrorCode;
  constructor(code: EntryErrorCode);
}

export type NativeTool = (typeof NATIVE_TOOLS)[number];
export type BusinessTool = (typeof BUSINESS_TOOLS)[number];
export type LocalTool = (typeof LOCAL_TOOLS)[number];
export type RequestTool = NativeTool | LocalTool | BusinessTool;

export interface SessionRequest {
  version: 1;
  action: 'session';
  token: string;
}
export interface PromptRequest {
  version: 1;
  action: 'prompt';
  token: string;
  prompt: string;
  session: string | null;
  tools: RequestTool[];
  maxTurns: number;
  model: { contextWindow: number; maxOutputTokens: number };
  /** 预置的 JSON Schema（工作区相对路径 → schema）；parseRequest 的结果中总有（省略时为 {}）。 */
  jsonSchemas?: Record<string, unknown>;
}
export type EntryRequest = SessionRequest | PromptRequest;

export interface PromptOutcome {
  session: string;
  turns: number;
  stopReason: 'stop' | 'length';
}
export type RunPrompt = (request: PromptRequest, options: { baseUrl: string }) => Promise<PromptOutcome>;

export function readRequest(stream: AsyncIterable<Buffer> & { destroy?: () => void }, maxBytes?: number): Promise<Buffer>;
export function parseRequest(bytes: Buffer): EntryRequest;
export function querySession(options: { baseUrl?: string; token: string; timeoutMs?: number }): Promise<{ expiresAt: string }>;
export function formatResult(result: Record<string, unknown>): string;
export function runEntry(options: {
  stdin: Readable | AsyncIterable<Buffer>;
  stdout: Writable;
  baseUrl?: string;
  timeoutMs?: number;
  runPrompt?: RunPrompt;
}): Promise<0 | 1>;
