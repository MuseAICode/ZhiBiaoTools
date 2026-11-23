import { describe, expect, it } from 'vitest';
import { ConfigError, loadSandboxRunnerConfig } from '../../src/config.ts';
import { buildContainerSpec, buildNetworkSpec, resolveCommand, SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';

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
    expect(resolveCommand(parse, 'parse', ['docx'])).toEqual({ argv: ['node', '/opt/parse/entry.mjs', 'docx'], timeoutMs: 600_000, maxInputBytes: 0 });
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

  it.each(['export-preview', 'export-document', 'export-feasibility'] as const)('%s reuses the isolation of the parse template', (name) => {
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

  it('export-feasibility (7.5b) has exactly the limits of export-document, only the entry mode differs', () => {
    const { name, commands, ...feasibility } = SANDBOX_TEMPLATES['export-feasibility'];
    const { name: documentName, commands: documentCommands, ...document } = SANDBOX_TEMPLATES['export-document'];
    expect([name, documentName]).toEqual(['export-feasibility', 'export-document']);
    expect(feasibility).toEqual(document);
    expect(Object.keys(commands)).toEqual(Object.keys(documentCommands));
    expect(commands.export!.timeoutMs).toBe(documentCommands.export!.timeoutMs);
    const image = 'zhibiao-export@sha256:' + 'c'.repeat(64);
    const options = { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) } as const;
    const { Labels: feasibilityLabels, ...feasibilitySpec } = buildContainerSpec(SANDBOX_TEMPLATES['export-feasibility'], options);
    const { Labels: documentLabels, ...documentSpec } = buildContainerSpec(SANDBOX_TEMPLATES['export-document'], options);
    expect(feasibilitySpec).toEqual(documentSpec);
    expect(feasibilityLabels).toMatchObject({ 'zhibiao.sandbox.template': 'export-feasibility' });
    expect(documentLabels).toMatchObject({ 'zhibiao.sandbox.template': 'export-document' });
  });

  it('only runs the export entry with the mode fixed by the template', () => {
    expect(resolveCommand(SANDBOX_TEMPLATES['export-preview'], 'export', [])).toEqual({ argv: ['node', '/opt/export/entry.mjs', 'preview'], timeoutMs: 60_000, maxInputBytes: 0 });
    expect(resolveCommand(SANDBOX_TEMPLATES['export-document'], 'export', [])).toEqual({ argv: ['node', '/opt/export/entry.mjs', 'document'], timeoutMs: 1_200_000, maxInputBytes: 0 });
    expect(resolveCommand(SANDBOX_TEMPLATES['export-feasibility'], 'export', [])).toEqual({ argv: ['node', '/opt/export/entry.mjs', 'feasibility'], timeoutMs: 1_200_000, maxInputBytes: 0 });
    expect(resolveCommand(SANDBOX_TEMPLATES['export-feasibility'], 'export', ['document'])).toBeNull();
    expect(resolveCommand(SANDBOX_TEMPLATES['export-preview'], 'export', ['document'])).toBeNull();
    expect(resolveCommand(SANDBOX_TEMPLATES['export-preview'], 'export', [''])).toBeNull();
    expect(resolveCommand(SANDBOX_TEMPLATES['export-preview'], 'parse', [])).toBeNull();
    expect(resolveCommand(parse, 'export', [])).toBeNull();
  });
});

describe('render-html template (8.8a1)', () => {
  const MIB = 1024 ** 2;
  const GIB = 1024 ** 3;
  const template = SANDBOX_TEMPLATES['render-html'];
  const image = 'zhibiao-export@sha256:' + 'c'.repeat(64);

  it('reuses the export image and the isolation of the parse template', () => {
    expect(template.image).toBe('export');
    expect(template.network).toBe('none');
    const host = buildContainerSpec(template, { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) }).HostConfig;
    const parseHost = buildContainerSpec(parse, { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) }).HostConfig;
    for (const key of ['NetworkMode', 'ReadonlyRootfs', 'Privileged', 'CapDrop', 'SecurityOpt', 'Init', 'IpcMode', 'Runtime', 'Binds', 'Mounts', 'Devices', 'Dns', 'ExtraHosts', 'LogConfig', 'RestartPolicy']) {
      expect(host[key], key).toEqual(parseHost[key]);
    }
    expect(Object.keys(host.Tmpfs as object).sort()).toEqual(['/output', '/tmp', '/work']);
    for (const options of Object.values(host.Tmpfs as Record<string, string>)) expect(options).toMatch(/^rw,noexec,nosuid,nodev,size=\d+,/);
    expect(host.MemorySwap).toBe(host.Memory);
  });

  it('applies the starting limits of the step 8 notes, item 3 (1 GiB memory, 1 CPU, 5 minutes per batch)', () => {
    expect(template.memoryBytes).toBe(1 * GIB);
    expect(template.nanoCpus).toBe(1e9);
    expect(template.commands.render!.timeoutMs).toBe(5 * 60_000);
    expect(template.lifetimeMs).toBeGreaterThan(template.commands.render!.timeoutMs + 2 * template.transferTimeoutMs);
  });

  it('accepts only request.json and the SVG / WebP images to convert (8.8a2), and returns only PNGs (at most 50, 10 MiB each) and result.json', () => {
    expect(template.input).toMatchObject({ directory: '/work', maxDepth: 1, maxFiles: 51 });
    expect([...template.input.extensions!].sort()).toEqual(['json', 'svg', 'webp']);
    // HTML 合计 16 MiB，JSON 转义后至多约 6 倍；图片合计 64 MiB。
    expect(template.input.maxFileBytes).toBeGreaterThanOrEqual(6 * 16 * MIB + 64 * 1024);
    expect(template.input.maxTotalBytes).toBeGreaterThanOrEqual(template.input.maxFileBytes + 64 * MIB);
    expect(template.tmpfs['/work']!.bytes).toBeGreaterThan(template.input.maxTotalBytes);
    expect(template.output).toMatchObject({ directory: '/output', maxDepth: 1, maxFiles: 51, maxFileBytes: 10 * MIB, maxTotalBytes: 256 * MIB });
    expect([...template.output.extensions!].sort()).toEqual(['json', 'png']);
    expect(template.tmpfs['/output']!.bytes).toBeGreaterThanOrEqual(template.output.maxTotalBytes);
  });

  it('only runs the render entry without arguments', () => {
    expect(resolveCommand(template, 'render', [])).toEqual({ argv: ['node', '/opt/export/render-html.mjs'], timeoutMs: 300_000, maxInputBytes: 0 });
    expect(resolveCommand(template, 'render', ['x'])).toBeNull();
    expect(resolveCommand(template, 'export', [])).toBeNull();
    expect(resolveCommand(SANDBOX_TEMPLATES['export-preview'], 'render', [])).toBeNull();
  });
});

describe('render-mermaid template (8.8b)', () => {
  const MIB = 1024 ** 2;
  const GIB = 1024 ** 3;
  const template = SANDBOX_TEMPLATES['render-mermaid'];
  const image = 'zhibiao-render-mermaid@sha256:' + 'c'.repeat(64);

  it('uses its own image, separate from render-html, export and agent, with the isolation of the parse template', () => {
    // 必须执行脚本（mermaid.js）：专用镜像，不与禁用 JavaScript 的 export 镜像（export-* 与 render-html）共用。
    expect(template.image).toBe('mermaid');
    for (const other of ['render-html', 'export-preview', 'export-document', 'export-feasibility', 'agent', 'agent-content', 'parse'] as const) {
      expect(SANDBOX_TEMPLATES[other].image, other).not.toBe('mermaid');
    }
    expect(template.network).toBe('none');
    const spec = buildContainerSpec(template, { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) });
    const host = spec.HostConfig;
    const parseHost = buildContainerSpec(parse, { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) }).HostConfig;
    for (const key of ['NetworkMode', 'ReadonlyRootfs', 'Privileged', 'CapDrop', 'SecurityOpt', 'Init', 'IpcMode', 'Runtime', 'Binds', 'Mounts', 'Devices', 'Dns', 'ExtraHosts', 'LogConfig', 'RestartPolicy']) {
      expect(host[key], key).toEqual(parseHost[key]);
    }
    expect(host.NetworkMode).toBe('none');
    expect(host.CapDrop).toEqual(['ALL']);
    expect(spec.User).toBe('10001:10001');
    expect(spec.Env).toEqual(['HOME=/tmp', 'LANG=C.UTF-8', 'TMPDIR=/tmp']);
    expect(Object.keys(host.Tmpfs as object).sort()).toEqual(['/output', '/tmp', '/work']);
    for (const options of Object.values(host.Tmpfs as Record<string, string>)) expect(options).toMatch(/^rw,noexec,nosuid,nodev,size=\d+,/);
    expect(host.MemorySwap).toBe(host.Memory);
  });

  it('applies the starting limits of the step 8 notes, item 3 (1 GiB memory, 1 CPU, 5 minutes per batch)', () => {
    expect(template.memoryBytes).toBe(1 * GIB);
    expect(template.nanoCpus).toBe(1e9);
    expect(template.pidsLimit).toBe(256);
    expect(template.commands.render!.timeoutMs).toBe(5 * 60_000);
    expect(template.lifetimeMs).toBeGreaterThan(template.commands.render!.timeoutMs + 2 * template.transferTimeoutMs);
  });

  it('accepts only request.json, and returns only PNGs (at most 50, 10 MiB each) and result.json, never the SVG', () => {
    expect(template.input).toMatchObject({ directory: '/work', maxDepth: 1, maxFiles: 1 });
    expect([...template.input.extensions!]).toEqual(['json']);
    // 源码合计 1 MiB，JSON 转义后至多约 6 倍。
    expect(template.input.maxFileBytes).toBeGreaterThanOrEqual(6 * MIB + 64 * 1024);
    expect(template.tmpfs['/work']!.bytes).toBeGreaterThan(template.input.maxTotalBytes);
    expect(template.output).toMatchObject({ directory: '/output', maxDepth: 1, maxFiles: 51, maxFileBytes: 10 * MIB, maxTotalBytes: 256 * MIB });
    expect([...template.output.extensions!].sort()).toEqual(['json', 'png']);
    expect(template.tmpfs['/output']!.bytes).toBeGreaterThanOrEqual(template.output.maxTotalBytes);
  });

  it('only runs the render entry without arguments', () => {
    expect(resolveCommand(template, 'render', [])).toEqual({ argv: ['node', '/opt/render-mermaid/entry.mjs'], timeoutMs: 300_000, maxInputBytes: 0 });
    expect(resolveCommand(template, 'render', ['x'])).toBeNull();
    expect(resolveCommand(template, 'export', [])).toBeNull();
    expect(resolveCommand(SANDBOX_TEMPLATES['render-html'], 'render', [])!.argv).not.toContain('/opt/render-mermaid/entry.mjs');
  });
});

describe('render-layout template (8.8c)', () => {
  const MIB = 1024 ** 2;
  const GIB = 1024 ** 3;
  const template = SANDBOX_TEMPLATES['render-layout'];
  const image = 'zhibiao-render-layout@sha256:' + 'b'.repeat(64);

  it('uses its own image, separate from every other template, with the isolation of the parse template', () => {
    // 必须执行脚本（docx-editor）：专用镜像，不与禁用 JavaScript 的 export 镜像或 render-mermaid 的镜像共用。
    expect(template.image).toBe('layout');
    for (const other of ['render-html', 'render-mermaid', 'export-preview', 'export-document', 'export-feasibility', 'agent', 'agent-content', 'parse'] as const) {
      expect(SANDBOX_TEMPLATES[other].image, other).not.toBe('layout');
    }
    expect(template.network).toBe('none');
    const spec = buildContainerSpec(template, { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) });
    const host = spec.HostConfig;
    const parseHost = buildContainerSpec(parse, { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) }).HostConfig;
    for (const key of ['NetworkMode', 'ReadonlyRootfs', 'Privileged', 'CapDrop', 'SecurityOpt', 'Init', 'IpcMode', 'Runtime', 'Binds', 'Mounts', 'Devices', 'Dns', 'ExtraHosts', 'LogConfig', 'RestartPolicy']) {
      expect(host[key], key).toEqual(parseHost[key]);
    }
    expect(host.NetworkMode).toBe('none');
    expect(host.CapDrop).toEqual(['ALL']);
    expect(spec.User).toBe('10001:10001');
    expect(spec.Env).toEqual(['HOME=/tmp', 'LANG=C.UTF-8', 'TMPDIR=/tmp']);
    expect(Object.keys(host.Tmpfs as object).sort()).toEqual(['/output', '/tmp', '/work']);
    for (const options of Object.values(host.Tmpfs as Record<string, string>)) expect(options).toMatch(/^rw,noexec,nosuid,nodev,size=\d+,/);
    expect(host.MemorySwap).toBe(host.Memory);
  });

  it('applies the starting limits of the step 8 notes, item 3 (2 GiB memory, 1 CPU, 3 minutes)', () => {
    expect(template.memoryBytes).toBe(2 * GIB);
    expect(template.nanoCpus).toBe(1e9);
    expect(template.pidsLimit).toBe(256);
    expect(template.commands.measure!.timeoutMs).toBe(3 * 60_000);
    expect(template.lifetimeMs).toBeGreaterThan(template.commands.measure!.timeoutMs + 2 * template.transferTimeoutMs);
  });

  it('accepts only one docx of at most 100 MiB, and returns only one layout JSON of at most 16 MiB', () => {
    expect(template.input).toMatchObject({ directory: '/work', maxDepth: 1, maxFiles: 1, maxFileBytes: 100 * MIB, maxTotalBytes: 100 * MIB });
    expect([...template.input.extensions!]).toEqual(['docx']);
    expect(template.tmpfs['/work']!.bytes).toBeGreaterThan(template.input.maxTotalBytes);
    expect(template.output).toMatchObject({ directory: '/output', maxDepth: 1, maxFiles: 1, maxFileBytes: 16 * MIB, maxTotalBytes: 16 * MIB });
    expect([...template.output.extensions!]).toEqual(['json']);
    expect(template.tmpfs['/output']!.bytes).toBeGreaterThanOrEqual(template.output.maxTotalBytes);
    // /work 与 /output 计入内存上限，留给浏览器的至少 1.5 GiB。
    expect(template.memoryBytes - template.tmpfs['/work']!.bytes - template.tmpfs['/output']!.bytes).toBeGreaterThan(1.5 * GIB);
  });

  it('only runs the measure entry without arguments', () => {
    expect(resolveCommand(template, 'measure', [])).toEqual({ argv: ['node', '/opt/render-layout/entry.mjs'], timeoutMs: 180_000, maxInputBytes: 0 });
    expect(resolveCommand(template, 'measure', ['x'])).toBeNull();
    expect(resolveCommand(template, 'render', [])).toBeNull();
  });
});

describe('agent templates (8.1)', () => {
  const MIB = 1024 ** 2;
  const GIB = 1024 ** 3;
  const image = 'zhibiao-agent@sha256:' + 'e'.repeat(64);
  const network = { name: `zhibiao-sandbox-${JOB_ID}`, gatewayAddress: '172.18.0.1' };
  const parseHost = buildContainerSpec(parse, { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) }).HostConfig;

  it.each(['agent', 'agent-content'] as const)('%s reuses the isolation of the parse template, except for its dedicated network', (name) => {
    const template = SANDBOX_TEMPLATES[name];
    expect(template.image).toBe('agent');
    expect(template.network).toBe('agent');
    const spec = buildContainerSpec(template, { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000), network });
    const host = spec.HostConfig;
    for (const key of ['ReadonlyRootfs', 'Privileged', 'CapDrop', 'SecurityOpt', 'Init', 'IpcMode', 'Runtime', 'Binds', 'Mounts', 'Devices', 'Dns', 'LogConfig', 'RestartPolicy']) {
      expect(host[key], key).toEqual(parseHost[key]);
    }
    // 网络：只接入自己的专用网络，agent-gw 的地址写在 /etc/hosts，不配置 DNS。
    expect(host.NetworkMode).toBe(network.name);
    expect(spec.NetworkingConfig).toEqual({ EndpointsConfig: { [network.name]: {} } });
    expect(host.ExtraHosts).toEqual(['agent-gw:172.18.0.1']);
    expect(host.Dns).toEqual([]);
    expect(spec.User).toBe('10001:10001');
    expect(spec.Env).toEqual(['HOME=/tmp', 'LANG=C.UTF-8', 'TMPDIR=/tmp']);
    expect(spec.Labels).toMatchObject({ 'zhibiao.sandbox.template': name });
    // 决定事项第 3 项的起步值：CPU 1 核、内存 2 GiB（无 swap）、pids 256、/workspace 1 GiB、/tmp 256 MiB。
    expect(host.Memory).toBe(2 * GIB);
    expect(host.MemorySwap).toBe(host.Memory);
    expect(host.NanoCpus).toBe(1e9);
    expect(host.PidsLimit).toBe(256);
    expect(host.Tmpfs).toEqual({
      '/tmp': `rw,noexec,nosuid,nodev,size=${256 * MIB},mode=1777`,
      '/workspace': `rw,noexec,nosuid,nodev,size=${1 * GIB},uid=10001,gid=10001,mode=0700`,
    });
    // 工作区的取回规则（决定事项第 13 项）：文件数 ≤ 10,000、合计 ≤ 512 MiB、扩展名白名单。
    expect(template.output).toMatchObject({ directory: '/workspace', maxFiles: 10_000, maxTotalBytes: 512 * MIB });
    expect(template.output.extensions!.has('html')).toBe(true);
    for (const extension of ['sh', 'js', 'mjs', 'exe', 'so', 'docx', '']) expect(template.output.extensions!.has(extension), extension).toBe(false);
    expect(template.input).toMatchObject({ directory: '/workspace', maxFiles: 10_000, maxTotalBytes: 512 * MIB, extensions: null });
    // 8.6a：只有入口命令 run，不接受参数，请求（含任务令牌）经标准输入传入，至多 1 MiB；命令墙钟即任务墙钟。
    expect(Object.keys(template.commands)).toEqual(['run']);
    const wallClock = name === 'agent' ? 30 * 60_000 : 120 * 60_000;
    expect(resolveCommand(template, 'run', [])).toEqual({ argv: ['/usr/local/bin/node', '/opt/agent/entry.mjs'], timeoutMs: wallClock, maxInputBytes: MIB });
    expect(template.lifetimeMs).toBeGreaterThanOrEqual(wallClock + 2 * template.transferTimeoutMs);
    for (const args of [[''], ['--eval=process.exit()'], ['/workspace/x.mjs'], ['agt_' + 'a'.repeat(43)]]) expect(resolveCommand(template, 'run', args), args[0]).toBeNull();
    expect(resolveCommand(template, 'sh', ['-c', 'id'])).toBeNull();
    expect(resolveCommand(template, 'toString', [])).toBeNull();
  });

  it('only the agent entry accepts a request on standard input', () => {
    for (const template of Object.values(SANDBOX_TEMPLATES)) {
      for (const [name, command] of Object.entries(template.commands)) {
        expect(command.maxInputBytes ?? 0, `${template.name}:${name}`).toBe(template.image === 'agent' ? MIB : 0);
      }
    }
  });

  it('agent-content differs from agent only in its lifetime and entry wall clock (task wall clock 2 hours instead of 30 minutes)', () => {
    const { name, lifetimeMs, commands, ...content } = SANDBOX_TEMPLATES['agent-content'];
    const { name: agentName, lifetimeMs: agentLifetime, commands: agentCommands, ...agent } = SANDBOX_TEMPLATES.agent;
    expect([name, agentName]).toEqual(['agent-content', 'agent']);
    expect(content).toEqual(agent);
    expect({ ...commands.run, timeoutMs: 0 }).toEqual({ ...agentCommands.run, timeoutMs: 0 });
    expect(agentLifetime).toBeGreaterThanOrEqual(30 * 60_000 + 2 * agent.transferTimeoutMs);
    expect(lifetimeMs).toBeGreaterThanOrEqual(120 * 60_000 + 2 * agent.transferTimeoutMs);
  });

  it('requires a dedicated network exactly for the agent templates', () => {
    const options = { image, runtime: 'runsc', jobId: JOB_ID, expiresAt: new Date(1_000) };
    expect(() => buildContainerSpec(SANDBOX_TEMPLATES.agent, options)).toThrow();
    expect(() => buildContainerSpec(parse, { ...options, network })).toThrow();
    expect(() => buildContainerSpec(SANDBOX_TEMPLATES.agent, { ...options, network: { name: 'bridge', gatewayAddress: '172.18.0.1' } })).toThrow();
    expect(() => buildContainerSpec(SANDBOX_TEMPLATES.agent, { ...options, network: { name: 'host', gatewayAddress: '172.18.0.1' } })).toThrow();
    expect(() => buildContainerSpec(SANDBOX_TEMPLATES.agent, { ...options, network: { ...network, gatewayAddress: '172.18.0.1 evil' } })).toThrow();
    expect(() => buildContainerSpec(SANDBOX_TEMPLATES.agent, { ...options, network: { ...network, gatewayAddress: '1.2.3.4\nx:5.6.7.8' } })).toThrow();
  });

  it('builds an internal network without a host address on the bridge', () => {
    const spec = buildNetworkSpec(network.name, { template: 'agent', jobId: JOB_ID, expiresAt: new Date(1_000) });
    expect(spec).toEqual({
      Name: network.name,
      Driver: 'bridge',
      Internal: true,
      Attachable: false,
      EnableIPv6: false,
      Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true', 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
      Labels: { 'zhibiao.sandbox': '1', 'zhibiao.sandbox.template': 'agent', 'zhibiao.sandbox.job': JOB_ID, 'zhibiao.sandbox.expires': '1000' },
    });
    expect(() => buildNetworkSpec('bridge', { template: 'agent', jobId: JOB_ID, expiresAt: new Date(1_000) })).toThrow();
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
    expect(loadSandboxRunnerConfig(base).images).toEqual({ parse: 'zhibiao-parse:dev', export: 'zhibiao-export:dev', agent: null, mermaid: null, layout: null });
    expect(() => loadSandboxRunnerConfig({ ...base, SANDBOX_EXPORT_IMAGE: undefined })).toThrow(/SANDBOX_EXPORT_IMAGE/);
    expect(() => loadSandboxRunnerConfig({ ...base, SANDBOX_EXPORT_IMAGE: '' })).toThrow(/SANDBOX_EXPORT_IMAGE/);
    const production = { ...base, NODE_ENV: 'production', SANDBOX_RUNTIME: 'runsc', SANDBOX_PARSE_IMAGE: pinned };
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_EXPORT_IMAGE: 'zhibiao-export:latest' })).toThrow(/SANDBOX_EXPORT_IMAGE/);
    expect(loadSandboxRunnerConfig({ ...production, SANDBOX_EXPORT_IMAGE: exportPinned }).images.export).toBe(exportPinned);
  });

  it('makes the agent image and gateway optional until agent tasks ship (8.1), and pins the image in production', () => {
    expect(loadSandboxRunnerConfig(base).agentGateway).toBeNull();
    const configured = loadSandboxRunnerConfig({ ...base, SANDBOX_AGENT_IMAGE: 'zhibiao-agent:dev', SANDBOX_AGENT_GATEWAY: 'zhibiao-agent-gw-1' });
    expect(configured.images.agent).toBe('zhibiao-agent:dev');
    expect(configured.agentGateway).toBe('zhibiao-agent-gw-1');
    expect(() => loadSandboxRunnerConfig({ ...base, SANDBOX_AGENT_GATEWAY: '../x' })).toThrow(/SANDBOX_AGENT_GATEWAY/);
    expect(() => loadSandboxRunnerConfig({ ...base, SANDBOX_AGENT_GATEWAY: 'a b' })).toThrow(/SANDBOX_AGENT_GATEWAY/);
    const production = { ...base, NODE_ENV: 'production', SANDBOX_RUNTIME: 'runsc', SANDBOX_PARSE_IMAGE: pinned, SANDBOX_EXPORT_IMAGE: exportPinned };
    expect(loadSandboxRunnerConfig(production).images.agent).toBeNull();
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_AGENT_IMAGE: 'zhibiao-agent:latest' })).toThrow(/SANDBOX_AGENT_IMAGE/);
    const agentPinned = `registry.example.com/zhibiao-agent@sha256:${'f'.repeat(64)}`;
    expect(loadSandboxRunnerConfig({ ...production, SANDBOX_AGENT_IMAGE: agentPinned }).images.agent).toBe(agentPinned);
  });

  it('makes the render-mermaid image optional until content generation uses it (8.8b), and pins it in production', () => {
    expect(loadSandboxRunnerConfig({ ...base, SANDBOX_MERMAID_IMAGE: 'zhibiao-render-mermaid:dev' }).images.mermaid).toBe('zhibiao-render-mermaid:dev');
    const production = { ...base, NODE_ENV: 'production', SANDBOX_RUNTIME: 'runsc', SANDBOX_PARSE_IMAGE: pinned, SANDBOX_EXPORT_IMAGE: exportPinned };
    expect(loadSandboxRunnerConfig(production).images.mermaid).toBeNull();
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_MERMAID_IMAGE: 'zhibiao-render-mermaid:latest' })).toThrow(/SANDBOX_MERMAID_IMAGE/);
    const mermaidPinned = `registry.example.com/zhibiao-render-mermaid@sha256:${'9'.repeat(64)}`;
    expect(loadSandboxRunnerConfig({ ...production, SANDBOX_MERMAID_IMAGE: mermaidPinned }).images.mermaid).toBe(mermaidPinned);
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_RUNTIME: 'runc', SANDBOX_MERMAID_IMAGE: mermaidPinned })).toThrow(/SANDBOX_RUNTIME/);
  });

  it('makes the render-layout image optional until content generation uses it (8.8c), and pins it in production', () => {
    expect(loadSandboxRunnerConfig({ ...base, SANDBOX_LAYOUT_IMAGE: 'zhibiao-render-layout:dev' }).images.layout).toBe('zhibiao-render-layout:dev');
    const production = { ...base, NODE_ENV: 'production', SANDBOX_RUNTIME: 'runsc', SANDBOX_PARSE_IMAGE: pinned, SANDBOX_EXPORT_IMAGE: exportPinned };
    expect(loadSandboxRunnerConfig(production).images.layout).toBeNull();
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_LAYOUT_IMAGE: 'zhibiao-render-layout:latest' })).toThrow(/SANDBOX_LAYOUT_IMAGE/);
    const layoutPinned = `registry.example.com/zhibiao-render-layout@sha256:${'8'.repeat(64)}`;
    expect(loadSandboxRunnerConfig({ ...production, SANDBOX_LAYOUT_IMAGE: layoutPinned }).images.layout).toBe(layoutPinned);
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_RUNTIME: 'runc', SANDBOX_LAYOUT_IMAGE: layoutPinned })).toThrow(/SANDBOX_RUNTIME/);
  });

  it('rejects runc in production also when the agent image and gateway are configured (8.1)', () => {
    // 运行时是 sandbox-runner 全局的配置，对所有模板（含 agent / agent-content）生效，模板中没有可覆盖运行时的字段。
    const agentPinned = `registry.example.com/zhibiao-agent@sha256:${'f'.repeat(64)}`;
    const production = { ...base, NODE_ENV: 'production', SANDBOX_PARSE_IMAGE: pinned, SANDBOX_EXPORT_IMAGE: exportPinned, SANDBOX_AGENT_IMAGE: agentPinned, SANDBOX_AGENT_GATEWAY: 'zhibiao-agent-gw-1' };
    expect(() => loadSandboxRunnerConfig({ ...production, SANDBOX_RUNTIME: 'runc' })).toThrow(/SANDBOX_RUNTIME/);
    expect(() => loadSandboxRunnerConfig(production)).toThrow(/SANDBOX_RUNTIME/);
    expect(loadSandboxRunnerConfig({ ...production, SANDBOX_RUNTIME: 'runsc' }).runtime).toBe('runsc');
    for (const name of ['agent', 'agent-content'] as const) expect(Object.keys(SANDBOX_TEMPLATES[name]).some((key) => /runtime/i.test(key))).toBe(false);
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
