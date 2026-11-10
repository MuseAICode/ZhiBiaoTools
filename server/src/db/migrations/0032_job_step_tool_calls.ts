// 任务步骤结果保存工具调用（路线图第 8 步 8.2c1；docs/SERVER_DESIGN.md 第 7.13 节）：AI 网关支持工具调用后，模型的一次输出
// 可能只有工具调用、没有文字。步骤幂等（0025_job_step_results）要能原样取回这次输出，否则续跑时取回的结果缺了工具调用。
//
// - 新增可空列 tool_calls（jsonb 数组，每项 {id, name, arguments}）：没有工具调用的步骤为 NULL，与之前的行相同；
// - CHECK：是数组、最多 128 项（与 src/ai/tools.ts 的 MAX_TOOL_CALLS 相同）、序列化后不超过结果的字节上限（与 content 相同）；
//   每一项的字段由网关写入前保证（结构不合法的上游响应不收费、不保存）；
// - 应用角色补上这一列的 INSERT 授权（与 0025 中其他列相同）；仍然没有 UPDATE、DELETE。RLS 策略不变。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { JOB_STEP_RESULT_MAX_BYTES } from './0025_job_step_results.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

/** 一次输出最多的工具调用数，与 src/ai/tools.ts 的 MAX_TOOL_CALLS 相同。 */
export const JOB_STEP_MAX_TOOL_CALLS = 128;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE job_step_results ADD COLUMN tool_calls jsonb
          CONSTRAINT job_step_results_tool_calls_check CHECK (
            tool_calls IS NULL OR (
              jsonb_typeof(tool_calls) = 'array'
              AND jsonb_array_length(tool_calls) BETWEEN 1 AND ${sql.lit(JOB_STEP_MAX_TOOL_CALLS)}
              AND octet_length(tool_calls::text) <= ${sql.lit(JOB_STEP_RESULT_MAX_BYTES)}))`,
    sql`GRANT INSERT (tool_calls) ON job_step_results TO ${sql.id(APP_ROLE)}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 删除列时列级授权一并删除。
  await run(db, [sql`ALTER TABLE job_step_results DROP COLUMN tool_calls`]);
}
