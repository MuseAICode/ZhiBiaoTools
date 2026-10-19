// 调用模型服务商的 HTTP 客户端（OpenAI 兼容的 /chat/completions 流式接口），docs/SERVER_DESIGN.md 第 4.4 节的出站防护：
// - Base URL 只能是 https；AI_UPSTREAM_PRIVATE_HOSTS 中的主机（自托管模型、CI 中的模拟服务商）例外；
// - 连接时校验实际连接的 IP：DNS 解析结果中有私有、回环、链路本地、组播、保留地址时拒绝（IPv4 与 IPv6），
//   连接用的就是校验过的地址，DNS rebinding 换不了；IP 字面量的主机不经过 DNS，单独校验；
// - 不跟随重定向；响应体大小和总时长都有上限。
//
// 错误一律转成 UpstreamError，消息是固定文案，不含请求头（API Key）、响应体或 Base URL。
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export type UpstreamFailure = 'upstream_error' | 'upstream_timeout' | 'upstream_unreachable' | 'invalid_upstream_response';

export class UpstreamError extends Error {
  readonly reason: UpstreamFailure;
  /** 服务商返回的 HTTP 状态码（有的话）。 */
  readonly status: number | undefined;
  /** 服务商错误体中的错误码（只保留 [A-Za-z0-9_.-]，最长 64 个字符），用于日志。 */
  readonly upstreamCode: string | undefined;

  constructor(reason: UpstreamFailure, details: { status?: number; upstreamCode?: string } = {}) {
    super(`upstream request failed: ${reason}${details.status ? ` (HTTP ${details.status})` : ''}`);
    this.name = 'UpstreamError';
    this.reason = reason;
    this.status = details.status;
    this.upstreamCode = details.upstreamCode;
  }
}

// IPv4 和 IPv6 分开：BlockList 检查 IPv4 地址时也会匹配 IPv6 规则中的 IPv4 映射段（::ffff:0:0/96）。
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  // IPv4 映射 / 兼容地址、NAT64：一律拒绝，避免绕过上面的 IPv4 规则。
  ['::ffff:0:0', 96],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

/** 是否为不允许连接的地址（私有、回环、链路本地、组播、保留、文档用、IPv4 映射等）。不是合法 IP 时也返回 true。 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 4 ? BLOCKED_V4.check(address, 'ipv4') : BLOCKED_V6.check(address, 'ipv6');
}

class BlockedAddressError extends Error {
  readonly code = 'EAI_BLOCKED';
}

/** 解析后校验每一个地址，有任何一个被禁止就整体拒绝。 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, '', 0);
    if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
      return callback(new BlockedAddressError('blocked address'), '', 0);
    }
    if (options.all) return (callback as unknown as (err: null, addresses: LookupAddress[]) => void)(null, addresses);
    const first = addresses[0]!;
    return callback(null, first.address, first.family);
  });
};

export interface UpstreamRequest {
  /** 已经过 normalizeBaseUrl（src/ai/credentials.ts）的 Base URL。 */
  baseUrl: string;
  path: string;
  apiKey: string;
  body: unknown;
  /** 客户端取消或总超时。 */
  signal: AbortSignal;
  /** 由 signal 触发的取消是否属于超时（决定错误原因是 upstream_timeout 还是调用方取消）。 */
  isTimeout: () => boolean;
  privateHosts: readonly string[];
  maxResponseBytes: number;
}

/** 调用方（用户断开、任务取消）主动中止，不属于上游失败。 */
export class UpstreamAbortedError extends Error {
  constructor() {
    super('upstream request aborted by caller');
    this.name = 'UpstreamAbortedError';
  }
}

const ERROR_BODY_LIMIT = 64 * 1024;

function sanitizeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

/** 从服务商的错误体中只取错误码（OpenAI 兼容格式 error.code / error.type，或顶层 code），不保留消息正文。 */
function errorCodeOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown }; code?: unknown };
    return sanitizeCode(parsed.error?.code) ?? sanitizeCode(parsed.error?.type) ?? sanitizeCode(parsed.code);
  } catch {
    return undefined;
  }
}

/**
 * 发起流式请求，逐个产出 SSE 的 data 事件（已解析的 JSON）。遇到 data: [DONE] 结束。
 * 服务商非 200、连接失败、超时、响应过大或格式不对时抛 UpstreamError；调用方主动中止时抛 UpstreamAbortedError。
 */
export async function* streamChatCompletion(request: UpstreamRequest): AsyncGenerator<Record<string, unknown>, { done: boolean }> {
  const url = new URL(`${request.baseUrl}${request.path}`);
  const host = url.hostname.toLowerCase();
  const trusted = request.privateHosts.includes(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && trusted)) throw new UpstreamError('upstream_unreachable');
  const literal = host.replace(/^\[|\]$/g, '');
  if (!trusted && isIP(literal) !== 0 && isBlockedAddress(literal)) throw new UpstreamError('upstream_unreachable');

  const payload = Buffer.from(JSON.stringify(request.body), 'utf8');
  const transport = url.protocol === 'https:' ? https : http;

  const abortedError = () => (request.isTimeout() ? new UpstreamError('upstream_timeout') : new UpstreamAbortedError());
  if (request.signal.aborted) throw abortedError();

  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'content-length': payload.length,
          authorization: `Bearer ${request.apiKey}`,
        },
        ...(trusted ? {} : { lookup: safeLookup }),
        signal: request.signal,
        // 不复用连接：每次调用独立校验地址。
        agent: false,
      },
      resolve,
    );
    // 连接失败（含被拒绝的地址）、TLS 错误、中止：原始错误可能带主机和地址，不向外传。
    req.on('error', () => reject(request.signal.aborted ? abortedError() : new UpstreamError('upstream_unreachable')));
    req.end(payload);
  });

  const status = response.statusCode ?? 0;
  if (status !== 200) {
    let body = '';
    try {
      for await (const chunk of response) {
        body += (chunk as Buffer).toString('utf8');
        if (body.length > ERROR_BODY_LIMIT) break;
      }
    } catch {
      // 错误体读不完不影响结果。
    }
    response.destroy();
    if (request.signal.aborted) throw abortedError();
    const upstreamCode = errorCodeOf(body);
    throw new UpstreamError('upstream_error', { status, ...(upstreamCode ? { upstreamCode } : {}) });
  }

  let received = 0;
  let buffer = '';
  let dataLines: string[] = [];
  // 调用方提前结束迭代（return）时也要关闭连接。
  try {
    for await (const chunk of response) {
      received += (chunk as Buffer).length;
      if (received > request.maxResponseBytes) throw new UpstreamError('invalid_upstream_response');
      buffer += (chunk as Buffer).toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (dataLines.length === 0) continue;
          const data = dataLines.join('\n');
          dataLines = [];
          if (data === '[DONE]') return { done: true };
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            throw new UpstreamError('invalid_upstream_response');
          }
          if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new UpstreamError('invalid_upstream_response');
          yield event as Record<string, unknown>;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // event:、id:、retry: 和注释行（:）忽略。
      }
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (request.signal.aborted) throw abortedError();
    // 连接中途断开。
    throw new UpstreamError('upstream_unreachable');
  } finally {
    response.destroy();
  }
  // 没有 [DONE] 就结束了：由调用方根据是否收到 finish_reason 判断是否完整。
  return { done: false };
}
