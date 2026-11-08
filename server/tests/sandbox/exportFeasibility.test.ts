// 可研报告导出 Word 的沙箱侧规则（路线图第 7 步 7.5b；server/sandbox/export/feasibility.mjs、entry.mjs、Dockerfile），不需要 Docker：
// 1. request.json 的形态：只把已知字段交给桌面版的 buildDocxResult（base_dir 等让桌面版读本机文件的字段一律拒绝）；
// 2. 注入的运行时只认本项目产物地址（assets/<产物 id>）与 data URL，其他来源读不到；产物按文件头识别类型；WebP 经调用方给出的
//    转换器转成 PNG，失败时与桌面版相同的原因；装饰与桌面版 renderChromePngs 的返回值形态相同；
// 3. 提示文字在写进 result.json 之前去掉控制字符、限制条数与长度；
// 4. 镜像与入口的约定：镜像复制的桌面版文件就是可研导出用到的全部本仓库模块；desktop/package-lock.json 的条目与
//    client/package-lock.json 中的同名条目逐项相同；入口的 feasibility 模式不经助手、静默桌面版代码的 console。
// 真实沙箱中的端到端测试见 tests/sandbox/docker/exportFeasibility.test.ts。
import { readFileSync } from 'node:fs';
import {
  FEASIBILITY_FIELD_MAX,
  FEASIBILITY_NODE_ID_MAX,
  FEASIBILITY_OUTLINE_DEPTH_MAX,
  FEASIBILITY_TEXT_MAX,
  FEASIBILITY_TITLE_MAX,
} from '../../src/db/migrations/0017_feasibility_report.ts';
import { FEASIBILITY_REPORT_EXPORT_PROJECT_NAME_MAX } from '../../src/db/migrations/0030_feasibility_report_export.ts';
import { FEASIBILITY_EXPORT_OPTION_TEXT_MAX } from '../../src/export/feasibilityRequestStore.ts';
import { FEASIBILITY_OUTLINE_NODES_MAX } from '../../src/feasibilityReport/store.ts';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 沙箱入口的 ESM 模块没有类型声明
import * as feasibility from '../../sandbox/export/feasibility.mjs';

const {
  createFeasibilityRuntime,
  FeasibilityRequestError,
  imageTypeFromBytes,
  imageTypeFromMime,
  MAX_WARNING_CHARS,
  MAX_WARNINGS,
  parseFeasibilityRequest,
  renderChromeWith,
  sanitizeWarnings,
} = feasibility as Record<string, any>;

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const entrySource = read('../../sandbox/export/entry.mjs');
const dockerfile = read('../../sandbox/export/Dockerfile');
const ID = '0b6f1f8e-3c1a-4d0e-9a51-0e2f7f9d1a01';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

function request(extra: Record<string, unknown> = {}) {
  return {
    project_name: '可研报告',
    outline: [{ id: 'a', title: '总论', description: '', children: [{ id: 'b', title: '概况', content: '正文' }] }],
    export_format: { page: {} },
    feasibility_options: {
      includeCover: true, includePreparationNotes: false, includeAppendixTables: true,
      preparationUnit: '编制中心', securityLevel: '内部资料', documentCode: 'KYBG-1',
      project_info: { projectName: '项目', constructionContent: '多行\n说明' },
    },
    ...extra,
  };
}

describe('request.json', () => {
  it('passes only the four known fields to buildDocxResult', () => {
    const payload = parseFeasibilityRequest(request({ asset_types: { [ID]: 'image/png' } }));
    expect(Object.keys(payload).sort()).toEqual(['export_format', 'feasibility_options', 'outline', 'project_name']);
    expect(payload.outline).toEqual(request().outline);
    expect(payload.feasibility_options.project_info).toEqual({ projectName: '项目', constructionContent: '多行\n说明' });
  });

  it.each([
    ['an unknown top-level field (base_dir would make the desktop code read local files)', { base_dir: '/etc' }],
    ['html of another mode', { html: '<p>x</p>' }],
    ['an empty outline', { outline: [] }],
    ['an outline node with an unknown field', { outline: [{ id: 'a', title: 't', number: '1' }] }],
    ['a non-string content', { outline: [{ id: 'a', title: 't', content: 1 }] }],
    ['a non-object export_format', { export_format: [] }],
    ['an unknown option', { feasibility_options: { ...request().feasibility_options, baseDir: '/' } }],
    ['a non-boolean flag', { feasibility_options: { ...request().feasibility_options, includeCover: 'yes' } }],
    ['an unknown project_info field', { feasibility_options: { ...request().feasibility_options, project_info: { evil: 'x' } } }],
    ['a too long title', { outline: [{ id: 'a', title: 'x'.repeat(2_001) }] }],
  ])('rejects %s', (_name, extra) => {
    expect(() => parseFeasibilityRequest(request(extra))).toThrow(FeasibilityRequestError);
  });

  it('accepts everything the server can store (outline, project information and option limits)', () => {
    expect(feasibility.MAX_TITLE_CHARS).toBeGreaterThanOrEqual(FEASIBILITY_TITLE_MAX);
    expect(feasibility.MAX_ID_CHARS).toBeGreaterThanOrEqual(FEASIBILITY_NODE_ID_MAX);
    expect(feasibility.MAX_OUTLINE_NODES).toBeGreaterThanOrEqual(FEASIBILITY_OUTLINE_NODES_MAX);
    expect(feasibility.MAX_OUTLINE_DEPTH).toBeGreaterThanOrEqual(FEASIBILITY_OUTLINE_DEPTH_MAX);
    expect(feasibility.MAX_PROJECT_INFO_CHARS).toBeGreaterThanOrEqual(FEASIBILITY_TEXT_MAX);
    expect(feasibility.MAX_TEXT_CHARS).toBeGreaterThanOrEqual(Math.max(FEASIBILITY_FIELD_MAX, FEASIBILITY_EXPORT_OPTION_TEXT_MAX, FEASIBILITY_REPORT_EXPORT_PROJECT_NAME_MAX));
    const longest = parseFeasibilityRequest(request({
      project_name: '名'.repeat(FEASIBILITY_REPORT_EXPORT_PROJECT_NAME_MAX),
      outline: [{ id: 'i'.repeat(FEASIBILITY_NODE_ID_MAX), title: '标'.repeat(FEASIBILITY_TITLE_MAX), content: '正' }],
    }));
    expect([...longest.outline[0].title]).toHaveLength(FEASIBILITY_TITLE_MAX);
  });

  it('rejects outlines that are too deep or have too many nodes', () => {
    let deep: Record<string, unknown> = { id: 'leaf', title: 't' };
    for (let index = 0; index < 64; index += 1) deep = { id: `n${index}`, title: 't', children: [deep] };
    expect(() => parseFeasibilityRequest(request({ outline: [deep] }))).toThrow(FeasibilityRequestError);
    const wide = Array.from({ length: 2_001 }, (_item, index) => ({ id: `n${index}`, title: 't' }));
    expect(() => parseFeasibilityRequest(request({ outline: wide }))).toThrow(FeasibilityRequestError);
    expect(parseFeasibilityRequest(request({ outline: wide.slice(0, 2_000) })).outline).toHaveLength(2_000);
  });
});

describe('injected runtime', () => {
  function runtime(assets: Record<string, Buffer> = {}) {
    const reads: string[] = [];
    const converted: Buffer[] = [];
    const value = createFeasibilityRuntime({
      async readAsset(id: string) {
        reads.push(id);
        return assets[id] ?? null;
      },
      async convertWebp(data: Buffer) {
        converted.push(data);
        return data.equals(WEBP) ? PNG : null;
      },
      renderChromePngs: async (page: unknown) => ({ page }),
    });
    return { runtime: value, reads, converted };
  }

  it('reads project artifacts from assets/<id> (case-insensitive id) and sniffs their type', async () => {
    const { runtime: value, reads } = runtime({ [ID]: PNG });
    expect(await value.loadImage(`/api/artifacts/${ID.toUpperCase()}/content`)).toEqual({ buffer: PNG, type: 'png' });
    expect(await value.loadImage(` /api/artifacts/${ID}/content `)).toEqual({ buffer: PNG, type: 'png' });
    expect(reads).toEqual([ID, ID]);
  });

  it('decodes data URLs like the desktop code', async () => {
    const { runtime: value } = runtime();
    expect(await value.loadImage(`data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`)).toEqual({ buffer: Buffer.from('jpg'), type: 'jpg' });
    expect(await value.loadImage(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)).toEqual({ buffer: Buffer.from('<svg/>'), type: null });
  });

  it('does not read anything for any other source', async () => {
    const { runtime: value, reads } = runtime({ [ID]: PNG });
    for (const source of [
      'app-asset://imported-images/a.png', 'https://example.com/a.png', 'http://127.0.0.1/a.png', '/etc/passwd', '../assets/' + ID,
      'file:///work/assets/' + ID, `/api/artifacts/${ID}/content?x=1`, `/api/artifacts/${ID}/content/../x`, `https://host/api/artifacts/${ID}/content`, '',
    ]) {
      expect(await value.loadImage(source), source).toBeNull();
    }
    expect(reads).toEqual([]);
  });

  it('returns null for an artifact that was not put into the sandbox', async () => {
    const { runtime: value, reads } = runtime();
    expect(await value.loadImage(`/api/artifacts/${ID}/content`)).toBeNull();
    expect(reads).toEqual([ID]);
  });

  it('converts WebP to PNG and fails like the desktop code when the conversion fails', async () => {
    const { runtime: value, converted } = runtime();
    expect(await value.normalizeImage({ buffer: WEBP, type: 'webp' })).toEqual({ buffer: PNG, type: 'png' });
    await expect(value.normalizeImage({ buffer: Buffer.from('RIFFxxxxWEBPbroken'), type: 'webp' })).rejects.toThrow('WebP 图片转换失败');
    const png = { buffer: PNG, type: 'png' };
    expect(await value.normalizeImage(png)).toBe(png);
    expect(await value.normalizeImage(null)).toBeNull();
    expect(converted).toHaveLength(2);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(value).sort()).toEqual(['loadImage', 'normalizeImage', 'renderChromePngs']);
  });

  it('sniffs the image types the desktop code can embed', () => {
    expect(imageTypeFromBytes(PNG)).toBe('png');
    expect(imageTypeFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(imageTypeFromBytes(Buffer.from('GIF89a'))).toBe('gif');
    expect(imageTypeFromBytes(Buffer.from('BM\0\0'))).toBe('bmp');
    expect(imageTypeFromBytes(WEBP)).toBe('webp');
    expect(imageTypeFromBytes(Buffer.from('<svg/>'))).toBeNull();
    expect(imageTypeFromMime('image/png')).toBe('png');
    expect(imageTypeFromMime('image/tiff')).toBeNull();
  });

  it('renders decorations with the same shape as chromeAssetService.renderChromePngs, rasterizing each SVG once', async () => {
    const rasterized: string[] = [];
    const layout = { widthCm: 21, headerHeightCm: 1.5, footerHeightCm: 1 };
    const buildChrome = () => ({ headerSvg: '<svg>h</svg>', footerSvg: '<svg>h</svg>', layout, textLayout: { t: 1 }, colors: { c: 1 } });
    const result = await renderChromeWith(buildChrome, async (svg: string, widthCm: number, heightCm: number) => {
      rasterized.push(`${svg}:${widthCm}:${heightCm}`);
      return PNG;
    }, { header_footer_style: 'band' });
    expect(result).toEqual({
      header: { buffer: PNG, widthCm: 21, heightCm: 1.5 },
      footer: { buffer: PNG, widthCm: 21, heightCm: 1 },
      layout, textLayout: { t: 1 }, colors: { c: 1 },
    });
    expect(rasterized).toEqual(['<svg>h</svg>:21:1.5']);
    const plain = await renderChromeWith(() => ({ headerSvg: null, footerSvg: '', layout, textLayout: {}, colors: {} }), async () => PNG, null);
    expect([plain.header, plain.footer]).toEqual([null, null]);
  });
});

describe('warnings written to result.json', () => {
  it('keeps only bounded strings without control characters', () => {
    expect(sanitizeWarnings(['图片无法导出：a\nb\u0000c', 1, null, 'ok'])).toEqual(['图片无法导出：a b c', 'ok']);
    expect(sanitizeWarnings('x')).toEqual([]);
    expect(sanitizeWarnings(Array.from({ length: MAX_WARNINGS + 5 }, () => 'w'))).toHaveLength(MAX_WARNINGS);
    expect([...sanitizeWarnings(['图'.repeat(MAX_WARNING_CHARS + 10)])[0]]).toHaveLength(MAX_WARNING_CHARS);
  });
});

describe('image and entry conventions', () => {
  it('the image copies exactly the repository modules the desktop feasibility export loads', () => {
    // 与在 client/ 中加载 exportService.cjs 并生成一份可研 Word 时实际加载的本仓库模块相同（7.5b 实测），另加装饰生成器。
    const copied = [...dockerfile.matchAll(/^COPY --chmod=0644 --from=desktop (.+) \/opt\/export\/desktop\/electron\/[a-z/]+\/$/gm)]
      .flatMap((match) => match[1]!.split(' '));
    expect(copied.sort()).toEqual([
      'services/chromeAssetService.cjs', 'services/exportService.cjs', 'shared/chrome/*.mjs',
      'utils/developerLog.cjs', 'utils/paths.cjs', 'utils/renderMarkdownHtml.cjs', 'utils/silentFileLog.cjs',
    ]);
    for (const file of copied.filter((name) => !name.includes('*'))) {
      // exportService.cjs 末尾的独立自检（require.main === module）只在直接运行该文件时执行，不算。
      const full = read(`../../../client/electron/${file}`);
      const selfTest = full.indexOf('if (require.main === module)');
      const source = selfTest >= 0 ? full.slice(0, selfTest) : full;
      for (const match of source.matchAll(/require\('(\.[^']+)'\)/g)) {
        // 只在函数内按需加载、沙箱中不会走到的模块（Electron 的隐藏窗口渲染）除外。
        if (match[1] === './localImageRenderService.cjs') continue;
        const target = new URL(match[1]!, new URL(`../../../client/electron/${file}`, import.meta.url)).pathname.split('/client/electron/')[1];
        expect(copied, `${file} requires ${match[1]}`).toContain(target);
      }
    }
    expect(dockerfile).toContain('--build-context desktop=client/electron');
    expect(dockerfile).toMatch(/COPY --chmod=0644 package\.json entry\.mjs render\.mjs webp\.mjs feasibility\.mjs \/opt\/export\//);
  });

  it('desktop/package-lock.json has exactly the entries of client/package-lock.json it needs', () => {
    const client = JSON.parse(read('../../../client/package-lock.json')) as { packages: Record<string, Record<string, unknown>> };
    const desktop = JSON.parse(read('../../sandbox/export/desktop/package-lock.json')) as { packages: Record<string, Record<string, unknown>> };
    const manifest = JSON.parse(read('../../sandbox/export/desktop/package.json')) as { dependencies: Record<string, string> };
    const clientManifest = JSON.parse(read('../../../client/package.json')) as { dependencies: Record<string, string> };
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      expect(clientManifest.dependencies[name], name).toBeDefined();
      expect(client.packages[`node_modules/${name}`]!.version, name).toBe(version);
    }
    const entries = Object.entries(desktop.packages).filter(([key]) => key !== '');
    expect(entries.length).toBeGreaterThan(10);
    for (const [key, entry] of entries) {
      const original = client.packages[key];
      expect(original, key).toBeDefined();
      for (const field of ['version', 'resolved', 'integrity', 'license', 'dependencies']) expect(entry[field], `${key} ${field}`).toEqual(original![field]);
      expect(entry.hasInstallScript, key).toBeUndefined();
    }
  });

  it('the feasibility mode runs the desktop code in-process, not OpenXmlHelper, and silences its console', () => {
    expect(entrySource).toContain("const DESKTOP_EXPORT_SERVICE = '/opt/export/desktop/electron/services/exportService.cjs';");
    const runner = entrySource.slice(entrySource.indexOf('async function runFeasibility('), entrySource.indexOf('/** 运行助手一次'));
    expect(runner).toContain('silenceConsole();');
    expect(runner.indexOf('silenceConsole();')).toBeLessThan(runner.indexOf('createRequire(import.meta.url)(DESKTOP_EXPORT_SERVICE)'));
    expect(runner).toContain('buildDocxResult(input.payload, { runtime })');
    expect(runner).not.toContain('runHelper');
    expect(entrySource).toMatch(/feasibility: Object\.freeze\(\{ feasibility: true, buildTimeoutMs: 18 \* 60_000, builtInAssets: false, convertWebp: true \}\)/);
  });
});
