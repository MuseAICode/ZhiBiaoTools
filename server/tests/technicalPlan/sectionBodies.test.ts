// src/technicalPlan/sectionBodies.ts 的 prepareSectionBody（8.10a）：AI 小节正文入库前经服务端受限 HTML 白名单规范化。
// 只保存规范化的结果；有 error 级问题时整节拒绝；链接、远程图片、内联样式等经清洗去掉，可见文字保留（8.6e2 第 6 项的入库一侧）。
// 数据库一侧（产物核对、替换、清空）见 tests/db/technicalPlanSectionBodies.test.ts。
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES, TECHNICAL_PLAN_SECTION_IMAGES_MAX } from '../../src/db/migrations/0046_technical_plan_section_bodies.ts';
import { prepareSectionBody, SectionBodyRejectedError } from '../../src/technicalPlan/sectionBodies.ts';
import { parseRestrictedHtml, RESTRICTED_HTML_BLOCK_MARKER } from '../../src/templates/restrictedHtml.ts';

const block = (html: string) => `${RESTRICTED_HTML_BLOCK_MARKER}\n${html}`;
const figure = (ref: string | null, id = 'f1') =>
  `<figure id="${id}" data-app-generation="aiImage" data-app-size="wide" data-app-fit="contain"><template data-app-role="prompt">现场示意</template><img alt="现场"${ref === null ? '' : ` data-app-asset-ref="${ref}"`}><figcaption>图 1 现场</figcaption></figure>`;

function rejected(source: string): string[] {
  try {
    prepareSectionBody(source);
  } catch (error) {
    expect(error).toBeInstanceOf(SectionBodyRejectedError);
    expect(error).toMatchObject({ statusCode: 422, code: 'TECHNICAL_PLAN_SECTION_BODY_INVALID' });
    return (error as SectionBodyRejectedError).issues;
  }
  throw new Error('应当被拒绝');
}

describe('prepareSectionBody', () => {
  it('合规正文：保存规范化的结果（与 parseRestrictedHtml 的 normalizedHtml 相同），配图引用按首次出现去重', () => {
    const a = randomUUID();
    const b = randomUUID();
    const source = [block('<p id="p1">第一段<strong>重点</strong>。</p>'), block(figure(a)), block(figure(b, 'f2')), block(figure(a, 'f3'))].join('\n');
    const prepared = prepareSectionBody(source);
    expect(prepared.html).toBe(parseRestrictedHtml(source).normalizedHtml);
    expect(prepared.imageArtifactIds).toEqual([a, b]);
  });

  it('配图尚未生成（img 没有 data-app-asset-ref）照常保存，不计入引用', () => {
    const prepared = prepareSectionBody([block('<p id="p1">段落</p>'), block(figure(null))].join('\n'));
    expect(prepared.imageArtifactIds).toEqual([]);
    expect(prepared.html).toContain('<img alt="现场">');
  });

  it('链接、远程图片、内联样式与事件属性被清除，可见文字保留；原文不保存（8.6e2 第 6 项）', () => {
    const ref = randomUUID();
    const source = [
      block('<p id="p1">正文 MARKER-VISIBLE-A<a href="http://example.invalid/pay" onclick="steal()">点我领奖</a>。</p>'),
      block(
        `<figure id="f1" data-app-generation="aiImage" data-app-size="wide"><template data-app-role="prompt">配图</template><img alt="x" src="http://example.invalid/track.png" onerror="steal()" data-app-asset-ref="${ref}"></figure>`,
      ),
      block('<p id="p2"><span style="color:#fff;font-size:0">MARKER-STYLED</span>结尾 MARKER-VISIBLE-B。</p>'),
    ].join('\n');
    const { html, imageArtifactIds } = prepareSectionBody(source);
    expect(html).toMatch(/MARKER-VISIBLE-A/);
    expect(html).toMatch(/点我领奖/);
    expect(html).toMatch(/MARKER-VISIBLE-B/);
    for (const pattern of [/<a[\s>]/i, /href=/i, /\ssrc=/i, /example\.invalid/, /onclick|onerror|steal/i, /style=/i, /font-size/i, /<span/i]) {
      expect(html, String(pattern)).not.toMatch(pattern);
    }
    // 去掉样式后原本“隐藏”的文字成为普通可见文字，不再隐藏。
    expect(html).toMatch(/MARKER-STYLED/);
    expect(imageArtifactIds).toEqual([ref]);
  });

  it('危险标签、不支持的块标签、结构不合规时整节拒绝，问题逐条带块序号，不含正文原文', () => {
    const cases: [string, RegExp][] = [
      // script 被 HTML 解析器放到 head 中，片段的 body 为空。
      [block('<p id="p1">正文</p>') + '\n' + block('<script>MARKER-HIDDEN</script>'), /第 2 块：片段缺少合法主块/],
      [block('<div style="display:none">MARKER-HIDDEN</div>'), /第 1 块：不支持块标签 <div>/],
      [block('<p id="p1">正文</p>') + '\n' + block('<iframe src="http://example.invalid"></iframe>'), /第 2 块：禁止使用 <iframe>/],
      [block('<p id="p1">正文</p><p id="p2">第二个主块</p>'), /每个片段只能包含一个主块/],
      [block('<p>缺少 id</p>'), /第 1 块：<p> 缺少合法 id/],
      ['<p id="p0">缺少分隔注释</p>' + block('<p id="p1">正文</p>'), /首个正文块前缺少 app:block 分隔注释/],
      [block('<figure id="f1" data-app-generation="aiImage"><img alt=""></figure>'), /img 必须包含非空 alt/],
    ];
    for (const [source, pattern] of cases) {
      const issues = rejected(source);
      expect(issues.join('\n'), source).toMatch(pattern);
      expect(issues.join('\n')).not.toMatch(/MARKER-HIDDEN|example\.invalid/);
    }
  });

  it('空正文、只有空白的正文被拒绝', () => {
    expect(rejected('')).toEqual(['正文为空']);
    expect(rejected(' \n\t ')).toEqual(['正文为空']);
    expect(rejected(`${RESTRICTED_HTML_BLOCK_MARKER}\n  \n`).join('')).toMatch(/没有可保存的正文块|没有可解析的正文块/);
  });

  it('配图引用必须是产物 id（小写 uuid）：工作区路径、大写、协议地址都拒绝', () => {
    for (const ref of ['图片/a.png', 'images/a.png', randomUUID().toUpperCase(), 'not-a-uuid', `${randomUUID()}/x`]) {
      expect(rejected(block(figure(ref))).join(''), ref).toMatch(/配图引用必须是本项目已生成的图片/);
    }
    // 协议地址与 ../ 先被白名单本身拒绝。
    expect(rejected(block(figure('http://example.invalid/a.png'))).join('')).toMatch(/data-app-asset-ref 必须是工作区内的相对路径/);
    expect(rejected(block(figure('../a.png'))).join('')).toMatch(/data-app-asset-ref 必须是工作区内的相对路径/);
  });

  it('超过大小与配图数上限时拒绝', () => {
    const big = Array.from({ length: Math.ceil(TECHNICAL_PLAN_SECTION_HTML_MAX_BYTES / 3000) + 1 }, (_, index) => block(`<p id="p${index}">${'字'.repeat(1000)}</p>`)).join('\n');
    expect(rejected(big).join('')).toMatch(/正文超过 2 MiB/);
    const many = Array.from({ length: TECHNICAL_PLAN_SECTION_IMAGES_MAX + 1 }, (_, index) => block(figure(randomUUID(), `f${index}`))).join('\n');
    expect(rejected(many).join('')).toMatch(new RegExp(`至多引用 ${TECHNICAL_PLAN_SECTION_IMAGES_MAX} 张配图`));
    const atLimit = Array.from({ length: TECHNICAL_PLAN_SECTION_IMAGES_MAX }, (_, index) => block(figure(randomUUID(), `f${index}`))).join('\n');
    expect(prepareSectionBody(atLimit).imageArtifactIds).toHaveLength(TECHNICAL_PLAN_SECTION_IMAGES_MAX);
  });

  it('属性值中的引号不会伪造引用（规范化结果由解析树序列化）', () => {
    const ref = randomUUID();
    const prepared = prepareSectionBody(block(`<p id="p1">说明 &lt;img data-app-asset-ref="${randomUUID()}"&gt;</p>`) + '\n' + block(figure(ref)));
    expect(prepared.imageArtifactIds).toEqual([ref]);
  });
});
