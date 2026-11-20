// Agent 任务用量统计：node src/cli/agent-task-usage.ts --org <组织 id> [--since <时间>] [--until <时间>] [--min-samples <n>]
// （编译后为 dist/cli/agent-task-usage.js，npm run agent:usage）。路线图第 8 步 8.7f1，供 8.7f2 按真实任务 P95 的 2 倍重定 AGENT_TASK_LIMITS。
//
// - 只读：用应用角色连接（DATABASE_USER / DATABASE_PASSWORD[_FILE]），按组织上下文查询，RLS 只放行该组织的数据；
// - 统计窗口内成功完成的 Agent 任务，按任务类型输出轮数与费用的 P50 / P95 / 最大值、起步值、本组织的覆盖值与建议上限
//   （src/agent/usageStats.ts）；
// - 输出一行 JSON（stdout），不含项目、用户、任务参数等内容。
import { parseArgs } from 'node:util';
import { Kysely, PostgresDialect } from 'kysely';
import { readAgentTaskUsage, summarizeAgentTaskUsage, usageSummaryToJson, DEFAULT_MIN_SAMPLES } from '../agent/usageStats.ts';
import type { AgentTaskLimits } from '../agent/budget.ts';
import { ConfigError, loadAppDatabaseConfig } from '../config.ts';
import { createPool } from '../db/database.ts';
import type { Database } from '../db/schema.ts';
import { JOB_TYPES } from '../jobs/registry.ts';

const USAGE = '用法：agent-task-usage --org <组织 id> [--since <ISO 时间>] [--until <ISO 时间>] [--min-samples <正整数>]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function writeLine(stream: NodeJS.WriteStream, entry: Record<string, unknown>): void {
  stream.write(`${JSON.stringify({ time: Date.now(), ...entry })}\n`);
}

function fail(msg: string, extra: Record<string, unknown> = {}): never {
  writeLine(process.stderr, { level: 'fatal', msg, ...extra });
  process.exit(1);
}

function parseTime(raw: string | undefined, name: string): Date | undefined {
  if (raw === undefined) return undefined;
  const time = new Date(raw);
  if (Number.isNaN(time.getTime())) fail(`${name} 不是合法的时间`);
  return time;
}

let values;
try {
  ({ values } = parseArgs({
    options: { org: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, 'min-samples': { type: 'string' } },
    strict: true,
  }));
} catch {
  fail(USAGE);
}
const orgId = values.org;
if (!orgId || !UUID.test(orgId)) fail(USAGE);
const since = parseTime(values.since, '--since');
const until = parseTime(values.until, '--until');
if (since && until && since >= until) fail('--since 须早于 --until');
const minSamples = values['min-samples'] === undefined ? DEFAULT_MIN_SAMPLES : Number(values['min-samples']);
if (!Number.isSafeInteger(minSamples) || minSamples < 1) fail(USAGE);

let config;
try {
  config = loadAppDatabaseConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) fail(error.message, { issues: error.issues });
  throw error;
}

const agentTypes = new Map<string, AgentTaskLimits>();
for (const definition of JOB_TYPES) if (definition.agentLimits) agentTypes.set(definition.type, definition.agentLimits);

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: createPool(config, { maxConnections: 1, applicationName: 'bidtools-agent-task-usage' }) }),
});
let summaries;
try {
  const input = await readAgentTaskUsage(db, orgId, [...agentTypes.keys()], { ...(since ? { since } : {}), ...(until ? { until } : {}) });
  summaries = summarizeAgentTaskUsage(input, agentTypes, { minSamples });
} catch (error) {
  await db.destroy();
  fail('统计失败', { error: error instanceof Error ? error.message : String(error) });
}
await db.destroy();
writeLine(process.stdout, {
  level: 'info',
  msg: 'agent task usage',
  orgId,
  since: since?.toISOString() ?? null,
  until: until?.toISOString() ?? null,
  minSamples,
  types: summaries.map(usageSummaryToJson),
});
