// parse 沙箱的隔离测试（路线图第 6 步“文件解析的隔离”的测试要求）：在真实的 Docker（CI 中为 gVisor）中创建沙箱，
// 在沙箱内运行探测脚本。每项加固都有对照组：去掉该项（网络、只读根文件系统、取回校验）后同一个探测会得到相反的结果，
// 证明测试确实能发现加固被去掉。网络、文件系统与权限、资源上限、放入与取回的用例在 isolationSuite.ts 中按模板参数化
// （7.1 起 export 模板复用同一套，见 exportIsolation.test.ts）；这里另有 parse 专用的生命周期、sandbox-runner 与 LibreOffice 用例。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readArchive } from '../../../src/sandbox/archive.ts';
import { createSandboxRunnerClient } from '../../../src/sandbox/client.ts';
import { countSandboxes } from '../../../src/sandbox/docker.ts';
import type { SandboxRef } from '../../../src/sandbox/driver.ts';
import { buildSandboxRunnerApp } from '../../../src/sandbox/runnerApp.ts';
import { SANDBOX_TEMPLATES } from '../../../src/sandbox/templates.ts';
import { docker, dockerRequest, sandboxEnv } from './env.ts';
import { bridgeGateway, createIsolationHarness, defineIsolationSuite } from './isolationSuite.ts';

const parse = SANDBOX_TEMPLATES.parse;
const harness = createIsolationHarness('parse', sandboxEnv.image);
const { driver, makeDriver, createSandbox, track, run, sh, probe, weakenedDriver } = harness;

defineIsolationSuite(
  { template: 'parse', image: sandboxEnv.image, codeDirectory: '/opt/parse', outputExtension: 'md', validOutput: ['content.md', 'images/image-001.png'] },
  harness,
);

describe('sandbox lifecycle', () => {
  it('enforces the maximum number of sandboxes', async () => {
    const existing = await countSandboxes(docker);
    const limited = makeDriver({ maxActive: existing + 1 });
    const first = await createSandbox(limited);
    await expect(limited.create('parse', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_BUSY' });
    await limited.destroy(first);
    await createSandbox(limited);
  });

  it('counts stopped and expired-but-unswept sandboxes toward the cap, and allows creating again after cleanup', async () => {
    // 路线图 6.6（#28 确认时登记）：计入全部带沙箱标签的容器，含已停止、已到期但尚未清理的残留沙箱。
    const existing = await countSandboxes(docker);
    const limited = makeDriver({ maxActive: existing + 2 });
    // 已到期但还没被清理：创建时的时钟早于一个生命周期，标签中的到期时间已过。
    const past = makeDriver({ maxActive: existing + 2, now: () => new Date(Date.now() - parse.lifetimeMs - 60_000) });
    const expired = await createSandbox(past);
    const stopped = await createSandbox(limited);
    // 已停止（超时被终止的沙箱就是这样）：容器仍在，计数。
    await docker.killContainer(`zhibiao-sandbox-${stopped.id}`);
    expect((await docker.inspectContainer(`zhibiao-sandbox-${stopped.id}`))?.State.Running).toBe(false);
    await expect(limited.lookup(expired.id, expired.jobId)).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });

    const busy = await limited.create('parse', { jobId: randomUUID() }).then(() => null, (error: unknown) => error);
    expect(busy).toMatchObject({ code: 'SANDBOX_BUSY', message: '沙箱数已达上限，请稍后重试' });

    // 到期清理删掉已到期的残留后可以再创建；销毁已停止的残留后同样。
    expect(await limited.sweep()).toBeGreaterThanOrEqual(1);
    expect(await docker.inspectContainer(`zhibiao-sandbox-${expired.id}`)).toBeNull();
    await createSandbox(limited);
    await expect(limited.create('parse', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_BUSY' });
    await limited.destroy(stopped);
    await createSandbox(limited);
  });

  it('expires sandboxes and sweeps them', async () => {
    const ref = await createSandbox();
    const later = makeDriver({ now: () => new Date(Date.now() + parse.lifetimeMs + 1_000) });
    await expect(later.lookup(ref.id, ref.jobId)).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
    expect(await later.sweep()).toBeGreaterThanOrEqual(1);
    expect(await docker.inspectContainer(`zhibiao-sandbox-${ref.id}`)).toBeNull();
  });
});

describe('sandbox-runner over http', () => {
  const token = 'isolation-test-token-'.padEnd(48, 'x');
  let app: Awaited<ReturnType<typeof buildSandboxRunnerApp>>;
  let url: string;

  beforeAll(async () => {
    app = await buildSandboxRunnerApp({ driver, docker, runtime: sandboxEnv.runtime, token, logLevel: 'silent' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await app.close();
  });

  it('runs the parse template end to end and only the registered command', async () => {
    const client = createSandboxRunnerClient({ url, token });
    const ref = await client.create('parse', { jobId: randomUUID() });
    track(ref);
    await client.copyIn(ref, [{ path: 'original.docx', data: Buffer.from('PK') }]);
    const result = await client.exec(ref, 'parse', []);
    // 没有给出格式：解析入口以 64（参数不合法）退出，不读输入。
    expect(result.exitCode).toBe(64);
    expect(result.stdout.trim()).toBe('{"error":"bad_arguments"}');
    await expect(client.exec(ref, 'sh', ['-c', 'id'])).rejects.toMatchObject({ code: 'SANDBOX_BAD_REQUEST' });
    expect(await client.copyOut(ref)).toEqual([]);
    await expect(client.exec({ ...ref, jobId: randomUUID() }, 'parse', [])).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
    await client.destroy({ ...ref, jobId: randomUUID() });
    expect(await docker.inspectContainer(`zhibiao-sandbox-${ref.id}`)).not.toBeNull();
    await client.destroy(ref);
    expect(await docker.inspectContainer(`zhibiao-sandbox-${ref.id}`)).toBeNull();
  });

  it('cannot be reached from inside a sandbox', async () => {
    // 即使 sandbox-runner 监听所有地址（生产只在 sandbox-control 上），断网的沙箱也连不到它；对照组（网桥网络）能连到。
    const exposed = await buildSandboxRunnerApp({ driver, docker, runtime: sandboxEnv.runtime, token, logLevel: 'silent' });
    await exposed.listen({ host: '0.0.0.0', port: 0 });
    try {
      const port = (exposed.server.address() as { port: number }).port;
      const gateway = await bridgeGateway();
      const script = `const http = require('http');
        const get = (host) => new Promise((resolve) => {
          const req = http.get({ host, port: ${port}, path: '/healthz', timeout: 3000 }, (res) => { res.resume(); resolve('status:' + res.statusCode); });
          req.on('timeout', () => { req.destroy(); resolve('timeout'); });
          req.on('error', (error) => resolve(error.code));
        });
        (async () => console.log(JSON.stringify({ gateway: await get(${JSON.stringify(gateway)}), loopback: await get('127.0.0.1'), name: await get('sandbox-runner') })))();`;
      const ref = await createSandbox();
      const result = await probe<Record<string, string>>(ref, script);
      for (const outcome of Object.values(result)) expect(outcome).not.toMatch(/^status:/);
      const weakened = weakenedDriver((spec) => {
        spec.HostConfig.NetworkMode = 'bridge';
      });
      const control = await createSandbox(weakened);
      expect((await probe<Record<string, string>>(control, script, weakened)).gateway).toBe('status:200');
    } finally {
      await exposed.close();
    }
  });

  it('refuses to operate on containers it did not create', async () => {
    const id = randomUUID();
    const jobId = randomUUID();
    // 名称与沙箱相同、但没有沙箱标签的容器（例如被冒名的数据库容器）。
    const { status } = await dockerRequest('POST', `/containers/create?name=zhibiao-sandbox-${id}`, {
      Image: sandboxEnv.image,
      Entrypoint: ['/usr/bin/sleep'],
      Cmd: ['infinity'],
      Labels: { 'zhibiao.sandbox.job': jobId },
      HostConfig: { NetworkMode: 'none', Runtime: sandboxEnv.runtime },
    });
    expect(status).toBe(201);
    try {
      await dockerRequest('POST', `/containers/zhibiao-sandbox-${id}/start`);
      const client = createSandboxRunnerClient({ url, token });
      const ref: SandboxRef = { id, template: 'parse', jobId, expiresAt: new Date() };
      await expect(client.exec(ref, 'parse', [])).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
      await expect(client.copyIn(ref, [{ path: 'a', data: Buffer.from('x') }])).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
      await client.destroy(ref);
      expect(await docker.inspectContainer(`zhibiao-sandbox-${id}`)).not.toBeNull();
    } finally {
      await docker.removeContainer(`zhibiao-sandbox-${id}`);
    }
  });
});

describe.runIf(sandboxEnv.office)('LibreOffice in the sandbox', () => {
  const samples = new URL('../../files/samples/', import.meta.url);

  it.each([
    ['input.rtf', 'rtf-word.doc', []],
    ['input.doc', 'ole-word.docx', []],
    // HTML 默认按 Writer/Web 打开，没有 docx 导出过滤器；指定按 Writer 导入。
    ['input.html', 'html-word.doc', ['--infilter=HTML (StarWriter)']],
  ])('converts %s to docx under the parse template', async (name, sample, filters) => {
    const createStarted = Date.now();
    const ref = await createSandbox();
    const createMs = Date.now() - createStarted;
    await driver.copyIn(ref, [{ path: name, data: readFileSync(new URL(sample, samples)) }]);
    const started = Date.now();
    const result = await run(ref, ['soffice', '--headless', '--norestore', '--nolockcheck', '--nologo', '--nodefault', ...filters, '--convert-to', 'docx:MS Word 2007 XML', '--outdir', '/tmp/out', `/input/${name}`], 180_000);
    const convertMs = Date.now() - started;
    expect(result.exitCode, result.stderr).toBe(0);
    await sh(ref, `test -s /tmp/out/${name.replace(/\.[a-z]+$/, '')}.docx`);
    // 实测数据（路线图第 6 步：LibreOffice 在 gVisor 下的兼容性与性能以 6.5 的实测为准），写在 CI 日志中。
    console.info(JSON.stringify({ runtime: sandboxEnv.runtime, sample: name, createMs, convertMs }));
  });
});

describe('archive helper sanity', () => {
  it('accepts an empty output', async () => {
    expect(await readArchive((async function* () {
      yield Buffer.alloc(1024);
    })(), parse.output)).toEqual([]);
  });
});
