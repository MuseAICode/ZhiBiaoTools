// agent 沙箱工作区快照的取回与放入（路线图第 8 步 8.5b）在真实沙箱中的验证（CI 中在 gVisor 下运行）：
// - 往返：沙箱内的 GNU tar 打包 /workspace（中文文件名、超过 100 字节的名字、多层目录、空文件），driver 逐项校验后重新生成只含
//   普通文件、不带扩展头的归档；放入另一个新沙箱后，沙箱内看到的文件名（UTF-8 字节）与内容与原来的完全相同；
// - 取回的恶意样本：沙箱内的代码造出符号链接（指向 /etc/passwd 与工作区外）、硬链接、FIFO、隐藏文件、白名单外的扩展名、
//   非法 UTF-8 的文件名、零宽 / 双向控制字符、全角斜线、NFD 组合字符、大小写折叠后同名、超过层数：都被整体拒绝；
// - 放入的恶意样本：sandbox-runner 按模板的放入规则拒绝符号链接、穿越与中文路径的绕过，沙箱内不出现对应的文件。
// 数据库与对象存储一侧（保存、替换、放入前再次核对与校验）见 tests/db/agentWorkspaceSandbox.test.ts。
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readArchive, type SandboxFile } from '../../../src/sandbox/archive.ts';
import { SANDBOX_TEMPLATES } from '../../../src/sandbox/templates.ts';
import { END_OF_ARCHIVE, tarEntry } from '../tarFixtures.ts';
import { dockerRequest, sandboxEnv } from './env.ts';
import { createIsolationHarness } from './isolationSuite.ts';

const image = sandboxEnv.agentImage ?? '';
const suffix = randomUUID();
const gatewayName = `zhibiao-test-agent-gw-${suffix}`;
const gatewayHomeNetwork = `zhibiao-test-agent-gw-home-${suffix}`;

const harness = createIsolationHarness('agent', image, gatewayName);
const { driver, createSandbox, run } = harness;

/** 在沙箱内按 UTF-8 写出文件（名字与内容经 JSON / base64 传入，不经 shell 转义）。 */
async function writeFiles(ref: Parameters<typeof run>[0], files: ReadonlyArray<{ path: string; data: Buffer }>) {
  const payload = JSON.stringify(files.map((file) => [file.path, file.data.toString('base64')]));
  const script = `
    const fs = require('fs'), path = require('path');
    for (const [name, data] of ${payload}) {
      const target = path.join('/workspace', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(data, 'base64'));
    }`;
  const result = await run(ref, ['node', '-e', script]);
  expect(result.exitCode, result.stderr).toBe(0);
}

/** 沙箱内 /workspace 中的普通文件：名字（UTF-8 字节的十六进制，确认没有被改写）与内容的 SHA-256（exec 的输出只保留前 64 KiB）。 */
async function listFiles(ref: Parameters<typeof run>[0]): Promise<Array<[string, string]>> {
  const script = `
    const fs = require('fs'), crypto = require('crypto');
    const out = [];
    const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true, encoding: 'buffer' })) {
      const full = Buffer.concat([Buffer.from(dir + '/'), entry.name]);
      if (entry.isDirectory()) walk(full.toString());
      else out.push([full.subarray('/workspace/'.length).toString('hex'), entry.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') : 'not-a-file']);
    } };
    walk('/workspace');
    out.sort((a, b) => a[0] < b[0] ? -1 : 1);
    process.stdout.write(JSON.stringify(out));`;
  const result = await run(ref, ['node', '-e', script]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Array<[string, string]>;
}

async function capture(ref: Parameters<typeof run>[0]): Promise<{ archive: Buffer; fileCount: number }> {
  const output = await driver.copyOutArchive(ref);
  const chunks: Buffer[] = [];
  for await (const chunk of output.chunks) chunks.push(chunk);
  return { archive: Buffer.concat(chunks), fileCount: output.fileCount };
}

async function captureError(ref: Parameters<typeof run>[0]): Promise<unknown> {
  try {
    await capture(ref);
  } catch (error) {
    return error;
  }
  return null;
}

const WORKSPACE: SandboxFile[] = [
  { path: '任务/大纲.json', data: Buffer.from('{"章节":[1,2,3]}') },
  { path: '所选模板配置.json', data: Buffer.from('{}') },
  { path: `底稿/${'很长的中文目录名'.repeat(4)}/第一章（初稿）.md`, data: Buffer.from('# 第一章\n'.repeat(800)) },
  { path: 'images/图1.png', data: Buffer.alloc(40_000, 0x89) }, // 经 argv 传入，单个参数不能超过 128 KiB
  { path: 'pi-sessions/2026-11-14T10-00-00-000Z_0f8e.jsonl', data: Buffer.from('{"type":"session"}\n') },
  { path: 'empty.txt', data: Buffer.alloc(0) },
];

const sorted = (files: readonly SandboxFile[]) =>
  files
    .map((file): [string, string] => [Buffer.from(file.path).toString('hex'), createHash('sha256').update(file.data).digest('hex')])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

describe.runIf(sandboxEnv.agentImage)('agent 工作区快照（8.5b）', () => {
  beforeAll(async () => {
    expect((await dockerRequest('POST', '/networks/create', { Name: gatewayHomeNetwork, Internal: true })).status).toBe(201);
    const created = await dockerRequest('POST', `/containers/create?name=${gatewayName}`, {
      Image: image,
      Entrypoint: ['node'],
      Cmd: ['-e', `require('http').createServer((req, res) => res.end('gateway')).listen(8080, '0.0.0.0')`],
      User: '10001:10001',
      HostConfig: { NetworkMode: gatewayHomeNetwork, Runtime: 'runc', CapDrop: ['ALL'] },
    });
    expect(created.status).toBe(201);
    expect((await dockerRequest('POST', `/containers/${gatewayName}/start`)).status).toBe(204);
  });
  afterAll(async () => {
    await dockerRequest('DELETE', `/containers/${gatewayName}?force=true`);
    await dockerRequest('DELETE', `/networks/${gatewayHomeNetwork}`);
  });

  it('中文文件名的工作区经取回、重新生成与放入后在新沙箱中完全相同', async () => {
    const source = await createSandbox();
    await writeFiles(source, WORKSPACE);
    const { archive, fileCount } = await capture(source);
    expect(fileCount).toBe(WORKSPACE.length);
    // 重新生成的归档只含普通文件头（类型 0），没有目录与扩展头。
    for (let offset = 0; offset < archive.length - 1024; ) {
      expect(String.fromCharCode(archive[offset + 156]!)).toBe('0');
      const size = Number.parseInt(archive.subarray(offset + 124, offset + 135).toString('ascii'), 8);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(sorted(await readArchive(Readable.from([archive]), SANDBOX_TEMPLATES.agent.output))).toEqual(sorted(WORKSPACE));

    const target = await createSandbox();
    await driver.copyInArchive(target, archive);
    expect(await listFiles(target)).toEqual(sorted(WORKSPACE));
    // 放入的文件属于沙箱用户、不带 setuid 等位；Agent 可以继续修改。
    const stat = await run(target, ['sh', '-c', 'stat -c "%u %a" /workspace/所选模板配置.json && echo changed > /workspace/所选模板配置.json && cat /workspace/所选模板配置.json']);
    expect(stat.exitCode, stat.stderr).toBe(0);
    expect(stat.stdout).toBe('10001 600\nchanged\n');
  });

  it.each<[string, string]>([
    ['指向 /etc/passwd 的符号链接', 'ln -s /etc/passwd /workspace/passwd.md'],
    ['指向工作区外的符号链接目录', 'ln -s /tmp /workspace/tmpdir'],
    ['硬链接', 'echo x > /workspace/a.md && ln /workspace/a.md /workspace/b.md'],
    ['FIFO', 'mkfifo /workspace/pipe.md'],
    ['隐藏文件', 'echo x > /workspace/.profile.md'],
    ['白名单外的扩展名', 'echo x > /workspace/run.sh'],
    ['非法 UTF-8 的文件名', "printf x > \"$(printf '/workspace/\\377\\376.md')\""],
    ['零宽字符', "printf x > \"$(printf '/workspace/a\\342\\200\\213.md')\""],
    ['双向控制字符', "printf x > \"$(printf '/workspace/a\\342\\200\\256gpj.md')\""],
    ['全角斜线', "printf x > \"$(printf '/workspace/a\\357\\274\\217b.md')\""],
    ['NFD 组合字符', "printf x > \"$(printf '/workspace/e\\314\\201.md')\""],
    ['大小写折叠后同名', 'echo 1 > /workspace/A.md && echo 2 > /workspace/a.md'],
    ['超过层数', 'mkdir -p /workspace/1/2/3/4/5/6/7/8 && echo x > /workspace/1/2/3/4/5/6/7/8/x.md'],
  ])('取回时拒绝%s', async (_label, script) => {
    const ref = await createSandbox();
    await writeFiles(ref, WORKSPACE.slice(0, 2));
    const made = await run(ref, ['sh', '-c', script]);
    expect(made.exitCode, made.stderr).toBe(0);
    expect(await captureError(ref)).toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' });
    // 对照组：删掉恶意文件后同一沙箱可以取回。
    const cleaned = await run(ref, ['sh', '-c', 'cd /workspace && find . -mindepth 1 -maxdepth 1 ! -name 任务 ! -name 所选模板配置.json -exec rm -rf {} +']);
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);
    expect((await capture(ref)).fileCount).toBe(2);
  });

  it('放入时 sandbox-runner 按模板规则拒绝恶意归档，沙箱内不出现对应的文件', async () => {
    for (const bad of [
      tarEntry({ name: 'passwd.md', type: '2', linkname: '/etc/passwd' }),
      tarEntry({ name: '../../tmp/x.md', data: Buffer.from('x') }),
      tarEntry({ name: 'a／b.md', data: Buffer.from('x') }),
      tarEntry({ name: 'a‮.md', data: Buffer.from('x') }),
    ]) {
      const ref = await createSandbox();
      await expect(driver.copyInArchive(ref, Buffer.concat([tarEntry({ name: 'ok.md', data: Buffer.from('ok') }), bad, END_OF_ARCHIVE]))).rejects.toMatchObject({
        code: 'SANDBOX_BAD_REQUEST',
      });
      const listed = await run(ref, ['sh', '-c', 'find /workspace -mindepth 1 ! -name ok.md; test ! -e /tmp/x.md']).catch(() => null);
      // 沙箱可能已被终止（放入中途失败）；还在运行时，工作区中只可能有之前合规的 ok.md，/tmp 中没有穿越写出的文件。
      if (listed && listed.exitCode === 0) expect(listed.stdout).toBe('');
    }
  });
});
