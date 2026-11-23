// render-mermaid 沙箱（路线图第 8 步 8.8b）：按 render-mermaid 模板创建真实的沙箱（CI 中为 gVisor），经 worker 一侧的 renderMermaidImages
// （src/render/mermaidImages.ts）与模板写死的生产命令转图，结果按不可信输入校验。Mermaid 代码一律按不可信输入处理，每类注入样本都有
// 对照组证明样本有效（去掉对应的防护后样本确实生效），再证明生产配置下不生效：
// - 镜像：专用镜像中只有按版本固定的 mermaid.min.js、页面脚本与入口，没有 export 镜像的导出代码；
// - 正常转图：常见图表都输出 PNG，按桌面版的规则排版（过宽缩到 680 × 3 倍像素宽），过高的图缩进 3306 像素高；语法错误只让该段失败并带
//   Mermaid 的说明；只交出 PNG 与 result.json，Mermaid 生成的 SVG（以其中的文字为标记）不出沙箱；
// - 样本（对照组在沙箱内用同一镜像、测试自己改写出的放宽页面，生产入口没有任何放宽选项）：
//   A. init 指令 / initialize 指令 / frontmatter 的 config 把安全级别改为 loose：生产页面中不生效（click 不执行，主题指令照常生效，
//      证明指令确实被处理）；对照组（页面直接设为 loose）中 click 执行；
//   B. click 指向 javascript:、call eval、call setTimeout：生产中点击所有元素都不执行、SVG 中没有 javascript: 地址；对照组（loose）中都执行；
//   C. 标签中嵌入 HTML / 脚本（img onerror、svg 中 animate 的 onbegin、details ontoggle、javascript: 链接）与打开 HTML 标签的指令：生产中没有 HTML 元素、
//      事件属性与 foreignObject，都不执行；对照组：同样的 HTML 直接放进页面时都执行（样本有效），只保留 Mermaid 默认锁定的设置时
//      HTML 标签指令生效（追加锁定的 htmlLabels 有效）；
//   D. 外部图片与样式引用（themeCSS 的 @import / url()、fontFamily 中的 url()、HTML 标签中的 img、img 形状）：生产入口在断网沙箱与
//      去掉断网的沙箱中都不发出任何请求；对照组（去掉断网、去掉追加的锁定与 CSP、上下文不离线并放行外部请求，另关闭 Chromium 的本地网络
//      访问检查）中测试服务器收到每一个样本的请求；只去掉 CSP 时 img 形状的请求会发出（CSP 是这一项的防线）；
//   E. 超大与深度嵌套的图（64 KiB 的类图、3000 层嵌套的子图）：生产中止于每段 30 秒的时限，后面的段照常转图，宿主不受影响；对照组：不限时长时
//      35 秒后仍未完成。内存：对照组不限内存时峰值约 0.9 GiB（runc）～1.2 GiB（gVisor），1 GiB 的模板中先到时限，运行期间宿主可用内存的下降
//      不超过模板上限加开销；内存上限的强制执行由隔离套件证明。超过 64 KiB 的源码在 worker 与入口都被拒绝。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMermaidImages, type MermaidImageResult, type RenderMermaidContext } from '../../../src/render/mermaidImages.ts';
import type { SandboxRef } from '../../../src/sandbox/driver.ts';
import { SANDBOX_TEMPLATES } from '../../../src/sandbox/templates.ts';
import { sandboxEnv } from './env.ts';
import { decodePng } from './exportFixtures.ts';
import { bridgeGateway, createIsolationHarness } from './isolationSuite.ts';

const harness = createIsolationHarness('render-mermaid', sandboxEnv.mermaidImage ?? '');
const JOB_ID = '6b1f3c2e-8a4d-4f0b-9c7e-5d2a1b3c4e6f';
const MIB = 1024 * 1024;
const pageScript = readFileSync(new URL('../../../sandbox/render-mermaid/page.js', import.meta.url));
const clientLock = JSON.parse(readFileSync(new URL('../../../../client/package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version: string }> };

function contextOf(driver = harness.driver): RenderMermaidContext {
  return { jobId: JOB_ID, signal: new AbortController().signal, log: async () => {}, sandbox: driver };
}

const render = (codes: string[], driver = harness.driver) => renderMermaidImages(contextOf(driver), codes, { createRetryDelaysMs: [] });
const sizeOf = (result: MermaidImageResult) => (result.status === 'rendered' ? [result.width, result.height] : result.error);

const FLOW = 'flowchart TD\n  A[需求调研] --> B{评审}\n  B -->|通过| C[方案设计]\n  B -->|不通过| A';
const COMMON: Record<string, string> = {
  flowchart: FLOW,
  sequence: 'sequenceDiagram\n  participant 用户\n  participant 系统\n  用户->>系统: 提交\n  Note right of 系统: 校验\n  系统-->>用户: 结果',
  gantt: 'gantt\n  title 进度\n  dateFormat YYYY-MM-DD\n  section 一\n  调研 :a1, 2024-01-01, 10d\n  设计 :after a1, 5d',
  class: 'classDiagram\n  Animal <|-- Duck\n  Animal : +int age',
  state: 'stateDiagram-v2\n  [*] --> Still\n  Still --> Moving\n  Moving --> [*]',
  pie: 'pie title 占比\n  "A" : 40\n  "B" : 60',
  mindmap: 'mindmap\n  root((项目))\n    计划\n    实施',
  er: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
};
/** 很宽的图：按桌面版的规则缩到 664 像素宽（截图 680 × 3 = 2040 像素宽）。 */
const WIDE = `flowchart LR\n  ${Array.from({ length: 30 }, (_, index) => `n${index}[第${index}步]`).join(' --> ')}`;
/** 很高的图：按 1086 像素高等比缩小，PNG 不超过 3306 像素高。 */
const TALL = `sequenceDiagram\n${Array.from({ length: 200 }, (_, index) => `  A->>B: 第${index}条消息`).join('\n')}`;

/** A：图表内的指令把安全级别改为 loose，再用 click 执行脚本（生效时在 body 上留下 data-<名称> 标记）。 */
const DIRECTIVE_SAMPLES: Record<string, string> = {
  'init-loose': '%%{init: {"securityLevel": "loose"}}%%\nflowchart TD\n  A --> B\n  click A call eval("document.body.dataset.initLoose=1")',
  'initialize-loose': '%%{initialize: {"securityLevel": "loose"}}%%\nflowchart TD\n  A --> B\n  click A href "javascript:void(document.body.dataset.initializeLoose=1)"',
  'frontmatter-loose': '---\nconfig:\n  securityLevel: loose\n---\nflowchart TD\n  A --> B\n  click A call eval("document.body.dataset.frontmatterLoose=1")',
  'unlock-secure': '%%{init: {"secure": [], "securityLevel": "loose"}}%%\nflowchart TD\n  A --> B\n  click A call eval("document.body.dataset.unlockSecure=1")',
};
/** B：click 指向 javascript: 与函数调用。 */
const CLICK_SAMPLES: Record<string, string> = {
  'click-javascript': 'flowchart TD\n  A --> B\n  click A "javascript:void(document.body.dataset.clickJavascript=1)"',
  'click-href-javascript': 'flowchart TD\n  A --> B\n  click B href "javascript:void(document.body.dataset.clickHrefJavascript=1)" _self',
  'click-call-eval': 'flowchart TD\n  A --> B\n  click A call eval("document.body.dataset.clickCallEval=1")',
  'click-call-settimeout': 'flowchart TD\n  A --> B\n  click B call setTimeout("document.body.dataset.clickCallSettimeout=1")',
};
/** C：标签中嵌入的 HTML / 脚本（作为 HTML 直接放进页面时每一种都会执行）。 */
const LABEL_HTML: Record<string, string> = {
  'label-img-onerror': '<img src=x onerror=document.body.dataset.labelImgOnerror=1>',
  'label-svg-animate': '<svg><animate onbegin=document.body.dataset.labelSvgAnimate=1 attributeName=x dur=1s /></svg>',
  'label-details-ontoggle': '<details open ontoggle=document.body.dataset.labelDetailsOntoggle=1>x</details>',
  'label-javascript-link': '<a href="javascript:void(document.body.dataset.labelJavascriptLink=1)">点我</a>',
};
const labelSample = (html: string) => `flowchart TD\n  A["${html}"] --> B["<b>粗体</b>"]`;
const LABEL_SAMPLES = Object.fromEntries(Object.entries(LABEL_HTML).map(([name, html]) => [name, labelSample(html)]));
/** C / D：打开 HTML 标签的指令（Mermaid 默认不锁定 htmlLabels，本页面另外锁定）。 */
const htmlLabelsDirective = (base: string) => `%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%\nflowchart TD\n  A["<b>粗</b><img src='${base}/html-labels.png'>"] --> B`;
/** D：外部图片与样式引用。 */
const externalSamples = (base: string): Record<string, string> => ({
  'theme-css': `%%{init: {"themeCSS": "@import url(${base}/theme-css-import.css); .node rect { fill: url(${base}/theme-css-fill.svg#p) }"}}%%\nflowchart TD\n  A --> B`,
  'font-family': `%%{init: {"fontFamily": "x;background:url(${base}/font-family.png)"}}%%\nflowchart TD\n  A --> B`,
  'html-labels': htmlLabelsDirective(base),
  'img-shape': `flowchart TD\n  A@{ img: "${base}/img-shape.png", label: "图", pos: "t", w: 60, h: 60, constraint: "off" } --> B`,
});
const EXTERNAL_PATHS: Record<string, string> = {
  'theme-css': '/theme-css-',
  'font-family': '/font-family.png',
  'html-labels': '/html-labels.png',
  'img-shape': '/img-shape.png',
};

/** E：64 KiB 的类图（约 7,000 个类）与 3000 层嵌套的子图（本地实测分别约 49 秒、35 秒，前者不限内存时峰值约 0.9 GiB）。 */
function fill(head: string, line: (index: number) => string): string {
  let text = head;
  for (let index = 0; ; index += 1) {
    const next = line(index);
    if (Buffer.byteLength(text + next) > 64 * 1024) return text;
    text += next;
  }
}
const HUGE_CLASS = fill('classDiagram\n', (index) => `class C${index}\n`);
const DEEP_SUBGRAPHS = `flowchart TD\n${Array.from({ length: 3000 }, (_, index) => `subgraph s${index}\n`).join('')}x\n${'end\n'.repeat(3000)}`;

describe.runIf(sandboxEnv.mermaidImage)('render-mermaid sandbox', () => {
  it('carries the pinned mermaid bundle and the page script, and none of the export image', async () => {
    const ref = await harness.createSandbox();
    const facts = await harness.probe<{ page: string; version: boolean; exportCode: boolean; files: string[] }>(
      ref,
      `const fs = require('fs');
       const bundle = fs.readFileSync('/opt/render-mermaid/assets/mermaid.min.js', 'utf8');
       console.log(JSON.stringify({
         page: require('crypto').createHash('sha256').update(fs.readFileSync('/opt/render-mermaid/page.js')).digest('hex'),
         version: bundle.includes(${JSON.stringify(`"${clientLock.packages['node_modules/mermaid']!.version}"`)}),
         exportCode: ['/opt/export', '/opt/openxmlhelper', '/opt/agent', '/opt/parse'].some((path) => fs.existsSync(path)),
         files: fs.readdirSync('/opt/render-mermaid').sort(),
       }))`,
    );
    expect(facts.page).toBe(createHash('sha256').update(pageScript).digest('hex'));
    expect(facts.version).toBe(true);
    expect(facts.exportCode).toBe(false);
    expect(facts.files).toEqual(['assets', 'entry.mjs', 'mermaidImage.mjs', 'node_modules', 'package.json', 'page.js']);
  });

  it('renders common diagrams to PNG with the desktop layout rules and the pixel limit', async () => {
    const names = Object.keys(COMMON);
    const started = Date.now();
    const results = await render([...names.map((name) => COMMON[name]!), WIDE, TALL]);
    console.info(JSON.stringify({ renderMermaidBatch: { diagrams: results.length, ms: Date.now() - started } }));
    for (const [index, result] of results.entries()) {
      const name = names[index] ?? (index === names.length ? 'wide' : 'tall');
      expect(result.status, name).toBe('rendered');
      if (result.status !== 'rendered') continue;
      expect(result.width % 3, name).toBe(0);
      expect(result.height % 3, name).toBe(0);
      expect(result.width, name).toBeLessThanOrEqual(2040);
      expect(result.height, name).toBeLessThanOrEqual(3306);
      const png = decodePng(result.png);
      expect([png.width, png.height]).toEqual([result.width, result.height]);
      // 白色背景、四周 8 像素外边距，中间有图。
      expect(png.pixel(3, 3), name).toEqual([255, 255, 255]);
    }
    const wide = results[names.length]!;
    const tall = results[names.length + 1]!;
    expect(wide.status === 'rendered' && wide.width).toBe(2040);
    expect(tall.status === 'rendered' && tall.height).toBeGreaterThan(3000);
    expect(tall.status === 'rendered' && tall.height).toBeLessThanOrEqual(3306);
  });

  it("fails a syntax error on its own item with Mermaid's message, and hands out only the PNG, never the SVG", async () => {
    const marker = 'ZHIBIAOSVGMARKER';
    const ref = await harness.createSandbox();
    const request = { version: 1, items: [{ id: 'm001', code: `flowchart TD\n  A[${marker}] --> B` }, { id: 'm002', code: 'flowchart TD\n  A[' }] };
    await harness.driver.copyIn(ref, [{ path: 'request.json', data: Buffer.from(JSON.stringify(request)) }]);
    const exec = await harness.driver.exec(ref, 'render', []);
    expect(exec.exitCode).toBe(0);
    const files = await harness.driver.copyOut(ref);
    expect(files.map((file) => file.path).sort()).toEqual(['m001.png', 'result.json']);
    for (const file of files) {
      expect(file.data.includes(marker), file.path).toBe(false);
      expect(file.data.includes('<svg'), file.path).toBe(false);
    }
    const result = JSON.parse(files.find((file) => file.path === 'result.json')!.data.toString('utf8'));
    expect(result.items[0]).toMatchObject({ id: 'm001', status: 'rendered' });
    expect(result.items[1]).toMatchObject({ id: 'm002', status: 'failed', error: 'diagram_invalid' });
    expect(result.items[1].message).toMatch(/^Parse error on line \d+:/);
  });

  describe('A. directives that change the security level', () => {
    it('do not take effect in production, although directives are processed', async () => {
      const ref = await harness.createSandbox();
      const production = await probeIn(ref, { samples: { ...DIRECTIVE_SAMPLES, 'theme-default': FLOW, 'theme-dark': `%%{init: {"theme": "dark"}}%%\n${FLOW}` } });
      for (const name of Object.keys(DIRECTIVE_SAMPLES)) {
        expect(production[name]!.ok, name).toBe(true);
        expect(production[name]!.markers, name).toEqual([]);
        expect(production[name]!.dom.javascriptUrls, name).toBe(0);
      }
      // 指令确实被处理：主题指令照常改变节点的填充色。
      expect(production['theme-dark']!.fill).not.toBe(production['theme-default']!.fill);

      // 对照组：页面本身设为 loose（指令若能生效即是如此）时，同样的样本都执行。
      const loose = await probeIn(ref, { samples: DIRECTIVE_SAMPLES, page: { config: 'loose', csp: false } });
      for (const name of Object.keys(DIRECTIVE_SAMPLES)) expect(loose[name]!.markers, name).toEqual([camel(name)]);
    });
  });

  describe('B. click callbacks and javascript: links', () => {
    it('never run in production, while the loose control runs every one', async () => {
      const ref = await harness.createSandbox();
      const production = await probeIn(ref, { samples: CLICK_SAMPLES });
      for (const name of Object.keys(CLICK_SAMPLES)) {
        expect(production[name]!.ok, name).toBe(true);
        expect(production[name]!.markers, name).toEqual([]);
        expect(production[name]!.dom.javascriptUrls, name).toBe(0);
      }
      const loose = await probeIn(ref, { samples: CLICK_SAMPLES, page: { config: 'loose', csp: false } });
      for (const name of Object.keys(CLICK_SAMPLES)) expect(loose[name]!.markers, name).toEqual([camel(name)]);
    });
  });

  describe('C. HTML and scripts in labels', () => {
    it('render as plain text in production, while the same HTML runs when put into a page', async () => {
      const ref = await harness.createSandbox();
      const production = await probeIn(ref, { samples: { ...LABEL_SAMPLES, 'html-labels': htmlLabelsDirective('http://html-labels.invalid') } });
      for (const name of [...Object.keys(LABEL_SAMPLES), 'html-labels']) {
        const result = production[name]!;
        expect(result.ok, name).toBe(true);
        expect(result.markers, name).toEqual([]);
        expect(result.dom, name).toMatchObject({ foreignObject: 0, htmlElements: 0, eventAttributes: 0, javascriptUrls: 0, scripts: 0 });
        expect(result.blocked, name).toEqual([]);
      }
      // 对照组一：同样的 HTML 直接放进页面（不经 Mermaid、没有 CSP）时每一种都执行（样本有效）。
      const raw = await probeIn(ref, { samples: LABEL_HTML, page: { config: 'production', csp: false }, rawHtml: true });
      for (const name of Object.keys(LABEL_HTML)) expect(raw[name]!.markers, name).toEqual([camel(name)]);
      // 对照组二：只保留 Mermaid 默认锁定的设置时，打开 HTML 标签的指令生效（标签变成 foreignObject 中的 HTML，并请求其中的图片）。
      const defaults = await probeIn(ref, { samples: { 'html-labels': htmlLabelsDirective('http://html-labels.invalid') }, page: { secure: 'mermaid-default', csp: false } });
      expect(defaults['html-labels']!.dom.foreignObject).toBeGreaterThan(0);
      expect(defaults['html-labels']!.dom.htmlElements).toBeGreaterThan(0);
      expect(defaults['html-labels']!.blocked).toContain('http://html-labels.invalid/html-labels.png');
    });
  });

  describe('D. external images and style references', () => {
    let server: Server;
    let base = '';
    const requests: string[] = [];

    beforeAll(async () => {
      server = createServer((request, response) => {
        requests.push(request.url ?? '');
        response.end('x');
      });
      await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
      base = `http://${await bridgeGateway()}:${(server.address() as { port: number }).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const weakenedNetwork = () =>
      harness.weakenedDriver((spec) => {
        spec.HostConfig.NetworkMode = 'bridge';
      });

    it('request nothing from the production entry, with or without the network', async () => {
      requests.length = 0;
      const samples = externalSamples(base);
      for (const driver of [harness.driver, weakenedNetwork()]) {
        const results = await render(Object.values(samples), driver);
        // img 形状的图片加载不到，Mermaid 报告无法解码；其余照常转图。
        expect(results.map((result) => result.status === 'rendered' || result.error)).toEqual([true, true, true, 'diagram_invalid']);
      }
      expect(requests).toEqual([]);
    });

    it('are blocked in the production page by the locked settings and the CSP (no request even reaches the route)', async () => {
      const ref = await harness.createSandbox();
      const production = await probeIn(ref, { samples: externalSamples(base) });
      for (const name of Object.keys(EXTERNAL_PATHS)) expect(production[name]!.blocked, name).toEqual([]);
      expect(production['img-shape']!.cspViolations).toContain('img-src');
      // 只去掉 CSP：img 形状的请求会发出（被路由中止），其余仍被锁定的设置挡住。
      const noCsp = await probeIn(ref, { samples: externalSamples(base), page: { csp: false } });
      expect(noCsp['img-shape']!.blocked).toEqual([`${base}/img-shape.png`]);
      for (const name of ['theme-css', 'font-family', 'html-labels']) expect(noCsp[name]!.blocked, name).toEqual([]);
      expect(requests).toEqual([]);
    });

    it('reach the test server for every sample when the network, the extra locks, the CSP and the offline context are all removed (sample-validity control)', async () => {
      requests.length = 0;
      const weakened = weakenedNetwork();
      const ref: SandboxRef = await weakened.create('render-mermaid', { jobId: JOB_ID });
      harness.track(ref, weakened);
      await probeIn(ref, { samples: externalSamples(base), page: { secure: 'mermaid-default', csp: false }, network: 'open' }, weakened);
      for (const [name, path] of Object.entries(EXTERNAL_PATHS)) expect(requests.some((url) => url.startsWith(path)), `${name}: ${JSON.stringify(requests)}`).toBe(true);
    });
  });

  describe('E. huge and deeply nested diagrams', () => {
    it('reject code over 64 KiB in the worker and in the entry', async () => {
      await expect(render(['x'.repeat(64 * 1024 + 1)])).rejects.toMatchObject({ code: 'RENDER_MERMAID_REQUEST_INVALID' });
      const ref = await harness.createSandbox();
      await harness.driver.copyIn(ref, [{ path: 'request.json', data: Buffer.from(JSON.stringify({ version: 1, items: [{ id: 'm001', code: 'x'.repeat(64 * 1024 + 1) }] })) }]);
      const result = await harness.driver.exec(ref, 'render', []);
      expect(result.exitCode).toBe(65);
      expect(result.stdout.trim().split('\n').at(-1)).toBe('{"error":"request_invalid"}');
      expect(await harness.driver.copyOut(ref)).toEqual([]);
    });

    it('stop at the per-item time limit or the memory limit, and the next item still renders', { timeout: 300_000 }, async () => {
      const started = Date.now();
      const before = hostMemAvailable();
      let lowest = before;
      const sampler = setInterval(() => {
        lowest = Math.min(lowest, hostMemAvailable());
      }, 200);
      const results = await render([HUGE_CLASS, DEEP_SUBGRAPHS, FLOW]).finally(() => clearInterval(sampler));
      const elapsed = Date.now() - started;
      // 宿主可用内存的下降不超过沙箱的内存上限加运行时开销（与隔离套件相同的口径）。
      expect(before - lowest).toBeLessThan(SANDBOX_TEMPLATES['render-mermaid'].memoryBytes + 768 * MIB);
      console.info(JSON.stringify({ renderMermaidExhaustion: { results: results.map(sizeOf), ms: elapsed } }));
      for (const result of results.slice(0, 2)) expect(['render_timeout', 'render_failed']).toContain(result.status === 'failed' && result.error);
      expect(results[2]!.status).toBe('rendered');
      // 两段各至多 30 秒，加上浏览器启动、放入与取回。
      expect(elapsed).toBeLessThan(2 * 30_000 + 60_000);
      await harness.expectHostHealthy();
    });

    it('control: without the time limit both samples are still running after 35 seconds', { timeout: 300_000 }, async () => {
      const ref = await harness.createSandbox();
      // 每个样本单独一次（node -e 的单个参数至多 128 KiB）。
      for (const [name, code] of Object.entries({ 'huge-class': HUGE_CLASS, 'deep-subgraphs': DEEP_SUBGRAPHS })) {
        const control = await probeIn(ref, { samples: { [name]: code }, timeoutMs: 35_000 });
        expect(control[name]!.timedOut, name).toBe(true);
      }
    });

    // 内存：不限内存时同一样本的峰值 runc 下约 0.9 GiB、gVisor 下约 1.2 GiB（按 cgroup 计数，CI 实测，超过模板的 1 GiB），但在 1 GiB 的模板中
    // 先到的是 30 秒时限（上一个用例同时断言宿主可用内存的下降不超过模板上限加运行时开销）。把内存上限降到 512 MiB 试过：渲染进程在内存紧张时
    // 靠频繁回收撑着、越来越慢，仍是时限先到，“止于内存上限”不能稳定复现，所以不作为用例。内存上限本身的强制执行由 renderMermaidIsolation.test.ts
    // 的隔离套件证明（超限的进程被结束、宿主内存不受影响，并有去掉上限的对照组）。
    it('control: without the memory limit the huge class diagram uses most of the template memory or more', { timeout: 300_000 }, async () => {
      const weakened = harness.weakenedDriver((spec) => {
        spec.HostConfig.Memory = 0;
        spec.HostConfig.MemorySwap = 0;
      });
      const ref: SandboxRef = await weakened.create('render-mermaid', { jobId: JOB_ID });
      harness.track(ref, weakened);
      const control = await probeIn(ref, { samples: { 'huge-class': HUGE_CLASS }, timeoutMs: 150_000, measureMemory: true }, weakened);
      console.info(JSON.stringify({ renderMermaidMemoryControl: { peakMiB: Math.round(control['huge-class']!.peakBytes / MIB), timedOut: control['huge-class']!.timedOut } }));
      expect(control['huge-class']!.peakBytes).toBeGreaterThan(768 * MIB);
    });
  });
});

/** 宿主的可用内存（字节）：测试进程在宿主上，/proc/meminfo 是宿主的。 */
function hostMemAvailable(): number {
  return Number(/^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))![1]) * 1024;
}

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

interface ProbeResult {
  ok: boolean;
  timedOut: boolean;
  /** 渲染进程崩溃（例如被内存上限结束）。 */
  crashed: boolean;
  message?: string;
  markers: string[];
  blocked: string[];
  cspViolations: string[];
  fill: string;
  peakBytes: number;
  dom: { foreignObject: number; htmlElements: number; eventAttributes: number; javascriptUrls: number; scripts: number };
}

interface ProbeOptions {
  samples: Record<string, string>;
  /**
   * 不给出时用生产页面（mermaidImage.mjs 的 routeMermaidPage 与 openMermaidPage，原样）。给出时为测试自己改写出的放宽页面：
   * secure 'mermaid-default' 只保留 Mermaid 默认锁定的设置；config 'loose' 把页面设为 loose 并打开 HTML 标签（并像 mermaid.run 一样
   * 绑定 click 回调）；csp false 去掉 CSP（响应头与 meta）。
   */
  page?: { secure?: 'production' | 'mermaid-default'; config?: 'production' | 'loose'; csp?: boolean };
  /** open：上下文不离线，外部请求放行（只在去掉断网的沙箱中有意义）。 */
  network?: 'blocked' | 'open';
  /** 把样本当作 HTML 直接放进页面（不经 Mermaid），证明 HTML 样本本身有效。 */
  rawHtml?: boolean;
  /** 每个样本的时限（默认 20 秒）；到时记 timedOut。 */
  timeoutMs?: number;
  /** 渲染期间每 200 毫秒读一次沙箱内所有进程的 RSS 之和（/proc），记下峰值。 */
  measureMemory?: boolean;
}

async function probeIn(ref: SandboxRef, options: ProbeOptions, driver = harness.driver): Promise<Record<string, ProbeResult>> {
  const result = await driver.execArgv(ref, ['node', '-e', probeScript(options)], { timeoutMs: 280_000 });
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, ProbeResult>;
}

/**
 * 在沙箱内用镜像中的 Chromium 与 mermaidImage.mjs 打开页面、渲染样本，再点击渲染结果中的每个元素，读出生效的脚本留下的标记、
 * 被路由中止的请求、CSP 拦截、SVG 中的 HTML 元素 / 事件属性 / javascript: 地址。生产入口与页面没有任何放宽的选项：
 * 放宽的页面由这里按 page.js 中的 SECURE_KEYS 与 CONFIG 两行改写（改写不成功即失败）。
 */
function probeScript(options: ProbeOptions): string {
  return `
    (async () => {
      const fs = require('fs');
      const { createRequire } = require('module');
      const { chromium } = createRequire('/opt/render-mermaid/package.json')('playwright-core');
      const m = await import('/opt/render-mermaid/mermaidImage.mjs');
      const options = ${JSON.stringify(options)};
      const assets = await m.loadPageAssets();
      const replaceOnce = (text, from, to) => { if (!text.includes(from)) throw new Error('page.js changed: ' + from); return text.replace(from, to); };
      let pageScript = assets.pageScript.toString('utf8');
      if (options.page?.secure === 'mermaid-default') {
        pageScript = pageScript.replace(/const SECURE_KEYS = \\[.*\\];/, "const SECURE_KEYS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges'];");
        if (!pageScript.includes("'maxEdges'];")) throw new Error('page.js changed: SECURE_KEYS');
      }
      if (options.page?.config === 'loose') {
        pageScript = replaceOnce(pageScript, "securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }", "securityLevel: 'loose', htmlLabels: true, flowchart: { htmlLabels: true }");
        pageScript = replaceOnce(pageScript, "({ svg } = await mermaid.render('zhibiao-mermaid', code));", "({ svg, bindFunctions: window.__bind } = await mermaid.render('zhibiao-mermaid', code));");
        pageScript = replaceOnce(pageScript, 'root.innerHTML = svg;', 'root.innerHTML = svg; window.__bind?.(root);');
      }
      const csp = options.page?.csp !== false;
      const html = csp ? m.PAGE_HTML : m.PAGE_HTML.replace(/\\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
      if (!csp && html.includes('Content-Security-Policy')) throw new Error('csp not removed');
      // network 'open' 的对照组另外关闭 Chromium 的本地网络访问检查（公网来源的页面不能请求私有地址，测试服务器在网桥的私有地址上），
      // 这是生产之外的又一层，对照组要证明的是样本本身会发出请求。
      const extraArgs = options.network === 'open' ? ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] : [];
      const browser = await chromium.launch({ executablePath: m.CHROMIUM_EXECUTABLE, headless: true, args: [...m.LAUNCH_ARGS, ...extraArgs], env: { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' } });
      // 沙箱的内存用量：按 cgroup 的计数（与内存上限用同一个口径，含 tmpfs）；读不到时用沙箱内所有进程的 RSS 之和。
      const memoryUsage = () => {
        for (const path of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
          try { const value = Number(fs.readFileSync(path, 'utf8').trim()); if (value > 0) return value; } catch {}
        }
        let total = 0;
        for (const pid of fs.readdirSync('/proc').filter((name) => /^\\d+$/.test(name))) {
          try { total += Number(/VmRSS:\\s+(\\d+) kB/.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8'))?.[1] ?? 0) * 1024; } catch {}
        }
        return total;
      };
      const out = {};
      for (const [name, code] of Object.entries(options.samples)) {
        const blocked = [];
        const open = options.network === 'open';
        const context = open
          ? await browser.newContext({ javaScriptEnabled: true, viewport: { width: m.RENDER_WIDTH, height: 1200 }, deviceScaleFactor: m.CAPTURE_SCALE })
          : await m.newMermaidContext(browser);
        if (!options.page && !open) {
          await m.routeMermaidPage(context, assets, (url) => blocked.push(url));
        } else {
          await context.route('**/*', (route) => {
            const url = route.request().url();
            if (url === m.PAGE_URL) return route.fulfill({ status: 200, headers: csp ? { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': m.PAGE_CSP } : { 'content-type': 'text/html; charset=utf-8' }, body: html });
            if (url === m.MERMAID_SCRIPT_URL) return route.fulfill({ status: 200, contentType: 'text/javascript', body: assets.mermaidScript });
            if (url === m.PAGE_SCRIPT_URL) return route.fulfill({ status: 200, contentType: 'text/javascript', body: pageScript });
            blocked.push(url);
            return open ? route.continue() : route.abort('blockedbyclient');
          });
        }
        const page = await m.openMermaidPage(context, Date.now() + 20000);
        await page.evaluate(() => {
          window.__violations = [];
          document.addEventListener('securitypolicyviolation', (event) => window.__violations.push(event.effectiveDirective));
        });
        let peakBytes = 0;
        const timer = options.measureMemory ? setInterval(() => { peakBytes = Math.max(peakBytes, memoryUsage()); }, 200) : null;
        const run = options.rawHtml
          ? page.evaluate((text) => { document.getElementById('app-capture-root').innerHTML = text; return { ok: true }; }, code)
          : page.evaluate((text) => window.__zhibiaoMermaid.render(text), code);
        const timeoutMs = options.timeoutMs ?? 20000;
        const rendered = await Promise.race([run.catch((error) => ({ ok: false, message: String(error && error.message) })), new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))]);
        if (timer) clearInterval(timer);
        if (rendered === 'timeout') {
          out[name] = { ok: false, timedOut: true, crashed: false, markers: [], blocked, cspViolations: [], fill: '', peakBytes, dom: {} };
          await context.close();
          continue;
        }
        // 渲染进程已崩溃（例如被内存上限结束）：记下崩溃，不再读页面。
        if (rendered.ok !== true && (page.isClosed() || /crash|closed|Target/i.test(String(rendered.message)))) {
          out[name] = { ok: false, timedOut: false, crashed: true, message: String(rendered.message).slice(0, 200), markers: [], blocked, cspViolations: [], fill: '', peakBytes, dom: {} };
          await context.close().catch(() => {});
          continue;
        }
        // 先读渲染结果，再点击：生产中被清理成 about:blank 的链接（target 为 _self 时）会让页面离开，之后读不到这一页。
        const facts = await page.evaluate(() => {
          const root = document.getElementById('app-capture-root');
          const all = [...root.querySelectorAll('*')];
          const attributes = all.flatMap((element) => [...element.attributes]);
          const rect = root.querySelector('.node rect, .node polygon, .node path');
          return {
            violationsBefore: [...window.__violations],
            fill: rect ? getComputedStyle(rect).fill : '',
            dom: {
              foreignObject: root.querySelectorAll('foreignObject').length,
              htmlElements: all.filter((element) => element.namespaceURI === 'http://www.w3.org/1999/xhtml' && ['img', 'b', 'details', 'a', 'svg', 'iframe', 'script'].includes(element.localName)).length,
              eventAttributes: attributes.filter((attribute) => /^on/i.test(attribute.name)).length,
              javascriptUrls: attributes.filter((attribute) => /^\\s*javascript:/i.test(attribute.value)).length,
              scripts: root.querySelectorAll('script').length,
            },
          };
        });
        await page.evaluate(() => {
          for (const element of document.querySelectorAll('#app-capture-root *')) element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          for (const link of document.querySelectorAll('#app-capture-root a')) link.click?.();
        }).catch(() => {});
        await page.waitForTimeout(800);
        // 标记只能由执行了的脚本写在这一页的 body 上；页面已经离开（导航到了别的地址）时没有标记。
        const after = await page.evaluate(() => ({ markers: Object.keys(document.body?.dataset ?? {}).sort(), cspViolations: [...new Set(window.__violations ?? [])].sort() })).catch(() => ({ markers: [], cspViolations: [] }));
        const { violationsBefore, ...rest } = facts;
        out[name] = { ok: rendered.ok === true, timedOut: false, crashed: false, message: rendered.message, blocked, peakBytes, ...rest, markers: after.markers, cspViolations: [...new Set([...violationsBefore, ...after.cspViolations])].sort(), url: page.url() };
        await context.close();
      }
      await browser.close();
      process.stdout.write(JSON.stringify(out));
    })().catch((error) => { console.error(error); process.exit(1); });`;
}
