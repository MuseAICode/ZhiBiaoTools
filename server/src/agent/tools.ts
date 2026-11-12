// Agent 业务工具 RPC 框架（路线图第 8 步 8.4a；docs/SERVER_DESIGN.md 第 7.15 节；“第 8 步说明”第 1 项“业务工具 RPC，服务端逐一校验”）。
//
// 沙箱内的业务工具只是桩：Pi 调用工具时，沙箱内的入口经 agent-gw 把 { name, arguments } 发到 worker 内部入口的
// POST /v1/tools/call，由这里登记的处理函数执行。请求来自沙箱，按攻击者的输入处理：
//
// 1. **工具名**：只接受登记过、且本任务类型（JobTypeDefinition.agentTools）登记可用的工具；未登记与本任务类型不可用的
//    一律 404 AGENT_TOOL_NOT_FOUND，不区分两者；
// 2. **身份只按令牌**（agentIdentityOf）：组织、项目、任务、发起用户由服务端按令牌查出，处理函数拿到的是令牌身份与据此建立的
//    TenantContext（发起用户的身份与 RLS）；请求中自称的组织、项目、任务、用户等字段没有位置（请求体顶层只有 name 与 arguments，
//    arguments 的 schema 由工具登记且必须是封闭的：每个对象都 additionalProperties: false）；
// 3. **调用次数与频率**：每个任务对每个工具有累计次数上限（跨执行累计）与每分钟的频率上限，在执行之前原子地计入
//    （迁移 0037_agent_tool_calls），参数不合法的调用同样计入，达到上限 429；任务不在本次执行中 409；
// 4. **参数**：先查字节数（工具自己的上限，超出 413），再按登记的 schema 校验（不做类型转换，不合法 400，错误说明只含
//    参数中的位置与 schema 的要求，供模型修正）；
// 5. **资源标识**：参数中的每个资源标识都是不可信输入，处理函数按令牌身份在本项目范围内重新解析（resolveProjectArtifact 等），
//    查不到即 404 AGENT_RESOURCE_NOT_FOUND，不区分“不存在”和“无权访问”；
// 6. **结果**：处理函数返回可 JSON 序列化的值，响应 { result }；超过 AGENT_TOOL_MAX_RESULT_BYTES 按内部错误处理。
//
// 日志只记工具名、任务 id、令牌哈希前缀、耗时与结果码，不记参数与结果。
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { AGENT_TOOL_NAME_PATTERN } from '../db/migrations/0037_agent_tool_calls.ts';
import type { ArtifactKind } from '../artifacts/store.ts';
import type { ArtifactStatus, Database } from '../db/schema.ts';
import { withTenant, type TenantContext } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { AGENT_TOOL_CALL_PATH, AGENT_TOOL_MAX_BODY_BYTES } from './gateway.ts';
import { findAgentFailureReport, noAgentFailureReport } from './failureReport.ts';
import { agentTenantContext, type AgentTokenIdentity } from './tokenStore.ts';

export { AGENT_TOOL_CALL_PATH, AGENT_TOOL_MAX_BODY_BYTES } from './gateway.ts';

/** 一个工具的参数（序列化后）至多的字节数：请求体上限减去 name 等外层字段的余量。 */
export const AGENT_TOOL_MAX_ARGUMENT_BYTES = AGENT_TOOL_MAX_BODY_BYTES - 1024;
/** 处理函数返回结果（序列化后）至多的字节数。 */
export const AGENT_TOOL_MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** 每个任务对一个工具的累计调用次数可以登记的最大值。 */
export const AGENT_TOOL_MAX_CALLS_PER_JOB = 100_000;
/** 每个任务对一个工具每分钟的调用次数可以登记的最大值。 */
export const AGENT_TOOL_MAX_CALLS_PER_MINUTE = 600;
/** 频率窗口的长度（秒）。 */
export const AGENT_TOOL_RATE_WINDOW_SECONDS = 60;
/** schema 的最大嵌套层数（登记时检查）。 */
const MAX_SCHEMA_DEPTH = 16;
/** 返回给模型的参数错误条数。 */
const MAX_REPORTED_ERRORS = 5;

const TOOL_NAME = new RegExp(AGENT_TOOL_NAME_PATTERN);

/** 工具参数的 JSON Schema（只允许下面登记的关键字，见 assertClosedSchema）。 */
export type AgentToolSchema = Readonly<Record<string, unknown>>;

/** 处理函数拿到的上下文：身份全部按令牌查出，不来自请求。 */
export interface AgentToolContext {
  readonly identity: AgentTokenIdentity;
  /** 发起用户的身份（RLS）：业务读写经 withTenant(db, tenant, ...) 进行。 */
  readonly tenant: TenantContext;
  readonly db: Kysely<Database>;
  /** 沙箱断开、worker 关闭时中止。 */
  readonly signal: AbortSignal;
  readonly log: FastifyBaseLogger;
  /** 通知执行该任务的执行者立即续租一次（经任务控制频道），让它马上发现工具写下的状态（如失败报告）。失败时只写日志。 */
  notifyExecutor(): Promise<void>;
}

export interface AgentToolDefinition<A = any, R = unknown> {
  /** 工具名（小写字母、数字与连字符，2～64 个字符）。 */
  readonly name: string;
  /** 参数的 schema：顶层必须是对象，每个对象 additionalProperties: false，字符串有 maxLength，数组有 maxItems。 */
  readonly argumentsSchema: AgentToolSchema;
  /** 参数序列化后的字节数上限（≤ AGENT_TOOL_MAX_ARGUMENT_BYTES）。 */
  readonly maxArgumentBytes: number;
  /** 每个任务累计调用次数上限（1～AGENT_TOOL_MAX_CALLS_PER_JOB，跨执行累计）。 */
  readonly maxCallsPerJob: number;
  /** 每个任务每分钟调用次数上限（1～AGENT_TOOL_MAX_CALLS_PER_MINUTE）。 */
  readonly maxCallsPerMinute: number;
  /** 执行。参数已按 schema 校验；其中的资源标识仍是不可信输入，须在本项目范围内重新解析。 */
  run(context: AgentToolContext, args: A): Promise<R>;
}

export interface AgentToolRegistry {
  get(name: string): AgentToolDefinition | undefined;
  readonly names: readonly string[];
}

export function isValidAgentToolName(name: unknown): name is string {
  return typeof name === 'string' && TOOL_NAME.test(name);
}

const SCHEMA_KEYWORDS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'enum',
  'const',
  'minimum',
  'maximum',
  'anyOf',
]);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const SCHEMA_FORMATS = new Set(['uuid']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * 登记时检查参数 schema 是封闭的：只用 SCHEMA_KEYWORDS 中的关键字（没有 $ref、patternProperties、if / then 等）；
 * 每个节点给出 type（单个类型）、enum、const 或 anyOf 之一；对象 additionalProperties: false 且 required 中的属性都有定义；
 * 字符串有 maxLength；数组有 items 与 maxItems；嵌套不超过 MAX_SCHEMA_DEPTH 层。不合格时抛 TypeError（启动时失败）。
 */
export function assertClosedSchema(schema: unknown, path = 'arguments', depth = 0): void {
  const fail = (message: string): never => {
    throw new TypeError(`工具参数 schema 不合法（${path}）：${message}`);
  };
  if (depth > MAX_SCHEMA_DEPTH) fail('嵌套过深');
  if (!isPlainObject(schema)) fail('必须是对象');
  const node = schema as Record<string, unknown>;
  for (const key of Object.keys(node)) if (!SCHEMA_KEYWORDS.has(key)) fail(`不允许的关键字 ${key}`);
  if (node.description !== undefined && typeof node.description !== 'string') fail('description 必须是字符串');

  if (node.anyOf !== undefined) {
    if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) fail('anyOf 必须是非空数组');
    if (Object.keys(node).some((key) => key !== 'anyOf' && key !== 'description')) fail('anyOf 不能与其他关键字一起使用');
    (node.anyOf as unknown[]).forEach((branch, index) => assertClosedSchema(branch, `${path}.anyOf[${index}]`, depth + 1));
    return;
  }
  if (node.const !== undefined || node.enum !== undefined) {
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) fail('enum 必须是非空数组');
    const values = node.enum !== undefined ? (node.enum as unknown[]) : [node.const];
    if (!values.every((value) => value === null || ['string', 'number', 'boolean'].includes(typeof value))) fail('enum / const 只能是标量');
    if (node.type !== undefined && (typeof node.type !== 'string' || !SCHEMA_TYPES.has(node.type))) fail('type 不合法');
    return;
  }
  if (typeof node.type !== 'string' || !SCHEMA_TYPES.has(node.type)) fail('必须给出单个 type');
  const only = (allowed: readonly string[]) => {
    for (const key of Object.keys(node)) if (key !== 'type' && key !== 'description' && !allowed.includes(key)) fail(`${node.type} 不能使用 ${key}`);
  };
  switch (node.type) {
    case 'object': {
      only(['properties', 'required', 'additionalProperties']);
      if (node.additionalProperties !== false) fail('对象必须 additionalProperties: false');
      if (!isPlainObject(node.properties)) fail('对象必须给出 properties');
      const properties = node.properties as Record<string, unknown>;
      const required = node.required ?? [];
      if (!Array.isArray(required) || !required.every((name) => typeof name === 'string' && Object.hasOwn(properties, name))) fail('required 只能列出已定义的属性');
      for (const [name, child] of Object.entries(properties)) assertClosedSchema(child, `${path}.${name}`, depth + 1);
      return;
    }
    case 'array':
      only(['items', 'minItems', 'maxItems', 'uniqueItems']);
      if (!Number.isSafeInteger(node.maxItems)) fail('数组必须给出 maxItems');
      assertClosedSchema(node.items, `${path}[]`, depth + 1);
      return;
    case 'string':
      only(['minLength', 'maxLength', 'pattern', 'format']);
      if (!Number.isSafeInteger(node.maxLength)) fail('字符串必须给出 maxLength');
      if (node.pattern !== undefined && typeof node.pattern !== 'string') fail('pattern 必须是字符串');
      if (node.format !== undefined && !SCHEMA_FORMATS.has(node.format as string)) fail('format 只能是 uuid');
      return;
    case 'integer':
    case 'number':
      only(['minimum', 'maximum']);
      return;
    default:
      only([]);
  }
}

function assertLimit(name: string, field: string, value: unknown, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new TypeError(`工具 ${name} 的 ${field} 必须是 1～${max} 的整数`);
  }
}

export function createAgentToolRegistry(tools: readonly AgentToolDefinition<any, any>[]): AgentToolRegistry {
  const byName = new Map<string, AgentToolDefinition>();
  for (const tool of tools) {
    if (!isValidAgentToolName(tool.name)) throw new TypeError(`工具名不合法：${String(tool.name)}`);
    if (byName.has(tool.name)) throw new TypeError(`工具重复登记：${tool.name}`);
    if (typeof tool.run !== 'function') throw new TypeError(`工具 ${tool.name} 没有处理函数`);
    assertLimit(tool.name, 'maxArgumentBytes', tool.maxArgumentBytes, AGENT_TOOL_MAX_ARGUMENT_BYTES);
    assertLimit(tool.name, 'maxCallsPerJob', tool.maxCallsPerJob, AGENT_TOOL_MAX_CALLS_PER_JOB);
    assertLimit(tool.name, 'maxCallsPerMinute', tool.maxCallsPerMinute, AGENT_TOOL_MAX_CALLS_PER_MINUTE);
    const schema = tool.argumentsSchema as Record<string, unknown>;
    if (!isPlainObject(schema) || schema.type !== 'object') throw new TypeError(`工具 ${tool.name} 的参数必须是对象`);
    assertClosedSchema(schema);
    byName.set(tool.name, Object.freeze({ ...tool }));
  }
  return Object.freeze({ get: (name: string) => byName.get(name), names: Object.freeze([...byName.keys()]) });
}

/** 启动时检查：每个任务类型登记可用的工具都已登记（worker.ts 调用）。 */
export function assertAgentToolsRegistered(jobTypes: readonly { type: string; agentTools?: readonly string[] }[], registry: AgentToolRegistry): void {
  for (const definition of jobTypes) {
    for (const name of definition.agentTools ?? []) {
      if (!registry.get(name)) throw new TypeError(`任务类型 ${definition.type} 登记了未定义的工具 ${name}`);
    }
  }
}

export type AgentToolCallOutcome = 'not-running' | 'call-limit' | 'rate-limit';

export interface AgentToolCallRef {
  /** 按令牌查出的身份（不来自请求）。 */
  tenant: TenantContext;
  jobId: string;
  runId: string;
  tool: string;
  maxCallsPerJob: number;
  maxCallsPerMinute: number;
}

/**
 * 计入一次工具调用：一条 INSERT ... ON CONFLICT DO UPDATE 原子地检查并递增——任务仍是本次执行（running、run_id 相符）且是
 * 登记了上限的 Agent 任务、本次执行没有报告无法继续（8.4b）、累计次数小于上限、当前一分钟窗口内的次数小于频率上限（窗口已过则从 now() 重新计数）。
 * 计入成功返回 null，否则返回原因（不计入）。
 */
export async function beginAgentToolCall(db: Kysely<Database>, ref: AgentToolCallRef): Promise<AgentToolCallOutcome | null> {
  return withTenant(db, ref.tenant, async (trx) => {
    const window = sql`make_interval(secs => ${AGENT_TOOL_RATE_WINDOW_SECONDS})`;
    const counted = await sql<{ calls: number }>`
      INSERT INTO agent_tool_calls (org_id, job_id, tool)
      SELECT ${ref.tenant.orgId}::uuid, ${ref.jobId}::uuid, ${ref.tool}
      WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = ${ref.tenant.orgId}::uuid AND j.id = ${ref.jobId}::uuid
                      AND j.status = 'running' AND j.run_id = ${ref.runId}::uuid)
        AND EXISTS (SELECT 1 FROM agent_job_budgets b WHERE b.org_id = ${ref.tenant.orgId}::uuid AND b.job_id = ${ref.jobId}::uuid)
        AND ${noAgentFailureReport(ref.jobId, ref.runId)}
      ON CONFLICT (job_id, tool) DO UPDATE SET
        calls = agent_tool_calls.calls + 1,
        window_started_at = CASE WHEN agent_tool_calls.window_started_at <= now() - ${window} THEN now() ELSE agent_tool_calls.window_started_at END,
        window_calls = CASE WHEN agent_tool_calls.window_started_at <= now() - ${window} THEN 1 ELSE agent_tool_calls.window_calls + 1 END
      WHERE agent_tool_calls.calls < ${ref.maxCallsPerJob}
        AND ${noAgentFailureReport(ref.jobId, ref.runId)}
        AND (agent_tool_calls.window_started_at <= now() - ${window} OR agent_tool_calls.window_calls < ${ref.maxCallsPerMinute})
      RETURNING calls`.execute(trx);
    if (counted.rows.length > 0) return null;

    const job = await trx.selectFrom('jobs').select(['status', 'run_id']).where('id', '=', ref.jobId).executeTakeFirst();
    if (!job || job.status !== 'running' || job.run_id !== ref.runId) return 'not-running';
    // Agent 已报告无法继续（8.4b）：本次执行即将结束，之后的工具调用按不在执行中处理。
    if ((await findAgentFailureReport(trx, ref.jobId, ref.runId)) !== null) return 'not-running';
    const row = await trx.selectFrom('agent_tool_calls').select('calls').where('job_id', '=', ref.jobId).where('tool', '=', ref.tool).executeTakeFirst();
    // 没有行：任务没有登记上限（不是 Agent 任务），按不在执行中处理。
    if (!row) return 'not-running';
    return row.calls >= ref.maxCallsPerJob ? 'call-limit' : 'rate-limit';
  });
}

/** 资源标识查不到（不存在、不属于本项目、不属于本组织）：一律同一个错误，不区分原因。 */
export function agentResourceNotFound(): AppError {
  return new AppError(404, 'AGENT_RESOURCE_NOT_FOUND', '资源不存在或不属于本项目');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 资源标识的格式：小写的 UUID；格式不对按查不到处理（不查库）。 */
export function parseAgentResourceId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw agentResourceNotFound();
  return value;
}

export interface AgentProjectArtifact {
  id: string;
  kind: ArtifactKind;
  name: string;
  mime: string;
  status: ArtifactStatus;
  sizeBytes: number | null;
}

/**
 * 在本项目范围内重新解析产物 id（在 withTenant(db, context.tenant, ...) 的事务中调用，RLS 限定本组织）：产物须属于令牌的项目、
 * 已完成且未被替换；否则 404 AGENT_RESOURCE_NOT_FOUND。
 */
export async function resolveProjectArtifact(trx: Transaction<Database>, context: AgentToolContext, id: unknown): Promise<AgentProjectArtifact> {
  const artifactId = parseAgentResourceId(id);
  const row = await trx
    .selectFrom('artifacts')
    .select(['id', 'kind', 'name', 'mime', 'status', 'size_bytes'])
    .where('id', '=', artifactId)
    .where('org_id', '=', context.identity.orgId)
    .where('project_id', '=', context.identity.projectId)
    .where('status', '=', 'ready')
    .where('superseded_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw agentResourceNotFound();
  return { id: row.id, kind: row.kind, name: row.name, mime: row.mime, status: row.status, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes) };
}

export interface AgentToolRouteDependencies {
  db: Kysely<Database>;
  tools: AgentToolRegistry;
  /** 任务类型登记可用的工具名（JobTypeDefinition.agentTools）。 */
  toolsForJobType: (jobType: string) => readonly string[];
  identityOf: (request: FastifyRequest) => AgentTokenIdentity;
  /** 登记进行中的调用，worker 关闭时统一中止；返回注销函数。 */
  track: (controller: AbortController) => () => void;
  /** 通知执行者立即检查该任务（src/events/publisher.ts 的 notifyJobControl）；不传时执行者在下一次定期续租时发现。 */
  notifyJobControl?: (jobId: string) => Promise<void>;
  /** 测试用：替换计数。 */
  beginCall?: typeof beginAgentToolCall;
}

interface ToolCallBody {
  name: string;
  arguments: Record<string, unknown>;
}

function toolNotFound(): AppError {
  return new AppError(404, 'AGENT_TOOL_NOT_FOUND', '工具不存在或本任务不能使用');
}

/** 请求体 schema：顶层只有 name 与 arguments；arguments 按工具名套用该工具的 schema（if / then，由平台生成）。 */
export function agentToolCallBodySchema(tools: AgentToolRegistry): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'arguments'],
    properties: { name: { type: 'string', maxLength: 64 }, arguments: { type: 'object' } },
  };
  if (tools.names.length > 0) {
    schema.allOf = tools.names.map((name) => ({
      if: { properties: { name: { const: name } }, required: ['name'] },
      then: { properties: { arguments: tools.get(name)!.argumentsSchema } },
    }));
  }
  return schema;
}

interface ValidationIssue {
  keyword?: string;
  instancePath?: string;
  message?: string;
}

/** 参数错误的说明：只含参数中的位置与 schema 的要求（工具的 schema 本来就给了模型），不含请求原文。 */
function describeValidation(error: { validation?: ValidationIssue[] } | undefined): string {
  const issues = (error?.validation ?? []).filter((issue) => issue.keyword !== 'if' && issue.keyword !== 'allOf');
  const parts = issues.slice(0, MAX_REPORTED_ERRORS).map((issue) => {
    const where = (issue.instancePath ?? '').replace(/^\/arguments/, '') || '/';
    return `${where.slice(0, 200)} ${(issue.message ?? '不符合要求').slice(0, 200)}`;
  });
  return parts.length > 0 ? `工具参数不合法：${parts.join('；')}` : '工具参数不合法';
}

export function registerAgentToolRoute(app: FastifyInstance, deps: AgentToolRouteDependencies): void {
  const beginCall = deps.beginCall ?? beginAgentToolCall;
  const allowed = (identity: AgentTokenIdentity, name: unknown): AgentToolDefinition | null => {
    if (!isValidAgentToolName(name)) return null;
    const tool = deps.tools.get(name);
    if (!tool || !deps.toolsForJobType(identity.jobType).includes(name)) return null;
    return tool;
  };

  app.post<{ Body: ToolCallBody }>(
    AGENT_TOOL_CALL_PATH,
    {
      bodyLimit: AGENT_TOOL_MAX_BODY_BYTES,
      schema: { body: agentToolCallBodySchema(deps.tools) },
      // 校验失败也进入处理函数：先按工具名放行、计入次数，再返回说明（参数不合法的调用同样计入）。
      attachValidation: true,
      // 工具名在校验参数之前检查：未登记或本任务类型不可用的一律 404。
      preValidation: async (request) => {
        const body = request.body as unknown;
        const name = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).name : undefined;
        if (!allowed(deps.identityOf(request), name)) throw toolNotFound();
      },
    },
    async (request: FastifyRequest<{ Body: ToolCallBody }>, reply: FastifyReply) => {
      const identity = deps.identityOf(request);
      const tool = allowed(identity, request.body.name);
      if (!tool) throw toolNotFound();
      const tenant = agentTenantContext(identity);
      const started = Date.now();
      const logCall = (code: string) =>
        request.log.info({ tool: tool.name, jobId: identity.jobId, tokenId: identity.logId, ms: Date.now() - started, code }, 'agent tool call');

      const outcome = await beginCall(deps.db, {
        tenant,
        jobId: identity.jobId,
        runId: identity.runId,
        tool: tool.name,
        maxCallsPerJob: tool.maxCallsPerJob,
        maxCallsPerMinute: tool.maxCallsPerMinute,
      });
      if (outcome !== null) {
        logCall(outcome);
        if (outcome === 'not-running') throw new AppError(409, 'JOB_NOT_RUNNING', '任务不在执行中，不能调用工具');
        if (outcome === 'call-limit') throw new AppError(429, 'AGENT_TOOL_CALL_LIMIT', `本任务调用工具 ${tool.name} 的次数已达到上限`);
        throw new AppError(429, 'AGENT_TOOL_RATE_LIMIT', `调用工具 ${tool.name} 过于频繁，请稍后再试`);
      }
      // 参数“形状”不对（不是对象等）时 validationError 已经给出；字节数按序列化后的参数计。
      const args = request.body.arguments;
      if (typeof args === 'object' && args !== null && Buffer.byteLength(JSON.stringify(args), 'utf8') > tool.maxArgumentBytes) {
        logCall('too-large');
        throw new AppError(413, 'AGENT_TOOL_ARGUMENTS_TOO_LARGE', `工具 ${tool.name} 的参数过大`);
      }
      if (request.validationError) {
        logCall('invalid');
        throw new AppError(400, 'AGENT_TOOL_INVALID_ARGUMENTS', describeValidation(request.validationError as { validation?: ValidationIssue[] }));
      }

      const controller = new AbortController();
      const untrack = deps.track(controller);
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished && !controller.signal.aborted) controller.abort('client');
      });
      let result: unknown;
      try {
        const notifyExecutor = async () => {
          await deps.notifyJobControl?.(identity.jobId).catch((error: unknown) => request.log.warn({ err: error, jobId: identity.jobId }, 'job control notify failed'));
        };
        result = await tool.run({ identity, tenant, db: deps.db, signal: controller.signal, log: request.log, notifyExecutor }, args);
      } catch (error) {
        logCall(error instanceof AppError ? error.code : 'error');
        throw error;
      } finally {
        untrack();
      }
      const body = JSON.stringify({ result: result ?? null });
      if (Buffer.byteLength(body, 'utf8') > AGENT_TOOL_MAX_RESULT_BYTES) {
        logCall('result-too-large');
        throw new Error(`agent tool ${tool.name} returned an oversized result`);
      }
      logCall('ok');
      reply.header('cache-control', 'no-store');
      return reply.type('application/json; charset=utf-8').send(body);
    },
  );
}
