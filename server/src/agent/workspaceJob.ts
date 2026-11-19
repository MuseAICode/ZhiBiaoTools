// Agent 任务的工作区快照接入续跑（路线图第 8 步 8.5c；docs/SERVER_DESIGN.md 第 7.21 节）。
//
// 任务类型登记 agentWorkspace（任务类别）后，执行者给任务的上下文提供 context.agentWorkspace（src/jobs/runner.ts）：
// - saveCheckpoint(sandbox, checkpoint, progress?)：先把沙箱的 /workspace 保存为快照（8.5b 的 saveWorkspaceSnapshot），成功后再保存
//   checkpoint。快照保存失败时 checkpoint 不前进，旧快照原样保留，二者仍是上一个检查点的一对：
//   - 超出组织存储配额：抛 JobStorageQuotaError，执行者把任务暂停为 storage_quota（迁移 0041），用户删除文件后经普通的“继续”续跑；
//   - 工作区不符合快照规则（SANDBOX_OUTPUT_REJECTED）：任务以 AGENT_WORKSPACE_REJECTED 失败，失败说明写明是哪一类规则不符
//     （文件类型、链接或特殊文件、命名、数量或大小、归档格式），不含文件名与内容；不自动改名、不跳过不合规的文件（#88 确认时）；
//   - 工作区超过快照的大小上限（AGENT_WORKSPACE_TOO_LARGE）：任务以同一代码失败；
// - restore(sandbox)：把该项目、该类任务当前的快照放入刚创建的沙箱；没有时返回 null。快照不可用（SANDBOX_INPUT_FAILED：对象缺失、
//   大小或 SHA-256 不符、内容不符合规则、文件数不符；沙箱已被销毁）时丢弃这个快照，任务以 AGENT_WORKSPACE_RESTORE_FAILED 失败，
//   不自动从头开始（从头开始会重新调用模型、重新扣费，由用户决定是否重新发起）；
// - 任务成功完成后执行者丢弃快照（登记 keepAfterSuccess 的除外），用户重置该类任务时调用 discardAgentWorkspaceSnapshots。
// 组织、用户与项目一律来自任务记录（不接受 Agent 传入）。本模块不写日志。
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { JobError, JobStorageQuotaError } from '../jobs/definitions.ts';
import { SandboxArchiveError } from '../sandbox/archive.ts';
import { SandboxError, type SandboxDriver, type SandboxRef } from '../sandbox/driver.ts';
import { restoreWorkspaceSnapshot, saveWorkspaceSnapshot, type WorkspaceSandboxDriver } from './workspaceSandbox.ts';
import { discardWorkspaceSnapshot, type WorkspaceSnapshotRecord } from './workspaceSnapshots.ts';

export const AGENT_WORKSPACE_REJECTED_CODE = 'AGENT_WORKSPACE_REJECTED';
export const AGENT_WORKSPACE_TOO_LARGE_CODE = 'AGENT_WORKSPACE_TOO_LARGE';
export const AGENT_WORKSPACE_RESTORE_FAILED_CODE = 'AGENT_WORKSPACE_RESTORE_FAILED';

/** 工作区不符合快照规则的类别（失败说明只写类别，不含文件名与内容）。 */
export type AgentWorkspaceRejectionCategory = 'file-type' | 'special-file' | 'naming' | 'size' | 'format';

const REJECTION_MESSAGES: Readonly<Record<AgentWorkspaceRejectionCategory, string>> = {
  'file-type': '工作区中有不允许保存的文件类型',
  'special-file': '工作区中有链接、设备等特殊文件（只能保存普通文件）',
  naming: '工作区中有不符合命名规则的文件名或目录（例如含空格、以 . 开头、重名或层级过深）',
  size: '工作区中的文件数量或大小超过上限',
  format: '工作区的归档格式不正确',
};

const NAMING_REASONS: ReadonlySet<string> = new Set([
  'absolute path',
  'duplicate path',
  'empty path',
  'file path ends with a slash',
  'path conflict',
  'path encoding invalid',
  'path not normalized',
  'path segment not allowed',
  'path too deep',
  'path too long',
  'path traversal',
]);
const SPECIAL_FILE_REASONS: ReadonlySet<string> = new Set([
  'hard link not allowed',
  'symbolic link not allowed',
  'device file not allowed',
  'fifo not allowed',
  'entry type not allowed',
]);
const SIZE_REASONS: ReadonlySet<string> = new Set(['too many files', 'too many entries', 'file too large', 'archive too large']);

/** 取回被拒绝的原因（SandboxArchiveError 的 reason）归到给用户看的类别；认不出的归为归档格式。 */
export function agentWorkspaceRejectionCategory(reason: string | null): AgentWorkspaceRejectionCategory {
  if (reason === 'file extension not allowed') return 'file-type';
  if (reason !== null && SPECIAL_FILE_REASONS.has(reason)) return 'special-file';
  if (reason !== null && NAMING_REASONS.has(reason)) return 'naming';
  if (reason !== null && SIZE_REASONS.has(reason)) return 'size';
  return 'format';
}

export function agentWorkspaceRejectedMessage(category: AgentWorkspaceRejectionCategory): string {
  return `无法保存 Agent 的工作区：${REJECTION_MESSAGES[category]}，任务已停止。平台不会代为改名或跳过文件，请重新发起任务`;
}

const TOO_LARGE_MESSAGE = '无法保存 Agent 的工作区：工作区超过快照的大小上限，任务已停止';
const RESTORE_FAILED_MESSAGE = '上次保存的 Agent 工作区不可用，已丢弃，请重新发起任务';

function archiveReason(error: SandboxError): string | null {
  return error.cause instanceof SandboxArchiveError ? error.cause.reason : null;
}

/** 任务上下文中的工作区（context.agentWorkspace）。 */
export interface JobAgentWorkspace {
  /** 任务类别（任务类型登记的 agentWorkspace.taskKind）。 */
  readonly taskKind: string;
  /**
   * 把当前的快照放入刚创建、尚未放入其他文件的 agent 沙箱；没有快照时返回 null、沙箱不变。快照不可用时沙箱已被销毁、快照被丢弃，
   * 抛 JobError(AGENT_WORKSPACE_RESTORE_FAILED)。
   */
  restore(sandbox: SandboxRef): Promise<WorkspaceSnapshotRecord | null>;
  /**
   * 检查点：先保存工作区快照（替换当前的），成功后再保存 checkpoint（同 context.saveCheckpoint）。checkpoint 可以是函数：取刚保存的
   * 快照生成 checkpoint（8.7b：执行者把快照 id 写进现场，跨任务续用时据此确认快照与会话是同一对）。超出组织存储配额抛
   * JobStorageQuotaError（任务应立即退出，执行者暂停为 storage_quota）；工作区不符合规则或过大抛 JobError（任务失败）；
   * 这些情况下 checkpoint 不前进、旧快照保留。沙箱保存后仍可继续使用。
   */
  saveCheckpoint(
    sandbox: SandboxRef,
    checkpoint: Record<string, unknown> | ((snapshot: WorkspaceSnapshotRecord) => Record<string, unknown>),
    progress?: number,
  ): Promise<WorkspaceSnapshotRecord>;
}

export interface JobAgentWorkspaceOptions {
  db: Kysely<Database>;
  store: ObjectStore;
  driver: WorkspaceSandboxDriver;
  tenant: TenantContext;
  projectId: string;
  taskKind: string;
  signal: AbortSignal;
  /** 任务上下文的 saveCheckpoint。 */
  saveCheckpoint(checkpoint: Record<string, unknown>, progress?: number): Promise<void>;
  /** 超出存储配额时调用（执行者据此暂停，任务吞掉了 JobStorageQuotaError 也照样暂停）。 */
  onStorageQuotaExceeded(): void;
}

/** driver 是否能整体放入与取回归档（worker 中的 sandbox-runner 客户端可以；解析任务用的测试桩可能不行）。 */
export function isWorkspaceSandboxDriver(driver: SandboxDriver | null | undefined): driver is WorkspaceSandboxDriver {
  const candidate = driver as Partial<WorkspaceSandboxDriver> | null | undefined;
  return typeof candidate?.copyInArchive === 'function' && typeof candidate.copyOutArchive === 'function';
}

export function createJobAgentWorkspace(options: JobAgentWorkspaceOptions): JobAgentWorkspace {
  const deps = { db: options.db, store: options.store, driver: options.driver };
  const target = { projectId: options.projectId, taskKind: options.taskKind };
  let storageQuotaExceeded = false;
  return Object.freeze({
    taskKind: options.taskKind,
    async restore(sandbox: SandboxRef) {
      try {
        return await restoreWorkspaceSnapshot(deps, options.tenant, sandbox, target, { signal: options.signal });
      } catch (error) {
        if (error instanceof SandboxError && error.code === 'SANDBOX_INPUT_FAILED') {
          // 丢弃失败时（例如数据库暂时不可用）快照仍是当前的，下次放入同样失败、同样失败结束，不会被当成可用的。
          await discardWorkspaceSnapshot(options.db, options.tenant, options.store, target).catch(() => false);
          throw new JobError(AGENT_WORKSPACE_RESTORE_FAILED_CODE, RESTORE_FAILED_MESSAGE, { cause: error });
        }
        throw error;
      }
    },
    async saveCheckpoint(sandbox: SandboxRef, checkpoint: Record<string, unknown> | ((snapshot: WorkspaceSnapshotRecord) => Record<string, unknown>), progress?: number) {
      // 已超出配额：之后的检查点不再保存（任务应已退出），checkpoint 不前进。
      if (storageQuotaExceeded) throw new JobStorageQuotaError();
      let record: WorkspaceSnapshotRecord;
      try {
        record = await saveWorkspaceSnapshot(deps, options.tenant, sandbox, target, { signal: options.signal });
      } catch (error) {
        if (error instanceof AppError && error.code === 'STORAGE_QUOTA_EXCEEDED') {
          storageQuotaExceeded = true;
          options.onStorageQuotaExceeded();
          throw new JobStorageQuotaError({ cause: error });
        }
        if (error instanceof AppError && error.code === AGENT_WORKSPACE_TOO_LARGE_CODE) {
          throw new JobError(AGENT_WORKSPACE_TOO_LARGE_CODE, TOO_LARGE_MESSAGE, { cause: error });
        }
        if (error instanceof SandboxError && error.code === 'SANDBOX_OUTPUT_REJECTED') {
          const category = agentWorkspaceRejectionCategory(archiveReason(error));
          throw new JobError(AGENT_WORKSPACE_REJECTED_CODE, agentWorkspaceRejectedMessage(category), { cause: error });
        }
        throw error;
      }
      await options.saveCheckpoint(typeof checkpoint === 'function' ? checkpoint(record) : checkpoint, progress);
      return record;
    },
  });
}

/**
 * 用户重置某类任务时丢弃这些任务类别的快照（8.7 起各业务的重置入口调用）。组织与用户来自请求的 TenantContext，项目须已经
 * requireProject 校验；返回被丢弃的类别。对象删除失败的、store 为 null（api 未配置对象存储）时的对象，留给清理任务。
 */
export async function discardAgentWorkspaceSnapshots(
  db: Kysely<Database>,
  context: TenantContext,
  store: ObjectStore | null,
  projectId: string,
  taskKinds: readonly string[],
): Promise<string[]> {
  const discarded: string[] = [];
  for (const taskKind of new Set(taskKinds)) {
    if (await discardWorkspaceSnapshot(db, context, store, { projectId, taskKind })) discarded.push(taskKind);
  }
  return discarded;
}
