// export 沙箱入口与桌面版的逐项核对（路线图第 7 步 7.2），不需要 Docker：按源码比较入口（server/sandbox/export）与
// 桌面版 Main（client/electron/services）中各自手写的同一段逻辑，任何一边改动而另一边没跟上时失败。
// - 交给助手的 chrome_assets：字段与取值表达式逐行相同（只有 root 两端各自约定）；
// - 装饰 SVG 交给 Chromium 时包的固定尺寸容器：与桌面版 chromeAssetService.rasterizeSvg 相同。
// 装饰生成器本身（同一份代码）在沙箱中的输出见 tests/sandbox/docker/export.test.ts。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const entrySource = readFileSync(new URL('../../sandbox/export/entry.mjs', import.meta.url), 'utf8');
const renderSource = readFileSync(new URL('../../sandbox/export/render.mjs', import.meta.url), 'utf8');
const desktopHelperSource = readFileSync(new URL('../../../client/electron/services/openXmlHelperService.cjs', import.meta.url), 'utf8');
const desktopChromeSource = readFileSync(new URL('../../../client/electron/services/chromeAssetService.cjs', import.meta.url), 'utf8');

/** 源码中唯一一处 chrome_assets: { ... } 的各行（去掉缩进）。 */
function chromeAssetsLines(source: string): string[] {
  const start = source.indexOf('chrome_assets: {');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(source.indexOf('chrome_assets: {', start + 1)).toBe(-1);
  const end = source.indexOf('}', start);
  return source
    .slice(start + 'chrome_assets: {'.length, end)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('export 入口与桌面版一致', () => {
  it('交给助手的 chrome_assets 字段与取值逐行相同（root 除外）', () => {
    const entry = chromeAssetsLines(entrySource);
    const desktop = chromeAssetsLines(desktopHelperSource);
    expect(entry.length).toBeGreaterThanOrEqual(10);
    expect(entry.filter((line) => line.startsWith('root:'))).toEqual(['root: chrome.root,']);
    expect(desktop.filter((line) => line.startsWith('root:'))).toEqual(['root: chrome.assetRoot,']);
    expect(entry.filter((line) => !line.startsWith('root:'))).toEqual(desktop.filter((line) => !line.startsWith('root:')));
  });

  it('两端都由 buildChrome(page) 得到装饰，页面配置取自 export_format.page', () => {
    expect(desktopChromeSource).toContain('const chrome = buildChrome(pageConfig || {});');
    expect(desktopHelperSource).toContain('buildChromeAssets(app, exportFormat?.page)');
    expect(entrySource).toContain("chrome = buildChrome(isPlainObject(page) ? page : {});");
    expect(entrySource).toContain('buildChromeAssets(input.exportFormat.page)');
  });

  it('装饰 SVG 包进与桌面版相同的固定尺寸容器', () => {
    const container = '`<div style="width:${width}px;height:${height}px;overflow:hidden;line-height:0">`';
    const stretch = "replace('<svg ', `<svg style=\"display:block;width:${width}px;height:${height}px\" `)";
    for (const source of [desktopChromeSource, renderSource]) {
      expect(source).toContain(container);
      expect(source).toContain(stretch);
    }
    // 尺寸按同一公式由 cm 换算成 CSS 像素。
    const cmToPx = 'Math.max(1, Math.round((cm * CSS_DPI) / 2.54))';
    expect(desktopChromeSource).toContain(cmToPx);
    expect(renderSource).toContain(cmToPx);
  });
});
