// agent 沙箱入口的请求与结果协议（路线图第 8 步 8.6a；docs/SERVER_DESIGN.md 第 7.22 节）。只用 Node 内置模块。
//
// worker 经 sandbox-runner 执行模板登记的入口命令 run（node /opt/agent/entry.mjs，不接受参数），请求经**标准输入**传入：
// 一个 UTF-8 的 JSON 对象，至多 MAX_REQUEST_BYTES（与模板的 maxInputBytes 相同）。任务令牌只在请求中，不出现在 argv、
// 容器的环境变量、工作区与任何输出中；入口不把它放进自己的环境（之后由入口启动的 Agent 命令不会继承它）。
//
// 结果写到**标准输出**：恰好一行 JSON（以换行结束），至多 MAX_RESULT_BYTES；退出码 0 表示 ok，1 表示按协议报告的失败。
// 失败只给出固定的错误代码与固定的说明，不含请求、令牌、网关的响应正文。worker 按不可信输入解析结果（src/agent/entry.ts）。
//
// 两种请求（action）：
// - session（8.6a）：经 agent-gw 的 GET /v1/session 确认令牌有效，返回令牌的到期时间；
// - prompt（8.6b）：先同样确认令牌，再在 Pi 会话中执行**一条**提示词（新建会话或续接 /workspace/pi-sessions/ 中的会话文件），
//   返回会话文件名、本条提示词用掉的轮数与结束原因。Pi 会话的实现在 pi.mjs，由 entry.mjs 注入（runPrompt），本文件不加载 Pi。
//   提示词、工具清单、轮数上限与模型的上下文长度都由 worker 给出；Agent 的回复与写出的文件留在工作区，由 worker 取回（8.6d）。
//   工具清单中除原生工具外还可以有业务工具（8.6c1，BUSINESS_TOOLS）：入口为它们登记桩（tools.mjs），调用经 agent-gw 的
//   POST /v1/tools/call 交给 worker。**阶段的限制在 worker 一侧**（迁移 0042_agent_tool_scopes）：这里只登记 worker 给出的桩、
//   让 Agent 正常工作，不算控制（沙箱内的命令可以绕过入口直接调用工具接口，#91 确认）。
//   本地工具（8.6c2a，LOCAL_TOOLS）在沙箱内执行、不经 worker：json-validation（jsonValidation.mjs）供 Agent 自查工作区中的 JSON 文件，
//   worker 可在 jsonSchemas 中为指定文件预置 Schema（只在 json-validation 启用时可以给出）；结果提交时平台另按固定规则校验。
import { request as httpRequest } from 'node:http';

export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESULT_BYTES = 16 * 1024;
/** agent-gw 在沙箱内的地址：名字由模板写进 /etc/hosts（不配置 DNS），端口为 AGENT_GATEWAY_PORT。 */
export const GATEWAY_BASE_URL = 'http://agent-gw:8080';
/** 等 agent-gw 响应（含读完响应体）的时限。 */
export const GATEWAY_TIMEOUT_MS = 15_000;
/** agent-gw 响应体的上限（/v1/session 的响应只有几十个字节）。 */
const MAX_GATEWAY_RESPONSE_BYTES = 4 * 1024;

const TOKEN_PATTERN = /^agt_[A-Za-z0-9_-]{43}$/;
/** Pi 原生工具（桌面版 NATIVE_AGENT_TOOLS）。 */
export const NATIVE_TOOLS = Object.freeze(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);
/**
 * 业务工具（8.6c1）：名字是 worker 一侧登记的工具名（src/agent/toolRegistry.ts），入口登记同名的桩（tools.mjs）；
 * request-termination 面向模型的工具名是 report-failure（与桌面版相同），因此与 report-failure 只能二选一。
 */
export const BUSINESS_TOOLS = Object.freeze(['ask-user', 'report-failure', 'request-termination']);
/** 只能出现其中之一的业务工具。 */
export const EXCLUSIVE_BUSINESS_TOOLS = Object.freeze([Object.freeze(['report-failure', 'request-termination'])]);
/** 本地工具（8.6c2a）：在沙箱内由入口执行，不经 worker。 */
export const LOCAL_TOOLS = Object.freeze(['json-validation']);
const REQUEST_TOOLS = Object.freeze([...NATIVE_TOOLS, ...LOCAL_TOOLS, ...BUSINESS_TOOLS]);
/** jsonSchemas 至多为这么多个文件预置 Schema。 */
export const MAX_JSON_SCHEMAS = 32;
/** 工作区内相对路径的上限（与工作区快照的规则相同：完整路径至多 255 个字节、至多 8 级）。 */
export const MAX_WORKSPACE_PATH_BYTES = 255;
export const MAX_WORKSPACE_PATH_DEPTH = 8;
/** Pi 新建会话时的文件名（SessionManager：ISO 时间中的 : 与 . 换成 -，加会话 id）；续接时只接受这种名字。 */
export const SESSION_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
/** 一条提示词至多这么多字符（请求整体另有 MAX_REQUEST_BYTES）。 */
export const MAX_PROMPT_CHARS = 256 * 1024;
/** 一条提示词之内至多的轮数（桌面版 max_turns_per_prompt；任务的轮数与费用上限另由平台按令牌执行，8.3a）。 */
export const MAX_TURNS_PER_PROMPT = 1_000;
/** 模型的上下文长度与输出上限的取值范围（worker 按组织选用的模型给出；平台另把 max_tokens 截到 AI_MAX_OUTPUT_TOKENS）。 */
export const CONTEXT_WINDOW_RANGE = Object.freeze({ min: 8_192, max: 2_000_000 });
export const MAX_OUTPUT_TOKENS_RANGE = Object.freeze({ min: 256, max: 131_072 });
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const ENTRY_ERROR_MESSAGES = Object.freeze({
  BAD_REQUEST: '入口请求不合法',
  TOKEN_INVALID: '任务令牌无效',
  GATEWAY_UNAVAILABLE: '无法连接平台入口',
  GATEWAY_FAILED: '平台入口的响应不合法',
  SESSION_INVALID: 'Agent 会话文件无效',
  TURN_LIMIT: '本条提示词的轮数达到上限',
  MODEL_FAILED: '模型调用失败',
  REPORTED_FAILURE: 'Agent 报告无法继续',
  RUN_ENDED: '本次执行已结束',
  INTERNAL: '入口内部错误',
});

export class EntryError extends Error {
  /** @param {keyof typeof ENTRY_ERROR_MESSAGES} code */
  constructor(code) {
    super(ENTRY_ERROR_MESSAGES[code]);
    this.name = 'EntryError';
    this.code = code;
  }
}

/** 读完标准输入；超过上限即停止读取并拒绝（不缓存多出的字节）。 */
export async function readRequest(stream, maxBytes = MAX_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy?.();
      throw new EntryError('BAD_REQUEST');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const hasExactKeys = (value, keys) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isIntegerIn = (value, { min, max }) => Number.isSafeInteger(value) && value >= min && value <= max;

/**
 * 规范的工作区相对路径：以 / 分隔、不以 / 开头或结尾，没有空段、`.`、`..`，不含反斜杠与控制字符，至多 MAX_WORKSPACE_PATH_BYTES 个字节、
 * MAX_WORKSPACE_PATH_DEPTH 级。jsonSchemas 的键必须是这种形式（worker 一侧 src/agent/entry.ts 用同样的规则）。
 */
export function isWorkspaceRelativePath(value) {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > MAX_WORKSPACE_PATH_BYTES) return false;
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return false;
  const segments = value.split('/');
  return segments.length <= MAX_WORKSPACE_PATH_DEPTH && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** 预置 Schema：键为工作区相对路径，值为 JSON Schema（对象或布尔值）；在沙箱内用到时才编译。 */
function parseJsonSchemas(value) {
  if (!isPlainObject(value)) throw new EntryError('BAD_REQUEST');
  const entries = Object.entries(value);
  if (entries.length > MAX_JSON_SCHEMAS) throw new EntryError('BAD_REQUEST');
  for (const [path, schema] of entries) {
    if (!isWorkspaceRelativePath(path)) throw new EntryError('BAD_REQUEST');
    if (typeof schema !== 'boolean' && !isPlainObject(schema)) throw new EntryError('BAD_REQUEST');
  }
  // Object.fromEntries 按自有属性写入（键为 __proto__ 时也不改原型）。
  return Object.fromEntries(entries);
}

const PROMPT_KEYS = Object.freeze(['version', 'action', 'token', 'prompt', 'session', 'tools', 'maxTurns', 'model']);

function parsePromptFields(value) {
  // jsonSchemas 可以省略（等于没有预置），给出时 tools 中必须有 json-validation。
  const hasSchemas = Object.hasOwn(value, 'jsonSchemas');
  if (!hasExactKeys(value, hasSchemas ? [...PROMPT_KEYS, 'jsonSchemas'] : PROMPT_KEYS)) throw new EntryError('BAD_REQUEST');
  const { prompt, session, tools, maxTurns, model } = value;
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_PROMPT_CHARS) throw new EntryError('BAD_REQUEST');
  if (session !== null && (typeof session !== 'string' || !SESSION_FILE_PATTERN.test(session))) throw new EntryError('BAD_REQUEST');
  if (!Array.isArray(tools) || tools.length > REQUEST_TOOLS.length || new Set(tools).size !== tools.length) throw new EntryError('BAD_REQUEST');
  if (!tools.every((name) => typeof name === 'string' && REQUEST_TOOLS.includes(name))) throw new EntryError('BAD_REQUEST');
  if (EXCLUSIVE_BUSINESS_TOOLS.some((group) => group.filter((name) => tools.includes(name)).length > 1)) throw new EntryError('BAD_REQUEST');
  if (!isIntegerIn(maxTurns, { min: 1, max: MAX_TURNS_PER_PROMPT })) throw new EntryError('BAD_REQUEST');
  if (!isPlainObject(model) || !hasExactKeys(model, ['contextWindow', 'maxOutputTokens'])) throw new EntryError('BAD_REQUEST');
  if (!isIntegerIn(model.contextWindow, CONTEXT_WINDOW_RANGE) || !isIntegerIn(model.maxOutputTokens, MAX_OUTPUT_TOKENS_RANGE)) throw new EntryError('BAD_REQUEST');
  if (model.maxOutputTokens > model.contextWindow) throw new EntryError('BAD_REQUEST');
  if (hasSchemas && !tools.includes('json-validation')) throw new EntryError('BAD_REQUEST');
  return {
    prompt,
    session,
    tools: [...tools],
    maxTurns,
    model: { contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens },
    jsonSchemas: hasSchemas ? parseJsonSchemas(value.jsonSchemas) : {},
  };
}

/** 严格解析请求：严格 UTF-8、一个 JSON 对象、字段恰好是该 action 登记的那几个（多余的、缺少的、类型不对的一律拒绝）。 */
export function parseRequest(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new EntryError('BAD_REQUEST');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EntryError('BAD_REQUEST');
  }
  if (!isPlainObject(value) || value.version !== PROTOCOL_VERSION) throw new EntryError('BAD_REQUEST');
  if (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)) throw new EntryError('BAD_REQUEST');
  if (value.action === 'session') {
    if (!hasExactKeys(value, ['version', 'action', 'token'])) throw new EntryError('BAD_REQUEST');
    return { version: PROTOCOL_VERSION, action: 'session', token: value.token };
  }
  if (value.action === 'prompt') return { version: PROTOCOL_VERSION, action: 'prompt', token: value.token, ...parsePromptFields(value) };
  throw new EntryError('BAD_REQUEST');
}

/**
 * GET /v1/session：令牌有效时返回 { expiresAt }（ISO 时间）。401 为 TOKEN_INVALID；连不上、超时为 GATEWAY_UNAVAILABLE；
 * 其他状态、响应体过大或不合法为 GATEWAY_FAILED。不跟随重定向、不复用连接。
 */
export function querySession({ baseUrl = GATEWAY_BASE_URL, token, timeoutMs = GATEWAY_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const url = new URL('/v1/session', baseUrl);
    const req = httpRequest(url, { method: 'GET', agent: false, headers: { authorization: `Bearer ${token}`, accept: 'application/json', connection: 'close' } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_GATEWAY_RESPONSE_BYTES) {
          finish(new EntryError('GATEWAY_FAILED'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => finish(new EntryError('GATEWAY_UNAVAILABLE')));
      response.on('end', () => {
        if (response.statusCode === 401) return finish(new EntryError('TOKEN_INVALID'));
        if (response.statusCode !== 200) return finish(new EntryError('GATEWAY_FAILED'));
        let body;
        try {
          body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          return finish(new EntryError('GATEWAY_FAILED'));
        }
        if (!isPlainObject(body) || body.status !== 'active' || typeof body.expiresAt !== 'string' || !ISO_INSTANT_PATTERN.test(body.expiresAt) || Number.isNaN(Date.parse(body.expiresAt))) {
          return finish(new EntryError('GATEWAY_FAILED'));
        }
        finish(null, { expiresAt: body.expiresAt });
      });
    });
    const timer = setTimeout(() => finish(new EntryError('GATEWAY_UNAVAILABLE')), timeoutMs);
    req.on('error', () => finish(new EntryError('GATEWAY_UNAVAILABLE')));
    req.end();
  });
}

/** 一行结果（以换行结束）。超过 MAX_RESULT_BYTES 时改报 INTERNAL（结果只有固定的字段与会话文件名，不会发生）。 */
export function formatResult(result) {
  const line = `${JSON.stringify({ version: PROTOCOL_VERSION, ...result })}\n`;
  if (Buffer.byteLength(line) <= MAX_RESULT_BYTES) return line;
  return `${JSON.stringify({ version: PROTOCOL_VERSION, ok: false, error: { code: 'INTERNAL', message: ENTRY_ERROR_MESSAGES.INTERNAL } })}\n`;
}

function errorResult(error) {
  const code = error instanceof EntryError ? error.code : 'INTERNAL';
  return { ok: false, error: { code, message: ENTRY_ERROR_MESSAGES[code] } };
}

/**
 * 执行一次入口请求，把结果写到 stdout，返回退出码（0 为 ok，1 为失败）。
 * runPrompt（pi.mjs 的 runPiPrompt）只在 prompt 请求、令牌确认有效之后调用，返回 { session, turns, stopReason }，
 * 失败时抛 EntryError（其他异常一律按 INTERNAL 报告，不带出说明）。
 */
export async function runEntry({ stdin, stdout, baseUrl = GATEWAY_BASE_URL, timeoutMs = GATEWAY_TIMEOUT_MS, runPrompt }) {
  let result;
  try {
    const request = parseRequest(await readRequest(stdin));
    const session = await querySession({ baseUrl, token: request.token, timeoutMs });
    if (request.action === 'session') {
      result = { ok: true, action: 'session', expiresAt: session.expiresAt };
    } else {
      if (typeof runPrompt !== 'function') throw new EntryError('INTERNAL');
      const outcome = await runPrompt(request, { baseUrl });
      result = { ok: true, action: 'prompt', session: outcome.session, turns: outcome.turns, stopReason: outcome.stopReason };
    }
  } catch (error) {
    result = errorResult(error);
  }
  await new Promise((resolve) => stdout.write(formatResult(result), resolve));
  return result.ok ? 0 : 1;
}
