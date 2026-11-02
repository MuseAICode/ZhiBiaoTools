// 装饰生成器核对用的页面配置（路线图第 7 步 7.2）：8 种页眉页脚样式 × 各类开关与可配几何、配色、纸张、页码，
// 外加桌面版系统模板的页面配置。全部先经桌面版 normalizeExportFormat 规范化（7.3 起服务端入队前做同样的规范化），
// 另保留几份未规范化的原始配置（入口只要求 page 是对象）。期望值由宿主上的桌面版装饰生成器
// （client/electron/shared/chrome/index.mjs，桌面版 chromeAssetService 加载的同一个文件）给出。
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeExportFormat } = require('../../../../client/electron/services/exportFormatDefaults.cjs') as {
  normalizeExportFormat(source: unknown): { page: Record<string, unknown> };
};
const { SYSTEM_EXPORT_TEMPLATES } = require('../../../../client/electron/services/systemExportTemplates.cjs') as {
  SYSTEM_EXPORT_TEMPLATES: Array<{ template_id: string; config: { page?: Record<string, unknown> } }>;
};

export const DESKTOP_CHROME_MODULE = new URL('../../../../client/electron/shared/chrome/index.mjs', import.meta.url);

export const DECORATION_STYLES = ['plain', 'band', 'rules', 'top-bar', 'footer-badge', 'slant', 'letterhead', 'frame'] as const;

export interface DecorationCase {
  name: string;
  page: Record<string, unknown>;
}

const FULL = {
  header_enabled: true,
  header_text: '智标装饰核对 · 第一章 总体方案',
  header_badge_text: '智标',
  footer_enabled: true,
  footer_text: '智标导出测试 机密文件',
  page_number_enabled: true,
};

/** 每种样式下的变体（叠加在 FULL 之上，再规范化）。 */
const VARIANTS: Record<string, Record<string, unknown>> = {
  full: {},
  'header-only': { footer_enabled: false, page_number_enabled: false },
  'footer-only': { header_enabled: false },
  'page-number-only': { header_enabled: false, footer_enabled: false, page_number_enabled: true, page_number_format: '- {page} -', page_number_pad: 2, page_number_start: 7 },
  'empty-text': { header_text: '', header_badge_text: '', footer_text: '' },
  'custom-geometry': {
    header_chrome_height_cm: 2.2,
    footer_chrome_height_cm: 1.4,
    header_text_top_cm: 0.4,
    header_text_left_cm: 3.1,
    footer_text_top_cm: 0.2,
    footer_text_left_cm: 2.6,
    footer_distance_cm: 0.8,
    margin_top_cm: 3.2,
    margin_bottom_cm: 2.7,
    margin_left_cm: 2.4,
    margin_right_cm: 1.8,
  },
  'colors-and-fonts': {
    chrome_bar_color: '#1f3a5f',
    chrome_accent_color: '#c0392b',
    header_color: '#ffffff',
    footer_color: '#333333',
    header_font: '黑体',
    footer_font: '仿宋',
    header_size: '小四',
    footer_size: '五号',
    header_alignment: '左对齐',
    footer_alignment: '右对齐',
  },
  'landscape-a3': { paper_size: 'a3', orientation: 'landscape', two_column: true },
  'letter-long-text': { paper_size: 'letter', header_text: '很长的页眉文字'.repeat(12), footer_text: '很长的页脚文字'.repeat(12), header_badge_text: '超过四个字的角标' },
  'out-of-range': { header_chrome_height_cm: 99, footer_chrome_height_cm: 0.01, header_text_left_cm: -5, chrome_bar_color: 'not-a-color', chrome_accent_color: '#abc' },
};

export function decorationCases(): DecorationCase[] {
  const cases: DecorationCase[] = [];
  for (const style of DECORATION_STYLES) {
    for (const [variant, overrides] of Object.entries(VARIANTS)) {
      cases.push({ name: `${style}/${variant}`, page: normalizeExportFormat({ page: { ...FULL, header_footer_style: style, ...overrides } }).page });
    }
  }
  for (const template of SYSTEM_EXPORT_TEMPLATES) {
    cases.push({ name: `system/${template.template_id}`, page: normalizeExportFormat(template.config).page });
  }
  // 未规范化的配置：空对象、只有样式、旧样式名（规范化前）。
  cases.push({ name: 'raw/empty', page: {} });
  cases.push({ name: 'raw/style-only', page: { header_footer_style: 'band', header_enabled: true, footer_enabled: true } });
  cases.push({ name: 'raw/legacy-style', page: { header_footer_style: 'spine', header_enabled: true, header_text: '旧样式' } });
  return cases;
}

export interface ChromeDigest {
  style: string;
  headerSvg: string | null;
  footerSvg: string | null;
  /** layout、colors、textLayout 的 JSON。 */
  geometry: string;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** buildChrome 结果的摘要（沙箱中的输出有 64 KiB 上限，SVG 与几何都按 SHA-256 比较）。 */
export function digestChrome(chrome: { style: string; headerSvg: string | null; footerSvg: string | null; layout: unknown; colors: unknown; textLayout: unknown }): ChromeDigest {
  return {
    style: chrome.style,
    headerSvg: chrome.headerSvg === null ? null : sha256(chrome.headerSvg),
    footerSvg: chrome.footerSvg === null ? null : sha256(chrome.footerSvg),
    geometry: sha256(JSON.stringify({ layout: chrome.layout, colors: chrome.colors, textLayout: chrome.textLayout })),
  };
}

/** 与 digestChrome 相同的摘要，在沙箱中执行（node -e）。读 /work/pages.json，输出 { 名称: 摘要 }。 */
export const SANDBOX_DIGEST_SCRIPT = `
const crypto = require('crypto');
const fs = require('fs');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
import('file:///opt/export/chrome/index.mjs').then(({ buildChrome }) => {
  const out = {};
  for (const { name, page } of JSON.parse(fs.readFileSync('/work/pages.json', 'utf8'))) {
    const chrome = buildChrome(page);
    out[name] = {
      style: chrome.style,
      headerSvg: chrome.headerSvg === null ? null : sha256(chrome.headerSvg),
      footerSvg: chrome.footerSvg === null ? null : sha256(chrome.footerSvg),
      geometry: sha256(JSON.stringify({ layout: chrome.layout, colors: chrome.colors, textLayout: chrome.textLayout })),
    };
  }
  console.log(JSON.stringify(out));
});
`;

/**
 * 桌面版交给助手的 chrome_assets（openXmlHelperService.createRestrictedHtmlDocx）中由几何决定的字段；
 * root 与 header / footer 的文件名两端各自约定（桌面版按内容哈希命名），只比较有无。
 * 字段的对应关系与桌面版逐行一致，由 tests/sandbox/exportEntry.test.ts 按源码核对。
 */
export function desktopChromeAssets(chrome: { headerSvg: string | null; footerSvg: string | null; layout: Record<string, number>; textLayout: unknown }) {
  return {
    header: Boolean(chrome.headerSvg) && chrome.layout.headerHeightCm! > 0,
    footer: Boolean(chrome.footerSvg) && chrome.layout.footerHeightCm! > 0,
    header_height_cm: chrome.layout.headerHeightCm,
    footer_height_cm: chrome.layout.footerHeightCm,
    footer_top_cm: chrome.layout.footerTopCm,
    footer_distance_cm: chrome.layout.footerDistanceCm,
    header_distance_cm: chrome.layout.headerDistanceCm,
    margin_top_cm: chrome.layout.marginTopCm,
    margin_bottom_cm: chrome.layout.marginBottomCm,
    text_layout: chrome.textLayout,
  };
}
