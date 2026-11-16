// Agent 工作区中受保护文件的登记、比对与还原（路线图第 8 步 8.6c2b；docs/SERVER_DESIGN.md 第 7.26 节）。
//
// 桌面版（client/electron/services/pi/piWorkspaceBaseline.cjs）在工作区外保存程序写入的文件的原件，提交校验前比对，被改或被删的
// 直接还原。Web 版的工作区在 agent 沙箱中，沙箱内的一切都按攻击者的数据处理，这件事放在 worker 一侧：
// - **登记**：程序经 write 把文件放入沙箱的 /workspace，同时按分组记下路径、大小与 SHA-256，原件保存在 worker 的内存中；
//   分组由任务命名（例如“输入资料”“非目标小节”），整体替换某组（replace）、解除登记（release）不影响其他组；
// - **比对与还原**（restore）：取回沙箱的 /workspace（copyOutArchive，按模板的取回规则逐项校验），只对登记的路径计算 SHA-256，
//   内容不同或不存在的把原件放回去，返回还原的路径。任务在每次提交校验之前、下一条提示词之前调用（8.6d）；
// - **续跑**：登记（不含原件）经 toState 写进 jobs.checkpoint；新的执行从 checkpoint 重建（fromState）、放入工作区快照之后调用
//   recover，从刚放入、Agent 尚未执行过的工作区中取回与登记相符的原件。不相符的（检查点之前没有还原、或还原之后被后台进程改动）
//   原件已不可用：任务须重新 write 这些文件，否则 restore 以 AGENT_PROTECTED_FILES_UNAVAILABLE 失败，不把 Agent 改过的内容当作原件；
// - **平台只用原件**：还原之后沙箱内残留的后台进程仍可能再次改动，所以 worker 处理受保护文件时一律用 original 给出的原件，
//   不读回沙箱中的副本；restore 只是让 Agent 的后续工作基于正确的输入，并告诉 Agent 哪些文件被还原了。
// 组织、项目与任务一律来自调用方（任务的上下文），本模块不访问数据库、不写日志，失败说明不含文件名与内容。
import { createHash } from 'node:crypto';
import { JobError } from '../jobs/definitions.ts';
import { archivePathKey, SandboxArchiveError, validateRelativePath, visitArchive, type SandboxFile } from '../sandbox/archive.ts';
import { SandboxError, type SandboxRef } from '../sandbox/driver.ts';
import { SANDBOX_TEMPLATES, type SandboxTransferLimits } from '../sandbox/templates.ts';
import type { WorkspaceSandboxDriver } from './workspaceSandbox.ts';
import { AGENT_WORKSPACE_REJECTED_CODE, agentWorkspaceRejectedMessage, agentWorkspaceRejectionCategory } from './workspaceJob.ts';

export const AGENT_PROTECTED_FILES_RESTORE_FAILED_CODE = 'AGENT_PROTECTED_FILES_RESTORE_FAILED';
export const AGENT_PROTECTED_FILES_UNAVAILABLE_CODE = 'AGENT_PROTECTED_FILES_UNAVAILABLE';

const RESTORE_FAILED_MESSAGE = '无法还原被 Agent 改动的程序文件（文件名与工作区中已有的文件或目录冲突），任务已停止，请重新发起任务';
const UNAVAILABLE_MESSAGE = '程序文件的原件已不可用，无法还原被 Agent 改动的内容，任务已停止，请重新发起任务';

/** 分组名：任务代码中的常量。 */
const GROUP_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const AGENT_BASELINE_MAX_GROUPS = 16;
/** 登记的文件数上限：登记随 checkpoint 保存（jobs.checkpoint 至多 1 MiB），每条至多约 350 字节。 */
export const AGENT_BASELINE_MAX_FILES = 1_000;
/** 原件合计的字节上限：原件在 worker 的内存中（相同内容只存一份）。 */
export const AGENT_BASELINE_MAX_BYTES = 64 * 1024 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface AgentBaselineEntry {
  readonly sha256: string;
  readonly size: number;
}

/** 写进 jobs.checkpoint 的登记（不含原件）。 */
export interface AgentWorkspaceBaselineState {
  readonly version: 1;
  readonly groups: Readonly<Record<string, Readonly<Record<string, AgentBaselineEntry>>>>;
}

export interface AgentBaselineOptions {
  /** 任务取消、暂停或 worker 关闭时中止。 */
  signal?: AbortSignal;
}

export interface AgentBaselineWriteOptions extends AgentBaselineOptions {
  /** 以这些文件整体替换该分组（不在其中的旧登记解除，沙箱中的文件不删除）；默认追加或刷新。 */
  replace?: boolean;
}

export interface AgentWorkspaceBaseline {
  /**
   * 把文件放入沙箱的 /workspace（覆盖同名文件），成功后登记到分组。路径按 agent 工作区的取回规则（与快照相同）校验并规范化；
   * 不合法、超过上限、同一路径重复时抛 TypeError（程序错误），不放入、不登记。放入失败时按 driver 的错误码抛出，登记不变。
   */
  write(sandbox: SandboxRef, group: string, files: readonly SandboxFile[], options?: AgentBaselineWriteOptions): Promise<void>;
  /** 解除登记：交给 Agent 修改的文件不再还原。返回实际解除的路径。 */
  release(group: string, paths: readonly string[]): string[];
  /** 分组中登记的路径（规范化后）。 */
  paths(group: string): string[];
  /** 登记的原件；没有登记、或续跑后原件不可用时返回 null。worker 处理受保护文件时只用它，不读回沙箱中的副本。 */
  original(path: string): Buffer | null;
  /**
   * 取回 /workspace，比对全部登记的文件，内容不同或不存在的放回原件；返回还原的路径（按登记顺序，不重复）。
   * 工作区不符合取回规则时 JobError(AGENT_WORKSPACE_REJECTED)（与检查点相同）；与已有的文件或目录冲突、放回失败时销毁沙箱并抛
   * JobError(AGENT_PROTECTED_FILES_RESTORE_FAILED)；需要放回、但原件不可用时 JobError(AGENT_PROTECTED_FILES_UNAVAILABLE)；
   * 其他沙箱错误（连接中断、中止）按 driver 的错误码抛出。
   */
  restore(sandbox: SandboxRef, options?: AgentBaselineOptions): Promise<string[]>;
  /**
   * 续跑：从刚放入快照、Agent 尚未执行过的工作区中取回与登记相符的原件；返回原件仍不可用的路径（不相符或不存在）。
   * 错误同 restore 的取回部分。
   */
  recover(sandbox: SandboxRef, options?: AgentBaselineOptions): Promise<string[]>;
  /** 写进 checkpoint 的登记。 */
  toState(): AgentWorkspaceBaselineState;
}

export interface AgentWorkspaceBaselineDeps {
  driver: WorkspaceSandboxDriver;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function workspaceLimits(sandbox: SandboxRef): SandboxTransferLimits {
  if (sandbox.template !== 'agent' && sandbox.template !== 'agent-content') throw new TypeError('只有 agent 沙箱有受保护文件');
  return SANDBOX_TEMPLATES[sandbox.template].output;
}

// 两个 agent 模板的工作区规则相同（templates.ts），登记的路径按它校验。
const LIMITS = SANDBOX_TEMPLATES.agent.output;

function normalizePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new TypeError('受保护文件的路径必须是字符串');
  try {
    return validateRelativePath(raw, LIMITS, false);
  } catch (error) {
    if (error instanceof SandboxArchiveError) throw new TypeError(`受保护文件的路径不合法（${error.reason}）`);
    throw error;
  }
}

function assertGroup(group: unknown): asserts group is string {
  if (typeof group !== 'string' || !GROUP_PATTERN.test(group)) throw new TypeError('受保护文件的分组名不合法');
}

/** 从 checkpoint 读出的登记：checkpoint 由 worker 写入，仍按形状逐项检查，不合法时抛 TypeError。 */
function parseState(state: unknown): Map<string, Map<string, AgentBaselineEntry>> {
  const groups = new Map<string, Map<string, AgentBaselineEntry>>();
  if (typeof state !== 'object' || state === null || Array.isArray(state)) throw new TypeError('受保护文件的登记不合法');
  const record = state as Record<string, unknown>;
  if (record.version !== 1 || typeof record.groups !== 'object' || record.groups === null || Array.isArray(record.groups)) {
    throw new TypeError('受保护文件的登记不合法');
  }
  for (const [group, entries] of Object.entries(record.groups as Record<string, unknown>)) {
    assertGroup(group);
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) throw new TypeError('受保护文件的登记不合法');
    const map = new Map<string, AgentBaselineEntry>();
    for (const [path, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (normalizePath(path) !== path) throw new TypeError('受保护文件的登记不合法');
      const value = entry as Partial<AgentBaselineEntry> | null;
      if (
        typeof value !== 'object' || value === null ||
        typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256) ||
        !Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > LIMITS.maxFileBytes
      ) {
        throw new TypeError('受保护文件的登记不合法');
      }
      map.set(path, Object.freeze({ sha256: value.sha256, size: value.size as number }));
    }
    groups.set(group, map);
  }
  return groups;
}

/** 取回工作区时，登记的每个路径在其中的情况。 */
interface Observed {
  /** 路径（按大小写折叠后的键）→ 实际的路径与内容的 SHA-256；captured 为需要保存的内容。 */
  files: Map<string, { path: string; sha256: string; data: Buffer | null }>;
  /** 工作区中全部文件路径的键（判断冲突）。 */
  keys: Set<string>;
}

export function createAgentWorkspaceBaseline(deps: AgentWorkspaceBaselineDeps, state?: AgentWorkspaceBaselineState | null): AgentWorkspaceBaseline {
  const groups = state !== undefined && state !== null ? parseState(state) : new Map<string, Map<string, AgentBaselineEntry>>();
  if (groups.size > AGENT_BASELINE_MAX_GROUPS) throw new TypeError('受保护文件的分组过多');
  /** 原件，按 SHA-256 存放（相同内容只存一份）。 */
  const originals = new Map<string, Buffer>();

  /** 全部登记：路径 → 条目（同一路径可以在几个分组中，内容以最后一次写入为准，写入时同步刷新）。 */
  function allEntries(): Map<string, AgentBaselineEntry> {
    const all = new Map<string, AgentBaselineEntry>();
    for (const entries of groups.values()) for (const [path, entry] of entries) all.set(path, entry);
    return all;
  }

  function countFiles(candidate: Map<string, Map<string, AgentBaselineEntry>>): number {
    const paths = new Set<string>();
    for (const entries of candidate.values()) for (const path of entries.keys()) paths.add(path);
    return paths.size;
  }

  if (countFiles(groups) > AGENT_BASELINE_MAX_FILES) throw new TypeError('受保护文件过多');

  /** 不再被任何登记引用的原件丢掉。 */
  function pruneOriginals(): void {
    const used = new Set([...allEntries().values()].map((entry) => entry.sha256));
    for (const hash of originals.keys()) if (!used.has(hash)) originals.delete(hash);
  }

  /** 取回工作区，记下登记路径的 SHA-256（capture 为真时同时保存与登记相符的内容）。 */
  async function observe(sandbox: SandboxRef, wanted: Map<string, AgentBaselineEntry>, capture: boolean, options: AgentBaselineOptions): Promise<Observed> {
    const limits = workspaceLimits(sandbox);
    const wantedKeys = new Map([...wanted].map(([path, entry]) => [archivePathKey(path, limits), { path, entry }]));
    const observed: Observed = { files: new Map(), keys: new Set() };
    let current: { key: string; path: string; size: number; hash: ReturnType<typeof createHash>; parts: Buffer[] | null } | null = null;
    const finish = () => {
      if (!current) return;
      const data = current.parts ? Buffer.concat(current.parts) : null;
      observed.files.set(current.key, { path: current.path, sha256: current.hash.digest('hex'), data });
      current = null;
    };
    try {
      const archive = await deps.driver.copyOutArchive(sandbox, options.signal ? { signal: options.signal } : {});
      await visitArchive(archive.chunks, limits, {
        file(path, size) {
          finish();
          const key = archivePathKey(path, limits);
          observed.keys.add(key);
          const target = wantedKeys.get(key);
          if (!target) return;
          // 大小不同的一定被改动过，只在大小相同时保存内容（不按 Agent 写出的大小分配内存）。
          const keep = capture && target.path === path && size === target.entry.size;
          current = { key, path, size, hash: createHash('sha256'), parts: keep ? [] : null };
        },
        data(bytes) {
          if (!current) return;
          current.hash.update(bytes);
          current.parts?.push(Buffer.from(bytes));
        },
      });
      finish();
    } catch (error) {
      if (error instanceof SandboxError && error.code === 'SANDBOX_OUTPUT_REJECTED') {
        const reason = error.cause instanceof SandboxArchiveError ? error.cause.reason : null;
        throw new JobError(AGENT_WORKSPACE_REJECTED_CODE, agentWorkspaceRejectedMessage(agentWorkspaceRejectionCategory(reason)), { cause: error });
      }
      // copyOutArchive 已经逐项校验并重新生成，这里的第二次校验不应失败；万一失败同样按不符合规则处理。
      if (error instanceof SandboxArchiveError) {
        throw new JobError(AGENT_WORKSPACE_REJECTED_CODE, agentWorkspaceRejectedMessage(agentWorkspaceRejectionCategory(error.reason)), { cause: error });
      }
      throw error;
    }
    return observed;
  }

  /** 登记的路径与工作区中的文件或目录冲突（大小写不同的同名文件、上级目录变成了文件、文件变成了非空目录）：放回会失败或产生重名。 */
  function conflicts(path: string, observed: Observed, limits: SandboxTransferLimits): boolean {
    const key = archivePathKey(path, limits);
    const seen = observed.files.get(key);
    if (seen && seen.path !== path) return true;
    const segments = key.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      if (observed.keys.has(segments.slice(0, index).join('/'))) return true;
    }
    const prefix = `${key}/`;
    for (const other of observed.keys) if (other.startsWith(prefix)) return true;
    return false;
  }

  async function failRestore(sandbox: SandboxRef, cause?: unknown): Promise<never> {
    await deps.driver.destroy(sandbox).catch(() => {});
    throw new JobError(AGENT_PROTECTED_FILES_RESTORE_FAILED_CODE, RESTORE_FAILED_MESSAGE, cause === undefined ? undefined : { cause });
  }

  return Object.freeze({
    async write(sandbox: SandboxRef, group: string, files: readonly SandboxFile[], options: AgentBaselineWriteOptions = {}) {
      workspaceLimits(sandbox);
      assertGroup(group);
      const prepared = new Map<string, { data: Buffer; entry: AgentBaselineEntry }>();
      let bytes = 0;
      for (const file of files) {
        const path = normalizePath(file?.path);
        if (!Buffer.isBuffer(file.data)) throw new TypeError('受保护文件的内容必须是 Buffer');
        if (prepared.has(path)) throw new TypeError('受保护文件的路径重复');
        if (file.data.length > LIMITS.maxFileBytes) throw new TypeError('受保护文件过大');
        bytes += file.data.length;
        prepared.set(path, { data: Buffer.from(file.data), entry: Object.freeze({ sha256: sha256(file.data), size: file.data.length }) });
      }
      const next = new Map([...groups].map(([name, entries]) => [name, new Map(entries)]));
      const target = options.replace ? new Map<string, AgentBaselineEntry>() : (next.get(group) ?? new Map<string, AgentBaselineEntry>());
      for (const [path, { entry }] of prepared) {
        target.set(path, entry);
        // 同一路径在其他分组中的登记一并刷新为新内容（否则还原时会放回旧内容）。
        for (const [name, entries] of next) if (name !== group && entries.has(path)) entries.set(path, entry);
      }
      next.set(group, target);
      if (next.size > AGENT_BASELINE_MAX_GROUPS) throw new TypeError('受保护文件的分组过多');
      if (countFiles(next) > AGENT_BASELINE_MAX_FILES) throw new TypeError('受保护文件过多');
      // 原件按内容存放，合计按不同内容的大小算（含续跑后尚未取回的原件）。
      const sizes = new Map<string, number>();
      for (const entries of next.values()) for (const entry of entries.values()) sizes.set(entry.sha256, entry.size);
      let total = 0;
      for (const size of sizes.values()) total += size;
      if (bytes > AGENT_BASELINE_MAX_BYTES || total > AGENT_BASELINE_MAX_BYTES) throw new TypeError('受保护文件的合计大小超过上限');
      if (prepared.size > 0) {
        await deps.driver.copyIn(sandbox, [...prepared].map(([path, { data }]) => ({ path, data })), options.signal ? { signal: options.signal } : {});
      }
      groups.clear();
      for (const [name, entries] of next) groups.set(name, entries);
      for (const { data, entry } of prepared.values()) originals.set(entry.sha256, data);
      pruneOriginals();
    },

    release(group: string, paths: readonly string[]) {
      assertGroup(group);
      const entries = groups.get(group);
      if (!entries) return [];
      const released: string[] = [];
      for (const raw of paths) {
        const path = normalizePath(raw);
        if (entries.delete(path)) released.push(path);
      }
      pruneOriginals();
      return released;
    },

    paths(group: string) {
      assertGroup(group);
      return [...(groups.get(group)?.keys() ?? [])];
    },

    original(raw: string) {
      const path = normalizePath(raw);
      const entry = allEntries().get(path);
      const data = entry ? originals.get(entry.sha256) : undefined;
      return data ? Buffer.from(data) : null;
    },

    async restore(sandbox: SandboxRef, options: AgentBaselineOptions = {}) {
      const limits = workspaceLimits(sandbox);
      const all = allEntries();
      if (all.size === 0) return [];
      const observed = await observe(sandbox, all, false, options);
      const changed: string[] = [];
      for (const [path, entry] of all) {
        const seen = observed.files.get(archivePathKey(path, limits));
        if (seen && seen.path === path && seen.sha256 === entry.sha256) continue;
        changed.push(path);
      }
      if (changed.length === 0) return [];
      if (changed.some((path) => !originals.has(all.get(path)!.sha256))) {
        throw new JobError(AGENT_PROTECTED_FILES_UNAVAILABLE_CODE, UNAVAILABLE_MESSAGE);
      }
      if (changed.some((path) => conflicts(path, observed, limits))) return failRestore(sandbox);
      try {
        await deps.driver.copyIn(sandbox, changed.map((path) => ({ path, data: originals.get(all.get(path)!.sha256)! })), options.signal ? { signal: options.signal } : {});
      } catch (error) {
        if (error instanceof SandboxError && error.code === 'SANDBOX_ABORTED') throw error;
        return failRestore(sandbox, error);
      }
      return changed;
    },

    async recover(sandbox: SandboxRef, options: AgentBaselineOptions = {}) {
      const limits = workspaceLimits(sandbox);
      const all = allEntries();
      if (all.size === 0) return [];
      const observed = await observe(sandbox, all, true, options);
      const missing: string[] = [];
      for (const [path, entry] of all) {
        if (originals.has(entry.sha256)) continue;
        const seen = observed.files.get(archivePathKey(path, limits));
        if (seen?.data && seen.path === path && seen.sha256 === entry.sha256) originals.set(entry.sha256, seen.data);
        else missing.push(path);
      }
      return missing;
    },

    toState(): AgentWorkspaceBaselineState {
      const out: Record<string, Record<string, AgentBaselineEntry>> = {};
      for (const [group, entries] of groups) {
        const record: Record<string, AgentBaselineEntry> = {};
        for (const [path, entry] of entries) Object.defineProperty(record, path, { value: { sha256: entry.sha256, size: entry.size }, enumerable: true, writable: true, configurable: true });
        Object.defineProperty(out, group, { value: record, enumerable: true, writable: true, configurable: true });
      }
      return { version: 1, groups: out };
    },
  });
}
