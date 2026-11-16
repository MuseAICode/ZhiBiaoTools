// agent 沙箱入口中的本地工具 json-validation（路线图第 8 步 8.6c2a；docs/SERVER_DESIGN.md 第 7.25 节）。
//
// 桌面版的 json-validation（pi/piJsonValidationTool.cjs）读取工作区中的 JSON 文件、供 Agent 自查；平台在结果提交时另按固定规则校验。
// #82 决定事项第 3 项：不做成 RPC，在沙箱内本地执行——避免把文件上传到 worker，也避免在持有数据库凭据的 worker 中编译 Agent 提供的
// 任意 schema（正则回溯等资源耗尽）。在沙箱内执行只影响本沙箱，且受沙箱的 CPU、内存与时长限制。
//
// 每次调用在一个新的工作线程中执行（jsonValidationWorker.mjs → jsonValidationCore.mjs）：至多 VALIDATION_TIMEOUT_MS、堆至多
// VALIDATION_HEAP_MB，超出时终止该线程并把“超时 / 超出资源上限”作为校验失败交给模型，入口与 Pi 会话不受影响（schema 中的灾难性
// 正则不会卡住入口的事件循环，轮数上限与中止照常生效）。工作线程的环境为空（不继承入口进程的环境）。
//
// 面向模型的名称、说明、提示与参数沿用桌面版；worker 可在请求的 jsonSchemas 中为指定文件预置 Schema（protocol.mjs）。
import { Worker } from 'node:worker_threads';
import { JSON_VALIDATION_TOOL_NAME, MAX_JSON_FILE_BYTES, validationPayload } from './jsonValidationCore.mjs';

export { JSON_VALIDATION_TOOL_NAME, MAX_JSON_FILE_BYTES };
/** 一次校验（读取、解析、编译 schema、校验）的时限。 */
export const VALIDATION_TIMEOUT_MS = 30_000;
/** 工作线程的堆上限（老生代，MiB）；agent 模板的内存为 2 GiB。 */
export const VALIDATION_HEAP_MB = 512;

const WORKER_URL = new URL('./jsonValidationWorker.mjs', import.meta.url);

const failure = (filePath, stage, message) => validationPayload({ filePath: String(filePath ?? '').slice(0, 500), valid: false, stage, errors: [{ message }] });

/**
 * 在新的工作线程中校验一个文件，返回 validationPayload 的结果（不抛异常）。超时返回 stage = timeout，线程异常退出（含超出堆上限）
 * 返回 stage = resource，被中止返回 stage = aborted。
 */
export function runJsonValidation({ workspaceDir, filePath, presetSchemas, schema, signal, timeoutMs = VALIDATION_TIMEOUT_MS, heapMb = VALIDATION_HEAP_MB }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(failure(filePath, 'aborted', '校验已中止'));
    let settled = false;
    let worker;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker?.terminate();
      resolve(payload);
    };
    const onAbort = () => finish(failure(filePath, 'aborted', '校验已中止'));
    const timer = setTimeout(() => finish(failure(filePath, 'timeout', `校验超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成，已终止；请简化 schema（尤其是 pattern 中的正则）或缩小文件后重试`)), timeoutMs);
    try {
      worker = new Worker(WORKER_URL, {
        workerData: { workspaceDir, filePath, presetSchemas, schema },
        env: {},
        argv: [],
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
    } catch {
      return finish(failure(filePath, 'resource', '无法启动校验，请稍后重试'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    // 工作线程的输出不交给入口的标准输出（入口的标准输出只有一行结果）。
    worker.stdout.resume();
    worker.stderr.resume();
    worker.once('message', (payload) => finish(payload));
    worker.once('error', () => finish(failure(filePath, 'resource', '校验超出资源上限（内存或嵌套层数），已终止；请简化 schema 或缩小文件后重试')));
    worker.once('exit', () => finish(failure(filePath, 'resource', '校验异常结束，请简化 schema 或缩小文件后重试')));
  });
}

/** 工具结果：与桌面版 createToolResult 相同（失败时 isError）。 */
function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
    ...(payload.valid ? {} : { isError: true }),
  };
}

/**
 * json-validation 的 Pi 工具定义（由 pi.mjs 经 defineTool 登记）。
 * - Type：TypeBox（随 Pi 加载）；workspaceDir：工作区；presetSchemas：请求中的 jsonSchemas；
 * - validate 只供测试替换（默认 runJsonValidation）。
 */
export function createJsonValidationTool({ Type, workspaceDir, presetSchemas = {}, validate = runJsonValidation }) {
  return {
    name: JSON_VALIDATION_TOOL_NAME,
    label: 'JSON 校验',
    description: '使用 JSON.parse 和 Ajv 校验当前工作区内的 JSON 文件。任务已预置 Schema 时只传 file_path；没有预置时根据输出要求提供完整 schema。校验失败后修复文件并再次调用。',
    promptSnippet: '使用 JSON.parse 和 Ajv 校验工作区内的 JSON 文件。',
    executionMode: 'sequential',
    parameters: Type.Object({
      file_path: Type.String({
        minLength: 1,
        description: '待校验 JSON 文件相对于当前工作区的路径。',
      }),
      schema: Type.Optional(Type.Union([
        Type.Object({}, { additionalProperties: true }),
        Type.Boolean(),
      ], {
        description: '仅在任务没有为目标文件预置 Schema 时提供，根据当前任务输出要求构造 JSON Schema Draft-07。',
      })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params, signal) => toolResult(await validate({ workspaceDir, filePath: params.file_path, presetSchemas, schema: params.schema, signal })),
  };
}
