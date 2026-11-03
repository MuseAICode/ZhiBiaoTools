// worker 中的任务执行与对账（docs/SERVER_DESIGN.md 第 5 节；路线图第 6 步 6.2）。
//
// 执行：BullMQ 派发 → claimJob 认领（只有 queued 能被认领，同一任务派发多次也只执行一次）→ 按任务记录建立 TenantContext →
// 执行任务类型的 run，期间定期续租并检查取消、暂停请求 → finishRun 收尾。认领后的每次写入都带 run_id 条件。
// 组织已有 orgRunningLimit 个任务在运行时，本次派发延后（BullMQ 延迟任务），任务留在 queued。
//
// 对账（reconcile）：启动时、发现 Redis 数据丢失时和之后定期执行。jobs 是唯一权威，Redis 不持久化，重启或被清空后队列内容全部丢失；
// 对账从 jobs 找出 queued 的任务重新放进 BullMQ（同一 id 已在队列中时是空操作），并收回租约过期的任务
// （执行者崩溃或失联）：可续跑的回到 queued 再派发、从 checkpoint 继续，不可续跑的标为失败。不依赖 BullMQ 的 stalled 检测。
// 发现数据丢失：Redis 中放一个哨兵键，每次连上和每隔 redisCheckIntervalMs 用 SET NX 写一次；写入成功说明键不在了
// （重启或被清空，清空时连接并不会断开），立即对账，不必等到下一次定期对账。
//
// 推送（6.3）：认领、进度、日志、结束、对账改变状态后经 notifier 推送（src/jobs/notify.ts）。另订阅任务控制频道
// （src/events/publisher.ts 的 jobControlChannel）：收到正在执行的任务 id 时立即续租一次，从 jobs 读到取消、暂停请求，
// 不必等到下一次续租；消息本身不被信任，只触发一次查询。
//
// 模型调用（6.4）：任务经 context.ai 调用 AI 网关（在 worker 进程中运行），用量记到本任务；余额不足以冻结时
// 任务退出、暂停为 paused / insufficient_balance，经 notifier 推送（job 事件的 pauseReason），充值后由用户继续。
// 每次调用带步骤键（6.4a）：结果与结算同一事务保存，续跑时同一步骤直接取回，不重复调用、不重复扣费。
import { randomUUID } from 'node:crypto';
import { DelayedError, Worker, type Job, type RedisOptions as BullmqRedisOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import { JOB_DISPATCH_BATCH_MAX } from '../db/migrations/0021_jobs.ts';
import type { AiGateway } from '../ai/gateway.ts';
import type { Database } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import type { SandboxDriver } from '../sandbox/driver.ts';
import {
  DEFAULT_QUEUE_CONCURRENCY,
  JOB_QUEUES,
  JobBalanceExhaustedError,
  JobError,
  JobInterruptedError,
  maxAttemptsOf,
  ORG_RUNNING_JOB_LIMIT,
  type JobAi,
  type JobContext,
  type JobQueueName,
  type JobTypeRegistry,
} from './definitions.ts';
import { jobControlChannel } from '../events/publisher.ts';
import { NULL_JOB_NOTIFIER, type JobNotifier } from './notify.ts';
import { DEFAULT_QUEUE_PREFIX, type DispatchPayload, type JobDispatcher } from './queue.ts';
import {
  appendRunLog,
  claimJob,
  finishRun,
  listDispatchCandidates,
  recoverJob,
  renewRun,
  type JobRecord,
  type RunOutcome,
  type RunRef,
  type RunState,
} from './store.ts';

export interface JobRunnerOptions {
  db: Kysely<Database>;
  registry: JobTypeRegistry;
  dispatcher: JobDispatcher;
  /** BullMQ 消费者的连接参数（src/redis.ts 的 bullmqConnection(..., 'worker', ...)）。 */
  connection: BullmqRedisOptions;
  log: FastifyBaseLogger;
  prefix?: string;
  /** 本实例消费哪些队列，默认全部。 */
  queues?: readonly JobQueueName[];
  concurrency?: Partial<Record<JobQueueName, number>>;
  orgRunningLimit?: number;
  /** 租约时长；执行者超过这么久没有续租即视为失联。 */
  leaseMs?: number;
  /** 续租间隔，默认租约的 1/4。 */
  heartbeatMs?: number;
  /** 定期对账的间隔。 */
  reconcileIntervalMs?: number;
  /** 组织并发已满时，派发延后多久再试。 */
  deferDelayMs?: number;
  /** 检查 Redis 哨兵键（发现数据丢失）的间隔。 */
  redisCheckIntervalMs?: number;
  /** 状态变化后的推送；不提供时不推送。 */
  notifier?: JobNotifier;
  /** AI 网关；未配置主密钥时为 null，任务调用模型时失败（AI_UNAVAILABLE）。 */
  gateway?: AiGateway | null;
  /** 对象存储；未配置时为 null。 */
  objectStore?: ObjectStore | null;
  /** 解析沙箱（经 sandbox-runner）；未配置时为 null。 */
  sandbox?: SandboxDriver | null;
}

export interface ReconcileResult {
  /** 放进 BullMQ 的任务数（含原本就在队列中、放入为空操作的）。 */
  dispatched: number;
  failed: number;
}

export interface JobRunner {
  /** 启动消费者和定期对账，并先执行一次对账。 */
  start(): Promise<void>;
  /** 立即对账一次；已在对账中时等待那一次结束。 */
  reconcile(): Promise<ReconcileResult>;
  /** 中止正在执行的任务（按中止收尾：可续跑的回到 queued），等待它们结束后关闭消费者。 */
  close(): Promise<void>;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 15_000;
const DEFAULT_DEFER_DELAY_MS = 5_000;
const DEFAULT_REDIS_CHECK_INTERVAL_MS = 5_000;
const FINISH_RETRIES = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type AbortReason = 'cancel' | 'pause' | 'lease-lost' | 'shutdown';

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { db, registry, dispatcher, log } = options;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.max(Math.floor(leaseMs / 4), 50);
  const reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  const deferDelayMs = options.deferDelayMs ?? DEFAULT_DEFER_DELAY_MS;
  const orgRunningLimit = options.orgRunningLimit ?? ORG_RUNNING_JOB_LIMIT;
  const queueNames = options.queues ?? JOB_QUEUES;
  const prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
  const redisCheckIntervalMs = options.redisCheckIntervalMs ?? DEFAULT_REDIS_CHECK_INTERVAL_MS;
  const sentinelKey = `${prefix}:jobs:sentinel`;
  const notifier = options.notifier ?? NULL_JOB_NOTIFIER;
  const gateway = options.gateway ?? null;

  const workers: Worker<DispatchPayload>[] = [];
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** 正在执行的任务 id → 立即续租一次（收到控制消息时调用）。 */
  const checks = new Map<string, () => void>();
  let reconcileTimer: NodeJS.Timeout | undefined;
  let sentinelTimer: NodeJS.Timeout | undefined;
  let monitor: Redis | null = null;
  let control: Redis | null = null;
  let reconciling: Promise<ReconcileResult> | null = null;
  let closing = false;

  async function finishWithRetry(run: RunRef, outcome: RunOutcome, resumable: boolean) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await finishRun(db, run, outcome, resumable);
      } catch (error) {
        if (attempt >= FINISH_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  async function execute(
    job: JobRecord,
    role: JobContext<unknown>['tenant']['role'],
    runId: string,
    controller: AbortController,
  ): Promise<void> {
    const definition = registry.get(job.type);
    if (!definition) throw new Error('claimed job has no definition');
    const run: RunRef = { orgId: job.orgId, jobId: job.id, runId };
    const ref = { orgId: job.orgId, id: job.id, projectId: job.projectId, type: job.type };
    let lost = false;

    const apply = (state: RunState | null) => {
      let reason: AbortReason | null = null;
      if (!state) {
        lost = true;
        reason = 'lease-lost';
      } else if (state.status === 'cancelling') reason = 'cancel';
      else if (state.pauseRequested) reason = 'pause';
      if (reason && !controller.signal.aborted) controller.abort(reason);
      return state;
    };
    const renew = () => {
      renewRun(db, run, leaseMs).then(apply, (error: unknown) => log.warn({ err: error, jobId: job.id }, 'job lease renewal failed'));
    };
    // 余额不足以冻结：之后的调用不再发起，执行结束后暂停（不中止进行中的其他调用，它们照常结算）。
    let balanceExhausted = false;
    const tenant = { orgId: job.orgId, userId: job.userId, role };
    const ai: JobAi = {
      async chat(request, chatOptions = {}) {
        if (balanceExhausted) throw new JobBalanceExhaustedError();
        if (!gateway) throw new JobError('AI_UNAVAILABLE', '模型服务暂不可用，请稍后再试');
        try {
          return await gateway.chat(
            tenant,
            { ...request, source: 'job', jobId: job.id, jobType: job.type },
            {
              signal: controller.signal,
              log,
              // 任务中的调用一直排队等并发名额，直到任务被取消或暂停。
              concurrencyWaitMs: Number.POSITIVE_INFINITY,
              // worker 关闭、租约丢失中止的调用不收费（续跑时重做）；用户取消、暂停中止的按已产生的用量收费。
              platformAborted: () => controller.signal.reason === 'shutdown' || controller.signal.reason === 'lease-lost',
              ...(chatOptions.onDelta ? { onDelta: chatOptions.onDelta } : {}),
            },
          );
        } catch (error) {
          if (error instanceof AppError && error.code === 'INSUFFICIENT_BALANCE') {
            balanceExhausted = true;
            throw new JobBalanceExhaustedError({ cause: error });
          }
          if (controller.signal.aborted) throw error;
          if (error instanceof AppError) throw new JobError(error.code, error.message, { cause: error });
          throw error;
        }
      },
    };

    const heartbeat = setInterval(renew, heartbeatMs);
    heartbeat.unref();
    checks.set(job.id, renew);

    const context: JobContext<unknown> = {
      jobId: job.id,
      projectId: job.projectId,
      type: job.type,
      attempt: job.attempt,
      params: undefined,
      checkpoint: job.checkpoint,
      tenant,
      db,
      ai,
      objectStore: options.objectStore ?? null,
      sandbox: options.sandbox ?? null,
      signal: controller.signal,
      async setProgress(progress) {
        if (!apply(await renewRun(db, run, leaseMs, { progress }))) throw new JobInterruptedError();
        await notifier.progress(ref, progress);
      },
      async saveCheckpoint(checkpoint, progress) {
        if (!apply(await renewRun(db, run, leaseMs, { checkpoint, ...(progress !== undefined ? { progress } : {}) }))) {
          throw new JobInterruptedError();
        }
        if (progress !== undefined) await notifier.progress(ref, progress);
      },
      async log(message, data) {
        const event = await appendRunLog(db, run, message, data);
        if (!event) {
          apply(null);
          throw new JobInterruptedError();
        }
        await notifier.logged(ref, event);
      },
    };

    let outcome: RunOutcome;
    try {
      const params = definition.parseParams(job.params);
      await definition.run({ ...context, params });
      outcome = { kind: 'succeeded' };
    } catch (error) {
      if (balanceExhausted && !lost) {
        outcome = { kind: 'insufficient-balance' };
      } else if (controller.signal.aborted || error instanceof JobInterruptedError) {
        outcome = { kind: 'interrupted' };
      } else if (error instanceof JobError) {
        outcome = { kind: 'failed', code: error.code, message: error.message };
      } else {
        log.error({ err: error, jobId: job.id, jobType: job.type }, 'job failed');
        outcome = { kind: 'failed', code: 'JOB_FAILED', message: '任务执行失败' };
      }
    } finally {
      clearInterval(heartbeat);
      if (checks.get(job.id) === renew) checks.delete(job.id);
    }

    if (lost) {
      log.warn({ jobId: job.id, jobType: job.type }, 'job lease lost, result discarded');
      return;
    }
    const status = await finishWithRetry(run, outcome, definition.resumable);
    if (status === null) {
      log.warn({ jobId: job.id, jobType: job.type }, 'job lease lost before finishing, result discarded');
      return;
    }
    log.info({ jobId: job.id, jobType: job.type, status, attempt: job.attempt }, 'job run finished');
    await notifier.changedById(job.orgId, job.id);
    if (status === 'queued' && !closing) {
      await dispatcher
        .dispatch({ id: job.id, orgId: job.orgId, type: job.type, queue: definition.queue })
        .catch((error: unknown) => log.warn({ err: error, jobId: job.id }, 'job redispatch failed, left for reconcile'));
    }
  }

  async function processDispatch(bullJob: Job<DispatchPayload>, token?: string): Promise<void> {
    const jobId = bullJob.id;
    const orgId = bullJob.data?.orgId;
    // 派发数据只用于设置认领事务的组织上下文；对不上的（伪造或错误）在 RLS 下查不到任务，按不存在处理。
    if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId) || typeof orgId !== 'string' || !UUID_PATTERN.test(orgId)) return;
    if (closing) throw new Error('worker is closing');
    const runId = randomUUID();
    const claim = await claimJob(db, {
      orgId,
      jobId,
      runId,
      leaseMs,
      orgRunningLimit,
      attemptsFor: (type) => {
        const definition = registry.get(type);
        return definition ? maxAttemptsOf(definition) : null;
      },
    });
    if (claim.kind === 'deferred') {
      await bullJob.moveToDelayed(Date.now() + deferDelayMs, token);
      throw new DelayedError();
    }
    if (claim.kind === 'skipped') {
      if (claim.reason === 'failed') await notifier.changedById(orgId, jobId);
      return;
    }
    await notifier.changed(claim.job);

    const controller = new AbortController();
    const done = execute(claim.job, claim.role, runId, controller);
    active.set(runId, { controller, done: done.then(() => {}, () => {}) });
    try {
      await done;
    } finally {
      active.delete(runId);
    }
  }

  async function reconcileOnce(): Promise<ReconcileResult> {
    const result: ReconcileResult = { dispatched: 0, failed: 0 };
    let after: { cursor: string; id: string } | null = null;
    for (;;) {
      const candidates = await listDispatchCandidates(db, after);
      for (const candidate of candidates) {
        try {
          const recovered = await recoverJob(db, candidate, (type) => registry.get(type)?.resumable ?? null);
          if (recovered.changed) await notifier.changedById(candidate.orgId, candidate.id);
          if (recovered.kind !== 'dispatch') continue;
          const definition = registry.get(recovered.type);
          if (!definition) continue;
          await dispatcher.dispatch({ id: candidate.id, orgId: candidate.orgId, type: recovered.type, queue: definition.queue });
          result.dispatched += 1;
        } catch (error) {
          result.failed += 1;
          log.warn({ err: error, jobId: candidate.id }, 'job reconcile failed');
        }
      }
      const last = candidates.at(-1);
      if (!last || candidates.length < JOB_DISPATCH_BATCH_MAX) break;
      after = { cursor: last.cursor, id: last.id };
    }
    if (result.dispatched > 0 || result.failed > 0) log.info(result, 'jobs reconciled');
    return result;
  }

  function reconcile(): Promise<ReconcileResult> {
    reconciling ??= reconcileOnce().finally(() => {
      reconciling = null;
    });
    return reconciling;
  }

  function reconcileInBackground() {
    if (closing) return;
    reconcile().catch((error: unknown) => log.warn({ err: error }, 'jobs reconcile failed'));
  }

  /** 哨兵键不在了（首次启动、Redis 重启或被清空）时写入并对账。 */
  async function checkSentinel(): Promise<void> {
    if (closing || !monitor) return;
    const created = await monitor.set(sentinelKey, String(Date.now()), 'NX');
    if (created !== 'OK') return;
    log.warn('job queue state missing in redis (restart or flush), reconciling from database');
    let complete = false;
    try {
      complete = (await reconcile()).failed === 0;
    } finally {
      // 对账没有全部成功（例如派发用的连接还没重新连上）：删掉哨兵，下一次检查再来一遍。
      if (!complete) await monitor?.del(sentinelKey).catch(() => {});
    }
  }

  function checkSentinelInBackground() {
    checkSentinel().catch((error: unknown) => log.warn({ err: error }, 'job queue redis check failed'));
  }

  return {
    async start() {
      for (const name of queueNames) {
        const worker = new Worker<DispatchPayload>(name, processDispatch, {
          connection: options.connection,
          prefix,
          concurrency: options.concurrency?.[name] ?? DEFAULT_QUEUE_CONCURRENCY[name],
          // 失败与续跑由 jobs 的状态机决定，BullMQ 不保留已完成、已失败的任务。
          removeOnComplete: { count: 0 },
          removeOnFail: { count: 0 },
          autorun: false,
        });
        worker.on('error', (error) => log.warn({ err: error, queue: name }, 'job queue error'));
        workers.push(worker);
        void worker.run().catch((error: unknown) => log.error({ err: error, queue: name }, 'job queue consumer stopped'));
      }
      await Promise.all(workers.map((worker) => worker.waitUntilReady()));
      // 哨兵检查用单独的连接，未连接时命令立即失败（不排队），Redis 不可用期间不会堆积检查。
      monitor = new Redis({
        ...options.connection,
        connectionName: `${options.connection.connectionName ?? 'worker'}-monitor`,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: 2_000,
        lazyConnect: true,
      });
      monitor.on('error', (error: Error) => log.warn({ err: error }, 'job queue monitor connection error'));
      await monitor.connect();
      // 启动时总要对账一次（下面），先写入哨兵，避免把首次启动当成数据丢失。
      await monitor.set(sentinelKey, String(Date.now()));
      // 之后每次重新连上都检查：Redis 重启后数据全部丢失。
      monitor.on('ready', checkSentinelInBackground);
      // 控制频道：断线重连后自动重新订阅；错过的消息不影响正确性，最迟在下一次续租时发现请求。
      control = new Redis({
        ...options.connection,
        connectionName: `${options.connection.connectionName ?? 'worker'}-control`,
        lazyConnect: true,
      });
      control.on('error', (error: Error) => log.warn({ err: error }, 'job control connection error'));
      control.on('message', (_channel: string, message: string) => checks.get(message)?.());
      await control.connect();
      await control.subscribe(jobControlChannel(prefix));
      await reconcile().catch((error: unknown) => log.warn({ err: error }, 'jobs reconcile failed'));
      reconcileTimer = setInterval(reconcileInBackground, reconcileIntervalMs);
      reconcileTimer.unref();
      sentinelTimer = setInterval(checkSentinelInBackground, redisCheckIntervalMs);
      sentinelTimer.unref();
    },
    reconcile,
    async close() {
      closing = true;
      clearInterval(reconcileTimer);
      clearInterval(sentinelTimer);
      for (const entry of active.values()) entry.controller.abort('shutdown');
      await Promise.all([...active.values()].map((entry) => entry.done));
      await Promise.all(workers.map((worker) => worker.close()));
      await reconciling?.catch(() => {});
      if (monitor) {
        monitor.disconnect();
        monitor = null;
      }
      if (control) {
        control.disconnect();
        control = null;
      }
    },
  };
}
