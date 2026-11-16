// jsonValidation.mjs 与 jsonValidationCore.mjs 的类型（测试从 TypeScript 导入）。
export const JSON_VALIDATION_TOOL_NAME: 'json-validation';
export const MAX_JSON_FILE_BYTES: number;
export const VALIDATION_TIMEOUT_MS: number;
export const VALIDATION_HEAP_MB: number;

export interface ValidationPayload {
  valid: boolean;
  stage: 'read' | 'parse' | 'schema' | 'validation' | 'success' | 'timeout' | 'resource' | 'aborted';
  file_path: string;
  errors: Array<{ message: string; instancePath?: string; schemaPath?: string; keyword?: string; params?: Record<string, unknown> }>;
  error_count?: number;
  message: string;
}

export interface ValidationInput {
  workspaceDir: string;
  filePath: unknown;
  presetSchemas?: Record<string, unknown>;
  schema?: unknown;
}

export function runJsonValidation(options: ValidationInput & { signal?: AbortSignal; timeoutMs?: number; heapMb?: number }): Promise<ValidationPayload>;

export interface JsonValidationTool {
  name: 'json-validation';
  label: string;
  description: string;
  promptSnippet: string;
  executionMode: 'sequential';
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: any, signal?: AbortSignal): Promise<{ content: Array<{ type: 'text'; text: string }>; details: ValidationPayload; isError?: true }>;
}

export function createJsonValidationTool(options: {
  Type: unknown;
  workspaceDir: string;
  presetSchemas?: Record<string, unknown>;
  validate?: (options: ValidationInput & { signal?: AbortSignal }) => Promise<ValidationPayload>;
}): JsonValidationTool;
