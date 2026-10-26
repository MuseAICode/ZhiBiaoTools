// worker 进程入口（docs/SERVER_DESIGN.md 第 1、5 节）：与 api 同一镜像、不同入口（node dist/worker.js）。
// 执行任务队列中的全部长任务，不对外提供接口；只在容器内监听 /healthz、/readyz，供容器健康检查使用。
// 收到 SIGTERM / SIGINT 时中止正在执行的任务（可续跑的回到 queued，由其他 worker 或重启后继续），再退出。
import Fastify from 'fastify';
import { ConfigError, loadConfig, type AppConfig } from './config.ts';
import { createDatabase } from './db/database.ts';
import { registerErrorHandlers } from './errors.ts';
import { createEventPublisher } from './events/publisher.ts';
import { createJobNotifier } from './jobs/notify.ts';
import { createJobDispatcher } from './jobs/queue.ts';
import { jobTypeRegistry } from './jobs/registry.ts';
import { createJobRunner } from './jobs/runner.ts';
import { createLoggerOptions } from './logger.ts';
import { bullmqConnection, createRedis } from './redis.ts';
import { registerHealthRoutes } from './routes/health.ts';

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
const runner = createJobRunner({
  db: database.db,
  registry: jobTypeRegistry,
  dispatcher,
  connection: bullmqConnection(redisConfig, 'worker', 'bidtools-worker'),
  log: app.log,
  notifier: createJobNotifier({ db: database.db, publisher, log: app.log }),
});

app.addHook('onClose', async () => {
  await runner.close();
  await dispatcher.close();
  await publisher.close();
  await Promise.all([database.destroy(), redis.destroy()]);
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
app.log.info({ jobTypes: jobTypeRegistry.types.map((definition) => definition.type) }, 'job worker started');
