// 整本导出的 HTML 组装（src/export/documentHtml.ts，路线图第 7 步 7.4c）：
// - 共用用例：client/tests/fixtures/technicalPlanExportCases.json 由桌面版 technicalPlanExport.build 记录
//   （client/tests/electron/technicalPlanExportCases.test.ts 核对），服务端对每条用例必须得到相同的 HTML、提示与消息。
//   约定见那份测试的开头：IMAGE:<名称> 在这里换成 /api/artifacts/<uuid>/content，结果中的产物 id 写回 IMAGE:<名称>；
//   桌面版读取本机路径失败的原因在服务端是 UNSUPPORTED_IMAGE_REASON（服务端不读任何非产物地址）；
// - 服务端独有的规则：只认产物地址、引用去重与小写、用户原始 HTML 中自带的 data-app-asset-ref 不保留、转换器提示逐处归到小节、
//   目录为空与标题过深的错误代码。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assembleDocumentHtml,
  collectOutlineExportEntries,
  DocumentHtmlError,
  EXPORT_DONE_MESSAGE,
  summarizeDocumentExport,
  UNSUPPORTED_IMAGE_REASON,
  type DocumentSnapshot,
} from '../../src/export/documentHtml.ts';
import type { TechnicalPlanOutlineItem } from '../../src/technicalPlan/outline.ts';

interface FixtureItem {
  id: string;
  title: string;
  content_mode?: string;
  content_mode_note?: string;
  content?: string;
  children?: FixtureItem[];
}

interface ExportCase {
  name: string;
  snapshot: { project_name?: string; export_template_scope: 'ai-only' | 'document'; outline: FixtureItem[] };
  imageWarnings?: { image: string; reason: string }[];
  expected: { html: string; warnings: string[]; message: string } | { error: string };
}

const cases = JSON.parse(
  readFileSync(new URL('../../../client/tests/fixtures/technicalPlanExportCases.json', import.meta.url), 'utf8'),
) as ExportCase[];
const DESKTOP_MISSING_IMAGE_REASON = '图片文件不存在或为空';
const IMAGE_TOKEN = /IMAGE:([a-z0-9]+)/g;

/** 每个图片名称对应一个固定的产物 id（大写，验证引用统一为小写）。 */
function artifactId(name: string): string {
  const hex = Buffer.from(name).toString('hex').padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${hex}`.toUpperCase();
}

function toServerOutline(items: FixtureItem[]): TechnicalPlanOutlineItem[] {
  return items.map((item) => ({
    ...(item as Omit<TechnicalPlanOutlineItem, 'number' | 'description' | 'children'>),
    description: '',
    number: '',
    ...(item.content === undefined ? {} : {
      // ./missing-image.png 原样保留：桌面版读取失败的本机路径，在服务端同样不是产物地址。
      content: item.content.replace(IMAGE_TOKEN, (_m, name: string) => `/api/artifacts/${artifactId(name)}/content`),
    }),
    ...(item.children ? { children: toServerOutline(item.children) } : {}),
  }));
}

function runServer(item: ExportCase): ExportCase['expected'] {
  const names = new Map<string, string>();
  const collect = (items: FixtureItem[]) => {
    for (const node of items) {
      for (const match of (node.content ?? '').matchAll(IMAGE_TOKEN)) names.set(artifactId(match[1]!).toLowerCase(), match[1]!);
      collect(node.children ?? []);
    }
  };
  collect(item.snapshot.outline);
  const snapshot: DocumentSnapshot = {
    projectName: item.snapshot.project_name ?? null,
    exportTemplateScope: item.snapshot.export_template_scope,
    outline: toServerOutline(item.snapshot.outline),
  };
  let document;
  try {
    document = assembleDocumentHtml(snapshot);
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentHtmlError);
    return { error: (error as Error).message };
  }
  expect(document.assetRefs.every((ref) => names.has(ref))).toBe(true);
  const imageWarnings = (item.imageWarnings ?? []).map(({ image, reason }) => ({ assetRef: artifactId(image).toLowerCase(), reason }));
  const summary = summarizeDocumentExport(document, imageWarnings);
  const desktopReason = (text: string) => text.replaceAll(UNSUPPORTED_IMAGE_REASON, DESKTOP_MISSING_IMAGE_REASON);
  return {
    html: document.html
      .replace(/data-app-asset-ref="([^"]+)"/g, (_m, ref: string) => `data-app-asset-ref="IMAGE:${names.get(ref) ?? `?${ref}`}"`)
      .replace(/task-item-\d+/g, 'task-item-N'),
    warnings: summary.warnings.map(desktopReason),
    message: summary.message,
  };
}

describe('整本导出 HTML：与桌面版的共用用例', () => {
  it('用例覆盖成功、带提示与失败三种结果', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.some((item) => 'html' in item.expected && item.expected.warnings.length === 0)).toBe(true);
    expect(cases.some((item) => 'html' in item.expected && item.expected.warnings.length > 0)).toBe(true);
    expect(cases.some((item) => 'error' in item.expected)).toBe(true);
  });

  it.each(cases.map((item) => [item.name, item] as const))('%s', (_name, item) => {
    expect(runServer(item)).toEqual(item.expected);
  });
});

const ID_A = '0123abcd-0000-4000-8000-00000000000a';
const ID_B = '0123abcd-0000-4000-8000-00000000000b';

function manual(title: string, content: string): TechnicalPlanOutlineItem {
  return { id: title, title, description: '', number: '', content_mode: 'manual-fill', content };
}

function assemble(...outline: TechnicalPlanOutlineItem[]) {
  return assembleDocumentHtml({ projectName: '项目', exportTemplateScope: 'document', outline });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('整本导出 HTML：服务端的配图规则', () => {
  it('只认本系统的产物地址；远程地址、data:、本机路径与变形的地址都不读取，原位提示并记下原因', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const sources = [
      'https://example.com/a.png',
      'http://127.0.0.1:9/a.png',
      '//example.com/a.png',
      'data:image/png;base64,iVBORw0KGgo=',
      'file:///etc/passwd',
      '/etc/passwd',
      '../../secret.png',
      `https://example.com/api/artifacts/${ID_A}/content`,
      `/api/artifacts/${ID_A}/content?download=1`,
      `/api/artifacts/${ID_A}/content/../x`,
      `/api/artifacts/${ID_A}`,
      `/api/artifacts/not-a-uuid/content`,
      `/api/files/${ID_A}/content`,
    ];
    // 原始 HTML 的 img（markdown-it 对 Markdown 图片还会先按自己的规则拒绝 file: 等地址，原始 HTML 不经过那一步）。
    const document = assemble(manual('配图', sources.map((src, index) => `<p><img src="${src}" alt="图${index}"></p>`).join('\n\n')));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.assetRefs).toEqual([]);
    expect(document.html).not.toContain('<img');
    expect(document.imageFailures.get('1 配图')).toEqual(sources.map(() => UNSUPPORTED_IMAGE_REASON));
    for (const index of sources.keys()) expect(document.html).toContain(`<p><em>[图片无法导出：图${index}]</em></p>`);
  });

  it('产物地址的 id 统一为小写，同一产物只收集一次，按首次出现的顺序；每一处引用都记下所在小节', () => {
    const document = assemble(
      manual('甲', `![](/api/artifacts/${ID_B.toUpperCase()}/content)\n\n![](/api/artifacts/${ID_A}/content)`),
      manual('乙', `<img src="  /api/artifacts/${ID_B}/content  ">\n\n![](/api/artifacts/${ID_B}/content)`),
    );
    expect(document.assetRefs).toEqual([ID_B, ID_A]);
    expect(document.imageSections).toEqual(new Map([[ID_B, ['1 甲', '2 乙', '2 乙']], [ID_A, ['1 甲']]]));
    expect(document.html.match(/data-app-asset-ref="([^"]+)"/g)).toEqual([ID_B, ID_A, ID_B, ID_B].map((id) => `data-app-asset-ref="${id}"`));
  });

  it('用户原始 HTML 中自带的 data-app-asset-ref 一律不保留（含 template 的内容与没有来源的 img）', () => {
    const document = assemble(manual('原始', [
      '<img data-app-asset-ref="../../other-project.png">',
      `<figure><img data-app-asset-ref="${ID_B}" src="/api/artifacts/${ID_A}/content"></figure>`,
      '<template><p><img data-app-asset-ref="hidden.png" alt="隐藏"></p></template>',
      '<p><picture><img src="x.png" data-app-asset-ref="y.png"></picture></p>',
    ].join('\n\n')));
    const refs = [...document.html.matchAll(/data-app-asset-ref="([^"]+)"/g)].map((match) => match[1]);
    expect(refs).toEqual([ID_A]);
    expect(document.assetRefs).toEqual([ID_A]);
    expect(document.imageFailures.get('1 原始')).toHaveLength(3);
    expect(document.html).toContain('<template><p><em>[图片无法导出：隐藏]</em></p></template>');
  });

  it('不改动传入的快照', () => {
    const outline = [manual('甲', `![图](/api/artifacts/${ID_A}/content)`)];
    const before = structuredClone(outline);
    assemble(...outline);
    expect(outline).toEqual(before);
  });
});

describe('整本导出 HTML：转换器提示与消息', () => {
  const document = assemble(
    manual('甲', `![](/api/artifacts/${ID_A}/content)`),
    manual('乙', `![](/api/artifacts/${ID_A}/content)\n\n![](/api/artifacts/${ID_B}/content)`),
  );

  it('同一产物的第 k 条提示归到它第 k 处引用的小节；不在本次引用中或多出的提示忽略', () => {
    const summary = summarizeDocumentExport(document, [
      { assetRef: ID_A, reason: '原因一' },
      { assetRef: ID_A, reason: '原因二' },
      { assetRef: ID_A, reason: '多出的提示' },
      { assetRef: '0123abcd-0000-4000-8000-0000000000ff', reason: '未引用' },
    ]);
    expect(summary.warnings).toEqual([
      '小节 1 甲 有 1 张图片无法导出，已在原位置用文字标出：原因一',
      '小节 2 乙 有 1 张图片无法导出，已在原位置用文字标出：原因二',
    ]);
    expect(summary.message).toBe('Word 已导出，2 张图片无法导出，已在原位置用文字标出，请打开文档核对。');
  });

  it('没有提示时是桌面版的成功消息；汇总不改动组装结果', () => {
    expect(summarizeDocumentExport(document, [])).toEqual({ warnings: [], message: EXPORT_DONE_MESSAGE });
    summarizeDocumentExport(document, [{ assetRef: ID_A, reason: '原因' }]);
    expect(document.imageFailures.size).toBe(0);
    expect(document.warnings).toEqual([]);
  });
});

describe('整本导出 HTML：错误', () => {
  it('目录为空时抛 EXPORT_EMPTY', () => {
    for (const outline of [[], undefined as unknown as TechnicalPlanOutlineItem[]]) {
      expect(() => assembleDocumentHtml({ exportTemplateScope: 'document', outline })).toThrow(
        expect.objectContaining({ code: 'EXPORT_EMPTY', message: '没有可导出的目录内容' }),
      );
    }
  });

  it('超过六级标题时抛 EXPORT_HEADING_TOO_DEEP（目录本身最多 10 级）', () => {
    let item = manual('L7', '太深');
    for (let level = 6; level >= 1; level -= 1) item = { id: `L${level}`, title: `L${level}`, description: '', number: '', children: [item] };
    expect(() => assemble(item)).toThrow(expect.objectContaining({ code: 'EXPORT_HEADING_TOO_DEEP' }));
  });

  it('collectOutlineExportEntries 按树的顺序重新编号，不采用节点上已有的编号', () => {
    const entries = collectOutlineExportEntries([{ ...manual('甲', ''), number: '9.9', children: [{ ...manual('乙', ''), number: '7' }] }], false);
    expect(entries.map((entry) => [entry.item.number, entry.level])).toEqual([['1', 1], ['1.1', 2]]);
  });
});
