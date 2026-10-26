// 沙箱模板（docs/SERVER_DESIGN.md 第 7.4、7.5 节；路线图第 6 步 6.5）。
// 模板写死在代码中：镜像（由 sandbox-runner 的配置给出摘要固定的引用）、网络、只读根文件系统、用户、资源上限、
// 可写目录、可执行的命令和取回规则。调用方（worker）只能选模板名，不能传镜像、挂载、网络或任意 Docker 参数。
// 第 6 步只有 parse 模板（断网解析）；第 8 步在同一套机制上加 agent 模板（内部网络、任务令牌、业务工具 RPC）。

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const SANDBOX_TEMPLATE_NAMES = ['parse'] as const;
export type SandboxTemplateName = (typeof SANDBOX_TEMPLATE_NAMES)[number];

/** 沙箱内进程的用户与组（镜像中的 sandbox 用户），非 root。 */
export const SANDBOX_UID = 10001;

/** 沙箱容器的标签：sandbox-runner 只操作带这些标签的容器，按标签清理过期的沙箱。 */
export const SANDBOX_LABEL = 'zhibiao.sandbox';
export const SANDBOX_LABEL_TEMPLATE = 'zhibiao.sandbox.template';
export const SANDBOX_LABEL_JOB = 'zhibiao.sandbox.job';
export const SANDBOX_LABEL_EXPIRES = 'zhibiao.sandbox.expires';
export const SANDBOX_CONTAINER_PREFIX = 'zhibiao-sandbox-';

/** 进出沙箱的文件规则：只收普通文件，路径在目录内、按段校验，数量、大小和扩展名受限。 */
export interface SandboxTransferLimits {
  /** 沙箱内的目录（copyIn 解到这里，copyOut 从这里打包）。 */
  readonly directory: string;
  /** 路径最多几段（content.md 是 1 段，images/image-001.png 是 2 段）。 */
  readonly maxDepth: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  /** 允许的扩展名（小写，不带点）；为 null 时不限制。 */
  readonly extensions: ReadonlySet<string> | null;
}

/** 模板中的命令：可执行文件和固定参数写死，调用方只能追加少量符合 argPattern 的参数。 */
export interface SandboxCommand {
  readonly argv: readonly string[];
  readonly maxArgs: number;
  readonly argPattern: RegExp;
  /** 单次执行的墙钟上限，超过即终止整个沙箱。 */
  readonly timeoutMs: number;
}

export interface SandboxTemplate {
  readonly name: SandboxTemplateName;
  /** 沙箱从创建起最长存活多久，到期由 sandbox-runner 销毁（不论是否还在使用）。 */
  readonly lifetimeMs: number;
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  readonly openFilesLimit: number;
  /** 可写目录（tmpfs，大小计入内存上限）；根文件系统只读。 */
  readonly tmpfs: Readonly<Record<string, { readonly bytes: number; readonly owner: 'root' | 'sandbox' }>>;
  readonly input: SandboxTransferLimits;
  readonly output: SandboxTransferLimits;
  readonly commands: Readonly<Record<string, SandboxCommand>>;
  /** copyIn、copyOut（沙箱内的 tar）单次执行的墙钟上限。 */
  readonly transferTimeoutMs: number;
}

/**
 * parse：解析上传的文档（6.6 起）。完全断网（--network none，只有 lo），一个文件一个沙箱、用完即毁。
 * 资源上限为第 6 步决定事项第 5 项的起步值：内存 2 GiB（无 swap）、CPU 1 核、/tmp 与 /output 各 1 GiB、
 * 单个文件解析墙钟 10 分钟、单个文件产出的图片 2,000 张。
 */
const PARSE_TEMPLATE: SandboxTemplate = Object.freeze({
  name: 'parse',
  lifetimeMs: 15 * 60_000,
  memoryBytes: 2 * GIB,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
  openFilesLimit: 1024,
  tmpfs: Object.freeze({
    '/tmp': { bytes: 1 * GIB, owner: 'root' as const },
    '/input': { bytes: 256 * MIB, owner: 'sandbox' as const },
    '/output': { bytes: 1 * GIB, owner: 'sandbox' as const },
  }),
  input: Object.freeze({
    directory: '/input',
    maxDepth: 1,
    maxFiles: 4,
    // 原件不超过 100 MiB（上传上限），留出余量。
    maxFileBytes: 128 * MIB,
    maxTotalBytes: 192 * MIB,
    extensions: null,
  }),
  output: Object.freeze({
    directory: '/output',
    maxDepth: 2,
    // 图片 2,000 张 + Markdown + 清单。
    maxFiles: 2_010,
    // 单个产物的大小上限与迁移 0008 的 MAX_ARTIFACT_BYTES 相同。
    maxFileBytes: 100 * MIB,
    maxTotalBytes: 1 * GIB,
    // 与迁移 0008 登记的产物 MIME 对应（Markdown、png / jpeg / gif / webp / bmp），另加清单 JSON；不收 svg、html。
    extensions: new Set(['md', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']),
  }),
  commands: Object.freeze({
    // 解析入口（6.6 实现分派）。参数只有分派结果（如格式名），不含路径：输入固定在 /input，输出固定在 /output。
    parse: Object.freeze({
      argv: Object.freeze(['node', '/opt/parse/entry.mjs']),
      maxArgs: 8,
      argPattern: /^[A-Za-z0-9][A-Za-z0-9._=:-]{0,127}$/,
      timeoutMs: 10 * 60_000,
    }),
  }),
  transferTimeoutMs: 2 * 60_000,
});

export const SANDBOX_TEMPLATES: Readonly<Record<SandboxTemplateName, SandboxTemplate>> = Object.freeze({
  parse: PARSE_TEMPLATE,
});

export function isSandboxTemplateName(value: unknown): value is SandboxTemplateName {
  return typeof value === 'string' && (SANDBOX_TEMPLATE_NAMES as readonly string[]).includes(value);
}

/** 校验命令参数并拼出完整的 argv；不合法时返回 null。 */
export function resolveCommand(template: SandboxTemplate, name: string, args: readonly unknown[]): { argv: string[]; timeoutMs: number } | null {
  if (!Object.hasOwn(template.commands, name)) return null;
  const command = template.commands[name]!;
  if (args.length > command.maxArgs) return null;
  for (const arg of args) {
    if (typeof arg !== 'string' || !command.argPattern.test(arg)) return null;
  }
  return { argv: [...command.argv, ...(args as string[])], timeoutMs: command.timeoutMs };
}

export interface ContainerSpecOptions {
  /** sandbox-runner 配置中按摘要固定的镜像引用。 */
  image: string;
  /** 容器运行时：生产只允许 runsc（gVisor），开发可用 runc。 */
  runtime: string;
  jobId: string;
  expiresAt: Date;
}

/** Docker Engine API 创建容器的请求体（POST /containers/create）。 */
export type ContainerSpec = Record<string, unknown> & { HostConfig: Record<string, unknown> };

function tmpfsOptions(spec: { bytes: number; owner: 'root' | 'sandbox' }): string {
  const owner = spec.owner === 'sandbox' ? `uid=${SANDBOX_UID},gid=${SANDBOX_UID},mode=0700` : 'mode=1777';
  return `rw,noexec,nosuid,nodev,size=${spec.bytes},${owner}`;
}

/**
 * 按模板生成容器参数（docs/SERVER_DESIGN.md 第 7.4 节）。容器的主进程只是 sleep，解析等命令经 exec 执行，
 * 输入输出经 exec 中的 tar 传送，不挂载任何宿主目录、卷或 Docker socket，不注入宿主环境变量。
 */
export function buildContainerSpec(template: SandboxTemplate, options: ContainerSpecOptions): ContainerSpec {
  return {
    Image: options.image,
    Entrypoint: ['/usr/bin/sleep'],
    Cmd: ['infinity'],
    User: `${SANDBOX_UID}:${SANDBOX_UID}`,
    WorkingDir: '/tmp',
    Env: ['HOME=/tmp', 'LANG=C.UTF-8', 'TMPDIR=/tmp'],
    Hostname: 'sandbox',
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    OpenStdin: false,
    Tty: false,
    StopTimeout: 1,
    Labels: {
      [SANDBOX_LABEL]: '1',
      [SANDBOX_LABEL_TEMPLATE]: template.name,
      [SANDBOX_LABEL_JOB]: options.jobId,
      [SANDBOX_LABEL_EXPIRES]: String(options.expiresAt.getTime()),
    },
    HostConfig: {
      Runtime: options.runtime,
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Init: true,
      IpcMode: 'private',
      Memory: template.memoryBytes,
      // 等于内存上限即不使用 swap。
      MemorySwap: template.memoryBytes,
      NanoCpus: template.nanoCpus,
      PidsLimit: template.pidsLimit,
      Ulimits: [{ Name: 'nofile', Soft: template.openFilesLimit, Hard: template.openFilesLimit }],
      Tmpfs: Object.fromEntries(Object.entries(template.tmpfs).map(([path, spec]) => [path, tmpfsOptions(spec)])),
      Binds: [],
      Mounts: [],
      Devices: [],
      Dns: [],
      ExtraHosts: [],
      // 不保留容器的标准输出（可能含文档内容）；命令的输出经 exec 取回。
      LogConfig: { Type: 'none', Config: {} },
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
    },
    NetworkingConfig: { EndpointsConfig: {} },
  };
}
