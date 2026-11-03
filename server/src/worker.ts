// worker 进程入口（docs/SERVER_DESIGN.md 第 1、5 节）：与 api 同一镜像、不同入口（node dist/worker.js）。
// 执行任务队列中的全部长任务，不对外提供接口；只在容器内监听 /healthz、/readyz，供容器健康检查使用。
// 收到 SIGTERM / SIGINT 时中止正在执行的任务（可续跑的回到 queued，由其他 worker 或重启后继续），再退出。
// 任务中的模型调用经同一个 AI 网关模块（src/ai/gateway.ts），在 worker 进程中解密平台 Key、冻结和结算（6.4）。
// 文档解析（6.6）经 sandbox-runner 在断网沙箱中执行（SANDBOX_RUNNER_URL + 令牌），worker 只取原件、校验结果、写产物，
// 不运行任何文档解析器，也不挂载 Docker socket。
// 清理任务（6.8）每小时一批：跨组织删除超过保留期的文件、产物、项目和任务记录，并把到期的冻结收尾（src/cleanup/）。
import Fastify from 'fastify';
import { createAiConcurrencyLimiter } from './ai/concurrency.ts';
import { createAiGateway } from './ai/gateway.ts';
import { KeyringError, loadFileKeyWrapper, type KeyWrapper } from './ai/keyring.ts';
import { createCleaner, startCleanupSchedule, type CleanupSchedule } from './cleanup/cleanup.ts';
import { ConfigError, loadConfig, type AppConfig } from './config.ts';
import { createDatabase } from './db/database.ts';
import { registerErrorHandlers } from './errors.ts';
import { createEventPublisher } from './events/publisher.ts';
import { createS3ObjectStore } from './files/objectStore.ts';
import { createJobNotifier } from './jobs/notify.ts';
import { createJobDispatcher } from './jobs/queue.ts';
import { jobTypeRegistry } from './jobs/registry.ts';
import { createJobRunner } from './jobs/runner.ts';
import { createLoggerOptions } from './logger.ts';
import { bullmqConnection, createRedis } from './redis.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { createSandboxRunnerClient } from './sandbox/client.ts';

/** 等待正在执行的任务在检查点退出的上限；docker-compose.yml 的 stop_grace_period 要比它长。 */
const SHUTDOWN_TIMEOUT_MS = 25_000;

function failStartup(message: string, extra: Record<string, unknown> = {}): never {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', time: Date.now(), msg: message, ...extra })}\n`);
  process.exit(1);
}

let config: AppConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) failStartup(error.message, { issues: error.issues });
  throw error;
}
const redisConfig = config.redis;
if (!redisConfig) failStartup('配置不合法：REDIS_URL 缺失（worker 必需）');

let keyWrapper: KeyWrapper | null = null;
if (config.ai.kekFile) {
  try {
    keyWrapper = loadFileKeyWrapper(config.ai.kekFile, config.ai.kekVersion);
  } catch (error) {
    if (error instanceof KeyringError) failStartup(error.message);
    throw error;
  }
}

const app = Fastify({ logger: createLoggerOptions({ level: config.logLevel }) });
registerErrorHandlers(app);

const database = createDatabase(config.database, {
  applicationName: 'bidtools-worker',
  onIdleError: (error) => app.log.warn({ err: error }, 'idle database connection error'),
});
const redis = createRedis(redisConfig, {
  connectionName: 'bidtools-worker-health',
  onError: (error) => app.log.warn({ err: error }, 'redis connection error'),
});
await app.register(registerHealthRoutes, { pingDatabase: () => database.ping(), pingRedis: () => redis.ping() });

const dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig, 'producer', 'bidtools-worker-dispatch') });
const publisher = createEventPublisher(redisConfig, { log: app.log, connectionName: 'bidtools-worker-publisher' });
const aiLimiter = createAiConcurrencyLimiter(redisConfig, { leaseMs: config.ai.holdTtlSeconds * 1000, log: app.log });
// 未配置主密钥时任务调用模型一律失败（AI_UNAVAILABLE）；不调用模型的任务照常执行。
const gateway = keyWrapper ? createAiGateway({ db: database.db, keyWrapper, settings: config.ai, log: app.log, limiter: aiLimiter }) : null;
if (!gateway) app.log.warn('AI_KEK_FILE is not set, model calls in jobs will fail');
// 未配置对象存储或 sandbox-runner 时解析任务失败（PARSE_UNAVAILABLE），其他任务照常执行。
const objectStore = config.storage ? createS3ObjectStore(config.storage) : null;
if (!objectStore) app.log.warn('S3_BUCKET is not set, document parse jobs will fail and expired files will not be cleaned up');
const sandbox = config.sandbox ? createSandboxRunnerClient({ url: config.sandbox.url, token: config.sandbox.token }) : null;
if (!sandbox) app.log.warn('SANDBOX_RUNNER_URL is not set, document parse jobs will fail');
const runner = createJobRunner({
  db: database.db,
  registry: jobTypeRegistry,
  dispatcher,
  connection: bullmqConnection(redisConfig, 'worker', 'bidtools-worker'),
  log: app.log,
  notifier: createJobNotifier({ db: database.db, publisher, log: app.log }),
  gateway,
  objectStore,
  sandbox,
});

let cleanup: CleanupSchedule | null = null;

app.addHook('onClose', async () => {
  await cleanup?.close();
  await runner.close();
  await dispatcher.close();
  await publisher.close();
  await Promise.all([database.destroy(), redis.destroy(), aiLimiter.close()]);
});

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
// Redis 暂时不可用时这里等到连上为止（期间 /readyz 返回 503），连上后先对账再开始消费。
await runner.start();
cleanup = startCleanupSchedule(createCleaner({ db: database.db, objectStore, log: app.log }), { log: app.log });
app.log.info({ jobTypes: jobTypeRegistry.types.map((definition) => definition.type) }, 'job worker started');
