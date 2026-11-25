// 长时业务工具调用的交接（路线图第 8 步 8.10c2b1；docs/SERVER_DESIGN.md 第 7.44 节）。
//
// 正文写作的 generate-sections（8.10c2b2）一次提交可能要几十分钟，超过 agent-gw 单次转发的时限；它要用的服务端材料、JobAi 与沙箱
// 都在执行该任务的执行者手里，而 worker 内部入口的处理函数不一定与执行者在同一个进程中。#123 开始前用户确认：**由执行者执行**——
// 内部入口只把请求登记在这里并等待（同 ask-user：一次调用至多等 50 秒，未完成返回 pending，桩以相同的参数再次调用），执行者在
// 本条提示词执行期间认领、执行并写下结果，内部入口取回后交给 Agent。内部入口不因此获得任何新的能力（不接触沙箱、不调用模型）。
//
// - agent_tool_requests：每次请求一行；每个任务同时至多一个未关闭的请求（pending / running / finished，部分唯一索引）。
//   args 是按工具 schema 校验过的参数（来自沙箱，不可信），args_hash 是其规范化 JSON 的 SHA-256（以相同参数再次调用时按它认出）；
// - 状态只能按下列方式改变，由触发器强制（AR001），不依赖应用代码：
//   - pending → running：执行者认领，只能在任务 running、run_id 是任务当前的执行时（claimed_at 由触发器填写）；
//   - running → finished：写下 outcome（succeeded 带 result、rejected 带给 Agent 的说明、failed 两者都没有）；succeeded / rejected
//     只能在任务仍是该次执行时写下，failed 任何时候都可以（执行者中止、任务被暂停后也能收尾）；finished_at 由触发器填写；
//   - finished → consumed：结果交给了该次执行的 Agent（任务 running、run_id 相符），consumed_at 由触发器填写；
//   - pending / running / finished → superseded：该行属于任务较早的执行（续跑后新的执行另提请求），或已完成未取回时同一次执行
//     提出了不同的请求；
//   - consumed、superseded 之后不能再改；标识、工具、参数与创建时间不能改，outcome / result / message 只在 running → finished 时写下；
// - 写入只能为本组织 running、run_id 相符且登记了上限的 Agent 任务进行（RLS）；没有 DELETE 授权；随任务记录删除。
//
// 不改已有表的 RLS 策略，不新增数据库角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { AGENT_TOOL_NAME_PATTERN } from './0037_agent_tool_calls.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

export const AGENT_TOOL_REQUEST_STATUSES = ['pending', 'running', 'finished', 'consumed', 'superseded'] as const;
export const AGENT_TOOL_REQUEST_OUTCOMES = ['succeeded', 'rejected', 'failed'] as const;
/** args（jsonb 文本形式）的最大字节数；长时工具登记的参数上限不能超过它。 */
export const AGENT_TOOL_REQUEST_ARGS_MAX_BYTES = 256 * 1024;
/** result（jsonb 文本形式）的最大字节数。 */
export const AGENT_TOOL_REQUEST_RESULT_MAX_BYTES = 256 * 1024;
/** rejected 时给 Agent 的说明的最大字符数（与沙箱内桩交给模型的上限相同）。 */
export const AGENT_TOOL_REQUEST_MESSAGE_MAX_LENGTH = 500;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`CREATE TABLE agent_tool_requests (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          run_id uuid NOT NULL,
          tool text NOT NULL CHECK (tool ~ ${sql.lit(AGENT_TOOL_NAME_PATTERN)}),
          args_hash bytea NOT NULL CHECK (octet_length(args_hash) = 32),
          args jsonb NOT NULL CHECK (jsonb_typeof(args) = 'object' AND octet_length(args::text) <= ${sql.lit(AGENT_TOOL_REQUEST_ARGS_MAX_BYTES)}),
          status text NOT NULL DEFAULT 'pending' CHECK (status IN (${list(AGENT_TOOL_REQUEST_STATUSES)})),
          outcome text CHECK (outcome IN (${list(AGENT_TOOL_REQUEST_OUTCOMES)})),
          result jsonb CHECK (octet_length(result::text) <= ${sql.lit(AGENT_TOOL_REQUEST_RESULT_MAX_BYTES)}),
          message text CHECK (char_length(message) BETWEEN 1 AND ${sql.lit(AGENT_TOOL_REQUEST_MESSAGE_MAX_LENGTH)}),
          created_at timestamptz NOT NULL DEFAULT now(),
          claimed_at timestamptz,
          finished_at timestamptz,
          consumed_at timestamptz,
          CONSTRAINT agent_tool_requests_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE,
          CONSTRAINT agent_tool_requests_outcome_shape CHECK (CASE outcome
            WHEN 'succeeded' THEN result IS NOT NULL AND message IS NULL
            WHEN 'rejected' THEN result IS NULL AND message IS NOT NULL
            ELSE result IS NULL AND message IS NULL END),
          CONSTRAINT agent_tool_requests_status_shape CHECK (CASE status
            WHEN 'pending' THEN outcome IS NULL AND claimed_at IS NULL AND finished_at IS NULL AND consumed_at IS NULL
            WHEN 'running' THEN outcome IS NULL AND claimed_at IS NOT NULL AND finished_at IS NULL AND consumed_at IS NULL
            WHEN 'finished' THEN outcome IS NOT NULL AND claimed_at IS NOT NULL AND finished_at IS NOT NULL AND consumed_at IS NULL
            WHEN 'consumed' THEN outcome IS NOT NULL AND claimed_at IS NOT NULL AND finished_at IS NOT NULL AND consumed_at IS NOT NULL
            ELSE consumed_at IS NULL END)
        )`,
    // 每个任务同时至多一个未关闭的请求。
    sql`CREATE UNIQUE INDEX agent_tool_requests_job_id_open_idx ON agent_tool_requests (job_id) WHERE status IN ('pending', 'running', 'finished')`,
    sql`CREATE INDEX agent_tool_requests_org_id_job_id_idx ON agent_tool_requests (org_id, job_id)`,

    sql`CREATE FUNCTION agent_tool_requests_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_job_status text;
            v_job_run_id uuid;
            v_current boolean;
          BEGIN
            IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
               OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.tool IS DISTINCT FROM OLD.tool OR NEW.args_hash IS DISTINCT FROM OLD.args_hash
               OR NEW.args IS DISTINCT FROM OLD.args OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
              RAISE EXCEPTION 'agent tool request identity is immutable' USING ERRCODE = 'AR001';
            END IF;
            IF OLD.status IN ('consumed', 'superseded') THEN
              RAISE EXCEPTION 'agent tool request is closed' USING ERRCODE = 'AR001';
            END IF;
            -- 时间一律由触发器填写。
            IF NEW.claimed_at IS DISTINCT FROM OLD.claimed_at OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
               OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
              RAISE EXCEPTION 'agent tool request timestamps are set by the database' USING ERRCODE = 'AR001';
            END IF;
            -- 结果只在 running → finished 时写下。
            IF NOT (OLD.status = 'running' AND NEW.status = 'finished')
               AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.result IS DISTINCT FROM OLD.result OR NEW.message IS DISTINCT FROM OLD.message) THEN
              RAISE EXCEPTION 'agent tool request outcome is immutable' USING ERRCODE = 'AR001';
            END IF;
            SELECT j.status, j.run_id INTO v_job_status, v_job_run_id
              FROM public.jobs j WHERE j.org_id = OLD.org_id AND j.id = OLD.job_id;
            v_current := coalesce(v_job_status = 'running' AND v_job_run_id = OLD.run_id, false);

            IF OLD.status = 'pending' AND NEW.status = 'running' THEN
              IF NOT v_current THEN
                RAISE EXCEPTION 'agent tool request can only be claimed by the current run' USING ERRCODE = 'AR001';
              END IF;
              NEW.claimed_at := now();
              RETURN NEW;
            END IF;

            IF OLD.status = 'running' AND NEW.status = 'finished' THEN
              IF NEW.outcome IS NULL OR (NEW.outcome <> 'failed' AND NOT v_current) THEN
                RAISE EXCEPTION 'agent tool request result can only be written by the current run' USING ERRCODE = 'AR001';
              END IF;
              NEW.finished_at := now();
              RETURN NEW;
            END IF;

            IF OLD.status = 'finished' AND NEW.status = 'consumed' THEN
              IF NOT v_current THEN
                RAISE EXCEPTION 'agent tool request result can only be consumed by the current run' USING ERRCODE = 'AR001';
              END IF;
              NEW.consumed_at := now();
              RETURN NEW;
            END IF;

            IF NEW.status = 'superseded' THEN
              -- 较早执行的请求，或同一次执行中已完成、未取回的请求（Agent 改提了不同的请求）。
              IF v_job_status IS DISTINCT FROM 'running' OR v_job_run_id IS NULL
                 OR (v_job_run_id = OLD.run_id AND OLD.status <> 'finished') THEN
                RAISE EXCEPTION 'only a request from an earlier run or a finished request can be superseded' USING ERRCODE = 'AR001';
              END IF;
              RETURN NEW;
            END IF;

            RAISE EXCEPTION 'agent tool request status cannot change this way' USING ERRCODE = 'AR001';
          END
          $$`,
    sql`CREATE TRIGGER agent_tool_requests_guard BEFORE UPDATE ON agent_tool_requests FOR EACH ROW EXECUTE FUNCTION agent_tool_requests_guard()`,
    sql`REVOKE ALL ON FUNCTION agent_tool_requests_guard() FROM PUBLIC`,

    sql`ALTER TABLE agent_tool_requests ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_tool_requests FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY agent_tool_requests_select_tenant ON agent_tool_requests FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    // 只能为本组织 running、run_id 相符且登记了上限的 Agent 任务登记请求。
    sql`CREATE POLICY agent_tool_requests_insert_running ON agent_tool_requests FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND status = 'pending'
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = agent_tool_requests.org_id AND j.id = agent_tool_requests.job_id
                          AND j.status = 'running' AND j.run_id = agent_tool_requests.run_id)
            AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.job_id = agent_tool_requests.job_id))`,
    // 改法由触发器限定。
    sql`CREATE POLICY agent_tool_requests_update_tenant ON agent_tool_requests FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT SELECT ON agent_tool_requests TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, run_id, tool, args_hash, args) ON agent_tool_requests TO ${app}`,
    sql`GRANT UPDATE (status, outcome, result, message) ON agent_tool_requests TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`DROP TABLE agent_tool_requests`, sql`DROP FUNCTION agent_tool_requests_guard()`]);
}
