// 技术方案整本导出 HTML 的共用用例（路线图第 7 步 7.4c）：tests/fixtures/technicalPlanExportCases.json 中每条用例的目录快照与
// 桌面版 technicalPlanExport.build（非格式自检）交给 OpenXmlHelper 的整本 HTML、提示与消息。服务端的同名实现
// （server/src/export/documentHtml.ts）在 server/tests/export/documentHtml.test.ts 中跑同一份用例，两端都必须得到记录的结果。
// 改了桌面版的组装规则时，用 UPDATE_TECHNICAL_PLAN_EXPORT_CASES=1 npm run test 重新记录，再同步修改服务端，直到服务端的测试也通过。
//
// 约定（两端相同）：
// - 正文中的 IMAGE:<名称> 是一张图片：这里换成内容为 fixture-image-<名称> 的 PNG data: 地址（桌面版能直接读取），
//   服务端换成 /api/artifacts/<uuid>/content；记录的 HTML 中 data-app-asset-ref 都写回 IMAGE:<名称>；
// - imageWarnings 是转换器对无法导出的图片的返回（按文档顺序，同一图片的第 k 条对应它第 k 处引用）；
// - 任务列表的 id 每次随机，比较前统一为 task-item-N；
// - ./missing-image.png 在桌面版中读取失败（图片文件不存在或为空），服务端不读任何非产物地址，原因由服务端的测试对应。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

interface OutlineItem {
  id: string;
  title: string;
  content_mode?: string;
  content_mode_note?: string;
  content?: string;
  children?: OutlineItem[];
}

interface ExportCase {
  name: string;
  snapshot: { project_name?: string; export_template_scope: 'ai-only' | 'document'; outline: OutlineItem[] };
  imageWarnings?: { image: string; reason: string }[];
  expected: { html: string; warnings: string[]; message: string } | { error: string };
}

const casesFile = path.resolve(__dirname, '../fixtures/technicalPlanExportCases.json');
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8')) as ExportCase[];

/** 加载桌面版 technicalPlanExport.cjs：electron 换成没有 app 的桩，正文 Agent 模块只取任务键（第 8 步的工作区不参与）。 */
function loadDesktop() {
  const Module = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') return { app: undefined, dialog: {}, nativeImage: undefined };
    if (request === './contentGenerationAgent.cjs') return { CONTENT_GENERATION_AGENT_TASK_KEY: 'content-generation' };
    return original.call(this, request, parent, isMain);
  };
  try {
    return require('../../electron/services/technicalPlanExport.cjs') as {
      createTechnicalPlanExport: (deps: Record<string, unknown>) => {
        build: (snapshot: Record<string, unknown>, options: Record<string, unknown>) => Promise<{ warnings: string[]; message?: string }>;
      };
    };
  } finally {
    Module._load = original;
  }
}

const { createTechnicalPlanExport } = loadDesktop();
const IMAGE_TOKEN = /IMAGE:([a-z0-9]+)/g;

function withImages(items: OutlineItem[]): OutlineItem[] {
  return items.map((item) => ({
    ...item,
    ...(item.content === undefined ? {} : {
      content: item.content.replace(IMAGE_TOKEN, (_m, name: string) => `data:image/png;base64,${Buffer.from(`fixture-image-${name}`).toString('base64')}`),
    }),
    ...(item.children ? { children: withImages(item.children) } : {}),
  }));
}

/** 运行桌面版并按约定记录结果（DONE_MESSAGE 同 exportService 在没有提示时的消息）。 */
async function runDesktop(item: ExportCase): Promise<ExportCase['expected']> {
  let html = '';
  const helper = {
    async createRestrictedHtmlDocx(source: string, _format: unknown, options: { assets: Map<string, Buffer> }) {
      const names = new Map<string, string>();
      for (const [ref, buffer] of options.assets) names.set(ref, buffer.toString('utf8').replace(/^fixture-image-/, ''));
      html = source
        .replace(/data-app-asset-ref="([^"]+)"/g, (_m, ref: string) => `data-app-asset-ref="IMAGE:${names.get(ref) ?? `?${ref}`}"`)
        .replace(/task-item-\d+/g, 'task-item-N');
      // 同一图片的第 k 条提示对应它第 k 处引用（按文档顺序）。
      const order = [...options.assets.keys()];
      const used = new Map<string, number>();
      const imageWarnings = (item.imageWarnings ?? []).map(({ image, reason }) => {
        const refs = order.filter((ref) => names.get(ref) === image);
        const index = used.get(image) ?? 0;
        used.set(image, index + 1);
        return { assetRef: refs[index], reason };
      });
      return { bytes: new Uint8Array(), imageWarnings };
    },
  };
  const service = createTechnicalPlanExport({ technicalPlanStore: {}, templateStore: {}, agentService: {}, openXmlHelperService: helper });
  try {
    const result = await service.build({
      project_name: item.snapshot.project_name,
      outline: withImages(item.snapshot.outline),
      export_format: {},
      export_template_scope: item.snapshot.export_template_scope,
      workspaceDir: undefined,
    }, { stats: {} });
    return { html, warnings: result.warnings, message: result.message || 'Word 已导出，请打开文档核对图片、表格和版式。' };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

if (process.env.UPDATE_TECHNICAL_PLAN_EXPORT_CASES === '1') {
  const updated = [];
  for (const item of cases) updated.push({ ...item, expected: await runDesktop(item) });
  fs.writeFileSync(casesFile, `${JSON.stringify(updated, null, 2)}\n`);
}

describe('技术方案整本导出 HTML 共用用例（桌面版）', () => {
  it('用例覆盖成功、带提示与失败三种结果', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(new Set(cases.map((item) => item.name)).size).toBe(cases.length);
    expect(cases.some((item) => 'html' in item.expected && item.expected.warnings.length === 0)).toBe(true);
    expect(cases.some((item) => 'html' in item.expected && item.expected.warnings.length > 0)).toBe(true);
    expect(cases.some((item) => 'error' in item.expected)).toBe(true);
  });

  it.each(cases.map((item) => [item.name, item] as const))('%s', async (_name, item) => {
    expect(await runDesktop(item)).toEqual(item.expected);
  });
});
