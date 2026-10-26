// parse 沙箱的隔离测试（路线图第 6 步“文件解析的隔离”的测试要求）：在真实的 Docker（CI 中为 gVisor）中创建沙箱，
// 在沙箱内运行探测脚本。每项加固都有对照组：去掉该项（网络、只读根文件系统、取回校验）后同一个探测会得到相反的结果，
// 证明测试确实能发现加固被去掉。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readArchive } from '../../../src/sandbox/archive.ts';
import { createSandboxRunnerClient } from '../../../src/sandbox/client.ts';
import { createDockerSandboxDriver, type DockerSandboxDriver } from '../../../src/sandbox/docker.ts';
import type { SandboxRef } from '../../../src/sandbox/driver.ts';
import { buildSandboxRunnerApp } from '../../../src/sandbox/runnerApp.ts';
import { buildContainerSpec, SANDBOX_TEMPLATES } from '../../../src/sandbox/templates.ts';
import { docker, dockerRequest, sandboxEnv, silentLog } from './env.ts';

const parse = SANDBOX_TEMPLATES.parse;
const created: Array<{ driver: DockerSandboxDriver; ref: SandboxRef }> = [];

function makeDriver(overrides: Partial<Parameters<typeof createDockerSandboxDriver>[0]> = {}): DockerSandboxDriver {
  return createDockerSandboxDriver({ docker, runtime: sandboxEnv.runtime, images: { parse: sandboxEnv.image }, maxActive: 32, log: silentLog, ...overrides });
}

const driver = makeDriver();

async function createSandbox(target: DockerSandboxDriver = driver): Promise<SandboxRef> {
  const ref = await target.create('parse', { jobId: randomUUID() });
  created.push({ driver: target, ref });
  return ref;
}

async function run(ref: SandboxRef, argv: string[], timeoutMs = 60_000, target: DockerSandboxDriver = driver) {
  return target.execArgv(ref, argv, { timeoutMs });
}

async function sh(ref: SandboxRef, script: string, target: DockerSandboxDriver = driver) {
  const result = await run(ref, ['sh', '-c', script], 60_000, target);
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  return result;
}

async function probe<T>(ref: SandboxRef, script: string, target: DockerSandboxDriver = driver): Promise<T> {
  const result = await run(ref, ['node', '-e', script], 60_000, target);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

/** 去掉某项加固的对照组 driver。 */
function weakenedDriver(change: (spec: ReturnType<typeof buildContainerSpec>) => void): DockerSandboxDriver {
  return makeDriver({
    buildSpec: (template, options) => {
      const spec = buildContainerSpec(template, options);
      change(spec);
      return spec;
    },
  });
}

afterEach(async () => {
  for (const { driver: owner, ref } of created.splice(0)) await owner.destroy(ref);
});

describe('network', () => {
  let server: Server;
  let gateway: string;
  let port: number;

  beforeAll(async () => {
    server = createServer((socket) => {
      // 探测脚本连上即断开，忽略连接重置。
      socket.on('error', () => {});
      socket.end('hello');
    });
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    port = (server.address() as { port: number }).port;
    const network = await dockerRequest('GET', '/networks/bridge');
    gateway = (network.json as { IPAM: { Config: Array<{ Gateway?: string }> } }).IPAM.Config.find((entry) => entry.Gateway?.includes('.'))!.Gateway!;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const script = (host: string, hostPort: number) => `
    const net = require('net'), dns = require('dns'), dgram = require('dgram'), fs = require('fs');
    const tcp = (host, port) => new Promise((resolve) => {
      const socket = net.connect({ host, port, timeout: 3000 });
      socket.on('connect', () => { socket.destroy(); resolve('connected'); });
      socket.on('timeout', () => { socket.destroy(); resolve('timeout'); });
      socket.on('error', (error) => resolve(error.code));
    });
    const lookup = (name) => new Promise((resolve) => dns.lookup(name, (error, address) => resolve(error ? error.code : 'resolved:' + address)));
    const udp = () => new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      socket.send(Buffer.from('x'), 53, '8.8.8.8', (error) => { socket.close(); resolve(error ? error.code : 'sent'); });
    });
    (async () => {
      const interfaces = fs.readFileSync('/proc/net/dev', 'utf8').split('\\n').slice(2).map((line) => line.split(':')[0].trim()).filter(Boolean);
      const result = { interfaces, tcp: {}, dns: {} };
      for (const [host, port] of [[${JSON.stringify(host)}, ${hostPort}], ['169.254.169.254', 80], ['1.1.1.1', 443], ['8.8.8.8', 53], ['10.0.0.1', 5432]]) {
        result.tcp[host + ':' + port] = await tcp(host, port);
      }
      for (const name of ['redis', 'postgres', 's3', 'sandbox-runner', 'example.com', 'host.docker.internal']) result.dns[name] = await lookup(name);
      result.udp = await udp();
      console.log(JSON.stringify(result));
    })();
  `;

  interface NetworkProbe {
    interfaces: string[];
    tcp: Record<string, string>;
    dns: Record<string, string>;
    udp: string;
  }

  it('has no network interface except loopback and reaches nothing', async () => {
    const ref = await createSandbox();
    const result = await probe<NetworkProbe>(ref, script(gateway, port));
    expect(result.interfaces.every((name) => name === 'lo')).toBe(true);
    for (const outcome of Object.values(result.tcp)) expect(outcome).not.toBe('connected');
    for (const outcome of Object.values(result.dns)) expect(outcome).not.toMatch(/^resolved/);
    expect(result.udp).not.toBe('sent');
  });

  it('control: without --network none the same probe reaches the host', async () => {
    const weakened = weakenedDriver((spec) => {
      spec.HostConfig.NetworkMode = 'bridge';
    });
    const ref = await createSandbox(weakened);
    const result = await probe<NetworkProbe>(ref, script(gateway, port), weakened);
    expect(result.interfaces).toContain('eth0');
    expect(result.tcp[`${gateway}:${port}`]).toBe('connected');
  });
});

describe('filesystem and privileges', () => {
  const script = `
    const fs = require('fs'), childProcess = require('child_process');
    const write = (path) => { try { fs.writeFileSync(path, 'x'); return 'written'; } catch (error) { return error.code; } };
    const result = { root: {}, writable: {} };
    for (const path of ['/probe', '/etc/probe', '/opt/parse/probe', '/usr/local/bin/probe', '/var/probe']) result.root[path] = write(path);
    for (const path of ['/tmp/probe', '/output/probe.md', '/input/probe']) result.writable[path] = write(path);
    fs.copyFileSync('/usr/bin/true', '/tmp/true');
    fs.chmodSync('/tmp/true', 0o755);
    try { childProcess.execFileSync('/tmp/true'); result.tmpExec = 'executed'; } catch (error) { result.tmpExec = error.code; }
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const field = (name) => (status.match(new RegExp('^' + name + ':\\\\s*(.*)$', 'm')) || [])[1];
    result.uid = process.getuid(); result.gid = process.getgid();
    result.capEff = field('CapEff'); result.capBnd = field('CapBnd'); result.noNewPrivs = field('NoNewPrivs');
    result.env = Object.keys(process.env).sort();
    console.log(JSON.stringify(result));
  `;

  interface FsProbe {
    root: Record<string, string>;
    writable: Record<string, string>;
    tmpExec: string;
    uid: number;
    gid: number;
    capEff?: string;
    capBnd?: string;
    noNewPrivs?: string;
    env: string[];
  }

  it('has a read-only root filesystem, non-executable scratch space, no capabilities and no host environment', async () => {
    const ref = await createSandbox();
    const result = await probe<FsProbe>(ref, script);
    for (const outcome of Object.values(result.root)) expect(outcome).toBe('EROFS');
    for (const outcome of Object.values(result.writable)) expect(outcome).toBe('written');
    expect(result.tmpExec).toBe('EACCES');
    expect([result.uid, result.gid]).toEqual([10001, 10001]);
    expect(result.capEff).toMatch(/^0+$/);
    if (result.capBnd !== undefined) expect(result.capBnd).toMatch(/^0+$/);
    if (result.noNewPrivs !== undefined) expect(result.noNewPrivs).toBe('1');
    expect(result.env.filter((name) => !['HOME', 'LANG', 'TMPDIR', 'PATH', 'HOSTNAME', 'NODE_VERSION', 'YARN_VERSION'].includes(name))).toEqual([]);
  });

  it('control: without a read-only root filesystem the same writes are no longer EROFS', async () => {
    const weakened = weakenedDriver((spec) => {
      spec.HostConfig.ReadonlyRootfs = false;
    });
    const ref = await createSandbox(weakened);
    const result = await probe<FsProbe>(ref, script, weakened);
    expect(Object.values(result.root)).not.toContain('EROFS');
  });

  it('contains no setuid programs, network tools, package managers or compilers', async () => {
    const ref = await createSandbox();
    const result = await sh(
      ref,
      'find / -xdev -type f -perm /6000 2>/dev/null; for tool in curl wget nc ncat netcat socat ssh scp telnet ftp npm npx corepack yarn gcc cc g++ make; do command -v "$tool" || true; done',
    );
    expect(result.stdout).toBe('');
  });

  it('applies the template to the container', async () => {
    const ref = await createSandbox();
    const { json } = await dockerRequest('GET', `/containers/zhibiao-sandbox-${ref.id}/json`);
    const info = json as { HostConfig: Record<string, unknown>; Mounts: unknown[]; Config: { User: string } };
    expect(info.HostConfig).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Runtime: sandboxEnv.runtime,
      Memory: parse.memoryBytes,
      MemorySwap: parse.memoryBytes,
      NanoCpus: parse.nanoCpus,
      PidsLimit: parse.pidsLimit,
    });
    expect(info.HostConfig.Binds ?? []).toEqual([]);
    expect(info.Mounts).toEqual([]);
    expect(info.Config.User).toBe('10001:10001');
  });
});

describe('resource limits', () => {
  it('kills a process that exceeds the memory limit', async () => {
    const ref = await createSandbox();
    const result = await run(ref, ['node', '-e', "const kept = []; for (let i = 0; i < 40; i += 1) kept.push(Buffer.alloc(100 * 1024 * 1024, 1)); console.log('allocated')"]);
    expect(result.stdout).not.toContain('allocated');
    expect(result.exitCode).not.toBe(0);
  });

  it('limits the number of processes', async () => {
    const ref = await createSandbox();
    const result = await probe<{ spawned: number; error: string | null }>(
      ref,
      `const { spawn } = require('child_process'); let spawned = 0, error = null;
       for (let i = 0; i < 400; i += 1) { try { const child = spawn('sleep', ['30']); child.on('spawn', () => { spawned += 1; }); child.on('error', (e) => { error = e.code; }); } catch (e) { error = e.code; break; } }
       setTimeout(() => { console.log(JSON.stringify({ spawned, error })); process.exit(0); }, 3000);`,
    );
    expect(result.spawned).toBeLessThan(parse.pidsLimit);
    expect(result.error).not.toBeNull();
  });

  it('terminates the sandbox when a command exceeds its time limit', async () => {
    const ref = await createSandbox();
    const started = Date.now();
    const result = await run(ref, ['sleep', '60'], 1_500);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(20_000);
    await expect(driver.lookup(ref.id, ref.jobId)).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
  });

  it('terminates the sandbox when the caller aborts', async () => {
    const ref = await createSandbox();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    await expect(driver.execArgv(ref, ['sleep', '60'], { timeoutMs: 60_000, signal: controller.signal })).rejects.toMatchObject({ code: 'SANDBOX_ABORTED' });
    await expect(driver.lookup(ref.id, ref.jobId)).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
  });
});

describe('copy in and copy out', () => {
  it('round-trips files through /input and /output', async () => {
    const ref = await createSandbox();
    const original = Buffer.from('原件内容\u0000binary', 'utf8');
    await driver.copyIn(ref, [{ path: 'original.docx', data: original }]);
    await sh(ref, 'cp /input/original.docx /output/content.md && mkdir /output/images && printf x > /output/images/image-001.png');
    const files = await driver.copyOut(ref);
    expect(files.map((file) => file.path).sort()).toEqual(['content.md', 'images/image-001.png']);
    expect(files.find((file) => file.path === 'content.md')!.data.equals(original)).toBe(true);
  });

  it.each([
    ['a symbolic link', 'printf x > /output/a.md && ln -s /etc/passwd /output/b.md'],
    ['a hard link', 'printf x > /output/a.md && ln /output/a.md /output/b.md'],
    ['a fifo', 'mkfifo /output/pipe.md'],
    ['too many files', 'i=0; while [ $i -le 2010 ]; do : > /output/f$i.md; i=$((i+1)); done'],
    ['a disallowed extension', "printf '<script>' > /output/page.html"],
    ['a path that is too deep', 'mkdir -p /output/a/b && printf x > /output/a/b/c.png'],
    ['an unsafe file name', "printf x > '/output/-rf.md'"],
  ])('rejects output containing %s', async (_name, script) => {
    const ref = await createSandbox();
    await sh(ref, script);
    await expect(driver.copyOut(ref)).rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' });
  });

  it('control: the raw archive does contain the link that validation rejects', async () => {
    const ref = await createSandbox();
    await sh(ref, 'printf x > /output/a.md && ln -s /etc/passwd /output/b.md');
    const raw = await driver.copyOutRaw(ref);
    const chunks: Buffer[] = [];
    for await (const chunk of raw) chunks.push(chunk as Buffer);
    const archive = Buffer.concat(chunks);
    const types: string[] = [];
    for (let offset = 0; offset + 512 <= archive.length; ) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
      types.push(String.fromCharCode(header[156]!));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(types).toContain('2');
  });

  it('does not share anything between sandboxes', async () => {
    const first = await createSandbox();
    await driver.copyIn(first, [{ path: 'secret.docx', data: Buffer.from('secret') }]);
    await sh(first, 'printf secret > /tmp/secret && printf secret > /output/secret.md');
    const second = await createSandbox();
    const result = await run(second, ['sh', '-c', 'ls -A /input /output /tmp; test ! -e /tmp/secret && echo isolated']);
    expect(result.stdout).toContain('isolated');
    expect(result.stdout).not.toContain('secret');
    expect(await driver.copyOut(second)).toEqual([]);
  });
});

describe('sandbox lifecycle', () => {
  it('enforces the maximum number of sandboxes', async () => {
    const existing = (await docker.listContainers('zhibiao.sandbox=1')).length;
    const limited = makeDriver({ maxActive: existing + 1 });
    const first = await createSandbox(limited);
    await expect(limited.create('parse', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_BUSY' });
    await limited.destroy(first);
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
    created.push({ driver, ref });
    await client.copyIn(ref, [{ path: 'original.docx', data: Buffer.from('PK') }]);
    const result = await client.exec(ref, 'parse', []);
    // 6.5 的占位入口：退出码 64。
    expect(result.exitCode).toBe(64);
    await expect(client.exec(ref, 'sh', ['-c', 'id'])).rejects.toMatchObject({ code: 'SANDBOX_BAD_REQUEST' });
    expect(await client.copyOut(ref)).toEqual([]);
    await expect(client.exec({ ...ref, jobId: randomUUID() }, 'parse', [])).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
    await client.destroy({ ...ref, jobId: randomUUID() });
    expect(await docker.inspectContainer(`zhibiao-sandbox-${ref.id}`)).not.toBeNull();
    await client.destroy(ref);
    expect(await docker.inspectContainer(`zhibiao-sandbox-${ref.id}`)).toBeNull();
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
    ['input.rtf', 'rtf-word.doc'],
    ['input.doc', 'ole-word.docx'],
    ['input.html', 'html-word.doc'],
  ])('converts %s to docx under the parse template', async (name, sample) => {
    const createStarted = Date.now();
    const ref = await createSandbox();
    const createMs = Date.now() - createStarted;
    await driver.copyIn(ref, [{ path: name, data: readFileSync(new URL(sample, samples)) }]);
    const started = Date.now();
    const result = await run(ref, ['soffice', '--headless', '--norestore', '--nolockcheck', '--nologo', '--nodefault', '--convert-to', 'docx', '--outdir', '/tmp/out', `/input/${name}`], 180_000);
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
