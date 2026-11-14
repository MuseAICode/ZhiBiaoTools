// 清理任务（路线图第 6 步 6.8，决定事项第 9、10 项）：worker 每小时跨组织执行一批。
//
// - 过期条件全部在数据库中（迁移 0024_cleanup 的 SECURITY DEFINER 函数，属主 bidtools_cleanup，对计费表没有任何权限）：
//   这里只拿到候选行的 id 和对象键，不传时间、保留期或组织；
// - 先删对象、确认成功（或对象已不存在）后再删行；对象删除失败的行保留，下一批重试，不会出现“行已删、对象还在”；
// - 孤儿对象：按前缀 org/ 分页列出，只考虑修改时间超过 7 天的、形如 org/{org}/files|artifacts/{id} 且数据库中没有对应行的键，
//   每批从上次停下的位置继续，到末尾后从头开始（0040 起也包括 org/{org}/agent-workspaces/{id}）；
// - 模板样张（迁移 0027）：样张产物与其他产物同一路径（过期条件加上“创建超过 24 小时”），样张请求没有对象，24 小时后删行；
// - Agent 工作区快照（迁移 0040）：与产物同一路径（先删对象、再删行，遗留的写入计入 uploading 类），在项目之前删除；
// - 冻结到期收尾（ai_usage_expire_holds，属主 bidtools_billing）以应用角色调用，不经清理角色（原来在 api 的定时器中）；
// - 每批按类别各记一行结构化日志：删除条数、对象数、失败数和耗时，不含对象键、文件名和内容。
// 多个 worker 同时执行是安全的：删行的函数会重新检查条件，删除已不存在的对象不报错，只会多做一次。
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { expireStaleHolds } from '../billing/usage.ts';
import { CLEANUP_BATCH_MAX, SUPERSEDED_ARTIFACT_DAYS } from '../db/migrations/0024_cleanup.ts';
import type { Database } from '../db/schema.ts';
import type { ObjectLister, ObjectStore } from '../files/objectStore.ts';

export const CLEANUP_CATEGORIES = [
  'holds', 'artifacts', 'files', 'uploading', 'agent_workspaces', 'projects', 'orphans', 'jobs', 'job_events', 'template_preview_requests',
] as const;
export type CleanupCategory = (typeof CLEANUP_CATEGORIES)[number];

/** 每小时一批（决定事项第 9 项）。 */
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** worker 启动后第一批的延迟：不和启动时的对账挤在一起。 */
export const CLEANUP_INITIAL_DELAY_MS = 60 * 1000;
/** 孤儿对象的最短存在时间，与恢复期相同：更新的对象可能属于还没登记完的写入。 */
export const ORPHAN_MIN_AGE_MS = SUPERSEDED_ARTIFACT_DAYS * 24 * 60 * 60 * 1000;
/** 每批最多列出的对象数。 */
export const ORPHAN_SCAN_MAX = 10_000;
const ORPHAN_PREFIX = 'org/';

export interface CleanupCategoryResult {
  category: CleanupCategory;
  /** 删除（冻结为收尾）的行数；孤儿对象为删除的对象数。 */
  deleted: number;
  /** 删除的对象数。 */
  objects: number;
  /** 失败数：对象删除失败而保留的行、删除失败的孤儿对象；整类出错时为 1。 */
  failed: number;
  durationMs: number;
  /** 本类没有执行（未配置对象存储）。 */
  skipped?: true;
}

export type CleanupLog = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface CleanerOptions {
  db: Kysely<Database>;
  /** 未配置对象存储时为 null：有对象的行一律不删（不能留下孤儿对象），只清理项目、任务记录和冻结。 */
  objectStore: (ObjectStore & ObjectLister) | null;
  log: CleanupLog;
  /** 每类每批最多处理的行数，默认（也是上限）1000。 */
  batchSize?: number;
  /** 每批最多列出的对象数，默认 10000。 */
  orphanScanMax?: number;
  /** 当前时间（测试用）：只用于判断孤儿对象的修改时间，行的过期条件只在数据库中判断。 */
  now?: () => number;
}

export interface Cleaner {
  /** 执行一批；signal 中止时在下一项之前停止。返回各类的结果（已写日志）。 */
  runBatch(signal?: AbortSignal): Promise<CleanupCategoryResult[]>;
}

interface Candidate {
  id: string;
  storage_key: string;
  stale: boolean;
}

function counter(category: CleanupCategory) {
  const started = performance.now();
  return {
    category,
    deleted: 0,
    objects: 0,
    failed: 0,
    finish(extra: { skipped?: true } = {}): CleanupCategoryResult {
      return {
        category,
        deleted: this.deleted,
        objects: this.objects,
        failed: this.failed,
        durationMs: Math.round(performance.now() - started),
        ...extra,
      };
    },
  };
}

export function createCleaner(options: CleanerOptions): Cleaner {
  const { db, objectStore, log } = options;
  const batchSize = Math.min(Math.max(options.batchSize ?? CLEANUP_BATCH_MAX, 1), CLEANUP_BATCH_MAX);
  const orphanScanMax = options.orphanScanMax ?? ORPHAN_SCAN_MAX;
  const now = options.now ?? Date.now;
  let orphanCursor: string | undefined;

  // 有对象的行：先删对象，成功后再删行；stale（遗留的上传 / 写入）记到 uploading 类。
  async function purge(
    candidates: Candidate[],
    remove: (id: string) => Promise<boolean>,
    expired: ReturnType<typeof counter>,
    uploading: ReturnType<typeof counter>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const candidate of candidates) {
      if (signal?.aborted) return;
      const target = candidate.stale ? uploading : expired;
      try {
        await objectStore!.delete(candidate.storage_key);
      } catch {
        target.failed += 1;
        continue;
      }
      target.objects += 1;
      if (await remove(candidate.id)) target.deleted += 1;
      else target.failed += 1;
    }
  }

  async function artifactsAndFiles(signal?: AbortSignal): Promise<CleanupCategoryResult[]> {
    const artifacts = counter('artifacts');
    const files = counter('files');
    const uploading = counter('uploading');
    const workspaces = counter('agent_workspaces');
    if (!objectStore) {
      return [
        artifacts.finish({ skipped: true }), files.finish({ skipped: true }), uploading.finish({ skipped: true }), workspaces.finish({ skipped: true }),
      ];
    }
    // 产物先于文件：来源文件的产物删完，文件才成为候选。
    const artifactCandidates = await sql<Candidate>`SELECT * FROM cleanup_artifact_candidates(${batchSize})`.execute(db);
    await purge(
      artifactCandidates.rows,
      async (id) => (await sql<{ ok: boolean }>`SELECT cleanup_delete_artifact(${id}::uuid) AS ok`.execute(db)).rows[0]!.ok,
      artifacts,
      uploading,
      signal,
    );
    if (!signal?.aborted) {
      const fileCandidates = await sql<Candidate>`SELECT * FROM cleanup_file_candidates(${batchSize})`.execute(db);
      await purge(
        fileCandidates.rows,
        async (id) => (await sql<{ ok: boolean }>`SELECT cleanup_delete_file(${id}::uuid) AS ok`.execute(db)).rows[0]!.ok,
        files,
        uploading,
        signal,
      );
    }
    // 快照只挂在项目下，与产物、文件互不依赖；项目要等它删完才能删除（cleanup_delete_projects 在之后执行）。
    if (!signal?.aborted) {
      const snapshotCandidates = await sql<Candidate>`SELECT * FROM cleanup_agent_workspace_candidates(${batchSize})`.execute(db);
      await purge(
        snapshotCandidates.rows,
        async (id) => (await sql<{ ok: boolean }>`SELECT cleanup_delete_agent_workspace(${id}::uuid) AS ok`.execute(db)).rows[0]!.ok,
        workspaces,
        uploading,
        signal,
      );
    }
    return [artifacts.finish(), files.finish(), uploading.finish(), workspaces.finish()];
  }

  async function count(category: CleanupCategory, statement: () => Promise<number>): Promise<CleanupCategoryResult> {
    const result = counter(category);
    result.deleted = await statement();
    return result.finish();
  }

  async function orphans(signal?: AbortSignal): Promise<CleanupCategoryResult> {
    const result = counter('orphans');
    if (!objectStore) return result.finish({ skipped: true });
    const cutoff = now() - ORPHAN_MIN_AGE_MS;
    let scanned = 0;
    while (scanned < orphanScanMax && !signal?.aborted) {
      const page = await objectStore.list({
        prefix: ORPHAN_PREFIX,
        maxKeys: Math.min(CLEANUP_BATCH_MAX, orphanScanMax - scanned),
        ...(orphanCursor ? { startAfter: orphanCursor } : {}),
      });
      scanned += page.objects.length;
      const old = page.objects.filter((object) => object.lastModified.getTime() <= cutoff).map((object) => object.key);
      if (old.length > 0) {
        const unreferenced = await sql<{ key: string }>`SELECT cleanup_unreferenced_keys(${old}::text[]) AS key`.execute(db);
        for (const { key } of unreferenced.rows) {
          if (signal?.aborted) break;
          try {
            await objectStore.delete(key);
            result.objects += 1;
            result.deleted += 1;
          } catch {
            result.failed += 1;
          }
        }
      }
      orphanCursor = page.truncated ? page.objects.at(-1)?.key : undefined;
      if (!orphanCursor) break;
    }
    return result.finish();
  }

  // 一类出错不影响其他类；出错的类同样记一行（failed = 1）。
  async function guarded(categories: CleanupCategory[], task: () => Promise<CleanupCategoryResult | CleanupCategoryResult[]>) {
    const started = performance.now();
    try {
      const value = await task();
      return Array.isArray(value) ? value : [value];
    } catch (error) {
      // 错误只记名称和代码：S3 / 数据库的错误消息可能带对象键。
      const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
      log.warn({ categories, error: { name, code } }, 'cleanup category failed');
      const durationMs = Math.round(performance.now() - started);
      return categories.map((category) => ({ category, deleted: 0, objects: 0, failed: 1, durationMs }));
    }
  }

  return {
    async runBatch(signal) {
      const results: CleanupCategoryResult[] = [];
      const steps: [CleanupCategory[], () => Promise<CleanupCategoryResult | CleanupCategoryResult[]>][] = [
        [['holds'], () => count('holds', () => expireStaleHolds(db))],
        [['artifacts', 'files', 'uploading', 'agent_workspaces'], () => artifactsAndFiles(signal)],
        [['projects'], () => count('projects', async () =>
          (await sql<{ n: number }>`SELECT cleanup_delete_projects(${batchSize}) AS n`.execute(db)).rows[0]!.n)],
        [['orphans'], () => orphans(signal)],
        [['jobs'], () => count('jobs', async () =>
          (await sql<{ n: number }>`SELECT cleanup_delete_jobs(${batchSize}) AS n`.execute(db)).rows[0]!.n)],
        [['job_events'], () => count('job_events', async () =>
          (await sql<{ n: number }>`SELECT cleanup_delete_job_events(${batchSize}) AS n`.execute(db)).rows[0]!.n)],
        [['template_preview_requests'], () => count('template_preview_requests', async () =>
          (await sql<{ n: number }>`SELECT cleanup_delete_template_preview_requests(${batchSize}) AS n`.execute(db)).rows[0]!.n)],
      ];
      for (const [categories, task] of steps) {
        if (signal?.aborted) break;
        results.push(...(await guarded(categories, task)));
      }
      for (const result of results) log.info({ cleanup: result }, 'cleanup batch');
      return results;
    },
  };
}

export interface CleanupSchedule {
  /** 停止定时器；正在执行的一批在下一项之前停止，等它结束后返回。 */
  close(): Promise<void>;
}

/** 在 worker 中定时执行：启动后 initialDelayMs 执行第一批，之后每 intervalMs 一批（上一批结束后才计时）。 */
export function startCleanupSchedule(
  cleaner: Cleaner,
  options: { intervalMs?: number; initialDelayMs?: number; log: CleanupLog },
): CleanupSchedule {
  const intervalMs = options.intervalMs ?? CLEANUP_INTERVAL_MS;
  const controller = new AbortController();
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  function schedule(delay: number) {
    timer = setTimeout(() => {
      running = cleaner
        .runBatch(controller.signal)
        .then(
          () => undefined,
          (error: unknown) => options.log.warn({ err: error }, 'cleanup batch failed'),
        )
        .finally(() => {
          running = null;
          if (!controller.signal.aborted) schedule(intervalMs);
        });
    }, delay);
    timer.unref();
  }

  schedule(options.initialDelayMs ?? CLEANUP_INITIAL_DELAY_MS);
  return {
    async close() {
      controller.abort();
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
