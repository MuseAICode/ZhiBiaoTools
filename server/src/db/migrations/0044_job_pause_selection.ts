// 任务等待用户确认选择时暂停（路线图第 8 步 8.7e1；docs/SERVER_DESIGN.md 第 7.35 节）。
// 技术方案目录生成（outline-generation）生成一级目录后须由用户确认使用哪些一级目录（桌面版 waitForOutlineSelection，任务在内存中
// 一直等待）。Web 版的执行者保存检查点后退出、任务暂停为 waiting_for_selection（沙箱随即销毁、不占 Agent 并发与运行时长），用户经
// 该任务类型的确认接口提交选择后任务回到 queued，从检查点续跑（src/jobs/store.ts 的 confirmJobSelection）。普通的“继续”不放行。
//
// - jobs.pause_reason 新增 waiting_for_selection。
//
// 不新增表，不改已有表的 RLS 策略，不新增数据库角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { JOB_PAUSE_REASONS as JOB_PAUSE_REASONS_0043 } from './0043_agent_model_rejections.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

/** 等待用户确认选择而暂停的原因。 */
export const WAITING_FOR_SELECTION_PAUSE_REASON = 'waiting_for_selection';
/** 暂停原因：0043 的八个加上等待用户确认选择。 */
export const JOB_PAUSE_REASONS = [...JOB_PAUSE_REASONS_0043, WAITING_FOR_SELECTION_PAUSE_REASON] as const;

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
  // 等待选择而暂停的任务回滚后按手动暂停处理（仍是 paused）。做法同 0041、0043 的回滚。
  await run(db, [
    sql`ALTER TABLE jobs DROP CONSTRAINT jobs_pause_reason_check`,
    sql`ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY`,
    sql`UPDATE jobs SET pause_reason = NULL WHERE pause_reason = ${sql.lit(WAITING_FOR_SELECTION_PAUSE_REASON)}`,
    sql`ALTER TABLE jobs FORCE ROW LEVEL SECURITY`,
    pauseReasonCheck(JOB_PAUSE_REASONS_0043),
  ]);
}
