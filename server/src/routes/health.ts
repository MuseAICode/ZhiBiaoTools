import type { FastifyInstance } from 'fastify';

export interface ReadinessDependencies {
  /** 检查数据库连通性，不可用时抛错。 */
  pingDatabase(): Promise<void>;
}

const statusSchema = (status: string) => ({
  type: 'object',
  properties: { status: { type: 'string', const: status } },
  required: ['status'],
  additionalProperties: false,
});

/**
 * /healthz：存活检查，只表示进程能处理请求，不检查依赖、不返回版本等内部信息。
 * /readyz：就绪检查，依赖（目前只有数据库）全部可用时返回 200，否则 503。
 * 两者都只返回固定的 status，失败原因只写日志，不返回数据库地址、错误消息等信息。
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
      try {
        await deps.pingDatabase();
      } catch (error) {
        request.log.warn({ err: error, dependency: 'database' }, 'readiness check failed');
        return reply.code(503).send({ status: 'unavailable' as const });
      }
      return { status: 'ok' as const };
    },
  );
}
