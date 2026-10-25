// BullMQ 生产者（docs/SERVER_DESIGN.md 第 5 节）：只负责把 jobs 中 queued 的任务派发给 worker，不保存任何任务状态。
//
// - BullMQ 任务 id 就是 jobs.id：同一任务已在 Redis 中（等待、延迟、执行中）时再次放入是空操作，所以对账可以反复放入；
// - 任务数据只有 orgId（用来设置认领事务的组织上下文），参数、用户、类型都从 jobs 读取；
// - 不让 BullMQ 重试（attempts = 1），完成或失败后立即删除，失败与续跑由 jobs 的状态机决定；
//   删除后同一 id 可以再次放入，对账把回到 queued 的任务重新派发。
import { Queue, type ConnectionOptions } from 'bullmq';
import { JOB_QUEUES, type JobQueueName } from './definitions.ts';

export interface DispatchPayload {
  orgId: string;
}

export interface JobDispatcher {
  /** 放进对应队列；已在队列中时不重复放入。Redis 不可用时抛错，任务仍在 jobs 中，由对账重新放入。 */
  dispatch(job: { id: string; orgId: string; type: string; queue: JobQueueName }): Promise<void>;
  close(): Promise<void>;
}

export interface DispatcherOptions {
  connection: ConnectionOptions;
  /** BullMQ 键前缀，测试中每个文件用不同的前缀互不干扰。 */
  prefix?: string;
}

export const DEFAULT_QUEUE_PREFIX = 'bull';

export const DISPATCH_JOB_OPTIONS = Object.freeze({ attempts: 1, removeOnComplete: true, removeOnFail: true });

export function createJobDispatcher(options: DispatcherOptions): JobDispatcher {
  const prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
  const queues = new Map<JobQueueName, Queue<DispatchPayload>>();
  function queueFor(name: JobQueueName): Queue<DispatchPayload> {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue<DispatchPayload>(name, { connection: options.connection, prefix });
      // 连接错误由调用方在 dispatch 失败时处理；不监听时 ioredis 会打印到 stderr。
      queue.on('error', () => {});
      queues.set(name, queue);
    }
    return queue;
  }
  return {
    async dispatch(job) {
      if (!(JOB_QUEUES as readonly string[]).includes(job.queue)) throw new TypeError('队列不合法');
      await queueFor(job.queue).add(job.type, { orgId: job.orgId }, { ...DISPATCH_JOB_OPTIONS, jobId: job.id });
    },
    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      queues.clear();
    },
  };
}
