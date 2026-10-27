// 解析入口输出的校验（路线图第 6 步：“解析结果按不可信输入校验”）。归档本身（文件类型、路径、数量、大小、扩展名）已由
// src/sandbox/archive.ts 按 parse 模板校验；这里再校验内容：
// - 只能有 content.md、manifest.json 和清单中登记的 images/image-NNNN.<扩展名>，不多不少；
// - 清单的结构、图片数量（至多 2,000 张）、MIME 与扩展名一致，图片的文件头与 MIME 一致；
// - content.md 是合法 UTF-8；
// - Markdown 中的图片引用只保留指向本次输出图片的（改写为产物地址），其他（远程地址、data: 等）一律去掉；
//   引用了本次输出中没有的图片时整体拒绝（桌面版导入原方案时“校验原图资源”，路线图第 6 步事项第 19 项）。
// 解析入口失败时只采用它在标准输出最后一行给出的错误代码（白名单内），不采用任何文字。
import type { SandboxFile } from '../sandbox/archive.ts';

export const PARSE_MAX_IMAGES = 2_000;

const IMAGE_PATH = /^images\/image-(\d{4})\.(png|jpg|gif|webp|bmp)$/;
const EXTENSION_MIME: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
});

/** 解析入口给出的错误代码（server/sandbox/parse/entry.mjs）。 */
export const PARSE_ENTRY_ERROR_CODES = [
  'bad_arguments',
  'unsupported_format',
  'text_decode_failed',
  'zip_invalid',
  'zip_too_many_entries',
  'zip_too_large',
  'zip_ratio',
  'pdf_invalid',
  'pdf_too_many_pages',
  'pdf_text_layer_missing',
  'spreadsheet_empty',
  'office_conversion_failed',
  'too_many_images',
  'conversion_failed',
] as const;
export type ParseEntryErrorCode = (typeof PARSE_ENTRY_ERROR_CODES)[number];

/** 解析输出不符合规则。reason 是固定的英文短语，不含输出中的内容。 */
export class ParseOutputError extends Error {
  readonly reason: string;
  /** 引用了输出中没有的图片（给用户的文案不同）。 */
  readonly missingImage: boolean;

  constructor(reason: string, options: { missingImage?: boolean } = {}) {
    super(`parse output rejected: ${reason}`);
    this.name = 'ParseOutputError';
    this.reason = reason;
    this.missingImage = options.missingImage ?? false;
  }
}

export interface ParsedImage {
  /** 输出中的相对路径（images/image-0001.png），Markdown 按它引用。 */
  path: string;
  mime: string;
  data: Buffer;
}

export interface ParsedOutput {
  markdown: string;
  images: ParsedImage[];
}

/** 标准输出最后一个非空行的 {"error":"代码"}；不是白名单内的代码时返回 conversion_failed。 */
export function entryErrorCode(stdout: string): ParseEntryErrorCode {
  const line = stdout.split('\n').map((item) => item.trim()).filter(Boolean).at(-1) ?? '';
  try {
    const code = (JSON.parse(line) as { error?: unknown }).error;
    if (typeof code === 'string' && (PARSE_ENTRY_ERROR_CODES as readonly string[]).includes(code)) return code as ParseEntryErrorCode;
  } catch {
    // 不是 JSON。
  }
  return 'conversion_failed';
}

function startsWith(data: Buffer, signature: readonly number[], offset = 0): boolean {
  return data.length >= offset + signature.length && signature.every((byte, index) => data[offset + index] === byte);
}

/** 图片的文件头与登记的 MIME 一致（产物以登记的 Content-Type 下载）。 */
export function imageMatchesMime(data: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/png':
      return startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(data, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    case 'image/webp':
      return startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8);
    case 'image/bmp':
      return startsWith(data, [0x42, 0x4d]) && data.length >= 26;
    default:
      return false;
  }
}

function parseManifest(data: Buffer): Array<{ path: string; mime: string }> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new ParseOutputError('manifest is not valid json');
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw new ParseOutputError('manifest is not an object');
  const { version, images, ...rest } = manifest as Record<string, unknown>;
  if (version !== 1 || Object.keys(rest).length > 0 || !Array.isArray(images)) throw new ParseOutputError('manifest has an unexpected shape');
  if (images.length > PARSE_MAX_IMAGES) throw new ParseOutputError('too many images');
  return images.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new ParseOutputError('manifest image is not an object');
    const { path, mime, ...other } = item as Record<string, unknown>;
    if (typeof path !== 'string' || typeof mime !== 'string' || Object.keys(other).length > 0) throw new ParseOutputError('manifest image has an unexpected shape');
    const match = IMAGE_PATH.exec(path);
    // 编号从 1 开始连续，与入口的写法一致；同一路径不会出现两次。
    if (!match || Number(match[1]) !== index + 1) throw new ParseOutputError('manifest image path is not allowed');
    if (EXTENSION_MIME[match[2]!] !== mime) throw new ParseOutputError('manifest image mime does not match its extension');
    return { path, mime };
  });
}

/** 校验解析输出（归档已由 src/sandbox/archive.ts 校验）。不符时抛 ParseOutputError。 */
export function validateParseOutput(files: readonly SandboxFile[]): ParsedOutput {
  const byPath = new Map(files.map((file) => [file.path, file.data]));
  const content = byPath.get('content.md');
  const manifestData = byPath.get('manifest.json');
  if (!content || !manifestData) throw new ParseOutputError('content.md or manifest.json is missing');
  const declared = parseManifest(manifestData);
  if (files.length !== declared.length + 2) throw new ParseOutputError('output contains files not listed in the manifest');
  const images = declared.map(({ path, mime }) => {
    const data = byPath.get(path);
    if (!data) throw new ParseOutputError('image listed in the manifest is missing');
    if (!imageMatchesMime(data, mime)) throw new ParseOutputError('image content does not match its mime');
    return { path, mime, data };
  });
  let markdown: string;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new ParseOutputError('content.md is not valid utf-8');
  }
  return { markdown: markdown.replace(/^﻿/, '').replace(/\u0000/g, ''), images };
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(\s+"[^"]*")?\)/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;
const HTML_SRC = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * 把 Markdown 中的图片引用改写为产物地址：指向本次输出图片（images/…）的改为 urls 中的地址，其他图片（远程地址、data:、
 * 其他路径）一律去掉；引用了 urls 中没有的 images/… 时抛 ParseOutputError（missingImage）。
 * 也处理 HTML 表格（mammoth 的表格原样保留为 HTML）中的 <img>。
 */
export function rewriteImageReferences(markdown: string, urls: ReadonlyMap<string, string>): string {
  const resolve = (target: string): string | null => {
    const clean = target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
    if (!IMAGE_PATH.test(clean)) return null;
    const url = urls.get(clean);
    if (!url) throw new ParseOutputError('markdown references an image that is not in the output', { missingImage: true });
    return url;
  };
  const withMarkdown = markdown.replace(MARKDOWN_IMAGE, (_match, alt: string, target: string, title: string | undefined) => {
    const url = resolve(target);
    return url ? `![${alt}](${url}${title ?? ''})` : '';
  });
  return withMarkdown.replace(HTML_IMAGE, (tag) => {
    const src = HTML_SRC.exec(tag);
    const url = src ? resolve(src[1] ?? src[2] ?? src[3] ?? '') : null;
    return url ? `<img src="${url}">` : '';
  });
}
