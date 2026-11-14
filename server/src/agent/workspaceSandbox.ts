// Agent 工作区快照的取回与放入（路线图第 8 步 8.5b；docs/SERVER_DESIGN.md 第 7.20 节）。
//
// 快照是 agent 沙箱整个 /workspace 的 tar 归档（中间文件与 Pi 会话文件都在其中，会话文件的位置由 8.6 的入口固定在 /workspace 内）。
// 沙箱内的一切都按攻击者的数据处理，归档的内容校验两次：
// - 取回（saveWorkspaceSnapshot）：driver 按模板的取回规则（src/sandbox/templates.ts 的 AGENT_WORKSPACE：只收普通文件、
//   中文路径段规则、扩展名白名单、文件数 ≤ 10,000、合计 ≤ 512 MiB）逐项校验，只用通过校验的普通文件重新生成归档（不带扩展头），
//   边取回边写入对象存储（src/agent/workspaceSnapshots.ts），不在内存或磁盘中缓存整个归档；任何一项不符整体拒绝，
//   写到一半的对象与登记行被删除，旧快照原样保留；
// - 放入（restoreWorkspaceSnapshot）：对象存储中的内容同样不可信，取回时核对大小与 SHA-256，并按同一份取回规则（含扩展名白名单，
//   比模板的放入规则更严）逐项校验、重新生成后才放入新沙箱；文件数须与写入时记下的相同。核对或校验出错时之前的条目可能已放入，
//   整个沙箱被销毁。
// 组织、用户与项目一律来自调用方（任务的 TenantContext 与任务令牌中的项目），不接受 Agent 传入。本模块不写日志。
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { rewriteArchiveStream, SandboxArchiveError } from '../sandbox/archive.ts';
import { SandboxError, type SandboxArchiveTransfer, type SandboxDriver, type SandboxRef } from '../sandbox/driver.ts';
import { SANDBOX_TEMPLATES, type SandboxTemplateName } from '../sandbox/templates.ts';
import {
  openWorkspaceSnapshot,
  WorkspaceSnapshotIntegrityError,
  writeWorkspaceSnapshot,
  type WorkspaceSnapshotRecord,
  type WorkspaceSnapshotTarget,
} from './workspaceSnapshots.ts';

/** 能整体放入与取回归档的 driver（worker 中为 createSandboxRunnerClient）。 */
export type WorkspaceSandboxDriver = SandboxDriver & SandboxArchiveTransfer;

export interface WorkspaceSandboxDeps {
  db: Kysely<Database>;
  store: ObjectStore;
  driver: WorkspaceSandboxDriver;
}

const AGENT_TEMPLATES: ReadonlySet<SandboxTemplateName> = new Set(['agent', 'agent-content']);

/** 只有 agent 沙箱有工作区快照；其他模板是调用方的程序错误。 */
function assertAgentSandbox(sandbox: SandboxRef): void {
  if (!AGENT_TEMPLATES.has(sandbox.template)) throw new TypeError('只有 agent 沙箱有工作区快照');
}

export interface WorkspaceSandboxOptions {
  /** 任务取消、暂停或 worker 关闭时中止。 */
  signal?: AbortSignal;
}

/**
 * 取回沙箱的 /workspace 并保存为该项目、该类任务的快照（替换当前的）。沙箱仍可继续使用。
 * 归档不符合规则时抛 SandboxError('SANDBOX_OUTPUT_REJECTED')（cause 为 SandboxArchiveError）；超出组织配额 413 STORAGE_QUOTA_EXCEEDED
 * （8.5c 据此暂停任务）；其他沙箱错误按 driver 的错误码。任何失败都不留下新快照，旧快照原样保留。
 */
export async function saveWorkspaceSnapshot(
  deps: WorkspaceSandboxDeps,
  context: TenantContext,
  sandbox: SandboxRef,
  target: WorkspaceSnapshotTarget,
  options: WorkspaceSandboxOptions = {},
): Promise<WorkspaceSnapshotRecord> {
  assertAgentSandbox(sandbox);
  const signal = options.signal ? { signal: options.signal } : {};
  const archive = await deps.driver.copyOutArchive(sandbox, signal);
  return writeWorkspaceSnapshot(deps.db, context, deps.store, { ...target, fileCount: () => archive.fileCount }, archive.chunks, signal);
}

/**
 * 把该项目、该类任务当前的快照放入沙箱的 /workspace（只用于刚创建、尚未放入其他文件的沙箱）。没有快照时返回 null，沙箱不变。
 * 快照不可用（对象缺失、大小或 SHA-256 不符、内容不符合取回规则、文件数与记录不符）时销毁沙箱，抛
 * SandboxError('SANDBOX_INPUT_FAILED')，cause 为 WorkspaceSnapshotIntegrityError 或 SandboxArchiveError（8.5c 据此决定是否丢弃快照、
 * 从头开始）；放入本身失败时同样销毁沙箱，按 driver 的错误码抛出。
 */
export async function restoreWorkspaceSnapshot(
  deps: WorkspaceSandboxDeps,
  context: TenantContext,
  sandbox: SandboxRef,
  target: WorkspaceSnapshotTarget,
  options: WorkspaceSandboxOptions = {},
): Promise<WorkspaceSnapshotRecord | null> {
  assertAgentSandbox(sandbox);
  const signal = options.signal ? { signal: options.signal } : {};
  let failure: unknown;
  try {
    const opened = await openWorkspaceSnapshot(deps.db, context, deps.store, target);
    if (!opened) return null;
    const rewritten = rewriteArchiveStream(opened.chunks, SANDBOX_TEMPLATES[sandbox.template].output, { expectedFileCount: opened.record.fileCount });
    // 记下来自快照本身的错误：driver 往往把它包成连接或放入失败。
    async function* recorded(): AsyncGenerator<Buffer> {
      try {
        yield* rewritten.chunks;
      } catch (error) {
        failure = error;
        throw error;
      }
    }
    await deps.driver.copyInArchive(sandbox, recorded(), signal);
    // 放入成功也要确认快照已读完并通过核对（driver 不会在没读完时返回成功，这里再确认一次）。
    if (rewritten.fileCount !== opened.record.fileCount) throw new SandboxArchiveError('file count mismatch');
    return opened.record;
  } catch (error) {
    await deps.driver.destroy(sandbox).catch(() => {});
    const cause = failure ?? error;
    if (cause instanceof WorkspaceSnapshotIntegrityError || cause instanceof SandboxArchiveError) {
      throw new SandboxError('SANDBOX_INPUT_FAILED', '工作区快照不可用', { cause });
    }
    throw error;
  }
}
