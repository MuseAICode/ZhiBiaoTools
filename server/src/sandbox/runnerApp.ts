// sandbox-runner 的 HTTP 接口（docs/SERVER_DESIGN.md 第 7.4、7.5 节）。只有 worker 调用，经内部网络 sandbox-control，
// 每个请求都要带共享令牌（Authorization: Bearer，令牌取自 Docker secret）。
//
// 接口只接受“模板名 + 任务 id”和模板中登记的命令名与参数，不接受镜像、挂载、网络、环境变量或任意 Docker 参数：
//   POST   /v1/sandboxes                 { template, jobId }        → 201 { id, template, jobId, expiresAt }
//   PUT    /v1/sandboxes/:id/input       tar（只含普通文件，流式校验转发） → 204
//   POST   /v1/sandboxes/:id/exec        { command, args }          → 200 执行结果
//   GET    /v1/sandboxes/:id/output                                  → 200 tar（原样转出，由 worker 校验）
//   DELETE /v1/sandboxes/:id                                         → 204
// 后四个接口用 X-Sandbox-Job 头带任务 id，与创建时不符按不存在处理。
//
// 接收请求的时限（#66）：Fastify 默认不限时（requestTimeout、connectionTimeout 都是 0），停住的上传（worker 卡死或网络中断、
// 连接没有被重置）会让这个请求、driver 对请求流的读取与沙箱内的 tar 一直挂着。放入归档时等待客户端下一块数据超过
// inputIdleTimeoutMs（默认 60 秒）即销毁请求与连接，driver 随之中止并终止沙箱（与客户端断开相同）；另以 requestTimeout
// 限制接收整个请求的时间（默认为最长的放入时限加 1 分钟），作为其他请求的兜底。执行命令等处理本身的耗时不受这两项限制。
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
/** 放入归档时等待客户端下一块数据的上限。worker 从对象存储按需读取配图，正常情况下块与块之间远小于它。 */
export const DEFAULT_INPUT_IDLE_TIMEOUT_MS = 60_000;
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
          },
          required: ['command', 'args'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const ref = await lookup(request);
      const body = request.body as { command: string; args: string[] };
      try {
        return await driver.exec(ref, body.command, body.args, { signal: abortOnDisconnect(reply) });
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
