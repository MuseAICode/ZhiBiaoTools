// render-mermaid 沙箱的隔离测试（路线图第 8 步 8.8b）：与 parse / export 模板完全相同的一套用例（isolationSuite.ts）——断网、只读根文件系统、
// 非 root 无能力、镜像中没有 setuid 程序 / 网络工具 / 包管理器 / 编译器、资源上限（内存、进程数、fork 炸弹、可写目录写满、CPU、命令超时、
// 调用方中止）、取回时拒绝符号链接与多余文件、沙箱之间不共享任何文件，每项都有去掉该项加固的对照组。输入只收一个 request.json：
// 放入大文件与多个文件的流式用例不适用（streamingInput: false），另有下面的用例证明其余输入一律被拒绝。
// render-mermaid 专用的用例（Mermaid 的注入样本与对照组、外部引用、资源耗尽、只交出 PNG）在 renderMermaid.test.ts。
import { describe, expect, it } from 'vitest';
import { sandboxEnv } from './env.ts';
import { createIsolationHarness, defineIsolationSuite } from './isolationSuite.ts';

describe.runIf(sandboxEnv.mermaidImage)('render-mermaid', () => {
  const harness = createIsolationHarness('render-mermaid', sandboxEnv.mermaidImage ?? '');

  it.each([
    ['another file name', [{ path: 'request.bin', data: Buffer.from('{}') }]],
    ['a second file', [{ path: 'request.json', data: Buffer.from('{}') }, { path: 'extra.json', data: Buffer.from('{}') }]],
    ['a nested path', [{ path: 'd/request.json', data: Buffer.from('{}') }]],
    ['a request over 7 MiB', [{ path: 'request.json', data: Buffer.alloc(7 * 1024 * 1024 + 1, 0x20) }]],
  ])('accepts only request.json as input: rejects %s', async (_name, files) => {
    const ref = await harness.createSandbox();
    await expect(harness.driver.copyIn(ref, files)).rejects.toMatchObject({ code: 'SANDBOX_BAD_REQUEST' });
  });

  defineIsolationSuite({
    template: 'render-mermaid',
    image: sandboxEnv.mermaidImage ?? '',
    codeDirectory: '/opt/render-mermaid',
    outputExtension: 'png',
    validOutput: ['m001.png', 'result.json'],
    inputName: 'request.json',
    streamingInput: false,
  }, harness);
});
