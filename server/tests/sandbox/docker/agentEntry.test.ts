// agent 沙箱入口（路线图第 8 步 8.6a、8.6b）在真实沙箱中的验证（CI 中在 gVisor 下运行）：
// - 模板的 run 命令执行镜像中的 /opt/agent/entry.mjs，请求经标准输入传入，经 /etc/hosts 中的 agent-gw 确认令牌；
//   agent-gw 这里是一个桩容器（只认一个令牌，与 agentIsolation.test.ts 的桩相同不是沙箱），真实的 agent-gw 与 worker 入口
//   按令牌查身份见 tests/db/agentEndpoint.test.ts；
// - 令牌只在标准输入中：入口运行期间，沙箱内的其他进程在 /proc 中（各进程的环境与参数）、exec 的参数（Docker 记录的
//   ProcessConfig）、容器的环境、/workspace 与 /tmp 中都找不到它；
// - 不合法的调用：没有请求（BAD_REQUEST）、请求超过上限与带参数（sandbox-runner 拒绝，不执行）、令牌无效（TOKEN_INVALID）、
//   agent-gw 不可用（GATEWAY_UNAVAILABLE）；
// - prompt（8.6b）：镜像中的 Pi 运行时经 agent-gw 的 POST /v1/chat/completions 调用模型（桩按脚本回答：先让 Agent 执行一条 bash
//   命令，再结束），令牌只在 Authorization 中；Agent 执行的命令中，沙箱内所有进程的环境与参数里都没有令牌，命令的环境固定；
//   会话文件在 /workspace/pi-sessions/ 中、可续接，工作区（结果文件与会话文件）按 agent 模板的规则取回。
//   真实的模型调用路由（schema、字段转换）见 tests/agent/piSession.test.ts；
// - 业务工具的桩（8.6c1）：镜像中的 tools.mjs 为请求中的 ask-user 登记桩，经 agent-gw 的 POST /v1/tools/call 调用（令牌只在
//   Authorization 中），回答交给模型。真实的工具路由见 tests/agent/piBusinessTools.test.ts，阶段限制与绕过入口直接调用见
//   tests/db/agentToolScopes.test.ts。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_SESSION_FILE_PATTERN, type AgentPromptRequest, runAgentEntry } from '../../../src/agent/entry.ts';
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

/** 桩让 Agent 执行的 bash 命令：/tmp/probe.cjs 拿到令牌的两半（命令自己的参数中没有完整的令牌）。 */
const PROBE_COMMAND = `node /tmp/probe.cjs ${TOKEN.slice(0, 20)} ${TOKEN.slice(20)} && printf ok > /workspace/结果.txt`;
/** 在沙箱中找令牌：其他进程的环境与参数（跳过自己）；并给出自己的环境变量名（即 bash 命令的环境）。 */
const PROBE_SCRIPT = `
  const fs = require('fs');
  const token = process.argv[2] + process.argv[3];
  const found = [], processes = [];
  for (const pid of fs.readdirSync('/proc').filter((name) => /^\\d+$/.test(name) && Number(name) !== process.pid)) {
    let cmdline = '';
    try { cmdline = fs.readFileSync('/proc/' + pid + '/cmdline', 'latin1'); } catch {}
    processes.push(cmdline.split('\\0').join(' ').trim());
    for (const file of ['environ', 'cmdline']) {
      try { if (fs.readFileSync('/proc/' + pid + '/' + file, 'latin1').includes(token)) found.push(pid + '/' + file); } catch {}
    }
  }
  // 纵深防御评估（#90 登记）的测量，只记录、不断言：Agent 的命令能否读取入口（Pi）进程的内存并从中找到令牌。
  const memory = {};
  const entryPid = fs.readdirSync('/proc').find((name) => /^\\d+$/.test(name) && (() => { try { return fs.readFileSync('/proc/' + name + '/cmdline', 'latin1').includes('/opt/agent/entry.mjs'); } catch { return false; } })());
  let maps = '';
  try { maps = fs.readFileSync('/proc/' + entryPid + '/maps', 'utf8'); memory.maps = 'readable'; } catch (error) { memory.maps = error.code || 'error'; }
  let fd;
  try { fd = fs.openSync('/proc/' + entryPid + '/mem', 'r'); memory.mem = 'opened'; } catch (error) { memory.mem = error.code || 'error'; }
  memory.tokenFound = false;
  if (fd !== undefined) {
    const needle = Buffer.from(token);
    for (const line of maps.split('\\n')) {
      const match = /^([0-9a-f]+)-([0-9a-f]+) rw/.exec(line);
      if (!match || memory.tokenFound) continue;
      for (let at = BigInt('0x' + match[1]), end = BigInt('0x' + match[2]); at < end && !memory.tokenFound; at += 1048576n) {
        const length = Number(end - at < 1048576n ? end - at : 1048576n);
        const buffer = Buffer.alloc(length);
        try { fs.readSync(fd, buffer, 0, length, at); } catch (error) { memory.readError = error.code || 'error'; continue; }
        if (buffer.includes(needle)) memory.tokenFound = true;
      }
    }
  }
  process.stdout.write(JSON.stringify({ found, processes, env: Object.keys(process.env).sort(), memory }));`;

/** 桩让 Agent 调用 ask-user 时的参数与回答（8.6c1）。 */
const ASK_USER_ARGUMENTS = { question: '按哪种方式组织目录？', options: [{ label: '按评分项', custom: false }, { label: '按章节', custom: false }] };
const ASK_USER_ANSWER = { answered: true, answer: '按评分项', selected_option: '按评分项', is_custom: false };

/**
 * agent-gw 的桩：GET /v1/session 只认 TOKEN 与 SLOW_TOKEN（Bearer），其余 401；记录收到的 Authorization。
 * POST /v1/chat/completions（只认 TOKEN）：最后一条消息是用户的提示词时回答一次 bash 工具调用（PROBE_COMMAND），否则回答“完成”；
 * 用户的提示词含“调用业务工具”时改为回答一次 ask-user 工具调用（8.6c1）；含“校验 JSON”时回答两次 json-validation 工具调用（8.6c2a：
 * 一次用预置的 Schema、一次用模型给出的 schema）。
 * POST /v1/tools/call（只认 TOKEN）：回答 ask-user 已被回答，记录请求体。
 * 记录每个请求的 Authorization、请求体中是否出现令牌、消息条数与 tool 消息的内容。
 */
const GATEWAY_STUB = `
  const http = require('http');
  const seen = [];
  const sse = (res, delta, finish) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (d, f) => res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: d, finish_reason: f }] }) + '\\n\\n');
    chunk(Object.assign({ role: 'assistant' }, delta), null);
    chunk({}, finish);
    res.end('data: [DONE]\\n\\n');
  };
  http.createServer((req, res) => {
    if (req.url === '/seen') return res.end(JSON.stringify(seen));
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => handle(req, res, raw));
  }).listen(8080, '0.0.0.0');
  function handle(req, res, raw) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw);
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null, bodyHasToken: raw.includes(process.env.TOKEN), messages: body.messages.length, tools: (body.tools || []).map((tool) => tool.function.name).sort(), toolResults: body.messages.filter((m) => m.role === 'tool').map((m) => m.content) });
      if (token !== process.env.TOKEN) { res.statusCode = 401; return res.end('{"error":{"code":"AGENT_TOKEN_INVALID"}}'); }
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'user' && JSON.stringify(last.content).includes('调用业务工具')) {
        return sse(res, { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'ask-user', arguments: JSON.stringify(${JSON.stringify(ASK_USER_ARGUMENTS)}) } }] }, 'tool_calls');
      }
      if (last.role === 'user' && JSON.stringify(last.content).includes('校验 JSON')) {
        return sse(res, { tool_calls: [
          { index: 0, id: 'call_3', type: 'function', function: { name: 'json-validation', arguments: JSON.stringify({ file_path: '目录.json' }) } },
          { index: 1, id: 'call_4', type: 'function', function: { name: 'json-validation', arguments: JSON.stringify({ file_path: '目录.json', schema: { type: 'object', required: ['items'] } }) } },
        ] }, 'tool_calls');
      }
      if (last.role === 'user') {
        return sse(res, { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: process.env.PROBE_COMMAND }) } }] }, 'tool_calls');
      }
      return sse(res, { content: '完成' }, 'stop');
    }
    if (req.method === 'POST' && req.url === '/v1/tools/call') {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null, bodyHasToken: raw.includes(process.env.TOKEN), toolCall: JSON.parse(raw) });
      if (token !== process.env.TOKEN) { res.statusCode = 401; return res.end('{"error":{"code":"AGENT_TOKEN_INVALID"}}'); }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ result: ${JSON.stringify(ASK_USER_ANSWER)} }));
    }
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
    const answer = () => {
      if (req.method !== 'GET' || req.url !== '/v1/session' || (token !== process.env.TOKEN && token !== process.env.SLOW_TOKEN)) {
        res.statusCode = 401;
        return res.end('{"error":{"code":"AGENT_TOKEN_INVALID"}}');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'active', expiresAt: '${EXPIRES}' }));
    };
    if (token === process.env.SLOW_TOKEN) setTimeout(answer, ${SLOW_MS}); else answer();
  }`;

interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  bodyHasToken?: boolean;
  messages?: number;
  tools?: string[];
  toolResults?: string[];
  toolCall?: { name: string; arguments: unknown };
}

async function gatewaySeen(ref: Parameters<typeof run>[0]): Promise<Seen[]> {
  const result = await run(ref, ['node', '-e', `require('http').get('http://agent-gw:8080/seen', (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => process.stdout.write(b)); })`]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe.runIf(sandboxEnv.agentImage)('agent 入口（8.6a、8.6b）', () => {
  beforeAll(async () => {
    expect((await dockerRequest('POST', '/networks/create', { Name: gatewayHomeNetwork, Internal: true })).status).toBe(201);
    const created = await dockerRequest('POST', `/containers/create?name=${gatewayName}`, {
      Image: image,
      Entrypoint: ['node'],
      Cmd: ['-e', GATEWAY_STUB],
      Env: [`TOKEN=${TOKEN}`, `SLOW_TOKEN=${SLOW_TOKEN}`, `PROBE_COMMAND=${PROBE_COMMAND}`],
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

  it('prompt：Pi 经 agent-gw 调用模型并执行 bash 命令；命令的环境固定，沙箱内任何进程的环境与参数中都没有令牌', async () => {
    const ref = await createSandbox();
    const written = await run(ref, ['node', '-e', `require('fs').writeFileSync('/tmp/probe.cjs', ${JSON.stringify(PROBE_SCRIPT)})`]);
    expect(written.exitCode, written.stderr).toBe(0);
    const request: AgentPromptRequest = {
      action: 'prompt',
      token: TOKEN,
      prompt: '按任务说明检查工作区',
      session: null,
      tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'],
      maxTurns: 5,
      model: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    };
    const result = await runAgentEntry(driver, ref, request);
    expect(result).toEqual({ ok: true, action: 'prompt', session: expect.stringMatching(AGENT_SESSION_FILE_PATTERN), turns: 2, stopReason: 'stop' });
    const session = (result as { session: string }).session;
    const chats = (await gatewaySeen(ref)).filter((item) => item.url === '/v1/chat/completions');
    expect(chats).toHaveLength(2);
    for (const chat of chats) expect(chat).toMatchObject({ method: 'POST', authorization: `Bearer ${TOKEN}`, bodyHasToken: false });
    expect(chats[0]!.tools).toEqual(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
    const probe = JSON.parse(chats[1]!.toolResults![0]!) as { found: string[]; processes: string[]; env: string[]; memory: Record<string, unknown> };
    // 纵深防御评估的测量（见路线图 8.6b“纵深防御评估”）：只记录，不断言。
    console.info(JSON.stringify({ runtime: sandboxEnv.runtime, template: 'agent', agentCommandReadsEntryMemory: probe.memory }));
    // 入口（Pi）在运行，bash 命令在它之下运行。
    expect(probe.processes).toContain('/usr/local/bin/node /opt/agent/entry.mjs');
    expect(probe.found).toEqual([]);
    expect(probe.env).toEqual(['HOME', 'LANG', 'PATH', 'PWD', 'TMPDIR']);

    // 续接会话：带上之前的对话，写回同一个会话文件。
    const resumed = await runAgentEntry(driver, ref, { ...request, prompt: '继续', session });
    expect(resumed).toEqual({ ok: true, action: 'prompt', session, turns: 2, stopReason: 'stop' });
    const resumedChats = (await gatewaySeen(ref)).filter((item) => item.url === '/v1/chat/completions').slice(2);
    expect(resumedChats[0]!.messages).toBeGreaterThan(chats[1]!.messages!);

    // 工作区按 agent 模板的规则取回：结果文件与会话文件（都是普通文件、扩展名在白名单中），其中没有令牌。
    const files = await driver.copyOut(ref);
    expect(files.map((file) => file.path).sort()).toEqual([`pi-sessions/${session}`, '结果.txt']);
    expect(files.find((file) => file.path === '结果.txt')!.data.toString()).toBe('ok');
    for (const file of files) expect(file.data.toString('latin1')).not.toContain(TOKEN);
  });

  it('prompt：业务工具的桩（8.6c1）经 agent-gw 的 POST /v1/tools/call 调用，令牌只在 Authorization 中，回答交给模型', async () => {
    const ref = await createSandbox();
    const before = (await gatewaySeen(ref)).length;
    const request: AgentPromptRequest = {
      action: 'prompt',
      token: TOKEN,
      prompt: '调用业务工具确认目录组织方式',
      session: null,
      tools: ['read', 'ask-user'],
      maxTurns: 5,
      model: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    };
    const result = await runAgentEntry(driver, ref, request);
    expect(result).toEqual({ ok: true, action: 'prompt', session: expect.stringMatching(AGENT_SESSION_FILE_PATTERN), turns: 2, stopReason: 'stop' });
    const seen = (await gatewaySeen(ref)).slice(before);
    expect(seen.filter((item) => item.url === '/v1/tools/call')).toEqual([
      { method: 'POST', url: '/v1/tools/call', authorization: `Bearer ${TOKEN}`, bodyHasToken: false, toolCall: { name: 'ask-user', arguments: ASK_USER_ARGUMENTS } },
    ]);
    const chats = seen.filter((item) => item.url === '/v1/chat/completions');
    expect(chats).toHaveLength(2);
    expect(chats[0]!.tools).toEqual(['ask-user', 'read']);
    expect(chats[1]!.toolResults!.map((content) => JSON.parse(content))).toEqual([ASK_USER_ANSWER]);
  });

  it('prompt：本地工具 json-validation（8.6c2a）在沙箱内的工作线程中用镜像中的 Ajv 校验，不经 agent-gw；预置 Schema 优先', async () => {
    const ref = await createSandbox();
    const written = await run(ref, ['node', '-e', `require('fs').writeFileSync('/workspace/目录.json', JSON.stringify({ items: ['概述'] }))`]);
    expect(written.exitCode, written.stderr).toBe(0);
    const before = (await gatewaySeen(ref)).length;
    const request: AgentPromptRequest = {
      action: 'prompt',
      token: TOKEN,
      prompt: '校验 JSON 结果',
      session: null,
      tools: ['read', 'json-validation'],
      maxTurns: 5,
      model: { contextWindow: 128_000, maxOutputTokens: 8_192 },
      jsonSchemas: { '目录.json': { type: 'object', properties: { items: { type: 'array', minItems: 2 } } } },
    };
    const result = await runAgentEntry(driver, ref, request);
    expect(result).toEqual({ ok: true, action: 'prompt', session: expect.stringMatching(AGENT_SESSION_FILE_PATTERN), turns: 2, stopReason: 'stop' });
    const seen = (await gatewaySeen(ref)).slice(before);
    expect(seen.filter((item) => item.url === '/v1/tools/call')).toEqual([]);
    const chats = seen.filter((item) => item.url === '/v1/chat/completions');
    expect(chats[0]!.tools).toEqual(['json-validation', 'read']);
    // 两次调用都按预置的 Schema（minItems 2）校验：模型给出的 schema 被忽略。
    const results = chats[1]!.toolResults!.map((content) => JSON.parse(content));
    expect(results).toHaveLength(2);
    for (const item of results) expect(item).toMatchObject({ valid: false, stage: 'validation', file_path: '目录.json', errors: [{ instancePath: '/items', keyword: 'minItems' }] });
  });

  it('prompt：续接的会话文件不存在时 SESSION_INVALID；令牌无效时不启动 Pi 会话', async () => {
    const ref = await createSandbox();
    const request: AgentPromptRequest = {
      action: 'prompt',
      token: TOKEN,
      prompt: '继续',
      session: '2026-11-15T12-00-00-000Z_01a1e18b-3a01-73ab-8e86-dcac529abd40.jsonl',
      tools: [],
      maxTurns: 5,
      model: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    };
    const before = (await gatewaySeen(ref)).length;
    expect(await runAgentEntry(driver, ref, request)).toEqual({ ok: false, code: 'SESSION_INVALID' });
    expect(await runAgentEntry(driver, ref, { ...request, session: null, token: generateAgentToken() })).toEqual({ ok: false, code: 'TOKEN_INVALID' });
    const after = (await gatewaySeen(ref)).slice(before);
    expect(after.map((item) => item.url)).toEqual(['/v1/session', '/v1/session']);
  });

  // 放在最后：停止桩之后本文件的其他用例无法再访问 agent-gw。
  it('agent-gw 不可用时报告 GATEWAY_UNAVAILABLE', async () => {
    const ref = await createSandbox();
    expect((await dockerRequest('POST', `/containers/${gatewayName}/kill`)).status).toBe(204);
    expect(await runAgentEntry(driver, ref, { action: 'session', token: TOKEN })).toEqual({ ok: false, code: 'GATEWAY_UNAVAILABLE' });
  });
});
