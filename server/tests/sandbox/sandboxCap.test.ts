// sandbox-runner 对同时存在的沙箱总数的硬上限（路线图第 6 步 6.6，#28 确认时登记）：计入全部带沙箱标签的容器，
// 含已停止、已到期但尚未清理的残留沙箱；超出时拒绝创建（429 SANDBOX_BUSY，文案“沙箱数已达上限，请稍后重试”）；
// 清理（销毁、到期删除）后可以再创建。这里用内存中的 Docker 桩覆盖计数规则和接口，真实 Docker 下的同一组用例在
// tests/sandbox/docker/isolation.test.ts 的 “sandbox lifecycle”。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createSandboxRunnerClient } from '../../src/sandbox/client.ts';
import { createDockerSandboxDriver } from '../../src/sandbox/docker.ts';
import type { DockerApi, DockerContainerInfo } from '../../src/sandbox/dockerApi.ts';
import { SANDBOX_BUSY_MESSAGE } from '../../src/sandbox/driver.ts';
import { buildSandboxRunnerApp } from '../../src/sandbox/runnerApp.ts';
import { SANDBOX_LABEL, SANDBOX_LABEL_EXPIRES, SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';

const TOKEN = 'cap-test-token-'.padEnd(48, 'x');
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

interface FakeContainer {
  id: string;
  name: string;
  labels: Record<string, string>;
  running: boolean;
}

/** 只实现创建、列出、查看、停止、删除的 Docker 桩：容器（含已停止的）一直在，直到被删除。 */
function fakeDocker() {
  const containers = new Map<string, FakeContainer>();
  const api = {
    async ping() {},
    async runtimes() {
      return ['runc'];
    },
    async createContainer(name: string, spec: Record<string, unknown>) {
      const id = randomUUID().replaceAll('-', '');
      containers.set(id, { id, name, labels: { ...(spec.Labels as Record<string, string>) }, running: false });
      return id;
    },
    async startContainer(id: string) {
      containers.get(id)!.running = true;
    },
    async inspectContainer(nameOrId: string): Promise<DockerContainerInfo | null> {
      const container = [...containers.values()].find((item) => item.id === nameOrId || item.name === nameOrId);
      if (!container) return null;
      return { Id: container.id, Name: `/${container.name}`, Config: { Labels: container.labels }, State: { Running: container.running } } as DockerContainerInfo;
    },
    async killContainer(id: string) {
      const container = containers.get(id);
      if (container) container.running = false;
    },
    async removeContainer(nameOrId: string) {
      for (const container of containers.values()) {
        if (container.id === nameOrId || container.name === nameOrId) containers.delete(container.id);
      }
    },
    async listContainers(label: string) {
      const [key, value] = label.split('=');
      return [...containers.values()]
        .filter((container) => container.labels[key!] === value)
        .map((container) => ({ Id: container.id, Names: [`/${container.name}`], Labels: container.labels }));
    },
  };
  return { api: api as unknown as DockerApi, containers };
}

function driverFor(docker: DockerApi, maxActive: number, now: () => Date = () => new Date()) {
  return createDockerSandboxDriver({ docker, runtime: 'runc', images: { parse: 'zhibiao-parse:test' }, maxActive, log: silentLog, now });
}

describe('sandbox total cap', () => {
  it('counts stopped and expired-but-unswept sandboxes, then allows creating again after cleanup', async () => {
    const { api, containers } = fakeDocker();
    const driver = driverFor(api, 3);
    const running = await driver.create('parse', { jobId: randomUUID() });
    const stopped = await driver.create('parse', { jobId: randomUUID() });
    const expired = await driver.create('parse', { jobId: randomUUID() });
    // 已停止（例如超时被终止）：仍然计数。
    await api.killContainer([...containers.values()].find((item) => item.name.endsWith(stopped.id))!.id);
    // 已到期但还没被清理：同样计数。
    const expiredContainer = [...containers.values()].find((item) => item.name.endsWith(expired.id))!;
    expiredContainer.labels[SANDBOX_LABEL_EXPIRES] = String(Date.now() - 1_000);

    const busy = await driver.create('parse', { jobId: randomUUID() }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(busy).toMatchObject({ code: 'SANDBOX_BUSY', message: SANDBOX_BUSY_MESSAGE });
    expect(SANDBOX_BUSY_MESSAGE).toBe('沙箱数已达上限，请稍后重试');
    expect([...containers.values()].filter((item) => item.labels[SANDBOX_LABEL] === '1')).toHaveLength(3);

    // 到期清理删掉过期的那个，空出一个名额。
    expect(await driver.sweep()).toBe(1);
    const again = await driver.create('parse', { jobId: randomUUID() });
    await expect(driver.create('parse', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_BUSY' });
    // 销毁已停止的残留（解析任务在 finally 中 destroy）后同样空出名额。
    await driver.destroy(stopped);
    await driver.create('parse', { jobId: randomUUID() });
    expect(containers.size).toBe(3);
    expect([running.id, again.id].every((id) => [...containers.values()].some((item) => item.name.endsWith(id)))).toBe(true);
  });

  it('counts sandboxes created by an earlier sandbox-runner process (state lives in container labels)', async () => {
    const { api } = fakeDocker();
    await driverFor(api, 2).create('parse', { jobId: randomUUID() });
    await driverFor(api, 2).create('parse', { jobId: randomUUID() });
    await expect(driverFor(api, 2).create('parse', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_BUSY' });
  });

  it('checks the cap and creates serially, so concurrent requests cannot overshoot it', async () => {
    const { api, containers } = fakeDocker();
    const driver = driverFor(api, 4);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => driver.create('parse', { jobId: randomUUID() })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(4);
    expect(results.filter((result) => result.status === 'rejected').every((result) => (result as PromiseRejectedResult).reason.code === 'SANDBOX_BUSY')).toBe(true);
    expect(containers.size).toBe(4);
  });

  describe('over http', () => {
    let app: FastifyInstance | undefined;
    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it('answers 429 SANDBOX_BUSY with the message, and the worker client keeps the code and message', async () => {
      const { api } = fakeDocker();
      const driver = driverFor(api, 1);
      app = await buildSandboxRunnerApp({ driver, docker: api, runtime: 'runc', token: TOKEN, logLevel: 'silent' });
      const first = await app.inject({
        method: 'POST',
        url: '/v1/sandboxes',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { template: 'parse', jobId: randomUUID() },
      });
      expect(first.statusCode).toBe(201);
      const second = await app.inject({
        method: 'POST',
        url: '/v1/sandboxes',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { template: 'parse', jobId: randomUUID() },
      });
      expect(second.statusCode).toBe(429);
      expect(second.json()).toMatchObject({ error: { code: 'SANDBOX_BUSY', message: '沙箱数已达上限，请稍后重试' } });

      await app.listen({ host: '127.0.0.1', port: 0 });
      const client = createSandboxRunnerClient({ url: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, token: TOKEN });
      await expect(client.create('parse', { jobId: randomUUID() })).rejects.toMatchObject({ code: 'SANDBOX_BUSY', message: SANDBOX_BUSY_MESSAGE });
      // 删除（到期清理或销毁）后可以再创建。
      const later = driverFor(api, 1, () => new Date(Date.now() + SANDBOX_TEMPLATES.parse.lifetimeMs + 1_000));
      expect(await later.sweep()).toBe(1);
      expect((await client.create('parse', { jobId: randomUUID() })).template).toBe('parse');
    });
  });
});
