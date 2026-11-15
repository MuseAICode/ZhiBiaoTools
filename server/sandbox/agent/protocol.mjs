// agent 沙箱入口的请求与结果协议（路线图第 8 步 8.6a；docs/SERVER_DESIGN.md 第 7.22 节）。只用 Node 内置模块。
//
// worker 经 sandbox-runner 执行模板登记的入口命令 run（node /opt/agent/entry.mjs，不接受参数），请求经**标准输入**传入：
// 一个 UTF-8 的 JSON 对象，至多 MAX_REQUEST_BYTES（与模板的 maxInputBytes 相同）。任务令牌只在请求中，不出现在 argv、
// 容器的环境变量、工作区与任何输出中；入口不把它放进自己的环境（之后由入口启动的 Agent 命令不会继承它）。
//
// 结果写到**标准输出**：恰好一行 JSON（以换行结束），至多 MAX_RESULT_BYTES；退出码 0 表示 ok，1 表示按协议报告的失败。
// 失败只给出固定的错误代码与固定的说明，不含请求、令牌、网关的响应正文。worker 按不可信输入解析结果（src/agent/entry.ts）。
//
// 8.6a 只有 action = session：经 agent-gw 的 GET /v1/session 确认令牌有效，返回令牌的到期时间。Pi 会话（action = prompt）随 8.6b。
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
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const ENTRY_ERROR_MESSAGES = Object.freeze({
  BAD_REQUEST: '入口请求不合法',
  TOKEN_INVALID: '任务令牌无效',
  GATEWAY_UNAVAILABLE: '无法连接平台入口',
  GATEWAY_FAILED: '平台入口的响应不合法',
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

/** 严格解析请求：严格 UTF-8、一个 JSON 对象、字段恰好是登记的那几个（多余的、缺少的、类型不对的一律拒绝）。 */
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
  if (!isPlainObject(value)) throw new EntryError('BAD_REQUEST');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'action,token,version') throw new EntryError('BAD_REQUEST');
  if (value.version !== PROTOCOL_VERSION || value.action !== 'session') throw new EntryError('BAD_REQUEST');
  if (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)) throw new EntryError('BAD_REQUEST');
  return { version: PROTOCOL_VERSION, action: 'session', token: value.token };
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

/** 一行结果（以换行结束）。超过 MAX_RESULT_BYTES 时改报 INTERNAL（8.6a 的结果都很短，不会发生）。 */
export function formatResult(result) {
  const line = `${JSON.stringify({ version: PROTOCOL_VERSION, ...result })}\n`;
  if (Buffer.byteLength(line) <= MAX_RESULT_BYTES) return line;
  return `${JSON.stringify({ version: PROTOCOL_VERSION, ok: false, error: { code: 'INTERNAL', message: ENTRY_ERROR_MESSAGES.INTERNAL } })}\n`;
}

function errorResult(error) {
  const code = error instanceof EntryError ? error.code : 'INTERNAL';
  return { ok: false, error: { code, message: ENTRY_ERROR_MESSAGES[code] } };
}

/** 执行一次入口请求，把结果写到 stdout，返回退出码（0 为 ok，1 为失败）。 */
export async function runEntry({ stdin, stdout, baseUrl = GATEWAY_BASE_URL, timeoutMs = GATEWAY_TIMEOUT_MS }) {
  let result;
  try {
    const request = parseRequest(await readRequest(stdin));
    const session = await querySession({ baseUrl, token: request.token, timeoutMs });
    result = { ok: true, action: 'session', expiresAt: session.expiresAt };
  } catch (error) {
    result = errorResult(error);
  }
  await new Promise((resolve) => stdout.write(formatResult(result), resolve));
  return result.ok ? 0 : 1;
}
