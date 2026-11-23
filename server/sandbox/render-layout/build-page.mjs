// 构建 render-layout 的页面脚本（路线图第 8 步 8.8c）：只在镜像的构建阶段运行（server/sandbox/render-layout/Dockerfile 的 deps 阶段），
// 用 esbuild 把 page.mjs、layoutProjection.mjs 与已打补丁的 @docx-editor.dev/core 打成一个自包含的浏览器脚本（IIFE），
// 最终镜像只有这一个文件，没有 esbuild 与 node_modules 中的 docx-editor。
//
// docx-editor 中只在 Node 或可选功能中按需加载的模块换成立即抛错的桩，不进入浏览器脚本：
// - fs、fs/promises、url、path：Node 中从磁盘读取打包资源的加载器（浏览器中用不到）；
// - HarfBuzz 排版库（dist-*.js，内含 WebAssembly）：只在调用方要求 HarfBuzz 排版时加载；这里用 Canvas 测量，与桌面版相同。
// 构建后核对：桩正好命中上面这些模块（升级 docx-editor 后模块变化时构建失败，需要重新核对）；输出中没有 WebAssembly、eval、
// new Function 与动态 import（页面 CSP 也不允许）；补丁已打上（输出中有补丁新增的探针 id）。
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const [, , output] = process.argv;
if (!output) {
  console.error('usage: node build-page.mjs <output.js>');
  process.exit(64);
}

const NODE_MODULES = new Set(['fs', 'fs/promises', 'url', 'path']);
const EXPECTED_STUBS = ['fs', 'fs/promises', 'harfbuzz', 'path', 'url'];
const stubbed = new Set();

const stubPlugin = {
  name: 'zhibiao-stub',
  setup(builder) {
    builder.onResolve({ filter: /^(fs|fs\/promises|url|path)$/ }, (args) => {
      if (!NODE_MODULES.has(args.path) || !args.importer.includes('/@docx-editor.dev/core/dist/')) return undefined;
      stubbed.add(args.path);
      return { path: args.path, namespace: 'zhibiao-stub' };
    });
    builder.onResolve({ filter: /^\.\/dist-[A-Z0-9]+\.js$/ }, (args) => {
      if (!args.importer.includes('/@docx-editor.dev/core/dist/')) return undefined;
      const source = readFileSync(new URL(args.path, `file://${args.importer}`), 'utf8');
      // 只把 HarfBuzz（含 WebAssembly 的排版库）换成桩。
      if (!source.includes('WebAssembly') || !source.includes('hb_')) return undefined;
      stubbed.add('harfbuzz');
      return { path: 'harfbuzz', namespace: 'zhibiao-stub' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'zhibiao-stub' }, (args) => ({
      contents: `throw new Error(${JSON.stringify(`not available in render-layout: ${args.path}`)});`,
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: [new URL('./page.mjs', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  outfile: output,
  plugins: [stubPlugin],
  logLevel: 'warning',
});

const stubs = [...stubbed].sort();
if (stubs.join(',') !== EXPECTED_STUBS.join(',')) throw new Error(`unexpected stubbed modules: ${stubs.join(',')}`);
const script = readFileSync(output, 'utf8');
for (const forbidden of ['WebAssembly', 'new Function', 'eval(', 'import(']) {
  if (script.includes(forbidden)) throw new Error(`page script contains ${forbidden}`);
}
if (!script.includes('app-keep-probe')) throw new Error('the docx-editor patch is not applied');
if (!script.includes('__zhibiaoLayout')) throw new Error('the page entry is missing');
