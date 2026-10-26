import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSandboxRunnerClient } from '../../src/sandbox/client.ts';
import type { DockerSandboxDriver } from '../../src/sandbox/docker.ts';
import type { DockerApi } from '../../src/sandbox/dockerApi.ts';
import { SandboxError, type SandboxDriver, type SandboxRef } from '../../src/sandbox/driver.ts';
import { readArchive } from '../../src/sandbox/archive.ts';
import { buildSandboxRunnerApp } from '../../src/sandbox/runnerApp.ts';
import { resolveCommand, SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';
import { createLogCapture } from '../helpers.ts';
import { END_OF_ARCHIVE, tarEntry } from './tarFixtures.ts';

const TOKEN = 'runner-token-'.padEnd(48, 'x');
const JOB_ID = '7d3c9b0e-1f2a-4b5c-8d6e-0f1a2b3c4d5e';
const OTHER_JOB = '00000000-0000-4000-8000-000000000001';
const SANDBOX_ID = '11111111-2222-4333-8444-555555555555';

/** 不访问 Docker 的 driver 桩：只认 SANDBOX_ID + JOB_ID，记录调用。 */
function fakeDriver() {
  const calls: string[] = [];
  let output: Buffer = Buffer.concat([tarEntry({ name: 'content.md', data: Buffer.from('ok') }), END_OF_ARCHIVE]);
  const ref: SandboxRef = Object.freeze({ id: SANDBOX_ID, template: 'parse', jobId: JOB_ID, expiresAt: new Date('2030-01-01T00:00:00Z') });
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
      // 与真实 driver 相同：先按模板的输入规则检查，不符为 SANDBOX_BAD_REQUEST。
      await readArchive(Readable.from([archive]), SANDBOX_TEMPLATES.parse.input).catch((error: unknown) => {
        throw new SandboxError('SANDBOX_BAD_REQUEST', '输入文件不符合沙箱规则', { cause: error });
      });
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
      if (id !== SANDBOX_ID || jobId !== JOB_ID) throw new SandboxError('SANDBOX_NOT_FOUND', '沙箱不存在');
      return ref;
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
    setOutput(value: Buffer) {
      output = value;
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
