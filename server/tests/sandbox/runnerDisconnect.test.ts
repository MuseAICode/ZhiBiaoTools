// sandbox-runner 流式放入在连接异常时的收尾（路线图第 7 步 7.4a 的流式转发；#65 排查 runnerApp.test.ts 偶发挂住时补充）。
// 用原始的 node:http 客户端精确制造各种情况，核对 runner 一侧：请求的处理在限定时间内结束、driver 读请求流的循环结束（不挂在
// 读取上）、driver 收到的中止信号在客户端断开时触发、连接被关闭（不保持在只读不处理的状态）。
// - 请求体发到一半时客户端销毁连接；
// - 请求体发到一半时客户端只关闭写方向（FIN，声明的长度没有发完）；
// - 请求体中途不合规（runner 回 400 并关闭连接）之后客户端继续发送；
// - 声明的长度超过模板上限（不读请求体就回 400）之后客户端继续发送；
// - 客户端停住不发也不关闭：放入的空闲超时（inputIdleTimeoutMs）到期后结束；慢但持续发送的客户端不受影响。
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { maxArchiveBytes, validateArchiveStream } from '../../src/sandbox/archive.ts';
import type { DockerSandboxDriver } from '../../src/sandbox/docker.ts';
import type { DockerApi } from '../../src/sandbox/dockerApi.ts';
import { SandboxError, type SandboxRef } from '../../src/sandbox/driver.ts';
import { buildSandboxRunnerApp, SANDBOX_JOB_HEADER } from '../../src/sandbox/runnerApp.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { createLogCapture } from '../helpers.ts';
import { END_OF_ARCHIVE, tarEntry } from './tarFixtures.ts';

const TOKEN = 'runner-token-'.padEnd(48, 'x');
const JOB_ID = '7d3c9b0e-1f2a-4b5c-8d6e-0f1a2b3c4d5e';
const SANDBOX_ID = '11111111-2222-4333-8444-555555555555';
const MIB = 1024 * 1024;
/** 每种情况下 runner 收尾的时限：远小于 vitest 的 hook 超时，远大于正常的处理时间。 */
const SETTLE_MS = 3_000;
/** 测试中放入的空闲超时（生产默认 60 秒）。 */
const INPUT_IDLE_MS = 500;

interface CopyInRecord {
  /** driver 读请求流的循环已结束（正常读完、出错或被中止）。 */
  settled: boolean;
  /** 循环结束的方式。 */
  outcome: 'completed' | 'stream-error' | 'pending';
  /** 中止信号是否触发。 */
  aborted: boolean;
  bytes: number;
}

function fakeDriver() {
  const records: CopyInRecord[] = [];
  const ref: SandboxRef = Object.freeze({ id: SANDBOX_ID, template: 'parse', jobId: JOB_ID, expiresAt: new Date('2030-01-01T00:00:00Z') });
  const driver = {
    async lookup(id: string, jobId: string) {
      if (id !== SANDBOX_ID || jobId !== JOB_ID) throw new SandboxError('SANDBOX_NOT_FOUND', '沙箱不存在');
      return ref;
    },
    async copyInArchive(sandbox: SandboxRef, archive: Buffer | AsyncIterable<Buffer>, options: { signal?: AbortSignal } = {}) {
      const record: CopyInRecord = { settled: false, outcome: 'pending', aborted: false, bytes: 0 };
      records.push(record);
      options.signal?.addEventListener('abort', () => {
        record.aborted = true;
      }, { once: true });
      try {
        // 与真实 driver 相同：边读边按模板的输入规则校验。
        for await (const chunk of validateArchiveStream(Buffer.isBuffer(archive) ? Readable.from([archive]) : archive, SANDBOX_TEMPLATES[sandbox.template].input)) {
          record.bytes += chunk.length;
        }
        record.outcome = 'completed';
      } catch (error) {
        record.outcome = 'stream-error';
        if (error instanceof SandboxError) throw error;
        throw new SandboxError('SANDBOX_BAD_REQUEST', '输入文件不符合沙箱规则', { cause: error });
      } finally {
        record.settled = true;
      }
    },
  } as unknown as DockerSandboxDriver;
  return { driver, records };
}

const fakeDocker = { ping: async () => {}, runtimes: async () => ['runc', 'runsc'] } as unknown as DockerApi;

let app: FastifyInstance;
let port: number;
let fake: ReturnType<typeof fakeDriver>;
const inFlight = new Map<string, string>();
const sockets = new Set<Socket>();

beforeAll(async () => {
  fake = fakeDriver();
  app = await buildSandboxRunnerApp({
    driver: fake.driver, docker: fakeDocker, runtime: 'runsc', token: TOKEN, logLevel: 'info', logStream: createLogCapture().stream,
    // 停住的上传在 INPUT_IDLE_MS 内没有新数据即被结束（默认 60 秒，这里缩短以便测试）。
    inputIdleTimeoutMs: INPUT_IDLE_MS,
  });
  app.addHook('onRequest', async (request) => {
    inFlight.set(request.id, `${request.method} ${request.url}`);
  });
  app.addHook('onResponse', async (request) => {
    inFlight.delete(request.id);
  });
  app.addHook('onRequestAbort', async (request) => {
    inFlight.delete(request.id);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(() => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
});

afterAll(async () => {
  await app.close();
});

/** 打开一个原始连接，发出放入归档的请求头（声明 length 字节的请求体）。 */
async function openUpload(length: number): Promise<{ socket: Socket; response: Promise<string>; closed: Promise<void> }> {
  const socket = connect(port, '127.0.0.1');
  sockets.add(socket);
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  socket.on('error', () => {});
  let received = '';
  const response = new Promise<string>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
      if (received.includes('\r\n\r\n')) resolve(received.split('\r\n')[0]!);
    });
    socket.once('close', () => resolve(received.split('\r\n')[0] ?? ''));
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.write([
    `PUT /v1/sandboxes/${SANDBOX_ID}/input HTTP/1.1`,
    `host: 127.0.0.1:${port}`,
    `authorization: Bearer ${TOKEN}`,
    `${SANDBOX_JOB_HEADER}: ${JOB_ID}`,
    'content-type: application/x-tar',
    `content-length: ${length}`,
    '',
    '',
  ].join('\r\n'));
  return { socket, response, closed };
}

/** 等到 runner 中没有仍在处理的请求、driver 的读取都已结束；超时返回仍未结束的情况。 */
async function settled(): Promise<{ inFlight: string[]; pendingCopyIns: number }> {
  const deadline = Date.now() + SETTLE_MS;
  const state = () => ({ inFlight: [...inFlight.values()], pendingCopyIns: fake.records.filter((record) => !record.settled).length });
  while (Date.now() < deadline) {
    const current = state();
    if (current.inFlight.length === 0 && current.pendingCopyIns === 0) return current;
    await sleep(20);
  }
  return state();
}

const GOOD = tarEntry({ name: 'a.docx', data: Buffer.alloc(4 * MIB, 1) });

describe('sandbox-runner streaming input when the connection misbehaves', () => {
  it('the client destroys the connection halfway through the body: the read ends, the driver is aborted', async () => {
    const before = fake.records.length;
    const { socket } = await openUpload(GOOD.length + END_OF_ARCHIVE.length);
    socket.write(GOOD.subarray(0, MIB));
    while (fake.records.length === before) await sleep(5);
    socket.destroy();
    expect(await settled()).toEqual({ inFlight: [], pendingCopyIns: 0 });
    const record = fake.records.at(-1)!;
    expect(record.outcome).toBe('stream-error');
    expect(record.aborted).toBe(true);
  });

  it('the client half-closes (FIN) before sending the declared length: the read ends, the connection closes', async () => {
    const before = fake.records.length;
    const { socket, closed } = await openUpload(GOOD.length + END_OF_ARCHIVE.length);
    socket.write(GOOD.subarray(0, MIB));
    while (fake.records.length === before) await sleep(5);
    socket.end();
    expect(await settled()).toEqual({ inFlight: [], pendingCopyIns: 0 });
    expect(fake.records.at(-1)!.outcome).toBe('stream-error');
    await expect(Promise.race([closed.then(() => 'closed'), sleep(SETTLE_MS).then(() => 'still open')])).resolves.toBe('closed');
  });

  it('the body turns invalid midway and the client keeps sending: 400, then the runner closes the connection', async () => {
    const bad = tarEntry({ name: 'x', type: '2', linkname: '/etc/passwd' });
    const { socket, response, closed } = await openUpload(64 * MIB);
    socket.write(Buffer.concat([tarEntry({ name: 'a.docx', data: Buffer.from('PK') }), bad]));
    // 客户端不理会响应，继续发送（直到连接被关闭）。
    const zeros = Buffer.alloc(MIB);
    let sent = 0;
    const pump = (async () => {
      while (!socket.destroyed && sent < 64 * MIB) {
        if (!socket.write(zeros)) await new Promise((resolve) => socket.once('drain', resolve).once('close', resolve));
        sent += zeros.length;
      }
    })();
    expect(await response).toMatch(/^HTTP\/1\.1 400 /);
    await expect(Promise.race([closed.then(() => 'closed'), sleep(SETTLE_MS).then(() => 'still open')])).resolves.toBe('closed');
    await pump;
    expect(await settled()).toEqual({ inFlight: [], pendingCopyIns: 0 });
    expect(sent).toBeLessThan(64 * MIB);
  });

  it('a declared length over the template limit: 400 without reading, then the runner closes the connection while the client keeps sending', async () => {
    const before = fake.records.length;
    const { socket, response, closed } = await openUpload(maxArchiveBytes(SANDBOX_TEMPLATES.parse.input) + 1);
    const zeros = Buffer.alloc(MIB);
    let sent = 0;
    const pump = (async () => {
      while (!socket.destroyed && sent < 512 * MIB) {
        if (!socket.write(zeros)) await new Promise((resolve) => socket.once('drain', resolve).once('close', resolve));
        sent += zeros.length;
      }
    })();
    expect(await response).toMatch(/^HTTP\/1\.1 400 /);
    await expect(Promise.race([closed.then(() => 'closed'), sleep(SETTLE_MS).then(() => 'still open')])).resolves.toBe('closed');
    await pump;
    expect(await settled()).toEqual({ inFlight: [], pendingCopyIns: 0 });
    expect(fake.records.length).toBe(before);
    expect(sent).toBeLessThan(512 * MIB);
  });

  it('the client stalls without sending or closing: after the idle timeout the read ends, the driver is aborted, the connection closes', async () => {
    const before = fake.records.length;
    const { socket, closed } = await openUpload(GOOD.length + END_OF_ARCHIVE.length);
    socket.write(GOOD.subarray(0, MIB));
    while (fake.records.length === before) await sleep(5);
    const stalledAt = Date.now();
    expect(await settled()).toEqual({ inFlight: [], pendingCopyIns: 0 });
    const record = fake.records.at(-1)!;
    expect(record.outcome).toBe('stream-error');
    expect(record.aborted).toBe(true);
    await expect(Promise.race([closed.then(() => 'closed'), sleep(SETTLE_MS).then(() => 'still open')])).resolves.toBe('closed');
    expect(Date.now() - stalledAt).toBeGreaterThanOrEqual(INPUT_IDLE_MS - 50);
  });

  it('a slow but steady client is not cut off: every gap is below the idle timeout', async () => {
    const before = fake.records.length;
    const body = Buffer.concat([GOOD, END_OF_ARCHIVE]);
    const { socket, response } = await openUpload(body.length);
    const parts = 6;
    const size = Math.ceil(body.length / parts);
    for (let index = 0; index < parts; index += 1) {
      socket.write(body.subarray(index * size, (index + 1) * size));
      await sleep(INPUT_IDLE_MS / 2);
    }
    expect(await response).toMatch(/^HTTP\/1\.1 204 /);
    expect(await settled()).toEqual({ inFlight: [], pendingCopyIns: 0 });
    expect(fake.records.length).toBe(before + 1);
    expect(fake.records.at(-1)).toMatchObject({ outcome: 'completed', aborted: false, bytes: body.length });
  });
});
