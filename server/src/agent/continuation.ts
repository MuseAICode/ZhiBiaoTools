// 跨任务续用 Agent 会话（路线图第 8 步 8.7b；docs/SERVER_DESIGN.md 第 7.31 节）。
//
// 桌面版的调整类任务（可研目录调整、技术方案目录调整、全局事实调整）接着对应生成任务的持久会话继续（persistent_task.mode = 'resume'）。
// Web 版的会话文件在工作区快照中（每个项目、每类任务只保留最近一次，8.5a），执行者的现场（会话文件名、受保护文件的登记）在写下该快照的
// 任务的 checkpoint 中（8.6d1）。两者是同一对的依据是现场中的快照 id（8.7b 起执行者在保存快照后写入）：
// - 找到该类任务当前的快照（已完成、未被替换），再找本项目中这几类任务里、现场的快照 id 正是它的任务；
// - 只采用已结束（成功或失败）的任务：被取消的任务（用户取消、保存上游内容或重置时取消）在取消到退出之间仍可能保存检查点，
//   它的会话不再续用；暂停中、排队中、执行中的任务仍是它自己的会话（且持有互斥键，调整任务此时也无法入队）；
// - 现场须能按 checkpoint 的规则读出、有会话文件（取最新的一个；它不合法时按找不到处理，不退回更早的任务）。
// 找不到时返回 null：调用方按“工作空间不存在，请重新生成”处理。放入快照时执行者再核对一次快照 id（execution.ts 的 open）。
// 组织由 RLS 限定（调用方的事务经 withTenant），项目须已按业务规则校验。本模块不写日志。
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { parseAgentRunCheckpoint, type AgentRunState } from './execution.ts';

/** 可以续用会话的来源任务的状态。 */
const SOURCE_STATUSES = ['succeeded', 'failed'] as const;

export interface AgentSessionTarget {
  readonly projectId: string;
  /** 工作区快照的任务类别（任务类型登记的 agentWorkspace.taskKind）。 */
  readonly taskKind: string;
  /** 共用这个类别、会话可以续用的任务类型（例如目录生成与目录调整）。 */
  readonly jobTypes: readonly string[];
}

export interface AgentSessionSource {
  /** 写下当前快照与现场的任务。 */
  readonly jobId: string;
  /** 交给 open({ continueFrom }) 的现场。 */
  readonly state: AgentRunState;
}

/** 在调用方的事务中查找（例如读取页面状态时一并给出能否调整）。 */
export async function findContinuableAgentSessionIn(trx: Transaction<Database>, target: AgentSessionTarget): Promise<AgentSessionSource | null> {
  if (target.jobTypes.length === 0) return null;
  const snapshot = await trx
    .selectFrom('agent_workspace_snapshots')
    .select('id')
    .where('project_id', '=', target.projectId)
    .where('task_kind', '=', target.taskKind)
    .where('status', '=', 'ready')
    .where('superseded_at', 'is', null)
    .executeTakeFirst();
  if (!snapshot) return null;
  const row = await trx
    .selectFrom('jobs')
    .select(['id', 'checkpoint'])
    .where('project_id', '=', target.projectId)
    .where('type', 'in', [...target.jobTypes])
    .where('status', 'in', [...SOURCE_STATUSES])
    .where(sql<string>`checkpoint -> 'agent' ->> 'snapshot'`, '=', snapshot.id)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  let parsed;
  try {
    parsed = parseAgentRunCheckpoint(row.checkpoint);
  } catch {
    return null;
  }
  if (!parsed || parsed.agent.session === null || parsed.agent.snapshot !== snapshot.id) return null;
  return { jobId: row.id, state: parsed.agent };
}

export function findContinuableAgentSession(db: Kysely<Database>, context: TenantContext, target: AgentSessionTarget): Promise<AgentSessionSource | null> {
  return withTenant(db, context, (trx) => findContinuableAgentSessionIn(trx, target));
}
