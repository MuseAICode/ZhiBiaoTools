// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseRestrictedHtml, RESTRICTED_HTML_BLOCK_MARKER } from '../../src/shared/bodyHtml/restrictedHtml';
import type { SkeletonPlan } from '../../src/shared/layoutBudget/sectionSkeleton';
import { assembleRestrictedHtml, buildSkeletonSystemPrompt, extractHtml } from '../../src/shared/layoutBudget/skeletonPrompt';

const plan = {
  blocks: [{ kind: 'heading', id: 'h', level: 2, text: '施工组织设计' }],
} as unknown as SkeletonPlan;

describe('受限 HTML 分块标记', () => {
  it('分块标记为 <!-- app:block -->，提示词要求模型使用同一标记', () => {
    expect(RESTRICTED_HTML_BLOCK_MARKER).toBe('<!-- app:block -->');
    expect(buildSkeletonSystemPrompt()).toContain('每个块前面单独一行 <!-- app:block --> 注释');
  });

  it('程序组装的正文带新标记，并能被解析器按块解析', () => {
    // 模型漏写了标记，组装时按顶层元素补齐，标题由程序拼在最前面。
    const assembled = assembleRestrictedHtml('<p id="p1">第一段。</p>\n<p id="p2">第二段。</p>', plan);
    expect(assembled.html.match(/<!-- app:block -->/g)).toHaveLength(3);
    expect(assembled.html.startsWith(RESTRICTED_HTML_BLOCK_MARKER)).toBe(true);

    const parsed = parseRestrictedHtml(assembled.html);
    expect(parsed.issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(parsed.blocks.map((block) => block.valid)).toEqual([true, true, true]);
    expect(parsed.normalizedHtml).toBe(assembled.html);
  });

  it('模型按提示词输出的新标记能被提取和解析，解析结果原样保留标记', () => {
    const reply = `好的，正文如下：\n<!-- app:block -->\n<p id="p1">甲。</p>\n\n<!--  app:block  -->\n<ul id="l1"><li>乙</li></ul>`;
    const html = extractHtml(reply);
    expect(html.startsWith('<!-- app:block -->')).toBe(true);

    const parsed = parseRestrictedHtml(html);
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.normalizedHtml).toBe(`${RESTRICTED_HTML_BLOCK_MARKER}\n<p id="p1">甲。</p>\n\n${RESTRICTED_HTML_BLOCK_MARKER}\n<ul id="l1"><li>乙</li></ul>`);
  });

  it('其他命名的注释不算分块标记', () => {
    const parsed = parseRestrictedHtml('<!-- other:block -->\n<p id="p1">甲。</p>');
    expect(parsed.normalizedHtml).toBeNull();
    expect(parsed.issues.map((issue) => issue.message)).toContain('首个正文块前缺少 app:block 分隔注释');
  });
});
