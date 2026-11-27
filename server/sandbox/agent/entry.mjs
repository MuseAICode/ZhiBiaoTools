// agent 沙箱的入口（路线图第 8 步 8.6a、8.6b、8.6d2）：sandbox-runner 按模板的 run 命令执行（node /opt/agent/entry.mjs，不接受参数）。
// 请求经标准输入传入、结果写到标准输出，协议见 protocol.mjs；prompt 请求在 Pi 会话中执行一条提示词、compact 请求压缩会话的上下文、
// child-prompt 请求在子会话中执行一条提示词（8.10c3b2）、remove 请求删除工作区中的文件
// （pi.mjs，只在需要时加载 Pi）。
// 标准输出只留给那一行结果：console 的输出（Pi 的提示与告警）一律改到标准错误。写完结果即退出，不等 Pi 留下的连接与定时器。
import { format } from 'node:util';
import { runEntry } from './protocol.mjs';

for (const method of ['log', 'info', 'debug', 'warn', 'error', 'trace']) {
  console[method] = (...args) => process.stderr.write(`${format(...args)}\n`);
}

const code = await runEntry({
  stdin: process.stdin,
  stdout: process.stdout,
  runPrompt: async (request, options) => (await import('./pi.mjs')).runPiPrompt(request, options),
  runCompact: async (request, options) => (await import('./pi.mjs')).runPiCompaction(request, options),
  runChildPrompt: async (request, options) => (await import('./pi.mjs')).runPiChildPrompt(request, options),
});
process.exit(code);
