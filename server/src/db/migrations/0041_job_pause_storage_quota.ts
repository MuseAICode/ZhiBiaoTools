// Agent 工作区快照超出组织存储配额时暂停任务（路线图第 8 步 8.5c；docs/SERVER_DESIGN.md 第 7.21 节）。
// 执行者在检查点保存工作区快照（src/agent/workspaceJob.ts）时超出组织存储配额（0040 的 AW001），任务暂停为 storage_quota，
// 用户删除不需要的文件后经普通的“继续”从上一个检查点续跑（拆分计划“5. 工作区”）。
//
// - jobs.pause_reason 新增 storage_quota。
//
// 不新增表，不改已有表的 RLS 策略，不新增数据库角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { JOB_PAUSE_REASONS as JOB_PAUSE_REASONS_0039 } from './0039_agent_questions.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

/** 保存工作区快照时超出组织存储配额而暂停的原因。 */
export const STORAGE_QUOTA_PAUSE_REASON = 'storage_quota';
/** 暂停原因：0039 的五个加上存储配额已满。 */
export const JOB_PAUSE_REASONS = [...JOB_PAUSE_REASONS_0039, STORAGE_QUOTA_PAUSE_REASON] as const;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

function pauseReasonCheck(reasons: readonly string[]): RawBuilder<unknown> {
  return sql`ALTER TABLE jobs ADD CONSTRAINT jobs_pause_reason_check CHECK (pause_reason IN (${list(reasons)}))`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`ALTER TABLE jobs DROP CONSTRAINT jobs_pause_reason_check`, pauseReasonCheck(JOB_PAUSE_REASONS)]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 因存储配额暂停的任务回滚后按手动暂停处理（仍是 paused，可以继续）。做法同 0036、0039 的回滚。
  await run(db, [
    sql`ALTER TABLE jobs DROP CONSTRAINT jobs_pause_reason_check`,
    sql`ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY`,
    sql`UPDATE jobs SET pause_reason = NULL WHERE pause_reason = ${sql.lit(STORAGE_QUOTA_PAUSE_REASON)}`,
    sql`ALTER TABLE jobs FORCE ROW LEVEL SECURITY`,
    pauseReasonCheck(JOB_PAUSE_REASONS_0039),
  ]);
}
