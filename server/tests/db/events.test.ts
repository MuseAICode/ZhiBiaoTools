// 事件推送（路线图第 6 步 6.3；src/events/、src/jobs/notify.ts、GET /api/events）与真实 PostgreSQL、Valkey 的集成测试：
// 发布与订阅、按组织和用户过滤、Last-Event-ID 补发与 resync、Stream 的保留窗口，SSE 接口的鉴权、心跳、会话重新校验、
// 连接数上限、服务关闭，任务状态变化经 worker 推送，取消经控制频道立即送达 worker。
// 需要 TEST_DATABASE_ADMIN_URL 和 TEST_REDIS_URL / TEST_REDIS_PASSWORD；Redis 重启的用例另需 TEST_REDIS_RESTART_COMMAND。
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../../src/app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimitSettings } from '../../src/auth/rateLimit.ts';
import { createDatabase, type DatabaseHandle } from '../../src/db/database.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import type { TenantContext } from '../../src/db/tenant.ts';
import { createEventHub, EventsUnavailableError, type EventHub, type EventSink } from '../../src/events/hub.ts';
import { createEventPublisher, type EventPublisher } from '../../src/events/publisher.ts';
import { compareStreamIds, EVENT_STREAM_MAX_LENGTH, EVENT_STREAM_WINDOW_MS, orgStreamKey, type StreamEvent } from '../../src/events/stream.ts';
import { createJobNotifier, type JobNotifier } from '../../src/jobs/notify.ts';
import { createJobDispatcher, type JobDispatcher } from '../../src/jobs/queue.ts';
import { createJobRunner, type JobRunner } from '../../src/jobs/runner.ts';
import { enqueueJob } from '../../src/jobs/service.ts';
import { bullmqConnection } from '../../src/redis.ts';
import { fastHasher, sameSiteHeaders, testConfig } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';
import { createTestJobTypes, rawRedis, redisConfig, testLogger, uniquePrefix, waitFor } from './jobFixtures.ts';

const PASSWORD = 'quiet-harbor-maple-58';

const RELAXED_LIMITS: AuthRateLimitSettings = Object.fromEntries(
  Object.entries(DEFAULT_AUTH_RATE_LIMITS).map(([key, value]) => [
    key,
    'limit' in value ? { ...value, limit: 10_000 } : { ...value, freeFailures: 10_000 },
  ]),
) as unknown as AuthRateLimitSettings;

interface Member {
  userId: string;
  orgId: string;
  cookie: string;
  context: TenantContext;
}

let testDb: TestDatabase;
let superuser: Kysely<any>;
let database: DatabaseHandle;
let appDb: Kysely<Database>;
let redis: Redis;
let keyPrefix: string;
let queuePrefix: string;
let logs: ReturnType<typeof testLogger>;
let publisher: EventPublisher;
let hub: EventHub;
let notifier: JobNotifier;
let types: ReturnType<typeof createTestJobTypes>;
let dispatcher: JobDispatcher;
let app: FastifyInstance;
let baseUrl: string;
const runners: JobRunner[] = [];
const clients: SseClient[] = [];
const closers: (() => Promise<void>)[] = [];

// ---------------------------------------------------------------------------------------------------------------
// SSE 客户端
// ---------------------------------------------------------------------------------------------------------------

interface SseMessage {
  id?: string;
  event: string;
  data: any;
}

class SseClient {
  readonly messages: SseMessage[] = [];
  readonly comments: string[] = [];
  retry: number | null = null;
  ended = false;
  /** 非 200 时的 JSON 响应体。 */
  errorBody: any = null;
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  private readonly request: http.ClientRequest;
  private buffer = '';

  private constructor(response: http.IncomingMessage, request: http.ClientRequest) {
    this.status = response.statusCode ?? 0;
    this.headers = response.headers;
    this.request = request;
  }

  /** 每次新建连接（agent: false），断开即关闭 socket，不留下空闲的连接。 */
  static open(member: Member | null, options: { lastEventId?: string; base?: string } = {}): Promise<SseClient> {
    return new Promise((resolve, reject) => {
      const request = http.get(
        `${options.base ?? baseUrl}/api/events`,
        {
          agent: false,
          headers: {
            ...(member ? { cookie: `__Host-session=${member.cookie}` } : {}),
            ...(options.lastEventId !== undefined ? { 'last-event-id': options.lastEventId } : {}),
          },
        },
        (response) => {
          const client = new SseClient(response, request);
          clients.push(client);
          response.setEncoding('utf8');
          response.on('close', () => {
            client.ended = true;
          });
          if (client.status === 200) {
            response.on('data', (chunk: string) => client.feed(chunk));
            resolve(client);
            return;
          }
          let body = '';
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () => {
            client.errorBody = JSON.parse(body);
            resolve(client);
          });
        },
      );
      request.on('error', reject);
    });
  }

  private feed(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n\n')) >= 0) {
      this.parse(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 2);
    }
  }

  private parse(block: string) {
    const message: Partial<SseMessage> & { dataText?: string } = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) this.comments.push(line.slice(1).trim());
      else if (line.startsWith('retry: ')) this.retry = Number(line.slice(7));
      else if (line.startsWith('id: ')) message.id = line.slice(4);
      else if (line.startsWith('event: ')) message.event = line.slice(7);
      else if (line.startsWith('data: ')) message.dataText = line.slice(6);
    }
    if (message.event) this.messages.push({ ...(message.id ? { id: message.id } : {}), event: message.event, data: JSON.parse(message.dataText ?? 'null') });
  }

  of(event: string): SseMessage[] {
    return this.messages.filter((message) => message.event === event);
  }

  async waitFor(predicate: (messages: SseMessage[]) => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    await waitFor(async () => predicate(this.messages), timeoutMs, what);
  }

  async ready(): Promise<this> {
    await this.waitFor((messages) => messages.some((message) => message.event === 'ready'), 'ready');
    return this;
  }

  close() {
    this.request.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 准备
// ---------------------------------------------------------------------------------------------------------------

async function login(target: FastifyInstance, email: string): Promise<string> {
  const response = await target.inject({ method: 'POST', url: '/api/auth/login', headers: sameSiteHeaders, payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  return /__Host-session=([A-Za-z0-9_-]{43});/.exec(Array.isArray(header) ? header[0]! : String(header))![1]!;
}

async function newMember(orgId: string = randomUUID(), target: FastifyInstance = app): Promise<Member> {
  const hasher = await fastHasher();
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  const existing = await superuser.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
  if (!existing) await superuser.insertInto('organizations').values({ id: orgId, name: email, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email, password_hash: await hasher.hash(PASSWORD), email_verified_at: new Date() }).execute();
  const role = existing ? 'member' : 'owner';
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role }).execute();
  return { userId, orgId, cookie: await login(target, email), context: { orgId, userId, role } };
}

async function startApp(options: Partial<BuildAppOptions> = {}): Promise<{ app: FastifyInstance; baseUrl: string }> {
  const instance = await buildApp(
    { ...testConfig, database: testDb.appConfig },
    {
      database,
      passwordHasher: await fastHasher(),
      rateLimits: RELAXED_LIMITS,
      mailer: { send: async () => {} },
      events: { hub, notifier },
      eventLimits: { heartbeatMs: 200, sessionCheckMs: 200, maxConnectionsPerUser: 3 },
      ...options,
    },
  );
  await instance.listen({ host: '127.0.0.1', port: 0 });
  const { port } = instance.server.address() as AddressInfo;
  return { app: instance, baseUrl: `http://127.0.0.1:${port}` };
}

async function startRunner(heartbeatMs = 150): Promise<JobRunner> {
  const runner = createJobRunner({
    db: appDb,
    registry: types.registry,
    dispatcher,
    connection: bullmqConnection(redisConfig(), 'worker', 'test-worker'),
    log: logs.log,
    prefix: queuePrefix,
    leaseMs: Math.max(heartbeatMs * 4, 1_000),
    heartbeatMs,
    reconcileIntervalMs: 600_000,
    notifier,
  });
  runners.push(runner);
  await runner.start();
  return runner;
}

function newHubAndPublisher() {
  const extraPublisher = createEventPublisher(redisConfig(), { log: logs.log, connectionName: 'test-events-publisher', keyPrefix, queuePrefix });
  const extraHub = createEventHub(redisConfig(), { log: logs.log, connectionName: 'test-events-hub', keyPrefix });
  closers.push(() => extraPublisher.close(), () => extraHub.close());
  return { publisher: extraPublisher, hub: extraHub };
}

/** 直接订阅 hub，收集交给连接的事件。 */
function collector() {
  const events: StreamEvent[] = [];
  let resyncs = 0;
  let lost = 0;
  const sink: EventSink = {
    event: (event) => events.push(event),
    resync: () => {
      resyncs += 1;
    },
    lost: () => {
      lost += 1;
    },
  };
  return {
    sink,
    events,
    get resyncs() {
      return resyncs;
    },
    get lost() {
      return lost;
    },
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  database = createDatabase(testDb.appConfig);
  appDb = database.db;
  redis = rawRedis();
  keyPrefix = `${uniquePrefix()}:`;
  queuePrefix = uniquePrefix();
  logs = testLogger();
  publisher = createEventPublisher(redisConfig(), { log: logs.log, connectionName: 'test-events-publisher', keyPrefix, queuePrefix });
  hub = createEventHub(redisConfig(), { log: logs.log, connectionName: 'test-events-hub', keyPrefix });
  notifier = createJobNotifier({ db: appDb, publisher, log: logs.log });
  types = createTestJobTypes();
  dispatcher = createJobDispatcher({ connection: bullmqConnection(redisConfig(), 'producer', 'test-dispatch'), prefix: queuePrefix });
  ({ app, baseUrl } = await startApp());
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const runner of runners.splice(0)) await runner.close();
});

afterAll(async () => {
  await app?.close();
  for (const close of closers.splice(0)) await close().catch(() => {});
  await dispatcher?.close();
  await hub?.close();
  await publisher?.close();
  redis?.disconnect();
  await database?.destroy();
  await testDb?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
// 发布与订阅（src/events/）
// ---------------------------------------------------------------------------------------------------------------

describe('发布与订阅', () => {
  it('实时送达本组织的连接；其他组织收不到；指定了 userId 的事件只送给该用户', async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const [a1, a2, b] = [collector(), collector(), collector()];
    const userA1 = randomUUID();
    const detachA1 = await hub.attach(orgA, userA1, null, a1.sink);
    const detachA2 = await hub.attach(orgA, randomUUID(), null, a2.sink);
    const detachB = await hub.attach(orgB, randomUUID(), null, b.sink);

    const first = await publisher.publish(orgA, { type: 'test', data: { n: 1 } });
    await publisher.publish(orgA, { type: 'test.private', data: { n: 2 }, userId: userA1 });
    await publisher.publish(orgB, { type: 'test', data: { n: 3 } });
    expect(first).toMatch(/^\d+-\d+$/);

    await waitFor(async () => a1.events.length === 2 && a2.events.length === 1 && b.events.length === 1, 5_000, 'delivery');
    expect(a1.events.map((event) => event.data)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(a1.events[0]!.id).toBe(first);
    expect(a2.events.map((event) => event.data)).toEqual([{ n: 1 }]);
    expect(b.events.map((event) => event.data)).toEqual([{ n: 3 }]);

    // 取消订阅后不再收到；同一组织还有别的连接时频道保持订阅。
    detachA1();
    await publisher.publish(orgA, { type: 'test', data: { n: 4 } });
    await waitFor(async () => a2.events.length === 2, 5_000, 'a2 still subscribed');
    expect(a1.events).toHaveLength(2);
    detachA2();
    detachB();
    // 最后一个连接离开后退订，之后重新连上的连接照常收到。
    const again = collector();
    const detachAgain = await hub.attach(orgA, randomUUID(), null, again.sink);
    await publisher.publish(orgA, { type: 'test', data: { n: 5 } });
    await waitFor(async () => again.events.length === 1, 5_000, 'resubscribed');
    detachAgain();
  });

  it('Last-Event-ID 补发之后的事件（同样按用户过滤），补发期间的实时事件按 ID 去重、不漏', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const ids: string[] = [];
    for (let n = 0; n < 5; n += 1) ids.push((await publisher.publish(orgId, { type: 'test', data: { n } }))!);
    await publisher.publish(orgId, { type: 'test', data: { n: 'other-user' }, userId: randomUUID() });

    const replayed = collector();
    const detach = await hub.attach(orgId, userId, ids[1]!, replayed.sink);
    expect(replayed.resyncs).toBe(0);
    expect(replayed.events.map((event) => event.data.n)).toEqual([2, 3, 4]);
    detach();

    // 补发与并发发布交错：收到的 ID 严格递增，所有事件恰好各一次。
    const concurrent = collector();
    const publishing = (async () => {
      const published: string[] = [];
      for (let n = 0; n < 50; n += 1) published.push((await publisher.publish(orgId, { type: 'test', data: { n: 100 + n } }))!);
      return published;
    })();
    const detachConcurrent = await hub.attach(orgId, userId, ids[4]!, concurrent.sink);
    const published = await publishing;
    await waitFor(async () => concurrent.events.at(-1)?.id === published.at(-1), 5_000, 'all delivered');
    const received = concurrent.events.map((event) => event.id);
    expect(new Set(received).size).toBe(received.length);
    expect([...received].sort(compareStreamIds)).toEqual(received);
    expect(concurrent.events.map((event) => event.data.n)).toEqual(published.map((_id, index) => 100 + index));
    detachConcurrent();
  });

  it('无法补发时 resync：ID 格式不对、不是这条 Stream 生成的、Stream 已不存在、之后的事件已被裁剪', async () => {
    const orgId = randomUUID();
    const first = (await publisher.publish(orgId, { type: 'test', data: {} }))!;
    for (const lastEventId of ['garbage', '99999999999999-0']) {
      const sink = collector();
      (await hub.attach(orgId, randomUUID(), lastEventId, sink.sink))();
      expect(sink.resyncs, lastEventId).toBe(1);
      expect(sink.events).toEqual([]);
    }

    // 超过条数上限后，第一条之后的事件已被裁剪。
    const pipeline = Array.from({ length: EVENT_STREAM_MAX_LENGTH + 5 }, (_, n) => publisher.publish(orgId, { type: 'test', data: { n } }));
    await Promise.all(pipeline);
    expect(await redis.xlen(orgStreamKey(keyPrefix, orgId))).toBe(EVENT_STREAM_MAX_LENGTH);
    const pttl = await redis.pttl(orgStreamKey(keyPrefix, orgId));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(EVENT_STREAM_WINDOW_MS);
    const trimmed = collector();
    (await hub.attach(orgId, randomUUID(), first, trimmed.sink))();
    expect(trimmed.resyncs).toBe(1);
    expect(trimmed.events).toEqual([]);

    // 仍在窗口内的 ID 可以补发。
    const [[recentId]] = (await redis.xrange(orgStreamKey(keyPrefix, orgId), '-', '+', 'COUNT', 1)) as [[string, string[]]];
    const recent = collector();
    (await hub.attach(orgId, randomUUID(), recentId, recent.sink))();
    expect(recent.resyncs).toBe(0);
    expect(recent.events).toHaveLength(EVENT_STREAM_MAX_LENGTH - 1);

    // Stream 不存在（过期、Redis 重启或被清空）。
    await redis.del(orgStreamKey(keyPrefix, orgId));
    const missing = collector();
    (await hub.attach(orgId, randomUUID(), recentId, missing.sink))();
    expect(missing.resyncs).toBe(1);
  });

  it('Redis 不可达：发布返回 null 并写日志，订阅抛 EventsUnavailableError', async () => {
    const unreachable = { ...redisConfig(), port: 1 };
    const local = testLogger();
    const deadPublisher = createEventPublisher(unreachable, { log: local.log, connectionName: 'test-dead' });
    const deadHub = createEventHub(unreachable, { log: local.log });
    closers.push(() => deadPublisher.close(), () => deadHub.close());
    expect(await deadPublisher.publish(randomUUID(), { type: 'test', data: {} })).toBeNull();
    expect(local.entries.some((entry) => entry.msg === 'event publish failed, dropped')).toBe(true);
    await expect(deadHub.attach(randomUUID(), randomUUID(), null, collector().sink)).rejects.toBeInstanceOf(EventsUnavailableError);
  });

  it('事件类型不合法或过大是程序错误', async () => {
    await expect(publisher.publish(randomUUID(), { type: 'Bad Type', data: {} })).rejects.toThrow(TypeError);
    await expect(publisher.publish(randomUUID(), { type: 'test', data: { text: 'x'.repeat(70_000) } })).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GET /api/events
// ---------------------------------------------------------------------------------------------------------------

describe('GET /api/events', () => {
  it('未登录 401；未配置 Redis 时 503', async () => {
    const anonymous = await SseClient.open(null);
    expect(anonymous.status).toBe(401);
    const disabled = await startApp({ events: null });
    closers.push(() => disabled.app.close());
    const member = await newMember(randomUUID(), disabled.app);
    const response = await SseClient.open(member, { base: disabled.baseUrl });
    expect(response.status).toBe(503);
    expect(response.errorBody.error.code).toBe('EVENTS_UNAVAILABLE');
  });

  it('SSE 响应头、retry、ready 与心跳', async () => {
    const member = await newMember();
    const client = await (await SseClient.open(member)).ready();
    expect(client.status).toBe(200);
    expect(client.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(client.headers['cache-control']).toBe('no-store');
    expect(client.headers['x-accel-buffering']).toBe('no');
    expect(client.headers['x-content-type-options']).toBe('nosniff');
    expect(client.headers['content-security-policy']).toContain("default-src 'self'");
    expect(client.retry).toBe(3_000);
    await waitFor(async () => client.comments.includes('ping'), 5_000, 'heartbeat');
  });

  it('任务从入队到结束的状态、进度、日志推送给本组织的连接，其他组织收不到', async () => {
    const member = await newMember();
    const colleague = await newMember(member.orgId);
    const outsider = await newMember();
    const [mine, theirs, other] = await Promise.all([member, colleague, outsider].map(async (who) => (await SseClient.open(who)).ready()));
    await startRunner();

    const job = await enqueueJob({ db: appDb, registry: types.registry, dispatcher, log: logs.log, notifier }, member.context, {
      type: 'test-echo',
      params: { steps: 2 },
    });
    for (const client of [mine!, theirs!]) {
      await client.waitFor((messages) => messages.some((message) => message.event === 'job' && message.data.job.status === 'succeeded'), 'succeeded');
      const states = client.of('job').filter((message) => message.data.job.id === job.id).map((message) => message.data.job.status);
      expect(states[0]).toBe('queued');
      expect(states).toContain('running');
      expect(states.at(-1)).toBe('succeeded');
      expect(client.of('job.progress').map((message) => message.data)).toEqual([
        { jobId: job.id, projectId: null, type: 'test-echo', progress: 33 },
        { jobId: job.id, projectId: null, type: 'test-echo', progress: 66 },
      ]);
      const [log] = client.of('job.log');
      expect(log!.data).toMatchObject({ jobId: job.id, type: 'test-echo', event: { kind: 'log', message: '测试任务完成' } });
      // 事件数据（job_events.data）、参数与 checkpoint 不推送。
      expect(log!.data.event).not.toHaveProperty('data');
      expect(client.of('job')[0]!.data.job).not.toHaveProperty('params');
      expect(client.of('job')[0]!.data.job).not.toHaveProperty('checkpoint');
      for (const message of client.messages.filter((entry) => entry.event.startsWith('job'))) expect(message.id).toMatch(/^\d+-\d+$/);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(other!.messages.filter((message) => message.event.startsWith('job'))).toEqual([]);
  });

  it('断线重连带 Last-Event-ID 补发；不认识的 ID 推 resync', async () => {
    const member = await newMember();
    const first = await (await SseClient.open(member)).ready();
    await publisher.publish(member.orgId, { type: 'test', data: { n: 1 } });
    await first.waitFor((messages) => messages.some((message) => message.event === 'test'), 'first event');
    const lastEventId = first.of('test')[0]!.id!;
    first.close();
    await publisher.publish(member.orgId, { type: 'test', data: { n: 2 } });
    await publisher.publish(member.orgId, { type: 'test', data: { n: 3 } });

    const resumed = await (await SseClient.open(member, { lastEventId })).ready();
    expect(resumed.of('test').map((message) => message.data.n)).toEqual([2, 3]);
    expect(resumed.of('resync')).toEqual([]);
    // 补发的事件在 ready 之前。
    expect(resumed.messages.findIndex((message) => message.event === 'ready')).toBe(2);

    const unknown = await (await SseClient.open(member, { lastEventId: '1-0' })).ready();
    expect(unknown.of('resync')).toHaveLength(1);
    expect(unknown.of('test')).toEqual([]);
  });

  it('会话被吊销或用户被移出组织后推 closed 并断开，重连 401', async () => {
    const revoked = await newMember();
    const removed = await newMember();
    const [a, b] = await Promise.all([revoked, removed].map(async (who) => (await SseClient.open(who)).ready()));
    await superuser.updateTable('sessions').set({ revoked_at: new Date() }).where('user_id', '=', revoked.userId).execute();
    await superuser.deleteFrom('org_memberships').where('user_id', '=', removed.userId).execute();
    for (const client of [a!, b!]) {
      await waitFor(async () => client.ended, 5_000, 'stream closed');
      expect(client.of('closed').map((message) => message.data)).toEqual([{ reason: 'session' }]);
    }
    expect((await SseClient.open(revoked)).status).toBe(401);
    expect((await SseClient.open(removed)).status).toBe(401);
  });

  it('每个用户的连接数上限，断开后释放', async () => {
    const member = await newMember();
    const open = await Promise.all([1, 2, 3].map(async () => (await SseClient.open(member)).ready()));
    const rejected = await SseClient.open(member);
    expect(rejected.status).toBe(429);
    expect(rejected.errorBody.error.code).toBe('EVENTS_TOO_MANY_CONNECTIONS');
    // 同组织的其他用户不受影响。
    expect((await SseClient.open(await newMember(member.orgId))).status).toBe(200);
    open[0]!.close();
    await waitFor(async () => (await SseClient.open(member).then((client) => (client.status === 200 ? client : null))) ?? null, 5_000, 'slot released');
  });

  it('取消经控制频道立即送达执行中的 worker，不必等到下一次续租', async () => {
    const member = await newMember();
    const client = await (await SseClient.open(member)).ready();
    // 续租间隔 15 秒：只靠续租时，取消要十几秒后才会被发现。
    await startRunner(15_000);
    const job = await enqueueJob({ db: appDb, registry: types.registry, dispatcher, log: logs.log, notifier }, member.context, {
      type: 'test-echo',
      params: { steps: 1, hold: true },
    });
    await types.gate(job.id, 0).entered;
    const started = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/cancel`,
      headers: { ...sameSiteHeaders, cookie: `__Host-session=${member.cookie}` },
    });
    expect(response.json().status).toBe('cancelling');
    await client.waitFor(
      (messages) => messages.some((message) => message.event === 'job' && message.data.job.status === 'cancelled'),
      'cancelled',
      5_000,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(client.of('job').map((message) => message.data.job.status)).toContain('cancelling');
  });

  it('服务关闭时推 closed 并断开连接，不阻塞关闭', async () => {
    const instance = await startApp();
    const member = await newMember(randomUUID(), instance.app);
    const client = await (await SseClient.open(member, { base: instance.baseUrl })).ready();
    const started = Date.now();
    await instance.app.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    await waitFor(async () => client.ended, 5_000, 'stream closed');
    expect(client.of('closed').map((message) => message.data)).toEqual([{ reason: 'shutdown' }]);
  });

  // 放在最后：重启 Redis 会断开本文件的所有连接。
  it.skipIf(!process.env.TEST_REDIS_RESTART_COMMAND)('Redis 重启：连接推 closed（unavailable）后断开，重连后 resync', async () => {
    const own = newHubAndPublisher();
    const instance = await startApp({ events: { hub: own.hub, notifier: createJobNotifier({ db: appDb, publisher: own.publisher, log: logs.log }) } });
    closers.push(() => instance.app.close());
    const member = await newMember(randomUUID(), instance.app);
    const client = await (await SseClient.open(member, { base: instance.baseUrl })).ready();
    const lastEventId = (await own.publisher.publish(member.orgId, { type: 'test', data: {} }))!;
    await client.waitFor((messages) => messages.some((message) => message.event === 'test'), 'event');

    execSync(process.env.TEST_REDIS_RESTART_COMMAND!, { stdio: 'inherit', timeout: 60_000 });
    await waitFor(async () => client.ended, 30_000, 'stream closed');
    expect(client.of('closed').map((message) => message.data)).toEqual([{ reason: 'unavailable' }]);

    // Redis 回来后重连：Stream 已随重启丢失，推 resync。
    const resumed = await waitFor(
      async () => {
        const attempt = await SseClient.open(member, { base: instance.baseUrl, lastEventId });
        return attempt.status === 200 ? attempt : null;
      },
      30_000,
      'reconnected',
    );
    await resumed.ready();
    expect(resumed.of('resync')).toHaveLength(1);
  });
});
