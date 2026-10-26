// parse 沙箱的隔离测试（路线图第 6 步“文件解析的隔离”的测试要求）：在真实的 Docker（CI 中为 gVisor）中创建沙箱，
// 在沙箱内运行探测脚本。每项加固都有对照组：去掉该项（网络、只读根文件系统、取回校验）后同一个探测会得到相反的结果，
// 证明测试确实能发现加固被去掉。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
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
    // 根挂载点的挂载选项：gVisor 对非 root 用户先检查权限（EACCES），写入失败不足以说明只读，直接看是否以 ro 挂载。
    const root = fs.readFileSync('/proc/self/mounts', 'utf8').split('\\n').map((line) => line.split(' ')).find((fields) => fields[1] === '/');
    result.rootReadOnly = Boolean(root && root[3].split(',').includes('ro'));
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
    rootReadOnly: boolean;
  }

  it('has a read-only root filesystem, non-executable scratch space, no capabilities and no host environment', async () => {
    const ref = await createSandbox();
    const result = await probe<FsProbe>(ref, script);
    expect(result.rootReadOnly).toBe(true);
    // runc 下为 EROFS；gVisor 对非 root 用户先检查权限，得到 EACCES。
    for (const outcome of Object.values(result.root)) expect(['EROFS', 'EACCES']).toContain(outcome);
    for (const outcome of Object.values(result.writable)) expect(outcome).toBe('written');
    expect(result.tmpExec).toBe('EACCES');
    expect([result.uid, result.gid]).toEqual([10001, 10001]);
    expect(result.capEff).toMatch(/^0+$/);
    if (result.capBnd !== undefined) expect(result.capBnd).toMatch(/^0+$/);
    if (result.noNewPrivs !== undefined) expect(result.noNewPrivs).toBe('1');
    expect(result.env.filter((name) => !['HOME', 'LANG', 'TMPDIR', 'PATH', 'HOSTNAME', 'NODE_VERSION', 'YARN_VERSION'].includes(name))).toEqual([]);
  });

  it('control: without a read-only root filesystem the root is mounted read-write', async () => {
    const weakened = weakenedDriver((spec) => {
      spec.HostConfig.ReadonlyRootfs = false;
    });
    const ref = await createSandbox(weakened);
    const result = await probe<FsProbe>(ref, script, weakened);
    expect(result.rootReadOnly).toBe(false);
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

/** 宿主的可用内存（字节）。测试进程在宿主上（或 --network host 的容器中），/proc/meminfo 是宿主的。 */
function hostMemAvailable(): number {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  return Number(match![1]) * 1024;
}

/** 宿主上的线程总数（/proc/loadavg 第 4 项的分母）。runc 下沙箱内的每个进程都是宿主进程。 */
function hostThreads(): number {
  return Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[3]!.split('/')[1]);
}

/** 在 operation 执行期间每 100 ms 采样一次，返回采到的最小值和最大值。 */
async function sampleDuring<T>(read: () => number, operation: Promise<T>): Promise<{ result: T; min: number; max: number }> {
  let min = read();
  let max = min;
  const timer = setInterval(() => {
    const value = read();
    min = Math.min(min, value);
    max = Math.max(max, value);
  }, 100);
  try {
    return { result: await operation, min, max };
  } finally {
    clearInterval(timer);
  }
}

/** 宿主未受影响：Docker 照常响应，新建的沙箱能在 15 秒内执行命令。 */
async function expectHostHealthy() {
  const started = Date.now();
  await docker.ping();
  const ref = await createSandbox();
  const result = await run(ref, ['echo', 'ok'], 15_000);
  expect(result.stdout.trim()).toBe('ok');
  expect(Date.now() - started).toBeLessThan(15_000);
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('resource limits', () => {
  const allocate = "const kept = []; for (let i = 0; i < 40; i += 1) kept.push(Buffer.alloc(100 * 1024 * 1024, 1)); console.log('allocated')";

  it('kills a process that exceeds the memory limit without exhausting host memory', async () => {
    const ref = await createSandbox();
    const before = hostMemAvailable();
    const { result, min } = await sampleDuring(hostMemAvailable, run(ref, ['node', '-e', allocate]));
    expect(result.stdout).not.toContain('allocated');
    expect(result.exitCode).not.toBe(0);
    // 尝试分配 4 GiB，宿主可用内存的下降不超过沙箱上限 2 GiB 加上运行时开销。
    expect(before - min).toBeLessThan(parse.memoryBytes + 768 * MIB);
    await expectHostHealthy();
  });

  it('control: without the memory limit the same allocation succeeds', async () => {
    const weakened = weakenedDriver((spec) => {
      spec.HostConfig.Memory = 0;
      spec.HostConfig.MemorySwap = 0;
    });
    const ref = await createSandbox(weakened);
    const result = await run(ref, ['node', '-e', allocate], 60_000, weakened);
    expect(result.stdout).toContain('allocated');
  });

  const spawnMany = `const { spawn } = require('child_process'); let spawned = 0, error = null;
     for (let i = 0; i < 400; i += 1) { try { const child = spawn('sleep', ['30'], { stdio: 'ignore' }); child.on('spawn', () => { spawned += 1; }); child.on('error', (e) => { error = e.code; }); } catch (e) { error = e.code; break; } }
     setTimeout(() => { console.log(JSON.stringify({ spawned, error })); process.exit(0); }, 3000);`;

  it('limits the number of processes', async () => {
    const ref = await createSandbox();
    const result = await probe<{ spawned: number; error: string | null }>(ref, spawnMany);
    expect(result.spawned).toBeLessThan(parse.pidsLimit);
    expect(result.error).not.toBeNull();
  });

  it('control: without the pids limit the same 400 processes start', async () => {
    const weakened = weakenedDriver((spec) => {
      spec.HostConfig.PidsLimit = 0;
    });
    const ref = await createSandbox(weakened);
    const result = await probe<{ spawned: number; error: string | null }>(ref, spawnMany, weakened);
    expect(result.spawned).toBe(400);
  });

  it('contains a fork bomb and terminates it at the time limit without flooding the host', async () => {
    const ref = await createSandbox();
    const before = hostThreads();
    const { result, max } = await sampleDuring(hostThreads, run(ref, ['sh', '-c', 'bomb() { while :; do bomb & done; }; bomb & exec sleep 60'], 8_000));
    // dash 在 fork 失败时退出，炸弹在 pids 上限处不断有进程退出、又不断重试；主进程（sleep）一直等到超时被终止。
    expect(result.timedOut).toBe(true);
    // runc 下沙箱内的进程都是宿主进程，最多 pids 上限个；gVisor 下沙箱内的进程不是宿主进程。
    expect(max - before).toBeLessThan(parse.pidsLimit + 64);
    await expect(driver.lookup(ref.id, ref.jobId)).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
    await expectHostHealthy();
  });

  it('stops writes when a scratch directory is full and does not touch the host disk', async () => {
    const ref = await createSandbox();
    const hostFree = async () => {
      const stats = await statfs('/');
      return stats.bavail * stats.bsize;
    };
    const freeBefore = await hostFree();
    const result = await probe<Record<string, { bytes: number; code: string | null }>>(
      ref,
      `const fs = require('fs');
       const chunk = Buffer.alloc(16 * 1024 * 1024, 1);
       const fill = (path) => {
         let bytes = 0, code = null;
         const fd = fs.openSync(path, 'w');
         try { for (;;) { bytes += fs.writeSync(fd, chunk); if (bytes > 3 * 1024 ** 3) break; } } catch (error) { code = error.code; }
         fs.closeSync(fd);
         fs.unlinkSync(path);
         return { bytes, code };
       };
       console.log(JSON.stringify({ '/tmp': fill('/tmp/fill'), '/input': fill('/input/fill'), '/output': fill('/output/fill.md') }));`,
    );
    for (const [path, outcome] of Object.entries(result)) {
      expect(outcome.code, path).toBe('ENOSPC');
      expect(outcome.bytes, path).toBeLessThanOrEqual(parse.tmpfs[path]!.bytes);
    }
    // 可写目录都是 tmpfs，根文件系统只读，宿主磁盘的可用空间不因此减少。
    expect(freeBefore - (await hostFree())).toBeLessThan(64 * MIB);
    await expectHostHealthy();
  });

  // 4 个线程同时空转与 1 个线程空转的总吞吐之比：限制为 1 核时约为 1，不限制时接近宿主的核数。
  const cpuRatio = `const { Worker } = require('worker_threads');
     const spin = (threads) => Promise.all(Array.from({ length: threads }, () => new Promise((resolve) => {
       const worker = new Worker('const { parentPort } = require("worker_threads"); const end = Date.now() + 1500; let n = 0; while (Date.now() < end) n += 1; parentPort.postMessage(n);', { eval: true });
       worker.once('message', resolve);
     }))).then((counts) => counts.reduce((a, b) => a + b, 0));
     (async () => { await spin(1); const one = await spin(1); const four = await spin(4); console.log(JSON.stringify({ ratio: four / one })); })();`;

  it('limits a CPU busy loop to one core and terminates it at the time limit', async () => {
    const ref = await createSandbox();
    const { ratio } = await probe<{ ratio: number }>(ref, cpuRatio);
    expect(ratio).toBeLessThan(1.6);
    const started = Date.now();
    const result = await run(ref, ['node', '-e', 'for (;;) {}'], 3_000);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
    await expect(driver.lookup(ref.id, ref.jobId)).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
    await expectHostHealthy();
  });

  it.runIf(availableParallelism() >= 3)('control: without the CPU limit four threads run in parallel', async () => {
    const weakened = weakenedDriver((spec) => {
      spec.HostConfig.NanoCpus = 0;
    });
    const ref = await createSandbox(weakened);
    const { ratio } = await probe<{ ratio: number }>(ref, cpuRatio, weakened);
    expect(ratio).toBeGreaterThan(2);
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

  it('cannot be reached from inside a sandbox', async () => {
    // 即使 sandbox-runner 监听所有地址（生产只在 sandbox-control 上），断网的沙箱也连不到它；对照组（网桥网络）能连到。
    const exposed = await buildSandboxRunnerApp({ driver, docker, runtime: sandboxEnv.runtime, token, logLevel: 'silent' });
    await exposed.listen({ host: '0.0.0.0', port: 0 });
    try {
      const port = (exposed.server.address() as { port: number }).port;
      const network = await dockerRequest('GET', '/networks/bridge');
      const gateway = (network.json as { IPAM: { Config: Array<{ Gateway?: string }> } }).IPAM.Config.find((entry) => entry.Gateway?.includes('.'))!.Gateway!;
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
