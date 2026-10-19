// 模拟的 OpenAI 兼容模型服务商（CI 中不使用真实 Key、不访问外网）。监听 127.0.0.1 的随机端口，
// 每个请求交给测试设置的 handler 处理；默认校验 Authorization 并按 SSE 流式返回固定内容和用量。
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

export type MockHandler = (request: MockRequest, response: http.ServerResponse) => void | Promise<void>;

export interface MockProvider {
  /** http://127.0.0.1:<port>/v1 */
  readonly baseUrl: string;
  readonly requests: MockRequest[];
  setHandler(handler: MockHandler): void;
  reset(): void;
  close(): Promise<void>;
}

export function sseChunk(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

export interface StreamOptions {
  pieces?: string[];
  usage?: Record<string, unknown> | null;
  /** 每段之间的间隔（毫秒）。 */
  delayMs?: number;
  /** 发出 [DONE] 之前等待的 Promise，用于在调用进行中检查冻结。 */
  beforeDone?: Promise<void>;
}

/** 按 OpenAI 兼容格式流式返回：若干内容块、带 finish_reason 的块、用量块、[DONE]。 */
export async function streamCompletion(response: http.ServerResponse, options: StreamOptions = {}): Promise<void> {
  const pieces = options.pieces ?? ['你好', '，世界'];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const piece of pieces) {
    response.write(sseChunk({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  response.write(sseChunk({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  if (options.beforeDone) await options.beforeDone;
  if (options.usage !== null) {
    response.write(sseChunk({ id: 'c1', choices: [], usage: options.usage ?? { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } }));
  }
  response.end(sseChunk('[DONE]'));
}

export async function startMockProvider(expectedApiKey: string): Promise<MockProvider> {
  const defaultHandler: MockHandler = async (request, response) => {
    if (request.authorization !== `Bearer ${expectedApiKey}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } }));
      return;
    }
    await streamCompletion(response);
  };
  let handler = defaultHandler;
  const requests: MockRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request: MockRequest = { path: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(raw || '{}') };
    requests.push(request);
    try {
      await handler(request, res);
    } catch {
      res.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setHandler(next) {
      handler = next;
    },
    reset() {
      handler = defaultHandler;
      requests.length = 0;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
