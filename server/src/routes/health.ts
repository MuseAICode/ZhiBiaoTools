import type { FastifyInstance } from 'fastify';

export interface ReadinessDependencies {
  /** 检查数据库连通性，不可用时抛错。 */
  pingDatabase(): Promise<void>;
  /** 检查 Redis 连通性，不可用时抛错；未配置 Redis 时不提供，不检查。 */
  pingRedis?: () => Promise<void>;
}

const statusSchema = (status: string) => ({
  type: 'object',
  properties: { status: { type: 'string', const: status } },
  required: ['status'],
  additionalProperties: false,
});

/**
 * /healthz：存活检查，只表示进程能处理请求，不检查依赖、不返回版本等内部信息。
 * /readyz：就绪检查，依赖（数据库，以及配置了的 Redis）全部可用时返回 200，否则 503。
 * 两者都只返回固定的 status，失败原因只写日志，不返回依赖的地址、错误消息等信息。
 */
export async function registerHealthRoutes(app: FastifyInstance, deps: ReadinessDependencies): Promise<void> {
  app.get(
    '/healthz',
    {
      // 容器健康检查频繁调用，正常请求不写 info 日志。
      logLevel: 'warn',
      config: { access: 'public' },
      schema: { response: { 200: statusSchema('ok') } },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      return { status: 'ok' as const };
    },
  );

  app.get(
    '/readyz',
    {
      logLevel: 'warn',
      config: { access: 'public' },
      schema: { response: { 200: statusSchema('ok'), 503: statusSchema('unavailable') } },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const checks: Array<[dependency: string, ping: () => Promise<void>]> = [['database', deps.pingDatabase]];
      if (deps.pingRedis) checks.push(['redis', deps.pingRedis]);
      // 并行检查，每个依赖的失败都写日志，便于一次看出全部不可用的依赖。
      const results = await Promise.allSettled(checks.map(([, ping]) => ping()));
      let ready = true;
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          ready = false;
          request.log.warn({ err: result.reason, dependency: checks[index]?.[0] }, 'readiness check failed');
        }
      });
      if (!ready) return reply.code(503).send({ status: 'unavailable' as const });
      return { status: 'ok' as const };
    },
  );
}
