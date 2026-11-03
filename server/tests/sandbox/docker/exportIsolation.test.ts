// export 沙箱的隔离测试（路线图第 7 步 7.1）：与 parse 模板完全相同的一套用例（isolationSuite.ts）——断网、只读根文件系统、
// 非 root 无能力、资源上限（内存、进程数、fork 炸弹、可写目录写满、CPU、命令超时、调用方中止）、取回时拒绝符号链接与多余文件、
// 沙箱之间不共享任何文件，每项都有去掉该项加固的对照组。样张与整本导出两个模板分别按各自的资源上限（决定事项第 5 项）运行。
// export 专用的用例（Chromium 禁用 JavaScript、外部引用、导出前后的任务间隔离）在 export.test.ts。
import { describe } from 'vitest';
import { sandboxEnv } from './env.ts';
import { defineIsolationSuite } from './isolationSuite.ts';

for (const template of ['export-preview', 'export-document'] as const) {
  describe.runIf(sandboxEnv.exportImage)(template, () => {
    defineIsolationSuite({
      template,
      image: sandboxEnv.exportImage ?? '',
      codeDirectory: '/opt/export',
      outputExtension: 'json',
      validOutput: ['document.docx', 'result.json'],
    });
  });
}
