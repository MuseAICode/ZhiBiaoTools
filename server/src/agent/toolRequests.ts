// 长时业务工具调用的交接（路线图第 8 步 8.10c2b1；docs/SERVER_DESIGN.md 第 7.44 节；迁移 0047_agent_tool_requests）。
//
// 一次调用要几十分钟的业务工具（8.10c2b2 的 generate-sections）不能在 worker 内部入口的一次转发中完成，它要用的服务端材料、JobAi
// 与沙箱也只在执行该任务的执行者手里。#123 开始前用户确认：**由执行者执行**。
//
// - 内部入口一侧（createAgentLongTool 生成的工具）：参数照常经 8.4a 的框架校验与计数，然后登记一条请求并至多等待 waitMs
//   （默认 50 秒，短于 agent-gw 的转发时限），期间每 pollMs 查一次：已完成即取回（标为 consumed）交给 Agent；仍未完成返回
//   { completed: false, pending: true, message }，沙箱内的桩以完全相同的参数再次调用继续等待（同 ask-user，8.6）。以相同参数
//   （规范化 JSON 的 SHA-256）再次调用不新建请求；本次执行另有一个不同的请求在等待或执行时 409 AGENT_TOOL_REQUEST_PENDING；
//   已完成、未取回的请求遇到不同的请求时作废后新建；较早执行的请求一律作废。内部入口不接触沙箱、不调用模型。
// - 执行者一侧（serveAgentToolRequests，由 AgentRun.prompt 在本条提示词执行期间运行）：认领本次执行中由本条提示词登记了执行函数的
//   工具的请求，调用执行函数，写下结果——
//   - 返回值：succeeded（结果须可 JSON 序列化、不超过 AGENT_TOOL_REQUEST_RESULT_MAX_BYTES）；
//   - AgentToolRequestRejection：rejected，说明（任务代码给出的固定文字）作为工具错误交给 Agent（422 AGENT_TOOL_REJECTED）；
//   - 其他错误：failed（Agent 只得到固定的说明），并且是本次执行的致命错误——prompt 中止入口、按该错误结束（余额不足暂停、
//     达到上限暂停、中止、任务失败等，与任务自己抛出时相同）。
//
// 组织、任务与本次执行一律来自令牌身份（内部入口）或任务记录（执行者），不来自请求。本模块不写日志。
import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import { type Kysely } from 'kysely';
import {
  AGENT_TOOL_REQUEST_ARGS_MAX_BYTES,
  AGENT_TOOL_REQUEST_MESSAGE_MAX_LENGTH,
  AGENT_TOOL_REQUEST_RESULT_MAX_BYTES,
} from '../db/migrations/0047_agent_tool_requests.ts';
import type { AgentToolRequestOutcome, AgentToolRequestStatus, Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { findAgentFailureReport } from './failureReport.ts';
import type { AgentToolContext, AgentToolDefinition, AgentToolSchema } from './tools.ts';

export {
  AGENT_TOOL_REQUEST_ARGS_MAX_BYTES,
  AGENT_TOOL_REQUEST_MESSAGE_MAX_LENGTH,
  AGENT_TOOL_REQUEST_RESULT_MAX_BYTES,
} from '../db/migrations/0047_agent_tool_requests.ts';

type Trx = Transaction<Database>;

/** 内部入口一次调用至多等待的时间（毫秒）：与 ask-user 相同，短于 agent-gw 的转发时限。 */
export const AGENT_LONG_TOOL_WAIT_MS = 50_000;
/** 内部入口等待中查询结果的间隔（毫秒）。 */
export const AGENT_LONG_TOOL_POLL_MS = 1_000;
/** 执行者查询待认领请求的间隔（毫秒）。 */
export const AGENT_TOOL_REQUEST_SERVE_POLL_MS = 1_000;

/** 仍未完成时交给桩的结果（桩据此以相同参数再次调用）。 */
export interface AgentLongToolPending {
  completed: false;
  pending: true;
  message: string;
}

const PENDING_MESSAGE = '工具仍在执行，请以完全相同的参数再次调用以取回结果';
/** failed 时交给 Agent 的固定说明（与沙箱内桩的通用说明相同）。 */
export const AGENT_TOOL_FAILED_MESSAGE = '平台暂时无法执行该工具，请稍后重试';

function notRunning(): AppError {
  return new AppError(409, 'JOB_NOT_RUNNING', '任务不在执行中，不能调用工具');
}

/** 规范化 JSON（对象的键排序）：以相同参数再次调用时得到相同的哈希。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function agentToolArgsHash(args: Record<string, unknown>): Buffer {
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest();
}

export interface AgentToolRequestRef {
  /** 内部入口：按令牌查出的身份；执行者：任务记录中的身份。 */
  tenant: TenantContext;
  jobId: string;
  runId: string;
}

/** 请求的结果（内部入口取回时）。 */
export type AgentToolRequestResult =
  | { outcome: 'succeeded'; result: unknown }
  | { outcome: 'rejected'; message: string }
  | { outcome: 'failed' };

export type AgentToolRequestState =
  /** 已完成：结果已交给本次执行（请求关闭）。 */
  | { kind: 'finished'; requestId: string; result: AgentToolRequestResult }
  /** 等待执行者认领或执行中。 */
  | { kind: 'pending'; requestId: string; created: boolean }
  /** 任务不在本次执行中（或 Agent 已报告无法继续），或请求已被作废。 */
  | { kind: 'not-running' }
  /** 本次执行已有另一个请求在等待或执行。 */
  | { kind: 'conflict' };

interface RequestRow {
  id: string;
  run_id: string;
  tool: string;
  args_hash: Buffer;
  status: AgentToolRequestStatus;
  outcome: AgentToolRequestOutcome | null;
  result: unknown;
  message: string | null;
}

const REQUEST_COLUMNS = ['id', 'run_id', 'tool', 'args_hash', 'status', 'outcome', 'result', 'message'] as const;
const OPEN_STATUSES = ['pending', 'running', 'finished'] as const;

/** 锁住任务行，任务仍是本次执行且没有失败报告时返回 true。 */
async function lockCurrentRun(trx: Trx, ref: AgentToolRequestRef): Promise<boolean> {
  const job = await trx.selectFrom('jobs').select(['status', 'run_id']).where('id', '=', ref.jobId).forUpdate().executeTakeFirst();
  if (!job || job.status !== 'running' || job.run_id !== ref.runId) return false;
  return (await findAgentFailureReport(trx, ref.jobId, ref.runId)) === null;
}

function resultOf(row: RequestRow): AgentToolRequestResult {
  if (row.outcome === 'succeeded') return { outcome: 'succeeded', result: row.result };
  if (row.outcome === 'rejected') return { outcome: 'rejected', message: row.message ?? AGENT_TOOL_FAILED_MESSAGE };
  return { outcome: 'failed' };
}

async function consume(trx: Trx, row: RequestRow): Promise<AgentToolRequestState> {
  await trx.updateTable('agent_tool_requests').set({ status: 'consumed' }).where('id', '=', row.id).execute();
  return { kind: 'finished', requestId: row.id, result: resultOf(row) };
}

/**
 * 登记一次请求（内部入口，在 withTenant 的事务中调用）。同一工具、同一参数的请求已完成的直接取回结果，未完成的继续等待；
 * 已完成未取回的不同请求、较早执行的请求作废后新建；本次执行另有不同的请求在等待或执行时返回 conflict。
 */
export async function openAgentToolRequest(trx: Trx, ref: AgentToolRequestRef, tool: string, args: Record<string, unknown>): Promise<AgentToolRequestState> {
  const serialized = JSON.stringify(args);
  if (Buffer.byteLength(serialized, 'utf8') > AGENT_TOOL_REQUEST_ARGS_MAX_BYTES) throw new TypeError('工具参数超过请求的上限');
  const hash = agentToolArgsHash(args);
  if (!(await lockCurrentRun(trx, ref))) return { kind: 'not-running' };
  const open = (await trx
    .selectFrom('agent_tool_requests')
    .select(REQUEST_COLUMNS)
    .where('job_id', '=', ref.jobId)
    .where('status', 'in', OPEN_STATUSES)
    .forUpdate()
    .executeTakeFirst()) as RequestRow | undefined;
  if (open && open.run_id === ref.runId) {
    if (open.tool === tool && open.args_hash.equals(hash)) {
      if (open.status === 'finished') return consume(trx, open);
      return { kind: 'pending', requestId: open.id, created: false };
    }
    if (open.status !== 'finished') return { kind: 'conflict' };
  }
  if (open) await trx.updateTable('agent_tool_requests').set({ status: 'superseded' }).where('id', '=', open.id).execute();
  const inserted = await trx
    .insertInto('agent_tool_requests')
    .values({ org_id: ref.tenant.orgId, job_id: ref.jobId, run_id: ref.runId, tool, args_hash: hash, args: serialized })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { kind: 'pending', requestId: inserted.id, created: true };
}

/** 等待中检查一次（内部入口，在 withTenant 的事务中调用）：已完成即取回结果；请求被作废、任务不在本次执行中时 not-running。 */
export async function pollAgentToolRequest(trx: Trx, ref: AgentToolRequestRef, requestId: string): Promise<AgentToolRequestState> {
  if (!(await lockCurrentRun(trx, ref))) return { kind: 'not-running' };
  const row = (await trx
    .selectFrom('agent_tool_requests')
    .select(REQUEST_COLUMNS)
    .where('id', '=', requestId)
    .where('job_id', '=', ref.jobId)
    .forUpdate()
    .executeTakeFirst()) as RequestRow | undefined;
  if (!row || row.run_id !== ref.runId) return { kind: 'not-running' };
  if (row.status === 'finished') return consume(trx, row);
  if (row.status === 'pending' || row.status === 'running') return { kind: 'pending', requestId: row.id, created: false };
  return { kind: 'not-running' };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface AgentToolRequestWaitOptions {
  waitMs: number;
  pollMs: number;
}

/**
 * 登记请求并至多等待 waitMs（内部入口）：已完成返回结果，仍未完成返回 null（由桩以相同参数再次调用）；本次执行另有请求在等待
 * 409 AGENT_TOOL_REQUEST_PENDING，任务不在本次执行中 409 JOB_NOT_RUNNING。
 */
export async function waitForAgentToolRequest(
  context: AgentToolContext,
  tool: string,
  args: Record<string, unknown>,
  options: AgentToolRequestWaitOptions,
): Promise<AgentToolRequestResult | null> {
  const ref: AgentToolRequestRef = { tenant: context.tenant, jobId: context.identity.jobId, runId: context.identity.runId };
  let state: AgentToolRequestState = await withTenant(context.db, context.tenant, (trx) => openAgentToolRequest(trx, ref, tool, args));
  if (state.kind === 'pending' && state.created) context.log.info({ jobId: ref.jobId, tokenId: context.identity.logId, tool, requestId: state.requestId }, 'agent tool request');
  const deadline = Date.now() + options.waitMs;
  while (state.kind === 'pending' && Date.now() < deadline && !context.signal.aborted) {
    await sleep(Math.min(options.pollMs, Math.max(deadline - Date.now(), 0)), context.signal);
    if (context.signal.aborted) break;
    const requestId: string = state.requestId;
    state = await withTenant(context.db, context.tenant, (trx) => pollAgentToolRequest(trx, ref, requestId));
  }
  if (state.kind === 'finished') return state.result;
  if (state.kind === 'conflict') throw new AppError(409, 'AGENT_TOOL_REQUEST_PENDING', '已有一个工具调用在执行，请以完全相同的参数再次调用该工具以取回结果');
  if (state.kind === 'not-running') throw notRunning();
  return null;
}

export interface AgentLongToolOptions {
  readonly name: string;
  readonly argumentsSchema: AgentToolSchema;
  /** 不超过 AGENT_TOOL_REQUEST_ARGS_MAX_BYTES。 */
  readonly maxArgumentBytes: number;
  /** 每次等待调用都计入（一次执行 30 分钟约 36 次）。 */
  readonly maxCallsPerJob: number;
  readonly maxCallsPerMinute: number;
  /** 测试用：等待与查询的间隔。 */
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/**
 * 长时业务工具（内部入口一侧）：登记请求、等待并取回结果。succeeded 返回结果；rejected 422 AGENT_TOOL_REJECTED（说明是任务代码的
 * 固定文字，交给 Agent 修正）；failed 503 AGENT_TOOL_FAILED（Agent 只得到固定说明，执行者同时按致命错误结束本次执行）；
 * 未完成返回 { completed: false, pending: true }。
 */
export function createAgentLongTool(options: AgentLongToolOptions): AgentToolDefinition<Record<string, unknown>, unknown> {
  if (!Number.isSafeInteger(options.maxArgumentBytes) || options.maxArgumentBytes > AGENT_TOOL_REQUEST_ARGS_MAX_BYTES) {
    throw new TypeError(`长时工具 ${options.name} 的参数上限不能超过 ${AGENT_TOOL_REQUEST_ARGS_MAX_BYTES} 字节`);
  }
  const waitMs = options.waitMs ?? AGENT_LONG_TOOL_WAIT_MS;
  const pollMs = options.pollMs ?? AGENT_LONG_TOOL_POLL_MS;
  return {
    name: options.name,
    argumentsSchema: options.argumentsSchema,
    maxArgumentBytes: options.maxArgumentBytes,
    maxCallsPerJob: options.maxCallsPerJob,
    maxCallsPerMinute: options.maxCallsPerMinute,
    async run(context, args): Promise<unknown> {
      const finished = await waitForAgentToolRequest(context, options.name, args, { waitMs, pollMs });
      if (finished === null) return { completed: false, pending: true, message: PENDING_MESSAGE } satisfies AgentLongToolPending;
      if (finished.outcome === 'succeeded') return finished.result;
      if (finished.outcome === 'rejected') throw new AppError(422, 'AGENT_TOOL_REJECTED', finished.message);
      throw new AppError(503, 'AGENT_TOOL_FAILED', AGENT_TOOL_FAILED_MESSAGE);
    },
  };
}

// ---- 执行者一侧 ----

/**
 * 执行函数拒绝本次请求（如任务文件不合法）：说明作为工具错误交给 Agent，本次执行继续。说明必须是任务代码给出的固定文字
 * （可以带上 Agent 给出的小节 id 等经过校验的标识），不含模型写出的内容；超过 AGENT_TOOL_REQUEST_MESSAGE_MAX_LENGTH 个字符时截短。
 */
export class AgentToolRequestRejection extends Error {
  constructor(message: string) {
    const text = Array.from(message.trim()).slice(0, AGENT_TOOL_REQUEST_MESSAGE_MAX_LENGTH).join('');
    super(text === '' ? AGENT_TOOL_FAILED_MESSAGE : text);
    this.name = 'AgentToolRequestRejection';
  }
}

export interface AgentToolRequestExecution {
  /** 请求 id（日志用）。 */
  readonly requestId: string;
  /** 按工具 schema 校验过的参数（来自沙箱，不可信：其中的资源标识须重新解析）。 */
  readonly args: Record<string, unknown>;
  /** 本条提示词结束、任务被取消或暂停时中止。 */
  readonly signal: AbortSignal;
}

/** 长时工具的执行函数（任务代码在 AgentPromptInput.longTools 中给出）。 */
export type AgentLongToolExecutor = (request: AgentToolRequestExecution) => Promise<unknown>;

export interface ClaimedAgentToolRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** 认领本次执行中这些工具的一个待执行请求（执行者）；没有时 null。 */
export async function claimAgentToolRequest(db: Kysely<Database>, ref: AgentToolRequestRef, tools: readonly string[]): Promise<ClaimedAgentToolRequest | null> {
  if (tools.length === 0) return null;
  return withTenant(db, ref.tenant, async (trx) => {
    if (!(await lockCurrentRun(trx, ref))) return null;
    const row = await trx
      .selectFrom('agent_tool_requests')
      .select(['id', 'tool', 'args'])
      .where('job_id', '=', ref.jobId)
      .where('run_id', '=', ref.runId)
      .where('status', '=', 'pending')
      .where('tool', 'in', tools)
      .orderBy('created_at')
      .forUpdate()
      .executeTakeFirst();
    if (!row) return null;
    await trx.updateTable('agent_tool_requests').set({ status: 'running' }).where('id', '=', row.id).execute();
    return { id: row.id, tool: row.tool, args: row.args };
  });
}

/** 写下结果（执行者）。succeeded 的结果不能序列化或过大时按 failed 写下并返回 false。 */
export async function finishAgentToolRequest(db: Kysely<Database>, ref: AgentToolRequestRef, requestId: string, result: AgentToolRequestResult): Promise<boolean> {
  let set: { status: 'finished'; outcome: AgentToolRequestOutcome; result: string | null; message: string | null };
  let accepted = true;
  if (result.outcome === 'succeeded') {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(result.result ?? null);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > AGENT_TOOL_REQUEST_RESULT_MAX_BYTES) {
      accepted = false;
      set = { status: 'finished', outcome: 'failed', result: null, message: null };
    } else {
      set = { status: 'finished', outcome: 'succeeded', result: serialized, message: null };
    }
  } else if (result.outcome === 'rejected') {
    set = { status: 'finished', outcome: 'rejected', result: null, message: new AgentToolRequestRejection(result.message).message };
  } else {
    set = { status: 'finished', outcome: 'failed', result: null, message: null };
  }
  await withTenant(db, ref.tenant, (trx) =>
    trx.updateTable('agent_tool_requests').set(set).where('id', '=', requestId).where('job_id', '=', ref.jobId).where('status', '=', 'running').execute(),
  );
  return accepted;
}

export interface ServeAgentToolRequestsOptions {
  db: Kysely<Database>;
  ref: AgentToolRequestRef;
  executors: ReadonlyMap<string, AgentLongToolExecutor>;
  /** 本条提示词结束时中止（停止认领；执行中的请求随之中止、按 failed 写下）。 */
  signal: AbortSignal;
  pollMs?: number;
}

/**
 * 在本条提示词执行期间依次认领并执行请求，直到 signal 中止。返回致命错误（执行函数抛出 AgentToolRequestRejection 以外的错误、
 * 结果不能保存、数据库操作失败）或 null（正常停止）。有致命错误时立即停止，调用方据此中止入口。
 */
export async function serveAgentToolRequests(options: ServeAgentToolRequestsOptions): Promise<unknown> {
  const { db, ref, executors, signal } = options;
  const pollMs = options.pollMs ?? AGENT_TOOL_REQUEST_SERVE_POLL_MS;
  const tools = [...executors.keys()];
  if (tools.length === 0) return null;
  while (!signal.aborted) {
    let claimed: ClaimedAgentToolRequest | null;
    try {
      claimed = await claimAgentToolRequest(db, ref, tools);
    } catch (error) {
      return error;
    }
    if (!claimed) {
      await sleep(pollMs, signal);
      continue;
    }
    const executor = executors.get(claimed.tool)!;
    let outcome: AgentToolRequestResult;
    let fatal: unknown = null;
    try {
      outcome = { outcome: 'succeeded', result: await executor({ requestId: claimed.id, args: claimed.args, signal }) };
    } catch (error) {
      if (error instanceof AgentToolRequestRejection) {
        outcome = { outcome: 'rejected', message: error.message };
      } else {
        outcome = { outcome: 'failed' };
        fatal = error;
      }
    }
    try {
      const accepted = await finishAgentToolRequest(db, ref, claimed.id, outcome);
      if (!accepted) fatal ??= new Error(`agent tool ${claimed.tool} returned an oversized or invalid result`);
    } catch (error) {
      fatal ??= error;
    }
    if (fatal !== null) return fatal;
  }
  return null;
}
