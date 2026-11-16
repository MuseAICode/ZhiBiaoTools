// pi.mjs 的类型（测试从 TypeScript 导入）。
import type { PromptOutcome, PromptRequest } from './protocol.mjs';

export const WORKSPACE_DIR: string;
export const SESSIONS_DIR: string;
export const AGENT_DIR: string;
export const INSTRUCTIONS_PATH: URL;
export const BASH_COMMAND_TIMEOUT_SECONDS: number;
export const MODEL_REQUEST_TIMEOUT_MS: number;
export const BASH_ENV: Readonly<Record<string, string>>;

export function bashTimeoutSeconds(requested: number | undefined): number;
export function runPiPrompt(
  request: PromptRequest,
  options: {
    baseUrl: string;
    workspaceDir?: string;
    sessionsDir?: string;
    agentDir?: string;
    instructionsPath?: URL | string;
    callTool?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  },
): Promise<PromptOutcome>;
