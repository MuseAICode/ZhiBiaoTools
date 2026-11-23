// render-layout 沙箱的隔离测试（路线图第 8 步 8.8c）：与 parse / export / render-mermaid 模板完全相同的一套用例（isolationSuite.ts）——
// 断网、只读根文件系统、非 root 无能力、镜像中没有 setuid 程序 / 网络工具 / 包管理器 / 编译器、资源上限（内存、进程数、fork 炸弹、
// 可写目录写满、CPU、命令超时、调用方中止）、取回时拒绝符号链接与多余文件、沙箱之间不共享任何文件，每项都有去掉该项加固的对照组。
// 输入只收一个 document.docx：放入 .bin 大文件与多个文件的流式用例不适用（streamingInput: false，流式放入是驱动的机制，已由其他模板覆盖），
// 另有下面的用例证明其余输入一律被拒绝、100 MiB 的 docx 能完整放入。
// render-layout 专用的用例（测量、docx 样本、外部引用、时限、只交出版式 JSON）在 renderLayout.test.ts。
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sandboxEnv } from './env.ts';
import { createIsolationHarness, defineIsolationSuite } from './isolationSuite.ts';

const MIB = 1024 * 1024;

describe.runIf(sandboxEnv.layoutImage)('render-layout', () => {
  const harness = createIsolationHarness('render-layout', sandboxEnv.layoutImage ?? '');
  const docx = (bytes: number) => Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(bytes - 4, 0x5a)]);

  it.each([
    ['another file name', [{ path: 'document.zip', data: docx(16) }]],
    ['another extension', [{ path: 'document.json', data: Buffer.from('{}') }]],
    ['a second file', [{ path: 'document.docx', data: docx(16) }, { path: 'extra.docx', data: docx(16) }]],
    ['a nested path', [{ path: 'd/document.docx', data: docx(16) }]],
    ['a docx over 100 MiB', [{ path: 'document.docx', data: docx(100 * MIB + 1) }]],
  ])('accepts only one docx as input: rejects %s', async (_name, files) => {
    const ref = await harness.createSandbox();
    await expect(harness.driver.copyIn(ref, files)).rejects.toMatchObject({ code: 'SANDBOX_BAD_REQUEST' });
  });

  it('copies a 100 MiB docx into /work intact', { timeout: 180_000 }, async () => {
    const ref = await harness.createSandbox();
    const data = docx(100 * MIB);
    await harness.driver.copyIn(ref, [{ path: 'document.docx', data }]);
    const result = await harness.sh(ref, 'sha256sum /work/document.docx');
    expect(result.stdout.split(' ')[0]).toBe(createHash('sha256').update(data).digest('hex'));
  });

  defineIsolationSuite({
    template: 'render-layout',
    image: sandboxEnv.layoutImage ?? '',
    codeDirectory: '/opt/render-layout',
    outputExtension: 'json',
    validOutput: ['layout.json'],
    inputName: 'document.docx',
    streamingInput: false,
  }, harness);
});
