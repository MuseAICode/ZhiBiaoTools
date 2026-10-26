// sandbox-runner 进程入口（docs/SERVER_DESIGN.md 第 7.4、7.5 节；路线图第 6 步 6.5）：与 api 同一镜像、不同入口
// （node dist/sandbox-runner.js）。唯一挂载 Docker socket、能创建容器的进程，只按 src/sandbox/templates.ts 中写死的模板
// 创建和销毁沙箱。只在内部网络 sandbox-control 上监听，只有 worker 持有调用令牌。
// 启动时检查配置的容器运行时（生产为 runsc）已在 Docker 中登记，否则拒绝启动；之后每 30 秒删除到期的沙箱。
import { loadSandboxRunnerConfig, ConfigError, type SandboxRunnerConfig } from './config.ts';
import { assertRuntimeAvailable, createDockerSandboxDriver } from './sandbox/docker.ts';
import { createDockerApi } from './sandbox/dockerApi.ts';
import { buildSandboxRunnerApp } from './sandbox/runnerApp.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const SWEEP_INTERVAL_MS = 30_000;

function failStartup(message: string, extra: Record<string, unknown> = {}): never {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', time: Date.now(), msg: message, ...extra })}\n`);
  process.exit(1);
}

let config: SandboxRunnerConfig;
try {
  config = loadSandboxRunnerConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) failStartup(error.message, { issues: error.issues });
  throw error;
}

const docker = createDockerApi(config.dockerSocket);
try {
  await assertRuntimeAvailable(docker, config.runtime);
} catch (error) {
  failStartup('容器运行时不可用', { runtime: config.runtime, reason: error instanceof Error ? error.message : 'unknown' });
}

// buildSandboxRunnerApp 之后才有日志器，driver 的日志先转一层。
const log = {
  info: (obj: unknown, msg?: string) => app.log.info(obj, msg),
  warn: (obj: unknown, msg?: string) => app.log.warn(obj, msg),
  error: (obj: unknown, msg?: string) => app.log.error(obj, msg),
} as Parameters<typeof createDockerSandboxDriver>[0]['log'];
const driver = createDockerSandboxDriver({ docker, runtime: config.runtime, images: config.images, maxActive: config.maxActive, log });
const app = await buildSandboxRunnerApp({ driver, docker, runtime: config.runtime, token: config.token, logLevel: config.logLevel });
if (config.runtime !== 'runsc') app.log.warn({ runtime: config.runtime }, 'sandbox runtime is not gVisor (development only)');

const sweeper = setInterval(() => {
  driver.sweep().catch((error: unknown) => app.log.warn({ err: error }, 'sandbox sweep failed'));
}, SWEEP_INTERVAL_MS);
sweeper.unref();
app.addHook('onClose', async () => clearInterval(sweeper));

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
// 启动时先清理一次：上次运行留下的到期沙箱。
await driver.sweep().catch((error: unknown) => app.log.warn({ err: error }, 'sandbox sweep failed'));
