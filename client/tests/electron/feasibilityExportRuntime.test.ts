// 可研导出的可注入运行时（路线图第 7 步 7.5a）：exportService.buildDocxResult 的配图读取、图片规范化与页眉页脚装饰转图
// 经 options.runtime 注入，桌面版不传、用 DESKTOP_EXPORT_RUNTIME（行为不变）；export 沙箱（7.5b）注入自己的实现。
// 1. 不加载 Electron 也能加载模块并生成可研 Word（沙箱中没有 Electron）；
// 2. 同一份可研输入，桌面版默认运行时与等价的注入运行时生成的 docx 正文、页眉页脚与图片部件逐字节相同（含装饰 PNG）；
// 3. 注入的运行时接管全部配图来源：读取函数收到每一处图片地址，读不到时与桌面版“未找到可用图片数据”的提示相同，
//    规范化失败时与桌面版“图片格式转换失败”的提示相同；
// 4. 注入的运行时必须给出全部三个函数，不能部分沿用桌面版的实现。
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';
import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type Loaded = { buffer: Buffer; type: string | null } | null;
interface ChromePng { buffer: Buffer; widthCm: number; heightCm: number }
interface Runtime {
  loadImage: (source: string, context: unknown) => Promise<Loaded>;
  normalizeImage: (loaded: Loaded) => Loaded;
  renderChromePngs: (page: unknown) => Promise<{ header: ChromePng | null; footer: ChromePng | null; layout: unknown; textLayout: unknown; colors: unknown }>;
}
interface ExportServiceModule {
  DESKTOP_EXPORT_RUNTIME: Runtime;
  buildDocxResult: (payload: unknown, options?: { runtime?: Runtime }) => Promise<{ buffer: Buffer; warnings: string[] }>;
  createExportService: (deps: Record<string, unknown>) => { exportWord: (payload: unknown) => Promise<{ success: boolean; canceled?: boolean }> };
}
interface ChromeModule {
  buildChrome: (page: unknown) => { headerSvg: string | null; footerSvg: string | null; layout: { widthCm: number; headerHeightCm: number; footerHeightCm: number }; textLayout: unknown; colors: unknown };
}

const SERVICE = '../../electron/services/exportService.cjs';
const CHROME_ASSETS = '../../electron/services/chromeAssetService.cjs';
const CHROME_MODULE = '../../electron/shared/chrome/index.mjs';

/** 每次装饰都用同一张 1×1 PNG（真实栅格化由桌面版的隐藏窗口或 7.5b 的 Chromium 完成，这里只比较注入点）。 */
const DECORATION_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const IMAGE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNk+M9QzwAEjDAGNzYAAEsbBB+8hyQ/AAAAAElFTkSuQmCC',
  'base64',
);

interface LoadOptions {
  /** 为 true 时 require('electron') 抛错（沙箱中没有 Electron）；否则返回桩。 */
  noElectron?: boolean;
  electron?: Record<string, unknown>;
}

// Electron 与隐藏窗口渲染改为用到时才加载（7.5a），所以替换要在整个测试期间生效，不只在加载模块时。
let current: LoadOptions = {};
const Module = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = Module._load;
Module._load = function load(request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    if (current.noElectron) throw new Error('electron is not available in the sandbox');
    return current.electron ?? { app: undefined, dialog: {}, nativeImage: undefined };
  }
  if (request === './localImageRenderService.cjs') {
    if (current.noElectron) throw new Error('the hidden-window renderer needs electron');
    return { getLocalImageRenderService: () => ({ renderExactHtmlToPng: async () => ({ buffer: DECORATION_PNG }) }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
afterAll(() => {
  Module._load = originalLoad;
});

/** 重新加载 exportService 与 chromeAssetService（清掉缓存，装饰 PNG 的缓存也随之清空），之后按给出的方式替换 Electron。 */
function loadService(options: LoadOptions = {}): ExportServiceModule {
  for (const id of [SERVICE, CHROME_ASSETS]) delete require.cache[require.resolve(id)];
  current = options;
  return require(SERVICE) as ExportServiceModule;
}

function defaultExportFormat(headerFooterStyle: string): Record<string, unknown> {
  const format = (require('../../electron/services/exportFormatDefaults.cjs') as { cloneDefaultExportFormat: () => Record<string, any> })
    .cloneDefaultExportFormat();
  format.page = { ...format.page, header_footer_style: headerFooterStyle, header_enabled: true, header_text: '可研页眉', footer_enabled: true, footer_text: '可研页脚' };
  return format;
}

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

function feasibilityPayload(headerFooterStyle = 'plain', content = `## 概述\n\n正文第一段。\n\n![选址图](${dataUrl(IMAGE_PNG)})\n\n| 指标 | 数值 |\n|---|---|\n| 总投资 | 1000 万元 |`) {
  return {
    project_name: '示例产业园可行性研究报告',
    export_format: defaultExportFormat(headerFooterStyle),
    outline: [
      { id: 'c1', title: '总论', children: [{ id: 'c1-1', title: '项目概况', content }] },
      { id: 'c2', title: '建设条件', content: '<p>原始 <strong>HTML</strong> 段落</p>\n\n- 列表一\n- 列表二' },
    ],
    feasibility_options: {
      includeCover: true,
      includePreparationNotes: true,
      includeAppendixTables: true,
      preparationUnit: '编制中心',
      securityLevel: '内部资料',
      documentCode: 'KYBG-123456',
      project_info: {
        projectName: '示例产业园', projectType: 'industrial', industry: '制造业', constructionUnit: '示例公司', location: '某市',
        constructionContent: '厂房与配套', constructionPeriodYears: '2', operationPeriodYears: '20', totalInvestment: '1000', fundingSource: '自筹',
      },
    },
  };
}

/** 与 7.5b 沙箱入口等价的注入运行时：只认 data URL，图片原样（不是 WebP），装饰几何来自同一份共享模块。 */
function sandboxLikeRuntime(calls: string[] = []): Runtime {
  return {
    async loadImage(source) {
      calls.push(source);
      const match = /^data:([^;,]+);base64,(.+)$/i.exec(source);
      if (!match) return null;
      return { buffer: Buffer.from(match[2]!, 'base64'), type: match[1]!.includes('png') ? 'png' : null };
    },
    normalizeImage: (loaded) => loaded,
    async renderChromePngs(page) {
      const { buildChrome } = (await import(CHROME_MODULE)) as ChromeModule;
      const chrome = buildChrome(page || {});
      const emit = (svg: string | null, heightCm: number) => (svg && heightCm > 0 ? { buffer: DECORATION_PNG, widthCm: chrome.layout.widthCm, heightCm } : null);
      return {
        header: emit(chrome.headerSvg, chrome.layout.headerHeightCm),
        footer: emit(chrome.footerSvg, chrome.layout.footerHeightCm),
        layout: chrome.layout,
        textLayout: chrome.textLayout,
        colors: chrome.colors,
      };
    },
  };
}

/** docx 中除 docProps（含生成时间）以外的全部部件。 */
function parts(buffer: Buffer): Map<string, Buffer> {
  const zip = new AdmZip(buffer);
  return new Map(zip.getEntries().filter((entry) => !entry.entryName.startsWith('docProps/')).map((entry) => [entry.entryName, entry.getData()]));
}

function expectSameParts(left: Buffer, right: Buffer) {
  const a = parts(left);
  const b = parts(right);
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [name, data] of a) expect(b.get(name)!.equals(data), name).toBe(true);
}

describe('不加载 Electron', () => {
  it('模块能加载，注入运行时时生成可研 Word，不调用 Electron', async () => {
    const service = loadService({ noElectron: true });
    const calls: string[] = [];
    const result = await service.buildDocxResult(feasibilityPayload('band'), { runtime: sandboxLikeRuntime(calls) });
    const document = parts(result.buffer).get('word/document.xml')!.toString('utf8');
    expect(document).toContain('可行性研究报告');
    expect(document).toContain('KYBG-123456');
    expect(document).toContain('原始 ');
    expect(result.warnings).toEqual([]);
    expect(calls).toEqual([dataUrl(IMAGE_PNG)]);
    expect([...parts(result.buffer).keys()].filter((name) => name.startsWith('word/media/')).length).toBeGreaterThanOrEqual(2);
  });

  it('不注入时仍是桌面版的运行时：WebP 走 nativeImage，没有 Electron 时该图原位提示', async () => {
    const service = loadService({ noElectron: true });
    const webp = `data:image/webp;base64,${Buffer.from('RIFF....WEBPVP8 ').toString('base64')}`;
    const result = await service.buildDocxResult(feasibilityPayload('plain', `![动图](${webp})`));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^图片无法导出：动图，/);
  });
});

describe('桌面版默认运行时与等价的注入运行时', () => {
  for (const style of ['plain', 'band', 'frame']) {
    it(`生成相同的 docx（页眉页脚样式 ${style}）`, async () => {
      const service = loadService();
      const desktop = await service.buildDocxResult(feasibilityPayload(style));
      const injected = await service.buildDocxResult(feasibilityPayload(style), { runtime: sandboxLikeRuntime() });
      expectSameParts(desktop.buffer, injected.buffer);
      expect(injected.warnings).toEqual(desktop.warnings);
    });
  }

  it('默认运行时就是 DESKTOP_EXPORT_RUNTIME，显式传入时结果相同', async () => {
    const service = loadService();
    const implicit = await service.buildDocxResult(feasibilityPayload('band'));
    const explicit = await service.buildDocxResult(feasibilityPayload('band'), { runtime: service.DESKTOP_EXPORT_RUNTIME });
    expectSameParts(implicit.buffer, explicit.buffer);
    expect(Object.isFrozen(service.DESKTOP_EXPORT_RUNTIME)).toBe(true);
  });
});

describe('注入的运行时接管全部配图来源', () => {
  it('每一处图片地址都交给注入的读取函数；读不到时与桌面版找不到文件时的提示相同', async () => {
    const service = loadService();
    // file:// 地址在 markdown-it 中就被拦下（validateLink），桌面版同样不会读取，这里不列。
    const sources = ['app-asset://imported-images/a.png', 'https://example.com/b.png', '/etc/passwd.png', './relative/c.png'];
    const content = sources.map((source, index) => `![图${index}](${source})`).join('\n\n');
    const calls: string[] = [];
    const injected = await service.buildDocxResult(feasibilityPayload('plain', content), { runtime: sandboxLikeRuntime(calls) });
    expect(calls).toEqual(sources);
    expect(injected.warnings).toEqual(sources.map((_source, index) => `图片无法导出：图${index}，未找到可用图片数据`));
    // 桌面版读不到本机文件（app-asset 没有 app、本机路径不存在）时是同样的提示。
    const desktop = await service.buildDocxResult(feasibilityPayload('plain', '![图0](app-asset://imported-images/a.png)\n\n![图2](/nonexistent/c.png)'));
    expect(desktop.warnings).toEqual(['图片无法导出：图0，未找到可用图片数据', '图片无法导出：图2，未找到可用图片数据']);
  });

  it('注入的规范化失败时与桌面版相同的原位提示', async () => {
    const service = loadService();
    const runtime = { ...sandboxLikeRuntime(), normalizeImage: () => { throw new Error('WebP 图片转换失败'); } };
    const result = await service.buildDocxResult(feasibilityPayload('plain', `![选址图](${dataUrl(IMAGE_PNG)})`), { runtime });
    expect(result.warnings).toEqual(['图片无法导出：选址图，WebP 图片转换失败']);
  });
});

describe('运行时的形态', () => {
  it('缺少任何一个函数、不是对象时拒绝，不部分沿用桌面版', async () => {
    const service = loadService();
    const full = sandboxLikeRuntime();
    for (const runtime of [null, {}, { ...full, loadImage: undefined }, { ...full, normalizeImage: 'x' }, { ...full, renderChromePngs: undefined }]) {
      await expect(service.buildDocxResult(feasibilityPayload(), { runtime: runtime as unknown as Runtime })).rejects.toThrow(TypeError);
    }
  });
});

describe('桌面版保存流程', () => {
  it('Electron 在导出时才加载：保存对话框取消时返回 canceled', async () => {
    const electron = {
      app: { getPath: () => '/tmp' },
      dialog: { showSaveDialog: async () => ({ canceled: true }) },
      nativeImage: undefined,
    };
    const service = loadService({ electron });
    const result = await service.createExportService({ configStore: { get: () => ({}) } }).exportWord(feasibilityPayload());
    expect(result).toMatchObject({ success: false, canceled: true });
  });
});
