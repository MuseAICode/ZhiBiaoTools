import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadMigrationConfig, type LoadConfigOptions } from '../src/config.ts';

/** 满足必需项的最小环境。 */
const BASE_ENV = { NODE_ENV: 'test', DATABASE_PASSWORD: 'pw' } as const;

function expectConfigError(env: Record<string, string | undefined>, options: LoadConfigOptions = {}): ConfigError {
  try {
    loadConfig(env, options);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('loadConfig 应当抛出 ConfigError');
}

describe('loadConfig', () => {
  it('只设置必需项时使用默认值', () => {
    expect(loadConfig({ NODE_ENV: 'production', DATABASE_PASSWORD: 'pw', PUBLIC_ORIGIN: 'https://bid.example.com' })).toEqual({
      nodeEnv: 'production',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      publicOrigin: 'https://bid.example.com',
      trustedProxies: [],
      database: { host: '127.0.0.1', port: 5432, name: 'bidtools', user: 'bidtools_app', password: 'pw' },
      ai: { kekFile: null, kekVersion: 1, upstreamTimeoutMs: 300_000, holdTtlSeconds: 900, maxOutputTokens: 8192, upstreamPrivateHosts: [] },
      storage: null,
    });
  });

  it('读取并解析全部配置，忽略无关环境变量', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      PUBLIC_ORIGIN: 'http://127.0.0.1:5173/',
      TRUSTED_PROXIES: '172.30.0.2, 10.0.0.0/8,fd00::1',
      DATABASE_HOST: 'postgres',
      DATABASE_PORT: '6543',
      DATABASE_NAME: 'bidtools_dev',
      DATABASE_USER: 'app_user',
      DATABASE_PASSWORD: ' secret with spaces ',
      AI_KEK_FILE: '/run/secrets/ai_kek',
      AI_KEK_VERSION: '2',
      AI_UPSTREAM_TIMEOUT_MS: '60000',
      AI_HOLD_TTL_SECONDS: '120',
      AI_MAX_OUTPUT_TOKENS: '4096',
      AI_UPSTREAM_PRIVATE_HOSTS: '127.0.0.1, LLM.internal',
      PATH: '/usr/bin',
      UNRELATED: 'x',
    });
    expect(config).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'debug',
      publicOrigin: 'http://127.0.0.1:5173',
      trustedProxies: ['172.30.0.2', '10.0.0.0/8', 'fd00::1'],
      database: { host: 'postgres', port: 6543, name: 'bidtools_dev', user: 'app_user', password: ' secret with spaces ' },
      ai: {
        kekFile: '/run/secrets/ai_kek',
        kekVersion: 2,
        upstreamTimeoutMs: 60_000,
        holdTtlSeconds: 120,
        maxOutputTokens: 4096,
        upstreamPrivateHosts: ['127.0.0.1', 'llm.internal'],
      },
      storage: null,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.ai)).toBe(true);
  });

  it('缺少必需的 NODE_ENV、数据库密码时失败', () => {
    const error = expectConfigError({});
    expect(error.issues).toEqual([
      { name: 'NODE_ENV', reason: expect.stringContaining('缺失') },
      { name: 'DATABASE_PASSWORD', reason: expect.stringContaining('缺失') },
    ]);
  });

  it('空字符串视为未设置', () => {
    const error = expectConfigError({ NODE_ENV: '  ', DATABASE_PASSWORD: '' });
    expect(error.issues.map((issue) => issue.name)).toEqual(['NODE_ENV', 'DATABASE_PASSWORD']);
    expect(loadConfig({ ...BASE_ENV, PORT: '' }).port).toBe(3000);
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '80.5'],
    ['PORT', '-1'],
    ['PORT', 'abc'],
    ['LOG_LEVEL', 'verbose'],
    ['HOST', 'http://example.com/'],
    ['DATABASE_HOST', 'db/evil'],
    ['DATABASE_PORT', '99999'],
    ['DATABASE_NAME', 'bidtools; DROP'],
    ['DATABASE_USER', '1abc'],
    ['AI_KEK_VERSION', '0'],
    ['AI_UPSTREAM_TIMEOUT_MS', '999'],
    ['AI_HOLD_TTL_SECONDS', '3601'],
    ['AI_MAX_OUTPUT_TOKENS', '0'],
    ['AI_MAX_OUTPUT_TOKENS', '1.5'],
    ['AI_UPSTREAM_PRIVATE_HOSTS', 'http://127.0.0.1'],
    ['AI_UPSTREAM_PRIVATE_HOSTS', '127.0.0.1,'],
  ])('%s=%s 不合法时失败', (name, value) => {
    const error = expectConfigError({ ...BASE_ENV, [name]: value });
    expect(error.issues).toEqual([{ name, reason: expect.stringContaining('不合法') }]);
  });

  it('冻结时长必须比上游超时至少长 30 秒，否则结算可能落在冻结到期之后', () => {
    const error = expectConfigError({ ...BASE_ENV, AI_UPSTREAM_TIMEOUT_MS: '300000', AI_HOLD_TTL_SECONDS: '300' });
    expect(error.issues).toEqual([{ name: 'AI_HOLD_TTL_SECONDS', reason: expect.stringContaining('至少长 30 秒') }]);
    expect(loadConfig({ ...BASE_ENV, AI_UPSTREAM_TIMEOUT_MS: '270000', AI_HOLD_TTL_SECONDS: '300' }).ai.holdTtlSeconds).toBe(300);
  });

  it('一次报告全部问题', () => {
    const error = expectConfigError({ PORT: 'x', LOG_LEVEL: 'y' });
    expect(error.issues.map((issue) => issue.name)).toEqual(['NODE_ENV', 'PORT', 'LOG_LEVEL', 'DATABASE_PASSWORD']);
  });

  it('错误信息不回显变量值', () => {
    const secretLike = 'postgres://admin:hunter2@db/prod';
    const error = expectConfigError({
      NODE_ENV: secretLike,
      PORT: secretLike,
      HOST: secretLike,
      DATABASE_USER: secretLike,
      DATABASE_PASSWORD: 'hunter2',
      DATABASE_PASSWORD_FILE: '/run/secrets/hunter2',
    });
    expect(error.message).not.toContain('hunter2');
    expect(JSON.stringify(error.issues)).not.toContain('hunter2');
  });
});

describe('PUBLIC_ORIGIN', () => {
  it('开发、测试环境默认 http://localhost:3000', () => {
    expect(loadConfig(BASE_ENV).publicOrigin).toBe('http://localhost:3000');
    expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'development' }).publicOrigin).toBe('http://localhost:3000');
  });

  it('生产环境必需，且必须是 https', () => {
    const production = { NODE_ENV: 'production', DATABASE_PASSWORD: 'pw' };
    expect(expectConfigError(production).issues).toEqual([{ name: 'PUBLIC_ORIGIN', reason: expect.stringContaining('缺失') }]);
    expect(expectConfigError({ ...production, PUBLIC_ORIGIN: 'http://bid.example.com' }).issues).toEqual([
      { name: 'PUBLIC_ORIGIN', reason: expect.stringContaining('https') },
    ]);
  });

  it.each([
    'bid.example.com',
    'ftp://bid.example.com',
    'https://bid.example.com/app',
    'https://user:pw@bid.example.com',
    'https://bid.example.com?x=1',
    'https://bid.example.com#x',
  ])('不是纯源时失败：%s', (value) => {
    const error = expectConfigError({ ...BASE_ENV, PUBLIC_ORIGIN: value });
    expect(error.issues.map((issue) => issue.name)).toEqual(['PUBLIC_ORIGIN']);
    expect(error.message).not.toContain(value);
  });

  it('规范化为 URL.origin（小写主机、去掉默认端口和末尾斜杠）', () => {
    expect(loadConfig({ ...BASE_ENV, PUBLIC_ORIGIN: 'HTTPS://Bid.Example.com:443/' }).publicOrigin).toBe('https://bid.example.com');
  });
});

describe('TRUSTED_PROXIES', () => {
  it('默认不信任任何代理', () => {
    expect(loadConfig(BASE_ENV).trustedProxies).toEqual([]);
    expect(loadConfig({ ...BASE_ENV, TRUSTED_PROXIES: '  ' }).trustedProxies).toEqual([]);
  });

  it('接受 IPv4 / IPv6 地址和 CIDR', () => {
    const config = loadConfig({ ...BASE_ENV, TRUSTED_PROXIES: '127.0.0.1,::1,172.30.0.0/24,fd00::/64' });
    expect(config.trustedProxies).toEqual(['127.0.0.1', '::1', '172.30.0.0/24', 'fd00::/64']);
    expect(Object.isFrozen(config.trustedProxies)).toBe(true);
  });

  it.each([
    'caddy',
    'loopback',
    '0.0.0.0/0',
    '::/0',
    '10.0.0.0/33',
    'fd00::/129',
    '10.0.0.0/',
    '10.0.0.0/8/1',
    '10.0.0.1,',
    '10.0.0.1,,10.0.0.2',
    '10.0.0.256',
  ])('不合法时失败且不回显值：%s', (value) => {
    const error = expectConfigError({ ...BASE_ENV, TRUSTED_PROXIES: value });
    expect(error.issues.map((issue) => issue.name)).toEqual(['TRUSTED_PROXIES']);
    expect(error.message).not.toContain(value);
  });
});

describe('数据库密码', () => {
  const files: Record<string, string> = {
    '/run/secrets/db_app_password': 'from-file\n',
    '/run/secrets/empty': '  \n',
  };
  const readFile: LoadConfigOptions['readFile'] = (path) => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };

  it('从 DATABASE_PASSWORD_FILE 读取并去掉首尾空白', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PASSWORD_FILE: '/run/secrets/db_app_password' }, { readFile });
    expect(config.database.password).toBe('from-file');
  });

  it('同时设置 DATABASE_PASSWORD 和 DATABASE_PASSWORD_FILE 时失败', () => {
    const error = expectConfigError(
      { NODE_ENV: 'test', DATABASE_PASSWORD: 'pw', DATABASE_PASSWORD_FILE: '/run/secrets/db_app_password' },
      { readFile },
    );
    expect(error.issues).toEqual([{ name: 'DATABASE_PASSWORD', reason: expect.stringContaining('只能设置一个') }]);
  });

  it.each([
    ['/run/secrets/missing', '无法读取'],
    ['/run/secrets/empty', '为空'],
  ])('密码文件 %s 不可用时失败（%s）', (path, reason) => {
    const error = expectConfigError({ NODE_ENV: 'test', DATABASE_PASSWORD_FILE: path }, { readFile });
    expect(error.issues).toEqual([{ name: 'DATABASE_PASSWORD_FILE', reason: expect.stringContaining(reason) }]);
    expect(error.message).not.toContain(path);
  });
});

describe('对象存储（S3_*）', () => {
  const S3_ENV = { ...BASE_ENV, S3_BUCKET: 'bidtools-files', S3_ACCESS_KEY_ID: 'AKIDEXAMPLE', S3_SECRET_ACCESS_KEY: 's3-secret' };

  it('未设置 S3_BUCKET 时关闭', () => {
    expect(loadConfig(BASE_ENV).storage).toBeNull();
  });

  it('设置 S3_BUCKET 后读取全部参数，密钥可以来自文件', () => {
    expect(loadConfig({ ...S3_ENV, S3_ENDPOINT: 'http://127.0.0.1:8333', S3_REGION: 'ap-east-1', S3_FORCE_PATH_STYLE: 'true' }).storage).toEqual({
      endpoint: 'http://127.0.0.1:8333',
      region: 'ap-east-1',
      bucket: 'bidtools-files',
      forcePathStyle: true,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 's3-secret',
    });
    const fromFile = loadConfig(
      { ...S3_ENV, S3_SECRET_ACCESS_KEY: undefined, S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/s3' },
      { readFile: () => 'file-secret\n' },
    );
    expect(fromFile.storage).toMatchObject({ endpoint: null, region: 'us-east-1', forcePathStyle: false, secretAccessKey: 'file-secret' });
  });

  it('启用后缺少访问密钥时失败，错误信息不回显密钥', () => {
    const error = expectConfigError({ ...BASE_ENV, S3_BUCKET: 'bidtools-files', S3_ACCESS_KEY_ID: 'AKIDEXAMPLE' });
    expect(error.issues.map((issue) => issue.name)).toEqual(['S3_SECRET_ACCESS_KEY']);
    const bad = expectConfigError({ ...S3_ENV, S3_ENDPOINT: 'ftp://s3.example.com', S3_FORCE_PATH_STYLE: 'yes' });
    expect(bad.issues.map((issue) => issue.name)).toEqual(['S3_ENDPOINT', 'S3_FORCE_PATH_STYLE']);
    expect(bad.message).not.toContain('s3-secret');
  });

  it('生产环境的 endpoint 必须是 https；bucket 名必须合法', () => {
    const production = { ...S3_ENV, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://bid.example.com' };
    expect(expectConfigError({ ...production, S3_ENDPOINT: 'http://s3.example.com' }).issues.map((issue) => issue.name)).toEqual(['S3_ENDPOINT']);
    expect(loadConfig({ ...production, S3_ENDPOINT: 'https://s3.example.com' }).storage?.endpoint).toBe('https://s3.example.com');
    expect(expectConfigError({ ...S3_ENV, S3_BUCKET: '../Bad_Bucket' }).issues.map((issue) => issue.name)).toEqual(['S3_BUCKET']);
  });
});

describe('loadMigrationConfig', () => {
  it('使用属主角色和独立的密码变量，与应用共用主机、端口、库名', () => {
    const config = loadMigrationConfig({
      DATABASE_HOST: 'postgres',
      DATABASE_PASSWORD: 'app-pw',
      MIGRATION_DATABASE_PASSWORD: 'owner-pw',
    });
    expect(config).toEqual({ host: 'postgres', port: 5432, name: 'bidtools', user: 'bidtools_owner', password: 'owner-pw' });
  });

  it('不接受应用角色的密码代替属主密码', () => {
    expect(() => loadMigrationConfig({ DATABASE_PASSWORD: 'app-pw' })).toThrow(ConfigError);
  });
});
