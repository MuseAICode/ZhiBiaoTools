// jsonValidationCore.mjs 的类型（测试从 TypeScript 导入）。
import type { ValidationInput, ValidationPayload } from './jsonValidation.mjs';

export const JSON_VALIDATION_TOOL_NAME: 'json-validation';
export const MAX_JSON_FILE_BYTES: number;
export const MAX_REPORTED_ERRORS: number;
export function normalizeWorkspaceFilePath(filePath: unknown): string;
export function normalizeAjvErrors(errors?: unknown[]): ValidationPayload['errors'];
export function validationPayload(options: { filePath: string; valid: boolean; stage: ValidationPayload['stage']; errors?: ValidationPayload['errors']; errorCount?: number }): ValidationPayload;
export function validateJsonFile(options: ValidationInput): ValidationPayload;
