// 事件推送的 Redis 键与脚本（docs/SERVER_DESIGN.md 第 5.5 节；路线图第 6 步 6.3）。
//
// 每个组织一条 Stream（stream:org:{orgId}）和一个频道（events:org:{orgId}）。发布用一个 Lua 脚本原子地完成：
// XADD 追加（Stream ID 由 Redis 生成、单调递增）→ 按条数和时间窗口裁剪 → 刷新过期时间 → 向频道 PUBLISH “ID 空格 JSON”。
// 补发（Last-Event-ID）同样用一个脚本：判断上次收到的 ID 之后有没有被裁剪掉的事件，有就要求前端重新拉快照（resync），
// 没有就返回之后的全部事件。Redis 不持久化（第 8.4 节），事件可丢；丢了的由 resync 兜底，任务状态的权威始终是 jobs 表。

/** Stream 只保留最近这么多条、这么长时间内的事件（第 5.5 节）。 */
export const EVENT_STREAM_MAX_LENGTH = 1000;
export const EVENT_STREAM_WINDOW_MS = 10 * 60_000;
/** 单个事件序列化后的上限；超过的是程序错误。 */
export const EVENT_MAX_BYTES = 64 * 1024;
/** 事件类型（SSE 的 event: 字段）。 */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
/** Redis Stream ID：毫秒时间戳-序号。 */
export const STREAM_ID_PATTERN = /^\d{1,20}-\d{1,20}$/;

export interface OrgEvent {
  /** SSE 的 event: 字段，例如 job、job.progress、job.log。 */
  type: string;
  data: Record<string, unknown>;
  /** 只推给本组织的这个用户；不设置时推给本组织的全部连接。 */
  userId?: string;
}

/** 从 Stream 或频道读出的事件。 */
export interface StreamEvent extends OrgEvent {
  id: string;
}

export function orgStreamKey(prefix: string, orgId: string): string {
  return `${prefix}stream:org:${orgId}`;
}

export function orgChannel(prefix: string, orgId: string): string {
  return `${prefix}events:org:${orgId}`;
}

/** 比较两个 Stream ID；格式已经过 STREAM_ID_PATTERN 校验。 */
export function compareStreamIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split('-').map(BigInt) as [bigint, bigint];
  const [bMs, bSeq] = b.split('-').map(BigInt) as [bigint, bigint];
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}

/** 解析 Stream 或频道中的一条事件；格式不对（不应发生）时返回 null。 */
export function parseStreamEvent(id: string, json: string): StreamEvent | null {
  if (!STREAM_ID_PATTERN.test(id)) return null;
  try {
    const value = JSON.parse(json) as Partial<OrgEvent> | null;
    if (!value || typeof value !== 'object' || typeof value.type !== 'string' || !EVENT_TYPE_PATTERN.test(value.type)) return null;
    if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return null;
    if (value.userId !== undefined && typeof value.userId !== 'string') return null;
    return { id, type: value.type, data: value.data, ...(value.userId !== undefined ? { userId: value.userId } : {}) };
  } catch {
    return null;
  }
}

// KEYS[1] Stream，KEYS[2] 频道；ARGV[1] 事件 JSON，ARGV[2] 最多条数，ARGV[3] 时间窗口（毫秒）。返回 Stream ID。
// 时间取 Redis 的 TIME，与 XADD 生成 ID 用的是同一个时钟。
export const PUBLISH_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '=', ARGV[2], '*', 'e', ARGV[1])
redis.call('XTRIM', KEYS[1], 'MINID', '=', string.format('%d', now - tonumber(ARGV[3])))
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PUBLISH', KEYS[2], id .. ' ' .. ARGV[1])
return id
`;

// KEYS[1] Stream；ARGV[1] 上次收到的 ID，ARGV[2] 最多返回条数。
// 返回 {'resync'}：Stream 不存在（过期、Redis 重启或被清空）、上次的 ID 比最后生成的还大（不是这条 Stream 生成的），
// 或上次的 ID 比下限还小；否则返回 {'ok', XRANGE 的结果}。下限：裁剪过就是被裁掉的最大 ID（max-deleted-entry-id，
// 上次的 ID 更小说明之后有事件已被裁掉），没裁剪过就是第一条的 ID（更小说明它来自已过期的上一条同名 Stream，
// 两条 Stream 之间的事件可能已丢失）。
export const REPLAY_SCRIPT = `
local function parse(id)
  local ms, seq = string.match(id, '^(%d+)-(%d+)$')
  return tonumber(ms), tonumber(seq)
end
local function greater(a, b)
  local am, as = parse(a)
  local bm, bs = parse(b)
  if am ~= bm then return am > bm end
  return as > bs
end
if redis.call('EXISTS', KEYS[1]) == 0 then return {'resync'} end
local info = redis.call('XINFO', 'STREAM', KEYS[1])
local lastGenerated, maxDeleted, firstEntry = '0-0', '0-0', nil
for i = 1, #info, 2 do
  if info[i] == 'last-generated-id' then lastGenerated = info[i + 1] end
  if info[i] == 'max-deleted-entry-id' then maxDeleted = info[i + 1] end
  if info[i] == 'first-entry' and type(info[i + 1]) == 'table' then firstEntry = info[i + 1][1] end
end
local floor = maxDeleted
if maxDeleted == '0-0' and firstEntry then floor = firstEntry end
if greater(ARGV[1], lastGenerated) or greater(floor, ARGV[1]) then return {'resync'} end
return {'ok', redis.call('XRANGE', KEYS[1], '(' .. ARGV[1], '+', 'COUNT', ARGV[2])}
`;
