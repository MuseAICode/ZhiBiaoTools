// 统一错误处理：响应体固定为 { error: { code, message, requestId } }。
// 只有 AppError 的 message 会原样返回给客户端；其他错误只返回按状态码确定的通用文案，
// 堆栈、内部错误消息、Fastify 错误码等只写日志。
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

/** 有意返回给客户端的业务错误，message 必须是可以给用户看的中文文案。 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const GENERIC_ERRORS: Readonly<Record<number, { code: string; message: string }>> = {
  400: { code: 'BAD_REQUEST', message: '请求不合法' },
  401: { code: 'UNAUTHORIZED', message: '请先登录' },
  403: { code: 'FORBIDDEN', message: '没有权限执行此操作' },
  404: { code: 'NOT_FOUND', message: '资源不存在' },
  405: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法' },
  408: { code: 'REQUEST_TIMEOUT', message: '请求超时' },
  409: { code: 'CONFLICT', message: '请求与当前状态冲突' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支持的内容类型' },
  429: { code: 'TOO_MANY_REQUESTS', message: '请求过于频繁，请稍后再试' },
  503: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用，请稍后再试' },
};

const INTERNAL_ERROR = { code: 'INTERNAL_ERROR', message: '服务器内部错误' } as const;
const CLIENT_ERROR = { code: 'BAD_REQUEST', message: '请求不合法' } as const;

function errorBody(request: FastifyRequest, code: string, message: string): ErrorBody {
  return { error: { code, message, requestId: request.id } };
}

function sendError(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string) {
  return reply.code(status).type('application/json; charset=utf-8').send(errorBody(request, code, message));
}

export function registerErrorHandlers(app: FastifyInstance): void {
  // 处理器本身出错会退回 Fastify 默认处理器（原样返回 message），所以这里不能假设 error 是对象：
  // 业务代码可能 throw 字符串等任意值。
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, 'request failed');
      return sendError(reply, request, error.statusCode, error.code, error.message);
    }

    const rawStatus = error instanceof Error ? (error as Partial<FastifyError>).statusCode : undefined;
    const status = typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      const generic = status === 503 ? GENERIC_ERRORS[503]! : INTERNAL_ERROR;
      return sendError(reply, request, status === 503 ? 503 : 500, generic.code, generic.message);
    }

    // 4xx：Fastify 自带的错误（JSON 解析失败、请求体过大、校验失败等）的 message 会带出
    // 解析器细节或 schema 结构，只记日志，不返回给客户端。
    request.log.info({ err: error }, 'request rejected');
    const generic = GENERIC_ERRORS[status] ?? CLIENT_ERROR;
    return sendError(reply, request, status, generic.code, generic.message);
  });

  app.setNotFoundHandler((request, reply) => {
    const generic = GENERIC_ERRORS[404]!;
    return sendError(reply, request, 404, generic.code, generic.message);
  });
}
