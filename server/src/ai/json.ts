// 从模型输出中解析 JSON（取代桌面版 aiService.cjs 的 parseJsonContent 与 buildJsonRepairMessages，逻辑原样搬运）：依次尝试整段、
// 去掉代码块包裹、代码块中的内容、括号配平的片段，以及修复非法反斜杠转义后的同一批候选；都不合法时由调用方请模型修复。
// 模型输出是不可信输入：括号配平只从前 MAX_BALANCED_STARTS 个左括号开始扫描（桌面版从每个左括号开始，最坏是平方级），
// 解析结果只当作数据使用。
import type { ChatMessage } from './providers.ts';

const MAX_BALANCED_STARTS = 32;

function extractJsonContent(content: string): string {
  const normalized = content.trim();
  if (!normalized.startsWith('```')) return normalized;
  const lines = normalized.split(/\r?\n/);
  const firstLine = (lines[0] ?? '').trim().toLowerCase();
  const lastLine = (lines[lines.length - 1] ?? '').trim();
  if ((firstLine === '```' || firstLine === '```json') && lastLine.startsWith('```')) return lines.slice(1, -1).join('\n').trim();
  return normalized;
}

function extractFencedJsonBlocks(content: string): string[] {
  const blocks: string[] = [];
  const normalized = content.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = fence.exec(normalized);
  while (match) {
    const block = (match[1] ?? '').trim();
    if (block) blocks.push(block);
    match = fence.exec(normalized);
  }
  return blocks;
}

function extractBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let starts = 0;
  for (let start = 0; start < text.length && starts < MAX_BALANCED_STARTS; start += 1) {
    const first = text[start];
    if (first !== '{' && first !== '[') continue;
    starts += 1;
    const stack = [first];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }
      if (char === '}' || char === ']') {
        if (stack[stack.length - 1] !== (char === '}' ? '{' : '[')) break;
        stack.pop();
        if (!stack.length) {
          const candidate = text.slice(start, index + 1).trim();
          if (candidate) candidates.push(candidate);
          start = index;
          break;
        }
      }
    }
  }
  return candidates;
}

const JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const MARKDOWN_ESCAPES = new Set(['.', '(', ')', '[', ']', '{', '}', '#', '*', '+', '-', '_', '!', '<', '>', '|', '`']);

/** 修复 JSON 字符串中的非法反斜杠转义（模型常把 Markdown 的 \. 等写进字符串）。 */
function repairInvalidJsonStringEscapes(text: string): string {
  let output = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = false;
      continue;
    }
    if (char !== '\\') {
      output += char;
      continue;
    }
    const next = text[index + 1] ?? '';
    if (!next) {
      output += '\\\\';
      continue;
    }
    if (next === 'u') {
      if (/^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
        output += text.slice(index, index + 6);
        index += 5;
      } else {
        output += '\\\\';
      }
      continue;
    }
    if (JSON_ESCAPES.has(next)) {
      output += char + next;
      index += 1;
      continue;
    }
    if (MARKDOWN_ESCAPES.has(next)) {
      output += next;
      index += 1;
      continue;
    }
    output += '\\\\';
  }
  return output;
}

/** 解析模型输出中的 JSON；都不合法时抛出最后一个解析错误（SyntaxError）。 */
export function parseJsonContent(content: string): unknown {
  const normalized = String(content ?? '').replace(/^﻿/, '').trim();
  const candidates = [normalized, extractJsonContent(normalized), ...extractFencedJsonBlocks(normalized)].filter(Boolean);
  const withBalanced: string[] = [];
  for (const candidate of candidates) withBalanced.push(candidate, ...extractBalancedJsonCandidates(candidate));
  const repaired: string[] = [];
  for (const candidate of withBalanced) {
    const fixed = repairInvalidJsonStringEscapes(candidate);
    if (fixed !== candidate) repaired.push(fixed);
  }
  const unique = [...new Set([...withBalanced, ...repaired].map((item) => item.trim()).filter(Boolean))];
  let lastError: unknown = null;
  for (const candidate of unique) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new SyntaxError('AI 返回内容为空，无法解析 JSON');
}

/** 给修复请求看的问题说明（与桌面版 formatJsonIssues 相同）。 */
export function jsonIssues(error: unknown): string[] {
  if (error instanceof SyntaxError) return [`JSON 语法错误：${error.message}`];
  return [error instanceof Error && error.message ? error.message : '字段校验失败'];
}

/** 请模型修复不合法 JSON 的消息（与桌面版 aiService.cjs 的 buildJsonRepairMessages 相同，待修复内容最多 60,000 字）。 */
export function buildJsonRepairMessages(invalidContent: string, issues: readonly string[], targetDescription: string): ChatMessage[] {
  const issueLines = issues.map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'system',
      content: `你是一个严格的 JSON 修复助手。请根据给出的原始内容和校验问题，修复现有结果。

要求：
1. 优先在原结果基础上做最小必要修改，不要整体重写
2. 尽量保留原有结构、字段值、节点顺序和已生成内容
3. 若缺少必填字段，应结合现有上下文补齐合理内容，不要用空字符串敷衍
4. 若存在多余说明、代码块包裹、字段名错误、children 结构不规范或顶层包裹错误，应修正为合法 JSON
5. 必须修复 JSON 字符串中的非法反斜杠转义，例如将 1\\. 改为 1.，或将必须保留的反斜杠写成 \\\\
6. 只返回修复后的完整 JSON，不要输出任何解释`,
    },
    { role: 'user', content: `目标结果类型：${targetDescription}` },
    { role: 'user', content: `当前校验问题：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent ?? '').slice(0, 60000)}\n\`\`\`` },
    { role: 'user', content: '请在保留原有正确内容的前提下，仅修复上述问题，并返回完整 JSON。' },
  ];
}
