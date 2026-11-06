import { describe, expect, it } from 'vitest';
import { ConfigError, loadSandboxRunnerConfig } from '../../src/config.ts';
import { buildContainerSpec, resolveCommand, SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';

const parse = SANDBOX_TEMPLATES.parse;
const JOB_ID = '7d3c9b0e-1f2a-4b5c-8d6e-0f1a2b3c4d5e';

describe('parse template', () => {
  const spec = buildContainerSpec(parse, { image: 'zhibiao-parse@sha256:' + 'a'.repeat(64), runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) });
  const host = spec.HostConfig;

  it('has no network, a read-only root filesystem and no privileges', () => {
    expect(host.NetworkMode).toBe('none');
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Privileged).toBe(false);
    expect(host.CapDrop).toEqual(['ALL']);
    expect(host.CapAdd).toBeUndefined();
    expect(host.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(spec.User).toBe('10001:10001');
    expect(host.Runtime).toBe('runsc');
  });

  it('mounts nothing from the host and injects no host environment', () => {
    expect(host.Binds).toEqual([]);
    expect(host.Mounts).toEqual([]);
    expect(host.Devices).toEqual([]);
    expect(host.VolumesFrom).toBeUndefined();
    expect(spec.Volumes).toBeUndefined();
    expect(spec.Env).toEqual(['HOME=/tmp', 'LANG=C.UTF-8', 'TMPDIR=/tmp']);
    expect(Object.keys(host.Tmpfs as object).sort()).toEqual(['/input', '/output', '/tmp']);
    for (const options of Object.values(host.Tmpfs as Record<string, string>)) expect(options).toMatch(/^rw,noexec,nosuid,nodev,size=\d+,/);
  });

  it('applies the resource limits of decision 5 (2 GiB memory without swap, 1 CPU)', () => {
    expect(host.Memory).toBe(2 * 1024 ** 3);
    expect(host.MemorySwap).toBe(host.Memory);
    expect(host.NanoCpus).toBe(1e9);
    expect(host.PidsLimit).toBe(256);
    expect(parse.commands.parse!.timeoutMs).toBe(10 * 60_000);
    expect(parse.output.maxFiles).toBeGreaterThanOrEqual(2000);
    expect(host.LogConfig).toEqual({ Type: 'none', Config: {} });
  });

  it('labels the container with the template, job and expiry', () => {
    expect(spec.Labels).toEqual({ 'zhibiao.sandbox': '1', 'zhibiao.sandbox.template': 'parse', 'zhibiao.sandbox.job': JOB_ID, 'zhibiao.sandbox.expires': '1000' });
  });

  it('only resolves registered commands with well-formed arguments', () => {
    expect(resolveCommand(parse, 'parse', ['docx'])).toEqual({ argv: ['node', '/opt/parse/entry.mjs', 'docx'], timeoutMs: 600_000 });
    expect(resolveCommand(parse, 'sh', [])).toBeNull();
    expect(resolveCommand(parse, 'toString', [])).toBeNull();
    expect(resolveCommand(parse, '__proto__', [])).toBeNull();
    expect(resolveCommand(parse, 'parse', ['--eval=x;y'])).toBeNull();
    expect(resolveCommand(parse, 'parse', ['../etc/passwd'])).toBeNull();
    expect(resolveCommand(parse, 'parse', ['/input/x'])).toBeNull();
    expect(resolveCommand(parse, 'parse', ['a b'])).toBeNull();
    expect(resolveCommand(parse, 'parse', Array.from({ length: 9 }, () => 'x'))).toBeNull();
    expect(resolveCommand(parse, 'parse', [1 as unknown as string])).toBeNull();
  });
});

describe('export templates', () => {
  const MIB = 1024 ** 2;
  const GIB = 1024 ** 3;
  const image = 'zhibiao-export@sha256:' + 'c'.repeat(64);
  const parseHost = buildContainerSpec(parse, { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) }).HostConfig;

  it.each(['export-preview', 'export-document'] as const)('%s reuses the isolation of the parse template', (name) => {
    const template = SANDBOX_TEMPLATES[name];
    expect(template.image).toBe('export');
    const spec = buildContainerSpec(template, { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) });
    const host = spec.HostConfig;
    // 网络、只读根文件系统、用户、能力、运行时、挂载、环境变量、日志与 parse 完全相同，不同的只有资源上限和可写目录。
    for (const key of ['NetworkMode', 'ReadonlyRootfs', 'Privileged', 'CapDrop', 'SecurityOpt', 'Init', 'IpcMode', 'Runtime', 'Binds', 'Mounts', 'Devices', 'Dns', 'ExtraHosts', 'LogConfig', 'RestartPolicy']) {
      expect(host[key], key).toEqual(parseHost[key]);
    }
    expect(spec.User).toBe('10001:10001');
    expect(spec.Env).toEqual(['HOME=/tmp', 'LANG=C.UTF-8', 'TMPDIR=/tmp']);
    expect(spec.Labels).toMatchObject({ 'zhibiao.sandbox.template': name });
    expect(Object.keys(host.Tmpfs as object).sort()).toEqual(['/output', '/tmp', '/work']);
    for (const options of Object.values(host.Tmpfs as Record<string, string>)) expect(options).toMatch(/^rw,noexec,nosuid,nodev,size=\d+,/);
    expect(host.MemorySwap).toBe(host.Memory);
    expect(host.NanoCpus).toBe(1e9);
    // 取回：只有 document.docx 和 result.json，docx 不超过 100 MiB。
    expect(template.output).toMatchObject({ directory: '/output', maxDepth: 1, maxFiles: 2, maxFileBytes: 100 * MIB });
    expect([...template.output.extensions!].sort()).toEqual(['docx', 'json']);
    expect(template.input.directory).toBe('/work');
    expect(template.input.maxDepth).toBe(2);
  });

  it('applies the preview limits of step 7 decision 5 (1 GiB memory, 1 CPU, 60 seconds)', () => {
    const preview = SANDBOX_TEMPLATES['export-preview'];
    expect(preview.memoryBytes).toBe(1 * GIB);
    expect(preview.commands.export!.timeoutMs).toBe(60_000);
    expect(preview.lifetimeMs).toBeGreaterThan(preview.commands.export!.timeoutMs + 2 * preview.transferTimeoutMs);
  });

  it('applies the whole-document limits of step 7 decision 5 and 7.4b (2 GiB memory, 1 CPU, 20 minutes, 128 MiB input, 2,000 images)', () => {
    const document = SANDBOX_TEMPLATES['export-document'];
    expect(document.memoryBytes).toBe(2 * GIB);
    expect(document.commands.export!.timeoutMs).toBe(20 * 60_000);
    expect(document.input.maxTotalBytes).toBe(128 * MIB);
    expect(document.input.maxFiles).toBe(2_001);
    expect(document.lifetimeMs).toBeGreaterThan(document.commands.export!.timeoutMs + 2 * document.transferTimeoutMs);
    // 输入、装饰与助手写出的 docx 都在 /work 中。
    expect(document.tmpfs['/work']!.bytes).toBeGreaterThanOrEqual(document.input.maxTotalBytes + 100 * MIB);
    // 7.4b：tmpfs 计入内存上限。写满全部 tmpfs，再加上助手约为输入 2 倍的内存（实测），仍在内存上限之内。
    const tmpfsBytes = Object.values(document.tmpfs).reduce((sum, item) => sum + item.bytes, 0);
    expect(tmpfsBytes + 2 * document.input.maxTotalBytes).toBeLessThanOrEqual(document.memoryBytes - 512 * MIB);
  });

  it('only runs the export entry with the mode fixed by the template', () => {
    expect(resolveCommand(SANDBOX_TEMPLATES['export-preview'], 'export', [])).toEqual({ argv: ['node', '/opt/export/entry.mjs', 'preview'], timeoutMs: 60_000 });
    expect(resolveCommand(SANDBOX_TEMPLATES['export-document'], 'export', [])).toEqual({ argv: ['node', '/opt/export/entry.mjs', 'document'], timeoutMs: 1_200_000 });
    expect(resolveCommand(SANDBOX_TEMPLATES['export-preview'], 'export', ['document'])).toBeNull();
    expect(resolveCommand(SANDBOX_TEMPLATES['export-preview'], 'export', [''])).toBeNull();
    expect(resolveCommand(SANDBOX_TEMPLATES['export-preview'], 'parse', [])).toBeNull();
    expect(resolveCommand(parse, 'export', [])).toBeNull();
  });
});

describe('loadSandboxRunnerConfig', () => {
  const token = 't'.repeat(40);
  const base = { NODE_ENV: 'development', SANDBOX_PARSE_IMAGE: 'zhibiao-parse:dev', SANDBOX_EXPORT_IMAGE: 'zhibiao-export:dev', SANDBOX_RUNNER_TOKEN: token };
  const pinned = `registry.example.com/zhibiao-parse@sha256:${'b'.repeat(64)}`;
  const exportPinned = `registry.example.com/zhibiao-export@sha256:${'d'.repeat(64)}`;

  it('defaults to runc in development and listens on 3100', () => {
    const config = loadSandboxRunnerConfig(base);
    expect(config.runtime).toBe('runc');
    expect(config.port).toBe(3100);
    expect(config.dockerSocket).toBe('/var/run/docker.sock');
    expect(config.maxActive).toBe(8);
  });

  it('only allows gVisor and digest-pinned images in production', () => {
    const production = { ...base, NODE_ENV: 'production', SANDBOX_PARSE_IMAGE: pinned, SANDBOX_EXPORT_IMAGE: exportPinned };
    expect(loadSandboxRunnerConfig({ ...production, SANDBOX_RUNTIME: 'runsc' }).runtime).toBe('runsc');
    expect(() => loadSandboxRunnerConfig(production)).toThrow(ConfigError);
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_RUNTIME: 'runc' })).toThrow(/SANDBOX_RUNTIME/);
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_RUNTIME: 'runsc', SANDBOX_PARSE_IMAGE: 'zhibiao-parse:latest' })).toThrow(/SANDBOX_PARSE_IMAGE/);
  });

  it('requires the export image since the preview endpoint ships (7.3e), and pins it in production', () => {
    expect(loadSandboxRunnerConfig(base).images).toEqual({ parse: 'zhibiao-parse:dev', export: 'zhibiao-export:dev' });
    expect(() => loadSandboxRunnerConfig({ ...base, SANDBOX_EXPORT_IMAGE: undefined })).toThrow(/SANDBOX_EXPORT_IMAGE/);
    expect(() => loadSandboxRunnerConfig({ ...base, SANDBOX_EXPORT_IMAGE: '' })).toThrow(/SANDBOX_EXPORT_IMAGE/);
    const production = { ...base, NODE_ENV: 'production', SANDBOX_RUNTIME: 'runsc', SANDBOX_PARSE_IMAGE: pinned };
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_EXPORT_IMAGE: 'zhibiao-export:latest' })).toThrow(/SANDBOX_EXPORT_IMAGE/);
    expect(loadSandboxRunnerConfig({ ...production, SANDBOX_EXPORT_IMAGE: exportPinned }).images.export).toBe(exportPinned);
  });

  it('requires a long token and does not echo it', () => {
    expect(() => loadSandboxRunnerConfig({ ...base, SANDBOX_RUNNER_TOKEN: undefined })).toThrow(/SANDBOX_RUNNER_TOKEN/);
    try {
      loadSandboxRunnerConfig({ ...base, SANDBOX_RUNNER_TOKEN: 'short-secret-value' });
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain('short-secret-value');
    }
    expect(loadSandboxRunnerConfig({ ...base, SANDBOX_RUNNER_TOKEN: undefined, SANDBOX_RUNNER_TOKEN_FILE: '/run/secrets/t' }, { readFile: () => `${token}\n` }).token).toBe(token);
  });

  it('rejects unknown runtimes and relative socket paths', () => {
    expect(() => loadSandboxRunnerConfig({ ...base, SANDBOX_RUNTIME: 'kata' })).toThrow(/SANDBOX_RUNTIME/);
    expect(() => loadSandboxRunnerConfig({ ...base, DOCKER_SOCKET: 'docker.sock' })).toThrow(/DOCKER_SOCKET/);
    expect(() => loadSandboxRunnerConfig({ ...base, DOCKER_SOCKET: '/var/../etc/x' })).toThrow(/DOCKER_SOCKET/);
  });
});
