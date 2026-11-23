// 生图结果的下载（src/ai/imageDownload.ts，路线图第 8 步 8.9）：只允许服务商域名、仅 https、不跟随跳转、拒绝内网地址、
// 大小与时长上限、不带凭据。用本机的自签名 https 服务模拟服务商的图片地址（证书在测试开始时用 openssl 生成，只交给这一个请求信任）。
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkImageUrl, downloadImage, hostAllowed, ImageDownloadError, isValidHostRule, type ImageDownloadFailure } from '../../src/ai/imageDownload.ts';

let server: https.Server;
let port: number;
let ca: Buffer;
let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;
const seen: { path: string; headers: import('node:http').IncomingHttpHeaders }[] = [];
const sockets = new Set<import('node:stream').Duplex>();

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'image-download-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    ], { stdio: 'ignore' });
    ca = readFileSync(path.join(dir, 'cert.pem'));
    server = https.createServer({ key: readFileSync(path.join(dir, 'key.pem')), cert: ca }, (req, res) => {
      seen.push({ path: req.url ?? '', headers: req.headers });
      handler(req, res);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  server.close();
  await once(server, 'close');
});

beforeEach(() => {
  seen.length = 0;
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from('png-bytes'));
  };
});

const IMAGE = () => `https://127.0.0.1:${port}/result/image.png?sig=abc`;
const download = (overrides: Partial<Parameters<typeof downloadImage>[0]> = {}) =>
  downloadImage({ url: IMAGE(), allowedHosts: ['127.0.0.1'], privateHosts: ['127.0.0.1'], maxBytes: 1024, timeoutMs: 2_000, ca, ...overrides });

async function expectFailure(promise: Promise<unknown>, reason: ImageDownloadFailure): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ImageDownloadError);
  expect((error as ImageDownloadError).reason).toBe(reason);
  // 错误消息不含网址、主机或签名参数。
  expect((error as Error).message).not.toMatch(/127\.0\.0\.1|sig=|https?:/);
}

describe('hostAllowed / isValidHostRule', () => {
  it('matches exact hosts and subdomains of a suffix rule, never the bare suffix or a look-alike', () => {
    const rules = ['.aliyuncs.com', 'dashscope.example.com'];
    expect(hostAllowed('dashscope-result-bj.oss-cn-beijing.aliyuncs.com', rules)).toBe(true);
    expect(hostAllowed('DashScope.Example.com', rules)).toBe(true);
    expect(hostAllowed('aliyuncs.com', rules)).toBe(false);
    expect(hostAllowed('evilaliyuncs.com', rules)).toBe(false);
    expect(hostAllowed('aliyuncs.com.evil.net', rules)).toBe(false);
    expect(hostAllowed('x.dashscope.example.com', rules)).toBe(false);
    expect(hostAllowed('10.0.0.1', ['.0.0.1'])).toBe(false);
    expect(hostAllowed('anything.example', [])).toBe(false);
  });

  it('validates rules', () => {
    expect(isValidHostRule('.aliyuncs.com')).toBe(true);
    expect(isValidHostRule('oss.example.com')).toBe(true);
    for (const bad of ['*.aliyuncs.com', 'https://x.com', '..com', 'a b', '', '.']) expect(isValidHostRule(bad)).toBe(false);
  });
});

describe('checkImageUrl', () => {
  const allowed = ['.aliyuncs.com', '10.0.0.1', '127.0.0.1', '::1'];
  it.each([
    ['http (not https)', 'http://x.aliyuncs.com/a.png', 'url_invalid'],
    ['a data URL', 'data:image/png;base64,AAAA', 'url_invalid'],
    ['a file URL', 'file:///etc/passwd', 'url_invalid'],
    ['user info', 'https://user:pw@x.aliyuncs.com/a.png', 'url_invalid'],
    ['a non-default port', 'https://x.aliyuncs.com:8443/a.png', 'url_invalid'],
    ['not a URL', 'not a url', 'url_invalid'],
    ['an overlong URL', `https://x.aliyuncs.com/${'a'.repeat(5000)}`, 'url_invalid'],
    ['a host outside the allow list', 'https://evil.example.com/a.png', 'host_not_allowed'],
    ['the metadata service', 'https://169.254.169.254/latest/meta-data', 'host_not_allowed'],
    ['a private IP even when listed', 'https://10.0.0.1/a.png', 'address_blocked'],
    ['loopback even when listed', 'https://127.0.0.1/a.png', 'address_blocked'],
    ['IPv6 loopback even when listed', 'https://[::1]/a.png', 'address_blocked'],
  ] as const)('rejects %s', (_name, url, reason) => {
    expect(() => checkImageUrl(url, allowed, [])).toThrow(expect.objectContaining({ reason }));
  });

  it('accepts an https URL on an allowed host', () => {
    expect(checkImageUrl('https://dashscope-result.oss-cn-beijing.aliyuncs.com/a.png?Expires=1', allowed, []).hostname).toBe(
      'dashscope-result.oss-cn-beijing.aliyuncs.com',
    );
  });
});

describe('downloadImage', () => {
  it('downloads over https without sending credentials', async () => {
    const image = await download();
    expect(image.data.toString()).toBe('png-bytes');
    expect(image.contentType).toBe('image/png');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers.cookie).toBeUndefined();
  });

  it('rejects a host that resolves to a private address (DNS is checked when connecting)', async () => {
    // localhost 不在 AI_UPSTREAM_PRIVATE_HOSTS 中：解析到 127.0.0.1 / ::1，连接前被拒绝。
    await expectFailure(downloadImage({ url: 'https://localhost/a.png', allowedHosts: ['localhost'], privateHosts: [], maxBytes: 1024, timeoutMs: 2_000 }), 'address_blocked');
    expect(seen).toHaveLength(0);
  });

  it('does not follow redirects', async () => {
    handler = (req, res) => {
      if (req.url?.startsWith('/result/')) {
        res.writeHead(302, { location: `https://127.0.0.1:${port}/elsewhere` });
        res.end();
      } else {
        res.writeHead(200);
        res.end('should not be requested');
      }
    };
    await expectFailure(download(), 'redirect');
    expect(seen.map((entry) => entry.path)).toEqual(['/result/image.png?sig=abc']);
  });

  it('rejects other non-200 responses', async () => {
    handler = (_req, res) => {
      res.writeHead(403);
      res.end('denied');
    };
    await expectFailure(download(), 'http_error');
  });

  it('rejects a declared Content-Length over the limit without reading the body', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': '2048' });
      res.end(Buffer.alloc(2048));
    };
    await expectFailure(download(), 'too_large');
  });

  it('stops reading a chunked body once it passes the limit', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      const timer = setInterval(() => res.write(Buffer.alloc(512)), 5);
      res.on('close', () => clearInterval(timer));
    };
    await expectFailure(download(), 'too_large');
  });

  it('gives up after the time limit (slow body)', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write('x');
    };
    const started = Date.now();
    await expectFailure(download({ timeoutMs: 300 }), 'timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives up after the time limit (no response)', async () => {
    handler = () => {};
    await expectFailure(download({ timeoutMs: 300 }), 'timeout');
  });

  it('reports a caller abort as aborted', async () => {
    handler = () => {};
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expectFailure(download({ signal: controller.signal }), 'aborted');
  });

  it('rejects an untrusted certificate', async () => {
    await expectFailure(download({ ca: undefined }), 'unreachable');
  });
});
