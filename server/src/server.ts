// 进程入口：校验配置 → 启动 → 收到 SIGTERM / SIGINT 时优雅退出。
import { createAiConcurrencyLimiter } from './ai/concurrency.ts';
import { KeyringError, loadFileKeyWrapper, type KeyWrapper } from './ai/keyring.ts';
import { buildApp } from './app.ts';
import { expireStaleHolds } from './billing/usage.ts';
import { ConfigError, loadConfig, type AppConfig } from './config.ts';
import { createDatabase } from './db/database.ts';
import { createEventHub } from './events/hub.ts';
import { createEventPublisher } from './events/publisher.ts';
import { createS3ObjectStore } from './files/objectStore.ts';
import { createJobNotifier } from './jobs/notify.ts';
import { createRedis } from './redis.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;
/** 清理到期冻结的间隔。到期的冻结本来就不占用余额，这里只把记录标为 abandoned。 */
const HOLD_SWEEP_INTERVAL_MS = 60_000;

function failStartup(message: string, extra: Record<string, unknown> = {}): never {
  // 此时日志器尚未创建，直接输出一行结构化 JSON 到 stderr。
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

let keyWrapper: KeyWrapper | null = null;
if (config.ai.kekFile) {
  try {
    keyWrapper = loadFileKeyWrapper(config.ai.kekFile, config.ai.kekVersion);
  } catch (error) {
    if (error instanceof KeyringError) failStartup(error.message);
    throw error;
  }
}

// 连接池按需建连：数据库暂时不可用时进程照常启动，由 /readyz 报告未就绪。
const database = createDatabase(config.database, {
  onIdleError: (error) => app.log.warn({ err: error }, 'idle database connection error'),
});
const objectStore = config.storage ? createS3ObjectStore(config.storage) : null;
// 与数据库相同：Redis 暂时不可用时进程照常启动并自动重连，由 /readyz 报告未就绪。
const redis = config.redis
  ? createRedis(config.redis, { onError: (error) => app.log.warn({ err: error }, 'redis connection error') })
  : null;
// 事件推送（GET /api/events 与任务状态变化的推送）同样只在配置了 Redis 时开启；日志器在 buildApp 之后才有，先转一层。
const eventLog = { warn: (obj: unknown, msg?: string) => app.log.warn(obj, msg) };
const publisher = config.redis ? createEventPublisher(config.redis, { log: eventLog, connectionName: 'bidtools-api-publisher' }) : null;
const hub = config.redis ? createEventHub(config.redis, { log: eventLog }) : null;
const events = publisher && hub ? { hub, notifier: createJobNotifier({ db: database.db, publisher, log: eventLog }) } : null;
// AI 网关的并发信号量（名额最长占用一个冻结时长）。未配置 Redis 时不限制并发。
const aiLimiter = config.redis
  ? createAiConcurrencyLimiter(config.redis, { leaseMs: config.ai.holdTtlSeconds * 1000, log: eventLog })
  : null;
const app = await buildApp(config, { database, keyWrapper, objectStore, redis, events, aiLimiter });
if (!keyWrapper) app.log.warn('AI_KEK_FILE is not set, AI gateway disabled');
if (!objectStore) app.log.warn('S3_BUCKET is not set, file storage disabled');
if (!redis) app.log.warn('REDIS_URL is not set, redis readiness check and event stream disabled');

const sweeper = setInterval(() => {
  expireStaleHolds(database.db).then(
    (expired) => {
      if (expired > 0) app.log.warn({ expired }, 'expired abandoned ai usage holds');
    },
    (error: unknown) => app.log.warn({ err: error }, 'ai usage hold sweep failed'),
  );
}, HOLD_SWEEP_INTERVAL_MS);
sweeper.unref();

app.addHook('onClose', async () => {
  clearInterval(sweeper);
  await Promise.all([database.destroy(), redis?.destroy(), hub?.close(), publisher?.close(), aiLimiter?.close()]);
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
