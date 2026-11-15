// sandbox-runner 的 HTTP 接口（docs/SERVER_DESIGN.md 第 7.4、7.5 节）。只有 worker 调用，经内部网络 sandbox-control，
// 每个请求都要带共享令牌（Authorization: Bearer，令牌取自 Docker secret）。
//
// 接口只接受“模板名 + 任务 id”和模板中登记的命令名与参数，不接受镜像、挂载、网络、环境变量或任意 Docker 参数：
//   POST   /v1/sandboxes                 { template, jobId }        → 201 { id, template, jobId, expiresAt }
//   PUT    /v1/sandboxes/:id/input       tar（只含普通文件，流式校验转发） → 204
//   POST   /v1/sandboxes/:id/exec        { command, args, input? }  → 200 执行结果（input：标准输入的 base64，只有登记了上限的命令接收）
//   GET    /v1/sandboxes/:id/output                                  → 200 tar（原样转出，由 worker 校验）
//   DELETE /v1/sandboxes/:id                                         → 204
// 后四个接口用 X-Sandbox-Job 头带任务 id，与创建时不符按不存在处理。
//
// 接收请求的时限（#66）：Fastify 默认不限时（requestTimeout、connectionTimeout 都是 0），停住的上传（worker 卡死或网络中断、
// 连接没有被重置）会让这个请求、driver 对请求流的读取与沙箱内的 tar 一直挂着。放入归档时等待客户端下一块数据超过
// inputIdleTimeoutMs（默认 60 秒）即销毁请求与连接，driver 随之中止并终止沙箱（与客户端断开相同）；另以 requestTimeout
// 限制接收整个请求的时间（默认为最长的放入时限加 1 分钟），作为其他请求的兜底。执行命令等处理本身的耗时不受这两项限制。
//
// 关闭（重启、部署，#66）：Node 的 server.close() 与 Fastify 默认的 forceCloseConnections: 'idle' 只关闭空闲的 keep-alive
// 连接，不关闭已连接但还没发出请求的连接（例如 worker 的连接池在请求被中止时留下的、健康检查与端口探测），会一直等到
// headersTimeout（60 秒），超过 sandbox-runner 的退出时限而被强制退出，在途请求的中止信号不会触发、沙箱留到到期清理。
// 关闭时在途请求处理完（或等满 closeGraceMs，默认 5 秒）即关闭全部剩余连接：被截断的请求触发 abortOnDisconnect，
// driver 中止并终止对应的沙箱。
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { maxArchiveBytes } from './archive.ts';
import type { DockerApi } from './dockerApi.ts';
import type { DockerSandboxDriver } from './docker.ts';
import { SandboxError, type SandboxErrorCode, type SandboxRef } from './driver.ts';
import { SANDBOX_TEMPLATE_NAMES, SANDBOX_TEMPLATES } from './templates.ts';
import { AppError, registerErrorHandlers } from '../errors.ts';
import type { LogLevel } from '../config.ts';
import { createLoggerOptions } from '../logger.ts';

export const SANDBOX_JOB_HEADER = 'x-sandbox-job';
const JSON_BODY_LIMIT = 1024 * 1024;
/** 命令经标准输入接收的请求的最大字节数（各模板命令的 maxInputBytes 中最大的，8.6a 的 agent 入口为 1 MiB）。 */
const MAX_EXEC_INPUT_BYTES = Math.max(0, ...Object.values(SANDBOX_TEMPLATES).flatMap((template) => Object.values(template.commands).map((command) => command.maxInputBytes ?? 0)));
/** input 的 base64 至多这么长（每 3 字节 4 个字符）。 */
const MAX_EXEC_INPUT_BASE64 = Math.ceil(MAX_EXEC_INPUT_BYTES / 3) * 4;
/** 执行命令的请求体上限：base64 的 input 加命令名与参数。 */
const EXEC_BODY_LIMIT = MAX_EXEC_INPUT_BASE64 + 64 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** 严格解码 base64（长度为 4 的倍数、只含标准字母表、补位规范，重新编码后与原文相同）；不合法时返回 null。 */
function decodeBase64(value: string): Buffer | null {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}
/** 放入归档时等待客户端下一块数据的上限。worker 从对象存储按需读取配图，正常情况下块与块之间远小于它。 */
export const DEFAULT_INPUT_IDLE_TIMEOUT_MS = 60_000;
/** 关闭时等待在途请求处理完的上限，之后关闭全部连接（sandbox-runner 的退出时限为 10 秒）。 */
export const DEFAULT_CLOSE_GRACE_MS = 5_000;
/** 接收整个请求的上限：最长的放入时限（模板的 transferTimeoutMs）加 1 分钟。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = Math.max(...Object.values(SANDBOX_TEMPLATES).map((template) => template.transferTimeoutMs)) + 60_000;
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export interface SandboxRunnerAppOptions {
  driver: DockerSandboxDriver;
  docker: DockerApi;
  runtime: string;
  /** worker 与 sandbox-runner 之间的共享令牌。 */
  token: string;
  logLevel: LogLevel;
  logStream?: NodeJS.WritableStream;
  /** 放入归档时等待下一块数据的上限（毫秒），默认 DEFAULT_INPUT_IDLE_TIMEOUT_MS；测试中缩短。 */
  inputIdleTimeoutMs?: number;
  /** 接收整个请求的上限（毫秒），默认 DEFAULT_REQUEST_TIMEOUT_MS。 */
  requestTimeoutMs?: number;
  /** 关闭时等待在途请求的上限（毫秒），默认 DEFAULT_CLOSE_GRACE_MS；测试中缩短。 */
  closeGraceMs?: number;
}

const STATUS_BY_CODE: Readonly<Record<SandboxErrorCode, number>> = {
  SANDBOX_BAD_REQUEST: 400,
  SANDBOX_NOT_FOUND: 404,
  SANDBOX_BUSY: 429,
  SANDBOX_OUTPUT_REJECTED: 422,
  SANDBOX_UNAVAILABLE: 503,
  SANDBOX_ABORTED: 409,
  SANDBOX_INPUT_FAILED: 500,
  SANDBOX_FAILED: 500,
};

function toAppError(error: unknown): unknown {
  if (error instanceof SandboxError) return new AppError(STATUS_BY_CODE[error.code], error.code, error.message, { cause: error });
  return error;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
  required: ['id'],
  additionalProperties: false,
} as const;

const jobHeaders = {
  type: 'object',
  properties: { [SANDBOX_JOB_HEADER]: { type: 'string', pattern: UUID_PATTERN } },
  required: [SANDBOX_JOB_HEADER],
} as const;

function refBody(ref: SandboxRef) {
  return { id: ref.id, template: ref.template, jobId: ref.jobId, expiresAt: ref.expiresAt.toISOString() };
}

/** 客户端断开（worker 中止、关闭）时中止正在进行的沙箱操作；中止 exec 会终止整个沙箱。 */
/**
 * 放入归档的请求流，等待客户端下一块数据超过 idleMs 时销毁请求与连接（driver 读到错误、abortOnDisconnect 触发中止）。
 * 只在等待客户端时计时：块交给 driver 之后、driver 处理（例如沙箱内的 tar 写得慢、形成背压）期间不计时，不会误伤慢的沙箱。
 */
async function* withInputIdleTimeout(request: FastifyRequest, body: Readable, idleMs: number): AsyncGenerator<Buffer> {
  const iterator = body.iterator({ destroyOnReturn: false });
  let timer: NodeJS.Timeout | undefined;
  try {
    while (true) {
      timer = setTimeout(() => {
        request.log.warn({ idleMs }, 'sandbox input stalled, closing the connection');
        request.raw.destroy(new Error('sandbox input idle timeout'));
      }, idleMs);
      const next = await iterator.next();
      clearTimeout(timer);
      timer = undefined;
      if (next.done) return;
      yield next.value as Buffer;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

export async function buildSandboxRunnerApp(options: SandboxRunnerAppOptions): Promise<FastifyInstance> {
  const { driver, docker } = options;
  const expectedToken = digest(options.token);
  const app = Fastify({
    // 与 api 相同：请求体中多余的字段一律拒绝（400），而不是悄悄删掉后继续处理。
    ajv: { customOptions: { removeAdditional: false } },
    logger: createLoggerOptions({ level: options.logLevel, ...(options.logStream ? { stream: options.logStream } : {}) }),
    // JSON 请求体的上限。输入归档不经 Fastify 缓冲（见下面的 tar 解析器），上限按沙箱的模板在读取时检查。
    bodyLimit: JSON_BODY_LIMIT,
    // 接收整个请求的上限（见文件头）。
    requestTimeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });
  const inputIdleTimeoutMs = options.inputIdleTimeoutMs ?? DEFAULT_INPUT_IDLE_TIMEOUT_MS;
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;

  // 在途请求数（关闭时用，见文件头）：从收到请求到响应发完或连接断开（ServerResponse 的 close 事件，两种情况都只触发一次）。
  // 不用请求对象的 close：它在请求体读完时就触发，执行命令等请求那时还在处理。
  let activeRequests = 0;
  app.addHook('onRequest', async (_request, reply) => {
    activeRequests += 1;
    reply.raw.once('close', () => {
      activeRequests -= 1;
    });
  });
  app.addHook('preClose', async () => {
    // preClose 之后 Fastify 才停止监听并关闭空闲连接；这里只安排在其后关闭剩余的连接，不阻塞关闭流程。
    const deadline = Date.now() + closeGraceMs;
    const closeRemaining = () => {
      if (activeRequests > 0 && Date.now() < deadline) {
        setTimeout(closeRemaining, 20).unref();
        return;
      }
      if (activeRequests > 0) app.log.warn({ activeRequests, closeGraceMs }, 'closing connections of requests still in progress');
      app.server.closeAllConnections();
    };
    setImmediate(closeRemaining);
  });
  registerErrorHandlers(app);
  // 输入归档（parse 至多约 192 MiB、export-document 至多约 128 MiB，另加头部）不在内存中整体缓存：把请求流原样交给路由，由 driver 边读边校验、
  // 只把通过校验的条目转给沙箱内的 tar（src/sandbox/archive.ts 的 validateArchiveStream），超过模板上限即中止。
  app.addContentTypeParser('application/x-tar', (_request, payload, done) => done(null, payload));

  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (request.routeOptions.config?.access === 'public') return;
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    // 比较摘要：长度固定，timingSafeEqual 不会因长度不同而提前返回。
    if (!token || !timingSafeEqual(digest(token), expectedToken)) {
      throw new AppError(401, 'UNAUTHORIZED', '令牌无效');
    }
  });

  const health = { logLevel: 'warn' as const, config: { access: 'public' as const } };
  app.get('/healthz', health, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { status: 'ok' };
  });
  app.get('/readyz', health, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      await docker.ping();
      const runtimes = await docker.runtimes();
      if (!runtimes.includes(options.runtime)) throw new Error('configured container runtime is not registered');
      return { status: 'ok' };
    } catch (error) {
      request.log.warn({ err: error, dependency: 'docker' }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.post(
    '/v1/sandboxes',
    {
      schema: {
        body: {
          type: 'object',
          properties: { template: { type: 'string', enum: [...SANDBOX_TEMPLATE_NAMES] }, jobId: { type: 'string', pattern: UUID_PATTERN } },
          required: ['template', 'jobId'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { template: (typeof SANDBOX_TEMPLATE_NAMES)[number]; jobId: string };
      try {
        const ref = await driver.create(body.template, { jobId: body.jobId });
        return reply.code(201).send(refBody(ref));
      } catch (error) {
        throw toAppError(error);
      }
    },
  );

  async function lookup(request: FastifyRequest): Promise<SandboxRef> {
    const { id } = request.params as { id: string };
    const jobId = request.headers[SANDBOX_JOB_HEADER] as string;
    try {
      return await driver.lookup(id, jobId);
    } catch (error) {
      throw toAppError(error);
    }
  }

  app.put('/v1/sandboxes/:id/input', { schema: { params: idParams, headers: jobHeaders } }, async (request, reply) => {
    const body = request.body;
    if (!(body instanceof Readable)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 tar 归档');
    const ref = await lookup(request);
    const limit = maxArchiveBytes(SANDBOX_TEMPLATES[ref.template].input);
    const declared = Number(request.headers['content-length']);
    // 声明的长度已超过模板上限：不碰沙箱，直接拒绝（没有声明长度时在读取中检查）。
    if (Number.isFinite(declared) && declared > limit) {
      reply.header('connection', 'close');
      throw new AppError(400, 'SANDBOX_BAD_REQUEST', '输入文件不符合沙箱规则');
    }
    try {
      // 校验失败时不销毁请求流：先把 400 发出去，剩余的请求体由 Node 丢弃或随连接关闭。
      await driver.copyInArchive(ref, withInputIdleTimeout(request, body, inputIdleTimeoutMs), { signal: abortOnDisconnect(reply) });
    } catch (error) {
      if (error instanceof SandboxError && error.code === 'SANDBOX_BAD_REQUEST') reply.header('connection', 'close');
      throw toAppError(error);
    }
    return reply.code(204).send();
  });

  app.post(
    '/v1/sandboxes/:id/exec',
    {
      schema: {
        params: idParams,
        headers: jobHeaders,
        body: {
          type: 'object',
          properties: {
            command: { type: 'string', maxLength: 64 },
            args: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 256 } },
            input: { type: 'string', maxLength: MAX_EXEC_INPUT_BASE64 },
          },
          required: ['command', 'args'],
          additionalProperties: false,
        },
      },
      bodyLimit: EXEC_BODY_LIMIT,
    },
    async (request, reply) => {
      const ref = await lookup(request);
      const body = request.body as { command: string; args: string[]; input?: string };
      // input 可能含任务令牌：不写日志，解码失败只回 400（大小与命令是否接收由 driver 按模板检查）。
      const input = body.input === undefined ? undefined : decodeBase64(body.input);
      if (input === null) throw new AppError(400, 'SANDBOX_BAD_REQUEST', '沙箱命令的输入不合法');
      try {
        return await driver.exec(ref, body.command, body.args, { signal: abortOnDisconnect(reply), ...(input !== undefined ? { input } : {}) });
      } catch (error) {
        throw toAppError(error);
      }
    },
  );

  app.get('/v1/sandboxes/:id/output', { schema: { params: idParams, headers: jobHeaders } }, async (request, reply) => {
    const ref = await lookup(request);
    let stream;
    try {
      stream = await driver.copyOutRaw(ref, { signal: abortOnDisconnect(reply) });
    } catch (error) {
      throw toAppError(error);
    }
    stream.once('error', (error: unknown) => request.log.warn({ err: error }, 'sandbox output stream failed'));
    return reply.code(200).header('cache-control', 'no-store').type('application/x-tar').send(stream);
  });

  app.delete('/v1/sandboxes/:id', { schema: { params: idParams, headers: jobHeaders } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const jobId = request.headers[SANDBOX_JOB_HEADER] as string;
    const ref = await driver.lookup(id, jobId).catch(() => null);
    try {
      // 已停止（超时被终止）或已到期的沙箱 lookup 查不到，仍按 id 和任务 id 删除。
      await driver.destroy(ref ?? { id, jobId, template: 'parse', expiresAt: new Date(0) });
    } catch (error) {
      throw toAppError(error);
    }
    return reply.code(204).send();
  });

  return app;
}
