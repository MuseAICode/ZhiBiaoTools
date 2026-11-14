// Agent 向用户提问（ask-user，路线图第 8 步 8.4c1；docs/SERVER_DESIGN.md 第 7.17 节）。
// 沙箱内的 Agent 经业务工具 ask-user 提出一个问题（src/agent/askUserTool.ts），用户在页面上回答（POST /api/jobs/:jobId/answer），
// 答案经同一个工具交回 Agent。等待超过 AGENT_QUESTION_TIMEOUT_SECONDS（8.4c1 开始前用户确认：10 分钟）时任务暂停为 waiting_for_user，
// 用户回答后自动继续（回到 queued），续跑时 Agent 再次提出同一个问题即取回答案。
//
// - agent_questions：每个问题一行；每个任务同时至多一个未关闭的问题（pending 或 answered，部分唯一索引）。
//   question / options 是服务端规范化后的纯文本（来自沙箱，不可信），content_hash 是两者的 SHA-256（续跑时按它认出同一个问题）；
// - 状态只能按下列方式改变，由触发器强制（AQ001），不依赖应用代码：
//   - pending → pending：任务换了执行（续跑），新的执行再次提出同一问题时接手（run_id 改为任务当前的执行，asked_at 重新计时）；
//   - pending → answered：只能回答尚未关闭的任务（queued / running / paused），回答人是本组织成员并且是任务发起人或 owner / admin
//     （没有用户上下文一律拒绝）；选项序号在范围内，选了“自定义输入”的选项时必须有 answer_text，否则不能有；
//     answered_by、answered_at 由触发器填写；
//   - answered → consumed：只在任务 running 时，consumed_run_id 必须是任务当前的执行（答案交给了这次执行的 Agent）；
//   - pending / answered → superseded：任务换了执行后 Agent 提出了不同的问题，旧问题作废（只能作废旧执行的问题）；
//   - consumed、superseded 之后不能再改；标识、问题与选项不能改；
// - 写入只能为本组织 running、run_id 相符且登记了上限的 Agent 任务进行（RLS）；没有 DELETE 授权；随任务记录删除；
// - jobs.pause_reason 新增 waiting_for_user。
//
// 不改已有表的 RLS 策略，不新增数据库角色。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';
import { JOB_PAUSE_REASONS as JOB_PAUSE_REASONS_0036 } from './0036_agent_job_runs.ts';
import { AGENT_BUDGET_CONFIRM_ROLES } from './0034_agent_job_budget_confirm.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 等待用户回答超时而暂停的原因。 */
export const AGENT_WAITING_FOR_USER_PAUSE_REASON = 'waiting_for_user';
/** 暂停原因：0036 的四个加上等待回答超时。 */
export const JOB_PAUSE_REASONS = [...JOB_PAUSE_REASONS_0036, AGENT_WAITING_FOR_USER_PAUSE_REASON] as const;

export const AGENT_QUESTION_STATUSES = ['pending', 'answered', 'consumed', 'superseded'] as const;
/** 可以回答的组织角色（与确认继续相同：owner / admin）；任务发起人另外可以回答（8.4c1 开始前用户确认）。 */
export const AGENT_QUESTION_ANSWER_ROLES = AGENT_BUDGET_CONFIRM_ROLES;
/** 问题与自定义回答的最大字符数。 */
export const AGENT_QUESTION_MAX_LENGTH = 2000;
/** 选项数（与桌面版相同：2～5 个）。 */
export const AGENT_QUESTION_MIN_OPTIONS = 2;
export const AGENT_QUESTION_MAX_OPTIONS = 5;
/** options（jsonb 文本形式）的最大字节数。 */
export const AGENT_QUESTION_OPTIONS_MAX_BYTES = 16 * 1024;

function list(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((value) => sql.lit(value)));
}

function pauseReasonCheck(reasons: readonly string[]): RawBuilder<unknown> {
  return sql`ALTER TABLE jobs ADD CONSTRAINT jobs_pause_reason_check CHECK (pause_reason IN (${list(reasons)}))`;
}

const MAX_LENGTH = sql.lit(AGENT_QUESTION_MAX_LENGTH);

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE jobs DROP CONSTRAINT jobs_pause_reason_check`,
    pauseReasonCheck(JOB_PAUSE_REASONS),

    sql`CREATE TABLE agent_questions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id uuid NOT NULL,
          job_id uuid NOT NULL,
          run_id uuid NOT NULL,
          content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
          question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND ${MAX_LENGTH} AND question = btrim(question)),
          options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array'
            AND jsonb_array_length(options) BETWEEN ${sql.lit(AGENT_QUESTION_MIN_OPTIONS)} AND ${sql.lit(AGENT_QUESTION_MAX_OPTIONS)}
            AND octet_length(options::text) <= ${sql.lit(AGENT_QUESTION_OPTIONS_MAX_BYTES)}),
          status text NOT NULL DEFAULT 'pending' CHECK (status IN (${list(AGENT_QUESTION_STATUSES)})),
          asked_at timestamptz NOT NULL DEFAULT now(),
          answer_option smallint CHECK (answer_option BETWEEN 0 AND ${sql.lit(AGENT_QUESTION_MAX_OPTIONS - 1)}),
          answer_text text CHECK (char_length(answer_text) BETWEEN 1 AND ${MAX_LENGTH} AND answer_text = btrim(answer_text)),
          answered_by uuid,
          answered_at timestamptz,
          consumed_run_id uuid,
          consumed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT agent_questions_job_fkey FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE,
          CONSTRAINT agent_questions_status_shape CHECK (CASE status
            WHEN 'pending' THEN answer_option IS NULL AND answer_text IS NULL AND answered_by IS NULL AND answered_at IS NULL
              AND consumed_run_id IS NULL AND consumed_at IS NULL
            WHEN 'answered' THEN answer_option IS NOT NULL AND answered_by IS NOT NULL AND answered_at IS NOT NULL
              AND consumed_run_id IS NULL AND consumed_at IS NULL
            WHEN 'consumed' THEN answer_option IS NOT NULL AND answered_by IS NOT NULL AND answered_at IS NOT NULL
              AND consumed_run_id IS NOT NULL AND consumed_at IS NOT NULL
            ELSE consumed_run_id IS NULL AND consumed_at IS NULL END)
        )`,
    // 每个任务同时至多一个未关闭的问题。
    sql`CREATE UNIQUE INDEX agent_questions_job_id_open_idx ON agent_questions (job_id) WHERE status IN ('pending', 'answered')`,
    sql`CREATE INDEX agent_questions_org_id_job_id_idx ON agent_questions (org_id, job_id)`,

    sql`CREATE FUNCTION agent_questions_guard() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_user_id uuid := public.app_current_user_id();
            v_job_status text;
            v_job_run_id uuid;
            v_custom boolean;
          BEGIN
            IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
               OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.question IS DISTINCT FROM OLD.question
               OR NEW.options IS DISTINCT FROM OLD.options OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
              RAISE EXCEPTION 'agent question identity is immutable' USING ERRCODE = 'AQ001';
            END IF;
            IF OLD.status IN ('consumed', 'superseded') THEN
              RAISE EXCEPTION 'agent question is closed' USING ERRCODE = 'AQ001';
            END IF;
            SELECT j.status, j.run_id INTO v_job_status, v_job_run_id
              FROM public.jobs j WHERE j.org_id = OLD.org_id AND j.id = OLD.job_id;

            IF NEW.status = 'pending' THEN
              -- 续跑：新的执行接手同一个问题，等待重新计时。
              IF OLD.status <> 'pending' OR NEW.run_id = OLD.run_id OR v_job_status IS DISTINCT FROM 'running'
                 OR NEW.run_id IS DISTINCT FROM v_job_run_id THEN
                RAISE EXCEPTION 'agent question can only be taken over by the current run' USING ERRCODE = 'AQ001';
              END IF;
              NEW.asked_at := now();
              RETURN NEW;
            END IF;

            IF NEW.status = 'answered' THEN
              IF OLD.status <> 'pending' OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.answer_option IS NULL
                 OR NEW.answer_option >= jsonb_array_length(OLD.options)
                 OR v_job_status IS NULL OR v_job_status NOT IN ('queued', 'running', 'paused') THEN
                RAISE EXCEPTION 'agent question cannot be answered' USING ERRCODE = 'AQ001';
              END IF;
              v_custom := coalesce((OLD.options -> NEW.answer_option::int ->> 'custom')::boolean, false);
              IF v_custom <> (NEW.answer_text IS NOT NULL) THEN
                RAISE EXCEPTION 'custom answer text must match the selected option' USING ERRCODE = 'AQ001';
              END IF;
              -- 回答人：本组织成员，且是任务发起人或 owner / admin。没有用户上下文时一律拒绝。
              IF v_user_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM public.org_memberships m JOIN public.jobs j ON j.org_id = m.org_id
                   WHERE m.org_id = OLD.org_id AND m.user_id = v_user_id AND j.id = OLD.job_id
                     AND (j.user_id = v_user_id OR m.role IN (${list(AGENT_QUESTION_ANSWER_ROLES)})))
              THEN
                RAISE EXCEPTION 'only the job creator or an organization admin can answer' USING ERRCODE = 'AQ001';
              END IF;
              NEW.answered_by := v_user_id;
              NEW.answered_at := now();
              RETURN NEW;
            END IF;

            IF NEW.answer_option IS DISTINCT FROM OLD.answer_option OR NEW.answer_text IS DISTINCT FROM OLD.answer_text
               OR NEW.answered_by IS DISTINCT FROM OLD.answered_by OR NEW.answered_at IS DISTINCT FROM OLD.answered_at
               OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.asked_at IS DISTINCT FROM OLD.asked_at THEN
              RAISE EXCEPTION 'agent question answer is immutable' USING ERRCODE = 'AQ001';
            END IF;

            IF NEW.status = 'consumed' THEN
              IF OLD.status <> 'answered' OR v_job_status IS DISTINCT FROM 'running' OR NEW.consumed_run_id IS NULL
                 OR NEW.consumed_run_id IS DISTINCT FROM v_job_run_id THEN
                RAISE EXCEPTION 'agent question answer can only be consumed by the current run' USING ERRCODE = 'AQ001';
              END IF;
              NEW.consumed_at := now();
              RETURN NEW;
            END IF;

            -- superseded：只能作废旧执行的问题（同一次执行中不能换问题）。
            IF v_job_status IS DISTINCT FROM 'running' OR v_job_run_id IS NULL OR v_job_run_id = OLD.run_id
               OR NEW.consumed_run_id IS NOT NULL OR NEW.consumed_at IS NOT NULL THEN
              RAISE EXCEPTION 'only a question from an earlier run can be superseded' USING ERRCODE = 'AQ001';
            END IF;
            RETURN NEW;
          END
          $$`,
    sql`CREATE TRIGGER agent_questions_guard BEFORE UPDATE ON agent_questions FOR EACH ROW EXECUTE FUNCTION agent_questions_guard()`,
    sql`REVOKE ALL ON FUNCTION agent_questions_guard() FROM PUBLIC`,

    sql`ALTER TABLE agent_questions ENABLE ROW LEVEL SECURITY`,
    sql`ALTER TABLE agent_questions FORCE ROW LEVEL SECURITY`,
    sql`CREATE POLICY agent_questions_select_tenant ON agent_questions FOR SELECT TO ${app} USING (org_id = app_current_org_id())`,
    // 只能为本组织 running、run_id 相符且登记了上限的 Agent 任务提问。
    sql`CREATE POLICY agent_questions_insert_running ON agent_questions FOR INSERT TO ${app}
          WITH CHECK (org_id = app_current_org_id() AND status = 'pending'
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = agent_questions.org_id AND j.id = agent_questions.job_id
                          AND j.status = 'running' AND j.run_id = agent_questions.run_id)
            AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.job_id = agent_questions.job_id))`,
    // 改法由触发器限定。
    sql`CREATE POLICY agent_questions_update_tenant ON agent_questions FOR UPDATE TO ${app}
          USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id())`,
    sql`GRANT SELECT ON agent_questions TO ${app}`,
    sql`GRANT INSERT (org_id, job_id, run_id, content_hash, question, options) ON agent_questions TO ${app}`,
    sql`GRANT UPDATE (run_id, status, answer_option, answer_text, consumed_run_id) ON agent_questions TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`DROP TABLE agent_questions`,
    sql`DROP FUNCTION agent_questions_guard()`,
    // 等待回答超时而暂停的任务回滚后按手动暂停处理（仍是 paused，可以继续）。做法同 0036 的回滚。
    sql`ALTER TABLE jobs DROP CONSTRAINT jobs_pause_reason_check`,
    sql`ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY`,
    sql`UPDATE jobs SET pause_reason = NULL WHERE pause_reason = ${sql.lit(AGENT_WAITING_FOR_USER_PAUSE_REASON)}`,
    sql`ALTER TABLE jobs FORCE ROW LEVEL SECURITY`,
    pauseReasonCheck(JOB_PAUSE_REASONS_0036),
  ]);
}
