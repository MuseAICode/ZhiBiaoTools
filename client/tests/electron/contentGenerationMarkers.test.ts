import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { topLevelNodes } = require('../../electron/services/contentGenerationAiBatch.cjs');
const { protectBlocks, restoreBlocks } = require('../../electron/services/contentGenerationWordTools.cjs');

describe('正文生成的分块与占位标记', () => {
  it('按 app:block 注释识别分块标记，其他注释忽略', () => {
    const { nodes } = topLevelNodes('<!-- app:block -->\n<p id="p1">甲</p>\n<!-- other:block -->\n<!--app:block-->\n<p id="p2">乙</p>');
    expect(nodes.map((node: { kind: string }) => node.kind)).toEqual(['marker', 'element', 'marker', 'element']);
  });

  it('图片和表格替换为 app:keep-N 占位，改写后按占位原样还原', () => {
    const html = '<!-- app:block -->\n<p id="p1">甲</p>\n<!-- app:block -->\n<table id="t1"><tbody><tr><td>1</td></tr></tbody></table>\n<!-- app:block -->\n<figure id="f1"><img src="app-asset://generated-images/a.png"></figure>';
    const { text, blocks } = protectBlocks(html);
    expect(text).toContain('<!-- app:keep-1 -->');
    expect(text).toContain('<!-- app:keep-2 -->');
    expect(blocks).toHaveLength(2);

    const rewritten = text.replace('<p id="p1">甲</p>', '<p id="p1">甲（改写）</p>');
    const restored = restoreBlocks(rewritten, blocks);
    expect(restored).toContain('<p id="p1">甲（改写）</p>');
    expect(restored).toContain('<table id="t1">');
    expect(restored).toContain('app-asset://generated-images/a.png');
    expect(restored).not.toContain('app:keep-');
  });

  it('占位缺失时报错，提示须按顺序保留', () => {
    const { blocks } = protectBlocks('<table id="t1"><tbody><tr><td>1</td></tr></tbody></table>');
    expect(() => restoreBlocks('<p>没有占位</p>', blocks)).toThrow('占位注释须按原顺序各保留一次');
  });
});
