// 模板样张 HTML 的服务端校验（路线图第 7 步决定事项第 8 项，7.3a）。
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PREVIEW_ASSET_REFS, PREVIEW_HTML_MAX_BYTES, validatePreviewHtml } from '../../src/templates/previewHtml.ts';
import { parseRestrictedHtml } from '../../src/templates/restrictedHtml.ts';

const M = '<!-- app:block -->';
const template = readFileSync(new URL('../../../client/electron/resources/content-generation/正文模板.html', import.meta.url), 'utf8');
const documentTemplateSource = readFileSync(new URL('../../../client/src/shared/bodyHtml/documentTemplate.ts', import.meta.url), 'utf8');
const previewAssetDir = new URL('../../../client/assets/content-template-preview/', import.meta.url);

/** 与前端 DOCUMENT_DISPLAY_TEMPLATE_HTML 相同：把 src 换成打包后的地址（Vite 带哈希的文件名）。 */
function displayTemplate(url: (name: string) => string) {
  return template.replace(/src="assets\/([a-z-]+)\.webp"/g, (_match, name: string) => `src="${url(name)}"`);
}

const figure = (ref: string | null, extra = '') => `<figure id="f1" data-app-generation="aiImage" data-app-size="wide">`
  + `<template data-app-role="prompt">说明</template><img${ref === null ? '' : ` data-app-asset-ref="${ref}"`} alt="图"${extra}></figure>`;

function expectRejected(html: unknown, reason: string) {
  const result = validatePreviewHtml(html);
  expect(result.ok, typeof html === 'string' ? html.slice(0, 200) : String(html)).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

describe('样张固定配图', () => {
  it('与桌面版随包的样张配图、前端样张的图片表、正文模板中的引用三者一致', () => {
    const files = readdirSync(previewAssetDir).filter((name) => name.endsWith('.webp')).sort();
    expect(files.length).toBe(5);
    expect([...PREVIEW_ASSET_REFS].sort()).toEqual(files.map((name) => `assets/${name}`));
    const frontend = [...documentTemplateSource.matchAll(/^\s+'(assets\/[^']+)': /gm)].map((match) => match[1]!);
    expect(frontend.sort()).toEqual([...PREVIEW_ASSET_REFS].sort());
    const used = [...new Set([...template.matchAll(/data-app-asset-ref="([^"]+)"/g)].map((match) => match[1]!))];
    expect(used.sort()).toEqual([...PREVIEW_ASSET_REFS].sort());
  });

  it('清单不可修改', () => {
    expect(Object.isFrozen(PREVIEW_ASSET_REFS)).toBe(true);
  });
});

describe('validatePreviewHtml：前端样张', () => {
  it.each([
    ['Vite 打包后的地址', (name: string) => `/assets/${name}-Bx7Kq2Lm.webp`],
    ['开发服务器的地址', (name: string) => `/@fs/home/dev/client/assets/content-template-preview/${name}.webp?import`],
    ['原始相对地址', (name: string) => `assets/${name}.webp`],
    ['任意地址（不转发）', () => 'https://evil.example/x.png'],
  ])('src 为%s时通过，转发的 HTML 不含 src、与正文模板去掉 src 后的规范化结果相同', (_name, url) => {
    const result = validatePreviewHtml(displayTemplate(url));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toMatch(/\ssrc=/);
    expect(result.html).not.toContain('evil.example');
    expect(result.html).toBe(parseRestrictedHtml(template).normalizedHtml);
    expect(result.assetRefs).toEqual(PREVIEW_ASSET_REFS);
    expect(result.html.split(M).length - 1).toBe(parseRestrictedHtml(template).blocks.length);
  });

  it('没有配图的样张也可以，assetRefs 为空；只返回用到的配图', () => {
    const plain = validatePreviewHtml(`${M}\n<p id="p1">正文</p>`);
    expect(plain).toEqual({ ok: true, html: `${M}\n<p id="p1">正文</p>`, assetRefs: [] });
    const one = validatePreviewHtml(`${M}\n${figure('assets/visual-wbs-mindmap.webp')}`);
    expect(one.ok && one.assetRefs).toEqual(['assets/visual-wbs-mindmap.webp']);
  });

  it('大小上限按 UTF-8 字节计算', () => {
    const paragraph = (id: number, text: string) => `${M}\n<p id="p${id}">${text}</p>\n`;
    let html = '';
    for (let index = 0; Buffer.byteLength(html) < PREVIEW_HTML_MAX_BYTES - 2048; index += 1) html += paragraph(index, '中'.repeat(300));
    expect(validatePreviewHtml(html).ok).toBe(true);
    const over = html + paragraph(99_999, '中'.repeat(Math.ceil((PREVIEW_HTML_MAX_BYTES - Buffer.byteLength(html)) / 3) + 10));
    expect(over.length).toBeLessThan(PREVIEW_HTML_MAX_BYTES);
    expectRejected(over, 'too_large');
  });
});

describe('validatePreviewHtml：拒绝', () => {
  it('不是字符串、为空或没有块', () => {
    for (const value of [undefined, null, 1, {}, [], Buffer.from('x')]) expectRejected(value, 'not_string');
    for (const value of ['', '   \n']) expectRejected(value, 'empty');
    // 只有分隔注释时前端报“没有可解析的正文块”
    expectRejected(`${M}\n\n${M}`, 'not_restricted_html');
  });

  it('前端会报错的内容', () => {
    for (const html of [
      `${M}\n<p id="p1">前<script>alert(1)</script>后</p>`,
      `${M}\n<p id="p1">x<svg onload="alert(1)"></svg></p>`,
      `${M}\n<div id="d1">块</div>`,
      `${M}\n<p>缺少 id</p>`,
      `${M}\n<p id="a">一</p>\n${M}\n<p id="a">二</p>`,
      `<p id="p0">分隔注释前的内容</p>\n${M}\n<p id="p1">正文</p>`,
      `${M}\n<p id="p1">x</p><style>p{}</style>`,
      `${M}\n<table id="t1" data-app-preset="plain"><tbody><tr><td rowspan="3">a</td></tr></tbody></table>`,
    ]) expectRejected(html, 'not_restricted_html');
  });

  it('前端只会警告并删除的内容也拒绝（多余的标签、属性、事件处理器）', () => {
    for (const html of [
      `${M}\n<p id="p1"><span>文字</span></p>`,
      `${M}\n<p id="p1"><a href="javascript:alert(1)">链接</a></p>`,
      `${M}\n<p id="p1" class="x">正文</p>`,
      `${M}\n<p id="p1" style="background:url(https://evil.example/x.png)">正文</p>`,
      `${M}\n<p id="p1" onclick="alert(1)">正文</p>`,
      `${M}\n${figure('assets/visual-wbs-mindmap.webp', ' onerror="alert(1)"')}`,
      `${M}\n${figure('assets/visual-wbs-mindmap.webp', ' srcset="https://evil.example/x.png 2x"')}`,
      `${M}\n<p id="p1">x<noscript>y</noscript></p>`,
    ]) expectRejected(html, 'not_restricted_html');
  });

  it('配图只能引用固定的样张配图', () => {
    for (const ref of [
      'assets/other.webp',
      'assets/Visual-wbs-mindmap.webp',
      ' assets/visual-wbs-mindmap.webp',
      'visual-wbs-mindmap.webp',
      'assets/../assets/visual-wbs-mindmap.webp',
      'assets/./visual-wbs-mindmap.webp',
      'artifact:00000000-0000-4000-8000-000000000000',
      'projects/1/image.png',
    ]) expectRejected(`${M}\n${figure(ref)}`, ref.includes('..') || ref.includes(':') ? 'not_restricted_html' : 'asset_ref');
    expectRejected(`${M}\n${figure(null)}`, 'asset_ref');
    expectRejected(`${M}\n${figure(null, ' src="assets/visual-wbs-mindmap.webp"')}`, 'asset_ref');
  });

  it('解析时被移到 head 的内容不进入规范化结果，因而不会转发', () => {
    const result = validatePreviewHtml(`${M}\n<script>alert(1)</script><meta http-equiv="refresh" content="0"><p id="p1">正文</p>`);
    expect(result).toEqual({ ok: true, html: `${M}\n<p id="p1">正文</p>`, assetRefs: [] });
  });

  it('拒绝结果不含输入内容', () => {
    const result = validatePreviewHtml(`${M}\n<p id="p1">机密<span>x</span></p>`);
    expect(result).toEqual({ ok: false, reason: 'not_restricted_html', issueCount: 1 });
  });
});
