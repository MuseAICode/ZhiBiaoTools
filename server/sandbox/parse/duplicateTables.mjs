// 标书查重读取 Markdown 中 HTML 表格的文字（路线图第 6 步 6.10），搬自桌面版 duplicateCheckService.cjs 的
// extractHtmlTableTextBlocks / extractHtmlCellTextBlocks。表格 HTML 来自本沙箱中的解析结果；cheerio 只在沙箱中运行，
// worker 中不运行 HTML 解析器（路线图第 6 步“上传的文件只在断网沙箱中解析”）。
import * as cheerio from 'cheerio';
import { addContentTextBlock } from './duplicateText.mjs';

function extractHtmlCellTextBlocks($, cell) {
  const blocks = [];
  const node = $(cell).clone();
  node.find('img').remove();
  node.find('br').replaceWith('\n');

  node.find('p, li, h1, h2, h3, h4, h5, h6, blockquote, div').each((_, element) => {
    const block = $(element).clone();
    block.find('img').remove();
    block.find('br').replaceWith('\n');
    addContentTextBlock(blocks, block.text());
    $(element).remove();
  });

  addContentTextBlock(blocks, node.text());
  return blocks;
}

export function extractHtmlTableTextBlocks(tableHtml) {
  const $ = cheerio.load(tableHtml, { decodeEntities: false });
  const blocks = [];
  $('tr').each((_, row) => {
    $(row).children('th, td').each((__, cell) => {
      for (const block of extractHtmlCellTextBlocks($, cell)) {
        addContentTextBlock(blocks, block);
      }
    });
  });
  if (!blocks.length) addContentTextBlock(blocks, $.root().text());
  return blocks;
}
