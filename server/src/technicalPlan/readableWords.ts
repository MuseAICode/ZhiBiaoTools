// 可读正文的字数统计（路线图第 8 步 8.10c2a），与桌面版 client/electron/utils/wordCount.cjs 的 countReadableWords 及
// contentGenerationWordTools.cjs 的 countHtmlWords 相同：汉字逐字计数，其余按英文单词与数字串计数；HTML 去掉标签，正文 HTML 另去掉
// 配图提示词（<template>）。测试逐个输入与桌面版核对（tests/technicalPlan/contentSectionWriting.test.ts）。

function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '\n');
}

function stripMarkdownImages(content: string): string {
  return content.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
}

function keepMarkdownLinkText(content: string): string {
  return content
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
}

function stripUrls(content: string): string {
  return content.replace(/\b(?:https?|file|app-asset):\/\/\S+/gi, ' ');
}

function stripHtml(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(?:p|div|section|article|tr|td|th|li|ul|ol|table|thead|tbody|blockquote|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeMarkdownLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(trimmed)) return '';

  return line
    .replace(/^\s{0,3}#{1,6}\s+/g, ' ')
    .replace(/^\s{0,3}>\s?/g, ' ')
    .replace(/^\s*[-+*]\s+(?:\[[ xX]\]\s*)?/g, ' ')
    .replace(/^\s*\d+[.)．、]\s+/g, ' ')
    .replace(/^\s*\|/, ' ')
    .replace(/\|\s*$/g, ' ')
    .replace(/\|/g, ' ');
}

export function normalizeReadableText(content: unknown): string {
  return stripHtml(stripUrls(keepMarkdownLinkText(stripMarkdownImages(stripFencedCodeBlocks(String(content || ''))))))
    .split(/\r?\n/)
    .map(normalizeMarkdownLine)
    .join('\n')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[~*_#>\[\](){}|\\]/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countReadableWords(content: unknown): number {
  const readableText = normalizeReadableText(content);
  if (!readableText) return 0;

  const cjkCount = (readableText.match(/[㐀-鿿]/gu) || []).length;
  const withoutCjk = readableText.replace(/[㐀-鿿]/gu, ' ');
  const tokenCount = (withoutCjk.match(/[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)*/g) || []).length;
  return cjkCount + tokenCount;
}

/** 统计实际 HTML 中的可读正文，排除图片提示词。 */
export function countHtmlWords(html: unknown): number {
  return countReadableWords(String(html).replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ''));
}
