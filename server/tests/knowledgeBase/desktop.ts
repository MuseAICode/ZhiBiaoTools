// 加载桌面版 knowledgeBaseService.cjs（tests/knowledgeBase/prepare.test.ts、match.test.ts、tests/db/knowledgeBaseJobs.test.ts 对照用）：
// electron 与 fileService.cjs（文档解析，依赖 client/ 的 npm 包）换成桩，promptPrefixCache.cjs 换成不等待的同样调用
// （预热后的 1.5 秒等待只为服务商构建缓存），其余模块用桌面版原文件。
// runDesktopPreparation 用内存中的 Store 与模型桩执行桌面版的 prepareDocument（非开发者模式，准备完成后接着匹配），
// 记下全部模型请求与写入的结果，供与服务端任务的结果逐项比较。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SERVICE = '../../../client/electron/services/knowledgeBaseService.cjs';

/** 解析结果由测试给出（取代 fileService.cjs 的 parseDocumentWithConfig）。 */
const parser = { markdown: '' };

function loadDesktop(): any {
  const Module = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') return { dialog: {} };
    if (request === './fileService.cjs') return { parseDocumentWithConfig: async () => parser.markdown };
    if (request === '../utils/promptPrefixCache.cjs') {
      return {
        async warmPromptPrefix({ aiService, messages }: { aiService: { chat: (request: unknown) => Promise<unknown> }; messages: unknown[] }) {
          try {
            await aiService.chat({ output_token_limit: 1, messages });
          } catch {
            // 与桌面版相同：预热失败直接继续。
          }
        },
      };
    }
    if (request === '../utils/silentFileLog.cjs') return { enqueueJsonLine: () => {}, enqueueLogRemoval: () => {} };
    return original.call(this, request, parent, isMain);
  };
  try {
    return require(SERVICE);
  } finally {
    Module._load = original;
  }
}

export const desktop = loadDesktop() as {
  createKnowledgeBaseService: (options: Record<string, unknown>) => Record<string, (...args: any[]) => any>;
  _internals: Record<string, (...args: any[]) => any>;
};

export interface DesktopRequest {
  kind: 'warmup' | 'json';
  messages: { role: string; content: string }[];
}

export interface DesktopResult {
  document: Record<string, any>;
  requests: DesktopRequest[];
  blocks: any[];
  filteredBlocks: any[];
  candidateItems: any[];
  steps: Map<string, { status: string; result?: unknown; error?: string }>;
  matchBatches: Map<number, { status: string; item_ids?: unknown; matches?: unknown[]; error?: string }>;
  finalItems: any[];
  /** saveMatchResult 收到的匹配结果与报告。 */
  matchResult: Record<string, any> | null;
}

/**
 * 以非开发者模式执行桌面版的 prepareDocument（经 retryDocument 触发，准备完成后接着 matchDocument），respond 按请求消息返回
 * 模型输出（JSON 文本）。contextLengthLimit 与服务端任务的 contextLengthLimit 相同时，分段与请求逐字相同。
 */
export async function runDesktopPreparation(options: {
  fileName: string;
  markdown: string;
  respond: (messages: DesktopRequest['messages']) => string;
  contextLengthLimit: number;
}): Promise<DesktopResult> {
  parser.markdown = options.markdown;
  const baseDir = mkdtempSync(path.join(tmpdir(), 'kb-desktop-'));
  const documentId = 'doc-1';
  const documentDir = `folders/f/documents/${documentId}`;
  mkdirSync(path.join(baseDir, 'workspace', 'knowledge-base', documentDir), { recursive: true });
  writeFileSync(path.join(baseDir, 'workspace', 'knowledge-base', documentDir, 'source.docx'), 'x');
  // 非开发者模式没有调试日志：文档写入 success 或 error 即处理结束（准备失败、匹配完成或失败）。
  let finished = false;

  let document: Record<string, any> = {
    id: documentId,
    file_name: options.fileName,
    document_dir: documentDir,
    source_path: `${documentDir}/source.docx`,
    markdown_path: `${documentDir}/content.md`,
    status: 'error',
  };
  const steps = new Map<string, { status: string; result?: unknown; error?: string }>();
  let blocks: any[] = [];
  let filteredBlocks: any[] = [];
  let candidateItems: any[] = [];
  let finalItems: any[] = [];
  let matchResult: Record<string, any> | null = null;
  const matchBatches = new Map<number, { status: string; item_ids?: unknown; matches?: unknown[]; error?: string }>();
  const STEP_KEYS = ['copy_source', 'convert_markdown', 'build_blocks', 'extract_first_items', 'extract_supplement_items', 'merge_candidates', 'match_batches', 'recover_missing', 'save_result'];

  const store = {
    recoverInterruptedDocuments: () => [],
    getDocument: () => ({ ...document }),
    updateDocument: (_id: string, partial: Record<string, unknown>) => {
      document = { ...document, ...partial };
      if (partial.status === 'success' || partial.status === 'error') finished = true;
      return { ...document };
    },
    getDocumentStep: (_id: string, key: string) => (steps.has(key) ? structuredClone(steps.get(key)) : null),
    saveDocumentStep: (_id: string, key: string, fields: { status: string; result?: unknown; error?: string }) => {
      steps.set(key, { ...steps.get(key), ...structuredClone(fields) });
    },
    readBlocks: () => structuredClone(blocks),
    readFilteredBlocks: () => structuredClone(filteredBlocks),
    readCandidateItems: () => structuredClone(candidateItems),
    clearDocumentProcessingFromStep: (_id: string, key: string) => {
      const start = STEP_KEYS.indexOf(key);
      for (const stepKey of STEP_KEYS.slice(start)) steps.delete(stepKey);
      // 与桌面版 knowledgeBaseStore.cjs 相同：每次都清除 error 与 last_batch_size。
      document = { ...document, error: null, last_batch_size: null };
      if (start <= STEP_KEYS.indexOf('build_blocks')) {
        blocks = [];
        filteredBlocks = [];
      }
      if (start <= STEP_KEYS.indexOf('merge_candidates')) candidateItems = [];
      if (start <= STEP_KEYS.indexOf('match_batches')) matchBatches.clear();
      if (start <= STEP_KEYS.indexOf('save_result')) {
        finalItems = [];
        matchResult = null;
      }
    },
    updateMarkdownMetadata: () => {},
    saveBlocks: (_id: string, kept: any[], filtered: any[]) => {
      blocks = structuredClone(kept);
      filteredBlocks = structuredClone(filtered);
    },
    saveCandidateItems: (_id: string, items: any[]) => {
      candidateItems = structuredClone(items);
    },
    readMatchBatches: () => [...matchBatches.entries()].sort(([a], [b]) => a - b).map(([index, batch]) => ({ batch_index: index, ...structuredClone(batch) })),
    getMatchBatch: (_id: string, index: number) => (matchBatches.has(index) ? structuredClone(matchBatches.get(index)) : null),
    saveMatchBatch: (_id: string, index: number, fields: { status: string; itemIds?: unknown; matches?: unknown[]; error?: string }) => {
      const current = matchBatches.get(index) ?? { status: 'idle' };
      matchBatches.set(index, {
        ...current,
        status: fields.status,
        ...(fields.itemIds !== undefined ? { item_ids: structuredClone(fields.itemIds) } : {}),
        ...(fields.matches !== undefined ? { matches: structuredClone(fields.matches) } : {}),
        ...(fields.error !== undefined ? { error: fields.error } : {}),
      });
    },
    clearMatchBatches: () => matchBatches.clear(),
    readItems: () => structuredClone(finalItems),
    saveMatchResult: (_id: string, input: { candidateItems: any[]; matchResult: Record<string, any>; finalItems: any[] }) => {
      candidateItems = structuredClone(input.candidateItems);
      finalItems = structuredClone(input.finalItems);
      matchResult = structuredClone(input.matchResult);
    },
  };

  const requests: DesktopRequest[] = [];
  const clone = (messages: any[]) => messages.map((message) => ({ role: String(message.role), content: String(message.content) }));
  const aiService = {
    getConfig: () => ({ context_length_limit: options.contextLengthLimit }),
    async chat(request: { messages: any[]; output_token_limit?: number }) {
      if (request.output_token_limit !== 1) throw new Error('unexpected chat request');
      requests.push({ kind: 'warmup', messages: clone(request.messages) });
      return '';
    },
    async collectJsonResponse(request: { messages: any[]; normalizer?: (value: unknown) => unknown; validator?: (value: unknown) => void }) {
      requests.push({ kind: 'json', messages: clone(request.messages) });
      const parsed = JSON.parse(options.respond(clone(request.messages)));
      const normalized = request.normalizer ? request.normalizer(parsed) : parsed;
      request.validator?.(normalized);
      return normalized;
    },
  };
  const app = { getPath: () => baseDir };
  const info = console.info;
  console.info = () => {};
  try {
    const service = desktop.createKnowledgeBaseService({
      app,
      aiService,
      configStore: { load: () => ({ developer_mode: false }) },
      knowledgeBaseStore: store,
    });
    service.retryDocument!(documentId, { isDestroyed: () => false, send: () => {} });
    const deadline = Date.now() + 30_000;
    while (!finished) {
      if (Date.now() > deadline) throw new Error('desktop preparation timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    console.info = info;
  }
  return { document, requests, blocks, filteredBlocks, candidateItems, steps, matchBatches, finalItems, matchResult };
}
