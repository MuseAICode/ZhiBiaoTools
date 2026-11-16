// agent 沙箱入口中的 Pi 会话（路线图第 8 步 8.6b；docs/SERVER_DESIGN.md 第 7.22 节）：执行一条提示词（protocol.mjs 的 prompt 请求）。
// 依赖 @earendil-works/pi-coding-agent / pi-ai（MIT，按 package-lock.json 在镜像构建阶段安装），只在 prompt 请求时加载。
//
// 与桌面版 pi/piSessionFactory.cjs 的同一套配置（提供方 app、openai-completions、不思考、不加载项目上下文 / 扩展 / 技能 /
// 提示模板 / 主题、不发遥测），不同之处：
// - **模型经 agent-gw**：Base URL 固定为 http://agent-gw:8080/v1（/etc/hosts 中的地址），任务令牌作为 Pi 的运行时 API Key
//   只留在本进程内存中（Pi 以 Authorization: Bearer 发送），不写进环境、文件与会话；平台按令牌决定组织、模型与上限，
//   请求中的模型名（default）不被采信。Pi 自身不重试（retry.enabled = false），重试与暂停由 worker 决定（8.6d）；
// - **原生工具**：read / write / edit / bash / grep / find / ls 按请求的清单启用（业务工具的桩随 8.6c），工作目录 /workspace；
// - **bash**：/bin/sh；每条命令最多 BASH_COMMAND_TIMEOUT_SECONDS（模型给出的 timeout 只能更短）；命令的环境是固定的几项
//   （BASH_ENV），不继承入口进程的环境；
// - **会话文件**：/workspace/pi-sessions/（随工作区快照保存，续跑时由 worker 放回）；续接时只接受 Pi 命名的普通文件；
// - **工作区说明**：镜像中的 workspace-instructions.md（桌面版 agent-workspace.md 改写：Linux /bin/sh、断网、文件命名规则）；
// - **一条提示词的轮数上限**：第 maxTurns + 1 轮开始时中止（TURN_LIMIT），与桌面版 max_turns_per_prompt 相同。
//
// Pi 运行在沙箱中、按攻击者的代码处理：这里的设置只是让 Agent 正常工作，平台的控制都在沙箱之外（网络只通 agent-gw、令牌、
// 上限、工作区取回校验）。
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EntryError, SESSION_FILE_PATTERN } from './protocol.mjs';

export const WORKSPACE_DIR = '/workspace';
export const SESSIONS_DIR = '/workspace/pi-sessions';
/** Pi 的配置目录（只在 /tmp 中，Pi 在本平台的配置下不写入；不放进工作区）。 */
export const AGENT_DIR = '/tmp/pi-agent';
export const INSTRUCTIONS_PATH = new URL('./workspace-instructions.md', import.meta.url);
/** 单条 bash 命令的时限（#70 决定事项第 3 项）。 */
export const BASH_COMMAND_TIMEOUT_SECONDS = 5 * 60;
/** 一次模型调用（含流式响应）的空闲时限：比 agent-gw 等 worker 的时限长，由平台一侧先结束。 */
export const MODEL_REQUEST_TIMEOUT_MS = 15 * 60_000;
/** bash 命令的环境：固定的几项，不继承入口进程（及 Pi）的环境。 */
export const BASH_ENV = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  TMPDIR: '/tmp',
  LANG: 'C.UTF-8',
});
const PROVIDER = 'app';
const MODEL_ID = 'default';

let modulesPromise = null;
function loadPiModules() {
  // 在加载 Pi 之前设定：不下载缺少的 rg / fd（镜像中已有）、不检查新版本，Pi 的配置目录在 /tmp 中。
  process.env.PI_OFFLINE = '1';
  process.env.PI_SKIP_VERSION_CHECK = '1';
  process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
  modulesPromise ??= Promise.all([import('@earendil-works/pi-coding-agent'), import('@earendil-works/pi-ai')]).then(([codingAgent, piAi]) => ({ codingAgent, piAi }));
  return modulesPromise;
}

/** 续接的会话文件：名字已按 SESSION_FILE_PATTERN 检查；必须是 sessionsDir 中的普通文件（不跟随符号链接）。 */
function existingSessionPath(sessionsDir, name) {
  if (!SESSION_FILE_PATTERN.test(name)) throw new EntryError('SESSION_INVALID');
  const path = join(sessionsDir, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new EntryError('SESSION_INVALID');
  }
  if (!stat.isFile()) throw new EntryError('SESSION_INVALID');
  return path;
}

/** 本条提示词结束后最后一条 assistant 消息的结束原因。 */
function lastAssistant(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return messages[index];
  }
  return null;
}

/**
 * 一条 bash 命令的时限（秒）：模型没给出时为 BASH_COMMAND_TIMEOUT_SECONDS，给出的只能更短。不合法的值（非正数、NaN）原样交给 Pi，
 * 由 Pi 报告参数错误、不执行命令。
 */
export function bashTimeoutSeconds(requested) {
  if (requested === undefined) return BASH_COMMAND_TIMEOUT_SECONDS;
  return typeof requested === 'number' && requested > BASH_COMMAND_TIMEOUT_SECONDS ? BASH_COMMAND_TIMEOUT_SECONDS : requested;
}

/** bash 工具的执行：/bin/sh，命令时限见 bashTimeoutSeconds，环境固定为 BASH_ENV（不继承入口进程的环境）。 */
function createBashOperations(codingAgent) {
  const local = codingAgent.createLocalBashOperations({ shellPath: '/bin/sh' });
  return {
    exec: (command, cwd, options) => local.exec(command, cwd, { ...options, timeout: bashTimeoutSeconds(options.timeout), env: { ...BASH_ENV } }),
  };
}

/**
 * 执行一条提示词。request 为 protocol.mjs 解析过的 prompt 请求；返回 { session（会话文件名）, turns, stopReason（stop / length）}。
 * 失败抛 EntryError：会话文件不存在或无效 SESSION_INVALID、轮数达到上限 TURN_LIMIT、模型调用失败（含被平台拒绝：令牌失效、
 * 达到任务上限、余额不足等，具体原因由 worker 按任务状态判断，不采信沙箱的说法）MODEL_FAILED。
 */
export async function runPiPrompt(request, { baseUrl, workspaceDir = WORKSPACE_DIR, sessionsDir = SESSIONS_DIR, agentDir = AGENT_DIR, instructionsPath = INSTRUCTIONS_PATH } = {}) {
  const { codingAgent, piAi } = await loadPiModules();
  const instructions = readFileSync(instructionsPath, 'utf8');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionPath = request.session === null ? null : existingSessionPath(sessionsDir, request.session);

  const modelRuntime = await codingAgent.ModelRuntime.create({
    credentials: new piAi.InMemoryCredentialStore(),
    modelsStore: new piAi.InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(PROVIDER, {
    name: 'ZhiBiaoTools AI',
    baseUrl: `${baseUrl}/v1`,
    api: 'openai-completions',
    models: [{
      id: MODEL_ID,
      name: 'ZhiBiaoTools Current Text Model',
      reasoning: false,
      input: ['text'],
      contextWindow: request.model.contextWindow,
      maxTokens: request.model.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
        maxTokensField: 'max_tokens',
      },
    }],
  });
  await modelRuntime.setRuntimeApiKey(PROVIDER, request.token);
  const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
  if (!model) throw new EntryError('INTERNAL');

  const settingsManager = codingAgent.SettingsManager.inMemory({
    defaultProvider: PROVIDER,
    defaultModel: MODEL_ID,
    defaultThinkingLevel: 'off',
    defaultProjectTrust: 'never',
    retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: MODEL_REQUEST_TIMEOUT_MS } },
    compaction: { enabled: true },
    images: { autoResize: false, blockImages: true },
    enableInstallTelemetry: false,
    enableAnalytics: false,
    shellPath: '/bin/sh',
    httpIdleTimeoutMs: MODEL_REQUEST_TIMEOUT_MS,
  }, { projectTrusted: false });
  const resourceLoader = new codingAgent.DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir,
    settingsManager,
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [{ path: '<app-agent-workspace>', content: instructions }] }),
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  let sessionManager;
  try {
    sessionManager = sessionPath ? codingAgent.SessionManager.open(sessionPath, sessionsDir, workspaceDir) : codingAgent.SessionManager.create(workspaceDir, sessionsDir);
  } catch {
    throw new EntryError('SESSION_INVALID');
  }
  const bashTool = codingAgent.createBashToolDefinition(workspaceDir, { shellPath: '/bin/sh', operations: createBashOperations(codingAgent) });
  const { session } = await codingAgent.createAgentSession({
    cwd: workspaceDir,
    agentDir,
    model,
    modelRuntime,
    thinkingLevel: 'off',
    // tools 同时限定注册范围（含 customTools）：只注册请求中的原生工具；bash 用上面的定义替换 Pi 的默认实现，不在清单中时不注册。
    tools: request.tools,
    customTools: [bashTool],
    resourceLoader,
    settingsManager,
    sessionManager,
  });

  let turns = 0;
  let turnLimitReached = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== 'turn_start' || turnLimitReached) return;
    turns += 1;
    if (turns <= request.maxTurns) return;
    turnLimitReached = true;
    void session.abort();
  });
  try {
    await session.prompt(request.prompt, { expandPromptTemplates: false });
  } finally {
    unsubscribe();
  }
  if (turnLimitReached) throw new EntryError('TURN_LIMIT');
  const assistant = lastAssistant(session.messages);
  if (!assistant || assistant.stopReason === 'error' || assistant.stopReason === 'aborted') throw new EntryError('MODEL_FAILED');
  if (assistant.stopReason !== 'stop' && assistant.stopReason !== 'length') throw new EntryError('INTERNAL');
  const sessionFile = session.sessionFile ?? sessionManager.getSessionFile();
  const name = typeof sessionFile === 'string' ? sessionFile.slice(sessionFile.lastIndexOf('/') + 1) : '';
  if (!SESSION_FILE_PATTERN.test(name)) throw new EntryError('INTERNAL');
  session.dispose();
  return { session: name, turns, stopReason: assistant.stopReason };
}
