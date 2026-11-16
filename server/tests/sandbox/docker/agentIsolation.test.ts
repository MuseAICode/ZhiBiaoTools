// agent 沙箱的隔离测试（路线图第 8 步 8.1，“测试方案”中网络、资源上限、逃逸面与沙箱互访的部分；不接模型）：
// - 与 parse / export 完全相同的一套用例（isolationSuite.ts：只读根文件系统、非 root 无能力、内存 / 进程数 / fork 炸弹 / 可写目录写满 /
//   CPU / 超时 / 中止、放入与取回校验、沙箱之间不共享文件），每项有去掉加固的对照组；
// - 网络：每个沙箱一个专用的 internal 网络，只通 agent-gw（这里是一个回答固定文字的桩容器，8.2 换成真正的 agent-gw）。
//   恶意样本为外网、DNS、元数据服务、宿主（Docker 网桥与宿主地址上监听所有地址的服务）、agent-gw 在其他网络上的地址、
//   另一个同时运行的 agent 沙箱；对照组为经 /etc/hosts 中的 agent-gw 访问桩成功，以及去掉 inhibit_ipv4 后同一探测连到宿主；
// - 专用网络的生命周期：随沙箱创建与删除、到期清理、创建失败时不残留，网关未配置、不可用或是沙箱时拒绝创建；
//   只剩网络的残留计入沙箱总数上限，占满时拒绝创建、清理后恢复（8.2d）；
// - 逃逸面与镜像内容：mount、unshare 失败，没有 Docker socket，镜像中有 rg / fd / jq、没有 Chromium、LibreOffice、OpenXmlHelper；
//   Pi 运行时（8.6b）的版本与 sandbox/agent/package-lock.json 一致，没有包管理器与原生模块，/opt/agent 只读。
// agent-content 与 agent 只有沙箱最长存活不同（tests/sandbox/templates.test.ts 核对），这里只跑 agent。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countSandboxes } from '../../../src/sandbox/docker.ts';
import { buildNetworkSpec, SANDBOX_TEMPLATES } from '../../../src/sandbox/templates.ts';
import { docker, dockerRequest, sandboxEnv } from './env.ts';
import { bridgeGateway, createIsolationHarness, defineIsolationSuite } from './isolationSuite.ts';

const agent = SANDBOX_TEMPLATES.agent;
const image = sandboxEnv.agentImage ?? '';
const suffix = randomUUID();
/** agent-gw 的桩：普通容器（不带沙箱标签，runc，与生产的 agent-gw 一样不是沙箱），在 8080 上回答 gateway。 */
const gatewayName = `zhibiao-test-agent-gw-${suffix}`;
/** 桩自己的网络（生产中 agent-gw 在 sandbox-control 一侧的网络）。 */
const gatewayHomeNetwork = `zhibiao-test-agent-gw-home-${suffix}`;
const GATEWAY_PORT = 8080;

const harness = createIsolationHarness('agent', image, gatewayName);
const { driver, makeDriver, createSandbox, run, sh, probe } = harness;

async function containerAddress(containerName: string, network: string): Promise<string> {
  const { json } = await dockerRequest('GET', `/containers/${containerName}/json`);
  return (json as { NetworkSettings: { Networks: Record<string, { IPAddress: string }> } }).NetworkSettings.Networks[network]!.IPAddress;
}

interface NetworkInfo {
  Name: string;
  Internal: boolean;
  EnableIPv6: boolean;
  Options: Record<string, string>;
  Labels: Record<string, string>;
  IPAM: { Config: Array<{ Subnet?: string; Gateway?: string }> | null };
  Containers: Record<string, { Name: string; IPv4Address: string }> | null;
}

async function inspectNetwork(name: string): Promise<NetworkInfo | null> {
  const { status, json } = await dockerRequest('GET', `/networks/${name}`);
  return status === 200 ? (json as NetworkInfo) : null;
}

/** 宿主自己的 IPv4 地址（测试进程在宿主网络上），不含回环与 Docker 网桥。 */
function hostAddresses(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([name]) => !name.startsWith('docker') && !name.startsWith('br-') && !name.startsWith('veth') && name !== 'lo')
    .flatMap(([, entries]) => (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address));
}

/** 在沙箱内依次探测 TCP 连接、DNS 解析和 UDP 发送。HTTP 只对 agent-gw 做（读回桩的回答）。 */
const networkProbe = (targets: Array<[string, number]>) => `
  const net = require('net'), dns = require('dns'), dgram = require('dgram'), fs = require('fs'), http = require('http');
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
  const get = (host, port) => new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: 3000 }, (res) => { let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve(body)); });
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.on('error', (error) => resolve(error.code));
  });
  (async () => {
    const interfaces = fs.readFileSync('/proc/net/dev', 'utf8').split('\\n').slice(2).map((line) => line.split(':')[0].trim()).filter(Boolean);
    const result = { interfaces, tcp: {}, dns: {} };
    for (const [host, port] of ${JSON.stringify(targets)}) result.tcp[host + ':' + port] = await tcp(host, port);
    for (const name of ['agent-gw', 'redis', 'postgres', 's3', 'sandbox-runner', 'example.com', 'host.docker.internal', ${JSON.stringify(gatewayName)}]) result.dns[name] = await lookup(name);
    result.udp = await udp();
    result.gateway = await get('agent-gw', ${GATEWAY_PORT});
    console.log(JSON.stringify(result));
  })();
`;

interface NetworkProbe {
  interfaces: string[];
  tcp: Record<string, string>;
  dns: Record<string, string>;
  udp: string;
  gateway: string;
}

describe.runIf(sandboxEnv.agentImage)('agent sandbox', () => {
  beforeAll(async () => {
    expect((await dockerRequest('POST', '/networks/create', { Name: gatewayHomeNetwork, Internal: true })).status).toBe(201);
    const created = await dockerRequest('POST', `/containers/create?name=${gatewayName}`, {
      Image: image,
      Entrypoint: ['node'],
      Cmd: ['-e', `require('http').createServer((req, res) => res.end('gateway')).listen(${GATEWAY_PORT}, '0.0.0.0')`],
      User: '10001:10001',
      HostConfig: { NetworkMode: gatewayHomeNetwork, Runtime: 'runc', CapDrop: ['ALL'] },
    });
    expect(created.status).toBe(201);
    expect((await dockerRequest('POST', `/containers/${gatewayName}/start`)).status).toBe(204);
  });
  afterAll(async () => {
    await dockerRequest('DELETE', `/containers/${gatewayName}?force=true`);
    await dockerRequest('DELETE', `/networks/${gatewayHomeNetwork}`);
  });

  defineIsolationSuite({ template: 'agent', image, codeDirectory: '/opt/agent', outputExtension: 'md', validOutput: ['notes.md', 'images/figure-1.png'], disallowedOutput: 'payload.sh' }, harness);

  describe('network', () => {
    let server: Server;
    let port: number;

    beforeAll(async () => {
      // 宿主上监听所有地址的服务（模拟宿主上的数据库、Redis、sandbox-runner 等）。
      server = createServer((socket) => {
        socket.on('error', () => {});
        socket.end('hello');
      });
      await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
      port = (server.address() as { port: number }).port;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function maliciousTargets(): Promise<Array<[string, number]>> {
      return [
        [await bridgeGateway(), port],
        ...hostAddresses().map((address): [string, number] => [address, port]),
        // agent-gw 在它自己网络上的地址：不在沙箱的网络中。
        [await containerAddress(gatewayName, gatewayHomeNetwork), GATEWAY_PORT],
        ['169.254.169.254', 80],
        ['1.1.1.1', 443],
        ['8.8.8.8', 53],
        ['10.0.0.1', 5432],
      ];
    }

    it('only reaches agent-gw, through the address in /etc/hosts', async () => {
      const ref = await createSandbox();
      const network = (await inspectNetwork(`zhibiao-sandbox-${ref.id}`))!;
      const gatewayAddress = network.Containers ? Object.values(network.Containers).find((entry) => entry.Name === gatewayName)!.IPv4Address.split('/')[0]! : '';
      const result = await probe<NetworkProbe>(ref, networkProbe([[gatewayAddress, GATEWAY_PORT], ...(await maliciousTargets())]));
      expect(result.interfaces.sort()).toEqual(['eth0', 'lo']);
      // 对照组：同一个探测经 agent-gw 的名字与地址都能连到桩。
      expect(result.gateway).toBe('gateway');
      expect(result.dns['agent-gw']).toBe(`resolved:${gatewayAddress}`);
      const { [`${gatewayAddress}:${GATEWAY_PORT}`]: gateway, ...others } = result.tcp;
      expect(gateway).toBe('connected');
      for (const [target, outcome] of Object.entries(others)) expect(outcome, target).not.toBe('connected');
      // 除 agent-gw（/etc/hosts）之外的名字都解析不了；runc 下 Docker 的内置 DNS 只认得本网络中的两个容器（沙箱与 agent-gw），
      // 内部网络不向外转发查询；gVisor 下内置 DNS 不可用。
      for (const name of ['redis', 'postgres', 's3', 'sandbox-runner', 'example.com', 'host.docker.internal']) expect(result.dns[name], name).not.toMatch(/^resolved/);
      expect(result.udp).not.toBe('sent');
    });

    it('control: without inhibit_ipv4 the same network reaches the host through the bridge address', async () => {
      const weakened = makeDriver({
        buildNetwork: (name, options) => {
          const spec = buildNetworkSpec(name, options);
          delete (spec.Options as Record<string, string>)['com.docker.network.bridge.inhibit_ipv4'];
          return spec;
        },
      });
      const ref = await createSandbox(weakened);
      const network = (await inspectNetwork(`zhibiao-sandbox-${ref.id}`))!;
      const bridgeAddress = network.IPAM.Config!.find((entry) => entry.Gateway?.includes('.'))!.Gateway!;
      const result = await probe<NetworkProbe>(ref, networkProbe([[bridgeAddress, port]]), weakened);
      expect(result.tcp[`${bridgeAddress}:${port}`]).toBe('connected');
    });

    it('cannot reach another agent sandbox running at the same time', async () => {
      const first = await createSandbox();
      const second = await createSandbox();
      const secondAddress = await containerAddress(`zhibiao-sandbox-${second.id}`, `zhibiao-sandbox-${second.id}`);
      const secondNetwork = (await inspectNetwork(`zhibiao-sandbox-${second.id}`))!;
      const gatewayOnSecond = Object.values(secondNetwork.Containers!).find((entry) => entry.Name === gatewayName)!.IPv4Address.split('/')[0]!;
      // 第二个沙箱中监听 9000 端口 8 秒。
      const listening = run(second, ['node', '-e', `require('net').createServer((s) => { s.on('error', () => {}); s.end('second'); }).listen(9000, '0.0.0.0'); setTimeout(() => process.exit(0), 8000);`], 30_000);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const fromFirst = await probe<NetworkProbe>(first, networkProbe([[secondAddress, 9000], [gatewayOnSecond, GATEWAY_PORT]]));
      // 对照组：第二个沙箱自己能连到这个端口（监听确实在）。
      const fromSecond = await probe<NetworkProbe>(second, networkProbe([[secondAddress, 9000]]));
      await listening;
      expect(fromFirst.tcp[`${secondAddress}:9000`]).not.toBe('connected');
      expect(fromFirst.tcp[`${gatewayOnSecond}:${GATEWAY_PORT}`]).not.toBe('connected');
      expect(fromSecond.tcp[`${secondAddress}:9000`]).toBe('connected');
      // 两个沙箱各自的 agent-gw 都可用。
      expect(fromFirst.gateway).toBe('gateway');
      expect(fromSecond.gateway).toBe('gateway');
    });
  });

  describe('dedicated network lifecycle', () => {
    it('creates an internal network with only the sandbox and agent-gw, and removes it with the sandbox', async () => {
      const ref = await createSandbox();
      const name = `zhibiao-sandbox-${ref.id}`;
      const network = (await inspectNetwork(name))!;
      expect(network.Internal).toBe(true);
      expect(network.EnableIPv6).toBe(false);
      expect(network.Options['com.docker.network.bridge.inhibit_ipv4']).toBe('true');
      expect(network.Labels).toMatchObject({ 'zhibiao.sandbox': '1', 'zhibiao.sandbox.template': 'agent', 'zhibiao.sandbox.job': ref.jobId, 'zhibiao.sandbox.expires': String(ref.expiresAt.getTime()) });
      expect(Object.values(network.Containers ?? {}).map((entry) => entry.Name).sort()).toEqual([gatewayName, name].sort());
      const { json } = await dockerRequest('GET', `/containers/${name}/json`);
      const info = json as { HostConfig: { ExtraHosts: string[]; Dns: string[] }; NetworkSettings: { Networks: Record<string, unknown> } };
      expect(Object.keys(info.NetworkSettings.Networks)).toEqual([name]);
      expect(info.HostConfig.ExtraHosts).toHaveLength(1);
      expect(info.HostConfig.ExtraHosts[0]).toMatch(/^agent-gw:\d+\.\d+\.\d+\.\d+$/);

      // 任务 id 不符：容器与网络都不动。
      await driver.destroy({ ...ref, jobId: randomUUID() });
      expect(await inspectNetwork(name)).not.toBeNull();
      await driver.destroy(ref);
      expect(await docker.inspectContainer(name)).toBeNull();
      expect(await inspectNetwork(name)).toBeNull();
      // agent-gw 不受影响：仍在运行、仍在自己的网络上。
      const gateway = (await dockerRequest('GET', `/containers/${gatewayName}/json`)).json as { State: { Running: boolean }; NetworkSettings: { Networks: Record<string, unknown> } };
      expect(gateway.State.Running).toBe(true);
      expect(Object.keys(gateway.NetworkSettings.Networks)).toEqual([gatewayHomeNetwork]);
    });

    it('sweeps expired sandboxes together with their networks, and leftover networks without a container', async () => {
      const past = makeDriver({ now: () => new Date(Date.now() - agent.lifetimeMs - 60_000) });
      const expired = await createSandbox(past);
      // 只剩网络的残留（例如创建中途失败、清理也失败）：直接删掉容器，留下网络。
      const leftover = await createSandbox(past);
      await docker.removeContainer(`zhibiao-sandbox-${leftover.id}`);
      const current = await createSandbox();
      expect(await driver.sweep()).toBeGreaterThanOrEqual(1);
      expect(await docker.inspectContainer(`zhibiao-sandbox-${expired.id}`)).toBeNull();
      expect(await inspectNetwork(`zhibiao-sandbox-${expired.id}`)).toBeNull();
      expect(await inspectNetwork(`zhibiao-sandbox-${leftover.id}`)).toBeNull();
      expect(await inspectNetwork(`zhibiao-sandbox-${current.id}`)).not.toBeNull();
      expect((await probe<NetworkProbe>(current, networkProbe([]))).gateway).toBe('gateway');
    });

    it('counts leftover networks toward the sandbox cap: refuses to create while they fill it, and recovers after cleanup', async () => {
      // 8.2d（#71 确认时登记）：上限同时计入带沙箱标签的专用网络，只剩网络的残留不能累积到耗尽地址池。
      const listNetworks = async () => (await docker.listNetworks('zhibiao.sandbox=1')).length;
      const existing = await countSandboxes(docker);
      const limited = makeDriver({ maxActive: existing + 2 });
      const past = makeDriver({ maxActive: existing + 2, now: () => new Date(Date.now() - agent.lifetimeMs - 60_000) });
      // 两个只剩网络的残留（容器已删，例如清理失败）：一个未到期、一个已到期。
      const leftover = await createSandbox(limited);
      await docker.removeContainer(`zhibiao-sandbox-${leftover.id}`);
      const expiredLeftover = await createSandbox(past);
      await docker.removeContainer(`zhibiao-sandbox-${expiredLeftover.id}`);
      expect(await inspectNetwork(`zhibiao-sandbox-${leftover.id}`)).not.toBeNull();
      const networksBefore = await listNetworks();

      const busy = await limited.create('agent', { jobId: randomUUID() }).then(() => null, (error: unknown) => error);
      expect(busy).toMatchObject({ code: 'SANDBOX_BUSY', message: '沙箱数已达上限，请稍后重试' });
      // 拒绝时不新建网络。
      expect(await listNetworks()).toBe(networksBefore);

      // 到期清理删掉已到期的残留网络后可以再创建；销毁未到期的残留（容器已不存在）后同样。
      await limited.sweep();
      expect(await inspectNetwork(`zhibiao-sandbox-${expiredLeftover.id}`)).toBeNull();
      await createSandbox(limited);
      await expect(limited.create('agent', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_BUSY' });
      await limited.destroy(leftover);
      expect(await inspectNetwork(`zhibiao-sandbox-${leftover.id}`)).toBeNull();
      await createSandbox(limited);
    });

    it('leaves no network behind when the container cannot be created', async () => {
      const before = (await dockerRequest('GET', `/networks?filters=${encodeURIComponent(JSON.stringify({ label: ['zhibiao.sandbox=1'] }))}`)).json as unknown[];
      const broken = makeDriver({ images: { agent: 'zhibiao-agent-does-not-exist:missing' } });
      await expect(broken.create('agent', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
      const after = (await dockerRequest('GET', `/networks?filters=${encodeURIComponent(JSON.stringify({ label: ['zhibiao.sandbox=1'] }))}`)).json as unknown[];
      expect(after.length).toBe(before.length);
    });

    it('refuses to create an agent sandbox without a usable gateway', async () => {
      await expect(makeDriver({ agentGateway: null }).create('agent', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
      await expect(makeDriver({ agentGateway: `zhibiao-test-missing-${randomUUID()}` }).create('agent', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
      // 网关是另一个沙箱：拒绝（否则一个沙箱会被接进另一个沙箱的网络）。
      const other = await createSandbox();
      await expect(makeDriver({ agentGateway: `zhibiao-sandbox-${other.id}` }).create('agent', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
      const network = (await inspectNetwork(`zhibiao-sandbox-${other.id}`))!;
      expect(Object.keys(network.Containers ?? {})).toHaveLength(2);
    });
  });

  describe('escape surface and image contents', () => {
    it('cannot mount filesystems or create namespaces, and has no Docker socket', async () => {
      const ref = await createSandbox();
      const result = await run(ref, [
        'sh',
        '-c',
        'mkdir -p /tmp/m; mount -t tmpfs none /tmp/m 2>/dev/null && echo mount:ok || echo mount:denied; ' +
          'unshare -m true 2>/dev/null && echo unshare-mount:ok || echo unshare-mount:denied; ' +
          'unshare -n true 2>/dev/null && echo unshare-net:ok || echo unshare-net:denied; ' +
          'unshare -U -r -m true 2>/dev/null && echo unshare-user:ok || echo unshare-user:denied; ' +
          'test -e /var/run/docker.sock -o -e /run/docker.sock && echo docker-socket:present || echo docker-socket:absent',
      ]);
      const outcomes = Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split(':') as [string, string]));
      console.info(JSON.stringify({ runtime: sandboxEnv.runtime, template: 'agent', escapeSurface: outcomes }));
      expect(outcomes).toMatchObject({ mount: 'denied', 'unshare-mount': 'denied', 'unshare-net': 'denied', 'docker-socket': 'absent' });
      // 先建用户命名空间再建挂载命名空间：runc 下被 Docker 默认的 seccomp 拒绝；gVisor 下在 Sentry 内实现，即使成功也只在沙箱自己的内核里，
      // 不碰宿主内核，所以只对 runc 断言。
      if (sandboxEnv.runtime === 'runc') expect(outcomes['unshare-user']).toBe('denied');
    });

    it('ships rg, fd and jq, and no browser, office suite or OpenXmlHelper', async () => {
      const ref = await createSandbox();
      // 不经管道截断：`rg --version | head -1` 中 head 先退出时 rg 偶发向 stderr 写 "error: broken pipe"（#74 CI），sh 要求 stderr 为空。
      const tools = await sh(ref, 'rg --version; fd --version; jq --version');
      expect(tools.stdout).toMatch(/^ripgrep \d/m);
      // Debian 的 fd 以 fdfind 为名打印版本（镜像中的 fd 是指向 fdfind 的链接），两种名字都算。
      expect(tools.stdout).toMatch(/^fd(find)? \d/m);
      expect(tools.stdout).toMatch(/^jq-\d/m);
      const absent = await sh(
        ref,
        'for tool in chromium chromium-browser chrome google-chrome headless_shell soffice libreoffice openxmlhelper dotnet python3 python; do command -v "$tool" || true; done; ls /opt',
      );
      expect(absent.stdout.trim()).toBe('agent');
    });

    it('ships the Pi runtime pinned by sandbox/agent/package-lock.json, read-only, without npm or native addons', async () => {
      const ref = await createSandbox();
      const lock = JSON.parse(readFileSync(new URL('../../../sandbox/agent/package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version?: string }> };
      const versions = await sh(
        ref,
        `cd /opt/agent && node -p "['pi-coding-agent','pi-ai'].map((name) => require('./node_modules/@earendil-works/' + name + '/package.json').version).join(' ')"`,
      );
      expect(versions.stdout.trim()).toBe(`${lock.packages['node_modules/@earendil-works/pi-coding-agent']!.version} ${lock.packages['node_modules/@earendil-works/pi-ai']!.version}`);
      // 镜像中没有包管理器与原生模块；/opt/agent 属主为 root，沙箱用户不能写。
      const extras = await sh(ref, 'command -v npm npx corepack yarn || true; find / -xdev -name "*.node" -type f 2>/dev/null | head -5; find /opt/agent ! -user root | head -5; touch /opt/agent/x 2>/dev/null && echo writable || true');
      expect(extras.stdout.trim()).toBe('');
    });
  });
});
