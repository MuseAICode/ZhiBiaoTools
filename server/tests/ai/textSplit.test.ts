// 按上下文长度切分（src/ai/textSplit.ts，取代桌面版 userTextSplitter.cjs）。
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_LENGTH_LIMIT, splitTextByContextLimit } from '../../src/ai/textSplit.ts';

describe('splitTextByContextLimit', () => {
  it('不超过“上下文长度 × 比例”时原样返回一段，默认上下文长度与桌面版相同', () => {
    expect(DEFAULT_CONTEXT_LENGTH_LIMIT).toBe(400_000);
    expect(splitTextByContextLimit('短文本')).toEqual(['短文本']);
    expect(splitTextByContextLimit('a'.repeat(80), { contextLengthLimit: 100 })).toHaveLength(1);
    expect(splitTextByContextLimit('a'.repeat(81), { contextLengthLimit: 100 })).toHaveLength(2);
    expect(splitTextByContextLimit('', { contextLengthLimit: 1 })).toEqual(['']);
  });

  it('各段首尾相接即原文，长度相近；切点优先落在标题前，其次句末', () => {
    const text = `${'第一部分正文。'.repeat(10)}\n## 第二部分\n${'第二部分正文。'.repeat(10)}`;
    const parts = splitTextByContextLimit(text, { contextLengthLimit: 100, limitRatio: 0.8 });
    expect(parts.join('')).toBe(text);
    expect(parts).toHaveLength(2);
    expect(parts[1]!.startsWith('## 第二部分')).toBe(true);

    const sentences = '甲乙丙丁戊己庚辛。'.repeat(20);
    for (const part of splitTextByContextLimit(sentences, { contextLengthLimit: 50 }).slice(0, -1)) expect(part.endsWith('。')).toBe(true);
  });

  it('不切开 Markdown 代码块和代理对', () => {
    const fenced = `${'说明。'.repeat(10)}\n\`\`\`\n${'x\n'.repeat(30)}\`\`\`\n${'结尾。'.repeat(10)}`;
    for (const part of splitTextByContextLimit(fenced, { contextLengthLimit: 60 })) {
      expect((part.match(/```/g) ?? []).length % 2 === 0 || part.includes('x')).toBe(true);
    }
    const emoji = '😀'.repeat(100);
    const parts = splitTextByContextLimit(emoji, { contextLengthLimit: 51 });
    expect(parts.join('')).toBe(emoji);
    for (const part of parts) expect(part.length % 2).toBe(0);
  });
});
