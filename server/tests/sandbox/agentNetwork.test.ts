// agent 沙箱的专用网络在 driver 中的处理（路线图 8.1）：用内存中的 Docker 桩覆盖失败路径——网络不是 internal、
// 接入后成员不止 agent-gw、容器创建或启动失败时，已建的网络都被删除，不留下网络或容器；销毁与到期清理一并删除网络。
// 真实 Docker（CI 中为 gVisor）下的网络隔离与生命周期在 tests/sandbox/docker/agentIsolation.test.ts。
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDockerSandboxDriver } from '../../src/sandbox/docker.ts';
import type { DockerApi, DockerContainerInfo, DockerNetworkInfo } from '../../src/sandbox/dockerApi.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const GATEWAY = 'agent-gw-1';

interface FakeOptions {
  internal?: boolean;
  extraMember?: boolean;
  failStart?: boolean;
  gatewayLabels?: Record<string, string>;
}

function fakeDocker(fake: FakeOptions = {}) {
  const containers = new Map<string, { id: string; name: string; labels: Record<string, string>; running: boolean; spec: Record<string, unknown> }>();
  const networks = new Map<string, { id: string; name: string; labels: Record<string, string>; members: Set<string> }>();
  containers.set('gw', { id: 'gw', name: GATEWAY, labels: fake.gatewayLabels ?? {}, running: true, spec: {} });
  const find = <T extends { id: string; name: string }>(map: Map<string, T>, key: string) => [...map.values()].find((item) => item.id === key || item.name === key);
  const api: Partial<DockerApi> = {
    async createContainer(name, spec) {
      const id = randomUUID();
      containers.set(id, { id, name, labels: { ...(spec.Labels as Record<string, string>) }, running: false, spec });
      return id;
    },
    async startContainer(id) {
      if (fake.failStart) throw Object.assign(new Error('start failed'), { code: 'EFAKE' });
      containers.get(id)!.running = true;
    },
    async inspectContainer(key) {
      const container = find(containers, key);
      return container ? ({ Id: container.id, Name: `/${container.name}`, Config: { Labels: container.labels }, State: { Running: container.running } } as DockerContainerInfo) : null;
    },
    async removeContainer(key) {
      const container = find(containers, key);
      if (!container) return;
      containers.delete(container.id);
      for (const network of networks.values()) network.members.delete(container.id);
    },
    async listContainers(label) {
      const [key, value] = label.split('=');
      return [...containers.values()].filter((item) => item.labels[key!] === value).map((item) => ({ Id: item.id, Names: [`/${item.name}`], Labels: item.labels }));
    },
    async createNetwork(spec) {
      const id = randomUUID();
      networks.set(id, { id, name: spec.Name as string, labels: { ...(spec.Labels as Record<string, string>) }, members: new Set(fake.extraMember ? ['intruder'] : []) });
      return id;
    },
    async inspectNetwork(key) {
      const network = find(networks, key);
      if (!network) return null;
      return {
        Id: network.id,
        Name: network.name,
        Internal: fake.internal ?? true,
        Labels: network.labels,
        Options: {},
        Containers: Object.fromEntries([...network.members].map((member, index) => [member, { Name: member, IPv4Address: `172.18.0.${index + 1}/16` }])),
      } as DockerNetworkInfo;
    },
    async connectNetwork(networkId, containerId) {
      networks.get(networkId)!.members.add(containerId);
    },
    async disconnectNetwork(networkId, containerId) {
      networks.get(networkId)?.members.delete(containerId);
    },
    async removeNetwork(id) {
      const network = networks.get(id);
      if (network && network.members.size > 0) throw new Error('network has active endpoints');
      networks.delete(id);
    },
    async listNetworks(label) {
      const [key, value] = label.split('=');
      return [...networks.values()].filter((item) => item.labels[key!] === value).map((item) => ({ Id: item.id, Name: item.name, Labels: item.labels }));
    },
  };
  return { api: api as DockerApi, containers, networks };
}

function driverFor(docker: DockerApi, overrides: Partial<Parameters<typeof createDockerSandboxDriver>[0]> = {}) {
  return createDockerSandboxDriver({ docker, runtime: 'runc', images: { agent: 'zhibiao-agent:test' }, maxActive: 8, agentGateway: GATEWAY, log: silentLog, ...overrides });
}

const sandboxes = (fake: ReturnType<typeof fakeDocker>) => [...fake.containers.values()].filter((item) => item.labels['zhibiao.sandbox'] === '1');

describe('agent sandbox network in the driver', () => {
  it('connects only the gateway and writes its address into /etc/hosts', async () => {
    const fake = fakeDocker();
    const ref = await driverFor(fake.api).create('agent', { jobId: randomUUID() });
    const [network] = [...fake.networks.values()];
    expect(network!.name).toBe(`zhibiao-sandbox-${ref.id}`);
    const container = sandboxes(fake)[0]!;
    const host = container.spec.HostConfig as Record<string, unknown>;
    expect(host.NetworkMode).toBe(network!.name);
    expect(host.ExtraHosts).toEqual(['agent-gw:172.18.0.1']);
  });

  it.each(['agent', 'agent-content'] as const)('creates %s sandboxes with the runtime configured for sandbox-runner (runsc in production)', async (template) => {
    const fake = fakeDocker();
    await driverFor(fake.api, { runtime: 'runsc' }).create(template, { jobId: randomUUID() });
    expect((sandboxes(fake)[0]!.spec.HostConfig as Record<string, unknown>).Runtime).toBe('runsc');
  });

  it.each([
    ['the network is not internal', { internal: false }],
    ['the network has another member', { extraMember: true }],
    ['the container cannot be started', { failStart: true }],
  ])('removes the network and creates no sandbox when %s', async (_name, options: FakeOptions) => {
    const fake = fakeDocker(options);
    await expect(driverFor(fake.api).create('agent', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(fake.networks.size).toBe(0);
    expect(sandboxes(fake)).toEqual([]);
    // 网关仍在运行、没有被删除。
    expect(fake.containers.get('gw')!.running).toBe(true);
  });

  it('refuses a gateway that is a sandbox or is missing, and an unconfigured gateway', async () => {
    const asSandbox = fakeDocker({ gatewayLabels: { 'zhibiao.sandbox': '1' } });
    await expect(driverFor(asSandbox.api).create('agent', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE', message: '沙箱网关不可用' });
    expect(asSandbox.networks.size).toBe(0);
    const fake = fakeDocker();
    await expect(driverFor(fake.api, { agentGateway: 'missing' }).create('agent', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    await expect(driverFor(fake.api, { agentGateway: null }).create('agent', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE', message: '沙箱网关未配置' });
    expect(fake.networks.size).toBe(0);
  });

  it('does not create networks for templates without network access', async () => {
    const fake = fakeDocker();
    await driverFor(fake.api, { images: { parse: 'zhibiao-parse:test' } }).create('parse', { jobId: randomUUID() });
    expect(fake.networks.size).toBe(0);
    const host = sandboxes(fake)[0]!.spec.HostConfig as Record<string, unknown>;
    expect(host.NetworkMode).toBe('none');
    expect(host.ExtraHosts).toEqual([]);
  });

  it('removes the network on destroy (also when the container is already gone), but not for another job', async () => {
    const fake = fakeDocker();
    const driver = driverFor(fake.api);
    const ref = await driver.create('agent', { jobId: randomUUID() });
    await driver.destroy({ ...ref, jobId: randomUUID() });
    expect(fake.networks.size).toBe(1);
    expect(sandboxes(fake)).toHaveLength(1);
    await driver.destroy(ref);
    expect(fake.networks.size).toBe(0);
    expect(sandboxes(fake)).toEqual([]);

    const leftover = await driver.create('agent', { jobId: randomUUID() });
    await fake.api.removeContainer(`zhibiao-sandbox-${leftover.id}`);
    await driver.destroy({ ...leftover, jobId: randomUUID() });
    expect(fake.networks.size).toBe(1);
    await driver.destroy(leftover);
    expect(fake.networks.size).toBe(0);
    expect(fake.containers.get('gw')!.running).toBe(true);
  });

  it('sweeps expired networks together with their sandboxes and keeps current ones', async () => {
    const fake = fakeDocker();
    const lifetime = 45 * 60_000;
    const past = driverFor(fake.api, { now: () => new Date(Date.now() - lifetime - 60_000) });
    const expired = await past.create('agent', { jobId: randomUUID() });
    const current = await driverFor(fake.api).create('agent', { jobId: randomUUID() });
    expect(await driverFor(fake.api).sweep()).toBe(1);
    expect([...fake.networks.values()].map((network) => network.name)).toEqual([`zhibiao-sandbox-${current.id}`]);
    expect(fake.containers.has(expired.id)).toBe(false);
  });
});
