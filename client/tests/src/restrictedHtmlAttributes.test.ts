// @vitest-environment jsdom
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRestrictedHtml } from '../../src/shared/bodyHtml/restrictedHtml';

const require = createRequire(import.meta.url);
const { findHtmlStructureIssues } = require('../../electron/utils/htmlStructure.cjs');

const clientDir = path.resolve(__dirname, '../..');
const repoDir = path.resolve(clientDir, '..');
const read = (file: string) => fs.readFileSync(path.join(repoDir, file), 'utf8');

const specFile = 'client/electron/resources/content-generation/受限HTML生成规范.md';
const templateFile = 'client/electron/resources/content-generation/正文模板.html';
const cssFile = 'client/src/styles/shared-restricted-html.css';
const csharpFiles = [
  'openxmlhelper/src/OpenXmlHelper/Jobs/RestrictedHtmlWordInserter.cs',
  'openxmlhelper/src/OpenXmlHelper/Jobs/RestrictedHtmlDocumentRenderer.cs',
];
const exportFile = 'client/electron/services/technicalPlanExport.cjs';

/** AI 提示词中给模型看的受限 HTML 示例。 */
const specSamples = [...read(specFile).matchAll(/```html\n([\s\S]*?)```/g)].map((match) => match[1].trim());
const attributeNames = (text: string) => new Set(text.match(/data-app-[a-z-]+/g) || []);
const errorsOf = (html: string, options = {}) => parseRestrictedHtml(html, options).issues.filter((issue) => issue.level === 'error');

describe('受限 HTML 的 data-app-* 属性', () => {
  it('AI 提示词中的示例使用 data-app-*，每个示例都能通过前端解析和 Main 导出预检', () => {
    expect(specSamples.filter((sample) => attributeNames(sample).size).length).toBeGreaterThanOrEqual(3);
    for (const sample of specSamples) {
      expect(errorsOf(sample)).toEqual([]);
      const parsed = parseRestrictedHtml(sample);
      // 解析器会删除白名单外的属性，规范化结果仍含示例的全部属性说明新属性被识别。
      for (const name of attributeNames(sample)) expect(parsed.normalizedHtml).toContain(`${name}=`);
      expect(findHtmlStructureIssues(sample, { checkSourceCompleteness: true })).toEqual([]);
    }
  });

  it('正文模板（模型的版式参照）使用 data-app-* 并能通过解析', () => {
    const template = read(templateFile);
    expect([...attributeNames(template)]).toEqual(expect.arrayContaining([
      'data-app-generation', 'data-app-size', 'data-app-role', 'data-app-asset-ref', 'data-app-preset',
    ]));
    expect(errorsOf(template, { allowImageSrc: true })).toEqual([]);
  });

  it('前端预览保留新属性，样式表按同名属性选择器渲染画框、图片类型和表格预设', () => {
    const container = document.createElement('div');
    container.className = 'restricted-html-document';
    container.innerHTML = parseRestrictedHtml(specSamples.join('\n')).previewHtml;
    const figure = container.querySelector('figure[data-app-generation="mermaid"][data-app-size="wide"][data-app-fit="contain"]');
    expect(figure).not.toBeNull();
    expect(figure?.querySelector('template[data-app-role="prompt"]')).not.toBeNull();
    expect(figure?.querySelector('img[data-app-asset-ref="图片/实施阶段.png"]')).not.toBeNull();
    expect(container.querySelector('table[data-app-preset="headerRow"]')).not.toBeNull();

    const css = read(cssFile);
    for (const size of ['square', 'wide', 'tall', 'panorama']) expect(css).toContain(`figure[data-app-size='${size}']`);
    for (const generation of ['aiImage', 'mermaid', 'htmlImage']) expect(css).toContain(`figure[data-app-generation='${generation}']`);
    for (const preset of ['imageText', 'threeImages', 'fourImages']) expect(css).toContain(`table[data-app-preset='${preset}']`);
  });

  it('其他前缀的同名属性不被识别：配图缺少必填属性时报错，属性被清除', () => {
    const sample = specSamples.find((item) => item.includes('<figure'))!;
    const renamed = sample.replaceAll('data-app-', 'data-old-');
    const messages = errorsOf(renamed).map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining([
      'figure 缺少合法 data-app-generation',
      'figure 缺少合法 data-app-size',
    ]));
    expect(parseRestrictedHtml(renamed).previewHtml).not.toContain('data-old-');
  });

  it('Word 导出（C#）读取的属性与前端白名单、Main 组装的属性一致', () => {
    const parserAttributes = new Set(
      [...read('client/src/shared/bodyHtml/restrictedHtml.ts').matchAll(/names\.add\('(data-app-[a-z-]+)'\)/g)].map((match) => match[1]),
    );
    const exportAttributes = attributeNames(read(exportFile));
    const csharpAttributes = new Set(csharpFiles.flatMap((file) => [...attributeNames(read(file))]));

    // 配图与表格的导出依赖这些属性；Main 只为整本导出额外组装标题编号和页面范围属性。
    expect([...csharpAttributes].sort()).toEqual([
      'data-app-asset-ref', 'data-app-export-page-template', 'data-app-export-template',
      'data-app-fit', 'data-app-outline-number', 'data-app-preset', 'data-app-size',
    ]);
    for (const name of csharpAttributes) {
      expect(parserAttributes.has(name) || exportAttributes.has(name), name).toBe(true);
    }
    for (const name of ['data-app-outline-number', 'data-app-export-template', 'data-app-export-page-template']) {
      expect(exportAttributes.has(name), name).toBe(true);
    }
  });

  it('格式自检的定位标记在 Main 与 C# 中使用同一前缀 app_layout_', () => {
    expect(read(exportFile)).toContain('const name = `app_layout_${layoutSources.length}`;');
    expect(read(exportFile)).toContain('APPMARKLAYOUT:${name}');
    expect(read('openxmlhelper/src/OpenXmlHelper/Jobs/RestrictedHtmlDocumentRenderer.cs')).toContain('"APPMARKLAYOUT:app_layout_"');
  });
});
