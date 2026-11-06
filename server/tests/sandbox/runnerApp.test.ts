import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSandboxRunnerClient } from '../../src/sandbox/client.ts';
import type { DockerSandboxDriver } from '../../src/sandbox/docker.ts';
import type { DockerApi } from '../../src/sandbox/dockerApi.ts';
import { SandboxError, type SandboxDriver, type SandboxRef } from '../../src/sandbox/driver.ts';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createArchive, maxArchiveBytes, validateArchiveStream } from '../../src/sandbox/archive.ts';
import { buildSandboxRunnerApp } from '../../src/sandbox/runnerApp.ts';
import { resolveCommand, SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { createLogCapture } from '../helpers.ts';
import { END_OF_ARCHIVE, tarEntry } from './tarFixtures.ts';

const TOKEN = 'runner-token-'.padEnd(48, 'x');
const JOB_ID = '7d3c9b0e-1f2a-4b5c-8d6e-0f1a2b3c4d5e';
const OTHER_JOB = '00000000-0000-4000-8000-000000000001';
const SANDBOX_ID = '11111111-2222-4333-8444-555555555555';
/** export-document 模板的沙箱（输入至多 128 MiB），用于大请求体。 */
const EXPORT_IDS = Array.from({ length: 4 }, (_, index) => `22222222-2222-4333-8444-55555555555${index}`);

/** 不访问 Docker 的 driver 桩：只认 SANDBOX_ID + JOB_ID，记录调用。 */
function fakeDriver() {
  const calls: string[] = [];
  let output: Buffer = Buffer.concat([tarEntry({ name: 'content.md', data: Buffer.from('ok') }), END_OF_ARCHIVE]);
  const ref: SandboxRef = Object.freeze({ id: SANDBOX_ID, template: 'parse', jobId: JOB_ID, expiresAt: new Date('2030-01-01T00:00:00Z') });
  /** 每个沙箱收到（通过校验、转给“tar”）的字节数与 SHA-256。 */
  const received = new Map<string, { bytes: number; sha256: string }>();
  /** 模拟沙箱内 tar 的写入速度：每转出这么多字节让出一次事件循环。 */
  let consumeDelayEvery = 0;
  const driver: DockerSandboxDriver = {
    async create(template, options) {
      calls.push(`create:${template}:${options.jobId}`);
      return { ...ref, jobId: options.jobId };
    },
    async copyIn() {
      throw new Error('not used');
    },
    async copyInArchive(sandbox, archive) {
      calls.push(`copyIn:${sandbox.id}`);
      // 与真实 driver 相同：边读边按模板的输入规则检查，只转出通过校验的字节，不符为 SANDBOX_BAD_REQUEST。
      const hash = createHash('sha256');
      let bytes = 0;
      let sinceDelay = 0;
      try {
        for await (const chunk of validateArchiveStream(Buffer.isBuffer(archive) ? Readable.from([archive]) : archive, SANDBOX_TEMPLATES[sandbox.template].input)) {
          hash.update(chunk);
          bytes += chunk.length;
          sinceDelay += chunk.length;
          if (consumeDelayEvery > 0 && sinceDelay >= consumeDelayEvery) {
            sinceDelay = 0;
            await sleep(1);
          }
        }
      } catch (error) {
        throw new SandboxError('SANDBOX_BAD_REQUEST', '输入文件不符合沙箱规则', { cause: error });
      }
      received.set(sandbox.id, { bytes, sha256: hash.digest('hex') });
    },
    async exec(sandbox, command, args) {
      if (!resolveCommand(SANDBOX_TEMPLATES.parse, command, args)) throw new SandboxError('SANDBOX_BAD_REQUEST', '沙箱命令或参数不合法');
      calls.push(`exec:${sandbox.id}:${command}:${args.join(',')}`);
      return { exitCode: 0, timedOut: false, stdout: 'done', stderr: '', stdoutTruncated: false, stderrTruncated: false };
    },
    async copyOut() {
      throw new Error('not used');
    },
    async copyOutRaw(sandbox) {
      calls.push(`copyOut:${sandbox.id}`);
      return Readable.from([output]);
    },
    async execArgv() {
      throw new Error('must not be reachable over http');
    },
    async lookup(id, jobId) {
      if (jobId !== JOB_ID) throw new SandboxError('SANDBOX_NOT_FOUND', '沙箱不存在');
      if (id === SANDBOX_ID) return ref;
      if (EXPORT_IDS.includes(id)) return { ...ref, id, template: 'export-document' };
      throw new SandboxError('SANDBOX_NOT_FOUND', '沙箱不存在');
    },
    async destroy(sandbox) {
      calls.push(`destroy:${sandbox.id}:${sandbox.jobId}`);
    },
    async sweep() {
      return 0;
    },
  };
  return {
    driver,
    calls,
    received,
    setOutput(value: Buffer) {
      output = value;
    },
    setConsumeDelay(every: number) {
      consumeDelayEvery = every;
    },
  };
}

const fakeDocker = { ping: async () => {}, runtimes: async () => ['runc', 'runsc'] } as unknown as DockerApi;

describe('sandbox-runner http api', () => {
  let app: FastifyInstance;
  let fake: ReturnType<typeof fakeDriver>;
  let client: SandboxDriver;
  const logs = createLogCapture();

  beforeAll(async () => {
    fake = fakeDriver();
    app = await buildSandboxRunnerApp({ driver: fake.driver, docker: fakeDocker, runtime: 'runsc', token: TOKEN, logLevel: 'info', logStream: logs.stream });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as { port: number };
    client = createSandboxRunnerClient({ url: `http://127.0.0.1:${address.port}`, token: TOKEN });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    fake.calls.length = 0;
    fake.received.clear();
    fake.setConsumeDelay(0);
    fake.setOutput(Buffer.concat([tarEntry({ name: 'content.md', data: Buffer.from('ok') }), END_OF_ARCHIVE]));
  });

  const auth = { authorization: `Bearer ${TOKEN}` };
  const job = { 'x-sandbox-job': JOB_ID };

  it('requires the shared token on every sandbox route but not on health checks', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }, { authorization: `Bearer ${TOKEN}x` }]) {
      const response = await app.inject({ method: 'POST', url: '/v1/sandboxes', headers, payload: { template: 'parse', jobId: JOB_ID } });
      expect(response.statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'GET', url: `/v1/sandboxes/${SANDBOX_ID}/output`, headers: job })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `/v1/sandboxes/${SANDBOX_ID}`, headers: job })).statusCode).toBe(401);
    expect(fake.calls).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).json()).toEqual({ status: 'ok' });
    expect(logs.text()).not.toContain(TOKEN);
  });

  it('only accepts a template name and a job id when creating', async () => {
    const create = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/sandboxes', headers: auth, payload: payload as object });
    for (const payload of [
      { template: 'parse', jobId: JOB_ID, image: 'alpine' },
      { template: 'parse', jobId: JOB_ID, binds: ['/:/host'] },
      { template: 'parse', jobId: JOB_ID, network: 'host' },
      { template: 'agent', jobId: JOB_ID },
      { template: 'parse', jobId: 'not-a-uuid' },
      { template: 'parse' },
    ]) {
      expect((await create(payload)).statusCode).toBe(400);
    }
    expect(fake.calls).toEqual([]);
    const response = await create({ template: 'parse', jobId: JOB_ID });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: SANDBOX_ID, template: 'parse', jobId: JOB_ID });
  });

  it('only runs commands registered in the template', async () => {
    const exec = (payload: unknown, headers: Record<string, string> = { ...auth, ...job }) =>
      app.inject({ method: 'POST', url: `/v1/sandboxes/${SANDBOX_ID}/exec`, headers, payload: payload as object });
    expect((await exec({ command: 'sh', args: ['-c', 'id'] })).json().error.code).toBe('SANDBOX_BAD_REQUEST');
    expect((await exec({ command: 'parse', args: ['$(id)'] })).statusCode).toBe(400);
    expect((await exec({ command: 'parse', args: [], argv: ['sh'] })).statusCode).toBe(400);
    expect((await exec({ command: 'parse', args: [] }, { ...auth, 'x-sandbox-job': OTHER_JOB })).statusCode).toBe(404);
    expect((await exec({ command: 'parse', args: [] }, auth)).statusCode).toBe(400);
    const ok = await exec({ command: 'parse', args: ['docx'] });
    expect(ok.statusCode).toBe(200);
    expect(fake.calls).toEqual([`exec:${SANDBOX_ID}:parse:docx`]);
  });

  it('rejects input archives that are not plain files', async () => {
    const archive = Buffer.concat([tarEntry({ name: 'x', type: '2', linkname: '/etc/passwd' }), END_OF_ARCHIVE]);
    const response = await app.inject({ method: 'PUT', url: `/v1/sandboxes/${SANDBOX_ID}/input`, headers: { ...auth, ...job, 'content-type': 'application/x-tar' }, payload: archive });
    expect(response.statusCode).toBe(400);
    const json = await app.inject({ method: 'PUT', url: `/v1/sandboxes/${SANDBOX_ID}/input`, headers: { ...auth, ...job }, payload: { a: 1 } });
    expect(json.statusCode).toBe(415);
  });

  const MIB = 1024 * 1024;
  const inputUrl = (id: string) => {
    const address = app.server.address() as { port: number };
    return `http://127.0.0.1:${address.port}/v1/sandboxes/${id}/input`;
  };
  /** 用流式请求体放入归档（不带 Content-Length），模拟不在内存中整体生成归档的调用方。 */
  const putStream = (id: string, source: AsyncIterable<Uint8Array>) =>
    fetch(inputUrl(id), {
      method: 'PUT',
      headers: { ...auth, ...job, 'content-type': 'application/x-tar' },
      body: ReadableStream.from(source) as unknown as RequestInit['body'],
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  /** 一个归档：count 个 size 字节的文件，内容由同一块缓冲区重复组成（生成方本身几乎不占内存）；返回字节流与它的 SHA-256。 */
  function generatedArchive(count: number, size: number, fill: number) {
    const block = Buffer.alloc(MIB, fill);
    const hash = createHash('sha256');
    let total = 0;
    async function* source() {
      for (let index = 0; index < count; index += 1) {
        const header = createArchive([{ path: `assets/image-${index}.png`, data: Buffer.alloc(0) }], SANDBOX_TEMPLATES['export-document'].input).subarray(0, 512);
        // 改写头部中的大小与校验和。
        header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
        header.fill(0x20, 148, 156);
        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
        hash.update(header);
        total += 512;
        yield header;
        for (let sent = 0; sent < size; sent += MIB) {
          const chunk = block.subarray(0, Math.min(MIB, size - sent));
          hash.update(chunk);
          total += chunk.length;
          yield chunk;
        }
        const padding = (512 - (size % 512)) % 512;
        if (padding > 0) {
          hash.update(Buffer.alloc(padding));
          total += padding;
          yield Buffer.alloc(padding);
        }
      }
      hash.update(END_OF_ARCHIVE);
      total += END_OF_ARCHIVE.length;
      yield END_OF_ARCHIVE;
    }
    return { source, expected: () => ({ bytes: total, sha256: hash.digest('hex') }) };
  }

  it('streams input archives past the JSON body limit and forwards exactly the validated bytes', async () => {
    const files = [
      { path: 'original.docx', data: Buffer.alloc(20 * MIB, 1) },
      { path: 'extra.bin', data: Buffer.alloc(3 * MIB + 17, 2) },
    ];
    const archive = createArchive(files, SANDBOX_TEMPLATES.parse.input);
    const ref = await client.create('parse', { jobId: JOB_ID });
    await client.copyIn(ref, files);
    expect(fake.received.get(SANDBOX_ID)).toEqual({ bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') });

    const generated = generatedArchive(2, 40 * MIB + 3, 9);
    const response = await putStream(EXPORT_IDS[0]!, generated.source());
    expect(response.status).toBe(204);
    expect(fake.received.get(EXPORT_IDS[0]!)).toEqual(generated.expected());
  });

  it('rejects a declared length over the template limit before touching the sandbox', async () => {
    const limit = maxArchiveBytes(SANDBOX_TEMPLATES.parse.input);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(inputUrl(SANDBOX_ID), {
        method: 'PUT',
        headers: { ...auth, ...job, 'content-type': 'application/x-tar', 'content-length': String(limit + 1) },
      });
      req.on('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
        req.destroy();
      });
      req.on('error', reject);
      req.write(Buffer.alloc(512));
    });
    expect(status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it('rejects an archive that turns invalid midway or grows past the template limit while streaming', async () => {
    const good = tarEntry({ name: 'a.docx', data: Buffer.from('PK') });
    const midway = await app.inject({
      method: 'PUT',
      url: `/v1/sandboxes/${SANDBOX_ID}/input`,
      headers: { ...auth, ...job, 'content-type': 'application/x-tar' },
      payload: Buffer.concat([good, tarEntry({ name: 'x', type: '2', linkname: '/etc/passwd' }), END_OF_ARCHIVE]),
    });
    expect(midway.statusCode).toBe(400);
    expect(midway.json().error.code).toBe('SANDBOX_BAD_REQUEST');
    expect(fake.received.has(SANDBOX_ID)).toBe(false);

    // 合规的归档之后不断追加数据：读入的字节数超过模板上限即拒绝，不再读取。
    const limit = maxArchiveBytes(SANDBOX_TEMPLATES.parse.input);
    let produced = 0;
    async function* endless() {
      yield Buffer.concat([good, END_OF_ARCHIVE]);
      const zeros = Buffer.alloc(MIB);
      while (produced < limit * 2) {
        produced += zeros.length;
        yield zeros;
      }
    }
    const response = await putStream(SANDBOX_ID, endless()).catch((error: unknown) => error);
    // 服务端发出 400 后关闭连接；客户端可能先看到 400，也可能因连接关闭而失败，两种情况都没有被接受。
    if (response instanceof Response) expect(response.status).toBe(400);
    else expect(response).toBeInstanceOf(Error);
    expect(fake.received.has(SANDBOX_ID)).toBe(false);
    expect(produced).toBeLessThan(limit + 64 * MIB);
  });

  it('keeps its memory flat while several large archives stream in concurrently', async () => {
    // 4 个并发请求、每个约 120 MiB（export-document 的输入上限 128 MiB 以内，合计约 480 MiB），“tar”写得比网络慢。
    // 整体缓存时内存至少增长约 480 MiB。
    fake.setConsumeDelay(4 * MIB);
    const uploads = EXPORT_IDS.map((_, index) => generatedArchive(3, 40 * MIB, index + 1));
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    try {
      const responses = await Promise.all(uploads.map((upload, index) => putStream(EXPORT_IDS[index]!, upload.source())));
      expect(responses.map((response) => response.status)).toEqual([204, 204, 204, 204]);
    } finally {
      clearInterval(sampler);
    }
    uploads.forEach((upload, index) => expect(fake.received.get(EXPORT_IDS[index]!)).toEqual(upload.expected()));
    expect(peak - baseline).toBeLessThan(200 * MIB);
  }, 120_000);

  it('round-trips through the client', async () => {
    const ref = await client.create('parse', { jobId: JOB_ID });
    await client.copyIn(ref, [{ path: 'original.docx', data: Buffer.from('PK') }]);
    expect((await client.exec(ref, 'parse', ['docx'])).stdout).toBe('done');
    const files = await client.copyOut(ref);
    expect(files.map((file) => [file.path, file.data.toString()])).toEqual([['content.md', 'ok']]);
    await client.destroy(ref);
    expect(fake.calls).toEqual([`create:parse:${JOB_ID}`, `copyIn:${SANDBOX_ID}`, `exec:${SANDBOX_ID}:parse:docx`, `copyOut:${SANDBOX_ID}`, `destroy:${SANDBOX_ID}:${JOB_ID}`]);
  });

  it('validates the output in the worker, not trusting the runner', async () => {
    const ref = await client.create('parse', { jobId: JOB_ID });
    fake.setOutput(Buffer.concat([tarEntry({ name: 'x.md', type: '2', linkname: '/etc/shadow' }), END_OF_ARCHIVE]));
    await expect(client.copyOut(ref)).rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' });
    fake.setOutput(Buffer.concat([tarEntry({ name: '../../x.md', data: Buffer.from('x') }), END_OF_ARCHIVE]));
    await expect(client.copyOut(ref)).rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' });
    fake.setOutput(tarEntry({ name: 'x.md', data: Buffer.from('x') }));
    await expect(client.copyOut(ref)).rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' });
  });

  it('maps runner errors to sandbox error codes and a wrong token to unavailable', async () => {
    await expect(client.exec({ id: SANDBOX_ID, template: 'parse', jobId: OTHER_JOB, expiresAt: new Date() }, 'parse', [])).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
    await expect(client.exec({ id: SANDBOX_ID, template: 'parse', jobId: JOB_ID, expiresAt: new Date() }, 'sh', [])).rejects.toMatchObject({ code: 'SANDBOX_BAD_REQUEST' });
    const address = app.server.address() as { port: number };
    const wrong = createSandboxRunnerClient({ url: `http://127.0.0.1:${address.port}`, token: 'x'.repeat(40) });
    await expect(wrong.create('parse', { jobId: JOB_ID })).rejects.toMatchObject({ code: 'SANDBOX_FAILED' });
    const down = createSandboxRunnerClient({ url: 'http://127.0.0.1:1', token: TOKEN });
    await expect(down.create('parse', { jobId: JOB_ID })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });
});
