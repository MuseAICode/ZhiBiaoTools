// agent-gw（src/agent/gateway.ts，路线图第 8 步 8.2b）的单元测试：用一个记录请求的 HTTP 桩代替 worker。
// 每一项检查都有恶意样本（被拒绝、没有转给 worker）与对照组（合法请求转给 worker 并原样回传）。
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_GATEWAY_ROUTES, buildAgentGateway, type AgentGatewayLimits } from '../../src/agent/gateway.ts';
import { AGENT_RELAY_KEY_HEADER, agentTokenLogId, generateAgentToken, hashAgentToken } from '../../src/agent/token.ts';
import { createLogCapture } from '../helpers.ts';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** worker 内部入口的桩：记录收到的请求，按 handler 响应。 */
function createUpstream() {
  const requests: Recorded[] = [];
  const closed: string[] = [];
  let handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void = (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'x=1', 'x-internal': 'secret-detail' });
    response.end(JSON.stringify({ status: 'active' }));
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      response.once('close', () => {
        if (!response.writableFinished) closed.push(request.url ?? '');
      });
      handler(request, response, body);
    });
  });
  return {
    server,
    requests,
    closed,
    setHandler(next: typeof handler) {
      handler = next;
    },
  };
}

const TEST_LIMITS: Partial<AgentGatewayLimits> = {
  headersTimeoutMs: 300,
  requestTimeoutMs: 600,
  maxBodyBytes: 64 * 1024,
  maxInFlightPerToken: 2,
  upstreamConnectTimeoutMs: 300,
  responseTimeoutMs: 1_500,
};
const ROUTES = [...AGENT_GATEWAY_ROUTES, { method: 'POST', path: '/v1/test-echo', bodyLimit: 16 * 1024 } as const];

let upstream: ReturnType<typeof createUpstream>;
let upstreamOrigin: string;
let gateway: FastifyInstance;
let gatewayPort: number;
let logs: ReturnType<typeof createLogCapture>;
const token = generateAgentToken();
const RELAY_KEY = 'relay-key-'.padEnd(48, 'k');

async function startGateway(options: { upstream?: string; limits?: Partial<AgentGatewayLimits> } = {}) {
  logs = createLogCapture();
  const app = await buildAgentGateway({
    upstream: options.upstream ?? upstreamOrigin,
    relayKey: RELAY_KEY,
    logLevel: 'info',
    logStream: logs.stream,
    limits: { ...TEST_LIMITS, ...options.limits },
    routes: ROUTES,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, port: (app.server.address() as AddressInfo).port };
}

beforeAll(async () => {
  upstream = createUpstream();
  await new Promise<void>((resolve) => upstream.server.listen(0, '127.0.0.1', resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  upstream.server.closeAllConnections();
  await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
});

beforeEach(async () => {
  upstream.requests.length = 0;
  upstream.closed.length = 0;
  ({ app: gateway, port: gatewayPort } = await startGateway());
});

afterEach(async () => {
  await gateway.close();
});

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(options: { method?: string; path?: string; headers?: Record<string, string | number | string[]>; body?: Buffer | string; port?: number }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: options.port ?? gatewayPort, method: options.method ?? 'GET', path: options.path ?? '/v1/session', headers: options.headers ?? {}, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

const auth = (value = token) => ({ authorization: `Bearer ${value}` });

/** 原始 TCP 连接：写入 data 后等服务端关闭连接，返回收到的全部字节与耗时。 */
function rawExchange(data: string | Buffer, options: { keepWriting?: (socket: Socket) => void; timeoutMs?: number } = {}): Promise<{ text: string; ms: number; closed: boolean }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect(gatewayPort, '127.0.0.1');
    const chunks: Buffer[] = [];
    let interval: NodeJS.Timeout | undefined;
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      if (interval) clearInterval(interval);
      socket.destroy();
      resolve({ text: Buffer.concat(chunks).toString('latin1'), ms: Date.now() - started, closed });
    };
    const timer = setTimeout(() => finish(false), options.timeoutMs ?? 5_000);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('close', () => finish(true));
    socket.on('error', () => undefined);
    socket.write(data);
    if (options.keepWriting) {
      const keep = options.keepWriting;
      interval = setInterval(() => {
        if (!socket.destroyed) keep(socket);
      }, 100);
    }
  });
}

describe('对照组：合法请求转给 worker', () => {
  it('带有效格式的令牌访问登记的路由：转给 worker 并回传状态码与响应体', async () => {
    const response = await send({ headers: auth() });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'active' });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({ method: 'GET', url: '/v1/session' });
    expect(upstream.requests[0]!.headers.authorization).toBe(`Bearer ${token}`);
    expect(upstream.requests[0]!.headers[AGENT_RELAY_KEY_HEADER]).toBe(RELAY_KEY);
  });

  it('POST 路由原样转发 JSON 请求体（agent-gw 不解析）', async () => {
    const body = '{"messages":[{"role":"user","content":"你好"}],  "x": 1}';
    const response = await send({ method: 'POST', path: '/v1/test-echo', headers: { ...auth(), 'content-type': 'application/json; charset=utf-8' }, body });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]!.body.toString('utf8')).toBe(body);
    expect(upstream.requests[0]!.headers['content-type']).toBe('application/json');
    expect(upstream.requests[0]!.headers['content-length']).toBe(String(Buffer.byteLength(body)));
  });

  it('健康检查不需要令牌、不转给 worker', async () => {
    const response = await send({ path: '/healthz' });
    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe('令牌：只做格式检查，不对的不读请求体、不转给 worker', () => {
  it.each([
    ['缺失', {}],
    ['不是 Bearer', { authorization: `Basic ${token}` }],
    ['小写 bearer', { authorization: `bearer ${token}` }],
    ['多一个空格', { authorization: `Bearer  ${token}` }],
    ['前缀不对', { authorization: `Bearer xyz_${token.slice(4)}` }],
    ['过短', { authorization: `Bearer ${token.slice(0, -1)}` }],
    ['过长', { authorization: `Bearer ${token}A` }],
    ['非法字符', { authorization: `Bearer ${token.slice(0, -1)}=` }],
    ['sandbox-runner 风格的共享令牌', { authorization: `Bearer ${'x'.repeat(48)}` }],
  ])('%s → 401', async (_name, headers) => {
    const response = await send({ headers });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('AGENT_TOKEN_INVALID');
    expect(upstream.requests).toHaveLength(0);
  });

  it('令牌格式不对时不读取请求体：大请求体的连接被关闭', async () => {
    const response = await send({ method: 'POST', path: '/v1/test-echo', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: Buffer.alloc(10 * 1024, 0x20) });
    expect(response.status).toBe(401);
    expect(response.headers.connection).toBe('close');
    expect(upstream.requests).toHaveLength(0);
  });
});

describe('路由：只转登记的方法与路径', () => {
  it.each([
    ['GET', '/v1/other'],
    ['GET', '/'],
    ['POST', '/v1/session'],
    ['GET', '/v1/test-echo'],
    ['DELETE', '/v1/session'],
    ['HEAD', '/v1/session'],
    ['GET', '/v1/session/../admin'],
    ['GET', '//worker/v1/session'],
  ])('%s %s → 拒绝', async (method, path) => {
    const response = await send({ method, path, headers: auth() });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it('查询串不转发', async () => {
    const response = await send({ path: '/v1/session?org_id=other&redirect=http://evil', headers: auth() });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]!.url).toBe('/v1/session');
  });
});

describe('头部：只转必要的头部，回传时也只带必要的头部', () => {
  it('沙箱自称的身份字段、Cookie、转发头一律不转给 worker', async () => {
    const response = await send({
      headers: {
        ...auth(),
        cookie: '__Host-session=stolen',
        'x-forwarded-for': '10.0.0.1',
        'x-org-id': '00000000-0000-4000-8000-000000000000',
        'x-job-id': '00000000-0000-4000-8000-000000000001',
        'x-sandbox-job': '00000000-0000-4000-8000-000000000001',
        'x-api-key': 'sk-fake',
        host: 'worker.internal',
        'x-request-id': 'forged',
        [AGENT_RELAY_KEY_HEADER]: 'forged-relay-key-'.padEnd(48, 'f'),
      },
    });
    expect(response.status).toBe(200);
    const forwarded = upstream.requests[0]!.headers;
    expect(Object.keys(forwarded).sort()).toEqual(['authorization', 'connection', 'host', AGENT_RELAY_KEY_HEADER, 'x-request-id']);
    // 沙箱自带的中继密钥头部不转发：只有 agent-gw 自己的密钥。
    expect(forwarded[AGENT_RELAY_KEY_HEADER]).toBe(RELAY_KEY);
    expect(forwarded['x-request-id']).not.toBe('forged');
    expect(forwarded.host).not.toBe('worker.internal');
  });

  it('worker 的 Set-Cookie 等响应头不回传给沙箱', async () => {
    const response = await send({ headers: auth() });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-internal']).toBeUndefined();
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('超大头部 → 431，不转给 worker', async () => {
    const response = await send({ headers: { ...auth(), 'x-padding': 'a'.repeat(16 * 1024) } });
    expect(response.status).toBe(431);
    expect(upstream.requests).toHaveLength(0);
  });

  it('慢速头部（每 100 毫秒一个字节）：在头部时限后断开连接，不转给 worker', async () => {
    const result = await rawExchange(`GET /v1/session HTTP/1.1\r\nHost: agent-gw\r\nAuthorization: Bearer ${token}\r\n`, {
      keepWriting: (socket) => socket.write('X'),
    });
    expect(result.closed).toBe(true);
    expect(result.ms).toBeLessThan(3_000);
    expect(upstream.requests).toHaveLength(0);
  });

  it('只连接、不发送任何字节：在头部时限后断开连接', async () => {
    const result = await rawExchange('');
    expect(result.closed).toBe(true);
    expect(result.ms).toBeLessThan(3_000);
  });
});

describe('请求体：类型、大小与接收时限', () => {
  it('超过路由上限（声明长度）→ 413，不读取、不转给 worker', async () => {
    const response = await send({ method: 'POST', path: '/v1/test-echo', headers: { ...auth(), 'content-type': 'application/json' }, body: Buffer.alloc(16 * 1024 + 1, 0x20) });
    expect(response.status).toBe(413);
    expect(upstream.requests).toHaveLength(0);
  });

  it('超过路由上限（分块传输，不声明长度）→ 413，不转给 worker', async () => {
    const result = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port: gatewayPort, method: 'POST', path: '/v1/test-echo', headers: { ...auth(), 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, agent: false },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      for (let index = 0; index < 20; index += 1) request.write(Buffer.alloc(1024, 0x20));
      request.end();
    });
    expect(result).toBe(413);
    expect(upstream.requests).toHaveLength(0);
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/x-tar'])('Content-Type %s → 415', async (type) => {
    const response = await send({ method: 'POST', path: '/v1/test-echo', headers: { ...auth(), 'content-type': type }, body: '{}' });
    expect(response.status).toBe(415);
    expect(upstream.requests).toHaveLength(0);
  });

  it('GET 带请求体 → 400', async () => {
    const response = await send({ headers: { ...auth(), 'content-type': 'application/json' }, body: '{"org_id":"x"}' });
    expect(response.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it('慢速请求体：在请求时限后断开连接，不转给 worker', async () => {
    const head = `POST /v1/test-echo HTTP/1.1\r\nHost: agent-gw\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{`;
    const result = await rawExchange(head, { keepWriting: (socket) => socket.write(' ') });
    expect(result.closed).toBe(true);
    expect(result.ms).toBeLessThan(3_000);
    expect(upstream.requests).toHaveLength(0);
  });

  it('请求体比声明的短、随后断开：不转给 worker', async () => {
    await rawExchange(`POST /v1/test-echo HTTP/1.1\r\nHost: agent-gw\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{}`, { timeoutMs: 200 });
    await sleep(100);
    expect(upstream.requests).toHaveLength(0);
  });

  it.each([
    ['畸形请求行', 'GET\r\n\r\n'],
    ['非 HTTP 数据', '\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03'],
    ['重复的 Content-Length', `POST /v1/test-echo HTTP/1.1\r\nHost: a\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}`],
    ['同时有 Content-Length 与分块传输（请求走私）', `POST /v1/test-echo HTTP/1.1\r\nHost: a\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`],
    ['头部中的非法字符', `GET /v1/session HTTP/1.1\r\nHost: a\r\nAuthorization: Bearer ${token}\r\nX-Bad: a\x00b\r\n\r\n`],
  ])('%s → 400 并关闭连接，不转给 worker', async (_name, data) => {
    const result = await rawExchange(data);
    expect(result.closed).toBe(true);
    expect(result.text).toMatch(/^HTTP\/1\.1 400/);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe('并发与转发', () => {
  it('同一令牌同时进行的请求超过上限 → 429；其他令牌不受影响；请求结束后恢复', async () => {
    const release: Array<() => void> = [];
    upstream.setHandler((_request, response) => {
      release.push(() => response.end('{}'));
    });
    try {
      const first = send({ headers: auth() });
      const second = send({ headers: auth() });
      while (upstream.requests.length < 2) await sleep(10);
      const third = await send({ headers: auth() });
      expect(third.status).toBe(429);
      const other = send({ headers: auth(generateAgentToken()) });
      while (upstream.requests.length < 3) await sleep(10);
      release.splice(0).forEach((done) => done());
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect((await other).status).toBe(200);
      expect(upstream.requests).toHaveLength(3);
      upstream.setHandler((_request, response) => response.end('{}'));
      expect((await send({ headers: auth() })).status).toBe(200);
    } finally {
      release.forEach((done) => done());
      upstream.setHandler((_request, response) => response.end('{}'));
    }
  });

  it('流式响应不缓冲：worker 发出第一块后沙箱立即收到', async () => {
    let finish: (() => void) | undefined;
    upstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      finish = () => response.end('data: [DONE]\n\n');
    });
    try {
      const first = await new Promise<{ chunk: string; response: IncomingMessage }>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port: gatewayPort, path: '/v1/session', headers: auth(), agent: false }, (response) => {
          response.once('data', (chunk: Buffer) => resolve({ chunk: chunk.toString('utf8'), response }));
        });
        request.on('error', reject);
        request.end();
      });
      expect(first.chunk).toBe('data: first\n\n');
      expect(first.response.headers['content-type']).toBe('text/event-stream');
      const rest: Buffer[] = [];
      first.response.on('data', (chunk: Buffer) => rest.push(chunk));
      const ended = new Promise((resolve) => first.response.on('end', resolve));
      finish!();
      await ended;
      expect(Buffer.concat(rest).toString('utf8')).toBe('data: [DONE]\n\n');
    } finally {
      upstream.setHandler((_request, response) => response.end('{}'));
    }
  });

  it('沙箱中途断开：转给 worker 的请求随之中止', async () => {
    upstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port: gatewayPort, path: '/v1/session', headers: auth(), agent: false }, (response) => {
          response.once('data', () => {
            request.destroy();
            resolve();
          });
        });
        request.on('error', () => undefined);
        request.end();
        setTimeout(() => reject(new Error('no data')), 2_000);
      });
      const deadline = Date.now() + 2_000;
      while (upstream.closed.length === 0 && Date.now() < deadline) await sleep(10);
      expect(upstream.closed).toEqual(['/v1/session']);
    } finally {
      upstream.setHandler((_request, response) => response.end('{}'));
    }
  });

  it('worker 响应超过转发时限：尚未响应时 504，转给 worker 的请求被中止', async () => {
    upstream.setHandler(() => undefined);
    try {
      const started = Date.now();
      const response = await send({ headers: auth() });
      expect(response.status).toBe(504);
      expect(Date.now() - started).toBeLessThan(3_000);
      const deadline = Date.now() + 1_000;
      while (upstream.closed.length === 0 && Date.now() < deadline) await sleep(10);
      expect(upstream.closed).toEqual(['/v1/session']);
    } finally {
      upstream.setHandler((_request, response) => response.end('{}'));
    }
  });

  it('worker 不可用 → 502，不回显内部地址', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const dead = await startGateway({ upstream: `http://127.0.0.1:${deadPort}` });
    try {
      const response = await send({ headers: auth(), port: dead.port });
      expect(response.status).toBe(502);
      expect(response.body).not.toContain('127.0.0.1');
      expect(response.body).not.toContain(String(deadPort));
    } finally {
      await dead.app.close();
    }
  });
});

describe('日志', () => {
  it('只记令牌哈希前缀，不记令牌原文与请求体', async () => {
    const body = '{"secret_prompt":"招标文件内容"}';
    await send({ headers: auth() });
    await send({ method: 'POST', path: '/v1/test-echo', headers: { ...auth(), 'content-type': 'application/json' }, body });
    await send({ headers: { authorization: `Bearer ${token.slice(0, -1)}` } });
    const text = logs.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.slice(4, 20));
    expect(text).not.toContain('secret_prompt');
    expect(text).not.toContain(RELAY_KEY);
    const logId = agentTokenLogId(hashAgentToken(token));
    const lines = logs.lines().filter((line) => line.msg === 'agent request');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.filter((line) => line.tokenId === logId)).toHaveLength(2);
  });
});

describe('构建参数', () => {
  it.each(['https://worker:3200', 'http://worker:3200/v1', 'http://u:p@worker:3200'])('拒绝不合法的上游：%s', async (value) => {
    await expect(buildAgentGateway({ upstream: value, relayKey: RELAY_KEY, logLevel: 'silent' })).rejects.toThrow(TypeError);
  });

  it.each(['', 'short-key'])('拒绝过短的中继密钥：%j', async (relayKey) => {
    await expect(buildAgentGateway({ upstream: 'http://worker:3200', relayKey, logLevel: 'silent' })).rejects.toThrow(TypeError);
  });
});
