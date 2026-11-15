// agent 沙箱入口（路线图第 8 步 8.6a）在真实沙箱中的验证（CI 中在 gVisor 下运行）：
// - 模板的 run 命令执行镜像中的 /opt/agent/entry.mjs，请求经标准输入传入，经 /etc/hosts 中的 agent-gw 确认令牌；
//   agent-gw 这里是一个桩容器（只认一个令牌，与 agentIsolation.test.ts 的桩相同不是沙箱），真实的 agent-gw 与 worker 入口
//   按令牌查身份见 tests/db/agentEndpoint.test.ts；
// - 令牌只在标准输入中：入口运行期间，沙箱内的其他进程在 /proc 中（各进程的环境与参数）、exec 的参数（Docker 记录的
//   ProcessConfig）、容器的环境、/workspace 与 /tmp 中都找不到它；
// - 不合法的调用：没有请求（BAD_REQUEST）、请求超过上限与带参数（sandbox-runner 拒绝，不执行）、令牌无效（TOKEN_INVALID）、
//   agent-gw 不可用（GATEWAY_UNAVAILABLE）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentEntry } from '../../../src/agent/entry.ts';
import { generateAgentToken } from '../../../src/agent/token.ts';
import { AGENT_ENTRY_COMMAND, AGENT_ENTRY_MAX_INPUT_BYTES } from '../../../src/sandbox/templates.ts';
import { dockerRequest, sandboxEnv } from './env.ts';
import { createIsolationHarness } from './isolationSuite.ts';

const image = sandboxEnv.agentImage ?? '';
const suffix = randomUUID();
const gatewayName = `zhibiao-test-agent-gw-${suffix}`;
const gatewayHomeNetwork = `zhibiao-test-agent-gw-home-${suffix}`;
const TOKEN = generateAgentToken();
/** 桩收到这个令牌时等 SLOW_MS 再回答：入口在此期间一直运行，供同一沙箱内的探测查找令牌。 */
const SLOW_TOKEN = generateAgentToken();
const SLOW_MS = 6_000;
const EXPIRES = '2026-11-15T12:30:00.000Z';

const harness = createIsolationHarness('agent', image, gatewayName);
const { driver, createSandbox, run } = harness;

/** agent-gw 的桩：GET /v1/session 只认 TOKEN 与 SLOW_TOKEN（Bearer），其余 401；记录收到的 Authorization。 */
const GATEWAY_STUB = `
  const http = require('http');
  const seen = [];
  http.createServer((req, res) => {
    if (req.url === '/seen') return res.end(JSON.stringify(seen));
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const answer = () => {
      if (req.method !== 'GET' || req.url !== '/v1/session' || (token !== process.env.TOKEN && token !== process.env.SLOW_TOKEN)) {
        res.statusCode = 401;
        return res.end('{"error":{"code":"AGENT_TOKEN_INVALID"}}');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'active', expiresAt: '${EXPIRES}' }));
    };
    if (token === process.env.SLOW_TOKEN) setTimeout(answer, ${SLOW_MS}); else answer();
  }).listen(8080, '0.0.0.0');`;

async function gatewaySeen(ref: Parameters<typeof run>[0]): Promise<Array<{ method: string; url: string; authorization: string | null }>> {
  const result = await run(ref, ['node', '-e', `require('http').get('http://agent-gw:8080/seen', (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => process.stdout.write(b)); })`]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe.runIf(sandboxEnv.agentImage)('agent 入口（8.6a）', () => {
  beforeAll(async () => {
    expect((await dockerRequest('POST', '/networks/create', { Name: gatewayHomeNetwork, Internal: true })).status).toBe(201);
    const created = await dockerRequest('POST', `/containers/create?name=${gatewayName}`, {
      Image: image,
      Entrypoint: ['node'],
      Cmd: ['-e', GATEWAY_STUB],
      Env: [`TOKEN=${TOKEN}`, `SLOW_TOKEN=${SLOW_TOKEN}`],
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

  it('经标准输入收到请求，经 /etc/hosts 中的 agent-gw 确认令牌', async () => {
    const ref = await createSandbox();
    expect(await runAgentEntry(driver, ref, { action: 'session', token: TOKEN })).toEqual({ ok: true, action: 'session', expiresAt: new Date(EXPIRES) });
    // 令牌不对：入口按协议报告 TOKEN_INVALID（退出码 1），不带出 agent-gw 的响应正文。
    expect(await runAgentEntry(driver, ref, { action: 'session', token: generateAgentToken() })).toEqual({ ok: false, code: 'TOKEN_INVALID' });
    const seen = await gatewaySeen(ref);
    expect(seen.map((item) => [item.method, item.url])).toEqual([['GET', '/v1/session'], ['GET', '/v1/session']]);
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('没有请求时报告 BAD_REQUEST；请求超过上限、带参数时 sandbox-runner 拒绝，不执行', async () => {
    const ref = await createSandbox();
    const empty = await driver.exec(ref, AGENT_ENTRY_COMMAND, []);
    expect(empty.exitCode).toBe(1);
    expect(JSON.parse(empty.stdout)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    await expect(driver.exec(ref, AGENT_ENTRY_COMMAND, [], { input: Buffer.alloc(AGENT_ENTRY_MAX_INPUT_BYTES + 1, 0x20) })).rejects.toMatchObject({ code: 'SANDBOX_BAD_REQUEST' });
    await expect(driver.exec(ref, AGENT_ENTRY_COMMAND, ['--eval=1'], { input: Buffer.from('{}') })).rejects.toMatchObject({ code: 'SANDBOX_BAD_REQUEST' });
    // 上限处的请求照常交给入口（空白填充的合法 JSON）。
    const request = Buffer.from(JSON.stringify({ version: 1, action: 'session', token: TOKEN }));
    const padded = Buffer.concat([request.subarray(0, -1), Buffer.alloc(AGENT_ENTRY_MAX_INPUT_BYTES - request.length, 0x20), Buffer.from('}')]);
    const atLimit = await driver.exec(ref, AGENT_ENTRY_COMMAND, [], { input: padded });
    expect(atLimit.exitCode, atLimit.stderr).toBe(0);
    expect(JSON.parse(atLimit.stdout)).toMatchObject({ ok: true, action: 'session' });
  });

  it('入口运行期间，令牌不在沙箱内任何进程的环境与参数中，也不在 exec 的参数、容器环境与可写目录中', async () => {
    const ref = await createSandbox();
    const entry = runAgentEntry(driver, ref, { action: 'session', token: SLOW_TOKEN });
    // 探测脚本拿到的只是令牌的两半（自己的参数中也就没有完整的令牌），且跳过自己。
    const half = Math.floor(SLOW_TOKEN.length / 2);
    const probeScript = `
      const fs = require('fs');
      const token = ${JSON.stringify(SLOW_TOKEN.slice(0, half))} + ${JSON.stringify(SLOW_TOKEN.slice(half))};
      const found = [], processes = [];
      for (const pid of fs.readdirSync('/proc').filter((name) => /^\\d+$/.test(name) && Number(name) !== process.pid)) {
        let cmdline = '';
        try { cmdline = fs.readFileSync('/proc/' + pid + '/cmdline', 'latin1'); } catch {}
        processes.push(cmdline.split('\\0').join(' ').trim());
        for (const file of ['environ', 'cmdline']) {
          try { if (fs.readFileSync('/proc/' + pid + '/' + file, 'latin1').includes(token)) found.push(pid + '/' + file); } catch {}
        }
      }
      const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = dir + '/' + entry.name;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && fs.readFileSync(full, 'latin1').includes(token)) found.push(full);
      } };
      walk('/workspace'); walk('/tmp');
      process.stdout.write(JSON.stringify({ found, processes }));`;
    // 等入口启动并在等 agent-gw 的回答。
    let probe: { found: string[]; processes: string[] } = { found: [], processes: [] };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await run(ref, ['node', '-e', probeScript]);
      expect(result.exitCode, result.stderr).toBe(0);
      probe = JSON.parse(result.stdout);
      if (probe.processes.some((cmdline) => cmdline.includes('/opt/agent/entry.mjs'))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(probe.processes.filter((cmdline) => cmdline.includes('/opt/agent/entry.mjs'))).toEqual(['/usr/local/bin/node /opt/agent/entry.mjs']);
    expect(probe.found).toEqual([]);
    // Docker 记录的 exec 参数与容器的环境中也没有令牌。
    const { json } = await dockerRequest('GET', `/containers/zhibiao-sandbox-${ref.id}/json`);
    const container = json as { ExecIDs: string[] | null; Config: { Env: string[] } };
    expect(JSON.stringify(container.Config.Env)).not.toContain(SLOW_TOKEN);
    const execs = await Promise.all((container.ExecIDs ?? []).map(async (id) => (await dockerRequest('GET', `/exec/${id}/json`)).json as { ProcessConfig: { entrypoint: string; arguments: string[] } }));
    expect(execs.some((exec) => exec.ProcessConfig.arguments.includes('/opt/agent/entry.mjs'))).toBe(true);
    for (const exec of execs) expect(JSON.stringify(exec.ProcessConfig)).not.toContain(SLOW_TOKEN);
    expect(await entry).toEqual({ ok: true, action: 'session', expiresAt: new Date(EXPIRES) });
  });

  // 放在最后：停止桩之后本文件的其他用例无法再访问 agent-gw。
  it('agent-gw 不可用时报告 GATEWAY_UNAVAILABLE', async () => {
    const ref = await createSandbox();
    expect((await dockerRequest('POST', `/containers/${gatewayName}/kill`)).status).toBe(204);
    expect(await runAgentEntry(driver, ref, { action: 'session', token: TOKEN })).toEqual({ ok: false, code: 'GATEWAY_UNAVAILABLE' });
  });
});
