// agent 沙箱的入口（路线图第 8 步 8.6a）：sandbox-runner 按模板的 run 命令执行（node /opt/agent/entry.mjs，不接受参数）。
// 请求经标准输入传入、结果写到标准输出，协议见 protocol.mjs。8.6a 只确认任务令牌有效（action = session）；Pi 会话随 8.6b。
import { runEntry } from './protocol.mjs';

process.exitCode = await runEntry({ stdin: process.stdin, stdout: process.stdout });
