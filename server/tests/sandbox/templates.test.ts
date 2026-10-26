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

describe('loadSandboxRunnerConfig', () => {
  const token = 't'.repeat(40);
  const base = { NODE_ENV: 'development', SANDBOX_PARSE_IMAGE: 'zhibiao-parse:dev', SANDBOX_RUNNER_TOKEN: token };
  const pinned = `registry.example.com/zhibiao-parse@sha256:${'b'.repeat(64)}`;

  it('defaults to runc in development and listens on 3100', () => {
    const config = loadSandboxRunnerConfig(base);
    expect(config.runtime).toBe('runc');
    expect(config.port).toBe(3100);
    expect(config.dockerSocket).toBe('/var/run/docker.sock');
    expect(config.maxActive).toBe(8);
  });

  it('only allows gVisor and digest-pinned images in production', () => {
    const production = { ...base, NODE_ENV: 'production', SANDBOX_PARSE_IMAGE: pinned };
    expect(loadSandboxRunnerConfig({ ...production, SANDBOX_RUNTIME: 'runsc' }).runtime).toBe('runsc');
    expect(() => loadSandboxRunnerConfig(production)).toThrow(ConfigError);
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_RUNTIME: 'runc' })).toThrow(/SANDBOX_RUNTIME/);
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_RUNTIME: 'runsc', SANDBOX_PARSE_IMAGE: 'zhibiao-parse:latest' })).toThrow(/SANDBOX_PARSE_IMAGE/);
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
