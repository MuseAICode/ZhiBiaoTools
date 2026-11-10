// 结构化日志（pino，Fastify 内置）。凭据类字段一律替换为 [REDACTED]，见 docs/SERVER_DESIGN.md 第 4.3 节。
import type { FastifyServerOptions } from 'fastify';
import type { LogLevel } from './config.ts';

export const REDACTED = '[REDACTED]';

/** 按字段名脱敏，不区分出现在顶层还是嵌套一两层的对象里。 */
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'currentPassword',
  'newPassword',
  'tokenHash',
  'token_hash',
  'apiKey',
  'api_key',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'secret',
  'clientSecret',
  'client_secret',
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-agent-relay-key',
  'relayKey',
] as const;

export const REDACT_PATHS: readonly string[] = SENSITIVE_KEYS.flatMap((key) => {
  const accessor = /^[A-Za-z_]\w*$/.test(key) ? `.${key}` : `["${key}"]`;
  const topLevel = accessor.startsWith('.') ? key : accessor;
  return [topLevel, `*${accessor}`, `*.*${accessor}`];
});

interface LoggerOptions {
  level: LogLevel;
  /** 测试用：把日志写到指定流，默认 stdout。 */
  stream?: NodeJS.WritableStream;
}

type FastifyLoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

export function createLoggerOptions(options: LoggerOptions): FastifyLoggerOptions {
  return {
    level: options.level,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    serializers: {
      // 只记录方法和路径：查询串里可能有一次性令牌等敏感参数，不进日志。
      req(request) {
        return {
          method: request.method,
          path: request.url.split('?', 1)[0],
        };
      },
      res(reply) {
        return { statusCode: reply.statusCode };
      },
    },
    ...(options.stream ? { stream: options.stream } : {}),
  };
}
