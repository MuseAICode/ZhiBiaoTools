// 沙箱模板（docs/SERVER_DESIGN.md 第 7.4、7.5 节；路线图第 6 步 6.5）。
// 模板写死在代码中：镜像（由 sandbox-runner 的配置给出摘要固定的引用）、网络、只读根文件系统、用户、资源上限、
// 可写目录、可执行的命令和取回规则。调用方（worker）只能选模板名，不能传镜像、挂载、网络或任意 Docker 参数。
// 第 6 步建了 parse 模板（断网解析）；第 7 步加 export 模板（断网导出 Word，路线图 7.1），分样张与整本导出两档资源上限；
// 第 8 步在同一套机制上加 agent 模板（8.1：镜像、资源与每个沙箱一个内部网络；任务令牌、业务工具 RPC 随 8.2、8.4）。

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const SANDBOX_TEMPLATE_NAMES = ['parse', 'export-preview', 'export-document', 'export-feasibility', 'agent', 'agent-content'] as const;
export type SandboxTemplateName = (typeof SANDBOX_TEMPLATE_NAMES)[number];

/** 镜像：export 模板用同一个 export 镜像（第 7 步决定事项第 2 项），两个 agent 模板用同一个 agent 镜像，只是资源上限不同。 */
export const SANDBOX_IMAGE_NAMES = ['parse', 'export', 'agent'] as const;
export type SandboxImageName = (typeof SANDBOX_IMAGE_NAMES)[number];

/** 沙箱内进程的用户与组（镜像中的 sandbox 用户），非 root。 */
export const SANDBOX_UID = 10001;

/** 沙箱容器的标签：sandbox-runner 只操作带这些标签的容器，按标签清理过期的沙箱。 */
export const SANDBOX_LABEL = 'zhibiao.sandbox';
export const SANDBOX_LABEL_TEMPLATE = 'zhibiao.sandbox.template';
export const SANDBOX_LABEL_JOB = 'zhibiao.sandbox.job';
export const SANDBOX_LABEL_EXPIRES = 'zhibiao.sandbox.expires';
export const SANDBOX_CONTAINER_PREFIX = 'zhibiao-sandbox-';

/**
 * agent 沙箱访问平台的唯一入口（agent-gw，路线图第 8 步决定事项第 1 项，8.2 实现）在沙箱内的名字。
 * 不配置 DNS：名字与地址由模板写进沙箱的 /etc/hosts（ExtraHosts）。
 */
export const AGENT_GATEWAY_HOSTNAME = 'agent-gw';
/** agent-gw 在沙箱网络上监听的端口（8.2b）；沙箱内的入口（8.6）按 http://agent-gw:8080 访问。 */
export const AGENT_GATEWAY_PORT = 8080;

/**
 * 沙箱的网络。none：--network none，只有 lo。agent：每个沙箱一个专用的 internal 网络（第 8 步决定事项第 2 项 B1），
 * 由 sandbox-runner 随沙箱创建与删除，网络中只有这个沙箱和 agent-gw；网桥不分配 IPv4 地址，沙箱到不了宿主。
 */
export type SandboxNetworkKind = 'none' | 'agent';
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
  /** 用哪个镜像（引用由 sandbox-runner 的配置给出）。 */
  readonly image: SandboxImageName;
  readonly network: SandboxNetworkKind;
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
  image: 'parse' as const,
  network: 'none' as const,
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

/** export 的取回规则：只有 document.docx 和 result.json 两个普通文件（路线图 7.1“输出校验”）。 */
const EXPORT_OUTPUT: SandboxTransferLimits = Object.freeze({
  directory: '/output',
  maxDepth: 1,
  maxFiles: 2,
  // 输出 docx 不超过 100 MiB（第 7 步决定事项第 5 项），与产物的大小上限相同。
  maxFileBytes: 100 * MIB,
  maxTotalBytes: 101 * MIB,
  extensions: new Set(['docx', 'json']),
});

/** export 入口：模式名由模板写死，调用方不能追加参数。输入固定在 /work，输出固定在 /output。 */
function exportCommand(mode: 'preview' | 'document' | 'feasibility', timeoutMs: number): SandboxCommand {
  return Object.freeze({
    argv: Object.freeze(['node', '/opt/export/entry.mjs', mode]),
    maxArgs: 0,
    argPattern: /^$/,
    timeoutMs,
  });
}

/**
 * export-preview：模板样张（7.3 起）。隔离参数与 parse 相同（断网、gVisor、只读根文件系统、非 root、无能力），
 * 资源上限为第 7 步决定事项第 5 项的样张起步值：内存 1 GiB（无 swap）、CPU 1 核、墙钟 60 秒。
 * 输入只有样张 HTML 与配置（固定样张配图 7.3b 起打进镜像，入口复制到 /work/preview/assets/），可写目录相应较小。
 */
const EXPORT_PREVIEW_TEMPLATE: SandboxTemplate = Object.freeze({
  name: 'export-preview',
  image: 'export' as const,
  network: 'none' as const,
  // 命令墙钟 60 秒 + 放入与取回各 1 分钟，再留出余量。
  lifetimeMs: 5 * 60_000,
  memoryBytes: 1 * GIB,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
  openFilesLimit: 1024,
  tmpfs: Object.freeze({
    // Chromium 的用户目录与共享内存（--disable-dev-shm-usage）、.NET 的临时文件。
    '/tmp': { bytes: 256 * MIB, owner: 'root' as const },
    // 输入与助手的工作区（任务目录、装饰 PNG、助手写出的 docx）。
    '/work': { bytes: 192 * MIB, owner: 'sandbox' as const },
    '/output': { bytes: 128 * MIB, owner: 'sandbox' as const },
  }),
  input: Object.freeze({
    directory: '/work',
    // request.json（样张，7.3b 起入口拒绝其他文件）；与 export-document 相同的两层规则。
    maxDepth: 2,
    maxFiles: 32,
    maxFileBytes: 32 * MIB,
    maxTotalBytes: 64 * MIB,
    extensions: null,
  }),
  output: EXPORT_OUTPUT,
  commands: Object.freeze({ export: exportCommand('preview', 60_000) }),
  transferTimeoutMs: 60_000,
});

/**
 * export-document：技术方案整本导出 Word（7.4 起）。资源上限为第 7 步决定事项第 5 项的整本导出起步值：
 * 内存 2 GiB（无 swap）、CPU 1 核、墙钟 20 分钟；配图不超过 2,000 张，输出 docx 不超过 100 MiB。
 * 输入合计不超过 128 MiB（7.4b 由用户决定，原为 1 GiB）：tmpfs 计入内存上限，助手写 docx 时的内存约为配图字节数的
 * 2 倍，2 GiB 下 512 MiB 以上的输入必然内存不足；而 PNG / JPEG 等已压缩的配图在 docx 中几乎压不动，超过约 100 MiB
 * 本来就会因 docx 超过 100 MiB 而失败。实测见路线图“export-document 的 tmpfs 与内存”。
 */
const EXPORT_DOCUMENT_TEMPLATE: SandboxTemplate = Object.freeze({
  name: 'export-document',
  image: 'export' as const,
  network: 'none' as const,
  // 命令墙钟 20 分钟 + 放入与取回各 5 分钟，再留出余量。
  lifetimeMs: 35 * 60_000,
  memoryBytes: 2 * GIB,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
  openFilesLimit: 1024,
  tmpfs: Object.freeze({
    '/tmp': { bytes: 512 * MIB, owner: 'root' as const },
    // 输入 128 MiB，另留出装饰 PNG 与助手写出的 docx（不超过 100 MiB，助手写完才检查大小）的空间。
    // 输入、/work 中的 docx 与复制到 /output 的 docx 都计入内存：实测 100 MiB 不可压缩配图的导出峰值约 520 MiB。
    '/work': { bytes: 384 * MIB, owner: 'sandbox' as const },
    '/output': { bytes: 128 * MIB, owner: 'sandbox' as const },
  }),
  input: Object.freeze({
    directory: '/work',
    maxDepth: 2,
    // 配图 2,000 张 + request.json。
    maxFiles: 2_001,
    // 单张配图不超过产物的大小上限（迁移 0008 的 MAX_ARTIFACT_BYTES）。
    maxFileBytes: 100 * MIB,
    // 与输出 docx 的 100 MiB 上限对齐并留出余量（含 request.json）；worker 在新建沙箱之前按所引用配图的合计大小拒绝（7.4e）。
    maxTotalBytes: 128 * MIB,
    extensions: null,
  }),
  output: EXPORT_OUTPUT,
  commands: Object.freeze({ export: exportCommand('document', 20 * 60_000) }),
  transferTimeoutMs: 5 * 60_000,
});

/**
 * export-feasibility：可研报告导出 Word（路线图第 7 步 7.5b，#61 决定事项第 1 项）。同一个 export 镜像、与 export-document
 * 完全相同的隔离参数、资源与输入输出上限（输入合计 128 MiB、配图 2,000 张、docx 100 MiB），只有入口模式不同：
 * 在沙箱内运行与桌面版同一份的可研导出代码（server/sandbox/export/feasibility.mjs），不经 OpenXmlHelper。
 */
const EXPORT_FEASIBILITY_TEMPLATE: SandboxTemplate = Object.freeze({
  ...EXPORT_DOCUMENT_TEMPLATE,
  name: 'export-feasibility',
  commands: Object.freeze({ export: exportCommand('feasibility', 20 * 60_000) }),
});

/**
 * agent 工作区的放入与取回规则（/workspace，路线图第 8 步“工作区”与决定事项第 13 项）：只收普通文件，
 * 文件数 ≤ 10,000、合计 ≤ 512 MiB，扩展名限于 Agent 的正文、中间文件与会话文件会用到的文本与图片格式。
 * 快照的保存、取回与恢复（含中文路径段的处理）随 8.5，届时按实际用到的文件核对本表。
 */
const AGENT_WORKSPACE: SandboxTransferLimits = Object.freeze({
  directory: '/workspace',
  maxDepth: 8,
  maxFiles: 10_000,
  // 单个文件不超过产物的大小上限（迁移 0008 的 MAX_ARTIFACT_BYTES）。
  maxFileBytes: 100 * MIB,
  maxTotalBytes: 512 * MIB,
  extensions: new Set(['md', 'txt', 'json', 'jsonl', 'html', 'mmd', 'svg', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp']),
});

/**
 * agent：Agent 任务（路线图第 8 步 8.1，决定事项第 3 项的起步值）。镜像只有 Node 24、rg / fd / jq、/bin/sh 与基本 coreutils
 * （Pi 运行时随 8.6），不含 Chromium、LibreOffice、OpenXmlHelper、编译器和网络工具。隔离参数与 parse 相同（gVisor、非 root、
 * cap-drop ALL、no-new-privileges、只读根文件系统、不挂载宿主目录、不注入宿主环境变量），只有网络不同：每个沙箱一个专用的
 * internal 网络，只通 agent-gw（见 SandboxNetworkKind）。资源：CPU 1 核、内存 2 GiB（无 swap）、pids 256、/workspace 1 GiB、
 * /tmp 256 MiB（tmpfs 计入内存上限）。
 *
 * 任务墙钟按任务类型（正文生成 2 小时，其余 30 分钟），分成两个模板：沙箱最长存活为墙钟加放入、取回的时限，到期由 sandbox-runner
 * 销毁，不论 Agent 是否还在运行。Agent 的入口命令（命令墙钟即任务墙钟）随 8.6 登记；单条 bash 命令 5 分钟由入口执行，
 * 它只是 Agent 自身的约束，平台的控制是命令与沙箱的墙钟、cgroup 上限与网络。
 */
const AGENT_TEMPLATE: SandboxTemplate = Object.freeze({
  name: 'agent',
  image: 'agent' as const,
  network: 'agent' as const,
  // 任务墙钟 30 分钟 + 放入与取回各 5 分钟，再留出余量。
  lifetimeMs: 45 * 60_000,
  memoryBytes: 2 * GIB,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
  openFilesLimit: 1024,
  tmpfs: Object.freeze({
    '/tmp': { bytes: 256 * MIB, owner: 'root' as const },
    '/workspace': { bytes: 1 * GIB, owner: 'sandbox' as const },
  }),
  // 放入的是 worker 选定的本任务文件与已经过取回校验的工作区快照，与 parse / export 相同不限扩展名；其余规则与取回相同。
  input: Object.freeze({ ...AGENT_WORKSPACE, extensions: null }),
  output: AGENT_WORKSPACE,
  commands: Object.freeze({}),
  transferTimeoutMs: 5 * 60_000,
});

/** agent-content：正文生成（含章节重写、原方案还原）的 Agent 任务，任务墙钟 2 小时，其余与 agent 完全相同。 */
const AGENT_CONTENT_TEMPLATE: SandboxTemplate = Object.freeze({
  ...AGENT_TEMPLATE,
  name: 'agent-content',
  // 任务墙钟 2 小时 + 放入与取回各 5 分钟，再留出余量。
  lifetimeMs: 135 * 60_000,
});

export const SANDBOX_TEMPLATES: Readonly<Record<SandboxTemplateName, SandboxTemplate>> = Object.freeze({
  parse: PARSE_TEMPLATE,
  'export-preview': EXPORT_PREVIEW_TEMPLATE,
  'export-document': EXPORT_DOCUMENT_TEMPLATE,
  'export-feasibility': EXPORT_FEASIBILITY_TEMPLATE,
  agent: AGENT_TEMPLATE,
  'agent-content': AGENT_CONTENT_TEMPLATE,
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
  /** network 为 agent 的模板必需：该沙箱的专用网络名与 agent-gw 在其中的地址；network 为 none 的模板不能给出。 */
  network?: { name: string; gatewayAddress: string };
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
  if ((template.network === 'agent') !== (options.network !== undefined)) throw new Error('sandbox network does not match the template');
  const network = options.network;
  if (network && (!NETWORK_NAME_PATTERN.test(network.name) || !IPV4_PATTERN.test(network.gatewayAddress))) throw new Error('invalid sandbox network');
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
      NetworkMode: network ? network.name : 'none',
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
      // agent：agent-gw 的地址写进 /etc/hosts，不依赖 DNS。
      ExtraHosts: network ? [`${AGENT_GATEWAY_HOSTNAME}:${network.gatewayAddress}`] : [],
      // 不保留容器的标准输出（可能含文档内容）；命令的输出经 exec 取回。
      LogConfig: { Type: 'none', Config: {} },
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
    },
    NetworkingConfig: { EndpointsConfig: network ? { [network.name]: {} } : {} },
  };
}

const NETWORK_NAME_PATTERN = /^zhibiao-sandbox-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export interface NetworkSpecOptions {
  template: SandboxTemplateName;
  jobId: string;
  expiresAt: Date;
}

/**
 * agent 沙箱的专用网络（Docker Engine API POST /networks/create 的请求体，路线图第 8 步决定事项第 2 项 B1）：
 * - internal：没有出口路由（外网、169.254.169.254、宿主的其他网络都到不了）；
 * - 网桥不分配 IPv4 地址（inhibit_ipv4）：宿主在这个网络上没有地址，沙箱连不到宿主上监听所有地址的服务（有对照测试）；
 * - 不开 IPv6、不做地址伪装；网络中只有该沙箱与 agent-gw，与其他沙箱的网络之间由 Docker 的网桥隔离规则隔开；
 * - 标签与沙箱容器相同（模板、任务、到期时间），sandbox-runner 只删除带这些标签的网络，到期的由 sweep 删除。
 */
export function buildNetworkSpec(name: string, options: NetworkSpecOptions): Record<string, unknown> {
  if (!NETWORK_NAME_PATTERN.test(name)) throw new Error('invalid sandbox network');
  return {
    Name: name,
    Driver: 'bridge',
    Internal: true,
    Attachable: false,
    EnableIPv6: false,
    Options: {
      'com.docker.network.bridge.inhibit_ipv4': 'true',
      'com.docker.network.bridge.enable_ip_masquerade': 'false',
    },
    Labels: {
      [SANDBOX_LABEL]: '1',
      [SANDBOX_LABEL_TEMPLATE]: options.template,
      [SANDBOX_LABEL_JOB]: options.jobId,
      [SANDBOX_LABEL_EXPIRES]: String(options.expiresAt.getTime()),
    },
  };
}
