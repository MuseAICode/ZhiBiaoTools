// 加载桌面版 knowledgeBaseService.cjs（tests/knowledgeBase/prepare.test.ts、tests/db/knowledgeBaseJobs.test.ts 对照用）：
// electron 与 fileService.cjs（文档解析，依赖 client/ 的 npm 包）换成桩，其余模块用桌面版原文件。
// runDesktopPreparation 用内存中的 Store 与模型桩执行桌面版的 prepareDocument（开发者模式，停在待匹配），
// 记下全部模型请求与写入的结果，供与服务端任务的结果逐项比较。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SERVICE = '../../../client/electron/services/knowledgeBaseService.cjs';

/** 解析结果由测试给出（取代 fileService.cjs 的 parseDocumentWithConfig）。 */
const parser = { markdown: '' };
/** 开发者模式的调试日志（silentFileLog.cjs 换成桩）：prepare:finish 表示 prepareDocument 已结束。 */
const debugEvents: string[] = [];

function loadDesktop(): any {
  const Module = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') return { dialog: {} };
    if (request === './fileService.cjs') return { parseDocumentWithConfig: async () => parser.markdown };
    if (request === '../utils/silentFileLog.cjs') {
      return { enqueueJsonLine: (_path: string, entry: { event: string }) => debugEvents.push(entry.event), enqueueLogRemoval: () => {} };
    }
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
}

/**
 * 以开发者模式执行桌面版的 prepareDocument（经 retryDocument 触发），respond 按请求消息返回模型输出（JSON 文本）。
 * contextLengthLimit 与服务端任务的 contextLengthLimit 相同时，分段与请求逐字相同。
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
  debugEvents.length = 0;

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
  const STEP_KEYS = ['copy_source', 'convert_markdown', 'build_blocks', 'extract_first_items', 'extract_supplement_items', 'merge_candidates', 'match_batches', 'recover_missing', 'save_result'];

  const store = {
    recoverInterruptedDocuments: () => [],
    getDocument: () => ({ ...document }),
    updateDocument: (_id: string, partial: Record<string, unknown>) => {
      document = { ...document, ...partial };
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
      if (start <= STEP_KEYS.indexOf('build_blocks')) {
        blocks = [];
        filteredBlocks = [];
      }
      if (start <= STEP_KEYS.indexOf('merge_candidates')) candidateItems = [];
    },
    updateMarkdownMetadata: () => {},
    saveBlocks: (_id: string, kept: any[], filtered: any[]) => {
      blocks = structuredClone(kept);
      filteredBlocks = structuredClone(filtered);
    },
    saveCandidateItems: (_id: string, items: any[]) => {
      candidateItems = structuredClone(items);
    },
  };

  const requests: DesktopRequest[] = [];
  const clone = (messages: any[]) => messages.map((message) => ({ role: String(message.role), content: String(message.content) }));
  const aiService = {
    getConfig: () => ({ context_length_limit: options.contextLengthLimit }),
    async chat(request: { messages: any[] }) {
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
      configStore: { load: () => ({ developer_mode: true }) },
      knowledgeBaseStore: store,
    });
    service.retryDocument!(documentId, { isDestroyed: () => false, send: () => {} });
    const deadline = Date.now() + 30_000;
    while (!debugEvents.includes('prepare:finish')) {
      if (Date.now() > deadline) throw new Error('desktop preparation timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    console.info = info;
  }
  return { document, requests, blocks, filteredBlocks, candidateItems, steps };
}
