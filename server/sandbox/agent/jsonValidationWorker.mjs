// json-validation 的工作线程（路线图第 8 步 8.6c2a）：由 jsonValidation.mjs 以 worker_threads 启动，执行一次校验后把结果发回并退出。
// Agent 给出的 schema（含正则）与待校验的数据都在这个线程中处理：耗尽时间或内存时只终止本线程，入口与 Pi 会话继续运行。
import { parentPort, workerData } from 'node:worker_threads';
import { validateJsonFile } from './jsonValidationCore.mjs';

parentPort?.postMessage(validateJsonFile(workerData));
