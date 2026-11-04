// 服务端配置：只从环境变量读取，启动时一次性校验。
// 校验失败时报告变量名和期望格式，不回显变量值（数据库密码等密钥也走这里）。
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

/** AI 网关（docs/SERVER_DESIGN.md 第 4、10 节）。 */
export interface AiGatewayConfig {
  /**
   * 主密钥（KEK）文件：32 字节随机数的 base64。只给路径，内容由 src/ai/keyring.ts 在启动时读取，不进入配置对象。
   * 未设置时 AI 网关和平台凭据接口关闭（返回 503）。生产环境将换成云 KMS（第 4.2 节）。
   */
  kekFile: string | null;
  /** 当前主密钥的版本号，写入 provider_credentials.kek_version，轮换时递增。 */
  kekVersion: number;
  /** 单次上游调用的总时长上限（毫秒），含流式输出。 */
  upstreamTimeoutMs: number;
  /** 冻结时长（秒）：超过后冻结自动释放。必须比上游超时至少长 30 秒，结算才不会落在冻结到期之后。 */
  holdTtlSeconds: number;
  /** 单次调用的最大输出 token 数（请求未指定时也按此冻结和传给服务商）。 */
  maxOutputTokens: number;
  /**
   * 允许使用 http、允许解析到内网地址的上游主机名（小写，逗号分隔），用于自托管模型和 CI 中的模拟服务商。
   * 默认空：Base URL 只能是 https，且连接时拒绝私有、回环、链路本地等地址（第 4.4 节）。
   */
  upstreamPrivateHosts: readonly string[];
  /**
   * 每个“组织 + 服务商”同时进行的模型调用数的平台上限（Redis 分布式信号量，src/ai/concurrency.ts）；组织设置
   * org_settings.concurrency_limit 更小时取组织的。未配置 Redis 时不限制。
   */
  concurrencyMax: number;
  /** 交互式调用等待并发名额的最长时间（毫秒），超过返回 429；任务中的调用一直等到被取消。 */
  concurrencyWaitMs: number;
}

/** 对象存储（docs/SERVER_DESIGN.md 第 6.3 节），S3 兼容接口。 */
export interface ObjectStorageConfig {
  /** S3 兼容服务的地址（如 https://s3.ap-east-1.example.com）；为 null 时用 SDK 按 region 推导的 AWS 地址。 */
  endpoint: string | null;
  region: string;
  bucket: string;
  /** 路径风格（https://host/bucket/key）：SeaweedFS 等自建服务需要，多数云厂商用虚拟主机风格。 */
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Redis（Valkey，docs/SERVER_DESIGN.md 第 5 节）：任务队列、事件推送、限流和分布式信号量的共享存储。 */
export interface RedisConfig {
  host: string;
  port: number;
  /** ACL 用户名；为 null 时用 default 用户（开发 compose 和生产都禁用了 default，必须给出用户名）。 */
  username: string | null;
  password: string;
  /** rediss:// 时为 true，用 TLS 连接。 */
  tls: boolean;
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  logLevel: LogLevel;
  /**
   * 站点对外的源（协议 + 主机 + 端口，不带路径），用于 CSRF 的 Origin 校验和邮件中的链接。
   * 生产环境必需且必须是 https；开发、测试环境默认 http://localhost:3000。
   */
  publicOrigin: string;
  /**
   * 可信反向代理的地址（IP 或 CIDR），只有来自这些地址的连接，其 X-Forwarded-For 才被采信。
   * 默认空：不信任任何代理，客户端 IP 取 TCP 连接的对端地址。
   */
  trustedProxies: readonly string[];
  /** 应用连接：非表属主、非超级用户的角色，RLS 对它强制生效（docs/SERVER_DESIGN.md 第 2.6 节）。 */
  database: DatabaseConfig;
  ai: AiGatewayConfig;
  /** 未设置 S3_BUCKET 时为 null，文件接口返回 503。 */
  storage: ObjectStorageConfig | null;
  /** 未设置 REDIS_URL 时为 null，/readyz 不检查 Redis（第 6 步的任务队列接入后改为必需）。 */
  redis: RedisConfig | null;
  /**
   * worker 调用 sandbox-runner 的地址和令牌（6.6 起）。未设置 SANDBOX_RUNNER_URL 时为 null：解析任务失败（PARSE_UNAVAILABLE）。
   * 只有 worker 使用；api 不读取令牌文件以外的内容，也不调用 sandbox-runner。
   */
  sandbox: SandboxClientConfig | null;
}

export interface SandboxClientConfig {
  /** sandbox-runner 的源（如 http://sandbox-runner:3100），只在内部网络 sandbox-control 上。 */
  url: string;
  token: string;
}

/** sandbox-runner 进程的配置（docs/SERVER_DESIGN.md 第 7.5 节），与 api / worker 的配置分开读取。 */
export interface SandboxRunnerConfig {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  logLevel: LogLevel;
  /** Docker Engine API 的 unix socket；只有 sandbox-runner 挂载它。 */
  dockerSocket: string;
  /** 容器运行时：生产只允许 runsc（gVisor）；开发、测试可用参数相同的 runc（第 6 步决定事项第 2 项）。 */
  runtime: SandboxRuntime;
  /** 各镜像的引用，都必须配置；生产必须按摘要固定（name@sha256:...）。export 镜像随样张接口上线（7.3e）改为必需。 */
  images: { parse: string; export: string };
  /** 同时存在的沙箱数上限。 */
  maxActive: number;
  /** worker 调用 sandbox-runner 的共享令牌（至少 32 个字符）。 */
  token: string;
}

export const SANDBOX_RUNTIMES = ['runsc', 'runc'] as const;
export type SandboxRuntime = (typeof SANDBOX_RUNTIMES)[number];

export interface ConfigIssue {
  name: string;
  reason: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`配置不合法：${issues.map((issue) => `${issue.name} ${issue.reason}`).join('；')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export interface LoadConfigOptions {
  /** 读取 *_FILE 指向的密钥文件，测试时替换。 */
  readFile?: (path: string) => string;
}

interface VarSpec<T> {
  /** 未设置（或为空字符串）时使用；不提供即为必需配置。 */
  default?: T;
  /** 返回解析结果；返回 undefined 表示不合法，此时用 expected 作为错误说明。 */
  parse: (raw: string) => T | undefined;
  expected: string;
}

function oneOf<T extends string>(values: readonly T[]): VarSpec<T>['parse'] {
  return (raw) => (values as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

const HOSTNAME_PATTERN = /^[A-Za-z0-9.:-]+$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const HOST_SPEC: VarSpec<string> = {
  parse: (raw) => (HOSTNAME_PATTERN.test(raw) ? raw : undefined),
  expected: 'IP 地址或主机名',
};

function portSpec(defaultPort: number): VarSpec<number> {
  return {
    default: defaultPort,
    parse: (raw) => {
      if (!/^\d{1,5}$/.test(raw)) return undefined;
      const port = Number(raw);
      return port >= 1 && port <= 65535 ? port : undefined;
    },
    expected: '1~65535 的整数',
  };
}

function identifierSpec(defaultValue: string): VarSpec<string> {
  return {
    default: defaultValue,
    parse: (raw) => (IDENTIFIER_PATTERN.test(raw) ? raw : undefined),
    expected: '字母或下划线开头、只含字母数字下划线、不超过 63 个字符的标识符',
  };
}

/** 只接受纯源：http(s)、无用户信息、无路径（或只有 /）、无查询串和片段。返回 URL.origin 的规范形式。 */
function parseOrigin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return undefined;
  if (raw.endsWith('?') || raw.endsWith('#')) return undefined;
  return url.origin;
}

/**
 * 逗号分隔的 IP 或 CIDR。不接受前缀长度为 0（等于信任所有来源，任何客户端都能伪造 IP），
 * 也不接受 proxy-addr 的 loopback 等别名，部署说明中写明实际地址。
 */
function parseTrustedProxies(raw: string): readonly string[] | undefined {
  const entries = raw.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    const [address = '', prefix, ...rest] = entry.split('/');
    const family = isIP(address);
    if (family === 0 || rest.length > 0) return undefined;
    if (prefix !== undefined) {
      if (!/^\d{1,3}$/.test(prefix)) return undefined;
      const bits = Number(prefix);
      if (bits < 1 || bits > (family === 4 ? 32 : 128)) return undefined;
    }
  }
  return Object.freeze(entries);
}

function intSpec(defaultValue: number, min: number, max: number): VarSpec<number> {
  return {
    default: defaultValue,
    parse: (raw) => {
      if (!/^\d{1,10}$/.test(raw)) return undefined;
      const value = Number(raw);
      return value >= min && value <= max ? value : undefined;
    },
    expected: `${min}~${max} 的整数`,
  };
}

interface RedisAddress {
  host: string;
  port: number;
  username: string | null;
  tls: boolean;
}

/**
 * redis:// 或 rediss://，可带 ACL 用户名，不带密码（密码走 REDIS_PASSWORD[_FILE]，不写进连接串）、
 * 不带库号路径、查询串和片段：队列只用 0 号库，避免不同进程配置不一致。
 */
function parseRedisUrl(raw: string): RedisAddress | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') return undefined;
  if (url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return undefined;
  if (raw.endsWith('?') || raw.endsWith('#') || url.port === '0') return undefined;
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (!host || !HOSTNAME_PATTERN.test(host)) return undefined;
  let username: string | null = null;
  if (url.username) {
    try {
      username = decodeURIComponent(url.username);
    } catch {
      return undefined;
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) return undefined;
  }
  return Object.freeze({ host, port: url.port ? Number(url.port) : 6379, username, tls: url.protocol === 'rediss:' });
}

const HOSTNAME_LIST_ENTRY = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$|^\[[0-9a-f:.]+\]$/;

function parseHostList(raw: string): readonly string[] | undefined {
  const entries = raw.split(',').map((entry) => entry.trim().toLowerCase());
  return entries.every((entry) => HOSTNAME_LIST_ENTRY.test(entry)) ? Object.freeze(entries) : undefined;
}

/** 冻结时长至少比上游超时长这么多，留给结算。 */
export const HOLD_SETTLE_MARGIN_MS = 30_000;

const DEV_PUBLIC_ORIGIN = 'http://localhost:3000';

function createReader(env: Env, options: LoadConfigOptions) {
  const issues: ConfigIssue[] = [];
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  function read<T>(name: string, spec: VarSpec<T>): T {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') {
      if (spec.default !== undefined) return spec.default;
      issues.push({ name, reason: `缺失（必需，${spec.expected}）` });
      return undefined as T;
    }
    const value = spec.parse(raw);
    if (value === undefined) {
      issues.push({ name, reason: `不合法（应为${spec.expected}）` });
      return undefined as T;
    }
    return value;
  }

  /**
   * 密钥：NAME 直接给值，或 NAME_FILE 给文件路径（Docker secrets），二者只能设置一个。
   * 文件内容去掉首尾空白；读取失败时只报告变量名，不带路径以外的细节。
   */
  function readSecret(name: string): string {
    const fileName = `${name}_FILE`;
    const direct = env[name];
    const file = env[fileName]?.trim();
    if (direct !== undefined && direct !== '' && file) {
      issues.push({ name, reason: `与 ${fileName} 只能设置一个` });
      return undefined as unknown as string;
    }
    if (file) {
      let content: string;
      try {
        content = readFile(file);
      } catch {
        issues.push({ name: fileName, reason: '指向的文件无法读取' });
        return undefined as unknown as string;
      }
      const value = content.trim();
      if (value === '') issues.push({ name: fileName, reason: '指向的文件为空' });
      return value;
    }
    if (direct === undefined || direct === '') {
      issues.push({ name, reason: `缺失（必需，设置 ${name} 或 ${fileName}）` });
      return undefined as unknown as string;
    }
    return direct;
  }

  function readDatabase(userVar: string, defaultUser: string, passwordVar: string): DatabaseConfig {
    return Object.freeze({
      host: read('DATABASE_HOST', { ...HOST_SPEC, default: '127.0.0.1' }),
      port: read('DATABASE_PORT', portSpec(5432)),
      name: read('DATABASE_NAME', identifierSpec('bidtools')),
      user: read(userVar, identifierSpec(defaultUser)),
      password: readSecret(passwordVar),
    });
  }

  function finish<T extends object>(config: T): T {
    if (issues.length > 0) throw new ConfigError(issues);
    return Object.freeze(config);
  }

  function readAi(): AiGatewayConfig {
    const kekFile = env.AI_KEK_FILE?.trim();
    const upstreamTimeoutMs = read('AI_UPSTREAM_TIMEOUT_MS', intSpec(300_000, 1_000, 3_000_000));
    const holdTtlSeconds = read('AI_HOLD_TTL_SECONDS', intSpec(900, 60, 3600));
    if (upstreamTimeoutMs !== undefined && holdTtlSeconds !== undefined && holdTtlSeconds * 1000 < upstreamTimeoutMs + HOLD_SETTLE_MARGIN_MS) {
      issues.push({ name: 'AI_HOLD_TTL_SECONDS', reason: `不合法（必须比 AI_UPSTREAM_TIMEOUT_MS 至少长 ${HOLD_SETTLE_MARGIN_MS / 1000} 秒）` });
    }
    return Object.freeze({
      kekFile: kekFile ? kekFile : null,
      kekVersion: read('AI_KEK_VERSION', intSpec(1, 1, 1_000_000)),
      upstreamTimeoutMs,
      holdTtlSeconds,
      maxOutputTokens: read('AI_MAX_OUTPUT_TOKENS', intSpec(8192, 1, 1_000_000)),
      upstreamPrivateHosts: read('AI_UPSTREAM_PRIVATE_HOSTS', {
        default: Object.freeze([]),
        parse: parseHostList,
        expected: '逗号分隔的小写主机名或 IP（如 127.0.0.1,llm.internal）',
      }),
      concurrencyMax: read('AI_CONCURRENCY_MAX', intSpec(10, 1, 1000)),
      concurrencyWaitMs: read('AI_CONCURRENCY_WAIT_MS', intSpec(30_000, 0, 600_000)),
    });
  }

  /**
   * 设置了 S3_BUCKET 才启用；启用后访问密钥必需。生产环境的 endpoint 必须是 https。
   * 密钥可以用 S3_SECRET_ACCESS_KEY_FILE 给出（Docker secrets）。
   */
  function readStorage(production: boolean): ObjectStorageConfig | null {
    const bucket = env.S3_BUCKET?.trim();
    if (!bucket) return null;
    return Object.freeze({
      endpoint: read('S3_ENDPOINT', {
        default: null,
        parse: (raw) => {
          const origin = parseOrigin(raw);
          return origin !== undefined && (!production || origin.startsWith('https://')) ? origin : undefined;
        },
        expected: production ? 'https 地址（不带路径）' : 'http(s) 地址（不带路径，如 http://127.0.0.1:8333）',
      } as VarSpec<string | null>),
      region: read('S3_REGION', {
        default: 'us-east-1',
        parse: (raw) => (/^[a-z0-9-]{1,64}$/.test(raw) ? raw : undefined),
        expected: '小写字母、数字和连字符组成的地域名（如 ap-east-1）',
      }),
      bucket: read('S3_BUCKET', {
        parse: (raw) => (/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(raw) ? raw : undefined),
        expected: '3~63 位小写字母、数字、点和连字符组成的 bucket 名',
      }),
      forcePathStyle: read('S3_FORCE_PATH_STYLE', {
        default: false,
        parse: (raw) => (raw === 'true' ? true : raw === 'false' ? false : undefined),
        expected: 'true / false',
      }),
      accessKeyId: read('S3_ACCESS_KEY_ID', {
        parse: (raw) => (/^[\x21-\x7e]{1,256}$/.test(raw) ? raw : undefined),
        expected: '不含空白的访问密钥 ID',
      }),
      secretAccessKey: readSecret('S3_SECRET_ACCESS_KEY'),
    });
  }

  /** 设置了 REDIS_URL 才启用；启用后密码必需（REDIS_PASSWORD 或 REDIS_PASSWORD_FILE）。 */
  function readRedis(): RedisConfig | null {
    if (!env.REDIS_URL?.trim()) return null;
    const address = read('REDIS_URL', {
      parse: parseRedisUrl,
      expected: 'redis:// 或 rediss:// 地址（可带用户名，不带密码和路径，如 redis://bidtools@redis:6379）',
    });
    const password = readSecret('REDIS_PASSWORD');
    return Object.freeze({ ...address, password });
  }

  /** 设置了 SANDBOX_RUNNER_URL 才启用；启用后令牌必需（SANDBOX_RUNNER_TOKEN 或 SANDBOX_RUNNER_TOKEN_FILE，至少 32 个字符）。 */
  function readSandboxClient(): SandboxClientConfig | null {
    if (!env.SANDBOX_RUNNER_URL?.trim()) return null;
    const url = read('SANDBOX_RUNNER_URL', {
      parse: parseOrigin,
      expected: 'http(s) 地址（不带路径，如 http://sandbox-runner:3100）',
    });
    const token = readSecret('SANDBOX_RUNNER_TOKEN');
    if (token !== undefined && token !== '' && token.length < 32) fail('SANDBOX_RUNNER_TOKEN', '过短（至少 32 个字符）');
    return Object.freeze({ url, token });
  }

  function fail(name: string, reason: string) {
    issues.push({ name, reason });
  }

  return { read, readSecret, readDatabase, readAi, readStorage, readRedis, readSandboxClient, fail, finish };
}

export function loadConfig(env: Env, options: LoadConfigOptions = {}): AppConfig {
  const { read, readDatabase, readAi, readStorage, readRedis, readSandboxClient, finish } = createReader(env, options);
  const nodeEnv = read('NODE_ENV', {
    parse: oneOf(NODE_ENVS),
    expected: NODE_ENVS.join(' / '),
  });
  const production = nodeEnv === 'production';
  return finish<AppConfig>({
    nodeEnv,
    host: read('HOST', { ...HOST_SPEC, default: '127.0.0.1' }),
    port: read('PORT', portSpec(3000)),
    logLevel: read('LOG_LEVEL', {
      default: 'info',
      parse: oneOf(LOG_LEVELS),
      expected: LOG_LEVELS.join(' / '),
    }),
    // 生产环境不设默认值：Cookie 带 Secure、链接要发给用户，必须明确配置为 https。
    publicOrigin: read('PUBLIC_ORIGIN', {
      ...(production ? {} : { default: DEV_PUBLIC_ORIGIN }),
      parse: (raw) => {
        const origin = parseOrigin(raw);
        return origin !== undefined && (!production || origin.startsWith('https://')) ? origin : undefined;
      },
      expected: production ? 'https 源（如 https://bid.example.com，不带路径）' : 'http(s) 源（如 http://localhost:3000，不带路径）',
    }),
    trustedProxies: read('TRUSTED_PROXIES', {
      default: Object.freeze([]),
      parse: parseTrustedProxies,
      expected: '逗号分隔的 IP 或 CIDR（如 172.30.0.2 或 172.30.0.0/24，前缀不能为 0）',
    }),
    database: readDatabase('DATABASE_USER', 'bidtools_app', 'DATABASE_PASSWORD'),
    ai: readAi(),
    storage: readStorage(production),
    redis: readRedis(),
    sandbox: readSandboxClient(),
  });
}

/**
 * 迁移命令的配置：用表属主角色连接，与应用连接共用 DATABASE_HOST / PORT / NAME。
 * 应用进程不读取这些变量，属主密码不进入 api 容器。
 */
export function loadMigrationConfig(env: Env, options: LoadConfigOptions = {}): DatabaseConfig {
  const { readDatabase, finish } = createReader(env, options);
  return finish(readDatabase('MIGRATION_DATABASE_USER', 'bidtools_owner', 'MIGRATION_DATABASE_PASSWORD'));
}

const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/;
const PINNED_IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/:-]{0,254}@sha256:[a-f0-9]{64}$/;

/**
 * sandbox-runner 的配置。生产环境的运行时必须是 runsc、镜像必须按摘要固定；配置成 runc 或未固定的标签时拒绝启动。
 * 镜像不在这里拉取：部署时预先拉好，sandbox-runner 不访问镜像仓库。
 */
export function loadSandboxRunnerConfig(env: Env, options: LoadConfigOptions = {}): SandboxRunnerConfig {
  const { read, readSecret, fail, finish } = createReader(env, options);
  const nodeEnv = read('NODE_ENV', { parse: oneOf(NODE_ENVS), expected: NODE_ENVS.join(' / ') });
  const production = nodeEnv === 'production';
  const runtime = read('SANDBOX_RUNTIME', {
    ...(production ? {} : { default: 'runc' as const }),
    parse: (raw) => {
      const value = oneOf(SANDBOX_RUNTIMES)(raw);
      return production && value !== 'runsc' ? undefined : value;
    },
    expected: production ? 'runsc（生产环境只允许 gVisor）' : SANDBOX_RUNTIMES.join(' / '),
  });
  const token = readSecret('SANDBOX_RUNNER_TOKEN');
  if (token !== undefined && token !== '' && token.length < 32) fail('SANDBOX_RUNNER_TOKEN', '过短（至少 32 个字符）');
  const imageSpec = {
    parse: (raw: string) => ((production ? PINNED_IMAGE_REFERENCE : IMAGE_REFERENCE).test(raw) ? raw : undefined),
    expected: production ? '按摘要固定的镜像引用（name@sha256:...）' : '镜像引用（生产环境必须按摘要固定）',
  };
  return finish<SandboxRunnerConfig>({
    nodeEnv,
    host: read('HOST', { ...HOST_SPEC, default: '127.0.0.1' }),
    port: read('PORT', portSpec(3100)),
    logLevel: read('LOG_LEVEL', { default: 'info', parse: oneOf(LOG_LEVELS), expected: LOG_LEVELS.join(' / ') }),
    dockerSocket: read('DOCKER_SOCKET', {
      default: '/var/run/docker.sock',
      parse: (raw) => (/^\/[A-Za-z0-9._/-]{1,200}$/.test(raw) && !raw.split('/').includes('..') ? raw : undefined),
      expected: 'unix socket 的绝对路径',
    }),
    runtime,
    images: Object.freeze({
      parse: read('SANDBOX_PARSE_IMAGE', imageSpec),
      export: read('SANDBOX_EXPORT_IMAGE', imageSpec),
    }),
    maxActive: read('SANDBOX_MAX_ACTIVE', intSpec(8, 1, 256)),
    token,
  });
}
