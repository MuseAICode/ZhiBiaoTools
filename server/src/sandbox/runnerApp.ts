// sandbox-runner 的 HTTP 接口（docs/SERVER_DESIGN.md 第 7.4、7.5 节）。只有 worker 调用，经内部网络 sandbox-control，
// 每个请求都要带共享令牌（Authorization: Bearer，令牌取自 Docker secret）。
//
// 接口只接受“模板名 + 任务 id”和模板中登记的命令名与参数，不接受镜像、挂载、网络、环境变量或任意 Docker 参数：
//   POST   /v1/sandboxes                 { template, jobId }        → 201 { id, template, jobId, expiresAt }
//   PUT    /v1/sandboxes/:id/input       tar（只含普通文件）           → 204
//   POST   /v1/sandboxes/:id/exec        { command, args }          → 200 执行结果
//   GET    /v1/sandboxes/:id/output                                  → 200 tar（原样转出，由 worker 校验）
//   DELETE /v1/sandboxes/:id                                         → 204
// 后四个接口用 X-Sandbox-Job 头带任务 id，与创建时不符按不存在处理。
import { createHash, timingSafeEqual } from 'node:crypto';
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
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export interface SandboxRunnerAppOptions {
  driver: DockerSandboxDriver;
  docker: DockerApi;
  runtime: string;
  /** worker 与 sandbox-runner 之间的共享令牌。 */
  token: string;
  logLevel: LogLevel;
  logStream?: NodeJS.WritableStream;
}

const STATUS_BY_CODE: Readonly<Record<SandboxErrorCode, number>> = {
  SANDBOX_BAD_REQUEST: 400,
  SANDBOX_NOT_FOUND: 404,
  SANDBOX_BUSY: 429,
  SANDBOX_OUTPUT_REJECTED: 422,
  SANDBOX_UNAVAILABLE: 503,
  SANDBOX_ABORTED: 409,
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
    // 输入归档的上限：模板中最大的输入（含 tar 头部和对齐）。
    bodyLimit: Math.max(1024 * 1024, ...SANDBOX_TEMPLATE_NAMES.map((name) => maxArchiveBytes(SANDBOX_TEMPLATES[name].input))),
  });
  registerErrorHandlers(app);
  app.addContentTypeParser('application/x-tar', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

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
    if (!Buffer.isBuffer(request.body)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 tar 归档');
    const ref = await lookup(request);
    try {
      await driver.copyInArchive(ref, request.body, { signal: abortOnDisconnect(reply) });
    } catch (error) {
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
