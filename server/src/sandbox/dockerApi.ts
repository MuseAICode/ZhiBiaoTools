// Docker Engine API 的最小客户端（经 unix socket），只在 sandbox-runner 进程中使用。不依赖第三方库。
// 只实现沙箱需要的调用：ping、info、创建 / 启动 / 查看 / 终止 / 删除 / 列出容器、exec（含经升级连接的标准输入输出），
// 以及 agent 沙箱的专用网络（8.1）：创建 / 查看 / 接入 / 断开 / 删除 / 列出网络。
// Docker 的错误正文可能含镜像名、路径等内部信息，只写日志，不返回给调用方。
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { PassThrough, type Readable } from 'node:stream';

/** Docker 25 起支持；Docker 29 的最低版本也是 1.44。 */
const API_PREFIX = '/v1.44';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class DockerApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'DockerApiError';
    this.statusCode = statusCode;
  }
}

export interface DockerContainerInfo {
  Id: string;
  Name: string;
  Created: string;
  Config: { Labels: Record<string, string> | null };
  State: { Running: boolean; Status: string };
  HostConfig: Record<string, unknown>;
}

export interface DockerNetworkInfo {
  Id: string;
  Name: string;
  Internal: boolean;
  Labels: Record<string, string> | null;
  Options: Record<string, string> | null;
  /** 已接入的容器（键为容器 id）及其在本网络中的地址（如 172.18.0.1/16）。 */
  Containers: Record<string, { Name: string; IPv4Address: string }> | null;
}

export interface DockerExecStream {
  /** 进程的标准输出（已从 Docker 的多路复用帧中拆出）。消费方应读完或销毁它。 */
  readonly stdout: Readable;
  /** 连接结束（进程退出或连接断开）时完成；流出错时拒绝。 */
  readonly done: Promise<void>;
  /** 断开连接（中止时用；进程本身由调用方终止容器）。 */
  abort(): void;
}

export interface DockerApi {
  ping(): Promise<void>;
  /** 已登记的容器运行时名称（runc、runsc 等）。 */
  runtimes(): Promise<string[]>;
  createContainer(name: string, spec: Record<string, unknown>): Promise<string>;
  startContainer(id: string): Promise<void>;
  /** 不存在时返回 null。 */
  inspectContainer(id: string): Promise<DockerContainerInfo | null>;
  killContainer(id: string): Promise<void>;
  /** 强制删除（含 tmpfs）；不存在时也成功。 */
  removeContainer(id: string): Promise<void>;
  /** 按标签列出容器（含已停止的），返回 id、名称和标签。 */
  listContainers(label: string): Promise<Array<{ Id: string; Names: string[]; Labels: Record<string, string> }>>;
  /** 创建网络，返回网络 id。 */
  createNetwork(spec: Record<string, unknown>): Promise<string>;
  /** 不存在时返回 null。 */
  inspectNetwork(id: string): Promise<DockerNetworkInfo | null>;
  connectNetwork(networkId: string, containerId: string): Promise<void>;
  /** 强制断开；网络或容器已不存在、已断开时也成功。 */
  disconnectNetwork(networkId: string, containerId: string): Promise<void>;
  /** 删除网络；不存在时也成功。 */
  removeNetwork(id: string): Promise<void>;
  /** 按标签列出网络，返回 id、名称和标签。 */
  listNetworks(label: string): Promise<Array<{ Id: string; Name: string; Labels: Record<string, string> }>>;
  createExec(containerId: string, options: { argv: readonly string[]; stdin: boolean }): Promise<string>;
  /**
   * 启动 exec 并接上标准输入输出：stdin 写完后半关闭连接（进程读到 EOF）；onStderr 收到标准错误的数据块。
   * stdin 为流时按背压逐块写入，不整体缓存；流出错时不半关闭（调用方负责终止）。
   */
  startExec(execId: string, options: { stdin?: Buffer | Readable; onStderr?: (chunk: Buffer) => void }): Promise<DockerExecStream>;
  inspectExec(execId: string): Promise<{ Running: boolean; ExitCode: number | null }>;
}

async function readBody(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += (chunk as Buffer).length;
    if (size > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw new DockerApiError(502, 'docker response too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * 从 Docker 的多路复用流中拆出标准输出、标准错误：每帧 8 字节头（第 1 字节 1 = stdout、2 = stderr，后 4 字节为大端长度）。
 * 下游（stdout）背压时暂停读取连接。
 */
function demultiplex(socket: Socket, head: Buffer, stdout: PassThrough, onStderr: ((chunk: Buffer) => void) | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    let pending: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        stdout.destroy(error);
        reject(error);
      } else {
        stdout.end();
        resolve();
      }
    };
    const drain = () => {
      while (pending.length >= 8) {
        const stream = pending[0];
        const length = pending.readUInt32BE(4);
        if (pending.length < 8 + length) return;
        const payload = pending.subarray(8, 8 + length);
        pending = pending.subarray(8 + length);
        if (stream === 1) {
          if (!stdout.write(payload)) {
            socket.pause();
            stdout.once('drain', () => socket.resume());
          }
        } else if (stream === 2) {
          onStderr?.(Buffer.from(payload));
        }
      }
    };
    socket.on('data', (chunk: Buffer) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      drain();
    });
    socket.on('end', () => finish(pending.length > 0 ? new DockerApiError(502, 'docker exec stream truncated') : undefined));
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish());
    // 下游被提前销毁（例如取回的归档超过上限）时断开连接。
    stdout.on('close', () => {
      if (!settled) socket.destroy();
    });
    drain();
  });
}

export function createDockerApi(socketPath: string): DockerApi {
  async function call(method: string, path: string, body?: unknown, okStatuses: readonly number[] = [200, 201, 204]): Promise<{ status: number; data: unknown }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          method,
          path: `${API_PREFIX}${path}`,
          headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
          timeout: REQUEST_TIMEOUT_MS,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new DockerApiError(504, 'docker request timed out')));
      req.on('error', reject);
      req.end(payload);
    });
    const raw = await readBody(response);
    const status = response.statusCode ?? 0;
    if (!okStatuses.includes(status)) {
      let message = `docker api ${method} ${path.split('?', 1)[0]} returned ${status}`;
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as { message?: unknown };
        if (typeof parsed.message === 'string') message += `: ${parsed.message.slice(0, 500)}`;
      } catch {
        // 不是 JSON，不附带正文。
      }
      throw new DockerApiError(status, message);
    }
    const text = raw.toString('utf8');
    return { status, data: text && /json/.test(String(response.headers['content-type'])) ? JSON.parse(text) : text };
  }

  const encode = (value: string) => encodeURIComponent(value);

  return {
    async ping() {
      await call('GET', '/_ping');
    },
    async runtimes() {
      const { data } = await call('GET', '/info');
      const runtimes = (data as { Runtimes?: Record<string, unknown> }).Runtimes ?? {};
      return Object.keys(runtimes);
    },
    async createContainer(name, spec) {
      const { data } = await call('POST', `/containers/create?name=${encode(name)}`, spec);
      return (data as { Id: string }).Id;
    },
    async startContainer(id) {
      await call('POST', `/containers/${encode(id)}/start`, undefined, [204, 304]);
    },
    async inspectContainer(id) {
      try {
        const { data } = await call('GET', `/containers/${encode(id)}/json`);
        return data as DockerContainerInfo;
      } catch (error) {
        if (error instanceof DockerApiError && error.statusCode === 404) return null;
        throw error;
      }
    },
    async killContainer(id) {
      // 容器已停止（409）或不存在（404）时不算失败。
      await call('POST', `/containers/${encode(id)}/kill?signal=SIGKILL`, undefined, [204, 404, 409]);
    },
    async removeContainer(id) {
      await call('DELETE', `/containers/${encode(id)}?force=true&v=true`, undefined, [204, 404, 409]);
    },
    async listContainers(label) {
      const filters = encode(JSON.stringify({ label: [label] }));
      const { data } = await call('GET', `/containers/json?all=true&filters=${filters}`);
      return data as Array<{ Id: string; Names: string[]; Labels: Record<string, string> }>;
    },
    async createNetwork(spec) {
      const { data } = await call('POST', '/networks/create', spec);
      return (data as { Id: string }).Id;
    },
    async inspectNetwork(id) {
      try {
        const { data } = await call('GET', `/networks/${encode(id)}`);
        return data as DockerNetworkInfo;
      } catch (error) {
        if (error instanceof DockerApiError && error.statusCode === 404) return null;
        throw error;
      }
    },
    async connectNetwork(networkId, containerId) {
      await call('POST', `/networks/${encode(networkId)}/connect`, { Container: containerId, EndpointConfig: {} }, [200]);
    },
    async disconnectNetwork(networkId, containerId) {
      // 网络或容器不存在（404）、容器未接入该网络（Docker 返回 500 / 403 视版本而定）时由调用方按删除网络的结果判断。
      await call('POST', `/networks/${encode(networkId)}/disconnect`, { Container: containerId, Force: true }, [200, 404]);
    },
    async removeNetwork(id) {
      await call('DELETE', `/networks/${encode(id)}`, undefined, [204, 404]);
    },
    async listNetworks(label) {
      const filters = encode(JSON.stringify({ label: [label] }));
      const { data } = await call('GET', `/networks?filters=${filters}`);
      return (data as Array<{ Id: string; Name: string; Labels: Record<string, string> | null }>).map((network) => ({ Id: network.Id, Name: network.Name, Labels: network.Labels ?? {} }));
    },
    async createExec(containerId, options) {
      const { data } = await call('POST', `/containers/${encode(containerId)}/exec`, {
        AttachStdin: options.stdin,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Privileged: false,
        Cmd: options.argv,
        Env: [],
      });
      return (data as { Id: string }).Id;
    },
    startExec(execId, options) {
      return new Promise<DockerExecStream>((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
        const req = httpRequest({
          socketPath,
          method: 'POST',
          path: `${API_PREFIX}/exec/${encode(execId)}/start`,
          headers: { 'content-type': 'application/json', 'content-length': payload.length, connection: 'Upgrade', upgrade: 'tcp' },
        });
        req.on('upgrade', (_response, socket, head) => {
          const stdout = new PassThrough();
          const done = demultiplex(socket, head, stdout, options.onStderr);
          // 标准输入写完后半关闭：Docker 对 unix socket 上的升级连接执行 CloseWrite，进程读到 EOF。
          const stdin = options.stdin;
          if (stdin === undefined || Buffer.isBuffer(stdin)) {
            if (stdin) socket.write(stdin);
            socket.end();
          } else {
            // pipe 按 socket 的背压暂停读取 stdin，读完后半关闭；连接先断开时不再写入。
            stdin.pipe(socket);
            socket.once('close', () => stdin.unpipe(socket));
          }
          resolve({ stdout, done, abort: () => socket.destroy() });
        });
        req.on('response', (response) => {
          void readBody(response).then(
            () => reject(new DockerApiError(response.statusCode ?? 0, `docker exec start returned ${response.statusCode}`)),
            reject,
          );
        });
        req.on('error', reject);
        req.end(payload);
      });
    },
    async inspectExec(execId) {
      const { data } = await call('GET', `/exec/${encode(execId)}/json`);
      const info = data as { Running: boolean; ExitCode: number | null };
      return { Running: info.Running, ExitCode: info.ExitCode };
    },
  };
}
