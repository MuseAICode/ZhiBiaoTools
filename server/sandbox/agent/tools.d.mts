// tools.mjs 的类型（测试从 TypeScript 导入）。
import type { EntryErrorCode } from './protocol.mjs';

export const TOOL_CALL_TIMEOUT_MS: number;
export const MAX_TOOL_RESPONSE_BYTES: number;
export const PENDING_RETRY_DELAY_MS: number;
export const MAX_TOOL_ERROR_CHARS: number;

export class ToolCallError extends Error {
  readonly fatalCode: EntryErrorCode | null;
  constructor(message: string, fatalCode?: EntryErrorCode | null);
}

export function callBusinessTool(options: {
  baseUrl: string;
  token: string;
  name: string;
  args: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<unknown>;

export function modelToolName(name: string): string;

export interface BusinessToolStub {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode: 'sequential';
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (update: { content: Array<{ type: 'text'; text: string }>; details: unknown }) => void): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
}

export function createBusinessToolStubs(options: {
  Type: unknown;
  names: readonly string[];
  call: (name: string, args: any, signal?: AbortSignal) => Promise<unknown>;
  end: (code: EntryErrorCode) => void;
  workspaceDir?: string;
}): BusinessToolStub[];

export function createChildReportFailureTool(options: { Type: unknown; report: (reason: string) => void }): Omit<BusinessToolStub, 'execute'> & {
  execute(toolCallId: string, params: any): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
};

export const CONTENT_SECTIONS_TASK_FILE: string;
export const KNOWLEDGE_INDEX_FILE: string;
export const CONTENT_SUBMISSION_ISSUES_FILE: string;
