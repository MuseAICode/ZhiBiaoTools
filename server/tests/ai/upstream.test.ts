// 上游 HTTP 客户端（src/ai/upstream.ts）：出站地址校验、不跟随重定向、SSE 解析、错误不带 Key 和响应体；
// 服务商适配（用量字段）和 token 上界估算。全部对本机的模拟服务商，不访问外网。
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { estimateTokens, inputTokenUpperBound } from '../../src/ai/estimate.ts';
import { PROVIDER_ADAPTERS } from '../../src/ai/providers.ts';
import { isBlockedAddress, streamChatCompletion, UpstreamAbortedError, UpstreamError, type UpstreamRequest } from '../../src/ai/upstream.ts';
import { sseChunk, startMockProvider, streamCompletion, type MockProvider } from './mockProvider.ts';

const API_KEY = 'sk-upstream-test-key-7f3a9c';
let provider: MockProvider;

beforeAll(async () => {
  provider = await startMockProvider(API_KEY);
});

afterAll(async () => {
  await provider.close();
});

beforeEach(() => provider.reset());

function request(overrides: Partial<UpstreamRequest> = {}): UpstreamRequest {
  return {
    baseUrl: provider.baseUrl,
    path: '/chat/completions',
    apiKey: API_KEY,
    body: { model: 'm', messages: [] },
    signal: new AbortController().signal,
    isTimeout: () => false,
    privateHosts: ['127.0.0.1'],
    maxResponseBytes: 1024 * 1024,
    ...overrides,
  };
}

async function collect(req: UpstreamRequest) {
  const events: Record<string, unknown>[] = [];
  const generator = streamChatCompletion(req);
  let step = await generator.next();
  while (!step.done) {
    events.push(step.value);
    step = await generator.next();
  }
  return { events, done: step.value.done };
}

async function failure(req: UpstreamRequest): Promise<unknown> {
  try {
    await collect(req);
  } catch (error) {
    return error;
  }
  throw new Error('应当失败');
}

describe('出站地址校验', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2001:db8::1',
    'not-an-ip',
  ])('%s 被拒绝', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '47.88.1.1', '2606:4700:4700::1111', '2400:3200::1'])('%s 允许', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('不在 AI_UPSTREAM_PRIVATE_HOSTS 中时，内网 IP 字面量和解析到内网的主机名都被拒绝，不发出请求', async () => {
    const port = new URL(provider.baseUrl).port;
    for (const baseUrl of [`https://127.0.0.1:${port}/v1`, `https://localhost:${port}/v1`, `https://[::1]:${port}/v1`]) {
      const error = await failure(request({ baseUrl, privateHosts: [] }));
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).reason).toBe('upstream_unreachable');
    }
    expect(provider.requests).toHaveLength(0);
  });

  it('http 只允许 AI_UPSTREAM_PRIVATE_HOSTS 中的主机', async () => {
    const error = await failure(request({ privateHosts: [] }));
    expect((error as UpstreamError).reason).toBe('upstream_unreachable');
    expect(provider.requests).toHaveLength(0);
  });

  it('不跟随重定向', async () => {
    provider.setHandler((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    const error = await failure(request());
    expect(error).toMatchObject({ reason: 'upstream_error', status: 302 });
    expect(provider.requests).toHaveLength(1);
  });
});

describe('流式响应', () => {
  it('带上 Key 请求，逐个产出 data 事件，[DONE] 结束', async () => {
    const { events, done } = await collect(request());
    expect(provider.requests[0]).toMatchObject({ path: '/v1/chat/completions', authorization: `Bearer ${API_KEY}` });
    expect(done).toBe(true);
    expect(events.at(-1)).toMatchObject({ usage: { prompt_tokens: 1000, completion_tokens: 500 } });
  });

  it('事件被拆在多个 TCP 块中、带 \\r\\n 和注释行时也能正确解析', async () => {
    provider.setHandler(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = `: keep-alive\r\n\r\nevent: message\r\n${sseChunk({ choices: [{ delta: { content: '分段' } }] }).replace('\n\n', '\r\n\r\n')}${sseChunk('[DONE]')}`;
      for (let i = 0; i < text.length; i += 7) {
        res.write(text.slice(i, i + 7));
        await new Promise((resolve) => setImmediate(resolve));
      }
      res.end();
    });
    const { events, done } = await collect(request());
    expect(events).toEqual([{ choices: [{ delta: { content: '分段' } }] }]);
    expect(done).toBe(true);
  });

  it('没有 [DONE] 就结束时报告未完成，由调用方判断', async () => {
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseChunk({ choices: [{ delta: { content: 'x' } }] }));
    });
    expect((await collect(request())).done).toBe(false);
  });

  it.each([
    ['非 JSON 的 data', 'data: {oops\n\n'],
    ['data 不是对象', 'data: [1,2]\n\n'],
  ])('%s：invalid_upstream_response', async (_name, body) => {
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    expect(await failure(request())).toMatchObject({ reason: 'invalid_upstream_response' });
  });

  it('响应超过上限时中止：invalid_upstream_response', async () => {
    provider.setHandler((_req, res) => streamCompletion(res, { pieces: Array.from({ length: 200 }, () => 'x'.repeat(100)) }));
    expect(await failure(request({ maxResponseBytes: 4096 }))).toMatchObject({ reason: 'invalid_upstream_response' });
  });

  it('连接中途断开：upstream_unreachable', async () => {
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk({ choices: [{ delta: { content: 'x' } }] }));
      setTimeout(() => res.socket?.destroy(), 20);
    });
    expect(await failure(request())).toMatchObject({ reason: 'upstream_unreachable' });
  });

  it('连接被拒绝：upstream_unreachable，错误中不含主机和端口', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    const error = await failure(request({ baseUrl: `http://127.0.0.1:${port}/v1` }));
    expect(error).toMatchObject({ reason: 'upstream_unreachable' });
    expect((error as Error).message).not.toContain(String(port));
  });

  it('超时与调用方取消分别报告', async () => {
    provider.setHandler(() => undefined);
    const timeout = new AbortController();
    setTimeout(() => timeout.abort(), 50);
    expect(await failure(request({ signal: timeout.signal, isTimeout: () => true }))).toMatchObject({ reason: 'upstream_timeout' });

    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 50);
    expect(await failure(request({ signal: cancel.signal }))).toBeInstanceOf(UpstreamAbortedError);
  });

  it('服务商返回错误：只保留状态码和规整过的错误码，不含响应体、请求头里的 Key', async () => {
    provider.setHandler((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      // 有的服务商会在错误消息里回显 Key。
      res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${req.authorization}` } }));
    });
    const error = await failure(request());
    expect(error).toMatchObject({ reason: 'upstream_error', status: 401, upstreamCode: 'invalid_api_key' });
    const text = `${(error as Error).message} ${(error as Error).stack} ${JSON.stringify(error)}`;
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain('Incorrect API key');

    provider.setHandler((_req, res) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { code: `<script>${API_KEY}</script>` } }));
    });
    const sanitized = await failure(request());
    expect((sanitized as UpstreamError).upstreamCode).toBeUndefined();
  });
});

describe('服务商适配', () => {
  it('请求体：流式、带 max_tokens 和 include_usage，消息只保留 role 和 content', () => {
    for (const adapter of Object.values(PROVIDER_ADAPTERS)) {
      const body = adapter.buildBody({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '你好', extra: 'x' } as never],
        maxOutputTokens: 1024,
        temperature: undefined,
      });
      expect(body).toEqual({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 1024,
        stream: true,
        stream_options: { include_usage: true },
      });
    }
  });

  it('DeepSeek 的缓存命中 token 在 prompt_cache_hit_tokens，通义千问在 prompt_tokens_details.cached_tokens', () => {
    expect(PROVIDER_ADAPTERS.deepseek.parseUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 64 })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 64,
    });
    expect(PROVIDER_ADAPTERS.qwen.parseUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 32 } })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 32,
    });
  });

  it('用量缺失或不合法时返回 null（改用本地估算）', () => {
    for (const usage of [null, {}, { prompt_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: 1.5, completion_tokens: 1 }, { prompt_tokens: '1', completion_tokens: 1 }]) {
      expect(PROVIDER_ADAPTERS.deepseek.parseUsage(usage)).toBeNull();
    }
    // 缓存 token 不会超过输入 token。
    expect(PROVIDER_ADAPTERS.deepseek.parseUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 99 })?.cachedInputTokens).toBe(10);
  });
});

describe('token 估算', () => {
  it('输入上界不小于 UTF-8 字节数（字节级 BPE 每个 token 至少 1 字节）', () => {
    const messages = [
      { role: 'system' as const, content: '你是投标助手。' },
      { role: 'user' as const, content: 'Hello, 世界！🙂'.repeat(100) },
    ];
    const bytes = messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
    expect(inputTokenUpperBound(messages)).toBeGreaterThan(bytes);
  });

  it('本地估算：中日韩字符 1 个 token，其他字符 4 个一组', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abc你好')).toBe(3);
  });
});
