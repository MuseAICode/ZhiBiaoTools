// agent-gw 进程入口（路线图第 8 步 8.2b，docs/SERVER_DESIGN.md 第 7.12 节）：与 api 同一镜像、不同入口（node dist/agent-gw.js）。
// agent 沙箱访问平台的唯一入口，只做令牌格式、大小与时限检查后把请求转给 worker 的内部入口（src/agent/gateway.ts）。
// 不持有平台凭据（只有转给 worker 这一跳的中继密钥 AGENT_RELAY_KEY）：环境中出现数据库密码、主密钥、对象存储密钥、Redis 密码、sandbox-runner 令牌等配置即拒绝启动。
import { buildAgentGateway } from './agent/gateway.ts';
import { ConfigError, loadAgentGatewayConfig, type AgentGatewayConfig } from './config.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function failStartup(message: string, extra: Record<string, unknown> = {}): never {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', time: Date.now(), msg: message, ...extra })}\n`);
  process.exit(1);
}

let config: AgentGatewayConfig;
try {
  config = loadAgentGatewayConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) failStartup(error.message, { issues: error.issues });
  throw error;
}

const app = await buildAgentGateway({ upstream: config.upstream, relayKey: config.relayKey, logLevel: config.logLevel, limits: { responseTimeoutMs: config.responseTimeoutMs } });

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => {
    app.log.error('shutdown timed out, exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  process.exit(1);
}
