// 沙箱隔离的公共测试套件（路线图第 6 步“文件解析的隔离”的测试要求，6.5 建立；7.1 起按模板参数化，export 模板复用）：
// 在真实的 Docker（CI 中为 gVisor）中按模板创建沙箱，在沙箱内运行探测脚本。每项加固都有对照组：去掉该项（网络、只读根文件系统、
// 内存 / pids / CPU 上限、取回校验）后同一个探测会得到相反的结果，证明测试确实能发现加固被去掉。
// parse 模板在 isolation.test.ts、export 模板在 exportIsolation.test.ts 中调用 defineIsolationSuite。
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { createServer, type Server } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createArchive } from '../../../src/sandbox/archive.ts';
import { createDockerSandboxDriver, type DockerSandboxDriver } from '../../../src/sandbox/docker.ts';
import type { SandboxRef } from '../../../src/sandbox/driver.ts';
import { buildContainerSpec, SANDBOX_TEMPLATES, type SandboxImageName, type SandboxTemplateName } from '../../../src/sandbox/templates.ts';
import { docker, dockerRequest, sandboxEnv, silentLog } from './env.ts';

const MIB = 1024 * 1024;

export interface IsolationTarget {
  template: SandboxTemplateName;
  /** 该模板所用镜像的引用（测试环境给出）。 */
  image: string;
  /** 镜像中放入口脚本的目录（只读根文件系统上的一个位置）。 */
  codeDirectory: string;
  /** 取回规则允许的一个扩展名，构造“除了被测的这一项之外都合法”的输出。 */
  outputExtension: string;
  /** 一组合法的输出（相对输出目录的路径），用于往返测试。 */
  validOutput: readonly string[];
}

export interface IsolationHarness {
  driver: DockerSandboxDriver;
  makeDriver(overrides?: Partial<Parameters<typeof createDockerSandboxDriver>[0]>): DockerSandboxDriver;
  createSandbox(target?: DockerSandboxDriver): Promise<SandboxRef>;
  /** 由别处（如经 HTTP 的客户端）创建的沙箱，同样在测试结束后销毁。 */
  track(ref: SandboxRef, target?: DockerSandboxDriver): void;
  run(ref: SandboxRef, argv: string[], timeoutMs?: number, target?: DockerSandboxDriver): ReturnType<DockerSandboxDriver['execArgv']>;
  sh(ref: SandboxRef, script: string, target?: DockerSandboxDriver): ReturnType<DockerSandboxDriver['execArgv']>;
  probe<T>(ref: SandboxRef, script: string, target?: DockerSandboxDriver): Promise<T>;
  /** 去掉某项加固的对照组 driver。 */
  weakenedDriver(change: (spec: ReturnType<typeof buildContainerSpec>) => void): DockerSandboxDriver;
  expectHostHealthy(): Promise<void>;
}

/** 按模板创建沙箱并在测试结束后销毁的工具；同一测试文件中的公共套件与专用用例共用。 */
export function createIsolationHarness(template: SandboxTemplateName, image: string): IsolationHarness {
  const created: Array<{ driver: DockerSandboxDriver; ref: SandboxRef }> = [];
  const imageName: SandboxImageName = SANDBOX_TEMPLATES[template].image;
  const makeDriver: IsolationHarness['makeDriver'] = (overrides = {}) =>
    createDockerSandboxDriver({ docker, runtime: sandboxEnv.runtime, images: { [imageName]: image }, maxActive: 32, log: silentLog, ...overrides });
  const driver = makeDriver();

  const createSandbox: IsolationHarness['createSandbox'] = async (target = driver) => {
    const ref = await target.create(template, { jobId: randomUUID() });
    created.push({ driver: target, ref });
    return ref;
  };
  const track: IsolationHarness['track'] = (ref, target = driver) => {
    created.push({ driver: target, ref });
  };
  const run: IsolationHarness['run'] = (ref, argv, timeoutMs = 60_000, target = driver) => target.execArgv(ref, argv, { timeoutMs });
  const sh: IsolationHarness['sh'] = async (ref, script, target = driver) => {
    const result = await run(ref, ['sh', '-c', script], 60_000, target);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    return result;
  };
  const probe = async <T>(ref: SandboxRef, script: string, target: DockerSandboxDriver = driver): Promise<T> => {
    const result = await run(ref, ['node', '-e', script], 60_000, target);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as T;
  };
  const weakenedDriver: IsolationHarness['weakenedDriver'] = (change) =>
    makeDriver({
      buildSpec: (spec, options) => {
        const built = buildContainerSpec(spec, options);
        change(built);
        return built;
      },
    });
  /** 宿主未受影响：Docker 照常响应，新建的沙箱能在 15 秒内执行命令。 */
  const expectHostHealthy = async () => {
    const started = Date.now();
    await docker.ping();
    const ref = await createSandbox();
    const result = await run(ref, ['echo', 'ok'], 15_000);
    expect(result.stdout.trim()).toBe('ok');
    expect(Date.now() - started).toBeLessThan(15_000);
  };

  afterEach(async () => {
    for (const { driver: owner, ref } of created.splice(0)) await owner.destroy(ref);
  });

  return { driver, makeDriver, createSandbox, track, run, sh, probe, weakenedDriver, expectHostHealthy };
}

/** Docker 网桥的网关地址：测试进程在宿主上监听，网桥上的容器经它连到宿主。 */
export async function bridgeGateway(): Promise<string> {
  const network = await dockerRequest('GET', '/networks/bridge');
  return (network.json as { IPAM: { Config: Array<{ Gateway?: string }> } }).IPAM.Config.find((entry) => entry.Gateway?.includes('.'))!.Gateway!;
}

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

/** 按模板定义网络、文件系统与权限、资源上限、放入与取回、任务间隔离的全部用例（每项有对照组）。 */
export function defineIsolationSuite(target: IsolationTarget, harness: IsolationHarness = createIsolationHarness(target.template, target.image)) {
  const template = SANDBOX_TEMPLATES[target.template];
  const { driver, createSandbox, run, sh, probe, weakenedDriver, expectHostHealthy } = harness;
  const inputDirectory = template.input.directory;
  const outputDirectory = template.output.directory;
  const ext = target.outputExtension;

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
      gateway = await bridgeGateway();
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
    const writable = Object.keys(template.tmpfs);
    const script = `
      const fs = require('fs'), childProcess = require('child_process');
      const write = (path) => { try { fs.writeFileSync(path, 'x'); return 'written'; } catch (error) { return error.code; } };
      const result = { root: {}, writable: {} };
      for (const path of ['/probe', '/etc/probe', ${JSON.stringify(`${target.codeDirectory}/probe`)}, '/usr/local/bin/probe', '/var/probe']) result.root[path] = write(path);
      for (const path of ${JSON.stringify(writable.map((directory) => `${directory}/probe.${ext}`))}) result.writable[path] = write(path);
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
      expect(Object.keys(result.writable)).toHaveLength(writable.length);
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
        'find / -xdev -type f -perm /6000 2>/dev/null; for tool in curl wget nc ncat netcat socat ssh scp telnet ftp npm npx corepack yarn gcc cc g++ make dotnet csc; do command -v "$tool" || true; done',
      );
      expect(result.stdout).toBe('');
    });

    it('applies the template to the container', async () => {
      const ref = await createSandbox();
      const { json } = await dockerRequest('GET', `/containers/zhibiao-sandbox-${ref.id}/json`);
      const info = json as { HostConfig: Record<string, unknown>; Mounts: unknown[]; Config: { User: string; Labels: Record<string, string> } };
      expect(info.HostConfig).toMatchObject({
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Runtime: sandboxEnv.runtime,
        Memory: template.memoryBytes,
        MemorySwap: template.memoryBytes,
        NanoCpus: template.nanoCpus,
        PidsLimit: template.pidsLimit,
      });
      expect(info.HostConfig.Binds ?? []).toEqual([]);
      expect(info.Mounts).toEqual([]);
      expect(info.Config.User).toBe('10001:10001');
      expect(info.Config.Labels['zhibiao.sandbox.template']).toBe(target.template);
    });
  });

  describe('resource limits', () => {
    // 尝试分配模板内存上限的两倍（100 MiB 一块）。
    const chunks = Math.ceil((template.memoryBytes * 2) / (100 * MIB));
    const allocate = `const kept = []; for (let i = 0; i < ${chunks}; i += 1) kept.push(Buffer.alloc(100 * 1024 * 1024, 1)); console.log('allocated')`;

    it('kills a process that exceeds the memory limit without exhausting host memory', async () => {
      const ref = await createSandbox();
      const before = hostMemAvailable();
      const { result, min } = await sampleDuring(hostMemAvailable, run(ref, ['node', '-e', allocate]));
      expect(result.stdout).not.toContain('allocated');
      expect(result.exitCode).not.toBe(0);
      // 宿主可用内存的下降不超过沙箱上限加上运行时开销。
      expect(before - min).toBeLessThan(template.memoryBytes + 768 * MIB);
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

    const attempts = template.pidsLimit + 144;
    const spawnMany = `const { spawn } = require('child_process'); let spawned = 0, error = null;
       for (let i = 0; i < ${attempts}; i += 1) { try { const child = spawn('sleep', ['30'], { stdio: 'ignore' }); child.on('spawn', () => { spawned += 1; }); child.on('error', (e) => { error = e.code; }); } catch (e) { error = e.code; break; } }
       setTimeout(() => { console.log(JSON.stringify({ spawned, error })); process.exit(0); }, 3000);`;

    it('limits the number of processes', async () => {
      const ref = await createSandbox();
      const result = await probe<{ spawned: number; error: string | null }>(ref, spawnMany);
      expect(result.spawned).toBeLessThan(template.pidsLimit);
      expect(result.error).not.toBeNull();
    });

    it('control: without the pids limit the same processes start', async () => {
      const weakened = weakenedDriver((spec) => {
        spec.HostConfig.PidsLimit = 0;
      });
      const ref = await createSandbox(weakened);
      const result = await probe<{ spawned: number; error: string | null }>(ref, spawnMany, weakened);
      expect(result.spawned).toBe(attempts);
    });

    it('contains a fork bomb without flooding the host', async () => {
      const ref = await createSandbox();
      const before = hostThreads();
      const started = Date.now();
      const { result, max } = await sampleDuring(hostThreads, run(ref, ['sh', '-c', 'bomb() { while :; do bomb & done; }; bomb & exec sleep 60'], 8_000));
      const sandboxAlive = await driver.lookup(ref.id, ref.jobId).then(
        () => true,
        () => false,
      );
      // 实际结果写进 CI 日志：runc 下 dash 在 fork 失败时退出、炸弹在 pids 上限处反复重试，主进程（sleep）一直等到超时被终止；
      // gVisor 下炸弹可能使整个沙箱提前结束。两种都算被限制或被终止，不允许的是“命令正常结束且沙箱完好”。
      console.info(JSON.stringify({ runtime: sandboxEnv.runtime, template: target.template, forkBomb: { timedOut: result.timedOut, exitCode: result.exitCode, elapsedMs: Date.now() - started, sandboxAlive, hostThreadDelta: max - before, stderr: result.stderr.slice(0, 200) } }));
      expect(result.timedOut || result.exitCode !== 0 || !sandboxAlive).toBe(true);
      if (result.timedOut) expect(sandboxAlive).toBe(false);
      // 宿主线程的增量受 pids 上限约束（runc 下沙箱内的进程即宿主进程；gVisor 下是 Sentry 的线程，同样在容器的 cgroup 中）。
      expect(max - before).toBeLessThan(template.pidsLimit + 64);
      // gVisor 下炸弹会使 runsc 的控制通道断开（exec 以 128 返回），容器却仍在运行；调用方在任何非 0 退出后都必须销毁沙箱，
      // 销毁后容器不存在、宿主线程数回落。
      await driver.destroy(ref);
      expect(await docker.inspectContainer(`zhibiao-sandbox-${ref.id}`)).toBeNull();
      const deadline = Date.now() + 10_000;
      while (hostThreads() - before >= 64 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
      expect(hostThreads() - before).toBeLessThan(64);
      await expectHostHealthy();
    });

    it('stops writes when a scratch directory is full and does not touch the host disk', async () => {
      const ref = await createSandbox();
      const hostFree = async () => {
        const stats = await statfs('/');
        return stats.bavail * stats.bsize;
      };
      const freeBefore = await hostFree();
      const paths = Object.keys(template.tmpfs);
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
         const result = {};
         for (const directory of ${JSON.stringify(paths)}) result[directory] = fill(directory + '/fill.${ext}');
         console.log(JSON.stringify(result));`,
      );
      expect(Object.keys(result).sort()).toEqual([...paths].sort());
      for (const [path, outcome] of Object.entries(result)) {
        expect(outcome.code, path).toBe('ENOSPC');
        expect(outcome.bytes, path).toBeLessThanOrEqual(template.tmpfs[path]!.bytes);
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
    it(`round-trips files through ${inputDirectory} and ${outputDirectory}`, async () => {
      const ref = await createSandbox();
      const original = Buffer.from('原件内容\u0000binary', 'utf8');
      await driver.copyIn(ref, [{ path: 'original.bin', data: original }]);
      const [first, ...rest] = target.validOutput;
      const script = [`cp ${inputDirectory}/original.bin ${outputDirectory}/${first}`];
      for (const path of rest) {
        if (path.includes('/')) script.push(`mkdir -p ${outputDirectory}/${path.slice(0, path.lastIndexOf('/'))}`);
        script.push(`printf x > ${outputDirectory}/${path}`);
      }
      await sh(ref, script.join(' && '));
      const files = await driver.copyOut(ref);
      expect(files.map((file) => file.path).sort()).toEqual([...target.validOutput].sort());
      expect(files.find((file) => file.path === first)!.data.equals(original)).toBe(true);
    });

    const tooDeep = `${outputDirectory}/${'d/'.repeat(template.output.maxDepth)}c.${ext}`;
    it.each([
      ['a symbolic link', `printf x > ${outputDirectory}/a.${ext} && ln -s /etc/passwd ${outputDirectory}/b.${ext}`],
      ['a hard link', `printf x > ${outputDirectory}/a.${ext} && ln ${outputDirectory}/a.${ext} ${outputDirectory}/b.${ext}`],
      ['a fifo', `mkfifo ${outputDirectory}/pipe.${ext}`],
      ['too many files', `i=0; while [ $i -le ${template.output.maxFiles} ]; do : > ${outputDirectory}/f$i.${ext}; i=$((i+1)); done`],
      ['a disallowed extension', `printf '<script>' > ${outputDirectory}/page.html`],
      ['a path that is too deep', `mkdir -p ${tooDeep.slice(0, tooDeep.lastIndexOf('/'))} && printf x > ${tooDeep}`],
      ['an unsafe file name', `printf x > '${outputDirectory}/-rf.${ext}'`],
    ])('rejects output containing %s', async (_name, script) => {
      const ref = await createSandbox();
      await sh(ref, script);
      await expect(driver.copyOut(ref)).rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' });
    });

    it('control: the raw archive does contain the link that validation rejects', async () => {
      const ref = await createSandbox();
      await sh(ref, `printf x > ${outputDirectory}/a.${ext} && ln -s /etc/passwd ${outputDirectory}/b.${ext}`);
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

    /** 一个文件的归档流：内容由同一块缓冲区重复组成，不在测试进程中生成整个归档。 */
    function streamedArchive(name: string, size: number, tail: Buffer[] = [Buffer.alloc(1024)]) {
      const header = createArchive([{ path: name, data: Buffer.alloc(0) }], template.input).subarray(0, 512);
      header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
      header.fill(0x20, 148, 156);
      let sum = 0;
      for (const byte of header) sum += byte;
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
      const block = Buffer.alloc(MIB);
      for (let index = 0; index < block.length; index += 1) block[index] = (index * 31 + 7) & 0xff;
      const hash = createHash('sha256');
      async function* source() {
        yield header;
        for (let sent = 0; sent < size; sent += MIB) {
          const chunk = block.subarray(0, Math.min(MIB, size - sent));
          hash.update(chunk);
          yield chunk;
        }
        yield Buffer.alloc((512 - (size % 512)) % 512);
        yield* tail;
      }
      return { source, sha256: () => hash.digest('hex') };
    }

    it(`streams a large input archive into ${inputDirectory} intact`, async () => {
      const ref = await createSandbox();
      // 不超过模板的单个文件与总大小上限（export-preview 为 32 MiB / 64 MiB）。
      const archive = streamedArchive('large.bin', Math.min(96 * MIB, template.input.maxFileBytes, template.input.maxTotalBytes) - 4096 + 123);
      await driver.copyInArchive(ref, archive.source());
      const result = await sh(ref, `sha256sum ${inputDirectory}/large.bin`);
      expect(result.stdout.split(' ')[0]).toBe(archive.sha256());
    });

    it('terminates the sandbox when the input archive turns invalid midway', async () => {
      const ref = await createSandbox();
      // 第一个文件合规（已交给沙箱内的 tar），之后是一个符号链接：校验在转出它的头部之前拒绝，整个沙箱被终止。
      const link = Buffer.alloc(512);
      link.write('link.bin', 0, 100, 'utf8');
      for (const [offset, value] of [[100, '0000644\0'], [108, '0000000\0'], [116, '0000000\0'], [124, '00000000000\0'], [136, '00000000000\0']] as const) link.write(value, offset, 'ascii');
      link.write('2', 156, 1, 'ascii');
      link.write('/etc/passwd', 157, 100, 'utf8');
      link.write('ustar\0', 257, 6, 'ascii');
      link.write('00', 263, 2, 'ascii');
      link.fill(0x20, 148, 156);
      let sum = 0;
      for (const byte of link) sum += byte;
      link.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
      const archive = streamedArchive('first.bin', 8 * MIB, [link, Buffer.alloc(1024)]);
      await expect(driver.copyInArchive(ref, archive.source())).rejects.toMatchObject({ code: 'SANDBOX_BAD_REQUEST' });
      await expect(driver.lookup(ref.id, ref.jobId)).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
      await expect(driver.execArgv(ref, ['true'], { timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
    });

    it('does not share anything between sandboxes', async () => {
      const first = await createSandbox();
      await driver.copyIn(first, [{ path: 'secret.bin', data: Buffer.from('secret') }]);
      await sh(first, `printf secret > /tmp/secret && printf secret > ${outputDirectory}/secret.${ext}`);
      const second = await createSandbox();
      const result = await run(second, ['sh', '-c', `ls -A ${Object.keys(template.tmpfs).join(' ')}; test ! -e /tmp/secret && echo isolated`]);
      expect(result.stdout).toContain('isolated');
      expect(result.stdout).not.toContain('secret');
      expect(await driver.copyOut(second)).toEqual([]);
    });
  });
}
