// 生图结果的下载（路线图第 8 步 8.9）：服务商以网址返回图片时，worker 按下面的规则取回，防止被服务商的响应（不可信）
// 引去访问内网或任意网站（SSRF），也不让一张图片拖住或撑爆 worker。规则与 AI 网关调用服务商的出站防护相同（src/ai/upstream.ts，
// docs/SERVER_DESIGN.md 第 4.4 节），另加域名白名单：
//
// - 只允许 https；网址不能带用户名、密码；端口只能是默认的 443（AI_UPSTREAM_PRIVATE_HOSTS 中的主机例外）；
// - 只允许服务商的域名：主机名必须等于白名单中的某一项，或是以“.后缀”写出的某一项的子域名（例如 .aliyuncs.com）。
//   白名单来自服务商适配（src/ai/images.ts 的 IMAGE_PROVIDER_ADAPTERS）与该服务商生图凭据的 Base URL 主机；
// - 拒绝内网地址：IP 字面量直接检查；域名经 safeLookup 解析后检查每一个地址（私有、回环、链路本地、组播、保留、IPv4 映射等），
//   连接用的就是检查过的地址，DNS rebinding 换不了。AI_UPSTREAM_PRIVATE_HOSTS 中的主机（CI 中的模拟服务商）不做地址检查，
//   但仍然必须是 https、必须在域名白名单中；
// - 不跟随跳转：任何 3xx 都按失败处理，Location 不读取；
// - 大小上限：Content-Length 超过上限时不读正文；读取中累计超过上限立即断开；
// - 时长上限：连接、等待响应与读完正文合计不超过 timeoutMs；
// - 不带任何凭据：请求中没有 Authorization 与 Cookie，平台的 API Key 不会被发给图片地址。
//
// 失败一律抛 ImageDownloadError（代码在白名单内），消息是固定文案，不含网址、地址、响应头或正文。
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isBlockedAddress, safeLookup } from './upstream.ts';

export const IMAGE_DOWNLOAD_FAILURES = [
  'url_invalid',
  'host_not_allowed',
  'address_blocked',
  'redirect',
  'http_error',
  'too_large',
  'timeout',
  'unreachable',
  'aborted',
] as const;
export type ImageDownloadFailure = (typeof IMAGE_DOWNLOAD_FAILURES)[number];

export class ImageDownloadError extends Error {
  readonly reason: ImageDownloadFailure;
  constructor(reason: ImageDownloadFailure) {
    super(`image download failed: ${reason}`);
    this.name = 'ImageDownloadError';
    this.reason = reason;
  }
}

/** 网址的长度上限（服务商的签名网址通常数百个字符）。 */
export const IMAGE_URL_MAX_LENGTH = 4096;
const HOST_RULE = /^\.?(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** 白名单项：小写主机名，或以“.”开头的域名后缀（匹配其子域名，不匹配后缀本身）。 */
export function isValidHostRule(rule: string): boolean {
  return HOST_RULE.test(rule);
}

/** 主机名是否在白名单中。IP 字面量只能精确匹配（不按后缀）。 */
export function hostAllowed(host: string, rules: readonly string[]): boolean {
  const name = host.toLowerCase();
  return rules.some((rule) => (rule.startsWith('.') ? isIP(name) === 0 && name.endsWith(rule) && name.length > rule.length : name === rule));
}

export interface ImageDownloadRequest {
  url: string;
  /** 允许的主机（见 hostAllowed）。为空时任何网址都被拒绝。 */
  allowedHosts: readonly string[];
  /** AI_UPSTREAM_PRIVATE_HOSTS：这些主机不做内网地址检查（仍要求 https 与白名单）。 */
  privateHosts: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  /** 调用方取消。 */
  signal?: AbortSignal | undefined;
  /** 只用于测试：信任的自签名证书。生产代码不传。 */
  ca?: string | Buffer | undefined;
}

export interface DownloadedImage {
  data: Buffer;
  /** 服务商声明的类型（只作参考，格式按内容判断）。 */
  contentType: string | null;
}

/** 检查网址（不发请求），返回解析后的 URL；不合格时抛 ImageDownloadError。 */
export function checkImageUrl(raw: string, allowedHosts: readonly string[], privateHosts: readonly string[]): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > IMAGE_URL_MAX_LENGTH) throw new ImageDownloadError('url_invalid');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImageDownloadError('url_invalid');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // 非默认端口只允许 AI_UPSTREAM_PRIVATE_HOSTS 中的主机（CI 中的模拟服务商监听随机端口）。
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && !privateHosts.includes(host))) {
    throw new ImageDownloadError('url_invalid');
  }
  if (!hostAllowed(host, allowedHosts)) throw new ImageDownloadError('host_not_allowed');
  if (!privateHosts.includes(host) && isIP(host) !== 0 && isBlockedAddress(host)) throw new ImageDownloadError('address_blocked');
  return url;
}

/** 取回一张图片。 */
export async function downloadImage(request: ImageDownloadRequest): Promise<DownloadedImage> {
  const url = checkImageUrl(request.url, request.allowedHosts, request.privateHosts);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const trusted = request.privateHosts.includes(host);
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const abortReason = (): ImageDownloadError => new ImageDownloadError(timeout.aborted ? 'timeout' : 'aborted');
  if (signal.aborted) throw abortReason();

  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: { accept: 'image/*' },
        ...(trusted ? {} : { lookup: safeLookup }),
        ...(request.ca !== undefined ? { ca: request.ca } : {}),
        signal,
        agent: false,
      },
      resolve,
    );
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (signal.aborted) return reject(abortReason());
      reject(new ImageDownloadError(error.code === 'EAI_BLOCKED' ? 'address_blocked' : 'unreachable'));
    });
    req.end();
  });

  try {
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) throw new ImageDownloadError('redirect');
    if (status !== 200) throw new ImageDownloadError('http_error');
    const declared = response.headers['content-length'];
    if (declared !== undefined && !(/^\d{1,15}$/.test(declared) && Number(declared) <= request.maxBytes)) throw new ImageDownloadError('too_large');
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      for await (const chunk of response) {
        received += (chunk as Buffer).length;
        if (received > request.maxBytes) throw new ImageDownloadError('too_large');
        chunks.push(chunk as Buffer);
      }
    } catch (error) {
      if (error instanceof ImageDownloadError) throw error;
      if (signal.aborted) throw abortReason();
      throw new ImageDownloadError('unreachable');
    }
    if (signal.aborted) throw abortReason();
    const type = response.headers['content-type'];
    return { data: Buffer.concat(chunks), contentType: typeof type === 'string' ? type.slice(0, 100) : null };
  } finally {
    response.destroy();
  }
}
