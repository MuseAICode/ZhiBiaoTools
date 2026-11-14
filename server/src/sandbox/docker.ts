// SandboxDriver 的 Docker 实现（docs/SERVER_DESIGN.md 第 7.5 节）：只在 sandbox-runner 进程中运行，
// 那是唯一能访问容器运行时（Docker socket）的进程；worker 经 HTTP 调用 sandbox-runner（src/sandbox/client.ts）。
//
// - 沙箱即一个按模板创建的容器（src/sandbox/templates.ts），名称为 zhibiao-sandbox-{uuid}，状态全部在容器标签中
//   （模板、任务 id、到期时间），sandbox-runner 本身无状态、重启后照常服务已有的沙箱；
// - 每次操作先按名称查出容器，核对标签（是沙箱、模板和任务 id 相符、未到期、仍在运行），不符按不存在处理：
//   调用方不能经 sandbox-runner 在其他容器（数据库、Redis 等）中执行命令；
// - 输入输出经 exec 中的 tar 传送（gVisor 下 docker cp 无法写入只读根文件系统上的 tmpfs），输入先按模板校验，
//   取回的归档按不可信输入校验（src/sandbox/archive.ts）；
// - 命令超时、调用方中止时终止整个容器；到期的沙箱由 sweep 定期删除；
// - agent 模板（8.1）：每个沙箱一个专用的 internal 网络（与容器同名、同样的标签），创建时只把配置的 agent-gw 容器接入，
//   沙箱删除时一并删除，到期的同样由 sweep 删除。
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { createArchive, createArchiveStream, hasStreamFiles, maxArchiveBytes, readArchive, SandboxArchiveError, validateArchiveStream, type ArchiveStream, type SandboxFile } from './archive.ts';
import { DockerApiError, type DockerApi } from './dockerApi.ts';
import { toOutputArchive } from './outputArchive.ts';
import {
  SandboxError,
  SANDBOX_BUSY_MESSAGE,
  SANDBOX_OUTPUT_PREVIEW_BYTES,
  type SandboxArchiveTransfer,
  type SandboxDriver,
  type SandboxExecResult,
  type SandboxOperationOptions,
  type SandboxRef,
} from './driver.ts';
import {
  buildContainerSpec,
  buildNetworkSpec,
  resolveCommand,
  SANDBOX_CONTAINER_PREFIX,
  SANDBOX_LABEL,
  SANDBOX_LABEL_EXPIRES,
  SANDBOX_LABEL_JOB,
  SANDBOX_LABEL_TEMPLATE,
  SANDBOX_TEMPLATES,
  isSandboxTemplateName,
  type SandboxImageName,
  type SandboxTemplate,
  type SandboxTemplateName,
} from './templates.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DockerSandboxDriverOptions {
  docker: DockerApi;
  /** 容器运行时（runsc / runc），由 sandbox-runner 的配置决定。 */
  runtime: string;
  /** 各镜像的引用（按摘要固定），由 sandbox-runner 的配置决定；未配置的镜像（如尚未部署的 export）不能创建对应模板的沙箱。 */
  images: Readonly<Partial<Record<SandboxImageName, string | null>>>;
  /** 同时存在的沙箱数上限（含已结束、尚未删除的容器与只剩专用网络的残留，见 countSandboxes）。 */
  maxActive: number;
  /**
   * agent-gw 的容器名（8.1）：每个 agent 沙箱的专用网络只接入这一个容器。未配置时不能创建 agent 模板的沙箱。
   * 它必须是正在运行、且不是沙箱的容器（不带沙箱标签），否则按网关不可用处理。
   */
  agentGateway?: string | null;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  now?: () => Date;
  /**
   * 只供隔离测试替换：证明去掉某项加固（如 --network none、只读根文件系统）时测试会失败。
   * sandbox-runner 的入口不传。
   */
  buildSpec?: typeof buildContainerSpec;
  /** 同上：替换 agent 沙箱专用网络的参数（例如去掉 inhibit_ipv4），只供隔离测试的对照组使用。 */
  buildNetwork?: typeof buildNetworkSpec;
}

export interface ExecArgvOptions extends SandboxOperationOptions {
  timeoutMs: number;
  /** 流出错时终止整个沙箱，exec 以该错误失败。 */
  stdin?: Buffer | Readable;
}

export interface DockerSandboxDriver extends SandboxDriver, SandboxArchiveTransfer {
  /**
   * 放入归档（sandbox-runner 收到的请求体，可以是流）：边读边按模板的输入规则校验，只把通过校验的条目转给沙箱内的 tar，
   * 不在内存中缓存整个归档。中途不符时终止整个沙箱（之前的条目可能已放入），以 SANDBOX_BAD_REQUEST 失败，之后只能 destroy。
   */
  copyInArchive(sandbox: SandboxRef, archive: Buffer | AsyncIterable<Uint8Array>, options?: SandboxOperationOptions): Promise<void>;
  /**
   * 取回输出目录的原始归档（sandbox-runner 原样转给 worker，由 worker 校验）。超过模板上限即中止；
   * 沙箱内的 tar 失败时流以错误结束。
   */
  copyOutRaw(sandbox: SandboxRef, options?: SandboxOperationOptions): Promise<Readable>;
  /** 在沙箱中执行任意命令。只供本进程内部（copyIn、copyOut）和隔离测试使用，不经 HTTP 暴露。 */
  execArgv(sandbox: SandboxRef, argv: readonly string[], options: ExecArgvOptions): Promise<SandboxExecResult>;
  /** 按 id 和任务 id 找回沙箱（sandbox-runner 收到请求时用）；不存在、不属于该任务或已到期时抛 SANDBOX_NOT_FOUND。 */
  lookup(id: string, jobId: string): Promise<SandboxRef>;
  /** 删除到期的沙箱，返回删除的数量。 */
  sweep(): Promise<number>;
}

class OutputPreview {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  push(chunk: Buffer) {
    const room = SANDBOX_OUTPUT_PREVIEW_BYTES - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > room) this.truncated = true;
    const kept = chunk.subarray(0, room);
    this.chunks.push(Buffer.from(kept));
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function containerName(id: string): string {
  return `${SANDBOX_CONTAINER_PREFIX}${id}`;
}

/**
 * 计入沙箱总数上限的数量（8.2d）：带沙箱标签的容器（含已停止、已到期但尚未清理的）与带沙箱标签的专用网络
 * （含容器已删、网络因清理失败残留的）按名称合并计数——同一个 agent 沙箱的容器与网络同名，只算一个；
 * 只剩容器或只剩网络的各算一个。因此容器数与网络数都不会超过上限，残留网络不能累积到耗尽 Docker 的地址池。
 * 名称不是沙箱名称格式的（只有本服务创建带沙箱标签的对象，正常不会出现）按 id 各算一个。
 */
export async function countSandboxes(docker: Pick<DockerApi, 'listContainers' | 'listNetworks'>): Promise<number> {
  const [containers, networks] = await Promise.all([docker.listContainers(`${SANDBOX_LABEL}=1`), docker.listNetworks(`${SANDBOX_LABEL}=1`)]);
  const keys = new Set<string>();
  for (const container of containers) {
    const name = container.Names?.[0]?.replace(/^\//, '');
    keys.add(name?.startsWith(SANDBOX_CONTAINER_PREFIX) ? name : `container:${container.Id}`);
  }
  for (const network of networks) keys.add(network.Name.startsWith(SANDBOX_CONTAINER_PREFIX) ? network.Name : `network:${network.Id}`);
  return keys.size;
}

export function createDockerSandboxDriver(options: DockerSandboxDriverOptions): DockerSandboxDriver {
  const { docker, log } = options;
  const now = options.now ?? (() => new Date());
  const buildSpec = options.buildSpec ?? buildContainerSpec;
  const buildNetwork = options.buildNetwork ?? buildNetworkSpec;
  let createQueue: Promise<unknown> = Promise.resolve();

  function wrap(error: unknown, operation: string): SandboxError {
    if (error instanceof SandboxError) return error;
    if (error instanceof SandboxArchiveError) return new SandboxError('SANDBOX_BAD_REQUEST', '输入文件不符合沙箱规则', { cause: error });
    log.error({ err: error, operation }, 'sandbox operation failed');
    if (error instanceof DockerApiError || (error instanceof Error && 'code' in error)) {
      return new SandboxError('SANDBOX_UNAVAILABLE', '沙箱服务暂不可用', { cause: error });
    }
    return new SandboxError('SANDBOX_FAILED', '沙箱操作失败', { cause: error });
  }

  /** 流式放入失败：读取调用方给出的文件出错时为 SANDBOX_INPUT_FAILED（cause 是源的错误），其他按原样。 */
  function inputFailure(sandbox: SandboxRef, archive: ArchiveStream, error: unknown, signal: AbortSignal | undefined): unknown {
    const failure = archive.failure;
    if (failure === undefined || failure instanceof SandboxArchiveError || signal?.aborted) return error;
    // 源的错误可能带对象键等信息，只写错误名。
    log.warn({ sandboxId: sandbox.id, source: failure instanceof Error ? failure.name : typeof failure }, 'sandbox input source failed, sandbox terminated');
    return new SandboxError('SANDBOX_INPUT_FAILED', '读取放入沙箱的文件失败', { cause: failure });
  }

  function templateOf(sandbox: SandboxRef): SandboxTemplate {
    return SANDBOX_TEMPLATES[sandbox.template];
  }

  /** 核对容器确实是这个任务的、未到期的沙箱，返回容器 id。 */
  async function resolveContainer(id: string, jobId: string): Promise<{ containerId: string; ref: SandboxRef }> {
    if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(jobId)) throw new SandboxError('SANDBOX_NOT_FOUND', '沙箱不存在');
    const info = await docker.inspectContainer(containerName(id));
    const labels = info?.Config.Labels ?? {};
    const template = labels[SANDBOX_LABEL_TEMPLATE];
    const expires = Number(labels[SANDBOX_LABEL_EXPIRES]);
    if (
      !info ||
      info.Name !== `/${containerName(id)}` ||
      labels[SANDBOX_LABEL] !== '1' ||
      labels[SANDBOX_LABEL_JOB] !== jobId ||
      !isSandboxTemplateName(template) ||
      !Number.isFinite(expires) ||
      expires <= now().getTime() ||
      !info.State.Running
    ) {
      throw new SandboxError('SANDBOX_NOT_FOUND', '沙箱不存在');
    }
    return { containerId: info.Id, ref: Object.freeze({ id, template, jobId, expiresAt: new Date(expires) }) };
  }

  /**
   * 执行命令：收集标准输出（sink 为 null 时）或把标准输出交给 sink，超时、中止时终止容器。
   */
  async function runExec(
    containerId: string,
    argv: readonly string[],
    execOptions: ExecArgvOptions,
    sink: ((stdout: Readable) => Promise<void>) | null,
  ): Promise<SandboxExecResult> {
    if (execOptions.signal?.aborted) throw new SandboxError('SANDBOX_ABORTED', '沙箱操作已中止');
    const stdoutPreview = new OutputPreview();
    const stderrPreview = new OutputPreview();
    const stdin = execOptions.stdin;
    const stdinStream = stdin && !Buffer.isBuffer(stdin) ? stdin : null;
    let timedOut = false;
    let aborted = false;
    let stdinError: unknown = null;
    let killed: Promise<void> | null = null;
    let stream: Awaited<ReturnType<DockerApi['startExec']>> | null = null;
    const terminate = () => {
      stream?.abort();
      killed ??= docker.killContainer(containerId).catch((error: unknown) => log.warn({ err: error }, 'failed to kill sandbox'));
    };
    // 标准输入的流出错（例如放入的归档中途不符合规则）：已写入的部分不可信，终止整个沙箱。在开始读取之前接上。
    const onStdinError = (error: unknown) => {
      stdinError ??= error;
      terminate();
    };
    stdinStream?.once('error', onStdinError);
    try {
      const execId = await docker.createExec(containerId, { argv, stdin: stdin !== undefined });
      stream = await docker.startExec(execId, {
        ...(stdin !== undefined ? { stdin } : {}),
        onStderr: (chunk) => stderrPreview.push(chunk),
      });
      // startExec 返回之前标准输入已出错：此时 terminate 还没能断开连接。
      if (stdinError !== null) terminate();
      return await waitExec(execId, stream);
    } finally {
      if (stdinStream) {
        stdinStream.off('error', onStdinError);
        // 进程提前退出（没有读完）、被终止或 exec 没能启动时，不再读取上游。
        stdinStream.destroy();
      }
    }

    async function waitExec(execId: string, started: NonNullable<typeof stream>): Promise<SandboxExecResult> {
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, execOptions.timeoutMs);
      const onAbort = () => {
        aborted = true;
        terminate();
      };
      execOptions.signal?.addEventListener('abort', onAbort, { once: true });
      if (execOptions.signal?.aborted) onAbort();
      try {
        const consume = sink
          ? sink(started.stdout)
          : (async () => {
              for await (const chunk of started.stdout) stdoutPreview.push(chunk as Buffer);
            })();
        await Promise.allSettled([consume, started.done]);
        // 超时、中止时等容器确实被终止后再返回，之后的操作一律查不到这个沙箱。
        if (killed) await killed;
        if (aborted) throw new SandboxError('SANDBOX_ABORTED', '沙箱操作已中止');
        if (stdinError !== null) throw stdinError;
        if (timedOut) {
          return { exitCode: null, timedOut: true, stdout: stdoutPreview.text(), stderr: stderrPreview.text(), stdoutTruncated: stdoutPreview.truncated, stderrTruncated: stderrPreview.truncated };
        }
        await consume;
        const info = await docker.inspectExec(execId);
        return {
          exitCode: info.Running ? null : info.ExitCode,
          timedOut: false,
          stdout: stdoutPreview.text(),
          stderr: stderrPreview.text(),
          stdoutTruncated: stdoutPreview.truncated,
          stderrTruncated: stderrPreview.truncated,
        };
      } finally {
        clearTimeout(timer);
        execOptions.signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  async function copyInArchive(sandbox: SandboxRef, archive: Buffer | AsyncIterable<Uint8Array>, operationOptions: SandboxOperationOptions = {}) {
    try {
      const template = templateOf(sandbox);
      const { containerId } = await resolveContainer(sandbox.id, sandbox.jobId);
      // 请求体来自 worker，仍按模板规则检查：只有普通文件、路径和大小在上限内。边读边校验，只转发通过校验的条目。
      const stdin = Readable.from(validateArchiveStream(Buffer.isBuffer(archive) ? Readable.from([archive]) : archive, template.input), { objectMode: false });
      const result = await runExec(
        containerId,
        ['tar', '-x', '-f', '-', '-C', template.input.directory, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'],
        { timeoutMs: template.transferTimeoutMs, stdin, ...operationOptions },
        null,
      );
      if (result.timedOut || result.exitCode !== 0) {
        log.warn({ exitCode: result.exitCode, timedOut: result.timedOut }, 'sandbox copy-in failed');
        throw new SandboxError('SANDBOX_FAILED', '向沙箱放入文件失败');
      }
    } catch (error) {
      if (error instanceof SandboxArchiveError) log.warn({ reason: error.reason, sandboxId: sandbox.id }, 'sandbox input rejected, sandbox terminated');
      throw wrap(error, 'copy-in');
    }
  }

  async function copyOutRaw(sandbox: SandboxRef, operationOptions: SandboxOperationOptions = {}): Promise<Readable> {
    const template = templateOf(sandbox);
    const limit = maxArchiveBytes(template.output);
    let received = 0;
    const output = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > limit) callback(new SandboxError('SANDBOX_OUTPUT_REJECTED', '沙箱输出超过上限'));
        else callback(null, chunk);
      },
    });
    // 消费方接上之前出错时不让进程因未处理的 error 事件退出；消费方（for await、pipeline）照常收到错误。
    output.on('error', () => {});
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sink = (stdout: Readable) =>
      new Promise<void>((resolve) => {
        started();
        stdout.on('data', (chunk: Buffer) => {
          if (!output.write(chunk)) {
            stdout.pause();
            output.once('drain', () => stdout.resume());
          }
        });
        stdout.once('end', resolve);
        stdout.once('close', resolve);
        stdout.once('error', () => resolve());
        // 消费方提前结束或超过上限时，断开与沙箱内 tar 的连接。
        output.once('close', () => {
          stdout.destroy();
          resolve();
        });
      });
    let exitCheck: Promise<SandboxExecResult>;
    try {
      const { containerId } = await resolveContainer(sandbox.id, sandbox.jobId);
      exitCheck = runExec(containerId, ['tar', '-c', '-f', '-', '-C', template.output.directory, '.'], { timeoutMs: template.transferTimeoutMs, ...operationOptions }, sink);
      // 沙箱内的 tar 失败（退出码非 0、超时）时流以错误结束，接收方收不到完整的流。
      exitCheck.then(
        (result) => {
          if (output.destroyed) return;
          if (result.timedOut || result.exitCode !== 0) output.destroy(new SandboxError('SANDBOX_FAILED', '从沙箱取回文件失败'));
          else output.end();
        },
        (error: unknown) => output.destroy(wrap(error, 'copy-out')),
      );
      await Promise.race([ready, exitCheck]);
    } catch (error) {
      output.destroy();
      throw wrap(error, 'copy-out');
    }
    return output;
  }

  /** 删除沙箱的专用网络：先强制断开仍接入的容器（agent-gw），再删除网络。网络已不存在时也成功。 */
  async function removeNetwork(networkId: string): Promise<void> {
    const info = await docker.inspectNetwork(networkId);
    if (!info) return;
    for (const containerId of Object.keys(info.Containers ?? {})) await docker.disconnectNetwork(info.Id, containerId);
    await docker.removeNetwork(info.Id);
  }

  /** 按沙箱 id 删除其专用网络：只删除带沙箱标签、任务 id 相符的网络（与容器的规则相同）。 */
  async function removeSandboxNetwork(id: string, jobId: string): Promise<void> {
    const info = await docker.inspectNetwork(containerName(id));
    if (!info || info.Name !== containerName(id) || info.Labels?.[SANDBOX_LABEL] !== '1' || info.Labels[SANDBOX_LABEL_JOB] !== jobId) return;
    await removeNetwork(info.Id);
    log.info({ sandboxId: id }, 'sandbox network removed');
  }

  /**
   * 新建 agent 沙箱的专用网络并接入 agent-gw，返回网络名和 agent-gw 在其中的地址。网络必须是 internal、此时只有 agent-gw 一个成员，
   * 否则删除网络、按不可用处理。中途失败时删除已建的网络。
   */
  async function createAgentNetwork(id: string, templateName: SandboxTemplateName, jobId: string, expiresAt: Date): Promise<{ networkId: string; name: string; gatewayAddress: string }> {
    const gatewayName = options.agentGateway;
    if (!gatewayName) throw new SandboxError('SANDBOX_UNAVAILABLE', '沙箱网关未配置');
    const gateway = await docker.inspectContainer(gatewayName);
    // 网关不能是沙箱：否则一个沙箱会被接进另一个沙箱的网络。
    if (!gateway || !gateway.State.Running || gateway.Config.Labels?.[SANDBOX_LABEL] === '1') {
      log.error({ gateway: gatewayName }, 'agent gateway container is not available');
      throw new SandboxError('SANDBOX_UNAVAILABLE', '沙箱网关不可用');
    }
    const name = containerName(id);
    const networkId = await docker.createNetwork(buildNetwork(name, { template: templateName, jobId, expiresAt }));
    try {
      await docker.connectNetwork(networkId, gateway.Id);
      const info = await docker.inspectNetwork(networkId);
      const members = Object.entries(info?.Containers ?? {});
      const gatewayAddress = members.length === 1 && members[0]![0] === gateway.Id ? members[0]![1].IPv4Address.split('/', 1)[0] : undefined;
      if (!info || !info.Internal || !gatewayAddress) {
        log.error({ sandboxId: id, internal: info?.Internal, members: members.length }, 'agent sandbox network is not as expected');
        throw new SandboxError('SANDBOX_UNAVAILABLE', '沙箱网络创建失败');
      }
      return { networkId, name, gatewayAddress };
    } catch (error) {
      await removeNetwork(networkId).catch((cleanupError: unknown) => log.warn({ err: cleanupError, sandboxId: id }, 'failed to remove sandbox network'));
      throw error;
    }
  }

  const driver: DockerSandboxDriver = {
    async create(templateName, createOptions) {
      if (!isSandboxTemplateName(templateName) || !UUID_PATTERN.test(createOptions.jobId)) {
        throw new SandboxError('SANDBOX_BAD_REQUEST', '沙箱模板或任务不合法');
      }
      const template = SANDBOX_TEMPLATES[templateName];
      const image = options.images[template.image];
      if (!image) throw new SandboxError('SANDBOX_UNAVAILABLE', '沙箱镜像未配置');
      const run = async (): Promise<SandboxRef> => {
        if ((await countSandboxes(docker)) >= options.maxActive) throw new SandboxError('SANDBOX_BUSY', SANDBOX_BUSY_MESSAGE);
        const id = randomUUID();
        const expiresAt = new Date(now().getTime() + template.lifetimeMs);
        const network = template.network === 'agent' ? await createAgentNetwork(id, templateName, createOptions.jobId, expiresAt) : null;
        try {
          const spec = buildSpec(template, {
            image,
            runtime: options.runtime,
            jobId: createOptions.jobId,
            expiresAt,
            ...(network ? { network: { name: network.name, gatewayAddress: network.gatewayAddress } } : {}),
          });
          const containerId = await docker.createContainer(containerName(id), spec);
          try {
            await docker.startContainer(containerId);
          } catch (error) {
            await docker.removeContainer(containerId).catch(() => {});
            throw error;
          }
        } catch (error) {
          if (network) await removeNetwork(network.networkId).catch((cleanupError: unknown) => log.warn({ err: cleanupError, sandboxId: id }, 'failed to remove sandbox network'));
          throw error;
        }
        log.info({ sandboxId: id, template: templateName, jobId: createOptions.jobId }, 'sandbox created');
        return Object.freeze({ id, template: templateName, jobId: createOptions.jobId, expiresAt });
      };
      // 串行创建，数量上限的检查与创建之间不会被其他请求插入。
      const result = createQueue.then(run, run);
      createQueue = result.catch(() => {});
      try {
        return await result;
      } catch (error) {
        throw wrap(error, 'create');
      }
    },

    async copyIn(sandbox, files, operationOptions = {}) {
      let archive: Buffer | ArchiveStream;
      try {
        archive = hasStreamFiles(files)
          ? createArchiveStream(files, templateOf(sandbox).input, operationOptions.signal ? { signal: operationOptions.signal } : {})
          : createArchive(files as readonly SandboxFile[], templateOf(sandbox).input);
      } catch (error) {
        throw wrap(error, 'copy-in');
      }
      if (Buffer.isBuffer(archive)) return copyInArchive(sandbox, archive, operationOptions);
      try {
        await copyInArchive(sandbox, archive.chunks, operationOptions);
      } catch (error) {
        throw inputFailure(sandbox, archive, error, operationOptions.signal);
      }
    },

    copyInArchive,

    async exec(sandbox, command, args, operationOptions = {}) {
      const resolved = resolveCommand(templateOf(sandbox), command, args);
      if (!resolved) throw new SandboxError('SANDBOX_BAD_REQUEST', '沙箱命令或参数不合法');
      try {
        const { containerId } = await resolveContainer(sandbox.id, sandbox.jobId);
        return await runExec(containerId, resolved.argv, { timeoutMs: resolved.timeoutMs, ...operationOptions }, null);
      } catch (error) {
        throw wrap(error, 'exec');
      }
    },

    async copyOut(sandbox, operationOptions) {
      const stream = await copyOutRaw(sandbox, operationOptions);
      try {
        return await readArchive(stream, templateOf(sandbox).output);
      } catch (error) {
        stream.destroy();
        if (error instanceof SandboxArchiveError) {
          log.warn({ reason: error.reason, sandboxId: sandbox.id }, 'sandbox output rejected');
          throw new SandboxError('SANDBOX_OUTPUT_REJECTED', '沙箱输出不符合规则', { cause: error });
        }
        throw wrap(error, 'copy-out');
      }
    },

    async copyOutArchive(sandbox, operationOptions = {}) {
      const stream = await copyOutRaw(sandbox, operationOptions);
      return toOutputArchive(stream, templateOf(sandbox).output, {
        signal: operationOptions.signal,
        onRejected: (error) => log.warn({ reason: error.reason, sandboxId: sandbox.id }, 'sandbox output rejected'),
      });
    },

    copyOutRaw,

    async execArgv(sandbox, argv, execOptions) {
      try {
        const { containerId } = await resolveContainer(sandbox.id, sandbox.jobId);
        return await runExec(containerId, argv, execOptions, null);
      } catch (error) {
        throw wrap(error, 'exec');
      }
    },

    async lookup(id, jobId) {
      try {
        return (await resolveContainer(id, jobId)).ref;
      } catch (error) {
        throw wrap(error, 'lookup');
      }
    },

    async destroy(sandbox) {
      if (!UUID_PATTERN.test(sandbox.id)) return;
      try {
        const info = await docker.inspectContainer(containerName(sandbox.id));
        if (info) {
          // 只删除确实是沙箱的容器；任务 id 不符时不删（按不存在处理），网络也不动。
          if (info.Config.Labels?.[SANDBOX_LABEL] !== '1' || info.Config.Labels[SANDBOX_LABEL_JOB] !== sandbox.jobId) return;
          await docker.removeContainer(info.Id);
          log.info({ sandboxId: sandbox.id }, 'sandbox destroyed');
        }
        // agent 沙箱的专用网络（容器已不存在时也删，例如创建中途失败后残留的）。
        await removeSandboxNetwork(sandbox.id, sandbox.jobId);
      } catch (error) {
        throw wrap(error, 'destroy');
      }
    },

    async sweep() {
      const containers = await docker.listContainers(`${SANDBOX_LABEL}=1`);
      const current = now().getTime();
      let removed = 0;
      for (const container of containers) {
        const expires = Number(container.Labels[SANDBOX_LABEL_EXPIRES]);
        // 标签不合法的也删除：只有本服务创建带 zhibiao.sandbox 标签的容器。
        if (Number.isFinite(expires) && expires > current) continue;
        try {
          await docker.removeContainer(container.Id);
          removed += 1;
        } catch (error) {
          log.warn({ err: error }, 'failed to remove expired sandbox');
        }
      }
      // agent 沙箱的专用网络：与容器同样按到期时间删除（容器已删除、或创建中途失败后残留的网络）。
      let removedNetworks = 0;
      for (const network of await docker.listNetworks(`${SANDBOX_LABEL}=1`)) {
        const expires = Number(network.Labels[SANDBOX_LABEL_EXPIRES]);
        if (Number.isFinite(expires) && expires > current) continue;
        try {
          await removeNetwork(network.Id);
          removedNetworks += 1;
        } catch (error) {
          log.warn({ err: error }, 'failed to remove expired sandbox network');
        }
      }
      if (removed > 0 || removedNetworks > 0) log.info({ removed, removedNetworks }, 'expired sandboxes removed');
      return removed;
    },
  };
  return driver;
}

/** 启动时检查配置的容器运行时已在 Docker 中登记（例如生产环境要求的 runsc）。 */
export async function assertRuntimeAvailable(docker: DockerApi, runtime: string): Promise<void> {
  const runtimes = await docker.runtimes();
  if (!runtimes.includes(runtime)) throw new Error(`container runtime ${runtime} is not registered in docker`);
}
